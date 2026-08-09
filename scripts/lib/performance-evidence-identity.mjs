import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

export const ACCEPTANCE_PERFORMANCE_REQUIREMENTS = Object.freeze({
  "P0-BASELINE": null,
  "P0-TOOLCHAIN": null,
  "P0-ARTIFACT": null,
  "P0-DATA": null,
  "P0-PROMOTE": null,
  "P0-RELEASE": "P0-TOOLCHAIN",
  "P1-PWA": null,
  "P2A-LOCAL": null,
  "P2B-REPORT": null,
  "P3-XLSX": "P3-XLSX",
  "P4-CSP": null,
  "P5-DUAL": "P5-DUAL",
  "P5-LIST": "P5-LIST",
  "P6-APP": null,
  "P7-IDB": null,
  "P8-CLEAN": "performance-inherited-closure/v1",
});

const parseCanonicalFileBytes = (bytes, label) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error(`${label} bytes are invalid`);
  }
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  const canonical = canonicalJsonBytes(value);
  const canonicalWithLf = Buffer.concat([canonical, Buffer.from("\n", "utf8")]);
  if (!bytes.equals(canonical) && !bytes.equals(canonicalWithLf)) {
    throw new Error(`${label} must use canonical JSON bytes`);
  }
  return value;
};

const assertOwnGateProducerReceipt = (value, label) => {
  const producerReceipt = value.producerReceipt;
  if (
    !hasExactKeys(producerReceipt, [
      "schemaVersion",
      "receipt",
      "receiptSha256",
    ]) ||
    producerReceipt.schemaVersion !== 1 ||
    !SHA256_PATTERN.test(producerReceipt.receiptSha256 ?? "") ||
    sha256Json(producerReceipt.receipt) !== producerReceipt.receiptSha256
  ) {
    throw new Error(`${label} producer receipt identity is invalid`);
  }
  const receipt = producerReceipt.receipt;
  if (
    !hasExactKeys(receipt, [
      "kind",
      "namespace",
      "operationId",
      "acceptedGate",
      "performanceGate",
      "source",
      "authoritativeState",
      "requirementsSha256",
      "artifactArchiveSha256",
      "rawSamplesArtifact",
      "producerRunId",
      "performanceEvidence",
      "producedAtUtc",
    ]) ||
    !hasExactKeys(receipt.source, [
      "gitCommitSha",
      "sourceClosureSha256",
      "treeState",
    ]) ||
    !hasExactKeys(receipt.authoritativeState, ["sequence", "eventHash"]) ||
    !hasExactKeys(receipt.rawSamplesArtifact, [
      "name",
      "runId",
      "sha256",
      "collectorIdentity",
      "workflowRunAuthority",
    ]) ||
    !hasExactKeys(receipt.rawSamplesArtifact.collectorIdentity, [
      "sha256",
      "uri",
    ]) ||
    !hasExactKeys(receipt.rawSamplesArtifact.workflowRunAuthority, [
      "sha256",
      "uri",
    ]) ||
    !hasExactKeys(receipt.performanceEvidence, [
      "name",
      "envelopeSha256",
      "evidenceSha256",
    ])
  ) {
    throw new Error(`${label} producer receipt schema is not closed`);
  }
  const requirement = ACCEPTANCE_PERFORMANCE_REQUIREMENTS[receipt.acceptedGate];
  const envelope = {
    schemaVersion: value.schemaVersion,
    evidence: value.evidence,
    evidenceSha256: value.evidenceSha256,
  };
  if (
    receipt.kind !== "own-gate-performance-evidence-producer-receipt/v1" ||
    typeof receipt.namespace !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(receipt.namespace) ||
    typeof receipt.operationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.operationId) ||
    typeof requirement !== "string" ||
    requirement === "performance-inherited-closure/v1" ||
    receipt.performanceGate !== requirement ||
    value.evidence.gate !== requirement ||
    !SOURCE_SHA_PATTERN.test(receipt.source.gitCommitSha ?? "") ||
    !SHA256_PATTERN.test(receipt.source.sourceClosureSha256 ?? "") ||
    receipt.source.treeState !== "clean" ||
    receipt.source.gitCommitSha !== value.evidence.source?.gitCommitSha ||
    receipt.source.sourceClosureSha256 !==
      value.evidence.source?.sourceClosureSha256 ||
    value.evidence.source?.treeState !== "clean" ||
    !Number.isSafeInteger(receipt.authoritativeState.sequence) ||
    receipt.authoritativeState.sequence < 1 ||
    !SHA256_PATTERN.test(receipt.authoritativeState.eventHash ?? "") ||
    !SHA256_PATTERN.test(receipt.requirementsSha256 ?? "") ||
    !SHA256_PATTERN.test(receipt.artifactArchiveSha256 ?? "") ||
    receipt.artifactArchiveSha256 !== value.evidence.source?.artifactSha256 ||
    receipt.rawSamplesArtifact.name !==
      `foundation-performance-raw-samples-${receipt.source.gitCommitSha}` ||
    !RUN_ID_PATTERN.test(receipt.rawSamplesArtifact.runId ?? "") ||
    !SHA256_PATTERN.test(receipt.rawSamplesArtifact.sha256 ?? "") ||
    [
      receipt.rawSamplesArtifact.collectorIdentity,
      receipt.rawSamplesArtifact.workflowRunAuthority,
    ].some(
      (reference) =>
        !SHA256_PATTERN.test(reference.sha256 ?? "") ||
        reference.uri !==
          `release-state://${receipt.namespace}/evidence/${reference.sha256}`,
    ) ||
    !RUN_ID_PATTERN.test(receipt.producerRunId ?? "") ||
    BigInt(receipt.rawSamplesArtifact.runId) >= BigInt(receipt.producerRunId) ||
    receipt.performanceEvidence.name !==
      `foundation-performance-own-gate-evidence-${receipt.source.gitCommitSha}` ||
    receipt.performanceEvidence.envelopeSha256 !==
      sha256Bytes(canonicalJsonBytes(envelope)) ||
    receipt.performanceEvidence.evidenceSha256 !== value.evidenceSha256 ||
    !Number.isFinite(Date.parse(receipt.producedAtUtc ?? "")) ||
    new Date(Date.parse(receipt.producedAtUtc ?? "")).toISOString() !==
      receipt.producedAtUtc ||
    Date.parse(receipt.producedAtUtc) <
      Date.parse(value.evidence.collectedAtUtc ?? "")
  ) {
    throw new Error(`${label} producer receipt binding is invalid`);
  }
  return producerReceipt;
};

