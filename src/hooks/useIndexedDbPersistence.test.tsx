// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizePersistenceFailure,
  useIndexedDbPersistence,
} from "./useIndexedDbPersistence";

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

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const isBeforeUnloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("normalizePersistenceFailure", () => {
  it.each([
    ["QuotaExceededError", "quota", "保存容量が不足", "JSONバックアップ"],
    ["SecurityError", "permission", "データ保存を許可", "サイトデータ"],
    ["NotAllowedError", "permission", "データ保存を許可", "サイトデータ"],
    ["DataCloneError", "data-clone", "保存できない形式", "問題のデータ"],
    ["InvalidStateError", "database", "保存領域に異常", "再読み込み"],
  ] as const)(
    "%s を利用者向けの原因分類へ変換する",
    (errorName, category, messagePart, actionPart) => {
      const error = Object.assign(new Error("browser detail"), {
        name: errorName,
      });

      const detail = normalizePersistenceFailure("mapData", error);

      expect(detail).toMatchObject({
        storeName: "mapData",
        category,
        errorCode: errorName,
        technicalMessage: "browser detail",
      });
      expect(detail.userMessage).toContain(messagePart);
      expect(detail.userMessage).toContain(actionPart);
    },
  );

  it("unknown例外の原因コードと技術メッセージを一行・上限内にする", () => {
    const detail = normalizePersistenceFailure("eventLists", {
      name: "Odd\nError!",
      message: `first line\r\nsecond line ${"x".repeat(300)}`,
    });

    expect(detail.category).toBe("unknown");
    expect(detail.errorCode).toBe("OddError");
    expect(detail.userMessage).toContain("予期しない問題");
    expect(detail.technicalMessage).not.toMatch(/[\r\n]/);
    expect(detail.technicalMessage?.length).toBeLessThanOrEqual(160);
    expect(detail.technicalMessage).toMatch(/…$/);
  });
});

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

  it("persists a purchase status changed immediately after initialization", async () => {
    const loadedEventLists: PersistedValues["eventLists"] = {
      テストイベント: [
        {
          id: "item-1",
          circle: "テストサークル",
          eventDate: "1日目",
          block: "A",
          number: "01",
          title: "テスト品",
          price: 1000,
          purchaseStatus: "None",
          quantity: 1,
          remarks: "",
        },
      ],
    };
    dbMock.loadEventLists.mockResolvedValue({
      status: "ok",
      data: loadedEventLists,
    });

    const setters = createSetters();
    const initialValues = createValues();
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);
    expect(result.current.isInitialized).toBe(true);
    expect(result.current.persistenceStatus).toBe("saved");

    const changedEventLists: PersistedValues["eventLists"] = {
      テストイベント: [
        {
          ...loadedEventLists.テストイベント[0],
          purchaseStatus: "Purchased",
        },
      ],
    };
    rerender({
      values: {
        ...initialValues,
        eventLists: changedEventLists,
      },
    });
    expect(result.current.persistenceStatus).toBe("unsaved");

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(1);
    expect(dbMock.saveEventLists).toHaveBeenCalledWith(changedEventLists);
    expect(result.current.persistenceStatus).toBe("saved");
    expect(result.current.failedStores).toEqual([]);
  });

  it("reports a mapData failure and retrySave immediately persists its latest value", async () => {
    const alertSpy = vi
      .spyOn(window, "alert")
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const setters = createSetters();
    const initialValues = createValues();
    dbMock.loadMapData.mockResolvedValue({
      status: "ok",
      data: initialValues.mapData,
    });
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
    expect(result.current.persistenceStatus).toBe("failed");
    expect(result.current.failedStores).toEqual(["mapData"]);
    expect(result.current.failureDetails).toEqual([
      expect.objectContaining({
        storeName: "mapData",
        category: "unknown",
        errorCode: "Error",
        technicalMessage: "mapData write failed",
      }),
    ]);
    const eventListSaveCountAfterFailure =
      dbMock.saveEventLists.mock.calls.length;

    const latestMapData: PersistedValues["mapData"] = {
      importedEvent: {
        "1日目": {
          maxRow: 0,
          maxCol: 0,
          cells: [],
          mergedCells: [],
          blocks: [],
        },
      },
    };
    const valuesAtRetry: PersistedValues = {
      ...valuesAfterImport,
      mapData: latestMapData,
    };
    rerender({ values: valuesAtRetry });
    expect(result.current.persistenceStatus).toBe("unsaved");

    await act(async () => {
      result.current.retrySave();
      await flushMicrotasks();
    });

    expect(dbMock.saveMapDataChanges).toHaveBeenCalledTimes(2);
    expect(dbMock.saveMapDataChanges).toHaveBeenLastCalledWith(
      {},
      latestMapData,
    );
    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(
      eventListSaveCountAfterFailure,
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(result.current.persistenceStatus).toBe("saved");
    expect(result.current.failedStores).toEqual([]);
    expect(result.current.failureDetails).toEqual([]);
  });

  it("keeps quota details through a failed retry and a failed restore", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setters = createSetters();
    const initialValues = createValues();
    const quotaError = Object.assign(
      new Error("quota exceeded\r\nwhile writing map data"),
      { name: "QuotaExceededError" },
    );
    dbMock.saveMapDataChanges.mockRejectedValue(quotaError);

    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const changedValues: PersistedValues = {
      ...initialValues,
      mapData: { 容量超過イベント: {} },
    };
    rerender({ values: changedValues });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.persistenceStatus).toBe("failed");
    expect(result.current.failedStores).toEqual(["mapData"]);
    expect(result.current.failureDetails).toEqual([
      expect.objectContaining({
        storeName: "mapData",
        category: "quota",
        errorCode: "QuotaExceededError",
        technicalMessage: "quota exceeded while writing map data",
      }),
    ]);

    await act(async () => {
      result.current.retrySave();
      await flushMicrotasks();
    });

    expect(dbMock.saveMapDataChanges).toHaveBeenCalledTimes(2);
    expect(result.current.persistenceStatus).toBe("failed");
    const detailsBeforeRestore = result.current.failureDetails;

    const restoreError = new Error("restore failed");
    let caughtRestoreError: unknown;
    await act(async () => {
      try {
        await result.current.runExclusiveRestore(initialValues, async () => {
          throw restoreError;
        });
      } catch (error) {
        caughtRestoreError = error;
      }
    });

    expect(caughtRestoreError).toBe(restoreError);
    expect(result.current.persistenceStatus).toBe("failed");
    expect(result.current.failedStores).toEqual(["mapData"]);
    expect(result.current.failureDetails).toEqual(detailsBeforeRestore);
  });

  it("warns before unload while unsaved, saving, or failed, then removes the warning after retry succeeds", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const setters = createSetters();
    const initialValues = createValues();
    const firstSave = createDeferred<void>();
    dbMock.saveEventLists
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);

    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);
    expect(result.current.persistenceStatus).toBe("saved");
    expect(isBeforeUnloadPrevented()).toBe(false);

    const changedValues: PersistedValues = {
      ...initialValues,
      eventLists: { テストイベント: [] },
    };
    rerender({ values: changedValues });

    expect(result.current.persistenceStatus).toBe("unsaved");
    expect(isBeforeUnloadPrevented()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(flushMicrotasks);

    expect(result.current.persistenceStatus).toBe("saving");
    expect(isBeforeUnloadPrevented()).toBe(true);

    const saveError = new Error("eventLists write failed");
    await act(async () => {
      firstSave.reject(saveError);
      await flushMicrotasks();
    });

    expect(result.current.persistenceStatus).toBe("failed");
    expect(result.current.failedStores).toEqual(["eventLists"]);
    expect(isBeforeUnloadPrevented()).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to save data to IndexedDB:",
      [{ label: "eventLists", error: saveError }],
    );

    await act(async () => {
      result.current.retrySave();
      await flushMicrotasks();
    });

    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(2);
    expect(result.current.persistenceStatus).toBe("saved");
    expect(result.current.failedStores).toEqual([]);
    expect(isBeforeUnloadPrevented()).toBe(false);
  });

  it("serializes saves and drains the newest snapshot after a slow save", async () => {
    const setters = createSetters();
    const initialValues = createValues();
    const firstSave = createDeferred<void>();
    dbMock.saveEventLists
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);

    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);
    expect(result.current.isInitialized).toBe(true);
    expect(result.current.persistenceStatus).toBe("saved");

    const unchangedEvent = [
      {
        id: "unchanged",
        circle: "変更なし",
        eventDate: "1日目",
        block: "B",
        number: "02",
        title: "対象外",
        price: 500,
        purchaseStatus: "None" as const,
        quantity: 1,
        remarks: "",
      },
    ];
    const firstEventLists: PersistedValues["eventLists"] = {
      対象イベント: [
        {
          ...unchangedEvent[0],
          id: "target",
          circle: "対象",
          number: "01",
          title: "保存1",
        },
      ],
      変更しないイベント: unchangedEvent,
    };
    rerender({
      values: {
        ...initialValues,
        eventLists: firstEventLists,
      },
    });
    expect(result.current.persistenceStatus).toBe("unsaved");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(flushMicrotasks);
    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(1);
    expect(dbMock.saveEventLists).toHaveBeenLastCalledWith(firstEventLists);
    expect(result.current.persistenceStatus).toBe("saving");

    const newestEventLists: PersistedValues["eventLists"] = {
      ...firstEventLists,
      対象イベント: [
        {
          ...firstEventLists.対象イベント[0],
          title: "保存2",
          remarks: "保存中に編集",
        },
      ],
    };
    rerender({
      values: {
        ...initialValues,
        eventLists: newestEventLists,
      },
    });
    expect(result.current.persistenceStatus).toBe("unsaved");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(flushMicrotasks);

    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(1);

    firstSave.resolve();
    await act(flushMicrotasks);

    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(2);
    expect(dbMock.saveEventLists).toHaveBeenLastCalledWith(newestEventLists);
    expect(dbMock.saveEventLists.mock.calls[1][0].変更しないイベント).toEqual(
      unchangedEvent,
    );
    expect(result.current.persistenceStatus).toBe("saved");
  });

  it("waits for an active save before restore and adopts the restored snapshot as the new baseline", async () => {
    const setters = createSetters();
    const initialValues = createValues();
    const activeSave = createDeferred<void>();
    dbMock.saveEventLists.mockImplementationOnce(() => activeSave.promise);

    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);

    const valuesBeingSaved: PersistedValues = {
      ...initialValues,
      eventLists: { 保存中イベント: [] },
    };
    rerender({ values: valuesBeingSaved });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(flushMicrotasks);
    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(1);

    const restoredValues: PersistedValues = {
      ...initialValues,
      eventLists: { 復元イベント: [] },
    };
    const restoreOperation = vi.fn().mockResolvedValue(undefined);
    let restorePromise!: Promise<void>;
    act(() => {
      restorePromise = result.current.runExclusiveRestore(
        restoredValues,
        restoreOperation,
      );
    });
    await act(flushMicrotasks);
    expect(restoreOperation).not.toHaveBeenCalled();

    await act(async () => {
      activeSave.resolve();
      await restorePromise;
    });
    expect(restoreOperation).toHaveBeenCalledTimes(1);

    rerender({ values: restoredValues });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(1);
    expect(result.current.persistenceStatus).toBe("saved");
    expect(result.current.failedStores).toEqual([]);
  });
});
