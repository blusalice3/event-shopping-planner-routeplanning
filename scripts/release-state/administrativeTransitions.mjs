import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { verifyPhaseSequence } from "../lib/release-policy.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  deriveLifecycleAppendId,
  deriveRollbackInventory,
} from "./lifecycleExecution.mjs";
import { assertRequiredApprovalSet } from "./approvalResolver.mjs";
import { collectAndStorePrePromotionApprovals } from "./promotionPreparation.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  collectBindingEvidenceReferences,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";
import {
  storeProviderAliasObservation,
  validateProviderAliasObservationEvidence,
} from "./reconcileDecision.mjs";

export const ADMINISTRATIVE_SUBJECT_KINDS = Object.freeze({
  initialize: "state-initialization-subject/v1",
  activateDb: "db-contract-activation-subject/v1",
  abort: "operation-abort-subject/v1",
});

const SUBJECT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-state-administrative-subject+json;version=1";
const DB_ACTIVATION_ROLES = ["releaseOwner", "dataSafetyReviewer"];
const EVENT_TYPE_BY_SUBJECT_KIND = Object.freeze({
  [ADMINISTRATIVE_SUBJECT_KINDS.initialize]: "state-initialized",
  [ADMINISTRATIVE_SUBJECT_KINDS.activateDb]: "db-contract-activated",
  [ADMINISTRATIVE_SUBJECT_KINDS.abort]: "operation-aborted",
});
const SUBJECT_KEYS_BY_KIND = Object.freeze({
  [ADMINISTRATIVE_SUBJECT_KINDS.initialize]: [
    "acceptedGate",
    "activeReleasePolicyReference",
    "bootstrapRecovery",
    "bootstrapRecoveryReference",
    "currentDbCompatibility",
    "dbContractReference",
    "executorSourceSha",
    "expectedState",
    "legacyObservationReference",
    "legacyObservedProduction",
    "minimumSafetyFloors",
    "namespace",
    "operationId",
    "schemaVersion",
    "sourceEvidenceRefs",
    "subjectKind",
    "targetSourceSha",
  ],
  [ADMINISTRATIVE_SUBJECT_KINDS.activateDb]: [
    "currentDbCompatibility",
    "dbContractReference",
    "executorSourceSha",
    "expectedState",
    "namespace",
    "operationId",
    "previousDbCompatibility",
    "rollbackInventory",
    "schemaVersion",
    "sourceEvidenceRefs",
    "subjectKind",
    "targetSourceSha",
  ],
  [ADMINISTRATIVE_SUBJECT_KINDS.abort]: [
    "executorSourceSha",
    "expectedState",
    "legacyProductionObservationReference",
    "namespace",
    "operationId",
    "pendingOperation",
    "preOperationActiveProduction",
    "providerObservationReference",
    "schemaVersion",
    "sourceEvidenceRefs",
    "subjectKind",
    "targetSourceSha",
  ],
});

const assertStore = (store) => {
  if (
    !store ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function" ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    typeof store.compareAndAppend !== "function"
  ) {
    throw new Error("Release State administrative store is incomplete");
  }
};

const assertIdentity = ({ store, namespace, operationId }) => {
  assertStore(store);
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    (store.namespace !== undefined && store.namespace !== namespace)
  ) {
    throw new Error("Administrative namespace or operation ID is invalid");
  }
};

const immutableReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const eventReference = (namespace, record) => ({
  uri: `release-state://${namespace}/events/${record.sequence}/${record.eventHash}`,
  sha256: record.eventHash,
});

