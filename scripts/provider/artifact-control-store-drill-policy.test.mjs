import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveArtifactControlStoreDrillPolicyState,
  verifyArtifactControlStoreDrillPolicy,
} from "../lib/artifact-control-store-drill-policy.mjs";
import { runArtifactControlStoreDrillPolicyVerifier } from "./verify-artifact-control-store-drill-policy.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const loadPolicy = async () =>
  JSON.parse(
    await readFile(
      path.join(root, "config", "artifact-control-store-drill.json"),
      "utf8",
    ),
  );

const configuredBindings = (policy) => ({
  ...structuredClone(policy),
  allowedDrillHosts: ["drill-db.acme.com"],
  allowedDrillDatabases: ["artifact_drill"],
  allowedDrillAdministratorRoles: ["artifact_drill_admin"],
  allowedDrillExecutorRoles: ["artifact_drill_executor"],
  allowedDeniedReaderProjectionRoles: ["drill_denied_reader"],
  databaseCaSha256:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  providerPreviewAliasSuffix: "drill.acme.com",
  bindingStatus: "configured",
  blockerCodes: [],
});

test("derives only the seven external binding blockers", async () => {
  const policy = await loadPolicy();
  const derived = deriveArtifactControlStoreDrillPolicyState(policy);
  assert.equal(derived.bindingStatus, "unconfigured");
  assert.equal(derived.blockerCodes.length, 7);
  assert.deepEqual(policy.blockerCodes, [...derived.blockerCodes]);
  const report = verifyArtifactControlStoreDrillPolicy(policy);
  assert.equal(report.configured, false);
});

test("configured bindings have no repository implementation blocker", async () => {
  const policy = configuredBindings(await loadPolicy());
  const report = verifyArtifactControlStoreDrillPolicy(policy);
  assert.equal(report.configured, true);
  assert.deepEqual(report.blockerCodes, []);
  const claimed = structuredClone(policy);
  claimed.bindingStatus = "unconfigured";
  assert.throws(
    () => verifyArtifactControlStoreDrillPolicy(claimed),
    /differ from derived authority/,
  );
});

test("rejects unknown or missing root and implementation fields", async () => {
  const original = await loadPolicy();
  for (const mutate of [
    (policy) => {
      policy.callerConfigured = true;
    },
    (policy) => {
      delete policy.schemaResetMode;
    },
    (policy) => {
      policy.implementation.callerAdapterImplemented = true;
    },
    (policy) => {
      delete policy.implementation.collectorIdentityBindingImplemented;
    },
  ]) {
    const policy = structuredClone(original);
    mutate(policy);
    assert.throws(
      () => verifyArtifactControlStoreDrillPolicy(policy),
      /unknown or missing fields/,
    );
  }
});

test("rejects legacy production-reader policy keys without fallback", async () => {
  const policy = configuredBindings(await loadPolicy());
  policy.productionReaderDatabaseUrlEnvironmentName =
    "ARTIFACT_DRILL_PRODUCTION_READER_DATABASE_URL";
  policy.allowedProductionReaderRoles = ["production_reader"];
  delete policy.deniedReaderProjectionDatabaseUrlEnvironmentName;
  delete policy.allowedDeniedReaderProjectionRoles;
  assert.throws(
    () => verifyArtifactControlStoreDrillPolicy(policy),
    /unknown or missing fields/,
  );
});

test("rejects placeholder, duplicate, unsorted, and overlapping role bindings", async () => {
  const original = await loadPolicy();
  const cases = [
    [
      "placeholder host",
      (policy) => (policy.allowedDrillHosts = ["db.example.test"]),
    ],
    [
      "placeholder database",
      (policy) => (policy.allowedDrillDatabases = ["test_db"]),
    ],
    [
      "placeholder role",
      (policy) => (policy.allowedDrillExecutorRoles = ["placeholder_executor"]),
    ],
    [
      "duplicate",
      (policy) => (policy.allowedDrillHosts = ["a.acme.com", "a.acme.com"]),
    ],
    [
      "unsorted",
      (policy) => (policy.allowedDrillHosts = ["z.acme.com", "a.acme.com"]),
    ],
    ["placeholder CA", (policy) => (policy.databaseCaSha256 = "0".repeat(64))],
    [
      "placeholder alias",
      (policy) => (policy.providerPreviewAliasSuffix = "drill.example.test"),
    ],
    [
      "overlapping roles",
      (policy) => {
        policy.allowedDrillAdministratorRoles = ["shared_drill_role"];
        policy.allowedDrillExecutorRoles = ["shared_drill_role"];
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const policy = structuredClone(original);
    mutate(policy);
    assert.throws(
      () => deriveArtifactControlStoreDrillPolicyState(policy),
      /invalid|placeholder|duplicate|unsorted/,
      label,
    );
  }
});

test("rejects unknown, duplicate, unsorted, or forged blocker arrays", async () => {
  const original = await loadPolicy();
  for (const blockers of [
    [...original.blockerCodes, "caller-success"],
    [...original.blockerCodes, original.blockerCodes.at(-1)],
    [...original.blockerCodes].reverse(),
    original.blockerCodes.slice(1),
  ]) {
    const policy = structuredClone(original);
    policy.blockerCodes = blockers;
    assert.throws(
      () => verifyArtifactControlStoreDrillPolicy(policy),
      /unknown, duplicate, or unsorted|differ from derived authority/,
    );
  }
});

test("rejects disabling repository implementation capability flags", async () => {
  const original = await loadPolicy();
  for (const key of Object.keys(original.implementation)) {
    const policy = structuredClone(original);
    policy.implementation[key] = false;
    assert.throws(
      () => verifyArtifactControlStoreDrillPolicy(policy),
      new RegExp(`differs from repository code: ${key}`, "u"),
    );
  }
});

test("CLI passes structural verification and fails require-configured", async () => {
  const policy = await loadPolicy();
  let output = "";
  const report = await runArtifactControlStoreDrillPolicyVerifier(
    {
      argv: [],
      stdout: { write: (value) => (output += value) },
    },
    { loadPolicy: async () => structuredClone(policy) },
  );
  assert.equal(report.configured, false);
  assert.match(output, /PASS.*unconfigured; blockers 7/u);
  await assert.rejects(
    runArtifactControlStoreDrillPolicyVerifier(
      { argv: ["--require-configured"], stdout: { write() {} } },
      { loadPolicy: async () => structuredClone(policy) },
    ),
    /not configured/,
  );
  await assert.rejects(
    runArtifactControlStoreDrillPolicyVerifier(
      { argv: ["--caller-success"], stdout: { write() {} } },
      { loadPolicy: async () => structuredClone(policy) },
    ),
    /Usage:/,
  );
});
