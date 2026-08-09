import { sha256Bytes, sha256Json } from "../lib/canonical-json.mjs";
import {
  assertRequiredApprovalSet,
  resolveApprovalReference,
} from "./approvalResolver.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { fetchGitHubProtectedEnvironmentApprovals } from "./githubApprovalReceipt.mjs";
import { assertBindingPolicyEligible } from "./policyCompatibility.mjs";
import { resolvePrePromotionEvidenceReferences } from "./prePromotionEvidence.mjs";
import {
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  collectBindingEvidenceReferences,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";

export const PROMOTION_SUBJECT_KIND = "promotion-preparation-subject/v1";
const PRE_PROMOTION_ROLES = ["releaseOwner", "dataSafetyReviewer"];
const SUBJECT_KEYS = [
  "companionBinding",
  "emergencyRecoveryBinding",
  "evidenceRefs",
  "expectedState",
  "namespace",
  "operationId",
  "operationKind",
  "previousBinding",
  "schemaVersion",
  "subjectKind",
  "targetBinding",
];
const FORBIDDEN_CALLER_AUTHORITY_FIELDS = [
  "approvalRefs",
  "claims",
  "preparedAt",
  "roles",
  "snapshot",
];

const assertNoCallerAuthority = (options) => {
  for (const field of FORBIDDEN_CALLER_AUTHORITY_FIELDS) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `Caller-supplied ${field} is forbidden; authoritative state and approvals are resolved internally`,
      );
    }
  }
};

const expectedEmergencyRecovery = (snapshot) => {
  if (snapshot.activeProduction?.releaseRole === "containment") {
    return snapshot.activeProduction;
  }
  return snapshot.containmentCompanion ?? snapshot.bootstrapRecovery;
};

const assertPromotionPair = (standard, companion) => {
  if (
    standard.sourceSha !== companion.sourceSha ||
    standard.providerProjectId !== companion.providerProjectId ||
    !sameCanonicalValue(
      standard.requiredDbCompatibility,
      companion.requiredDbCompatibility,
    ) ||
    !sameCanonicalValue(standard.releasePolicy, companion.releasePolicy) ||
    !sameCanonicalValue(standard.providerPolicy, companion.providerPolicy) ||
    standard.providerConfigurationHash !== companion.providerConfigurationHash
  ) {
    throw new Error(
      "Promotion target and containment companion are not an exact pair",
    );
  }
};

export const validatePromotionSubject = ({ subject, snapshot }) => {
  assertExactKeys(subject, SUBJECT_KEYS, "Promotion subject");
  if (snapshot.pendingOperation !== null) {
    throw new Error("A Release State operation is already pending");
  }
  if (
    subject.schemaVersion !== 1 ||
    subject.subjectKind !== PROMOTION_SUBJECT_KIND ||
    subject.operationKind !== "promote-standard" ||
    !NAMESPACE_PATTERN.test(subject.namespace) ||
    !OPERATION_ID_PATTERN.test(subject.operationId)
  ) {
    throw new Error("Promotion subject identity is invalid");
  }
  assertExactKeys(
    subject.expectedState,
    ["eventHash", "sequence"],
    "Promotion expected state",
  );
  if (
    !Number.isSafeInteger(subject.expectedState.sequence) ||
    subject.expectedState.sequence < 1 ||
    !SHA256_PATTERN.test(subject.expectedState.eventHash) ||
    subject.expectedState.sequence !== snapshot.sequence ||
    subject.expectedState.eventHash !== snapshot.eventHash
  ) {
    throw new Error(
      "Promotion subject does not bind the replayed Release State head",
    );
  }
  assertDeploymentBinding(subject.targetBinding, {
    namespace: subject.namespace,
    expectedRole: "standard",
    label: "Promotion target",
  });
  assertDeploymentBinding(subject.companionBinding, {
    namespace: subject.namespace,
    expectedRole: "containment",
    label: "Promotion companion",
  });
  assertDeploymentBinding(subject.emergencyRecoveryBinding, {
    namespace: subject.namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Promotion emergency recovery",
  });
  assertPromotionPair(subject.targetBinding, subject.companionBinding);
  assertBindingPolicyEligible({
    snapshot,
    binding: subject.emergencyRecoveryBinding,
    action: "containment",
    label: "Promotion emergency recovery",
  });

  if (
    !sameCanonicalValue(subject.previousBinding, snapshot.activeProduction) ||
    !sameCanonicalValue(
      subject.emergencyRecoveryBinding,
      expectedEmergencyRecovery(snapshot),
    )
  ) {
    throw new Error(
      "Promotion previous or emergency binding was not derived from current state",
    );
  }
  if (
    !sameCanonicalValue(
      subject.targetBinding.requiredDbCompatibility,
      snapshot.currentDbCompatibility,
    ) ||
    !sameCanonicalValue(
      subject.companionBinding.requiredDbCompatibility,
      snapshot.currentDbCompatibility,
    ) ||
    !sameCanonicalValue(
      subject.emergencyRecoveryBinding.requiredDbCompatibility,
      snapshot.currentDbCompatibility,
    ) ||
    !sameCanonicalValue(
      subject.targetBinding.releasePolicy,
      snapshot.activeReleasePolicy,
    ) ||
    !sameCanonicalValue(
      subject.companionBinding.releasePolicy,
      snapshot.activeReleasePolicy,
    )
  ) {
    throw new Error(
      "Promotion bindings differ from current policy or DB compatibility",
    );
  }
  if (
    snapshot.activeProduction?.providerDeploymentId ===
    subject.targetBinding.providerDeploymentId
  ) {
    throw new Error("Promotion target is already the active deployment");
  }
  if (
    !Array.isArray(subject.evidenceRefs) ||
    subject.evidenceRefs.length !== 5
  ) {
    throw new Error(
      "Promotion subject requires the five closed pre-promotion receipts",
    );
  }
  const sortedEvidence = sortAndDedupeReferences(
    subject.evidenceRefs,
    subject.namespace,
  );
  if (
    sortedEvidence.length !== subject.evidenceRefs.length ||
    !sameCanonicalValue(sortedEvidence, subject.evidenceRefs)
  ) {
    throw new Error(
      "Promotion subject evidence references must be distinct and UTF-8 sorted",
    );
  }
  return subject;
};

