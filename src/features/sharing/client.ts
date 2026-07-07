import { getSharingAvailability, supabase } from '../../lib/supabase';
import type { AppData, SharingSessionMetadata } from '../../utils/indexedDB';
import { db } from '../../utils/indexedDB';
import {
  ItemSources,
  ProtectionLevels,
  PurchaseStatuses,
  type AssignmentMemberProfile,
  type PurchaseStatus,
  type ShoppingItem,
} from '../../types/item';
import type { Json } from '../../lib/database.types';
import {
  ROOM_EVENT_DATA_SCHEMA_VERSION,
  SHARING_CONTRACT_VERSION,
  isSharingErrorCode,
  type SharingEnvelope,
  type SharingErrorEnvelope,
  type SharingSuccessEnvelope,
} from './contracts';
import {
  CanonicalPayloadError,
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

type CreateRoomChallenge = {
  challengeId: string;
  roomId: string;
};

// Supabase typegen marks RPC args without defaults as non-null, while Postgres accepts explicit nulls.
const nullableRpcArg = <T>(value: T | null): T => value as T;

const publicGuardUnavailableEnvelope = <T>(): SharingEnvelope<T> => ({
  ok: false,
  error: {
    code: 'GUARD_UNAVAILABLE',
    contract_version: SHARING_CONTRACT_VERSION,
  },
});

const canonicalPayloadErrorEnvelope = <T>(error: unknown): SharingEnvelope<T> | null => {
  if (!(error instanceof CanonicalPayloadError)) return null;

  return {
    ok: false,
    error: {
      code: error.reason === 'PAYLOAD_TOO_LARGE' ? 'CREATE_PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      contract_version: SHARING_CONTRACT_VERSION,
    },
  };
};

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

export type RoomItemFieldClock = {
  itemsVersion: number;
  updatedAt: string;
};

export type RoomItemFieldClocks = Record<string, RoomItemFieldClock>;

export type DeletedItemClockMetadata = {
  deletedAt: string;
  deletedBy: string | null;
  fieldClocks: RoomItemFieldClocks;
  itemVersion: number;
  updatedAt: string;
};

type DeletedItemClockSnapshotEntry = DeletedItemClockMetadata | RoomItemFieldClocks;

export type SnapshotRoomItem = {
  localItemId: string;
  circle: string;
  block: string;
  number: string;
  title: string;
  eventDate: string | null;
  name?: string;
  priorityLevel: ShoppingItem['priorityLevel'] | null;
  protectionLevel: ShoppingItem['protectionLevel'] | null;
  source: ShoppingItem['source'] | null;
  manualHallId: string | null;
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
  deletedAt: string | null;
  deletedBy: string | null;
  itemVersion: number;
  updatedAt: string;
  fieldClocks: RoomItemFieldClocks;
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
    deletedItemClocks?: Record<string, DeletedItemClockSnapshotEntry>;
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
  fieldClocks?: RoomItemFieldClocks;
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
    assignedTo?: string | null;
  };
};

export type UpdateRoomItemWithPurchaseInput = UpdateRoomItemFieldsInput & {
  status?: PurchaseStatus | null;
  actualPurchaseQuantity?: number | null;
  expectedFieldClocks: RoomItemFieldClocks;
};

export type RouteOrderUpdate = {
  eventDate: string;
  itemIds: string[];
  expectedVersion: number;
};

export type UpsertRoomItemWithRouteInput = {
  roomId: string;
  localItemId: string;
  fields: Record<string, Json>;
  routeUpdates: RouteOrderUpdate[];
  expectedFieldClocks: RoomItemFieldClocks;
};

export type DeleteRoomItemWithRouteInput = {
  roomId: string;
  localItemId: string;
  routeUpdates: RouteOrderUpdate[];
  expectedFieldClocks: RoomItemFieldClocks;
};

export type BulkUpdateRoomItemsWithPurchaseInput = {
  roomId: string;
  mutations: Array<{
    localItemId: string;
    fields: Record<string, Json>;
    status?: PurchaseStatus | null;
    actualPurchaseQuantity?: number | null;
    expectedFieldClocks: RoomItemFieldClocks;
  }>;
};

export type RouteAwareRoomItemMutationResult = RoomItemMutationResult & {
  routeOrderVersion?: number | null;
  routeOrderVersions?: Record<string, number>;
  changedRouteOrders?: Array<{
    eventDate: string;
    itemIds: string[];
    dateRouteOrderVersion: number;
  }>;
  itemNotificationId?: string | null;
  routeNotificationId?: string | null;
};

export type BulkRoomItemPurchaseResult = {
  roomId: string;
  itemsVersion: number;
  changedItems: RoomItemMutationResult[];
};

export type AssignRoomItemInput = {
  roomId: string;
  localItemId: string;
  assignedToMemberId: string;
  expectedFieldClocks: RoomItemFieldClocks;
};

export type BulkAssignRoomItemsInput = {
  roomId: string;
  assignedToMemberId: string;
  assignments: Array<{
    localItemId: string;
    expectedFieldClocks: RoomItemFieldClocks;
  }>;
};

export type MemberRouteOrderUpdate = {
  eventDate: string;
  routeMemberId: string;
  itemIds: string[];
  expectedVersion: number;
};

export type UpdateRoomItemAssignmentWithMemberRoutesInput = {
  roomId: string;
  assignments: Array<{
    localItemId: string;
    assignedToMemberId: string | null;
    expectedFieldClocks: RoomItemFieldClocks;
  }>;
  memberRouteUpdates: MemberRouteOrderUpdate[];
};

