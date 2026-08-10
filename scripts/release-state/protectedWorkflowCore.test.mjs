import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  collectAndStorePrePromotionApprovals,
  preparePromotion,
} from "./promotionPreparation.mjs";
import {
  PROVIDER_ALIAS_OBSERVATION_KIND,
  decideProviderReconciliation,
  storeProviderAliasObservation,
} from "./reconcileDecision.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import { createStoredPrePromotionFixture } from "./prePromotionEvidenceTestFixture.mjs";

const namespace = "foundation-test";
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
const providerPolicy = {
  bindingStatus: "configured",
  expectedTeamId: "team-test",
  expectedProjectId: "project-test",
  ownedProductionDomains: ["a.example.test", "b.example.test"],
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
  },
};

class FakeReleaseStateStore {
  constructor() {
    this.namespace = namespace;
    this.records = [];
    this.evidence = new Map();
    this.compareAndAppendCalls = 0;
    this.closed = false;
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
    const eventHash = hashReleaseEvent(event);
    this.records.push({
      sequence: event.sequence,
      eventHash,
      previousHash: event.previousEventHash,
      event: structuredClone(event),
      committedAt: fixedTime,
    });
  }

  async compareAndAppend({ expectedSequence, expectedHash, event }) {
    this.compareAndAppendCalls += 1;
    const existing = this.records.find(
      ({ event: candidate }) => candidate.appendId === event.appendId,
    );
    if (existing) {
      if (
        !canonicalJsonBytes(existing.event).equals(canonicalJsonBytes(event))
      ) {
        throw new Error("append ID was reused with different bytes");
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
      throw new Error("CAS conflict");
    }
    this.seedEvent(event);
    return {
      namespace,
      sequence: event.sequence,
      eventHash: hashReleaseEvent(event),
      committedAt: fixedTime,
      replayed: false,
    };
  }

  async putEvidence({ bytes, mediaType }) {
    const objectBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(objectBytes);
    const replayed = this.evidence.has(sha256);
    const existing = this.evidence.get(sha256);
    if (existing && !existing.bytes.equals(objectBytes)) {
      throw new Error("evidence collision");
    }
    this.evidence.set(sha256, {
      bytes: objectBytes,
      mediaType,
      committedAt: fixedTime,
    });
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
      mediaType,
      byteLength: objectBytes.length,
      committedAt: fixedTime,
      replayed,
    };
  }

  async readEvidence({ sha256 }) {
    const value = this.evidence.get(sha256);
    return value
      ? {
          bytes: Buffer.from(value.bytes),
          mediaType: value.mediaType,
          committedAt: value.committedAt,
        }
      : null;
  }

  async close() {
    this.closed = true;
  }
}

const putJson = async (store, value, mediaType = "application/json") => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putProviderReceiptReferences = async (
  store,
  assignments,
  providerProjectId = "project-test",
) => {
  const references = [];
  for (const assignment of assignments) {
    const responseBytes = Buffer.from(
      JSON.stringify({
        alias: assignment.productionDomain,
        projectId: providerProjectId,
        deploymentId: assignment.assignedDeploymentId,
      }),
    );
    const response = await store.putEvidence({
      bytes: responseBytes,
      mediaType: "application/vnd.vercel.alias-response+json",
    });
    const responseReference = {
      uri: response.uri,
      sha256: response.sha256,
    };
    const requestUrl =
      `https://api.vercel.com/v4/aliases/${assignment.productionDomain}` +
      "?teamId=team-test";
    const receipt = await store.putEvidence({
      bytes: canonicalJsonBytes({
        schemaVersion: 1,
        receiptKind: "vercel-alias-read-receipt/v1",
        productionDomain: assignment.productionDomain,
        providerProjectId,
        providerDeploymentId: assignment.assignedDeploymentId,
        requestUrl,
        responseUrl: requestUrl,
        status: 200,
        providerDate: fixedTime,
        responseSha256: response.sha256,
        responseReference,
      }),
      mediaType:
        "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1",
    });
    references.push({ uri: receipt.uri, sha256: receipt.sha256 });
  }
  return references.sort((left, right) =>
    Buffer.compare(Buffer.from(left.uri), Buffer.from(right.uri)),
  );
};

