import {
  assertArtifactManifest,
  assertReleasePackageIndex,
} from "./artifact-contract.mjs";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import {
  ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
  assertReviewedPerformanceArtifact,
  projectOwnGatePerformanceEnvelope,
} from "./performance-evidence-identity.mjs";
import {
  projectPerformanceBudgetContract,
  verifyPerformanceEvidence,
} from "../verify-performance-policy.mjs";
import { canonicalize, sha256 } from "../foundation-policy-utils.mjs";
import {
  CANONICAL_SCENARIO_IDS,
  REQUIRED_PERFORMANCE_VARIANTS,
} from "../performance/canonicalScenarioDispatch.mjs";
import { computeVariantId } from "./release-policy.mjs";
import { assertRequiredApprovalSet } from "../release-state/approvalResolver.mjs";
import { assertOwnGatePerformanceProducerReceiptAuthority } from "../release-state/ownGatePerformanceEvidence.mjs";
import { hashReleaseEvent } from "../release-state/releaseStateReducer.mjs";
import {
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertDeploymentBinding,
  assertExactKeys,
  assertImmutableObjectReference,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";

export const PERFORMANCE_INHERITED_GATES = Object.freeze([
  "P0-TOOLCHAIN",
  "P3-XLSX",
  "P5-DUAL",
  "P5-LIST",
]);

const ACCEPTANCE_ROLES = Object.freeze([
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
]);
const ENTRY_INPUT_KEYS = Object.freeze([
  "gate",
  "performanceEvidenceBytes",
  "expectedPerformanceEvidenceSha256",
  "acceptedEventBytes",
  "expectedAcceptedEventSha256",
  "acceptanceSubjectBytes",
  "expectedAcceptanceSubjectSha256",
  "packageIndexBytes",
  "expectedPackageIndexSha256",
  "artifactManifestBytes",
  "expectedArtifactManifestSha256",
  "artifactArchiveAvailabilityBytes",
  "expectedArtifactArchiveAvailabilitySha256",
]);
const ACCEPTED_EVENT_KEYS = Object.freeze([
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
]);
const ACCEPTED_PAYLOAD_KEYS = Object.freeze([
  "acceptedGate",
  "releaseRole",
  "observedThrough",
  "rollbackInventory",
  "acceptedStandardFloors",
  "clearBootstrapRecovery",
]);
const ACCEPTANCE_SUBJECT_KEYS = Object.freeze([
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
]);
const AVAILABILITY_KEYS = Object.freeze([
  "artifactArchive",
  "artifactManifest",
  "availability",
  "bindingId",
  "evidenceKind",
  "namespace",
  "releaseRole",
  "schemaVersion",
  "sourceSha",
  "variantId",
]);
const ARCHIVE_DESCRIPTOR_KEYS = Object.freeze([
  "byteLength",
  "committedAt",
  "mediaType",
  "sha256",
  "uri",
]);
const GATE_ENTRY_KEYS = Object.freeze([
  "gate",
  "performanceEvidence",
  "acceptedEvent",
  "acceptanceSubject",
  "source",
  "artifact",
  "scenarioIds",
]);
const PERFORMANCE_REFERENCE_KEYS = Object.freeze([
  "reference",
  "objectSha256",
  "contentSha256",
  "evidenceId",
  "collectedAtUtc",
]);
const ACCEPTED_EVENT_SUMMARY_KEYS = Object.freeze([
  "reference",
  "operationId",
  "observedThrough",
  "sequence",
]);
const ARTIFACT_SUMMARY_KEYS = Object.freeze([
  "archive",
  "archiveAvailability",
  "manifest",
  "packageIndex",
  "variantId",
  "dimensions",
]);
const SCENARIO_SUMMARY_KEYS = Object.freeze([
  "id",
  "gate",
  "fixtureSha256",
  "performanceEvidenceObjectSha256",
  "performanceEvidenceContentSha256",
  "scenarioEvidenceSha256",
]);
const SOURCE_KEYS = Object.freeze([
  "gitCommitSha",
  "sourceClosureSha256",
  "treeState",
  "artifactSha256",
  "releaseVariant",
]);
const P8_SOURCE_KEYS = Object.freeze([
  "gitCommitSha",
  "sourceClosureSha256",
  "treeState",
]);
const REFERENCE_KEYS = Object.freeze(["sha256", "uri"]);

const assertCanonicalTimestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical UTC timestamp`);
  }
  return value;
};

const assertReviewedCanonicalObject = ({ bytes, expectedSha256, label }) => {
  if (
    !Buffer.isBuffer(bytes) ||
    !SHA256_PATTERN.test(expectedSha256 ?? "") ||
    sha256Bytes(bytes) !== expectedSha256
  ) {
    throw new Error(`${label} differs from its reviewed SHA-256`);
  }
  return parseCanonicalJsonBytes(bytes, label);
};

const referenceForEvidence = (namespace, sha256Value) => ({
  uri: `release-state://${namespace}/evidence/${sha256Value}`,
  sha256: sha256Value,
});

