import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { createReleaseEvent } from "../release-state/releaseStateReducer.mjs";
import { compareUtf8 } from "../release-state/releaseWorkflowValidation.mjs";
import {
  prepareProductionAssignmentAuthority,
  productionAssignmentApiRouteExpectations,
  produceProductionAssignmentValidation,
  validateProductionAssignmentAuthority,
} from "./productionAssignmentValidation.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";

const NAMESPACE = "production-assignment-test";
const SOURCE_SHA = "1".repeat(40);
const VARIANT_ID = "2".repeat(64);
const PROJECT_ID = "project-test";
const TEAM_ID = "team-test";
const TARGET_ID = "deployment-target";
const PREVIOUS_ID = "deployment-previous";
const DOMAIN = "app.example.test";
const DEPLOYMENT_URL = "https://deployment-target.vercel.app";
const FIXED_NOW = Date.parse("2026-08-06T00:00:20.000Z");
const FIXED_HTTP_DATE = "Thu, 06 Aug 2026 00:00:20 GMT";
const RECEIPT_DATE = "2026-08-06T00:00:09.000Z";
const COMPLETED_AT = "2026-08-06T00:00:10.000Z";
const TOOLCHAIN_POLICY = {
  schemaVersion: 1,
  packages: { vercel: "58.5.1" },
};
const PROVIDER_POLICY = {
  schemaVersion: 1,
  bindingStatus: "configured",
  provider: "vercel",
  expectedTeamId: TEAM_ID,
  expectedProjectId: PROJECT_ID,
  ownedProductionDomains: [DOMAIN],
  productionEnvironmentName: "production",
  providerNodeFamily: "24.x",
  productionBranch: "main",
  autoAssignCustomProductionDomains: false,
  gitProductionAutoDeploy: false,
  allowedPreviewBranches: [],
  requiredEnvironmentNames: ["VERCEL_DEPLOYMENT_ID"],
  cspReportEnvironmentNames: [],
  forbiddenEnvironmentNames: [],
  rawRequestByteCeilings: {
    persistenceReleaseAMetrics: 1024,
    cspReport: 16384,
    googleSheetsCsv: 512,
  },
  wafRules: {
    metricsRoute: { id: "metrics" },
    cspReportRoute: { id: "csp" },
    googleSheetsCsvRoute: { id: "sheets" },
  },
  logPolicy: {
    allowedFields: ["requestId"],
    retentionDays: 1,
    retentionObservation: {
      kind: "vercel-runtime-plan-v1",
      observabilityPlus: false,
      drainId: null,
      jsonPointer: "/plan",
    },
  },
  hstsOwner: "provider",
  hstsPolicy: {
    minimumMaxAgeSeconds: 31_536_000,
    requireIncludeSubDomains: true,
    requirePreload: true,
  },
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    firewallConfigVersion: "active",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
    requireEtag: true,
  },
  requiredConfigurationEvidence: [],
  blockerCodes: [],
};
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; object-src 'none'",
  "permissions-policy": "camera=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const DB_COMPATIBILITY = {
  contractUri: "release-state://production-assignment-test/evidence/db",
  fingerprint: "3".repeat(64),
};

class FakeStore {
  constructor() {
    this.namespace = NAMESPACE;
    this.evidence = new Map();
  }

  add(bytes, mediaType = "application/json") {
    const input = Buffer.from(bytes);
    const sha256 = sha256Bytes(input);
    this.evidence.set(sha256, {
      bytes: input,
      mediaType,
      committedAt: COMPLETED_AT,
    });
    return {
      uri: `release-state://${NAMESPACE}/evidence/${sha256}`,
      sha256,
    };
  }

  async putEvidence({ bytes, mediaType }) {
    const input = Buffer.from(bytes);
    const sha256 = sha256Bytes(input);
    const replayed = this.evidence.has(sha256);
    const reference = this.add(input, mediaType);
    return {
      ...reference,
      mediaType,
      byteLength: input.length,
      committedAt: COMPLETED_AT,
      replayed,
    };
  }

  async readEvidence({ sha256 }) {
    const stored = this.evidence.get(sha256);
    return stored
      ? {
          bytes: Buffer.from(stored.bytes),
          mediaType: stored.mediaType,
          committedAt: stored.committedAt,
        }
      : null;
  }

  async readHead() {
    return { sequence: 2, eventHash: "4".repeat(64) };
  }

  async readEvents() {
    return [];
  }
}

const responseReceiptHash = (bytes) => `"${sha256Bytes(bytes)}"`;

const contentTypeFor = (pathName) =>
  pathName === "/"
    ? "text/html; charset=utf-8"
    : pathName.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "text/javascript; charset=utf-8";

const immutableRouteReceipt = ({
  pathName,
  bytes,
  cacheControl = null,
  deploymentUrl = DEPLOYMENT_URL,
}) => ({
  path: pathName,
  requestUrl: `${deploymentUrl}${pathName}`,
  responseUrl: `${deploymentUrl}${pathName}`,
  status: 200,
  responseDate: "2026-08-06T00:00:00.000Z",
  etag: responseReceiptHash(bytes),
  contentType: contentTypeFor(pathName),
  cacheControl,
  securityHeaders: SECURITY_HEADERS,
  bodySha256: sha256Bytes(bytes),
  byteLength: bytes.length,
});

