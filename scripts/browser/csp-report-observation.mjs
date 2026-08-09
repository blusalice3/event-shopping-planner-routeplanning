import { chromium } from "playwright";

import { classifyBlockedTarget } from "../../api/csp-report.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { renderCspPolicyValue } from "../lib/csp-delivery.mjs";
import {
  putRemoteDbProviderObservationAuthority,
  readStoredRemoteDbProviderObservationAuthority,
} from "../db/remote-db-observation-authority.mjs";
import {
  assertProviderPolicyConfigured,
  collectVercelProviderObservation,
} from "../provider/collect-vercel-observation.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import {
  assertExactKeys,
  assertImmutableObjectReference,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  assertProductionRequestGraphProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority,
  deriveBrowserPhaseExitCollectorIdentity,
  readStoredProductionRequestGraphOidcAuthority,
  resolveProductionRequestGraphBinding,
} from "./production-request-graph.mjs";
import {
  assertCspReportPhaseStateAuthority,
  assertCspReportWafAuthority,
  deriveCspReportWafAuthority,
  resolveCspReportPhaseStateAuthority,
} from "./csp-report-phase-authority.mjs";

export const CSP_REPORT_OBSERVATION_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.csp-report-observation-raw+json;version=1";

export {
  assertProductionRequestGraphProtectedWorkflow as assertCspReportObservationProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority as collectAndStoreCspReportObservationOidcAuthority,
};

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_RAW_BYTES = 8 * 1024 * 1024;
const MAXIMUM_AGGREGATES = 1000;
const MAXIMUM_PROBE_RESPONSE_BYTES = 16 * 1024;
const SCENARIO_IDS = Object.freeze(["blob-url", "normal", "same-origin-api"]);
const PROBE_RECEIPT_KEYS = Object.freeze([
  "allow",
  "bodyByteLength",
  "bodySha256",
  "cacheControl",
  "contentType",
  "method",
  "ordinal",
  "status",
]);
const CONTROLLED_REPORT = Object.freeze({
  "csp-report": Object.freeze({
    "blocked-uri": "data:",
    disposition: "report",
    "document-uri": null,
    "effective-directive": "img-src",
  }),
});

const timestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
};

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return { uri: `release-state://${namespace}/evidence/${sha256}`, sha256 };
};

const violationCollector = () => {
  const { document } = globalThis;
  const violations = [];
  Object.defineProperty(globalThis, "__espCspReportViolations", {
    configurable: false,
    enumerable: false,
    value: violations,
    writable: false,
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push({
      blockedUri: event.blockedURI,
      disposition: event.disposition,
      documentUri: event.documentURI,
      effectiveDirective: event.effectiveDirective,
      sourceFile: event.sourceFile,
    });
  });
};

const safeLocation = (value, applicationOrigin) => {
  if (typeof value !== "string" || value === "") return "";
  if (/^(?:chrome|moz|safari-web)-extension:/iu.test(value)) return value;
  try {
    const url = new URL(value, applicationOrigin);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.slice(0, 512);
  }
};

export const classifyCspReportViolation = (violation) => {
  const candidates = [violation.blockedUri, violation.sourceFile];
  return candidates.some(
    (value) =>
      typeof value === "string" &&
      /^(?:chrome|moz|safari-web)-extension:/iu.test(value),
  )
    ? "known-extension-noise"
    : "first-party";
};

