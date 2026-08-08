import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";

const EVENT_TYPES = new Set([
  "state-initialized",
  "policy-activated",
  "db-contract-activated",
  "promotion-prepared",
  "deployment-assigned",
  "assignment-validated",
  "observation-started",
  "release-accepted",
  "operation-aborted",
  "temporary-containment-activated",
  "containment-activated",
  "rollback-activated",
  "package-redeploy-activated",
  "state-reconciled",
]);
const EVENT_KEYS = [
  "appendId",
  "approvalRefs",
  "eventType",
  "evidenceRefs",
  "namespace",
  "operationId",
  "payload",
  "payloadSha256",
  "previousEventHash",
  "schemaVersion",
  "sequence",
];
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sameValue = (left, right) => sha256Json(left) === sha256Json(right);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const assertImmutableRef = (reference, namespace) => {
  invariant(
    isRecord(reference) &&
      Object.keys(reference).sort().join("\n") === "sha256\nuri" &&
      typeof reference.sha256 === "string" &&
      SHA256_PATTERN.test(reference.sha256) &&
      typeof reference.uri === "string" &&
      new RegExp(
        `^release-state://${namespace}/(?:evidence|events/[1-9][0-9]*)/${reference.sha256}$`,
      ).test(reference.uri),
    "Immutable object reference is invalid",
  );
};

const assertBindingRole = (binding, role) => {
  invariant(
    binding && binding.releaseRole === role,
    `Expected a ${role} deployment binding`,
  );
  invariant(
    binding.sourceSha === binding.buildId,
    "Deployment binding buildId must equal sourceSha",
  );
};

const assertBindingPolicyMatches = (snapshot, binding) => {
  invariant(
    sameValue(binding.releasePolicy, snapshot.activeReleasePolicy),
    "Deployment binding does not match the active release policy",
  );
};

const assertDbBindingMatches = (snapshot, binding) => {
  invariant(
    binding.requiredDbCompatibility.contractUri ===
      snapshot.currentDbCompatibility.contractUri &&
      binding.requiredDbCompatibility.fingerprint ===
        snapshot.currentDbCompatibility.fingerprint,
    "Deployment binding does not match current DB compatibility",
  );
};

const assertCompanionPair = (standard, companion) => {
  assertBindingRole(standard, "standard");
  assertBindingRole(companion, "containment");
  invariant(
    standard.sourceSha === companion.sourceSha &&
      standard.providerProjectId === companion.providerProjectId &&
      sameValue(
        standard.requiredDbCompatibility,
        companion.requiredDbCompatibility,
      ) &&
      sameValue(standard.releasePolicy, companion.releasePolicy) &&
      sameValue(standard.providerPolicy, companion.providerPolicy) &&
      standard.providerConfigurationHash ===
        companion.providerConfigurationHash,
    "Standard and containment bindings are not a matching pair",
  );
};

const assertDistinctApprovals = (approvals, roles, operationId) => {
  const matching = approvals.filter((approval) =>
    roles.includes(approval.role),
  );
  invariant(
    matching.length === roles.length &&
      matching.length === approvals.length &&
      new Set(matching.map((approval) => approval.role)).size === roles.length,
    `Missing required approval roles: ${roles.join(", ")}`,
  );
  invariant(
    new Set(matching.map((approval) => approval.approvalId)).size ===
      matching.length,
    "Approval IDs must be distinct",
  );
  invariant(
    new Set(matching.map((approval) => approval.providerReviewerId)).size ===
      matching.length,
    "Provider reviewers must be distinct",
  );
  invariant(
    matching.every(
      (approval) =>
        approval.decision === "APPROVED" &&
        approval.operationId === operationId &&
        typeof approval.approvedAt === "string" &&
        Number.isFinite(new Date(approval.approvedAt).getTime()),
    ),
    "Only approved decisions are accepted",
  );
};

