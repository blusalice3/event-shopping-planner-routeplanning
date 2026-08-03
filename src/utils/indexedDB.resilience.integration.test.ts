// @vitest-environment jsdom

import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapDataStore } from "../types/map";
import {
  createPersistenceCheckpointKey,
  createPersistenceDigest,
  createPersistenceMetadataKey,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  createRuntimeFallbackPrefix,
  createSynchronousFingerprint,
  serializeRuntimeFallbackCandidate,
} from "./persistenceResilience";
import legacyJournalV1NoCheckpointFixture from "../test/fixtures/legacy-journal-v1-no-checkpoint-d2389a0.json";

const DATABASE_NAME = "EventShoppingPlannerDB";
const CURRENT_DATABASE_VERSION = 5;
const UNSUPPORTED_DATABASE_VERSION = 8;
const DATA_KEY = "data";
const LEGACY_MIGRATION_JOURNAL_KEY =
  "__esp_internal__:migration:v1:legacy-local-storage";
const LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX =
  "__esp_internal__:migration-archive:v1:";

const REQUIRED_STORES = [
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "dayModes",
  "mapData",
  "mapRotationSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "mapViewportSettings",
  "syncQueue",
] as const;

type StoreName = (typeof REQUIRED_STORES)[number];
type DbApi = (typeof import("./indexedDB"))["db"];
type AppData = import("./indexedDB").AppData;

let databaseFactory: IDBFactory;

function makeDayMap(marker: string) {
  return {
    sheetName: `${marker}シート`,
    maxRow: 1,
    maxCol: 1,
    cells: [],
    mergedCells: [],
    blocks: [],
  };
}

function createSplitMapKey(eventName: string, dayMapName: string): string {
  return `mapData:${JSON.stringify([eventName, dayMapName])}`;
}

function makeAppData(marker: string): AppData {
  const eventName = `${marker}イベント`;
  const dayMapName = "1日目マップ";

  return {
    eventLists: {
      [eventName]: [{ id: `${marker}-item`, title: `${marker}頒布物` }],
    },
    eventMetadata: {
      [eventName]: { marker },
    },
    executeModeItems: {
      [eventName]: { "1日目": [`${marker}-item`] },
    },
    dayModes: {
      [eventName]: { "1日目": `${marker}モード` },
    },
    mapData: {
      [eventName]: { [dayMapName]: makeDayMap(marker) },
    },
    mapRotationSettings: {
      [eventName]: { [dayMapName]: { rotation: marker.length } },
    },
    routeSettings: {
      [eventName]: { [dayMapName]: { route: marker } },
    },
    hallDefinitions: {
      [eventName]: { [dayMapName]: [{ id: `${marker}-hall` }] },
    },
    hallRouteSettings: {
      [eventName]: { [dayMapName]: { order: [`${marker}-hall`] } },
    },
    mapViewportSettings: {
      [eventName]: { [dayMapName]: { scale: marker.length } },
    },
  };
}

async function importFreshDb(): Promise<DbApi> {
  return (await import("./indexedDB")).db;
}

function requestRawDatabase(
  version?: number,
  storesToCreate: readonly string[] = [],
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? databaseFactory.open(DATABASE_NAME)
        : databaseFactory.open(DATABASE_NAME, version);

    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open the test database."));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      storesToCreate.forEach((storeName) => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      });
    };
  });
}

async function seedDatabase(
  version: number,
  stores: readonly string[] = REQUIRED_STORES,
): Promise<void> {
  const database = await requestRawDatabase(version, stores);
  database.close();
}

async function readRawRecord(
  storeName: StoreName,
  key: IDBValidKey,
): Promise<unknown> {
  const database = await requestRawDatabase(
    CURRENT_DATABASE_VERSION,
    REQUIRED_STORES,
  );
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(key);
      request.onerror = () =>
        reject(request.error ?? new Error(`Failed to read ${storeName}.`));
      request.onsuccess = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

async function readRawRecordAtExistingVersion(
  storeName: StoreName,
  key: IDBValidKey,
): Promise<unknown> {
  const database = await requestRawDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(key);
      request.onerror = () =>
        reject(request.error ?? new Error(`Failed to read ${storeName}.`));
      request.onsuccess = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

async function writeRawRecordAtExistingVersion(
  storeName: StoreName,
  key: IDBValidKey,
  value: unknown,
): Promise<void> {
  const database = await requestRawDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).put(value, key);
      request.onerror = () =>
        reject(request.error ?? new Error(`Failed to write ${storeName}.`));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          transaction.error ??
            request.error ??
            new Error(`Failed to commit ${storeName}.`),
        );
    });
  } finally {
    database.close();
  }
}

async function deleteRawRecordAtExistingVersion(
  storeName: StoreName,
  key: IDBValidKey,
): Promise<void> {
  const database = await requestRawDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).delete(key);
      request.onerror = () =>
        reject(request.error ?? new Error(`Failed to delete ${storeName}.`));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          transaction.error ??
            request.error ??
            new Error(`Failed to commit ${storeName} deletion.`),
        );
    });
  } finally {
    database.close();
  }
}

async function readCurrentRevision(
  storeName: StoreName,
  key = DATA_KEY,
): Promise<string> {
  const metadataKey = createPersistenceMetadataKey(storeName, key);
  const metadata = await readRawRecord("syncQueue", metadataKey);
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("revision" in metadata) ||
    typeof metadata.revision !== "string"
  ) {
    throw new Error(`Missing persistence metadata for ${storeName}:${key}.`);
  }
  return metadata.revision;
}

async function readCurrentMetadata(
  storeName: StoreName,
  key = DATA_KEY,
): Promise<{
  revision: string;
  baseRevision: string | null;
  payloadDigest: unknown;
  writerId: string;
  committedAt: string;
}> {
  const metadata = await readRawRecord(
    "syncQueue",
    createPersistenceMetadataKey(storeName, key),
  );
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("revision" in metadata) ||
    typeof metadata.revision !== "string" ||
    !("baseRevision" in metadata) ||
    !(
      metadata.baseRevision === null ||
      typeof metadata.baseRevision === "string"
    ) ||
    !("payloadDigest" in metadata) ||
    !("writerId" in metadata) ||
    typeof metadata.writerId !== "string" ||
    !("committedAt" in metadata) ||
    typeof metadata.committedAt !== "string"
  ) {
    throw new Error(`Missing persistence metadata for ${storeName}:${key}.`);
  }
  return {
    revision: metadata.revision,
    baseRevision: metadata.baseRevision,
    payloadDigest: metadata.payloadDigest,
    writerId: metadata.writerId,
    committedAt: metadata.committedAt,
  };
}

async function installRuntimeFallbackCandidate({
  storeName,
  key = DATA_KEY,
  revision,
  baseRevision,
  payload,
}: {
  storeName: StoreName;
  key?: string;
  revision: string;
  baseRevision: string;
  payload: unknown;
}) {
  const candidate = await createRuntimeFallbackCandidate({
    storeName,
    key,
    revision,
    baseRevision,
    payload,
  });
  const storageKey = createRuntimeFallbackKey(
    storeName,
    key,
    candidate.revision,
  );
  const serialized = serializeRuntimeFallbackCandidate(candidate);
  localStorage.setItem(storageKey, serialized);
  return { candidate, serialized, storageKey };
}

function mockStoreWriteFailures(
  storeName: StoreName,
  error: Error,
  failureCount = Number.POSITIVE_INFINITY,
) {
  const originalTransaction = FakeIDBDatabase.prototype.transaction;
  let failures = 0;

  const spy = vi
    .spyOn(FakeIDBDatabase.prototype, "transaction")
    .mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const requestedStores =
        typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
      if (
        mode === "readwrite" &&
        requestedStores.includes(storeName) &&
        failures < failureCount
      ) {
        failures += 1;
        throw error;
      }
      return originalTransaction.call(this, storeNames, mode, options);
    });

  return {
    getFailureCount: () => failures,
    spy,
  };
}

function mockSynchronousStorePutFailure(
  storeName: StoreName,
  key: IDBValidKey,
  error: Error,
) {
  const originalPut = FakeIDBObjectStore.prototype.put;
  let injectionCount = 0;

  const spy = vi
    .spyOn(FakeIDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      requestKey?: IDBValidKey,
    ) {
      if (this.name === storeName && requestKey === key) {
        injectionCount += 1;
        throw error;
      }
      return requestKey === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, requestKey);
    });

  return {
    getInjectionCount: () => injectionCount,
    spy,
  };
}

function mockMigrationArchivePutFailure(error: Error) {
  const originalPut = FakeIDBObjectStore.prototype.put;
  let injectionCount = 0;

  const spy = vi
    .spyOn(FakeIDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      requestKey?: IDBValidKey,
    ) {
      if (
        injectionCount === 0 &&
        this.name === "syncQueue" &&
        typeof requestKey === "string" &&
        requestKey.startsWith(LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX)
      ) {
        injectionCount += 1;
        throw error;
      }
      return requestKey === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, requestKey);
    });

  return {
    getInjectionCount: () => injectionCount,
    spy,
  };
}

function mockNthTransactionFailure({
  requiredStores,
  mode,
  occurrence,
  failureCount = 1,
  exactStores = false,
  error,
}: {
  requiredStores: readonly StoreName[];
  mode: IDBTransactionMode;
  occurrence: number;
  failureCount?: number;
  exactStores?: boolean;
  error: Error;
}) {
  const originalTransaction = FakeIDBDatabase.prototype.transaction;
  let matchCount = 0;
  let injectionCount = 0;

  const spy = vi
    .spyOn(FakeIDBDatabase.prototype, "transaction")
    .mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      transactionMode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const requestedStores =
        typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
      if (
        transactionMode === mode &&
        requiredStores.every((storeName) =>
          requestedStores.includes(storeName),
        ) &&
        (!exactStores || requestedStores.length === requiredStores.length)
      ) {
        matchCount += 1;
        if (
          matchCount >= occurrence &&
          matchCount < occurrence + failureCount
        ) {
          injectionCount += 1;
          throw error;
        }
      }
      return originalTransaction.call(
        this,
        storeNames,
        transactionMode,
        options,
      );
    });

  return {
    getInjectionCount: () => injectionCount,
    spy,
  };
}

function mockJournalPhasePutFailure(
  phase: string,
  error: Error,
  cleanupStatus?: string,
  failureCount = 1,
) {
  const originalPut = FakeIDBObjectStore.prototype.put;
  let injectionCount = 0;

  const spy = vi
    .spyOn(FakeIDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      requestKey?: IDBValidKey,
    ) {
      const candidate =
        typeof value === "object" && value !== null
          ? (value as { phase?: unknown; cleanupStatus?: unknown })
          : null;
      if (
        injectionCount < failureCount &&
        this.name === "syncQueue" &&
        requestKey === LEGACY_MIGRATION_JOURNAL_KEY &&
        candidate?.phase === phase &&
        (cleanupStatus === undefined ||
          candidate.cleanupStatus === cleanupStatus)
      ) {
        injectionCount += 1;
        throw error;
      }
      return requestKey === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, requestKey);
    });

  return {
    getInjectionCount: () => injectionCount,
    spy,
  };
}

function mockJournalPhasePutSideEffect(phase: string, sideEffect: () => void) {
  const originalPut = FakeIDBObjectStore.prototype.put;
  let injectionCount = 0;

  const spy = vi
    .spyOn(FakeIDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      requestKey?: IDBValidKey,
    ) {
      const candidate =
        typeof value === "object" && value !== null
          ? (value as { phase?: unknown })
          : null;
      if (
        injectionCount === 0 &&
        this.name === "syncQueue" &&
        requestKey === LEGACY_MIGRATION_JOURNAL_KEY &&
        candidate?.phase === phase
      ) {
        injectionCount += 1;
        sideEffect();
      }
      return requestKey === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, requestKey);
    });

  return {
    getInjectionCount: () => injectionCount,
    spy,
  };
}

function observeUserStorePuts() {
  const originalPut = FakeIDBObjectStore.prototype.put;
  let userStorePutCount = 0;

  const spy = vi
    .spyOn(FakeIDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      requestKey?: IDBValidKey,
    ) {
      if (this.name !== "syncQueue") {
        userStorePutCount += 1;
      }
      return requestKey === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, requestKey);
    });

  return {
    getUserStorePutCount: () => userStorePutCount,
    spy,
  };
}

function getRuntimeFallbackKeys(
  storeName: StoreName,
  key = DATA_KEY,
): string[] {
  const prefix = createRuntimeFallbackPrefix(storeName, key);
  return Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).filter(
    (storageKey): storageKey is string =>
      storageKey !== null && storageKey.startsWith(prefix),
  );
}

async function resumeEventMetadataMigrationAndAssertStable({
  expectedPayload,
  legacySource,
  expectedExistingRevision,
}: {
  expectedPayload: Record<string, unknown>;
  legacySource: string;
  expectedExistingRevision?: string;
}): Promise<string> {
  vi.resetModules();
  const resumedDb = await importFreshDb();
  const resumedMigration = await resumedDb.migrateFromLocalStorage();
  expect(resumedMigration).toMatchObject({ status: "cleanup-pending" });
  expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
    expectedPayload,
  );
  const resumedRevision = await readCurrentRevision("eventMetadata");
  if (expectedExistingRevision !== undefined) {
    expect(resumedRevision).toBe(expectedExistingRevision);
  }
  expect(localStorage.getItem("eventMetadata")).toBe(legacySource);

  await resumedDb.saveEventMetadata(expectedPayload);
  const postResumeSaveRevision = await readCurrentRevision("eventMetadata");
  expect(postResumeSaveRevision).not.toBe(resumedRevision);
  expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
    expectedPayload,
  );

  vi.resetModules();
  const idempotencyDb = await importFreshDb();
  const idempotentMigration = await idempotencyDb.migrateFromLocalStorage();
  expect(idempotentMigration).toMatchObject({ status: "cleanup-pending" });
  expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
    expectedPayload,
  );
  expect(await readCurrentRevision("eventMetadata")).toBe(
    postResumeSaveRevision,
  );
  expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  return postResumeSaveRevision;
}

