#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  fail,
  projectRoot,
  sha256,
} from "./foundation-policy-utils.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SCENARIO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATISTICS_METHOD = "median-average-p95-nearest-rank-v1";
const SAMPLE_COUNT = 30;

const REQUIRED_GATES = Object.freeze({
  "P0-TOOLCHAIN": {
    inherits: [],
    evidenceScope: "own",
    scenarioIds: [
      "foundation-startup-cold",
      "foundation-startup-warm",
      "foundation-full-list",
      "foundation-benign-main-thread-xlsx",
      "foundation-indexeddb-current",
    ],
  },
  "P3-XLSX": {
    inherits: ["P0-TOOLCHAIN"],
    evidenceScope: "own",
    scenarioIds: [
      "xlsx-worker-import-valid",
      "xlsx-worker-export-roundtrip",
      "xlsx-worker-reject-corrupt",
      "xlsx-worker-reject-input-over-limit",
      "xlsx-worker-reject-zip-bomb",
      "xlsx-worker-cancel",
      "xlsx-worker-timeout",
    ],
  },
  "P5-DUAL": {
    inherits: ["P3-XLSX"],
    evidenceScope: "own",
    scenarioIds: [
      "list-long-full",
      "list-long-virtual",
      "list-virtual-scroll-anchor",
      "list-virtual-focus-interaction",
    ],
  },
  "P5-LIST": {
    inherits: ["P5-DUAL"],
    evidenceScope: "own",
    scenarioIds: ["list-renderer-selection"],
  },
  "P8-CLEAN": {
    inherits: ["P5-LIST"],
    evidenceScope: "all-inherited",
    scenarioIds: [],
  },
});

const REQUIRED_VARIANTS = Object.freeze({
  "P0-TOOLCHAIN": {
    releaseRole: "standard",
    xlsxExecution: "main",
    listEngine: "full",
    listDefault: "full",
  },
  "P3-XLSX": {
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "full",
    listDefault: "full",
  },
  "P5-DUAL": {
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "dual",
    listDefault: "full",
  },
  "P5-LIST": {
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "dual",
    listDefault: "auto",
  },
  "P8-CLEAN": {
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "dual",
    listDefault: "auto",
  },
});

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sorted = (values) => [...values].sort();

const sameStringSet = (actual, expected) =>
  Array.isArray(actual) &&
  actual.every((value) => typeof value === "string") &&
  JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));

const isFiniteNonnegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isFinitePositive = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const roundStatistic = (value) => Number(value.toFixed(6));

export const calculatePerformanceStatistics = (samples) => {
  if (
    !Array.isArray(samples) ||
    samples.length === 0 ||
    samples.some((sample) => !isFiniteNonnegative(sample))
  ) {
    throw new TypeError(
      "Performance samples must be a non-empty array of finite nonnegative numbers.",
    );
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0
      ? (ordered[midpoint - 1] + ordered[midpoint]) / 2
      : ordered[midpoint];
  const p95Index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
  return {
    median: roundStatistic(median),
    p95: roundStatistic(ordered[p95Index]),
    maximum: roundStatistic(ordered[ordered.length - 1]),
  };
};

export const calculateSamplesSha256 = (samples) =>
  sha256(canonicalize(samples));

export const projectPerformanceBudgetContract = (budgets) => {
  const projected = structuredClone(budgets);
  for (const scenario of projected.scenarios ?? []) {
    scenario.evidenceSha256 = null;
  }
  return projected;
};

const readJsonAt = async (root, relativePath) => {
  const bytes = await readFile(path.resolve(root, relativePath));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
};

const resolveInsideRoot = (root, relativePath) => {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolvedPath;
};

const readBaselineFixture = (root, sourceSha, fixtureRef) =>
  execFileSync("git", ["show", `${sourceSha}:${fixtureRef}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });

const readCurrentFixture = async (root, fixtureRef) => {
  const absolutePath = resolveInsideRoot(root, fixtureRef);
  if (absolutePath === null) {
    throw new Error("fixture path is not a normalized project-relative path");
  }
  return readFile(absolutePath);
};

const parseJsonBytes = (bytes) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
};

const uniqueMap = (entries, getId, label, errors) => {
  const result = new Map();
  if (!Array.isArray(entries)) {
    errors.push(`${label} must be an array`);
    return result;
  }
  for (const entry of entries) {
    const id = getId(entry);
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${label} contains an entry without an id`);
      continue;
    }
    if (result.has(id)) {
      errors.push(`${label} contains duplicate id ${id}`);
      continue;
    }
    result.set(id, entry);
  }
  return result;
};

