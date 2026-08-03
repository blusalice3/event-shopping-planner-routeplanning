/**
 * IndexedDB ユーティリティ
 * localStorageの代わりに大容量データを保存するためのラッパー
 */

import type { MapDataStore } from "../types/map";
import {
  compactDayMapForStorage,
  compactMapDataForStorage,
  expandDayMapFromStorage,
  expandMapDataFromStorage,
  normalizeMapDataForPersistence,
} from "./mapDataPersistence";
import {
  createPersistenceCheckpointKey,
  createPersistenceDigest,
  createPersistenceMetadataKey,
  createPersistenceRevision,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  createRuntimeFallbackPrefix,
  createSynchronousFingerprint,
  createStartupRecoveryCandidateId,
  createStartupRecoveryBundle,
  getPersistenceWriterId,
  isPersistenceCheckpoint,
  isPersistenceDigestDescriptor,
  isPersistenceSynchronousFingerprint,
  parseRuntimeFallbackCandidate,
  reconcileRuntimeFallbackCandidates,
  serializeRuntimeFallbackCandidate,
  snapshotStartupRecoveryValue,
  verifyPersistenceDigest,
  type PersistenceCheckpoint,
  type PersistenceCheckpointAbsorbedCandidate,
  type PersistenceCheckpointCommittedRoot,
  type PersistenceDigestDescriptor,
  type PersistenceSynchronousFingerprint,
  type RuntimeFallbackCandidate,
  type StartupRecoveryBundle,
  type StartupRecoveryCandidate,
  type StartupRecoveryCandidateRole,
  type StartupRecoveryCandidateSource,
  type StartupRecoveryIssue,
  type StartupRecoveryLegacyMigrationConflict,
} from "./persistenceResilience";
import {
  coordinatePersistenceLegacyCleanup,
  emitPersistenceCleanupMetric,
  type AutomaticPersistenceCleanupRequest,
  type ManualPersistenceCleanupRequest,
  type PersistenceCleanupBlockedReason,
  type PersistenceCleanupDeferredReason,
  type PersistenceCleanupMode,
  type PersistenceCleanupPhysicalBlockedReason,
  type PersistenceCleanupPhysicalDeferredReason,
  type PersistenceCleanupTaskContext,
} from "./persistenceCleanupCoordinator";
import {
  recordPersistenceCleanupReleaseAMetric,
  recordPersistenceReleaseAMetric,
} from "./persistenceReleaseAMetrics";

const DB_NAME = "EventShoppingPlannerDB";
const DB_VERSION = 5;
const MAX_FORWARD_COMPATIBLE_DB_VERSION = 7;
const DATABASE_OPEN_BLOCKED_TIMEOUT_MS = 5_000;
const DATA_KEY = "data";
const MAP_DATA_LEGACY_KEY = "data";
const MAP_DATA_KEY_PREFIX = "mapData:";
const INTERNAL_RECORD_PREFIX = "__esp_internal__:";
const LEGACY_MIGRATION_JOURNAL_KEY =
  "__esp_internal__:migration:v1:legacy-local-storage";
const LEGACY_MIGRATION_SCHEMA_VERSION = 2;
const LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION = 1;
const LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX =
  "__esp_internal__:migration-archive:v1:";
const RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX =
  "__esp_internal__:recovery-adoption:v1:";
const RECOVERY_ADOPTION_RETENTION_KEY_PREFIX =
  "__esp_internal__:recovery-retain:v1:";
const LEGACY_MIGRATION_CONFLICT_RESOLUTION_KEY_PREFIX =
  "__esp_internal__:migration-resolution:v1:";
const LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION = 1;
const LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY = "syncQueue";

// ストア名
const STORES = {
  EVENT_LISTS: "eventLists",
  EVENT_METADATA: "eventMetadata",
  EXECUTE_MODE_ITEMS: "executeModeItems",
  DAY_MODES: "dayModes",
  MAP_DATA: "mapData",
  MAP_ROTATION_SETTINGS: "mapRotationSettings",
  ROUTE_SETTINGS: "routeSettings",
  HALL_DEFINITIONS: "hallDefinitions",
  HALL_ROUTE_SETTINGS: "hallRouteSettings",
  MAP_VIEWPORT_SETTINGS: "mapViewportSettings",
  SYNC_QUEUE: "syncQueue",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

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

interface ObservedRevisionRoot {
  storeName: StoreName;
  key: string;
  revision: string;
  baseRevision: string | null;
  payloadDigest: PersistenceDigestDescriptor;
  payloadFingerprint: PersistenceSynchronousFingerprint;
  writerId: string;
  committedAt: string;
  synthetic?: boolean;
  missing?: boolean;
  runtimeFallback?: boolean;
}

interface StoredPersistenceMetadata extends ObservedRevisionRoot {
  kind: "event-shopping-planner-persistence-metadata";
  version: 1;
}

type LegacyMigrationPhaseV1 =
  | "prepared"
  | "copied"
  | "verified"
  | "cleanupPending"
  | "completed";

type LegacyMigrationPhase =
  | "prepared"
  | "copied"
  | "verified"
  | "cleanup-ready"
  | "cleanup-in-progress"
  | "completed";

interface LegacyMigrationJournalEntry {
  legacyKey: string;
  storeName: Exclude<StoreName, "syncQueue">;
  rawValue: string;
  expectedRawDigest: PersistenceDigestDescriptor;
  payloadDigest: PersistenceDigestDescriptor;
  targetRevision: string;
  mapKeys: string[];
  cleanupStatus: "pending" | "deferred" | "in-progress" | "removed";
}

interface LegacyMigrationJournal {
  kind: "event-shopping-planner-legacy-migration";
  schemaVersion: typeof LEGACY_MIGRATION_SCHEMA_VERSION;
  sessionId: string;
  ownerId: string;
  phase: LegacyMigrationPhase;
  dataMigrationStatus: "prepared" | "copied" | "verified";
  cleanupStatus:
    | "not-ready"
    | "ready"
    | "deferred"
    | "in-progress"
    | "completed";
  archiveKey: string;
  createdAt: string;
  updatedAt: string;
  entries: LegacyMigrationJournalEntry[];
}

interface LegacyMigrationJournalEntryV1 {
  legacyKey: string;
  storeName: Exclude<StoreName, "syncQueue">;
  rawValue: string;
  rawDigest: PersistenceDigestDescriptor;
  payloadDigest: PersistenceDigestDescriptor;
  targetRevision: string;
  mapKeys: string[];
  cleanupStatus: "pending" | "retained" | "removed";
}

interface LegacyMigrationJournalV1 {
  kind: "event-shopping-planner-legacy-migration";
  schemaVersion: 1;
  sessionId: string;
  ownerId: string;
  phase: LegacyMigrationPhaseV1;
  createdAt: string;
  updatedAt: string;
  entries: LegacyMigrationJournalEntryV1[];
}

interface LegacyMigrationArchiveEntry {
  legacyKey: string;
  sourceKind: "migration-source" | "preserved-legacy-sync-queue";
  storeName: StoreName;
  rawValue: string;
  rawDigest: PersistenceDigestDescriptor;
  capturedAt: string;
}

interface LegacyMigrationArchive {
  kind: "event-shopping-planner-legacy-migration-archive";
  schemaVersion: typeof LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  entries: LegacyMigrationArchiveEntry[];
}

interface LegacyMigrationConflictResolution {
  kind: "event-shopping-planner-legacy-migration-conflict-resolution";
  schemaVersion: typeof LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION;
  decision: "retain-explicitly-adopted-root";
  decisionId: string;
  legacyKey: string;
  storeName: Exclude<StoreName, "syncQueue">;
  targetKey: typeof DATA_KEY;
  expectedLegacyRawDigest: PersistenceDigestDescriptor;
  selectedCandidate: {
    id: string;
    source: "indexedDB" | "runtime-fallback";
    sourceKey: string;
    revision: string;
    digest: PersistenceDigestDescriptor;
  };
  selectedRoot: PersistenceCheckpointCommittedRoot;
  committedRoot: PersistenceCheckpointCommittedRoot;
  adoptionArchiveKey: string;
  createdAt: string;
}

class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflict";
  }
}

class IndexedDBOpenBlockedError extends Error {
  constructor(timeoutMs: number) {
    super(
      `IndexedDB open request remained blocked for ${timeoutMs} milliseconds.`,
    );
    this.name = "IndexedDBOpenBlocked";
  }
}

let dbInstance: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase> | null = null;
const expectedRevisionRoots = new Map<string, ObservedRevisionRoot>();
const expectedPersistenceCheckpoints = new Map<
  string,
  PersistenceCheckpoint | null
>();
const persistenceWriterId = getPersistenceWriterId();

function getObservedRootKey(storeName: StoreName, key: string): string {
  return `${storeName}\u0000${key}`;
}

function isInternalRecordKey(key: IDBValidKey): boolean {
  return typeof key === "string" && key.startsWith(INTERNAL_RECORD_PREFIX);
}

function isPersistenceConflict(error: unknown): boolean {
  return (
    error instanceof PersistenceConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "PersistenceConflict")
  );
}

function readErrorName(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name?: unknown }).name === "string"
    ? ((error as { name: string }).name ?? "")
    : "";
}

function canUseRuntimeFallback(storeName: StoreName, error: unknown): boolean {
  if (storeName === STORES.MAP_DATA) return false;
  return ![
    "VersionError",
    "InvalidStateError",
    "PersistenceConflict",
    "DataCloneError",
  ].includes(readErrorName(error));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("IndexedDB transaction was aborted."),
      );
    transaction.onerror = () => {
      // onabort supplies the final transaction failure.
    };
  });
}

function fingerprintsEqual(left: unknown, right: unknown): boolean {
  try {
    const leftFingerprint = createSynchronousFingerprint(left);
    const rightFingerprint = createSynchronousFingerprint(right);
    return (
      leftFingerprint.algorithm === rightFingerprint.algorithm &&
      leftFingerprint.canonicalization === rightFingerprint.canonicalization &&
      leftFingerprint.canonicalLength === rightFingerprint.canonicalLength &&
      leftFingerprint.value === rightFingerprint.value
    );
  } catch {
    return false;
  }
}

function isStoredPersistenceMetadata(
  value: unknown,
  storeName: StoreName,
  key: string,
): value is StoredPersistenceMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredPersistenceMetadata>;
  return (
    candidate.kind === "event-shopping-planner-persistence-metadata" &&
    candidate.version === 1 &&
    candidate.storeName === storeName &&
    candidate.key === key &&
    typeof candidate.revision === "string" &&
    candidate.revision.length > 0 &&
    (candidate.baseRevision === null ||
      (typeof candidate.baseRevision === "string" &&
        candidate.baseRevision.length > 0)) &&
    isPersistenceDigestDescriptor(candidate.payloadDigest) &&
    isPersistenceSynchronousFingerprint(candidate.payloadFingerprint) &&
    typeof candidate.writerId === "string" &&
    candidate.writerId.length > 0 &&
    typeof candidate.committedAt === "string" &&
    Number.isFinite(Date.parse(candidate.committedAt))
  );
}

function checkpointCommittedRootMatches(
  checkpoint: PersistenceCheckpoint,
  root: ObservedRevisionRoot,
): boolean {
  return (
    checkpoint.committedRoot.revision === root.revision &&
    checkpoint.committedRoot.baseRevision === root.baseRevision &&
    checkpoint.committedRoot.digest.algorithm ===
      root.payloadDigest.algorithm &&
    checkpoint.committedRoot.digest.canonicalization ===
      root.payloadDigest.canonicalization &&
    checkpoint.committedRoot.digest.value === root.payloadDigest.value &&
    checkpoint.committedRoot.writerId === root.writerId &&
    checkpoint.committedRoot.committedAt === root.committedAt
  );
}

function validateCheckpointForRoot(
  value: unknown,
  storeName: StoreName,
  key: string,
  root: ObservedRevisionRoot,
): PersistenceCheckpoint | null {
  if (value === undefined || value === null) return null;
  if (
    !isPersistenceCheckpoint(value, { storeName, key }) ||
    !checkpointCommittedRootMatches(value, root)
  ) {
    throw new PersistenceConflictError(
      `${storeName}:${key} has an invalid persistence checkpoint.`,
    );
  }
  return value;
}

function assertStructuredCloneable(value: unknown): void {
  structuredClone(value);
}

function resetDbInstance() {
  dbOpenPromise = null;
  if (!dbInstance) return;
  try {
    dbInstance.close();
  } catch {
    // Ignore close failures; the next operation will open a fresh connection.
  }
  dbInstance = null;
}

function ensureStoreExists(db: IDBDatabase, storeName: StoreName) {
  if (!db.objectStoreNames.contains(storeName)) {
    throw new Error(`IndexedDB object store is missing: ${storeName}`);
  }
}

function isVersionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "VersionError"
  );
}

function createMissingStores(database: IDBDatabase): void {
  Object.values(STORES).forEach((storeName) => {
    if (!database.objectStoreNames.contains(storeName)) {
      database.createObjectStore(storeName);
    }
  });
}

function getMissingStores(database: IDBDatabase): StoreName[] {
  return Object.values(STORES).filter(
    (storeName) => !database.objectStoreNames.contains(storeName),
  );
}

function createDatabaseCompatibilityError(
  name: "InvalidStateError" | "VersionError",
  message: string,
): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function assertRequiredStoresCompatible(database: IDBDatabase): void {
  const missingStores = getMissingStores(database);
  if (missingStores.length > 0) {
    throw createDatabaseCompatibilityError(
      "InvalidStateError",
      `IndexedDB version ${database.version} is missing required object stores: ${missingStores.join(", ")}.`,
    );
  }

  const transaction = database.transaction(Object.values(STORES), "readonly");
  const incompatibleStores = Object.values(STORES).filter((storeName) => {
    const store = transaction.objectStore(storeName);
    return store.keyPath !== null || store.autoIncrement;
  });

  if (incompatibleStores.length > 0) {
    throw createDatabaseCompatibilityError(
      "InvalidStateError",
      `IndexedDB version ${database.version} has incompatible object stores: ${incompatibleStores.join(", ")}.`,
    );
  }
}

function requestDatabaseOpen(
  version: number | undefined,
  allowUpgrade: boolean,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(DB_NAME)
        : indexedDB.open(DB_NAME, version);
    let settled = false;
    let blockedTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearBlockedTimeout = () => {
      if (blockedTimeout === null) return;
      clearTimeout(blockedTimeout);
      blockedTimeout = null;
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearBlockedTimeout();
      reject(error);
    };

    request.onerror = () => {
      rejectOnce(request.error ?? new Error("Failed to open IndexedDB."));
    };

    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearBlockedTimeout();
      resolve(request.result);
    };

    request.onblocked = () => {
      console.warn("IndexedDB open request is blocked by another tab.");
      if (settled || blockedTimeout !== null) return;
      blockedTimeout = setTimeout(() => {
        rejectOnce(
          new IndexedDBOpenBlockedError(DATABASE_OPEN_BLOCKED_TIMEOUT_MS),
        );
      }, DATABASE_OPEN_BLOCKED_TIMEOUT_MS);
    };

    request.onupgradeneeded = () => {
      if (settled || !allowUpgrade) {
        request.transaction?.abort();
        return;
      }
      createMissingStores(request.result);
    };
  });
}

async function openForwardCompatibleDatabase(): Promise<IDBDatabase> {
  const currentDatabase = await requestDatabaseOpen(undefined, false);
  try {
    if (
      currentDatabase.version <= DB_VERSION ||
      currentDatabase.version > MAX_FORWARD_COMPATIBLE_DB_VERSION
    ) {
      throw createDatabaseCompatibilityError(
        "VersionError",
        `IndexedDB version ${currentDatabase.version} is outside the supported range ${DB_VERSION}-${MAX_FORWARD_COMPATIBLE_DB_VERSION}.`,
      );
    }
    assertRequiredStoresCompatible(currentDatabase);
    return currentDatabase;
  } catch (error) {
    currentDatabase.close();
    throw error;
  }
}

function registerDbInstance(database: IDBDatabase): IDBDatabase {
  dbInstance = database;
  database.onversionchange = () => {
    if (dbInstance === database) {
      resetDbInstance();
      return;
    }
    database.close();
  };
  database.onclose = () => {
    if (dbInstance === database) {
      dbInstance = null;
    }
  };
  return database;
}

function getMapDataEntryKey(eventName: string, dayMapName: string): string {
  return `${MAP_DATA_KEY_PREFIX}${JSON.stringify([eventName, dayMapName])}`;
}

function parseMapDataEntryKey(key: string): [string, string] | null {
  if (!key.startsWith(MAP_DATA_KEY_PREFIX)) return null;

  try {
    const parsed = JSON.parse(key.slice(MAP_DATA_KEY_PREFIX.length));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Ignore invalid split-map keys; legacy data is handled separately.
  }

  return null;
}

async function deleteDataFromIndexedDb(
  storeName: StoreName,
  key: string,
): Promise<void> {
  const db = await openDB();
  ensureStoreExists(db, storeName);

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onerror = () => {
      console.error(`Failed to delete from ${storeName}.`);
      reject(request.error);
    };

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onabort = () => {
      reject(transaction.error || request.error);
    };
  });
}

/**
 * データベースを開く
 */
function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  if (dbOpenPromise) {
    return dbOpenPromise;
  }

  const pendingOpen = (async () => {
    try {
      const database = await requestDatabaseOpen(DB_VERSION, true);
      try {
        assertRequiredStoresCompatible(database);
        return registerDbInstance(database);
      } catch (error) {
        database.close();
        throw error;
      }
    } catch (error) {
      if (!isVersionError(error)) {
        throw error;
      }

      // A newer release may already have upgraded this browser's database.
      // Opening without a version uses that existing version and never
      // downgrades or deletes its data.
      return registerDbInstance(await openForwardCompatibleDatabase());
    }
  })().catch((error) => {
    console.error("IndexedDB open failed.");
    throw error;
  });

  dbOpenPromise = pendingOpen;
  pendingOpen.then(
    () => {
      if (dbOpenPromise === pendingOpen) {
        dbOpenPromise = null;
      }
    },
    () => {
      if (dbOpenPromise === pendingOpen) {
        dbOpenPromise = null;
      }
    },
  );

  return pendingOpen;
}

interface RawPersistenceSnapshot {
  payload: unknown;
  metadata: unknown;
  checkpoint: unknown;
}

interface ValidatedPersistenceSnapshot<T> {
  status: "ok" | "missing";
  data: T | null;
  root: ObservedRevisionRoot;
  checkpoint: PersistenceCheckpoint | null;
}

function toRecoveryPrimitive(value: unknown): unknown {
  return snapshotStartupRecoveryValue(value);
}

function createRecoveryIssue(
  stage: string,
  code: string,
  message: string,
  storeName?: StoreName,
): StartupRecoveryIssue {
  return {
    stage,
    code,
    message,
    ...(storeName ? { storeName } : {}),
  } as StartupRecoveryIssue;
}

type RecoveryCandidateDigest =
  | PersistenceDigestDescriptor
  | PersistenceSynchronousFingerprint;

interface RecoveryCandidateOptions {
  role?: StartupRecoveryCandidateRole;
  sourceKey?: string;
  targetKey?: string;
  digest?: RecoveryCandidateDigest;
  adoptable?: boolean;
  migrationConflict?: StartupRecoveryLegacyMigrationConflict;
}

function inferRecoveryCandidateRole(
  source: StartupRecoveryCandidateSource,
  key: string,
): StartupRecoveryCandidateRole {
  if (source === "legacy-localStorage") return "legacy-migration-source";
  if (source === "migration-journal") {
    return key.startsWith(LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX)
      ? "migration-archive"
      : "migration-journal";
  }
  if (key.startsWith("__esp_internal__:checkpoint:")) {
    return "persistence-checkpoint";
  }
  if (key.startsWith("__esp_internal__:meta:")) {
    return "persistence-metadata";
  }
  return "app-payload";
}

function createRecoveryCandidate(
  source: StartupRecoveryCandidateSource,
  storeName: StoreName,
  key: string,
  revision: string | null,
  payload: unknown,
  rawValue?: string,
  options: RecoveryCandidateOptions = {},
): StartupRecoveryCandidate {
  const safePayload = toRecoveryPrimitive(payload);
  const role = options.role ?? inferRecoveryCandidateRole(source, key);
  const sourceKey = options.sourceKey ?? key;
  const targetKey =
    options.targetKey ?? (role === "app-payload" ? DATA_KEY : undefined);
  let digest = options.digest;
  if (!digest) {
    try {
      digest = createSynchronousFingerprint(safePayload);
    } catch {
      digest = undefined;
    }
  }
  const digestFields = digest
    ? {
        digest: digest.value,
        digestAlgorithm: digest.algorithm,
        digestCanonicalization: digest.canonicalization,
        ...("canonicalLength" in digest
          ? { digestCanonicalLength: digest.canonicalLength }
          : {}),
      }
    : {};
  const adoptableByShape =
    role === "app-payload" &&
    (source === "indexedDB" || source === "runtime-fallback") &&
    storeName !== STORES.SYNC_QUEUE &&
    key === DATA_KEY &&
    targetKey === DATA_KEY &&
    digest !== undefined &&
    (source !== "runtime-fallback" || revision !== null);
  const identity = {
    source,
    role,
    storeName,
    sourceKey,
    targetKey,
    ...(revision === null ? {} : { revision }),
    ...digestFields,
    ...(options.migrationConflict
      ? { migrationConflict: options.migrationConflict }
      : {}),
  };
  return {
    id: createStartupRecoveryCandidateId(identity),
    source,
    role,
    adoptable: options.adoptable ?? adoptableByShape,
    storeName,
    key,
    sourceKey,
    ...(targetKey === undefined ? {} : { targetKey }),
    ...(revision === null ? {} : { revision }),
    ...digestFields,
    payload: safePayload,
    ...(rawValue === undefined ? {} : { rawValue }),
    ...(options.migrationConflict
      ? { migrationConflict: options.migrationConflict }
      : {}),
  };
}

function createRecoveryBundle(
  issues: StartupRecoveryIssue[],
  candidates: StartupRecoveryCandidate[] = [],
): StartupRecoveryBundle {
  return createStartupRecoveryBundle({
    issues,
    candidates,
  });
}

function createConflictLoadResult<T>(
  message: string,
  storeName: StoreName,
  candidates: StartupRecoveryCandidate[],
): LoadResult<T> {
  const error = new PersistenceConflictError(message);
  return {
    status: "conflict",
    data: null,
    error,
    recoveryBundle: createRecoveryBundle(
      [createRecoveryIssue("load", "PersistenceConflict", message, storeName)],
      candidates,
    ),
  };
}

async function readPersistenceSnapshotOnce(
  storeName: StoreName,
  key: string,
): Promise<RawPersistenceSnapshot> {
  const database = await openDB();
  ensureStoreExists(database, storeName);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const transactionStores =
    storeName === STORES.SYNC_QUEUE
      ? [STORES.SYNC_QUEUE]
      : [storeName, STORES.SYNC_QUEUE];
  const transaction = database.transaction(transactionStores, "readonly");
  const finished = transactionFinished(transaction);
  const payloadRequest = transaction.objectStore(storeName).get(key);
  const metadataRequest = transaction
    .objectStore(STORES.SYNC_QUEUE)
    .get(createPersistenceMetadataKey(storeName, key));
  const checkpointRequest = transaction
    .objectStore(STORES.SYNC_QUEUE)
    .get(createPersistenceCheckpointKey(storeName, key));
  const [payload, metadata, checkpoint] = await Promise.all([
    requestResult(payloadRequest),
    requestResult(metadataRequest),
    requestResult(checkpointRequest),
  ]);
  await finished;
  return { payload, metadata, checkpoint };
}

async function readPersistenceSnapshotWithRetry(
  storeName: StoreName,
  key: string,
): Promise<RawPersistenceSnapshot> {
  try {
    return await readPersistenceSnapshotOnce(storeName, key);
  } catch (firstError) {
    resetDbInstance();
    try {
      return await readPersistenceSnapshotOnce(storeName, key);
    } catch (retryError) {
      resetDbInstance();
      throw retryError ?? firstError;
    }
  }
}

function createSyntheticRevision(
  storeName: StoreName,
  key: string,
  digest: PersistenceDigestDescriptor,
): string {
  return `synthetic:v1:${encodeURIComponent(storeName)}:${encodeURIComponent(
    key,
  )}:${encodeURIComponent(JSON.stringify(digest))}`;
}

async function createSyntheticRoot(
  storeName: StoreName,
  key: string,
  payload: unknown,
  missing = false,
): Promise<ObservedRevisionRoot> {
  const payloadDigest = await createPersistenceDigest(payload);
  return {
    storeName,
    key,
    revision: createSyntheticRevision(storeName, key, payloadDigest),
    baseRevision: null,
    payloadDigest,
    payloadFingerprint: createSynchronousFingerprint(payload),
    writerId: "synthetic",
    committedAt: "",
    synthetic: true,
    missing,
  };
}

async function validatePersistenceSnapshot<T>(
  storeName: StoreName,
  key: string,
  snapshot: RawPersistenceSnapshot,
): Promise<
  | { validated: ValidatedPersistenceSnapshot<T> }
  | {
      conflict: LoadResult<T>;
      checkpointConflict?: true;
    }
> {
  const payloadMissing =
    snapshot.payload === undefined || snapshot.payload === null;
  const metadataMissing =
    snapshot.metadata === undefined || snapshot.metadata === null;
  const checkpointMissing =
    snapshot.checkpoint === undefined || snapshot.checkpoint === null;

  if (payloadMissing && metadataMissing) {
    if (!checkpointMissing) {
      return {
        conflict: createConflictLoadResult(
          `${storeName} の吸収checkpointだけが残っているため、安全に読み込めません。`,
          storeName,
          [
            createRecoveryCandidate(
              "indexedDB",
              storeName,
              createPersistenceCheckpointKey(storeName, key),
              null,
              snapshot.checkpoint,
            ),
          ],
        ),
        checkpointConflict: true,
      };
    }
    const root = await createSyntheticRoot(storeName, key, null, true);
    return {
      validated: {
        status: "missing",
        data: null,
        root,
        checkpoint: null,
      },
    };
  }

  if (payloadMissing) {
    return {
      conflict: createConflictLoadResult(
        `${storeName} の世代情報だけが残っており、対応する保存データがありません。`,
        storeName,
        [
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            createPersistenceMetadataKey(storeName, key),
            isStoredPersistenceMetadata(snapshot.metadata, storeName, key)
              ? snapshot.metadata.revision
              : null,
            snapshot.metadata,
          ),
        ],
      ),
    };
  }

  if (metadataMissing) {
    if (!checkpointMissing) {
      return {
        conflict: createConflictLoadResult(
          `${storeName} のpayloadと吸収checkpointに対応する世代情報がありません。`,
          storeName,
          [
            createRecoveryCandidate(
              "indexedDB",
              storeName,
              key,
              null,
              snapshot.payload,
            ),
            createRecoveryCandidate(
              "indexedDB",
              storeName,
              createPersistenceCheckpointKey(storeName, key),
              null,
              snapshot.checkpoint,
            ),
          ],
        ),
        checkpointConflict: true,
      };
    }
    try {
      const root = await createSyntheticRoot(storeName, key, snapshot.payload);
      return {
        validated: {
          status: "ok",
          data: snapshot.payload as T,
          root,
          checkpoint: null,
        },
      };
    } catch {
      return {
        conflict: createConflictLoadResult(
          `${storeName} のmetadata未付与データを安全に識別できません。`,
          storeName,
          [
            createRecoveryCandidate(
              "indexedDB",
              storeName,
              key,
              null,
              snapshot.payload,
            ),
          ],
        ),
      };
    }
  }

  if (!isStoredPersistenceMetadata(snapshot.metadata, storeName, key)) {
    return {
      conflict: createConflictLoadResult(
        `${storeName} の世代情報が不正なため、保存データを上書きできません。`,
        storeName,
        [
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            key,
            null,
            snapshot.payload,
          ),
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            createPersistenceMetadataKey(storeName, key),
            null,
            snapshot.metadata,
          ),
        ],
      ),
    };
  }

  let digestValid = false;
  let fingerprintValid = false;
  try {
    digestValid = await verifyPersistenceDigest(
      snapshot.payload,
      snapshot.metadata.payloadDigest,
    );
    fingerprintValid = fingerprintsEqual(
      createSynchronousFingerprint(snapshot.payload),
      snapshot.metadata.payloadFingerprint,
    );
  } catch {
    // Unsupported or cyclic future payloads remain available in recovery.
  }
  if (!digestValid || !fingerprintValid) {
    return {
      conflict: createConflictLoadResult(
        `${storeName} の保存データと世代情報が一致しないため、安全に読み込めません。`,
        storeName,
        [
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            key,
            snapshot.metadata.revision,
            snapshot.payload,
          ),
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            createPersistenceMetadataKey(storeName, key),
            snapshot.metadata.revision,
            snapshot.metadata,
          ),
        ],
      ),
    };
  }

  let checkpoint: PersistenceCheckpoint | null;
  try {
    checkpoint = validateCheckpointForRoot(
      snapshot.checkpoint,
      storeName,
      key,
      snapshot.metadata,
    );
  } catch {
    return {
      conflict: createConflictLoadResult(
        `${storeName} の吸収checkpointが確定rootと一致しません。`,
        storeName,
        [
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            key,
            snapshot.metadata.revision,
            snapshot.payload,
          ),
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            createPersistenceCheckpointKey(storeName, key),
            snapshot.metadata.revision,
            snapshot.checkpoint,
          ),
        ],
      ),
      checkpointConflict: true,
    };
  }

  return {
    validated: {
      status: "ok",
      data: snapshot.payload as T,
      root: snapshot.metadata,
      checkpoint,
    },
  };
}

function createStoredMetadata(
  storeName: StoreName,
  key: string,
  revision: string,
  baseRevision: string | null,
  payloadDigest: PersistenceDigestDescriptor,
  payloadFingerprint: PersistenceSynchronousFingerprint,
): StoredPersistenceMetadata {
  return {
    kind: "event-shopping-planner-persistence-metadata",
    version: 1,
    storeName,
    key,
    revision,
    baseRevision,
    payloadDigest,
    payloadFingerprint,
    writerId: persistenceWriterId,
    committedAt: new Date().toISOString(),
  };
}

function createObservedRootFromRuntimeCandidate(
  candidate: RuntimeFallbackCandidate,
): ObservedRevisionRoot {
  return {
    storeName: candidate.storeName as StoreName,
    key: candidate.key,
    revision: candidate.revision,
    baseRevision: candidate.baseRevision,
    payloadDigest: candidate.digest,
    payloadFingerprint: createSynchronousFingerprint(candidate.payload),
    writerId: candidate.writerId,
    committedAt: candidate.createdAt,
    runtimeFallback: true,
  };
}

interface RuntimeCandidateSnapshot<T> {
  storageKey: string;
  rawValue: string;
  candidate: RuntimeFallbackCandidate<T>;
}

function checkpointDescriptorFromRuntimeCandidate(
  candidate: RuntimeFallbackCandidate,
): PersistenceCheckpointAbsorbedCandidate {
  return {
    schemaVersion: candidate.schemaVersion,
    revision: candidate.revision,
    baseRevision: candidate.baseRevision,
    digest: candidate.digest,
    writerId: candidate.writerId,
    createdAt: candidate.createdAt,
  };
}

