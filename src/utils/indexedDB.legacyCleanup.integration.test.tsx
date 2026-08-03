// @vitest-environment jsdom

import {
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION,
  type PersistenceCleanupLock,
  type PersistenceCleanupLockManager,
  type PersistenceCleanupMetricEvent,
} from "./persistenceCleanupCoordinator";

const DATABASE_NAME = "EventShoppingPlannerDB";
const LEGACY_MIGRATION_JOURNAL_KEY =
  "__esp_internal__:migration:v1:legacy-local-storage";
const LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX =
  "__esp_internal__:migration-archive:v1:";
const EVENT_LISTS_KEY = "eventShoppingLists";
const EVENT_METADATA_KEY = "eventMetadata";
const LEGACY_SYNC_QUEUE_KEY = "syncQueue";

const EVENT_LISTS_SOURCE = JSON.stringify({
  cleanupイベント: [{ id: "cleanup-item", title: "安全に移行済みの頒布物" }],
});
const EVENT_METADATA_SOURCE = JSON.stringify({
  cleanupイベント: { title: "安全に移行済みのイベント" },
});
const LEGACY_SYNC_QUEUE_SOURCE = '{"pending":[{"id":"legacy-sync-operation"}]}';

type DbApi = (typeof import("./indexedDB"))["db"];
type ManualCleanupSafetyRequest = Extract<
  import("./indexedDB").PersistenceLegacyCleanupSafetyRequest,
  { mode: "manual" }
>;

interface TestMigrationJournalEntry {
  legacyKey: string;
  cleanupStatus: "pending" | "deferred" | "in-progress" | "removed";
}

interface TestMigrationJournal {
  schemaVersion: number;
  phase:
    | "prepared"
    | "copied"
    | "verified"
    | "cleanup-ready"
    | "cleanup-in-progress"
    | "completed";
  cleanupStatus:
    | "not-ready"
    | "ready"
    | "deferred"
    | "in-progress"
    | "completed";
  archiveKey: string;
  entries: TestMigrationJournalEntry[];
}

let databaseFactory: IDBFactory;

async function importFreshDb(): Promise<DbApi> {
  return (await import("./indexedDB")).db;
}

function requestRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = databaseFactory.open(DATABASE_NAME);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open test database."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRawRecord(
  storeName: string,
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
        reject(request.error ?? new Error("Failed to read test record."));
      request.onsuccess = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

async function writeRawRecord(
  storeName: string,
  key: IDBValidKey,
  value: unknown,
): Promise<void> {
  const database = await requestRawDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).put(value, key);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to write test record."));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          transaction.error ??
            request.error ??
            new Error("Failed to commit test record."),
        );
    });
  } finally {
    database.close();
  }
}

async function readMigrationJournal(): Promise<TestMigrationJournal> {
  const value = await readRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY);
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 2 ||
    !("archiveKey" in value) ||
    typeof value.archiveKey !== "string" ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Expected a v2 migration journal.");
  }
  return structuredClone(value) as TestMigrationJournal;
}

function createManualSafetyRequest(
  overrides: Partial<ManualCleanupSafetyRequest> = {},
): ManualCleanupSafetyRequest {
  return {
    mode: "manual",
    isRuntimeKillSwitchActive: () => false,
    otherTabsClosedConfirmation: MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION,
    ...overrides,
  };
}

function createUnavailableLockManager(): PersistenceCleanupLockManager {
  return {
    request: async <T,>(
      _name: string,
      _options: {
        readonly mode: "exclusive";
        readonly ifAvailable: true;
      },
      callback: (lock: PersistenceCleanupLock | null) => T | PromiseLike<T>,
    ): Promise<T> => await callback(null),
  };
}

async function prepareMigration({
  eventLists = false,
  eventMetadata = true,
  syncQueue = false,
}: {
  eventLists?: boolean;
  eventMetadata?: boolean;
  syncQueue?: boolean;
} = {}): Promise<DbApi> {
  if (eventLists) {
    localStorage.setItem(EVENT_LISTS_KEY, EVENT_LISTS_SOURCE);
  }
  if (eventMetadata) {
    localStorage.setItem(EVENT_METADATA_KEY, EVENT_METADATA_SOURCE);
  }
  if (syncQueue) {
    localStorage.setItem(LEGACY_SYNC_QUEUE_KEY, LEGACY_SYNC_QUEUE_SOURCE);
  }

  const db = await importFreshDb();
  await expect(db.migrateFromLocalStorage()).resolves.toMatchObject({
    status: "cleanup-pending",
    dataMigrationStatus:
      eventLists || eventMetadata ? "verified" : "not-needed",
    cleanupStatus: "deferred",
  });
  return db;
}

