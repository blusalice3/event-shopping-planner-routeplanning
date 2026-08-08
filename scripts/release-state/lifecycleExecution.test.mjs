import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  COMPANION_RECOVERY_STEPS,
  produceCompanionRecoveryDrill,
  produceContinuousProductionProbe,
} from "./acceptanceEvidenceInputs.mjs";
import {
  acceptPendingStandardRelease,
  appendReadyReconciliation,
  recordPreparedPromotionAssignment,
  recordPreparedPromotionLifecycle,
} from "./lifecycleExecution.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
} from "./releaseStateReducer.mjs";

const namespace = "lifecycle-test";
const sourceSha = "a".repeat(40);
const operationId = "promote-lifecycle-fixture";
const completedAt = "2026-08-06T00:00:00.000Z";
const observationEndedAt = "2026-08-07T00:00:00.000Z";
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: "d".repeat(64),
};
const domains = ["a.example.test", "b.example.test"];
const providerPolicy = {
  bindingStatus: "configured",
  expectedTeamId: "team-test",
  expectedProjectId: "project-test",
  ownedProductionDomains: domains,
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.test",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
    requireEtag: false,
  },
};
const standardDimensions = (pwaLifecycle) => ({
  releaseRole: "standard",
  pwaLifecycle,
  cssDelivery: "cdn",
  cspMode: "none",
  xlsxExecution: "main",
  listEngine: "full",
  listDefault: "full",
  persistenceArchitecture: "monolith",
});
const releasePolicy = {
  schemaVersion: 1,
  dimensions: {
    releaseRole: ["standard", "containment"],
    pwaLifecycle: ["legacy-auto-update-v1", "prompt-close-all-v1"],
    cssDelivery: ["cdn"],
    cspMode: ["none"],
    xlsxExecution: ["main", "disabled"],
    listEngine: ["full", "disabled"],
    listDefault: ["full", "disabled"],
    persistenceArchitecture: ["monolith"],
  },
  containmentProjection: {
    "legacy-auto-update-v1": {
      releaseRole: "containment",
      xlsxExecution: "main",
      listEngine: "full",
      listDefault: "full",
    },
    "prompt-close-all-v1": {
      releaseRole: "containment",
      xlsxExecution: "disabled",
      listEngine: "disabled",
      listDefault: "disabled",
    },
  },
  initialStandard: standardDimensions("legacy-auto-update-v1"),
  targetStandard: standardDimensions("prompt-close-all-v1"),
  phaseSequence: [
    { gate: "P0-RELEASE", change: null },
    {
      gate: "P1-PWA",
      change: { pwaLifecycle: "prompt-close-all-v1" },
    },
  ],
};
const approvalPolicy = {
  bindingStatus: "configured",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  protectedEnvironment: "foundation-release-state",
  oidcMaxTokenAgeSeconds: 600,
  oidcClockSkewSeconds: 60,
};

class FakeReleaseStateStore {
  constructor() {
    this.namespace = namespace;
    this.records = [];
    this.evidence = new Map();
    this.compareAndAppendCalls = 0;
    this.failCompareAndAppendAt = null;
  }

  async readHead() {
    const last = this.records.at(-1);
    return last
      ? { sequence: last.sequence, eventHash: last.eventHash }
      : { sequence: 0, eventHash: null };
  }

  async readEvents({ afterSequence = 0 } = {}) {
    return this.records
      .filter((record) => record.sequence > afterSequence)
      .map((record) => structuredClone(record));
  }

  seedEvent(event, committedAtValue = completedAt) {
    const eventHash = hashReleaseEvent(event);
    this.records.push({
      sequence: event.sequence,
      eventHash,
      previousHash: event.previousEventHash,
      event: structuredClone(event),
      committedAt: committedAtValue,
    });
    return this.records.at(-1);
  }

  async compareAndAppend({ expectedSequence, expectedHash, event }) {
    this.compareAndAppendCalls += 1;
    if (this.compareAndAppendCalls === this.failCompareAndAppendAt) {
      throw new Error("fixture CAS conflict");
    }
    const existing = this.records.find(
      (record) => record.event.appendId === event.appendId,
    );
    if (existing) {
      if (
        !canonicalJsonBytes(existing.event).equals(canonicalJsonBytes(event))
      ) {
        throw new Error("append ID replay bytes differ");
      }
      return {
        namespace,
        sequence: existing.sequence,
        eventHash: existing.eventHash,
        committedAt: existing.committedAt,
        replayed: true,
      };
    }
    const head = await this.readHead();
    if (head.sequence !== expectedSequence || head.eventHash !== expectedHash) {
      throw new Error("fixture CAS conflict");
    }
    const record = this.seedEvent(event);
    return {
      namespace,
      sequence: record.sequence,
      eventHash: record.eventHash,
      committedAt: record.committedAt,
      replayed: false,
    };
  }

