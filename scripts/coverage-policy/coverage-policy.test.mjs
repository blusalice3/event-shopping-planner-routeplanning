import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeChangedLines,
  mergeCoverageRecords,
  parseLcov,
  parseUnifiedDiff,
  summarizeChangedCoverage,
  summarizeCoverage,
} from "./coverage-policy-lib.mjs";

const projectRoot = "C:/work/repository";

test("parses and merges LCOV without double-counting repeated reports", () => {
  const first = parseLcov(
    [
      "SF:C:\\work\\repository\\src\\pwa\\recovery.ts",
      "FN:2,recover",
      "FNDA:1,recover",
      "BRDA:3,0,0,0",
      "DA:2,1",
      "DA:3,0",
      "end_of_record",
      "",
    ].join("\n"),
    projectRoot,
  );
  const second = parseLcov(
    [
      "SF:src/pwa/recovery.ts",
      "FN:2,recover",
      "FNDA:2,recover",
      "BRDA:3,0,0,1",
      "DA:2,2",
      "DA:3,1",
      "end_of_record",
      "",
    ].join("\n"),
    projectRoot,
  );

  const summary = summarizeCoverage(mergeCoverageRecords(first, second), {
    files: [],
    prefixes: ["src/pwa/"],
  });
  assert.equal(summary.files.length, 1);
  assert.equal(summary.lines.total, 2);
  assert.equal(summary.lines.covered, 2);
  assert.equal(summary.branches.covered, 1);
  assert.equal(summary.functions.covered, 1);
});

test("maps zero-context diff hunks to executable changed lines and branches", () => {
  const changes = parseUnifiedDiff(
    [
      "diff --git a/src/xlsx/security/preflight.ts b/src/xlsx/security/preflight.ts",
      "--- a/src/xlsx/security/preflight.ts",
      "+++ b/src/xlsx/security/preflight.ts",
      "@@ -9,0 +10,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n"),
  );
  const records = parseLcov(
    [
      "SF:src/xlsx/security/preflight.ts",
      "BRDA:11,0,0,0",
      "DA:10,1",
      "DA:11,0",
      "end_of_record",
      "",
    ].join("\n"),
    projectRoot,
  );

  const summary = summarizeChangedCoverage(records, changes, {
    files: [],
    prefixes: ["src/xlsx/security/"],
  });
  assert.deepEqual(summary.changedFiles, ["src/xlsx/security/preflight.ts"]);
  assert.equal(summary.lines.rate, 50);
  assert.equal(summary.branches.rate, 0);
});

test("reports scoped changed source that is absent from every coverage report", () => {
  const changes = mergeChangedLines(
    new Map([["scripts/release-state/reducer.mjs", new Set([1, 2])]]),
    new Map([["scripts/release-state/reducer.mjs", new Set([2, 3])]]),
  );
  const summary = summarizeChangedCoverage(new Map(), changes, {
    files: ["scripts/release-state/reducer.mjs"],
    prefixes: [],
  });

  assert.deepEqual(summary.missingFiles, ["scripts/release-state/reducer.mjs"]);
});
