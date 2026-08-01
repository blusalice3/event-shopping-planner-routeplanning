import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DayMapData,
  RoutePathConstraint,
  RouteSegment,
} from "../../types/map";
import type { MapRoutePoint } from "../../utils/mapRoutePoints";

vi.mock("../../utils/pathfinding", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/pathfinding")>();
  return {
    ...actual,
    generateRouteSegmentsStrict: vi.fn(),
  };
});

import { generateRouteSegmentsStrict } from "../../utils/pathfinding";
import {
  calculateRouteSegmentsPair,
  createRouteInsertMapSnapshots,
  haveEquivalentRouteGeneratorPoints,
} from "./mapViewRouteCalculations";

const mockedGenerateRouteSegmentsStrict = vi.mocked(
  generateRouteSegmentsStrict,
);

const mapData: DayMapData = {
  sheetName: "Day1",
  maxRow: 3,
  maxCol: 3,
  cells: [
    {
      row: 1,
      col: 1,
      value: 1,
      backgroundColor: "#fff",
      borders: {
        top: { style: "thin", color: "#000" },
        right: null,
        bottom: null,
        left: null,
      },
    },
  ],
  blocks: [
    {
      name: "A",
      startRow: 1,
      startCol: 1,
      endRow: 3,
      endCol: 3,
      numberCells: [
        { row: 1, col: 1, value: 1 },
        { row: 1, col: 3, value: 2 },
      ],
      nameCells: [{ row: 2, col: 1 }],
      cellGroups: [
        {
          type: "individual",
          cells: [
            { row: 1, col: 1 },
            { row: 1, col: 3 },
          ],
        },
      ],
    },
  ],
  mergedCells: [
    {
      startRow: 2,
      startCol: 1,
      endRow: 2,
      endCol: 2,
      value: "A",
    },
  ],
};

const routePoints: MapRoutePoint[] = [
  {
    itemId: "item-a",
    row: 1,
    col: 1,
    order: 0,
    priorityLevel: "highest",
    groupKey: "hall-a:highest",
    hallId: "hall-a",
    anchorLabel: "1. A",
  },
  {
    itemId: "item-b",
    row: 1,
    col: 3,
    order: 1,
    priorityLevel: "none",
    groupKey: "hall-a",
    hallId: "hall-a",
    anchorLabel: "2. B",
  },
];

const generatedSegment: RouteSegment = {
  fromRow: 1,
  fromCol: 1,
  toRow: 1,
  toCol: 3,
  path: [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 1, col: 3 },
  ],
  fromPriority: "highest",
  toPriority: "none",
  fromItemId: "item-a",
  toItemId: "item-b",
  fromOrder: 0,
  toOrder: 1,
};

