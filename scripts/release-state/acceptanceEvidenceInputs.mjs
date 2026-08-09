import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  assertExactKeys,
  assertImmutableObjectReference,
  compareUtf8,
  isRecord,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";
import {
  COMPANION_RECOVERY_SOURCE_KIND,
  CONTINUOUS_PROBE_SOURCE_KIND,
  resolveCompanionRecoverySource,
  resolveContinuousProbeSource,
} from "./acceptanceEvidenceAuthority.mjs";
import {
  assertCompanionRecoveryEvidenceSchema,
  assertCompanionRecoverySourceSchema,
  assertContinuousProbeEvidenceSchema,
  assertContinuousProbeSourceSchema,
} from "./acceptanceEvidenceSchemas.mjs";
import { readBoundReviewedWorkflowRunAuthority } from "./reviewedWorkflowRunAuthority.mjs";

export const CONTINUOUS_PROBE_MAXIMUM_GAP_SECONDS = 300;
export const COMPANION_RECOVERY_STEPS = [
  "package-redeploy-without-rebuild",
  "independent-companion-probe",
  "standard-return",
];

const CONTINUOUS_SOURCE_KEYS = [
  "authorityBundle",
  "sampleChainHead",
  "schemaVersion",
  "sourceKind",
];
const CONTINUOUS_EVIDENCE_KEYS = [
  "assignmentValidationEvidence",
  "buildId",
  "endedAt",
  "evidenceKind",
  "maximumGapSeconds",
  "namespace",
  "observationStartedEvent",
  "operationId",
  "ownedProductionDomains",
  "providerDeploymentId",
  "providerProjectId",
  "releaseAEvidenceAuthority",
  "releaseAEvidenceSha256",
  "sampleCount",
  "samples",
  "schemaVersion",
  "sourceEvidenceSha256",
  "sourceWorkflowAuthority",
  "sourceSha",
  "standardBindingId",
  "startedAt",
];
const SAMPLE_KEYS = [
  "observedAt",
  "results",
  "sampleChainCommit",
  "sampleEvidence",
];
const SAMPLE_RESULT_KEYS = [
  "httpReceipt",
  "productionDomain",
  "providerDeploymentId",
  "providerLookupReceipt",
  "responseSha256",
  "status",
];
const RECOVERY_SOURCE_KEYS = [
  "authorityBundle",
  "packageRedeployTerminalEvent",
  "schemaVersion",
  "sourceKind",
  "standardReturnEvent",
];
const RECOVERY_RESOLVED_KEYS = [
  "authorityBundle",
  "command",
  "companion",
  "completedAt",
  "drillEvidenceRef",
  "startedAt",
  "status",
  "steps",
];
const RECOVERY_EVIDENCE_KEYS = [
  "buildId",
  "command",
  "companion",
  "completedAt",
  "drillEvidenceRef",
  "evidenceKind",
  "namespace",
  "operationId",
  "releaseAEvidenceSha256",
  "releaseAEvidenceAuthority",
  "releasePolicy",
  "schemaVersion",
  "sourceEvidenceSha256",
  "sourceWorkflowAuthority",
  "sourceSha",
  "startedAt",
  "status",
  "steps",
];
const RECOVERY_COMPANION_KEYS = [
  "artifactManifestSha256",
  "bindingId",
  "buildId",
  "packageIndexSha256",
  "providerDeploymentId",
  "providerEvidenceSha256",
  "providerProjectId",
  "sourceSha",
  "variantId",
];
const RECOVERY_STEP_KEYS = ["evidenceRef", "status", "step"];
const EVENT_REFERENCE_PATTERN = (namespace, sha256) =>
  new RegExp(`^release-state://${namespace}/events/[1-9][0-9]*/${sha256}$`);
const EVIDENCE_REFERENCE_PATTERN =
  /^(?:https:\/\/|artifact:\/\/|run:\/\/|dashboard:\/\/|ticket:\/\/|release-state:\/\/)[^\s]{1,500}$/;

