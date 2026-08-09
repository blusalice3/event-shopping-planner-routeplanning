import { describe, expect, it, vi } from "vitest";
import {
  PersistenceSettingsRollbackError,
  type PersistenceSnapshot,
} from "../../app/ports/PersistenceCommandPort";
import type { BlockDetectionSettings } from "../../types/map";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import { BlockDetectionSettingsRollbackError } from "../../utils/blockDetectionSettingsStorage";
import {
  createIndexedDbPersistenceCommandAdapter,
  type AuxiliaryPersistenceCommandDelegate,
  type IndexedDbPersistenceCommandDelegate,
} from "./indexedDbPersistenceCommandAdapter";

const snapshot = (): PersistenceSnapshot => ({
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

const createDelegate = (
  overrides: Partial<IndexedDbPersistenceCommandDelegate> = {},
): IndexedDbPersistenceCommandDelegate => ({
  migrateFromLocalStorage: vi.fn(async () => ({
    status: "not-needed" as const,
  })),
  adoptRecoveryCandidate: vi.fn(async () => ({ status: "adopted" })),
  saveEventLists: vi.fn(async () => undefined),
  saveEventMetadata: vi.fn(async () => undefined),
  saveExecuteModeItems: vi.fn(async () => undefined),
  saveDayModes: vi.fn(async () => undefined),
  saveMapDataChanges: vi.fn(async () => undefined),
  saveMapRotationSettings: vi.fn(async () => undefined),
  saveRouteSettings: vi.fn(async () => undefined),
  saveHallDefinitions: vi.fn(async () => undefined),
  saveHallRouteSettings: vi.fn(async () => undefined),
  saveMapViewportSettings: vi.fn(async () => undefined),
  restoreAppDataAtomically: vi.fn(async () => undefined),
  commitApplicationSnapshotAtomically: vi.fn(async () => undefined),
  deleteEventAtomically: vi.fn(async () => undefined),
  renameEventAtomically: vi.fn(async () => undefined),
  ...overrides,
});

const createAuxiliaryDelegate = (
  overrides: Partial<AuxiliaryPersistenceCommandDelegate> = {},
): AuxiliaryPersistenceCommandDelegate => {
  const runWithBlockDetectionSettingsRestore = vi.fn(
    async (
      _eventName: string,
      _settings: BlockDetectionSettings | null,
      commit: () => Promise<unknown>,
    ) => commit(),
  ) as unknown as AuxiliaryPersistenceCommandDelegate["runWithBlockDetectionSettingsRestore"];

  return {
    loadPreference: vi.fn(() => null),
    savePreference: vi.fn(),
    readBlockDetectionSettings: vi.fn(() => null),
    readBlockDetectionSettingsForBackup: vi.fn(() => ({})),
    saveBlockDetectionSettings: vi.fn(),
    removeBlockDetectionSettingsForEvent: vi.fn(),
    renameBlockDetectionSettingsForEvent: vi.fn(),
    runWithBlockDetectionSettingsRestore,
    ...overrides,
  };
};

describe("IndexedDB persistence command adapter", () => {
  it("routes preferences and event-scoped settings through the auxiliary port", async () => {
    const delegate = createDelegate();
    const settings = {} as BlockDetectionSettings;
    const auxiliary = createAuxiliaryDelegate({
      loadPreference: vi.fn(() => "stored"),
      readBlockDetectionSettings: vi.fn(() => settings),
      readBlockDetectionSettingsForBackup: vi.fn(() => ({
        event: settings,
      })),
    });
    const adapter = createIndexedDbPersistenceCommandAdapter(
      delegate,
      auxiliary,
    );
    const input = snapshot();

    expect(adapter.loadPreference("themeMode")).toBe("stored");
    adapter.savePreference("themeMode", "dark");
    expect(adapter.readBlockDetectionSettings("event")).toBe(settings);
    expect(adapter.readBlockDetectionSettingsForBackup(["event"])).toEqual({
      event: settings,
    });
    adapter.saveBlockDetectionSettings("event", settings);
    adapter.renameBlockDetectionSettingsForEvent("event", "renamed");
    adapter.removeBlockDetectionSettingsForEvent("renamed");
    await adapter.restoreAppDataWithBlockDetectionSettings(
      input,
      "event",
      settings,
    );

    expect(auxiliary.savePreference).toHaveBeenCalledWith("themeMode", "dark");
    expect(auxiliary.saveBlockDetectionSettings).toHaveBeenCalledWith(
      "event",
      settings,
    );
    expect(auxiliary.renameBlockDetectionSettingsForEvent).toHaveBeenCalledWith(
      "event",
      "renamed",
    );
    expect(auxiliary.removeBlockDetectionSettingsForEvent).toHaveBeenCalledWith(
      "renamed",
    );
    expect(auxiliary.runWithBlockDetectionSettingsRestore).toHaveBeenCalledWith(
      "event",
      settings,
      expect.any(Function),
    );
    expect(delegate.restoreAppDataAtomically).toHaveBeenCalledWith(input);
  });

  it("maps auxiliary rollback failure to the neutral application error", async () => {
    const originalError = new Error("restore failed");
    const rollbackError = new Error("rollback failed");
    const auxiliary = createAuxiliaryDelegate({
      runWithBlockDetectionSettingsRestore: vi.fn(async () => {
        throw new BlockDetectionSettingsRollbackError(
          originalError,
          rollbackError,
        );
      }),
    });
    const adapter = createIndexedDbPersistenceCommandAdapter(
      createDelegate(),
      auxiliary,
    );

    await expect(
      adapter.restoreAppDataWithBlockDetectionSettings(
        snapshot(),
        "event",
        null,
      ),
    ).rejects.toMatchObject({
      name: "PersistenceSettingsRollbackError",
      originalError,
      rollbackError,
    } satisfies Partial<PersistenceSettingsRollbackError>);
  });

  it("maps a rename auxiliary rollback failure to the neutral application error", async () => {
    const originalError = new Error("rename failed");
    const rollbackError = new Error("rename rollback failed");
    const auxiliary = createAuxiliaryDelegate({
      runWithBlockDetectionSettingsRestore: vi.fn(async () => {
        throw new BlockDetectionSettingsRollbackError(
          originalError,
          rollbackError,
        );
      }),
    });
    const adapter = createIndexedDbPersistenceCommandAdapter(
      createDelegate(),
      auxiliary,
    );

    await expect(
      adapter.renameEventAtomically(snapshot(), "source", "target"),
    ).rejects.toMatchObject({
      name: "PersistenceSettingsRollbackError",
      originalError,
      rollbackError,
    } satisfies Partial<PersistenceSettingsRollbackError>);
  });

  it("uses the default preference storage only when a browser window is available", () => {
    const adapter = createIndexedDbPersistenceCommandAdapter(createDelegate());

    expect(typeof window).toBe("undefined");
    expect(adapter.loadPreference("themeMode")).toBeNull();
    expect(() => adapter.savePreference("themeMode", "dark")).not.toThrow();

    const localStorage = {
      getItem: vi.fn(() => "light"),
      setItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage });
    try {
      expect(adapter.loadPreference("themeMode")).toBe("light");
      adapter.savePreference("themeMode", "dark");
      expect(localStorage.getItem).toHaveBeenCalledWith("themeMode");
      expect(localStorage.setItem).toHaveBeenCalledWith("themeMode", "dark");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves a non-rollback failure from the auxiliary restore boundary", async () => {
    const failure = new DOMException("restore failed", "AbortError");
    const auxiliary = createAuxiliaryDelegate({
      runWithBlockDetectionSettingsRestore: vi.fn(async () => {
        throw failure;
      }),
    });
    const adapter = createIndexedDbPersistenceCommandAdapter(
      createDelegate(),
      auxiliary,
    );

    await expect(
      adapter.restoreAppDataWithBlockDetectionSettings(
        snapshot(),
        "event",
        null,
      ),
    ).rejects.toBe(failure);
  });

  it("restores auxiliary settings when the atomic delete transaction aborts", async () => {
    const settings = { marker: "source" } as unknown as BlockDetectionSettings;
    const stored = new Map<string, BlockDetectionSettings | null>([
      ["source", settings],
    ]);
    const auxiliary = createAuxiliaryDelegate({
      readBlockDetectionSettings: vi.fn(
        (eventName) => stored.get(eventName) ?? null,
      ),
      runWithBlockDetectionSettingsRestore: vi.fn(
        async (eventName, nextSettings, commit) => {
          const previous = stored.get(eventName) ?? null;
          stored.set(eventName, nextSettings);
          try {
            return await commit();
          } catch (error) {
            stored.set(eventName, previous);
            throw error;
          }
        },
      ),
    });
    const failure = new DOMException("transaction aborted", "AbortError");
    const adapter = createIndexedDbPersistenceCommandAdapter(
      createDelegate({
        deleteEventAtomically: vi.fn(async () => {
          throw failure;
        }),
      }),
      auxiliary,
    );

    await expect(
      adapter.deleteEventAtomically(snapshot(), "source"),
    ).rejects.toBe(failure);
    expect(stored.get("source")).toBe(settings);
  });

  it("moves auxiliary settings only for a successful atomic rename", async () => {
    const settings = { marker: "source" } as unknown as BlockDetectionSettings;
    const stored = new Map<string, BlockDetectionSettings | null>([
      ["source", settings],
    ]);
    const auxiliary = createAuxiliaryDelegate({
      readBlockDetectionSettings: vi.fn(
        (eventName) => stored.get(eventName) ?? null,
      ),
      runWithBlockDetectionSettingsRestore: vi.fn(
        async (eventName, nextSettings, commit) => {
          const previous = stored.get(eventName) ?? null;
          stored.set(eventName, nextSettings);
          try {
            return await commit();
          } catch (error) {
            stored.set(eventName, previous);
            throw error;
          }
        },
      ),
    });
    const delegate = createDelegate();
    const adapter = createIndexedDbPersistenceCommandAdapter(
      delegate,
      auxiliary,
    );

    await adapter.renameEventAtomically(snapshot(), "source", "target");

    expect(stored.get("source")).toBeNull();
    expect(stored.get("target")).toBe(settings);
    expect(delegate.renameEventAtomically).toHaveBeenCalledWith(
      expect.any(Object),
      "source",
      "target",
    );
  });

  it("rejects an auxiliary rename collision before the IDB transaction", async () => {
    const settings = {} as BlockDetectionSettings;
    const delegate = createDelegate();
    const auxiliary = createAuxiliaryDelegate({
      readBlockDetectionSettings: vi.fn((eventName) =>
        eventName === "target" ? settings : null,
      ),
    });
    const adapter = createIndexedDbPersistenceCommandAdapter(
      delegate,
      auxiliary,
    );

    await expect(
      adapter.renameEventAtomically(snapshot(), "source", "target"),
    ).rejects.toThrow("already exist");
    expect(delegate.renameEventAtomically).not.toHaveBeenCalled();
  });

  it("forwards every persistence mutation without normalization", async () => {
    const delegate = createDelegate();
    const adapter = createIndexedDbPersistenceCommandAdapter(delegate);
    const input = snapshot();
    const candidate = { id: "recovery-candidate" } as StartupRecoveryCandidate;

    await expect(adapter.migrateFromLocalStorage()).resolves.toEqual({
      status: "not-needed",
    });
    await expect(adapter.adoptRecoveryCandidate(candidate)).resolves.toBe(
      undefined,
    );
    await adapter.saveEventLists(input.eventLists);
    await adapter.saveEventMetadata(input.eventMetadata);
    await adapter.saveExecuteModeItems(input.executeModeItems);
    await adapter.saveDayModes(input.dayModes);
    await adapter.saveMapDataChanges(input.mapData, input.mapData);
    await adapter.saveMapRotationSettings(input.mapRotationSettings);
    await adapter.saveRouteSettings(input.routeSettings);
    await adapter.saveHallDefinitions(input.hallDefinitions);
    await adapter.saveHallRouteSettings(input.hallRouteSettings);
    await adapter.saveMapViewportSettings(input.mapViewportSettings);
    await adapter.restoreAppDataAtomically(input);
    await adapter.commitApplicationSnapshotAtomically(input);

    expect(delegate.migrateFromLocalStorage).toHaveBeenCalledOnce();
    expect(delegate.adoptRecoveryCandidate).toHaveBeenCalledWith(candidate);
    expect(delegate.saveEventLists).toHaveBeenCalledWith(input.eventLists);
    expect(delegate.saveEventMetadata).toHaveBeenCalledWith(
      input.eventMetadata,
    );
    expect(delegate.saveExecuteModeItems).toHaveBeenCalledWith(
      input.executeModeItems,
    );
    expect(delegate.saveDayModes).toHaveBeenCalledWith(input.dayModes);
    expect(delegate.saveMapDataChanges).toHaveBeenCalledWith(
      input.mapData,
      input.mapData,
    );
    expect(delegate.saveMapRotationSettings).toHaveBeenCalledWith(
      input.mapRotationSettings,
    );
    expect(delegate.saveRouteSettings).toHaveBeenCalledWith(
      input.routeSettings,
    );
    expect(delegate.saveHallDefinitions).toHaveBeenCalledWith(
      input.hallDefinitions,
    );
    expect(delegate.saveHallRouteSettings).toHaveBeenCalledWith(
      input.hallRouteSettings,
    );
    expect(delegate.saveMapViewportSettings).toHaveBeenCalledWith(
      input.mapViewportSettings,
    );
    expect(delegate.restoreAppDataAtomically).toHaveBeenCalledWith(input);
    expect(delegate.commitApplicationSnapshotAtomically).toHaveBeenCalledWith(
      input,
    );
  });

  it("does not normalize a delegate failure", async () => {
    const failure = new DOMException("restore failed", "AbortError");
    const adapter = createIndexedDbPersistenceCommandAdapter(
      createDelegate({
        restoreAppDataAtomically: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(adapter.restoreAppDataAtomically(snapshot())).rejects.toBe(
      failure,
    );
  });
});
