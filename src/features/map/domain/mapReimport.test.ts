import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import type {
  DayMapData,
  HallDefinition,
  VisitPoint,
} from "../../../types/map";
import {
  applyMapReimportPlan,
  buildMapReimportPlan,
  type MapReimportState,
} from "./mapReimport";

const dayMap = (sheetName: string, blockName: string): DayMapData => ({
  sheetName,
  maxRow: 10,
  maxCol: 10,
  cells: [],
  mergedCells: [],
  blocks: [
    {
      id: `block-${blockName}`,
      name: blockName,
      startRow: 1,
      startCol: 1,
      endRow: 2,
      endCol: 2,
      numberCells: [],
    },
  ],
});

const item = (
  id: string,
  eventDate: string,
  manualHallId?: string,
): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate,
  block: "A",
  number: "1",
  title: `商品${id}`,
  price: 1000,
  purchaseStatus: id === "target-map" ? "Purchased" : "None",
  quantity: 3,
  limitedPurchasedQuantity: id === "target-map" ? 2 : undefined,
  remarks: `利用者メモ${id}`,
  manualHallId,
});

const hall = (id: string): HallDefinition => ({
  id,
  name: id,
  vertices: [
    { row: 0, col: 0 },
    { row: 0, col: 2 },
    { row: 2, col: 2 },
    { row: 2, col: 0 },
  ],
});

const visit = (order: number): VisitPoint => ({
  row: order,
  col: order,
  blockName: "A",
  number: order,
  order,
  itemIds: [`item-${order}`],
});

const createState = (): MapReimportState & {
  unrelatedUiSetting: { mode: string };
} => ({
  eventLists: {
    対象イベント: [
      item("target-map", "1日目", "old-map-hall"),
      item("target-mapless", "1日目", "mapless-hall"),
      item("other-day", "2日目", "day2-hall"),
    ],
    別イベント: [item("other-event", "1日目", "other-event-hall")],
  },
  executeModeItems: {
    対象イベント: {
      "1日目": ["target-mapless", "target-map"],
      "2日目": ["other-day"],
    },
    別イベント: { "1日目": ["other-event"] },
  },
  mapData: {
    対象イベント: {
      "1日目マップ": dayMap("古い1日目", "OLD"),
      "2日目マップ": dayMap("古い2日目", "DAY2"),
    },
    別イベント: {
      "1日目マップ": dayMap("別イベント", "OTHER"),
    },
  },
  mapRotationSettings: {
    対象イベント: {
      "1日目マップ": {
        initialAngle: 10,
        mapTabAngle: 20,
        focusModeAngle: 30,
      },
      "2日目マップ": {
        initialAngle: 40,
        mapTabAngle: 50,
        focusModeAngle: 60,
      },
    },
    別イベント: {
      "1日目マップ": {
        initialAngle: 70,
        mapTabAngle: 80,
        focusModeAngle: 90,
      },
    },
  },
  routeSettings: {
    対象イベント: {
      "1日目マップ": {
        isRouteVisible: true,
        visitOrder: [visit(1), visit(2)],
      },
      "2日目マップ": {
        isRouteVisible: false,
        visitOrder: [visit(3)],
      },
    },
    別イベント: {
      "1日目マップ": {
        isRouteVisible: true,
        visitOrder: [visit(4)],
      },
    },
  },
  hallDefinitions: {
    対象イベント: {
      "1日目マップ": [hall("old-map-hall")],
      "__mapless__:1日目": [
        { ...hall("mapless-hall"), vertices: [], blockNames: ["手動"] },
      ],
      "2日目マップ": [hall("day2-hall")],
    },
    別イベント: {
      "1日目マップ": [hall("other-event-hall")],
    },
  },
  hallRouteSettings: {
    対象イベント: {
      "1日目マップ": {
        hallOrder: ["old-map-hall"],
        hallVisitLists: [{ hallId: "old-map-hall", itemIds: ["target-map"] }],
      },
      "__mapless__:1日目": {
        hallOrder: ["mapless-hall"],
        hallVisitLists: [
          { hallId: "mapless-hall", itemIds: ["target-mapless"] },
        ],
      },
      "2日目マップ": {
        hallOrder: ["day2-hall"],
        hallVisitLists: [{ hallId: "day2-hall", itemIds: ["other-day"] }],
      },
    },
    別イベント: {
      "1日目マップ": {
        hallOrder: ["other-event-hall"],
        hallVisitLists: [],
      },
    },
  },
  mapViewportSettings: {
    対象イベント: {
      "1日目マップ": { zoomLevel: 125, offsetX: 10, offsetY: 20 },
      "2日目マップ": { zoomLevel: 75, offsetX: 30, offsetY: 40 },
    },
    別イベント: {
      "1日目マップ": { zoomLevel: 50, offsetX: 50, offsetY: 60 },
    },
  },
  unrelatedUiSetting: { mode: "そのまま" },
});