export const observeCspReportBrowser = async ({
  binding,
  cspPolicy,
  waf,
  browserType = chromium,
}) => {
  const target = new URL(binding.deploymentUrl);
  if (
    target.protocol !== "https:" &&
    !(
      target.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(target.hostname)
    )
  ) {
    throw new Error("CSP report target URL is not trusted");
  }
  const applicationOrigin = target.origin;
  const expectedHeader = renderCspPolicyValue(cspPolicy);
  assertCspReportWafAuthority(waf);
  const reportUrl = new URL(cspPolicy.reportEndpoint, binding.deploymentUrl)
    .href;
  const reportBody = {
    "csp-report": {
      ...CONTROLLED_REPORT["csp-report"],
      "document-uri": applicationOrigin,
    },
  };
  const receiptFor = async (response, method, ordinal) => {
    const [headers, body] = await Promise.all([
      Promise.resolve(response.headers()),
      response.body(),
    ]);
    if (body.length > MAXIMUM_PROBE_RESPONSE_BYTES) {
      throw new Error("CSP report route probe response is oversized");
    }
    return {
      ordinal,
      method,
      status: response.status(),
      allow: headers.allow ?? null,
      cacheControl: headers["cache-control"] ?? null,
      contentType: headers["content-type"] ?? null,
      bodyByteLength: body.length,
      bodySha256: sha256Bytes(body),
    };
  };
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    await page.addInitScript(violationCollector);
    const response = await page.goto(binding.deploymentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (response === null)
      throw new Error("CSP report document has no response");
    const headers = await response.allHeaders();
    if (
      headers["content-security-policy-report-only"] !== expectedHeader ||
      headers["content-security-policy"] !== undefined
    ) {
      throw new Error("CSP report-only response header differs from policy");
    }
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await page.locator("#root").waitFor({ state: "attached" });
    const normal = await page.evaluate(() => {
      const { document } = globalThis;
      return Boolean(document.querySelector("#root")?.childNodes.length);
    });
    if (!normal) throw new Error("CSP canonical normal scenario failed");
    const apiStatus = await page.evaluate(async () =>
      fetch("/release-identity.json", { cache: "no-store" }).then(
        (result) => result.status,
      ),
    );
    if (apiStatus !== 200) throw new Error("CSP canonical API scenario failed");
    const blobScheme = await page.evaluate(() => {
      const url = URL.createObjectURL(new Blob(["csp-report-scenario"]));
      try {
        return new URL(url).protocol;
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    if (blobScheme !== "blob:")
      throw new Error("CSP canonical Blob scenario failed");
    const identityResponse = await context.request.get(
      `${applicationOrigin}/release-identity.json`,
    );
    if (!identityResponse.ok())
      throw new Error("CSP release identity unavailable");
    const identity = parseJsonStrict(
      await identityResponse.text(),
      "CSP report release identity",
    );
    if (
      identity.sourceSha !== binding.sourceSha ||
      identity.buildId !== binding.buildId ||
      identity.releaseRole !== binding.releaseRole ||
      identity.variantId !== binding.variantId
    ) {
      throw new Error("CSP report release identity differs from binding");
    }
    const requestOptions = {
      data: reportBody,
      failOnStatusCode: false,
      headers: { "content-type": "application/csp-report" },
    };
    const methodDenialResponse = await context.request.get(reportUrl, {
      failOnStatusCode: false,
    });
    const reportResponse = await context.request.post(
      reportUrl,
      requestOptions,
    );
    const [methodDenial, validPost] = await Promise.all([
      receiptFor(methodDenialResponse, "GET", 1),
      receiptFor(reportResponse, "POST", 1),
    ]);
    const burstResponses = await Promise.all(
      Array.from({ length: waf.limit + 1 }, () =>
        context.request.post(reportUrl, requestOptions),
      ),
    );
    const rateBurst = await Promise.all(
      burstResponses.map((response, index) =>
        receiptFor(response, "POST", index + 1),
      ),
    );
    await page.waitForTimeout(300);
    const violations = await page.evaluate(
      () => globalThis.__espCspReportViolations ?? [],
    );
    await context.close();
    return {
      headerName: "Content-Security-Policy-Report-Only",
      headerValue: expectedHeader,
      reportEndpoint: cspPolicy.reportEndpoint,
      reportRouteStatus: reportResponse.status(),
      routeProbes: {
        methodDenial,
        validPost,
        rateBurst: {
          configuredLimit: waf.limit,
          receipts: rateBurst,
        },
      },
      releaseIdentity: {
        sourceSha: identity.sourceSha,
        buildId: identity.buildId,
        releaseRole: identity.releaseRole,
        variantId: identity.variantId,
      },
      scenarios: [
        { id: "blob-url", outcome: "succeeded" },
        { id: "normal", outcome: "succeeded" },
        { id: "same-origin-api", outcome: "succeeded" },
      ],
      violations: violations.map((violation) => ({
        blockedUri: safeLocation(violation.blockedUri, applicationOrigin),
        classification: classifyCspReportViolation(violation),
        disposition: violation.disposition,
        documentUri: safeLocation(violation.documentUri, applicationOrigin),
        effectiveDirective: violation.effectiveDirective,
        sourceFile: safeLocation(violation.sourceFile, applicationOrigin),
      })),
    };
  } finally {
    await browser.close();
  }
};

export const queryCspReportAggregates = async ({
  client,
  windowFrom,
  windowTo,
  sourceSha,
  providerDeploymentId,
  expectedObserverRole,
}) => {
  let began = false;
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    began = true;
    const identity = await client.query({
      name: "csp-report-observer-identity-v1",
      text: "select current_user as observer_role, current_setting('transaction_read_only') as read_only",
      values: [],
    });
    if (
      identity?.rows?.length !== 1 ||
      identity.rows[0].observer_role !== expectedObserverRole ||
      identity.rows[0].read_only !== "on"
    ) {
      throw new Error("CSP report DB observer authority differs");
    }
    const result = await client.query({
      name: "csp-report-deployment-aggregate-v1",
      text: `select effective_directive, disposition, blocked_target,
        violation_count::text, first_received_at, last_received_at
        from public.read_csp_deployment_violation_aggregates($1, $2, $3, $4, $5)`,
      values: [
        windowFrom,
        windowTo,
        sourceSha,
        providerDeploymentId,
        MAXIMUM_AGGREGATES,
      ],
    });
    if (
      !Array.isArray(result?.rows) ||
      result.rows.length > MAXIMUM_AGGREGATES
    ) {
      throw new Error("CSP report DB aggregate response is invalid");
    }
    await client.query("commit");
    began = false;
    return result.rows.map((row) => ({
      effectiveDirective: row.effective_directive,
      disposition: row.disposition,
      blockedTarget: row.blocked_target,
      violationCount: Number(row.violation_count),
      firstReceivedAt: new Date(row.first_received_at).toISOString(),
      lastReceivedAt: new Date(row.last_received_at).toISOString(),
    }));
  } catch (error) {
    if (began) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the authoritative query failure.
      }
    }
    throw error;
  }
};

