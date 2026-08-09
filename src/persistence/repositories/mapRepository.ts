import type { MapDataStore } from "../../types/map";
import {
  InvalidMapPayloadError,
  compactDayMapForStorage,
  expandDayMapFromStorage,
  expandMapDataFromStorage,
  normalizeMapDataForPersistence,
} from "../../utils/mapDataPersistence";
import {
  createPersistenceCheckpointKey,
  createPersistenceMetadataKey,
  createSynchronousFingerprint,
  verifyPersistenceDigest,
  type PersistenceCheckpoint,
} from "../../utils/persistenceResilience";
import type { LoadResult } from "../contracts/persistence";
import {
  DATA_KEY,
  MAP_DATA_KEY_PREFIX,
  MAP_DATA_LEGACY_KEY,
  STORES,
} from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import {
  ensureStoreExists,
  openDatabase,
  resetDatabaseConnection,
} from "../db/openDatabase";
import {
  openCoordinatedTransaction,
  requestResult,
  transactionFinished,
} from "../db/transactionCoordinator";
import {
  assertCurrentCheckpointMatchesExpected,
  createConflictLoadResult,
  createNextPersistenceCheckpoint,
  createRecoveryBundle,
  createRecoveryCandidate,
  createRecoveryIssue,
  createSyntheticRoot,
  expectedPersistenceCheckpoints,
  expectedRevisionRoots,
  getObservedRootKey,
  immutableObservedRootFieldsMatch,
  isPersistenceConflict,
  isStoredPersistenceMetadata,
  prepareMetadataForPayload,
  readErrorName,
  type ObservedRevisionRoot,
  type StoredPersistenceMetadata,
  type ValidatedPersistenceSnapshot,
} from "../internal/persistenceCore";
import { validateCheckpointForRoot } from "../recovery/checkpoint";
import { recordPersistenceLoadOutcome } from "./recordRepository";

const fingerprintsEqual = (left: unknown, right: unknown): boolean => {
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
};

export function getMapDataEntryKey(
  eventName: string,
  dayMapName: string,
): string {
  return `${MAP_DATA_KEY_PREFIX}${JSON.stringify([eventName, dayMapName])}`;
}

export function parseMapDataEntryKey(key: string): [string, string] | null {
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
    // Managed-prefix records are app-owned evidence and fail closed below.
  }

  throw new InvalidMapPayloadError(
    "Persisted mapData contains an invalid managed split-record key.",
  );
}

export function readMapEntriesFromStore(
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

export function materializeMapData(entries: Record<string, unknown>): {
  data: MapDataStore;
  knownKeys: string[];
} {
  const data: MapDataStore = {};
  const knownKeys: string[] = [];

  if (Object.prototype.hasOwnProperty.call(entries, MAP_DATA_LEGACY_KEY)) {
    knownKeys.push(MAP_DATA_LEGACY_KEY);
    const legacy = expandMapDataFromStorage(entries[MAP_DATA_LEGACY_KEY]);
    Object.entries(legacy).forEach(([eventName, eventMapData]) => {
      Object.defineProperty(data, eventName, {
        value: { ...eventMapData },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
  }

  Object.entries(entries).forEach(([storageKey, value]) => {
    const parsed = parseMapDataEntryKey(storageKey);
    if (!parsed) return;
    knownKeys.push(storageKey);
    const [eventName, dayMapName] = parsed;
    const expandedDayMap = expandDayMapFromStorage(value);
    const existingEventMap = Object.prototype.hasOwnProperty.call(
      data,
      eventName,
    )
      ? data[eventName]
      : undefined;
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
    Object.defineProperty(data, eventName, {
      value: {
        ...(existingEventMap ?? {}),
        [dayMapName]: expandedDayMap,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });

  return { data, knownKeys };
}

export function buildMapDataPuts(
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

export interface RawMapSnapshot {
  entries: Record<string, unknown>;
  metadata: unknown;
  checkpoint: unknown;
}

async function readRawMapSnapshotOnce(): Promise<RawMapSnapshot> {
  const database = await openDatabase();
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
    resetDatabaseConnection();
    try {
      return await readRawMapSnapshotOnce();
    } catch (retryError) {
      resetDatabaseConnection();
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
  const database = await openDatabase();
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

export async function saveMapData(data: MapDataStore): Promise<void> {
  const stableData = structuredClone(normalizeMapDataForPersistence(data));
  const observedKey = getObservedRootKey(STORES.MAP_DATA, DATA_KEY);
  let expected = expectedRevisionRoots.get(observedKey);
  if (!expected) {
    const loaded = await loadMapDataUnobserved();
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
    resetDatabaseConnection();
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

async function loadMapDataUnobserved(): Promise<LoadResult<MapDataStore>> {
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

export async function loadMapData(): Promise<LoadResult<MapDataStore>> {
  return recordPersistenceLoadOutcome(await loadMapDataUnobserved());
}
