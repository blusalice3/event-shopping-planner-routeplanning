import { useState, useEffect, useRef, useCallback } from 'react';
import { ShoppingItem, EventMetadata, DayModeState, ExecuteModeItems, MapDataStore, RouteSettingsStore, HallDefinitionsStore, HallRouteSettingsStore } from '../types';
import { db } from '../utils/indexedDB';

export interface AppDataState {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
}

export interface AppDataSetters {
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setEventMetadata: React.Dispatch<React.SetStateAction<Record<string, EventMetadata>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setDayModes: React.Dispatch<React.SetStateAction<Record<string, DayModeState>>>;
  setMapData: React.Dispatch<React.SetStateAction<MapDataStore>>;
  setRouteSettings: React.Dispatch<React.SetStateAction<RouteSettingsStore>>;
  setHallDefinitions: React.Dispatch<React.SetStateAction<HallDefinitionsStore>>;
  setHallRouteSettings: React.Dispatch<React.SetStateAction<HallRouteSettingsStore>>;
}

/**
 * Handles loading from and saving to IndexedDB with debounce.
 * Returns isInitialized flag.
 */
export function usePersistence(
  state: AppDataState,
  setters: AppDataSetters,
): boolean {
  const [isInitialized, setIsInitialized] = useState(false);
  const isSavingRef = useRef(false);

  // Load from IndexedDB on mount
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

        // Migration: ensure quantity field exists
        const migratedLists: Record<string, ShoppingItem[]> = {};
        Object.keys(loadedEventLists).forEach(eventName => {
          migratedLists[eventName] = (loadedEventLists[eventName] as ShoppingItem[]).map((item: ShoppingItem) => ({
            ...item,
            quantity: item.quantity ?? 1,
          }));
        });

        setters.setEventLists(migratedLists);
        setters.setEventMetadata(loadedMetadata as Record<string, EventMetadata>);
        setters.setExecuteModeItems(loadedExecuteItems);
        setters.setDayModes(loadedDayModes as Record<string, DayModeState>);
        setters.setMapData(loadedMapData as MapDataStore);
        setters.setRouteSettings(loadedRouteSettings as RouteSettingsStore);
        setters.setHallDefinitions(loadedHallDefinitions as HallDefinitionsStore);
        setters.setHallRouteSettings(loadedHallRouteSettings as HallRouteSettingsStore);

        console.log('Data loaded from IndexedDB');
      } catch (error) {
        console.error('Failed to load data from IndexedDB:', error);
      }
      setIsInitialized(true);
    };

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save to IndexedDB with debounce
  useEffect(() => {
    if (!isInitialized || isSavingRef.current) return;

    const saveData = async () => {
      isSavingRef.current = true;
      try {
        await Promise.all([
          db.saveEventLists(state.eventLists),
          db.saveEventMetadata(state.eventMetadata),
          db.saveExecuteModeItems(state.executeModeItems),
          db.saveDayModes(state.dayModes),
          db.saveMapData(state.mapData),
          db.saveRouteSettings(state.routeSettings),
          db.saveHallDefinitions(state.hallDefinitions),
          db.saveHallRouteSettings(state.hallRouteSettings),
        ]);
        console.log('Data saved to IndexedDB');
      } catch (error) {
        console.error('Failed to save data to IndexedDB:', error);
        alert('データの保存に失敗しました。ストレージ容量を確認してください。');
      } finally {
        isSavingRef.current = false;
      }
    };

    const timeoutId = setTimeout(saveData, 500);
    return () => clearTimeout(timeoutId);
  }, [
    state.eventLists, state.eventMetadata, state.executeModeItems, state.dayModes,
    state.mapData, state.routeSettings, state.hallDefinitions, state.hallRouteSettings,
    isInitialized,
  ]);

  return isInitialized;
}
