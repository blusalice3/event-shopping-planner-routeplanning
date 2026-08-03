// @vitest-environment jsdom

import {
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceCheckpointKey,
  createPersistenceMetadataKey,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  parseRuntimeFallbackCandidate,
  serializeRuntimeFallbackCandidate,
  serializeStartupRecoveryBundle,
  type StartupRecoveryCandidate,
} from "./persistenceResilience";
import { exportStartupRecoveryBundle } from "./persistenceRecoveryExport";
import d2389a0OrphanFixture from "../test/fixtures/d2389a0-orphan-runtime-fallback.json";

const DATABASE_NAME = "EventShoppingPlannerDB";
const DATA_KEY = "data";
const RECOVERY_ARCHIVE_PREFIX = "__esp_internal__:recovery-adoption:v1:";
const LEGACY_RESOLUTION_PREFIX = "__esp_internal__:migration-resolution:v1:";

type DbApi = (typeof import("./indexedDB"))["db"];

let databaseFactory: IDBFactory;

async function importFreshDb(): Promise<DbApi> {
  return (await import("./indexedDB")).db;
}

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = databaseFactory.open(DATABASE_NAME);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open the test database."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRawRecord(
  storeName: string,
  key: IDBValidKey,
): Promise<unknown> {
  const database = await openRawDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onerror = () =>
        reject(request.error ?? new Error(`Failed to read ${storeName}.`));
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
  const database = await openRawDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error(`Failed to write ${storeName}.`));
      transaction.objectStore(storeName).put(value, key);
    });
  } finally {
    database.close();
  }
}

async function readAllRawRecords(
  storeName: string,
): Promise<Record<string, unknown>> {
  const database = await openRawDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const result: Record<string, unknown> = {};
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).openCursor();
      request.onerror = () =>
        reject(request.error ?? new Error(`Failed to enumerate ${storeName}.`));
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
  } finally {
    database.close();
  }
}

async function readCurrentRevision(storeName: string): Promise<string> {
  const metadata = (await readRawRecord(
    "syncQueue",
    createPersistenceMetadataKey(storeName, DATA_KEY),
  )) as { revision?: unknown };
  if (typeof metadata?.revision !== "string") {
    throw new Error(`Missing revision for ${storeName}.`);
  }
  return metadata.revision;
}

async function installRuntimeCandidate({
  storeName,
  revision,
  baseRevision,
  payload,
}: {
  storeName: string;
  revision: string;
  baseRevision: string | null;
  payload: unknown;
}) {
  const candidate = await createRuntimeFallbackCandidate({
    storeName,
    key: DATA_KEY,
    revision,
    baseRevision,
    writerId: `writer-${revision}`,
    createdAt: "2026-08-03T00:00:00.000Z",
    payload,
  });
  const storageKey = createRuntimeFallbackKey(storeName, DATA_KEY, revision);
  const rawValue = serializeRuntimeFallbackCandidate(candidate);
  localStorage.setItem(storageKey, rawValue);
  return { candidate, storageKey, rawValue };
}

async function prepareRuntimeMetadataConflict() {
  const committed = {
    復旧イベント: { generation: "committed" },
  };
  const selected = {
    復旧イベント: {
      generation: "selected",
      secret: "payload本文をIDへ混入させない",
    },
  };
  const sibling = {
    復旧イベント: { generation: "sibling" },
  };
  const initialDb = await importFreshDb();
  await initialDb.saveEventMetadata(committed);
  const baseRevision = await readCurrentRevision("eventMetadata");
  const selectedSource = await installRuntimeCandidate({
    storeName: "eventMetadata",
    revision: "selected-recovery-branch",
    baseRevision,
    payload: selected,
  });
  const siblingSource = await installRuntimeCandidate({
    storeName: "eventMetadata",
    revision: "sibling-recovery-branch",
    baseRevision,
    payload: sibling,
  });

  vi.resetModules();
  const recoveryDb = await importFreshDb();
  const loaded = await recoveryDb.loadEventMetadata();
  expect(loaded.status).toBe("conflict");
  const candidate = loaded.recoveryBundle?.candidates.find(
    ({ source, revision }) =>
      source === "runtime-fallback" &&
      revision === selectedSource.candidate.revision,
  );
  if (!candidate) throw new Error("Missing selected recovery candidate.");
  return {
    recoveryDb,
    committed,
    selected,
    candidate,
    selectedSource,
    siblingSource,
  };
}

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

