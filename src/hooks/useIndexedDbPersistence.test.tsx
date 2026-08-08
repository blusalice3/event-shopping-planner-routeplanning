// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizePersistenceFailure,
  useIndexedDbPersistence,
} from "./useIndexedDbPersistence";
import {
  getPersistenceReleaseAMetricsSnapshot,
  resetPersistenceReleaseAMetrics,
} from "../utils/persistenceReleaseAMetrics";

const dbMock = vi.hoisted(() => ({
  adoptRecoveryCandidate: vi.fn(),
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
  loadSyncQueue: vi.fn(),
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
    [
      "QuotaExceededError",
      "quota",
      "storage-quota-exceeded",
      "保存容量が不足",
      "JSONバックアップ",
    ],
    [
      "SecurityError",
      "permission",
      "storage-permission-denied",
      "データ保存を許可",
      "サイトデータ",
    ],
    [
      "NotAllowedError",
      "permission",
      "storage-permission-denied",
      "データ保存を許可",
      "サイトデータ",
    ],
    [
      "DataCloneError",
      "data-clone",
      "storage-data-clone-failed",
      "保存できない形式",
      "問題のデータ",
    ],
    [
      "PersistenceConflict",
      "conflict",
      "storage-conflict",
      "競合を検出",
      "他のタブを閉じ",
    ],
    [
      "InvalidStateError",
      "database",
      "indexeddb-operation-failed",
      "保存領域に異常",
      "再読み込み",
    ],
    [
      "IndexedDBOpenBlocked",
      "database",
      "indexeddb-operation-failed",
      "保存領域に異常",
      "再読み込み",
    ],
  ] as const)(
    "%s を利用者向けの原因分類へ変換する",
    (errorName, category, errorCode, messagePart, actionPart) => {
      const error = Object.assign(new Error("browser detail"), {
        name: errorName,
      });

      const detail = normalizePersistenceFailure("mapData", error);

      expect(detail).toMatchObject({
        storeName: "mapData",
        category,
        errorCode,
        technicalMessage: null,
      });
      expect(detail.userMessage).toContain(messagePart);
      expect(detail.userMessage).toContain(actionPart);
    },
  );

  it("unknown例外の利用者由来メッセージを公開せず閉じた原因コードへ変換する", () => {
    const detail = normalizePersistenceFailure("eventLists", {
      name: "Odd\nError!",
      message: `first line\r\nsecond line ${"x".repeat(300)}`,
    });

    expect(detail.category).toBe("unknown");
    expect(detail.errorCode).toBe("persistence-operation-failed");
    expect(detail.userMessage).toContain("予期しない問題");
    expect(detail.technicalMessage).toBeNull();
  });
});

