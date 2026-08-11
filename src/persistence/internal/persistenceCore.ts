/**
 * IndexedDB persistence engine.
 *
 * Owns optimistic roots, snapshot validation, and fallback-lineage semantics.
 * Repository I/O, migration, restore, and explicit recovery orchestration
 * depend on this lower-level engine and never feed dependencies back into it.
 */

import { InvalidMapPayloadError } from "../../utils/mapDataPersistence";
import {
  createPersistenceCheckpointKey,
  createPersistenceDigest,
  createPersistenceIntegrityDescriptors,
  createPersistenceMetadataKey,
  createPersistenceRevision,
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
import type { LoadResult } from "../contracts/persistence";
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
import { resetDatabaseConnection as resetDbInstance } from "../db/openDatabase";
import { isPlainRecord } from "./valueValidation";
import {
  readPersistenceSnapshotOnce,
  type RawPersistenceSnapshot,
} from "../repositories/applicationDataRepository";
import { validateCheckpointForRoot } from "../recovery/checkpoint";

export type { StoreName } from "../db/constants";
export type { AppData } from "../../app/ports/PersistenceCommandPort";
export type {
  LoadResult,
  LoadStatus,
  PersistenceCleanupStatus,
  PersistenceDataMigrationStatus,
  PersistenceLegacyCleanupResult,
  PersistenceLegacyCleanupSafetyRequest,
  PersistenceLegacyCleanupTaskBlockedReason,
  PersistenceLegacyCleanupTaskDeferredReason,
  PersistenceMigrationCleanupDeferredReason,
  PersistenceMigrationResult,
  PersistenceMigrationStatus,
} from "../contracts/persistence";

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

export function isPersistenceConflict(error: unknown): boolean {
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

export function canUseRuntimeFallback(
  storeName: StoreName,
  error: unknown,
): boolean {
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

export function createConflictLoadResult<T>(
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

export async function createSyntheticRoot(
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

export function createObservedRootFromRuntimeCandidate(
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

export function checkpointDescriptorFromRuntimeCandidate(
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

export function checkpointRecordsRuntimeCandidate(
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

export async function assertPhysicalRootMatchesLogicalFallback(
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

export async function prepareMetadataForPayload(
  storeName: StoreName,
  key: string,
  data: unknown,
  baseRevision: string | null,
  revision = createPersistenceRevision(persistenceWriterId),
): Promise<StoredPersistenceMetadata> {
  assertStructuredCloneable(data);
  const { digest: payloadDigest, fingerprint: payloadFingerprint } =
    await createPersistenceIntegrityDescriptors(data);
  return createStoredMetadata(
    storeName,
    key,
    revision,
    baseRevision,
    payloadDigest,
    payloadFingerprint,
  );
}
