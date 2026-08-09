import { promisify } from "node:util";
import yauzl from "yauzl";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  collectReviewedWorkflowRunAuthority,
  readReviewedWorkflowRunAuthority,
} from "./reviewedWorkflowRunAuthority.mjs";

export const GITHUB_WORKFLOW_ARTIFACT_RESPONSE_MEDIA_TYPE =
  "application/vnd.github+json";
export const GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE = "application/zip";
export const REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.reviewed-workflow-artifact+json;version=1";

const MAXIMUM_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}\.json$/u;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9=._+-]+)*$/u;
const RECEIPT_KEYS = Object.freeze([
  "artifactApiResponse",
  "artifactArchive",
  "artifactDigestSha256",
  "artifactFile",
  "artifactFileMediaType",
  "artifactId",
  "artifactName",
  "fileName",
  "kind",
  "repository",
  "reviewedWorkflowRun",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sourceSha",
  "workflowPath",
]);
const REFERENCE_KEYS = Object.freeze(["sha256", "uri"]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertReference = ({ reference, namespace, label }) => {
  if (
    !hasExactKeys(reference, REFERENCE_KEYS) ||
    !SHA256_PATTERN.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} reference is invalid`);
  }
  return reference;
};

const assertOptions = ({
  namespace,
  repository,
  expectedRunId,
  expectedRunAttempt,
  expectedSourceSha,
  expectedWorkflowPath,
  expectedArtifactName,
  expectedFileName,
  expectedFileMediaType,
  store,
  requirePut,
}) => {
  if (
    !NAMESPACE_PATTERN.test(namespace ?? "") ||
    !REPOSITORY_PATTERN.test(repository ?? "") ||
    !RUN_ID_PATTERN.test(expectedRunId ?? "") ||
    !RUN_ATTEMPT_PATTERN.test(expectedRunAttempt ?? "") ||
    !SOURCE_SHA_PATTERN.test(expectedSourceSha ?? "") ||
    !WORKFLOW_PATH_PATTERN.test(expectedWorkflowPath ?? "") ||
    !ARTIFACT_NAME_PATTERN.test(expectedArtifactName ?? "") ||
    !FILE_NAME_PATTERN.test(expectedFileName ?? "") ||
    !MEDIA_TYPE_PATTERN.test(expectedFileMediaType ?? "") ||
    store?.namespace !== namespace ||
    typeof store.readEvidence !== "function" ||
    (requirePut && typeof store.putEvidence !== "function")
  ) {
    throw new Error("Reviewed GitHub artifact authority options are invalid");
  }
};

const putExact = async ({ store, namespace, bytes, mediaType, label }) => {
  const input = Buffer.from(bytes);
  const reference = immutableReference(namespace, input);
  const receipt = await store.putEvidence({ bytes: input, mediaType });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== input.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(input) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store put/readback differs`);
  }
  return reference;
};

const readExact = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
  maximumBytes,
}) => {
  assertReference({ reference, namespace, label });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > maximumBytes ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} immutable object is absent or differs`);
  }
  return Buffer.from(stored.bytes);
};

const readResponseBytes = async ({
  response,
  label,
  maximumBytes,
  contentTypePattern,
}) => {
  if (
    !response ||
    response.status !== 200 ||
    typeof response.arrayBuffer !== "function" ||
    !contentTypePattern.test(response.headers?.get?.("content-type") ?? "")
  ) {
    throw new Error(`${label} download failed`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new Error(`${label} is empty or oversized`);
  }
  return bytes;
};

const githubHeaders = (githubToken) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${githubToken}`,
  "user-agent": "event-shopping-planner-foundation-release",
  "x-github-api-version": "2022-11-28",
});

const fetchGithub = async ({ fetchImpl, url, githubToken, label }) => {
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: githubHeaders(githubToken),
      redirect: "follow",
    });
  } catch {
    throw new Error(`${label} download failed`);
  }
};

