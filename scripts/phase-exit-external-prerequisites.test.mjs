import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PHASE_EXIT_EXTERNAL_AUTHORITIES } from "./lib/phase-exit-external-authority.mjs";
import {
  BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST,
  FORMAL_EXTERNAL_PREREQUISITE_AUTHORITIES,
  MANAGED_DEVICE_RUNNER_LABELS,
  parseExternalPrerequisitePolicy,
  verifyExternalPrerequisitePolicy,
} from "./lib/phase-exit-external-prerequisites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(
  root,
  "config",
  "phase-exit-external-prerequisites.json",
);
const policyText = await readFile(policyPath, "utf8");
const basePolicy = parseExternalPrerequisitePolicy(policyText, policyPath);
const clone = (value) => structuredClone(value);
const run = (...arguments_) =>
  spawnSync(
    process.execPath,
    ["scripts/verify-phase-exit-external-prerequisites.mjs", ...arguments_],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
const output = (result) => `${result.stdout}\n${result.stderr}`;

const configuredPolicy = () => {
  const policy = clone(basePolicy);
  policy.activationStatus = "configured";
  policy.blockerCodes = [];
  policy.backupRestore = {
    ...policy.backupRestore,
    bindingStatus: "configured",
    provider: "supabase",
    apiOrigin: "https://api.supabase.com",
    sourceProjectRef: "abcdefghijklmnopqrst",
    restoreTarget: {
      ...policy.backupRestore.restoreTarget,
      projectRef: "abcdefghijklmnopqrsu",
    },
    owner: "github-team:acme/backup-operators",
  };
  policy.managedDeviceExecution = {
    ...policy.managedDeviceExecution,
    bindingStatus: "configured",
    runnerGroup: "foundation-managed-devices",
    browser: {
      ...policy.managedDeviceExecution.browser,
      binaryPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      exactVersion: "140.0.7339.41",
      managedEnrollmentIdSha256: "e".repeat(64),
    },
    deviceProfiles: policy.managedDeviceExecution.deviceProfiles.map(
      (profile, index) => {
        const profileRoot = `C:\\FoundationDevice\\Profile${index + 1}`;
        return {
          ...profile,
          profileRoot,
          profilePath: `${profileRoot}\\${profile.profileName}`,
        };
      },
    ),
    attestation: {
      ...policy.managedDeviceExecution.attestation,
      publicKeyFingerprintSha256: "a".repeat(64),
    },
    installedPwaLaunchAuthority: {
      ...policy.managedDeviceExecution.installedPwaLaunchAuthority,
      bindingStatus: "configured",
      forceInstallPolicyValueSha256: "b".repeat(64),
      installUrl: "https://planner.acme.co/app",
      applicationId: "abcdefghijklmnopabcdefghijklmnop",
    },
  };
  return policy;
};

test("closed policy fixes all three authority prerequisites without secrets", () => {
  const report = verifyExternalPrerequisitePolicy(basePolicy);
  assert.equal(report.activationStatus, "unconfigured");
  assert.deepEqual(
    report.formalAuthorities,
    FORMAL_EXTERNAL_PREREQUISITE_AUTHORITIES,
  );
  assert.deepEqual(
    basePolicy.backupRestore.credentialEnvironmentAllowlist,
    BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST,
  );
  assert.deepEqual(
    basePolicy.managedDeviceExecution.requiredLabels,
    MANAGED_DEVICE_RUNNER_LABELS,
  );
  assert.equal(report.blockerCodes.length, 12);
  assert.equal(basePolicy.backupRestore.provider, null);
  assert.equal(basePolicy.managedDeviceExecution.runnerGroup, null);
  assert.equal(
    basePolicy.managedDeviceExecution.attestation.publicKeyFingerprintSha256,
    null,
  );
  assert.doesNotMatch(
    policyText,
    /(?:password|privateKey|secretValue)\s*"\s*:/iu,
  );
});

test("strictly bound future policy derives configured status", () => {
  const policy = configuredPolicy();
  const report = verifyExternalPrerequisitePolicy(policy);
  assert.equal(report.activationStatus, "configured");
  assert.deepEqual(report.blockerCodes, []);
});

test("rejects unknown fields, values, and caller-supplied booleans", () => {
  for (const mutate of [
    (policy) => {
      policy.callerVerified = true;
    },
    (policy) => {
      policy.backupRestore.restoreSucceeded = true;
    },
    (policy) => {
      policy.managedDeviceExecution.deviceCompatible = true;
    },
    (policy) => {
      policy.backupRestore.provider = "unknown";
    },
    (policy) => {
      policy.managedDeviceExecution.browser.family = "unknown";
    },
    (policy) => {
      policy.managedDeviceExecution.attestation.algorithm = "unknown";
    },
  ]) {
    const policy = configuredPolicy();
    mutate(policy);
    assert.throws(
      () => verifyExternalPrerequisitePolicy(policy),
      /unknown|placeholder/iu,
    );
  }
});

test("rejects placeholder external bindings", () => {
  for (const mutate of [
    (policy) => {
      policy.backupRestore.apiOrigin = "https://api.example.com";
    },
    (policy) => {
      policy.backupRestore.owner = "github-team:example/backup";
    },
    (policy) => {
      policy.managedDeviceExecution.runnerGroup = "todo-runner";
    },
    (policy) => {
      policy.managedDeviceExecution.browser.managedEnrollmentIdSha256 =
        "unknown-id";
    },
    (policy) => {
      policy.managedDeviceExecution.installedPwaLaunchAuthority.installUrl =
        "https://planner.example.com/app";
    },
  ]) {
    const policy = configuredPolicy();
    mutate(policy);
    assert.throws(
      () => verifyExternalPrerequisitePolicy(policy),
      /placeholder/iu,
    );
  }
});

test("rejects duplicate JSON members and duplicate ordered inputs", () => {
  assert.throws(
    () =>
      parseExternalPrerequisitePolicy(
        '{"schemaVersion":1,"schemaVersion":1}',
        "duplicate-root.json",
      ),
    /duplicate JSON member schemaVersion/u,
  );
  assert.throws(
    () =>
      parseExternalPrerequisitePolicy(
        '{"outer":{"value":1,"value":2}}',
        "duplicate-nested.json",
      ),
    /duplicate JSON member value/u,
  );
  for (const mutate of [
    (policy) => {
      policy.formalAuthorities[1] = policy.formalAuthorities[0];
    },
    (policy) => {
      policy.backupRestore.credentialEnvironmentAllowlist[1] =
        policy.backupRestore.credentialEnvironmentAllowlist[0];
    },
    (policy) => {
      policy.managedDeviceExecution.requiredLabels[1] =
        policy.managedDeviceExecution.requiredLabels[0];
    },
    (policy) => {
      policy.managedDeviceExecution.deviceProfiles[1].id =
        policy.managedDeviceExecution.deviceProfiles[0].id;
    },
  ]) {
    const policy = configuredPolicy();
    mutate(policy);
    assert.throws(
      () => verifyExternalPrerequisitePolicy(policy),
      /allowlist|duplicate|profiles/iu,
    );
  }
});

test("rejects production restore targets and generic credential names", () => {
  for (const mutate of [
    (policy) => {
      policy.backupRestore.restoreTarget.environment = "production";
    },
    (policy) => {
      policy.backupRestore.restoreTarget.projectRef =
        policy.backupRestore.sourceProjectRef;
    },
    (policy) => {
      policy.backupRestore.restoreTarget.namespacePrefix = "production-restore";
    },
    (policy) => {
      policy.backupRestore.credentialEnvironmentAllowlist[0] =
        "SUPABASE_SERVICE_ROLE_KEY";
    },
  ]) {
    const policy = configuredPolicy();
    mutate(policy);
    assert.throws(
      () => verifyExternalPrerequisitePolicy(policy),
      /nonproduction|production|allowlist/iu,
    );
  }
});

test("rejects invalid objectives, browser identity, attestation, and launch authority", () => {
  for (const mutate of [
    (policy) => {
      policy.backupRestore.recoveryPointObjectiveSeconds = 0;
    },
    (policy) => {
      policy.backupRestore.recoveryTimeObjectiveSeconds = 86_401;
    },
    (policy) => {
      policy.managedDeviceExecution.browser.binaryPath = "chrome.exe";
    },
    (policy) => {
      policy.managedDeviceExecution.browser.exactVersion = "latest";
    },
    (policy) => {
      policy.managedDeviceExecution.browser.managedEnrollmentIdSha256 =
        "E".repeat(64);
    },
    (policy) => {
      policy.managedDeviceExecution.browser.managedEnrollmentIdSha256 =
        "e".repeat(63);
    },
    (policy) => {
      policy.managedDeviceExecution.attestation.publicKeyFingerprintSha256 =
        "A".repeat(64);
    },
    (policy) => {
      policy.managedDeviceExecution.installedPwaLaunchAuthority.forceInstallPolicyName =
        "UnknownPolicy";
    },
    (policy) => {
      policy.managedDeviceExecution.installedPwaLaunchAuthority.applicationId =
        "z".repeat(32);
    },
    (policy) => {
      policy.managedDeviceExecution.deviceProfiles[0].profileRoot =
        "relative-profile";
    },
    (policy) => {
      policy.managedDeviceExecution.deviceProfiles[0].profilePath =
        policy.managedDeviceExecution.deviceProfiles[1].profilePath;
    },
  ]) {
    const policy = configuredPolicy();
    mutate(policy);
    assert.throws(() => verifyExternalPrerequisitePolicy(policy));
  }
});

test("rejects caller status and blocker assertions that differ from bindings", () => {
  const configured = configuredPolicy();
  configured.activationStatus = "unconfigured";
  assert.throws(
    () => verifyExternalPrerequisitePolicy(configured),
    /status must be derived as configured/u,
  );

  const closed = clone(basePolicy);
  closed.blockerCodes = [];
  assert.throws(
    () => verifyExternalPrerequisitePolicy(closed),
    /blocker codes must be the exact ordered allowlist/iu,
  );
});

test("formal authority collector implementation status remains explicit", () => {
  for (const authority of FORMAL_EXTERNAL_PREREQUISITE_AUTHORITIES) {
    const definition = PHASE_EXIT_EXTERNAL_AUTHORITIES.find(
      (candidate) => candidate.authority === authority,
    );
    assert.ok(definition, `missing ${authority}`);
    assert.equal(definition.collectorImplemented, true, authority);
  }
});

test("CLI verifies structure but cannot promote the closed policy", () => {
  const valid = run("--json");
  assert.equal(valid.status, 0, output(valid));
  assert.equal(JSON.parse(valid.stdout).activationStatus, "unconfigured");

  const production = run("--require-configured");
  assert.notEqual(production.status, 0);
  assert.match(output(production), /remain unconfigured/u);

  for (const arguments_ of [
    ["--caller-verified"],
    ["--json", "--json"],
    ["--policy"],
  ]) {
    const result = run(...arguments_);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /argument|requires/iu);
  }
});
