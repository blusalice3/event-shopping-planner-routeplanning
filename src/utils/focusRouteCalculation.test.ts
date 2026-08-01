import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DayMapData, RouteSegment } from "../types/map";

vi.mock("./pathfinding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pathfinding")>();
  return {
    ...actual,
    generateRouteSegmentsStrict: vi.fn(),
  };
});

import { calculateStrictFocusRoute } from "./focusRouteCalculation";
import { generateRouteSegmentsStrict } from "./pathfinding";

const mockedGenerateRouteSegmentsStrict = vi.mocked(
  generateRouteSegmentsStrict,
);

const mapData: DayMapData = {
  sheetName: "Day1",
  maxRow: 5,
  maxCol: 5,
  cells: [],
  blocks: [],
  mergedCells: [],
};

const cell = (row: number, col: number) => ({
  row,
  col,
  key: `${row}-${col}`,
});

const segment: RouteSegment = {
  fromRow: 1,
  fromCol: 1,
  toRow: 3,
  toCol: 3,
  path: [
    { row: 1, col: 1 },
    { row: 1, col: 3 },
    { row: 3, col: 3 },
  ],
  fromOrder: 0,
  toOrder: 2,
};

describe("calculateStrictFocusRoute", () => {
  beforeEach(() => {
    mockedGenerateRouteSegmentsStrict.mockReset();
  });

  it("excludes a missing visit and connects the remaining visits in order", () => {
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: true,
      segments: [segment],
    });
    const locations = new Map([
      ["visit-a", cell(1, 1)],
      ["visit-c", cell(3, 3)],
    ]);

    const result = calculateStrictFocusRoute(
      mapData,
      ["visit-a", "visit-b", "visit-c"],
      locations,
    );

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledWith(mapData, [
      { row: 1, col: 1, itemId: "visit-a", order: 0 },
      { row: 3, col: 3, itemId: "visit-c", order: 2 },
    ]);
    expect(result.missingVisitKeys).toEqual(["visit-b"]);
    expect(result.segments).toEqual([
      {
        path: [
          { row: 1, col: 1 },
          { row: 1, col: 3 },
          { row: 3, col: 3 },
        ],
        segmentIndex: 0,
      },
    ]);
    expect(result.unreachable).toBe(false);
  });

  it("discards every partial segment when strict pathfinding fails", () => {
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: false,
      segments: [segment],
      failedSegment: {
        from: { row: 1, col: 1 },
        to: { row: 3, col: 3 },
        fromIndex: 0,
      },
    });

    const result = calculateStrictFocusRoute(
      mapData,
      ["visit-a", "visit-b"],
      new Map([
        ["visit-a", cell(1, 1)],
        ["visit-b", cell(3, 3)],
      ]),
    );

    expect(result.segments).toEqual([]);
    expect(result.unreachable).toBe(true);
  });

  it.each([
    { label: "zero", visitKeys: [] as string[] },
    { label: "one", visitKeys: ["visit-a"] },
  ])(
    "does not call pathfinding or report unreachable for $label valid visit(s)",
    ({ visitKeys }) => {
      const locations = new Map(
        visitKeys.map((visitKey) => [visitKey, cell(1, 1)]),
      );

      const result = calculateStrictFocusRoute(mapData, visitKeys, locations);

      expect(mockedGenerateRouteSegmentsStrict).not.toHaveBeenCalled();
      expect(result.segments).toEqual([]);
      expect(result.unreachable).toBe(false);
    },
  );
});
