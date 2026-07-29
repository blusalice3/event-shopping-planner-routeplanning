/**
 * IndexedDB ユーティリティ
 * localStorageの代わりに大容量データを保存するためのラッパー
 */

import type { MapDataStore } from "../types/map";
import {
  compactDayMapForStorage,
  compactMapDataForStorage,
  expandDayMapFromStorage,
  expandMapDataFromStorage,
} from "./mapDataPersistence";

const DB_NAME = "EventShoppingPlannerDB";
const DB_VERSION = 5;
const MAP_DATA_LEGACY_KEY = "data";
const MAP_DATA_KEY_PREFIX = "mapData:";

// ストア名
const STORES = {
  EVENT_LISTS: "eventLists",
  EVENT_METADATA: "eventMetadata",
  EXECUTE_MODE_ITEMS: "executeModeItems",
  DAY_MODES: "dayModes",
  MAP_DATA: "mapData",
  MAP_ROTATION_SETTINGS: "mapRotationSettings",
  ROUTE_SETTINGS: "routeSettings",
  HALL_DEFINITIONS: "hallDefinitions",
  HALL_ROUTE_SETTINGS: "hallRouteSettings",
  MAP_VIEWPORT_SETTINGS: "mapViewportSettings",
  SYNC_QUEUE: "syncQueue",
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

const LOCAL_STORAGE_FALLBACK_DISABLED_STORES = new Set<StoreName>([
  STORES.MAP_DATA,
]);

const LOCAL_STORAGE_KEYS: Record<StoreName, string> = {
  [STORES.EVENT_LISTS]: "eventShoppingLists",
  [STORES.EVENT_METADATA]: "eventMetadata",
  [STORES.EXECUTE_MODE_ITEMS]: "executeModeItems",
  [STORES.DAY_MODES]: "dayModes",
  [STORES.MAP_DATA]: "mapData",
  [STORES.MAP_ROTATION_SETTINGS]: "mapRotationSettings",
  [STORES.ROUTE_SETTINGS]: "routeSettings",
  [STORES.HALL_DEFINITIONS]: "hallDefinitions",
  [STORES.HALL_ROUTE_SETTINGS]: "hallRouteSettings",
  [STORES.MAP_VIEWPORT_SETTINGS]: "mapViewportSettings",
  [STORES.SYNC_QUEUE]: "syncQueue",
};

export type LoadStatus = "ok" | "missing" | "error";

export type LoadResult<T> = {
  status: LoadStatus;
  data: T | null;
  error?: unknown;
};

let dbInstance: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase> | null = null;

function resetDbInstance() {
  dbOpenPromise = null;
  if (!dbInstance) return;
  try {
    dbInstance.close();
  } catch {
    // Ignore close failures; the next operation will open a fresh connection.
  }
  dbInstance = null;
}

function ensureStoreExists(db: IDBDatabase, storeName: StoreName) {
  if (!db.objectStoreNames.contains(storeName)) {
    throw new Error(`IndexedDB object store is missing: ${storeName}`);
  }
}

function getLocalStorageKey(storeName: StoreName, key: string) {
  const baseKey = LOCAL_STORAGE_KEYS[storeName];
  return key === "data" ? baseKey : `${baseKey}:${key}`;
}

function saveDataToLocalStorage<T>(
  storeName: StoreName,
  key: string,
  data: T,
): void {
  localStorage.setItem(
    getLocalStorageKey(storeName, key),
    JSON.stringify(data),
  );
}

function clearLocalStorageFallbackData(
  storeName: StoreName,
  key: string,
): void {
  localStorage.removeItem(getLocalStorageKey(storeName, key));
}

function canUseLocalStorageFallback(storeName: StoreName): boolean {
  return !LOCAL_STORAGE_FALLBACK_DISABLED_STORES.has(storeName);
}

function getMapDataEntryKey(eventName: string, dayMapName: string): string {
  return `${MAP_DATA_KEY_PREFIX}${JSON.stringify([eventName, dayMapName])}`;
}

function parseMapDataEntryKey(key: string): [string, string] | null {
  if (!key.startsWith(MAP_DATA_KEY_PREFIX)) return null;

  try {
    const parsed = JSON.parse(key.slice(MAP_DATA_KEY_PREFIX.length));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Ignore invalid split-map keys; legacy data is handled separately.
  }

  return null;
}

function collectMapDataEntryKeys(data: MapDataStore): Set<string> {
  const keys = new Set<string>();

  Object.entries(data).forEach(([eventName, eventMapData]) => {
    Object.keys(eventMapData).forEach((dayMapName) => {
      keys.add(getMapDataEntryKey(eventName, dayMapName));
    });
  });

  return keys;
}

function getDayMapDataByStorageKey(data: MapDataStore, key: string) {
  const parsedKey = parseMapDataEntryKey(key);
  if (!parsedKey) return undefined;

  const [eventName, dayMapName] = parsedKey;
  return data[eventName]?.[dayMapName];
}

async function deleteDataFromIndexedDb(
  storeName: StoreName,
  key: string,
): Promise<void> {
  const db = await openDB();
  ensureStoreExists(db, storeName);

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onerror = () => {
      console.error(`Failed to delete from ${storeName}:`, request.error);
      reject(request.error);
    };

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onabort = () => {
      reject(transaction.error || request.error);
    };
  });
}