  async putEvidence({ bytes, mediaType }) {
    const objectBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(objectBytes);
    const existing = this.evidence.get(sha256);
    if (existing && !existing.bytes.equals(objectBytes)) {
      throw new Error("fixture evidence collision");
    }
    if (!existing) {
      this.evidence.set(sha256, {
        bytes: objectBytes,
        mediaType,
        committedAt: completedAt,
      });
    }
    const stored = this.evidence.get(sha256);
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
      mediaType: stored.mediaType,
      byteLength: objectBytes.length,
      committedAt: stored.committedAt,
      replayed: Boolean(existing),
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
}

const putJson = async (store, value, mediaType = "application/json") => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const outputFile = (path, bytes) => ({
  path,
  sha256: sha256Bytes(bytes),
  size: bytes.length,
});

const createBinding = async ({
  store,
  role,
  suffix,
  policyReference,
  providerPolicyReference,
  configurationHash,
  publicIdentityKind = "release-identity-v1",
  dimensions = standardDimensions("legacy-auto-update-v1"),
  releasePolicyValue = releasePolicy,
}) => {
  const packageIndex = await putJson(store, { kind: "package", suffix });
  if (publicIdentityKind === "legacy-bootstrap-v1") {
    const artifactManifest = await putJson(store, {
      kind: "manifest",
      suffix,
    });
    const providerEvidence = await putJson(store, {
      kind: "provider-deployment",
      suffix,
    });
    return {
      bindingId: `${role}-${suffix}`,
      sourceSha,
      buildId: sourceSha,
      variantId: suffix.repeat(64),
      releaseRole: role,
      publicIdentityKind,
      providerProjectId: providerPolicy.expectedProjectId,
      providerDeploymentId: `deployment-${role}-${suffix}`,
      deploymentUrl: `https://${role}-${suffix}.example.test`,
      packageIndex,
      artifactManifest,
      providerEvidence,
      releasePolicy: policyReference,
      providerPolicy: providerPolicyReference,
      providerConfigurationHash: configurationHash,
      requiredDbCompatibility: dbCompatibility,
    };
  }
  const variantId = computeVariantId(releasePolicyValue, dimensions);
  const deploymentUrl = `https://${role}-${suffix}.example.test`;
  const roleEntryBytes = Buffer.from(`role:${role}:${suffix}\n`);
  const serviceWorkerBytes = Buffer.from(`worker:${role}:${suffix}\n`);
  const outerAgentBytes = Buffer.from(`outer:${role}:${suffix}\n`);
  const roleEntryPath = "/assets/release-role.js";
  const serviceWorkerPath = "/sw.js";
  const outerAgentPath = "/assets/outer-recovery-agent.js";
  const identity =
    dimensions.pwaLifecycle === "prompt-close-all-v1"
      ? {
          schemaVersion: 1,
          sourceSha,
          buildId: sourceSha,
          variantId,
          releaseRole: role,
          requiredDbCompatibilityFingerprint: dbCompatibility.fingerprint,
          pwaLifecycle: dimensions.pwaLifecycle,
          roleEntryUrl: roleEntryPath,
          roleEntrySha256: sha256Bytes(roleEntryBytes),
          serviceWorkerUrl: serviceWorkerPath,
          serviceWorkerSha256: sha256Bytes(serviceWorkerBytes),
          outerAgentUrl: outerAgentPath,
          outerAgentSha256: sha256Bytes(outerAgentBytes),
        }
      : {
          schemaVersion: 1,
          sourceSha,
          buildId: sourceSha,
          variantId,
          releaseRole: role,
          requiredDbCompatibilityFingerprint: dbCompatibility.fingerprint,
          pwaLifecycle: dimensions.pwaLifecycle,
          appEntryUrl: roleEntryPath,
          appEntrySha256: sha256Bytes(roleEntryBytes),
          serviceWorkerUrl: serviceWorkerPath,
          serviceWorkerSha256: sha256Bytes(serviceWorkerBytes),
        };
  const entryModule =
    role === "standard"
      ? "src/bootstrap.ts"
      : "src/pwa/containment-recovery-entry.ts";
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha,
    releaseRole: role,
    variantId,
    entryModule,
    entryFile: roleEntryPath,
    modules: [
      {
        id: entryModule,
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: roleEntryPath,
        sha256: sha256Bytes(roleEntryBytes),
        size: roleEntryBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: [entryModule],
      },
    ],
  };
  const outputFiles = [
    outputFile("static/assets/release-role.js", roleEntryBytes),
    outputFile("static/sw.js", serviceWorkerBytes),
    ...(dimensions.pwaLifecycle === "prompt-close-all-v1"
      ? [outputFile("static/assets/outer-recovery-agent.js", outerAgentBytes)]
      : []),
  ].sort((left, right) => compareUtf8(left.path, right.path));
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole: role,
    dimensions,
    buildInputClosureHash: "1".repeat(64),
    lockfileSha256: "2".repeat(64),
    toolchainPolicyHash: "3".repeat(64),
    publicBuildEnvHash: "4".repeat(64),
    providerConfigurationHash: configurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: policyReference.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentityKind,
    bootstrap: null,
    publicResponseHashes: {},
    roleEntryGraph,
    roleEntryGraphHash: sha256Json(roleEntryGraph),
    outputFiles,
  };
  const artifactManifest = await putJson(store, manifest);
  const providerEvidence = await putJson(store, {
    schemaVersion: 1,
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: `deployment-${role}-${suffix}`,
    deploymentUrl,
    sourceSha,
    variantId,
    releaseRole: role,
    artifactManifestHash: artifactManifest.sha256,
    packageIndexHash: packageIndex.sha256,
    providerConfigurationHash: configurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: policyReference.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentity: {
      identityKind: "release-identity-v1",
      identity,
      identitySha256: sha256Json(identity),
    },
    routeProbeEvidenceHash: "5".repeat(64),
    environmentPresenceEvidenceHash: "6".repeat(64),
  });
  return {
    bindingId: `${role}-${suffix}`,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole: role,
    publicIdentityKind,
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: `deployment-${role}-${suffix}`,
    deploymentUrl,
    packageIndex,
    artifactManifest,
    providerEvidence,
    releasePolicy: policyReference,
    providerPolicy: providerPolicyReference,
    providerConfigurationHash: configurationHash,
    requiredDbCompatibility: dbCompatibility,
  };
};

const providerReceipt = (kind, responseDate = completedAt) => ({
  kind,
  responseDate,
  responseSha256: "f".repeat(64),
});

const providerObservation = (phase) => ({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: completedAt,
  providerTeamId: providerPolicy.expectedTeamId,
  providerProjectId: providerPolicy.expectedProjectId,
  ownedProductionDomains: domains,
  productionBranch: "main",
  configurationMarker: "fixture",
  evidenceReceipts: [providerReceipt(`${phase}-configuration`)],
});

