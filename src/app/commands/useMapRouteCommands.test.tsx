// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExecuteModeItems, ShoppingItem } from "../../types/item";
import {
  getMaplessKey,
  type DayMapData,
  type HallDefinition,
  type HallRouteSettings,
} from "../../types/map";
import {
  useMapRouteCommands,
  type MapRouteActionPort,
  type MapRouteCommandPorts,
  type MapRouteStatePort,
} from "./useMapRouteCommands";

const EVENT = "イベントA";
const OTHER_EVENT = "イベントB";
const DAY_ONE = "1日目";
const DAY_TWO = "2日目";
const MAP_ONE = `${DAY_ONE}マップ`;
const MAP_TWO = `${DAY_TWO}マップ`;
const MAP_HALL = "map-hall";
const MAPLESS_HALL = "mapless-hall";

const shoppingItem = (
  id: string,
  manualHallId: string,
  eventDate = DAY_ONE,
): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate,
  block: "A",
  number: "1",
  title: `商品${id}`,
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  manualHallId,
});

const hall = (id: string): HallDefinition => ({
  id,
  name: id,
  vertices: [],
  blockNames: [],
});

const dayMap = (sheetName: string): DayMapData => ({
  sheetName,
  maxRow: 1,
  maxCol: 1,
  cells: [],
  mergedCells: [],
  blocks: [],
});

const mapRouteSettings = (): HallRouteSettings => ({
  hallOrder: [MAP_HALL],
  hallVisitLists: [{ hallId: MAP_HALL, itemIds: ["three", "one"] }],
});

const maplessRouteSettings = (): HallRouteSettings => ({
  hallOrder: [MAPLESS_HALL],
  hallVisitLists: [{ hallId: MAPLESS_HALL, itemIds: ["two"] }],
});

const baseState = (): MapRouteStatePort => ({
  activeEventName: EVENT,
  activeEventDate: DAY_ONE,
  isMapTab: true,
  currentMapTabName: MAP_ONE,
  currentFocusMapName: MAP_TWO,
  routeVisible: true,
  mapRotationSettings: {
    [EVENT]: {
      [MAP_ONE]: {
        initialAngle: 10,
        mapTabAngle: 370,
        focusModeAngle: 20,
      },
      [MAP_TWO]: {
        initialAngle: -5,
        mapTabAngle: 30,
        focusModeAngle: 721,
      },
    },
  },
  mapViewportSettings: {
    [EVENT]: {
      [MAP_ONE]: { zoomLevel: 100, offsetX: 4, offsetY: 5 },
    },
  },
  mapData: {
    [EVENT]: {
      [MAP_ONE]: dayMap("one"),
      [MAP_TWO]: dayMap("two"),
    },
  },
  hallDefinitions: {
    [EVENT]: {
      [MAP_ONE]: [hall(MAP_HALL)],
      [getMaplessKey(DAY_ONE)]: [hall(MAPLESS_HALL)],
    },
  },
  hallRouteSettings: {
    [EVENT]: {
      [MAP_ONE]: mapRouteSettings(),
      [getMaplessKey(DAY_ONE)]: maplessRouteSettings(),
      preserved: { hallOrder: ["preserved"], hallVisitLists: [] },
    },
  },
  executeModeItems: {
    [EVENT]: { [DAY_ONE]: ["one", "two", "three"] },
    [OTHER_EVENT]: { [DAY_ONE]: ["other"] },
  },
  items: [
    shoppingItem("one", MAP_HALL),
    shoppingItem("two", MAPLESS_HALL),
    shoppingItem("three", MAP_HALL),
  ],
});