const resolveGateScenarioIdsInternal = (
  gateMap,
  gate,
  visiting,
  resolved,
  errors,
) => {
  if (resolved.has(gate)) return resolved.get(gate);
  if (visiting.has(gate)) {
    errors.push(`gate inheritance contains a cycle at ${gate}`);
    return [];
  }
  const requirement = gateMap.get(gate);
  if (!requirement) {
    errors.push(`gate ${gate} is not defined`);
    return [];
  }
  visiting.add(gate);
  const ids = [];
  for (const inheritedGate of requirement.inherits ?? []) {
    ids.push(
      ...resolveGateScenarioIdsInternal(
        gateMap,
        inheritedGate,
        visiting,
        resolved,
        errors,
      ),
    );
  }
  ids.push(...(requirement.scenarioIds ?? []));
  visiting.delete(gate);
  const uniqueIds = [...new Set(ids)];
  resolved.set(gate, uniqueIds);
  return uniqueIds;
};

export const resolveGateScenarioIds = (budgets, gate) => {
  const errors = [];
  const gateMap = uniqueMap(
    budgets.gateRequirements,
    (entry) => entry?.gate,
    "gateRequirements",
    errors,
  );
  const scenarioIds = resolveGateScenarioIdsInternal(
    gateMap,
    gate,
    new Set(),
    new Map(),
    errors,
  );
  return { scenarioIds, errors };
};

const validateFixtureContract = (fixture, scenario, xlsxLimits, errors) => {
  const prefix = scenario.id;
  if (!isRecord(fixture)) {
    errors.push(`${prefix}: fixture must be a JSON object`);
    return;
  }
  if (fixture.schemaVersion !== 1) {
    errors.push(`${prefix}: fixture schemaVersion must be 1`);
  }
  if (fixture.scenarioId !== scenario.id) {
    errors.push(`${prefix}: fixture scenarioId does not match`);
  }
  if (
    !Array.isArray(fixture.requiredAssertions) ||
    fixture.requiredAssertions.length === 0 ||
    fixture.requiredAssertions.some(
      (assertion) => typeof assertion !== "string" || assertion.length === 0,
    )
  ) {
    errors.push(`${prefix}: fixture requiredAssertions must be non-empty`);
  }
  if (
    !Array.isArray(fixture.requiredTelemetry) ||
    fixture.requiredTelemetry.length === 0
  ) {
    errors.push(`${prefix}: fixture requiredTelemetry must be non-empty`);
  }

  if (scenario.id === "xlsx-worker-reject-input-over-limit") {
    const compressedBytes = fixture.dataset?.compressedBytes;
    const configuredLimit =
      fixture.resourcePolicyExpectation?.configuredLimitBytes;
    if (
      configuredLimit !== xlsxLimits.maxCompressedBytes ||
      compressedBytes !== xlsxLimits.maxCompressedBytes + 1 ||
      fixture.resourcePolicyExpectation?.excessBytes !== 1
    ) {
      errors.push(
        `${prefix}: fixture must test exactly one byte above maxCompressedBytes`,
      );
    }
  }
  if (scenario.id === "xlsx-worker-timeout") {
    if (
      fixture.operation?.requestTimeoutMs !== xlsxLimits.maxWallTimeMs ||
      fixture.resourcePolicyExpectation?.configuredLimitMs !==
        xlsxLimits.maxWallTimeMs
    ) {
      errors.push(`${prefix}: timeout fixture must bind to xlsx maxWallTimeMs`);
    }
  }
  if (scenario.id === "xlsx-worker-reject-zip-bomb") {
    const configuredLimit = fixture.resourcePolicyExpectation?.configuredLimit;
    const ratio = fixture.dataset?.compressionRatio;
    if (
      configuredLimit !== xlsxLimits.maxCompressionRatio ||
      !isFinitePositive(ratio) ||
      ratio <= xlsxLimits.maxCompressionRatio
    ) {
      errors.push(
        `${prefix}: ZIP bomb fixture must exceed maxCompressionRatio`,
      );
    }
  }
  if (scenario.id === "xlsx-worker-cancel") {
    const assertions = new Set(fixture.requiredAssertions ?? []);
    for (const assertion of [
      "cancel-message-observed",
      "late-result-ignored",
      "zero-domain-commits",
      "zero-download-side-effects",
    ]) {
      if (!assertions.has(assertion)) {
        errors.push(`${prefix}: missing cancel assertion ${assertion}`);
      }
    }
  }
  if (scenario.id === "list-renderer-selection") {
    const cases = new Map(
      (fixture.eligibilityMatrix ?? []).map((entry) => [entry.case, entry]),
    );
    for (const fallbackCase of [
      "drag-active",
      "multiple-columns",
      "unsupported-zoom",
      "modal-active",
      "recovery-active",
    ]) {
      if (cases.get(fallbackCase)?.expectedRenderer !== "full") {
        errors.push(`${prefix}: ${fallbackCase} must select the full renderer`);
      }
    }
    if (cases.get("eligible-single-column")?.expectedRenderer !== "virtual") {
      errors.push(
        `${prefix}: proven single-column eligibility must select virtual`,
      );
    }
  }
};