beforeEach(() => {
  databaseFactory = new IDBFactory();
  vi.stubGlobal("indexedDB", databaseFactory);
  vi.resetModules();
  vi.stubEnv("VITE_PERSISTENCE_LEGACY_CLEANUP", "true");
  vi.stubEnv("VITE_PERSISTENCE_RELEASE_CHANNEL", "release-b");
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe("db.cleanupLegacyPersistenceSources Release B", () => {
  it("keeps physical cleanup forced OFF in a Release A artifact", async () => {
    vi.stubEnv("VITE_PERSISTENCE_RELEASE_CHANNEL", "release-a");
    vi.stubEnv("VITE_PERSISTENCE_LEGACY_CLEANUP", "true");
    const db = await prepareMigration();
    const cleanupBefore = (
      await import("./persistenceReleaseAMetrics")
    ).getPersistenceReleaseAMetricsSnapshot().counters.cleanup;

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "feature-flag-disabled",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    const cleanupAfter = (
      await import("./persistenceReleaseAMetrics")
    ).getPersistenceReleaseAMetricsSnapshot().counters.cleanup;
    expect(cleanupAfter.attempted - cleanupBefore.attempted).toBe(1);
    expect(cleanupAfter.blocked - cleanupBefore.blocked).toBe(1);
    expect(
      cleanupAfter.keyConfirmedRemoved - cleanupBefore.keyConfirmedRemoved,
    ).toBe(0);
    expect(cleanupAfter.completed - cleanupBefore.completed).toBe(0);
  });

  it("keeps the production build flag OFF despite a runtime override attempt", async () => {
    vi.stubEnv("VITE_PERSISTENCE_LEGACY_CLEANUP", "false");
    const db = await prepareMigration();
    const runtimeBypassAttempt = {
      ...createManualSafetyRequest(),
      buildFlagValue: "true",
    } as unknown as ManualCleanupSafetyRequest;

    const result =
      await db.cleanupLegacyPersistenceSources(runtimeBypassAttempt);

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "feature-flag-disabled",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
  });

  it("requires explicit manual confirmation and an exclusive lock when Web Locks exist", async () => {
    const db = await prepareMigration();

    const unconfirmed = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest({
        otherTabsClosedConfirmation: undefined,
      }),
    );
    expect(unconfirmed).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "manual-other-tabs-not-confirmed",
      removedKeys: [],
    });

    const navigatorWithLocks = Object.create(navigator) as Navigator & {
      locks: PersistenceCleanupLockManager;
    };
    Object.defineProperty(navigatorWithLocks, "locks", {
      configurable: true,
      value: createUnavailableLockManager(),
    });
    vi.stubGlobal("navigator", navigatorWithLocks);
    const runtimeLockBypassAttempt = {
      ...createManualSafetyRequest(),
      lockManager: null,
    } as unknown as ManualCleanupSafetyRequest;
    const unavailable = await db.cleanupLegacyPersistenceSources(
      runtimeLockBypassAttempt,
    );
    expect(unavailable).toEqual({
      status: "cleanup-deferred",
      mode: "manual",
      reason: "exclusive-lock-unavailable",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
  });

  it("cleans verified sources in journal order and never deletes legacy syncQueue", async () => {
    const db = await prepareMigration({
      eventLists: true,
      eventMetadata: true,
      syncQueue: true,
    });
    const journalBefore = await readMigrationJournal();
    const archiveBefore = await readRawRecord(
      "syncQueue",
      journalBefore.archiveKey,
    );
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");
    const metrics: PersistenceCleanupMetricEvent[] = [];

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest({
        metricSink: (event) => {
          metrics.push(event);
        },
      }),
    );

    expect(result).toEqual({
      status: "completed",
      mode: "manual",
      removedKeys: [EVENT_LISTS_KEY, EVENT_METADATA_KEY],
    });
    expect(localStorage.getItem(EVENT_LISTS_KEY)).toBeNull();
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_SYNC_QUEUE_KEY)).toBe(
      LEGACY_SYNC_QUEUE_SOURCE,
    );
    expect(
      removeItemSpy.mock.calls
        .map(([key]) => key)
        .filter((key) => [EVENT_LISTS_KEY, EVENT_METADATA_KEY].includes(key)),
    ).toEqual([EVENT_LISTS_KEY, EVENT_METADATA_KEY]);
    expect(removeItemSpy).not.toHaveBeenCalledWith(LEGACY_SYNC_QUEUE_KEY);
    expect(await readRawRecord("syncQueue", journalBefore.archiveKey)).toEqual(
      archiveBefore,
    );
    expect(await readMigrationJournal()).toMatchObject({
      phase: "completed",
      cleanupStatus: "completed",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_LISTS_KEY,
          cleanupStatus: "removed",
        }),
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "removed",
        }),
      ],
    });
    expect(metrics.map(({ name }) => name)).toEqual([
      "persistence-cleanup-attempted",
      "persistence-cleanup-task-started",
      "persistence-cleanup-key-confirmed-removed",
      "persistence-cleanup-key-confirmed-removed",
      "persistence-cleanup-completed",
    ]);
    metrics.forEach((event) => {
      expect(event).not.toHaveProperty("payload");
      expect(event).not.toHaveProperty("legacyKey");
      expect(event).not.toHaveProperty("rawValue");
      expect(event).not.toHaveProperty("error");
    });
  });

  it("records a confirmed removal centrally without a caller metric sink", async () => {
    const db = await prepareMigration();
    const before = (
      await import("./persistenceReleaseAMetrics")
    ).getPersistenceReleaseAMetricsSnapshot().counters.cleanup;

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "completed",
      mode: "manual",
      removedKeys: [EVENT_METADATA_KEY],
    });
    const after = (
      await import("./persistenceReleaseAMetrics")
    ).getPersistenceReleaseAMetricsSnapshot().counters.cleanup;
    expect(after.attempted - before.attempted).toBe(1);
    expect(after.taskStarted - before.taskStarted).toBe(1);
    expect(after.keyConfirmedRemoved - before.keyConfirmedRemoved).toBe(1);
    expect(after.completed - before.completed).toBe(1);
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBeNull();
  });

  it("completes a syncQueue-only journal while retaining its archived source", async () => {
    const db = await prepareMigration({
      eventMetadata: false,
      syncQueue: true,
    });
    const journalBefore = await readMigrationJournal();
    expect(journalBefore.entries).toEqual([]);
    const archiveBefore = await readRawRecord(
      "syncQueue",
      journalBefore.archiveKey,
    );
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "completed",
      mode: "manual",
      removedKeys: [],
    });
    expect(localStorage.getItem(LEGACY_SYNC_QUEUE_KEY)).toBe(
      LEGACY_SYNC_QUEUE_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(LEGACY_SYNC_QUEUE_KEY);
    expect(await readRawRecord("syncQueue", journalBefore.archiveKey)).toEqual(
      archiveBefore,
    );
    expect(await readMigrationJournal()).toMatchObject({
      phase: "completed",
      cleanupStatus: "completed",
      entries: [],
    });
  });

  it("defers a huge syncQueue-only archive quota failure without blocking app startup", async () => {
    const hugeLegacySyncQueueSource = JSON.stringify({
      pending: "x".repeat(256 * 1024),
    });
    localStorage.setItem(LEGACY_SYNC_QUEUE_KEY, hugeLegacySyncQueueSource);
    const originalPut = FakeIDBObjectStore.prototype.put;
    let archiveFailureCount = 0;
    let appStorePutCount = 0;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      requestKey?: IDBValidKey,
    ) {
      if (this.name !== "syncQueue") appStorePutCount += 1;
      if (
        archiveFailureCount === 0 &&
        this.name === "syncQueue" &&
        typeof requestKey === "string" &&
        requestKey.startsWith(LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX)
      ) {
        archiveFailureCount += 1;
        throw new DOMException(
          "forced standalone archive quota failure",
          "QuotaExceededError",
        );
      }
      return requestKey === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, requestKey);
    });
    const db = await importFreshDb();

    const result = await db.migrateFromLocalStorage();

    expect(result).toEqual({
      status: "cleanup-pending",
      dataMigrationStatus: "not-needed",
      cleanupStatus: "deferred",
      cleanupDeferredReason: "legacy-sync-queue-archive-unavailable",
      migratedKeys: [],
    });
    expect(archiveFailureCount).toBe(1);
    expect(appStorePutCount).toBe(0);
    expect(localStorage.getItem(LEGACY_SYNC_QUEUE_KEY)).toBe(
      hugeLegacySyncQueueSource,
    );
    expect(await readRawRecord("syncQueue", "data")).toBeUndefined();
    const journal = await readMigrationJournal();
    expect(journal).toMatchObject({
      phase: "prepared",
      cleanupStatus: "not-ready",
      entries: [],
    });
    expect(
      await readRawRecord("syncQueue", journal.archiveKey),
    ).toBeUndefined();
  });

  it("accepts a valid committed descendant created by a normal save after migration", async () => {
    const db = await prepareMigration();
    const newerMetadata = {
      cleanupイベント: {
        title: "Release A後に通常保存された新しいイベント",
        generation: 2,
      },
    };
    await db.saveEventMetadata(newerMetadata);

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "completed",
      mode: "manual",
      removedKeys: [EVENT_METADATA_KEY],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBeNull();
    await expect(db.loadEventMetadata()).resolves.toMatchObject({
      status: "ok",
      data: newerMetadata,
    });
  });

  it("rechecks the runtime kill switch between journal entries", async () => {
    const db = await prepareMigration({
      eventLists: true,
      eventMetadata: true,
    });
    const killSwitch = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(true);
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest({
        isRuntimeKillSwitchActive: killSwitch,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "runtime-kill-switch-active",
      removedKeys: [EVENT_LISTS_KEY],
    });
    expect(killSwitch).toHaveBeenCalledTimes(6);
    expect(localStorage.getItem(EVENT_LISTS_KEY)).toBeNull();
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      cleanupStatus: "in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_LISTS_KEY,
          cleanupStatus: "removed",
        }),
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "deferred",
        }),
      ],
    });
  });

  it("revalidates safety immediately before removeItem and preserves a claimed source when stopped", async () => {
    const db = await prepareMigration();
    const killSwitch = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(true);
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest({
        isRuntimeKillSwitchActive: killSwitch,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "runtime-kill-switch-active",
      removedKeys: [],
    });
    expect(killSwitch).toHaveBeenCalledTimes(5);
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      cleanupStatus: "in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "in-progress",
        }),
      ],
    });
  });

  it("re-reads the source after async safety proof and preserves a value changed during revalidation", async () => {
    const db = await prepareMigration();
    const changedDuringProof = '{"newer":"別clientの保存"}';
    let killSwitchChecks = 0;
    const killSwitch = vi.fn(() => {
      killSwitchChecks += 1;
      if (killSwitchChecks === 5) {
        localStorage.setItem(EVENT_METADATA_KEY, changedDuringProof);
      }
      return false;
    });
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest({
        isRuntimeKillSwitchActive: killSwitch,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "legacy-source-changed",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(changedDuringProof);
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      cleanupStatus: "in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "in-progress",
        }),
      ],
    });
  });

  it("stops at a removeItem failure, retains the source, and does not touch later keys", async () => {
    const db = await prepareMigration({
      eventLists: true,
      eventMetadata: true,
    });
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === EVENT_LISTS_KEY) {
          throw new Error(`秘密のraw値: ${EVENT_LISTS_SOURCE}`);
        }
        originalRemoveItem.call(this, key);
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const metrics: PersistenceCleanupMetricEvent[] = [];

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest({
        metricSink: (event) => {
          metrics.push(event);
        },
      }),
    );

    expect(result).toEqual({
      status: "cleanup-deferred",
      mode: "manual",
      reason: "legacy-source-remove-failed",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_LISTS_KEY)).toBe(EVENT_LISTS_SOURCE);
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_LISTS_KEY,
          cleanupStatus: "in-progress",
        }),
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "deferred",
        }),
      ],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(metrics)).not.toContain(EVENT_LISTS_SOURCE);
    expect(metrics).not.toContainEqual(
      expect.objectContaining({
        name: "persistence-cleanup-completed",
      }),
    );
    expect(metrics).toContainEqual({
      name: "persistence-cleanup-physical-deferred",
      mode: "manual",
      reason: "legacy-source-remove-failed",
    });
  });

  it("stops when a removed source reappears and preserves it without touching later keys", async () => {
    const db = await prepareMigration({
      eventLists: true,
      eventMetadata: true,
    });
    const reappearedSource = '{"reappeared":"別tabの新しい値"}';
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        originalRemoveItem.call(this, key);
        if (key === EVENT_LISTS_KEY) {
          this.setItem(key, reappearedSource);
        }
      });

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "legacy-source-reappeared",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_LISTS_KEY)).toBe(reappearedSource);
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_LISTS_KEY,
          cleanupStatus: "in-progress",
        }),
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "deferred",
        }),
      ],
    });
  });

  it("resumes an in-progress missing source after the post-delete journal put failed", async () => {
    const db = await prepareMigration();
    const originalPut = FakeIDBObjectStore.prototype.put;
    let injected = false;
    const journalPutSpy = vi
      .spyOn(FakeIDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        requestKey?: IDBValidKey,
      ) {
        const candidate =
          typeof value === "object" && value !== null
            ? (value as {
                phase?: unknown;
                entries?: Array<{ cleanupStatus?: unknown }>;
              })
            : null;
        if (
          !injected &&
          this.name === "syncQueue" &&
          requestKey === LEGACY_MIGRATION_JOURNAL_KEY &&
          candidate?.phase === "cleanup-in-progress" &&
          candidate.entries?.some(
            ({ cleanupStatus }) => cleanupStatus === "removed",
          )
        ) {
          injected = true;
          throw new DOMException(
            "forced post-delete journal failure",
            "UnknownError",
          );
        }
        return requestKey === undefined
          ? originalPut.call(this, value)
          : originalPut.call(this, value, requestKey);
      });

    const interrupted = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(interrupted).toEqual({
      status: "cleanup-deferred",
      mode: "manual",
      reason: "migration-journal-cas-failed",
      removedKeys: [],
    });
    expect(injected).toBe(true);
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBeNull();
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "in-progress",
        }),
      ],
    });
    journalPutSpy.mockRestore();

    vi.resetModules();
    const resumedDb = await importFreshDb();
    const resumedRemoveSpy = vi.spyOn(Storage.prototype, "removeItem");
    const resumed = await resumedDb.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(resumed).toEqual({
      status: "completed",
      mode: "manual",
      removedKeys: [EVENT_METADATA_KEY],
    });
    expect(resumedRemoveSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "completed",
      cleanupStatus: "completed",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "removed",
        }),
      ],
    });
  });

  it("does not confirm an in-progress missing source when archive evidence is invalid", async () => {
    const db = await prepareMigration();
    const journal = await readMigrationJournal();
    await writeRawRecord("syncQueue", LEGACY_MIGRATION_JOURNAL_KEY, {
      ...journal,
      phase: "cleanup-in-progress",
      cleanupStatus: "in-progress",
      entries: journal.entries.map((entry) => ({
        ...entry,
        cleanupStatus: "in-progress",
      })),
    });
    localStorage.removeItem(EVENT_METADATA_KEY);
    const archive = (await readRawRecord("syncQueue", journal.archiveKey)) as {
      entries: Array<Record<string, unknown>>;
    };
    await writeRawRecord("syncQueue", journal.archiveKey, {
      ...archive,
      entries: archive.entries.map((entry, index) =>
        index === 0
          ? { ...entry, rawValue: '{"tampered":"resume evidence"}' }
          : entry,
      ),
    });

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "migration-archive-invalid",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBeNull();
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-in-progress",
      entries: [
        expect.objectContaining({
          legacyKey: EVENT_METADATA_KEY,
          cleanupStatus: "in-progress",
        }),
      ],
    });
  });

  it("preserves a changed source and stops before any deletion", async () => {
    const db = await prepareMigration({
      eventLists: true,
      eventMetadata: true,
    });
    const changedSource = '{"changed":"別tabが保存した値"}';
    localStorage.setItem(EVENT_LISTS_KEY, changedSource);
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "legacy-source-changed",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_LISTS_KEY)).toBe(changedSource);
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_LISTS_KEY);
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
    expect(await readMigrationJournal()).toMatchObject({
      phase: "cleanup-ready",
      cleanupStatus: "deferred",
    });
  });

  it("blocks cleanup when the immutable archive was tampered with", async () => {
    const db = await prepareMigration();
    const journal = await readMigrationJournal();
    const archive = (await readRawRecord("syncQueue", journal.archiveKey)) as {
      entries: Array<Record<string, unknown>>;
    };
    await writeRawRecord("syncQueue", journal.archiveKey, {
      ...archive,
      entries: archive.entries.map((entry, index) =>
        index === 0 ? { ...entry, rawValue: '{"tampered":true}' } : entry,
      ),
    });
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "migration-archive-invalid",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
  });

  it("blocks cleanup when the committed target no longer validates", async () => {
    const db = await prepareMigration();
    await writeRawRecord("eventMetadata", "data", {
      tampered: "committed target replacement",
    });
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");

    const result = await db.cleanupLegacyPersistenceSources(
      createManualSafetyRequest(),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "committed-target-invalid",
      removedKeys: [],
    });
    expect(localStorage.getItem(EVENT_METADATA_KEY)).toBe(
      EVENT_METADATA_SOURCE,
    );
    expect(removeItemSpy).not.toHaveBeenCalledWith(EVENT_METADATA_KEY);
  });
});
