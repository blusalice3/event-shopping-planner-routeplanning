import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { DayMapData, RouteSegment } from "../../types/map";
import type { MapRoutePoint } from "../../utils/mapRoutePoints";
import MapCanvas from "./MapCanvas";

const makeCanvasContext = () =>
  new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 8 }),
      getLineDash: () => [],
    },
    {
      get(target, prop: string) {
        if (prop in target) return target[prop as keyof typeof target];
        return vi.fn();
      },
      set(target, prop: string, value) {
        target[prop as keyof typeof target] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

const mapData: DayMapData = {
  maxRow: 5,
  maxCol: 5,
  cells: [
    {
      row: 2,
      col: 2,
      value: null,
      backgroundColor: null,
      borders: { top: null, right: null, bottom: null, left: null },
    },
  ],
  mergedCells: [],
  blocks: [
    {
      name: "A",
      startRow: 1,
      startCol: 1,
      endRow: 5,
      endCol: 5,
      numberCells: [{ row: 1, col: 1, value: 1 }],
    },
  ],
};

const routePoints: MapRoutePoint[] = [
  {
    itemId: "a",
    row: 1,
    col: 1,
    order: 0,
    priorityLevel: "none",
    groupKey: null,
    hallId: null,
    anchorLabel: "1. A の後",
  },
  {
    itemId: "b",
    row: 1,
    col: 3,
    order: 1,
    priorityLevel: "none",
    groupKey: null,
    hallId: null,
    anchorLabel: "2. B の後",
  },
];

const routeSegments: RouteSegment[] = [
  {
    fromRow: 1,
    fromCol: 1,
    toRow: 1,
    toCol: 3,
    path: [
      { row: 1, col: 1 },
      { row: 1, col: 3 },
    ],
    fromItemId: "a",
    toItemId: "b",
    fromOrder: 0,
    toOrder: 1,
  },
];

const renderCanvas = (
  overrides: Partial<React.ComponentProps<typeof MapCanvas>> = {},
) => {
  const props: React.ComponentProps<typeof MapCanvas> = {
    mapData,
    mapName: "Day1マップ",
    items: [],
    executeModeItemIds: [],
    zoomLevel: 100,
    isRouteVisible: false,
    onCellClick: vi.fn(),
    ...overrides,
  };

  const rendered = render(
    <div style={{ width: 280, height: 280 }}>
      <MapCanvas {...props} />
    </div>,
  );
  const canvas = rendered.container.querySelector("canvas");
  if (!canvas) throw new Error("canvas not found");
  return { ...rendered, canvas, props };
};

describe("MapCanvas route insert integration", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 280,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 280,
    });
    HTMLCanvasElement.prototype.getContext = vi.fn(() =>
      makeCanvasContext(),
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 280,
      bottom: 280,
      width: 280,
      height: 280,
      toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("short-circuits route insert marker taps before regular cell dispatch", async () => {
    const onRouteInsertHit = vi.fn();
    const onRouteInsertMiss = vi.fn();
    const onCellClick = vi.fn();
    const mapCellClick = vi.fn();
    window.addEventListener("mapCellClick", mapCellClick);

    const { canvas } = renderCanvas({
      routeInsertSelectionActive: true,
      forceRouteVisible: true,
      routePointsOverride: routePoints,
      routeSegmentsOverride: routeSegments,
      routeInsertMissMapDataOverride: mapData,
      onRouteInsertHit,
      onRouteInsertMiss,
      onCellClick,
      vertexSelectionMode: { clickedVertices: [{ row: 1, col: 1 }] },
      cellSelectionMode: { type: "test", clickedCells: [{ row: 1, col: 1 }] },
    });

    await waitFor(() => expect(canvas.width).toBe(280));
    fireEvent.click(canvas, { clientX: 14, clientY: 14 });

    expect(onRouteInsertHit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "marker", itemId: "a" }),
    );
    expect(onRouteInsertMiss).not.toHaveBeenCalled();
    expect(onCellClick).not.toHaveBeenCalled();
    expect(mapCellClick).not.toHaveBeenCalled();

    window.removeEventListener("mapCellClick", mapCellClick);
  });

  it("short-circuits route insert line taps before regular cell dispatch", async () => {
    const onRouteInsertHit = vi.fn();
    const onRouteInsertMiss = vi.fn();
    const onCellClick = vi.fn();
    const mapCellClick = vi.fn();
    window.addEventListener("mapCellClick", mapCellClick);

    const { canvas } = renderCanvas({
      routeInsertSelectionActive: true,
      forceRouteVisible: true,
      routePointsOverride: routePoints,
      routeSegmentsOverride: routeSegments,
      routeInsertMissMapDataOverride: mapData,
      onRouteInsertHit,
      onRouteInsertMiss,
      onCellClick,
      vertexSelectionMode: { clickedVertices: [{ row: 1, col: 2 }] },
      cellSelectionMode: { type: "test", clickedCells: [{ row: 1, col: 2 }] },
    });

    await waitFor(() => expect(canvas.width).toBe(280));
    fireEvent.click(canvas, { clientX: 42, clientY: 14 });

    expect(onRouteInsertHit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "line", fromItemId: "a" }),
    );
    expect(onRouteInsertMiss).not.toHaveBeenCalled();
    expect(onCellClick).not.toHaveBeenCalled();
    expect(mapCellClick).not.toHaveBeenCalled();

    window.removeEventListener("mapCellClick", mapCellClick);
  });

  it("hit tests route insert lines after rotated view coordinates are mapped back", async () => {
    const onRouteInsertHit = vi.fn();
    const onRouteInsertMiss = vi.fn();
    const onCellClick = vi.fn();

    const { canvas } = renderCanvas({
      rotationAngle: 90,
      routeInsertSelectionActive: true,
      forceRouteVisible: true,
      routePointsOverride: routePoints,
      routeSegmentsOverride: routeSegments,
      routeInsertMissMapDataOverride: mapData,
      onRouteInsertHit,
      onRouteInsertMiss,
      onCellClick,
    });

    await waitFor(() => expect(canvas.width).toBe(280));
    // Map point (42, 14), the line midpoint, rotates around the 5x5 map center (70, 70)
    // to view point (126, 42). The route hit must use toMapCoordinates before testing.
    fireEvent.click(canvas, { clientX: 126, clientY: 42 });

    expect(onRouteInsertHit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "line", fromItemId: "a" }),
    );
    expect(onRouteInsertMiss).not.toHaveBeenCalled();
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it("reports blank instead of falling back to display map data when the strict miss snapshot is absent", async () => {
    const onRouteInsertMiss = vi.fn();
    const onCellClick = vi.fn();

    const { canvas } = renderCanvas({
      routeInsertSelectionActive: true,
      forceRouteVisible: true,
      onRouteInsertMiss,
      onCellClick,
    });

    await waitFor(() => expect(canvas.width).toBe(280));
    fireEvent.click(canvas, { clientX: 42, clientY: 42 });

    expect(onRouteInsertMiss).toHaveBeenCalledWith({ kind: "blank" });
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it("classifies route insert misses from the strict snapshot only", async () => {
    const onRouteInsertMiss = vi.fn();

    const { canvas } = renderCanvas({
      routeInsertSelectionActive: true,
      forceRouteVisible: true,
      routeInsertMissMapDataOverride: mapData,
      onRouteInsertMiss,
    });

    await waitFor(() => expect(canvas.width).toBe(280));
    fireEvent.click(canvas, { clientX: 42, clientY: 42 });
    fireEvent.click(canvas, { clientX: 126, clientY: 126 });

    expect(onRouteInsertMiss).toHaveBeenNthCalledWith(1, { kind: "cell" });
    expect(onRouteInsertMiss).toHaveBeenNthCalledWith(2, { kind: "blank" });
  });
});