test("derives the CSP report assignment route from the artifact CSP mode", () => {
  const none = productionAssignmentApiRouteExpectations("none").find(
    ({ path }) => path === "/api/csp-report",
  );
  assert.equal(none.status, 404);
  assert.equal(none.body.toString("utf8"), '{"error":"api-not-found"}');
  assert.equal(none.contentType, "application/json");
  assert.equal(none.allow, null);

  for (const mode of ["report-only", "enforced"]) {
    const active = productionAssignmentApiRouteExpectations(mode).find(
      ({ path }) => path === "/api/csp-report",
    );
    assert.equal(active.status, 405);
    assert.equal(active.body.length, 0);
    assert.equal(active.allow, "POST");
  }
  assert.throws(
    () => productionAssignmentApiRouteExpectations("caller-claimed"),
    /CSP mode is invalid/,
  );
});

const providerObservation = () => ({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: RECEIPT_DATE,
  providerTeamId: TEAM_ID,
  providerProjectId: PROJECT_ID,
  ownedProductionDomains: [DOMAIN],
  providerNodeFamily: "24.x",
  evidenceReceipts: [
    {
      kind: "fixture",
      responseDate: RECEIPT_DATE,
      etag: '"provider"',
      bodySha256: "5".repeat(64),
      responseSha256: "6".repeat(64),
    },
  ],
});

const domainObservation = ({ phase, deploymentId }) => {
  const requestUrl =
    `https://api.vercel.com/v4/aliases/${DOMAIN}` +
    `?projectId=${PROJECT_ID}&teamId=${TEAM_ID}`;
  const receipt = {
    schemaVersion: 1,
    receiptKind: "vercel-domain-assignment-observation/v1",
    phase,
    productionDomain: DOMAIN,
    method: "GET",
    requestUrl,
    status: 200,
    responseDate: RECEIPT_DATE,
    etag: `"${phase}"`,
    bodySha256: "7".repeat(64),
    providerProjectId: PROJECT_ID,
    assignedDeploymentId: deploymentId,
  };
  const value = {
    schemaVersion: 1,
    observationKind: "vercel-owned-domain-assignment/v1",
    phase,
    observedAt: RECEIPT_DATE,
    providerTeamId: TEAM_ID,
    providerProjectId: PROJECT_ID,
    receipts: [
      {
        productionDomain: DOMAIN,
        receiptSha256: sha256Json(receipt),
        receipt,
      },
    ],
  };
  return { sha256: sha256Json(value), value };
};

