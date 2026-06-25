import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from '../../types/item';
import type {
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from '../../types/map';
import type {
  AppData,
  SharingPendingRouteOrderAckMetadata,
  SharingPendingRouteOrderAckSource,
  SharingSessionMetadata,
} from '../../utils/indexedDB';
import {
  ROOM_EVENT_DATA_SCHEMA_VERSION,
  SHARING_CONTRACT_VERSION,
  type SharingErrorCode,
} from './contracts';
import type { RoomEventDataPayload, RoomEventJson } from './roomEventDataSchema';

export const SHARING_SYNC_METADATA_SCHEMA_VERSION = 2;

export const SHARING_STRUCTURE_LOCK_MESSAGE =
  '共有中のイベントでは、イベント設定・マップ・会場などの構造変更を停止しています。アイテム変更と巡回順は共有中でも同期できます。';

export const SHARING_SYNC_UPGRADE_REQUIRED_MESSAGE =
  '保存済みの共有同期情報が古いため、この共有セッションの同期を停止しました。ローカルデータは保持されています。必要に応じて現在のローカルイベントから新しい共有ルームを作成してください。';

export const SHARING_SYNC_UNUSABLE_MESSAGE =
  '共有の最新状態を安全に読み込めなかったため、この共有セッションの同期を停止しました。ローカルデータは保持されています。必要に応じて現在のローカルイベントから新しい共有ルームを作成してください。';

const SHARING_SYNC_UPGRADE_REQUIRED_ERROR_CODES = new Set<SharingErrorCode>([
  'CLIENT_UPGRADE_REQUIRED',
  'CONTRACT_VERSION_MISMATCH',
  'RESTORE_REQUIRED',
  'ROOM_UNAVAILABLE',
]);

export const isSharingSyncUpgradeRequiredErrorCode = (code: SharingErrorCode): boolean =>
  SHARING_SYNC_UPGRADE_REQUIRED_ERROR_CODES.has(code);

export type SharingAppState = {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  mapRotationSettings: MapRotationSettingsStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  mapViewportSettings: MapViewportSettingsStore;
};

export type SharingRoomEventPayloadInput = SharingAppState & {
  eventName: string;
};

export type SharingRoomEventPayloadResult = {
  payload: RoomEventDataPayload;
  rawJson: string;
  itemCount: number;
};

const jsonClone = (value: unknown): RoomEventJson => {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as RoomEventJson;
};

const jsonRecord = (value: unknown): Record<string, RoomEventJson> => {
  const cloned = jsonClone(value);
  return cloned && typeof cloned === 'object' && !Array.isArray(cloned)
    ? (cloned as Record<string, RoomEventJson>)
    : {};
};

const stringArrayRecord = (value: ExecuteModeItems | undefined): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  Object.entries(value ?? {}).forEach(([key, ids]) => {
    result[key] = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  });
  return result;
};

export const buildCurrentSharingAppData = (state: SharingAppState): AppData => ({
  eventLists: state.eventLists as unknown as Record<string, unknown[]>,
  eventMetadata: state.eventMetadata as unknown as Record<string, unknown>,
  executeModeItems: state.executeModeItems,
  dayModes: state.dayModes,
  mapData: state.mapData as unknown as Record<string, Record<string, unknown>>,
  mapRotationSettings: state.mapRotationSettings as unknown as Record<string, Record<string, unknown>>,
  routeSettings: state.routeSettings as unknown as Record<string, Record<string, unknown>>,
  hallDefinitions: state.hallDefinitions as unknown as Record<string, Record<string, unknown[]>>,
  hallRouteSettings: state.hallRouteSettings as unknown as Record<string, Record<string, unknown>>,
  mapViewportSettings: state.mapViewportSettings as unknown as Record<string, Record<string, unknown>>,
});

