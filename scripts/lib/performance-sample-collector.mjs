import { parseJsonStrict, sha256Bytes } from "./canonical-json.mjs";
import { resolveGateScenarioIds } from "../verify-performance-policy.mjs";
import {
  CANONICAL_SCENARIO_DISPATCH,
  CANONICAL_SCENARIO_IDS,
  PERFORMANCE_ROTATION,
  PERFORMANCE_SAMPLE_COUNT,
  PERFORMANCE_WARMUP_COUNT,
  REQUIRED_PERFORMANCE_VARIANTS,
} from "../performance/canonicalScenarioDispatch.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameStringSet = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((value) => right.includes(value)) &&
  right.every((value) => left.includes(value));

const assertExactKeys = (value, keys, label) => {
  if (!isRecord(value) || !sameStringSet(Object.keys(value), keys)) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
  }
};

const assertFiniteNonnegative = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite nonnegative number`);
  }
};

const validateExecutionBinding = (value, scenarioId) => {
  assertExactKeys(
    value,
    ["adapterContract", "fixturePayload", "faultInjection", "setup"],
    `${scenarioId} execution binding`,
  );
  assertExactKeys(
    value.fixturePayload,
    ["generator", "seed", "cardinality", "payloadSha256", "semanticSha256"],
    `${scenarioId} fixture payload binding`,
  );
  if (
    value.adapterContract !== "public-artifact-surface-v1" ||
    typeof value.fixturePayload.generator !== "string" ||
    value.fixturePayload.generator.length === 0 ||
    !(
      value.fixturePayload.seed === null ||
      (Number.isSafeInteger(value.fixturePayload.seed) &&
        value.fixturePayload.seed >= 0)
    ) ||
    !(
      value.fixturePayload.cardinality === null ||
      (Number.isSafeInteger(value.fixturePayload.cardinality) &&
        value.fixturePayload.cardinality >= 0)
    ) ||
    !SHA256_PATTERN.test(value.fixturePayload.payloadSha256 ?? "") ||
    !SHA256_PATTERN.test(value.fixturePayload.semanticSha256 ?? "")
  ) {
    throw new Error(`${scenarioId}: fixture execution binding is invalid`);
  }
  const expectsSetup = scenarioId === "xlsx-worker-export-roundtrip";
  if (value.setup === null) {
    if (expectsSetup) {
      throw new Error(`${scenarioId}: export setup binding is required`);
    }
  } else {
    if (!expectsSetup) {
      throw new Error(`${scenarioId}: setup binding is forbidden`);
    }
    assertExactKeys(
      value.setup,
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
      `${scenarioId} setup binding`,
    );
    if (
      value.setup.method !==
        "indexeddb-schema-exact-single-transaction-stage-v1" ||
      value.setup.timing !== "excluded-from-measurement-v1" ||
      value.setup.readback !== "separate-readonly-transaction-v1" ||
      value.setup.databaseName !== "EventShoppingPlannerDB" ||
      !Number.isSafeInteger(value.setup.databaseVersion) ||
      value.setup.databaseVersion < 5 ||
      value.setup.databaseVersion > 7 ||
      value.setup.storeName !== "eventLists" ||
      value.setup.controlStoreName !== "syncQueue" ||
      value.setup.key !== "data" ||
      JSON.stringify(value.setup.transactionStores) !==
        JSON.stringify(["eventLists", "syncQueue"]) ||
      value.setup.payloadSha256 !== value.fixturePayload.payloadSha256 ||
      value.setup.semanticSha256 !== value.fixturePayload.semanticSha256 ||
      value.setup.itemCount !== value.fixturePayload.cardinality ||
      value.setup.revision !==
        `performance-stage:${value.fixturePayload.payloadSha256}`
    ) {
      throw new Error(`${scenarioId}: export setup binding is invalid`);
    }
  }
  if (value.faultInjection === null) return;
  assertExactKeys(
    value.faultInjection,
    ["method", "originalWorkerSha256", "replacementWorkerSha256"],
    `${scenarioId} fault binding`,
  );
  if (
    value.faultInjection.method !==
      "playwright-exact-worker-response-substitution-v1" ||
    !SHA256_PATTERN.test(value.faultInjection.originalWorkerSha256 ?? "") ||
    !SHA256_PATTERN.test(value.faultInjection.replacementWorkerSha256 ?? "")
  ) {
    throw new Error(`${scenarioId}: fault execution binding is invalid`);
  }
};

const assertSourceBinding = (source, requiredVariant) => {
  assertExactKeys(
    source,
    [
      "gitCommitSha",
      "sourceClosureSha256",
      "treeState",
      "artifactSha256",
      "releaseVariant",
    ],
    "Performance source binding",
  );
  assertExactKeys(
    source.releaseVariant,
    ["releaseRole", "xlsxExecution", "listEngine", "listDefault"],
    "Performance release variant",
  );
  if (
    !GIT_SHA_PATTERN.test(source.gitCommitSha ?? "") ||
    !SHA256_PATTERN.test(source.sourceClosureSha256 ?? "") ||
    !SHA256_PATTERN.test(source.artifactSha256 ?? "") ||
    source.treeState !== "clean" ||
    Object.entries(requiredVariant).some(
      ([key, value]) => source.releaseVariant[key] !== value,
    )
  ) {
    throw new Error("Performance source/artifact binding is invalid");
  }
};

const assertEnvironmentBinding = (environment) => {
  assertExactKeys(
    environment,
    ["machineProfile", "browser"],
    "Performance environment binding",
  );
  assertExactKeys(
    environment.machineProfile,
    ["os", "cpu", "memoryBytes", "powerMode"],
    "Performance machine profile",
  );
  assertExactKeys(
    environment.browser,
    ["family", "version", "channel"],
    "Performance browser binding",
  );
  if (
    ![environment.machineProfile.os, environment.machineProfile.cpu].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Number.isSafeInteger(environment.machineProfile.memoryBytes) ||
    environment.machineProfile.memoryBytes <= 0 ||
    typeof environment.machineProfile.powerMode !== "string" ||
    environment.machineProfile.powerMode.length === 0 ||
    environment.browser.family !== "chromium" ||
    ![environment.browser.version, environment.browser.channel].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    throw new Error("Performance machine/browser binding is invalid");
  }
};

export const assertCanonicalScenarioDispatch = (context) => {
  const policyIds = [...(context?.scenarioMap?.keys() ?? [])];
  if (!sameStringSet(policyIds, CANONICAL_SCENARIO_IDS)) {
    throw new Error(
      "Canonical collector dispatch differs from UI scenario policy",
    );
  }
  for (const id of CANONICAL_SCENARIO_IDS) {
    const scenario = context.scenarioMap.get(id);
    const dispatch = CANONICAL_SCENARIO_DISPATCH[id];
    const expectedGate =
      scenario.introducedAtGate === "P0-BASELINE"
        ? "P0-TOOLCHAIN"
        : scenario.introducedAtGate;
    if (dispatch.gate !== expectedGate) {
      throw new Error(`${id}: collector dispatch gate differs from policy`);
    }
  }
};

export const buildDeterministicMeasurementSchedule = (
  scenarioIds,
  sampleCount = PERFORMANCE_SAMPLE_COUNT,
) => {
  if (
    !Array.isArray(scenarioIds) ||
    scenarioIds.length === 0 ||
    new Set(scenarioIds).size !== scenarioIds.length ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1
  ) {
    throw new Error("Performance measurement schedule input is invalid");
  }
  const schedule = scenarioIds.map((scenarioId) => ({
    phase: "warmup",
    round: -1,
    sampleIndex: null,
    scenarioId,
  }));
  for (let round = 0; round < sampleCount; round += 1) {
    const rotation = round % scenarioIds.length;
    for (let index = 0; index < scenarioIds.length; index += 1) {
      schedule.push({
        phase: "sample",
        round,
        sampleIndex: round,
        scenarioId: scenarioIds[(index + rotation) % scenarioIds.length],
      });
    }
  }
  return schedule;
};

const parseFixtureDocument = (bytes) => {
  try {
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      return null;
    }
    return parseJsonStrict(UTF8_DECODER.decode(bytes));
  } catch {
    return null;
  }
};

const prepareScenarios = async ({ context, loadFixture, scenarioIds }) => {
  const prepared = new Map();
  for (const scenarioId of scenarioIds) {
    const policy = context.scenarioMap.get(scenarioId);
    const budget = context.budgetMap.get(scenarioId);
    if (!policy || !budget) {
      throw new Error(`${scenarioId}: performance policy is incomplete`);
    }
    const fixtureBytes = await loadFixture(policy);
    if (!Buffer.isBuffer(fixtureBytes)) {
      throw new Error(`${scenarioId}: fixture loader did not return bytes`);
    }
    if (sha256Bytes(fixtureBytes) !== policy.fixtureSha256) {
      throw new Error(`${scenarioId}: fixture bytes differ from policy hash`);
    }
    const fixtureDocument = parseFixtureDocument(fixtureBytes);
    const requiredAssertions = fixtureDocument?.requiredAssertions ?? [
      "scenario-completed",
    ];
    const telemetry = [
      budget.primaryMetric,
      ...Object.keys(budget.supplementaryCeilings ?? {}),
    ];
    if (
      !Array.isArray(requiredAssertions) ||
      requiredAssertions.length === 0 ||
      !requiredAssertions.every(
        (assertion) => typeof assertion === "string" && assertion.length > 0,
      ) ||
      new Set(requiredAssertions).size !== requiredAssertions.length ||
      !telemetry.every(
        (metric) => typeof metric === "string" && metric.length > 0,
      ) ||
      new Set(telemetry).size !== telemetry.length
    ) {
      throw new Error(
        `${scenarioId}: fixture telemetry/assertions are invalid`,
      );
    }
    prepared.set(scenarioId, {
      budget,
      fixtureBytes,
      fixtureDocument,
      policy,
      requiredAssertions,
      telemetry,
    });
  }
  return prepared;
};

const assertAdapterRegistry = (adapters, selectedIds) => {
  if (!isRecord(adapters)) {
    throw new Error("Canonical performance adapter registry is missing");
  }
  if (!sameStringSet(Object.keys(adapters), CANONICAL_SCENARIO_IDS)) {
    throw new Error("Canonical performance adapter registry is incomplete");
  }
  for (const scenarioId of selectedIds) {
    if (typeof adapters[scenarioId] !== "function") {
      throw new Error(
        `Canonical performance adapter ${scenarioId} is not configured`,
      );
    }
  }
};

const validateAdapterResult = ({ prepared, result, scenarioId }) => {
  assertExactKeys(
    result,
    ["metrics", "assertions", "executionBinding"],
    `${scenarioId} adapter result`,
  );
  validateExecutionBinding(result.executionBinding, scenarioId);
  assertExactKeys(
    result.metrics,
    prepared.telemetry,
    `${scenarioId} telemetry`,
  );
  assertExactKeys(
    result.assertions,
    prepared.requiredAssertions,
    `${scenarioId} assertions`,
  );
  for (const metric of prepared.telemetry) {
    assertFiniteNonnegative(result.metrics[metric], `${scenarioId}.${metric}`);
  }
  for (const assertion of prepared.requiredAssertions) {
    if (result.assertions[assertion] !== true) {
      throw new Error(`${scenarioId}.${assertion} did not pass`);
    }
  }
};

export const collectCanonicalPerformanceSamples = async ({
  adapters,
  artifactBinding,
  browser,
  collectedAt = () => new Date(),
  context,
  environment,
  evidenceId,
  gate,
  loadFixture,
  source,
  targetUrl,
}) => {
  if ((context?.errors ?? []).length > 0) {
    throw new Error(
      `Performance policy is invalid:\n${context.errors.join("\n")}`,
    );
  }
  if (
    typeof evidenceId !== "string" ||
    !/^perf-[a-z0-9][a-z0-9._-]{7,127}$/.test(evidenceId)
  ) {
    throw new Error("Performance evidence ID is invalid");
  }
  if (typeof targetUrl !== "string" || targetUrl.length === 0) {
    throw new Error("Performance target URL is required");
  }
  const requiredVariant = REQUIRED_PERFORMANCE_VARIANTS[gate];
  if (!requiredVariant) {
    throw new Error(`Unknown performance gate ${gate}`);
  }
  assertSourceBinding(source, requiredVariant);
  assertEnvironmentBinding(environment);
  assertCanonicalScenarioDispatch(context);
  const requirement = context.gateMap?.get(gate);
  if (requirement?.evidenceScope !== "own") {
    throw new Error(
      `${gate}: inherited performance evidence must be verified through the accepted-evidence closure; single-artifact collection is forbidden`,
    );
  }
  const resolution = resolveGateScenarioIds(context.budgets, gate);
  const scenarioIds = [...(requirement?.scenarioIds ?? [])];
  if (
    !requirement ||
    resolution.errors.length > 0 ||
    scenarioIds.length === 0
  ) {
    throw new Error(
      `${gate}: performance scenario resolution failed: ${resolution.errors.join(", ")}`,
    );
  }
  assertAdapterRegistry(adapters, scenarioIds);
  const prepared = await prepareScenarios({
    context,
    loadFixture,
    scenarioIds,
  });
  const collected = new Map(
    scenarioIds.map((scenarioId) => {
      const scenario = prepared.get(scenarioId);
      return [
        scenarioId,
        {
          assertions: Object.fromEntries(
            scenario.requiredAssertions.map((assertion) => [assertion, true]),
          ),
          metrics: Object.fromEntries(
            scenario.telemetry.map((metric) => [metric, []]),
          ),
          executionBinding: null,
        },
      ];
    }),
  );
  const schedule = buildDeterministicMeasurementSchedule(
    scenarioIds,
    PERFORMANCE_SAMPLE_COUNT,
  );
  for (const [scheduleIndex, task] of schedule.entries()) {
    const scenario = prepared.get(task.scenarioId);
    const browserContext = await browser.newContext();
    try {
      const page = await browserContext.newPage();
      const result = await adapters[task.scenarioId]({
        adapterKind: CANONICAL_SCENARIO_DISPATCH[task.scenarioId].adapterKind,
        artifactBinding,
        browserContext,
        fixtureBytes: scenario.fixtureBytes,
        fixtureDocument: scenario.fixtureDocument,
        page,
        requiredAssertions: [...scenario.requiredAssertions],
        requiredTelemetry: [...scenario.telemetry],
        sampleIndex: task.sampleIndex,
        scenarioId: task.scenarioId,
        scheduleIndex,
        targetUrl,
        warmup: task.phase === "warmup",
      });
      validateAdapterResult({
        prepared: scenario,
        result,
        scenarioId: task.scenarioId,
      });
      const destination = collected.get(task.scenarioId);
      const bindingJson = JSON.stringify(result.executionBinding);
      if (destination.executionBinding === null) {
        destination.executionBinding = structuredClone(result.executionBinding);
      } else if (JSON.stringify(destination.executionBinding) !== bindingJson) {
        throw new Error(
          `${task.scenarioId}: execution binding drifted between samples`,
        );
      }
      if (task.phase === "sample") {
        for (const metric of scenario.telemetry) {
          destination.metrics[metric].push(result.metrics[metric]);
        }
      }
    } catch (error) {
      throw new Error(
        `${task.scenarioId} ${task.phase} ${task.sampleIndex ?? 0} failed: ${error.message}`,
        { cause: error },
      );
    } finally {
      await browserContext.close();
    }
  }

  const scenarios = scenarioIds.map((scenarioId) => {
    const scenario = prepared.get(scenarioId);
    const values = collected.get(scenarioId);
    const samples = values.metrics[scenario.budget.primaryMetric];
    const supplementarySamples = Object.fromEntries(
      Object.keys(scenario.budget.supplementaryCeilings ?? {}).map((metric) => [
        metric,
        values.metrics[metric],
      ]),
    );
    if (
      values.executionBinding === null ||
      samples.length !== PERFORMANCE_SAMPLE_COUNT ||
      Object.values(supplementarySamples).some(
        (metricSamples) => metricSamples.length !== PERFORMANCE_SAMPLE_COUNT,
      )
    ) {
      throw new Error(`${scenarioId}: collector sample count differs from 30`);
    }
    return {
      id: scenarioId,
      samples,
      supplementarySamples,
      outcomeAssertions: values.assertions,
      executionBinding: values.executionBinding,
    };
  });

  const collectedAtValue = collectedAt();
  if (
    !(collectedAtValue instanceof Date) ||
    !Number.isFinite(collectedAtValue.getTime())
  ) {
    throw new Error("Performance collection timestamp is invalid");
  }
  return {
    schemaVersion: 1,
    evidenceId,
    gate,
    collectedAtUtc: collectedAtValue.toISOString(),
    source: structuredClone(source),
    environment: structuredClone(environment),
    scenarios,
  };
};

export const PERFORMANCE_COLLECTOR_CONTRACT = Object.freeze({
  rotation: PERFORMANCE_ROTATION,
  sampleCount: PERFORMANCE_SAMPLE_COUNT,
  warmupCount: PERFORMANCE_WARMUP_COUNT,
});
