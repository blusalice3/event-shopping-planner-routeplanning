import type { MapDataStore } from "../../types/map";
import {
  InvalidMapPayloadError,
  compactDayMapForStorage,
  expandDayMapFromStorage,
  expandMapDataFromStorage,
} from "../../utils/mapDataPersistence";
import { createSynchronousFingerprint } from "../../utils/persistenceResilience";
import { MAP_DATA_KEY_PREFIX, MAP_DATA_LEGACY_KEY } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";

const fingerprintsEqual = (left: unknown, right: unknown): boolean => {
  try {
    const leftFingerprint = createSynchronousFingerprint(left);
    const rightFingerprint = createSynchronousFingerprint(right);
    return (
      leftFingerprint.algorithm === rightFingerprint.algorithm &&
      leftFingerprint.canonicalization === rightFingerprint.canonicalization &&
      leftFingerprint.canonicalLength === rightFingerprint.canonicalLength &&
      leftFingerprint.value === rightFingerprint.value
    );
  } catch {
    return false;
  }
};

export function getMapDataEntryKey(
  eventName: string,
  dayMapName: string,
): string {
  return `${MAP_DATA_KEY_PREFIX}${JSON.stringify([eventName, dayMapName])}`;
}

export function parseMapDataEntryKey(key: string): [string, string] | null {
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
    // Managed-prefix records are app-owned evidence and fail closed below.
  }

  throw new InvalidMapPayloadError(
    "Persisted mapData contains an invalid managed split-record key.",
  );
}

export function readMapEntriesFromStore(
  store: IDBObjectStore,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const result: Record<string, unknown> = {};
    const request = store.openCursor();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to enumerate mapData."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(result);
        return;
      }
      result[String(cursor.key)] = cursor.value;
      cursor.continue();
    };
  });
}

export function materializeMapData(entries: Record<string, unknown>): {
  data: MapDataStore;
  knownKeys: string[];
} {
  const data: MapDataStore = {};
  const knownKeys: string[] = [];

  if (Object.prototype.hasOwnProperty.call(entries, MAP_DATA_LEGACY_KEY)) {
    knownKeys.push(MAP_DATA_LEGACY_KEY);
    const legacy = expandMapDataFromStorage(entries[MAP_DATA_LEGACY_KEY]);
    Object.entries(legacy).forEach(([eventName, eventMapData]) => {
      Object.defineProperty(data, eventName, {
        value: { ...eventMapData },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
  }

  Object.entries(entries).forEach(([storageKey, value]) => {
    const parsed = parseMapDataEntryKey(storageKey);
    if (!parsed) return;
    knownKeys.push(storageKey);
    const [eventName, dayMapName] = parsed;
    const expandedDayMap = expandDayMapFromStorage(value);
    const existingEventMap = Object.prototype.hasOwnProperty.call(
      data,
      eventName,
    )
      ? data[eventName]
      : undefined;
    if (
      existingEventMap &&
      Object.prototype.hasOwnProperty.call(existingEventMap, dayMapName) &&
      !fingerprintsEqual(
        createSynchronousFingerprint(existingEventMap[dayMapName]),
        createSynchronousFingerprint(expandedDayMap),
      )
    ) {
      throw new PersistenceConflictError(
        `mapData contains conflicting legacy and split entries for ${eventName}/${dayMapName}.`,
      );
    }
    Object.defineProperty(data, eventName, {
      value: {
        ...(existingEventMap ?? {}),
        [dayMapName]: expandedDayMap,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });

  return { data, knownKeys };
}

export function buildMapDataPuts(
  data: MapDataStore,
): { key: string; value: unknown }[] {
  const puts: { key: string; value: unknown }[] = [];
  Object.entries(data).forEach(([eventName, eventMapData]) => {
    Object.entries(eventMapData).forEach(([dayMapName, dayMapData]) => {
      puts.push({
        key: getMapDataEntryKey(eventName, dayMapName),
        value: compactDayMapForStorage(dayMapData),
      });
    });
  });
  return puts;
}