describe("map view route segment calculation", () => {
  beforeEach(() => {
    mockedGenerateRouteSegmentsStrict.mockReset();
  });

  it("uses one strict calculation when both generators have identical inputs", () => {
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: true,
      segments: [generatedSegment],
    });

    const result = calculateRouteSegmentsPair({
      displayMapData: mapData,
      displayRoutePoints: routePoints,
      mapInsertMapData: mapData,
      mapInsertRoutePoints: routePoints.map((point) => ({ ...point })),
      mapInsertPathConstraint: undefined,
    });

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(1);
    expect(result.displayRouteSegments).toEqual(result.mapInsertRouteSegments);
    expect(result.displayRouteState).toBe("normal");
    expect(result.displayRouteSegments[0].path).toEqual([
      { row: 1, col: 1 },
      { row: 1, col: 3 },
    ]);
    expect(result.displayRouteSegments).not.toBe(result.mapInsertRouteSegments);
    expect(result.displayRouteSegments[0]).not.toBe(
      result.mapInsertRouteSegments[0],
    );
    expect(result.displayRouteSegments[0].path).not.toBe(
      result.mapInsertRouteSegments[0].path,
    );
    expect(result.displayRouteSegments[0].path[0]).not.toBe(
      result.mapInsertRouteSegments[0].path[0],
    );
  });

  it("matches the existing reachable-route results when sharing the strict calculation", async () => {
    const actualPathfinding = await vi.importActual<
      typeof import("../../utils/pathfinding")
    >("../../utils/pathfinding");
    mockedGenerateRouteSegmentsStrict.mockImplementation(
      actualPathfinding.generateRouteSegmentsStrict,
    );
    const reachableMapData: DayMapData = { ...mapData, cells: [] };

    const result = calculateRouteSegmentsPair({
      displayMapData: reachableMapData,
      displayRoutePoints: routePoints,
      mapInsertMapData: reachableMapData,
      mapInsertRoutePoints: routePoints.map((point) => ({ ...point })),
      mapInsertPathConstraint: undefined,
    });
    const expectedDisplay = actualPathfinding.generateRouteSegmentsStrict(
      reachableMapData,
      routePoints,
    );
    expect(expectedDisplay.ok).toBe(true);
    const expectedSegments = (
      expectedDisplay.ok ? expectedDisplay.segments : []
    ).map((segment) => ({
      ...segment,
      path: actualPathfinding.simplifyPath(segment.path),
    }));

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(1);
    expect(result.displayRouteSegments).toEqual(expectedSegments);
    expect(result.mapInsertRouteSegments).toEqual(expectedSegments);
    expect(result.displayRouteState).toBe("normal");
  });

  it("discards all display and insert segments when shared strict calculation fails", () => {
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: false,
      segments: [generatedSegment],
      failedSegment: {
        from: routePoints[0],
        to: routePoints[1],
        fromIndex: 0,
      },
    });

    const result = calculateRouteSegmentsPair({
      displayMapData: mapData,
      displayRoutePoints: routePoints,
      mapInsertMapData: mapData,
      mapInsertRoutePoints: routePoints.map((point) => ({ ...point })),
      mapInsertPathConstraint: undefined,
    });

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(1);
    expect(result.displayRouteSegments).toEqual([]);
    expect(result.mapInsertRouteSegments).toEqual([]);
    expect(result.displayRouteState).toBe("unreachable");
  });

  it("keeps separate calculations when map references differ", () => {
    const otherMapData = { ...mapData };
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: true,
      segments: [generatedSegment],
    });

    calculateRouteSegmentsPair({
      displayMapData: mapData,
      displayRoutePoints: routePoints,
      mapInsertMapData: otherMapData,
      mapInsertRoutePoints: routePoints,
      mapInsertPathConstraint: undefined,
    });

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(2);
  });

  it("keeps separate calculations when a path constraint exists", () => {
    const constraint: RoutePathConstraint = {
      isPathAllowed: () => true,
    };
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: true,
      segments: [generatedSegment],
    });

    calculateRouteSegmentsPair({
      displayMapData: mapData,
      displayRoutePoints: routePoints,
      mapInsertMapData: mapData,
      mapInsertRoutePoints: routePoints,
      mapInsertPathConstraint: constraint,
    });

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(2);
    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledWith(
      mapData,
      routePoints,
      { pathConstraint: constraint },
    );
  });

  it.each([
    {
      label: "neither route is needed",
      includeDisplayRoute: false,
      includeMapInsertRoute: false,
      strictCalls: 0,
      displayCount: 0,
      insertCount: 0,
      displayState: "idle" as const,
    },
    {
      label: "only the visible display route is needed",
      includeDisplayRoute: true,
      includeMapInsertRoute: false,
      strictCalls: 1,
      displayCount: 1,
      insertCount: 0,
      displayState: "normal" as const,
    },
    {
      label: "only map-insert validation is needed",
      includeDisplayRoute: false,
      includeMapInsertRoute: true,
      strictCalls: 1,
      displayCount: 0,
      insertCount: 1,
      displayState: "idle" as const,
    },
  ])(
    "skips unused A* work when $label",
    ({
      includeDisplayRoute,
      includeMapInsertRoute,
      strictCalls,
      displayCount,
      insertCount,
      displayState,
    }) => {
      mockedGenerateRouteSegmentsStrict.mockReturnValue({
        ok: true,
        segments: [generatedSegment],
      });

      const result = calculateRouteSegmentsPair({
        displayMapData: mapData,
        displayRoutePoints: routePoints,
        mapInsertMapData: mapData,
        mapInsertRoutePoints: routePoints,
        mapInsertPathConstraint: undefined,
        includeDisplayRoute,
        includeMapInsertRoute,
      });

      expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(
        strictCalls,
      );
      expect(result.displayRouteSegments).toHaveLength(displayCount);
      expect(result.mapInsertRouteSegments).toHaveLength(insertCount);
      expect(result.displayRouteState).toBe(displayState);
    },
  );

  it("does not report unreachable when fewer than two display points are valid", () => {
    const result = calculateRouteSegmentsPair({
      displayMapData: mapData,
      displayRoutePoints: routePoints.slice(0, 1),
      mapInsertMapData: null,
      mapInsertRoutePoints: [],
      includeDisplayRoute: true,
      includeMapInsertRoute: false,
    });

    expect(mockedGenerateRouteSegmentsStrict).not.toHaveBeenCalled();
    expect(result.displayRouteSegments).toEqual([]);
    expect(result.displayRouteState).toBe("normal");
  });

  it.each([
    ["row", { row: 2 }],
    ["col", { col: 2 }],
    ["priorityLevel", { priorityLevel: "priority" as const }],
    ["itemId", { itemId: "item-c" }],
    ["order", { order: 2 }],
  ])("does not share when route point %s differs", (_field, override) => {
    const changedPoints = routePoints.map((point, index) =>
      index === 1 ? { ...point, ...override } : { ...point },
    );
    mockedGenerateRouteSegmentsStrict.mockReturnValue({
      ok: true,
      segments: [generatedSegment],
    });

    calculateRouteSegmentsPair({
      displayMapData: mapData,
      displayRoutePoints: routePoints,
      mapInsertMapData: mapData,
      mapInsertRoutePoints: changedPoints,
      mapInsertPathConstraint: undefined,
    });

    expect(mockedGenerateRouteSegmentsStrict).toHaveBeenCalledTimes(2);
  });

  it("ignores route point fields that generators do not read", () => {
    const changedMetadata = routePoints.map((point) => ({
      ...point,
      groupKey: "different",
      hallId: "different",
      anchorLabel: "different",
    }));

    expect(
      haveEquivalentRouteGeneratorPoints(routePoints, changedMetadata),
    ).toBe(true);
  });
});

