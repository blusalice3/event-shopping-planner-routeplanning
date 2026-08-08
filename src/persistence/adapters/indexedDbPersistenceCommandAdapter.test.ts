import { describe, expect, it, vi } from "vitest";
import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";
import { createIndexedDbPersistenceCommandAdapter } from "./indexedDbPersistenceCommandAdapter";

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

describe("IndexedDB persistence command adapter", () => {
  it("forwards the exact snapshot and observable promise result", async () => {
    const restoreAppDataAtomically = vi.fn(async () => undefined);
    const adapter = createIndexedDbPersistenceCommandAdapter({
      restoreAppDataAtomically,
    });
    const input = snapshot();

    await expect(
      adapter.restoreAppDataAtomically(input),
    ).resolves.toBeUndefined();
    expect(restoreAppDataAtomically).toHaveBeenCalledOnce();
    expect(restoreAppDataAtomically).toHaveBeenCalledWith(input);
  });

  it("does not normalize a delegate failure", async () => {
    const failure = new DOMException("restore failed", "AbortError");
    const adapter = createIndexedDbPersistenceCommandAdapter({
      restoreAppDataAtomically: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(adapter.restoreAppDataAtomically(snapshot())).rejects.toBe(
      failure,
    );
  });
});
