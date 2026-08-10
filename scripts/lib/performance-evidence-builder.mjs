import {
  calculatePerformanceStatistics,
  calculateSamplesSha256,
  projectPerformanceBudgetContract,
  resolveGateScenarioIds,
} from "../verify-performance-policy.mjs";
import { canonicalize, sha256 } from "../foundation-policy-utils.mjs";

const SAMPLE_COUNT = 30;
const STATISTICS_METHOD = "median-average-p95-nearest-rank-v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameStringSet = (left, right) =>
  left.length === right.length &&
  left.every((value) => right.includes(value)) &&
  right.every((value) => left.includes(value));

const validateExactKeys = (value, expectedKeys, path, errors) => {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const actualKeys = Object.keys(value);
  if (!sameStringSet(actualKeys, expectedKeys)) {
    errors.push(`${path} must contain exactly: ${expectedKeys.join(", ")}`);
    return false;
  }
  return true;
};

const validateSamples = (samples, path, errors) => {
  if (
    !Array.isArray(samples) ||
    samples.length !== SAMPLE_COUNT ||
    samples.some(
      (sample) =>
        typeof sample !== "number" || !Number.isFinite(sample) || sample < 0,
    )
  ) {
    errors.push(`${path} must contain exactly 30 finite nonnegative samples`);
    return false;
  }
  return true;
};

const validateExecutionBinding = (binding, path, errors, scenarioId) => {
  if (
    !validateExactKeys(
      binding,
      ["adapterContract", "fixturePayload", "faultInjection", "setup"],
      path,
      errors,
    ) ||
    !validateExactKeys(
      binding.fixturePayload,
      ["generator", "seed", "cardinality", "payloadSha256", "semanticSha256"],
      `${path}.fixturePayload`,
      errors,
    )
  ) {
    return false;
  }
  const payload = binding.fixturePayload;
  if (
    binding.adapterContract !== "public-artifact-surface-v1" ||
    typeof payload.generator !== "string" ||
    payload.generator.length === 0 ||
    !(
      payload.seed === null ||
      (Number.isSafeInteger(payload.seed) && payload.seed >= 0)
    ) ||
    !(
      payload.cardinality === null ||
      (Number.isSafeInteger(payload.cardinality) && payload.cardinality >= 0)
    ) ||
    !SHA256_PATTERN.test(payload.payloadSha256 ?? "") ||
    !SHA256_PATTERN.test(payload.semanticSha256 ?? "")
  ) {
    errors.push(`${path}.fixturePayload is invalid`);
    return false;
  }
  const expectsSetup = scenarioId === "xlsx-worker-export-roundtrip";
  if (binding.setup === null) {
    if (expectsSetup) {
      errors.push(`${path}.setup is required for the export round trip`);
      return false;
    }
  } else {
    if (
      !expectsSetup ||
      !validateExactKeys(
        binding.setup,
        [
          "method",
          "timing",
          "readback",
          "databaseName",
          "databaseVersion",
          "storeName",
          "controlStoreName",
          "key",
          "transactionStores",
          "payloadSha256",
          "semanticSha256",
          "itemCount",
          "revision",
        ],
        `${path}.setup`,
        errors,
      ) ||
      binding.setup.method !==
        "indexeddb-schema-exact-single-transaction-stage-v1" ||
      binding.setup.timing !== "excluded-from-measurement-v1" ||
      binding.setup.readback !== "separate-readonly-transaction-v1" ||
      binding.setup.databaseName !== "EventShoppingPlannerDB" ||
      !Number.isSafeInteger(binding.setup.databaseVersion) ||
      binding.setup.databaseVersion < 5 ||
      binding.setup.databaseVersion > 7 ||
      binding.setup.storeName !== "eventLists" ||
      binding.setup.controlStoreName !== "syncQueue" ||
      binding.setup.key !== "data" ||
      JSON.stringify(binding.setup.transactionStores) !==
        JSON.stringify(["eventLists", "syncQueue"]) ||
      binding.setup.payloadSha256 !== payload.payloadSha256 ||
      binding.setup.semanticSha256 !== payload.semanticSha256 ||
      binding.setup.itemCount !== payload.cardinality ||
      binding.setup.revision !== `performance-stage:${payload.payloadSha256}`
    ) {
      errors.push(`${path}.setup is invalid`);
      return false;
    }
  }
  if (binding.faultInjection === null) return true;
  if (
    !validateExactKeys(
      binding.faultInjection,
      ["method", "originalWorkerSha256", "replacementWorkerSha256"],
      `${path}.faultInjection`,
      errors,
    )
  ) {
    return false;
  }
  if (
    binding.faultInjection.method !==
      "playwright-exact-worker-response-substitution-v1" ||
    !SHA256_PATTERN.test(binding.faultInjection.originalWorkerSha256 ?? "") ||
    !SHA256_PATTERN.test(binding.faultInjection.replacementWorkerSha256 ?? "")
  ) {
    errors.push(`${path}.faultInjection is invalid`);
    return false;
  }
  return true;
};

