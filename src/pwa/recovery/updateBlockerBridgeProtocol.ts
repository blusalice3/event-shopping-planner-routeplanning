export const ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE =
  "ESP_PWA_ROLE_BLOCKER_SNAPSHOT_REQUEST" as const;
export const ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE =
  "ESP_PWA_ROLE_BLOCKER_SNAPSHOT_RESPONSE" as const;
export const ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION = 1 as const;

export type UpdateBlockerSnapshot = {
  clientId: string;
  capturedAt: string;
  responsive: boolean;
  blockers: Array<{ id: string; label: string }>;
  flushError: boolean;
};

export type RoleBlockerSnapshotRequest = {
  type: typeof ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE;
  protocolVersion: typeof ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  clientId: string;
  flush: boolean;
};

export type RoleBlockerSnapshotResponse = {
  type: typeof ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE;
  protocolVersion: typeof ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  snapshot: UpdateBlockerSnapshot;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
};

export const isBridgeRequestId = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export const isClientId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
  });

const isCapturedAt = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const isBlocker = (
  value: unknown,
): value is UpdateBlockerSnapshot["blockers"][number] =>
  isRecord(value) &&
  hasExactKeys(value, ["id", "label"]) &&
  typeof value.id === "string" &&
  BLOCKER_ID_PATTERN.test(value.id) &&
  typeof value.label === "string" &&
  value.label.trim().length > 0 &&
  value.label.length <= 160;

export const isUpdateBlockerSnapshot = (
  value: unknown,
): value is UpdateBlockerSnapshot => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "blockers",
      "capturedAt",
      "clientId",
      "flushError",
      "responsive",
    ]) ||
    !isClientId(value.clientId) ||
    !isCapturedAt(value.capturedAt) ||
    typeof value.responsive !== "boolean" ||
    !Array.isArray(value.blockers) ||
    value.blockers.length > 256 ||
    !value.blockers.every(isBlocker) ||
    typeof value.flushError !== "boolean"
  ) {
    return false;
  }
  return (
    new Set(value.blockers.map(({ id }) => id)).size === value.blockers.length
  );
};

export const isRoleBlockerSnapshotRequest = (
  value: unknown,
): value is RoleBlockerSnapshotRequest =>
  isRecord(value) &&
  hasExactKeys(value, [
    "clientId",
    "flush",
    "protocolVersion",
    "requestId",
    "type",
  ]) &&
  value.type === ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE &&
  value.protocolVersion === ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION &&
  isBridgeRequestId(value.requestId) &&
  isClientId(value.clientId) &&
  typeof value.flush === "boolean";

export const isRoleBlockerSnapshotResponse = (
  value: unknown,
): value is RoleBlockerSnapshotResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["protocolVersion", "requestId", "snapshot", "type"]) &&
  value.type === ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE &&
  value.protocolVersion === ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION &&
  isBridgeRequestId(value.requestId) &&
  isUpdateBlockerSnapshot(value.snapshot);

export const cloneUpdateBlockerSnapshot = (
  snapshot: UpdateBlockerSnapshot,
): UpdateBlockerSnapshot => ({
  ...snapshot,
  blockers: snapshot.blockers.map((blocker) => ({ ...blocker })),
});
