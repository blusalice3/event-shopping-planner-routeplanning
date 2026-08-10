import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  MANAGED_DEVICE_MULTISTAGE_MEDIA_TYPES,
  MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE,
  aggregateManagedDeviceStages,
} from "../browser/managed-device-stage-authority.mjs";
import {
  MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES,
  assertSignedManagedDeviceReceipt,
  resolveManagedDeviceAcceptedDeployment,
} from "../browser/managed-device-authority.mjs";
import { readBoundReviewedWorkflowArtifactAuthority } from "./reviewedWorkflowArtifactAuthority.mjs";

export const MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.managed-device-reviewed-stage-set-authority+json;version=1";
export const MANAGED_DEVICE_REVIEWED_STAGE_SET_KIND =
  "managed-device-reviewed-stage-set-authority/v1";
export const MANAGED_DEVICE_STAGE_WORKFLOW_PATH =
  ".github/workflows/release.yml";
export const MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE =
  "foundation-managed-device-live-stage-{sourceSha}-{runAttempt}";
export const MANAGED_DEVICE_STAGE_FILE_NAME = "managed-device-live-stage.json";
export const PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.pwa-reviewed-formal-closure-authority+json;version=1";
export const PWA_REVIEWED_FORMAL_CLOSURE_KIND =
  "pwa-reviewed-formal-closure-authority/v1";
export const PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE =
  "foundation-pwa-multiclient-drill-{sourceSha}-{runAttempt}";
