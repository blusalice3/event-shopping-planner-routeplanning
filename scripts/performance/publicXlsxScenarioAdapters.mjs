import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  buildCanonicalBackup,
  buildCanonicalEventWorkbookBytes,
  buildCompressionRatioWorkbookBytes,
  buildCorruptWorkbookBytes,
  buildOpaqueWorkbookBytes,
  canonicalEventItemsSemanticSha256,
  canonicalPersistencePayloadBytes,
  sha256Bytes,
} from "./canonicalPublicFixtures.mjs";
import { installHashBoundWorkerFault } from "./hashBoundWorkerFaults.mjs";

const XLSX_INPUT_LABEL = "Excelファイルを選択";
const BACKUP_INPUT_LABEL = "バックアップファイルを選択";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const generatedFixturePromises = new Map();
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const resolveSourceBoundWorkerAsset = ({
  artifactBinding,
  targetUrl,
}) => {
  const matches = (artifactBinding?.outputFiles ?? []).filter(({ path }) =>
    /^static\/assets\/xlsx\.worker-[A-Za-z0-9_-]+\.js$/.test(path),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one source-bound XLSX Worker asset; received ${matches.length}`,
    );
  }
  const entry = matches[0];
  if (
    !SHA256_PATTERN.test(entry.sha256 ?? "") ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0
  ) {
    throw new Error("Source-bound XLSX Worker manifest entry is invalid");
  }
  return {
    entry,
    url: new URL(entry.path.slice("static".length), targetUrl).toString(),
  };
};

const waitForApplication = async (page, targetUrl) => {
  await page.goto(new URL(targetUrl).toString(), {
    waitUntil: "networkidle",
  });
  await page.getByLabel(BACKUP_INPUT_LABEL).waitFor({ state: "attached" });
};

const readHeapBytes = async (session) => {
  const response = await session.send("Performance.getMetrics");
  const metric = response.metrics.find(({ name }) => name === "JSHeapUsedSize");
  if (!metric || !Number.isFinite(metric.value) || metric.value < 0) {
    throw new Error("Chromium did not expose JSHeapUsedSize through CDP");
  }
  return metric.value;
};

const readCdpTrace = async (session, stream) => {
  let serialized = "";
  try {
    for (;;) {
      const chunk = await session.send("IO.read", { handle: stream });
      if (!isRecord(chunk) || typeof chunk.data !== "string") {
        throw new Error("CDP trace stream returned an invalid chunk");
      }
      serialized += chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64").toString("utf8")
        : chunk.data;
      if (chunk.eof === true) break;
    }
  } finally {
    await session.send("IO.close", { handle: stream });
  }
  let trace;
  try {
    trace = JSON.parse(serialized);
  } catch {
    throw new Error("CDP trace stream is not valid JSON");
  }
  if (!isRecord(trace) || !Array.isArray(trace.traceEvents)) {
    throw new Error("CDP trace does not contain timeline events");
  }
  return trace.traceEvents;
};

const summarizeCdpLongTasks = (traceEvents) => {
  const rendererMainThreads = new Set(
    traceEvents
      .filter(
        (event) =>
          event?.ph === "M" &&
          event.name === "thread_name" &&
          event.args?.name === "CrRendererMain" &&
          Number.isSafeInteger(event.pid) &&
          Number.isSafeInteger(event.tid),
      )
      .map((event) => `${event.pid}:${event.tid}`),
  );
  if (rendererMainThreads.size === 0) {
    throw new Error("CDP trace did not identify the renderer main thread");
  }
  return traceEvents
    .filter(
      (event) =>
        event?.ph === "X" &&
        event.name === "RunTask" &&
        rendererMainThreads.has(`${event.pid}:${event.tid}`) &&
        typeof event.dur === "number" &&
        Number.isFinite(event.dur) &&
        event.dur >= 50_000,
    )
    .reduce((maximum, event) => Math.max(maximum, event.dur / 1_000), 0);
};

const startCdpLongTaskTrace = async ({ browserContext, page }) => {
  const session = await browserContext.newCDPSession(page);
  try {
    await session.send("Tracing.start", {
      categories: "devtools.timeline",
      options: "record-as-much-as-possible",
      transferMode: "ReturnAsStream",
    });
  } catch (error) {
    await session.detach();
    throw error;
  }
  let stopPromise = null;
  return {
    stop() {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        try {
          const completed = new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("CDP trace completion timed out")),
              30_000,
            );
            session.once("Tracing.tracingComplete", (event) => {
              clearTimeout(timeout);
              resolve(event);
            });
          });
          await session.send("Tracing.end");
          const completion = await completed;
          if (!isRecord(completion) || typeof completion.stream !== "string") {
            throw new Error("CDP trace did not return a stream");
          }
          return summarizeCdpLongTasks(
            await readCdpTrace(session, completion.stream),
          );
        } finally {
          await session.detach();
        }
      })();
      return stopPromise;
    },
  };
};

const measureBrowserOperation = async ({ browserContext, page, operation }) => {
  const session = await browserContext.newCDPSession(page);
  const trace = await startCdpLongTaskTrace({ browserContext, page });
  const heartbeatGaps = [];
  let heartbeatPrevious = performance.now();
  let heartbeatPending = false;
  let peakHeapBytes;
  let memoryPending = false;
  let traceStopped = false;
  await session.send("Performance.enable");
  const initialHeapBytes = await readHeapBytes(session);
  peakHeapBytes = initialHeapBytes;
  const heartbeatTimer = globalThis.setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    const requestedAt = performance.now();
    void page
      .evaluate(() => globalThis.performance.now())
      .then(() => {
        const now = performance.now();
        heartbeatGaps.push(now - heartbeatPrevious, now - requestedAt);
        heartbeatPrevious = now;
      })
      .finally(() => {
        heartbeatPending = false;
      });
  }, 25);
  const memoryTimer = globalThis.setInterval(() => {
    if (memoryPending) return;
    memoryPending = true;
    void readHeapBytes(session)
      .then((value) => {
        peakHeapBytes = Math.max(peakHeapBytes, value);
      })
      .finally(() => {
        memoryPending = false;
      });
  }, 25);
  const startedAt = performance.now();
  try {
    const value = await operation();
    const durationMs = performance.now() - startedAt;
    peakHeapBytes = Math.max(peakHeapBytes, await readHeapBytes(session));
    const maxMainThreadTaskMs = await trace.stop();
    traceStopped = true;
    return {
      value,
      durationMs,
      maxMainThreadTaskMs,
      maxUiHeartbeatGapMs: Math.max(0, ...heartbeatGaps),
      peakMemoryDeltaBytes: Math.max(0, peakHeapBytes - initialHeapBytes),
    };
  } finally {
    globalThis.clearInterval(heartbeatTimer);
    globalThis.clearInterval(memoryTimer);
    if (!traceStopped) await trace.stop();
    await session.detach();
  }
};

const selectMetrics = (requiredTelemetry, measured, extra = {}) =>
  Object.fromEntries(
    requiredTelemetry.map((metric) => {
      const value = Object.hasOwn(extra, metric)
        ? extra[metric]
        : measured[metric];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Required telemetry ${metric} was not observed`);
      }
      return [metric, value];
    }),
  );

