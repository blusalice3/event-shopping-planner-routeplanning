#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fail, projectRoot, readJson } from "./foundation-policy-utils.mjs";
import {
  formatRate,
  isCoverageSourcePath,
  mergeChangedLines,
  mergeCoverageRecords,
  parseLcov,
  parseUnifiedDiff,
  pathMatchesScope,
  summarizeChangedCoverage,
  summarizeCoverage,
} from "./coverage-policy/coverage-policy-lib.mjs";

const policy = await readJson("config/coverage-policy.json");
const packageJson = await readJson("package.json");
const errors = [];
const thresholdKeys = ["branches", "functions", "lines", "statements"];
const changedThresholdKeys = ["branches", "lines"];
const mandatorySubsystems = new Set([
  "artifact-reducer",
  "persistence-transactions",
  "pwa-recovery",
  "shopping-list-model-selector",
  "xlsx-protocol-security",
]);
const resultsRequested = process.argv.slice(2).includes("--results");
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--results");

const validateThresholds = (value, label, keys = thresholdKeys) => {
  for (const key of keys) {
    if (
      typeof value?.[key] !== "number" ||
      value[key] <= 0 ||
      value[key] > 100
    ) {
      errors.push(`${label}.${key}: must be a percentage above 0 through 100`);
    }
  }
};

