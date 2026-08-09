import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalItems,
  buildCanonicalEventWorkbookBytes,
  canonicalEventItemsSemanticSha256,
  sha256Bytes,
} from "./canonicalPublicFixtures.mjs";
import {
  PUBLIC_XLSX_SCENARIO_IDS,
  publicXlsxScenarioAdapters,
  resolveSourceBoundWorkerAsset,
} from "./publicXlsxScenarioAdapters.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const createCdpSessionDouble = () => {
  let tracingComplete = null;
  return {
    async send(method) {
      if (method === "Performance.getMetrics") {
        return { metrics: [{ name: "JSHeapUsedSize", value: 1_000 }] };
      }
      if (method === "Tracing.end") {
        queueMicrotask(() => tracingComplete?.({ stream: "trace-stream" }));
        return {};
      }
      if (method === "IO.read") {
        return {
          data: JSON.stringify({
            traceEvents: [
              {
                ph: "M",
                name: "thread_name",
                args: { name: "CrRendererMain" },
                pid: 1,
                tid: 1,
              },
            ],
          }),
          eof: true,
        };
      }
      return {};
    },
    once(type, listener) {
      if (type === "Tracing.tracingComplete") tracingComplete = listener;
    },
    async detach() {},
  };
};

test("dispatches every XLSX scenario through a repo-owned public adapter", () => {
  assert.deepEqual(PUBLIC_XLSX_SCENARIO_IDS, [
    "foundation-benign-main-thread-xlsx",
    "xlsx-worker-import-valid",
    "xlsx-worker-export-roundtrip",
    "xlsx-worker-reject-corrupt",
    "xlsx-worker-reject-input-over-limit",
    "xlsx-worker-reject-zip-bomb",
    "xlsx-worker-cancel",
    "xlsx-worker-timeout",
  ]);
  for (const id of PUBLIC_XLSX_SCENARIO_IDS) {
    assert.equal(typeof publicXlsxScenarioAdapters[id], "function");
  }
});

test("binds one exact public Worker asset to its artifact manifest", () => {
  const entry = {
    path: "static/assets/xlsx.worker-source-bound.js",
    size: 123,
    sha256: "a".repeat(64),
  };
  assert.deepEqual(
    resolveSourceBoundWorkerAsset({
      artifactBinding: { outputFiles: [entry] },
      targetUrl: "https://performance.example.test/release/",
    }),
    {
      entry,
      url: "https://performance.example.test/assets/xlsx.worker-source-bound.js",
    },
  );
  assert.throws(
    () =>
      resolveSourceBoundWorkerAsset({
        artifactBinding: { outputFiles: [] },
        targetUrl: "https://performance.example.test/",
      }),
    /Expected one source-bound XLSX Worker asset/,
  );
  assert.throws(
    () =>
      resolveSourceBoundWorkerAsset({
        artifactBinding: { outputFiles: [entry, { ...entry }] },
        targetUrl: "https://performance.example.test/",
      }),
    /received 2/,
  );
});

test("generates one deterministic source-bound workbook recipe", async () => {
  const first = await buildCanonicalEventWorkbookBytes({
    rowCount: 10,
    seed: 1967,
  });
  const second = await buildCanonicalEventWorkbookBytes({
    rowCount: 10,
    seed: 1967,
  });
  assert.equal(first.bytes.subarray(0, 2).toString("ascii"), "PK");
  assert.equal(first.payloadSha256, sha256Bytes(first.bytes));
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.semanticSha256, second.semanticSha256);
});

test("binds round-trip semantics to every exported item field", () => {
  const items = buildCanonicalItems({ rowCount: 2, seed: 1967 });
  const expected = canonicalEventItemsSemanticSha256("semantic-event", items);
  const changed = structuredClone(items);
  changed[1].circle = "drifted non-ID field";
  assert.notEqual(
    canonicalEventItemsSemanticSha256("semantic-event", changed),
    expected,
  );
  changed[1].circle = items[1].circle;
  changed[1].purchaseStatus = "Purchased";
  assert.notEqual(
    canonicalEventItemsSemanticSha256("semantic-event", changed),
    expected,
  );
});

test("fault fixture hashes bind the exact tracked Worker bytes", async () => {
  for (const [scenarioId, workerName] of [
    ["xlsx-worker-cancel", "cancel.worker.js"],
    ["xlsx-worker-timeout", "timeout.worker.js"],
  ]) {
    const fixture = JSON.parse(
      await readFile(
        path.join(
          root,
          "scripts",
          "fixtures",
          "performance",
          `${scenarioId}.json`,
        ),
        "utf8",
      ),
    );
    const workerBytes = await readFile(
      path.join(root, "scripts", "performance", "fault-workers", workerName),
    );
    assert.equal(
      fixture.faultInjection.replacementSha256,
      sha256Bytes(workerBytes),
    );
    assert.equal(
      fixture.faultInjection.method,
      "playwright-exact-worker-response-substitution-v1",
    );
  }
});

