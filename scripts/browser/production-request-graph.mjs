import { chromium } from "playwright";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { assertBindingPolicyEligible } from "../release-state/policyCompatibility.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  assertStoredGitHubOidcReceipt,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "../release-state/githubOidc.mjs";
import {
  assertDeploymentBinding,
  assertExactKeys,
  assertImmutableObjectReference,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";

export const PRODUCTION_REQUEST_GRAPH_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.production-request-graph-raw+json;version=1";
export const PRODUCTION_REQUEST_GRAPH_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.production-request-graph-observation+json;version=1";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
export const BROWSER_PHASE_EXIT_WORKFLOW_PATH = ".github/workflows/release.yml";
const MAXIMUM_RAW_GRAPH_BYTES = 16 * 1024 * 1024;
const MAXIMUM_REQUESTS = 20_000;
const MAXIMUM_RUNTIME_CSS_WRITES = 10_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const compareUtf8 = (left, right) =>
  Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const assertBrowserPhaseExitCollectorIdentity = (
  identity,
  expectedSourceSha,
) => {
  assertExactKeys(
    identity,
    ["repository", "runAttempt", "runId", "sourceSha", "workflowPath"],
    "Browser phase-exit collector identity",
  );
  if (
    !REPOSITORY_PATTERN.test(identity.repository ?? "") ||
    identity.workflowPath !== BROWSER_PHASE_EXIT_WORKFLOW_PATH ||
    !SOURCE_SHA_PATTERN.test(identity.sourceSha ?? "") ||
    identity.sourceSha !== expectedSourceSha ||
    !RUN_ID_PATTERN.test(identity.runId ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(identity.runAttempt ?? "")
  ) {
    throw new Error("Browser phase-exit collector identity is invalid");
  }
  return identity;
};

export const deriveBrowserPhaseExitCollectorIdentity = ({
  sourceSha,
  oidcAuthority,
}) => {
  const identity = {
    repository: oidcAuthority?.approvalPolicy?.repository,
    workflowPath: BROWSER_PHASE_EXIT_WORKFLOW_PATH,
    sourceSha,
    runId: oidcAuthority?.runId,
    runAttempt: oidcAuthority?.runAttempt,
  };
  assertBrowserPhaseExitCollectorIdentity(identity, sourceSha);
  return identity;
};

const assertCanonicalTimestamp = (value, label) => {
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

const assertHead = (head, label = "Release State head") => {
  assertExactKeys(head, ["eventHash", "sequence"], label);
  if (
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    !SHA256_PATTERN.test(head.eventHash ?? "")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return head;
};

const canonicalOrigin = (value, { allowInsecureLocalhost = false } = {}) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Production request graph target URL is invalid");
  }
  const localHttp =
    allowInsecureLocalhost &&
    parsed.protocol === "http:" &&
    LOCAL_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Production request graph target is not trusted");
  }
  return parsed.origin;
};

const requestPath = (value) => {
  const parsed = new URL(value);
  return `${parsed.pathname}${parsed.search === "" ? "" : `?sha256=${sha256Bytes(Buffer.from(parsed.search, "utf8"))}`}`;
};

const bindingProjection = ({ binding, selection, policyEligibility }) => ({
  bindingId: binding.bindingId,
  sourceSha: binding.sourceSha,
  releaseRole: binding.releaseRole,
  providerProjectId: binding.providerProjectId,
  providerDeploymentId: binding.providerDeploymentId,
  deploymentUrl: binding.deploymentUrl,
  selection,
  policyEligibility,
});

const actionForRole = (role) =>
  role === "standard" ? "rollback" : "containment";

const assertCurrentDbBinding = (snapshot, binding) => {
  if (
    !isRecord(snapshot.currentDbCompatibility) ||
    !sameCanonicalValue(
      snapshot.currentDbCompatibility,
      binding.requiredDbCompatibility,
    )
  ) {
    throw new Error(
      "Production request graph binding differs from current DB compatibility",
    );
  }
};

const assertPreparedAssignment = ({ current, binding, operation }) => {
  const matchingEvents = current.records.filter(
    ({ event }) =>
      event?.operationId === operation.operationId &&
      ["deployment-assigned", "assignment-validated"].includes(
        event.eventType,
      ) &&
      sameCanonicalValue(event.payload?.targetBinding, binding),
  );
  const kinds = new Set(matchingEvents.map(({ event }) => event.eventType));
  if (!kinds.has("deployment-assigned") || !kinds.has("assignment-validated")) {
    throw new Error(
      "Prepared production binding lacks assigned and validated authority",
    );
  }
};

export const resolveProductionRequestGraphBinding = ({
  current,
  namespace,
  sourceSha,
  nowMilliseconds = Date.now(),
}) => {
  if (
    !NAMESPACE_PATTERN.test(namespace ?? "") ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !isRecord(current?.snapshot) ||
    !Array.isArray(current.records)
  ) {
    throw new Error("Production request graph Release State input is invalid");
  }
  if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
    throw new Error("Production request graph eligibility clock is invalid");
  }
  assertHead(current.head);
  const candidates = [];
  const active = current.snapshot.activeProduction;
  if (active !== null && active !== undefined) {
    assertDeploymentBinding(active, {
      namespace,
      label: "Active production request graph binding",
    });
    if (active.sourceSha === sourceSha) {
      const policy = assertBindingPolicyEligible({
        snapshot: current.snapshot,
        binding: active,
        action: actionForRole(active.releaseRole),
        label: "Active production request graph binding",
      });
      if (
        policy.kind === "compatible-predecessor" &&
        Date.parse(policy.entry.expiresAt) <= nowMilliseconds
      ) {
        throw new Error("Active production request graph eligibility expired");
      }
      assertCurrentDbBinding(current.snapshot, active);
      candidates.push({
        binding: active,
        selection: "active-production",
        policyEligibility: policy.kind,
      });
    }
  }

  const operation = current.snapshot.pendingOperation;
  const prepared = operation?.targetBinding;
  if (prepared !== null && prepared !== undefined) {
    assertDeploymentBinding(prepared, {
      namespace,
      label: "Prepared production request graph binding",
    });
    if (prepared.sourceSha === sourceSha) {
      assertPreparedAssignment({ current, binding: prepared, operation });
      const policy = assertBindingPolicyEligible({
        snapshot: current.snapshot,
        binding: prepared,
        action: actionForRole(prepared.releaseRole),
        label: "Prepared production request graph binding",
      });
      if (
        policy.kind === "compatible-predecessor" &&
        Date.parse(policy.entry.expiresAt) <= nowMilliseconds
      ) {
        throw new Error(
          "Prepared production request graph eligibility expired",
        );
      }
      assertCurrentDbBinding(current.snapshot, prepared);
      candidates.push({
        binding: prepared,
        selection: "prepared-production",
        policyEligibility: policy.kind,
      });
    }
  }

  const distinct = new Map();
  for (const candidate of candidates) {
    if (!distinct.has(candidate.binding.bindingId)) {
      distinct.set(candidate.binding.bindingId, candidate);
    }
  }
  if (distinct.size !== 1) {
    throw new Error(
      distinct.size === 0
        ? "No exact current or prepared production binding matches source SHA"
        : "Current and prepared production bindings are ambiguous",
    );
  }
  const selected = [...distinct.values()][0];
  return Object.freeze({
    binding: selected.binding,
    projection: Object.freeze(bindingProjection(selected)),
  });
};

