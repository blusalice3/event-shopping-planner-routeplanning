/**
 * IndexedDB ユーティリティ
 * localStorageの代わりに大容量データを保存するためのラッパー
 */

import type { AssignmentMemberProfile } from '../types/item';

type SharingFieldClocks = Record<string, { itemsVersion: number; updatedAt: string }>;

type SharingDeletedItemClockMetadata = {
  deletedAt: string;
  deletedBy: string | null;
  fieldClocks: SharingFieldClocks;
  itemVersion: number;
  updatedAt: string;
};

export type SharingPendingRouteOrderAckSource = 'mutation' | 'reorder' | 'sync';

export type SharingPendingRouteOrderAckMetadata = {
  version: number;
  source: SharingPendingRouteOrderAckSource;
  retryCount: number;
  lastTriedAt?: string;
  updatedAt: string;
};

const DB_NAME = 'EventShoppingPlannerDB';
const DB_VERSION = 5;

// ストア名
const STORES = {
  EVENT_LISTS: 'eventLists',
  EVENT_METADATA: 'eventMetadata',
  EXECUTE_MODE_ITEMS: 'executeModeItems',
  DAY_MODES: 'dayModes',
  MAP_DATA: 'mapData',
  MAP_ROTATION_SETTINGS: 'mapRotationSettings',
  ROUTE_SETTINGS: 'routeSettings',
  HALL_DEFINITIONS: 'hallDefinitions',
  HALL_ROUTE_SETTINGS: 'hallRouteSettings',
  MAP_VIEWPORT_SETTINGS: 'mapViewportSettings',
  SYNC_QUEUE: 'syncQueue',
  SHARING_SESSIONS: 'sharingSessions',
  SHARING_SNAPSHOT_STAGING: 'sharingSnapshotStaging',
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

export type LoadStatus = 'ok' | 'missing' | 'error';

export type LoadResult<T> = {
  status: LoadStatus;
  data: T | null;
  error?: unknown;
};

let dbInstance: IDBDatabase | null = null;

/**
 * データベースを開く
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('IndexedDB open error:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // 各ストアを作成
      Object.values(STORES).forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      });
    };
  });
}

/**
 * データを保存
 */
async function saveData<T>(storeName: StoreName, key: string, data: T): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(data, key);

    request.onerror = () => {
      console.error(`Failed to save to ${storeName}:`, request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve();
    };
  });
}

/**
 * データを読み込み
 */
async function loadData<T>(storeName: StoreName, key: string): Promise<LoadResult<T>> {
  try {
    const db = await openDB();

    return await new Promise((resolve) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => {
        console.error(`Failed to load from ${storeName}:`, request.error);
        resolve({
          status: 'error',
          data: null,
          error: request.error,
        });
      };

      request.onsuccess = () => {
        if (request.result === undefined || request.result === null) {
          resolve({
            status: 'missing',
            data: null,
          });
          return;
        }

        resolve({
          status: 'ok',
          data: request.result as T,
        });
      };
    });
  } catch (error) {
    console.error(`Failed to load from ${storeName}:`, error);
    return {
      status: 'error',
      data: null,
      error,
    };
  }
}

/**
 * データを削除
 */
async function deleteData(storeName: StoreName, key: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onerror = () => {
      console.error(`Failed to delete from ${storeName}:`, request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve();
    };
  });
}

// deleteDataは将来使用する可能性があるため維持
void deleteData;

/**
 * ストア内の全キーを取得
 */
async function getAllKeys(storeName: StoreName): Promise<string[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAllKeys();

    request.onerror = () => {
      console.error(`Failed to get keys from ${storeName}:`, request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result as string[]);
    };
  });
}

/**
 * ストア内の全データを取得
 */
async function getAllData<T>(storeName: StoreName): Promise<Record<string, T>> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const result: Record<string, T> = {};

    const cursorRequest = store.openCursor();

    cursorRequest.onerror = () => {
      console.error(`Failed to get all data from ${storeName}:`, cursorRequest.error);
      reject(cursorRequest.error);
    };

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        result[cursor.key as string] = cursor.value;
        cursor.continue();
      } else {
        resolve(result);
      }
    };
  });
}

/**
 * localStorageからIndexedDBへの移行
 */
