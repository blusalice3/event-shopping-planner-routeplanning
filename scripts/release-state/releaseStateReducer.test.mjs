import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
  replayReleaseEvents,
} from "./releaseStateReducer.mjs";
import {
  assertReleaseEventMatchesSchema,
  assertReleaseStateSnapshotMatchesSchema,
} from "./releaseStateSchema.mjs";

const sha = (character) => character.repeat(64);
const sourceSha = "a".repeat(40);
const namespace = "foundation-test";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const releaseStateSchema = JSON.parse(
  await readFile(
    path.join(root, "config", "release-state.schema.json"),
    "utf8",
  ),
);
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: sha("d"),
};
const nextDbCompatibility = {
  contractUri: "urn:test:db:v2",
  fingerprint: sha("e"),
};
const objectRef = (character) => ({
  uri: `release-state://${namespace}/evidence/${sha(character)}`,
  sha256: sha(character),
});
const eventRef = (sequence, character) => ({
  uri: `release-state://${namespace}/events/${sequence}/` + sha(character),
  sha256: sha(character),
});
const policyRef = objectRef("1");
const phaseExitAttestationSeed = Object.freeze([
  {
    gate: "P0-BASELINE",
    sourceSha,
    subjectKind: "repository-phase-subject/v1",
    attestation: objectRef("a"),
    predecessor: null,
  },
  {
    gate: "P0-TOOLCHAIN",
    sourceSha,
    subjectKind: "repository-phase-subject/v1",
    attestation: objectRef("b"),
    predecessor: objectRef("a"),
  },
  {
    gate: "P0-ARTIFACT",
    sourceSha,
    subjectKind: "disposable-drill-subject/v1",
    attestation: objectRef("d"),
    predecessor: objectRef("b"),
  },
]);
const phaseExitSeedEvidence = phaseExitAttestationSeed.map(
  ({ attestation }) => attestation,
);

const binding = (role, suffix, bindingSourceSha = sourceSha) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha: bindingSourceSha,
  buildId: bindingSourceSha,
  variantId: sha(suffix),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${role}-${suffix}`,
  deploymentUrl: `https://${role}-${suffix}.example.test`,
  artifactArchive: objectRef("7"),
  artifactArchiveAvailability: objectRef("8"),
  packageIndex: objectRef("2"),
  artifactManifest: objectRef("3"),
  providerEvidence: objectRef("4"),
  releasePolicy: policyRef,
  providerPolicy: objectRef("5"),
  providerConfigurationHash: sha("6"),
  requiredDbCompatibility: dbCompatibility,
});

const approval = (operationId, role, suffix) => ({
  uri: `release-state://${namespace}/evidence/${sha(suffix)}`,
  sha256: sha(suffix),
  approvalId: `approval-${suffix}`,
  operationId,
  subjectSha256: sha("7"),
  trustedIssuer: "https://token.actions.githubusercontent.com",
  issuerReceiptUri: `release-state://${namespace}/evidence/${sha("8")}`,
  issuerReceiptSha256: sha("8"),
  workflowRunId: `run-${suffix}`,
  protectedEnvironment: "foundation-release-state",
  providerReviewerId: `reviewer-${suffix}`,
  role,
  decision: "APPROVED",
  approvedAt: "2026-08-01T00:00:00.000Z",
});

const appendEvent = (
  snapshot,
  eventType,
  operationId,
  payload,
  approvals = [],
  evidenceRefs = [objectRef("9")],
) =>
  createReleaseEvent({
    namespace,
    sequence: snapshot === null ? 1 : snapshot.sequence + 1,
    eventType,
    operationId,
    previousEventHash: snapshot?.eventHash ?? null,
    payload,
    evidenceRefs,
    approvalRefs: approvals,
  });

const currentHeadRef = (snapshot) => ({
  uri:
    `release-state://${namespace}/events/${snapshot.sequence}/` +
    snapshot.eventHash,
  sha256: snapshot.eventHash,
});

const initializeState = () => {
  const bootstrap = {
    ...binding("containment", "b"),
    publicIdentityKind: "legacy-bootstrap-v1",
  };
  const event = appendEvent(
    null,
    "state-initialized",
    "initialize",
    {
      acceptedGate: null,
      executorSourceSha: sourceSha,
      legacyObservedProduction: {
        observationUri: objectRef("c").uri,
        observationSha256: sha("c"),
      },
      bootstrapRecovery: bootstrap,
      minimumSafetyFloors: {
        releaseChannel: "release-a",
        legacyLocalStorageCleanup: "forced-off",
      },
      currentDbCompatibility: dbCompatibility,
      activeReleasePolicy: policyRef,
      phaseExitAttestationSeed,
    },
    [],
    phaseExitSeedEvidence,
  );
  return reduceReleaseState(null, event);
};

const inventoryEntry = (
  standard,
  actions = ["package-redeploy", "rollback"],
) => ({
  binding: standard,
  acceptedEvent: objectRef("4"),
  acceptedGate: "P0-RELEASE",
  acceptedStandardFloors: { pwaLifecycle: "outer-agent-v1" },
  evaluatedPolicy: policyRef,
  eligibleActions: actions,
  eligibility: actions.length === 0 ? "ineligible" : "eligible",
  reasonCodes: [],
});

const prepareOperation = (
  snapshot,
  {
    operationId,
    kind,
    targetBinding,
    companionBinding = null,
    originBinding = null,
    originCompanionBinding = null,
    emergencyRecoveryBinding = snapshot.bootstrapRecovery,
  },
) => {
  const approvals = [
    approval(operationId, "releaseOwner", "a"),
    approval(operationId, "dataSafetyReviewer", "b"),
  ];
  const event = appendEvent(
    snapshot,
    "promotion-prepared",
    operationId,
    {
      pendingOperation: {
        operationId,
        kind,
        expectedState: {
          sequence: snapshot.sequence,
          eventHash: snapshot.eventHash,
        },
        targetBinding,
        originBinding,
        originCompanionBinding,
        companionBinding,
        previousBinding: snapshot.activeProduction,
        emergencyRecoveryBinding,
        approvalRefs: approvals,
        preparedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    approvals,
  );
  return reduceReleaseState(snapshot, event);
};

const advanceAssignmentLifecycle = (
  snapshot,
  {
    operationId = snapshot.pendingOperation?.operationId,
    targetBinding = snapshot.pendingOperation?.targetBinding,
    assignmentReceipt = objectRef("c"),
    promotionReceipt = objectRef("d"),
    assignmentValidation = objectRef("e"),
    productionProbe = objectRef("f"),
  } = {},
) => {
  if (snapshot.pendingOperation?.reconciliationAuthority !== undefined) {
    const authority = snapshot.pendingOperation.reconciliationAuthority;
    return reduceReleaseState(
      snapshot,
      appendEvent(
        snapshot,
        "assignment-validated",
        operationId,
        {
          reconciliationKind: authority.reconciliationKind,
          providerObservation: authority.providerObservation,
          stateReconciled: authority.stateReconciled,
          targetBinding,
        },
        [],
        [currentHeadRef(snapshot), authority.providerObservation],
      ),
    );
  }
  let current = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "deployment-assigned",
      operationId,
      { assignmentReceipt, promotionReceipt, targetBinding },
      [],
      [currentHeadRef(snapshot)],
    ),
  );
  current = reduceReleaseState(
    current,
    appendEvent(
      current,
      "assignment-validated",
      operationId,
      {
        assignmentReceipt,
        assignmentValidation,
        productionProbe,
        targetBinding,
      },
      [],
      [currentHeadRef(current)],
    ),
  );
  return current;
};

const appendRecoveryTerminal = (snapshot, eventType, payload, options = {}) =>
  appendEvent(
    snapshot,
    eventType,
    options.operationId ?? snapshot.pendingOperation?.operationId,
    payload,
    options.approvals ?? snapshot.pendingOperation?.approvalRefs,
    options.evidenceRefs ?? [currentHeadRef(snapshot)],
  );