const readCanonicalEvidence = async ({
  store,
  namespace,
  reference,
  label,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  return {
    value: parseCanonicalJsonBytes(stored.bytes, label),
    bytes: stored.bytes,
    mediaType: stored.mediaType,
  };
};

const initialMinimumSafetyFloors = (releasePolicy) => {
  verifyPhaseSequence(releasePolicy);
  const deferred = new Set();
  for (const phase of releasePolicy.phaseSequence) {
    for (const key of Object.keys(phase.minimumSafetyFloorChange ?? {})) {
      deferred.add(key);
    }
  }
  return Object.fromEntries(
    Object.entries(releasePolicy.minimumSafetyFloors).filter(
      ([key]) => !deferred.has(key),
    ),
  );
};

const assertFinalDbContract = (contract, reference) => {
  if (
    contract?.contractStatus !== "remote-verified" ||
    contract?.remote?.observationStatus !== "observed" ||
    !Array.isArray(contract.blockerCodes) ||
    contract.blockerCodes.length !== 0 ||
    typeof contract.contractUri !== "string" ||
    contract.contractUri.length === 0 ||
    sha256Json(contract) !== reference.sha256
  ) {
    throw new Error(
      "DB compatibility contract is not final and remotely observed",
    );
  }
  return {
    contractUri: contract.contractUri,
    fingerprint: reference.sha256,
  };
};

const validateReleasePolicyReference = async ({
  store,
  namespace,
  reference,
  label,
}) => {
  const { value } = await readCanonicalEvidence({
    store,
    namespace,
    reference,
    label,
  });
  verifyPhaseSequence(value);
  if (
    value.activationStatus !== "active" ||
    !Array.isArray(value.activationBlockers) ||
    value.activationBlockers.length !== 0
  ) {
    throw new Error("Release policy is not explicitly active and blocker-free");
  }
  return value;
};

const collectAndVerifyBindingEvidence = async ({
  store,
  namespace,
  binding,
  label,
}) => {
  await validateProviderEvidenceForBinding({
    store,
    namespace,
    binding,
    label,
  });
  await assertArtifactArchiveAvailable({
    store,
    namespace,
    binding,
    label,
  });
  const references = collectBindingEvidenceReferences(binding);
  for (const reference of references) {
    await assertEvidenceObjectAvailable({
      store,
      namespace,
      reference,
      label: `${label} immutable evidence`,
    });
  }
  return references;
};

const assertNoAuthorityInjection = (options, forbidden) => {
  if (options === null || typeof options !== "object") {
    throw new Error("Administrative subject options are invalid");
  }
  for (const field of forbidden) {
    if (Object.hasOwn(options, field)) {
      throw new Error(`Caller-supplied ${field} is forbidden`);
    }
  }
};

export const buildAuthoritativeStateInitializationSubject = async (
  options,
  {
    readState = readCurrentReleaseState,
    validateProviderObservation = validateProviderAliasObservationEvidence,
    verifyBindingEvidence = collectAndVerifyBindingEvidence,
  } = {},
) => {
  assertNoAuthorityInjection(options, [
    "bootstrapRecovery",
    "currentDbCompatibility",
    "legacyObservedProduction",
    "minimumSafetyFloors",
    "releasePolicy",
    "snapshot",
  ]);
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    bootstrapRecoveryReference,
    legacyObservationReference,
    dbContractReference,
    activeReleasePolicyReference,
  } = options;
  assertIdentity({ store, namespace, operationId });
  if (!SOURCE_SHA_PATTERN.test(executorSourceSha)) {
    throw new Error("Administrative executor source SHA is invalid");
  }
  const current = await readState({ store, requireInitialized: false });
  if (
    current.head.sequence !== 0 ||
    current.head.eventHash !== null ||
    current.snapshot !== null ||
    current.records.length !== 0
  ) {
    throw new Error("State initialization requires an empty namespace");
  }
  const [{ value: bootstrapRecovery }, { value: dbContract }, releasePolicy] =
    await Promise.all([
      readCanonicalEvidence({
        store,
        namespace,
        reference: bootstrapRecoveryReference,
        label: "Bootstrap recovery binding",
      }),
      readCanonicalEvidence({
        store,
        namespace,
        reference: dbContractReference,
        label: "Final DB compatibility contract",
      }),
      validateReleasePolicyReference({
        store,
        namespace,
        reference: activeReleasePolicyReference,
        label: "Active release policy",
      }),
    ]);
  assertDeploymentBinding(bootstrapRecovery, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Bootstrap recovery binding",
  });
  if (bootstrapRecovery.publicIdentityKind !== "legacy-bootstrap-v1") {
    throw new Error(
      "Bootstrap recovery does not use legacy bootstrap identity",
    );
  }
  const currentDbCompatibility = assertFinalDbContract(
    dbContract,
    dbContractReference,
  );
  if (
    !sameCanonicalValue(
      bootstrapRecovery.requiredDbCompatibility,
      currentDbCompatibility,
    ) ||
    !sameCanonicalValue(
      bootstrapRecovery.releasePolicy,
      activeReleasePolicyReference,
    )
  ) {
    throw new Error(
      "Bootstrap recovery differs from final DB or active policy",
    );
  }
  const bindingEvidenceRefs = await verifyBindingEvidence({
    store,
    namespace,
    binding: bootstrapRecovery,
    label: "Bootstrap recovery binding",
  });
  const { value: providerPolicy } = await readCanonicalEvidence({
    store,
    namespace,
    reference: bootstrapRecovery.providerPolicy,
    label: "Bootstrap provider policy",
  });
  const legacyStored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: legacyObservationReference,
    label: "Legacy production provider observation",
  });
  const legacyValidation = await validateProviderObservation({
    store,
    namespace,
    observationBytes: legacyStored.bytes,
    providerPolicy,
    expectedBinding: null,
  });
  if (
    !sameCanonicalValue(
      legacyValidation.observationReference,
      legacyObservationReference,
    )
  ) {
    throw new Error("Legacy production observation reference differs");
  }
  const subject = {
    schemaVersion: 1,
    subjectKind: ADMINISTRATIVE_SUBJECT_KINDS.initialize,
    namespace,
    operationId,
    expectedState: { sequence: 0, eventHash: null },
    executorSourceSha,
    targetSourceSha: bootstrapRecovery.sourceSha,
    bootstrapRecoveryReference: structuredClone(bootstrapRecoveryReference),
    legacyObservationReference: structuredClone(legacyObservationReference),
    dbContractReference: structuredClone(dbContractReference),
    activeReleasePolicyReference: structuredClone(activeReleasePolicyReference),
    acceptedGate: null,
    bootstrapRecovery: structuredClone(bootstrapRecovery),
    legacyObservedProduction: {
      observationUri: legacyObservationReference.uri,
      observationSha256: legacyObservationReference.sha256,
    },
    currentDbCompatibility,
    minimumSafetyFloors: initialMinimumSafetyFloors(releasePolicy),
    sourceEvidenceRefs: sortAndDedupeReferences(
      [
        bootstrapRecoveryReference,
        legacyObservationReference,
        dbContractReference,
        activeReleasePolicyReference,
        ...bindingEvidenceRefs,
        ...legacyValidation.providerReceiptChainReferences,
      ],
      namespace,
    ),
  };
  const subjectBytes = canonicalJsonBytes(subject);
  return {
    subject,
    subjectBytes,
    subjectSha256: sha256Bytes(subjectBytes),
    expectedState: subject.expectedState,
  };
};

