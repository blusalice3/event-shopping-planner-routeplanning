import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  assertArtifactManifest,
  assertReleaseIdentity,
} from "../lib/artifact-contract.mjs";
import {
  RELEASE_DIMENSION_KEYS,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import {
  ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
  assertReviewedPerformanceArtifactForAcceptedGate,
  projectOwnGatePerformanceEnvelope,
} from "../lib/performance-evidence-identity.mjs";
import { assertVercelObservationEvidence } from "../provider/collect-vercel-observation.mjs";
import { validateReleaseAEvidence } from "../verify-release-a-evidence.mjs";
import { verifyPerformanceGate } from "../verify-performance-policy.mjs";
import { validatePreparedPromotionResult } from "../provider/preparedPromotion.mjs";
import { validateProductionAssignmentAuthority } from "../provider/productionAssignmentValidation.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import {
  assertRequiredApprovalSet,
  resolveApprovalReference,
} from "./approvalResolver.mjs";
import {
  validateCompanionRecoveryDrill,
  validateContinuousProductionProbe,
} from "./acceptanceEvidenceInputs.mjs";
import {
  assertAcceptanceFinalBundleBinding,
  buildReleaseEvidenceObjectSet,
  loadAcceptanceFinalBundle,
} from "./acceptanceTerminalBundle.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { fetchGitHubProtectedEnvironmentApprovals } from "./githubApprovalReceipt.mjs";
import {
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import { findBindingPolicyCompatibility } from "./policyCompatibility.mjs";
import { assertOwnGatePerformanceProducerReceiptAuthority } from "./ownGatePerformanceEvidence.mjs";
import {
  PROVIDER_ALIAS_OBSERVATION_KIND,
  PROVIDER_ALIAS_OBSERVATION_MEDIA_TYPE,
} from "./reconcileDecision.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  assertArtifactArchiveAvailable,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  collectBindingEvidenceReferences,
  isRecord,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_REFERENCE_PATTERN = (namespace, sha256) =>
  new RegExp(
    `^release-state://${namespace}/(?:evidence|events/[1-9][0-9]*)/${sha256}$`,
  );
const ACCEPTANCE_ROLES = [
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
];
const MINIMUM_OBSERVATION_MILLISECONDS = 24 * 60 * 60 * 1000;
const SOURCE_HARDENED_RECOVERY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_PRODUCTION_PROBE_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_PRODUCTION_PROBE_RECEIPTS = 4096;
const PRODUCTION_API_PATHS = [
  "/api",
  "/api/__foundation-assignment-validation__",
  "/api/csp-report",
  "/api/google-sheets-csv",
  "/api/persistence-release-a-metrics",
];
const ACCEPTED_STANDARD_FLOOR_KEYS = RELEASE_DIMENSION_KEYS.filter(
  (key) => key !== "releaseRole",
);

const PROMOTION_RECEIPT_KEYS = [
  "afterObservation",
  "afterProviderObservation",
  "approvalReferences",
  "assignmentEvidence",
  "beforeObservation",
  "beforeProviderObservation",
  "cli",
  "companion",
  "completedAt",
  "idempotencyKey",
  "outcome",
  "preparedEvent",
  "provider",
  "providerBinding",
  "receiptKind",
  "schemaVersion",
  "sourceSha",
  "target",
];
const ASSIGNMENT_EVIDENCE_KEYS = [
  "assignmentApiReceiptSetHash",
  "assignments",
  "evidenceKind",
  "providerProjectId",
  "schemaVersion",
];
const ASSIGNMENT_VALIDATION_KEYS = [
  "assignmentReceiptSha256",
  "assignmentReceiptUri",
  "assignments",
  "evidenceKind",
  "productionProbeEvidenceHash",
  "providerProjectId",
  "schemaVersion",
];
const ASSIGNMENT_KEYS = [
  "assignedDeploymentId",
  "previousDeploymentId",
  "productionDomain",
];
const DOMAIN_RECEIPT_KEYS = [
  "assignedDeploymentId",
  "bodySha256",
  "etag",
  "method",
  "phase",
  "productionDomain",
  "providerProjectId",
  "receiptKind",
  "requestUrl",
  "responseDate",
  "schemaVersion",
  "status",
];
const PRODUCTION_PROBE_KEYS = [
  "evidenceKind",
  "immutableApiReceipts",
  "immutableRouteProbeEvidenceHash",
  "observedAt",
  "providerAssignmentObservation",
  "providerDeploymentEvidenceHash",
  "providerDeploymentId",
  "providerProjectId",
  "results",
  "schemaVersion",
];
const PRODUCTION_PROBE_RECEIPT_KEYS = [
  "allow",
  "bodySha256",
  "byteLength",
  "cacheControl",
  "contentType",
  "etag",
  "method",
  "path",
  "requestUrl",
  "responseDate",
  "responseUrl",
  "securityHeaders",
  "status",
];
const PRODUCTION_PROBE_SECURITY_HEADER_KEYS = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
];
const PRODUCTION_PROBE_RESULT_KEYS = [
  "productionDomain",
  "providerDeploymentId",
  "receipts",
  "responseSha256",
  "status",
];
const ACCEPTANCE_SUBJECT_KEYS = [
  "acceptedGate",
  "acceptedStandardFloors",
  "assignmentValidationEvidence",
  "clearBootstrapRecovery",
  "companionBinding",
  "companionRecoveryDrill",
  "continuousProductionProbe",
  "expectedState",
  "namespace",
  "observationStartedEvent",
  "observedThrough",
  "operationId",
  "performanceEvidence",
  "releaseAEvidence",
  "rollbackInventory",
  "schemaVersion",
  "standardBinding",
  "subjectKind",
];
const PREPARED_EVENT_KEYS = [
  "committedAt",
  "operationId",
  "sequence",
  "sha256",
  "uri",
];
const TARGET_KEYS = [
  "bindingId",
  "deploymentUrl",
  "providerDeploymentEvidenceSha256",
  "providerDeploymentId",
  "releaseRole",
];
const COMPANION_KEYS = [
  "bindingId",
  "providerDeploymentEvidenceSha256",
  "providerDeploymentId",
  "releaseRole",
];
const PROVIDER_BINDING_KEYS = [
  "afterProviderObservationSha256",
  "beforeProviderObservationSha256",
  "providerConfigurationHash",
  "providerPolicySha256",
  "providerProjectId",
  "providerTeamId",
];
const OBSERVATION_WRAPPER_KEYS = ["sha256", "value"];
const CLI_KEYS = ["executed", "operation", "package", "version"];
const APPROVAL_REFERENCE_KEYS = ["role", "sha256", "uri"];

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical ISO timestamp`);
  }
  return milliseconds;
};

const readClock = (clock, label) => {
  if (typeof clock !== "function") {
    throw new TypeError(`${label} clock is invalid`);
  }
  const milliseconds = clock();
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} clock returned an invalid time`);
  }
  return milliseconds;
};

const assertStore = (store) => {
  if (
    !store ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function" ||
    typeof store.compareAndAppend !== "function" ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error(
      "Release State store lacks replay, CAS, or immutable evidence operations",
    );
  }
};

const assertNoCallerAuthority = (options) => {
  for (const field of [
    "acceptedStandardFloors",
    "approvalRefs",
    "clock",
    "floors",
    "inventory",
    "minimumObservationEndsAt",
    "now",
    "nowMilliseconds",
    "observationNotBefore",
    "observedThrough",
    "pendingAcceptance",
    "roles",
    "snapshot",
    "timestamps",
  ]) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `Caller-supplied ${field} is forbidden; lifecycle authority is derived internally`,
      );
    }
  }
};

const deterministicUuid = (value) => {
  const digest = Buffer.from(sha256Json(value), "hex").subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
  if (!UUID_V4_PATTERN.test(uuid)) {
    throw new Error("Deterministic append ID is invalid");
  }
  return uuid;
};

export const deriveLifecycleAppendId = ({
  kind,
  namespace,
  operationId,
  evidenceSha256,
}) =>
  deterministicUuid({
    kind: `release-state-lifecycle-append/${kind}/v1`,
    namespace,
    operationId,
    evidenceSha256,
  });

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !SHA256_PATTERN.test(reference.sha256) ||
    !EVENT_REFERENCE_PATTERN(namespace, reference.sha256).test(reference.uri)
  ) {
    throw new Error(`${label} is not bound to the Release State namespace`);
  }
  return reference;
};

const sortAndDedupeReferences = (references, namespace) => {
  const byUri = new Map();
  for (const reference of references) {
    assertReference(reference, namespace, "Lifecycle evidence reference");
    const previous = byUri.get(reference.uri);
    if (previous && previous.sha256 !== reference.sha256) {
      throw new Error("Lifecycle evidence URI has conflicting hashes");
    }
    byUri.set(reference.uri, reference);
  }
  return [...byUri.values()].sort((left, right) =>
    compareUtf8(left.uri, right.uri),
  );
};

const eventReference = (namespace, record) => ({
  uri: `release-state://${namespace}/events/${record.sequence}/${record.eventHash}`,
  sha256: record.eventHash,
});

export const resolveAcceptedStandardAuthority = ({ current, binding }) => {
  if (!isRecord(current?.snapshot) || !isRecord(binding)) {
    throw new Error("Accepted standard authority input is invalid");
  }
  const candidateReferences = [];
  if (
    sameCanonicalValue(current.snapshot.acceptedStandard, binding) &&
    current.snapshot.acceptedStandardEvent !== null
  ) {
    candidateReferences.push(current.snapshot.acceptedStandardEvent);
  }
  for (const entry of current.snapshot.rollbackInventory) {
    if (sameCanonicalValue(entry.binding, binding)) {
      candidateReferences.push(entry.acceptedEvent);
    }
  }
  const distinctReferences = [
    ...new Map(
      candidateReferences.map((reference) => [reference.uri, reference]),
    ).values(),
  ];
  if (distinctReferences.length !== 1) {
    throw new Error("Accepted standard event authority is absent or ambiguous");
  }
  const acceptedEvent = distinctReferences[0];
  let replayed = null;
  let match = null;
  for (const record of current.records) {
    replayed = reduceReleaseState(replayed, record.event);
    const reference = eventReference(record.event.namespace, record);
    if (sameCanonicalValue(reference, acceptedEvent)) {
      if (
        record.event.eventType !== "release-accepted" ||
        !sameCanonicalValue(replayed.acceptedStandard, binding) ||
        !sameCanonicalValue(replayed.acceptedStandardEvent, reference) ||
        !sameCanonicalValue(
          replayed.acceptedStandardFloors,
          record.event.payload.acceptedStandardFloors,
        ) ||
        replayed.acceptedGate !== record.event.payload.acceptedGate
      ) {
        throw new Error(
          "Accepted standard event does not authorize the selected binding",
        );
      }
      match = {
        acceptedEvent: structuredClone(reference),
        acceptedGate: record.event.payload.acceptedGate,
        acceptedStandardFloors: structuredClone(
          record.event.payload.acceptedStandardFloors,
        ),
      };
    }
  }
  if (match === null) {
    throw new Error("Accepted standard event could not be read back");
  }
  return match;
};

const putImmutableEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const objectBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const expectedSha256 = sha256Bytes(objectBytes);
  const receipt = await store.putEvidence({ bytes: objectBytes, mediaType });
  if (
    !receipt ||
    receipt.uri !== `release-state://${namespace}/evidence/${expectedSha256}` ||
    receipt.sha256 !== expectedSha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== objectBytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256: expectedSha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    !stored.bytes.equals(objectBytes) ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return { uri: receipt.uri, sha256: expectedSha256 };
};

const findAppendRecord = (current, appendId) => {
  const records = current.records.filter(
    (record) => record.event.appendId === appendId,
  );
  if (records.length > 1) {
    throw new Error("Lifecycle append ID is ambiguous");
  }
  return records[0] ?? null;
};

const assertExistingEvent = ({
  record,
  eventType,
  operationId,
  payload,
  evidenceRefs,
  approvalRefs = [],
}) => {
  if (
    record.event.eventType !== eventType ||
    record.event.operationId !== operationId ||
    !sameCanonicalValue(record.event.payload, payload) ||
    !sameCanonicalValue(record.event.evidenceRefs, evidenceRefs) ||
    !sameCanonicalValue(record.event.approvalRefs, approvalRefs) ||
    hashReleaseEvent(record.event) !== record.eventHash
  ) {
    throw new Error("Existing lifecycle event differs from retry input");
  }
  return record;
};

const appendLifecycleEvent = async ({
  store,
  current,
  eventType,
  operationId,
  appendId,
  payload,
  evidenceRefs,
  approvalRefs = [],
  readState = readCurrentReleaseState,
}) => {
  const existing = findAppendRecord(current, appendId);
  if (existing) {
    assertExistingEvent({
      record: existing,
      eventType,
      operationId,
      payload,
      evidenceRefs,
      approvalRefs,
    });
    return { current, record: existing, replayed: true };
  }
  const event = createReleaseEvent({
    namespace: store.namespace,
    sequence: current.snapshot.sequence + 1,
    eventType,
    operationId,
    appendId,
    previousEventHash: current.snapshot.eventHash,
    payload,
    evidenceRefs,
    approvalRefs,
  });
  reduceReleaseState(current.snapshot, event);
  const eventHash = hashReleaseEvent(event);
  const receipt = await store.compareAndAppend({
    expectedSequence: current.snapshot.sequence,
    expectedHash: current.snapshot.eventHash,
    event,
  });
  if (
    !receipt ||
    receipt.namespace !== store.namespace ||
    receipt.sequence !== event.sequence ||
    receipt.eventHash !== eventHash ||
    typeof receipt.replayed !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new Error("Lifecycle CAS receipt differs from the submitted event");
  }
  const committed = await readState({ store });
  const record = committed.records.find(
    (candidate) =>
      candidate.sequence === event.sequence &&
      candidate.eventHash === eventHash &&
      candidate.event.appendId === appendId,
  );
  if (!record) {
    throw new Error("Committed lifecycle event was not recovered by replay");
  }
  return { current: committed, record, replayed: receipt.replayed };
};