export type RoomVersions = {
  roomId: string;
  itemsVersion: number;
  routeOrderVersion: number | null;
  routeOrderVersions?: Record<string, number>;
  memberRouteOrderVersions?: MemberRouteOrderVersions;
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

export type MemberRouteOrderVersions = Record<string, Record<string, number>>;

export type MemberRouteOrderByDateResult = {
  roomId: string;
  eventDate: string;
  routeMemberId: string;
  itemIds: string[];
  dateMemberRouteOrderVersion: number;
  routeOrderVersion: number;
  memberRouteOrderVersions: MemberRouteOrderVersions;
};

export type UpdateMemberRouteOrderInput = {
  roomId: string;
  eventDate: string;
  routeMemberId: string;
  itemIds: string[];
  expectedVersion: number;
};

export type UpdateMemberRouteOrderResult = MemberRouteOrderByDateResult & {
  changedMemberRouteOrders: Array<{
    eventDate: string;
    routeMemberId: string;
    itemIds: string[];
    dateMemberRouteOrderVersion: number;
  }>;
  notificationId: string | null;
};

export type AssignmentWithMemberRoutesResult = BulkRoomItemPurchaseResult & {
  routeOrderVersion: number | null;
  memberRouteOrderVersions: MemberRouteOrderVersions;
  changedMemberRouteOrders: Array<{
    eventDate: string;
    routeMemberId: string;
    itemIds: string[];
    dateMemberRouteOrderVersion: number;
  }>;
};

export type RoomItemChange = {
  changeId: string;
  localItemId: string;
  changeType?: 'create' | 'update' | 'delete';
  itemsVersion: number;
  updatedFields: string[];
  updatedValues: Record<string, Json>;
  fieldUpdatedAt: Record<string, string>;
  fieldClocks?: RoomItemFieldClocks;
  item?: SnapshotRoomItem;
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

export type AckRoomMemberRouteOrderVersionsResult = {
  roomId: string;
  roomMemberId: string;
  memberRouteOrderVersions: MemberRouteOrderVersions;
};

export type RoomSyncRealtimeEvent = {
  table:
    | 'room_items'
    | 'notifications'
    | 'room_members'
    | 'room_route_order_versions'
    | 'room_member_route_order_versions';
  eventType: string;
  roomId: string;
  id: string | null;
  itemsVersion?: number | null;
  createdAt?: string | null;
  targetMemberId?: string | null;
  eventDate?: string | null;
  routeMemberId?: string | null;
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
        ? {
            ...item,
            purchaseStatus: value as PurchaseStatus,
            postponed: value === 'Postpone',
          }
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
    case 'circle':
      return typeof value === 'string' ? { ...item, circle: value } : item;
    case 'block':
      return typeof value === 'string' ? { ...item, block: value } : item;
    case 'number':
      return typeof value === 'string' ? { ...item, number: value } : item;
    case 'title':
    case 'name':
      return typeof value === 'string' ? { ...item, title: value } : item;
    case 'eventDate':
      return typeof value === 'string'
        ? { ...item, eventDate: value }
        : value === null
          ? { ...item, eventDate: '' }
          : item;
    case 'priorityLevel':
      return typeof value === 'string' || value === null
        ? { ...item, priorityLevel: value as ShoppingItem['priorityLevel'] }
        : item;
    case 'protectionLevel':
      return typeof value === 'string' || value === null
        ? { ...item, protectionLevel: value as ShoppingItem['protectionLevel'] }
        : item;
    case 'source':
      return typeof value === 'string' || value === null
        ? { ...item, source: value as ShoppingItem['source'] }
        : item;
    case 'manualHallId':
      return typeof value === 'string'
        ? { ...item, manualHallId: value }
        : { ...item, manualHallId: undefined };
    default:
      return item;
  }
};

const snapshotRoomItemToShoppingItem = (snapshot: SnapshotRoomItem): ShoppingItem => ({
  id: snapshot.localItemId,
  circle: snapshot.circle,
  eventDate: snapshot.eventDate ?? '',
  block: snapshot.block,
  number: snapshot.number,
  title: snapshot.title,
  price: snapshot.price,
  purchaseStatus: snapshot.purchaseStatus,
  quantity: snapshot.quantity ?? 1,
  limitedPurchasedQuantity: snapshot.actualPurchaseQuantity ?? undefined,
  remarks: snapshot.remarks ?? '',
  url: snapshot.url ?? undefined,
  priorityLevel: snapshot.priorityLevel ?? undefined,
  protectionLevel: snapshot.protectionLevel ?? undefined,
  source: snapshot.source ?? undefined,
  assignedTo: snapshot.assignedTo ?? undefined,
  securedBy: snapshot.securedBy ?? undefined,
  lastSyncedAt: snapshot.updatedAt,
  orderIndex: snapshot.orderIndex ?? undefined,
  postponed: snapshot.purchaseStatus === 'Postpone',
  manualHallId: snapshot.manualHallId ?? undefined,
});

export const applyRoomItemChangesToItems = (
  items: ShoppingItem[],
  changes: RoomItemChange[],
): ShoppingItem[] => {
  if (changes.length === 0) return items;

  const itemsById = new Map(items.map((item) => [item.id, item]));
  let itemOrder = items.map((item) => item.id);

  changes
    .slice()
    .sort((a, b) => a.itemsVersion - b.itemsVersion)
    .forEach((change) => {
      if (change.changeType === 'delete') {
        itemsById.delete(change.localItemId);
        itemOrder = itemOrder.filter((itemId) => itemId !== change.localItemId);
        return;
      }

      if (change.changeType === 'create') {
        if (!change.item) return;
        const createdItem = snapshotRoomItemToShoppingItem(change.item);
        itemsById.set(createdItem.id, createdItem);
        if (!itemOrder.includes(createdItem.id)) {
          itemOrder = [...itemOrder, createdItem.id];
        }
        return;
      }

      const currentItem = itemsById.get(change.localItemId);
      if (!currentItem) return;
      const patched = change.updatedFields.reduce(
        (next, field) => applyRoomItemUpdatedValue(next, field, change.updatedValues[field]),
        currentItem,
      );
      itemsById.set(change.localItemId, {
        ...patched,
        lastSyncedAt: change.createdAt,
      });
    });

  return itemOrder
    .map((itemId) => itemsById.get(itemId))
    .filter((item): item is ShoppingItem => item !== undefined);
};

export const mergeSnapshotRoomItemIntoShoppingItem = (
  item: ShoppingItem,
  snapshot: SnapshotRoomItem,
): ShoppingItem => ({
  ...item,
  circle: snapshot.circle,
  eventDate: snapshot.eventDate ?? '',
  block: snapshot.block,
  number: snapshot.number,
  title: snapshot.title,
  price: snapshot.price,
  purchaseStatus: snapshot.purchaseStatus,
  quantity: snapshot.quantity ?? 1,
  limitedPurchasedQuantity: snapshot.actualPurchaseQuantity ?? undefined,
  remarks: snapshot.remarks ?? '',
  url: snapshot.url ?? undefined,
  priorityLevel: snapshot.priorityLevel ?? undefined,
  protectionLevel: snapshot.protectionLevel ?? undefined,
  source: snapshot.source ?? undefined,
  assignedTo: snapshot.assignedTo ?? undefined,
  securedBy: snapshot.securedBy ?? undefined,
  lastSyncedAt: snapshot.updatedAt,
  orderIndex: snapshot.orderIndex ?? undefined,
  postponed: snapshot.purchaseStatus === 'Postpone',
  manualHallId: snapshot.manualHallId ?? undefined,
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isRecordOfNonNegativeIntegers = (value: unknown): value is Record<string, number> =>
  isPlainObject(value) && Object.values(value).every(isNonNegativeInteger);

const isNestedRecordOfNonNegativeIntegers = (
  value: unknown,
): value is Record<string, Record<string, number>> =>
  isPlainObject(value) && Object.values(value).every(isRecordOfNonNegativeIntegers);

const isUniqueNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every(isNonEmptyString) &&
  new Set(value).size === value.length;

const isUniqueStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string') &&
  new Set(value).size === value.length;

const parseClockUpdatedAtMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isNullableTimestampString = (value: unknown): value is string | null =>
  value === null || parseClockUpdatedAtMs(value) !== null;

const isRoomItemFieldClock = (value: unknown): value is RoomItemFieldClock => {
  const clock = asObject(value);
  return isNonNegativeInteger(clock.itemsVersion) && parseClockUpdatedAtMs(clock.updatedAt) !== null;
};

const hasMonotonicRoomItemFieldClocks = (fieldClocks: RoomItemFieldClocks): boolean => {
  const clocks = Object.values(fieldClocks).map((clock) => ({
    itemsVersion: clock.itemsVersion,
    updatedAtMs: parseClockUpdatedAtMs(clock.updatedAt) ?? 0,
  }));

  return clocks.every((clock, index) =>
    clocks.every(
      (other, otherIndex) =>
        index === otherIndex ||
        clock.itemsVersion >= other.itemsVersion ||
        clock.updatedAtMs <= other.updatedAtMs,
    ),
  );
};

const isRoomItemFieldClocks = (value: unknown): value is RoomItemFieldClocks => {
  if (!isPlainObject(value)) return false;
  return (
    Object.values(value).every(isRoomItemFieldClock) &&
    hasMonotonicRoomItemFieldClocks(value as RoomItemFieldClocks)
  );
};

const hasFieldClockEntriesForUpdatedFields = (
  updatedFields: string[],
  fieldClocks: RoomItemFieldClocks,
): boolean =>
  updatedFields.every((fieldName) =>
    Object.prototype.hasOwnProperty.call(fieldClocks, fieldName),
  );

const hasUpdatedValueEntriesForUpdatedFields = (
  updatedFields: string[],
  updatedValues: Record<string, unknown>,
): boolean =>
  updatedFields.every((fieldName) =>
    Object.prototype.hasOwnProperty.call(updatedValues, fieldName),
  );

const hasFieldUpdatedAtEntriesForUpdatedFields = (
  updatedFields: string[],
  fieldUpdatedAt: Record<string, unknown>,
): boolean =>
  updatedFields.every((fieldName) => parseClockUpdatedAtMs(fieldUpdatedAt[fieldName]) !== null);

const hasConsistentFieldClockUpdatedAt = (
  updatedFields: string[],
  fieldUpdatedAt: Record<string, unknown>,
  fieldClocks: RoomItemFieldClocks,
): boolean =>
  updatedFields.every((fieldName) => {
    const updatedAtMs = parseClockUpdatedAtMs(fieldUpdatedAt[fieldName]);
    const clockUpdatedAtMs = parseClockUpdatedAtMs(fieldClocks[fieldName]?.updatedAt);
    return updatedAtMs !== null && updatedAtMs === clockUpdatedAtMs;
  });

const hasConsistentFieldClockItemsVersion = (
  updatedFields: string[],
  itemsVersion: number,
  fieldClocks: RoomItemFieldClocks,
): boolean =>
  updatedFields.every((fieldName) => fieldClocks[fieldName]?.itemsVersion === itemsVersion);

const isDeletedItemClockMetadataValue = (value: unknown): value is DeletedItemClockMetadata => {
  const metadata = asObject(value);
  return (
    parseClockUpdatedAtMs(metadata.deletedAt) !== null &&
    isNullableString(metadata.deletedBy) &&
    isRoomItemFieldClocks(metadata.fieldClocks) &&
    isNonNegativeInteger(metadata.itemVersion) &&
    parseClockUpdatedAtMs(metadata.updatedAt) !== null
  );
};

const isDeletedItemClockMetadataRecord = (
  value: unknown,
): value is Record<string, DeletedItemClockMetadata> =>
  value === undefined ||
  (isPlainObject(value) && Object.values(value).every(isDeletedItemClockMetadataValue));

const isSnapshotRoomItem = (value: unknown): value is SnapshotRoomItem => {
  const item = asObject(value);
  return (
    typeof item.localItemId === 'string' &&
    typeof item.circle === 'string' &&
    typeof item.block === 'string' &&
    typeof item.number === 'string' &&
    typeof item.title === 'string' &&
    isNullableString(item.eventDate) &&
    (item.name === undefined || typeof item.name === 'string') &&
    (item.priorityLevel === null ||
      item.priorityLevel === 'none' ||
      item.priorityLevel === 'priority' ||
      item.priorityLevel === 'highest') &&
    (item.protectionLevel === null || ProtectionLevels.includes(item.protectionLevel as never)) &&
    (item.source === null || ItemSources.includes(item.source as never)) &&
    isNullableString(item.manualHallId) &&
    PurchaseStatuses.includes(item.purchaseStatus as never) &&
    isNullableNumber(item.price) &&
    isNullableNumber(item.quantity) &&
    isNullableNumber(item.limitQuantity) &&
    isNullableNumber(item.actualPurchaseQuantity) &&
    isNullableString(item.remarks) &&
    isNullableString(item.url) &&
    isNullableString(item.assignedTo) &&
    isNullableString(item.securedBy) &&
    isNullableNumber(item.orderIndex) &&
    item.postponed === (item.purchaseStatus === 'Postpone') &&
    (item.deletedAt === null || parseClockUpdatedAtMs(item.deletedAt) !== null) &&
    isNullableString(item.deletedBy) &&
    isNonNegativeInteger(item.itemVersion) &&
    parseClockUpdatedAtMs(item.updatedAt) !== null &&
    isRoomItemFieldClocks(item.fieldClocks)
  );
};

const isRoomItemChange = (value: unknown): value is RoomItemChange => {
  const change = asObject(value);
  const changeType = change.changeType ?? 'update';
  const updatedFields = change.updatedFields;
  const fieldUpdatedAt = asObject(change.fieldUpdatedAt);
  const hasValidTopLevelFieldClocks =
    change.fieldClocks !== undefined && isRoomItemFieldClocks(change.fieldClocks);

  if (
    typeof change.changeId !== 'string' ||
    typeof change.localItemId !== 'string' ||
    (changeType !== 'create' && changeType !== 'update' && changeType !== 'delete') ||
    !isNonNegativeInteger(change.itemsVersion) ||
    !isUniqueStringArray(updatedFields) ||
    !isPlainObject(change.updatedValues) ||
    !hasUpdatedValueEntriesForUpdatedFields(updatedFields, change.updatedValues) ||
    !isPlainObject(change.fieldUpdatedAt) ||
    !hasFieldUpdatedAtEntriesForUpdatedFields(updatedFields, fieldUpdatedAt) ||
    !isNullableString(change.updatedByMemberId) ||
    !isNullableString(change.notificationId) ||
    parseClockUpdatedAtMs(change.createdAt) === null
  ) {
    return false;
  }

  if (changeType === 'create') {
    return (
      isSnapshotRoomItem(change.item) &&
      hasValidTopLevelFieldClocks &&
      hasFieldClockEntriesForUpdatedFields(
        updatedFields,
        change.fieldClocks as RoomItemFieldClocks,
      ) &&
      hasConsistentFieldClockUpdatedAt(
        updatedFields,
        fieldUpdatedAt,
        change.fieldClocks as RoomItemFieldClocks,
      ) &&
      hasConsistentFieldClockItemsVersion(
        updatedFields,
        change.itemsVersion,
        change.fieldClocks as RoomItemFieldClocks,
      )
    );
  }

  return (
    hasValidTopLevelFieldClocks &&
    hasFieldClockEntriesForUpdatedFields(updatedFields, change.fieldClocks as RoomItemFieldClocks) &&
    hasConsistentFieldClockUpdatedAt(
      updatedFields,
      fieldUpdatedAt,
      change.fieldClocks as RoomItemFieldClocks,
    ) &&
    hasConsistentFieldClockItemsVersion(
      updatedFields,
      change.itemsVersion,
      change.fieldClocks as RoomItemFieldClocks,
    )
  );
};

const isRoomItemChangesResult = (value: unknown): value is RoomItemChangesResult => {
  const result = asObject(value);
  const changes = Array.isArray(result.changes) ? result.changes : [];
  const fromItemsVersion = result.fromItemsVersion;
  const itemsVersion = result.itemsVersion;
  const hasChangesWithinVersionRange =
    isNonNegativeInteger(fromItemsVersion) &&
    isNonNegativeInteger(itemsVersion) &&
    itemsVersion >= fromItemsVersion &&
    changes.every((change) => {
      const itemChange = asObject(change);
      return (
        isNonNegativeInteger(itemChange.itemsVersion) &&
        itemChange.itemsVersion > fromItemsVersion &&
        itemChange.itemsVersion <= itemsVersion
      );
    });

  return (
    typeof result.roomId === 'string' &&
    isNonNegativeInteger(fromItemsVersion) &&
    isNonNegativeInteger(itemsVersion) &&
    Array.isArray(result.changes) &&
    hasChangesWithinVersionRange &&
    result.changes.every(isRoomItemChange)
  );
};

const isRoomItemMutationResult = (value: unknown): value is RoomItemMutationResult => {
  const result = asObject(value);
  const changedFields = result.changedFields;
  const fieldUpdatedAt = asObject(result.fieldUpdatedAt);
  const hasValidFieldClocks =
    Array.isArray(changedFields) &&
    (changedFields.length === 0 ||
      (isRoomItemFieldClocks(result.fieldClocks) &&
        hasFieldClockEntriesForUpdatedFields(changedFields, result.fieldClocks) &&
        hasConsistentFieldClockUpdatedAt(changedFields, fieldUpdatedAt, result.fieldClocks) &&
        hasConsistentFieldClockItemsVersion(
          changedFields,
          result.itemsVersion as number,
          result.fieldClocks,
        )));
  return (
    typeof result.roomId === 'string' &&
    isNonNegativeInteger(result.itemsVersion) &&
    isUniqueStringArray(changedFields) &&
    isPlainObject(result.updatedValues) &&
    hasUpdatedValueEntriesForUpdatedFields(changedFields, result.updatedValues) &&
    isPlainObject(result.fieldUpdatedAt) &&
    hasFieldUpdatedAtEntriesForUpdatedFields(changedFields, fieldUpdatedAt) &&
    hasValidFieldClocks &&
    (result.notificationId === undefined || isNullableString(result.notificationId)) &&
    isSnapshotRoomItem(result.item)
  );
};

const isCanonicalRouteOrderResult = (value: unknown): boolean => {
  const routeOrder = asObject(value);
  return (
    isNonEmptyString(routeOrder.eventDate) &&
    isUniqueNonEmptyStringArray(routeOrder.itemIds) &&
    isNonNegativeInteger(routeOrder.dateRouteOrderVersion)
  );
};

const hasConsistentChangedRouteVersions = (
  routeOrderVersions: unknown,
  changedRouteOrders: unknown,
): boolean => {
  if (routeOrderVersions === undefined || changedRouteOrders === undefined) return true;
  if (!isRecordOfNonNegativeIntegers(routeOrderVersions) || !Array.isArray(changedRouteOrders)) {
    return false;
  }

  return changedRouteOrders.every((entry) => {
    const routeOrder = asObject(entry);
    return (
      isNonEmptyString(routeOrder.eventDate) &&
      routeOrderVersions[routeOrder.eventDate] === routeOrder.dateRouteOrderVersion
    );
  });
};

const isRoomVersions = (value: unknown): value is RoomVersions => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    isNonNegativeInteger(result.itemsVersion) &&
    (result.routeOrderVersion === null || isNonNegativeInteger(result.routeOrderVersion)) &&
    isRecordOfNonNegativeIntegers(result.routeOrderVersions) &&
    (result.memberRouteOrderVersions === undefined ||
      isNestedRecordOfNonNegativeIntegers(result.memberRouteOrderVersions)) &&
    (result.roomEventDataUpdatedAt === undefined ||
      isNullableTimestampString(result.roomEventDataUpdatedAt)) &&
    parseClockUpdatedAtMs(result.expiresAt) !== null &&
    typeof result.isActive === 'boolean'
  );
};

const isRouteOrderByDateResult = (value: unknown): value is RouteOrderByDateResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    isNonEmptyString(result.eventDate) &&
    isUniqueNonEmptyStringArray(result.itemIds) &&
    isNonNegativeInteger(result.dateRouteOrderVersion) &&
    isNonNegativeInteger(result.routeOrderVersion)
  );
};

