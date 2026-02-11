import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
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
          loadedRouteSettings,
          loadedHallDefinitions,
          loadedHallRouteSettings,
        ] = await Promise.all([
          db.loadEventLists(),
          db.loadEventMetadata(),
          db.loadExecuteModeItems(),
          db.loadDayModes(),
          db.loadMapData(),
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
    routeSettings,
    hallDefinitions,
    hallRouteSettings,
  ]);

  return { isInitialized } as const;
}