function loadDataFromLocalStorage<T>(
  storeName: StoreName,
  key: string,
): LoadResult<T> {
  const stored = localStorage.getItem(getLocalStorageKey(storeName, key));
  if (stored === null) {
    return {
      status: "missing",
      data: null,
    };
  }

  try {
    return {
      status: "ok",
      data: JSON.parse(stored) as T,
    };
  } catch (error) {
    console.error(
      `Failed to load fallback localStorage data for ${storeName}:`,
      error,
    );
    return {
      status: "error",
      data: null,
      error,
    };
  }
}

/**
 * データベースを開く
 */
function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  if (dbOpenPromise) {
    return dbOpenPromise;
  }

  dbOpenPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error("IndexedDB open error:", request.error);
      resetDbInstance();
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        resetDbInstance();
      };
      dbInstance.onclose = () => {
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onblocked = () => {
      console.warn("IndexedDB open request is blocked by another tab.");
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

  dbOpenPromise.then(
    () => {
      dbOpenPromise = null;
    },
    () => {
      dbOpenPromise = null;
    },
  );

  return dbOpenPromise;
}

/**
 * mapDataストアへの複数キーの削除+書き込みを単一トランザクションで実行
 * (キーごとにトランザクションを分けると、書き込み回数と一時的なディスク使用量が
 *  増えて大容量データで失敗しやすくなるため)
 */
async function writeMapDataEntriesOnce(
  deletes: string[],
  puts: { key: string; value: unknown }[],
): Promise<void> {
  const db = await openDB();
  ensureStoreExists(db, STORES.MAP_DATA);

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.MAP_DATA, "readwrite");
    const store = transaction.objectStore(STORES.MAP_DATA);
    let requestError: unknown = null;

    const trackRequestError = (request: IDBRequest) => {
      request.onerror = () => {
        requestError = request.error;
      };
    };

    deletes.forEach((key) => trackRequestError(store.delete(key)));
    puts.forEach(({ key, value }) => trackRequestError(store.put(value, key)));

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onabort = () => {
      console.error(
        `Failed to write to ${STORES.MAP_DATA}:`,
        transaction.error || requestError,
      );
      reject(transaction.error || requestError);
    };
  });
}

async function writeMapDataEntries(
  deletes: string[],
  puts: { key: string; value: unknown }[],
): Promise<void> {
  if (deletes.length === 0 && puts.length === 0) return;

  try {
    await writeMapDataEntriesOnce(deletes, puts);
  } catch (firstError) {
    console.warn(
      `Retrying ${STORES.MAP_DATA} write after failure:`,
      firstError,
    );
    resetDbInstance();
    await writeMapDataEntriesOnce(deletes, puts);
  }
}

/**
 * データを保存
 */
async function saveData<T>(
  storeName: StoreName,
  key: string,
  data: T,
): Promise<void> {
  const saveOnce = async (): Promise<void> => {
    const db = await openDB();
    ensureStoreExists(db, storeName);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.put(data, key);

      request.onerror = () => {
        console.error(`Failed to save to ${storeName}:`, request.error);
        reject(request.error);
      };

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onabort = () => {
        reject(transaction.error || request.error);
      };
    });
  };

  try {
    await saveOnce();
    clearLocalStorageFallbackData(storeName, key);
  } catch (firstError) {
    resetDbInstance();
    try {
      await saveOnce();
      clearLocalStorageFallbackData(storeName, key);
    } catch (retryError) {
      if (!canUseLocalStorageFallback(storeName)) {
        throw retryError || firstError;
      }
      console.warn(
        `Falling back to localStorage for ${storeName}:`,
        retryError || firstError,
      );
      saveDataToLocalStorage(storeName, key, data);
    }
  }
}

