import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
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

async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

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
        includeBlockDefinitions: false,
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
    const dayMap = makeDayMap("current-format");
    const item: ShoppingItem = {
      id: "current-export-item",
      circle: "現行形式サークル",
      eventDate: "1日目",
      block: "A",
      number: "01a",
      title: "現行形式頒布物",
      price: 700,
      purchaseStatus: "Purchased",
      quantity: 1,
      remarks: "",
    };
    const blob = await exportToXlsx(
      eventName,
      [item],
      {
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: true,
        includeBlockDefinitions: false,
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
