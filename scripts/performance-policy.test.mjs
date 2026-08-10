import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePerformanceStatistics,
  calculateSamplesSha256,
  projectPerformanceBudgetContract,
  verifyPerformanceEvidence,
  verifyPerformanceGate,
  verifyPerformancePolicy,
} from "./verify-performance-policy.mjs";
import {
  canonicalize,
  projectRoot,
  sha256,
} from "./foundation-policy-utils.mjs";
import { buildPerformanceEvidenceEnvelope } from "./lib/performance-evidence-builder.mjs";

const clone = (value) => structuredClone(value);
const primarySamples = Array.from({ length: 30 }, (_, index) => index + 1);
const zeroSamples = Array.from({ length: 30 }, () => 0);

test("uses the fixed median and nearest-rank p95 method", () => {
  assert.deepEqual(calculatePerformanceStatistics(primarySamples), {
    median: 15.5,
    p95: 29,
    maximum: 30,
  });
  assert.equal(
    calculateSamplesSha256(primarySamples),
    "ebda43c0ca7bab4c6b235bede1b8d289a4181c5bbe556cf1af17979956289a7b",
  );
});

test("validates canonical P0, XLSX Worker, and dual-list policy as pending", async () => {
  const context = await verifyPerformancePolicy({ root: projectRoot });
  assert.deepEqual(context.errors, []);
  assert.equal(context.scenarioMap.size, 17);
  assert.equal(context.fixtureMap.size, 12);
  assert.equal(context.pendingScenarioIds.length, 17);
  assert.ok(context.blockerMap.has("P3-PERFORMANCE-EVIDENCE"));
  assert.ok(context.blockerMap.has("P5-DUAL-PERFORMANCE-EVIDENCE"));
  assert.ok(context.blockerMap.has("P8-PERFORMANCE-CLOSURE"));
});

test("fails P3 acceptance while samples, ceilings, and source bindings are pending", async () => {
  const result = await verifyPerformanceGate({
    root: projectRoot,
    gate: "P3-XLSX",
    evidence: null,
  });
  assert.ok(
    result.errors.some((error) =>
      error.includes("xlsx-worker-timeout is pending"),
    ),
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("explicit blocker P3-PERFORMANCE-EVIDENCE remains"),
    ),
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("performance evidence envelope is required"),
    ),
  );
});

test("fails P8 closure while any inherited P0, P3, or P5 evidence is pending", async () => {
  const result = await verifyPerformanceGate({
    root: projectRoot,
    gate: "P8-CLEAN",
    evidence: null,
  });
  assert.ok(
    result.errors.some((error) =>
      error.includes("xlsx-worker-import-valid is pending"),
    ),
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("list-renderer-selection is pending"),
    ),
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("explicit blocker P8-PERFORMANCE-CLOSURE remains"),
    ),
  );
});

test("rejects removal of a mandatory cancel or renderer-selection scenario", async () => {
  const current = await verifyPerformancePolicy({
    root: projectRoot,
    verifyFixtures: false,
  });
  const uiScenarios = clone(current.uiScenarios);
  const budgets = clone(current.budgets);
  uiScenarios.scenarios = uiScenarios.scenarios.filter(
    ({ id }) => id !== "xlsx-worker-cancel",
  );
  budgets.scenarios = budgets.scenarios.filter(
    ({ id }) => id !== "xlsx-worker-cancel",
  );
  budgets.gateRequirements.find(({ gate }) => gate === "P3-XLSX").scenarioIds =
    budgets.gateRequirements
      .find(({ gate }) => gate === "P3-XLSX")
      .scenarioIds.filter((id) => id !== "xlsx-worker-cancel");

  const result = await verifyPerformancePolicy({
    root: projectRoot,
    uiScenarios,
    budgets,
    xlsxLimits: current.xlsxLimits,
    verifyFixtures: false,
  });
  assert.ok(
    result.errors.some((error) => error.includes("canonical P0/P3/P5 set")),
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("P3-XLSX: scenario ids do not match policy"),
    ),
  );
});

test("rejects a temporary performance exception at every gate", async () => {
  const current = await verifyPerformancePolicy({
    root: projectRoot,
    verifyFixtures: false,
  });
  const budgets = clone(current.budgets);
  budgets.gateRequirements.find(
    ({ gate }) => gate === "P8-CLEAN",
  ).temporaryExceptions = ["skip-list-virtual"];
  const result = await verifyPerformancePolicy({
    root: projectRoot,
    uiScenarios: current.uiScenarios,
    budgets,
    xlsxLimits: current.xlsxLimits,
    verifyFixtures: false,
  });
  assert.ok(
    result.errors.some((error) =>
      error.includes("temporary performance exceptions must be empty"),
    ),
  );
});

