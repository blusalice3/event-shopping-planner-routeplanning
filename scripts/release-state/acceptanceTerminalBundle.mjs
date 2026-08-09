import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
  assertReviewedPerformanceArtifactForAcceptedGate,
} from "../lib/performance-evidence-identity.mjs";
import { assertReleaseEvidenceBundleEnvelope } from "../verify-release-a-evidence-bundle.mjs";
import { assertRequiredApprovalSet } from "./approvalResolver.mjs";
import { assertOwnGatePerformanceProducerReceiptAuthority } from "./ownGatePerformanceEvidence.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  assertExactKeys,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

const ACCEPTANCE_ROLES = [
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
];
const OBJECT_SET_KEYS = ["kind", "objects", "schemaVersion"];
const OBJECT_ENTRY_KEYS = ["bytesBase64", "sha256"];
const REFERENCE_KEYS = ["sha256", "uri"];

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, REFERENCE_KEYS, label);
  const match =
    typeof reference.uri === "string"
      ? /^release-state:\/\/([a-z0-9][a-z0-9-]{2,62})\/(?:evidence|events\/[1-9][0-9]*)\/([0-9a-f]{64})$/.exec(
          reference.uri,
        )
      : null;
  if (
    match === null ||
    match[1] !== namespace ||
    match[2] !== reference.sha256 ||
    !SHA256_PATTERN.test(reference.sha256)
  ) {
    throw new Error(`${label} is not a bound immutable reference`);
  }
};

export const buildReleaseEvidenceObjectSet = async ({ store, references }) => {
  if (!store || typeof store.readEvidence !== "function") {
    throw new Error("Release evidence object-set store is invalid");
  }
  const bySha256 = new Map();
  for (const reference of references) {
    assertReference(reference, store.namespace, "Terminal bundle object");
    bySha256.set(reference.sha256, reference);
  }
  const objects = [];
  for (const sha256 of [...bySha256.keys()].sort(compareUtf8)) {
    const reference = bySha256.get(sha256);
    let stored = await store.readEvidence({ sha256 });
    if (!stored || !Buffer.isBuffer(stored.bytes)) {
      const eventMatch = new RegExp(
        `^release-state://${store.namespace}/events/([1-9][0-9]*)/${sha256}$`,
      ).exec(reference.uri);
      if (eventMatch !== null && typeof store.readEvents === "function") {
        const sequence = Number(eventMatch[1]);
        const records = await store.readEvents({ afterSequence: sequence - 1 });
        const record = records.find(
          (candidate) =>
            candidate.sequence === sequence && candidate.eventHash === sha256,
        );
        if (record) {
          stored = { bytes: canonicalJsonBytes(record.event) };
        }
      }
    }
    if (!stored || !Buffer.isBuffer(stored.bytes)) {
      throw new Error(`Terminal bundle object is missing: ${sha256}`);
    }
    if (sha256Bytes(stored.bytes) !== sha256) {
      throw new Error(`Terminal bundle object hash differs: ${sha256}`);
    }
    objects.push({ sha256, bytesBase64: stored.bytes.toString("base64") });
  }
  const objectSet = {
    schemaVersion: 1,
    kind: "release-evidence-object-set/v1",
    objects,
  };
  const objectSetBytes = canonicalJsonBytes(objectSet);
  return {
    objectSet,
    objectSetBytes,
    objectSetSha256: sha256Bytes(objectSetBytes),
  };
};

const parseObjectSet = ({ bytes, expectedSha256 }) => {
  if (
    !Buffer.isBuffer(bytes) ||
    !SHA256_PATTERN.test(expectedSha256) ||
    sha256Bytes(bytes) !== expectedSha256
  ) {
    throw new Error(
      "Acceptance terminal object set differs from its reviewed SHA-256",
    );
  }
  const objectSet = parseCanonicalJsonBytes(
    bytes,
    "Acceptance terminal object set",
  );
  assertExactKeys(objectSet, OBJECT_SET_KEYS, "Acceptance terminal object set");
  if (
    objectSet.schemaVersion !== 1 ||
    objectSet.kind !== "release-evidence-object-set/v1" ||
    !Array.isArray(objectSet.objects) ||
    objectSet.objects.length === 0
  ) {
    throw new Error("Acceptance terminal object set identity is invalid");
  }
  const values = new Map();
  let previousSha256 = null;
  for (const entry of objectSet.objects) {
    assertExactKeys(entry, OBJECT_ENTRY_KEYS, "Terminal object-set entry");
    if (typeof entry.bytesBase64 !== "string") {
      throw new Error("Acceptance terminal object set is unsorted or tampered");
    }
    const objectBytes = Buffer.from(entry.bytesBase64, "base64");
    if (
      !SHA256_PATTERN.test(entry.sha256) ||
      objectBytes.length === 0 ||
      objectBytes.toString("base64") !== entry.bytesBase64 ||
      sha256Bytes(objectBytes) !== entry.sha256 ||
      (previousSha256 !== null &&
        compareUtf8(previousSha256, entry.sha256) >= 0)
    ) {
      throw new Error("Acceptance terminal object set is unsorted or tampered");
    }
    previousSha256 = entry.sha256;
    values.set(entry.sha256, objectBytes);
  }
  return { objectSet, values };
};