const assertInventory = (snapshot, inventory, activePolicy) => {
  invariant(Array.isArray(inventory), "Rollback inventory must be an array");
  const bindingIds = new Set();
  for (const entry of inventory) {
    assertBindingRole(entry?.binding, "standard");
    assertDbBindingMatches(snapshot, entry.binding);
    invariant(
      sameValue(entry.evaluatedPolicy, activePolicy),
      "Rollback inventory was not evaluated against the active policy",
    );
    invariant(
      !bindingIds.has(entry.binding.bindingId),
      "Rollback inventory binding IDs must be distinct",
    );
    bindingIds.add(entry.binding.bindingId);
    const actions = entry.eligibleActions;
    invariant(Array.isArray(actions), "Rollback inventory actions are invalid");
    invariant(
      new Set(actions).size === actions.length &&
        actions.every((action) =>
          ["package-redeploy", "rollback"].includes(action),
        ) &&
        sameValue(actions, [...actions].sort()),
      "Rollback inventory actions must be sorted and distinct",
    );
    invariant(
      (entry.eligibility === "eligible" && actions.length > 0) ||
        (entry.eligibility === "ineligible" && actions.length === 0),
      "Rollback inventory eligibility differs from its actions",
    );
    invariant(
      Array.isArray(entry.reasonCodes) &&
        new Set(entry.reasonCodes).size === entry.reasonCodes.length,
      "Rollback inventory reason codes must be distinct",
    );
  }
};

export const createReleaseEvent = ({
  namespace,
  sequence,
  eventType,
  operationId,
  appendId = randomUUID(),
  previousEventHash,
  payload,
  evidenceRefs = [],
  approvalRefs = [],
}) => {
  invariant(EVENT_TYPES.has(eventType), `Unknown release event: ${eventType}`);
  invariant(
    typeof namespace === "string" && NAMESPACE_PATTERN.test(namespace),
    "Release event namespace is invalid",
  );
  invariant(
    Number.isSafeInteger(sequence) && sequence > 0,
    "Release event sequence is invalid",
  );
  invariant(
    typeof operationId === "string" && operationId.length > 0,
    "Release operation ID is invalid",
  );
  invariant(
    typeof appendId === "string" && UUID_V4_PATTERN.test(appendId),
    "Release append ID is not a UUID v4",
  );
  invariant(isRecord(payload), "Release event payload must be an object");
  invariant(
    Array.isArray(evidenceRefs) && Array.isArray(approvalRefs),
    "Release event references must be arrays",
  );
  return {
    schemaVersion: 1,
    namespace,
    sequence,
    eventType,
    operationId,
    appendId,
    previousEventHash,
    payload,
    payloadSha256: sha256Json(payload),
    evidenceRefs,
    approvalRefs,
  };
};

export const hashReleaseEvent = (event) =>
  sha256Bytes(canonicalJsonBytes(event));

const assertEventChain = (snapshot, event) => {
  invariant(
    isRecord(event) &&
      Object.keys(event).sort().join("\n") === EVENT_KEYS.join("\n"),
    "Release event envelope has unknown or missing fields",
  );
  invariant(event.schemaVersion === 1, "Unsupported release event schema");
  invariant(EVENT_TYPES.has(event.eventType), "Unknown release event type");
  invariant(
    typeof event.namespace === "string" &&
      NAMESPACE_PATTERN.test(event.namespace) &&
      Number.isSafeInteger(event.sequence) &&
      event.sequence > 0 &&
      typeof event.operationId === "string" &&
      event.operationId.length > 0 &&
      typeof event.appendId === "string" &&
      UUID_V4_PATTERN.test(event.appendId) &&
      isRecord(event.payload) &&
      Array.isArray(event.evidenceRefs) &&
      Array.isArray(event.approvalRefs),
    "Release event envelope shape is invalid",
  );
  for (const reference of event.evidenceRefs) {
    assertImmutableRef(reference, event.namespace);
  }
  invariant(
    new Set(event.evidenceRefs.map((reference) => reference.uri)).size ===
      event.evidenceRefs.length,
    "Release evidence references must be distinct",
  );
  for (const approval of event.approvalRefs) {
    invariant(
      isRecord(approval) &&
        approval.operationId === event.operationId &&
        approval.trustedIssuer ===
          "https://token.actions.githubusercontent.com" &&
        approval.decision === "APPROVED" &&
        typeof approval.sha256 === "string" &&
        SHA256_PATTERN.test(approval.sha256) &&
        typeof approval.uri === "string" &&
        new RegExp(
          `^release-state://${event.namespace}/evidence/${approval.sha256}$`,
        ).test(approval.uri),
      "Release approval reference is invalid",
    );
  }
  invariant(
    event.payloadSha256 === sha256Json(event.payload),
    "Release event payload hash mismatch",
  );
  if (snapshot === null) {
    invariant(event.sequence === 1, "First release event must have sequence 1");
    invariant(
      event.previousEventHash === null,
      "First release event must not have a predecessor",
    );
    invariant(
      event.eventType === "state-initialized",
      "Release state must start with state-initialized",
    );
    return;
  }
  invariant(
    event.sequence === snapshot.sequence + 1,
    "Release event sequence is not contiguous",
  );
  invariant(
    event.previousEventHash === snapshot.eventHash,
    "Release event predecessor hash mismatch",
  );
};