const createBinding = async ({
  store,
  role,
  suffix,
  policyRef,
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
  const bindingWithoutEvidence = {
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
    releasePolicy: policyRef,
    providerPolicy: providerPolicyReference,
    providerConfigurationHash: "6".repeat(64),
    requiredDbCompatibility: dbCompatibility,
  };
  const providerEvidence = await putJson(store, {
    schemaVersion: 1,
    providerProjectId: bindingWithoutEvidence.providerProjectId,
    providerDeploymentId: bindingWithoutEvidence.providerDeploymentId,
    deploymentUrl: bindingWithoutEvidence.deploymentUrl,
    sourceSha,
    variantId: bindingWithoutEvidence.variantId,
    releaseRole: role,
    artifactManifestHash: artifactManifest.sha256,
    packageIndexHash: packageIndex.sha256,
    providerConfigurationHash: bindingWithoutEvidence.providerConfigurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: policyRef.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentity: {
      identityKind: publicIdentityKind,
    },
    routeProbeEvidenceHash: "7".repeat(64),
    environmentPresenceEvidenceHash: "8".repeat(64),
  });
  return {
    ...bindingWithoutEvidence,
    providerEvidence,
  };
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
  const policyRef = prePromotion.releasePolicyReference;
  const bootstrap = await createBinding({
    store,
    role: "containment",
    suffix: "b",
    policyRef,
    publicIdentityKind: "legacy-bootstrap-v1",
  });
  const initialEvidence = await putJson(store, {
    kind: "initial-evidence",
  });
  const initial = createReleaseEvent({
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
      minimumSafetyFloors: {
        releaseChannel: "release-a",
      },
      currentDbCompatibility: dbCompatibility,
      activeReleasePolicy: policyRef,
      phaseExitAttestationSeed,
    },
    evidenceRefs: [initialEvidence, ...phaseExitAttestationReferences],
  });
  store.seedEvent(initial);
  const current = await readCurrentReleaseState({ store });
  return {
    store,
    policyRef,
    bootstrap,
    current,
    prePromotion,
  };
};

const createPromotionFixture = async () => {
  const fixture = await initializeFixture();
  const targetBinding = fixture.prePromotion.standard;
  const companionBinding = fixture.prePromotion.containment;
  const subject = {
    schemaVersion: 1,
    subjectKind: "promotion-preparation-subject/v1",
    namespace,
    operationId: "promote-fixture",
    operationKind: "promote-standard",
    expectedState: {
      sequence: fixture.current.snapshot.sequence,
      eventHash: fixture.current.snapshot.eventHash,
    },
    targetBinding,
    companionBinding,
    previousBinding: null,
    emergencyRecoveryBinding: fixture.bootstrap,
    evidenceRefs: Object.values(fixture.prePromotion.namedEvidence).sort(
      (left, right) =>
        Buffer.compare(Buffer.from(left.uri), Buffer.from(right.uri)),
    ),
  };
  return {
    ...fixture,
    targetBinding,
    companionBinding,
    subject,
    subjectBytes: canonicalJsonBytes(subject),
    subjectSha256: sha256Bytes(canonicalJsonBytes(subject)),
  };
};

const approvalPolicy = {
  bindingStatus: "configured",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  protectedEnvironment: "foundation-release-state",
};

const createApprovalCollector = () => {
  let calls = 0;
  const collect = async ({
    store,
    namespace: boundNamespace,
    operationId,
    subjectSha256,
  }) => {
    calls += 1;
    assert.equal(boundNamespace, namespace);
    const issuer = await store.putEvidence({
      bytes: canonicalJsonBytes({ kind: "verified-oidc" }),
      mediaType: "application/json",
    });
    const approvalRefs = [];
    for (const [role, suffix] of [
      ["releaseOwner", "1"],
      ["dataSafetyReviewer", "2"],
    ]) {
      const receipt = await store.putEvidence({
        bytes: canonicalJsonBytes({ kind: "verified-approval", role }),
        mediaType: "application/json",
      });
      approvalRefs.push({
        uri: receipt.uri,
        sha256: receipt.sha256,
        approvalId: `approval-${suffix}`,
        operationId,
        subjectSha256,
        trustedIssuer: approvalPolicy.trustedIssuer,
        issuerReceiptUri: issuer.uri,
        issuerReceiptSha256: issuer.sha256,
        workflowRunId: "100",
        protectedEnvironment: approvalPolicy.protectedEnvironment,
        providerReviewerId: `reviewer-${suffix}`,
        role,
        decision: "APPROVED",
        approvedAt: fixedTime,
      });
    }
    return {
      approvalRefs,
      issuerReceiptReference: {
        uri: issuer.uri,
        sha256: issuer.sha256,
      },
      verifiedAt: fixedTime,
    };
  };
  return {
    collect,
    get calls() {
      return calls;
    },
  };
};

