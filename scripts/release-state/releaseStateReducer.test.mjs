import assert from "node:assert/strict";
import test from "node:test";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
  replayReleaseEvents,
} from "./releaseStateReducer.mjs";

const sha = (character) => character.repeat(64);
const sourceSha = "a".repeat(40);
const namespace = "foundation-test";
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: sha("d"),
};
const objectRef = (character) => ({
  uri: `release-state://${namespace}/evidence/${sha(character)}`,
  sha256: sha(character),
});
const policyRef = objectRef("1");

const binding = (role, suffix) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: sha(suffix),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${role}-${suffix}`,
  deploymentUrl: `https://${role}-${suffix}.example.test`,
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
) =>
  createReleaseEvent({
    namespace,
    sequence: snapshot === null ? 1 : snapshot.sequence + 1,
    eventType,
    operationId,
    previousEventHash: snapshot?.eventHash ?? null,
    payload,
    evidenceRefs: [objectRef("9")],
    approvalRefs: approvals,
  });

const initializeState = () => {
  const bootstrap = {
    ...binding("containment", "b"),
    publicIdentityKind: "legacy-bootstrap-v1",
  };
  const event = appendEvent(null, "state-initialized", "initialize", {
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
  });
  return reduceReleaseState(null, event);
};

const inventoryEntry = (
  standard,
  actions = ["package-redeploy", "rollback"],
) => ({
  binding: standard,
  acceptedEvent: objectRef("4"),
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
        emergencyRecoveryBinding: snapshot.bootstrapRecovery,
        approvalRefs: approvals,
        preparedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    approvals,
  );
  return reduceReleaseState(snapshot, event);
};

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

  for (const eventType of ["deployment-assigned", "assignment-validated"]) {
    const event = appendEvent(snapshot, eventType, operationId, {
      evidence: objectRef(eventType === "deployment-assigned" ? "d" : "e"),
    });
    snapshot = reduceReleaseState(snapshot, event);
  }

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
      releaseRole: "standard",
      observedThrough: "2026-08-02T00:00:01.000Z",
      acceptedStandardFloors: {
        pwaLifecycle: "legacy-auto-update-v1",
      },
      rollbackInventory: [
        {
          binding: standard,
          acceptedEvent: objectRef("4"),
          evaluatedPolicy: policyRef,
          eligibleActions: ["package-redeploy", "rollback"],
          eligibility: "eligible",
          reasonCodes: [],
        },
      ],
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

test("rejects containment acceptance and duplicate reviewers", () => {
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
  assert.throws(
    () => reduceReleaseState(snapshot, event),
    /reviewers must be distinct/,
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
  const initial = appendEvent(null, "state-initialized", "initialize", {
    legacyObservedProduction: {
      observationUri: objectRef("c").uri,
      observationSha256: sha("c"),
    },
    bootstrapRecovery: firstSnapshot.bootstrapRecovery,
    minimumSafetyFloors: firstSnapshot.minimumSafetyFloors,
    currentDbCompatibility: firstSnapshot.currentDbCompatibility,
    activeReleasePolicy: firstSnapshot.activeReleasePolicy,
  });
  assert.throws(
    () => replayReleaseEvents([initial, second]),
    /namespaces differ/,
  );
});

test("applies policy and DB compatibility changes with reviewed inventory", () => {
  let snapshot = initializeState();
  const standard = binding("standard", "a");
  const policyOperation = "activate-policy";
  const policyApprovals = [
    approval(policyOperation, "releaseOwner", "1"),
    approval(policyOperation, "dataSafetyReviewer", "2"),
  ];
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "policy-activated",
      policyOperation,
      {
        activeReleasePolicy: policyRef,
        minimumSafetyFloors: { releaseChannel: "release-a" },
        rollbackInventory: [inventoryEntry(standard)],
      },
      policyApprovals,
    ),
  );
  assert.deepEqual(snapshot.rollbackInventory, [inventoryEntry(standard)]);
  assert.deepEqual(snapshot.minimumSafetyFloors, {
    releaseChannel: "release-a",
  });

  const dbOperation = "activate-db-contract";
  const dbApprovals = [
    approval(dbOperation, "releaseOwner", "3"),
    approval(dbOperation, "dataSafetyReviewer", "4"),
  ];
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "db-contract-activated",
      dbOperation,
      {
        currentDbCompatibility: dbCompatibility,
        rollbackInventory: [inventoryEntry(standard)],
      },
      dbApprovals,
    ),
  );
  assert.deepEqual(snapshot.currentDbCompatibility, dbCompatibility);
});