export const appendReadyReconciliation = async (
  { store, decision },
  { readState = readCurrentReleaseState } = {},
) => {
  assertStore(store);
  if (!isRecord(decision) || !["ready", "blocked"].includes(decision.status)) {
    throw new Error("Reconcile decision is invalid");
  }
  if (decision.status === "blocked") {
    return { ...decision, appended: false };
  }
  const plan = decision.eventPlan;
  assertExactKeys(
    plan,
    ["eventType", "evidenceRefs", "expectedState", "operationId", "payload"],
    "Ready reconcile event plan",
  );
  if (
    plan.eventType !== "state-reconciled" ||
    !isRecord(plan.expectedState) ||
    !Number.isSafeInteger(plan.expectedState.sequence) ||
    !SHA256_PATTERN.test(plan.expectedState.eventHash) ||
    plan.operationId !== decision.operationId ||
    plan.payload?.providerObservation?.sha256 !== decision.observationSha256
  ) {
    throw new Error("Ready reconcile event plan binding is invalid");
  }
  const current = await readState({ store });
  const appendId = deriveLifecycleAppendId({
    kind: "state-reconciled",
    namespace: store.namespace,
    operationId: plan.operationId,
    evidenceSha256: decision.observationSha256,
  });
  const evidenceRefs = sortAndDedupeReferences(
    plan.evidenceRefs,
    store.namespace,
  );
  const storedObservation = await assertEvidenceObjectAvailable({
    store,
    reference: plan.payload.providerObservation,
    namespace: store.namespace,
    label: "Reconcile provider observation",
  });
  const providerObservation = parseCanonicalJsonBytes(
    storedObservation.bytes,
    "Reconcile provider observation",
  );
  assertExactKeys(
    providerObservation,
    [
      "assignments",
      "namespace",
      "observationKind",
      "observedBinding",
      "providerProjectId",
      "providerReceiptReferences",
      "schemaVersion",
    ],
    "Reconcile provider observation",
  );
  if (
    storedObservation.mediaType !== PROVIDER_ALIAS_OBSERVATION_MEDIA_TYPE ||
    providerObservation.schemaVersion !== 1 ||
    providerObservation.observationKind !== PROVIDER_ALIAS_OBSERVATION_KIND ||
    providerObservation.namespace !== store.namespace ||
    providerObservation.providerProjectId !==
      plan.payload.observedBinding.providerProjectId ||
    !sameCanonicalValue(
      providerObservation.observedBinding,
      plan.payload.observedBinding,
    ) ||
    !Array.isArray(providerObservation.assignments) ||
    providerObservation.assignments.length === 0 ||
    providerObservation.assignments.some(
      (assignment) =>
        !isRecord(assignment) ||
        assignment.assignedDeploymentId !==
          plan.payload.observedBinding.providerDeploymentId,
    ) ||
    !Array.isArray(providerObservation.providerReceiptReferences) ||
    providerObservation.providerReceiptReferences.length === 0 ||
    providerObservation.providerReceiptReferences.some(
      (reference) =>
        !evidenceRefs.some((candidate) =>
          sameCanonicalValue(candidate, reference),
        ),
    )
  ) {
    throw new Error("Reconcile provider observation authority is invalid");
  }
  const existing = findAppendRecord(current, appendId);
  let reconciled;
  if (existing) {
    if (
      plan.expectedState.sequence !== existing.event.sequence - 1 ||
      plan.expectedState.eventHash !== existing.event.previousEventHash
    ) {
      throw new Error(
        "Reconcile retry expected state differs from the committed predecessor",
      );
    }
    assertExistingEvent({
      record: existing,
      eventType: "state-reconciled",
      operationId: plan.operationId,
      payload: plan.payload,
      evidenceRefs,
    });
    reconciled = { current, record: existing, replayed: true };
  } else {
    if (
      current.head.sequence !== plan.expectedState.sequence ||
      current.head.eventHash !== plan.expectedState.eventHash
    ) {
      throw new Error("Reconcile event plan does not bind the replayed head");
    }
    reconciled = await appendLifecycleEvent({
      store,
      current,
      eventType: "state-reconciled",
      operationId: plan.operationId,
      appendId,
      payload: plan.payload,
      evidenceRefs,
      readState,
    });
  }
  const reconciledReference = eventReference(
    store.namespace,
    reconciled.record,
  );
  let reconciliationSnapshot = null;
  for (const record of reconciled.current.records) {
    reconciliationSnapshot = reduceReleaseState(
      reconciliationSnapshot,
      record.event,
    );
    if (record.eventHash === reconciled.record.eventHash) break;
  }
  if (
    reconciliationSnapshot === null ||
    reconciliationSnapshot.eventHash !== reconciled.record.eventHash
  ) {
    throw new Error("Reconcile authority event could not be replayed");
  }
  if (decision.terminalPlan === null) {
    return {
      ...decision,
      appended: true,
      replayed: reconciled.replayed,
      event: reconciled.record.event,
      eventHash: reconciled.record.eventHash,
      eventUri: reconciledReference.uri,
      head: reconciled.current.head,
    };
  }

  const terminalPlan = decision.terminalPlan;
  assertExactKeys(
    terminalPlan,
    ["approvalRefs", "eventType", "payload", "targetBinding"],
    "Reconcile terminal plan",
  );
  if (
    ![
      "containment-activated",
      "package-redeploy-activated",
      "rollback-activated",
      "temporary-containment-activated",
    ].includes(terminalPlan.eventType) ||
    !sameCanonicalValue(
      terminalPlan.targetBinding,
      reconciliationSnapshot.pendingOperation?.targetBinding,
    ) ||
    !sameCanonicalValue(
      terminalPlan.approvalRefs,
      reconciliationSnapshot.pendingOperation?.approvalRefs,
    )
  ) {
    throw new Error("Reconcile terminal plan differs from replayed authority");
  }
  if (terminalPlan.targetBinding.publicIdentityKind !== "legacy-bootstrap-v1") {
    await assertArtifactArchiveAvailable({
      store,
      namespace: store.namespace,
      binding: terminalPlan.targetBinding,
      label: "Reconcile terminal target",
    });
  }
  const companionBinding =
    terminalPlan.payload.companionBinding ??
    reconciliationSnapshot.pendingOperation.companionBinding;
  if (companionBinding !== null) {
    await assertArtifactArchiveAvailable({
      store,
      namespace: store.namespace,
      binding: companionBinding,
      label: "Reconcile terminal companion",
    });
  }

  const validated = await appendLifecycleEvent({
    store,
    current: reconciled.current,
    eventType: "assignment-validated",
    operationId: plan.operationId,
    appendId: deriveLifecycleAppendId({
      kind: `reconcile-assignment-validated/${plan.payload.reconciliationKind}`,
      namespace: store.namespace,
      operationId: plan.operationId,
      evidenceSha256: decision.observationSha256,
    }),
    payload: {
      reconciliationKind: plan.payload.reconciliationKind,
      providerObservation: plan.payload.providerObservation,
      stateReconciled: reconciledReference,
      targetBinding: terminalPlan.targetBinding,
    },
    evidenceRefs: sortAndDedupeReferences(
      [...evidenceRefs, reconciledReference],
      store.namespace,
    ),
    readState,
  });
  const acceptedOriginEvidence = Object.hasOwn(
    terminalPlan.payload,
    "originAcceptedEvent",
  )
    ? [terminalPlan.payload.originAcceptedEvent]
    : [];
  const terminal = await appendLifecycleEvent({
    store,
    current: validated.current,
    eventType: terminalPlan.eventType,
    operationId: plan.operationId,
    appendId: deriveLifecycleAppendId({
      kind: `reconcile-${terminalPlan.eventType}/${plan.payload.reconciliationKind}`,
      namespace: store.namespace,
      operationId: plan.operationId,
      evidenceSha256: decision.observationSha256,
    }),
    payload: terminalPlan.payload,
    evidenceRefs: sortAndDedupeReferences(
      [
        ...evidenceRefs,
        ...acceptedOriginEvidence,
        eventReference(store.namespace, validated.record),
      ],
      store.namespace,
    ),
    approvalRefs: terminalPlan.approvalRefs,
    readState,
  });
  return {
    ...decision,
    appended: true,
    replayed: reconciled.replayed && validated.replayed && terminal.replayed,
    event: reconciled.record.event,
    eventHash: reconciled.record.eventHash,
    eventUri: reconciledReference.uri,
    terminalEvent: terminal.record.event,
    terminalEventHash: terminal.record.eventHash,
    terminalEventUri: eventReference(store.namespace, terminal.record).uri,
    head: terminal.current.head,
  };
};

const assertCanonicalWrappedObservation = ({
  wrapper,
  label,
  expectedSha256 = null,
}) => {
  assertExactKeys(wrapper, OBSERVATION_WRAPPER_KEYS, label);
  const actualSha256 = sha256Json(wrapper.value);
  if (
    wrapper.sha256 !== actualSha256 ||
    (expectedSha256 !== null && wrapper.sha256 !== expectedSha256)
  ) {
    throw new Error(`${label} hash differs from its canonical value`);
  }
  return wrapper.value;
};

const assertFreshCompletedAt = ({
  completedAt,
  providerPolicy,
  nowMilliseconds,
  responseDates,
}) => {
  const completed = assertTimestamp(completedAt, "Promotion completedAt");
  const maximumAge =
    providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000;
  const maximumFuture =
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000;
  const age = nowMilliseconds - completed;
  if (age > maximumAge || age < -maximumFuture) {
    throw new Error("Promotion completedAt is outside provider freshness");
  }
  for (const responseDate of responseDates) {
    const response = assertTimestamp(
      new Date(Date.parse(responseDate)).toISOString(),
      "Provider response Date",
    );
    if (response > completed || completed - response > maximumAge) {
      throw new Error(
        "Promotion completedAt does not follow fresh authoritative provider Dates",
      );
    }
  }
  return completed;
};

const assertDomainObservation = ({
  observation,
  phase,
  providerPolicy,
  targetDeploymentId,
  allowedBeforeDeploymentIds = [],
}) => {
  assertExactKeys(
    observation,
    [
      "observationKind",
      "observedAt",
      "phase",
      "providerProjectId",
      "providerTeamId",
      "receipts",
      "schemaVersion",
    ],
    `${phase} domain observation`,
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !== "vercel-owned-domain-assignment/v1" ||
    observation.phase !== phase ||
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    observation.providerTeamId !== providerPolicy.expectedTeamId ||
    !Array.isArray(observation.receipts)
  ) {
    throw new Error(`${phase} domain observation binding is invalid`);
  }
  assertTimestamp(observation.observedAt, `${phase} observation time`);
  const expectedDomains = providerPolicy.ownedProductionDomains;
  const actualDomains = observation.receipts.map(
    (entry) => entry.productionDomain,
  );
  if (!sameCanonicalValue(actualDomains, expectedDomains)) {
    throw new Error(`${phase} domain observation set differs from policy`);
  }
  const responseDates = [];
  for (const entry of observation.receipts) {
    assertExactKeys(
      entry,
      ["productionDomain", "receipt", "receiptSha256"],
      `${phase} domain receipt`,
    );
    assertExactKeys(
      entry.receipt,
      DOMAIN_RECEIPT_KEYS,
      `${phase} authoritative domain receipt`,
    );
    const expectedRequestUrl = new URL(
      `/v4/aliases/${encodeURIComponent(entry.productionDomain)}`,
      providerPolicy.observationPolicy.apiBaseUrl,
    );
    expectedRequestUrl.searchParams.set(
      "projectId",
      providerPolicy.expectedProjectId,
    );
    expectedRequestUrl.searchParams.set(
      "teamId",
      providerPolicy.expectedTeamId,
    );
    expectedRequestUrl.searchParams.sort();
    if (
      entry.receiptSha256 !== sha256Json(entry.receipt) ||
      entry.receipt.schemaVersion !== 1 ||
      entry.receipt.receiptKind !== "vercel-domain-assignment-observation/v1" ||
      entry.receipt.phase !== phase ||
      entry.receipt.productionDomain !== entry.productionDomain ||
      entry.receipt.method !== "GET" ||
      entry.receipt.requestUrl !== expectedRequestUrl.href ||
      entry.receipt.status !== 200 ||
      !SHA256_PATTERN.test(entry.receipt.bodySha256) ||
      !(
        entry.receipt.etag === null ||
        (typeof entry.receipt.etag === "string" &&
          entry.receipt.etag.length > 0 &&
          entry.receipt.etag.length <= 512)
      ) ||
      entry.receipt.providerProjectId !== providerPolicy.expectedProjectId ||
      entry.receipt.assignedDeploymentId === null
    ) {
      throw new Error(`${phase} domain receipt hash or binding is invalid`);
    }
    if (
      phase === "after" &&
      entry.receipt.assignedDeploymentId !== targetDeploymentId
    ) {
      throw new Error("After-promotion domain does not target the deployment");
    }
    responseDates.push(entry.receipt.responseDate);
  }
  const assignedDeploymentIds = new Set(
    observation.receipts.map((entry) => entry.receipt.assignedDeploymentId),
  );
  if (
    phase === "before" &&
    (assignedDeploymentIds.size !== 1 ||
      !allowedBeforeDeploymentIds.includes(
        observation.receipts[0]?.receipt.assignedDeploymentId,
      ))
  ) {
    throw new Error(
      "Before-promotion domains do not uniformly target the prepared predecessor",
    );
  }
  return responseDates;
};

const assertProviderObservation = ({
  observation,
  label,
  providerPolicy,
  expectedConfigurationHash,
}) => {
  if (
    !isRecord(observation) ||
    observation.schemaVersion !== 1 ||
    observation.evidenceKind !== "vercel-provider-observation-v1" ||
    observation.provider !== "vercel" ||
    observation.providerTeamId !== providerPolicy.expectedTeamId ||
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(
      observation.ownedProductionDomains,
      providerPolicy.ownedProductionDomains,
    ) ||
    !Array.isArray(observation.evidenceReceipts) ||
    providerConfigurationHash(observation) !== expectedConfigurationHash
  ) {
    throw new Error(`${label} provider observation binding is invalid`);
  }
  assertTimestamp(observation.observedAt, `${label} provider observedAt`);
  return observation.evidenceReceipts.map((receipt) => {
    if (
      !isRecord(receipt) ||
      typeof receipt.responseDate !== "string" ||
      !SHA256_PATTERN.test(receipt.responseSha256)
    ) {
      throw new Error(`${label} provider receipt is invalid`);
    }
    return receipt.responseDate;
  });
};

const assertAssignmentArray = ({
  assignments,
  providerPolicy,
  targetDeploymentId,
  label,
}) => {
  if (!Array.isArray(assignments)) {
    throw new Error(`${label} assignments are invalid`);
  }
  const domains = assignments.map((assignment) => {
    assertExactKeys(assignment, ASSIGNMENT_KEYS, `${label} assignment`);
    if (
      assignment.assignedDeploymentId !== targetDeploymentId ||
      (typeof assignment.previousDeploymentId !== "string" &&
        assignment.previousDeploymentId !== null)
    ) {
      throw new Error(`${label} assignment target is invalid`);
    }
    return assignment.productionDomain;
  });
  if (
    !sameCanonicalValue(domains, providerPolicy.ownedProductionDomains) ||
    new Set(domains).size !== domains.length
  ) {
    throw new Error(`${label} does not cover the owned domain set`);
  }
};

