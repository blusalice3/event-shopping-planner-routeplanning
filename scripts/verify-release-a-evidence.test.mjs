import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadEvidenceFile,
  parseJsonStrict,
  validateReleaseAEvidence,
} from "./verify-release-a-evidence.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASELINE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const D2389A0_SHA = "d2389a02363176ba8354c4562f1a669a0b15dab9";
const NOW_MS = Date.parse("2026-08-03T00:00:00.000Z");

function evidenceRef(id) {
  return `artifact://release-a/${id}`;
}

function comparison(
  id,
  baselineNumerator,
  baselineDenominator,
  observedNumerator,
  observedDenominator,
  sampleBasis = "PRODUCTION",
) {
  return {
    baselineNumerator,
    baselineDenominator,
    baselineValue: baselineNumerator / baselineDenominator,
    observedNumerator,
    observedDenominator,
    observedValue: observedNumerator / observedDenominator,
    sampleBasis,
    evidenceRef: evidenceRef(`metric-${id}`),
  };
}

function baselineStartupCounts() {
  return {
    "lt-250ms": 70,
    "250-999ms": 25,
    "1-2999ms": 5,
    "3-9999ms": 0,
    "gte-10s": 0,
  };
}

function baselineRate(id, numerator, denominator) {
  return {
    numerator,
    denominator,
    value: numerator / denominator,
    evidenceRef: evidenceRef(`baseline-metric-${id}`),
  };
}

function baselineMetrics() {
  return {
    checkpointAdoptionRate: baselineRate("checkpoint-adoption", 95, 100),
    fallbackRepairSuccessRate: baselineRate("fallback-repair-success", 90, 100),
    conflictRate: baselineRate("load-conflict", 2, 100),
    saveFailureRate: baselineRate("save-failure", 1, 100),
    startupP95Bucket: {
      counts: baselineStartupCounts(),
      p95Bucket: "250-999ms",
      evidenceRef: evidenceRef("baseline-metric-startup-p95"),
    },
  };
}

function startupP95Bucket() {
  return {
    baselineCounts: baselineStartupCounts(),
    baselineP95Bucket: "250-999ms",
    observedCounts: {
      "lt-250ms": 75,
      "250-999ms": 20,
      "1-2999ms": 5,
      "3-9999ms": 0,
      "gte-10s": 0,
    },
    observedP95Bucket: "250-999ms",
    sampleBasis: "PRODUCTION",
    evidenceRef: evidenceRef("metric-startup-p95"),
  };
}

function hourlyEvidence() {
  const firstHour = Date.parse("2026-08-01T00:00:00.000Z");
  return Array.from({ length: 24 }, (_, index) => ({
    buildSha: RELEASE_SHA,
    startedAt: new Date(firstHour + index * 3_600_000).toISOString(),
    endedAt: new Date(firstHour + (index + 1) * 3_600_000).toISOString(),
    sampleCount: index < 4 ? 5 : 4,
    evidenceRef: evidenceRef(`canary-hour-${String(index).padStart(2, "0")}`),
  }));
}

function automatedGate(name, completedAt = "2026-08-02T01:00:00.000Z") {
  const commands = {
    test: "npm run test:run",
    lint: "npm run lint",
    typecheck: "npm run typecheck",
    build: "npm run build:release-a",
    format: "npm run format:check",
    encoding: "npm run test:encoding",
    browserPreflight: "npm run test:release-a-browser",
    rollback: "npm run test:release-a-rollback",
  };
  return {
    status: "PASS",
    command: commands[name],
    commitSha: RELEASE_SHA,
    completedAt,
    evidenceRef: evidenceRef(`gate-${name}`),
  };
}

function pwaCheck(
  os,
  browser,
  suffix,
  executedAt = "2026-08-02T02:00:00.000Z",
  reviewedAt = "2026-08-02T03:00:00.000Z",
) {
  return {
    os,
    osVersion: os === "WINDOWS_11" ? "23H2" : "15",
    browser,
    browserVersion: "140.0.0.0",
    installMode: "ACTUAL_INSTALLED_PWA",
    buildSha: RELEASE_SHA,
    serviceWorkerSha: RELEASE_SHA,
    onlineStatus: "PASS",
    offlineStatus: "PASS",
    updateStatus: "PASS",
    legacyOriginalsUnchanged: true,
    executedBy: `executor-${suffix}`,
    executedAt,
    reviewedBy: `reviewer-${suffix}`,
    reviewedAt,
    evidenceRef: evidenceRef(`pwa-${suffix}`),
  };
}

