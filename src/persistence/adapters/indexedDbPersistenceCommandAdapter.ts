import type {
  PersistenceCommandPort,
  PersistenceMigrationCommandResult,
  PersistenceSnapshot,
} from "../../app/ports/PersistenceCommandPort";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import { db } from "../facade/indexedDbPersistence";

export interface IndexedDbPersistenceCommandDelegate {
  migrateFromLocalStorage(): Promise<PersistenceMigrationCommandResult>;
  adoptRecoveryCandidate(candidate: StartupRecoveryCandidate): Promise<unknown>;
  saveEventLists: PersistenceCommandPort["saveEventLists"];
  saveEventMetadata: PersistenceCommandPort["saveEventMetadata"];
  saveExecuteModeItems: PersistenceCommandPort["saveExecuteModeItems"];
  saveDayModes: PersistenceCommandPort["saveDayModes"];
  saveMapDataChanges: PersistenceCommandPort["saveMapDataChanges"];
  saveMapRotationSettings: PersistenceCommandPort["saveMapRotationSettings"];
  saveRouteSettings: PersistenceCommandPort["saveRouteSettings"];
  saveHallDefinitions: PersistenceCommandPort["saveHallDefinitions"];
  saveHallRouteSettings: PersistenceCommandPort["saveHallRouteSettings"];
  saveMapViewportSettings: PersistenceCommandPort["saveMapViewportSettings"];
  restoreAppDataAtomically(snapshot: PersistenceSnapshot): Promise<void>;
}

export const createIndexedDbPersistenceCommandAdapter = (
  delegate: IndexedDbPersistenceCommandDelegate = db,
): PersistenceCommandPort => ({
  migrateFromLocalStorage(): Promise<PersistenceMigrationCommandResult> {
    return delegate.migrateFromLocalStorage();
  },
  async adoptRecoveryCandidate(
    candidate: StartupRecoveryCandidate,
  ): Promise<void> {
    await delegate.adoptRecoveryCandidate(candidate);
  },
  saveEventLists(value): Promise<void> {
    return delegate.saveEventLists(value);
  },
  saveEventMetadata(value): Promise<void> {
    return delegate.saveEventMetadata(value);
  },
  saveExecuteModeItems(value): Promise<void> {
    return delegate.saveExecuteModeItems(value);
  },
  saveDayModes(value): Promise<void> {
    return delegate.saveDayModes(value);
  },
  saveMapDataChanges(previousValue, value): Promise<void> {
    return delegate.saveMapDataChanges(previousValue, value);
  },
  saveMapRotationSettings(value): Promise<void> {
    return delegate.saveMapRotationSettings(value);
  },
  saveRouteSettings(value): Promise<void> {
    return delegate.saveRouteSettings(value);
  },
  saveHallDefinitions(value): Promise<void> {
    return delegate.saveHallDefinitions(value);
  },
  saveHallRouteSettings(value): Promise<void> {
    return delegate.saveHallRouteSettings(value);
  },
  saveMapViewportSettings(value): Promise<void> {
    return delegate.saveMapViewportSettings(value);
  },
  restoreAppDataAtomically(snapshot): Promise<void> {
    return delegate.restoreAppDataAtomically(snapshot);
  },
});
