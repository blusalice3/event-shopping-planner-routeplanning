import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";

export const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_RESPONSE_BYTES = 512 * 1024;
const verifiedApprovals = new WeakSet();

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fetchGithubJson = async ({
  url,
  githubToken,
  fetchImpl,
  allowNotFound = false,
}) => {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.url && response.url !== url) {
    throw new Error("GitHub approval API response URL differs");
  }
  if (allowNotFound && response.status === 404) {
    return { response, value: null };
  }
  if (response.status !== 200 || typeof response.arrayBuffer !== "function") {
    throw new Error(`GitHub approval API returned HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("GitHub approval API response is oversized");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error("GitHub approval API response is empty or oversized");
  }
  return {
    response,
    value: parseJsonStrict(bytes.toString("utf8"), "GitHub approval API"),
    responseSha256: sha256Bytes(bytes),
  };
};

const assertPolicy = (policy) => {
  const teams = Object.values(policy.roles ?? {}).map(
    (role) => role?.reviewerTeam,
  );
  if (
    policy.bindingStatus !== "configured" ||
    typeof policy.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository) ||
    typeof policy.protectedEnvironment !== "string" ||
    policy.protectedEnvironment.length === 0 ||
    teams.length !== 3 ||
    teams.some(
      (team) =>
        typeof team !== "string" ||
        !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(team),
    ) ||
    new Set(teams).size !== teams.length
  ) {
    throw new Error("GitHub approval policy is not fully configured");
  }
};

const reviewMatchesEnvironment = (review, environment) =>
  isRecord(review) &&
  review.state === "approved" &&
  Array.isArray(review.environments) &&
  review.environments.some(
    (candidate) =>
      isRecord(candidate) &&
      candidate.name === environment &&
      Number.isSafeInteger(candidate.id) &&
      candidate.id > 0,
  ) &&
  isRecord(review.user) &&
  Number.isSafeInteger(review.user.id) &&
  review.user.id > 0 &&
  typeof review.user.login === "string" &&
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(review.user.login) &&
  typeof review.user.node_id === "string" &&
  review.user.node_id.length > 0;

const resolveReviewerRole = async ({
  policy,
  owner,
  review,
  githubToken,
  fetchImpl,
}) => {
  const memberships = [];
  for (const [role, rolePolicy] of Object.entries(policy.roles)) {
    const url =
      `${GITHUB_API_ORIGIN}/orgs/${encodeURIComponent(owner)}/teams/` +
      `${encodeURIComponent(rolePolicy.reviewerTeam)}/memberships/` +
      encodeURIComponent(review.user.login);
    const { value } = await fetchGithubJson({
      url,
      githubToken,
      fetchImpl,
      allowNotFound: true,
    });
    if (value === null) continue;
    if (
      !isRecord(value) ||
      value.state !== "active" ||
      !["member", "maintainer"].includes(value.role)
    ) {
      throw new Error("GitHub reviewer team membership is invalid");
    }
    memberships.push({
      role,
      reviewerTeam: rolePolicy.reviewerTeam,
    });
  }
  if (memberships.length !== 1) {
    throw new Error(
      "GitHub reviewer must belong to exactly one configured approval team",
    );
  }
  return memberships[0];
};

export const fetchGitHubProtectedEnvironmentApprovals = async ({
  policy,
  githubToken,
  operationId,
  subjectSha256,
  expectedRunId,
  fetchImpl = fetch,
}) => {
  assertPolicy(policy);
  if (
    typeof githubToken !== "string" ||
    githubToken.length < 20 ||
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(subjectSha256) ||
    !/^[1-9][0-9]*$/.test(expectedRunId)
  ) {
    throw new Error("GitHub approval request binding is invalid");
  }
  const [owner, repository] = policy.repository.split("/");
  const reviewUrl =
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repository)}/actions/runs/${expectedRunId}/approvals`;
  const reviewResult = await fetchGithubJson({
    url: reviewUrl,
    githubToken,
    fetchImpl,
  });
  if (!Array.isArray(reviewResult.value)) {
    throw new Error("GitHub approval history is not an array");
  }
  const candidates = reviewResult.value.filter((review) =>
    reviewMatchesEnvironment(review, policy.protectedEnvironment),
  );
  if (candidates.length === 0) {
    throw new Error("GitHub protected environment has no approved review");
  }
  const providerDate = reviewResult.response.headers?.get?.("date");
  const approvedAtMilliseconds = Date.parse(providerDate ?? "");
  if (!Number.isFinite(approvedAtMilliseconds)) {
    throw new Error("GitHub approval response lacks an authoritative Date");
  }

  const results = [];
  for (const review of candidates) {
    const membership = await resolveReviewerRole({
      policy,
      owner,
      review,
      githubToken,
      fetchImpl,
    });
    const providerReviewerId = String(review.user.id);
    const approvalId = sha256Json({
      schemaVersion: 1,
      workflowRunId: expectedRunId,
      protectedEnvironment: policy.protectedEnvironment,
      providerReviewerId,
      providerReviewerNodeId: review.user.node_id,
      role: membership.role,
      providerResponseSha256: reviewResult.responseSha256,
    });
    const receipt = {
      schemaVersion: 1,
      kind: "github-protected-environment-approval/v1",
      approvalId,
      operationId,
      subjectSha256,
      decision: "APPROVED",
      providerReviewerId,
      providerReviewerLogin: review.user.login,
      providerReviewerNodeId: review.user.node_id,
      providerReviewerTeamIds: [membership.reviewerTeam],
      role: membership.role,
      workflowRunId: expectedRunId,
      protectedEnvironment: policy.protectedEnvironment,
      providerResponseSha256: reviewResult.responseSha256,
      approvedAt: new Date(approvedAtMilliseconds).toISOString(),
    };
    const result = {
      receipt,
      receiptBytes: canonicalJsonBytes(receipt),
    };
    verifiedApprovals.add(result);
    results.push(result);
  }
  if (
    new Set(results.map(({ receipt }) => receipt.approvalId)).size !==
    results.length
  ) {
    throw new Error("GitHub approval history contains duplicate approvals");
  }
  return results;
};

export const assertVerifiedGitHubApprovalResult = (result) => {
  if (!isRecord(result) || !verifiedApprovals.has(result)) {
    throw new Error("Approval receipt was not resolved from the GitHub API");
  }
  return result;
};
