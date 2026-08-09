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

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

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