const isUpdateRouteOrderResult = (value: unknown): value is UpdateRouteOrderResult => {
  const result = asObject(value);
  return (
    isRouteOrderByDateResult(value) &&
    isRecordOfNonNegativeIntegers(result.routeOrderVersions) &&
    isNullableString(result.notificationId)
  );
};

const isMemberRouteOrderByDateResult = (
  value: unknown,
): value is MemberRouteOrderByDateResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    isNonEmptyString(result.eventDate) &&
    isNonEmptyString(result.routeMemberId) &&
    isUniqueNonEmptyStringArray(result.itemIds) &&
    isNonNegativeInteger(result.dateMemberRouteOrderVersion) &&
    isNonNegativeInteger(result.routeOrderVersion) &&
    isNestedRecordOfNonNegativeIntegers(result.memberRouteOrderVersions)
  );
};

const isCanonicalMemberRouteOrderResult = (value: unknown): boolean => {
  const routeOrder = asObject(value);
  return (
    isNonEmptyString(routeOrder.eventDate) &&
    isNonEmptyString(routeOrder.routeMemberId) &&
    isUniqueNonEmptyStringArray(routeOrder.itemIds) &&
    isNonNegativeInteger(routeOrder.dateMemberRouteOrderVersion)
  );
};

const isUpdateMemberRouteOrderResult = (
  value: unknown,
): value is UpdateMemberRouteOrderResult => {
  const result = asObject(value);
  return (
    isMemberRouteOrderByDateResult(value) &&
    Array.isArray(result.changedMemberRouteOrders) &&
    result.changedMemberRouteOrders.every(isCanonicalMemberRouteOrderResult) &&
    isNullableString(result.notificationId)
  );
};