const referenceForEvent = (event, sha256Value) => ({
  uri: `release-state://${event.namespace}/events/${event.sequence}/${sha256Value}`,
  sha256: sha256Value,
});

const containsReference = (references, expected) =>
  Array.isArray(references) &&
  references.some(
    (reference) =>
      reference?.uri === expected.uri && reference?.sha256 === expected.sha256,
  );

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, REFERENCE_KEYS, label);
  assertImmutableObjectReference(reference, namespace, label);
  return reference;
};

const assertP8Source = (source) => {
  assertExactKeys(source, P8_SOURCE_KEYS, "P8 source closure");
  if (
    !SOURCE_SHA_PATTERN.test(source.gitCommitSha ?? "") ||
    !SHA256_PATTERN.test(source.sourceClosureSha256 ?? "") ||
    source.treeState !== "clean"
  ) {
    throw new Error("P8 source closure is invalid or dirty");
  }
  return source;
};

export const resolveHistoricalPerformanceDimensions = (releasePolicy, gate) => {
  if (!PERFORMANCE_INHERITED_GATES.includes(gate)) {
    throw new Error(`${gate}: unsupported inherited performance gate`);
  }
  const dimensions = structuredClone(releasePolicy.initialStandard);
  if (gate === "P0-TOOLCHAIN") return dimensions;
  for (const phase of releasePolicy.phaseSequence) {
    if (phase.change !== null) Object.assign(dimensions, phase.change);
    if (phase.gate === gate) return dimensions;
  }
  throw new Error(`${gate}: release variant phase is missing`);
};

const assertAcceptedEvent = ({ event, expectedSha256, gate }) => {
  assertExactKeys(event, ACCEPTED_EVENT_KEYS, "Accepted Release State event");
  assertExactKeys(
    event.payload,
    ACCEPTED_PAYLOAD_KEYS,
    "Accepted Release State payload",
  );
  if (
    event.schemaVersion !== 1 ||
    event.eventType !== "release-accepted" ||
    !NAMESPACE_PATTERN.test(event.namespace ?? "") ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.operationId !== "string" ||
    event.operationId.length === 0 ||
    !SHA256_PATTERN.test(event.previousEventHash ?? "") ||
    event.payloadSha256 !== sha256Json(event.payload) ||
    hashReleaseEvent(event) !== expectedSha256 ||
    ACCEPTANCE_PERFORMANCE_REQUIREMENTS[event.payload.acceptedGate] !== gate ||
    event.payload.releaseRole !== "standard" ||
    typeof event.payload.clearBootstrapRecovery !== "boolean" ||
    !Array.isArray(event.evidenceRefs)
  ) {
    throw new Error("Accepted Release State event identity is invalid");
  }
  assertCanonicalTimestamp(
    event.payload.observedThrough,
    "Accepted Release State observedThrough",
  );
  assertRequiredApprovalSet(event.approvalRefs, ACCEPTANCE_ROLES);
  return event;
};

