import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DayMapData } from "../types/map";
import { db, type AppData } from "./indexedDB";

const RESTORE_STORE_NAMES = [
  db.STORES.EVENT_LISTS,
  db.STORES.EVENT_METADATA,
  db.STORES.EXECUTE_MODE_ITEMS,
  db.STORES.DAY_MODES,
  db.STORES.MAP_DATA,
  db.STORES.MAP_ROTATION_SETTINGS,
  db.STORES.ROUTE_SETTINGS,
  db.STORES.HALL_DEFINITIONS,
  db.STORES.HALL_ROUTE_SETTINGS,
  db.STORES.MAP_VIEWPORT_SETTINGS,
] as const;

const ORDINARY_STORE_NAMES = RESTORE_STORE_NAMES.filter(
  (storeName) => storeName !== db.STORES.MAP_DATA,
);

const FALLBACK_KEYS = [
  "eventShoppingLists",
  "eventMetadata",
  "executeModeItems",
  "dayModes",
  "mapData",
  "mapRotationSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "mapViewportSettings",
] as const;

function makeDayMap(marker: string): DayMapData {
  return {
    sheetName: `${marker}シート`,
    maxRow: 1,
    maxCol: 1,
    cells: [
      {
        row: 1,
        col: 1,
        value: marker,
        backgroundColor: null,
        fontColor: null,
        borders: {
          top: null,
          right: null,
          bottom: null,
          left: null,
        },
        isMerged: false,
        isVerticalText: false,
      },
    ],
    mergedCells: [],
    blocks: [],
  };
}

function makeAppData(marker: string): AppData {
  const eventName = `${marker}イベント`;

  return {
    eventLists: {
      [eventName]: [{ id: `${marker}-item`, title: `${marker}頒布物` }],
    },
    eventMetadata: {
      [eventName]: { source: marker },
    },
    executeModeItems: {
      [eventName]: { "1日目": [`${marker}-item`] },
    },
    dayModes: {
      [eventName]: { "1日目": `${marker}モード` },
    },
    mapData: {
      [eventName]: {
        "1日目マップ": makeDayMap(`${marker}-day-1`),
        "2日目マップ": makeDayMap(`${marker}-day-2`),
      },
    },
    mapRotationSettings: {
      [eventName]: { "1日目マップ": { rotation: marker.length } },
    },
    routeSettings: {
      [eventName]: { "1日目マップ": { route: marker } },
    },
    hallDefinitions: {
      [eventName]: { "1日目マップ": [{ id: `${marker}-hall` }] },
    },
    hallRouteSettings: {
      [eventName]: { "1日目マップ": { order: [`${marker}-hall`] } },
    },
    mapViewportSettings: {
      [eventName]: { "1日目マップ": { scale: marker.length } },
    },
  };
}

async function readRawRestoreStores(): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      RESTORE_STORE_NAMES.map(async (storeName) => [
        storeName,
        await db.getAllData(storeName),
      ]),
    ),
  );
}

function setFallbackMarkers(marker: string): void {
  FALLBACK_KEYS.forEach((key) => {
    localStorage.setItem(key, `${marker}:${key}`);
  });
}

function expectFallbackMarkers(marker: string): void {
  FALLBACK_KEYS.forEach((key) => {
    expect(localStorage.getItem(key)).toBe(`${marker}:${key}`);
  });
}

describe("db.restoreAppDataAtomically", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces all ten app-data stores and leaves the sync queue untouched", async () => {
    const restoredData = makeAppData("成功");
    const syncQueue = [{ id: "keep-sync-queue" }];
    localStorage.clear();
    setFallbackMarkers("成功前");
    await db.saveSyncQueue(syncQueue);

    await expect(
      db.restoreAppDataAtomically(restoredData),
    ).resolves.toBeUndefined();

    expect(await db.getAllAppData()).toEqual(restoredData);
    const rawStores = await readRawRestoreStores();
    ORDINARY_STORE_NAMES.forEach((storeName) => {
      expect(Object.keys(rawStores[storeName] as object)).toEqual(["data"]);
    });
    expect(Object.keys(rawStores[db.STORES.MAP_DATA] as object).sort()).toEqual(
      [
        'mapData:["成功イベント","1日目マップ"]',
        'mapData:["成功イベント","2日目マップ"]',
      ],
    );
    expect(await db.loadSyncQueue()).toMatchObject({
      status: "ok",
      data: syncQueue,
    });
    expectFallbackMarkers("成功前");
  });

  it("normalizes an empty map event during atomic restore without leaving a split record", async () => {
    const restoredData = {
      ...makeAppData("空map復元"),
      mapData: { 空map復元イベント: {} },
    };
    localStorage.clear();

    await expect(
      db.restoreAppDataAtomically(restoredData),
    ).resolves.toBeUndefined();

    expect(await db.loadMapData()).toMatchObject({
      status: "missing",
      data: null,
    });
    expect(await db.getAllKeys(db.STORES.MAP_DATA)).toEqual([]);
  });

  it("rolls back a mid-restore DataCloneError and succeeds on retry", async () => {
    const initialData = makeAppData("復元前");
    const retryData = makeAppData("再成功");
    const syncQueue = [{ id: "still-in-sync-queue" }];
    localStorage.clear();
    await db.saveSyncQueue(syncQueue);
    await db.restoreAppDataAtomically(initialData);
    const beforeFailure = await readRawRestoreStores();
    setFallbackMarkers("失敗前");

    const failingData: AppData = {
      ...makeAppData("失敗候補"),
      routeSettings: {
        失敗候補イベント: {
          "1日目マップ": {
            uncloneable: () => "DataCloneError",
          },
        },
      },
    };

    await expect(
      db.restoreAppDataAtomically(failingData),
    ).rejects.toMatchObject({
      name: "DataCloneError",
    });

    expect(await readRawRestoreStores()).toEqual(beforeFailure);
    expect(await db.getAllAppData()).toEqual(initialData);
    expect(await db.loadSyncQueue()).toMatchObject({
      status: "ok",
      data: syncQueue,
    });
    expectFallbackMarkers("失敗前");

    await expect(
      db.restoreAppDataAtomically(retryData),
    ).resolves.toBeUndefined();

    expect(await db.getAllAppData()).toEqual(retryData);
    expect(await db.loadSyncQueue()).toMatchObject({
      status: "ok",
      data: syncQueue,
    });
    expectFallbackMarkers("失敗前");
  });

  it("does not touch legacy sources while restoring", async () => {
    const restoredData = makeAppData("後片付け失敗");
    localStorage.clear();
    setFallbackMarkers("削除前");
    const cleanupError = new Error("localStorage is locked");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
      throw cleanupError;
    });

    await expect(
      db.restoreAppDataAtomically(restoredData),
    ).resolves.toBeUndefined();

    expect(await db.getAllAppData()).toEqual(restoredData);
    expectFallbackMarkers("削除前");
    expect(Storage.prototype.removeItem).not.toHaveBeenCalled();
  });
});
