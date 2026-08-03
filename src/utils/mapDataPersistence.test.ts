import { describe, expect, it } from "vitest";
import type { CellData, MapDataStore } from "../types/map";
import {
  InvalidMapPayloadError,
  compactMapDataForStorage,
  expandMapDataFromStorage,
  normalizeMapDataForPersistence,
} from "./mapDataPersistence";

const emptyBorders = {
  top: null,
  right: null,
  bottom: null,
  left: null,
};

function makeCell(overrides: Partial<CellData> = {}): CellData {
  return {
    row: 1,
    col: 1,
    value: null,
    backgroundColor: null,
    fontColor: null,
    borders: emptyBorders,
    isMerged: false,
    isVerticalText: false,
    ...overrides,
  };
}

function makePersistedDayMap(overrides: Record<string, unknown> = {}) {
  return {
    maxRow: 1,
    maxCol: 1,
    cells: [],
    mergedCells: [],
    blocks: [],
    ...overrides,
  };
}

describe("mapDataPersistence", () => {
  it("prunes empty event maps to the same logical value as an empty store", () => {
    const withEmptyEvent: MapDataStore = {
      空イベント: {},
    };

    expect(compactMapDataForStorage(withEmptyEvent)).toEqual({});
    expect(expandMapDataFromStorage({ 空イベント: {} })).toEqual({});
    expect(normalizeMapDataForPersistence(withEmptyEvent)).toEqual({});
    expect(normalizeMapDataForPersistence({})).toEqual({});
  });

  it("omits empty default cells and restores persisted render cells on load", () => {
    const mapData: MapDataStore = {
      Event: {
        "1日目マップ": {
          sheetName: "1日目",
          maxRow: 2,
          maxCol: 2,
          cells: [
            makeCell(),
            makeCell({
              row: 2,
              col: 2,
              value: "A",
              backgroundColor: "#ffffff",
              fontColor: "#000000",
              borders: {
                ...emptyBorders,
                top: {
                  style: "thin",
                  color: "#111111",
                },
              },
              isMerged: true,
              mergeParent: {
                row: 2,
                col: 1,
              },
              isVerticalText: true,
            }),
          ],
          mergedCells: [],
          blocks: [
            {
              name: "A",
              startRow: 2,
              startCol: 2,
              endRow: 2,
              endCol: 2,
              numberCells: [{ row: 2, col: 2, value: 1 }],
            },
          ],
        },
      },
    };

    const compacted = compactMapDataForStorage(mapData);
    const compactedCells = (
      compacted.Event["1日目マップ"] as { cells: Record<string, unknown>[] }
    ).cells;

    expect(compactedCells).toHaveLength(1);
    expect(compactedCells[0].value).toBe("A");
    expect(compactedCells[0].borders).toEqual(
      mapData.Event["1日目マップ"].cells[1].borders,
    );

    expect(expandMapDataFromStorage(compacted)).toEqual({
      Event: {
        "1日目マップ": {
          ...mapData.Event["1日目マップ"],
          cells: [
            {
              ...mapData.Event["1日目マップ"].cells[1],
              backgroundColor: null,
            },
          ],
        },
      },
    });
  });

  it("normalizes XLSX-shaped cells to one stable persistence representation", () => {
    const xlsxShapedMapData: MapDataStore = {
      Event: {
        "1日目マップ": {
          sheetName: "1日目",
          rows: 2,
          cols: 2,
          maxRow: 2,
          maxCol: 2,
          cells: [
            makeCell({
              backgroundColor: "#FFFFFF",
              mergeParent: undefined,
            }),
            makeCell({
              row: 1,
              col: 2,
              value: "A-01",
              backgroundColor: "#ffffff",
              mergeParent: undefined,
            }),
            makeCell({
              row: 2,
              col: 1,
              backgroundColor: "#FFFFFF",
              mergeParent: undefined,
            }),
            makeCell({
              row: 2,
              col: 2,
              backgroundColor: "#FFFFFF",
              mergeParent: undefined,
            }),
          ],
          mergedCells: [],
          blocks: [
            {
              name: "A",
              startRow: 1,
              startCol: 1,
              endRow: 2,
              endCol: 2,
              numberCells: [{ row: 2, col: 1, value: 1 }],
            },
          ],
        },
      },
    };
    const alreadyNormalizedMapData: MapDataStore = {
      Event: {
        "1日目マップ": {
          sheetName: "1日目",
          rows: 2,
          cols: 2,
          maxRow: 2,
          maxCol: 2,
          cells: [
            makeCell({
              row: 1,
              col: 2,
              value: "A-01",
            }),
            makeCell({
              row: 2,
              col: 1,
            }),
          ],
          mergedCells: [],
          blocks: xlsxShapedMapData.Event["1日目マップ"].blocks,
        },
      },
    };

    const normalized = normalizeMapDataForPersistence(xlsxShapedMapData);

    expect(normalized).toEqual(alreadyNormalizedMapData);
    expect(normalized).toEqual(
      normalizeMapDataForPersistence(alreadyNormalizedMapData),
    );
    expect(normalizeMapDataForPersistence(normalized)).toEqual(normalized);
    expect(normalized.Event["1日目マップ"].cells).toHaveLength(2);
    expect(normalized.Event["1日目マップ"].cells[0]).not.toHaveProperty(
      "mergeParent",
    );
  });

  it.each([
    ["primitive root", 42],
    ["array root", []],
    ["Date root", new Date("2026-08-04T00:00:00.000Z")],
    ["primitive event", { Event: 42 }],
    ["array event", { Event: [] }],
    [
      "unknown cell field",
      {
        Event: {
          Day: makePersistedDayMap({
            cells: [{ row: 1, col: 1, futureField: "raw" }],
          }),
        },
      },
    ],
    [
      "unknown borders field",
      {
        Event: {
          Day: makePersistedDayMap({
            cells: [
              {
                row: 1,
                col: 1,
                borders: { futureField: "raw" },
              },
            ],
          }),
        },
      },
    ],
    [
      "invalid merge parent",
      {
        Event: {
          Day: makePersistedDayMap({
            cells: [
              {
                row: 1,
                col: 1,
                mergeParent: { row: 1, col: "1" },
              },
            ],
          }),
        },
      },
    ],
    [
      "invalid merged cell",
      {
        Event: {
          Day: makePersistedDayMap({
            mergedCells: [
              {
                startRow: 1,
                startCol: 1,
                endRow: 1,
                endCol: 1,
                value: Number.NaN,
              },
            ],
          }),
        },
      },
    ],
    [
      "invalid block nested cell",
      {
        Event: {
          Day: makePersistedDayMap({
            blocks: [
              {
                name: "A",
                startRow: 1,
                startCol: 1,
                endRow: 1,
                endCol: 1,
                numberCells: [{ row: 1, col: 1, value: "1" }],
              },
            ],
          }),
        },
      },
    ],
    [
      "unknown day field",
      {
        Event: {
          Day: makePersistedDayMap({ futureField: "raw" }),
        },
      },
    ],
  ])("rejects a %s before lossy normalization", (_label, invalidMapData) => {
    expect(() =>
      normalizeMapDataForPersistence(invalidMapData as MapDataStore),
    ).toThrow(InvalidMapPayloadError);
  });

  it("rejects sparse arrays and arrays with extra own properties", () => {
    const sparseCells = new Array(2);
    sparseCells[1] = { row: 1, col: 1, value: "raw" };
    const cellsWithExtraProperty = [{ row: 1, col: 1, value: "raw" }];
    Object.defineProperty(cellsWithExtraProperty, "futureField", {
      value: "raw",
      enumerable: true,
    });

    [sparseCells, cellsWithExtraProperty].forEach((cells) => {
      expect(() =>
        normalizeMapDataForPersistence({
          Event: {
            Day: makePersistedDayMap({ cells }),
          },
        } as MapDataStore),
      ).toThrow(InvalidMapPayloadError);
    });
  });

  it("preserves __proto__ as an own event and day name", () => {
    const mapData = JSON.parse(
      `{"__proto__":{"__proto__":${JSON.stringify(makePersistedDayMap())}}}`,
    ) as MapDataStore;

    const normalized = normalizeMapDataForPersistence(mapData);
    const compacted = compactMapDataForStorage(mapData);

    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        normalized["__proto__"],
        "__proto__",
      ),
    ).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(compacted, "__proto__")).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(compacted["__proto__"], "__proto__"),
    ).toBe(true);
  });
});
