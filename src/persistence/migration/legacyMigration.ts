/**
 * Legacy localStorage migration and cleanup state machine.
 *
 * Journal CAS, raw-source evidence, archive verification, and cleanup safety
 * remain co-located so each transition can be tested independently of the
 * public persistence facade.
 */

import type { MapDataStore } from "../../types/map";
import {
  compactMapDataForStorage,
  expandMapDataFromStorage,
} from "../../utils/mapDataPersistence";
import {
  createPersistenceCheckpointKey,
  createPersistenceDigest,
  createPersistenceMetadataKey,
  createPersistenceRevision,
  createSynchronousFingerprint,
  createStartupRecoveryCandidateId,
  isPersistenceDigestDescriptor,
  parseRuntimeFallbackCandidate,
  reconcileRuntimeFallbackCandidates,
  verifyPersistenceDigest,
  type PersistenceCheckpoint,
  type PersistenceCheckpointCommittedRoot,
  type PersistenceDigestDescriptor,
  type StartupRecoveryCandidate,
  type StartupRecoveryLegacyMigrationConflict,
} from "../../utils/persistenceResilience";
import {
  coordinatePersistenceLegacyCleanup,
  emitPersistenceCleanupMetric,
  type PersistenceCleanupBlockedReason,
  type PersistenceCleanupDeferredReason,
  type PersistenceCleanupMode,
  type PersistenceCleanupTaskContext,
} from "../../utils/persistenceCleanupCoordinator";
import { recordPersistenceCleanupReleaseAMetric } from "../../utils/persistenceReleaseAMetrics";
import {
  DATA_KEY,
  LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX,
  LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION,
  LEGACY_MIGRATION_CONFLICT_RESOLUTION_KEY_PREFIX,
  LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  LEGACY_MIGRATION_JOURNAL_KEY,
  LEGACY_MIGRATION_SCHEMA_VERSION,
  LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY,
  RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX,
  STORES,
  type StoreName,
} from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import { ensureStoreExists, openDatabase as openDB } from "../db/openDatabase";
import {
  openCoordinatedTransaction,
  requestResult,
  transactionFinished,
} from "../db/transactionCoordinator";
import { isPlainRecord } from "../internal/valueValidation";
import {
  assertCurrentCheckpointMatchesExpected,
  assertCurrentMapMatchesExpected,
  assertCurrentSnapshotMatchesExpected,
  assertStructuredCloneable,
  createNextPersistenceCheckpoint,
  createRecoveryBundle,
  createRecoveryCandidate,
  createRecoveryIssue,
  createStoredMetadata,
  expectedPersistenceCheckpoints,
  expectedRevisionRoots,
  fingerprintsEqual,
  getObservedRootKey,
  isStoredPersistenceMetadata,
  partitionRuntimeCandidateSnapshots,
  persistenceWriterId,
  readErrorName,
  readPersistenceSnapshotWithRetry,
  readRawMapSnapshotWithRetry,
  readRuntimeCandidateSnapshots,
  runtimeSnapshotsToRecoveryCandidates,
  validateMapSnapshot,
  validatePersistenceSnapshot,
  type LegacyMigrationArchive,
  type LegacyMigrationConflictResolution,
  type LegacyMigrationJournal,
  type LegacyMigrationJournalEntry,
  type LegacyMigrationJournalEntryV1,
  type LegacyMigrationJournalV1,
  type LegacyMigrationPhase,
  type ObservedRevisionRoot,
  type PersistenceCleanupStatus,
  type PersistenceLegacyCleanupResult,
  type PersistenceLegacyCleanupSafetyRequest,
  type PersistenceLegacyCleanupTaskBlockedReason,
  type PersistenceLegacyCleanupTaskDeferredReason,
  type PersistenceMigrationResult,
  type RawMapSnapshot,
  type RuntimeCandidateSnapshot,
  type StoredPersistenceMetadata,
  type ValidatedPersistenceSnapshot,
} from "../internal/persistenceCore";
import {
  getTrustedRecoveryAdoptionRoot,
  materializeRecoveryAdoptionCurrentPayload,
  normalizeRecoveryAdoptionPayload,
  type RecoveryAdoptionCurrentEvidence,
} from "../recovery/recoveryEvidence";
import {
  recoveryEvidenceMatches,
  type RecoveryAdoptionStoreName,
} from "../recovery/recoverySourceEvidence";
import {
  buildMapDataPuts,
  materializeMapData,
  readMapEntriesFromStore,
} from "../repositories/mapRepository";
import { validateCheckpointForRoot } from "../recovery/checkpoint";

