import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  assertBindingPolicyEligible,
  assertPolicyCompatibilityEntries,
} from "./policyCompatibility.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_SUBJECT_KIND_BY_GATE,
  RELEASE_PHASE_GATES,
  nextReleasePhaseGate,
} from "./phaseGates.mjs";

const EVENT_TYPES = new Set([
  "state-initialized",
  "policy-activated",
  "db-contract-activated",
  "promotion-prepared",
  "deployment-assigned",
  "assignment-validated",
  "observation-started",
  "release-accepted",
  "phase-exit-attested",
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
const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
const nextPhaseGate = (acceptedGate) => {
  try {
    return nextReleasePhaseGate(acceptedGate);
  } catch (error) {
    invariant(false, error.message);
  }
};
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

const assertRecoveryBindingPolicyMatches = (snapshot, binding, action) =>
  assertBindingPolicyEligible({
    snapshot,
    binding,
    action,
    label: "Recovery deployment binding",
  });

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

const assertRequiredRoleApprovals = (approvals, roles, operationId) => {
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
    matching.every(
      (approval) =>
        typeof approval.approvalId === "string" &&
        approval.approvalId.length > 0 &&
        typeof approval.providerReviewerId === "string" &&
        approval.providerReviewerId.length > 0,
    ),
    "Approval identities must be non-empty strings",
  );
  invariant(
    new Set(matching.map((approval) => approval.approvalId)).size ===
      matching.length,
    "Approval IDs must be distinct",
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
    invariant(
      hasExactKeys(entry, [
        "acceptedEvent",
        "acceptedGate",
        "acceptedStandardFloors",
        "binding",
        "eligibility",
        "eligibleActions",
        "evaluatedPolicy",
        "reasonCodes",
      ]) &&
        RELEASE_PHASE_GATES.includes(entry.acceptedGate) &&
        isRecord(entry.acceptedStandardFloors),
      "Rollback inventory accepted authority is invalid",
    );
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
      entry.eligibility !== "eligible" ||
        (entry.binding.artifactArchive !== undefined &&
          entry.binding.artifactArchiveAvailability !== undefined),
      "Eligible rollback inventory lacks a durable artifact archive receipt",
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
  invariant(
    hasExactKeys(payload, [
      "acceptedGate",
      "activeReleasePolicy",
      "bootstrapRecovery",
      "currentDbCompatibility",
      "executorSourceSha",
      "legacyObservedProduction",
      "minimumSafetyFloors",
      "phaseExitAttestationSeed",
    ]),
    "State initialization payload has unknown or missing fields",
  );
  assertBindingRole(payload.bootstrapRecovery, "containment");
  invariant(
    typeof payload.executorSourceSha === "string" &&
      /^[0-9a-f]{40}$/u.test(payload.executorSourceSha),
    "State initialization executor source SHA is invalid",
  );
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
  invariant(
    payload.acceptedGate === null,
    "State initialization cannot synthesize an accepted phase gate",
  );
  invariant(
    event.approvalRefs.length === 0,
    "State initialization must not synthesize protected approvals",
  );
  invariant(
    Array.isArray(payload.phaseExitAttestationSeed) &&
      payload.phaseExitAttestationSeed.length === 3,
    "State initialization requires three pre-initialization phase exits",
  );
  for (
    let index = 0;
    index < payload.phaseExitAttestationSeed.length;
    index += 1
  ) {
    const seed = payload.phaseExitAttestationSeed[index];
    invariant(
      hasExactKeys(seed, [
        "attestation",
        "gate",
        "predecessor",
        "sourceSha",
        "subjectKind",
      ]) &&
        seed.gate === FORMAL_PHASE_EXIT_GATES[index] &&
        seed.subjectKind === PHASE_EXIT_SUBJECT_KIND_BY_GATE[seed.gate] &&
        typeof seed.sourceSha === "string" &&
        /^[0-9a-f]{40}$/u.test(seed.sourceSha),
      "State initialization phase exit seed identity differs",
    );
    assertImmutableRef(seed.attestation, event.namespace);
    const predecessor =
      index === 0
        ? null
        : payload.phaseExitAttestationSeed[index - 1].attestation;
    invariant(
      sameValue(seed.predecessor, predecessor) &&
        event.evidenceRefs.some((reference) =>
          sameValue(reference, seed.attestation),
        ),
      "State initialization phase exit seed chain differs",
    );
  }
  return {
    sequence: event.sequence,
    eventHash: hashReleaseEvent(event),
    legacyObservedProduction: payload.legacyObservedProduction,
    activeProduction: null,
    acceptedStandard: null,
    acceptedStandardEvent: null,
    acceptedGate: null,
    bootstrapRecovery: payload.bootstrapRecovery,
    containmentCompanion: null,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: null,
    standardRecovery: null,
    rollbackInventory: [],
    activePolicyCompatibility: [],
    phaseExitAttestations: structuredClone(payload.phaseExitAttestationSeed),
    minimumSafetyFloors: payload.minimumSafetyFloors,
    acceptedStandardFloors: {},
    currentDbCompatibility: payload.currentDbCompatibility,
    activeReleasePolicy: payload.activeReleasePolicy,
  };
};

const applyPhaseExitAttested = (snapshot, event) => {
  const payload = event.payload;
  invariant(
    hasExactKeys(payload, [
      "attestation",
      "gate",
      "predecessor",
      "sourceSha",
      "subjectKind",
    ]),
    "Phase exit attestation payload has unknown or missing fields",
  );
  const expectedGate =
    FORMAL_PHASE_EXIT_GATES[snapshot.phaseExitAttestations.length];
  invariant(
    payload.gate === expectedGate &&
      PHASE_EXIT_SUBJECT_KIND_BY_GATE[payload.gate] === payload.subjectKind &&
      typeof payload.sourceSha === "string" &&
      /^[0-9a-f]{40}$/u.test(payload.sourceSha),
    "Phase exit attestation does not extend the formal gate sequence",
  );
  assertImmutableRef(payload.attestation, event.namespace);
  const prior = snapshot.phaseExitAttestations.at(-1)?.attestation ?? null;
  invariant(
    sameValue(payload.predecessor, prior),
    "Phase exit attestation predecessor differs from the formal ledger",
  );
  if (payload.predecessor !== null) {
    assertImmutableRef(payload.predecessor, event.namespace);
  }
  const expectedEvidence = [
    payload.attestation,
    ...(payload.predecessor === null ? [] : [payload.predecessor]),
  ];
  invariant(
    event.approvalRefs.length === 0 &&
      sameValue(event.evidenceRefs, expectedEvidence),
    "Phase exit attestation event evidence differs from its chain links",
  );
  return finalize(snapshot, event, {
    phaseExitAttestations: [
      ...snapshot.phaseExitAttestations,
      structuredClone(payload),
    ],
  });
};

const applyPolicyActivated = (snapshot, event) => {
  const payload = event.payload;
  invariant(
    hasExactKeys(payload, [
      "activationGate",
      "activePolicyCompatibility",
      "activeReleasePolicy",
      "behaviorDimensionChange",
      "closureBundle",
      "closureEvidenceRefs",
      "minimumSafetyFloorChange",
      "minimumSafetyFloors",
      "previousReleasePolicy",
      "proposedReleasePolicy",
      "rollbackInventory",
    ]),
    "Policy activation payload has unknown or missing fields",
  );
  invariant(
    snapshot.pendingOperation === null,
    "Cannot activate policy mid-operation",
  );
  invariant(
    snapshot.pendingAcceptance === null && snapshot.acceptedStandard !== null,
    "Policy activation requires an idle accepted standard",
  );
  assertImmutableRef(payload.previousReleasePolicy, event.namespace);
  assertImmutableRef(payload.proposedReleasePolicy, event.namespace);
  assertImmutableRef(payload.activeReleasePolicy, event.namespace);
  assertImmutableRef(payload.closureBundle, event.namespace);
  invariant(
    sameValue(payload.previousReleasePolicy, snapshot.activeReleasePolicy),
    "Policy activation does not bind the active policy predecessor",
  );
  invariant(
    Array.isArray(payload.closureEvidenceRefs) &&
      payload.closureEvidenceRefs.length === 5,
    "Policy activation requires the five closed closure receipts",
  );
  for (const reference of payload.closureEvidenceRefs) {
    assertImmutableRef(reference, event.namespace);
  }
  invariant(
    event.evidenceRefs.some((reference) =>
      sameValue(reference, payload.closureBundle),
    ) &&
      payload.closureEvidenceRefs.every((required) =>
        event.evidenceRefs.some((reference) => sameValue(reference, required)),
      ),
    "Policy activation closure evidence is absent from the event",
  );
  const p8Transition = payload.activationGate === "P8-CLEAN";
  invariant(
    p8Transition
      ? snapshot.acceptedGate === "P8-CLEAN"
      : payload.activationGate === nextPhaseGate(snapshot.acceptedGate),
    "Policy activation is not authorized by the accepted phase gate",
  );
  invariant(
    p8Transition
      ? sameValue(
          payload.previousReleasePolicy,
          payload.proposedReleasePolicy,
        ) &&
          sameValue(payload.previousReleasePolicy, payload.activeReleasePolicy)
      : !sameValue(
          payload.previousReleasePolicy,
          payload.proposedReleasePolicy,
        ) &&
          !sameValue(
            payload.proposedReleasePolicy,
            payload.activeReleasePolicy,
          ) &&
          !sameValue(
            payload.previousReleasePolicy,
            payload.activeReleasePolicy,
          ),
    "Policy activation reference transition is invalid",
  );
  invariant(
    p8Transition
      ? payload.behaviorDimensionChange === null &&
          hasExactKeys(payload.minimumSafetyFloorChange, ["styleSrcAttr"]) &&
          payload.minimumSafetyFloorChange.styleSrcAttr === "none"
      : hasExactKeys(payload.behaviorDimensionChange, [
          "dimension",
          "from",
          "to",
        ]) &&
          typeof payload.behaviorDimensionChange.dimension === "string" &&
          typeof payload.behaviorDimensionChange.from === "string" &&
          typeof payload.behaviorDimensionChange.to === "string" &&
          payload.behaviorDimensionChange.from !==
            payload.behaviorDimensionChange.to &&
          snapshot.acceptedStandardFloors[
            payload.behaviorDimensionChange.dimension
          ] === payload.behaviorDimensionChange.from &&
          payload.minimumSafetyFloorChange === null,
    "Policy activation does not describe exactly one gate delta",
  );
  const expectedFloors = p8Transition
    ? {
        ...snapshot.minimumSafetyFloors,
        ...payload.minimumSafetyFloorChange,
      }
    : snapshot.minimumSafetyFloors;
  invariant(
    sameValue(payload.minimumSafetyFloors, expectedFloors) &&
      Object.entries(snapshot.minimumSafetyFloors).every(
        ([key, value]) => payload.minimumSafetyFloors[key] === value,
      ) &&
      (!p8Transition || snapshot.minimumSafetyFloors.styleSrcAttr !== "none"),
    "Policy activation must preserve or strengthen safety floors monotonically",
  );
  assertPolicyCompatibilityEntries(payload.activePolicyCompatibility, {
    namespace: event.namespace,
    minimumSafetyFloors: payload.minimumSafetyFloors,
    currentDbCompatibility: snapshot.currentDbCompatibility,
  });
  assertRequiredRoleApprovals(
    event.approvalRefs,
    ["releaseOwner", "dataSafetyReviewer", "operationsReviewer"],
    event.operationId,
  );
  const nextPolicySnapshot = {
    ...snapshot,
    activeReleasePolicy: payload.activeReleasePolicy,
    activePolicyCompatibility: payload.activePolicyCompatibility,
    minimumSafetyFloors: payload.minimumSafetyFloors,
  };
  for (const [label, binding] of [
    ["Active production", snapshot.activeProduction],
    ["Accepted standard", snapshot.acceptedStandard],
  ]) {
    if (binding !== null) {
      assertBindingPolicyEligible({
        snapshot: nextPolicySnapshot,
        binding,
        action: binding.releaseRole === "standard" ? "rollback" : "containment",
        label,
      });
    }
  }
  assertInventory(
    nextPolicySnapshot,
    payload.rollbackInventory,
    payload.activeReleasePolicy,
  );
  return finalize(snapshot, event, {
    activeReleasePolicy: payload.activeReleasePolicy,
    activePolicyCompatibility: payload.activePolicyCompatibility,
    minimumSafetyFloors: payload.minimumSafetyFloors,
    rollbackInventory: payload.rollbackInventory,
  });
};

const applyDbContractActivated = (snapshot, event) => {
  invariant(
    hasExactKeys(event.payload, [
      "currentDbCompatibility",
      "previousDbCompatibility",
      "rollbackInventory",
    ]),
    "DB contract activation payload has unknown or missing fields",
  );
  invariant(
    snapshot.pendingOperation === null,
    "Cannot activate DB contract mid-operation",
  );
  invariant(
    snapshot.pendingAcceptance === null &&
      sameValue(
        event.payload.previousDbCompatibility,
        snapshot.currentDbCompatibility,
      ) &&
      !sameValue(
        event.payload.currentDbCompatibility,
        snapshot.currentDbCompatibility,
      ),
    "DB contract activation does not bind a new predecessor contract",
  );
  assertRequiredRoleApprovals(
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
  assertRequiredRoleApprovals(
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
  assertBindingRole(operation.emergencyRecoveryBinding, "containment");
  assertDbBindingMatches(snapshot, operation.emergencyRecoveryBinding);
  assertRecoveryBindingPolicyMatches(
    snapshot,
    operation.emergencyRecoveryBinding,
    "containment",
  );
  if (operation.kind === "promote-standard") {
    assertDbBindingMatches(snapshot, operation.targetBinding);
    assertBindingPolicyMatches(snapshot, operation.targetBinding);
    assertCompanionPair(operation.targetBinding, operation.companionBinding);
    invariant(
      operation.originBinding === null &&
        operation.originCompanionBinding === null,
      "Promotion cannot claim redeploy origins",
    );
  } else if (operation.kind === "redeploy-standard") {
    assertDbBindingMatches(snapshot, operation.targetBinding);
    assertRecoveryBindingPolicyMatches(
      snapshot,
      operation.targetBinding,
      "rollback",
    );
    assertBindingRole(operation.originBinding, "standard");
    assertBindingRole(operation.originCompanionBinding, "containment");
    assertCompanionPair(operation.targetBinding, operation.companionBinding);
  } else if (operation.kind === "redeploy-containment") {
    assertDbBindingMatches(snapshot, operation.targetBinding);
    assertRecoveryBindingPolicyMatches(
      snapshot,
      operation.targetBinding,
      "containment",
    );
    assertBindingRole(operation.originBinding, "containment");
    assertBindingRole(operation.targetBinding, "containment");
    invariant(
      operation.originCompanionBinding === null &&
        operation.companionBinding === null,
      "Containment redeploy cannot claim a companion pair",
    );
  } else {
    assertDbBindingMatches(snapshot, operation.targetBinding);
    assertRecoveryBindingPolicyMatches(
      snapshot,
      operation.targetBinding,
      operation.kind === "rollback-standard" ? "rollback" : "containment",
    );
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

const assertCurrentHeadEvidence = (snapshot, event, label) => {
  const expected = {
    uri:
      `release-state://${event.namespace}/events/${snapshot.sequence}/` +
      snapshot.eventHash,
    sha256: snapshot.eventHash,
  };
  invariant(
    event.evidenceRefs.some((reference) => sameValue(reference, expected)),
    `${label} must reference the immediately preceding lifecycle event`,
  );
};

const assertRecoveryTerminalAuthority = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  const requiredLifecycleEvents =
    snapshot.pendingOperation.reconciliationAuthority === undefined ? 3 : 2;
  invariant(
    snapshot.sequence ===
      snapshot.pendingOperation.expectedState.sequence +
        requiredLifecycleEvents,
    "Recovery terminal requires assignment and validation lifecycle events",
  );
  assertCurrentHeadEvidence(snapshot, event, "Recovery terminal");
  invariant(
    sameValue(event.approvalRefs, snapshot.pendingOperation.approvalRefs),
    "Recovery terminal approvals differ from the prepared operation",
  );
  assertRequiredRoleApprovals(
    event.approvalRefs,
    ["releaseOwner", "dataSafetyReviewer"],
    event.operationId,
  );
};

const assertAcceptedOriginAuthority = ({
  snapshot,
  event,
  binding,
  inventoryEntry,
}) => {
  assertImmutableRef(event.payload.originAcceptedEvent, event.namespace);
  invariant(
    event.evidenceRefs.some((reference) =>
      sameValue(reference, event.payload.originAcceptedEvent),
    ),
    "Accepted origin event is absent from recovery terminal evidence",
  );
  invariant(
    inventoryEntry !== undefined &&
      sameValue(inventoryEntry.binding, binding) &&
      sameValue(
        inventoryEntry.acceptedEvent,
        event.payload.originAcceptedEvent,
      ) &&
      inventoryEntry.acceptedGate === event.payload.originAcceptedGate &&
      sameValue(
        inventoryEntry.acceptedStandardFloors,
        event.payload.originAcceptedStandardFloors,
      ),
    "Recovery accepted origin differs from the rollback inventory",
  );
  if (sameValue(snapshot.acceptedStandard, binding)) {
    invariant(
      sameValue(
        snapshot.acceptedStandardEvent,
        event.payload.originAcceptedEvent,
      ) &&
        sameValue(
          snapshot.acceptedStandardFloors,
          event.payload.originAcceptedStandardFloors,
        ) &&
        snapshot.acceptedGate === event.payload.originAcceptedGate,
      "Recovery accepted origin differs from the current accepted standard",
    );
  }
};

const applyDeploymentAssigned = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  invariant(
    hasExactKeys(event.payload, [
      "assignmentReceipt",
      "promotionReceipt",
      "targetBinding",
    ]) &&
      sameValue(
        event.payload.targetBinding,
        snapshot.pendingOperation.targetBinding,
      ) &&
      snapshot.pendingOperation.reconciliationAuthority === undefined,
    "Deployment assignment differs from the prepared target",
  );
  assertImmutableRef(event.payload.assignmentReceipt, event.namespace);
  assertImmutableRef(event.payload.promotionReceipt, event.namespace);
  assertCurrentHeadEvidence(snapshot, event, "Deployment assignment");
  invariant(
    snapshot.sequence ===
      snapshot.pendingOperation.expectedState.sequence + 1 &&
      event.approvalRefs.length === 0,
    "Deployment assignment lifecycle order or approvals are invalid",
  );
  return finalize(snapshot, event, {});
};

const applyAssignmentValidated = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  const reconciliation = snapshot.pendingOperation.reconciliationAuthority;
  if (reconciliation !== undefined) {
    invariant(
      hasExactKeys(event.payload, [
        "providerObservation",
        "reconciliationKind",
        "stateReconciled",
        "targetBinding",
      ]) &&
        sameValue(
          event.payload.targetBinding,
          snapshot.pendingOperation.targetBinding,
        ) &&
        sameValue(
          event.payload.providerObservation,
          reconciliation.providerObservation,
        ) &&
        event.payload.reconciliationKind ===
          reconciliation.reconciliationKind &&
        sameValue(
          event.payload.stateReconciled,
          reconciliation.stateReconciled,
        ),
      "Reconcile assignment validation differs from its authority",
    );
    assertImmutableRef(event.payload.providerObservation, event.namespace);
    assertImmutableRef(event.payload.stateReconciled, event.namespace);
    invariant(
      event.evidenceRefs.some((reference) =>
        sameValue(reference, event.payload.providerObservation),
      ) &&
        event.evidenceRefs.some((reference) =>
          sameValue(reference, event.payload.stateReconciled),
        ),
      "Reconcile assignment validation evidence is incomplete",
    );
    assertCurrentHeadEvidence(
      snapshot,
      event,
      "Reconcile assignment validation",
    );
    invariant(
      snapshot.sequence ===
        snapshot.pendingOperation.expectedState.sequence + 1 &&
        event.approvalRefs.length === 0,
      "Reconcile assignment validation lifecycle order or approvals are invalid",
    );
    return finalize(snapshot, event, {});
  }
  invariant(
    hasExactKeys(event.payload, [
      "assignmentReceipt",
      "assignmentValidation",
      "productionProbe",
      "targetBinding",
    ]) &&
      sameValue(
        event.payload.targetBinding,
        snapshot.pendingOperation.targetBinding,
      ),
    "Assignment validation differs from the prepared target",
  );
  for (const reference of [
    event.payload.assignmentReceipt,
    event.payload.assignmentValidation,
    event.payload.productionProbe,
  ]) {
    assertImmutableRef(reference, event.namespace);
  }
  assertCurrentHeadEvidence(snapshot, event, "Assignment validation");
  invariant(
    snapshot.sequence ===
      snapshot.pendingOperation.expectedState.sequence + 2 &&
      event.approvalRefs.length === 0,
    "Assignment validation lifecycle order or approvals are invalid",
  );
  return finalize(snapshot, event, {});
};

const applyObservationStarted = (snapshot, event) => {
  assertPendingOperation(snapshot, event);
  const acceptance = event.payload.pendingAcceptance;
  invariant(
    snapshot.pendingOperation.kind === "promote-standard" &&
      snapshot.pendingOperation.reconciliationAuthority === undefined &&
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
  assertRequiredRoleApprovals(
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
    !event.payload.rollbackInventory.some(
      (entry) => entry.binding.bindingId === standard.bindingId,
    ),
    "Accepted standard must not remain in the rollback inventory",
  );
  invariant(
    sameValue(snapshot.activeProduction, standard),
    "Accepted standard is not the active production binding",
  );
  invariant(
    event.payload.releaseRole === "standard",
    "Containment cannot be release-accepted",
  );
  const sameGateAcceptance =
    snapshot.acceptedGate !== null &&
    snapshot.acceptedStandard !== null &&
    event.payload.acceptedGate === snapshot.acceptedGate;
  invariant(
    !(sameGateAcceptance && snapshot.acceptedGate === "P8-CLEAN"),
    "Terminal P8-CLEAN does not permit a same-floor accepted standard replacement",
  );
  const replacesCurrentSourceAtSameFloor =
    sameGateAcceptance &&
    sameValue(
      event.payload.acceptedStandardFloors,
      snapshot.acceptedStandardFloors,
    ) &&
    standard.sourceSha !== snapshot.acceptedStandard.sourceSha &&
    standard.buildId !== snapshot.acceptedStandard.buildId &&
    standard.bindingId !== snapshot.acceptedStandard.bindingId &&
    standard.providerDeploymentId !==
      snapshot.acceptedStandard.providerDeploymentId &&
    standard.deploymentUrl !== snapshot.acceptedStandard.deploymentUrl;
  invariant(
    replacesCurrentSourceAtSameFloor ||
      event.payload.acceptedGate === nextPhaseGate(snapshot.acceptedGate),
    "Accepted standard neither advances exactly one phase gate nor replaces the current source at the same floor",
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
    acceptedStandardEvent: {
      uri:
        `release-state://${event.namespace}/events/${event.sequence}/` +
        hashReleaseEvent(event),
      sha256: hashReleaseEvent(event),
    },
    acceptedGate: event.payload.acceptedGate,
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
  assertRecoveryTerminalAuthority(snapshot, event);
  const binding = event.payload.binding;
  assertBindingRole(binding, "containment");
  assertDbBindingMatches(snapshot, binding);
  assertRecoveryBindingPolicyMatches(snapshot, binding, "containment");
  if (kind === "legacy-bootstrap") {
    invariant(
      snapshot.bootstrapRecovery !== null &&
        snapshot.acceptedStandard === null &&
        snapshot.acceptedStandardEvent === null &&
        snapshot.legacyObservedProduction !== null &&
        sameValue(binding, snapshot.bootstrapRecovery) &&
        snapshot.pendingOperation.kind === "promote-standard" &&
        sameValue(binding, snapshot.pendingOperation.emergencyRecoveryBinding),
      "Temporary containment must use the verified bootstrap recovery",
    );
  } else {
    const expectedKind =
      event.eventType === "package-redeploy-activated"
        ? "redeploy-containment"
        : "activate-containment";
    invariant(
      snapshot.pendingOperation.kind === expectedKind &&
        sameValue(binding, snapshot.pendingOperation.targetBinding),
      "Containment activation differs from the prepared operation",
    );
  }
  const activatedAt = new Date(event.payload.activatedAt).getTime();
  const recoveryDeadline = new Date(event.payload.recoveryDeadline).getTime();
  const targetStandard = Object.hasOwn(event.payload, "targetStandard")
    ? event.payload.targetStandard
    : snapshot.acceptedStandard;
  invariant(
    Number.isFinite(activatedAt) &&
      Number.isFinite(recoveryDeadline) &&
      recoveryDeadline > activatedAt &&
      recoveryDeadline - activatedAt <=
        (kind === "legacy-bootstrap" ? 6 : 24) * 60 * 60 * 1000 &&
      sameValue(targetStandard, snapshot.acceptedStandard),
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
      targetStandard,
      recoveryDeadline: event.payload.recoveryDeadline,
    },
  });
};

const applyRollback = (snapshot, event) => {
  assertRecoveryTerminalAuthority(snapshot, event);
  const binding = event.payload.binding;
  invariant(
    hasExactKeys(event.payload, [
      "binding",
      "companionBinding",
      "originAcceptedEvent",
      "originAcceptedGate",
      "originAcceptedStandardFloors",
      "rollbackInventory",
    ]) &&
      snapshot.pendingOperation.kind === "rollback-standard" &&
      sameValue(binding, snapshot.pendingOperation.targetBinding) &&
      sameValue(
        event.payload.companionBinding,
        snapshot.pendingOperation.companionBinding,
      ),
    "Rollback differs from the prepared operation",
  );
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
  assertAcceptedOriginAuthority({
    snapshot,
    event,
    binding,
    inventoryEntry,
  });
  assertDbBindingMatches(snapshot, binding);
  assertRecoveryBindingPolicyMatches(snapshot, binding, "rollback");
  assertCompanionPair(binding, event.payload.companionBinding);
  assertInventory(
    snapshot,
    event.payload.rollbackInventory,
    snapshot.activeReleasePolicy,
  );
  const displacedBinding = snapshot.acceptedStandard;
  const displacedAcceptedEvent = snapshot.acceptedStandardEvent;
  invariant(
    displacedBinding !== null &&
      displacedAcceptedEvent !== null &&
      snapshot.acceptedGate !== null &&
      snapshot.acceptedStandardFloors !== null &&
      displacedBinding.bindingId !== binding.bindingId,
    "Rollback has no distinct current accepted standard to preserve",
  );
  assertBindingRole(displacedBinding, "standard");
  assertDbBindingMatches(snapshot, displacedBinding);
  assertRecoveryBindingPolicyMatches(snapshot, displacedBinding, "rollback");
  assertImmutableRef(displacedAcceptedEvent, event.namespace);
  invariant(
    event.evidenceRefs.some((reference) =>
      sameValue(reference, displacedAcceptedEvent),
    ),
    "Displaced accepted standard event is absent from rollback evidence",
  );
  invariant(
    !event.payload.rollbackInventory.some(
      (entry) => entry.binding.bindingId === binding.bindingId,
    ),
    "Activated rollback target must be removed from the rollback inventory",
  );
  const displacedInventoryEntries = event.payload.rollbackInventory.filter(
    (entry) => entry.binding.bindingId === displacedBinding.bindingId,
  );
  invariant(
    displacedInventoryEntries.length === 1 &&
      sameValue(displacedInventoryEntries[0].binding, displacedBinding) &&
      sameValue(
        displacedInventoryEntries[0].acceptedEvent,
        displacedAcceptedEvent,
      ) &&
      displacedInventoryEntries[0].acceptedGate === snapshot.acceptedGate &&
      sameValue(
        displacedInventoryEntries[0].acceptedStandardFloors,
        snapshot.acceptedStandardFloors,
      ) &&
      sameValue(
        displacedInventoryEntries[0].evaluatedPolicy,
        snapshot.activeReleasePolicy,
      ) &&
      displacedInventoryEntries[0].eligibility === "eligible" &&
      sameValue(displacedInventoryEntries[0].eligibleActions, [
        "package-redeploy",
        "rollback",
      ]) &&
      sameValue(displacedInventoryEntries[0].reasonCodes, []),
    "Displaced current standard lacks exact eligible rollback authority",
  );
  const priorByBindingId = new Map(
    snapshot.rollbackInventory.map((entry) => [entry.binding.bindingId, entry]),
  );
  const expectedBindingIds = new Set(
    snapshot.rollbackInventory
      .filter(
        (entry) =>
          entry.binding.bindingId !== binding.bindingId &&
          entry.binding.bindingId !== displacedBinding.bindingId,
      )
      .map((entry) => entry.binding.bindingId),
  );
  expectedBindingIds.add(displacedBinding.bindingId);
  invariant(
    event.payload.rollbackInventory.length === expectedBindingIds.size &&
      event.payload.rollbackInventory.every((entry) =>
        expectedBindingIds.has(entry.binding.bindingId),
      ),
    "Rollback inventory binding IDs are not an exact atomic swap",
  );
  for (const entry of event.payload.rollbackInventory) {
    if (entry.binding.bindingId === displacedBinding.bindingId) continue;
    const prior = priorByBindingId.get(entry.binding.bindingId);
    invariant(
      prior !== undefined && sameValue(prior, entry),
      "Rollback inventory changed an unrelated accepted authority",
    );
  }
  return finalize(snapshot, event, {
    activeProduction: binding,
    acceptedStandard: binding,
    acceptedStandardEvent: event.payload.originAcceptedEvent,
    acceptedGate: event.payload.originAcceptedGate,
    acceptedStandardFloors: event.payload.originAcceptedStandardFloors,
    containmentCompanion: event.payload.companionBinding,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: null,
    standardRecovery: null,
    rollbackInventory: event.payload.rollbackInventory,
  });
};

const applyPackageRedeploy = (snapshot, event) => {
  assertRecoveryTerminalAuthority(snapshot, event);
  const standardBranch = event.payload.releaseRole === "standard";
  if (standardBranch) {
    invariant(
      hasExactKeys(event.payload, [
        "companionBinding",
        "originAcceptedEvent",
        "originAcceptedGate",
        "originAcceptedStandardFloors",
        "releaseRole",
        "rollbackInventory",
        "standardBinding",
      ]) &&
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
    const originInventoryEntry = snapshot.rollbackInventory.find((entry) =>
      sameValue(entry.binding, snapshot.pendingOperation.originBinding),
    );
    const currentOriginEntry = sameValue(
      snapshot.acceptedStandard,
      snapshot.pendingOperation.originBinding,
    )
      ? {
          binding: snapshot.acceptedStandard,
          acceptedEvent: snapshot.acceptedStandardEvent,
          acceptedGate: snapshot.acceptedGate,
          acceptedStandardFloors: snapshot.acceptedStandardFloors,
        }
      : undefined;
    assertAcceptedOriginAuthority({
      snapshot,
      event,
      binding: snapshot.pendingOperation.originBinding,
      inventoryEntry: originInventoryEntry ?? currentOriginEntry,
    });
    invariant(
      originInventoryEntry === undefined ||
        (originInventoryEntry.eligibility === "eligible" &&
          originInventoryEntry.eligibleActions.includes("package-redeploy")),
      "Standard redeploy origin is not eligible for package redeploy",
    );
    let replacedOrigin = false;
    const expectedInventory = snapshot.rollbackInventory.map((entry) => {
      if (!sameValue(entry.binding, snapshot.pendingOperation.originBinding)) {
        return structuredClone(entry);
      }
      replacedOrigin = true;
      return {
        ...structuredClone(entry),
        binding: structuredClone(event.payload.standardBinding),
        acceptedEvent: structuredClone(event.payload.originAcceptedEvent),
        acceptedGate: event.payload.originAcceptedGate,
        acceptedStandardFloors: structuredClone(
          event.payload.originAcceptedStandardFloors,
        ),
      };
    });
    if (!replacedOrigin) {
      invariant(
        currentOriginEntry !== undefined,
        "Standard redeploy origin has no current accepted authority",
      );
      expectedInventory.push({
        binding: structuredClone(event.payload.standardBinding),
        acceptedEvent: structuredClone(event.payload.originAcceptedEvent),
        acceptedGate: event.payload.originAcceptedGate,
        acceptedStandardFloors: structuredClone(
          event.payload.originAcceptedStandardFloors,
        ),
        evaluatedPolicy: structuredClone(snapshot.activeReleasePolicy),
        eligibleActions: ["package-redeploy", "rollback"],
        eligibility: "eligible",
        reasonCodes: [],
      });
    }
    expectedInventory.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.binding.bindingId, "utf8"),
        Buffer.from(right.binding.bindingId, "utf8"),
      ),
    );
    invariant(
      sameValue(event.payload.rollbackInventory, expectedInventory),
      "Standard redeploy inventory is not the exact authorized transform",
    );
    const redeployedInventoryEntry = event.payload.rollbackInventory.find(
      (entry) => sameValue(entry.binding, event.payload.standardBinding),
    );
    invariant(
      redeployedInventoryEntry !== undefined &&
        sameValue(
          redeployedInventoryEntry.acceptedEvent,
          event.payload.originAcceptedEvent,
        ),
      "Standard redeploy inventory does not preserve accepted origin authority",
    );
    return finalize(snapshot, event, {
      activeProduction: event.payload.standardBinding,
      acceptedStandard: event.payload.standardBinding,
      acceptedStandardEvent: event.payload.originAcceptedEvent,
      acceptedGate: event.payload.originAcceptedGate,
      acceptedStandardFloors: event.payload.originAcceptedStandardFloors,
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
    event.approvalRefs.length === 0 && snapshot.pendingAcceptance === null,
    "Reconcile approvals or pending acceptance are invalid",
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
  const operation = snapshot.pendingOperation;
  let nextOperation;
  if (payload.reconciliationKind === "provider-target-assigned/v1") {
    invariant(
      sameValue(payload.observedBinding, operation.targetBinding),
      "Reconcile provider binding differs from the prepared target",
    );
    nextOperation = structuredClone(operation);
  } else if (payload.reconciliationKind === "provider-previous-assigned/v1") {
    invariant(
      operation.previousBinding !== null &&
        sameValue(payload.observedBinding, operation.previousBinding),
      "Reconcile provider binding differs from the prepared previous binding",
    );
    if (payload.observedBinding.releaseRole === "standard") {
      invariant(
        snapshot.containmentCompanion !== null,
        "Reconcile previous standard companion is absent",
      );
      nextOperation = {
        ...structuredClone(operation),
        kind: "rollback-standard",
        targetBinding: structuredClone(payload.observedBinding),
        companionBinding: structuredClone(snapshot.containmentCompanion),
        originBinding: null,
        originCompanionBinding: null,
      };
    } else {
      nextOperation = {
        ...structuredClone(operation),
        kind: "activate-containment",
        targetBinding: structuredClone(payload.observedBinding),
        companionBinding: null,
        originBinding: null,
        originCompanionBinding: null,
      };
    }
  } else {
    invariant(
      payload.reconciliationKind === "provider-emergency-assigned/v1" &&
        sameValue(payload.observedBinding, operation.emergencyRecoveryBinding),
      "Reconcile provider binding differs from the prepared emergency binding",
    );
    const legacyBootstrap =
      payload.observedBinding.publicIdentityKind === "legacy-bootstrap-v1";
    invariant(
      !legacyBootstrap ||
        (operation.kind === "promote-standard" &&
          snapshot.acceptedStandard === null &&
          snapshot.acceptedStandardEvent === null &&
          snapshot.legacyObservedProduction !== null &&
          snapshot.bootstrapRecovery !== null &&
          sameValue(payload.observedBinding, snapshot.bootstrapRecovery)),
      "Legacy emergency reconcile is not an initial promotion recovery",
    );
    nextOperation = {
      ...structuredClone(operation),
      kind: legacyBootstrap ? "promote-standard" : "activate-containment",
      targetBinding: structuredClone(payload.observedBinding),
      companionBinding: null,
      originBinding: null,
      originCompanionBinding: null,
    };
  }
  nextOperation.expectedState = {
    sequence: snapshot.sequence,
    eventHash: snapshot.eventHash,
  };
  const reconciledEventHash = hashReleaseEvent(event);
  nextOperation.reconciliationAuthority = {
    reconciliationKind: payload.reconciliationKind,
    providerObservation: structuredClone(payload.providerObservation),
    stateReconciled: {
      uri:
        `release-state://${event.namespace}/events/${event.sequence}/` +
        reconciledEventHash,
      sha256: reconciledEventHash,
    },
  };
  return finalize(snapshot, event, { pendingOperation: nextOperation });
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
      return applyDeploymentAssigned(snapshot, event);
    case "assignment-validated":
      return applyAssignmentValidated(snapshot, event);
    case "observation-started":
      return applyObservationStarted(snapshot, event);
    case "release-accepted":
      return applyReleaseAccepted(snapshot, event);
    case "phase-exit-attested":
      return applyPhaseExitAttested(snapshot, event);
    case "operation-aborted":
      assertPendingOperation(snapshot, event);
      invariant(
        hasExactKeys(event.payload, []) && event.approvalRefs.length === 0,
        "Operation abort payload or approvals are invalid",
      );
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
