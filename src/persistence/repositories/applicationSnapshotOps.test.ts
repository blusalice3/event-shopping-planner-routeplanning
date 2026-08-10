import { describe, expect, it } from "vitest";
import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";
import {
  EventSnapshotCollisionError,
  removeEventFromApplicationSnapshot,
  renameEventInApplicationSnapshot,
} from "./applicationSnapshotOps";

const createSnapshot = (): PersistenceSnapshot => ({
  eventLists: { source: [{ id: "item" }] },
  eventMetadata: { source: { imported: true } },
  executeModeItems: { source: { day: ["item"] } },
  dayModes: { source: { day: "execute" } },
  mapData: { source: { day: { cells: [] } } },
  mapRotationSettings: { source: { day: 90 } },
  routeSettings: { source: { day: { start: 1 } } },
  hallDefinitions: { source: { day: [] } },
  hallRouteSettings: { source: { day: { order: [] } } },
  mapViewportSettings: { source: { day: { zoom: 1 } } },
});

describe("application snapshot event operations", () => {
  it("removes an event from all ten stores without mutating the source", () => {
    const source = createSnapshot();
    const next = removeEventFromApplicationSnapshot(source, "source");

    expect(Object.values(next).every((store) => !("source" in store))).toBe(
      true,
    );
    expect(source.eventLists.source).toHaveLength(1);
  });

  it("renames an event across all ten stores without mutating the source", () => {
    const source = createSnapshot();
    const next = renameEventInApplicationSnapshot(source, "source", "target");

    expect(
      Object.values(next).every(
        (store) => !("source" in store) && "target" in store,
      ),
    ).toBe(true);
    expect(source.eventLists.source).toHaveLength(1);
  });

  it("rejects a target collision found in any application store", () => {
    const source = createSnapshot();
    source.mapViewportSettings.target = {};

    expect(() =>
      renameEventInApplicationSnapshot(source, "source", "target"),
    ).toThrow(EventSnapshotCollisionError);
    expect(source.eventLists.source).toHaveLength(1);
  });
});