const assertArtifactMetadata = ({
  bytes,
  repository,
  expectedRunId,
  expectedSourceSha,
  expectedArtifactName,
}) => {
  const response = parseJsonStrict(
    bytes.toString("utf8"),
    "GitHub workflow artifact response",
  );
  if (
    !isRecord(response) ||
    response.total_count !== 1 ||
    !Array.isArray(response.artifacts) ||
    response.artifacts.length !== 1
  ) {
    throw new Error("GitHub workflow artifact set is not exact");
  }
  const artifact = response.artifacts[0];
  const artifactId = String(artifact?.id ?? "");
  const digestMatch = /^sha256:([0-9a-f]{64})$/u.exec(artifact?.digest ?? "");
  if (
    !isRecord(artifact) ||
    !RUN_ID_PATTERN.test(artifactId) ||
    artifact.name !== expectedArtifactName ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAXIMUM_ARCHIVE_BYTES ||
    digestMatch === null ||
    String(artifact.workflow_run?.id ?? "") !== expectedRunId ||
    artifact.workflow_run?.head_sha !== expectedSourceSha ||
    artifact.archive_download_url !==
      `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`
  ) {
    throw new Error("GitHub workflow artifact metadata binding differs");
  }
  return {
    artifactId,
    archiveSize: artifact.size_in_bytes,
    digestSha256: digestMatch[1],
  };
};

const openZipFromBuffer = promisify(yauzl.fromBuffer);

const extractExactFile = async ({ archiveBytes, expectedFileName }) => {
  let zip;
  try {
    zip = await openZipFromBuffer(archiveBytes, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch {
    throw new Error("GitHub workflow artifact archive is invalid");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let fileBytes = null;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(new Error(message));
    };
    zip.once("error", () =>
      fail("GitHub workflow artifact archive is invalid"),
    );
    zip.on("entry", (entry) => {
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const fileType = unixMode & 0o170000;
      if (
        fileBytes !== null ||
        entry.fileName !== expectedFileName ||
        entry.fileName.includes("/") ||
        entry.fileName.includes("\\") ||
        entry.uncompressedSize < 1 ||
        entry.uncompressedSize > MAXIMUM_FILE_BYTES ||
        (entry.generalPurposeBitFlag & 1) !== 0 ||
        (fileType !== 0 && fileType !== 0o100000)
      ) {
        fail("GitHub workflow artifact archive file set is not exact");
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail("GitHub workflow artifact file cannot be read");
          return;
        }
        const chunks = [];
        let byteLength = 0;
        stream.on("data", (chunk) => {
          byteLength += chunk.length;
          if (byteLength > MAXIMUM_FILE_BYTES) {
            stream.destroy(
              new Error("GitHub workflow artifact file is oversized"),
            );
            return;
          }
          chunks.push(chunk);
        });
        stream.once("error", () =>
          fail("GitHub workflow artifact file cannot be read"),
        );
        stream.once("end", () => {
          if (settled) return;
          const bytes = Buffer.concat(chunks);
          if (bytes.length !== entry.uncompressedSize) {
            fail("GitHub workflow artifact file size differs");
            return;
          }
          fileBytes = bytes;
          zip.readEntry();
        });
      });
    });
    zip.once("end", () => {
      if (settled) return;
      if (!Buffer.isBuffer(fileBytes)) {
        fail("GitHub workflow artifact archive file set is not exact");
        return;
      }
      settled = true;
      resolve(fileBytes);
    });
    zip.readEntry();
  });
};

const assertReceipt = ({
  receipt,
  namespace,
  repository,
  expectedRunId,
  expectedRunAttempt,
  expectedSourceSha,
  expectedWorkflowPath,
  expectedArtifactName,
  expectedFileName,
  expectedFileMediaType,
}) => {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "reviewed-github-workflow-artifact/v1" ||
    receipt.repository !== repository ||
    receipt.runId !== expectedRunId ||
    receipt.runAttempt !== expectedRunAttempt ||
    receipt.sourceSha !== expectedSourceSha ||
    receipt.workflowPath !== expectedWorkflowPath ||
    receipt.artifactName !== expectedArtifactName ||
    receipt.fileName !== expectedFileName ||
    receipt.artifactFileMediaType !== expectedFileMediaType ||
    !RUN_ID_PATTERN.test(receipt.artifactId ?? "") ||
    !SHA256_PATTERN.test(receipt.artifactDigestSha256 ?? "")
  ) {
    throw new Error("Reviewed GitHub artifact receipt binding differs");
  }
  for (const [label, reference] of [
    ["Reviewed workflow run", receipt.reviewedWorkflowRun],
    ["GitHub artifact API response", receipt.artifactApiResponse],
    ["GitHub artifact archive", receipt.artifactArchive],
    ["GitHub artifact file", receipt.artifactFile],
  ]) {
    assertReference({ reference, namespace, label });
  }
  return receipt;
};