test("activates bootstrap containment, source-hardened containment, and rollback", () => {
  let snapshot = initializeState();
  const bootstrap = snapshot.bootstrapRecovery;
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "temporary-containment-activated",
      "temporary-containment",
      {
        binding: bootstrap,
        activatedAt: "2026-08-01T00:00:00.000Z",
        recoveryDeadline: "2026-08-01T01:00:00.000Z",
        targetStandard: null,
      },
    ),
  );
  assert.equal(snapshot.containmentIncident?.kind, "legacy-bootstrap");
  assert.equal(snapshot.standardRecovery?.targetStandard, null);

  const containment = binding("containment", "c");
  const targetStandard = binding("standard", "d");
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "containment-activated",
      "source-hardened-containment",
      {
        binding: containment,
        activatedAt: "2026-08-01T02:00:00.000Z",
        recoveryDeadline: "2026-08-01T03:00:00.000Z",
        targetStandard,
      },
    ),
  );
  assert.equal(snapshot.containmentIncident?.kind, "source-hardened");
  assert.equal(
    snapshot.standardRecovery?.targetStandard.bindingId,
    targetStandard.bindingId,
  );

  const standard = binding("standard", "e");
  const companion = binding("containment", "f");
  snapshot = {
    ...snapshot,
    rollbackInventory: [inventoryEntry(standard)],
  };
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(snapshot, "rollback-activated", "rollback", {
      binding: standard,
      companionBinding: companion,
    }),
  );
  assert.equal(snapshot.activeProduction?.bindingId, standard.bindingId);
  assert.equal(snapshot.containmentCompanion?.bindingId, companion.bindingId);
  assert.equal(snapshot.containmentIncident, null);
});

test("applies prepared standard and containment package redeploys", () => {
  let snapshot = initializeState();
  const originStandard = binding("standard", "1");
  const originCompanion = binding("containment", "2");
  const nextStandard = binding("standard", "3");
  const nextCompanion = binding("containment", "4");
  snapshot = prepareOperation(snapshot, {
    operationId: "redeploy-standard",
    kind: "redeploy-standard",
    targetBinding: nextStandard,
    companionBinding: nextCompanion,
    originBinding: originStandard,
    originCompanionBinding: originCompanion,
  });
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(snapshot, "package-redeploy-activated", "redeploy-standard", {
      releaseRole: "standard",
      standardBinding: nextStandard,
      companionBinding: nextCompanion,
      rollbackInventory: [inventoryEntry(nextStandard)],
    }),
  );
  assert.equal(snapshot.acceptedStandard?.bindingId, nextStandard.bindingId);
  assert.equal(snapshot.pendingOperation, null);

  const originContainment = binding("containment", "5");
  const nextContainment = binding("containment", "6");
  snapshot = prepareOperation(snapshot, {
    operationId: "redeploy-containment",
    kind: "redeploy-containment",
    targetBinding: nextContainment,
    originBinding: originContainment,
  });
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(
      snapshot,
      "package-redeploy-activated",
      "redeploy-containment",
      {
        releaseRole: "containment",
        binding: nextContainment,
        activatedAt: "2026-08-01T04:00:00.000Z",
        recoveryDeadline: "2026-08-01T05:00:00.000Z",
        targetStandard: nextStandard,
      },
    ),
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
  snapshot = reduceReleaseState(
    snapshot,
    appendEvent(snapshot, "containment-activated", "activate-before-db", {
      binding: binding("containment", "a"),
      activatedAt: "2026-08-01T00:00:00.000Z",
      recoveryDeadline: "2026-08-01T01:00:00.000Z",
    }),
  );
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
        currentDbCompatibility: dbCompatibility,
        rollbackInventory: [inventoryEntry(binding("standard", "b"), [])],
      },
      approvals,
    ),
  );
  assert.equal(snapshot.rollbackInventory[0]?.eligibility, "ineligible");

  snapshot = prepareOperation(snapshot, {
    operationId: "generic-operation",
    kind: "rollback",
    targetBinding: binding("standard", "c"),
  });
  assert.equal(snapshot.pendingOperation?.kind, "rollback");
});