const createFixture = ({
  stateTarget = true,
  routePath = null,
  routeBodyHash = null,
} = {}) => {
  const store = new FakeStore();
  const roleBytes = Buffer.from("globalThis.__role='standard';\n");
  const serviceWorkerBytes = Buffer.from(
    "self.addEventListener('fetch',()=>{});\n",
  );
  const htmlBytes = Buffer.from(
    "<!doctype html><html><head>" +
      `<meta name="event-shopping-planner-build-id" content="${SOURCE_SHA}">` +
      `<meta name="event-shopping-planner-source-sha" content="${SOURCE_SHA}">` +
      "</head><body>fixture</body></html>\n",
  );
  const capabilityBytes = canonicalJsonBytes({
    kind: "event-shopping-planner-release-capabilities",
    version: 1,
    buildId: SOURCE_SHA,
    sourceSha: SOURCE_SHA,
    sourceState: "clean",
    releaseChannel: "release-a",
    legacyLocalStorageCleanup: "forced-off",
  });
  const identity = {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    variantId: VARIANT_ID,
    releaseRole: "standard",
    requiredDbCompatibilityFingerprint: DB_COMPATIBILITY.fingerprint,
    pwaLifecycle: "legacy-auto-update-v1",
    appEntryUrl: "/assets/role.js",
    appEntrySha256: sha256Bytes(roleBytes),
    serviceWorkerUrl: "/sw.js",
    serviceWorkerSha256: sha256Bytes(serviceWorkerBytes),
  };
  const identityBytes = canonicalJsonBytes(identity);
  const publicBodies = new Map([
    ["/", htmlBytes],
    ["/assets/role.js", roleBytes],
    ["/release-capabilities.json", capabilityBytes],
    ["/release-identity.json", identityBytes],
    ["/sw.js", serviceWorkerBytes],
  ]);
  const immutableRoutes = [...publicBodies.entries()]
    .map(([pathName, bytes]) =>
      immutableRouteReceipt({
        pathName: pathName === "/" && routePath !== null ? routePath : pathName,
        bytes,
        cacheControl:
          pathName === "/sw.js"
            ? "public, max-age=0, must-revalidate"
            : pathName === "/release-identity.json"
              ? "private, no-store"
              : null,
      }),
    )
    .sort((left, right) => compareUtf8(left.path, right.path));
  if (routeBodyHash !== null) {
    immutableRoutes.find(({ path }) => path === "/").bodySha256 = routeBodyHash;
  }
  const deploymentReceiptReference = store.add(
    canonicalJsonBytes({ kind: "deployment-receipt" }),
  );
  const cspPolicyReference = store.add(
    canonicalJsonBytes({ kind: "csp-policy" }),
  );
  const routeProbe = {
    schemaVersion: 1,
    evidenceKind: "immutable-deployment-route-probe/v1",
    namespace: NAMESPACE,
    providerProjectId: PROJECT_ID,
    providerDeploymentId: TARGET_ID,
    deploymentUrl: DEPLOYMENT_URL,
    observedAt: "2026-08-06T00:00:00.000Z",
    deploymentReceipt: deploymentReceiptReference,
    cspPolicy: cspPolicyReference,
    runtimeHtmlIdentity: {
      buildId: SOURCE_SHA,
      sourceSha: SOURCE_SHA,
    },
    routes: immutableRoutes,
  };
  const routeProbeReference = store.add(canonicalJsonBytes(routeProbe));
  const packageIndexReference = store.add(
    canonicalJsonBytes({ kind: "package-index" }),
  );
  const artifactManifestReference = store.add(
    canonicalJsonBytes({ kind: "manifest" }),
  );
  const releasePolicyReference = store.add(
    canonicalJsonBytes({ kind: "release-policy" }),
  );
  const providerPolicyReference = store.add(
    canonicalJsonBytes(PROVIDER_POLICY),
    "application/vnd.event-shopping-planner.provider-policy+json;version=1",
  );
  const configurationObservation = providerObservation();
  const configurationHash = providerConfigurationHash(configurationObservation);
  const providerEvidence = {
    schemaVersion: 1,
    providerProjectId: PROJECT_ID,
    providerDeploymentId: TARGET_ID,
    deploymentUrl: DEPLOYMENT_URL,
    sourceSha: SOURCE_SHA,
    variantId: VARIANT_ID,
    releaseRole: "standard",
    artifactManifestHash: artifactManifestReference.sha256,
    packageIndexHash: packageIndexReference.sha256,
    providerConfigurationHash: configurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility: DB_COMPATIBILITY,
    publicIdentity: {
      identityKind: "release-identity-v1",
      identity,
      identitySha256: sha256Bytes(identityBytes),
    },
    routeProbeEvidenceHash: routeProbeReference.sha256,
    environmentPresenceEvidenceHash: "8".repeat(64),
  };
  const providerEvidenceReference = store.add(
    canonicalJsonBytes(providerEvidence),
  );
  const companionProviderEvidenceReference = store.add(
    canonicalJsonBytes({
      ...providerEvidence,
      providerDeploymentId: "deployment-companion",
      deploymentUrl: "https://deployment-companion.vercel.app",
      releaseRole: "containment",
    }),
  );
  const previousProviderEvidenceReference = store.add(
    canonicalJsonBytes({
      ...providerEvidence,
      providerDeploymentId: PREVIOUS_ID,
      deploymentUrl: "https://deployment-previous.vercel.app",
    }),
  );
  const archiveBinding = (bindingId, releaseRole) => {
    const archiveBytes = Buffer.from(`archive:${bindingId}`);
    const artifactArchive = store.add(
      archiveBytes,
      "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
    );
    const artifactArchiveAvailability = store.add(
      canonicalJsonBytes({
        schemaVersion: 1,
        evidenceKind: "artifact-archive-availability/v1",
        availability: "available",
        namespace: NAMESPACE,
        bindingId,
        sourceSha: SOURCE_SHA,
        variantId: VARIANT_ID,
        releaseRole,
        artifactManifest: artifactManifestReference,
        artifactArchive: {
          ...artifactArchive,
          mediaType:
            "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
          byteLength: archiveBytes.length,
          committedAt: COMPLETED_AT,
        },
      }),
      "application/vnd.event-shopping-planner.artifact-archive-availability+json;version=1",
    );
    return { artifactArchive, artifactArchiveAvailability };
  };
  const targetBinding = {
    bindingId: "standard-target",
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    variantId: VARIANT_ID,
    releaseRole: "standard",
    publicIdentityKind: "release-identity-v1",
    providerProjectId: PROJECT_ID,
    providerDeploymentId: TARGET_ID,
    deploymentUrl: DEPLOYMENT_URL,
    ...archiveBinding("standard-target", "standard"),
    packageIndex: packageIndexReference,
    artifactManifest: artifactManifestReference,
    providerEvidence: providerEvidenceReference,
    releasePolicy: releasePolicyReference,
    providerPolicy: providerPolicyReference,
    providerConfigurationHash: configurationHash,
    requiredDbCompatibility: DB_COMPATIBILITY,
  };
  const companionBinding = {
    ...targetBinding,
    bindingId: "containment-companion",
    releaseRole: "containment",
    providerDeploymentId: "deployment-companion",
    deploymentUrl: "https://deployment-companion.vercel.app",
    providerEvidence: companionProviderEvidenceReference,
    ...archiveBinding("containment-companion", "containment"),
  };
  const previousBinding = {
    ...targetBinding,
    bindingId: "standard-previous",
    providerDeploymentId: PREVIOUS_ID,
    deploymentUrl: "https://deployment-previous.vercel.app",
    providerEvidence: previousProviderEvidenceReference,
    ...archiveBinding("standard-previous", "standard"),
  };
  const subjectReference = store.add(
    canonicalJsonBytes({ kind: "promotion-subject" }),
  );
  const issuerReference = store.add(
    canonicalJsonBytes({ kind: "approval-issuer" }),
  );
  const approvalReferences = [
    store.add(canonicalJsonBytes({ kind: "release-owner-approval" })),
    store.add(canonicalJsonBytes({ kind: "data-safety-approval" })),
  ];
  const approvals = [
    {
      ...approvalReferences[0],
      approvalId: "approval-release-owner",
      operationId: "promote-production-fixture",
      subjectSha256: subjectReference.sha256,
      trustedIssuer: "https://token.actions.githubusercontent.com",
      issuerReceiptUri: issuerReference.uri,
      issuerReceiptSha256: issuerReference.sha256,
      workflowRunId: "100",
      protectedEnvironment: "foundation-release-state",
      providerReviewerId: "reviewer-release-owner",
      role: "releaseOwner",
      decision: "APPROVED",
      approvedAt: "2026-08-06T00:00:00.000Z",
    },
    {
      ...approvalReferences[1],
      approvalId: "approval-data-safety",
      operationId: "promote-production-fixture",
      subjectSha256: subjectReference.sha256,
      trustedIssuer: "https://token.actions.githubusercontent.com",
      issuerReceiptUri: issuerReference.uri,
      issuerReceiptSha256: issuerReference.sha256,
      workflowRunId: "100",
      protectedEnvironment: "foundation-release-state",
      providerReviewerId: "reviewer-data-safety",
      role: "dataSafetyReviewer",
      decision: "APPROVED",
      approvedAt: "2026-08-06T00:00:00.000Z",
    },
  ];
  const operation = {
    operationId: "promote-production-fixture",
    kind: "promote-standard",
    expectedState: {
      sequence: 1,
      eventHash: "4".repeat(64),
    },
    targetBinding,
    companionBinding,
    previousBinding,
    emergencyRecoveryBinding: companionBinding,
    originBinding: null,
    originCompanionBinding: null,
    approvalRefs: approvals,
    preparedAt: "2026-08-06T00:00:00.000Z",
  };
  const event = createReleaseEvent({
    namespace: NAMESPACE,
    sequence: 2,
    eventType: "promotion-prepared",
    operationId: operation.operationId,
    appendId: "12345678-1234-4123-8123-123456789abc",
    previousEventHash: operation.expectedState.eventHash,
    payload: { pendingOperation: operation },
    evidenceRefs: [subjectReference, issuerReference, ...approvalReferences],
    approvalRefs: approvals,
  });
  const eventHash = sha256Bytes(canonicalJsonBytes(event));
  const result = {
    replayed: false,
    subjectSha256: subjectReference.sha256,
    subjectReference,
    approvalRefs: approvals,
    event,
    eventHash,
    eventUri: `release-state://${NAMESPACE}/events/2/${eventHash}`,
    committedAt: "2026-08-06T00:00:01.000Z",
    head: { sequence: 2, eventHash },
  };
  const validatedPrepared = {
    result,
    event,
    operation,
    domains: [DOMAIN],
    token: "fixture-vercel-token-value",
    providerPolicySha256: sha256Json(PROVIDER_POLICY),
  };
  const beforeProvider = providerObservation();
  const afterProvider = providerObservation();
  const beforeObservation = domainObservation({
    phase: "before",
    deploymentId: PREVIOUS_ID,
  });
  const afterObservation = domainObservation({
    phase: "after",
    deploymentId: TARGET_ID,
  });
  const assignments = [
    {
      productionDomain: DOMAIN,
      previousDeploymentId: PREVIOUS_ID,
      assignedDeploymentId: TARGET_ID,
    },
  ];
  const assignmentEvidence = {
    schemaVersion: 1,
    evidenceKind: "assignment-receipt",
    providerProjectId: PROJECT_ID,
    assignments,
    assignmentApiReceiptSetHash: sha256Json({
      before: beforeObservation.value.receipts,
      after: afterObservation.value.receipts,
    }),
  };
  const promotionReceipt = {
    schemaVersion: 1,
    receiptKind: "vercel-prepared-promotion/v1",
    provider: "vercel",
    outcome: "promoted",
    idempotencyKey: `promotion:${sha256Json({
      kind: "prepared-provider-promotion/v1",
      eventHash: result.eventHash,
      providerTeamId: TEAM_ID,
      providerProjectId: PROJECT_ID,
      domains: [DOMAIN],
      targetDeploymentId: TARGET_ID,
    })}`,
    completedAt: COMPLETED_AT,
    preparedEvent: {
      uri: result.eventUri,
      sha256: result.eventHash,
      sequence: event.sequence,
      operationId: event.operationId,
      committedAt: result.committedAt,
    },
    sourceSha: SOURCE_SHA,
    target: {
      bindingId: targetBinding.bindingId,
      releaseRole: "standard",
      providerDeploymentId: TARGET_ID,
      deploymentUrl: DEPLOYMENT_URL,
      providerDeploymentEvidenceSha256: targetBinding.providerEvidence.sha256,
    },
    companion: {
      bindingId: companionBinding.bindingId,
      releaseRole: "containment",
      providerDeploymentId: companionBinding.providerDeploymentId,
      providerDeploymentEvidenceSha256:
        companionBinding.providerEvidence.sha256,
    },
    approvalReferences: approvals.map(({ role, uri, sha256 }) => ({
      role,
      uri,
      sha256,
    })),
    providerBinding: {
      providerTeamId: TEAM_ID,
      providerProjectId: PROJECT_ID,
      providerPolicySha256: sha256Json(PROVIDER_POLICY),
      providerConfigurationHash: configurationHash,
      beforeProviderObservationSha256: sha256Json(beforeProvider),
      afterProviderObservationSha256: sha256Json(afterProvider),
    },
    beforeProviderObservation: {
      sha256: sha256Json(beforeProvider),
      value: beforeProvider,
    },
    afterProviderObservation: {
      sha256: sha256Json(afterProvider),
      value: afterProvider,
    },
    beforeObservation,
    afterObservation,
    assignmentEvidence,
    cli: {
      package: "vercel",
      version: TOOLCHAIN_POLICY.packages.vercel,
      operation: "promote",
      executed: true,
    },
  };
  const state = {
    head: { sequence: 2, eventHash: result.eventHash },
    snapshot: {
      pendingOperation: stateTarget ? operation : null,
    },
    records: [
      {
        sequence: 2,
        eventHash: result.eventHash,
        event,
      },
    ],
  };
  const fetchCalls = [];
  const aliasResponseBody = {
    alias: DOMAIN,
    projectId: PROJECT_ID,
    deploymentId: TARGET_ID,
    redirect: null,
  };
  const apiResponses = new Map([
    [
      "/api",
      {
        status: 404,
        bytes: Buffer.from('{"error":"api-not-found"}'),
        cacheControl: "no-store",
        contentType: "application/json; charset=utf-8",
        allow: null,
      },
    ],
    [
      "/api/__foundation-assignment-validation__",
      {
        status: 404,
        bytes: Buffer.from('{"error":"api-not-found"}'),
        cacheControl: "no-store",
        contentType: "application/json; charset=utf-8",
        allow: null,
      },
    ],
    [
      "/api/persistence-release-a-metrics",
      {
        status: 405,
        bytes: Buffer.from('{"error":"method-not-allowed"}'),
        cacheControl: "no-store",
        contentType: "application/json; charset=utf-8",
        allow: "POST",
      },
    ],
    [
      "/api/csp-report",
      {
        status: 405,
        bytes: Buffer.alloc(0),
        cacheControl: "no-store",
        contentType: null,
        allow: "POST",
      },
    ],
    [
      "/api/google-sheets-csv",
      {
        status: 405,
        bytes: Buffer.alloc(0),
        cacheControl: "no-store",
        contentType: null,
        allow: "POST",
      },
    ],
  ]);
  const fetchImpl = async (requestUrl) => {
    fetchCalls.push(requestUrl);
    const parsed = new URL(requestUrl);
    if (parsed.hostname === "api.vercel.com") {
      const bytes = canonicalJsonBytes(aliasResponseBody);
      return {
        status: 200,
        url: requestUrl,
        redirected: false,
        headers: {
          get(name) {
            const headers = {
              date: FIXED_HTTP_DATE,
              "content-length": String(bytes.length),
            };
            return headers[name.toLowerCase()] ?? null;
          },
        },
        async arrayBuffer() {
          return bytes;
        },
      };
    }
    const pathName = parsed.pathname;
    const api = apiResponses.get(pathName);
    const bytes = api?.bytes ?? publicBodies.get(pathName);
    if (!bytes) throw new Error(`unexpected route ${pathName}`);
    const cacheControl =
      api?.cacheControl ??
      (pathName === "/sw.js"
        ? "public, max-age=0, must-revalidate"
        : pathName === "/release-identity.json"
          ? "private, no-store"
          : null);
    const headers = new Map(
      Object.entries({
        date: FIXED_HTTP_DATE,
        etag: responseReceiptHash(bytes),
        "content-type": api?.contentType ?? contentTypeFor(pathName),
        "cache-control": cacheControl,
        allow: api?.allow ?? null,
        ...SECURITY_HEADERS,
      }).filter(([, value]) => value !== null),
    );
    return {
      status: api?.status ?? 200,
      url: requestUrl,
      redirected: false,
      headers: {
        get(name) {
          return headers.get(name.toLowerCase()) ?? null;
        },
      },
      async arrayBuffer() {
        return bytes;
      },
    };
  };
  let readStateCalls = 0;
  return {
    store,
    targetBinding,
    providerEvidence,
    routeProbe,
    publicBodies,
    promotionReceipt,
    aliasResponseBody,
    validatedPrepared,
    preparedEnvironment: {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_PROTECTED: "true",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "100",
      GITHUB_SHA: SOURCE_SHA,
      RELEASE_STATE_NAMESPACE: NAMESPACE,
      VERCEL_ORG_ID: TEAM_ID,
      VERCEL_PROJECT_ID: PROJECT_ID,
      VERCEL_TOKEN: validatedPrepared.token,
    },
    fetchCalls,
    state,
    options: {
      preparedResultBytes: canonicalJsonBytes(result),
      promotionReceiptBytes: canonicalJsonBytes(promotionReceipt),
      namespace: NAMESPACE,
      store,
      providerPolicy: PROVIDER_POLICY,
      toolchainPolicy: TOOLCHAIN_POLICY,
      environment: {},
    },
    dependencies: {
      validatePreparedResult: () => validatedPrepared,
      providerObservationValidator: () => {},
      resolveCspMode: async () => "report-only",
      fetchImpl,
      clock: () => FIXED_NOW,
      readState: async () => {
        readStateCalls += 1;
        return structuredClone(state);
      },
    },
    get readStateCalls() {
      return readStateCalls;
    },
  };
};