/**
 * データを読み込み
 */
async function loadData<T>(
  storeName: StoreName,
  key: string,
): Promise<LoadResult<T>> {
  const loadOnce = async (): Promise<LoadResult<T>> => {
    const db = await openDB();
    ensureStoreExists(db, storeName);

    return await new Promise((resolve) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => {
        console.error(`Failed to load from ${storeName}:`, request.error);
        resolve({
          status: "error",
          data: null,
          error: request.error,
        });
      };

      request.onsuccess = () => {
        if (request.result === undefined || request.result === null) {
          resolve({
            status: "missing",
            data: null,
          });
          return;
        }

        resolve({
          status: "ok",
          data: request.result as T,
        });
      };

      transaction.onabort = () => {
        resolve({
          status: "error",
          data: null,
          error: transaction.error || request.error,
        });
      };
    });
  };

  try {
    const firstResult = await loadOnce();
    if (firstResult.status !== "error") return firstResult;
    resetDbInstance();
    const retryResult = await loadOnce();
    if (retryResult.status !== "error") return retryResult;
    console.warn(
      `Falling back to localStorage for ${storeName}:`,
      retryResult.error,
    );
    return loadDataFromLocalStorage(storeName, key);
  } catch (error) {
    resetDbInstance();
    try {
      return await loadOnce();
    } catch (retryError) {
      console.warn(
        `Falling back to localStorage for ${storeName}:`,
        retryError || error,
      );
      return loadDataFromLocalStorage(storeName, key);
    }
  }
}

/**
 * データを削除
 */
async function deleteData(storeName: StoreName, key: string): Promise<void> {
  try {
    await deleteDataFromIndexedDb(storeName, key);
  } catch {
    resetDbInstance();
    localStorage.removeItem(getLocalStorageKey(storeName, key));
  }
}

// deleteDataは将来使用する可能性があるため維持
void deleteData;

/**
 * ストア内の全キーを取得
 */
async function getAllKeys(storeName: StoreName): Promise<string[]> {
  try {
    const db = await openDB();
    ensureStoreExists(db, storeName);

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
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
  } catch {
    resetDbInstance();
    return localStorage.getItem(LOCAL_STORAGE_KEYS[storeName]) === null
      ? []
      : ["data"];
  }
}

/**
 * ストア内の全データを取得
 */
