/**
 * Explicit recovery-candidate adoption transaction.
 *
 * Candidate identity, raw evidence, conflict resolution, archive, commit, and
 * readback verification are kept behind one independently testable operation.
 */

import type { MapDataStore } from "../../types/map";
import {
  createPersistenceCheckpointKey,
  createPersistenceDigest,
  createPersistenceMetadataKey,
  createPersistenceRevision,
  createRuntimeFallbackKey,
  createSynchronousFingerprint,
  createStartupRecoveryCandidateId,
  snapshotStartupRecoveryValue,
  verifyPersistenceDigest,
  type PersistenceCheckpoint,
  type PersistenceCheckpointCommittedRoot,
  type PersistenceDigestDescriptor,
  type RuntimeFallbackCandidate,
  type StartupRecoveryCandidate,
} from "../../utils/persistenceResilience";
import {
  DATA_KEY,
  LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  LEGACY_MIGRATION_JOURNAL_KEY,
  MAP_DATA_LEGACY_KEY,
  RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX,
  STORES,
} from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import { ensureStoreExists, openDatabase as openDB } from "../db/openDatabase";
import { openCoordinatedTransaction } from "../db/transactionCoordinator";
import {
  assertStructuredCloneable,
  checkpointDescriptorMatchesRuntimeCandidate,
  createNextPersistenceCheckpoint,
  expectedPersistenceCheckpoints,
  expectedRevisionRoots,
  fingerprintsEqual,
  getObservedRootKey,
  immutableObservedRootFieldsMatch,
  isStoredPersistenceMetadata,
  persistenceWriterId,
  prepareMetadataForPayload,
  readPersistenceSnapshotWithRetry,
  readRuntimeCandidateSnapshots,
  retainRuntimeCandidatesForRecoveryAdoption,
  runtimeCandidateIsRetainedForRecoveryAdoption,
  runtimeSnapshotsToRecoveryCandidates,
  type LegacyMigrationConflictResolution,
  type LegacyMigrationJournal,
  type RuntimeCandidateSnapshot,
  type StoredPersistenceMetadata,
} from "../internal/persistenceCore";
import {
  committedRootFromMetadata,
  createLegacyMigrationConflictResolutionKey,
  isLegacyMigrationConflictContext,
  isLegacyMigrationConflictResolution,
  isLegacyMigrationJournal,
  legacyMigrationTargetForConflictContext,
  readInternalControlRecord,
  recoveryAdoptionArchiveMatchesLegacyResolution,
} from "../migration/legacyMigration";
import {
  buildMapDataPuts,
  parseMapDataEntryKey,
  readRawMapSnapshotWithRetry,
} from "../repositories/mapRepository";
import { validateCheckpointForRoot } from "./checkpoint";
import {
  assertRuntimeRawEvidenceUnchanged,
  recoveryEvidenceMatches,
  type RecoveryAdoptionStoreName,
} from "./recoverySourceEvidence";
import {
  getTrustedRecoveryAdoptionRoot,
  materializeRecoveryAdoptionCurrentPayload,
  normalizeRecoveryAdoptionPayload,
  type RecoveryAdoptionCurrentEvidence,
} from "./recoveryEvidence";

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
      transaction = openCoordinatedTransaction(
        database,
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

export async function adoptRecoveryCandidateInternal(
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