test("rereads the head and replays immutable events instead of accepting a snapshot", async () => {
  const { store, current } = await initializeFixture();
  assert.equal(current.snapshot.sequence, 1);
  assert.equal(current.snapshot.bootstrapRecovery.releaseRole, "containment");
  assert.equal(Object.isFrozen(current.snapshot), true);

  const originalReadHead = store.readHead.bind(store);
  let reads = 0;
  store.readHead = async () => {
    reads += 1;
    const head = await originalReadHead();
    return reads === 2
      ? { sequence: head.sequence + 1, eventHash: "f".repeat(64) }
      : head;
  };
  await assert.rejects(
    readCurrentReleaseState({ store }),
    /head changed during replay/,
  );
});

test("stores authoritative approval receipts and derives exactly the two pre-promotion roles", async () => {
  const store = new FakeReleaseStateStore();
  const oidcReceipt = {
    verifiedAt: fixedTime,
    claims: {
      sourceSha,
      runId: "100",
    },
  };
  const candidates = [
    {
      authoritativeRole: "releaseOwner",
      reviewer: "reviewer-1",
      receiptBytes: canonicalJsonBytes({
        reviewer: "reviewer-1",
        roleClaim: "operationsReviewer",
      }),
    },
    {
      authoritativeRole: "dataSafetyReviewer",
      reviewer: "reviewer-2",
      receiptBytes: canonicalJsonBytes({
        reviewer: "reviewer-2",
        roleClaim: "releaseOwner",
      }),
    },
    {
      authoritativeRole: "operationsReviewer",
      reviewer: "reviewer-3",
      receiptBytes: canonicalJsonBytes({
        reviewer: "reviewer-3",
        roleClaim: "releaseOwner",
      }),
    },
  ];
  const subjectSha256 = "9".repeat(64);
  const result = await collectAndStorePrePromotionApprovals(
    {
      store,
      namespace,
      policy: {
        ...approvalPolicy,
        oidcAudience: "urn:test",
      },
      operationId: "promote-fixture",
      subjectSha256,
      expectedSourceSha: sourceSha,
      expectedRunId: "100",
      oidcRequestUrl: "https://token.actions.githubusercontent.com/test",
      oidcRequestToken: "token",
      githubToken: "github-token",
    },
    {
      requestOidcToken: async () => "signed-token",
      verifyOidcToken: async () => ({
        receipt: oidcReceipt,
        receiptBytes: canonicalJsonBytes(oidcReceipt),
      }),
      fetchApprovals: async () => candidates,
      resolveApproval: ({
        receiptReference,
        issuerReceiptReference,
        verifiedApprovalResult,
        operationId,
      }) => ({
        uri: receiptReference.uri,
        sha256: receiptReference.sha256,
        approvalId: `approval-${verifiedApprovalResult.reviewer}`,
        operationId,
        subjectSha256,
        trustedIssuer: approvalPolicy.trustedIssuer,
        issuerReceiptUri: issuerReceiptReference.uri,
        issuerReceiptSha256: issuerReceiptReference.sha256,
        workflowRunId: "100",
        protectedEnvironment: approvalPolicy.protectedEnvironment,
        providerReviewerId: verifiedApprovalResult.reviewer,
        role: verifiedApprovalResult.authoritativeRole,
        decision: "APPROVED",
        approvedAt: fixedTime,
      }),
    },
  );
  assert.deepEqual(
    result.approvalRefs.map(({ role }) => role),
    ["releaseOwner", "dataSafetyReviewer"],
  );
  assert.equal(store.evidence.size, 4);
  assert.equal(
    result.approvalRefs.some(({ role }) => role === "operationsReviewer"),
    false,
  );
});