test("appends the exact next formal phase exit after the pre-initialization seed", () => {
  const snapshot = initializeState();
  const operationId = "attest-p0-data";
  const attestation = objectRef("e");
  const predecessor = phaseExitAttestationSeed.at(-1).attestation;
  const payload = {
    gate: "P0-DATA",
    sourceSha,
    subjectKind: "state-initialized-bootstrap-subject/v1",
    attestation,
    predecessor,
  };
  const event = appendEvent(
    snapshot,
    "phase-exit-attested",
    operationId,
    payload,
    [],
    [attestation, predecessor],
  );

  const next = reduceReleaseState(snapshot, event);
  assert.equal(next.phaseExitAttestations.length, 4);
  assert.deepEqual(next.phaseExitAttestations.at(-1), payload);

  const eventWithApproval = appendEvent(
    snapshot,
    "phase-exit-attested",
    operationId,
    payload,
    [approval(operationId, "releaseOwner", "f")],
    [attestation, predecessor],
  );
  assert.throws(
    () => reduceReleaseState(snapshot, eventWithApproval),
    /event evidence differs from its chain links/,
  );
});

test("builds a source-hardened standard acceptance through the event chain", () => {
  let snapshot = initializeState();
  const standard = binding("standard", "e");
  const companion = binding("containment", "f");
  const operationId = "promote-standard-test";
  const preApprovals = [
    approval(operationId, "releaseOwner", "a"),
    approval(operationId, "dataSafetyReviewer", "b"),
  ];
  const prepared = appendEvent(
    snapshot,
    "promotion-prepared",
    operationId,
    {
      pendingOperation: {
        operationId,
        kind: "promote-standard",
        expectedState: {
          sequence: snapshot.sequence,
          eventHash: snapshot.eventHash,
        },
        targetBinding: standard,
        originBinding: null,
        originCompanionBinding: null,
        companionBinding: companion,
        previousBinding: null,
        emergencyRecoveryBinding: snapshot.bootstrapRecovery,
        approvalRefs: preApprovals,
        preparedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    preApprovals,
  );
  snapshot = reduceReleaseState(snapshot, prepared);
  assert.equal(snapshot.pendingOperation?.operationId, operationId);

  snapshot = advanceAssignmentLifecycle(snapshot);

  const observationStartedEvent = objectRef("f");
  const observation = appendEvent(
    snapshot,
    "observation-started",
    operationId,
    {
      pendingAcceptance: {
        operationId,
        standardBinding: standard,
        companionBinding: companion,
        assignmentValidationEvidence: objectRef("0"),
        observationStartedEvent,
        observationNotBefore: "2026-08-01T00:00:00.000Z",
        minimumObservationEndsAt: "2026-08-02T00:00:00.000Z",
      },
    },
  );
  snapshot = reduceReleaseState(snapshot, observation);
  assert.equal(snapshot.activeProduction?.bindingId, standard.bindingId);

  const acceptanceApprovals = [
    approval(operationId, "releaseOwner", "1"),
    approval(operationId, "dataSafetyReviewer", "2"),
    approval(operationId, "operationsReviewer", "3"),
  ];
  const accepted = appendEvent(
    snapshot,
    "release-accepted",
    operationId,
    {
      acceptedGate: "P0-RELEASE",
      releaseRole: "standard",
      observedThrough: "2026-08-02T00:00:01.000Z",
      acceptedStandardFloors: {
        pwaLifecycle: "legacy-auto-update-v1",
      },
      rollbackInventory: [],
      clearBootstrapRecovery: false,
    },
    acceptanceApprovals,
  );
  snapshot = reduceReleaseState(snapshot, accepted);
  assert.equal(snapshot.acceptedStandard?.bindingId, standard.bindingId);
  assert.equal(snapshot.containmentCompanion?.bindingId, companion.bindingId);
  assert.equal(snapshot.pendingOperation, null);
  assert.equal(snapshot.pendingAcceptance, null);
  assert.equal(snapshot.legacyObservedProduction, null);
});

test("allows only a distinct source binding to replace an accepted standard at the exact same floor", () => {
  const floors = { pwaLifecycle: "legacy-auto-update-v1" };
  const stageAcceptance = ({
    snapshot,
    standard,
    companion,
    operationId: stagedOperationId,
  }) => {
    let staged = prepareOperation(snapshot, {
      operationId: stagedOperationId,
      kind: "promote-standard",
      targetBinding: standard,
      companionBinding: companion,
    });
    staged = advanceAssignmentLifecycle(staged);
    return reduceReleaseState(
      staged,
      appendEvent(staged, "observation-started", stagedOperationId, {
        pendingAcceptance: {
          operationId: stagedOperationId,
          standardBinding: standard,
          companionBinding: companion,
          assignmentValidationEvidence: objectRef("0"),
          observationStartedEvent: objectRef("f"),
          observationNotBefore: "2026-08-01T00:00:00.000Z",
          minimumObservationEndsAt: "2026-08-02T00:00:00.000Z",
        },
      }),
    );
  };
  const acceptanceEvent = ({
    snapshot,
    operationId: acceptedOperationId,
    acceptedGate = "P0-RELEASE",
    acceptedFloors = floors,
    rollbackInventory = [],
  }) =>
    appendEvent(
      snapshot,
      "release-accepted",
      acceptedOperationId,
      {
        acceptedGate,
        releaseRole: "standard",
        observedThrough: "2026-08-02T00:00:01.000Z",
        acceptedStandardFloors: acceptedFloors,
        rollbackInventory,
        clearBootstrapRecovery: false,
      },
      [
        approval(acceptedOperationId, "releaseOwner", "1"),
        approval(acceptedOperationId, "dataSafetyReviewer", "2"),
        approval(acceptedOperationId, "operationsReviewer", "3"),
      ],
    );

  const firstStandard = binding("standard", "a");
  const firstCompanion = binding("containment", "b");
  const firstOperationId = "accept-source-a";
  const firstPending = stageAcceptance({
    snapshot: initializeState(),
    standard: firstStandard,
    companion: firstCompanion,
    operationId: firstOperationId,
  });
  const firstAccepted = reduceReleaseState(
    firstPending,
    acceptanceEvent({
      snapshot: firstPending,
      operationId: firstOperationId,
    }),
  );

  const secondSourceSha = "b".repeat(40);
  const secondStandard = binding("standard", "4", secondSourceSha);
  const secondCompanion = binding("containment", "5", secondSourceSha);
  const secondOperationId = "accept-source-b";
  const secondPending = stageAcceptance({
    snapshot: firstAccepted,
    standard: secondStandard,
    companion: secondCompanion,
    operationId: secondOperationId,
  });
  const priorInventory = [
    {
      ...inventoryEntry(firstStandard),
      acceptedStandardFloors: floors,
    },
  ];

  for (const [label, acceptedGate, acceptedFloors] of [
    ["floor drift", "P0-RELEASE", { pwaLifecycle: "prompt-close-all-v1" }],
    ["gate skip", "P2A-LOCAL", floors],
    ["gate regression", "P0-PROMOTE", floors],
  ]) {
    assert.throws(
      () =>
        reduceReleaseState(
          secondPending,
          acceptanceEvent({
            snapshot: secondPending,
            operationId: secondOperationId,
            acceptedGate,
            acceptedFloors,
            rollbackInventory: priorInventory,
          }),
        ),
      /neither advances exactly one phase gate nor replaces the current source at the same floor/,
      label,
    );
  }

  const sameSourceOperationId = "reject-same-source-build";
  const sameSourcePending = stageAcceptance({
    snapshot: firstAccepted,
    standard: binding("standard", "6"),
    companion: binding("containment", "7"),
    operationId: sameSourceOperationId,
  });
  assert.throws(
    () =>
      reduceReleaseState(
        sameSourcePending,
        acceptanceEvent({
          snapshot: sameSourcePending,
          operationId: sameSourceOperationId,
          rollbackInventory: priorInventory,
        }),
      ),
    /neither advances exactly one phase gate nor replaces the current source at the same floor/,
  );

  for (const [label, suffix, companionSuffix, reusedIdentity] of [
    ["binding ID", "8", "9", { bindingId: firstStandard.bindingId }],
    [
      "provider deployment ID",
      "c",
      "d",
      { providerDeploymentId: firstStandard.providerDeploymentId },
    ],
    [
      "deployment URL",
      "e",
      "f",
      { deploymentUrl: firstStandard.deploymentUrl },
    ],
  ]) {
    const rejectedOperationId = `reject-reused-${suffix}`;
    const rejectedPending = stageAcceptance({
      snapshot: firstAccepted,
      standard: {
        ...binding("standard", suffix, secondSourceSha),
        ...reusedIdentity,
      },
      companion: binding("containment", companionSuffix, secondSourceSha),
      operationId: rejectedOperationId,
    });
    assert.throws(
      () =>
        reduceReleaseState(
          rejectedPending,
          acceptanceEvent({
            snapshot: rejectedPending,
            operationId: rejectedOperationId,
            rollbackInventory: priorInventory,
          }),
        ),
      label === "binding ID"
        ? /Accepted standard must not remain in the rollback inventory/
        : /neither advances exactly one phase gate nor replaces the current source at the same floor/,
      label,
    );
  }

  const terminalPending = stageAcceptance({
    snapshot: { ...firstAccepted, acceptedGate: "P8-CLEAN" },
    standard: binding("standard", "e", secondSourceSha),
    companion: binding("containment", "f", secondSourceSha),
    operationId: "reject-terminal-same-floor",
  });
  assert.throws(
    () =>
      reduceReleaseState(
        terminalPending,
        acceptanceEvent({
          snapshot: terminalPending,
          operationId: "reject-terminal-same-floor",
          acceptedGate: "P8-CLEAN",
          rollbackInventory: priorInventory,
        }),
      ),
    /Terminal P8-CLEAN does not permit a same-floor accepted standard replacement/u,
  );

  const secondAccepted = reduceReleaseState(
    secondPending,
    acceptanceEvent({
      snapshot: secondPending,
      operationId: secondOperationId,
      rollbackInventory: priorInventory,
    }),
  );
  assert.equal(secondAccepted.acceptedGate, "P0-RELEASE");
  assert.deepEqual(secondAccepted.acceptedStandardFloors, floors);
  assert.equal(secondAccepted.acceptedStandard?.bindingId, "standard-4");
  assert.equal(secondAccepted.rollbackInventory.length, 1);
  assert.equal(
    secondAccepted.rollbackInventory[0].binding.bindingId,
    firstStandard.bindingId,
  );
});

test("accepts one reviewer filling both required promotion roles", () => {
  let snapshot = initializeState();
  const operationId = "invalid-approval";
  const standard = binding("standard", "1");
  const companion = binding("containment", "2");
  const first = approval(operationId, "releaseOwner", "3");
  const second = {
    ...approval(operationId, "dataSafetyReviewer", "4"),
    providerReviewerId: first.providerReviewerId,
  };
  const event = appendEvent(
    snapshot,
    "promotion-prepared",
    operationId,
    {
      pendingOperation: {
        operationId,
        kind: "promote-standard",
        expectedState: {
          sequence: snapshot.sequence,
          eventHash: snapshot.eventHash,
        },
        targetBinding: standard,
        originBinding: null,
        originCompanionBinding: null,
        companionBinding: companion,
        previousBinding: null,
        emergencyRecoveryBinding: snapshot.bootstrapRecovery,
        approvalRefs: [first, second],
        preparedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    [first, second],
  );
  const prepared = reduceReleaseState(snapshot, event);
  assert.equal(prepared.pendingOperation?.operationId, operationId);
  assert.deepEqual(
    prepared.pendingOperation?.approvalRefs.map(
      ({ providerReviewerId }) => providerReviewerId,
    ),
    [first.providerReviewerId, first.providerReviewerId],
  );

  const duplicateApprovalId = {
    ...second,
    approvalId: first.approvalId,
  };
  const duplicateEvent = appendEvent(
    snapshot,
    "promotion-prepared",
    operationId,
    {
      pendingOperation: {
        ...event.payload.pendingOperation,
        approvalRefs: [first, duplicateApprovalId],
      },
    },
    [first, duplicateApprovalId],
  );
  assert.throws(
    () => reduceReleaseState(snapshot, duplicateEvent),
    /Approval IDs must be distinct/,
  );

  const missingReviewer = {
    ...second,
    providerReviewerId: "",
  };
  const missingReviewerEvent = appendEvent(
    snapshot,
    "promotion-prepared",
    operationId,
    {
      pendingOperation: {
        ...event.payload.pendingOperation,
        approvalRefs: [first, missingReviewer],
      },
    },
    [first, missingReviewer],
  );
  assert.throws(
    () => reduceReleaseState(snapshot, missingReviewerEvent),
    /Approval identities must be non-empty strings/,
  );
});

test("rejects event tampering and a broken predecessor", () => {
  const snapshot = initializeState();
  const event = appendEvent(snapshot, "policy-activated", "policy", {
    activeReleasePolicy: objectRef("a"),
    minimumSafetyFloors: snapshot.minimumSafetyFloors,
    rollbackInventory: [],
  });
  assert.equal(hashReleaseEvent(event), hashReleaseEvent({ ...event }));
  assert.throws(
    () =>
      reduceReleaseState(snapshot, {
        ...event,
        payload: {
          ...event.payload,
          minimumSafetyFloors: {},
        },
      }),
    /payload hash mismatch/,
  );
  assert.throws(
    () =>
      reduceReleaseState(snapshot, {
        ...event,
        previousEventHash: sha("0"),
      }),
    /predecessor hash mismatch/,
  );
});

test("rejects a prepared operation that does not bind the current head", () => {
  const snapshot = initializeState();
  const operationId = "stale-preparation";
  const approvals = [
    approval(operationId, "releaseOwner", "a"),
    approval(operationId, "dataSafetyReviewer", "b"),
  ];
  const event = appendEvent(
    snapshot,
    "promotion-prepared",
    operationId,
    {
      pendingOperation: {
        operationId,
        kind: "promote-standard",
        expectedState: {
          sequence: snapshot.sequence - 1,
          eventHash: sha("0"),
        },
        targetBinding: binding("standard", "c"),
        originBinding: null,
        originCompanionBinding: null,
        companionBinding: binding("containment", "d"),
        previousBinding: null,
        emergencyRecoveryBinding: snapshot.bootstrapRecovery,
        approvalRefs: approvals,
        preparedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    approvals,
  );
  assert.throws(
    () => reduceReleaseState(snapshot, event),
    /does not bind the current Release State head/,
  );
});

test("rejects namespace changes while replaying one event chain", () => {
  const firstSnapshot = initializeState();
  const second = createReleaseEvent({
    namespace: "other-foundation",
    sequence: firstSnapshot.sequence + 1,
    eventType: "operation-aborted",
    operationId: "namespace-change",
    previousEventHash: firstSnapshot.eventHash,
    payload: {},
  });
  const initial = appendEvent(
    null,
    "state-initialized",
    "initialize",
    {
      acceptedGate: null,
      executorSourceSha: sourceSha,
      legacyObservedProduction: {
        observationUri: objectRef("c").uri,
        observationSha256: sha("c"),
      },
      bootstrapRecovery: firstSnapshot.bootstrapRecovery,
      minimumSafetyFloors: firstSnapshot.minimumSafetyFloors,
      currentDbCompatibility: firstSnapshot.currentDbCompatibility,
      activeReleasePolicy: firstSnapshot.activeReleasePolicy,
      phaseExitAttestationSeed,
    },
    [],
    phaseExitSeedEvidence,
  );
  assert.throws(
    () => replayReleaseEvents([initial, second]),
    /namespaces differ/,
  );
});

test("applies policy and DB compatibility changes with reviewed inventory", () => {
  let snapshot = initializeState();
  const standard = binding("standard", "a");
  const acceptedEvent = eventRef(snapshot.sequence, "4");
  snapshot = {
    ...snapshot,
    activeProduction: standard,
    acceptedStandard: standard,
    acceptedStandardEvent: acceptedEvent,
    acceptedGate: "P8-CLEAN",
  };
  const policyOperation = "activate-policy";
  const policyApprovals = [
    approval(policyOperation, "releaseOwner", "1"),
    approval(policyOperation, "dataSafetyReviewer", "2"),
    approval(policyOperation, "operationsReviewer", "3"),
  ];
  const policyClosureBundle = objectRef("a");
  const policyClosureEvidenceRefs = [
    objectRef("b"),
    objectRef("c"),
    objectRef("d"),
    objectRef("e"),
    objectRef("f"),
  ];
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "policy-activated",
      policyOperation,
      {
        activationGate: "P8-CLEAN",
        previousReleasePolicy: policyRef,
        proposedReleasePolicy: policyRef,
        activeReleasePolicy: policyRef,
        behaviorDimensionChange: null,
        minimumSafetyFloorChange: { styleSrcAttr: "none" },
        minimumSafetyFloors: {
          ...snapshot.minimumSafetyFloors,
          styleSrcAttr: "none",
        },
        activePolicyCompatibility: [],
        closureBundle: policyClosureBundle,
        closureEvidenceRefs: policyClosureEvidenceRefs,
        rollbackInventory: [inventoryEntry(standard)],
      },
      policyApprovals,
      [policyClosureBundle, ...policyClosureEvidenceRefs],
    ),
  );
  assert.deepEqual(snapshot.rollbackInventory, [inventoryEntry(standard)]);
  assert.deepEqual(snapshot.minimumSafetyFloors, {
    releaseChannel: "release-a",
    legacyLocalStorageCleanup: "forced-off",
    styleSrcAttr: "none",
  });

  const dbOperation = "activate-db-contract";
  const dbApprovals = [
    approval(dbOperation, "releaseOwner", "3"),
    approval(dbOperation, "dataSafetyReviewer", "4"),
  ];
  const nextStandard = {
    ...standard,
    requiredDbCompatibility: nextDbCompatibility,
  };
  snapshot = { ...snapshot, activeProduction: nextStandard };
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "db-contract-activated",
      dbOperation,
      {
        previousDbCompatibility: dbCompatibility,
        currentDbCompatibility: nextDbCompatibility,
        rollbackInventory: [inventoryEntry(nextStandard)],
      },
      dbApprovals,
    ),
  );
  assert.deepEqual(snapshot.currentDbCompatibility, nextDbCompatibility);
});

test("activates bootstrap containment, source-hardened containment, and rollback", () => {
  let snapshot = initializeState();
  const bootstrap = snapshot.bootstrapRecovery;
  snapshot = prepareOperation(snapshot, {
    operationId: "temporary-containment",
    kind: "promote-standard",
    targetBinding: binding("standard", "1"),
    companionBinding: binding("containment", "2"),
  });
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendRecoveryTerminal(snapshot, "temporary-containment-activated", {
      binding: bootstrap,
      activatedAt: "2026-08-01T00:00:00.000Z",
      recoveryDeadline: "2026-08-01T01:00:00.000Z",
      targetStandard: null,
    }),
  );
  assert.equal(snapshot.containmentIncident?.kind, "legacy-bootstrap");
  assert.equal(snapshot.standardRecovery?.targetStandard, null);

  const containment = binding("containment", "c");
  const targetStandard = binding("standard", "d");
  snapshot = {
    ...snapshot,
    acceptedStandard: targetStandard,
    acceptedStandardEvent: objectRef("4"),
    containmentCompanion: containment,
  };
  snapshot = prepareOperation(snapshot, {
    operationId: "source-hardened-containment",
    kind: "activate-containment",
    targetBinding: containment,
  });
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendRecoveryTerminal(snapshot, "containment-activated", {
      binding: containment,
      activatedAt: "2026-08-01T02:00:00.000Z",
      recoveryDeadline: "2026-08-01T03:00:00.000Z",
      targetStandard,
    }),
  );
  assert.equal(snapshot.containmentIncident?.kind, "source-hardened");
  assert.equal(
    snapshot.standardRecovery?.targetStandard.bindingId,
    targetStandard.bindingId,
  );

  const standard = binding("standard", "e");
  const companion = binding("containment", "f");
  const rollbackAuthority = inventoryEntry(standard).acceptedEvent;
  const displacedAuthority = objectRef("a");
  snapshot = {
    ...snapshot,
    acceptedStandardEvent: displacedAuthority,
    acceptedGate: "P0-RELEASE",
    acceptedStandardFloors: { pwaLifecycle: "outer-agent-v1" },
    rollbackInventory: [inventoryEntry(standard)],
  };
  snapshot = prepareOperation(snapshot, {
    operationId: "rollback",
    kind: "rollback-standard",
    targetBinding: standard,
    companionBinding: companion,
  });
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendRecoveryTerminal(
      snapshot,
      "rollback-activated",
      {
        binding: standard,
        companionBinding: companion,
        rollbackInventory: [
          {
            ...inventoryEntry(targetStandard),
            acceptedEvent: displacedAuthority,
          },
        ],
        originAcceptedEvent: rollbackAuthority,
        originAcceptedGate: "P0-RELEASE",
        originAcceptedStandardFloors: { pwaLifecycle: "outer-agent-v1" },
      },
      {
        evidenceRefs: [
          currentHeadRef(snapshot),
          rollbackAuthority,
          displacedAuthority,
        ],
      },
    ),
  );
  assert.equal(snapshot.activeProduction?.bindingId, standard.bindingId);
  assert.equal(snapshot.containmentCompanion?.bindingId, companion.bindingId);
  assert.deepEqual(snapshot.acceptedStandardEvent, rollbackAuthority);
  assert.deepEqual(snapshot.acceptedStandardFloors, {
    pwaLifecycle: "outer-agent-v1",
  });
  assert.equal(snapshot.containmentIncident, null);
});