const validateSubjectEvidence = async ({ store, subject, snapshot }) => {
  const bindings = [
    ["Promotion target", subject.targetBinding],
    ["Promotion companion", subject.companionBinding],
    ["Promotion emergency recovery", subject.emergencyRecoveryBinding],
  ];
  for (const [label, binding] of bindings) {
    await validateProviderEvidenceForBinding({
      store,
      namespace: subject.namespace,
      binding,
      label,
    });
  }
  await resolvePrePromotionEvidenceReferences({
    store,
    namespace: subject.namespace,
    references: subject.evidenceRefs,
    bindings: {
      standard: subject.targetBinding,
      containment: subject.companionBinding,
    },
    snapshot,
  });
  const references = sortAndDedupeReferences(
    [
      ...subject.evidenceRefs,
      ...bindings.flatMap(([, binding]) =>
        collectBindingEvidenceReferences(binding),
      ),
    ],
    subject.namespace,
  );
  for (const reference of references) {
    await assertEvidenceObjectAvailable({
      store,
      reference,
      namespace: subject.namespace,
      label: "Promotion evidence",
    });
  }
  return references;
};

const putReceiptEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const expectedSha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    !receipt ||
    receipt.sha256 !== expectedSha256 ||
    receipt.uri !== `release-state://${namespace}/evidence/${expectedSha256}` ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  return {
    uri: receipt.uri,
    sha256: receipt.sha256,
  };
};