const assertBrowser = (browser, cspPolicy) => {
  const expectedHeader = renderCspPolicyValue(cspPolicy);
  assertExactKeys(
    browser,
    [
      "headerName",
      "headerValue",
      "releaseIdentity",
      "reportEndpoint",
      "reportRouteStatus",
      "routeProbes",
      "scenarios",
      "violations",
    ],
    "CSP report browser trace",
  );
  if (
    browser.headerName !== "Content-Security-Policy-Report-Only" ||
    browser.headerValue !== expectedHeader ||
    browser.reportEndpoint !== cspPolicy.reportEndpoint ||
    browser.reportRouteStatus !== 204 ||
    !Array.isArray(browser.scenarios) ||
    !sameCanonicalValue(
      browser.scenarios.map(({ id }) => id),
      SCENARIO_IDS,
    ) ||
    !Array.isArray(browser.violations)
  ) {
    throw new Error("CSP report browser trace differs");
  }
  assertExactKeys(
    browser.routeProbes,
    ["methodDenial", "rateBurst", "validPost"],
    "CSP report route probes",
  );
  const assertProbeReceipt = (receipt, method, ordinal, label) => {
    assertExactKeys(receipt, PROBE_RECEIPT_KEYS, label);
    if (
      receipt.method !== method ||
      receipt.ordinal !== ordinal ||
      !Number.isSafeInteger(receipt.status) ||
      receipt.status < 100 ||
      receipt.status > 599 ||
      !Number.isSafeInteger(receipt.bodyByteLength) ||
      receipt.bodyByteLength < 0 ||
      !SHA256.test(receipt.bodySha256 ?? "") ||
      !["allow", "cacheControl", "contentType"].every(
        (key) => receipt[key] === null || typeof receipt[key] === "string",
      )
    ) {
      throw new Error(`${label} is invalid`);
    }
  };
  assertProbeReceipt(
    browser.routeProbes.methodDenial,
    "GET",
    1,
    "CSP report method denial",
  );
  assertProbeReceipt(
    browser.routeProbes.validPost,
    "POST",
    1,
    "CSP report valid POST",
  );
  const methodDenial = browser.routeProbes.methodDenial;
  const validPost = browser.routeProbes.validPost;
  if (
    methodDenial.status !== 405 ||
    methodDenial.allow !== "POST" ||
    methodDenial.cacheControl !== "no-store" ||
    methodDenial.bodyByteLength !== 0 ||
    methodDenial.bodySha256 !== sha256Bytes(Buffer.alloc(0)) ||
    validPost.status !== 204 ||
    validPost.cacheControl !== "no-store" ||
    validPost.bodyByteLength !== 0 ||
    validPost.bodySha256 !== sha256Bytes(Buffer.alloc(0))
  ) {
    throw new Error("CSP report method/valid route contract differs");
  }
  assertExactKeys(
    browser.routeProbes.rateBurst,
    ["configuredLimit", "receipts"],
    "CSP report rate burst",
  );
  const rateBurst = browser.routeProbes.rateBurst;
  if (
    !Number.isSafeInteger(rateBurst.configuredLimit) ||
    rateBurst.configuredLimit < 2 ||
    !Array.isArray(rateBurst.receipts) ||
    rateBurst.receipts.length !== rateBurst.configuredLimit + 1
  ) {
    throw new Error("CSP report rate burst size differs");
  }
  rateBurst.receipts.forEach((receipt, index) => {
    assertProbeReceipt(
      receipt,
      "POST",
      index + 1,
      `CSP report rate burst ${index + 1}`,
    );
    if (![204, 429].includes(receipt.status)) {
      throw new Error("CSP report rate burst has an unexpected response");
    }
  });
  if (!rateBurst.receipts.some(({ status }) => status === 429)) {
    throw new Error("CSP report rate burst did not exercise provider denial");
  }
  assertExactKeys(
    browser.releaseIdentity,
    ["buildId", "releaseRole", "sourceSha", "variantId"],
    "CSP report release identity",
  );
  for (const scenario of browser.scenarios) {
    assertExactKeys(scenario, ["id", "outcome"], "CSP report scenario");
    if (scenario.outcome !== "succeeded")
      throw new Error("CSP report scenario failed");
  }
  for (const violation of browser.violations) {
    assertExactKeys(
      violation,
      [
        "blockedUri",
        "classification",
        "disposition",
        "documentUri",
        "effectiveDirective",
        "sourceFile",
      ],
      "CSP report violation",
    );
    if (
      !["known-extension-noise", "first-party"].includes(
        violation.classification,
      ) ||
      classifyCspReportViolation(violation) !== violation.classification ||
      Object.entries(violation).some(
        ([key, value]) => key !== "classification" && typeof value !== "string",
      )
    ) {
      throw new Error("CSP report violation classification is invalid");
    }
  }
};