test("atomically swaps rollback inventory and rejects authority or eligibility tampering", () => {
  const displaced = binding("standard", "1");
  const target = binding("standard", "2");
  const companion = binding("containment", "3");
  const unrelated = binding("standard", "4");
  const displacedAuthority = objectRef("a");
  const targetAuthority = objectRef("b");
  const unrelatedAuthority = objectRef("c");
  const floors = { pwaLifecycle: "outer-agent-v1" };
  const targetEntry = {
    ...inventoryEntry(target),
    acceptedEvent: targetAuthority,
  };
  const unrelatedEntry = {
    ...inventoryEntry(unrelated),
    acceptedEvent: unrelatedAuthority,
  };
  let pending = {
    ...initializeState(),
    activeProduction: displaced,
    acceptedStandard: displaced,
    acceptedStandardEvent: displacedAuthority,
    acceptedGate: "P0-RELEASE",
    acceptedStandardFloors: floors,
    containmentCompanion: binding("containment", "5"),
    rollbackInventory: [
      targetEntry,
      unrelatedEntry,
      {
        ...inventoryEntry(displaced),
        acceptedEvent: objectRef("f"),
      },
    ],
  };
  pending = prepareOperation(pending, {
    operationId: "atomic-rollback-swap",
    kind: "rollback-standard",
    targetBinding: target,
    companionBinding: companion,
  });
  pending = advanceAssignmentLifecycle(pending);
  const displacedEntry = {
    ...inventoryEntry(displaced),
    acceptedEvent: displacedAuthority,
  };
  const validInventory = [displacedEntry, unrelatedEntry];
  const rollbackEvent = (rollbackInventory, evidenceRefs = []) =>
    appendRecoveryTerminal(
      pending,
      "rollback-activated",
      {
        binding: target,
        companionBinding: companion,
        rollbackInventory,
        originAcceptedEvent: targetAuthority,
        originAcceptedGate: "P0-RELEASE",
        originAcceptedStandardFloors: floors,
      },
      {
        evidenceRefs: [
          currentHeadRef(pending),
          targetAuthority,
          displacedAuthority,
          ...evidenceRefs,
        ],
      },
    );

  const swapped = reduceReleaseState(pending, rollbackEvent(validInventory));
  assert.equal(swapped.acceptedStandard?.bindingId, target.bindingId);
  assert.deepEqual(
    swapped.rollbackInventory.map((entry) => entry.binding.bindingId),
    [displaced.bindingId, unrelated.bindingId],
  );
  assert.deepEqual(
    swapped.rollbackInventory[0].acceptedEvent,
    displacedAuthority,
  );

  for (const [label, rollbackInventory, message] of [
    [
      "missing displaced current",
      [unrelatedEntry],
      /Displaced current standard lacks exact eligible rollback authority/,
    ],
    [
      "target retained",
      [displacedEntry, unrelatedEntry, targetEntry],
      /Activated rollback target must be removed/,
    ],
    [
      "stale displaced event",
      [{ ...displacedEntry, acceptedEvent: objectRef("e") }, unrelatedEntry],
      /Displaced current standard lacks exact eligible rollback authority/,
    ],
    [
      "displaced action downgrade",
      [{ ...displacedEntry, eligibleActions: ["rollback"] }, unrelatedEntry],
      /Displaced current standard lacks exact eligible rollback authority/,
    ],
    [
      "displaced reason tamper",
      [
        { ...displacedEntry, reasonCodes: ["tampered-authority"] },
        unrelatedEntry,
      ],
      /Displaced current standard lacks exact eligible rollback authority/,
    ],
    [
      "displaced policy tamper",
      [{ ...displacedEntry, evaluatedPolicy: objectRef("2") }, unrelatedEntry],
      /not evaluated against the active policy/,
    ],
    [
      "unrelated eligibility tamper",
      [
        displacedEntry,
        {
          ...unrelatedEntry,
          eligibleActions: [],
          eligibility: "ineligible",
          reasonCodes: ["artifact-archive-unavailable"],
        },
      ],
      /changed an unrelated accepted authority/,
    ],
    [
      "unrelated accepted event tamper",
      [displacedEntry, { ...unrelatedEntry, acceptedEvent: objectRef("d") }],
      /changed an unrelated accepted authority/,
    ],
    [
      "duplicate displaced binding",
      [displacedEntry, displacedEntry, unrelatedEntry],
      /binding IDs must be distinct/,
    ],
  ]) {
    assert.throws(
      () => reduceReleaseState(pending, rollbackEvent(rollbackInventory)),
      message,
      label,
    );
  }

  assert.throws(
    () =>
      reduceReleaseState(
        { ...pending, rollbackInventory: [unrelatedEntry] },
        rollbackEvent(validInventory),
      ),
    /Rollback target is not currently eligible/,
  );
  const missingDisplacedEvidence = rollbackEvent(validInventory);
  missingDisplacedEvidence.evidenceRefs =
    missingDisplacedEvidence.evidenceRefs.filter(
      (reference) => reference.uri !== displacedAuthority.uri,
    );
  assert.throws(
    () => reduceReleaseState(pending, missingDisplacedEvidence),
    /Displaced accepted standard event is absent from rollback evidence/,
  );
});