function checkpointDescriptorMatchesRuntimeCandidate(
  descriptor: PersistenceCheckpointAbsorbedCandidate,
  candidate: RuntimeFallbackCandidate,
): boolean {
  return (
    descriptor.schemaVersion === candidate.schemaVersion &&
    descriptor.revision === candidate.revision &&
    descriptor.baseRevision === candidate.baseRevision &&
    descriptor.digest.algorithm === candidate.digest.algorithm &&
    descriptor.digest.canonicalization === candidate.digest.canonicalization &&
    descriptor.digest.value === candidate.digest.value &&
    descriptor.writerId === candidate.writerId &&
    descriptor.createdAt === candidate.createdAt
  );
}

function checkpointRecordsRuntimeCandidate(
  checkpoint: PersistenceCheckpoint | null,
  candidate: RuntimeFallbackCandidate,
): boolean {
  if (!checkpoint) return false;
  const committed = checkpoint.committedRoot;
  if (
    committed.revision === candidate.revision &&
    committed.baseRevision === candidate.baseRevision &&
    committed.digest.algorithm === candidate.digest.algorithm &&
    committed.digest.canonicalization === candidate.digest.canonicalization &&
    committed.digest.value === candidate.digest.value &&
    committed.writerId === candidate.writerId &&
    committed.committedAt === candidate.createdAt
  ) {
    return true;
  }
  return checkpoint.absorbedCandidates.some((descriptor) =>
    checkpointDescriptorMatchesRuntimeCandidate(descriptor, candidate),
  );
}

function partitionRuntimeCandidateSnapshots<T>(
  checkpoint: PersistenceCheckpoint | null,
  snapshots: readonly RuntimeCandidateSnapshot<T>[],
): {
  absorbed: RuntimeCandidateSnapshot<T>[];
  active: RuntimeCandidateSnapshot<T>[];
} {
  const absorbed: RuntimeCandidateSnapshot<T>[] = [];
  const active: RuntimeCandidateSnapshot<T>[] = [];
  snapshots.forEach((snapshot) => {
    (checkpointRecordsRuntimeCandidate(checkpoint, snapshot.candidate)
      ? absorbed
      : active
    ).push(snapshot);
  });
  return { absorbed, active };
}

function createNextPersistenceCheckpoint(
  storeName: StoreName,
  key: string,
  metadata: StoredPersistenceMetadata,
  previous: PersistenceCheckpoint | null,
  absorbedSnapshots: readonly RuntimeCandidateSnapshot<unknown>[] = [],
): PersistenceCheckpoint {
  const absorbedByRevision = new Map(
    (previous?.absorbedCandidates ?? []).map((descriptor) => [
      descriptor.revision,
      descriptor,
    ]),
  );
  absorbedSnapshots.forEach(({ candidate }) => {
    const descriptor = checkpointDescriptorFromRuntimeCandidate(candidate);
    const existing = absorbedByRevision.get(descriptor.revision);
    if (existing && !fingerprintsEqual(existing, descriptor)) {
      throw new PersistenceConflictError(
        `${storeName}:${key} has conflicting absorbed candidate metadata.`,
      );
    }
    absorbedByRevision.set(descriptor.revision, descriptor);
  });
  return {
    kind: "event-shopping-planner-persistence-checkpoint",
    version: 1,
    storeName,
    key,
    committedRoot: {
      revision: metadata.revision,
      baseRevision: metadata.baseRevision,
      digest: metadata.payloadDigest,
      writerId: metadata.writerId,
      committedAt: metadata.committedAt,
    },
    absorbedCandidates: Array.from(absorbedByRevision.values()).sort(
      (left, right) => left.revision.localeCompare(right.revision),
    ),
    updatedAt: new Date().toISOString(),
  };
}

async function readRuntimeCandidateSnapshots<T>(
  storeName: StoreName,
  key: string,
): Promise<
  | { status: "ok"; snapshots: RuntimeCandidateSnapshot<T>[] }
  | { status: "conflict"; result: LoadResult<T> }
> {
  const prefix = createRuntimeFallbackPrefix(storeName, key);
  const candidateKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const candidateKey = localStorage.key(index);
    if (candidateKey?.startsWith(prefix)) {
      candidateKeys.push(candidateKey);
    }
  }
  candidateKeys.sort();

  const snapshots: RuntimeCandidateSnapshot<T>[] = [];
  const invalidCandidates: StartupRecoveryCandidate[] = [];
  const issues: StartupRecoveryIssue[] = [];
  for (const storageKey of candidateKeys) {
    const rawValue = localStorage.getItem(storageKey);
    if (rawValue === null) continue;

    try {
      const encodedRevision = storageKey.slice(prefix.length);
      const revision = decodeURIComponent(encodedRevision);
      if (!revision || encodeURIComponent(revision) !== encodedRevision) {
        throw new Error("Runtime fallback key contains an invalid revision.");
      }
      const candidate = parseRuntimeFallbackCandidate<T>(rawValue, {
        storeName,
        key,
        revision,
      });
      if (
        !(await verifyPersistenceDigest(candidate.payload, candidate.digest))
      ) {
        throw new Error("Runtime fallback digest does not match its payload.");
      }
      snapshots.push({ storageKey, rawValue, candidate });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Runtime fallback candidate is invalid.";
      issues.push(
        createRecoveryIssue(
          "fallback-reconcile",
          readErrorName(error) || "PersistenceEnvelopeError",
          `${storeName} の退避候補を検証できません: ${message}`,
          storeName,
        ),
      );
      invalidCandidates.push(
        createRecoveryCandidate(
          "runtime-fallback",
          storeName,
          key,
          null,
          null,
          rawValue,
          {
            role: "invalid-source",
            sourceKey: storageKey,
            adoptable: false,
          },
        ),
      );
    }
  }

  if (issues.length > 0) {
    const error = new PersistenceConflictError(
      `${storeName} に検証できない退避候補があります。`,
    );
    return {
      status: "conflict",
      result: {
        status: "conflict",
        data: null,
        error,
        recoveryBundle: createRecoveryBundle(issues, [
          ...invalidCandidates,
          ...runtimeSnapshotsToRecoveryCandidates(storeName, key, snapshots),
        ]),
      },
    };
  }

  return { status: "ok", snapshots };
}

function runtimeSnapshotsToRecoveryCandidates(
  storeName: StoreName,
  key: string,
  snapshots: readonly RuntimeCandidateSnapshot<unknown>[],
  migrationConflict?: StartupRecoveryLegacyMigrationConflict,
): StartupRecoveryCandidate[] {
  return snapshots.map(({ storageKey, candidate, rawValue }) =>
    createRecoveryCandidate(
      "runtime-fallback",
      storeName,
      key,
      candidate.revision,
      candidate.payload,
      rawValue,
      {
        sourceKey: storageKey,
        digest: candidate.digest,
        ...(migrationConflict ? { migrationConflict } : {}),
      },
    ),
  );
}

interface RecoveryAdoptionRetentionMarker {
  kind: "event-shopping-planner-recovery-adoption-retention";
  version: 1;
  storageKey: string;
  rawFingerprint: PersistenceSynchronousFingerprint;
}

function createRecoveryAdoptionRetentionKey(storageKey: string): string {
  const fingerprint = createSynchronousFingerprint(storageKey);
  return `${RECOVERY_ADOPTION_RETENTION_KEY_PREFIX}${fingerprint.value}`;
}

function createRecoveryAdoptionRetentionMarker(
  snapshot: RuntimeCandidateSnapshot<unknown>,
): RecoveryAdoptionRetentionMarker {
  return {
    kind: "event-shopping-planner-recovery-adoption-retention",
    version: 1,
    storageKey: snapshot.storageKey,
    rawFingerprint: createSynchronousFingerprint(snapshot.rawValue),
  };
}

function isRecoveryAdoptionRetentionMarker(
  value: unknown,
  snapshot: RuntimeCandidateSnapshot<unknown>,
): boolean {
  if (!isPlainRecord(value)) return false;
  const expected = createRecoveryAdoptionRetentionMarker(snapshot);
  return (
    value.kind === expected.kind &&
    value.version === expected.version &&
    value.storageKey === expected.storageKey &&
    isPersistenceSynchronousFingerprint(value.rawFingerprint) &&
    fingerprintsEqual(value.rawFingerprint, expected.rawFingerprint)
  );
}

function runtimeCandidateIsRetainedForRecoveryAdoption(
  snapshot: RuntimeCandidateSnapshot<unknown>,
): boolean {
  const rawMarker = localStorage.getItem(
    createRecoveryAdoptionRetentionKey(snapshot.storageKey),
  );
  if (rawMarker === null) return false;
  try {
    return isRecoveryAdoptionRetentionMarker(JSON.parse(rawMarker), snapshot);
  } catch {
    return false;
  }
}

function retainRuntimeCandidatesForRecoveryAdoption(
  snapshots: readonly RuntimeCandidateSnapshot<unknown>[],
): void {
  snapshots.forEach((snapshot) => {
    const markerKey = createRecoveryAdoptionRetentionKey(snapshot.storageKey);
    const marker = createRecoveryAdoptionRetentionMarker(snapshot);
    const serialized = JSON.stringify(marker);
    localStorage.setItem(markerKey, serialized);
    if (
      localStorage.getItem(markerKey) !== serialized ||
      !runtimeCandidateIsRetainedForRecoveryAdoption(snapshot)
    ) {
      throw new PersistenceConflictError("Failed to retain a recovery source.");
    }
  });
}

function cleanupRuntimeCandidateSnapshots(
  snapshots: readonly RuntimeCandidateSnapshot<unknown>[],
): void {
  snapshots.forEach((snapshot) => {
    const { storageKey, rawValue } = snapshot;
    try {
      if (runtimeCandidateIsRetainedForRecoveryAdoption(snapshot)) return;
      if (localStorage.getItem(storageKey) !== rawValue) return;
      localStorage.removeItem(storageKey);
      if (localStorage.getItem(storageKey) !== null) {
        throw new Error("Runtime fallback remained after cleanup.");
      }
    } catch {
      console.warn("Failed to clean a committed runtime fallback.");
    }
  });
}

function immutableObservedRootFieldsMatch(
  current: ObservedRevisionRoot,
  expected: ObservedRevisionRoot,
): boolean {
  return (
    current.revision === expected.revision &&
    current.baseRevision === expected.baseRevision &&
    current.writerId === expected.writerId &&
    current.committedAt === expected.committedAt &&
    current.payloadDigest.algorithm === expected.payloadDigest.algorithm &&
    current.payloadDigest.canonicalization ===
      expected.payloadDigest.canonicalization &&
    current.payloadDigest.value === expected.payloadDigest.value &&
    fingerprintsEqual(current.payloadFingerprint, expected.payloadFingerprint)
  );
}

function assertCurrentSnapshotMatchesExpected(
  storeName: StoreName,
  key: string,
  payload: unknown,
  metadata: unknown,
  expected: ObservedRevisionRoot,
): void {
  const payloadMissing = payload === undefined || payload === null;
  const metadataMissing = metadata === undefined || metadata === null;

  if (expected.synthetic) {
    if (!metadataMissing) {
      throw new PersistenceConflictError(
        `${storeName}:${key} was updated by another writer.`,
      );
    }
    if (expected.missing) {
      if (!payloadMissing) {
        throw new PersistenceConflictError(
          `${storeName}:${key} was created by another writer.`,
        );
      }
      return;
    }
    if (
      payloadMissing ||
      !fingerprintsEqual(
        createSynchronousFingerprint(payload),
        expected.payloadFingerprint,
      )
    ) {
      throw new PersistenceConflictError(
        `${storeName}:${key} legacy payload changed before commit.`,
      );
    }
    return;
  }

  if (
    payloadMissing ||
    !isStoredPersistenceMetadata(metadata, storeName, key) ||
    !immutableObservedRootFieldsMatch(metadata, expected) ||
    !fingerprintsEqual(
      createSynchronousFingerprint(payload),
      expected.payloadFingerprint,
    )
  ) {
    throw new PersistenceConflictError(
      `${storeName}:${key} changed after it was last observed.`,
    );
  }
}

function assertCurrentCheckpointMatchesExpected(
  storeName: StoreName,
  key: string,
  current: unknown,
  expected: PersistenceCheckpoint | null,
): void {
  const currentMissing = current === undefined || current === null;
  if (expected === null) {
    if (!currentMissing) {
      throw new PersistenceConflictError(
        `${storeName}:${key} checkpoint was created by another writer.`,
      );
    }
    return;
  }
  if (
    currentMissing ||
    !isPersistenceCheckpoint(current, { storeName, key }) ||
    !fingerprintsEqual(current, expected)
  ) {
    throw new PersistenceConflictError(
      `${storeName}:${key} checkpoint changed after it was last observed.`,
    );
  }
}

function observedRootsMatch(
  current: ObservedRevisionRoot,
  expected: ObservedRevisionRoot,
): boolean {
  return (
    immutableObservedRootFieldsMatch(current, expected) &&
    Boolean(current.missing) === Boolean(expected.missing) &&
    Boolean(current.synthetic) === Boolean(expected.synthetic)
  );
}

async function assertPhysicalRootMatchesLogicalFallback(
  storeName: StoreName,
  key: string,
  physicalRoot: ObservedRevisionRoot,
  physicalCheckpoint: PersistenceCheckpoint | null,
  logicalExpected: ObservedRevisionRoot,
): Promise<RuntimeCandidateSnapshot<unknown>[]> {
  if (!logicalExpected.runtimeFallback) {
    if (observedRootsMatch(physicalRoot, logicalExpected)) {
      return [];
    }
    throw new PersistenceConflictError(
      `${storeName}:${key} is not backed by a runtime fallback.`,
    );
  }

  const candidateScan = await readRuntimeCandidateSnapshots<unknown>(
    storeName,
    key,
  );
  if (candidateScan.status === "conflict") {
    throw (
      candidateScan.result.error ??
      new PersistenceConflictError(
        `${storeName}:${key} has an invalid runtime fallback lineage.`,
      )
    );
  }
  const partitioned = partitionRuntimeCandidateSnapshots(
    physicalCheckpoint,
    candidateScan.snapshots,
  );

  const reconciliation = reconcileRuntimeFallbackCandidates(
    {
      revision: physicalRoot.missing ? null : physicalRoot.revision,
      baseRevision: physicalRoot.missing ? null : physicalRoot.baseRevision,
      digest: physicalRoot.missing ? undefined : physicalRoot.payloadDigest,
      writerId: physicalRoot.missing ? undefined : physicalRoot.writerId,
      createdAt: physicalRoot.missing ? undefined : physicalRoot.committedAt,
    },
    partitioned.active.map(({ candidate }) => candidate),
    physicalCheckpoint?.absorbedCandidates ?? [],
  );
  if (reconciliation.status === "conflict") {
    throw new PersistenceConflictError(
      `${storeName}:${key} has a conflicting runtime fallback lineage.`,
    );
  }

  if (reconciliation.head) {
    const reconciledHead = createObservedRootFromRuntimeCandidate(
      reconciliation.head,
    );
    if (observedRootsMatch(reconciledHead, logicalExpected)) {
      return candidateScan.snapshots;
    }
  } else if (observedRootsMatch(physicalRoot, logicalExpected)) {
    return candidateScan.snapshots;
  }

  throw new PersistenceConflictError(
    `${storeName}:${key} no longer matches the fallback lineage.`,
  );
}

async function writeDataWithMetadataOnce<T>(
  storeName: StoreName,
  key: string,
  data: T,
  expected: ObservedRevisionRoot,
  expectedCheckpoint: PersistenceCheckpoint | null,
  metadata: StoredPersistenceMetadata,
  checkpoint: PersistenceCheckpoint,
): Promise<void> {
  const database = await openDB();
  ensureStoreExists(database, storeName);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const transactionStores =
    storeName === STORES.SYNC_QUEUE
      ? [STORES.SYNC_QUEUE]
      : [storeName, STORES.SYNC_QUEUE];

  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(transactionStores, "readwrite");
    } catch (error) {
      reject(error);
      return;
    }

    let failure: unknown = null;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      failure = failure ?? transaction.error;
    };
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error(`Failed to write ${storeName}:${key}.`),
      );

    try {
      const payloadStore = transaction.objectStore(storeName);
      const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);
      const payloadRequest = payloadStore.get(key);
      const metadataKey = createPersistenceMetadataKey(storeName, key);
      const metadataRequest = controlStore.get(metadataKey);
      const checkpointKey = createPersistenceCheckpointKey(storeName, key);
      const checkpointRequest = controlStore.get(checkpointKey);
      let currentPayload: unknown;
      let currentMetadata: unknown;
      let currentCheckpoint: unknown;
      let payloadLoaded = false;
      let metadataLoaded = false;
      let checkpointLoaded = false;
      let writesQueued = false;

      const abortWith = (error: unknown) => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      };
      const commitIfReady = () => {
        if (
          writesQueued ||
          !payloadLoaded ||
          !metadataLoaded ||
          !checkpointLoaded
        )
          return;
        writesQueued = true;
        try {
          assertCurrentSnapshotMatchesExpected(
            storeName,
            key,
            currentPayload,
            currentMetadata,
            expected,
          );
          assertCurrentCheckpointMatchesExpected(
            storeName,
            key,
            currentCheckpoint,
            expectedCheckpoint,
          );
          const payloadPut = payloadStore.put(data, key);
          const metadataPut = controlStore.put(metadata, metadataKey);
          const checkpointPut = controlStore.put(checkpoint, checkpointKey);
          payloadPut.onerror = () => {
            failure = failure ?? payloadPut.error;
          };
          metadataPut.onerror = () => {
            failure = failure ?? metadataPut.error;
          };
          checkpointPut.onerror = () => {
            failure = failure ?? checkpointPut.error;
          };
        } catch (error) {
          abortWith(error);
        }
      };

      payloadRequest.onerror = () => {
        failure =
          failure ??
          payloadRequest.error ??
          new Error(`Failed to read ${storeName}:${key} before write.`);
      };
      payloadRequest.onsuccess = () => {
        currentPayload = payloadRequest.result;
        payloadLoaded = true;
        commitIfReady();
      };
      metadataRequest.onerror = () => {
        failure =
          failure ??
          metadataRequest.error ??
          new Error(`Failed to read metadata for ${storeName}:${key}.`);
      };
      metadataRequest.onsuccess = () => {
        currentMetadata = metadataRequest.result;
        metadataLoaded = true;
        commitIfReady();
      };
      checkpointRequest.onerror = () => {
        failure =
          failure ??
          checkpointRequest.error ??
          new Error(`Failed to read checkpoint for ${storeName}:${key}.`);
      };
      checkpointRequest.onsuccess = () => {
        currentCheckpoint = checkpointRequest.result;
        checkpointLoaded = true;
        commitIfReady();
      };
    } catch (error) {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    }
  });
}

async function prepareMetadataForPayload(
  storeName: StoreName,
  key: string,
  data: unknown,
  baseRevision: string | null,
  revision = createPersistenceRevision(persistenceWriterId),
): Promise<StoredPersistenceMetadata> {
  assertStructuredCloneable(data);
  const payloadFingerprint = createSynchronousFingerprint(data);
  const payloadDigest = await createPersistenceDigest(data);
  return createStoredMetadata(
    storeName,
    key,
    revision,
    baseRevision,
    payloadDigest,
    payloadFingerprint,
  );
}

interface RawMapSnapshot {
  entries: Record<string, unknown>;
  metadata: unknown;
  checkpoint: unknown;
}

function readMapEntriesFromStore(
  store: IDBObjectStore,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const result: Record<string, unknown> = {};
    const request = store.openCursor();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to enumerate mapData."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(result);
        return;
      }
      result[String(cursor.key)] = cursor.value;
      cursor.continue();
    };
  });
}

function materializeMapData(entries: Record<string, unknown>): {
  data: MapDataStore;
  knownKeys: string[];
} {
  const data: MapDataStore = {};
  const knownKeys: string[] = [];

  if (Object.prototype.hasOwnProperty.call(entries, MAP_DATA_LEGACY_KEY)) {
    knownKeys.push(MAP_DATA_LEGACY_KEY);
    const legacy = expandMapDataFromStorage(
      entries[MAP_DATA_LEGACY_KEY] as Record<string, Record<string, unknown>>,
    );
    Object.entries(legacy).forEach(([eventName, eventMapData]) => {
      data[eventName] = { ...eventMapData };
    });
  }

  Object.entries(entries).forEach(([storageKey, value]) => {
    const parsed = parseMapDataEntryKey(storageKey);
    if (!parsed) return;
    knownKeys.push(storageKey);
    const [eventName, dayMapName] = parsed;
    const expandedDayMap = expandDayMapFromStorage(
      value as Parameters<typeof expandDayMapFromStorage>[0],
    );
    const existingEventMap = data[eventName];
    if (
      existingEventMap &&
      Object.prototype.hasOwnProperty.call(existingEventMap, dayMapName) &&
      !fingerprintsEqual(
        createSynchronousFingerprint(existingEventMap[dayMapName]),
        createSynchronousFingerprint(expandedDayMap),
      )
    ) {
      throw new PersistenceConflictError(
        `mapData contains conflicting legacy and split entries for ${eventName}/${dayMapName}.`,
      );
    }
    data[eventName] = {
      ...(existingEventMap ?? {}),
      [dayMapName]: expandedDayMap,
    };
  });

  return { data, knownKeys };
}

function buildMapDataPuts(
  data: MapDataStore,
): { key: string; value: unknown }[] {
  const puts: { key: string; value: unknown }[] = [];
  Object.entries(data).forEach(([eventName, eventMapData]) => {
    Object.entries(eventMapData).forEach(([dayMapName, dayMapData]) => {
      puts.push({
        key: getMapDataEntryKey(eventName, dayMapName),
        value: compactDayMapForStorage(dayMapData),
      });
    });
  });
  return puts;
}

async function readRawMapSnapshotOnce(): Promise<RawMapSnapshot> {
  const database = await openDB();
  ensureStoreExists(database, STORES.MAP_DATA);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const transaction = database.transaction(
    [STORES.MAP_DATA, STORES.SYNC_QUEUE],
    "readonly",
  );
  const finished = transactionFinished(transaction);
  const entriesPromise = readMapEntriesFromStore(
    transaction.objectStore(STORES.MAP_DATA),
  );
  const metadataPromise = requestResult(
    transaction
      .objectStore(STORES.SYNC_QUEUE)
      .get(createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY)),
  );
  const checkpointPromise = requestResult(
    transaction
      .objectStore(STORES.SYNC_QUEUE)
      .get(createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY)),
  );
  const [entries, metadata, checkpoint] = await Promise.all([
    entriesPromise,
    metadataPromise,
    checkpointPromise,
  ]);
  await finished;
  return { entries, metadata, checkpoint };
}

async function readRawMapSnapshotWithRetry(): Promise<RawMapSnapshot> {
  try {
    return await readRawMapSnapshotOnce();
  } catch (firstError) {
    resetDbInstance();
    try {
      return await readRawMapSnapshotOnce();
    } catch (retryError) {
      resetDbInstance();
      throw retryError ?? firstError;
    }
  }
}

async function validateMapSnapshot(
  snapshot: RawMapSnapshot,
): Promise<
  | { validated: ValidatedPersistenceSnapshot<MapDataStore> }
  | { conflict: LoadResult<MapDataStore> }
> {
  let materialized: ReturnType<typeof materializeMapData>;
  try {
    materialized = materializeMapData(snapshot.entries);
  } catch (error) {
    return {
      conflict: {
        status: "conflict",
        data: null,
        error,
        recoveryBundle: createRecoveryBundle(
          [
            createRecoveryIssue(
              "load",
              readErrorName(error) || "InvalidMapPayload",
              "mapData の保存形式が不正なため、安全に読み込めません。",
              STORES.MAP_DATA,
            ),
          ],
          [
            createRecoveryCandidate(
              "indexedDB",
              STORES.MAP_DATA,
              DATA_KEY,
              null,
              snapshot.entries,
              undefined,
              { role: "invalid-source", adoptable: false },
            ),
            ...(snapshot.metadata === undefined || snapshot.metadata === null
              ? []
              : [
                  createRecoveryCandidate(
                    "indexedDB",
                    STORES.MAP_DATA,
                    createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
                    isStoredPersistenceMetadata(
                      snapshot.metadata,
                      STORES.MAP_DATA,
                      DATA_KEY,
                    )
                      ? snapshot.metadata.revision
                      : null,
                    snapshot.metadata,
                  ),
                ]),
          ],
        ),
      },
    };
  }

  const logicalData = materialized.data;
  const isMissing = Object.keys(logicalData).length === 0;
  const metadataMissing =
    snapshot.metadata === undefined || snapshot.metadata === null;
  if (metadataMissing) {
    if (snapshot.checkpoint !== undefined && snapshot.checkpoint !== null) {
      return {
        conflict: createConflictLoadResult(
          "mapData のpayloadと吸収checkpointに対応する世代情報がありません。",
          STORES.MAP_DATA,
          [
            createRecoveryCandidate(
              "indexedDB",
              STORES.MAP_DATA,
              DATA_KEY,
              null,
              logicalData,
            ),
            createRecoveryCandidate(
              "indexedDB",
              STORES.MAP_DATA,
              createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY),
              null,
              snapshot.checkpoint,
            ),
          ],
        ),
      };
    }
    try {
      const root = await createSyntheticRoot(
        STORES.MAP_DATA,
        DATA_KEY,
        logicalData,
        isMissing,
      );
      return {
        validated: {
          status: isMissing ? "missing" : "ok",
          data: isMissing ? null : logicalData,
          root,
          checkpoint: null,
        },
      };
    } catch {
      return {
        conflict: createConflictLoadResult(
          "mapData のmetadata未付与データを安全に識別できません。",
          STORES.MAP_DATA,
          [
            createRecoveryCandidate(
              "indexedDB",
              STORES.MAP_DATA,
              DATA_KEY,
              null,
              logicalData,
            ),
          ],
        ),
      };
    }
  }

  if (
    !isStoredPersistenceMetadata(snapshot.metadata, STORES.MAP_DATA, DATA_KEY)
  ) {
    return {
      conflict: createConflictLoadResult(
        "mapData の世代情報が不正なため、保存データを上書きできません。",
        STORES.MAP_DATA,
        [
          createRecoveryCandidate(
            "indexedDB",
            STORES.MAP_DATA,
            DATA_KEY,
            null,
            logicalData,
          ),
          createRecoveryCandidate(
            "indexedDB",
            STORES.MAP_DATA,
            createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
            null,
            snapshot.metadata,
          ),
        ],
      ),
    };
  }

  let digestValid = false;
  let fingerprintValid = false;
  try {
    digestValid = await verifyPersistenceDigest(
      logicalData,
      snapshot.metadata.payloadDigest,
    );
    fingerprintValid = fingerprintsEqual(
      createSynchronousFingerprint(logicalData),
      snapshot.metadata.payloadFingerprint,
    );
  } catch {
    // Unsupported future payloads remain available in recovery.
  }
  if (!digestValid || !fingerprintValid) {
    return {
      conflict: createConflictLoadResult(
        "mapData の保存内容と世代情報が一致しません。",
        STORES.MAP_DATA,
        [
          createRecoveryCandidate(
            "indexedDB",
            STORES.MAP_DATA,
            DATA_KEY,
            snapshot.metadata.revision,
            logicalData,
          ),
          createRecoveryCandidate(
            "indexedDB",
            STORES.MAP_DATA,
            createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
            snapshot.metadata.revision,
            snapshot.metadata,
          ),
        ],
      ),
    };
  }

  let checkpoint: PersistenceCheckpoint | null;
  try {
    checkpoint = validateCheckpointForRoot(
      snapshot.checkpoint,
      STORES.MAP_DATA,
      DATA_KEY,
      snapshot.metadata,
    );
  } catch {
    return {
      conflict: createConflictLoadResult(
        "mapData の吸収checkpointが確定rootと一致しません。",
        STORES.MAP_DATA,
        [
          createRecoveryCandidate(
            "indexedDB",
            STORES.MAP_DATA,
            DATA_KEY,
            snapshot.metadata.revision,
            logicalData,
          ),
          createRecoveryCandidate(
            "indexedDB",
            STORES.MAP_DATA,
            createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY),
            snapshot.metadata.revision,
            snapshot.checkpoint,
          ),
        ],
      ),
    };
  }

  return {
    validated: {
      status: isMissing ? "missing" : "ok",
      data: isMissing ? null : logicalData,
      root: {
        ...snapshot.metadata,
        missing: isMissing,
      },
      checkpoint,
    },
  };
}

function assertCurrentMapMatchesExpected(
  entries: Record<string, unknown>,
  metadata: unknown,
  expected: ObservedRevisionRoot,
): string[] {
  const { data, knownKeys } = materializeMapData(entries);
  const currentFingerprint = createSynchronousFingerprint(data);
  const metadataMissing = metadata === undefined || metadata === null;

  if (expected.synthetic) {
    if (
      !metadataMissing ||
      !fingerprintsEqual(currentFingerprint, expected.payloadFingerprint)
    ) {
      throw new PersistenceConflictError(
        "mapData changed after it was last observed.",
      );
    }
    return knownKeys;
  }

  if (
    !isStoredPersistenceMetadata(metadata, STORES.MAP_DATA, DATA_KEY) ||
    !immutableObservedRootFieldsMatch(metadata, expected) ||
    !fingerprintsEqual(currentFingerprint, expected.payloadFingerprint)
  ) {
    throw new PersistenceConflictError(
      "mapData changed after it was last observed.",
    );
  }
  return knownKeys;
}

async function writeMapDataWithMetadataOnce(
  data: MapDataStore,
  expected: ObservedRevisionRoot,
  expectedCheckpoint: PersistenceCheckpoint | null,
  metadata: StoredPersistenceMetadata,
  checkpoint: PersistenceCheckpoint,
): Promise<void> {
  const database = await openDB();
  ensureStoreExists(database, STORES.MAP_DATA);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const desiredPuts = buildMapDataPuts(data);
  const desiredByStorageKey = new Map(
    desiredPuts.map(({ key: storageKey, value }) => [storageKey, value]),
  );

  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        [STORES.MAP_DATA, STORES.SYNC_QUEUE],
        "readwrite",
      );
    } catch (error) {
      reject(error);
      return;
    }

    let failure: unknown = null;
    let entries: Record<string, unknown> | null = null;
    let currentMetadata: unknown;
    let currentCheckpoint: unknown;
    let metadataLoaded = false;
    let checkpointLoaded = false;
    let committed = false;
    const mapStore = transaction.objectStore(STORES.MAP_DATA);
    const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      failure = failure ?? transaction.error;
    };
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Failed to write mapData and its metadata."),
      );

    const abortWith = (error: unknown) => {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    };

    const commitIfReady = () => {
      if (committed || entries === null || !metadataLoaded || !checkpointLoaded)
        return;
      committed = true;
      const observedEntries = entries;
      try {
        const deletes = assertCurrentMapMatchesExpected(
          observedEntries,
          currentMetadata,
          expected,
        ).filter((storageKey) => !desiredByStorageKey.has(storageKey));
        assertCurrentCheckpointMatchesExpected(
          STORES.MAP_DATA,
          DATA_KEY,
          currentCheckpoint,
          expectedCheckpoint,
        );
        deletes.forEach((storageKey) => {
          const request = mapStore.delete(storageKey);
          request.onerror = () => {
            failure = failure ?? request.error;
          };
        });
        desiredPuts.forEach(({ key: storageKey, value }) => {
          if (
            Object.prototype.hasOwnProperty.call(observedEntries, storageKey) &&
            fingerprintsEqual(
              createSynchronousFingerprint(observedEntries[storageKey]),
              createSynchronousFingerprint(value),
            )
          ) {
            return;
          }
          const request = mapStore.put(value, storageKey);
          request.onerror = () => {
            failure = failure ?? request.error;
          };
        });
        const metadataRequest = controlStore.put(
          metadata,
          createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
        );
        metadataRequest.onerror = () => {
          failure = failure ?? metadataRequest.error;
        };
        const checkpointRequest = controlStore.put(
          checkpoint,
          createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY),
        );
        checkpointRequest.onerror = () => {
          failure = failure ?? checkpointRequest.error;
        };
      } catch (error) {
        abortWith(error);
      }
    };

    const currentEntries: Record<string, unknown> = {};
    const cursorRequest = mapStore.openCursor();
    cursorRequest.onerror = () =>
      abortWith(
        cursorRequest.error ?? new Error("Failed to enumerate mapData."),
      );
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        currentEntries[String(cursor.key)] = cursor.value;
        cursor.continue();
        return;
      }
      entries = currentEntries;
      commitIfReady();
    };

    const metadataRequest = controlStore.get(
      createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
    );
    metadataRequest.onerror = () =>
      abortWith(
        metadataRequest.error ?? new Error("Failed to read mapData metadata."),
      );
    metadataRequest.onsuccess = () => {
      currentMetadata = metadataRequest.result;
      metadataLoaded = true;
      commitIfReady();
    };
    const checkpointRequest = controlStore.get(
      createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY),
    );
    checkpointRequest.onerror = () =>
      abortWith(
        checkpointRequest.error ??
          new Error("Failed to read mapData checkpoint."),
      );
    checkpointRequest.onsuccess = () => {
      currentCheckpoint = checkpointRequest.result;
      checkpointLoaded = true;
      commitIfReady();
    };
  });
}

