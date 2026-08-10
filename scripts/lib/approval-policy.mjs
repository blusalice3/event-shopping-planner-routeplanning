export const FORMAL_APPROVAL_ROLES = Object.freeze([
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
]);

const TEAM_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const assertConfiguredApprovalRolePolicy = (
  policy,
  label = "Approval policy",
) => {
  const roleKeys = isRecord(policy?.roles)
    ? Object.keys(policy.roles).sort()
    : [];
  const expectedRoleKeys = [...FORMAL_APPROVAL_ROLES].sort();
  const reviewerTeams = FORMAL_APPROVAL_ROLES.map(
    (role) => policy?.roles?.[role]?.reviewerTeam,
  );
  if (
    policy?.bindingStatus !== "configured" ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0 ||
    roleKeys.length !== expectedRoleKeys.length ||
    roleKeys.some((role, index) => role !== expectedRoleKeys[index]) ||
    reviewerTeams.some(
      (reviewerTeam) =>
        typeof reviewerTeam !== "string" ||
        !TEAM_SLUG_PATTERN.test(reviewerTeam),
    ) ||
    new Set(reviewerTeams).size !== reviewerTeams.length ||
    policy.humanOperatorModel !== "single-human-single-github-account/v1" ||
    policy.distinctApprovalIds !== true ||
    policy.distinctProviderReviewerIds !== false
  ) {
    throw new Error(`${label} role binding is not configured`);
  }
  return Object.freeze(
    Object.fromEntries(
      FORMAL_APPROVAL_ROLES.map((role, index) => [role, reviewerTeams[index]]),
    ),
  );
};