test("rejects unauthorized or incomplete recovery terminal events", () => {
  const directSnapshot = initializeState();
  assert.throws(
    () =>
      reduceReleaseState(
        directSnapshot,
        appendEvent(
          directSnapshot,
          "containment-activated",
          "direct-containment",
          {
            binding: binding("containment", "1"),
            activatedAt: "2026-08-01T00:00:00.000Z",
            recoveryDeadline: "2026-08-01T01:00:00.000Z",
            targetStandard: null,
          },
          [],
          [currentHeadRef(directSnapshot)],
        ),
      ),
    /No release operation is pending/,
  );
  assert.throws(
    () =>
      reduceReleaseState(
        directSnapshot,
        appendEvent(
          directSnapshot,
          "rollback-activated",
          "direct-rollback",
          {
            binding: binding("standard", "2"),
            companionBinding: binding("containment", "3"),
          },
          [],
          [currentHeadRef(directSnapshot)],
        ),
      ),
    /No release operation is pending/,
  );

  const target = binding("containment", "4");
  let partial = prepareOperation(directSnapshot, {
    operationId: "partial-assignment",
    kind: "activate-containment",
    targetBinding: target,
  });
  partial = reduceReleaseState(
    partial,
    appendEvent(
      partial,
      "deployment-assigned",
      "partial-assignment",
      {
        assignmentReceipt: objectRef("c"),
        promotionReceipt: objectRef("d"),
        targetBinding: target,
      },
      [],
      [currentHeadRef(partial)],
    ),
  );
  assert.throws(
    () =>
      reduceReleaseState(
        partial,
        appendRecoveryTerminal(partial, "containment-activated", {
          binding: target,
          activatedAt: "2026-08-01T00:00:00.000Z",
          recoveryDeadline: "2026-08-01T01:00:00.000Z",
          targetStandard: null,
        }),
      ),
    /requires assignment and validation lifecycle events/,
  );

  let prepared = prepareOperation(directSnapshot, {
    operationId: "guard-terminal",
    kind: "activate-containment",
    targetBinding: target,
  });
  prepared = advanceAssignmentLifecycle(prepared);
  assert.throws(
    () =>
      reduceReleaseState(
        prepared,
        appendRecoveryTerminal(prepared, "containment-activated", {
          binding: binding("containment", "5"),
          activatedAt: "2026-08-01T00:00:00.000Z",
          recoveryDeadline: "2026-08-01T01:00:00.000Z",
          targetStandard: null,
        }),
      ),
    /differs from the prepared operation/,
  );
  assert.throws(
    () =>
      reduceReleaseState(
        prepared,
        appendRecoveryTerminal(
          prepared,
          "containment-activated",
          {
            binding: target,
            activatedAt: "2026-08-01T00:00:00.000Z",
            recoveryDeadline: "2026-08-01T01:00:00.000Z",
            targetStandard: null,
          },
          {
            approvals: [
              approval("guard-terminal", "releaseOwner", "1"),
              approval("guard-terminal", "dataSafetyReviewer", "2"),
            ],
          },
        ),
      ),
    /approvals differ from the prepared operation/,
  );
});

