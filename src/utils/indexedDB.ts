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
} from "./mapDataPersistence";
import {
  createPersistenceDigest,
  createPersistenceMetadataKey,
  createPersistenceRevision,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  createRuntimeFallbackPrefix,
  createSynchronousFingerprint,
  createStartupRecoveryBundle,
  getPersistenceWriterId,
  isPersistenceDigestDescriptor,
  isPersistenceSynchronousFingerprint,
  parseRuntimeFallbackCandidate,
  reconcileRuntimeFallbackCandidates,
  serializeRuntimeFallbackCandidate,
  snapshotStartupRecoveryValue,
  verifyPersistenceDigest,
  type PersistenceDigestDescriptor,
  type PersistenceSynchronousFingerprint,
  type RuntimeFallbackCandidate,
  type StartupRecoveryBundle,
  type StartupRecoveryCandidate,
  type StartupRecoveryCandidateSource,
  type StartupRecoveryIssue,
} from "./persistenceResilience";

const DB_NAME = "EventShoppingPlannerDB";
const DB_VERSION = 5;
const MAX_FORWARD_COMPATIBLE_DB_VERSION = 7;
const DATA_KEY = "data";
const MAP_DATA_LEGACY_KEY = "data";
const MAP_DATA_KEY_PREFIX = "mapData:";
const INTERNAL_RECORD_PREFIX = "__esp_internal__:";
const LEGACY_MIGRATION_JOURNAL_KEY =
  "__esp_internal__:migration:v1:legacy-local-storage";
const LEGACY_MIGRATION_SCHEMA_VERSION = 1;

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

export type PersistenceMigrationResult =
  | {
      status: "not-needed";
    }
  | {
      status: "completed" | "cleanup-pending";
      migratedKeys: string[];
    }
  | {
      status: "recovery-required";
      recoveryBundle: StartupRecoveryBundle;
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

type LegacyMigrationPhase =
  | "prepared"
  | "copied"
  | "verified"
  | "cleanupPending"
  | "completed";

interface LegacyMigrationJournalEntry {
  legacyKey: string;
  storeName: Exclude<StoreName, "syncQueue">;
  rawValue: string;
  rawDigest: PersistenceDigestDescriptor;
  payloadDigest: PersistenceDigestDescriptor;
  targetRevision: string;
  mapKeys: string[];
  cleanupStatus: "pending" | "retained" | "removed";
}

interface LegacyMigrationJournal {
  kind: "event-shopping-planner-legacy-migration";
  schemaVersion: typeof LEGACY_MIGRATION_SCHEMA_VERSION;
  sessionId: string;
  ownerId: string;
  phase: LegacyMigrationPhase;
  createdAt: string;
  updatedAt: string;
  entries: LegacyMigrationJournalEntry[];
}

class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflict";
  }
}