const requiredEvidenceScenarioIds = (context, gate, errors) => {
  const requirement = context.gateMap?.get(gate);
  if (!requirement) {
    errors.push(`unknown performance gate ${gate}`);
    return [];
  }
  if (requirement.evidenceScope === "own") {
    return [...requirement.scenarioIds];
  }
  const resolution = resolveGateScenarioIds(context.budgets, gate);
  errors.push(...resolution.errors);
  return resolution.scenarioIds;
};

const buildMetricEvidence = (name, samples) => ({
  name,
  samples: [...samples],
  samplesSha256: calculateSamplesSha256(samples),
  statistics: calculatePerformanceStatistics(samples),
});

export const buildPerformanceEvidenceEnvelope = ({ context, input }) => {
  const errors = [...(context?.errors ?? [])];
  if (
    !validateExactKeys(
      input,
      [
        "schemaVersion",
        "evidenceId",
        "gate",
        "collectedAtUtc",
        "source",
        "environment",
        "scenarios",
      ],
      "raw evidence input",
      errors,
    )
  ) {
    throw new Error(errors.join("\n"));
  }
  if (input.schemaVersion !== 1) {
    errors.push("raw evidence input schemaVersion must be 1");
  }
  if (
    typeof input.evidenceId !== "string" ||
    !/^perf-[a-z0-9][a-z0-9._-]{7,127}$/.test(input.evidenceId)
  ) {
    errors.push("raw evidence input evidenceId is invalid");
  }
  if (
    typeof input.collectedAtUtc !== "string" ||
    !input.collectedAtUtc.endsWith("Z") ||
    !Number.isFinite(Date.parse(input.collectedAtUtc))
  ) {
    errors.push("raw evidence input collectedAtUtc is invalid");
  }
  validateExactKeys(
    input.source,
    [
      "gitCommitSha",
      "sourceClosureSha256",
      "treeState",
      "artifactSha256",
      "releaseVariant",
    ],
    "raw evidence input source",
    errors,
  );
  validateExactKeys(
    input.source?.releaseVariant,
    ["releaseRole", "xlsxExecution", "listEngine", "listDefault"],
    "raw evidence input source.releaseVariant",
    errors,
  );
  validateExactKeys(
    input.environment,
    ["machineProfile", "browser"],
    "raw evidence input environment",
    errors,
  );
  validateExactKeys(
    input.environment?.machineProfile,
    ["os", "cpu", "memoryBytes", "powerMode"],
    "raw evidence input environment.machineProfile",
    errors,
  );
  validateExactKeys(
    input.environment?.browser,
    ["family", "version", "channel"],
    "raw evidence input environment.browser",
    errors,
  );

  const requiredIds = requiredEvidenceScenarioIds(context, input.gate, errors);
  const rawScenarios = Array.isArray(input.scenarios) ? input.scenarios : [];
  if (rawScenarios !== input.scenarios) {
    errors.push("raw evidence input scenarios must be an array");
  }
  const scenarioMap = new Map();
  for (const [index, scenario] of rawScenarios.entries()) {
    const path = `raw evidence input scenarios[${index}]`;
    if (
      !validateExactKeys(
        scenario,
        [
          "id",
          "samples",
          "supplementarySamples",
          "outcomeAssertions",
          "executionBinding",
        ],
        path,
        errors,
      )
    ) {
      continue;
    }
    if (typeof scenario.id !== "string" || scenarioMap.has(scenario.id)) {
      errors.push(`${path}.id must be a unique string`);
      continue;
    }
    scenarioMap.set(scenario.id, scenario);
  }
  if (!sameStringSet([...scenarioMap.keys()], requiredIds)) {
    errors.push(
      `${input.gate}: raw evidence scenario set is incomplete or contains extras`,
    );
  }

  const scenarios = [];
  for (const id of requiredIds) {
    const raw = scenarioMap.get(id);
    const policy = context.scenarioMap?.get(id);
    const budget = context.budgetMap?.get(id);
    const fixture = context.fixtureMap?.get(id);
    if (!raw || !policy || !budget) continue;
    if (budget.pendingState !== null) {
      errors.push(
        `${id}: budget remains pending; evidence cannot be finalized`,
      );
    }
    if (
      !validateSamples(raw.samples, `${id}.${budget.primaryMetric}`, errors)
    ) {
      continue;
    }
    if (!isRecord(raw.supplementarySamples)) {
      errors.push(`${id}.supplementarySamples must be an object`);
      continue;
    }
    const expectedSupplementary = Object.keys(budget.supplementaryCeilings);
    if (
      !sameStringSet(
        Object.keys(raw.supplementarySamples),
        expectedSupplementary,
      )
    ) {
      errors.push(
        `${id}: supplementary sample metric set does not match policy`,
      );
      continue;
    }
    const supplementaryMetrics = [];
    for (const name of expectedSupplementary) {
      const samples = raw.supplementarySamples[name];
      if (!validateSamples(samples, `${id}.${name}`, errors)) continue;
      supplementaryMetrics.push(buildMetricEvidence(name, samples));
    }
    const requiredAssertions = fixture?.requiredAssertions ?? [
      "scenario-completed",
    ];
    if (
      !isRecord(raw.outcomeAssertions) ||
      !sameStringSet(Object.keys(raw.outcomeAssertions), requiredAssertions) ||
      Object.values(raw.outcomeAssertions).some((value) => value !== true)
    ) {
      errors.push(
        `${id}: outcomeAssertions must contain exactly the required true assertions`,
      );
      continue;
    }
    if (
      !validateExecutionBinding(
        raw.executionBinding,
        `${id}.executionBinding`,
        errors,
        id,
      )
    ) {
      continue;
    }
    scenarios.push({
      id,
      fixtureSha256: policy.fixtureSha256,
      primaryMetric: budget.primaryMetric,
      samples: [...raw.samples],
      samplesSha256: calculateSamplesSha256(raw.samples),
      statistics: calculatePerformanceStatistics(raw.samples),
      supplementaryMetrics,
      outcomeAssertions: structuredClone(raw.outcomeAssertions),
      executionBinding: structuredClone(raw.executionBinding),
    });
  }

  if (errors.length > 0) {
    throw new Error(
      `Performance evidence input is invalid:\n${errors.join("\n")}`,
    );
  }
  const evidence = {
    evidenceId: input.evidenceId,
    gate: input.gate,
    collectedAtUtc: input.collectedAtUtc,
    policyBindings: {
      uiScenariosSha256: sha256(canonicalize(context.uiScenarios)),
      performanceBudgetContractSha256: sha256(
        canonicalize(projectPerformanceBudgetContract(context.budgets)),
      ),
      xlsxLimitsSha256: sha256(canonicalize(context.xlsxLimits)),
    },
    source: structuredClone(input.source),
    environment: structuredClone(input.environment),
    sampleCount: SAMPLE_COUNT,
    statisticsMethod: STATISTICS_METHOD,
    scenarios,
  };
  return {
    schemaVersion: 1,
    evidence,
    evidenceSha256: sha256(canonicalize(evidence)),
  };
};