const domainObservation = ({ phase, targetDeploymentId }) => {
  const receipts = domains.map((productionDomain) => {
    const requestUrl = new URL(
      `/v4/aliases/${encodeURIComponent(productionDomain)}`,
      providerPolicy.observationPolicy.apiBaseUrl,
    );
    requestUrl.searchParams.set("projectId", providerPolicy.expectedProjectId);
    requestUrl.searchParams.set("teamId", providerPolicy.expectedTeamId);
    requestUrl.searchParams.sort();
    const receipt = {
      schemaVersion: 1,
      receiptKind: "vercel-domain-assignment-observation/v1",
      phase,
      productionDomain,
      method: "GET",
      requestUrl: requestUrl.href,
      status: 200,
      responseDate: completedAt,
      etag: null,
      bodySha256: "7".repeat(64),
      providerProjectId: providerPolicy.expectedProjectId,
      assignedDeploymentId: targetDeploymentId,
    };
    return {
      productionDomain,
      receiptSha256: sha256Json(receipt),
      receipt,
    };
  });
  return {
    schemaVersion: 1,
    observationKind: "vercel-owned-domain-assignment/v1",
    phase,
    observedAt: completedAt,
    providerTeamId: providerPolicy.expectedTeamId,
    providerProjectId: providerPolicy.expectedProjectId,
    receipts,
  };
};

const createApprovalReference = async ({
  store,
  role,
  index,
  subjectSha256,
  approvedAt = completedAt,
}) => {
  const issuer = await putJson(store, {
    kind: "issuer",
    operationId,
    index,
  });
  const receipt = await putJson(store, {
    kind: "approval",
    operationId,
    role,
    index,
  });
  return {
    uri: receipt.uri,
    sha256: receipt.sha256,
    approvalId: `approval-${index}`,
    operationId,
    subjectSha256,
    trustedIssuer: approvalPolicy.trustedIssuer,
    issuerReceiptUri: issuer.uri,
    issuerReceiptSha256: issuer.sha256,
    workflowRunId: "100",
    protectedEnvironment: approvalPolicy.protectedEnvironment,
    providerReviewerId: `reviewer-${index}`,
    role,
    decision: "APPROVED",
    approvedAt,
  };
};