const assertPerformanceArtifactIdentity = (
  value,
  label = "Performance evidence artifact",
) => {
  if (
    hasExactKeys(value, [
      "schemaVersion",
      "evidence",
      "evidenceSha256",
      "producerReceipt",
    ]) &&
    value.schemaVersion === 1 &&
    isRecord(value.evidence) &&
    SHA256_PATTERN.test(value.evidenceSha256 ?? "") &&
    sha256Json(value.evidence) === value.evidenceSha256
  ) {
    assertOwnGateProducerReceipt(value, label);
    return { artifactKind: "own-gate-performance-evidence/v1", value };
  }
  if (
    hasExactKeys(value, ["schemaVersion", "closure", "closureSha256"]) &&
    value.schemaVersion === 1 &&
    isRecord(value.closure) &&
    value.closure.kind === "performance-inherited-closure/v1" &&
    SHA256_PATTERN.test(value.closureSha256 ?? "") &&
    sha256Json(value.closure) === value.closureSha256
  ) {
    return { artifactKind: "performance-inherited-closure/v1", value };
  }
  throw new Error(`${label} identity or content SHA-256 is invalid`);
};

export const projectOwnGatePerformanceEnvelope = (value) => {
  const artifact = assertPerformanceArtifactIdentity(value);
  if (artifact.artifactKind !== "own-gate-performance-evidence/v1") {
    throw new Error("Performance artifact is not own-gate evidence");
  }
  return {
    schemaVersion: value.schemaVersion,
    evidence: structuredClone(value.evidence),
    evidenceSha256: value.evidenceSha256,
  };
};

export const assertPerformanceArtifactValueForAcceptedGate = ({
  acceptedGate,
  value,
  label = "Performance evidence artifact",
}) => {
  if (!Object.hasOwn(ACCEPTANCE_PERFORMANCE_REQUIREMENTS, acceptedGate)) {
    throw new Error(`${label} accepted gate is unknown`);
  }
  const requirement = ACCEPTANCE_PERFORMANCE_REQUIREMENTS[acceptedGate];
  if (requirement === null) {
    if (value !== null) {
      throw new Error(
        `${label} is forbidden for accepted gate ${acceptedGate}`,
      );
    }
    return { artifactKind: null, value: null };
  }
  if (value === null) {
    throw new Error(`${label} is required for accepted gate ${acceptedGate}`);
  }
  const artifact = assertPerformanceArtifactIdentity(value, label);
  if (
    requirement === "performance-inherited-closure/v1"
      ? artifact.artifactKind !== requirement
      : artifact.artifactKind !== "own-gate-performance-evidence/v1" ||
        artifact.value.evidence.gate !== requirement
  ) {
    throw new Error(`${label} kind or gate differs from ${acceptedGate}`);
  }
  return artifact;
};

export const assertReviewedPerformanceArtifact = ({
  bytes,
  expectedSha256,
  label = "Performance evidence artifact",
}) => {
  if (
    !Buffer.isBuffer(bytes) ||
    !SHA256_PATTERN.test(expectedSha256 ?? "") ||
    sha256Bytes(bytes) !== expectedSha256
  ) {
    throw new Error(`${label} differs from its reviewed SHA-256`);
  }
  return assertPerformanceArtifactIdentity(
    parseCanonicalFileBytes(bytes, label),
    label,
  );
};

export const assertReviewedPerformanceArtifactForAcceptedGate = ({
  acceptedGate,
  bytes,
  expectedSha256,
  label = "Performance evidence artifact",
}) => {
  if (bytes === null || expectedSha256 === null) {
    if (bytes !== null || expectedSha256 !== null) {
      throw new Error(`${label} bytes and reviewed SHA-256 must both be null`);
    }
    return assertPerformanceArtifactValueForAcceptedGate({
      acceptedGate,
      value: null,
      label,
    });
  }
  const artifact = assertReviewedPerformanceArtifact({
    bytes,
    expectedSha256,
    label,
  });
  return assertPerformanceArtifactValueForAcceptedGate({
    acceptedGate,
    value: artifact.value,
    label,
  });
};
