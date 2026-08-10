import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  PRE_PROMOTION_EVIDENCE_SOURCE_KIND,
  PRE_PROMOTION_EVIDENCE_SET_KIND,
  buildAuthoritativePrePromotionEvidenceSet,
  buildAuthoritativePromotionSubject,
  buildAuthoritativeProviderAliasObservation,
  collectVercelAliasAssignments,
} from "./authoritativeInputProducers.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { decideProviderReconciliation } from "./reconcileDecision.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
} from "./releaseStateReducer.mjs";
import { createStoredPrePromotionFixture } from "./prePromotionEvidenceTestFixture.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "./reviewedWorkflowRunAuthority.mjs";
import { readFile } from "node:fs/promises";

const namespace = "producer-test";
const sourceSha = "a".repeat(40);
const fixedTime = "2026-08-06T00:00:00.000Z";
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
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: "d".repeat(64),
};
const observationPolicy = {
  apiBaseUrl: "https://api.vercel.com",
  maxResponseAgeSeconds: 300,
  maxFutureClockSkewSeconds: 30,
};
const providerPolicy = {
  bindingStatus: "configured",
  expectedTeamId: "team-test",
  expectedProjectId: "project-test",
  ownedProductionDomains: ["b.example.test", "a.example.test"],
  observationPolicy,
};

class FakeReleaseStateStore {
  constructor() {
    this.namespace = namespace;
    this.records = [];
    this.evidence = new Map();
  }

  async readHead() {
    const last = this.records.at(-1);
    return last
      ? { sequence: last.sequence, eventHash: last.eventHash }
      : { sequence: 0, eventHash: null };
  }

  async readEvents({ afterSequence = 0 } = {}) {
    return this.records
      .filter(({ sequence }) => sequence > afterSequence)
      .map((record) => structuredClone(record));
  }

  seedEvent(event) {
    this.records.push({
      sequence: event.sequence,
      eventHash: hashReleaseEvent(event),
      previousHash: event.previousEventHash,
      event: structuredClone(event),
      committedAt: fixedTime,
    });
  }