async function writeMapData(data: MapDataStore): Promise<void> {
  const stableData = normalizeMapDataForPersistence(structuredClone(data));
  const observedKey = getObservedRootKey(STORES.MAP_DATA, DATA_KEY);
  let expected = expectedRevisionRoots.get(observedKey);
  if (!expected) {
    const loaded = await loadMapDataInternal();
    if (loaded.status === "error" || loaded.status === "conflict") {
      throw (
        loaded.error ??
        new PersistenceConflictError("mapData could not be observed.")
      );
    }
    expected = expectedRevisionRoots.get(observedKey);
  }
  if (!expected) {
    throw new Error("Failed to observe mapData before save.");
  }
  const expectedCheckpoint =
    expectedPersistenceCheckpoints.get(observedKey) ?? null;

  const metadata = await prepareMetadataForPayload(
    STORES.MAP_DATA,
    DATA_KEY,
    stableData,
    expected.missing ? null : expected.revision,
  );
  const checkpoint = createNextPersistenceCheckpoint(
    STORES.MAP_DATA,
    DATA_KEY,
    metadata,
    expectedCheckpoint,
  );
  try {
    await writeMapDataWithMetadataOnce(
      stableData,
      expected,
      expectedCheckpoint,
      metadata,
      checkpoint,
    );
  } catch (firstError) {
    if (isPersistenceConflict(firstError)) throw firstError;
    resetDbInstance();
    await writeMapDataWithMetadataOnce(
      stableData,
      expected,
      expectedCheckpoint,
      metadata,
      checkpoint,
    );
  }
  expectedRevisionRoots.set(observedKey, {
    ...metadata,
    missing: Object.keys(stableData).length === 0,
  });
  expectedPersistenceCheckpoints.set(observedKey, checkpoint);
}

async function loadMapDataInternal(): Promise<LoadResult<MapDataStore>> {
  let snapshot: RawMapSnapshot;
  try {
    snapshot = await readRawMapSnapshotWithRetry();
  } catch (error) {
    return {
      status: "error",
      data: null,
      error,
      recoveryBundle: createRecoveryBundle([
        createRecoveryIssue(
          "load",
          readErrorName(error) || "IndexedDBReadError",
          "mapData を2回試しても読み込めませんでした。",
          STORES.MAP_DATA,
        ),
      ]),
    };
  }

  const validation = await validateMapSnapshot(snapshot);
  if ("conflict" in validation) return validation.conflict;
  expectedRevisionRoots.set(
    getObservedRootKey(STORES.MAP_DATA, DATA_KEY),
    validation.validated.root,
  );
  expectedPersistenceCheckpoints.set(
    getObservedRootKey(STORES.MAP_DATA, DATA_KEY),
    validation.validated.checkpoint,
  );
  return {
    status: validation.validated.status,
    data: validation.validated.data,
  };
}

/**
 * データを保存
 */
async function saveData<T>(
  storeName: StoreName,
  key: string,
  data: T,
): Promise<void> {
  const stableData = structuredClone(data);
  const observedKey = getObservedRootKey(storeName, key);
  let expected = expectedRevisionRoots.get(observedKey);
  if (!expected) {
    const observed = await loadData<T>(storeName, key);
    if (observed.status === "error" || observed.status === "conflict") {
      throw (
        observed.error ??
        new PersistenceConflictError(
          `${storeName}:${key} could not be observed before save.`,
        )
      );
    }
    expected = expectedRevisionRoots.get(observedKey);
  }
  if (!expected) {
    throw new Error(`Failed to observe ${storeName}:${key} before save.`);
  }

  const logicalExpected = expected;
  let writeExpected = logicalExpected;
  let writeExpectedCheckpoint =
    expectedPersistenceCheckpoints.get(observedKey) ?? null;
  let absorbedForCommit: RuntimeCandidateSnapshot<T>[] = [];
  if (logicalExpected.runtimeFallback) {
    try {
      const physicalSnapshot = await readPersistenceSnapshotWithRetry(
        storeName,
        key,
      );
      const physicalValidation = await validatePersistenceSnapshot<T>(
        storeName,
        key,
        physicalSnapshot,
      );
      if ("conflict" in physicalValidation) {
        throw (
          physicalValidation.conflict.error ??
          new PersistenceConflictError(
            `${storeName}:${key} is inconsistent behind its fallback head.`,
          )
        );
      }
      const physicalRoot = physicalValidation.validated.root;
      absorbedForCommit = (await assertPhysicalRootMatchesLogicalFallback(
        storeName,
        key,
        physicalRoot,
        physicalValidation.validated.checkpoint,
        logicalExpected,
      )) as RuntimeCandidateSnapshot<T>[];
      writeExpected = physicalRoot;
      writeExpectedCheckpoint = physicalValidation.validated.checkpoint;
    } catch (error) {
      if (
        isPersistenceConflict(error) ||
        !canUseRuntimeFallback(storeName, error)
      ) {
        throw error;
      }
    }
  } else {
    const candidateScan = await readRuntimeCandidateSnapshots<T>(
      storeName,
      key,
    );
    if (candidateScan.status === "conflict") {
      throw (
        candidateScan.result.error ??
        new PersistenceConflictError(
          `${storeName}:${key} has an invalid fallback candidate.`,
        )
      );
    }
    const partitioned = partitionRuntimeCandidateSnapshots(
      writeExpectedCheckpoint,
      candidateScan.snapshots,
    );
    const reconciliation = reconcileRuntimeFallbackCandidates(
      {
        revision: logicalExpected.missing ? null : logicalExpected.revision,
        baseRevision: logicalExpected.missing
          ? null
          : logicalExpected.baseRevision,
        digest: logicalExpected.missing
          ? undefined
          : logicalExpected.payloadDigest,
        writerId: logicalExpected.missing
          ? undefined
          : logicalExpected.writerId,
        createdAt: logicalExpected.missing
          ? undefined
          : logicalExpected.committedAt,
      },
      partitioned.active.map(({ candidate }) => candidate),
      writeExpectedCheckpoint?.absorbedCandidates ?? [],
    );
    if (reconciliation.status === "conflict" || reconciliation.head) {
      throw new PersistenceConflictError(
        `${storeName}:${key} has an uncommitted persistence branch.`,
      );
    }
    absorbedForCommit = candidateScan.snapshots;
  }

  const baseRevision = logicalExpected.missing
    ? null
    : logicalExpected.revision;
  const metadata = await prepareMetadataForPayload(
    storeName,
    key,
    stableData,
    baseRevision,
  );
  const checkpoint = createNextPersistenceCheckpoint(
    storeName,
    key,
    metadata,
    writeExpectedCheckpoint,
    absorbedForCommit,
  );

  const saveOnce = () =>
    writeDataWithMetadataOnce(
      storeName,
      key,
      stableData,
      writeExpected,
      writeExpectedCheckpoint,
      metadata,
      checkpoint,
    );

  try {
    await saveOnce();
    expectedRevisionRoots.set(observedKey, metadata);
    expectedPersistenceCheckpoints.set(observedKey, checkpoint);
    cleanupRuntimeCandidateSnapshots(absorbedForCommit);
    return;
  } catch (firstError) {
    if (
      isPersistenceConflict(firstError) ||
      !canUseRuntimeFallback(storeName, firstError)
    ) {
      throw firstError;
    }
    resetDbInstance();

    try {
      await saveOnce();
      expectedRevisionRoots.set(observedKey, metadata);
      expectedPersistenceCheckpoints.set(observedKey, checkpoint);
      cleanupRuntimeCandidateSnapshots(absorbedForCommit);
      return;
    } catch (retryError) {
      if (
        isPersistenceConflict(retryError) ||
        !canUseRuntimeFallback(storeName, retryError)
      ) {
        throw retryError;
      }

      console.warn(
        `Using immutable fallback candidates for ${storeName} after an IndexedDB retry failure.`,
      );

      let current = logicalExpected;
      let currentCheckpoint =
        expectedPersistenceCheckpoints.get(observedKey) ?? null;
      try {
        const currentSnapshot = await readPersistenceSnapshotWithRetry(
          storeName,
          key,
        );
        const currentValidation = await validatePersistenceSnapshot<T>(
          storeName,
          key,
          currentSnapshot,
        );
        if ("conflict" in currentValidation) {
          throw (
            currentValidation.conflict.error ??
            new PersistenceConflictError(
              `${storeName}:${key} became inconsistent before fallback.`,
            )
          );
        }
        const physicalCurrent = currentValidation.validated.root;
        await assertPhysicalRootMatchesLogicalFallback(
          storeName,
          key,
          physicalCurrent,
          currentValidation.validated.checkpoint,
          logicalExpected,
        );
        current = logicalExpected;
        currentCheckpoint = currentValidation.validated.checkpoint;
      } catch (readError) {
        if (
          isPersistenceConflict(readError) ||
          !canUseRuntimeFallback(storeName, readError)
        ) {
          throw readError;
        }
        current = logicalExpected;
      }

      const candidateScan = await readRuntimeCandidateSnapshots<T>(
        storeName,
        key,
      );
      if (candidateScan.status === "conflict") {
        throw (
          candidateScan.result.error ??
          new PersistenceConflictError(
            `${storeName}:${key} has an invalid fallback candidate.`,
          )
        );
      }
      const partitioned = partitionRuntimeCandidateSnapshots(
        currentCheckpoint,
        candidateScan.snapshots,
      );
      const reconciliation = reconcileRuntimeFallbackCandidates(
        {
          revision: current.missing ? null : current.revision,
          baseRevision: current.missing ? null : current.baseRevision,
          digest: current.missing ? undefined : current.payloadDigest,
          writerId: current.missing ? undefined : current.writerId,
          createdAt: current.missing ? undefined : current.committedAt,
        },
        partitioned.active.map(({ candidate }) => candidate),
        currentCheckpoint?.absorbedCandidates ?? [],
      );
      if (reconciliation.status === "conflict" || reconciliation.head) {
        throw new PersistenceConflictError(
          `${storeName}:${key} has another uncommitted persistence branch.`,
        );
      }
      const candidate = await createRuntimeFallbackCandidate({
        storeName,
        key,
        revision: metadata.revision,
        baseRevision,
        writerId: persistenceWriterId,
        payload: stableData,
      });
      const storageKey = createRuntimeFallbackKey(
        storeName,
        key,
        candidate.revision,
      );
      const serialized = serializeRuntimeFallbackCandidate(candidate);
      const existing = localStorage.getItem(storageKey);
      if (existing !== null && existing !== serialized) {
        throw new PersistenceConflictError(
          "Immutable runtime fallback key already exists.",
        );
      }
      localStorage.setItem(storageKey, serialized);
      if (localStorage.getItem(storageKey) !== serialized) {
        const error = new Error(
          "Runtime fallback readback verification failed.",
        );
        error.name = "PersistenceFallbackReadbackError";
        throw error;
      }

      expectedRevisionRoots.set(
        observedKey,
        createObservedRootFromRuntimeCandidate(candidate),
      );
    }
  }
}

/**
 * データを読み込み
 */
async function loadRuntimeFallbackWithoutIndexedDb<T>(
  storeName: StoreName,
  key: string,
  indexedDbError: unknown,
): Promise<LoadResult<T>> {
  const makeReadError = (): LoadResult<T> => ({
    status: "error",
    data: null,
    error: indexedDbError,
    recoveryBundle: createRecoveryBundle([
      createRecoveryIssue(
        "load",
        readErrorName(indexedDbError) || "IndexedDBReadError",
        `${storeName} のIndexedDBデータを2回試しても読み込めませんでした。`,
        storeName,
      ),
    ]),
  });

  if (!canUseRuntimeFallback(storeName, indexedDbError)) {
    return makeReadError();
  }

  let candidateScan:
    | { status: "ok"; snapshots: RuntimeCandidateSnapshot<T>[] }
    | { status: "conflict"; result: LoadResult<T> };
  try {
    candidateScan = await readRuntimeCandidateSnapshots<T>(storeName, key);
  } catch {
    return makeReadError();
  }
  if (candidateScan.status === "conflict") return candidateScan.result;
  if (candidateScan.snapshots.length === 0) return makeReadError();

  const observedKey = getObservedRootKey(storeName, key);
  const expected = expectedRevisionRoots.get(observedKey);
  let current: {
    revision: string | null;
    baseRevision: string | null;
    digest?: PersistenceDigestDescriptor;
    writerId?: string;
    createdAt?: string;
  };

  if (expected) {
    current = {
      revision: expected.missing ? null : expected.revision,
      baseRevision: expected.missing ? null : expected.baseRevision,
      digest: expected.missing ? undefined : expected.payloadDigest,
      writerId: expected.missing ? undefined : expected.writerId,
      createdAt: expected.missing ? undefined : expected.committedAt,
    };
  } else {
    return createConflictLoadResult(
      `${storeName} のIndexedDB確定rootと吸収checkpointを確認できないため、退避候補を自動採用しません。`,
      storeName,
      runtimeSnapshotsToRecoveryCandidates(
        storeName,
        key,
        candidateScan.snapshots,
      ),
    );
  }
  const partitioned = partitionRuntimeCandidateSnapshots(
    expectedPersistenceCheckpoints.get(observedKey) ?? null,
    candidateScan.snapshots,
  );

  const reconciliation = reconcileRuntimeFallbackCandidates(
    current,
    partitioned.active.map(({ candidate }) => candidate),
    (expectedPersistenceCheckpoints.get(observedKey) ?? null)
      ?.absorbedCandidates ?? [],
  );
  if (reconciliation.status === "conflict") {
    return createConflictLoadResult(
      `${storeName} の退避候補が分岐しており、安全に選択できません。`,
      storeName,
      runtimeSnapshotsToRecoveryCandidates(
        storeName,
        key,
        candidateScan.snapshots,
      ),
    );
  }

  const head =
    reconciliation.head ??
    reconciliation.staleCandidates.find(
      (candidate) => candidate.revision === current.revision,
    ) ??
    null;
  if (!head) return makeReadError();

  expectedRevisionRoots.set(
    observedKey,
    createObservedRootFromRuntimeCandidate(head),
  );
  return {
    status: "ok",
    data: head.payload,
  };
}

async function resolveFallbackRepairConflict<T>(
  storeName: StoreName,
  key: string,
  head: RuntimeFallbackCandidate<T>,
  runtimeSnapshots: readonly RuntimeCandidateSnapshot<T>[],
  repairError: unknown,
): Promise<LoadResult<T>> {
  const observedKey = getObservedRootKey(storeName, key);
  const runtimeCandidates = runtimeSnapshotsToRecoveryCandidates(
    storeName,
    key,
    runtimeSnapshots,
  );
  let indexedDbCandidates: StartupRecoveryCandidate[] = [];

  try {
    resetDbInstance();
    const snapshot = await readPersistenceSnapshotOnce(storeName, key);
    const validation = await validatePersistenceSnapshot<T>(
      storeName,
      key,
      snapshot,
    );
    if ("conflict" in validation) {
      indexedDbCandidates =
        validation.conflict.recoveryBundle?.candidates ?? [];
    } else {
      const current = validation.validated.root;
      if (
        !current.synthetic &&
        current.revision === head.revision &&
        current.payloadDigest.value === head.digest.value &&
        current.baseRevision === head.baseRevision &&
        current.writerId === head.writerId &&
        current.committedAt === head.createdAt &&
        runtimeSnapshots.every(({ candidate }) =>
          checkpointRecordsRuntimeCandidate(
            validation.validated.checkpoint,
            candidate,
          ),
        )
      ) {
        expectedRevisionRoots.set(observedKey, current);
        expectedPersistenceCheckpoints.set(
          observedKey,
          validation.validated.checkpoint,
        );
        cleanupRuntimeCandidateSnapshots(runtimeSnapshots);
        return {
          status: "ok",
          data: head.payload,
        };
      }

      const revision = isStoredPersistenceMetadata(
        snapshot.metadata,
        storeName,
        key,
      )
        ? snapshot.metadata.revision
        : null;
      if (snapshot.payload !== undefined && snapshot.payload !== null) {
        indexedDbCandidates.push(
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            key,
            revision,
            snapshot.payload,
          ),
        );
      }
      if (snapshot.metadata !== undefined && snapshot.metadata !== null) {
        indexedDbCandidates.push(
          createRecoveryCandidate(
            "indexedDB",
            storeName,
            createPersistenceMetadataKey(storeName, key),
            revision,
            snapshot.metadata,
          ),
        );
      }
    }
  } catch {
    console.warn(
      `Failed to re-read ${storeName} after a fallback repair conflict.`,
    );
  }

  const conflict = new PersistenceConflictError(
    `${storeName}:${key} changed while repairing its runtime fallback.`,
  );
  return {
    status: "conflict",
    data: null,
    error: conflict,
    recoveryBundle: createRecoveryBundle(
      [
        createRecoveryIssue(
          "fallback-repair",
          readErrorName(repairError) || "PersistenceConflict",
          `${storeName} の退避候補と同時更新されたIndexedDBを自動判定できません。`,
          storeName,
        ),
      ],
      [...indexedDbCandidates, ...runtimeCandidates],
    ),
  };
}

async function loadDataUnobserved<T>(
  storeName: StoreName,
  key: string,
): Promise<LoadResult<T>> {
  let snapshot: RawPersistenceSnapshot;
  try {
    snapshot = await readPersistenceSnapshotWithRetry(storeName, key);
  } catch (error) {
    return loadRuntimeFallbackWithoutIndexedDb<T>(storeName, key, error);
  }

  const validation = await validatePersistenceSnapshot<T>(
    storeName,
    key,
    snapshot,
  );
  if ("conflict" in validation) {
    if (validation.checkpointConflict) {
      recordPersistenceReleaseAMetric({
        version: 1,
        name: "checkpoint-adoption",
        outcome: "conflict",
      });
    }
    return validation.conflict;
  }

  const observedKey = getObservedRootKey(storeName, key);
  const validated = validation.validated;
  if (storeName === STORES.MAP_DATA) {
    expectedRevisionRoots.set(observedKey, validated.root);
    expectedPersistenceCheckpoints.set(observedKey, validated.checkpoint);
    return {
      status: validated.status,
      data: validated.data,
    };
  }

  let candidateScan:
    | { status: "ok"; snapshots: RuntimeCandidateSnapshot<T>[] }
    | { status: "conflict"; result: LoadResult<T> };
  try {
    candidateScan = await readRuntimeCandidateSnapshots<T>(storeName, key);
  } catch (error) {
    return {
      status: "error",
      data: null,
      error,
      recoveryBundle: createRecoveryBundle([
        createRecoveryIssue(
          "fallback-reconcile",
          readErrorName(error) || "FallbackScanError",
          `${storeName} の退避候補を走査できませんでした。`,
          storeName,
        ),
      ]),
    };
  }
  if (candidateScan.status === "conflict") {
    recordPersistenceReleaseAMetric({
      version: 1,
      name: "checkpoint-adoption",
      outcome: "conflict",
    });
    return candidateScan.result;
  }
  const partitioned = partitionRuntimeCandidateSnapshots(
    validated.checkpoint,
    candidateScan.snapshots,
  );

  const reconciliation = reconcileRuntimeFallbackCandidates(
    {
      revision: validated.root.missing ? null : validated.root.revision,
      baseRevision: validated.root.missing ? null : validated.root.baseRevision,
      digest: validated.root.missing ? undefined : validated.root.payloadDigest,
      writerId: validated.root.missing ? undefined : validated.root.writerId,
      createdAt: validated.root.missing
        ? undefined
        : validated.root.committedAt,
    },
    partitioned.active.map(({ candidate }) => candidate),
    validated.checkpoint?.absorbedCandidates ?? [],
  );
  if (reconciliation.status === "conflict") {
    recordPersistenceReleaseAMetric({
      version: 1,
      name: "checkpoint-adoption",
      outcome: "conflict",
    });
    const candidates: StartupRecoveryCandidate[] = [
      createRecoveryCandidate(
        "indexedDB",
        storeName,
        key,
        validated.root.missing ? null : validated.root.revision,
        validated.data,
        undefined,
        {
          digest: validated.root.payloadDigest,
          adoptable: !validated.root.missing,
        },
      ),
      ...runtimeSnapshotsToRecoveryCandidates(
        storeName,
        key,
        candidateScan.snapshots,
      ),
    ];
    return createConflictLoadResult(
      `${storeName} に分岐した保存候補があり、安全に新旧を判定できません。`,
      storeName,
      candidates,
    );
  }

  if (!reconciliation.head) {
    recordPersistenceReleaseAMetric({
      version: 1,
      name: "checkpoint-adoption",
      outcome:
        partitioned.absorbed.length > 0 ? "already-absorbed" : "not-needed",
    });
    cleanupRuntimeCandidateSnapshots(partitioned.absorbed);
    expectedRevisionRoots.set(observedKey, validated.root);
    expectedPersistenceCheckpoints.set(observedKey, validated.checkpoint);
    return {
      status: validated.status,
      data: validated.data,
    };
  }

  const head = reconciliation.head;
  const repairedMetadata: StoredPersistenceMetadata = {
    kind: "event-shopping-planner-persistence-metadata",
    version: 1,
    storeName,
    key,
    revision: head.revision,
    baseRevision: head.baseRevision,
    payloadDigest: head.digest,
    payloadFingerprint: createSynchronousFingerprint(head.payload),
    writerId: head.writerId,
    committedAt: head.createdAt,
  };
  const repairedCheckpoint = createNextPersistenceCheckpoint(
    storeName,
    key,
    repairedMetadata,
    validated.checkpoint,
    candidateScan.snapshots,
  );
  let repairFailure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeDataWithMetadataOnce(
        storeName,
        key,
        head.payload,
        validated.root,
        validated.checkpoint,
        repairedMetadata,
        repairedCheckpoint,
      );
      repairFailure = null;
      break;
    } catch (error) {
      if (isPersistenceConflict(error)) {
        recordPersistenceReleaseAMetric({
          version: 1,
          name: "fallback-repair",
          outcome: "conflict",
        });
        recordPersistenceReleaseAMetric({
          version: 1,
          name: "checkpoint-adoption",
          outcome: "conflict",
        });
        return resolveFallbackRepairConflict(
          storeName,
          key,
          head,
          candidateScan.snapshots,
          error,
        );
      }
      if (!canUseRuntimeFallback(storeName, error)) {
        recordPersistenceReleaseAMetric({
          version: 1,
          name: "fallback-repair",
          outcome: "failed",
        });
        recordPersistenceReleaseAMetric({
          version: 1,
          name: "checkpoint-adoption",
          outcome: "failed",
        });
        return {
          status: "error",
          data: null,
          error,
          recoveryBundle: createRecoveryBundle(
            [
              createRecoveryIssue(
                "fallback-repair",
                readErrorName(error) || "IndexedDBRepairError",
                `${storeName} の退避候補をIndexedDBへ修復できませんでした。`,
                storeName,
              ),
            ],
            runtimeSnapshotsToRecoveryCandidates(
              storeName,
              key,
              candidateScan.snapshots,
            ),
          ),
        };
      }
      repairFailure = error;
      if (attempt === 0) resetDbInstance();
    }
  }

  if (repairFailure !== null) {
    recordPersistenceReleaseAMetric({
      version: 1,
      name: "fallback-repair",
      outcome: "failed",
    });
    recordPersistenceReleaseAMetric({
      version: 1,
      name: "checkpoint-adoption",
      outcome: "failed",
    });
    console.warn(
      `Failed to repair runtime fallback for ${storeName}; using the verified candidate.`,
    );
    expectedRevisionRoots.set(
      observedKey,
      createObservedRootFromRuntimeCandidate(head),
    );
    expectedPersistenceCheckpoints.set(observedKey, validated.checkpoint);
    return {
      status: "ok",
      data: head.payload,
    };
  }

  expectedRevisionRoots.set(observedKey, repairedMetadata);
  expectedPersistenceCheckpoints.set(observedKey, repairedCheckpoint);
  cleanupRuntimeCandidateSnapshots(candidateScan.snapshots);
  recordPersistenceReleaseAMetric({
    version: 1,
    name: "fallback-repair",
    outcome: "succeeded",
  });
  recordPersistenceReleaseAMetric({
    version: 1,
    name: "checkpoint-adoption",
    outcome: "adopted",
  });
  return {
    status: "ok",
    data: head.payload,
  };
}

async function loadData<T>(
  storeName: StoreName,
  key: string,
): Promise<LoadResult<T>> {
  const result = await loadDataUnobserved<T>(storeName, key);
  return recordPersistenceLoadOutcome(result);
}

function recordPersistenceLoadOutcome<T>(result: LoadResult<T>): LoadResult<T> {
  recordPersistenceReleaseAMetric({
    version: 1,
    name: "load",
    outcome:
      result.status === "ok"
        ? "succeeded"
        : result.status === "missing"
          ? "missing"
          : result.status === "error"
            ? "failed"
            : "conflict",
  });
  return result;
}

/**
 * データを削除
 */
async function deleteData(storeName: StoreName, key: string): Promise<void> {
  try {
    await deleteDataFromIndexedDb(storeName, key);
  } catch (firstError) {
    resetDbInstance();
    try {
      await deleteDataFromIndexedDb(storeName, key);
    } catch (retryError) {
      resetDbInstance();
      throw retryError ?? firstError;
    }
  }
}

// deleteDataは将来使用する可能性があるため維持
void deleteData;

/**
 * ストア内の全キーを取得
 */
async function getAllKeys(storeName: StoreName): Promise<string[]> {
  const loadOnce = async (): Promise<string[]> => {
    const db = await openDB();
    ensureStoreExists(db, storeName);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();

      request.onerror = () => {
        console.error(`Failed to get keys from ${storeName}.`);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(
          request.result
            .filter(
              (key) =>
                storeName !== STORES.SYNC_QUEUE || !isInternalRecordKey(key),
            )
            .map((key) => String(key)),
        );
      };
    });
  };

  try {
    return await loadOnce();
  } catch (firstError) {
    resetDbInstance();
    try {
      return await loadOnce();
    } catch (retryError) {
      resetDbInstance();
      throw retryError ?? firstError;
    }
  }
}

/**
 * ストア内の全データを取得
 */
async function getAllData<T>(storeName: StoreName): Promise<Record<string, T>> {
  const loadOnce = async (): Promise<Record<string, T>> => {
    const db = await openDB();
    ensureStoreExists(db, storeName);

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const result: Record<string, T> = {};

      const cursorRequest = store.openCursor();

      cursorRequest.onerror = () => {
        console.error(`Failed to get all data from ${storeName}.`);
        reject(cursorRequest.error);
      };

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          if (
            storeName !== STORES.SYNC_QUEUE ||
            !isInternalRecordKey(cursor.key)
          ) {
            result[String(cursor.key)] = cursor.value;
          }
          cursor.continue();
        } else {
          resolve(result);
        }
      };

      transaction.onabort = () => {
        reject(transaction.error || cursorRequest.error);
      };
    });
  };

  try {
    return await loadOnce();
  } catch (firstError) {
    resetDbInstance();
    try {
      return await loadOnce();
    } catch (retryError) {
      resetDbInstance();
      throw retryError ?? firstError;
    }
  }
}

/**
 * localStorageからIndexedDBへの移行
 */
const LEGACY_MIGRATION_TARGETS = [
  { legacyKey: "eventShoppingLists", storeName: STORES.EVENT_LISTS },
  { legacyKey: "eventMetadata", storeName: STORES.EVENT_METADATA },
  { legacyKey: "executeModeItems", storeName: STORES.EXECUTE_MODE_ITEMS },
  { legacyKey: "dayModes", storeName: STORES.DAY_MODES },
  { legacyKey: "mapData", storeName: STORES.MAP_DATA },
  {
    legacyKey: "mapRotationSettings",
    storeName: STORES.MAP_ROTATION_SETTINGS,
  },
  { legacyKey: "routeSettings", storeName: STORES.ROUTE_SETTINGS },
  { legacyKey: "hallDefinitions", storeName: STORES.HALL_DEFINITIONS },
  {
    legacyKey: "hallRouteSettings",
    storeName: STORES.HALL_ROUTE_SETTINGS,
  },
  {
    legacyKey: "mapViewportSettings",
    storeName: STORES.MAP_VIEWPORT_SETTINGS,
  },
] as const;

type LegacyMigrationTarget = (typeof LEGACY_MIGRATION_TARGETS)[number];

interface LegacySourceState {
  target: LegacyMigrationTarget;
  rawValue: string | null;
}

class LegacySourceChangedError extends PersistenceConflictError {
  readonly currentSources: LegacySourceState[];

  constructor(message: string, currentSources: LegacySourceState[]) {
    super(message);
    this.currentSources = currentSources;
  }
}

class LegacyMigrationConflictError extends PersistenceConflictError {
  readonly recoveryCandidates: StartupRecoveryCandidate[];

  constructor(
    message: string,
    migrationConflict: StartupRecoveryLegacyMigrationConflict,
    recoveryCandidates: StartupRecoveryCandidate[],
  ) {
    super(message);
    this.recoveryCandidates = recoveryCandidates.map((candidate) =>
      candidate.adoptable === true &&
      !fingerprintsEqual(candidate.migrationConflict, migrationConflict)
        ? { ...candidate, adoptable: false }
        : candidate,
    );
  }
}

function validatedMigrationRecoveryCandidate(
  storeName: StoreName,
  validated: ValidatedPersistenceSnapshot<unknown>,
  migrationConflict: StartupRecoveryLegacyMigrationConflict,
): StartupRecoveryCandidate | null {
  if (
    validated.status !== "ok" ||
    validated.data === null ||
    validated.root.synthetic
  ) {
    return null;
  }
  return createRecoveryCandidate(
    "indexedDB",
    storeName,
    DATA_KEY,
    validated.root.revision,
    validated.data,
    undefined,
    {
      digest: validated.root.payloadDigest,
      migrationConflict,
    },
  );
}

async function trustedMigrationRecoveryCandidate(
  storeName: RecoveryAdoptionStoreName,
  evidence: RecoveryAdoptionCurrentEvidence,
  migrationConflict: StartupRecoveryLegacyMigrationConflict,
): Promise<StartupRecoveryCandidate | null> {
  const trusted = await getTrustedRecoveryAdoptionRoot(storeName, evidence);
  if (!trusted) return null;
  const payload = materializeRecoveryAdoptionCurrentPayload(
    storeName,
    evidence,
  );
  return createRecoveryCandidate(
    "indexedDB",
    storeName,
    DATA_KEY,
    trusted.root.revision,
    payload,
    undefined,
    {
      digest: trusted.root.payloadDigest,
      migrationConflict,
    },
  );
}