const validateMeasurement = (scenario, errors) => {
  const prefix = `performance scenario ${scenario.id}`;
  const supplementaryValues = Object.values(
    isRecord(scenario.supplementaryCeilings)
      ? scenario.supplementaryCeilings
      : {},
  );
  const acceptanceValues = [
    scenario.measurement,
    scenario.absoluteCeilingMs,
    scenario.regressionCeilingPercent,
    scenario.regressionReference,
    scenario.evidenceSha256,
    ...supplementaryValues,
  ];
  const allNull = acceptanceValues.every((value) => value === null);
  const allBound = acceptanceValues.every((value) => value !== null);

  if (!allNull && !allBound) {
    errors.push(
      `${prefix}: acceptance fields must be entirely pending or entirely bound`,
    );
  }
  if (allNull) {
    if (
      scenario.pendingState?.status !== "external-blocked" ||
      !Array.isArray(scenario.pendingState.blockerIds) ||
      scenario.pendingState.blockerIds.length === 0
    ) {
      errors.push(`${prefix}: null budgets require explicit blocker ids`);
    }
    return "pending";
  }
  if (scenario.pendingState !== null) {
    errors.push(`${prefix}: accepted budget must have pendingState null`);
  }
  if (
    !isRecord(scenario.measurement) ||
    !isFiniteNonnegative(scenario.measurement.medianMs) ||
    !isFiniteNonnegative(scenario.measurement.p95Ms) ||
    scenario.measurement.p95Ms < scenario.measurement.medianMs
  ) {
    errors.push(`${prefix}: measurement medianMs/p95Ms is invalid`);
  }
  if (!isFinitePositive(scenario.absoluteCeilingMs)) {
    errors.push(`${prefix}: absoluteCeilingMs must be positive`);
  }
  if (!isFiniteNonnegative(scenario.regressionCeilingPercent)) {
    errors.push(`${prefix}: regressionCeilingPercent must be nonnegative`);
  }
  if (
    !isRecord(scenario.regressionReference) ||
    !SHA256_PATTERN.test(scenario.regressionReference.evidenceSha256 ?? "") ||
    !isFinitePositive(scenario.regressionReference.medianMs) ||
    !isFinitePositive(scenario.regressionReference.p95Ms)
  ) {
    errors.push(`${prefix}: regressionReference is invalid`);
  }
  if (!SHA256_PATTERN.test(scenario.evidenceSha256 ?? "")) {
    errors.push(`${prefix}: evidenceSha256 is invalid`);
  }
  for (const [metric, ceiling] of Object.entries(
    scenario.supplementaryCeilings ?? {},
  )) {
    if (!isFiniteNonnegative(ceiling)) {
      errors.push(`${prefix}: supplementary ceiling ${metric} is invalid`);
    }
  }
  return "accepted";
};