const assertAcceptanceSubject = ({
  subject,
  subjectReference,
  performanceReference,
  event,
}) => {
  assertExactKeys(
    subject,
    ACCEPTANCE_SUBJECT_KEYS,
    "Standard acceptance subject",
  );
  assertExactKeys(
    subject.expectedState,
    ["eventHash", "sequence"],
    "Standard acceptance expected state",
  );
  if (
    subject.schemaVersion !== 1 ||
    subject.subjectKind !== "standard-acceptance-subject/v1" ||
    subject.namespace !== event.namespace ||
    subject.operationId !== event.operationId ||
    subject.expectedState.sequence !== event.sequence - 1 ||
    subject.expectedState.eventHash !== event.previousEventHash ||
    !sameCanonicalValue(subject.performanceEvidence, performanceReference) ||
    subject.acceptedGate !== event.payload.acceptedGate ||
    subject.observedThrough !== event.payload.observedThrough ||
    !sameCanonicalValue(
      subject.acceptedStandardFloors,
      event.payload.acceptedStandardFloors,
    ) ||
    !sameCanonicalValue(
      subject.rollbackInventory,
      event.payload.rollbackInventory,
    ) ||
    subject.clearBootstrapRecovery !== event.payload.clearBootstrapRecovery
  ) {
    throw new Error("Standard acceptance subject differs from its event");
  }
  assertDeploymentBinding(subject.standardBinding, {
    namespace: event.namespace,
    expectedRole: "standard",
    label: "Accepted performance standard binding",
  });
  assertDeploymentBinding(subject.companionBinding, {
    namespace: event.namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Accepted performance companion binding",
  });
  if (
    !containsReference(event.evidenceRefs, subjectReference) ||
    !containsReference(event.evidenceRefs, performanceReference)
  ) {
    throw new Error(
      "Accepted Release State event lacks its subject or performance evidence",
    );
  }
  for (const approval of event.approvalRefs) {
    if (
      approval.operationId !== event.operationId ||
      approval.subjectSha256 !== subjectReference.sha256
    ) {
      throw new Error("Accepted approval does not bind the acceptance subject");
    }
  }
  return subject;
};

const assertArchiveAvailability = ({
  availability,
  binding,
  expectedReference,
  namespace,
}) => {
  assertExactKeys(
    availability,
    AVAILABILITY_KEYS,
    "Artifact archive availability",
  );
  assertExactKeys(
    availability.artifactArchive,
    ARCHIVE_DESCRIPTOR_KEYS,
    "Artifact archive descriptor",
  );
  assertReference(
    availability.artifactManifest,
    namespace,
    "Availability artifact manifest",
  );
  const descriptor = availability.artifactArchive;
  if (
    availability.schemaVersion !== 1 ||
    availability.evidenceKind !== "artifact-archive-availability/v1" ||
    availability.availability !== "available" ||
    availability.namespace !== namespace ||
    availability.bindingId !== binding.bindingId ||
    availability.sourceSha !== binding.sourceSha ||
    availability.variantId !== binding.variantId ||
    availability.releaseRole !== "standard" ||
    !sameCanonicalValue(
      availability.artifactManifest,
      binding.artifactManifest,
    ) ||
    descriptor.uri !== binding.artifactArchive.uri ||
    descriptor.sha256 !== binding.artifactArchive.sha256 ||
    descriptor.mediaType !== ARTIFACT_ARCHIVE_MEDIA_TYPE ||
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength < 1 ||
    !Number.isFinite(Date.parse(descriptor.committedAt)) ||
    !sameCanonicalValue(binding.artifactArchiveAvailability, expectedReference)
  ) {
    throw new Error("Artifact archive availability binding is invalid");
  }
  return availability;
};

const assertSource = (source, gate) => {
  assertExactKeys(source, SOURCE_KEYS, `${gate} performance source`);
  assertExactKeys(
    source.releaseVariant,
    ["releaseRole", "xlsxExecution", "listEngine", "listDefault"],
    `${gate} performance release variant`,
  );
  if (
    !SOURCE_SHA_PATTERN.test(source.gitCommitSha ?? "") ||
    !SHA256_PATTERN.test(source.sourceClosureSha256 ?? "") ||
    !SHA256_PATTERN.test(source.artifactSha256 ?? "") ||
    source.treeState !== "clean" ||
    !sameCanonicalValue(
      source.releaseVariant,
      REQUIRED_PERFORMANCE_VARIANTS[gate],
    )
  ) {
    throw new Error(`${gate}: performance source binding is invalid`);
  }
};

