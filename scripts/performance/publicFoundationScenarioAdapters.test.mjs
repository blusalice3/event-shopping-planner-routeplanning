import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PUBLIC_FOUNDATION_ADAPTER_CONTRACT,
  PUBLIC_FOUNDATION_SCENARIO_IDS,
  publicFoundationScenarioAdapters,
} from "./publicFoundationScenarioAdapters.mjs";

const sha = (character) => character.repeat(64);
const sourceSha = "a".repeat(40);
const requiredStores = [
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
];

const makeHarness = ({
  identityRole = "standard",
  indexedDbMatched = true,
  storageUsage = 0,
} = {}) => {
  const calls = [];
  const state = {
    lastNavigation: null,
    renderedCount: 4,
    tracingComplete: null,
  };
  const traceBytes = JSON.stringify({
    traceEvents: [
      {
        ph: "M",
        name: "thread_name",
        pid: 10,
        tid: 20,
        args: { name: "CrRendererMain" },
      },
      {
        ph: "X",
        name: "RunTask",
        pid: 10,
        tid: 20,
        dur: 55_000,
      },
    ],
  });
  const response = { ok: () => true };
  const session = {
    async send(method, parameters) {
      calls.push(["cdp", method, parameters]);
      if (method === "Storage.getUsageAndQuota") {
        return {
          usageBreakdown: [
            { storageType: "indexeddb", usage: storageUsage },
            { storageType: "cache_storage", usage: 0 },
          ],
        };
      }
      if (method === "Tracing.end") {
        queueMicrotask(() =>
          state.tracingComplete?.({ stream: "fixture-trace-stream" }),
        );
      }
      if (method === "IO.read") {
        return { data: traceBytes, eof: true };
      }
      return {};
    },
    once(eventName, callback) {
      assert.equal(eventName, "Tracing.tracingComplete");
      state.tracingComplete = callback;
    },
    async detach() {
      calls.push(["cdp-detach"]);
    },
  };
  const roleTarget = (role, name) => ({
    async check() {
      calls.push(["check", role, String(name)]);
    },
    async click() {
      calls.push(["click", role, String(name)]);
    },
    async waitFor(options) {
      calls.push(["wait-role", role, String(name), options?.state]);
    },
  });
  const dialog = {
    async waitFor(options) {
      calls.push(["wait-dialog", options?.state]);
    },
    getByRole(role, options = {}) {
      return roleTarget(role, options.name);
    },
  };
  const page = {
    async evaluate(_script, request) {
      calls.push(["evaluate", request.operation]);
      if (request.operation === "standard-artifact") {
        return {
          buildId: sourceSha,
          releaseRole: identityRole,
          sourceSha,
          variantId: sha("b"),
        };
      }
      if (request.operation === "navigation-observation") {
        return {
          durationMs: state.lastNavigation === "reload" ? 42 : 84,
          navigationType: state.lastNavigation,
          serviceWorkerControlled: state.lastNavigation === "reload",
          serviceWorkerStartMs: state.lastNavigation === "reload" ? 3 : 0,
        };
      }
      if (request.operation === "prime-state") {
        return { active: true, cacheCount: 2 };
      }
      if (request.operation === "clock") return 100;
      if (request.operation === "clock-after-frames") return 124;
      if (request.operation === "indexeddb-ready") {
        return {
          durationMs: 2,
          matched: indexedDbMatched,
          storeNames: requiredStores,
          version: 5,
        };
      }
      if (request.operation === "measure-indexeddb") {
        return {
          durationMs: 7,
          matched: indexedDbMatched,
          storeNames: requiredStores,
          version: 5,
        };
      }
      throw new Error(`Unexpected browser operation ${request.operation}`);
    },
    async goto(url, options) {
      state.lastNavigation = "navigate";
      calls.push(["goto", url, options?.waitUntil]);
      return response;
    },
    async reload(options) {
      state.lastNavigation = "reload";
      calls.push(["reload", options?.waitUntil]);
      return response;
    },
    locator(selector) {
      return {
        async count() {
          calls.push(["count", selector]);
          return state.renderedCount;
        },
        async setInputFiles(file) {
          calls.push([
            "set-input-files",
            selector,
            file.name,
            file.buffer.length,
          ]);
        },
        async waitFor(options) {
          calls.push(["wait-locator", selector, options?.state]);
        },
      };
    },
    getByRole(role, options = {}) {
      if (role === "dialog") return dialog;
      return roleTarget(role, options.name);
    },
    getByText(text, options) {
      calls.push(["get-by-text", text, options?.exact]);
      return {
        last() {
          return roleTarget("text-last", text);
        },
      };
    },
    async waitForFunction() {
      calls.push(["wait-for-function"]);
    },
    async waitForTimeout(milliseconds) {
      calls.push(["wait-for-timeout", milliseconds]);
    },
  };
  const browserContext = {
    async clearCookies() {
      calls.push(["clear-cookies"]);
    },
    async newCDPSession(receivedPage) {
      assert.equal(receivedPage, page);
      calls.push(["new-cdp-session"]);
      return session;
    },
  };
  return { browserContext, calls, page };
};