test("appends promotion-prepared once and replays the deterministic operation retry", async () => {
  const fixture = await createPromotionFixture();
  const collector = createApprovalCollector();
  const options = {
    store: fixture.store,
    subjectBytes: fixture.subjectBytes,
    expectedSubjectSha256: fixture.subjectSha256,
    approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: "100",
    oidcRequestUrl: "https://token.actions.githubusercontent.com/test",
    oidcRequestToken: "token",
    githubToken: "github-token",
  };
  const first = await preparePromotion(options, {
    collectApprovals: collector.collect,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.event.eventType, "promotion-prepared");
  assert.equal(first.event.payload.pendingOperation.kind, "promote-standard");
  assert.deepEqual(
    first.approvalRefs.map(({ role }) => role),
    ["releaseOwner", "dataSafetyReviewer"],
  );
  assert.equal(fixture.store.compareAndAppendCalls, 1);

  const second = await preparePromotion(options, {
    collectApprovals: collector.collect,
  });
  assert.equal(second.replayed, true);
  assert.equal(second.eventHash, first.eventHash);
  assert.equal(fixture.store.compareAndAppendCalls, 1);
  assert.equal(collector.calls, 1);

  const replayed = await readCurrentReleaseState({ store: fixture.store });
  assert.equal(
    replayed.snapshot.pendingOperation.operationId,
    fixture.subject.operationId,
  );
});

test("forbids caller-supplied snapshots, approval roles, and stale operation subjects", async () => {
  const fixture = await createPromotionFixture();
  const collector = createApprovalCollector();
  const base = {
    store: fixture.store,
    subjectBytes: fixture.subjectBytes,
    expectedSubjectSha256: fixture.subjectSha256,
    approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: "100",
  };
  await assert.rejects(
    preparePromotion(
      { ...base, snapshot: fixture.current.snapshot },
      { collectApprovals: collector.collect },
    ),
    /Caller-supplied snapshot is forbidden/,
  );
  await assert.rejects(
    preparePromotion(
      { ...base, roles: ["releaseOwner", "dataSafetyReviewer"] },
      { collectApprovals: collector.collect },
    ),
    /Caller-supplied roles is forbidden/,
  );
  const staleBytes = canonicalJsonBytes({
    ...fixture.subject,
    expectedState: {
      ...fixture.subject.expectedState,
      eventHash: "0".repeat(64),
    },
  });
  await assert.rejects(
    preparePromotion(
      { ...base, subjectBytes: staleBytes },
      {
        collectApprovals: collector.collect,
      },
    ),
    /reviewed subject SHA-256/,
  );
  await assert.rejects(
    preparePromotion(
      {
        ...base,
        subjectBytes: staleBytes,
        expectedSubjectSha256: sha256Bytes(staleBytes),
      },
      { collectApprovals: collector.collect },
    ),
    /does not bind the replayed Release State head/,
  );
});

test("produces a read-only reconcile plan only for an exact all-domain target match", async () => {
  const fixture = await createPromotionFixture();
  const collector = createApprovalCollector();
  await preparePromotion(
    {
      store: fixture.store,
      subjectBytes: fixture.subjectBytes,
      expectedSubjectSha256: fixture.subjectSha256,
      approvalPolicy,
      expectedSourceSha: sourceSha,
      expectedRunId: "100",
    },
    { collectApprovals: collector.collect },
  );
  const assignments = [
    {
      productionDomain: "a.example.test",
      assignedDeploymentId: fixture.targetBinding.providerDeploymentId,
    },
    {
      productionDomain: "b.example.test",
      assignedDeploymentId: fixture.targetBinding.providerDeploymentId,
    },
  ];
  const observation = {
    schemaVersion: 1,
    observationKind: PROVIDER_ALIAS_OBSERVATION_KIND,
    namespace,
    providerProjectId: "project-test",
    assignments,
    observedBinding: fixture.targetBinding,
    providerReceiptReferences: await putProviderReceiptReferences(
      fixture.store,
      assignments,
    ),
  };
  const observationBytes = canonicalJsonBytes(observation);
  await storeProviderAliasObservation({
    store: fixture.store,
    observationBytes,
  });
  const decision = await decideProviderReconciliation(
    {
      store: fixture.store,
      observationBytes,
    },
    { now: () => Date.parse(fixedTime) },
  );
  assert.equal(decision.status, "ready");
  assert.equal(decision.action, "append-state-reconciled");
  assert.equal(decision.eventPlan.payload.snapshotPatch, undefined);
  await assert.rejects(
    decideProviderReconciliation({
      store: fixture.store,
      observationBytes,
      providerPolicy: { ...providerPolicy, expectedProjectId: "attacker" },
    }),
    /Caller-supplied snapshot or provider policy is forbidden/,
  );

  const current = await readCurrentReleaseState({ store: fixture.store });
  const reconciled = createReleaseEvent({
    namespace,
    sequence: current.snapshot.sequence + 1,
    eventType: decision.eventPlan.eventType,
    operationId: decision.eventPlan.operationId,
    previousEventHash: current.snapshot.eventHash,
    payload: decision.eventPlan.payload,
    evidenceRefs: decision.eventPlan.evidenceRefs,
  });
  assert.equal(
    reduceReleaseState(current.snapshot, reconciled).pendingOperation
      .operationId,
    fixture.subject.operationId,
  );
  const handEdited = createReleaseEvent({
    namespace,
    sequence: current.snapshot.sequence + 1,
    eventType: "state-reconciled",
    operationId: fixture.subject.operationId,
    previousEventHash: current.snapshot.eventHash,
    payload: {
      snapshotPatch: {
        pendingOperation: null,
      },
    },
  });
  assert.throws(
    () => reduceReleaseState(current.snapshot, handEdited),
    /cannot contain a snapshot patch/,
  );
});

test("fails reconcile closed for partial, ambiguous, and unknown assignments", async () => {
  const fixture = await createPromotionFixture();
  const collector = createApprovalCollector();
  await preparePromotion(
    {
      store: fixture.store,
      subjectBytes: fixture.subjectBytes,
      expectedSubjectSha256: fixture.subjectSha256,
      approvalPolicy,
      expectedSourceSha: sourceSha,
      expectedRunId: "100",
    },
    { collectApprovals: collector.collect },
  );
  const cases = [
    {
      expected: "partial-production-domain-set",
      assignments: [
        {
          productionDomain: "a.example.test",
          assignedDeploymentId: fixture.targetBinding.providerDeploymentId,
        },
      ],
      observedBinding: fixture.targetBinding,
    },
    {
      expected: "ambiguous-provider-assignment",
      assignments: [
        {
          productionDomain: "a.example.test",
          assignedDeploymentId: fixture.targetBinding.providerDeploymentId,
        },
        {
          productionDomain: "b.example.test",
          assignedDeploymentId: "deployment-unknown",
        },
      ],
      observedBinding: fixture.targetBinding,
    },
    {
      expected: "unknown-provider-deployment",
      assignments: [
        {
          productionDomain: "a.example.test",
          assignedDeploymentId: "deployment-unknown",
        },
        {
          productionDomain: "b.example.test",
          assignedDeploymentId: "deployment-unknown",
        },
      ],
      observedBinding: null,
    },
  ];
  for (const fixtureCase of cases) {
    const bytes = canonicalJsonBytes({
      schemaVersion: 1,
      observationKind: PROVIDER_ALIAS_OBSERVATION_KIND,
      namespace,
      providerProjectId: "project-test",
      assignments: fixtureCase.assignments,
      observedBinding: fixtureCase.observedBinding,
      providerReceiptReferences: await putProviderReceiptReferences(
        fixture.store,
        fixtureCase.assignments,
      ),
    });
    await storeProviderAliasObservation({
      store: fixture.store,
      observationBytes: bytes,
    });
    const decision = await decideProviderReconciliation(
      {
        store: fixture.store,
        observationBytes: bytes,
      },
      { now: () => Date.parse(fixedTime) },
    );
    assert.equal(decision.status, "blocked");
    assert.equal(decision.action, null);
    assert.ok(decision.reasonCodes.includes(fixtureCase.expected));
    assert.equal(decision.eventPlan, null);
  }
});
