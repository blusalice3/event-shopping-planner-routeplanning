#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "release-a-evidence/v1";
const BASELINE_POLICY = "release-a-baseline-policy/v1";
const BASELINE_DEFINITION =
  "previous-production-build-matched-cohort-complete-24h/v1";
const D2389A0_SHA = "d2389a02363176ba8354c4562f1a669a0b15dab9";
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MIN_PRODUCTION_METRIC_DENOMINATOR = 20;
const MAX_STARTUP_P95_BUCKET_REGRESSION_STEPS = 0;
const HOUR_MS = 60 * 60 * 1_000;
const COMPLETED_HOURS_PER_CANARY_BUCKET = 24;
const FULL_SHA = /^[0-9a-f]{40}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PENDING_VALUE = /^(?:pending|todo|tbd|replace_me)$/i;
const FORBIDDEN_KEY_PARTS = ["payload", "raw", "storage", "revision", "digest"];
const PASS = "PASS";
const EPSILON = 1e-9;

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "release",
  "canary",
  "installedPwaChecks",
  "automatedGates",
  "historicalDeploymentAudit",
  "approvals",
];

const RELEASE_KEYS = [
  "releaseId",
  "commitSha",
  "sourceTreeClean",
  "sourceTreeCheckedAt",
  "sourceTreeEvidenceRef",
  "cleanupMode",
  "cleanupCheckedAt",
  "cleanupEvidenceRef",
];

const CANARY_KEYS = [
  "buildSha",
  "baselinePolicy",
  "baseline",
  "startedAt",
  "endedAt",
  "declaredDurationHours",
  "cohortRef",
  "metricsBackend",
  "buckets",
];

const BASELINE_KEYS = [
  "definition",
  "buildSha",
  "startedAt",
  "endedAt",
  "declaredDurationHours",
  "cohortRef",
  "queryEvidenceRef",
  "selectedBy",
  "selectedAt",
  "reviewedBy",
  "reviewedAt",
  "selectionApprovalRef",
  "metrics",
];

const BASELINE_METRICS_KEYS = [
  "checkpointAdoptionRate",
  "fallbackRepairSuccessRate",
  "conflictRate",
  "saveFailureRate",
  "startupP95Bucket",
];

const BASELINE_RATE_KEYS = ["numerator", "denominator", "value", "evidenceRef"];

const BASELINE_STARTUP_P95_KEYS = ["counts", "p95Bucket", "evidenceRef"];

const METRICS_BACKEND_KEYS = [
  "buildSha",
  "backendName",
  "environment",
  "probeStatus",
  "probedAt",
  "probeEvidenceRef",
  "dashboardRef",
];

const BUCKET_KEYS = [
  "buildSha",
  "baselineBuildSha",
  "startedAt",
  "endedAt",
  "sampleCount",
  "legacyPhysicalDeleteCount",
  "checkpointAdoptionRate",
  "fallbackRepairSuccessRate",
  "conflictRate",
  "saveFailureRate",
  "startupP95Bucket",
  "hourlyEvidence",
  "evidenceRef",
];

const HOURLY_EVIDENCE_KEYS = [
  "buildSha",
  "startedAt",
  "endedAt",
  "sampleCount",
  "evidenceRef",
];

const COMPARISON_KEYS = [
  "baselineNumerator",
  "baselineDenominator",
  "baselineValue",
  "observedNumerator",
  "observedDenominator",
  "observedValue",
  "sampleBasis",
  "evidenceRef",
];

const STARTUP_P95_KEYS = [
  "baselineCounts",
  "baselineP95Bucket",
  "observedCounts",
  "observedP95Bucket",
  "sampleBasis",
  "evidenceRef",
];

const STARTUP_DURATION_BUCKETS = [
  "lt-250ms",
  "250-999ms",
  "1-2999ms",
  "3-9999ms",
  "gte-10s",
];

const PWA_KEYS = [
  "os",
  "osVersion",
  "browser",
  "browserVersion",
  "installMode",
  "buildSha",
  "serviceWorkerSha",
  "onlineStatus",
  "offlineStatus",
  "updateStatus",
  "legacyOriginalsUnchanged",
  "executedBy",
  "executedAt",
  "reviewedBy",
  "reviewedAt",
  "evidenceRef",
];

const AUTOMATED_GATE_NAMES = [
  "test",
  "lint",
  "typecheck",
  "build",
  "format",
  "encoding",
  "browserPreflight",
  "rollback",
];

const AUTOMATED_GATE_KEYS = [
  "status",
  "command",
  "commitSha",
  "completedAt",
  "evidenceRef",
];

const EXPECTED_COMMANDS = {
  test: "npm run test:run",
  lint: "npm run lint",
  typecheck: "npm run typecheck",
  build: "npm run build:release-a",
  format: "npm run format:check",
  encoding: "npm run test:encoding",
  browserPreflight: "npm run test:release-a-browser",
  rollback: "npm run test:release-a-rollback",
};

const HISTORICAL_AUDIT_KEYS = [
  "targetCommitSha",
  "gitRefs",
  "providerDeployments",
  "manualDeployments",
  "accessLogs",
  "externalRecordsComplete",
  "verdict",
  "safetyDisposition",
  "auditedBy",
  "auditedAt",
  "reviewedBy",
  "reviewedAt",
  "reviewEvidenceRef",
  "dedicatedE2e",
];

const AUDIT_SOURCE_KEYS = ["finding", "checkedAt", "evidenceRef"];
const AUDIT_FINDINGS = ["FOUND", "NOT_FOUND", "INCONCLUSIVE"];
const AUDIT_SOURCE_NAMES = [
  "gitRefs",
  "providerDeployments",
  "manualDeployments",
  "accessLogs",
];

const DEDICATED_E2E_KEYS = [
  "status",
  "scenario",
  "releaseCommitSha",
  "completedAt",
  "evidenceRef",
];

const APPROVAL_ROLES = [
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
];

const APPROVAL_KEYS = [
  "decision",
  "approver",
  "approvedAt",
  "commitSha",
  "evidenceRef",
];

const REQUIRED_PWA_TARGETS = [
  "WINDOWS_11/CHROME",
  "WINDOWS_11/EDGE",
  "ANDROID/CHROME",
];

const METRIC_RULES = {
  checkpointAdoptionRate: {
    direction: "HIGHER_IS_BETTER",
    maximumRegressionFactor: 1.25,
    zeroBaselineAbsoluteCap: null,
  },
  fallbackRepairSuccessRate: {
    direction: "HIGHER_IS_BETTER",
    maximumRegressionFactor: 1.25,
    zeroBaselineAbsoluteCap: null,
  },
  conflictRate: {
    direction: "LOWER_IS_BETTER",
    maximumRegressionFactor: 1.25,
    zeroBaselineAbsoluteCap: 0.001,
  },
  saveFailureRate: {
    direction: "LOWER_IS_BETTER",
    maximumRegressionFactor: 1.25,
    zeroBaselineAbsoluteCap: 0.001,
  },
};

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateExactObject(value, path, expectedKeys, errors) {
  if (!isRecord(value)) {
    addError(errors, path, "must be an object");
    return false;
  }

  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      addError(errors, `${path}.${key}`, "is required");
    }
  }

  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      addError(errors, `${path}.${key}`, "is not an allowed field");
    }
  }

  return true;
}

function validateForbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateForbiddenKeys(entry, `${path}[${index}]`, errors),
    );
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    const forbidden = FORBIDDEN_KEY_PARTS.find((part) =>
      normalized.includes(part),
    );
    if (forbidden) {
      addError(
        errors,
        `${path}.${key}`,
        `field names containing "${forbidden}" are forbidden`,
      );
    }
    validateForbiddenKeys(entry, `${path}.${key}`, errors);
  }
}

function validateNoFutureTimestamps(value, path, errors, nowMs) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateNoFutureTimestamps(entry, `${path}[${index}]`, errors, nowMs),
    );
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (
      key.endsWith("At") &&
      typeof entry === "string" &&
      parseStrictUtcTimestamp(entry) !== undefined
    ) {
      const timestamp = parseStrictUtcTimestamp(entry);
      if (timestamp > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
        addError(
          errors,
          entryPath,
          "must not be more than 5 minutes in the future",
        );
      }
    }
    validateNoFutureTimestamps(entry, entryPath, errors, nowMs);
  }
}

function validateMeaningfulString(value, path, errors, maxLength = 160) {
  if (typeof value !== "string") {
    addError(errors, path, "must be a string");
    return false;
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    PENDING_VALUE.test(trimmed)
  ) {
    addError(
      errors,
      path,
      `must be a completed non-placeholder string of at most ${maxLength} characters`,
    );
    return false;
  }

  if (
    [...trimmed].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    addError(errors, path, "must not contain control characters");
    return false;
  }

  return true;
}

