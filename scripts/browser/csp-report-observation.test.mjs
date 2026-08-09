import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Bytes } from "../lib/canonical-json.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import {
  CSP_REPORT_OBSERVATION_RAW_MEDIA_TYPE,
  assertCspReportObservation,
  assertCspReportObservationRaw,
  classifyCspReportViolation,
  collectAndStoreCspReportObservation,
  observeCspReportBrowser,
  putCspReportObservation,
  queryCspReportAggregates,
  readStoredCspReportObservation,
  summarizeCspReportObservation,
} from "./csp-report-observation.mjs";
import {
  parseCspReportObservationArguments,
  writeCspReportObservationOutput,
} from "./collect-csp-report-observation.mjs";
import { deriveCspReportWafAuthority } from "./csp-report-phase-authority.mjs";

const namespace = "csp-report-test";
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const otherSourceSha = "89abcdef0123456789abcdef0123456789abcdef";
const repository = "owner/repository";
const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
  sha256: character.repeat(64),
});
const oidcReceipt = reference("8");
const activePolicy = reference("a");
const providerPolicyReference = reference("6");
const dbCompatibility = {
  contractUri: "urn:event-shopping-planner:db-compatibility:v1",
  fingerprint: "b".repeat(64),
};
const cspPolicy = {
  reportEndpoint: "/api/csp-report",
  directives: {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "report-uri": ["/api/csp-report"],
  },
};
const header = Object.entries(cspPolicy.directives)
  .map(([name, values]) => `${name} ${values.join(" ")}`)
  .join("; ");
const emptyBodySha256 = sha256Bytes(Buffer.alloc(0));
const apiNotFoundBytes = Buffer.from('{"error":"api-not-found"}', "utf8");
const cspReportWafRule = {
  id: "csp-report-rate-limit",
  active: true,
  action: "rate_limit",
  conditionGroup: [
    {
      conditions: [
        { type: "path", op: "eq", value: "/api/csp-report" },
        { type: "method", op: "eq", value: "POST" },
      ],
    },
  ],
  rateLimit: { algo: "fixed_window", limit: 2, window: 10, keys: ["ip"] },
};
const providerPolicyFixture = {
  wafRules: { cspReportRoute: cspReportWafRule },
};
const providerObservationFixture = {
  provider: "vercel",
  providerProjectId: "project-test",
  ownedProductionDomains: ["app.example.test"],
  wafRules: { cspReportRoute: cspReportWafRule },
};
const providerHash = providerConfigurationHash(providerObservationFixture);
const wafAuthority = deriveCspReportWafAuthority({
  providerObservation: providerObservationFixture,
  providerPolicy: providerPolicyFixture,
});

const binding = ({
  source = sourceSha,
  deploymentUrl = "https://app.example.test/",
} = {}) => ({
  bindingId: "deployment-binding:standard:report-only",
  sourceSha: source,
  buildId: source,
  variantId: "c".repeat(64),
  releaseRole: "standard",
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: "deployment-report-only",
  deploymentUrl,
  artifactArchive: reference("1"),
  artifactArchiveAvailability: reference("2"),
  packageIndex: reference("3"),
  artifactManifest: reference("4"),
  providerEvidence: reference("5"),
  releasePolicy: activePolicy,
  providerPolicy: providerPolicyReference,
  providerConfigurationHash: providerHash,
  requiredDbCompatibility: dbCompatibility,
});

const state = (active = binding()) => ({
  head: { sequence: 3, eventHash: "e".repeat(64) },
  records: [],
  snapshot: {
    activeProduction: active,
    pendingOperation: null,
    activeReleasePolicy: activePolicy,
    activePolicyCompatibility: [],
    currentDbCompatibility: dbCompatibility,
    minimumSafetyFloors: {},
  },
});

const probeReceipt = ({ method, ordinal, status }) => ({
  ordinal,
  method,
  status,
  allow: method === "GET" ? "POST" : null,
  cacheControl: "no-store",
  contentType: null,
  bodyByteLength: 0,
  bodySha256: emptyBodySha256,
});

