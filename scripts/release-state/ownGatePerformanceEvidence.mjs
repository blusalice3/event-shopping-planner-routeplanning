import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { buildPerformanceEvidenceEnvelope } from "../lib/performance-evidence-builder.mjs";
import {
  ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
  assertPerformanceArtifactValueForAcceptedGate,
  projectOwnGatePerformanceEnvelope,
} from "../lib/performance-evidence-identity.mjs";
import { verifyPerformanceGate } from "../verify-performance-policy.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertExactKeys,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";
import { RELEASE_PHASE_GATES } from "./phaseGates.mjs";

const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/;
const OWN_GATE_ARTIFACT_KIND = "own-gate-performance-evidence/v1";
const PRODUCER_RECEIPT_KIND =
  "own-gate-performance-evidence-producer-receipt/v1";
const OWN_GATE_PERFORMANCE_GATES = new Set(
  Object.values(ACCEPTANCE_PERFORMANCE_REQUIREMENTS).filter(
    (requirement) =>
      typeof requirement === "string" &&
      requirement !== "performance-inherited-closure/v1",
  ),
);

const parseCanonicalRawSamples = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("Reviewed raw performance samples bytes are invalid");
  }
  const value = parseJsonStrict(
    bytes.toString("utf8"),
    "Raw performance samples",
  );
  const canonicalBytes = canonicalJsonBytes(value);
  const canonicalBytesWithLf = Buffer.concat([
    canonicalBytes,
    Buffer.from("\n", "utf8"),
  ]);
  if (!bytes.equals(canonicalBytes) && !bytes.equals(canonicalBytesWithLf)) {
    throw new Error("Raw performance samples must use canonical JSON bytes");
  }
  return value;
};

const assertStateHead = (head) => {
  assertExactKeys(head, ["sequence", "eventHash"], "Acceptance state head");
  if (
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    !SHA256_PATTERN.test(head.eventHash ?? "")
  ) {
    throw new Error("Acceptance state head is invalid");
  }
};

export const assertAuthoritativeOwnGatePerformanceRequirements = ({
  requirements,
  expectedNamespace,
  expectedSourceSha,
}) => {
  assertExactKeys(
    requirements,
    [
      "schemaVersion",
      "requirementKind",
      "namespace",
      "operationId",
      "sourceSha",
      "expectedArtifactSha256",
      "expectedState",
      "acceptedGate",
      "performanceEvidenceKind",
      "performanceGate",
    ],
    "Authoritative acceptance requirements",
  );
  assertStateHead(requirements.expectedState);
  if (
    requirements.schemaVersion !== 1 ||
    requirements.requirementKind !== "standard-acceptance-requirements/v1" ||
    !NAMESPACE_PATTERN.test(requirements.namespace ?? "") ||
    requirements.namespace !== expectedNamespace ||
    !OPERATION_ID_PATTERN.test(requirements.operationId ?? "") ||
    !SOURCE_SHA_PATTERN.test(requirements.sourceSha ?? "") ||
    requirements.sourceSha !== expectedSourceSha ||
    !SHA256_PATTERN.test(requirements.expectedArtifactSha256 ?? "") ||
    !Object.hasOwn(
      ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
      requirements.acceptedGate,
    ) ||
    !RELEASE_PHASE_GATES.includes(requirements.acceptedGate)
  ) {
    throw new Error(
      "Authoritative acceptance requirements identity is invalid",
    );
  }
  const performanceGate =
    ACCEPTANCE_PERFORMANCE_REQUIREMENTS[requirements.acceptedGate];
  if (
    requirements.performanceEvidenceKind !== OWN_GATE_ARTIFACT_KIND ||
    typeof performanceGate !== "string" ||
    performanceGate === "performance-inherited-closure/v1" ||
    requirements.performanceGate !== performanceGate
  ) {
    throw new Error(
      `Accepted gate ${requirements.acceptedGate} does not require own-gate performance evidence`,
    );
  }
  return requirements;
};

export const ownGateRawSamplesArtifactName = (sourceSha, runAttempt) => {
  if (
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(runAttempt ?? "")
  ) {
    throw new Error("Own-gate raw samples artifact source SHA is invalid");
  }
  return `foundation-performance-raw-samples-${sourceSha}-${runAttempt}`;
};

export const ownGateRawSamplesEvidenceId = ({ performanceGate, runId }) => {
  if (
    typeof performanceGate !== "string" ||
    !OWN_GATE_PERFORMANCE_GATES.has(performanceGate) ||
    !RUN_ID_PATTERN.test(runId ?? "")
  ) {
    throw new Error("Own-gate raw performance collection identity is invalid");
  }
  return `perf-own-gate-${performanceGate.toLowerCase()}-${runId}`;
};