export const readReviewedWorkflowArtifactAuthority = async (options) => {
  assertOptions({ ...options, requirePut: false });
  assertReference({
    reference: options.reference,
    namespace: options.namespace,
    label: "Reviewed GitHub artifact authority",
  });
  const receiptBytes = await readExact({
    store: options.store,
    namespace: options.namespace,
    reference: options.reference,
    mediaType: REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
    label: "Reviewed GitHub artifact authority",
    maximumBytes: MAXIMUM_API_RESPONSE_BYTES,
  });
  const receipt = parseJsonStrict(
    receiptBytes.toString("utf8"),
    "Reviewed GitHub artifact authority",
  );
  if (!receiptBytes.equals(canonicalJsonBytes(receipt))) {
    throw new Error("Reviewed GitHub artifact receipt is not canonical");
  }
  assertReceipt({ receipt, ...options });
  const [workflowRun, apiResponseBytes, archiveBytes, storedFileBytes] =
    await Promise.all([
      readReviewedWorkflowRunAuthority({
        namespace: options.namespace,
        repository: options.repository,
        expectedRunId: options.expectedRunId,
        expectedRunAttempt: options.expectedRunAttempt,
        expectedSourceSha: options.expectedSourceSha,
        expectedWorkflowPath: options.expectedWorkflowPath,
        reference: receipt.reviewedWorkflowRun,
        store: options.store,
      }),
      readExact({
        store: options.store,
        namespace: options.namespace,
        reference: receipt.artifactApiResponse,
        mediaType: GITHUB_WORKFLOW_ARTIFACT_RESPONSE_MEDIA_TYPE,
        label: "GitHub artifact API response",
        maximumBytes: MAXIMUM_API_RESPONSE_BYTES,
      }),
      readExact({
        store: options.store,
        namespace: options.namespace,
        reference: receipt.artifactArchive,
        mediaType: GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE,
        label: "GitHub artifact archive",
        maximumBytes: MAXIMUM_ARCHIVE_BYTES,
      }),
      readExact({
        store: options.store,
        namespace: options.namespace,
        reference: receipt.artifactFile,
        mediaType: options.expectedFileMediaType,
        label: "GitHub artifact file",
        maximumBytes: MAXIMUM_FILE_BYTES,
      }),
    ]);
  const metadata = assertArtifactMetadata({
    bytes: apiResponseBytes,
    repository: options.repository,
    expectedRunId: options.expectedRunId,
    expectedSourceSha: options.expectedSourceSha,
    expectedArtifactName: options.expectedArtifactName,
  });
  if (
    metadata.artifactId !== receipt.artifactId ||
    metadata.digestSha256 !== receipt.artifactDigestSha256 ||
    metadata.archiveSize !== archiveBytes.length ||
    sha256Bytes(archiveBytes) !== metadata.digestSha256
  ) {
    throw new Error("GitHub artifact archive digest binding differs");
  }
  const extractedFileBytes = await extractExactFile({
    archiveBytes,
    expectedFileName: options.expectedFileName,
  });
  if (
    !extractedFileBytes.equals(storedFileBytes) ||
    sha256Bytes(storedFileBytes) !== receipt.artifactFile.sha256
  ) {
    throw new Error("GitHub artifact extracted file binding differs");
  }
  return {
    receipt,
    receiptBytes,
    reference: options.reference,
    workflowRun,
    fileBytes: storedFileBytes,
  };
};

export const readBoundReviewedWorkflowArtifactAuthority = async ({
  namespace,
  repository,
  expectedSourceSha,
  expectedWorkflowPath,
  expectedArtifactNameTemplate,
  expectedFileName,
  expectedFileMediaType,
  reference,
  store,
}) => {
  assertReference({
    reference,
    namespace,
    label: "Reviewed GitHub artifact authority",
  });
  const receiptBytes = await readExact({
    store,
    namespace,
    reference,
    mediaType: REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
    label: "Reviewed GitHub artifact authority",
    maximumBytes: MAXIMUM_API_RESPONSE_BYTES,
  });
  const receipt = parseJsonStrict(
    receiptBytes.toString("utf8"),
    "Reviewed GitHub artifact authority",
  );
  if (
    typeof expectedArtifactNameTemplate !== "string" ||
    !expectedArtifactNameTemplate.includes("{runAttempt}")
  ) {
    throw new Error("Reviewed GitHub artifact name template is invalid");
  }
  const expectedArtifactName = expectedArtifactNameTemplate.replace(
    "{runAttempt}",
    receipt?.runAttempt ?? "",
  );
  return readReviewedWorkflowArtifactAuthority({
    namespace,
    repository,
    expectedRunId: receipt?.runId,
    expectedRunAttempt: receipt?.runAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
    expectedArtifactName,
    expectedFileName,
    expectedFileMediaType,
    reference,
    store,
  });
};