const selectAssertions = (requiredAssertions, observed) =>
  Object.fromEntries(
    requiredAssertions.map((assertion) => {
      if (observed[assertion] !== true) {
        throw new Error(`Required assertion ${assertion} was not observed`);
      }
      return [assertion, true];
    }),
  );

const executionBinding = ({
  fixtureDocument,
  payloadBytes,
  semanticSha256,
  faultInjection = null,
  setup = null,
}) => ({
  adapterContract: "public-artifact-surface-v1",
  fixturePayload: {
    generator: fixtureDocument?.dataset?.generator ?? "tracked-fixture-raw-v1",
    seed: Number.isSafeInteger(fixtureDocument?.dataset?.seed)
      ? fixtureDocument.dataset.seed
      : null,
    cardinality:
      fixtureDocument?.dataset?.rowCount ??
      fixtureDocument?.dataset?.itemCount ??
      null,
    payloadSha256: sha256Bytes(payloadBytes),
    semanticSha256,
  },
  faultInjection,
  setup,
});

const bytesToBase64 = (bytes) => Buffer.from(bytes).toString("base64");

const runPublicWorkerRequest = async ({
  page,
  workerUrl,
  request,
  inputBytes = null,
}) => {
  const inputBase64 = inputBytes === null ? null : bytesToBase64(inputBytes);
  return page.evaluate(
    ({ inputBase64: encoded, request: requestValue, workerUrl: publicUrl }) =>
      new Promise((resolve, reject) => {
        const worker = new globalThis.Worker(publicUrl, {
          type: "module",
          name: "foundation-performance-public-worker",
        });
        const progress = [];
        let terminalCount = 0;
        const timeout = globalThis.setTimeout(() => {
          worker.terminate();
          reject(new Error("Public XLSX Worker operation timed out"));
        }, 180_000);
        worker.addEventListener("message", (event) => {
          const message = event.data;
          if (message?.requestId !== requestValue.requestId) return;
          if (message.type === "XLSX_PROGRESS") {
            progress.push(message.progress);
            return;
          }
          terminalCount += 1;
          globalThis.clearTimeout(timeout);
          const result = {
            response: message,
            progress,
            terminalCount,
          };
          worker.terminate();
          resolve(result);
        });
        worker.addEventListener("error", (event) => {
          globalThis.clearTimeout(timeout);
          worker.terminate();
          reject(new Error(event.message || "Public XLSX Worker crashed"));
        });
        if (encoded === null) {
          worker.postMessage(requestValue);
          return;
        }
        const binary = globalThis.atob(encoded);
        const input = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          input[index] = binary.charCodeAt(index);
        }
        worker.postMessage({ ...requestValue, input: input.buffer }, [
          input.buffer,
        ]);
      }),
    { inputBase64, request, workerUrl },
  );
};