interface TestMigrationJournalV2 {
  kind: string;
  schemaVersion: number;
  sessionId: string;
  ownerId: string;
  phase: string;
  dataMigrationStatus: string;
  cleanupStatus: string;
  archiveKey: string;
  createdAt: string;
  updatedAt: string;
  entries: Array<{
    legacyKey: string;
    storeName: Exclude<StoreName, "syncQueue">;
    rawValue: string;
    expectedRawDigest: unknown;
    payloadDigest: unknown;
    targetRevision: string;
    mapKeys: string[];
    cleanupStatus: string;
  }>;
}

async function readMigrationJournalV2(): Promise<TestMigrationJournalV2> {
  const journal = await readRawRecord(
    "syncQueue",
    LEGACY_MIGRATION_JOURNAL_KEY,
  );
  if (
    typeof journal !== "object" ||
    journal === null ||
    !("schemaVersion" in journal) ||
    journal.schemaVersion !== 2 ||
    !("archiveKey" in journal) ||
    typeof journal.archiveKey !== "string" ||
    !("entries" in journal) ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error("Expected a migration journal v2 fixture.");
  }
  return structuredClone(journal) as TestMigrationJournalV2;
}

async function downgradeCurrentMigrationJournalToV1(
  phase: "prepared" | "copied" | "verified" | "cleanupPending" | "completed",
): Promise<{ archiveKey: string; source: string }> {
  const journal = await readMigrationJournalV2();
  const cleanupStatus =
    phase === "completed"
      ? "removed"
      : phase === "cleanupPending"
        ? "retained"
        : "pending";
  const v1Journal = {
    kind: journal.kind,
    schemaVersion: 1,
    sessionId: journal.sessionId,
    ownerId: journal.ownerId,
    phase,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    entries: journal.entries.map((entry) => ({
      legacyKey: entry.legacyKey,
      storeName: entry.storeName,
      rawValue: entry.rawValue,
      rawDigest: entry.expectedRawDigest,
      payloadDigest: entry.payloadDigest,
      targetRevision: entry.targetRevision,
      mapKeys: entry.mapKeys,
      cleanupStatus,
    })),
  };
  await deleteRawRecordAtExistingVersion("syncQueue", journal.archiveKey);
  await writeRawRecordAtExistingVersion(
    "syncQueue",
    LEGACY_MIGRATION_JOURNAL_KEY,
    v1Journal,
  );
  return {
    archiveKey: journal.archiveKey,
    source: journal.entries[0]?.rawValue ?? "",
  };
}

async function seedActualV1EventMetadataFixtureWithoutCheckpoint(): Promise<{
  payload: Record<string, unknown>;
  legacySource: string;
  targetRevision: string;
  checkpointKey: string;
}> {
  const payload = structuredClone(legacyJournalV1NoCheckpointFixture.payload);
  const legacySource = legacyJournalV1NoCheckpointFixture.legacySource;
  const targetRevision = legacyJournalV1NoCheckpointFixture.targetRevision;
  const checkpointKey = createPersistenceCheckpointKey(
    "eventMetadata",
    DATA_KEY,
  );
  expect(legacyJournalV1NoCheckpointFixture.sourceCommit).toBe(
    "d2389a02363176ba8354c4562f1a669a0b15dab9",
  );
  expect(legacyJournalV1NoCheckpointFixture.checkpointPresent).toBe(false);
  expect(JSON.stringify(payload)).toBe(legacySource);
  await expect(createPersistenceDigest(payload)).resolves.toEqual(
    legacyJournalV1NoCheckpointFixture.metadata.payloadDigest,
  );
  await expect(createPersistenceDigest(legacySource)).resolves.toEqual(
    legacyJournalV1NoCheckpointFixture.journal.entries[0]?.rawDigest,
  );
  expect(createSynchronousFingerprint(payload)).toEqual(
    legacyJournalV1NoCheckpointFixture.metadata.payloadFingerprint,
  );
  await seedDatabase(CURRENT_DATABASE_VERSION);
  await writeRawRecordAtExistingVersion("eventMetadata", DATA_KEY, payload);
  await writeRawRecordAtExistingVersion(
    "syncQueue",
    createPersistenceMetadataKey("eventMetadata", DATA_KEY),
    structuredClone(legacyJournalV1NoCheckpointFixture.metadata),
  );
  await writeRawRecordAtExistingVersion(
    "syncQueue",
    LEGACY_MIGRATION_JOURNAL_KEY,
    structuredClone(legacyJournalV1NoCheckpointFixture.journal),
  );
  localStorage.setItem("eventMetadata", legacySource);
  return { payload, legacySource, targetRevision, checkpointKey };
}

beforeEach(() => {
  databaseFactory = new IDBFactory();
  vi.stubGlobal("indexedDB", databaseFactory);
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe("db open resilience", () => {
  it("times out a blocked open with a dedicated recovery error and permits retry", async () => {
    vi.useFakeTimers();
    const pendingOpenRequest = {} as IDBOpenDBRequest;
    const openSpy = vi
      .spyOn(databaseFactory, "open")
      .mockReturnValue(pendingOpenRequest);
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await importFreshDb();

    const migrationPromise = db.migrateFromLocalStorage();
    expect(openSpy).toHaveBeenCalledTimes(1);
    if (typeof pendingOpenRequest.onblocked !== "function") {
      throw new Error("Expected the blocked-open handler to be installed.");
    }
    pendingOpenRequest.onblocked.call(
      pendingOpenRequest,
      new Event("blocked") as IDBVersionChangeEvent,
    );
    let settled = false;
    void migrationPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const migration = await migrationPromise;

    expect(migration).toMatchObject({
      status: "recovery-required",
      dataMigrationStatus: "recovery-required",
      cleanupStatus: "recovery-required",
    });
    if (migration.status !== "recovery-required") {
      throw new Error("Expected blocked-open recovery.");
    }
    expect(migration.recoveryBundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "migration",
          code: "IndexedDBOpenBlocked",
        }),
      ]),
    );
    expect(warningSpy).toHaveBeenCalledWith(
      "IndexedDB open request is blocked by another tab.",
    );

    openSpy.mockRestore();
    vi.useRealTimers();
    await expect(db.migrateFromLocalStorage()).resolves.toEqual({
      status: "not-needed",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "not-needed",
    });
  });
});

describe("db payload compatibility", () => {
  it("round-trips optional object properties whose value is undefined", async () => {
    const eventLists = {
      undefined互換イベント: [
        {
          id: "optional-url-item",
          title: "URL未設定",
          url: undefined,
        },
      ],
    };
    const db = await importFreshDb();

    await db.saveEventLists(eventLists);
    const loaded = await db.loadEventLists();

    expect(loaded).toMatchObject({ status: "ok", data: eventLists });
    expect(
      Object.prototype.hasOwnProperty.call(
        loaded.data?.undefined互換イベント?.[0],
        "url",
      ),
    ).toBe(true);
    expect(
      await readRawRecord(
        "syncQueue",
        createPersistenceMetadataKey("eventLists", DATA_KEY),
      ),
    ).toMatchObject({
      storeName: "eventLists",
      key: DATA_KEY,
    });
  });

  it("loads metadata-less IndexedDB data containing an undefined property", async () => {
    const legacyEventLists = {
      旧undefined互換イベント: [
        {
          id: "legacy-optional-url-item",
          title: "旧URL未設定",
          url: undefined,
        },
      ],
    };
    await seedDatabase(CURRENT_DATABASE_VERSION);
    await writeRawRecordAtExistingVersion(
      "eventLists",
      DATA_KEY,
      legacyEventLists,
    );
    const db = await importFreshDb();

    const loaded = await db.loadEventLists();

    expect(loaded).toMatchObject({ status: "ok", data: legacyEventLists });
    expect(
      Object.prototype.hasOwnProperty.call(
        loaded.data?.旧undefined互換イベント?.[0],
        "url",
      ),
    ).toBe(true);
  });
});

