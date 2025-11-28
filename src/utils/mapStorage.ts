import { MapData, MapMetadata } from '../types';

const STORAGE_KEYS = {
  MAP_METADATA: 'mapMetadata',
};

const DB_NAME = 'eventShoppingPlannerDB';
const DB_VERSION = 1;
const STORE_NAMES = {
  MAP_DATA: 'mapData',
};

// ストレージ戦略の決定ロジック
function shouldUseIndexedDB(mapData: MapData): boolean {
  const jsonString = JSON.stringify(mapData);
  const sizeInBytes = new Blob([jsonString]).size;
  const sizeInMB = sizeInBytes / (1024 * 1024);
  
  // 5MB以上の場合、IndexedDBを使用
  return sizeInMB >= 5;
}

// localStorageに保存
export function saveMapDataToLocalStorage(
  eventName: string,
  eventDate: string,
  mapData: MapData
): void {
  const key = `mapData_${eventName}_${eventDate}`;
  try {
    localStorage.setItem(key, JSON.stringify(mapData));
    updateMapMetadata(eventName, eventDate, mapData, 'localStorage');
  } catch (error) {
    console.error('Failed to save map data to localStorage', error);
    throw error;
  }
}

// localStorageから読み込み
export function loadMapDataFromLocalStorage(
  eventName: string,
  eventDate: string
): MapData | null {
  const key = `mapData_${eventName}_${eventDate}`;
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('Failed to load map data from localStorage', error);
    return null;
  }
}

// localStorageから削除
export function deleteMapDataFromLocalStorage(
  eventName: string,
  eventDate: string
): void {
  const key = `mapData_${eventName}_${eventDate}`;
  try {
    localStorage.removeItem(key);
    removeMapMetadata(eventName, eventDate);
  } catch (error) {
    console.error('Failed to delete map data from localStorage', error);
  }
}

// IndexedDBに保存
export class MapDataStorage {
  private db: IDBDatabase | null = null;
  
  async init(): Promise<void> {
    if (this.db) return;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAMES.MAP_DATA)) {
          const store = db.createObjectStore(STORE_NAMES.MAP_DATA, { keyPath: ['eventName', 'eventDate'] });
          store.createIndex('eventName', 'eventName', { unique: false });
        }
      };
    });
  }
  
  async saveMapData(
    eventName: string,
    eventDate: string,
    mapData: MapData
  ): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAMES.MAP_DATA], 'readwrite');
      const store = transaction.objectStore(STORE_NAMES.MAP_DATA);
      
      const request = store.put({
        eventName,
        eventDate,
        data: mapData,
        timestamp: new Date().toISOString(),
      });
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        updateMapMetadata(eventName, eventDate, mapData, 'indexedDB');
        resolve();
      };
    });
  }
  
  async loadMapData(
    eventName: string,
    eventDate: string
  ): Promise<MapData | null> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAMES.MAP_DATA], 'readonly');
      const store = transaction.objectStore(STORE_NAMES.MAP_DATA);
      
      const request = store.get([eventName, eventDate]);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.data : null);
      };
    });
  }
  
  async deleteMapData(eventName: string, eventDate: string): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAMES.MAP_DATA], 'readwrite');
      const store = transaction.objectStore(STORE_NAMES.MAP_DATA);
      
      const request = store.delete([eventName, eventDate]);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        removeMapMetadata(eventName, eventDate);
        resolve();
      };
    });
  }
}

// マップメタデータの更新
function updateMapMetadata(
  eventName: string,
  eventDate: string,
  mapData: MapData,
  storageType: 'localStorage' | 'indexedDB'
): void {
  try {
    const metadataStr = localStorage.getItem(STORAGE_KEYS.MAP_METADATA);
    const metadata: Record<string, MapMetadata> = metadataStr ? JSON.parse(metadataStr) : {};
    
    if (!metadata[eventName]) {
      metadata[eventName] = {
        eventName,
        maps: {},
      };
    }
    
    const jsonString = JSON.stringify(mapData);
    const sizeInBytes = new Blob([jsonString]).size;
    
    metadata[eventName].maps[eventDate] = {
      sheetName: mapData.sheetName,
      lastModified: new Date().toISOString(),
      dataSize: sizeInBytes,
    };
    
    localStorage.setItem(STORAGE_KEYS.MAP_METADATA, JSON.stringify(metadata));
  } catch (error) {
    console.error('Failed to update map metadata', error);
  }
}

// マップメタデータの削除
function removeMapMetadata(eventName: string, eventDate: string): void {
  try {
    const metadataStr = localStorage.getItem(STORAGE_KEYS.MAP_METADATA);
    if (!metadataStr) return;
    
    const metadata: Record<string, MapMetadata> = JSON.parse(metadataStr);
    if (metadata[eventName] && metadata[eventName].maps[eventDate]) {
      delete metadata[eventName].maps[eventDate];
      
      // マップが全て削除された場合はイベントのメタデータも削除
      if (Object.keys(metadata[eventName].maps).length === 0) {
        delete metadata[eventName];
      }
      
      localStorage.setItem(STORAGE_KEYS.MAP_METADATA, JSON.stringify(metadata));
    }
  } catch (error) {
    console.error('Failed to remove map metadata', error);
  }
}

// マップメタデータの読み込み
export function loadMapMetadata(eventName: string): MapMetadata | null {
  try {
    const metadataStr = localStorage.getItem(STORAGE_KEYS.MAP_METADATA);
    if (!metadataStr) return null;
    
    const metadata: Record<string, MapMetadata> = JSON.parse(metadataStr);
    return metadata[eventName] || null;
  } catch (error) {
    console.error('Failed to load map metadata', error);
    return null;
  }
}

// 統合保存関数（ストレージ戦略に応じて自動選択）
const mapDataStorage = new MapDataStorage();

export async function saveMapData(
  eventName: string,
  eventDate: string,
  mapData: MapData
): Promise<void> {
  if (shouldUseIndexedDB(mapData)) {
    await mapDataStorage.saveMapData(eventName, eventDate, mapData);
  } else {
    saveMapDataToLocalStorage(eventName, eventDate, mapData);
  }
}

// 統合読み込み関数（メタデータからストレージタイプを判定）
export async function loadMapData(
  eventName: string,
  eventDate: string
): Promise<MapData | null> {
  const metadata = loadMapMetadata(eventName);
  if (!metadata || !metadata.maps[eventDate]) {
    return null;
  }
  
  // メタデータにストレージタイプの情報がない場合は、両方を試す
  // まずlocalStorageを試し、なければIndexedDBを試す
  const localStorageData = loadMapDataFromLocalStorage(eventName, eventDate);
  if (localStorageData) {
    return localStorageData;
  }
  
  return await mapDataStorage.loadMapData(eventName, eventDate);
}

// 統合削除関数
export async function deleteMapData(
  eventName: string,
  eventDate: string
): Promise<void> {
  // 両方のストレージから削除を試みる
  deleteMapDataFromLocalStorage(eventName, eventDate);
  try {
    await mapDataStorage.deleteMapData(eventName, eventDate);
  } catch (error) {
    // IndexedDBにデータがない場合はエラーを無視
    console.warn('Failed to delete from IndexedDB (may not exist)', error);
  }
}

