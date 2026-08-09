import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  collectAndStorePrePromotionApprovals,
  derivePromotionAppendId,
} from "../release-state/promotionPreparation.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "../release-state/releaseStateReducer.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  collectBindingEvidenceReferences,
  sameCanonicalValue,
  sortAndDedupeReferences,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  ARCHIVE_RECOVERY_ACTIONS,
  selectRecoveryBinding,
} from "./archiveRecovery.mjs";

export const ARCHIVE_RECOVERY_SUBJECT_KIND = "artifact-recovery-subject/v1";

const SUBJECT_KEYS = [
  "companionBinding",
  "emergencyRecoveryBinding",
  "evidenceRefs",
  "expectedState",
  "namespace",
  "operationId",
  "operationKind",
  "originBinding",
  "originCompanionBinding",
  "previousBinding",
  "recoveryAction",
  "schemaVersion",
  "subjectKind",
  "targetBinding",
];

const ACTION_OPERATION_KINDS = Object.freeze({
  rollback: "rollback-standard",
  "activate-containment": "activate-containment",
  "redeploy-standard": "redeploy-standard",
  "redeploy-containment": "redeploy-containment",
});

const requiredApprovalRoles = ["releaseOwner", "dataSafetyReviewer"];

const expectedEmergencyRecovery = (snapshot) =>
  snapshot.activeProduction?.releaseRole === "containment"
    ? snapshot.activeProduction
    : (snapshot.containmentCompanion ?? snapshot.bootstrapRecovery);

const isExactPair = (standard, companion) =>
  standard?.releaseRole === "standard" &&
  companion?.releaseRole === "containment" &&
  standard.sourceSha === companion.sourceSha &&
  standard.providerProjectId === companion.providerProjectId &&
  standard.providerConfigurationHash === companion.providerConfigurationHash &&
  sameCanonicalValue(standard.providerPolicy, companion.providerPolicy) &&
  sameCanonicalValue(standard.releasePolicy, companion.releasePolicy) &&
  sameCanonicalValue(
    standard.requiredDbCompatibility,
    companion.requiredDbCompatibility,
  );

const isExactPackageRedeploy = (origin, target) =>
  origin?.providerDeploymentId !== target?.providerDeploymentId &&
  origin?.sourceSha === target?.sourceSha &&
  origin?.buildId === target?.buildId &&
  origin?.variantId === target?.variantId &&
  origin?.releaseRole === target?.releaseRole &&
  origin?.publicIdentityKind === target?.publicIdentityKind &&
  origin?.providerProjectId === target?.providerProjectId &&
  origin?.providerConfigurationHash === target?.providerConfigurationHash &&
  sameCanonicalValue(origin?.artifactArchive, target?.artifactArchive) &&
  sameCanonicalValue(origin?.packageIndex, target?.packageIndex) &&
  sameCanonicalValue(origin?.artifactManifest, target?.artifactManifest) &&
  sameCanonicalValue(origin?.releasePolicy, target?.releasePolicy) &&
  sameCanonicalValue(origin?.providerPolicy, target?.providerPolicy) &&
  sameCanonicalValue(
    origin?.requiredDbCompatibility,
    target?.requiredDbCompatibility,
  );

const eventReference = (namespace, record) => ({
  uri:
    `release-state://${namespace}/events/${record.sequence}/` +
    record.eventHash,
  sha256: record.eventHash,
});

const matchingAcceptedEvent = ({ current, standard, namespace }) => {
  const acceptedReferences = [
    current.snapshot.acceptedStandard?.bindingId === standard.bindingId
      ? current.snapshot.acceptedStandardEvent
      : null,
    ...current.snapshot.rollbackInventory
      .filter((entry) => entry.binding.bindingId === standard.bindingId)
      .map((entry) => entry.acceptedEvent),
  ].filter(Boolean);
  const matches = current.records.filter((record) =>
    acceptedReferences.some((reference) =>
      sameCanonicalValue(reference, eventReference(namespace, record)),
    ),
  );
  if (matches.length > 1) {
    throw new Error("Artifact recovery accepted standard event is ambiguous");
  }
  return matches[0] ?? null;
};