export const assertCspReportObservationRaw = (raw, cspPolicy) => {
  assertExactKeys(
    raw,
    [
      "binding",
      "browser",
      "database",
      "kind",
      "namespace",
      "observedAt",
      "phaseState",
      "provider",
      "releaseStateHead",
      "schemaVersion",
      "sourceSha",
      "window",
    ],
    "CSP report raw observation",
  );
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== "csp-report-observation-raw/v1" ||
    !NAMESPACE.test(raw.namespace ?? "") ||
    !SOURCE_SHA.test(raw.sourceSha ?? "")
  ) {
    throw new Error("CSP report raw identity is invalid");
  }
  timestamp(raw.observedAt, "CSP report observedAt");
  assertExactKeys(
    raw.releaseStateHead,
    ["eventHash", "sequence"],
    "CSP report state head",
  );
  if (!SHA256.test(raw.releaseStateHead.eventHash ?? ""))
    throw new Error("CSP report state head invalid");
  assertCspReportPhaseStateAuthority(raw.phaseState);
  if (
    !sameCanonicalValue(
      raw.phaseState.releaseStateHead,
      raw.releaseStateHead,
    ) ||
    raw.phaseState.acceptedStandard.bindingId !== raw.binding?.bindingId ||
    raw.phaseState.acceptedStandard.providerDeploymentId !==
      raw.binding?.providerDeploymentId ||
    raw.phaseState.acceptedStandard.sourceSha !== raw.sourceSha
  ) {
    throw new Error("CSP report phase-state authority differs from binding");
  }
  assertExactKeys(
    raw.provider,
    ["configurationHash", "observation", "policy", "waf"],
    "CSP report provider authority",
  );
  assertImmutableObjectReference(
    raw.provider.observation,
    raw.namespace,
    "CSP report provider observation",
  );
  assertImmutableObjectReference(
    raw.provider.policy,
    raw.namespace,
    "CSP report provider policy",
  );
  assertCspReportWafAuthority(raw.provider.waf);
  if (
    !SHA256.test(raw.provider.configurationHash ?? "") ||
    raw.provider.configurationHash !==
      raw.phaseState.acceptedStandard.providerConfigurationHash ||
    raw.provider.waf.limit !==
      raw.browser?.routeProbes?.rateBurst?.configuredLimit
  ) {
    throw new Error("CSP report live provider authority differs from binding");
  }
  assertExactKeys(
    raw.binding,
    [
      "bindingId",
      "deploymentUrl",
      "policyEligibility",
      "providerDeploymentId",
      "providerProjectId",
      "releaseRole",
      "selection",
      "sourceSha",
    ],
    "CSP report binding",
  );
  if (
    raw.binding.sourceSha !== raw.sourceSha ||
    !["standard", "containment"].includes(raw.binding.releaseRole) ||
    !["active-production", "prepared-production"].includes(
      raw.binding.selection,
    ) ||
    !["active", "compatible-predecessor"].includes(
      raw.binding.policyEligibility,
    ) ||
    typeof raw.binding.providerDeploymentId !== "string" ||
    raw.binding.providerDeploymentId.length === 0
  ) {
    throw new Error("CSP report binding is invalid");
  }
  assertExactKeys(
    raw.window,
    ["fromInclusive", "toExclusive"],
    "CSP report query window",
  );
  const from = timestamp(raw.window.fromInclusive, "CSP report window start");
  const to = timestamp(raw.window.toExclusive, "CSP report window end");
  if (from >= to || to - from > 8 * 24 * 60 * 60 * 1000) {
    throw new Error("CSP report query window is invalid");
  }
  assertBrowser(raw.browser, cspPolicy);
  if (
    raw.browser.releaseIdentity.sourceSha !== raw.sourceSha ||
    raw.browser.releaseIdentity.buildId !== raw.sourceSha ||
    raw.browser.releaseIdentity.releaseRole !== raw.binding.releaseRole
  ) {
    throw new Error("CSP report release identity differs from raw binding");
  }
  assertExactKeys(
    raw.database,
    ["aggregates", "fingerprint", "providerDeploymentId", "sourceSha"],
    "CSP report DB observation",
  );
  if (
    raw.database.sourceSha !== raw.sourceSha ||
    raw.database.providerDeploymentId !== raw.binding.providerDeploymentId ||
    !SHA256.test(raw.database.fingerprint ?? "") ||
    !Array.isArray(raw.database.aggregates) ||
    raw.database.aggregates.length > MAXIMUM_AGGREGATES
  ) {
    throw new Error("CSP report DB binding differs");
  }
  for (const aggregate of raw.database.aggregates) {
    assertExactKeys(
      aggregate,
      [
        "blockedTarget",
        "disposition",
        "effectiveDirective",
        "firstReceivedAt",
        "lastReceivedAt",
        "violationCount",
      ],
      "CSP report aggregate",
    );
    const first = timestamp(
      aggregate.firstReceivedAt,
      "CSP aggregate first time",
    );
    const last = timestamp(aggregate.lastReceivedAt, "CSP aggregate last time");
    if (
      first < from ||
      first >= to ||
      last < first ||
      last >= to ||
      !Number.isSafeInteger(aggregate.violationCount) ||
      aggregate.violationCount < 1 ||
      ![
        aggregate.blockedTarget,
        aggregate.disposition,
        aggregate.effectiveDirective,
      ].every((value) => typeof value === "string" && value.length > 0)
    ) {
      throw new Error("CSP report aggregate exceeds its exclusive window");
    }
  }
  return raw;
};