const validatePromotionReceipt = ({
  receiptBytes,
  validatedPrepared,
  providerPolicy,
  nowMilliseconds,
  validateProviderObservation,
}) => {
  const receipt = parseCanonicalJsonBytes(
    receiptBytes,
    "Prepared promotion receipt",
  );
  assertExactKeys(receipt, PROMOTION_RECEIPT_KEYS, "Promotion receipt");
  const { result, event, operation, providerPolicySha256 } = validatedPrepared;
  const target = operation.targetBinding;
  const companion = operation.companionBinding;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== "vercel-prepared-promotion/v1" ||
    receipt.provider !== "vercel" ||
    !["promoted", "replayed"].includes(receipt.outcome) ||
    receipt.sourceSha !== target.sourceSha
  ) {
    throw new Error("Promotion receipt identity is invalid");
  }
  assertExactKeys(receipt.preparedEvent, PREPARED_EVENT_KEYS, "Prepared event");
  if (
    receipt.preparedEvent.uri !== result.eventUri ||
    receipt.preparedEvent.sha256 !== result.eventHash ||
    receipt.preparedEvent.sequence !== event.sequence ||
    receipt.preparedEvent.operationId !== event.operationId ||
    receipt.preparedEvent.committedAt !== result.committedAt
  ) {
    throw new Error("Promotion receipt prepared event differs");
  }
  assertExactKeys(receipt.target, TARGET_KEYS, "Promotion target");
  if (companion === null) {
    if (receipt.companion !== null) {
      throw new Error("Containment promotion receipt claimed a companion");
    }
  } else {
    assertExactKeys(receipt.companion, COMPANION_KEYS, "Promotion companion");
  }
  if (
    receipt.target.bindingId !== target.bindingId ||
    receipt.target.releaseRole !== target.releaseRole ||
    receipt.target.providerDeploymentId !== target.providerDeploymentId ||
    receipt.target.deploymentUrl !== target.deploymentUrl ||
    receipt.target.providerDeploymentEvidenceSha256 !==
      target.providerEvidence.sha256 ||
    (companion !== null &&
      (receipt.companion.bindingId !== companion.bindingId ||
        receipt.companion.releaseRole !== "containment" ||
        receipt.companion.providerDeploymentId !==
          companion.providerDeploymentId ||
        receipt.companion.providerDeploymentEvidenceSha256 !==
          companion.providerEvidence.sha256))
  ) {
    throw new Error("Promotion receipt target pair differs from pending state");
  }
  assertExactKeys(
    receipt.providerBinding,
    PROVIDER_BINDING_KEYS,
    "Promotion provider binding",
  );
  if (
    receipt.providerBinding.providerTeamId !== providerPolicy.expectedTeamId ||
    receipt.providerBinding.providerProjectId !==
      providerPolicy.expectedProjectId ||
    receipt.providerBinding.providerPolicySha256 !== providerPolicySha256 ||
    receipt.providerBinding.providerConfigurationHash !==
      target.providerConfigurationHash
  ) {
    throw new Error("Promotion provider binding differs from policy or target");
  }
  if (
    !Array.isArray(receipt.approvalReferences) ||
    receipt.approvalReferences.length !== result.approvalRefs.length
  ) {
    throw new Error("Promotion approval reference set is invalid");
  }
  receipt.approvalReferences.forEach((reference, index) => {
    assertExactKeys(
      reference,
      APPROVAL_REFERENCE_KEYS,
      "Promotion approval reference",
    );
    const expected = result.approvalRefs[index];
    if (
      reference.role !== expected.role ||
      reference.uri !== expected.uri ||
      reference.sha256 !== expected.sha256
    ) {
      throw new Error("Promotion approval reference differs");
    }
  });
  assertExactKeys(receipt.cli, CLI_KEYS, "Promotion CLI receipt");
  if (
    receipt.cli.package !== "vercel" ||
    receipt.cli.operation !== "promote" ||
    typeof receipt.cli.version !== "string" ||
    typeof receipt.cli.executed !== "boolean"
  ) {
    throw new Error("Promotion CLI receipt is invalid");
  }
  const expectedIdempotencyKey = `promotion:${sha256Json({
    kind: "prepared-provider-promotion/v1",
    eventHash: result.eventHash,
    providerTeamId: providerPolicy.expectedTeamId,
    providerProjectId: providerPolicy.expectedProjectId,
    domains: providerPolicy.ownedProductionDomains,
    targetDeploymentId: target.providerDeploymentId,
  })}`;
  if (receipt.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error("Promotion idempotency binding differs");
  }

  const beforeProvider = assertCanonicalWrappedObservation({
    wrapper: receipt.beforeProviderObservation,
    label: "Before provider observation",
    expectedSha256: receipt.providerBinding.beforeProviderObservationSha256,
  });
  const afterProvider = assertCanonicalWrappedObservation({
    wrapper: receipt.afterProviderObservation,
    label: "After provider observation",
    expectedSha256: receipt.providerBinding.afterProviderObservationSha256,
  });
  const before = assertCanonicalWrappedObservation({
    wrapper: receipt.beforeObservation,
    label: "Before domain observation",
  });
  const after = assertCanonicalWrappedObservation({
    wrapper: receipt.afterObservation,
    label: "After domain observation",
  });
  validateProviderObservation(beforeProvider, providerPolicy, nowMilliseconds);
  validateProviderObservation(afterProvider, providerPolicy, nowMilliseconds);
  const responseDates = [
    ...assertProviderObservation({
      observation: beforeProvider,
      label: "Before",
      providerPolicy,
      expectedConfigurationHash: target.providerConfigurationHash,
    }),
    ...assertProviderObservation({
      observation: afterProvider,
      label: "After",
      providerPolicy,
      expectedConfigurationHash: target.providerConfigurationHash,
    }),
    ...assertDomainObservation({
      observation: before,
      phase: "before",
      providerPolicy,
      targetDeploymentId: target.providerDeploymentId,
      allowedBeforeDeploymentIds: [
        target.providerDeploymentId,
        operation.previousBinding?.providerDeploymentId,
      ].filter((value) => typeof value === "string"),
    }),
    ...assertDomainObservation({
      observation: after,
      phase: "after",
      providerPolicy,
      targetDeploymentId: target.providerDeploymentId,
    }),
  ];
  const completedMilliseconds = assertFreshCompletedAt({
    completedAt: receipt.completedAt,
    providerPolicy,
    nowMilliseconds,
    responseDates,
  });

  assertExactKeys(
    receipt.assignmentEvidence,
    ASSIGNMENT_EVIDENCE_KEYS,
    "Assignment receipt evidence",
  );
  const assignmentEvidence = receipt.assignmentEvidence;
  if (
    assignmentEvidence.schemaVersion !== 1 ||
    assignmentEvidence.evidenceKind !== "assignment-receipt" ||
    assignmentEvidence.providerProjectId !== providerPolicy.expectedProjectId ||
    assignmentEvidence.assignmentApiReceiptSetHash !==
      sha256Json({
        before: before.receipts,
        after: after.receipts,
      })
  ) {
    throw new Error("Assignment receipt evidence binding is invalid");
  }
  assertAssignmentArray({
    assignments: assignmentEvidence.assignments,
    providerPolicy,
    targetDeploymentId: target.providerDeploymentId,
    label: "Assignment receipt evidence",
  });
  const afterAssignments = after.receipts.map((entry) => ({
    productionDomain: entry.productionDomain,
    previousDeploymentId:
      before.receipts.find(
        (beforeEntry) =>
          beforeEntry.productionDomain === entry.productionDomain,
      )?.receipt?.assignedDeploymentId ?? null,
    assignedDeploymentId: entry.receipt.assignedDeploymentId,
  }));
  if (!sameCanonicalValue(afterAssignments, assignmentEvidence.assignments)) {
    throw new Error(
      "Assignment receipt evidence differs from after observations",
    );
  }
  return {
    receipt,
    assignmentEvidence,
    completedMilliseconds,
    nestedEvidence: {
      beforeProvider,
      afterProvider,
      before,
      after,
    },
  };
};

const assertProbeHeaderValue = (value, label) => {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length > 8192 ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== 0x09 && (codePoint <= 0x1f || codePoint === 0x7f);
      }))
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const validateProductionProbeReceipt = ({
  receipt,
  expectedOrigin,
  expectedPath,
  providerPolicy,
  nowMilliseconds,
  requireFresh,
  label,
}) => {
  assertExactKeys(receipt, PRODUCTION_PROBE_RECEIPT_KEYS, label);
  assertExactKeys(
    receipt.securityHeaders,
    PRODUCTION_PROBE_SECURITY_HEADER_KEYS,
    `${label} security headers`,
  );
  const responseMilliseconds = Date.parse(receipt.responseDate);
  const expectedUrl = `${expectedOrigin}${expectedPath}`;
  if (
    receipt.method !== "GET" ||
    receipt.path !== expectedPath ||
    receipt.requestUrl !== expectedUrl ||
    receipt.responseUrl !== expectedUrl ||
    !Number.isSafeInteger(receipt.status) ||
    receipt.status < 100 ||
    receipt.status > 599 ||
    !SHA256_PATTERN.test(receipt.bodySha256) ||
    !Number.isSafeInteger(receipt.byteLength) ||
    receipt.byteLength < 0 ||
    receipt.byteLength > MAX_PRODUCTION_PROBE_RECEIPT_BYTES ||
    !Number.isFinite(responseMilliseconds)
  ) {
    throw new Error(`${label} is not bound to its exact route response`);
  }
  const maximumAge =
    providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000;
  const maximumFutureSkew =
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000;
  if (
    (requireFresh && nowMilliseconds - responseMilliseconds > maximumAge) ||
    (requireFresh && responseMilliseconds - nowMilliseconds > maximumFutureSkew)
  ) {
    throw new Error(`${label} is outside provider freshness`);
  }
  for (const [name, value] of [
    ["ETag", receipt.etag],
    ["content type", receipt.contentType],
    ["cache control", receipt.cacheControl],
    ["Allow", receipt.allow],
  ]) {
    assertProbeHeaderValue(value, `${label} ${name}`);
  }
  for (const [name, value] of Object.entries(receipt.securityHeaders)) {
    assertProbeHeaderValue(value, `${label} ${name}`);
  }
  return responseMilliseconds;
};

const validateProductionProbeReceipts = ({
  receipts,
  expectedOrigin,
  expectedPaths,
  providerPolicy,
  nowMilliseconds,
  requireFresh,
  label,
}) => {
  if (
    !Array.isArray(receipts) ||
    receipts.length !== expectedPaths.length ||
    receipts.length === 0 ||
    receipts.length > MAX_PRODUCTION_PROBE_RECEIPTS
  ) {
    throw new Error(`${label} does not cover its exact route set`);
  }
  return receipts.map((receipt, index) =>
    validateProductionProbeReceipt({
      receipt,
      expectedOrigin,
      expectedPath: expectedPaths[index],
      providerPolicy,
      nowMilliseconds,
      requireFresh,
      label: `${label} ${expectedPaths[index]}`,
    }),
  );
};

const validateAssignmentEvidence = ({
  validationBytes,
  productionProbeBytes,
  assignmentEvidence,
  assignmentReference,
  assignmentAuthority,
  providerPolicy,
  providerEvidence,
  targetBinding,
  completedMilliseconds,
  nowMilliseconds,
  requireFresh,
}) => {
  const targetDeploymentId = targetBinding.providerDeploymentId;
  const validation = parseCanonicalJsonBytes(
    validationBytes,
    "Assignment validation evidence",
  );
  assertExactKeys(
    validation,
    ASSIGNMENT_VALIDATION_KEYS,
    "Assignment validation evidence",
  );
  if (
    validation.schemaVersion !== 1 ||
    validation.evidenceKind !== "assignment-validation" ||
    validation.providerProjectId !== providerPolicy.expectedProjectId ||
    validation.assignmentReceiptUri !== assignmentReference.uri ||
    validation.assignmentReceiptSha256 !== assignmentReference.sha256 ||
    !sameCanonicalValue(validation.assignments, assignmentEvidence.assignments)
  ) {
    throw new Error(
      "Assignment validation does not bind the assignment receipt",
    );
  }
  assertAssignmentArray({
    assignments: validation.assignments,
    providerPolicy,
    targetDeploymentId,
    label: "Assignment validation",
  });
  const probe = parseCanonicalJsonBytes(
    productionProbeBytes,
    "Production probe evidence",
  );
  if (
    validation.productionProbeEvidenceHash !== sha256Bytes(productionProbeBytes)
  ) {
    throw new Error("Production probe evidence hash differs");
  }
  assertExactKeys(probe, PRODUCTION_PROBE_KEYS, "Production probe evidence");
  if (
    probe.schemaVersion !== 1 ||
    probe.evidenceKind !== "production-assignment-probe/v1" ||
    probe.providerProjectId !== providerPolicy.expectedProjectId ||
    probe.providerDeploymentId !== targetDeploymentId ||
    probe.providerDeploymentEvidenceHash !==
      targetBinding.providerEvidence.sha256 ||
    probe.immutableRouteProbeEvidenceHash !==
      providerEvidence.routeProbeEvidenceHash ||
    !sameCanonicalValue(
      probe.providerAssignmentObservation,
      assignmentAuthority.providerAssignmentObservation,
    ) ||
    !Array.isArray(probe.immutableApiReceipts) ||
    !Array.isArray(probe.results)
  ) {
    throw new Error("Production probe identity differs from the assignment");
  }
  assertReference(
    probe.providerAssignmentObservation,
    assignmentAuthority.namespace,
    "Production probe provider assignment observation",
  );
  const responseDates = validateProductionProbeReceipts({
    receipts: probe.immutableApiReceipts,
    expectedOrigin: targetBinding.deploymentUrl,
    expectedPaths: PRODUCTION_API_PATHS,
    providerPolicy,
    nowMilliseconds,
    requireFresh,
    label: "Immutable API probe",
  });
  const probedDomains = probe.results.map((result) => result?.productionDomain);
  if (
    !sameCanonicalValue(probedDomains, providerPolicy.ownedProductionDomains) ||
    new Set(probedDomains).size !== probedDomains.length
  ) {
    throw new Error("Production probe does not cover the owned domain set");
  }
  let expectedPaths = null;
  for (const result of probe.results) {
    assertExactKeys(
      result,
      PRODUCTION_PROBE_RESULT_KEYS,
      "Production probe result",
    );
    if (
      result.providerDeploymentId !== targetDeploymentId ||
      result.status !== "PASS" ||
      !SHA256_PATTERN.test(result.responseSha256) ||
      !Array.isArray(result.receipts) ||
      result.responseSha256 !== sha256Json(result.receipts)
    ) {
      throw new Error("Production probe result does not pass for the target");
    }
    const resultPaths = result.receipts.map((receipt) => receipt?.path);
    if (
      expectedPaths === null &&
      (!Array.isArray(resultPaths) ||
        !PRODUCTION_API_PATHS.every((path) => resultPaths.includes(path)))
    ) {
      throw new Error("Production probe omits immutable API routes");
    }
    expectedPaths ??= resultPaths;
    if (
      !sameCanonicalValue(resultPaths, expectedPaths) ||
      new Set(resultPaths).size !== resultPaths.length ||
      !sameCanonicalValue([...resultPaths].sort(compareUtf8), resultPaths)
    ) {
      throw new Error("Production probe route set is partial or non-canonical");
    }
    responseDates.push(
      ...validateProductionProbeReceipts({
        receipts: result.receipts,
        expectedOrigin: `https://${result.productionDomain}`,
        expectedPaths,
        providerPolicy,
        nowMilliseconds,
        requireFresh,
        label: `Production probe ${result.productionDomain}`,
      }),
    );
  }
  const observedAt = assertTimestamp(
    probe.observedAt,
    "Production probe observedAt",
  );
  const maximumResponseDate = Math.max(...responseDates);
  const futureLimit =
    nowMilliseconds +
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000;
  if (
    observedAt !== maximumResponseDate ||
    observedAt + 999 < completedMilliseconds ||
    observedAt > futureLimit
  ) {
    throw new Error(
      "Production probe observedAt is outside the promoted assignment window",
    );
  }
  return { validation, probe };
};

const assertPreparedResultInState = ({
  current,
  validatedPrepared,
  namespace,
}) => {
  const { result, event, operation } = validatedPrepared;
  if (
    event.namespace !== namespace ||
    current.snapshot.pendingOperation === null ||
    !sameCanonicalValue(current.snapshot.pendingOperation, operation)
  ) {
    throw new Error(
      "Prepared promotion result differs from the pending Release State operation",
    );
  }
  const records = current.records.filter(
    (record) =>
      record.sequence === event.sequence &&
      record.eventHash === result.eventHash,
  );
  if (
    records.length !== 1 ||
    !sameCanonicalValue(records[0].event, event) ||
    result.head.sequence !== event.sequence ||
    result.head.eventHash !== result.eventHash
  ) {
    throw new Error(
      "Prepared promotion result is not an exact committed state event",
    );
  }
  return records[0];
};

const putEvidenceEntries = async ({ store, namespace, entries }) => {
  const references = {};
  for (const [name, bytes, mediaType] of entries) {
    references[name] = await putImmutableEvidence({
      store,
      namespace,
      bytes,
      mediaType,
      label: name,
    });
  }
  return references;
};

const putPromotionAssignmentEvidenceSet = async ({
  store,
  namespace,
  preparedResultBytes,
  promotionReceiptBytes,
  assignmentEvidence,
  nestedEvidence,
}) =>
  putEvidenceEntries({
    store,
    namespace,
    entries: [
      [
        "preparedResult",
        preparedResultBytes,
        "application/vnd.event-shopping-planner.prepared-promotion-result+json;version=1",
      ],
      [
        "promotionReceipt",
        promotionReceiptBytes,
        "application/vnd.event-shopping-planner.prepared-promotion-receipt+json;version=1",
      ],
      [
        "assignmentReceipt",
        canonicalJsonBytes(assignmentEvidence),
        "application/vnd.event-shopping-planner.provider-assignment-receipt+json;version=1",
      ],
      [
        "beforeProvider",
        canonicalJsonBytes(nestedEvidence.beforeProvider),
        "application/vnd.event-shopping-planner.provider-observation+json;version=1",
      ],
      [
        "afterProvider",
        canonicalJsonBytes(nestedEvidence.afterProvider),
        "application/vnd.event-shopping-planner.provider-observation+json;version=1",
      ],
      [
        "beforeDomains",
        canonicalJsonBytes(nestedEvidence.before),
        "application/vnd.event-shopping-planner.domain-assignment-observation+json;version=1",
      ],
      [
        "afterDomains",
        canonicalJsonBytes(nestedEvidence.after),
        "application/vnd.event-shopping-planner.domain-assignment-observation+json;version=1",
      ],
    ],
  });

const putPromotionValidationEvidenceSet = async ({
  store,
  namespace,
  validationBytes,
  productionProbeBytes,
}) =>
  putEvidenceEntries({
    store,
    namespace,
    entries: [
      [
        "assignmentValidation",
        validationBytes,
        "application/vnd.event-shopping-planner.provider-assignment-validation+json;version=1",
      ],
      [
        "productionProbe",
        productionProbeBytes,
        "application/vnd.event-shopping-planner.production-probe+json;version=1",
      ],
    ],
  });