export const resolveRecoveryCompanion = ({ current, standard, namespace }) => {
  assertDeploymentBinding(standard, {
    namespace,
    expectedRole: "standard",
    label: "Artifact recovery standard",
  });
  const candidates = [];
  if (
    current.snapshot.acceptedStandard?.bindingId === standard.bindingId &&
    isExactPair(standard, current.snapshot.containmentCompanion)
  ) {
    candidates.push(current.snapshot.containmentCompanion);
  }
  const acceptedEvent = matchingAcceptedEvent({ current, standard, namespace });
  if (acceptedEvent !== null) {
    for (const record of current.records) {
      const pending = record.event.payload?.pendingAcceptance;
      if (
        record.event.eventType === "observation-started" &&
        record.event.operationId === acceptedEvent.event.operationId &&
        sameCanonicalValue(pending?.standardBinding, standard) &&
        isExactPair(standard, pending?.companionBinding)
      ) {
        candidates.push(pending.companionBinding);
      }
    }
  }
  for (const record of current.records) {
    const payload = record.event.payload;
    if (
      record.event.eventType === "package-redeploy-activated" &&
      payload?.releaseRole === "standard" &&
      sameCanonicalValue(payload.standardBinding, standard) &&
      isExactPair(standard, payload.companionBinding)
    ) {
      candidates.push(payload.companionBinding);
    }
    if (
      record.event.eventType === "rollback-activated" &&
      sameCanonicalValue(payload?.binding, standard) &&
      isExactPair(standard, payload.companionBinding)
    ) {
      candidates.push(payload.companionBinding);
    }
  }
  const unique = [
    ...new Map(
      candidates.map((binding) => [binding.bindingId, binding]),
    ).values(),
  ];
  if (unique.length !== 1) {
    throw new Error(
      "Artifact recovery containment companion is absent or ambiguous",
    );
  }
  return unique[0];
};

export const resolveRecoveryPackageBindings = ({
  current,
  archivedBinding,
  namespace,
}) => {
  if (archivedBinding.releaseRole === "standard") {
    return [
      archivedBinding,
      resolveRecoveryCompanion({
        current,
        standard: archivedBinding,
        namespace,
      }),
    ];
  }
  assertDeploymentBinding(archivedBinding, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Artifact recovery containment archive",
  });
  if (archivedBinding.publicIdentityKind === "legacy-bootstrap-v1") {
    return [archivedBinding];
  }
  const pairs = [];
  const addPair = (standard, companion) => {
    if (
      sameCanonicalValue(companion, archivedBinding) &&
      isExactPair(standard, companion)
    ) {
      pairs.push(standard);
    }
  };
  addPair(
    current.snapshot.acceptedStandard,
    current.snapshot.containmentCompanion,
  );
  for (const record of current.records) {
    const payload = record.event.payload ?? {};
    const pendingAcceptance = payload.pendingAcceptance;
    addPair(
      pendingAcceptance?.standardBinding,
      pendingAcceptance?.companionBinding,
    );
    const pendingOperation = payload.pendingOperation;
    addPair(
      pendingOperation?.targetBinding,
      pendingOperation?.companionBinding,
    );
    addPair(
      pendingOperation?.originBinding,
      pendingOperation?.originCompanionBinding,
    );
    addPair(payload.standardBinding, payload.companionBinding);
    addPair(payload.targetStandard, payload.binding);
  }
  const standards = [
    ...new Map(
      pairs.map((standard) => [standard.bindingId, standard]),
    ).values(),
  ];
  if (standards.length !== 1) {
    throw new Error(
      "Artifact recovery standard package peer is absent or ambiguous",
    );
  }
  return [standards[0], archivedBinding];
};