test("applies prepared standard and containment package redeploys", () => {
  let snapshot = initializeState();
  const originStandard = binding("standard", "1");
  const originCompanion = binding("containment", "2");
  const nextStandard = binding("standard", "3");
  const nextCompanion = binding("containment", "4");
  const unrelatedStandard = binding("standard", "8");
  const newerStandard = binding("standard", "9");
  const newerCompanion = binding("containment", "a");
  const originAuthority = inventoryEntry(originStandard).acceptedEvent;
  const originFloors = { pwaLifecycle: "outer-agent-v1" };
  snapshot = {
    ...snapshot,
    activeProduction: newerStandard,
    acceptedStandard: newerStandard,
    acceptedStandardEvent: eventRef(3, "b"),
    acceptedGate: "P1-PWA",
    acceptedStandardFloors: { pwaLifecycle: "outer-agent-v2" },
    containmentCompanion: newerCompanion,
    rollbackInventory: [
      inventoryEntry(originStandard),
      inventoryEntry(unrelatedStandard),
    ],
  };
  snapshot = prepareOperation(snapshot, {
    operationId: "redeploy-standard",
    kind: "redeploy-standard",
    targetBinding: nextStandard,
    companionBinding: nextCompanion,
    originBinding: originStandard,
    originCompanionBinding: originCompanion,
  });
  snapshot = advanceAssignmentLifecycle(snapshot);
  const redeployInventory = [
    inventoryEntry(nextStandard),
    inventoryEntry(unrelatedStandard),
  ];
  const redeployPayload = {
    releaseRole: "standard",
    standardBinding: nextStandard,
    companionBinding: nextCompanion,
    rollbackInventory: redeployInventory,
    originAcceptedEvent: originAuthority,
    originAcceptedGate: "P0-RELEASE",
    originAcceptedStandardFloors: originFloors,
  };
  const redeployTerminal = (rollbackInventory) =>
    appendRecoveryTerminal(
      snapshot,
      "package-redeploy-activated",
      { ...redeployPayload, rollbackInventory },
      {
        evidenceRefs: [currentHeadRef(snapshot), originAuthority],
      },
    );
  for (const mutate of [
    (inventory) => {
      inventory[1].acceptedGate = "P1-PWA";
    },
    (inventory) => {
      inventory[1].eligibility = "ineligible";
      inventory[1].eligibleActions = [];
      inventory[1].reasonCodes = ["tampered"];
    },
    (inventory) => {
      inventory[0].acceptedStandardFloors = {
        pwaLifecycle: "outer-agent-v2",
      };
    },
    (inventory) => {
      inventory[0].eligibleActions = ["rollback"];
    },
  ]) {
    const tamperedInventory = structuredClone(redeployInventory);
    mutate(tamperedInventory);
    assert.throws(
      () => reduceReleaseState(snapshot, redeployTerminal(tamperedInventory)),
      /exact authorized transform/,
    );
  }
  snapshot = reduceReleaseState(snapshot, redeployTerminal(redeployInventory));
  assert.equal(snapshot.acceptedStandard?.bindingId, nextStandard.bindingId);
  assert.deepEqual(snapshot.acceptedStandardEvent, originAuthority);
  assert.equal(snapshot.acceptedGate, "P0-RELEASE");
  assert.deepEqual(snapshot.acceptedStandardFloors, originFloors);
  assert.equal(snapshot.pendingOperation, null);

  const originContainment = binding("containment", "5");
  const nextContainment = binding("containment", "6");
  snapshot = prepareOperation(snapshot, {
    operationId: "redeploy-containment",
    kind: "redeploy-containment",
    targetBinding: nextContainment,
    originBinding: originContainment,
  });
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendRecoveryTerminal(snapshot, "package-redeploy-activated", {
      releaseRole: "containment",
      binding: nextContainment,
      activatedAt: "2026-08-01T04:00:00.000Z",
      recoveryDeadline: "2026-08-01T05:00:00.000Z",
      targetStandard: nextStandard,
    }),
  );
  assert.equal(snapshot.activeProduction?.bindingId, nextContainment.bindingId);
  assert.equal(snapshot.containmentIncident?.kind, "source-hardened");
});