function auditSource(name, finding = "INCONCLUSIVE") {
  return {
    finding,
    checkedAt: "2026-08-02T02:15:00.000Z",
    evidenceRef: evidenceRef(`audit-${name}`),
  };
}

function approval(role, approvedAt = "2026-08-02T06:00:00.000Z") {
  return {
    decision: "APPROVED",
    approver: `approver-${role}`,
    approvedAt,
    commitSha: RELEASE_SHA,
    evidenceRef: evidenceRef(`approval-${role}`),
  };
}

function makeValidEvidence() {
  return {
    schemaVersion: "release-a-evidence/v1",
    release: {
      releaseId: "release-a-2026-08-02.1",
      commitSha: RELEASE_SHA,
      sourceTreeClean: true,
      sourceTreeCheckedAt: "2026-08-01T00:00:00.000Z",
      sourceTreeEvidenceRef: evidenceRef("source-tree"),
      cleanupMode: "FORCED_OFF",
      cleanupCheckedAt: "2026-08-01T00:00:00.000Z",
      cleanupEvidenceRef: evidenceRef("cleanup-mode"),
    },
    canary: {
      buildSha: RELEASE_SHA,
      baselinePolicy: "release-a-baseline-policy/v1",
      baseline: {
        definition: "previous-production-build-matched-cohort-complete-24h/v1",
        buildSha: BASELINE_SHA,
        startedAt: "2026-07-30T22:00:00.000Z",
        endedAt: "2026-07-31T22:00:00.000Z",
        declaredDurationHours: 24,
        cohortRef: evidenceRef("baseline-cohort"),
        queryEvidenceRef: evidenceRef("baseline-query"),
        selectedBy: "baseline-selector",
        selectedAt: "2026-07-31T22:15:00.000Z",
        reviewedBy: "baseline-reviewer",
        reviewedAt: "2026-07-31T23:00:00.000Z",
        selectionApprovalRef: evidenceRef("baseline-selection-approval"),
        metrics: baselineMetrics(),
      },
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-02T00:00:00.000Z",
      declaredDurationHours: 24,
      cohortRef: evidenceRef("canary-cohort"),
      metricsBackend: {
        buildSha: RELEASE_SHA,
        backendName: "production-observability",
        environment: "PRODUCTION",
        probeStatus: "PASS",
        probedAt: "2026-08-01T00:05:00.000Z",
        probeEvidenceRef: evidenceRef("metrics-probe"),
        dashboardRef: "dashboard://release-a/canary-2026-08-01",
      },
      buckets: [
        {
          buildSha: RELEASE_SHA,
          baselineBuildSha: BASELINE_SHA,
          startedAt: "2026-08-01T00:00:00.000Z",
          endedAt: "2026-08-02T00:00:00.000Z",
          sampleCount: 100,
          legacyPhysicalDeleteCount: 0,
          checkpointAdoptionRate: comparison(
            "checkpoint-adoption",
            95,
            100,
            96,
            100,
          ),
          fallbackRepairSuccessRate: comparison(
            "fallback-repair-success",
            90,
            100,
            91,
            100,
          ),
          conflictRate: comparison("load-conflict", 2, 100, 2, 100),
          saveFailureRate: comparison("save-failure", 1, 100, 1, 100),
          startupP95Bucket: startupP95Bucket(),
          hourlyEvidence: hourlyEvidence(),
          evidenceRef: evidenceRef("canary-bucket"),
        },
      ],
    },
    installedPwaChecks: [
      pwaCheck("WINDOWS_11", "CHROME", "windows-chrome"),
      pwaCheck("WINDOWS_11", "EDGE", "windows-edge"),
      pwaCheck("ANDROID", "CHROME", "android-chrome"),
    ],
    automatedGates: Object.fromEntries(
      [
        "test",
        "lint",
        "typecheck",
        "build",
        "format",
        "encoding",
        "browserPreflight",
        "rollback",
      ].map((name) => [name, automatedGate(name)]),
    ),
    historicalDeploymentAudit: {
      targetCommitSha: D2389A0_SHA,
      gitRefs: auditSource("git-refs", "NOT_FOUND"),
      providerDeployments: auditSource("provider"),
      manualDeployments: auditSource("manual"),
      accessLogs: auditSource("access"),
      externalRecordsComplete: false,
      verdict: "UNKNOWN",
      safetyDisposition: "TREAT_AS_DEPLOYED",
      auditedBy: "historical-auditor",
      auditedAt: "2026-08-02T02:30:00.000Z",
      reviewedBy: "historical-reviewer",
      reviewedAt: "2026-08-02T04:00:00.000Z",
      reviewEvidenceRef: evidenceRef("audit-review"),
      dedicatedE2e: {
        status: "PASS",
        scenario: "DETECT_EXPORT_EXPLICIT_ADOPT",
        releaseCommitSha: RELEASE_SHA,
        completedAt: "2026-08-02T03:00:00.000Z",
        evidenceRef: evidenceRef("d2389a0-e2e"),
      },
    },
    approvals: {
      releaseOwner: approval("release-owner"),
      dataSafetyReviewer: approval("data-safety"),
      operationsReviewer: approval("operations"),
    },
  };
}