const cssInstrumentation = () => {
  const {
    CSSStyleSheet,
    Document,
    Element,
    MutationObserver,
    Node,
    ShadowRoot,
    document,
  } = globalThis;
  const writes = [];
  let sequence = 0;
  const record = (operation, target) => {
    if (writes.length >= 10_000) return;
    writes.push({ sequence: (sequence += 1), operation, target });
  };
  Object.defineProperty(globalThis, "__espProductionRequestGraphCssWrites", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: writes,
  });

  for (const method of ["insertRule", "deleteRule", "replace", "replaceSync"]) {
    const original = CSSStyleSheet.prototype[method];
    if (typeof original !== "function") continue;
    Object.defineProperty(CSSStyleSheet.prototype, method, {
      configurable: true,
      writable: true,
      value: function instrumentedStylesheetWrite(...arguments_) {
        record(`CSSStyleSheet.${method}`, "stylesheet");
        return original.apply(this, arguments_);
      },
    });
  }

  const containsStyleElement = (node) =>
    node?.nodeType === Node.ELEMENT_NODE &&
    (node.localName === "style" || Boolean(node.querySelector?.("style")));
  for (const method of ["appendChild", "insertBefore", "replaceChild"]) {
    const original = Node.prototype[method];
    Object.defineProperty(Node.prototype, method, {
      configurable: true,
      writable: true,
      value: function instrumentedNodeInsertion(...arguments_) {
        if (containsStyleElement(arguments_[0])) {
          record(`Node.${method}`, arguments_[0].localName || "element");
        }
        return original.apply(this, arguments_);
      },
    });
  }
  for (const method of ["append", "prepend"]) {
    const original = Element.prototype[method];
    Object.defineProperty(Element.prototype, method, {
      configurable: true,
      writable: true,
      value: function instrumentedElementInsertion(...arguments_) {
        for (const argument of arguments_) {
          if (containsStyleElement(argument)) {
            record(`Element.${method}`, argument.localName || "element");
          }
        }
        return original.apply(this, arguments_);
      },
    });
  }

  for (const prototype of [Document.prototype, ShadowRoot.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "adoptedStyleSheets",
    );
    if (typeof descriptor?.set !== "function") continue;
    Object.defineProperty(prototype, "adoptedStyleSheets", {
      ...descriptor,
      set(value) {
        record("adoptedStyleSheets", this.nodeName || "document");
        descriptor.set.call(this, value);
      },
    });
  }

  const startObserver = () => {
    new MutationObserver((records) => {
      for (const mutation of records) {
        if (
          mutation.type === "characterData" &&
          mutation.target.parentElement?.localName === "style"
        ) {
          record("MutationObserver.style-text", "style");
        }
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node.localName === "style" || node.querySelector?.("style"))
          ) {
            record("MutationObserver.style-element", node.localName);
          }
        }
      }
    }).observe(document, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  };
  startObserver();
};