async function collectMigrationConflictRecoveryCandidates(
  target: LegacyMigrationTarget,
  migrationConflict: StartupRecoveryLegacyMigrationConflict,
): Promise<StartupRecoveryCandidate[]> {
  const candidates: StartupRecoveryCandidate[] = [];
  try {
    if (target.storeName === STORES.MAP_DATA) {
      const snapshot = await readRawMapSnapshotWithRetry();
      const trusted = await trustedMigrationRecoveryCandidate(
        target.storeName,
        {
          mapEntries: snapshot.entries,
          metadata: snapshot.metadata,
          checkpoint: snapshot.checkpoint,
        },
        migrationConflict,
      );
      if (trusted) candidates.push(trusted);
      const validation = await validateMapSnapshot(snapshot);
      if ("conflict" in validation) {
        candidates.push(
          ...(validation.conflict.recoveryBundle?.candidates ?? []),
        );
      }
      return candidates;
    }

    const snapshot = await readPersistenceSnapshotWithRetry(
      target.storeName,
      DATA_KEY,
    );
    const trusted = await trustedMigrationRecoveryCandidate(
      target.storeName,
      {
        payload: snapshot.payload,
        metadata: snapshot.metadata,
        checkpoint: snapshot.checkpoint,
      },
      migrationConflict,
    );
    if (trusted) candidates.push(trusted);
    const validation = await validatePersistenceSnapshot(
      target.storeName,
      DATA_KEY,
      snapshot,
    );
    if ("conflict" in validation) {
      candidates.push(
        ...(validation.conflict.recoveryBundle?.candidates ?? []),
      );
    }
    const candidateScan = await readRuntimeCandidateSnapshots<
      Record<string, unknown>
    >(target.storeName, DATA_KEY);
    if (candidateScan.status === "ok") {
      candidates.push(
        ...runtimeSnapshotsToRecoveryCandidates(
          target.storeName,
          DATA_KEY,
          candidateScan.snapshots,
          migrationConflict,
        ),
      );
    } else {
      candidates.push(
        ...(candidateScan.result.recoveryBundle?.candidates ?? []),
      );
    }
  } catch {
    // Recovery stays fail-closed when no current candidate can be verified.
  }
  return candidates;
}

function captureLegacySourceStates(): LegacySourceState[] {
  return LEGACY_MIGRATION_TARGETS.map((target) => ({
    target,
    rawValue: localStorage.getItem(target.legacyKey),
  }));
}

function captureLegacySyncQueueSource(): string | null {
  return localStorage.getItem(LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY);
}

function captureLegacySyncQueueSourceForRecovery(
  fallback: string | null,
): string | null {
  try {
    return captureLegacySyncQueueSource();
  } catch {
    return fallback;
  }
}

function presentLegacySourceSnapshots(
  states: readonly LegacySourceState[],
): { target: LegacyMigrationTarget; rawValue: string }[] {
  return states.flatMap(({ target, rawValue }) =>
    rawValue === null ? [] : [{ target, rawValue }],
  );
}

function assertLegacySourcesUnchanged(
  captured: readonly LegacySourceState[],
): void {
  const current = captureLegacySourceStates();
  const capturedByKey = new Map(
    captured.map(({ target, rawValue }) => [target.legacyKey, rawValue]),
  );
  const changed = current.some(
    ({ target, rawValue }) => capturedByKey.get(target.legacyKey) !== rawValue,
  );
  if (changed) {
    throw new LegacySourceChangedError(
      "Legacy localStorage sources changed during migration.",
      current,
    );
  }
}

function assertJournalSourcesResumable(
  journal: LegacyMigrationJournal,
  current: readonly LegacySourceState[],
): void {
  const entriesByKey = new Map(
    journal.entries.map((entry) => [entry.legacyKey, entry]),
  );
  const changed = current.some(({ target, rawValue }) => {
    const entry = entriesByKey.get(target.legacyKey);
    if (!entry) return rawValue !== null;
    if (entry.cleanupStatus === "removed") return rawValue !== null;
    if (
      (journal.phase === "copied" ||
        journal.phase === "verified" ||
        journal.phase === "cleanup-ready" ||
        journal.phase === "cleanup-in-progress" ||
        journal.phase === "completed") &&
      (entry.cleanupStatus === "pending" ||
        entry.cleanupStatus === "deferred" ||
        entry.cleanupStatus === "in-progress") &&
      rawValue === null
    ) {
      return false;
    }
    return rawValue !== entry.rawValue;
  });
  if (changed) {
    throw new LegacySourceChangedError(
      "Legacy localStorage sources no longer match the migration journal.",
      [...current],
    );
  }
}

interface PreparedLegacyMigrationEntry {
  target: LegacyMigrationTarget;
  rawValue: string;
  payload: Record<string, unknown>;
  rawDigest: PersistenceDigestDescriptor;
  payloadDigest: PersistenceDigestDescriptor;
  metadata: StoredPersistenceMetadata;
  expectedCheckpoint: PersistenceCheckpoint | null;
  checkpoint: PersistenceCheckpoint;
  mapPuts: { key: string; value: unknown }[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactRecordKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every(
      (actualKey, index) => actualKey === sortedExpectedKeys[index],
    )
  );
}

function createLegacyMigrationConflictResolutionKey(legacyKey: string): string {
  return `${LEGACY_MIGRATION_CONFLICT_RESOLUTION_KEY_PREFIX}${encodeURIComponent(
    legacyKey,
  )}`;
}

function committedRootFromObservedRoot(
  root: ObservedRevisionRoot,
): PersistenceCheckpointCommittedRoot {
  return {
    revision: root.revision,
    baseRevision: root.baseRevision,
    digest: root.payloadDigest,
    writerId: root.writerId,
    committedAt: root.committedAt,
  };
}

function committedRootFromMetadata(
  metadata: StoredPersistenceMetadata,
): PersistenceCheckpointCommittedRoot {
  return committedRootFromObservedRoot(metadata);
}

function isPersistenceCheckpointCommittedRootValue(
  value: unknown,
): value is PersistenceCheckpointCommittedRoot {
  if (
    !isPlainRecord(value) ||
    !hasExactRecordKeys(value, [
      "revision",
      "baseRevision",
      "digest",
      "writerId",
      "committedAt",
    ])
  ) {
    return false;
  }
  return (
    typeof value.revision === "string" &&
    value.revision.length > 0 &&
    (value.baseRevision === null ||
      (typeof value.baseRevision === "string" &&
        value.baseRevision.length > 0)) &&
    isPersistenceDigestDescriptor(value.digest) &&
    typeof value.writerId === "string" &&
    value.writerId.length > 0 &&
    typeof value.committedAt === "string" &&
    Number.isFinite(Date.parse(value.committedAt))
  );
}

function legacyMigrationTargetForConflictContext(
  context: StartupRecoveryLegacyMigrationConflict,
  storeName: RecoveryAdoptionStoreName,
): LegacyMigrationTarget | null {
  return (
    LEGACY_MIGRATION_TARGETS.find(
      (target) =>
        target.legacyKey === context.legacyKey &&
        target.storeName === storeName,
    ) ?? null
  );
}

function isLegacyMigrationConflictContext(
  value: unknown,
  storeName: RecoveryAdoptionStoreName,
): value is StartupRecoveryLegacyMigrationConflict {
  if (
    !isPlainRecord(value) ||
    !hasExactRecordKeys(value, [
      "kind",
      "version",
      "legacyKey",
      "targetKey",
      "expectedRawDigest",
    ]) ||
    value.kind !== "event-shopping-planner-legacy-migration-conflict" ||
    value.version !== 1 ||
    typeof value.legacyKey !== "string" ||
    value.legacyKey.length === 0 ||
    value.targetKey !== DATA_KEY ||
    !isPersistenceDigestDescriptor(value.expectedRawDigest)
  ) {
    return false;
  }
  return (
    legacyMigrationTargetForConflictContext(
      value as unknown as StartupRecoveryLegacyMigrationConflict,
      storeName,
    ) !== null
  );
}

function isLegacyMigrationConflictResolution(
  value: unknown,
  target: LegacyMigrationTarget,
): value is LegacyMigrationConflictResolution {
  if (
    !isPlainRecord(value) ||
    !hasExactRecordKeys(value, [
      "kind",
      "schemaVersion",
      "decision",
      "decisionId",
      "legacyKey",
      "storeName",
      "targetKey",
      "expectedLegacyRawDigest",
      "selectedCandidate",
      "selectedRoot",
      "committedRoot",
      "adoptionArchiveKey",
      "createdAt",
    ]) ||
    value.kind !==
      "event-shopping-planner-legacy-migration-conflict-resolution" ||
    value.schemaVersion !==
      LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION ||
    value.decision !== "retain-explicitly-adopted-root" ||
    typeof value.decisionId !== "string" ||
    value.decisionId.length === 0 ||
    value.legacyKey !== target.legacyKey ||
    value.storeName !== target.storeName ||
    value.targetKey !== DATA_KEY ||
    !isPersistenceDigestDescriptor(value.expectedLegacyRawDigest) ||
    !isPlainRecord(value.selectedCandidate) ||
    !hasExactRecordKeys(value.selectedCandidate, [
      "id",
      "source",
      "sourceKey",
      "revision",
      "digest",
    ]) ||
    typeof value.selectedCandidate.id !== "string" ||
    value.selectedCandidate.id.length === 0 ||
    (value.selectedCandidate.source !== "indexedDB" &&
      value.selectedCandidate.source !== "runtime-fallback") ||
    typeof value.selectedCandidate.sourceKey !== "string" ||
    value.selectedCandidate.sourceKey.length === 0 ||
    typeof value.selectedCandidate.revision !== "string" ||
    value.selectedCandidate.revision.length === 0 ||
    !isPersistenceDigestDescriptor(value.selectedCandidate.digest) ||
    !isPersistenceCheckpointCommittedRootValue(value.selectedRoot) ||
    !isPersistenceCheckpointCommittedRootValue(value.committedRoot) ||
    typeof value.adoptionArchiveKey !== "string" ||
    !value.adoptionArchiveKey.startsWith(
      RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX,
    ) ||
    value.adoptionArchiveKey.slice(
      RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX.length,
    ) !== value.decisionId ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return false;
  }
  return (
    value.selectedCandidate.revision === value.selectedRoot.revision &&
    fingerprintsEqual(
      value.selectedCandidate.digest,
      value.selectedRoot.digest,
    ) &&
    value.committedRoot.baseRevision === value.selectedRoot.revision
  );
}

async function selectedRootFromRecoveryAdoptionArchive(
  archive: Record<string, unknown>,
  resolution: LegacyMigrationConflictResolution,
): Promise<{
  root: PersistenceCheckpointCommittedRoot;
  payload: unknown;
  rawValue?: string;
} | null> {
  if (resolution.selectedCandidate.source === "indexedDB") {
    if (!isPlainRecord(archive.currentEvidence)) return null;
    const metadata = archive.currentEvidence.metadata;
    if (
      !isStoredPersistenceMetadata(metadata, resolution.storeName, DATA_KEY)
    ) {
      return null;
    }
    let payload: unknown;
    try {
      if (resolution.storeName === STORES.MAP_DATA) {
        if (!isPlainRecord(archive.currentEvidence.mapEntries)) return null;
        payload = materializeMapData(archive.currentEvidence.mapEntries).data;
      } else {
        if (
          !Object.prototype.hasOwnProperty.call(
            archive.currentEvidence,
            "payload",
          )
        ) {
          return null;
        }
        payload = archive.currentEvidence.payload;
      }
      if (
        !(await verifyPersistenceDigest(payload, metadata.payloadDigest)) ||
        !fingerprintsEqual(
          createSynchronousFingerprint(payload),
          metadata.payloadFingerprint,
        )
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return { root: committedRootFromMetadata(metadata), payload };
  }

  if (!Array.isArray(archive.observedRuntimeCandidates)) return null;
  const source = archive.observedRuntimeCandidates.find(
    (value) =>
      isPlainRecord(value) &&
      value.storageKey === resolution.selectedCandidate.sourceKey,
  );
  if (
    !isPlainRecord(source) ||
    typeof source.rawValue !== "string" ||
    !isPlainRecord(source.candidate)
  ) {
    return null;
  }
  try {
    const parsed = parseRuntimeFallbackCandidate(source.rawValue, {
      storeName: resolution.storeName,
      key: DATA_KEY,
      revision: resolution.selectedCandidate.revision,
    });
    if (
      !fingerprintsEqual(parsed, source.candidate) ||
      !(await verifyPersistenceDigest(parsed.payload, parsed.digest))
    ) {
      return null;
    }
    return {
      root: {
        revision: parsed.revision,
        baseRevision: parsed.baseRevision,
        digest: parsed.digest,
        writerId: parsed.writerId,
        committedAt: parsed.createdAt,
      },
      payload: parsed.payload,
      rawValue: source.rawValue,
    };
  } catch {
    return null;
  }
}

async function recoveryAdoptionArchiveMatchesLegacyResolution(
  value: unknown,
  resolution: LegacyMigrationConflictResolution,
): Promise<boolean> {
  if (
    !isPlainRecord(value) ||
    value.kind !== "event-shopping-planner-recovery-adoption-archive" ||
    value.schemaVersion !== 1 ||
    value.decisionId !== resolution.decisionId ||
    value.storeName !== resolution.storeName ||
    value.key !== DATA_KEY ||
    value.createdAt !== resolution.createdAt ||
    !isPlainRecord(value.candidate) ||
    value.candidate.id !== resolution.selectedCandidate.id ||
    value.candidate.source !== resolution.selectedCandidate.source ||
    value.candidate.sourceKey !== resolution.selectedCandidate.sourceKey ||
    value.candidate.revision !== resolution.selectedCandidate.revision ||
    value.candidate.digest !== resolution.selectedCandidate.digest.value ||
    value.candidate.digestAlgorithm !==
      resolution.selectedCandidate.digest.algorithm ||
    value.candidate.digestCanonicalization !==
      resolution.selectedCandidate.digest.canonicalization ||
    value.candidate.digestCanonicalLength !== undefined ||
    !recoveryEvidenceMatches(
      value.legacyMigrationConflictResolution,
      resolution,
    ) ||
    !isStoredPersistenceMetadata(
      value.committedMetadata,
      resolution.storeName,
      DATA_KEY,
    )
  ) {
    return false;
  }
  const migrationConflict: StartupRecoveryLegacyMigrationConflict = {
    kind: "event-shopping-planner-legacy-migration-conflict",
    version: 1,
    legacyKey: resolution.legacyKey,
    targetKey: DATA_KEY,
    expectedRawDigest: resolution.expectedLegacyRawDigest,
  };
  if (
    value.candidate.role !== "app-payload" ||
    value.candidate.storeName !== resolution.storeName ||
    value.candidate.key !== DATA_KEY ||
    value.candidate.targetKey !== DATA_KEY ||
    !recoveryEvidenceMatches(
      value.candidate.migrationConflict,
      migrationConflict,
    ) ||
    value.candidate.id !==
      createStartupRecoveryCandidateId({
        source: resolution.selectedCandidate.source,
        role: "app-payload",
        storeName: resolution.storeName,
        sourceKey: resolution.selectedCandidate.sourceKey,
        targetKey: DATA_KEY,
        revision: resolution.selectedCandidate.revision,
        digest: resolution.selectedCandidate.digest.value,
        digestAlgorithm: resolution.selectedCandidate.digest.algorithm,
        digestCanonicalization:
          resolution.selectedCandidate.digest.canonicalization,
        migrationConflict,
      })
  ) {
    return false;
  }
  const selected = await selectedRootFromRecoveryAdoptionArchive(
    value,
    resolution,
  );
  if (
    selected === null ||
    !fingerprintsEqual(selected.root, resolution.selectedRoot) ||
    !(await verifyPersistenceDigest(
      selected.payload,
      resolution.selectedCandidate.digest,
    )) ||
    !isPlainRecord(value.chosenSourceEvidence) ||
    value.chosenSourceEvidence.sourceKey !==
      resolution.selectedCandidate.sourceKey ||
    !recoveryEvidenceMatches(
      value.chosenSourceEvidence.payload,
      selected.payload,
    ) ||
    (resolution.selectedCandidate.source === "runtime-fallback"
      ? value.chosenSourceEvidence.rawValue !== selected.rawValue
      : value.chosenSourceEvidence.rawValue !== undefined)
  ) {
    return false;
  }
  let committedCheckpoint: PersistenceCheckpoint | null;
  let committedPayload: unknown;
  try {
    committedPayload = normalizeRecoveryAdoptionPayload(
      resolution.storeName,
      value.chosenSourceEvidence.payload,
    );
    committedCheckpoint = validateCheckpointForRoot(
      value.committedCheckpoint,
      resolution.storeName,
      DATA_KEY,
      value.committedMetadata,
    );
  } catch {
    return false;
  }
  return (
    committedCheckpoint !== null &&
    (await verifyPersistenceDigest(
      committedPayload,
      value.committedMetadata.payloadDigest,
    )) &&
    fingerprintsEqual(
      createSynchronousFingerprint(committedPayload),
      value.committedMetadata.payloadFingerprint,
    ) &&
    fingerprintsEqual(
      committedRootFromMetadata(value.committedMetadata),
      resolution.committedRoot,
    )
  );
}

async function currentMigrationResolutionRootIsValid(
  storeName: RecoveryAdoptionStoreName,
): Promise<boolean> {
  if (storeName === STORES.MAP_DATA) {
    const validation = await validateMapSnapshot(
      await readRawMapSnapshotWithRetry(),
    );
    return !("conflict" in validation) && !validation.validated.root.synthetic;
  }
  const validation = await validatePersistenceSnapshot(
    storeName,
    DATA_KEY,
    await readPersistenceSnapshotWithRetry(storeName, DATA_KEY),
  );
  return !("conflict" in validation) && !validation.validated.root.synthetic;
}

async function legacyMigrationResolutionRepairRequired(
  target: LegacyMigrationTarget,
  rawValue: string,
  message: string,
  additionalCandidates: readonly StartupRecoveryCandidate[] = [],
): Promise<never> {
  const migrationConflict: StartupRecoveryLegacyMigrationConflict = {
    kind: "event-shopping-planner-legacy-migration-conflict",
    version: 1,
    legacyKey: target.legacyKey,
    targetKey: DATA_KEY,
    expectedRawDigest: await createPersistenceDigest(rawValue),
  };
  throw new LegacyMigrationConflictError(message, migrationConflict, [
    ...(await collectMigrationConflictRecoveryCandidates(
      target,
      migrationConflict,
    )),
    ...additionalCandidates,
  ]);
}

async function resolvedLegacyMigrationKeys(
  states: readonly LegacySourceState[],
  journal: unknown,
): Promise<Set<string>> {
  const resolved = new Set<string>();
  for (const { target, rawValue } of states) {
    if (rawValue === null) continue;
    const resolutionKey = createLegacyMigrationConflictResolutionKey(
      target.legacyKey,
    );
    const rawResolution = await readInternalControlRecord(resolutionKey);
    if (rawResolution === undefined || rawResolution === null) continue;
    if (!isLegacyMigrationConflictResolution(rawResolution, target)) {
      await legacyMigrationResolutionRepairRequired(
        target,
        rawValue,
        `Legacy migration resolution must be replaced explicitly for ${target.legacyKey}.`,
      );
      continue;
    }
    if (
      !(await verifyPersistenceDigest(
        rawValue,
        rawResolution.expectedLegacyRawDigest,
      ))
    ) {
      continue;
    }
    const archive = await readInternalControlRecord(
      rawResolution.adoptionArchiveKey,
    );
    const archiveIsValid = await recoveryAdoptionArchiveMatchesLegacyResolution(
      archive,
      rawResolution,
    );
    const currentRootIsValid = await currentMigrationResolutionRootIsValid(
      target.storeName,
    );
    if (!archiveIsValid || !currentRootIsValid) {
      await legacyMigrationResolutionRepairRequired(
        target,
        rawValue,
        `Legacy migration resolution evidence must be replaced explicitly for ${target.legacyKey}.`,
        archive === undefined || archive === null
          ? []
          : [
              createRecoveryCandidate(
                "migration-journal",
                STORES.SYNC_QUEUE,
                rawResolution.adoptionArchiveKey,
                null,
                archive,
                undefined,
                {
                  role: archiveIsValid ? "migration-archive" : "invalid-source",
                  sourceKey: rawResolution.adoptionArchiveKey,
                  adoptable: false,
                },
              ),
            ],
      );
      continue;
    }
    if (
      journal !== undefined &&
      journal !== null &&
      (!isLegacyMigrationJournal(journal) ||
        journal.entries.some(({ legacyKey }) => legacyKey === target.legacyKey))
    ) {
      const matchingEntry = isLegacyMigrationJournal(journal)
        ? journal.entries.find(
            ({ legacyKey }) => legacyKey === target.legacyKey,
          )
        : undefined;
      if (
        isLegacyMigrationJournal(journal) &&
        journal.phase === "prepared" &&
        matchingEntry?.storeName === target.storeName &&
        matchingEntry.rawValue === rawValue &&
        fingerprintsEqual(
          matchingEntry.expectedRawDigest,
          rawResolution.expectedLegacyRawDigest,
        )
      ) {
        const migrationConflict: StartupRecoveryLegacyMigrationConflict = {
          kind: "event-shopping-planner-legacy-migration-conflict",
          version: 1,
          legacyKey: target.legacyKey,
          targetKey: DATA_KEY,
          expectedRawDigest: rawResolution.expectedLegacyRawDigest,
        };
        throw new LegacyMigrationConflictError(
          `A prepared migration journal must be superseded explicitly for ${target.legacyKey}.`,
          migrationConflict,
          await collectMigrationConflictRecoveryCandidates(
            target,
            migrationConflict,
          ),
        );
      }
      if (
        matchingEntry?.storeName === target.storeName &&
        matchingEntry.rawValue === rawValue &&
        fingerprintsEqual(
          matchingEntry.expectedRawDigest,
          rawResolution.expectedLegacyRawDigest,
        ) &&
        fingerprintsEqual(
          matchingEntry.payloadDigest,
          rawResolution.selectedCandidate.digest,
        )
      ) {
        continue;
      }
      throw new PersistenceConflictError(
        `Legacy migration journal conflicts with the explicit resolution for ${target.legacyKey}.`,
      );
    }
    resolved.add(target.legacyKey);
  }
  assertLegacySourcesUnchanged(states);
  return resolved;
}

function parseLegacyMigrationPayload(
  target: LegacyMigrationTarget,
  rawValue: string,
): Record<string, unknown> {
  const parsed = JSON.parse(rawValue) as unknown;
  if (!isPlainRecord(parsed)) {
    throw new Error(`${target.legacyKey} must contain a JSON object.`);
  }

  if (
    target.storeName === STORES.EVENT_LISTS &&
    Object.values(parsed).some((value) => !Array.isArray(value))
  ) {
    throw new Error(`${target.legacyKey} contains a non-array event list.`);
  }
  if (
    target.storeName === STORES.MAP_DATA &&
    Object.values(parsed).some((value) => !isPlainRecord(value))
  ) {
    throw new Error(`${target.legacyKey} contains an invalid event map.`);
  }

  if (target.storeName === STORES.MAP_DATA) {
    return expandMapDataFromStorage(
      compactMapDataForStorage(parsed as MapDataStore),
    ) as Record<string, unknown>;
  }
  return parsed;
}

function isLegacyMigrationJournalEntryV1(
  value: unknown,
  entryKeys: Set<string>,
): value is LegacyMigrationJournalEntryV1 {
  if (!isPlainRecord(value)) return false;
  const target = LEGACY_MIGRATION_TARGETS.find(
    ({ legacyKey, storeName }) =>
      legacyKey === value.legacyKey && storeName === value.storeName,
  );
  if (
    !target ||
    typeof value.rawValue !== "string" ||
    !isPersistenceDigestDescriptor(value.rawDigest) ||
    !isPersistenceDigestDescriptor(value.payloadDigest) ||
    typeof value.targetRevision !== "string" ||
    value.targetRevision.length === 0 ||
    !Array.isArray(value.mapKeys) ||
    value.mapKeys.some((key) => typeof key !== "string") ||
    !["pending", "retained", "removed"].includes(String(value.cleanupStatus)) ||
    entryKeys.has(target.legacyKey)
  ) {
    return false;
  }
  entryKeys.add(target.legacyKey);
  return true;
}

function isLegacyMigrationJournalV1(
  value: unknown,
): value is LegacyMigrationJournalV1 {
  if (!isPlainRecord(value)) return false;
  const entries = value.entries;
  if (!Array.isArray(entries)) return false;
  const entryKeys = new Set<string>();
  const entriesValid = entries.every((entry) =>
    isLegacyMigrationJournalEntryV1(entry, entryKeys),
  );
  const phase = String(value.phase);
  const cleanupStateValid =
    phase === "cleanupPending" ||
    (phase === "completed"
      ? entries.every(
          (entry) => isPlainRecord(entry) && entry.cleanupStatus === "removed",
        )
      : entries.every(
          (entry) => isPlainRecord(entry) && entry.cleanupStatus === "pending",
        ));
  return (
    entriesValid &&
    entries.length > 0 &&
    value.kind === "event-shopping-planner-legacy-migration" &&
    value.schemaVersion === 1 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.ownerId === "string" &&
    value.ownerId.length > 0 &&
    ["prepared", "copied", "verified", "cleanupPending", "completed"].includes(
      phase,
    ) &&
    cleanupStateValid &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

function isLegacyMigrationJournalEntry(
  value: unknown,
  entryKeys: Set<string>,
): value is LegacyMigrationJournalEntry {
  if (!isPlainRecord(value)) return false;
  const target = LEGACY_MIGRATION_TARGETS.find(
    ({ legacyKey, storeName }) =>
      legacyKey === value.legacyKey && storeName === value.storeName,
  );
  if (
    !target ||
    typeof value.rawValue !== "string" ||
    !isPersistenceDigestDescriptor(value.expectedRawDigest) ||
    !isPersistenceDigestDescriptor(value.payloadDigest) ||
    typeof value.targetRevision !== "string" ||
    value.targetRevision.length === 0 ||
    !Array.isArray(value.mapKeys) ||
    value.mapKeys.some((key) => typeof key !== "string") ||
    !["pending", "deferred", "in-progress", "removed"].includes(
      String(value.cleanupStatus),
    ) ||
    entryKeys.has(target.legacyKey)
  ) {
    return false;
  }
  entryKeys.add(target.legacyKey);
  return true;
}

function isLegacyMigrationJournal(
  value: unknown,
): value is LegacyMigrationJournal {
  if (!isPlainRecord(value)) return false;
  const entries = value.entries;
  if (!Array.isArray(entries)) return false;
  const entryKeys = new Set<string>();
  if (
    !entries.every((entry) => isLegacyMigrationJournalEntry(entry, entryKeys))
  ) {
    return false;
  }

  const phase = String(value.phase);
  const dataMigrationStatus = String(value.dataMigrationStatus);
  const cleanupStatus = String(value.cleanupStatus);
  const phaseStatusValid =
    (phase === "prepared" &&
      dataMigrationStatus === "prepared" &&
      cleanupStatus === "not-ready" &&
      entries.every((entry) => entry.cleanupStatus === "pending")) ||
    (phase === "copied" &&
      dataMigrationStatus === "copied" &&
      cleanupStatus === "not-ready" &&
      entries.every((entry) => entry.cleanupStatus === "pending")) ||
    (phase === "verified" &&
      dataMigrationStatus === "verified" &&
      cleanupStatus === "not-ready" &&
      entries.every((entry) => entry.cleanupStatus === "pending")) ||
    (phase === "cleanup-ready" &&
      dataMigrationStatus === "verified" &&
      (cleanupStatus === "ready" || cleanupStatus === "deferred") &&
      entries.every((entry) =>
        ["pending", "deferred", "removed"].includes(entry.cleanupStatus),
      )) ||
    (phase === "cleanup-in-progress" &&
      dataMigrationStatus === "verified" &&
      cleanupStatus === "in-progress" &&
      entries.every((entry) =>
        ["pending", "deferred", "in-progress", "removed"].includes(
          entry.cleanupStatus,
        ),
      )) ||
    (phase === "completed" &&
      dataMigrationStatus === "verified" &&
      cleanupStatus === "completed" &&
      entries.every((entry) => entry.cleanupStatus === "removed"));

  return (
    value.kind === "event-shopping-planner-legacy-migration" &&
    value.schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.ownerId === "string" &&
    value.ownerId.length > 0 &&
    [
      "prepared",
      "copied",
      "verified",
      "cleanup-ready",
      "cleanup-in-progress",
      "completed",
    ].includes(phase) &&
    phaseStatusValid &&
    typeof value.archiveKey === "string" &&
    value.archiveKey === createLegacyMigrationArchiveKey(value.sessionId) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

function createLegacyMigrationArchiveKey(sessionId: string): string {
  return `${LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX}${encodeURIComponent(
    sessionId,
  )}`;
}

function isLegacyMigrationArchive(
  value: unknown,
): value is LegacyMigrationArchive {
  if (!isPlainRecord(value) || !Array.isArray(value.entries)) return false;
  const keys = new Set<string>();
  const entriesValid = value.entries.every((entry) => {
    if (!isPlainRecord(entry) || typeof entry.legacyKey !== "string") {
      return false;
    }
    const migrationTarget = LEGACY_MIGRATION_TARGETS.find(
      ({ legacyKey, storeName }) =>
        entry.sourceKind === "migration-source" &&
        legacyKey === entry.legacyKey &&
        storeName === entry.storeName,
    );
    const preservedSyncQueue =
      entry.sourceKind === "preserved-legacy-sync-queue" &&
      entry.legacyKey === LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY &&
      entry.storeName === STORES.SYNC_QUEUE;
    if (
      (!migrationTarget && !preservedSyncQueue) ||
      typeof entry.rawValue !== "string" ||
      !isPersistenceDigestDescriptor(entry.rawDigest) ||
      typeof entry.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.capturedAt)) ||
      keys.has(entry.legacyKey)
    ) {
      return false;
    }
    keys.add(entry.legacyKey);
    return true;
  });
  return (
    value.kind === "event-shopping-planner-legacy-migration-archive" &&
    value.schemaVersion === LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    value.entries.length > 0 &&
    entriesValid
  );
}

async function readInternalControlRecord(key: string): Promise<unknown> {
  const database = await openDB();
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const transaction = database.transaction(STORES.SYNC_QUEUE, "readonly");
  const finished = transactionFinished(transaction);
  const value = await requestResult(
    transaction.objectStore(STORES.SYNC_QUEUE).get(key),
  );
  await finished;
  return value;
}

async function createLegacyMigrationArchive(
  journal: LegacyMigrationJournal | LegacyMigrationJournalV1,
  legacySyncQueueRawValue: string | null,
): Promise<LegacyMigrationArchive> {
  const capturedAt = new Date().toISOString();
  const migrationEntries = journal.entries.map((entry) => ({
    legacyKey: entry.legacyKey,
    sourceKind: "migration-source" as const,
    storeName: entry.storeName,
    rawValue: entry.rawValue,
    rawDigest:
      "expectedRawDigest" in entry ? entry.expectedRawDigest : entry.rawDigest,
    capturedAt,
  }));
  const syncQueueEntries =
    legacySyncQueueRawValue === null
      ? []
      : [
          {
            legacyKey: LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY,
            sourceKind: "preserved-legacy-sync-queue" as const,
            storeName: STORES.SYNC_QUEUE,
            rawValue: legacySyncQueueRawValue,
            rawDigest: await createPersistenceDigest(legacySyncQueueRawValue),
            capturedAt,
          },
        ];
  return {
    kind: "event-shopping-planner-legacy-migration-archive",
    schemaVersion: LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION,
    sessionId: journal.sessionId,
    createdAt: capturedAt,
    entries: [...migrationEntries, ...syncQueueEntries],
  };
}

async function validateLegacyMigrationArchive(
  value: unknown,
  journal: LegacyMigrationJournal,
  expected?: LegacyMigrationArchive,
): Promise<LegacyMigrationArchive> {
  if (
    !isLegacyMigrationArchive(value) ||
    value.sessionId !== journal.sessionId ||
    (expected !== undefined && !fingerprintsEqual(value, expected))
  ) {
    throw new PersistenceConflictError(
      "Migration recovery archive is missing or was replaced.",
    );
  }

  const entriesByKey = new Map(
    value.entries.map((entry) => [entry.legacyKey, entry]),
  );
  for (const entry of value.entries) {
    if (!(await verifyPersistenceDigest(entry.rawValue, entry.rawDigest))) {
      throw new PersistenceConflictError(
        `Migration recovery archive digest is invalid for ${entry.legacyKey}.`,
      );
    }
  }
  for (const journalEntry of journal.entries) {
    const archived = entriesByKey.get(journalEntry.legacyKey);
    if (
      !archived ||
      archived.sourceKind !== "migration-source" ||
      archived.storeName !== journalEntry.storeName ||
      archived.rawValue !== journalEntry.rawValue ||
      !fingerprintsEqual(archived.rawDigest, journalEntry.expectedRawDigest)
    ) {
      throw new PersistenceConflictError(
        `Migration recovery archive does not match ${journalEntry.legacyKey}.`,
      );
    }
  }
  return value;
}

async function readAndValidateLegacyMigrationArchive(
  journal: LegacyMigrationJournal,
  expected?: LegacyMigrationArchive,
): Promise<LegacyMigrationArchive> {
  return validateLegacyMigrationArchive(
    await readInternalControlRecord(journal.archiveKey),
    journal,
    expected,
  );
}

function upgradeLegacyMigrationJournalValue(
  journal: LegacyMigrationJournalV1,
): LegacyMigrationJournal {
  const allRemoved = journal.entries.every(
    ({ cleanupStatus }) => cleanupStatus === "removed",
  );
  let phase: LegacyMigrationPhase;
  let dataMigrationStatus: LegacyMigrationJournal["dataMigrationStatus"];
  let cleanupStatus: LegacyMigrationJournal["cleanupStatus"];
  switch (journal.phase) {
    case "prepared":
      phase = "prepared";
      dataMigrationStatus = "prepared";
      cleanupStatus = "not-ready";
      break;
    case "copied":
      phase = "copied";
      dataMigrationStatus = "copied";
      cleanupStatus = "not-ready";
      break;
    case "verified":
      phase = "verified";
      dataMigrationStatus = "verified";
      cleanupStatus = "not-ready";
      break;
    case "cleanupPending":
      phase = allRemoved ? "cleanup-in-progress" : "cleanup-ready";
      dataMigrationStatus = "verified";
      cleanupStatus = allRemoved ? "in-progress" : "deferred";
      break;
    case "completed":
      phase = "completed";
      dataMigrationStatus = "verified";
      cleanupStatus = "completed";
      break;
  }

  return {
    kind: journal.kind,
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    sessionId: journal.sessionId,
    ownerId: journal.ownerId,
    phase,
    dataMigrationStatus,
    cleanupStatus,
    archiveKey: createLegacyMigrationArchiveKey(journal.sessionId),
    createdAt: journal.createdAt,
    updatedAt: new Date().toISOString(),
    entries: journal.entries.map((entry) => ({
      legacyKey: entry.legacyKey,
      storeName: entry.storeName,
      rawValue: entry.rawValue,
      expectedRawDigest: entry.rawDigest,
      payloadDigest: entry.payloadDigest,
      targetRevision: entry.targetRevision,
      mapKeys: [...entry.mapKeys],
      cleanupStatus:
        entry.cleanupStatus === "removed"
          ? "removed"
          : journal.phase === "cleanupPending"
            ? "deferred"
            : "pending",
    })),
  };
}

async function upgradeLegacyMigrationJournalV1Atomically(
  journal: LegacyMigrationJournalV1,
  legacySyncQueueRawValue: string | null,
): Promise<LegacyMigrationJournal> {
  await validateLegacyMigrationJournalDescriptors(journal);
  const upgraded = upgradeLegacyMigrationJournalValue(journal);
  const archive = await createLegacyMigrationArchive(
    journal,
    legacySyncQueueRawValue,
  );
  const database = await openDB();
  ensureStoreExists(database, STORES.SYNC_QUEUE);

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORES.SYNC_QUEUE, "readwrite");
    const store = transaction.objectStore(STORES.SYNC_QUEUE);
    let failure: unknown = null;
    let currentJournal: unknown;
    let currentArchive: unknown;
    let readsRemaining = 2;
    let writesQueued = false;

    const abortWith = (error: unknown) => {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    };
    const queueWrites = () => {
      readsRemaining -= 1;
      if (readsRemaining !== 0 || writesQueued) return;
      writesQueued = true;
      try {
        if (
          !isLegacyMigrationJournalV1(currentJournal) ||
          currentJournal.sessionId !== journal.sessionId ||
          !fingerprintsEqual(currentJournal, journal)
        ) {
          throw new PersistenceConflictError(
            "Migration journal changed before its v2 upgrade.",
          );
        }
        if (
          currentArchive !== undefined &&
          currentArchive !== null &&
          (!isLegacyMigrationArchive(currentArchive) ||
            !fingerprintsEqual(currentArchive, archive))
        ) {
          throw new PersistenceConflictError(
            "A different immutable migration archive already exists.",
          );
        }
        if (currentArchive === undefined || currentArchive === null) {
          const archivePut = store.put(archive, upgraded.archiveKey);
          archivePut.onerror = () => {
            failure = failure ?? archivePut.error;
          };
        }
        const journalPut = store.put(upgraded, LEGACY_MIGRATION_JOURNAL_KEY);
        journalPut.onerror = () => {
          failure = failure ?? journalPut.error;
        };
      } catch (error) {
        abortWith(error);
      }
    };

    const journalRequest = store.get(LEGACY_MIGRATION_JOURNAL_KEY);
    journalRequest.onerror = () => {
      failure = failure ?? journalRequest.error;
    };
    journalRequest.onsuccess = () => {
      currentJournal = journalRequest.result;
      queueWrites();
    };
    const archiveRequest = store.get(upgraded.archiveKey);
    archiveRequest.onerror = () => {
      failure = failure ?? archiveRequest.error;
    };
    archiveRequest.onsuccess = () => {
      currentArchive = archiveRequest.result;
      queueWrites();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      failure = failure ?? transaction.error;
    };
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Failed to upgrade the migration journal."),
      );
  });

  await readAndValidateLegacyMigrationArchive(upgraded, archive);
  return upgraded;
}

