import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  aggregateValidatedManagedDeviceStages,
  deriveManagedDeviceFingerprint,
  deriveManagedDeviceLegacySentinelValues,
  summarizeManagedDeviceStagePayload,
} from "./managed-device-stage-authority.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const loadJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const baseExternalPolicy = await loadJson(
  "config/phase-exit-external-prerequisites.json",
);
const dbContract = await loadJson("config/db-compatibility-contract.json");
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const rollbackSourceSha = "fedcba9876543210fedcba9876543210fedcba98";
const deploymentUrl = "https://deployment.example.test/";
const hash = (character) => character.repeat(64);

const configuredExternalPolicy = () => {
  const policy = structuredClone(baseExternalPolicy);
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

const stores = () =>
  Object.entries(dbContract.indexedDb.stores)
    .map(([name, value]) => ({
      indexes: value.indexes,
      keyPath: value.keyPath,
      name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const rawDatabase = (profileIndex) => ({
  name: dbContract.indexedDb.name,
  version: dbContract.indexedDb.version,
  stores: stores(),
  raw: {
    archive: { schemaVersion: 1, entries: [{ profileIndex }] },
    checkpoint: {
      kind: "event-shopping-planner-persistence-checkpoint",
      version: 1,
      storeName: "eventMetadata",
      key: "data",
      committedRoot: {
        revision: `managed-revision-${profileIndex}`,
        digest: { algorithm: "SHA-256", value: hash("c") },
      },
    },
    journal: {
      schemaVersion: 2,
      phase: "verified",
      dataMigrationStatus: "verified",
      entries: [{ profileIndex }],
    },
    syncQueuePayload: [{ id: `queue-${profileIndex}` }],
  },
});

const capabilityBytes = (stageSourceSha) =>
  canonicalJsonBytes({
    sourceSha: stageSourceSha,
    buildId: stageSourceSha,
    releaseChannel: "release-a",
    legacyLocalStorageCleanup: "forced-off",
  });

const clientObservation = ({
  policy,
  profileIndex,
  processId,
  stageSourceSha,
  activationEventHash,
}) => {
  const device = policy.managedDeviceExecution;
  const profile = device.deviceProfiles[profileIndex];
  const installed = profile.id === "installed-pwa";
  const controllerBytes = Buffer.from(`service-worker-${stageSourceSha}`);
  const conflictFixture = {
    orphanStorageKey: `esp:idb-fallback:v1:eventMetadata:data:orphan-${profileIndex}`,
    rawValue: `conflict-${profileIndex}`,
  };
  const arguments_ = [
    device.browser.binaryPath,
    `--user-data-dir=${profile.profileRoot}`,
    `--profile-directory=${profile.profileName}`,
    `--remote-debugging-port=${9222 + profileIndex}`,
    ...(installed
      ? [`--app-id=${device.installedPwaLaunchAuthority.applicationId}`]
      : []),
  ];
  const commandLine = arguments_.map((value) => `"${value}"`).join(" ");
  const capability = capabilityBytes(stageSourceSha);
  const profilePathSha256 = sha256Bytes(
    Buffer.from(profile.profilePath, "utf8"),
  );
  return {
    profileId: profile.id,
    clientKind: profile.clientKind,
    installedMode: profile.installedMode,
    profileRootSha256: sha256Bytes(Buffer.from(profile.profileRoot, "utf8")),
    profilePathSha256,
    process: {
      processId,
      executableSha256: hash("3"),
      cimCommandLineBytesBase64: Buffer.from(commandLine).toString("base64"),
    },
    cdp: {
      browserArgumentsBytesBase64:
        canonicalJsonBytes(arguments_).toString("base64"),
      browserVersion: device.browser.exactVersion,
      targetType: "page",
      targetUrl: device.installedPwaLaunchAuthority.installUrl,
    },
    pwa: {
      capabilityBytesBase64: capability.toString("base64"),
      offlineCapabilityBytesBase64: capability.toString("base64"),
      controller: {
        activeState: "activated",
        scriptUrl: "https://planner.acme.co/sw.js",
        sourceBytesBase64: controllerBytes.toString("base64"),
      },
      immutableDeployment: {
        deploymentUrl,
        capabilityUrl:
          "https://deployment.example.test/release-capabilities.json",
        capabilityBytesBase64: capability.toString("base64"),
        controllerUrl: "https://deployment.example.test/sw.js",
        controllerBytesBase64: controllerBytes.toString("base64"),
      },
      legacyRawValues: deriveManagedDeviceLegacySentinelValues({
        activationEventHash,
        profileId: profile.id,
      }),
    },
    idbRawReceipt: {
      schemaVersion: 1,
      kind: "managed-device-idb-profile-probe/v1",
      profileId: profile.id,
      sourceSha: stageSourceSha,
      profilePathSha256,
      browserProcessId: processId,
      controller: {
        scriptUrl: "https://planner.acme.co/sw.js",
        sourceBytesBase64: controllerBytes.toString("base64"),
      },
      database: rawDatabase(profileIndex),
      invalid: {
        fixture: {
          storageKey:
            "esp:idb-fallback:v1:eventMetadata:data:managed-device-invalid",
          rawValue: "{",
        },
        observation: {
          bodyTextSha256: hash("1"),
          candidateCount: 1,
          rawRetained: "{",
          recoveryVisible: true,
        },
      },
      conflict: {
        fixture: conflictFixture,
        fixtureBytesBase64:
          canonicalJsonBytes(conflictFixture).toString("base64"),
        observation: {
          bodyTextSha256: hash("2"),
          candidateCount: 2,
          rawRetained: conflictFixture.rawValue,
          recoveryVisible: true,
        },
      },
      cleanup: { callCount: 0, physicalDeleteCount: 0 },
    },
  };
};

const stagePayload = (policy, stageSourceSha = sourceSha) => {
  const device = policy.managedDeviceExecution;
  const activationEventHash = hash("e");
  const cycles = ["initial", "reopened"].map((cycle, cycleIndex) => ({
    cycle,
    clients: device.deviceProfiles.map((_, profileIndex) =>
      clientObservation({
        policy,
        profileIndex,
        processId: 100 + cycleIndex * 10 + profileIndex,
        stageSourceSha,
        activationEventHash,
      }),
    ),
  }));
  const observationWithoutFingerprint = {
    runnerGroup: device.runnerGroup,
    runnerLabels: [...device.requiredLabels],
    operatingSystem: structuredClone(device.operatingSystem),
    browser: {
      family: device.browser.family,
      binaryPath: device.browser.binaryPath,
      binarySha256: hash("3"),
      version: device.browser.exactVersion,
      enrollmentIdSha256: device.browser.managedEnrollmentIdSha256,
    },
    policy: {
      forceInstallPolicyName:
        device.installedPwaLaunchAuthority.forceInstallPolicyName,
      forceInstallPolicyValueSha256:
        device.installedPwaLaunchAuthority.forceInstallPolicyValueSha256,
      installUrl: device.installedPwaLaunchAuthority.installUrl,
      applicationId: device.installedPwaLaunchAuthority.applicationId,
      shortcutArgumentsSha256: hash("4"),
      shortcutPathSha256: hash("5"),
    },
    cycles,
    closures: [
      {
        cycle: "initial",
        processIds: [100, 101],
        remainingProcessCount: 0,
        closedAt: "2026-08-09T00:01:00.000Z",
      },
      {
        cycle: "reopened",
        processIds: [110, 111],
        remainingProcessCount: 0,
        closedAt: "2026-08-09T00:02:00.000Z",
      },
    ],
    legacySentinels: device.deviceProfiles.map(({ id }) => {
      const rawValues = deriveManagedDeviceLegacySentinelValues({
        activationEventHash,
        profileId: id,
      });
      return {
        profileId: id,
        rawValues,
        rawValuesSha256: sha256Json(rawValues),
      };
    }),
  };
  return {
    releaseState: {
      activeBinding: { sourceSha: stageSourceSha, deploymentUrl },
      activation: { eventHash: activationEventHash },
    },
    observation: {
      ...observationWithoutFingerprint,
      deviceFingerprintSha256: deriveManagedDeviceFingerprint({
        observation: observationWithoutFingerprint,
        device,
      }),
    },
  };
};

test("managed device stage summary is derived from two real client cycles", () => {
  const policy = configuredExternalPolicy();
  const payload = stagePayload(policy);
  const summary = summarizeManagedDeviceStagePayload({
    payload,
    externalPolicy: policy,
    dbContract,
  });
  assert.equal(summary.deploymentSourceSha, sourceSha);
  assert.deepEqual(
    summary.clients.map(({ profileId }) => profileId),
    ["browser-tab", "installed-pwa"],
  );
  assert.equal(summary.clients[0].cleanup.callCount, 0);
  assert.match(summary.clients[0].checkpointSha256, /^[0-9a-f]{64}$/u);
  assert.match(summary.clients[0].rawDatabaseSha256, /^[0-9a-f]{64}$/u);
});

test("managed device stage rejects caller-like launch and raw claims", () => {
  const policy = configuredExternalPolicy();
  const invalidCases = [
    (payload) => {
      const installed = payload.observation.cycles[0].clients[1];
      installed.cdp.browserArgumentsBytesBase64 = canonicalJsonBytes([
        policy.managedDeviceExecution.browser.binaryPath,
        `--user-data-dir=${policy.managedDeviceExecution.deviceProfiles[1].profileRoot}`,
        "--profile-directory=foundation-installed-pwa",
        "--remote-debugging-port=9223",
        "--app=https://planner.acme.co/app",
      ]).toString("base64");
    },
    (payload) => {
      const browserTab = payload.observation.cycles[0].clients[0];
      browserTab.cdp.browserArgumentsBytesBase64 = canonicalJsonBytes([
        policy.managedDeviceExecution.browser.binaryPath,
        `--user-data-dir=${policy.managedDeviceExecution.deviceProfiles[0].profileRoot}`,
        "--profile-directory=foundation-browser-tab",
        "--remote-debugging-port=9222",
        "--app-id=abcdefghijklmnopabcdefghijklmnop",
      ]).toString("base64");
    },
    (payload) => {
      payload.observation.cycles[0].clients[0].idbRawReceipt.sourceSha =
        rollbackSourceSha;
    },
    (payload) => {
      payload.observation.cycles[0].clients[0].pwa.offlineCapabilityBytesBase64 =
        canonicalJsonBytes({ sourceSha }).toString("base64");
    },
    (payload) => {
      payload.observation.cycles[1].clients[0].idbRawReceipt.database.raw.checkpoint.committedRoot.revision =
        "reopened-tamper";
    },
    (payload) => {
      payload.observation.cycles[0].clients[0].profileRootSha256 = hash("f");
    },
    (payload) => {
      payload.observation.cycles[0].clients[0].pwa.immutableDeployment.controllerBytesBase64 =
        Buffer.from("substituted-controller").toString("base64");
    },
    (payload) => {
      payload.observation.closures[0].remainingProcessCount = 1;
    },
    (payload) => {
      payload.observation.cycles[0].clients[0].process.executableSha256 =
        hash("d");
    },
  ];
  invalidCases.forEach((mutate) => {
    const payload = stagePayload(policy);
    mutate(payload);
    assert.throws(() =>
      summarizeManagedDeviceStagePayload({
        payload,
        externalPolicy: policy,
        dbContract,
      }),
    );
  });
});

const clientResult = ({ controller, profileId }) => ({
  profileId,
  controllerSha256: hash(controller),
  capabilitySha256: hash("4"),
  legacyRawSha256: hash("5"),
  databaseFingerprintSha256: hash("6"),
  invalid: { outcome: "invalid" },
  conflict: { outcome: "conflict" },
  syncQueue: {
    archiveSha256: hash("7"),
    journalSha256: hash("8"),
    payloadSha256: hash("9"),
    wireVersion: 2,
  },
  recovery: {
    checkpointVersion: 1,
    candidateCount: 2,
    rawSha256: hash("a"),
    selectedRevisionSha256: hash("b"),
  },
  cleanup: { callCount: 0, physicalDeleteCount: 0 },
  checkpointSha256: hash("c"),
  rawDatabaseSha256: hash("d"),
});

const binding = (bindingSourceSha, suffix) => ({
  bindingId: `binding-${suffix}`,
  sourceSha: bindingSourceSha,
  releaseRole: "standard",
});

const validatedStage = ({
  sequence,
  runId,
  stageSourceSha,
  controller,
  eventType,
  activationAt,
  observedAt,
  head,
}) => {
  const activeBinding = binding(stageSourceSha, runId);
  return {
    payload: {
      collectorIdentity: { runId, runAttempt: "1" },
      observedAt,
      releaseState: {
        head,
        activation: {
          sequence,
          eventHash: hash(String(sequence)),
          previousHash: sequence === 1 ? null : hash("e"),
          committedAt: activationAt,
          event: { eventType },
        },
        activeBinding,
      },
    },
    receiptSha256: sha256Json({ runId }),
    result: {
      deploymentSourceSha: stageSourceSha,
      deviceFingerprintSha256: hash("f"),
      clients: [
        clientResult({ controller, profileId: "browser-tab" }),
        clientResult({ controller, profileId: "installed-pwa" }),
      ],
    },
  };
};

const multistageFixture = () => {
  const finalHead = { sequence: 9, eventHash: hash("9") };
  const stages = [
    validatedStage({
      sequence: 1,
      runId: "101",
      stageSourceSha: sourceSha,
      controller: "1",
      eventType: "release-accepted",
      activationAt: "2026-08-09T00:00:00.000Z",
      observedAt: "2026-08-09T00:01:00.000Z",
      head: { sequence: 2, eventHash: hash("2") },
    }),
    validatedStage({
      sequence: 5,
      runId: "102",
      stageSourceSha: rollbackSourceSha,
      controller: "2",
      eventType: "rollback-activated",
      activationAt: "2026-08-09T00:10:00.000Z",
      observedAt: "2026-08-09T00:11:00.000Z",
      head: { sequence: 6, eventHash: hash("6") },
    }),
    validatedStage({
      sequence: 9,
      runId: "103",
      stageSourceSha: sourceSha,
      controller: "1",
      eventType: "rollback-activated",
      activationAt: "2026-08-09T00:20:00.000Z",
      observedAt: "2026-08-09T00:21:00.000Z",
      head: finalHead,
    }),
  ];
  return {
    stages,
    current: {
      head: finalHead,
      snapshot: {
        activeProduction: stages[2].payload.releaseState.activeBinding,
      },
    },
    sequenceAuthority: {
      head: finalHead,
      stages: stages.map((stage, index) => ({
        role: ["initial-forward", "rollback", "final-forward"][index],
        activation: structuredClone(stage.payload.releaseState.activation),
        activeBinding: structuredClone(
          stage.payload.releaseState.activeBinding,
        ),
      })),
    },
  };
};

test("managed device multistage aggregator closes three reviewed A-B-A runs", () => {
  for (const authority of [
    "pwa-multiclient-drill",
    "idb-device-compatibility",
  ]) {
    const fixture = multistageFixture();
    const aggregated = aggregateValidatedManagedDeviceStages({
      authority,
      validatedStages: fixture.stages.reverse(),
      current: fixture.current,
      expectedCollectorSourceSha: sourceSha,
      sequenceAuthority: fixture.sequenceAuthority,
    });
    assert.equal(aggregated.document.result.transitionCount, 3);
    assert.deepEqual(
      aggregated.document.stages.map(({ role }) => role),
      ["initial-forward", "rollback", "final-forward"],
    );
    assert.equal(aggregated.document.result.finalSourceSha, sourceSha);
  }
});

test("managed device multistage aggregator rejects stale and tampered chains", () => {
  const cases = [
    ({ stages }) => {
      stages[2].payload.releaseState.head = {
        sequence: 8,
        eventHash: hash("8"),
      };
    },
    ({ stages }) => {
      stages[2].payload.collectorIdentity.runId = "102";
    },
    ({ stages }) => {
      stages[2].result.clients[0].controllerSha256 = hash("2");
    },
    ({ stages }) => {
      stages[1].result.clients[1].cleanup.callCount = 1;
    },
    ({ stages }) => {
      stages[1].result.clients[0].rawDatabaseSha256 = hash("e");
    },
    ({ stages }) => {
      stages[1].payload.releaseState.activation.event.eventType =
        "release-accepted";
    },
  ];
  cases.forEach((mutate) => {
    const fixture = multistageFixture();
    mutate(fixture);
    assert.throws(() =>
      aggregateValidatedManagedDeviceStages({
        authority: "idb-device-compatibility",
        validatedStages: fixture.stages,
        current: fixture.current,
        expectedCollectorSourceSha: sourceSha,
        sequenceAuthority: fixture.sequenceAuthority,
      }),
    );
  });
});