test("binds the compressed-input and timeout scenarios to XLSX resource limits", async () => {
  const current = await verifyPerformancePolicy({
    root: projectRoot,
    verifyFixtures: false,
  });
  const xlsxLimits = clone(current.xlsxLimits);
  xlsxLimits.maxCompressedBytes -= 1;
  xlsxLimits.maxWallTimeMs -= 1;
  const result = await verifyPerformancePolicy({
    root: projectRoot,
    uiScenarios: current.uiScenarios,
    budgets: current.budgets,
    xlsxLimits,
    verifyFixtures: true,
  });
  assert.ok(
    result.errors.some((error) =>
      error.includes("exactly one byte above maxCompressedBytes"),
    ),
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("timeout fixture must bind to xlsx maxWallTimeMs"),
    ),
  );
});

const bindP3Budget = async () => {
  const current = await verifyPerformancePolicy({
    root: projectRoot,
    verifyFixtures: false,
  });
  const budgets = clone(current.budgets);
  budgets.machineProfile = {
    status: "bound",
    os: "Windows 11",
    cpu: "Canonical CPU",
    memoryBytes: 34359738368,
    powerMode: "best-performance-ac",
  };
  budgets.browser = {
    family: "chromium",
    version: "140.0.7339.16",
    channel: "playwright",
  };
  budgets.blockers = budgets.blockers.filter(
    ({ blocksExit }) => blocksExit !== "P3-XLSX",
  );
  const p3Ids = new Set(
    budgets.gateRequirements.find(({ gate }) => gate === "P3-XLSX").scenarioIds,
  );
  for (const scenario of budgets.scenarios) {
    if (!p3Ids.has(scenario.id)) continue;
    scenario.measurement = { medianMs: 15.5, p95Ms: 29 };
    scenario.absoluteCeilingMs = 35;
    scenario.regressionCeilingPercent = 100;
    scenario.regressionReference = {
      evidenceSha256: "b".repeat(64),
      medianMs: 20,
      p95Ms: 30,
    };
    scenario.evidenceSha256 = "a".repeat(64);
    scenario.pendingState = null;
    for (const metric of Object.keys(scenario.supplementaryCeilings)) {
      scenario.supplementaryCeilings[metric] = 100;
    }
  }
  const initialContext = await verifyPerformancePolicy({
    root: projectRoot,
    uiScenarios: current.uiScenarios,
    budgets,
    xlsxLimits: current.xlsxLimits,
    verifyFixtures: true,
  });
  assert.deepEqual(initialContext.errors, []);

  const policyBindings = {
    uiScenariosSha256: sha256(canonicalize(initialContext.uiScenarios)),
    performanceBudgetContractSha256: sha256(
      canonicalize(projectPerformanceBudgetContract(budgets)),
    ),
    xlsxLimitsSha256: sha256(canonicalize(initialContext.xlsxLimits)),
  };
  const scenarioEvidence = [...p3Ids].map((id) => {
    const scenarioPolicy = initialContext.scenarioMap.get(id);
    const budget = initialContext.budgetMap.get(id);
    return {
      id,
      fixtureSha256: scenarioPolicy.fixtureSha256,
      primaryMetric: budget.primaryMetric,
      samples: primarySamples,
      samplesSha256: calculateSamplesSha256(primarySamples),
      statistics: calculatePerformanceStatistics(primarySamples),
      supplementaryMetrics: Object.keys(budget.supplementaryCeilings).map(
        (name) => ({
          name,
          samples: zeroSamples,
          samplesSha256: calculateSamplesSha256(zeroSamples),
          statistics: calculatePerformanceStatistics(zeroSamples),
        }),
      ),
      outcomeAssertions: Object.fromEntries(
        initialContext.fixtureMap
          .get(id)
          .requiredAssertions.map((assertion) => [assertion, true]),
      ),
      executionBinding: {
        adapterContract: "public-artifact-surface-v1",
        fixturePayload: {
          generator: "policy-test-v1",
          seed: 1967,
          cardinality: id === "xlsx-worker-export-roundtrip" ? 50_000 : 10,
          payloadSha256: "4".repeat(64),
          semanticSha256: "5".repeat(64),
        },
        faultInjection: null,
        setup:
          id === "xlsx-worker-export-roundtrip"
            ? {
                method: "indexeddb-schema-exact-single-transaction-stage-v1",
                timing: "excluded-from-measurement-v1",
                readback: "separate-readonly-transaction-v1",
                databaseName: "EventShoppingPlannerDB",
                databaseVersion: 5,
                storeName: "eventLists",
                controlStoreName: "syncQueue",
                key: "data",
                transactionStores: ["eventLists", "syncQueue"],
                payloadSha256: "4".repeat(64),
                semanticSha256: "5".repeat(64),
                itemCount: 50_000,
                revision: `performance-stage:${"4".repeat(64)}`,
              }
            : null,
      },
    };
  });
  const evidence = {
    evidenceId: "perf-p3-unit-fixture",
    gate: "P3-XLSX",
    collectedAtUtc: "2026-08-06T00:00:00.000Z",
    policyBindings,
    source: {
      gitCommitSha: "1".repeat(40),
      sourceClosureSha256: "2".repeat(64),
      treeState: "clean",
      artifactSha256: "3".repeat(64),
      releaseVariant: {
        releaseRole: "standard",
        xlsxExecution: "worker",
        listEngine: "full",
        listDefault: "full",
      },
    },
    environment: {
      machineProfile: {
        os: budgets.machineProfile.os,
        cpu: budgets.machineProfile.cpu,
        memoryBytes: budgets.machineProfile.memoryBytes,
        powerMode: budgets.machineProfile.powerMode,
      },
      browser: clone(budgets.browser),
    },
    sampleCount: 30,
    statisticsMethod: "median-average-p95-nearest-rank-v1",
    scenarios: scenarioEvidence,
  };
  const envelope = {
    schemaVersion: 1,
    evidence,
    evidenceSha256: sha256(canonicalize(evidence)),
  };
  for (const scenario of budgets.scenarios) {
    if (p3Ids.has(scenario.id)) {
      scenario.evidenceSha256 = envelope.evidenceSha256;
    }
  }
  const context = await verifyPerformancePolicy({
    root: projectRoot,
    uiScenarios: current.uiScenarios,
    budgets,
    xlsxLimits: current.xlsxLimits,
    verifyFixtures: true,
  });
  assert.deepEqual(context.errors, []);
  return { context, envelope };
};