  async putEvidence({ bytes, mediaType }) {
    const storedBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(storedBytes);
    const replayed = this.evidence.has(sha256);
    this.evidence.set(sha256, {
      bytes: storedBytes,
      mediaType,
      committedAt: fixedTime,
    });
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
      mediaType,
      byteLength: storedBytes.length,
      committedAt: fixedTime,
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
}

const putJson = async (store, value, mediaType = "application/json") => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putWorkflowRunAuthority = async (store, runId = "101") => {
  const apiResponse = await putJson(
    store,
    {
      id: Number(runId),
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: "owner/repository" },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  return putJson(
    store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository: "owner/repository",
      runId,
      runAttempt: "1",
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
};

const createBinding = async ({
  store,
  role,
  suffix,
  releasePolicy,
  publicIdentityKind = "release-identity-v1",
}) => {
  const packageIndex = await putJson(store, {
    kind: "package-index",
    suffix,
  });
  const artifactManifest = await putJson(store, {
    kind: "artifact-manifest",
    suffix,
  });
  const providerPolicyReference = await putJson(
    store,
    providerPolicy,
    "application/vnd.event-shopping-planner.provider-policy+json;version=1",
  );
  const archiveBytes = Buffer.from(`archive:${role}:${suffix}`);
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
      sourceSha,
      variantId: suffix.repeat(64),
      releaseRole: role,
      artifactManifest,
      artifactArchive: {
        ...artifactArchive,
        mediaType:
          "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
        byteLength: archiveBytes.length,
        committedAt: fixedTime,
      },
    },
    "application/vnd.event-shopping-planner.artifact-archive-availability+json;version=1",
  );
  const base = {
    bindingId: `${role}-${suffix}`,
    sourceSha,
    buildId: sourceSha,
    variantId: suffix.repeat(64),
    releaseRole: role,
    publicIdentityKind,
    providerProjectId: "project-test",
    providerDeploymentId: `deployment-${role}-${suffix}`,
    deploymentUrl: `https://${role}-${suffix}.example.test`,
    artifactArchive,
    artifactArchiveAvailability,
    packageIndex,
    artifactManifest,
    providerEvidence: null,
    releasePolicy,
    providerPolicy: providerPolicyReference,
    providerConfigurationHash: "6".repeat(64),
    requiredDbCompatibility: dbCompatibility,
  };
  const providerEvidence = await putJson(store, {
    schemaVersion: 1,
    providerProjectId: base.providerProjectId,
    providerDeploymentId: base.providerDeploymentId,
    deploymentUrl: base.deploymentUrl,
    sourceSha: base.sourceSha,
    variantId: base.variantId,
    releaseRole: base.releaseRole,
    artifactManifestHash: artifactManifest.sha256,
    packageIndexHash: packageIndex.sha256,
    providerConfigurationHash: base.providerConfigurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicy.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentity: {
      identityKind: publicIdentityKind,
    },
    routeProbeEvidenceHash: "7".repeat(64),
    environmentPresenceEvidenceHash: "8".repeat(64),
  });
  return { ...base, providerEvidence };
};

const initializeFixture = async () => {
  const store = new FakeReleaseStateStore();
  const configuredReleasePolicy = JSON.parse(
    await readFile(
      new URL("../../config/release-variants.json", import.meta.url),
      "utf8",
    ),
  );
  const prePromotion = await createStoredPrePromotionFixture({
    store,
    namespace,
    sourceSha,
    dbCompatibility,
    providerPolicy,
    releasePolicy: {
      ...configuredReleasePolicy,
      activationStatus: "active",
      activationBlockers: [],
    },
  });
  const releasePolicy = prePromotion.releasePolicyReference;
  const bootstrap = await createBinding({
    store,
    role: "containment",
    suffix: "b",
    releasePolicy,
    publicIdentityKind: "legacy-bootstrap-v1",
  });
  const initialEvidence = await putJson(store, {
    kind: "initial-observation",
  });
  store.seedEvent(
    createReleaseEvent({
      namespace,
      sequence: 1,
      eventType: "state-initialized",
      operationId: "initialize",
      previousEventHash: null,
      payload: {
        acceptedGate: null,
        executorSourceSha: sourceSha,
        legacyObservedProduction: {
          observationUri: initialEvidence.uri,
          observationSha256: initialEvidence.sha256,
        },
        bootstrapRecovery: bootstrap,
        minimumSafetyFloors: { releaseChannel: "release-a" },
        currentDbCompatibility: dbCompatibility,
        activeReleasePolicy: releasePolicy,
        phaseExitAttestationSeed,
      },
      evidenceRefs: [initialEvidence, ...phaseExitAttestationReferences],
    }),
  );
  const standard = prePromotion.standard;
  const containment = prePromotion.containment;
  const namedEvidence = prePromotion.namedEvidence;
  const evidenceRefs = Object.values(namedEvidence).sort((left, right) =>
    Buffer.compare(Buffer.from(left.uri), Buffer.from(right.uri)),
  );
  const workflowRunAuthority = await putWorkflowRunAuthority(store);
  const evidenceSetBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: PRE_PROMOTION_EVIDENCE_SET_KIND,
    namespace,
    evidence: namedEvidence,
    workflowRunAuthority,
  });
  return {
    store,
    bootstrap,
    standard,
    containment,
    namedEvidence,
    evidenceRefs,
    evidenceSetBytes,
    workflowRunAuthority,
  };
};

const producePromotion = async (fixture) =>
  buildAuthoritativePromotionSubject({
    store: fixture.store,
    namespace,
    operationId: "promote-authoritative",
    standardBindingBytes: canonicalJsonBytes(fixture.standard),
    containmentBindingBytes: canonicalJsonBytes(fixture.containment),
    evidenceSetBytes: fixture.evidenceSetBytes,
  });

test("produces pre-promotion evidence only from reviewed stored references", async () => {
  const fixture = await initializeFixture();
  const sourceBytes = canonicalJsonBytes({
    schemaVersion: 1,
    sourceKind: PRE_PROMOTION_EVIDENCE_SOURCE_KIND,
    namespace,
    sourceSha,
    evidence: fixture.namedEvidence,
  });
  const result = await buildAuthoritativePrePromotionEvidenceSet(
    {
      store: fixture.store,
      namespace,
      sourceSha,
      sourceBytes,
      expectedSourceSha256: sha256Bytes(sourceBytes),
      currentRunId: "200",
      githubToken: "github-token-fixture",
      repository: "owner/repository",
    },
    {
      collectRunAuthority: async () => ({
        receipt: fixture.workflowRunAuthority,
      }),
    },
  );
  assert.deepEqual(result.evidenceSet, {
    schemaVersion: 1,
    evidenceKind: PRE_PROMOTION_EVIDENCE_SET_KIND,
    namespace,
    evidence: fixture.namedEvidence,
    workflowRunAuthority: fixture.workflowRunAuthority,
  });
  await assert.rejects(
    buildAuthoritativePrePromotionEvidenceSet(
      {
        store: fixture.store,
        namespace,
        sourceSha,
        sourceBytes,
        expectedSourceSha256: sha256Bytes(sourceBytes),
        currentRunId: "101",
        githubToken: "github-token-fixture",
        repository: "owner/repository",
      },
      {
        collectRunAuthority: async () => {
          throw new Error("same-run authority lookup must not execute");
        },
      },
    ),
    /distinct prior run/,
  );
  const missing = structuredClone(JSON.parse(sourceBytes.toString("utf8")));
  missing.evidence.qa.sha256 = "0".repeat(64);
  missing.evidence.qa.uri =
    `release-state://${namespace}/evidence/` + missing.evidence.qa.sha256;
  const missingBytes = canonicalJsonBytes(missing);
  await assert.rejects(
    buildAuthoritativePrePromotionEvidenceSet({
      store: fixture.store,
      namespace,
      sourceSha,
      sourceBytes: missingBytes,
      expectedSourceSha256: sha256Bytes(missingBytes),
      currentRunId: "200",
      githubToken: "github-token-fixture",
      repository: "owner/repository",
    }),
    /not found|missing|absent/i,
  );
});

