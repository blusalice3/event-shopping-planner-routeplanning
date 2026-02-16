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
import { db, type LoadResult } from '../utils/indexedDB';

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
  const hasShownLoadErrorRef = useRef(false);
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

        const loadErrorStores: string[] = [];
        const resolveLoadResult = <T extends Record<string, unknown>>(
          storeLabel: string,
          result: LoadResult<T>,
        ): T => {
          if (result.status === 'ok' && result.data) {
            return result.data;
          }
          if (result.status === 'error') {
            console.error(`Failed to load ${storeLabel} from IndexedDB:`, result.error);
            loadErrorStores.push(storeLabel);
          }
          return {} as T;
        };

        const resolvedEventLists = resolveLoadResult('eventLists', loadedEventLists);
        const resolvedMetadata = resolveLoadResult('eventMetadata', loadedMetadata);
        const resolvedExecuteItems = resolveLoadResult('executeModeItems', loadedExecuteItems);
        const resolvedDayModes = resolveLoadResult('dayModes', loadedDayModes);
        const resolvedMapData = resolveLoadResult('mapData', loadedMapData);
        const resolvedMapRotationSettings = resolveLoadResult(
          'mapRotationSettings',
          loadedMapRotationSettings,
        );
        const resolvedRouteSettings = resolveLoadResult('routeSettings', loadedRouteSettings);
        const resolvedHallDefinitions = resolveLoadResult(
          'hallDefinitions',
          loadedHallDefinitions,
        );
        const resolvedHallRouteSettings = resolveLoadResult(
          'hallRouteSettings',
          loadedHallRouteSettings,
        );

        const migratedLists: Record<string, ShoppingItem[]> = {};
        Object.keys(resolvedEventLists).forEach((eventName) => {
          migratedLists[eventName] = (resolvedEventLists[eventName] as ShoppingItem[]).map(
            (item: ShoppingItem) => ({
              ...item,
              quantity: item.quantity ?? 1,
            }),
          );
        });

        setEventLists(migratedLists);
        setEventMetadata(resolvedMetadata as Record<string, EventMetadata>);
        setExecuteModeItems(resolvedExecuteItems as Record<string, ExecuteModeItems>);
        setDayModes(resolvedDayModes as Record<string, DayModeState>);
        setMapData(resolvedMapData as MapDataStore);
        setMapRotationSettings(resolvedMapRotationSettings as MapRotationSettingsStore);
        setRouteSettings(resolvedRouteSettings as RouteSettingsStore);
        setHallDefinitions(resolvedHallDefinitions as HallDefinitionsStore);
        setHallRouteSettings(resolvedHallRouteSettings as HallRouteSettingsStore);

        if (loadErrorStores.length > 0 && !hasShownLoadErrorRef.current) {
          hasShownLoadErrorRef.current = true;
          alert(
            `一部の保存データの読み込みに失敗したため、初期値で起動しました。\n${loadErrorStores.join('\n')}`,
          );
        }
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