export const verifyPerformancePolicy = async ({
  root = projectRoot,
  uiScenarios: suppliedUiScenarios,
  budgets: suppliedBudgets,
  xlsxLimits: suppliedXlsxLimits,
  verifyFixtures = true,
} = {}) => {
  const errors = [];
  const uiScenarios =
    suppliedUiScenarios ?? (await readJsonAt(root, "config/ui-scenarios.json"));
  const budgets =
    suppliedBudgets ??
    (await readJsonAt(root, "config/performance-budgets.json"));
  const xlsxLimits =
    suppliedXlsxLimits ?? (await readJsonAt(root, "config/xlsx-limits.json"));

  if (uiScenarios.schemaVersion !== 2) {
    errors.push("ui-scenarios schemaVersion must be 2");
  }
  if (budgets.schemaVersion !== 2) {
    errors.push("performance-budgets schemaVersion must be 2");
  }
  if (uiScenarios.fixtureHashAlgorithm !== "sha256-raw-bytes") {
    errors.push("fixtureHashAlgorithm must be sha256-raw-bytes");
  }
  if (
    uiScenarios.baselineFixtureSourceSha !== budgets.measurementSourceSha ||
    !GIT_SHA_PATTERN.test(budgets.measurementSourceSha ?? "")
  ) {
    errors.push("baseline fixture source must match measurementSourceSha");
  }
  if (budgets.sampleCount !== SAMPLE_COUNT) {
    errors.push(`sampleCount must be exactly ${SAMPLE_COUNT}`);
  }
  if (!sameStringSet(budgets.statistics, ["median", "p95"])) {
    errors.push("statistics must contain exactly median and p95");
  }
  if (budgets.statisticsMethod !== STATISTICS_METHOD) {
    errors.push(`statisticsMethod must be ${STATISTICS_METHOD}`);
  }
  if (
    budgets.measurementRules?.outlierRemoval !== "forbidden" ||
    budgets.measurementRules?.primaryAbsoluteCeilingAppliesTo !== "p95" ||
    !sameStringSet(budgets.measurementRules?.regressionCeilingAppliesTo, [
      "median",
      "p95",
    ])
  ) {
    errors.push("measurement rules do not enforce the canonical statistics");
  }
  if (budgets.evidenceSchemaRef !== "config/performance-evidence.schema.json") {
    errors.push("evidenceSchemaRef is not canonical");
  } else {
    try {
      const evidenceSchema = await readJsonAt(root, budgets.evidenceSchemaRef);
      if (
        evidenceSchema.$id !==
        "https://event-shopping-planner.invalid/schemas/performance-evidence-v1.json"
      ) {
        errors.push("performance evidence schema id is not canonical");
      }
    } catch (error) {
      errors.push(
        `performance evidence schema is unreadable: ${error.message}`,
      );
    }
  }

  const scenarioMap = uniqueMap(
    uiScenarios.scenarios,
    (scenario) => scenario?.id,
    "ui scenarios",
    errors,
  );
  const budgetMap = uniqueMap(
    budgets.scenarios,
    (scenario) => scenario?.id,
    "performance scenarios",
    errors,
  );
  const blockerMap = uniqueMap(
    budgets.blockers,
    (blocker) => blocker?.id,
    "performance blockers",
    errors,
  );
  const gateMap = uniqueMap(
    budgets.gateRequirements,
    (requirement) => requirement?.gate,
    "gate requirements",
    errors,
  );

  const expectedScenarioIds = Object.values(REQUIRED_GATES).flatMap(
    ({ scenarioIds }) => scenarioIds,
  );
  if (!sameStringSet([...scenarioMap.keys()], expectedScenarioIds)) {
    errors.push("ui scenarios do not match the canonical P0/P3/P5 set");
  }
  if (!sameStringSet([...budgetMap.keys()], expectedScenarioIds)) {
    errors.push("performance scenarios do not match ui scenario ids");
  }
  if (!sameStringSet([...gateMap.keys()], Object.keys(REQUIRED_GATES))) {
    errors.push("gate requirements do not match P0/P3/P5/P8");
  }

  for (const [gate, expected] of Object.entries(REQUIRED_GATES)) {
    const actual = gateMap.get(gate);
    if (!actual) continue;
    if (!sameStringSet(actual.inherits, expected.inherits)) {
      errors.push(`${gate}: inherited gates do not match policy`);
    }
    if (!sameStringSet(actual.scenarioIds, expected.scenarioIds)) {
      errors.push(`${gate}: scenario ids do not match policy`);
    }
    if (actual.evidenceScope !== expected.evidenceScope) {
      errors.push(`${gate}: evidenceScope must be ${expected.evidenceScope}`);
    }
    if (
      !Array.isArray(actual.temporaryExceptions) ||
      actual.temporaryExceptions.length !== 0
    ) {
      errors.push(`${gate}: temporary performance exceptions must be empty`);
    }
  }

  const fixtureMap = new Map();
  for (const [id, scenario] of scenarioMap) {
    if (!SCENARIO_ID_PATTERN.test(id)) {
      errors.push(`${id}: invalid canonical scenario id`);
    }
    if (!SHA256_PATTERN.test(scenario.fixtureSha256 ?? "")) {
      errors.push(`${id}: fixtureSha256 is invalid`);
    }
    const expectedGate = Object.entries(REQUIRED_GATES).find(([, value]) =>
      value.scenarioIds.includes(id),
    )?.[0];
    if (scenario.requiredFromExit !== expectedGate) {
      errors.push(`${id}: requiredFromExit must be ${expectedGate}`);
    }
    const postBaseline = scenario.introducedAtGate !== "P0-BASELINE";
    if (postBaseline && scenario.fixtureBinding !== "current-policy-tree") {
      errors.push(
        `${id}: post-baseline fixture must bind to current-policy-tree`,
      );
    }
    if (!verifyFixtures) continue;

    try {
      const bytes = postBaseline
        ? await readCurrentFixture(root, scenario.fixtureRef)
        : readBaselineFixture(
            root,
            budgets.measurementSourceSha,
            scenario.fixtureRef,
          );
      if (sha256(bytes) !== scenario.fixtureSha256) {
        errors.push(`${id}: fixture raw-byte hash does not match policy`);
      }
      if (postBaseline) {
        const fixture = parseJsonBytes(bytes);
        fixtureMap.set(id, fixture);
        validateFixtureContract(fixture, scenario, xlsxLimits, errors);
      }
    } catch (error) {
      errors.push(`${id}: fixture is unreadable: ${error.message}`);
    }
  }

  const pendingScenarioIds = [];
  for (const [id, scenario] of budgetMap) {
    if (!scenarioMap.has(id)) continue;
    const state = validateMeasurement(scenario, errors);
    if (state === "pending") pendingScenarioIds.push(id);
    if (typeof scenario.primaryMetric !== "string") {
      errors.push(`${id}: primaryMetric is missing`);
    }
    if (!isRecord(scenario.supplementaryCeilings)) {
      errors.push(`${id}: supplementaryCeilings must be an object`);
    }
    const fixture = fixtureMap.get(id);
    if (
      fixture &&
      !sameStringSet(fixture.requiredTelemetry, [
        scenario.primaryMetric,
        ...Object.keys(scenario.supplementaryCeilings ?? {}),
      ])
    ) {
      errors.push(`${id}: fixture telemetry does not match budget metrics`);
    }
    if (state === "pending") {
      const requiredExit = scenarioMap.get(id).requiredFromExit;
      for (const blockerId of scenario.pendingState?.blockerIds ?? []) {
        const blocker = blockerMap.get(blockerId);
        if (!blocker) {
          errors.push(`${id}: unknown pending blocker ${blockerId}`);
        } else if (blocker.blocksExit !== requiredExit) {
          errors.push(
            `${id}: blocker ${blockerId} does not block ${requiredExit}`,
          );
        }
      }
    }
  }

  const gateResolutionErrors = [];
  for (const gate of Object.keys(REQUIRED_GATES)) {
    resolveGateScenarioIdsInternal(
      gateMap,
      gate,
      new Set(),
      new Map(),
      gateResolutionErrors,
    );
  }
  errors.push(...gateResolutionErrors);

  for (const [id, blocker] of blockerMap) {
    if (!Object.hasOwn(REQUIRED_GATES, blocker.blocksExit)) {
      errors.push(`${id}: blocksExit is not a performance gate`);
    }
    if (typeof blocker.reason !== "string" || blocker.reason.length < 20) {
      errors.push(`${id}: blocker reason is not explicit`);
    }
  }

  if (
    pendingScenarioIds.length > 0 &&
    budgets.status !== "pending-external-evidence"
  ) {
    errors.push("pending scenarios require pending-external-evidence status");
  }
  if (pendingScenarioIds.length === 0 && budgets.status !== "accepted") {
    errors.push("fully bound scenarios require accepted status");
  }
  if (
    pendingScenarioIds.length > 0 &&
    !blockerMap.has("P8-PERFORMANCE-CLOSURE")
  ) {
    errors.push("pending inherited scenarios require the P8 closure blocker");
  }
  if (
    pendingScenarioIds.length === 0 &&
    blockerMap.has("P8-PERFORMANCE-CLOSURE")
  ) {
    errors.push(
      "accepted performance policy must remove the P8 closure blocker",
    );
  }

  return {
    errors,
    uiScenarios,
    budgets,
    xlsxLimits,
    scenarioMap,
    budgetMap,
    blockerMap,
    gateMap,
    fixtureMap,
    pendingScenarioIds,
  };
};

