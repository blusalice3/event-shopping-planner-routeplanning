/**
 * IndexedDB persistence compatibility facade.
 *
 * Public names and observable Promise semantics remain stable while storage,
 * migration, atomic restore, and recovery live in dedicated modules.
 */

import type { AppData } from "../../app/ports/PersistenceCommandPort";
import type { MapDataStore } from "../../types/map";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import { STORES, type StoreName } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import { restoreAppDataAtomically } from "../db/atomicRestoreTransaction";
import {
  loadData,
  loadMapDataInternal,
  recordPersistenceLoadOutcome,
  saveData,
  writeMapData,
  type LoadResult,
} from "../internal/persistenceCore";
import {
  migrateFromLocalStorage,
  runLegacyPersistenceSourceCleanup,
} from "../migration/legacyMigration";
import {
  getAllApplicationData as getAllData,
  getAllApplicationDataKeys as getAllKeys,
} from "../repositories/applicationDataRepository";
import { createSyncQueueRepository } from "../repositories/syncQueueRepository";
import {
  adoptRecoveryCandidateInternal,
  type RecoveryCandidateAdoptionResult,
} from "../recovery/recoveryAdoption";

export type { StoreName } from "../db/constants";
export type { AppData } from "../../app/ports/PersistenceCommandPort";
export type {
  LoadResult,
  LoadStatus,
  PersistenceCleanupStatus,
  PersistenceDataMigrationStatus,
  PersistenceLegacyCleanupResult,
  PersistenceLegacyCleanupSafetyRequest,
  PersistenceLegacyCleanupTaskBlockedReason,
  PersistenceLegacyCleanupTaskDeferredReason,
  PersistenceMigrationCleanupDeferredReason,
  PersistenceMigrationResult,
  PersistenceMigrationStatus,
} from "../internal/persistenceCore";
export type { RecoveryCandidateAdoptionResult } from "../recovery/recoveryAdoption";

const resolveLoadResultData = <T extends Record<string, unknown>>(
  storeName: StoreName,
  result: LoadResult<T>,
): T => {
  if (result.status === "ok" && result.data) {
    return result.data;
  }

  if (result.status === "error" || result.status === "conflict") {
    console.error(`Failed to load ${storeName}.`);
    throw (
      result.error ??
      new PersistenceConflictError(`Failed to resolve ${storeName}.`)
    );
  }

  return {} as T;
};

const removeEventFromStore = async <T extends Record<string, unknown>>(
  eventName: string,
  storeName: StoreName,
  loader: () => Promise<LoadResult<T>>,
  saver: (data: T) => Promise<void>,
): Promise<void> => {
  const loadResult = await loader();
  if (loadResult.status === "error" || loadResult.status === "conflict") {
    console.error(`Failed to load ${storeName} during event deletion.`);
    throw (
      loadResult.error ??
      new PersistenceConflictError(
        `${storeName} could not be loaded during event deletion.`,
      )
    );
  }
  if (loadResult.status !== "ok" || !loadResult.data) {
    return;
  }

  if (!(eventName in loadResult.data)) {
    return;
  }

  const nextData = { ...loadResult.data };
  delete nextData[eventName];
  await saver(nextData as T);
};

const syncQueueRepository = createSyncQueueRepository<LoadResult<unknown[]>>({
  write: (storeName, key, data) => saveData(storeName, key, data),
  read: (storeName, key) => loadData<unknown[]>(storeName, key),
});