const approvalReceiptMatches = ({
  approval,
  receipt,
  issuer,
  bundle,
  approvalPolicy,
}) =>
  receipt?.schemaVersion === 1 &&
  receipt.kind === "github-protected-environment-approval/v1" &&
  receipt.approvalId === approval.approvalId &&
  receipt.operationId === approval.operationId &&
  receipt.subjectSha256 === approval.subjectSha256 &&
  receipt.decision === approval.decision &&
  receipt.providerReviewerId === approval.providerReviewerId &&
  receipt.role === approval.role &&
  receipt.workflowRunId === approval.workflowRunId &&
  receipt.protectedEnvironment === approval.protectedEnvironment &&
  receipt.approvedAt === approval.approvedAt &&
  Array.isArray(receipt.providerReviewerTeamIds) &&
  receipt.providerReviewerTeamIds.includes(
    approvalPolicy.roles[approval.role].reviewerTeam,
  ) &&
  issuer?.schemaVersion === 1 &&
  issuer.kind === "github-actions-oidc-verification/v1" &&
  issuer.issuer === approval.trustedIssuer &&
  issuer.claims?.repository === approvalPolicy.repository &&
  issuer.claims?.workflowRef === approvalPolicy.workflowRef &&
  issuer.claims?.sourceSha === bundle.sourceSha &&
  issuer.claims?.runId === approval.workflowRunId &&
  issuer.claims?.environment === approval.protectedEnvironment &&
  Number.isFinite(Date.parse(issuer.verifiedAt)) &&
  Number.isFinite(Date.parse(issuer.claims?.expiresAt));

