import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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

export type PersistedStateValues = {
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

export type PersistedStoreName = keyof PersistedStateValues;

export type PersistenceStatus = "unsaved" | "saving" | "saved" | "failed";

export type PersistenceFailureCategory =
  | "quota"
  | "permission"
  | "data-clone"
  | "database"
  | "unknown";

export interface PersistenceFailureDetail {
  storeName: PersistedStoreName;
  category: PersistenceFailureCategory;
  errorCode: string;
  userMessage: string;
  technicalMessage: string | null;
}

const MAX_ERROR_CODE_LENGTH = 64;
const MAX_TECHNICAL_MESSAGE_LENGTH = 160;

const DATABASE_ERROR_NAMES = new Set([
  "AbortError",
  "ConstraintError",
  "InvalidAccessError",
  "InvalidStateError",
  "NotFoundError",
  "OperationError",
  "ReadOnlyError",
  "TimeoutError",
  "TransactionInactiveError",
  "UnknownError",
  "VersionError",
]);

const FAILURE_MESSAGES: Record<PersistenceFailureCategory, string> = {
  quota:
    "ブラウザーの保存容量が不足しています。JSONバックアップを保存し、不要なサイトデータを整理してから再試行してください。",
  permission:
    "ブラウザーがこのサイトのデータ保存を許可していません。サイトデータの保存を許可してから再試行してください。",
  "data-clone":
    "保存できない形式のデータが含まれています。JSONバックアップを保存し、問題のデータを確認してください。",
  database:
    "ブラウザーの保存領域に異常があります。ページを再読み込みして再試行し、改善しない場合はサイトデータを確認してください。",
  unknown:
    "保存中に予期しない問題が発生しました。再試行し、改善しない場合はJSONバックアップを保存してください。",
};

const readErrorField = (
  error: unknown,
  field: "name" | "code" | "message",
): string => {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return "";
  }

  try {
    const value = (error as Record<string, unknown>)[field];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  } catch {
    return "";
  }
};

const sanitizeSingleLine = (value: string, maxLength: number): string => {
  const singleLine = value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
};

const sanitizeErrorCode = (value: string): string => {
  const safeCode = value
    .replace(/[\r\n\u2028\u2029\s]+/g, "")
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .slice(0, MAX_ERROR_CODE_LENGTH);
  return safeCode || "UnknownError";
};

const stringifyPrimitiveError = (error: unknown): string => {
  if (
    error === null ||
    error === undefined ||
    !["string", "number", "boolean", "bigint", "symbol"].includes(typeof error)
  ) {
    return "";
  }

  try {
    return String(error);
  } catch {
    return "";
  }
};

export const normalizePersistenceFailure = (
  storeName: PersistedStoreName,
  error: unknown,
): PersistenceFailureDetail => {
  const rawName = readErrorField(error, "name");
  const rawCode = readErrorField(error, "code");
  const rawMessage =
    readErrorField(error, "message") || stringifyPrimitiveError(error);
  const classificationText =
    `${rawName} ${rawCode} ${rawMessage}`.toLowerCase();
  const errorNames = new Set([rawName, rawCode].filter(Boolean));

  let category: PersistenceFailureCategory = "unknown";
  if (
    errorNames.has("QuotaExceededError") ||
    classificationText.includes("quotaexceeded") ||
    classificationText.includes("quota exceeded")
  ) {
    category = "quota";
  } else if (
    errorNames.has("SecurityError") ||
    errorNames.has("NotAllowedError")
  ) {
    category = "permission";
  } else if (
    errorNames.has("DataCloneError") ||
    classificationText.includes("dataclone")
  ) {
    category = "data-clone";
  } else if (
    Array.from(errorNames).some((name) => DATABASE_ERROR_NAMES.has(name)) ||
    /\b(indexeddb|database|object store|transaction)\b/.test(classificationText)
  ) {
    category = "database";
  }

  const codeSource =
    (rawName && rawName !== "Error" ? rawName : rawCode || rawName) ||
    "UnknownError";
  const technicalMessage = sanitizeSingleLine(
    rawMessage,
    MAX_TECHNICAL_MESSAGE_LENGTH,
  );

  return {
    storeName,
    category,
    errorCode: sanitizeErrorCode(codeSource),
    userMessage: FAILURE_MESSAGES[category],
    technicalMessage: technicalMessage || null,
  };
};

type SaveTask = {
  label: PersistedStoreName;
  save: () => Promise<void>;
};

