import { describe, expect, it } from "vitest";
import type { CellData, DayMapData, HallDefinition } from "../types/map";
import { buildSelectedHallRouteMapData } from "./mapRouteMapData";

const cell = (row: number, col: number): CellData => ({
  row,
  col,
  value: null,
  backgroundColor: null,
  borders: { top: null, right: null, bottom: null, left: null },
});

const hall: HallDefinition = {
  id: "h1",
  name: "Hall 1",
  vertices: [
    { row: 1, col: 1 },
    { row: 1, col: 3 },
    { row: 3, col: 3 },
    { row: 3, col: 1 },
  ],
};

describe("buildSelectedHallRouteMapData", () => {
  it("filters strict map data without reviving outside number or merged cells", () => {
    const mapData: DayMapData = {
      maxRow: 4,
      maxCol: 4,
      cells: [cell(2, 2), cell(4, 4)],
      mergedCells: [
        { startRow: 4, startCol: 4, endRow: 4, endCol: 4, value: null },
      ],
      blocks: [
        {
          name: "A",
          startRow: 1,
          startCol: 1,
          endRow: 4,
          endCol: 4,
          numberCells: [
            { row: 2, col: 2, value: 1 },
            { row: 4, col: 4, value: 2 },
          ],
        },
      ],
    };

    const result = buildSelectedHallRouteMapData(mapData, hall);

    expect(result?.strictFilteredMapData.cells).toEqual([cell(2, 2)]);
    expect(result?.strictFilteredMapData.blocks[0].numberCells).toEqual([
      { row: 2, col: 2, value: 1 },
    ]);
    expect(result?.strictFilteredMapData.mergedCells).toEqual([]);
    expect(result?.hallConstrainedPathfindingMapData.maxRow).toBe(4);
  });

  it("keeps boundary number cells and retained merged-cell bounds in strict map data", () => {
    const mapData: DayMapData = {
      maxRow: 6,
      maxCol: 6,
      cells: [cell(1, 2), cell(2, 2), cell(5, 5)],
      mergedCells: [
        { startRow: 2, startCol: 2, endRow: 3, endCol: 3, value: null },
        { startRow: 3, startCol: 3, endRow: 4, endCol: 4, value: null },
      ],
      blocks: [
        {
          name: "A",
          startRow: 1,
          startCol: 1,
          endRow: 6,
          endCol: 6,
          numberCells: [
            { row: 1, col: 2, value: 1 },
            { row: 5, col: 5, value: 2 },
          ],
        },
      ],
    };

    const result = buildSelectedHallRouteMapData(mapData, hall);

    expect(result?.strictFilteredMapData.blocks[0].numberCells).toContainEqual({
      row: 1,
      col: 2,
      value: 1,
    });
    expect(
      result?.strictFilteredMapData.blocks[0].numberCells,
    ).not.toContainEqual({
      row: 5,
      col: 5,
      value: 2,
    });
    expect(result?.strictFilteredMapData.mergedCells).toEqual([
      { startRow: 2, startCol: 2, endRow: 3, endCol: 3, value: null },
    ]);
    expect(result?.strictFilteredMapData.maxRow).toBe(3);
    expect(result?.strictFilteredMapData.maxCol).toBe(3);
  });

  it("returns null for missing or invalid selected hall route contexts", () => {
    const mapData: DayMapData = {
      maxRow: 4,
      maxCol: 4,
      cells: [cell(2, 2)],
      mergedCells: [],
      blocks: [],
    };

    expect(buildSelectedHallRouteMapData(mapData, undefined)).toBeNull();
    expect(
      buildSelectedHallRouteMapData(mapData, {
        ...hall,
        vertices: [
          { row: 1, col: 1 },
          { row: 1, col: 3 },
          { row: 3, col: 3 },
        ],
      }),
    ).toBeNull();
  });

  it("blocks outside-hall cells for pathfinding while preserving full map bounds", () => {
    const mapData: DayMapData = {
      maxRow: 4,
      maxCol: 4,
      cells: [cell(2, 2)],
      mergedCells: [],
      blocks: [],
    };

    const result = buildSelectedHallRouteMapData(mapData, hall);

    expect(result?.hallConstrainedPathfindingMapData.maxRow).toBe(4);
    expect(result?.hallConstrainedPathfindingMapData.maxCol).toBe(4);
    expect(result?.hallConstrainedPathfindingMapData.cells).toContainEqual(
      expect.objectContaining({
        row: 4,
        col: 4,
        backgroundColor: "#000000",
      }),
    );
    expect(result?.hallConstrainedPathfindingMapData.cells).toContainEqual(
      cell(2, 2),
    );
  });

  it("rejects route paths whose segment leaves the selected hall polygon", () => {
    const concaveHall: HallDefinition = {
      id: "concave",
      name: "Concave",
      vertices: [
        { row: 1, col: 1 },
        { row: 1, col: 5 },
        { row: 3, col: 5 },
        { row: 3, col: 3 },
        { row: 5, col: 3 },
        { row: 5, col: 1 },
      ],
    };
    const mapData: DayMapData = {
      maxRow: 5,
      maxCol: 5,
      cells: [],
      mergedCells: [],
      blocks: [],
    };

    const result = buildSelectedHallRouteMapData(mapData, concaveHall);

    expect(
      result?.routePathConstraint.isPathAllowed([
        { row: 2, col: 2 },
        { row: 4, col: 4 },
      ]),
    ).toBe(false);
    expect(
      result?.routePathConstraint.isPathAllowed([
        { row: 1, col: 2 },
        { row: 1, col: 4 },
      ]),
    ).toBe(true);
  });
});