const createApproval = (role, suffix, operationId) => ({
  uri: `release-state://${namespace}/evidence/${suffix.repeat(64)}`,
  sha256: suffix.repeat(64),
  approvalId: `approval-${suffix}`,
  operationId,
  subjectSha256: "9".repeat(64),
  trustedIssuer: "https://token.actions.githubusercontent.com",
  issuerReceiptUri: `release-state://${namespace}/evidence/${"f".repeat(64)}`,
  issuerReceiptSha256: "f".repeat(64),
  workflowRunId: "100",
  protectedEnvironment: "foundation-release-state",
  providerReviewerId: `reviewer-${suffix}`,
  role,
  decision: "APPROVED",
  approvedAt: fixedTime,
});

const seedPreparedPromotion = async (fixture, promotion) => {
  const current = await readCurrentReleaseState({ store: fixture.store });
  const approvalRefs = [
    createApproval("releaseOwner", "1", promotion.subject.operationId),
    createApproval("dataSafetyReviewer", "2", promotion.subject.operationId),
  ];
  fixture.store.seedEvent(
    createReleaseEvent({
      namespace,
      sequence: current.snapshot.sequence + 1,
      eventType: "promotion-prepared",
      operationId: promotion.subject.operationId,
      previousEventHash: current.snapshot.eventHash,
      payload: {
        pendingOperation: {
          operationId: promotion.subject.operationId,
          kind: "promote-standard",
          expectedState: promotion.subject.expectedState,
          targetBinding: promotion.subject.targetBinding,
          originBinding: null,
          originCompanionBinding: null,
          companionBinding: promotion.subject.companionBinding,
          previousBinding: promotion.subject.previousBinding,
          emergencyRecoveryBinding: promotion.subject.emergencyRecoveryBinding,
          approvalRefs,
          preparedAt: fixedTime,
        },
      },
      approvalRefs,
    }),
  );
};

test("derives a canonical promotion subject only from replayed state and stored evidence", async () => {
  const fixture = await initializeFixture();
  const result = await producePromotion(fixture);
  const current = await readCurrentReleaseState({ store: fixture.store });

  assert.deepEqual(result.subject.expectedState, {
    sequence: current.snapshot.sequence,
    eventHash: current.snapshot.eventHash,
  });
  assert.equal(result.subject.previousBinding, null);
  assert.deepEqual(result.subject.emergencyRecoveryBinding, fixture.bootstrap);
  assert.deepEqual(result.subject.evidenceRefs, fixture.evidenceRefs);
  assert.equal(result.subjectSha256, sha256Bytes(result.subjectBytes));
  assert.deepEqual(
    JSON.parse(result.subjectBytes.toString("utf8")),
    result.subject,
  );

  await assert.rejects(
    buildAuthoritativePromotionSubject({
      store: fixture.store,
      namespace,
      operationId: "promote-authoritative",
      standardBindingBytes: canonicalJsonBytes(fixture.standard),
      containmentBindingBytes: canonicalJsonBytes(fixture.containment),
      evidenceSetBytes: fixture.evidenceSetBytes,
      previousBinding: null,
    }),
    /Caller-supplied previousBinding is forbidden/,
  );
});

