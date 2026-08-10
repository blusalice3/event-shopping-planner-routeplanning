import { canonicalJsonBytes } from "./canonical-json.mjs";
import { assertConfiguredApprovalRolePolicy } from "./approval-policy.mjs";
import { assertReviewedPerformanceArtifactForAcceptedGate } from "./performance-evidence-identity.mjs";
import { PERFORMANCE_INHERITED_GATES } from "./performance-inherited-closure.mjs";
import { assertRequiredApprovalSet } from "../release-state/approvalResolver.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import { assertOwnGatePerformanceProducerReceiptAuthority } from "../release-state/ownGatePerformanceEvidence.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  SHA256_PATTERN,
  assertArtifactArchiveAvailable,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";

const ACCEPTANCE_ROLES = Object.freeze([
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
]);
const ACCEPTED_EVENT_HASH_KEYS = Object.freeze([
  ...PERFORMANCE_INHERITED_GATES,
]);
const APPROVAL_REFERENCE_KEYS = Object.freeze([
  "uri",
  "sha256",
  "approvalId",
  "operationId",
  "subjectSha256",
  "trustedIssuer",
  "issuerReceiptUri",
  "issuerReceiptSha256",
  "workflowRunId",
  "protectedEnvironment",
  "providerReviewerId",
  "role",
  "decision",
  "approvedAt",
]);
const MEDIA_TYPES = Object.freeze({
  approval:
    "application/vnd.event-shopping-planner.github-approval-receipt+json;version=1",
  artifactManifest:
    "application/vnd.event-shopping-planner.artifact-manifest+json;version=1",
  archiveAvailability: ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  issuer:
    "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1",
  packageIndex:
    "application/vnd.event-shopping-planner.release-package-index+json;version=1",
  performance:
    "application/vnd.event-shopping-planner.performance-evidence+json;version=1",
  subject:
    "application/vnd.event-shopping-planner.standard-acceptance-subject+json;version=1",
});

const assertConfiguredApprovalPolicy = (policy) => {
  assertConfiguredApprovalRolePolicy(
    policy,
    "Performance closure approval policy",
  );
  if (
    typeof policy.repository !== "string" ||
    policy.repository.length === 0 ||
    typeof policy.workflowRef !== "string" ||
    policy.workflowRef.length === 0 ||
    typeof policy.trustedIssuer !== "string" ||
    policy.trustedIssuer.length === 0 ||
    typeof policy.protectedEnvironment !== "string" ||
    policy.protectedEnvironment.length === 0
  ) {
    throw new Error("Performance closure approval policy is not configured");
  }
  return policy;
};

const referenceFromApproval = (approval) => ({
  uri: approval.uri,
  sha256: approval.sha256,
});

const issuerReferenceFromApproval = (approval) => ({
  uri: approval.issuerReceiptUri,
  sha256: approval.issuerReceiptSha256,
});

const referenceIsPresent = (references, expected) =>
  references.some(
    (reference) =>
      reference?.uri === expected.uri && reference?.sha256 === expected.sha256,
  );

const assertTimestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical UTC timestamp`);
  }
};

const readEvidenceReference = async ({
  store,
  namespace,
  reference,
  label,
  mediaType = null,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    reference,
    namespace,
    label,
  });
  if (mediaType !== null && stored.mediaType !== mediaType) {
    throw new Error(`${label} has the wrong immutable media type`);
  }
  return stored;
};

const assertEventReferencesReachable = ({ current, event }) => {
  for (const reference of event.evidenceRefs) {
    const match = new RegExp(
      `^release-state://${event.namespace}/events/([1-9][0-9]*)/([0-9a-f]{64})$`,
    ).exec(reference?.uri ?? "");
    if (match === null) continue;
    const sequence = Number(match[1]);
    const digest = match[2];
    if (
      reference.sha256 !== digest ||
      !current.records.some(
        (record) => record.sequence === sequence && record.eventHash === digest,
      )
    ) {
      throw new Error(
        "Accepted event references an event outside the authoritative chain",
      );
    }
  }
};