const uuidFor = (scenarioId, suffix = 0) => {
  const digest = createHash("sha256")
    .update(`${scenarioId}:${suffix}`, "utf8")
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const captureIndexedDbFingerprint = async (page) =>
  page.evaluate(async () => {
    if (typeof globalThis.indexedDB.databases !== "function") {
      throw new Error("Chromium indexedDB.databases() is unavailable");
    }
    const databases = (await globalThis.indexedDB.databases())
      .filter(({ name }) => typeof name === "string")
      .sort((left, right) => left.name.localeCompare(right.name));
    const snapshot = [];
    for (const descriptor of databases) {
      const database = await new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(descriptor.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const stores = [...database.objectStoreNames].sort();
        const values = [];
        for (const storeName of stores) {
          const records = await new Promise((resolve, reject) => {
            const request = database
              .transaction(storeName, "readonly")
              .objectStore(storeName)
              .getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          values.push([storeName, records]);
        }
        snapshot.push([descriptor.name, descriptor.version, values]);
      } finally {
        database.close();
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  });

export const stageCanonicalExportEventLists = async ({
  eventLists,
  eventName,
  expectedSemanticSha256,
  page,
}) => {
  const payloadBytes = canonicalPersistencePayloadBytes(eventLists);
  const payloadSha256 = sha256Bytes(payloadBytes);
  const receipt = await page.evaluate(
    async (input) => {
      const DATABASE_NAME = "EventShoppingPlannerDB";
      const MIN_DATABASE_VERSION = 5;
      const MAX_DATABASE_VERSION = 7;
      const DATA_KEY = "data";
      const EVENT_STORE = "eventLists";
      const CONTROL_STORE = "syncQueue";
      const REQUIRED_STORES = [
        "dayModes",
        "eventLists",
        "eventMetadata",
        "executeModeItems",
        "hallDefinitions",
        "hallRouteSettings",
        "mapData",
        "mapRotationSettings",
        "mapViewportSettings",
        "routeSettings",
        "syncQueue",
      ].sort();
      const metadataKey = "__esp_internal__:meta:v1:eventLists:data";
      const checkpointKey = "__esp_internal__:checkpoint:v1:eventLists:data";
      const committedAt = "2026-08-09T00:00:00.000Z";
      const writerId = "performance-collector-idb-stage-v1";

      const canonicalize = (value) => {
        if (value === null) return "null";
        if (Array.isArray(value)) {
          return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
        }
        if (typeof value === "object") {
          return `{${Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
            .join(",")}}`;
        }
        if (
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        ) {
          return JSON.stringify(value);
        }
        throw new Error(
          "Canonical export staging payload is not JSON-compatible",
        );
      };
      const hex = (bytes) =>
        [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
      const sha256 = async (canonical) =>
        hex(
          new Uint8Array(
            await globalThis.crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(canonical),
            ),
          ),
        );
      const fingerprint = (canonical) => {
        let hash = 0xcbf29ce484222325n;
        for (const byte of new TextEncoder().encode(canonical)) {
          hash ^= BigInt(byte);
          hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
        }
        return {
          algorithm: "FNV-1A-64",
          canonicalization: "esp-json-v1",
          canonicalLength: canonical.length,
          value: hash.toString(16).padStart(16, "0"),
        };
      };
      const requestResult = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const transactionFinished = (transaction) =>
        new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => {};
          transaction.onabort = () =>
            reject(
              transaction.error ??
                new Error("Canonical export staging transaction aborted"),
            );
        });
      const openDatabase = () =>
        new Promise((resolve, reject) => {
          const request = globalThis.indexedDB.open(DATABASE_NAME);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = () => {
            request.transaction?.abort();
            reject(
              new Error("Canonical export staging must not create a database"),
            );
          };
        });
      const semanticCanonical = (payload) => {
        const items = payload[input.eventName];
        if (!Array.isArray(items)) {
          throw new Error("Canonical export event payload is missing");
        }
        return canonicalize({
          eventName: input.eventName,
          items: items.map((item) => ({
            block: item.block ?? "",
            catalogPrice: item.catalogPrice ?? null,
            circle: item.circle ?? "",
            eventDate: item.eventDate ?? "",
            id: item.id ?? "",
            limitedPurchasedQuantity: item.limitedPurchasedQuantity ?? null,
            manualHallId: item.manualHallId ?? "",
            number: item.number ?? "",
            price: item.price ?? null,
            priorityLevel: item.priorityLevel ?? "none",
            protectionLevel: item.protectionLevel ?? "none",
            purchaseStatus: item.purchaseStatus ?? "None",
            quantity: item.quantity ?? 1,
            remarks: item.remarks ?? "",
            sheetRemarks: item.sheetRemarks ?? "",
            source: item.source ?? "app",
            title: item.title ?? "",
            url: item.url ?? "",
          })),
        });
      };

      if (input.contract !== "event-export-idb-stage-v1") {
        throw new Error("Canonical export staging contract is invalid");
      }
      const canonicalPayload = canonicalize(input.eventLists);
      const digestValue = await sha256(canonicalPayload);
      const semanticSha256 = await sha256(semanticCanonical(input.eventLists));
      if (
        digestValue !== input.payloadSha256 ||
        semanticSha256 !== input.expectedSemanticSha256
      ) {
        throw new Error("Canonical export staging input binding drifted");
      }
      const payloadDigest = {
        algorithm: "SHA-256",
        canonicalization: "esp-json-v1",
        value: digestValue,
      };
      const revision = `performance-stage:${digestValue}`;
      const metadata = {
        kind: "event-shopping-planner-persistence-metadata",
        version: 1,
        storeName: EVENT_STORE,
        key: DATA_KEY,
        revision,
        baseRevision: null,
        payloadDigest,
        payloadFingerprint: fingerprint(canonicalPayload),
        writerId,
        committedAt,
      };
      const checkpoint = {
        kind: "event-shopping-planner-persistence-checkpoint",
        version: 1,
        storeName: EVENT_STORE,
        key: DATA_KEY,
        committedRoot: {
          revision,
          baseRevision: null,
          digest: payloadDigest,
          writerId,
          committedAt,
        },
        absorbedCandidates: [],
        updatedAt: committedAt,
      };
      const database = await openDatabase();
      try {
        const stores = [...database.objectStoreNames].sort();
        if (
          database.version < MIN_DATABASE_VERSION ||
          database.version > MAX_DATABASE_VERSION ||
          JSON.stringify(stores) !== JSON.stringify(REQUIRED_STORES)
        ) {
          throw new Error("Canonical export staging database schema drifted");
        }
        for (const storeName of [EVENT_STORE, CONTROL_STORE]) {
          const transaction = database.transaction(storeName, "readonly");
          const store = transaction.objectStore(storeName);
          if (store.keyPath !== null || store.autoIncrement !== false) {
            throw new Error(
              `Canonical export staging store contract drifted: ${storeName}`,
            );
          }
        }

        const transaction = database.transaction(
          [EVENT_STORE, CONTROL_STORE],
          "readwrite",
        );
        const completion = transactionFinished(transaction);
        const eventStore = transaction.objectStore(EVENT_STORE);
        const controlStore = transaction.objectStore(CONTROL_STORE);
        const existing = await Promise.all([
          requestResult(eventStore.get(DATA_KEY)),
          requestResult(controlStore.get(metadataKey)),
          requestResult(controlStore.get(checkpointKey)),
        ]);
        if (existing.some((value) => value !== undefined)) {
          transaction.abort();
          try {
            await completion;
          } catch {
            // The explicit abort is expected for a non-fresh context.
          }
          throw new Error(
            "Canonical export staging requires an empty fresh-context root",
          );
        }
        eventStore.put(input.eventLists, DATA_KEY);
        controlStore.put(metadata, metadataKey);
        controlStore.put(checkpoint, checkpointKey);
        await completion;

        const readbackTransaction = database.transaction(
          [EVENT_STORE, CONTROL_STORE],
          "readonly",
        );
        const readbackCompletion = transactionFinished(readbackTransaction);
        const readbackEventStore = readbackTransaction.objectStore(EVENT_STORE);
        const readbackControlStore =
          readbackTransaction.objectStore(CONTROL_STORE);
        const [readbackPayload, readbackMetadata, readbackCheckpoint] =
          await Promise.all([
            requestResult(readbackEventStore.get(DATA_KEY)),
            requestResult(readbackControlStore.get(metadataKey)),
            requestResult(readbackControlStore.get(checkpointKey)),
          ]);
        await readbackCompletion;
        const readbackCanonical = canonicalize(readbackPayload);
        const readbackDigest = await sha256(readbackCanonical);
        const readbackSemanticSha256 = await sha256(
          semanticCanonical(readbackPayload),
        );
        const itemCount = readbackPayload?.[input.eventName]?.length;
        if (
          Object.keys(readbackPayload ?? {}).length !== 1 ||
          itemCount !== input.itemCount ||
          readbackDigest !== digestValue ||
          readbackSemanticSha256 !== input.expectedSemanticSha256 ||
          JSON.stringify(fingerprint(readbackCanonical)) !==
            JSON.stringify(metadata.payloadFingerprint) ||
          JSON.stringify(readbackMetadata) !== JSON.stringify(metadata) ||
          JSON.stringify(readbackCheckpoint) !== JSON.stringify(checkpoint)
        ) {
          throw new Error("Canonical export staging readback drifted");
        }
        return {
          contract: input.contract,
          databaseName: DATABASE_NAME,
          databaseVersion: database.version,
          storeName: EVENT_STORE,
          controlStoreName: CONTROL_STORE,
          key: DATA_KEY,
          payloadSha256: readbackDigest,
          semanticSha256: readbackSemanticSha256,
          itemCount,
          transactionStores: [EVENT_STORE, CONTROL_STORE],
        };
      } finally {
        database.close();
      }
    },
    {
      contract: "event-export-idb-stage-v1",
      eventLists,
      eventName,
      expectedSemanticSha256,
      itemCount: eventLists[eventName]?.length ?? -1,
      payloadSha256,
    },
  );
  const expectedReceipt = {
    contract: "event-export-idb-stage-v1",
    databaseName: "EventShoppingPlannerDB",
    storeName: "eventLists",
    controlStoreName: "syncQueue",
    key: "data",
    payloadSha256,
    semanticSha256: expectedSemanticSha256,
    itemCount: eventLists[eventName]?.length ?? -1,
    transactionStores: ["eventLists", "syncQueue"],
  };
  if (
    !isRecord(receipt) ||
    !Number.isSafeInteger(receipt.databaseVersion) ||
    receipt.databaseVersion < 5 ||
    receipt.databaseVersion > 7 ||
    Object.entries(expectedReceipt).some(
      ([key, value]) => JSON.stringify(receipt[key]) !== JSON.stringify(value),
    )
  ) {
    throw new Error("Canonical export staging receipt is invalid");
  }
  return { payloadBytes, receipt };
};

export const readCommittedEventListsReceipt = async ({
  eventName,
  expectedItemCount,
  expectedSemanticSha256,
  page,
}) => {
  const receipt = await page.evaluate(
    async (input) => {
      const canonicalize = (value) => {
        if (value === null) return "null";
        if (Array.isArray(value)) {
          return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
        }
        if (typeof value === "object") {
          return `{${Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
            .join(",")}}`;
        }
        if (
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        ) {
          return JSON.stringify(value);
        }
        throw new Error("Committed event payload is not JSON-compatible");
      };
      const hex = (bytes) =>
        [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
      const sha256 = async (canonical) =>
        hex(
          new Uint8Array(
            await globalThis.crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(canonical),
            ),
          ),
        );
      const fingerprint = (canonical) => {
        let hash = 0xcbf29ce484222325n;
        for (const byte of new TextEncoder().encode(canonical)) {
          hash ^= BigInt(byte);
          hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
        }
        return {
          algorithm: "FNV-1A-64",
          canonicalization: "esp-json-v1",
          canonicalLength: canonical.length,
          value: hash.toString(16).padStart(16, "0"),
        };
      };
      const requestResult = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const transactionFinished = (transaction) =>
        new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => {};
          transaction.onabort = () =>
            reject(
              transaction.error ??
                new Error("Committed event readback transaction aborted"),
            );
        });
      const database = await new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open("EventShoppingPlannerDB");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          reject(
            new Error("Committed event readback must not create a database"),
          );
        };
      });
      try {
        if (
          database.version < 5 ||
          database.version > 7 ||
          !database.objectStoreNames.contains("eventLists") ||
          !database.objectStoreNames.contains("syncQueue")
        ) {
          throw new Error("Committed event readback database schema drifted");
        }
        const transaction = database.transaction(
          ["eventLists", "syncQueue"],
          "readonly",
        );
        const completion = transactionFinished(transaction);
        const eventStore = transaction.objectStore("eventLists");
        const controlStore = transaction.objectStore("syncQueue");
        const [payload, metadata, checkpoint] = await Promise.all([
          requestResult(eventStore.get("data")),
          requestResult(
            controlStore.get("__esp_internal__:meta:v1:eventLists:data"),
          ),
          requestResult(
            controlStore.get("__esp_internal__:checkpoint:v1:eventLists:data"),
          ),
        ]);
        await completion;
        const items = payload?.[input.eventName];
        if (!Array.isArray(items) || items.length !== input.expectedItemCount) {
          throw new Error("Committed event cardinality drifted");
        }
        const payloadCanonical = canonicalize(payload);
        const payloadSha256 = await sha256(payloadCanonical);
        const payloadFingerprint = fingerprint(payloadCanonical);
        const semanticSha256 = await sha256(
          canonicalize({
            eventName: input.eventName,
            items: items.map((item) => ({
              block: item.block ?? "",
              catalogPrice: item.catalogPrice ?? null,
              circle: item.circle ?? "",
              eventDate: item.eventDate ?? "",
              id: item.id ?? "",
              limitedPurchasedQuantity: item.limitedPurchasedQuantity ?? null,
              manualHallId: item.manualHallId ?? "",
              number: item.number ?? "",
              price: item.price ?? null,
              priorityLevel: item.priorityLevel ?? "none",
              protectionLevel: item.protectionLevel ?? "none",
              purchaseStatus: item.purchaseStatus ?? "None",
              quantity: item.quantity ?? 1,
              remarks: item.remarks ?? "",
              sheetRemarks: item.sheetRemarks ?? "",
              source: item.source ?? "app",
              title: item.title ?? "",
              url: item.url ?? "",
            })),
          }),
        );
        const rootMatches =
          metadata?.kind === "event-shopping-planner-persistence-metadata" &&
          metadata.version === 1 &&
          metadata.storeName === "eventLists" &&
          metadata.key === "data" &&
          typeof metadata.revision === "string" &&
          metadata.revision.length > 0 &&
          typeof metadata.writerId === "string" &&
          metadata.writerId.length > 0 &&
          Number.isFinite(Date.parse(metadata.committedAt)) &&
          metadata.payloadDigest?.algorithm === "SHA-256" &&
          metadata.payloadDigest?.canonicalization === "esp-json-v1" &&
          metadata.payloadDigest?.value === payloadSha256 &&
          JSON.stringify(metadata.payloadFingerprint) ===
            JSON.stringify(payloadFingerprint) &&
          checkpoint?.kind ===
            "event-shopping-planner-persistence-checkpoint" &&
          checkpoint.version === 1 &&
          checkpoint.storeName === "eventLists" &&
          checkpoint.key === "data" &&
          Array.isArray(checkpoint.absorbedCandidates) &&
          checkpoint.committedRoot?.revision === metadata.revision &&
          checkpoint.committedRoot?.baseRevision === metadata.baseRevision &&
          checkpoint.committedRoot?.writerId === metadata.writerId &&
          checkpoint.committedRoot?.committedAt === metadata.committedAt &&
          JSON.stringify(checkpoint.committedRoot?.digest) ===
            JSON.stringify(metadata.payloadDigest) &&
          Number.isFinite(Date.parse(checkpoint.updatedAt));
        if (!rootMatches || semanticSha256 !== input.expectedSemanticSha256) {
          throw new Error("Committed event root binding drifted");
        }
        return {
          databaseName: database.name,
          databaseVersion: database.version,
          storeName: "eventLists",
          controlStoreName: "syncQueue",
          key: "data",
          itemCount: items.length,
          payloadSha256,
          semanticSha256,
          revision: metadata.revision,
        };
      } finally {
        database.close();
      }
    },
    { eventName, expectedItemCount, expectedSemanticSha256 },
  );
  if (
    !isRecord(receipt) ||
    receipt.databaseName !== "EventShoppingPlannerDB" ||
    !Number.isSafeInteger(receipt.databaseVersion) ||
    receipt.databaseVersion < 5 ||
    receipt.databaseVersion > 7 ||
    receipt.storeName !== "eventLists" ||
    receipt.controlStoreName !== "syncQueue" ||
    receipt.key !== "data" ||
    receipt.itemCount !== expectedItemCount ||
    !SHA256_PATTERN.test(receipt.payloadSha256 ?? "") ||
    receipt.semanticSha256 !== expectedSemanticSha256 ||
    typeof receipt.revision !== "string" ||
    receipt.revision.length === 0
  ) {
    throw new Error("Committed event readback receipt is invalid");
  }
  return receipt;
};