async function getAllData<T>(storeName: StoreName): Promise<Record<string, T>> {
  try {
    const db = await openDB();
    ensureStoreExists(db, storeName);

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const result: Record<string, T> = {};

      const cursorRequest = store.openCursor();

      cursorRequest.onerror = () => {
        console.error(
          `Failed to get all data from ${storeName}:`,
          cursorRequest.error,
        );
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
  } catch {
    resetDbInstance();
    const fallback = loadDataFromLocalStorage<T>(storeName, "data");
    return fallback.status === "ok" && fallback.data !== null
      ? { data: fallback.data }
      : {};
  }
}

/**
 * localStorageからIndexedDBへの移行
 */
async function migrateFromLocalStorage(): Promise<boolean> {
  try {
    // localStorageにデータがあるか確認
    const storedLists = localStorage.getItem("eventShoppingLists");
    if (!storedLists) {
      return false; // 移行するデータがない
    }

    console.log("Migrating data from localStorage to IndexedDB...");

    // 各データを移行
    const migrations = [
      { key: "eventShoppingLists", store: STORES.EVENT_LISTS },
      { key: "eventMetadata", store: STORES.EVENT_METADATA },
      { key: "executeModeItems", store: STORES.EXECUTE_MODE_ITEMS },
      { key: "dayModes", store: STORES.DAY_MODES },
      { key: "mapData", store: STORES.MAP_DATA },
      { key: "mapRotationSettings", store: STORES.MAP_ROTATION_SETTINGS },
      { key: "routeSettings", store: STORES.ROUTE_SETTINGS },
      { key: "hallDefinitions", store: STORES.HALL_DEFINITIONS },
      { key: "hallRouteSettings", store: STORES.HALL_ROUTE_SETTINGS },
    ];

    for (const { key, store } of migrations) {
      const data = localStorage.getItem(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          if (store === STORES.MAP_DATA) {
            const compactedMapData = compactMapDataForStorage(
              parsed as MapDataStore,
            );
            const puts: { key: string; value: unknown }[] = [];
            for (const [eventName, eventMapData] of Object.entries(
              compactedMapData,
            )) {
              for (const [dayMapName, dayMapData] of Object.entries(
                eventMapData,
              )) {
                puts.push({
                  key: getMapDataEntryKey(eventName, dayMapName),
                  value: dayMapData,
                });
              }
            }
            await writeMapDataEntries([], puts);
          } else {
            await saveData(store, "data", parsed);
          }
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

    console.log("Migration complete");
    return true;
  } catch (error) {
    console.error("Migration failed:", error);
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

const resolveLoadResultData = <T extends Record<string, unknown>>(
  storeName: StoreName,
  result: LoadResult<T>,
): T => {
  if (result.status === "ok" && result.data) {
    return result.data;
  }

  if (result.status === "error") {
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
  if (loadResult.status === "error") {
    console.error(
      `Failed to load ${storeName} during event deletion:`,
      loadResult.error,
    );
    return;
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

// 公開API
export const db = {
  STORES,

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
    const puts: { key: string; value: unknown }[] = [];
    const nextKeys = new Set<string>();

    Object.entries(data).forEach(([eventName, eventMapData]) => {
      Object.entries(eventMapData).forEach(([dayMapName, dayMapData]) => {
        const key = getMapDataEntryKey(eventName, dayMapName);
        nextKeys.add(key);
        puts.push({ key, value: compactDayMapForStorage(dayMapData) });
      });
    });

    const existingKeys = await getAllKeys(STORES.MAP_DATA);
    const deletes = existingKeys
      .map((key) => String(key))
      .filter(
        (keyString) =>
          keyString === MAP_DATA_LEGACY_KEY ||
          (keyString.startsWith(MAP_DATA_KEY_PREFIX) &&
            !nextKeys.has(keyString)),
      );

    await writeMapDataEntries(deletes, puts);

    clearLocalStorageFallbackData(STORES.MAP_DATA, MAP_DATA_LEGACY_KEY);
  },
  async saveMapDataChanges(
    previousData: MapDataStore,
    nextData: MapDataStore,
  ): Promise<void> {
    const previousKeys = collectMapDataEntryKeys(previousData);
    const nextKeys = collectMapDataEntryKeys(nextData);

    const deletes: string[] = [MAP_DATA_LEGACY_KEY];
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) {
        deletes.push(key);
      }
    }

    const puts: { key: string; value: unknown }[] = [];
    for (const key of nextKeys) {
      const previousDayMapData = getDayMapDataByStorageKey(previousData, key);
      const nextDayMapData = getDayMapDataByStorageKey(nextData, key);
      if (!nextDayMapData || previousDayMapData === nextDayMapData) continue;

      puts.push({ key, value: compactDayMapForStorage(nextDayMapData) });
    }

    await writeMapDataEntries(deletes, puts);

    clearLocalStorageFallbackData(STORES.MAP_DATA, MAP_DATA_LEGACY_KEY);
  },
  async loadMapData(): Promise<LoadResult<MapDataStore>> {
    try {
      const entries = await getAllData<unknown>(STORES.MAP_DATA);
      const loaded: MapDataStore = {};

      Object.entries(entries).forEach(([key, value]) => {
        if (key === MAP_DATA_LEGACY_KEY) {
          const legacyMapData = expandMapDataFromStorage(
            value as Record<string, Record<string, unknown>>,
          );
          Object.entries(legacyMapData).forEach(([eventName, eventMapData]) => {
            loaded[eventName] = {
              ...(loaded[eventName] ?? {}),
              ...eventMapData,
            };
          });
          return;
        }

        const parsedKey = parseMapDataEntryKey(key);
        if (!parsedKey) return;

        const [eventName, dayMapName] = parsedKey;
        loaded[eventName] = {
          ...(loaded[eventName] ?? {}),
          [dayMapName]: expandDayMapFromStorage(
            value as Parameters<typeof expandDayMapFromStorage>[0],
          ),
        };
      });

      return {
        status: Object.keys(loaded).length > 0 ? "ok" : "missing",
        data: Object.keys(loaded).length > 0 ? loaded : null,
      };
    } catch (error) {
      return {
        status: "error",
        data: null,
        error,
      };
    }
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

  // 同期キュー（共有機能用）
  async saveSyncQueue(data: unknown[]): Promise<void> {
    await saveData(STORES.SYNC_QUEUE, "data", data);
  },
  async loadSyncQueue(): Promise<LoadResult<unknown[]>> {
    return loadData(STORES.SYNC_QUEUE, "data");
  },

  // localStorageからの移行
  migrateFromLocalStorage,

  // ユーティリティ
  getAllKeys,
  getAllData,
};

export default db;