const isAssignmentWithMemberRoutesResult = (
  value: unknown,
): value is AssignmentWithMemberRoutesResult => {
  const result = asObject(value);
  return (
    isBulkRoomItemPurchaseResult(value) &&
    (result.routeOrderVersion === null || isNonNegativeInteger(result.routeOrderVersion)) &&
    isNestedRecordOfNonNegativeIntegers(result.memberRouteOrderVersions) &&
    Array.isArray(result.changedMemberRouteOrders) &&
    result.changedMemberRouteOrders.every(isCanonicalMemberRouteOrderResult)
  );
};

const isAckRoomSnapshotResult = (value: unknown): value is AckRoomSnapshotResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    typeof result.snapshotReceiptId === 'string' &&
    isNonNegativeInteger(result.itemsVersion) &&
    isRecordOfNonNegativeIntegers(result.routeOrderVersions)
  );
};

const isAckRoomSyncProgressResult = (
  value: unknown,
): value is AckRoomSyncProgressResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    isNonNegativeInteger(result.itemsVersion) &&
    isNullableString(result.lastProcessedEventCreatedAt) &&
    isNullableString(result.lastProcessedEventId)
  );
};

const isAckRoomRouteOrderVersionsResult = (
  value: unknown,
): value is AckRoomRouteOrderVersionsResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    isRecordOfNonNegativeIntegers(result.routeOrderVersions)
  );
};

const isAckRoomMemberRouteOrderVersionsResult = (
  value: unknown,
): value is AckRoomMemberRouteOrderVersionsResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    isNestedRecordOfNonNegativeIntegers(result.memberRouteOrderVersions)
  );
};

const isRoomNotification = (value: unknown): value is RoomNotification => {
  const notification = asObject(value);
  return (
    typeof notification.id === 'string' &&
    typeof notification.eventId === 'string' &&
    typeof notification.idempotencyKey === 'string' &&
    typeof notification.notificationType === 'string' &&
    isNullableString(notification.targetMemberId) &&
    notification.payload !== undefined &&
    parseClockUpdatedAtMs(notification.createdAt) !== null
  );
};

const isNotificationListItem = (value: unknown): value is NotificationListItem => {
  const notification = asObject(value);
  return (
    isRoomNotification(value) &&
    isNullableTimestampString(notification.readAt) &&
    isNullableTimestampString(notification.hiddenAt)
  );
};

const isRoomNotificationsResult = (value: unknown): value is RoomNotificationsResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    isNonNegativeInteger(result.limit) &&
    (result.events === undefined ||
      (Array.isArray(result.events) && result.events.every(isRoomNotification))) &&
    Array.isArray(result.notifications) &&
    result.notifications.every(isRoomNotification) &&
    isNullableTimestampString(result.nextWatermarkCreatedAt) &&
    isNullableString(result.nextWatermarkId) &&
    typeof result.hasMore === 'boolean' &&
    isNullableTimestampString(result.serverHighWatermarkCreatedAt) &&
    isNullableString(result.serverHighWatermarkId)
  );
};

const isNotificationListResult = (value: unknown): value is NotificationListResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    isNonNegativeInteger(result.limit) &&
    Array.isArray(result.notifications) &&
    result.notifications.every(isNotificationListItem)
  );
};

const isNotificationReadStateResult = (
  value: unknown,
): value is NotificationReadStateResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.notificationId === 'string' &&
    isNullableTimestampString(result.readAt) &&
    isNullableTimestampString(result.hiddenAt)
  );
};