const createHarness = (overrides: Partial<MapRouteStatePort> = {}) => {
  const state = { ...baseState(), ...overrides };
  const stores = {
    routeVisible: state.routeVisible,
    mapRotationSettings: state.mapRotationSettings,
    mapViewportSettings: state.mapViewportSettings,
    hallRouteSettings: state.hallRouteSettings,
    executeModeItems: state.executeModeItems,
  };
  const setRouteVisible: MapRouteActionPort["setRouteVisible"] = vi.fn(
    (value) => {
      stores.routeVisible = value;
    },
  );
  const setMapRotationSettings: MapRouteActionPort["setMapRotationSettings"] =
    vi.fn((updater) => {
      stores.mapRotationSettings = updater(stores.mapRotationSettings);
    });
  const setMapViewportSettings: MapRouteActionPort["setMapViewportSettings"] =
    vi.fn((updater) => {
      stores.mapViewportSettings = updater(stores.mapViewportSettings);
    });
  const setHallRouteSettings: MapRouteActionPort["setHallRouteSettings"] =
    vi.fn((updater) => {
      stores.hallRouteSettings = updater(stores.hallRouteSettings);
    });
  const updateExecuteModeItems: MapRouteActionPort["updateExecuteModeItems"] =
    vi.fn((updater) => {
      stores.executeModeItems = updater(stores.executeModeItems);
    });
  const getMapTabForDate = vi.fn((eventDate: string) =>
    eventDate === DAY_ONE ? MAP_ONE : eventDate === DAY_TWO ? MAP_TWO : null,
  );
  const actions: MapRouteActionPort = {
    setRouteVisible,
    setMapRotationSettings,
    setMapViewportSettings,
    setHallRouteSettings,
    updateExecuteModeItems,
  };
  const ports: MapRouteCommandPorts = {
    state,
    actions,
    selectors: { getMapTabForDate },
  };

  return {
    ports,
    stores,
    spies: {
      setRouteVisible,
      setMapRotationSettings,
      setMapViewportSettings,
      setHallRouteSettings,
      updateExecuteModeItems,
      getMapTabForDate,
    },
  };
};