async function migrateFromLocalStorage(): Promise<boolean> {
  try {
    // localStorageにデータがあるか確認
    const storedLists = localStorage.getItem('eventShoppingLists');
    if (!storedLists) {
      return false; // 移行するデータがない
    }

    console.log('Migrating data from localStorage to IndexedDB...');

    // 各データを移行
    const migrations = [
      { key: 'eventShoppingLists', store: STORES.EVENT_LISTS },
      { key: 'eventMetadata', store: STORES.EVENT_METADATA },
      { key: 'executeModeItems', store: STORES.EXECUTE_MODE_ITEMS },
      { key: 'dayModes', store: STORES.DAY_MODES },
      { key: 'mapData', store: STORES.MAP_DATA },
      { key: 'mapRotationSettings', store: STORES.MAP_ROTATION_SETTINGS },
      { key: 'routeSettings', store: STORES.ROUTE_SETTINGS },
      { key: 'hallDefinitions', store: STORES.HALL_DEFINITIONS },
      { key: 'hallRouteSettings', store: STORES.HALL_ROUTE_SETTINGS },
    ];

    for (const { key, store } of migrations) {
      const data = localStorage.getItem(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          await saveData(store, 'data', parsed);
          console.log(`Migrated ${key} to IndexedDB`);
        } catch (e) {
          console.error(`Failed to migrate ${key}:`, e);
        }
      }
    }

    // 移行完了後、localStorageをクリア
    migrations.forEach(({ key }) => {
      localStorage.removeItem(key);
    });

    console.log('Migration complete');
    return true;
  } catch (error) {
    console.error('Migration failed:', error);
    return false;
  }
}

// エクスポート用の型定義
export interface AppData {
  eventLists: Record<string, unknown[]>;
  eventMetadata: Record<string, unknown>;
  executeModeItems: Record<string, Record<string, string[]>>;
  dayModes: Record<string, Record<string, string>>;
  mapData: Record<string, Record<string, unknown>>;
  mapRotationSettings: Record<string, Record<string, unknown>>;
  routeSettings: Record<string, Record<string, unknown>>;
  hallDefinitions: Record<string, Record<string, unknown[]>>;
  hallRouteSettings: Record<string, Record<string, unknown>>;
  mapViewportSettings: Record<string, Record<string, unknown>>;
}

export interface SharingSessionMetadata {
  sessionId: string;
  roomId: string;
  roomCode?: string;
  roomMemberId: string;
  contractVersion?: number;
  metadataSchemaVersion?: number;
  eventName: string;
  role: 'host' | 'member';
  status: 'active' | 'paused' | 'expired' | 'leaving' | 'localizing';
  startedAt: string;
  expiresAt: string;
  itemsVersion: number;
  routeOrderVersions: Record<string, number>;
  fieldClocksByItemId?: Record<
    string,
    Record<string, { itemsVersion: number; updatedAt: string }>
  >;
  deletedItemClocks?: Record<string, SharingDeletedItemClockMetadata>;
  pendingItemSyncAck?: {
    fromItemsVersion: number;
    targetItemsVersion: number;
    affectedLocalItemIds?: string[];
    retryCount?: number;
    lastTriedAt?: string;
    updatedAt: string;
  };
  pendingRouteOrderAcks?: Record<string, SharingPendingRouteOrderAckMetadata>;
  lastSnapshotReceiptId?: string;
  lastAckAt?: string;
  lastProcessedEventCreatedAt?: string | null;
  lastProcessedEventId?: string | null;
  memberProfileSnapshot?: AssignmentMemberProfile[];
}

export interface SharingSnapshotCommitInput {
  appData: AppData;
  session: SharingSessionMetadata;
  staging: {
    snapshotReceiptId: string;
    roomId: string;
    roomMemberId: string;
    receivedAt: string;
    payload: unknown;
  };
}

export interface SharingLocalizeCommitInput {
  eventLists: Record<string, unknown[]>;
  session: SharingSessionMetadata;
}