const isPreparedMemberToken = (value: unknown): value is PreparedMemberToken => {
  const result = asObject(value);
  return (
    typeof result.challengeId === 'string' &&
    typeof result.roomId === 'string' &&
    typeof result.tokenContext === 'string' &&
    parseClockUpdatedAtMs(result.expiresAt) !== null
  );
};

const isJoinSharingRoomResult = (value: unknown): value is JoinSharingRoomResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    typeof result.tokenContext === 'string'
  );
};

const isHeartbeatRoomSessionResult = (
  value: unknown,
): value is HeartbeatRoomSessionResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    parseClockUpdatedAtMs(result.lastSeenAt) !== null
  );
};

const isPauseRoomSessionResult = (value: unknown): value is PauseRoomSessionResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    parseClockUpdatedAtMs(result.pausedAt) !== null
  );
};

const isLeaveRoomResult = (value: unknown): value is LeaveRoomResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomMemberId === 'string' &&
    result.membershipStatus === 'left' &&
    parseClockUpdatedAtMs(result.leftAt) !== null
  );
};

const isAssignmentMemberProfile = (value: unknown): value is AssignmentMemberProfile => {
  const member = asObject(value);
  return (
    typeof member.roomMemberId === 'string' &&
    typeof member.displayName === 'string' &&
    (member.color === undefined || isNullableString(member.color)) &&
    (member.role === 'host' || member.role === 'member') &&
    (member.membershipStatus === 'active' || member.membershipStatus === 'left')
  );
};

const isRoomMembersForDisplayResult = (
  value: unknown,
): value is RoomMembersForDisplayResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    Array.isArray(result.members) &&
    result.members.every(isAssignmentMemberProfile)
  );
};

const isRouteAwareRoomItemMutationResult = (
  value: unknown,
): value is RouteAwareRoomItemMutationResult => {
  const result = asObject(value);
  return (
    isRoomItemMutationResult(value) &&
    (result.routeOrderVersion === undefined ||
      result.routeOrderVersion === null ||
      isNonNegativeInteger(result.routeOrderVersion)) &&
    (result.routeOrderVersions === undefined ||
      isRecordOfNonNegativeIntegers(result.routeOrderVersions)) &&
    (result.changedRouteOrders === undefined ||
      (Array.isArray(result.changedRouteOrders) &&
        result.changedRouteOrders.every(isCanonicalRouteOrderResult))) &&
    hasConsistentChangedRouteVersions(result.routeOrderVersions, result.changedRouteOrders) &&
    (result.itemNotificationId === undefined || isNullableString(result.itemNotificationId)) &&
    (result.routeNotificationId === undefined || isNullableString(result.routeNotificationId))
  );
};

const isBulkRoomItemPurchaseResult = (value: unknown): value is BulkRoomItemPurchaseResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    isNonNegativeInteger(result.itemsVersion) &&
    Array.isArray(result.changedItems) &&
    result.changedItems.every(isRoomItemMutationResult)
  );
};

const isCreateRoomChallenge = (value: unknown): value is CreateRoomChallenge => {
  const result = asObject(value);
  return typeof result.challengeId === 'string' && typeof result.roomId === 'string';
};

const isCreateSharingRoomResult = (value: unknown): value is CreateSharingRoomResult => {
  const result = asObject(value);
  return (
    typeof result.roomId === 'string' &&
    typeof result.roomCode === 'string' &&
    typeof result.hostMemberId === 'string' &&
    parseClockUpdatedAtMs(result.expiresAt) !== null &&
    isNonNegativeInteger(result.itemsVersion) &&
    (result.routeOrderVersion === null || isNonNegativeInteger(result.routeOrderVersion)) &&
    isRecordOfNonNegativeIntegers(result.routeOrderVersions) &&
    typeof result.tokenContext === 'string'
  );
};

export const validateRoomSnapshot = (value: unknown): value is RoomSnapshot => {
  const snapshot = asObject(value);
  const room = asObject(snapshot.room);
  const currentMember = asObject(snapshot.currentMember);
  const snapshotMetadata = asObject(snapshot.snapshot);

  return (
    typeof room.roomId === 'string' &&
    typeof room.eventName === 'string' &&
    typeof room.hostMemberId === 'string' &&
    isNonNegativeInteger(room.itemsVersion) &&
    (room.routeOrderVersion === null || isNonNegativeInteger(room.routeOrderVersion)) &&
    parseClockUpdatedAtMs(room.expiresAt) !== null &&
    room.sharingStatus === 'active' &&
    typeof currentMember.roomMemberId === 'string' &&
    typeof currentMember.displayName === 'string' &&
    isNullableString(currentMember.color) &&
    (currentMember.role === 'host' || currentMember.role === 'member') &&
    Array.isArray(snapshot.members) &&
    snapshot.members.every((member) => {
      const value = asObject(member);
      return (
        typeof value.roomMemberId === 'string' &&
        typeof value.displayName === 'string' &&
        isNullableString(value.color) &&
        (value.role === 'host' || value.role === 'member') &&
        (value.membershipStatus === 'active' || value.membershipStatus === 'left')
      );
    }) &&
    Array.isArray(snapshot.items) &&
    snapshot.items.every(isSnapshotRoomItem) &&
    typeof snapshotMetadata.receiptId === 'string' &&
    isNonNegativeInteger(snapshotMetadata.itemsVersion) &&
    (snapshotMetadata.routeOrderVersion === null ||
      isNonNegativeInteger(snapshotMetadata.routeOrderVersion)) &&
    isRecordOfNonNegativeIntegers(snapshotMetadata.routeOrderVersions) &&
    isDeletedItemClockMetadataRecord(snapshotMetadata.deletedItemClocks) &&
    isNullableTimestampString(snapshotMetadata.notificationWatermarkCreatedAt) &&
    isNullableString(snapshotMetadata.notificationWatermarkId) &&
    parseClockUpdatedAtMs(snapshotMetadata.createdAt) !== null
  );
};

const fullItemRefreshRequiredEnvelope = <T>(): SharingEnvelope<T> => ({
  ok: false,
  error: {
    code: 'FULL_ITEM_REFRESH_REQUIRED',
    contract_version: SHARING_CONTRACT_VERSION,
  },
});

const fullNotificationRefreshRequiredEnvelope = <T>(): SharingEnvelope<T> => ({
  ok: false,
  error: {
    code: 'FULL_NOTIFICATION_REFRESH_REQUIRED',
    contract_version: SHARING_CONTRACT_VERSION,
  },
});

const normalizeRoomItemMutationEnvelope = (
  value: RpcJson,
): SharingEnvelope<RoomItemMutationResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isRoomItemMutationResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<RoomItemMutationResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeRouteAwareRoomItemMutationEnvelope = (
  value: RpcJson,
): SharingEnvelope<RouteAwareRoomItemMutationResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isRouteAwareRoomItemMutationResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<RouteAwareRoomItemMutationResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeBulkRoomItemPurchaseEnvelope = (
  value: RpcJson,
): SharingEnvelope<BulkRoomItemPurchaseResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isBulkRoomItemPurchaseResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<BulkRoomItemPurchaseResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const malformedSharingRpcEnvelope = <T>(): SharingEnvelope<T> =>
  normalizeEnvelope<T>(undefined);

