// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIndexedDbPersistence } from "./useIndexedDbPersistence";

const dbMock = vi.hoisted(() => ({
  migrateFromLocalStorage: vi.fn(),
  loadEventLists: vi.fn(),
  loadEventMetadata: vi.fn(),
  loadExecuteModeItems: vi.fn(),
  loadDayModes: vi.fn(),
  loadMapData: vi.fn(),
  loadMapRotationSettings: vi.fn(),
  loadRouteSettings: vi.fn(),
  loadHallDefinitions: vi.fn(),
  loadHallRouteSettings: vi.fn(),
  loadMapViewportSettings: vi.fn(),
  saveEventLists: vi.fn(),
  saveEventMetadata: vi.fn(),
  saveExecuteModeItems: vi.fn(),
  saveDayModes: vi.fn(),
  saveMapDataChanges: vi.fn(),
  saveMapRotationSettings: vi.fn(),
  saveRouteSettings: vi.fn(),
  saveHallDefinitions: vi.fn(),
  saveHallRouteSettings: vi.fn(),
  saveMapViewportSettings: vi.fn(),
}));

vi.mock("../utils/indexedDB", () => ({
  db: dbMock,
}));

type HookParams = Parameters<typeof useIndexedDbPersistence>[0];
type PersistedValues = HookParams["values"];
type PersistedSetters = HookParams["setters"];

const createValues = (): PersistedValues => ({
  eventLists: {},
  eventMetadata: {},
  executeModeItems: {},
  dayModes: {},
  mapData: {},
  mapRotationSettings: {},
  routeSettings: {},
  hallDefinitions: {},
  hallRouteSettings: {},
  mapViewportSettings: {},
});

const createSetters = (): PersistedSetters => ({
  setEventLists: vi.fn(),
  setEventMetadata: vi.fn(),
  setExecuteModeItems: vi.fn(),
  setDayModes: vi.fn(),
  setMapData: vi.fn(),
  setMapRotationSettings: vi.fn(),
  setRouteSettings: vi.fn(),
  setHallDefinitions: vi.fn(),
  setHallRouteSettings: vi.fn(),
  setMapViewportSettings: vi.fn(),
});

const flushMicrotasks = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

describe("useIndexedDbPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const missing = { status: "missing" as const, data: null };
    dbMock.migrateFromLocalStorage.mockResolvedValue(false);
    dbMock.loadEventLists.mockResolvedValue(missing);
    dbMock.loadEventMetadata.mockResolvedValue(missing);
    dbMock.loadExecuteModeItems.mockResolvedValue(missing);
    dbMock.loadDayModes.mockResolvedValue(missing);
    dbMock.loadMapData.mockResolvedValue(missing);
    dbMock.loadMapRotationSettings.mockResolvedValue(missing);
    dbMock.loadRouteSettings.mockResolvedValue(missing);
    dbMock.loadHallDefinitions.mockResolvedValue(missing);
    dbMock.loadHallRouteSettings.mockResolvedValue(missing);
    dbMock.loadMapViewportSettings.mockResolvedValue(missing);

    dbMock.saveEventLists.mockResolvedValue(undefined);
    dbMock.saveEventMetadata.mockResolvedValue(undefined);
    dbMock.saveExecuteModeItems.mockResolvedValue(undefined);
    dbMock.saveDayModes.mockResolvedValue(undefined);
    dbMock.saveMapDataChanges.mockResolvedValue(undefined);
    dbMock.saveMapRotationSettings.mockResolvedValue(undefined);
    dbMock.saveRouteSettings.mockResolvedValue(undefined);
    dbMock.saveHallDefinitions.mockResolvedValue(undefined);
    dbMock.saveHallRouteSettings.mockResolvedValue(undefined);
    dbMock.saveMapViewportSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs a mapData save failure without alerting and retries that store on the next save", async () => {
    const alertSpy = vi
      .spyOn(window, "alert")
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const setters = createSetters();
    const initialValues = createValues();
    const saveError = new Error("mapData write failed");

    dbMock.saveMapDataChanges
      .mockRejectedValueOnce(saveError)
      .mockResolvedValueOnce(undefined);

    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);
    expect(result.current.isInitialized).toBe(true);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const changedMapData: PersistedValues["mapData"] = { importedEvent: {} };
    const valuesAfterImport: PersistedValues = {
      ...initialValues,
      mapData: changedMapData,
    };
    rerender({ values: valuesAfterImport });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(dbMock.saveMapDataChanges).toHaveBeenCalledTimes(1);
    expect(dbMock.saveMapDataChanges).toHaveBeenLastCalledWith(
      {},
      changedMapData,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to save data to IndexedDB:",
      [{ label: "mapData", error: saveError }],
    );
    expect(alertSpy).not.toHaveBeenCalled();

    const valuesAtNextSave: PersistedValues = {
      ...valuesAfterImport,
      eventLists: { importedEvent: [] },
    };
    rerender({ values: valuesAtNextSave });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(dbMock.saveMapDataChanges).toHaveBeenCalledTimes(2);
    expect(dbMock.saveMapDataChanges).toHaveBeenLastCalledWith(
      {},
      changedMapData,
    );
    expect(dbMock.saveEventLists).toHaveBeenCalledWith(
      valuesAtNextSave.eventLists,
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