const assertArtifactChain = ({
  gate,
  releasePolicy,
  binding,
  packageIndex,
  manifest,
  manifestReference,
  packageIndexReference,
  archiveAvailability,
  archiveAvailabilityReference,
  source,
  event,
}) => {
  assertArtifactManifest(manifest, releasePolicy);
  assertReleasePackageIndex(packageIndex);
  const expectedDimensions = resolveHistoricalPerformanceDimensions(
    releasePolicy,
    gate,
  );
  const standardArtifact =
    packageIndex.packageKind === "source-hardened-pair"
      ? packageIndex.artifacts.find(
          (artifact) => artifact.releaseRole === "standard",
        )
      : null;
  if (
    standardArtifact === null ||
    !sameCanonicalValue(manifest.dimensions, expectedDimensions) ||
    manifest.sourceSha !== binding.sourceSha ||
    manifest.sourceSha !== source.gitCommitSha ||
    manifest.variantId !== binding.variantId ||
    standardArtifact.variantId !== binding.variantId ||
    packageIndex.sourceSha !== binding.sourceSha ||
    standardArtifact.manifest.sha256 !== manifestReference.sha256 ||
    standardArtifact.archive.sha256 !== binding.artifactArchive.sha256 ||
    source.artifactSha256 !== binding.artifactArchive.sha256 ||
    manifest.releasePolicyHash !== binding.releasePolicy.sha256 ||
    manifest.releasePolicyHash !== sha256Json(releasePolicy) ||
    packageIndex.releasePolicyHash !== manifest.releasePolicyHash ||
    !sameCanonicalValue(binding.artifactManifest, manifestReference) ||
    !sameCanonicalValue(binding.packageIndex, packageIndexReference) ||
    !containsReference(event.evidenceRefs, manifestReference) ||
    !containsReference(event.evidenceRefs, packageIndexReference) ||
    !containsReference(event.evidenceRefs, archiveAvailabilityReference)
  ) {
    throw new Error(`${gate}: accepted artifact binding/hash chain differs`);
  }
  assertArchiveAvailability({
    availability: archiveAvailability,
    binding,
    expectedReference: archiveAvailabilityReference,
    namespace: event.namespace,
  });
  return expectedDimensions;
};

const policyBindings = (context) => ({
  uiScenariosSha256: sha256(canonicalize(context.uiScenarios)),
  performanceBudgetContractSha256: sha256(
    canonicalize(projectPerformanceBudgetContract(context.budgets)),
  ),
  xlsxLimitsSha256: sha256(canonicalize(context.xlsxLimits)),
});

export const validateOwnGatePerformanceForInheritedClosure = ({
  context,
  gate,
  reviewedPerformance,
}) => {
  if (reviewedPerformance.artifactKind !== "own-gate-performance-evidence/v1") {
    throw new Error(`${gate}: an own-gate performance envelope is required`);
  }
  const envelope = projectOwnGatePerformanceEnvelope(reviewedPerformance.value);
  const verification = verifyPerformanceEvidence({ context, gate, envelope });
  if (verification.errors.length > 0) {
    throw new Error(
      `${gate}: performance evidence failed:\n${verification.errors.join("\n")}`,
    );
  }
  assertSource(envelope.evidence.source, gate);
  return envelope;
};