const readAcceptedEvidenceObjects = async ({ store, current, event }) => {
  assertEventReferencesReachable({ current, event });
  const evidenceReferences = event.evidenceRefs.filter((reference) =>
    new RegExp(
      `^release-state://${event.namespace}/evidence/[0-9a-f]{64}$`,
    ).test(reference?.uri ?? ""),
  );
  const stored = await Promise.all(
    evidenceReferences.map(async (reference) => ({
      reference,
      stored: await readEvidenceReference({
        store,
        namespace: event.namespace,
        reference,
        label: "Accepted event evidence",
      }),
    })),
  );
  return new Map(stored.map((value) => [value.reference.sha256, value]));
};

const onlyMediaType = ({ values, mediaType, label }) => {
  const matches = [...values.values()].filter(
    (value) => value.stored.mediaType === mediaType,
  );
  if (matches.length !== 1) {
    throw new Error(`${label} must resolve to exactly one immutable object`);
  }
  return matches[0];
};

const assertApprovalReceiptChain = ({
  approval,
  event,
  subjectReference,
  sourceSha,
  policy,
  values,
}) => {
  assertExactKeys(
    approval,
    APPROVAL_REFERENCE_KEYS,
    "Accepted approval reference",
  );
  const receiptReference = referenceFromApproval(approval);
  const issuerReference = issuerReferenceFromApproval(approval);
  if (
    !referenceIsPresent(event.evidenceRefs, receiptReference) ||
    !referenceIsPresent(event.evidenceRefs, issuerReference)
  ) {
    throw new Error(
      "Accepted approval receipts are absent from event evidence",
    );
  }
  const receiptStored = values.get(receiptReference.sha256)?.stored;
  const issuerStored = values.get(issuerReference.sha256)?.stored;
  if (
    receiptStored?.mediaType !== MEDIA_TYPES.approval ||
    issuerStored?.mediaType !== MEDIA_TYPES.issuer
  ) {
    throw new Error("Accepted approval receipt media type is invalid");
  }
  const receipt = parseCanonicalJsonBytes(
    receiptStored.bytes,
    "Accepted GitHub approval receipt",
  );
  const issuer = parseCanonicalJsonBytes(
    issuerStored.bytes,
    "Accepted GitHub OIDC receipt",
  );
  const expectedTeam = policy.roles[approval.role]?.reviewerTeam;
  if (
    approval.operationId !== event.operationId ||
    approval.subjectSha256 !== subjectReference.sha256 ||
    approval.trustedIssuer !== policy.trustedIssuer ||
    approval.protectedEnvironment !== policy.protectedEnvironment ||
    approval.decision !== "APPROVED" ||
    receipt?.schemaVersion !== 1 ||
    receipt.kind !== "github-protected-environment-approval/v1" ||
    receipt.approvalId !== approval.approvalId ||
    receipt.operationId !== approval.operationId ||
    receipt.subjectSha256 !== approval.subjectSha256 ||
    receipt.decision !== approval.decision ||
    receipt.providerReviewerId !== approval.providerReviewerId ||
    receipt.role !== approval.role ||
    receipt.workflowRunId !== approval.workflowRunId ||
    receipt.protectedEnvironment !== approval.protectedEnvironment ||
    receipt.approvedAt !== approval.approvedAt ||
    !Array.isArray(receipt.providerReviewerTeamIds) ||
    receipt.providerReviewerTeamIds.length !== 1 ||
    receipt.providerReviewerTeamIds[0] !== expectedTeam ||
    issuer?.schemaVersion !== 1 ||
    issuer.kind !== "github-actions-oidc-verification/v1" ||
    issuer.issuer !== approval.trustedIssuer ||
    issuer.claims?.repository !== policy.repository ||
    issuer.claims?.workflowRef !== policy.workflowRef ||
    issuer.claims?.environment !== approval.protectedEnvironment ||
    issuer.claims?.runId !== approval.workflowRunId ||
    issuer.claims?.sourceSha !== sourceSha
  ) {
    throw new Error("Accepted approval/OIDC receipt chain differs");
  }
  assertTimestamp(approval.approvedAt, "Accepted approval time");
  assertTimestamp(issuer.verifiedAt, "Accepted OIDC verification time");
  assertTimestamp(issuer.claims.expiresAt, "Accepted OIDC expiration");
};