describe("Release A persistence metric integration", () => {
  it("records every public mapData load outcome exactly once", async () => {
    const eventName = "metricsマップイベント";
    const dayMapName = "1日目";
    const mapData = {
      [eventName]: {
        [dayMapName]: makeDayMap("metrics"),
      },
    };
    const db = await importFreshDb();
    const metrics = await import("./persistenceReleaseAMetrics");
    metrics.resetPersistenceReleaseAMetrics();

    await expect(db.loadMapData()).resolves.toMatchObject({
      status: "missing",
    });
    await db.saveMapData(mapData);
    await expect(db.loadMapData()).resolves.toMatchObject({
      status: "ok",
      data: mapData,
    });

    await writeRawRecordAtExistingVersion(
      "mapData",
      createSplitMapKey(eventName, dayMapName),
      makeDayMap("metrics-conflict"),
    );
    await expect(db.loadMapData()).resolves.toMatchObject({
      status: "conflict",
    });

    const readFailure = mockNthTransactionFailure({
      requiredStores: ["mapData", "syncQueue"],
      mode: "readonly",
      occurrence: 1,
      failureCount: 2,
      exactStores: true,
      error: new DOMException(
        "forced map metrics read failure",
        "UnknownError",
      ),
    });
    await expect(db.loadMapData()).resolves.toMatchObject({
      status: "error",
    });

    expect(readFailure.getInjectionCount()).toBe(2);
    const snapshot = metrics.getPersistenceReleaseAMetricsSnapshot();
    expect(snapshot.counters.load).toEqual({
      succeeded: 1,
      missing: 1,
      failed: 1,
      conflict: 1,
    });
    expect(
      metrics.calculatePersistenceReleaseARates(snapshot).conflictRate,
    ).toBe(0.25);
  });

  it("records an early checkpoint validation conflict without classifying payload conflicts as checkpoint conflicts", async () => {
    const metadata = {
      metricsCheckpointイベント: { generation: "committed" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(metadata);
    const metrics = await import("./persistenceReleaseAMetrics");
    metrics.resetPersistenceReleaseAMetrics();
    const checkpointKey = createPersistenceCheckpointKey(
      "eventMetadata",
      DATA_KEY,
    );
    const checkpoint = await readRawRecord("syncQueue", checkpointKey);
    await writeRawRecordAtExistingVersion("syncQueue", checkpointKey, {
      corrupted: true,
    });

    await expect(db.loadEventMetadata()).resolves.toMatchObject({
      status: "conflict",
    });
    expect(
      metrics.getPersistenceReleaseAMetricsSnapshot().counters,
    ).toMatchObject({
      checkpointAdoption: { conflict: 1 },
      load: { conflict: 1 },
    });

    await writeRawRecordAtExistingVersion(
      "syncQueue",
      checkpointKey,
      checkpoint,
    );
    await writeRawRecordAtExistingVersion("eventMetadata", DATA_KEY, {
      metricsCheckpointイベント: { generation: "payload-conflict" },
    });
    await expect(db.loadEventMetadata()).resolves.toMatchObject({
      status: "conflict",
    });

    expect(
      metrics.getPersistenceReleaseAMetricsSnapshot().counters,
    ).toMatchObject({
      checkpointAdoption: { conflict: 1 },
      load: { conflict: 2 },
    });
  });
});

describe("db.migrateFromLocalStorage resilience", () => {
  it("reports separate not-needed data and cleanup statuses", async () => {
    const db = await importFreshDb();

    await expect(db.migrateFromLocalStorage()).resolves.toEqual({
      status: "not-needed",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "not-needed",
    });
  });

  it("migrates metadata and viewport settings when eventShoppingLists is absent", async () => {
    const metadata = {
      移行対象イベント: {
        title: "メタデータだけ存在",
      },
    };
    const viewportSettings = {
      移行対象イベント: {
        "1日目": {
          scale: 1.25,
          scrollLeft: 120,
          scrollTop: 80,
        },
      },
    };
    const metadataSource = JSON.stringify(metadata);
    const viewportSource = JSON.stringify(viewportSettings);
    localStorage.setItem("eventMetadata", metadataSource);
    localStorage.setItem("mapViewportSettings", viewportSource);
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({ status: "cleanup-pending" });
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: metadata,
    });
    expect(await db.loadMapViewportSettings()).toMatchObject({
      status: "ok",
      data: viewportSettings,
    });
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(localStorage.getItem("mapViewportSettings")).toBe(viewportSource);
  });

  it("keeps every legacy source and rolls back all user records when one source is malformed", async () => {
    const legacySources = {
      eventShoppingLists: JSON.stringify({
        移行失敗イベント: [{ id: "legacy-item", title: "原本" }],
      }),
      eventMetadata: JSON.stringify({
        移行失敗イベント: { title: "書き込まれてはいけない" },
      }),
      mapViewportSettings: '{"移行失敗イベント":',
    };
    Object.entries(legacySources).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });
    const putObserver = observeUserStorePuts();
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({
      status: "recovery-required",
      dataMigrationStatus: "recovery-required",
      cleanupStatus: "recovery-required",
    });
    expect(putObserver.getUserStorePutCount()).toBe(0);
    Object.entries(legacySources).forEach(([key, value]) => {
      expect(localStorage.getItem(key)).toBe(value);
    });
    await expect(
      Promise.all([
        readRawRecord("eventLists", DATA_KEY),
        readRawRecord("eventMetadata", DATA_KEY),
        readRawRecord("mapViewportSettings", DATA_KEY),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("requires recovery before migration writes when a newer runtime candidate overlaps the legacy source", async () => {
    const idbAndLegacyValue = {
      交差回帰イベント: { generation: "idb-and-legacy" },
    };
    const runtimeValue = {
      交差回帰イベント: { generation: "newer-runtime-fallback" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbAndLegacyValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const legacySource = JSON.stringify(idbAndLegacyValue);
    localStorage.setItem("eventMetadata", legacySource);
    const runtimeCandidate = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "migration-overlap-runtime-candidate",
      baseRevision,
      payload: runtimeValue,
    });

    vi.resetModules();
    const migratingDb = await importFreshDb();
    const putObserver = observeUserStorePuts();
    const migration = await migratingDb.migrateFromLocalStorage();

    expect(migration).toMatchObject({
      status: "recovery-required",
      dataMigrationStatus: "recovery-required",
      cleanupStatus: "recovery-required",
    });
    if (migration.status !== "recovery-required") {
      throw new Error("Expected migration recovery to be required.");
    }
    expect(migration.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "legacy-localStorage",
          storeName: "eventMetadata",
        }),
        expect.objectContaining({
          source: "runtime-fallback",
          revision: runtimeCandidate.candidate.revision,
        }),
      ]),
    });
    expect(putObserver.getUserStorePutCount()).toBe(0);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      idbAndLegacyValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
    expect(localStorage.getItem(runtimeCandidate.storageKey)).toBe(
      runtimeCandidate.serialized,
    );
  });

  it("rolls back every payload and revision record when one atomic copy put throws synchronously", async () => {
    const legacySources = {
      eventShoppingLists: JSON.stringify({
        同期例外イベント: [{ id: "atomic-item", title: "保持対象" }],
      }),
      eventMetadata: JSON.stringify({
        同期例外イベント: { title: "transaction全体を戻す" },
      }),
    };
    Object.entries(legacySources).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });
    const putError = new DOMException(
      "forced migration clone failure",
      "DataCloneError",
    );
    const putFailure = mockSynchronousStorePutFailure(
      "eventMetadata",
      DATA_KEY,
      putError,
    );
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({ status: "recovery-required" });
    expect(putFailure.getInjectionCount()).toBe(1);
    Object.entries(legacySources).forEach(([key, value]) => {
      expect(localStorage.getItem(key)).toBe(value);
    });
    await expect(
      Promise.all([
        readRawRecord("eventLists", DATA_KEY),
        readRawRecord("eventMetadata", DATA_KEY),
        readRawRecord(
          "syncQueue",
          createPersistenceMetadataKey("eventLists", DATA_KEY),
        ),
        readRawRecord(
          "syncQueue",
          createPersistenceMetadataKey("eventMetadata", DATA_KEY),
        ),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined, undefined]);
  });

  it("resumes idempotently from a prepared migration journal", async () => {
    const metadata = {
      prepared再開イベント: { phase: "prepared" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const copyFailure = mockNthTransactionFailure({
      requiredStores: ["eventMetadata", "syncQueue"],
      mode: "readwrite",
      occurrence: 1,
      error: new DOMException("forced copy start failure", "UnknownError"),
    });
    const db = await importFreshDb();

    const failedMigration = await db.migrateFromLocalStorage();

    expect(failedMigration).toMatchObject({ status: "recovery-required" });
    expect(copyFailure.getInjectionCount()).toBe(1);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "prepared" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toBeUndefined();
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
    copyFailure.spy.mockRestore();

    await resumeEventMetadataMigrationAndAssertStable({
      expectedPayload: metadata,
      legacySource,
    });
  });

  it("resumes idempotently from a copied migration journal", async () => {
    const metadata = {
      copied再開イベント: { phase: "copied" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const verificationFailure = mockNthTransactionFailure({
      requiredStores: ["eventMetadata", "syncQueue"],
      mode: "readonly",
      occurrence: 2,
      failureCount: 2,
      exactStores: true,
      error: new DOMException(
        "forced verification read failure",
        "UnknownError",
      ),
    });
    const db = await importFreshDb();

    const failedMigration = await db.migrateFromLocalStorage();

    expect(failedMigration).toMatchObject({ status: "recovery-required" });
    expect(verificationFailure.getInjectionCount()).toBe(2);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "copied" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    const copiedRevision = await readCurrentRevision("eventMetadata");
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
    verificationFailure.spy.mockRestore();

    await resumeEventMetadataMigrationAndAssertStable({
      expectedPayload: metadata,
      legacySource,
      expectedExistingRevision: copiedRevision,
    });
  });

  it("saves immediately after resuming a verified journal without a prior load", async () => {
    const migratedMetadata = {
      verified即時保存イベント: { phase: "verified" },
    };
    const savedImmediately = {
      verified即時保存イベント: { phase: "saved-after-resume" },
    };
    const legacySource = JSON.stringify(migratedMetadata);
    localStorage.setItem("eventMetadata", legacySource);
    const cleanupReadyFailure = mockJournalPhasePutFailure(
      "cleanup-ready",
      new DOMException(
        "forced verified immediate-save fixture",
        "UnknownError",
      ),
      undefined,
      Number.POSITIVE_INFINITY,
    );
    const initialDb = await importFreshDb();
    await expect(initialDb.migrateFromLocalStorage()).resolves.toMatchObject({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
    });
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "verified" });
    const migratedRevision = await readCurrentRevision("eventMetadata");

    vi.resetModules();
    const resumedDb = await importFreshDb();
    await expect(resumedDb.migrateFromLocalStorage()).resolves.toMatchObject({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
    });
    await expect(
      resumedDb.saveEventMetadata(savedImmediately),
    ).resolves.toBeUndefined();

    const savedRevision = await readCurrentRevision("eventMetadata");
    expect(savedRevision).not.toBe(migratedRevision);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      savedImmediately,
    );
    expect(
      await readRawRecord(
        "syncQueue",
        createPersistenceCheckpointKey("eventMetadata", DATA_KEY),
      ),
    ).toMatchObject({
      committedRoot: {
        revision: savedRevision,
        baseRevision: migratedRevision,
      },
    });
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "verified" });
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
    expect(cleanupReadyFailure.getInjectionCount()).toBeGreaterThanOrEqual(2);
  });

  it.each(["copied", "verified"] as const)(
    "saves mapData immediately after resuming a %s journal without a prior load",
    async (resumePhase) => {
      const eventName = `map-${resumePhase}-再開イベント`;
      const dayOne = "1日目マップ";
      const dayTwo = "2日目マップ";
      const legacyMapData: MapDataStore = {
        [eventName]: {
          [dayOne]: makeDayMap(`${resumePhase}-migrated-1`),
          [dayTwo]: makeDayMap(`${resumePhase}-migrated-2`),
        },
        [`map-${resumePhase}-空イベント`]: {},
      };
      const normalizedMigratedMapData: MapDataStore = {
        [eventName]: legacyMapData[eventName],
      };
      const savedImmediately: MapDataStore = {
        [eventName]: {
          [dayOne]: makeDayMap(`${resumePhase}-saved-1`),
          [dayTwo]: legacyMapData[eventName][dayTwo],
        },
      };
      const legacySource = JSON.stringify(legacyMapData);
      localStorage.setItem("mapData", legacySource);
      const failure =
        resumePhase === "copied"
          ? mockNthTransactionFailure({
              requiredStores: ["mapData", "syncQueue"],
              mode: "readonly",
              occurrence: 2,
              failureCount: 2,
              exactStores: true,
              error: new DOMException(
                "forced copied map verification fixture",
                "UnknownError",
              ),
            })
          : mockJournalPhasePutFailure(
              "cleanup-ready",
              new DOMException(
                "forced verified map journal fixture",
                "UnknownError",
              ),
            );
      const initialDb = await importFreshDb();
      await expect(initialDb.migrateFromLocalStorage()).resolves.toMatchObject({
        status:
          resumePhase === "copied" ? "recovery-required" : "cleanup-pending",
      });
      expect(
        await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
      ).toMatchObject({ phase: resumePhase });
      failure.spy.mockRestore();
      const migratedRevision = await readCurrentRevision("mapData");

      vi.resetModules();
      const resumedDb = await importFreshDb();
      await expect(resumedDb.migrateFromLocalStorage()).resolves.toMatchObject({
        status: "cleanup-pending",
        dataMigrationStatus: "verified",
      });
      await expect(
        resumedDb.saveMapDataChanges(
          normalizedMigratedMapData,
          savedImmediately,
        ),
      ).resolves.toBeUndefined();

      const savedRevision = await readCurrentRevision("mapData");
      expect(savedRevision).not.toBe(migratedRevision);
      expect(await readRawRecord("mapData", DATA_KEY)).toBeUndefined();
      expect(
        await readRawRecord("mapData", createSplitMapKey(eventName, dayOne)),
      ).toEqual(savedImmediately[eventName][dayOne]);
      expect(
        await readRawRecord("mapData", createSplitMapKey(eventName, dayTwo)),
      ).toEqual(savedImmediately[eventName][dayTwo]);
      expect(
        await readRawRecord(
          "syncQueue",
          createPersistenceCheckpointKey("mapData", DATA_KEY),
        ),
      ).toMatchObject({
        committedRoot: {
          revision: savedRevision,
          baseRevision: migratedRevision,
        },
      });
      expect(await resumedDb.loadMapData()).toMatchObject({
        status: "ok",
        data: savedImmediately,
      });
      expect(getRuntimeFallbackKeys("mapData")).toEqual([]);
      expect(localStorage.getItem("mapData")).toBe(legacySource);
    },
  );

  it("keeps a newer normal save available while cleanup-ready journal writes keep failing", async () => {
    const migratedMetadata = {
      verified再開イベント: { phase: "verified" },
    };
    const newerMetadata = {
      verified再開イベント: { phase: "newer-normal-save" },
    };
    const legacySource = JSON.stringify(migratedMetadata);
    localStorage.setItem("eventMetadata", legacySource);
    const cleanupReadyFailure = mockJournalPhasePutFailure(
      "cleanup-ready",
      new DOMException("forced cleanup-ready journal failure", "UnknownError"),
      undefined,
      Number.POSITIVE_INFINITY,
    );
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      migratedKeys: ["eventMetadata"],
    });
    expect(cleanupReadyFailure.getInjectionCount()).toBe(1);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "verified" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      migratedMetadata,
    );
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);

    await db.saveEventMetadata(newerMetadata);
    const newerRevision = await readCurrentRevision("eventMetadata");
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      newerMetadata,
    );

    vi.resetModules();
    const resumedDb = await importFreshDb();
    await expect(resumedDb.migrateFromLocalStorage()).resolves.toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      migratedKeys: ["eventMetadata"],
    });
    expect(cleanupReadyFailure.getInjectionCount()).toBe(2);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "verified" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      newerMetadata,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(newerRevision);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);

    vi.resetModules();
    const retriedDb = await importFreshDb();
    await expect(retriedDb.migrateFromLocalStorage()).resolves.toMatchObject({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
    });
    expect(cleanupReadyFailure.getInjectionCount()).toBe(3);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      newerMetadata,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(newerRevision);
  });

  it("keeps fresh and resumed verified data available when deferred journal writes fail", async () => {
    const metadata = {
      deferred書込失敗イベント: { phase: "cleanup-ready" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const deferredFailure = mockJournalPhasePutFailure(
      "cleanup-ready",
      new DOMException("forced deferred journal failure", "UnknownError"),
      "deferred",
    );
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      migratedKeys: ["eventMetadata"],
    });
    expect(deferredFailure.getInjectionCount()).toBe(1);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanup-ready",
      dataMigrationStatus: "verified",
      cleanupStatus: "ready",
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    const verifiedRevision = await readCurrentRevision("eventMetadata");
    deferredFailure.spy.mockRestore();

    vi.resetModules();
    const resumedFailure = mockJournalPhasePutFailure(
      "cleanup-ready",
      new DOMException(
        "forced resumed deferred journal failure",
        "UnknownError",
      ),
      "deferred",
    );
    const resumedDb = await importFreshDb();
    const resumed = await resumedDb.migrateFromLocalStorage();

    expect(resumed).toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      migratedKeys: ["eventMetadata"],
    });
    expect(resumedFailure.getInjectionCount()).toBe(1);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(await readCurrentRevision("eventMetadata")).toBe(verifiedRevision);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  });

  it("retains every verified legacy source when explicit cleanup is requested", async () => {
    const eventLists = {
      cleanup保持イベント: [{ id: "cleanup-item", title: "保持する原本" }],
    };
    const metadata = {
      cleanup保持イベント: { title: "別タブ更新を誤削除しない原本" },
    };
    const listSource = JSON.stringify(eventLists);
    const metadataSource = JSON.stringify(metadata);
    localStorage.setItem("eventShoppingLists", listSource);
    localStorage.setItem("eventMetadata", metadataSource);
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");
    const db = await importFreshDb();

    const retainedMigration = await db.migrateFromLocalStorage({
      cleanupLegacySources: true,
    });

    expect(retainedMigration).toMatchObject({ status: "cleanup-pending" });
    expect(removeItemSpy).not.toHaveBeenCalledWith("eventShoppingLists");
    expect(removeItemSpy).not.toHaveBeenCalledWith("eventMetadata");
    expect(localStorage.getItem("eventShoppingLists")).toBe(listSource);
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(await readRawRecord("eventLists", DATA_KEY)).toEqual(eventLists);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    const listRevision = await readCurrentRevision("eventLists");
    const metadataRevision = await readCurrentRevision("eventMetadata");
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      schemaVersion: 2,
      phase: "cleanup-ready",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventShoppingLists",
          cleanupStatus: "deferred",
          expectedRawDigest: expect.objectContaining({
            value: expect.any(String),
          }),
        }),
        expect.objectContaining({
          legacyKey: "eventMetadata",
          cleanupStatus: "deferred",
          expectedRawDigest: expect.objectContaining({
            value: expect.any(String),
          }),
        }),
      ]),
    });

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const resumedMigration = await resumedDb.migrateFromLocalStorage({
      cleanupLegacySources: true,
    });

    expect(resumedMigration).toMatchObject({ status: "cleanup-pending" });
    expect(localStorage.getItem("eventShoppingLists")).toBe(listSource);
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(await readRawRecord("eventLists", DATA_KEY)).toEqual(eventLists);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(await readCurrentRevision("eventLists")).toBe(listRevision);
    expect(await readCurrentRevision("eventMetadata")).toBe(metadataRevision);

    vi.resetModules();
    const idempotencyDb = await importFreshDb();
    expect(
      await idempotencyDb.migrateFromLocalStorage({
        cleanupLegacySources: true,
      }),
    ).toMatchObject({ status: "cleanup-pending" });
    expect(removeItemSpy).not.toHaveBeenCalledWith("eventShoppingLists");
    expect(removeItemSpy).not.toHaveBeenCalledWith("eventMetadata");
    expect(await readCurrentRevision("eventLists")).toBe(listRevision);
    expect(await readCurrentRevision("eventMetadata")).toBe(metadataRevision);
  });

  it("safely resumes a coordinator journal after partial cleanup", async () => {
    const eventLists = {
      旧cleanup再開イベント: [{ id: "older-cleanup-item" }],
    };
    const metadata = {
      旧cleanup再開イベント: { generation: "verified-source" },
    };
    const listSource = JSON.stringify(eventLists);
    const metadataSource = JSON.stringify(metadata);
    localStorage.setItem("eventShoppingLists", listSource);
    localStorage.setItem("eventMetadata", metadataSource);
    const db = await importFreshDb();
    expect(await db.migrateFromLocalStorage()).toMatchObject({
      status: "cleanup-pending",
    });
    const listRevision = await readCurrentRevision("eventLists");
    const metadataRevision = await readCurrentRevision("eventMetadata");
    const retainedJournal = await readMigrationJournalV2();
    retainedJournal.cleanupStatus = "ready";
    retainedJournal.entries = retainedJournal.entries.map((entry) => ({
      ...entry,
      cleanupStatus:
        entry.legacyKey === "eventShoppingLists" ? "removed" : "pending",
    }));
    localStorage.removeItem("eventShoppingLists");
    await writeRawRecordAtExistingVersion(
      "syncQueue",
      LEGACY_MIGRATION_JOURNAL_KEY,
      retainedJournal,
    );
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    vi.resetModules();
    const resumedDb = await importFreshDb();
    expect(
      await resumedDb.migrateFromLocalStorage({
        cleanupLegacySources: true,
      }),
    ).toMatchObject({ status: "cleanup-pending" });

    expect(removeItemSpy).not.toHaveBeenCalledWith("eventMetadata");
    expect(localStorage.getItem("eventShoppingLists")).toBeNull();
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "deferred",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventShoppingLists",
          cleanupStatus: "removed",
        }),
        expect.objectContaining({
          legacyKey: "eventMetadata",
          cleanupStatus: "deferred",
        }),
      ]),
    });
    expect(await readCurrentRevision("eventLists")).toBe(listRevision);
    expect(await readCurrentRevision("eventMetadata")).toBe(metadataRevision);
    removeItemSpy.mockRestore();

    const partiallyRetainedJournal = structuredClone(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ) as typeof retainedJournal;
    partiallyRetainedJournal.phase = "cleanup-in-progress";
    partiallyRetainedJournal.cleanupStatus = "in-progress";
    partiallyRetainedJournal.entries = partiallyRetainedJournal.entries.map(
      (entry) => ({ ...entry, cleanupStatus: "removed" }),
    );
    localStorage.removeItem("eventMetadata");
    await writeRawRecordAtExistingVersion(
      "syncQueue",
      LEGACY_MIGRATION_JOURNAL_KEY,
      partiallyRetainedJournal,
    );

    vi.resetModules();
    const compatibilityDb = await importFreshDb();
    expect(await compatibilityDb.migrateFromLocalStorage()).toMatchObject({
      status: "completed",
    });
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "completed" });
    expect(await readCurrentRevision("eventLists")).toBe(listRevision);
    expect(await readCurrentRevision("eventMetadata")).toBe(metadataRevision);
  });

  it("detects a source update during pending-to-deferred journal recovery", async () => {
    const capturedMetadata = {
      旧journal競合イベント: { generation: "captured-source" },
    };
    const currentMetadata = {
      旧journal競合イベント: { generation: "concurrent-current-source" },
    };
    const capturedSource = JSON.stringify(capturedMetadata);
    const currentSource = JSON.stringify(currentMetadata);
    localStorage.setItem("eventMetadata", capturedSource);
    const db = await importFreshDb();
    expect(await db.migrateFromLocalStorage()).toMatchObject({
      status: "cleanup-pending",
    });
    const pendingJournal = await readMigrationJournalV2();
    pendingJournal.cleanupStatus = "ready";
    pendingJournal.entries = pendingJournal.entries.map((entry) => ({
      ...entry,
      cleanupStatus: "pending",
    }));
    await writeRawRecordAtExistingVersion(
      "syncQueue",
      LEGACY_MIGRATION_JOURNAL_KEY,
      pendingJournal,
    );
    const sourceChange = mockJournalPhasePutSideEffect("cleanup-ready", () => {
      localStorage.setItem("eventMetadata", currentSource);
    });

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const migration = await resumedDb.migrateFromLocalStorage();

    expect(sourceChange.getInjectionCount()).toBe(1);
    expect(migration).toMatchObject({ status: "recovery-required" });
    if (migration.status !== "recovery-required") {
      throw new Error(
        "Expected pending journal recovery to detect the update.",
      );
    }
    expect(migration.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "legacy-localStorage",
          rawValue: capturedSource,
        }),
        expect.objectContaining({
          source: "legacy-localStorage",
          rawValue: currentSource,
        }),
      ]),
    });
    expect(localStorage.getItem("eventMetadata")).toBe(currentSource);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      capturedMetadata,
    );
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "deferred",
      entries: [expect.objectContaining({ cleanupStatus: "deferred" })],
    });
  });

  it("detects a legacy source change during cleanup-ready CAS and preserves the current raw value", async () => {
    const capturedMetadata = {
      TOCTOUイベント: { generation: "captured-source" },
    };
    const currentMetadata = {
      TOCTOUイベント: { generation: "concurrent-current-source" },
    };
    const capturedSource = JSON.stringify(capturedMetadata);
    const currentSource = JSON.stringify(currentMetadata);
    localStorage.setItem("eventMetadata", capturedSource);
    const sourceChange = mockJournalPhasePutSideEffect("cleanup-ready", () => {
      localStorage.setItem("eventMetadata", currentSource);
    });
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage({
      cleanupLegacySources: true,
    });

    expect(sourceChange.getInjectionCount()).toBe(1);
    expect(migration).toMatchObject({ status: "recovery-required" });
    if (migration.status !== "recovery-required") {
      throw new Error("Expected TOCTOU recovery to be required.");
    }
    expect(migration.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "legacy-localStorage",
          rawValue: capturedSource,
        }),
        expect.objectContaining({
          source: "legacy-localStorage",
          rawValue: currentSource,
        }),
      ]),
    });
    expect(localStorage.getItem("eventMetadata")).toBe(currentSource);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      capturedMetadata,
    );
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "ready",
    });
  });

  it("fills missing split map entries when the existing IDB entries match the legacy subset", async () => {
    const eventName = "部分移行補完イベント";
    const existingDayName = "既存日マップ";
    const missingDayName = "不足日マップ";
    const existingDayMap = makeDayMap("一致");
    const missingDayMap = makeDayMap("補完");
    const idbSubset = {
      [eventName]: {
        [existingDayName]: existingDayMap,
      },
    };
    const completeLegacyMap = {
      [eventName]: {
        [existingDayName]: existingDayMap,
        [missingDayName]: missingDayMap,
      },
    };
    const db = await importFreshDb();
    await db.saveMapData(idbSubset);
    const existingKey = createSplitMapKey(eventName, existingDayName);
    const missingKey = createSplitMapKey(eventName, missingDayName);
    const existingBeforeMigration = await readRawRecord("mapData", existingKey);
    const legacySource = JSON.stringify(completeLegacyMap);
    localStorage.setItem("mapData", legacySource);

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({ status: "cleanup-pending" });
    expect(await readRawRecord("mapData", existingKey)).toEqual(
      existingBeforeMigration,
    );
    expect(await readRawRecord("mapData", missingKey)).toMatchObject(
      missingDayMap,
    );
    const loadedMap = await db.loadMapData();
    expect(loadedMap.status).toBe("ok");
    expect(loadedMap.data).toEqual(completeLegacyMap);
    expect(localStorage.getItem("mapData")).toBe(legacySource);
  });

  it("normalizes an empty legacy map event to the same logical and physical form as an empty map", async () => {
    const legacyMap = { 空イベント: {} };
    const legacySource = JSON.stringify(legacyMap);
    localStorage.setItem("mapData", legacySource);
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
    });
    expect(await db.loadMapData()).toMatchObject({
      status: "missing",
      data: null,
    });
    expect(await db.getAllKeys("mapData")).toEqual([]);
    expect(localStorage.getItem("mapData")).toBe(legacySource);
  });

  it("requires recovery without changing either side when one existing split map entry conflicts", async () => {
    const eventName = "部分移行競合イベント";
    const conflictingDayName = "競合日マップ";
    const missingDayName = "未書込日マップ";
    const idbMap = {
      [eventName]: {
        [conflictingDayName]: makeDayMap("IDB側"),
      },
    };
    const legacyMap = {
      [eventName]: {
        [conflictingDayName]: makeDayMap("legacy側"),
        [missingDayName]: makeDayMap("書込禁止"),
      },
    };
    const db = await importFreshDb();
    await db.saveMapData(idbMap);
    const idbRevision = await readCurrentRevision("mapData");
    const conflictingKey = createSplitMapKey(eventName, conflictingDayName);
    const missingKey = createSplitMapKey(eventName, missingDayName);
    const idbSource = await readRawRecord("mapData", conflictingKey);
    const metadataKey = createPersistenceMetadataKey("mapData", DATA_KEY);
    const metadataSource = await readRawRecord("syncQueue", metadataKey);
    const legacySource = JSON.stringify(legacyMap);
    localStorage.setItem("mapData", legacySource);

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({ status: "recovery-required" });
    expect(localStorage.getItem("mapData")).toBe(legacySource);
    expect(await readRawRecord("mapData", conflictingKey)).toEqual(idbSource);
    expect(await readRawRecord("mapData", missingKey)).toBeUndefined();
    expect(await readRawRecord("syncQueue", metadataKey)).toEqual(
      metadataSource,
    );
    if (migration.status !== "recovery-required") {
      throw new Error("Expected map migration recovery.");
    }
    const idbCandidate = migration.recoveryBundle.candidates.find(
      ({ source, role, storeName }) =>
        source === "indexedDB" &&
        role === "app-payload" &&
        storeName === "mapData",
    );
    expect(idbCandidate).toMatchObject({
      adoptable: true,
      revision: idbRevision,
      payload: idbMap,
    });
    const loadedMap = await db.loadMapData();
    expect(loadedMap.status).toBe("ok");
    expect(loadedMap.data).toEqual(idbMap);
  });

  it("offers the current committed IndexedDB payload for explicit adoption when legacy data conflicts", async () => {
    const idbMetadata = {
      明示採用移行イベント: { generation: "indexed-db" },
    };
    const legacyMetadata = {
      明示採用移行イベント: { generation: "legacy" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbMetadata);
    const idbRevision = await readCurrentRevision("eventMetadata");
    const legacySource = JSON.stringify(legacyMetadata);
    localStorage.setItem("eventMetadata", legacySource);

    const migration = await db.migrateFromLocalStorage();

    expect(migration.status).toBe("recovery-required");
    if (migration.status !== "recovery-required") {
      throw new Error("Expected metadata migration recovery.");
    }
    const idbCandidate = migration.recoveryBundle.candidates.find(
      ({ source, role, storeName }) =>
        source === "indexedDB" &&
        role === "app-payload" &&
        storeName === "eventMetadata",
    );
    if (!idbCandidate) {
      throw new Error("Missing current IndexedDB migration candidate.");
    }
    expect(idbCandidate).toMatchObject({
      adoptable: true,
      revision: idbRevision,
      payload: idbMetadata,
      targetKey: DATA_KEY,
    });
    expect(migration.recoveryBundle.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "legacy-localStorage",
          storeName: "eventMetadata",
          rawValue: legacySource,
          adoptable: false,
        }),
      ]),
    );

    await expect(
      db.adoptRecoveryCandidate(idbCandidate),
    ).resolves.toMatchObject({
      status: "adopted",
      storeName: "eventMetadata",
      key: DATA_KEY,
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(idbMetadata);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  });

  it("preserves validation recovery candidates through a legacy migration failure", async () => {
    const metadata = {
      checkpoint候補伝搬イベント: { generation: "committed" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(metadata);
    const revision = await readCurrentRevision("eventMetadata");
    const checkpointKey = createPersistenceCheckpointKey(
      "eventMetadata",
      DATA_KEY,
    );
    await writeRawRecordAtExistingVersion("syncQueue", checkpointKey, {
      corrupted: true,
    });
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);

    const migration = await db.migrateFromLocalStorage();

    expect(migration.status).toBe("recovery-required");
    if (migration.status !== "recovery-required") {
      throw new Error("Expected checkpoint migration recovery.");
    }
    const payloadCandidate = migration.recoveryBundle.candidates.find(
      ({ source, role, storeName }) =>
        source === "indexedDB" &&
        role === "app-payload" &&
        storeName === "eventMetadata",
    );
    if (!payloadCandidate) {
      throw new Error("Missing propagated IndexedDB payload candidate.");
    }
    expect(payloadCandidate).toMatchObject({
      adoptable: true,
      revision,
      payload: metadata,
    });
    expect(migration.recoveryBundle.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "indexedDB",
          role: "persistence-checkpoint",
          sourceKey: checkpointKey,
          adoptable: false,
          payload: { corrupted: true },
        }),
      ]),
    );

    await db.adoptRecoveryCandidate(payloadCandidate);
    await expect(db.migrateFromLocalStorage()).resolves.toMatchObject({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  });

  it("defaults a verified migration to cleanup-pending and retains its exact sources", async () => {
    const eventLists = {
      後片付け待ちイベント: [
        { id: "cleanup-pending-item", title: "移行済み原本" },
      ],
    };
    const metadata = {
      後片付け待ちイベント: { title: "原本を既定では削除しない" },
    };
    const listSource = JSON.stringify(eventLists);
    const metadataSource = JSON.stringify(metadata);
    localStorage.setItem("eventShoppingLists", listSource);
    localStorage.setItem("eventMetadata", metadataSource);
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({ status: "cleanup-pending" });
    expect(await readRawRecord("eventLists", DATA_KEY)).toEqual(eventLists);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(localStorage.getItem("eventShoppingLists")).toBe(listSource);
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
  });

  it("repeats cleanup-pending idempotently without changing payloads or revisions", async () => {
    const eventLists = {
      冪等移行イベント: [{ id: "idempotent-item", title: "同一原本" }],
    };
    const metadata = {
      冪等移行イベント: { title: "revisionを増やさない" },
    };
    const listSource = JSON.stringify(eventLists);
    const metadataSource = JSON.stringify(metadata);
    localStorage.setItem("eventShoppingLists", listSource);
    localStorage.setItem("eventMetadata", metadataSource);
    const db = await importFreshDb();

    const firstMigration = await db.migrateFromLocalStorage();
    expect(firstMigration).toMatchObject({ status: "cleanup-pending" });
    const firstSnapshot = {
      eventLists: await readRawRecord("eventLists", DATA_KEY),
      eventMetadata: await readRawRecord("eventMetadata", DATA_KEY),
      eventListsRevision: await readCurrentRevision("eventLists"),
      eventMetadataRevision: await readCurrentRevision("eventMetadata"),
    };

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const secondMigration = await resumedDb.migrateFromLocalStorage();

    expect(secondMigration).toMatchObject({ status: "cleanup-pending" });
    await expect(
      Promise.all([
        readRawRecord("eventLists", DATA_KEY),
        readRawRecord("eventMetadata", DATA_KEY),
        readCurrentRevision("eventLists"),
        readCurrentRevision("eventMetadata"),
      ]),
    ).resolves.toEqual([
      firstSnapshot.eventLists,
      firstSnapshot.eventMetadata,
      firstSnapshot.eventListsRevision,
      firstSnapshot.eventMetadataRevision,
    ]);
    expect(localStorage.getItem("eventShoppingLists")).toBe(listSource);
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
  });

  it("resumes cleanup-pending without rolling back a newer normal save", async () => {
    const legacyMetadata = {
      移行再開イベント: { generation: "legacy-source" },
    };
    const newerMetadata = {
      移行再開イベント: { generation: "newer-normal-save" },
    };
    const legacySource = JSON.stringify(legacyMetadata);
    localStorage.setItem("eventMetadata", legacySource);
    const db = await importFreshDb();

    const firstMigration = await db.migrateFromLocalStorage();
    expect(firstMigration).toMatchObject({ status: "cleanup-pending" });
    const migratedRevision = await readCurrentRevision("eventMetadata");

    await db.saveEventMetadata(newerMetadata);
    const newerRevision = await readCurrentRevision("eventMetadata");
    expect(newerRevision).not.toBe(migratedRevision);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const resumedMigration = await resumedDb.migrateFromLocalStorage();

    expect(resumedMigration).toMatchObject({ status: "cleanup-pending" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      newerMetadata,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(newerRevision);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  });

  it("resumes deferred cleanup when an older tab has already removed the legacy source", async () => {
    const metadata = {
      旧tab削除イベント: { generation: "migrated-before-external-cleanup" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const db = await importFreshDb();

    const firstMigration = await db.migrateFromLocalStorage();
    expect(firstMigration).toMatchObject({ status: "cleanup-pending" });
    const migratedRevision = await readCurrentRevision("eventMetadata");
    const journalBeforeRemoval = await readRawRecord(
      "syncQueue",
      LEGACY_MIGRATION_JOURNAL_KEY,
    );
    expect(journalBeforeRemoval).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "deferred",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventMetadata",
          rawValue: legacySource,
        }),
      ]),
    });
    localStorage.removeItem("eventMetadata");

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const resumedMigration = await resumedDb.migrateFromLocalStorage();

    expect(resumedMigration).toMatchObject({ status: "cleanup-pending" });
    expect(localStorage.getItem("eventMetadata")).toBeNull();
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(await readCurrentRevision("eventMetadata")).toBe(migratedRevision);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "deferred",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventMetadata",
          rawValue: legacySource,
        }),
      ]),
    });
  });

  it("strictly verifies and resumes a copied journal after an older tab removes the legacy source", async () => {
    const metadata = {
      copied旧tab削除イベント: { generation: "copied-before-external-cleanup" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const verificationFailure = mockNthTransactionFailure({
      requiredStores: ["eventMetadata", "syncQueue"],
      mode: "readonly",
      occurrence: 2,
      failureCount: 2,
      exactStores: true,
      error: new DOMException(
        "forced copied-phase verification failure",
        "UnknownError",
      ),
    });
    const db = await importFreshDb();

    const failedMigration = await db.migrateFromLocalStorage();

    expect(failedMigration).toMatchObject({ status: "recovery-required" });
    expect(verificationFailure.getInjectionCount()).toBe(2);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "copied",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventMetadata",
          rawValue: legacySource,
        }),
      ]),
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    const copiedRevision = await readCurrentRevision("eventMetadata");
    verificationFailure.spy.mockRestore();
    localStorage.removeItem("eventMetadata");

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const resumedMigration = await resumedDb.migrateFromLocalStorage();

    expect(resumedMigration).toMatchObject({ status: "cleanup-pending" });
    expect(localStorage.getItem("eventMetadata")).toBeNull();
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(await readCurrentRevision("eventMetadata")).toBe(copiedRevision);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "deferred",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventMetadata",
          rawValue: legacySource,
        }),
      ]),
    });
  });

  it("stores an immutable raw archive for migration sources and the legacy syncQueue key", async () => {
    const metadata = {
      archive確認イベント: { generation: "migration-source" },
    };
    const metadataSource = JSON.stringify(metadata);
    const legacySyncQueueSource =
      '{"pending":[{"id":"legacy-sync-operation"}]}';
    localStorage.setItem("eventMetadata", metadataSource);
    localStorage.setItem("syncQueue", legacySyncQueueSource);
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");
    const db = await importFreshDb();

    expect(await db.migrateFromLocalStorage()).toMatchObject({
      status: "cleanup-pending",
    });

    const journal = await readMigrationJournalV2();
    expect(journal).toMatchObject({
      phase: "cleanup-ready",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
    });
    const archive = await readRawRecord("syncQueue", journal.archiveKey);
    expect(archive).toMatchObject({
      kind: "event-shopping-planner-legacy-migration-archive",
      schemaVersion: 1,
      sessionId: journal.sessionId,
      createdAt: expect.any(String),
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventMetadata",
          sourceKind: "migration-source",
          storeName: "eventMetadata",
          rawValue: metadataSource,
          rawDigest: await createPersistenceDigest(metadataSource),
          capturedAt: expect.any(String),
        }),
        expect.objectContaining({
          legacyKey: "syncQueue",
          sourceKind: "preserved-legacy-sync-queue",
          storeName: "syncQueue",
          rawValue: legacySyncQueueSource,
          rawDigest: await createPersistenceDigest(legacySyncQueueSource),
          capturedAt: expect.any(String),
        }),
      ]),
    });
    expect(localStorage.getItem("syncQueue")).toBe(legacySyncQueueSource);
    expect(await readRawRecord("syncQueue", "syncQueue")).toBeUndefined();
    expect(removeItemSpy).not.toHaveBeenCalledWith("syncQueue");
  });

  it("stops in recovery when the directly-read migration archive is replaced", async () => {
    const metadata = {
      archive改ざん検出イベント: { generation: "verified-source" },
    };
    const source = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", source);
    const db = await importFreshDb();
    expect(await db.migrateFromLocalStorage()).toMatchObject({
      status: "cleanup-pending",
    });
    const journal = await readMigrationJournalV2();
    const archive = (await readRawRecord("syncQueue", journal.archiveKey)) as {
      entries: Array<Record<string, unknown>>;
    };
    await writeRawRecordAtExistingVersion("syncQueue", journal.archiveKey, {
      ...archive,
      entries: archive.entries.map((entry, index) =>
        index === 0 ? { ...entry, rawValue: '{"tampered":true}' } : entry,
      ),
    });

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const resumed = await resumedDb.migrateFromLocalStorage();

    expect(resumed).toMatchObject({
      status: "recovery-required",
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    expect(localStorage.getItem("eventMetadata")).toBe(source);
  });

  it("reports syncQueue-only as not-needed while retaining the rollback-compatible v2 journal shape", async () => {
    const legacySyncQueueSource = '{"standalone":["legacy-operation"]}';
    localStorage.setItem("syncQueue", legacySyncQueueSource);
    const db = await importFreshDb();

    expect(await db.migrateFromLocalStorage()).toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "deferred",
      migratedKeys: [],
    });

    const journal = await readMigrationJournalV2();
    expect(journal).toMatchObject({
      phase: "cleanup-ready",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      entries: [],
    });
    expect(await readRawRecord("syncQueue", journal.archiveKey)).toMatchObject({
      entries: [
        expect.objectContaining({
          legacyKey: "syncQueue",
          sourceKind: "preserved-legacy-sync-queue",
          rawValue: legacySyncQueueSource,
        }),
      ],
    });
    expect(await readRawRecord("syncQueue", DATA_KEY)).toBeUndefined();
    expect(localStorage.getItem("syncQueue")).toBe(legacySyncQueueSource);
  });

  it.each([
    ["non-JSON", "legacy-sync-operation\nnot-json"],
    ["empty", ""],
  ])(
    "archives a %s standalone legacy syncQueue source without parsing, migrating, or deleting it",
    async (_label, legacySyncQueueSource) => {
      localStorage.setItem("syncQueue", legacySyncQueueSource);
      const db = await importFreshDb();

      expect(await db.migrateFromLocalStorage()).toEqual({
        status: "cleanup-pending",
        dataMigrationStatus: "not-needed",
        cleanupStatus: "deferred",
        migratedKeys: [],
      });

      const journal = await readMigrationJournalV2();
      expect(
        await readRawRecord("syncQueue", journal.archiveKey),
      ).toMatchObject({
        entries: [
          expect.objectContaining({
            legacyKey: "syncQueue",
            sourceKind: "preserved-legacy-sync-queue",
            rawValue: legacySyncQueueSource,
          }),
        ],
      });
      expect(await readRawRecord("syncQueue", DATA_KEY)).toBeUndefined();
      expect(localStorage.getItem("syncQueue")).toBe(legacySyncQueueSource);
    },
  );

  it("archives a legacy syncQueue source without changing an existing IDB queue root", async () => {
    const existingQueue = [{ id: "現行IDBキュー", operation: "keep" }];
    const legacySyncQueueSource = '{"legacy":["archive-only"]}';
    const db = await importFreshDb();
    await db.saveSyncQueue(existingQueue);
    const metadataKey = createPersistenceMetadataKey("syncQueue", DATA_KEY);
    const checkpointKey = createPersistenceCheckpointKey("syncQueue", DATA_KEY);
    const before = {
      payload: await readRawRecord("syncQueue", DATA_KEY),
      metadata: await readRawRecord("syncQueue", metadataKey),
      checkpoint: await readRawRecord("syncQueue", checkpointKey),
    };
    localStorage.setItem("syncQueue", legacySyncQueueSource);

    expect(await db.migrateFromLocalStorage()).toMatchObject({
      status: "cleanup-pending",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "deferred",
    });

    expect(await db.loadSyncQueue()).toMatchObject({
      status: "ok",
      data: existingQueue,
    });
    expect(await readRawRecord("syncQueue", DATA_KEY)).toEqual(before.payload);
    expect(await readRawRecord("syncQueue", metadataKey)).toEqual(
      before.metadata,
    );
    expect(await readRawRecord("syncQueue", checkpointKey)).toEqual(
      before.checkpoint,
    );
    expect(localStorage.getItem("syncQueue")).toBe(legacySyncQueueSource);
  });

  it("rolls back the atomic copy when the immutable archive cannot be stored", async () => {
    const metadata = {
      archive失敗イベント: { generation: "must-not-copy" },
    };
    const metadataSource = JSON.stringify(metadata);
    const legacySyncQueueSource = '{"operation":"must-preserve"}';
    localStorage.setItem("eventMetadata", metadataSource);
    localStorage.setItem("syncQueue", legacySyncQueueSource);
    const archiveFailure = mockMigrationArchivePutFailure(
      new DOMException("forced archive quota failure", "QuotaExceededError"),
    );
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({ status: "recovery-required" });
    expect(archiveFailure.getInjectionCount()).toBe(1);
    if (migration.status !== "recovery-required") {
      throw new Error("Expected archive failure recovery.");
    }
    expect(migration.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "legacy-localStorage",
          storeName: "eventMetadata",
          rawValue: metadataSource,
        }),
        expect.objectContaining({
          source: "legacy-localStorage",
          storeName: "syncQueue",
          rawValue: legacySyncQueueSource,
        }),
      ]),
    });
    const journal = await readMigrationJournalV2();
    expect(journal).toMatchObject({
      phase: "prepared",
      dataMigrationStatus: "prepared",
      cleanupStatus: "not-ready",
    });
    expect(
      await readRawRecord("syncQueue", journal.archiveKey),
    ).toBeUndefined();
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toBeUndefined();
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(localStorage.getItem("syncQueue")).toBe(legacySyncQueueSource);
  });

  it("requires recovery for an unknown journal version without writing or deleting sources", async () => {
    const metadata = {
      未対応journalイベント: { generation: "preserve" },
    };
    const metadataSource = JSON.stringify(metadata);
    const legacySyncQueueSource = '{"future":"queue-format"}';
    const unknownJournal = {
      kind: "event-shopping-planner-legacy-migration",
      schemaVersion: 99,
      futureState: "do-not-interpret",
    };
    localStorage.setItem("eventMetadata", metadataSource);
    localStorage.setItem("syncQueue", legacySyncQueueSource);
    await seedDatabase(CURRENT_DATABASE_VERSION);
    await writeRawRecordAtExistingVersion(
      "syncQueue",
      LEGACY_MIGRATION_JOURNAL_KEY,
      unknownJournal,
    );
    const putObserver = observeUserStorePuts();
    const db = await importFreshDb();

    const migration = await db.migrateFromLocalStorage();

    expect(migration).toMatchObject({
      status: "recovery-required",
      dataMigrationStatus: "recovery-required",
      cleanupStatus: "recovery-required",
    });
    expect(putObserver.getUserStorePutCount()).toBe(0);
    if (migration.status !== "recovery-required") {
      throw new Error("Expected unsupported journal recovery.");
    }
    expect(migration.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "migration-journal",
          payload: expect.objectContaining({ schemaVersion: 99 }),
        }),
        expect.objectContaining({
          source: "legacy-localStorage",
          storeName: "syncQueue",
          rawValue: legacySyncQueueSource,
        }),
      ]),
    });
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toEqual(unknownJournal);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toBeUndefined();
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(localStorage.getItem("syncQueue")).toBe(legacySyncQueueSource);
  });

  it("upgrades an actual journal v1 fixture with no checkpoint and permits an immediate save", async () => {
    const {
      payload: migratedMetadata,
      legacySource,
      targetRevision,
      checkpointKey,
    } = await seedActualV1EventMetadataFixtureWithoutCheckpoint();
    expect(await readRawRecord("syncQueue", checkpointKey)).toBeUndefined();
    const db = await importFreshDb();

    await expect(db.migrateFromLocalStorage()).resolves.toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      migratedKeys: ["eventMetadata"],
    });

    expect(await readMigrationJournalV2()).toMatchObject({
      schemaVersion: 2,
      phase: "cleanup-ready",
      dataMigrationStatus: "verified",
      cleanupStatus: "deferred",
      entries: [
        expect.objectContaining({
          legacyKey: "eventMetadata",
          targetRevision,
          cleanupStatus: "deferred",
        }),
      ],
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      migratedMetadata,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(targetRevision);
    expect(await readRawRecord("syncQueue", checkpointKey)).toBeUndefined();
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);

    const savedImmediately = {
      旧v1実fixtureイベント: { generation: "saved-immediately" },
    };
    await expect(
      db.saveEventMetadata(savedImmediately),
    ).resolves.toBeUndefined();
    const savedRevision = await readCurrentRevision("eventMetadata");
    expect(savedRevision).not.toBe(targetRevision);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      savedImmediately,
    );
    expect(await readRawRecord("syncQueue", checkpointKey)).toMatchObject({
      committedRoot: {
        revision: savedRevision,
        baseRevision: targetRevision,
      },
    });
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  });

  it.each([
    {
      v1Phase: "prepared" as const,
      initialV2Phase: "prepared",
      failurePhase: "copy" as const,
    },
    {
      v1Phase: "copied" as const,
      initialV2Phase: "copied",
      failurePhase: "verified" as const,
    },
    {
      v1Phase: "verified" as const,
      initialV2Phase: "verified",
      failurePhase: "cleanup-ready" as const,
    },
    {
      v1Phase: "cleanupPending" as const,
      initialV2Phase: "cleanup-ready",
      failurePhase: null,
    },
    {
      v1Phase: "completed" as const,
      initialV2Phase: "cleanup-ready",
      failurePhase: null,
    },
  ])(
    "atomically upgrades and resumes a v1 $v1Phase journal",
    async ({ v1Phase, initialV2Phase, failurePhase }) => {
      const metadata = {
        [`v1-${v1Phase}-イベント`]: { phase: v1Phase },
      };
      const legacySource = JSON.stringify(metadata);
      localStorage.setItem("eventMetadata", legacySource);
      let failure:
        | ReturnType<typeof mockNthTransactionFailure>
        | ReturnType<typeof mockJournalPhasePutFailure>
        | undefined;
      if (failurePhase === "copy") {
        failure = mockNthTransactionFailure({
          requiredStores: ["eventMetadata", "syncQueue"],
          mode: "readwrite",
          occurrence: 1,
          error: new DOMException("forced v1 prepared fixture", "UnknownError"),
        });
      } else if (failurePhase !== null) {
        failure = mockJournalPhasePutFailure(
          failurePhase,
          new DOMException(`forced v1 ${v1Phase} fixture`, "UnknownError"),
        );
      }
      const db = await importFreshDb();

      const initialMigration = await db.migrateFromLocalStorage();

      expect(initialMigration).toMatchObject({
        status:
          failurePhase === null || failurePhase === "cleanup-ready"
            ? "cleanup-pending"
            : "recovery-required",
      });
      expect(await readMigrationJournalV2()).toMatchObject({
        phase: initialV2Phase,
      });
      failure?.spy.mockRestore();
      const { archiveKey } =
        await downgradeCurrentMigrationJournalToV1(v1Phase);
      if (v1Phase === "completed") {
        localStorage.removeItem("eventMetadata");
      }

      vi.resetModules();
      const resumedDb = await importFreshDb();
      const resumedMigration = await resumedDb.migrateFromLocalStorage();

      expect(resumedMigration).toMatchObject({
        status: v1Phase === "completed" ? "completed" : "cleanup-pending",
      });
      const upgradedJournal = await readMigrationJournalV2();
      expect(upgradedJournal).toMatchObject({
        schemaVersion: 2,
        archiveKey,
        dataMigrationStatus: "verified",
        phase: v1Phase === "completed" ? "completed" : "cleanup-ready",
        cleanupStatus: v1Phase === "completed" ? "completed" : "deferred",
      });
      expect(await readRawRecord("syncQueue", archiveKey)).toMatchObject({
        kind: "event-shopping-planner-legacy-migration-archive",
        schemaVersion: 1,
        sessionId: upgradedJournal.sessionId,
        entries: [
          expect.objectContaining({
            legacyKey: "eventMetadata",
            rawValue: legacySource,
            rawDigest: await createPersistenceDigest(legacySource),
          }),
        ],
      });
      expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    },
  );

  it("keeps a v1 journal unchanged when its atomic archive upgrade fails", async () => {
    const metadata = {
      v1昇格失敗イベント: { phase: "prepared" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const copyFailure = mockNthTransactionFailure({
      requiredStores: ["eventMetadata", "syncQueue"],
      mode: "readwrite",
      occurrence: 1,
      error: new DOMException("forced prepared fixture", "UnknownError"),
    });
    const db = await importFreshDb();
    expect(await db.migrateFromLocalStorage()).toMatchObject({
      status: "recovery-required",
    });
    copyFailure.spy.mockRestore();
    const { archiveKey } =
      await downgradeCurrentMigrationJournalToV1("prepared");
    const archiveFailure = mockMigrationArchivePutFailure(
      new DOMException("forced v1 archive failure", "QuotaExceededError"),
    );

    vi.resetModules();
    const resumedDb = await importFreshDb();
    expect(await resumedDb.migrateFromLocalStorage()).toMatchObject({
      status: "recovery-required",
    });

    expect(archiveFailure.getInjectionCount()).toBe(1);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ schemaVersion: 1, phase: "prepared" });
    expect(await readRawRecord("syncQueue", archiveKey)).toBeUndefined();
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toBeUndefined();
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  });
});

