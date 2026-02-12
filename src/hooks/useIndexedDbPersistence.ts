import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  RouteSettingsStore,
  ShoppingItem,
} from '../types';
import { db } from '../utils/indexedDB';

type PersistedStateValues = {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  mapRotationSettings: MapRotationSettingsStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
};

type PersistedStateSetters = {
  setEventLists: Dispatch<SetStateAction<Record<string, ShoppingItem[]>>>;
  setEventMetadata: Dispatch<SetStateAction<Record<string, EventMetadata>>>;
  setExecuteModeItems: Dispatch<SetStateAction<Record<string, ExecuteModeItems>>>;
  setDayModes: Dispatch<SetStateAction<Record<string, DayModeState>>>;
  setMapData: Dispatch<SetStateAction<MapDataStore>>;
  setMapRotationSettings: Dispatch<SetStateAction<MapRotationSettingsStore>>;
  setRouteSettings: Dispatch<SetStateAction<RouteSettingsStore>>;
  setHallDefinitions: Dispatch<SetStateAction<HallDefinitionsStore>>;
  setHallRouteSettings: Dispatch<SetStateAction<HallRouteSettingsStore>>;
};

type UseIndexedDbPersistenceParams = {
  values: PersistedStateValues;
  setters: PersistedStateSetters;
  saveDelayMs?: number;
};

export function useIndexedDbPersistence({
  values,
  setters,
  saveDelayMs = 500,
}: UseIndexedDbPersistenceParams) {
  const [isInitialized, setIsInitialized] = useState(false);
  const isSavingRef = useRef(false);
  const {
    eventLists,
    eventMetadata,
    executeModeItems,
    dayModes,
    mapData,
    mapRotationSettings,
    routeSettings,
    hallDefinitions,
    hallRouteSettings,
  } = values;
  const {
    setEventLists,
    setEventMetadata,
    setExecuteModeItems,
    setDayModes,
    setMapData,
    setMapRotationSettings,
    setRouteSettings,
    setHallDefinitions,
    setHallRouteSettings,
  } = setters;

  useEffect(() => {
    const loadData = async () => {
      try {
        await db.migrateFromLocalStorage();

        const [
          loadedEventLists,
          loadedMetadata,
          loadedExecuteItems,
          loadedDayModes,
          loadedMapData,
          loadedMapRotationSettings,
          loadedRouteSettings,
          loadedHallDefinitions,
          loadedHallRouteSettings,
        ] = await Promise.all([
          db.loadEventLists(),
          db.loadEventMetadata(),
          db.loadExecuteModeItems(),
          db.loadDayModes(),
          db.loadMapData(),
          db.loadMapRotationSettings(),
          db.loadRouteSettings(),
          db.loadHallDefinitions(),
          db.loadHallRouteSettings(),
        ]);

        const migratedLists: Record<string, ShoppingItem[]> = {};
        Object.keys(loadedEventLists).forEach((eventName) => {
          migratedLists[eventName] = (loadedEventLists[eventName] as ShoppingItem[]).map(
            (item: ShoppingItem) => ({
              ...item,
              quantity: item.quantity ?? 1,
            }),
          );
        });

        setEventLists(migratedLists);
        setEventMetadata(loadedMetadata as Record<string, EventMetadata>);
        setExecuteModeItems(loadedExecuteItems);
        setDayModes(loadedDayModes as Record<string, DayModeState>);
        setMapData(loadedMapData as MapDataStore);
        setMapRotationSettings(loadedMapRotationSettings as MapRotationSettingsStore);
        setRouteSettings(loadedRouteSettings as RouteSettingsStore);
        setHallDefinitions(loadedHallDefinitions as HallDefinitionsStore);
        setHallRouteSettings(loadedHallRouteSettings as HallRouteSettingsStore);
      } catch (error) {
        console.error('Failed to load data from IndexedDB:', error);
      }
      setIsInitialized(true);
    };

    loadData();
  }, [
    setDayModes,
    setEventLists,
    setEventMetadata,
    setExecuteModeItems,
    setHallDefinitions,
    setHallRouteSettings,
    setMapData,
    setMapRotationSettings,
    setRouteSettings,
  ]);

  useEffect(() => {
    if (!isInitialized || isSavingRef.current) return;

    const saveData = async () => {
      isSavingRef.current = true;
      try {
        await Promise.all([
          db.saveEventLists(eventLists),
          db.saveEventMetadata(eventMetadata),
          db.saveExecuteModeItems(executeModeItems),
          db.saveDayModes(dayModes),
          db.saveMapData(mapData),
          db.saveMapRotationSettings(mapRotationSettings),
          db.saveRouteSettings(routeSettings),
          db.saveHallDefinitions(hallDefinitions),
          db.saveHallRouteSettings(hallRouteSettings),
        ]);
      } catch (error) {
        console.error('Failed to save data to IndexedDB:', error);
        alert('Failed to save data. Please reload the page.');
      } finally {
        isSavingRef.current = false;
      }
    };

    const timeoutId = setTimeout(saveData, saveDelayMs);
    return () => clearTimeout(timeoutId);
  }, [
    isInitialized,
    saveDelayMs,
    eventLists,
    eventMetadata,
    executeModeItems,
    dayModes,
    mapData,
    mapRotationSettings,
    routeSettings,
    hallDefinitions,
    hallRouteSettings,
  ]);

  return { isInitialized } as const;
}
