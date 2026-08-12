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

export interface EventLifecyclePersistenceValues {
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
}

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

export interface EventLifecycleCommandPorts extends EventLifecyclePersistenceValues {
  persistenceCommands: Pick<
    PersistenceCommandPort,
    "deleteEventAtomically" | "renameEventAtomically"
  >;
  flushPendingSave(): Promise<void>;
  runExclusiveRestore<T>(
    restoredValues: EventLifecyclePersistenceValues,
    restore: () => Promise<T>,
  ): Promise<T>;
  activeEventName: string | null;
  eventToRename: string | null;
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
  values: EventLifecyclePersistenceValues,
): PersistenceSnapshot => values as unknown as PersistenceSnapshot;

const removeEventFromPersistenceValues = (
  values: EventLifecyclePersistenceValues,
  eventName: string,
): EventLifecyclePersistenceValues => ({
  eventLists: removeRecordKey(values.eventLists, eventName),
  eventMetadata: removeRecordKey(values.eventMetadata, eventName),
  executeModeItems: removeRecordKey(values.executeModeItems, eventName),
  dayModes: removeRecordKey(values.dayModes, eventName),
  mapData: removeRecordKey(values.mapData, eventName),
  mapRotationSettings: removeRecordKey(values.mapRotationSettings, eventName),
  routeSettings: removeRecordKey(values.routeSettings, eventName),
  hallDefinitions: removeRecordKey(values.hallDefinitions, eventName),
  hallRouteSettings: removeRecordKey(values.hallRouteSettings, eventName),
  mapViewportSettings: removeRecordKey(values.mapViewportSettings, eventName),
});

const renameEventInPersistenceValues = (
  values: EventLifecyclePersistenceValues,
  oldEventName: string,
  newEventName: string,
): EventLifecyclePersistenceValues => ({
  eventLists: renameRecordKey(values.eventLists, oldEventName, newEventName),
  eventMetadata: renameRecordKey(
    values.eventMetadata,
    oldEventName,
    newEventName,
  ),
  executeModeItems: renameRecordKey(
    values.executeModeItems,
    oldEventName,
    newEventName,
  ),
  dayModes: renameRecordKey(values.dayModes, oldEventName, newEventName),
  mapData: renameRecordKey(values.mapData, oldEventName, newEventName),
  mapRotationSettings: renameRecordKey(
    values.mapRotationSettings,
    oldEventName,
    newEventName,
  ),
  routeSettings: renameRecordKey(
    values.routeSettings,
    oldEventName,
    newEventName,
  ),
  hallDefinitions: renameRecordKey(
    values.hallDefinitions,
    oldEventName,
    newEventName,
  ),
  hallRouteSettings: renameRecordKey(
    values.hallRouteSettings,
    oldEventName,
    newEventName,
  ),
  mapViewportSettings: renameRecordKey(
    values.mapViewportSettings,
    oldEventName,
    newEventName,
  ),
});

const resolveCommittedRecord = <T>(
  current: Record<string, T>,
  operationSource: Record<string, T>,
  committed: Record<string, T>,
  update: (currentValue: Record<string, T>) => Record<string, T>,
): Record<string, T> =>
  current === operationSource ? committed : update(current);

export const useEventLifecycleCommands = ({
  persistenceCommands,
  flushPendingSave,
  runExclusiveRestore,
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
      const operationSource: EventLifecyclePersistenceValues = {
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
      };
      const committedValues = removeEventFromPersistenceValues(
        operationSource,
        eventName,
      );

      try {
        await flushPendingSave();
        await runExclusiveRestore(committedValues, () =>
          persistenceCommands.deleteEventAtomically(
            toPersistenceSnapshot(operationSource),
            eventName,
          ),
        );
      } catch {
        notify(
          "イベントを削除できませんでした。保存状態は変更されていません。",
        );
        return;
      }
      closeEventUpdateForEvent(eventName);
      setEventLists((current) =>
        resolveCommittedRecord(
          current,
          operationSource.eventLists,
          committedValues.eventLists,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setEventMetadata((current) =>
        resolveCommittedRecord(
          current,
          operationSource.eventMetadata,
          committedValues.eventMetadata,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      updateExecuteModeItems((current) =>
        resolveCommittedRecord(
          current,
          operationSource.executeModeItems,
          committedValues.executeModeItems,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setDayModes((current) =>
        resolveCommittedRecord(
          current,
          operationSource.dayModes,
          committedValues.dayModes,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setMapData((current) =>
        resolveCommittedRecord(
          current,
          operationSource.mapData,
          committedValues.mapData,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setMapRotationSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.mapRotationSettings,
          committedValues.mapRotationSettings,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setRouteSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.routeSettings,
          committedValues.routeSettings,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setHallDefinitions((current) =>
        resolveCommittedRecord(
          current,
          operationSource.hallDefinitions,
          committedValues.hallDefinitions,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setHallRouteSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.hallRouteSettings,
          committedValues.hallRouteSettings,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
      setMapViewportSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.mapViewportSettings,
          committedValues.mapViewportSettings,
          (latest) => removeRecordKey(latest, eventName),
        ),
      );
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
      runExclusiveRestore,
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

      const operationSource: EventLifecyclePersistenceValues = {
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
      };
      const committedValues = renameEventInPersistenceValues(
        operationSource,
        eventToRename,
        newName,
      );

      try {
        await flushPendingSave();
        await runExclusiveRestore(committedValues, () =>
          persistenceCommands.renameEventAtomically(
            toPersistenceSnapshot(operationSource),
            eventToRename,
            newName,
          ),
        );
      } catch {
        notify(
          "イベント名を変更できませんでした。保存状態は変更されていません。",
        );
        return;
      }

      setEventLists((current) =>
        resolveCommittedRecord(
          current,
          operationSource.eventLists,
          committedValues.eventLists,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setEventMetadata((current) =>
        resolveCommittedRecord(
          current,
          operationSource.eventMetadata,
          committedValues.eventMetadata,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setDayModes((current) =>
        resolveCommittedRecord(
          current,
          operationSource.dayModes,
          committedValues.dayModes,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      updateExecuteModeItems((current) =>
        resolveCommittedRecord(
          current,
          operationSource.executeModeItems,
          committedValues.executeModeItems,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setMapData((current) =>
        resolveCommittedRecord(
          current,
          operationSource.mapData,
          committedValues.mapData,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setMapRotationSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.mapRotationSettings,
          committedValues.mapRotationSettings,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setRouteSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.routeSettings,
          committedValues.routeSettings,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setHallDefinitions((current) =>
        resolveCommittedRecord(
          current,
          operationSource.hallDefinitions,
          committedValues.hallDefinitions,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setHallRouteSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.hallRouteSettings,
          committedValues.hallRouteSettings,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
      );
      setMapViewportSettings((current) =>
        resolveCommittedRecord(
          current,
          operationSource.mapViewportSettings,
          committedValues.mapViewportSettings,
          (latest) => renameRecordKey(latest, eventToRename, newName),
        ),
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
      runExclusiveRestore,
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
