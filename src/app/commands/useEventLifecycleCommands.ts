import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { AppNavigationCommands } from "../navigation";
import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import type { FocusModeSessionState } from "../../types/focus";
import type {
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from "../../types/map";
import type {
  PersistenceCommandPort,
  PersistenceSnapshot,
} from "../ports/PersistenceCommandPort";
import {
  removeRecordKey,
  renameRecordKey,
} from "../../features/events/recordOps";
import { resolveEventListTab } from "../../features/events/uiOrchestration";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

export const removeFocusModeSessionByEvent = (
  sessions: Record<string, FocusModeSessionState>,
  eventName: string,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (key.startsWith(`${eventName}::`)) {
      changed = true;
      return;
    }
    next[key] = value;
  });

  return changed ? next : sessions;
};

export const renameFocusModeSessionKeys = (
  sessions: Record<string, FocusModeSessionState>,
  oldEventName: string,
  newEventName: string,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (key.startsWith(`${oldEventName}::`)) {
      const suffix = key.slice(oldEventName.length);
      next[`${newEventName}${suffix}`] = value;
      changed = true;
    } else {
      next[key] = value;
    }
  });

  return changed ? next : sessions;
};

export interface EventLifecycleCommandPorts {
  persistenceCommands: Pick<
    PersistenceCommandPort,
    "deleteEventAtomically" | "renameEventAtomically"
  >;
  flushPendingSave(): Promise<void>;
  activeEventName: string | null;
  eventToRename: string | null;
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
  navigation: AppNavigationCommands;
  notify(message: string): void;
  clearSelection(): void;
  setSelectedBlockFilters: StateSetter<Set<string>>;
  closeEventUpdateForEvent(eventName: string): void;
  setEventLists: StateSetter<Record<string, ShoppingItem[]>>;
  setEventMetadata: StateSetter<Record<string, EventMetadata>>;
  updateExecuteModeItems(
    updater: (
      current: Record<string, ExecuteModeItems>,
    ) => Record<string, ExecuteModeItems>,
  ): Record<string, ExecuteModeItems>;
  setDayModes: StateSetter<Record<string, DayModeState>>;
  setMapData: StateSetter<MapDataStore>;
  setMapRotationSettings: StateSetter<MapRotationSettingsStore>;
  setRouteSettings: StateSetter<RouteSettingsStore>;
  setHallDefinitions: StateSetter<HallDefinitionsStore>;
  setHallRouteSettings: StateSetter<HallRouteSettingsStore>;
  setMapViewportSettings: StateSetter<MapViewportSettingsStore>;
  setFocusModeSessions: StateSetter<Record<string, FocusModeSessionState>>;
  openRename(eventName: string): void;
  confirmEventOverlay(): void;
}

export interface EventLifecycleCommands {
  selectEvent(eventName: string): void;
  deleteEvent(eventName: string): Promise<void>;
  requestRename(eventName: string): void;
  confirmRename(newName: string): Promise<void>;
}

const toPersistenceSnapshot = (
  ports: Pick<
    EventLifecycleCommandPorts,
    | "eventLists"
    | "eventMetadata"
    | "executeModeItems"
    | "dayModes"
    | "mapData"
    | "mapRotationSettings"
    | "routeSettings"
    | "hallDefinitions"
    | "hallRouteSettings"
    | "mapViewportSettings"
  >,
): PersistenceSnapshot => ports as unknown as PersistenceSnapshot;

