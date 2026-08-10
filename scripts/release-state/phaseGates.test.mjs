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
import {
  P8_FLOOR_PREDECESSOR,
  resolveRequiredPhaseExitForOperation,
} from "./releaseOperationPhaseExit.mjs";
import {
  assertReleaseOperationPhaseExit,
  runReleaseOperationPhaseExitCli,
} from "./verify-operation-phase-exit.mjs";

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

test("opens only the P8 floor branch against the formal P7 predecessor", () => {
  for (const operation of [
    "produce-policy-activation-closure",
    "produce-policy-activation-subject",
    "activate-policy-floor",
  ]) {
    assert.equal(
      resolveRequiredPhaseExitForOperation({
        operation,
        acceptedGate: "P8-CLEAN",
      }),
      P8_FLOOR_PREDECESSOR,
      operation,
    );
  }
  assert.throws(
    () =>
      resolveRequiredPhaseExitForOperation({
        operation: "activate-policy-floor",
        acceptedGate: "P7-IDB",
      }),
    /requires the live accepted P8-CLEAN gate/u,
  );
  assert.equal(
    resolveRequiredPhaseExitForOperation({
      operation: "activate-policy",
      acceptedGate: "P8-CLEAN",
    }),
    "P8-CLEAN",
  );
  assert.equal(
    resolveRequiredPhaseExitForOperation({
      operation: "produce-policy-activation-qa-package",
      acceptedGate: "P7-IDB",
    }),
    "P7-IDB",
  );
});

test("routes acceptance candidates through advance or same-floor predecessors", () => {
  for (const operation of [
    "produce-acceptance-requirements",
    "produce-acceptance-inputs",
    "accept-standard",
  ]) {
    assert.equal(
      resolveRequiredPhaseExitForOperation({
        operation,
        acceptedGate: "P7-IDB",
        candidateGate: "P8-CLEAN",
      }),
      "P7-IDB",
      `${operation} advance`,
    );
    assert.equal(
      resolveRequiredPhaseExitForOperation({
        operation,
        acceptedGate: "P1-PWA",
        candidateGate: "P1-PWA",
      }),
      "P0-RELEASE",
      `${operation} same-floor`,
    );
    assert.throws(
      () =>
        resolveRequiredPhaseExitForOperation({
          operation,
          acceptedGate: "P8-CLEAN",
          candidateGate: "P8-CLEAN",
        }),
      /Terminal P8-CLEAN does not permit same-floor acceptance routing/u,
      `${operation} terminal same-floor`,
    );
    assert.equal(
      resolveRequiredPhaseExitForOperation({
        operation,
        acceptedGate: null,
        candidateGate: "P0-RELEASE",
      }),
      "P0-PROMOTE",
      `${operation} initial`,
    );
    for (const candidateGate of [null, "P0-TOOLCHAIN", "P5-LIST"]) {
      assert.throws(
        () =>
          resolveRequiredPhaseExitForOperation({
            operation,
            acceptedGate: "P7-IDB",
            candidateGate,
          }),
        /candidate gate/u,
        `${operation} ${String(candidateGate)}`,
      );
    }
  }
  assert.throws(
    () =>
      resolveRequiredPhaseExitForOperation({
        operation: "produce-artifact-build-requirements",
        acceptedGate: "P8-CLEAN",
        candidateGate: "P8-CLEAN",
      }),
    /forbidden outside acceptance predecessor routing/u,
  );
  assert.equal(
    resolveRequiredPhaseExitForOperation({
      operation: "produce-artifact-build-requirements",
      acceptedGate: "P8-CLEAN",
    }),
    "P0-TOOLCHAIN",
  );
});

test("fails closed on missing or surplus predecessor candidate gates", async () => {
  const baseInput = {
    store: {},
    sourceSha: "a".repeat(40),
  };
  await assert.rejects(
    assertReleaseOperationPhaseExit({
      ...baseInput,
      operation: "accept-standard",
    }),
    /predecessor identity is invalid/u,
  );
  await assert.rejects(
    assertReleaseOperationPhaseExit({
      ...baseInput,
      operation: "produce-artifact-build-requirements",
      candidateGate: "P1-PWA",
    }),
    /predecessor identity is invalid/u,
  );
  await assert.rejects(
    runReleaseOperationPhaseExitCli([
      "--namespace",
      "release-test",
      "--source-sha",
      "a".repeat(40),
      "--operation",
      "produce-artifact-build-requirements",
      "--candidate-gate",
      "P1-PWA",
    ]),
    /Release predecessor arguments are incomplete/u,
  );
});

test("rejects P8 floor preparation until formal P7-IDB is attested", async () => {
  const current = { snapshot: { acceptedGate: "P8-CLEAN" } };
  const baseDependencies = {
    readState: async () => current,
    isSourceAncestor: () => true,
  };
  await assert.rejects(
    assertReleaseOperationPhaseExit(
      {
        store: {},
        operation: "produce-policy-activation-closure",
        sourceSha: "a".repeat(40),
      },
      {
        ...baseDependencies,
        readLedger: () => [],
        validateChain: async () => {
          throw new Error("unreachable chain validation");
        },
      },
    ),
    /required formal predecessor exit is absent: P7-IDB/u,
  );
  const ledger = [{ gate: "P7-IDB", attestation: { sha256: "b".repeat(64) } }];
  const verified = await assertReleaseOperationPhaseExit(
    {
      store: {},
      operation: "produce-policy-activation-subject",
      sourceSha: "a".repeat(40),
    },
    {
      ...baseDependencies,
      readLedger: () => ledger,
      validateChain: async () => [{ attestation: { gate: "P7-IDB" } }],
    },
  );
  assert.deepEqual(verified, {
    operation: "produce-policy-activation-subject",
    requiredGate: "P7-IDB",
    status: "verified",
  });
});

test("verifies same-floor acceptance against the previous formal gate", async () => {
  const current = { snapshot: { acceptedGate: "P1-PWA" } };
  const ledger = [
    { gate: "P0-RELEASE", attestation: { sha256: "b".repeat(64) } },
  ];
  const verified = await assertReleaseOperationPhaseExit(
    {
      store: {},
      operation: "accept-standard",
      sourceSha: "a".repeat(40),
      candidateGate: "P1-PWA",
    },
    {
      readState: async () => current,
      readLedger: () => ledger,
      validateChain: async () => [{ attestation: { gate: "P0-RELEASE" } }],
      isSourceAncestor: () => true,
    },
  );
  assert.deepEqual(verified, {
    operation: "accept-standard",
    requiredGate: "P0-RELEASE",
    status: "verified",
  });
});