const cacheGenerated = (key, factory) => {
  if (!generatedFixturePromises.has(key)) {
    generatedFixturePromises.set(key, Promise.resolve().then(factory));
  }
  return generatedFixturePromises.get(key);
};

const getValidWorkbook = async (fixtureDocument) => {
  const {
    rowCount,
    seed = 1967,
    targetCompressedBytes,
  } = fixtureDocument.dataset;
  const key = `valid:${rowCount}:${seed}:${targetCompressedBytes ?? 0}`;
  return cacheGenerated(key, async () => {
    if (!targetCompressedBytes) {
      return buildCanonicalEventWorkbookBytes({ rowCount, seed });
    }
    let paddingCharacters = Math.max(
      1,
      Math.ceil((targetCompressedBytes / rowCount) * 1.05),
    );
    const tolerance = Math.max(
      65_536,
      Math.floor(targetCompressedBytes * 0.05),
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const generated = await buildCanonicalEventWorkbookBytes({
        rowCount,
        seed,
        paddingCharacters,
      });
      const drift = generated.bytes.length - targetCompressedBytes;
      if (Math.abs(drift) <= tolerance) {
        return { ...generated, paddingCharacters };
      }
      paddingCharacters = Math.max(
        1,
        Math.round(
          paddingCharacters * (targetCompressedBytes / generated.bytes.length),
        ),
      );
    }
    throw new Error(
      "Canonical workbook generator missed its compressed-size target",
    );
  });
};