describe("route insert map snapshots", () => {
  it("clones one snapshot when canvas and miss maps are the same object", () => {
    const snapshots = createRouteInsertMapSnapshots(mapData, mapData);

    expect(snapshots.canvasMapDataAtStart).toBe(
      snapshots.routeInsertMissMapDataAtStart,
    );
    expect(snapshots.canvasMapDataAtStart).not.toBe(mapData);
    expect(snapshots.canvasMapDataAtStart.cells[0]).not.toBe(mapData.cells[0]);
    expect(snapshots.canvasMapDataAtStart.cells[0].borders).not.toBe(
      mapData.cells[0].borders,
    );
    expect(snapshots.canvasMapDataAtStart.blocks[0]).not.toBe(
      mapData.blocks[0],
    );
    expect(snapshots.canvasMapDataAtStart.blocks[0].numberCells[0]).not.toBe(
      mapData.blocks[0].numberCells[0],
    );
    expect(
      snapshots.canvasMapDataAtStart.blocks[0].cellGroups?.[0].cells?.[0],
    ).not.toBe(mapData.blocks[0].cellGroups?.[0].cells?.[0]);
    expect(snapshots.canvasMapDataAtStart.mergedCells[0]).not.toBe(
      mapData.mergedCells[0],
    );
  });

  it("keeps independent snapshots when source map objects differ", () => {
    const otherMapData: DayMapData = {
      ...mapData,
      cells: mapData.cells.map((cell) => ({ ...cell })),
    };

    const snapshots = createRouteInsertMapSnapshots(mapData, otherMapData);

    expect(snapshots.canvasMapDataAtStart).not.toBe(
      snapshots.routeInsertMissMapDataAtStart,
    );
    expect(snapshots.canvasMapDataAtStart).not.toBe(mapData);
    expect(snapshots.routeInsertMissMapDataAtStart).not.toBe(otherMapData);
  });
});
