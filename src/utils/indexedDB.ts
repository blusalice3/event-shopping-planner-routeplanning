/**
 * IndexedDB ユーティリティ
 * localStorageの代わりに大容量データを保存するためのラッパー
 */

const DB_NAME = 'EventShoppingPlannerDB';
const DB_VERSION = 1;

// ストア名
const STORES = {
  EVENT_LISTS: 'eventLists',
  EVENT_METADATA: 'eventMetadata',
  EXECUTE_MODE_ITEMS: 'executeModeItems',
  DAY_MODES: 'dayModes',
  MAP_DATA: 'mapData',
  ROUTE_SETTINGS: 'routeSettings',
  HALL_DEFINITIONS: 'hallDefinitions',
  HALL_ROUTE_SETTINGS: 'hallRouteSettings',
} as const;

type StoreName = typeof STORES[keyof typeof STORES];

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
      Object.values(STORES).forEach(storeName => {
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
async function loadData<T>(storeName: StoreName, key: string): Promise<T | null> {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onerror = () => {
      console.error(`Failed to load from ${storeName}:`, request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result ?? null);
    };
  });
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
  routeSettings: Record<string, Record<string, unknown>>;
  hallDefinitions: Record<string, Record<string, unknown[]>>;
  hallRouteSettings: Record<string, Record<string, unknown>>;
}

// 公開API
export const db = {
  STORES,
  
  // イベントリスト
  async saveEventLists(data: Record<string, unknown[]>): Promise<void> {
    await saveData(STORES.EVENT_LISTS, 'data', data);
  },
  async loadEventLists(): Promise<Record<string, unknown[]>> {
    return (await loadData(STORES.EVENT_LISTS, 'data')) || {};
  },
  
  // イベントメタデータ
  async saveEventMetadata(data: Record<string, unknown>): Promise<void> {
    await saveData(STORES.EVENT_METADATA, 'data', data);
  },
  async loadEventMetadata(): Promise<Record<string, unknown>> {
    return (await loadData(STORES.EVENT_METADATA, 'data')) || {};
  },
  
  // 実行モードアイテム
  async saveExecuteModeItems(data: Record<string, Record<string, string[]>>): Promise<void> {
    await saveData(STORES.EXECUTE_MODE_ITEMS, 'data', data);
  },
  async loadExecuteModeItems(): Promise<Record<string, Record<string, string[]>>> {
    return (await loadData(STORES.EXECUTE_MODE_ITEMS, 'data')) || {};
  },
  
  // 日モード
  async saveDayModes(data: Record<string, Record<string, string>>): Promise<void> {
    await saveData(STORES.DAY_MODES, 'data', data);
  },
  async loadDayModes(): Promise<Record<string, Record<string, string>>> {
    return (await loadData(STORES.DAY_MODES, 'data')) || {};
  },
  
  // マップデータ
  async saveMapData(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.MAP_DATA, 'data', data);
  },
  async loadMapData(): Promise<Record<string, Record<string, unknown>>> {
    return (await loadData(STORES.MAP_DATA, 'data')) || {};
  },
  
  // ルート設定
  async saveRouteSettings(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.ROUTE_SETTINGS, 'data', data);
  },
  async loadRouteSettings(): Promise<Record<string, Record<string, unknown>>> {
    return (await loadData(STORES.ROUTE_SETTINGS, 'data')) || {};
  },
  
  // ホール定義
  async saveHallDefinitions(data: Record<string, Record<string, unknown[]>>): Promise<void> {
    await saveData(STORES.HALL_DEFINITIONS, 'data', data);
  },
  async loadHallDefinitions(): Promise<Record<string, Record<string, unknown[]>>> {
    return (await loadData(STORES.HALL_DEFINITIONS, 'data')) || {};
  },
  
  // ホールルート設定
  async saveHallRouteSettings(data: Record<string, Record<string, unknown>>): Promise<void> {
    await saveData(STORES.HALL_ROUTE_SETTINGS, 'data', data);
  },
  async loadHallRouteSettings(): Promise<Record<string, Record<string, unknown>>> {
    return (await loadData(STORES.HALL_ROUTE_SETTINGS, 'data')) || {};
  },

  // イベント削除時に関連データも削除
  async deleteEventData(eventName: string): Promise<void> {
    const stores = [
      { store: STORES.EVENT_LISTS, loader: db.loadEventLists, saver: db.saveEventLists },
      { store: STORES.EVENT_METADATA, loader: db.loadEventMetadata, saver: db.saveEventMetadata },
      { store: STORES.EXECUTE_MODE_ITEMS, loader: db.loadExecuteModeItems, saver: db.saveExecuteModeItems },
      { store: STORES.DAY_MODES, loader: db.loadDayModes, saver: db.saveDayModes },
      { store: STORES.MAP_DATA, loader: db.loadMapData, saver: db.saveMapData },
      { store: STORES.ROUTE_SETTINGS, loader: db.loadRouteSettings, saver: db.saveRouteSettings },
      { store: STORES.HALL_DEFINITIONS, loader: db.loadHallDefinitions, saver: db.saveHallDefinitions },
      { store: STORES.HALL_ROUTE_SETTINGS, loader: db.loadHallRouteSettings, saver: db.saveHallRouteSettings },
    ];

    for (const { loader, saver } of stores) {
      try {
        const data = await loader();
        if (data && eventName in data) {
          delete (data as Record<string, unknown>)[eventName];
          await saver(data as never);
        }
      } catch (e) {
        console.error(`Failed to delete ${eventName} from store:`, e);
      }
    }
  },
  
  // 全データを取得（エクスポート用）
  async getAllAppData(): Promise<AppData> {
    return {
      eventLists: await db.loadEventLists(),
      eventMetadata: await db.loadEventMetadata(),
      executeModeItems: await db.loadExecuteModeItems(),
      dayModes: await db.loadDayModes(),
      mapData: await db.loadMapData(),
      routeSettings: await db.loadRouteSettings(),
      hallDefinitions: await db.loadHallDefinitions(),
      hallRouteSettings: await db.loadHallRouteSettings(),
    };
  },
  
  // localStorageからの移行
  migrateFromLocalStorage,
  
  // ユーティリティ
  getAllKeys,
  getAllData,
};

export default db;