const assertCanonicalTimestamp = (value, label) => {
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

const assertReviewedCanonicalBytes = ({ bytes, expectedSha256, label }) => {
  if (
    !SHA256_PATTERN.test(expectedSha256) ||
    sha256Bytes(bytes) !== expectedSha256
  ) {
    throw new Error(`${label} differs from its reviewed SHA-256`);
  }
  return parseCanonicalJsonBytes(bytes, label);
};

const assertEvidenceReferenceText = (value, label) => {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !EVIDENCE_REFERENCE_PATTERN.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const assertEventReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    !SHA256_PATTERN.test(reference.sha256) ||
    !EVENT_REFERENCE_PATTERN(namespace, reference.sha256).test(reference.uri)
  ) {
    throw new Error(`${label} is not bound to the release namespace`);
  }
};

const assertPendingAcceptance = (pendingAcceptance, namespace) => {
  if (
    !isRecord(pendingAcceptance) ||
    !isRecord(pendingAcceptance.standardBinding) ||
    !isRecord(pendingAcceptance.companionBinding) ||
    pendingAcceptance.standardBinding.releaseRole !== "standard" ||
    pendingAcceptance.companionBinding.releaseRole !== "containment" ||
    typeof pendingAcceptance.operationId !== "string" ||
    pendingAcceptance.operationId.length === 0
  ) {
    throw new Error("Pending standard acceptance is invalid");
  }
  assertImmutableObjectReference(
    pendingAcceptance.assignmentValidationEvidence,
    namespace,
    "Pending assignment validation evidence",
  );
  assertEventReference(
    pendingAcceptance.observationStartedEvent,
    namespace,
    "Pending observation-started event",
  );
  assertCanonicalTimestamp(
    pendingAcceptance.observationNotBefore,
    "Pending observation not-before",
  );
  assertCanonicalTimestamp(
    pendingAcceptance.minimumObservationEndsAt,
    "Pending minimum observation end",
  );
  return pendingAcceptance;
};

const assertFrozenEvidenceIdentity = ({
  releaseAEvidence,
  releaseAEvidenceSha256,
  pendingAcceptance,
}) => {
  const standard = pendingAcceptance.standardBinding;
  if (
    !isRecord(releaseAEvidence) ||
    releaseAEvidence.release?.releaseId !== pendingAcceptance.operationId ||
    releaseAEvidence.release?.commitSha !== standard.sourceSha ||
    releaseAEvidence.canary?.buildSha !== standard.buildId ||
    !SHA256_PATTERN.test(releaseAEvidenceSha256)
  ) {
    throw new Error(
      "Release A evidence differs from the pending standard acceptance",
    );
  }
  const startedAt = assertCanonicalTimestamp(
    releaseAEvidence.canary.startedAt,
    "Release A canary start",
  );
  const endedAt = assertCanonicalTimestamp(
    releaseAEvidence.canary.endedAt,
    "Release A canary end",
  );
  if (
    startedAt <
      assertCanonicalTimestamp(
        pendingAcceptance.observationNotBefore,
        "Pending observation not-before",
      ) ||
    endedAt <
      assertCanonicalTimestamp(
        pendingAcceptance.minimumObservationEndsAt,
        "Pending minimum observation end",
      )
  ) {
    throw new Error("Release A evidence predates the pending observation");
  }
  return { startedAt, endedAt };
};

const assertProviderPolicy = (providerPolicy, pendingAcceptance) => {
  const standard = pendingAcceptance.standardBinding;
  if (
    !isRecord(providerPolicy) ||
    providerPolicy.bindingStatus !== "configured" ||
    providerPolicy.expectedProjectId !== standard.providerProjectId ||
    !Array.isArray(providerPolicy.ownedProductionDomains) ||
    providerPolicy.ownedProductionDomains.length === 0 ||
    !Number.isSafeInteger(
      providerPolicy.observationPolicy?.maxFutureClockSkewSeconds,
    ) ||
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds < 0
  ) {
    throw new Error("Continuous probe provider policy is invalid");
  }
  const domains = [...providerPolicy.ownedProductionDomains].sort(compareUtf8);
  if (
    new Set(domains).size !== domains.length ||
    domains.some(
      (domain) =>
        typeof domain !== "string" ||
        domain.length === 0 ||
        domain !== domain.toLowerCase(),
    )
  ) {
    throw new Error("Continuous probe production domain set is invalid");
  }
  return domains;
};

