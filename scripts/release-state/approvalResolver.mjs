import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { assertVerifiedGitHubApprovalResult } from "./githubApprovalReceipt.mjs";
import { assertVerifiedGitHubOidcResult } from "./githubOidc.mjs";

const assertExactReceiptBinding = ({
  policy,
  receipt,
  issuerReceipt,
  operationId,
  subjectSha256,
}) => {
  if (issuerReceipt.issuer !== policy.trustedIssuer) {
    throw new Error("Approval issuer is not trusted");
  }
  if (issuerReceipt.claims.repository !== policy.repository) {
    throw new Error("Approval repository does not match policy");
  }
  if (issuerReceipt.claims.workflowRef !== policy.workflowRef) {
    throw new Error("Approval workflow does not match policy");
  }
  if (issuerReceipt.claims.environment !== policy.protectedEnvironment) {
    throw new Error("Approval protected environment does not match policy");
  }
  if (
    receipt.operationId !== operationId ||
    receipt.subjectSha256 !== subjectSha256
  ) {
    throw new Error("Approval subject does not match the release operation");
  }
  if (receipt.decision !== "APPROVED") {
    throw new Error("Approval receipt is not approved");
  }
  if (
    typeof receipt.approvalId !== "string" ||
    receipt.approvalId.length === 0 ||
    typeof receipt.providerReviewerId !== "string" ||
    receipt.providerReviewerId.length === 0 ||
    !Array.isArray(receipt.providerReviewerTeamIds) ||
    receipt.providerReviewerTeamIds.some(
      (team) => typeof team !== "string" || team.length === 0,
    ) ||
    typeof receipt.workflowRunId !== "string" ||
    receipt.workflowRunId !== issuerReceipt.claims.runId ||
    typeof receipt.approvedAt !== "string" ||
    !Number.isFinite(new Date(receipt.approvedAt).getTime())
  ) {
    throw new Error("Approval receipt shape is invalid");
  }
  const matchingRoles = Object.entries(policy.roles ?? {})
    .filter(
      ([, rolePolicy]) =>
        typeof rolePolicy.reviewerTeam === "string" &&
        rolePolicy.reviewerTeam.length > 0 &&
        receipt.providerReviewerTeamIds.length === 1 &&
        receipt.providerReviewerTeamIds[0] === rolePolicy.reviewerTeam,
    )
    .map(([role]) => role);
  if (matchingRoles.length !== 1) {
    throw new Error("Approval reviewer is not a member of the configured team");
  }
  const [resolvedRole] = matchingRoles;
  if (receipt.role !== resolvedRole) {
    throw new Error(
      "Approval role self-claim differs from authoritative membership",
    );
  }
  return resolvedRole;
};

export const resolveApprovalReference = ({
  policy,
  receiptReference,
  issuerReceiptReference,
  verifiedApprovalResult,
  verifiedOidcResult,
  operationId,
  subjectSha256,
}) => {
  if (policy.bindingStatus !== "configured") {
    throw new Error(
      `Approval policy is not configured: ${(policy.blockerCodes ?? []).join(", ")}`,
    );
  }
  const verifiedApproval = assertVerifiedGitHubApprovalResult(
    verifiedApprovalResult,
  );
  const verifiedOidc = assertVerifiedGitHubOidcResult(verifiedOidcResult);
  const receiptBytes = verifiedApproval.receiptBytes;
  const receiptSha256 = sha256Bytes(receiptBytes);
  const issuerReceiptSha256 = sha256Bytes(verifiedOidc.receiptBytes);
  const receiptUri = new RegExp(
    `^release-state://([a-z0-9][a-z0-9-]{2,62})/evidence/${receiptSha256}$`,
  ).exec(receiptReference?.uri ?? "");
  if (
    receiptUri === null ||
    receiptReference.sha256 !== receiptSha256 ||
    !issuerReceiptReference ||
    typeof issuerReceiptReference.uri !== "string" ||
    issuerReceiptReference.uri !==
      `release-state://${receiptUri[1]}/evidence/${issuerReceiptSha256}` ||
    issuerReceiptReference.sha256 !== issuerReceiptSha256 ||
    !/^[0-9a-f]{64}$/.test(subjectSha256)
  ) {
    throw new Error("Approval issuer reference or subject is invalid");
  }
  const receipt = parseJsonStrict(
    Buffer.from(receiptBytes).toString("utf8"),
    "approval receipt",
  );
  if (!canonicalJsonBytes(receipt).equals(receiptBytes)) {
    throw new Error(
      "Approval receipt bytes differ from the verified API result",
    );
  }
  const resolvedRole = assertExactReceiptBinding({
    policy,
    receipt,
    issuerReceipt: verifiedOidc.receipt,
    operationId,
    subjectSha256,
  });
  return {
    uri: receiptReference.uri,
    sha256: receiptSha256,
    approvalId: receipt.approvalId,
    operationId,
    subjectSha256,
    trustedIssuer: policy.trustedIssuer,
    issuerReceiptUri: issuerReceiptReference.uri,
    issuerReceiptSha256: issuerReceiptReference.sha256,
    workflowRunId: verifiedOidc.receipt.claims.runId,
    protectedEnvironment: policy.protectedEnvironment,
    providerReviewerId: receipt.providerReviewerId,
    role: resolvedRole,
    decision: "APPROVED",
    approvedAt: receipt.approvedAt,
  };
};

export const assertRequiredApprovalSet = (approvals, requiredRoles) => {
  if (
    new Set(requiredRoles).size !== requiredRoles.length ||
    approvals.length !== requiredRoles.length
  ) {
    throw new Error("Approval set must contain exactly the required roles");
  }
  if (
    approvals.some(
      (approval) =>
        approval === null ||
        typeof approval !== "object" ||
        typeof approval.approvalId !== "string" ||
        approval.approvalId.length === 0 ||
        typeof approval.providerReviewerId !== "string" ||
        approval.providerReviewerId.length === 0,
    )
  ) {
    throw new Error("Approval identities are invalid");
  }
  if (
    new Set(approvals.map((approval) => approval.approvalId)).size !==
    approvals.length
  ) {
    throw new Error("Approval IDs are not distinct");
  }
  for (const role of requiredRoles) {
    if (!approvals.some((approval) => approval.role === role)) {
      throw new Error(`Required approval role is absent: ${role}`);
    }
  }
  for (const role of requiredRoles) {
    const matching = approvals.filter((approval) => approval.role === role);
    if (matching.length !== 1) {
      throw new Error(`Required approval role repeats: ${role}`);
    }
    const [approval] = matching;
    if (
      approval.decision !== "APPROVED" ||
      typeof approval.approvedAt !== "string" ||
      !Number.isFinite(new Date(approval.approvedAt).getTime())
    ) {
      throw new Error(`Required approval role is invalid: ${role}`);
    }
  }
  return true;
};