export const useEventLifecycleCommands = ({
  persistenceCommands,
  flushPendingSave,
  activeEventName,
  eventToRename,
  eventLists,
  eventMetadata,
  executeModeItems,
  dayModes,
  mapData,
  mapRotationSettings,
  routeSettings,
  hallDefinitions,
  hallRouteSettings,
  mapViewportSettings,
  navigation,
  notify,
  clearSelection,
  setSelectedBlockFilters,
  closeEventUpdateForEvent,
  setEventLists,
  setEventMetadata,
  updateExecuteModeItems,
  setDayModes,
  setMapData,
  setMapRotationSettings,
  setRouteSettings,
  setHallDefinitions,
  setHallRouteSettings,
  setMapViewportSettings,
  setFocusModeSessions,
  openRename,
  confirmEventOverlay,
}: EventLifecycleCommandPorts): EventLifecycleCommands => {
  const selectEvent = useCallback(
    (eventName: string) => {
      const nextTab = resolveEventListTab(eventLists[eventName] || []);
      if (!nextTab) {
        notify("参加日がないため処理を停止しました。");
        return;
      }

      navigation.openEvent(eventName, nextTab);
      clearSelection();
      setSelectedBlockFilters(new Set());
    },
    [clearSelection, eventLists, navigation, notify, setSelectedBlockFilters],
  );

  const deleteEvent = useCallback(
    async (eventName: string): Promise<void> => {
      try {
        await flushPendingSave();
        await persistenceCommands.deleteEventAtomically(
          toPersistenceSnapshot({
            eventLists,
            eventMetadata,
            executeModeItems,
            dayModes,
            mapData,
            mapRotationSettings,
            routeSettings,
            hallDefinitions,
            hallRouteSettings,
            mapViewportSettings,
          }),
          eventName,
        );
      } catch {
        notify(
          "イベントを削除できませんでした。保存状態は変更されていません。",
        );
        return;
      }
      closeEventUpdateForEvent(eventName);
      setEventLists((current) => removeRecordKey(current, eventName));
      setEventMetadata((current) => removeRecordKey(current, eventName));
      updateExecuteModeItems((current) => removeRecordKey(current, eventName));
      setDayModes((current) => removeRecordKey(current, eventName));
      setMapData((current) => removeRecordKey(current, eventName));
      setMapRotationSettings((current) => removeRecordKey(current, eventName));
      setRouteSettings((current) => removeRecordKey(current, eventName));
      setHallDefinitions((current) => removeRecordKey(current, eventName));
      setHallRouteSettings((current) => removeRecordKey(current, eventName));
      setMapViewportSettings((current) => removeRecordKey(current, eventName));
      setFocusModeSessions((current) =>
        removeFocusModeSessionByEvent(current, eventName),
      );
      navigation.removeEvent(eventName);
    },
    [
      navigation,
      dayModes,
      eventLists,
      eventMetadata,
      executeModeItems,
      flushPendingSave,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      mapRotationSettings,
      mapViewportSettings,
      notify,
      persistenceCommands,
      routeSettings,
      setDayModes,
      setEventLists,
      setEventMetadata,
      setFocusModeSessions,
      setHallDefinitions,
      setHallRouteSettings,
      setMapData,
      setMapRotationSettings,
      setMapViewportSettings,
      closeEventUpdateForEvent,
      setRouteSettings,
      updateExecuteModeItems,
    ],
  );

  const requestRename = useCallback(
    (eventName: string) => {
      openRename(eventName);
    },
    [openRename],
  );

  const confirmRename = useCallback(
    async (newName: string): Promise<void> => {
      if (!eventToRename) return;

      if (eventToRename === newName) {
        confirmEventOverlay();
        return;
      }

      if (eventLists[newName]) {
        notify("同名のイベントが既に存在します。別の名前を指定してください。");
        return;
      }

      try {
        await flushPendingSave();
        await persistenceCommands.renameEventAtomically(
          toPersistenceSnapshot({
            eventLists,
            eventMetadata,
            executeModeItems,
            dayModes,
            mapData,
            mapRotationSettings,
            routeSettings,
            hallDefinitions,
            hallRouteSettings,
            mapViewportSettings,
          }),
          eventToRename,
          newName,
        );
      } catch {
        notify(
          "イベント名を変更できませんでした。保存状態は変更されていません。",
        );
        return;
      }

      setEventLists((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setEventMetadata((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setDayModes((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      updateExecuteModeItems((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setMapData((current) => renameRecordKey(current, eventToRename, newName));
      setMapRotationSettings((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setRouteSettings((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setHallDefinitions((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setHallRouteSettings((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setMapViewportSettings((current) =>
        renameRecordKey(current, eventToRename, newName),
      );
      setFocusModeSessions((current) =>
        renameFocusModeSessionKeys(current, eventToRename, newName),
      );

      if (activeEventName === eventToRename) {
        navigation.renameActiveEvent(eventToRename, newName);
      }

      confirmEventOverlay();
    },
    [
      activeEventName,
      dayModes,
      eventLists,
      eventMetadata,
      eventToRename,
      executeModeItems,
      flushPendingSave,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      mapRotationSettings,
      mapViewportSettings,
      confirmEventOverlay,
      navigation,
      notify,
      persistenceCommands,
      routeSettings,
      setDayModes,
      setEventLists,
      setEventMetadata,
      setFocusModeSessions,
      setHallDefinitions,
      setHallRouteSettings,
      setMapData,
      setMapRotationSettings,
      setMapViewportSettings,
      setRouteSettings,
      updateExecuteModeItems,
    ],
  );

  return {
    selectEvent,
    deleteEvent,
    requestRename,
    confirmRename,
  };
};
