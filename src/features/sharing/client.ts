import { getSharingAvailability, supabase } from '../../lib/supabase';
import type { AppData, SharingSessionMetadata } from '../../utils/indexedDB';
import { db } from '../../utils/indexedDB';
import type { AssignmentMemberProfile, PurchaseStatus, ShoppingItem } from '../../types/item';
import type { Json } from '../../lib/database.types';
import {
  ROOM_EVENT_DATA_SCHEMA_VERSION,
  SHARING_CONTRACT_VERSION,
  type SharingEnvelope,
  type SharingErrorEnvelope,
  type SharingSuccessEnvelope,
} from './contracts';
import {
  canonicalCreateRoomPayload,
  type CanonicalCreateRoomPayload,
} from './canonicalCreateRoomPayload';
import {
  parseRoomEventData,
  type RoomEventDataPayload,
  type RoomEventJson,
} from './roomEventDataSchema';
import {
  prepareCreateRoomViaPublicGuard,
  prepareJoinViaPublicGuard,
  prepareRestoreViaPublicGuard,
} from './publicGuardClient';
import type { SharingAvailability } from '../../lib/supabase';

const MEMBER_KEY_STORAGE_PREFIX = 'sharing.memberKey.v1';

type RpcJson = Json | undefined;

const publicGuardUnavailableEnvelope = <T>(): SharingEnvelope<T> => ({
  ok: false,
  error: {
    code: 'GUARD_UNAVAILABLE',
    contract_version: SHARING_CONTRACT_VERSION,
  },
});

const isPublicGuardRequiredButUnavailable = (
  availability: SharingAvailability,
): boolean =>
  !availability.enabled && availability.reason === 'PUBLIC_GUARD_UNCONFIGURED';

export type SharingAuthSession = {
  userId: string;
};

export type CreateSharingRoomInput = {
  roomId: string;
  displayName: string;
  rawRoomEventDataJson: string;
  itemCount: number;
  memberKey: string;
};

export type CreateSharingRoomResult = {
  roomId: string;
  roomCode: string;
  hostMemberId: string;
  expiresAt: string;
  itemsVersion: number;
  routeOrderVersion: number | null;
  routeOrderVersions: Record<string, number>;
  tokenContext: string;
};

export type PreparedMemberToken = {
  challengeId: string;
  roomId: string;
  tokenContext: string;
  expiresAt: string;
};

export type JoinSharingRoomResult = {
  roomId: string;
  roomMemberId: string;
  tokenContext: string;
};

export type SnapshotRoomItem = {
  localItemId: string;
  eventDate: string | null;
  name: string;
  purchaseStatus: PurchaseStatus;
  price: number | null;
  quantity: number | null;
  limitQuantity: number | null;
  actualPurchaseQuantity: number | null;
  remarks: string | null;
  url: string | null;
  assignedTo: string | null;
  securedBy: string | null;
  orderIndex: number | null;
  postponed: boolean;
  itemVersion: number;
  updatedAt: string;
};

export type RoomSnapshot = {
  room: {
    roomId: string;
    eventName: string;
    hostMemberId: string;
    itemsVersion: number;
    routeOrderVersion: number | null;
    expiresAt: string;
    sharingStatus: 'active';
  };
  currentMember: {
    roomMemberId: string;
    displayName: string;
    color: string | null;
    role: 'host' | 'member';
  };
  members: Array<{
    roomMemberId: string;
    displayName: string;
    color: string | null;
    role: 'host' | 'member';
    membershipStatus: 'active' | 'left';
  }>;
  items: SnapshotRoomItem[];
  eventData: RoomEventDataPayload;
  snapshot: {
    receiptId: string;
    itemsVersion: number;
    routeOrderVersion: number | null;
    routeOrderVersions: Record<string, number>;
    notificationWatermarkCreatedAt: string | null;
    notificationWatermarkId: string | null;
    createdAt: string;
  };
};

export type AckRoomSnapshotResult = {
  roomId: string;
  roomMemberId: string;
  snapshotReceiptId: string;
  itemsVersion: number;
  routeOrderVersions: Record<string, number>;
};

export type HeartbeatRoomSessionResult = {
  roomId: string;
  roomMemberId: string;
  lastSeenAt: string;
};

export type PauseRoomSessionResult = {
  roomId: string;
  roomMemberId: string;
  pausedAt: string;
};

export type LeaveRoomResult = {
  roomId: string;
  roomMemberId: string;
  membershipStatus: 'left';
  leftAt: string;
};

export type RoomMembersForDisplayResult = {
  roomId: string;
  members: AssignmentMemberProfile[];
};

export type RoomItemMutationResult = {
  roomId: string;
  itemsVersion: number;
  changedFields: string[];
  updatedValues: Record<string, Json>;
  fieldUpdatedAt: Record<string, string>;
  notificationId?: string;
  item: SnapshotRoomItem;
};

export type BulkRoomItemAssignmentResult = {
  roomId: string;
  itemsVersion: number;
  assignedToMemberId: string;
  changedItems: RoomItemMutationResult[];
};

export type UpdateRoomItemFieldsInput = {
  roomId: string;
  localItemId: string;
  fields: {
    price?: number | null;
    quantity?: number | null;
    actualPurchaseQuantity?: number | null;
    remarks?: string | null;
    url?: string | null;
  };
};

export type ClaimRoomItemInput = {
  roomId: string;
  localItemId: string;
  status: PurchaseStatus;
  actualPurchaseQuantity?: number | null;
};

export type UpdateRoomItemWithPurchaseInput = UpdateRoomItemFieldsInput & {
  status?: PurchaseStatus | null;
  actualPurchaseQuantity?: number | null;
};

