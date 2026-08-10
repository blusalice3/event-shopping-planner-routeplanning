import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertConfiguredApprovalRolePolicy } from "./lib/approval-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (...arguments_) =>
  spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
const output = (result) => `${result.stdout}\n${result.stderr}`;

test("approval policy fixes one human account across all operator roles", () => {
  const policy = JSON.parse(
    readFileSync(path.join(root, "config/approval-policy.json"), "utf8"),
  );
  assert.equal(policy.distinctApprovalIds, true);
  assert.equal(policy.distinctProviderReviewerIds, false);
  assert.equal(
    policy.humanOperatorModel,
    "single-human-single-github-account/v1",
  );
});

test("configured approval policy fixes exact roles, teams, and identity flags", () => {
  const basePolicy = JSON.parse(
    readFileSync(path.join(root, "config/approval-policy.json"), "utf8"),
  );
  const configuredPolicy = {
    ...basePolicy,
    bindingStatus: "configured",
    blockerCodes: [],
    roles: {
      releaseOwner: { reviewerTeam: "release-owners" },
      dataSafetyReviewer: { reviewerTeam: "data-safety-reviewers" },
      operationsReviewer: { reviewerTeam: "operations-reviewers" },
    },
  };
  assert.deepEqual(assertConfiguredApprovalRolePolicy(configuredPolicy), {
    releaseOwner: "release-owners",
    dataSafetyReviewer: "data-safety-reviewers",
    operationsReviewer: "operations-reviewers",
  });
  for (const invalidPolicy of [
    { ...configuredPolicy, distinctApprovalIds: false },
    { ...configuredPolicy, distinctProviderReviewerIds: true },
    { ...configuredPolicy, humanOperatorModel: "multi-human-required/v1" },
    { ...configuredPolicy, blockerCodes: ["still-blocked"] },
    {
      ...configuredPolicy,
      roles: {
        ...configuredPolicy.roles,
        operationsReviewer: { reviewerTeam: "release-owners" },
      },
    },
    {
      ...configuredPolicy,
      roles: { ...configuredPolicy.roles, unexpectedRole: {} },
    },
  ]) {
    assert.throws(
      () => assertConfiguredApprovalRolePolicy(invalidPolicy),
      /role binding is not configured/,
    );
  }
});

test("foundation readiness includes baseline, retention, startup, and external prerequisite authorities", () => {
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
    "backup-provider-unconfigured",
    "device-runner-group-unconfigured",
    "artifact-drill-database-host-unconfigured",
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
  assert.match(output(result), /backup-provider-unconfigured/);
  assert.match(output(result), /device-runner-group-unconfigured/);
  assert.match(output(result), /artifact-drill-database-host-unconfigured/);
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
