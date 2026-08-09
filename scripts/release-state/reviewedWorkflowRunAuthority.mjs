import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";

export const GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE =
  "application/vnd.github+json";
export const REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.reviewed-workflow-run+json;version=1";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const WORKFLOW_PATHS = new Set([
  ".github/workflows/performance-evidence.yml",
  ".github/workflows/release.yml",
]);
const RECEIPT_KEYS = [
  "apiResponse",
  "conclusion",
  "event",
  "headBranch",
  "headSha",
  "kind",
  "repository",
  "runAttempt",
  "runId",
  "schemaVersion",
  "status",
  "workflowPath",
];
const REFERENCE_KEYS = ["sha256", "uri"];

const hasExactKeys = (value, expected) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
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
    !stored?.bytes?.equals(input) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store receipt differs`);
  }
  return reference;
};

const readBoundedResponse = async (response) => {
  if (
    !response ||
    response.status !== 200 ||
    typeof response.arrayBuffer !== "function" ||
    !/^application\/json(?:\s*;|$)|^application\/vnd\.github\+json(?:\s*;|$)/i.test(
      response.headers?.get?.("content-type") ?? "",
    )
  ) {
    throw new Error("Reviewed GitHub workflow run lookup failed");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      "Reviewed GitHub workflow run response is empty or oversized",
    );
  }
  return bytes;
};

const assertOptions = ({
  namespace,
  repository,
  expectedRunId,
  expectedRunAttempt,
  expectedSourceSha,
  expectedWorkflowPath,
  store,
}) => {
  if (
    typeof namespace !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(namespace) ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !RUN_ID_PATTERN.test(expectedRunId ?? "") ||
    !RUN_ID_PATTERN.test(expectedRunAttempt ?? "") ||
    !SOURCE_SHA_PATTERN.test(expectedSourceSha ?? "") ||
    !WORKFLOW_PATHS.has(expectedWorkflowPath) ||
    store?.namespace !== namespace
  ) {
    throw new Error(
      "Reviewed GitHub workflow run authority options are invalid",
    );
  }
};

const assertRun = ({
  run,
  repository,
  expectedRunId,
  expectedRunAttempt,
  expectedSourceSha,
  expectedWorkflowPath,
}) => {
  if (
    run === null ||
    typeof run !== "object" ||
    Array.isArray(run) ||
    String(run.id) !== expectedRunId ||
    String(run.run_attempt) !== expectedRunAttempt ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== "main" ||
    run.head_sha !== expectedSourceSha ||
    run.path !== expectedWorkflowPath ||
    run.repository?.full_name !== repository
  ) {
    throw new Error(
      "Reviewed GitHub workflow run differs from protected authority",
    );
  }
  return run;
};

const assertReference = ({ reference, namespace, label }) => {
  if (
    !hasExactKeys(reference, REFERENCE_KEYS) ||
    !/^[0-9a-f]{64}$/.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} reference is invalid`);
  }
  return reference;
};