describe("explicit recovery candidate adoption", () => {
  it("adopts an exact runtime source, archives evidence atomically, and retains every original", async () => {
    const { recoveryDb, selected, candidate, selectedSource, siblingSource } =
      await prepareRuntimeMetadataConflict();

    expect(candidate).toMatchObject({
      role: "app-payload",
      adoptable: true,
      sourceKey: selectedSource.storageKey,
      targetKey: DATA_KEY,
      digest: expect.any(String),
    });
    expect(candidate.id).not.toContain("payload本文をIDへ混入させない");
    expect(candidate.id).not.toContain(selectedSource.rawValue);

    const result = await recoveryDb.adoptRecoveryCandidate(candidate);

    expect(result).toMatchObject({
      status: "adopted",
      storeName: "eventMetadata",
      key: DATA_KEY,
      revision: expect.any(String),
      digest: expect.any(String),
      archiveKey: expect.stringMatching(
        /^__esp_internal__:recovery-adoption:v1:/,
      ),
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(selected);
    expect(localStorage.getItem(selectedSource.storageKey)).toBe(
      selectedSource.rawValue,
    );
    expect(localStorage.getItem(siblingSource.storageKey)).toBe(
      siblingSource.rawValue,
    );
    expect(await recoveryDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: selected,
    });
    expect(localStorage.getItem(selectedSource.storageKey)).toBe(
      selectedSource.rawValue,
    );
    expect(localStorage.getItem(siblingSource.storageKey)).toBe(
      siblingSource.rawValue,
    );

    const archive = (await readRawRecord("syncQueue", result.archiveKey)) as {
      kind?: unknown;
      currentEvidence?: unknown;
      observedRuntimeCandidates?: unknown[];
    };
    expect(archive).toMatchObject({
      kind: "event-shopping-planner-recovery-adoption-archive",
      currentEvidence: expect.any(Object),
    });
    expect(archive.observedRuntimeCandidates).toHaveLength(2);

    const checkpoint = (await readRawRecord(
      "syncQueue",
      createPersistenceCheckpointKey("eventMetadata", DATA_KEY),
    )) as { absorbedCandidates?: { revision?: string }[] };
    expect(checkpoint.absorbedCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: "selected-recovery-branch" }),
        expect.objectContaining({ revision: "sibling-recovery-branch" }),
      ]),
    );
  });

  it("rejects a source that changes during the IndexedDB CAS transaction", async () => {
    const { recoveryDb, committed, candidate, selectedSource } =
      await prepareRuntimeMetadataConflict();
    const originalGet = FakeIDBObjectStore.prototype.get;
    let metadataReadCount = 0;
    const changedRawValue = `${selectedSource.rawValue} `;
    vi.spyOn(FakeIDBObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ) {
      if (
        this.name === "syncQueue" &&
        query === createPersistenceMetadataKey("eventMetadata", DATA_KEY)
      ) {
        metadataReadCount += 1;
        if (metadataReadCount === 2) {
          localStorage.setItem(selectedSource.storageKey, changedRawValue);
        }
      }
      return originalGet.call(this, query);
    });

    await expect(
      recoveryDb.adoptRecoveryCandidate(candidate),
    ).rejects.toMatchObject({ name: "PersistenceConflict" });

    expect(metadataReadCount).toBeGreaterThanOrEqual(2);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(committed);
    const controlRecords = await readAllRawRecords("syncQueue");
    expect(
      Object.keys(controlRecords).some((key) =>
        key.startsWith(RECOVERY_ARCHIVE_PREFIX),
      ),
    ).toBe(false);
    expect(localStorage.getItem(selectedSource.storageKey)).toBe(
      changedRawValue,
    );
  });

  it("rolls back payload, metadata, and checkpoint when archive creation fails", async () => {
    const { recoveryDb, committed, candidate, selectedSource, siblingSource } =
      await prepareRuntimeMetadataConflict();
    const originalRevision = await readCurrentRevision("eventMetadata");
    const originalAdd = FakeIDBObjectStore.prototype.add;
    let injectionCount = 0;
    vi.spyOn(FakeIDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (
        this.name === "syncQueue" &&
        typeof key === "string" &&
        key.startsWith(RECOVERY_ARCHIVE_PREFIX)
      ) {
        injectionCount += 1;
        throw new DOMException("archive write failed", "QuotaExceededError");
      }
      return key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
    });

    await expect(
      recoveryDb.adoptRecoveryCandidate(candidate),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(injectionCount).toBe(1);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(committed);
    expect(await readCurrentRevision("eventMetadata")).toBe(originalRevision);
    expect(localStorage.getItem(selectedSource.storageKey)).toBe(
      selectedSource.rawValue,
    );
    expect(localStorage.getItem(siblingSource.storageKey)).toBe(
      siblingSource.rawValue,
    );
    const controlRecords = await readAllRawRecords("syncQueue");
    expect(
      Object.keys(controlRecords).some((key) =>
        key.startsWith(RECOVERY_ARCHIVE_PREFIX),
      ),
    ).toBe(false);
    expect(
      Object.keys(controlRecords).some((key) =>
        key.startsWith(LEGACY_RESOLUTION_PREFIX),
      ),
    ).toBe(false);
  });

  it("rolls back the adopted root and archive when the legacy resolution write fails", async () => {
    const committed = {
      原子的競合解決イベント: { generation: "indexed-db" },
    };
    const legacy = {
      原子的競合解決イベント: { generation: "legacy" },
    };
    const legacySource = JSON.stringify(legacy);
    const initialDb = await importFreshDb();
    await initialDb.saveEventMetadata(committed);
    const originalRevision = await readCurrentRevision("eventMetadata");
    const metadataKey = createPersistenceMetadataKey("eventMetadata", DATA_KEY);
    const checkpointKey = createPersistenceCheckpointKey(
      "eventMetadata",
      DATA_KEY,
    );
    const originalMetadata = await readRawRecord("syncQueue", metadataKey);
    const originalCheckpoint = await readRawRecord("syncQueue", checkpointKey);
    localStorage.setItem("eventMetadata", legacySource);
    const migration = await initialDb.migrateFromLocalStorage();
    expect(migration.status).toBe("recovery-required");
    if (migration.status !== "recovery-required") {
      throw new Error("Expected a legacy migration conflict.");
    }
    const candidate = migration.recoveryBundle.candidates.find(
      ({ source, role, storeName }) =>
        source === "indexedDB" &&
        role === "app-payload" &&
        storeName === "eventMetadata",
    );
    if (!candidate) {
      throw new Error("Missing IndexedDB legacy conflict candidate.");
    }

    const originalPut = FakeIDBObjectStore.prototype.put;
    let injectionCount = 0;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (
        this.name === "syncQueue" &&
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind ===
          "event-shopping-planner-legacy-migration-conflict-resolution"
      ) {
        injectionCount += 1;
        throw new DOMException("resolution write failed", "QuotaExceededError");
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    });

    await expect(
      initialDb.adoptRecoveryCandidate(candidate),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(injectionCount).toBe(1);
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(committed);
    expect(await readCurrentRevision("eventMetadata")).toBe(originalRevision);
    expect(await readRawRecord("syncQueue", metadataKey)).toEqual(
      originalMetadata,
    );
    expect(await readRawRecord("syncQueue", checkpointKey)).toEqual(
      originalCheckpoint,
    );
    const controlRecords = await readAllRawRecords("syncQueue");
    expect(
      Object.keys(controlRecords).some((key) =>
        key.startsWith(RECOVERY_ARCHIVE_PREFIX),
      ),
    ).toBe(false);
    expect(
      Object.keys(controlRecords).some((key) =>
        key.startsWith(LEGACY_RESOLUTION_PREFIX),
      ),
    ).toBe(false);
    expect(localStorage.getItem("eventMetadata")).toBe(legacySource);
    await expect(initialDb.migrateFromLocalStorage()).resolves.toMatchObject({
      status: "recovery-required",
    });
  });

  it("adopts a live IndexedDB app payload but rejects its control-record candidate", async () => {
    const payload = {
      IndexedDB復旧イベント: { marker: "payload" },
    };
    const initialDb = await importFreshDb();
    await initialDb.saveEventMetadata(payload);
    await writeRawRecord(
      "syncQueue",
      createPersistenceCheckpointKey("eventMetadata", DATA_KEY),
      { corrupted: true },
    );

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const loaded = await recoveryDb.loadEventMetadata();
    expect(loaded.status).toBe("conflict");
    const payloadCandidate = loaded.recoveryBundle?.candidates.find(
      ({ role }) => role === "app-payload",
    );
    const controlCandidate = loaded.recoveryBundle?.candidates.find(
      ({ role }) => role === "persistence-checkpoint",
    );
    if (!payloadCandidate || !controlCandidate) {
      throw new Error("Missing IndexedDB recovery candidates.");
    }
    expect(payloadCandidate.adoptable).toBe(true);
    expect(controlCandidate.adoptable).toBe(false);

    await expect(
      recoveryDb.adoptRecoveryCandidate(controlCandidate),
    ).rejects.toMatchObject({ name: "PersistenceConflict" });
    await expect(
      recoveryDb.adoptRecoveryCandidate({
        ...payloadCandidate,
        payload: { tampered: true },
      }),
    ).rejects.toMatchObject({ name: "PersistenceConflict" });

    const result = await recoveryDb.adoptRecoveryCandidate(payloadCandidate);
    expect(result.status).toBe("adopted");
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(payload);
  });

  it("normalizes an adopted map payload into the shared split physical form", async () => {
    const eventName = "復旧マップイベント";
    const dayMapName = "1日目";
    const selected = {
      [eventName]: { [dayMapName]: makeDayMap("selected") },
      空イベント: {},
    };
    const initialDb = await importFreshDb();
    await initialDb.loadMapData();
    await writeRawRecord("mapData", DATA_KEY, selected);
    await writeRawRecord(
      "syncQueue",
      createPersistenceCheckpointKey("mapData", DATA_KEY),
      { orphaned: true },
    );

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const loaded = await recoveryDb.loadMapData();
    expect(loaded.status).toBe("conflict");
    const candidate = loaded.recoveryBundle?.candidates.find(
      ({ source, role }) => source === "indexedDB" && role === "app-payload",
    );
    if (!candidate) throw new Error("Missing selected map candidate.");

    await recoveryDb.adoptRecoveryCandidate(candidate);

    const physical = await readAllRawRecords("mapData");
    expect(physical[DATA_KEY]).toBeUndefined();
    expect(
      physical[`mapData:${JSON.stringify([eventName, dayMapName])}`],
    ).toBeDefined();
    expect(
      Object.keys(physical).some((key) => key.includes("空イベント")),
    ).toBe(false);
    expect(await recoveryDb.loadMapData()).toMatchObject({
      status: "ok",
      data: {
        [eventName]: {
          [dayMapName]: expect.objectContaining({
            sheetName: "selectedシート",
          }),
        },
      },
    });
  });

  it("rejects legacy, migration, and ID-only candidate objects", async () => {
    const db = await importFreshDb();
    const unsafeCandidates: StartupRecoveryCandidate[] = [
      {
        id: "legacy",
        source: "legacy-localStorage",
        role: "legacy-migration-source",
        adoptable: false,
        storeName: "eventMetadata",
        key: "eventMetadata",
        sourceKey: "eventMetadata",
        targetKey: DATA_KEY,
        rawValue: '{"unsafe":true}',
      },
      {
        id: "journal",
        source: "migration-journal",
        role: "migration-journal",
        adoptable: false,
        storeName: "syncQueue",
        key: "__esp_internal__:migration:v1:legacy-local-storage",
        sourceKey: "__esp_internal__:migration:v1:legacy-local-storage",
      },
      {
        id: "id-only",
        source: "indexedDB",
      },
    ];

    for (const candidate of unsafeCandidates) {
      await expect(db.adoptRecoveryCandidate(candidate)).rejects.toMatchObject({
        name: "PersistenceConflict",
      });
    }
    expect(localStorage.getItem("eventMetadata")).toBeNull();
  });
});