export const ownGatePerformanceEvidenceArtifactName = (
  sourceSha,
  runAttempt,
) => {
  if (
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(runAttempt ?? "")
  ) {
    throw new Error(
      "Own-gate performance evidence artifact source SHA is invalid",
    );
  }
  return `foundation-performance-own-gate-evidence-${sourceSha}-${runAttempt}`;
};

export const produceAuthoritativeOwnGatePerformanceEvidence = async (
  {
    requirements,
    rawSamplesBytes,
    expectedRawSamplesSha256,
    rawSamplesRunId,
    rawSamplesRunAttempt,
    currentRunId,
    currentRunAttempt,
    sourceState,
    context,
    producedAtUtc,
    collectorAuthority,
  },
  {
    buildEnvelope = buildPerformanceEvidenceEnvelope,
    verifyGate = verifyPerformanceGate,
  } = {},
) => {
  if (
    !RUN_ID_PATTERN.test(rawSamplesRunId ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(rawSamplesRunAttempt ?? "") ||
    !RUN_ID_PATTERN.test(currentRunId ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(currentRunAttempt ?? "") ||
    rawSamplesRunId === currentRunId
  ) {
    throw new Error(
      "Raw performance samples must come from a distinct prior workflow run",
    );
  }
  if (
    !SHA256_PATTERN.test(expectedRawSamplesSha256 ?? "") ||
    sha256Bytes(rawSamplesBytes) !== expectedRawSamplesSha256
  ) {
    throw new Error(
      "Raw performance samples differ from their reviewed SHA-256",
    );
  }
  assertExactKeys(
    collectorAuthority,
    ["collectorIdentity", "workflowRunAuthority"],
    "Raw performance collector authority",
  );
  for (const [label, reference] of [
    ["collector identity", collectorAuthority.collectorIdentity],
    ["workflow run authority", collectorAuthority.workflowRunAuthority],
  ]) {
    assertExactKeys(reference, ["sha256", "uri"], `Raw performance ${label}`);
    if (
      !SHA256_PATTERN.test(reference.sha256 ?? "") ||
      reference.uri !==
        `release-state://${requirements.namespace}/evidence/${reference.sha256}`
    ) {
      throw new Error(`Raw performance ${label} reference is invalid`);
    }
  }
  assertExactKeys(
    sourceState,
    ["gitCommitSha", "sourceClosureSha256", "treeState"],
    "Clean source state",
  );
  if (
    !SOURCE_SHA_PATTERN.test(sourceState.gitCommitSha ?? "") ||
    !SHA256_PATTERN.test(sourceState.sourceClosureSha256 ?? "") ||
    sourceState.treeState !== "clean"
  ) {
    throw new Error("Own-gate performance producer source is not clean");
  }
  assertAuthoritativeOwnGatePerformanceRequirements({
    requirements,
    expectedNamespace: requirements?.namespace,
    expectedSourceSha: sourceState.gitCommitSha,
  });
  if (
    typeof producedAtUtc !== "string" ||
    !Number.isFinite(Date.parse(producedAtUtc)) ||
    new Date(Date.parse(producedAtUtc)).toISOString() !== producedAtUtc
  ) {
    throw new Error("Own-gate performance producer timestamp is invalid");
  }

  const rawArtifact = parseCanonicalRawSamples(rawSamplesBytes);
  assertExactKeys(
    rawArtifact,
    ["artifactKind", "collectorIdentity", "samples", "schemaVersion"],
    "Protected raw performance artifact",
  );
  if (
    rawArtifact.schemaVersion !== 1 ||
    rawArtifact.artifactKind !== "protected-own-gate-performance-raw/v1" ||
    !sameCanonicalValue(
      rawArtifact.collectorIdentity,
      collectorAuthority.collectorIdentity,
    )
  ) {
    throw new Error("Protected raw performance artifact authority differs");
  }
  const rawSamples = rawArtifact.samples;
  if (
    rawSamples.evidenceId !==
      ownGateRawSamplesEvidenceId({
        performanceGate: requirements.performanceGate,
        runId: rawSamplesRunId,
      }) ||
    rawSamples.gate !== requirements.performanceGate ||
    rawSamples.source?.gitCommitSha !== requirements.sourceSha ||
    rawSamples.source?.sourceClosureSha256 !==
      sourceState.sourceClosureSha256 ||
    rawSamples.source?.treeState !== "clean"
  ) {
    throw new Error(
      "Raw performance samples differ from the authoritative gate or clean source",
    );
  }
  if (
    !Number.isFinite(Date.parse(rawSamples.collectedAtUtc ?? "")) ||
    Date.parse(rawSamples.collectedAtUtc) > Date.parse(producedAtUtc)
  ) {
    throw new Error(
      "Raw performance samples were collected after the producer timestamp",
    );
  }

  if (
    rawSamples.source?.artifactSha256 !== requirements.expectedArtifactSha256
  ) {
    throw new Error(
      "Raw performance samples differ from the authoritative artifact archive",
    );
  }
  const envelope = buildEnvelope({ context, input: rawSamples });
  const verification = await verifyGate({
    context,
    gate: requirements.performanceGate,
    evidence: envelope,
  });
  if (!verification || !Array.isArray(verification.errors)) {
    throw new Error("Performance gate verifier returned an invalid result");
  }
  if (verification.errors.length > 0) {
    throw new Error(
      `Produced own-gate performance evidence is invalid:\n${verification.errors.join("\n")}`,
    );
  }

  const envelopeBytes = canonicalJsonBytes(envelope);
  const receiptBody = {
    kind: PRODUCER_RECEIPT_KIND,
    namespace: requirements.namespace,
    operationId: requirements.operationId,
    acceptedGate: requirements.acceptedGate,
    performanceGate: requirements.performanceGate,
    source: structuredClone(sourceState),
    authoritativeState: structuredClone(requirements.expectedState),
    requirementsSha256: sha256Json(requirements),
    artifactArchiveSha256: requirements.expectedArtifactSha256,
    rawSamplesArtifact: {
      name: ownGateRawSamplesArtifactName(
        requirements.sourceSha,
        rawSamplesRunAttempt,
      ),
      runId: rawSamplesRunId,
      runAttempt: rawSamplesRunAttempt,
      sha256: expectedRawSamplesSha256,
      collectorIdentity: structuredClone(collectorAuthority.collectorIdentity),
      workflowRunAuthority: structuredClone(
        collectorAuthority.workflowRunAuthority,
      ),
    },
    producerRunId: currentRunId,
    producerRunAttempt: currentRunAttempt,
    performanceEvidence: {
      name: ownGatePerformanceEvidenceArtifactName(
        requirements.sourceSha,
        currentRunAttempt,
      ),
      envelopeSha256: sha256Bytes(envelopeBytes),
      evidenceSha256: envelope.evidenceSha256,
    },
    producedAtUtc,
  };
  const receipt = {
    schemaVersion: 1,
    receipt: receiptBody,
    receiptSha256: sha256Json(receiptBody),
  };
  const artifactValue = {
    ...envelope,
    producerReceipt: receipt,
  };
  const artifact = assertPerformanceArtifactValueForAcceptedGate({
    acceptedGate: requirements.acceptedGate,
    value: artifactValue,
    label: "Produced own-gate performance evidence",
  });
  if (artifact.artifactKind !== OWN_GATE_ARTIFACT_KIND) {
    throw new Error("Produced performance artifact is not own-gate evidence");
  }
  const evidenceBytes = canonicalJsonBytes(artifactValue);
  return {
    envelope: artifactValue,
    evidenceBytes,
    receipt,
    receiptBytes: canonicalJsonBytes(receipt),
  };
};

export const assertOwnGatePerformanceProducerReceiptAuthority = ({
  artifactValue,
  requirements,
  expectedNamespace,
  expectedSourceSha,
  acceptanceRunId = null,
}) => {
  assertAuthoritativeOwnGatePerformanceRequirements({
    requirements,
    expectedNamespace,
    expectedSourceSha,
  });
  const baseEnvelope = projectOwnGatePerformanceEnvelope(artifactValue);
  const receipt = artifactValue.producerReceipt.receipt;
  if (
    receipt.namespace !== requirements.namespace ||
    receipt.operationId !== requirements.operationId ||
    receipt.acceptedGate !== requirements.acceptedGate ||
    receipt.performanceGate !== requirements.performanceGate ||
    !sameCanonicalValue(
      receipt.authoritativeState,
      requirements.expectedState,
    ) ||
    receipt.requirementsSha256 !== sha256Json(requirements) ||
    receipt.artifactArchiveSha256 !== requirements.expectedArtifactSha256 ||
    baseEnvelope.evidence.source?.artifactSha256 !==
      requirements.expectedArtifactSha256
  ) {
    throw new Error(
      "Own-gate performance producer receipt differs from authoritative acceptance requirements",
    );
  }
  if (
    acceptanceRunId !== null &&
    (!RUN_ID_PATTERN.test(acceptanceRunId) ||
      BigInt(receipt.producerRunId) >= BigInt(acceptanceRunId))
  ) {
    throw new Error(
      "Own-gate performance evidence must come from a prior producer run",
    );
  }
  return receipt;
};

export const assertUnchangedOwnGatePerformanceRequirements = ({
  before,
  after,
}) => {
  if (!sameCanonicalValue(before, after)) {
    throw new Error(
      "Authoritative acceptance requirements changed during performance evidence production",
    );
  }
};