const assertReleaseIdentity = ({ identity, binding }) => {
  if (
    !isRecord(identity) ||
    identity.sourceSha !== binding.sourceSha ||
    identity.buildId !== binding.sourceSha ||
    identity.releaseRole !== binding.releaseRole ||
    identity.variantId !== binding.variantId
  ) {
    throw new Error(
      "Observed release identity differs from the selected production binding",
    );
  }
};

export const observeProductionRequestGraph = async ({
  binding,
  namespace,
  releaseStateHead,
  bindingSelection,
  now = () => Date.now(),
  browserType = chromium,
  allowInsecureLocalhost = false,
}) => {
  const applicationOrigin = canonicalOrigin(binding.deploymentUrl, {
    allowInsecureLocalhost,
  });
  const observedAt = new Date(Number(now())).toISOString();
  assertCanonicalTimestamp(observedAt, "Production request graph observedAt");
  assertHead(releaseStateHead);
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({
      serviceWorkers: "allow",
    });
    const requests = [];
    const byRequest = new WeakMap();
    let sequence = 0;
    context.on("request", (request) => {
      const parsed = new URL(request.url());
      if (!["http:", "https:"].includes(parsed.protocol)) return;
      const previous = request.redirectedFrom();
      const entry = {
        sequence: (sequence += 1),
        origin: parsed.origin,
        path: requestPath(parsed.href),
        method: request.method(),
        resourceType: request.resourceType(),
        navigation: request.isNavigationRequest(),
        redirectFrom:
          previous === null
            ? null
            : {
                origin: new URL(previous.url()).origin,
                path: requestPath(previous.url()),
              },
        responseStatus: null,
        responseContentType: null,
      };
      requests.push(entry);
      byRequest.set(request, entry);
    });
    context.on("response", async (response) => {
      const entry = byRequest.get(response.request());
      if (entry === undefined) return;
      entry.responseStatus = response.status();
      entry.responseContentType =
        (await response.headerValue("content-type")) ?? null;
    });

    const page = await context.newPage();
    await page.addInitScript(cssInstrumentation);
    const response = await page.goto(binding.deploymentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (response === null) {
      throw new Error("Production request graph navigation has no response");
    }
    const responseUrl = new URL(response.url());
    if (responseUrl.origin !== applicationOrigin) {
      throw new Error("Production request graph navigation changed origin");
    }
    await page.waitForLoadState("load");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
    const identity = await page.evaluate(async () => {
      const identityResponse = await fetch("/release-identity.json", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!identityResponse.ok) {
        throw new Error(`release identity HTTP ${identityResponse.status}`);
      }
      return identityResponse.json();
    });
    assertReleaseIdentity({ identity, binding });
    await page.waitForTimeout(100);
    const runtimeCssWrites = await page.evaluate(
      () => globalThis.__espProductionRequestGraphCssWrites ?? [],
    );
    await context.close();

    return {
      schemaVersion: 1,
      kind: "production-request-graph-raw/v1",
      namespace,
      sourceSha: binding.sourceSha,
      observedAt,
      releaseStateHead: { ...releaseStateHead },
      binding: { ...bindingSelection },
      applicationOrigin,
      document: {
        requestedOrigin: new URL(binding.deploymentUrl).origin,
        requestedPath: requestPath(binding.deploymentUrl),
        responseOrigin: responseUrl.origin,
        responsePath: requestPath(responseUrl.href),
        responseStatus: response.status(),
      },
      requests,
      runtimeCssWrites,
    };
  } finally {
    await browser.close();
  }
};

