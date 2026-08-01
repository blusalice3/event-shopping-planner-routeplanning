import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import type { CellBorders, DayMapData, MapDataStore } from "../types/map";
import { toImportedEventData } from "../features/events/fileImport";
import { exportToXlsx, importFromXlsx } from "./exportImport";
import { db } from "./indexedDB";

const emptyBorders: CellBorders = {
  top: null,
  right: null,
  bottom: null,
  left: null,
};

function makeDayMap(value: string): DayMapData {
  return {
    sheetName: value,
    maxRow: 2,
    maxCol: 2,
    cells: [
      {
        row: 1,
        col: 1,
        value,
        backgroundColor: null,
        fontColor: null,
        borders: emptyBorders,
        isMerged: false,
        isVerticalText: false,
      },
    ],
    mergedCells: [],
    blocks: [],
  };
}

async function loadStoredMapData(): Promise<MapDataStore> {
  const result = await db.loadMapData();
  expect(result.status).not.toBe("error");
  return result.data ?? {};
}

async function openRawDatabase(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open("EventShoppingPlannerDB", 5);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function writeRawMapEntry(key: string, value: unknown): Promise<void> {
  const database = await openRawDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(db.STORES.MAP_DATA, "readwrite");
      const request = transaction
        .objectStore(db.STORES.MAP_DATA)
        .put(value, key);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  } finally {
    database.close();
  }
}

async function readRawMapEntry(key: string): Promise<unknown> {
  const database = await openRawDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(db.STORES.MAP_DATA, "readonly");
      const request = transaction.objectStore(db.STORES.MAP_DATA).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

function mockMapReadFailures(errors: readonly Error[]) {
  const originalTransaction = IDBDatabase.prototype.transaction;
  let failureIndex = 0;

  return vi
    .spyOn(IDBDatabase.prototype, "transaction")
    .mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const requestedStores =
        typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
      if (
        mode === "readonly" &&
        requestedStores.includes(db.STORES.MAP_DATA) &&
        failureIndex < errors.length
      ) {
        throw errors[failureIndex++];
      }
      return originalTransaction.call(this, storeNames, mode, options);
    });
}

async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem("mapData");
});