test("reconciles and aborts only the currently prepared operation", () => {
  let snapshot = initializeState();
  const target = binding("standard", "a");
  snapshot = prepareOperation(snapshot, {
    operationId: "reconcile-operation",
    kind: "promote-standard",
    targetBinding: target,
    companionBinding: binding("containment", "b"),
  });
  const reconciled = reduceReleaseState(
    snapshot,
    appendEvent(snapshot, "state-reconciled", "reconcile-operation", {
      observedBinding: target,
      providerObservation: objectRef("9"),
      reconciliationKind: "provider-target-assigned/v1",
    }),
  );
  assert.equal(reconciled.pendingOperation?.operationId, "reconcile-operation");

  const aborted = reduceReleaseState(
    reconciled,
    appendEvent(reconciled, "operation-aborted", "reconcile-operation", {}),
  );
  assert.equal(aborted.pendingOperation, null);
  assert.equal(aborted.pendingAcceptance, null);

  assert.throws(
    () =>
      reduceReleaseState(
        aborted,
        appendEvent(aborted, "operation-aborted", "reconcile-operation", {}),
      ),
    /No release operation is pending/,
  );
  assert.throws(
    () =>
      reduceReleaseState(
        aborted,
        appendEvent(aborted, "state-initialized", "initialize-again", {}),
      ),
    /already initialized/,
  );
});

test("reconciles an already active previous accepted standard by aborting the no-op operation", () => {
  let snapshot = initializeState();
  const previous = binding("standard", "7");
  const companion = binding("containment", "8");
  const acceptedEvent = eventRef(2, "a");
  const acceptedFloors = { pwaLifecycle: "outer-agent-v1" };
  snapshot = {
    ...snapshot,
    activeProduction: previous,
    acceptedStandard: previous,
    acceptedStandardEvent: acceptedEvent,
    acceptedGate: "P0-RELEASE",
    acceptedStandardFloors: acceptedFloors,
    containmentCompanion: companion,
    rollbackInventory: [
      {
        ...inventoryEntry(previous),
        acceptedEvent,
        acceptedGate: "P0-RELEASE",
        acceptedStandardFloors: acceptedFloors,
      },
    ],
  };
  snapshot = prepareOperation(snapshot, {
    operationId: "reconcile-previous-standard",
    kind: "promote-standard",
    targetBinding: binding("standard", "9"),
    companionBinding: binding("containment", "a"),
  });
  const observation = objectRef("b");
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "state-reconciled",
      "reconcile-previous-standard",
      {
        reconciliationKind: "provider-previous-assigned/v1",
        observedBinding: previous,
        providerObservation: observation,
      },
      [],
      [observation],
    ),
  );
  assert.equal(snapshot.pendingOperation.kind, "rollback-standard");
  assert.equal(
    snapshot.pendingOperation.targetBinding.bindingId,
    previous.bindingId,
  );
  assert.throws(
    () =>
      reduceReleaseState(
        snapshot,
        appendEvent(
          snapshot,
          "deployment-assigned",
          "reconcile-previous-standard",
          {
            assignmentReceipt: observation,
            promotionReceipt: observation,
            targetBinding: previous,
          },
          [],
          [currentHeadRef(snapshot), observation],
        ),
      ),
    /differs from the prepared target/,
  );
  assert.throws(
    () =>
      reduceReleaseState(
        snapshot,
        appendEvent(
          snapshot,
          "assignment-validated",
          "reconcile-previous-standard",
          {
            assignmentReceipt: observation,
            assignmentValidation: observation,
            productionProbe: observation,
            targetBinding: previous,
          },
          [],
          [currentHeadRef(snapshot), observation],
        ),
      ),
    /differs from its authority/,
  );
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "operation-aborted",
      "reconcile-previous-standard",
      {},
      [],
      [currentHeadRef(snapshot)],
    ),
  );
  assert.equal(snapshot.pendingOperation, null);
  assert.deepEqual(snapshot.acceptedStandardEvent, acceptedEvent);
  assert.equal(snapshot.acceptedGate, "P0-RELEASE");
  assert.deepEqual(snapshot.acceptedStandardFloors, acceptedFloors);
});

test("reconciles a source-hardened emergency only as prepared containment recovery", () => {
  let snapshot = initializeState();
  const emergency = binding("containment", "d");
  snapshot = prepareOperation(snapshot, {
    operationId: "reconcile-emergency-containment",
    kind: "promote-standard",
    targetBinding: binding("standard", "e"),
    companionBinding: binding("containment", "f"),
    emergencyRecoveryBinding: emergency,
  });
  const observation = objectRef("c");
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "state-reconciled",
      "reconcile-emergency-containment",
      {
        reconciliationKind: "provider-emergency-assigned/v1",
        observedBinding: emergency,
        providerObservation: observation,
      },
      [],
      [observation],
    ),
  );
  assert.equal(snapshot.pendingOperation.kind, "activate-containment");
  assert.equal(
    snapshot.pendingOperation.targetBinding.bindingId,
    emergency.bindingId,
  );
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendRecoveryTerminal(snapshot, "containment-activated", {
      binding: emergency,
      activatedAt: "2026-08-01T01:00:00.000Z",
      recoveryDeadline: "2026-08-02T01:00:00.000Z",
      targetStandard: null,
    }),
  );
  assert.equal(snapshot.pendingOperation, null);
  assert.equal(snapshot.containmentIncident.kind, "source-hardened");
});