const assertContinuousSamples = ({
  namespace,
  samples,
  pendingAcceptance,
  releaseAEvidence,
  providerPolicy,
  nowMilliseconds,
}) => {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error("Continuous production probe samples are incomplete");
  }
  const domains = assertProviderPolicy(providerPolicy, pendingAcceptance);
  const standard = pendingAcceptance.standardBinding;
  const { startedAt, endedAt } = assertFrozenEvidenceIdentity({
    releaseAEvidence,
    releaseAEvidenceSha256: "0".repeat(64),
    pendingAcceptance,
  });
  let previous = null;
  for (const [sampleIndex, sample] of samples.entries()) {
    assertExactKeys(
      sample,
      SAMPLE_KEYS,
      `Continuous production sample ${sampleIndex}`,
    );
    const observedAt = assertCanonicalTimestamp(
      sample.observedAt,
      `Continuous production sample ${sampleIndex} observedAt`,
    );
    assertImmutableObjectReference(
      sample.sampleEvidence,
      namespace,
      `Continuous production sample ${sampleIndex} evidence`,
    );
    assertImmutableObjectReference(
      sample.sampleChainCommit,
      namespace,
      `Continuous production sample ${sampleIndex} chain commit`,
    );
    if (
      previous !== null &&
      (observedAt <= previous ||
        observedAt - previous > CONTINUOUS_PROBE_MAXIMUM_GAP_SECONDS * 1000)
    ) {
      throw new Error(
        "Continuous production probe contains a duplicate, gap, or regression",
      );
    }
    previous = observedAt;
    if (
      !Array.isArray(sample.results) ||
      sample.results.length !== domains.length
    ) {
      throw new Error(
        "Continuous production probe does not cover every owned domain",
      );
    }
    for (const [resultIndex, result] of sample.results.entries()) {
      assertExactKeys(
        result,
        SAMPLE_RESULT_KEYS,
        `Continuous production sample ${sampleIndex} result ${resultIndex}`,
      );
      if (
        result.productionDomain !== domains[resultIndex] ||
        result.providerDeploymentId !== standard.providerDeploymentId ||
        result.status !== "PASS" ||
        !SHA256_PATTERN.test(result.responseSha256)
      ) {
        throw new Error(
          "Continuous production probe differs from the pending deployment",
        );
      }
      assertImmutableObjectReference(
        result.httpReceipt,
        namespace,
        `Continuous production sample ${sampleIndex} HTTP receipt ${resultIndex}`,
      );
      assertImmutableObjectReference(
        result.providerLookupReceipt,
        namespace,
        `Continuous production sample ${sampleIndex} provider receipt ${resultIndex}`,
      );
    }
  }
  if (
    assertCanonicalTimestamp(
      samples[0].observedAt,
      "First continuous production sample",
    ) !== startedAt ||
    assertCanonicalTimestamp(
      samples.at(-1).observedAt,
      "Last continuous production sample",
    ) !== endedAt ||
    endedAt >
      nowMilliseconds +
        providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(
      "Continuous production probe does not cover the frozen canary window",
    );
  }
  return {
    domains,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };
};

const continuousIdentity = ({
  namespace,
  pendingAcceptance,
  releaseAEvidenceSha256,
  releaseAEvidenceAuthority,
  sourceEvidenceSha256,
  sourceWorkflowAuthority,
  coverage,
  samples,
}) => {
  const standard = pendingAcceptance.standardBinding;
  return {
    schemaVersion: 1,
    evidenceKind: "continuous-production-probe/v1",
    namespace,
    operationId: pendingAcceptance.operationId,
    sourceSha: standard.sourceSha,
    buildId: standard.buildId,
    standardBindingId: standard.bindingId,
    providerProjectId: standard.providerProjectId,
    providerDeploymentId: standard.providerDeploymentId,
    assignmentValidationEvidence: structuredClone(
      pendingAcceptance.assignmentValidationEvidence,
    ),
    observationStartedEvent: structuredClone(
      pendingAcceptance.observationStartedEvent,
    ),
    releaseAEvidenceSha256,
    releaseAEvidenceAuthority: structuredClone(releaseAEvidenceAuthority),
    sourceEvidenceSha256,
    sourceWorkflowAuthority: structuredClone(sourceWorkflowAuthority),
    maximumGapSeconds: CONTINUOUS_PROBE_MAXIMUM_GAP_SECONDS,
    startedAt: coverage.startedAt,
    endedAt: coverage.endedAt,
    sampleCount: samples.length,
    ownedProductionDomains: coverage.domains,
    samples: structuredClone(samples),
  };
};