const assertAcceptedEventHashMap = (value) => {
  assertExactKeys(
    value,
    ACCEPTED_EVENT_HASH_KEYS,
    "Historical accepted event hash map",
  );
  for (const gate of PERFORMANCE_INHERITED_GATES) {
    if (!SHA256_PATTERN.test(value[gate] ?? "")) {
      throw new Error(`${gate}: accepted event hash is invalid`);
    }
  }
  if (
    new Set(Object.values(value)).size !== PERFORMANCE_INHERITED_GATES.length
  ) {
    throw new Error("Historical accepted event hashes must be distinct");
  }
  return value;
};

const resolveEntry = async ({
  store,
  current,
  gate,
  acceptedEventSha256,
  approvalPolicy,
}) => {
  const record = current.records.find(
    (candidate) => candidate.eventHash === acceptedEventSha256,
  );
  if (
    record === undefined ||
    record.event.eventType !== "release-accepted" ||
    record.event.namespace !== store.namespace
  ) {
    throw new Error(`${gate}: accepted event is absent from the current chain`);
  }
  const event = record.event;
  const values = await readAcceptedEvidenceObjects({ store, current, event });
  const subjectStored = onlyMediaType({
    values,
    mediaType: MEDIA_TYPES.subject,
    label: `${gate} standard acceptance subject`,
  });
  const subject = parseCanonicalJsonBytes(
    subjectStored.stored.bytes,
    `${gate} standard acceptance subject`,
  );
  const subjectReference = subjectStored.reference;
  assertExactKeys(
    subject.performanceEvidence,
    ["uri", "sha256"],
    `${gate} performance evidence reference`,
  );
  if (
    subject.operationId !== event.operationId ||
    subject.namespace !== event.namespace ||
    subject.acceptedGate !== event.payload?.acceptedGate ||
    subject.expectedState?.sequence !== event.sequence - 1 ||
    subject.expectedState?.eventHash !== event.previousEventHash ||
    !referenceIsPresent(event.evidenceRefs, subject.performanceEvidence)
  ) {
    throw new Error(`${gate}: acceptance subject authority is invalid`);
  }
  const performanceStored = values.get(
    subject.performanceEvidence.sha256,
  )?.stored;
  if (performanceStored?.mediaType !== MEDIA_TYPES.performance) {
    throw new Error(`${gate}: performance evidence is not authoritative`);
  }
  const liveArchive = await assertArtifactArchiveAvailable({
    store,
    namespace: event.namespace,
    binding: subject.standardBinding,
    label: `${gate} accepted standard binding`,
  });
  const requiredObjects = await Promise.all(
    [
      [
        subject.standardBinding.packageIndex,
        MEDIA_TYPES.packageIndex,
        `${gate} package index`,
      ],
      [
        subject.standardBinding.artifactManifest,
        MEDIA_TYPES.artifactManifest,
        `${gate} artifact manifest`,
      ],
      [
        subject.standardBinding.artifactArchiveAvailability,
        MEDIA_TYPES.archiveAvailability,
        `${gate} archive availability`,
      ],
    ].map(async ([reference, mediaType, label]) => ({
      reference,
      stored: await readEvidenceReference({
        store,
        namespace: event.namespace,
        reference,
        mediaType,
        label,
      }),
    })),
  );
  const [packageIndex, artifactManifest, archiveAvailability] = requiredObjects;
  if (
    !liveArchive.archive.bytes.equals(
      (
        await readEvidenceReference({
          store,
          namespace: event.namespace,
          reference: subject.standardBinding.artifactArchive,
          label: `${gate} live archive`,
        })
      ).bytes,
    ) ||
    !sameCanonicalValue(
      liveArchive.availability,
      parseCanonicalJsonBytes(
        archiveAvailability.stored.bytes,
        `${gate} archive availability`,
      ),
    )
  ) {
    throw new Error(`${gate}: live archive authority changed during readback`);
  }
  for (const approval of event.approvalRefs) {
    assertApprovalReceiptChain({
      approval,
      event,
      subjectReference,
      sourceSha: subject.standardBinding.sourceSha,
      policy: approvalPolicy,
      values,
    });
  }
  assertRequiredApprovalSet(event.approvalRefs, ACCEPTANCE_ROLES);
  const acceptanceRunIds = [
    ...new Set(event.approvalRefs.map(({ workflowRunId }) => workflowRunId)),
  ];
  if (acceptanceRunIds.length !== 1) {
    throw new Error(
      `${gate}: acceptance approvals span multiple workflow runs`,
    );
  }
  const performanceArtifact = assertReviewedPerformanceArtifactForAcceptedGate({
    acceptedGate: event.payload.acceptedGate,
    bytes: performanceStored.bytes,
    expectedSha256: subject.performanceEvidence.sha256,
    label: `${gate} authoritative performance evidence`,
  });
  if (performanceArtifact.artifactKind !== "own-gate-performance-evidence/v1") {
    throw new Error(`${gate}: historical evidence is not an own-gate artifact`);
  }
  const producerReceipt = assertOwnGatePerformanceProducerReceiptAuthority({
    artifactValue: performanceArtifact.value,
    requirements: {
      schemaVersion: 1,
      requirementKind: "standard-acceptance-requirements/v1",
      namespace: event.namespace,
      operationId: event.operationId,
      sourceSha: subject.standardBinding.sourceSha,
      expectedArtifactSha256: subject.standardBinding.artifactArchive.sha256,
      expectedState: structuredClone(subject.expectedState),
      acceptedGate: event.payload.acceptedGate,
      performanceEvidenceKind: "own-gate-performance-evidence/v1",
      performanceGate: gate,
    },
    expectedNamespace: event.namespace,
    expectedSourceSha: subject.standardBinding.sourceSha,
    acceptanceRunId: acceptanceRunIds[0],
  });
  assertTimestamp(
    event.payload.observedThrough,
    `${gate} accepted observation time`,
  );
  if (
    Date.parse(producerReceipt.producedAtUtc) >
    Date.parse(event.payload.observedThrough)
  ) {
    throw new Error(
      `${gate}: performance evidence was produced after acceptance observation`,
    );
  }
  return {
    gate,
    performanceEvidenceBytes: Buffer.from(performanceStored.bytes),
    expectedPerformanceEvidenceSha256: subject.performanceEvidence.sha256,
    acceptedEventBytes: canonicalJsonBytes(event),
    expectedAcceptedEventSha256: record.eventHash,
    acceptanceSubjectBytes: Buffer.from(subjectStored.stored.bytes),
    expectedAcceptanceSubjectSha256: subjectReference.sha256,
    packageIndexBytes: Buffer.from(packageIndex.stored.bytes),
    expectedPackageIndexSha256: packageIndex.reference.sha256,
    artifactManifestBytes: Buffer.from(artifactManifest.stored.bytes),
    expectedArtifactManifestSha256: artifactManifest.reference.sha256,
    artifactArchiveAvailabilityBytes: Buffer.from(
      archiveAvailability.stored.bytes,
    ),
    expectedArtifactArchiveAvailabilitySha256:
      archiveAvailability.reference.sha256,
  };
};

export const resolveAuthoritativePerformanceClosureEntries = async ({
  store,
  acceptedEventSha256ByGate,
  approvalPolicy,
  readState = readCurrentReleaseState,
}) => {
  if (
    !store ||
    typeof store.namespace !== "string" ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error(
      "Performance closure requires a readable Release State store",
    );
  }
  assertAcceptedEventHashMap(acceptedEventSha256ByGate);
  assertConfiguredApprovalPolicy(approvalPolicy);
  const current = await readState({ store, requireInitialized: true });
  const entries = [];
  for (const gate of PERFORMANCE_INHERITED_GATES) {
    entries.push(
      await resolveEntry({
        store,
        current,
        gate,
        acceptedEventSha256: acceptedEventSha256ByGate[gate],
        approvalPolicy,
      }),
    );
  }
  const sequences = entries.map(
    (entry) =>
      current.records.find(
        (record) => record.eventHash === entry.expectedAcceptedEventSha256,
      ).sequence,
  );
  if (
    sequences.some(
      (sequence, index) => index > 0 && sequence <= sequences[index - 1],
    )
  ) {
    throw new Error("Historical accepted events are not ordered by gate");
  }
  return { current, entries };
};