const optionsFor = (scenarioId, harness, overrides = {}) => ({
  adapterKind: "foundation-browser",
  artifactBinding: {
    archiveSha256: sha("c"),
    outputFiles: [
      {
        path: "static/release-identity.json",
        sha256: sha("d"),
        size: 123,
      },
    ],
  },
  browserContext: harness.browserContext,
  fixtureBytes: Buffer.from(`fixture:${scenarioId}`, "utf8"),
  fixtureDocument: null,
  page: harness.page,
  requiredAssertions: ["scenario-completed"],
  requiredTelemetry: ["durationMs"],
  sampleIndex: 0,
  scenarioId,
  scheduleIndex: 1,
  targetUrl: "https://standard.example.test/",
  warmup: false,
  ...overrides,
});

const assertResultContract = (result, expectedDuration) => {
  assert.deepEqual(Object.keys(result).sort(), [
    "assertions",
    "executionBinding",
    "metrics",
  ]);
  assert.deepEqual(result.metrics, { durationMs: expectedDuration });
  assert.deepEqual(result.assertions, { "scenario-completed": true });
  assert.deepEqual(Object.keys(result.executionBinding).sort(), [
    "adapterContract",
    "faultInjection",
    "fixturePayload",
    "setup",
  ]);
  assert.equal(
    result.executionBinding.adapterContract,
    PUBLIC_FOUNDATION_ADAPTER_CONTRACT,
  );
  assert.equal(result.executionBinding.faultInjection, null);
  assert.equal(result.executionBinding.setup, null);
  assert.match(
    result.executionBinding.fixturePayload.payloadSha256,
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    result.executionBinding.fixturePayload.semanticSha256,
    /^[0-9a-f]{64}$/,
  );
};