const prepareFixtureAuthority = async (
  fixture,
  dependencies = fixture.dependencies,
) => {
  const prepared = await prepareProductionAssignmentAuthority(
    fixture.options,
    dependencies,
  );
  fixture.options = {
    ...fixture.options,
    assignmentAuthorityBytes: prepared.assignmentAuthorityBytes,
  };
  return prepared;
};

test("replays pending authority and produces closed domain-by-route validation evidence", async () => {
  const fixture = createFixture();
  const preparedAuthority = await prepareFixtureAuthority(fixture);
  const result = await produceProductionAssignmentValidation(
    fixture.options,
    fixture.dependencies,
  );

  assert.equal(fixture.readStateCalls, 6);
  assert.equal(fixture.fetchCalls.length, 16);
  assert.equal(
    fixture.fetchCalls.every((url) => url.startsWith("https://")),
    true,
  );
  assert.equal(
    result.assignmentValidation.evidenceKind,
    "assignment-validation",
  );
  assert.equal(
    result.assignmentValidation.productionProbeEvidenceHash,
    result.productionProbeSha256,
  );
  assert.equal(
    result.assignmentValidation.assignmentReceiptSha256,
    sha256Json(fixture.promotionReceipt.assignmentEvidence),
  );
  assert.equal(
    result.assignmentAuthoritySha256,
    preparedAuthority.assignmentAuthoritySha256,
  );
  assert.equal(
    result.productionProbe.providerDeploymentEvidenceHash,
    fixture.targetBinding.providerEvidence.sha256,
  );
  assert.equal(
    result.productionProbe.immutableRouteProbeEvidenceHash,
    fixture.providerEvidence.routeProbeEvidenceHash,
  );
  assert.deepEqual(
    result.productionProbe.providerAssignmentObservation,
    preparedAuthority.providerAssignmentObservationReference,
  );
  assert.equal(result.productionProbe.observedAt, "2026-08-06T00:00:20.000Z");
  assert.equal(result.productionProbe.immutableApiReceipts.length, 5);
  assert.equal(result.productionProbe.results.length, 1);
  assert.equal(result.productionProbe.results[0].receipts.length, 10);
  assert.equal(
    result.productionProbe.results[0].responseSha256,
    sha256Json(result.productionProbe.results[0].receipts),
  );
  assert.equal(
    result.assignmentValidationBytes.equals(
      canonicalJsonBytes(result.assignmentValidation),
    ),
    true,
  );
  assert.equal(
    result.productionProbeBytes.equals(
      canonicalJsonBytes(result.productionProbe),
    ),
    true,
  );
});