const initializePromotionFixture = async ({
  pwaLifecycle = "legacy-auto-update-v1",
  companionDimensions = null,
  releasePolicyValue = releasePolicy,
} = {}) => {
  const store = new FakeReleaseStateStore();
  const policyReference = await putJson(store, releasePolicyValue);
  const providerPolicyReference = await putJson(store, providerPolicy);
  const configurationHash = providerConfigurationHash(
    providerObservation("stable"),
  );
  const bootstrap = await createBinding({
    store,
    role: "containment",
    suffix: "b",
    policyReference,
    providerPolicyReference,
    configurationHash,
    publicIdentityKind: "legacy-bootstrap-v1",
  });
  const initialEvidence = await putJson(store, { kind: "initial" });
  const initial = createReleaseEvent({
    namespace,
    sequence: 1,
    eventType: "state-initialized",
    operationId: "initialize",
    previousEventHash: null,
    payload: {
      legacyObservedProduction: {
        observationUri: initialEvidence.uri,
        observationSha256: initialEvidence.sha256,
      },
      bootstrapRecovery: bootstrap,
      minimumSafetyFloors: { releaseChannel: "release-a" },
      currentDbCompatibility: dbCompatibility,
      activeReleasePolicy: policyReference,
    },
    evidenceRefs: [initialEvidence],
  });
  store.seedEvent(initial);
  const targetBinding = await createBinding({
    store,
    role: "standard",
    suffix: "c",
    policyReference,
    providerPolicyReference,
    configurationHash,
    dimensions: standardDimensions(pwaLifecycle),
    releasePolicyValue,
  });
  const projectedCompanionDimensions = projectContainmentDimensions(
    releasePolicyValue,
    standardDimensions(pwaLifecycle),
  );
  const companionBinding = await createBinding({
    store,
    role: "containment",
    suffix: "e",
    policyReference,
    providerPolicyReference,
    configurationHash,
    dimensions: companionDimensions ?? projectedCompanionDimensions,
    releasePolicyValue,
  });
  const subjectReference = await putJson(store, {
    kind: "promotion-subject",
    operationId,
  });
  const subjectSha256 = subjectReference.sha256;
  const approvals = [
    await createApprovalReference({
      store,
      role: "releaseOwner",
      index: 1,
      subjectSha256,
    }),
    await createApprovalReference({
      store,
      role: "dataSafetyReviewer",
      index: 2,
      subjectSha256,
    }),
  ];
  const current = await readCurrentReleaseState({ store });
  const pendingOperation = {
    operationId,
    kind: "promote-standard",
    expectedState: structuredClone(current.head),
    targetBinding,
    originBinding: null,
    originCompanionBinding: null,
    companionBinding,
    previousBinding: null,
    emergencyRecoveryBinding: bootstrap,
    approvalRefs: approvals,
    preparedAt: completedAt,
  };
  const preparedEvent = createReleaseEvent({
    namespace,
    sequence: current.snapshot.sequence + 1,
    eventType: "promotion-prepared",
    operationId,
    previousEventHash: current.snapshot.eventHash,
    payload: { pendingOperation },
    evidenceRefs: [
      subjectReference,
      ...approvals.flatMap((approval) => [
        { uri: approval.uri, sha256: approval.sha256 },
        {
          uri: approval.issuerReceiptUri,
          sha256: approval.issuerReceiptSha256,
        },
      ]),
    ],
    approvalRefs: approvals,
  });
  const preparedRecord = store.seedEvent(preparedEvent);
  const preparedResult = {
    replayed: false,
    subjectSha256,
    subjectReference,
    approvalRefs: approvals,
    event: preparedEvent,
    eventHash: preparedRecord.eventHash,
    eventUri:
      `release-state://${namespace}/events/` +
      `${preparedRecord.sequence}/${preparedRecord.eventHash}`,
    committedAt: completedAt,
    head: {
      sequence: preparedRecord.sequence,
      eventHash: preparedRecord.eventHash,
    },
  };
  const before = domainObservation({
    phase: "before",
    targetDeploymentId: targetBinding.providerDeploymentId,
  });
  const after = domainObservation({
    phase: "after",
    targetDeploymentId: targetBinding.providerDeploymentId,
  });
  const beforeProvider = providerObservation("before");
  const afterProvider = providerObservation("after");
  const assignmentEvidence = {
    schemaVersion: 1,
    evidenceKind: "assignment-receipt",
    providerProjectId: providerPolicy.expectedProjectId,
    assignments: domains.map((productionDomain) => ({
      productionDomain,
      previousDeploymentId: targetBinding.providerDeploymentId,
      assignedDeploymentId: targetBinding.providerDeploymentId,
    })),
    assignmentApiReceiptSetHash: sha256Json({
      before: before.receipts,
      after: after.receipts,
    }),
  };
  const promotionReceipt = {
    schemaVersion: 1,
    receiptKind: "vercel-prepared-promotion/v1",
    provider: "vercel",
    outcome: "replayed",
    idempotencyKey: `promotion:${sha256Json({
      kind: "prepared-provider-promotion/v1",
      eventHash: preparedResult.eventHash,
      providerTeamId: providerPolicy.expectedTeamId,
      providerProjectId: providerPolicy.expectedProjectId,
      domains,
      targetDeploymentId: targetBinding.providerDeploymentId,
    })}`,
    completedAt,
    preparedEvent: {
      uri: preparedResult.eventUri,
      sha256: preparedResult.eventHash,
      sequence: preparedEvent.sequence,
      operationId,
      committedAt: completedAt,
    },
    sourceSha,
    target: {
      bindingId: targetBinding.bindingId,
      releaseRole: "standard",
      providerDeploymentId: targetBinding.providerDeploymentId,
      deploymentUrl: targetBinding.deploymentUrl,
      providerDeploymentEvidenceSha256: targetBinding.providerEvidence.sha256,
    },
    companion: {
      bindingId: companionBinding.bindingId,
      releaseRole: "containment",
      providerDeploymentId: companionBinding.providerDeploymentId,
      providerDeploymentEvidenceSha256:
        companionBinding.providerEvidence.sha256,
    },
    approvalReferences: approvals.map((approval) => ({
      role: approval.role,
      uri: approval.uri,
      sha256: approval.sha256,
    })),
    providerBinding: {
      providerTeamId: providerPolicy.expectedTeamId,
      providerProjectId: providerPolicy.expectedProjectId,
      providerPolicySha256: sha256Json(providerPolicy),
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
    beforeObservation: {
      sha256: sha256Json(before),
      value: before,
    },
    afterObservation: {
      sha256: sha256Json(after),
      value: after,
    },
    assignmentEvidence,
    cli: {
      package: "vercel",
      version: "50.9.5",
      operation: "promote",
      executed: false,
    },
  };
  const assignmentBytes = canonicalJsonBytes(assignmentEvidence);
  const assignmentSha256 = sha256Bytes(assignmentBytes);
  const providerAssignmentObservation = await putJson(store, {
    observationKind: "fixture-provider-assignment-observation/v1",
    targetBindingId: targetBinding.bindingId,
  });
  const assignmentAuthority = {
    schemaVersion: 1,
    evidenceKind: "production-assignment-authority/v1",
    namespace,
    preparedResultSha256: sha256Bytes(canonicalJsonBytes(preparedResult)),
    targetBindingId: targetBinding.bindingId,
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: targetBinding.providerDeploymentId,
    promotionReceipt: {
      uri:
        `release-state://${namespace}/evidence/` +
        sha256Bytes(canonicalJsonBytes(promotionReceipt)),
      sha256: sha256Bytes(canonicalJsonBytes(promotionReceipt)),
    },
    assignmentReceipt: {
      uri: `release-state://${namespace}/evidence/` + assignmentSha256,
      sha256: assignmentSha256,
    },
    providerAssignmentObservation,
  };
  const productionPaths = [
    "/api",
    "/api/__foundation-assignment-validation__",
    "/api/csp-report",
    "/api/google-sheets-csv",
    "/api/persistence-release-a-metrics",
  ];
  const productionReceipt = (origin, path) => ({
    method: "GET",
    path,
    requestUrl: `${origin}${path}`,
    responseUrl: `${origin}${path}`,
    status: 404,
    responseDate: new Date(completedAt).toUTCString(),
    etag: null,
    contentType: "application/json",
    cacheControl: "no-store",
    allow: null,
    securityHeaders: {
      "content-security-policy": "default-src 'none'",
      "permissions-policy": "",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
    bodySha256: "8".repeat(64),
    byteLength: 0,
  });
  const immutableApiReceipts = productionPaths.map((path) =>
    productionReceipt(targetBinding.deploymentUrl, path),
  );
  const productionProbe = {
    schemaVersion: 1,
    evidenceKind: "production-assignment-probe/v1",
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: targetBinding.providerDeploymentId,
    providerDeploymentEvidenceHash: targetBinding.providerEvidence.sha256,
    immutableRouteProbeEvidenceHash: "5".repeat(64),
    providerAssignmentObservation,
    observedAt: completedAt,
    immutableApiReceipts,
    results: domains.map((productionDomain) => ({
      productionDomain,
      providerDeploymentId: targetBinding.providerDeploymentId,
      status: "PASS",
      responseSha256: sha256Json(
        productionPaths.map((path) =>
          productionReceipt(`https://${productionDomain}`, path),
        ),
      ),
      receipts: productionPaths.map((path) =>
        productionReceipt(`https://${productionDomain}`, path),
      ),
    })),
  };
  const assignmentValidation = {
    schemaVersion: 1,
    evidenceKind: "assignment-validation",
    providerProjectId: providerPolicy.expectedProjectId,
    assignmentReceiptUri: `release-state://${namespace}/evidence/${assignmentSha256}`,
    assignmentReceiptSha256: assignmentSha256,
    assignments: structuredClone(assignmentEvidence.assignments),
    productionProbeEvidenceHash: sha256Bytes(
      canonicalJsonBytes(productionProbe),
    ),
  };
  const validatedPrepared = {
    result: preparedResult,
    event: preparedEvent,
    operation: pendingOperation,
    domains,
    token: "fixture-token-value",
    providerPolicySha256: sha256Json(providerPolicy),
  };
  return {
    store,
    bootstrap,
    targetBinding,
    companionBinding,
    preparedResult,
    preparedResultBytes: canonicalJsonBytes(preparedResult),
    promotionReceipt,
    promotionReceiptBytes: canonicalJsonBytes(promotionReceipt),
    assignmentAuthority,
    assignmentAuthorityBytes: canonicalJsonBytes(assignmentAuthority),
    assignmentValidation,
    assignmentValidationBytes: canonicalJsonBytes(assignmentValidation),
    productionProbe,
    productionProbeBytes: canonicalJsonBytes(productionProbe),
    validatedPrepared,
  };
};

const runPromotionLifecycle = async (
  fixture,
  overrides = {},
  dependencyOverrides = {},
) => {
  const dependencies = {
    validatePreparedResult: () => fixture.validatedPrepared,
    validateProviderObservation: () => {},
    validateAuthority: () => fixture.assignmentAuthority,
    clock: () => Date.parse(completedAt),
    ...dependencyOverrides,
  };
  const common = {
    store: fixture.store,
    preparedResultBytes: fixture.preparedResultBytes,
    promotionReceiptBytes: fixture.promotionReceiptBytes,
    assignmentAuthorityBytes: fixture.assignmentAuthorityBytes,
    providerPolicy,
    environment: {},
    ...overrides,
  };
  await recordPreparedPromotionAssignment(common, dependencies);
  return recordPreparedPromotionLifecycle(
    {
      assignmentValidationBytes: fixture.assignmentValidationBytes,
      productionProbeBytes: fixture.productionProbeBytes,
      ...common,
    },
    dependencies,
  );
};

const acceptanceEvidence = () => ({
  schemaVersion: "release-a-evidence/v1",
  release: {
    releaseId: operationId,
    commitSha: sourceSha,
  },
  canary: {
    buildSha: sourceSha,
    startedAt: completedAt,
    endedAt: observationEndedAt,
  },
  automatedGates: {
    rollback: {
      status: "PASS",
      command: "npm run test:release-a-rollback",
      commitSha: sourceSha,
      completedAt: observationEndedAt,
      evidenceRef: "artifact://release-a/rollback-recovery-drill",
    },
  },
});

const acceptanceInputOptions = async ({
  fixture,
  evidence = acceptanceEvidence(),
  includeRecoveryDrill = false,
}) => {
  const current = await readCurrentReleaseState({ store: fixture.store });
  const pendingAcceptance = current.snapshot.pendingAcceptance;
  const evidenceBytes = canonicalJsonBytes(evidence);
  const expectedEvidenceSha256 = sha256Bytes(evidenceBytes);
  const continuousSource = {
    schemaVersion: 1,
    sourceKind: "continuous-production-probe-source/v1",
    samples: Array.from({ length: 289 }, (_, index) => ({
      observedAt: new Date(
        Date.parse(completedAt) + index * 5 * 60 * 1000,
      ).toISOString(),
      results: domains.map((productionDomain) => ({
        productionDomain,
        providerDeploymentId:
          pendingAcceptance.standardBinding.providerDeploymentId,
        status: "PASS",
        responseSha256: sha256Json({ index, productionDomain }),
      })),
    })),
  };
  const continuousSourceBytes = canonicalJsonBytes(continuousSource);
  const continuous = produceContinuousProductionProbe({
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes: evidenceBytes,
    expectedReleaseAEvidenceSha256: expectedEvidenceSha256,
    sourceBytes: continuousSourceBytes,
    expectedSourceSha256: sha256Bytes(continuousSourceBytes),
    providerPolicy,
    nowMilliseconds: Date.parse(observationEndedAt),
  });
  const options = {
    store: fixture.store,
    evidenceBytes,
    expectedEvidenceSha256,
    continuousProbeBytes: continuous.evidenceBytes,
    expectedContinuousProbeSha256: continuous.sha256,
    approvalPolicy,
    expectedRunId: "200",
  };
  if (!includeRecoveryDrill) return options;
  const companion = pendingAcceptance.companionBinding;
  const recoverySource = {
    schemaVersion: 1,
    sourceKind: "companion-recovery-drill-source/v1",
    status: "PASS",
    command: "npm run test:release-a-rollback",
    startedAt: "2026-08-06T23:00:00.000Z",
    completedAt: evidence.automatedGates.rollback.completedAt,
    drillEvidenceRef: evidence.automatedGates.rollback.evidenceRef,
    companion: {
      bindingId: companion.bindingId,
      sourceSha: companion.sourceSha,
      buildId: companion.buildId,
      variantId: companion.variantId,
      providerProjectId: companion.providerProjectId,
      providerDeploymentId: companion.providerDeploymentId,
      packageIndexSha256: companion.packageIndex.sha256,
      artifactManifestSha256: companion.artifactManifest.sha256,
      providerEvidenceSha256: companion.providerEvidence.sha256,
    },
    steps: COMPANION_RECOVERY_STEPS.map((step, index) => ({
      step,
      status: "PASS",
      evidenceRef: `artifact://release-a/recovery-step-${index + 1}`,
    })),
  };
  const recoverySourceBytes = canonicalJsonBytes(recoverySource);
  const recovery = produceCompanionRecoveryDrill({
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes: evidenceBytes,
    expectedReleaseAEvidenceSha256: expectedEvidenceSha256,
    sourceBytes: recoverySourceBytes,
    expectedSourceSha256: sha256Bytes(recoverySourceBytes),
    nowMilliseconds: Date.parse(observationEndedAt),
    futureClockSkewSeconds: 30,
  });
  return {
    ...options,
    companionRecoveryDrillBytes: recovery.evidenceBytes,
    expectedCompanionRecoveryDrillSha256: recovery.sha256,
  };
};

const acceptanceCollector = async ({
  store,
  operationId: boundOperationId,
  subjectSha256,
  observedThrough,
}) => {
  const issuer = await putJson(store, {
    kind: "acceptance-issuer",
    subjectSha256,
  });
  const approvalRefs = [];
  for (const [role, index] of [
    ["releaseOwner", 1],
    ["dataSafetyReviewer", 2],
    ["operationsReviewer", 3],
  ]) {
    const receipt = await putJson(store, {
      kind: "acceptance-approval",
      role,
      subjectSha256,
    });
    approvalRefs.push({
      uri: receipt.uri,
      sha256: receipt.sha256,
      approvalId: `acceptance-${index}`,
      operationId: boundOperationId,
      subjectSha256,
      trustedIssuer: approvalPolicy.trustedIssuer,
      issuerReceiptUri: issuer.uri,
      issuerReceiptSha256: issuer.sha256,
      workflowRunId: "200",
      protectedEnvironment: approvalPolicy.protectedEnvironment,
      providerReviewerId: `acceptance-reviewer-${index}`,
      role,
      decision: "APPROVED",
      approvedAt: observedThrough,
    });
  }
  return {
    approvalRefs,
    issuerReceiptReference: issuer,
    oidcExpiresAt: new Date(
      Date.parse(observedThrough) + 10 * 60 * 1000,
    ).toISOString(),
    verifiedAt: observedThrough,
  };
};

test("appends a ready reconcile plan once and replays the deterministic event", async () => {
  const fixture = await initializePromotionFixture();
  const observationReference = await putJson(fixture.store, {
    kind: "provider-observation",
  });
  const current = await readCurrentReleaseState({ store: fixture.store });
  const decision = {
    schemaVersion: 1,
    decisionKind: "release-state-reconcile-decision/v1",
    status: "ready",
    action: "append-state-reconciled",
    operationId,
    observationSha256: observationReference.sha256,
    eventPlan: {
      eventType: "state-reconciled",
      operationId,
      expectedState: current.head,
      payload: {
        reconciliationKind: "provider-target-assigned/v1",
        observedBinding: fixture.targetBinding,
        providerObservation: observationReference,
      },
      evidenceRefs: [
        observationReference,
        fixture.targetBinding.providerEvidence,
      ],
    },
  };
  const first = await appendReadyReconciliation({
    store: fixture.store,
    decision,
  });
  const calls = fixture.store.compareAndAppendCalls;
  const replay = await appendReadyReconciliation({
    store: fixture.store,
    decision,
  });
  const tamperedRetry = structuredClone(decision);
  tamperedRetry.eventPlan.expectedState.eventHash = "0".repeat(64);
  await assert.rejects(
    appendReadyReconciliation({
      store: fixture.store,
      decision: tamperedRetry,
    }),
    /expected state differs from the committed predecessor/,
  );
  assert.equal(first.appended, true);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(fixture.store.compareAndAppendCalls, calls);
  assert.equal(
    fixture.store.records.filter(
      (record) => record.event.eventType === "state-reconciled",
    ).length,
    1,
  );
});

test("never appends a blocked reconcile decision", async () => {
  const fixture = await initializePromotionFixture();
  const result = await appendReadyReconciliation({
    store: fixture.store,
    decision: {
      schemaVersion: 1,
      status: "blocked",
      reasonCodes: ["partial-production-domain-set"],
    },
  });
  assert.equal(result.appended, false);
  assert.equal(fixture.store.compareAndAppendCalls, 0);
});

test("records assignment, validation, and observation events and replays exactly", async () => {
  const fixture = await initializePromotionFixture();
  const first = await runPromotionLifecycle(fixture);
  const calls = fixture.store.compareAndAppendCalls;
  const replay = await runPromotionLifecycle(
    fixture,
    {},
    {
      clock: () => Date.parse(completedAt) + 24 * 60 * 60 * 1000,
    },
  );
  const current = await readCurrentReleaseState({ store: fixture.store });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.store.compareAndAppendCalls, calls);
  assert.equal(current.snapshot.pendingAcceptance.operationId, operationId);
  assert.equal(
    current.snapshot.pendingAcceptance.observationStartedEvent.uri,
    first.events.assignmentValidated.uri,
  );
  assert.equal(
    current.snapshot.pendingAcceptance.minimumObservationEndsAt,
    observationEndedAt,
  );
});

test("resumes an exact partial lifecycle after a CAS conflict", async () => {
  const fixture = await initializePromotionFixture();
  fixture.store.failCompareAndAppendAt = 2;
  await assert.rejects(runPromotionLifecycle(fixture), /fixture CAS conflict/);
  assert.equal(
    fixture.store.records.filter(
      (record) => record.event.eventType === "deployment-assigned",
    ).length,
    1,
  );
  fixture.store.failCompareAndAppendAt = null;
  const result = await runPromotionLifecycle(fixture);
  assert.equal(result.replayed, false);
  assert.equal(
    fixture.store.records.filter((record) =>
      [
        "deployment-assigned",
        "assignment-validated",
        "observation-started",
      ].includes(record.event.eventType),
    ).length,
    3,
  );
});

test("rejects tampered evidence and preserves only a verified assignment prefix", async (t) => {
  await t.test("tampered target", async () => {
    const fixture = await initializePromotionFixture();
    const receipt = structuredClone(fixture.promotionReceipt);
    receipt.target.providerDeploymentId = "deployment-attacker";
    await assert.rejects(
      runPromotionLifecycle(fixture, {
        promotionReceiptBytes: canonicalJsonBytes(receipt),
      }),
      /target pair differs/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, 0);
  });
  await t.test("stale receipt", async () => {
    const fixture = await initializePromotionFixture();
    const receipt = structuredClone(fixture.promotionReceipt);
    receipt.completedAt = "2026-08-05T23:00:00.000Z";
    await assert.rejects(
      runPromotionLifecycle(fixture, {
        promotionReceiptBytes: canonicalJsonBytes(receipt),
      }),
      /freshness|authoritative provider Dates/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, 0);
  });
  await t.test("duplicate domain", async () => {
    const fixture = await initializePromotionFixture();
    const validation = structuredClone(fixture.assignmentValidation);
    validation.assignments[1].productionDomain =
      validation.assignments[0].productionDomain;
    await assert.rejects(
      runPromotionLifecycle(fixture, {
        assignmentValidationBytes: canonicalJsonBytes(validation),
      }),
      /does not bind the assignment receipt|owned domain set/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, 1);
  });
  await t.test("unknown authoritative receipt field", async () => {
    const fixture = await initializePromotionFixture();
    const receipt = structuredClone(fixture.promotionReceipt);
    receipt.afterObservation.value.receipts[0].receipt.unreviewed = true;
    receipt.afterObservation.sha256 = sha256Json(
      receipt.afterObservation.value,
    );
    await assert.rejects(
      runPromotionLifecycle(fixture, {
        promotionReceiptBytes: canonicalJsonBytes(receipt),
      }),
      /authoritative domain receipt has unknown or missing fields/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, 0);
  });
  await t.test("probe for a different deployment", async () => {
    const fixture = await initializePromotionFixture();
    const probe = structuredClone(fixture.productionProbe);
    probe.providerDeploymentId = "deployment-attacker";
    for (const result of probe.results) {
      result.providerDeploymentId = "deployment-attacker";
    }
    const validation = structuredClone(fixture.assignmentValidation);
    validation.productionProbeEvidenceHash = sha256Bytes(
      canonicalJsonBytes(probe),
    );
    await assert.rejects(
      runPromotionLifecycle(fixture, {
        productionProbeBytes: canonicalJsonBytes(probe),
        assignmentValidationBytes: canonicalJsonBytes(validation),
      }),
      /Production probe identity differs/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, 1);
  });
  await t.test("duplicate probe domain", async () => {
    const fixture = await initializePromotionFixture();
    const probe = structuredClone(fixture.productionProbe);
    probe.results[1].productionDomain = probe.results[0].productionDomain;
    const validation = structuredClone(fixture.assignmentValidation);
    validation.productionProbeEvidenceHash = sha256Bytes(
      canonicalJsonBytes(probe),
    );
    await assert.rejects(
      runPromotionLifecycle(fixture, {
        productionProbeBytes: canonicalJsonBytes(probe),
        assignmentValidationBytes: canonicalJsonBytes(validation),
      }),
      /does not cover the owned domain set/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, 1);
  });
});

test("rejects a production probe without authoritative observedAt", async () => {
  const fixture = await initializePromotionFixture();
  const probe = structuredClone(fixture.productionProbe);
  delete probe.observedAt;
  const probeBytes = canonicalJsonBytes(probe);
  const validation = structuredClone(fixture.assignmentValidation);
  validation.productionProbeEvidenceHash = sha256Bytes(probeBytes);
  await assert.rejects(
    runPromotionLifecycle(fixture, {
      productionProbeBytes: probeBytes,
      assignmentValidationBytes: canonicalJsonBytes(validation),
    }),
    /unknown or missing fields/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, 1);
});

test("rechecks provider freshness immediately before the first lifecycle CAS", async () => {
  const fixture = await initializePromotionFixture();
  let reads = 0;
  await assert.rejects(
    runPromotionLifecycle(
      fixture,
      {},
      {
        clock: () => {
          reads += 1;
          return Date.parse(completedAt) + (reads === 1 ? 0 : 60 * 60 * 1000);
        },
      },
    ),
    /outside provider freshness/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, 0);
});

test("rejects caller-supplied lifecycle state and authority fields", async () => {
  const fixture = await initializePromotionFixture();
  await assert.rejects(
    runPromotionLifecycle(fixture, { snapshot: {} }),
    /Caller-supplied snapshot is forbidden/,
  );
  await assert.rejects(
    runPromotionLifecycle(fixture, {
      nowMilliseconds: Date.parse(completedAt),
    }),
    /Caller-supplied nowMilliseconds is forbidden/,
  );
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({ fixture });
  await assert.rejects(
    acceptPendingStandardRelease(
      {
        ...input,
        inventory: [],
      },
      {
        validateEvidence: () => [],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      },
    ),
    /Caller-supplied inventory is forbidden/,
  );
});

test("rejects acceptance bytes that differ from the reviewed evidence hash", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({ fixture });
  const calls = fixture.store.compareAndAppendCalls;
  await assert.rejects(
    acceptPendingStandardRelease(
      {
        ...input,
        expectedEvidenceSha256: "0".repeat(64),
      },
      {
        validateEvidence: () => [],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      },
    ),
    /differs from its reviewed SHA-256/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, calls);
});

