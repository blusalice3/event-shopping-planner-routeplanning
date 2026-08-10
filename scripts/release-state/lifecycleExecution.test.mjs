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
import { ACCEPTANCE_PERFORMANCE_REQUIREMENTS } from "../lib/performance-evidence-identity.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { PROVIDER_ALIAS_OBSERVATION_KIND } from "./reconcileDecision.mjs";
import { buildAuthoritativeProviderAliasObservation } from "./authoritativeInputProducers.mjs";
import {
  produceCompanionRecoveryDrill,
  produceContinuousProductionProbe,
} from "./acceptanceEvidenceInputs.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  collectContinuousProductionSample,
  collectReleaseAEvidenceAuthority,
  createCompanionRecoverySource,
  initializeContinuousProbeCollection,
} from "./acceptanceEvidenceAuthority.mjs";
import {
  acceptPendingStandardRelease,
  appendReadyReconciliation,
  deriveAcceptedGateForCandidate,
  deriveRollbackInventory,
  preparePendingStandardAcceptanceBundle,
  recordPreparedPromotionAssignment,
  recordPreparedPromotionLifecycle,
  resolveAcceptedStandardAuthority,
  resolvePendingAcceptanceRequirements,
} from "./lifecycleExecution.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
} from "./releaseStateReducer.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "./reviewedWorkflowRunAuthority.mjs";