const validateEntry = ({ context, releasePolicy, input }) => {
  assertExactKeys(input, ENTRY_INPUT_KEYS, "Inherited performance entry input");
  const gate = input.gate;
  if (!PERFORMANCE_INHERITED_GATES.includes(gate)) {
    throw new Error(`${gate}: inherited performance gate is invalid`);
  }
  const reviewedPerformance = assertReviewedPerformanceArtifact({
    bytes: input.performanceEvidenceBytes,
    expectedSha256: input.expectedPerformanceEvidenceSha256,
    label: `${gate} performance evidence`,
  });
  const envelope = validateOwnGatePerformanceForInheritedClosure({
    context,
    gate,
    reviewedPerformance,
  });

  const event = assertAcceptedEvent({
    event: assertReviewedCanonicalObject({
      bytes: input.acceptedEventBytes,
      expectedSha256: input.expectedAcceptedEventSha256,
      label: `${gate} accepted Release State event`,
    }),
    expectedSha256: input.expectedAcceptedEventSha256,
    gate,
  });
  const performanceReference = referenceForEvidence(
    event.namespace,
    input.expectedPerformanceEvidenceSha256,
  );
  const subject = assertReviewedCanonicalObject({
    bytes: input.acceptanceSubjectBytes,
    expectedSha256: input.expectedAcceptanceSubjectSha256,
    label: `${gate} standard acceptance subject`,
  });
  const subjectReference = referenceForEvidence(
    event.namespace,
    input.expectedAcceptanceSubjectSha256,
  );
  assertAcceptanceSubject({
    subject,
    subjectReference,
    performanceReference,
    event,
  });
  const acceptanceRunIds = [
    ...new Set(event.approvalRefs.map(({ workflowRunId }) => workflowRunId)),
  ];
  if (acceptanceRunIds.length !== 1) {
    throw new Error(
      `${gate}: acceptance approvals span multiple workflow runs`,
    );
  }
  const producerReceipt = assertOwnGatePerformanceProducerReceiptAuthority({
    artifactValue: reviewedPerformance.value,
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
  if (
    Date.parse(producerReceipt.producedAtUtc) >
    Date.parse(event.payload.observedThrough)
  ) {
    throw new Error(
      `${gate}: performance evidence was produced after acceptance observation`,
    );
  }

  const manifest = assertReviewedCanonicalObject({
    bytes: input.artifactManifestBytes,
    expectedSha256: input.expectedArtifactManifestSha256,
    label: `${gate} artifact manifest`,
  });
  const packageIndex = assertReviewedCanonicalObject({
    bytes: input.packageIndexBytes,
    expectedSha256: input.expectedPackageIndexSha256,
    label: `${gate} package index`,
  });
  const archiveAvailability = assertReviewedCanonicalObject({
    bytes: input.artifactArchiveAvailabilityBytes,
    expectedSha256: input.expectedArtifactArchiveAvailabilitySha256,
    label: `${gate} artifact archive availability`,
  });
  const manifestReference = referenceForEvidence(
    event.namespace,
    input.expectedArtifactManifestSha256,
  );
  const packageIndexReference = referenceForEvidence(
    event.namespace,
    input.expectedPackageIndexSha256,
  );
  const archiveAvailabilityReference = referenceForEvidence(
    event.namespace,
    input.expectedArtifactArchiveAvailabilitySha256,
  );
  const dimensions = assertArtifactChain({
    gate,
    releasePolicy,
    binding: subject.standardBinding,
    packageIndex,
    manifest,
    manifestReference,
    packageIndexReference,
    archiveAvailability,
    archiveAvailabilityReference,
    source: envelope.evidence.source,
    event,
  });

  const scenarioIds = envelope.evidence.scenarios.map(({ id }) => id);
  return {
    gate,
    performanceEvidence: {
      reference: performanceReference,
      objectSha256: input.expectedPerformanceEvidenceSha256,
      contentSha256: envelope.evidenceSha256,
      evidenceId: envelope.evidence.evidenceId,
      collectedAtUtc: envelope.evidence.collectedAtUtc,
    },
    acceptedEvent: {
      reference: referenceForEvent(event, input.expectedAcceptedEventSha256),
      operationId: event.operationId,
      observedThrough: event.payload.observedThrough,
      sequence: event.sequence,
    },
    acceptanceSubject: subjectReference,
    source: structuredClone(envelope.evidence.source),
    artifact: {
      archive: structuredClone(subject.standardBinding.artifactArchive),
      archiveAvailability: archiveAvailabilityReference,
      manifest: manifestReference,
      packageIndex: packageIndexReference,
      variantId: manifest.variantId,
      dimensions,
    },
    scenarioIds,
    scenarioEvidence: new Map(
      envelope.evidence.scenarios.map((scenario) => [scenario.id, scenario]),
    ),
  };
};

const assertClosureReference = (reference, namespace, label) =>
  assertReference(reference, namespace, label);

const validateClosureShape = ({ context, releasePolicy, envelope }) => {
  assertExactKeys(
    envelope,
    ["schemaVersion", "closure", "closureSha256"],
    "Performance inherited closure envelope",
  );
  if (
    envelope.schemaVersion !== 1 ||
    !SHA256_PATTERN.test(envelope.closureSha256 ?? "") ||
    envelope.closureSha256 !== sha256Json(envelope.closure)
  ) {
    throw new Error(
      "Performance inherited closure envelope identity is invalid",
    );
  }
  const closure = envelope.closure;
  assertExactKeys(
    closure,
    [
      "kind",
      "closureId",
      "createdAtUtc",
      "namespace",
      "p8Source",
      "policyBindings",
      "requiredGates",
      "gates",
      "scenarios",
    ],
    "Performance inherited closure",
  );
  if (
    closure.kind !== "performance-inherited-closure/v1" ||
    typeof closure.closureId !== "string" ||
    !/^perf-closure-[a-z0-9][a-z0-9._-]{7,111}$/.test(closure.closureId) ||
    !NAMESPACE_PATTERN.test(closure.namespace ?? "")
  ) {
    throw new Error("Performance inherited closure identity is invalid");
  }
  assertCanonicalTimestamp(closure.createdAtUtc, "Closure createdAtUtc");
  const closureCreatedMilliseconds = Date.parse(closure.createdAtUtc);
  assertP8Source(closure.p8Source);
  assertExactKeys(
    closure.policyBindings,
    [
      "uiScenariosSha256",
      "performanceBudgetContractSha256",
      "xlsxLimitsSha256",
    ],
    "Closure policy bindings",
  );
  if (!sameCanonicalValue(closure.policyBindings, policyBindings(context))) {
    throw new Error("Performance inherited closure policy binding differs");
  }
  if (
    !sameCanonicalValue(closure.requiredGates, PERFORMANCE_INHERITED_GATES) ||
    !Array.isArray(closure.gates) ||
    closure.gates.length !== PERFORMANCE_INHERITED_GATES.length
  ) {
    throw new Error("Performance inherited closure gate set is invalid");
  }

  const artifactShas = new Set();
  let previousSequence = 0;
  const gateById = new Map();
  for (const [index, entry] of closure.gates.entries()) {
    const expectedGate = PERFORMANCE_INHERITED_GATES[index];
    assertExactKeys(entry, GATE_ENTRY_KEYS, `Closure gate ${index}`);
    assertExactKeys(
      entry.performanceEvidence,
      PERFORMANCE_REFERENCE_KEYS,
      `${expectedGate} performance evidence summary`,
    );
    assertExactKeys(
      entry.acceptedEvent,
      ACCEPTED_EVENT_SUMMARY_KEYS,
      `${expectedGate} accepted event summary`,
    );
    assertExactKeys(
      entry.artifact,
      ARTIFACT_SUMMARY_KEYS,
      `${expectedGate} artifact summary`,
    );
    assertExactKeys(
      entry.source,
      SOURCE_KEYS,
      `${expectedGate} source summary`,
    );
    if (entry.gate !== expectedGate) {
      throw new Error("Performance inherited closure gates are out of order");
    }
    assertSource(entry.source, expectedGate);
    assertClosureReference(
      entry.performanceEvidence.reference,
      closure.namespace,
      `${expectedGate} performance evidence reference`,
    );
    assertClosureReference(
      entry.acceptanceSubject,
      closure.namespace,
      `${expectedGate} acceptance subject reference`,
    );
    for (const [name, reference] of [
      ["archive", entry.artifact.archive],
      ["archive availability", entry.artifact.archiveAvailability],
      ["manifest", entry.artifact.manifest],
      ["package index", entry.artifact.packageIndex],
    ]) {
      assertClosureReference(
        reference,
        closure.namespace,
        `${expectedGate} ${name} reference`,
      );
    }
    assertExactKeys(
      entry.acceptedEvent.reference,
      REFERENCE_KEYS,
      `${expectedGate} accepted event reference`,
    );
    if (
      entry.acceptedEvent.reference.uri !==
        `release-state://${closure.namespace}/events/${entry.acceptedEvent.sequence}/${entry.acceptedEvent.reference.sha256}` ||
      !SHA256_PATTERN.test(entry.acceptedEvent.reference.sha256 ?? "") ||
      !Number.isSafeInteger(entry.acceptedEvent.sequence) ||
      entry.acceptedEvent.sequence <= previousSequence ||
      typeof entry.acceptedEvent.operationId !== "string" ||
      entry.acceptedEvent.operationId.length === 0 ||
      [...entry.acceptedEvent.operationId].length > 128 ||
      entry.performanceEvidence.reference.sha256 !==
        entry.performanceEvidence.objectSha256 ||
      !SHA256_PATTERN.test(entry.performanceEvidence.contentSha256 ?? "") ||
      !sameCanonicalValue(
        entry.source.releaseVariant,
        REQUIRED_PERFORMANCE_VARIANTS[expectedGate],
      ) ||
      !sameCanonicalValue(
        entry.artifact.dimensions,
        resolveHistoricalPerformanceDimensions(releasePolicy, expectedGate),
      ) ||
      entry.artifact.variantId !==
        computeVariantId(releasePolicy, entry.artifact.dimensions) ||
      entry.source.artifactSha256 !== entry.artifact.archive.sha256
    ) {
      throw new Error(`${expectedGate}: closure binding is invalid`);
    }
    assertCanonicalTimestamp(
      entry.performanceEvidence.collectedAtUtc,
      `${expectedGate} collectedAtUtc`,
    );
    assertCanonicalTimestamp(
      entry.acceptedEvent.observedThrough,
      `${expectedGate} observedThrough`,
    );
    if (
      Date.parse(entry.performanceEvidence.collectedAtUtc) >
        Date.parse(entry.acceptedEvent.observedThrough) ||
      Date.parse(entry.acceptedEvent.observedThrough) >
        closureCreatedMilliseconds
    ) {
      throw new Error(
        `${expectedGate}: performance collection, acceptance, and closure timestamps are out of order`,
      );
    }
    previousSequence = entry.acceptedEvent.sequence;
    artifactShas.add(entry.artifact.archive.sha256);
    const requirement = context.gateMap?.get(expectedGate);
    if (
      requirement?.evidenceScope !== "own" ||
      !sameCanonicalValue(entry.scenarioIds, requirement.scenarioIds)
    ) {
      throw new Error(
        `${expectedGate}: closure scenario set differs from policy`,
      );
    }
    gateById.set(expectedGate, entry);
  }
  if (artifactShas.size !== PERFORMANCE_INHERITED_GATES.length) {
    throw new Error("Inherited performance gates must bind distinct archives");
  }
  if (
    context.gateMap?.get("P8-CLEAN")?.evidenceScope !== "all-inherited" ||
    context.gateMap?.get("P8-CLEAN")?.scenarioIds?.length !== 0
  ) {
    throw new Error("P8 performance policy has unexpected own scenarios");
  }
  if (
    !Array.isArray(closure.scenarios) ||
    closure.scenarios.length !== CANONICAL_SCENARIO_IDS.length
  ) {
    throw new Error("Performance inherited closure scenario set is incomplete");
  }
  const seen = new Set();
  for (const [index, scenario] of closure.scenarios.entries()) {
    const expectedId = CANONICAL_SCENARIO_IDS[index];
    assertExactKeys(
      scenario,
      SCENARIO_SUMMARY_KEYS,
      `Closure scenario ${index}`,
    );
    const policy = context.scenarioMap?.get(expectedId);
    const budget = context.budgetMap?.get(expectedId);
    const gate = PERFORMANCE_INHERITED_GATES.find((candidate) =>
      context.gateMap.get(candidate).scenarioIds.includes(expectedId),
    );
    const gateEntry = gateById.get(gate);
    if (
      scenario.id !== expectedId ||
      seen.has(scenario.id) ||
      scenario.gate !== gate ||
      scenario.fixtureSha256 !== policy?.fixtureSha256 ||
      scenario.performanceEvidenceObjectSha256 !==
        gateEntry?.performanceEvidence.objectSha256 ||
      scenario.performanceEvidenceContentSha256 !==
        gateEntry?.performanceEvidence.contentSha256 ||
      budget?.evidenceSha256 !== scenario.performanceEvidenceContentSha256 ||
      !SHA256_PATTERN.test(scenario.scenarioEvidenceSha256 ?? "")
    ) {
      throw new Error(`${expectedId}: inherited scenario binding is invalid`);
    }
    seen.add(scenario.id);
  }
  return envelope;
};

export const buildPerformanceInheritedClosure = ({
  context,
  releasePolicy,
  closureId,
  createdAtUtc,
  p8Source,
  entries,
}) => {
  if ((context?.errors ?? []).length > 0) {
    throw new Error(
      `Performance policy is invalid:\n${context.errors.join("\n")}`,
    );
  }
  if (
    !Array.isArray(entries) ||
    entries.length !== PERFORMANCE_INHERITED_GATES.length
  ) {
    throw new Error(
      "Performance inherited closure requires exactly four gates",
    );
  }
  assertCanonicalTimestamp(createdAtUtc, "Closure createdAtUtc");
  assertP8Source(p8Source);
  const byGate = new Map();
  for (const entry of entries) {
    if (byGate.has(entry?.gate)) {
      throw new Error(
        "Performance inherited closure contains a duplicate gate",
      );
    }
    byGate.set(entry?.gate, entry);
  }
  const validated = PERFORMANCE_INHERITED_GATES.map((gate) => {
    const entry = byGate.get(gate);
    if (!entry)
      throw new Error(`${gate}: accepted performance entry is missing`);
    return validateEntry({ context, releasePolicy, input: entry });
  });
  const namespaces = new Set(
    validated.map(
      ({ acceptedEvent }) =>
        /^release-state:\/\/([^/]+)\//.exec(acceptedEvent.reference.uri)?.[1],
    ),
  );
  if (namespaces.size !== 1 || namespaces.has(undefined)) {
    throw new Error(
      "Inherited accepted events must use one Release State namespace",
    );
  }
  const [namespace] = namespaces;
  const scenarios = CANONICAL_SCENARIO_IDS.map((id) => {
    const owner = validated.find(({ scenarioEvidence }) =>
      scenarioEvidence.has(id),
    );
    if (!owner)
      throw new Error(`${id}: inherited scenario evidence is missing`);
    const evidence = owner.scenarioEvidence.get(id);
    return {
      id,
      gate: owner.gate,
      fixtureSha256: evidence.fixtureSha256,
      performanceEvidenceObjectSha256: owner.performanceEvidence.objectSha256,
      performanceEvidenceContentSha256: owner.performanceEvidence.contentSha256,
      scenarioEvidenceSha256: sha256Json(evidence),
    };
  });
  if (
    new Set(scenarios.map(({ id }) => id)).size !==
    CANONICAL_SCENARIO_IDS.length
  ) {
    throw new Error("Inherited scenario evidence contains duplicates");
  }
  const closure = {
    kind: "performance-inherited-closure/v1",
    closureId,
    createdAtUtc,
    namespace,
    p8Source: structuredClone(p8Source),
    policyBindings: policyBindings(context),
    requiredGates: [...PERFORMANCE_INHERITED_GATES],
    gates: validated.map((entry) => ({
      gate: entry.gate,
      performanceEvidence: entry.performanceEvidence,
      acceptedEvent: entry.acceptedEvent,
      acceptanceSubject: entry.acceptanceSubject,
      source: entry.source,
      artifact: entry.artifact,
      scenarioIds: entry.scenarioIds,
    })),
    scenarios,
  };
  const envelope = {
    schemaVersion: 1,
    closure,
    closureSha256: sha256Json(closure),
  };
  return validateClosureShape({ context, releasePolicy, envelope });
};

export const verifyPerformanceInheritedClosure = ({
  context,
  releasePolicy,
  envelope,
}) => {
  const errors = [...(context?.errors ?? [])];
  try {
    validateClosureShape({ context, releasePolicy, envelope });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { errors };
};

export const canonicalPerformanceInheritedClosureBytes = (envelope) =>
  canonicalJsonBytes(envelope);
