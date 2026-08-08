import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  COMPANION_RECOVERY_STEPS,
  produceCompanionRecoveryDrill,
  produceContinuousProductionProbe,
  validateCompanionRecoveryDrill,
  validateContinuousProductionProbe,
} from "./acceptanceEvidenceInputs.mjs";

const namespace = "acceptance-input-test";
const sourceSha = "a".repeat(40);
const operationId = "acceptance-input-operation";
const startedAt = "2026-08-06T00:00:00.000Z";
const endedAt = "2026-08-07T00:00:00.000Z";
const nowMilliseconds = Date.parse(endedAt);
const domains = ["a.example.test", "b.example.test"];

const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});
const eventReference = (sha256) => ({
  uri: `release-state://${namespace}/events/4/${sha256}`,
  sha256,
});
const binding = (role, suffix) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: suffix.repeat(64),
  releaseRole: role,
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${role}-${suffix}`,
  packageIndex: reference("1".repeat(64)),
  artifactManifest: reference(
    role === "standard" ? "2".repeat(64) : "3".repeat(64),
  ),
  providerEvidence: reference(
    role === "standard" ? "4".repeat(64) : "5".repeat(64),
  ),
  releasePolicy: reference("6".repeat(64)),
});
const pendingAcceptance = {
  operationId,
  standardBinding: binding("standard", "a"),
  companionBinding: binding("containment", "b"),
  assignmentValidationEvidence: reference("7".repeat(64)),
  observationStartedEvent: eventReference("8".repeat(64)),
  observationNotBefore: startedAt,
  minimumObservationEndsAt: endedAt,
};
const releaseAEvidence = {
  release: {
    releaseId: operationId,
    commitSha: sourceSha,
  },
  canary: {
    buildSha: sourceSha,
    startedAt,
    endedAt,
  },
  automatedGates: {
    rollback: {
      status: "PASS",
      command: "npm run test:release-a-rollback",
      commitSha: sourceSha,
      completedAt: endedAt,
      evidenceRef: "artifact://release-a/companion-recovery",
    },
  },
};
const releaseAEvidenceBytes = canonicalJsonBytes(releaseAEvidence);
const releaseAEvidenceSha256 = sha256Bytes(releaseAEvidenceBytes);
const providerPolicy = {
  bindingStatus: "configured",
  expectedProjectId: "project-test",
  ownedProductionDomains: domains,
  observationPolicy: {
    maxFutureClockSkewSeconds: 30,
  },
};

const continuousSource = () => ({
  schemaVersion: 1,
  sourceKind: "continuous-production-probe-source/v1",
  samples: Array.from({ length: 289 }, (_, index) => ({
    observedAt: new Date(
      Date.parse(startedAt) + index * 5 * 60 * 1000,
    ).toISOString(),
    results: domains.map((productionDomain) => ({
      productionDomain,
      providerDeploymentId:
        pendingAcceptance.standardBinding.providerDeploymentId,
      status: "PASS",
      responseSha256: `${index.toString(16).padStart(63, "0")}a`.slice(-64),
    })),
  })),
});

const recoveryCompanion = () => {
  const companion = pendingAcceptance.companionBinding;
  return {
    bindingId: companion.bindingId,
    sourceSha: companion.sourceSha,
    buildId: companion.buildId,
    variantId: companion.variantId,
    providerProjectId: companion.providerProjectId,
    providerDeploymentId: companion.providerDeploymentId,
    packageIndexSha256: companion.packageIndex.sha256,
    artifactManifestSha256: companion.artifactManifest.sha256,
    providerEvidenceSha256: companion.providerEvidence.sha256,
  };
};

const recoverySource = () => ({
  schemaVersion: 1,
  sourceKind: "companion-recovery-drill-source/v1",
  status: "PASS",
  command: "npm run test:release-a-rollback",
  startedAt: "2026-08-06T23:00:00.000Z",
  completedAt: endedAt,
  drillEvidenceRef: releaseAEvidence.automatedGates.rollback.evidenceRef,
  companion: recoveryCompanion(),
  steps: COMPANION_RECOVERY_STEPS.map((step, index) => ({
    step,
    status: "PASS",
    evidenceRef: `artifact://release-a/recovery-step-${index + 1}`,
  })),
});

