import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  PERFORMANCE_SAMPLE_COUNT,
  PERFORMANCE_WARMUP_COUNT,
  REQUIRED_PERFORMANCE_VARIANTS,
} from "../performance/canonicalScenarioDispatch.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  assertAuthoritativeOwnGatePerformanceRequirements,
  assertUnchangedOwnGatePerformanceRequirements,
  ownGateRawSamplesEvidenceId,
} from "./ownGatePerformanceEvidence.mjs";
import {
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

const ARTIFACT_MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";
const COLLECTION_AUTHORITY_KIND =
  "own-gate-performance-collection-authority/v1";
export const PROTECTED_RAW_PERFORMANCE_ARTIFACT_KIND =
  "protected-own-gate-performance-raw/v1";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const assertCleanSourceState = (sourceState) => {
  assertExactKeys(
    sourceState,
    ["gitCommitSha", "sourceClosureSha256", "treeState"],
    "Performance collection clean source",
  );
  if (
    !SOURCE_SHA_PATTERN.test(sourceState.gitCommitSha ?? "") ||
    !SHA256_PATTERN.test(sourceState.sourceClosureSha256 ?? "") ||
    sourceState.treeState !== "clean"
  ) {
    throw new Error("Performance collection source is not clean");
  }
  return sourceState;
};

export const deriveReviewedPerformanceEnvironment = (context) => {
  if (!context || !Array.isArray(context.errors) || context.errors.length > 0) {
    throw new Error("Performance collection policy is invalid");
  }
  const machineProfile = context.budgets?.machineProfile;
  const browser = context.budgets?.browser;
  assertExactKeys(
    machineProfile,
    ["status", "os", "cpu", "memoryBytes", "powerMode"],
    "Reviewed performance machine profile",
  );
  assertExactKeys(
    browser,
    ["family", "version", "channel"],
    "Reviewed performance browser",
  );
  if (
    machineProfile.status !== "bound" ||
    ![machineProfile.os, machineProfile.cpu, machineProfile.powerMode].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Number.isSafeInteger(machineProfile.memoryBytes) ||
    machineProfile.memoryBytes <= 0 ||
    browser.family !== "chromium" ||
    ![browser.version, browser.channel].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    throw new Error(
      "Reviewed physical machine and Chromium binding is incomplete",
    );
  }
  return {
    machineProfile: {
      os: machineProfile.os,
      cpu: machineProfile.cpu,
      memoryBytes: machineProfile.memoryBytes,
      powerMode: machineProfile.powerMode,
    },
    browser: structuredClone(browser),
  };
};

const resolveOwnScenarioIds = ({ context, performanceGate }) => {
  const requirement = context.gateMap?.get(performanceGate);
  if (
    requirement?.gate !== performanceGate ||
    requirement.evidenceScope !== "own" ||
    !Array.isArray(requirement.scenarioIds) ||
    requirement.scenarioIds.length === 0 ||
    new Set(requirement.scenarioIds).size !== requirement.scenarioIds.length ||
    !Object.hasOwn(REQUIRED_PERFORMANCE_VARIANTS, performanceGate)
  ) {
    throw new Error(
      `${performanceGate}: authoritative own-gate scenario policy is invalid`,
    );
  }
  return [...requirement.scenarioIds];
};

const assertPendingBindingAuthority = ({ current, requirements, binding }) => {
  if (
    binding === null ||
    binding === undefined ||
    current.snapshot?.pendingAcceptance === null ||
    current.snapshot?.pendingAcceptance === undefined ||
    current.snapshot.pendingAcceptance.operationId !==
      requirements.operationId ||
    current.snapshot.pendingOperation?.operationId !==
      requirements.operationId ||
    !sameCanonicalValue(current.head, requirements.expectedState) ||
    !sameCanonicalValue(
      current.snapshot.pendingAcceptance.standardBinding,
      binding,
    ) ||
    !sameCanonicalValue(
      current.snapshot.pendingOperation.targetBinding,
      binding,
    )
  ) {
    throw new Error(
      "Performance collection pending acceptance changed or is not authoritative",
    );
  }
  assertDeploymentBinding(binding, {
    namespace: requirements.namespace,
    expectedRole: "standard",
    label: "Pending performance standard",
  });
  if (
    binding.sourceSha !== requirements.sourceSha ||
    binding.artifactArchive.sha256 !== requirements.expectedArtifactSha256
  ) {
    throw new Error(
      "Performance collection binding differs from acceptance requirements",
    );
  }
};

export const buildOwnGatePerformanceEvidenceId = ({ performanceGate, runId }) =>
  ownGateRawSamplesEvidenceId({ performanceGate, runId });

export const resolveAuthoritativeOwnGatePerformanceCollection = async (
  { store, requirements, sourceState, context, runId },
  {
    readState = readCurrentReleaseState,
    verifyArchive = assertArtifactArchiveAvailable,
    readEvidence = assertEvidenceObjectAvailable,
  } = {},
) => {
  assertCleanSourceState(sourceState);
  assertAuthoritativeOwnGatePerformanceRequirements({
    requirements,
    expectedNamespace: store?.namespace,
    expectedSourceSha: sourceState.gitCommitSha,
  });
  const current = await readState({ store });
  const binding = current.snapshot?.pendingAcceptance?.standardBinding;
  assertPendingBindingAuthority({ current, requirements, binding });

  const [archive, manifestStored] = await Promise.all([
    verifyArchive({
      store,
      namespace: requirements.namespace,
      binding,
      label: "Pending performance standard",
    }),
    readEvidence({
      store,
      namespace: requirements.namespace,
      reference: binding.artifactManifest,
      label: "Pending performance artifact manifest",
    }),
  ]);
  if (
    archive?.archive?.mediaType !== ARTIFACT_ARCHIVE_MEDIA_TYPE ||
    !Buffer.isBuffer(archive.archive.bytes) ||
    sha256Bytes(archive.archive.bytes) !== requirements.expectedArtifactSha256
  ) {
    throw new Error(
      "Pending performance artifact archive failed live readback",
    );
  }
  if (
    manifestStored?.mediaType !== ARTIFACT_MANIFEST_MEDIA_TYPE ||
    !Buffer.isBuffer(manifestStored.bytes) ||
    sha256Bytes(manifestStored.bytes) !== binding.artifactManifest.sha256
  ) {
    throw new Error(
      "Pending performance artifact manifest failed live readback",
    );
  }
  parseCanonicalJsonBytes(
    manifestStored.bytes,
    "Pending performance artifact manifest",
  );

  const environment = deriveReviewedPerformanceEnvironment(context);
  const scenarioIds = resolveOwnScenarioIds({
    context,
    performanceGate: requirements.performanceGate,
  });
  const evidenceId = buildOwnGatePerformanceEvidenceId({
    performanceGate: requirements.performanceGate,
    runId,
  });
  const authority = {
    schemaVersion: 1,
    authorityKind: COLLECTION_AUTHORITY_KIND,
    namespace: requirements.namespace,
    operationId: requirements.operationId,
    acceptedGate: requirements.acceptedGate,
    performanceGate: requirements.performanceGate,
    source: structuredClone(sourceState),
    expectedState: structuredClone(requirements.expectedState),
    bindingId: binding.bindingId,
    variantId: binding.variantId,
    deploymentUrl: binding.deploymentUrl,
    artifactArchiveSha256: binding.artifactArchive.sha256,
    artifactManifestSha256: binding.artifactManifest.sha256,
    evidenceId,
    environment,
    scenarioIds,
    collectorContract: {
      adapterContract: "public-artifact-surface-v1",
      sampleCount: PERFORMANCE_SAMPLE_COUNT,
      warmupSamples: PERFORMANCE_WARMUP_COUNT,
      freshBrowserContextPerSample: true,
    },
  };
  return {
    authority,
    archiveBytes: Buffer.from(archive.archive.bytes),
    manifestBytes: Buffer.from(manifestStored.bytes),
  };
};

export const assertUnchangedOwnGatePerformanceCollection = ({
  before,
  after,
}) => {
  assertUnchangedOwnGatePerformanceRequirements({
    before: before.requirements,
    after: after.requirements,
  });
  if (
    !sameCanonicalValue(
      before.collection.authority,
      after.collection.authority,
    ) ||
    !before.collection.archiveBytes.equals(after.collection.archiveBytes) ||
    !before.collection.manifestBytes.equals(after.collection.manifestBytes)
  ) {
    throw new Error(
      "Authoritative pending artifact changed during performance collection",
    );
  }
};

const parseCanonicalRawSamples = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("Collected raw performance samples are empty");
  }
  const value = parseJsonStrict(
    UTF8_DECODER.decode(bytes),
    "Collected raw performance samples",
  );
  const canonical = canonicalJsonBytes(value);
  const canonicalWithLf = Buffer.concat([canonical, Buffer.from("\n", "utf8")]);
  if (!bytes.equals(canonical) && !bytes.equals(canonicalWithLf)) {
    throw new Error("Collected raw performance samples are not canonical JSON");
  }
  return value;
};