export type AssignRoomItemInput = {
  roomId: string;
  localItemId: string;
  assignedToMemberId: string;
};

export type BulkAssignRoomItemsInput = {
  roomId: string;
  localItemIds: string[];
  assignedToMemberId: string;
};

export type RoomVersions = {
  roomId: string;
  itemsVersion: number;
  routeOrderVersion: number | null;
  routeOrderVersions?: Record<string, number>;
  roomEventDataUpdatedAt?: string | null;
  expiresAt: string;
  isActive: boolean;
};

export type RouteOrderByDateResult = {
  roomId: string;
  eventDate: string;
  itemIds: string[];
  dateRouteOrderVersion: number;
  routeOrderVersion: number;
};

export type UpdateRouteOrderInput = {
  roomId: string;
  eventDate: string;
  itemIds: string[];
  expectedVersion: number;
};

export type UpdateRouteOrderResult = RouteOrderByDateResult & {
  routeOrderVersions: Record<string, number>;
  notificationId: string | null;
};

export type RoomItemChange = {
  changeId: string;
  localItemId: string;
  itemsVersion: number;
  updatedFields: string[];
  updatedValues: Record<string, Json>;
  fieldUpdatedAt: Record<string, string>;
  updatedByMemberId: string | null;
  notificationId: string | null;
  createdAt: string;
};

export type RoomItemChangesResult = {
  roomId: string;
  fromItemsVersion: number;
  itemsVersion: number;
  changes: RoomItemChange[];
};

export type RoomNotification = {
  id: string;
  eventId: string;
  idempotencyKey: string;
  notificationType: string;
  targetMemberId: string | null;
  payload: Json;
  createdAt: string;
};

export type NotificationListItem = RoomNotification & {
  readAt: string | null;
  hiddenAt: string | null;
};

export type NotificationListResult = {
  roomId: string;
  limit: number;
  notifications: NotificationListItem[];
};

export type NotificationReadStateResult = {
  roomId: string;
  notificationId: string;
  readAt: string | null;
  hiddenAt: string | null;
};

export type RoomNotificationsResult = {
  roomId: string;
  limit: number;
  events?: RoomNotification[];
  notifications: RoomNotification[];
  nextWatermarkCreatedAt: string | null;
  nextWatermarkId: string | null;
  hasMore: boolean;
  serverHighWatermarkCreatedAt: string | null;
  serverHighWatermarkId: string | null;
};

export type RoomNotificationsCatchUpResult = RoomNotificationsResult & {
  events: RoomNotification[];
  pageCount: number;
};

export type ProcessedSyncEvent = {
  event_id: string;
  processed_at: string;
};

export type AckRoomSyncProgressResult = {
  roomId: string;
  roomMemberId: string;
  itemsVersion: number;
  lastProcessedEventCreatedAt: string | null;
  lastProcessedEventId: string | null;
};

export type AckRoomRouteOrderVersionsResult = {
  roomId: string;
  roomMemberId: string;
  routeOrderVersions: Record<string, number>;
};

export type RoomSyncRealtimeEvent = {
  table: 'room_items' | 'notifications' | 'room_members' | 'room_route_order_versions';
  eventType: string;
  roomId: string;
  id: string | null;
  itemsVersion?: number | null;
  createdAt?: string | null;
  targetMemberId?: string | null;
  eventDate?: string | null;
  routeOrderVersion?: number | null;
};

export type RoomSyncSubscription = {
  unsubscribe: () => void;
};

const applyRoomItemUpdatedValue = (
  item: ShoppingItem,
  field: string,
  value: Json | undefined,
): ShoppingItem => {
  switch (field) {
    case 'purchaseStatus':
      return typeof value === 'string'
        ? { ...item, purchaseStatus: value as PurchaseStatus }
        : item;
    case 'price':
      return typeof value === 'number' || value === null
        ? { ...item, price: value }
        : item;
    case 'quantity':
      return typeof value === 'number'
        ? { ...item, quantity: value }
        : value === null
          ? { ...item, quantity: 1 }
          : item;
    case 'actualPurchaseQuantity':
      return typeof value === 'number'
        ? { ...item, limitedPurchasedQuantity: value }
        : { ...item, limitedPurchasedQuantity: undefined };
    case 'remarks':
      return typeof value === 'string'
        ? { ...item, remarks: value }
        : value === null
          ? { ...item, remarks: '' }
          : item;
    case 'url':
      return typeof value === 'string'
        ? { ...item, url: value }
        : { ...item, url: undefined };
    case 'securedBy':
      return typeof value === 'string'
        ? { ...item, securedBy: value }
        : { ...item, securedBy: undefined };
    case 'assignedTo':
      return typeof value === 'string'
        ? { ...item, assignedTo: value }
        : { ...item, assignedTo: undefined };
    case 'postponed':
      return typeof value === 'boolean' ? { ...item, postponed: value } : item;
    default:
      return item;
  }
};

export const applyRoomItemChangesToItems = (
  items: ShoppingItem[],
  changes: RoomItemChange[],
): ShoppingItem[] => {
  if (changes.length === 0) return items;

  const changesByItem = changes.reduce<Record<string, RoomItemChange[]>>(
    (acc, change) => {
      acc[change.localItemId] = [...(acc[change.localItemId] ?? []), change];
      return acc;
    },
    {},
  );

  return items.map((item) => {
    const itemChanges = changesByItem[item.id];
    if (!itemChanges) return item;

    return itemChanges
      .slice()
      .sort((a, b) => a.itemsVersion - b.itemsVersion)
      .reduce((current, change) => {
        const patched = change.updatedFields.reduce(
          (next, field) =>
            applyRoomItemUpdatedValue(next, field, change.updatedValues[field]),
          current,
        );
        return {
          ...patched,
          lastSyncedAt: change.createdAt,
        };
      }, item);
  });
};

