import { describe, expect, it } from "vitest";
import type { CellData, MapDataStore } from "../types/map";
import {
  compactMapDataForStorage,
  expandMapDataFromStorage,
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
});
