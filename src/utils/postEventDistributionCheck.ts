export const POST_EVENT_DISTRIBUTION_REMARK_LABEL = "通販･頒布確認:";

export const POST_EVENT_DISTRIBUTION_OPTIONS = [
  "通販有(メロン等)",
  "BOOTH有",
  "別イベント頒布有",
  "通販･別イベ頒布無",
] as const;

export const POST_EVENT_DISTRIBUTION_UNCONFIRMED = "未確認";

export type PostEventDistributionAnswer =
  | (typeof POST_EVENT_DISTRIBUTION_OPTIONS)[number]
  | typeof POST_EVENT_DISTRIBUTION_UNCONFIRMED;

export const normalizePostEventDistributionAnswer = (
  value: string,
): PostEventDistributionAnswer =>
  POST_EVENT_DISTRIBUTION_OPTIONS.includes(
    value as (typeof POST_EVENT_DISTRIBUTION_OPTIONS)[number],
  )
    ? (value as (typeof POST_EVENT_DISTRIBUTION_OPTIONS)[number])
    : POST_EVENT_DISTRIBUTION_UNCONFIRMED;

export const upsertPostEventDistributionRemark = (
  remarks: string,
  value: PostEventDistributionAnswer,
): string => {
  const nextRemark = `${POST_EVENT_DISTRIBUTION_REMARK_LABEL} ${value}`;
  const existingPattern = new RegExp(
    `${POST_EVENT_DISTRIBUTION_REMARK_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\S*`,
  );

  if (existingPattern.test(remarks)) {
    return remarks.replace(existingPattern, nextRemark);
  }

  const trimmed = remarks.trim();
  return trimmed ? `${trimmed} ${nextRemark}` : nextRemark;
};