export const readReviewedWorkflowRunAuthority = async ({
  namespace,
  repository,
  expectedRunId,
  expectedRunAttempt,
  expectedSourceSha,
  expectedWorkflowPath,
  reference,
  store,
}) => {
  assertOptions({
    namespace,
    repository,
    expectedRunId,
    expectedRunAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
    store,
  });
  assertReference({
    reference,
    namespace,
    label: "Reviewed GitHub workflow run authority",
  });
  const storedReceipt = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !storedReceipt?.bytes ||
    sha256Bytes(storedReceipt.bytes) !== reference.sha256 ||
    storedReceipt.mediaType !== REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE
  ) {
    throw new Error("Reviewed GitHub workflow run receipt is absent");
  }
  const receipt = parseJsonStrict(
    storedReceipt.bytes.toString("utf8"),
    "Reviewed GitHub workflow run receipt",
  );
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "reviewed-github-workflow-run/v1" ||
    receipt.repository !== repository ||
    receipt.runId !== expectedRunId ||
    receipt.runAttempt !== expectedRunAttempt ||
    receipt.workflowPath !== expectedWorkflowPath ||
    receipt.event !== "workflow_dispatch" ||
    receipt.status !== "completed" ||
    receipt.conclusion !== "success" ||
    receipt.headBranch !== "main" ||
    receipt.headSha !== expectedSourceSha
  ) {
    throw new Error("Reviewed GitHub workflow run receipt binding differs");
  }
  assertReference({
    reference: receipt.apiResponse,
    namespace,
    label: "Reviewed GitHub workflow run API response",
  });
  const storedResponse = await store.readEvidence({
    sha256: receipt.apiResponse.sha256,
  });
  if (
    !storedResponse?.bytes ||
    sha256Bytes(storedResponse.bytes) !== receipt.apiResponse.sha256 ||
    storedResponse.mediaType !== GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE
  ) {
    throw new Error("Reviewed GitHub workflow run API response is absent");
  }
  assertRun({
    run: parseJsonStrict(
      storedResponse.bytes.toString("utf8"),
      "Stored GitHub workflow run API response",
    ),
    repository,
    expectedRunId,
    expectedRunAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
  });
  return { receipt, receiptBytes: storedReceipt.bytes };
};

export const readBoundReviewedWorkflowRunAuthority = async ({
  namespace,
  repository,
  expectedSourceSha,
  expectedWorkflowPath,
  reference,
  store,
}) => {
  assertReference({
    reference,
    namespace,
    label: "Reviewed GitHub workflow run authority",
  });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !stored?.bytes ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE
  ) {
    throw new Error("Reviewed GitHub workflow run receipt is absent");
  }
  const receipt = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Reviewed GitHub workflow run receipt",
  );
  return readReviewedWorkflowRunAuthority({
    namespace,
    repository: repository ?? receipt?.repository,
    expectedRunId: receipt?.runId,
    expectedRunAttempt: receipt?.runAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
    reference,
    store,
  });
};

export const collectReviewedWorkflowRunAuthority = async ({
  fetchImpl = fetch,
  githubToken,
  namespace,
  repository,
  expectedRunId,
  expectedRunAttempt,
  expectedSourceSha,
  expectedWorkflowPath,
  store,
}) => {
  assertOptions({
    namespace,
    repository,
    expectedRunId,
    expectedRunAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
    store,
  });
  if (
    typeof fetchImpl !== "function" ||
    typeof githubToken !== "string" ||
    githubToken.length < 8
  ) {
    throw new Error(
      "Reviewed GitHub workflow run authority options are invalid",
    );
  }
  const requestUrl = `https://api.github.com/repos/${repository
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/actions/runs/${expectedRunId}`;
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${githubToken}`,
        "user-agent": "event-shopping-planner-foundation-release",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
    });
  } catch {
    throw new Error("Reviewed GitHub workflow run lookup failed");
  }
  const responseBytes = await readBoundedResponse(response);
  const run = parseJsonStrict(
    responseBytes.toString("utf8"),
    "GitHub workflow run",
  );
  assertRun({
    run,
    repository,
    expectedRunId,
    expectedRunAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
  });
  const apiResponse = await putExact({
    store,
    namespace,
    bytes: responseBytes,
    mediaType: GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
    label: "Reviewed GitHub workflow run response",
  });
  const receiptBytes = canonicalJsonBytes({
    schemaVersion: 1,
    kind: "reviewed-github-workflow-run/v1",
    repository,
    runId: expectedRunId,
    runAttempt: expectedRunAttempt,
    workflowPath: expectedWorkflowPath,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    headSha: expectedSourceSha,
    apiResponse,
  });
  const receipt = await putExact({
    store,
    namespace,
    bytes: receiptBytes,
    mediaType: REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
    label: "Reviewed GitHub workflow run receipt",
  });
  await readReviewedWorkflowRunAuthority({
    namespace,
    repository,
    expectedRunId,
    expectedRunAttempt,
    expectedSourceSha,
    expectedWorkflowPath,
    reference: receipt,
    store,
  });
  return { apiResponse, receipt, receiptBytes };
};
