/**
 * IndexedDB persistence engine.
 *
 * Owns optimistic roots, fallback reconciliation, and record-level read/write
 * semantics. Migration, restore, and explicit recovery orchestration depend on
 * this lower-level engine and never feed dependencies back into it.
 */

import type { MapDataStore } from "../../types/map";
import {
  InvalidMapPayloadError,
  normalizeMapDataForPersistence,
} from "../../utils/mapDataPersistence";
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
} from "../../utils/persistenceResilience";
import type {
  AutomaticPersistenceCleanupRequest,
  ManualPersistenceCleanupRequest,
  PersistenceCleanupBlockedReason,
  PersistenceCleanupDeferredReason,
  PersistenceCleanupMode,
  PersistenceCleanupPhysicalBlockedReason,
  PersistenceCleanupPhysicalDeferredReason,
} from "../../utils/persistenceCleanupCoordinator";
import { recordPersistenceReleaseAMetric } from "../../utils/persistenceReleaseAMetrics";
import {
  DATA_KEY,
  LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX,
  LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION,
  LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  LEGACY_MIGRATION_SCHEMA_VERSION,
  RECOVERY_ADOPTION_RETENTION_KEY_PREFIX,
  STORES,
  type StoreName,
} from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import {
  ensureStoreExists,
  openDatabase as openDB,
  resetDatabaseConnection as resetDbInstance,
} from "../db/openDatabase";
import {
  openCoordinatedTransaction,
  requestResult,
  transactionFinished,
} from "../db/transactionCoordinator";
import { isPlainRecord } from "./valueValidation";
import {
  deleteApplicationDataRecord as deleteDataFromIndexedDb,
  readPersistenceSnapshotOnce,
  type RawPersistenceSnapshot,
} from "../repositories/applicationDataRepository";
import {
  buildMapDataPuts,
  materializeMapData,
  readMapEntriesFromStore,
} from "../repositories/mapRepository";
import { validateCheckpointForRoot } from "../recovery/checkpoint";

export type { StoreName } from "../db/constants";
export type { AppData } from "../../app/ports/PersistenceCommandPort";

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

