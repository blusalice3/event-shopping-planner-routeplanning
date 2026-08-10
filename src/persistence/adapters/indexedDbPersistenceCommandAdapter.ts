import type {
  PersistenceCommandPort,
  PersistenceMigrationCommandResult,
  PersistenceSnapshot,
} from "../../app/ports/PersistenceCommandPort";
import { PersistenceSettingsRollbackError } from "../../app/ports/PersistenceCommandPort";
import type {
  BlockDetectionSettings,
  BlockDetectionSettingsStore,
} from "../../types/map";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import {
  BlockDetectionSettingsRollbackError,
  loadBlockDetectionSettings,
  readBlockDetectionSettingsStoreForBackup as readBlockDetectionSettingsForBackup,
  removeBlockDetectionSettingsForEvent,
  renameBlockDetectionSettingsForEvent,
  runWithBlockDetectionSettingsRestore,
  saveBlockDetectionSettings,
} from "../../utils/blockDetectionSettingsStorage";
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
  commitApplicationSnapshotAtomically(
    snapshot: PersistenceSnapshot,
  ): Promise<void>;
  deleteEventAtomically(
    snapshot: PersistenceSnapshot,
    eventName: string,
  ): Promise<void>;
  renameEventAtomically(
    snapshot: PersistenceSnapshot,
    oldEventName: string,
    newEventName: string,
  ): Promise<void>;
}

export interface AuxiliaryPersistenceCommandDelegate {
  loadPreference(key: string): string | null;
  savePreference(key: string, value: string): void;
  readBlockDetectionSettings(eventName: string): BlockDetectionSettings | null;
  readBlockDetectionSettingsForBackup(
    eventNames: readonly string[],
  ): BlockDetectionSettingsStore;
  saveBlockDetectionSettings(
    eventName: string,
    settings: BlockDetectionSettings,
  ): void;
  removeBlockDetectionSettingsForEvent(eventName: string): void;
  renameBlockDetectionSettingsForEvent(
    oldEventName: string,
    newEventName: string,
  ): void;
  runWithBlockDetectionSettingsRestore<T>(
    eventName: string,
    settings: BlockDetectionSettings | null,
    commit: () => Promise<T>,
  ): Promise<T>;
}

const browserAuxiliaryPersistenceCommands: AuxiliaryPersistenceCommandDelegate =
  {
    loadPreference(key): string | null {
      return typeof window === "undefined"
        ? null
        : window.localStorage.getItem(key);
    },
    savePreference(key, value): void {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(key, value);
      }
    },
    readBlockDetectionSettings: loadBlockDetectionSettings,
    readBlockDetectionSettingsForBackup,
    saveBlockDetectionSettings,
    removeBlockDetectionSettingsForEvent,
    renameBlockDetectionSettingsForEvent,
    runWithBlockDetectionSettingsRestore,
  };

export const createIndexedDbPersistenceCommandAdapter = (
  delegate: IndexedDbPersistenceCommandDelegate = db,
  auxiliary: AuxiliaryPersistenceCommandDelegate = browserAuxiliaryPersistenceCommands,
): PersistenceCommandPort => ({
  loadPreference(key): string | null {
    return auxiliary.loadPreference(key);
  },
  savePreference(key, value): void {
    auxiliary.savePreference(key, value);
  },
  readBlockDetectionSettings(eventName): BlockDetectionSettings | null {
    return auxiliary.readBlockDetectionSettings(eventName);
  },
  readBlockDetectionSettingsForBackup(eventNames) {
    return auxiliary.readBlockDetectionSettingsForBackup(eventNames);
  },
  saveBlockDetectionSettings(eventName, settings): void {
    auxiliary.saveBlockDetectionSettings(eventName, settings);
  },
  removeBlockDetectionSettingsForEvent(eventName): void {
    auxiliary.removeBlockDetectionSettingsForEvent(eventName);
  },
  renameBlockDetectionSettingsForEvent(oldEventName, newEventName): void {
    auxiliary.renameBlockDetectionSettingsForEvent(oldEventName, newEventName);
  },
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
  commitApplicationSnapshotAtomically(snapshot): Promise<void> {
    return delegate.commitApplicationSnapshotAtomically(snapshot);
  },
  async deleteEventAtomically(snapshot, eventName): Promise<void> {
    try {
      await auxiliary.runWithBlockDetectionSettingsRestore(
        eventName,
        null,
        () => delegate.deleteEventAtomically(snapshot, eventName),
      );
    } catch (error) {
      if (error instanceof BlockDetectionSettingsRollbackError) {
        throw new PersistenceSettingsRollbackError(
          error.originalError,
          error.rollbackError,
        );
      }
      throw error;
    }
  },
  async renameEventAtomically(
    snapshot,
    oldEventName,
    newEventName,
  ): Promise<void> {
    const oldSettings = auxiliary.readBlockDetectionSettings(oldEventName);
    if (auxiliary.readBlockDetectionSettings(newEventName) !== null) {
      throw new Error(
        `Block detection settings already exist for ${newEventName}.`,
      );
    }
    try {
      await auxiliary.runWithBlockDetectionSettingsRestore(
        oldEventName,
        null,
        () =>
          auxiliary.runWithBlockDetectionSettingsRestore(
            newEventName,
            oldSettings,
            () =>
              delegate.renameEventAtomically(
                snapshot,
                oldEventName,
                newEventName,
              ),
          ),
      );
    } catch (error) {
      if (error instanceof BlockDetectionSettingsRollbackError) {
        throw new PersistenceSettingsRollbackError(
          error.originalError,
          error.rollbackError,
        );
      }
      throw error;
    }
  },
  async restoreAppDataWithBlockDetectionSettings(
    snapshot,
    eventName,
    settings,
  ): Promise<void> {
    try {
      await auxiliary.runWithBlockDetectionSettingsRestore(
        eventName,
        settings,
        () => delegate.restoreAppDataAtomically(snapshot),
      );
    } catch (error) {
      if (error instanceof BlockDetectionSettingsRollbackError) {
        throw new PersistenceSettingsRollbackError(
          error.originalError,
          error.rollbackError,
        );
      }
      throw error;
    }
  },
});
