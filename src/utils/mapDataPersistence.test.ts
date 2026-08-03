import { describe, expect, it } from "vitest";
import type { CellData, MapDataStore } from "../types/map";
import {
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

describe("mapDataPersistence", () => {
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
});