export const PWA_STRICT_RECEIPT_FILE_NAME = "pwa-multiclient-drill.json";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAXIMUM_SET_BYTES = 64 * 1024;
const REFERENCE_KEYS = Object.freeze(["sha256", "uri"]);
const SET_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "authority",
  "namespace",
  "repository",
  "sourceSha",
  "workflowPath",
  "artifact",
  "stages",
]);
const ARTIFACT_KEYS = Object.freeze([
  "nameTemplate",
  "fileName",
  "fileMediaType",
]);
const STAGE_KEYS = Object.freeze(["runId", "runAttempt", "reviewedArtifact"]);
const PWA_CLOSURE_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "authority",
  "namespace",
  "repository",
  "sourceSha",
  "stageSetAuthority",
  "strictReceiptArtifactAuthority",
]);
const PWA_AUTHORITY = "pwa-multiclient-drill";
const MAXIMUM_PWA_CLOSURE_BYTES = 32 * 1024;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const sameCanonicalValue = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertReference = ({ reference, namespace, label }) => {
  if (
    !hasExactKeys(reference, REFERENCE_KEYS) ||
    !SHA256_PATTERN.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} reference differs`);
  }
  return reference;
};

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return Object.freeze({
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  });
};

const compareRunIds = (left, right) => {
  const leftId = BigInt(left.runId);
  const rightId = BigInt(right.runId);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return Number(BigInt(left.runAttempt) - BigInt(right.runAttempt));
};

const assertPriorDistinctRuns = (stages, currentWorkflowRunId) => {
  if (
    !Array.isArray(stages) ||
    stages.length !== 3 ||
    new Set(stages.map(({ runId }) => runId)).size !== 3 ||
    (currentWorkflowRunId !== null &&
      !RUN_ID_PATTERN.test(currentWorkflowRunId ?? ""))
  ) {
    throw new Error(
      "Managed device stage set requires three distinct prior runs",
    );
  }
  for (const stage of stages) {
    if (
      !RUN_ID_PATTERN.test(stage?.runId ?? "") ||
      !RUN_ATTEMPT_PATTERN.test(stage?.runAttempt ?? "") ||
      (currentWorkflowRunId !== null &&
        BigInt(stage.runId) >= BigInt(currentWorkflowRunId))
    ) {
      throw new Error(
        "Managed device stage set contains a current or future run",
      );
    }
  }
};

const expectedArtifactName = (sourceSha, runAttempt) =>
  MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE.replace(
    "{sourceSha}",
    sourceSha,
  ).replace("{runAttempt}", runAttempt);

const assertSetIdentity = ({
  document,
  authority,
  namespace,
  repository,
  expectedCollectorSourceSha,
  currentWorkflowRunId,
}) => {
  if (
    !hasExactKeys(document, SET_KEYS) ||
    !Object.hasOwn(MANAGED_DEVICE_MULTISTAGE_MEDIA_TYPES, authority) ||
    document.schemaVersion !== 1 ||
    document.kind !== MANAGED_DEVICE_REVIEWED_STAGE_SET_KIND ||
    document.authority !== authority ||
    document.namespace !== namespace ||
    document.repository !== repository ||
    document.sourceSha !== expectedCollectorSourceSha ||
    document.workflowPath !== MANAGED_DEVICE_STAGE_WORKFLOW_PATH ||
    !hasExactKeys(document.artifact, ARTIFACT_KEYS) ||
    document.artifact.nameTemplate !==
      MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE ||
    document.artifact.fileName !== MANAGED_DEVICE_STAGE_FILE_NAME ||
    document.artifact.fileMediaType !==
      MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE ||
    !NAMESPACE_PATTERN.test(namespace ?? "") ||
    !REPOSITORY_PATTERN.test(repository ?? "") ||
    !SOURCE_SHA_PATTERN.test(expectedCollectorSourceSha ?? "")
  ) {
    throw new Error("Managed device reviewed stage set identity differs");
  }
  assertPriorDistinctRuns(document.stages, currentWorkflowRunId);
  let previous = null;
  for (const stage of document.stages) {
    if (
      !hasExactKeys(stage, STAGE_KEYS) ||
      (previous !== null && compareRunIds(previous, stage) >= 0)
    ) {
      throw new Error(
        "Managed device reviewed stage set order or schema differs",
      );
    }
    assertReference({
      reference: stage.reviewedArtifact,
      namespace,
      label: "Managed device reviewed artifact",
    });
    previous = stage;
  }
  return document;
};

const readStoredManagedDeviceStageSet = async ({
  authority,
  namespace,
  reference,
  store,
  repository,
  expectedCollectorSourceSha,
  currentWorkflowRunId,
}) => {
  assertReference({
    reference,
    namespace,
    label: "Managed device reviewed stage set",
  });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAXIMUM_SET_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE
  ) {
    throw new Error("Managed device reviewed stage set is absent or differs");
  }
  const document = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Managed device reviewed stage set",
  );
  if (!stored.bytes.equals(canonicalJsonBytes(document))) {
    throw new Error("Managed device reviewed stage set is not canonical");
  }
  assertSetIdentity({
    document,
    authority,
    namespace,
    repository,
    expectedCollectorSourceSha,
    currentWorkflowRunId,
  });
  return Object.freeze({ document, stored });
};

const expectedPwaStrictArtifactName = (sourceSha, runAttempt) =>
  PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE.replace(
    "{sourceSha}",
    sourceSha,
  ).replace("{runAttempt}", runAttempt);

const assertPwaStrictReviewedArtifact = ({
  artifact,
  reference,
  repository,
  sourceSha,
}) => {
  const receipt = artifact?.receipt;
  if (
    !isRecord(artifact) ||
    !isRecord(receipt) ||
    !isRecord(artifact.reference) ||
    !sameCanonicalValue(artifact.reference, reference) ||
    receipt.kind !== "reviewed-github-workflow-artifact/v1" ||
    receipt.repository !== repository ||
    receipt.sourceSha !== sourceSha ||
    receipt.workflowPath !== MANAGED_DEVICE_STAGE_WORKFLOW_PATH ||
    !RUN_ID_PATTERN.test(receipt.runId ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(receipt.runAttempt ?? "") ||
    receipt.artifactName !==
      expectedPwaStrictArtifactName(sourceSha, receipt.runAttempt) ||
    receipt.fileName !== PWA_STRICT_RECEIPT_FILE_NAME ||
    receipt.artifactFileMediaType !==
      MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES[PWA_AUTHORITY] ||
    !Buffer.isBuffer(artifact.fileBytes)
  ) {
    throw new Error("Reviewed strict PWA receipt artifact differs");
  }
  return artifact;
};

const readPwaStrictReviewedArtifact = async (
  { namespace, repository, sourceSha, reference, store },
  readReviewedArtifact,
) =>
  assertPwaStrictReviewedArtifact({
    artifact: await readReviewedArtifact({
      namespace,
      repository,
      expectedSourceSha: sourceSha,
      expectedWorkflowPath: MANAGED_DEVICE_STAGE_WORKFLOW_PATH,
      expectedArtifactNameTemplate:
        PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE.replace(
          "{sourceSha}",
          sourceSha,
        ),
      expectedFileName: PWA_STRICT_RECEIPT_FILE_NAME,
      expectedFileMediaType:
        MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES[PWA_AUTHORITY],
      reference,
      store,
    }),
    reference,
    repository,
    sourceSha,
  });

const assertPwaCompositeRunBinding = ({
  stageSet,
  strictArtifact,
  currentWorkflowRunId,
}) => {
  if (!RUN_ID_PATTERN.test(currentWorkflowRunId ?? "")) {
    throw new Error("PWA formal closure current workflow run is invalid");
  }
  const strictRunId = strictArtifact.receipt.runId;
  const stageRunIds = stageSet.stages.map(({ runId }) => runId);
  if (
    new Set([strictRunId, ...stageRunIds, currentWorkflowRunId]).size !== 5 ||
    BigInt(strictRunId) >= BigInt(currentWorkflowRunId) ||
    stageRunIds.some(
      (runId) =>
        BigInt(strictRunId) >= BigInt(runId) ||
        BigInt(runId) >= BigInt(currentWorkflowRunId),
    )
  ) {
    throw new Error(
      "PWA formal closure requires one strict predecessor and three distinct prior stage runs",
    );
  }
};

const assertPwaClosureIdentity = ({
  document,
  namespace,
  repository,
  sourceSha,
}) => {
  if (
    !hasExactKeys(document, PWA_CLOSURE_KEYS) ||
    document.schemaVersion !== 1 ||
    document.kind !== PWA_REVIEWED_FORMAL_CLOSURE_KIND ||
    document.authority !== PWA_AUTHORITY ||
    document.namespace !== namespace ||
    document.repository !== repository ||
    document.sourceSha !== sourceSha ||
    !NAMESPACE_PATTERN.test(namespace ?? "") ||
    !REPOSITORY_PATTERN.test(repository ?? "") ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "")
  ) {
    throw new Error("PWA reviewed formal closure identity differs");
  }
  assertReference({
    reference: document.stageSetAuthority,
    namespace,
    label: "PWA formal closure stage set",
  });
  assertReference({
    reference: document.strictReceiptArtifactAuthority,
    namespace,
    label: "PWA formal closure strict receipt artifact",
  });
  if (
    document.stageSetAuthority.sha256 ===
    document.strictReceiptArtifactAuthority.sha256
  ) {
    throw new Error(
      "PWA formal closure component authorities are not distinct",
    );
  }
  return document;
};

const readStoredPwaClosure = async ({
  namespace,
  reference,
  store,
  repository,
  sourceSha,
}) => {
  assertReference({
    reference,
    namespace,
    label: "PWA reviewed formal closure",
  });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAXIMUM_PWA_CLOSURE_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE
  ) {
    throw new Error("PWA reviewed formal closure is absent or differs");
  }
  const document = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "PWA reviewed formal closure",
  );
  if (!stored.bytes.equals(canonicalJsonBytes(document))) {
    throw new Error("PWA reviewed formal closure is not canonical");
  }
  assertPwaClosureIdentity({
    document,
    namespace,
    repository,
    sourceSha,
  });
  return Object.freeze({ document, stored });
};

const DEPLOYMENT_BINDING_KEYS = Object.freeze([
  "bindingId",
  "deploymentUrl",
  "providerDeploymentId",
  "providerProjectId",
  "releaseRole",
  "sourceSha",
]);

const deploymentBindingProjection = (binding, label) => {
  if (
    !isRecord(binding) ||
    DEPLOYMENT_BINDING_KEYS.some(
      (key) => typeof binding[key] !== "string" || binding[key].length === 0,
    ) ||
    !SOURCE_SHA_PATTERN.test(binding.sourceSha)
  ) {
    throw new Error(`PWA formal closure ${label} binding differs`);
  }
  return Object.fromEntries(
    DEPLOYMENT_BINDING_KEYS.map((key) => [key, binding[key]]),
  );
};

const strictDeviceProjection = (payload) => {
  const host = payload?.host;
  if (
    !isRecord(host) ||
    !isRecord(host.operatingSystem) ||
    !isRecord(host.browser) ||
    !isRecord(host.policy) ||
    !isRecord(host.appLaunch) ||
    !Array.isArray(host.profiles)
  ) {
    throw new Error("PWA formal closure strict device evidence differs");
  }
  return {
    runnerGroup: host.runnerGroup,
    runnerLabels: host.runnerLabels,
    operatingSystem: {
      family: host.operatingSystem.family,
      release: host.operatingSystem.release,
      architecture: host.operatingSystem.architecture,
    },
    browser: host.browser,
    policy: {
      applicationId: host.policy.applicationId,
      forceInstallPolicyName: host.policy.forceInstallPolicyName,
      forceInstallPolicyValueSha256: host.policy.forceInstallPolicyValueSha256,
      installUrl: host.policy.installUrl,
      shortcutArgumentsSha256: host.appLaunch.argumentsSha256,
      shortcutPathSha256: host.appLaunch.shortcutPathSha256,
    },
    profiles: host.profiles.map(({ profileId, profilePathSha256 }) => ({
      profileId,
      profilePathSha256,
    })),
  };
};

const stageDeviceProjection = (stage) => {
  const observation = stage?.payload?.observation;
  const clients = observation?.cycles?.[0]?.clients;
  if (
    !isRecord(observation) ||
    !isRecord(observation.operatingSystem) ||
    !isRecord(observation.browser) ||
    !isRecord(observation.policy) ||
    !Array.isArray(clients)
  ) {
    throw new Error("PWA formal closure stage device evidence differs");
  }
  return {
    runnerGroup: observation.runnerGroup,
    runnerLabels: observation.runnerLabels,
    operatingSystem: observation.operatingSystem,
    browser: observation.browser,
    policy: observation.policy,
    profiles: clients.map(({ profileId, profilePathSha256 }) => ({
      profileId,
      profilePathSha256,
    })),
  };
};

const assertPwaCrossEvidenceBinding = ({
  stageSetReadback,
  verifiedStrictReceipt,
  expectedCollectorSourceSha,
}) => {
  const aggregate = stageSetReadback?.aggregated;
  const stages = aggregate?.stages;
  const stageDocument = aggregate?.document;
  const strictPayload = verifiedStrictReceipt?.receipt?.payload;
  const strictResult = verifiedStrictReceipt?.result;
  const transitions = strictPayload?.evidence?.transitions;
  if (
    !Array.isArray(stages) ||
    stages.length !== 3 ||
    !isRecord(stageDocument) ||
    stageDocument.authority !== PWA_AUTHORITY ||
    stageDocument.sourceSha !== expectedCollectorSourceSha ||
    !isRecord(strictPayload) ||
    strictPayload.authority !== PWA_AUTHORITY ||
    strictPayload.sourceSha !== expectedCollectorSourceSha ||
    !isRecord(strictResult) ||
    !Array.isArray(transitions) ||
    transitions.length !== 3
  ) {
    throw new Error("PWA formal closure source authority differs");
  }

  const expectedBindings = [
    strictPayload.deployment,
    strictPayload.rollbackDeployment,
    strictPayload.deployment,
  ];
  stages.forEach((stage, index) => {
    const stageBinding = deploymentBindingProjection(
      stage?.payload?.releaseState?.activeBinding,
      `stage ${index + 1}`,
    );
    const strictBinding = deploymentBindingProjection(
      expectedBindings[index],
      `strict transition ${index + 1}`,
    );
    if (!sameCanonicalValue(stageBinding, strictBinding)) {
      throw new Error("PWA formal closure deployment predecessor differs");
    }
  });

  const device = strictDeviceProjection(strictPayload);
  const stageDevices = stages.map(stageDeviceProjection);
  if (
    stageDevices.some((stageDevice) => !sameCanonicalValue(stageDevice, device))
  ) {
    throw new Error("PWA formal closure device binding differs");
  }

  transitions.forEach((transition, index) => {
    const controllerSha256 = transition?.controller?.scriptSourceSha256;
    const clients = stages[index]?.result?.clients;
    if (
      !SHA256_PATTERN.test(controllerSha256 ?? "") ||
      !Array.isArray(clients) ||
      clients.length !== 2 ||
      clients.some((client) => client?.controllerSha256 !== controllerSha256)
    ) {
      throw new Error("PWA formal closure controller predecessor differs");
    }
  });

  const strictObservedAt = Date.parse(strictPayload.observedAt);
  const initialStageObservedAt = Date.parse(stages[0]?.payload?.observedAt);
  if (
    !Number.isFinite(strictObservedAt) ||
    !Number.isFinite(initialStageObservedAt) ||
    strictObservedAt >= initialStageObservedAt
  ) {
    throw new Error("PWA formal closure strict receipt is not a predecessor");
  }
  if (
    !sameCanonicalValue(
      strictResult.clientKinds,
      stageDocument.result?.clientKinds,
    ) ||
    strictResult.transitionCount !== stageDocument.result?.transitionCount ||
    strictResult.finalBuildId !== stageDocument.result?.finalSourceSha
  ) {
    throw new Error("PWA formal closure source result differs");
  }
};

const assertReviewedStageForSet = ({
  stage,
  namespace,
  repository,
  sourceSha,
}) => {
  const receipt = stage?.receipt;
  const reference = stage?.reference;
  if (
    !isRecord(receipt) ||
    receipt.kind !== "reviewed-github-workflow-artifact/v1" ||
    receipt.repository !== repository ||
    receipt.sourceSha !== sourceSha ||
    receipt.workflowPath !== MANAGED_DEVICE_STAGE_WORKFLOW_PATH ||
    !RUN_ID_PATTERN.test(receipt.runId ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(receipt.runAttempt ?? "") ||
    receipt.artifactName !==
      expectedArtifactName(sourceSha, receipt.runAttempt) ||
    receipt.fileName !== MANAGED_DEVICE_STAGE_FILE_NAME ||
    receipt.artifactFileMediaType !== MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE
  ) {
    throw new Error("Managed device reviewed stage artifact differs");
  }
  assertReference({
    reference,
    namespace,
    label: "Managed device reviewed artifact",
  });
  return Object.freeze({
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    reviewedArtifact: Object.freeze({ ...reference }),
  });
};

export const putManagedDeviceReviewedStageSetAuthority = async ({
  authority,
  namespace,
  repository,
  sourceSha,
  reviewedStages,
  store,
  currentWorkflowRunId,
}) => {
  if (
    store?.namespace !== namespace ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    !Object.hasOwn(MANAGED_DEVICE_MULTISTAGE_MEDIA_TYPES, authority)
  ) {
    throw new Error("Managed device stage set writer options differ");
  }
  const stages = reviewedStages
    .map((stage) =>
      assertReviewedStageForSet({
        stage,
        namespace,
        repository,
        sourceSha,
      }),
    )
    .sort(compareRunIds);
  assertPriorDistinctRuns(stages, currentWorkflowRunId);
  const document = Object.freeze({
    schemaVersion: 1,
    kind: MANAGED_DEVICE_REVIEWED_STAGE_SET_KIND,
    authority,
    namespace,
    repository,
    sourceSha,
    workflowPath: MANAGED_DEVICE_STAGE_WORKFLOW_PATH,
    artifact: Object.freeze({
      nameTemplate: MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE,
      fileName: MANAGED_DEVICE_STAGE_FILE_NAME,
      fileMediaType: MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE,
    }),
    stages: Object.freeze(stages),
  });
  assertSetIdentity({
    document,
    authority,
    namespace,
    repository,
    expectedCollectorSourceSha: sourceSha,
    currentWorkflowRunId,
  });
  const bytes = canonicalJsonBytes(document);
  const reference = immutableReference(namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE,
  });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error("Managed device stage set immutable readback differs");
  }
  return Object.freeze({ document, bytes, reference, receipt });
};

export const readManagedDeviceReviewedStageSetAuthority = async (
  {
    authority,
    namespace,
    reference,
    store,
    current,
    expectedCollectorSourceSha,
    externalPolicy,
    approvalPolicy,
    dbContract,
    currentWorkflowRunId,
  },
  {
    readReviewedArtifact = readBoundReviewedWorkflowArtifactAuthority,
    aggregate = aggregateManagedDeviceStages,
  } = {},
) => {
  if (
    store?.namespace !== namespace ||
    typeof store.readEvidence !== "function" ||
    typeof readReviewedArtifact !== "function" ||
    typeof aggregate !== "function" ||
    !isRecord(approvalPolicy) ||
    approvalPolicy.repository === undefined
  ) {
    throw new Error("Managed device stage set reader options differ");
  }
  const { document, stored } = await readStoredManagedDeviceStageSet({
    authority,
    namespace,
    reference,
    store,
    repository: approvalPolicy.repository,
    expectedCollectorSourceSha,
    currentWorkflowRunId,
  });
  const artifacts = await Promise.all(
    document.stages.map((stage) =>
      readReviewedArtifact({
        namespace,
        repository: document.repository,
        expectedSourceSha: expectedCollectorSourceSha,
        expectedWorkflowPath: document.workflowPath,
        expectedArtifactNameTemplate: document.artifact.nameTemplate.replace(
          "{sourceSha}",
          expectedCollectorSourceSha,
        ),
        expectedFileName: document.artifact.fileName,
        expectedFileMediaType: document.artifact.fileMediaType,
        reference: stage.reviewedArtifact,
        store,
      }).then((artifact) => {
        if (
          artifact.receipt?.runId !== stage.runId ||
          artifact.receipt?.runAttempt !== stage.runAttempt ||
          !Buffer.isBuffer(artifact.fileBytes)
        ) {
          throw new Error(
            "Managed device reviewed stage selector was substituted",
          );
        }
        const receipt = parseJsonStrict(
          artifact.fileBytes.toString("utf8"),
          "Managed device signed stage receipt",
        );
        if (!artifact.fileBytes.equals(canonicalJsonBytes(receipt))) {
          throw new Error(
            "Managed device signed stage receipt is not canonical",
          );
        }
        return Object.freeze({
          runId: stage.runId,
          runAttempt: stage.runAttempt,
          receipt,
        });
      }),
    ),
  );
  const aggregated = aggregate({
    authority,
    reviewedStages: artifacts,
    externalPolicy,
    approvalPolicy,
    dbContract,
    current,
    expectedCollectorSourceSha,
  });
  if (
    aggregated?.document?.authority !== authority ||
    aggregated.document.sourceSha !== expectedCollectorSourceSha ||
    aggregated.sha256 !== sha256Bytes(canonicalJsonBytes(aggregated.document))
  ) {
    throw new Error("Managed device stage aggregation identity differs");
  }
  return Object.freeze({
    document: Object.freeze(structuredClone(document)),
    sha256: reference.sha256,
    aggregated,
    reviewedStages: Object.freeze(artifacts),
    setReceipt: Object.freeze({
      reference: Object.freeze({ ...reference }),
      mediaType: stored.mediaType,
      committedAt: stored.committedAt,
    }),
  });
};

export const putPwaReviewedFormalClosureAuthority = async (
  {
    namespace,
    repository,
    sourceSha,
    stageSetReference,
    strictReceiptArtifactReference,
    store,
    currentWorkflowRunId,
  },
  { readReviewedArtifact = readBoundReviewedWorkflowArtifactAuthority } = {},
) => {
  if (
    store?.namespace !== namespace ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    typeof readReviewedArtifact !== "function" ||
    !NAMESPACE_PATTERN.test(namespace ?? "") ||
    !REPOSITORY_PATTERN.test(repository ?? "") ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "")
  ) {
    throw new Error("PWA reviewed formal closure writer options differ");
  }
  const [stageSet, strictArtifact] = await Promise.all([
    readStoredManagedDeviceStageSet({
      authority: PWA_AUTHORITY,
      namespace,
      reference: stageSetReference,
      store,
      repository,
      expectedCollectorSourceSha: sourceSha,
      currentWorkflowRunId,
    }),
    readPwaStrictReviewedArtifact(
      {
        namespace,
        repository,
        sourceSha,
        reference: strictReceiptArtifactReference,
        store,
      },
      readReviewedArtifact,
    ),
  ]);
  assertPwaCompositeRunBinding({
    stageSet: stageSet.document,
    strictArtifact,
    currentWorkflowRunId,
  });
  const document = Object.freeze({
    schemaVersion: 1,
    kind: PWA_REVIEWED_FORMAL_CLOSURE_KIND,
    authority: PWA_AUTHORITY,
    namespace,
    repository,
    sourceSha,
    stageSetAuthority: Object.freeze({ ...stageSetReference }),
    strictReceiptArtifactAuthority: Object.freeze({
      ...strictReceiptArtifactReference,
    }),
  });
  assertPwaClosureIdentity({ document, namespace, repository, sourceSha });
  const bytes = canonicalJsonBytes(document);
  const reference = immutableReference(namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE,
  });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error("PWA reviewed formal closure immutable readback differs");
  }
  return Object.freeze({ document, bytes, reference, receipt });
};

export const readPwaReviewedFormalClosureAuthority = async (
  {
    namespace,
    reference,
    store,
    current,
    expectedCollectorSourceSha,
    externalPolicy,
    approvalPolicy,
    dbContract,
    currentWorkflowRunId,
  },
  {
    readReviewedArtifact = readBoundReviewedWorkflowArtifactAuthority,
    readStageSet = readManagedDeviceReviewedStageSetAuthority,
    assertStrictReceipt = assertSignedManagedDeviceReceipt,
    resolveDeployment = resolveManagedDeviceAcceptedDeployment,
  } = {},
) => {
  if (
    store?.namespace !== namespace ||
    typeof store.readEvidence !== "function" ||
    typeof readReviewedArtifact !== "function" ||
    typeof readStageSet !== "function" ||
    typeof assertStrictReceipt !== "function" ||
    typeof resolveDeployment !== "function" ||
    !isRecord(approvalPolicy) ||
    !REPOSITORY_PATTERN.test(approvalPolicy.repository ?? "") ||
    !SOURCE_SHA_PATTERN.test(expectedCollectorSourceSha ?? "")
  ) {
    throw new Error("PWA reviewed formal closure reader options differ");
  }
  const { document, stored } = await readStoredPwaClosure({
    namespace,
    reference,
    store,
    repository: approvalPolicy.repository,
    sourceSha: expectedCollectorSourceSha,
  });
  const [storedStageSet, stageSetReadback, strictArtifact] = await Promise.all([
    readStoredManagedDeviceStageSet({
      authority: PWA_AUTHORITY,
      namespace,
      reference: document.stageSetAuthority,
      store,
      repository: approvalPolicy.repository,
      expectedCollectorSourceSha,
      currentWorkflowRunId,
    }),
    readStageSet({
      authority: PWA_AUTHORITY,
      namespace,
      reference: document.stageSetAuthority,
      store,
      current,
      expectedCollectorSourceSha,
      externalPolicy,
      approvalPolicy,
      dbContract,
      currentWorkflowRunId,
    }),
    readPwaStrictReviewedArtifact(
      {
        namespace,
        repository: approvalPolicy.repository,
        sourceSha: expectedCollectorSourceSha,
        reference: document.strictReceiptArtifactAuthority,
        store,
      },
      readReviewedArtifact,
    ),
  ]);
  if (
    stageSetReadback?.sha256 !== document.stageSetAuthority.sha256 ||
    !isRecord(stageSetReadback.document) ||
    !sameCanonicalValue(stageSetReadback.document, storedStageSet.document) ||
    !isRecord(stageSetReadback.setReceipt?.reference) ||
    !sameCanonicalValue(
      stageSetReadback.setReceipt.reference,
      document.stageSetAuthority,
    )
  ) {
    throw new Error("PWA formal closure stage set readback differs");
  }
  const signedReceipt = parseJsonStrict(
    strictArtifact.fileBytes.toString("utf8"),
    "Strict signed PWA receipt",
  );
  if (!strictArtifact.fileBytes.equals(canonicalJsonBytes(signedReceipt))) {
    throw new Error("Strict signed PWA receipt is not canonical");
  }
  const selected = resolveDeployment({
    current,
    namespace,
    sourceSha: expectedCollectorSourceSha,
    requireRollback: true,
  });
  if (
    !isRecord(selected?.projection) ||
    !isRecord(selected.rollbackProjection)
  ) {
    throw new Error("PWA formal closure deployment authority differs");
  }
  const verifiedStrictReceipt = assertStrictReceipt(signedReceipt, {
    authority: PWA_AUTHORITY,
    externalPolicy,
    approvalPolicy,
    dbContract,
    expectedSourceSha: expectedCollectorSourceSha,
    expectedRunId: strictArtifact.receipt.runId,
    expectedRunAttempt: strictArtifact.receipt.runAttempt,
    expectedDeployment: selected.projection,
    expectedRollbackDeployment: selected.rollbackProjection,
  });
  const signedReceiptSha256 = sha256Bytes(canonicalJsonBytes(signedReceipt));
  if (
    !isRecord(verifiedStrictReceipt) ||
    verifiedStrictReceipt.sha256 !== signedReceiptSha256 ||
    !isRecord(verifiedStrictReceipt.receipt) ||
    !sameCanonicalValue(verifiedStrictReceipt.receipt, signedReceipt)
  ) {
    throw new Error("Strict signed PWA receipt verification differs");
  }
  assertPwaCompositeRunBinding({
    stageSet: stageSetReadback.document,
    strictArtifact,
    currentWorkflowRunId,
  });
  assertPwaCrossEvidenceBinding({
    stageSetReadback,
    verifiedStrictReceipt,
    expectedCollectorSourceSha,
  });
  const compositeReference = Object.freeze({ ...reference });
  const stageSetAuthority = Object.freeze({
    ...document.stageSetAuthority,
  });
  const strictReceiptArtifactAuthority = Object.freeze({
    ...document.strictReceiptArtifactAuthority,
  });
  return Object.freeze({
    document: Object.freeze(structuredClone(document)),
    sha256: reference.sha256,
    aggregated: stageSetReadback.aggregated,
    reviewedStages: stageSetReadback.reviewedStages,
    setReceipt: Object.freeze({
      reference: compositeReference,
      mediaType: stored.mediaType,
      committedAt: stored.committedAt,
    }),
    formalClosure: Object.freeze({
      kind: PWA_REVIEWED_FORMAL_CLOSURE_KIND,
      authority: PWA_AUTHORITY,
      sourceSha: expectedCollectorSourceSha,
      reference: compositeReference,
      stageSetAuthority,
      strictReceiptArtifactAuthority,
      strictReceiptSha256: signedReceiptSha256,
    }),
    stageSetReadback,
    strictReceipt: verifiedStrictReceipt,
    strictReviewedArtifact: strictArtifact,
  });
};