const finalize = (snapshot, event, patch) => ({
  ...snapshot,
  ...patch,
  sequence: event.sequence,
  eventHash: hashReleaseEvent(event),
});

const initialize = (event) => {
  const payload = event.payload;
  assertBindingRole(payload.bootstrapRecovery, "containment");
  invariant(
    payload.bootstrapRecovery.publicIdentityKind === "legacy-bootstrap-v1",
    "Initial bootstrap recovery must use legacy bootstrap identity",
  );
  invariant(
    sameValue(
      payload.bootstrapRecovery.requiredDbCompatibility,
      payload.currentDbCompatibility,
    ),
    "Initial bootstrap recovery does not match DB compatibility",
  );
  invariant(
    sameValue(
      payload.bootstrapRecovery.releasePolicy,
      payload.activeReleasePolicy,
    ),
    "Initial bootstrap recovery does not match release policy",
  );
  return {
    sequence: event.sequence,
    eventHash: hashReleaseEvent(event),
    legacyObservedProduction: payload.legacyObservedProduction,
    activeProduction: null,
    acceptedStandard: null,
    bootstrapRecovery: payload.bootstrapRecovery,
    containmentCompanion: null,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: null,
    standardRecovery: null,
    rollbackInventory: [],
    minimumSafetyFloors: payload.minimumSafetyFloors,
    acceptedStandardFloors: {},
    currentDbCompatibility: payload.currentDbCompatibility,
    activeReleasePolicy: payload.activeReleasePolicy,
  };
};

const applyPolicyActivated = (snapshot, event) => {
  invariant(
    snapshot.pendingOperation === null,
    "Cannot activate policy mid-operation",
  );
  assertDistinctApprovals(
    event.approvalRefs,
    ["releaseOwner", "dataSafetyReviewer"],
    event.operationId,
  );
  assertInventory(
    snapshot,
    event.payload.rollbackInventory,
    event.payload.activeReleasePolicy,
  );
  return finalize(snapshot, event, {
    activeReleasePolicy: event.payload.activeReleasePolicy,
    minimumSafetyFloors: event.payload.minimumSafetyFloors,
    rollbackInventory: event.payload.rollbackInventory,
  });
};

const applyDbContractActivated = (snapshot, event) => {
  invariant(
    snapshot.pendingOperation === null,
    "Cannot activate DB contract mid-operation",
  );
  assertDistinctApprovals(
    event.approvalRefs,
    ["releaseOwner", "dataSafetyReviewer"],
    event.operationId,
  );
  if (snapshot.activeProduction !== null) {
    invariant(
      sameValue(
        snapshot.activeProduction.requiredDbCompatibility,
        event.payload.currentDbCompatibility,
      ),
      "Active production does not satisfy the new DB compatibility contract",
    );
  }
  const nextCompatibilitySnapshot = {
    ...snapshot,
    currentDbCompatibility: event.payload.currentDbCompatibility,
  };
  assertInventory(
    nextCompatibilitySnapshot,
    event.payload.rollbackInventory,
    snapshot.activeReleasePolicy,
  );
  return finalize(snapshot, event, {
    currentDbCompatibility: event.payload.currentDbCompatibility,
    rollbackInventory: event.payload.rollbackInventory,
  });
};