// 各テストは同じDBを共有するため、イベント名はテストごとに固有にする
describe("db.saveMapDataChanges", () => {
  it("saves newly added event maps", async () => {
    const next: MapDataStore = {
      新規イベント: {
        "1日目マップ": makeDayMap("a1"),
        "2日目マップ": makeDayMap("a2"),
      },
    };

    await db.saveMapDataChanges({}, next);

    const stored = await loadStoredMapData();
    expect(Object.keys(stored["新規イベント"]).sort()).toEqual([
      "1日目マップ",
      "2日目マップ",
    ]);
    expect(stored["新規イベント"]["1日目マップ"].cells[0].value).toBe("a1");
  });

  it("deletes removed event maps and keeps other events", async () => {
    const initial: MapDataStore = {
      削除イベント: { "1日目マップ": makeDayMap("a1") },
      維持イベント: { "1日目マップ": makeDayMap("b1") },
    };
    await db.saveMapDataChanges({}, initial);

    const next: MapDataStore = {
      維持イベント: initial["維持イベント"],
    };
    await db.saveMapDataChanges(initial, next);

    const stored = await loadStoredMapData();
    expect(stored["削除イベント"]).toBeUndefined();
    expect(stored["維持イベント"]["1日目マップ"].cells[0].value).toBe("b1");
  });

  it("overwrites only changed day maps on re-import of the same event", async () => {
    const initial: MapDataStore = {
      上書きイベント: {
        "1日目マップ": makeDayMap("old-1"),
        "2日目マップ": makeDayMap("old-2"),
      },
    };
    await db.saveMapDataChanges({}, initial);

    const next: MapDataStore = {
      上書きイベント: {
        "1日目マップ": makeDayMap("new-1"),
        "2日目マップ": initial["上書きイベント"]["2日目マップ"],
      },
    };
    await db.saveMapDataChanges(initial, next);

    const stored = await loadStoredMapData();
    expect(stored["上書きイベント"]["1日目マップ"].cells[0].value).toBe(
      "new-1",
    );
    expect(stored["上書きイベント"]["2日目マップ"].cells[0].value).toBe(
      "old-2",
    );
  });

  it("restores data after delete-then-reimport of the same event", async () => {
    const imported: MapDataStore = {
      再取込イベント: { "1日目マップ": makeDayMap("a1") },
    };
    await db.saveMapDataChanges({}, imported);

    // イベント削除
    await db.saveMapDataChanges(imported, {});
    expect((await loadStoredMapData())["再取込イベント"]).toBeUndefined();

    // 同じxlsxを再インポート
    const reimported: MapDataStore = {
      再取込イベント: { "1日目マップ": makeDayMap("a1") },
    };
    await db.saveMapDataChanges({}, reimported);

    const stored = await loadStoredMapData();
    expect(stored["再取込イベント"]["1日目マップ"].cells[0].value).toBe("a1");
  });

  it("keeps a committed map save successful when fallback cleanup is unavailable", async () => {
    const cleanupError = new DOMException(
      "localStorage is unavailable",
      "SecurityError",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw cleanupError;
    });
    const next: MapDataStore = {
      後片付け失敗イベント: {
        "1日目マップ": makeDayMap("committed"),
      },
    };

    await expect(db.saveMapDataChanges({}, next)).resolves.toBeUndefined();

    const stored = await loadStoredMapData();
    expect(stored["後片付け失敗イベント"]["1日目マップ"].cells[0].value).toBe(
      "committed",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to clear localStorage fallback after saving mapData:",
      cleanupError,
    );
  });

  it("aborts queued map deletes when a later put throws synchronously", async () => {
    const original: MapDataStore = {
      同期例外元イベント: {
        "1日目マップ": makeDayMap("must-remain"),
      },
    };
    await db.saveMapDataChanges({}, original);

    const uncloneableDayMap = {
      ...makeDayMap("uncloneable"),
      uncloneable: () => "DataCloneError",
    } as DayMapData;
    const invalidNext: MapDataStore = {
      同期例外先イベント: {
        "1日目マップ": uncloneableDayMap,
      },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      db.saveMapDataChanges(original, invalidNext),
    ).rejects.toMatchObject({
      name: "DataCloneError",
    });

    const stored = await loadStoredMapData();
    expect(stored["同期例外元イベント"]["1日目マップ"].cells[0].value).toBe(
      "must-remain",
    );
    expect(stored["同期例外先イベント"]).toBeUndefined();
  });

  it("migrates every unchanged day map before deleting the legacy map entry", async () => {
    const eventName = "旧DB形式移行イベント";
    const legacy: MapDataStore = {
      [eventName]: {
        "1日目マップ": makeDayMap("legacy-old-1"),
        "2日目マップ": makeDayMap("legacy-keep-2"),
      },
    };
    await writeRawMapEntry("data", legacy);

    const next: MapDataStore = {
      [eventName]: {
        "1日目マップ": makeDayMap("legacy-new-1"),
        "2日目マップ": legacy[eventName]["2日目マップ"],
      },
    };
    await db.saveMapDataChanges(legacy, next);

    const stored = await loadStoredMapData();
    expect(stored[eventName]["1日目マップ"].cells[0].value).toBe(
      "legacy-new-1",
    );
    expect(stored[eventName]["2日目マップ"].cells[0].value).toBe(
      "legacy-keep-2",
    );
    expect(await readRawMapEntry("data")).toBeUndefined();
    expect(
      await readRawMapEntry(
        `mapData:${JSON.stringify([eventName, "2日目マップ"])}`,
      ),
    ).toBeDefined();
  });

  it("normalizes and saves map data imported from an older full export", async () => {
    const eventName = "旧形式エクスポートイベント";
    const item: ShoppingItem = {
      id: "legacy-export-item",
      circle: "旧形式サークル",
      eventDate: "1日目",
      block: "A",
      number: "01a",
      title: "旧形式頒布物",
      price: 500,
      purchaseStatus: "None",
      quantity: 1,
      remarks: "",
    };
    const legacyDayMap = {
      sheetName: "1日目",
      maxRow: 1,
      maxCol: 1,
      cells: [{ row: 1, col: 1, value: "A" }],
    } as unknown as DayMapData;
    const blob = await exportToXlsx(
      eventName,
      [item],
      {
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: true,
        includeRouteInfo: false,
        format: "full",
      },
      {
        mapData: {
          [eventName]: {
            "1日目マップ": legacyDayMap,
          },
        },
      },
    );
    const exportBuffer = await readBlobAsArrayBuffer(blob);
    const file = {
      name: "legacy-full-export.xlsx",
      arrayBuffer: async () => exportBuffer,
    } as File;

    const importResult = await importFromXlsx(file);
    const imported = toImportedEventData(importResult);

    expect(importResult.success).toBe(true);
    expect(imported.mapData).not.toBeNull();

    await expect(
      db.saveMapDataChanges(
        {},
        {
          [eventName]: imported.mapData!,
        },
      ),
    ).resolves.toBeUndefined();

    const stored = await loadStoredMapData();
    expect(stored[eventName]["1日目マップ"]).toMatchObject({
      maxRow: 1,
      maxCol: 1,
      mergedCells: [],
      blocks: [],
      cells: [
        {
          row: 1,
          col: 1,
          value: "A",
          backgroundColor: null,
          fontColor: null,
          borders: emptyBorders,
          isMerged: false,
          isVerticalText: false,
        },
      ],
    });
  });

  it("keeps the current full export-import-save roundtrip compatible", async () => {
    const eventName = "現行形式ラウンドトリップイベント";
    const dayMap: DayMapData = {
      ...makeDayMap("current-format"),
      blocks: [
        {
          id: "block-a",
          name: "A",
          startRow: 1,
          startCol: 1,
          endRow: 2,
          endCol: 2,
          numberCells: [{ value: 1, row: 1, col: 1 }],
        },
      ],
    };
    const item: ShoppingItem = {
      id: "current-export-item",
      circle: "現行形式サークル",
      eventDate: "1日目",
      block: "A",
      number: "01a",
      title: "現行形式頒布物",
      price: 700,
      catalogPrice: 900,
      purchaseStatus: "Purchased",
      quantity: 1,
      remarks: "利用者メモ",
      sheetRemarks: "シート備考",
      source: "spreadsheet",
    };
    const blob = await exportToXlsx(
      eventName,
      [item],
      {
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: true,
        includeRouteInfo: false,
        format: "full",
      },
      {
        mapData: {
          [eventName]: {
            "1日目マップ": dayMap,
          },
        },
      },
    );
    const exportBuffer = await readBlobAsArrayBuffer(blob);
    const file = {
      name: "current-full-export.xlsx",
      arrayBuffer: async () => exportBuffer,
    } as File;

    const importResult = await importFromXlsx(file);
    const imported = toImportedEventData(importResult);

    expect(importResult.success).toBe(true);
    expect(imported.items[0]).toMatchObject({
      price: 700,
      catalogPrice: 900,
      remarks: "利用者メモ",
      sheetRemarks: "シート備考",
    });
    expect(imported.mapData?.["1日目マップ"]).toEqual(dayMap);

    await db.saveMapDataChanges(
      {},
      {
        [eventName]: imported.mapData!,
      },
    );

    const stored = await loadStoredMapData();
    expect(stored[eventName]["1日目マップ"]).toEqual(dayMap);
  });
});

describe("db.loadMapData", () => {
  it("reports an error after both IndexedDB reads fail without a legacy fallback", async () => {
    localStorage.removeItem("mapData");
    const firstError = new DOMException("first read failed", "UnknownError");
    const retryError = new DOMException("retry read failed", "UnknownError");
    const transactionSpy = mockMapReadFailures([firstError, retryError]);

    const result = await db.loadMapData();

    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: "error",
      data: null,
      error: retryError,
    });
  });

  it("keeps the legacy localStorage fallback after both IndexedDB reads fail", async () => {
    const eventName = "旧localStorage読込イベント";
    localStorage.setItem(
      "mapData",
      JSON.stringify({
        [eventName]: {
          "1日目マップ": makeDayMap("legacy-local"),
        },
      } satisfies MapDataStore),
    );
    const transactionSpy = mockMapReadFailures([
      new DOMException("first read failed", "UnknownError"),
      new DOMException("retry read failed", "UnknownError"),
    ]);

    const result = await db.loadMapData();

    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.data?.[eventName]["1日目マップ"].cells[0].value).toBe(
      "legacy-local",
    );
  });
});
