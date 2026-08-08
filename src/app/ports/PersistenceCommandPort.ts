import type {
  StartupRecoveryBundle,
  StartupRecoveryCandidate,
} from "../../utils/persistenceResilience";

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

export type PersistenceMigrationCleanupStatus =
  | "not-needed"
  | "not-ready"
  | "ready"
  | "deferred"
  | "in-progress"
  | "completed"
  | "recovery-required";

export type PersistenceMigrationCommandResult =
  | {
      status: "not-needed" | "completed" | "cleanup-pending";
      cleanupStatus?: Exclude<
        PersistenceMigrationCleanupStatus,
        "recovery-required"
      >;
    }
  | {
      status: "recovery-required";
      cleanupStatus?: PersistenceMigrationCleanupStatus;
      recoveryBundle: StartupRecoveryBundle;
    };

export interface PersistenceCommandPort {
  migrateFromLocalStorage(): Promise<PersistenceMigrationCommandResult>;
  adoptRecoveryCandidate(candidate: StartupRecoveryCandidate): Promise<void>;
  saveEventLists(value: PersistenceSnapshot["eventLists"]): Promise<void>;
  saveEventMetadata(value: PersistenceSnapshot["eventMetadata"]): Promise<void>;
  saveExecuteModeItems(
    value: PersistenceSnapshot["executeModeItems"],
  ): Promise<void>;
  saveDayModes(value: PersistenceSnapshot["dayModes"]): Promise<void>;
  saveMapDataChanges(
    previousValue: PersistenceSnapshot["mapData"],
    value: PersistenceSnapshot["mapData"],
  ): Promise<void>;
  saveMapRotationSettings(
    value: PersistenceSnapshot["mapRotationSettings"],
  ): Promise<void>;
  saveRouteSettings(value: PersistenceSnapshot["routeSettings"]): Promise<void>;
  saveHallDefinitions(
    value: PersistenceSnapshot["hallDefinitions"],
  ): Promise<void>;
  saveHallRouteSettings(
    value: PersistenceSnapshot["hallRouteSettings"],
  ): Promise<void>;
  saveMapViewportSettings(
    value: PersistenceSnapshot["mapViewportSettings"],
  ): Promise<void>;
  restoreAppDataAtomically(snapshot: PersistenceSnapshot): Promise<void>;
}
