import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import { assertReviewedPerformanceArtifact } from "./lib/performance-evidence-identity.mjs";
import {
  PERFORMANCE_INHERITED_GATES,
  resolveHistoricalPerformanceDimensions,
  verifyPerformanceInheritedClosure,
} from "./lib/performance-inherited-closure.mjs";
import { computeVariantId } from "./lib/release-policy.mjs";
import {
  CANONICAL_SCENARIO_IDS,
  REQUIRED_PERFORMANCE_VARIANTS,
} from "./performance/canonicalScenarioDispatch.mjs";
import {
  canonicalize,
  projectRoot,
  sha256 as sha256Canonical,
} from "./foundation-policy-utils.mjs";
import {
  projectPerformanceBudgetContract,
  verifyPerformanceGate,
  verifyPerformancePolicy,
} from "./verify-performance-policy.mjs";
import { collectJsonSchemaErrors } from "./release-state/releaseStateSchema.mjs";

const namespace = "performance-closure-test";
const createdAtUtc = "2026-08-09T00:00:00.000Z";
const sha = (value) => value.toString(16).padStart(64, "0");
const sourceSha = (value) => value.toString(16).padStart(40, "0");
const reference = (digest) => ({
  uri: `release-state://${namespace}/evidence/${digest}`,
  sha256: digest,
});

const buildFixture = async () => {
  const [context, releasePolicy, schema] = await Promise.all([
    verifyPerformancePolicy({ root: projectRoot }),
    readJsonStrict(`${projectRoot}/config/release-variants.json`),
    readJsonStrict(
      `${projectRoot}/config/performance-inherited-closure.schema.json`,
    ),
  ]);
  assert.deepEqual(context.errors, []);
  const contentByGate = new Map(
    PERFORMANCE_INHERITED_GATES.map((gate, index) => [gate, sha(10 + index)]),
  );
  const gateForScenario = (id) =>
    PERFORMANCE_INHERITED_GATES.find((gate) =>
      context.gateMap.get(gate).scenarioIds.includes(id),
    );
  const budgetMap = new Map(
    [...context.budgetMap].map(([id, budget]) => [
      id,
      {
        ...budget,
        evidenceSha256: contentByGate.get(gateForScenario(id)),
      },
    ]),
  );
  const boundContext = { ...context, budgetMap };
  const gates = PERFORMANCE_INHERITED_GATES.map((gate, index) => {
    const sequence = (index + 1) * 10;
    const evidenceObjectSha256 = sha(20 + index);
    const archiveSha256 = sha(30 + index);
    const eventSha256 = sha(40 + index);
    const dimensions = resolveHistoricalPerformanceDimensions(
      releasePolicy,
      gate,
    );
    return {
      gate,
      performanceEvidence: {
        reference: reference(evidenceObjectSha256),
        objectSha256: evidenceObjectSha256,
        contentSha256: contentByGate.get(gate),
        evidenceId: `perf-${gate.toLowerCase()}-accepted`,
        collectedAtUtc: createdAtUtc,
      },
      acceptedEvent: {
        reference: {
          uri: `release-state://${namespace}/events/${sequence}/${eventSha256}`,
          sha256: eventSha256,
        },
        operationId: `accept-${gate.toLowerCase()}`,
        observedThrough: createdAtUtc,
        sequence,
      },
      acceptanceSubject: reference(sha(50 + index)),
      source: {
        gitCommitSha: sourceSha(60 + index),
        sourceClosureSha256: sha(70 + index),
        treeState: "clean",
        artifactSha256: archiveSha256,
        releaseVariant: structuredClone(REQUIRED_PERFORMANCE_VARIANTS[gate]),
      },
      artifact: {
        archive: reference(archiveSha256),
        archiveAvailability: reference(sha(80 + index)),
        manifest: reference(sha(90 + index)),
        packageIndex: reference(sha(100 + index)),
        variantId: computeVariantId(releasePolicy, dimensions),
        dimensions,
      },
      scenarioIds: [...context.gateMap.get(gate).scenarioIds],
    };
  });
  const scenarios = CANONICAL_SCENARIO_IDS.map((id, index) => {
    const gate = gateForScenario(id);
    const gateEntry = gates.find((entry) => entry.gate === gate);
    return {
      id,
      gate,
      fixtureSha256: context.scenarioMap.get(id).fixtureSha256,
      performanceEvidenceObjectSha256:
        gateEntry.performanceEvidence.objectSha256,
      performanceEvidenceContentSha256:
        gateEntry.performanceEvidence.contentSha256,
      scenarioEvidenceSha256: sha(200 + index),
    };
  });
  const closure = {
    kind: "performance-inherited-closure/v1",
    closureId: "perf-closure-focused-contract",
    createdAtUtc,
    namespace,
    p8Source: {
      gitCommitSha: sourceSha(1),
      sourceClosureSha256: sha(2),
      treeState: "clean",
    },
    policyBindings: {
      uiScenariosSha256: sha256Canonical(canonicalize(context.uiScenarios)),
      performanceBudgetContractSha256: sha256Canonical(
        canonicalize(projectPerformanceBudgetContract(context.budgets)),
      ),
      xlsxLimitsSha256: sha256Canonical(canonicalize(context.xlsxLimits)),
    },
    requiredGates: [...PERFORMANCE_INHERITED_GATES],
    gates,
    scenarios,
  };
  const probe = {
    schemaVersion: 1,
    closure,
    closureSha256: sha256Json(closure),
  };
  return { boundContext, envelope: probe, releasePolicy, schema };
};