const validatePathList = (value, label, { allowEmpty = false } = {}) => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push(`${label}: must be ${allowEmpty ? "an" : "a non-empty"} array`);
    return;
  }
  if (
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\\") ||
        path.isAbsolute(entry),
    )
  ) {
    errors.push(
      `${label}: entries must be non-empty repository-relative POSIX paths`,
    );
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${label}: duplicate entries are forbidden`);
  }
};

if (unexpectedArguments.length > 0) {
  errors.push(`unexpected arguments: ${unexpectedArguments.join(", ")}`);
}
if (policy.schemaVersion !== 2) {
  errors.push("coverage policy schemaVersion must be 2");
}
if (policy.provider !== "v8") {
  errors.push("coverage provider must be v8");
}
if (!policy.reporters?.includes("lcov")) {
  errors.push("coverage reporters must include lcov for changed-code checks");
}
validatePathList(policy.include, "include");
validatePathList(policy.exclude, "exclude");
validateThresholds(policy.globalThresholds, "globalThresholds");
validateThresholds(
  policy.changedCodeThresholds,
  "changedCodeThresholds",
  changedThresholdKeys,
);
if (
  policy.changedCodeThresholds.lines < policy.globalThresholds.lines ||
  policy.changedCodeThresholds.branches < policy.globalThresholds.branches
) {
  errors.push("changed-code thresholds must not be below global thresholds");
}

if (!Array.isArray(policy.subsystemThresholds)) {
  errors.push("subsystemThresholds must be an array");
}
const subsystemIds = new Set();
for (const subsystem of policy.subsystemThresholds ?? []) {
  if (typeof subsystem.id !== "string" || subsystem.id.length === 0) {
    errors.push("every subsystem must have an id");
    continue;
  }
  if (subsystemIds.has(subsystem.id)) {
    errors.push(`${subsystem.id}: duplicate subsystem id`);
  }
  subsystemIds.add(subsystem.id);
  validateThresholds(subsystem, `subsystemThresholds.${subsystem.id}`);
  validateThresholds(
    subsystem.changedCodeThresholds,
    `subsystemThresholds.${subsystem.id}.changedCodeThresholds`,
    changedThresholdKeys,
  );
  for (const key of changedThresholdKeys) {
    if (
      subsystem.changedCodeThresholds?.[key] < policy.changedCodeThresholds[key]
    ) {
      errors.push(
        `${subsystem.id}: changed ${key} threshold must be at least the policy floor`,
      );
    }
  }
  validatePathList(subsystem.vitestGlobs, `${subsystem.id}.vitestGlobs`, {
    allowEmpty: true,
  });
  validatePathList(
    subsystem.changedScope?.prefixes,
    `${subsystem.id}.changedScope.prefixes`,
    { allowEmpty: true },
  );
  validatePathList(
    subsystem.changedScope?.files,
    `${subsystem.id}.changedScope.files`,
    { allowEmpty: true },
  );
  if (
    (subsystem.changedScope?.prefixes?.length ?? 0) +
      (subsystem.changedScope?.files?.length ?? 0) ===
    0
  ) {
    errors.push(`${subsystem.id}: changedScope must not be empty`);
  }
  if (
    subsystem.vitestGlobs.length === 0 &&
    subsystem.nodeCoverage === undefined
  ) {
    errors.push(`${subsystem.id}: no coverage engine is configured`);
  }
  if (
    typeof subsystem.requiredFromExit !== "string" ||
    subsystem.requiredFromExit.length === 0
  ) {
    errors.push(`${subsystem.id}: requiredFromExit is required`);
  }

  if (subsystem.nodeCoverage !== undefined) {
    const nodeCoverage = subsystem.nodeCoverage;
    validatePathList(
      nodeCoverage.include,
      `${subsystem.id}.nodeCoverage.include`,
    );
    validatePathList(nodeCoverage.tests, `${subsystem.id}.nodeCoverage.tests`);
    validateThresholds(nodeCoverage, `${subsystem.id}.nodeCoverage`, [
      "branches",
      "functions",
      "lines",
    ]);
    if (
      typeof nodeCoverage.report !== "string" ||
      !nodeCoverage.report.startsWith(`${policy.reportsDirectory}/node/`) ||
      !nodeCoverage.report.endsWith(".lcov") ||
      nodeCoverage.report.includes("\\")
    ) {
      errors.push(
        `${subsystem.id}: Node LCOV report must be inside ${policy.reportsDirectory}/node`,
      );
    }
    const scopeFiles = new Set(subsystem.changedScope.files);
    for (const include of nodeCoverage.include) {
      if (!scopeFiles.has(include)) {
        errors.push(
          `${subsystem.id}: Node include ${include} is absent from changedScope.files`,
        );
      }
    }
  }
}

for (const mandatorySubsystem of mandatorySubsystems) {
  if (!subsystemIds.has(mandatorySubsystem)) {
    errors.push(`${mandatorySubsystem}: mandatory subsystem floor is missing`);
  }
}
for (const collection of ["exceptions", "waivers", "futureSubsystems"]) {
  if (!Array.isArray(policy[collection]) || policy[collection].length !== 0) {
    errors.push(`${collection} must be present and empty`);
  }
}

if (packageJson.devDependencies?.["@vitest/coverage-v8"] !== "4.1.10") {
  errors.push("@vitest/coverage-v8 must be pinned to 4.1.10");
}
if (
  packageJson.scripts?.["test:coverage"] !==
  "node scripts/coverage-policy/run-coverage-policy.mjs"
) {
  errors.push(
    "test:coverage must run the complete cross-engine coverage policy",
  );
}
if (
  packageJson.scripts?.["test:coverage-policy"] !==
  "node --test scripts/coverage-policy/coverage-policy.test.mjs"
) {
  errors.push("test:coverage-policy must run the coverage policy unit tests");
}

const [configSource, workflowSource] = await Promise.all([
  readFile(path.resolve(projectRoot, "vitest.config.ts"), "utf8"),
  readFile(
    path.resolve(projectRoot, ".github", "workflows", "quality.yml"),
    "utf8",
  ),
]);
if (
  !configSource.includes("config/coverage-policy.json") ||
  !configSource.includes("vitestGlobs")
) {
  errors.push("vitest.config.ts must consume active subsystem coverage globs");
}
if (
  !workflowSource.includes("fetch-depth: 0") ||
  !workflowSource.includes("COVERAGE_BASE_REF:") ||
  !workflowSource.includes("npm run test:coverage-policy")
) {
  errors.push(
    "quality workflow must fetch history and run policy tests with COVERAGE_BASE_REF",
  );
}

const runGit = (args) => {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
};

const readCoverageReport = async (relativePath) => {
  const bytes = await readFile(path.resolve(projectRoot, relativePath));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

const readChangedLines = async () => {
  const requestedBase = process.env.COVERAGE_BASE_REF?.trim();
  const usableBase =
    requestedBase !== undefined &&
    requestedBase.length > 0 &&
    !/^0+$/u.test(requestedBase);
  let diff;
  let comparison;

  if (usableBase) {
    runGit(["rev-parse", "--verify", `${requestedBase}^{commit}`]);
    comparison = `${requestedBase}...HEAD`;
    diff = runGit([
      "diff",
      "--no-prefix",
      "--unified=0",
      "--no-ext-diff",
      "--diff-filter=ACMR",
      comparison,
      "--",
    ]);
  } else {
    const localStatus = runGit([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (localStatus.trim().length > 0) {
      comparison = "HEAD + working tree";
      diff = runGit([
        "diff",
        "--no-prefix",
        "--unified=0",
        "--no-ext-diff",
        "--diff-filter=ACMR",
        "HEAD",
        "--",
      ]);
    } else {
      comparison = "HEAD^...HEAD";
      diff = runGit([
        "diff",
        "--no-prefix",
        "--unified=0",
        "--no-ext-diff",
        "--diff-filter=ACMR",
        comparison,
        "--",
      ]);
    }
  }

  const trackedChanges = parseUnifiedDiff(diff);
  const untrackedChanges = new Map();
  if (comparison === "HEAD + working tree") {
    const untracked = runGit(["ls-files", "--others", "--exclude-standard"])
      .split(/\r?\n/u)
      .filter(
        (filePath) =>
          filePath.length > 0 &&
          isCoverageSourcePath(filePath) &&
          policy.subsystemThresholds.some((subsystem) =>
            pathMatchesScope(filePath, subsystem.changedScope),
          ),
      );
    for (const filePath of untracked) {
      const source = await readFile(
        path.resolve(projectRoot, filePath),
        "utf8",
      );
      const lineCount =
        source.length === 0
          ? 0
          : (source.match(/\n/gu)?.length ?? 0) +
            (source.endsWith("\n") ? 0 : 1);
      untrackedChanges.set(
        filePath,
        new Set(
          Array.from({ length: lineCount }, (_value, index) => index + 1),
        ),
      );
    }
  }

  return {
    changedLines: mergeChangedLines(trackedChanges, untrackedChanges),
    comparison,
  };
};

if (errors.length === 0 && resultsRequested) {
  try {
    const reportPaths = [
      `${policy.reportsDirectory}/lcov.info`,
      ...policy.subsystemThresholds
        .filter((subsystem) => subsystem.nodeCoverage !== undefined)
        .map((subsystem) => subsystem.nodeCoverage.report),
    ];
    const reportSources = await Promise.all(
      reportPaths.map((reportPath) => readCoverageReport(reportPath)),
    );
    const coverage = mergeCoverageRecords(
      ...reportSources.map((source) => parseLcov(source, projectRoot)),
    );
    const { changedLines, comparison } = await readChangedLines();
    process.stdout.write(`Changed-code comparison: ${comparison}\n`);

    for (const subsystem of policy.subsystemThresholds) {
      const total = summarizeCoverage(coverage, subsystem.changedScope);
      if (total.files.length === 0) {
        errors.push(`${subsystem.id}: no scoped files found in LCOV reports`);
      }
      for (const key of ["branches", "functions", "lines"]) {
        if (
          total[key].rate !== undefined &&
          total[key].rate + Number.EPSILON < subsystem[key]
        ) {
          errors.push(
            `${subsystem.id}: total ${key} ${formatRate(total[key])} is below ${subsystem[key]}%`,
          );
        }
      }

      const changed = summarizeChangedCoverage(
        coverage,
        changedLines,
        subsystem.changedScope,
      );
      for (const missingFile of changed.missingFiles) {
        errors.push(
          `${subsystem.id}: changed source is missing from LCOV: ${missingFile}`,
        );
      }
      for (const key of changedThresholdKeys) {
        if (
          changed[key].rate !== undefined &&
          changed[key].rate + Number.EPSILON <
            subsystem.changedCodeThresholds[key]
        ) {
          errors.push(
            `${subsystem.id}: changed ${key} ${formatRate(changed[key])} is below ${subsystem.changedCodeThresholds[key]}%`,
          );
        }
      }
      process.stdout.write(
        `${subsystem.id}: total lines ${formatRate(total.lines)}, branches ${formatRate(total.branches)}; changed lines ${formatRate(changed.lines)}, branches ${formatRate(changed.branches)} across ${changed.changedFiles.length} file(s)\n`,
      );
    }
  } catch (error) {
    errors.push(
      `coverage result verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

if (errors.length > 0) {
  fail("FAIL coverage policy verification", errors);
} else if (resultsRequested) {
  process.stdout.write(
    `PASS generated coverage and changed-code floors for ${policy.subsystemThresholds.length} subsystems\n`,
  );
} else {
  process.stdout.write(
    `PASS coverage policy: global ${policy.globalThresholds.lines}% lines / ${policy.globalThresholds.branches}% branches; ${policy.subsystemThresholds.length} active subsystem floors; 0 exceptions/waivers/future placeholders\n`,
  );
}
