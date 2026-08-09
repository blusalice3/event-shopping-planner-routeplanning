import { CANONICAL_SCENARIO_IDS } from "./canonicalScenarioDispatch.mjs";
import { publicFoundationScenarioAdapters } from "./publicFoundationScenarioAdapters.mjs";
import { publicListScenarioAdapters } from "./publicListScenarioAdapters.mjs";
import { publicXlsxScenarioAdapters } from "./publicXlsxScenarioAdapters.mjs";

export const PERFORMANCE_ADAPTER_CONTRACT_VERSION = 1;

const publicAdapters = Object.freeze({
  ...publicFoundationScenarioAdapters,
  ...publicXlsxScenarioAdapters,
  ...publicListScenarioAdapters,
});

if (
  Object.keys(publicAdapters).length !== CANONICAL_SCENARIO_IDS.length ||
  CANONICAL_SCENARIO_IDS.some(
    (scenarioId) => typeof publicAdapters[scenarioId] !== "function",
  )
) {
  throw new Error(
    "Canonical public Playwright adapter dispatch is incomplete or out of order",
  );
}

export const scenarioAdapters = Object.freeze(
  Object.fromEntries(
    CANONICAL_SCENARIO_IDS.map((scenarioId) => [
      scenarioId,
      publicAdapters[scenarioId],
    ]),
  ),
);
