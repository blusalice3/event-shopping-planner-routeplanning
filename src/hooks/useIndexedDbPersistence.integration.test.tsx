// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../utils/indexedDB";
import { createIndexedDbPersistenceCommandAdapter } from "../persistence/adapters/indexedDbPersistenceCommandAdapter";
import {
  useIndexedDbPersistence as useIndexedDbPersistenceImplementation,
  type PersistedStateValues,
} from "./useIndexedDbPersistence";

const persistenceCommands = createIndexedDbPersistenceCommandAdapter();
type ImplementationHookParams = Parameters<
  typeof useIndexedDbPersistenceImplementation
>[0];
const useIndexedDbPersistence = (
  params: Omit<ImplementationHookParams, "persistenceCommands">,
) =>
  useIndexedDbPersistenceImplementation({
    ...params,
    persistenceCommands,
  });

type HookParams = Parameters<typeof useIndexedDbPersistence>[0];
type PersistedSetters = HookParams["setters"];

const createValues = (): PersistedStateValues => ({
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

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("useIndexedDbPersistence with real IndexedDB", () => {
  it("keeps an explicitly adopted IDB root ready across immediate reinitialization and remount", async () => {
    const idbMetadata = {
      "Release A IDBイベント": {
        spreadsheetUrl: "https://example.invalid/idb",
        spreadsheetSheetName: "IDB採用候補",
        lastImportDate: "2026-08-03T00:00:00.000Z",
      },
    };
    const legacyMetadata = {
      "Release A legacyイベント": {
        spreadsheetUrl: "https://example.invalid/legacy",
        spreadsheetSheetName: "保持する旧原本",
        lastImportDate: "2026-08-02T00:00:00.000Z",
      },
    };
    const legacyRaw = JSON.stringify(legacyMetadata);

    await db.saveEventMetadata(idbMetadata);
    localStorage.setItem("eventMetadata", legacyRaw);

    const firstSetters = createSetters();
    const firstMount = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters: firstSetters,
        saveDelayMs: 1,
      }),
    );

    await waitFor(() => {
      expect(firstMount.result.current.startupState.status).toBe(
        "recovery-required",
      );
    });
    const firstStartupState = firstMount.result.current.startupState;
    if (firstStartupState.status !== "recovery-required") {
      throw new Error("Expected migration recovery before explicit adoption.");
    }
    const idbCandidate = firstStartupState.recoveryBundle?.candidates.find(
      ({ source, role, storeName }) =>
        source === "indexedDB" &&
        role === "app-payload" &&
        storeName === "eventMetadata",
    );
    if (!idbCandidate) {
      throw new Error("Missing adoptable IndexedDB recovery candidate.");
    }

    await act(async () => {
      await firstMount.result.current.adoptRecoveryCandidate(idbCandidate);
    });

    await waitFor(() => {
      expect(firstMount.result.current.startupState.status).toBe("ready");
    });
    expect(firstMount.result.current.isInitialized).toBe(true);
    expect(firstMount.result.current.legacyCleanupStatus).toBe("deferred");
    expect(firstSetters.setEventMetadata).toHaveBeenCalledWith(idbMetadata);
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: idbMetadata,
    });
    expect(localStorage.getItem("eventMetadata")).toBe(legacyRaw);

    firstMount.unmount();

    const restartedSetters = createSetters();
    const restartedMount = renderHook(() =>
      useIndexedDbPersistence({
        values: createValues(),
        setters: restartedSetters,
        saveDelayMs: 1,
      }),
    );

    await waitFor(() => {
      expect(restartedMount.result.current.startupState.status).toBe("ready");
    });
    expect(restartedMount.result.current.isInitialized).toBe(true);
    expect(restartedMount.result.current.legacyCleanupStatus).toBe("deferred");
    expect(restartedSetters.setEventMetadata).toHaveBeenCalledWith(idbMetadata);
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: idbMetadata,
    });
    expect(localStorage.getItem("eventMetadata")).toBe(legacyRaw);
  });
});