export const buildProtectedRawPerformanceArtifact = ({
  samples,
  collectorIdentity,
}) => {
  assertExactKeys(
    collectorIdentity,
    ["sha256", "uri"],
    "Performance collector identity reference",
  );
  if (
    !SHA256_PATTERN.test(collectorIdentity.sha256 ?? "") ||
    typeof collectorIdentity.uri !== "string" ||
    !collectorIdentity.uri.endsWith(`/evidence/${collectorIdentity.sha256}`)
  ) {
    throw new Error("Performance collector identity reference is invalid");
  }
  const artifact = {
    schemaVersion: 1,
    artifactKind: PROTECTED_RAW_PERFORMANCE_ARTIFACT_KIND,
    collectorIdentity: structuredClone(collectorIdentity),
    samples: structuredClone(samples),
  };
  return Buffer.concat([
    canonicalJsonBytes(artifact),
    Buffer.from("\n", "utf8"),
  ]);
};

export const parseProtectedRawPerformanceArtifact = ({ bytes, namespace }) => {
  const artifact = parseCanonicalRawSamples(bytes);
  assertExactKeys(
    artifact,
    ["artifactKind", "collectorIdentity", "samples", "schemaVersion"],
    "Protected raw performance artifact",
  );
  assertExactKeys(
    artifact.collectorIdentity,
    ["sha256", "uri"],
    "Protected raw performance collector identity",
  );
  if (
    artifact.schemaVersion !== 1 ||
    artifact.artifactKind !== PROTECTED_RAW_PERFORMANCE_ARTIFACT_KIND ||
    !SHA256_PATTERN.test(artifact.collectorIdentity.sha256 ?? "") ||
    artifact.collectorIdentity.uri !==
      `release-state://${namespace}/evidence/${artifact.collectorIdentity.sha256}`
  ) {
    throw new Error("Protected raw performance artifact authority is invalid");
  }
  return artifact;
};