export const mergeSnapshotRoomItemIntoShoppingItem = (
  item: ShoppingItem,
  snapshot: SnapshotRoomItem,
): ShoppingItem => ({
  ...item,
  price: snapshot.price,
  purchaseStatus: snapshot.purchaseStatus,
  quantity: snapshot.quantity ?? 1,
  limitedPurchasedQuantity: snapshot.actualPurchaseQuantity ?? undefined,
  remarks: snapshot.remarks ?? '',
  url: snapshot.url ?? undefined,
  assignedTo: snapshot.assignedTo ?? undefined,
  securedBy: snapshot.securedBy ?? undefined,
  lastSyncedAt: snapshot.updatedAt,
  orderIndex: snapshot.orderIndex ?? undefined,
  postponed: snapshot.postponed,
});

export class SharingClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharingClientError';
  }
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof btoa === 'function') {
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
  }

  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
};

const sha256Base64Url = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toBase64Url(new Uint8Array(digest));
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const normalizeEnvelope = <T>(value: RpcJson): SharingEnvelope<T> => {
  const envelope = asObject(value);
  if (envelope.ok === true) {
    return {
      ok: true,
      data: envelope.data as T,
      contract_version:
        typeof envelope.contract_version === 'number'
          ? envelope.contract_version
          : SHARING_CONTRACT_VERSION,
    } satisfies SharingSuccessEnvelope<T>;
  }

  const errorObject = asObject(envelope.error);
  return {
    ok: false,
    error: {
      code:
        typeof errorObject.code === 'string'
          ? (errorObject.code as SharingErrorEnvelope['error']['code'])
          : 'SHARING_INTERNAL_ERROR',
      retry_after_seconds:
        typeof errorObject.retry_after_seconds === 'number'
          ? errorObject.retry_after_seconds
          : undefined,
      contract_version:
        typeof errorObject.contract_version === 'number'
          ? errorObject.contract_version
          : SHARING_CONTRACT_VERSION,
      request_id:
        typeof errorObject.request_id === 'string'
          ? errorObject.request_id
          : undefined,
    },
  };
};

const requireSupabase = () => {
  const availability = getSharingAvailability();
  if (!supabase || !availability.enabled) {
    throw new SharingClientError('Sharing requires Supabase configuration.');
  }
  return supabase;
};