function errorsFor(evidence) {
  return validateReleaseAEvidence(evidence, { nowMs: NOW_MS }).join("\n");
}

test("accepts a complete UNKNOWN audit only with treat-as-deployed safety evidence", () => {
  assert.deepEqual(
    validateReleaseAEvidence(makeValidEvidence(), { nowMs: NOW_MS }),
    [],
  );
});

test("the distributed pending template is structurally parseable but cannot pass", async () => {
  const templatePath = resolve(
    SCRIPT_DIRECTORY,
    "../docs/release-a-evidence.template.json",
  );
  const template = parseJsonStrict(await readFile(templatePath, "utf8"));
  const errors = validateReleaseAEvidence(template, { nowMs: NOW_MS });
  assert.ok(errors.length > 20);
  assert.match(errors.join("\n"), /release\.commitSha/);
  assert.match(errors.join("\n"), /canary/);
  assert.match(errors.join("\n"), /approvals/);
});

test("rejects unknown and privacy-sensitive fields at every depth", () => {
  const evidence = makeValidEvidence();
  evidence.release.payload = "forbidden";
  evidence.canary.buckets[0].rawStorage = "forbidden";
  const errors = errorsFor(evidence);
  assert.match(errors, /release\.payload.*forbidden/);
  assert.match(errors, /rawStorage.*forbidden/);
  assert.match(errors, /not an allowed field/);
});

test("rejects duplicate JSON object keys before schema validation", () => {
  assert.throws(
    () => parseJsonStrict('{"schemaVersion":1,"schemaVersion":2}'),
    /duplicate JSON key "schemaVersion"/,
  );
});

test("loadEvidenceFile rejects BOM and malformed UTF-8", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "release-a-evidence-"),
  );
  try {
    const bomPath = resolve(temporaryDirectory, "bom.json");
    await writeFile(
      bomPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("{}", "utf8"),
      ]),
    );
    await assert.rejects(() => loadEvidenceFile(bomPath), /UTF-8 without BOM/);

    const malformedPath = resolve(temporaryDirectory, "malformed.json");
    await writeFile(malformedPath, Buffer.from([0xc3, 0x28]));
    await assert.rejects(() => loadEvidenceFile(malformedPath), TypeError);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI fails closed for pending evidence and invalid invocation", () => {
  const scriptPath = resolve(SCRIPT_DIRECTORY, "verify-release-a-evidence.mjs");
  const templatePath = resolve(
    SCRIPT_DIRECTORY,
    "../docs/release-a-evidence.template.json",
  );
  const pending = spawnSync(process.execPath, [scriptPath, templatePath], {
    encoding: "utf8",
  });
  assert.equal(pending.status, 1);
  assert.match(pending.stderr, /FAIL Release A evidence/);

  const missingArgument = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
  });
  assert.equal(missingArgument.status, 2);
  assert.match(missingArgument.stderr, /Usage:/);
});

test("rejects a canary shorter than 24 hours or incomplete bucket coverage", () => {
  const evidence = makeValidEvidence();
  evidence.canary.endedAt = "2026-08-01T23:00:00.000Z";
  evidence.canary.declaredDurationHours = 23;
  evidence.canary.buckets[0].endedAt = "2026-08-01T23:00:00.000Z";
  const errors = errorsFor(evidence);
  assert.match(errors, /must be at least 24 hours/);
  assert.match(errors, /must cover exactly 24 hours/);
});