export interface ObservedRevisionRoot {
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

export interface StoredPersistenceMetadata extends ObservedRevisionRoot {
  kind: "event-shopping-planner-persistence-metadata";
  version: 1;
}

type LegacyMigrationPhaseV1 =
  | "prepared"
  | "copied"
  | "verified"
  | "cleanupPending"
  | "completed";

export type LegacyMigrationPhase =
  | "prepared"
  | "copied"
  | "verified"
  | "cleanup-ready"
  | "cleanup-in-progress"
  | "completed";

export interface LegacyMigrationJournalEntry {
  legacyKey: string;
  storeName: Exclude<StoreName, "syncQueue">;
  rawValue: string;
  expectedRawDigest: PersistenceDigestDescriptor;
  payloadDigest: PersistenceDigestDescriptor;
  targetRevision: string;
  mapKeys: string[];
  cleanupStatus: "pending" | "deferred" | "in-progress" | "removed";
}

export interface LegacyMigrationJournal {
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

export interface LegacyMigrationJournalEntryV1 {
  legacyKey: string;
  storeName: Exclude<StoreName, "syncQueue">;
  rawValue: string;
  rawDigest: PersistenceDigestDescriptor;
  payloadDigest: PersistenceDigestDescriptor;
  targetRevision: string;
  mapKeys: string[];
  cleanupStatus: "pending" | "retained" | "removed";
}

export interface LegacyMigrationJournalV1 {
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

export interface LegacyMigrationArchive {
  kind: "event-shopping-planner-legacy-migration-archive";
  schemaVersion: typeof LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  entries: LegacyMigrationArchiveEntry[];
}

export interface LegacyMigrationConflictResolution {
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

export const expectedRevisionRoots = new Map<string, ObservedRevisionRoot>();
export const expectedPersistenceCheckpoints = new Map<
  string,
  PersistenceCheckpoint | null
>();
export const persistenceWriterId = getPersistenceWriterId();

export function getObservedRootKey(storeName: StoreName, key: string): string {
  return `${storeName}\u0000${key}`;
}

function isPersistenceConflict(error: unknown): boolean {
  return (
    error instanceof PersistenceConflictError ||
    error instanceof InvalidMapPayloadError ||
    ["PersistenceConflict", "InvalidMapPayload"].includes(readErrorName(error))
  );
}

export function readErrorName(error: unknown): string {
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

export function fingerprintsEqual(left: unknown, right: unknown): boolean {
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

export function isStoredPersistenceMetadata(
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

export function assertStructuredCloneable(value: unknown): void {
  structuredClone(value);
}

export interface ValidatedPersistenceSnapshot<T> {
  status: "ok" | "missing";
  data: T | null;
  root: ObservedRevisionRoot;
  checkpoint: PersistenceCheckpoint | null;
}

function toRecoveryPrimitive(value: unknown): unknown {
  return snapshotStartupRecoveryValue(value);
}

export function createRecoveryIssue(
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

export function createRecoveryCandidate(
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

export function createRecoveryBundle(
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

export async function readPersistenceSnapshotWithRetry(
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

export async function validatePersistenceSnapshot<T>(
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

export function createStoredMetadata(
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

export interface RuntimeCandidateSnapshot<T> {
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

export function checkpointDescriptorMatchesRuntimeCandidate(
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

export function partitionRuntimeCandidateSnapshots<T>(
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

export function createNextPersistenceCheckpoint(
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
  const checkpoint: PersistenceCheckpoint = {
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
  const validatedCheckpoint = validateCheckpointForRoot(
    checkpoint,
    storeName,
    key,
    metadata,
  );
  if (!validatedCheckpoint) {
    throw new PersistenceConflictError(
      `${storeName}:${key} produced an empty persistence checkpoint.`,
    );
  }
  return validatedCheckpoint;
}

export async function readRuntimeCandidateSnapshots<T>(
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

export function runtimeSnapshotsToRecoveryCandidates(
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

export function runtimeCandidateIsRetainedForRecoveryAdoption(
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

export function retainRuntimeCandidatesForRecoveryAdoption(
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

export function cleanupRuntimeCandidateSnapshots(
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

export function immutableObservedRootFieldsMatch(
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

export function assertCurrentSnapshotMatchesExpected(
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

export function assertCurrentCheckpointMatchesExpected(
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
      transaction = openCoordinatedTransaction(
        database,
        transactionStores,
        "readwrite",
      );
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

export async function prepareMetadataForPayload(
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

export interface RawMapSnapshot {
  entries: Record<string, unknown>;
  metadata: unknown;
  checkpoint: unknown;
}

async function readRawMapSnapshotOnce(): Promise<RawMapSnapshot> {
  const database = await openDB();
  ensureStoreExists(database, STORES.MAP_DATA);
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const transaction = openCoordinatedTransaction(
    database,
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

export async function readRawMapSnapshotWithRetry(): Promise<RawMapSnapshot> {
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

export async function validateMapSnapshot(
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

export function assertCurrentMapMatchesExpected(
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
      transaction = openCoordinatedTransaction(
        database,
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

export async function writeMapData(data: MapDataStore): Promise<void> {
  const stableData = structuredClone(normalizeMapDataForPersistence(data));
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

export async function loadMapDataInternal(): Promise<LoadResult<MapDataStore>> {
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
export async function saveData<T>(
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
        [
          ...(currentCheckpoint?.absorbedCandidates ?? []),
          ...absorbedForCommit.map(({ candidate }) =>
            checkpointDescriptorFromRuntimeCandidate(candidate),
          ),
        ],
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
          adoptable: storeName !== STORES.SYNC_QUEUE && !validated.root.missing,
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

export async function loadData<T>(
  storeName: StoreName,
  key: string,
): Promise<LoadResult<T>> {
  const result = await loadDataUnobserved<T>(storeName, key);
  return recordPersistenceLoadOutcome(result);
}

export function recordPersistenceLoadOutcome<T>(
  result: LoadResult<T>,
): LoadResult<T> {
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