test("produces and revalidates a continuous all-domain deployment probe", () => {
  const sourceBytes = canonicalJsonBytes(continuousSource());
  const produced = produceContinuousProductionProbe({
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    providerPolicy,
    nowMilliseconds,
  });
  assert.equal(produced.evidence.sampleCount, 289);
  assert.equal(produced.evidence.maximumGapSeconds, 300);
  assert.deepEqual(
    validateContinuousProductionProbe({
      bytes: produced.evidenceBytes,
      expectedSha256: produced.sha256,
      namespace,
      pendingAcceptance,
      releaseAEvidence,
      releaseAEvidenceSha256,
      providerPolicy,
      nowMilliseconds,
    }),
    produced.evidence,
  );
});

test("rejects a continuous probe gap, deployment drift, and hash drift", () => {
  const gap = continuousSource();
  gap.samples.splice(100, 1);
  const gapBytes = canonicalJsonBytes(gap);
  assert.throws(
    () =>
      produceContinuousProductionProbe({
        namespace,
        pendingAcceptance,
        releaseAEvidenceBytes,
        expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
        sourceBytes: gapBytes,
        expectedSourceSha256: sha256Bytes(gapBytes),
        providerPolicy,
        nowMilliseconds,
      }),
    /duplicate, gap, or regression/,
  );

  const drift = continuousSource();
  drift.samples[10].results[0].providerDeploymentId = "other-deployment";
  const driftBytes = canonicalJsonBytes(drift);
  assert.throws(
    () =>
      produceContinuousProductionProbe({
        namespace,
        pendingAcceptance,
        releaseAEvidenceBytes,
        expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
        sourceBytes: driftBytes,
        expectedSourceSha256: sha256Bytes(driftBytes),
        providerPolicy,
        nowMilliseconds,
      }),
    /differs from the pending deployment/,
  );

  const validBytes = canonicalJsonBytes(continuousSource());
  assert.throws(
    () =>
      produceContinuousProductionProbe({
        namespace,
        pendingAcceptance,
        releaseAEvidenceBytes,
        expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
        sourceBytes: validBytes,
        expectedSourceSha256: "f".repeat(64),
        providerPolicy,
        nowMilliseconds,
      }),
    /reviewed SHA-256/,
  );
});

test("produces and revalidates a companion-specific recovery drill", () => {
  const sourceBytes = canonicalJsonBytes(recoverySource());
  const produced = produceCompanionRecoveryDrill({
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    nowMilliseconds,
    futureClockSkewSeconds: 30,
  });
  assert.equal(
    produced.evidence.companion.providerDeploymentId,
    pendingAcceptance.companionBinding.providerDeploymentId,
  );
  assert.deepEqual(
    validateCompanionRecoveryDrill({
      bytes: produced.evidenceBytes,
      expectedSha256: produced.sha256,
      namespace,
      pendingAcceptance,
      releaseAEvidence,
      releaseAEvidenceSha256,
      nowMilliseconds,
      futureClockSkewSeconds: 30,
    }),
    produced.evidence,
  );
});

test("rejects a generic or incorrectly bound recovery drill", () => {
  const source = recoverySource();
  source.companion.providerDeploymentId = "other-deployment";
  const sourceBytes = canonicalJsonBytes(source);
  assert.throws(
    () =>
      produceCompanionRecoveryDrill({
        namespace,
        pendingAcceptance,
        releaseAEvidenceBytes,
        expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
        sourceBytes,
        expectedSourceSha256: sha256Bytes(sourceBytes),
        nowMilliseconds,
        futureClockSkewSeconds: 30,
      }),
    /differs from the pending companion/,
  );

  const wrongStep = recoverySource();
  wrongStep.steps[1].step = wrongStep.steps[0].step;
  const wrongStepBytes = canonicalJsonBytes(wrongStep);
  assert.throws(
    () =>
      produceCompanionRecoveryDrill({
        namespace,
        pendingAcceptance,
        releaseAEvidenceBytes,
        expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
        sourceBytes: wrongStepBytes,
        expectedSourceSha256: sha256Bytes(wrongStepBytes),
        nowMilliseconds,
        futureClockSkewSeconds: 30,
      }),
    /step order, status, or reference/,
  );
});
