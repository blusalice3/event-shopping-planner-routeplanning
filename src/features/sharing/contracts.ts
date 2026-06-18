export const SHARING_CONTRACT_VERSION = 1 as const;
export const ROOM_EVENT_DATA_SCHEMA_VERSION = 1 as const;

export const MAX_ROOM_MEMBERS = 20;
export const MVP_TARGET_ROOM_ITEMS = 1000;
export const MAX_ROOM_ITEMS = 5000;
export const MAX_ROOM_EVENT_DATA_BYTES = 5 * 1024 * 1024;
export const MAX_CANONICAL_CREATE_PAYLOAD_BYTES = 10 * 1024 * 1024;

export const SHARING_ERROR_CODES = [
  'AUTH_REQUIRED',
  'ANONYMOUS_AUTH_UNAVAILABLE',
  'CLIENT_UPGRADE_REQUIRED',
  'SHARING_DISABLED',
  'GUARD_REQUIRED',
  'GUARD_UNAVAILABLE',
  'CONTRACT_VERSION_MISMATCH',
  'RATE_LIMITED',
  'INVALID_REQUEST',
  'CHALLENGE_INVALID',
  'ROOM_UNAVAILABLE',
  'ROOM_EXPIRED',
  'ROOM_MEMBER_LIMIT_REACHED',
  'CREATE_PAYLOAD_TOO_LARGE',
  'PAYLOAD_PROTECTION_REQUIRED',
  'SNAPSHOT_CONFLICT',
  'SNAPSHOT_RECEIPT_INVALID',
  'RESTORE_REQUIRED',
  'ITEM_DIFF_EXPIRED',
  'FULL_ITEM_REFRESH_REQUIRED',
  'NOTIFICATION_CATCHUP_EXPIRED',
  'FULL_NOTIFICATION_REFRESH_REQUIRED',
  'ROUTE_ORDER_CONFLICT',
  'PERMISSION_DENIED',
  'SHARING_INTERNAL_ERROR',
] as const;

export type SharingErrorCode = (typeof SHARING_ERROR_CODES)[number];

export type SharingErrorEnvelope = {
  ok: false;
  error: {
    code: SharingErrorCode;
    retry_after_seconds?: number;
    contract_version: number;
    request_id?: string;
  };
};

export type SharingSuccessEnvelope<T> = {
  ok: true;
  data: T;
  contract_version: number;
};

export type SharingEnvelope<T> =
  | SharingSuccessEnvelope<T>
  | SharingErrorEnvelope;