test("accepts a source-bound P3 evidence envelope with 30 recomputable samples", async () => {
  const { context, envelope } = await bindP3Budget();
  const result = verifyPerformanceEvidence({
    context,
    gate: "P3-XLSX",
    envelope,
  });
  assert.deepEqual(result.errors, []);
});

test("builds evidence only from a complete closed 30-sample input", async () => {
  const { context, envelope } = await bindP3Budget();
  const input = {
    schemaVersion: 1,
    evidenceId: envelope.evidence.evidenceId,
    gate: envelope.evidence.gate,
    collectedAtUtc: envelope.evidence.collectedAtUtc,
    source: clone(envelope.evidence.source),
    environment: clone(envelope.evidence.environment),
    scenarios: envelope.evidence.scenarios.map((scenario) => ({
      id: scenario.id,
      samples: [...scenario.samples],
      supplementarySamples: Object.fromEntries(
        scenario.supplementaryMetrics.map((metric) => [
          metric.name,
          [...metric.samples],
        ]),
      ),
      outcomeAssertions: clone(scenario.outcomeAssertions),
      executionBinding: clone(scenario.executionBinding),
    })),
  };

  assert.deepEqual(
    buildPerformanceEvidenceEnvelope({ context, input }),
    envelope,
  );

  const truncated = clone(input);
  truncated.scenarios[0].samples.pop();
  assert.throws(
    () => buildPerformanceEvidenceEnvelope({ context, input: truncated }),
    /exactly 30 finite nonnegative samples/,
  );

  const extended = clone(input);
  extended.scenarios[0].unknown = true;
  assert.throws(
    () => buildPerformanceEvidenceEnvelope({ context, input: extended }),
    /must contain exactly/,
  );
});

test("rejects evidence when a 30-sample series is truncated", async () => {
  const { context, envelope } = await bindP3Budget();
  const broken = clone(envelope);
  broken.evidence.scenarios[0].samples.pop();
  broken.evidence.scenarios[0].samplesSha256 = calculateSamplesSha256(
    broken.evidence.scenarios[0].samples,
  );
  broken.evidenceSha256 = sha256(canonicalize(broken.evidence));
  const result = verifyPerformanceEvidence({
    context,
    gate: "P3-XLSX",
    envelope: broken,
  });
  assert.ok(
    result.errors.some((error) =>
      error.includes("exactly 30 finite samples are required"),
    ),
  );
});

test("performance contract hash excludes only the evidence envelope digest", async () => {
  const current = await verifyPerformancePolicy({
    root: projectRoot,
    verifyFixtures: false,
  });
  const left = clone(current.budgets);
  const right = clone(current.budgets);
  left.scenarios[0].evidenceSha256 = "1".repeat(64);
  right.scenarios[0].evidenceSha256 = "2".repeat(64);
  assert.deepEqual(
    projectPerformanceBudgetContract(left),
    projectPerformanceBudgetContract(right),
  );
});