export const summarizeCspReportObservation = (raw, cspPolicy) => {
  assertCspReportObservationRaw(raw, cspPolicy);
  const browserFirstPartyCount = raw.browser.violations.filter(
    ({ classification }) => classification === "first-party",
  ).length;
  const expectedNoiseCount = raw.browser.violations.filter(
    ({ classification }) => classification === "known-extension-noise",
  ).length;
  const storedSanitizedReportCount = raw.database.aggregates.reduce(
    (count, aggregate) => count + aggregate.violationCount,
    0,
  );
  const applicationOrigin = new URL(raw.binding.deploymentUrl).origin;
  const knownNoiseAggregates = new Map();
  for (const violation of raw.browser.violations.filter(
    ({ classification }) => classification === "known-extension-noise",
  )) {
    const key = `${violation.effectiveDirective}\u0000${violation.disposition}\u0000${classifyBlockedTarget(violation.blockedUri, applicationOrigin)}`;
    knownNoiseAggregates.set(key, (knownNoiseAggregates.get(key) ?? 0) + 1);
  }
  const acceptedControlledProbeCount =
    (raw.browser.routeProbes.validPost.status === 204 ? 1 : 0) +
    raw.browser.routeProbes.rateBurst.receipts.filter(
      ({ status }) => status === 204,
    ).length;
  let canonicalProbeRemaining = acceptedControlledProbeCount;
  let databaseFirstPartyCount = 0;
  for (const aggregate of raw.database.aggregates) {
    const key = `${aggregate.effectiveDirective}\u0000${aggregate.disposition}\u0000${aggregate.blockedTarget}`;
    let remaining = aggregate.violationCount;
    if (
      key === "img-src\u0000report\u0000scheme" &&
      canonicalProbeRemaining > 0
    ) {
      const consumed = Math.min(remaining, canonicalProbeRemaining);
      remaining -= consumed;
      canonicalProbeRemaining -= consumed;
    }
    const knownNoise = knownNoiseAggregates.get(key) ?? 0;
    const noiseConsumed = Math.min(remaining, knownNoise);
    remaining -= noiseConsumed;
    knownNoiseAggregates.set(key, knownNoise - noiseConsumed);
    databaseFirstPartyCount += remaining;
  }
  if (canonicalProbeRemaining !== 0 || storedSanitizedReportCount < 1) {
    throw new Error("CSP report controlled sink probe was not stored");
  }
  const unexpectedFirstPartyViolationCount =
    browserFirstPartyCount + databaseFirstPartyCount;
  if (unexpectedFirstPartyViolationCount !== 0) {
    throw new Error("CSP report observation contains first-party violations");
  }
  return {
    deploymentId: raw.binding.providerDeploymentId,
    headerName: raw.browser.headerName,
    reportEndpoint: raw.browser.reportEndpoint,
    reportRouteStatus: raw.browser.reportRouteStatus,
    methodDenialStatus: raw.browser.routeProbes.methodDenial.status,
    preP2BReportRouteStatus: raw.phaseState.preP2B.reportRoute.status,
    rateLimitConfigured: raw.provider.waf.limit,
    rateLimitSentRequestCount:
      raw.browser.routeProbes.rateBurst.receipts.length,
    rateLimitedRequestCount: raw.browser.routeProbes.rateBurst.receipts.filter(
      ({ status }) => status === 429,
    ).length,
    wafConfigurationSha256: raw.provider.waf.configurationSha256,
    phaseStateSha256: sha256Bytes(canonicalJsonBytes(raw.phaseState)),
    canonicalScenarioCount: raw.browser.scenarios.length,
    unexpectedFirstPartyViolationCount,
    expectedNoiseCount,
    storedSanitizedReportCount,
    databaseFingerprint: raw.database.fingerprint,
    outcome: "succeeded",
    rawSha256: sha256Bytes(canonicalJsonBytes(raw)),
  };
};

