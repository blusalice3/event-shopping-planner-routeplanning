import { describe, expect, it } from "vitest";
import { DEFAULT_UI_VISIBILITY } from "../../hooks/useUIVisibilitySettings";
import type { FocusModeSessionState } from "../../types/focus";
import type { ShoppingItem } from "../../types/item";
import type { DayMapData, HallDefinition } from "../../types/map";
import {
  areFocusModeSessionStatesEqual,
  selectAppChromeVisibility,
  selectCurrentFocusSession,
  selectCurrentMapRotations,
  selectCurrentMapViewport,
  selectCurrentMode,
  selectHallExecuteCount,
  selectHallTotalItemCount,
  selectItemHallId,
  selectItemsInSameHallGroup,
  selectItemsInSameHallVisit,
  selectValidFocusSessionKeys,
} from "./appMapViewSelectors";

const item = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: id,
  eventDate: "1日目",
  block: "A",
  number: "01a",
  title: "",
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

const hall = (
  id: string,
  overrides: Partial<HallDefinition> = {},
): HallDefinition => ({
  id,
  name: id,
  vertices: [
    { row: 0, col: 0 },
    { row: 0, col: 10 },
    { row: 10, col: 10 },
    { row: 10, col: 0 },
  ],
  ...overrides,
});

const mapData: DayMapData = {
  maxRow: 20,
  maxCol: 20,
  cells: [],
  mergedCells: [],
  blocks: [
    {
      name: "A",
      startRow: 2,
      startCol: 2,
      endRow: 4,
      endCol: 4,
      numberCells: [],
    },
    {
      name: "B",
      startRow: 12,
      startCol: 12,
      endRow: 14,
      endCol: 14,
      numberCells: [],
    },
  ],
};

const focusState = (
  overrides: Partial<FocusModeSessionState> = {},
): FocusModeSessionState => ({
  phase: "normal",
  phaseIndex: 1,
  savedPhaseIndices: { normal: 1, postponed: 0, late: 0 },
  postponedItemIds: ["postponed"],
  lateItemIds: [],
  isCompleted: false,
  lastPurchaseChangeAt: null,
  ...overrides,
});

describe("appMapViewSelectors", () => {
  it("derives hall counts from the current map polygon and execute order", () => {
    const items = [
      item("inside"),
      item("outside", { block: "B" }),
      item("other-day", { eventDate: "2日目" }),
    ];
    const input = {
      hallId: "east",
      activeEventName: "event",
      activeEventDate: "1日目",
      isMapTab: true,
      currentMapData: mapData,
      currentHalls: [hall("east")],
      items,
      executeModeItems: { event: { "1日目": ["outside", "inside"] } },
    } as const;

    expect(selectHallExecuteCount(input)).toBe(1);
    expect(selectHallTotalItemCount(input)).toBe(1);
    expect(selectHallExecuteCount({ ...input, activeEventName: null })).toBe(0);
  });

  it("resolves manual, polygon, and block-name fallback halls in precedence order", () => {
    const mapless = hall("mapless", { vertices: [], blockNames: ["B"] });
    const halls = [hall("polygon"), hall("manual"), mapless];

    expect(
      selectItemHallId({
        item: item("manual-item", { manualHallId: "manual" }),
        halls,
        mapData,
      }),
    ).toBe("manual");
    expect(
      selectItemHallId({ item: item("polygon-item"), halls, mapData }),
    ).toBe("polygon");
    expect(
      selectItemHallId({
        item: item("fallback-item", { block: "B" }),
        halls,
        mapData: null,
      }),
    ).toBe("mapless");
  });

  it("keeps hall-group and same-space visit relationships distinct", () => {
    const items = [
      item("first"),
      item("same-visit", { number: "01a2" }),
      item("same-hall", { number: "02a" }),
      item("different-priority", { priorityLevel: "priority" }),
    ];
    const base = {
      firstItemId: "first",
      items,
      halls: [hall("polygon")],
      mapData,
    } as const;

    expect(
      selectItemsInSameHallVisit({ ...base, secondItemId: "same-visit" }),
    ).toBe(true);
    expect(
      selectItemsInSameHallVisit({ ...base, secondItemId: "same-hall" }),
    ).toBe(false);
    expect(
      selectItemsInSameHallGroup({ ...base, secondItemId: "same-hall" }),
    ).toBe(true);
    expect(
      selectItemsInSameHallGroup({
        ...base,
        secondItemId: "different-priority",
      }),
    ).toBe(false);
    expect(
      selectItemsInSameHallVisit({ ...base, secondItemId: "missing" }),
    ).toBe(true);
  });

  it("derives view mode and focus-session keys without mutating persisted state", () => {
    expect(
      selectCurrentMode({
        activeEventName: null,
        activeEventDate: "1日目",
        dayModes: {},
      }),
    ).toBe("execute");
    expect(
      selectCurrentMode({
        activeEventName: "event",
        activeEventDate: "1日目",
        dayModes: { event: { "1日目": "focus" } },
      }),
    ).toBe("focus");

    const state = focusState();
    expect(
      selectCurrentFocusSession({
        activeEventName: "event",
        activeEventDate: "1日目",
        focusModeSessions: { "event::1日目": state },
      }),
    ).toEqual({
      sessionKey: "event::1日目",
      resumeState: state,
      mapName: "1日目マップ",
    });
    expect([
      ...selectValidFocusSessionKeys({
        eventLists: {
          event: [item("one"), item("two", { eventDate: "2日目" })],
        },
      }),
    ]).toEqual(["event::1日目", "event::2日目"]);
    expect(areFocusModeSessionStatesEqual(state, structuredClone(state))).toBe(
      true,
    );
    expect(
      areFocusModeSessionStatesEqual(state, focusState({ phaseIndex: 2 })),
    ).toBe(false);
  });

  it("normalizes per-screen rotations, selects viewport, and honors visibility override", () => {
    expect(
      selectCurrentMapRotations({
        activeEventName: "event",
        isMapTab: true,
        currentMapTabName: "1日目マップ",
        currentFocusMapName: "1日目マップ",
        mapRotationSettings: {
          event: {
            "1日目マップ": {
              initialAngle: -1,
              mapTabAngle: 361,
              focusModeAngle: 89.6,
            },
          },
        },
      }),
    ).toEqual({
      mapTab: { initialAngle: 359, mapTabAngle: 1, focusModeAngle: 90 },
      focus: { initialAngle: 359, mapTabAngle: 1, focusModeAngle: 90 },
    });
    const viewport = { zoomLevel: 75, offsetX: 10, offsetY: -4 };
    expect(
      selectCurrentMapViewport({
        activeEventName: "event",
        isMapTab: true,
        currentMapTabName: "1日目マップ",
        mapViewportSettings: { event: { "1日目マップ": viewport } },
      }),
    ).toBe(viewport);

    const hidden = {
      ...DEFAULT_UI_VISIBILITY,
      focus_sp_mapOn: { header: false, tabBar: false },
    };
    expect(
      selectAppChromeVisibility({
        activeEventName: "event",
        currentMode: "focus",
        layoutMode: "smartphone",
        focusModeMapVisible: true,
        uiVisibilitySettings: hidden,
        uiVisibilityOverride: true,
        uiSettingsPanelOpen: false,
      }),
    ).toEqual({
      showHeaderBar: true,
      showTabBar: true,
      rawHideSomething: true,
    });
  });
});