test("accepts only fresh standard evidence with three derived roles and replays", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({ fixture });
  const first = await acceptPendingStandardRelease(
    {
      ...input,
      oidcRequestUrl: "https://oidc.example.test",
      oidcRequestToken: "oidc-token",
      githubToken: "g".repeat(20),
    },
    {
      validateEvidence: () => [],
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    },
  );
  const calls = fixture.store.compareAndAppendCalls;
  const replay = await acceptPendingStandardRelease(
    {
      ...input,
      oidcRequestUrl: "https://oidc.example.test",
      oidcRequestToken: "oidc-token",
      githubToken: "g".repeat(20),
    },
    {
      validateEvidence: () => [],
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    },
  );
  const current = await readCurrentReleaseState({ store: fixture.store });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.store.compareAndAppendCalls, calls);
  assert.equal(first.approvals.length, 3);
  assert.equal(current.snapshot.pendingAcceptance, null);
  assert.equal(current.snapshot.pendingOperation, null);
  assert.equal(
    current.snapshot.acceptedStandard.bindingId,
    fixture.targetBinding.bindingId,
  );
  assert.deepEqual(current.snapshot.acceptedStandardFloors, {
    pwaLifecycle: "legacy-auto-update-v1",
    cssDelivery: "cdn",
    cspMode: "none",
    xlsxExecution: "main",
    listEngine: "full",
    listDefault: "full",
    persistenceArchitecture: "monolith",
  });
  assert.equal(
    current.snapshot.bootstrapRecovery.bindingId,
    fixture.bootstrap.bindingId,
  );
  const acceptedRecord = fixture.store.records.find(
    (record) => record.event.eventType === "release-accepted",
  );
  acceptedRecord.event.payload.observedThrough = "2026-08-07T00:00:01.000Z";
  acceptedRecord.event.payloadSha256 = sha256Json(acceptedRecord.event.payload);
  acceptedRecord.eventHash = hashReleaseEvent(acceptedRecord.event);
  await assert.rejects(
    acceptPendingStandardRelease(
      {
        ...input,
      },
      {
        validateEvidence: () => [],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      },
    ),
    /subject or payload differs/,
  );
});