async function writeMigrationJournalWithCas(
  expected: LegacyMigrationJournal | null,
  next: LegacyMigrationJournal,
): Promise<void> {
  const database = await openDB();
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORES.SYNC_QUEUE, "readwrite");
    let failure: unknown = null;
    const store = transaction.objectStore(STORES.SYNC_QUEUE);
    const readRequest = store.get(LEGACY_MIGRATION_JOURNAL_KEY);
    readRequest.onerror = () => {
      failure = readRequest.error;
    };
    readRequest.onsuccess = () => {
      try {
        const current = readRequest.result;
        if (expected === null) {
          if (current !== undefined && current !== null) {
            throw new PersistenceConflictError(
              "Another migration session owns the journal.",
            );
          }
        } else if (
          !isLegacyMigrationJournal(current) ||
          current.sessionId !== expected.sessionId ||
          !fingerprintsEqual(
            createSynchronousFingerprint(current),
            createSynchronousFingerprint(expected),
          )
        ) {
          throw new PersistenceConflictError(
            "Migration journal changed before its phase update.",
          );
        }
        const writeRequest = store.put(next, LEGACY_MIGRATION_JOURNAL_KEY);
        writeRequest.onerror = () => {
          failure = writeRequest.error;
        };
      } catch (error) {
        failure = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Failed to update the migration journal."),
      );
  });
}

function migrationRecoveryResult(
  message: string,
  error: unknown,
  entries: readonly {
    target: LegacyMigrationTarget;
    rawValue: string;
  }[],
  journal?: unknown,
  currentSources?: readonly LegacySourceState[],
  additionalCandidates: readonly StartupRecoveryCandidate[] = [],
  legacySyncQueueRawValue: string | null = null,
): PersistenceMigrationResult {
  const candidates = entries.map(({ target, rawValue }) =>
    createRecoveryCandidate(
      "legacy-localStorage",
      target.storeName,
      target.legacyKey,
      null,
      null,
      rawValue,
      {
        sourceKey: target.legacyKey,
        targetKey: DATA_KEY,
        adoptable: false,
      },
    ),
  );
  if (journal !== undefined && journal !== null) {
    const journalRevision =
      isLegacyMigrationJournal(journal) || isLegacyMigrationJournalV1(journal)
        ? (journal.entries[0]?.targetRevision ?? null)
        : null;
    candidates.push(
      createRecoveryCandidate(
        "migration-journal",
        STORES.SYNC_QUEUE,
        LEGACY_MIGRATION_JOURNAL_KEY,
        journalRevision,
        journal,
      ),
    );
  }
  if (currentSources) {
    const capturedByKey = new Map(
      entries.map(({ target, rawValue }) => [target.legacyKey, rawValue]),
    );
    currentSources.forEach(({ target, rawValue }) => {
      if (capturedByKey.get(target.legacyKey) === rawValue) return;
      candidates.push(
        createRecoveryCandidate(
          "legacy-localStorage",
          target.storeName,
          target.legacyKey,
          null,
          rawValue === null
            ? { sourceState: "missing", snapshot: "current" }
            : { sourceState: "present", snapshot: "current" },
          rawValue ?? undefined,
          {
            sourceKey: target.legacyKey,
            targetKey: DATA_KEY,
            adoptable: false,
          },
        ),
      );
    });
  }
  if (legacySyncQueueRawValue !== null) {
    candidates.push(
      createRecoveryCandidate(
        "legacy-localStorage",
        STORES.SYNC_QUEUE,
        LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY,
        null,
        {
          sourceState: "present",
          preservation: "archive-only",
        },
        legacySyncQueueRawValue,
      ),
    );
  }
  candidates.push(...additionalCandidates);
  const recognizedJournal = isLegacyMigrationJournal(journal) ? journal : null;
  return {
    status: "recovery-required",
    dataMigrationStatus:
      recognizedJournal?.dataMigrationStatus ?? "recovery-required",
    cleanupStatus: recognizedJournal?.cleanupStatus ?? "recovery-required",
    recoveryBundle: createRecoveryBundle(
      [
        createRecoveryIssue(
          "migration",
          readErrorName(error) || "MigrationError",
          message,
        ),
      ],
      candidates,
    ),
  };
}

async function prepareLegacyMigrationEntries(
  snapshots: readonly {
    target: LegacyMigrationTarget;
    rawValue: string;
  }[],
): Promise<{
  entries: PreparedLegacyMigrationEntry[];
  roots: Map<StoreName, ObservedRevisionRoot>;
}> {
  const entries: PreparedLegacyMigrationEntry[] = [];
  const roots = new Map<StoreName, ObservedRevisionRoot>();

  for (const snapshot of snapshots) {
    const rawDigest = await createPersistenceDigest(snapshot.rawValue);
    const migrationConflict: StartupRecoveryLegacyMigrationConflict = {
      kind: "event-shopping-planner-legacy-migration-conflict",
      version: 1,
      legacyKey: snapshot.target.legacyKey,
      targetKey: DATA_KEY,
      expectedRawDigest: rawDigest,
    };
    let payload: Record<string, unknown>;
    try {
      payload = parseLegacyMigrationPayload(snapshot.target, snapshot.rawValue);
      assertStructuredCloneable(payload);
    } catch {
      throw new LegacyMigrationConflictError(
        `${snapshot.target.legacyKey} cannot be parsed as a supported legacy source.`,
        migrationConflict,
        await collectMigrationConflictRecoveryCandidates(
          snapshot.target,
          migrationConflict,
        ),
      );
    }
    const payloadDigest = await createPersistenceDigest(payload);
    let validated: ValidatedPersistenceSnapshot<unknown>;
    let absorbedSnapshots: RuntimeCandidateSnapshot<unknown>[] = [];

    if (snapshot.target.storeName === STORES.MAP_DATA) {
      const rawMapSnapshot = await readRawMapSnapshotWithRetry();
      const validation = await validateMapSnapshot(rawMapSnapshot);
      if ("conflict" in validation) {
        const trustedCandidate = await trustedMigrationRecoveryCandidate(
          snapshot.target.storeName,
          {
            mapEntries: rawMapSnapshot.entries,
            metadata: rawMapSnapshot.metadata,
            checkpoint: rawMapSnapshot.checkpoint,
          },
          migrationConflict,
        );
        throw new LegacyMigrationConflictError(
          "Existing mapData is inconsistent.",
          migrationConflict,
          [
            ...(trustedCandidate ? [trustedCandidate] : []),
            ...(validation.conflict.recoveryBundle?.candidates ?? []),
          ],
        );
      }
      validated = validation.validated;
      const currentCandidate = validatedMigrationRecoveryCandidate(
        snapshot.target.storeName,
        validated,
        migrationConflict,
      );
      const currentCandidates = currentCandidate ? [currentCandidate] : [];
      const existingMap = validated.data ?? {};
      for (const [eventName, eventMapData] of Object.entries(existingMap)) {
        const targetEventMap = payload[eventName];
        if (!isPlainRecord(targetEventMap)) {
          throw new LegacyMigrationConflictError(
            `Existing mapData event ${eventName} is absent from the legacy source.`,
            migrationConflict,
            currentCandidates,
          );
        }
        for (const [dayMapName, dayMapData] of Object.entries(eventMapData)) {
          if (!(dayMapName in targetEventMap)) {
            throw new LegacyMigrationConflictError(
              `Existing mapData entry ${eventName}/${dayMapName} is absent from the legacy source.`,
              migrationConflict,
              currentCandidates,
            );
          }
          const existingDigest = await createPersistenceDigest(dayMapData);
          const targetDigest = await createPersistenceDigest(
            targetEventMap[dayMapName],
          );
          if (existingDigest.value !== targetDigest.value) {
            throw new LegacyMigrationConflictError(
              `Existing mapData entry ${eventName}/${dayMapName} conflicts with the legacy source.`,
              migrationConflict,
              currentCandidates,
            );
          }
        }
      }
    } else {
      const rawSnapshot = await readPersistenceSnapshotWithRetry(
        snapshot.target.storeName,
        DATA_KEY,
      );
      const validation = await validatePersistenceSnapshot(
        snapshot.target.storeName,
        DATA_KEY,
        rawSnapshot,
      );
      if ("conflict" in validation) {
        const trustedCandidate = await trustedMigrationRecoveryCandidate(
          snapshot.target.storeName,
          {
            payload: rawSnapshot.payload,
            metadata: rawSnapshot.metadata,
            checkpoint: rawSnapshot.checkpoint,
          },
          migrationConflict,
        );
        throw new LegacyMigrationConflictError(
          `${snapshot.target.storeName} is inconsistent.`,
          migrationConflict,
          [
            ...(trustedCandidate ? [trustedCandidate] : []),
            ...(validation.conflict.recoveryBundle?.candidates ?? []),
          ],
        );
      }
      validated = validation.validated;
      const currentCandidate = validatedMigrationRecoveryCandidate(
        snapshot.target.storeName,
        validated,
        migrationConflict,
      );
      const currentCandidates = currentCandidate ? [currentCandidate] : [];
      const candidateScan = await readRuntimeCandidateSnapshots<
        Record<string, unknown>
      >(snapshot.target.storeName, DATA_KEY);
      if (candidateScan.status === "conflict") {
        throw new LegacyMigrationConflictError(
          `${snapshot.target.storeName} has an invalid runtime fallback candidate.`,
          migrationConflict,
          [
            ...currentCandidates,
            ...(candidateScan.result.recoveryBundle?.candidates ?? []),
          ],
        );
      }
      const partitioned = partitionRuntimeCandidateSnapshots(
        validated.checkpoint,
        candidateScan.snapshots,
      );
      const reconciliation = reconcileRuntimeFallbackCandidates(
        {
          revision: validated.root.missing ? null : validated.root.revision,
          baseRevision: validated.root.missing
            ? null
            : validated.root.baseRevision,
          digest: validated.root.missing
            ? undefined
            : validated.root.payloadDigest,
          writerId: validated.root.missing
            ? undefined
            : validated.root.writerId,
          createdAt: validated.root.missing
            ? undefined
            : validated.root.committedAt,
        },
        partitioned.active.map(({ candidate }) => candidate),
        validated.checkpoint?.absorbedCandidates ?? [],
      );
      if (
        reconciliation.status === "conflict" ||
        reconciliation.head !== null
      ) {
        throw new LegacyMigrationConflictError(
          `${snapshot.target.storeName} has an active runtime fallback branch.`,
          migrationConflict,
          [
            ...currentCandidates,
            ...runtimeSnapshotsToRecoveryCandidates(
              snapshot.target.storeName,
              DATA_KEY,
              candidateScan.snapshots,
              migrationConflict,
            ),
          ],
        );
      }
      if (validated.status === "ok") {
        const existingDigest = await createPersistenceDigest(validated.data);
        if (existingDigest.value !== payloadDigest.value) {
          throw new LegacyMigrationConflictError(
            `${snapshot.target.storeName} conflicts with the legacy source.`,
            migrationConflict,
            currentCandidates,
          );
        }
      }
      absorbedSnapshots = candidateScan.snapshots;
    }

    roots.set(snapshot.target.storeName, validated.root);
    const metadata = createStoredMetadata(
      snapshot.target.storeName,
      DATA_KEY,
      createPersistenceRevision(persistenceWriterId),
      validated.root.missing ? null : validated.root.revision,
      payloadDigest,
      createSynchronousFingerprint(payload),
    );
    const checkpoint = createNextPersistenceCheckpoint(
      snapshot.target.storeName,
      DATA_KEY,
      metadata,
      validated.checkpoint,
      absorbedSnapshots,
    );
    entries.push({
      target: snapshot.target,
      rawValue: snapshot.rawValue,
      payload,
      rawDigest,
      payloadDigest,
      metadata,
      expectedCheckpoint: validated.checkpoint,
      checkpoint,
      mapPuts:
        snapshot.target.storeName === STORES.MAP_DATA
          ? buildMapDataPuts(payload as MapDataStore)
          : [],
    });
  }

  return { entries, roots };
}

function createLegacyMigrationJournal(
  entries: readonly PreparedLegacyMigrationEntry[],
): LegacyMigrationJournal {
  const now = new Date().toISOString();
  const sessionId = createPersistenceRevision(persistenceWriterId);
  return {
    kind: "event-shopping-planner-legacy-migration",
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    sessionId,
    ownerId: persistenceWriterId,
    phase: "prepared",
    dataMigrationStatus: "prepared",
    cleanupStatus: "not-ready",
    archiveKey: createLegacyMigrationArchiveKey(sessionId),
    createdAt: now,
    updatedAt: now,
    entries: entries.map((entry) => ({
      legacyKey: entry.target.legacyKey,
      storeName: entry.target.storeName,
      rawValue: entry.rawValue,
      expectedRawDigest: entry.rawDigest,
      payloadDigest: entry.payloadDigest,
      targetRevision: entry.metadata.revision,
      mapKeys: entry.mapPuts.map(({ key }) => key).sort(),
      cleanupStatus: "pending",
    })),
  };
}

function withJournalPhase(
  journal: LegacyMigrationJournal,
  phase: LegacyMigrationPhase,
  cleanupStatus?: LegacyMigrationJournalEntry["cleanupStatus"],
): LegacyMigrationJournal {
  const dataMigrationStatus: LegacyMigrationJournal["dataMigrationStatus"] =
    phase === "prepared"
      ? "prepared"
      : phase === "copied"
        ? "copied"
        : "verified";
  const journalCleanupStatus: LegacyMigrationJournal["cleanupStatus"] =
    phase === "prepared" || phase === "copied" || phase === "verified"
      ? "not-ready"
      : phase === "cleanup-ready"
        ? cleanupStatus === "deferred"
          ? "deferred"
          : "ready"
        : phase === "cleanup-in-progress"
          ? "in-progress"
          : "completed";
  return {
    ...journal,
    phase,
    dataMigrationStatus,
    cleanupStatus: journalCleanupStatus,
    updatedAt: new Date().toISOString(),
    entries:
      cleanupStatus === undefined
        ? journal.entries
        : journal.entries.map((entry) => ({ ...entry, cleanupStatus })),
  };
}

async function copyLegacyMigrationAtomically(
  entries: readonly PreparedLegacyMigrationEntry[],
  journal: LegacyMigrationJournal,
  roots: ReadonlyMap<StoreName, ObservedRevisionRoot>,
  archive: LegacyMigrationArchive,
): Promise<LegacyMigrationJournal> {
  const database = await openDB();
  const targetStores = Array.from(
    new Set<StoreName>([
      ...entries.map(({ target }) => target.storeName),
      STORES.SYNC_QUEUE,
    ]),
  );
  targetStores.forEach((storeName) => ensureStoreExists(database, storeName));
  const copiedJournal = withJournalPhase(journal, "copied");

  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(targetStores, "readwrite");
    } catch (error) {
      reject(error);
      return;
    }
    let failure: unknown = null;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      failure = failure ?? transaction.error;
    };
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Legacy migration transaction was aborted."),
      );
    const track = (request: IDBRequest) => {
      request.onerror = () => {
        failure = failure ?? request.error;
      };
    };

    try {
      const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);
      const currentPayloads = new Map<StoreName, unknown>();
      const currentMetadata = new Map<StoreName, unknown>();
      const currentCheckpoints = new Map<StoreName, unknown>();
      let currentMapEntries: Record<string, unknown> | null = null;
      let currentJournal: unknown;
      let currentArchive: unknown;
      let remainingReads = entries.length * 3 + 2;
      let writesQueued = false;

      const abortWith = (error: unknown) => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      };

      const commitIfReady = () => {
        remainingReads -= 1;
        if (remainingReads !== 0 || writesQueued) return;
        writesQueued = true;
        try {
          if (
            !isLegacyMigrationJournal(currentJournal) ||
            currentJournal.sessionId !== journal.sessionId ||
            !fingerprintsEqual(
              createSynchronousFingerprint(currentJournal),
              createSynchronousFingerprint(journal),
            )
          ) {
            throw new PersistenceConflictError(
              "Migration journal ownership changed before copy.",
            );
          }
          if (
            currentArchive !== undefined &&
            currentArchive !== null &&
            (!isLegacyMigrationArchive(currentArchive) ||
              !fingerprintsEqual(currentArchive, archive))
          ) {
            throw new PersistenceConflictError(
              "A different immutable migration archive already exists.",
            );
          }

          entries.forEach((entry) => {
            const root = roots.get(entry.target.storeName);
            if (!root) {
              throw new Error(
                `Missing observed root for ${entry.target.storeName}.`,
              );
            }
            if (entry.target.storeName === STORES.MAP_DATA) {
              if (currentMapEntries === null) {
                throw new Error("Missing mapData CAS snapshot.");
              }
              const knownKeys = assertCurrentMapMatchesExpected(
                currentMapEntries,
                currentMetadata.get(STORES.MAP_DATA),
                root,
              );
              const mapStore = transaction.objectStore(STORES.MAP_DATA);
              knownKeys.forEach((storageKey) =>
                track(mapStore.delete(storageKey)),
              );
              entry.mapPuts.forEach(({ key, value }) =>
                track(mapStore.put(value, key)),
              );
            } else {
              assertCurrentSnapshotMatchesExpected(
                entry.target.storeName,
                DATA_KEY,
                currentPayloads.get(entry.target.storeName),
                currentMetadata.get(entry.target.storeName),
                root,
              );
              track(
                transaction
                  .objectStore(entry.target.storeName)
                  .put(entry.payload, DATA_KEY),
              );
            }
            assertCurrentCheckpointMatchesExpected(
              entry.target.storeName,
              DATA_KEY,
              currentCheckpoints.get(entry.target.storeName),
              entry.expectedCheckpoint,
            );
            track(
              controlStore.put(
                entry.metadata,
                createPersistenceMetadataKey(entry.target.storeName, DATA_KEY),
              ),
            );
            track(
              controlStore.put(
                entry.checkpoint,
                createPersistenceCheckpointKey(
                  entry.target.storeName,
                  DATA_KEY,
                ),
              ),
            );
          });
          if (currentArchive === undefined || currentArchive === null) {
            track(controlStore.put(archive, journal.archiveKey));
          }
          track(controlStore.put(copiedJournal, LEGACY_MIGRATION_JOURNAL_KEY));
        } catch (error) {
          abortWith(error);
        }
      };

      const journalRequest = controlStore.get(LEGACY_MIGRATION_JOURNAL_KEY);
      journalRequest.onerror = () => {
        failure = failure ?? journalRequest.error;
      };
      journalRequest.onsuccess = () => {
        currentJournal = journalRequest.result;
        commitIfReady();
      };
      const archiveRequest = controlStore.get(journal.archiveKey);
      archiveRequest.onerror = () => {
        failure = failure ?? archiveRequest.error;
      };
      archiveRequest.onsuccess = () => {
        currentArchive = archiveRequest.result;
        commitIfReady();
      };

      entries.forEach((entry) => {
        const metadataRequest = controlStore.get(
          createPersistenceMetadataKey(entry.target.storeName, DATA_KEY),
        );
        metadataRequest.onerror = () => {
          failure = failure ?? metadataRequest.error;
        };
        metadataRequest.onsuccess = () => {
          currentMetadata.set(entry.target.storeName, metadataRequest.result);
          commitIfReady();
        };
        const checkpointRequest = controlStore.get(
          createPersistenceCheckpointKey(entry.target.storeName, DATA_KEY),
        );
        checkpointRequest.onerror = () => {
          failure = failure ?? checkpointRequest.error;
        };
        checkpointRequest.onsuccess = () => {
          currentCheckpoints.set(
            entry.target.storeName,
            checkpointRequest.result,
          );
          commitIfReady();
        };

        if (entry.target.storeName === STORES.MAP_DATA) {
          const mapEntries: Record<string, unknown> = {};
          const cursorRequest = transaction
            .objectStore(STORES.MAP_DATA)
            .openCursor();
          cursorRequest.onerror = () => {
            failure = failure ?? cursorRequest.error;
          };
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              mapEntries[String(cursor.key)] = cursor.value;
              cursor.continue();
              return;
            }
            currentMapEntries = mapEntries;
            commitIfReady();
          };
        } else {
          const payloadRequest = transaction
            .objectStore(entry.target.storeName)
            .get(DATA_KEY);
          payloadRequest.onerror = () => {
            failure = failure ?? payloadRequest.error;
          };
          payloadRequest.onsuccess = () => {
            currentPayloads.set(entry.target.storeName, payloadRequest.result);
            commitIfReady();
          };
        }
      });
    } catch (error) {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    }
  });
  return copiedJournal;
}

async function verifyLegacyMigration(
  entries: readonly PreparedLegacyMigrationEntry[],
  journal: LegacyMigrationJournal,
): Promise<void> {
  for (const entry of entries) {
    const targetRevision = journal.entries.find(
      ({ legacyKey }) => legacyKey === entry.target.legacyKey,
    )?.targetRevision;
    if (entry.target.storeName === STORES.MAP_DATA) {
      const snapshot = await readRawMapSnapshotWithRetry();
      const validation = await validateMapSnapshot(snapshot);
      if ("conflict" in validation) {
        throw (
          validation.conflict.error ??
          new PersistenceConflictError(
            "Direct validation of migrated mapData failed.",
          )
        );
      }
      const materialized = materializeMapData(snapshot.entries);
      const actualDigest = await createPersistenceDigest(materialized.data);
      const actualKeys = materialized.knownKeys.sort();
      const expectedKeys = [...entry.mapPuts.map(({ key }) => key)].sort();
      if (
        validation.validated.root.synthetic ||
        validation.validated.root.revision !== targetRevision ||
        validation.validated.root.payloadDigest.value !==
          entry.payloadDigest.value ||
        actualDigest.value !== entry.payloadDigest.value ||
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        throw new Error("Direct verification of migrated mapData failed.");
      }
    } else {
      const snapshot = await readPersistenceSnapshotWithRetry(
        entry.target.storeName,
        DATA_KEY,
      );
      const validation = await validatePersistenceSnapshot(
        entry.target.storeName,
        DATA_KEY,
        snapshot,
      );
      if ("conflict" in validation) {
        throw (
          validation.conflict.error ??
          new PersistenceConflictError(
            `Direct validation of ${entry.target.storeName} failed.`,
          )
        );
      }
      const actualDigest = await createPersistenceDigest(snapshot.payload);
      if (
        validation.validated.root.synthetic ||
        validation.validated.root.revision !== targetRevision ||
        validation.validated.root.payloadDigest.value !==
          entry.payloadDigest.value ||
        actualDigest.value !== entry.payloadDigest.value
      ) {
        throw new Error(
          `Direct verification of ${entry.target.storeName} failed.`,
        );
      }
    }
  }
}

async function verifyCommittedMigrationTargets(
  journal: LegacyMigrationJournal,
  requireJournalTarget = false,
): Promise<{
  roots: Map<StoreName, ObservedRevisionRoot>;
  checkpoints: Map<StoreName, PersistenceCheckpoint | null>;
}> {
  const roots = new Map<StoreName, ObservedRevisionRoot>();
  const checkpoints = new Map<StoreName, PersistenceCheckpoint | null>();
  for (const entry of journal.entries) {
    let validated: ValidatedPersistenceSnapshot<unknown>;
    if (entry.storeName === STORES.MAP_DATA) {
      const validation = await validateMapSnapshot(
        await readRawMapSnapshotWithRetry(),
      );
      if ("conflict" in validation) {
        throw (
          validation.conflict.error ??
          new PersistenceConflictError(
            "Committed mapData is inconsistent while resuming migration.",
          )
        );
      }
      validated = validation.validated;
    } else {
      const validation = await validatePersistenceSnapshot<unknown>(
        entry.storeName,
        DATA_KEY,
        await readPersistenceSnapshotWithRetry(entry.storeName, DATA_KEY),
      );
      if ("conflict" in validation) {
        throw (
          validation.conflict.error ??
          new PersistenceConflictError(
            `${entry.storeName} is inconsistent while resuming migration.`,
          )
        );
      }
      validated = validation.validated;
    }

    if (validated.root.synthetic) {
      throw new PersistenceConflictError(
        `${entry.storeName} has no committed persistence root while resuming migration.`,
      );
    }
    if (
      requireJournalTarget &&
      (validated.root.revision !== entry.targetRevision ||
        validated.root.payloadDigest.value !== entry.payloadDigest.value)
    ) {
      throw new PersistenceConflictError(
        `${entry.storeName} no longer matches the migration target root.`,
      );
    }
    roots.set(entry.storeName, validated.root);
    checkpoints.set(entry.storeName, validated.checkpoint);
  }
  return { roots, checkpoints };
}

