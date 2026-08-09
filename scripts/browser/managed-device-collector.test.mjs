import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseManagedDeviceCollectorArguments,
  runManagedDeviceCollectorCli,
} from "./collect-managed-device-authority.mjs";
import { runIdbDeviceCompatibilityCollector } from "./collect-idb-device-compatibility.mjs";
import { runPwaMulticlientDrillCollector } from "./collect-pwa-multiclient-drill.mjs";
import { managedDevicePublicKeyFingerprint } from "./managed-device-authority.mjs";
import { selectManagedDeviceRollbackBinding } from "./managed-device-package.mjs";
import { executeManagedDevicePowerShell } from "./managed-device-powershell.mjs";
import { canonicalJsonBytes } from "../lib/canonical-json.mjs";

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
  "managed-device.json",
];

test("managed-device argument parser accepts only the closed four-pair contract", () => {
  assert.deepEqual(
    parseManagedDeviceCollectorArguments([
      "--authority",
      "pwa-multiclient-drill",
      ...publicArguments,
    ]),
    {
      authority: "pwa-multiclient-drill",
      namespace: "foundation-production",
      outputPath: "managed-device.json",
      sourceSha,
    },
  );
  for (const prohibited of [
    "--client-kind",
    "--status",
    "--hash",
    "--installed",
  ]) {
    assert.throws(
      () =>
        parseManagedDeviceCollectorArguments([
          "--authority",
          "idb-device-compatibility",
          "--namespace",
          "foundation-production",
          "--source-sha",
          sourceSha,
          prohibited,
          "caller-claim",
        ]),
      /arguments are invalid|Usage/,
    );
  }
  assert.throws(
    () =>
      parseManagedDeviceCollectorArguments([
        "--authority",
        "pwa-multiclient-drill",
        "--authority",
        "idb-device-compatibility",
        "--source-sha",
        sourceSha,
        "--output",
        "managed-device.json",
      ]),
    /arguments are invalid/,
  );
});

test("fixed collector entrypoints supply their authority and expose only three caller pairs", async () => {
  const observed = [];
  const capture = async ({ argv }) => {
    const parsed = parseManagedDeviceCollectorArguments(argv);
    observed.push(parsed.authority);
    return parsed;
  };
  await runPwaMulticlientDrillCollector({ argv: publicArguments }, {}, capture);
  await runIdbDeviceCompatibilityCollector(
    { argv: publicArguments },
    {},
    capture,
  );
  assert.deepEqual(observed, [
    "pwa-multiclient-drill",
    "idb-device-compatibility",
  ]);
});

test("unconfigured managed-device policy rejects before policies, store, or executor", async () => {
  const calls = { createStore: 0, execute: 0, loadPolicy: 0 };
  await assert.rejects(
    runManagedDeviceCollectorCli(
      {
        argv: ["--authority", "pwa-multiclient-drill", ...publicArguments],
        environment: {},
      },
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
        execute: async () => {
          calls.execute += 1;
          throw new Error("unreachable executor");
        },
      },
    ),
    /unconfigured/,
  );
  assert.deepEqual(calls, { createStore: 0, execute: 0, loadPolicy: 0 });
});

test("PowerShell adapter rejects unconfigured policy before platform and process resolution", async () => {
  const calls = { resolvePowerShell: 0, run: 0 };
  await assert.rejects(
    executeManagedDevicePowerShell(
      {
        request: { authority: "pwa-multiclient-drill" },
        artifacts: {},
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
    /unconfigured/,
  );
  assert.deepEqual(calls, { resolvePowerShell: 0, run: 0 });
});

test("PowerShell adapter projects a closed child environment without workflow or database secrets", async () => {
  const configuredPolicy = structuredClone(externalPolicy);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const device = configuredPolicy.managedDeviceExecution;
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
  device.attestation.publicKeyFingerprintSha256 =
    managedDevicePublicKeyFingerprint(publicKeyPem);
  device.installedPwaLaunchAuthority.bindingStatus = "configured";
  device.installedPwaLaunchAuthority.forceInstallPolicyValueSha256 = hash("b");
  device.installedPwaLaunchAuthority.installUrl = "https://planner.acme.co/app";
  device.installedPwaLaunchAuthority.applicationId =
    "abcdefghijklmnopabcdefghijklmnop";
  configuredPolicy.blockerCodes = configuredPolicy.blockerCodes.filter(
    (code) =>
      !code.startsWith("device-") &&
      code !== "installed-pwa-launch-authority-unconfigured",
  );
  const environment = {
    ...process.env,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
    FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM: privateKeyPem,
    FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM: publicKeyPem,
    FOUNDATION_DEVICE_PROFILE_ROOT: root,
    FOUNDATION_DEVICE_RUNNER_GROUP: device.runnerGroup,
    FOUNDATION_DEVICE_RUNNER_LABELS: device.requiredLabels.join(","),
    RELEASE_STATE_DATABASE_URL: "postgres://must-not-reach-child",
    RUNNER_TEMP: tmpdir(),
  };
  const receipt = await executeManagedDevicePowerShell(
    {
      request: { authority: "idb-device-compatibility" },
      artifacts: { current: { distRoot: root }, rollback: null },
      externalPolicy: configuredPolicy,
      environment,
      repositoryRoot: root,
    },
    {
      platform: "win32",
      resolvePowerShell: async () => "C:\\pwsh.exe",
      run: async (_executable, arguments_, options) => {
        assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
        assert.equal(options.env.RELEASE_STATE_DATABASE_URL, undefined);
        assert.equal(
          options.env.FOUNDATION_DEVICE_RUNNER_GROUP,
          device.runnerGroup,
        );
        const outputPath = arguments_[arguments_.indexOf("-OutputPath") + 1];
        await writeFile(outputPath, canonicalJsonBytes({ projected: true }), {
          flag: "wx",
        });
        return { stderr: "", stdout: "" };
      },
    },
  );
  assert.deepEqual(receipt, { projected: true });
});

test("PWA rollback materialization accepts exactly one distinct eligible standard", () => {
  const acceptedStandard = { sourceSha };
  const eligible = {
    eligibility: "eligible",
    eligibleActions: ["rollback"],
    binding: { releaseRole: "standard", sourceSha: "f".repeat(40) },
  };
  assert.equal(
    selectManagedDeviceRollbackBinding({
      acceptedStandard,
      rollbackInventory: [eligible],
    }),
    eligible.binding,
  );
  for (const rollbackInventory of [
    [],
    [eligible, structuredClone(eligible)],
    [
      {
        ...eligible,
        binding: { releaseRole: "standard", sourceSha },
      },
    ],
    [
      {
        ...eligible,
        binding: { releaseRole: "containment", sourceSha: "f".repeat(40) },
      },
    ],
  ]) {
    assert.throws(
      () =>
        selectManagedDeviceRollbackBinding({
          acceptedStandard,
          rollbackInventory,
        }),
      /exactly one eligible rollback artifact/,
    );
  }
});