const assertBindingProjection = (binding, namespace, sourceSha) => {
  assertExactKeys(
    binding,
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
    "Production request graph binding",
  );
  canonicalOrigin(binding.deploymentUrl, {
    allowInsecureLocalhost: true,
  });
  if (
    binding.sourceSha !== sourceSha ||
    !["standard", "containment"].includes(binding.releaseRole) ||
    !["active-production", "prepared-production"].includes(binding.selection) ||
    !["active", "compatible-predecessor"].includes(binding.policyEligibility) ||
    typeof binding.bindingId !== "string" ||
    binding.bindingId.length === 0 ||
    typeof binding.providerProjectId !== "string" ||
    binding.providerProjectId.length === 0 ||
    typeof binding.providerDeploymentId !== "string" ||
    binding.providerDeploymentId.length === 0 ||
    !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw new Error("Production request graph binding projection is invalid");
  }
};

const assertRawRequest = (request, index) => {
  assertExactKeys(
    request,
    [
      "method",
      "navigation",
      "origin",
      "path",
      "redirectFrom",
      "resourceType",
      "responseContentType",
      "responseStatus",
      "sequence",
    ],
    `Production request graph request ${index + 1}`,
  );
  if (
    request.sequence !== index + 1 ||
    typeof request.method !== "string" ||
    request.method.length === 0 ||
    typeof request.resourceType !== "string" ||
    request.resourceType.length === 0 ||
    typeof request.navigation !== "boolean" ||
    typeof request.origin !== "string" ||
    typeof request.path !== "string" ||
    request.path.length === 0 ||
    !(
      request.responseStatus === null ||
      (Number.isSafeInteger(request.responseStatus) &&
        request.responseStatus >= 100 &&
        request.responseStatus <= 599)
    ) ||
    !(
      request.responseContentType === null ||
      typeof request.responseContentType === "string"
    )
  ) {
    throw new Error(`Production request graph request ${index + 1} is invalid`);
  }
  canonicalOrigin(request.origin, { allowInsecureLocalhost: true });
  if (request.redirectFrom !== null) {
    assertExactKeys(
      request.redirectFrom,
      ["origin", "path"],
      `Production request graph redirect ${index + 1}`,
    );
    canonicalOrigin(request.redirectFrom.origin, {
      allowInsecureLocalhost: true,
    });
    if (
      typeof request.redirectFrom.path !== "string" ||
      request.redirectFrom.path.length === 0
    ) {
      throw new Error(
        `Production request graph redirect ${index + 1} is invalid`,
      );
    }
  }
};

