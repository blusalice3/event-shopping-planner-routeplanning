// @vitest-environment jsdom

import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceMetadataKey,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  createRuntimeFallbackPrefix,
  serializeRuntimeFallbackCandidate,
} from "./persistenceResilience";

const DATABASE_NAME = "EventShoppingPlannerDB";
const CURRENT_DATABASE_VERSION = 5;
const UNSUPPORTED_DATABASE_VERSION = 8;
const DATA_KEY = "data";
const LEGACY_MIGRATION_JOURNAL_KEY =
  "__esp_internal__:migration:v1:legacy-local-storage";

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

function mockJournalPhasePutFailure(phase: string, error: Error) {
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

  vi.resetModules();
  const idempotencyDb = await importFreshDb();
  const idempotentMigration = await idempotencyDb.migrateFromLocalStorage();
  expect(idempotentMigration).toMatchObject({ status: "cleanup-pending" });
  expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
    expectedPayload,
  );
  expect(await readCurrentRevision("eventMetadata")).toBe(resumedRevision);
  expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
  return resumedRevision;
}

beforeEach(() => {
  databaseFactory = new IDBFactory();
  vi.stubGlobal("indexedDB", databaseFactory);
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe("db.migrateFromLocalStorage resilience", () => {
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

    expect(migration).toMatchObject({ status: "recovery-required" });
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

    expect(migration).toMatchObject({ status: "recovery-required" });
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

  it("resumes idempotently from a verified migration journal", async () => {
    const metadata = {
      verified再開イベント: { phase: "verified" },
    };
    const legacySource = JSON.stringify(metadata);
    localStorage.setItem("eventMetadata", legacySource);
    const cleanupPendingFailure = mockJournalPhasePutFailure(
      "cleanupPending",
      new DOMException(
        "forced cleanup-pending journal failure",
        "UnknownError",
      ),
    );
    const db = await importFreshDb();

    const failedMigration = await db.migrateFromLocalStorage();

    expect(failedMigration).toMatchObject({ status: "recovery-required" });
    expect(cleanupPendingFailure.getInjectionCount()).toBe(1);
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({ phase: "verified" });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    const verifiedRevision = await readCurrentRevision("eventMetadata");
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
    cleanupPendingFailure.spy.mockRestore();

    await resumeEventMetadataMigrationAndAssertStable({
      expectedPayload: metadata,
      legacySource,
      expectedExistingRevision: verifiedRevision,
    });
  });

  it("resumes partial explicit cleanup without rewriting committed revisions", async () => {
    const eventLists = {
      cleanup再開イベント: [{ id: "cleanup-item", title: "削除済み原本" }],
    };
    const metadata = {
      cleanup再開イベント: { title: "再開時に削除する原本" },
    };
    const listSource = JSON.stringify(eventLists);
    const metadataSource = JSON.stringify(metadata);
    localStorage.setItem("eventShoppingLists", listSource);
    localStorage.setItem("eventMetadata", metadataSource);
    const cleanupError = new DOMException(
      "forced legacy cleanup failure",
      "SecurityError",
    );
    const originalRemoveItem = Storage.prototype.removeItem;
    let failedCleanupAttempts = 0;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, storageKey: string) {
        if (storageKey === "eventMetadata") {
          failedCleanupAttempts += 1;
          throw cleanupError;
        }
        return originalRemoveItem.call(this, storageKey);
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await importFreshDb();

    const partialCleanup = await db.migrateFromLocalStorage({
      cleanupLegacySources: true,
    });

    expect(partialCleanup).toMatchObject({ status: "cleanup-pending" });
    expect(failedCleanupAttempts).toBeGreaterThan(0);
    expect(localStorage.getItem("eventShoppingLists")).toBeNull();
    expect(localStorage.getItem("eventMetadata")).toBe(metadataSource);
    expect(await readRawRecord("eventLists", DATA_KEY)).toEqual(eventLists);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(metadata);
    const listRevision = await readCurrentRevision("eventLists");
    const metadataRevision = await readCurrentRevision("eventMetadata");
    expect(
      await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY),
    ).toMatchObject({
      phase: "cleanupPending",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventShoppingLists",
          cleanupStatus: "removed",
        }),
        expect.objectContaining({
          legacyKey: "eventMetadata",
          cleanupStatus: "pending",
        }),
      ]),
    });
    removeItemSpy.mockRestore();

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const completedCleanup = await resumedDb.migrateFromLocalStorage({
      cleanupLegacySources: true,
    });

    expect(completedCleanup).toMatchObject({ status: "completed" });
    expect(localStorage.getItem("eventShoppingLists")).toBeNull();
    expect(localStorage.getItem("eventMetadata")).toBeNull();
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
    ).toMatchObject({ status: "completed" });
    expect(await readCurrentRevision("eventLists")).toBe(listRevision);
    expect(await readCurrentRevision("eventMetadata")).toBe(metadataRevision);
  });

  it("detects a legacy source change during cleanup-pending CAS and preserves the current raw value", async () => {
    const capturedMetadata = {
      TOCTOUイベント: { generation: "captured-source" },
    };
    const currentMetadata = {
      TOCTOUイベント: { generation: "concurrent-current-source" },
    };
    const capturedSource = JSON.stringify(capturedMetadata);
    const currentSource = JSON.stringify(currentMetadata);
    localStorage.setItem("eventMetadata", capturedSource);
    const sourceChange = mockJournalPhasePutSideEffect("cleanupPending", () => {
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
    ).toMatchObject({ phase: "cleanupPending" });
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
    const loadedMap = await db.loadMapData();
    expect(loadedMap.status).toBe("ok");
    expect(loadedMap.data).toEqual(idbMap);
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

  it("resumes cleanup-pending when an older tab has already removed the legacy source", async () => {
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
      phase: "cleanupPending",
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
      phase: "cleanupPending",
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
      phase: "cleanupPending",
      entries: expect.arrayContaining([
        expect.objectContaining({
          legacyKey: "eventMetadata",
          rawValue: legacySource,
        }),
      ]),
    });
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
});

describe("db runtime fallback resilience", () => {
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
      候補追記イベント: { generation: "latest-candidate-a" },
    };
    const candidateBValue = {
      候補追記イベント: { generation: "uncommitted-candidate-b" },
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
    const quotaError = new DOMException(
      "candidate B quota exceeded",
      "QuotaExceededError",
    );
    const attemptedStorageKeys: string[] = [];
    const appendSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((storageKey) => {
        attemptedStorageKeys.push(storageKey);
        throw quotaError;
      });

    await expect(db.saveEventMetadata(candidateBValue)).rejects.toMatchObject({
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
          storageKey !== candidateA.storageKey,
      ),
    ).toBe(true);
    expect(localStorage.getItem(candidateA.storageKey)).toBe(
      candidateA.serialized,
    );
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(idbValue);
    expect(await readCurrentRevision("eventMetadata")).toBe(baseRevision);
    expect(getRuntimeFallbackKeys("eventMetadata")).toEqual([
      candidateA.storageKey,
    ]);

    writeFailure.spy.mockRestore();
    appendSpy.mockRestore();
    expect(await db.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: candidateAValue,
    });
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
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    await expect(
      db.saveEventMetadata({
        将来DBイベント: { mustNotFallback: true },
      }),
    ).rejects.toMatchObject({ name: "VersionError" });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("eventMetadata")).toBeNull();
    expect(
      await readRawRecordAtExistingVersion("eventMetadata", DATA_KEY),
    ).toBeUndefined();
  });
});