test("integrates the real prepared-result validator, deployment evidence, and provider receipt chain", async () => {
  const fixture = createFixture();
  fixture.options = {
    ...fixture.options,
    environment: fixture.preparedEnvironment,
  };
  const dependencies = {
    ...fixture.dependencies,
    validatePreparedResult: undefined,
  };
  const authority = await prepareFixtureAuthority(fixture, dependencies);
  const result = await produceProductionAssignmentValidation(
    fixture.options,
    dependencies,
  );
  assert.equal(
    authority.assignmentAuthority.preparedResultSha256,
    sha256Bytes(fixture.options.preparedResultBytes),
  );
  assert.deepEqual(
    result.assignmentAuthority.providerAssignmentObservation,
    authority.providerAssignmentObservationReference,
  );
  assert.equal(result.productionProbe.results[0].status, "PASS");
});

test("binds assignment authority to fresh raw provider bytes and preserves preflight evidence on failure", async () => {
  {
    const fixture = createFixture();
    fixture.aliasResponseBody.deploymentId = "deployment-provider-tamper";
    await assert.rejects(
      prepareProductionAssignmentAuthority(
        fixture.options,
        fixture.dependencies,
      ),
      /deployment is ambiguous or unknown/,
    );
    assert.equal(fixture.fetchCalls.length, 1);
    for (const [bytes, mediaType] of [
      [
        fixture.options.promotionReceiptBytes,
        "application/vnd.event-shopping-planner.prepared-promotion-receipt+json;version=1",
      ],
      [
        canonicalJsonBytes(fixture.promotionReceipt.assignmentEvidence),
        "application/vnd.event-shopping-planner.provider-assignment-receipt+json;version=1",
      ],
    ]) {
      const stored = fixture.store.evidence.get(sha256Bytes(bytes));
      assert.equal(stored?.mediaType, mediaType);
      assert.equal(stored?.bytes.equals(bytes), true);
    }
  }
  {
    const fixture = createFixture();
    const authority = await prepareFixtureAuthority(fixture);
    const originalFetch = fixture.dependencies.fetchImpl;
    await assert.rejects(
      produceProductionAssignmentValidation(fixture.options, {
        ...fixture.dependencies,
        fetchImpl: async (requestUrl, init) => {
          const response = await originalFetch(requestUrl, init);
          return new URL(requestUrl).hostname === DOMAIN &&
            new URL(requestUrl).pathname === "/"
            ? { ...response, status: 503 }
            : response;
        },
      }),
      /differs from its immutable route/,
    );
    const retainedReferences = [
      authority.promotionReceiptReference,
      authority.assignmentReceiptReference,
      authority.providerAssignmentObservationReference,
      ...authority.providerReceiptChainReferences,
    ];
    for (const reference of retainedReferences) {
      assert.equal(fixture.store.evidence.has(reference.sha256), true);
    }
  }
});