const validateExactKeys = (value, keys, label, errors) => {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  if (!sameStringSet(Object.keys(value), keys)) {
    errors.push(`${label} fields do not match the evidence schema`);
    return false;
  }
  return true;
};

const validateSamplesAndStatistics = (
  samples,
  samplesSha256,
  statistics,
  label,
  errors,
) => {
  if (
    !Array.isArray(samples) ||
    samples.length !== SAMPLE_COUNT ||
    samples.some((sample) => !isFiniteNonnegative(sample))
  ) {
    errors.push(
      `${label}: exactly ${SAMPLE_COUNT} finite samples are required`,
    );
    return null;
  }
  if (calculateSamplesSha256(samples) !== samplesSha256) {
    errors.push(`${label}: samplesSha256 does not match canonical samples`);
  }
  const calculated = calculatePerformanceStatistics(samples);
  if (
    !isRecord(statistics) ||
    calculated.median !== statistics.median ||
    calculated.p95 !== statistics.p95 ||
    calculated.maximum !== statistics.maximum
  ) {
    errors.push(`${label}: median/p95/maximum do not match raw samples`);
  }
  return calculated;
};

const expectedEvidenceScenarioIds = (context, gate, errors) => {
  const requirement = context.gateMap.get(gate);
  if (!requirement) {
    errors.push(`gate ${gate} is not defined`);
    return [];
  }
  if (requirement.evidenceScope === "own") {
    return requirement.scenarioIds;
  }
  return resolveGateScenarioIdsInternal(
    context.gateMap,
    gate,
    new Set(),
    new Map(),
    errors,
  );
};