// 公開API
export const db = {
  STORES,

  async adoptRecoveryCandidate(
    candidate: StartupRecoveryCandidate,
  ): Promise<RecoveryCandidateAdoptionResult> {
    return adoptRecoveryCandidateInternal(candidate);
  },

  // イベントリスト
  async saveEventLists(data: Record<string, unknown[]>): Promise<void> {
    await saveData(STORES.EVENT_LISTS, "data", data);
  },
  async loadEventLists(): Promise<LoadResult<Record<string, unknown[]>>> {
    return loadData(STORES.EVENT_LISTS, "data");
  },

  // イベントメタデータ
  async saveEventMetadata(data: Record<string, unknown>): Promise<void> {
    await saveData(STORES.EVENT_METADATA, "data", data);
  },
  async loadEventMetadata(): Promise<LoadResult<Record<string, unknown>>> {
    return loadData(STORES.EVENT_METADATA, "data");
  },

  // 実行モードアイテム
  async saveExecuteModeItems(
    data: Record<string, Record<string, string[]>>,
  ): Promise<void> {
    await saveData(STORES.EXECUTE_MODE_ITEMS, "data", data);
  },
  async loadExecuteModeItems(): Promise<
    LoadResult<Record<string, Record<string, string[]>>>
  > {
    return loadData(STORES.EXECUTE_MODE_ITEMS, "data");
  },

  // 日モード
  async saveDayModes(
    data: Record<string, Record<string, string>>,
  ): Promise<void> {
    await saveData(STORES.DAY_MODES, "data", data);
  },
  async loadDayModes(): Promise<
    LoadResult<Record<string, Record<string, string>>>
  > {
    return loadData(STORES.DAY_MODES, "data");
  },

  // マップデータ
  async saveMapData(data: MapDataStore): Promise<void> {
    await writeMapData(data);
  },
  async saveMapDataChanges(
    _previousData: MapDataStore,
    nextData: MapDataStore,
  ): Promise<void> {
    await writeMapData(nextData);
  },
  async loadMapData(): Promise<LoadResult<MapDataStore>> {
    return recordPersistenceLoadOutcome(await loadMapDataInternal());
  },

  // マップ回転設定
  async saveMapRotationSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.MAP_ROTATION_SETTINGS, "data", data);
  },
  async loadMapRotationSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.MAP_ROTATION_SETTINGS, "data");
  },

  // ルート設定
  async saveRouteSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.ROUTE_SETTINGS, "data", data);
  },
  async loadRouteSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.ROUTE_SETTINGS, "data");
  },

  // ホール定義
  async saveHallDefinitions(
    data: Record<string, Record<string, unknown[]>>,
  ): Promise<void> {
    await saveData(STORES.HALL_DEFINITIONS, "data", data);
  },
  async loadHallDefinitions(): Promise<
    LoadResult<Record<string, Record<string, unknown[]>>>
  > {
    return loadData(STORES.HALL_DEFINITIONS, "data");
  },

  // ホールルート設定
  async saveHallRouteSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.HALL_ROUTE_SETTINGS, "data", data);
  },
  async loadHallRouteSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.HALL_ROUTE_SETTINGS, "data");
  },

  // マップビューポート設定
  async saveMapViewportSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.MAP_VIEWPORT_SETTINGS, "data", data);
  },
  async loadMapViewportSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.MAP_VIEWPORT_SETTINGS, "data");
  },

  // イベント削除時に関連データも削除
  async deleteEventData(eventName: string): Promise<void> {
    try {
      await removeEventFromStore(
        eventName,
        STORES.EVENT_LISTS,
        db.loadEventLists,
        db.saveEventLists,
      );
      await removeEventFromStore(
        eventName,
        STORES.EVENT_METADATA,
        db.loadEventMetadata,
        db.saveEventMetadata,
      );
      await removeEventFromStore(
        eventName,
        STORES.EXECUTE_MODE_ITEMS,
        db.loadExecuteModeItems,
        db.saveExecuteModeItems,
      );
      await removeEventFromStore(
        eventName,
        STORES.DAY_MODES,
        db.loadDayModes,
        db.saveDayModes,
      );
      await removeEventFromStore(
        eventName,
        STORES.MAP_DATA,
        db.loadMapData,
        db.saveMapData,
      );
      await removeEventFromStore(
        eventName,
        STORES.MAP_ROTATION_SETTINGS,
        db.loadMapRotationSettings,
        db.saveMapRotationSettings,
      );
      await removeEventFromStore(
        eventName,
        STORES.ROUTE_SETTINGS,
        db.loadRouteSettings,
        db.saveRouteSettings,
      );
      await removeEventFromStore(
        eventName,
        STORES.HALL_DEFINITIONS,
        db.loadHallDefinitions,
        db.saveHallDefinitions,
      );
      await removeEventFromStore(
        eventName,
        STORES.HALL_ROUTE_SETTINGS,
        db.loadHallRouteSettings,
        db.saveHallRouteSettings,
      );
      await removeEventFromStore(
        eventName,
        STORES.MAP_VIEWPORT_SETTINGS,
        db.loadMapViewportSettings,
        db.saveMapViewportSettings,
      );
    } catch {
      console.error("Failed to delete event data from IndexedDB.");
    }
  },

  // 全データを取得（エクスポート用）
  async getAllAppData(): Promise<AppData> {
    const [
      eventListsResult,
      eventMetadataResult,
      executeModeItemsResult,
      dayModesResult,
      mapDataResult,
      mapRotationSettingsResult,
      routeSettingsResult,
      hallDefinitionsResult,
      hallRouteSettingsResult,
      mapViewportSettingsResult,
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

    return {
      eventLists: resolveLoadResultData(STORES.EVENT_LISTS, eventListsResult),
      eventMetadata: resolveLoadResultData(
        STORES.EVENT_METADATA,
        eventMetadataResult,
      ),
      executeModeItems: resolveLoadResultData(
        STORES.EXECUTE_MODE_ITEMS,
        executeModeItemsResult,
      ),
      dayModes: resolveLoadResultData(STORES.DAY_MODES, dayModesResult),
      mapData: resolveLoadResultData(STORES.MAP_DATA, mapDataResult),
      mapRotationSettings: resolveLoadResultData(
        STORES.MAP_ROTATION_SETTINGS,
        mapRotationSettingsResult,
      ),
      routeSettings: resolveLoadResultData(
        STORES.ROUTE_SETTINGS,
        routeSettingsResult,
      ),
      hallDefinitions: resolveLoadResultData(
        STORES.HALL_DEFINITIONS,
        hallDefinitionsResult,
      ),
      hallRouteSettings: resolveLoadResultData(
        STORES.HALL_ROUTE_SETTINGS,
        hallRouteSettingsResult,
      ),
      mapViewportSettings: resolveLoadResultData(
        STORES.MAP_VIEWPORT_SETTINGS,
        mapViewportSettingsResult,
      ),
    };
  },

  // バックアップから全アプリデータを単一トランザクションで復元
  restoreAppDataAtomically,

  // 同期キュー（共有機能用）
  async saveSyncQueue(data: unknown[]): Promise<void> {
    await syncQueueRepository.savePayload(data);
  },
  async loadSyncQueue(): Promise<LoadResult<unknown[]>> {
    return syncQueueRepository.loadPayload();
  },

  // localStorageからの移行
  migrateFromLocalStorage,

  // Release B: 検証済み旧localStorage原本の条件付き物理cleanup
  cleanupLegacyPersistenceSources: runLegacyPersistenceSourceCleanup,

  // ユーティリティ
  getAllKeys,
  getAllData,
};

export default db;
