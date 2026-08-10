import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJsonBytes } from "../lib/canonical-json.mjs";
import {
  parseManagedDeviceLiveStageArguments,
  runManagedDeviceLiveStageCollector,
} from "./collect-managed-device-live-stage.mjs";
import { parseManagedDeviceStageFinalizerArguments } from "./finalize-managed-device-live-stage.mjs";
import {
  executeManagedDeviceLiveStagePowerShell,
  projectManagedDeviceLiveStageEnvironment,
} from "./managed-device-live-stage-powershell.mjs";
import { parseManagedDeviceLegacySentinelArguments } from "./prepare-managed-device-legacy-sentinels.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const externalPolicy = JSON.parse(
  await readFile(
    path.join(root, "config", "phase-exit-external-prerequisites.json"),
    "utf8",
  ),
);
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const hash = (character) => character.repeat(64);
const publicArguments = [
  "--namespace",
  "foundation-production",
  "--source-sha",
  sourceSha,
  "--output",
  "managed-device-stage.json",
];

const configuredExternalPolicy = () => {
  const policy = structuredClone(externalPolicy);
  const device = policy.managedDeviceExecution;
  device.bindingStatus = "configured";
  device.runnerGroup = "foundation-managed-devices";
  device.browser.binaryPath =
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  device.browser.exactVersion = "140.0.7339.41";
  device.browser.managedEnrollmentIdSha256 = hash("e");
  device.deviceProfiles = device.deviceProfiles.map((profile, index) => {
    const profileRoot = `C:\\FoundationDevice\\Profile${index + 1}`;
    return {
      ...profile,
      profileRoot,
      profilePath: `${profileRoot}\\${profile.profileName}`,
    };
  });
  device.attestation.publicKeyFingerprintSha256 = hash("a");
  device.installedPwaLaunchAuthority = {
    ...device.installedPwaLaunchAuthority,
    bindingStatus: "configured",
    forceInstallPolicyValueSha256: hash("b"),
    installUrl: "https://planner.acme.co/app",
    applicationId: "abcdefghijklmnopabcdefghijklmnop",
  };
  policy.blockerCodes = policy.blockerCodes.filter(
    (code) =>
      !code.startsWith("device-") &&
      code !== "installed-pwa-launch-authority-unconfigured",
  );
  return policy;
};

test("live stage parser exposes no stage or client result claims", () => {
  assert.deepEqual(parseManagedDeviceLiveStageArguments(publicArguments), {
    namespace: "foundation-production",
    outputPath: "managed-device-stage.json",
    sourceSha,
  });
  for (const prohibited of [
    "--stage",
    "--client-kind",
    "--status",
    "--hash",
    "--installed",
    "--run-id",
  ]) {
    assert.throws(
      () =>
        parseManagedDeviceLiveStageArguments([
          "--namespace",
          "foundation-production",
          "--source-sha",
          sourceSha,
          prohibited,
          "caller-claim",
        ]),
      /arguments are invalid|Usage/u,
    );
  }
});