export const produceContinuousProductionProbe = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  releaseAEvidenceBytes,
  expectedReleaseAEvidenceSha256,
  sourceBytes,
  expectedSourceSha256,
  sourceWorkflowAuthority,
  approvalPolicy,
  providerPolicy,
  nowMilliseconds,
}) => {
  if (!NAMESPACE_PATTERN.test(namespace) || !Number.isFinite(nowMilliseconds)) {
    throw new Error("Continuous production probe producer options are invalid");
  }
  assertPendingAcceptance(pendingAcceptance, namespace);
  const releaseAEvidence = assertReviewedCanonicalBytes({
    bytes: releaseAEvidenceBytes,
    expectedSha256: expectedReleaseAEvidenceSha256,
    label: "Release A evidence",
  });
  const source = assertReviewedCanonicalBytes({
    bytes: sourceBytes,
    expectedSha256: expectedSourceSha256,
    label: "Continuous production probe source",
  });
  assertContinuousProbeSourceSchema(source);
  assertExactKeys(
    source,
    CONTINUOUS_SOURCE_KEYS,
    "Continuous production probe source",
  );
  if (
    source.schemaVersion !== 2 ||
    source.sourceKind !== CONTINUOUS_PROBE_SOURCE_KIND
  ) {
    throw new Error("Continuous production probe source identity is invalid");
  }
  const resolved = await resolveContinuousProbeSource({
    store,
    current,
    namespace,
    pendingAcceptance,
    providerPolicy,
    releaseAEvidence,
    releaseAEvidenceSha256: expectedReleaseAEvidenceSha256,
    source,
    maximumGapSeconds: CONTINUOUS_PROBE_MAXIMUM_GAP_SECONDS,
  });
  await readBoundReviewedWorkflowRunAuthority({
    namespace,
    repository: approvalPolicy?.repository ?? null,
    expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    reference: sourceWorkflowAuthority,
    store,
  });
  const coverage = assertContinuousSamples({
    namespace,
    samples: resolved.samples,
    pendingAcceptance,
    releaseAEvidence,
    providerPolicy,
    nowMilliseconds,
  });
  const evidence = continuousIdentity({
    namespace,
    pendingAcceptance,
    releaseAEvidenceSha256: expectedReleaseAEvidenceSha256,
    releaseAEvidenceAuthority: resolved.authorityBundle,
    sourceEvidenceSha256: expectedSourceSha256,
    sourceWorkflowAuthority,
    coverage,
    samples: resolved.samples,
  });
  assertContinuousProbeEvidenceSchema(evidence);
  const evidenceBytes = canonicalJsonBytes(evidence);
  return {
    evidence,
    evidenceBytes,
    sha256: sha256Bytes(evidenceBytes),
  };
};