export const buildAuthoritativeDbContractActivationSubject = async (
  options,
  {
    readState = readCurrentReleaseState,
    deriveInventory = deriveRollbackInventory,
  } = {},
) => {
  assertNoAuthorityInjection(options, [
    "currentDbCompatibility",
    "previousDbCompatibility",
    "rollbackInventory",
    "snapshot",
  ]);
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    dbContractReference,
  } = options;
  assertIdentity({ store, namespace, operationId });
  if (!SOURCE_SHA_PATTERN.test(executorSourceSha)) {
    throw new Error("Administrative executor source SHA is invalid");
  }
  const current = await readState({ store });
  if (
    current.records[0]?.event?.namespace !== namespace ||
    current.snapshot.pendingOperation !== null ||
    current.snapshot.pendingAcceptance !== null
  ) {
    throw new Error("DB contract activation requires an idle namespace");
  }
  const { value: dbContract } = await readCanonicalEvidence({
    store,
    namespace,
    reference: dbContractReference,
    label: "Next DB compatibility contract",
  });
  const nextDbCompatibility = assertFinalDbContract(
    dbContract,
    dbContractReference,
  );
  if (
    sameCanonicalValue(
      current.snapshot.currentDbCompatibility,
      nextDbCompatibility,
    )
  ) {
    throw new Error("DB contract activation must move to a new fingerprint");
  }
  if (
    current.snapshot.activeProduction !== null &&
    !sameCanonicalValue(
      current.snapshot.activeProduction.requiredDbCompatibility,
      nextDbCompatibility,
    )
  ) {
    throw new Error("Active production does not satisfy the next DB contract");
  }
  const releasePolicy = await validateReleasePolicyReference({
    store,
    namespace,
    reference: current.snapshot.activeReleasePolicy,
    label: "DB activation release policy",
  });
  const projectedCurrent = {
    ...current,
    snapshot: {
      ...current.snapshot,
      currentDbCompatibility: nextDbCompatibility,
    },
  };
  const rollbackInventory =
    current.snapshot.rollbackInventory.length === 0 &&
    current.snapshot.acceptedStandard === null
      ? []
      : await deriveInventory({
          store,
          current: projectedCurrent,
          releasePolicy,
          minimumAcceptedGate: current.snapshot.acceptedGate,
          minimumAcceptedFloors: current.snapshot.acceptedStandardFloors,
        });
  const inventoryEvidence = rollbackInventory.flatMap((entry) => [
    entry.acceptedEvent,
    ...collectBindingEvidenceReferences(entry.binding),
  ]);
  const subject = {
    schemaVersion: 1,
    subjectKind: ADMINISTRATIVE_SUBJECT_KINDS.activateDb,
    namespace,
    operationId,
    expectedState: structuredClone(current.head),
    executorSourceSha,
    targetSourceSha:
      current.snapshot.activeProduction?.sourceSha ??
      current.snapshot.bootstrapRecovery.sourceSha,
    dbContractReference: structuredClone(dbContractReference),
    previousDbCompatibility: structuredClone(
      current.snapshot.currentDbCompatibility,
    ),
    currentDbCompatibility: nextDbCompatibility,
    rollbackInventory,
    sourceEvidenceRefs: sortAndDedupeReferences(
      [
        dbContractReference,
        current.snapshot.activeReleasePolicy,
        ...inventoryEvidence,
      ],
      namespace,
    ),
  };
  const subjectBytes = canonicalJsonBytes(subject);
  return {
    subject,
    subjectBytes,
    subjectSha256: sha256Bytes(subjectBytes),
    expectedState: subject.expectedState,
  };
};

