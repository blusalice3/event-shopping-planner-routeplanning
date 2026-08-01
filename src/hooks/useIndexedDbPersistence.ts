import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../types/item";
import { normalizeLimitedPurchaseFields } from "../utils/purchaseQuantity";
import {
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from "../types/map";
import { db, type LoadResult } from "../utils/indexedDB";

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
  setExecuteModeItems: Dispatch<
    SetStateAction<Record<string, ExecuteModeItems>>
  >;
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
  const previousSavedValuesRef = useRef<PersistedStateValues>(values);
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
    let isCancelled = false;

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
          if (result.status === "ok" && result.data) {
            return result.data;
          }
          if (result.status === "error") {
            console.error(
              `Failed to load ${storeLabel} from IndexedDB:`,
              result.error,
            );
            loadErrorStores.push(storeLabel);
          }
          return {} as T;
        };

        const resolvedEventLists = resolveLoadResult(
          "eventLists",
          loadedEventLists,
        );
        const resolvedMetadata = resolveLoadResult(
          "eventMetadata",
          loadedMetadata,
        );
        const resolvedExecuteItems = resolveLoadResult(
          "executeModeItems",
          loadedExecuteItems,
        );
        const resolvedDayModes = resolveLoadResult("dayModes", loadedDayModes);
        const resolvedMapData = resolveLoadResult("mapData", loadedMapData);
        const resolvedMapRotationSettings = resolveLoadResult(
          "mapRotationSettings",
          loadedMapRotationSettings,
        );
        const resolvedRouteSettings = resolveLoadResult(
          "routeSettings",
          loadedRouteSettings,
        );
        const resolvedHallDefinitions = resolveLoadResult(
          "hallDefinitions",
          loadedHallDefinitions,
        );
        const resolvedHallRouteSettings = resolveLoadResult(
          "hallRouteSettings",
          loadedHallRouteSettings,
        );
        const resolvedMapViewportSettings = resolveLoadResult(
          "mapViewportSettings",
          loadedMapViewportSettings,
        );

        const migratedLists: Record<string, ShoppingItem[]> = {};
        Object.keys(resolvedEventLists).forEach((eventName) => {
          migratedLists[eventName] = (
            resolvedEventLists[eventName] as ShoppingItem[]
          ).map((item: ShoppingItem) =>
            normalizeLimitedPurchaseFields({
              ...item,
              quantity: item.quantity ?? 1,
            }),
          );
        });

        if (isCancelled) return;

        const hydratedValues: PersistedStateValues = {
          eventLists: migratedLists,
          eventMetadata: resolvedMetadata as Record<string, EventMetadata>,
          executeModeItems: resolvedExecuteItems as Record<
            string,
            ExecuteModeItems
          >,
          dayModes: resolvedDayModes as Record<string, DayModeState>,
          mapData: resolvedMapData as MapDataStore,
          mapRotationSettings:
            resolvedMapRotationSettings as MapRotationSettingsStore,
          routeSettings: resolvedRouteSettings as RouteSettingsStore,
          hallDefinitions: resolvedHallDefinitions as HallDefinitionsStore,
          hallRouteSettings:
            resolvedHallRouteSettings as HallRouteSettingsStore,
          mapViewportSettings:
            resolvedMapViewportSettings as MapViewportSettingsStore,
        };

        // 画面を操作可能にする前に復元値を保存済み基準として確定する。
        // 初回の保存タイマーより先に変更されても、その変更を差分として保存できる。
        previousSavedValuesRef.current = hydratedValues;

        setEventLists(hydratedValues.eventLists);
        setEventMetadata(hydratedValues.eventMetadata);
        setExecuteModeItems(hydratedValues.executeModeItems);
        setDayModes(hydratedValues.dayModes);
        setMapData(hydratedValues.mapData);
        setMapRotationSettings(hydratedValues.mapRotationSettings);
        setRouteSettings(hydratedValues.routeSettings);
        setHallDefinitions(hydratedValues.hallDefinitions);
        setHallRouteSettings(hydratedValues.hallRouteSettings);
        setMapViewportSettings(hydratedValues.mapViewportSettings);

        if (loadErrorStores.length > 0 && !hasShownLoadErrorRef.current) {
          hasShownLoadErrorRef.current = true;
          alert(
            `一部の保存データの読み込みに失敗したため、初期値で起動しました。\n${loadErrorStores.join("\n")}`,
          );
        }
      } catch (error) {
        if (isCancelled) return;
        console.error("Failed to load data from IndexedDB:", error);
      }
      setIsInitialized(true);
    };

    void loadData();

    return () => {
      isCancelled = true;
    };
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
        const currentValues: PersistedStateValues = {
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
        const previousValues = previousSavedValuesRef.current;

        const saveTasks: { label: string; save: () => Promise<void> }[] = [];
        if (previousValues.eventLists !== eventLists) {
          saveTasks.push({
            label: "eventLists",
            save: () => db.saveEventLists(eventLists),
          });
        }
        if (previousValues.eventMetadata !== eventMetadata) {
          saveTasks.push({
            label: "eventMetadata",
            save: () => db.saveEventMetadata(eventMetadata),
          });
        }
        if (previousValues.executeModeItems !== executeModeItems) {
          saveTasks.push({
            label: "executeModeItems",
            save: () => db.saveExecuteModeItems(executeModeItems),
          });
        }
        if (previousValues.dayModes !== dayModes) {
          saveTasks.push({
            label: "dayModes",
            save: () => db.saveDayModes(dayModes),
          });
        }
        if (previousValues.mapData !== mapData) {
          saveTasks.push({
            label: "mapData",
            save: () => db.saveMapDataChanges(previousValues.mapData, mapData),
          });
        }
        if (previousValues.mapRotationSettings !== mapRotationSettings) {
          saveTasks.push({
            label: "mapRotationSettings",
            save: () => db.saveMapRotationSettings(mapRotationSettings),
          });
        }
        if (previousValues.routeSettings !== routeSettings) {
          saveTasks.push({
            label: "routeSettings",
            save: () => db.saveRouteSettings(routeSettings),
          });
        }
        if (previousValues.hallDefinitions !== hallDefinitions) {
          saveTasks.push({
            label: "hallDefinitions",
            save: () => db.saveHallDefinitions(hallDefinitions),
          });
        }
        if (previousValues.hallRouteSettings !== hallRouteSettings) {
          saveTasks.push({
            label: "hallRouteSettings",
            save: () => db.saveHallRouteSettings(hallRouteSettings),
          });
        }
        if (previousValues.mapViewportSettings !== mapViewportSettings) {
          saveTasks.push({
            label: "mapViewportSettings",
            save: () => db.saveMapViewportSettings(mapViewportSettings),
          });
        }

        if (saveTasks.length === 0) return;

        // ストアを1つずつ順番に保存する。並列実行すると、あるストアの保存失敗時の
        // DB接続リセットが実行中の他ストアのトランザクションを巻き添えでabortさせ、
        // 実際には保存できるデータでも失敗扱いになってしまうため。
        const failed: { label: string; error: unknown }[] = [];
        for (const { label, save } of saveTasks) {
          try {
            await save();
          } catch (error) {
            failed.push({ label, error });
          }
        }

        // 成功したストアは保存済みとして記録し、失敗したストアだけ次回の保存で再試行する
        const nextSavedValues: PersistedStateValues = { ...currentValues };
        for (const failure of failed) {
          const label = failure.label as keyof PersistedStateValues;
          if (label in previousValues) {
            (nextSavedValues as Record<string, unknown>)[label] =
              previousValues[label];
          }
        }
        previousSavedValuesRef.current = nextSavedValues;

        if (failed.length > 0) {
          console.error("Failed to save data to IndexedDB:", failed);
          return;
        }
      } catch (error) {
        console.error("Failed to save data to IndexedDB:", error);
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