const assertCurrentPolicyBinding = (snapshot, binding, label) => {
  if (
    !sameCanonicalValue(
      binding.requiredDbCompatibility,
      snapshot.currentDbCompatibility,
    ) ||
    !sameCanonicalValue(binding.releasePolicy, snapshot.activeReleasePolicy)
  ) {
    throw new Error(`${label} differs from current policy or DB compatibility`);
  }
};

export const validateArchiveRecoverySubject = ({ subject, snapshot }) => {
  assertExactKeys(subject, SUBJECT_KEYS, "Artifact recovery subject");
  if (
    subject.schemaVersion !== 1 ||
    subject.subjectKind !== ARCHIVE_RECOVERY_SUBJECT_KIND ||
    !ARCHIVE_RECOVERY_ACTIONS.includes(subject.recoveryAction) ||
    subject.operationKind !== ACTION_OPERATION_KINDS[subject.recoveryAction] ||
    !NAMESPACE_PATTERN.test(subject.namespace) ||
    !OPERATION_ID_PATTERN.test(subject.operationId)
  ) {
    throw new Error("Artifact recovery subject identity is invalid");
  }
  if (snapshot.pendingOperation !== null) {
    throw new Error("A Release State operation is already pending");
  }
  assertExactKeys(
    subject.expectedState,
    ["eventHash", "sequence"],
    "Artifact recovery expected state",
  );
  if (
    subject.expectedState.sequence !== snapshot.sequence ||
    subject.expectedState.eventHash !== snapshot.eventHash ||
    !Number.isSafeInteger(subject.expectedState.sequence) ||
    !SHA256_PATTERN.test(subject.expectedState.eventHash)
  ) {
    throw new Error("Artifact recovery subject does not bind the current head");
  }
  if (
    !sameCanonicalValue(subject.previousBinding, snapshot.activeProduction) ||
    !sameCanonicalValue(
      subject.emergencyRecoveryBinding,
      expectedEmergencyRecovery(snapshot),
    )
  ) {
    throw new Error(
      "Artifact recovery subject was not derived from current state",
    );
  }
  if (
    subject.previousBinding?.providerDeploymentId ===
    subject.targetBinding?.providerDeploymentId
  ) {
    throw new Error("Artifact recovery target is already active production");
  }
  assertDeploymentBinding(subject.targetBinding, {
    namespace: subject.namespace,
    expectedRole: subject.operationKind.includes("containment")
      ? "containment"
      : "standard",
    label: "Artifact recovery target",
  });
  assertCurrentPolicyBinding(
    snapshot,
    subject.targetBinding,
    "Recovery target",
  );
  if (subject.companionBinding !== null) {
    assertDeploymentBinding(subject.companionBinding, {
      namespace: subject.namespace,
      expectedRole: "containment",
      label: "Artifact recovery companion",
    });
    assertCurrentPolicyBinding(
      snapshot,
      subject.companionBinding,
      "Recovery companion",
    );
    if (!isExactPair(subject.targetBinding, subject.companionBinding)) {
      throw new Error("Artifact recovery target pair differs");
    }
  }
  if (subject.emergencyRecoveryBinding === null) {
    throw new Error("Artifact recovery emergency binding is absent");
  }
  assertDeploymentBinding(subject.emergencyRecoveryBinding, {
    namespace: subject.namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Artifact recovery emergency binding",
  });
  for (const [label, binding] of [
    ["origin", subject.originBinding],
    ["origin companion", subject.originCompanionBinding],
  ]) {
    if (binding !== null) {
      assertDeploymentBinding(binding, {
        namespace: subject.namespace,
        allowLegacyBootstrap: true,
        label: `Artifact recovery ${label}`,
      });
      assertCurrentPolicyBinding(snapshot, binding, `Recovery ${label}`);
    }
  }
  const shapes = {
    "rollback-standard":
      subject.targetBinding.releaseRole === "standard" &&
      subject.companionBinding !== null &&
      subject.originBinding === null &&
      subject.originCompanionBinding === null,
    "activate-containment":
      subject.targetBinding.releaseRole === "containment" &&
      subject.companionBinding === null &&
      subject.originBinding === null &&
      subject.originCompanionBinding === null,
    "redeploy-standard":
      subject.targetBinding.releaseRole === "standard" &&
      subject.companionBinding !== null &&
      subject.originBinding?.releaseRole === "standard" &&
      subject.originCompanionBinding?.releaseRole === "containment" &&
      isExactPair(subject.originBinding, subject.originCompanionBinding),
    "redeploy-containment":
      subject.targetBinding.releaseRole === "containment" &&
      subject.companionBinding === null &&
      subject.originBinding?.releaseRole === "containment" &&
      subject.originCompanionBinding === null,
  };
  if (shapes[subject.operationKind] !== true) {
    throw new Error("Artifact recovery operation binding shape is invalid");
  }
  if (
    subject.operationKind.startsWith("redeploy-") &&
    !isExactPackageRedeploy(subject.originBinding, subject.targetBinding)
  ) {
    throw new Error("Artifact recovery redeploy changed immutable identity");
  }
  if (
    subject.operationKind === "redeploy-standard" &&
    !isExactPackageRedeploy(
      subject.originCompanionBinding,
      subject.companionBinding,
    )
  ) {
    throw new Error(
      "Artifact recovery companion redeploy changed immutable identity",
    );
  }
  if (
    !Array.isArray(subject.evidenceRefs) ||
    subject.evidenceRefs.length === 0 ||
    !sameCanonicalValue(
      subject.evidenceRefs,
      sortAndDedupeReferences(subject.evidenceRefs, subject.namespace),
    )
  ) {
    throw new Error("Artifact recovery evidence references are invalid");
  }
  return subject;
};