const createEmptyMapState = (
  eventDates: string[] = ["1日目"],
): MapReimportState => ({
  eventLists: {
    対象イベント: eventDates.map((eventDate, index) =>
      item(`target-${index + 1}`, eventDate),
    ),
  },
  executeModeItems: {},
  mapData: {},
  mapRotationSettings: {},
  routeSettings: {},
  hallDefinitions: {},
  hallRouteSettings: {},
  mapViewportSettings: {},
});

const target = (eventDate = "1日目") => ({
  eventDate,
  mapTabName: `${eventDate}マップ`,
  mapData: dayMap(`新しい${eventDate}`, "NEW"),
  initialAngle: 0,
});

describe("map reimport", () => {
  it("replaces only the target map and resets only map-dependent state", () => {
    const state = createState();
    const before = structuredClone(state);
    const importedMap = dayMap("新しい1日目", "NEW");

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [
        {
          eventDate: "1日目",
          mapTabName: "1日目マップ",
          mapData: importedMap,
          initialAngle: -90,
        },
      ],
    });
    const next = applyMapReimportPlan(state, plan, {
      preserveMaplessHalls: true,
    });

    expect(state).toEqual(before);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.targets[0].requiresConfirmation).toBe(true);
    expect(plan.impact).toEqual({
      targetDayCount: 1,
      visitPointCount: 2,
      mapHallDefinitionCount: 1,
      manualAssignmentCount: 1,
      hallRouteDayCount: 1,
      viewportDayCount: 1,
      rotationDayCount: 1,
      maplessHallDefinitionCount: 1,
      maplessManualAssignmentCount: 1,
      maplessHallRouteDayCount: 1,
    });
    expect(next.mapData["対象イベント"]["1日目マップ"]).toEqual(importedMap);
    expect(next.mapData["対象イベント"]["2日目マップ"]).toEqual(
      before.mapData["対象イベント"]["2日目マップ"],
    );
    expect(next.mapData["別イベント"]).toEqual(before.mapData["別イベント"]);
    expect(next.routeSettings["対象イベント"]["1日目マップ"]).toEqual({
      isRouteVisible: true,
      visitOrder: [],
    });
    expect(next.routeSettings["対象イベント"]["2日目マップ"]).toEqual(
      before.routeSettings["対象イベント"]["2日目マップ"],
    );
    expect(next.routeSettings["別イベント"]).toEqual(
      before.routeSettings["別イベント"],
    );
    expect(next.mapRotationSettings["対象イベント"]["1日目マップ"]).toEqual({
      initialAngle: 270,
      mapTabAngle: 270,
      focusModeAngle: 270,
    });
    expect(next.mapRotationSettings["対象イベント"]["2日目マップ"]).toEqual(
      before.mapRotationSettings["対象イベント"]["2日目マップ"],
    );
    expect(next.mapViewportSettings["対象イベント"]["1日目マップ"]).toBe(
      undefined,
    );
    expect(next.mapViewportSettings["対象イベント"]["2日目マップ"]).toEqual(
      before.mapViewportSettings["対象イベント"]["2日目マップ"],
    );
    expect(next.hallDefinitions["対象イベント"]["1日目マップ"]).toBe(undefined);
    expect(next.hallDefinitions["対象イベント"]["__mapless__:1日目"]).toEqual(
      before.hallDefinitions["対象イベント"]["__mapless__:1日目"],
    );
    expect(next.hallRouteSettings["対象イベント"]["1日目マップ"]).toBe(
      undefined,
    );
    expect(next.hallRouteSettings["対象イベント"]["__mapless__:1日目"]).toEqual(
      before.hallRouteSettings["対象イベント"]["__mapless__:1日目"],
    );
    expect(next.eventLists["対象イベント"][0]).toEqual({
      ...before.eventLists["対象イベント"][0],
      manualHallId: undefined,
    });
    expect(next.eventLists["対象イベント"][0].purchaseStatus).toBe("Purchased");
    expect(next.eventLists["対象イベント"][0].limitedPurchasedQuantity).toBe(2);
    expect(next.eventLists["対象イベント"][1]).toEqual(
      before.eventLists["対象イベント"][1],
    );
    expect(next.eventLists["対象イベント"][2]).toEqual(
      before.eventLists["対象イベント"][2],
    );
    expect(next.eventLists["別イベント"]).toEqual(
      before.eventLists["別イベント"],
    );
    expect(next.executeModeItems).toBe(state.executeModeItems);
    expect(next.executeModeItems).toEqual(before.executeModeItems);
    expect(next.unrelatedUiSetting).toBe(state.unrelatedUiSetting);
  });

  it("also clears the target day's mapless state only when selected", () => {
    const state = createState();
    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [
        {
          eventDate: "1日目",
          mapTabName: "1日目マップ",
          mapData: dayMap("新しい1日目", "NEW"),
          initialAngle: 0,
        },
      ],
    });

    const next = applyMapReimportPlan(state, plan, {
      preserveMaplessHalls: false,
    });

    expect(next.hallDefinitions["対象イベント"]["__mapless__:1日目"]).toBe(
      undefined,
    );
    expect(next.hallRouteSettings["対象イベント"]["__mapless__:1日目"]).toBe(
      undefined,
    );
    expect(next.eventLists["対象イベント"][1].manualHallId).toBe(undefined);
    expect(next.hallDefinitions["対象イベント"]["2日目マップ"]).toEqual(
      state.hallDefinitions["対象イベント"]["2日目マップ"],
    );
  });

  it("keeps a manual assignment when the same hall ID still exists in a preserved mapless hall", () => {
    const state = createState();
    state.hallDefinitions["対象イベント"]["1日目マップ"] = [
      hall("shared-hall"),
    ];
    state.hallDefinitions["対象イベント"]["__mapless__:1日目"] = [
      { ...hall("shared-hall"), vertices: [], blockNames: ["手動"] },
      { ...hall("mapless-hall"), vertices: [], blockNames: ["手動"] },
    ];
    state.eventLists["対象イベント"][0].manualHallId = "shared-hall";

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [
        {
          eventDate: "1日目",
          mapTabName: "1日目マップ",
          mapData: dayMap("新しい1日目", "NEW"),
          initialAngle: 0,
        },
      ],
    });
    const next = applyMapReimportPlan(state, plan, {
      preserveMaplessHalls: true,
    });

    expect(plan.impact.manualAssignmentCount).toBe(0);
    expect(next.eventLists["対象イベント"][0].manualHallId).toBe("shared-hall");
  });

  it("会場定義からすでに消えた対象日の手動割り当ても解除する", () => {
    const state = createState();
    state.eventLists["対象イベント"][0].manualHallId = "already-missing-hall";

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [
        {
          eventDate: "1日目",
          mapTabName: "1日目マップ",
          mapData: dayMap("新しい1日目", "NEW"),
          initialAngle: 0,
        },
      ],
    });
    const next = applyMapReimportPlan(state, plan, {
      preserveMaplessHalls: true,
    });

    expect(plan.impact.manualAssignmentCount).toBe(1);
    expect(next.eventLists["対象イベント"][0].manualHallId).toBeUndefined();
    expect(next.eventLists["対象イベント"][1].manualHallId).toBe(
      "mapless-hall",
    );
    expect(next.eventLists["対象イベント"][2].manualHallId).toBe("day2-hall");
  });

  it("requires no confirmation when all map-dependent stores are empty", () => {
    const plan = buildMapReimportPlan({
      state: createEmptyMapState(),
      eventName: "対象イベント",
      targets: [target()],
    });

    expect(plan.targets[0].requiresConfirmation).toBe(false);
    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.impact.rotationDayCount).toBe(0);
  });

  it.each([
    [
      "mapData",
      (state: MapReimportState) => {
        state.mapData = {
          対象イベント: { "1日目マップ": dayMap("既存", "OLD") },
        };
      },
    ],
    [
      "mapRotationSettings",
      (state: MapReimportState) => {
        state.mapRotationSettings = {
          対象イベント: {
            "1日目マップ": {
              initialAngle: 0,
              mapTabAngle: 0,
              focusModeAngle: 0,
            },
          },
        };
      },
    ],
    [
      "routeSettings",
      (state: MapReimportState) => {
        state.routeSettings = {
          対象イベント: {
            "1日目マップ": { isRouteVisible: false, visitOrder: [] },
          },
        };
      },
    ],
    [
      "hallDefinitions",
      (state: MapReimportState) => {
        state.hallDefinitions = {
          対象イベント: { "1日目マップ": [] },
        };
      },
    ],
    [
      "hallRouteSettings",
      (state: MapReimportState) => {
        state.hallRouteSettings = {
          対象イベント: {
            "1日目マップ": { hallOrder: [], hallVisitLists: [] },
          },
        };
      },
    ],
    [
      "mapViewportSettings",
      (state: MapReimportState) => {
        state.mapViewportSettings = {
          対象イベント: {
            "1日目マップ": { zoomLevel: 100, offsetX: 0, offsetY: 0 },
          },
        };
      },
    ],
  ] as const)(
    "requires confirmation when only %s has the target key",
    (storeName, seedState) => {
      const state = createEmptyMapState();
      seedState(state);

      const plan = buildMapReimportPlan({
        state,
        eventName: "対象イベント",
        targets: [target()],
      });

      expect(plan.targets[0].requiresConfirmation).toBe(true);
      expect(plan.requiresConfirmation).toBe(true);
      expect(plan.impact.rotationDayCount).toBe(
        storeName === "mapRotationSettings" ? 1 : 0,
      );
    },
  );

  it("does not require confirmation for mapless state that will be preserved", () => {
    const state = createEmptyMapState();
    state.hallDefinitions = {
      対象イベント: {
        "__mapless__:1日目": [
          { ...hall("mapless-hall"), vertices: [], blockNames: ["手動"] },
        ],
      },
    };
    state.hallRouteSettings = {
      対象イベント: {
        "__mapless__:1日目": {
          hallOrder: ["mapless-hall"],
          hallVisitLists: [{ hallId: "mapless-hall", itemIds: ["target-1"] }],
        },
      },
    };
    state.eventLists["対象イベント"][0].manualHallId = "mapless-hall";

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [target()],
    });

    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.impact.manualAssignmentCount).toBe(0);
  });

  it("requires confirmation when an orphaned manual assignment will be removed", () => {
    const state = createEmptyMapState();
    state.eventLists["対象イベント"][0].manualHallId = "missing-hall";

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [target()],
    });

    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.impact.manualAssignmentCount).toBe(1);
  });

  it("ignores map state belonging only to another day or event", () => {
    const state = createEmptyMapState();
    state.mapData = {
      対象イベント: {
        "2日目マップ": dayMap("別日", "DAY2"),
      },
      別イベント: {
        "1日目マップ": dayMap("別イベント", "OTHER"),
      },
    };

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [target()],
    });

    expect(plan.requiresConfirmation).toBe(false);
  });

  it("requires one confirmation when any target day has existing state", () => {
    const state = createEmptyMapState(["1日目", "2日目"]);
    state.mapData = {
      対象イベント: {
        "2日目マップ": dayMap("既存2日目", "DAY2"),
      },
    };

    const plan = buildMapReimportPlan({
      state,
      eventName: "対象イベント",
      targets: [target("1日目"), target("2日目")],
    });

    expect(
      plan.targets.map(({ requiresConfirmation }) => requiresConfirmation),
    ).toEqual([false, true]);
    expect(plan.requiresConfirmation).toBe(true);
  });

  it("rejects an invalid plan before any state can be applied", () => {
    const state = createState();
    const emptyMap = { ...dayMap("空", "EMPTY"), blocks: [] };

    expect(() =>
      buildMapReimportPlan({
        state,
        eventName: "対象イベント",
        targets: [
          {
            eventDate: "1日目",
            mapTabName: "1日目マップ",
            mapData: emptyMap,
            initialAngle: 0,
          },
        ],
      }),
    ).toThrow("有効なブロックがない");
    expect(() =>
      buildMapReimportPlan({
        state,
        eventName: "対象イベント",
        targets: [
          {
            eventDate: "1日目",
            mapTabName: "1日目マップ",
            mapData: dayMap("新1", "A"),
            initialAngle: 0,
          },
          {
            eventDate: "1日目",
            mapTabName: "別名マップ",
            mapData: dayMap("新2", "B"),
            initialAngle: 0,
          },
        ],
      }),
    ).toThrow("1日につき1件");
  });
});