const routeProbes = () => ({
  methodDenial: probeReceipt({ method: "GET", ordinal: 1, status: 405 }),
  validPost: probeReceipt({ method: "POST", ordinal: 1, status: 204 }),
  rateBurst: {
    configuredLimit: wafAuthority.limit,
    receipts: [
      probeReceipt({ method: "POST", ordinal: 1, status: 204 }),
      probeReceipt({ method: "POST", ordinal: 2, status: 429 }),
      probeReceipt({ method: "POST", ordinal: 3, status: 429 }),
    ],
  },
});

const browserFixture = (overrides = {}) => ({
  headerName: "Content-Security-Policy-Report-Only",
  headerValue: header,
  reportEndpoint: "/api/csp-report",
  reportRouteStatus: 204,
  routeProbes: routeProbes(),
  releaseIdentity: {
    sourceSha,
    buildId: sourceSha,
    releaseRole: "standard",
    variantId: "c".repeat(64),
  },
  scenarios: [
    { id: "blob-url", outcome: "succeeded" },
    { id: "normal", outcome: "succeeded" },
    { id: "same-origin-api", outcome: "succeeded" },
  ],
  violations: [],
  ...overrides,
});

const bindingPhaseProjection = (selected, cspMode) => ({
  bindingId: selected.bindingId,
  sourceSha: selected.sourceSha,
  releaseRole: selected.releaseRole,
  providerDeploymentId: selected.providerDeploymentId,
  providerConfigurationHash: selected.providerConfigurationHash,
  artifactManifest: selected.artifactManifest,
  cspMode,
});

const phaseStateFixture = (selected = binding()) => ({
  releaseStateHead: { sequence: 3, eventHash: "e".repeat(64) },
  acceptedGate: "P2B-REPORT",
  pendingOperation: null,
  pendingAcceptance: null,
  acceptedStandard: bindingPhaseProjection(selected, "report-only"),
  containmentCompanion: {
    ...bindingPhaseProjection(
      {
        ...selected,
        bindingId: "deployment-binding:containment:report-only",
        releaseRole: "containment",
        providerDeploymentId: "deployment-report-only-companion",
        artifactManifest: reference("d"),
      },
      "report-only",
    ),
  },
  preP2B: {
    acceptedGate: "P2A-LOCAL",
    acceptedEvent: {
      sequence: 1,
      uri: `release-state://${namespace}/events/1/${"1".repeat(64)}`,
      sha256: "1".repeat(64),
    },
    assignmentValidatedEvent: {
      sequence: 2,
      uri: `release-state://${namespace}/events/2/${"2".repeat(64)}`,
      sha256: "2".repeat(64),
    },
    productionProbe: reference("f"),
    acceptedStandard: {
      ...bindingPhaseProjection(selected, "none"),
      bindingId: "deployment-binding:standard:none",
      providerDeploymentId: "deployment-none",
      artifactManifest: reference("b"),
    },
    containmentCompanion: {
      ...bindingPhaseProjection(selected, "none"),
      bindingId: "deployment-binding:containment:none",
      releaseRole: "containment",
      providerDeploymentId: "deployment-none-companion",
      artifactManifest: reference("c"),
    },
    reportRoute: {
      method: "GET",
      path: "/api/csp-report",
      status: 404,
      bodySha256: sha256Bytes(apiNotFoundBytes),
      bodyByteLength: apiNotFoundBytes.length,
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      allow: null,
      productionReceiptSetSha256: "3".repeat(64),
    },
  },
});