test("rejects hourly coverage gaps, duplicate hours, zero samples, and wrong SHAs", () => {
  const gapEvidence = makeValidEvidence();
  gapEvidence.canary.buckets[0].hourlyEvidence[5].startedAt =
    "2026-08-01T06:00:00.000Z";
  gapEvidence.canary.buckets[0].hourlyEvidence[5].endedAt =
    "2026-08-01T07:00:00.000Z";
  assert.match(
    errorsFor(gapEvidence),
    /must be contiguous with the prior completed UTC hour/,
  );

  const duplicateEvidence = makeValidEvidence();
  duplicateEvidence.canary.buckets[0].hourlyEvidence[1].startedAt =
    duplicateEvidence.canary.buckets[0].hourlyEvidence[0].startedAt;
  duplicateEvidence.canary.buckets[0].hourlyEvidence[1].endedAt =
    duplicateEvidence.canary.buckets[0].hourlyEvidence[0].endedAt;
  assert.match(
    errorsFor(duplicateEvidence),
    /must be unique within the 24-hour evidence set/,
  );

  const zeroEvidence = makeValidEvidence();
  zeroEvidence.canary.buckets[0].hourlyEvidence[0].sampleCount = 0;
  assert.match(
    errorsFor(zeroEvidence),
    /hourlyEvidence\[0\]\.sampleCount.*at least 1/,
  );

  const wrongShaEvidence = makeValidEvidence();
  wrongShaEvidence.canary.buckets[0].hourlyEvidence[0].buildSha =
    "fedcba9876543210fedcba9876543210fedcba98";
  assert.match(
    errorsFor(wrongShaEvidence),
    /hourlyEvidence\[0\]\.buildSha.*must match release commit/,
  );
});

test("rejects an untrimmed 25-row rolling view with a partial endpoint hour", () => {
  const evidence = makeValidEvidence();
  evidence.canary.buckets[0].hourlyEvidence.push({
    buildSha: RELEASE_SHA,
    startedAt: "2026-08-02T00:00:00.000Z",
    endedAt: "2026-08-02T00:30:00.000Z",
    sampleCount: 1,
    evidenceRef: evidenceRef("canary-partial-endpoint"),
  });
  const errors = errorsFor(evidence);
  assert.match(errors, /must contain exactly 24 completed contiguous UTC-hour/);
  assert.match(errors, /must cover exactly one completed hour/);
});

test("rejects any observed legacy physical delete", () => {
  const evidence = makeValidEvidence();
  evidence.canary.buckets[0].legacyPhysicalDeleteCount = 1;
  assert.match(errorsFor(evidence), /must be exactly 0/);
});

test("rejects a canary metric regression beyond baseline thresholds", () => {
  const evidence = makeValidEvidence();
  evidence.canary.buckets[0].conflictRate.observedNumerator = 3;
  evidence.canary.buckets[0].conflictRate.observedValue = 0.03;
  evidence.canary.buckets[0].conflictRate.maxRelativeRegressionPct = 100;
  const errors = errorsFor(evidence);
  assert.match(errors, /maxRelativeRegressionPct.*not an allowed field/);
  assert.match(errors, /baseline x 1.25/);
});

test("binds canary, dashboard, bucket, and baseline observations to commit SHAs", () => {
  const evidence = makeValidEvidence();
  const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
  evidence.canary.buildSha = otherSha;
  evidence.canary.metricsBackend.buildSha = otherSha;
  evidence.canary.buckets[0].buildSha = otherSha;
  evidence.canary.buckets[0].baselineBuildSha = RELEASE_SHA;
  const errors = errorsFor(evidence);
  assert.match(errors, /canary\.buildSha.*must match release commit/);
  assert.match(errors, /metricsBackend\.buildSha.*must match release commit/);
  assert.match(errors, /buckets\[0\]\.buildSha.*must match release commit/);
  assert.match(errors, /baselineBuildSha.*must match release commit 89abcdef/);
});

test("requires a prior non-overlapping baseline build and query window", () => {
  const evidence = makeValidEvidence();
  evidence.canary.baseline.buildSha = RELEASE_SHA;
  evidence.canary.baseline.endedAt = "2026-08-01T01:00:00.000Z";
  evidence.canary.baseline.declaredDurationHours = 25;
  evidence.canary.buckets[0].baselineBuildSha = RELEASE_SHA;
  const errors = errorsFor(evidence);
  assert.match(errors, /must identify a prior baseline build/);
  assert.match(errors, /must not overlap or follow the canary window/);
});