let dbInstance: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase> | null = null;
const expectedRevisionRoots = new Map<string, ObservedRevisionRoot>();
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

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB."));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onblocked = () => {
      console.warn("IndexedDB open request is blocked by another tab.");
    };

    request.onupgradeneeded = () => {
      if (!allowUpgrade) {
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
      console.error(`Failed to delete from ${storeName}:`, request.error);
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
    console.error("IndexedDB open error:", error);
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
}

interface ValidatedPersistenceSnapshot<T> {
  status: "ok" | "missing";
  data: T | null;
  root: ObservedRevisionRoot;
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

function createRecoveryCandidate(
  source: StartupRecoveryCandidateSource,
  storeName: StoreName,
  key: string,
  revision: string | null,
  payload: unknown,
  rawValue?: string,
): StartupRecoveryCandidate {
  return {
    id: [
      source,
      storeName,
      key,
      revision ?? "no-revision",
      rawValue ?? JSON.stringify(toRecoveryPrimitive(payload)),
    ].join("\u0000"),
    source,
    storeName,
    key,
    ...(revision === null ? {} : { revision }),
    payload: toRecoveryPrimitive(payload),
    ...(rawValue === undefined ? {} : { rawValue }),
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
  const [payload, metadata] = await Promise.all([
    requestResult(payloadRequest),
    requestResult(metadataRequest),
  ]);
  await finished;
  return { payload, metadata };
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
  { validated: ValidatedPersistenceSnapshot<T> } | { conflict: LoadResult<T> }
> {
  const payloadMissing =
    snapshot.payload === undefined || snapshot.payload === null;
  const metadataMissing =
    snapshot.metadata === undefined || snapshot.metadata === null;

  if (payloadMissing && metadataMissing) {
    const root = await createSyntheticRoot(storeName, key, null, true);
    return {
      validated: {
        status: "missing",
        data: null,
        root,
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
            key,
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
    try {
      const root = await createSyntheticRoot(storeName, key, snapshot.payload);
      return {
        validated: {
          status: "ok",
          data: snapshot.payload as T,
          root,
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
            key,
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
            key,
            snapshot.metadata.revision,
            snapshot.metadata,
          ),
        ],
      ),
    };
  }

  return {
    validated: {
      status: "ok",
      data: snapshot.payload as T,
      root: snapshot.metadata,
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
): StartupRecoveryCandidate[] {
  return snapshots.map(({ candidate, rawValue }) =>
    createRecoveryCandidate(
      "runtime-fallback",
      storeName,
      key,
      candidate.revision,
      candidate.payload,
      rawValue,
    ),
  );
}

function cleanupRuntimeCandidateSnapshots(
  snapshots: readonly RuntimeCandidateSnapshot<unknown>[],
): void {
  snapshots.forEach(({ storageKey, rawValue }) => {
    try {
      if (localStorage.getItem(storageKey) === rawValue) {
        localStorage.removeItem(storageKey);
      }
    } catch (error) {
      console.warn(
        `Failed to clean committed runtime fallback ${storageKey}:`,
        error,
      );
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

function isRuntimeFallbackPhysicalPredecessor(
  current: ObservedRevisionRoot,
  runtimeRoot: ObservedRevisionRoot,
): boolean {
  if (!runtimeRoot.runtimeFallback) return false;
  return runtimeRoot.baseRevision === null
    ? Boolean(current.missing)
    : !current.missing && current.revision === runtimeRoot.baseRevision;
}

async function cleanupCommittedRuntimeCandidates(
  storeName: StoreName,
  key: string,
  committed: ObservedRevisionRoot,
): Promise<void> {
  try {
    const candidateScan = await readRuntimeCandidateSnapshots<unknown>(
      storeName,
      key,
    );
    if (candidateScan.status === "conflict") return;
    const reconciliation = reconcileRuntimeFallbackCandidates(
      {
        revision: committed.missing ? null : committed.revision,
        baseRevision: committed.missing ? null : committed.baseRevision,
        digest: committed.missing ? undefined : committed.payloadDigest,
        writerId: committed.missing ? undefined : committed.writerId,
        createdAt: committed.missing ? undefined : committed.committedAt,
      },
      candidateScan.snapshots.map(({ candidate }) => candidate),
    );
    if (reconciliation.status === "conflict" || reconciliation.head) return;
    const staleRevisions = new Set(
      reconciliation.staleCandidates.map(({ revision }) => revision),
    );
    cleanupRuntimeCandidateSnapshots(
      candidateScan.snapshots.filter(({ candidate }) =>
        staleRevisions.has(candidate.revision),
      ),
    );
  } catch (error) {
    console.warn(
      `Failed to inspect committed runtime fallbacks for ${storeName}:${key}:`,
      error,
    );
  }
}

async function writeDataWithMetadataOnce<T>(
  storeName: StoreName,
  key: string,
  data: T,
  expected: ObservedRevisionRoot,
  metadata: StoredPersistenceMetadata,
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
      let currentPayload: unknown;
      let currentMetadata: unknown;
      let payloadLoaded = false;
      let metadataLoaded = false;
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
        if (writesQueued || !payloadLoaded || !metadataLoaded) return;
        writesQueued = true;
        try {
          assertCurrentSnapshotMatchesExpected(
            storeName,
            key,
            currentPayload,
            currentMetadata,
            expected,
          );
          const payloadPut = payloadStore.put(data, key);
          const metadataPut = controlStore.put(metadata, metadataKey);
          payloadPut.onerror = () => {
            failure = failure ?? payloadPut.error;
          };
          metadataPut.onerror = () => {
            failure = failure ?? metadataPut.error;
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
  const [entries, metadata] = await Promise.all([
    entriesPromise,
    metadataPromise,
  ]);
  await finished;
  return { entries, metadata };
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
            ),
            ...(snapshot.metadata === undefined || snapshot.metadata === null
              ? []
              : [
                  createRecoveryCandidate(
                    "indexedDB",
                    STORES.MAP_DATA,
                    DATA_KEY,
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
            DATA_KEY,
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
            DATA_KEY,
            snapshot.metadata.revision,
            snapshot.metadata,
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
  metadata: StoredPersistenceMetadata,
): Promise<void> {
  const database = await openDB();
  ensureStoreExists(database, STORES.MAP_DATA);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const puts = buildMapDataPuts(data);

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
    let metadataLoaded = false;
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
      if (committed || entries === null || !metadataLoaded) return;
      committed = true;
      try {
        const deletes = assertCurrentMapMatchesExpected(
          entries,
          currentMetadata,
          expected,
        );
        deletes.forEach((storageKey) => {
          const request = mapStore.delete(storageKey);
          request.onerror = () => {
            failure = failure ?? request.error;
          };
        });
        puts.forEach(({ key: storageKey, value }) => {
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
  });
}

async function writeMapData(data: MapDataStore): Promise<void> {
  const stableData = structuredClone(data);
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

  const metadata = await prepareMetadataForPayload(
    STORES.MAP_DATA,
    DATA_KEY,
    stableData,
    expected.missing ? null : expected.revision,
  );
  try {
    await writeMapDataWithMetadataOnce(stableData, expected, metadata);
  } catch (firstError) {
    if (isPersistenceConflict(firstError)) throw firstError;
    resetDbInstance();
    await writeMapDataWithMetadataOnce(stableData, expected, metadata);
  }
  expectedRevisionRoots.set(observedKey, {
    ...metadata,
    missing: Object.keys(stableData).length === 0,
  });
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
      if (
        !observedRootsMatch(physicalRoot, logicalExpected) &&
        !isRuntimeFallbackPhysicalPredecessor(physicalRoot, logicalExpected)
      ) {
        throw new PersistenceConflictError(
          `${storeName}:${key} no longer matches the fallback lineage.`,
        );
      }
      writeExpected = physicalRoot;
    } catch (error) {
      if (
        isPersistenceConflict(error) ||
        !canUseRuntimeFallback(storeName, error)
      ) {
        throw error;
      }
    }
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

  const saveOnce = () =>
    writeDataWithMetadataOnce(
      storeName,
      key,
      stableData,
      writeExpected,
      metadata,
    );

  try {
    await saveOnce();
    expectedRevisionRoots.set(observedKey, metadata);
    await cleanupCommittedRuntimeCandidates(storeName, key, metadata);
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
      await cleanupCommittedRuntimeCandidates(storeName, key, metadata);
      return;
    } catch (retryError) {
      if (
        isPersistenceConflict(retryError) ||
        !canUseRuntimeFallback(storeName, retryError)
      ) {
        throw retryError;
      }

      console.warn(
        `Falling back to immutable localStorage candidates for ${storeName}:`,
        retryError ?? firstError,
      );

      let current = logicalExpected;
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
        if (
          !observedRootsMatch(physicalCurrent, logicalExpected) &&
          !isRuntimeFallbackPhysicalPredecessor(
            physicalCurrent,
            logicalExpected,
          )
        ) {
          throw new PersistenceConflictError(
            `${storeName}:${key} changed before the fallback candidate was appended.`,
          );
        }
        current = logicalExpected;
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
      const reconciliation = reconcileRuntimeFallbackCandidates(
        {
          revision: current.missing ? null : current.revision,
          baseRevision: current.missing ? null : current.baseRevision,
          digest: current.missing ? undefined : current.payloadDigest,
          writerId: current.missing ? undefined : current.writerId,
          createdAt: current.missing ? undefined : current.committedAt,
        },
        candidateScan.snapshots.map(({ candidate }) => candidate),
      );
      if (reconciliation.status === "conflict" || reconciliation.head) {
        throw new PersistenceConflictError(
          `${storeName}:${key} has another uncommitted persistence branch.`,
        );
      }
      const staleRevisions = new Set(
        reconciliation.staleCandidates.map(({ revision }) => revision),
      );

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
          `Immutable fallback key already exists: ${storageKey}`,
        );
      }
      localStorage.setItem(storageKey, serialized);
      if (localStorage.getItem(storageKey) !== serialized) {
        const error = new Error(
          `Runtime fallback readback verification failed: ${storageKey}`,
        );
        error.name = "PersistenceFallbackReadbackError";
        throw error;
      }

      expectedRevisionRoots.set(
        observedKey,
        createObservedRootFromRuntimeCandidate(candidate),
      );
      cleanupRuntimeCandidateSnapshots(
        candidateScan.snapshots.filter(({ candidate }) =>
          staleRevisions.has(candidate.revision),
        ),
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
  };

  if (expected) {
    current = {
      revision: expected.missing ? null : expected.revision,
      baseRevision: expected.missing ? null : expected.baseRevision,
      digest: expected.missing ? undefined : expected.payloadDigest,
    };
  } else {
    const revisions = new Set(
      candidateScan.snapshots.map(({ candidate }) => candidate.revision),
    );
    const roots = candidateScan.snapshots.filter(
      ({ candidate }) =>
        candidate.baseRevision === null ||
        !revisions.has(candidate.baseRevision),
    );
    if (roots.length !== 1) {
      return createConflictLoadResult(
        `${storeName} の退避候補に複数の起点があり、安全に選択できません。`,
        storeName,
        runtimeSnapshotsToRecoveryCandidates(
          storeName,
          key,
          candidateScan.snapshots,
        ),
      );
    }
    current = {
      revision: roots[0].candidate.baseRevision,
      baseRevision: null,
    };
  }

  const reconciliation = reconcileRuntimeFallbackCandidates(
    current,
    candidateScan.snapshots.map(({ candidate }) => candidate),
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
    candidateScan.snapshots.find(
      ({ candidate }) => candidate.revision === current.revision,
    )?.candidate ??
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
        current.committedAt === head.createdAt
      ) {
        expectedRevisionRoots.set(observedKey, current);
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
            key,
            revision,
            snapshot.metadata,
          ),
        );
      }
    }
  } catch (readError) {
    console.warn(
      `Failed to re-read ${storeName}:${key} after fallback repair conflict:`,
      readError,
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

async function loadData<T>(
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
    return validation.conflict;
  }

  const observedKey = getObservedRootKey(storeName, key);
  const validated = validation.validated;
  if (storeName === STORES.MAP_DATA) {
    expectedRevisionRoots.set(observedKey, validated.root);
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
    return candidateScan.result;
  }

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
    candidateScan.snapshots.map(({ candidate }) => candidate),
  );
  if (reconciliation.status === "conflict") {
    const candidates: StartupRecoveryCandidate[] = [
      createRecoveryCandidate(
        "indexedDB",
        storeName,
        key,
        validated.root.missing ? null : validated.root.revision,
        validated.data,
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
    const staleRevisions = new Set(
      reconciliation.staleCandidates.map(({ revision }) => revision),
    );
    cleanupRuntimeCandidateSnapshots(
      candidateScan.snapshots.filter(({ candidate }) =>
        staleRevisions.has(candidate.revision),
      ),
    );
    expectedRevisionRoots.set(observedKey, validated.root);
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
  let repairFailure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeDataWithMetadataOnce(
        storeName,
        key,
        head.payload,
        validated.root,
        repairedMetadata,
      );
      repairFailure = null;
      break;
    } catch (error) {
      if (isPersistenceConflict(error)) {
        return resolveFallbackRepairConflict(
          storeName,
          key,
          head,
          candidateScan.snapshots,
          error,
        );
      }
      if (!canUseRuntimeFallback(storeName, error)) {
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
    console.warn(
      `Failed to repair runtime fallback for ${storeName}; using the verified candidate:`,
      repairFailure,
    );
    expectedRevisionRoots.set(
      observedKey,
      createObservedRootFromRuntimeCandidate(head),
    );
    return {
      status: "ok",
      data: head.payload,
    };
  }

  expectedRevisionRoots.set(observedKey, repairedMetadata);
  cleanupRuntimeCandidateSnapshots(candidateScan.snapshots);
  return {
    status: "ok",
    data: head.payload,
  };
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
        console.error(`Failed to get keys from ${storeName}:`, request.error);
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
        console.error(
          `Failed to get all data from ${storeName}:`,
          cursorRequest.error,
        );
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

class LegacyMigrationRuntimeConflictError extends PersistenceConflictError {
  readonly recoveryCandidates: StartupRecoveryCandidate[];

  constructor(message: string, recoveryCandidates: StartupRecoveryCandidate[]) {
    super(message);
    this.recoveryCandidates = recoveryCandidates;
  }
}

function captureLegacySourceStates(): LegacySourceState[] {
  return LEGACY_MIGRATION_TARGETS.map((target) => ({
    target,
    rawValue: localStorage.getItem(target.legacyKey),
  }));
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
        journal.phase === "cleanupPending") &&
      (entry.cleanupStatus === "pending" ||
        entry.cleanupStatus === "retained") &&
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
  mapPuts: { key: string; value: unknown }[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isLegacyMigrationJournal(
  value: unknown,
): value is LegacyMigrationJournal {
  if (!isPlainRecord(value)) return false;
  const entries = value.entries;
  if (!Array.isArray(entries)) return false;
  const entryKeys = new Set<string>();
  const entriesValid = entries.every((entry) => {
    if (!isPlainRecord(entry)) return false;
    const target = LEGACY_MIGRATION_TARGETS.find(
      ({ legacyKey, storeName }) =>
        legacyKey === entry.legacyKey && storeName === entry.storeName,
    );
    if (
      !target ||
      typeof entry.rawValue !== "string" ||
      !isPersistenceDigestDescriptor(entry.rawDigest) ||
      !isPersistenceDigestDescriptor(entry.payloadDigest) ||
      typeof entry.targetRevision !== "string" ||
      entry.targetRevision.length === 0 ||
      !Array.isArray(entry.mapKeys) ||
      entry.mapKeys.some((key) => typeof key !== "string") ||
      !["pending", "retained", "removed"].includes(
        String(entry.cleanupStatus),
      ) ||
      entryKeys.has(target.legacyKey)
    ) {
      return false;
    }
    entryKeys.add(target.legacyKey);
    return true;
  });
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
    value.schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION &&
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
  journal?: LegacyMigrationJournal,
  currentSources?: readonly LegacySourceState[],
  additionalCandidates: readonly StartupRecoveryCandidate[] = [],
): PersistenceMigrationResult {
  const candidates = entries.map(({ target, rawValue }) =>
    createRecoveryCandidate(
      "legacy-localStorage",
      target.storeName,
      DATA_KEY,
      null,
      null,
      rawValue,
    ),
  );
  if (journal) {
    candidates.push(
      createRecoveryCandidate(
        "migration-journal",
        STORES.SYNC_QUEUE,
        LEGACY_MIGRATION_JOURNAL_KEY,
        journal.entries[0]?.targetRevision ?? null,
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
          DATA_KEY,
          null,
          rawValue === null
            ? { sourceState: "missing", snapshot: "current" }
            : { sourceState: "present", snapshot: "current" },
          rawValue ?? undefined,
        ),
      );
    });
  }
  candidates.push(...additionalCandidates);
  return {
    status: "recovery-required",
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
    const payload = parseLegacyMigrationPayload(
      snapshot.target,
      snapshot.rawValue,
    );
    assertStructuredCloneable(payload);
    const rawDigest = await createPersistenceDigest(snapshot.rawValue);
    const payloadDigest = await createPersistenceDigest(payload);
    let validated: ValidatedPersistenceSnapshot<unknown>;

    if (snapshot.target.storeName === STORES.MAP_DATA) {
      const rawMapSnapshot = await readRawMapSnapshotWithRetry();
      const validation = await validateMapSnapshot(rawMapSnapshot);
      if ("conflict" in validation) {
        throw (
          validation.conflict.error ??
          new PersistenceConflictError("Existing mapData is inconsistent.")
        );
      }
      validated = validation.validated;
      const existingMap = validated.data ?? {};
      for (const [eventName, eventMapData] of Object.entries(existingMap)) {
        const targetEventMap = payload[eventName];
        if (!isPlainRecord(targetEventMap)) {
          throw new PersistenceConflictError(
            `Existing mapData event ${eventName} is absent from the legacy source.`,
          );
        }
        for (const [dayMapName, dayMapData] of Object.entries(eventMapData)) {
          if (!(dayMapName in targetEventMap)) {
            throw new PersistenceConflictError(
              `Existing mapData entry ${eventName}/${dayMapName} is absent from the legacy source.`,
            );
          }
          const existingDigest = await createPersistenceDigest(dayMapData);
          const targetDigest = await createPersistenceDigest(
            targetEventMap[dayMapName],
          );
          if (existingDigest.value !== targetDigest.value) {
            throw new PersistenceConflictError(
              `Existing mapData entry ${eventName}/${dayMapName} conflicts with the legacy source.`,
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
        throw (
          validation.conflict.error ??
          new PersistenceConflictError(
            `${snapshot.target.storeName} is inconsistent.`,
          )
        );
      }
      validated = validation.validated;
      const candidateScan = await readRuntimeCandidateSnapshots<
        Record<string, unknown>
      >(snapshot.target.storeName, DATA_KEY);
      if (candidateScan.status === "conflict") {
        throw new LegacyMigrationRuntimeConflictError(
          `${snapshot.target.storeName} has an invalid runtime fallback candidate.`,
          candidateScan.result.recoveryBundle?.candidates ?? [],
        );
      }
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
        candidateScan.snapshots.map(({ candidate }) => candidate),
      );
      if (
        reconciliation.status === "conflict" ||
        reconciliation.head !== null
      ) {
        throw new LegacyMigrationRuntimeConflictError(
          `${snapshot.target.storeName} has an active runtime fallback branch.`,
          runtimeSnapshotsToRecoveryCandidates(
            snapshot.target.storeName,
            DATA_KEY,
            candidateScan.snapshots,
          ),
        );
      }
      if (validated.status === "ok") {
        const existingDigest = await createPersistenceDigest(validated.data);
        if (existingDigest.value !== payloadDigest.value) {
          throw new PersistenceConflictError(
            `${snapshot.target.storeName} conflicts with the legacy source.`,
          );
        }
      }
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
    entries.push({
      target: snapshot.target,
      rawValue: snapshot.rawValue,
      payload,
      rawDigest,
      payloadDigest,
      metadata,
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
  return {
    kind: "event-shopping-planner-legacy-migration",
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    sessionId: createPersistenceRevision(persistenceWriterId),
    ownerId: persistenceWriterId,
    phase: "prepared",
    createdAt: now,
    updatedAt: now,
    entries: entries.map((entry) => ({
      legacyKey: entry.target.legacyKey,
      storeName: entry.target.storeName,
      rawValue: entry.rawValue,
      rawDigest: entry.rawDigest,
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
  return {
    ...journal,
    phase,
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
      let currentMapEntries: Record<string, unknown> | null = null;
      let currentJournal: unknown;
      let remainingReads = entries.length * 2 + 1;
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
            track(
              controlStore.put(
                entry.metadata,
                createPersistenceMetadataKey(entry.target.storeName, DATA_KEY),
              ),
            );
          });
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
): Promise<void> {
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
  }
}

function legacySnapshotsFromJournal(
  journal: LegacyMigrationJournal,
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
  journal: LegacyMigrationJournal,
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
      verifyPersistenceDigest(snapshot.rawValue, journalEntry.rawDigest),
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
      recorded.rawDigest.value !== entry.rawDigest.value ||
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
  });
}

async function cleanupLegacySourcesFromJournal(
  journal: LegacyMigrationJournal,
): Promise<LegacyMigrationJournal> {
  let working = journal;
  assertJournalSourcesResumable(working, captureLegacySourceStates());

  for (const legacyKey of journal.entries.map(({ legacyKey }) => legacyKey)) {
    const entry = working.entries.find(
      (candidate) => candidate.legacyKey === legacyKey,
    );
    if (!entry || entry.cleanupStatus === "removed") continue;

    let current: string | null;
    try {
      current = localStorage.getItem(entry.legacyKey);
    } catch (error) {
      console.warn(
        `Failed to inspect legacy source ${entry.legacyKey} during cleanup:`,
        error,
      );
      continue;
    }
    if (
      current === null &&
      working.phase === "cleanupPending" &&
      entry.cleanupStatus === "pending"
    ) {
      const inferredJournal: LegacyMigrationJournal = {
        ...working,
        updatedAt: new Date().toISOString(),
        entries: working.entries.map((candidate) =>
          candidate.legacyKey === entry.legacyKey
            ? { ...candidate, cleanupStatus: "removed" as const }
            : candidate,
        ),
      };
      await writeMigrationJournalWithCas(working, inferredJournal);
      working = inferredJournal;
      continue;
    }
    if (
      current === null &&
      working.phase === "cleanupPending" &&
      entry.cleanupStatus === "retained"
    ) {
      continue;
    }
    if (current !== entry.rawValue) {
      throw new LegacySourceChangedError(
        `Legacy source ${entry.legacyKey} changed before cleanup.`,
        captureLegacySourceStates(),
      );
    }

    let removed = false;
    try {
      localStorage.removeItem(entry.legacyKey);
      removed = localStorage.getItem(entry.legacyKey) === null;
    } catch (error) {
      console.warn(
        `Failed to remove legacy source ${entry.legacyKey}; cleanup remains pending:`,
        error,
      );
    }
    if (!removed) continue;

    const nextJournal: LegacyMigrationJournal = {
      ...working,
      updatedAt: new Date().toISOString(),
      entries: working.entries.map((candidate) =>
        candidate.legacyKey === entry.legacyKey
          ? { ...candidate, cleanupStatus: "removed" as const }
          : candidate,
      ),
    };
    await writeMigrationJournalWithCas(working, nextJournal);
    working = nextJournal;
  }

  let finalSources: LegacySourceState[];
  try {
    finalSources = captureLegacySourceStates();
    assertJournalSourcesResumable(working, finalSources);
  } catch (error) {
    if (error instanceof LegacySourceChangedError) throw error;
    console.warn(
      "Failed to verify legacy cleanup; cleanup remains pending:",
      error,
    );
    return working;
  }

  if (
    working.entries.every(({ cleanupStatus }) => cleanupStatus === "removed")
  ) {
    const completedJournal: LegacyMigrationJournal = {
      ...working,
      phase: "completed",
      updatedAt: new Date().toISOString(),
    };
    await writeMigrationJournalWithCas(working, completedJournal);
    working = completedJournal;
  }
  return working;
}

async function migrateFromLocalStorage(
  options: {
    cleanupLegacySources?: boolean;
  } = {},
): Promise<PersistenceMigrationResult> {
  let capturedSources: LegacySourceState[];
  try {
    capturedSources = captureLegacySourceStates();
  } catch (error) {
    return migrationRecoveryResult(
      "旧データのスナップショットを取得できませんでした。",
      error,
      [],
    );
  }
  let snapshots = presentLegacySourceSnapshots(capturedSources);
  let existingJournal: LegacyMigrationJournal | null = null;
  try {
    const rawJournal = await readInternalControlRecord(
      LEGACY_MIGRATION_JOURNAL_KEY,
    );
    if (rawJournal !== undefined && rawJournal !== null) {
      if (!isLegacyMigrationJournal(rawJournal)) {
        return migrationRecoveryResult(
          "移行ジャーナルの形式が不正です。",
          new PersistenceConflictError("Invalid migration journal."),
          snapshots,
        );
      }
      existingJournal = rawJournal;
      snapshots = legacySnapshotsFromJournal(rawJournal);
      await validateLegacyMigrationJournalDescriptors(rawJournal);
      try {
        assertJournalSourcesResumable(rawJournal, capturedSources);
      } catch (error) {
        return migrationRecoveryResult(
          "移行待ちの原本が前回のスナップショットから変更されています。",
          error,
          snapshots,
          rawJournal,
          error instanceof LegacySourceChangedError
            ? error.currentSources
            : capturedSources,
        );
      }

      if (
        rawJournal.phase === "completed" ||
        rawJournal.phase === "cleanupPending"
      ) {
        let terminalJournal = rawJournal;
        try {
          await verifyCommittedMigrationTargets(terminalJournal);
          if (
            terminalJournal.phase === "cleanupPending" &&
            terminalJournal.entries.some(
              ({ cleanupStatus }) => cleanupStatus === "pending",
            )
          ) {
            terminalJournal =
              await cleanupLegacySourcesFromJournal(terminalJournal);
          }
        } catch (error) {
          return migrationRecoveryResult(
            "移行済みデータのcommitted rootが欠損または不整合です。",
            error,
            snapshots,
            terminalJournal,
            error instanceof LegacySourceChangedError
              ? error.currentSources
              : undefined,
          );
        }
        if (
          terminalJournal.phase === "completed" ||
          !options.cleanupLegacySources
        ) {
          return {
            status:
              terminalJournal.phase === "completed"
                ? "completed"
                : "cleanup-pending",
            migratedKeys: terminalJournal.entries.map(
              ({ legacyKey }) => legacyKey,
            ),
          };
        }
        try {
          const cleanedJournal =
            await cleanupLegacySourcesFromJournal(terminalJournal);
          return {
            status:
              cleanedJournal.phase === "completed"
                ? "completed"
                : "cleanup-pending",
            migratedKeys: cleanedJournal.entries.map(
              ({ legacyKey }) => legacyKey,
            ),
          };
        } catch (error) {
          return migrationRecoveryResult(
            "旧データの安全な削除を完了できませんでした。",
            error,
            snapshots,
            terminalJournal,
            error instanceof LegacySourceChangedError
              ? error.currentSources
              : undefined,
          );
        }
      }
    }
  } catch (error) {
    return migrationRecoveryResult(
      "移行ジャーナルの所有権または原本を確認できませんでした。",
      error,
      snapshots,
      existingJournal ?? undefined,
    );
  }
  if (!existingJournal && snapshots.length === 0) {
    return { status: "not-needed" };
  }

  let prepared: Awaited<ReturnType<typeof prepareLegacyMigrationEntries>>;
  try {
    prepared = await prepareLegacyMigrationEntries(snapshots);
  } catch (error) {
    return migrationRecoveryResult(
      "旧データの解析・検証、または既存IndexedDBとの比較に失敗しました。",
      error,
      snapshots,
      undefined,
      undefined,
      error instanceof LegacyMigrationRuntimeConflictError
        ? error.recoveryCandidates
        : [],
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

    const capturedForCopy = capturedSources;
    if (journal.phase === "prepared") {
      assertLegacySourcesUnchanged(capturedForCopy);
      journal = await copyLegacyMigrationAtomically(
        prepared.entries,
        journal,
        prepared.roots,
      );
    }
    await verifyLegacyMigration(prepared.entries, journal);
    assertLegacySourcesUnchanged(capturedForCopy);
    if (journal.phase !== "verified") {
      const verifiedJournal = withJournalPhase(journal, "verified");
      await writeMigrationJournalWithCas(journal, verifiedJournal);
      journal = verifiedJournal;
    }
    assertLegacySourcesUnchanged(capturedForCopy);

    if (options.cleanupLegacySources) {
      const cleanupPendingJournal = withJournalPhase(journal, "cleanupPending");
      await writeMigrationJournalWithCas(journal, cleanupPendingJournal);
      journal = cleanupPendingJournal;
      assertLegacySourcesUnchanged(capturedForCopy);
      const cleanedJournal = await cleanupLegacySourcesFromJournal(journal);
      return {
        status:
          cleanedJournal.phase === "completed"
            ? "completed"
            : "cleanup-pending",
        migratedKeys: cleanedJournal.entries.map(({ legacyKey }) => legacyKey),
      };
    }

    const cleanupPendingJournal = withJournalPhase(
      journal,
      "cleanupPending",
      "retained",
    );
    await writeMigrationJournalWithCas(journal, cleanupPendingJournal);
    journal = cleanupPendingJournal;
    assertLegacySourcesUnchanged(capturedForCopy);
    prepared.entries.forEach((entry) => {
      expectedRevisionRoots.set(
        getObservedRootKey(entry.target.storeName, DATA_KEY),
        entry.metadata,
      );
    });
    return {
      status: "cleanup-pending",
      migratedKeys: journal.entries.map(({ legacyKey }) => legacyKey),
    };
  } catch (error) {
    return migrationRecoveryResult(
      "旧データの一括コピーまたは読戻し検証に失敗しました。",
      error,
      snapshots,
      journal,
      error instanceof LegacySourceChangedError
        ? error.currentSources
        : undefined,
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
  runtimeCandidates: RuntimeCandidateSnapshot<unknown>[];
}

async function observeAppDataRestoreState(): Promise<AppDataRestoreObservation> {
  const roots = new Map<StoreName, ObservedRevisionRoot>();
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
      roots.set(storeName, validation.validated.root);
      runtimeCandidates.push(...candidateScan.snapshots);
    }),
  );

  return { roots, runtimeCandidates };
}

async function restoreAppDataAtomically(data: AppData): Promise<void> {
  const stableData = structuredClone(data);
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
    [STORES.MAP_DATA, stableData.mapData],
    [STORES.MAP_ROTATION_SETTINGS, stableData.mapRotationSettings],
    [STORES.ROUTE_SETTINGS, stableData.routeSettings],
    [STORES.HALL_DEFINITIONS, stableData.hallDefinitions],
    [STORES.HALL_ROUTE_SETTINGS, stableData.hallRouteSettings],
    [STORES.MAP_VIEWPORT_SETTINGS, stableData.mapViewportSettings],
  ]);
  const preparedMetadata = new Map<StoreName, StoredPersistenceMetadata>();
  await Promise.all(
    APP_DATA_RESTORE_STORE_NAMES.map(async (storeName) => {
      const observed = observation.roots.get(storeName);
      if (!observed) {
        throw new Error(`Missing restore observation for ${storeName}.`);
      }
      preparedMetadata.set(
        storeName,
        await prepareMetadataForPayload(
          storeName,
          DATA_KEY,
          restorePayloads.get(storeName),
          observed.missing ? null : observed.revision,
        ),
      );
    }),
  );
  const mapPuts = buildMapDataPuts(stableData.mapData as MapDataStore);

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
    let currentMapEntries: Record<string, unknown> | null = null;
    let remainingReads = APP_DATA_RESTORE_STORE_NAMES.length * 2;
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
          if (!observed || !metadata) {
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

          trackRequest(
            controlStore.put(
              metadata,
              createPersistenceMetadataKey(storeName, DATA_KEY),
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
    expectedRevisionRoots.set(
      getObservedRootKey(storeName, DATA_KEY),
      storeName === STORES.MAP_DATA
        ? {
            ...metadata,
            missing: Object.keys(stableData.mapData).length === 0,
          }
        : metadata,
    );
  });
  cleanupRuntimeCandidateSnapshots(observation.runtimeCandidates);
}

const resolveLoadResultData = <T extends Record<string, unknown>>(
  storeName: StoreName,
  result: LoadResult<T>,
): T => {
  if (result.status === "ok" && result.data) {
    return result.data;
  }

  if (result.status === "error" || result.status === "conflict") {
    console.error(`Failed to load ${storeName}:`, result.error);
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
    console.error(
      `Failed to load ${storeName} during event deletion:`,
      loadResult.error,
    );
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
    return loadMapDataInternal();
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
    } catch (error) {
      console.error(`Failed to delete ${eventName} from IndexedDB:`, error);
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

  // ユーティリティ
  getAllKeys,
  getAllData,
};

export default db;
