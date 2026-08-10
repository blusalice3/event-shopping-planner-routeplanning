import type { StartupRecoveryBundle } from "../../utils/persistenceResilience";
import type {
  AutomaticPersistenceCleanupRequest,
  ManualPersistenceCleanupRequest,
  PersistenceCleanupBlockedReason,
  PersistenceCleanupDeferredReason,
  PersistenceCleanupMode,
  PersistenceCleanupPhysicalBlockedReason,
  PersistenceCleanupPhysicalDeferredReason,
} from "../../utils/persistenceCleanupCoordinator";
import type { StoreName } from "../db/constants";

export type LoadStatus = "ok" | "missing" | "error" | "conflict";

export type LoadResult<T> = {
  status: LoadStatus;
  data: T | null;
  error?: unknown;
  recoveryBundle?: StartupRecoveryBundle;
};

export type PersistenceMigrationStatus =
  | "not-needed"
  | "completed"
  | "cleanup-pending"
  | "recovery-required";

export type PersistenceDataMigrationStatus =
  | "not-needed"
  | "prepared"
  | "copied"
  | "verified"
  | "recovery-required";

export type PersistenceCleanupStatus =
  | "not-needed"
  | "not-ready"
  | "ready"
  | "deferred"
  | "in-progress"
  | "completed"
  | "recovery-required";

export type PersistenceMigrationCleanupDeferredReason =
  "legacy-sync-queue-archive-unavailable";

export type PersistenceMigrationResult =
  | {
      status: "not-needed";
      dataMigrationStatus?: "not-needed";
      cleanupStatus?: "not-needed";
    }
  | {
      status: "completed" | "cleanup-pending";
      migratedKeys: string[];
      dataMigrationStatus?: "verified";
      cleanupStatus?: Exclude<
        PersistenceCleanupStatus,
        "not-needed" | "recovery-required"
      >;
    }
  | {
      status: "cleanup-pending";
      migratedKeys: [];
      dataMigrationStatus: "not-needed";
      cleanupStatus: "deferred";
      cleanupDeferredReason?: PersistenceMigrationCleanupDeferredReason;
    }
  | {
      status: "recovery-required";
      recoveryBundle: StartupRecoveryBundle;
      dataMigrationStatus?: PersistenceDataMigrationStatus;
      cleanupStatus?: PersistenceCleanupStatus;
    };

export type PersistenceLegacyCleanupSafetyRequest =
  | Omit<
      AutomaticPersistenceCleanupRequest<void>,
      "buildFlagValue" | "cleanupTask" | "lockManager"
    >
  | Omit<
      ManualPersistenceCleanupRequest<void>,
      "buildFlagValue" | "cleanupTask" | "lockManager"
    >;

export type PersistenceLegacyCleanupTaskDeferredReason =
  PersistenceCleanupPhysicalDeferredReason;

export type PersistenceLegacyCleanupTaskBlockedReason =
  PersistenceCleanupPhysicalBlockedReason;

export type PersistenceLegacyCleanupResult =
  | {
      status: "completed";
      mode: PersistenceCleanupMode;
      removedKeys: string[];
    }
  | {
      status: "cleanup-deferred";
      mode: PersistenceCleanupMode;
      reason:
        | PersistenceCleanupDeferredReason
        | PersistenceLegacyCleanupTaskDeferredReason;
      removedKeys: string[];
    }
  | {
      status: "cleanup-blocked";
      mode: PersistenceCleanupMode;
      reason:
        | PersistenceCleanupBlockedReason
        | PersistenceLegacyCleanupTaskBlockedReason;
      removedKeys: string[];
    };

export interface PersistenceRecordOperations {
  save<T>(storeName: StoreName, key: string, data: T): Promise<void>;
  load<T>(storeName: StoreName, key: string): Promise<LoadResult<T>>;
}