test("pins every bucket to one approved global baseline aggregate", () => {
  const evidence = makeValidEvidence();
  evidence.canary.buckets[0].conflictRate.baselineNumerator = 3;
  evidence.canary.buckets[0].conflictRate.baselineValue = 0.03;
  evidence.canary.buckets[0].startupP95Bucket.baselineCounts["lt-250ms"] = 69;
  evidence.canary.buckets[0].startupP95Bucket.baselineCounts["250-999ms"] = 26;
  const errors = errorsFor(evidence);
  assert.match(
    errors,
    /conflictRate\.baselineNumerator.*single approved global baseline/,
  );
  assert.match(
    errors,
    /startupP95Bucket\.baselineCounts\.lt-250ms.*single approved global baseline/,
  );
});

test("requires count-derived rates with adequate production-only samples", () => {
  const evidence = makeValidEvidence();
  evidence.canary.buckets[0].checkpointAdoptionRate.observedValue = 0.5;
  evidence.canary.buckets[0].fallbackRepairSuccessRate.observedDenominator = 1;
  evidence.canary.buckets[0].fallbackRepairSuccessRate.observedNumerator = 1;
  evidence.canary.buckets[0].fallbackRepairSuccessRate.observedValue = 1;
  const errors = errorsFor(evidence);
  assert.match(
    errors,
    /checkpointAdoptionRate\.observedValue.*observedNumerator \/ observedDenominator/,
  );
  assert.match(
    errors,
    /fallbackRepairSuccessRate\.observedDenominator.*at least 20/,
  );

  evidence.canary.buckets[0].checkpointAdoptionRate.observedValue = 0.96;
  evidence.canary.buckets[0].fallbackRepairSuccessRate.sampleBasis =
    "CONTROLLED_TRIAGE";
  assert.match(
    errorsFor(evidence),
    /fallbackRepairSuccessRate\.sampleBasis.*PRODUCTION/,
  );
});

test("uses fixed zero-baseline absolute caps for conflict and save failure", () => {
  const evidence = makeValidEvidence();
  evidence.canary.buckets[0].sampleCount = 1_000;
  evidence.canary.buckets[0].hourlyEvidence.forEach((hour, index) => {
    hour.sampleCount = index < 16 ? 42 : 41;
  });
  for (const metricName of ["conflictRate", "saveFailureRate"]) {
    const approvedBaseline = evidence.canary.baseline.metrics[metricName];
    approvedBaseline.numerator = 0;
    approvedBaseline.value = 0;
    const metric = evidence.canary.buckets[0][metricName];
    metric.baselineNumerator = 0;
    metric.baselineValue = 0;
    metric.observedNumerator = 1;
    metric.observedDenominator = 1_000;
    metric.observedValue = 0.001;
  }
  assert.deepEqual(validateReleaseAEvidence(evidence, { nowMs: NOW_MS }), []);

  evidence.canary.buckets[0].conflictRate.observedNumerator = 2;
  evidence.canary.buckets[0].conflictRate.observedValue = 0.002;
  assert.match(errorsFor(evidence), /fixed zero-baseline absolute cap 0\.001/);
});

test("computes startup p95 from telemetry buckets and permits no slower bucket", () => {
  const evidence = makeValidEvidence();
  const startup = evidence.canary.buckets[0].startupP95Bucket;
  startup.observedCounts["lt-250ms"] = 70;
  startup.observedCounts["250-999ms"] = 20;
  startup.observedCounts["1-2999ms"] = 10;
  startup.observedP95Bucket = "1-2999ms";
  assert.match(
    errorsFor(evidence),
    /must not be slower than baseline under fixed conservative bucket policy/,
  );

  startup.observedP95Bucket = "250-999ms";
  const mismatchErrors = errorsFor(evidence);
  assert.match(
    mismatchErrors,
    /must equal the p95 bucket computed from observedCounts \(1-2999ms\)/,
  );
});