test("validates event construction and replay boundary inputs", () => {
  const base = {
    namespace,
    sequence: 1,
    eventType: "state-initialized",
    operationId: "validate",
    previousEventHash: null,
    payload: {},
  };
  for (const [patch, message] of [
    [{ eventType: "unknown" }, /Unknown release event/],
    [{ namespace: "NO" }, /namespace is invalid/],
    [{ sequence: 0 }, /sequence is invalid/],
    [{ operationId: "" }, /operation ID is invalid/],
    [{ appendId: "not-a-uuid" }, /not a UUID v4/],
    [{ payload: [] }, /payload must be an object/],
    [{ evidenceRefs: null }, /references must be arrays/],
  ]) {
    assert.throws(() => createReleaseEvent({ ...base, ...patch }), message);
  }
  assert.throws(() => replayReleaseEvents([]), /event list is empty/);
});

test("updates DB compatibility with active production and prepares a generic operation", () => {
  let snapshot = initializeState();
  const initialContainment = binding("containment", "a");
  const nextContainment = {
    ...initialContainment,
    requiredDbCompatibility: nextDbCompatibility,
  };
  snapshot = prepareOperation(snapshot, {
    operationId: "activate-before-db",
    kind: "activate-containment",
    targetBinding: initialContainment,
  });
  snapshot = advanceAssignmentLifecycle(snapshot);
  snapshot = reduceReleaseState(
    snapshot,
    appendRecoveryTerminal(snapshot, "containment-activated", {
      binding: initialContainment,
      activatedAt: "2026-08-01T00:00:00.000Z",
      recoveryDeadline: "2026-08-01T01:00:00.000Z",
    }),
  );
  snapshot = { ...snapshot, activeProduction: nextContainment };
  const operationId = "db-with-active-production";
  const approvals = [
    approval(operationId, "releaseOwner", "1"),
    approval(operationId, "dataSafetyReviewer", "2"),
  ];
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "db-contract-activated",
      operationId,
      {
        previousDbCompatibility: dbCompatibility,
        currentDbCompatibility: nextDbCompatibility,
        rollbackInventory: [
          inventoryEntry(
            {
              ...binding("standard", "b"),
              requiredDbCompatibility: nextDbCompatibility,
            },
            [],
          ),
        ],
      },
      approvals,
    ),
  );
  assert.equal(snapshot.rollbackInventory[0]?.eligibility, "ineligible");

  snapshot = {
    ...snapshot,
    bootstrapRecovery: {
      ...snapshot.bootstrapRecovery,
      requiredDbCompatibility: nextDbCompatibility,
    },
  };
  snapshot = prepareOperation(snapshot, {
    operationId: "generic-operation",
    kind: "rollback",
    targetBinding: {
      ...binding("standard", "c"),
      requiredDbCompatibility: nextDbCompatibility,
    },
  });
  assert.equal(snapshot.pendingOperation?.kind, "rollback");
});

const releaseEventSchemaFixtures = () => {
  const operationId = "schema-operation";
  const standard = binding("standard", "a");
  const companion = binding("containment", "b");
  const bootstrap = {
    ...binding("containment", "c"),
    publicIdentityKind: "legacy-bootstrap-v1",
  };
  const approvals = [
    approval(operationId, "releaseOwner", "a"),
    approval(operationId, "dataSafetyReviewer", "b"),
  ];
  const pendingOperation = {
    operationId,
    kind: "promote-standard",
    expectedState: {
      sequence: 1,
      eventHash: sha("a"),
    },
    targetBinding: standard,
    originBinding: null,
    originCompanionBinding: null,
    companionBinding: companion,
    previousBinding: null,
    emergencyRecoveryBinding: bootstrap,
    approvalRefs: approvals,
    preparedAt: "2026-08-01T00:00:00.000Z",
  };
  const pendingAcceptance = {
    operationId,
    standardBinding: standard,
    companionBinding: companion,
    assignmentValidationEvidence: objectRef("a"),
    observationStartedEvent: objectRef("b"),
    observationNotBefore: "2026-08-01T00:00:00.000Z",
    minimumObservationEndsAt: "2026-08-02T00:00:00.000Z",
  };
  const rollbackInventory = [inventoryEntry(standard)];

  return [
    [
      "state-initialized",
      {
        acceptedGate: null,
        executorSourceSha: sourceSha,
        legacyObservedProduction: {
          observationUri: objectRef("c").uri,
          observationSha256: sha("c"),
        },
        bootstrapRecovery: bootstrap,
        minimumSafetyFloors: { releaseChannel: "release-a" },
        currentDbCompatibility: dbCompatibility,
        activeReleasePolicy: policyRef,
        phaseExitAttestationSeed,
      },
      "initial",
    ],
    [
      "policy-activated",
      {
        activationGate: "P8-CLEAN",
        previousReleasePolicy: policyRef,
        proposedReleasePolicy: policyRef,
        activeReleasePolicy: policyRef,
        behaviorDimensionChange: null,
        minimumSafetyFloorChange: { styleSrcAttr: "none" },
        minimumSafetyFloors: {
          releaseChannel: "release-a",
          styleSrcAttr: "none",
        },
        activePolicyCompatibility: [],
        closureBundle: objectRef("a"),
        closureEvidenceRefs: [
          objectRef("b"),
          objectRef("c"),
          objectRef("d"),
          objectRef("e"),
          objectRef("f"),
        ],
        rollbackInventory,
      },
      "policy",
    ],
    [
      "db-contract-activated",
      {
        previousDbCompatibility: dbCompatibility,
        currentDbCompatibility: dbCompatibility,
        rollbackInventory,
      },
      "db",
    ],
    ["promotion-prepared", { pendingOperation }, "prepared"],
    [
      "deployment-assigned",
      {
        assignmentReceipt: objectRef("c"),
        promotionReceipt: objectRef("d"),
        targetBinding: standard,
      },
      "assigned",
    ],
    [
      "assignment-validated",
      {
        assignmentReceipt: objectRef("c"),
        assignmentValidation: objectRef("d"),
        productionProbe: objectRef("e"),
        targetBinding: standard,
      },
      "validated",
    ],
    [
      "assignment-validated",
      {
        reconciliationKind: "provider-target-assigned/v1",
        providerObservation: objectRef("f"),
        stateReconciled: eventRef(2, "e"),
        targetBinding: standard,
      },
      "reconcile-validated",
    ],
    ["observation-started", { pendingAcceptance }, "observation"],
    [
      "release-accepted",
      {
        acceptedGate: "P0-RELEASE",
        releaseRole: "standard",
        observedThrough: "2026-08-02T00:00:01.000Z",
        acceptedStandardFloors: { pwaLifecycle: "outer-agent-v1" },
        rollbackInventory,
        clearBootstrapRecovery: true,
      },
      "accepted",
    ],
    [
      "phase-exit-attested",
      {
        gate: "P0-BASELINE",
        sourceSha: "a".repeat(40),
        subjectKind: "repository-phase-subject/v1",
        attestation: objectRef("a"),
        predecessor: null,
      },
      "phase-exit",
    ],
    ["operation-aborted", {}, "aborted"],
    [
      "temporary-containment-activated",
      {
        binding: bootstrap,
        activatedAt: "2026-08-01T00:00:00.000Z",
        recoveryDeadline: "2026-08-01T01:00:00.000Z",
        targetStandard: null,
      },
      "temporary-containment",
    ],
    [
      "containment-activated",
      {
        binding: companion,
        activatedAt: "2026-08-01T02:00:00.000Z",
        recoveryDeadline: "2026-08-01T03:00:00.000Z",
        targetStandard: standard,
      },
      "containment",
    ],
    [
      "rollback-activated",
      {
        binding: standard,
        companionBinding: companion,
        rollbackInventory,
        originAcceptedEvent: rollbackInventory[0].acceptedEvent,
        originAcceptedGate: "P0-RELEASE",
        originAcceptedStandardFloors: { pwaLifecycle: "outer-agent-v1" },
      },
      "rollback",
    ],
    [
      "package-redeploy-activated",
      {
        releaseRole: "standard",
        standardBinding: standard,
        companionBinding: companion,
        rollbackInventory,
        originAcceptedEvent: rollbackInventory[0].acceptedEvent,
        originAcceptedGate: "P0-RELEASE",
        originAcceptedStandardFloors: { pwaLifecycle: "outer-agent-v1" },
      },
      "standard-redeploy",
    ],
    [
      "package-redeploy-activated",
      {
        releaseRole: "containment",
        binding: companion,
        activatedAt: "2026-08-01T04:00:00.000Z",
        recoveryDeadline: "2026-08-01T05:00:00.000Z",
        targetStandard: standard,
      },
      "containment-redeploy",
    ],
    [
      "state-reconciled",
      {
        reconciliationKind: "provider-target-assigned/v1",
        observedBinding: standard,
        providerObservation: objectRef("f"),
      },
      "reconciled",
    ],
  ];
};