const subjectBindings = (subject) =>
  [
    subject.targetBinding,
    subject.companionBinding,
    subject.originBinding,
    subject.originCompanionBinding,
    subject.emergencyRecoveryBinding,
  ].filter(Boolean);

const validateSubjectEvidence = async ({ store, subject }) => {
  const bindings = subjectBindings(subject);
  for (const binding of bindings) {
    await validateProviderEvidenceForBinding({
      store,
      namespace: subject.namespace,
      binding,
      label: "Artifact recovery binding",
    });
    await assertArtifactArchiveAvailable({
      store,
      namespace: subject.namespace,
      binding,
      label: "Artifact recovery binding",
    });
  }
  const references = sortAndDedupeReferences(
    [
      ...subject.evidenceRefs,
      ...bindings.flatMap(collectBindingEvidenceReferences),
    ],
    subject.namespace,
  );
  for (const reference of references) {
    await assertEvidenceObjectAvailable({
      store,
      namespace: subject.namespace,
      reference,
      label: "Artifact recovery evidence",
    });
  }
  return references;
};

const putEvidence = async ({ store, namespace, bytes, mediaType, label }) => {
  const expectedSha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.sha256 !== expectedSha256 ||
    receipt.uri !== `release-state://${namespace}/evidence/${expectedSha256}` ||
    receipt.byteLength !== bytes.length
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

export const buildArchiveRecoverySubject = ({
  current,
  namespace,
  operationId,
  action,
  bindingId,
  expectedArchivedSourceSha,
  targetBinding = null,
  companionBinding = null,
  evidenceRefs = [],
}) => {
  if (
    current.records[0]?.event?.namespace !== undefined &&
    current.records[0].event.namespace !== namespace
  ) {
    throw new Error("Artifact recovery state namespace differs");
  }
  const archived = selectRecoveryBinding({
    snapshot: current.snapshot,
    action,
    bindingId,
  });
  if (archived.sourceSha !== expectedArchivedSourceSha) {
    throw new Error("Artifact recovery archive source differs");
  }
  const archivedCompanion =
    archived.releaseRole === "standard"
      ? resolveRecoveryCompanion({ current, standard: archived, namespace })
      : null;
  const redeploy = action.startsWith("redeploy-");
  const selectedTarget = redeploy ? targetBinding : archived;
  const selectedCompanion =
    action === "rollback"
      ? archivedCompanion
      : action === "redeploy-standard"
        ? companionBinding
        : null;
  const origins = redeploy
    ? { originBinding: archived, originCompanionBinding: archivedCompanion }
    : { originBinding: null, originCompanionBinding: null };
  const bindings = [
    selectedTarget,
    selectedCompanion,
    origins.originBinding,
    origins.originCompanionBinding,
    expectedEmergencyRecovery(current.snapshot),
  ].filter(Boolean);
  const subject = {
    schemaVersion: 1,
    subjectKind: ARCHIVE_RECOVERY_SUBJECT_KIND,
    namespace,
    operationId,
    recoveryAction: action,
    operationKind: ACTION_OPERATION_KINDS[action],
    expectedState: {
      sequence: current.head.sequence,
      eventHash: current.head.eventHash,
    },
    targetBinding: selectedTarget,
    ...origins,
    companionBinding: selectedCompanion,
    previousBinding: current.snapshot.activeProduction,
    emergencyRecoveryBinding: expectedEmergencyRecovery(current.snapshot),
    evidenceRefs: sortAndDedupeReferences(
      [...evidenceRefs, ...bindings.flatMap(collectBindingEvidenceReferences)],
      namespace,
    ),
  };
  validateArchiveRecoverySubject({ subject, snapshot: current.snapshot });
  const subjectBytes = canonicalJsonBytes(subject);
  return {
    subject,
    subjectBytes,
    subjectSha256: sha256Bytes(subjectBytes),
  };
};

export const prepareArchiveRecovery = async (
  options,
  {
    readState = readCurrentReleaseState,
    collectApprovals = collectAndStorePrePromotionApprovals,
    validateEvidence = validateSubjectEvidence,
  } = {},
) => {
  const {
    store,
    subjectBytes,
    expectedSubjectSha256,
    approvalPolicy,
    expectedExecutorSourceSha,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
    nowMs = Date.now(),
  } = options;
  const bytes = Buffer.isBuffer(subjectBytes)
    ? subjectBytes
    : Buffer.from(subjectBytes ?? "");
  const subject = JSON.parse(bytes.toString("utf8"));
  const canonical = canonicalJsonBytes(subject);
  const subjectSha256 = sha256Bytes(bytes);
  if (
    !bytes.equals(canonical) ||
    !SHA256_PATTERN.test(expectedSubjectSha256) ||
    expectedSubjectSha256 !== subjectSha256
  ) {
    throw new Error("Artifact recovery subject bytes or reviewed hash differ");
  }
  if (store?.namespace !== subject.namespace) {
    throw new Error(
      "Artifact recovery subject namespace differs from its store",
    );
  }
  const current = await readState({ store, requireInitialized: true });
  validateArchiveRecoverySubject({ subject, snapshot: current.snapshot });
  const subjectReference = {
    uri: `release-state://${subject.namespace}/evidence/${subjectSha256}`,
    sha256: subjectSha256,
  };
  const appendId = derivePromotionAppendId({
    namespace: subject.namespace,
    operationId: subject.operationId,
    subjectSha256,
  });
  const existing = current.records.find(
    (record) =>
      record.event.appendId === appendId &&
      record.event.eventType === "promotion-prepared",
  );
  if (existing) {
    const stored = await assertEvidenceObjectAvailable({
      store,
      namespace: subject.namespace,
      reference: subjectReference,
      label: "Artifact recovery subject",
    });
    if (!stored.bytes.equals(bytes)) {
      throw new Error("Stored artifact recovery subject differs from retry");
    }
    return {
      replayed: true,
      subjectSha256,
      subjectReference,
      approvalRefs: existing.event.approvalRefs,
      event: existing.event,
      eventHash: existing.eventHash,
      eventUri: eventReference(subject.namespace, existing).uri,
      committedAt: existing.committedAt,
      head: current.head,
    };
  }
  const bindingEvidence = await validateEvidence({ store, subject });
  const storedSubject = await putEvidence({
    store,
    namespace: subject.namespace,
    bytes,
    mediaType:
      "application/vnd.event-shopping-planner.artifact-recovery-subject+json;version=1",
    label: "Artifact recovery subject",
  });
  if (!sameCanonicalValue(storedSubject, subjectReference)) {
    throw new Error("Stored artifact recovery subject reference differs");
  }
  const approvalSet = await collectApprovals({
    store,
    namespace: subject.namespace,
    policy: approvalPolicy,
    operationId: subject.operationId,
    subjectSha256,
    expectedSourceSha: expectedExecutorSourceSha,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl,
    nowMs,
  });
  if (
    approvalSet.approvalRefs?.length !== requiredApprovalRoles.length ||
    approvalSet.approvalRefs.some(
      (approval, index) =>
        approval.role !== requiredApprovalRoles[index] ||
        approval.operationId !== subject.operationId ||
        approval.subjectSha256 !== subjectSha256,
    )
  ) {
    throw new Error("Artifact recovery approvals differ from the subject");
  }
  const refreshed = await readState({ store, requireInitialized: true });
  validateArchiveRecoverySubject({ subject, snapshot: refreshed.snapshot });
  const pendingOperation = {
    operationId: subject.operationId,
    kind: subject.operationKind,
    expectedState: subject.expectedState,
    targetBinding: subject.targetBinding,
    originBinding: subject.originBinding,
    originCompanionBinding: subject.originCompanionBinding,
    companionBinding: subject.companionBinding,
    previousBinding: subject.previousBinding,
    emergencyRecoveryBinding: subject.emergencyRecoveryBinding,
    approvalRefs: approvalSet.approvalRefs,
    preparedAt: new Date(approvalSet.verifiedAt).toISOString(),
  };
  const event = createReleaseEvent({
    namespace: subject.namespace,
    sequence: refreshed.snapshot.sequence + 1,
    eventType: "promotion-prepared",
    operationId: subject.operationId,
    appendId,
    previousEventHash: refreshed.snapshot.eventHash,
    payload: { pendingOperation },
    evidenceRefs: sortAndDedupeReferences(
      [
        subjectReference,
        approvalSet.issuerReceiptReference,
        ...bindingEvidence,
        ...approvalSet.approvalRefs.map(({ uri, sha256 }) => ({ uri, sha256 })),
      ],
      subject.namespace,
    ),
    approvalRefs: approvalSet.approvalRefs,
  });
  reduceReleaseState(refreshed.snapshot, event);
  const eventHash = hashReleaseEvent(event);
  const receipt = await store.compareAndAppend({
    expectedSequence: refreshed.snapshot.sequence,
    expectedHash: refreshed.snapshot.eventHash,
    event,
  });
  if (
    receipt?.eventHash !== eventHash ||
    receipt.sequence !== event.sequence ||
    receipt.namespace !== subject.namespace
  ) {
    throw new Error("Artifact recovery CAS receipt differs");
  }
  const committed = await readState({ store, requireInitialized: true });
  const record = committed.records.find(
    (candidate) => candidate.eventHash === eventHash,
  );
  if (!record) {
    throw new Error("Artifact recovery prepared event was not replayed");
  }
  return {
    replayed: receipt.replayed,
    subjectSha256,
    subjectReference,
    approvalRefs: approvalSet.approvalRefs,
    event,
    eventHash,
    eventUri: eventReference(subject.namespace, record).uri,
    committedAt: receipt.committedAt,
    head: committed.head,
  };
};
