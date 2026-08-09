import {
  createPersistenceCheckpointKey,
  createPersistenceMetadataKey,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  createSynchronousFingerprint,
  reconcileRuntimeFallbackCandidates,
  serializeRuntimeFallbackCandidate,
  type PersistenceCheckpoint,
  type PersistenceDigestDescriptor,
  type RuntimeFallbackCandidate,
  type StartupRecoveryCandidate,
} from "../../utils/persistenceResilience";
import { recordPersistenceReleaseAMetric } from "../../utils/persistenceReleaseAMetrics";
import type {
  LoadResult,
  PersistenceRecordOperations,
} from "../contracts/persistence";
import { STORES, type StoreName } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import {
  ensureStoreExists,
  openDatabase,
  resetDatabaseConnection,
} from "../db/openDatabase";
import { openCoordinatedTransaction } from "../db/transactionCoordinator";
import {
  assertCurrentCheckpointMatchesExpected,
  assertCurrentSnapshotMatchesExpected,
  assertPhysicalRootMatchesLogicalFallback,
  canUseRuntimeFallback,
  checkpointDescriptorFromRuntimeCandidate,
  checkpointRecordsRuntimeCandidate,
  cleanupRuntimeCandidateSnapshots,
  createConflictLoadResult,
  createNextPersistenceCheckpoint,
  createObservedRootFromRuntimeCandidate,
  createRecoveryBundle,
  createRecoveryCandidate,
  createRecoveryIssue,
  expectedPersistenceCheckpoints,
  expectedRevisionRoots,
  getObservedRootKey,
  isPersistenceConflict,
  isStoredPersistenceMetadata,
  partitionRuntimeCandidateSnapshots,
  persistenceWriterId,
  prepareMetadataForPayload,
  readErrorName,
  readPersistenceSnapshotWithRetry,
  readRuntimeCandidateSnapshots,
  runtimeSnapshotsToRecoveryCandidates,
  validatePersistenceSnapshot,
  type ObservedRevisionRoot,
  type RuntimeCandidateSnapshot,
  type StoredPersistenceMetadata,
} from "../internal/persistenceCore";
import {
  readPersistenceSnapshotOnce,
  type RawPersistenceSnapshot,
} from "./applicationDataRepository";

async function writeDataWithMetadataOnce<T>(
  storeName: StoreName,
  key: string,
  data: T,
  expected: ObservedRevisionRoot,
  expectedCheckpoint: PersistenceCheckpoint | null,
  metadata: StoredPersistenceMetadata,
  checkpoint: PersistenceCheckpoint,
): Promise<void> {
  const database = await openDatabase();
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

export async function saveApplicationRecord<T>(
  storeName: StoreName,
  key: string,
  data: T,
): Promise<void> {
  const stableData = structuredClone(data);
  const observedKey = getObservedRootKey(storeName, key);
  let expected = expectedRevisionRoots.get(observedKey);
  if (!expected) {
    const observed = await loadApplicationRecord<T>(storeName, key);
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
    resetDatabaseConnection();

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
    resetDatabaseConnection();
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

async function loadApplicationRecordUnobserved<T>(
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
      if (attempt === 0) resetDatabaseConnection();
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

export async function loadApplicationRecord<T>(
  storeName: StoreName,
  key: string,
): Promise<LoadResult<T>> {
  const result = await loadApplicationRecordUnobserved<T>(storeName, key);
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

export const applicationRecordOperations: PersistenceRecordOperations = {
  save: saveApplicationRecord,
  load: loadApplicationRecord,
};