test("PowerShell enrollment authority is hash-only in policy comparison and raw evidence", async () => {
  const sources = await Promise.all(
    [
      "scripts/collect-managed-device-live-stage.ps1",
      "scripts/collect-managed-device-raw.ps1",
    ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")),
  );
  for (const source of sources) {
    assert.match(source, /managedEnrollmentIdSha256/u);
    assert.match(
      source,
      /Sha256\s*=\s*Get-Sha256Text\s+-Value\s+\(\s*\[string\]\$property\.CloudManagementEnrollmentToken\s*\)/u,
    );
    assert.match(
      source,
      /enrollmentIdSha256\s*=\s*\[string\]\$enrollmentObservations\[0\]\.Sha256/u,
    );
    assert.doesNotMatch(source, /\$enrollmentObservations\[0\]\.Value/u);
    assert.doesNotMatch(
      source,
      /Value\s*=\s*\[string\]\$property\.CloudManagementEnrollmentToken/u,
    );
    assert.match(
      source,
      /\[Text\.UTF8Encoding\]::new\(\$false\)\.GetBytes\(\s*\$Value\s*\)/u,
    );
  }
});

test("live finalizer exposes only exact internal file authorities", () => {
  const valid = [
    "--request",
    "C:\\temp\\request.json",
    "--host",
    "C:\\temp\\host.json",
    "--initial",
    "C:\\temp\\initial.json",
    "--reopened",
    "C:\\temp\\reopened.json",
    "--output",
    "C:\\temp\\receipt.json",
  ];
  assert.equal(parseManagedDeviceStageFinalizerArguments(valid).size, 5);
  const tampered = [...valid];
  tampered.splice(0, 2, "--stage", "rollback");
  assert.throws(
    () => parseManagedDeviceStageFinalizerArguments(tampered),
    /arguments are invalid/u,
  );
});

test("legacy sentinel preparer accepts only internal file authorities", () => {
  const valid = [
    "--request",
    "C:\\temp\\request.json",
    "--launch",
    "C:\\temp\\launch.json",
    "--output",
    "C:\\temp\\sentinels.json",
  ];
  assert.deepEqual(parseManagedDeviceLegacySentinelArguments(valid), {
    launchPath: "C:\\temp\\launch.json",
    outputPath: "C:\\temp\\sentinels.json",
    requestPath: "C:\\temp\\request.json",
  });
  const tampered = [...valid];
  tampered.splice(0, 2, "--status", "PASS");
  assert.throws(
    () => parseManagedDeviceLegacySentinelArguments(tampered),
    /arguments are invalid/u,
  );
});

test("unconfigured live stage rejects before policy, store, OIDC, or process", async () => {
  const calls = {
    collectOidcReceipt: 0,
    createStore: 0,
    execute: 0,
    loadPolicy: 0,
  };
  await assert.rejects(
    runManagedDeviceLiveStageCollector(
      { argv: publicArguments, environment: {} },
      {
        loadExternalPolicy: async () => ({ policy: externalPolicy }),
        loadPolicy: async () => {
          calls.loadPolicy += 1;
          throw new Error("unreachable policy loader");
        },
        createStore: async () => {
          calls.createStore += 1;
          throw new Error("unreachable store");
        },
        collectOidcReceipt: async () => {
          calls.collectOidcReceipt += 1;
          throw new Error("unreachable OIDC");
        },
        execute: async () => {
          calls.execute += 1;
          throw new Error("unreachable process");
        },
      },
    ),
    /unconfigured/u,
  );
  assert.deepEqual(calls, {
    collectOidcReceipt: 0,
    createStore: 0,
    execute: 0,
    loadPolicy: 0,
  });
});

test("live PowerShell adapter rejects unconfigured policy before process resolution", async () => {
  const calls = { resolvePowerShell: 0, run: 0 };
  await assert.rejects(
    executeManagedDeviceLiveStagePowerShell(
      {
        request: { kind: "managed-device-stage-execution-request/v1" },
        externalPolicy,
        environment: {},
        repositoryRoot: root,
      },
      {
        platform: "win32",
        resolvePowerShell: async () => {
          calls.resolvePowerShell += 1;
          throw new Error("unreachable PowerShell resolver");
        },
        run: async () => {
          calls.run += 1;
          throw new Error("unreachable process");
        },
      },
    ),
    /unconfigured/u,
  );
  assert.deepEqual(calls, { resolvePowerShell: 0, run: 0 });
});

const childEnvironment = (policy) => ({
  APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-reach-child",
  DATABASE_URL: "postgres://must-not-reach-child",
  FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM: "p".repeat(64),
  FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM: "q".repeat(64),
  FOUNDATION_DEVICE_RUNNER_GROUP: policy.managedDeviceExecution.runnerGroup,
  FOUNDATION_DEVICE_RUNNER_LABELS:
    policy.managedDeviceExecution.requiredLabels.join(","),
  PATH: "C:\\Windows\\System32",
  ProgramData: "C:\\ProgramData",
  RELEASE_STATE_DATABASE_URL: "postgres://must-not-reach-child",
  RUNNER_TEMP: tmpdir(),
  SystemRoot: "C:\\Windows",
});

test("live PowerShell child environment is closed and omits workflow/database secrets", async () => {
  const policy = configuredExternalPolicy();
  const environment = childEnvironment(policy);
  const projected = projectManagedDeviceLiveStageEnvironment(environment);
  assert.equal(projected.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(projected.DATABASE_URL, undefined);
  assert.equal(projected.RELEASE_STATE_DATABASE_URL, undefined);
  assert.deepEqual(Object.keys(projected).sort(), [
    "APPDATA",
    "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
    "FOUNDATION_DEVICE_RUNNER_GROUP",
    "FOUNDATION_DEVICE_RUNNER_LABELS",
    "PATH",
    "ProgramData",
    "RUNNER_TEMP",
    "SystemRoot",
  ]);
});

test("live PowerShell adapter reads only a canonical signed stage output", async () => {
  const policy = configuredExternalPolicy();
  const environment = childEnvironment(policy);
  const expected = {
    schemaVersion: 1,
    kind: "managed-device-stage-signed-receipt/v1",
    payload: { fixture: true },
    signature: { fixture: true },
  };
  const receipt = await executeManagedDeviceLiveStagePowerShell(
    {
      request: { kind: "managed-device-stage-execution-request/v1" },
      externalPolicy: policy,
      environment,
      repositoryRoot: root,
    },
    {
      platform: "win32",
      resolvePowerShell: async () => "C:\\pwsh.exe",
      run: async (_executable, arguments_, options) => {
        assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
        assert.equal(options.env.RELEASE_STATE_DATABASE_URL, undefined);
        const outputPath = arguments_[arguments_.indexOf("-OutputPath") + 1];
        await writeFile(outputPath, canonicalJsonBytes(expected), {
          flag: "wx",
        });
        return { stderr: "", stdout: "" };
      },
    },
  );
  assert.deepEqual(receipt, expected);
});
