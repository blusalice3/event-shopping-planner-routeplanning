import { describe, expect, it, vi } from "vitest";
import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import {
  createIndexedDbPersistenceCommandAdapter,
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
  ...overrides,
});

describe("IndexedDB persistence command adapter", () => {
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