export const validateContinuousProductionProbe = async ({
  store,
  current,
  bytes,
  expectedSha256,
  namespace,
  pendingAcceptance,
  releaseAEvidence,
  releaseAEvidenceSha256,
  providerPolicy,
  approvalPolicy,
  nowMilliseconds,
}) => {
  assertPendingAcceptance(pendingAcceptance, namespace);
  const evidence = assertReviewedCanonicalBytes({
    bytes,
    expectedSha256,
    label: "Continuous production probe evidence",
  });
  assertContinuousProbeEvidenceSchema(evidence);
  assertExactKeys(
    evidence,
    CONTINUOUS_EVIDENCE_KEYS,
    "Continuous production probe evidence",
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.evidenceKind !== "continuous-production-probe/v1" ||
    evidence.releaseAEvidenceSha256 !== releaseAEvidenceSha256 ||
    !SHA256_PATTERN.test(evidence.sourceEvidenceSha256)
  ) {
    throw new Error("Continuous production probe evidence identity is invalid");
  }
  await readBoundReviewedWorkflowRunAuthority({
    namespace,
    repository: approvalPolicy?.repository ?? null,
    expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    reference: evidence.sourceWorkflowAuthority,
    store,
  });
  const source = {
    schemaVersion: 2,
    sourceKind: CONTINUOUS_PROBE_SOURCE_KIND,
    authorityBundle: evidence.releaseAEvidenceAuthority,
    sampleChainHead: evidence.samples?.at(-1)?.sampleChainCommit,
  };
  if (
    sha256Bytes(canonicalJsonBytes(source)) !== evidence.sourceEvidenceSha256
  ) {
    throw new Error("Continuous production probe source authority differs");
  }
  const resolved = await resolveContinuousProbeSource({
    store,
    current,
    namespace,
    pendingAcceptance,
    providerPolicy,
    releaseAEvidence,
    releaseAEvidenceSha256,
    source,
    maximumGapSeconds: CONTINUOUS_PROBE_MAXIMUM_GAP_SECONDS,
  });
  const coverage = assertContinuousSamples({
    namespace,
    samples: resolved.samples,
    pendingAcceptance,
    releaseAEvidence,
    providerPolicy,
    nowMilliseconds,
  });
  const expected = continuousIdentity({
    namespace,
    pendingAcceptance,
    releaseAEvidenceSha256,
    releaseAEvidenceAuthority: resolved.authorityBundle,
    sourceEvidenceSha256: evidence.sourceEvidenceSha256,
    sourceWorkflowAuthority: evidence.sourceWorkflowAuthority,
    coverage,
    samples: resolved.samples,
  });
  if (!sameCanonicalValue(evidence, expected)) {
    throw new Error("Continuous production probe identity or coverage differs");
  }
  return evidence;
};

const recoveryCompanionIdentity = (binding) => ({
  bindingId: binding.bindingId,
  sourceSha: binding.sourceSha,
  buildId: binding.buildId,
  variantId: binding.variantId,
  providerProjectId: binding.providerProjectId,
  providerDeploymentId: binding.providerDeploymentId,
  packageIndexSha256: binding.packageIndex.sha256,
  artifactManifestSha256: binding.artifactManifest.sha256,
  providerEvidenceSha256: binding.providerEvidence.sha256,
});

const assertRecoverySource = ({
  namespace,
  source,
  pendingAcceptance,
  releaseAEvidence,
  nowMilliseconds,
  futureClockSkewSeconds,
}) => {
  assertExactKeys(
    source,
    RECOVERY_RESOLVED_KEYS,
    "Companion recovery drill source",
  );
  if (
    source.status !== "PASS" ||
    source.command !== "npm run test:release-a-rollback"
  ) {
    throw new Error("Companion recovery drill source identity is invalid");
  }
  assertImmutableObjectReference(
    source.authorityBundle,
    namespace,
    "Release A authority bundle",
  );
  assertExactKeys(
    source.companion,
    RECOVERY_COMPANION_KEYS,
    "Companion recovery drill binding",
  );
  if (
    !sameCanonicalValue(
      source.companion,
      recoveryCompanionIdentity(pendingAcceptance.companionBinding),
    )
  ) {
    throw new Error(
      "Companion recovery drill differs from the pending companion",
    );
  }
  const startedAt = assertCanonicalTimestamp(
    source.startedAt,
    "Companion recovery drill start",
  );
  const completedAt = assertCanonicalTimestamp(
    source.completedAt,
    "Companion recovery drill completion",
  );
  if (
    completedAt < startedAt ||
    completedAt > nowMilliseconds + futureClockSkewSeconds * 1000
  ) {
    throw new Error("Companion recovery drill time is invalid");
  }
  assertEvidenceReferenceText(
    source.drillEvidenceRef,
    "Companion recovery drill evidence reference",
  );
  if (
    !Array.isArray(source.steps) ||
    source.steps.length !== COMPANION_RECOVERY_STEPS.length
  ) {
    throw new Error("Companion recovery drill steps are incomplete");
  }
  const stepReferences = new Set();
  for (const [index, step] of source.steps.entries()) {
    assertExactKeys(
      step,
      RECOVERY_STEP_KEYS,
      `Companion recovery drill step ${index}`,
    );
    assertEvidenceReferenceText(
      step.evidenceRef,
      `Companion recovery drill step ${index} evidence reference`,
    );
    if (
      step.step !== COMPANION_RECOVERY_STEPS[index] ||
      step.status !== "PASS" ||
      stepReferences.has(step.evidenceRef)
    ) {
      throw new Error(
        "Companion recovery drill step order, status, or reference is invalid",
      );
    }
    stepReferences.add(step.evidenceRef);
  }
  const rollback = releaseAEvidence.automatedGates?.rollback;
  if (
    rollback?.status !== "PASS" ||
    rollback.command !== source.command ||
    rollback.commitSha !== pendingAcceptance.standardBinding.sourceSha ||
    rollback.completedAt !== source.completedAt ||
    source.drillEvidenceRef !== source.steps?.[0]?.evidenceRef
  ) {
    throw new Error(
      "Companion recovery drill differs from frozen rollback evidence",
    );
  }
};