test("fails promotion subject production for noncanonical or absent evidence", async () => {
  const fixture = await initializeFixture();
  await assert.rejects(
    buildAuthoritativePromotionSubject({
      store: fixture.store,
      namespace,
      operationId: "promote-authoritative",
      standardBindingBytes: Buffer.from(
        JSON.stringify(fixture.standard, null, 2),
      ),
      containmentBindingBytes: canonicalJsonBytes(fixture.containment),
      evidenceSetBytes: fixture.evidenceSetBytes,
    }),
    /must use canonical JSON bytes/,
  );

  fixture.store.evidence.delete(fixture.evidenceRefs[0].sha256);
  await assert.rejects(producePromotion(fixture), /absent or failed/);

  const missingAuthority = await initializeFixture();
  missingAuthority.store.evidence.delete(
    missingAuthority.workflowRunAuthority.sha256,
  );
  await assert.rejects(
    producePromotion(missingAuthority),
    /workflow run receipt is absent/,
  );
});

test("collects every Vercel alias from the provider API with response bindings", async () => {
  const calls = [];
  const assignments = await collectVercelAliasAssignments({
    domains: ["b.example.test", "a.example.test"],
    expectedProjectId: "project-test",
    expectedTeamId: "team-test",
    token: "v".repeat(20),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const domain = new URL(url).pathname.split("/").at(-1);
      const body = Buffer.from(
        JSON.stringify({
          alias: domain,
          projectId: "project-test",
          deploymentId: "deployment-standard-c",
        }),
      );
      return {
        status: 200,
        url,
        headers: {
          get(name) {
            if (name === "date") return fixedTime;
            if (name === "content-length") return String(body.length);
            return null;
          },
        },
        async arrayBuffer() {
          return body;
        },
      };
    },
  });

  assert.deepEqual(
    assignments.map(({ productionDomain }) => productionDomain),
    ["a.example.test", "b.example.test"],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"v".repeat(20)}`);
  assert.equal(new URL(calls[0].url).searchParams.get("teamId"), "team-test");
  assert.equal(
    assignments.every(
      ({ responseSha256, bodyBytes }) =>
        responseSha256 === sha256Bytes(bodyBytes),
    ),
    true,
  );

  const invalidTokenOptions = {
    domains: ["a.example.test"],
    expectedProjectId: "project-test",
    expectedTeamId: "team-test",
    fetchImpl: async () => {
      throw new Error("fetch must not run");
    },
  };
  await assert.rejects(
    collectVercelAliasAssignments({
      ...invalidTokenOptions,
      token: "v".repeat(4097),
    }),
    /collector binding is invalid/,
  );
  await assert.rejects(
    collectVercelAliasAssignments({
      ...invalidTokenOptions,
      token: `${"v".repeat(20)}\n`,
    }),
    /collector binding is invalid/,
  );
});

test("stores provider API receipts and emits an observation accepted by reconcile", async () => {
  const fixture = await initializeFixture();
  const promotion = await producePromotion(fixture);
  await seedPreparedPromotion(fixture, promotion);
  const result = await buildAuthoritativeProviderAliasObservation(
    {
      store: fixture.store,
      namespace,
      providerToken: "v".repeat(20),
    },
    {
      now: () => Date.parse(fixedTime),
      collectAssignments: async ({ domains }) =>
        domains.map((productionDomain) => {
          const bodyBytes = Buffer.from(
            JSON.stringify({
              alias: productionDomain,
              projectId: "project-test",
              deploymentId: fixture.standard.providerDeploymentId,
            }),
          );
          const requestUrl =
            `https://api.vercel.com/v4/aliases/${productionDomain}` +
            "?teamId=team-test";
          return {
            productionDomain,
            providerProjectId: "project-test",
            providerDeploymentId: fixture.standard.providerDeploymentId,
            requestUrl,
            responseUrl: requestUrl,
            status: 200,
            providerDate: fixedTime,
            bodyBytes,
            responseSha256: sha256Bytes(bodyBytes),
          };
        }),
    },
  );

  assert.equal(result.decision.status, "ready");
  assert.equal(result.observationSha256, sha256Bytes(result.observationBytes));
  assert.deepEqual(result.observation.observedBinding, fixture.standard);
  assert.deepEqual(
    result.observation.assignments.map(
      ({ productionDomain }) => productionDomain,
    ),
    ["a.example.test", "b.example.test"],
  );
  assert.equal(result.providerReceiptReferences.length, 2);
  assert.deepEqual(
    result.observation.providerReceiptReferences,
    result.providerReceiptReferences,
  );
  for (const reference of result.providerReceiptReferences) {
    assert.ok(fixture.store.evidence.has(reference.sha256));
  }
  assert.ok(fixture.store.evidence.has(result.observationReference.sha256));

  const storedReceipt = fixture.store.evidence.get(
    result.providerReceiptReferences[0].sha256,
  );
  const receipt = JSON.parse(storedReceipt.bytes.toString("utf8"));
  fixture.store.evidence.get(receipt.responseReference.sha256).bytes =
    Buffer.from("{}");
  const tamperedDecision = await decideProviderReconciliation(
    {
      store: fixture.store,
      observationBytes: result.observationBytes,
    },
    { now: () => Date.parse(fixedTime) },
  );
  assert.equal(tamperedDecision.status, "blocked");
  assert.ok(
    tamperedDecision.reasonCodes.includes(
      "provider-receipt-chain-unverifiable",
    ),
  );
});