export const buildRoomEventPayloadForEvent = (
  input: SharingRoomEventPayloadInput,
): SharingRoomEventPayloadResult => {
  const eventItems = input.eventLists[input.eventName] ?? [];
  const eventExecuteModeItems = stringArrayRecord(input.executeModeItems[input.eventName]);
  const eventMetadata = {
    ...jsonRecord(input.eventMetadata[input.eventName] ?? {}),
    eventName: input.eventName,
  };

  const payload: RoomEventDataPayload = {
    schemaVersion: ROOM_EVENT_DATA_SCHEMA_VERSION,
    eventMetadata,
    executeModeItems: eventExecuteModeItems,
    dayModes: Object.fromEntries(
      Object.entries(input.dayModes[input.eventName] ?? {}).filter(
        ([, mode]) => typeof mode === 'string',
      ),
    ),
    mapData: jsonRecord(input.mapData[input.eventName] ?? {}),
    mapRotationSettings: jsonRecord(input.mapRotationSettings[input.eventName] ?? {}),
    routeSettings: jsonRecord(input.routeSettings[input.eventName] ?? {}),
    hallDefinitions: jsonRecord(input.hallDefinitions[input.eventName] ?? {}),
    hallRouteSettings: jsonRecord(input.hallRouteSettings[input.eventName] ?? {}),
    mapViewportSettings: jsonRecord(input.mapViewportSettings[input.eventName] ?? {}),
    routeOrderByDate: eventExecuteModeItems,
    itemSnapshots: Object.fromEntries(
      eventItems.map((item) => [item.id, jsonRecord(item)]),
    ),
  };

  return {
    payload,
    rawJson: JSON.stringify(payload),
    itemCount: eventItems.length,
  };
};

export const isSharingSessionActive = (
  session: SharingSessionMetadata,
  nowMs = Date.now(),
): boolean => session.status === 'active' && Date.parse(session.expiresAt) > nowMs;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRouteOrderVersionRecord = (value: unknown): value is Record<string, number> =>
  isPlainRecord(value) &&
  Object.values(value).every(
    (version) => typeof version === 'number' && Number.isInteger(version) && version >= 0,
  );

const isPendingRouteOrderAckRecord = (
  value: unknown,
): value is Record<string, number | SharingPendingRouteOrderAckMetadata> =>
  isPlainRecord(value) &&
  Object.values(value).every((entry) => {
    if (typeof entry === 'number') return Number.isInteger(entry) && entry >= 0;
    return (
      isPlainRecord(entry) &&
      typeof entry.version === 'number' &&
      Number.isInteger(entry.version) &&
      entry.version >= 0 &&
      ['mutation', 'reorder', 'sync'].includes(String(entry.source)) &&
      typeof entry.retryCount === 'number' &&
      Number.isInteger(entry.retryCount) &&
      entry.retryCount >= 0 &&
      (entry.lastTriedAt === undefined || typeof entry.lastTriedAt === 'string') &&
      typeof entry.updatedAt === 'string'
    );
  });

const isPendingItemSyncAckMetadata = (
  value: unknown,
): value is NonNullable<SharingSessionMetadata['pendingItemSyncAck']> => {
  if (!isPlainRecord(value)) return false;
  const fromItemsVersion = value.fromItemsVersion;
  const targetItemsVersion = value.targetItemsVersion;
  const affectedLocalItemIds = value.affectedLocalItemIds;
  const retryCount = value.retryCount;
  const lastTriedAt = value.lastTriedAt;

  return (
    typeof fromItemsVersion === 'number' &&
    Number.isInteger(fromItemsVersion) &&
    fromItemsVersion >= 0 &&
    typeof targetItemsVersion === 'number' &&
    Number.isInteger(targetItemsVersion) &&
    targetItemsVersion >= fromItemsVersion &&
    (affectedLocalItemIds === undefined ||
      (Array.isArray(affectedLocalItemIds) &&
        affectedLocalItemIds.every((itemId) => typeof itemId === 'string'))) &&
    (retryCount === undefined ||
      (typeof retryCount === 'number' && Number.isInteger(retryCount) && retryCount >= 0)) &&
    (lastTriedAt === undefined || typeof lastTriedAt === 'string') &&
    typeof value.updatedAt === 'string'
  );
};

export const markPendingItemSyncAckAttempt = (
  pending: unknown,
  nowIso: string,
): SharingSessionMetadata['pendingItemSyncAck'] | undefined => {
  if (!isPendingItemSyncAckMetadata(pending)) return undefined;

  return {
    ...pending,
    retryCount: (pending.retryCount ?? 0) + 1,
    lastTriedAt: nowIso,
    updatedAt: nowIso,
  };
};

