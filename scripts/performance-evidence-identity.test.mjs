import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import { projectRoot } from "./foundation-policy-utils.mjs";
import {
  ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
  assertPerformanceArtifactValueForAcceptedGate,
  assertReviewedPerformanceArtifactForAcceptedGate,
  projectOwnGatePerformanceEnvelope,
} from "./lib/performance-evidence-identity.mjs";

const ownGateEnvelope = (gate) => {
  const acceptedGate = Object.entries(ACCEPTANCE_PERFORMANCE_REQUIREMENTS).find(
    ([, requirement]) => requirement === gate,
  )?.[0];
  const sourceSha = "b".repeat(40);
  const artifactSha256 = "c".repeat(64);
  const evidence = {
    gate,
    collectedAtUtc: "2026-08-09T00:00:00.000Z",
    source: {
      gitCommitSha: sourceSha,
      sourceClosureSha256: "d".repeat(64),
      treeState: "clean",
      artifactSha256,
    },
  };
  const envelope = {
    schemaVersion: 1,
    evidence,
    evidenceSha256: sha256Json(evidence),
  };
  const receipt = {
    kind: "own-gate-performance-evidence-producer-receipt/v1",
    namespace: "performance-identity-test",
    operationId: "identity-test",
    acceptedGate,
    performanceGate: gate,
    source: {
      gitCommitSha: sourceSha,
      sourceClosureSha256: "d".repeat(64),
      treeState: "clean",
    },
    authoritativeState: { sequence: 1, eventHash: "e".repeat(64) },
    requirementsSha256: "f".repeat(64),
    artifactArchiveSha256: artifactSha256,
    rawSamplesArtifact: {
      name: `foundation-performance-raw-samples-${sourceSha}-1`,
      runId: "1",
      runAttempt: "1",
      sha256: "1".repeat(64),
      collectorIdentity: {
        uri: `release-state://performance-identity-test/evidence/${"2".repeat(64)}`,
        sha256: "2".repeat(64),
      },
      workflowRunAuthority: {
        uri: `release-state://performance-identity-test/evidence/${"3".repeat(64)}`,
        sha256: "3".repeat(64),
      },
    },
    producerRunId: "2",
    producerRunAttempt: "1",
    performanceEvidence: {
      name: `foundation-performance-own-gate-evidence-${sourceSha}-1`,
      envelopeSha256: sha256Bytes(canonicalJsonBytes(envelope)),
      evidenceSha256: envelope.evidenceSha256,
    },
    producedAtUtc: "2026-08-09T01:00:00.000Z",
  };
  return {
    ...envelope,
    producerReceipt: {
      schemaVersion: 1,
      receipt,
      receiptSha256: sha256Json(receipt),
    },
  };
};

const closureEnvelope = () => {
  const closure = {
    kind: "performance-inherited-closure/v1",
    p8Source: { gitCommitSha: "a".repeat(40) },
  };
  return {
    schemaVersion: 1,
    closure,
    closureSha256: sha256Json(closure),
  };
};

test("maps accepted gates to exact own evidence, P8 closure, or null", () => {
  for (const [acceptedGate, requirement] of Object.entries(
    ACCEPTANCE_PERFORMANCE_REQUIREMENTS,
  )) {
    const value =
      requirement === null
        ? null
        : requirement === "performance-inherited-closure/v1"
          ? closureEnvelope()
          : ownGateEnvelope(requirement);
    const result = assertPerformanceArtifactValueForAcceptedGate({
      acceptedGate,
      value,
    });
    assert.equal(
      result.artifactKind,
      requirement === null
        ? null
        : requirement === "performance-inherited-closure/v1"
          ? requirement
          : "own-gate-performance-evidence/v1",
    );
  }
});

test("projects a formal four-key own-gate artifact to the verifier's closed three-key envelope", () => {
  const artifact = ownGateEnvelope("P3-XLSX");
  assert.deepEqual(projectOwnGatePerformanceEnvelope(artifact), {
    schemaVersion: artifact.schemaVersion,
    evidence: artifact.evidence,
    evidenceSha256: artifact.evidenceSha256,
  });
  assert.equal(
    Object.hasOwn(
      projectOwnGatePerformanceEnvelope(artifact),
      "producerReceipt",
    ),
    false,
  );
});

test("rejects a missing, extra, wrong-gate, or wrong-kind artifact", () => {
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P3-XLSX",
        value: null,
      }),
    /is required/,
  );
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P1-PWA",
        value: ownGateEnvelope("P0-TOOLCHAIN"),
      }),
    /is forbidden/,
  );
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P5-DUAL",
        value: ownGateEnvelope("P3-XLSX"),
      }),
    /kind or gate differs/,
  );
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P8-CLEAN",
        value: ownGateEnvelope("P5-LIST"),
      }),
    /kind or gate differs/,
  );
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P9-UNKNOWN",
        value: null,
      }),
    /accepted gate is unknown/,
  );
  const legacyEnvelope = ownGateEnvelope("P3-XLSX");
  delete legacyEnvelope.producerReceipt;
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P3-XLSX",
        value: legacyEnvelope,
      }),
    /identity or content SHA-256 is invalid/,
  );
  const wrongAttempt = ownGateEnvelope("P3-XLSX");
  wrongAttempt.producerReceipt.receipt.producerRunAttempt = "2";
  wrongAttempt.producerReceipt.receiptSha256 = sha256Json(
    wrongAttempt.producerReceipt.receipt,
  );
  assert.throws(
    () =>
      assertPerformanceArtifactValueForAcceptedGate({
        acceptedGate: "P3-XLSX",
        value: wrongAttempt,
      }),
    /producer receipt binding is invalid/u,
  );
});

test("binds optional bytes and reviewed SHA as one pair", () => {
  const value = ownGateEnvelope("P3-XLSX");
  const bytes = canonicalJsonBytes(value);
  assert.equal(
    assertReviewedPerformanceArtifactForAcceptedGate({
      acceptedGate: "P3-XLSX",
      bytes,
      expectedSha256: sha256Bytes(bytes),
    }).artifactKind,
    "own-gate-performance-evidence/v1",
  );
  assert.equal(
    assertReviewedPerformanceArtifactForAcceptedGate({
      acceptedGate: "P6-APP",
      bytes: null,
      expectedSha256: null,
    }).artifactKind,
    null,
  );
  assert.throws(
    () =>
      assertReviewedPerformanceArtifactForAcceptedGate({
        acceptedGate: "P6-APP",
        bytes: null,
        expectedSha256: "a".repeat(64),
      }),
    /must both be null/,
  );
});

test("tracks a separate closed schema for formal own-gate artifacts", async () => {
  const schema = await readJsonStrict(
    `${projectRoot}/config/own-gate-performance-evidence.schema.json`,
  );
  assert.equal(
    schema.$id,
    "https://event-shopping-planner.invalid/schemas/own-gate-performance-evidence-v1.json",
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    [...schema.required].sort(),
    ["schemaVersion", "evidence", "evidenceSha256", "producerReceipt"].sort(),
  );
  assert.equal(schema.$defs.producerReceipt.additionalProperties, false);
  assert.equal(schema.$defs.producerReceiptBody.additionalProperties, false);
});
