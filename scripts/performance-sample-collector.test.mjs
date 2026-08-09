import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseArguments,
  verifyTargetArtifactAssets,
} from "./collect-performance-samples.mjs";
import {
  assertCanonicalScenarioDispatch,
  buildDeterministicMeasurementSchedule,
  collectCanonicalPerformanceSamples,
  PERFORMANCE_COLLECTOR_CONTRACT,
} from "./lib/performance-sample-collector.mjs";
import {
  CANONICAL_SCENARIO_IDS,
  REQUIRED_PERFORMANCE_VARIANTS,
} from "./performance/canonicalScenarioDispatch.mjs";
import { verifyPerformancePolicy } from "./verify-performance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = {
  gitCommitSha: "a".repeat(40),
  sourceClosureSha256: "b".repeat(64),
  treeState: "clean",
  artifactSha256: "c".repeat(64),
  releaseVariant: structuredClone(REQUIRED_PERFORMANCE_VARIANTS["P5-LIST"]),
};
const environment = {
  machineProfile: {
    os: "fixture-os",
    cpu: "fixture-cpu",
    memoryBytes: 16_000_000_000,
    powerMode: "fixture-fixed-performance",
  },
  browser: {
    family: "chromium",
    version: "fixture-chromium-1",
    channel: "chromium",
  },
};

const createBrowser = () => {
  const state = { closed: 0, contexts: 0 };
  return {
    state,
    browser: {
      async newContext() {
        state.contexts += 1;
        return {
          async newPage() {
            return {};
          },
          async close() {
            state.closed += 1;
          },
        };
      },
    },
  };
};

const adapterRegistry = (adapter) =>
  Object.fromEntries(CANONICAL_SCENARIO_IDS.map((id) => [id, adapter]));

const currentFixtureLoader = (scenario) =>
  readFile(path.join(root, scenario.fixtureRef));

const makeExecutionBinding = () => ({
  adapterContract: "public-artifact-surface-v1",
  fixturePayload: {
    generator: "collector-test-v1",
    seed: 1967,
    cardinality: 10,
    payloadSha256: "d".repeat(64),
    semanticSha256: "e".repeat(64),
  },
  faultInjection: null,
  setup: null,
});

const makeResult = ({
  requiredAssertions,
  requiredTelemetry,
  sampleIndex,
  warmup,
}) => ({
  metrics: Object.fromEntries(
    requiredTelemetry.map((metric, index) => [
      metric,
      warmup ? 10_000 + index : sampleIndex + index / 10,
    ]),
  ),
  assertions: Object.fromEntries(
    requiredAssertions.map((assertion) => [assertion, true]),
  ),
  executionBinding: makeExecutionBinding(),
});

test("dispatches all 17 canonical scenarios and fixes the collector protocol", async () => {
  const context = await verifyPerformancePolicy({ root });
  assert.doesNotThrow(() => assertCanonicalScenarioDispatch(context));
  assert.equal(CANONICAL_SCENARIO_IDS.length, 17);
  assert.deepEqual(PERFORMANCE_COLLECTOR_CONTRACT, {
    rotation: "left-rotate-by-sample-index-v1",
    sampleCount: 30,
    warmupCount: 1,
  });
});

test("rejects P8 inherited collection before opening a browser context", async () => {
  const context = await verifyPerformancePolicy({ root });
  const { browser, state } = createBrowser();
  await assert.rejects(
    collectCanonicalPerformanceSamples({
      adapters: adapterRegistry(makeResult),
      artifactBinding: {
        archiveSha256: "c".repeat(64),
        outputFiles: [],
      },
      browser,
      context,
      environment,
      evidenceId: "perf-p8-inherited-rejected",
      gate: "P8-CLEAN",
      loadFixture: currentFixtureLoader,
      source: {
        ...source,
        releaseVariant: structuredClone(
          REQUIRED_PERFORMANCE_VARIANTS["P8-CLEAN"],
        ),
      },
      targetUrl: "https://performance.example.test/",
    }),
    /accepted-evidence closure; single-artifact collection is forbidden/,
  );
  assert.equal(state.contexts, 0);
});