function legacySnapshotsFromJournal(
  journal: LegacyMigrationJournal | LegacyMigrationJournalV1,
): { target: LegacyMigrationTarget; rawValue: string }[] {
  return journal.entries.map((entry) => {
    const target = LEGACY_MIGRATION_TARGETS.find(
      ({ legacyKey, storeName }) =>
        legacyKey === entry.legacyKey && storeName === entry.storeName,
    );
    if (!target) {
      throw new PersistenceConflictError(
        `Migration journal contains an unknown target: ${entry.legacyKey}.`,
      );
    }
    return { target, rawValue: entry.rawValue };
  });
}

async function validateLegacyMigrationJournalDescriptors(
  journal: LegacyMigrationJournal | LegacyMigrationJournalV1,
): Promise<void> {
  for (const snapshot of legacySnapshotsFromJournal(journal)) {
    const journalEntry = journal.entries.find(
      ({ legacyKey }) => legacyKey === snapshot.target.legacyKey,
    );
    if (!journalEntry) {
      throw new PersistenceConflictError(
        `Migration journal entry is missing: ${snapshot.target.legacyKey}.`,
      );
    }
    const payload = parseLegacyMigrationPayload(
      snapshot.target,
      snapshot.rawValue,
    );
    const [rawDigestValid, payloadDigestValid] = await Promise.all([
      verifyPersistenceDigest(
        snapshot.rawValue,
        "expectedRawDigest" in journalEntry
          ? journalEntry.expectedRawDigest
          : journalEntry.rawDigest,
      ),
      verifyPersistenceDigest(payload, journalEntry.payloadDigest),
    ]);
    const mapKeys =
      snapshot.target.storeName === STORES.MAP_DATA
        ? buildMapDataPuts(payload as MapDataStore)
            .map(({ key }) => key)
            .sort()
        : [];
    const recordedMapKeys = [...journalEntry.mapKeys].sort();
    if (
      !rawDigestValid ||
      !payloadDigestValid ||
      mapKeys.length !== recordedMapKeys.length ||
      mapKeys.some((key, index) => key !== recordedMapKeys[index])
    ) {
      throw new PersistenceConflictError(
        `Migration journal descriptors do not match ${snapshot.target.legacyKey}.`,
      );
    }
  }
}

function assertPreparedEntriesMatchJournal(
  entries: readonly PreparedLegacyMigrationEntry[],
  journal: LegacyMigrationJournal,
): void {
  const journalByKey = new Map(
    journal.entries.map((entry) => [entry.legacyKey, entry]),
  );
  entries.forEach((entry) => {
    const recorded = journalByKey.get(entry.target.legacyKey);
    const mapKeys = entry.mapPuts.map(({ key }) => key).sort();
    const recordedMapKeys = recorded ? [...recorded.mapKeys].sort() : [];
    if (
      !recorded ||
      recorded.storeName !== entry.target.storeName ||
      recorded.rawValue !== entry.rawValue ||
      recorded.expectedRawDigest.value !== entry.rawDigest.value ||
      recorded.payloadDigest.value !== entry.payloadDigest.value ||
      mapKeys.length !== recordedMapKeys.length ||
      mapKeys.some((key, index) => key !== recordedMapKeys[index])
    ) {
      throw new PersistenceConflictError(
        `Migration journal digest no longer matches ${entry.target.legacyKey}.`,
      );
    }
    entry.metadata = {
      ...entry.metadata,
      revision: recorded.targetRevision,
    };
    entry.checkpoint = {
      ...entry.checkpoint,
      committedRoot: {
        revision: entry.metadata.revision,
        baseRevision: entry.metadata.baseRevision,
        digest: entry.metadata.payloadDigest,
        writerId: entry.metadata.writerId,
        committedAt: entry.metadata.committedAt,
      },
      updatedAt: new Date().toISOString(),
    };
  });
}

interface LegacyCleanupDeferralResult {
  journal: LegacyMigrationJournal;
  journalWriteFailed: boolean;
}

async function tryWriteLegacyCleanupJournalWithCas(
  expected: LegacyMigrationJournal,
  next: LegacyMigrationJournal,
): Promise<boolean> {
  try {
    await writeMigrationJournalWithCas(expected, next);
    return true;
  } catch {
    return false;
  }
}

async function deferLegacyCleanupFromJournal(
  journal: LegacyMigrationJournal,
): Promise<LegacyCleanupDeferralResult> {
  const currentSources = captureLegacySourceStates();
  const resolvedKeys = await resolvedLegacyMigrationKeys(
    currentSources,
    journal,
  );
  assertJournalSourcesResumable(
    journal,
    currentSources.filter(({ target }) => !resolvedKeys.has(target.legacyKey)),
  );
  if (
    journal.phase === "cleanup-in-progress" &&
    journal.entries.every(({ cleanupStatus }) => cleanupStatus === "removed")
  ) {
    const completedJournal = withJournalPhase(journal, "completed", "removed");
    await writeMigrationJournalWithCas(journal, completedJournal);
    const completedSources = captureLegacySourceStates();
    const completedResolvedKeys = await resolvedLegacyMigrationKeys(
      completedSources,
      completedJournal,
    );
    assertJournalSourcesResumable(
      completedJournal,
      completedSources.filter(
        ({ target }) => !completedResolvedKeys.has(target.legacyKey),
      ),
    );
    return { journal: completedJournal, journalWriteFailed: false };
  }
  if (
    journal.phase !== "cleanup-ready" ||
    journal.cleanupStatus === "deferred"
  ) {
    return { journal, journalWriteFailed: false };
  }

  // Release A keeps physical cleanup disabled. Verification and deferred
  // cleanup are separate states so normal startup can continue safely.
  const deferredJournal: LegacyMigrationJournal = {
    ...journal,
    cleanupStatus: "deferred",
    updatedAt: new Date().toISOString(),
    entries: journal.entries.map((entry) =>
      entry.cleanupStatus === "pending"
        ? { ...entry, cleanupStatus: "deferred" as const }
        : entry,
    ),
  };
  if (!(await tryWriteLegacyCleanupJournalWithCas(journal, deferredJournal))) {
    return { journal, journalWriteFailed: true };
  }
  const deferredSources = captureLegacySourceStates();
  const deferredResolvedKeys = await resolvedLegacyMigrationKeys(
    deferredSources,
    deferredJournal,
  );
  assertJournalSourcesResumable(
    deferredJournal,
    deferredSources.filter(
      ({ target }) => !deferredResolvedKeys.has(target.legacyKey),
    ),
  );
  return { journal: deferredJournal, journalWriteFailed: false };
}

function successfulMigrationResult(
  journal: LegacyMigrationJournal,
  cleanupStatus: Exclude<
    PersistenceCleanupStatus,
    "not-needed" | "recovery-required"
  > = journal.cleanupStatus,
): PersistenceMigrationResult {
  if (journal.entries.length === 0) {
    return {
      status: "cleanup-pending",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "deferred",
      migratedKeys: [],
    };
  }
  return {
    status: journal.phase === "completed" ? "completed" : "cleanup-pending",
    dataMigrationStatus: "verified",
    cleanupStatus,
    migratedKeys: journal.entries.map(({ legacyKey }) => legacyKey),
  };
}

function removedLegacyMigrationKeys(
  journal: LegacyMigrationJournal | null,
): string[] {
  return (
    journal?.entries
      .filter(({ cleanupStatus }) => cleanupStatus === "removed")
      .map(({ legacyKey }) => legacyKey) ?? []
  );
}

function legacyCleanupDeferred(
  mode: PersistenceCleanupMode,
  reason:
    | PersistenceCleanupDeferredReason
    | PersistenceLegacyCleanupTaskDeferredReason,
  journal: LegacyMigrationJournal | null,
): PersistenceLegacyCleanupResult {
  return {
    status: "cleanup-deferred",
    mode,
    reason,
    removedKeys: removedLegacyMigrationKeys(journal),
  };
}

function legacyCleanupBlocked(
  mode: PersistenceCleanupMode,
  reason:
    | PersistenceCleanupBlockedReason
    | PersistenceLegacyCleanupTaskBlockedReason,
  journal: LegacyMigrationJournal | null,
): PersistenceLegacyCleanupResult {
  return {
    status: "cleanup-blocked",
    mode,
    reason,
    removedKeys: removedLegacyMigrationKeys(journal),
  };
}

function legacyCleanupCompleted(
  mode: PersistenceCleanupMode,
  journal: LegacyMigrationJournal | null,
): PersistenceLegacyCleanupResult {
  return {
    status: "completed",
    mode,
    removedKeys: journal?.entries.map(({ legacyKey }) => legacyKey) ?? [],
  };
}

async function writeAndReadLegacyCleanupJournalWithCas(
  expected: LegacyMigrationJournal,
  next: LegacyMigrationJournal,
): Promise<LegacyMigrationJournal | null> {
  try {
    await writeMigrationJournalWithCas(expected, next);
    const readback = await readInternalControlRecord(
      LEGACY_MIGRATION_JOURNAL_KEY,
    );
    if (
      !isLegacyMigrationJournal(readback) ||
      readback.sessionId !== next.sessionId ||
      !fingerprintsEqual(
        createSynchronousFingerprint(readback),
        createSynchronousFingerprint(next),
      )
    ) {
      return null;
    }
    return readback;
  } catch {
    return null;
  }
}

function withLegacyCleanupInProgress(
  journal: LegacyMigrationJournal,
): LegacyMigrationJournal {
  return {
    ...journal,
    phase: "cleanup-in-progress",
    cleanupStatus: "in-progress",
    updatedAt: new Date().toISOString(),
    entries: journal.entries.map((entry) => ({ ...entry })),
  };
}

function withLegacyCleanupEntryStatus(
  journal: LegacyMigrationJournal,
  entryIndex: number,
  cleanupStatus: "in-progress" | "removed",
): LegacyMigrationJournal {
  return {
    ...journal,
    phase: "cleanup-in-progress",
    cleanupStatus: "in-progress",
    updatedAt: new Date().toISOString(),
    entries: journal.entries.map((entry, index) =>
      index === entryIndex ? { ...entry, cleanupStatus } : { ...entry },
    ),
  };
}

function withLegacyCleanupCompleted(
  journal: LegacyMigrationJournal,
): LegacyMigrationJournal {
  return {
    ...journal,
    phase: "completed",
    cleanupStatus: "completed",
    updatedAt: new Date().toISOString(),
    entries: journal.entries.map((entry) => ({
      ...entry,
      cleanupStatus: "removed",
    })),
  };
}

function inspectLegacyCleanupSourceConflict(
  journal: LegacyMigrationJournal,
): PersistenceLegacyCleanupTaskBlockedReason | null {
  const entriesByKey = new Map(
    journal.entries.map((entry) => [entry.legacyKey, entry]),
  );
  for (const { target, rawValue } of captureLegacySourceStates()) {
    const entry = entriesByKey.get(target.legacyKey);
    if (!entry) {
      if (rawValue !== null) return "legacy-source-changed";
      continue;
    }
    if (entry.cleanupStatus === "removed") {
      if (rawValue !== null) return "legacy-source-reappeared";
      continue;
    }
    if (rawValue !== null && rawValue !== entry.rawValue) {
      return "legacy-source-changed";
    }
  }
  return null;
}

async function readValidatedLegacyCleanupArchive(
  journal: LegacyMigrationJournal,
  expected?: LegacyMigrationArchive,
): Promise<LegacyMigrationArchive | null> {
  try {
    return await readAndValidateLegacyMigrationArchive(journal, expected);
  } catch {
    return null;
  }
}

async function committedLegacyCleanupTargetsAreValid(
  journal: LegacyMigrationJournal,
): Promise<boolean> {
  try {
    await verifyCommittedMigrationTargets(journal);
    return true;
  } catch {
    return false;
  }
}

function readLegacyCleanupSource(
  legacyKey: string,
): { status: "ok"; rawValue: string | null } | { status: "failed" } {
  try {
    return { status: "ok", rawValue: localStorage.getItem(legacyKey) };
  } catch {
    return { status: "failed" };
  }
}

function removeLegacyCleanupSource(legacyKey: string): boolean {
  try {
    localStorage.removeItem(legacyKey);
    return true;
  } catch {
    return false;
  }
}

async function revalidateLegacyCleanupSafety(
  mode: PersistenceCleanupMode,
  journal: LegacyMigrationJournal | null,
  revalidateSafety: PersistenceCleanupTaskContext["revalidateSafety"],
): Promise<PersistenceLegacyCleanupResult | null> {
  const safety = await revalidateSafety();
  if (safety.status === "safe") return null;
  return safety.status === "cleanup-blocked"
    ? legacyCleanupBlocked(mode, safety.reason, journal)
    : legacyCleanupDeferred(mode, safety.reason, journal);
}

async function executePhysicalLegacyCleanup(
  request: PersistenceLegacyCleanupSafetyRequest,
  revalidateSafety: PersistenceCleanupTaskContext["revalidateSafety"],
): Promise<PersistenceLegacyCleanupResult> {
  const mode = request.mode;
  let rawJournal: unknown;
  try {
    rawJournal = await readInternalControlRecord(LEGACY_MIGRATION_JOURNAL_KEY);
  } catch {
    return legacyCleanupBlocked(mode, "migration-journal-invalid", null);
  }

  if (rawJournal === undefined || rawJournal === null) {
    return legacyCleanupCompleted(mode, null);
  }
  if (!isLegacyMigrationJournal(rawJournal)) {
    return legacyCleanupBlocked(mode, "migration-journal-invalid", null);
  }

  let journal = rawJournal;
  const archive = await readValidatedLegacyCleanupArchive(journal);
  if (!archive) {
    return legacyCleanupBlocked(mode, "migration-archive-invalid", journal);
  }
  if (!(await committedLegacyCleanupTargetsAreValid(journal))) {
    return legacyCleanupBlocked(mode, "committed-target-invalid", journal);
  }

  let sourceConflict: PersistenceLegacyCleanupTaskBlockedReason | null;
  try {
    sourceConflict = inspectLegacyCleanupSourceConflict(journal);
  } catch {
    return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
  }
  if (sourceConflict) {
    return legacyCleanupBlocked(mode, sourceConflict, journal);
  }

  let safetyStop = await revalidateLegacyCleanupSafety(
    mode,
    journal,
    revalidateSafety,
  );
  if (safetyStop) return safetyStop;

  if (journal.phase === "completed") {
    return legacyCleanupCompleted(mode, journal);
  }
  if (
    journal.phase !== "cleanup-ready" &&
    journal.phase !== "cleanup-in-progress"
  ) {
    return legacyCleanupDeferred(mode, "cleanup-not-ready", journal);
  }

  if (journal.phase === "cleanup-ready") {
    const started = await writeAndReadLegacyCleanupJournalWithCas(
      journal,
      withLegacyCleanupInProgress(journal),
    );
    if (!started) {
      return legacyCleanupDeferred(
        mode,
        "migration-journal-cas-failed",
        journal,
      );
    }
    journal = started;
  }

  for (let entryIndex = 0; entryIndex < journal.entries.length; entryIndex++) {
    safetyStop = await revalidateLegacyCleanupSafety(
      mode,
      journal,
      revalidateSafety,
    );
    if (safetyStop) return safetyStop;

    if (!(await readValidatedLegacyCleanupArchive(journal, archive))) {
      return legacyCleanupBlocked(mode, "migration-archive-invalid", journal);
    }
    if (!(await committedLegacyCleanupTargetsAreValid(journal))) {
      return legacyCleanupBlocked(mode, "committed-target-invalid", journal);
    }
    try {
      sourceConflict = inspectLegacyCleanupSourceConflict(journal);
    } catch {
      return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
    }
    if (sourceConflict) {
      return legacyCleanupBlocked(mode, sourceConflict, journal);
    }

    let entry = journal.entries[entryIndex];
    if (entry.cleanupStatus === "removed") continue;

    const beforeClaim = readLegacyCleanupSource(entry.legacyKey);
    if (beforeClaim.status === "failed") {
      return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
    }
    if (beforeClaim.rawValue === null) {
      if (entry.cleanupStatus !== "in-progress") {
        return legacyCleanupBlocked(
          mode,
          "legacy-source-missing-before-claim",
          journal,
        );
      }
      const removed = await writeAndReadLegacyCleanupJournalWithCas(
        journal,
        withLegacyCleanupEntryStatus(journal, entryIndex, "removed"),
      );
      if (!removed) {
        return legacyCleanupDeferred(
          mode,
          "migration-journal-cas-failed",
          journal,
        );
      }
      journal = removed;
      const afterResume = readLegacyCleanupSource(entry.legacyKey);
      if (afterResume.status === "failed") {
        return legacyCleanupBlocked(
          mode,
          "legacy-storage-unavailable",
          journal,
        );
      }
      if (afterResume.rawValue !== null) {
        return legacyCleanupBlocked(mode, "legacy-source-reappeared", journal);
      }
      emitPersistenceCleanupMetric(request.metricSink, {
        name: "persistence-cleanup-key-confirmed-removed",
        mode,
      });
      continue;
    }
    if (beforeClaim.rawValue !== entry.rawValue) {
      return legacyCleanupBlocked(mode, "legacy-source-changed", journal);
    }
    let rawDigestMatches = false;
    try {
      rawDigestMatches = await verifyPersistenceDigest(
        beforeClaim.rawValue,
        entry.expectedRawDigest,
      );
    } catch {
      rawDigestMatches = false;
    }
    if (!rawDigestMatches) {
      return legacyCleanupBlocked(
        mode,
        "legacy-source-digest-mismatch",
        journal,
      );
    }

    if (entry.cleanupStatus !== "in-progress") {
      const claimed = await writeAndReadLegacyCleanupJournalWithCas(
        journal,
        withLegacyCleanupEntryStatus(journal, entryIndex, "in-progress"),
      );
      if (!claimed) {
        return legacyCleanupDeferred(
          mode,
          "migration-journal-cas-failed",
          journal,
        );
      }
      journal = claimed;
      entry = journal.entries[entryIndex];
    }

    const beforeRemove = readLegacyCleanupSource(entry.legacyKey);
    if (beforeRemove.status === "failed") {
      return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
    }
    if (beforeRemove.rawValue === null) {
      return legacyCleanupDeferred(
        mode,
        "legacy-source-missing-after-claim",
        journal,
      );
    }
    if (beforeRemove.rawValue !== entry.rawValue) {
      return legacyCleanupBlocked(mode, "legacy-source-changed", journal);
    }
    safetyStop = await revalidateLegacyCleanupSafety(
      mode,
      journal,
      revalidateSafety,
    );
    if (safetyStop) return safetyStop;

    // Safety proof collection is asynchronous. Re-read synchronously after it
    // completes so a write that happened during revalidation cannot be removed.
    const immediatelyBeforeRemove = readLegacyCleanupSource(entry.legacyKey);
    if (immediatelyBeforeRemove.status === "failed") {
      return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
    }
    if (immediatelyBeforeRemove.rawValue === null) {
      return legacyCleanupDeferred(
        mode,
        "legacy-source-missing-after-claim",
        journal,
      );
    }
    if (immediatelyBeforeRemove.rawValue !== entry.rawValue) {
      return legacyCleanupBlocked(mode, "legacy-source-changed", journal);
    }
    if (!removeLegacyCleanupSource(entry.legacyKey)) {
      return legacyCleanupDeferred(
        mode,
        "legacy-source-remove-failed",
        journal,
      );
    }

    const afterRemove = readLegacyCleanupSource(entry.legacyKey);
    if (afterRemove.status === "failed") {
      return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
    }
    if (afterRemove.rawValue !== null) {
      return legacyCleanupBlocked(mode, "legacy-source-reappeared", journal);
    }

    const removed = await writeAndReadLegacyCleanupJournalWithCas(
      journal,
      withLegacyCleanupEntryStatus(journal, entryIndex, "removed"),
    );
    if (!removed) {
      return legacyCleanupDeferred(
        mode,
        "migration-journal-cas-failed",
        journal,
      );
    }
    journal = removed;

    const afterJournalCommit = readLegacyCleanupSource(entry.legacyKey);
    if (afterJournalCommit.status === "failed") {
      return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
    }
    if (afterJournalCommit.rawValue !== null) {
      return legacyCleanupBlocked(mode, "legacy-source-reappeared", journal);
    }
    emitPersistenceCleanupMetric(request.metricSink, {
      name: "persistence-cleanup-key-confirmed-removed",
      mode,
    });
  }

  if (!(await readValidatedLegacyCleanupArchive(journal, archive))) {
    return legacyCleanupBlocked(mode, "migration-archive-invalid", journal);
  }
  if (!(await committedLegacyCleanupTargetsAreValid(journal))) {
    return legacyCleanupBlocked(mode, "committed-target-invalid", journal);
  }
  try {
    sourceConflict = inspectLegacyCleanupSourceConflict(journal);
  } catch {
    return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
  }
  if (sourceConflict) {
    return legacyCleanupBlocked(mode, sourceConflict, journal);
  }
  if (
    journal.entries.some(({ cleanupStatus }) => cleanupStatus !== "removed")
  ) {
    return legacyCleanupDeferred(mode, "cleanup-not-ready", journal);
  }

  safetyStop = await revalidateLegacyCleanupSafety(
    mode,
    journal,
    revalidateSafety,
  );
  if (safetyStop) return safetyStop;

  const completed = await writeAndReadLegacyCleanupJournalWithCas(
    journal,
    withLegacyCleanupCompleted(journal),
  );
  if (!completed) {
    return legacyCleanupDeferred(mode, "migration-journal-cas-failed", journal);
  }
  journal = completed;

  try {
    sourceConflict = inspectLegacyCleanupSourceConflict(journal);
  } catch {
    return legacyCleanupBlocked(mode, "legacy-storage-unavailable", journal);
  }
  if (sourceConflict) {
    return legacyCleanupBlocked(mode, sourceConflict, journal);
  }
  return legacyCleanupCompleted(mode, journal);
}

async function cleanupLegacyPersistenceSources(
  request: PersistenceLegacyCleanupSafetyRequest,
): Promise<PersistenceLegacyCleanupResult> {
  let physicalOutcome: PersistenceLegacyCleanupResult | null = null;
  const metricSink = (
    event: Parameters<NonNullable<typeof request.metricSink>>[0],
  ) => {
    if (
      event.name === "persistence-cleanup-completed" &&
      physicalOutcome?.status !== "completed"
    ) {
      return;
    }
    recordPersistenceCleanupReleaseAMetric(event);
    return request.metricSink?.(event);
  };
  const cleanupTask = async (context: PersistenceCleanupTaskContext) => {
    physicalOutcome = await executePhysicalLegacyCleanup(
      { ...request, metricSink },
      context.revalidateSafety,
    );
    if (physicalOutcome.status === "cleanup-deferred") {
      emitPersistenceCleanupMetric(metricSink, {
        name: "persistence-cleanup-physical-deferred",
        mode: request.mode,
        reason: physicalOutcome.reason,
      });
    } else if (physicalOutcome.status === "cleanup-blocked") {
      emitPersistenceCleanupMetric(metricSink, {
        name: "persistence-cleanup-physical-blocked",
        mode: request.mode,
        reason: physicalOutcome.reason,
      });
    }
    return physicalOutcome;
  };
  const coordinated =
    request.mode === "auto"
      ? await coordinatePersistenceLegacyCleanup({
          ...request,
          buildFlagValue: undefined,
          lockManager: undefined,
          metricSink,
          cleanupTask,
        })
      : await coordinatePersistenceLegacyCleanup({
          ...request,
          buildFlagValue: undefined,
          lockManager: undefined,
          metricSink,
          cleanupTask,
        });

  if (coordinated.status === "completed") return coordinated.value;
  return { ...coordinated, removedKeys: [] };
}

function registerCommittedMigrationState(state: {
  roots: ReadonlyMap<StoreName, ObservedRevisionRoot>;
  checkpoints: ReadonlyMap<StoreName, PersistenceCheckpoint | null>;
}): void {
  state.roots.forEach((root, storeName) => {
    expectedRevisionRoots.set(getObservedRootKey(storeName, DATA_KEY), root);
    expectedPersistenceCheckpoints.set(
      getObservedRootKey(storeName, DATA_KEY),
      state.checkpoints.get(storeName) ?? null,
    );
  });
}

function migrationArchiveRecoveryCandidates(
  archive: LegacyMigrationArchive | undefined,
): StartupRecoveryCandidate[] {
  if (!archive) return [];
  return [
    createRecoveryCandidate(
      "migration-journal",
      STORES.SYNC_QUEUE,
      createLegacyMigrationArchiveKey(archive.sessionId),
      null,
      archive,
    ),
  ];
}

function assertPreservedLegacySyncQueueUnchanged(
  archive: LegacyMigrationArchive,
  currentRawValue: string | null,
): void {
  const archived = archive.entries.find(
    ({ sourceKind }) => sourceKind === "preserved-legacy-sync-queue",
  );
  if (currentRawValue === null) return;
  if (!archived || archived.rawValue !== currentRawValue) {
    throw new PersistenceConflictError(
      "The preserved legacy syncQueue source changed after it was archived.",
    );
  }
}

async function migrateFromLocalStorage(
  options: {
    /**
     * @deprecated Legacy sources are retained because Web Storage cannot
     * atomically compare and remove a value written by another tab.
     */
    cleanupLegacySources?: boolean;
  } = {},
): Promise<PersistenceMigrationResult> {
  // Kept for API compatibility. Automatic removal is intentionally disabled
  // because localStorage cannot atomically prove that a value is still the
  // verified migration source at deletion time.
  void options.cleanupLegacySources;
  let capturedSources: LegacySourceState[];
  let capturedLegacySyncQueueRawValue: string | null;
  try {
    capturedSources = captureLegacySourceStates();
    capturedLegacySyncQueueRawValue = captureLegacySyncQueueSource();
  } catch (error) {
    return migrationRecoveryResult(
      "旧データのスナップショットを取得できませんでした。",
      error,
      [],
    );
  }
  let snapshots = presentLegacySourceSnapshots(capturedSources);
  let unresolvedCapturedSources = capturedSources;
  let explicitlyResolvedLegacyKeys = new Set<string>();
  let existingJournal: LegacyMigrationJournal | null = null;
  let rawJournalForRecovery: unknown;
  let migrationArchive: LegacyMigrationArchive | undefined;
  try {
    const rawJournal = await readInternalControlRecord(
      LEGACY_MIGRATION_JOURNAL_KEY,
    );
    rawJournalForRecovery = rawJournal;
    let normalizedJournal = rawJournal;
    if (isLegacyMigrationJournalV1(rawJournal)) {
      existingJournal = await upgradeLegacyMigrationJournalV1Atomically(
        rawJournal,
        capturedLegacySyncQueueRawValue,
      );
      migrationArchive =
        await readAndValidateLegacyMigrationArchive(existingJournal);
      normalizedJournal = existingJournal;
    } else if (
      rawJournal !== undefined &&
      rawJournal !== null &&
      !isLegacyMigrationJournal(rawJournal)
    ) {
      const unsupportedVersion =
        isPlainRecord(rawJournal) &&
        rawJournal.kind === "event-shopping-planner-legacy-migration" &&
        rawJournal.schemaVersion !== 1 &&
        rawJournal.schemaVersion !== LEGACY_MIGRATION_SCHEMA_VERSION;
      return migrationRecoveryResult(
        unsupportedVersion
          ? "未対応versionの移行ジャーナルを検出したため、自動処理を停止しました。"
          : "移行ジャーナルの形式が不正です。",
        new PersistenceConflictError(
          unsupportedVersion
            ? "Unsupported migration journal version."
            : "Invalid migration journal.",
        ),
        snapshots,
        rawJournal,
        undefined,
        [],
        capturedLegacySyncQueueRawValue,
      );
    }
    explicitlyResolvedLegacyKeys = await resolvedLegacyMigrationKeys(
      capturedSources,
      normalizedJournal,
    );
    unresolvedCapturedSources = capturedSources.filter(
      ({ target }) => !explicitlyResolvedLegacyKeys.has(target.legacyKey),
    );
    if (normalizedJournal === undefined || normalizedJournal === null) {
      snapshots = presentLegacySourceSnapshots(unresolvedCapturedSources);
    }
    if (normalizedJournal !== undefined && normalizedJournal !== null) {
      if (existingJournal === null) {
        existingJournal = normalizedJournal as LegacyMigrationJournal;
      }
      snapshots = legacySnapshotsFromJournal(existingJournal);
      await validateLegacyMigrationJournalDescriptors(existingJournal);
      try {
        assertJournalSourcesResumable(
          existingJournal,
          unresolvedCapturedSources,
        );
      } catch (error) {
        return migrationRecoveryResult(
          "移行待ちの原本が前回のスナップショットから変更されています。",
          error,
          snapshots,
          existingJournal,
          error instanceof LegacySourceChangedError
            ? error.currentSources
            : capturedSources,
          migrationArchiveRecoveryCandidates(migrationArchive),
          capturedLegacySyncQueueRawValue,
        );
      }

      if (!migrationArchive) {
        const rawArchive = await readInternalControlRecord(
          existingJournal.archiveKey,
        );
        if (rawArchive !== undefined && rawArchive !== null) {
          migrationArchive = await validateLegacyMigrationArchive(
            rawArchive,
            existingJournal,
          );
        } else if (existingJournal.phase !== "prepared") {
          throw new PersistenceConflictError(
            "Migration recovery archive is missing after copy.",
          );
        }
      }
      if (migrationArchive) {
        assertPreservedLegacySyncQueueUnchanged(
          migrationArchive,
          capturedLegacySyncQueueRawValue,
        );
      }

      if (
        existingJournal.phase === "completed" ||
        existingJournal.phase === "verified" ||
        existingJournal.phase === "cleanup-ready" ||
        existingJournal.phase === "cleanup-in-progress"
      ) {
        let terminalJournal = existingJournal;
        let reportedCleanupStatus = terminalJournal.cleanupStatus;
        try {
          if (!migrationArchive) {
            throw new PersistenceConflictError(
              "Migration recovery archive is missing.",
            );
          }
          await readAndValidateLegacyMigrationArchive(
            terminalJournal,
            migrationArchive,
          );
          const committedState =
            await verifyCommittedMigrationTargets(terminalJournal);
          if (terminalJournal.phase === "verified") {
            const cleanupReadyJournal = withJournalPhase(
              terminalJournal,
              "cleanup-ready",
            );
            if (
              await tryWriteLegacyCleanupJournalWithCas(
                terminalJournal,
                cleanupReadyJournal,
              )
            ) {
              terminalJournal = cleanupReadyJournal;
            } else {
              reportedCleanupStatus = "deferred";
            }
          }
          if (
            terminalJournal.phase === "cleanup-ready" ||
            terminalJournal.phase === "cleanup-in-progress"
          ) {
            const deferral =
              await deferLegacyCleanupFromJournal(terminalJournal);
            terminalJournal = deferral.journal;
            reportedCleanupStatus = deferral.journalWriteFailed
              ? "deferred"
              : terminalJournal.cleanupStatus;
          }
          const currentSources = captureLegacySourceStates();
          const currentResolvedKeys = await resolvedLegacyMigrationKeys(
            currentSources,
            terminalJournal,
          );
          assertJournalSourcesResumable(
            terminalJournal,
            currentSources.filter(
              ({ target }) => !currentResolvedKeys.has(target.legacyKey),
            ),
          );
          assertPreservedLegacySyncQueueUnchanged(
            migrationArchive,
            captureLegacySyncQueueSource(),
          );
          registerCommittedMigrationState(committedState);
        } catch (error) {
          return migrationRecoveryResult(
            "移行済みデータのcommitted rootが欠損または不整合です。",
            error,
            snapshots,
            terminalJournal,
            error instanceof LegacySourceChangedError
              ? error.currentSources
              : undefined,
            migrationArchiveRecoveryCandidates(migrationArchive),
            captureLegacySyncQueueSourceForRecovery(
              capturedLegacySyncQueueRawValue,
            ),
          );
        }
        return successfulMigrationResult(
          terminalJournal,
          reportedCleanupStatus,
        );
      }
    }
  } catch (error) {
    return migrationRecoveryResult(
      "移行ジャーナルの所有権または原本を確認できませんでした。",
      error,
      snapshots,
      existingJournal ?? rawJournalForRecovery,
      error instanceof LegacySourceChangedError
        ? error.currentSources
        : undefined,
      [
        ...migrationArchiveRecoveryCandidates(migrationArchive),
        ...(error instanceof LegacyMigrationConflictError
          ? error.recoveryCandidates
          : []),
      ],
      capturedLegacySyncQueueRawValue,
    );
  }
  if (
    !existingJournal &&
    snapshots.length === 0 &&
    capturedLegacySyncQueueRawValue === null
  ) {
    if (explicitlyResolvedLegacyKeys.size > 0) {
      try {
        assertLegacySourcesUnchanged(capturedSources);
        if (
          captureLegacySyncQueueSource() !== capturedLegacySyncQueueRawValue
        ) {
          throw new PersistenceConflictError(
            "The legacy syncQueue source changed while validating explicit migration resolutions.",
          );
        }
      } catch (error) {
        return migrationRecoveryResult(
          "競合解決の検証中に旧データ原本が変更されました。",
          error,
          presentLegacySourceSnapshots(capturedSources),
          rawJournalForRecovery,
          error instanceof LegacySourceChangedError
            ? error.currentSources
            : captureLegacySourceStates(),
          [],
          captureLegacySyncQueueSourceForRecovery(
            capturedLegacySyncQueueRawValue,
          ),
        );
      }
      return {
        status: "cleanup-pending",
        migratedKeys: Array.from(explicitlyResolvedLegacyKeys).sort(),
        dataMigrationStatus: "verified",
        cleanupStatus: "deferred",
      };
    }
    return {
      status: "not-needed",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "not-needed",
    };
  }

  let prepared: Awaited<ReturnType<typeof prepareLegacyMigrationEntries>>;
  try {
    prepared = await prepareLegacyMigrationEntries(snapshots);
  } catch (error) {
    return migrationRecoveryResult(
      "旧データの解析・検証、または既存IndexedDBとの比較に失敗しました。",
      error,
      snapshots,
      existingJournal ?? rawJournalForRecovery,
      undefined,
      [
        ...migrationArchiveRecoveryCandidates(migrationArchive),
        ...(error instanceof LegacyMigrationConflictError
          ? error.recoveryCandidates
          : []),
      ],
      capturedLegacySyncQueueRawValue,
    );
  }

  let journal: LegacyMigrationJournal | undefined;
  try {
    if (existingJournal) {
      journal = existingJournal;
      assertPreparedEntriesMatchJournal(prepared.entries, journal);
      if (journal.phase === "copied" || journal.phase === "verified") {
        await verifyLegacyMigration(prepared.entries, journal);
      }
    } else {
      journal = createLegacyMigrationJournal(prepared.entries);
      await writeMigrationJournalWithCas(null, journal);
    }
    if (!migrationArchive) {
      const rawArchive = await readInternalControlRecord(journal.archiveKey);
      if (rawArchive !== undefined && rawArchive !== null) {
        migrationArchive = await validateLegacyMigrationArchive(
          rawArchive,
          journal,
        );
      } else {
        migrationArchive = await createLegacyMigrationArchive(
          journal,
          capturedLegacySyncQueueRawValue,
        );
      }
    }
    assertPreservedLegacySyncQueueUnchanged(
      migrationArchive,
      capturedLegacySyncQueueRawValue,
    );

    const capturedForCopy = capturedSources;
    if (journal.phase === "prepared") {
      assertLegacySourcesUnchanged(capturedForCopy);
      journal = await copyLegacyMigrationAtomically(
        prepared.entries,
        journal,
        prepared.roots,
        migrationArchive,
      );
    }
    await readAndValidateLegacyMigrationArchive(journal, migrationArchive);
    await verifyLegacyMigration(prepared.entries, journal);
    assertLegacySourcesUnchanged(capturedForCopy);
    assertPreservedLegacySyncQueueUnchanged(
      migrationArchive,
      captureLegacySyncQueueSource(),
    );
    const committedState = await verifyCommittedMigrationTargets(journal, true);
    registerCommittedMigrationState(committedState);
    if (journal.phase !== "verified") {
      const verifiedJournal = withJournalPhase(journal, "verified");
      await writeMigrationJournalWithCas(journal, verifiedJournal);
      journal = verifiedJournal;
    }
    assertLegacySourcesUnchanged(capturedForCopy);
    assertPreservedLegacySyncQueueUnchanged(
      migrationArchive,
      captureLegacySyncQueueSource(),
    );

    const cleanupReadyJournal = withJournalPhase(journal, "cleanup-ready");
    if (
      !(await tryWriteLegacyCleanupJournalWithCas(journal, cleanupReadyJournal))
    ) {
      return successfulMigrationResult(journal, "deferred");
    }
    journal = cleanupReadyJournal;
    assertLegacySourcesUnchanged(capturedForCopy);
    assertPreservedLegacySyncQueueUnchanged(
      migrationArchive,
      captureLegacySyncQueueSource(),
    );
    const deferral = await deferLegacyCleanupFromJournal(journal);
    journal = deferral.journal;
    return successfulMigrationResult(
      journal,
      deferral.journalWriteFailed ? "deferred" : journal.cleanupStatus,
    );
  } catch (error) {
    if (
      prepared.entries.length === 0 &&
      capturedLegacySyncQueueRawValue !== null
    ) {
      return {
        status: "cleanup-pending",
        dataMigrationStatus: "not-needed",
        cleanupStatus: "deferred",
        cleanupDeferredReason: "legacy-sync-queue-archive-unavailable",
        migratedKeys: [],
      };
    }
    return migrationRecoveryResult(
      "旧データの一括コピーまたは読戻し検証に失敗しました。",
      error,
      snapshots,
      journal,
      error instanceof LegacySourceChangedError
        ? error.currentSources
        : undefined,
      migrationArchiveRecoveryCandidates(migrationArchive),
      captureLegacySyncQueueSourceForRecovery(capturedLegacySyncQueueRawValue),
    );
  }
}