test("exports only the four public foundation adapters without a target harness", async () => {
  assert.deepEqual(Object.keys(publicFoundationScenarioAdapters), [
    "foundation-startup-cold",
    "foundation-startup-warm",
    "foundation-full-list",
    "foundation-indexeddb-current",
  ]);
  assert.deepEqual(
    Object.keys(publicFoundationScenarioAdapters),
    PUBLIC_FOUNDATION_SCENARIO_IDS,
  );
  assert.equal(Object.isFrozen(publicFoundationScenarioAdapters), true);
  assert.equal(
    Object.hasOwn(
      publicFoundationScenarioAdapters,
      "foundation-benign-main-thread-xlsx",
    ),
    false,
  );
  const source = await readFile(
    new URL("./publicFoundationScenarioAdapters.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /__ESP_CANONICAL_PERFORMANCE_HARNESS__/);
  assert.doesNotMatch(source, /runScenario\s*\(/);
  assert.equal(source.includes(["add", "Init", "Script"].join("")), false);
  assert.doesNotMatch(source, /Object\.defineProperty\(globalThis/);
});

test("measures cold clear/navigation and same-context prime/reload semantics", async () => {
  const coldHarness = makeHarness();
  const cold = await publicFoundationScenarioAdapters[
    "foundation-startup-cold"
  ](optionsFor("foundation-startup-cold", coldHarness));
  assertResultContract(cold, 84);
  assert.deepEqual(
    coldHarness.calls
      .filter(([kind]) => kind === "cdp")
      .map(([, method]) => method)
      .slice(0, 4),
    [
      "Network.enable",
      "Network.clearBrowserCache",
      "Storage.clearDataForOrigin",
      "Storage.getUsageAndQuota",
    ],
  );
  const clearRequest = coldHarness.calls.find(
    ([kind, method]) =>
      kind === "cdp" && method === "Storage.clearDataForOrigin",
  );
  assert.equal(
    clearRequest[2].storageTypes,
    "cookies,indexeddb,local_storage,service_workers,cache_storage",
  );
  assert.equal(
    coldHarness.calls.filter(([kind]) => kind === "reload").length,
    0,
  );

  const warmHarness = makeHarness();
  const warm = await publicFoundationScenarioAdapters[
    "foundation-startup-warm"
  ](optionsFor("foundation-startup-warm", warmHarness));
  assertResultContract(warm, 42);
  assert.equal(warmHarness.calls.filter(([kind]) => kind === "goto").length, 1);
  assert.equal(
    warmHarness.calls.filter(([kind]) => kind === "reload").length,
    1,
  );
  const operations = warmHarness.calls
    .filter(([kind]) => kind === "evaluate")
    .map(([, operation]) => operation);
  assert.ok(
    operations.indexOf("prime-state") <
      operations.lastIndexOf("navigation-observation"),
  );
});

test("keeps fixture setup outside full-list and current IndexedDB measurements", async () => {
  const listHarness = makeHarness();
  const list = await publicFoundationScenarioAdapters["foundation-full-list"](
    optionsFor("foundation-full-list", listHarness),
  );
  assertResultContract(list, 24);
  assert.equal(list.executionBinding.fixturePayload.cardinality, 4);
  assert.equal(
    list.executionBinding.fixturePayload.generator,
    "public-backup-full-list-v1",
  );
  const listKinds = listHarness.calls.map(([kind, value]) => {
    if (kind === "evaluate" || kind === "cdp") return `${kind}:${value}`;
    return kind;
  });
  assert.ok(
    listKinds.indexOf("set-input-files") <
      listKinds.indexOf("cdp:Tracing.start"),
  );
  assert.ok(
    listKinds.indexOf("cdp:Tracing.start") <
      listKinds.indexOf("evaluate:clock"),
  );
  assert.ok(
    listKinds.indexOf("evaluate:clock") <
      listKinds.indexOf("evaluate:clock-after-frames"),
  );

  const indexedDbHarness = makeHarness();
  const indexedDb = await publicFoundationScenarioAdapters[
    "foundation-indexeddb-current"
  ](optionsFor("foundation-indexeddb-current", indexedDbHarness));
  assertResultContract(indexedDb, 7);
  assert.equal(indexedDb.executionBinding.fixturePayload.cardinality, 4);
  assert.equal(
    indexedDb.executionBinding.fixturePayload.generator,
    "public-backup-indexeddb-current-v1",
  );
  const indexedDbOperations = indexedDbHarness.calls
    .filter(([kind]) => kind === "evaluate")
    .map(([, operation]) => operation);
  assert.ok(
    indexedDbOperations.indexOf("indexeddb-ready") <
      indexedDbOperations.indexOf("measure-indexeddb"),
  );
});

test("fails closed for containment, dirty cold state, and caller telemetry drift", async () => {
  const containmentHarness = makeHarness({ identityRole: "containment" });
  await assert.rejects(
    publicFoundationScenarioAdapters["foundation-startup-cold"](
      optionsFor("foundation-startup-cold", containmentHarness),
    ),
    /only against a source-bound standard artifact/,
  );

  const dirtyHarness = makeHarness({ storageUsage: 1 });
  await assert.rejects(
    publicFoundationScenarioAdapters["foundation-startup-cold"](
      optionsFor("foundation-startup-cold", dirtyHarness),
    ),
    /storage was not cleared/,
  );

  const telemetryHarness = makeHarness();
  await assert.rejects(
    publicFoundationScenarioAdapters["foundation-startup-warm"](
      optionsFor("foundation-startup-warm", telemetryHarness, {
        requiredTelemetry: ["durationMs", "inventedMs"],
      }),
    ),
    /adapter input is invalid/,
  );
  assert.equal(telemetryHarness.calls.length, 0);

  const missingRecordHarness = makeHarness({ indexedDbMatched: false });
  await assert.rejects(
    publicFoundationScenarioAdapters["foundation-indexeddb-current"](
      optionsFor("foundation-indexeddb-current", missingRecordHarness),
    ),
    /not committed to current IndexedDB/,
  );
});