test("executes the default benign XLSX adapter through the public file surface", async () => {
  const calls = [];
  const locator = (label) => ({
    async setInputFiles(file) {
      calls.push(["input", label, file.name, file.buffer.length]);
    },
    async waitFor() {
      calls.push(["wait", label]);
    },
  });
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    getByLabel(label) {
      return locator(label);
    },
    getByRole(role, options) {
      return locator(`${role}:${options.name}`);
    },
    on() {},
    off() {},
    async evaluate(callback) {
      return callback();
    },
  };
  const browserContext = {
    async newCDPSession() {
      return createCdpSessionDouble();
    },
  };
  const result = await publicXlsxScenarioAdapters[
    "foundation-benign-main-thread-xlsx"
  ]({
    browserContext,
    fixtureBytes: Buffer.from("tracked-foundation-fixture", "utf8"),
    fixtureDocument: null,
    page,
    requiredAssertions: ["scenario-completed"],
    requiredTelemetry: ["durationMs"],
    scenarioId: "foundation-benign-main-thread-xlsx",
    targetUrl: "https://performance.example.test/release/",
  });
  assert.equal(result.assertions["scenario-completed"], true);
  assert.equal(
    result.executionBinding.adapterContract,
    "public-artifact-surface-v1",
  );
  assert.equal(result.executionBinding.setup, null);
  assert.ok(result.metrics.durationMs >= 0);
  assert.deepEqual(calls.slice(0, 2), [
    ["goto", "https://performance.example.test/release/", "networkidle"],
    ["wait", "バックアップファイルを選択"],
  ]);
  assert.equal(
    calls.some(([kind]) => kind === "input"),
    true,
  );
});