test("supports exact replay without renewing freshness and tolerates HTTP Date second precision", async () => {
  const fixture = createFixture();
  fixture.promotionReceipt.completedAt = "2026-08-06T00:00:10.900Z";
  fixture.options.promotionReceiptBytes = canonicalJsonBytes(
    fixture.promotionReceipt,
  );
  const authority = await prepareFixtureAuthority(fixture);
  await assert.rejects(
    validateProductionAssignmentAuthority({
      store: fixture.store,
      namespace: NAMESPACE,
      authorityBytes: authority.assignmentAuthorityBytes,
      preparedResultBytes: fixture.options.preparedResultBytes,
      promotionReceiptBytes: fixture.options.promotionReceiptBytes,
      validatedPrepared: fixture.validatedPrepared,
      providerPolicy: PROVIDER_POLICY,
      nowMilliseconds: FIXED_NOW + 24 * 60 * 60 * 1000,
      requireFresh: true,
    }),
    /stale, future, or invalid/,
  );
  await validateProductionAssignmentAuthority({
    store: fixture.store,
    namespace: NAMESPACE,
    authorityBytes: authority.assignmentAuthorityBytes,
    preparedResultBytes: fixture.options.preparedResultBytes,
    promotionReceiptBytes: fixture.options.promotionReceiptBytes,
    validatedPrepared: fixture.validatedPrepared,
    providerPolicy: PROVIDER_POLICY,
    nowMilliseconds: FIXED_NOW + 24 * 60 * 60 * 1000,
    requireFresh: false,
  });

  const originalFetch = fixture.dependencies.fetchImpl;
  const result = await produceProductionAssignmentValidation(fixture.options, {
    ...fixture.dependencies,
    fetchImpl: async (requestUrl, init) => {
      const response = await originalFetch(requestUrl, init);
      if (new URL(requestUrl).hostname === "api.vercel.com") {
        return response;
      }
      return {
        ...response,
        headers: {
          get(name) {
            return name.toLowerCase() === "date"
              ? "Thu, 06 Aug 2026 00:00:10 GMT"
              : response.headers.get(name);
          },
        },
      };
    },
  });
  assert.equal(result.productionProbe.observedAt, "2026-08-06T00:00:10.000Z");

  const retryResult = await produceProductionAssignmentValidation(
    fixture.options,
    {
      ...fixture.dependencies,
      clock: () => FIXED_NOW + 24 * 60 * 60 * 1000,
      fetchImpl: async (requestUrl, init) => {
        const response = await originalFetch(requestUrl, init);
        return {
          ...response,
          headers: {
            get(name) {
              return name.toLowerCase() === "date"
                ? "Fri, 07 Aug 2026 00:00:20 GMT"
                : response.headers.get(name);
            },
          },
        };
      },
    },
  );
  assert.equal(
    retryResult.productionProbe.observedAt,
    "2026-08-07T00:00:20.000Z",
  );
});

