import { canonicalJsonBytes } from "../lib/canonical-json.mjs";
import { FORMAL_PHASE_EXIT_GATES, RELEASE_PHASE_GATES } from "./phaseGates.mjs";
import { hashReleaseEvent } from "./releaseStateReducer.mjs";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SUPPORT_KEYS = Object.freeze([
  "sequence",
  "eventHash",
  "eventType",
  "gate",
  "sourceSha",
  "bindingId",
]);
const NORMAL_PREPARED_OPERATION_KEYS = Object.freeze([
  "operationId",
  "kind",
  "expectedState",
  "targetBinding",
  "originBinding",
  "originCompanionBinding",
  "companionBinding",
  "previousBinding",
  "emergencyRecoveryBinding",
  "approvalRefs",
  "preparedAt",
]);
const NORMAL_ASSIGNMENT_KEYS = Object.freeze([
  "assignmentReceipt",
  "promotionReceipt",
  "targetBinding",
]);
const NORMAL_VALIDATION_KEYS = Object.freeze([
  "assignmentReceipt",
  "assignmentValidation",
  "productionProbe",
  "targetBinding",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
const sameValue = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertHead = (current, head) => {
  if (
    !hasExactKeys(head, ["sequence", "eventHash"]) ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    !SHA256.test(head.eventHash ?? "") ||
    current?.head?.sequence < head.sequence ||
    current.records?.[head.sequence - 1]?.eventHash !== head.eventHash
  ) {
    throw new Error("Phase exit supporting event subject head differs");
  }
};

const assertRecordEnvelope = (record) => {
  if (
    !isRecord(record) ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    !SHA256.test(record.eventHash ?? "") ||
    !isRecord(record.event) ||
    record.event.sequence !== record.sequence ||
    hashReleaseEvent(record.event) !== record.eventHash
  ) {
    throw new Error("Phase exit supporting Release State event is tampered");
  }
  return record;
};

const bindingIdentity = (binding, label) => {
  if (
    !isRecord(binding) ||
    typeof binding.bindingId !== "string" ||
    binding.bindingId.length === 0 ||
    !SOURCE_SHA.test(binding.sourceSha ?? "")
  ) {
    throw new Error(`${label} binding identity is invalid`);
  }
  return { bindingId: binding.bindingId, sourceSha: binding.sourceSha };
};

const recordReference = (record) => ({
  uri:
    `release-state://${record.event.namespace}/events/${record.sequence}/` +
    record.eventHash,
  sha256: record.eventHash,
});

const hasEvidenceReference = (event, reference) =>
  Array.isArray(event.evidenceRefs) &&
  event.evidenceRefs.some((candidate) => sameValue(candidate, reference));

const normalPromotionIdentityForRecord = (current, record) => {
  const event = record.event;
  if (
    event.eventType !== "assignment-validated" ||
    !hasExactKeys(event.payload, NORMAL_VALIDATION_KEYS) ||
    event.approvalRefs?.length !== 0
  ) {
    return null;
  }
  const preparations = current.records.filter(
    (candidate) =>
      candidate.sequence < record.sequence &&
      candidate.event?.eventType === "promotion-prepared" &&
      candidate.event.operationId === event.operationId,
  );
  const assignments = current.records.filter(
    (candidate) =>
      candidate.sequence < record.sequence &&
      candidate.event?.eventType === "deployment-assigned" &&
      candidate.event.operationId === event.operationId,
  );
  if (preparations.length !== 1 || assignments.length !== 1) {
    throw new Error(
      "P0-PROMOTE assignment has no unique prepared assignment lifecycle",
    );
  }
  const preparation = assertRecordEnvelope(preparations[0]);
  const assignment = assertRecordEnvelope(assignments[0]);
  const operation = preparation.event.payload?.pendingOperation;
  if (
    !hasExactKeys(preparation.event.payload, ["pendingOperation"]) ||
    !hasExactKeys(operation, NORMAL_PREPARED_OPERATION_KEYS) ||
    operation.kind !== "promote-standard" ||
    operation.operationId !== event.operationId ||
    preparation.sequence + 1 !== assignment.sequence ||
    assignment.sequence + 1 !== record.sequence ||
    !hasExactKeys(assignment.event.payload, NORMAL_ASSIGNMENT_KEYS) ||
    assignment.event.approvalRefs?.length !== 0 ||
    !sameValue(
      operation.targetBinding,
      assignment.event.payload.targetBinding,
    ) ||
    !sameValue(operation.targetBinding, event.payload.targetBinding) ||
    !sameValue(
      assignment.event.payload.assignmentReceipt,
      event.payload.assignmentReceipt,
    ) ||
    !hasEvidenceReference(assignment.event, recordReference(preparation)) ||
    !hasEvidenceReference(event, recordReference(assignment))
  ) {
    throw new Error(
      "P0-PROMOTE assignment is not the exact normal promotion lifecycle",
    );
  }
  return bindingIdentity(operation.targetBinding, "P0-PROMOTE assignment");
};

const acceptedBindingForRecord = (current, record) => {
  const starts = current.records.filter(
    (candidate) =>
      candidate.sequence < record.sequence &&
      candidate.event?.eventType === "observation-started" &&
      candidate.event.operationId === record.event.operationId,
  );
  if (starts.length !== 1) {
    throw new Error(
      "Release-accepted supporting event has no unique observation authority",
    );
  }
  assertRecordEnvelope(starts[0]);
  return bindingIdentity(
    starts[0].event.payload?.pendingAcceptance?.standardBinding,
    "Release-accepted supporting",
  );
};

const projectRecord = ({ current, record, gate }) => {
  assertRecordEnvelope(record);
  const event = record.event;
  let identity;
  let eventGate;
  if (gate === "P0-DATA") {
    if (event.eventType !== "state-initialized") {
      throw new Error("P0-DATA supporting event is not state initialization");
    }
    identity = bindingIdentity(
      event.payload?.bootstrapRecovery,
      "P0-DATA bootstrap",
    );
    if (!SOURCE_SHA.test(event.payload?.executorSourceSha ?? "")) {
      throw new Error("P0-DATA supporting executor source is invalid");
    }
    identity = {
      bindingId: identity.bindingId,
      sourceSha: event.payload.executorSourceSha,
    };
    eventGate = "P0-DATA";
  } else if (gate === "P0-PROMOTE") {
    identity = normalPromotionIdentityForRecord(current, record);
    if (identity === null) {
      throw new Error(
        "P0-PROMOTE supporting event is not a normal assignment validation",
      );
    }
    eventGate = "P0-PROMOTE";
  } else {
    if (
      event.eventType !== "release-accepted" ||
      event.payload?.acceptedGate !== gate ||
      !RELEASE_PHASE_GATES.includes(gate)
    ) {
      throw new Error(
        "Release gate supporting event is not the exact acceptance",
      );
    }
    identity = acceptedBindingForRecord(current, record);
    eventGate = event.payload.acceptedGate;
  }
  return Object.freeze({
    sequence: record.sequence,
    eventHash: record.eventHash,
    eventType: event.eventType,
    gate: eventGate,
    sourceSha: identity.sourceSha,
    bindingId: identity.bindingId,
  });
};

const assertCurrentSubject = ({
  current,
  gate,
  sourceSha,
  subjectHead,
  support,
}) => {
  const snapshot = current.snapshot;
  if (gate === "P0-DATA") return;
  if (
    current?.head?.sequence !== subjectHead.sequence ||
    current.head.eventHash !== subjectHead.eventHash
  ) {
    throw new Error(`${gate}: new attestation subject is not the live head`);
  }
  if (!isRecord(snapshot)) {
    throw new Error(`${gate}: live Release State snapshot is absent`);
  }
  const supportRecord = current.records[support.sequence - 1];
  if (gate === "P0-PROMOTE") {
    const operation = snapshot.pendingOperation;
    const laterRecords = current.records.slice(
      support.sequence,
      subjectHead.sequence,
    );
    if (
      !isRecord(operation) ||
      operation.operationId !== supportRecord.event.operationId ||
      operation.kind !== "promote-standard" ||
      Object.hasOwn(operation, "reconciliationAuthority") ||
      !sameValue(
        operation.targetBinding,
        supportRecord.event.payload.targetBinding,
      ) ||
      laterRecords.length !== 1 ||
      laterRecords.some(
        (record) =>
          record.event?.eventType !== "observation-started" ||
          record.event.operationId !== operation.operationId,
      ) ||
      !isRecord(snapshot.pendingAcceptance) ||
      snapshot.pendingAcceptance.operationId !== operation.operationId ||
      !sameValue(
        snapshot.pendingAcceptance.standardBinding,
        operation.targetBinding,
      )
    ) {
      throw new Error(
        "P0-PROMOTE supporting lifecycle is not the live normal promotion",
      );
    }
    return;
  }
  const acceptedReference = recordReference(supportRecord);
  const accepted = snapshot.acceptedStandard;
  const laterRecords = current.records.slice(
    support.sequence,
    subjectHead.sequence,
  );
  const exactTerminalHistory =
    gate === "P8-CLEAN"
      ? laterRecords.length === 1 &&
        laterRecords[0].event?.eventType === "policy-activated" &&
        laterRecords[0].event.payload?.activationGate === "P8-CLEAN"
      : laterRecords.length === 0;
  if (
    !exactTerminalHistory ||
    snapshot.acceptedGate !== gate ||
    !sameValue(snapshot.acceptedStandardEvent, acceptedReference) ||
    !sameValue(snapshot.activeProduction, accepted) ||
    snapshot.pendingOperation !== null ||
    snapshot.pendingAcceptance !== null ||
    snapshot.containmentIncident !== null ||
    snapshot.standardRecovery !== null ||
    accepted?.sourceSha !== sourceSha ||
    accepted?.bindingId !== support.bindingId
  ) {
    throw new Error(
      `${gate}: acceptance support is not the current idle accepted binding`,
    );
  }
};

export const assertPhaseExitSupportingEvent = ({
  current,
  gate,
  sourceSha,
  subjectHead,
  supportingEvent,
}) => {
  if (
    !FORMAL_PHASE_EXIT_GATES.includes(gate) ||
    FORMAL_PHASE_EXIT_GATES.indexOf(gate) < 3 ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !Array.isArray(current?.records) ||
    !hasExactKeys(supportingEvent, SUPPORT_KEYS)
  ) {
    throw new Error("Phase exit supporting event context is invalid");
  }
  assertHead(current, subjectHead);
  if (supportingEvent.sequence > subjectHead.sequence) {
    throw new Error("Phase exit subject predates its supporting event");
  }
  const record = current.records[supportingEvent.sequence - 1];
  const expected = projectRecord({ current, record, gate });
  if (
    expected.sourceSha !== sourceSha ||
    !sameValue(expected, supportingEvent)
  ) {
    throw new Error(
      "Phase exit supporting event differs from exact history, source, or binding",
    );
  }
  return expected;
};

export const derivePhaseExitSupportingEvent = ({
  current,
  gate,
  sourceSha,
  subjectHead,
}) => {
  const supportingEvent = resolveCurrentPhaseExitSupportingEvent({
    current,
    gate,
    sourceSha,
    subjectHead,
  });
  if (supportingEvent === null) {
    throw new Error(
      `${gate}: exact supporting event is absent, ambiguous, or wrong-source`,
    );
  }
  return supportingEvent;
};

export const resolveCurrentPhaseExitSupportingEvent = ({
  current,
  gate,
  sourceSha,
  subjectHead,
}) => {
  if (
    !FORMAL_PHASE_EXIT_GATES.includes(gate) ||
    FORMAL_PHASE_EXIT_GATES.indexOf(gate) < 3 ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !Array.isArray(current?.records)
  ) {
    throw new Error(
      "Phase exit supporting event derivation context is invalid",
    );
  }
  assertHead(current, subjectHead);
  if (
    gate === "P0-PROMOTE" &&
    (!isRecord(current.snapshot?.pendingOperation) ||
      current.snapshot.pendingOperation.kind !== "promote-standard" ||
      Object.hasOwn(
        current.snapshot.pendingOperation,
        "reconciliationAuthority",
      ) ||
      !isRecord(current.snapshot?.pendingAcceptance) ||
      current.snapshot.pendingAcceptance.operationId !==
        current.snapshot.pendingOperation.operationId ||
      !sameValue(
        current.snapshot.pendingAcceptance.standardBinding,
        current.snapshot.pendingOperation.targetBinding,
      ))
  ) {
    return null;
  }
  let candidates = current.records
    .filter((record) => record.sequence <= subjectHead.sequence)
    .filter((record) => {
      if (gate === "P0-DATA")
        return record.event?.eventType === "state-initialized";
      if (gate === "P0-PROMOTE") {
        return (
          record.event?.eventType === "assignment-validated" &&
          hasExactKeys(record.event.payload, NORMAL_VALIDATION_KEYS)
        );
      }
      return (
        record.event?.eventType === "release-accepted" &&
        record.event.payload?.acceptedGate === gate
      );
    })
    .map((record) => projectRecord({ current, record, gate }))
    .filter((candidate) => candidate.sourceSha === sourceSha);
  if (gate === "P0-PROMOTE" && isRecord(current.snapshot?.pendingOperation)) {
    candidates = candidates.filter(
      (candidate) =>
        current.records[candidate.sequence - 1]?.event?.operationId ===
        current.snapshot.pendingOperation.operationId,
    );
  } else if (RELEASE_PHASE_GATES.includes(gate)) {
    candidates = candidates.filter((candidate) =>
      sameValue(
        recordReference(current.records[candidate.sequence - 1]),
        current.snapshot?.acceptedStandardEvent,
      ),
    );
  }
  if (candidates.length !== 1) {
    if (candidates.length === 0) return null;
    throw new Error(
      `${gate}: exact supporting event is absent, ambiguous, or wrong-source`,
    );
  }
  const supportingEvent = assertPhaseExitSupportingEvent({
    current,
    gate,
    sourceSha,
    subjectHead,
    supportingEvent: candidates[0],
  });
  assertCurrentSubject({
    current,
    gate,
    sourceSha,
    subjectHead,
    support: supportingEvent,
  });
  return supportingEvent;
};