const applyPromotionPrepared = (snapshot, event) => {
  invariant(
    snapshot.pendingOperation === null,
    "A release operation is already pending",
  );
  const operation = event.payload.pendingOperation;
  assertDistinctApprovals(
    event.approvalRefs,
    ["releaseOwner", "dataSafetyReviewer"],
    event.operationId,
  );
  invariant(
    operation.operationId === event.operationId &&
      operation.expectedState.sequence === snapshot.sequence &&
      operation.expectedState.eventHash === snapshot.eventHash,
    "Prepared operation does not bind the current Release State head",
  );
  invariant(
    sameValue(operation.approvalRefs, event.approvalRefs),
    "Prepared operation approvals differ from the event envelope",
  );
  assertDbBindingMatches(snapshot, operation.targetBinding);
  assertBindingPolicyMatches(snapshot, operation.targetBinding);
  assertBindingRole(operation.emergencyRecoveryBinding, "containment");
  assertDbBindingMatches(snapshot, operation.emergencyRecoveryBinding);
  assertBindingPolicyMatches(snapshot, operation.emergencyRecoveryBinding);
  if (operation.kind === "promote-standard") {
    assertCompanionPair(operation.targetBinding, operation.companionBinding);
    invariant(
      operation.originBinding === null &&
        operation.originCompanionBinding === null,
      "Promotion cannot claim redeploy origins",
    );
  } else if (operation.kind === "redeploy-standard") {
    assertBindingRole(operation.originBinding, "standard");
    assertBindingRole(operation.originCompanionBinding, "containment");
    assertCompanionPair(operation.targetBinding, operation.companionBinding);
  } else if (operation.kind === "redeploy-containment") {
    assertBindingRole(operation.originBinding, "containment");
    assertBindingRole(operation.targetBinding, "containment");
    invariant(
      operation.originCompanionBinding === null &&
        operation.companionBinding === null,
      "Containment redeploy cannot claim a companion pair",
    );
  } else {
    invariant(
      operation.originBinding === null &&
        operation.originCompanionBinding === null,
      "Non-redeploy operations cannot claim redeploy origins",
    );
  }
  return finalize(snapshot, event, { pendingOperation: operation });
};

const assertPendingOperation = (snapshot, event) => {
  invariant(
    snapshot.pendingOperation !== null,
    "No release operation is pending",
  );
  invariant(
    snapshot.pendingOperation.operationId === event.operationId,
    "Release operation ID mismatch",
  );
};

const applyObservationStarted = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  const acceptance = event.payload.pendingAcceptance;
  invariant(
    snapshot.pendingOperation.kind === "promote-standard" &&
      acceptance.operationId === event.operationId &&
      sameValue(
        acceptance.standardBinding,
        snapshot.pendingOperation.targetBinding,
      ) &&
      sameValue(
        acceptance.companionBinding,
        snapshot.pendingOperation.companionBinding,
      ),
    "Pending acceptance differs from the prepared promotion",
  );
  assertCompanionPair(acceptance.standardBinding, acceptance.companionBinding);
  const notBefore = new Date(acceptance.observationNotBefore).getTime();
  const minimumEnd = new Date(acceptance.minimumObservationEndsAt).getTime();
  invariant(
    Number.isFinite(notBefore) &&
      Number.isFinite(minimumEnd) &&
      minimumEnd - notBefore >= 24 * 60 * 60 * 1000,
    "Standard observation window must be at least 24 hours",
  );
  return finalize(snapshot, event, {
    activeProduction: acceptance.standardBinding,
    pendingAcceptance: acceptance,
  });
};