describe("db.restoreAppDataAtomically resilience", () => {
  it("rolls back every payload and revision while preserving unknown v7 records", async () => {
    const appDataStoreNames: StoreName[] = [
      "eventLists",
      "eventMetadata",
      "executeModeItems",
      "dayModes",
      "mapData",
      "mapRotationSettings",
      "routeSettings",
      "hallDefinitions",
      "hallRouteSettings",
      "mapViewportSettings",
    ];
    const ordinaryStoreNames = appDataStoreNames.filter(
      (storeName) => storeName !== "mapData",
    );
    const initialData = makeAppData("atomic復元前");
    const nextData = makeAppData("atomic失敗候補");
    const initialEventName = "atomic復元前イベント";
    const initialMapKey = createSplitMapKey(initialEventName, "1日目マップ");
    const unknownOrdinaryKey = "future:v7:ordinary";
    const unknownMapKey = "future:v7:map";
    const unknownOrdinaryValue = { preserved: "ordinary-v7-record" };
    const unknownMapValue = { preserved: "map-v7-record" };
    await seedDatabase(7);
    const db = await importFreshDb();
    await db.restoreAppDataAtomically(initialData);
    await writeRawRecordAtExistingVersion(
      "eventMetadata",
      unknownOrdinaryKey,
      unknownOrdinaryValue,
    );
    await writeRawRecordAtExistingVersion(
      "mapData",
      unknownMapKey,
      unknownMapValue,
    );

    const payloadSnapshot = await Promise.all([
      ...ordinaryStoreNames.map((storeName) =>
        readRawRecordAtExistingVersion(storeName, DATA_KEY),
      ),
      readRawRecordAtExistingVersion("mapData", initialMapKey),
      readRawRecordAtExistingVersion("eventMetadata", unknownOrdinaryKey),
      readRawRecordAtExistingVersion("mapData", unknownMapKey),
    ]);
    const metadataSnapshot = await Promise.all(
      appDataStoreNames.map((storeName) =>
        readRawRecordAtExistingVersion(
          "syncQueue",
          createPersistenceMetadataKey(storeName, DATA_KEY),
        ),
      ),
    );
    metadataSnapshot.forEach((metadata) => {
      expect(metadata).toMatchObject({ revision: expect.any(String) });
    });
    const restoreFailure = mockSynchronousStorePutFailure(
      "routeSettings",
      DATA_KEY,
      new DOMException("forced atomic restore failure", "DataCloneError"),
    );

    await expect(db.restoreAppDataAtomically(nextData)).rejects.toMatchObject({
      name: "DataCloneError",
    });

    expect(restoreFailure.getInjectionCount()).toBe(1);
    await expect(
      Promise.all([
        ...ordinaryStoreNames.map((storeName) =>
          readRawRecordAtExistingVersion(storeName, DATA_KEY),
        ),
        readRawRecordAtExistingVersion("mapData", initialMapKey),
        readRawRecordAtExistingVersion("eventMetadata", unknownOrdinaryKey),
        readRawRecordAtExistingVersion("mapData", unknownMapKey),
      ]),
    ).resolves.toEqual(payloadSnapshot);
    await expect(
      Promise.all(
        appDataStoreNames.map((storeName) =>
          readRawRecordAtExistingVersion(
            "syncQueue",
            createPersistenceMetadataKey(storeName, DATA_KEY),
          ),
        ),
      ),
    ).resolves.toEqual(metadataSnapshot);
    expect(await db.getAllAppData()).toEqual(initialData);
  });

  it("refuses an atomic restore while an unresolved runtime branch exists", async () => {
    const db = await importFreshDb();
    const baseValue = {
      restore分岐イベント: { generation: "base" },
    };
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const branch = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "restore-unresolved-branch",
      baseRevision,
      payload: {
        restore分岐イベント: { generation: "runtime-branch" },
      },
    });

    await expect(
      db.restoreAppDataAtomically(makeAppData("restore-rejected")),
    ).rejects.toMatchObject({ name: "PersistenceConflict" });

    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(baseValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    expect(localStorage.getItem(branch.storageKey)).toBe(branch.serialized);
  });
});

