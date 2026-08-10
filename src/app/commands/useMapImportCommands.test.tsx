// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "react";
import type { ShoppingItem } from "../../types/item";
import {
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  type DayMapData,
} from "../../types/map";
import { buildMapReimportPlan } from "../../features/map/domain/mapReimport";
import type { PreparedMapImport } from "../../features/map/domain/mapImportFlow";
import {
  useMapImportCommands,
  type MapImportActionPort,
  type MapImportCommandPorts,
  type MapImportStatePort,
} from "./useMapImportCommands";

const EVENT = "対象イベント";
const DAY = "1日目";
const MAP_TAB = `${DAY}マップ`;

const item = (id: string, eventDate = DAY): ShoppingItem => ({
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
});

const dayMap = (sheetName: string, withBlocks = true): DayMapData => ({
  sheetName,
  maxRow: 2,
  maxCol: 2,
  cells: [],
  mergedCells: [],
  blocks: withBlocks
    ? [
        {
          id: `block-${sheetName}`,
          name: "A",
          startRow: 1,
          startCol: 1,
          endRow: 2,
          endCol: 2,
          numberCells: [],
        },
      ]
    : [],
});

const settings = structuredClone(DEFAULT_BLOCK_DETECTION_SETTINGS);

const baseState = (): MapImportStatePort => ({
  eventLists: { [EVENT]: [item("one")] },
  executeModeItems: {},
  mapData: {},
  mapRotationSettings: {},
  routeSettings: {},
  hallDefinitions: {},
  hallRouteSettings: {},
  mapViewportSettings: {},
  pendingEventName: EVENT,
  pendingReimport: null,
  mapViewActive: true,
});

const preparedImport = (state: MapImportStatePort): PreparedMapImport => ({
  plan: buildMapReimportPlan({
    state,
    eventName: EVENT,
    targets: [
      {
        eventDate: DAY,
        mapTabName: MAP_TAB,
        mapData: dayMap("replacement"),
        initialAngle: 15,
      },
    ],
  }),
  settings,
  skippedDays: [],
});

const createHarness = (stateOverrides: Partial<MapImportStatePort> = {}) => {
  const initialState = { ...baseState(), ...stateOverrides };
  const stores = {
    eventLists: initialState.eventLists,
    mapData: initialState.mapData,
    mapRotationSettings: initialState.mapRotationSettings,
    routeSettings: initialState.routeSettings,
    hallDefinitions: initialState.hallDefinitions,
    hallRouteSettings: initialState.hallRouteSettings,
    mapViewportSettings: initialState.mapViewportSettings,
    dialogOpen: false,
    pendingFile: null as File | null,
    pendingEventName: initialState.pendingEventName,
    pendingReimport: initialState.pendingReimport,
  };
  const setEventLists: MapImportActionPort["setEventLists"] = vi.fn((value) => {
    stores.eventLists = value;
  });
  const setMapData: MapImportActionPort["setMapData"] = vi.fn((value) => {
    stores.mapData = value;
  });
  const setMapRotationSettings: MapImportActionPort["setMapRotationSettings"] =
    vi.fn((value) => {
      stores.mapRotationSettings = value;
    });
  const setRouteSettings: MapImportActionPort["setRouteSettings"] = vi.fn(
    (value) => {
      stores.routeSettings = value;
    },
  );
  const setHallDefinitions: MapImportActionPort["setHallDefinitions"] = vi.fn(
    (value) => {
      stores.hallDefinitions = value;
    },
  );
  const setHallRouteSettings: MapImportActionPort["setHallRouteSettings"] =
    vi.fn((value) => {
      stores.hallRouteSettings = value;
    });
  const setMapViewportSettings: MapImportActionPort["setMapViewportSettings"] =
    vi.fn((value) => {
      stores.mapViewportSettings = value;
    });
  const openImport: MapImportActionPort["openImport"] = vi.fn(
    (file, eventName) => {
      stores.pendingFile = file;
      stores.pendingEventName = eventName;
      stores.dialogOpen = true;
      stores.pendingReimport = null;
    },
  );
  const requestReimport: MapImportActionPort["requestReimport"] = vi.fn(
    (prepared) => {
      stores.pendingReimport = prepared;
      stores.dialogOpen = false;
      stores.pendingFile = null;
    },
  );
  const closeImportDialog: MapImportActionPort["closeImportDialog"] = vi.fn(
    () => {
      stores.dialogOpen = false;
      stores.pendingFile = null;
      stores.pendingEventName = "";
    },
  );
  const cancelReimport: MapImportActionPort["cancelReimport"] = vi.fn(() => {
    stores.pendingReimport = null;
    stores.pendingFile = null;
    stores.pendingEventName = "";
  });
  const confirmReimport: MapImportActionPort["confirmReimport"] = vi.fn(() => {
    stores.pendingReimport = null;
    stores.pendingFile = null;
    stores.pendingEventName = "";
  });
  const commitApplicationSnapshotPatch = vi.fn(async () => undefined);
  const openEvent = vi.fn();
  const notify = vi.fn();
  const reportDiagnostic = vi.fn();
  const input = document.createElement("input");
  input.type = "file";
  const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
  const actions: MapImportActionPort = {
    setEventLists,
    setMapData,
    setMapRotationSettings,
    setRouteSettings,
    setHallDefinitions,
    setHallRouteSettings,
    setMapViewportSettings,
    openImport,
    requestReimport,
    closeImportDialog,
    cancelReimport,
    confirmReimport,
  };
  const ports: MapImportCommandPorts = {
    fileInput: { current: input },
    state: initialState,
    actions,
    settings: { commitApplicationSnapshotPatch },
    navigation: { openEvent },
    effects: { notify, reportDiagnostic },
  };

  return {
    ports,
    stores,
    input,
    spies: {
      click,
      setEventLists,
      setMapData,
      setMapRotationSettings,
      setRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
      setMapViewportSettings,
      openImport,
      requestReimport,
      closeImportDialog,
      cancelReimport,
      confirmReimport,
      commitApplicationSnapshotPatch,
      openEvent,
      notify,
      reportDiagnostic,
    },
  };
};