export const verifyPerformanceEvidence = ({ context, gate, envelope }) => {
  const errors = [];
  if (!Object.hasOwn(REQUIRED_GATES, gate)) {
    return { errors: [`unknown performance gate ${gate}`] };
  }
  if (
    !validateExactKeys(
      envelope,
      ["schemaVersion", "evidence", "evidenceSha256"],
      "evidence envelope",
      errors,
    )
  ) {
    return { errors };
  }
  if (envelope.schemaVersion !== 1) {
    errors.push("evidence envelope schemaVersion must be 1");
  }
  if (sha256(canonicalize(envelope.evidence)) !== envelope.evidenceSha256) {
    errors.push("evidenceSha256 does not match the canonical evidence body");
  }

  const evidence = envelope.evidence;
  if (
    !validateExactKeys(
      evidence,
      [
        "evidenceId",
        "gate",
        "collectedAtUtc",
        "policyBindings",
        "source",
        "environment",
        "sampleCount",
        "statisticsMethod",
        "scenarios",
      ],
      "evidence body",
      errors,
    )
  ) {
    return { errors };
  }
  if (
    typeof evidence.evidenceId !== "string" ||
    !/^perf-[a-z0-9][a-z0-9._-]{7,127}$/.test(evidence.evidenceId)
  ) {
    errors.push("evidenceId is invalid");
  }
  if (evidence.gate !== gate) {
    errors.push(`evidence gate must be ${gate}`);
  }
  if (
    typeof evidence.collectedAtUtc !== "string" ||
    !evidence.collectedAtUtc.endsWith("Z") ||
    !Number.isFinite(Date.parse(evidence.collectedAtUtc))
  ) {
    errors.push("collectedAtUtc must be a valid UTC timestamp");
  }
  if (evidence.sampleCount !== SAMPLE_COUNT) {
    errors.push(`evidence sampleCount must be ${SAMPLE_COUNT}`);
  }
  if (evidence.statisticsMethod !== STATISTICS_METHOD) {
    errors.push("evidence statisticsMethod does not match policy");
  }

  const expectedBindings = {
    uiScenariosSha256: sha256(canonicalize(context.uiScenarios)),
    performanceBudgetContractSha256: sha256(
      canonicalize(projectPerformanceBudgetContract(context.budgets)),
    ),
    xlsxLimitsSha256: sha256(canonicalize(context.xlsxLimits)),
  };
  if (
    !validateExactKeys(
      evidence.policyBindings,
      Object.keys(expectedBindings),
      "policyBindings",
      errors,
    )
  ) {
    return { errors };
  }
  for (const [name, expected] of Object.entries(expectedBindings)) {
    if (evidence.policyBindings[name] !== expected) {
      errors.push(`${name} does not bind the current canonical policy`);
    }
  }

  const source = evidence.source;
  if (
    validateExactKeys(
      source,
      [
        "gitCommitSha",
        "sourceClosureSha256",
        "treeState",
        "artifactSha256",
        "releaseVariant",
      ],
      "source",
      errors,
    )
  ) {
    if (!GIT_SHA_PATTERN.test(source.gitCommitSha ?? "")) {
      errors.push("source gitCommitSha is invalid");
    }
    if (!SHA256_PATTERN.test(source.sourceClosureSha256 ?? "")) {
      errors.push("sourceClosureSha256 is invalid");
    }
    if (!SHA256_PATTERN.test(source.artifactSha256 ?? "")) {
      errors.push("artifactSha256 is invalid");
    }
    if (source.treeState !== "clean") {
      errors.push("performance evidence requires a clean source tree");
    }
    const requiredVariant = REQUIRED_VARIANTS[gate];
    if (
      !validateExactKeys(
        source.releaseVariant,
        Object.keys(requiredVariant),
        "source.releaseVariant",
        errors,
      ) ||
      Object.entries(requiredVariant).some(
        ([name, expected]) => source.releaseVariant?.[name] !== expected,
      )
    ) {
      errors.push(`${gate}: release variant does not match the required gate`);
    }
  }

  const environment = evidence.environment;
  if (
    validateExactKeys(
      environment,
      ["machineProfile", "browser"],
      "environment",
      errors,
    )
  ) {
    const expectedMachine = {
      os: context.budgets.machineProfile.os,
      cpu: context.budgets.machineProfile.cpu,
      memoryBytes: context.budgets.machineProfile.memoryBytes,
      powerMode: context.budgets.machineProfile.powerMode,
    };
    if (
      !validateExactKeys(
        environment.machineProfile,
        Object.keys(expectedMachine),
        "environment.machineProfile",
        errors,
      ) ||
      JSON.stringify(environment.machineProfile) !==
        JSON.stringify(expectedMachine)
    ) {
      errors.push("evidence machine profile does not match policy");
    }
    if (
      !validateExactKeys(
        environment.browser,
        ["family", "version", "channel"],
        "environment.browser",
        errors,
      ) ||
      JSON.stringify(environment.browser) !==
        JSON.stringify(context.budgets.browser)
    ) {
      errors.push("evidence browser does not match policy");
    }
  }

  const requiredScenarioIds = expectedEvidenceScenarioIds(
    context,
    gate,
    errors,
  );
  const evidenceScenarioMap = uniqueMap(
    evidence.scenarios,
    (scenario) => scenario?.id,
    "evidence scenarios",
    errors,
  );
  if (!sameStringSet([...evidenceScenarioMap.keys()], requiredScenarioIds)) {
    errors.push(
      `${gate}: evidence scenario set is incomplete or contains extras`,
    );
  }

  for (const id of requiredScenarioIds) {
    const scenarioEvidence = evidenceScenarioMap.get(id);
    const scenarioPolicy = context.scenarioMap.get(id);
    const budget = context.budgetMap.get(id);
    if (!scenarioEvidence || !scenarioPolicy || !budget) continue;
    if (
      !validateExactKeys(
        scenarioEvidence,
        [
          "id",
          "fixtureSha256",
          "primaryMetric",
          "samples",
          "samplesSha256",
          "statistics",
          "supplementaryMetrics",
          "outcomeAssertions",
        ],
        `evidence scenario ${id}`,
        errors,
      )
    ) {
      continue;
    }
    if (scenarioEvidence.fixtureSha256 !== scenarioPolicy.fixtureSha256) {
      errors.push(
        `${id}: evidence fixture hash does not match scenario policy`,
      );
    }
    if (scenarioEvidence.primaryMetric !== budget.primaryMetric) {
      errors.push(`${id}: primary metric does not match budget policy`);
    }
    const statistics = validateSamplesAndStatistics(
      scenarioEvidence.samples,
      scenarioEvidence.samplesSha256,
      scenarioEvidence.statistics,
      `${id}.${budget.primaryMetric}`,
      errors,
    );

    const supplementaryMap = uniqueMap(
      scenarioEvidence.supplementaryMetrics,
      (metric) => metric?.name,
      `${id} supplementary metrics`,
      errors,
    );
    const expectedSupplementary = Object.keys(budget.supplementaryCeilings);
    if (!sameStringSet([...supplementaryMap.keys()], expectedSupplementary)) {
      errors.push(`${id}: supplementary metric set does not match budget`);
    }
    for (const metricName of expectedSupplementary) {
      const metric = supplementaryMap.get(metricName);
      if (!metric) continue;
      const metricStatistics = validateSamplesAndStatistics(
        metric.samples,
        metric.samplesSha256,
        metric.statistics,
        `${id}.${metricName}`,
        errors,
      );
      const ceiling = budget.supplementaryCeilings[metricName];
      if (
        metricStatistics !== null &&
        isFiniteNonnegative(ceiling) &&
        metricStatistics.maximum > ceiling
      ) {
        errors.push(`${id}.${metricName}: observed maximum exceeds ceiling`);
      }
    }

    const fixture = context.fixtureMap.get(id);
    const requiredAssertions = fixture?.requiredAssertions ?? [
      "scenario-completed",
    ];
    if (!isRecord(scenarioEvidence.outcomeAssertions)) {
      errors.push(`${id}: outcomeAssertions must be an object`);
    } else {
      for (const assertion of requiredAssertions) {
        if (scenarioEvidence.outcomeAssertions[assertion] !== true) {
          errors.push(`${id}: required assertion ${assertion} is not true`);
        }
      }
      if (
        Object.values(scenarioEvidence.outcomeAssertions).some(
          (value) => value !== true,
        )
      ) {
        errors.push(`${id}: outcome assertions may only contain true values`);
      }
    }

    if (statistics !== null) {
      if (
        budget.measurement?.medianMs !== statistics.median ||
        budget.measurement?.p95Ms !== statistics.p95
      ) {
        errors.push(`${id}: committed measurement does not match evidence`);
      }
      if (
        isFinitePositive(budget.absoluteCeilingMs) &&
        statistics.p95 > budget.absoluteCeilingMs
      ) {
        errors.push(`${id}: p95 exceeds absoluteCeilingMs`);
      }
      const reference = budget.regressionReference;
      const regressionPercent = budget.regressionCeilingPercent;
      if (
        isRecord(reference) &&
        isFiniteNonnegative(regressionPercent) &&
        (statistics.median >
          reference.medianMs * (1 + regressionPercent / 100) ||
          statistics.p95 > reference.p95Ms * (1 + regressionPercent / 100))
      ) {
        errors.push(`${id}: median or p95 exceeds regression ceiling`);
      }
    }
    if (budget.evidenceSha256 !== envelope.evidenceSha256) {
      errors.push(`${id}: budget evidenceSha256 does not bind this envelope`);
    }
  }

  return { errors };
};