export const subscribeToRoomSync = (
  roomId: string,
  onEvent: (event: RoomSyncRealtimeEvent) => void,
  onStatus?: (status: string) => void,
): RoomSyncSubscription => {
  const client = requireSupabase();
  const channel = client
    .channel(`room-sync:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'room_items',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        const row = asObject(payload.new);
        onEvent({
          table: 'room_items',
          eventType: payload.eventType,
          roomId: typeof row.room_id === 'string' ? row.room_id : roomId,
          id: typeof row.id === 'string' ? row.id : null,
          itemsVersion: typeof row.item_version === 'number' ? row.item_version : null,
        });
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'room_members',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        const row = asObject(payload.new);
        onEvent({
          table: 'room_members',
          eventType: payload.eventType,
          roomId: typeof row.room_id === 'string' ? row.room_id : roomId,
          id: typeof row.id === 'string' ? row.id : null,
        });
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'notifications',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        const row = asObject(payload.new);
        onEvent({
          table: 'notifications',
          eventType: payload.eventType,
          roomId: typeof row.room_id === 'string' ? row.room_id : roomId,
          id: typeof row.id === 'string' ? row.id : null,
          createdAt: typeof row.created_at === 'string' ? row.created_at : null,
          targetMemberId:
            typeof row.target_member_id === 'string' ? row.target_member_id : null,
        });
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'room_route_order_versions',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        const row = asObject(payload.new);
        onEvent({
          table: 'room_route_order_versions',
          eventType: payload.eventType,
          roomId: typeof row.room_id === 'string' ? row.room_id : roomId,
          id: null,
          eventDate: typeof row.event_date === 'string' ? row.event_date : null,
          routeOrderVersion: typeof row.version === 'number' ? row.version : null,
        });
      },
    );

  channel.subscribe((status) => {
    onStatus?.(status);
  });

  return {
    unsubscribe: () => {
      void client.removeChannel(channel);
    },
  };
};

export const createClientRoomId = (): string => globalThis.crypto.randomUUID();

export const generateMemberKey = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

export const buildMemberKeyStorageKey = (roomId: string): string =>
  `${MEMBER_KEY_STORAGE_PREFIX}.${roomId}`;

export const loadMemberKey = (roomId: string): string | null =>
  localStorage.getItem(buildMemberKeyStorageKey(roomId));

export const saveMemberKey = (roomId: string, memberKey: string): void => {
  localStorage.setItem(buildMemberKeyStorageKey(roomId), memberKey);
};

export const forgetMemberKey = (roomId: string): void => {
  localStorage.removeItem(buildMemberKeyStorageKey(roomId));
};

export const deriveMemberRestoreToken = async (
  tokenContext: string,
  memberKey: string,
): Promise<string> => sha256Base64Url(`${tokenContext}:${memberKey}`);

export const ensureAnonymousSession = async (): Promise<SharingEnvelope<SharingAuthSession>> => {
  const client = requireSupabase();
  const sessionResult = await client.auth.getSession();
  const existingUserId = sessionResult.data.session?.user.id;
  if (existingUserId) {
    return {
      ok: true,
      data: { userId: existingUserId },
      contract_version: SHARING_CONTRACT_VERSION,
    };
  }

  const signInResult = await client.auth.signInAnonymously();
  if (signInResult.error || !signInResult.data.user?.id) {
    return {
      ok: false,
      error: {
        code: 'ANONYMOUS_AUTH_UNAVAILABLE',
        contract_version: SHARING_CONTRACT_VERSION,
      },
    };
  }

  return {
    ok: true,
    data: { userId: signInResult.data.user.id },
    contract_version: SHARING_CONTRACT_VERSION,
  };
};

export const canonicalizeRoomEventDataForCreate = async (
  rawJson: string,
): Promise<CanonicalCreateRoomPayload> =>
  canonicalCreateRoomPayload(rawJson, {
    validate: (value) => {
      parseRoomEventData(value);
    },
  });

export const createSharingRoom = async (
  input: CreateSharingRoomInput,
): Promise<SharingEnvelope<CreateSharingRoomResult>> => {
  const availability = getSharingAvailability();
  if (isPublicGuardRequiredButUnavailable(availability)) {
    return publicGuardUnavailableEnvelope();
  }

  const auth = await ensureAnonymousSession();
  if (!auth.ok) {
    return auth;
  }

  const client = requireSupabase();
  const canonical = await canonicalizeRoomEventDataForCreate(input.rawRoomEventDataJson);
  const prepared =
    availability.enabled && availability.mode === 'public_guard'
      ? await prepareCreateRoomViaPublicGuard({
          roomId: input.roomId,
          canonicalPayload: canonical.canonicalText,
          plaintextFingerprint: canonical.fingerprint,
          itemCount: input.itemCount,
          canonicalSchemaVersion: ROOM_EVENT_DATA_SCHEMA_VERSION,
          payloadProtectionMode: 'encrypted',
        })
      : normalizeEnvelope<{
          challengeId: string;
          roomId: string;
        }>(
          (
            await client.rpc('prepare_create_room_challenge', {
              p_client_room_id: input.roomId,
              p_canonical_payload: canonical.canonicalText,
              p_plaintext_fingerprint: canonical.fingerprint,
              p_item_count: input.itemCount,
              p_canonical_schema_version: ROOM_EVENT_DATA_SCHEMA_VERSION,
              p_payload_protection_mode: 'encrypted',
            })
          ).data,
        );
  if (!prepared.ok) {
    return prepared;
  }

  const tokenContext = `restore:v1:${input.roomId}`;
  const memberRestoreToken = await deriveMemberRestoreToken(tokenContext, input.memberKey);
  const createResult = await client.rpc('create_room', {
    p_room_id: input.roomId,
    p_display_name: input.displayName,
    p_member_restore_token: memberRestoreToken,
    p_challenge_id: prepared.data.challengeId,
  });
  if (createResult.error) {
    return normalizeEnvelope<CreateSharingRoomResult>(undefined);
  }

  const envelope = normalizeEnvelope<CreateSharingRoomResult>(createResult.data);
  if (envelope.ok) {
    saveMemberKey(input.roomId, input.memberKey);
  }
  return envelope;
};

export const prepareJoinRoom = async (
  roomCode: string,
): Promise<SharingEnvelope<PreparedMemberToken>> => {
  const availability = getSharingAvailability();
  if (isPublicGuardRequiredButUnavailable(availability)) {
    return publicGuardUnavailableEnvelope();
  }

  const auth = await ensureAnonymousSession();
  if (!auth.ok) {
    return auth;
  }

  if (availability.enabled && availability.mode === 'public_guard') {
    return prepareJoinViaPublicGuard(roomCode);
  }

  const result = await requireSupabase().rpc('prepare_room_member_token', {
    p_room_code: roomCode,
  });
  if (result.error) {
    return normalizeEnvelope<PreparedMemberToken>(undefined);
  }
  return normalizeEnvelope<PreparedMemberToken>(result.data);
};

export const joinPreparedRoom = async (
  prepared: PreparedMemberToken,
  displayName: string,
  memberKey: string,
): Promise<SharingEnvelope<JoinSharingRoomResult>> => {
  const memberRestoreToken = await deriveMemberRestoreToken(
    prepared.tokenContext,
    memberKey,
  );
  const result = await requireSupabase().rpc('join_room_by_code', {
    p_challenge_id: prepared.challengeId,
    p_member_restore_token: memberRestoreToken,
    p_display_name: displayName,
  });
  if (result.error) {
    return normalizeEnvelope<JoinSharingRoomResult>(undefined);
  }

  const envelope = normalizeEnvelope<JoinSharingRoomResult>(result.data);
  if (envelope.ok) {
    saveMemberKey(envelope.data.roomId, memberKey);
  }
  return envelope;
};

export const prepareRestoreRoom = async (
  roomId: string,
): Promise<SharingEnvelope<PreparedMemberToken>> => {
  const availability = getSharingAvailability();
  if (isPublicGuardRequiredButUnavailable(availability)) {
    return publicGuardUnavailableEnvelope();
  }

  const auth = await ensureAnonymousSession();
  if (!auth.ok) {
    return auth;
  }

  if (availability.enabled && availability.mode === 'public_guard') {
    return prepareRestoreViaPublicGuard(roomId);
  }

  const result = await requireSupabase().rpc('prepare_restore_member_token', {
    p_room_id: roomId,
  });
  if (result.error) {
    return normalizeEnvelope<PreparedMemberToken>(undefined);
  }
  return normalizeEnvelope<PreparedMemberToken>(result.data);
};

export const restorePreparedRoom = async (
  prepared: PreparedMemberToken,
  memberKey: string,
): Promise<SharingEnvelope<JoinSharingRoomResult>> => {
  const memberRestoreToken = await deriveMemberRestoreToken(
    prepared.tokenContext,
    memberKey,
  );
  const result = await requireSupabase().rpc('restore_member_by_key', {
    p_challenge_id: prepared.challengeId,
    p_member_restore_token: memberRestoreToken,
  });
  if (result.error) {
    return normalizeEnvelope<JoinSharingRoomResult>(undefined);
  }
  return normalizeEnvelope<JoinSharingRoomResult>(result.data);
};

const toRoomSnapshot = (value: unknown): RoomSnapshot => {
  const snapshot = value as RoomSnapshot;
  return {
    ...snapshot,
    eventData: parseRoomEventData(snapshot.eventData),
  };
};

export const getRoomSnapshot = async (
  roomId: string,
): Promise<SharingEnvelope<RoomSnapshot>> => {
  const result = await requireSupabase().rpc('get_room_snapshot', {
    p_room_id: roomId,
  });
  if (result.error) {
    return normalizeEnvelope<RoomSnapshot>(undefined);
  }

  const envelope = normalizeEnvelope<unknown>(result.data);
  if (!envelope.ok) {
    return envelope;
  }

  return {
    ok: true,
    data: toRoomSnapshot(envelope.data),
    contract_version: envelope.contract_version,
  };
};

export const ackRoomSnapshot = async (
  roomId: string,
  snapshotReceiptId: string,
): Promise<SharingEnvelope<AckRoomSnapshotResult>> => {
  const result = await requireSupabase().rpc('ack_room_snapshot_watermark', {
    p_room_id: roomId,
    p_snapshot_receipt_id: snapshotReceiptId,
  });
  if (result.error) {
    return normalizeEnvelope<AckRoomSnapshotResult>(undefined);
  }
  return normalizeEnvelope<AckRoomSnapshotResult>(result.data);
};

export const heartbeatRoomSession = async (
  roomId: string,
): Promise<SharingEnvelope<HeartbeatRoomSessionResult>> => {
  const result = await requireSupabase().rpc('heartbeat_room_session', {
    p_room_id: roomId,
  });
  if (result.error) {
    return normalizeEnvelope<HeartbeatRoomSessionResult>(undefined);
  }
  return normalizeEnvelope<HeartbeatRoomSessionResult>(result.data);
};

export const pauseRoomSession = async (
  roomId: string,
): Promise<SharingEnvelope<PauseRoomSessionResult>> => {
  const result = await requireSupabase().rpc('pause_room_session', {
    p_room_id: roomId,
  });
  if (result.error) {
    return normalizeEnvelope<PauseRoomSessionResult>(undefined);
  }
  return normalizeEnvelope<PauseRoomSessionResult>(result.data);
};

export const leaveRoom = async (
  roomId: string,
): Promise<SharingEnvelope<LeaveRoomResult>> => {
  const result = await requireSupabase().rpc('leave_room', {
    p_room_id: roomId,
    p_mode: 'final',
  });
  if (result.error) {
    return normalizeEnvelope<LeaveRoomResult>(undefined);
  }
  return normalizeEnvelope<LeaveRoomResult>(result.data);
};

export const getRoomMembersForDisplay = async (
  roomId: string,
): Promise<SharingEnvelope<RoomMembersForDisplayResult>> => {
  const result = await requireSupabase().rpc('get_room_members_for_display', {
    p_room_id: roomId,
  });
  if (result.error) {
    return normalizeEnvelope<RoomMembersForDisplayResult>(undefined);
  }
  return normalizeEnvelope<RoomMembersForDisplayResult>(result.data);
};

export const updateRoomItemFields = async (
  input: UpdateRoomItemFieldsInput,
): Promise<SharingEnvelope<RoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('update_room_item_fields', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_fields: input.fields,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemMutationResult>(undefined);
  }
  return normalizeEnvelope<RoomItemMutationResult>(result.data);
};

export const claimRoomItem = async (
  input: ClaimRoomItemInput,
): Promise<SharingEnvelope<RoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('claim_item', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_status: input.status,
    p_actual_purchase_quantity: input.actualPurchaseQuantity ?? undefined,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemMutationResult>(undefined);
  }
  return normalizeEnvelope<RoomItemMutationResult>(result.data);
};

export const updateRoomItemWithPurchase = async (
  input: UpdateRoomItemWithPurchaseInput,
): Promise<SharingEnvelope<RoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('update_room_item_with_purchase', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_fields: input.fields,
    p_status: input.status ?? undefined,
    p_actual_purchase_quantity: input.actualPurchaseQuantity ?? undefined,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemMutationResult>(undefined);
  }
  return normalizeEnvelope<RoomItemMutationResult>(result.data);
};

export const assignRoomItem = async (
  input: AssignRoomItemInput,
): Promise<SharingEnvelope<RoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('assign_item', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_assigned_to: input.assignedToMemberId,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemMutationResult>(undefined);
  }
  return normalizeEnvelope<RoomItemMutationResult>(result.data);
};

export const bulkAssignRoomItems = async (
  input: BulkAssignRoomItemsInput,
): Promise<SharingEnvelope<BulkRoomItemAssignmentResult>> => {
  const result = await requireSupabase().rpc('bulk_assign_items', {
    p_room_id: input.roomId,
    p_local_item_ids: input.localItemIds,
    p_assigned_to: input.assignedToMemberId,
  });
  if (result.error) {
    return normalizeEnvelope<BulkRoomItemAssignmentResult>(undefined);
  }
  return normalizeEnvelope<BulkRoomItemAssignmentResult>(result.data);
};

export const getRoomVersions = async (
  roomId: string,
): Promise<SharingEnvelope<RoomVersions>> => {
  const result = await requireSupabase().rpc('get_room_versions', {
    p_room_id: roomId,
  });
  if (result.error) {
    return normalizeEnvelope<RoomVersions>(undefined);
  }
  return normalizeEnvelope<RoomVersions>(result.data);
};

export const getRouteOrderByDate = async (
  roomId: string,
  eventDate: string,
): Promise<SharingEnvelope<RouteOrderByDateResult>> => {
  const result = await requireSupabase().rpc('get_route_order_by_date', {
    p_room_id: roomId,
    p_event_date: eventDate,
  });
  if (result.error) {
    return normalizeEnvelope<RouteOrderByDateResult>(undefined);
  }
  return normalizeEnvelope<RouteOrderByDateResult>(result.data);
};

export const updateRouteOrder = async (
  input: UpdateRouteOrderInput,
): Promise<SharingEnvelope<UpdateRouteOrderResult>> => {
  const result = await requireSupabase().rpc('update_route_order', {
    p_room_id: input.roomId,
    p_event_date: input.eventDate,
    p_item_ids: input.itemIds,
    p_expected_version: input.expectedVersion,
  });
  if (result.error) {
    return normalizeEnvelope<UpdateRouteOrderResult>(undefined);
  }
  return normalizeEnvelope<UpdateRouteOrderResult>(result.data);
};

export const getRoomItemChangesSince = async (
  roomId: string,
  sinceItemsVersion: number,
): Promise<SharingEnvelope<RoomItemChangesResult>> => {
  const result = await requireSupabase().rpc('get_room_item_changes_since', {
    p_room_id: roomId,
    p_since_items_version: sinceItemsVersion,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemChangesResult>(undefined);
  }
  return normalizeEnvelope<RoomItemChangesResult>(result.data);
};

export const getNotificationsAfterWatermark = async (
  roomId: string,
  afterCreatedAt: string | null,
  afterId: string | null,
  limit = 100,
): Promise<SharingEnvelope<RoomNotificationsResult>> => {
  const result = await requireSupabase().rpc('get_notifications_after_watermark', {
    p_room_id: roomId,
    p_after_created_at: afterCreatedAt ?? undefined,
    p_after_id: afterId ?? undefined,
    p_limit: limit,
  });
  if (result.error) {
    return normalizeEnvelope<RoomNotificationsResult>(undefined);
  }
  return normalizeEnvelope<RoomNotificationsResult>(result.data);
};

export const getNotificationList = async (
  roomId: string,
  limit = 50,
  includeHidden = false,
): Promise<SharingEnvelope<NotificationListResult>> => {
  const result = await requireSupabase().rpc('get_notification_list', {
    p_room_id: roomId,
    p_limit: limit,
    p_include_hidden: includeHidden,
  });
  if (result.error) {
    return normalizeEnvelope<NotificationListResult>(undefined);
  }
  return normalizeEnvelope<NotificationListResult>(result.data);
};

export const markNotificationRead = async (
  roomId: string,
  notificationId: string,
  isRead = true,
): Promise<SharingEnvelope<NotificationReadStateResult>> => {
  const result = await requireSupabase().rpc('mark_notification_read', {
    p_room_id: roomId,
    p_notification_id: notificationId,
    p_is_read: isRead,
  });
  if (result.error) {
    return normalizeEnvelope<NotificationReadStateResult>(undefined);
  }
  return normalizeEnvelope<NotificationReadStateResult>(result.data);
};

export const hideNotification = async (
  roomId: string,
  notificationId: string,
  isHidden = true,
): Promise<SharingEnvelope<NotificationReadStateResult>> => {
  const result = await requireSupabase().rpc('hide_notification', {
    p_room_id: roomId,
    p_notification_id: notificationId,
    p_is_hidden: isHidden,
  });
  if (result.error) {
    return normalizeEnvelope<NotificationReadStateResult>(undefined);
  }
  return normalizeEnvelope<NotificationReadStateResult>(result.data);
};

const compareWatermarks = (
  leftCreatedAt: string | null,
  leftId: string | null,
  rightCreatedAt: string | null,
  rightId: string | null,
): number => {
  if (leftCreatedAt === rightCreatedAt) {
    return (leftId ?? '').localeCompare(rightId ?? '');
  }
  if (leftCreatedAt === null) return rightCreatedAt === null ? 0 : -1;
  if (rightCreatedAt === null) return 1;
  return leftCreatedAt.localeCompare(rightCreatedAt);
};

const isAtOrBeforeWatermark = (
  notification: RoomNotification,
  ceilingCreatedAt: string | null,
  ceilingId: string | null,
): boolean =>
  ceilingCreatedAt === null ||
  compareWatermarks(notification.createdAt, notification.id, ceilingCreatedAt, ceilingId) <= 0;

export const filterNotificationsAtOrBeforeWatermark = (
  notifications: RoomNotification[],
  ceilingCreatedAt: string | null,
  ceilingId: string | null,
): RoomNotification[] =>
  notifications.filter((notification) =>
    isAtOrBeforeWatermark(notification, ceilingCreatedAt, ceilingId),
  );

export const getRoomNotificationEvents = (
  result: RoomNotificationsResult,
): RoomNotification[] => result.events ?? result.notifications;

export type NotificationCatchUpPageSummary = {
  included: RoomNotification[];
  nextCursorCreatedAt: string | null;
  nextCursorId: string | null;
  shouldContinue: boolean;
};

export const summarizeNotificationCatchUpPage = (
  result: RoomNotificationsResult,
  ceilingCreatedAt: string | null,
  ceilingId: string | null,
): NotificationCatchUpPageSummary => {
  const pageEvents = getRoomNotificationEvents(result);
  const included = filterNotificationsAtOrBeforeWatermark(
    pageEvents,
    ceilingCreatedAt,
    ceilingId,
  );
  const latestIncluded = included[included.length - 1];
  if (!latestIncluded) {
    return {
      included,
      nextCursorCreatedAt: null,
      nextCursorId: null,
      shouldContinue: false,
    };
  }

  const nextCursorCreatedAt = latestIncluded.createdAt;
  const nextCursorId = latestIncluded.id;
  const reachedCeiling =
    ceilingCreatedAt !== null &&
    compareWatermarks(nextCursorCreatedAt, nextCursorId, ceilingCreatedAt, ceilingId) >= 0;
  const pageCrossedCeiling = included.length < pageEvents.length;

  return {
    included,
    nextCursorCreatedAt,
    nextCursorId,
    shouldContinue: result.hasMore && !reachedCeiling && !pageCrossedCeiling,
  };
};

const notificationCatchUpError = (): SharingErrorEnvelope => ({
  ok: false,
  error: {
    code: 'FULL_NOTIFICATION_REFRESH_REQUIRED',
    contract_version: SHARING_CONTRACT_VERSION,
  },
});

export const getAllNotificationsAfterWatermark = async (
  roomId: string,
  afterCreatedAt: string | null,
  afterId: string | null,
  limit = 100,
  maxPages = 50,
): Promise<SharingEnvelope<RoomNotificationsCatchUpResult>> => {
  const collected: RoomNotification[] = [];
  let cursorCreatedAt = afterCreatedAt;
  let cursorId = afterId;
  let ceilingCreatedAt: string | null = null;
  let ceilingId: string | null = null;
  let pageCount = 0;
  let lastPage: RoomNotificationsResult | null = null;

  while (pageCount < maxPages) {
    const page = await getNotificationsAfterWatermark(
      roomId,
      cursorCreatedAt,
      cursorId,
      limit,
    );
    if (!page.ok) return page;

    pageCount += 1;
    lastPage = page.data;
    if (pageCount === 1) {
      ceilingCreatedAt = page.data.serverHighWatermarkCreatedAt;
      ceilingId = page.data.serverHighWatermarkId;
    }

    const pageSummary = summarizeNotificationCatchUpPage(
      page.data,
      ceilingCreatedAt,
      ceilingId,
    );
    collected.push(...pageSummary.included);

    if (!pageSummary.nextCursorCreatedAt || !pageSummary.nextCursorId) {
      break;
    }

    cursorCreatedAt = pageSummary.nextCursorCreatedAt;
    cursorId = pageSummary.nextCursorId;

    if (!pageSummary.shouldContinue) {
      break;
    }
  }

  if (pageCount >= maxPages && lastPage?.hasMore) {
    return notificationCatchUpError();
  }

  return {
    ok: true,
    contract_version: SHARING_CONTRACT_VERSION,
    data: {
      roomId,
      limit,
      notifications: collected,
      events: collected,
      nextWatermarkCreatedAt: cursorCreatedAt,
      nextWatermarkId: cursorId,
      hasMore: false,
      serverHighWatermarkCreatedAt: ceilingCreatedAt,
      serverHighWatermarkId: ceilingId,
      pageCount,
    },
  };
};

export const ackRoomSyncProgress = async (
  roomId: string,
  itemsVersion: number,
  lastProcessedEventCreatedAt: string | null,
  lastProcessedEventId: string | null,
  processedEventIds: ProcessedSyncEvent[] = [],
): Promise<SharingEnvelope<AckRoomSyncProgressResult>> => {
  const result = await requireSupabase().rpc('ack_room_sync_progress', {
    p_room_id: roomId,
    p_items_version: itemsVersion,
    p_last_processed_event_created_at: lastProcessedEventCreatedAt ?? undefined,
    p_last_processed_event_id: lastProcessedEventId ?? undefined,
    p_processed_event_ids: processedEventIds,
  });
  if (result.error) {
    return normalizeEnvelope<AckRoomSyncProgressResult>(undefined);
  }
  return normalizeEnvelope<AckRoomSyncProgressResult>(result.data);
};

export const ackRoomRouteOrderVersions = async (
  roomId: string,
  routeOrderVersions: Record<string, number>,
): Promise<SharingEnvelope<AckRoomRouteOrderVersionsResult>> => {
  const result = await requireSupabase().rpc('ack_room_route_order_versions', {
    p_room_id: roomId,
    p_route_order_versions: routeOrderVersions,
  });
  if (result.error) {
    return normalizeEnvelope<AckRoomRouteOrderVersionsResult>(undefined);
  }
  return normalizeEnvelope<AckRoomRouteOrderVersionsResult>(result.data);
};

const getString = (
  value: Record<string, RoomEventJson> | undefined,
  key: string,
  fallback = '',
): string => {
  const raw = value?.[key];
  return typeof raw === 'string' ? raw : fallback;
};

const getStringOrUndefined = (
  value: Record<string, RoomEventJson> | undefined,
  key: string,
): string | undefined => {
  const raw = value?.[key];
  return typeof raw === 'string' ? raw : undefined;
};

const normalizeSnapshotItem = (
  item: SnapshotRoomItem,
  staticSnapshot: Record<string, RoomEventJson> | undefined,
): ShoppingItem => ({
  id: item.localItemId,
  circle: getString(staticSnapshot, 'circle', item.name),
  eventDate: item.eventDate ?? getString(staticSnapshot, 'eventDate'),
  block: getString(staticSnapshot, 'block'),
  number: getString(staticSnapshot, 'number'),
  title: getString(staticSnapshot, 'title', item.name),
  price: item.price,
  purchaseStatus: item.purchaseStatus,
  quantity: item.quantity ?? 1,
  limitedPurchasedQuantity: item.actualPurchaseQuantity ?? undefined,
  remarks: item.remarks ?? '',
  url: item.url ?? undefined,
  priorityLevel: getStringOrUndefined(staticSnapshot, 'priorityLevel') as
    | ShoppingItem['priorityLevel']
    | undefined,
  protectionLevel: getStringOrUndefined(staticSnapshot, 'protectionLevel') as
    | ShoppingItem['protectionLevel']
    | undefined,
  source: getStringOrUndefined(staticSnapshot, 'source') as
    | ShoppingItem['source']
    | undefined,
  assignedTo: item.assignedTo ?? undefined,
  securedBy: item.securedBy ?? undefined,
  lastSyncedAt: item.updatedAt,
  orderIndex: item.orderIndex ?? undefined,
  postponed: item.postponed,
  manualHallId: getStringOrUndefined(staticSnapshot, 'manualHallId'),
});

export const roomSnapshotToAppData = (
  snapshot: RoomSnapshot,
  currentAppData?: AppData,
): AppData => {
  const eventName = snapshot.room.eventName;
  const itemSnapshots = snapshot.eventData.itemSnapshots;
  const eventItems = snapshot.items.map((item) =>
    normalizeSnapshotItem(item, itemSnapshots[item.localItemId]),
  );

  return {
    eventLists: {
      ...(currentAppData?.eventLists ?? {}),
      [eventName]: eventItems,
    },
    eventMetadata: {
      ...(currentAppData?.eventMetadata ?? {}),
      [eventName]: snapshot.eventData.eventMetadata,
    },
    executeModeItems: {
      ...(currentAppData?.executeModeItems ?? {}),
      [eventName]: snapshot.eventData.routeOrderByDate,
    },
    dayModes: {
      ...(currentAppData?.dayModes ?? {}),
      [eventName]: snapshot.eventData.dayModes,
    },
    mapData: {
      ...(currentAppData?.mapData ?? {}),
      [eventName]: snapshot.eventData.mapData,
    },
    mapRotationSettings: {
      ...(currentAppData?.mapRotationSettings ?? {}),
      [eventName]: snapshot.eventData.mapRotationSettings,
    },
    routeSettings: {
      ...(currentAppData?.routeSettings ?? {}),
      [eventName]: snapshot.eventData.routeSettings,
    },
    hallDefinitions: {
      ...(currentAppData?.hallDefinitions ?? {}),
      [eventName]: snapshot.eventData.hallDefinitions as Record<string, unknown[]>,
    },
    hallRouteSettings: {
      ...(currentAppData?.hallRouteSettings ?? {}),
      [eventName]: snapshot.eventData.hallRouteSettings,
    },
    mapViewportSettings: {
      ...(currentAppData?.mapViewportSettings ?? {}),
      [eventName]: snapshot.eventData.mapViewportSettings,
    },
  };
};

export const buildSharingSessionMetadata = (
  snapshot: RoomSnapshot,
): SharingSessionMetadata => ({
  sessionId: snapshot.room.roomId,
  roomId: snapshot.room.roomId,
  roomMemberId: snapshot.currentMember.roomMemberId,
  eventName: snapshot.room.eventName,
  role: snapshot.currentMember.role,
  status: 'active',
  startedAt: snapshot.snapshot.createdAt,
  expiresAt: snapshot.room.expiresAt,
  itemsVersion: snapshot.snapshot.itemsVersion,
  routeOrderVersions: snapshot.snapshot.routeOrderVersions,
  lastSnapshotReceiptId: snapshot.snapshot.receiptId,
  lastProcessedEventCreatedAt: snapshot.snapshot.notificationWatermarkCreatedAt,
  lastProcessedEventId: snapshot.snapshot.notificationWatermarkId,
  memberProfileSnapshot: snapshot.members.map(
    (member): AssignmentMemberProfile => ({
      roomMemberId: member.roomMemberId,
      displayName: member.displayName,
      color: member.color,
      role: member.role,
      membershipStatus: member.membershipStatus,
    }),
  ),
});

export const commitSnapshotThenAck = async (
  snapshot: RoomSnapshot,
  currentAppData?: AppData,
): Promise<SharingEnvelope<AckRoomSnapshotResult>> => {
  const appData = roomSnapshotToAppData(snapshot, currentAppData);
  const session = buildSharingSessionMetadata(snapshot);

  await db.commitSharingSnapshot({
    appData,
    session,
    staging: {
      snapshotReceiptId: snapshot.snapshot.receiptId,
      roomId: snapshot.room.roomId,
      roomMemberId: snapshot.currentMember.roomMemberId,
      receivedAt: new Date().toISOString(),
      payload: snapshot,
    },
  });

  const ack = await ackRoomSnapshot(snapshot.room.roomId, snapshot.snapshot.receiptId);
  if (ack.ok) {
    await db.saveSharingSession({
      ...session,
      lastAckAt: new Date().toISOString(),
      itemsVersion: ack.data.itemsVersion,
      routeOrderVersions: ack.data.routeOrderVersions,
    });
  }
  return ack;
};
