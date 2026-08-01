// @vitest-environment jsdom

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapDataStore } from "../types/map";

const DATABASE_NAME = "EventShoppingPlannerDB";
const MAP_DATA_STORE = "mapData";
const FUTURE_STORE = "futureOnly";
const REQUIRED_STORES = [
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "dayModes",
  MAP_DATA_STORE,
  "mapRotationSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "mapViewportSettings",
  "syncQueue",
] as const;

const testMapData: MapDataStore = {
  互換性テストイベント: {
    テストマップ: {
      sheetName: "テストマップ",
      maxRow: 1,
      maxCol: 1,
      cells: [],
      mergedCells: [],
      blocks: [],
    },
  },
};

let databaseFactory: IDBFactory;

function requestRawDatabase(
  version?: number,
  storesToCreate: readonly string[] = [],
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? databaseFactory.open(DATABASE_NAME)
        : databaseFactory.open(DATABASE_NAME, version);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      storesToCreate.forEach((storeName) => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      });
    };
  });
}

async function seedDatabase(
  version: number,
  stores: readonly string[],
): Promise<void> {
  const database = await requestRawDatabase(version, stores);
  try {
    if (database.objectStoreNames.contains(FUTURE_STORE)) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(FUTURE_STORE, "readwrite");
        const request = transaction
          .objectStore(FUTURE_STORE)
          .put({ preserved: true }, "sentinel");
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? request.error);
      });
    }
  } finally {
    database.close();
  }
}

async function inspectRawDatabase(): Promise<{
  version: number;
  stores: string[];
  futureValue: unknown;
}> {
  const database = await requestRawDatabase();
  try {
    let futureValue: unknown;
    if (database.objectStoreNames.contains(FUTURE_STORE)) {
      futureValue = await new Promise((resolve, reject) => {
        const request = database
          .transaction(FUTURE_STORE, "readonly")
          .objectStore(FUTURE_STORE)
          .get("sentinel");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    }

    return {
      version: database.version,
      stores: Array.from(database.objectStoreNames),
      futureValue,
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  databaseFactory = new IDBFactory();
  vi.stubGlobal("indexedDB", databaseFactory);
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("IndexedDB version compatibility", () => {
  it("uses a compatible version 7 database without downgrading or changing future data", async () => {
    await seedDatabase(7, [...REQUIRED_STORES, FUTURE_STORE]);
    const { db } = await import("./indexedDB");

    await db.saveMapDataChanges({}, testMapData);

    const loaded = await db.loadMapData();
    expect(loaded.status).toBe("ok");
    expect(loaded.data).toEqual(testMapData);

    const inspected = await inspectRawDatabase();
    expect(inspected.version).toBe(7);
    expect(inspected.stores).toContain(FUTURE_STORE);
    expect(inspected.futureValue).toEqual({ preserved: true });
  });

  it("does not upgrade or modify a version 7 database with a missing required store", async () => {
    const incompleteStores = REQUIRED_STORES.filter(
      (storeName) => storeName !== MAP_DATA_STORE,
    );
    await seedDatabase(7, [...incompleteStores, FUTURE_STORE]);
    const { db } = await import("./indexedDB");

    await expect(db.saveMapDataChanges({}, testMapData)).rejects.toMatchObject({
      name: "InvalidStateError",
    });

    const inspected = await inspectRawDatabase();
    expect(inspected.version).toBe(7);
    expect(inspected.stores).not.toContain(MAP_DATA_STORE);
    expect(inspected.futureValue).toEqual({ preserved: true });
  });

  it("refuses an unknown newer database without modifying it", async () => {
    await seedDatabase(8, [...REQUIRED_STORES, FUTURE_STORE]);
    const { db } = await import("./indexedDB");

    await expect(db.saveMapDataChanges({}, testMapData)).rejects.toMatchObject({
      name: "VersionError",
    });

    const inspected = await inspectRawDatabase();
    expect(inspected.version).toBe(8);
    expect(inspected.futureValue).toEqual({ preserved: true });
  });

  it("still creates a new database at version 5", async () => {
    const { db } = await import("./indexedDB");

    await db.saveMapDataChanges({}, testMapData);

    const inspected = await inspectRawDatabase();
    expect(inspected.version).toBe(5);
    expect(inspected.stores).toEqual(
      expect.arrayContaining([...REQUIRED_STORES]),
    );
  });
});