test("uses one warmup then deterministic rotated 30-sample rounds", () => {
  const schedule = buildDeterministicMeasurementSchedule(
    ["scenario-a", "scenario-b", "scenario-c"],
    3,
  );
  assert.deepEqual(
    schedule
      .slice(0, 3)
      .map(({ phase, scenarioId }) => ({ phase, scenarioId })),
    [
      { phase: "warmup", scenarioId: "scenario-a" },
      { phase: "warmup", scenarioId: "scenario-b" },
      { phase: "warmup", scenarioId: "scenario-c" },
    ],
  );
  assert.deepEqual(
    schedule.slice(3).map(({ round, scenarioId }) => ({ round, scenarioId })),
    [
      { round: 0, scenarioId: "scenario-a" },
      { round: 0, scenarioId: "scenario-b" },
      { round: 0, scenarioId: "scenario-c" },
      { round: 1, scenarioId: "scenario-b" },
      { round: 1, scenarioId: "scenario-c" },
      { round: 1, scenarioId: "scenario-a" },
      { round: 2, scenarioId: "scenario-c" },
      { round: 2, scenarioId: "scenario-a" },
      { round: 2, scenarioId: "scenario-b" },
    ],
  );
  const fullSchedule = buildDeterministicMeasurementSchedule(
    CANONICAL_SCENARIO_IDS,
  );
  assert.equal(fullSchedule.length, 17 + 17 * 30);
  for (const id of CANONICAL_SCENARIO_IDS) {
    assert.equal(
      fullSchedule.filter(
        ({ phase, scenarioId }) => phase === "sample" && scenarioId === id,
      ).length,
      30,
    );
  }
});

test("collects 30 measurements in fresh contexts and excludes warmup", async () => {
  const context = await verifyPerformancePolicy({ root });
  const { browser, state } = createBrowser();
  const raw = await collectCanonicalPerformanceSamples({
    adapters: adapterRegistry(makeResult),
    browser,
    collectedAt: () => new Date("2026-08-09T00:00:00.000Z"),
    context,
    environment,
    evidenceId: "perf-p5-list-collector-test",
    gate: "P5-LIST",
    loadFixture: currentFixtureLoader,
    source,
    targetUrl: "https://performance.example.test/",
  });
  assert.equal(state.contexts, 31);
  assert.equal(state.closed, 31);
  assert.equal(raw.scenarios.length, 1);
  assert.deepEqual(
    raw.scenarios[0].samples,
    Array.from({ length: 30 }, (_, index) => index),
  );
  assert.deepEqual(
    raw.scenarios[0].supplementarySamples.rendererMismatchCount,
    Array.from({ length: 30 }, (_, index) => index + 0.1),
  );
  assert.equal(
    Object.values(raw.scenarios[0].outcomeAssertions).every(Boolean),
    true,
  );
  assert.deepEqual(raw.scenarios[0].executionBinding, makeExecutionBinding());
});

test("fails before sampling for an incomplete adapter or fixture drift", async () => {
  const context = await verifyPerformancePolicy({ root });
  const first = createBrowser();
  const incomplete = adapterRegistry(makeResult);
  delete incomplete["foundation-startup-cold"];
  await assert.rejects(
    collectCanonicalPerformanceSamples({
      adapters: incomplete,
      browser: first.browser,
      context,
      environment,
      evidenceId: "perf-p5-list-incomplete-adapter",
      gate: "P5-LIST",
      loadFixture: currentFixtureLoader,
      source,
      targetUrl: "https://performance.example.test/",
    }),
    /adapter registry is incomplete/,
  );
  assert.equal(first.state.contexts, 0);

  const second = createBrowser();
  await assert.rejects(
    collectCanonicalPerformanceSamples({
      adapters: adapterRegistry(makeResult),
      browser: second.browser,
      context,
      environment,
      evidenceId: "perf-p5-list-fixture-drift",
      gate: "P5-LIST",
      loadFixture: async () => Buffer.from("{}", "utf8"),
      source,
      targetUrl: "https://performance.example.test/",
    }),
    /fixture bytes differ from policy hash/,
  );
  assert.equal(second.state.contexts, 0);
});

test("fails closed for missing telemetry and a false functional assertion", async () => {
  const context = await verifyPerformancePolicy({ root });
  const missingTelemetry = createBrowser();
  await assert.rejects(
    collectCanonicalPerformanceSamples({
      adapters: adapterRegistry(({ requiredAssertions }) => ({
        metrics: {},
        assertions: Object.fromEntries(
          requiredAssertions.map((assertion) => [assertion, true]),
        ),
        executionBinding: makeExecutionBinding(),
      })),
      browser: missingTelemetry.browser,
      context,
      environment,
      evidenceId: "perf-p5-list-missing-telemetry",
      gate: "P5-LIST",
      loadFixture: currentFixtureLoader,
      source,
      targetUrl: "https://performance.example.test/",
    }),
    /telemetry must contain exactly/,
  );
  assert.equal(missingTelemetry.state.contexts, 1);
  assert.equal(missingTelemetry.state.closed, 1);

  const falseAssertion = createBrowser();
  await assert.rejects(
    collectCanonicalPerformanceSamples({
      adapters: adapterRegistry((options) => {
        const result = makeResult(options);
        const [firstAssertion] = Object.keys(result.assertions);
        result.assertions[firstAssertion] = false;
        return result;
      }),
      browser: falseAssertion.browser,
      context,
      environment,
      evidenceId: "perf-p5-list-false-assertion",
      gate: "P5-LIST",
      loadFixture: currentFixtureLoader,
      source,
      targetUrl: "https://performance.example.test/",
    }),
    /did not pass/,
  );
  assert.equal(falseAssertion.state.contexts, 1);
  assert.equal(falseAssertion.state.closed, 1);
});

