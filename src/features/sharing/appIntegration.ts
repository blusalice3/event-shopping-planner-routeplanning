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
import type { AppData, SharingSessionMetadata } from '../../utils/indexedDB';
import { ROOM_EVENT_DATA_SCHEMA_VERSION } from './contracts';
import type { RoomEventDataPayload, RoomEventJson } from './roomEventDataSchema';

export const SHARING_STRUCTURE_LOCK_MESSAGE =
  '共有中のイベントでは、追加・削除・イベント構造の変更を停止しています。価格、数量、備考、URL、購入状態、担当者、巡回順は共有中でも同期できます。';

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

export const findActiveSharingSessionForEvent = (
  sessions: Record<string, SharingSessionMetadata>,
  eventName: string | null | undefined,
  nowMs = Date.now(),
): SharingSessionMetadata | null => {
  if (!eventName) return null;
  return (
    Object.values(sessions).find(
      (session) =>
        session.eventName === eventName && isSharingSessionActive(session, nowMs),
    ) ?? null
  );
};