const applyReleaseAccepted = (snapshot, event) => {
  invariant(
    snapshot.pendingAcceptance !== null,
    "No standard acceptance is pending",
  );
  invariant(
    snapshot.pendingAcceptance.operationId === event.operationId,
    "Acceptance operation ID mismatch",
  );
  assertDistinctApprovals(
    event.approvalRefs,
    ["releaseOwner", "dataSafetyReviewer", "operationsReviewer"],
    event.operationId,
  );
  const standard = snapshot.pendingAcceptance.standardBinding;
  const companion = snapshot.pendingAcceptance.companionBinding;
  assertBindingRole(standard, "standard");
  assertBindingRole(companion, "containment");
  assertCompanionPair(standard, companion);
  assertInventory(
    snapshot,
    event.payload.rollbackInventory,
    snapshot.activeReleasePolicy,
  );
  invariant(
    sameValue(snapshot.activeProduction, standard),
    "Accepted standard is not the active production binding",
  );
  invariant(
    event.payload.releaseRole === "standard",
    "Containment cannot be release-accepted",
  );
  invariant(
    new Date(event.payload.observedThrough).getTime() >=
      new Date(snapshot.pendingAcceptance.minimumObservationEndsAt).getTime(),
    "Minimum observation window has not elapsed",
  );
  return finalize(snapshot, event, {
    legacyObservedProduction: null,
    activeProduction: standard,
    acceptedStandard: standard,
    containmentCompanion: companion,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: null,
    standardRecovery: null,
    rollbackInventory: event.payload.rollbackInventory,
    acceptedStandardFloors: event.payload.acceptedStandardFloors,
    bootstrapRecovery:
      event.payload.clearBootstrapRecovery === true
        ? null
        : snapshot.bootstrapRecovery,
  });
};

const applyContainment = (snapshot, event, kind) => {
  const binding = event.payload.binding;
  assertBindingRole(binding, "containment");
  assertDbBindingMatches(snapshot, binding);
  assertBindingPolicyMatches(snapshot, binding);
  if (kind === "legacy-bootstrap") {
    invariant(
      snapshot.bootstrapRecovery !== null &&
        sameValue(binding, snapshot.bootstrapRecovery),
      "Temporary containment must use the verified bootstrap recovery",
    );
  }
  invariant(
    Number.isFinite(new Date(event.payload.recoveryDeadline).getTime()),
    "Containment recovery deadline is invalid",
  );
  return finalize(snapshot, event, {
    activeProduction: binding,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: {
      kind,
      binding,
      activatedAt: event.payload.activatedAt,
      recoveryDeadline: event.payload.recoveryDeadline,
    },
    standardRecovery: {
      containmentBinding: binding,
      targetStandard: event.payload.targetStandard ?? snapshot.acceptedStandard,
      recoveryDeadline: event.payload.recoveryDeadline,
    },
  });
};

const applyRollback = (snapshot, event) => {
  const binding = event.payload.binding;
  assertBindingRole(binding, "standard");
  const inventoryEntry = snapshot.rollbackInventory.find(
    (entry) => entry.binding.bindingId === binding.bindingId,
  );
  invariant(
    inventoryEntry?.eligibility === "eligible" &&
      inventoryEntry.eligibleActions.includes("rollback"),
    "Rollback target is not currently eligible",
  );
  invariant(
    sameValue(inventoryEntry.binding, binding),
    "Rollback binding differs from the accepted inventory",
  );
  assertDbBindingMatches(snapshot, binding);
  assertBindingPolicyMatches(snapshot, binding);
  assertCompanionPair(binding, event.payload.companionBinding);
  return finalize(snapshot, event, {
    activeProduction: binding,
    acceptedStandard: binding,
    containmentCompanion: event.payload.companionBinding,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: null,
    standardRecovery: null,
  });
};

