import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from '../types/item';
import { normalizeLimitedPurchaseFields } from '../utils/purchaseQuantity';
import {
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from '../types/map';
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
  mapViewportSettings: MapViewportSettingsStore;
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
  setMapViewportSettings: Dispatch<SetStateAction<MapViewportSettingsStore>>;
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
  const hasShownSaveErrorRef = useRef(false);
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
    mapViewportSettings,
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
    setMapViewportSettings,
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
          loadedMapViewportSettings,
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
          db.loadMapViewportSettings(),
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
        const resolvedMapViewportSettings = resolveLoadResult(
          'mapViewportSettings',
          loadedMapViewportSettings,
        );

        const migratedLists: Record<string, ShoppingItem[]> = {};
        Object.keys(resolvedEventLists).forEach((eventName) => {
          migratedLists[eventName] = (resolvedEventLists[eventName] as ShoppingItem[]).map(
            (item: ShoppingItem) =>
              normalizeLimitedPurchaseFields({
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
        setMapViewportSettings(resolvedMapViewportSettings as MapViewportSettingsStore);

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
    setMapViewportSettings,
    setRouteSettings,
  ]);

  useEffect(() => {
    if (!isInitialized || isSavingRef.current) return;

    const saveData = async () => {
      isSavingRef.current = true;
      try {
        const toIndexedDbSafeData = <T,>(data: T): T => JSON.parse(JSON.stringify(data)) as T;
        const saveTasks = [
          {
            label: 'eventLists',
            save: () => db.saveEventLists(toIndexedDbSafeData(eventLists)),
          },
          {
            label: 'eventMetadata',
            save: () => db.saveEventMetadata(toIndexedDbSafeData(eventMetadata)),
          },
          {
            label: 'executeModeItems',
            save: () => db.saveExecuteModeItems(toIndexedDbSafeData(executeModeItems)),
          },
          {
            label: 'dayModes',
            save: () => db.saveDayModes(toIndexedDbSafeData(dayModes)),
          },
          {
            label: 'mapData',
            save: () => db.saveMapData(toIndexedDbSafeData(mapData)),
          },
          {
            label: 'mapRotationSettings',
            save: () => db.saveMapRotationSettings(toIndexedDbSafeData(mapRotationSettings)),
          },
          {
            label: 'routeSettings',
            save: () => db.saveRouteSettings(toIndexedDbSafeData(routeSettings)),
          },
          {
            label: 'hallDefinitions',
            save: () => db.saveHallDefinitions(toIndexedDbSafeData(hallDefinitions)),
          },
          {
            label: 'hallRouteSettings',
            save: () => db.saveHallRouteSettings(toIndexedDbSafeData(hallRouteSettings)),
          },
          {
            label: 'mapViewportSettings',
            save: () => db.saveMapViewportSettings(toIndexedDbSafeData(mapViewportSettings)),
          },
        ];

        const results = await Promise.allSettled(
          saveTasks.map(async ({ label, save }) => {
            try {
              await save();
            } catch (error) {
              throw { label, error };
            }
          }),
        );
        const failed = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);

        if (failed.length > 0) {
          console.error('Failed to save data to IndexedDB:', failed);
          if (!hasShownSaveErrorRef.current) {
            hasShownSaveErrorRef.current = true;
            alert(
              `保存に失敗しました。ページを再読み込みしてください。\n${failed
                .map((failure) => failure.label || 'unknown')
                .join('\n')}`,
            );
          }
          return;
        }
        hasShownSaveErrorRef.current = false;
      } catch (error) {
        console.error('Failed to save data to IndexedDB:', error);
        if (!hasShownSaveErrorRef.current) {
          hasShownSaveErrorRef.current = true;
          alert('保存に失敗しました。ページを再読み込みしてください。');
        }
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
    mapViewportSettings,
  ]);

  return { isInitialized } as const;
}
