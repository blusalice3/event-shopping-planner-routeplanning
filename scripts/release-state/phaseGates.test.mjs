import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACCEPTANCE_PERFORMANCE_REQUIREMENTS } from "../lib/performance-evidence-identity.mjs";
import {
  NORMAL_POLICY_ACTIVATION_GATES,
  POLICY_ACTIVATION_GATES,
  RELEASE_PHASE_GATES,
  nextReleasePhaseGate,
} from "./phaseGates.mjs";

const loadJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));

test("production phase gates have one canonical ordered contract", async () => {
  const [policy, stateSchema] = await Promise.all([
    loadJson("../../config/release-variants.json"),
    loadJson("../../config/release-state.schema.json"),
  ]);

  assert.deepEqual(
    policy.phaseSequence.map(({ gate }) => gate),
    RELEASE_PHASE_GATES,
  );
  assert.deepEqual(stateSchema.$defs.phaseGate.enum, RELEASE_PHASE_GATES);
  assert.deepEqual(
    stateSchema.$defs.policyActivatedPayload.properties.activationGate.enum,
    POLICY_ACTIVATION_GATES,
  );
  assert.deepEqual(
    Object.keys(ACCEPTANCE_PERFORMANCE_REQUIREMENTS).filter((gate) =>
      RELEASE_PHASE_GATES.includes(gate),
    ),
    RELEASE_PHASE_GATES,
  );
  assert.deepEqual(
    POLICY_ACTIVATION_GATES.filter((gate) => gate !== "P8-CLEAN"),
    NORMAL_POLICY_ACTIVATION_GATES,
  );
});

test("phase progression includes same-floor gates and rejects terminal advance", () => {
  assert.equal(nextReleasePhaseGate(null), "P0-RELEASE");
  assert.equal(nextReleasePhaseGate("P5-LIST"), "P6-APP");
  assert.equal(nextReleasePhaseGate("P7-IDB"), "P8-CLEAN");
  assert.throws(
    () => nextReleasePhaseGate("P8-CLEAN"),
    /cannot advance outside the phase sequence/,
  );
  assert.throws(
    () => nextReleasePhaseGate("P0-TOOLCHAIN"),
    /cannot advance outside the phase sequence/,
  );
});