const memoryStore = ({ storeNamespace = namespace } = {}) => {
  const objects = new Map();
  return {
    namespace: storeNamespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = "2026-08-09T00:00:02.000Z";
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        mediaType,
        committedAt,
      });
      return {
        uri: `release-state://${storeNamespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
  };
};

const startFixture = async ({
  responseHeader = header,
  reportStatus = 204,
} = {}) => {
  let reportPostCount = 0;
  const identity = JSON.stringify({
    sourceSha,
    buildId: sourceSha,
    releaseRole: "standard",
    variantId: "c".repeat(64),
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/csp-report" && request.method === "GET") {
      response.writeHead(405, {
        allow: "POST",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (url.pathname === "/api/csp-report" && request.method === "POST") {
      request.resume();
      reportPostCount += 1;
      const status =
        reportStatus === 204 && reportPostCount > wafAuthority.limit
          ? 429
          : reportStatus;
      response.writeHead(status, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/release-identity.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(identity);
      return;
    }
    if (url.pathname === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end('document.querySelector("#root").textContent="ready";');
      return;
    }
    response.writeHead(200, {
      "content-security-policy-report-only": responseHeader,
      "content-type": "text/html",
    });
    response.end(
      '<div id="loading-screen" hidden></div><div id="root"></div><script src="/app.js"></script>',
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const aggregate = (overrides = {}) => ({
  effectiveDirective: "img-src",
  disposition: "report",
  blockedTarget: "scheme",
  violationCount: 2,
  firstReceivedAt: "2026-08-09T00:00:00.500Z",
  lastReceivedAt: "2026-08-09T00:00:00.500Z",
  ...overrides,
});

const projection = (selected) => ({
  bindingId: selected.bindingId,
  sourceSha: selected.sourceSha,
  releaseRole: selected.releaseRole,
  providerProjectId: selected.providerProjectId,
  providerDeploymentId: selected.providerDeploymentId,
  deploymentUrl: selected.deploymentUrl,
  selection: "active-production",
  policyEligibility: "active",
});

const rawFixture = (browser, selected = binding()) => ({
  schemaVersion: 1,
  kind: "csp-report-observation-raw/v1",
  namespace,
  sourceSha,
  observedAt: "2026-08-09T00:00:01.000Z",
  releaseStateHead: { sequence: 3, eventHash: "e".repeat(64) },
  binding: projection(selected),
  phaseState: phaseStateFixture(selected),
  provider: {
    observation: reference("7"),
    policy: providerPolicyReference,
    configurationHash: selected.providerConfigurationHash,
    waf: wafAuthority,
  },
  window: {
    fromInclusive: "2026-08-09T00:00:00.000Z",
    toExclusive: "2026-08-09T00:00:01.000Z",
  },
  browser,
  database: {
    sourceSha,
    providerDeploymentId: selected.providerDeploymentId,
    fingerprint: dbCompatibility.fingerprint,
    aggregates: [aggregate()],
  },
});

test("observes report-only header, scenarios, identity, and sink status", async () => {
  const fixture = await startFixture();
  try {
    const browser = await observeCspReportBrowser({
      binding: binding({ deploymentUrl: fixture.url }),
      cspPolicy,
      waf: wafAuthority,
    });
    assert.equal(browser.headerName, "Content-Security-Policy-Report-Only");
    assert.equal(browser.reportRouteStatus, 204);
    assert.equal(browser.scenarios.length, 3);
    assert.deepEqual(browser.violations, []);
  } finally {
    await fixture.close();
  }
});

test("rejects header drift and missing report route", async () => {
  for (const options of [
    {
      responseHeader: `${header}; object-src 'none'`,
      pattern: /header differs/,
    },
    { reportStatus: 404, pattern: /browser trace differs/ },
  ]) {
    const fixture = await startFixture(options);
    try {
      if (options.reportStatus === 404) {
        const browser = await observeCspReportBrowser({
          binding: binding({ deploymentUrl: fixture.url }),
          cspPolicy,
          waf: wafAuthority,
        });
        assert.throws(
          () => assertCspReportObservationRaw(rawFixture(browser), cspPolicy),
          options.pattern,
        );
      } else {
        await assert.rejects(
          observeCspReportBrowser({
            binding: binding({ deploymentUrl: fixture.url }),
            cspPolicy,
            waf: wafAuthority,
          }),
          options.pattern,
        );
      }
    } finally {
      await fixture.close();
    }
  }
});

test("queries an exclusive source/deployment DB window read-only", async () => {
  const calls = [];
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === "string") return { rows: [] };
      if (query.name === "csp-report-observer-identity-v1") {
        return { rows: [{ observer_role: "operator", read_only: "on" }] };
      }
      return {
        rows: [
          {
            effective_directive: "img-src",
            disposition: "report",
            blocked_target: "scheme",
            violation_count: "2",
            first_received_at: new Date("2026-08-09T00:00:00.500Z"),
            last_received_at: new Date("2026-08-09T00:00:00.500Z"),
          },
        ],
      };
    },
  };
  const rows = await queryCspReportAggregates({
    client,
    windowFrom: "2026-08-09T00:00:00.000Z",
    windowTo: "2026-08-09T00:00:01.000Z",
    sourceSha,
    providerDeploymentId: "deployment-report-only",
    expectedObserverRole: "operator",
  });
  assert.deepEqual(rows, [aggregate()]);
  assert.deepEqual(calls[2].values.slice(0, 4), [
    "2026-08-09T00:00:00.000Z",
    "2026-08-09T00:00:01.000Z",
    sourceSha,
    "deployment-report-only",
  ]);
  assert.equal(
    calls[0],
    "begin transaction isolation level repeatable read read only",
  );
  assert.equal(calls.at(-1), "commit");
});

test("classifies extension noise and rejects first-party/misclassified noise", () => {
  assert.equal(
    classifyCspReportViolation(
      { blockedUri: "chrome-extension://abc/script.js", sourceFile: "" },
      "https://app.example.test",
    ),
    "known-extension-noise",
  );
  assert.equal(
    classifyCspReportViolation(
      { blockedUri: "https://app.example.test/app.js", sourceFile: "" },
      "https://app.example.test",
    ),
    "first-party",
  );
  const browser = browserFixture();
  const firstParty = rawFixture(browser);
  firstParty.browser.violations.push({
    blockedUri: "https://app.example.test/app.js",
    classification: "first-party",
    disposition: "report",
    documentUri: "https://app.example.test/",
    effectiveDirective: "script-src-elem",
    sourceFile: "https://app.example.test/app.js",
  });
  assert.throws(
    () => summarizeCspReportObservation(firstParty, cspPolicy),
    /first-party violations/,
  );
  const misclassified = structuredClone(firstParty);
  misclassified.browser.violations[0].classification = "known-extension-noise";
  assert.throws(
    () => assertCspReportObservationRaw(misclassified, cspPolicy),
    /classification is invalid/,
  );
});

test("rejects DB fingerprint/window drift, missing scenarios, and extra keys", () => {
  const browser = browserFixture();
  const wrongFingerprint = rawFixture(browser);
  wrongFingerprint.database.fingerprint = "bad";
  assert.throws(
    () => assertCspReportObservationRaw(wrongFingerprint, cspPolicy),
    /DB binding differs/,
  );
  const overlapping = rawFixture(browser);
  overlapping.database.aggregates[0].lastReceivedAt =
    overlapping.window.toExclusive;
  assert.throws(
    () => assertCspReportObservationRaw(overlapping, cspPolicy),
    /exclusive window/,
  );
  const missing = rawFixture(browser);
  missing.browser.scenarios.pop();
  assert.throws(
    () => assertCspReportObservationRaw(missing, cspPolicy),
    /browser trace differs/,
  );
  assert.throws(
    () =>
      assertCspReportObservationRaw(
        { ...rawFixture(browser), callerCount: 1 },
        cspPolicy,
      ),
    /unknown or missing fields/,
  );
});

test("immutably stores and rejects tamper/media/store mismatch", async () => {
  const browser = browserFixture();
  const store = memoryStore();
  const stored = await putCspReportObservation({
    store,
    raw: rawFixture(browser),
    cspPolicy,
  });
  assert.equal(stored.readback.result.storedSanitizedReportCount, 2);
  store.objects.get(stored.reference.sha256).bytes = Buffer.from("{}", "utf8");
  await assert.rejects(
    readStoredCspReportObservation({
      store,
      namespace,
      reference: stored.reference,
      cspPolicy,
    }),
    /differs/,
  );
  store.objects.get(stored.reference.sha256).bytes = stored.readback.bytes;
  store.objects.get(stored.reference.sha256).mediaType = "application/json";
  await assert.rejects(
    readStoredCspReportObservation({
      store,
      namespace,
      reference: stored.reference,
      cspPolicy,
    }),
    /differs/,
  );
  await assert.rejects(
    putCspReportObservation({
      store: memoryStore({ storeNamespace: "other-store" }),
      raw: rawFixture(browser),
      cspPolicy,
    }),
    /namespace or size differs/,
  );
});

test("collector rejects old source and untrusted OIDC; CLI rejects caller claims", async () => {
  const base = {
    current: state(binding({ source: otherSourceSha })),
    store: memoryStore(),
    namespace,
    sourceSha,
    oidcReceipt,
    oidcAuthority: {
      approvalPolicy: { repository },
      runId: "123",
      runAttempt: "1",
    },
    cspPolicy,
    dbClient: {},
    expectedObserverRole: "operator",
    now: (() => {
      const values = [0, 0, 1000];
      return () => values.shift();
    })(),
  };
  await assert.rejects(
    collectAndStoreCspReportObservation(base, {
      readOidcAuthority: async () => ({}),
    }),
    /No exact current or prepared production binding/,
  );
  await assert.rejects(
    collectAndStoreCspReportObservation(
      { ...base, current: state() },
      {
        readOidcAuthority: async () => {
          throw new Error("untrusted OIDC");
        },
      },
    ),
    /untrusted OIDC/,
  );
  for (const flag of ["--url", "--count", "--fingerprint", "--outcome"]) {
    assert.throws(
      () =>
        parseCspReportObservationArguments([
          "--namespace",
          namespace,
          "--source-sha",
          sourceSha,
          flag,
          "caller",
        ]),
      /invalid/,
    );
  }
});

test("collector derives its result only from trusted browser and DB observations", async () => {
  const browser = browserFixture();
  const clockValues = [
    Date.parse("2026-08-09T00:00:00.000Z"),
    Date.parse("2026-08-09T00:00:00.000Z"),
    Date.parse("2026-08-09T00:00:00.000Z"),
    Date.parse("2026-08-09T00:00:01.000Z"),
  ];
  let oidcReads = 0;
  const observation = await collectAndStoreCspReportObservation(
    {
      current: state(),
      store: memoryStore(),
      namespace,
      sourceSha,
      oidcReceipt,
      oidcAuthority: {
        approvalPolicy: { repository },
        runId: "123",
        runAttempt: "1",
      },
      cspPolicy,
      providerPolicy: providerPolicyFixture,
      providerToken: "provider-token-1234567890",
      dbClient: {},
      expectedObserverRole: "operator",
      observeBrowser: async () => browser,
      queryAggregates: async (options) => {
        assert.equal(options.sourceSha, sourceSha);
        assert.equal(options.providerDeploymentId, "deployment-report-only");
        return [aggregate()];
      },
      now: () => clockValues.shift(),
    },
    {
      readOidcAuthority: async () => {
        oidcReads += 1;
        return {};
      },
      assertProviderPolicy: () => {},
      collectProviderObservation: async () => providerObservationFixture,
      storeProviderObservation: async () => ({
        reference: reference("7"),
        policyReference: providerPolicyReference,
      }),
      resolvePhaseState: async () => phaseStateFixture(),
      readState: async () => state(),
    },
  );
  assert.equal(oidcReads, 1);
  assert.equal(observation.collectorIdentity.runId, "123");
  assert.equal(observation.collectorIdentity.runAttempt, "1");
  assert.throws(
    () =>
      assertCspReportObservation({
        ...observation,
        collectorIdentity: {
          ...observation.collectorIdentity,
          sourceSha: otherSourceSha,
        },
      }),
    /collector identity is invalid/,
  );
  assert.equal(observation.result.canonicalScenarioCount, 3);
  assert.equal(observation.result.storedSanitizedReportCount, 2);
  assert.equal(
    observation.result.databaseFingerprint,
    dbCompatibility.fingerprint,
  );
  assert.equal(observation.rawObservation.sha256, observation.result.rawSha256);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "csp-report-"));
  try {
    const outputPath = path.join(temporaryRoot, "observation.json");
    const written = await writeCspReportObservationOutput(
      outputPath,
      observation,
    );
    assert.deepEqual(await readFile(outputPath), written.bytes);
    await assert.rejects(
      writeCspReportObservationOutput(outputPath, observation),
      /already exists/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("raw media type is dedicated to CSP report observations", () => {
  assert.match(
    CSP_REPORT_OBSERVATION_RAW_MEDIA_TYPE,
    /csp-report-observation-raw/,
  );
});
