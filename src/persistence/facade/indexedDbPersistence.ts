/**
 * IndexedDB persistence compatibility facade.
 *
 * Public names and observable Promise semantics remain stable while storage,
 * migration, atomic restore, and recovery live in dedicated modules.
 */

import type { AppData } from "../../app/ports/PersistenceCommandPort";
import type { MapDataStore } from "../../types/map";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import type { LoadResult } from "../contracts/persistence";
import { STORES, type StoreName } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import {
  commitApplicationSnapshotAtomically,
  restoreAppDataAtomically,
} from "../db/atomicRestoreTransaction";
import {
  removeEventFromApplicationSnapshot,
  renameEventInApplicationSnapshot,
} from "../repositories/applicationSnapshotOps";
import {
  migrateFromLocalStorage,
  runLegacyPersistenceSourceCleanup,
} from "../migration/legacyMigration";
import {
  getAllApplicationData as getAllData,
  getAllApplicationDataKeys as getAllKeys,
} from "../repositories/applicationDataRepository";
import { createEventRepository } from "../repositories/eventRepository";
import { loadMapData, saveMapData } from "../repositories/mapRepository";
import { applicationRecordOperations } from "../repositories/recordRepository";
import { createSettingsRepository } from "../repositories/settingsRepository";
import { createSyncQueueRepository } from "../repositories/syncQueueRepository";
import type { RecoveryCandidateAdoptionResult } from "../recovery/recoveryAdoption";
import { recoveryRepository } from "../recovery/recoveryRepository";

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
} from "../contracts/persistence";
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

const eventRepository = createEventRepository(applicationRecordOperations);
const settingsRepository = createSettingsRepository(
  applicationRecordOperations,
);
const syncQueueRepository = createSyncQueueRepository(
  applicationRecordOperations,
);

// 公開API
export const db = {
  STORES,

  async adoptRecoveryCandidate(
    candidate: StartupRecoveryCandidate,
  ): Promise<RecoveryCandidateAdoptionResult> {
    return recoveryRepository.adoptCandidate(candidate);
  },

  // イベントリスト
  async saveEventLists(data: Record<string, unknown[]>): Promise<void> {
    await eventRepository.saveEventLists(data);
  },
  async loadEventLists(): Promise<LoadResult<Record<string, unknown[]>>> {
    return eventRepository.loadEventLists();
  },

  // イベントメタデータ
  async saveEventMetadata(data: Record<string, unknown>): Promise<void> {
    await eventRepository.saveEventMetadata(data);
  },
  async loadEventMetadata(): Promise<LoadResult<Record<string, unknown>>> {
    return eventRepository.loadEventMetadata();
  },

  // 実行モードアイテム
  async saveExecuteModeItems(
    data: Record<string, Record<string, string[]>>,
  ): Promise<void> {
    await eventRepository.saveExecuteModeItems(data);
  },
  async loadExecuteModeItems(): Promise<
    LoadResult<Record<string, Record<string, string[]>>>
  > {
    return eventRepository.loadExecuteModeItems();
  },

  // 日モード
  async saveDayModes(
    data: Record<string, Record<string, string>>,
  ): Promise<void> {
    await eventRepository.saveDayModes(data);
  },
  async loadDayModes(): Promise<
    LoadResult<Record<string, Record<string, string>>>
  > {
    return eventRepository.loadDayModes();
  },

  // マップデータ
  async saveMapData(data: MapDataStore): Promise<void> {
    await saveMapData(data);
  },
  async saveMapDataChanges(
    _previousData: MapDataStore,
    nextData: MapDataStore,
  ): Promise<void> {
    await saveMapData(nextData);
  },
  async loadMapData(): Promise<LoadResult<MapDataStore>> {
    return loadMapData();
  },

  // マップ回転設定
  async saveMapRotationSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await settingsRepository.saveMapRotationSettings(data);
  },
  async loadMapRotationSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return settingsRepository.loadMapRotationSettings();
  },

  // ルート設定
  async saveRouteSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await settingsRepository.saveRouteSettings(data);
  },
  async loadRouteSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return settingsRepository.loadRouteSettings();
  },

  // ホール定義
  async saveHallDefinitions(
    data: Record<string, Record<string, unknown[]>>,
  ): Promise<void> {
    await settingsRepository.saveHallDefinitions(data);
  },
  async loadHallDefinitions(): Promise<
    LoadResult<Record<string, Record<string, unknown[]>>>
  > {
    return settingsRepository.loadHallDefinitions();
  },

  // ホールルート設定
  async saveHallRouteSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await settingsRepository.saveHallRouteSettings(data);
  },
  async loadHallRouteSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return settingsRepository.loadHallRouteSettings();
  },

  // マップビューポート設定
  async saveMapViewportSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await settingsRepository.saveMapViewportSettings(data);
  },
  async loadMapViewportSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return settingsRepository.loadMapViewportSettings();
  },

  // イベント削除時に関連データも削除
  async deleteEventData(eventName: string): Promise<void> {
    const snapshot = await db.getAllAppData();
    await db.deleteEventAtomically(snapshot, eventName);
  },

  async deleteEventAtomically(
    snapshot: AppData,
    eventName: string,
  ): Promise<void> {
    await commitApplicationSnapshotAtomically(
      removeEventFromApplicationSnapshot(snapshot, eventName),
    );
  },

  async renameEventAtomically(
    snapshot: AppData,
    oldEventName: string,
    newEventName: string,
  ): Promise<void> {
    await commitApplicationSnapshotAtomically(
      renameEventInApplicationSnapshot(snapshot, oldEventName, newEventName),
    );
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
  commitApplicationSnapshotAtomically,

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