export const LEGACY_MIGRATION_TARGETS = [
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

export type LegacyMigrationTarget = (typeof LEGACY_MIGRATION_TARGETS)[number];

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

class LegacyMigrationArchiveConflictError extends PersistenceConflictError {
  readonly recoveryCandidates: StartupRecoveryCandidate[];

  constructor(message: string, archiveKey: string, rawArchive: unknown) {
    super(message);
    this.recoveryCandidates =
      rawArchive === undefined
        ? []
        : [
            createRecoveryCandidate(
              "migration-journal",
              STORES.SYNC_QUEUE,
              archiveKey,
              null,
              rawArchive,
              undefined,
              { role: "invalid-source", adoptable: false },
            ),
          ];
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

export function createLegacyMigrationConflictResolutionKey(
  legacyKey: string,
): string {
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

export function committedRootFromMetadata(
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

export function legacyMigrationTargetForConflictContext(
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

export function isLegacyMigrationConflictContext(
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

export function isLegacyMigrationConflictResolution(
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

export async function recoveryAdoptionArchiveMatchesLegacyResolution(
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
  if (target.storeName === STORES.MAP_DATA) {
    for (const eventMap of Object.values(parsed)) {
      if (!isPlainRecord(eventMap)) {
        throw new Error(`${target.legacyKey} contains an invalid event map.`);
      }
      if (Object.values(eventMap).some((dayMap) => !isPlainRecord(dayMap))) {
        throw new Error(`${target.legacyKey} contains an invalid day map.`);
      }
    }
    return expandMapDataFromStorage(
      compactMapDataForStorage(parsed as MapDataStore),
    ) as Record<string, unknown>;
  }
  return parsed;
}

function parseLegacyV1MigrationPayloadForDigest(
  target: LegacyMigrationTarget,
  rawValue: string,
  normalizedPayload: Record<string, unknown>,
): Record<string, unknown> {
  if (target.storeName !== STORES.MAP_DATA) return normalizedPayload;
  const parsed = JSON.parse(rawValue) as unknown;
  if (!isPlainRecord(parsed)) {
    throw new Error(`${target.legacyKey} must contain a JSON object.`);
  }

  // d2389a0 retained exactly empty map events in the logical digest even
  // though it emitted no split records for them. Its ordinary property
  // assignment also dropped "__proto__" event/day names as own keys.
  // Reconstruct that historical representation while sourcing all retained
  // day-map values from the current strict parser and normalizer.
  const legacyPayload: Record<string, unknown> = {};
  Object.entries(parsed).forEach(([eventName, eventMap]) => {
    if (!isPlainRecord(eventMap)) {
      throw new Error(`${target.legacyKey} contains an invalid event map.`);
    }
    // d2389a0 used ordinary property assignment. "__proto__" therefore
    // replaced an intermediate prototype and never became an own event key.
    if (eventName === "__proto__") return;
    const normalizedEventMap = normalizedPayload[eventName];
    const legacyEventMap: Record<string, unknown> = {};
    Object.keys(eventMap).forEach((dayMapName) => {
      // The nested ordinary assignment had the same "__proto__" behavior.
      if (dayMapName === "__proto__") return;
      if (
        !isPlainRecord(normalizedEventMap) ||
        !Object.prototype.hasOwnProperty.call(normalizedEventMap, dayMapName)
      ) {
        throw new Error(
          `${target.legacyKey} could not reconstruct legacy day ${dayMapName}.`,
        );
      }
      Object.defineProperty(legacyEventMap, dayMapName, {
        value: normalizedEventMap[dayMapName],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    Object.defineProperty(legacyPayload, eventName, {
      value: legacyEventMap,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });
  return legacyPayload;
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

export function isLegacyMigrationJournal(
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

export async function readInternalControlRecord(key: string): Promise<unknown> {
  const database = await openDB();
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  const transaction = openCoordinatedTransaction(
    database,
    STORES.SYNC_QUEUE,
    "readonly",
  );
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
  const conflict = (message: string) =>
    new LegacyMigrationArchiveConflictError(message, journal.archiveKey, value);
  if (
    !isLegacyMigrationArchive(value) ||
    value.sessionId !== journal.sessionId ||
    (expected !== undefined && !fingerprintsEqual(value, expected))
  ) {
    throw conflict("Migration recovery archive is missing or was replaced.");
  }

  const entriesByKey = new Map(
    value.entries.map((entry) => [entry.legacyKey, entry]),
  );
  for (const entry of value.entries) {
    let digestValid = false;
    try {
      digestValid = await verifyPersistenceDigest(
        entry.rawValue,
        entry.rawDigest,
      );
    } catch {
      // Unsupported or malformed digests remain available for recovery export.
    }
    if (!digestValid) {
      throw conflict(
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
      throw conflict(
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

async function upgradeLegacyMigrationJournalValue(
  journal: LegacyMigrationJournalV1,
): Promise<LegacyMigrationJournal> {
  const normalizedPayloadDigests = new Map<
    string,
    PersistenceDigestDescriptor
  >();
  const normalizedMapKeys = new Map<string, string[]>();
  for (const { target, rawValue } of legacySnapshotsFromJournal(journal)) {
    const normalizedPayload = parseLegacyMigrationPayload(target, rawValue);
    normalizedPayloadDigests.set(
      target.legacyKey,
      await createPersistenceDigest(normalizedPayload),
    );
    if (target.storeName === STORES.MAP_DATA) {
      normalizedMapKeys.set(
        target.legacyKey,
        buildMapDataPuts(normalizedPayload as MapDataStore)
          .map(({ key }) => key)
          .sort(),
      );
    }
  }
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
      payloadDigest:
        normalizedPayloadDigests.get(entry.legacyKey) ?? entry.payloadDigest,
      targetRevision: entry.targetRevision,
      mapKeys: normalizedMapKeys.get(entry.legacyKey) ?? [...entry.mapKeys],
      cleanupStatus:
        entry.cleanupStatus === "removed"
          ? "removed"
          : journal.phase === "cleanupPending"
            ? "deferred"
            : "pending",
    })),
  };
}

interface LegacyV1MapNormalizationRepair {
  expectedSnapshot: RawMapSnapshot;
  repairedMetadata: StoredPersistenceMetadata;
  repairedCheckpoint: PersistenceCheckpoint;
  mapDeletes: string[];
  mapPuts: { key: string; value: unknown }[];
}

async function prepareLegacyV1MapNormalizationRepair(
  journal: LegacyMigrationJournalV1,
  upgraded: LegacyMigrationJournal,
): Promise<LegacyV1MapNormalizationRepair | null> {
  const legacyEntry = journal.entries.find(
    ({ storeName }) => storeName === STORES.MAP_DATA,
  );
  const upgradedEntry = upgraded.entries.find(
    ({ storeName }) => storeName === STORES.MAP_DATA,
  );
  if (
    !legacyEntry ||
    !upgradedEntry ||
    fingerprintsEqual(legacyEntry.payloadDigest, upgradedEntry.payloadDigest)
  ) {
    return null;
  }
  if (journal.phase === "prepared") return null;

  const target = LEGACY_MIGRATION_TARGETS.find(
    ({ legacyKey, storeName }) =>
      legacyKey === legacyEntry.legacyKey &&
      storeName === legacyEntry.storeName,
  );
  if (!target) {
    throw new PersistenceConflictError(
      "A legacy v1 map journal contains an unknown target.",
    );
  }
  const normalizedPayload = parseLegacyMigrationPayload(
    target,
    legacyEntry.rawValue,
  );
  const legacyDigestPayload = parseLegacyV1MigrationPayloadForDigest(
    target,
    legacyEntry.rawValue,
    normalizedPayload,
  );
  const expectedLegacyFingerprint =
    createSynchronousFingerprint(legacyDigestPayload);
  const normalizedFingerprint = createSynchronousFingerprint(normalizedPayload);
  const expectedLegacyPuts = buildMapDataPuts(
    legacyDigestPayload as MapDataStore,
  );
  const normalizedPuts = buildMapDataPuts(normalizedPayload as MapDataStore);
  const snapshot = await readRawMapSnapshotWithRetry();
  const materialized = materializeMapData(snapshot.entries);
  const actualKeys = [...materialized.knownKeys].sort();
  const expectedKeys = [...legacyEntry.mapKeys].sort();
  const expectedLegacyPutKeys = expectedLegacyPuts.map(({ key }) => key).sort();
  const legacyMetadata = isStoredPersistenceMetadata(
    snapshot.metadata,
    STORES.MAP_DATA,
    DATA_KEY,
  )
    ? snapshot.metadata
    : null;
  if (
    legacyMetadata !== null &&
    legacyMetadata.revision === legacyEntry.targetRevision &&
    fingerprintsEqual(
      legacyMetadata.payloadDigest,
      legacyEntry.payloadDigest,
    ) &&
    fingerprintsEqual(
      legacyMetadata.payloadFingerprint,
      expectedLegacyFingerprint,
    ) &&
    snapshot.checkpoint === undefined &&
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedLegacyPutKeys.length === expectedKeys.length &&
    expectedLegacyPutKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedLegacyPuts.every(({ key, value }) =>
      fingerprintsEqual(snapshot.entries[key], value),
    )
  ) {
    const repairedMetadata: StoredPersistenceMetadata = {
      ...legacyMetadata,
      payloadDigest: upgradedEntry.payloadDigest,
      payloadFingerprint: normalizedFingerprint,
    };
    return {
      expectedSnapshot: snapshot,
      repairedMetadata,
      repairedCheckpoint: createNextPersistenceCheckpoint(
        STORES.MAP_DATA,
        DATA_KEY,
        repairedMetadata,
        null,
      ),
      mapDeletes: actualKeys,
      mapPuts: normalizedPuts,
    };
  }

  if (journal.phase !== "copied") {
    const currentValidation = await validateMapSnapshot(snapshot);
    if (
      !("conflict" in currentValidation) &&
      !currentValidation.validated.root.synthetic
    ) {
      return null;
    }
  }
  throw new PersistenceConflictError(
    "A legacy v1 map journal does not match its physical root.",
  );
}

async function upgradeLegacyMigrationJournalV1Atomically(
  journal: LegacyMigrationJournalV1,
  legacySyncQueueRawValue: string | null,
): Promise<LegacyMigrationJournal> {
  await validateLegacyMigrationJournalDescriptors(journal);
  const upgraded = await upgradeLegacyMigrationJournalValue(journal);
  const mapNormalizationRepair = await prepareLegacyV1MapNormalizationRepair(
    journal,
    upgraded,
  );
  const archive = await createLegacyMigrationArchive(
    journal,
    legacySyncQueueRawValue,
  );
  const database = await openDB();
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  if (mapNormalizationRepair) {
    ensureStoreExists(database, STORES.MAP_DATA);
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = openCoordinatedTransaction(
      database,
      mapNormalizationRepair
        ? [STORES.MAP_DATA, STORES.SYNC_QUEUE]
        : STORES.SYNC_QUEUE,
      "readwrite",
    );
    const store = transaction.objectStore(STORES.SYNC_QUEUE);
    let failure: unknown = null;
    let currentJournal: unknown;
    let currentArchive: unknown;
    let currentMapEntries: Record<string, unknown> | undefined;
    let currentMapMetadata: unknown;
    let currentMapCheckpoint: unknown;
    let readsRemaining = mapNormalizationRepair ? 5 : 2;
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
          (!isLegacyMigrationArchive(currentArchive) ||
            !fingerprintsEqual(currentArchive, archive))
        ) {
          throw new LegacyMigrationArchiveConflictError(
            "A different immutable migration archive already exists.",
            upgraded.archiveKey,
            currentArchive,
          );
        }
        if (
          mapNormalizationRepair &&
          (!currentMapEntries ||
            !fingerprintsEqual(
              currentMapEntries,
              mapNormalizationRepair.expectedSnapshot.entries,
            ) ||
            !fingerprintsEqual(
              currentMapMetadata,
              mapNormalizationRepair.expectedSnapshot.metadata,
            ) ||
            currentMapCheckpoint !== undefined)
        ) {
          throw new PersistenceConflictError(
            "The copied legacy v1 map root changed before normalization.",
          );
        }
        if (currentArchive === undefined) {
          const archivePut = store.put(archive, upgraded.archiveKey);
          archivePut.onerror = () => {
            failure = failure ?? archivePut.error;
          };
        }
        if (mapNormalizationRepair) {
          const mapStore = transaction.objectStore(STORES.MAP_DATA);
          mapNormalizationRepair.mapDeletes.forEach((key) => {
            const mapDelete = mapStore.delete(key);
            mapDelete.onerror = () => {
              failure = failure ?? mapDelete.error;
            };
          });
          mapNormalizationRepair.mapPuts.forEach(({ key, value }) => {
            const mapPut = mapStore.put(value, key);
            mapPut.onerror = () => {
              failure = failure ?? mapPut.error;
            };
          });
          const metadataPut = store.put(
            mapNormalizationRepair.repairedMetadata,
            createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
          );
          metadataPut.onerror = () => {
            failure = failure ?? metadataPut.error;
          };
          const checkpointPut = store.put(
            mapNormalizationRepair.repairedCheckpoint,
            createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY),
          );
          checkpointPut.onerror = () => {
            failure = failure ?? checkpointPut.error;
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
    if (mapNormalizationRepair) {
      void readMapEntriesFromStore(
        transaction.objectStore(STORES.MAP_DATA),
      ).then(
        (entries) => {
          currentMapEntries = entries;
          queueWrites();
        },
        (error: unknown) => {
          abortWith(error);
        },
      );
      const metadataRequest = store.get(
        createPersistenceMetadataKey(STORES.MAP_DATA, DATA_KEY),
      );
      metadataRequest.onerror = () => {
        failure = failure ?? metadataRequest.error;
      };
      metadataRequest.onsuccess = () => {
        currentMapMetadata = metadataRequest.result;
        queueWrites();
      };
      const checkpointRequest = store.get(
        createPersistenceCheckpointKey(STORES.MAP_DATA, DATA_KEY),
      );
      checkpointRequest.onerror = () => {
        failure = failure ?? checkpointRequest.error;
      };
      checkpointRequest.onsuccess = () => {
        currentMapCheckpoint = checkpointRequest.result;
        queueWrites();
      };
    }
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
  await validateLegacyMigrationJournalDescriptors(upgraded);
  return upgraded;
}

async function writeMigrationJournalWithCas(
  expected: LegacyMigrationJournal | null,
  next: LegacyMigrationJournal,
): Promise<void> {
  const database = await openDB();
  ensureStoreExists(database, STORES.SYNC_QUEUE);
  await new Promise<void>((resolve, reject) => {
    const transaction = openCoordinatedTransaction(
      database,
      STORES.SYNC_QUEUE,
      "readwrite",
    );
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
      transaction = openCoordinatedTransaction(
        database,
        targetStores,
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
            (!isLegacyMigrationArchive(currentArchive) ||
              !fingerprintsEqual(currentArchive, archive))
          ) {
            throw new LegacyMigrationArchiveConflictError(
              "A different immutable migration archive already exists.",
              journal.archiveKey,
              currentArchive,
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
          if (currentArchive === undefined) {
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
    const legacyV1MapPayload =
      journal.schemaVersion === 1 &&
      snapshot.target.storeName === STORES.MAP_DATA
        ? parseLegacyV1MigrationPayloadForDigest(
            snapshot.target,
            snapshot.rawValue,
            payload,
          )
        : null;
    const [rawDigestValid, normalizedPayloadDigestValid] = await Promise.all([
      verifyPersistenceDigest(
        snapshot.rawValue,
        "expectedRawDigest" in journalEntry
          ? journalEntry.expectedRawDigest
          : journalEntry.rawDigest,
      ),
      verifyPersistenceDigest(payload, journalEntry.payloadDigest),
    ]);
    const legacyV1PayloadDigestValid =
      !normalizedPayloadDigestValid && legacyV1MapPayload !== null
        ? await verifyPersistenceDigest(
            legacyV1MapPayload,
            journalEntry.payloadDigest,
          )
        : false;
    const mapKeys =
      snapshot.target.storeName === STORES.MAP_DATA
        ? buildMapDataPuts((legacyV1MapPayload ?? payload) as MapDataStore)
            .map(({ key }) => key)
            .sort()
        : [];
    const recordedMapKeys = [...journalEntry.mapKeys].sort();
    if (
      !rawDigestValid ||
      (!normalizedPayloadDigestValid && !legacyV1PayloadDigestValid) ||
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

export async function runLegacyPersistenceSourceCleanup(
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

function migrationArchiveConflictRecoveryCandidates(
  error: unknown,
): StartupRecoveryCandidate[] {
  return error instanceof LegacyMigrationArchiveConflictError
    ? error.recoveryCandidates
    : [];
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

export async function migrateFromLocalStorage(
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
        if (rawArchive !== undefined) {
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
            [
              ...migrationArchiveRecoveryCandidates(migrationArchive),
              ...migrationArchiveConflictRecoveryCandidates(error),
            ],
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
        ...migrationArchiveConflictRecoveryCandidates(error),
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
        ...migrationArchiveConflictRecoveryCandidates(error),
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
      if (rawArchive !== undefined) {
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
      capturedLegacySyncQueueRawValue !== null &&
      !(error instanceof LegacyMigrationArchiveConflictError)
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
      [
        ...migrationArchiveRecoveryCandidates(migrationArchive),
        ...migrationArchiveConflictRecoveryCandidates(error),
      ],
      captureLegacySyncQueueSourceForRecovery(capturedLegacySyncQueueRawValue),
    );
  }
}