export const readStoredCspReportObservation = async ({
  store,
  namespace,
  reference,
  cspPolicy,
}) => {
  if (store?.namespace !== namespace)
    throw new Error("CSP report store namespace differs");
  assertImmutableObjectReference(
    reference,
    namespace,
    "CSP report raw reference",
  );
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== CSP_REPORT_OBSERVATION_RAW_MEDIA_TYPE ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error("Stored CSP report observation differs");
  }
  timestamp(stored.committedAt, "Stored CSP report immutable commit");
  const raw = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Stored CSP report observation",
  );
  if (!canonicalJsonBytes(raw).equals(stored.bytes))
    throw new Error("Stored CSP report observation is not canonical");
  return {
    bytes: Buffer.from(stored.bytes),
    committedAt: stored.committedAt,
    raw,
    result: summarizeCspReportObservation(raw, cspPolicy),
  };
};

export const readStoredCspReportObservationAuthority = async ({
  store,
  namespace,
  reference,
  cspPolicy,
  providerPolicy,
  current,
  sourceSha,
  now = Date.now,
}) => {
  const stored = await readStoredCspReportObservation({
    store,
    namespace,
    reference,
    cspPolicy,
  });
  const [phaseState, provider] = await Promise.all([
    resolveCspReportPhaseStateAuthority({
      store,
      current,
      namespace,
      sourceSha,
    }),
    readStoredRemoteDbProviderObservationAuthority({
      store,
      namespace,
      reference: stored.raw.provider.observation,
      policyReference: stored.raw.provider.policy,
      now,
    }),
  ]);
  const waf = deriveCspReportWafAuthority({
    providerObservation: provider.observation,
    providerPolicy,
    reportEndpoint: cspPolicy.reportEndpoint,
  });
  if (
    !sameCanonicalValue(provider.providerPolicy, providerPolicy) ||
    !sameCanonicalValue(phaseState, stored.raw.phaseState) ||
    !sameCanonicalValue(waf, stored.raw.provider.waf) ||
    providerConfigurationHash(provider.observation) !==
      stored.raw.provider.configurationHash ||
    stored.raw.releaseStateHead.eventHash !== current.head.eventHash ||
    stored.raw.releaseStateHead.sequence !== current.head.sequence
  ) {
    throw new Error(
      "Stored CSP report authority differs from live provider or Release State",
    );
  }
  return { ...stored, phaseState, provider };
};

export const putCspReportObservation = async ({ store, raw, cspPolicy }) => {
  summarizeCspReportObservation(raw, cspPolicy);
  const bytes = canonicalJsonBytes(raw);
  if (store?.namespace !== raw.namespace || bytes.length > MAXIMUM_RAW_BYTES) {
    throw new Error("CSP report store namespace or size differs");
  }
  const reference = referenceFor(raw.namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: CSP_REPORT_OBSERVATION_RAW_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== CSP_REPORT_OBSERVATION_RAW_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string"
  ) {
    throw new Error("CSP report immutable receipt differs");
  }
  const readback = await readStoredCspReportObservation({
    store,
    namespace: raw.namespace,
    reference,
    cspPolicy,
  });
  if (
    !readback.bytes.equals(bytes) ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error("CSP report immutable readback differs");
  }
  return { reference, readback };
};

