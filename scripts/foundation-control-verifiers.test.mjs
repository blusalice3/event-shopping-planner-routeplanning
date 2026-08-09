import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (...arguments_) =>
  spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
const output = (result) => `${result.stdout}\n${result.stderr}`;

test("foundation readiness includes baseline, retention, and startup authorities", () => {
  const result = run("scripts/verify-foundation-policy.mjs", "--json");
  assert.equal(result.status, 0, output(result));
  const report = JSON.parse(result.stdout);
  assert.equal(report.productionActivationReady, false);
  for (const blocker of [
    "P0-BOOTSTRAP-BASELINE",
    "backup-retention-owner-unconfigured",
    "cron-not-remotely-observed",
    "last-success-not-remotely-observed",
    "production-waf-rate-unobserved",
  ]) {
    assert.ok(report.blockerCodes.includes(blocker), `missing ${blocker}`);
  }
});

test("foundation production readiness rejects unresolved control authorities", () => {
  const result = run(
    "scripts/verify-foundation-policy.mjs",
    "--require-production-ready",
  );
  assert.notEqual(result.status, 0);
  assert.match(output(result), /P0-BOOTSTRAP-BASELINE/);
  assert.match(output(result), /cron-not-remotely-observed/);
  assert.match(output(result), /production-waf-rate-unobserved/);
});

test("accepts complete per-target retention evidence", () => {
  const result = run(
    "scripts/verify-metrics-retention.mjs",
    "--evidence",
    "scripts/fixtures/controls/retention-evidence.valid.json",
  );
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /PASS metrics retention policy/);
});

test("rejects stale CSP retention even when metrics retention is fresh", () => {
  const result = run(
    "scripts/verify-metrics-retention.mjs",
    "--evidence",
    "scripts/fixtures/controls/retention-evidence.stale-csp.json",
  );
  assert.notEqual(result.status, 0);
  assert.match(output(result), /stale or invalid: csp-reports/);
});

test("keeps external production controls fail-closed while unconfigured", () => {
  for (const [script, argument, expected] of [
    [
      "scripts/provider/verify-provider-policy.mjs",
      "--require-configured",
      /Provider policy is not configured/,
    ],
    [
      "scripts/verify-db-compatibility-contract.mjs",
      "--require-remote",
      /DB compatibility is not remotely observed/,
    ],
    [
      "scripts/verify-metrics-retention.mjs",
      "--require-production-ready",
      /Metrics retention is not configured/,
    ],
    [
      "scripts/verify-release-state.mjs",
      "--require-configured",
      /Release State remains unconfigured/,
    ],
  ]) {
    const result = run(script, argument);
    assert.notEqual(result.status, 0, `${script} unexpectedly passed`);
    assert.match(output(result), expected);
  }
});