test("fails closed when a generated payload binding drifts after warmup", async () => {
  const context = await verifyPerformancePolicy({ root });
  const { browser, state } = createBrowser();
  await assert.rejects(
    collectCanonicalPerformanceSamples({
      adapters: adapterRegistry((options) => {
        const result = makeResult(options);
        if (!options.warmup) {
          result.executionBinding.fixturePayload.payloadSha256 = "f".repeat(64);
        }
        return result;
      }),
      browser,
      context,
      environment,
      evidenceId: "perf-p5-list-binding-drift",
      gate: "P5-LIST",
      loadFixture: currentFixtureLoader,
      source,
      targetUrl: "https://performance.example.test/",
    }),
    /execution binding drifted between samples/,
  );
  assert.equal(state.contexts, 2);
  assert.equal(state.closed, 2);
});

test("collector CLI requires explicit artifact, environment, target, and output", () => {
  const parsed = parseArguments([
    "--gate",
    "P3-XLSX",
    "--evidence-id",
    "perf-p3-canonical-collection",
    "--artifact",
    "artifact.zip",
    "--artifact-manifest",
    "artifact-manifest.json",
    "--environment",
    "environment.json",
    "--target-url",
    "https://preview.example.test/",
    "--output",
    "raw.json",
  ]);
  assert.equal(parsed.gate, "P3-XLSX");
  assert.match(parsed.adapterModule, /canonicalPlaywrightAdapters\.mjs$/);
  const customAdapter = parseArguments([
    "--adapter-module",
    "custom.mjs",
    "--gate",
    "P3-XLSX",
    "--evidence-id",
    "perf-p3-canonical-collection",
    "--artifact",
    "artifact.zip",
    "--artifact-manifest",
    "artifact-manifest.json",
    "--environment",
    "environment.json",
    "--target-url",
    "https://preview.example.test/",
    "--output",
    "raw.json",
  ]);
  assert.equal(customAdapter.adapterModule, "custom.mjs");
  assert.throws(() => parseArguments(["--gate", "P3-XLSX"]), /Usage:/);
  assert.throws(
    () => parseArguments(["--gate", "P3-XLSX", "--gate", "P5-DUAL"]),
    /argument --gate is invalid/,
  );
});

test("verifies every public artifact asset byte and fails closed on drift", async () => {
  const bytes = Buffer.from("source-bound-asset", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const createAssetBrowser = ({
    status = 200,
    responseBytes = bytes,
  } = {}) => ({
    async newContext() {
      return {
        request: {
          async get(url) {
            assert.equal(url, "https://performance.example.test/assets/app.js");
            return {
              status: () => status,
              body: async () => responseBytes,
            };
          },
        },
        async close() {},
      };
    },
  });
  const manifest = {
    outputFiles: [{ path: "static/assets/app.js", size: bytes.length, sha256 }],
  };
  await assert.doesNotReject(
    verifyTargetArtifactAssets({
      browser: createAssetBrowser(),
      manifest,
      targetUrl: "https://performance.example.test/",
    }),
  );
  await assert.rejects(
    verifyTargetArtifactAssets({
      browser: createAssetBrowser({ status: 404 }),
      manifest,
      targetUrl: "https://performance.example.test/",
    }),
    /returned HTTP 404/,
  );
  await assert.rejects(
    verifyTargetArtifactAssets({
      browser: createAssetBrowser({
        responseBytes: Buffer.from("tampered", "utf8"),
      }),
      manifest,
      targetUrl: "https://performance.example.test/",
    }),
    /differs from artifact bytes/,
  );
  await assert.rejects(
    verifyTargetArtifactAssets({
      browser: createAssetBrowser(),
      manifest: { outputFiles: [] },
      targetUrl: "https://performance.example.test/",
    }),
    /contains no public static files/,
  );
  await assert.rejects(
    verifyTargetArtifactAssets({
      browser: createAssetBrowser(),
      manifest: {
        outputFiles: [
          { path: "static/assets/app.js?unsafe=1", size: bytes.length, sha256 },
        ],
      },
      targetUrl: "https://performance.example.test/",
    }),
    /asset path is unsafe/,
  );
});