describe("useMapImportCommands", () => {
  it("owns file picker targeting and consumes one selected file", () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    act(() => result.current.requestFileSelection(EVENT));

    expect(harness.input.dataset.eventName).toBe(EVENT);
    expect(harness.spies.click).toHaveBeenCalledOnce();

    const file = new File(["xlsx"], "map.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const target = {
      files: [file],
      dataset: { eventName: EVENT },
      value: "C:\\fakepath\\map.xlsx",
    } as unknown as HTMLInputElement;

    act(() =>
      result.current.selectFile({ target } as ChangeEvent<HTMLInputElement>),
    );

    expect(harness.stores.pendingFile).toBe(file);
    expect(harness.stores.pendingEventName).toBe(EVENT);
    expect(harness.stores.dialogOpen).toBe(true);
    expect(target.value).toBe("");
  });

  it("commits a first import once through the domain flow and closes UI", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    await act(() =>
      result.current.prepareImport(
        {
          "１日目マップ": dayMap("one"),
          "3日目": dayMap("skipped"),
        },
        settings,
        { "１日目マップ": 450 },
      ),
    );

    expect(harness.stores.mapData[EVENT][MAP_TAB].sheetName).toBe("one");
    expect(
      harness.stores.mapRotationSettings[EVENT][MAP_TAB].initialAngle,
    ).toBe(90);
    expect(harness.spies.commitApplicationSnapshotPatch).toHaveBeenCalledOnce();
    expect(harness.spies.commitApplicationSnapshotPatch).toHaveBeenCalledWith(
      expect.any(Object),
      { eventName: EVENT, settings },
    );
    expect(harness.spies.openEvent).toHaveBeenCalledWith(EVENT, MAP_TAB, "map");
    expect(harness.stores.pendingReimport).toBeNull();
    expect(harness.stores.dialogOpen).toBe(false);
    expect(harness.stores.pendingFile).toBeNull();
    expect(harness.stores.pendingEventName).toBe("");
    expect(harness.spies.notify).toHaveBeenCalledWith(
      "1件のマップタブを取り込みました。\n3日目はないので取り込みしませんでした",
    );
    expect(harness.spies.reportDiagnostic).not.toHaveBeenCalled();
  });

  it("keeps every map slice unchanged when the atomic commit fails", async () => {
    const harness = createHarness();
    const before = structuredClone(harness.stores.mapData);
    harness.ports.settings.commitApplicationSnapshotPatch = vi.fn(async () => {
      throw new Error("transaction aborted");
    });
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    await act(() =>
      result.current.prepareImport({ [DAY]: dayMap("one") }, settings, {}),
    );

    expect(harness.stores.mapData).toEqual(before);
    expect(harness.spies.setMapData).not.toHaveBeenCalled();
    expect(harness.spies.setHallDefinitions).not.toHaveBeenCalled();
    expect(harness.spies.commitApplicationSnapshotPatch).not.toHaveBeenCalled();
    expect(harness.spies.openEvent).not.toHaveBeenCalled();
  });

  it("defers every mutation until destructive reimport confirmation", async () => {
    const existingMap = dayMap("existing");
    const harness = createHarness({
      mapData: { [EVENT]: { [MAP_TAB]: existingMap } },
    });
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    await act(() =>
      result.current.prepareImport({ [DAY]: dayMap("replacement") }, settings, {
        [DAY]: 30,
      }),
    );

    expect(harness.stores.pendingReimport?.plan.requiresConfirmation).toBe(
      true,
    );
    expect(harness.stores.mapData[EVENT][MAP_TAB]).toBe(existingMap);
    expect(harness.spies.setMapData).not.toHaveBeenCalled();
    expect(harness.spies.commitApplicationSnapshotPatch).not.toHaveBeenCalled();
    expect(harness.spies.openEvent).not.toHaveBeenCalled();
    expect(harness.stores.dialogOpen).toBe(false);
    expect(harness.stores.pendingFile).toBeNull();
    expect(harness.stores.pendingEventName).toBe(EVENT);
  });

  it("commits the exact pending plan with the reviewed reimport option", async () => {
    const currentState = baseState();
    currentState.mapData = { [EVENT]: { [MAP_TAB]: dayMap("existing") } };
    const pending = preparedImport(currentState);
    const harness = createHarness({
      ...currentState,
      pendingReimport: pending,
      mapViewActive: false,
    });
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    await act(() =>
      result.current.confirmReimport({ preserveMaplessHalls: false }),
    );

    expect(harness.stores.mapData[EVENT][MAP_TAB].sheetName).toBe(
      "replacement",
    );
    expect(harness.spies.commitApplicationSnapshotPatch).toHaveBeenCalledOnce();
    expect(harness.spies.openEvent).toHaveBeenCalledWith(
      EVENT,
      MAP_TAB,
      "list",
    );
    expect(harness.stores.pendingReimport).toBeNull();
  });

  it("rejects invalid prepared input without committing or closing retry state", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    await act(() =>
      result.current.prepareImport(
        { [DAY]: dayMap("invalid", false) },
        settings,
        {},
      ),
    );

    expect(harness.spies.setMapData).not.toHaveBeenCalled();
    expect(harness.spies.commitApplicationSnapshotPatch).not.toHaveBeenCalled();
    expect(harness.spies.closeImportDialog).not.toHaveBeenCalled();
    expect(harness.spies.reportDiagnostic).toHaveBeenCalledWith(
      "Map reimport planning failed (map-plan-failed).",
    );
    expect(harness.spies.notify).toHaveBeenCalledWith(
      "マップを取り込む準備に失敗しました。",
    );
  });

  it("closes an import with no matching event days and reports every skipped day", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    await act(() =>
      result.current.prepareImport(
        {
          "３日目マップ": dayMap("three"),
          "2日目": dayMap("two"),
        },
        settings,
        {},
      ),
    );

    expect(harness.spies.notify).toHaveBeenCalledWith(
      "2日目はないので取り込みしませんでした\n3日目はないので取り込みしませんでした",
    );
    expect(harness.stores.dialogOpen).toBe(false);
    expect(harness.stores.pendingFile).toBeNull();
    expect(harness.stores.pendingEventName).toBe("");
    expect(harness.spies.setMapData).not.toHaveBeenCalled();
  });

  it("cancels only pending reimport state while close owns import dialog state", () => {
    const currentState = baseState();
    const pending = preparedImport(currentState);
    const harness = createHarness({ pendingReimport: pending });
    const { result } = renderHook(() => useMapImportCommands(harness.ports));

    act(() => result.current.cancelReimport());

    expect(harness.stores.pendingReimport).toBeNull();
    expect(harness.stores.pendingFile).toBeNull();
    expect(harness.stores.pendingEventName).toBe("");
    expect(harness.spies.closeImportDialog).not.toHaveBeenCalled();
    expect(harness.spies.setMapData).not.toHaveBeenCalled();
    expect(harness.spies.commitApplicationSnapshotPatch).not.toHaveBeenCalled();

    act(() => result.current.closeImport());

    expect(harness.spies.closeImportDialog).toHaveBeenCalledOnce();
    expect(harness.spies.cancelReimport).toHaveBeenCalledOnce();
  });

  it("does nothing when a file, event binding, or pending plan is absent", async () => {
    const harness = createHarness({ pendingEventName: "" });
    Object.defineProperty(harness.ports.fileInput, "current", { value: null });
    const { result } = renderHook(() => useMapImportCommands(harness.ports));
    const target = {
      files: [],
      dataset: {},
      value: "",
    } as unknown as HTMLInputElement;

    await act(async () => {
      result.current.requestFileSelection(EVENT);
      result.current.selectFile({ target } as ChangeEvent<HTMLInputElement>);
      await result.current.prepareImport(
        { [DAY]: dayMap("one") },
        settings,
        {},
      );
      await result.current.confirmReimport({ preserveMaplessHalls: true });
    });

    expect(harness.spies.click).not.toHaveBeenCalled();
    expect(harness.spies.closeImportDialog).not.toHaveBeenCalled();
    expect(harness.spies.setMapData).not.toHaveBeenCalled();
    expect(harness.spies.notify).not.toHaveBeenCalled();
  });
});