describe("d2389a0 orphan recovery E2E fixture", () => {
  it("detects the orphan, exports JSON, and adopts only the explicitly selected live candidate", async () => {
    const committed = {
      d2389a0復旧イベント: { generation: "indexed-db-root" },
    };
    const orphanPayload = {
      d2389a0復旧イベント: { generation: "orphan-child-to-adopt" },
    };
    const initialDb = await importFreshDb();
    await initialDb.saveEventMetadata(committed);
    const committedRevision = await readCurrentRevision("eventMetadata");
    const deletedParentKey = createRuntimeFallbackKey(
      "eventMetadata",
      DATA_KEY,
      d2389a0OrphanFixture.deletedParentRevision,
    );
    const orphanCandidate = parseRuntimeFallbackCandidate(
      d2389a0OrphanFixture.rawValue,
      {
        storeName: "eventMetadata",
        key: DATA_KEY,
        revision: d2389a0OrphanFixture.orphanRevision,
      },
    );
    const orphanSource = {
      candidate: orphanCandidate,
      storageKey: d2389a0OrphanFixture.orphanStorageKey,
      rawValue: d2389a0OrphanFixture.rawValue,
    };
    expect(d2389a0OrphanFixture.sourceCommit).toBe(
      "d2389a02363176ba8354c4562f1a669a0b15dab9",
    );
    expect(deletedParentKey).toBe(d2389a0OrphanFixture.deletedParentStorageKey);
    expect(
      createRuntimeFallbackKey(
        orphanCandidate.storeName,
        orphanCandidate.key,
        orphanCandidate.revision,
      ),
    ).toBe(orphanSource.storageKey);
    expect(orphanCandidate).toMatchObject({
      baseRevision: d2389a0OrphanFixture.deletedParentRevision,
      digest: { value: d2389a0OrphanFixture.orphanDigest },
      payload: orphanPayload,
    });
    localStorage.setItem(orphanSource.storageKey, orphanSource.rawValue);
    expect(localStorage.getItem(deletedParentKey)).toBeNull();

    vi.resetModules();
    const recoveryDb = await importFreshDb();
    const loaded = await recoveryDb.loadEventMetadata();

    expect(loaded).toMatchObject({
      status: "conflict",
      data: null,
      recoveryBundle: {
        candidates: expect.arrayContaining([
          expect.objectContaining({
            source: "runtime-fallback",
            role: "app-payload",
            adoptable: true,
            sourceKey: orphanSource.storageKey,
            revision: orphanSource.candidate.revision,
            digest: orphanSource.candidate.digest.value,
          }),
        ]),
      },
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(committed);
    expect(await readCurrentRevision("eventMetadata")).toBe(committedRevision);
    expect(localStorage.getItem(orphanSource.storageKey)).toBe(
      orphanSource.rawValue,
    );
    if (!loaded.recoveryBundle) {
      throw new Error("Missing d2389a0 recovery bundle.");
    }
    const selectedCandidate = loaded.recoveryBundle.candidates.find(
      ({ sourceKey }) => sourceKey === orphanSource.storageKey,
    );
    if (!selectedCandidate) {
      throw new Error("Missing d2389a0 orphan candidate.");
    }

    let exportedJson = "";
    const download = vi.fn();
    const exportResult = exportStartupRecoveryBundle(loaded.recoveryBundle, {
      serialize: (bundle) => {
        exportedJson = serializeStartupRecoveryBundle(bundle);
        return exportedJson;
      },
      download,
      now: () => new Date("2026-08-03T02:03:04.567Z"),
    });

    expect(exportResult).toEqual({
      status: "completed",
      fileName: "event-shopping-planner-recovery-2026-08-03T02-03-04-567Z.json",
      byteSize: expect.any(Number),
    });
    expect(
      exportResult.status === "completed" && exportResult.byteSize,
    ).toBeGreaterThan(0);
    expect(download).toHaveBeenCalledTimes(1);
    const [exportedBlob] = download.mock.calls[0] as [Blob, string];
    expect(exportedBlob).toBeInstanceOf(Blob);
    expect(exportedBlob.size).toBe(
      exportResult.status === "completed" ? exportResult.byteSize : undefined,
    );
    const exportedBundle = JSON.parse(exportedJson) as {
      candidates?: StartupRecoveryCandidate[];
    };
    expect(exportedBundle.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: orphanSource.storageKey,
          revision: orphanSource.candidate.revision,
          rawValue: orphanSource.rawValue,
          payload: orphanPayload,
        }),
      ]),
    );
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(committed);
    expect(localStorage.getItem(orphanSource.storageKey)).toBe(
      orphanSource.rawValue,
    );

    const adoption = await recoveryDb.adoptRecoveryCandidate(selectedCandidate);

    expect(adoption).toMatchObject({
      status: "adopted",
      storeName: "eventMetadata",
      key: DATA_KEY,
      archiveKey: expect.stringMatching(
        /^__esp_internal__:recovery-adoption:v1:/,
      ),
    });
    expect(await readRawRecord("eventMetadata", DATA_KEY)).toEqual(
      orphanPayload,
    );
    expect(await recoveryDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: orphanPayload,
    });
    expect(localStorage.getItem(orphanSource.storageKey)).toBe(
      orphanSource.rawValue,
    );
    expect(await readRawRecord("syncQueue", adoption.archiveKey)).toMatchObject(
      {
        kind: "event-shopping-planner-recovery-adoption-archive",
        candidate: {
          sourceKey: orphanSource.storageKey,
          revision: orphanSource.candidate.revision,
        },
        chosenSourceEvidence: {
          sourceKey: orphanSource.storageKey,
          rawValue: orphanSource.rawValue,
          payload: orphanPayload,
        },
      },
    );
    expect(
      await readRawRecord(
        "syncQueue",
        createPersistenceCheckpointKey("eventMetadata", DATA_KEY),
      ),
    ).toMatchObject({
      absorbedCandidates: expect.arrayContaining([
        expect.objectContaining({
          revision: orphanSource.candidate.revision,
          digest: orphanSource.candidate.digest,
        }),
      ]),
    });

    const savedAfterAdoption = {
      d2389a0復旧イベント: { generation: "saved-after-adoption" },
    };
    await expect(
      recoveryDb.saveEventMetadata(savedAfterAdoption),
    ).resolves.toBeUndefined();
    expect(await recoveryDb.loadEventMetadata()).toMatchObject({
      status: "ok",
      data: savedAfterAdoption,
    });
    expect(localStorage.getItem(orphanSource.storageKey)).toBe(
      orphanSource.rawValue,
    );
  });
});