describe("db runtime fallback resilience", () => {
  it("keeps absorbed lineage proof when cleanup succeeds only for later candidates", async () => {
    const db = await importFreshDb();
    const baseValue = {
      部分cleanupイベント: { generation: "base" },
    };
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const candidate1 = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "partial-cleanup-chain-1",
      baseRevision,
      payload: {
        部分cleanupイベント: { generation: "candidate-1" },
      },
    });
    const candidate2 = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "partial-cleanup-chain-2",
      baseRevision: candidate1.candidate.revision,
      payload: {
        部分cleanupイベント: { generation: "candidate-2" },
      },
    });
    const candidate3 = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "partial-cleanup-chain-3",
      baseRevision: candidate2.candidate.revision,
      payload: {
        部分cleanupイベント: { generation: "candidate-3" },
      },
    });
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, storageKey: string) {
        if (storageKey === candidate1.storageKey) {
          throw new DOMException(
            "forced partial cleanup failure",
            "SecurityError",
          );
        }
        return originalRemoveItem.call(this, storageKey);
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    expect(await recoveryDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: candidate3.candidate.payload,
    });
    expect(localStorage.getItem(candidate1.storageKey)).toBe(
      candidate1.serialized,
    );
    expect(localStorage.getItem(candidate2.storageKey)).toBeNull();
    expect(localStorage.getItem(candidate3.storageKey)).toBeNull();
    expect(
      await readRawRecord(
        "syncQueue",
        createPersistenceCheckpointKey("eventMetadata", DATA_KEY),
      ),
    ).toMatchObject({
      committedRoot: { revision: candidate3.candidate.revision },
      absorbedCandidates: expect.arrayContaining([
        expect.objectContaining({ revision: candidate1.candidate.revision }),
        expect.objectContaining({ revision: candidate2.candidate.revision }),
        expect.objectContaining({ revision: candidate3.candidate.revision }),
      ]),
    });

    removeItemSpy.mockRestore();
    vi.resetModules();
    const verificationDb = await importFreshDb();
    expect(await verificationDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: candidate3.candidate.payload,
    });
    expect(localStorage.getItem(candidate1.storageKey)).toBeNull();
  });

  it("requires recovery when an absorbed checkpoint revision reappears with a different digest", async () => {
    const db = await importFreshDb();
    const baseValue = {
      checkpoint再出現イベント: { generation: "base" },
    };
    const absorbedValue = {
      checkpoint再出現イベント: { generation: "absorbed-A" },
    };
    const committedValue = {
      checkpoint再出現イベント: { generation: "committed-after-A" },
    };
    const conflictingValue = {
      checkpoint再出現イベント: { generation: "reappeared-B" },
    };
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const absorbed = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "checkpoint-reappeared-revision",
      baseRevision,
      payload: absorbedValue,
    });
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, storageKey: string) {
        if (storageKey === absorbed.storageKey) {
          throw new DOMException(
            "forced checkpoint candidate retention",
            "SecurityError",
          );
        }
        return originalRemoveItem.call(this, storageKey);
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    const repairingDb = await importFreshDb();
    expect(await repairingDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: absorbedValue,
    });
    await repairingDb.saveEventMetadata(committedValue);
    const committedRevision = await readCurrentRevision("eventMetadata");
    expect(
      await readRawRecord(
        "syncQueue",
        createPersistenceCheckpointKey("eventMetadata", DATA_KEY),
      ),
    ).toMatchObject({
      committedRoot: {
        revision: committedRevision,
        baseRevision: absorbed.candidate.revision,
      },
      absorbedCandidates: expect.arrayContaining([
        expect.objectContaining({
          revision: absorbed.candidate.revision,
          digest: absorbed.candidate.digest,
        }),
      ]),
    });
    expect(localStorage.getItem(absorbed.storageKey)).toBe(absorbed.serialized);
    removeItemSpy.mockRestore();

    const reappeared = await createRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      key: DATA_KEY,
      revision: absorbed.candidate.revision,
      baseRevision: absorbed.candidate.baseRevision,
      writerId: absorbed.candidate.writerId,
      createdAt: absorbed.candidate.createdAt,
      payload: conflictingValue,
    });
    const reappearedSerialized = serializeRuntimeFallbackCandidate(reappeared);
    localStorage.setItem(absorbed.storageKey, reappearedSerialized);

    vi.resetModules();
    const verificationDb = await importFreshDb();
    const loaded = await verificationDb.loadEventMetadata();

    expect(loaded).toMatchObject({
      status: "conflict",
      data: null,
      recoveryBundle: {
        candidates: expect.arrayContaining([
          expect.objectContaining({
            source: "runtime-fallback",
            sourceKey: absorbed.storageKey,
            revision: absorbed.candidate.revision,
            digest: reappeared.digest.value,
          }),
        ]),
      },
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      committedValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(committedRevision);
    expect(localStorage.getItem(absorbed.storageKey)).toBe(
      reappearedSerialized,
    );
    await expect(
      verificationDb.saveEventMetadata({
        checkpoint再出現イベント: { generation: "must-not-autosave" },
      }),
    ).rejects.toMatchObject({ name: "PersistenceConflict" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      committedValue,
    );

    const selectedCandidate = loaded.recoveryBundle?.candidates.find(
      ({ source, sourceKey }) =>
        source === "runtime-fallback" && sourceKey === absorbed.storageKey,
    );
    if (!selectedCandidate) {
      throw new Error("Missing reappeared checkpoint recovery candidate.");
    }
    await expect(
      verificationDb.adoptRecoveryCandidate(selectedCandidate),
    ).resolves.toMatchObject({
      status: "adopted",
      storeName: "eventMetadata",
      key: DATA_KEY,
    });
    expect(await verificationDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: conflictingValue,
    });
    expect(localStorage.getItem(absorbed.storageKey)).toBe(
      reappearedSerialized,
    );

    const postAdoptionValue = {
      checkpoint再出現イベント: { generation: "saved-after-adoption" },
    };
    await expect(
      verificationDb.saveEventMetadata(postAdoptionValue),
    ).resolves.toBeUndefined();
    expect(await verificationDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: postAdoptionValue,
    });
    expect(localStorage.getItem(absorbed.storageKey)).toBe(
      reappearedSerialized,
    );
  });

  it("does not infer a fallback head in a fresh session when IndexedDB is unreadable", async () => {
    const seedDb = await importFreshDb();
    await seedDb.saveEventMetadata({
      freshSessionイベント: { generation: "base" },
    });
    const baseRevision = await readCurrentRevision("eventMetadata");
    const fallback = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "fresh-session-unconfirmed-head",
      baseRevision,
      payload: {
        freshSessionイベント: { generation: "fallback" },
      },
    });
    vi.resetModules();
    const readFailure = mockNthTransactionFailure({
      requiredStores: ["eventMetadata", "syncQueue"],
      mode: "readonly",
      occurrence: 1,
      failureCount: 2,
      exactStores: true,
      error: new DOMException("forced unreadable IndexedDB", "UnknownError"),
    });
    const freshDb = await importFreshDb();

    const loaded = await freshDb.loadEventMetadata();

    expect(readFailure.getInjectionCount()).toBe(2);
    expect(loaded.status).toBe("conflict");
    expect(loaded.data).toBeNull();
    expect(loaded.recoveryBundle?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "runtime-fallback",
          revision: fallback.candidate.revision,
        }),
      ]),
    );
    expect(localStorage.getItem(fallback.storageKey)).toBe(fallback.serialized);
  });

  it.each(["writerId", "createdAt"] as const)(
    "同一セッションのIDB二重読込失敗時に%sが異なる同revision候補を採用しない",
    async (mismatchedField) => {
      const db = await importFreshDb();
      const baseValue = {
        系譜検証イベント: { generation: mismatchedField },
      };
      await db.saveEventMetadata(baseValue);
      expect(await db.loadEventMetadata()).toMatchObject({
        status: "ok",
        data: baseValue,
      });

      const metadataKey = createPersistenceMetadataKey(
        "eventMetadata",
        DATA_KEY,
      );
      const metadataBefore = await readRawRecord("syncQueue", metadataKey);
      const metadata = await readCurrentMetadata("eventMetadata");
      const checkpointKey = createPersistenceCheckpointKey(
        "eventMetadata",
        DATA_KEY,
      );
      const checkpointBefore = await readRawRecord("syncQueue", checkpointKey);
      const conflictingCandidate = await createRuntimeFallbackCandidate({
        storeName: "eventMetadata",
        key: DATA_KEY,
        revision: metadata.revision,
        baseRevision: metadata.baseRevision,
        writerId:
          mismatchedField === "writerId"
            ? `${metadata.writerId}-conflict`
            : metadata.writerId,
        createdAt:
          mismatchedField === "createdAt"
            ? new Date(Date.parse(metadata.committedAt) + 1).toISOString()
            : metadata.committedAt,
        payload: baseValue,
      });
      expect(conflictingCandidate.digest).toEqual(metadata.payloadDigest);
      const storageKey = createRuntimeFallbackKey(
        "eventMetadata",
        DATA_KEY,
        conflictingCandidate.revision,
      );
      const serialized =
        serializeRuntimeFallbackCandidate(conflictingCandidate);
      localStorage.setItem(storageKey, serialized);
      const readFailure = mockNthTransactionFailure({
        requiredStores: ["eventMetadata", "syncQueue"],
        mode: "readonly",
        occurrence: 1,
        failureCount: 2,
        exactStores: true,
        error: new DOMException(
          `forced cached-root ${mismatchedField} read failure`,
          "UnknownError",
        ),
      });

      const loaded = await db.loadEventMetadata();

      expect(readFailure.getInjectionCount()).toBe(2);
      expect(loaded).toMatchObject({
        status: "conflict",
        data: null,
        recoveryBundle: {
          candidates: expect.arrayContaining([
            expect.objectContaining({
              source: "runtime-fallback",
              sourceKey: storageKey,
              revision: metadata.revision,
            }),
          ]),
        },
      });
      expect(localStorage.getItem(storageKey)).toBe(serialized);

      readFailure.spy.mockRestore();
      expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(baseValue);
      expect(await readRawRecord("syncQueue", metadataKey)).toEqual(
        metadataBefore,
      );
      expect(await readRawRecord("syncQueue", checkpointKey)).toEqual(
        checkpointBefore,
      );

      localStorage.removeItem(storageKey);
      const savedAfterConflict = {
        系譜検証イベント: { generation: `saved-after-${mismatchedField}` },
      };
      await expect(
        db.saveEventMetadata(savedAfterConflict),
      ).resolves.toBeUndefined();
      expect(await db.loadEventMetadata()).toMatchObject({
        status: "ok",
        data: savedAfterConflict,
      });
    },
  );

  it("checks for a newly appeared runtime branch before advancing a cached IDB root", async () => {
    const db = await importFreshDb();
    const baseValue = {
      保存直前分岐イベント: { generation: "base" },
    };
    await db.saveEventMetadata(baseValue);
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: baseValue,
    });
    const baseRevision = await readCurrentRevision("eventMetadata");
    const branch = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "appeared-after-observation",
      baseRevision,
      payload: {
        保存直前分岐イベント: { generation: "other-writer" },
      },
    });

    await expect(
      db.saveEventMetadata({
        保存直前分岐イベント: { generation: "must-not-commit" },
      }),
    ).rejects.toMatchObject({ name: "PersistenceConflict" });

    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(baseValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    expect(localStorage.getItem(branch.storageKey)).toBe(branch.serialized);
  });

  it("rolls back payload and metadata when the checkpoint put fails", async () => {
    const db = await importFreshDb();
    const baseValue = {
      checkpointRollbackイベント: { generation: "base" },
    };
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const checkpointKey = createPersistenceCheckpointKey(
      "eventMetadata",
      DATA_KEY,
    );
    const checkpointBefore = await readRawRecord("syncQueue", checkpointKey);
    const checkpointFailure = mockSynchronousStorePutFailure(
      "syncQueue",
      checkpointKey,
      new DOMException("forced checkpoint failure", "DataCloneError"),
    );

    await expect(
      db.saveEventMetadata({
        checkpointRollbackイベント: { generation: "must-roll-back" },
      }),
    ).rejects.toMatchObject({ name: "DataCloneError" });

    expect(checkpointFailure.getInjectionCount()).toBe(1);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(baseValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    expect(await readRawRecord("syncQueue", checkpointKey)).toEqual(
      checkpointBefore,
    );
  });

  it("chains consecutive fallback saves and repairs IndexedDB to the latest value", async () => {
    const idbValue = {
      連続退避イベント: { generation: "indexed-db-base" },
    };
    const fallbackValues = [
      { 連続退避イベント: { generation: "fallback-1" } },
      { 連続退避イベント: { generation: "fallback-2" } },
      { 連続退避イベント: { generation: "fallback-3" } },
    ];
    const db = await importFreshDb();
    await db.saveEventMetadata(idbValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const writeFailure = mockStoreWriteFailures(
      "eventMetadata",
      new DOMException("forced consecutive write failure", "UnknownError"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const [index, fallbackValue] of fallbackValues.entries()) {
      await db.saveEventMetadata(fallbackValue);
      expect(getRuntimeFallbackKeys("eventMetadata")).toHaveLength(index + 1);
      expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(idbValue);
      expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    }

    writeFailure.spy.mockRestore();
    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const latestValue = fallbackValues.at(-1);
    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded).toMatchObject({ status: "ok", data: latestValue });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(latestValue);
    expect(await readCurrentRevision("eventMetadata")).not.toBe(baseRevision);
    expect(getRuntimeFallbackKeys("eventMetadata")).toEqual([]);
  });

  it("rejects a sibling commit when a child fallback appears after observation", async () => {
    const baseValue = {
      子候補競合イベント: { generation: "base" },
    };
    const observedFallbackValue = {
      子候補競合イベント: { generation: "observed-fallback" },
    };
    const concurrentChildValue = {
      子候補競合イベント: { generation: "concurrent-child" },
    };
    const rejectedSiblingValue = {
      子候補競合イベント: { generation: "must-not-commit-sibling" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const observedFallback = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "observed-fallback-revision",
      baseRevision,
      payload: observedFallbackValue,
    });
    const repairFailure = mockStoreWriteFailures(
      "eventMetadata",
      new DOMException("forced repair failure", "UnknownError"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: observedFallbackValue,
    });
    repairFailure.spy.mockRestore();

    await writeRawRecordAtExistingVersion(
      "eventMetadata",
      DATA_KEY,
      observedFallback.candidate.payload,
    );
    await writeRawRecordAtExistingVersion(
      "syncQueue",
      createPersistenceMetadataKey("eventMetadata", DATA_KEY),
      {
        kind: "event-shopping-planner-persistence-metadata",
        version: 1,
        storeName: "eventMetadata",
        key: DATA_KEY,
        revision: observedFallback.candidate.revision,
        baseRevision: observedFallback.candidate.baseRevision,
        payloadDigest: observedFallback.candidate.digest,
        payloadFingerprint: createSynchronousFingerprint(
          observedFallback.candidate.payload,
        ),
        writerId: observedFallback.candidate.writerId,
        committedAt: observedFallback.candidate.createdAt,
      },
    );
    const concurrentChild = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "concurrent-child-revision",
      baseRevision: observedFallback.candidate.revision,
      payload: concurrentChildValue,
    });

    await expect(
      db.saveEventMetadata(rejectedSiblingValue),
    ).rejects.toMatchObject({
      name: "PersistenceConflict",
    });

    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      observedFallbackValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(
      observedFallback.candidate.revision,
    );
    expect(getRuntimeFallbackKeys("eventMetadata")).toEqual(
      expect.arrayContaining([
        observedFallback.storageKey,
        concurrentChild.storageKey,
      ]),
    );
    expect(getRuntimeFallbackKeys("eventMetadata")).toHaveLength(2);
  });

  it("loads a newer runtime candidate, repairs the older IDB value, and removes the committed candidate", async () => {
    const idbValue = {
      フォールバック復旧イベント: { generation: "older-idb" },
    };
    const fallbackValue = {
      フォールバック復旧イベント: { generation: "newer-fallback" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const { candidate, storageKey } = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "runtime-newer-candidate",
      baseRevision,
      payload: fallbackValue,
    });

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded).toMatchObject({
      status: "ok",
      data: fallbackValue,
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      fallbackValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(candidate.revision);
    expect(
      await readRawRecord(
        "syncQueue",
        createPersistenceMetadataKey("eventMetadata", DATA_KEY),
      ),
    ).toMatchObject({
      revision: candidate.revision,
      baseRevision,
      payloadDigest: candidate.digest,
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(localStorage.getItem("eventMetadata")).toBeNull();
    vi.resetModules();
    const verificationDb = await importFreshDb();
    expect(await verificationDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: fallbackValue,
    });
  });

  it("prefers a newer IDB revision and removes only the stale fallback candidate", async () => {
    const baseValue = {
      stale候補イベント: { generation: "common-base" },
    };
    const staleFallbackValue = {
      stale候補イベント: { generation: "older-fallback" },
    };
    const newerIdbValue = {
      stale候補イベント: { generation: "newer-idb" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const staleCandidate = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "eventual-stale-candidate",
      baseRevision,
      payload: staleFallbackValue,
    });
    const cleanupError = new DOMException(
      "forced stale cleanup failure",
      "SecurityError",
    );
    const originalRemoveItem = Storage.prototype.removeItem;
    let staleCleanupAttempts = 0;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, storageKey: string) {
        if (storageKey === staleCandidate.storageKey) {
          staleCleanupAttempts += 1;
          throw cleanupError;
        }
        return originalRemoveItem.call(this, storageKey);
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    const repairingDb = await importFreshDb();
    expect(await repairingDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: staleFallbackValue,
    });
    expect(localStorage.getItem(staleCandidate.storageKey)).toBe(
      staleCandidate.serialized,
    );
    expect(staleCleanupAttempts).toBeGreaterThan(0);

    await repairingDb.saveEventMetadata(newerIdbValue);
    const newerRevision = await readCurrentRevision("eventMetadata");
    expect(newerRevision).not.toBe(staleCandidate.candidate.revision);
    expect(localStorage.getItem(staleCandidate.storageKey)).toBe(
      staleCandidate.serialized,
    );
    localStorage.setItem("unrelated-persistence-key", "must-remain");
    removeItemSpy.mockRestore();

    vi.resetModules();
    const verificationDb = await importFreshDb();
    expect(await verificationDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: newerIdbValue,
    });
    expect(await readCurrentRevision("eventMetadata")).toBe(newerRevision);
    expect(localStorage.getItem(staleCandidate.storageKey)).toBeNull();
    expect(localStorage.getItem("unrelated-persistence-key")).toBe(
      "must-remain",
    );
  });

  it("returns a verified fallback and retains it when both IDB repair attempts fail", async () => {
    const idbValue = {
      repair失敗イベント: { generation: "older-idb" },
    };
    const fallbackValue = {
      repair失敗イベント: { generation: "verified-fallback" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const fallback = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "repair-failure-candidate",
      baseRevision,
      payload: fallbackValue,
    });

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const repairFailure = mockStoreWriteFailures(
      "eventMetadata",
      new DOMException("forced repair failure", "UnknownError"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded).toMatchObject({
      status: "ok",
      data: fallbackValue,
    });
    expect(repairFailure.getFailureCount()).toBeGreaterThanOrEqual(2);
    expect(localStorage.getItem(fallback.storageKey)).toBe(fallback.serialized);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(idbValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
  });

  it("keeps a successful repair and its fallback when candidate cleanup fails", async () => {
    const idbValue = {
      cleanup失敗イベント: { generation: "older-idb" },
    };
    const fallbackValue = {
      cleanup失敗イベント: { generation: "newer-fallback" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const fallback = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "cleanup-failure-candidate",
      baseRevision,
      payload: fallbackValue,
    });

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const cleanupError = new DOMException(
      "forced candidate cleanup failure",
      "SecurityError",
    );
    const originalRemoveItem = Storage.prototype.removeItem;
    let cleanupAttempts = 0;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, storageKey: string) {
        if (storageKey === fallback.storageKey) {
          cleanupAttempts += 1;
          throw cleanupError;
        }
        return originalRemoveItem.call(this, storageKey);
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded).toMatchObject({
      status: "ok",
      data: fallbackValue,
    });
    expect(cleanupAttempts).toBeGreaterThan(0);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      fallbackValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(
      fallback.candidate.revision,
    );
    expect(localStorage.getItem(fallback.storageKey)).toBe(fallback.serialized);

    removeItemSpy.mockRestore();
    vi.resetModules();
    const cleanupDb = await importFreshDb();
    expect(await cleanupDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: fallbackValue,
    });
    expect(localStorage.getItem(fallback.storageKey)).toBeNull();
  });

  it("reports sibling candidates from the same base as a conflict and retains both", async () => {
    const idbValue = {
      競合イベント: { generation: "common-base" },
    };
    const candidateAValue = {
      競合イベント: { generation: "candidate-a" },
    };
    const candidateBValue = {
      競合イベント: { generation: "candidate-b" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const candidateA = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "sibling-candidate-a",
      baseRevision,
      payload: candidateAValue,
    });
    const candidateB = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "sibling-candidate-b",
      baseRevision,
      payload: candidateBValue,
    });

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded.status).toBe("conflict");
    expect(loaded.data).toBeNull();
    expect(loaded.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "runtime-fallback",
          revision: candidateA.candidate.revision,
        }),
        expect.objectContaining({
          source: "runtime-fallback",
          revision: candidateB.candidate.revision,
        }),
      ]),
    });
    expect(localStorage.getItem(candidateA.storageKey)).toBe(
      candidateA.serialized,
    );
    expect(localStorage.getItem(candidateB.storageKey)).toBe(
      candidateB.serialized,
    );
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(idbValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
  });

  it("reports a conflict when IDB and runtime fallback commit different children of the same base", async () => {
    const baseValue = {
      repair競合イベント: { generation: "common-base" },
    };
    const idbBranchValue = {
      repair競合イベント: { generation: "idb-writer" },
    };
    const runtimeBranchValue = {
      repair競合イベント: { generation: "runtime-writer" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(baseValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    await db.saveEventMetadata(idbBranchValue);
    const idbBranchRevision = await readCurrentRevision("eventMetadata");
    const runtimeBranch = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "repair-race-runtime-branch",
      baseRevision,
      payload: runtimeBranchValue,
    });

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded.status).toBe("conflict");
    expect(loaded.data).toBeNull();
    expect(loaded.recoveryBundle).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "indexedDB",
          revision: idbBranchRevision,
        }),
        expect.objectContaining({
          source: "runtime-fallback",
          revision: runtimeBranch.candidate.revision,
        }),
      ]),
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      idbBranchValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(idbBranchRevision);
    expect(localStorage.getItem(runtimeBranch.storageKey)).toBe(
      runtimeBranch.serialized,
    );
  });

  it("keeps the latest fallback candidate when appending its successor fails", async () => {
    const idbValue = {
      候補追記イベント: { generation: "older-idb" },
    };
    const candidateAValue = {
      候補追記イベント: { generation: "candidate-a" },
    };
    const candidateBValue = {
      候補追記イベント: { generation: "latest-accepted-candidate-b" },
    };
    const candidateCValue = {
      候補追記イベント: { generation: "uncommitted-candidate-c" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(idbValue);
    const baseRevision = await readCurrentRevision("eventMetadata");
    const candidateA = await installRuntimeFallbackCandidate({
      storeName: "eventMetadata",
      revision: "latest-candidate-a",
      baseRevision,
      payload: candidateAValue,
    });
    const indexedDbError = new DOMException(
      "forced IndexedDB write failure",
      "UnknownError",
    );
    const writeFailure = mockStoreWriteFailures(
      "eventMetadata",
      indexedDbError,
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: candidateAValue,
    });
    expect(localStorage.getItem(candidateA.storageKey)).toBe(
      candidateA.serialized,
    );
    await db.saveEventMetadata(candidateBValue);
    const acceptedFallbackKeys = getRuntimeFallbackKeys("eventMetadata");
    expect(acceptedFallbackKeys).toHaveLength(2);
    expect(acceptedFallbackKeys).toContain(candidateA.storageKey);
    const quotaError = new DOMException(
      "candidate C quota exceeded",
      "QuotaExceededError",
    );
    const attemptedStorageKeys: string[] = [];
    const appendSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((storageKey) => {
        attemptedStorageKeys.push(storageKey);
        throw quotaError;
      });

    await expect(db.saveEventMetadata(candidateCValue)).rejects.toMatchObject({
      name: "QuotaExceededError",
    });

    expect(writeFailure.getFailureCount()).toBeGreaterThan(0);
    const runtimePrefix = createRuntimeFallbackPrefix(
      "eventMetadata",
      DATA_KEY,
    );
    expect(
      attemptedStorageKeys.some(
        (storageKey) =>
          storageKey.startsWith(runtimePrefix) &&
          !acceptedFallbackKeys.includes(storageKey),
      ),
    ).toBe(true);
    expect(localStorage.getItem(candidateA.storageKey)).toBe(
      candidateA.serialized,
    );
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(idbValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    expect(getRuntimeFallbackKeys("eventMetadata")).toEqual(
      expect.arrayContaining(acceptedFallbackKeys),
    );
    expect(getRuntimeFallbackKeys("eventMetadata")).toHaveLength(2);

    writeFailure.spy.mockRestore();
    appendSpy.mockRestore();
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: candidateBValue,
    });
    expect(getRuntimeFallbackKeys("eventMetadata")).toEqual([]);
  });

  it("does not silently overwrite a commit from another module instance with a stale observed root", async () => {
    const baseValue = {
      同時更新イベント: { generation: "common-base" },
    };
    const writerAValue = {
      同時更新イベント: { generation: "writer-a" },
    };
    const writerBValue = {
      同時更新イベント: { generation: "writer-b" },
    };
    const bootstrapDb = await importFreshDb();
    await bootstrapDb.saveEventMetadata(baseValue);

    vi.resetModules();
    const writerA = await importFreshDb();
    expect(await writerA.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: baseValue,
    });
    vi.resetModules();
    const writerB = await importFreshDb();
    expect(await writerB.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: baseValue,
    });

    await writerA.saveEventMetadata(writerAValue);
    const writerARevision = await readCurrentRevision("eventMetadata");
    await expect(writerB.saveEventMetadata(writerBValue)).rejects.toMatchObject(
      {
        name: "PersistenceConflict",
      },
    );

    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      writerAValue,
    );
    expect(await readCurrentRevision("eventMetadata")).toBe(writerARevision);
    expect(getRuntimeFallbackKeys("eventMetadata")).toEqual([]);
  });

  it("rejects a save when IndexedDB and fallback localStorage both fail", async () => {
    const initialMetadata = {
      容量失敗イベント: { generation: "idb-original" },
    };
    const nextMetadata = {
      容量失敗イベント: { generation: "must-not-report-success" },
    };
    const db = await importFreshDb();
    await db.saveEventMetadata(initialMetadata);
    const indexedDbError = new DOMException(
      "forced IndexedDB write failure",
      "UnknownError",
    );
    const writeFailure = mockStoreWriteFailures(
      "eventMetadata",
      indexedDbError,
    );
    const quotaError = new DOMException(
      "fallback quota exceeded",
      "QuotaExceededError",
    );
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw quotaError;
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(db.saveEventMetadata(nextMetadata)).rejects.toBeDefined();
    expect(writeFailure.getFailureCount()).toBeGreaterThan(0);
    expect(setItemSpy).toHaveBeenCalled();
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      initialMetadata,
    );
    expect(localStorage.length).toBe(0);
  });

  it("rejects a normal store save against v8 without writing any localStorage fallback", async () => {
    await seedDatabase(UNSUPPORTED_DATABASE_VERSION);
    const db = await importFreshDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      db.saveEventMetadata({
        将来DBイベント: { mustNotFallback: true },
      }),
    ).rejects.toMatchObject({ name: "VersionError" });
    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem("eventMetadata")).toBeNull();
    expect(
      await readRawRecordAtExistingVersion("eventMetadata", DATA_KEY),
    ).toBeUndefined();
  });
});
