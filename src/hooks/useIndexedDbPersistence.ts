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
import {
  db,
  type LoadResult,
  type PersistenceCleanupStatus as DbPersistenceCleanupStatus,
} from "../utils/indexedDB";
import {
  createStartupRecoveryBundle,
  mergeStartupRecoveryBundles,
  startupRecoveryCandidatesHaveSameSelectionDescriptor,
  type StartupRecoveryBundle,
  type StartupRecoveryCandidate,
  type StartupRecoveryIssue,
} from "../utils/persistenceResilience";
import {
  bucketPersistenceStartupDuration,
  recordPersistenceReleaseAMetric,
} from "../utils/persistenceReleaseAMetrics";
import type { PersistenceCommandPort } from "../app/ports/PersistenceCommandPort";

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

export type LegacyCleanupStatus =
  | "checking"
  | Exclude<DbPersistenceCleanupStatus, "recovery-required">;

export type PersistenceFailureCategory =
  | "quota"
  | "permission"
  | "data-clone"
  | "conflict"
  | "database"
  | "unknown";

export type PersistenceFailureCode =
  | "storage-quota-exceeded"
  | "storage-permission-denied"
  | "storage-data-clone-failed"
  | "storage-conflict"
  | "indexeddb-operation-failed"
  | "persistence-operation-failed";

export interface PersistenceFailureDetail {
  storeName: PersistedStoreName;
  category: PersistenceFailureCategory;
  errorCode: PersistenceFailureCode;
  userMessage: string;
  technicalMessage: string | null;
}

export type PersistenceStartupState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
    }
  | {
      status: "recovery-required";
      message: string;
      details: string[];
      recoveryBundle: StartupRecoveryBundle | null;
      isRetrying: boolean;
    };

const DATABASE_ERROR_NAMES = new Set([
  "AbortError",
  "ConstraintError",
  "InvalidAccessError",
  "InvalidStateError",
  "IndexedDBOpenBlocked",
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
  conflict:
    "別のタブまたは退避データとの競合を検出しました。他のタブを閉じ、JSONバックアップを保存してから再試行してください。",
  database:
    "ブラウザーの保存領域に異常があります。ページを再読み込みして再試行し、改善しない場合はサイトデータを確認してください。",
  unknown:
    "保存中に予期しない問題が発生しました。再試行し、改善しない場合はJSONバックアップを保存してください。",
};

const FAILURE_ERROR_CODES: Record<
  PersistenceFailureCategory,
  PersistenceFailureCode
> = {
  quota: "storage-quota-exceeded",
  permission: "storage-permission-denied",
  "data-clone": "storage-data-clone-failed",
  conflict: "storage-conflict",
  database: "indexeddb-operation-failed",
  unknown: "persistence-operation-failed",
};

const createRecoveryBundle = (
  issues: StartupRecoveryIssue[],
  bundles: readonly (StartupRecoveryBundle | null | undefined)[] = [],
): StartupRecoveryBundle =>
  mergeStartupRecoveryBundles([
    createStartupRecoveryBundle({ issues }),
    ...bundles.filter(
      (bundle): bundle is StartupRecoveryBundle =>
        bundle !== null && bundle !== undefined,
    ),
  ]);

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

const sanitizeErrorCode = (value: string): string => {
  const safeCode = value
    .replace(/[\r\n\u2028\u2029\s]+/g, "")
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .slice(0, 64);
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
    errorNames.has("PersistenceConflict") ||
    classificationText.includes("persistence conflict")
  ) {
    category = "conflict";
  } else if (
    Array.from(errorNames).some((name) => DATABASE_ERROR_NAMES.has(name)) ||
    /\b(indexeddb|database|object store|transaction)\b/.test(classificationText)
  ) {
    category = "database";
  }

  return {
    storeName,
    category,
    errorCode: FAILURE_ERROR_CODES[category],
    userMessage: FAILURE_MESSAGES[category],
    // Raw browser messages can contain user-controlled object paths. Keep the
    // compatibility field, but never expose those messages to UI or logging.
    technicalMessage: null,
  };
};

const privacySafeFailureLog = ({
  storeName,
  category,
  errorCode,
}: PersistenceFailureDetail) => ({ storeName, category, errorCode });

type SaveTask = {
  label: PersistedStoreName;
  save: () => Promise<void>;
};