export const collectAndStorePrePromotionApprovals = async (
  {
    store,
    namespace,
    policy,
    operationId,
    subjectSha256,
    expectedSourceSha,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
    nowMs = Date.now(),
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
    nowMs,
    fetchImpl,
  });
  if (
    !verifiedOidc ||
    !Buffer.isBuffer(verifiedOidc.receiptBytes) ||
    verifiedOidc.receipt?.claims?.sourceSha !== expectedSourceSha ||
    verifiedOidc.receipt?.claims?.runId !== expectedRunId ||
    !Number.isFinite(Date.parse(verifiedOidc.receipt?.verifiedAt))
  ) {
    throw new Error("Verified GitHub OIDC result has an invalid binding");
  }
  const issuerReceiptReference = await putReceiptEvidence({
    store,
    namespace,
    bytes: verifiedOidc.receiptBytes,
    mediaType:
      "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1",
    label: "GitHub OIDC receipt",
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
      throw new Error("Verified GitHub approval result is invalid");
    }
    const receiptReference = await putReceiptEvidence({
      store,
      namespace,
      bytes: candidate.receiptBytes,
      mediaType:
        "application/vnd.event-shopping-planner.github-approval-receipt+json;version=1",
      label: "GitHub approval receipt",
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
    if (PRE_PROMOTION_ROLES.includes(reference.role)) {
      resolved.push(reference);
    }
  }
  resolved.sort(
    (left, right) =>
      PRE_PROMOTION_ROLES.indexOf(left.role) -
      PRE_PROMOTION_ROLES.indexOf(right.role),
  );
  assertRequiredApprovalSet(resolved, PRE_PROMOTION_ROLES);
  return {
    approvalRefs: resolved,
    issuerReceiptReference,
    verifiedAt: verifiedOidc.receipt.verifiedAt,
  };
};

export const derivePromotionAppendId = ({
  namespace,
  operationId,
  subjectSha256,
}) => {
  const digest = Buffer.from(
    sha256Json({
      kind: "promotion-prepared-append-id/v1",
      namespace,
      operationId,
      subjectSha256,
    }),
    "hex",
  ).subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const subjectMatchesPreparedEvent = ({
  subject,
  subjectReference,
  appendId,
  event,
}) => {
  const operation = event?.payload?.pendingOperation;
  return (
    event?.eventType === "promotion-prepared" &&
    event.appendId === appendId &&
    event.namespace === subject.namespace &&
    event.operationId === subject.operationId &&
    event.sequence === subject.expectedState.sequence + 1 &&
    event.previousEventHash === subject.expectedState.eventHash &&
    operation?.operationId === subject.operationId &&
    operation?.kind === subject.operationKind &&
    sameCanonicalValue(operation?.expectedState, subject.expectedState) &&
    sameCanonicalValue(operation?.targetBinding, subject.targetBinding) &&
    sameCanonicalValue(operation?.companionBinding, subject.companionBinding) &&
    sameCanonicalValue(operation?.previousBinding, subject.previousBinding) &&
    sameCanonicalValue(
      operation?.emergencyRecoveryBinding,
      subject.emergencyRecoveryBinding,
    ) &&
    operation?.originBinding === null &&
    operation?.originCompanionBinding === null &&
    event.evidenceRefs?.some(
      (reference) =>
        reference.uri === subjectReference.uri &&
        reference.sha256 === subjectReference.sha256,
    )
  );
};

const existingPreparationResult = async ({
  store,
  current,
  subject,
  subjectBytes,
  subjectReference,
  appendId,
}) => {
  const matches = current.records.filter((record) =>
    subjectMatchesPreparedEvent({
      subject,
      subjectReference,
      appendId,
      event: record.event,
    }),
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error("Promotion idempotency key is ambiguous");
  }
  const storedSubject = await assertEvidenceObjectAvailable({
    store,
    reference: subjectReference,
    namespace: subject.namespace,
    label: "Promotion subject",
  });
  if (!storedSubject.bytes.equals(subjectBytes)) {
    throw new Error("Stored promotion subject differs from retry input");
  }
  const [record] = matches;
  return {
    replayed: true,
    subjectSha256: subjectReference.sha256,
    subjectReference,
    approvalRefs: record.event.approvalRefs,
    event: record.event,
    eventHash: record.eventHash,
    eventUri:
      `release-state://${subject.namespace}/events/` +
      `${record.sequence}/${record.eventHash}`,
    committedAt: record.committedAt,
    head: current.head,
  };
};

export const preparePromotion = async (
  options,
  {
    readState = readCurrentReleaseState,
    collectApprovals = collectAndStorePrePromotionApprovals,
  } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    store,
    subjectBytes: suppliedSubjectBytes,
    approvalPolicy,
    expectedSubjectSha256,
    expectedSourceSha,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
    nowMs = Date.now(),
  } = options;
  if (
    !store ||
    typeof store.compareAndAppend !== "function" ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error("Release State store lacks CAS or evidence operations");
  }
  const subjectBytes = Buffer.isBuffer(suppliedSubjectBytes)
    ? suppliedSubjectBytes
    : Buffer.from(suppliedSubjectBytes ?? "");
  const subject = parseCanonicalJsonBytes(
    subjectBytes,
    "Promotion operation subject",
  );
  const subjectSha256 = sha256Bytes(subjectBytes);
  if (
    !SHA256_PATTERN.test(expectedSubjectSha256) ||
    expectedSubjectSha256 !== subjectSha256
  ) {
    throw new Error(
      "Promotion subject bytes differ from the reviewed subject SHA-256",
    );
  }
  const subjectReference = {
    uri: `release-state://${subject.namespace}/evidence/${subjectSha256}`,
    sha256: subjectSha256,
  };
  const appendId = derivePromotionAppendId({
    namespace: subject.namespace,
    operationId: subject.operationId,
    subjectSha256,
  });
  const current = await readState({ store });
  const replayedNamespace = current.records[0]?.event?.namespace;
  if (
    subject.namespace !== replayedNamespace ||
    (typeof store.namespace === "string" &&
      store.namespace !== subject.namespace)
  ) {
    throw new Error(
      "Promotion subject namespace differs from the replayed Release State",
    );
  }
  if (
    subject.targetBinding.sourceSha !== expectedSourceSha ||
    subject.companionBinding.sourceSha !== expectedSourceSha
  ) {
    throw new Error("Promotion source differs from the protected workflow");
  }
  const bindingEvidenceReferences = await validateSubjectEvidence({
    store,
    subject,
    snapshot: current.snapshot,
  });
  const existing = await existingPreparationResult({
    store,
    current,
    subject,
    subjectBytes,
    subjectReference,
    appendId,
  });
  if (existing) return existing;

  validatePromotionSubject({ subject, snapshot: current.snapshot });
  const storedSubjectReference = await putReceiptEvidence({
    store,
    namespace: subject.namespace,
    bytes: subjectBytes,
    mediaType:
      "application/vnd.event-shopping-planner.promotion-subject+json;version=1",
    label: "Promotion subject",
  });
  if (!sameCanonicalValue(storedSubjectReference, subjectReference)) {
    throw new Error("Stored promotion subject reference differs");
  }

  const approvalSet = await collectApprovals({
    store,
    namespace: subject.namespace,
    policy: approvalPolicy,
    operationId: subject.operationId,
    subjectSha256,
    expectedSourceSha,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl,
    nowMs,
  });
  assertRequiredApprovalSet(approvalSet.approvalRefs, PRE_PROMOTION_ROLES);
  if (!Number.isFinite(Date.parse(approvalSet.verifiedAt))) {
    throw new Error("Approval verification time is invalid");
  }
  for (const approval of approvalSet.approvalRefs) {
    if (
      approval.operationId !== subject.operationId ||
      approval.subjectSha256 !== subjectSha256 ||
      approval.protectedEnvironment !== approvalPolicy.protectedEnvironment ||
      approval.trustedIssuer !== approvalPolicy.trustedIssuer
    ) {
      throw new Error("Resolved approval differs from the promotion subject");
    }
  }

  const refreshed = await readState({ store });
  validatePromotionSubject({ subject, snapshot: refreshed.snapshot });
  const refreshedBindingEvidenceReferences = await validateSubjectEvidence({
    store,
    subject,
    snapshot: refreshed.snapshot,
  });
  if (
    !sameCanonicalValue(
      refreshedBindingEvidenceReferences,
      bindingEvidenceReferences,
    )
  ) {
    throw new Error("Promotion evidence changed during approval resolution");
  }
  const eventEvidenceRefs = sortAndDedupeReferences(
    [
      subjectReference,
      approvalSet.issuerReceiptReference,
      ...subject.evidenceRefs,
      ...bindingEvidenceReferences,
      ...approvalSet.approvalRefs.map(({ uri, sha256 }) => ({
        uri,
        sha256,
      })),
    ],
    subject.namespace,
  );
  const pendingOperation = {
    operationId: subject.operationId,
    kind: "promote-standard",
    expectedState: subject.expectedState,
    targetBinding: subject.targetBinding,
    originBinding: null,
    originCompanionBinding: null,
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
    evidenceRefs: eventEvidenceRefs,
    approvalRefs: approvalSet.approvalRefs,
  });
  reduceReleaseState(refreshed.snapshot, event);
  const expectedEventHash = hashReleaseEvent(event);
  const receipt = await store.compareAndAppend({
    expectedSequence: refreshed.snapshot.sequence,
    expectedHash: refreshed.snapshot.eventHash,
    event,
  });
  if (
    !receipt ||
    receipt.namespace !== subject.namespace ||
    receipt.sequence !== event.sequence ||
    receipt.eventHash !== expectedEventHash ||
    typeof receipt.replayed !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new Error("Promotion CAS receipt differs from the prepared event");
  }
  const committed = await readState({ store });
  const committedRecord = committed.records.find(
    (record) =>
      record.sequence === event.sequence &&
      record.eventHash === expectedEventHash &&
      record.event.appendId === appendId,
  );
  if (!committedRecord) {
    throw new Error("Committed promotion event was not recovered by replay");
  }
  return {
    replayed: receipt.replayed,
    subjectSha256,
    subjectReference,
    approvalRefs: approvalSet.approvalRefs,
    event,
    eventHash: expectedEventHash,
    eventUri:
      `release-state://${subject.namespace}/events/` +
      `${event.sequence}/${expectedEventHash}`,
    committedAt: receipt.committedAt,
    head: committed.head,
  };
};