// エクスポート用の型定義
export interface AppData {
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

const APP_DATA_RESTORE_STORE_NAMES = [
  STORES.EVENT_LISTS,
  STORES.EVENT_METADATA,
  STORES.EXECUTE_MODE_ITEMS,
  STORES.DAY_MODES,
  STORES.MAP_DATA,
  STORES.MAP_ROTATION_SETTINGS,
  STORES.ROUTE_SETTINGS,
  STORES.HALL_DEFINITIONS,
  STORES.HALL_ROUTE_SETTINGS,
  STORES.MAP_VIEWPORT_SETTINGS,
] as const;

interface AppDataRestoreObservation {
  roots: Map<StoreName, ObservedRevisionRoot>;
  checkpoints: Map<StoreName, PersistenceCheckpoint | null>;
  runtimeCandidates: RuntimeCandidateSnapshot<unknown>[];
}

async function observeAppDataRestoreState(): Promise<AppDataRestoreObservation> {
  const roots = new Map<StoreName, ObservedRevisionRoot>();
  const checkpoints = new Map<StoreName, PersistenceCheckpoint | null>();
  const runtimeCandidates: RuntimeCandidateSnapshot<unknown>[] = [];

  await Promise.all(
    APP_DATA_RESTORE_STORE_NAMES.map(async (storeName) => {
      if (storeName === STORES.MAP_DATA) {
        const validation = await validateMapSnapshot(
          await readRawMapSnapshotWithRetry(),
        );
        if ("conflict" in validation) {
          throw (
            validation.conflict.error ??
            new PersistenceConflictError(
              "mapData is inconsistent before atomic restore.",
            )
          );
        }
        roots.set(storeName, validation.validated.root);
        checkpoints.set(storeName, validation.validated.checkpoint);
        return;
      }

      const [snapshot, candidateScan] = await Promise.all([
        readPersistenceSnapshotWithRetry(storeName, DATA_KEY),
        readRuntimeCandidateSnapshots<unknown>(storeName, DATA_KEY),
      ]);
      const validation = await validatePersistenceSnapshot<unknown>(
        storeName,
        DATA_KEY,
        snapshot,
      );
      if ("conflict" in validation) {
        throw (
          validation.conflict.error ??
          new PersistenceConflictError(
            `${storeName} is inconsistent before atomic restore.`,
          )
        );
      }
      if (candidateScan.status === "conflict") {
        throw (
          candidateScan.result.error ??
          new PersistenceConflictError(
            `${storeName} has an invalid runtime fallback before restore.`,
          )
        );
      }
      const partitioned = partitionRuntimeCandidateSnapshots(
        validation.validated.checkpoint,
        candidateScan.snapshots,
      );
      const reconciliation = reconcileRuntimeFallbackCandidates(
        {
          revision: validation.validated.root.missing
            ? null
            : validation.validated.root.revision,
          baseRevision: validation.validated.root.missing
            ? null
            : validation.validated.root.baseRevision,
          digest: validation.validated.root.missing
            ? undefined
            : validation.validated.root.payloadDigest,
          writerId: validation.validated.root.missing
            ? undefined
            : validation.validated.root.writerId,
          createdAt: validation.validated.root.missing
            ? undefined
            : validation.validated.root.committedAt,
        },
        partitioned.active.map(({ candidate }) => candidate),
        validation.validated.checkpoint?.absorbedCandidates ?? [],
      );
      if (reconciliation.status === "conflict" || reconciliation.head) {
        throw new PersistenceConflictError(
          `${storeName} has an unresolved runtime fallback before restore.`,
        );
      }
      roots.set(storeName, validation.validated.root);
      checkpoints.set(storeName, validation.validated.checkpoint);
      runtimeCandidates.push(...candidateScan.snapshots);
    }),
  );

  return { roots, checkpoints, runtimeCandidates };
}

async function restoreAppDataAtomically(data: AppData): Promise<void> {
  const stableData = structuredClone(data);
  const stableMapData = normalizeMapDataForPersistence(
    stableData.mapData as MapDataStore,
  );
  const observation = await observeAppDataRestoreState();
  const database = await openDB();
  APP_DATA_RESTORE_STORE_NAMES.forEach((storeName) => {
    ensureStoreExists(database, storeName);
  });
  ensureStoreExists(database, STORES.SYNC_QUEUE);

  const restorePayloads = new Map<StoreName, unknown>([
    [STORES.EVENT_LISTS, stableData.eventLists],
    [STORES.EVENT_METADATA, stableData.eventMetadata],
    [STORES.EXECUTE_MODE_ITEMS, stableData.executeModeItems],
    [STORES.DAY_MODES, stableData.dayModes],
    [STORES.MAP_DATA, stableMapData],
    [STORES.MAP_ROTATION_SETTINGS, stableData.mapRotationSettings],
    [STORES.ROUTE_SETTINGS, stableData.routeSettings],
    [STORES.HALL_DEFINITIONS, stableData.hallDefinitions],
    [STORES.HALL_ROUTE_SETTINGS, stableData.hallRouteSettings],
    [STORES.MAP_VIEWPORT_SETTINGS, stableData.mapViewportSettings],
  ]);
  const preparedMetadata = new Map<StoreName, StoredPersistenceMetadata>();
  const preparedCheckpoints = new Map<StoreName, PersistenceCheckpoint>();
  await Promise.all(
    APP_DATA_RESTORE_STORE_NAMES.map(async (storeName) => {
      const observed = observation.roots.get(storeName);
      if (!observed) {
        throw new Error(`Missing restore observation for ${storeName}.`);
      }
      const metadata = await prepareMetadataForPayload(
        storeName,
        DATA_KEY,
        restorePayloads.get(storeName),
        observed.missing ? null : observed.revision,
      );
      preparedMetadata.set(storeName, metadata);
      preparedCheckpoints.set(
        storeName,
        createNextPersistenceCheckpoint(
          storeName,
          DATA_KEY,
          metadata,
          observation.checkpoints.get(storeName) ?? null,
          observation.runtimeCandidates.filter(
            ({ candidate }) =>
              candidate.storeName === storeName && candidate.key === DATA_KEY,
          ),
        ),
      );
    }),
  );
  const mapPuts = buildMapDataPuts(stableMapData);

  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        [...APP_DATA_RESTORE_STORE_NAMES, STORES.SYNC_QUEUE],
        "readwrite",
      );
    } catch (error) {
      reject(error);
      return;
    }

    let failure: unknown = null;
    const currentPayloads = new Map<StoreName, unknown>();
    const currentMetadata = new Map<StoreName, unknown>();
    const currentCheckpoints = new Map<StoreName, unknown>();
    let currentMapEntries: Record<string, unknown> | null = null;
    let remainingReads = APP_DATA_RESTORE_STORE_NAMES.length * 3;
    let writesQueued = false;

    const trackRequest = (request: IDBRequest): void => {
      request.onerror = () => {
        failure =
          failure ??
          request.error ??
          new Error("IndexedDB atomic restore request failed.");
      };
    };

    const abortWith = (error: unknown): void => {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    };

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      failure = failure ?? transaction.error;
    };

    transaction.onabort = () => {
      reject(
        failure ??
          transaction.error ??
          new Error("IndexedDB atomic restore transaction was aborted."),
      );
    };

    const commitIfReady = (): void => {
      remainingReads -= 1;
      if (remainingReads !== 0 || writesQueued) return;
      writesQueued = true;

      try {
        const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);
        APP_DATA_RESTORE_STORE_NAMES.forEach((storeName) => {
          const observed = observation.roots.get(storeName);
          const metadata = preparedMetadata.get(storeName);
          const checkpoint = preparedCheckpoints.get(storeName);
          if (!observed || !metadata || !checkpoint) {
            throw new Error(`Missing restore state for ${storeName}.`);
          }

          if (storeName === STORES.MAP_DATA) {
            if (currentMapEntries === null) {
              throw new Error("Missing mapData restore CAS snapshot.");
            }
            const knownKeys = assertCurrentMapMatchesExpected(
              currentMapEntries,
              currentMetadata.get(storeName),
              observed,
            );
            const mapStore = transaction.objectStore(storeName);
            knownKeys.forEach((storageKey) => {
              trackRequest(mapStore.delete(storageKey));
            });
            mapPuts.forEach(({ key, value }) => {
              trackRequest(mapStore.put(value, key));
            });
          } else {
            assertCurrentSnapshotMatchesExpected(
              storeName,
              DATA_KEY,
              currentPayloads.get(storeName),
              currentMetadata.get(storeName),
              observed,
            );
            trackRequest(
              transaction
                .objectStore(storeName)
                .put(restorePayloads.get(storeName), DATA_KEY),
            );
          }
          assertCurrentCheckpointMatchesExpected(
            storeName,
            DATA_KEY,
            currentCheckpoints.get(storeName),
            observation.checkpoints.get(storeName) ?? null,
          );

          trackRequest(
            controlStore.put(
              metadata,
              createPersistenceMetadataKey(storeName, DATA_KEY),
            ),
          );
          trackRequest(
            controlStore.put(
              checkpoint,
              createPersistenceCheckpointKey(storeName, DATA_KEY),
            ),
          );
        });
      } catch (error) {
        abortWith(error);
      }
    };

    try {
      const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);
      APP_DATA_RESTORE_STORE_NAMES.forEach((storeName) => {
        const metadataRequest = controlStore.get(
          createPersistenceMetadataKey(storeName, DATA_KEY),
        );
        metadataRequest.onerror = () => {
          failure = failure ?? metadataRequest.error;
        };
        metadataRequest.onsuccess = () => {
          currentMetadata.set(storeName, metadataRequest.result);
          commitIfReady();
        };
        const checkpointRequest = controlStore.get(
          createPersistenceCheckpointKey(storeName, DATA_KEY),
        );
        checkpointRequest.onerror = () => {
          failure = failure ?? checkpointRequest.error;
        };
        checkpointRequest.onsuccess = () => {
          currentCheckpoints.set(storeName, checkpointRequest.result);
          commitIfReady();
        };

        if (storeName === STORES.MAP_DATA) {
          const mapEntries: Record<string, unknown> = {};
          const mapCursor = transaction.objectStore(storeName).openCursor();
          mapCursor.onerror = () => {
            failure =
              failure ??
              mapCursor.error ??
              new Error("Failed to enumerate mapData during atomic restore.");
          };
          mapCursor.onsuccess = () => {
            const cursor = mapCursor.result;
            if (cursor) {
              mapEntries[String(cursor.key)] = cursor.value;
              cursor.continue();
              return;
            }
            currentMapEntries = mapEntries;
            commitIfReady();
          };
        } else {
          const payloadRequest = transaction
            .objectStore(storeName)
            .get(DATA_KEY);
          payloadRequest.onerror = () => {
            failure = failure ?? payloadRequest.error;
          };
          payloadRequest.onsuccess = () => {
            currentPayloads.set(storeName, payloadRequest.result);
            commitIfReady();
          };
        }
      });
    } catch (error) {
      abortWith(error);
    }
  });

  preparedMetadata.forEach((metadata, storeName) => {
    const checkpoint = preparedCheckpoints.get(storeName);
    if (!checkpoint) {
      throw new Error(`Missing committed restore checkpoint for ${storeName}.`);
    }
    expectedRevisionRoots.set(
      getObservedRootKey(storeName, DATA_KEY),
      storeName === STORES.MAP_DATA
        ? {
            ...metadata,
            missing: Object.keys(stableMapData).length === 0,
          }
        : metadata,
    );
    expectedPersistenceCheckpoints.set(
      getObservedRootKey(storeName, DATA_KEY),
      checkpoint,
    );
  });
  cleanupRuntimeCandidateSnapshots(observation.runtimeCandidates);
}

type RecoveryAdoptionStoreName = Exclude<StoreName, "syncQueue">;

interface RecoveryAdoptionCurrentEvidence {
  payload?: unknown;
  mapEntries?: Record<string, unknown>;
  metadata: unknown;
  checkpoint: unknown;
}

interface RecoveryAdoptionArchive {
  kind: "event-shopping-planner-recovery-adoption-archive";
  schemaVersion: 1;
  decisionId: string;
  storeName: RecoveryAdoptionStoreName;
  key: typeof DATA_KEY;
  createdAt: string;
  candidate: Pick<
    StartupRecoveryCandidate,
    | "id"
    | "source"
    | "role"
    | "storeName"
    | "key"
    | "sourceKey"
    | "targetKey"
    | "revision"
    | "digest"
    | "digestAlgorithm"
    | "digestCanonicalization"
    | "digestCanonicalLength"
    | "migrationConflict"
  >;
  chosenSourceEvidence: {
    sourceKey: string;
    payload: unknown;
    rawValue?: string;
  };
  currentEvidence: RecoveryAdoptionCurrentEvidence;
  observedRuntimeCandidates: {
    storageKey: string;
    rawValue: string;
    candidate: RuntimeFallbackCandidate<unknown>;
  }[];
  committedMetadata: StoredPersistenceMetadata;
  committedCheckpoint: PersistenceCheckpoint;
  legacyMigrationConflictResolution?: LegacyMigrationConflictResolution;
}

export interface RecoveryCandidateAdoptionResult {
  status: "adopted";
  storeName: RecoveryAdoptionStoreName;
  key: typeof DATA_KEY;
  revision: string;
  digest: string;
  archiveKey: string;
}

function isRecoveryAdoptionStoreName(
  value: unknown,
): value is RecoveryAdoptionStoreName {
  return (
    typeof value === "string" &&
    value !== STORES.SYNC_QUEUE &&
    (Object.values(STORES) as string[]).includes(value)
  );
}

function getRecoveryCandidateIdentity(
  candidate: StartupRecoveryCandidate,
): Parameters<typeof createStartupRecoveryCandidateId>[0] {
  return {
    source: candidate.source,
    role: candidate.role,
    storeName: candidate.storeName,
    sourceKey: candidate.sourceKey,
    targetKey: candidate.targetKey,
    revision: candidate.revision,
    digest: candidate.digest,
    digestAlgorithm: candidate.digestAlgorithm,
    digestCanonicalization: candidate.digestCanonicalization,
    digestCanonicalLength: candidate.digestCanonicalLength,
    ...(candidate.migrationConflict
      ? { migrationConflict: candidate.migrationConflict }
      : {}),
  };
}

function assertAdoptableRecoveryCandidate(
  candidate: StartupRecoveryCandidate,
): asserts candidate is StartupRecoveryCandidate & {
  source: "indexedDB" | "runtime-fallback";
  role: "app-payload";
  adoptable: true;
  storeName: RecoveryAdoptionStoreName;
  key: typeof DATA_KEY;
  sourceKey: string;
  targetKey: typeof DATA_KEY;
  digest: string;
  digestAlgorithm: "SHA-256" | "FNV-1A-64";
  digestCanonicalization: "esp-json-v1";
} {
  if (
    candidate.source !== "indexedDB" &&
    candidate.source !== "runtime-fallback"
  ) {
    throw new PersistenceConflictError(
      "Legacy and migration recovery candidates cannot be adopted directly.",
    );
  }
  if (
    candidate.role !== "app-payload" ||
    candidate.adoptable !== true ||
    !isRecoveryAdoptionStoreName(candidate.storeName) ||
    candidate.key !== DATA_KEY ||
    candidate.targetKey !== DATA_KEY ||
    typeof candidate.sourceKey !== "string" ||
    candidate.sourceKey.length === 0
  ) {
    throw new PersistenceConflictError(
      "Only explicitly adoptable application payload candidates are supported.",
    );
  }
  if (
    typeof candidate.digest !== "string" ||
    candidate.digest.length === 0 ||
    (candidate.digestAlgorithm !== "SHA-256" &&
      candidate.digestAlgorithm !== "FNV-1A-64") ||
    candidate.digestCanonicalization !== "esp-json-v1" ||
    (candidate.digestAlgorithm === "FNV-1A-64" &&
      (!Number.isSafeInteger(candidate.digestCanonicalLength) ||
        (candidate.digestCanonicalLength ?? -1) < 0))
  ) {
    throw new PersistenceConflictError(
      "The recovery candidate does not contain a supported payload digest.",
    );
  }
  if (
    candidate.source === "indexedDB" &&
    (candidate.sourceKey !== DATA_KEY || candidate.rawValue !== undefined)
  ) {
    throw new PersistenceConflictError(
      "The IndexedDB recovery candidate does not identify an application payload.",
    );
  }
  if (
    candidate.source === "runtime-fallback" &&
    (typeof candidate.revision !== "string" ||
      candidate.revision.length === 0 ||
      typeof candidate.rawValue !== "string" ||
      candidate.sourceKey !==
        createRuntimeFallbackKey(
          candidate.storeName,
          DATA_KEY,
          candidate.revision,
        ))
  ) {
    throw new PersistenceConflictError(
      "The runtime fallback candidate does not identify an exact source record.",
    );
  }
  if (
    candidate.migrationConflict !== undefined &&
    (!isLegacyMigrationConflictContext(
      candidate.migrationConflict,
      candidate.storeName,
    ) ||
      candidate.digestAlgorithm !== "SHA-256" ||
      typeof candidate.revision !== "string" ||
      candidate.revision.length === 0)
  ) {
    throw new PersistenceConflictError(
      "The legacy migration conflict context is invalid or stale.",
    );
  }
  if (
    candidate.id !==
    createStartupRecoveryCandidateId(getRecoveryCandidateIdentity(candidate))
  ) {
    throw new PersistenceConflictError(
      "The recovery candidate identity was changed after it was observed.",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(candidate, "payload")) {
    throw new PersistenceConflictError(
      "The recovery candidate payload snapshot is missing.",
    );
  }
}

async function recoveryCandidateDigestMatchesPayload(
  candidate: StartupRecoveryCandidate & {
    digest: string;
    digestAlgorithm: "SHA-256" | "FNV-1A-64";
    digestCanonicalization: "esp-json-v1";
  },
  payload: unknown,
): Promise<boolean> {
  try {
    if (candidate.digestAlgorithm === "SHA-256") {
      const digest = await createPersistenceDigest(payload);
      return (
        digest.canonicalization === candidate.digestCanonicalization &&
        digest.value === candidate.digest
      );
    }
    const digest = createSynchronousFingerprint(
      snapshotStartupRecoveryValue(payload),
    );
    return (
      digest.canonicalization === candidate.digestCanonicalization &&
      digest.canonicalLength === candidate.digestCanonicalLength &&
      digest.value === candidate.digest
    );
  } catch {
    return false;
  }
}

function recoveryEvidenceMatches(left: unknown, right: unknown): boolean {
  return fingerprintsEqual(
    snapshotStartupRecoveryValue(left),
    snapshotStartupRecoveryValue(right),
  );
}

function captureRuntimeRawEvidence(
  storeName: RecoveryAdoptionStoreName,
): { storageKey: string; rawValue: string }[] {
  const prefix = createRuntimeFallbackPrefix(storeName, DATA_KEY);
  const evidence: { storageKey: string; rawValue: string }[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith(prefix)) continue;
    const rawValue = localStorage.getItem(storageKey);
    if (rawValue !== null) evidence.push({ storageKey, rawValue });
  }
  return evidence.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey),
  );
}

function assertRuntimeRawEvidenceUnchanged(
  storeName: RecoveryAdoptionStoreName,
  expected: readonly { storageKey: string; rawValue: string }[],
): void {
  if (
    !recoveryEvidenceMatches(captureRuntimeRawEvidence(storeName), expected)
  ) {
    throw new PersistenceConflictError(
      `${storeName} runtime fallback sources changed during recovery adoption.`,
    );
  }
}

function assertRecoveryCandidatePayloadSnapshot(
  candidate: StartupRecoveryCandidate,
  sourcePayload: unknown,
): void {
  if (
    !recoveryEvidenceMatches(
      candidate.payload,
      snapshotStartupRecoveryValue(sourcePayload),
    )
  ) {
    throw new PersistenceConflictError(
      "The recovery candidate payload snapshot was changed after observation.",
    );
  }
}

function normalizeRecoveryAdoptionPayload(
  storeName: RecoveryAdoptionStoreName,
  payload: unknown,
): unknown {
  if (!isPlainRecord(payload)) {
    throw new PersistenceConflictError(
      `${storeName} recovery payload must be a JSON-compatible object.`,
    );
  }
  const stablePayload = structuredClone(payload);
  createSynchronousFingerprint(stablePayload);
  if (storeName !== STORES.MAP_DATA) return stablePayload;

  Object.values(stablePayload).forEach((eventMapData) => {
    if (!isPlainRecord(eventMapData)) {
      throw new PersistenceConflictError(
        "mapData recovery payload contains an invalid event map.",
      );
    }
    Object.values(eventMapData).forEach((dayMapData) => {
      if (!isPlainRecord(dayMapData)) {
        throw new PersistenceConflictError(
          "mapData recovery payload contains an invalid day map.",
        );
      }
    });
  });
  return normalizeMapDataForPersistence(stablePayload as MapDataStore);
}

function createRecoveryAdoptionArchiveKey(): string {
  return `${RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX}${encodeURIComponent(
    createPersistenceRevision(persistenceWriterId),
  )}`;
}

function checkpointBaseForExplicitRecoveryAdoption(
  checkpoint: PersistenceCheckpoint | null,
  runtimeSnapshots: readonly RuntimeCandidateSnapshot<unknown>[],
): PersistenceCheckpoint | null {
  if (!checkpoint) return null;
  const liveCandidatesByRevision = new Map(
    runtimeSnapshots.map(({ candidate }) => [candidate.revision, candidate]),
  );
  const retainedDescriptors = checkpoint.absorbedCandidates.filter(
    (descriptor) => {
      const liveCandidate = liveCandidatesByRevision.get(descriptor.revision);
      return (
        !liveCandidate ||
        checkpointDescriptorMatchesRuntimeCandidate(descriptor, liveCandidate)
      );
    },
  );
  if (retainedDescriptors.length === checkpoint.absorbedCandidates.length) {
    return checkpoint;
  }
  return {
    ...checkpoint,
    absorbedCandidates: retainedDescriptors,
  };
}

async function readRecoveryAdoptionCurrentEvidence(
  storeName: RecoveryAdoptionStoreName,
): Promise<RecoveryAdoptionCurrentEvidence> {
  if (storeName === STORES.MAP_DATA) {
    const snapshot = await readRawMapSnapshotWithRetry();
    return {
      mapEntries: snapshot.entries,
      metadata: snapshot.metadata,
      checkpoint: snapshot.checkpoint,
    };
  }
  const snapshot = await readPersistenceSnapshotWithRetry(storeName, DATA_KEY);
  return {
    payload: snapshot.payload,
    metadata: snapshot.metadata,
    checkpoint: snapshot.checkpoint,
  };
}

function materializeRecoveryAdoptionCurrentPayload(
  storeName: RecoveryAdoptionStoreName,
  evidence: RecoveryAdoptionCurrentEvidence,
): unknown {
  if (storeName === STORES.MAP_DATA) {
    if (!evidence.mapEntries) {
      throw new PersistenceConflictError(
        "mapData recovery evidence is missing its physical records.",
      );
    }
    return materializeMapData(evidence.mapEntries).data;
  }
  return evidence.payload;
}