test("rejects receipt, replayed state, immutable route, and caller authority tampering before output", async () => {
  {
    const fixture = createFixture();
    const tampered = {
      ...fixture.promotionReceipt,
      assignmentEvidence: {
        ...fixture.promotionReceipt.assignmentEvidence,
        assignments: [
          {
            productionDomain: DOMAIN,
            previousDeploymentId: PREVIOUS_ID,
            assignedDeploymentId: "deployment-other",
          },
        ],
      },
    };
    await assert.rejects(
      produceProductionAssignmentValidation(
        {
          ...fixture.options,
          promotionReceiptBytes: canonicalJsonBytes(tampered),
        },
        fixture.dependencies,
      ),
      /assignment|target/i,
    );
    assert.equal(fixture.fetchCalls.length, 0);
  }
  {
    const fixture = createFixture({ stateTarget: false });
    await assert.rejects(
      produceProductionAssignmentValidation(
        fixture.options,
        fixture.dependencies,
      ),
      /replayed pending operation/,
    );
    assert.equal(fixture.fetchCalls.length, 0);
  }
  {
    const fixture = createFixture({ routePath: "/safe/../aliased" });
    await assert.rejects(
      produceProductionAssignmentValidation(
        fixture.options,
        fixture.dependencies,
      ),
      /unsafe or aliased/,
    );
    assert.equal(fixture.fetchCalls.length, 0);
  }
  {
    const fixture = createFixture();
    await assert.rejects(
      produceProductionAssignmentValidation(
        { ...fixture.options, domains: [DOMAIN] },
        fixture.dependencies,
      ),
      /Caller-supplied domains is forbidden/,
    );
    assert.equal(fixture.fetchCalls.length, 0);
  }
});