export const recordPreparedPromotionAssignment = async (
  options,
  {
    readState = readCurrentReleaseState,
    validatePreparedResult = validatePreparedPromotionResult,
    validateProviderObservation = assertVercelObservationEvidence,
    validateAuthority = validateProductionAssignmentAuthority,
    clock = Date.now,
  } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    store,
    preparedResultBytes,
    promotionReceiptBytes,
    assignmentAuthorityBytes,
    providerPolicy,
    environment,
  } = options;
  assertStore(store);
  parseCanonicalJsonBytes(
    assignmentAuthorityBytes,
    "Production assignment authority",
  );
  const nowMilliseconds = readClock(clock, "Promotion assignment");
  const validatedPrepared = validatePreparedResult({
    preparedResultBytes,
    providerPolicy,
    environment,
    nowMilliseconds,
  });
  let current = await readState({ store });
  const preparedRecord = assertPreparedResultInState({
    current,
    validatedPrepared,
    namespace: store.namespace,
  });
  const operation = validatedPrepared.operation;
  const promotionReceiptSha256 = sha256Bytes(promotionReceiptBytes);
  const appendId = deriveLifecycleAppendId({
    kind: "deployment-assigned",
    namespace: store.namespace,
    operationId: operation.operationId,
    evidenceSha256: promotionReceiptSha256,
  });
  const existing = findAppendRecord(current, appendId);
  const parsedReceipt = parseCanonicalJsonBytes(
    promotionReceiptBytes,
    "Prepared promotion receipt",
  );
  const receiptValidationTime =
    existing === null
      ? nowMilliseconds
      : assertTimestamp(
          parsedReceipt.completedAt,
          "Promotion replay completedAt",
        );
  const validatedReceipt = validatePromotionReceipt({
    receiptBytes: promotionReceiptBytes,
    validatedPrepared,
    providerPolicy,
    nowMilliseconds: receiptValidationTime,
    validateProviderObservation,
  });
  const authorityValidation = await validateAuthority({
    store,
    namespace: store.namespace,
    authorityBytes: assignmentAuthorityBytes,
    preparedResultBytes,
    promotionReceiptBytes,
    validatedPrepared,
    assignmentEvidence: validatedReceipt.assignmentEvidence,
    providerPolicy,
    nowMilliseconds,
    requireFresh: existing === null,
  });
  const authority = authorityValidation.authority ?? authorityValidation;
  const references = await putPromotionAssignmentEvidenceSet({
    store,
    namespace: store.namespace,
    preparedResultBytes,
    promotionReceiptBytes,
    assignmentEvidence: validatedReceipt.assignmentEvidence,
    nestedEvidence: validatedReceipt.nestedEvidence,
  });
  references.assignmentAuthority = await putImmutableEvidence({
    store,
    namespace: store.namespace,
    bytes: assignmentAuthorityBytes,
    mediaType:
      "application/vnd.event-shopping-planner.production-assignment-authority+json;version=1",
    label: "Production assignment authority",
  });
  if (
    !sameCanonicalValue(
      references.promotionReceipt,
      authority.promotionReceipt,
    ) ||
    !sameCanonicalValue(
      references.assignmentReceipt,
      authority.assignmentReceipt,
    )
  ) {
    throw new Error(
      "Stored promotion assignment references differ from authority",
    );
  }
  if (existing === null) {
    const commitNowMilliseconds = readClock(
      clock,
      "Promotion assignment commit",
    );
    const commitReceipt = validatePromotionReceipt({
      receiptBytes: promotionReceiptBytes,
      validatedPrepared,
      providerPolicy,
      nowMilliseconds: commitNowMilliseconds,
      validateProviderObservation,
    });
    if (
      !sameCanonicalValue(
        commitReceipt.assignmentEvidence,
        validatedReceipt.assignmentEvidence,
      )
    ) {
      throw new Error("Promotion assignment receipt changed before commit");
    }
    await validateAuthority({
      store,
      namespace: store.namespace,
      authorityBytes: assignmentAuthorityBytes,
      preparedResultBytes,
      promotionReceiptBytes,
      validatedPrepared,
      assignmentEvidence: commitReceipt.assignmentEvidence,
      providerPolicy,
      nowMilliseconds: commitNowMilliseconds,
      requireFresh: true,
    });
  }
  current = await readState({ store });
  assertPreparedResultInState({
    current,
    validatedPrepared,
    namespace: store.namespace,
  });
  const assignedPayload = {
    assignmentReceipt: references.assignmentReceipt,
    promotionReceipt: references.promotionReceipt,
    targetBinding: operation.targetBinding,
  };
  const assigned = await appendLifecycleEvent({
    store,
    current,
    eventType: "deployment-assigned",
    operationId: operation.operationId,
    appendId,
    payload: assignedPayload,
    evidenceRefs: sortAndDedupeReferences(
      [
        ...Object.values(references),
        authority.providerAssignmentObservation,
        eventReference(store.namespace, preparedRecord),
      ],
      store.namespace,
    ),
    readState,
  });
  return {
    schemaVersion: 1,
    resultKind: "promotion-assignment-recorded/v1",
    operationId: operation.operationId,
    targetBindingId: operation.targetBinding.bindingId,
    references,
    event: eventReference(store.namespace, assigned.record),
    replayed: assigned.replayed,
    head: assigned.current.head,
  };
};

export const recordPreparedPromotionLifecycle = async (
  options,
  {
    readState = readCurrentReleaseState,
    validatePreparedResult = validatePreparedPromotionResult,
    validateProviderObservation = assertVercelObservationEvidence,
    validateAuthority = validateProductionAssignmentAuthority,
    clock = Date.now,
  } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    store,
    preparedResultBytes,
    promotionReceiptBytes,
    assignmentAuthorityBytes,
    assignmentValidationBytes,
    productionProbeBytes,
    providerPolicy,
    environment,
  } = options;
  assertStore(store);
  const nowMilliseconds = readClock(clock, "Promotion lifecycle");
  const validatedPrepared = validatePreparedResult({
    preparedResultBytes,
    providerPolicy,
    environment,
    nowMilliseconds,
  });
  const initial = await readState({ store });
  assertPreparedResultInState({
    current: initial,
    validatedPrepared,
    namespace: store.namespace,
  });
  const assignedAppendId = deriveLifecycleAppendId({
    kind: "deployment-assigned",
    namespace: store.namespace,
    operationId: validatedPrepared.operation.operationId,
    evidenceSha256: sha256Bytes(promotionReceiptBytes),
  });
  if (findAppendRecord(initial, assignedAppendId) === null) {
    throw new Error(
      "Deployment assignment must be recorded before production validation",
    );
  }
  parseCanonicalJsonBytes(
    assignmentValidationBytes,
    "Assignment validation evidence",
  );
  parseCanonicalJsonBytes(
    assignmentAuthorityBytes,
    "Production assignment authority",
  );
  const validationSha256 = sha256Bytes(assignmentValidationBytes);
  const validationAppendId = deriveLifecycleAppendId({
    kind: "assignment-validated",
    namespace: store.namespace,
    operationId: validatedPrepared.operation.operationId,
    evidenceSha256: validationSha256,
  });
  const observationAppendId = deriveLifecycleAppendId({
    kind: "observation-started",
    namespace: store.namespace,
    operationId: validatedPrepared.operation.operationId,
    evidenceSha256: validationSha256,
  });
  const hasValidatedPrefix =
    findAppendRecord(initial, validationAppendId) !== null ||
    findAppendRecord(initial, observationAppendId) !== null;
  const parsedReceipt = parseCanonicalJsonBytes(
    promotionReceiptBytes,
    "Prepared promotion receipt",
  );
  const receiptValidationTime = assertTimestamp(
    parsedReceipt.completedAt,
    "Promotion replay completedAt",
  );
  const validatedReceipt = validatePromotionReceipt({
    receiptBytes: promotionReceiptBytes,
    validatedPrepared,
    providerPolicy,
    nowMilliseconds: receiptValidationTime,
    validateProviderObservation,
  });
  const assignmentBytes = canonicalJsonBytes(
    validatedReceipt.assignmentEvidence,
  );
  const assignmentReference = {
    uri:
      `release-state://${store.namespace}/evidence/` +
      sha256Bytes(assignmentBytes),
    sha256: sha256Bytes(assignmentBytes),
  };
  const authorityValidation = await validateAuthority({
    store,
    namespace: store.namespace,
    authorityBytes: assignmentAuthorityBytes,
    preparedResultBytes,
    promotionReceiptBytes,
    validatedPrepared,
    assignmentEvidence: validatedReceipt.assignmentEvidence,
    providerPolicy,
    nowMilliseconds,
    requireFresh: false,
  });
  const authority = authorityValidation.authority ?? authorityValidation;
  const targetBinding = validatedPrepared.operation.targetBinding;
  const providerEvidence = await validateProviderEvidenceForBinding({
    store,
    namespace: store.namespace,
    binding: targetBinding,
    label: "Promotion lifecycle target",
  });
  validateAssignmentEvidence({
    validationBytes: assignmentValidationBytes,
    productionProbeBytes,
    assignmentEvidence: validatedReceipt.assignmentEvidence,
    assignmentReference,
    assignmentAuthority: authority,
    providerPolicy,
    providerEvidence,
    targetBinding,
    completedMilliseconds: validatedReceipt.completedMilliseconds,
    nowMilliseconds,
    requireFresh: !hasValidatedPrefix,
  });
  const assignmentReferences = await putPromotionAssignmentEvidenceSet({
    store,
    namespace: store.namespace,
    preparedResultBytes,
    promotionReceiptBytes,
    assignmentEvidence: validatedReceipt.assignmentEvidence,
    nestedEvidence: validatedReceipt.nestedEvidence,
  });
  assignmentReferences.assignmentAuthority = await putImmutableEvidence({
    store,
    namespace: store.namespace,
    bytes: assignmentAuthorityBytes,
    mediaType:
      "application/vnd.event-shopping-planner.production-assignment-authority+json;version=1",
    label: "Production assignment authority",
  });
  const validationReferences = await putPromotionValidationEvidenceSet({
    store,
    namespace: store.namespace,
    validationBytes: assignmentValidationBytes,
    productionProbeBytes,
  });
  const references = {
    ...assignmentReferences,
    ...validationReferences,
  };
  if (
    !sameCanonicalValue(references.assignmentReceipt, assignmentReference) ||
    !sameCanonicalValue(
      references.promotionReceipt,
      authority.promotionReceipt,
    ) ||
    !sameCanonicalValue(
      references.assignmentReceipt,
      authority.assignmentReceipt,
    )
  ) {
    throw new Error("Stored assignment receipt reference differs");
  }
  if (!hasValidatedPrefix) {
    const commitNowMilliseconds = readClock(
      clock,
      "Promotion lifecycle commit",
    );
    validateAssignmentEvidence({
      validationBytes: assignmentValidationBytes,
      productionProbeBytes,
      assignmentEvidence: validatedReceipt.assignmentEvidence,
      assignmentReference,
      assignmentAuthority: authority,
      providerPolicy,
      providerEvidence,
      targetBinding,
      completedMilliseconds: validatedReceipt.completedMilliseconds,
      nowMilliseconds: commitNowMilliseconds,
      requireFresh: true,
    });
    await validateAuthority({
      store,
      namespace: store.namespace,
      authorityBytes: assignmentAuthorityBytes,
      preparedResultBytes,
      promotionReceiptBytes,
      validatedPrepared,
      assignmentEvidence: validatedReceipt.assignmentEvidence,
      providerPolicy,
      nowMilliseconds: commitNowMilliseconds,
      requireFresh: false,
    });
  }

  let current = await readState({ store });
  const preparedRecord = assertPreparedResultInState({
    current,
    validatedPrepared,
    namespace: store.namespace,
  });
  const operation = validatedPrepared.operation;
  const operationId = operation.operationId;
  const assignmentEvidenceRefs = sortAndDedupeReferences(
    [
      ...Object.values(assignmentReferences),
      authority.providerAssignmentObservation,
    ],
    store.namespace,
  );
  const sharedEvidence = sortAndDedupeReferences(
    [...Object.values(references), authority.providerAssignmentObservation],
    store.namespace,
  );
  const assignedPayload = {
    assignmentReceipt: references.assignmentReceipt,
    promotionReceipt: references.promotionReceipt,
    targetBinding: operation.targetBinding,
  };
  const assigned = await appendLifecycleEvent({
    store,
    current,
    eventType: "deployment-assigned",
    operationId,
    appendId: assignedAppendId,
    payload: assignedPayload,
    evidenceRefs: sortAndDedupeReferences(
      [
        ...assignmentEvidenceRefs,
        eventReference(store.namespace, preparedRecord),
      ],
      store.namespace,
    ),
    readState,
  });
  current = assigned.current;
  const validatedPayload = {
    assignmentReceipt: references.assignmentReceipt,
    assignmentValidation: references.assignmentValidation,
    productionProbe: references.productionProbe,
    targetBinding: operation.targetBinding,
  };
  const assignmentValidated = await appendLifecycleEvent({
    store,
    current,
    eventType: "assignment-validated",
    operationId,
    appendId: deriveLifecycleAppendId({
      kind: "assignment-validated",
      namespace: store.namespace,
      operationId,
      evidenceSha256: references.assignmentValidation.sha256,
    }),
    payload: validatedPayload,
    evidenceRefs: sortAndDedupeReferences(
      [...sharedEvidence, eventReference(store.namespace, assigned.record)],
      store.namespace,
    ),
    readState,
  });
  current = assignmentValidated.current;

  if (operation.kind !== "promote-standard") {
    const terminalKinds = {
      "rollback-standard": "rollback-activated",
      "activate-containment": "containment-activated",
      "redeploy-standard": "package-redeploy-activated",
      "redeploy-containment": "package-redeploy-activated",
    };
    const terminalEventType = terminalKinds[operation.kind];
    if (terminalEventType === undefined) {
      throw new Error("Prepared recovery operation kind is unsupported");
    }
    await assertArtifactArchiveAvailable({
      store,
      namespace: store.namespace,
      binding: operation.targetBinding,
      label: "Recovery terminal target",
    });
    if (operation.companionBinding !== null) {
      await assertArtifactArchiveAvailable({
        store,
        namespace: store.namespace,
        binding: operation.companionBinding,
        label: "Recovery terminal companion",
      });
    }
    const activatedAt = new Date(
      readClock(clock, "Recovery terminal commit"),
    ).toISOString();
    const recoveryDeadline = new Date(
      Date.parse(activatedAt) + SOURCE_HARDENED_RECOVERY_MILLISECONDS,
    ).toISOString();
    let terminalPayload;
    let terminalAcceptedAuthority = null;
    if (operation.kind === "rollback-standard") {
      terminalAcceptedAuthority = resolveAcceptedStandardAuthority({
        current,
        binding: operation.targetBinding,
      });
      terminalPayload = {
        binding: operation.targetBinding,
        companionBinding: operation.companionBinding,
        originAcceptedEvent: terminalAcceptedAuthority.acceptedEvent,
        originAcceptedGate: terminalAcceptedAuthority.acceptedGate,
        originAcceptedStandardFloors:
          terminalAcceptedAuthority.acceptedStandardFloors,
      };
    } else if (operation.kind === "activate-containment") {
      terminalPayload = {
        binding: operation.targetBinding,
        activatedAt,
        recoveryDeadline,
        targetStandard: current.snapshot.acceptedStandard,
      };
    } else if (operation.kind === "redeploy-containment") {
      terminalPayload = {
        releaseRole: "containment",
        binding: operation.targetBinding,
        activatedAt,
        recoveryDeadline,
        targetStandard: current.snapshot.acceptedStandard,
      };
    } else {
      terminalAcceptedAuthority = resolveAcceptedStandardAuthority({
        current,
        binding: operation.originBinding,
      });
      const inventory = current.snapshot.rollbackInventory.map((entry) =>
        sameCanonicalValue(entry.binding, operation.originBinding)
          ? {
              ...structuredClone(entry),
              binding: operation.targetBinding,
              acceptedEvent: terminalAcceptedAuthority.acceptedEvent,
              acceptedGate: terminalAcceptedAuthority.acceptedGate,
              acceptedStandardFloors:
                terminalAcceptedAuthority.acceptedStandardFloors,
            }
          : structuredClone(entry),
      );
      if (
        !inventory.some(
          (entry) =>
            entry.binding.bindingId === operation.targetBinding.bindingId,
        )
      ) {
        if (
          current.snapshot.acceptedStandard?.bindingId !==
            operation.originBinding.bindingId ||
          current.snapshot.acceptedStandardEvent === null
        ) {
          throw new Error(
            "Standard redeploy origin has no accepted inventory authority",
          );
        }
        inventory.push({
          binding: operation.targetBinding,
          acceptedEvent: terminalAcceptedAuthority.acceptedEvent,
          acceptedGate: terminalAcceptedAuthority.acceptedGate,
          acceptedStandardFloors:
            terminalAcceptedAuthority.acceptedStandardFloors,
          evaluatedPolicy: current.snapshot.activeReleasePolicy,
          eligibleActions: ["package-redeploy", "rollback"],
          eligibility: "eligible",
          reasonCodes: [],
        });
      }
      inventory.sort((left, right) =>
        compareUtf8(left.binding.bindingId, right.binding.bindingId),
      );
      terminalPayload = {
        releaseRole: "standard",
        standardBinding: operation.targetBinding,
        companionBinding: operation.companionBinding,
        rollbackInventory: inventory,
        originAcceptedEvent: terminalAcceptedAuthority.acceptedEvent,
        originAcceptedGate: terminalAcceptedAuthority.acceptedGate,
        originAcceptedStandardFloors:
          terminalAcceptedAuthority.acceptedStandardFloors,
      };
    }
    const terminal = await appendLifecycleEvent({
      store,
      current,
      eventType: terminalEventType,
      operationId,
      appendId: deriveLifecycleAppendId({
        kind: terminalEventType,
        namespace: store.namespace,
        operationId,
        evidenceSha256: references.assignmentValidation.sha256,
      }),
      payload: terminalPayload,
      evidenceRefs: sortAndDedupeReferences(
        [
          ...sharedEvidence,
          eventReference(store.namespace, assignmentValidated.record),
          ...(terminalAcceptedAuthority === null
            ? []
            : [terminalAcceptedAuthority.acceptedEvent]),
        ],
        store.namespace,
      ),
      approvalRefs: operation.approvalRefs,
      readState,
    });
    if (
      terminal.current.snapshot.pendingOperation !== null ||
      !sameCanonicalValue(
        terminal.current.snapshot.activeProduction,
        operation.targetBinding,
      )
    ) {
      throw new Error("Recovery terminal commit did not activate its target");
    }
    return {
      schemaVersion: 1,
      resultKind: "recovery-lifecycle-recorded/v1",
      operationKind: operation.kind,
      operationId,
      targetBindingId: operation.targetBinding.bindingId,
      references,
      events: {
        deploymentAssigned: eventReference(store.namespace, assigned.record),
        assignmentValidated: eventReference(
          store.namespace,
          assignmentValidated.record,
        ),
        terminal: eventReference(store.namespace, terminal.record),
      },
      replayed:
        assigned.replayed && assignmentValidated.replayed && terminal.replayed,
      head: terminal.current.head,
    };
  }

  const observationNotBefore = new Date(
    assertTimestamp(
      assignmentValidated.record.committedAt,
      "Assignment-validated commit time",
    ),
  ).toISOString();
  const minimumObservationEndsAt = new Date(
    Date.parse(observationNotBefore) + MINIMUM_OBSERVATION_MILLISECONDS,
  ).toISOString();
  const pendingAcceptance = {
    operationId,
    standardBinding: operation.targetBinding,
    companionBinding: operation.companionBinding,
    assignmentValidationEvidence: references.assignmentValidation,
    observationStartedEvent: eventReference(
      store.namespace,
      assignmentValidated.record,
    ),
    observationNotBefore,
    minimumObservationEndsAt,
  };
  const observationStarted = await appendLifecycleEvent({
    store,
    current,
    eventType: "observation-started",
    operationId,
    appendId: deriveLifecycleAppendId({
      kind: "observation-started",
      namespace: store.namespace,
      operationId,
      evidenceSha256: references.assignmentValidation.sha256,
    }),
    payload: { pendingAcceptance },
    evidenceRefs: sortAndDedupeReferences(
      [
        references.assignmentValidation,
        references.productionProbe,
        eventReference(store.namespace, assignmentValidated.record),
      ],
      store.namespace,
    ),
    readState,
  });
  if (
    !sameCanonicalValue(
      observationStarted.current.snapshot.pendingAcceptance,
      pendingAcceptance,
    ) ||
    !sameCanonicalValue(
      observationStarted.current.snapshot.activeProduction,
      operation.targetBinding,
    )
  ) {
    throw new Error(
      "Promotion lifecycle commit did not establish pending acceptance",
    );
  }
  return {
    schemaVersion: 1,
    resultKind: "promotion-lifecycle-recorded/v1",
    operationId,
    targetBindingId: operation.targetBinding.bindingId,
    references,
    events: {
      deploymentAssigned: eventReference(store.namespace, assigned.record),
      assignmentValidated: eventReference(
        store.namespace,
        assignmentValidated.record,
      ),
      observationStarted: eventReference(
        store.namespace,
        observationStarted.record,
      ),
    },
    observationNotBefore,
    minimumObservationEndsAt,
    replayed:
      assigned.replayed &&
      assignmentValidated.replayed &&
      observationStarted.replayed,
    head: observationStarted.current.head,
  };
};

const putApprovalEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) =>
  putImmutableEvidence({
    store,
    namespace,
    bytes,
    mediaType,
    label,
  });

export const collectAndStoreAcceptanceApprovals = async (
  {
    store,
    namespace,
    policy,
    operationId,
    subjectSha256,
    expectedSourceSha,
    expectedRunId,
    observedThrough,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
    nowMilliseconds = Date.now(),
  },
  {
    requestOidcToken = requestGitHubOidcToken,
    verifyOidcToken = verifyGitHubOidcTokenFromIssuer,
    fetchApprovals = fetchGitHubProtectedEnvironmentApprovals,
    resolveApproval = resolveApprovalReference,
  } = {},
) => {
  const token = await requestOidcToken({
    requestUrl: oidcRequestUrl,
    requestToken: oidcRequestToken,
    audience: policy.oidcAudience,
    fetchImpl,
  });
  const verifiedOidc = await verifyOidcToken({
    token,
    policy,
    expectedSourceSha,
    expectedRunId,
    nowMs: nowMilliseconds,
    fetchImpl,
  });
  if (
    !verifiedOidc ||
    !Buffer.isBuffer(verifiedOidc.receiptBytes) ||
    verifiedOidc.receipt?.claims?.sourceSha !== expectedSourceSha ||
    verifiedOidc.receipt?.claims?.runId !== expectedRunId
  ) {
    throw new Error("Acceptance OIDC result binding is invalid");
  }
  const issuerReceiptReference = await putApprovalEvidence({
    store,
    namespace,
    bytes: verifiedOidc.receiptBytes,
    mediaType:
      "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1",
    label: "Acceptance OIDC receipt",
  });
  const candidates = await fetchApprovals({
    policy,
    githubToken,
    operationId,
    subjectSha256,
    expectedRunId,
    fetchImpl,
  });
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("GitHub protected environment returned no approvals");
  }
  const resolved = [];
  for (const candidate of candidates) {
    if (!candidate || !Buffer.isBuffer(candidate.receiptBytes)) {
      throw new Error("Acceptance approval result is invalid");
    }
    const receiptReference = await putApprovalEvidence({
      store,
      namespace,
      bytes: candidate.receiptBytes,
      mediaType:
        "application/vnd.event-shopping-planner.github-approval-receipt+json;version=1",
      label: "Acceptance approval receipt",
    });
    const reference = resolveApproval({
      policy,
      receiptReference,
      issuerReceiptReference,
      verifiedApprovalResult: candidate,
      verifiedOidcResult: verifiedOidc,
      operationId,
      subjectSha256,
    });
    if (ACCEPTANCE_ROLES.includes(reference.role)) resolved.push(reference);
  }
  resolved.sort(
    (left, right) =>
      ACCEPTANCE_ROLES.indexOf(left.role) -
      ACCEPTANCE_ROLES.indexOf(right.role),
  );
  assertRequiredApprovalSet(resolved, ACCEPTANCE_ROLES);
  const observedThroughMilliseconds = assertTimestamp(
    observedThrough,
    "Acceptance observedThrough",
  );
  const verifiedAtMilliseconds = assertTimestamp(
    verifiedOidc.receipt.verifiedAt,
    "Acceptance OIDC verification time",
  );
  if (
    verifiedAtMilliseconds < observedThroughMilliseconds ||
    resolved.some(
      (approval) =>
        assertTimestamp(approval.approvedAt, "Acceptance approval time") <
        observedThroughMilliseconds,
    )
  ) {
    throw new Error("Acceptance approval predates terminal observation");
  }
  return {
    approvalRefs: resolved,
    issuerReceiptReference,
    oidcExpiresAt: verifiedOidc.receipt.claims.expiresAt,
    verifiedAt: verifiedOidc.receipt.verifiedAt,
  };
};

const readCanonicalEvidenceObject = async ({
  store,
  namespace,
  reference,
  label,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    reference,
    namespace,
    label,
  });
  return parseCanonicalJsonBytes(stored.bytes, label);
};

const validateAcceptanceBindingEvidence = async ({
  store,
  namespace,
  binding,
  releasePolicy,
  label,
}) => {
  await assertArtifactArchiveAvailable({
    store,
    namespace,
    binding,
    label,
  });
  const manifest = await readCanonicalEvidenceObject({
    store,
    namespace,
    reference: binding.artifactManifest,
    label: `${label} artifact manifest`,
  });
  assertArtifactManifest(manifest, releasePolicy);
  if (
    manifest.sourceSha !== binding.sourceSha ||
    manifest.buildId !== binding.buildId ||
    manifest.variantId !== binding.variantId ||
    manifest.releaseRole !== binding.releaseRole ||
    manifest.publicIdentityKind !== binding.publicIdentityKind ||
    manifest.providerConfigurationHash !== binding.providerConfigurationHash ||
    manifest.providerPolicyHash !== binding.providerPolicy.sha256 ||
    manifest.releasePolicyHash !== binding.releasePolicy.sha256 ||
    !sameCanonicalValue(
      manifest.requiredDbCompatibility,
      binding.requiredDbCompatibility,
    )
  ) {
    throw new Error(`${label} artifact manifest differs from its binding`);
  }
  const providerEvidence = await validateProviderEvidenceForBinding({
    store,
    namespace,
    binding,
    label,
  });
  assertExactKeys(
    providerEvidence.publicIdentity,
    ["identity", "identityKind", "identitySha256"],
    `${label} provider public identity`,
  );
  const identity = providerEvidence.publicIdentity.identity;
  if (
    providerEvidence.publicIdentity.identityKind !== "release-identity-v1" ||
    providerEvidence.publicIdentity.identitySha256 !== sha256Json(identity)
  ) {
    throw new Error(`${label} provider ReleaseIdentity hash differs`);
  }
  assertReleaseIdentity(identity, {
    manifest,
    outputFilesByPath: new Map(
      manifest.outputFiles.map((file) => [file.path, file]),
    ),
  });
  return { identity, manifest, providerEvidence };
};

const hasIndependentCompanion = (standard, companion) =>
  standard.bindingId !== companion.bindingId &&
  standard.variantId !== companion.variantId &&
  standard.providerDeploymentId !== companion.providerDeploymentId &&
  standard.deploymentUrl !== companion.deploymentUrl &&
  standard.artifactManifest.sha256 !== companion.artifactManifest.sha256 &&
  standard.providerEvidence.sha256 !== companion.providerEvidence.sha256;

const standardFloorsFromDimensions = (dimensions) =>
  Object.fromEntries(
    ACCEPTED_STANDARD_FLOOR_KEYS.map((key) => [key, dimensions[key]]),
  );

const releasePolicyPhaseStates = (releasePolicy) => {
  const phaseStates = [];
  let dimensions = structuredClone(releasePolicy.initialStandard);
  if (!Array.isArray(releasePolicy.phaseSequence)) {
    throw new Error("Active release policy phase sequence is invalid");
  }
  for (const phase of releasePolicy.phaseSequence) {
    if (phase?.change !== null && !isRecord(phase?.change)) {
      throw new Error("Active release policy phase change is invalid");
    }
    if (phase.change !== null) {
      dimensions = { ...dimensions, ...phase.change };
    }
    phaseStates.push({
      gate: phase.gate,
      floors: standardFloorsFromDimensions(dimensions),
    });
  }
  return phaseStates;
};

export const deriveAcceptedGateForCandidate = ({
  snapshot,
  releasePolicy,
  candidateFloors,
}) => {
  const phaseStates = releasePolicyPhaseStates(releasePolicy);
  const currentFloors = snapshot.acceptedStandardFloors;
  const hasCurrentFloors = Object.keys(currentFloors).length > 0;
  if (!hasCurrentFloors) {
    if (snapshot.acceptedStandard !== null || snapshot.acceptedGate !== null) {
      throw new Error(
        "Initial accepted standard state has contradictory gate or floors",
      );
    }
  } else {
    assertExactKeys(
      currentFloors,
      ACCEPTED_STANDARD_FLOOR_KEYS,
      "Current accepted standard floors",
    );
    if (snapshot.acceptedStandard === null || snapshot.acceptedGate === null) {
      throw new Error(
        "Accepted floors exist without an accepted gate and standard",
      );
    }
  }
  const currentIndex =
    snapshot.acceptedGate === null
      ? -1
      : phaseStates.findIndex(({ gate }) => gate === snapshot.acceptedGate);
  if (
    (snapshot.acceptedGate !== null && currentIndex < 0) ||
    (currentIndex >= 0 &&
      !sameCanonicalValue(phaseStates[currentIndex].floors, currentFloors))
  ) {
    throw new Error(
      "Current accepted gate and floors differ from policy phases",
    );
  }
  const candidate = phaseStates[currentIndex + 1];
  if (
    currentIndex < -1 ||
    candidate === undefined ||
    !sameCanonicalValue(candidate.floors, candidateFloors)
  ) {
    throw new Error(
      "Candidate standard does not advance exactly one phase gate",
    );
  }
  return candidate.gate;
};

const acceptancePerformanceRequirement = (acceptedGate) => {
  if (!Object.hasOwn(ACCEPTANCE_PERFORMANCE_REQUIREMENTS, acceptedGate)) {
    throw new Error(`Accepted gate ${acceptedGate} lacks a performance policy`);
  }
  const requirement = ACCEPTANCE_PERFORMANCE_REQUIREMENTS[acceptedGate];
  return {
    performanceEvidenceKind:
      requirement === null
        ? "none"
        : requirement === "performance-inherited-closure/v1"
          ? requirement
          : "own-gate-performance-evidence/v1",
    performanceGate:
      requirement === "performance-inherited-closure/v1"
        ? "P8-CLEAN"
        : requirement,
  };
};

const buildPendingAcceptanceRequirements = ({
  namespace,
  pendingAcceptance,
  expectedState,
  acceptedGate,
}) => ({
  schemaVersion: 1,
  requirementKind: "standard-acceptance-requirements/v1",
  namespace,
  operationId: pendingAcceptance.operationId,
  sourceSha: pendingAcceptance.standardBinding.sourceSha,
  expectedArtifactSha256:
    pendingAcceptance.standardBinding.artifactArchive.sha256,
  expectedState: structuredClone(expectedState),
  acceptedGate,
  ...acceptancePerformanceRequirement(acceptedGate),
});