const namespace = "lifecycle-test";
const sourceSha = "a".repeat(40);
const operationId = "promote-lifecycle-fixture";
const completedAt = "2026-08-06T00:00:00.000Z";
const observationEndedAt = "2026-08-07T00:00:00.000Z";
const phaseExitAttestationReferences = ["1", "2", "3"].map((character) => ({
  uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
  sha256: character.repeat(64),
}));
const phaseExitAttestationSeed = [
  {
    gate: "P0-BASELINE",
    sourceSha,
    subjectKind: "repository-phase-subject/v1",
    attestation: phaseExitAttestationReferences[0],
    predecessor: null,
  },
  {
    gate: "P0-TOOLCHAIN",
    sourceSha,
    subjectKind: "repository-phase-subject/v1",
    attestation: phaseExitAttestationReferences[1],
    predecessor: phaseExitAttestationReferences[0],
  },
  {
    gate: "P0-ARTIFACT",
    sourceSha,
    subjectKind: "disposable-drill-subject/v1",
    attestation: phaseExitAttestationReferences[2],
    predecessor: phaseExitAttestationReferences[1],
  },
];
const dbCompatibilityContract = {
  contractUri: "urn:test:db:v1",
  schemaVersion: 1,
};
const dbCompatibility = {
  contractUri: dbCompatibilityContract.contractUri,
  fingerprint: sha256Json(dbCompatibilityContract),
};
const domains = ["a.example.test", "b.example.test"];
const providerPolicy = {
  bindingStatus: "configured",
  expectedTeamId: "team-test",
  expectedProjectId: "project-test",
  ownedProductionDomains: domains,
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
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

test("advances null-change P6 and P8 gates without collapsing equal floors", () => {
  const policy = {
    ...releasePolicy,
    phaseSequence: [
      { gate: "P5-LIST", change: null },
      { gate: "P6-APP", change: null },
      {
        gate: "P7-IDB",
        change: { persistenceArchitecture: "facade" },
      },
      { gate: "P8-CLEAN", change: null },
    ],
  };
  const initialFloors = Object.fromEntries(
    Object.entries(policy.initialStandard).filter(
      ([key]) => key !== "releaseRole",
    ),
  );
  assert.equal(
    deriveAcceptedGateForCandidate({
      snapshot: {
        acceptedStandard: {},
        acceptedGate: "P5-LIST",
        acceptedStandardFloors: initialFloors,
      },
      releasePolicy: policy,
      candidateGate: "P6-APP",
      candidateFloors: initialFloors,
    }),
    "P6-APP",
  );
  assert.equal(
    deriveAcceptedGateForCandidate({
      snapshot: {
        acceptedStandard: {},
        acceptedGate: "P5-LIST",
        acceptedStandardFloors: initialFloors,
      },
      releasePolicy: policy,
      candidateGate: "P5-LIST",
      candidateFloors: initialFloors,
    }),
    "P5-LIST",
  );
  const p7Floors = {
    ...initialFloors,
    persistenceArchitecture: "facade",
  };
  assert.equal(
    deriveAcceptedGateForCandidate({
      snapshot: {
        acceptedStandard: {},
        acceptedGate: "P7-IDB",
        acceptedStandardFloors: p7Floors,
      },
      releasePolicy: policy,
      candidateGate: "P8-CLEAN",
      candidateFloors: p7Floors,
    }),
    "P8-CLEAN",
  );
  assert.throws(
    () =>
      deriveAcceptedGateForCandidate({
        snapshot: {
          acceptedStandard: {},
          acceptedGate: "P8-CLEAN",
          acceptedStandardFloors: p7Floors,
        },
        releasePolicy: policy,
        candidateGate: "P8-CLEAN",
        candidateFloors: p7Floors,
      }),
    /Terminal P8-CLEAN does not permit a same-floor standard replacement/u,
  );
  assert.throws(
    () =>
      deriveAcceptedGateForCandidate({
        snapshot: {
          acceptedStandard: {},
          acceptedGate: "P5-LIST",
          acceptedStandardFloors: initialFloors,
        },
        releasePolicy: policy,
        candidateGate: "P7-IDB",
        candidateFloors: p7Floors,
      }),
    /exactly one phase gate/,
  );
  assert.throws(
    () =>
      deriveAcceptedGateForCandidate({
        snapshot: {
          acceptedStandard: {},
          acceptedGate: "P7-IDB",
          acceptedStandardFloors: p7Floors,
        },
        releasePolicy: policy,
        candidateGate: "P6-APP",
        candidateFloors: initialFloors,
      }),
    /exactly one phase gate/,
  );
  assert.throws(
    () =>
      deriveAcceptedGateForCandidate({
        snapshot: {
          acceptedStandard: {},
          acceptedGate: "P7-IDB",
          acceptedStandardFloors: p7Floors,
        },
        releasePolicy: policy,
        candidateGate: "P7-IDB",
        candidateFloors: initialFloors,
      }),
    /differs from current accepted floors/,
  );
});
const approvalPolicy = {
  bindingStatus: "configured",
  blockerCodes: [],
  trustedIssuer: "https://token.actions.githubusercontent.com",
  protectedEnvironment: "foundation-release-state",
  humanOperatorModel: "single-human-single-github-account/v1",
  repository: "example/event-shopping-planner",
  workflowRef:
    "example/event-shopping-planner/.github/workflows/release.yml@refs/heads/main",
  roles: {
    releaseOwner: { reviewerTeam: "release-owners" },
    dataSafetyReviewer: { reviewerTeam: "data-safety-reviewers" },
    operationsReviewer: { reviewerTeam: "operations-reviewers" },
  },
  distinctApprovalIds: true,
  distinctProviderReviewerIds: false,
  oidcMaxTokenAgeSeconds: 600,
  oidcClockSkewSeconds: 60,
};

class FakeReleaseStateStore {
  constructor() {
    this.namespace = namespace;
    this.records = [];
    this.evidence = new Map();
    this.acceptanceChains = new Map();
    this.commitAt = completedAt;
    this.failAtomicAppendAfterSample = false;
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

  seedEvent(event, committedAtValue = this.commitAt) {
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
    if (
      existing &&
      (!existing.bytes.equals(objectBytes) || existing.mediaType !== mediaType)
    ) {
      throw new Error("fixture evidence collision");
    }
    if (!existing) {
      this.evidence.set(sha256, {
        bytes: objectBytes,
        mediaType,
        committedAt: this.commitAt,
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

  async appendAcceptanceSample({
    operationId: acceptanceOperationId,
    sourceSha: acceptanceSourceSha,
    bindingId,
    expectedPreviousCommit,
    expectedSequence,
    sampleBytes,
    sampleMediaType,
    commitBytes,
    commitMediaType,
  }) {
    const chainKey = `${acceptanceOperationId}\n${acceptanceSourceSha}\n${bindingId}`;
    const head = this.acceptanceChains.get(chainKey) ?? null;
    const sampleObjectBytes = Buffer.from(sampleBytes);
    const commitObjectBytes = Buffer.from(commitBytes);
    const sampleSha256 = sha256Bytes(sampleObjectBytes);
    const commitSha256 = sha256Bytes(commitObjectBytes);
    const receipt = (sha256, stored, replayed) => ({
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
      mediaType: stored.mediaType,
      byteLength: stored.bytes.length,
      committedAt: stored.committedAt,
      replayed,
    });
    if (
      head?.sequence === expectedSequence + 1 &&
      head.head.sha256 === commitSha256
    ) {
      const storedSample = this.evidence.get(sampleSha256);
      const storedCommit = this.evidence.get(commitSha256);
      if (
        !storedSample?.bytes.equals(sampleObjectBytes) ||
        storedSample.mediaType !== sampleMediaType ||
        !storedCommit?.bytes.equals(commitObjectBytes) ||
        storedCommit.mediaType !== commitMediaType ||
        storedSample.committedAt !== storedCommit.committedAt
      ) {
        throw new Error("fixture acceptance replay differs");
      }
      return {
        sample: receipt(sampleSha256, storedSample, true),
        commit: receipt(commitSha256, storedCommit, true),
      };
    }
    if (
      (head?.sequence ?? 0) !== expectedSequence ||
      (head === null
        ? expectedPreviousCommit !== null
        : head.head.sha256 !== expectedPreviousCommit?.sha256 ||
          head.head.uri !== expectedPreviousCommit?.uri)
    ) {
      throw new Error("fixture acceptance chain CAS conflict");
    }
    if (this.evidence.has(sampleSha256) || this.evidence.has(commitSha256)) {
      throw new Error("fixture acceptance objects predate atomic append");
    }
    const evidenceSnapshot = new Map(this.evidence);
    const chainSnapshot = new Map(this.acceptanceChains);
    try {
      const storedSample = {
        bytes: sampleObjectBytes,
        mediaType: sampleMediaType,
        committedAt: this.commitAt,
      };
      const storedCommit = {
        bytes: commitObjectBytes,
        mediaType: commitMediaType,
        committedAt: this.commitAt,
      };
      this.evidence.set(sampleSha256, storedSample);
      if (this.failAtomicAppendAfterSample) {
        this.failAtomicAppendAfterSample = false;
        throw new Error("fixture acceptance atomic failure");
      }
      this.evidence.set(commitSha256, storedCommit);
      const commit = receipt(commitSha256, storedCommit, false);
      this.acceptanceChains.set(chainKey, {
        sequence: expectedSequence + 1,
        head: { uri: commit.uri, sha256: commit.sha256 },
        updatedAt: commit.committedAt,
      });
      return {
        sample: receipt(sampleSha256, storedSample, false),
        commit,
      };
    } catch (error) {
      this.evidence = evidenceSnapshot;
      this.acceptanceChains = chainSnapshot;
      throw error;
    }
  }

  async readAcceptanceEvidenceChain({
    operationId: acceptanceOperationId,
    sourceSha: acceptanceSourceSha,
    bindingId,
  }) {
    const value = this.acceptanceChains.get(
      `${acceptanceOperationId}\n${acceptanceSourceSha}\n${bindingId}`,
    );
    return value ? structuredClone(value) : null;
  }
}

const putJson = async (store, value, mediaType = "application/json") => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putWorkflowRunAuthority = async (
  store,
  runId = "4000",
  workflowSourceSha = sourceSha,
) => {
  const apiResponse = await putJson(
    store,
    {
      id: Number(runId),
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: workflowSourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: approvalPolicy.repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  return putJson(
    store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository: approvalPolicy.repository,
      runId,
      runAttempt: "1",
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: workflowSourceSha,
      apiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
};

const putAcceptanceCollectorIdentity = async ({
  store,
  observedAt,
  runId,
  collectorSourceSha = sourceSha,
}) => {
  const expiresAt = new Date(
    Date.parse(observedAt) + 15 * 60 * 1000,
  ).toISOString();
  return putJson(
    store,
    {
      schemaVersion: 1,
      kind: "github-actions-oidc-verification/v1",
      issuer: "https://token.actions.githubusercontent.com",
      audience: "release-state",
      subject:
        "repo:example/event-shopping-planner:environment:production-release",
      tokenSha256: sha256Json({ runId, observedAt }),
      signingKey: {
        kid: "lifecycle-fixture",
        jwkThumbprintSha256: "1".repeat(64),
      },
      claims: {
        repository: "example/event-shopping-planner",
        workflowRef:
          "example/event-shopping-planner/.github/workflows/release.yml@refs/heads/main",
        workflowSha: collectorSourceSha,
        environment: "production-release",
        runId,
        runAttempt: "1",
        sourceSha: collectorSourceSha,
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        refProtected: true,
        jti: `lifecycle-acceptance-${runId}`,
        issuedAt: observedAt,
        notBefore: observedAt,
        expiresAt,
      },
      verifiedAt: observedAt,
    },
    GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  );
};

const acceptanceHttpResponse = ({ url, bytes, observedAt }) => ({
  status: 200,
  url,
  redirected: false,
  headers: {
    get(name) {
      const key = name.toLowerCase();
      if (key === "content-length") return String(bytes.length);
      if (key === "content-type") return "application/json; charset=utf-8";
      if (key === "date") return new Date(observedAt).toUTCString();
      return null;
    },
  },
  arrayBuffer: async () => bytes,
});

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
  bindingSourceSha = sourceSha,
  targetGate = "P0-RELEASE",
}) => {
  const packageIndex = await putJson(store, { kind: "package", suffix });
  if (publicIdentityKind === "legacy-bootstrap-v1") {
    const artifactManifest = await putJson(store, {
      kind: "manifest",
      suffix,
    });
    const deploymentUrl = `https://${role}-${suffix}.example.test`;
    const providerEvidence = await putJson(store, {
      schemaVersion: 1,
      providerProjectId: providerPolicy.expectedProjectId,
      providerDeploymentId: `deployment-${role}-${suffix}`,
      deploymentUrl,
      sourceSha: bindingSourceSha,
      variantId: suffix.repeat(64),
      releaseRole: role,
      artifactManifestHash: artifactManifest.sha256,
      packageIndexHash: packageIndex.sha256,
      providerConfigurationHash: configurationHash,
      providerPolicyHash: providerPolicyReference.sha256,
      releasePolicyHash: policyReference.sha256,
      requiredDbCompatibility: dbCompatibility,
      publicIdentity: { identityKind: publicIdentityKind },
      routeProbeEvidenceHash: "5".repeat(64),
      environmentPresenceEvidenceHash: "6".repeat(64),
    });
    const archiveBytes = Buffer.from(`archive:${role}:${suffix}\n`);
    const archiveReceipt = await store.putEvidence({
      bytes: archiveBytes,
      mediaType:
        "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
    });
    const artifactArchive = {
      uri: archiveReceipt.uri,
      sha256: archiveReceipt.sha256,
    };
    const artifactArchiveAvailability = await putJson(
      store,
      {
        schemaVersion: 1,
        evidenceKind: "artifact-archive-availability/v1",
        availability: "available",
        namespace,
        bindingId: `${role}-${suffix}`,
        sourceSha: bindingSourceSha,
        variantId: suffix.repeat(64),
        releaseRole: role,
        artifactManifest,
        artifactArchive: {
          ...artifactArchive,
          mediaType:
            "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
          byteLength: archiveBytes.length,
          committedAt: completedAt,
        },
      },
      "application/vnd.event-shopping-planner.artifact-archive-availability+json;version=1",
    );
    return {
      bindingId: `${role}-${suffix}`,
      sourceSha: bindingSourceSha,
      buildId: bindingSourceSha,
      variantId: suffix.repeat(64),
      releaseRole: role,
      publicIdentityKind,
      providerProjectId: providerPolicy.expectedProjectId,
      providerDeploymentId: `deployment-${role}-${suffix}`,
      deploymentUrl,
      artifactArchive,
      artifactArchiveAvailability,
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
          sourceSha: bindingSourceSha,
          buildId: bindingSourceSha,
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
          sourceSha: bindingSourceSha,
          buildId: bindingSourceSha,
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
    role === "standard" ? "src/index.tsx" : "src/pwa/containment/index.ts";
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha: bindingSourceSha,
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
  const buildAuthority = await putJson(store, {
    schemaVersion: 1,
    requirementsKind: "artifact-build-requirements/v1",
    operationId: `build-${role}-${suffix}`,
    targetGate,
  });
  const manifest = {
    schemaVersion: 1,
    sourceSha: bindingSourceSha,
    buildId: bindingSourceSha,
    variantId,
    releaseRole: role,
    dimensions,
    buildAuthority,
    targetGate,
    buildPurpose: "production",
    promotable: true,
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
    sourceSha: bindingSourceSha,
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
  const archiveBytes = Buffer.from(`archive:${role}:${suffix}\n`);
  const archiveReceipt = await store.putEvidence({
    bytes: archiveBytes,
    mediaType:
      "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
  });
  const artifactArchive = {
    uri: archiveReceipt.uri,
    sha256: archiveReceipt.sha256,
  };
  const artifactArchiveAvailability = await putJson(
    store,
    {
      schemaVersion: 1,
      evidenceKind: "artifact-archive-availability/v1",
      namespace,
      bindingId: `${role}-${suffix}`,
      sourceSha: bindingSourceSha,
      variantId,
      releaseRole: role,
      artifactManifest,
      artifactArchive: {
        ...artifactArchive,
        mediaType:
          "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
        byteLength: archiveBytes.length,
        committedAt: completedAt,
      },
      availability: "available",
    },
    "application/vnd.event-shopping-planner.artifact-archive-availability+json;version=1",
  );
  return {
    bindingId: `${role}-${suffix}`,
    sourceSha: bindingSourceSha,
    buildId: bindingSourceSha,
    variantId,
    releaseRole: role,
    publicIdentityKind,
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: `deployment-${role}-${suffix}`,
    deploymentUrl,
    packageIndex,
    artifactManifest,
    artifactArchive,
    artifactArchiveAvailability,
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
  approvalOperationId = operationId,
  approvedAt = completedAt,
}) => {
  const issuer = await putJson(store, {
    kind: "issuer",
    operationId: approvalOperationId,
    index,
  });
  const receipt = await putJson(store, {
    kind: "approval",
    operationId: approvalOperationId,
    role,
    index,
  });
  return {
    uri: receipt.uri,
    sha256: receipt.sha256,
    approvalId: `approval-${index}`,
    operationId: approvalOperationId,
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
  operationKind = "promote-standard",
  fixtureOperationId = operationId,
  fixtureSourceSha = sourceSha,
  targetGate = "P0-RELEASE",
  bootstrapSuffix = "b",
  targetSuffix = "c",
  companionSuffix = "e",
  operationTargetOverride = null,
  operationCompanionOverride = null,
  operationOriginOverride = null,
  operationOriginCompanionOverride = null,
  existingStore = null,
  withRecoveryHistory = false,
} = {}) => {
  if (withRecoveryHistory && existingStore === null) {
    const recoveryFixture = await initializePromotionFixture({
      pwaLifecycle,
      companionDimensions,
      releasePolicyValue,
      operationKind: "redeploy-containment",
      fixtureOperationId: "independent-companion-recovery",
      fixtureSourceSha,
      targetGate,
      bootstrapSuffix,
      targetSuffix,
      companionSuffix,
    });
    await runPromotionLifecycle(recoveryFixture);
    const recoveryTerminalRecord = recoveryFixture.store.records.find(
      (record) =>
        record.event.eventType === "package-redeploy-activated" &&
        record.event.operationId === "independent-companion-recovery",
    );
    assert.ok(recoveryTerminalRecord);
    const standardFixture = await initializePromotionFixture({
      pwaLifecycle,
      companionDimensions,
      releasePolicyValue,
      fixtureOperationId,
      fixtureSourceSha,
      targetGate,
      bootstrapSuffix,
      targetSuffix,
      companionSuffix,
      existingStore: recoveryFixture.store,
    });
    return { ...standardFixture, recoveryTerminalRecord };
  }
  const store = existingStore ?? new FakeReleaseStateStore();
  store.commitAt = completedAt;
  const policyReference = await putJson(store, releasePolicyValue);
  const providerPolicyReference = await putJson(
    store,
    providerPolicy,
    "application/vnd.event-shopping-planner.provider-policy+json;version=1",
  );
  const configurationHash = providerConfigurationHash(
    providerObservation("stable"),
  );
  const bootstrap = await createBinding({
    store,
    role: "containment",
    suffix: bootstrapSuffix,
    policyReference,
    providerPolicyReference,
    configurationHash,
    publicIdentityKind: "legacy-bootstrap-v1",
    bindingSourceSha: fixtureSourceSha,
  });
  if (store.records.length === 0) {
    const initialEvidence = await putJson(store, { kind: "initial" });
    const initial = createReleaseEvent({
      namespace,
      sequence: 1,
      eventType: "state-initialized",
      operationId: "initialize",
      previousEventHash: null,
      payload: {
        acceptedGate: null,
        executorSourceSha: fixtureSourceSha,
        legacyObservedProduction: {
          observationUri: initialEvidence.uri,
          observationSha256: initialEvidence.sha256,
        },
        bootstrapRecovery: bootstrap,
        minimumSafetyFloors: { releaseChannel: "release-a" },
        currentDbCompatibility: dbCompatibility,
        activeReleasePolicy: policyReference,
        phaseExitAttestationSeed,
      },
      evidenceRefs: [initialEvidence, ...phaseExitAttestationReferences],
    });
    store.seedEvent(initial);
  }
  const targetBinding = await createBinding({
    store,
    role: "standard",
    suffix: targetSuffix,
    policyReference,
    providerPolicyReference,
    configurationHash,
    dimensions: standardDimensions(pwaLifecycle),
    releasePolicyValue,
    bindingSourceSha: fixtureSourceSha,
    targetGate,
  });
  const projectedCompanionDimensions = projectContainmentDimensions(
    releasePolicyValue,
    standardDimensions(pwaLifecycle),
  );
  const companionBinding = await createBinding({
    store,
    role: "containment",
    suffix: companionSuffix,
    policyReference,
    providerPolicyReference,
    configurationHash,
    dimensions: companionDimensions ?? projectedCompanionDimensions,
    releasePolicyValue,
    bindingSourceSha: fixtureSourceSha,
    targetGate,
  });
  const operationTarget =
    operationTargetOverride ??
    (operationKind.includes("containment") ? companionBinding : targetBinding);
  const operationCompanion =
    operationCompanionOverride ??
    (operationKind.includes("containment") ? null : companionBinding);
  const subjectReference = await putJson(store, {
    kind: "promotion-subject",
    operationId: fixtureOperationId,
  });
  const subjectSha256 = subjectReference.sha256;
  const approvals = [
    await createApprovalReference({
      store,
      role: "releaseOwner",
      index: 1,
      subjectSha256,
      approvalOperationId: fixtureOperationId,
    }),
    await createApprovalReference({
      store,
      role: "dataSafetyReviewer",
      index: 2,
      subjectSha256,
      approvalOperationId: fixtureOperationId,
    }),
  ];
  const current = await readCurrentReleaseState({ store });
  const pendingOperation = {
    operationId: fixtureOperationId,
    kind: operationKind,
    expectedState: structuredClone(current.head),
    targetBinding: operationTarget,
    originBinding:
      operationOriginOverride ??
      (operationKind === "redeploy-containment" ? bootstrap : null),
    originCompanionBinding: operationOriginCompanionOverride,
    companionBinding: operationCompanion,
    previousBinding: current.snapshot.activeProduction,
    emergencyRecoveryBinding:
      current.snapshot.containmentCompanion ?? bootstrap,
    approvalRefs: approvals,
    preparedAt: completedAt,
  };
  const preparedEvent = createReleaseEvent({
    namespace,
    sequence: current.snapshot.sequence + 1,
    eventType: "promotion-prepared",
    operationId: fixtureOperationId,
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
    targetDeploymentId:
      current.snapshot.activeProduction?.providerDeploymentId ??
      operationTarget.providerDeploymentId,
  });
  const after = domainObservation({
    phase: "after",
    targetDeploymentId: operationTarget.providerDeploymentId,
  });
  const beforeProvider = providerObservation("before");
  const afterProvider = providerObservation("after");
  const assignmentEvidence = {
    schemaVersion: 1,
    evidenceKind: "assignment-receipt",
    providerProjectId: providerPolicy.expectedProjectId,
    assignments: domains.map((productionDomain) => ({
      productionDomain,
      previousDeploymentId:
        current.snapshot.activeProduction?.providerDeploymentId ??
        operationTarget.providerDeploymentId,
      assignedDeploymentId: operationTarget.providerDeploymentId,
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
      targetDeploymentId: operationTarget.providerDeploymentId,
    })}`,
    completedAt,
    preparedEvent: {
      uri: preparedResult.eventUri,
      sha256: preparedResult.eventHash,
      sequence: preparedEvent.sequence,
      operationId: fixtureOperationId,
      committedAt: completedAt,
    },
    sourceSha: fixtureSourceSha,
    target: {
      bindingId: operationTarget.bindingId,
      releaseRole: operationTarget.releaseRole,
      providerDeploymentId: operationTarget.providerDeploymentId,
      deploymentUrl: operationTarget.deploymentUrl,
      providerDeploymentEvidenceSha256: operationTarget.providerEvidence.sha256,
    },
    companion:
      operationCompanion === null
        ? null
        : {
            bindingId: operationCompanion.bindingId,
            releaseRole: "containment",
            providerDeploymentId: operationCompanion.providerDeploymentId,
            providerDeploymentEvidenceSha256:
              operationCompanion.providerEvidence.sha256,
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
    targetBindingId: operationTarget.bindingId,
  });
  const assignmentAuthority = {
    schemaVersion: 1,
    evidenceKind: "production-assignment-authority/v1",
    namespace,
    preparedResultSha256: sha256Bytes(canonicalJsonBytes(preparedResult)),
    targetBindingId: operationTarget.bindingId,
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: operationTarget.providerDeploymentId,
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
    productionReceipt(operationTarget.deploymentUrl, path),
  );
  const productionProbe = {
    schemaVersion: 1,
    evidenceKind: "production-assignment-probe/v1",
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: operationTarget.providerDeploymentId,
    providerDeploymentEvidenceHash: operationTarget.providerEvidence.sha256,
    immutableRouteProbeEvidenceHash: "5".repeat(64),
    providerAssignmentObservation,
    observedAt: completedAt,
    immutableApiReceipts,
    results: domains.map((productionDomain) => ({
      productionDomain,
      providerDeploymentId: operationTarget.providerDeploymentId,
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
    releasePolicy: releasePolicyValue,
    fixtureOperationId,
    fixtureSourceSha,
    targetGate,
    bootstrap,
    targetBinding,
    operationTarget,
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

const buildProviderReconciliation = async ({ store, observedBinding }) =>
  buildAuthoritativeProviderAliasObservation(
    {
      store,
      namespace,
      providerToken: "v".repeat(20),
    },
    {
      now: () => Date.parse(completedAt),
      collectAssignments: async ({ domains: ownedDomains }) =>
        ownedDomains.map((productionDomain) => {
          const bodyBytes = Buffer.from(
            JSON.stringify({
              alias: productionDomain,
              projectId: observedBinding.providerProjectId,
              deploymentId: observedBinding.providerDeploymentId,
            }),
          );
          const requestUrl =
            `https://api.vercel.com/v4/aliases/${encodeURIComponent(productionDomain)}` +
            `?teamId=${providerPolicy.expectedTeamId}`;
          return {
            productionDomain,
            providerProjectId: observedBinding.providerProjectId,
            providerDeploymentId: observedBinding.providerDeploymentId,
            requestUrl,
            responseUrl: requestUrl,
            status: 200,
            providerDate: completedAt,
            bodyBytes,
            responseSha256: sha256Bytes(bodyBytes),
          };
        }),
    },
  );

const appendReconciliation = (options, dependencies = {}) =>
  appendReadyReconciliation(options, {
    clock: () => Date.parse(completedAt),
    ...dependencies,
  });

const acceptanceEvidence = (
  evidenceSourceSha = sourceSha,
  evidenceOperationId = operationId,
) => ({
  schemaVersion: "release-a-evidence/v1",
  release: {
    releaseId: evidenceOperationId,
    commitSha: evidenceSourceSha,
  },
  canary: {
    buildSha: evidenceSourceSha,
    startedAt: completedAt,
    endedAt: observationEndedAt,
  },
  automatedGates: {
    rollback: {
      status: "PASS",
      command: "npm run test:release-a-rollback",
      commitSha: evidenceSourceSha,
      completedAt,
      evidenceRef: "artifact://release-a/rollback-recovery-drill",
    },
  },
});

const collectContinuousAcceptanceEvidence = async ({
  fixture,
  current,
  pendingAcceptance,
  evidenceBytes,
  expectedEvidenceSha256,
  rollbackTerminalEvent = null,
}) => {
  const store = fixture.store;
  const binding = pendingAcceptance.standardBinding;
  store.commitAt = completedAt;
  const initializationIdentity = await putAcceptanceCollectorIdentity({
    store,
    observedAt: completedAt,
    runId: "1000",
    collectorSourceSha: binding.sourceSha,
  });
  let source = (
    await initializeContinuousProbeCollection({
      store,
      namespace,
      pendingAcceptance,
      collectorIdentity: initializationIdentity,
    })
  ).source;
  for (let index = 0; index < 289; index += 1) {
    const observedAt = new Date(
      Date.parse(completedAt) + index * 5 * 60 * 1000,
    ).toISOString();
    store.commitAt = observedAt;
    const collectorIdentity = await putAcceptanceCollectorIdentity({
      store,
      observedAt,
      runId: String(2000 + index),
      collectorSourceSha: binding.sourceSha,
    });
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const providerLookup = parsed.hostname === "api.vercel.com";
      const productionDomain = providerLookup
        ? decodeURIComponent(parsed.pathname.split("/").at(-1))
        : parsed.hostname;
      const bytes = providerLookup
        ? canonicalJsonBytes({
            alias: productionDomain,
            projectId: binding.providerProjectId,
            deploymentId: binding.providerDeploymentId,
            redirect: null,
          })
        : canonicalJsonBytes({
            schemaVersion: 1,
            sourceSha: binding.sourceSha,
            buildId: binding.buildId,
            variantId: binding.variantId,
            releaseRole: binding.releaseRole,
          });
      return acceptanceHttpResponse({ url, bytes, observedAt });
    };
    source = (
      await collectContinuousProductionSample({
        store,
        namespace,
        pendingAcceptance,
        providerPolicy,
        providerToken: "provider-token-fixture",
        collectorIdentity,
        priorSource: source,
        fetchImpl,
        clock: () => Date.parse(observedAt),
      })
    ).source;
  }
  store.commitAt = observationEndedAt;
  const authorityCollectorIdentity = await putAcceptanceCollectorIdentity({
    store,
    observedAt: observationEndedAt,
    runId: "3000",
    collectorSourceSha: binding.sourceSha,
  });
  const evidenceUrl =
    "https://observability.example.test/release-a-evidence.json";
  const finalized = await collectReleaseAEvidenceAuthority({
    store,
    current,
    namespace,
    pendingAcceptance,
    providerPolicy,
    evidenceUrl,
    evidenceToken: "observability-token-fixture",
    collectorIdentity: authorityCollectorIdentity,
    continuousSource: source,
    rollbackTerminalEvent,
    validateEvidence: () => [],
    fetchImpl: async (url) =>
      acceptanceHttpResponse({
        url,
        bytes: evidenceBytes,
        observedAt: observationEndedAt,
      }),
    clock: () => Date.parse(observationEndedAt),
  });
  const sourceBytes = canonicalJsonBytes(finalized.continuousSource);
  const sourceWorkflowAuthority = await putWorkflowRunAuthority(
    store,
    "4000",
    binding.sourceSha,
  );
  const produced = await produceContinuousProductionProbe({
    store,
    current,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes: evidenceBytes,
    expectedReleaseAEvidenceSha256: expectedEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    sourceWorkflowAuthority,
    approvalPolicy,
    providerPolicy,
    nowMilliseconds: Date.parse(observationEndedAt),
  });
  return {
    ...produced,
    authorityBundle: finalized.authority.reference,
  };
};

const acceptanceInputOptions = async ({
  fixture,
  evidence = null,
  includeRecoveryDrill = false,
  collectApprovals = acceptanceCollector,
  prepareClock = () => Date.parse(observationEndedAt),
}) => {
  const current = await readCurrentReleaseState({ store: fixture.store });
  const pendingAcceptance = current.snapshot.pendingAcceptance;
  const effectiveEvidence =
    evidence ??
    acceptanceEvidence(
      pendingAcceptance.standardBinding.sourceSha,
      pendingAcceptance.operationId,
    );
  const evidenceBytes = canonicalJsonBytes(effectiveEvidence);
  const expectedEvidenceSha256 = sha256Bytes(evidenceBytes);
  const acceptanceRequirements = await resolvePendingAcceptanceRequirements({
    store: fixture.store,
  });
  const acceptedGate = acceptanceRequirements.acceptedGate;
  const performanceRequirement =
    ACCEPTANCE_PERFORMANCE_REQUIREMENTS[acceptedGate];
  let performanceEvidenceBytes = null;
  if (performanceRequirement !== null) {
    if (performanceRequirement === "performance-inherited-closure/v1") {
      const closure = {
        kind: performanceRequirement,
        p8Source: {
          gitCommitSha: pendingAcceptance.standardBinding.sourceSha,
        },
      };
      performanceEvidenceBytes = canonicalJsonBytes({
        schemaVersion: 1,
        closure,
        closureSha256: sha256Json(closure),
      });
    } else {
      const performanceEvidenceBody = {
        evidenceKind: "foundation-performance-evidence/v1",
        gate: performanceRequirement,
        collectedAtUtc: completedAt,
        source: {
          gitCommitSha: pendingAcceptance.standardBinding.sourceSha,
          sourceClosureSha256: "9".repeat(64),
          treeState: "clean",
          artifactSha256:
            pendingAcceptance.standardBinding.artifactArchive.sha256,
        },
      };
      const performanceEnvelope = {
        schemaVersion: 1,
        evidence: performanceEvidenceBody,
        evidenceSha256: sha256Json(performanceEvidenceBody),
      };
      const performanceRequirements = acceptanceRequirements;
      const producerReceiptBody = {
        kind: "own-gate-performance-evidence-producer-receipt/v1",
        namespace,
        operationId: pendingAcceptance.operationId,
        acceptedGate,
        performanceGate: performanceRequirement,
        source: {
          gitCommitSha: pendingAcceptance.standardBinding.sourceSha,
          sourceClosureSha256: "9".repeat(64),
          treeState: "clean",
        },
        authoritativeState: structuredClone(current.head),
        requirementsSha256: sha256Json(performanceRequirements),
        artifactArchiveSha256:
          pendingAcceptance.standardBinding.artifactArchive.sha256,
        rawSamplesArtifact: {
          name:
            "foundation-performance-raw-samples-" +
            `${pendingAcceptance.standardBinding.sourceSha}-1`,
          runId: "100",
          runAttempt: "1",
          sha256: "8".repeat(64),
          collectorIdentity: {
            uri: `release-state://${namespace}/evidence/${"a".repeat(64)}`,
            sha256: "a".repeat(64),
          },
          workflowRunAuthority: {
            uri: `release-state://${namespace}/evidence/${"b".repeat(64)}`,
            sha256: "b".repeat(64),
          },
        },
        producerRunId: "150",
        producerRunAttempt: "1",
        performanceEvidence: {
          name:
            "foundation-performance-own-gate-evidence-" +
            `${pendingAcceptance.standardBinding.sourceSha}-1`,
          envelopeSha256: sha256Bytes(canonicalJsonBytes(performanceEnvelope)),
          evidenceSha256: performanceEnvelope.evidenceSha256,
        },
        producedAtUtc: new Date(Date.parse(completedAt) + 1000).toISOString(),
      };
      performanceEvidenceBytes = canonicalJsonBytes({
        ...performanceEnvelope,
        producerReceipt: {
          schemaVersion: 1,
          receipt: producerReceiptBody,
          receiptSha256: sha256Json(producerReceiptBody),
        },
      });
    }
  }
  const recoveryTerminalEvent = fixture.recoveryTerminalRecord
    ? {
        uri:
          `release-state://${namespace}/events/` +
          `${fixture.recoveryTerminalRecord.sequence}/` +
          fixture.recoveryTerminalRecord.eventHash,
        sha256: fixture.recoveryTerminalRecord.eventHash,
      }
    : null;
  const continuous = await collectContinuousAcceptanceEvidence({
    fixture,
    current,
    pendingAcceptance,
    evidenceBytes,
    expectedEvidenceSha256,
    rollbackTerminalEvent:
      includeRecoveryDrill && recoveryTerminalEvent !== null
        ? recoveryTerminalEvent
        : null,
  });
  const options = {
    store: fixture.store,
    evidenceBytes,
    expectedEvidenceSha256,
    performanceEvidenceBytes,
    expectedPerformanceEvidenceSha256:
      performanceEvidenceBytes === null
        ? null
        : sha256Bytes(performanceEvidenceBytes),
    continuousProbeBytes: continuous.evidenceBytes,
    expectedContinuousProbeSha256: continuous.sha256,
    approvalPolicy,
    expectedRunId: "200",
  };
  if (includeRecoveryDrill && recoveryTerminalEvent !== null) {
    const recoverySource = createCompanionRecoverySource({
      current,
      namespace,
      pendingAcceptance,
      authorityBundle: continuous.authorityBundle,
      terminalEventSha256: recoveryTerminalEvent.sha256,
    });
    const recoverySourceBytes = canonicalJsonBytes(recoverySource);
    const recovery = await produceCompanionRecoveryDrill({
      store: fixture.store,
      current,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes: evidenceBytes,
      expectedReleaseAEvidenceSha256: expectedEvidenceSha256,
      sourceBytes: recoverySourceBytes,
      expectedSourceSha256: sha256Bytes(recoverySourceBytes),
      sourceWorkflowAuthority: continuous.evidence.sourceWorkflowAuthority,
      approvalPolicy,
      nowMilliseconds: Date.parse(observationEndedAt),
      futureClockSkewSeconds: 30,
      providerPolicy,
    });
    options.companionRecoveryDrillBytes = recovery.evidenceBytes;
    options.expectedCompanionRecoveryDrillSha256 = recovery.sha256;
  }
  const prepared = await preparePendingStandardAcceptanceBundle(
    {
      ...options,
      dbCompatibilityContractBytes: canonicalJsonBytes(dbCompatibilityContract),
    },
    {
      validateEvidence: () => [],
      validatePerformanceEvidence: async () => ({ errors: [] }),
      collectApprovals,
      clock: prepareClock,
    },
  );
  return {
    ...options,
    terminalBundleBytes: prepared.bundleBytes,
    expectedTerminalBundleSha256: prepared.bundleSha256,
    terminalObjectSetBytes: prepared.objectSetBytes,
    expectedTerminalObjectSetSha256: prepared.objectSetSha256,
  };
};

const acceptanceCollector = async ({
  store,
  operationId: boundOperationId,
  subjectSha256,
  expectedSourceSha,
  observedThrough,
}) => {
  const expiresAt = new Date(
    Date.parse(observedThrough) + 10 * 60 * 1000,
  ).toISOString();
  const issuer = await putJson(store, {
    schemaVersion: 1,
    kind: "github-actions-oidc-verification/v1",
    issuer: approvalPolicy.trustedIssuer,
    verifiedAt: observedThrough,
    claims: {
      sourceSha: expectedSourceSha,
      runId: "200",
      environment: approvalPolicy.protectedEnvironment,
      repository: approvalPolicy.repository,
      workflowRef: approvalPolicy.workflowRef,
      expiresAt,
    },
  });
  const approvalRefs = [];
  for (const [role, index] of [
    ["releaseOwner", 1],
    ["dataSafetyReviewer", 2],
    ["operationsReviewer", 3],
  ]) {
    const approvalId = `acceptance-${index}`;
    const providerReviewerId = "shared-acceptance-reviewer";
    const receipt = await putJson(store, {
      schemaVersion: 1,
      kind: "github-protected-environment-approval/v1",
      approvalId,
      operationId: boundOperationId,
      decision: "APPROVED",
      providerReviewerId,
      providerReviewerTeamIds: [approvalPolicy.roles[role].reviewerTeam],
      workflowRunId: "200",
      protectedEnvironment: approvalPolicy.protectedEnvironment,
      approvedAt: observedThrough,
      role,
      subjectSha256,
    });
    approvalRefs.push({
      uri: receipt.uri,
      sha256: receipt.sha256,
      approvalId,
      operationId: boundOperationId,
      subjectSha256,
      trustedIssuer: approvalPolicy.trustedIssuer,
      issuerReceiptUri: issuer.uri,
      issuerReceiptSha256: issuer.sha256,
      workflowRunId: "200",
      protectedEnvironment: approvalPolicy.protectedEnvironment,
      providerReviewerId,
      role,
      decision: "APPROVED",
      approvedAt: observedThrough,
    });
  }
  return {
    approvalRefs,
    issuerReceiptReference: issuer,
    oidcExpiresAt: expiresAt,
    verifiedAt: observedThrough,
  };
};

test("appends a ready reconcile plan once and replays the deterministic event", async () => {
  const fixture = await initializePromotionFixture();
  const { decision } = await buildProviderReconciliation({
    store: fixture.store,
    observedBinding: fixture.targetBinding,
  });
  await assert.rejects(
    appendReconciliation(
      {
        store: fixture.store,
        decision,
      },
      {
        clock: () => Date.parse(completedAt) + 24 * 60 * 60 * 1000,
      },
    ),
    /Provider alias receipt binding is invalid/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, 0);
  const first = await appendReconciliation({
    store: fixture.store,
    decision,
  });
  const calls = fixture.store.compareAndAppendCalls;
  const replay = await appendReconciliation({
    store: fixture.store,
    decision,
  });
  const tamperedRetry = structuredClone(decision);
  tamperedRetry.eventPlan.expectedState.eventHash = "0".repeat(64);
  await assert.rejects(
    appendReconciliation({
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

test("rejects a fresh target reconciliation terminal-type substitution before the first CAS", async () => {
  const fixture = await initializePromotionFixture({
    operationKind: "activate-containment",
    fixtureOperationId: "reconcile-target-terminal-substitution",
  });
  const produced = await buildProviderReconciliation({
    store: fixture.store,
    observedBinding: fixture.operationTarget,
  });
  assert.equal(
    produced.decision.terminalPlan.eventType,
    "containment-activated",
  );
  const substitutedDecision = structuredClone(produced.decision);
  substitutedDecision.terminalPlan.eventType = "operation-aborted";

  await assert.rejects(
    appendReconciliation({
      store: fixture.store,
      decision: substitutedDecision,
    }),
    /terminal event type differs from replayed operation authority/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, 0);
  assert.equal(
    fixture.store.records.some(
      ({ event }) => event.eventType === "state-reconciled",
    ),
    false,
  );
});

test("never appends a blocked reconcile decision", async () => {
  const fixture = await initializePromotionFixture();
  const result = await appendReconciliation({
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

test("rejects a reconcile decision whose observation has the wrong immutable media type", async () => {
  const fixture = await initializePromotionFixture();
  const providerReceipt = await putJson(fixture.store, {
    kind: "provider-receipt",
  });
  const providerObservation = await putJson(fixture.store, {
    schemaVersion: 1,
    observationKind: PROVIDER_ALIAS_OBSERVATION_KIND,
    namespace,
    providerProjectId: fixture.targetBinding.providerProjectId,
    assignments: [
      {
        productionDomain: domains[0],
        assignedDeploymentId: fixture.targetBinding.providerDeploymentId,
      },
    ],
    observedBinding: fixture.targetBinding,
    providerReceiptReferences: [providerReceipt],
  });
  const current = await readCurrentReleaseState({ store: fixture.store });
  await assert.rejects(
    appendReconciliation({
      store: fixture.store,
      decision: {
        status: "ready",
        operationId,
        observationSha256: providerObservation.sha256,
        terminalPlan: null,
        eventPlan: {
          eventType: "state-reconciled",
          operationId,
          expectedState: current.head,
          payload: {
            reconciliationKind: "provider-target-assigned/v1",
            observedBinding: fixture.targetBinding,
            providerObservation,
          },
          evidenceRefs: [providerObservation, providerReceipt],
        },
      },
    }),
    /provider observation authority is invalid/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, 0);
});

test("reconciles a verified bootstrap emergency through assignment validation and a six-hour terminal", async () => {
  const fixture = await initializePromotionFixture();
  const produced = await buildProviderReconciliation({
    store: fixture.store,
    observedBinding: fixture.bootstrap,
  });
  const decision = structuredClone(produced.decision);
  decision.terminalPlan.payload.activatedAt = "2099-01-01T00:00:00.000Z";
  decision.terminalPlan.payload.recoveryDeadline = "2099-01-01T06:00:00.000Z";
  const first = await appendReconciliation({
    store: fixture.store,
    decision,
  });
  const calls = fixture.store.compareAndAppendCalls;
  const replay = await appendReconciliation({
    store: fixture.store,
    decision,
  });
  const finalState = await readCurrentReleaseState({ store: fixture.store });
  assert.equal(
    first.terminalEvent.eventType,
    "temporary-containment-activated",
  );
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.store.compareAndAppendCalls, calls);
  assert.equal(finalState.snapshot.pendingOperation, null);
  assert.equal(
    finalState.snapshot.activeProduction.bindingId,
    fixture.bootstrap.bindingId,
  );
  assert.equal(
    finalState.snapshot.containmentIncident.activatedAt,
    completedAt,
  );
  assert.equal(
    Date.parse(finalState.snapshot.containmentIncident.recoveryDeadline) -
      Date.parse(finalState.snapshot.containmentIncident.activatedAt),
    6 * 60 * 60 * 1000,
  );
});

test("reconciles rollback previous as a no-op abort and target as an atomic inventory swap", async () => {
  const firstFixture = await initializePromotionFixture();
  await runPromotionLifecycle(firstFixture);
  await acceptPendingStandardRelease(
    await acceptanceInputOptions({ fixture: firstFixture }),
    {
      validateEvidence: () => [],
      validatePerformanceEvidence: async () => ({ errors: [] }),
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    },
  );
  const secondSourceSha = "b".repeat(40);
  const secondFixture = await initializePromotionFixture({
    fixtureOperationId: "reconcile-source-b",
    fixtureSourceSha: secondSourceSha,
    bootstrapSuffix: "6",
    targetSuffix: "7",
    companionSuffix: "8",
    existingStore: firstFixture.store,
  });
  await runPromotionLifecycle(secondFixture);
  await acceptPendingStandardRelease(
    await acceptanceInputOptions({ fixture: secondFixture }),
    {
      validateEvidence: () => [],
      validatePerformanceEvidence: async () => ({ errors: [] }),
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    },
  );

  const appendRollbackReconciliation = async ({
    operationId: reconciliationOperationId,
    observedBinding,
  }) => {
    const produced = await buildProviderReconciliation({
      store: secondFixture.store,
      observedBinding,
    });
    assert.equal(produced.decision.operationId, reconciliationOperationId);
    return {
      decision: produced.decision,
      result: await appendReconciliation({
        store: secondFixture.store,
        decision: produced.decision,
      }),
    };
  };

  const abortedFixture = await initializePromotionFixture({
    operationKind: "rollback-standard",
    fixtureOperationId: "reconcile-rollback-previous",
    fixtureSourceSha: firstFixture.targetBinding.sourceSha,
    bootstrapSuffix: "9",
    targetSuffix: "a",
    companionSuffix: "b",
    operationTargetOverride: firstFixture.targetBinding,
    operationCompanionOverride: firstFixture.companionBinding,
    existingStore: secondFixture.store,
  });
  const { result: aborted } = await appendRollbackReconciliation({
    operationId: abortedFixture.fixtureOperationId,
    observedBinding: secondFixture.targetBinding,
  });
  let current = await readCurrentReleaseState({ store: secondFixture.store });
  assert.equal(aborted.terminalEvent.eventType, "operation-aborted");
  assert.equal(
    current.snapshot.acceptedStandard?.bindingId,
    secondFixture.targetBinding.bindingId,
  );
  assert.deepEqual(
    current.snapshot.rollbackInventory.map((entry) => entry.binding.bindingId),
    [firstFixture.targetBinding.bindingId],
  );

  const activatedFixture = await initializePromotionFixture({
    operationKind: "rollback-standard",
    fixtureOperationId: "reconcile-rollback-target",
    fixtureSourceSha: firstFixture.targetBinding.sourceSha,
    bootstrapSuffix: "c",
    targetSuffix: "d",
    companionSuffix: "e",
    operationTargetOverride: firstFixture.targetBinding,
    operationCompanionOverride: firstFixture.companionBinding,
    existingStore: secondFixture.store,
  });
  current = await readCurrentReleaseState({ store: secondFixture.store });
  const targetAuthority = current.snapshot.rollbackInventory.find(
    (entry) => entry.binding.bindingId === firstFixture.targetBinding.bindingId,
  );
  assert.ok(targetAuthority);
  const { decision: activatedDecision, result: activated } =
    await appendRollbackReconciliation({
      operationId: activatedFixture.fixtureOperationId,
      observedBinding: firstFixture.targetBinding,
    });
  const appendCalls = secondFixture.store.compareAndAppendCalls;
  const activatedReplay = await appendReconciliation({
    store: secondFixture.store,
    decision: activatedDecision,
  });
  const abortSubstitution = structuredClone(activatedDecision);
  abortSubstitution.terminalPlan = {
    eventType: "operation-aborted",
    targetBinding: structuredClone(firstFixture.targetBinding),
    payload: {},
    approvalRefs: [],
  };
  await assert.rejects(
    appendReconciliation({
      store: secondFixture.store,
      decision: abortSubstitution,
    }),
    /terminal event type differs from replayed operation authority/,
  );
  current = await readCurrentReleaseState({ store: secondFixture.store });
  assert.equal(activated.terminalEvent.eventType, "rollback-activated");
  assert.equal(activatedReplay.replayed, true);
  assert.equal(secondFixture.store.compareAndAppendCalls, appendCalls);
  assert.equal(
    current.snapshot.acceptedStandard?.bindingId,
    firstFixture.targetBinding.bindingId,
  );
  assert.deepEqual(
    current.snapshot.rollbackInventory.map((entry) => entry.binding.bindingId),
    [secondFixture.targetBinding.bindingId],
  );
  assert.deepEqual(
    activated.terminalEvent.payload.rollbackInventory,
    current.snapshot.rollbackInventory,
  );

  const redeployFixture = await initializePromotionFixture({
    operationKind: "redeploy-standard",
    fixtureOperationId: "reconcile-redeploy-current",
    fixtureSourceSha: firstFixture.targetBinding.sourceSha,
    bootstrapSuffix: "f",
    targetSuffix: "0",
    companionSuffix: "1",
    operationOriginOverride: firstFixture.targetBinding,
    operationOriginCompanionOverride: firstFixture.companionBinding,
    existingStore: secondFixture.store,
  });
  current = await readCurrentReleaseState({ store: secondFixture.store });
  const unrelatedBeforeRedeploy = current.snapshot.rollbackInventory.find(
    (entry) =>
      entry.binding.bindingId === secondFixture.targetBinding.bindingId,
  );
  assert.ok(unrelatedBeforeRedeploy);
  assert.equal(
    current.snapshot.rollbackInventory.some(
      (entry) =>
        entry.binding.bindingId === firstFixture.targetBinding.bindingId,
    ),
    false,
  );
  const { result: redeployed } = await appendRollbackReconciliation({
    operationId: redeployFixture.fixtureOperationId,
    observedBinding: redeployFixture.targetBinding,
  });
  current = await readCurrentReleaseState({ store: secondFixture.store });
  assert.equal(
    current.snapshot.acceptedStandard?.bindingId,
    redeployFixture.targetBinding.bindingId,
  );
  assert.deepEqual(
    current.snapshot.rollbackInventory.find(
      (entry) =>
        entry.binding.bindingId === secondFixture.targetBinding.bindingId,
    ),
    unrelatedBeforeRedeploy,
  );
  const redeployedAuthority = current.snapshot.rollbackInventory.find(
    (entry) =>
      entry.binding.bindingId === redeployFixture.targetBinding.bindingId,
  );
  assert.ok(redeployedAuthority);
  assert.deepEqual(
    redeployedAuthority.acceptedEvent,
    current.snapshot.acceptedStandardEvent,
  );
  assert.deepEqual(redeployedAuthority.eligibleActions, [
    "package-redeploy",
    "rollback",
  ]);
  assert.deepEqual(
    redeployed.terminalEvent.payload.rollbackInventory,
    current.snapshot.rollbackInventory,
  );

  const provenanceRedeployFixture = await initializePromotionFixture({
    operationKind: "redeploy-standard",
    fixtureOperationId: "reconcile-redeploy-provenance",
    fixtureSourceSha: redeployFixture.targetBinding.sourceSha,
    bootstrapSuffix: "2",
    targetSuffix: "3",
    companionSuffix: "4",
    operationOriginOverride: redeployFixture.targetBinding,
    operationOriginCompanionOverride: redeployFixture.companionBinding,
    existingStore: secondFixture.store,
  });
  const provenanceObservation = await buildProviderReconciliation({
    store: secondFixture.store,
    observedBinding: provenanceRedeployFixture.targetBinding,
  });
  assert.deepEqual(
    provenanceObservation.decision.terminalPlan.payload.originAcceptedEvent,
    current.snapshot.acceptedStandardEvent,
  );
  const provenanceResult = await appendReconciliation({
    store: secondFixture.store,
    decision: provenanceObservation.decision,
  });
  current = await readCurrentReleaseState({ store: secondFixture.store });
  assert.equal(
    current.snapshot.acceptedStandard?.bindingId,
    provenanceRedeployFixture.targetBinding.bindingId,
  );
  assert.deepEqual(
    current.snapshot.acceptedStandardEvent,
    redeployedAuthority.acceptedEvent,
  );
  assert.ok(
    current.snapshot.rollbackInventory.some(
      (entry) =>
        entry.binding.bindingId ===
        provenanceRedeployFixture.targetBinding.bindingId,
    ),
  );
  assert.deepEqual(
    provenanceResult.terminalEvent.payload.rollbackInventory,
    current.snapshot.rollbackInventory,
  );
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

test("records containment recovery terminal only after assignment validation and preserves pending on terminal CAS failure", async () => {
  const fixture = await initializePromotionFixture({
    operationKind: "activate-containment",
  });
  fixture.store.failCompareAndAppendAt = 3;
  await assert.rejects(runPromotionLifecycle(fixture), /fixture CAS conflict/);
  let current = await readCurrentReleaseState({ store: fixture.store });
  assert.equal(current.snapshot.pendingOperation?.kind, "activate-containment");
  assert.equal(current.snapshot.activeProduction, null);
  assert.ok(
    current.records.some(
      (record) => record.event.eventType === "assignment-validated",
    ),
  );
  assert.equal(
    current.records.some(
      (record) => record.event.eventType === "containment-activated",
    ),
    false,
  );

  fixture.store.failCompareAndAppendAt = null;
  const recovered = await runPromotionLifecycle(fixture);
  current = await readCurrentReleaseState({ store: fixture.store });
  assert.equal(recovered.resultKind, "recovery-lifecycle-recorded/v1");
  assert.equal(recovered.operationKind, "activate-containment");
  assert.equal(current.snapshot.pendingOperation, null);
  assert.equal(
    current.snapshot.activeProduction?.bindingId,
    fixture.operationTarget.bindingId,
  );
  assert.equal(
    current.records.some(
      (record) => record.event.eventType === "observation-started",
    ),
    false,
  );
  const recoveredAppendCalls = fixture.store.compareAndAppendCalls;
  const recoveredReplay = await runPromotionLifecycle(
    fixture,
    {},
    {
      clock: () => Date.parse(completedAt) + 24 * 60 * 60 * 1000,
    },
  );
  assert.equal(recoveredReplay.replayed, true);
  assert.deepEqual(recoveredReplay.events, recovered.events);
  assert.equal(fixture.store.compareAndAppendCalls, recoveredAppendCalls);
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
        validatePerformanceEvidence: async () => ({ errors: [] }),
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
        validatePerformanceEvidence: async () => ({ errors: [] }),
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      },
    ),
    /differs from its reviewed SHA-256/,
  );
  assert.equal(fixture.store.compareAndAppendCalls, calls);
});

test("requires an untampered acceptance-final bundle bound to the current candidate", async (t) => {
  await t.test("missing bundle", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    const calls = fixture.store.compareAndAppendCalls;
    await assert.rejects(
      acceptPendingStandardRelease(
        {
          ...input,
          terminalBundleBytes: null,
          expectedTerminalBundleSha256: null,
        },
        {
          validateEvidence: () => [],
          validatePerformanceEvidence: async () => ({ errors: [] }),
          clock: () => Date.parse(observationEndedAt),
        },
      ),
      /terminal bundle differs from its reviewed SHA-256/,
    );
    assert.equal(fixture.store.compareAndAppendCalls, calls);
  });

  await t.test("tampered immutable object", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    const objectSet = JSON.parse(input.terminalObjectSetBytes.toString("utf8"));
    objectSet.objects[0].bytesBase64 = canonicalJsonBytes({
      tampered: true,
    }).toString("base64");
    const terminalObjectSetBytes = canonicalJsonBytes(objectSet);
    await assert.rejects(
      acceptPendingStandardRelease(
        {
          ...input,
          terminalObjectSetBytes,
          expectedTerminalObjectSetSha256: sha256Bytes(terminalObjectSetBytes),
        },
        {
          validateEvidence: () => [],
          validatePerformanceEvidence: async () => ({ errors: [] }),
          clock: () => Date.parse(observationEndedAt),
        },
      ),
      /object set is unsorted or tampered/,
    );
  });

  await t.test("wrong standard binding", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    const bundle = JSON.parse(input.terminalBundleBytes.toString("utf8"));
    bundle.artifactManifest = structuredClone(bundle.packageIndex);
    const terminalBundleBytes = canonicalJsonBytes(bundle);
    await assert.rejects(
      acceptPendingStandardRelease(
        {
          ...input,
          terminalBundleBytes,
          expectedTerminalBundleSha256: sha256Bytes(terminalBundleBytes),
        },
        {
          validateEvidence: () => [],
          validatePerformanceEvidence: async () => ({ errors: [] }),
          clock: () => Date.parse(observationEndedAt),
        },
      ),
      /binding\/hash chain differs/,
    );
  });

  await t.test("wrong bundle source", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    const bundle = JSON.parse(input.terminalBundleBytes.toString("utf8"));
    bundle.sourceSha = "9".repeat(40);
    const terminalBundleBytes = canonicalJsonBytes(bundle);
    await assert.rejects(
      acceptPendingStandardRelease(
        {
          ...input,
          terminalBundleBytes,
          expectedTerminalBundleSha256: sha256Bytes(terminalBundleBytes),
        },
        {
          validateEvidence: () => [],
          validatePerformanceEvidence: async () => ({ errors: [] }),
          clock: () => Date.parse(observationEndedAt),
        },
      ),
      /source chain differs|approval receipt chain differs/,
    );
  });
});

test("accepts only fresh standard evidence with three derived roles and replays", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({ fixture });
  const performanceVerifications = [];
  const validatePerformanceEvidence = async (options) => {
    performanceVerifications.push(structuredClone(options));
    return { errors: [] };
  };
  const first = await acceptPendingStandardRelease(
    {
      ...input,
      oidcRequestUrl: "https://oidc.example.test",
      oidcRequestToken: "oidc-token",
      githubToken: "g".repeat(20),
    },
    {
      validateEvidence: () => [],
      validatePerformanceEvidence,
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    },
  );
  assert.equal(performanceVerifications.length, 2);
  assert.ok(
    performanceVerifications.every(
      ({ gate, evidence }) =>
        gate === "P0-TOOLCHAIN" && evidence.evidence.gate === "P0-TOOLCHAIN",
    ),
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
      validatePerformanceEvidence,
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    },
  );
  const current = await readCurrentReleaseState({ store: fixture.store });
  const acceptedAuthority = resolveAcceptedStandardAuthority({
    current,
    binding: current.snapshot.acceptedStandard,
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(performanceVerifications.length, 3);
  assert.equal(fixture.store.compareAndAppendCalls, calls);
  assert.equal(first.approvals.length, 3);
  assert.equal(current.snapshot.pendingAcceptance, null);
  assert.deepEqual(
    acceptedAuthority.acceptedEvent,
    current.snapshot.acceptedStandardEvent,
  );
  assert.deepEqual(
    acceptedAuthority.acceptedStandardFloors,
    current.snapshot.acceptedStandardFloors,
  );
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
        validatePerformanceEvidence: async () => ({ errors: [] }),
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      },
    ),
    /subject or payload differs|retry terminal bundle differs/,
  );
});

test("derives prompt-close-all floors and clears bootstrap only with a passing recovery drill", async () => {
  const promptPolicy = {
    ...releasePolicy,
    initialStandard: standardDimensions("prompt-close-all-v1"),
    targetStandard: standardDimensions("prompt-close-all-v1"),
    phaseSequence: [{ gate: "P0-RELEASE", change: null }],
  };
  const fixture = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    withRecoveryHistory: true,
  });
  await runPromotionLifecycle(fixture);
  const input = await acceptanceInputOptions({
    fixture,
    includeRecoveryDrill: true,
  });
  await acceptPendingStandardRelease(input, {
    validateEvidence: () => [],
    validatePerformanceEvidence: async () => ({ errors: [] }),
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

test("accepts a fresh same-floor prompt standard from a distinct source and keeps its predecessor as the sole eligible rollback", async () => {
  const promptPolicy = {
    ...releasePolicy,
    initialStandard: standardDimensions("prompt-close-all-v1"),
    targetStandard: standardDimensions("prompt-close-all-v1"),
    phaseSequence: [{ gate: "P0-RELEASE", change: null }],
  };
  const firstFixture = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    withRecoveryHistory: true,
  });
  await runPromotionLifecycle(firstFixture);
  const firstInput = await acceptanceInputOptions({
    fixture: firstFixture,
    includeRecoveryDrill: true,
  });
  await acceptPendingStandardRelease(firstInput, {
    validateEvidence: () => [],
    validatePerformanceEvidence: async () => ({ errors: [] }),
    collectApprovals: acceptanceCollector,
    clock: () => Date.parse(observationEndedAt),
  });

  const secondSourceSha = "b".repeat(40);
  const secondFixture = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    fixtureOperationId: "same-floor-source-b",
    fixtureSourceSha: secondSourceSha,
    targetGate: "P0-RELEASE",
    bootstrapSuffix: "8",
    targetSuffix: "4",
    companionSuffix: "5",
    existingStore: firstFixture.store,
  });
  await runPromotionLifecycle(secondFixture);
  const requirements = await resolvePendingAcceptanceRequirements({
    store: secondFixture.store,
  });
  assert.equal(requirements.acceptedGate, "P0-RELEASE");
  assert.equal(requirements.sourceSha, secondSourceSha);
  const secondInput = await acceptanceInputOptions({ fixture: secondFixture });
  await acceptPendingStandardRelease(secondInput, {
    validateEvidence: () => [],
    validatePerformanceEvidence: async () => ({ errors: [] }),
    collectApprovals: acceptanceCollector,
    clock: () => Date.parse(observationEndedAt),
  });

  const current = await readCurrentReleaseState({ store: secondFixture.store });
  assert.equal(current.snapshot.acceptedGate, "P0-RELEASE");
  assert.equal(current.snapshot.acceptedStandard?.sourceSha, secondSourceSha);
  assert.deepEqual(
    current.snapshot.acceptedStandardFloors,
    Object.fromEntries(
      Object.entries(promptPolicy.initialStandard).filter(
        ([key]) => key !== "releaseRole",
      ),
    ),
  );
  const eligibleRollback = current.snapshot.rollbackInventory.filter(
    ({ eligibility, eligibleActions }) =>
      eligibility === "eligible" && eligibleActions.includes("rollback"),
  );
  assert.equal(eligibleRollback.length, 1);
  assert.equal(
    eligibleRollback[0].binding.bindingId,
    firstFixture.targetBinding.bindingId,
  );
  assert.equal(eligibleRollback[0].acceptedGate, "P0-RELEASE");
  assert.deepEqual(
    eligibleRollback[0].acceptedStandardFloors,
    current.snapshot.acceptedStandardFloors,
  );
  const acceptedRecords = secondFixture.store.records.filter(
    ({ event }) => event.eventType === "release-accepted",
  );
  assert.equal(acceptedRecords.length, 2);
  assert.deepEqual(
    acceptedRecords.map(({ event }) => event.approvalRefs.length),
    [3, 3],
  );
  assert.deepEqual(
    acceptedRecords.map(({ event }) => event.operationId),
    [operationId, "same-floor-source-b"],
  );

  const redeployedSecond = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    operationKind: "redeploy-standard",
    fixtureOperationId: "redeploy-managed-stage-current",
    fixtureSourceSha: secondFixture.targetBinding.sourceSha,
    targetGate: "P0-RELEASE",
    bootstrapSuffix: "c",
    targetSuffix: "d",
    companionSuffix: "e",
    operationOriginOverride: secondFixture.targetBinding,
    operationOriginCompanionOverride: secondFixture.companionBinding,
    existingStore: secondFixture.store,
  });
  await runPromotionLifecycle(redeployedSecond);
  let rollbackCurrent = await readCurrentReleaseState({
    store: secondFixture.store,
  });
  assert.equal(
    rollbackCurrent.snapshot.acceptedStandard?.bindingId,
    redeployedSecond.targetBinding.bindingId,
  );

  const rollbackToFirst = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    operationKind: "rollback-standard",
    fixtureOperationId: "managed-stage-rollback-to-first",
    fixtureSourceSha: firstFixture.targetBinding.sourceSha,
    targetGate: "P0-RELEASE",
    bootstrapSuffix: "1",
    targetSuffix: "2",
    companionSuffix: "3",
    operationTargetOverride: firstFixture.targetBinding,
    operationCompanionOverride: firstFixture.companionBinding,
    existingStore: secondFixture.store,
  });
  await runPromotionLifecycle(rollbackToFirst);
  const rollbackAppendCalls = secondFixture.store.compareAndAppendCalls;
  const rollbackReplay = await runPromotionLifecycle(
    rollbackToFirst,
    {},
    {
      clock: () => Date.parse(completedAt) + 24 * 60 * 60 * 1000,
    },
  );
  assert.equal(rollbackReplay.replayed, true);
  assert.equal(secondFixture.store.compareAndAppendCalls, rollbackAppendCalls);
  rollbackCurrent = await readCurrentReleaseState({
    store: secondFixture.store,
  });
  assert.equal(
    rollbackCurrent.snapshot.acceptedStandard?.bindingId,
    firstFixture.targetBinding.bindingId,
  );
  assert.deepEqual(
    rollbackCurrent.snapshot.rollbackInventory.map(
      (entry) => entry.binding.bindingId,
    ),
    [redeployedSecond.targetBinding.bindingId],
  );

  const rollbackToSecond = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    operationKind: "rollback-standard",
    fixtureOperationId: "managed-stage-rollback-to-second",
    fixtureSourceSha: redeployedSecond.targetBinding.sourceSha,
    targetGate: "P0-RELEASE",
    bootstrapSuffix: "6",
    targetSuffix: "7",
    companionSuffix: "8",
    operationTargetOverride: redeployedSecond.targetBinding,
    operationCompanionOverride: redeployedSecond.companionBinding,
    existingStore: secondFixture.store,
  });
  await runPromotionLifecycle(rollbackToSecond);
  rollbackCurrent = await readCurrentReleaseState({
    store: secondFixture.store,
  });
  assert.equal(
    rollbackCurrent.snapshot.acceptedStandard?.bindingId,
    redeployedSecond.targetBinding.bindingId,
  );
  assert.deepEqual(
    rollbackCurrent.snapshot.rollbackInventory.map(
      (entry) => entry.binding.bindingId,
    ),
    [firstFixture.targetBinding.bindingId],
  );
  assert.deepEqual(
    secondFixture.store.records
      .filter(({ event }) => event.eventType === "rollback-activated")
      .map(({ event }) => event.payload.binding.bindingId),
    [
      firstFixture.targetBinding.bindingId,
      redeployedSecond.targetBinding.bindingId,
    ],
  );

  const reusedSourceFixture = await initializePromotionFixture({
    pwaLifecycle: "prompt-close-all-v1",
    releasePolicyValue: promptPolicy,
    fixtureOperationId: "reject-reused-source",
    fixtureSourceSha: secondSourceSha,
    targetGate: "P0-RELEASE",
    bootstrapSuffix: "9",
    targetSuffix: "6",
    companionSuffix: "7",
    existingStore: secondFixture.store,
  });
  await runPromotionLifecycle(reusedSourceFixture);
  await assert.rejects(
    resolvePendingAcceptanceRequirements({ store: reusedSourceFixture.store }),
    /not an independent source deployment/,
  );
});