const recoveryIdentity = ({
  namespace,
  pendingAcceptance,
  releaseAEvidenceSha256,
  sourceEvidenceSha256,
  sourceWorkflowAuthority,
  source,
}) => ({
  schemaVersion: 1,
  evidenceKind: "companion-recovery-drill/v1",
  namespace,
  operationId: pendingAcceptance.operationId,
  sourceSha: pendingAcceptance.standardBinding.sourceSha,
  buildId: pendingAcceptance.standardBinding.buildId,
  releasePolicy: structuredClone(
    pendingAcceptance.standardBinding.releasePolicy,
  ),
  releaseAEvidenceSha256,
  releaseAEvidenceAuthority: structuredClone(source.authorityBundle),
  sourceEvidenceSha256,
  sourceWorkflowAuthority: structuredClone(sourceWorkflowAuthority),
  status: source.status,
  command: source.command,
  startedAt: source.startedAt,
  completedAt: source.completedAt,
  drillEvidenceRef: source.drillEvidenceRef,
  companion: structuredClone(source.companion),
  steps: structuredClone(source.steps),
});

export const produceCompanionRecoveryDrill = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  releaseAEvidenceBytes,
  expectedReleaseAEvidenceSha256,
  sourceBytes,
  expectedSourceSha256,
  sourceWorkflowAuthority,
  approvalPolicy,
  nowMilliseconds,
  futureClockSkewSeconds,
  providerPolicy,
}) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !Number.isFinite(nowMilliseconds) ||
    !Number.isSafeInteger(futureClockSkewSeconds) ||
    futureClockSkewSeconds < 0
  ) {
    throw new Error("Companion recovery drill producer options are invalid");
  }
  assertPendingAcceptance(pendingAcceptance, namespace);
  const releaseAEvidence = assertReviewedCanonicalBytes({
    bytes: releaseAEvidenceBytes,
    expectedSha256: expectedReleaseAEvidenceSha256,
    label: "Release A evidence",
  });
  assertFrozenEvidenceIdentity({
    releaseAEvidence,
    releaseAEvidenceSha256: expectedReleaseAEvidenceSha256,
    pendingAcceptance,
  });
  const source = assertReviewedCanonicalBytes({
    bytes: sourceBytes,
    expectedSha256: expectedSourceSha256,
    label: "Companion recovery drill source",
  });
  assertCompanionRecoverySourceSchema(source);
  assertExactKeys(source, RECOVERY_SOURCE_KEYS, "Companion recovery source");
  if (
    source.schemaVersion !== 2 ||
    source.sourceKind !== COMPANION_RECOVERY_SOURCE_KIND
  ) {
    throw new Error("Companion recovery source identity is invalid");
  }
  const resolved = await resolveCompanionRecoverySource({
    store,
    current,
    namespace,
    pendingAcceptance,
    providerPolicy,
    releaseAEvidence,
    releaseAEvidenceSha256: expectedReleaseAEvidenceSha256,
    source,
    nowMilliseconds,
    futureClockSkewSeconds,
  });
  await readBoundReviewedWorkflowRunAuthority({
    namespace,
    repository: approvalPolicy?.repository ?? null,
    expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    reference: sourceWorkflowAuthority,
    store,
  });
  assertRecoverySource({
    namespace,
    source: resolved,
    pendingAcceptance,
    releaseAEvidence,
    nowMilliseconds,
    futureClockSkewSeconds,
  });
  const evidence = recoveryIdentity({
    namespace,
    pendingAcceptance,
    releaseAEvidenceSha256: expectedReleaseAEvidenceSha256,
    sourceEvidenceSha256: expectedSourceSha256,
    sourceWorkflowAuthority,
    source: resolved,
  });
  assertCompanionRecoveryEvidenceSchema(evidence);
  const evidenceBytes = canonicalJsonBytes(evidence);
  return {
    evidence,
    evidenceBytes,
    sha256: sha256Bytes(evidenceBytes),
  };
};