export const assertProductionRequestGraphRaw = (raw) => {
  assertExactKeys(
    raw,
    [
      "applicationOrigin",
      "binding",
      "document",
      "kind",
      "namespace",
      "observedAt",
      "releaseStateHead",
      "requests",
      "runtimeCssWrites",
      "schemaVersion",
      "sourceSha",
    ],
    "Production request graph raw evidence",
  );
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== "production-request-graph-raw/v1" ||
    !NAMESPACE_PATTERN.test(raw.namespace ?? "") ||
    !SOURCE_SHA_PATTERN.test(raw.sourceSha ?? "") ||
    !Array.isArray(raw.requests) ||
    raw.requests.length < 1 ||
    raw.requests.length > MAXIMUM_REQUESTS ||
    !Array.isArray(raw.runtimeCssWrites) ||
    raw.runtimeCssWrites.length > MAXIMUM_RUNTIME_CSS_WRITES
  ) {
    throw new Error(
      "Production request graph raw evidence identity is invalid",
    );
  }
  assertCanonicalTimestamp(
    raw.observedAt,
    "Production request graph observedAt",
  );
  assertHead(raw.releaseStateHead);
  assertBindingProjection(raw.binding, raw.namespace, raw.sourceSha);
  const applicationOrigin = canonicalOrigin(raw.applicationOrigin, {
    allowInsecureLocalhost: true,
  });
  if (applicationOrigin !== raw.applicationOrigin) {
    throw new Error("Production request graph application origin is invalid");
  }
  assertExactKeys(
    raw.document,
    [
      "requestedOrigin",
      "requestedPath",
      "responseOrigin",
      "responsePath",
      "responseStatus",
    ],
    "Production request graph document",
  );
  if (
    raw.document.requestedOrigin !== applicationOrigin ||
    raw.document.responseOrigin !== applicationOrigin ||
    !Number.isSafeInteger(raw.document.responseStatus) ||
    raw.document.responseStatus < 200 ||
    raw.document.responseStatus >= 400 ||
    typeof raw.document.requestedPath !== "string" ||
    !raw.document.requestedPath.startsWith("/") ||
    typeof raw.document.responsePath !== "string" ||
    !raw.document.responsePath.startsWith("/")
  ) {
    throw new Error("Production request graph document binding is invalid");
  }
  raw.requests.forEach(assertRawRequest);
  raw.runtimeCssWrites.forEach((write, index) => {
    assertExactKeys(
      write,
      ["operation", "sequence", "target"],
      `Production request graph runtime CSS write ${index + 1}`,
    );
    if (
      write.sequence !== index + 1 ||
      typeof write.operation !== "string" ||
      write.operation.length === 0 ||
      typeof write.target !== "string" ||
      write.target.length === 0
    ) {
      throw new Error(
        `Production request graph runtime CSS write ${index + 1} is invalid`,
      );
    }
  });
  return raw;
};

const isTailwindCdn = (request) => {
  const hostname = new URL(request.origin).hostname.toLowerCase();
  return (
    hostname === "cdn.tailwindcss.com" || hostname.endsWith(".tailwindcss.com")
  );
};

const isRemoteFont = (request, applicationOrigin) => {
  if (request.origin === applicationOrigin) return false;
  const hostname = new URL(request.origin).hostname.toLowerCase();
  return (
    request.resourceType === "font" ||
    hostname === "fonts.googleapis.com" ||
    hostname === "fonts.gstatic.com"
  );
};

export const summarizeProductionRequestGraph = (raw) => {
  assertProductionRequestGraphRaw(raw);
  const unexpectedOrigins = [
    ...new Set(
      raw.requests
        .map(({ origin }) => origin)
        .filter((origin) => origin !== raw.applicationOrigin),
    ),
  ].sort(compareUtf8);
  const result = {
    deploymentId: raw.binding.providerDeploymentId,
    graphSha256: sha256Bytes(canonicalJsonBytes(raw)),
    totalRequestCount: raw.requests.length,
    sameOriginRequestCount: raw.requests.filter(
      ({ origin }) => origin === raw.applicationOrigin,
    ).length,
    tailwindCdnRequestCount: raw.requests.filter(isTailwindCdn).length,
    remoteFontRequestCount: raw.requests.filter((request) =>
      isRemoteFont(request, raw.applicationOrigin),
    ).length,
    runtimeCssWriteCount: raw.runtimeCssWrites.length,
    unexpectedOrigins,
    outcome: "succeeded",
  };
  if (
    result.totalRequestCount < 1 ||
    result.sameOriginRequestCount < 1 ||
    result.tailwindCdnRequestCount !== 0 ||
    result.remoteFontRequestCount !== 0 ||
    result.runtimeCssWriteCount !== 0 ||
    result.unexpectedOrigins.length !== 0
  ) {
    throw new Error(
      "Production request graph contains forbidden runtime edges",
    );
  }
  return result;
};

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