const assertAcceptancePerformanceArtifact = async ({
  acceptedGate,
  bytes,
  expectedSha256,
  expectedSourceSha,
  expectedArtifactSha256 = null,
  requirements = null,
  acceptanceRunId = null,
  validatePerformanceGate,
  label,
}) => {
  const artifact = assertReviewedPerformanceArtifactForAcceptedGate({
    acceptedGate,
    bytes,
    expectedSha256,
    label,
  });
  if (artifact.value === null) return artifact;
  const requirement = acceptancePerformanceRequirement(acceptedGate);
  const artifactSourceSha =
    artifact.artifactKind === "performance-inherited-closure/v1"
      ? artifact.value.closure?.p8Source?.gitCommitSha
      : artifact.value.evidence?.source?.gitCommitSha;
  if (artifactSourceSha !== expectedSourceSha) {
    throw new Error(`${label} source differs from the pending standard`);
  }
  if (
    artifact.artifactKind === "own-gate-performance-evidence/v1" &&
    (artifact.value.evidence?.source?.artifactSha256 !==
      expectedArtifactSha256 ||
      requirements === null)
  ) {
    throw new Error(
      `${label} artifact archive differs from the pending standard`,
    );
  }
  if (artifact.artifactKind === "own-gate-performance-evidence/v1") {
    assertOwnGatePerformanceProducerReceiptAuthority({
      artifactValue: artifact.value,
      requirements,
      expectedNamespace: requirements.namespace,
      expectedSourceSha,
      acceptanceRunId,
    });
  }
  const verification = await validatePerformanceGate({
    gate: requirement.performanceGate,
    evidence:
      artifact.artifactKind === "own-gate-performance-evidence/v1"
        ? projectOwnGatePerformanceEnvelope(artifact.value)
        : artifact.value,
  });
  if (
    !isRecord(verification) ||
    !Array.isArray(verification.errors) ||
    verification.errors.length > 0
  ) {
    throw new Error(
      `${label} failed the authoritative gate verifier: ${
        Array.isArray(verification?.errors)
          ? verification.errors.join("; ")
          : "invalid verifier result"
      }`,
    );
  }
  return artifact;
};

const deriveAcceptanceReleaseState = async ({
  store,
  current,
  pendingAcceptance,
  companionRecoveryDrill,
}) => {
  const standard = pendingAcceptance.standardBinding;
  const companion = pendingAcceptance.companionBinding;
  if (
    !sameCanonicalValue(
      standard.releasePolicy,
      current.snapshot.activeReleasePolicy,
    ) ||
    !sameCanonicalValue(companion.releasePolicy, standard.releasePolicy)
  ) {
    throw new Error("Acceptance bindings do not use the active release policy");
  }
  const releasePolicy = await readCanonicalEvidenceObject({
    store,
    namespace: store.namespace,
    reference: current.snapshot.activeReleasePolicy,
    label: "Active release policy",
  });
  const standardEvidence = await validateAcceptanceBindingEvidence({
    store,
    namespace: store.namespace,
    binding: standard,
    releasePolicy,
    label: "Pending standard",
  });
  const companionEvidence = await validateAcceptanceBindingEvidence({
    store,
    namespace: store.namespace,
    binding: companion,
    releasePolicy,
    label: "Pending containment companion",
  });
  const expectedCompanionDimensions = projectContainmentDimensions(
    releasePolicy,
    standardEvidence.manifest.dimensions,
  );
  if (
    !sameCanonicalValue(
      companionEvidence.manifest.dimensions,
      expectedCompanionDimensions,
    ) ||
    standardEvidence.identity.pwaLifecycle !==
      standardEvidence.manifest.dimensions.pwaLifecycle ||
    companionEvidence.identity.pwaLifecycle !==
      companionEvidence.manifest.dimensions.pwaLifecycle
  ) {
    throw new Error(
      "Containment companion does not match the standard policy projection",
    );
  }
  if (!hasIndependentCompanion(standard, companion)) {
    throw new Error("Containment companion is not an independent deployment");
  }
  const acceptedStandardFloors = standardFloorsFromDimensions(
    standardEvidence.manifest.dimensions,
  );
  const acceptedGate = deriveAcceptedGateForCandidate({
    snapshot: current.snapshot,
    releasePolicy,
    candidateFloors: acceptedStandardFloors,
  });
  const promptCloseAll =
    standardEvidence.identity.pwaLifecycle === "prompt-close-all-v1";
  const requiresRecoveryDrill =
    promptCloseAll && current.snapshot.bootstrapRecovery !== null;
  if (
    requiresRecoveryDrill &&
    (companionRecoveryDrill === null ||
      companionEvidence.identity.pwaLifecycle !== "prompt-close-all-v1" ||
      companionEvidence.manifest.dimensions.xlsxExecution !== "disabled" ||
      companionEvidence.manifest.dimensions.listEngine !== "disabled" ||
      companionEvidence.manifest.dimensions.listDefault !== "disabled")
  ) {
    throw new Error(
      "Prompt-close-all bootstrap clearance lacks an independent recovery drill",
    );
  }
  if (!requiresRecoveryDrill && companionRecoveryDrill !== null) {
    throw new Error(
      "Companion recovery drill is forbidden when bootstrap clearance is not pending",
    );
  }
  return {
    acceptedGate,
    acceptedStandardFloors,
    ...acceptancePerformanceRequirement(acceptedGate),
    clearBootstrapRecovery: requiresRecoveryDrill,
    releasePolicy,
    evidenceRefs: sortAndDedupeReferences(
      [
        ...collectBindingEvidenceReferences(standard),
        ...collectBindingEvidenceReferences(companion),
      ],
      store.namespace,
    ),
  };
};

export const resolvePendingAcceptanceRequirements = async (
  { store },
  { readState = readCurrentReleaseState } = {},
) => {
  assertStore(store);
  const current = await readState({ store });
  const pending = current.snapshot.pendingAcceptance;
  if (
    pending === null ||
    pending.standardBinding.releaseRole !== "standard" ||
    current.snapshot.pendingOperation?.operationId !== pending.operationId ||
    !sameCanonicalValue(
      pending.standardBinding.releasePolicy,
      current.snapshot.activeReleasePolicy,
    )
  ) {
    throw new Error("No authoritative standard acceptance is pending");
  }
  const releasePolicy = await readCanonicalEvidenceObject({
    store,
    namespace: store.namespace,
    reference: current.snapshot.activeReleasePolicy,
    label: "Active release policy",
  });
  const standardEvidence = await validateAcceptanceBindingEvidence({
    store,
    namespace: store.namespace,
    binding: pending.standardBinding,
    releasePolicy,
    label: "Pending standard",
  });
  const acceptedStandardFloors = standardFloorsFromDimensions(
    standardEvidence.manifest.dimensions,
  );
  const acceptedGate = deriveAcceptedGateForCandidate({
    snapshot: current.snapshot,
    releasePolicy,
    candidateFloors: acceptedStandardFloors,
  });
  return buildPendingAcceptanceRequirements({
    namespace: store.namespace,
    pendingAcceptance: pending,
    expectedState: current.head,
    acceptedGate,
  });
};

const bindingMatchesPolicyAndDatabase = (snapshot, binding) => ({
  database:
    binding.requiredDbCompatibility.contractUri ===
      snapshot.currentDbCompatibility.contractUri &&
    binding.requiredDbCompatibility.fingerprint ===
      snapshot.currentDbCompatibility.fingerprint,
  policy:
    findBindingPolicyCompatibility({
      snapshot,
      binding,
      action: "rollback",
    }) !== null,
});

export const deriveRollbackInventory = async ({
  store,
  current,
  releasePolicy,
  minimumAcceptedGate,
  minimumAcceptedFloors,
}) => {
  const acceptedEvents = new Map();
  let replayed = null;
  for (const record of current.records) {
    replayed = reduceReleaseState(replayed, record.event);
    if (
      record.event.eventType === "release-accepted" &&
      replayed.acceptedStandard !== null
    ) {
      acceptedEvents.set(replayed.acceptedStandard.bindingId, {
        reference: eventReference(record.event.namespace, record),
        gate: record.event.payload.acceptedGate,
        floors: structuredClone(record.event.payload.acceptedStandardFloors),
      });
    }
  }
  const phaseStates = releasePolicyPhaseStates(releasePolicy);
  const minimumFloorIndex = phaseStates.findIndex(
    ({ gate, floors }) =>
      gate === minimumAcceptedGate &&
      sameCanonicalValue(floors, minimumAcceptedFloors),
  );
  if (minimumFloorIndex < 0) {
    throw new Error("Accepted rollback floor is outside the active policy");
  }
  const candidates = new Map(
    current.snapshot.rollbackInventory.map((entry) => [
      entry.binding.bindingId,
      structuredClone(entry),
    ]),
  );
  const previous = current.snapshot.acceptedStandard;
  if (previous !== null && !candidates.has(previous.bindingId)) {
    const accepted = acceptedEvents.get(previous.bindingId);
    if (accepted) {
      candidates.set(previous.bindingId, {
        binding: structuredClone(previous),
        acceptedEvent: accepted.reference,
        acceptedGate: accepted.gate,
        acceptedStandardFloors: structuredClone(accepted.floors),
        evaluatedPolicy: structuredClone(current.snapshot.activeReleasePolicy),
        eligibleActions: [],
        eligibility: "ineligible",
        reasonCodes: [],
      });
    }
  }
  const inventory = [];
  for (const entry of candidates.values()) {
    const matches = bindingMatchesPolicyAndDatabase(
      current.snapshot,
      entry.binding,
    );
    const reasons = [];
    if (!matches.database) reasons.push("db-compatibility-mismatch");
    if (!matches.policy) reasons.push("release-policy-mismatch");
    try {
      await assertArtifactArchiveAvailable({
        store,
        namespace: store.namespace,
        binding: entry.binding,
        label: `Rollback inventory binding ${entry.binding.bindingId}`,
      });
    } catch {
      reasons.push("artifact-archive-unavailable");
    }
    const accepted =
      acceptedEvents.get(entry.binding.bindingId) ??
      (() => {
        const record = current.records.find(
          (candidate) =>
            candidate.eventHash === entry.acceptedEvent?.sha256 &&
            candidate.event.eventType === "release-accepted",
        );
        return record
          ? {
              reference: structuredClone(entry.acceptedEvent),
              gate: record.event.payload.acceptedGate,
              floors: structuredClone(
                record.event.payload.acceptedStandardFloors,
              ),
            }
          : null;
      })();
    if (!accepted) {
      throw new Error("Rollback inventory accepted event is unresolved");
    }
    assertExactKeys(
      accepted.floors,
      ACCEPTED_STANDARD_FLOOR_KEYS,
      "Rollback inventory accepted floors",
    );
    const acceptedFloorIndex = phaseStates.findIndex(
      ({ gate, floors }) =>
        gate === accepted.gate && sameCanonicalValue(floors, accepted.floors),
    );
    if (acceptedFloorIndex < minimumFloorIndex) {
      reasons.push("accepted-standard-floor-regression");
    }
    assertReference(
      accepted.reference,
      current.records[0].event.namespace,
      "Rollback inventory accepted event",
    );
    const eligibleActions =
      reasons.length === 0 ? ["package-redeploy", "rollback"] : [];
    inventory.push({
      binding: structuredClone(entry.binding),
      acceptedEvent: structuredClone(accepted.reference),
      acceptedGate: accepted.gate,
      acceptedStandardFloors: structuredClone(accepted.floors),
      evaluatedPolicy: structuredClone(current.snapshot.activeReleasePolicy),
      eligibleActions,
      eligibility: eligibleActions.length > 0 ? "eligible" : "ineligible",
      reasonCodes: [...new Set(reasons)].sort(compareUtf8),
    });
  }
  return inventory.sort((left, right) =>
    compareUtf8(left.binding.bindingId, right.binding.bindingId),
  );
};

const validateAcceptanceEvidence = ({
  evidenceBytes,
  pendingAcceptance,
  approvalPolicy,
  nowMilliseconds,
  validateEvidence,
}) => {
  const evidence = parseCanonicalJsonBytes(
    evidenceBytes,
    "Release A acceptance evidence",
  );
  const errors = validateEvidence(evidence, { nowMs: nowMilliseconds });
  if (!Array.isArray(errors) || errors.length > 0) {
    throw new Error(
      `Release A acceptance evidence failed: ${
        Array.isArray(errors) ? errors.join("; ") : "invalid verifier result"
      }`,
    );
  }
  const standard = pendingAcceptance.standardBinding;
  if (
    standard.releaseRole !== "standard" ||
    evidence.release?.commitSha !== standard.sourceSha ||
    evidence.canary?.buildSha !== standard.buildId
  ) {
    throw new Error(
      "Acceptance evidence source/build differs from the pending standard",
    );
  }
  const startedAt = assertTimestamp(
    evidence.canary.startedAt,
    "Acceptance canary startedAt",
  );
  const endedAt = assertTimestamp(
    evidence.canary.endedAt,
    "Acceptance canary endedAt",
  );
  const notBefore = assertTimestamp(
    pendingAcceptance.observationNotBefore,
    "Pending observation not-before",
  );
  const minimumEnd = assertTimestamp(
    pendingAcceptance.minimumObservationEndsAt,
    "Pending observation minimum end",
  );
  if (
    startedAt < notBefore ||
    endedAt < minimumEnd ||
    endedAt - startedAt < MINIMUM_OBSERVATION_MILLISECONDS
  ) {
    throw new Error(
      "Acceptance evidence does not cover the pending 24-hour observation",
    );
  }
  const freshness =
    (approvalPolicy.oidcMaxTokenAgeSeconds +
      approvalPolicy.oidcClockSkewSeconds) *
    1000;
  if (
    nowMilliseconds - endedAt > freshness ||
    endedAt > nowMilliseconds + approvalPolicy.oidcClockSkewSeconds * 1000
  ) {
    throw new Error("Acceptance evidence is stale or future-dated");
  }
  return { evidence, observedThrough: new Date(endedAt).toISOString() };
};

const findExistingAcceptance = ({
  current,
  namespace,
  operationId,
  evidenceSha256,
}) => {
  const appendId = deriveLifecycleAppendId({
    kind: "release-accepted",
    namespace,
    operationId,
    evidenceSha256,
  });
  const record = findAppendRecord(current, appendId);
  if (!record) return null;
  if (
    record.event.eventType !== "release-accepted" ||
    record.event.operationId !== operationId ||
    record.event.payload.releaseRole !== "standard" ||
    !record.event.evidenceRefs.some(
      (reference) => reference.sha256 === evidenceSha256,
    ) ||
    hashReleaseEvent(record.event) !== record.eventHash
  ) {
    throw new Error("Existing acceptance event differs from retry input");
  }
  return { appendId, record };
};