test("verifies a closed 4-gate, 17-scenario inherited closure", async () => {
  const { boundContext, envelope, releasePolicy } = await buildFixture();
  assert.deepEqual(
    verifyPerformanceInheritedClosure({
      context: boundContext,
      releasePolicy,
      envelope,
    }).errors,
    [],
  );
  const bytes = Buffer.concat([
    canonicalJsonBytes(envelope),
    Buffer.from("\n"),
  ]);
  assert.equal(
    assertReviewedPerformanceArtifact({
      bytes,
      expectedSha256: sha256Bytes(bytes),
    }).artifactKind,
    "performance-inherited-closure/v1",
  );
});

test("rejects closure field, variant, archive, and raw-byte tampering", async () => {
  const { boundContext, envelope, releasePolicy } = await buildFixture();
  const verifyTamper = (mutate) => {
    const tampered = structuredClone(envelope);
    mutate(tampered);
    tampered.closureSha256 = sha256Json(tampered.closure);
    return verifyPerformanceInheritedClosure({
      context: boundContext,
      releasePolicy,
      envelope: tampered,
    }).errors;
  };
  assert.ok(
    verifyTamper((value) => {
      value.closure.unknown = true;
    }).some((error) => error.includes("unknown or missing fields")),
  );
  assert.ok(
    verifyTamper((value) => {
      value.closure.gates[1].artifact.variantId = sha(999);
    }).some((error) => error.includes("closure binding is invalid")),
  );
  assert.ok(
    verifyTamper((value) => {
      value.closure.gates[1].artifact.archive = structuredClone(
        value.closure.gates[0].artifact.archive,
      );
      value.closure.gates[1].source.artifactSha256 =
        value.closure.gates[1].artifact.archive.sha256;
    }).some((error) => error.includes("distinct archives")),
  );
  assert.ok(
    verifyTamper((value) => {
      value.closure.gates[0].performanceEvidence.collectedAtUtc =
        "2026-08-09T00:00:01.000Z";
    }).some((error) => error.includes("timestamps are out of order")),
  );
  assert.ok(
    verifyTamper((value) => {
      value.closure.gates[0].acceptedEvent.observedThrough =
        "2026-08-09T00:00:01.000Z";
    }).some((error) => error.includes("timestamps are out of order")),
  );

  const bytes = canonicalJsonBytes(envelope);
  assert.throws(
    () =>
      assertReviewedPerformanceArtifact({
        bytes,
        expectedSha256: sha(999),
      }),
    /reviewed SHA-256/,
  );
});

test("rejects accepted operation IDs beyond the schema maximum at schema and runtime boundaries", async () => {
  const { boundContext, envelope, releasePolicy, schema } =
    await buildFixture();
  const operationId = "x".repeat(129);
  const operationIdSchema =
    schema.$defs.acceptedEventSummary.properties.operationId;
  assert.ok(
    collectJsonSchemaErrors(
      operationId,
      operationIdSchema,
      schema,
      "$.acceptedEvent.operationId",
    ).some((error) => error.includes("at most 128 characters")),
  );

  const tampered = structuredClone(envelope);
  tampered.closure.gates[0].acceptedEvent.operationId = operationId;
  tampered.closureSha256 = sha256Json(tampered.closure);
  assert.ok(
    verifyPerformanceInheritedClosure({
      context: boundContext,
      releasePolicy,
      envelope: tampered,
    }).errors.some((error) => error.includes("closure binding is invalid")),
  );
});

test("tracks a closed schema for every inherited closure object", async () => {
  const { schema } = await buildFixture();
  assert.equal(
    schema.$id,
    "https://event-shopping-planner.invalid/schemas/performance-inherited-closure-v1.json",
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.closure.additionalProperties, false);
  for (const definition of [
    "reference",
    "p8Source",
    "policyBindings",
    "releaseVariant",
    "source",
    "performanceEvidenceSummary",
    "acceptedEventSummary",
    "artifact",
    "gateEntry",
    "scenario",
  ]) {
    assert.equal(schema.$defs[definition].additionalProperties, false);
  }
  assert.deepEqual(
    schema.properties.closure.properties.requiredGates.prefixItems.map(
      ({ const: gate }) => gate,
    ),
    PERFORMANCE_INHERITED_GATES,
  );
  assert.equal(schema.properties.closure.properties.scenarios.minItems, 17);
  assert.equal(schema.properties.closure.properties.scenarios.maxItems, 17);
});

test("routes P8 verification to the inherited closure contract", async () => {
  const { boundContext, envelope } = await buildFixture();
  const context = {
    ...boundContext,
    pendingScenarioIds: [],
    blockerMap: new Map(),
    budgets: {
      ...boundContext.budgets,
      machineProfile: {
        status: "bound",
        os: "Windows 11",
        cpu: "Canonical CPU",
        memoryBytes: 32 * 1024 ** 3,
        powerMode: "best-performance-ac",
      },
      browser: {
        family: "chromium",
        version: "140.0.7339.16",
        channel: "playwright",
      },
    },
  };
  const result = await verifyPerformanceGate({
    root: projectRoot,
    gate: "P8-CLEAN",
    evidence: envelope,
    context,
  });
  assert.ok(
    result.errors.every(
      (error) => !error.includes("evidence body has unknown or missing fields"),
    ),
  );
  const ownGateEnvelope = {
    schemaVersion: 1,
    evidence: {},
    evidenceSha256: sha256Json({}),
  };
  const rejected = await verifyPerformanceGate({
    root: projectRoot,
    gate: "P8-CLEAN",
    evidence: ownGateEnvelope,
    context,
  });
  assert.ok(
    rejected.errors.some((error) =>
      error.includes("Performance inherited closure envelope"),
    ),
  );
});