const schemaEvent = (eventType, payload, fixtureId = eventType) =>
  createReleaseEvent({
    namespace,
    sequence: 1,
    eventType,
    operationId: `schema-${fixtureId}`,
    previousEventHash: null,
    payload,
    evidenceRefs:
      eventType === "state-initialized" ? phaseExitSeedEvidence : [],
  });

test("accepts a closed payload fixture for every release event type", () => {
  const fixtures = releaseEventSchemaFixtures();
  for (const [eventType, payload, fixtureId] of fixtures) {
    assert.doesNotThrow(
      () =>
        assertReleaseEventMatchesSchema(
          schemaEvent(eventType, payload, fixtureId),
          releaseStateSchema,
          fixtureId,
        ),
      `schema fixture rejected for ${eventType}/${fixtureId}`,
    );
  }
  const fixtureTypes = [
    ...new Set(fixtures.map(([eventType]) => eventType)),
  ].sort();
  const declaredTypes = [
    ...releaseStateSchema.$defs.releaseEventEnvelope.properties.eventType.enum,
  ].sort();
  assert.deepEqual(fixtureTypes, declaredTypes);
});

test("closes incident, recovery, legacy observation, and rollback inventory snapshots", () => {
  const snapshot = initializeState();
  const containmentBinding = binding("containment", "d");
  const targetStandard = binding("standard", "e");
  const containedSnapshot = {
    ...snapshot,
    containmentIncident: {
      kind: "source-hardened",
      binding: containmentBinding,
      activatedAt: "2026-08-01T02:00:00.000Z",
      recoveryDeadline: "2026-08-01T03:00:00.000Z",
    },
    standardRecovery: {
      containmentBinding,
      targetStandard,
      recoveryDeadline: "2026-08-01T03:00:00.000Z",
    },
    rollbackInventory: [inventoryEntry(targetStandard)],
  };
  assert.doesNotThrow(() =>
    assertReleaseStateSnapshotMatchesSchema(
      containedSnapshot,
      releaseStateSchema,
    ),
  );

  const unknownField = structuredClone(containedSnapshot);
  unknownField.containmentIncident.untrusted = true;
  assert.throws(
    () =>
      assertReleaseStateSnapshotMatchesSchema(unknownField, releaseStateSchema),
    /schema mismatch/,
  );
});

test("rejects unknown, missing, wrong-type, URI, hash, and time payload values", () => {
  const fixtures = releaseEventSchemaFixtures();
  const byType = new Map(
    fixtures.map(([eventType, payload]) => [eventType, payload]),
  );
  const stateWithoutArchive = structuredClone(byType.get("state-initialized"));
  delete stateWithoutArchive.bootstrapRecovery.artifactArchive;
  delete stateWithoutArchive.bootstrapRecovery.artifactArchiveAvailability;
  const invalidPayloads = [
    [
      "policy-activated",
      { ...structuredClone(byType.get("policy-activated")), unknown: true },
    ],
    ["db-contract-activated", { rollbackInventory: [] }],
    [
      "release-accepted",
      {
        ...structuredClone(byType.get("release-accepted")),
        clearBootstrapRecovery: "yes",
      },
    ],
    ["state-initialized", stateWithoutArchive],
    [
      "state-initialized",
      {
        ...structuredClone(byType.get("state-initialized")),
        legacyObservedProduction: {
          observationUri: "https://example.test/mutable",
          observationSha256: "not-a-hash",
        },
      },
    ],
    [
      "containment-activated",
      {
        ...structuredClone(byType.get("containment-activated")),
        recoveryDeadline: "tomorrow",
      },
    ],
  ];
  for (const [eventType, payload] of invalidPayloads) {
    assert.throws(
      () =>
        assertReleaseEventMatchesSchema(
          schemaEvent(eventType, payload, `invalid-${eventType}`),
          releaseStateSchema,
        ),
      /schema mismatch/,
    );
  }
});

const verifierInput = (event) => {
  const eventHash = hashReleaseEvent(event);
  return {
    events: [event],
    receipts: [
      {
        namespace: event.namespace,
        sequence: event.sequence,
        eventHash,
        canonicalEventSha256: eventHash,
        replayed: false,
        committedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  };
};

test("verify-release-state validates payload schemas and payload hashes", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "release-state-schema-"),
  );
  const inputPath = path.join(temporaryDirectory, "events.json");
  const runVerifier = async (event) => {
    await writeFile(inputPath, JSON.stringify(verifierInput(event)), "utf8");
    return spawnSync(
      process.execPath,
      ["scripts/verify-release-state.mjs", "--events", inputPath],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      },
    );
  };
  const output = (result) => `${result.stdout}\n${result.stderr}`;

  try {
    const initialPayload = structuredClone(
      releaseEventSchemaFixtures().find(
        ([eventType]) => eventType === "state-initialized",
      )[1],
    );
    const validEvent = schemaEvent(
      "state-initialized",
      initialPayload,
      "cli-valid",
    );
    const valid = await runVerifier(validEvent);
    assert.equal(valid.status, 0, output(valid));
    assert.match(valid.stdout, /PASS Release State: 1 events/);

    for (const invalidEvent of [
      {
        ...schemaEvent(
          "state-initialized",
          { ...structuredClone(initialPayload), unknown: true },
          "cli-unknown",
        ),
      },
      schemaEvent(
        "state-initialized",
        {
          bootstrapRecovery: initialPayload.bootstrapRecovery,
          minimumSafetyFloors: initialPayload.minimumSafetyFloors,
          currentDbCompatibility: initialPayload.currentDbCompatibility,
          activeReleasePolicy: initialPayload.activeReleasePolicy,
        },
        "cli-missing",
      ),
      schemaEvent(
        "state-initialized",
        {
          ...structuredClone(initialPayload),
          minimumSafetyFloors: [],
        },
        "cli-wrong-type",
      ),
      { ...validEvent, unknownEnvelopeField: true },
    ]) {
      const invalid = await runVerifier(invalidEvent);
      assert.notEqual(invalid.status, 0);
      assert.match(output(invalid), /schema mismatch/);
    }

    const tampered = structuredClone(validEvent);
    tampered.payload.minimumSafetyFloors.releaseChannel = "tampered";
    const tamperedResult = await runVerifier(tampered);
    assert.notEqual(tamperedResult.status, 0);
    assert.match(output(tamperedResult), /payload hash mismatch/);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