const createSaveTasks = (
  previousValues: PersistedStateValues,
  currentValues: PersistedStateValues,
  persistenceCommands: PersistenceCommandPort,
): SaveTask[] => {
  const saveTasks: SaveTask[] = [];
  if (previousValues.eventLists !== currentValues.eventLists) {
    saveTasks.push({
      label: "eventLists",
      save: () => persistenceCommands.saveEventLists(currentValues.eventLists),
    });
  }
  if (previousValues.eventMetadata !== currentValues.eventMetadata) {
    saveTasks.push({
      label: "eventMetadata",
      save: () =>
        persistenceCommands.saveEventMetadata(currentValues.eventMetadata),
    });
  }
  if (previousValues.executeModeItems !== currentValues.executeModeItems) {
    saveTasks.push({
      label: "executeModeItems",
      save: () =>
        persistenceCommands.saveExecuteModeItems(
          currentValues.executeModeItems,
        ),
    });
  }
  if (previousValues.dayModes !== currentValues.dayModes) {
    saveTasks.push({
      label: "dayModes",
      save: () => persistenceCommands.saveDayModes(currentValues.dayModes),
    });
  }
  if (previousValues.mapData !== currentValues.mapData) {
    saveTasks.push({
      label: "mapData",
      save: () =>
        persistenceCommands.saveMapDataChanges(
          previousValues.mapData,
          currentValues.mapData,
        ),
    });
  }
  if (
    previousValues.mapRotationSettings !== currentValues.mapRotationSettings
  ) {
    saveTasks.push({
      label: "mapRotationSettings",
      save: () =>
        persistenceCommands.saveMapRotationSettings(
          currentValues.mapRotationSettings,
        ),
    });
  }
  if (previousValues.routeSettings !== currentValues.routeSettings) {
    saveTasks.push({
      label: "routeSettings",
      save: () =>
        persistenceCommands.saveRouteSettings(currentValues.routeSettings),
    });
  }
  if (previousValues.hallDefinitions !== currentValues.hallDefinitions) {
    saveTasks.push({
      label: "hallDefinitions",
      save: () =>
        persistenceCommands.saveHallDefinitions(currentValues.hallDefinitions),
    });
  }
  if (previousValues.hallRouteSettings !== currentValues.hallRouteSettings) {
    saveTasks.push({
      label: "hallRouteSettings",
      save: () =>
        persistenceCommands.saveHallRouteSettings(
          currentValues.hallRouteSettings,
        ),
    });
  }
  if (
    previousValues.mapViewportSettings !== currentValues.mapViewportSettings
  ) {
    saveTasks.push({
      label: "mapViewportSettings",
      save: () =>
        persistenceCommands.saveMapViewportSettings(
          currentValues.mapViewportSettings,
        ),
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
  persistenceCommands: PersistenceCommandPort;
  saveDelayMs?: number;
};

export function useIndexedDbPersistence({
  values,
  setters,
  persistenceCommands,
  saveDelayMs = 500,
}: UseIndexedDbPersistenceParams) {
  const [startupState, setStartupState] = useState<PersistenceStartupState>({
    status: "loading",
  });
  const [persistenceStatus, setPersistenceStatus] =
    useState<PersistenceStatus>("saved");
  const [legacyCleanupStatus, setLegacyCleanupStatus] =
    useState<LegacyCleanupStatus>("checking");
  const [isAdoptingRecoveryCandidate, setIsAdoptingRecoveryCandidate] =
    useState(false);
  const [recoveryAdoptionError, setRecoveryAdoptionError] = useState<
    string | null
  >(null);
  const [failedStores, setFailedStores] = useState<PersistedStoreName[]>([]);
  const [failureDetails, setFailureDetails] = useState<
    PersistenceFailureDetail[]
  >([]);
  const isSavingRef = useRef(false);
  const saveRequestedRef = useRef(false);
  const latestValuesRef = useRef<PersistedStateValues>(values);
  const previousSavedValuesRef = useRef<PersistedStateValues>(values);
  const hasObservedHydratedValuesRef = useRef(false);
  const restoreInProgressRef = useRef(false);
  const recoveryAdoptionInProgressRef = useRef(false);
  const isMountedRef = useRef(false);
  const initializationPromiseRef = useRef<Promise<void> | null>(null);
  const saveIdleWaitersRef = useRef<Array<() => void>>([]);
  const persistenceStatusRef = useRef<PersistenceStatus>(persistenceStatus);
  const failedStoresRef = useRef<PersistedStoreName[]>(failedStores);
  const failureDetailsRef = useRef<PersistenceFailureDetail[]>(failureDetails);
  const isInitializedRef = useRef(false);
  latestValuesRef.current = values;
  persistenceStatusRef.current = persistenceStatus;
  failedStoresRef.current = failedStores;
  failureDetailsRef.current = failureDetails;
  const isInitialized = startupState.status === "ready";
  isInitializedRef.current = isInitialized;
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
        const saveTasks = createSaveTasks(
          previousValues,
          currentValues,
          persistenceCommands,
        );

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
          recordPersistenceReleaseAMetric({
            version: 1,
            name: "save",
            outcome: "failed",
          });
          const normalizedFailures = failed.map(({ label, error }) =>
            normalizePersistenceFailure(label, error),
          );
          console.error(
            "IndexedDB persistence save failed.",
            normalizedFailures.map(privacySafeFailureLog),
          );
          updateFailedStores(failed.map(({ label }) => label));
          updateFailureDetails(normalizedFailures);
          if (!saveRequestedRef.current) {
            updatePersistenceStatus("failed");
          }
        } else {
          recordPersistenceReleaseAMetric({
            version: 1,
            name: "save",
            outcome: "succeeded",
          });
          updateFailedStores([]);
          updateFailureDetails([]);
          if (!saveRequestedRef.current) {
            updatePersistenceStatus("saved");
          }
        }
      }
    } catch (error) {
      recordPersistenceReleaseAMetric({
        version: 1,
        name: "save",
        outcome: "failed",
      });
      const pendingStores = createSaveTasks(
        previousSavedValuesRef.current,
        latestValuesRef.current,
        persistenceCommands,
      ).map(({ label }) => label);
      const normalizedFailures = pendingStores.map((storeName) =>
        normalizePersistenceFailure(storeName, error),
      );
      console.error(
        "IndexedDB persistence save failed.",
        normalizedFailures.map(privacySafeFailureLog),
      );
      updateFailedStores(pendingStores);
      updateFailureDetails(normalizedFailures);
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
    persistenceCommands,
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

  const isUpdateBlocked = useCallback((): boolean => {
    if (
      !isInitializedRef.current ||
      restoreInProgressRef.current ||
      recoveryAdoptionInProgressRef.current ||
      isSavingRef.current ||
      saveRequestedRef.current ||
      persistenceStatusRef.current !== "saved"
    ) {
      return true;
    }

    return (
      createSaveTasks(
        previousSavedValuesRef.current,
        latestValuesRef.current,
        persistenceCommands,
      ).length > 0
    );
  }, [persistenceCommands]);

  const flushPendingSave = useCallback(async (): Promise<void> => {
    if (recoveryAdoptionInProgressRef.current) {
      throw new Error("復旧候補の採用中は保存を確定できません。");
    }
    if (!isInitializedRef.current) {
      throw new Error("保存データの初期化が完了していません。");
    }
    if (restoreInProgressRef.current) {
      throw new Error("復元処理の完了前に保存を確定できません。");
    }

    while (isUpdateBlocked()) {
      if (restoreInProgressRef.current) {
        throw new Error("復元処理の完了前に保存を確定できません。");
      }
      if (recoveryAdoptionInProgressRef.current) {
        throw new Error("復旧候補の採用中は保存を確定できません。");
      }

      // debounce待ちと実行中の保存のどちらでも、最新snapshotをもう一度queueへ載せる。
      // drainSaveQueueはsingle-flightなので、実行中ならこの要求を現在の保存後に処理する。
      saveRequestedRef.current = true;
      await drainSaveQueue();
      await waitForSaveIdle();

      if (restoreInProgressRef.current) {
        throw new Error("復元処理の完了前に保存を確定できません。");
      }
      if (recoveryAdoptionInProgressRef.current) {
        throw new Error("復旧候補の採用中は保存を確定できません。");
      }
      if (persistenceStatusRef.current === "failed") {
        throw new Error("保存を完了できませんでした。");
      }
    }
  }, [drainSaveQueue, isUpdateBlocked, waitForSaveIdle]);

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
              persistenceCommands,
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
      persistenceCommands,
      updateFailedStores,
      updateFailureDetails,
      updatePersistenceStatus,
      waitForSaveIdle,
    ],
  );

  const initializePersistence = useCallback(async (): Promise<void> => {
    const startupStartedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const recordStartupOutcome = (
      outcome: "ready" | "recovery-required",
    ): void => {
      const completedAt =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      recordPersistenceReleaseAMetric({
        version: 1,
        name: "startup",
        outcome,
        durationBucket: bucketPersistenceStartupDuration(
          Math.max(0, completedAt - startupStartedAt),
        ),
      });
    };

    try {
      const migrationResult =
        await persistenceCommands.migrateFromLocalStorage();
      const loadedSyncQueue = await db.loadSyncQueue();
      if (migrationResult.status === "recovery-required") {
        const syncQueueFailed =
          loadedSyncQueue.status === "error" ||
          loadedSyncQueue.status === "conflict";
        const recoveryBundle = syncQueueFailed
          ? createRecoveryBundle(
              [
                {
                  stage: "load",
                  code:
                    loadedSyncQueue.status === "conflict"
                      ? "PersistenceConflict"
                      : sanitizeErrorCode(
                          readErrorField(loadedSyncQueue.error, "name") ||
                            "LoadError",
                        ),
                  message:
                    loadedSyncQueue.status === "conflict"
                      ? "syncQueue に複数の保存候補があり、安全に選択できません。"
                      : "syncQueue の保存データを読み込めませんでした。",
                  storeName: "syncQueue",
                  key: "data",
                },
              ],
              [migrationResult.recoveryBundle, loadedSyncQueue.recoveryBundle],
            )
          : migrationResult.recoveryBundle;
        if (!isMountedRef.current) return;
        setStartupState({
          status: "recovery-required",
          message: "旧データを安全に移行できませんでした。",
          details: recoveryBundle?.issues.map((issue) => issue.message) ?? [
            "移行元データと保存済みデータの状態を確認できませんでした。",
          ],
          recoveryBundle,
          isRetrying: false,
        });
        recordStartupOutcome("recovery-required");
        return;
      }
      const nextLegacyCleanupStatus: LegacyCleanupStatus =
        migrationResult.cleanupStatus ??
        (migrationResult.status === "cleanup-pending"
          ? "deferred"
          : migrationResult.status === "completed"
            ? "completed"
            : "not-needed");

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

      const loadedStores = [
        ["eventLists", loadedEventLists],
        ["eventMetadata", loadedMetadata],
        ["executeModeItems", loadedExecuteItems],
        ["dayModes", loadedDayModes],
        ["mapData", loadedMapData],
        ["mapRotationSettings", loadedMapRotationSettings],
        ["routeSettings", loadedRouteSettings],
        ["hallDefinitions", loadedHallDefinitions],
        ["hallRouteSettings", loadedHallRouteSettings],
        ["mapViewportSettings", loadedMapViewportSettings],
        ["syncQueue", loadedSyncQueue],
      ] as const;

      const failedLoads = loadedStores.filter(
        ([, result]) =>
          result.status === "error" || result.status === "conflict",
      );
      if (failedLoads.length > 0) {
        const issues: StartupRecoveryIssue[] = failedLoads.map(
          ([storeName, result]) => ({
            stage: "load",
            code:
              result.status === "conflict"
                ? "PersistenceConflict"
                : sanitizeErrorCode(
                    readErrorField(result.error, "name") || "LoadError",
                  ),
            message:
              result.status === "conflict"
                ? `${storeName} に複数の保存候補があり、安全に選択できません。`
                : `${storeName} の保存データを読み込めませんでした。`,
            storeName,
            key: "data",
          }),
        );
        const bundles = failedLoads.map(([, result]) =>
          "recoveryBundle" in result
            ? (result.recoveryBundle as StartupRecoveryBundle)
            : null,
        );
        const recoveryBundle = createRecoveryBundle(issues, bundles);
        if (!isMountedRef.current) return;
        setStartupState({
          status: "recovery-required",
          message: "保存データを安全に読み込めませんでした。",
          details: recoveryBundle.issues.map((issue) => issue.message),
          recoveryBundle,
          isRetrying: false,
        });
        recordStartupOutcome("recovery-required");
        return;
      }

      const resolveLoadResult = <T extends Record<string, unknown>>(
        result: LoadResult<T>,
      ): T => (result.status === "ok" && result.data ? result.data : ({} as T));

      const resolvedEventLists = resolveLoadResult(loadedEventLists);
      const resolvedMetadata = resolveLoadResult(loadedMetadata);
      const resolvedExecuteItems = resolveLoadResult(loadedExecuteItems);
      const resolvedDayModes = resolveLoadResult(loadedDayModes);
      const resolvedMapData = resolveLoadResult(loadedMapData);
      const resolvedMapRotationSettings = resolveLoadResult(
        loadedMapRotationSettings,
      );
      const resolvedRouteSettings = resolveLoadResult(loadedRouteSettings);
      const resolvedHallDefinitions = resolveLoadResult(loadedHallDefinitions);
      const resolvedHallRouteSettings = resolveLoadResult(
        loadedHallRouteSettings,
      );
      const resolvedMapViewportSettings = resolveLoadResult(
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

      if (!isMountedRef.current) return;

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
        hallRouteSettings: resolvedHallRouteSettings as HallRouteSettingsStore,
        mapViewportSettings:
          resolvedMapViewportSettings as MapViewportSettingsStore,
      };

      // 画面を操作可能にする前に復元値を保存済み基準として確定する。
      // 初回の保存タイマーより先に変更されても、その変更を差分として保存できる。
      previousSavedValuesRef.current = hydratedValues;
      latestValuesRef.current = hydratedValues;
      hasObservedHydratedValuesRef.current = false;

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
      setLegacyCleanupStatus(nextLegacyCleanupStatus);
      setRecoveryAdoptionError(null);
      setStartupState({ status: "ready" });
      recordStartupOutcome("ready");
    } catch (error) {
      const initializationFailure = normalizePersistenceFailure(
        "eventLists",
        error,
      );
      console.error(
        "IndexedDB persistence initialization failed.",
        privacySafeFailureLog(initializationFailure),
      );
      if (!isMountedRef.current) return;
      const issue: StartupRecoveryIssue = {
        stage: "initialization",
        code: sanitizeErrorCode(
          readErrorField(error, "name") || "InitializationError",
        ),
        message:
          "保存データの初期化中にエラーが発生しました。通常画面には反映していません。",
      };
      const recoveryBundle = createRecoveryBundle([issue]);
      setStartupState({
        status: "recovery-required",
        message: "保存データを安全に読み込めませんでした。",
        details: [issue.message],
        recoveryBundle,
        isRetrying: false,
      });
      recordStartupOutcome("recovery-required");
    }
  }, [
    persistenceCommands,
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

  const startInitialization = useCallback((): Promise<void> => {
    if (initializationPromiseRef.current) {
      return initializationPromiseRef.current;
    }
    const pending = initializePersistence().finally(() => {
      if (initializationPromiseRef.current === pending) {
        initializationPromiseRef.current = null;
      }
    });
    initializationPromiseRef.current = pending;
    return pending;
  }, [initializePersistence]);

  const retryInitialization = useCallback((): void => {
    if (
      initializationPromiseRef.current ||
      recoveryAdoptionInProgressRef.current
    ) {
      return;
    }
    setRecoveryAdoptionError(null);
    setStartupState((current) =>
      current.status === "recovery-required"
        ? { ...current, isRetrying: true }
        : current,
    );
    startInitialization();
  }, [startInitialization]);

  const adoptRecoveryCandidate = useCallback(
    async (requestedCandidate: StartupRecoveryCandidate): Promise<void> => {
      if (
        recoveryAdoptionInProgressRef.current ||
        initializationPromiseRef.current ||
        startupState.status !== "recovery-required"
      ) {
        return;
      }
      const candidate: StartupRecoveryCandidate | undefined =
        startupState.recoveryBundle?.candidates.find(
          (currentCandidate) =>
            currentCandidate.adoptable === true &&
            startupRecoveryCandidatesHaveSameSelectionDescriptor(
              currentCandidate,
              requestedCandidate,
            ),
        );
      if (!candidate) {
        setRecoveryAdoptionError(
          "採用可能なapp payload候補を確認できませんでした。",
        );
        return;
      }

      recoveryAdoptionInProgressRef.current = true;
      setIsAdoptingRecoveryCandidate(true);
      setRecoveryAdoptionError(null);
      try {
        await persistenceCommands.adoptRecoveryCandidate(candidate);
        await startInitialization();
      } catch (error) {
        if (!isMountedRef.current) return;
        const errorName = sanitizeErrorCode(readErrorField(error, "name"));
        setRecoveryAdoptionError(
          errorName === "PersistenceConflict"
            ? "候補または保存領域が開始後に変更されたため、何も削除せず停止しました。再試行して最新の候補を確認してください。"
            : "候補を原子的に確定して読戻し検証できなかったため、何も削除せず停止しました。",
        );
      } finally {
        recoveryAdoptionInProgressRef.current = false;
        if (isMountedRef.current) {
          setIsAdoptingRecoveryCandidate(false);
        }
      }
    },
    [persistenceCommands, startInitialization, startupState],
  );

  useEffect(() => {
    isMountedRef.current = true;
    startInitialization();
    return () => {
      isMountedRef.current = false;
    };
  }, [startInitialization]);

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
    startupState,
    persistenceStatus,
    legacyCleanupStatus,
    isAdoptingRecoveryCandidate,
    recoveryAdoptionError,
    failedStores,
    failureDetails,
    retryInitialization,
    adoptRecoveryCandidate,
    retrySave,
    isUpdateBlocked,
    flushPendingSave,
    runExclusiveRestore,
  } as const;
}
