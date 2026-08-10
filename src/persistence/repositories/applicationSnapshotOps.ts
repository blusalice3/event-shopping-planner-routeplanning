import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";

const EVENT_SCOPED_SNAPSHOT_KEYS = [
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "dayModes",
  "mapData",
  "mapRotationSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "mapViewportSettings",
] as const satisfies readonly (keyof PersistenceSnapshot)[];

export class EventSnapshotCollisionError extends Error {
  constructor(readonly eventName: string) {
    super(`Application snapshot already contains event ${eventName}.`);
    this.name = "EventSnapshotCollisionError";
  }
}

export const removeEventFromApplicationSnapshot = (
  snapshot: PersistenceSnapshot,
  eventName: string,
): PersistenceSnapshot => {
  const next = structuredClone(snapshot);
  EVENT_SCOPED_SNAPSHOT_KEYS.forEach((key) => {
    delete next[key][eventName];
  });
  return next;
};

export const renameEventInApplicationSnapshot = (
  snapshot: PersistenceSnapshot,
  oldEventName: string,
  newEventName: string,
): PersistenceSnapshot => {
  if (
    EVENT_SCOPED_SNAPSHOT_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(snapshot[key], newEventName),
    )
  ) {
    throw new EventSnapshotCollisionError(newEventName);
  }

  const next = structuredClone(snapshot);
  EVENT_SCOPED_SNAPSHOT_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(next[key], oldEventName)) return;
    const value = next[key][oldEventName];
    delete next[key][oldEventName];
    Object.assign(next[key], { [newEventName]: value });
  });
  return next;
};