test("derives prompt-close-all floors and clears bootstrap only with a passing recovery drill", async () => {
  const promptPolicy = {
    ...releasePolicy,
    initialStandard: standardDimensions("prompt-close-all-v1"),
    targetStandard: standardDimensions("prompt-close-all-v1"),
    phaseSequence: [{ gate: "P1-PWA", change: null }],
  };
  const fixture = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
  });
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({
    fixture,
    includeRecoveryDrill: true,
  });
  await acceptPendingStandardRelease(input, {
    validateEvidence: () => [],
    collectApprovals: acceptanceCollector,
    clock: () => Date.parse(observationEndedAt),
  });
  const current = await readCurrentReleaseState({ store: fixture.store });
  const acceptance = fixture.store.records.find(
    (record) => record.event.eventType === "release-accepted",
  );
  assert.equal(current.snapshot.bootstrapRecovery, null);
  assert.equal(
    current.snapshot.acceptedStandardFloors.pwaLifecycle,
    "prompt-close-all-v1",
  );
  assert.equal(acceptance.event.payload.clearBootstrapRecovery, true);
});

test("fails prompt-close-all bootstrap clearance without recovery PASS or an exact companion projection", async (t) => {
  const promptPolicy = {
    ...releasePolicy,
    initialStandard: standardDimensions("prompt-close-all-v1"),
    targetStandard: standardDimensions("prompt-close-all-v1"),
    phaseSequence: [{ gate: "P1-PWA", change: null }],
  };
  await t.test("missing recovery PASS", async () => {
    const fixture = await initializePromotionFixture({
      pwaLifecycle: "prompt-close-all-v1",
      releasePolicyValue: promptPolicy,
    });
    await runPromotionLifecycle(fixture);
    const evidence = acceptanceEvidence();
    evidence.automatedGates.rollback.status = "FAIL";
    const input = await acceptanceInputOptions({ fixture, evidence });
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => [],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      }),
      /lacks an independent recovery drill/,
    );
  });
  await t.test("mismatched companion projection", async () => {
    const fixture = await initializePromotionFixture({
      pwaLifecycle: "prompt-close-all-v1",
      releasePolicyValue: promptPolicy,
      companionDimensions: {
        ...standardDimensions("prompt-close-all-v1"),
        releaseRole: "containment",
      },
    });
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({
      fixture,
      includeRecoveryDrill: true,
    });
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => [],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      }),
      /does not match the standard policy projection/,
    );
  });
});