function validateEnum(value, path, allowed, errors) {
  if (!allowed.includes(value)) {
    addError(errors, path, `must be one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

function validateBoolean(value, path, errors) {
  if (typeof value !== "boolean") {
    addError(errors, path, "must be a boolean");
    return false;
  }
  return true;
}

function validateNumber(value, path, errors, { min = 0, max } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addError(errors, path, "must be a finite number");
    return false;
  }
  if (value < min) {
    addError(errors, path, `must be at least ${min}`);
    return false;
  }
  if (max !== undefined && value > max) {
    addError(errors, path, `must be at most ${max}`);
    return false;
  }
  return true;
}

function validateInteger(value, path, errors, { min = 0 } = {}) {
  if (!Number.isInteger(value)) {
    addError(errors, path, "must be an integer");
    return false;
  }
  if (value < min) {
    addError(errors, path, `must be at least ${min}`);
    return false;
  }
  return true;
}

function validateSha(value, path, errors, expected) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    addError(errors, path, "must be a lowercase full 40-character commit SHA");
    return false;
  }
  if (expected !== undefined && value !== expected) {
    addError(errors, path, `must match release commit ${expected}`);
    return false;
  }
  return true;
}

function parseStrictUtcTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const normalizedInput = value.includes(".")
    ? value
    : value.replace("Z", ".000Z");
  return new Date(timestamp).toISOString() === normalizedInput
    ? timestamp
    : undefined;
}

function validateTimestamp(value, path, errors) {
  const timestamp = parseStrictUtcTimestamp(value);
  if (timestamp === undefined) {
    addError(errors, path, "must be a valid UTC ISO-8601 timestamp");
    return undefined;
  }
  return timestamp;
}

function validateEvidenceRef(value, path, errors) {
  if (!validateMeaningfulString(value, path, errors, 512)) {
    return false;
  }

  if (/^https:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        addError(
          errors,
          path,
          "HTTPS evidence references must not contain credentials, query data, or fragments",
        );
        return false;
      }
      return true;
    } catch {
      addError(errors, path, "must be a valid HTTPS evidence reference");
      return false;
    }
  }

  if (
    !/^(?:artifact|run|dashboard|ticket):\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/.test(
      value,
    )
  ) {
    addError(
      errors,
      path,
      "must be a non-inline HTTPS, artifact://, run://, dashboard://, or ticket:// reference",
    );
    return false;
  }

  return true;
}

function validateRelease(release, errors) {
  if (!validateExactObject(release, "$.release", RELEASE_KEYS, errors)) {
    return undefined;
  }

  validateMeaningfulString(
    release.releaseId,
    "$.release.releaseId",
    errors,
    80,
  );
  const shaValid = validateSha(
    release.commitSha,
    "$.release.commitSha",
    errors,
  );
  if (
    validateBoolean(
      release.sourceTreeClean,
      "$.release.sourceTreeClean",
      errors,
    )
  ) {
    if (!release.sourceTreeClean) {
      addError(
        errors,
        "$.release.sourceTreeClean",
        "must be true for an exact-source release",
      );
    }
  }
  const sourceTreeCheckedAt = validateTimestamp(
    release.sourceTreeCheckedAt,
    "$.release.sourceTreeCheckedAt",
    errors,
  );
  validateEvidenceRef(
    release.sourceTreeEvidenceRef,
    "$.release.sourceTreeEvidenceRef",
    errors,
  );
  validateEnum(
    release.cleanupMode,
    "$.release.cleanupMode",
    ["FORCED_OFF"],
    errors,
  );
  const cleanupCheckedAt = validateTimestamp(
    release.cleanupCheckedAt,
    "$.release.cleanupCheckedAt",
    errors,
  );
  validateEvidenceRef(
    release.cleanupEvidenceRef,
    "$.release.cleanupEvidenceRef",
    errors,
  );

  return {
    commitSha: shaValid ? release.commitSha : undefined,
    sourceTreeCheckedAt,
    cleanupCheckedAt,
  };
}

function validateComparison(
  value,
  path,
  rule,
  bucketSampleCount,
  approvedBaseline,
  errors,
) {
  if (!validateExactObject(value, path, COMPARISON_KEYS, errors)) {
    return;
  }

  const baselineNumeratorValid = validateInteger(
    value.baselineNumerator,
    `${path}.baselineNumerator`,
    errors,
  );
  const baselineDenominatorValid = validateInteger(
    value.baselineDenominator,
    `${path}.baselineDenominator`,
    errors,
    { min: MIN_PRODUCTION_METRIC_DENOMINATOR },
  );
  const observedNumeratorValid = validateInteger(
    value.observedNumerator,
    `${path}.observedNumerator`,
    errors,
  );
  const sampleBasisValid = validateEnum(
    value.sampleBasis,
    `${path}.sampleBasis`,
    ["PRODUCTION"],
    errors,
  );
  const observedDenominatorValid = validateInteger(
    value.observedDenominator,
    `${path}.observedDenominator`,
    errors,
    { min: MIN_PRODUCTION_METRIC_DENOMINATOR },
  );
  const baselineValid = validateNumber(
    value.baselineValue,
    `${path}.baselineValue`,
    errors,
    { min: 0, max: 1 },
  );
  const observedValid = validateNumber(
    value.observedValue,
    `${path}.observedValue`,
    errors,
    { min: 0, max: 1 },
  );
  validateEvidenceRef(value.evidenceRef, `${path}.evidenceRef`, errors);

  if (
    !baselineNumeratorValid ||
    !baselineDenominatorValid ||
    !observedNumeratorValid ||
    !observedDenominatorValid ||
    !sampleBasisValid ||
    !baselineValid ||
    !observedValid
  ) {
    return;
  }

  if (value.baselineNumerator > value.baselineDenominator) {
    addError(
      errors,
      `${path}.baselineNumerator`,
      "must not exceed baselineDenominator",
    );
  }
  if (value.observedNumerator > value.observedDenominator) {
    addError(
      errors,
      `${path}.observedNumerator`,
      "must not exceed observedDenominator",
    );
  }
  if (
    Number.isInteger(bucketSampleCount) &&
    value.observedDenominator > bucketSampleCount
  ) {
    addError(
      errors,
      `${path}.observedDenominator`,
      "must not exceed the bucket telemetry sampleCount",
    );
  }

  const computedBaseline = value.baselineNumerator / value.baselineDenominator;
  if (Math.abs(value.baselineValue - computedBaseline) > EPSILON) {
    addError(
      errors,
      `${path}.baselineValue`,
      `must equal baselineNumerator / baselineDenominator (${computedBaseline})`,
    );
  }
  const computedObserved = value.observedNumerator / value.observedDenominator;
  if (Math.abs(value.observedValue - computedObserved) > EPSILON) {
    addError(
      errors,
      `${path}.observedValue`,
      `must equal observedNumerator / observedDenominator (${computedObserved})`,
    );
  }

  if (
    value.baselineNumerator > value.baselineDenominator ||
    value.observedNumerator > value.observedDenominator ||
    Math.abs(value.baselineValue - computedBaseline) > EPSILON ||
    Math.abs(value.observedValue - computedObserved) > EPSILON
  ) {
    return;
  }

  let baselineMatches = true;
  if (approvedBaseline !== undefined) {
    for (const [field, expected] of [
      ["baselineNumerator", approvedBaseline.numerator],
      ["baselineDenominator", approvedBaseline.denominator],
      ["baselineValue", approvedBaseline.value],
    ]) {
      if (value[field] !== expected) {
        addError(
          errors,
          `${path}.${field}`,
          `must match the single approved global baseline value ${expected}`,
        );
        baselineMatches = false;
      }
    }
  }
  if (!baselineMatches) {
    return;
  }

  if (value.baselineValue === 0) {
    if (rule.zeroBaselineAbsoluteCap === null) {
      addError(
        errors,
        `${path}.baselineValue`,
        `must be greater than zero under fixed policy ${BASELINE_POLICY}`,
      );
      return;
    }
    if (value.observedValue > rule.zeroBaselineAbsoluteCap + EPSILON) {
      addError(
        errors,
        `${path}.observedValue`,
        `exceeds fixed zero-baseline absolute cap ${rule.zeroBaselineAbsoluteCap} under ${BASELINE_POLICY}`,
      );
    }
    return;
  }

  if (rule.direction === "HIGHER_IS_BETTER") {
    const minimumObserved = value.baselineValue / rule.maximumRegressionFactor;
    if (value.observedValue + EPSILON < minimumObserved) {
      addError(
        errors,
        `${path}.observedValue`,
        `must be at least ${minimumObserved} (baseline / ${rule.maximumRegressionFactor}) under ${BASELINE_POLICY}`,
      );
    }
    return;
  }

  const maximumObserved = value.baselineValue * rule.maximumRegressionFactor;
  if (value.observedValue > maximumObserved + EPSILON) {
    addError(
      errors,
      `${path}.observedValue`,
      `must be at most ${maximumObserved} (baseline x ${rule.maximumRegressionFactor}) under ${BASELINE_POLICY}`,
    );
  }
}

function validateStartupBucketCounts(value, path, errors, minimumSampleCount) {
  if (!validateExactObject(value, path, STARTUP_DURATION_BUCKETS, errors)) {
    return undefined;
  }

  let total = 0;
  let valid = true;
  for (const bucketName of STARTUP_DURATION_BUCKETS) {
    if (!validateInteger(value[bucketName], `${path}.${bucketName}`, errors)) {
      valid = false;
      continue;
    }
    total += value[bucketName];
  }
  if (!valid) {
    return undefined;
  }
  if (total < minimumSampleCount) {
    addError(
      errors,
      path,
      `must total at least ${minimumSampleCount} startup observations`,
    );
  }
  return total;
}

function calculateP95Bucket(value, total) {
  const rank = Math.ceil(total * 0.95);
  let cumulative = 0;
  for (const bucketName of STARTUP_DURATION_BUCKETS) {
    cumulative += value[bucketName];
    if (cumulative >= rank) {
      return bucketName;
    }
  }
  return undefined;
}

function validateStartupP95Bucket(
  value,
  path,
  bucketSampleCount,
  approvedBaseline,
  errors,
) {
  if (!validateExactObject(value, path, STARTUP_P95_KEYS, errors)) {
    return;
  }

  const sampleBasisValid = validateEnum(
    value.sampleBasis,
    `${path}.sampleBasis`,
    ["PRODUCTION"],
    errors,
  );
  const observedMinimum = MIN_PRODUCTION_METRIC_DENOMINATOR;
  const baselineTotal = validateStartupBucketCounts(
    value.baselineCounts,
    `${path}.baselineCounts`,
    errors,
    MIN_PRODUCTION_METRIC_DENOMINATOR,
  );
  const observedTotal = validateStartupBucketCounts(
    value.observedCounts,
    `${path}.observedCounts`,
    errors,
    observedMinimum,
  );
  const baselineBucketValid = validateEnum(
    value.baselineP95Bucket,
    `${path}.baselineP95Bucket`,
    STARTUP_DURATION_BUCKETS,
    errors,
  );
  const observedBucketValid = validateEnum(
    value.observedP95Bucket,
    `${path}.observedP95Bucket`,
    STARTUP_DURATION_BUCKETS,
    errors,
  );
  validateEvidenceRef(value.evidenceRef, `${path}.evidenceRef`, errors);

  if (
    Number.isInteger(bucketSampleCount) &&
    observedTotal !== undefined &&
    observedTotal > bucketSampleCount
  ) {
    addError(
      errors,
      `${path}.observedCounts`,
      "must not total more than the bucket telemetry sampleCount",
    );
  }

  if (
    !sampleBasisValid ||
    baselineTotal === undefined ||
    observedTotal === undefined ||
    !baselineBucketValid ||
    !observedBucketValid ||
    baselineTotal < MIN_PRODUCTION_METRIC_DENOMINATOR ||
    observedTotal < observedMinimum
  ) {
    return;
  }

  let baselineMatches = true;
  if (approvedBaseline !== undefined) {
    for (const bucketName of STARTUP_DURATION_BUCKETS) {
      if (
        value.baselineCounts[bucketName] !== approvedBaseline.counts[bucketName]
      ) {
        addError(
          errors,
          `${path}.baselineCounts.${bucketName}`,
          "must match the single approved global baseline counts",
        );
        baselineMatches = false;
      }
    }
    if (value.baselineP95Bucket !== approvedBaseline.p95Bucket) {
      addError(
        errors,
        `${path}.baselineP95Bucket`,
        `must match the approved global baseline bucket ${approvedBaseline.p95Bucket}`,
      );
      baselineMatches = false;
    }
  }
  if (!baselineMatches) {
    return;
  }

  const computedBaseline = calculateP95Bucket(
    value.baselineCounts,
    baselineTotal,
  );
  const computedObserved = calculateP95Bucket(
    value.observedCounts,
    observedTotal,
  );
  if (value.baselineP95Bucket !== computedBaseline) {
    addError(
      errors,
      `${path}.baselineP95Bucket`,
      `must equal the p95 bucket computed from baselineCounts (${computedBaseline})`,
    );
  }
  if (value.observedP95Bucket !== computedObserved) {
    addError(
      errors,
      `${path}.observedP95Bucket`,
      `must equal the p95 bucket computed from observedCounts (${computedObserved})`,
    );
  }
  if (
    value.baselineP95Bucket !== computedBaseline ||
    value.observedP95Bucket !== computedObserved
  ) {
    return;
  }

  const baselineIndex = STARTUP_DURATION_BUCKETS.indexOf(computedBaseline);
  const observedIndex = STARTUP_DURATION_BUCKETS.indexOf(computedObserved);
  if (observedIndex > baselineIndex + MAX_STARTUP_P95_BUCKET_REGRESSION_STEPS) {
    addError(
      errors,
      `${path}.observedP95Bucket`,
      `must not be slower than baseline under fixed conservative bucket policy ${BASELINE_POLICY}`,
    );
  }
}

function validateMetricsBackend(
  value,
  releaseSha,
  errors,
  canaryStart,
  canaryEnd,
) {
  const path = "$.canary.metricsBackend";
  if (!validateExactObject(value, path, METRICS_BACKEND_KEYS, errors)) {
    return;
  }

  validateSha(value.buildSha, `${path}.buildSha`, errors, releaseSha);
  validateMeaningfulString(
    value.backendName,
    `${path}.backendName`,
    errors,
    80,
  );
  validateEnum(
    value.environment,
    `${path}.environment`,
    ["PRODUCTION"],
    errors,
  );
  validateEnum(value.probeStatus, `${path}.probeStatus`, [PASS], errors);
  const probedAt = validateTimestamp(
    value.probedAt,
    `${path}.probedAt`,
    errors,
  );
  validateEvidenceRef(
    value.probeEvidenceRef,
    `${path}.probeEvidenceRef`,
    errors,
  );
  validateEvidenceRef(value.dashboardRef, `${path}.dashboardRef`, errors);

  if (
    probedAt !== undefined &&
    canaryStart !== undefined &&
    canaryEnd !== undefined &&
    (probedAt < canaryStart || probedAt > canaryEnd)
  ) {
    addError(
      errors,
      `${path}.probedAt`,
      "must fall within the canary observation window",
    );
  }
}

function validateBaselineRate(value, path, errors) {
  if (!validateExactObject(value, path, BASELINE_RATE_KEYS, errors)) {
    return undefined;
  }

  const numeratorValid = validateInteger(
    value.numerator,
    `${path}.numerator`,
    errors,
  );
  const denominatorValid = validateInteger(
    value.denominator,
    `${path}.denominator`,
    errors,
    { min: MIN_PRODUCTION_METRIC_DENOMINATOR },
  );
  const valueValid = validateNumber(value.value, `${path}.value`, errors, {
    min: 0,
    max: 1,
  });
  validateEvidenceRef(value.evidenceRef, `${path}.evidenceRef`, errors);

  if (!numeratorValid || !denominatorValid || !valueValid) {
    return undefined;
  }
  if (value.numerator > value.denominator) {
    addError(errors, `${path}.numerator`, "must not exceed denominator");
    return undefined;
  }
  const computed = value.numerator / value.denominator;
  if (Math.abs(value.value - computed) > EPSILON) {
    addError(
      errors,
      `${path}.value`,
      `must equal numerator / denominator (${computed})`,
    );
    return undefined;
  }
  return {
    numerator: value.numerator,
    denominator: value.denominator,
    value: value.value,
  };
}

function validateBaselineStartupP95(value, path, errors) {
  if (!validateExactObject(value, path, BASELINE_STARTUP_P95_KEYS, errors)) {
    return undefined;
  }

  const total = validateStartupBucketCounts(
    value.counts,
    `${path}.counts`,
    errors,
    MIN_PRODUCTION_METRIC_DENOMINATOR,
  );
  const bucketValid = validateEnum(
    value.p95Bucket,
    `${path}.p95Bucket`,
    STARTUP_DURATION_BUCKETS,
    errors,
  );
  validateEvidenceRef(value.evidenceRef, `${path}.evidenceRef`, errors);
  if (
    total === undefined ||
    total < MIN_PRODUCTION_METRIC_DENOMINATOR ||
    !bucketValid
  ) {
    return undefined;
  }

  const computed = calculateP95Bucket(value.counts, total);
  if (value.p95Bucket !== computed) {
    addError(
      errors,
      `${path}.p95Bucket`,
      `must equal the p95 bucket computed from counts (${computed})`,
    );
    return undefined;
  }
  return {
    counts: value.counts,
    p95Bucket: value.p95Bucket,
  };
}

function validateBaselineMetrics(value, path, errors) {
  if (!validateExactObject(value, path, BASELINE_METRICS_KEYS, errors)) {
    return undefined;
  }

  const metrics = Object.create(null);
  for (const metricName of BASELINE_METRICS_KEYS.slice(0, 4)) {
    metrics[metricName] = validateBaselineRate(
      value[metricName],
      `${path}.${metricName}`,
      errors,
    );
  }
  metrics.startupP95Bucket = validateBaselineStartupP95(
    value.startupP95Bucket,
    `${path}.startupP95Bucket`,
    errors,
  );
  return metrics;
}

function validateBaseline(baseline, releaseSha, canaryStart, errors) {
  const path = "$.canary.baseline";
  if (!validateExactObject(baseline, path, BASELINE_KEYS, errors)) {
    return undefined;
  }

  validateEnum(
    baseline.definition,
    `${path}.definition`,
    [BASELINE_DEFINITION],
    errors,
  );
  const shaValid = validateSha(baseline.buildSha, `${path}.buildSha`, errors);
  if (
    shaValid &&
    releaseSha !== undefined &&
    baseline.buildSha === releaseSha
  ) {
    addError(
      errors,
      `${path}.buildSha`,
      "must identify a prior baseline build, not the Release A commit",
    );
  }

  const start = validateTimestamp(
    baseline.startedAt,
    `${path}.startedAt`,
    errors,
  );
  const end = validateTimestamp(baseline.endedAt, `${path}.endedAt`, errors);
  const durationValid = validateNumber(
    baseline.declaredDurationHours,
    `${path}.declaredDurationHours`,
    errors,
    { min: 24 },
  );
  validateEvidenceRef(baseline.cohortRef, `${path}.cohortRef`, errors);
  validateEvidenceRef(
    baseline.queryEvidenceRef,
    `${path}.queryEvidenceRef`,
    errors,
  );
  validateMeaningfulString(
    baseline.selectedBy,
    `${path}.selectedBy`,
    errors,
    120,
  );
  const selectedAt = validateTimestamp(
    baseline.selectedAt,
    `${path}.selectedAt`,
    errors,
  );
  validateMeaningfulString(
    baseline.reviewedBy,
    `${path}.reviewedBy`,
    errors,
    120,
  );
  const reviewedAt = validateTimestamp(
    baseline.reviewedAt,
    `${path}.reviewedAt`,
    errors,
  );
  validateEvidenceRef(
    baseline.selectionApprovalRef,
    `${path}.selectionApprovalRef`,
    errors,
  );
  const metrics = validateBaselineMetrics(
    baseline.metrics,
    `${path}.metrics`,
    errors,
  );
  if (start !== undefined && end !== undefined) {
    const durationHours = (end - start) / 3_600_000;
    if (durationHours !== 24) {
      addError(
        errors,
        path,
        "must cover exactly one complete 24-hour approved baseline window",
      );
    }
    if (
      durationValid &&
      Math.abs(durationHours - baseline.declaredDurationHours) > EPSILON
    ) {
      addError(
        errors,
        `${path}.declaredDurationHours`,
        `must equal the timestamp duration (${durationHours} hours)`,
      );
    }
    if (canaryStart !== undefined && end > canaryStart) {
      addError(
        errors,
        `${path}.endedAt`,
        "must not overlap or follow the canary window",
      );
    }
    if (selectedAt !== undefined && selectedAt < end) {
      addError(
        errors,
        `${path}.selectedAt`,
        "must not precede completion of the baseline window",
      );
    }
  }
  if (
    selectedAt !== undefined &&
    reviewedAt !== undefined &&
    reviewedAt < selectedAt
  ) {
    addError(errors, `${path}.reviewedAt`, "must not precede selectedAt");
  }
  if (
    reviewedAt !== undefined &&
    canaryStart !== undefined &&
    reviewedAt > canaryStart
  ) {
    addError(
      errors,
      `${path}.reviewedAt`,
      "must be approved before the canary window starts",
    );
  }

  return {
    buildSha: shaValid ? baseline.buildSha : undefined,
    metrics,
    reviewedAt,
  };
}

function validateHourlyEvidence(
  hourlyEvidence,
  path,
  releaseSha,
  bucketStart,
  bucketEnd,
  bucketSampleCount,
  errors,
) {
  if (!Array.isArray(hourlyEvidence)) {
    addError(errors, path, "must be an array");
    return;
  }
  if (hourlyEvidence.length !== COMPLETED_HOURS_PER_CANARY_BUCKET) {
    addError(
      errors,
      path,
      `must contain exactly ${COMPLETED_HOURS_PER_CANARY_BUCKET} completed contiguous UTC-hour entries; exclude partial rolling-view endpoints`,
    );
  }

  const starts = new Set();
  let priorEnd = bucketStart;
  let totalSamples = 0;
  let samplesValid = true;

  hourlyEvidence.forEach((hour, index) => {
    const hourPath = `${path}[${index}]`;
    if (!validateExactObject(hour, hourPath, HOURLY_EVIDENCE_KEYS, errors)) {
      samplesValid = false;
      return;
    }

    validateSha(hour.buildSha, `${hourPath}.buildSha`, errors, releaseSha);
    const start = validateTimestamp(
      hour.startedAt,
      `${hourPath}.startedAt`,
      errors,
    );
    const end = validateTimestamp(hour.endedAt, `${hourPath}.endedAt`, errors);
    if (start !== undefined && end !== undefined) {
      if (end - start !== HOUR_MS) {
        addError(errors, hourPath, "must cover exactly one completed hour");
      }
      if (start % HOUR_MS !== 0 || end % HOUR_MS !== 0) {
        addError(
          errors,
          hourPath,
          "must use full UTC-hour boundaries with zero minutes and seconds",
        );
      }
      if (starts.has(start)) {
        addError(
          errors,
          `${hourPath}.startedAt`,
          "must be unique within the 24-hour evidence set",
        );
      }
      starts.add(start);
      if (priorEnd !== undefined && start !== priorEnd) {
        addError(
          errors,
          `${hourPath}.startedAt`,
          "must be contiguous with the prior completed UTC hour",
        );
      }
      priorEnd = end;
      if (
        bucketStart !== undefined &&
        bucketEnd !== undefined &&
        (start < bucketStart || end > bucketEnd)
      ) {
        addError(
          errors,
          hourPath,
          "must be inside its complete 24-hour canary bucket",
        );
      }
    }

    if (
      validateInteger(hour.sampleCount, `${hourPath}.sampleCount`, errors, {
        min: 1,
      })
    ) {
      totalSamples += hour.sampleCount;
    } else {
      samplesValid = false;
    }
    validateEvidenceRef(hour.evidenceRef, `${hourPath}.evidenceRef`, errors);
  });

  if (
    bucketEnd !== undefined &&
    priorEnd !== undefined &&
    priorEnd !== bucketEnd
  ) {
    addError(
      errors,
      path,
      "completed hourly evidence must end at the 24-hour bucket boundary",
    );
  }
  if (
    samplesValid &&
    Number.isInteger(bucketSampleCount) &&
    totalSamples !== bucketSampleCount
  ) {
    addError(
      errors,
      path,
      `hourly sample total ${totalSamples} must equal bucket sampleCount ${bucketSampleCount}`,
    );
  }
}

function validateCanary(canary, releaseSha, errors) {
  if (!validateExactObject(canary, "$.canary", CANARY_KEYS, errors)) {
    return undefined;
  }

  validateSha(canary.buildSha, "$.canary.buildSha", errors, releaseSha);
  validateEnum(
    canary.baselinePolicy,
    "$.canary.baselinePolicy",
    [BASELINE_POLICY],
    errors,
  );
  const start = validateTimestamp(
    canary.startedAt,
    "$.canary.startedAt",
    errors,
  );
  const end = validateTimestamp(canary.endedAt, "$.canary.endedAt", errors);
  const baselineResult = validateBaseline(
    canary.baseline,
    releaseSha,
    start,
    errors,
  );
  const durationValid = validateNumber(
    canary.declaredDurationHours,
    "$.canary.declaredDurationHours",
    errors,
    { min: 24 },
  );
  validateEvidenceRef(canary.cohortRef, "$.canary.cohortRef", errors);
  validateMetricsBackend(canary.metricsBackend, releaseSha, errors, start, end);

  let computedDuration;
  if (start !== undefined && end !== undefined) {
    computedDuration = (end - start) / 3_600_000;
    if (computedDuration < 24) {
      addError(
        errors,
        "$.canary",
        "the canary observation window must be at least 24 hours",
      );
    }
    if (
      durationValid &&
      Math.abs(computedDuration - canary.declaredDurationHours) > EPSILON
    ) {
      addError(
        errors,
        "$.canary.declaredDurationHours",
        `must equal the timestamp duration (${computedDuration} hours)`,
      );
    }
  }

  if (!Array.isArray(canary.buckets)) {
    addError(errors, "$.canary.buckets", "must be an array");
    return {
      start,
      end,
      baselineReviewedAt: baselineResult?.reviewedAt,
    };
  }
  if (canary.buckets.length === 0) {
    addError(
      errors,
      "$.canary.buckets",
      "must contain at least one complete 24-hour bucket",
    );
    return {
      start,
      end,
      baselineReviewedAt: baselineResult?.reviewedAt,
    };
  }

  let priorEnd = start;
  let bucketHours = 0;
  canary.buckets.forEach((bucket, index) => {
    const path = `$.canary.buckets[${index}]`;
    if (!validateExactObject(bucket, path, BUCKET_KEYS, errors)) {
      return;
    }

    validateSha(bucket.buildSha, `${path}.buildSha`, errors, releaseSha);
    validateSha(
      bucket.baselineBuildSha,
      `${path}.baselineBuildSha`,
      errors,
      baselineResult?.buildSha,
    );
    const bucketStart = validateTimestamp(
      bucket.startedAt,
      `${path}.startedAt`,
      errors,
    );
    const bucketEnd = validateTimestamp(
      bucket.endedAt,
      `${path}.endedAt`,
      errors,
    );

    if (bucketStart !== undefined && bucketEnd !== undefined) {
      const hours = (bucketEnd - bucketStart) / 3_600_000;
      bucketHours += hours;
      if (Math.abs(hours - 24) > EPSILON) {
        addError(errors, path, "must cover exactly 24 hours");
      }
      if (priorEnd !== undefined && bucketStart !== priorEnd) {
        addError(
          errors,
          `${path}.startedAt`,
          "must be contiguous with the prior canary boundary",
        );
      }
      priorEnd = bucketEnd;
      if (
        start !== undefined &&
        end !== undefined &&
        (bucketStart < start || bucketEnd > end)
      ) {
        addError(errors, path, "must be inside the canary observation window");
      }
    }

    validateInteger(bucket.sampleCount, `${path}.sampleCount`, errors, {
      min: 1,
    });
    if (
      validateInteger(
        bucket.legacyPhysicalDeleteCount,
        `${path}.legacyPhysicalDeleteCount`,
        errors,
      ) &&
      bucket.legacyPhysicalDeleteCount !== 0
    ) {
      addError(
        errors,
        `${path}.legacyPhysicalDeleteCount`,
        "must be exactly 0; any legacy physical delete stops Release A",
      );
    }
    validateHourlyEvidence(
      bucket.hourlyEvidence,
      `${path}.hourlyEvidence`,
      releaseSha,
      bucketStart,
      bucketEnd,
      bucket.sampleCount,
      errors,
    );

    Object.entries(METRIC_RULES).forEach(([metricName, rule]) => {
      validateComparison(
        bucket[metricName],
        `${path}.${metricName}`,
        rule,
        bucket.sampleCount,
        baselineResult?.metrics?.[metricName],
        errors,
      );
    });
    validateStartupP95Bucket(
      bucket.startupP95Bucket,
      `${path}.startupP95Bucket`,
      bucket.sampleCount,
      baselineResult?.metrics?.startupP95Bucket,
      errors,
    );
    validateEvidenceRef(bucket.evidenceRef, `${path}.evidenceRef`, errors);
  });

  if (end !== undefined && priorEnd !== undefined && priorEnd !== end) {
    addError(
      errors,
      "$.canary.buckets",
      "complete 24-hour buckets must cover the entire canary window",
    );
  }
  if (
    computedDuration !== undefined &&
    Math.abs(bucketHours - computedDuration) > EPSILON
  ) {
    addError(
      errors,
      "$.canary.buckets",
      `bucket coverage ${bucketHours} hours does not equal canary duration ${computedDuration} hours`,
    );
  }

  return {
    start,
    end,
    baselineReviewedAt: baselineResult?.reviewedAt,
  };
}

function validateInstalledPwaChecks(checks, releaseSha, errors) {
  if (!Array.isArray(checks)) {
    addError(errors, "$.installedPwaChecks", "must be an array");
    return [];
  }
  if (checks.length !== REQUIRED_PWA_TARGETS.length) {
    addError(
      errors,
      "$.installedPwaChecks",
      `must contain exactly ${REQUIRED_PWA_TARGETS.length} required device/browser checks`,
    );
  }

  const foundTargets = new Set();
  const completionTimes = [];
  checks.forEach((check, index) => {
    const path = `$.installedPwaChecks[${index}]`;
    if (!validateExactObject(check, path, PWA_KEYS, errors)) {
      return;
    }

    validateEnum(check.os, `${path}.os`, ["WINDOWS_11", "ANDROID"], errors);
    validateMeaningfulString(check.osVersion, `${path}.osVersion`, errors, 80);
    validateEnum(check.browser, `${path}.browser`, ["CHROME", "EDGE"], errors);
    validateMeaningfulString(
      check.browserVersion,
      `${path}.browserVersion`,
      errors,
      80,
    );
    validateEnum(
      check.installMode,
      `${path}.installMode`,
      ["ACTUAL_INSTALLED_PWA"],
      errors,
    );
    validateSha(check.buildSha, `${path}.buildSha`, errors, releaseSha);
    validateSha(
      check.serviceWorkerSha,
      `${path}.serviceWorkerSha`,
      errors,
      releaseSha,
    );
    if (
      typeof check.buildSha === "string" &&
      typeof check.serviceWorkerSha === "string" &&
      check.buildSha !== check.serviceWorkerSha
    ) {
      addError(errors, path, "buildSha and serviceWorkerSha must be identical");
    }
    validateEnum(check.onlineStatus, `${path}.onlineStatus`, [PASS], errors);
    validateEnum(check.offlineStatus, `${path}.offlineStatus`, [PASS], errors);
    validateEnum(check.updateStatus, `${path}.updateStatus`, [PASS], errors);
    if (
      validateBoolean(
        check.legacyOriginalsUnchanged,
        `${path}.legacyOriginalsUnchanged`,
        errors,
      ) &&
      !check.legacyOriginalsUnchanged
    ) {
      addError(errors, `${path}.legacyOriginalsUnchanged`, "must be true");
    }
    validateMeaningfulString(
      check.executedBy,
      `${path}.executedBy`,
      errors,
      120,
    );
    const executedAt = validateTimestamp(
      check.executedAt,
      `${path}.executedAt`,
      errors,
    );
    validateMeaningfulString(
      check.reviewedBy,
      `${path}.reviewedBy`,
      errors,
      120,
    );
    const reviewedAt = validateTimestamp(
      check.reviewedAt,
      `${path}.reviewedAt`,
      errors,
    );
    validateEvidenceRef(check.evidenceRef, `${path}.evidenceRef`, errors);

    if (
      executedAt !== undefined &&
      reviewedAt !== undefined &&
      reviewedAt < executedAt
    ) {
      addError(errors, `${path}.reviewedAt`, "must not precede executedAt");
    }
    if (reviewedAt !== undefined) {
      completionTimes.push(reviewedAt);
    }

    const target = `${check.os}/${check.browser}`;
    if (foundTargets.has(target)) {
      addError(errors, path, `duplicates required target ${target}`);
    }
    foundTargets.add(target);
  });

  for (const target of REQUIRED_PWA_TARGETS) {
    if (!foundTargets.has(target)) {
      addError(
        errors,
        "$.installedPwaChecks",
        `missing required actual installed-PWA target ${target}`,
      );
    }
  }
  for (const target of foundTargets) {
    if (!REQUIRED_PWA_TARGETS.includes(target)) {
      addError(
        errors,
        "$.installedPwaChecks",
        `unexpected device/browser target ${target}`,
      );
    }
  }

  return completionTimes;
}

function validateAutomatedGates(gates, releaseSha, errors) {
  if (
    !validateExactObject(
      gates,
      "$.automatedGates",
      AUTOMATED_GATE_NAMES,
      errors,
    )
  ) {
    return [];
  }

  const completionTimes = [];
  for (const gateName of AUTOMATED_GATE_NAMES) {
    const gate = gates[gateName];
    const path = `$.automatedGates.${gateName}`;
    if (!validateExactObject(gate, path, AUTOMATED_GATE_KEYS, errors)) {
      continue;
    }

    validateEnum(gate.status, `${path}.status`, [PASS], errors);
    if (
      validateMeaningfulString(gate.command, `${path}.command`, errors, 240)
    ) {
      const expected = EXPECTED_COMMANDS[gateName];
      if (expected !== undefined && gate.command !== expected) {
        addError(errors, `${path}.command`, `must be exactly "${expected}"`);
      }
    }
    validateSha(gate.commitSha, `${path}.commitSha`, errors, releaseSha);
    const completedAt = validateTimestamp(
      gate.completedAt,
      `${path}.completedAt`,
      errors,
    );
    if (completedAt !== undefined) {
      completionTimes.push(completedAt);
    }
    validateEvidenceRef(gate.evidenceRef, `${path}.evidenceRef`, errors);
  }

  return completionTimes;
}

function deriveAuditVerdict(sources, externalRecordsComplete) {
  const findings = sources.map((source) => source?.finding);
  if (findings.some((finding) => finding === "FOUND")) {
    return "DEPLOYED";
  }
  if (
    findings.every((finding) => finding === "NOT_FOUND") &&
    externalRecordsComplete === true
  ) {
    return "NOT_DEPLOYED";
  }
  return "UNKNOWN";
}

function validateHistoricalDeploymentAudit(audit, releaseSha, errors) {
  const path = "$.historicalDeploymentAudit";
  if (!validateExactObject(audit, path, HISTORICAL_AUDIT_KEYS, errors)) {
    return undefined;
  }

  validateSha(
    audit.targetCommitSha,
    `${path}.targetCommitSha`,
    errors,
    D2389A0_SHA,
  );

  const sources = [];
  const sourceCheckTimes = [];
  for (const sourceName of AUDIT_SOURCE_NAMES) {
    const source = audit[sourceName];
    const sourcePath = `${path}.${sourceName}`;
    sources.push(source);
    if (!validateExactObject(source, sourcePath, AUDIT_SOURCE_KEYS, errors)) {
      continue;
    }
    validateEnum(
      source.finding,
      `${sourcePath}.finding`,
      AUDIT_FINDINGS,
      errors,
    );
    const checkedAt = validateTimestamp(
      source.checkedAt,
      `${sourcePath}.checkedAt`,
      errors,
    );
    if (checkedAt !== undefined) {
      sourceCheckTimes.push(checkedAt);
    }
    validateEvidenceRef(
      source.evidenceRef,
      `${sourcePath}.evidenceRef`,
      errors,
    );
  }

  validateBoolean(
    audit.externalRecordsComplete,
    `${path}.externalRecordsComplete`,
    errors,
  );
  validateEnum(
    audit.verdict,
    `${path}.verdict`,
    ["NOT_DEPLOYED", "DEPLOYED", "UNKNOWN"],
    errors,
  );
  const expectedVerdict = deriveAuditVerdict(
    sources,
    audit.externalRecordsComplete,
  );
  if (audit.verdict !== expectedVerdict) {
    addError(
      errors,
      `${path}.verdict`,
      `must be ${expectedVerdict} for the recorded findings and completeness`,
    );
  }

  const expectedDisposition =
    expectedVerdict === "NOT_DEPLOYED" ? "NOT_REQUIRED" : "TREAT_AS_DEPLOYED";
  validateEnum(
    audit.safetyDisposition,
    `${path}.safetyDisposition`,
    [expectedDisposition],
    errors,
  );
  validateMeaningfulString(audit.auditedBy, `${path}.auditedBy`, errors, 120);
  const auditedAt = validateTimestamp(
    audit.auditedAt,
    `${path}.auditedAt`,
    errors,
  );
  validateMeaningfulString(audit.reviewedBy, `${path}.reviewedBy`, errors, 120);
  const reviewedAt = validateTimestamp(
    audit.reviewedAt,
    `${path}.reviewedAt`,
    errors,
  );
  validateEvidenceRef(
    audit.reviewEvidenceRef,
    `${path}.reviewEvidenceRef`,
    errors,
  );

  if (
    auditedAt !== undefined &&
    sourceCheckTimes.some((checkedAt) => checkedAt > auditedAt)
  ) {
    addError(errors, `${path}.auditedAt`, "must not precede any source check");
  }
  if (
    auditedAt !== undefined &&
    reviewedAt !== undefined &&
    reviewedAt < auditedAt
  ) {
    addError(errors, `${path}.reviewedAt`, "must not precede auditedAt");
  }

  const e2e = audit.dedicatedE2e;
  const e2ePath = `${path}.dedicatedE2e`;
  if (validateExactObject(e2e, e2ePath, DEDICATED_E2E_KEYS, errors)) {
    validateEnum(e2e.status, `${e2ePath}.status`, [PASS], errors);
    validateEnum(
      e2e.scenario,
      `${e2ePath}.scenario`,
      ["DETECT_EXPORT_EXPLICIT_ADOPT"],
      errors,
    );
    validateSha(
      e2e.releaseCommitSha,
      `${e2ePath}.releaseCommitSha`,
      errors,
      releaseSha,
    );
    const completedAt = validateTimestamp(
      e2e.completedAt,
      `${e2ePath}.completedAt`,
      errors,
    );
    validateEvidenceRef(e2e.evidenceRef, `${e2ePath}.evidenceRef`, errors);
    if (
      completedAt !== undefined &&
      reviewedAt !== undefined &&
      completedAt > reviewedAt
    ) {
      addError(
        errors,
        `${path}.reviewedAt`,
        "must not precede the dedicated d2389a0 E2E completion",
      );
    }
  }

  return reviewedAt;
}

function validateApprovals(
  approvals,
  releaseSha,
  prerequisiteCompletionTimes,
  errors,
) {
  if (!validateExactObject(approvals, "$.approvals", APPROVAL_ROLES, errors)) {
    return;
  }

  const latestPrerequisite =
    prerequisiteCompletionTimes.length === 0
      ? undefined
      : Math.max(...prerequisiteCompletionTimes);

  for (const role of APPROVAL_ROLES) {
    const approval = approvals[role];
    const path = `$.approvals.${role}`;
    if (!validateExactObject(approval, path, APPROVAL_KEYS, errors)) {
      continue;
    }

    validateEnum(approval.decision, `${path}.decision`, ["APPROVED"], errors);
    validateMeaningfulString(
      approval.approver,
      `${path}.approver`,
      errors,
      120,
    );
    const approvedAt = validateTimestamp(
      approval.approvedAt,
      `${path}.approvedAt`,
      errors,
    );
    validateSha(approval.commitSha, `${path}.commitSha`, errors, releaseSha);
    validateEvidenceRef(approval.evidenceRef, `${path}.evidenceRef`, errors);

    if (
      approvedAt !== undefined &&
      latestPrerequisite !== undefined &&
      approvedAt < latestPrerequisite
    ) {
      addError(
        errors,
        `${path}.approvedAt`,
        "must not precede completion of any required gate evidence",
      );
    }
  }
}

export function validateReleaseAEvidence(
  evidence,
  { nowMs = Date.now() } = {},
) {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch-millisecond number");
  }

  const errors = [];
  validateForbiddenKeys(evidence, "$", errors);
  validateNoFutureTimestamps(evidence, "$", errors, nowMs);
  if (!validateExactObject(evidence, "$", TOP_LEVEL_KEYS, errors)) {
    return errors;
  }

  validateEnum(
    evidence.schemaVersion,
    "$.schemaVersion",
    [SCHEMA_VERSION],
    errors,
  );
  const releaseResult = validateRelease(evidence.release, errors);
  const releaseSha = releaseResult?.commitSha;
  const canaryResult = validateCanary(evidence.canary, releaseSha, errors);
  for (const [path, checkedAt] of [
    ["$.release.sourceTreeCheckedAt", releaseResult?.sourceTreeCheckedAt],
    ["$.release.cleanupCheckedAt", releaseResult?.cleanupCheckedAt],
  ]) {
    if (
      checkedAt !== undefined &&
      canaryResult?.start !== undefined &&
      checkedAt > canaryResult.start
    ) {
      addError(errors, path, "must not follow the canary start");
    }
  }
  const pwaCompletionTimes = validateInstalledPwaChecks(
    evidence.installedPwaChecks,
    releaseSha,
    errors,
  );
  const automatedCompletionTimes = validateAutomatedGates(
    evidence.automatedGates,
    releaseSha,
    errors,
  );
  const auditCompletionTime = validateHistoricalDeploymentAudit(
    evidence.historicalDeploymentAudit,
    releaseSha,
    errors,
  );

  const prerequisiteCompletionTimes = [
    releaseResult?.sourceTreeCheckedAt,
    releaseResult?.cleanupCheckedAt,
    canaryResult?.baselineReviewedAt,
    canaryResult?.end,
    auditCompletionTime,
    ...pwaCompletionTimes,
    ...automatedCompletionTimes,
  ].filter((value) => value !== undefined);
  validateApprovals(
    evidence.approvals,
    releaseSha,
    prerequisiteCompletionTimes,
    errors,
  );

  return errors;
}

function syntaxError(text, index, message) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - lastNewline;
  return new SyntaxError(`${message} at line ${line}, column ${column}`);
}

export function parseJsonStrict(text) {
  let index = 0;

  function skipWhitespace() {
    while (/[\t\n\r ]/.test(text[index] ?? "")) {
      index += 1;
    }
  }

  function parseString() {
    if (text[index] !== '"') {
      throw syntaxError(text, index, "expected a JSON string");
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) {
          throw syntaxError(text, index, "unterminated JSON escape");
        }
        if (text[index] === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw syntaxError(text, index, "invalid JSON unicode escape");
          }
          index += 5;
        } else {
          if (!/["\\/bfnrt]/.test(text[index])) {
            throw syntaxError(text, index, "invalid JSON escape");
          }
          index += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        throw syntaxError(text, index, "unescaped control character");
      }
      index += 1;
    }
    throw syntaxError(text, index, "unterminated JSON string");
  }

  function parseNumber() {
    const match = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      throw syntaxError(text, index, "invalid JSON number");
    }
    index += match[0].length;
    return Number(match[0]);
  }

  function parseArray() {
    const result = [];
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(parseValue());
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        throw syntaxError(text, index, "expected ',' or ']'");
      }
      index += 1;
      skipWhitespace();
    }
    throw syntaxError(text, index, "unterminated JSON array");
  }

  function parseObject() {
    const result = Object.create(null);
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      const key = parseString();
      if (keys.has(key)) {
        throw syntaxError(text, index, `duplicate JSON key "${key}"`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") {
        throw syntaxError(text, index, "expected ':'");
      }
      index += 1;
      skipWhitespace();
      result[key] = parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        throw syntaxError(text, index, "expected ',' or '}'");
      }
      index += 1;
      skipWhitespace();
    }
    throw syntaxError(text, index, "unterminated JSON object");
  }

  function parseValue() {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      return parseObject();
    }
    if (character === "[") {
      return parseArray();
    }
    if (character === '"') {
      return parseString();
    }
    if (character === "-" || /\d/.test(character ?? "")) {
      return parseNumber();
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    throw syntaxError(text, index, "unexpected JSON token");
  }

  const result = parseValue();
  skipWhitespace();
  if (index !== text.length) {
    throw syntaxError(text, index, "unexpected content after JSON value");
  }
  return result;
}

export async function loadEvidenceFile(filePath) {
  const bytes = await readFile(filePath);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new Error("evidence JSON must be UTF-8 without BOM");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  return parseJsonStrict(decoder.decode(bytes));
}

export function formatValidationErrors(errors) {
  return errors.map((error) => `- ${error}`).join("\n");
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath || process.argv.length !== 3) {
    console.error(
      "Usage: node scripts/verify-release-a-evidence.mjs <release-a-evidence.json>",
    );
    process.exitCode = 2;
    return;
  }

  const resolvedPath = resolve(filePath);
  try {
    const evidence = await loadEvidenceFile(resolvedPath);
    const errors = validateReleaseAEvidence(evidence);
    if (errors.length > 0) {
      console.error(`FAIL Release A evidence: ${resolvedPath}`);
      console.error(formatValidationErrors(errors));
      process.exitCode = 1;
      return;
    }
    console.log(`PASS Release A evidence: ${resolvedPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL Release A evidence: ${resolvedPath}`);
    console.error(`- ${message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  await main();
}

export const releaseAEvidenceConstants = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  baselinePolicy: BASELINE_POLICY,
  d2389a0Sha: D2389A0_SHA,
  maxFutureClockSkewMs: MAX_FUTURE_CLOCK_SKEW_MS,
  minProductionMetricDenominator: MIN_PRODUCTION_METRIC_DENOMINATOR,
  maxStartupP95BucketRegressionSteps: MAX_STARTUP_P95_BUCKET_REGRESSION_STEPS,
});