export const buildAuthoritativeOperationAbortSubject = async (
  options,
  {
    readState = readCurrentReleaseState,
    storeObservation = storeProviderAliasObservation,
    validateProviderObservation = validateProviderAliasObservationEvidence,
    readProviderPolicy = async ({ store, namespace, reference }) =>
      (
        await readCanonicalEvidence({
          store,
          namespace,
          reference,
          label: "Abort provider policy",
        })
      ).value,
  } = {},
) => {
  assertNoAuthorityInjection(options, [
    "activeProduction",
    "pendingOperation",
    "providerPolicy",
    "snapshot",
  ]);
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    providerObservationBytes: suppliedObservationBytes,
  } = options;
  assertIdentity({ store, namespace, operationId });
  if (!SOURCE_SHA_PATTERN.test(executorSourceSha)) {
    throw new Error("Administrative executor source SHA is invalid");
  }
  const providerObservationBytes = Buffer.isBuffer(suppliedObservationBytes)
    ? suppliedObservationBytes
    : Buffer.from(suppliedObservationBytes ?? "");
  if (providerObservationBytes.length === 0) {
    throw new Error("Operation abort requires a fresh provider observation");
  }
  const current = await readState({ store });
  const pending = current.snapshot.pendingOperation;
  const latest = current.records.at(-1)?.event;
  if (
    current.records[0]?.event?.namespace !== namespace ||
    pending === null ||
    pending.operationId !== operationId ||
    current.snapshot.pendingAcceptance !== null ||
    latest?.eventType !== "promotion-prepared" ||
    latest.operationId !== operationId
  ) {
    throw new Error(
      "Operation abort is allowed only directly from the exact prepared head",
    );
  }
  const preOperationBinding = current.snapshot.activeProduction;
  if (!sameCanonicalValue(pending.previousBinding, preOperationBinding)) {
    throw new Error(
      "Operation abort lacks an exact pre-operation production binding",
    );
  }
  const providerPolicyReference =
    preOperationBinding?.providerPolicy ?? pending.targetBinding.providerPolicy;
  const providerPolicy = await readProviderPolicy({
    store,
    namespace,
    reference: providerPolicyReference,
  });
  const observationReference = await storeObservation({
    store,
    observationBytes: providerObservationBytes,
  });
  const validation = await validateProviderObservation({
    store,
    namespace,
    observationBytes: providerObservationBytes,
    providerPolicy,
    expectedBinding: preOperationBinding,
  });
  if (
    !sameCanonicalValue(
      observationReference,
      validation.observationReference,
    ) ||
    validation.observedDeploymentId ===
      pending.targetBinding.providerDeploymentId
  ) {
    throw new Error(
      "Provider observation is target-bound or differs from pre-operation production",
    );
  }
  let legacyObservationReference = null;
  let legacyEvidenceRefs = [];
  if (preOperationBinding === null) {
    const legacy = current.snapshot.legacyObservedProduction;
    if (
      legacy === null ||
      typeof legacy?.observationUri !== "string" ||
      typeof legacy?.observationSha256 !== "string"
    ) {
      throw new Error("Operation abort lacks a legacy production observation");
    }
    legacyObservationReference = {
      uri: legacy.observationUri,
      sha256: legacy.observationSha256,
    };
    const legacyStored = await assertEvidenceObjectAvailable({
      store,
      namespace,
      reference: legacyObservationReference,
      label: "Pre-operation legacy provider observation",
    });
    const legacyValidation = await validateProviderObservation({
      store,
      namespace,
      observationBytes: legacyStored.bytes,
      providerPolicy,
      expectedBinding: null,
      freshnessRequired: false,
    });
    if (
      !sameCanonicalValue(
        legacyValidation.observationReference,
        legacyObservationReference,
      ) ||
      legacyValidation.observation.providerProjectId !==
        validation.observation.providerProjectId ||
      !sameCanonicalValue(
        legacyValidation.observation.assignments,
        validation.observation.assignments,
      ) ||
      !sameCanonicalValue(
        legacyValidation.providerResponseReferences,
        validation.providerResponseReferences,
      )
    ) {
      throw new Error(
        "Fresh provider observation differs from legacy pre-operation production",
      );
    }
    legacyEvidenceRefs = [
      legacyObservationReference,
      ...legacyValidation.providerReceiptChainReferences,
    ];
  }
  const subject = {
    schemaVersion: 1,
    subjectKind: ADMINISTRATIVE_SUBJECT_KINDS.abort,
    namespace,
    operationId,
    expectedState: structuredClone(current.head),
    executorSourceSha,
    targetSourceSha: pending.targetBinding.sourceSha,
    pendingOperation: structuredClone(pending),
    preOperationActiveProduction: structuredClone(preOperationBinding),
    legacyProductionObservationReference: structuredClone(
      legacyObservationReference,
    ),
    providerObservationReference: structuredClone(observationReference),
    sourceEvidenceRefs: sortAndDedupeReferences(
      [
        observationReference,
        providerPolicyReference,
        ...validation.providerReceiptChainReferences,
        ...legacyEvidenceRefs,
        ...(preOperationBinding === null
          ? []
          : collectBindingEvidenceReferences(preOperationBinding)),
      ],
      namespace,
    ),
  };
  const subjectBytes = canonicalJsonBytes(subject);
  return {
    subject,
    subjectBytes,
    subjectSha256: sha256Bytes(subjectBytes),
    expectedState: subject.expectedState,
  };
};