const normalizeCreateRoomChallengeEnvelope = (
  value: RpcJson,
): SharingEnvelope<CreateRoomChallenge> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isCreateRoomChallenge(envelope.data)) {
    return malformedSharingRpcEnvelope<CreateRoomChallenge>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const validateCreateRoomChallengeEnvelope = (
  envelope: SharingEnvelope<CreateRoomChallenge>,
): SharingEnvelope<CreateRoomChallenge> => {
  if (!envelope.ok) return envelope;
  if (!isCreateRoomChallenge(envelope.data)) {
    return malformedSharingRpcEnvelope<CreateRoomChallenge>();
  }
  return envelope;
};

const normalizeCreateSharingRoomEnvelope = (
  value: RpcJson,
): SharingEnvelope<CreateSharingRoomResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isCreateSharingRoomResult(envelope.data)) {
    return malformedSharingRpcEnvelope<CreateSharingRoomResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeRoomVersionsEnvelope = (value: RpcJson): SharingEnvelope<RoomVersions> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isRoomVersions(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<RoomVersions>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeRouteOrderByDateEnvelope = (
  value: RpcJson,
): SharingEnvelope<RouteOrderByDateResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isRouteOrderByDateResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<RouteOrderByDateResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeUpdateRouteOrderEnvelope = (
  value: RpcJson,
): SharingEnvelope<UpdateRouteOrderResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isUpdateRouteOrderResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<UpdateRouteOrderResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeMemberRouteOrderByDateEnvelope = (
  value: RpcJson,
): SharingEnvelope<MemberRouteOrderByDateResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isMemberRouteOrderByDateResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<MemberRouteOrderByDateResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeUpdateMemberRouteOrderEnvelope = (
  value: RpcJson,
): SharingEnvelope<UpdateMemberRouteOrderResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isUpdateMemberRouteOrderResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<UpdateMemberRouteOrderResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeAssignmentWithMemberRoutesEnvelope = (
  value: RpcJson,
): SharingEnvelope<AssignmentWithMemberRoutesResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isAssignmentWithMemberRoutesResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<AssignmentWithMemberRoutesResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeAckRoomSnapshotEnvelope = (
  value: RpcJson,
): SharingEnvelope<AckRoomSnapshotResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isAckRoomSnapshotResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<AckRoomSnapshotResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeAckRoomSyncProgressEnvelope = (
  value: RpcJson,
): SharingEnvelope<AckRoomSyncProgressResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isAckRoomSyncProgressResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<AckRoomSyncProgressResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeAckRoomRouteOrderVersionsEnvelope = (
  value: RpcJson,
): SharingEnvelope<AckRoomRouteOrderVersionsResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isAckRoomRouteOrderVersionsResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<AckRoomRouteOrderVersionsResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeAckRoomMemberRouteOrderVersionsEnvelope = (
  value: RpcJson,
): SharingEnvelope<AckRoomMemberRouteOrderVersionsResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isAckRoomMemberRouteOrderVersionsResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<AckRoomMemberRouteOrderVersionsResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeRoomNotificationsEnvelope = (
  value: RpcJson,
): SharingEnvelope<RoomNotificationsResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isRoomNotificationsResult(envelope.data)) {
    return fullNotificationRefreshRequiredEnvelope<RoomNotificationsResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeNotificationListEnvelope = (
  value: RpcJson,
): SharingEnvelope<NotificationListResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isNotificationListResult(envelope.data)) {
    return fullNotificationRefreshRequiredEnvelope<NotificationListResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeNotificationReadStateEnvelope = (
  value: RpcJson,
): SharingEnvelope<NotificationReadStateResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isNotificationReadStateResult(envelope.data)) {
    return fullNotificationRefreshRequiredEnvelope<NotificationReadStateResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizePreparedMemberTokenEnvelope = (
  value: RpcJson,
): SharingEnvelope<PreparedMemberToken> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isPreparedMemberToken(envelope.data)) {
    return malformedSharingRpcEnvelope<PreparedMemberToken>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeJoinSharingRoomEnvelope = (
  value: RpcJson,
): SharingEnvelope<JoinSharingRoomResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isJoinSharingRoomResult(envelope.data)) {
    return malformedSharingRpcEnvelope<JoinSharingRoomResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeHeartbeatRoomSessionEnvelope = (
  value: RpcJson,
): SharingEnvelope<HeartbeatRoomSessionResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isHeartbeatRoomSessionResult(envelope.data)) {
    return malformedSharingRpcEnvelope<HeartbeatRoomSessionResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizePauseRoomSessionEnvelope = (
  value: RpcJson,
): SharingEnvelope<PauseRoomSessionResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isPauseRoomSessionResult(envelope.data)) {
    return malformedSharingRpcEnvelope<PauseRoomSessionResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeLeaveRoomEnvelope = (value: RpcJson): SharingEnvelope<LeaveRoomResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isLeaveRoomResult(envelope.data)) {
    return malformedSharingRpcEnvelope<LeaveRoomResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const normalizeRoomMembersForDisplayEnvelope = (
  value: RpcJson,
): SharingEnvelope<RoomMembersForDisplayResult> => {
  const envelope = normalizeEnvelope<unknown>(value);
  if (!envelope.ok) return envelope;
  if (!isRoomMembersForDisplayResult(envelope.data)) {
    return malformedSharingRpcEnvelope<RoomMembersForDisplayResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
};

const isDeletedItemClockMetadata = (
  entry: DeletedItemClockSnapshotEntry,
): entry is DeletedItemClockMetadata => {
  const value = entry as DeletedItemClockMetadata;
  return (
    typeof value.deletedAt === 'string' &&
    value.fieldClocks !== undefined &&
    typeof value.fieldClocks === 'object' &&
    typeof value.itemVersion === 'number' &&
    typeof value.updatedAt === 'string'
  );
};

const latestFieldClock = (
  fieldClocks: RoomItemFieldClocks,
): RoomItemFieldClock | undefined =>
  Object.values(fieldClocks).reduce<RoomItemFieldClock | undefined>(
    (latest, clock) =>
      !latest || clock.itemsVersion > latest.itemsVersion ? clock : latest,
    undefined,
  );

const normalizeDeletedItemClockMetadata = (
  entry: DeletedItemClockSnapshotEntry,
): DeletedItemClockMetadata => {
  if (isDeletedItemClockMetadata(entry)) return entry;

  const fieldClocks = entry as RoomItemFieldClocks;
  const fallbackClock = fieldClocks.deletedAt ?? latestFieldClock(fieldClocks);
  return {
    deletedAt: fieldClocks.deletedAt?.updatedAt ?? fallbackClock?.updatedAt ?? '',
    deletedBy: null,
    fieldClocks,
    itemVersion: fallbackClock?.itemsVersion ?? 0,
    updatedAt: fallbackClock?.updatedAt ?? '',
  };
};

const normalizeEnvelope = <T>(value: RpcJson): SharingEnvelope<T> => {
  const envelope = asObject(value);
  if (envelope.ok === true) {
    const contractVersion =
      typeof envelope.contract_version === 'number'
        ? envelope.contract_version
        : SHARING_CONTRACT_VERSION;
    if (contractVersion !== SHARING_CONTRACT_VERSION) {
      return {
        ok: false,
        error: {
          code: 'CONTRACT_VERSION_MISMATCH',
          contract_version: SHARING_CONTRACT_VERSION,
        },
      };
    }

    return {
      ok: true,
      data: envelope.data as T,
      contract_version: contractVersion,
    } satisfies SharingSuccessEnvelope<T>;
  }

  const errorObject = asObject(envelope.error);
  const errorContractVersion =
    typeof errorObject.contract_version === 'number'
      ? errorObject.contract_version
      : SHARING_CONTRACT_VERSION;
  if (errorContractVersion !== SHARING_CONTRACT_VERSION) {
    return {
      ok: false,
      error: {
        code: 'CONTRACT_VERSION_MISMATCH',
        contract_version: SHARING_CONTRACT_VERSION,
      },
    };
  }

  const errorCode = isSharingErrorCode(errorObject.code)
    ? errorObject.code
    : 'SHARING_INTERNAL_ERROR';
  return {
    ok: false,
    error: {
      code: errorCode,
      retry_after_seconds:
        typeof errorObject.retry_after_seconds === 'number'
          ? errorObject.retry_after_seconds
          : undefined,
      contract_version: errorContractVersion,
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
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'room_member_route_order_versions',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        const row = asObject(payload.new);
        onEvent({
          table: 'room_member_route_order_versions',
          eventType: payload.eventType,
          roomId: typeof row.room_id === 'string' ? row.room_id : roomId,
          id: null,
          eventDate: typeof row.event_date === 'string' ? row.event_date : null,
          routeMemberId:
            typeof row.route_member_id === 'string' ? row.route_member_id : null,
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

const prepareCreateRoomChallengeDirect = async ({
  canonical,
  client,
  input,
}: {
  canonical: CanonicalCreateRoomPayload;
  client: ReturnType<typeof requireSupabase>;
  input: CreateSharingRoomInput;
}): Promise<SharingEnvelope<CreateRoomChallenge>> => {
  const result = await client.rpc('prepare_create_room_challenge', {
    p_client_room_id: input.roomId,
    p_canonical_payload: canonical.canonicalText,
    p_plaintext_fingerprint: canonical.fingerprint,
    p_item_count: input.itemCount,
    p_canonical_schema_version: ROOM_EVENT_DATA_SCHEMA_VERSION,
    p_payload_protection_mode: 'encrypted',
  });
  if (result.error) {
    return malformedSharingRpcEnvelope<CreateRoomChallenge>();
  }
  return normalizeCreateRoomChallengeEnvelope(result.data);
};

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
  let canonical: CanonicalCreateRoomPayload;
  try {
    canonical = await canonicalizeRoomEventDataForCreate(input.rawRoomEventDataJson);
  } catch (error) {
    const envelope = canonicalPayloadErrorEnvelope<CreateSharingRoomResult>(error);
    if (envelope) return envelope;
    throw error;
  }
  const prepared =
    availability.enabled && availability.mode === 'public_guard'
      ? validateCreateRoomChallengeEnvelope(
          await prepareCreateRoomViaPublicGuard({
            roomId: input.roomId,
            canonicalPayload: canonical.canonicalText,
            plaintextFingerprint: canonical.fingerprint,
            itemCount: input.itemCount,
            canonicalSchemaVersion: ROOM_EVENT_DATA_SCHEMA_VERSION,
            payloadProtectionMode: 'encrypted',
          }),
        )
      : await prepareCreateRoomChallengeDirect({
          client,
          input,
          canonical,
        });
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

  const envelope = normalizeCreateSharingRoomEnvelope(createResult.data);
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
  return normalizePreparedMemberTokenEnvelope(result.data);
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

  const envelope = normalizeJoinSharingRoomEnvelope(result.data);
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
  return normalizePreparedMemberTokenEnvelope(result.data);
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
  return normalizeJoinSharingRoomEnvelope(result.data);
};

const toRoomSnapshot = (value: unknown): RoomSnapshot | null => {
  const snapshot = value as RoomSnapshot;
  const parsedSnapshot = {
    ...snapshot,
    eventData: parseRoomEventData(snapshot.eventData),
  };
  return validateRoomSnapshot(parsedSnapshot) ? parsedSnapshot : null;
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

  const snapshot = toRoomSnapshot(envelope.data);
  if (!snapshot) {
    return fullItemRefreshRequiredEnvelope<RoomSnapshot>();
  }

  return {
    ok: true,
    data: snapshot,
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
  return normalizeAckRoomSnapshotEnvelope(result.data);
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
  return normalizeHeartbeatRoomSessionEnvelope(result.data);
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
  return normalizePauseRoomSessionEnvelope(result.data);
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
  return normalizeLeaveRoomEnvelope(result.data);
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
  return normalizeRoomMembersForDisplayEnvelope(result.data);
};

export const updateRoomItemWithPurchase = async (
  input: UpdateRoomItemWithPurchaseInput,
): Promise<SharingEnvelope<RoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('update_room_item_with_purchase', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_fields: input.fields,
    p_status: nullableRpcArg(input.status ?? null),
    p_actual_purchase_quantity: nullableRpcArg(input.actualPurchaseQuantity ?? null),
    p_expected_field_clocks: input.expectedFieldClocks as Json,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemMutationResult>(undefined);
  }
  return normalizeRoomItemMutationEnvelope(result.data);
};

export const upsertRoomItemWithRoute = async (
  input: UpsertRoomItemWithRouteInput,
): Promise<SharingEnvelope<RouteAwareRoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('upsert_room_item_with_route', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_fields: input.fields as Json,
    p_route_updates: input.routeUpdates as Json,
    p_expected_field_clocks: input.expectedFieldClocks as Json,
  });
  if (result.error) {
    return normalizeEnvelope<RouteAwareRoomItemMutationResult>(undefined);
  }
  return normalizeRouteAwareRoomItemMutationEnvelope(result.data);
};

export const deleteRoomItemWithRoute = async (
  input: DeleteRoomItemWithRouteInput,
): Promise<SharingEnvelope<RouteAwareRoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('delete_room_item_with_route', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_route_updates: input.routeUpdates as Json,
    p_expected_field_clocks: input.expectedFieldClocks as Json,
  });
  if (result.error) {
    return normalizeEnvelope<RouteAwareRoomItemMutationResult>(undefined);
  }
  return normalizeRouteAwareRoomItemMutationEnvelope(result.data);
};

export const bulkUpdateRoomItemsWithPurchase = async (
  input: BulkUpdateRoomItemsWithPurchaseInput,
): Promise<SharingEnvelope<BulkRoomItemPurchaseResult>> => {
  const result = await requireSupabase().rpc('bulk_update_room_items_with_purchase', {
    p_room_id: input.roomId,
    p_mutations: input.mutations as Json,
  });
  if (result.error) {
    return normalizeEnvelope<BulkRoomItemPurchaseResult>(undefined);
  }
  return normalizeBulkRoomItemPurchaseEnvelope(result.data);
};

export const assignRoomItem = async (
  input: AssignRoomItemInput,
): Promise<SharingEnvelope<RoomItemMutationResult>> => {
  const result = await requireSupabase().rpc('update_room_item_with_purchase', {
    p_room_id: input.roomId,
    p_local_item_id: input.localItemId,
    p_fields: { assignedTo: input.assignedToMemberId },
    p_status: nullableRpcArg<PurchaseStatus>(null),
    p_actual_purchase_quantity: nullableRpcArg<number>(null),
    p_expected_field_clocks: input.expectedFieldClocks as Json,
  });
  if (result.error) {
    return normalizeEnvelope<RoomItemMutationResult>(undefined);
  }
  return normalizeRoomItemMutationEnvelope(result.data);
};

export const bulkAssignRoomItems = async (
  input: BulkAssignRoomItemsInput,
): Promise<SharingEnvelope<BulkRoomItemAssignmentResult>> => {
  const result = await requireSupabase().rpc('bulk_update_room_items_with_purchase', {
    p_room_id: input.roomId,
    p_mutations: input.assignments.map((assignment) => ({
      localItemId: assignment.localItemId,
      fields: { assignedTo: input.assignedToMemberId },
      status: null,
      actualPurchaseQuantity: null,
      expectedFieldClocks: assignment.expectedFieldClocks,
    })) as Json,
  });
  if (result.error) {
    return normalizeEnvelope<BulkRoomItemAssignmentResult>(undefined);
  }
  const normalized = normalizeBulkRoomItemPurchaseEnvelope(result.data);
  if (!normalized.ok) {
    return normalized;
  }
  return {
    ok: true,
    contract_version: normalized.contract_version,
    data: {
      ...normalized.data,
      assignedToMemberId: input.assignedToMemberId,
    },
  };
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
  return normalizeRoomVersionsEnvelope(result.data);
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
  return normalizeRouteOrderByDateEnvelope(result.data);
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
  return normalizeUpdateRouteOrderEnvelope(result.data);
};

export const getMemberRouteOrderByDate = async (
  roomId: string,
  eventDate: string,
  routeMemberId: string,
): Promise<SharingEnvelope<MemberRouteOrderByDateResult>> => {
  const result = await requireSupabase().rpc('get_member_route_order_by_date', {
    p_room_id: roomId,
    p_event_date: eventDate,
    p_route_member_id: routeMemberId,
  });
  if (result.error) {
    return normalizeEnvelope<MemberRouteOrderByDateResult>(undefined);
  }
  return normalizeMemberRouteOrderByDateEnvelope(result.data);
};

export const updateMemberRouteOrder = async (
  input: UpdateMemberRouteOrderInput,
): Promise<SharingEnvelope<UpdateMemberRouteOrderResult>> => {
  const result = await requireSupabase().rpc('update_member_route_order', {
    p_room_id: input.roomId,
    p_event_date: input.eventDate,
    p_route_member_id: input.routeMemberId,
    p_item_ids: input.itemIds,
    p_expected_version: input.expectedVersion,
  });
  if (result.error) {
    return normalizeEnvelope<UpdateMemberRouteOrderResult>(undefined);
  }
  return normalizeUpdateMemberRouteOrderEnvelope(result.data);
};

export const updateRoomItemAssignmentWithMemberRoutes = async (
  input: UpdateRoomItemAssignmentWithMemberRoutesInput,
): Promise<SharingEnvelope<AssignmentWithMemberRoutesResult>> => {
  const result = await requireSupabase().rpc('update_room_item_assignment_with_member_routes', {
    p_room_id: input.roomId,
    p_assignment_mutations: input.assignments.map((assignment) => ({
      localItemId: assignment.localItemId,
      assignedToMemberId: assignment.assignedToMemberId,
      expectedFieldClocks: assignment.expectedFieldClocks,
    })) as Json,
    p_member_route_updates: input.memberRouteUpdates.map((routeUpdate) => ({
      eventDate: routeUpdate.eventDate,
      routeMemberId: routeUpdate.routeMemberId,
      itemIds: routeUpdate.itemIds,
      expectedVersion: routeUpdate.expectedVersion,
    })) as Json,
  });
  if (result.error) {
    return normalizeEnvelope<AssignmentWithMemberRoutesResult>(undefined);
  }
  return normalizeAssignmentWithMemberRoutesEnvelope(result.data);
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
  const envelope = normalizeEnvelope<unknown>(result.data);
  if (!envelope.ok) {
    return envelope;
  }
  if (!isRoomItemChangesResult(envelope.data)) {
    return fullItemRefreshRequiredEnvelope<RoomItemChangesResult>();
  }
  return {
    ok: true,
    data: envelope.data,
    contract_version: envelope.contract_version,
  };
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
  return normalizeRoomNotificationsEnvelope(result.data);
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
  return normalizeNotificationListEnvelope(result.data);
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
  return normalizeNotificationReadStateEnvelope(result.data);
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
  return normalizeNotificationReadStateEnvelope(result.data);
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
  return normalizeAckRoomSyncProgressEnvelope(result.data);
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
  return normalizeAckRoomRouteOrderVersionsEnvelope(result.data);
};

export const ackRoomMemberRouteOrderVersions = async (
  roomId: string,
  memberRouteOrderVersions: MemberRouteOrderVersions,
): Promise<SharingEnvelope<AckRoomMemberRouteOrderVersionsResult>> => {
  const result = await requireSupabase().rpc('ack_room_member_route_order_versions', {
    p_room_id: roomId,
    p_member_route_order_versions: memberRouteOrderVersions,
  });
  if (result.error) {
    return normalizeEnvelope<AckRoomMemberRouteOrderVersionsResult>(undefined);
  }
  return normalizeAckRoomMemberRouteOrderVersionsEnvelope(result.data);
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
  circle: item.circle ?? getString(staticSnapshot, 'circle', item.name ?? ''),
  eventDate: item.eventDate ?? getString(staticSnapshot, 'eventDate'),
  block: item.block ?? getString(staticSnapshot, 'block'),
  number: item.number ?? getString(staticSnapshot, 'number'),
  title: item.title ?? getString(staticSnapshot, 'title', item.name ?? ''),
  price: item.price,
  purchaseStatus: item.purchaseStatus,
  quantity: item.quantity ?? 1,
  limitedPurchasedQuantity: item.actualPurchaseQuantity ?? undefined,
  remarks: item.remarks ?? '',
  url: item.url ?? undefined,
  priorityLevel:
    item.priorityLevel ??
    (getStringOrUndefined(staticSnapshot, 'priorityLevel') as
      | ShoppingItem['priorityLevel']
      | undefined),
  protectionLevel:
    item.protectionLevel ??
    (getStringOrUndefined(staticSnapshot, 'protectionLevel') as
      | ShoppingItem['protectionLevel']
      | undefined),
  source:
    item.source ??
    (getStringOrUndefined(staticSnapshot, 'source') as
      | ShoppingItem['source']
      | undefined),
  assignedTo: item.assignedTo ?? undefined,
  securedBy: item.securedBy ?? undefined,
  lastSyncedAt: item.updatedAt,
  orderIndex: item.orderIndex ?? undefined,
  postponed: item.purchaseStatus === 'Postpone',
  manualHallId: item.manualHallId ?? getStringOrUndefined(staticSnapshot, 'manualHallId'),
});

const buildCanonicalRouteOrderByDateFromSnapshotItems = (
  items: SnapshotRoomItem[],
): Record<string, string[]> => {
  const grouped = new Map<string, Array<{ itemId: string; orderIndex: number }>>();

  items.forEach((item) => {
    if (item.orderIndex === null || !item.eventDate) return;
    const entries = grouped.get(item.eventDate) ?? [];
    entries.push({
      itemId: item.localItemId,
      orderIndex: item.orderIndex,
    });
    grouped.set(item.eventDate, entries);
  });

  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' }))
      .map(([eventDate, entries]) => [
        eventDate,
        entries
          .sort(
            (a, b) =>
              a.orderIndex - b.orderIndex ||
              a.itemId.localeCompare(b.itemId, 'ja', { numeric: true, sensitivity: 'base' }),
          )
          .map((entry) => entry.itemId),
      ]),
  );
};

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
      [eventName]: buildCanonicalRouteOrderByDateFromSnapshotItems(snapshot.items),
    },
    memberRouteItems: {
      ...(currentAppData?.memberRouteItems ?? {}),
      [eventName]: snapshot.eventData.memberRouteItems,
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
): SharingSessionMetadata => {
  const deletedItemClocks = Object.fromEntries(
    Object.entries(snapshot.snapshot.deletedItemClocks ?? {}).map(([localItemId, metadata]) => [
      localItemId,
      normalizeDeletedItemClockMetadata(metadata),
    ]),
  );

  return {
    sessionId: snapshot.room.roomId,
    roomId: snapshot.room.roomId,
    roomMemberId: snapshot.currentMember.roomMemberId,
    contractVersion: SHARING_CONTRACT_VERSION,
    metadataSchemaVersion: 2,
    eventName: snapshot.room.eventName,
    role: snapshot.currentMember.role,
    status: 'active',
    startedAt: snapshot.snapshot.createdAt,
    expiresAt: snapshot.room.expiresAt,
    itemsVersion: snapshot.snapshot.itemsVersion,
    routeOrderVersions: snapshot.snapshot.routeOrderVersions,
    memberRouteOrderVersions: {},
    fieldClocksByItemId: {
      ...Object.fromEntries(
        snapshot.items.map((item) => [item.localItemId, item.fieldClocks]),
      ),
      ...Object.fromEntries(
        Object.entries(deletedItemClocks).map(([localItemId, metadata]) => [
          localItemId,
          metadata.fieldClocks,
        ]),
      ),
    },
    deletedItemClocks,
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
  };
};

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
