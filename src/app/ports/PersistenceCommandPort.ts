export interface PersistenceSnapshot {
  eventLists: Record<string, unknown[]>;
  eventMetadata: Record<string, unknown>;
  executeModeItems: Record<string, Record<string, string[]>>;
  dayModes: Record<string, Record<string, string>>;
  mapData: Record<string, Record<string, unknown>>;
  mapRotationSettings: Record<string, Record<string, unknown>>;
  routeSettings: Record<string, Record<string, unknown>>;
  hallDefinitions: Record<string, Record<string, unknown[]>>;
  hallRouteSettings: Record<string, Record<string, unknown>>;
  mapViewportSettings: Record<string, Record<string, unknown>>;
}

/**
 * Public compatibility name for the application-level persistence snapshot.
 *
 * Keep the shape owned by this neutral port so feature code and persistence
 * adapters do not depend on one another for a type-only contract.
 */
export type AppData = PersistenceSnapshot;

export interface PersistenceCommandPort {
  restoreAppDataAtomically(snapshot: PersistenceSnapshot): Promise<void>;
}