const replayExistingAcceptance = async ({
  store,
  current,
  existing,
  evidenceBytes,
  evidence,
  evidenceSha256,
  performanceEvidenceBytes,
  performanceEvidenceReference,
  continuousProbeBytes,
  continuousProbeReference,
  companionRecoveryDrillBytes,
  companionRecoveryDrillReference,
  validatePerformanceEvidence,
  acceptanceRunId,
}) => {
  const namespace = store.namespace;
  const event = existing.record.event;
  const evidenceReference = {
    uri: `release-state://${namespace}/evidence/${evidenceSha256}`,
    sha256: evidenceSha256,
  };
  const subjectCandidates = [];
  for (const reference of event.evidenceRefs) {
    assertReference(reference, namespace, "Acceptance replay evidence");
    if (
      reference.uri ===
      `release-state://${namespace}/evidence/${reference.sha256}`
    ) {
      const stored = await assertEvidenceObjectAvailable({
        store,
        reference,
        namespace,
        label: "Acceptance replay evidence",
      });
      if (
        stored.mediaType ===
        "application/vnd.event-shopping-planner.standard-acceptance-subject+json;version=1"
      ) {
        subjectCandidates.push({
          reference,
          subject: parseCanonicalJsonBytes(
            stored.bytes,
            "Stored standard acceptance subject",
          ),
        });
      }
    } else {
      const referencedEvent = current.records.filter(
        (record) =>
          record.eventHash === reference.sha256 &&
          eventReference(namespace, record).uri === reference.uri,
      );
      if (referencedEvent.length !== 1) {
        throw new Error("Acceptance replay event evidence is unresolved");
      }
    }
  }
  if (subjectCandidates.length !== 1) {
    throw new Error("Acceptance replay subject is absent or ambiguous");
  }
  const [{ reference: subjectReference, subject }] = subjectCandidates;
  assertExactKeys(
    subject,
    ACCEPTANCE_SUBJECT_KEYS,
    "Stored standard acceptance subject",
  );
  const expectedPayload = {
    acceptedGate: subject.acceptedGate,
    releaseRole: "standard",
    observedThrough: subject.observedThrough,
    rollbackInventory: subject.rollbackInventory,
    acceptedStandardFloors: subject.acceptedStandardFloors,
    clearBootstrapRecovery: subject.clearBootstrapRecovery,
  };
  if (
    subject.schemaVersion !== 1 ||
    subject.subjectKind !== "standard-acceptance-subject/v1" ||
    subject.namespace !== namespace ||
    subject.operationId !== event.operationId ||
    subject.releaseAEvidence.uri !== evidenceReference.uri ||
    subject.releaseAEvidence.sha256 !== evidenceReference.sha256 ||
    !sameCanonicalValue(
      subject.performanceEvidence,
      performanceEvidenceReference,
    ) ||
    !sameCanonicalValue(
      subject.continuousProductionProbe,
      continuousProbeReference,
    ) ||
    !sameCanonicalValue(
      subject.companionRecoveryDrill,
      companionRecoveryDrillReference,
    ) ||
    subject.standardBinding.sourceSha !== evidence.release.commitSha ||
    subject.standardBinding.buildId !== evidence.canary.buildSha ||
    subject.standardBinding.releaseRole !== "standard" ||
    subject.companionBinding.releaseRole !== "containment" ||
    subject.expectedState.sequence !== event.sequence - 1 ||
    subject.expectedState.eventHash !== event.previousEventHash ||
    !sameCanonicalValue(event.payload, expectedPayload)
  ) {
    throw new Error("Existing acceptance subject or payload differs");
  }
  const retryRequirements = buildPendingAcceptanceRequirements({
    namespace,
    pendingAcceptance: {
      operationId: event.operationId,
      standardBinding: subject.standardBinding,
    },
    expectedState: subject.expectedState,
    acceptedGate: subject.acceptedGate,
  });
  await assertAcceptancePerformanceArtifact({
    acceptedGate: subject.acceptedGate,
    bytes: performanceEvidenceBytes,
    expectedSha256: performanceEvidenceReference?.sha256 ?? null,
    expectedSourceSha: subject.standardBinding.sourceSha,
    expectedArtifactSha256: subject.standardBinding.artifactArchive.sha256,
    requirements: retryRequirements,
    acceptanceRunId,
    validatePerformanceGate: validatePerformanceEvidence,
    label: "Acceptance retry performance evidence",
  });
  assertRequiredApprovalSet(event.approvalRefs, ACCEPTANCE_ROLES);
  for (const approval of event.approvalRefs) {
    if (
      approval.operationId !== event.operationId ||
      approval.subjectSha256 !== subjectReference.sha256
    ) {
      throw new Error("Existing acceptance approval differs from its subject");
    }
  }
  const expectedEvidenceRefs = sortAndDedupeReferences(
    [
      evidenceReference,
      ...(subject.performanceEvidence === null
        ? []
        : [subject.performanceEvidence]),
      subject.continuousProductionProbe,
      ...(subject.companionRecoveryDrill === null
        ? []
        : [subject.companionRecoveryDrill]),
      subjectReference,
      subject.assignmentValidationEvidence,
      subject.observationStartedEvent,
      {
        uri:
          `release-state://${namespace}/evidence/` +
          subject.standardBinding.requiredDbCompatibility.fingerprint,
        sha256: subject.standardBinding.requiredDbCompatibility.fingerprint,
      },
      ...collectBindingEvidenceReferences(subject.standardBinding),
      ...collectBindingEvidenceReferences(subject.companionBinding),
      ...event.approvalRefs.flatMap((approval) => [
        { uri: approval.uri, sha256: approval.sha256 },
        {
          uri: approval.issuerReceiptUri,
          sha256: approval.issuerReceiptSha256,
        },
      ]),
    ],
    namespace,
  );
  if (!sameCanonicalValue(event.evidenceRefs, expectedEvidenceRefs)) {
    throw new Error("Existing acceptance evidence chain differs");
  }
  const storedEvidence = await store.readEvidence({ sha256: evidenceSha256 });
  if (
    !storedEvidence ||
    !Buffer.isBuffer(storedEvidence.bytes) ||
    !storedEvidence.bytes.equals(evidenceBytes)
  ) {
    throw new Error("Stored acceptance evidence differs on retry");
  }
  if (performanceEvidenceReference !== null) {
    const storedPerformanceEvidence = await store.readEvidence({
      sha256: performanceEvidenceReference.sha256,
    });
    if (
      !storedPerformanceEvidence ||
      !Buffer.isBuffer(storedPerformanceEvidence.bytes) ||
      !storedPerformanceEvidence.bytes.equals(performanceEvidenceBytes)
    ) {
      throw new Error("Stored performance evidence differs on retry");
    }
  }
  const storedContinuousProbe = await store.readEvidence({
    sha256: continuousProbeReference.sha256,
  });
  if (
    !storedContinuousProbe ||
    !Buffer.isBuffer(storedContinuousProbe.bytes) ||
    !storedContinuousProbe.bytes.equals(continuousProbeBytes)
  ) {
    throw new Error("Stored continuous production probe differs on retry");
  }
  if (companionRecoveryDrillReference !== null) {
    const storedRecoveryDrill = await store.readEvidence({
      sha256: companionRecoveryDrillReference.sha256,
    });
    if (
      !storedRecoveryDrill ||
      !Buffer.isBuffer(storedRecoveryDrill.bytes) ||
      !storedRecoveryDrill.bytes.equals(companionRecoveryDrillBytes)
    ) {
      throw new Error("Stored companion recovery drill differs on retry");
    }
  }
  return {
    schemaVersion: 1,
    resultKind: "standard-release-accepted/v1",
    operationId: event.operationId,
    sourceSha: subject.standardBinding.sourceSha,
    evidence: evidenceReference,
    performanceEvidence: performanceEvidenceReference,
    continuousProductionProbe: continuousProbeReference,
    companionRecoveryDrill: companionRecoveryDrillReference,
    subject: subjectReference,
    approvals: structuredClone(event.approvalRefs),
    event: eventReference(namespace, existing.record),
    observedThrough: subject.observedThrough,
    replayed: true,
    head: current.head,
  };
};