export const verifyPerformanceGate = async ({
  root = projectRoot,
  gate,
  evidence,
  context: suppliedContext,
} = {}) => {
  const context = suppliedContext ?? (await verifyPerformancePolicy({ root }));
  const errors = [...context.errors];
  if (!Object.hasOwn(REQUIRED_GATES, gate)) {
    errors.push(`unknown performance gate ${gate}`);
    return { errors, context };
  }
  const resolution = resolveGateScenarioIds(context.budgets, gate);
  errors.push(...resolution.errors);
  for (const id of resolution.scenarioIds) {
    if (context.pendingScenarioIds.includes(id)) {
      const blockers =
        context.budgetMap.get(id)?.pendingState?.blockerIds?.join(", ") ??
        "unbound";
      errors.push(`${gate}: ${id} is pending (${blockers})`);
    }
  }
  for (const blocker of context.blockerMap.values()) {
    if (blocker.blocksExit === gate) {
      errors.push(`${gate}: explicit blocker ${blocker.id} remains`);
    }
  }
  if (
    context.budgets.machineProfile.status !== "bound" ||
    typeof context.budgets.machineProfile.cpu !== "string" ||
    !isFinitePositive(context.budgets.machineProfile.memoryBytes) ||
    typeof context.budgets.machineProfile.powerMode !== "string" ||
    typeof context.budgets.browser.version !== "string" ||
    typeof context.budgets.browser.channel !== "string"
  ) {
    errors.push(
      `${gate}: canonical machine and Chromium binding is incomplete`,
    );
  }
  if (!isRecord(evidence)) {
    errors.push(`${gate}: a performance evidence envelope is required`);
  } else {
    errors.push(
      ...verifyPerformanceEvidence({ context, gate, envelope: evidence })
        .errors,
    );
  }
  return { errors, context };
};