test("fails prompt-close-all bootstrap clearance without recovery PASS or an exact companion projection", async (t) => {
  const promptPolicy = {
    ...releasePolicy,
    initialStandard: standardDimensions("prompt-close-all-v1"),
    targetStandard: standardDimensions("prompt-close-all-v1"),
    phaseSequence: [{ gate: "P0-RELEASE", change: null }],
  };
  await t.test("missing recovery PASS", async () => {
    const fixture = await initializePromotionFixture({
      pwaLifecycle: "prompt-close-all-v1",
      releasePolicyValue: promptPolicy,
    });
    await runPromotionLifecycle(fixture);
    const evidence = acceptanceEvidence();
    evidence.automatedGates.rollback.status = "FAIL";
    await assert.rejects(
      acceptanceInputOptions({ fixture, evidence }),
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
    await assert.rejects(
      acceptanceInputOptions({
        fixture,
        includeRecoveryDrill: true,
      }),
      /does not match the standard policy projection/,
    );
  });
});

test("rejects stale evidence, source tamper, and duplicate acceptance roles", async (t) => {
  await t.test("less than 24 hours", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    const evidence = acceptanceEvidence();
    evidence.canary.endedAt = "2026-08-06T23:59:59.000Z";
    evidence.automatedGates.rollback.completedAt = evidence.canary.endedAt;
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
          validatePerformanceEvidence: async () => ({ errors: [] }),
          clock: () => Date.parse(observationEndedAt),
        },
      ),
      /does not cover the pending 24-hour observation/,
    );
  });

  await t.test("stale evidence", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => [],
        validatePerformanceEvidence: async () => ({ errors: [] }),
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
          validatePerformanceEvidence: async () => ({ errors: [] }),
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
    await assert.rejects(
      acceptanceInputOptions({
        fixture,
        collectApprovals: async (options) => {
          const result = await acceptanceCollector(options);
          result.approvalRefs[2] = structuredClone(result.approvalRefs[1]);
          return result;
        },
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
        validatePerformanceEvidence: async () => ({ errors: [] }),
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      }),
      /minimum sample is not satisfied/,
    );
  });
  await t.test("authoritative performance verifier failure", async () => {
    const fixture = await initializePromotionFixture();
    await runPromotionLifecycle(fixture);
    const input = await acceptanceInputOptions({ fixture });
    const storedEvidenceCount = fixture.store.evidence.size;
    await assert.rejects(
      acceptPendingStandardRelease(input, {
        validateEvidence: () => [],
        validatePerformanceEvidence: async ({ gate, evidence }) => {
          assert.equal(gate, "P0-TOOLCHAIN");
          assert.equal(evidence.evidence.gate, "P0-TOOLCHAIN");
          return { errors: ["canonical 30-sample ceiling is not satisfied"] };
        },
        collectApprovals: acceptanceCollector,
        clock: () => Date.parse(observationEndedAt),
      }),
      /authoritative gate verifier: canonical 30-sample ceiling is not satisfied/,
    );
    assert.equal(fixture.store.evidence.size, storedEvidenceCount);
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
      validatePerformanceEvidence: async () => ({ errors: [] }),
      collectApprovals: acceptanceCollector,
      clock: () => Date.parse(observationEndedAt),
    }),
    /fixture CAS conflict/,
  );
  fixture.store.failCompareAndAppendAt = null;
  const result = await acceptPendingStandardRelease(options, {
    validateEvidence: () => [],
    validatePerformanceEvidence: async () => ({ errors: [] }),
    collectApprovals: acceptanceCollector,
    clock: () => Date.parse(observationEndedAt),
  });
  assert.equal(result.replayed, false);
});

