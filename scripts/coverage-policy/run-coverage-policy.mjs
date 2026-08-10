#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { projectRoot, readJson } from "../foundation-policy-utils.mjs";

const policy = await readJson("config/coverage-policy.json");
const packageJson = await readJson("package.json");

if (process.versions.node !== packageJson.engines.node) {
  throw new Error(
    `Coverage requires Node ${packageJson.engines.node}; received ${process.versions.node}.`,
  );
}

const run = (label, executable, args) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(executable, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const verifier = path.resolve(
  projectRoot,
  "scripts",
  "verify-coverage-policy.mjs",
);
run("Coverage policy contract", process.execPath, [verifier]);

const coverageRoot = path.resolve(projectRoot, policy.reportsDirectory);
if (
  coverageRoot === path.parse(coverageRoot).root ||
  path.dirname(coverageRoot) !== projectRoot
) {
  throw new Error(`Refusing unsafe coverage output path: ${coverageRoot}`);
}
await rm(coverageRoot, { force: true, recursive: true });
await mkdir(path.join(coverageRoot, "node"), { recursive: true });

const vitestEntry = path.resolve(
  projectRoot,
  "node_modules",
  "vitest",
  "vitest.mjs",
);
run("Vitest complete project coverage", process.execPath, [
  vitestEntry,
  "run",
  "--coverage",
]);

for (const subsystem of policy.subsystemThresholds) {
  if (subsystem.nodeCoverage === undefined) continue;
  const nodeCoverage = subsystem.nodeCoverage;
  const report = path.resolve(projectRoot, nodeCoverage.report);
  await mkdir(path.dirname(report), { recursive: true });
  run(`${subsystem.id} Node coverage`, process.execPath, [
    "--experimental-test-coverage",
    "--test",
    ...nodeCoverage.include.map(
      (include) => `--test-coverage-include=${include}`,
    ),
    `--test-coverage-branches=${nodeCoverage.branches}`,
    `--test-coverage-functions=${nodeCoverage.functions}`,
    `--test-coverage-lines=${nodeCoverage.lines}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${report}`,
    ...nodeCoverage.tests,
  ]);
}

run("Generated and changed-code coverage", process.execPath, [
  verifier,
  "--results",
]);