const executePendingStandardAcceptance = async (
  options,
  {
    readState = readCurrentReleaseState,
    validateEvidence = validateReleaseAEvidence,
    validatePerformanceEvidence = verifyPerformanceGate,
    collectApprovals = collectAndStoreAcceptanceApprovals,
    clock = Date.now,
  } = {},
  mode = "accept",
) => {
  assertNoCallerAuthority(options);
  const {
    store,
    evidenceBytes,
    expectedEvidenceSha256,
    performanceEvidenceBytes = null,
    expectedPerformanceEvidenceSha256 = null,
    continuousProbeBytes,
    expectedContinuousProbeSha256,
    companionRecoveryDrillBytes = null,
    expectedCompanionRecoveryDrillSha256 = null,
    approvalPolicy,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
    dbCompatibilityContractBytes = null,
    terminalBundleBytes = null,
    expectedTerminalBundleSha256 = null,
    terminalObjectSetBytes = null,
    expectedTerminalObjectSetSha256 = null,
  } = options;
  assertStore(store);
  if (!["accept", "prepare"].includes(mode)) {
    throw new Error("Standard acceptance execution mode is invalid");
  }
  const nowMilliseconds = readClock(clock, "Standard acceptance");
  const canonicalEvidence = parseCanonicalJsonBytes(
    evidenceBytes,
    "Release A acceptance evidence",
  );
  const evidenceSha256 = sha256Bytes(evidenceBytes);
  if (
    !SHA256_PATTERN.test(expectedEvidenceSha256) ||
    expectedEvidenceSha256 !== evidenceSha256
  ) {
    throw new Error(
      "Release A acceptance evidence differs from its reviewed SHA-256",
    );
  }
  parseCanonicalJsonBytes(
    continuousProbeBytes,
    "Continuous production probe evidence",
  );
  const continuousProbeSha256 = sha256Bytes(continuousProbeBytes);
  if (
    !SHA256_PATTERN.test(expectedContinuousProbeSha256) ||
    expectedContinuousProbeSha256 !== continuousProbeSha256
  ) {
    throw new Error(
      "Continuous production probe evidence differs from its reviewed SHA-256",
    );
  }
  const hasRecoveryDrill =
    companionRecoveryDrillBytes !== null ||
    expectedCompanionRecoveryDrillSha256 !== null;
  if (
    hasRecoveryDrill &&
    (!Buffer.isBuffer(companionRecoveryDrillBytes) ||
      !SHA256_PATTERN.test(expectedCompanionRecoveryDrillSha256) ||
      sha256Bytes(companionRecoveryDrillBytes) !==
        expectedCompanionRecoveryDrillSha256)
  ) {
    throw new Error(
      "Companion recovery drill evidence differs from its reviewed SHA-256",
    );
  }
  if (hasRecoveryDrill) {
    parseCanonicalJsonBytes(
      companionRecoveryDrillBytes,
      "Companion recovery drill evidence",
    );
  }
  const terminalBundle =
    mode === "accept"
      ? loadAcceptanceFinalBundle({
          bundleBytes: terminalBundleBytes,
          expectedBundleSha256: expectedTerminalBundleSha256,
          objectSetBytes: terminalObjectSetBytes,
          expectedObjectSetSha256: expectedTerminalObjectSetSha256,
          namespace: store.namespace,
          approvalPolicy,
        })
      : null;
  const continuousProbeReference = {
    uri: `release-state://${store.namespace}/evidence/` + continuousProbeSha256,
    sha256: continuousProbeSha256,
  };
  const companionRecoveryDrillReference = hasRecoveryDrill
    ? {
        uri:
          `release-state://${store.namespace}/evidence/` +
          expectedCompanionRecoveryDrillSha256,
        sha256: expectedCompanionRecoveryDrillSha256,
      }
    : null;
  let current = await readState({ store });
  const retryOperationId = canonicalEvidence.release?.releaseId;
  if (typeof retryOperationId === "string") {
    const existing = findExistingAcceptance({
      current,
      namespace: store.namespace,
      operationId: retryOperationId,
      evidenceSha256,
    });
    if (existing) {
      const retryPerformanceArtifact =
        assertReviewedPerformanceArtifactForAcceptedGate({
          acceptedGate: existing.record.event.payload.acceptedGate,
          bytes: performanceEvidenceBytes,
          expectedSha256: expectedPerformanceEvidenceSha256,
          label: "Acceptance retry performance evidence",
        });
      const performanceEvidenceReference =
        retryPerformanceArtifact.value === null
          ? null
          : {
              uri:
                `release-state://${store.namespace}/evidence/` +
                expectedPerformanceEvidenceSha256,
              sha256: expectedPerformanceEvidenceSha256,
            };
      if (
        terminalBundle === null ||
        !sameCanonicalValue(
          terminalBundle.releaseStateEvent,
          existing.record.event,
        ) ||
        terminalBundle.bundle.sourceSha !==
          canonicalEvidence.release.commitSha ||
        !sameCanonicalValue(
          terminalBundle.bundle.performanceEvidence,
          performanceEvidenceReference,
        )
      ) {
        throw new Error(
          "Acceptance retry terminal bundle differs from the committed event",
        );
      }
      return replayExistingAcceptance({
        store,
        current,
        existing,
        evidenceBytes,
        evidence: canonicalEvidence,
        evidenceSha256,
        performanceEvidenceBytes,
        performanceEvidenceReference,
        continuousProbeBytes,
        continuousProbeReference,
        companionRecoveryDrillBytes,
        companionRecoveryDrillReference,
        validatePerformanceEvidence,
        acceptanceRunId: expectedRunId,
      });
    }
  }
  const pending = current.snapshot.pendingAcceptance;
  if (
    pending === null ||
    pending.standardBinding.releaseRole !== "standard" ||
    pending.companionBinding.releaseRole !== "containment" ||
    current.snapshot.pendingOperation?.operationId !== pending.operationId
  ) {
    throw new Error("No standard acceptance is pending");
  }
  if (canonicalEvidence.release?.releaseId !== pending.operationId) {
    throw new Error(
      "Acceptance evidence releaseId must equal the pending operation ID",
    );
  }
  const validated = validateAcceptanceEvidence({
    evidenceBytes,
    pendingAcceptance: pending,
    approvalPolicy,
    nowMilliseconds,
    validateEvidence,
  });
  if (
    !sameCanonicalValue(
      pending.standardBinding.providerPolicy,
      pending.companionBinding.providerPolicy,
    )
  ) {
    throw new Error(
      "Acceptance standard and companion provider policies differ",
    );
  }
  const activeProviderPolicy = await readCanonicalEvidenceObject({
    store,
    namespace: store.namespace,
    reference: pending.standardBinding.providerPolicy,
    label: "Acceptance provider policy",
  });
  const continuousProbe = await validateContinuousProductionProbe({
    store,
    current,
    bytes: continuousProbeBytes,
    expectedSha256: expectedContinuousProbeSha256,
    namespace: store.namespace,
    pendingAcceptance: pending,
    releaseAEvidence: validated.evidence,
    releaseAEvidenceSha256: evidenceSha256,
    providerPolicy: activeProviderPolicy,
    approvalPolicy,
    nowMilliseconds,
  });
  const companionRecoveryDrill = hasRecoveryDrill
    ? await validateCompanionRecoveryDrill({
        store,
        current,
        bytes: companionRecoveryDrillBytes,
        expectedSha256: expectedCompanionRecoveryDrillSha256,
        namespace: store.namespace,
        pendingAcceptance: pending,
        releaseAEvidence: validated.evidence,
        releaseAEvidenceSha256: evidenceSha256,
        providerPolicy: activeProviderPolicy,
        approvalPolicy,
        nowMilliseconds,
        futureClockSkewSeconds:
          activeProviderPolicy.observationPolicy.maxFutureClockSkewSeconds,
      })
    : null;
  const derivedReleaseState = await deriveAcceptanceReleaseState({
    store,
    current,
    pendingAcceptance: pending,
    companionRecoveryDrill,
  });
  const performanceRequirements = buildPendingAcceptanceRequirements({
    namespace: store.namespace,
    pendingAcceptance: pending,
    expectedState: current.head,
    acceptedGate: derivedReleaseState.acceptedGate,
  });
  const performanceArtifact = await assertAcceptancePerformanceArtifact({
    acceptedGate: derivedReleaseState.acceptedGate,
    bytes: performanceEvidenceBytes,
    expectedSha256: expectedPerformanceEvidenceSha256,
    expectedSourceSha: pending.standardBinding.sourceSha,
    expectedArtifactSha256: pending.standardBinding.artifactArchive.sha256,
    requirements: performanceRequirements,
    acceptanceRunId: expectedRunId,
    validatePerformanceGate: validatePerformanceEvidence,
    label: "Acceptance performance evidence",
  });
  const performanceEvidenceReference =
    performanceArtifact.value === null
      ? null
      : {
          uri:
            `release-state://${store.namespace}/evidence/` +
            expectedPerformanceEvidenceSha256,
          sha256: expectedPerformanceEvidenceSha256,
        };
  const evidenceReference = await putImmutableEvidence({
    store,
    namespace: store.namespace,
    bytes: evidenceBytes,
    mediaType:
      "application/vnd.event-shopping-planner.release-a-evidence+json;version=1",
    label: "Release A acceptance evidence",
  });
  const storedPerformanceEvidenceReference =
    performanceEvidenceReference === null
      ? null
      : await putImmutableEvidence({
          store,
          namespace: store.namespace,
          bytes: performanceEvidenceBytes,
          mediaType:
            "application/vnd.event-shopping-planner.performance-evidence+json;version=1",
          label: "Acceptance performance evidence",
        });
  if (
    !sameCanonicalValue(
      storedPerformanceEvidenceReference,
      performanceEvidenceReference,
    )
  ) {
    throw new Error("Performance evidence reference changed");
  }
  const storedContinuousProbeReference = await putImmutableEvidence({
    store,
    namespace: store.namespace,
    bytes: continuousProbeBytes,
    mediaType:
      "application/vnd.event-shopping-planner.continuous-production-probe+json;version=1",
    label: "Continuous production probe evidence",
  });
  if (
    !sameCanonicalValue(
      storedContinuousProbeReference,
      continuousProbeReference,
    )
  ) {
    throw new Error("Continuous production probe reference changed");
  }
  const storedCompanionRecoveryDrillReference =
    companionRecoveryDrill === null
      ? null
      : await putImmutableEvidence({
          store,
          namespace: store.namespace,
          bytes: companionRecoveryDrillBytes,
          mediaType:
            "application/vnd.event-shopping-planner.companion-recovery-drill+json;version=1",
          label: "Companion recovery drill evidence",
        });
  if (
    !sameCanonicalValue(
      storedCompanionRecoveryDrillReference,
      companionRecoveryDrillReference,
    )
  ) {
    throw new Error("Companion recovery drill reference changed");
  }
  let dbCompatibilityContractReference;
  if (mode === "prepare") {
    const dbCompatibilityContract = parseCanonicalJsonBytes(
      dbCompatibilityContractBytes,
      "DB compatibility contract",
    );
    if (
      dbCompatibilityContract.contractUri !==
        pending.standardBinding.requiredDbCompatibility.contractUri ||
      sha256Json(dbCompatibilityContract) !==
        pending.standardBinding.requiredDbCompatibility.fingerprint
    ) {
      throw new Error(
        "DB compatibility contract differs from the pending standard binding",
      );
    }
    dbCompatibilityContractReference = await putImmutableEvidence({
      store,
      namespace: store.namespace,
      bytes: dbCompatibilityContractBytes,
      mediaType:
        "application/vnd.event-shopping-planner.db-compatibility-contract+json;version=1",
      label: "DB compatibility contract",
    });
  } else {
    dbCompatibilityContractReference = structuredClone(
      terminalBundle.bundle.dbCompatibilityContract,
    );
  }
  const acceptedStandardFloors = derivedReleaseState.acceptedStandardFloors;
  const rollbackInventory = await deriveRollbackInventory({
    store,
    current,
    releasePolicy: derivedReleaseState.releasePolicy,
    minimumAcceptedGate: derivedReleaseState.acceptedGate,
    minimumAcceptedFloors: acceptedStandardFloors,
  });
  const subject = {
    schemaVersion: 1,
    subjectKind: "standard-acceptance-subject/v1",
    namespace: store.namespace,
    operationId: pending.operationId,
    expectedState: structuredClone(current.head),
    standardBinding: structuredClone(pending.standardBinding),
    companionBinding: structuredClone(pending.companionBinding),
    assignmentValidationEvidence: structuredClone(
      pending.assignmentValidationEvidence,
    ),
    observationStartedEvent: structuredClone(pending.observationStartedEvent),
    releaseAEvidence: evidenceReference,
    performanceEvidence: storedPerformanceEvidenceReference,
    continuousProductionProbe: storedContinuousProbeReference,
    companionRecoveryDrill: storedCompanionRecoveryDrillReference,
    observedThrough: validated.observedThrough,
    rollbackInventory,
    acceptedGate: derivedReleaseState.acceptedGate,
    acceptedStandardFloors,
    clearBootstrapRecovery: derivedReleaseState.clearBootstrapRecovery,
  };
  const subjectBytes = canonicalJsonBytes(subject);
  const subjectReference = await putImmutableEvidence({
    store,
    namespace: store.namespace,
    bytes: subjectBytes,
    mediaType:
      "application/vnd.event-shopping-planner.standard-acceptance-subject+json;version=1",
    label: "Standard acceptance subject",
  });
  const approvalSet =
    mode === "prepare"
      ? await collectApprovals({
          store,
          namespace: store.namespace,
          policy: approvalPolicy,
          operationId: pending.operationId,
          subjectSha256: subjectReference.sha256,
          expectedSourceSha: pending.standardBinding.sourceSha,
          expectedRunId,
          observedThrough: validated.observedThrough,
          oidcRequestUrl,
          oidcRequestToken,
          githubToken,
          fetchImpl,
          nowMilliseconds,
        })
      : {
          approvalRefs: structuredClone(terminalBundle.approvalObjects),
        };
  assertRequiredApprovalSet(approvalSet.approvalRefs, ACCEPTANCE_ROLES);
  if (
    mode === "prepare" &&
    assertTimestamp(
      approvalSet.verifiedAt,
      "Acceptance approval verification time",
    ) < Date.parse(validated.observedThrough)
  ) {
    throw new Error("Acceptance approval verification predates observation");
  }
  for (const approval of approvalSet.approvalRefs) {
    if (
      approval.operationId !== pending.operationId ||
      approval.subjectSha256 !== subjectReference.sha256 ||
      approval.protectedEnvironment !== approvalPolicy.protectedEnvironment ||
      approval.trustedIssuer !== approvalPolicy.trustedIssuer
    ) {
      throw new Error("Acceptance approval differs from the derived subject");
    }
  }

  current = await readState({ store });
  if (
    !sameCanonicalValue(current.snapshot.pendingAcceptance, pending) ||
    current.head.sequence !== subject.expectedState.sequence ||
    current.head.eventHash !== subject.expectedState.eventHash
  ) {
    throw new Error("Release State changed during acceptance approval");
  }
  const commitNowMilliseconds = readClock(clock, "Standard acceptance commit");
  const commitValidation = validateAcceptanceEvidence({
    evidenceBytes,
    pendingAcceptance: pending,
    approvalPolicy,
    nowMilliseconds: commitNowMilliseconds,
    validateEvidence,
  });
  if (commitValidation.observedThrough !== validated.observedThrough) {
    throw new Error("Acceptance evidence changed before commit");
  }
  const commitDerivedReleaseState = await deriveAcceptanceReleaseState({
    store,
    current,
    pendingAcceptance: pending,
    companionRecoveryDrill,
  });
  if (!sameCanonicalValue(commitDerivedReleaseState, derivedReleaseState)) {
    throw new Error(
      "Acceptance binding or artifact archive changed before commit",
    );
  }
  await assertAcceptancePerformanceArtifact({
    acceptedGate: derivedReleaseState.acceptedGate,
    bytes: performanceEvidenceBytes,
    expectedSha256: expectedPerformanceEvidenceSha256,
    expectedSourceSha: pending.standardBinding.sourceSha,
    expectedArtifactSha256: pending.standardBinding.artifactArchive.sha256,
    requirements: performanceRequirements,
    acceptanceRunId: expectedRunId,
    validatePerformanceGate: validatePerformanceEvidence,
    label: "Acceptance performance evidence at commit",
  });
  const commitContinuousProbe = await validateContinuousProductionProbe({
    store,
    current,
    bytes: continuousProbeBytes,
    expectedSha256: expectedContinuousProbeSha256,
    namespace: store.namespace,
    pendingAcceptance: pending,
    releaseAEvidence: commitValidation.evidence,
    releaseAEvidenceSha256: evidenceSha256,
    providerPolicy: activeProviderPolicy,
    approvalPolicy,
    nowMilliseconds: commitNowMilliseconds,
  });
  if (!sameCanonicalValue(commitContinuousProbe, continuousProbe)) {
    throw new Error("Continuous production probe changed before commit");
  }
  if (companionRecoveryDrill !== null) {
    const commitRecoveryDrill = await validateCompanionRecoveryDrill({
      store,
      current,
      bytes: companionRecoveryDrillBytes,
      expectedSha256: expectedCompanionRecoveryDrillSha256,
      namespace: store.namespace,
      pendingAcceptance: pending,
      releaseAEvidence: commitValidation.evidence,
      releaseAEvidenceSha256: evidenceSha256,
      providerPolicy: activeProviderPolicy,
      approvalPolicy,
      nowMilliseconds: commitNowMilliseconds,
      futureClockSkewSeconds:
        activeProviderPolicy.observationPolicy.maxFutureClockSkewSeconds,
    });
    if (!sameCanonicalValue(commitRecoveryDrill, companionRecoveryDrill)) {
      throw new Error("Companion recovery drill changed before commit");
    }
  }
  if (mode === "prepare") {
    const oidcExpiresAt = assertTimestamp(
      approvalSet.oidcExpiresAt,
      "Acceptance OIDC expiration",
    );
    if (
      commitNowMilliseconds >
      oidcExpiresAt + approvalPolicy.oidcClockSkewSeconds * 1000
    ) {
      throw new Error("Acceptance OIDC authority expired before commit");
    }
  }
  const payload = {
    acceptedGate: derivedReleaseState.acceptedGate,
    releaseRole: "standard",
    observedThrough: validated.observedThrough,
    rollbackInventory,
    acceptedStandardFloors,
    clearBootstrapRecovery: derivedReleaseState.clearBootstrapRecovery,
  };
  const approvalEvidence = approvalSet.approvalRefs.flatMap(
    ({ uri, sha256, issuerReceiptUri, issuerReceiptSha256 }) => [
      { uri, sha256 },
      { uri: issuerReceiptUri, sha256: issuerReceiptSha256 },
    ],
  );
  const evidenceRefs = sortAndDedupeReferences(
    [
      evidenceReference,
      ...(storedPerformanceEvidenceReference === null
        ? []
        : [storedPerformanceEvidenceReference]),
      storedContinuousProbeReference,
      ...(storedCompanionRecoveryDrillReference === null
        ? []
        : [storedCompanionRecoveryDrillReference]),
      subjectReference,
      pending.assignmentValidationEvidence,
      pending.observationStartedEvent,
      dbCompatibilityContractReference,
      ...derivedReleaseState.evidenceRefs,
      ...approvalEvidence,
    ],
    store.namespace,
  );
  const appendId = deriveLifecycleAppendId({
    kind: "release-accepted",
    namespace: store.namespace,
    operationId: pending.operationId,
    evidenceSha256,
  });
  const candidateEvent = createReleaseEvent({
    namespace: store.namespace,
    sequence: current.snapshot.sequence + 1,
    eventType: "release-accepted",
    operationId: pending.operationId,
    appendId,
    previousEventHash: current.snapshot.eventHash,
    payload,
    evidenceRefs,
    approvalRefs: approvalSet.approvalRefs,
  });
  reduceReleaseState(current.snapshot, candidateEvent);
  if (mode === "prepare") {
    const approvalObjectReferences = [];
    for (const approval of approvalSet.approvalRefs) {
      approvalObjectReferences.push(
        await putImmutableEvidence({
          store,
          namespace: store.namespace,
          bytes: canonicalJsonBytes(approval),
          mediaType:
            "application/vnd.event-shopping-planner.release-approval-reference+json;version=1",
          label: "Acceptance approval reference",
        }),
      );
    }
    const candidateEventEvidenceReference = await putImmutableEvidence({
      store,
      namespace: store.namespace,
      bytes: canonicalJsonBytes(candidateEvent),
      mediaType:
        "application/vnd.event-shopping-planner.release-state-event+json;version=1",
      label: "Acceptance candidate Release State event",
    });
    const candidateEventReference = {
      uri:
        `release-state://${store.namespace}/events/${candidateEvent.sequence}/` +
        candidateEventEvidenceReference.sha256,
      sha256: candidateEventEvidenceReference.sha256,
    };
    const assignmentValidation = await readCanonicalEvidenceObject({
      store,
      namespace: store.namespace,
      reference: pending.assignmentValidationEvidence,
      label: "Acceptance assignment validation",
    });
    const assignmentReceiptReference = {
      uri: assignmentValidation.assignmentReceiptUri,
      sha256: assignmentValidation.assignmentReceiptSha256,
    };
    assertReference(
      assignmentReceiptReference,
      store.namespace,
      "Acceptance assignment receipt",
    );
    const bundle = {
      schemaVersion: 1,
      kind: "release-evidence-bundle/v1",
      stage: "acceptance-final",
      sourceSha: pending.standardBinding.sourceSha,
      releaseRole: "standard",
      v1Evidence: evidenceReference,
      performanceEvidence: storedPerformanceEvidenceReference,
      packageIndex: structuredClone(pending.standardBinding.packageIndex),
      artifactManifest: structuredClone(
        pending.standardBinding.artifactManifest,
      ),
      providerDeploymentEvidence: structuredClone(
        pending.standardBinding.providerEvidence,
      ),
      providerAssignmentEvidence: structuredClone(
        pending.assignmentValidationEvidence,
      ),
      dbCompatibilityContract: dbCompatibilityContractReference,
      releasePolicy: structuredClone(pending.standardBinding.releasePolicy),
      providerPolicy: structuredClone(pending.standardBinding.providerPolicy),
      releaseStateEvent: candidateEventReference,
      approvals: approvalObjectReferences,
    };
    const bundleBytes = canonicalJsonBytes(bundle);
    const objectSet = await buildReleaseEvidenceObjectSet({
      store,
      references: [
        bundle.v1Evidence,
        ...(bundle.performanceEvidence === null
          ? []
          : [bundle.performanceEvidence]),
        bundle.packageIndex,
        bundle.artifactManifest,
        bundle.providerDeploymentEvidence,
        bundle.providerAssignmentEvidence,
        bundle.dbCompatibilityContract,
        bundle.releasePolicy,
        bundle.providerPolicy,
        bundle.releaseStateEvent,
        ...bundle.approvals,
        ...candidateEvent.evidenceRefs,
        assignmentReceiptReference,
      ],
    });
    return {
      schemaVersion: 1,
      resultKind: "standard-acceptance-terminal-bundle-prepared/v1",
      operationId: pending.operationId,
      sourceSha: pending.standardBinding.sourceSha,
      bundle,
      bundleBytes,
      bundleSha256: sha256Bytes(bundleBytes),
      objectSet: objectSet.objectSet,
      objectSetBytes: objectSet.objectSetBytes,
      objectSetSha256: objectSet.objectSetSha256,
      subject: subjectReference,
      approvals: approvalSet.approvalRefs,
      proposedEvent: candidateEventReference,
      observedThrough: validated.observedThrough,
      head: current.head,
    };
  }
  assertAcceptanceFinalBundleBinding({
    loaded: terminalBundle,
    expectedEvent: candidateEvent,
    expectedSubject: subject,
    subjectReference,
    evidenceReference,
    performanceEvidenceReference: storedPerformanceEvidenceReference,
    continuousProbeReference: storedContinuousProbeReference,
    companionRecoveryDrillReference: storedCompanionRecoveryDrillReference,
    standardBinding: pending.standardBinding,
    assignmentValidationEvidence: pending.assignmentValidationEvidence,
  });
  const accepted = await appendLifecycleEvent({
    store,
    current,
    eventType: "release-accepted",
    operationId: pending.operationId,
    appendId,
    payload,
    evidenceRefs,
    approvalRefs: approvalSet.approvalRefs,
    readState,
  });
  if (
    accepted.current.snapshot.pendingOperation !== null ||
    accepted.current.snapshot.pendingAcceptance !== null ||
    !sameCanonicalValue(
      accepted.current.snapshot.acceptedStandard,
      pending.standardBinding,
    ) ||
    !sameCanonicalValue(
      accepted.current.snapshot.containmentCompanion,
      pending.companionBinding,
    )
  ) {
    throw new Error("Accepted release terminal state is inconsistent");
  }
  return {
    schemaVersion: 1,
    resultKind: "standard-release-accepted/v1",
    operationId: pending.operationId,
    sourceSha: pending.standardBinding.sourceSha,
    evidence: evidenceReference,
    continuousProductionProbe: storedContinuousProbeReference,
    companionRecoveryDrill: storedCompanionRecoveryDrillReference,
    subject: subjectReference,
    approvals: approvalSet.approvalRefs,
    event: eventReference(store.namespace, accepted.record),
    observedThrough: validated.observedThrough,
    replayed: accepted.replayed,
    head: accepted.current.head,
  };
};

export const preparePendingStandardAcceptanceBundle = (options, dependencies) =>
  executePendingStandardAcceptance(options, dependencies, "prepare");

export const acceptPendingStandardRelease = (options, dependencies) =>
  executePendingStandardAcceptance(options, dependencies, "accept");