export const readStoredProductionRequestGraph = async ({
  store,
  namespace,
  reference,
}) => {
  if (store?.namespace !== namespace) {
    throw new Error("Production request graph store namespace differs");
  }
  assertImmutableObjectReference(
    reference,
    namespace,
    "Production request graph raw reference",
  );
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length < 1 ||
    stored.bytes.length > MAXIMUM_RAW_GRAPH_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== PRODUCTION_REQUEST_GRAPH_RAW_MEDIA_TYPE ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error(
      "Stored production request graph differs from its reference",
    );
  }
  assertCanonicalTimestamp(
    stored.committedAt,
    "Production request graph immutable commit",
  );
  const value = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Stored production request graph",
  );
  if (!canonicalJsonBytes(value).equals(stored.bytes)) {
    throw new Error("Stored production request graph is not canonical");
  }
  assertProductionRequestGraphRaw(value);
  return Object.freeze({
    bytes: Buffer.from(stored.bytes),
    committedAt: stored.committedAt,
    raw: value,
    result: summarizeProductionRequestGraph(value),
  });
};

export const putProductionRequestGraph = async ({ store, raw }) => {
  assertProductionRequestGraphRaw(raw);
  if (store?.namespace !== raw.namespace) {
    throw new Error("Production request graph store namespace differs");
  }
  summarizeProductionRequestGraph(raw);
  const bytes = canonicalJsonBytes(raw);
  if (bytes.length > MAXIMUM_RAW_GRAPH_BYTES) {
    throw new Error("Production request graph is oversized");
  }
  const reference = immutableReference(raw.namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: PRODUCTION_REQUEST_GRAPH_RAW_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== PRODUCTION_REQUEST_GRAPH_RAW_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string"
  ) {
    throw new Error("Production request graph immutable receipt differs");
  }
  const readback = await readStoredProductionRequestGraph({
    store,
    namespace: raw.namespace,
    reference,
  });
  if (
    !readback.bytes.equals(bytes) ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error("Production request graph immutable readback differs");
  }
  return Object.freeze({ reference, readback });
};

export const readStoredProductionRequestGraphOidcAuthority = async ({
  store,
  namespace,
  reference,
  approvalPolicy,
  sourceSha,
  runId,
  runAttempt,
  assertStoredReceipt = assertStoredGitHubOidcReceipt,
}) => {
  if (store?.namespace !== namespace) {
    throw new Error("Production request graph OIDC store namespace differs");
  }
  assertImmutableObjectReference(
    reference,
    namespace,
    "Production request graph OIDC reference",
  );
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== GITHUB_OIDC_RECEIPT_MEDIA_TYPE ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error("Stored production request graph OIDC receipt differs");
  }
  assertCanonicalTimestamp(
    stored.committedAt,
    "Production request graph OIDC immutable commit",
  );
  const receipt = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Stored production request graph OIDC receipt",
  );
  if (!canonicalJsonBytes(receipt).equals(stored.bytes)) {
    throw new Error("Stored production request graph OIDC is not canonical");
  }
  assertStoredReceipt({
    receipt,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
  });
  return Object.freeze({
    bytes: Buffer.from(stored.bytes),
    committedAt: stored.committedAt,
    receipt,
  });
};