const collectDownloads = (page) => {
  const downloads = [];
  const listener = (download) => downloads.push(download.suggestedFilename());
  page.on("download", listener);
  return {
    downloads,
    dispose: () => page.off("download", listener),
  };
};

const workerImportRequest = (scenarioId) => ({
  type: "XLSX_IMPORT_REQUEST",
  protocolVersion: 1,
  requestId: uuidFor(scenarioId),
  kind: "event-import",
  fileName: `${scenarioId}.xlsx`,
});

const importViaPublicWorker = async (options, bytes) => {
  const worker = resolveSourceBoundWorkerAsset(options);
  const workerEvent = options.page.waitForEvent("worker");
  const measured = await measureBrowserOperation({
    browserContext: options.browserContext,
    page: options.page,
    operation: () =>
      runPublicWorkerRequest({
        page: options.page,
        workerUrl: worker.url,
        request: workerImportRequest(options.scenarioId),
        inputBytes: bytes,
      }),
  });
  const workerHandle = await workerEvent;
  if (workerHandle.url() !== worker.url) {
    throw new Error("Observed Worker URL differs from artifact binding");
  }
  return measured;
};

const runMainThreadXlsx = async (options) => {
  const generated = await cacheGenerated("main-thread-benign-v1", () =>
    buildCanonicalEventWorkbookBytes({ rowCount: 10, seed: 1967 }),
  );
  await waitForApplication(options.page, options.targetUrl);
  const dialogs = [];
  const dialogListener = async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  };
  options.page.on("dialog", dialogListener);
  try {
    const measured = await measureBrowserOperation({
      browserContext: options.browserContext,
      page: options.page,
      operation: async () => {
        await options.page.getByLabel(XLSX_INPUT_LABEL).setInputFiles({
          name: "benign-main-thread.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: generated.bytes,
        });
        await options.page
          .getByRole("button", { name: "別名で復元" })
          .waitFor({ state: "visible", timeout: 60_000 });
      },
    });
    if (dialogs.length !== 0) {
      throw new Error(
        "Benign main-thread XLSX operation opened an error dialog",
      );
    }
    return {
      metrics: selectMetrics(options.requiredTelemetry, measured),
      assertions: selectAssertions(options.requiredAssertions, {
        "scenario-completed": true,
      }),
      executionBinding: executionBinding({
        fixtureDocument: {
          dataset: {
            generator: "valid-event-workbook-v1",
            seed: 1967,
            rowCount: 10,
          },
        },
        payloadBytes: generated.bytes,
        semanticSha256: generated.semanticSha256,
      }),
    };
  } finally {
    options.page.off("dialog", dialogListener);
  }
};