const payloadFromSubject = (subject) => {
  switch (subject.subjectKind) {
    case ADMINISTRATIVE_SUBJECT_KINDS.initialize:
      return {
        acceptedGate: subject.acceptedGate,
        legacyObservedProduction: subject.legacyObservedProduction,
        bootstrapRecovery: subject.bootstrapRecovery,
        minimumSafetyFloors: subject.minimumSafetyFloors,
        currentDbCompatibility: subject.currentDbCompatibility,
        activeReleasePolicy: subject.activeReleasePolicyReference,
      };
    case ADMINISTRATIVE_SUBJECT_KINDS.activateDb:
      return {
        previousDbCompatibility: subject.previousDbCompatibility,
        currentDbCompatibility: subject.currentDbCompatibility,
        rollbackInventory: subject.rollbackInventory,
      };
    case ADMINISTRATIVE_SUBJECT_KINDS.abort:
      return {};
    default:
      throw new Error("Administrative subject kind is unsupported");
  }
};

const putSubject = async ({ store, namespace, bytes, sha256 }) => {
  const receipt = await store.putEvidence({
    bytes,
    mediaType: SUBJECT_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== SUBJECT_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(
      "Administrative subject immutable-store receipt is invalid",
    );
  }
  const stored = await store.readEvidence({ sha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    !stored.bytes.equals(bytes)
  ) {
    throw new Error(
      "Stored administrative subject differs from reviewed bytes",
    );
  }
  return { uri: receipt.uri, sha256 };
};

const rederiveSubject = async ({
  subject,
  store,
  readState,
  deriveInventory,
  validateProviderObservation,
}) => {
  if (subject.subjectKind === ADMINISTRATIVE_SUBJECT_KINDS.initialize) {
    return buildAuthoritativeStateInitializationSubject(
      {
        store,
        namespace: subject.namespace,
        operationId: subject.operationId,
        executorSourceSha: subject.executorSourceSha,
        bootstrapRecoveryReference: subject.bootstrapRecoveryReference,
        legacyObservationReference: subject.legacyObservationReference,
        dbContractReference: subject.dbContractReference,
        activeReleasePolicyReference: subject.activeReleasePolicyReference,
      },
      { readState, validateProviderObservation },
    );
  }
  if (subject.subjectKind === ADMINISTRATIVE_SUBJECT_KINDS.activateDb) {
    return buildAuthoritativeDbContractActivationSubject(
      {
        store,
        namespace: subject.namespace,
        operationId: subject.operationId,
        executorSourceSha: subject.executorSourceSha,
        dbContractReference: subject.dbContractReference,
      },
      { readState, deriveInventory },
    );
  }
  if (subject.subjectKind === ADMINISTRATIVE_SUBJECT_KINDS.abort) {
    const stored = await assertEvidenceObjectAvailable({
      store,
      namespace: subject.namespace,
      reference: subject.providerObservationReference,
      label: "Abort provider observation",
    });
    return buildAuthoritativeOperationAbortSubject(
      {
        store,
        namespace: subject.namespace,
        operationId: subject.operationId,
        executorSourceSha: subject.executorSourceSha,
        providerObservationBytes: stored.bytes,
      },
      {
        readState,
        storeObservation: async () => subject.providerObservationReference,
        validateProviderObservation,
      },
    );
  }
  throw new Error("Administrative subject kind is unsupported");
};

const existingResult = async ({
  current,
  store,
  subject,
  subjectBytes,
  subjectReference,
  appendId,
}) => {
  const matches = current.records.filter(
    (record) => record.event.appendId === appendId,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error("Administrative idempotency key is ambiguous");
  }
  const [record] = matches;
  const eventType = EVENT_TYPE_BY_SUBJECT_KIND[subject.subjectKind];
  if (
    eventType === "state-initialized" &&
    (record.sequence !== 1 || current.head.sequence !== 1)
  ) {
    throw new Error(
      "State initialization retry is no longer at the initial head",
    );
  }
  if (
    record.event.eventType !== eventType ||
    record.event.operationId !== subject.operationId ||
    !sameCanonicalValue(record.event.payload, payloadFromSubject(subject)) ||
    !record.event.evidenceRefs.some((reference) =>
      sameCanonicalValue(reference, subjectReference),
    )
  ) {
    throw new Error("Existing administrative event differs from retry input");
  }
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace: subject.namespace,
    reference: subjectReference,
    label: "Administrative subject",
  });
  if (!stored.bytes.equals(subjectBytes)) {
    throw new Error("Stored administrative retry subject differs");
  }
  return {
    schemaVersion: 1,
    resultKind: `${eventType}-committed/v1`,
    operationId: subject.operationId,
    subject: subjectReference,
    approvals: structuredClone(record.event.approvalRefs),
    event: eventReference(subject.namespace, record),
    replayed: true,
    head: current.head,
  };
};