test("rejects future canary and approval timestamps beyond five-minute skew", () => {
  const evidence = makeValidEvidence();
  const errors = validateReleaseAEvidence(evidence, {
    nowMs: Date.parse("2026-08-01T23:50:00.000Z"),
  }).join("\n");
  assert.match(
    errors,
    /canary\.endedAt.*must not be more than 5 minutes in the future/,
  );
  assert.match(
    errors,
    /approvals\.releaseOwner\.approvedAt.*must not be more than 5 minutes in the future/,
  );

  assert.deepEqual(
    validateReleaseAEvidence(makeValidEvidence(), {
      nowMs: Date.parse("2026-08-02T05:56:00.000Z"),
    }),
    [],
  );
});

test("rejects calendar-normalized impossible UTC dates", () => {
  const evidence = makeValidEvidence();
  evidence.release.sourceTreeCheckedAt = "2026-02-30T00:00:00.000Z";
  assert.match(
    errorsFor(evidence),
    /sourceTreeCheckedAt.*valid UTC ISO-8601 timestamp/,
  );
});

test("requires the exact automated encoding command", () => {
  const evidence = makeValidEvidence();
  evidence.automatedGates.encoding.command = "node scripts/verify-encoding.mjs";
  assert.match(
    errorsFor(evidence),
    /encoding\.command.*must be exactly "npm run test:encoding"/,
  );
});

test("rejects missing actual installed-PWA target and build/SW SHA mismatch", () => {
  const evidence = makeValidEvidence();
  evidence.installedPwaChecks[2] = pwaCheck(
    "WINDOWS_11",
    "CHROME",
    "duplicate",
  );
  evidence.installedPwaChecks[0].serviceWorkerSha =
    "fedcba9876543210fedcba9876543210fedcba98";
  const errors = errorsFor(evidence);
  assert.match(
    errors,
    /missing required actual installed-PWA target ANDROID\/CHROME/,
  );
  assert.match(errors, /buildSha and serviceWorkerSha must be identical/);
});

test("does not allow UNKNOWN to masquerade as NOT_DEPLOYED", () => {
  const evidence = makeValidEvidence();
  evidence.historicalDeploymentAudit.verdict = "NOT_DEPLOYED";
  evidence.historicalDeploymentAudit.safetyDisposition = "NOT_REQUIRED";
  const errors = errorsFor(evidence);
  assert.match(errors, /verdict.*must be UNKNOWN/);
  assert.match(errors, /safetyDisposition.*TREAT_AS_DEPLOYED/);
});

test("allows factual NOT_DEPLOYED only when every source is negative and complete", () => {
  const evidence = makeValidEvidence();
  for (const sourceName of [
    "gitRefs",
    "providerDeployments",
    "manualDeployments",
    "accessLogs",
  ]) {
    evidence.historicalDeploymentAudit[sourceName].finding = "NOT_FOUND";
  }
  evidence.historicalDeploymentAudit.externalRecordsComplete = true;
  evidence.historicalDeploymentAudit.verdict = "NOT_DEPLOYED";
  evidence.historicalDeploymentAudit.safetyDisposition = "NOT_REQUIRED";
  assert.deepEqual(validateReleaseAEvidence(evidence, { nowMs: NOW_MS }), []);
});

test("requires dedicated d2389a0 E2E PASS and independent approvals", () => {
  const evidence = makeValidEvidence();
  evidence.historicalDeploymentAudit.dedicatedE2e.status = "PENDING";
  evidence.approvals.operationsReviewer.approver =
    evidence.approvals.releaseOwner.approver;
  const errors = errorsFor(evidence);
  assert.match(errors, /dedicatedE2e\.status.*PASS/);
  assert.match(errors, /distinct across required approval roles/);
});

test("requires approvals after all gate evidence is complete", () => {
  const evidence = makeValidEvidence();
  evidence.approvals.releaseOwner.approvedAt = "2026-08-02T02:00:00.000Z";
  assert.match(errorsFor(evidence), /must not precede completion/);
});

test("includes source-clean and cleanup-off checks in approval prerequisites", () => {
  const evidence = makeValidEvidence();
  evidence.release.sourceTreeCheckedAt = "2026-08-02T07:00:00.000Z";
  evidence.release.cleanupCheckedAt = "2026-08-02T07:00:00.000Z";
  const errors = errorsFor(evidence);
  assert.match(errors, /sourceTreeCheckedAt.*must not follow the canary start/);
  assert.match(errors, /cleanupCheckedAt.*must not follow the canary start/);
  assert.match(
    errors,
    /approvals\.releaseOwner\.approvedAt.*must not precede completion/,
  );
});