describe("useMapRouteCommands", () => {
  it("projects normalized map/focus rotation, viewport, and merged route inputs", () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    expect(result.current.currentMapTabRotation).toEqual({
      initialAngle: 10,
      mapTabAngle: 10,
      focusModeAngle: 20,
    });
    expect(result.current.currentFocusMapRotation).toEqual({
      initialAngle: 355,
      mapTabAngle: 30,
      focusModeAngle: 1,
    });
    expect(result.current.currentMapTabViewport).toEqual({
      zoomLevel: 100,
      offsetX: 4,
      offsetY: 5,
    });
    expect(result.current.globalMapTabName).toBe(MAP_ONE);
    expect(result.current.globalHallRouteSettings.hallOrder).toEqual([
      MAP_HALL,
      MAPLESS_HALL,
    ]);
    expect(result.current.globalHallRouteSettings.hallVisitLists).toHaveLength(
      2,
    );
  });

  it("owns explicit and toggle route visibility commands", () => {
    const harness = createHarness({ routeVisible: true });
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => {
      result.current.setRouteVisibility(true);
      result.current.toggleRouteVisibility();
    });

    expect(harness.spies.setRouteVisible).toHaveBeenNthCalledWith(1, true);
    expect(harness.spies.setRouteVisible).toHaveBeenNthCalledWith(2, false);
  });

  it("normalizes map-tab rotation and preserves initial/focus angles", () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => result.current.updateMapTabRotation(450));

    expect(harness.stores.mapRotationSettings[EVENT][MAP_ONE]).toEqual({
      initialAngle: 10,
      mapTabAngle: 90,
      focusModeAngle: 20,
    });
    expect(harness.stores.mapRotationSettings[EVENT][MAP_TWO]).toBe(
      harness.ports.state.mapRotationSettings[EVENT][MAP_TWO],
    );
  });

  it("updates focus rotation independently and keeps no-op identity", () => {
    const state = baseState();
    state.mapRotationSettings[EVENT][MAP_TWO] = {
      initialAngle: 355,
      mapTabAngle: 30,
      focusModeAngle: 90,
    };
    const harness = createHarness(state);
    const before = harness.stores.mapRotationSettings;
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => result.current.updateFocusMapRotation(450));

    expect(harness.stores.mapRotationSettings).toBe(before);

    act(() => result.current.updateFocusMapRotation(-1));

    expect(
      harness.stores.mapRotationSettings[EVENT][MAP_TWO].focusModeAngle,
    ).toBe(359);
    expect(harness.stores.mapRotationSettings[EVENT][MAP_TWO].mapTabAngle).toBe(
      30,
    );
  });

  it("updates viewport once and preserves identity for equal coordinates", () => {
    const harness = createHarness();
    const before = harness.stores.mapViewportSettings;
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() =>
      result.current.updateMapViewport({
        zoomLevel: 100,
        offsetX: 4,
        offsetY: 5,
      }),
    );

    expect(harness.stores.mapViewportSettings).toBe(before);

    act(() =>
      result.current.updateMapViewport({
        zoomLevel: 125,
        offsetX: 8,
        offsetY: 9,
      }),
    );

    expect(harness.stores.mapViewportSettings[EVENT][MAP_ONE]).toEqual({
      zoomLevel: 125,
      offsetX: 8,
      offsetY: 9,
    });
  });

  it("updates only the active map hall-route input used for recalculation", () => {
    const harness = createHarness();
    const next: HallRouteSettings = {
      hallOrder: [`${MAP_HALL}:priority`, MAP_HALL],
      hallVisitLists: [{ hallId: `${MAP_HALL}:priority`, itemIds: ["one"] }],
    };
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => result.current.updateCurrentHallRouteSettings(next));

    expect(harness.stores.hallRouteSettings[EVENT][MAP_ONE]).toBe(next);
    expect(harness.stores.hallRouteSettings[EVENT].preserved).toBe(
      harness.ports.state.hallRouteSettings[EVENT].preserved,
    );
  });

  it("splits a reviewed global order into map and mapless stores", () => {
    const harness = createHarness();
    const settings: HallRouteSettings = {
      hallOrder: [MAPLESS_HALL, MAP_HALL, "undefined"],
      hallVisitLists: [
        { hallId: MAP_HALL, itemIds: ["one"] },
        { hallId: MAPLESS_HALL, itemIds: ["two"] },
        { hallId: "undefined", itemIds: ["missing"] },
      ],
    };
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => result.current.updateGlobalHallRouteSettings(settings));

    expect(harness.stores.hallRouteSettings[EVENT][MAP_ONE]).toEqual({
      hallOrder: [MAP_HALL, "undefined"],
      hallVisitLists: [{ hallId: MAP_HALL, itemIds: ["one"] }],
    });
    expect(
      harness.stores.hallRouteSettings[EVENT][getMaplessKey(DAY_ONE)],
    ).toEqual({
      hallOrder: [MAPLESS_HALL],
      hallVisitLists: [{ hallId: MAPLESS_HALL, itemIds: ["two"] }],
    });
    expect(harness.stores.hallRouteSettings[EVENT].preserved).toBe(
      harness.ports.state.hallRouteSettings[EVENT].preserved,
    );
  });

  it("reorders the execute list through hall and saved visit ordering", () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() =>
      result.current.reorderExecuteListByHallOrder([MAPLESS_HALL, MAP_HALL]),
    );

    expect(harness.stores.executeModeItems[EVENT][DAY_ONE]).toEqual([
      "two",
      "three",
      "one",
    ]);
    expect(harness.stores.executeModeItems[OTHER_EVENT][DAY_ONE]).toEqual([
      "other",
    ]);
  });

  it("keeps execute-store identity when the active day is empty", () => {
    const emptyExecuteModeItems: Record<string, ExecuteModeItems> = {
      [EVENT]: { [DAY_ONE]: [] },
    };
    const harness = createHarness({ executeModeItems: emptyExecuteModeItems });
    const before = harness.stores.executeModeItems;
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => result.current.reorderExecuteListByHallOrder([MAP_HALL]));

    expect(harness.stores.executeModeItems).toBe(before);
  });

  it("rejects map-bound updates outside an active map context", () => {
    const harness = createHarness({
      activeEventName: null,
      activeEventDate: "",
      isMapTab: false,
      currentMapTabName: null,
      currentFocusMapName: "",
    });
    const { result } = renderHook(() => useMapRouteCommands(harness.ports));

    act(() => {
      result.current.updateMapTabRotation(10);
      result.current.updateFocusMapRotation(10);
      result.current.updateMapViewport({
        zoomLevel: 100,
        offsetX: 0,
        offsetY: 0,
      });
      result.current.updateCurrentHallRouteSettings({
        hallOrder: [],
        hallVisitLists: [],
      });
      result.current.updateGlobalHallRouteSettings({
        hallOrder: [],
        hallVisitLists: [],
      });
      result.current.reorderExecuteListByHallOrder([]);
    });

    expect(harness.spies.setMapRotationSettings).not.toHaveBeenCalled();
    expect(harness.spies.setMapViewportSettings).not.toHaveBeenCalled();
    expect(harness.spies.setHallRouteSettings).not.toHaveBeenCalled();
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
  });
});