test("rejects stale evidence, source tamper, and duplicate acceptance roles", async (t) => {
  await t.test("stale evidence", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => [],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt) + 60 * 60 * 1000,
      }),
      /stale or future-dated/,
    );
  });
  await t.test("source tamper", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const evidence = acceptanceEvidence();
    evidence.release.commitSha = "9".repeat(40);
    const input = await acceptanceInputOptions({ fixture });
    const evidenceBytes = canonicalJsonBytes(evidence);
    await assert.rejects(
      acceptPendingStandardRelease(
        {
          ...input,
          evidenceBytes,
          expectedEvidenceSha256: sha256Bytes(evidenceBytes),
        },
        {
          validateEvidence: () => [],
          collectApprovals: acceptanceCollector,
          clock: () => Date.parse(observationEndedAt),
        },
      ),
      /source\/build differs/,
    );
  });
  await t.test("duplicate role", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => [],
        collectApprovals: async (options) => {
          const result = await acceptanceCollector(options);
          result.approvalRefs[2] = structuredClone(result.approvalRefs[1]);
          return result;
        },
        clock: () => Date.parse(observationEndedAt),
      }),
      /Approval IDs are not distinct|required approval roles/,
    );
  });
  await t.test("minimum sample verifier failure", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => ["minimum sample is not satisfied"],
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      }),
      /minimum sample is not satisfied/,
    );
  });
});