test("derives the initial post-promotion bootstrap recovery branch", async () => {
  const fixture = await initializeFixture();
  const promotion = await producePromotion(fixture);
  await seedPreparedPromotion(fixture, promotion);
  const result = await buildAuthoritativeProviderAliasObservation(
    {
      store: fixture.store,
      namespace,
      providerToken: "v".repeat(20),
    },
    {
      now: () => Date.parse(fixedTime),
      collectAssignments: async ({ domains }) =>
        domains.map((productionDomain) => {
          const bodyBytes = Buffer.from(
            JSON.stringify({
              alias: productionDomain,
              projectId: "project-test",
              deploymentId: fixture.bootstrap.providerDeploymentId,
            }),
          );
          const requestUrl =
            `https://api.vercel.com/v4/aliases/${productionDomain}` +
            "?teamId=team-test";
          return {
            productionDomain,
            providerProjectId: "project-test",
            providerDeploymentId: fixture.bootstrap.providerDeploymentId,
            requestUrl,
            responseUrl: requestUrl,
            status: 200,
            providerDate: fixedTime,
            bodyBytes,
            responseSha256: sha256Bytes(bodyBytes),
          };
        }),
    },
  );
  assert.deepEqual(result.observation.observedBinding, fixture.bootstrap);
  assert.equal(
    result.decision.eventPlan.payload.reconciliationKind,
    "provider-emergency-assigned/v1",
  );
  assert.equal(
    result.decision.terminalPlan.eventType,
    "temporary-containment-activated",
  );
  assert.equal(
    Date.parse(result.decision.terminalPlan.payload.recoveryDeadline) -
      Date.parse(result.decision.terminalPlan.payload.activatedAt),
    6 * 60 * 60 * 1000,
  );
});

test("fails provider production closed for partial, ambiguous, unknown, or caller assignments", async () => {
  const fixture = await initializeFixture();
  const promotion = await producePromotion(fixture);
  await seedPreparedPromotion(fixture, promotion);
  const makeCollected = (domain, deploymentId) => {
    const bodyBytes = Buffer.from("{}");
    const requestUrl = `https://api.vercel.com/v4/aliases/${domain}`;
    return {
      productionDomain: domain,
      providerProjectId: "project-test",
      providerDeploymentId: deploymentId,
      requestUrl,
      responseUrl: requestUrl,
      status: 200,
      providerDate: fixedTime,
      bodyBytes,
      responseSha256: sha256Bytes(bodyBytes),
    };
  };
  const base = {
    store: fixture.store,
    namespace,
    providerToken: "v".repeat(20),
  };

  await assert.rejects(
    buildAuthoritativeProviderAliasObservation(base, {
      now: () => Date.parse(fixedTime),
      collectAssignments: async () => [
        makeCollected("a.example.test", fixture.standard.providerDeploymentId),
      ],
    }),
    /partial or ambiguous/,
  );
  await assert.rejects(
    buildAuthoritativeProviderAliasObservation(base, {
      now: () => Date.parse(fixedTime),
      collectAssignments: async () => [
        makeCollected("a.example.test", fixture.standard.providerDeploymentId),
        makeCollected("b.example.test", "deployment-unknown"),
      ],
    }),
    /ambiguous or unknown/,
  );
  await assert.rejects(
    buildAuthoritativeProviderAliasObservation(base, {
      now: () => Date.parse(fixedTime),
      collectAssignments: async () => [
        {
          ...makeCollected(
            "a.example.test",
            fixture.standard.providerDeploymentId,
          ),
          providerDate: "2026-08-05T00:00:00.000Z",
        },
        {
          ...makeCollected(
            "b.example.test",
            fixture.standard.providerDeploymentId,
          ),
          providerDate: "2026-08-05T00:00:00.000Z",
        },
      ],
    }),
    /collector receipt is invalid/,
  );
  await assert.rejects(
    buildAuthoritativeProviderAliasObservation(
      { ...base, assignments: [] },
      {
        now: () => Date.parse(fixedTime),
        collectAssignments: async () => [],
      },
    ),
    /Caller-supplied assignments/,
  );
});