export const collectAndStoreProductionRequestGraphOidcAuthority = async (
  {
    store,
    namespace,
    sourceSha,
    runId,
    runAttempt,
    approvalPolicy,
    environment,
    nowMilliseconds = Date.now(),
    fetchImpl = globalThis.fetch,
  },
  {
    requestToken = requestGitHubOidcToken,
    verifyToken = verifyGitHubOidcTokenFromIssuer,
    assertVerified = assertVerifiedGitHubOidcResult,
    assertStoredReceipt = assertStoredGitHubOidcReceipt,
  } = {},
) => {
  if (store?.namespace !== namespace) {
    throw new Error("Production request graph OIDC store namespace differs");
  }
  const token = await requestToken({
    requestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: approvalPolicy.oidcAudience,
    fetchImpl,
  });
  const verified = await verifyToken({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    nowMs: nowMilliseconds,
    fetchImpl,
  });
  assertVerified(verified);
  if (
    !Buffer.isBuffer(verified?.receiptBytes) ||
    !canonicalJsonBytes(verified.receipt).equals(verified.receiptBytes)
  ) {
    throw new Error("Production request graph OIDC verification is invalid");
  }
  assertStoredReceipt({
    receipt: verified.receipt,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
  });
  const reference = immutableReference(namespace, verified.receiptBytes);
  const putReceipt = await store.putEvidence({
    bytes: verified.receiptBytes,
    mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  });
  if (
    putReceipt?.uri !== reference.uri ||
    putReceipt.sha256 !== reference.sha256 ||
    putReceipt.mediaType !== GITHUB_OIDC_RECEIPT_MEDIA_TYPE ||
    putReceipt.byteLength !== verified.receiptBytes.length ||
    typeof putReceipt.committedAt !== "string"
  ) {
    throw new Error("Production request graph OIDC immutable receipt differs");
  }
  const readback = await readStoredProductionRequestGraphOidcAuthority({
    store,
    namespace,
    reference,
    approvalPolicy,
    sourceSha,
    runId,
    runAttempt,
    assertStoredReceipt,
  });
  if (
    !readback.bytes.equals(verified.receiptBytes) ||
    readback.committedAt !== putReceipt.committedAt
  ) {
    throw new Error("Production request graph OIDC immutable readback differs");
  }
  return Object.freeze({ reference, readback });
};

export const assertProductionRequestGraphObservation = (observation) => {
  assertExactKeys(
    observation,
    [
      "binding",
      "collectorIdentity",
      "kind",
      "namespace",
      "observedAt",
      "oidcReceipt",
      "rawGraph",
      "releaseStateHead",
      "result",
      "schemaVersion",
      "sourceSha",
    ],
    "Production request graph observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.kind !== "production-request-graph-observation/v1" ||
    !NAMESPACE_PATTERN.test(observation.namespace ?? "") ||
    !SOURCE_SHA_PATTERN.test(observation.sourceSha ?? "")
  ) {
    throw new Error("Production request graph observation identity is invalid");
  }
  assertCanonicalTimestamp(
    observation.observedAt,
    "Production request graph observation time",
  );
  assertBrowserPhaseExitCollectorIdentity(
    observation.collectorIdentity,
    observation.sourceSha,
  );
  assertHead(observation.releaseStateHead);
  assertBindingProjection(
    observation.binding,
    observation.namespace,
    observation.sourceSha,
  );
  assertImmutableObjectReference(
    observation.oidcReceipt,
    observation.namespace,
    "Production request graph observation OIDC receipt",
  );
  assertImmutableObjectReference(
    observation.rawGraph,
    observation.namespace,
    "Production request graph observation raw graph",
  );
  assertExactKeys(
    observation.result,
    [
      "deploymentId",
      "graphSha256",
      "outcome",
      "remoteFontRequestCount",
      "runtimeCssWriteCount",
      "sameOriginRequestCount",
      "tailwindCdnRequestCount",
      "totalRequestCount",
      "unexpectedOrigins",
    ],
    "Production request graph observation result",
  );
  if (
    observation.result.graphSha256 !== observation.rawGraph.sha256 ||
    observation.result.deploymentId !==
      observation.binding.providerDeploymentId ||
    observation.result.outcome !== "succeeded"
  ) {
    throw new Error("Production request graph observation result differs");
  }
  for (const key of [
    "totalRequestCount",
    "sameOriginRequestCount",
    "tailwindCdnRequestCount",
    "remoteFontRequestCount",
    "runtimeCssWriteCount",
  ]) {
    if (
      !Number.isSafeInteger(observation.result[key]) ||
      observation.result[key] < 0
    ) {
      throw new Error(`Production request graph observation ${key} is invalid`);
    }
  }
  if (
    observation.result.totalRequestCount < 1 ||
    observation.result.sameOriginRequestCount < 1 ||
    observation.result.sameOriginRequestCount >
      observation.result.totalRequestCount ||
    observation.result.tailwindCdnRequestCount !== 0 ||
    observation.result.remoteFontRequestCount !== 0 ||
    observation.result.runtimeCssWriteCount !== 0 ||
    !Array.isArray(observation.result.unexpectedOrigins) ||
    observation.result.unexpectedOrigins.length !== 0
  ) {
    throw new Error("Production request graph observation did not pass policy");
  }
  return observation;
};

