import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  MemberRouteItems,
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
  memberRouteItems: Record<string, MemberRouteItems>;
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
  setMemberRouteItems: Dispatch<SetStateAction<Record<string, MemberRouteItems>>>;
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
  const {
    eventLists,
    eventMetadata,
    executeModeItems,
    memberRouteItems,
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
    setMemberRouteItems,
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
          loadedMemberRouteItems,
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
          db.loadMemberRouteItems(),
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
        const resolvedMemberRouteItems = resolveLoadResult(
          'memberRouteItems',
          loadedMemberRouteItems,
        );
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
        setMemberRouteItems(resolvedMemberRouteItems as Record<string, MemberRouteItems>);
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
    setMemberRouteItems,
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
        await Promise.all([
          db.saveEventLists(eventLists),
          db.saveEventMetadata(eventMetadata),
          db.saveExecuteModeItems(executeModeItems),
          db.saveMemberRouteItems(memberRouteItems),
          db.saveDayModes(dayModes),
          db.saveMapData(mapData),
          db.saveMapRotationSettings(mapRotationSettings),
          db.saveRouteSettings(routeSettings),
          db.saveHallDefinitions(hallDefinitions),
          db.saveHallRouteSettings(hallRouteSettings),
          db.saveMapViewportSettings(mapViewportSettings),
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
    memberRouteItems,
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