export const loadAcceptanceFinalBundle = ({
  bundleBytes,
  expectedBundleSha256,
  objectSetBytes,
  expectedObjectSetSha256,
  namespace,
  approvalPolicy,
}) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !Buffer.isBuffer(bundleBytes) ||
    !SHA256_PATTERN.test(expectedBundleSha256) ||
    sha256Bytes(bundleBytes) !== expectedBundleSha256
  ) {
    throw new Error(
      "Acceptance terminal bundle differs from its reviewed SHA-256",
    );
  }
  const reviewerTeams = ACCEPTANCE_ROLES.map(
    (role) => approvalPolicy?.roles?.[role]?.reviewerTeam,
  );
  if (
    approvalPolicy?.bindingStatus !== "configured" ||
    typeof approvalPolicy.repository !== "string" ||
    typeof approvalPolicy.workflowRef !== "string" ||
    typeof approvalPolicy.trustedIssuer !== "string" ||
    typeof approvalPolicy.protectedEnvironment !== "string" ||
    reviewerTeams.some(
      (reviewerTeam) =>
        typeof reviewerTeam !== "string" || reviewerTeam.length === 0,
    ) ||
    new Set(reviewerTeams).size !== reviewerTeams.length
  ) {
    throw new Error("Acceptance approval policy is not configured");
  }
  const bundle = parseCanonicalJsonBytes(
    bundleBytes,
    "Acceptance terminal evidence bundle",
  );
  assertReleaseEvidenceBundleEnvelope(bundle);
  if (
    bundle.stage !== "acceptance-final" ||
    bundle.releaseRole !== "standard"
  ) {
    throw new Error("Acceptance requires an acceptance-final standard bundle");
  }
  const { objectSet, values } = parseObjectSet({
    bytes: objectSetBytes,
    expectedSha256: expectedObjectSetSha256,
  });
  const used = new Set();
  const resolveBytes = (reference, label) => {
    assertReference(reference, namespace, label);
    const bytes = values.get(reference.sha256);
    if (bytes === undefined) {
      throw new Error(`Acceptance terminal bundle object is missing: ${label}`);
    }
    used.add(reference.sha256);
    return bytes;
  };
  const resolve = (reference, label) =>
    parseCanonicalJsonBytes(resolveBytes(reference, label), label);
  const directReferences = [
    bundle.v1Evidence,
    bundle.performanceEvidence,
    bundle.packageIndex,
    bundle.artifactManifest,
    bundle.providerDeploymentEvidence,
    bundle.providerAssignmentEvidence,
    bundle.dbCompatibilityContract,
    bundle.releasePolicy,
    bundle.providerPolicy,
    bundle.releaseStateEvent,
    ...bundle.approvals,
  ].filter((reference) => reference !== null);
  for (const reference of directReferences) {
    resolveBytes(reference, "Acceptance terminal direct object");
  }
  const releaseStateEvent = resolve(
    bundle.releaseStateEvent,
    "Acceptance terminal Release State event",
  );
  if (
    releaseStateEvent?.schemaVersion !== 1 ||
    releaseStateEvent.namespace !== namespace ||
    releaseStateEvent.eventType !== "release-accepted" ||
    releaseStateEvent.payloadSha256 !== sha256Json(releaseStateEvent.payload) ||
    sha256Bytes(canonicalJsonBytes(releaseStateEvent)) !==
      bundle.releaseStateEvent.sha256 ||
    bundle.releaseStateEvent.uri !==
      `release-state://${namespace}/events/${releaseStateEvent.sequence}/${bundle.releaseStateEvent.sha256}` ||
    !Array.isArray(releaseStateEvent.evidenceRefs) ||
    !Array.isArray(releaseStateEvent.approvalRefs)
  ) {
    throw new Error("Acceptance terminal Release State event is invalid");
  }
  const performanceEvidenceBytes =
    bundle.performanceEvidence === null
      ? null
      : resolveBytes(
          bundle.performanceEvidence,
          "Acceptance terminal performance evidence",
        );
  const performanceArtifact = assertReviewedPerformanceArtifactForAcceptedGate({
    acceptedGate: releaseStateEvent.payload.acceptedGate,
    bytes: performanceEvidenceBytes,
    expectedSha256: bundle.performanceEvidence?.sha256 ?? null,
    label: "Acceptance terminal performance evidence",
  });
  for (const reference of releaseStateEvent.evidenceRefs) {
    resolveBytes(reference, "Acceptance terminal event evidence");
  }
  const approvalObjects = bundle.approvals.map((reference) =>
    resolve(reference, "Acceptance terminal approval object"),
  );
  if (!sameCanonicalValue(approvalObjects, releaseStateEvent.approvalRefs)) {
    throw new Error(
      "Acceptance terminal approval chain differs from the event",
    );
  }
  assertRequiredApprovalSet(approvalObjects, ACCEPTANCE_ROLES);
  for (const approval of approvalObjects) {
    const receipt = resolve(
      { uri: approval.uri, sha256: approval.sha256 },
      "Acceptance approval receipt",
    );
    const issuer = resolve(
      {
        uri: approval.issuerReceiptUri,
        sha256: approval.issuerReceiptSha256,
      },
      "Acceptance approval issuer receipt",
    );
    if (
      approval.operationId !== releaseStateEvent.operationId ||
      approval.trustedIssuer !== approvalPolicy.trustedIssuer ||
      approval.protectedEnvironment !== approvalPolicy.protectedEnvironment ||
      !approvalReceiptMatches({
        approval,
        receipt,
        issuer,
        bundle,
        approvalPolicy,
      })
    ) {
      throw new Error("Acceptance terminal approval receipt chain differs");
    }
  }
  const assignment = resolve(
    bundle.providerAssignmentEvidence,
    "Acceptance assignment validation",
  );
  if (
    assignment?.schemaVersion !== 1 ||
    assignment.evidenceKind !== "assignment-validation" ||
    !SHA256_PATTERN.test(assignment.assignmentReceiptSha256) ||
    typeof assignment.assignmentReceiptUri !== "string"
  ) {
    throw new Error("Acceptance assignment validation object is invalid");
  }
  resolve(
    {
      uri: assignment.assignmentReceiptUri,
      sha256: assignment.assignmentReceiptSha256,
    },
    "Acceptance assignment receipt",
  );
  if (used.size !== values.size) {
    throw new Error("Acceptance terminal object set contains unbound objects");
  }
  const v1Evidence = resolve(
    bundle.v1Evidence,
    "Acceptance frozen v1 evidence",
  );
  if (
    v1Evidence.release?.commitSha !== bundle.sourceSha ||
    v1Evidence.canary?.buildSha !== bundle.sourceSha
  ) {
    throw new Error("Acceptance terminal bundle source chain differs");
  }
  return {
    bundle,
    bundleSha256: expectedBundleSha256,
    objectSet,
    objectSetSha256: expectedObjectSetSha256,
    releaseStateEvent,
    approvalObjects,
    assignment,
    performanceArtifact,
    resolve,
  };
};