export const collectReviewedWorkflowArtifactAuthority = async ({
  fetchImpl = fetch,
  githubToken,
  ...options
}) => {
  assertOptions({ ...options, requirePut: true });
  if (
    typeof fetchImpl !== "function" ||
    typeof githubToken !== "string" ||
    githubToken.length < 8
  ) {
    throw new Error("Reviewed GitHub artifact authority options are invalid");
  }
  const reviewedWorkflowRun = await collectReviewedWorkflowRunAuthority({
    fetchImpl,
    githubToken,
    namespace: options.namespace,
    repository: options.repository,
    expectedRunId: options.expectedRunId,
    expectedRunAttempt: options.expectedRunAttempt,
    expectedSourceSha: options.expectedSourceSha,
    expectedWorkflowPath: options.expectedWorkflowPath,
    store: options.store,
  });
  const repositoryPath = options.repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const metadataUrl =
    `https://api.github.com/repos/${repositoryPath}/actions/runs/` +
    `${options.expectedRunId}/artifacts?name=${encodeURIComponent(options.expectedArtifactName)}&per_page=100`;
  const metadataResponse = await fetchGithub({
    fetchImpl,
    url: metadataUrl,
    githubToken,
    label: "GitHub workflow artifact metadata",
  });
  const metadataBytes = await readResponseBytes({
    response: metadataResponse,
    label: "GitHub workflow artifact metadata",
    maximumBytes: MAXIMUM_API_RESPONSE_BYTES,
    contentTypePattern: /^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/iu,
  });
  const metadata = assertArtifactMetadata({
    bytes: metadataBytes,
    repository: options.repository,
    expectedRunId: options.expectedRunId,
    expectedSourceSha: options.expectedSourceSha,
    expectedArtifactName: options.expectedArtifactName,
  });
  const archiveUrl = `https://api.github.com/repos/${repositoryPath}/actions/artifacts/${metadata.artifactId}/zip`;
  const archiveResponse = await fetchGithub({
    fetchImpl,
    url: archiveUrl,
    githubToken,
    label: "GitHub workflow artifact archive",
  });
  const archiveBytes = await readResponseBytes({
    response: archiveResponse,
    label: "GitHub workflow artifact archive",
    maximumBytes: MAXIMUM_ARCHIVE_BYTES,
    contentTypePattern:
      /^application\/(?:zip|octet-stream|x-zip-compressed)(?:\s*;|$)/iu,
  });
  if (
    archiveBytes.length !== metadata.archiveSize ||
    sha256Bytes(archiveBytes) !== metadata.digestSha256
  ) {
    throw new Error("GitHub workflow artifact archive digest differs");
  }
  const fileBytes = await extractExactFile({
    archiveBytes,
    expectedFileName: options.expectedFileName,
  });
  const [artifactApiResponse, artifactArchive, artifactFile] =
    await Promise.all([
      putExact({
        store: options.store,
        namespace: options.namespace,
        bytes: metadataBytes,
        mediaType: GITHUB_WORKFLOW_ARTIFACT_RESPONSE_MEDIA_TYPE,
        label: "GitHub workflow artifact API response",
      }),
      putExact({
        store: options.store,
        namespace: options.namespace,
        bytes: archiveBytes,
        mediaType: GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE,
        label: "GitHub workflow artifact archive",
      }),
      putExact({
        store: options.store,
        namespace: options.namespace,
        bytes: fileBytes,
        mediaType: options.expectedFileMediaType,
        label: "GitHub workflow artifact file",
      }),
    ]);
  const receiptBytes = canonicalJsonBytes({
    schemaVersion: 1,
    kind: "reviewed-github-workflow-artifact/v1",
    repository: options.repository,
    runId: options.expectedRunId,
    runAttempt: options.expectedRunAttempt,
    sourceSha: options.expectedSourceSha,
    workflowPath: options.expectedWorkflowPath,
    artifactId: metadata.artifactId,
    artifactName: options.expectedArtifactName,
    artifactDigestSha256: metadata.digestSha256,
    fileName: options.expectedFileName,
    artifactFileMediaType: options.expectedFileMediaType,
    reviewedWorkflowRun: reviewedWorkflowRun.receipt,
    artifactApiResponse,
    artifactArchive,
    artifactFile,
  });
  const reference = await putExact({
    store: options.store,
    namespace: options.namespace,
    bytes: receiptBytes,
    mediaType: REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
    label: "Reviewed GitHub workflow artifact receipt",
  });
  return readReviewedWorkflowArtifactAuthority({
    ...options,
    reference,
  });
};