export const normalizePendingRouteOrderAcks = (
  pending: unknown,
  fallbackSource: SharingPendingRouteOrderAckSource,
  nowIso: string,
): Record<string, SharingPendingRouteOrderAckMetadata> | undefined => {
  if (!isPendingRouteOrderAckRecord(pending)) return undefined;

  const normalized = Object.fromEntries(
    Object.entries(pending).map(([eventDate, entry]) => [
      eventDate,
      typeof entry === 'number'
        ? {
            version: entry,
            source: fallbackSource,
            retryCount: 0,
            updatedAt: nowIso,
          }
        : entry,
    ]),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const mergePendingRouteOrderAcks = (
  pending: unknown,
  versionsByDate: Record<string, number>,
  source: SharingPendingRouteOrderAckSource,
  nowIso: string,
): Record<string, SharingPendingRouteOrderAckMetadata> | undefined => {
  const next = normalizePendingRouteOrderAcks(pending, source, nowIso) ?? {};

  Object.entries(versionsByDate).forEach(([eventDate, version]) => {
    const current = next[eventDate];
    if (current && current.version > version) return;

    next[eventDate] = {
      version,
      source,
      retryCount: current?.version === version ? current.retryCount : 0,
      lastTriedAt: current?.version === version ? current.lastTriedAt : undefined,
      updatedAt: nowIso,
    };
  });

  return Object.keys(next).length > 0 ? next : undefined;
};

export const markPendingRouteOrderAckAttempt = (
  pending: unknown,
  nowIso: string,
): Record<string, SharingPendingRouteOrderAckMetadata> | undefined => {
  const normalized = normalizePendingRouteOrderAcks(pending, 'sync', nowIso);
  if (!normalized) return undefined;

  return Object.fromEntries(
    Object.entries(normalized).map(([eventDate, ack]) => [
      eventDate,
      {
        ...ack,
        retryCount: ack.retryCount + 1,
        lastTriedAt: nowIso,
        updatedAt: nowIso,
      },
    ]),
  );
};

export const clearSatisfiedRouteOrderAcks = (
  pending: unknown,
  acked: Record<string, number> | undefined,
  nowIso: string,
): Record<string, SharingPendingRouteOrderAckMetadata> | undefined => {
  const normalized = normalizePendingRouteOrderAcks(pending, 'sync', nowIso);
  if (!normalized) return undefined;

  const remaining = Object.fromEntries(
    Object.entries(normalized).filter(
      ([eventDate, ack]) => (acked?.[eventDate] ?? -1) < ack.version,
    ),
  );
  return Object.keys(remaining).length > 0 ? remaining : undefined;
};

export const isSharingSessionSyncMetadataCompatible = (
  session: SharingSessionMetadata,
): boolean =>
  session.contractVersion === SHARING_CONTRACT_VERSION &&
  session.metadataSchemaVersion === SHARING_SYNC_METADATA_SCHEMA_VERSION &&
  isRouteOrderVersionRecord(session.routeOrderVersions) &&
  isPlainRecord(session.fieldClocksByItemId) &&
  (session.pendingItemSyncAck === undefined ||
    isPendingItemSyncAckMetadata(session.pendingItemSyncAck)) &&
  (session.pendingRouteOrderAcks === undefined ||
    isPendingRouteOrderAckRecord(session.pendingRouteOrderAcks));

export const isSharingSessionOperational = (
  session: SharingSessionMetadata,
  nowMs = Date.now(),
): boolean =>
  isSharingSessionActive(session, nowMs) &&
  isSharingSessionSyncMetadataCompatible(session);

export const buildLocalizedSharingSessionForSyncUpgrade = (
  session: SharingSessionMetadata,
  localizedAt = new Date().toISOString(),
): SharingSessionMetadata => ({
  ...session,
  status: 'localizing',
  routeOrderVersions: {},
  fieldClocksByItemId: undefined,
  deletedItemClocks: undefined,
  pendingItemSyncAck: undefined,
  pendingRouteOrderAcks: undefined,
  lastSnapshotReceiptId: undefined,
  lastProcessedEventCreatedAt: null,
  lastProcessedEventId: null,
  lastAckAt: localizedAt,
});

export const findActiveSharingSessionForEvent = (
  sessions: Record<string, SharingSessionMetadata>,
  eventName: string | null | undefined,
  nowMs = Date.now(),
): SharingSessionMetadata | null => {
  if (!eventName) return null;
  return (
    Object.values(sessions).find(
      (session) =>
        session.eventName === eventName && isSharingSessionOperational(session, nowMs),
    ) ?? null
  );
};
