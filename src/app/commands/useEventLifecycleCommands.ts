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
import type { PendingEventUpdate } from "../../features/events/updateFlow";
import {
  removeRecordKey,
  renameRecordKey,
} from "../../features/events/recordOps";
import { resolveEventListTab } from "../../features/events/uiOrchestration";
import {
  removeBlockDetectionSettingsForEvent,
  renameBlockDetectionSettingsForEvent,
} from "../../utils/blockDetectionSettingsStorage";

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
  activeEventName: string | null;
  eventToRename: string | null;
  eventLists: Record<string, ShoppingItem[]>;
  navigation: AppNavigationCommands;
  notify(message: string): void;
  clearSelection(): void;
  setSelectedBlockFilters: StateSetter<Set<string>>;
  setPendingEventUpdate: StateSetter<PendingEventUpdate | null>;
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
  setEventToRename: StateSetter<string | null>;
  setShowRenameDialog: StateSetter<boolean>;
}

export interface EventLifecycleCommands {
  selectEvent(eventName: string): void;
  deleteEvent(eventName: string): void;
  requestRename(eventName: string): void;
  confirmRename(newName: string): void;
}

export const useEventLifecycleCommands = ({
  activeEventName,
  eventToRename,
  eventLists,
  navigation,
  notify,
  clearSelection,
  setSelectedBlockFilters,
  setPendingEventUpdate,
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
  setEventToRename,
  setShowRenameDialog,
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
    (eventName: string) => {
      setPendingEventUpdate((pending) =>
        pending?.eventName === eventName ? null : pending,
      );
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
      removeBlockDetectionSettingsForEvent(eventName);
      setFocusModeSessions((current) =>
        removeFocusModeSessionByEvent(current, eventName),
      );
      navigation.removeEvent(eventName);
    },
    [
      navigation,
      setDayModes,
      setEventLists,
      setEventMetadata,
      setFocusModeSessions,
      setHallDefinitions,
      setHallRouteSettings,
      setMapData,
      setMapRotationSettings,
      setMapViewportSettings,
      setPendingEventUpdate,
      setRouteSettings,
      updateExecuteModeItems,
    ],
  );

  const requestRename = useCallback(
    (eventName: string) => {
      setEventToRename(eventName);
      setShowRenameDialog(true);
    },
    [setEventToRename, setShowRenameDialog],
  );

  const confirmRename = useCallback(
    (newName: string) => {
      if (!eventToRename) return;

      if (eventToRename === newName) {
        setShowRenameDialog(false);
        setEventToRename(null);
        return;
      }

      if (eventLists[newName]) {
        notify("同名のイベントが既に存在します。別の名前を指定してください。");
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
      renameBlockDetectionSettingsForEvent(eventToRename, newName);
      setFocusModeSessions((current) =>
        renameFocusModeSessionKeys(current, eventToRename, newName),
      );

      if (activeEventName === eventToRename) {
        navigation.renameActiveEvent(eventToRename, newName);
      }

      setShowRenameDialog(false);
      setEventToRename(null);
    },
    [
      activeEventName,
      eventLists,
      eventToRename,
      navigation,
      notify,
      setDayModes,
      setEventLists,
      setEventMetadata,
      setEventToRename,
      setFocusModeSessions,
      setHallDefinitions,
      setHallRouteSettings,
      setMapData,
      setMapRotationSettings,
      setMapViewportSettings,
      setRouteSettings,
      setShowRenameDialog,
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