test("fails closed for partial, redirected, body, header, and stale production responses", async () => {
  const cases = [
    {
      pattern: /differs from its immutable route/,
      mutate(response) {
        return { ...response, status: 503 };
      },
    },
    {
      pattern: /partial or redirected/,
      mutate(response, requestUrl) {
        return { ...response, url: `${requestUrl}/redirected` };
      },
    },
    {
      pattern: /differs from its immutable route/,
      mutate(response) {
        return {
          ...response,
          async arrayBuffer() {
            return Buffer.from("tampered body");
          },
        };
      },
    },
    {
      pattern: /differs from its immutable route/,
      mutate(response) {
        return {
          ...response,
          headers: {
            get(name) {
              if (name.toLowerCase() === "x-frame-options") return "SAMEORIGIN";
              return response.headers.get(name);
            },
          },
        };
      },
    },
    {
      pattern: /stale, future, or invalid/,
      mutate(response) {
        return {
          ...response,
          headers: {
            get(name) {
              if (name.toLowerCase() === "date") {
                return "Wed, 05 Aug 2026 00:00:00 GMT";
              }
              return response.headers.get(name);
            },
          },
        };
      },
    },
    {
      pattern: /response is oversized/,
      mutate(response) {
        let reads = 0;
        return {
          ...response,
          body: {
            getReader() {
              return {
                async read() {
                  reads += 1;
                  return reads <= 2
                    ? {
                        done: false,
                        value: new Uint8Array(3 * 1024 * 1024),
                      }
                    : { done: true, value: undefined };
                },
                async cancel() {},
                releaseLock() {},
              };
            },
          },
        };
      },
    },
  ];
  for (const testCase of cases) {
    const fixture = createFixture();
    await prepareFixtureAuthority(fixture);
    const originalFetch = fixture.dependencies.fetchImpl;
    let mutated = false;
    await assert.rejects(
      produceProductionAssignmentValidation(fixture.options, {
        ...fixture.dependencies,
        fetchImpl: async (requestUrl, init) => {
          const response = await originalFetch(requestUrl, init);
          if (
            !mutated &&
            new URL(requestUrl).hostname === DOMAIN &&
            new URL(requestUrl).pathname === "/"
          ) {
            mutated = true;
            return testCase.mutate(response, requestUrl);
          }
          return response;
        },
      }),
      testCase.pattern,
    );
  }
});

test("rejects a protected secret in a production body and state drift during probing", async () => {
  {
    const fixture = createFixture();
    await prepareFixtureAuthority(fixture);
    const secret = "production-secret-value";
    const originalFetch = fixture.dependencies.fetchImpl;
    await assert.rejects(
      produceProductionAssignmentValidation(
        {
          ...fixture.options,
          environment: { API_TOKEN: secret },
        },
        {
          ...fixture.dependencies,
          fetchImpl: async (requestUrl, init) => {
            const response = await originalFetch(requestUrl, init);
            if (
              new URL(requestUrl).hostname === DOMAIN &&
              new URL(requestUrl).pathname === "/"
            ) {
              return {
                ...response,
                async arrayBuffer() {
                  return Buffer.from(secret);
                },
              };
            }
            return response;
          },
        },
      ),
      /protected secret value/,
    );
  }
  {
    const fixture = createFixture();
    await prepareFixtureAuthority(fixture);
    let reads = 0;
    await assert.rejects(
      produceProductionAssignmentValidation(fixture.options, {
        ...fixture.dependencies,
        readState: async () => {
          reads += 1;
          const state = structuredClone(fixture.state);
          if (reads === 2) {
            state.head = {
              sequence: 3,
              eventHash: "a".repeat(64),
            };
          }
          return state;
        },
      }),
      /head changed during production assignment validation/,
    );
  }
});