export const executeAdministrativeTransition = async (
  options,
  {
    readState = readCurrentReleaseState,
    collectApprovals = collectAndStorePrePromotionApprovals,
    deriveInventory = deriveRollbackInventory,
    validateProviderObservation = validateProviderAliasObservationEvidence,
    nowMs = Date.now(),
  } = {},
) => {
  assertNoAuthorityInjection(options, [
    "event",
    "payload",
    "providerPolicy",
    "snapshot",
  ]);
  const {
    store,
    subjectBytes: suppliedSubjectBytes,
    expectedSubjectSha256,
    expectedExecutorSourceSha,
    expectedRunId,
    approvalPolicy,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
  } = options;
  assertStore(store);
  const subjectBytes = Buffer.isBuffer(suppliedSubjectBytes)
    ? suppliedSubjectBytes
    : Buffer.from(suppliedSubjectBytes ?? "");
  const subject = parseCanonicalJsonBytes(
    subjectBytes,
    "Administrative transition subject",
  );
  const subjectSha256 = sha256Bytes(subjectBytes);
  const eventType = EVENT_TYPE_BY_SUBJECT_KIND[subject.subjectKind];
  const subjectKeys = SUBJECT_KEYS_BY_KIND[subject.subjectKind];
  if (subjectKeys !== undefined) {
    assertExactKeys(subject, subjectKeys, "Administrative transition subject");
  }
  if (
    subject.schemaVersion !== 1 ||
    eventType === undefined ||
    !NAMESPACE_PATTERN.test(subject.namespace) ||
    !OPERATION_ID_PATTERN.test(subject.operationId) ||
    !SHA256_PATTERN.test(expectedSubjectSha256) ||
    expectedSubjectSha256 !== subjectSha256 ||
    !SOURCE_SHA_PATTERN.test(expectedExecutorSourceSha) ||
    subject.executorSourceSha !== expectedExecutorSourceSha ||
    !SOURCE_SHA_PATTERN.test(subject.targetSourceSha)
  ) {
    throw new Error(
      "Administrative subject identity or reviewed hash is invalid",
    );
  }
  assertIdentity({
    store,
    namespace: subject.namespace,
    operationId: subject.operationId,
  });
  const subjectReference = immutableReference(subject.namespace, subjectSha256);
  const appendId = deriveLifecycleAppendId({
    kind: eventType,
    namespace: subject.namespace,
    operationId: subject.operationId,
    evidenceSha256: subjectSha256,
  });
  let current = await readState({
    store,
    requireInitialized: eventType !== "state-initialized",
  });
  const existing = await existingResult({
    current,
    store,
    subject,
    subjectBytes,
    subjectReference,
    appendId,
  });
  if (existing) return existing;
  const derived = await rederiveSubject({
    subject,
    store,
    readState,
    deriveInventory,
    validateProviderObservation,
  });
  if (!sameCanonicalValue(subject, derived.subject)) {
    throw new Error(
      "Reviewed subject differs from authoritative state and evidence",
    );
  }
  const storedSubjectReference = await putSubject({
    store,
    namespace: subject.namespace,
    bytes: subjectBytes,
    sha256: subjectSha256,
  });
  let approvalRefs = [];
  let approvalEvidenceRefs = [];
  if (eventType === "db-contract-activated") {
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
    assertRequiredApprovalSet(approvalSet.approvalRefs, DB_ACTIVATION_ROLES);
    if (
      approvalSet.approvalRefs.some(
        (approval) =>
          approval.operationId !== subject.operationId ||
          approval.subjectSha256 !== subjectSha256,
      )
    ) {
      throw new Error(
        "DB activation approval differs from the reviewed subject",
      );
    }
    approvalRefs = approvalSet.approvalRefs;
    approvalEvidenceRefs = [
      approvalSet.issuerReceiptReference,
      ...approvalRefs.map(({ uri, sha256 }) => ({ uri, sha256 })),
    ];
  }
  current = await readState({
    store,
    requireInitialized: eventType !== "state-initialized",
  });
  const refreshed = await rederiveSubject({
    subject,
    store,
    readState,
    deriveInventory,
    validateProviderObservation,
  });
  if (!sameCanonicalValue(subject, refreshed.subject)) {
    throw new Error("Release State or evidence changed during authorization");
  }
  const evidenceRefs = sortAndDedupeReferences(
    [
      storedSubjectReference,
      ...subject.sourceEvidenceRefs,
      ...approvalEvidenceRefs,
    ],
    subject.namespace,
  );
  const event = createReleaseEvent({
    namespace: subject.namespace,
    sequence: current.head.sequence + 1,
    eventType,
    operationId: subject.operationId,
    appendId,
    previousEventHash: current.head.eventHash,
    payload: payloadFromSubject(subject),
    evidenceRefs,
    approvalRefs,
  });
  reduceReleaseState(current.snapshot, event);
  const eventHash = hashReleaseEvent(event);
  const receipt = await store.compareAndAppend({
    expectedSequence: current.head.sequence,
    expectedHash: current.head.eventHash,
    event,
  });
  if (
    receipt?.namespace !== subject.namespace ||
    receipt.sequence !== event.sequence ||
    receipt.eventHash !== eventHash ||
    typeof receipt.replayed !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new Error("Administrative CAS receipt differs from the event");
  }
  const committed = await readState({ store });
  const record = committed.records.find(
    (candidate) =>
      candidate.event.appendId === appendId &&
      candidate.eventHash === eventHash,
  );
  if (!record) {
    throw new Error("Committed administrative event is absent from replay");
  }
  return {
    schemaVersion: 1,
    resultKind: `${eventType}-committed/v1`,
    operationId: subject.operationId,
    subject: subjectReference,
    approvals: approvalRefs,
    event: eventReference(subject.namespace, record),
    replayed: receipt.replayed,
    head: committed.head,
  };
};