export const assertAuthoritativeRawPerformanceSamples = ({
  bytes,
  authority,
}) => {
  const value = parseCanonicalRawSamples(bytes);
  const canonicalCollectedAt = Number.isFinite(
    Date.parse(value.collectedAtUtc ?? ""),
  )
    ? new Date(Date.parse(value.collectedAtUtc)).toISOString()
    : null;
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "evidenceId",
      "gate",
      "collectedAtUtc",
      "source",
      "environment",
      "scenarios",
    ],
    "Collected raw performance samples",
  );
  assertExactKeys(
    value.source,
    [
      "gitCommitSha",
      "sourceClosureSha256",
      "treeState",
      "artifactSha256",
      "releaseVariant",
    ],
    "Collected raw performance source",
  );
  if (
    value.schemaVersion !== 1 ||
    value.evidenceId !== authority.evidenceId ||
    value.gate !== authority.performanceGate ||
    canonicalCollectedAt !== value.collectedAtUtc ||
    value.source.gitCommitSha !== authority.source.gitCommitSha ||
    value.source.sourceClosureSha256 !== authority.source.sourceClosureSha256 ||
    value.source.treeState !== "clean" ||
    value.source.artifactSha256 !== authority.artifactArchiveSha256 ||
    !sameCanonicalValue(
      value.source.releaseVariant,
      REQUIRED_PERFORMANCE_VARIANTS[authority.performanceGate],
    ) ||
    !sameCanonicalValue(value.environment, authority.environment)
  ) {
    throw new Error(
      "Collected raw samples differ from source, artifact, gate, or environment authority",
    );
  }
  if (
    !Array.isArray(value.scenarios) ||
    value.scenarios.length !== authority.scenarioIds.length ||
    value.scenarios.some((scenario, index) => {
      try {
        assertExactKeys(
          scenario,
          [
            "id",
            "samples",
            "supplementarySamples",
            "outcomeAssertions",
            "executionBinding",
          ],
          `${authority.scenarioIds[index]} raw scenario`,
        );
      } catch {
        return true;
      }
      const sampleSetIsValid = (samples) =>
        Array.isArray(samples) &&
        samples.length === PERFORMANCE_SAMPLE_COUNT &&
        samples.every(
          (sample) =>
            typeof sample === "number" &&
            Number.isFinite(sample) &&
            sample >= 0,
        );
      return (
        scenario.id !== authority.scenarioIds[index] ||
        !sampleSetIsValid(scenario.samples) ||
        typeof scenario.supplementarySamples !== "object" ||
        scenario.supplementarySamples === null ||
        Array.isArray(scenario.supplementarySamples) ||
        Object.values(scenario.supplementarySamples ?? {}).some(
          (samples) => !sampleSetIsValid(samples),
        ) ||
        typeof scenario.outcomeAssertions !== "object" ||
        scenario.outcomeAssertions === null ||
        Array.isArray(scenario.outcomeAssertions) ||
        Object.keys(scenario.outcomeAssertions ?? {}).length === 0 ||
        Object.values(scenario.outcomeAssertions ?? {}).some(
          (result) => result !== true,
        ) ||
        scenario.executionBinding?.adapterContract !==
          "public-artifact-surface-v1"
      );
    })
  ) {
    throw new Error(
      "Collected raw samples do not contain the authoritative scenario closure",
    );
  }
  return value;
};

export const OWN_GATE_PERFORMANCE_COLLECTION_CONTRACT = Object.freeze({
  authorityKind: COLLECTION_AUTHORITY_KIND,
  manifestMediaType: ARTIFACT_MANIFEST_MEDIA_TYPE,
});