describe("useIndexedDbPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    resetPersistenceReleaseAMetrics();

    const missing = { status: "missing" as const, data: null };
    dbMock.migrateFromLocalStorage.mockResolvedValue({
      status: "not-needed",
    });
    dbMock.adoptRecoveryCandidate.mockResolvedValue({
      status: "adopted",
    });
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
    dbMock.loadSyncQueue.mockResolvedValue(missing);

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

  it("StrictModeのeffect再実行でも初期化をsingle-flightに保つ", async () => {
    const migration = createDeferred<{ status: "not-needed" }>();
    dbMock.migrateFromLocalStorage.mockReturnValueOnce(migration.promise);
    const setters = createSetters();
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(
      () =>
        useIndexedDbPersistence({
          values: createValues(),
          setters,
          saveDelayMs: 1,
        }),
      { wrapper },
    );

    expect(dbMock.migrateFromLocalStorage).toHaveBeenCalledTimes(1);
    migration.resolve({ status: "not-needed" });
    await act(flushMicrotasks);

    expect(result.current.startupState.status).toBe("ready");
    expect(dbMock.migrateFromLocalStorage).toHaveBeenCalledTimes(1);
    expect(dbMock.loadSyncQueue).toHaveBeenCalledTimes(1);
    expect(getPersistenceReleaseAMetricsSnapshot().counters.startup.ready).toBe(
      1,
    );
    Object.values(setters).forEach((setter) => {
      expect(setter).toHaveBeenCalledTimes(1);
    });
  });

  it("IDB open blocked timeoutをdatabase分類し、recovery表示はprivacy-safeな固定文言に保つ", async () => {
    dbMock.migrateFromLocalStorage.mockRejectedValueOnce(
      Object.assign(new Error("秘密のdatabase path"), {
        name: "IndexedDBOpenBlocked",
      }),
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const setters = createSetters();
    const { result } = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters,
        saveDelayMs: 1,
      }),
    );

    await act(flushMicrotasks);

    expect(result.current.startupState).toMatchObject({
      status: "recovery-required",
      message: "保存データを安全に読み込めませんでした。",
      details: [
        "保存データの初期化中にエラーが発生しました。通常画面には反映していません。",
      ],
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "IndexedDB persistence initialization failed.",
      {
        storeName: "eventLists",
        category: "database",
        errorCode: "indexeddb-operation-failed",
      },
    );
    if (result.current.startupState.status !== "recovery-required") {
      throw new Error("Expected a recovery-required startup state.");
    }
    expect(result.current.startupState.message).not.toContain(
      "IndexedDBOpenBlocked",
    );
    expect(result.current.startupState.details.join(" ")).not.toContain(
      "秘密のdatabase path",
    );
    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });
  });

  it("初期化中にunmountした場合は後続のstate反映と自動保存を行わない", async () => {
    const migration = createDeferred<{ status: "not-needed" }>();
    dbMock.migrateFromLocalStorage.mockReturnValueOnce(migration.promise);
    const setters = createSetters();
    const { unmount } = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters,
        saveDelayMs: 1,
      }),
    );

    unmount();
    migration.resolve({ status: "not-needed" });
    await act(flushMicrotasks);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });
    expect(dbMock.saveEventLists).not.toHaveBeenCalled();
  });

  it("keeps setters and autosave disabled until a migration recovery is retried successfully", async () => {
    const recoveryBundle = {
      kind: "event-shopping-planner-persistence-recovery" as const,
      version: 1 as const,
      capturedAt: "2026-08-03T00:00:00.000Z",
      issues: [
        {
          stage: "migration",
          code: "LegacyConflict",
          message: "旧データとIndexedDBの内容が競合しています。",
        },
      ],
      candidates: [
        {
          id: "legacy-event-metadata",
          source: "legacy-localStorage" as const,
          storeName: "eventMetadata",
          key: "eventMetadata",
          rawValue: '{"イベント":{"source":"legacy"}}',
        },
      ],
    };
    dbMock.migrateFromLocalStorage
      .mockResolvedValueOnce({
        status: "recovery-required",
        recoveryBundle,
      })
      .mockResolvedValue({ status: "not-needed" });

    const setters = createSetters();
    const initialValues = createValues();
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);

    expect(result.current.isInitialized).toBe(false);
    expect(result.current.isUpdateBlocked()).toBe(true);
    await expect(result.current.flushPendingSave()).rejects.toThrow(
      "保存データの初期化が完了していません。",
    );
    expect(result.current.startupState).toMatchObject({
      status: "recovery-required",
      recoveryBundle,
      isRetrying: false,
    });
    expect(dbMock.loadEventLists).not.toHaveBeenCalled();
    expect(dbMock.loadSyncQueue).toHaveBeenCalledTimes(1);
    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });

    rerender({
      values: {
        ...initialValues,
        eventLists: { 操作禁止中の変更: [] },
      },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(dbMock.saveEventLists).not.toHaveBeenCalled();

    await act(async () => {
      result.current.retryInitialization();
      await flushMicrotasks();
    });

    expect(dbMock.migrateFromLocalStorage).toHaveBeenCalledTimes(2);
    expect(dbMock.loadSyncQueue).toHaveBeenCalledTimes(2);
    expect(result.current.startupState.status).toBe("ready");
    expect(result.current.isInitialized).toBe(true);
    Object.values(setters).forEach((setter) => {
      expect(setter).toHaveBeenCalledTimes(1);
    });
  });

  it("migration recoveryでもsyncQueueを走査し、両方の退避候補を同じbundleへ統合する", async () => {
    const migrationCandidate = {
      id: "legacy-migration-candidate",
      source: "legacy-localStorage" as const,
      role: "legacy-migration-source" as const,
      adoptable: false,
      storeName: "eventMetadata",
      key: "eventMetadata",
      sourceKey: "eventMetadata",
      rawValue: "legacy-raw",
    };
    const syncQueueCandidate = {
      id: "sync-queue-runtime-candidate",
      source: "runtime-fallback" as const,
      role: "app-payload" as const,
      adoptable: false,
      storeName: "syncQueue",
      key: "data",
      sourceKey: "esp:idb-fallback:v1:syncQueue:data:queue-branch",
      targetKey: "data",
      revision: "queue-branch",
      digest: "queue-digest",
      payload: [{ id: "queue-entry" }],
      rawValue: "queue-raw",
    };
    dbMock.migrateFromLocalStorage.mockResolvedValue({
      status: "recovery-required",
      recoveryBundle: {
        kind: "event-shopping-planner-persistence-recovery",
        version: 1,
        capturedAt: "2026-08-04T00:00:00.000Z",
        issues: [
          {
            stage: "migration",
            code: "LegacyConflict",
            message: "legacy conflict",
          },
        ],
        candidates: [migrationCandidate],
      },
    });
    dbMock.loadSyncQueue.mockResolvedValue({
      status: "conflict",
      data: null,
      error: Object.assign(new Error("syncQueue conflict"), {
        name: "PersistenceConflict",
      }),
      recoveryBundle: {
        kind: "event-shopping-planner-persistence-recovery",
        version: 1,
        capturedAt: "2026-08-04T00:00:01.000Z",
        issues: [
          {
            stage: "load",
            code: "PersistenceConflict",
            message: "syncQueue conflict",
            storeName: "syncQueue",
          },
        ],
        candidates: [syncQueueCandidate],
      },
    });
    const setters = createSetters();

    const { result } = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters,
        saveDelayMs: 1,
      }),
    );
    await act(flushMicrotasks);

    expect(result.current.startupState.status).toBe("recovery-required");
    if (result.current.startupState.status !== "recovery-required") {
      throw new Error("Expected merged migration recovery state.");
    }
    expect(
      result.current.startupState.recoveryBundle?.candidates.map(
        ({ sourceKey }) => sourceKey,
      ),
    ).toEqual([migrationCandidate.sourceKey, syncQueueCandidate.sourceKey]);
    expect(dbMock.loadEventLists).not.toHaveBeenCalled();
    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });
  });

  it("allows normal startup and autosave while verified legacy cleanup is deferred", async () => {
    dbMock.migrateFromLocalStorage.mockResolvedValue({
      status: "cleanup-pending",
      migratedKeys: ["eventLists"],
    });
    const setters = createSetters();
    const initialValues = createValues();
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);

    expect(result.current.startupState.status).toBe("ready");
    expect(result.current.isInitialized).toBe(true);
    expect(result.current.legacyCleanupStatus).toBe("deferred");

    const changedValues: PersistedValues = {
      ...initialValues,
      eventMetadata: {
        cleanup延期中: {
          spreadsheetUrl: "",
          spreadsheetSheetName: "1日目",
          lastImportDate: "2026-08-03T00:00:00.000Z",
        },
      },
    };
    rerender({ values: changedValues });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(dbMock.saveEventMetadata).toHaveBeenCalledWith(
      changedValues.eventMetadata,
    );
    expect(result.current.persistenceStatus).toBe("saved");
  });

  it("revalidates and adopts an explicitly selectable payload before restarting initialization", async () => {
    const candidate = {
      id: "esp-recovery-candidate:FNV-1A-64:0123456789abcdef:42",
      source: "indexedDB" as const,
      role: "app-payload" as const,
      adoptable: true,
      storeName: "eventMetadata",
      key: "data",
      sourceKey: "data",
      targetKey: "data",
      revision: "revision-2",
      digest: "a".repeat(64),
      digestAlgorithm: "SHA-256" as const,
      digestCanonicalization: "esp-json-v1" as const,
      payload: { 明示採用イベント: { generation: "selected" } },
    };
    const sameIdDifferentCandidate = {
      ...candidate,
      revision: "revision-1",
      digest: "c".repeat(64),
      payload: { 明示採用イベント: { generation: "not-selected" } },
    };
    const recoveryBundle = {
      kind: "event-shopping-planner-persistence-recovery" as const,
      version: 1 as const,
      capturedAt: "2026-08-03T00:00:00.000Z",
      issues: [
        {
          stage: "migration",
          code: "PersistenceConflict",
          message: "複数の候補があります。",
        },
      ],
      candidates: [sameIdDifferentCandidate, candidate],
    };
    dbMock.migrateFromLocalStorage
      .mockResolvedValueOnce({
        status: "recovery-required",
        recoveryBundle,
      })
      .mockResolvedValue({
        status: "cleanup-pending",
        migratedKeys: ["eventMetadata"],
        dataMigrationStatus: "verified",
        cleanupStatus: "deferred",
      });
    dbMock.loadEventMetadata.mockResolvedValue({
      status: "ok",
      data: candidate.payload,
    });
    const setters = createSetters();
    const { result } = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters,
        saveDelayMs: 1,
      }),
    );
    await act(flushMicrotasks);

    await act(async () => {
      await result.current.adoptRecoveryCandidate(candidate);
    });

    expect(dbMock.adoptRecoveryCandidate).toHaveBeenCalledWith(candidate);
    expect(dbMock.adoptRecoveryCandidate).not.toHaveBeenCalledWith(
      sameIdDifferentCandidate,
    );
    expect(dbMock.migrateFromLocalStorage).toHaveBeenCalledTimes(2);
    expect(result.current.startupState.status).toBe("ready");
    expect(result.current.isInitialized).toBe(true);
    expect(result.current.legacyCleanupStatus).toBe("deferred");
    expect(setters.setEventMetadata).toHaveBeenCalledWith(candidate.payload);
    expect(result.current.isAdoptingRecoveryCandidate).toBe(false);
    expect(result.current.recoveryAdoptionError).toBeNull();
  });

  it("keeps startup blocked and hides private error details when adoption evidence changes", async () => {
    const candidate = {
      id: "esp-recovery-candidate:FNV-1A-64:fedcba9876543210:42",
      source: "indexedDB" as const,
      role: "app-payload" as const,
      adoptable: true,
      storeName: "eventMetadata",
      key: "data",
      sourceKey: "data",
      targetKey: "data",
      revision: "revision-stale",
      digest: "b".repeat(64),
      digestAlgorithm: "SHA-256" as const,
      digestCanonicalization: "esp-json-v1" as const,
      payload: { 非公開イベント: { secret: "do-not-display" } },
    };
    const recoveryBundle = {
      kind: "event-shopping-planner-persistence-recovery" as const,
      version: 1 as const,
      capturedAt: "2026-08-03T00:00:00.000Z",
      issues: [
        {
          stage: "load",
          code: "PersistenceConflict",
          message: "候補の明示選択が必要です。",
        },
      ],
      candidates: [candidate],
    };
    dbMock.migrateFromLocalStorage.mockResolvedValue({
      status: "recovery-required",
      recoveryBundle,
    });
    const adoption = createDeferred<never>();
    dbMock.adoptRecoveryCandidate.mockReturnValueOnce(adoption.promise);
    const setters = createSetters();
    const { result } = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters,
        saveDelayMs: 1,
      }),
    );
    await act(flushMicrotasks);

    let adoptionPromise!: Promise<void>;
    act(() => {
      adoptionPromise = result.current.adoptRecoveryCandidate(candidate);
    });
    expect(dbMock.adoptRecoveryCandidate).toHaveBeenCalledTimes(1);
    expect(result.current.isAdoptingRecoveryCandidate).toBe(true);
    expect(result.current.isUpdateBlocked()).toBe(true);
    await expect(result.current.flushPendingSave()).rejects.toThrow(
      "復旧候補の採用中は保存を確定できません。",
    );
    await act(async () => {
      adoption.reject(
        Object.assign(new Error("非公開イベント do-not-display"), {
          name: "PersistenceConflict",
        }),
      );
      await adoptionPromise;
    });
    await act(flushMicrotasks);

    expect(result.current.isInitialized).toBe(false);
    expect(result.current.startupState.status).toBe("recovery-required");
    expect(
      getPersistenceReleaseAMetricsSnapshot().counters.startup.recoveryRequired,
    ).toBe(1);
    expect(result.current.recoveryAdoptionError).toContain(
      "開始後に変更されたため",
    );
    expect(result.current.recoveryAdoptionError).not.toContain(
      "非公開イベント",
    );
    expect(result.current.recoveryAdoptionError).not.toContain(
      "do-not-display",
    );
  });

  it("does not hydrate any store when one load needs recovery", async () => {
    const loadError = Object.assign(new Error("metadata read failed"), {
      name: "UnknownError",
    });
    dbMock.loadEventMetadata.mockResolvedValue({
      status: "error",
      data: null,
      error: loadError,
    });
    dbMock.loadEventLists.mockResolvedValue({
      status: "ok",
      data: { 保持対象イベント: [] },
    });

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const setters = createSetters();
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: createValues() } },
    );

    await act(flushMicrotasks);

    expect(result.current.isInitialized).toBe(false);
    expect(result.current.startupState).toMatchObject({
      status: "recovery-required",
      message: "保存データを安全に読み込めませんでした。",
    });
    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });

    rerender({
      values: {
        ...createValues(),
        eventLists: { 読込失敗後の変更: [] },
      },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(dbMock.saveEventLists).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      "Failed to save data to IndexedDB:",
      expect.anything(),
    );
  });

  it("syncQueueの競合候補を起動時に退避専用bundleへ含め、hydrateとautosaveを停止する", async () => {
    const queuePayload = [{ id: "opaque-queue-entry" }];
    const queueRawValue =
      '{"baseRevision":"queue-parent","createdAt":"2026-08-04T00:00:00.000Z","digest":{"algorithm":"SHA-256","canonicalization":"esp-json-v1","value":"queue-digest"},"key":"data","payload":[{"id":"opaque-queue-entry"}],"revision":"queue-branch","schemaVersion":1,"storeName":"syncQueue","writerId":"queue-writer"}';
    dbMock.loadSyncQueue.mockResolvedValue({
      status: "conflict",
      data: null,
      error: Object.assign(new Error("syncQueue conflict"), {
        name: "PersistenceConflict",
      }),
      recoveryBundle: {
        kind: "event-shopping-planner-persistence-recovery",
        version: 1,
        capturedAt: "2026-08-04T00:00:00.000Z",
        issues: [
          {
            stage: "load",
            code: "PersistenceConflict",
            message: "syncQueue conflict",
            storeName: "syncQueue",
          },
        ],
        candidates: [
          {
            id: "sync-queue-runtime-candidate",
            source: "runtime-fallback",
            role: "app-payload",
            adoptable: false,
            storeName: "syncQueue",
            key: "data",
            sourceKey: "esp:idb-fallback:v1:syncQueue:data:queue-branch",
            targetKey: "data",
            revision: "queue-branch",
            digest: "queue-digest",
            digestAlgorithm: "SHA-256",
            digestCanonicalization: "esp-json-v1",
            payload: queuePayload,
            rawValue: queueRawValue,
          },
        ],
      },
    });
    const setters = createSetters();
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 1 }),
      { initialProps: { values: createValues() } },
    );

    await act(flushMicrotasks);

    expect(dbMock.loadSyncQueue).toHaveBeenCalledTimes(1);
    expect(result.current.startupState.status).toBe("recovery-required");
    if (result.current.startupState.status !== "recovery-required") {
      throw new Error("Expected syncQueue recovery-required startup state.");
    }
    expect(result.current.startupState.recoveryBundle).toMatchObject({
      candidates: [
        {
          storeName: "syncQueue",
          role: "app-payload",
          adoptable: false,
          payload: queuePayload,
          rawValue: queueRawValue,
        },
      ],
    });
    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });

    rerender({
      values: {
        ...createValues(),
        eventLists: { syncQueue競合後の変更: [] },
      },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(dbMock.saveEventLists).not.toHaveBeenCalled();
  });

  it("複数storeのload競合候補を上書きせず1つの回復bundleへ統合する", async () => {
    const makeConflictResult = (storeName: string, rawValue: string) => ({
      status: "conflict" as const,
      data: null,
      error: Object.assign(new Error(`${storeName} conflict`), {
        name: "PersistenceConflict",
      }),
      recoveryBundle: {
        kind: "event-shopping-planner-persistence-recovery" as const,
        version: 1 as const,
        capturedAt: "2026-08-03T00:00:00.000Z",
        issues: [
          {
            stage: "load",
            code: "PersistenceConflict",
            message: `${storeName} conflict`,
            storeName,
          },
        ],
        candidates: [
          {
            id: "same-diagnostic-id",
            source: "runtime-fallback" as const,
            storeName,
            key: "data",
            rawValue,
          },
        ],
      },
    });
    dbMock.loadEventLists.mockResolvedValue(
      makeConflictResult("eventLists", "event-lists-raw"),
    );
    dbMock.loadEventMetadata.mockResolvedValue(
      makeConflictResult("eventMetadata", "event-metadata-raw"),
    );
    const setters = createSetters();

    const { result } = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters,
        saveDelayMs: 1,
      }),
    );
    await act(flushMicrotasks);

    expect(result.current.startupState.status).toBe("recovery-required");
    if (result.current.startupState.status !== "recovery-required") {
      throw new Error("Expected a recovery-required startup state.");
    }
    expect(
      result.current.startupState.recoveryBundle?.candidates.map(
        ({ rawValue }) => rawValue,
      ),
    ).toEqual(["event-lists-raw", "event-metadata-raw"]);
    Object.values(setters).forEach((setter) => {
      expect(setter).not.toHaveBeenCalled();
    });
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
    expect(
      getPersistenceReleaseAMetricsSnapshot().counters.save.succeeded,
    ).toBe(1);
  });

  it("flushPendingSave bypasses the debounce and persists the latest snapshot immediately", async () => {
    const setters = createSetters();
    const initialValues = createValues();
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 60_000 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);

    const changedEventLists: PersistedValues["eventLists"] = {
      即時保存イベント: [],
    };
    rerender({
      values: {
        ...initialValues,
        eventLists: changedEventLists,
      },
    });

    expect(result.current.persistenceStatus).toBe("unsaved");
    expect(result.current.isUpdateBlocked()).toBe(true);
    expect(dbMock.saveEventLists).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.flushPendingSave();
    });

    expect(dbMock.saveEventLists).toHaveBeenCalledOnce();
    expect(dbMock.saveEventLists).toHaveBeenCalledWith(changedEventLists);
    expect(result.current.persistenceStatus).toBe("saved");
    expect(result.current.isUpdateBlocked()).toBe(false);
  });

  it("flushPendingSave rejects and remains blocked when IndexedDB persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setters = createSetters();
    const initialValues = createValues();
    dbMock.saveEventLists.mockRejectedValue(
      new Error("eventLists write failed"),
    );
    const { result, rerender } = renderHook(
      ({ values }: { values: PersistedValues }) =>
        useIndexedDbPersistence({ values, setters, saveDelayMs: 60_000 }),
      { initialProps: { values: initialValues } },
    );

    await act(flushMicrotasks);
    rerender({
      values: {
        ...initialValues,
        eventLists: { 保存失敗イベント: [] },
      },
    });

    await act(async () => {
      await expect(result.current.flushPendingSave()).rejects.toThrow(
        "保存を完了できませんでした。",
      );
    });

    expect(dbMock.saveEventLists).toHaveBeenCalledOnce();
    expect(result.current.persistenceStatus).toBe("failed");
    expect(result.current.failedStores).toEqual(["eventLists"]);
    expect(result.current.isUpdateBlocked()).toBe(true);
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
      "IndexedDB persistence save failed.",
      [
        {
          storeName: "mapData",
          category: "unknown",
          errorCode: "persistence-operation-failed",
        },
      ],
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(result.current.persistenceStatus).toBe("failed");
    expect(result.current.failedStores).toEqual(["mapData"]);
    expect(result.current.failureDetails).toEqual([
      expect.objectContaining({
        storeName: "mapData",
        category: "unknown",
        errorCode: "persistence-operation-failed",
        technicalMessage: null,
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
        errorCode: "storage-quota-exceeded",
        technicalMessage: null,
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
      "IndexedDB persistence save failed.",
      [
        {
          storeName: "eventLists",
          category: "unknown",
          errorCode: "persistence-operation-failed",
        },
      ],
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

  it("flushPendingSave waits for an active save and drains its newest snapshot", async () => {
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

    let flushPromise!: Promise<void>;
    act(() => {
      flushPromise = result.current.flushPendingSave();
    });
    await act(flushMicrotasks);
    expect(result.current.isUpdateBlocked()).toBe(true);

    await act(async () => {
      firstSave.resolve();
      await flushPromise;
    });

    expect(dbMock.saveEventLists).toHaveBeenCalledTimes(2);
    expect(dbMock.saveEventLists).toHaveBeenLastCalledWith(newestEventLists);
    expect(dbMock.saveEventLists.mock.calls[1][0].変更しないイベント).toEqual(
      unchangedEvent,
    );
    expect(result.current.persistenceStatus).toBe("saved");
    expect(result.current.isUpdateBlocked()).toBe(false);
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
    expect(result.current.isUpdateBlocked()).toBe(true);
    await expect(result.current.flushPendingSave()).rejects.toThrow(
      "復元処理の完了前に保存を確定できません。",
    );

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