const applyPackageRedeploy = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  const standardBranch = event.payload.releaseRole === "standard";
  if (standardBranch) {
    invariant(
      snapshot.pendingOperation.kind === "redeploy-standard" &&
        sameValue(
          event.payload.standardBinding,
          snapshot.pendingOperation.targetBinding,
        ) &&
        sameValue(
          event.payload.companionBinding,
          snapshot.pendingOperation.companionBinding,
        ),
      "Standard redeploy differs from the prepared operation",
    );
    assertCompanionPair(
      event.payload.standardBinding,
      event.payload.companionBinding,
    );
    assertInventory(
      snapshot,
      event.payload.rollbackInventory,
      snapshot.activeReleasePolicy,
    );
    return finalize(snapshot, event, {
      activeProduction: event.payload.standardBinding,
      acceptedStandard: event.payload.standardBinding,
      containmentCompanion: event.payload.companionBinding,
      rollbackInventory: event.payload.rollbackInventory,
      pendingOperation: null,
      pendingAcceptance: null,
    });
  }
  invariant(
    snapshot.pendingOperation.kind === "redeploy-containment" &&
      sameValue(event.payload.binding, snapshot.pendingOperation.targetBinding),
    "Containment redeploy differs from the prepared operation",
  );
  return applyContainment(snapshot, event, "source-hardened");
};

const applyStateReconciled = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  const payload = event.payload;
  invariant(
    isRecord(payload) &&
      Object.keys(payload).sort().join("\n") ===
        "observedBinding\nproviderObservation\nreconciliationKind",
    "Reconcile payload must be derived and cannot contain a snapshot patch",
  );
  invariant(
    payload.reconciliationKind === "provider-target-assigned/v1",
    "Reconcile outcome is unsupported",
  );
  assertImmutableRef(payload.providerObservation, event.namespace);
  invariant(
    event.evidenceRefs.some(
      (reference) =>
        reference.uri === payload.providerObservation.uri &&
        reference.sha256 === payload.providerObservation.sha256,
    ),
    "Reconcile provider observation is absent from event evidence",
  );
  invariant(
    sameValue(payload.observedBinding, snapshot.pendingOperation.targetBinding),
    "Reconcile provider binding differs from the prepared target",
  );
  return finalize(snapshot, event, {});
};

export const reduceReleaseState = (snapshot, event) => {
  assertEventChain(snapshot, event);
  if (snapshot === null) return initialize(event);

  switch (event.eventType) {
    case "policy-activated":
      return applyPolicyActivated(snapshot, event);
    case "db-contract-activated":
      return applyDbContractActivated(snapshot, event);
    case "promotion-prepared":
      return applyPromotionPrepared(snapshot, event);
    case "deployment-assigned":
    case "assignment-validated":
      assertPendingOperation(snapshot, event);
      return finalize(snapshot, event, {});
    case "observation-started":
      return applyObservationStarted(snapshot, event);
    case "release-accepted":
      return applyReleaseAccepted(snapshot, event);
    case "operation-aborted":
      assertPendingOperation(snapshot, event);
      return finalize(snapshot, event, {
        pendingOperation: null,
        pendingAcceptance: null,
      });
    case "temporary-containment-activated":
      return applyContainment(snapshot, event, "legacy-bootstrap");
    case "containment-activated":
      return applyContainment(snapshot, event, "source-hardened");
    case "rollback-activated":
      return applyRollback(snapshot, event);
    case "package-redeploy-activated":
      return applyPackageRedeploy(snapshot, event);
    case "state-reconciled":
      return applyStateReconciled(snapshot, event);
    case "state-initialized":
      throw new Error("Release state is already initialized");
    default:
      throw new Error(`Unsupported release event: ${event.eventType}`);
  }
};

export const replayReleaseEvents = (events) => {
  invariant(
    Array.isArray(events) && events.length > 0,
    "Release event list is empty",
  );
  const namespace = events[0]?.namespace;
  invariant(
    events.every((event) => event.namespace === namespace),
    "Release event namespaces differ",
  );
  return events.reduce(
    (snapshot, event) => reduceReleaseState(snapshot, event),
    null,
  );
};