export const assertCspReportObservation = (observation) => {
  assertExactKeys(
    observation,
    [
      "binding",
      "collectorIdentity",
      "kind",
      "namespace",
      "observedAt",
      "oidcReceipt",
      "rawObservation",
      "releaseStateHead",
      "result",
      "schemaVersion",
      "sourceSha",
    ],
    "CSP report observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.kind !== "csp-report-observation/v1" ||
    !NAMESPACE.test(observation.namespace ?? "") ||
    !SOURCE_SHA.test(observation.sourceSha ?? "")
  ) {
    throw new Error("CSP report observation identity is invalid");
  }
  timestamp(observation.observedAt, "CSP report observation time");
  assertBrowserPhaseExitCollectorIdentity(
    observation.collectorIdentity,
    observation.sourceSha,
  );
  assertExactKeys(
    observation.releaseStateHead,
    ["eventHash", "sequence"],
    "CSP report observation state head",
  );
  if (
    !Number.isSafeInteger(observation.releaseStateHead.sequence) ||
    observation.releaseStateHead.sequence < 1 ||
    !SHA256.test(observation.releaseStateHead.eventHash ?? "")
  ) {
    throw new Error("CSP report observation state head is invalid");
  }
  assertExactKeys(
    observation.binding,
    [
      "bindingId",
      "deploymentUrl",
      "policyEligibility",
      "providerDeploymentId",
      "providerProjectId",
      "releaseRole",
      "selection",
      "sourceSha",
    ],
    "CSP report observation binding",
  );
  if (
    observation.binding.sourceSha !== observation.sourceSha ||
    !["standard", "containment"].includes(observation.binding.releaseRole) ||
    !["active-production", "prepared-production"].includes(
      observation.binding.selection,
    )
  ) {
    throw new Error("CSP report observation binding is invalid");
  }
  assertImmutableObjectReference(
    observation.oidcReceipt,
    observation.namespace,
    "CSP report OIDC receipt",
  );
  assertImmutableObjectReference(
    observation.rawObservation,
    observation.namespace,
    "CSP report raw observation",
  );
  assertExactKeys(
    observation.result,
    [
      "canonicalScenarioCount",
      "databaseFingerprint",
      "deploymentId",
      "expectedNoiseCount",
      "headerName",
      "methodDenialStatus",
      "outcome",
      "phaseStateSha256",
      "preP2BReportRouteStatus",
      "rateLimitConfigured",
      "rateLimitSentRequestCount",
      "rateLimitedRequestCount",
      "rawSha256",
      "reportEndpoint",
      "reportRouteStatus",
      "storedSanitizedReportCount",
      "unexpectedFirstPartyViolationCount",
      "wafConfigurationSha256",
    ],
    "CSP report result",
  );
  if (
    observation.result.rawSha256 !== observation.rawObservation.sha256 ||
    observation.result.deploymentId !==
      observation.binding.providerDeploymentId ||
    observation.result.headerName !== "Content-Security-Policy-Report-Only" ||
    observation.result.reportRouteStatus !== 204 ||
    observation.result.methodDenialStatus !== 405 ||
    observation.result.preP2BReportRouteStatus !== 404 ||
    typeof observation.result.reportEndpoint !== "string" ||
    !observation.result.reportEndpoint.startsWith("/") ||
    observation.result.unexpectedFirstPartyViolationCount !== 0 ||
    !SHA256.test(observation.result.databaseFingerprint ?? "") ||
    !SHA256.test(observation.result.wafConfigurationSha256 ?? "") ||
    !SHA256.test(observation.result.phaseStateSha256 ?? "") ||
    observation.result.outcome !== "succeeded"
  ) {
    throw new Error("CSP report observation result differs");
  }
  for (const key of [
    "canonicalScenarioCount",
    "expectedNoiseCount",
    "rateLimitConfigured",
    "rateLimitSentRequestCount",
    "rateLimitedRequestCount",
    "storedSanitizedReportCount",
  ]) {
    if (
      !Number.isSafeInteger(observation.result[key]) ||
      observation.result[key] < 0
    ) {
      throw new Error(`CSP report observation ${key} is invalid`);
    }
  }
  if (observation.result.canonicalScenarioCount < 1) {
    throw new Error("CSP report observation has no canonical scenarios");
  }
  if (
    observation.result.rateLimitConfigured < 2 ||
    observation.result.rateLimitSentRequestCount !==
      observation.result.rateLimitConfigured + 1 ||
    observation.result.rateLimitedRequestCount < 1 ||
    observation.result.rateLimitedRequestCount >
      observation.result.rateLimitSentRequestCount
  ) {
    throw new Error("CSP report observation rate-limit result is invalid");
  }
  return observation;
};