const resolveLoadResultData = <T extends Record<string, unknown>>(
  storeName: StoreName,
  result: LoadResult<T>,
): T => {
  if (result.status === 'ok' && result.data) {
    return result.data;
  }

  if (result.status === 'error') {
    console.error(`Failed to load ${storeName}:`, result.error);
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
  if (loadResult.status === 'error') {
    console.error(`Failed to load ${storeName} during event deletion:`, loadResult.error);
    return;
  }
  if (loadResult.status !== 'ok' || !loadResult.data) {
    return;
  }

  if (!(eventName in loadResult.data)) {
    return;
  }

  const nextData = { ...loadResult.data };
  delete nextData[eventName];
  await saver(nextData as T);
};

// 公開API
export const db = {
  STORES,

  // イベントリスト
  async saveEventLists(data: Record<string, unknown[]>): Promise<void> {
    await saveData(STORES.EVENT_LISTS, 'data', data);
  },
  async loadEventLists(): Promise<LoadResult<Record<string, unknown[]>>> {
    return loadData(STORES.EVENT_LISTS, 'data');
  },

  // イベントメタデータ
  async saveEventMetadata(data: Record<string, unknown>): Promise<void> {
    await saveData(STORES.EVENT_METADATA, 'data', data);
  },
  async loadEventMetadata(): Promise<LoadResult<Record<string, unknown>>> {
    return loadData(STORES.EVENT_METADATA, 'data');
  },

  // 実行モードアイテム
  async saveExecuteModeItems(data: Record<string, Record<string, string[]>>): Promise<void> {
    await saveData(STORES.EXECUTE_MODE_ITEMS, 'data', data);
  },
  async loadExecuteModeItems(): Promise<LoadResult<Record<string, Record<string, string[]>>>> {
    return loadData(STORES.EXECUTE_MODE_ITEMS, 'data');
  },

  // 日モード
  async saveDayModes(data: Record<string, Record<string, string>>): Promise<void> {
    await saveData(STORES.DAY_MODES, 'data', data);
  },
  async loadDayModes(): Promise<LoadResult<Record<string, Record<string, string>>>> {
    return loadData(STORES.DAY_MODES, 'data');
  },

  // マップデータ
  async saveMapData(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.MAP_DATA, 'data', data);
  },
  async loadMapData(): Promise<LoadResult<Record<string, Record<string, unknown>>>> {
    return loadData(STORES.MAP_DATA, 'data');
  },

  // マップ回転設定
  async saveMapRotationSettings(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.MAP_ROTATION_SETTINGS, 'data', data);
  },
  async loadMapRotationSettings(): Promise<LoadResult<Record<string, Record<string, unknown>>>> {
    return loadData(STORES.MAP_ROTATION_SETTINGS, 'data');
  },

  // ルート設定
  async saveRouteSettings(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.ROUTE_SETTINGS, 'data', data);
  },
  async loadRouteSettings(): Promise<LoadResult<Record<string, Record<string, unknown>>>> {
    return loadData(STORES.ROUTE_SETTINGS, 'data');
  },

  // ホール定義
  async saveHallDefinitions(data: Record<string, Record<string, unknown[]>>): Promise<void> {
    await saveData(STORES.HALL_DEFINITIONS, 'data', data);
  },
  async loadHallDefinitions(): Promise<LoadResult<Record<string, Record<string, unknown[]>>>> {
    return loadData(STORES.HALL_DEFINITIONS, 'data');
  },

  // ホールルート設定
  async saveHallRouteSettings(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.HALL_ROUTE_SETTINGS, 'data', data);
  },
  async loadHallRouteSettings(): Promise<LoadResult<Record<string, Record<string, unknown>>>> {
    return loadData(STORES.HALL_ROUTE_SETTINGS, 'data');
  },

  // マップビューポート設定
  async saveMapViewportSettings(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.MAP_VIEWPORT_SETTINGS, 'data', data);
  },
  async loadMapViewportSettings(): Promise<LoadResult<Record<string, Record<string, unknown>>>> {
    return loadData(STORES.MAP_VIEWPORT_SETTINGS, 'data');
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
      await removeEventFromStore(eventName, STORES.DAY_MODES, db.loadDayModes, db.saveDayModes);
      await removeEventFromStore(eventName, STORES.MAP_DATA, db.loadMapData, db.saveMapData);
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
    } catch (error) {
      console.error(`Failed to delete ${eventName} from IndexedDB:`, error);
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
      eventMetadata: resolveLoadResultData(STORES.EVENT_METADATA, eventMetadataResult),
      executeModeItems: resolveLoadResultData(STORES.EXECUTE_MODE_ITEMS, executeModeItemsResult),
      dayModes: resolveLoadResultData(STORES.DAY_MODES, dayModesResult),
      mapData: resolveLoadResultData(STORES.MAP_DATA, mapDataResult),
      mapRotationSettings: resolveLoadResultData(
        STORES.MAP_ROTATION_SETTINGS,
        mapRotationSettingsResult,
      ),
      routeSettings: resolveLoadResultData(STORES.ROUTE_SETTINGS, routeSettingsResult),
      hallDefinitions: resolveLoadResultData(STORES.HALL_DEFINITIONS, hallDefinitionsResult),
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

  // 同期キュー（共有機能用）
  async saveSyncQueue(data: unknown[]): Promise<void> {
    await saveData(STORES.SYNC_QUEUE, 'data', data);
  },
  async loadSyncQueue(): Promise<LoadResult<unknown[]>> {
    return loadData(STORES.SYNC_QUEUE, 'data');
  },

  async saveSharingSession(session: SharingSessionMetadata): Promise<void> {
    await saveData(STORES.SHARING_SESSIONS, session.sessionId, session);
  },
  async loadSharingSession(sessionId: string): Promise<LoadResult<SharingSessionMetadata>> {
    return loadData(STORES.SHARING_SESSIONS, sessionId);
  },
  async deleteSharingSession(sessionId: string): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORES.SHARING_SESSIONS, 'readwrite');
      const store = transaction.objectStore(STORES.SHARING_SESSIONS);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB sharing session deletion failed.'));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('IndexedDB sharing session deletion aborted.'));
      };

      store.delete(sessionId);
    });
  },

  async commitSharingSnapshot(input: SharingSnapshotCommitInput): Promise<void> {
    const database = await openDB();
    const storeNames = [
      STORES.EVENT_LISTS,
      STORES.EVENT_METADATA,
      STORES.EXECUTE_MODE_ITEMS,
      STORES.DAY_MODES,
      STORES.MAP_DATA,
      STORES.MAP_ROTATION_SETTINGS,
      STORES.ROUTE_SETTINGS,
      STORES.HALL_DEFINITIONS,
      STORES.HALL_ROUTE_SETTINGS,
      STORES.MAP_VIEWPORT_SETTINGS,
      STORES.SHARING_SESSIONS,
      STORES.SHARING_SNAPSHOT_STAGING,
    ];

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeNames, 'readwrite');
      const rejectWithTransactionError = () => {
        reject(transaction.error ?? new Error('IndexedDB sharing snapshot transaction failed.'));
      };

      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = rejectWithTransactionError;
      transaction.onabort = rejectWithTransactionError;

      transaction.objectStore(STORES.SHARING_SNAPSHOT_STAGING).put(
        input.staging,
        input.staging.snapshotReceiptId,
      );
      transaction.objectStore(STORES.EVENT_LISTS).put(input.appData.eventLists, 'data');
      transaction.objectStore(STORES.EVENT_METADATA).put(input.appData.eventMetadata, 'data');
      transaction
        .objectStore(STORES.EXECUTE_MODE_ITEMS)
        .put(input.appData.executeModeItems, 'data');
      transaction.objectStore(STORES.DAY_MODES).put(input.appData.dayModes, 'data');
      transaction.objectStore(STORES.MAP_DATA).put(input.appData.mapData, 'data');
      transaction
        .objectStore(STORES.MAP_ROTATION_SETTINGS)
        .put(input.appData.mapRotationSettings, 'data');
      transaction.objectStore(STORES.ROUTE_SETTINGS).put(input.appData.routeSettings, 'data');
      transaction
        .objectStore(STORES.HALL_DEFINITIONS)
        .put(input.appData.hallDefinitions, 'data');
      transaction
        .objectStore(STORES.HALL_ROUTE_SETTINGS)
        .put(input.appData.hallRouteSettings, 'data');
      transaction
        .objectStore(STORES.MAP_VIEWPORT_SETTINGS)
        .put(input.appData.mapViewportSettings, 'data');
      transaction.objectStore(STORES.SHARING_SESSIONS).put(input.session, input.session.sessionId);
    });
  },

  async commitSharingLocalize(input: SharingLocalizeCommitInput): Promise<void> {
    const database = await openDB();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [STORES.EVENT_LISTS, STORES.SHARING_SESSIONS],
        'readwrite',
      );
      const rejectWithTransactionError = () => {
        reject(transaction.error ?? new Error('IndexedDB sharing localize transaction failed.'));
      };

      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = rejectWithTransactionError;
      transaction.onabort = rejectWithTransactionError;

      transaction.objectStore(STORES.EVENT_LISTS).put(input.eventLists, 'data');
      transaction.objectStore(STORES.SHARING_SESSIONS).put(input.session, input.session.sessionId);
    });
  },

  // localStorageからの移行
  migrateFromLocalStorage,

  // ユーティリティ
  getAllKeys,
  getAllData,
};

export default db;