const eventReferenceFromUri = ({ uri, namespace, label }) => {
  if (typeof uri !== "string") {
    throw new Error(`${label} is invalid`);
  }
  const match = uri.match(
    new RegExp(
      `^release-state://${namespace}/events/[1-9][0-9]*/([0-9a-f]{64})$`,
    ),
  );
  if (!match) {
    throw new Error(`${label} is not a Release State event reference`);
  }
  return { uri, sha256: match[1] };
};

export const validateCompanionRecoveryDrill = async ({
  store,
  current,
  bytes,
  expectedSha256,
  namespace,
  pendingAcceptance,
  releaseAEvidence,
  releaseAEvidenceSha256,
  nowMilliseconds,
  futureClockSkewSeconds,
  providerPolicy,
  approvalPolicy,
}) => {
  assertPendingAcceptance(pendingAcceptance, namespace);
  const evidence = assertReviewedCanonicalBytes({
    bytes,
    expectedSha256,
    label: "Companion recovery drill evidence",
  });
  assertCompanionRecoveryEvidenceSchema(evidence);
  assertExactKeys(
    evidence,
    RECOVERY_EVIDENCE_KEYS,
    "Companion recovery drill evidence",
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.evidenceKind !== "companion-recovery-drill/v1" ||
    !SHA256_PATTERN.test(evidence.sourceEvidenceSha256) ||
    evidence.releaseAEvidenceSha256 !== releaseAEvidenceSha256
  ) {
    throw new Error("Companion recovery drill evidence identity is invalid");
  }
  await readBoundReviewedWorkflowRunAuthority({
    namespace,
    repository: approvalPolicy?.repository ?? null,
    expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    reference: evidence.sourceWorkflowAuthority,
    store,
  });
  const source = {
    schemaVersion: 2,
    sourceKind: COMPANION_RECOVERY_SOURCE_KIND,
    authorityBundle: evidence.releaseAEvidenceAuthority,
    packageRedeployTerminalEvent: eventReferenceFromUri({
      uri: evidence.steps?.[0]?.evidenceRef,
      namespace,
      label: "Companion package-redeploy terminal",
    }),
    standardReturnEvent: eventReferenceFromUri({
      uri: evidence.steps?.[2]?.evidenceRef,
      namespace,
      label: "Companion standard-return event",
    }),
  };
  if (
    sha256Bytes(canonicalJsonBytes(source)) !== evidence.sourceEvidenceSha256
  ) {
    throw new Error("Companion recovery source authority differs");
  }
  const resolved = await resolveCompanionRecoverySource({
    store,
    current,
    namespace,
    pendingAcceptance,
    providerPolicy,
    releaseAEvidence,
    releaseAEvidenceSha256,
    source,
    nowMilliseconds,
    futureClockSkewSeconds,
  });
  assertRecoverySource({
    namespace,
    source: resolved,
    pendingAcceptance,
    releaseAEvidence,
    nowMilliseconds,
    futureClockSkewSeconds,
  });
  const expected = recoveryIdentity({
    namespace,
    pendingAcceptance,
    releaseAEvidenceSha256,
    sourceEvidenceSha256: evidence.sourceEvidenceSha256,
    sourceWorkflowAuthority: evidence.sourceWorkflowAuthority,
    source: resolved,
  });
  if (!sameCanonicalValue(evidence, expected)) {
    throw new Error("Companion recovery drill evidence differs");
  }
  return evidence;
};