export const collectAndStoreCspReportObservation = async (
  {
    current,
    store,
    namespace,
    sourceSha,
    oidcReceipt,
    oidcAuthority,
    cspPolicy,
    providerPolicy,
    providerToken,
    dbClient,
    expectedObserverRole,
    observeBrowser = observeCspReportBrowser,
    queryAggregates = queryCspReportAggregates,
    now = () => Date.now(),
  },
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    collectProviderObservation = collectVercelProviderObservation,
    storeProviderObservation = putRemoteDbProviderObservationAuthority,
    resolvePhaseState = resolveCspReportPhaseStateAuthority,
    assertProviderPolicy = assertProviderPolicyConfigured,
    readState = null,
  } = {},
) => {
  await readOidcAuthority({
    store,
    namespace,
    reference: oidcReceipt,
    approvalPolicy: oidcAuthority.approvalPolicy,
    sourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
  });
  const selected = resolveProductionRequestGraphBinding({
    current,
    namespace,
    sourceSha,
    nowMilliseconds: Number(now()),
  });
  const collectorIdentity = deriveBrowserPhaseExitCollectorIdentity({
    sourceSha,
    oidcAuthority,
  });
  assertProviderPolicy(providerPolicy);
  if (typeof providerToken !== "string" || providerToken.length < 16) {
    throw new Error("CSP report provider token is absent or invalid");
  }
  if (selected.binding.releasePolicy === undefined)
    throw new Error("CSP report binding policy is absent");
  const [providerObservation, phaseState] = await Promise.all([
    collectProviderObservation({
      policy: providerPolicy,
      token: providerToken,
      now: Number(now()),
    }),
    resolvePhaseState({ store, current, namespace, sourceSha }),
  ]);
  if (
    providerConfigurationHash(providerObservation) !==
    selected.binding.providerConfigurationHash
  ) {
    throw new Error("CSP report live provider configuration drifted");
  }
  const waf = deriveCspReportWafAuthority({
    providerObservation,
    providerPolicy,
    reportEndpoint: cspPolicy.reportEndpoint,
  });
  const storedProvider = await storeProviderObservation({
    store,
    namespace,
    bytes: canonicalJsonBytes(providerObservation),
    providerPolicy,
  });
  if (
    !sameCanonicalValue(
      storedProvider.policyReference,
      selected.binding.providerPolicy,
    )
  ) {
    throw new Error("CSP report provider policy differs from binding");
  }
  const windowFrom = new Date(Number(now())).toISOString();
  const browser = await observeBrowser({
    binding: selected.binding,
    cspPolicy,
    waf,
  });
  const windowTo = new Date(Number(now())).toISOString();
  if (Date.parse(windowFrom) >= Date.parse(windowTo))
    throw new Error("CSP report observation window did not advance");
  const aggregates = await queryAggregates({
    client: dbClient,
    windowFrom,
    windowTo,
    sourceSha,
    providerDeploymentId: selected.binding.providerDeploymentId,
    expectedObserverRole,
  });
  const raw = {
    schemaVersion: 1,
    kind: "csp-report-observation-raw/v1",
    namespace,
    sourceSha,
    observedAt: windowTo,
    releaseStateHead: { ...current.head },
    binding: { ...selected.projection },
    phaseState,
    provider: {
      observation: { ...storedProvider.reference },
      policy: { ...storedProvider.policyReference },
      configurationHash: providerConfigurationHash(providerObservation),
      waf,
    },
    window: { fromInclusive: windowFrom, toExclusive: windowTo },
    browser,
    database: {
      sourceSha,
      providerDeploymentId: selected.binding.providerDeploymentId,
      fingerprint: current.snapshot.currentDbCompatibility.fingerprint,
      aggregates,
    },
  };
  if (
    browser.releaseIdentity.sourceSha !== sourceSha ||
    browser.releaseIdentity.buildId !== selected.binding.buildId ||
    browser.releaseIdentity.releaseRole !== selected.binding.releaseRole ||
    browser.releaseIdentity.variantId !== selected.binding.variantId
  ) {
    throw new Error("CSP report browser identity changed authority");
  }
  const stored = await putCspReportObservation({ store, raw, cspPolicy });
  if (typeof readState === "function") {
    const final = await readState({ store, requireInitialized: true });
    if (
      final.head.sequence !== current.head.sequence ||
      final.head.eventHash !== current.head.eventHash
    ) {
      throw new Error(
        "Release State head changed during CSP report observation",
      );
    }
  }
  const observation = {
    schemaVersion: 1,
    kind: "csp-report-observation/v1",
    namespace,
    sourceSha,
    collectorIdentity,
    observedAt: windowTo,
    releaseStateHead: { ...current.head },
    binding: { ...selected.projection },
    oidcReceipt: { ...oidcReceipt },
    rawObservation: { ...stored.reference },
    result: { ...stored.readback.result },
  };
  assertCspReportObservation(observation);
  return observation;
};