const runValidImport = async (options) => {
  const generated = await getValidWorkbook(options.fixtureDocument);
  const targetBytes = options.fixtureDocument.dataset.targetCompressedBytes;
  const expectedRowCount = options.fixtureDocument.dataset.rowCount;
  if (
    !Number.isSafeInteger(expectedRowCount) ||
    expectedRowCount < 1 ||
    (targetBytes !== undefined &&
      (generated.bytes.length < targetBytes * 0.95 ||
        generated.bytes.length > targetBytes * 1.05))
  ) {
    throw new Error("Canonical workbook payload binding is invalid");
  }
  await waitForApplication(options.page, options.targetUrl);
  const before = await captureIndexedDbFingerprint(options.page);
  const workerAsset = resolveSourceBoundWorkerAsset(options);
  const workerEvent = options.page.waitForEvent("worker");
  const progressVisible = options.requiredAssertions.includes(
    "progress-observed",
  )
    ? options.page
        .getByRole("status")
        .filter({ hasText: "Excel処理中" })
        .waitFor({ state: "visible", timeout: 180_000 })
        .then(() => true)
    : Promise.resolve(false);
  const measured = await measureBrowserOperation({
    browserContext: options.browserContext,
    page: options.page,
    operation: async () => {
      await options.page.getByLabel(XLSX_INPUT_LABEL).setInputFiles({
        name: `${options.scenarioId}.xlsx`,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: generated.bytes,
      });
      await options.page
        .getByRole("button", { name: "別名で復元" })
        .waitFor({ state: "visible", timeout: 180_000 });
    },
  });
  const workerHandle = await workerEvent;
  const observedProgress = await progressVisible;
  if (workerHandle.url() !== workerAsset.url) {
    throw new Error(
      "Import UI used a Worker outside the source-bound artifact",
    );
  }
  const targetEventName = await options.page
    .getByLabel("復元後のイベント名")
    .inputValue();
  const expectedSemanticSha256 = canonicalEventItemsSemanticSha256(
    targetEventName,
    generated.items,
  );
  const completionDialogs = [];
  const completionDialogListener = async (dialog) => {
    completionDialogs.push(dialog.message());
    await dialog.accept();
  };
  const completionDialogEvent = options.page.waitForEvent("dialog", {
    timeout: 180_000,
  });
  options.page.on("dialog", completionDialogListener);
  try {
    await options.page.getByRole("button", { name: "別名で復元" }).click();
    await completionDialogEvent;
  } finally {
    options.page.off("dialog", completionDialogListener);
  }
  const expectsDeferredEventList = expectedRowCount >= 10_000;
  let deferredEventListObserved = false;
  if (expectsDeferredEventList) {
    await options.page
      .getByRole("heading", { name: "保存済みの即売会リスト" })
      .waitFor({ state: "visible", timeout: 180_000 });
    const eventRowCount = await options.page
      .getByRole("listitem")
      .filter({ hasText: targetEventName })
      .count();
    deferredEventListObserved =
      eventRowCount === 1 &&
      (await options.page
        .locator('[role="list"][aria-label="買い物リスト"]')
        .count()) === 0;
  } else {
    await options.page
      .locator(
        `[role="list"][aria-label="買い物リスト"][data-list-row-count="${expectedRowCount}"]`,
      )
      .waitFor({ state: "visible", timeout: 180_000 });
  }
  const committed = await readCommittedEventListsReceipt({
    eventName: targetEventName,
    expectedItemCount: expectedRowCount,
    expectedSemanticSha256,
    page: options.page,
  });
  const after = await captureIndexedDbFingerprint(options.page);
  const singleCompletionDialog =
    completionDialogs.length === 1 &&
    completionDialogs[0].includes(`${expectedRowCount}件`) &&
    (!expectsDeferredEventList ||
      completionDialogs[0].includes(
        "リストは自動で開かずイベント一覧に戻りました",
      ));
  return {
    metrics: selectMetrics(options.requiredTelemetry, measured),
    assertions: selectAssertions(options.requiredAssertions, {
      "worker-execution-observed": true,
      "ui-heartbeat-observed": measured.maxUiHeartbeatGapMs > 0,
      "progress-observed": observedProgress,
      "single-terminal-result": singleCompletionDialog,
      "single-import-completion-dialog": singleCompletionDialog,
      "large-restore-deferred-to-event-list":
        expectsDeferredEventList && deferredEventListObserved,
      "atomic-domain-commit":
        before !== after &&
        committed.itemCount === expectedRowCount &&
        committed.semanticSha256 === expectedSemanticSha256,
    }),
    executionBinding: executionBinding({
      fixtureDocument: options.fixtureDocument,
      payloadBytes: generated.bytes,
      semanticSha256: generated.semanticSha256,
    }),
  };
};