const parseCliArguments = (argv) => {
  const result = { gate: null, evidencePath: null, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-exit") {
      result.gate = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--require-exit=")) {
      result.gate = argument.slice("--require-exit=".length);
    } else if (argument === "--evidence") {
      result.evidencePath = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--evidence=")) {
      result.evidencePath = argument.slice("--evidence=".length);
    } else {
      result.errors.push(`unknown argument ${argument}`);
    }
  }
  if (result.evidencePath !== null && result.gate === null) {
    result.errors.push("--evidence requires --require-exit");
  }
  return result;
};

const runCli = async () => {
  const cli = parseCliArguments(process.argv.slice(2));
  if (cli.errors.length > 0) {
    fail("FAIL performance policy verification", cli.errors);
    return;
  }
  const context = await verifyPerformancePolicy({ root: projectRoot });
  if (cli.gate === null) {
    if (context.errors.length > 0) {
      fail("FAIL performance policy verification", context.errors);
      return;
    }
    process.stdout.write(
      `PASS performance policy: ${context.scenarioMap.size} canonical scenarios; ${context.pendingScenarioIds.length} explicit pending scenario(s); production exits remain fail-closed\n`,
    );
    return;
  }

  let evidence = null;
  if (cli.evidencePath !== null) {
    try {
      evidence = await readJsonAt(projectRoot, cli.evidencePath);
    } catch (error) {
      context.errors.push(
        `performance evidence is unreadable: ${error.message}`,
      );
    }
  }
  const result = await verifyPerformanceGate({
    root: projectRoot,
    gate: cli.gate,
    evidence,
    context,
  });
  if (result.errors.length > 0) {
    fail(`FAIL ${cli.gate} performance acceptance`, result.errors);
    return;
  }
  process.stdout.write(
    `PASS ${cli.gate} performance acceptance: source-bound 30-sample evidence satisfies absolute and regression ceilings\n`,
  );
};

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await runCli();
}