export const collectAndStoreProductionRequestGraph = async (
  {
    current,
    store,
    namespace,
    sourceSha,
    oidcReceipt,
    oidcAuthority,
    observe = observeProductionRequestGraph,
    now = () => Date.now(),
  },
  { readOidcAuthority = readStoredProductionRequestGraphOidcAuthority } = {},
) => {
  if (store?.namespace !== namespace) {
    throw new Error("Production request graph store namespace differs");
  }
  assertImmutableObjectReference(
    oidcReceipt,
    namespace,
    "Production request graph collector OIDC receipt",
  );
  const collectorIdentity = deriveBrowserPhaseExitCollectorIdentity({
    sourceSha,
    oidcAuthority,
  });
  await readOidcAuthority({
    store,
    namespace,
    reference: oidcReceipt,
    approvalPolicy: oidcAuthority.approvalPolicy,
    sourceSha,
    runId: collectorIdentity.runId,
    runAttempt: collectorIdentity.runAttempt,
  });
  const selected = resolveProductionRequestGraphBinding({
    current,
    namespace,
    sourceSha,
    nowMilliseconds: Number(now()),
  });
  const raw = await observe({
    binding: selected.binding,
    namespace,
    releaseStateHead: current.head,
    bindingSelection: selected.projection,
    now,
  });
  if (
    raw.namespace !== namespace ||
    raw.sourceSha !== sourceSha ||
    !sameCanonicalValue(raw.releaseStateHead, current.head) ||
    !sameCanonicalValue(raw.binding, selected.projection)
  ) {
    throw new Error(
      "Production request graph observation changed its authority",
    );
  }
  const stored = await putProductionRequestGraph({ store, raw });
  const observation = {
    schemaVersion: 1,
    kind: "production-request-graph-observation/v1",
    namespace,
    sourceSha,
    collectorIdentity,
    observedAt: raw.observedAt,
    releaseStateHead: { ...current.head },
    binding: { ...selected.projection },
    oidcReceipt: { ...oidcReceipt },
    rawGraph: { ...stored.reference },
    result: { ...stored.readback.result },
  };
  assertProductionRequestGraphObservation(observation);
  return Object.freeze(observation);
};

const assertDefaultProtectedWorkflowEnvironment = async (options) => {
  const { assertProtectedWorkflowEnvironment } =
    await import("../release-state/protected-release.mjs");
  return assertProtectedWorkflowEnvironment(options);
};

export const assertProductionRequestGraphProtectedWorkflow = async (
  { environment, approvalPolicy, namespace, sourceSha },
  {
    assertWorkflowEnvironment = assertDefaultProtectedWorkflowEnvironment,
  } = {},
) => {
  const runId = environment?.GITHUB_RUN_ID;
  await assertWorkflowEnvironment({
    env: environment,
    approvalPolicy,
    namespace,
    sourceSha,
    runId,
  });
  for (const name of [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]) {
    const value = environment?.[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Production request graph OIDC environment is absent: ${name}`,
      );
    }
  }
  let oidcUrl;
  try {
    oidcUrl = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    throw new Error("Production request graph OIDC request URL is invalid");
  }
  if (oidcUrl.protocol !== "https:") {
    throw new Error("Production request graph OIDC request URL is not HTTPS");
  }
  return Object.freeze({
    runId,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  });
};