async function getTrustedRecoveryAdoptionRoot(
  storeName: RecoveryAdoptionStoreName,
  evidence: RecoveryAdoptionCurrentEvidence,
): Promise<{
  root: StoredPersistenceMetadata;
  checkpoint: PersistenceCheckpoint | null;
} | null> {
  if (!isStoredPersistenceMetadata(evidence.metadata, storeName, DATA_KEY)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = materializeRecoveryAdoptionCurrentPayload(storeName, evidence);
    if (
      !(await verifyPersistenceDigest(
        payload,
        evidence.metadata.payloadDigest,
      )) ||
      !fingerprintsEqual(
        createSynchronousFingerprint(payload),
        evidence.metadata.payloadFingerprint,
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  let checkpoint: PersistenceCheckpoint | null = null;
  try {
    checkpoint = validateCheckpointForRoot(
      evidence.checkpoint,
      storeName,
      DATA_KEY,
      evidence.metadata,
    );
  } catch {
    // An invalid checkpoint is archived but is not carried into the new root.
  }
  return { root: evidence.metadata, checkpoint };
}

interface PreparedLegacyMigrationConflictResolution {
  resolutionKey: string;
  resolution: LegacyMigrationConflictResolution;
  expectedResolution: unknown;
  expectedJournal: LegacyMigrationJournal | null;
  nextJournal: LegacyMigrationJournal | null;
  expectedRawValue: string;
}

function assertLegacyMigrationConflictRawUnchanged(
  prepared: PreparedLegacyMigrationConflictResolution,
): void {
  const currentRawValue = localStorage.getItem(prepared.resolution.legacyKey);
  if (currentRawValue !== prepared.expectedRawValue) {
    throw new PersistenceConflictError(
      "The legacy migration source changed during explicit adoption.",
    );
  }
}

async function prepareLegacyMigrationConflictResolution({
  candidate,
  selectedRoot,
  committedMetadata,
  archiveKey,
  createdAt,
}: {
  candidate: StartupRecoveryCandidate & {
    source: "indexedDB" | "runtime-fallback";
    storeName: RecoveryAdoptionStoreName;
    sourceKey: string;
    targetKey: typeof DATA_KEY;
    revision?: string;
    digest: string;
    digestAlgorithm: "SHA-256" | "FNV-1A-64";
    digestCanonicalization: "esp-json-v1";
  };
  selectedRoot: PersistenceCheckpointCommittedRoot;
  committedMetadata: StoredPersistenceMetadata;
  archiveKey: string;
  createdAt: string;
}): Promise<PreparedLegacyMigrationConflictResolution | null> {
  const context = candidate.migrationConflict;
  if (context === undefined) return null;
  if (
    !isLegacyMigrationConflictContext(context, candidate.storeName) ||
    candidate.digestAlgorithm !== "SHA-256" ||
    typeof candidate.revision !== "string" ||
    candidate.revision.length === 0
  ) {
    throw new PersistenceConflictError(
      "The selected migration candidate has invalid conflict evidence.",
    );
  }
  const target = legacyMigrationTargetForConflictContext(
    context,
    candidate.storeName,
  );
  if (!target) {
    throw new PersistenceConflictError(
      "The selected migration candidate does not match a legacy target.",
    );
  }
  const expectedRawValue = localStorage.getItem(context.legacyKey);
  if (
    expectedRawValue === null ||
    !(await verifyPersistenceDigest(
      expectedRawValue,
      context.expectedRawDigest,
    ))
  ) {
    throw new PersistenceConflictError(
      "The legacy migration source changed before explicit adoption.",
    );
  }
  const selectedDigest: PersistenceDigestDescriptor = {
    algorithm: candidate.digestAlgorithm,
    canonicalization: candidate.digestCanonicalization,
    value: candidate.digest,
  };
  const currentJournal = await readInternalControlRecord(
    LEGACY_MIGRATION_JOURNAL_KEY,
  );
  let expectedJournal: LegacyMigrationJournal | null = null;
  let nextJournal: LegacyMigrationJournal | null = null;
  if (currentJournal !== undefined && currentJournal !== null) {
    if (!isLegacyMigrationJournal(currentJournal)) {
      throw new PersistenceConflictError(
        "An invalid migration journal appeared before explicit adoption.",
      );
    }
    expectedJournal = currentJournal;
    const matchingEntry = currentJournal.entries.find(
      ({ legacyKey }) => legacyKey === target.legacyKey,
    );
    if (matchingEntry) {
      const journalSourceMatches =
        matchingEntry.storeName === target.storeName &&
        matchingEntry.rawValue === expectedRawValue &&
        fingerprintsEqual(
          matchingEntry.expectedRawDigest,
          context.expectedRawDigest,
        );
      if (
        !journalSourceMatches ||
        (currentJournal.phase === "prepared" &&
          matchingEntry.cleanupStatus !== "pending")
      ) {
        throw new PersistenceConflictError(
          "The migration journal does not match the selected conflict.",
        );
      }
      const remainingEntries = currentJournal.entries.filter(
        ({ legacyKey }) => legacyKey !== target.legacyKey,
      );
      nextJournal =
        remainingEntries.length === 0
          ? null
          : {
              ...currentJournal,
              updatedAt: createdAt,
              entries: remainingEntries,
            };
    } else {
      nextJournal = currentJournal;
    }
  }
  const resolutionKey = createLegacyMigrationConflictResolutionKey(
    target.legacyKey,
  );
  const expectedResolution = await readInternalControlRecord(resolutionKey);
  if (
    !fingerprintsEqual(selectedDigest, selectedRoot.digest) ||
    selectedRoot.revision !== candidate.revision
  ) {
    throw new PersistenceConflictError(
      "The selected migration candidate no longer matches its root.",
    );
  }
  const decisionId = archiveKey.slice(
    RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX.length,
  );
  const resolution: LegacyMigrationConflictResolution = {
    kind: "event-shopping-planner-legacy-migration-conflict-resolution",
    schemaVersion: LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION,
    decision: "retain-explicitly-adopted-root",
    decisionId,
    legacyKey: target.legacyKey,
    storeName: target.storeName,
    targetKey: DATA_KEY,
    expectedLegacyRawDigest: context.expectedRawDigest,
    selectedCandidate: {
      id: candidate.id,
      source: candidate.source,
      sourceKey: candidate.sourceKey,
      revision: candidate.revision,
      digest: selectedDigest,
    },
    selectedRoot,
    committedRoot: committedRootFromMetadata(committedMetadata),
    adoptionArchiveKey: archiveKey,
    createdAt,
  };
  if (!isLegacyMigrationConflictResolution(resolution, target)) {
    throw new PersistenceConflictError(
      "The migration conflict resolution could not be constructed safely.",
    );
  }
  return {
    resolutionKey,
    resolution,
    expectedResolution,
    expectedJournal,
    nextJournal,
    expectedRawValue,
  };
}

async function commitRecoveryCandidateAdoption({
  storeName,
  payload,
  expectedEvidence,
  expectedRuntimeEvidence,
  metadata,
  checkpoint,
  archiveKey,
  archive,
  preparedResolution,
}: {
  storeName: RecoveryAdoptionStoreName;
  payload: unknown;
  expectedEvidence: RecoveryAdoptionCurrentEvidence;
  expectedRuntimeEvidence: readonly {
    storageKey: string;
    rawValue: string;
  }[];
  metadata: StoredPersistenceMetadata;
  checkpoint: PersistenceCheckpoint;
  archiveKey: string;
  archive: RecoveryAdoptionArchive;
  preparedResolution: PreparedLegacyMigrationConflictResolution | null;
}): Promise<void> {
  const database = await openDB();
  ensureStoreExists(database, storeName);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const mapPuts =
    storeName === STORES.MAP_DATA
      ? buildMapDataPuts(payload as MapDataStore)
      : [];

  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        [storeName, STORES.SYNC_QUEUE],
        "readwrite",
      );
    } catch (error) {
      reject(error);
      return;
    }

    let failure: unknown = null;
    let remainingReads = 3 + (preparedResolution ? 2 : 0);
    let writesQueued = false;
    let currentPayload: unknown;
    let currentMapEntries: Record<string, unknown> | undefined;
    let currentMetadata: unknown;
    let currentCheckpoint: unknown;
    let currentResolution: unknown;
    let currentJournal: unknown;
    const payloadStore = transaction.objectStore(storeName);
    const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);

    const abortWith = (error: unknown): void => {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    };
    const trackWrite = (request: IDBRequest): void => {
      request.onerror = () => {
        failure =
          failure ??
          request.error ??
          new Error("Recovery adoption write request failed.");
      };
    };
    const commitIfReady = (): void => {
      remainingReads -= 1;
      if (remainingReads !== 0 || writesQueued) return;
      writesQueued = true;
      try {
        const observedEvidence: RecoveryAdoptionCurrentEvidence =
          storeName === STORES.MAP_DATA
            ? {
                mapEntries: currentMapEntries,
                metadata: currentMetadata,
                checkpoint: currentCheckpoint,
              }
            : {
                payload: currentPayload,
                metadata: currentMetadata,
                checkpoint: currentCheckpoint,
              };
        if (!recoveryEvidenceMatches(observedEvidence, expectedEvidence)) {
          throw new PersistenceConflictError(
            `${storeName} changed after the recovery candidate was observed.`,
          );
        }
        assertRuntimeRawEvidenceUnchanged(storeName, expectedRuntimeEvidence);
        if (preparedResolution) {
          assertLegacyMigrationConflictRawUnchanged(preparedResolution);
          if (
            !recoveryEvidenceMatches(
              currentResolution,
              preparedResolution.expectedResolution,
            )
          ) {
            throw new PersistenceConflictError(
              "The migration resolution changed before explicit adoption.",
            );
          }
          if (
            !recoveryEvidenceMatches(
              currentJournal ?? null,
              preparedResolution.expectedJournal,
            )
          ) {
            throw new PersistenceConflictError(
              "The migration journal changed before explicit adoption.",
            );
          }
        }

        if (storeName === STORES.MAP_DATA) {
          if (!currentMapEntries) {
            throw new PersistenceConflictError(
              "mapData physical recovery evidence is unavailable.",
            );
          }
          Object.keys(currentMapEntries)
            .filter(
              (storageKey) =>
                storageKey === MAP_DATA_LEGACY_KEY ||
                parseMapDataEntryKey(storageKey) !== null,
            )
            .forEach((storageKey) => {
              trackWrite(payloadStore.delete(storageKey));
            });
          mapPuts.forEach(({ key, value }) => {
            trackWrite(payloadStore.put(value, key));
          });
        } else {
          trackWrite(payloadStore.put(payload, DATA_KEY));
        }
        trackWrite(
          controlStore.put(
            metadata,
            createPersistenceMetadataKey(storeName, DATA_KEY),
          ),
        );
        trackWrite(
          controlStore.put(
            checkpoint,
            createPersistenceCheckpointKey(storeName, DATA_KEY),
          ),
        );
        trackWrite(controlStore.add(archive, archiveKey));
        if (preparedResolution) {
          trackWrite(
            controlStore.put(
              preparedResolution.resolution,
              preparedResolution.resolutionKey,
            ),
          );
          if (
            !recoveryEvidenceMatches(
              preparedResolution.expectedJournal,
              preparedResolution.nextJournal,
            )
          ) {
            trackWrite(
              preparedResolution.nextJournal === null
                ? controlStore.delete(LEGACY_MIGRATION_JOURNAL_KEY)
                : controlStore.put(
                    preparedResolution.nextJournal,
                    LEGACY_MIGRATION_JOURNAL_KEY,
                  ),
            );
          }
        }
      } catch (error) {
        abortWith(error);
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      failure = failure ?? transaction.error;
    };
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Recovery adoption transaction was aborted."),
      );

    const metadataRequest = controlStore.get(
      createPersistenceMetadataKey(storeName, DATA_KEY),
    );
    metadataRequest.onerror = () => {
      failure =
        failure ??
        metadataRequest.error ??
        new Error("Failed to read recovery metadata CAS evidence.");
    };
    metadataRequest.onsuccess = () => {
      currentMetadata = metadataRequest.result;
      commitIfReady();
    };

    const checkpointRequest = controlStore.get(
      createPersistenceCheckpointKey(storeName, DATA_KEY),
    );
    checkpointRequest.onerror = () => {
      failure =
        failure ??
        checkpointRequest.error ??
        new Error("Failed to read recovery checkpoint CAS evidence.");
    };
    checkpointRequest.onsuccess = () => {
      currentCheckpoint = checkpointRequest.result;
      commitIfReady();
    };

    if (preparedResolution) {
      const resolutionRequest = controlStore.get(
        preparedResolution.resolutionKey,
      );
      resolutionRequest.onerror = () => {
        failure =
          failure ??
          resolutionRequest.error ??
          new Error("Failed to read the migration resolution CAS evidence.");
      };
      resolutionRequest.onsuccess = () => {
        currentResolution = resolutionRequest.result;
        commitIfReady();
      };
      const journalRequest = controlStore.get(LEGACY_MIGRATION_JOURNAL_KEY);
      journalRequest.onerror = () => {
        failure =
          failure ??
          journalRequest.error ??
          new Error("Failed to read the migration journal CAS evidence.");
      };
      journalRequest.onsuccess = () => {
        currentJournal = journalRequest.result;
        commitIfReady();
      };
    }

    if (storeName === STORES.MAP_DATA) {
      const entries: Record<string, unknown> = {};
      const cursorRequest = payloadStore.openCursor();
      cursorRequest.onerror = () => {
        failure =
          failure ??
          cursorRequest.error ??
          new Error("Failed to enumerate mapData recovery CAS evidence.");
      };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          entries[String(cursor.key)] = cursor.value;
          cursor.continue();
          return;
        }
        currentMapEntries = entries;
        commitIfReady();
      };
    } else {
      const payloadRequest = payloadStore.get(DATA_KEY);
      payloadRequest.onerror = () => {
        failure =
          failure ??
          payloadRequest.error ??
          new Error("Failed to read recovery payload CAS evidence.");
      };
      payloadRequest.onsuccess = () => {
        currentPayload = payloadRequest.result;
        commitIfReady();
      };
    }
  });
}

async function verifyRecoveryCandidateAdoption({
  storeName,
  payload,
  metadata,
  checkpoint,
  archiveKey,
  archive,
  expectedRuntimeEvidence,
  preparedResolution,
}: {
  storeName: RecoveryAdoptionStoreName;
  payload: unknown;
  metadata: StoredPersistenceMetadata;
  checkpoint: PersistenceCheckpoint;
  archiveKey: string;
  archive: RecoveryAdoptionArchive;
  expectedRuntimeEvidence: readonly {
    storageKey: string;
    rawValue: string;
  }[];
  preparedResolution: PreparedLegacyMigrationConflictResolution | null;
}): Promise<void> {
  const readback = await readRecoveryAdoptionCurrentEvidence(storeName);
  const readbackPayload = materializeRecoveryAdoptionCurrentPayload(
    storeName,
    readback,
  );
  if (
    !recoveryEvidenceMatches(readbackPayload, payload) ||
    !(await verifyPersistenceDigest(readbackPayload, metadata.payloadDigest)) ||
    !isStoredPersistenceMetadata(readback.metadata, storeName, DATA_KEY) ||
    !immutableObservedRootFieldsMatch(readback.metadata, metadata) ||
    !fingerprintsEqual(
      readback.metadata.payloadFingerprint,
      metadata.payloadFingerprint,
    )
  ) {
    throw new PersistenceConflictError(
      `${storeName} recovery adoption direct readback failed.`,
    );
  }
  let verifiedCheckpoint: PersistenceCheckpoint | null;
  try {
    verifiedCheckpoint = validateCheckpointForRoot(
      readback.checkpoint,
      storeName,
      DATA_KEY,
      metadata,
    );
  } catch {
    verifiedCheckpoint = null;
  }
  if (
    !verifiedCheckpoint ||
    !recoveryEvidenceMatches(verifiedCheckpoint, checkpoint)
  ) {
    throw new PersistenceConflictError(
      `${storeName} recovery checkpoint direct readback failed.`,
    );
  }
  const archivedReadback = await readInternalControlRecord(archiveKey);
  if (!recoveryEvidenceMatches(archivedReadback, archive)) {
    throw new PersistenceConflictError(
      `${storeName} recovery archive direct readback failed.`,
    );
  }
  assertRuntimeRawEvidenceUnchanged(storeName, expectedRuntimeEvidence);
  if (preparedResolution) {
    assertLegacyMigrationConflictRawUnchanged(preparedResolution);
    const [resolutionReadback, journalReadback] = await Promise.all([
      readInternalControlRecord(preparedResolution.resolutionKey),
      readInternalControlRecord(LEGACY_MIGRATION_JOURNAL_KEY),
    ]);
    if (
      !recoveryEvidenceMatches(
        resolutionReadback,
        preparedResolution.resolution,
      ) ||
      !(await recoveryAdoptionArchiveMatchesLegacyResolution(
        archivedReadback,
        preparedResolution.resolution,
      )) ||
      !recoveryEvidenceMatches(
        journalReadback ?? null,
        preparedResolution.nextJournal,
      )
    ) {
      throw new PersistenceConflictError(
        `${storeName} migration resolution direct readback failed.`,
      );
    }
    if (
      !(await verifyPersistenceDigest(
        preparedResolution.expectedRawValue,
        preparedResolution.resolution.expectedLegacyRawDigest,
      ))
    ) {
      throw new PersistenceConflictError(
        `${storeName} legacy source digest verification failed after adoption.`,
      );
    }
  }
}

async function adoptRecoveryCandidateInternal(
  requestedCandidate: StartupRecoveryCandidate,
): Promise<RecoveryCandidateAdoptionResult> {
  const candidate = structuredClone(requestedCandidate);
  assertAdoptableRecoveryCandidate(candidate);
  const storeName = candidate.storeName;

  const [currentEvidence, candidateScan] = await Promise.all([
    readRecoveryAdoptionCurrentEvidence(storeName),
    readRuntimeCandidateSnapshots<unknown>(storeName, DATA_KEY),
  ]);
  if (candidateScan.status === "conflict") {
    throw (
      candidateScan.result.error ??
      new PersistenceConflictError(
        `${storeName} contains an invalid runtime fallback candidate.`,
      )
    );
  }
  const runtimeSnapshots = candidateScan.snapshots;
  const expectedRuntimeEvidence = runtimeSnapshots
    .map(({ storageKey, rawValue }) => ({ storageKey, rawValue }))
    .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  assertRuntimeRawEvidenceUnchanged(storeName, expectedRuntimeEvidence);

  let sourcePayload: unknown;
  let sourceRawValue: string | undefined;
  let selectedRuntimeSnapshot: RuntimeCandidateSnapshot<unknown> | null = null;
  if (candidate.source === "runtime-fallback") {
    const sourceSnapshot = runtimeSnapshots.find(
      ({ storageKey }) => storageKey === candidate.sourceKey,
    );
    if (
      !sourceSnapshot ||
      sourceSnapshot.rawValue !== candidate.rawValue ||
      sourceSnapshot.candidate.revision !== candidate.revision
    ) {
      throw new PersistenceConflictError(
        "The selected runtime fallback source is stale or missing.",
      );
    }
    const observedCandidate = runtimeSnapshotsToRecoveryCandidates(
      storeName,
      DATA_KEY,
      [sourceSnapshot],
      candidate.migrationConflict,
    )[0];
    if (!observedCandidate || observedCandidate.id !== candidate.id) {
      throw new PersistenceConflictError(
        "The selected runtime fallback descriptor no longer matches its source.",
      );
    }
    selectedRuntimeSnapshot = sourceSnapshot;
    sourcePayload = sourceSnapshot.candidate.payload;
    sourceRawValue = sourceSnapshot.rawValue;
  } else {
    sourcePayload = materializeRecoveryAdoptionCurrentPayload(
      storeName,
      currentEvidence,
    );
    const currentRevision = isStoredPersistenceMetadata(
      currentEvidence.metadata,
      storeName,
      DATA_KEY,
    )
      ? currentEvidence.metadata.revision
      : undefined;
    if (candidate.revision !== currentRevision) {
      throw new PersistenceConflictError(
        "The selected IndexedDB candidate revision is stale.",
      );
    }
  }

  if (
    !(await recoveryCandidateDigestMatchesPayload(candidate, sourcePayload))
  ) {
    throw new PersistenceConflictError(
      "The selected recovery candidate digest does not match its live source.",
    );
  }
  assertRecoveryCandidatePayloadSnapshot(candidate, sourcePayload);
  const payload = normalizeRecoveryAdoptionPayload(storeName, sourcePayload);
  const trustedCurrent = await getTrustedRecoveryAdoptionRoot(
    storeName,
    currentEvidence,
  );
  const selectedRoot =
    candidate.source === "indexedDB"
      ? trustedCurrent && trustedCurrent.root.revision === candidate.revision
        ? committedRootFromMetadata(trustedCurrent.root)
        : null
      : selectedRuntimeSnapshot
        ? {
            revision: selectedRuntimeSnapshot.candidate.revision,
            baseRevision: selectedRuntimeSnapshot.candidate.baseRevision,
            digest: selectedRuntimeSnapshot.candidate.digest,
            writerId: selectedRuntimeSnapshot.candidate.writerId,
            committedAt: selectedRuntimeSnapshot.candidate.createdAt,
          }
        : null;
  if (candidate.migrationConflict && !selectedRoot) {
    throw new PersistenceConflictError(
      "The selected recovery root is no longer available.",
    );
  }
  const baseRevision =
    candidate.source === "runtime-fallback"
      ? (candidate.revision ?? null)
      : (trustedCurrent?.root.revision ?? null);
  const metadata = await prepareMetadataForPayload(
    storeName,
    DATA_KEY,
    payload,
    baseRevision,
  );
  const checkpoint = createNextPersistenceCheckpoint(
    storeName,
    DATA_KEY,
    metadata,
    checkpointBaseForExplicitRecoveryAdoption(
      trustedCurrent?.checkpoint ?? null,
      runtimeSnapshots,
    ),
    runtimeSnapshots,
  );
  const archiveKey = createRecoveryAdoptionArchiveKey();
  const createdAt = new Date().toISOString();
  const preparedResolution = selectedRoot
    ? await prepareLegacyMigrationConflictResolution({
        candidate,
        selectedRoot,
        committedMetadata: metadata,
        archiveKey,
        createdAt,
      })
    : null;
  const archive: RecoveryAdoptionArchive = {
    kind: "event-shopping-planner-recovery-adoption-archive",
    schemaVersion: 1,
    decisionId: archiveKey.slice(RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX.length),
    storeName,
    key: DATA_KEY,
    createdAt,
    candidate: {
      id: candidate.id,
      source: candidate.source,
      role: candidate.role,
      storeName: candidate.storeName,
      key: candidate.key,
      sourceKey: candidate.sourceKey,
      targetKey: candidate.targetKey,
      revision: candidate.revision,
      digest: candidate.digest,
      digestAlgorithm: candidate.digestAlgorithm,
      digestCanonicalization: candidate.digestCanonicalization,
      digestCanonicalLength: candidate.digestCanonicalLength,
      ...(candidate.migrationConflict
        ? { migrationConflict: candidate.migrationConflict }
        : {}),
    },
    chosenSourceEvidence: {
      sourceKey: candidate.sourceKey,
      payload: sourcePayload,
      ...(sourceRawValue === undefined ? {} : { rawValue: sourceRawValue }),
    },
    currentEvidence,
    observedRuntimeCandidates: runtimeSnapshots,
    committedMetadata: metadata,
    committedCheckpoint: checkpoint,
    ...(preparedResolution
      ? {
          legacyMigrationConflictResolution: preparedResolution.resolution,
        }
      : {}),
  };
  assertStructuredCloneable(archive);
  retainRuntimeCandidatesForRecoveryAdoption(runtimeSnapshots);
  assertRuntimeRawEvidenceUnchanged(storeName, expectedRuntimeEvidence);

  await commitRecoveryCandidateAdoption({
    storeName,
    payload,
    expectedEvidence: currentEvidence,
    expectedRuntimeEvidence,
    metadata,
    checkpoint,
    archiveKey,
    archive,
    preparedResolution,
  });
  await verifyRecoveryCandidateAdoption({
    storeName,
    payload,
    metadata,
    checkpoint,
    archiveKey,
    archive,
    expectedRuntimeEvidence,
    preparedResolution,
  });
  if (
    runtimeSnapshots.some(
      (snapshot) => !runtimeCandidateIsRetainedForRecoveryAdoption(snapshot),
    )
  ) {
    throw new PersistenceConflictError(
      `${storeName} recovery source retention verification failed.`,
    );
  }

  const observedKey = getObservedRootKey(storeName, DATA_KEY);
  expectedRevisionRoots.set(
    observedKey,
    storeName === STORES.MAP_DATA
      ? {
          ...metadata,
          missing: Object.keys(payload as MapDataStore).length === 0,
        }
      : metadata,
  );
  expectedPersistenceCheckpoints.set(observedKey, checkpoint);
  return {
    status: "adopted",
    storeName,
    key: DATA_KEY,
    revision: metadata.revision,
    digest: metadata.payloadDigest.value,
    archiveKey,
  };
}

const resolveLoadResultData = <T extends Record<string, unknown>>(
  storeName: StoreName,
  result: LoadResult<T>,
): T => {
  if (result.status === "ok" && result.data) {
    return result.data;
  }

  if (result.status === "error" || result.status === "conflict") {
    console.error(`Failed to load ${storeName}.`);
    throw (
      result.error ??
      new PersistenceConflictError(`Failed to resolve ${storeName}.`)
    );
  }

  return {} as T;
};

const removeEventFromStore = async <T extends Record<string, unknown>>(
  eventName: string,
  storeName: StoreName,
  loader: () => Promise<LoadResult<T>>,
  saver: (data: T) => Promise<void>,
): Promise<void> => {
  const loadResult = await loader();
  if (loadResult.status === "error" || loadResult.status === "conflict") {
    console.error(`Failed to load ${storeName} during event deletion.`);
    throw (
      loadResult.error ??
      new PersistenceConflictError(
        `${storeName} could not be loaded during event deletion.`,
      )
    );
  }
  if (loadResult.status !== "ok" || !loadResult.data) {
    return;
  }

  if (!(eventName in loadResult.data)) {
    return;
  }

  const nextData = { ...loadResult.data };
  delete nextData[eventName];
  await saver(nextData as T);
};

// 公開API
export const db = {
  STORES,

  async adoptRecoveryCandidate(
    candidate: StartupRecoveryCandidate,
  ): Promise<RecoveryCandidateAdoptionResult> {
    return adoptRecoveryCandidateInternal(candidate);
  },

  // イベントリスト
  async saveEventLists(data: Record<string, unknown[]>): Promise<void> {
    await saveData(STORES.EVENT_LISTS, "data", data);
  },
  async loadEventLists(): Promise<LoadResult<Record<string, unknown[]>>> {
    return loadData(STORES.EVENT_LISTS, "data");
  },

  // イベントメタデータ
  async saveEventMetadata(data: Record<string, unknown>): Promise<void> {
    await saveData(STORES.EVENT_METADATA, "data", data);
  },
  async loadEventMetadata(): Promise<LoadResult<Record<string, unknown>>> {
    return loadData(STORES.EVENT_METADATA, "data");
  },

  // 実行モードアイテム
  async saveExecuteModeItems(
    data: Record<string, Record<string, string[]>>,
  ): Promise<void> {
    await saveData(STORES.EXECUTE_MODE_ITEMS, "data", data);
  },
  async loadExecuteModeItems(): Promise<
    LoadResult<Record<string, Record<string, string[]>>>
  > {
    return loadData(STORES.EXECUTE_MODE_ITEMS, "data");
  },

  // 日モード
  async saveDayModes(
    data: Record<string, Record<string, string>>,
  ): Promise<void> {
    await saveData(STORES.DAY_MODES, "data", data);
  },
  async loadDayModes(): Promise<
    LoadResult<Record<string, Record<string, string>>>
  > {
    return loadData(STORES.DAY_MODES, "data");
  },

  // マップデータ
  async saveMapData(data: MapDataStore): Promise<void> {
    await writeMapData(data);
  },
  async saveMapDataChanges(
    _previousData: MapDataStore,
    nextData: MapDataStore,
  ): Promise<void> {
    await writeMapData(nextData);
  },
  async loadMapData(): Promise<LoadResult<MapDataStore>> {
    return recordPersistenceLoadOutcome(await loadMapDataInternal());
  },

  // マップ回転設定
  async saveMapRotationSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.MAP_ROTATION_SETTINGS, "data", data);
  },
  async loadMapRotationSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.MAP_ROTATION_SETTINGS, "data");
  },

  // ルート設定
  async saveRouteSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.ROUTE_SETTINGS, "data", data);
  },
  async loadRouteSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.ROUTE_SETTINGS, "data");
  },

  // ホール定義
  async saveHallDefinitions(
    data: Record<string, Record<string, unknown[]>>,
  ): Promise<void> {
    await saveData(STORES.HALL_DEFINITIONS, "data", data);
  },
  async loadHallDefinitions(): Promise<
    LoadResult<Record<string, Record<string, unknown[]>>>
  > {
    return loadData(STORES.HALL_DEFINITIONS, "data");
  },

  // ホールルート設定
  async saveHallRouteSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.HALL_ROUTE_SETTINGS, "data", data);
  },
  async loadHallRouteSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.HALL_ROUTE_SETTINGS, "data");
  },

  // マップビューポート設定
  async saveMapViewportSettings(
    data: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await saveData(STORES.MAP_VIEWPORT_SETTINGS, "data", data);
  },
  async loadMapViewportSettings(): Promise<
    LoadResult<Record<string, Record<string, unknown>>>
  > {
    return loadData(STORES.MAP_VIEWPORT_SETTINGS, "data");
  },

  // イベント削除時に関連データも削除
  async deleteEventData(eventName: string): Promise<void> {
    try {
      await removeEventFromStore(
        eventName,
        STORES.EVENT_LISTS,
        db.loadEventLists,
        db.saveEventLists,
      );
      await removeEventFromStore(
        eventName,
        STORES.EVENT_METADATA,
        db.loadEventMetadata,
        db.saveEventMetadata,
      );
      await removeEventFromStore(
        eventName,
        STORES.EXECUTE_MODE_ITEMS,
        db.loadExecuteModeItems,
        db.saveExecuteModeItems,
      );
      await removeEventFromStore(
        eventName,
        STORES.DAY_MODES,
        db.loadDayModes,
        db.saveDayModes,
      );
      await removeEventFromStore(
        eventName,
        STORES.MAP_DATA,
        db.loadMapData,
        db.saveMapData,
      );
      await removeEventFromStore(
        eventName,
        STORES.MAP_ROTATION_SETTINGS,
        db.loadMapRotationSettings,
        db.saveMapRotationSettings,
      );
      await removeEventFromStore(
        eventName,
        STORES.ROUTE_SETTINGS,
        db.loadRouteSettings,
        db.saveRouteSettings,
      );
      await removeEventFromStore(
        eventName,
        STORES.HALL_DEFINITIONS,
        db.loadHallDefinitions,
        db.saveHallDefinitions,
      );
      await removeEventFromStore(
        eventName,
        STORES.HALL_ROUTE_SETTINGS,
        db.loadHallRouteSettings,
        db.saveHallRouteSettings,
      );
      await removeEventFromStore(
        eventName,
        STORES.MAP_VIEWPORT_SETTINGS,
        db.loadMapViewportSettings,
        db.saveMapViewportSettings,
      );
    } catch {
      console.error("Failed to delete event data from IndexedDB.");
    }
  },

  // 全データを取得（エクスポート用）
  async getAllAppData(): Promise<AppData> {
    const [
      eventListsResult,
      eventMetadataResult,
      executeModeItemsResult,
      dayModesResult,
      mapDataResult,
      mapRotationSettingsResult,
      routeSettingsResult,
      hallDefinitionsResult,
      hallRouteSettingsResult,
      mapViewportSettingsResult,
    ] = await Promise.all([
      db.loadEventLists(),
      db.loadEventMetadata(),
      db.loadExecuteModeItems(),
      db.loadDayModes(),
      db.loadMapData(),
      db.loadMapRotationSettings(),
      db.loadRouteSettings(),
      db.loadHallDefinitions(),
      db.loadHallRouteSettings(),
      db.loadMapViewportSettings(),
    ]);

    return {
      eventLists: resolveLoadResultData(STORES.EVENT_LISTS, eventListsResult),
      eventMetadata: resolveLoadResultData(
        STORES.EVENT_METADATA,
        eventMetadataResult,
      ),
      executeModeItems: resolveLoadResultData(
        STORES.EXECUTE_MODE_ITEMS,
        executeModeItemsResult,
      ),
      dayModes: resolveLoadResultData(STORES.DAY_MODES, dayModesResult),
      mapData: resolveLoadResultData(STORES.MAP_DATA, mapDataResult),
      mapRotationSettings: resolveLoadResultData(
        STORES.MAP_ROTATION_SETTINGS,
        mapRotationSettingsResult,
      ),
      routeSettings: resolveLoadResultData(
        STORES.ROUTE_SETTINGS,
        routeSettingsResult,
      ),
      hallDefinitions: resolveLoadResultData(
        STORES.HALL_DEFINITIONS,
        hallDefinitionsResult,
      ),
      hallRouteSettings: resolveLoadResultData(
        STORES.HALL_ROUTE_SETTINGS,
        hallRouteSettingsResult,
      ),
      mapViewportSettings: resolveLoadResultData(
        STORES.MAP_VIEWPORT_SETTINGS,
        mapViewportSettingsResult,
      ),
    };
  },

  // バックアップから全アプリデータを単一トランザクションで復元
  restoreAppDataAtomically,

  // 同期キュー（共有機能用）
  async saveSyncQueue(data: unknown[]): Promise<void> {
    await saveData(STORES.SYNC_QUEUE, "data", data);
  },
  async loadSyncQueue(): Promise<LoadResult<unknown[]>> {
    return loadData(STORES.SYNC_QUEUE, "data");
  },

  // localStorageからの移行
  migrateFromLocalStorage,

  // Release B: 検証済み旧localStorage原本の条件付き物理cleanup
  cleanupLegacyPersistenceSources,

  // ユーティリティ
  getAllKeys,
  getAllData,
};

export default db;