export const assertAcceptanceFinalBundleBinding = ({
  loaded,
  expectedEvent,
  expectedSubject,
  subjectReference,
  evidenceReference,
  performanceEvidenceReference,
  continuousProbeReference,
  companionRecoveryDrillReference,
  standardBinding,
  assignmentValidationEvidence,
}) => {
  const {
    bundle,
    releaseStateEvent,
    approvalObjects,
    performanceArtifact,
    resolve,
  } = loaded;
  const dbContract = resolve(
    bundle.dbCompatibilityContract,
    "Acceptance DB compatibility contract",
  );
  if (
    bundle.sourceSha !== standardBinding.sourceSha ||
    !sameCanonicalValue(bundle.v1Evidence, evidenceReference) ||
    !sameCanonicalValue(
      bundle.performanceEvidence,
      performanceEvidenceReference,
    ) ||
    !sameCanonicalValue(bundle.packageIndex, standardBinding.packageIndex) ||
    !sameCanonicalValue(
      bundle.artifactManifest,
      standardBinding.artifactManifest,
    ) ||
    !sameCanonicalValue(
      bundle.providerDeploymentEvidence,
      standardBinding.providerEvidence,
    ) ||
    !sameCanonicalValue(bundle.releasePolicy, standardBinding.releasePolicy) ||
    !sameCanonicalValue(
      bundle.providerPolicy,
      standardBinding.providerPolicy,
    ) ||
    !sameCanonicalValue(
      bundle.providerAssignmentEvidence,
      assignmentValidationEvidence,
    ) ||
    sha256Json(dbContract) !==
      standardBinding.requiredDbCompatibility.fingerprint ||
    dbContract.contractUri !==
      standardBinding.requiredDbCompatibility.contractUri
  ) {
    throw new Error("Acceptance terminal bundle binding/hash chain differs");
  }
  if (!sameCanonicalValue(releaseStateEvent, expectedEvent)) {
    throw new Error(
      "Acceptance terminal event differs from the current CAS plan",
    );
  }
  const subjectObject = resolve(
    subjectReference,
    "Acceptance terminal subject",
  );
  if (
    !sameCanonicalValue(subjectObject, expectedSubject) ||
    !sameCanonicalValue(subjectObject.releaseAEvidence, evidenceReference) ||
    !sameCanonicalValue(
      subjectObject.performanceEvidence,
      performanceEvidenceReference,
    ) ||
    !sameCanonicalValue(
      subjectObject.continuousProductionProbe,
      continuousProbeReference,
    ) ||
    !sameCanonicalValue(
      subjectObject.companionRecoveryDrill,
      companionRecoveryDrillReference,
    )
  ) {
    throw new Error("Acceptance terminal subject binding/hash chain differs");
  }
  if (performanceArtifact.artifactKind === "own-gate-performance-evidence/v1") {
    const performanceGate =
      ACCEPTANCE_PERFORMANCE_REQUIREMENTS[expectedEvent.payload.acceptedGate];
    const acceptanceRunIds = [
      ...new Set(approvalObjects.map(({ workflowRunId }) => workflowRunId)),
    ];
    if (acceptanceRunIds.length !== 1) {
      throw new Error(
        "Acceptance terminal approvals span multiple workflow runs",
      );
    }
    const producerReceipt = assertOwnGatePerformanceProducerReceiptAuthority({
      artifactValue: performanceArtifact.value,
      requirements: {
        schemaVersion: 1,
        requirementKind: "standard-acceptance-requirements/v1",
        namespace: expectedSubject.namespace,
        operationId: expectedSubject.operationId,
        sourceSha: standardBinding.sourceSha,
        expectedArtifactSha256: standardBinding.artifactArchive.sha256,
        expectedState: structuredClone(expectedSubject.expectedState),
        acceptedGate: expectedEvent.payload.acceptedGate,
        performanceEvidenceKind: "own-gate-performance-evidence/v1",
        performanceGate,
      },
      expectedNamespace: expectedSubject.namespace,
      expectedSourceSha: standardBinding.sourceSha,
      acceptanceRunId: acceptanceRunIds[0],
    });
    if (
      Date.parse(producerReceipt.producedAtUtc) >
      Date.parse(expectedEvent.payload.observedThrough)
    ) {
      throw new Error(
        "Acceptance terminal performance evidence was produced after observation",
      );
    }
  }
  return true;
};