test("round-trips the production UI export download through the public Worker", async () => {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        root,
        "scripts",
        "fixtures",
        "performance",
        "xlsx-worker-export-roundtrip.json",
      ),
      "utf8",
    ),
  );
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-public-export-"),
  );
  const downloadPath = path.join(temporaryRoot, "public-export.xlsx");
  await writeFile(
    downloadPath,
    Buffer.from("PK\u0003\u0004public-export", "binary"),
  );
  const workerUrl =
    "https://performance.example.test/assets/xlsx.worker-source-bound.js";
  const listeners = new Map();
  const waiters = new Map();
  const calls = [];
  const emit = (type, value) => {
    for (const listener of listeners.get(type) ?? []) listener(value);
    const waiter = waiters.get(type);
    if (waiter) {
      waiters.delete(type);
      waiter(value);
    }
  };
  const locator = (name, click = async () => calls.push(["click", name])) => ({
    async check() {
      calls.push(["check", name]);
    },
    async click() {
      await click();
    },
    filter() {
      return this;
    },
    getByRole(role, options) {
      return locator(`${name}:${role}:${options.name}`);
    },
    async setInputFiles(file) {
      calls.push(["input", name, file.name, file.buffer.length]);
    },
    async waitFor() {
      calls.push(["wait", name]);
    },
  });
  const page = {
    async evaluate(callback, argument) {
      if (argument?.contract === "event-export-idb-stage-v1") {
        calls.push([
          "idb-stage",
          argument.eventName,
          argument.itemCount,
          argument.payloadSha256,
        ]);
        return {
          contract: argument.contract,
          databaseName: "EventShoppingPlannerDB",
          databaseVersion: 5,
          storeName: "eventLists",
          controlStoreName: "syncQueue",
          key: "data",
          payloadSha256: argument.payloadSha256,
          semanticSha256: argument.expectedSemanticSha256,
          itemCount: argument.itemCount,
          transactionStores: ["eventLists", "syncQueue"],
        };
      }
      return callback(argument);
    },
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    getByLabel(label) {
      return locator(`label:${label}`);
    },
    getByRole(role, options) {
      const accessibleName = options?.name ?? "";
      const name = `${role}:${accessibleName}`;
      if (role === "button" && accessibleName === "エクスポート") {
        return locator(name, async () => {
          calls.push(["public-export-confirmed"]);
          emit("worker", { url: () => workerUrl });
          await new Promise((resolve) => setTimeout(resolve, 35));
          emit("download", {
            async path() {
              return downloadPath;
            },
            suggestedFilename() {
              return "canonical-worker-roundtrip.xlsx";
            },
          });
        });
      }
      return locator(name);
    },
    async reload(options) {
      calls.push(["reload", options.waitUntil]);
    },
    off(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(
          (candidate) => candidate !== listener,
        ),
      );
    },
    on(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    waitForEvent(type) {
      return new Promise((resolve) => waiters.set(type, resolve));
    },
  };
  const browserContext = {
    async newCDPSession() {
      return createCdpSessionDouble();
    },
  };
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class PublicWorkerContractDouble {
    #listeners = new Map();

    constructor(url) {
      emit("worker", { url: () => url });
    }

    addEventListener(type, listener) {
      this.#listeners.set(type, listener);
    }

    postMessage(request) {
      const listener = this.#listeners.get("message");
      setTimeout(() => {
        listener({
          data: {
            type: "XLSX_PROGRESS",
            requestId: request.requestId,
            progress: { phase: "parse", completed: 1, total: 1 },
          },
        });
        listener({
          data: {
            type: "XLSX_IMPORT_RESULT",
            requestId: request.requestId,
            result: {
              value: {
                eventName: "canonical-worker-roundtrip",
                items: buildCanonicalItems({ rowCount: 50_000, seed: 1967 }),
              },
            },
          },
        });
      }, 35);
    }

    terminate() {}
  };
  try {
    const result = await publicXlsxScenarioAdapters[
      "xlsx-worker-export-roundtrip"
    ]({
      artifactBinding: {
        outputFiles: [
          {
            path: "static/assets/xlsx.worker-source-bound.js",
            size: 123,
            sha256: "a".repeat(64),
          },
        ],
      },
      browserContext,
      fixtureBytes: Buffer.from(JSON.stringify(fixture), "utf8"),
      fixtureDocument: fixture,
      page,
      requiredAssertions: fixture.requiredAssertions,
      requiredTelemetry: fixture.requiredTelemetry,
      scenarioId: fixture.scenarioId,
      targetUrl: "https://performance.example.test/release/",
    });
    assert.deepEqual(result.assertions, {
      "worker-execution-observed": true,
      "ui-heartbeat-observed": true,
      "progress-observed": true,
      "single-terminal-result": true,
      "round-trip-semantic-parity": true,
      "single-atomic-download": true,
    });
    assert.equal(
      calls.some(([kind]) => kind === "public-export-confirmed"),
      true,
    );
    assert.equal(
      calls.some(
        ([kind, eventName, itemCount]) =>
          kind === "idb-stage" &&
          eventName === "canonical-worker-roundtrip" &&
          itemCount === 50_000,
      ),
      true,
    );
    assert.equal(
      result.executionBinding.fixturePayload.generator,
      "event-export-idb-stage-v1",
    );
    assert.deepEqual(result.executionBinding.setup, {
      method: "indexeddb-schema-exact-single-transaction-stage-v1",
      timing: "excluded-from-measurement-v1",
      readback: "separate-readonly-transaction-v1",
      databaseName: "EventShoppingPlannerDB",
      databaseVersion: 5,
      storeName: "eventLists",
      controlStoreName: "syncQueue",
      key: "data",
      transactionStores: ["eventLists", "syncQueue"],
      payloadSha256: result.executionBinding.fixturePayload.payloadSha256,
      semanticSha256: result.executionBinding.fixturePayload.semanticSha256,
      itemCount: 50_000,
      revision: `performance-stage:${result.executionBinding.fixturePayload.payloadSha256}`,
    });
    assert.equal(
      result.executionBinding.fixturePayload.payloadSha256,
      /^[0-9a-f]{64}$/.test(
        result.executionBinding.fixturePayload.payloadSha256,
      )
        ? result.executionBinding.fixturePayload.payloadSha256
        : null,
    );
  } finally {
    globalThis.Worker = originalWorker;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("keeps the XLSX adapter free of synthetic download and legacy target hooks", async () => {
  const source = await readFile(
    path.join(root, "scripts", "performance", "publicXlsxScenarioAdapters.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /foundation-performance-scenario/);
  assert.doesNotMatch(source, /__ESP_CANONICAL_PERFORMANCE_HARNESS__/);
  assert.doesNotMatch(source, /createObjectURL|new globalThis\.Blob/);
  assert.match(source, /getByRole\("button", \{\s*name: "Excel形式で出力"/);
  assert.match(source, /waitForEvent\("download"\)/);
  assert.match(source, /await readFile\(downloadPath\)/);
});