const runExportRoundTrip = async (options) => {
  const eventName = "canonical-worker-roundtrip";
  const rowCount = options.fixtureDocument.dataset.itemCount;
  const generated = buildCanonicalBackup({
    rowCount,
    seed: 1967,
    eventName,
  });
  const expectedItems = generated.document.data.eventLists[eventName];
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount < 1 ||
    expectedItems.length !== rowCount
  ) {
    throw new Error("Canonical export input cardinality is invalid");
  }
  await waitForApplication(options.page, options.targetUrl);
  const staged = await stageCanonicalExportEventLists({
    eventLists: generated.document.data.eventLists,
    eventName,
    expectedSemanticSha256: generated.semanticSha256,
    page: options.page,
  });
  await options.page.reload({ waitUntil: "networkidle" });
  await options.page
    .getByRole("heading", { name: "保存済みの即売会リスト" })
    .waitFor({ state: "visible", timeout: 180_000 });
  const eventRow = options.page
    .getByRole("listitem")
    .filter({ hasText: eventName });
  await eventRow.getByRole("button", { name: "メニュー" }).click();
  const exportAction = options.page.getByRole("button", {
    name: "Excel形式で出力",
    exact: true,
  });
  await exportAction.waitFor({ state: "visible", timeout: 180_000 });
  const worker = resolveSourceBoundWorkerAsset(options);
  const downloads = collectDownloads(options.page);
  const workerUrls = [];
  const workerListener = (handle) => workerUrls.push(handle.url());
  options.page.on("worker", workerListener);
  try {
    const measured = await measureBrowserOperation({
      browserContext: options.browserContext,
      page: options.page,
      operation: async () => {
        const downloadPromise = options.page.waitForEvent("download");
        const exportProgress = options.requiredAssertions.includes(
          "progress-observed",
        )
          ? options.page
              .getByRole("status")
              .filter({ hasText: "Excel処理中" })
              .waitFor({ state: "visible", timeout: 180_000 })
              .then(() => true)
          : Promise.resolve(false);
        await exportAction.click();
        await options.page
          .getByRole("heading", { name: "エクスポート設定", exact: true })
          .waitFor({ state: "visible", timeout: 180_000 });
        await options.page
          .getByRole("button", { name: "エクスポート", exact: true })
          .click();
        const download = await downloadPromise;
        const downloadPath = await download.path();
        if (
          downloadPath === null ||
          !download.suggestedFilename().toLowerCase().endsWith(".xlsx")
        ) {
          throw new Error("Public export did not retain one XLSX download");
        }
        const bytes = await readFile(downloadPath);
        if (bytes.subarray(0, 2).toString("ascii") !== "PK") {
          throw new Error("Public export download is not an XLSX ZIP");
        }
        const importResult = await runPublicWorkerRequest({
          page: options.page,
          workerUrl: worker.url,
          request: {
            ...workerImportRequest(options.scenarioId),
            requestId: uuidFor(options.scenarioId, 2),
          },
          inputBytes: bytes,
        });
        return {
          bytes,
          exportProgress: await exportProgress,
          importResult,
        };
      },
    });
    const imported = measured.value.importResult.response;
    const importedItems = imported?.result?.value?.items;
    const parity =
      imported?.type === "XLSX_IMPORT_RESULT" &&
      imported.result.value.eventName === eventName &&
      Array.isArray(importedItems) &&
      importedItems.length === expectedItems.length &&
      canonicalEventItemsSemanticSha256(eventName, importedItems) ===
        canonicalEventItemsSemanticSha256(eventName, expectedItems);
    return {
      metrics: selectMetrics(options.requiredTelemetry, measured),
      assertions: selectAssertions(options.requiredAssertions, {
        "worker-execution-observed":
          workerUrls.length === 2 &&
          workerUrls.every((url) => url === worker.url),
        "ui-heartbeat-observed": measured.maxUiHeartbeatGapMs > 0,
        "progress-observed":
          measured.value.exportProgress &&
          measured.value.importResult.progress.length > 0,
        "single-terminal-result":
          downloads.downloads.length === 1 &&
          measured.value.importResult.terminalCount === 1,
        "round-trip-semantic-parity": parity,
        "single-atomic-download": downloads.downloads.length === 1,
      }),
      executionBinding: executionBinding({
        fixtureDocument: options.fixtureDocument,
        payloadBytes: staged.payloadBytes,
        semanticSha256: generated.semanticSha256,
        setup: {
          method: "indexeddb-schema-exact-single-transaction-stage-v1",
          timing: "excluded-from-measurement-v1",
          readback: "separate-readonly-transaction-v1",
          databaseName: staged.receipt.databaseName,
          databaseVersion: staged.receipt.databaseVersion,
          storeName: staged.receipt.storeName,
          controlStoreName: staged.receipt.controlStoreName,
          key: staged.receipt.key,
          transactionStores: staged.receipt.transactionStores,
          payloadSha256: staged.receipt.payloadSha256,
          semanticSha256: staged.receipt.semanticSha256,
          itemCount: staged.receipt.itemCount,
          revision: `performance-stage:${staged.receipt.payloadSha256}`,
        },
      }),
    };
  } finally {
    options.page.off("worker", workerListener);
    downloads.dispose();
  }
};

const rejectedFixtureBytes = async (fixtureDocument) => {
  const { dataset } = fixtureDocument;
  if (dataset.generator === "corrupt-zip-header-v1") {
    return buildCorruptWorkbookBytes(dataset.compressedBytes);
  }
  if (dataset.generator === "opaque-bytes-v1") {
    return buildOpaqueWorkbookBytes(dataset.compressedBytes);
  }
  if (dataset.generator === "zip-compression-ratio-v1") {
    return cacheGenerated(`zip-ratio:${dataset.compressionRatio}`, () =>
      buildCompressionRatioWorkbookBytes({
        compressionRatio: dataset.compressionRatio,
      }),
    );
  }
  throw new Error(
    `Unsupported rejected fixture generator ${dataset.generator}`,
  );
};

