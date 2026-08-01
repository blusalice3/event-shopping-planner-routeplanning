import { describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import {
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  type DayMapData,
} from "../../../types/map";
import { buildMapReimportPlan, type MapReimportState } from "./mapReimport";
import {
  cancelPendingMapImport,
  commitPreparedMapImport,
  dispatchPreparedMapImport,
  type MapImportCommitEffects,
  type PreparedMapImport,
} from "./mapImportFlow";

const dayMap = (sheetName: string): DayMapData => ({
  sheetName,
  maxRow: 2,
  maxCol: 2,
  cells: [],
  mergedCells: [],
  blocks: [
    {
      id: `block-${sheetName}`,
      name: "A",
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
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  manualHallId,
});

const createState = (eventDates = ["1日目"]): MapReimportState => ({
  eventLists: {
    対象イベント: eventDates.map((eventDate, index) =>
      item(`item-${index + 1}`, eventDate),
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

const prepareImport = (
  state: MapReimportState,
  eventDates = ["1日目"],
  skippedDays: string[] = [],
): PreparedMapImport => ({
  plan: buildMapReimportPlan({
    state,
    eventName: "対象イベント",
    targets: eventDates.map((eventDate) => ({
      eventDate,
      mapTabName: `${eventDate}マップ`,
      mapData: dayMap(`新しい${eventDate}`),
      initialAngle: 15,
    })),
  }),
  settings: structuredClone(DEFAULT_BLOCK_DETECTION_SETTINGS),
  skippedDays,
});

const createCommitEffects = (): MapImportCommitEffects & {
  [K in keyof MapImportCommitEffects]: ReturnType<typeof vi.fn>;
} => ({
  setEventLists: vi.fn(),
  setMapData: vi.fn(),
  setMapRotationSettings: vi.fn(),
  setRouteSettings: vi.fn(),
  setHallDefinitions: vi.fn(),
  setHallRouteSettings: vi.fn(),
  setMapViewportSettings: vi.fn(),
  saveBlockDetectionSettings: vi.fn(),
  activateTarget: vi.fn(),
  finishImport: vi.fn(),
  notify: vi.fn(),
});

describe("map import flow", () => {
  it("commits a first import immediately and preserves mapless halls", () => {
    const preparedImport = prepareImport(createState());
    const requestConfirmation = vi.fn();
    const commit = vi.fn();

    const result = dispatchPreparedMapImport(preparedImport, {
      requestConfirmation,
      commit,
    });

    expect(result).toBe("committed");
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(preparedImport, {
      preserveMaplessHalls: true,
    });
  });

  it("defers the whole file when one of multiple target days has existing state", () => {
    const state = createState(["1日目", "2日目"]);
    state.mapData = {
      対象イベント: {
        "2日目マップ": dayMap("既存2日目"),
      },
    };
    const before = structuredClone(state);
    const preparedImport = prepareImport(state, ["1日目", "2日目"]);
    const requestConfirmation = vi.fn();
    const commit = vi.fn();

    const result = dispatchPreparedMapImport(preparedImport, {
      requestConfirmation,
      commit,
    });

    expect(
      preparedImport.plan.targets.map(
        ({ requiresConfirmation }) => requiresConfirmation,
      ),
    ).toEqual([false, true]);
    expect(result).toBe("confirmation");
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).toHaveBeenCalledWith(preparedImport);
    expect(commit).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("applies state and saves settings exactly once after commit", () => {
    const state = createState();
    const preparedImport = prepareImport(state, ["1日目"], ["3日目"]);
    const effects = createCommitEffects();

    commitPreparedMapImport({
      state,
      preparedImport,
      options: { preserveMaplessHalls: true },
      effects,
    });

    expect(effects.setEventLists).not.toHaveBeenCalled();
    for (const effect of [
      effects.setMapData,
      effects.setMapRotationSettings,
      effects.setRouteSettings,
      effects.setHallDefinitions,
      effects.setHallRouteSettings,
      effects.setMapViewportSettings,
      effects.saveBlockDetectionSettings,
      effects.activateTarget,
      effects.finishImport,
      effects.notify,
    ]) {
      expect(effect).toHaveBeenCalledTimes(1);
    }
    expect(effects.setMapData.mock.calls[0][0]).toMatchObject({
      対象イベント: {
        "1日目マップ": {
          sheetName: "新しい1日目",
        },
      },
    });
    expect(effects.saveBlockDetectionSettings).toHaveBeenCalledWith(
      "対象イベント",
      preparedImport.settings,
    );
    expect(effects.activateTarget).toHaveBeenCalledWith(
      "対象イベント",
      "1日目マップ",
    );
    expect(effects.notify).toHaveBeenCalledWith(
      "1件のマップタブを取り込みました。\n3日目はないので取り込みしませんでした",
    );
  });

  it("keeps mapless halls, routes, and their manual assignments on a first import", () => {
    const state = createState();
    state.eventLists.対象イベント[0] = item("item-1", "1日目", "mapless-hall");
    state.hallDefinitions = {
      対象イベント: {
        "__mapless__:1日目": [
          {
            id: "mapless-hall",
            name: "手動会場",
            vertices: [],
            blockNames: ["手動"],
          },
        ],
      },
    };
    state.hallRouteSettings = {
      対象イベント: {
        "__mapless__:1日目": {
          hallOrder: ["mapless-hall"],
          hallVisitLists: [
            {
              hallId: "mapless-hall",
              itemIds: ["item-1"],
            },
          ],
        },
      },
    };
    const preparedImport = prepareImport(state);
    const effects = createCommitEffects();

    expect(preparedImport.plan.requiresConfirmation).toBe(false);

    commitPreparedMapImport({
      state,
      preparedImport,
      options: { preserveMaplessHalls: true },
      effects,
    });

    expect(effects.setEventLists).not.toHaveBeenCalled();
    expect(effects.setHallDefinitions.mock.calls[0][0]).toMatchObject({
      対象イベント: {
        "__mapless__:1日目": [
          {
            id: "mapless-hall",
          },
        ],
      },
    });
    expect(effects.setHallRouteSettings.mock.calls[0][0]).toMatchObject({
      対象イベント: {
        "__mapless__:1日目": {
          hallOrder: ["mapless-hall"],
        },
      },
    });
    expect(state.eventLists.対象イベント[0].manualHallId).toBe("mapless-hall");
  });

  it("clears a removable manual assignment only when a confirmed commit runs", () => {
    const state = createState();
    state.eventLists.対象イベント[0] = item("item-1", "1日目", "orphan-hall");
    const preparedImport = prepareImport(state);
    const effects = createCommitEffects();
    const commit = vi.fn((pendingImport, options) =>
      commitPreparedMapImport({
        state,
        preparedImport: pendingImport,
        options,
        effects,
      }),
    );

    dispatchPreparedMapImport(preparedImport, {
      requestConfirmation: vi.fn(),
      commit,
    });

    expect(commit).not.toHaveBeenCalled();
    expect(effects.setEventLists).not.toHaveBeenCalled();
    expect(effects.saveBlockDetectionSettings).not.toHaveBeenCalled();

    commitPreparedMapImport({
      state,
      preparedImport,
      options: { preserveMaplessHalls: true },
      effects,
    });

    expect(effects.setEventLists).toHaveBeenCalledTimes(1);
    expect(
      effects.setEventLists.mock.calls[0][0].対象イベント[0],
    ).not.toHaveProperty("manualHallId");
    expect(effects.saveBlockDetectionSettings).toHaveBeenCalledTimes(1);
  });

  it("cancel only clears pending import UI state", () => {
    const clearPendingImport = vi.fn();
    const clearPendingFile = vi.fn();
    const clearPendingEventName = vi.fn();

    cancelPendingMapImport({
      clearPendingImport,
      clearPendingFile,
      clearPendingEventName,
    });

    expect(clearPendingImport).toHaveBeenCalledTimes(1);
    expect(clearPendingFile).toHaveBeenCalledTimes(1);
    expect(clearPendingEventName).toHaveBeenCalledTimes(1);
  });
});