const createSaveTasks = (
  previousValues: PersistedStateValues,
  currentValues: PersistedStateValues,
): SaveTask[] => {
  const saveTasks: SaveTask[] = [];
  if (previousValues.eventLists !== currentValues.eventLists) {
    saveTasks.push({
      label: "eventLists",
      save: () => db.saveEventLists(currentValues.eventLists),
    });
  }
  if (previousValues.eventMetadata !== currentValues.eventMetadata) {
    saveTasks.push({
      label: "eventMetadata",
      save: () => db.saveEventMetadata(currentValues.eventMetadata),
    });
  }
  if (previousValues.executeModeItems !== currentValues.executeModeItems) {
    saveTasks.push({
      label: "executeModeItems",
      save: () => db.saveExecuteModeItems(currentValues.executeModeItems),
    });
  }
  if (previousValues.dayModes !== currentValues.dayModes) {
    saveTasks.push({
      label: "dayModes",
      save: () => db.saveDayModes(currentValues.dayModes),
    });
  }
  if (previousValues.mapData !== currentValues.mapData) {
    saveTasks.push({
      label: "mapData",
      save: () =>
        db.saveMapDataChanges(previousValues.mapData, currentValues.mapData),
    });
  }
  if (
    previousValues.mapRotationSettings !== currentValues.mapRotationSettings
  ) {
    saveTasks.push({
      label: "mapRotationSettings",
      save: () => db.saveMapRotationSettings(currentValues.mapRotationSettings),
    });
  }
  if (previousValues.routeSettings !== currentValues.routeSettings) {
    saveTasks.push({
      label: "routeSettings",
      save: () => db.saveRouteSettings(currentValues.routeSettings),
    });
  }
  if (previousValues.hallDefinitions !== currentValues.hallDefinitions) {
    saveTasks.push({
      label: "hallDefinitions",
      save: () => db.saveHallDefinitions(currentValues.hallDefinitions),
    });
  }
  if (previousValues.hallRouteSettings !== currentValues.hallRouteSettings) {
    saveTasks.push({
      label: "hallRouteSettings",
      save: () => db.saveHallRouteSettings(currentValues.hallRouteSettings),
    });
  }
  if (
    previousValues.mapViewportSettings !== currentValues.mapViewportSettings
  ) {
    saveTasks.push({
      label: "mapViewportSettings",
      save: () => db.saveMapViewportSettings(currentValues.mapViewportSettings),
    });
  }
  return saveTasks;
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
  const [persistenceStatus, setPersistenceStatus] =
    useState<PersistenceStatus>("saved");
  const [failedStores, setFailedStores] = useState<PersistedStoreName[]>([]);
  const [failureDetails, setFailureDetails] = useState<
    PersistenceFailureDetail[]
  >([]);
  const isSavingRef = useRef(false);
  const saveRequestedRef = useRef(false);
  const latestValuesRef = useRef<PersistedStateValues>(values);
  const hasShownLoadErrorRef = useRef(false);
  const previousSavedValuesRef = useRef<PersistedStateValues>(values);
  const hasObservedHydratedValuesRef = useRef(false);
  const restoreInProgressRef = useRef(false);
  const saveIdleWaitersRef = useRef<Array<() => void>>([]);
  const persistenceStatusRef = useRef<PersistenceStatus>(persistenceStatus);
  const failedStoresRef = useRef<PersistedStoreName[]>(failedStores);
  const failureDetailsRef = useRef<PersistenceFailureDetail[]>(failureDetails);
  latestValuesRef.current = values;
  persistenceStatusRef.current = persistenceStatus;
  failedStoresRef.current = failedStores;
  failureDetailsRef.current = failureDetails;
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

  const updatePersistenceStatus = useCallback((status: PersistenceStatus) => {
    persistenceStatusRef.current = status;
    setPersistenceStatus(status);
  }, []);

  const updateFailedStores = useCallback((stores: PersistedStoreName[]) => {
    failedStoresRef.current = stores;
    setFailedStores(stores);
  }, []);

  const updateFailureDetails = useCallback(
    (details: PersistenceFailureDetail[]) => {
      failureDetailsRef.current = details;
      setFailureDetails(details);
    },
    [],
  );

  const resolveSaveIdleWaiters = useCallback(() => {
    const waiters = saveIdleWaitersRef.current.splice(0);
    waiters.forEach((resolve) => resolve());
  }, []);

  const waitForSaveIdle = useCallback((): Promise<void> => {
    if (!isSavingRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      saveIdleWaitersRef.current.push(resolve);
    });
  }, []);

  const drainSaveQueue = useCallback(async () => {
    if (isSavingRef.current || restoreInProgressRef.current) return;
    isSavingRef.current = true;
    try {
      while (saveRequestedRef.current && !restoreInProgressRef.current) {
        saveRequestedRef.current = false;
        const currentValues = latestValuesRef.current;
        const previousValues = previousSavedValuesRef.current;
        const saveTasks = createSaveTasks(previousValues, currentValues);

        if (saveTasks.length === 0) {
          updateFailedStores([]);
          updateFailureDetails([]);
          if (!saveRequestedRef.current) {
            updatePersistenceStatus("saved");
          }
          continue;
        }

        updatePersistenceStatus("saving");

        // ストアを1つずつ順番に保存する。並列実行すると、あるストアの保存失敗時の
        // DB接続リセットが実行中の他ストアのトランザクションを巻き添えでabortさせ、
        // 実際には保存できるデータでも失敗扱いになってしまうため。
        const failed: { label: PersistedStoreName; error: unknown }[] = [];
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
          nextSavedValues[failure.label] = previousValues[
            failure.label
          ] as never;
        }
        previousSavedValuesRef.current = nextSavedValues;

        if (failed.length > 0) {
          console.error("Failed to save data to IndexedDB:", failed);
          updateFailedStores(failed.map(({ label }) => label));
          updateFailureDetails(
            failed.map(({ label, error }) =>
              normalizePersistenceFailure(label, error),
            ),
          );
          if (!saveRequestedRef.current) {
            updatePersistenceStatus("failed");
          }
        } else {
          updateFailedStores([]);
          updateFailureDetails([]);
          if (!saveRequestedRef.current) {
            updatePersistenceStatus("saved");
          }
        }
      }
    } catch (error) {
      const pendingStores = createSaveTasks(
        previousSavedValuesRef.current,
        latestValuesRef.current,
      ).map(({ label }) => label);
      console.error("Failed to save data to IndexedDB:", error);
      updateFailedStores(pendingStores);
      updateFailureDetails(
        pendingStores.map((storeName) =>
          normalizePersistenceFailure(storeName, error),
        ),
      );
      updatePersistenceStatus("failed");
    } finally {
      isSavingRef.current = false;
      if (saveRequestedRef.current && !restoreInProgressRef.current) {
        void drainSaveQueue();
      } else {
        resolveSaveIdleWaiters();
      }
    }
  }, [
    resolveSaveIdleWaiters,
    updateFailedStores,
    updateFailureDetails,
    updatePersistenceStatus,
  ]);

  const retrySave = useCallback(() => {
    if (!isInitialized || restoreInProgressRef.current) return;
    saveRequestedRef.current = true;
    void drainSaveQueue();
  }, [drainSaveQueue, isInitialized]);

  const runExclusiveRestore = useCallback(
    async <T>(
      restoredValues: PersistedStateValues,
      restore: () => Promise<T>,
    ): Promise<T> => {
      if (!isInitialized) {
        throw new Error("保存データの初期化が完了していません。");
      }
      if (restoreInProgressRef.current) {
        throw new Error("別の復元処理が進行中です。");
      }

      const previousStatus = persistenceStatusRef.current;
      const previousFailedStores = [...failedStoresRef.current];
      const previousFailureDetails = [...failureDetailsRef.current];
      const hadPendingSave = saveRequestedRef.current;
      const wasSaving = isSavingRef.current;
      restoreInProgressRef.current = true;
      saveRequestedRef.current = false;
      updatePersistenceStatus("saving");

      await waitForSaveIdle();
      const settledStatus = wasSaving
        ? persistenceStatusRef.current
        : previousStatus;
      const settledFailedStores = wasSaving
        ? [...failedStoresRef.current]
        : previousFailedStores;
      const settledFailureDetails = wasSaving
        ? [...failureDetailsRef.current]
        : previousFailureDetails;
      updatePersistenceStatus("saving");

      let completed = false;
      try {
        const result = await restore();
        previousSavedValuesRef.current = restoredValues;
        latestValuesRef.current = restoredValues;
        saveRequestedRef.current = false;
        updateFailedStores([]);
        updateFailureDetails([]);
        updatePersistenceStatus("saved");
        completed = true;
        return result;
      } finally {
        restoreInProgressRef.current = false;
        if (!completed) {
          const requestedDuringRestore = saveRequestedRef.current;
          const hasPendingValues =
            createSaveTasks(
              previousSavedValuesRef.current,
              latestValuesRef.current,
            ).length > 0;
          updateFailedStores(settledFailedStores);
          updateFailureDetails(settledFailureDetails);
          updatePersistenceStatus(
            hasPendingValues && settledStatus !== "failed"
              ? "unsaved"
              : settledStatus,
          );
          if (hasPendingValues && (hadPendingSave || requestedDuringRestore)) {
            saveRequestedRef.current = true;
            void drainSaveQueue();
          }
        }
      }
    },
    [
      drainSaveQueue,
      isInitialized,
      updateFailedStores,
      updateFailureDetails,
      updatePersistenceStatus,
      waitForSaveIdle,
    ],
  );

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
    if (!isInitialized) return;

    // 初期復元による値の反映はユーザー編集ではないため保存対象にしない。
    // Reactは次の操作を処理する前にこのeffectを確定するため、その直後の編集は
    // 次の値変更として通常の保存キューへ入る。
    if (!hasObservedHydratedValuesRef.current) {
      hasObservedHydratedValuesRef.current = true;
      return;
    }

    saveRequestedRef.current = true;
    updatePersistenceStatus("unsaved");

    const timeoutId = setTimeout(() => {
      void drainSaveQueue();
    }, saveDelayMs);
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
    drainSaveQueue,
    updatePersistenceStatus,
  ]);

  useEffect(() => {
    if (!isInitialized || persistenceStatus === "saved") return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isInitialized, persistenceStatus]);

  return {
    isInitialized,
    persistenceStatus,
    failedStores,
    failureDetails,
    retrySave,
    runExclusiveRestore,
  } as const;
}