const runRejectedImport = async (options) => {
  const bytes = await rejectedFixtureBytes(options.fixtureDocument);
  await waitForApplication(options.page, options.targetUrl);
  const before = await captureIndexedDbFingerprint(options.page);
  const downloads = collectDownloads(options.page);
  try {
    const measured = await importViaPublicWorker(options, bytes);
    const after = await captureIndexedDbFingerprint(options.page);
    const expectedCode =
      options.fixtureDocument.expectedTerminal.category === "resource-limit"
        ? "RESOURCE_LIMIT"
        : "SECURITY_REJECTED";
    const progressPhases = measured.value.progress.map(({ phase }) => phase);
    const observed = {
      "rejected-before-workbook-parse": !progressPhases.includes("parse"),
      "single-terminal-error":
        measured.value.terminalCount === 1 &&
        measured.value.response?.type === "XLSX_ERROR" &&
        measured.value.response.errorCode === expectedCode,
      "bounded-inflation-observed":
        options.fixtureDocument.dataset.generator ===
          "zip-compression-ratio-v1" &&
        progressPhases.every((phase) => phase !== "parse"),
      "zero-domain-commits": before === after,
      "zero-download-side-effects": downloads.downloads.length === 0,
    };
    return {
      metrics: selectMetrics(options.requiredTelemetry, measured),
      assertions: selectAssertions(options.requiredAssertions, observed),
      executionBinding: executionBinding({
        fixtureDocument: options.fixtureDocument,
        payloadBytes: bytes,
        semanticSha256: sha256Bytes(options.fixtureBytes),
      }),
    };
  } finally {
    downloads.dispose();
  }
};

const runFaultedUiImport = async (options) => {
  const worker = resolveSourceBoundWorkerAsset(options);
  const inputBytes = Buffer.from("PK\u0003\u0004", "binary");
  const fault = await installHashBoundWorkerFault({
    artifactBinding: options.artifactBinding,
    browserContext: options.browserContext,
    fixtureDocument: options.fixtureDocument,
    page: options.page,
    scenarioId: options.scenarioId,
    targetUrl: options.targetUrl,
    workerUrl: worker.url,
  });
  const downloads = collectDownloads(options.page);
  const dialogs = [];
  const dialogListener = async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  };
  const expectsTimeoutDialog = options.scenarioId === "xlsx-worker-timeout";
  if (expectsTimeoutDialog) options.page.on("dialog", dialogListener);
  try {
    await waitForApplication(options.page, options.targetUrl);
    const controlled = await options.page.evaluate(() => {
      const serviceWorker = globalThis.navigator.serviceWorker;
      return serviceWorker ? serviceWorker.controller !== null : false;
    });
    if (controlled) {
      throw new Error(
        "Fault scenario requires the natural uncontrolled first page",
      );
    }
    const before = await captureIndexedDbFingerprint(options.page);
    let acknowledgementStartedAt = performance.now();
    const measured = await measureBrowserOperation({
      browserContext: options.browserContext,
      page: options.page,
      operation: async () => {
        await options.page.getByLabel(XLSX_INPUT_LABEL).setInputFiles({
          name: `${options.scenarioId}.xlsx`,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: inputBytes,
        });
        const status = options.page.getByLabel("Excel処理状況");
        await status.waitFor({ state: "visible", timeout: 10_000 });
        if (options.scenarioId === "xlsx-worker-cancel") {
          await options.page
            .getByRole("status")
            .filter({ hasText: "parse 1/2" })
            .waitFor({ state: "visible", timeout: 10_000 });
          acknowledgementStartedAt = performance.now();
          await options.page
            .getByRole("button", { name: "Excel処理を取り消す" })
            .click();
        }
        await status.waitFor({
          state: "detached",
          timeout:
            options.scenarioId === "xlsx-worker-timeout" ? 40_000 : 10_000,
        });
        return {
          acknowledgementMs: performance.now() - acknowledgementStartedAt,
        };
      },
    });
    const [cancelBeacon, lateBeacon, ackBeacon] = await Promise.all([
      fault.waitForBeacon("cancel-received", 5_000),
      fault.waitForBeacon("late-result-sent", 5_000),
      fault.waitForBeacon("cancel-ack-sent", 5_000),
    ]);
    await fault.waitForWorkerClose(5_000);
    const after = await captureIndexedDbFingerprint(options.page);
    const terminalSurfaceCount = await options.page
      .getByRole("button", { name: "別名で復元" })
      .count();
    const observed = {
      "cancel-message-observed":
        cancelBeacon.requestId &&
        cancelBeacon.requestId === lateBeacon.requestId &&
        lateBeacon.requestId === ackBeacon.requestId,
      "worker-terminated": true,
      "late-result-ignored": terminalSurfaceCount === 0,
      "zero-domain-commits": before === after,
      "zero-download-side-effects": downloads.downloads.length === 0,
      "single-timeout-error-dialog":
        expectsTimeoutDialog &&
        dialogs.length === 1 &&
        dialogs[0] ===
          "アイテムの取り込みに失敗しました。ファイル形式を確認してください。",
    };
    const acknowledgementMetric =
      options.scenarioId === "xlsx-worker-cancel"
        ? { cancelAcknowledgementMs: measured.value.acknowledgementMs }
        : { timeoutAcknowledgementMs: measured.value.acknowledgementMs };
    return {
      metrics: selectMetrics(
        options.requiredTelemetry,
        measured,
        acknowledgementMetric,
      ),
      assertions: selectAssertions(options.requiredAssertions, observed),
      executionBinding: executionBinding({
        fixtureDocument: options.fixtureDocument,
        payloadBytes: inputBytes,
        semanticSha256: sha256Bytes(options.fixtureBytes),
        faultInjection: fault.binding,
      }),
    };
  } finally {
    if (expectsTimeoutDialog) options.page.off("dialog", dialogListener);
    downloads.dispose();
    await fault.dispose();
  }
};

export const publicXlsxScenarioAdapters = Object.freeze({
  "foundation-benign-main-thread-xlsx": runMainThreadXlsx,
  "xlsx-worker-import-valid": runValidImport,
  "xlsx-worker-export-roundtrip": runExportRoundTrip,
  "xlsx-worker-reject-corrupt": runRejectedImport,
  "xlsx-worker-reject-input-over-limit": runRejectedImport,
  "xlsx-worker-reject-zip-bomb": runRejectedImport,
  "xlsx-worker-cancel": runFaultedUiImport,
  "xlsx-worker-timeout": runFaultedUiImport,
});

export const PUBLIC_XLSX_SCENARIO_IDS = Object.freeze(
  Object.keys(publicXlsxScenarioAdapters),
);