test("fails acceptance closed on a CAS conflict and succeeds on exact retry", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  fixture.store.failCompareAndAppendAt =
    fixture.store.compareAndAppendCalls + 1;
  const options = await acceptanceInputOptions({ fixture });
  await assert.rejects(
    acceptPendingStandardRelease(options, {
      validateEvidence: () => [],
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    }),
    /fixture CAS conflict/,
  );
  fixture.store.failCompareAndAppendAt = null;
  const result = await acceptPendingStandardRelease(options, {
    validateEvidence: () => [],
    collectApprovals: acceptanceCollector,
    clock: () => Date.parse(observationEndedAt),
  });
  assert.equal(result.replayed, false);
});

test("rechecks OIDC authority immediately before the acceptance CAS", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({ fixture });
  let reads = 0;
  await assert.rejects(
    acceptPendingStandardRelease(input, {
      validateEvidence: () => [],
      collectApprovals: async (options) => {
        const collected = await acceptanceCollector(options);
        return {
          ...collected,
          oidcExpiresAt: new Date(
            Date.parse(observationEndedAt) + 30 * 1000,
          ).toISOString(),
        };
      },
      clock: () => {
        reads += 1;
        return (
          Date.parse(observationEndedAt) + (reads === 1 ? 0 : 2 * 60 * 1000)
        );
      },
    }),
    /OIDC authority expired before commit/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, 3);
});