test("marks rollback and package redeploy ineligible when the archive is unavailable", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  const options = await acceptanceInputOptions({ fixture });
  await acceptPendingStandardRelease(options, {
    validateEvidence: () => [],
    validatePerformanceEvidence: async () => ({ errors: [] }),
    collectApprovals: acceptanceCollector,
    clock: () => Date.parse(observationEndedAt),
  });
  const current = await readCurrentReleaseState({ store: fixture.store });
  fixture.store.evidence.delete(fixture.targetBinding.artifactArchive.sha256);
  const inventory = await deriveRollbackInventory({
    store: fixture.store,
    current,
    releasePolicy,
    minimumAcceptedGate: current.snapshot.acceptedGate,
    minimumAcceptedFloors: current.snapshot.acceptedStandardFloors,
  });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].eligibility, "ineligible");
  assert.deepEqual(inventory[0].eligibleActions, []);
  assert.deepEqual(inventory[0].reasonCodes, ["artifact-archive-unavailable"]);
});

test("rechecks OIDC authority before publishing the terminal bundle", async () => {
  const fixture = await initializePromotionFixture();
  await runPromotionLifecycle(fixture);
  let reads = 0;
  await assert.rejects(
    acceptanceInputOptions({
      fixture,
      collectApprovals: async (options) => {
        const collected = await acceptanceCollector(options);
        return {
          ...collected,
          oidcExpiresAt: new Date(
            Date.parse(observationEndedAt) + 30 * 1000,
          ).toISOString(),
        };
      },
      prepareClock: () => {
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
