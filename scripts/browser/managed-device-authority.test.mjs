import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJsonBytes } from "../lib/canonical-json.mjs";
import { verifyExternalPrerequisitePolicy } from "../lib/phase-exit-external-prerequisites.mjs";
import {
  assertConfiguredManagedDeviceExecution,
  assertSignedManagedDeviceReceipt,
  createSignedManagedDeviceReceipt,
  deriveIdbDeviceProfileEvidence,
  derivePwaMulticlientEvidence,
  managedDevicePublicKeyFingerprint,
} from "./managed-device-authority.mjs";
import {
  assertLegacyRollbackCapabilityAbsence,
  resolvePromptCloseAllDrillMode,
  resolveRollbackActivationMode,
  resolveRollbackTargetCapabilityMode,
} from "./prompt-close-all-drill-authority.mjs";

test("resolves prompt-close drill mode as a closed forward-only contract", () => {
  assert.equal(
    resolvePromptCloseAllDrillMode({
      transitionMode: "forward",
      configuredMode: undefined,
    }),
    "required",
  );
  assert.equal(
    resolvePromptCloseAllDrillMode({
      transitionMode: "forward",
      configuredMode: "disabled",
    }),
    "disabled",
  );
  assert.equal(
    resolvePromptCloseAllDrillMode({
      transitionMode: "rollback",
      configuredMode: "disabled",
    }),
    "disabled",
  );
  assert.throws(
    () =>
      resolvePromptCloseAllDrillMode({
        transitionMode: "forward",
        configuredMode: "optional",
      }),
    /exactly required or disabled/,
  );
  assert.throws(
    () =>
      resolvePromptCloseAllDrillMode({
        transitionMode: "rollback",
        configuredMode: "required",
      }),
    /requires a forward transition/,
  );
});

test("resolves rollback capability mode as a closed rollback-only contract", () => {
  assert.equal(
    resolveRollbackTargetCapabilityMode({
      transitionMode: "rollback",
      configuredMode: undefined,
    }),
    "required",
  );
  assert.equal(
    resolveRollbackTargetCapabilityMode({
      transitionMode: "rollback",
      configuredMode: "legacy-absent",
    }),
    "legacy-absent",
  );
  assert.throws(
    () =>
      resolveRollbackTargetCapabilityMode({
        transitionMode: "rollback",
        configuredMode: "optional",
      }),
    /exactly required or legacy-absent/,
  );
  assert.throws(
    () =>
      resolveRollbackTargetCapabilityMode({
        transitionMode: "forward",
        configuredMode: "legacy-absent",
      }),
    /requires a rollback transition/,
  );
});

test("requires an explicit closed rollback activation mode", () => {
  assert.equal(
    resolveRollbackActivationMode({
      transitionMode: "rollback",
      configuredMode: "auto-takeover",
    }),
    "auto-takeover",
  );
  assert.equal(
    resolveRollbackActivationMode({
      transitionMode: "rollback",
      configuredMode: "natural-after-client-release",
    }),
    "natural-after-client-release",
  );
  assert.throws(
    () =>
      resolveRollbackActivationMode({
        transitionMode: "rollback",
        configuredMode: undefined,
      }),
    /must be configured explicitly/,
  );
  assert.throws(
    () =>
      resolveRollbackActivationMode({
        transitionMode: "rollback",
        configuredMode: "optional",
      }),
    /exactly auto-takeover or natural-after-client-release/,
  );
  assert.throws(
    () =>
      resolveRollbackActivationMode({
        transitionMode: "forward",
        configuredMode: "auto-takeover",
      }),
    /requires a rollback transition/,
  );
});

test("accepts only closed evidence that a legacy capability is absent", () => {
  assert.deepEqual(
    assertLegacyRollbackCapabilityAbsence({
      status: 404,
      contentType: "text/plain",
      observation: "other",
    }),
    {
      status: 404,
      contentType: "text/plain",
      observation: "other",
    },
  );
  assert.deepEqual(
    assertLegacyRollbackCapabilityAbsence({
      status: 200,
      contentType: "text/html; charset=utf-8",
      observation: "html-fallback",
    }),
    {
      status: 200,
      contentType: "text/html; charset=utf-8",
      observation: "html-fallback",
    },
  );
  for (const invalid of [
    {
      status: 200,
      contentType: "application/json",
      observation: "release-capability",
    },
    { status: 200, contentType: "text/plain", observation: "other" },
    { status: 500, contentType: "text/html", observation: "html-fallback" },
    {
      status: 404,
      contentType: "text/plain",
      observation: "other",
      callerClaim: true,
    },
  ]) {
    assert.throws(
      () => assertLegacyRollbackCapabilityAbsence(invalid),
      /versioned capability|unknown or missing fields/,
    );
  }
});

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
const approvalPolicy = await loadJson("config/approval-policy.json");
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const runId = "12345";
const runAttempt = "2";
const namespace = "foundation-production";
const now = "2026-08-09T00:00:00.000Z";
const hash = (character) => character.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });

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
  device.attestation.publicKeyFingerprintSha256 =
    managedDevicePublicKeyFingerprint(publicKeyPem);
  device.installedPwaLaunchAuthority.bindingStatus = "configured";
  device.installedPwaLaunchAuthority.forceInstallPolicyValueSha256 = hash("b");
  device.installedPwaLaunchAuthority.installUrl = "https://planner.acme.co/app";
  device.installedPwaLaunchAuthority.applicationId =
    "abcdefghijklmnopabcdefghijklmnop";
  policy.blockerCodes = policy.blockerCodes.filter(
    (code) =>
      !code.startsWith("device-") &&
      code !== "installed-pwa-launch-authority-unconfigured",
  );
  return policy;
};

const oidcReceipt = () => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: approvalPolicy.trustedIssuer,
  audience: approvalPolicy.oidcAudience,
  subject: `repo:${approvalPolicy.repository}:environment:${approvalPolicy.protectedEnvironment}`,
  tokenSha256: hash("1"),
  signingKey: { kid: "fixture-key", jwkThumbprintSha256: hash("2") },
  claims: {
    environment: approvalPolicy.protectedEnvironment,
    eventName: "workflow_dispatch",
    expiresAt: "2026-08-09T00:10:00.000Z",
    issuedAt: now,
    jti: "managed-device-fixture-jti",
    notBefore: now,
    ref: "refs/heads/main",
    refProtected: true,
    repository: approvalPolicy.repository,
    runAttempt,
    runId,
    sourceSha,
    workflowRef: approvalPolicy.workflowRef,
    workflowSha: sourceSha,
  },
  verifiedAt: now,
});

const deployment = {
  bindingId: "accepted-standard-binding",
  sourceSha,
  releaseRole: "standard",
  providerProjectId: "project-id",
  providerDeploymentId: "deployment-id",
  deploymentUrl: "https://accepted.example.test/",
  selection: "active-accepted-standard",
  policyEligibility: "active-policy",
};

const rollbackDeployment = {
  bindingId: "eligible-rollback-binding",
  sourceSha: "f".repeat(40),
  releaseRole: "standard",
  providerProjectId: "project-id",
  providerDeploymentId: "rollback-deployment-id",
  deploymentUrl: "https://rollback.example.test/",
  selection: "eligible-rollback-standard",
  policyEligibility: "current-rollback-inventory",
};

const host = (policy) => ({
  runnerGroup: policy.managedDeviceExecution.runnerGroup,
  runnerLabels: [...policy.managedDeviceExecution.requiredLabels],
  operatingSystem: {
    family: "windows",
    release: "11",
    architecture: "x64",
    buildNumber: "10.0.26100",
  },
  browser: {
    family: "chromium",
    binaryPath: policy.managedDeviceExecution.browser.binaryPath,
    binarySha256: hash("3"),
    version: policy.managedDeviceExecution.browser.exactVersion,
    enrollmentIdSha256:
      policy.managedDeviceExecution.browser.managedEnrollmentIdSha256,
  },
  policy: {
    forceInstallPolicyName: "WebAppInstallForceList",
    forceInstallPolicyValueSha256: hash("b"),
    installUrl: "https://planner.acme.co/app",
    applicationId: "abcdefghijklmnopabcdefghijklmnop",
    observedPolicyResult: "OK",
  },
  appLaunch: {
    applicationId: "abcdefghijklmnopabcdefghijklmnop",
    shortcutPathSha256: hash("4"),
    targetBinarySha256: hash("5"),
    argumentsSha256: hash("6"),
    processExecutableSha256: hash("7"),
    processCommandLineSha256: hash("8"),
  },
  profiles: [
    {
      profileId: "browser-tab",
      profileName: "foundation-browser-tab",
      profilePathSha256: hash("9"),
      initialProcessId: 101,
      reopenedProcessId: 321,
    },
    {
      profileId: "installed-pwa",
      profileName: "foundation-installed-pwa",
      profilePathSha256: hash("a"),
      initialProcessId: 102,
      reopenedProcessId: 322,
    },
  ],
});

const idbStores = () =>
  Object.entries(dbContract.indexedDb.stores)
    .map(([name, value]) => ({
      indexes: value.indexes,
      keyPath: value.keyPath,
      name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const rawDatabase = (profileIndex, phaseIndex) => ({
  name: dbContract.indexedDb.name,
  version: dbContract.indexedDb.version,
  stores: idbStores(),
  raw: {
    archive: { schemaVersion: 1, entries: [{ profileIndex, phaseIndex }] },
    checkpoint: {
      kind: "event-shopping-planner-persistence-checkpoint",
      version: 1,
      storeName: "eventMetadata",
      key: "data",
      committedRoot: {
        revision: `revision-${profileIndex}-${phaseIndex}`,
        digest: { algorithm: "SHA-256", value: hash("d") },
      },
    },
    journal: {
      schemaVersion: 2,
      phase: "verified",
      dataMigrationStatus: "verified",
      entries: [{ profileIndex }, { phaseIndex }],
    },
    syncQueuePayload: [{ id: "queue" }],
  },
});

const promptCloseAllDrill = (profileIndex) => {
  const phase = ({
    action,
    actionVisible,
    blockerCount,
    closeGuidanceVisible,
    flushFailureCount = 0,
    phase: phaseName,
    responsiveCount,
    saveOperationCount,
    snapshotCount = 3,
    unresponsiveCount,
  }) => ({
    phase: phaseName,
    snapshotCount,
    responsiveCount,
    blockerCount,
    unresponsiveCount,
    flushFailureCount,
    saveOperationCount,
    action,
    actionVisible,
    closeGuidanceVisible,
  });
  const roles = ["primary", "secondary", "standalone-equivalent"];
  const waitingVersionId = `waiting-${profileIndex}`;
  return {
    schemaVersion: 1,
    kind: "prompt-close-all-browser-drill/v1",
    clientRoles: roles,
    blockerFixture:
      "synthetic-protocol-blocker-with-real-event-autosave-persistence",
    interaction: {
      initialAction: "playwright-click",
      retryAction: "playwright-click",
      operationCount: 2,
      eventAutosaveBlockerObserved: true,
      eventAutosaveMutationPersistedAfterInitialAction: true,
      persistedItemCount: 1,
    },
    preflush: phase({
      phase: "save-required",
      responsiveCount: 3,
      blockerCount: 1,
      unresponsiveCount: 0,
      saveOperationCount: 0,
      action: "save-and-flush",
      actionVisible: true,
      closeGuidanceVisible: false,
    }),
    failedClosed: {
      cause: "frozen-unresponsive-client",
      ...phase({
        phase: "save-incomplete",
        responsiveCount: 2,
        blockerCount: 0,
        unresponsiveCount: 1,
        saveOperationCount: 1,
        action: "retry",
        actionVisible: true,
        closeGuidanceVisible: false,
      }),
    },
    postflush: phase({
      phase: "ready-to-close",
      responsiveCount: 3,
      blockerCount: 0,
      unresponsiveCount: 0,
      saveOperationCount: 2,
      action: null,
      actionVisible: false,
      closeGuidanceVisible: true,
    }),
    snapshotRequests: roles.map((role) => ({
      role,
      inspectionCount: 1,
      flushCount: 1,
      productionFlushCount: 1,
      productionFlushResponseCount: 1,
      productionCleanFlushResponseCount: 1,
    })),
    controllerBeforeClose: {
      fromArtifactId: rollbackDeployment.sourceSha,
      targetArtifactId: sourceSha,
      waitingVersionId,
      clients: roles.map((role) => ({
        role,
        activeState: "activated",
        waitingState: "installed",
        controllerState: "activated",
        controllerScriptUrl: "http://127.0.0.1:4173/sw.js",
        controllerChangeCountDelta: 0,
      })),
    },
    release: {
      releasedClientCount: 3,
      releasedTargetCount: 3,
      remainingOriginClientCount: 0,
      startedAfterReadyToClose: true,
    },
    naturalActivation: {
      outcome: "natural-after-all-clients-closed",
      versionId: waitingVersionId,
      stableAfterReopen: true,
      reopenedClientCount: 2,
    },
  };
};

const rawPwaObservation = (profileIndex, phaseIndex) => {
  const common = {
    browserProcessId: 301 + profileIndex + phaseIndex * 10,
    previewOrigin: "http://127.0.0.1:4173/",
    recoveryScreenVisible: false,
    database: rawDatabase(profileIndex, phaseIndex),
    legacySources: {
      rawValues: { eventMetadata: "{}", syncQueue: "[]" },
      physicalDeleteCount: 0,
    },
    surfaces: {
      normalTab: true,
      standaloneAppWindowEquivalent: true,
    },
  };
  if (phaseIndex === 0) {
    return {
      ...common,
      result: "PREFLIGHT_PASS",
      buildId: sourceSha,
      serviceWorker: {
        controlled: true,
        activeState: "activated",
        buildIdentityMatched: true,
        activeSource: { byteLength: 100, sha256: hash("c") },
        offlineControllerIdentity: { buildId: sourceSha },
      },
    };
  }
  if (phaseIndex === 1) {
    return {
      ...common,
      result: "PASS",
      mode: "rollback",
      fromArtifactId: sourceSha,
      targetArtifactId: rollbackDeployment.sourceSha,
      rollbackArtifactLoaded: true,
      activeServiceWorker: { byteLength: 100, sha256: hash("c") },
      offlineControllerIdentity: { buildId: rollbackDeployment.sourceSha },
      controllerChangeCount: 1,
    };
  }
  return {
    ...common,
    result: "PASS",
    mode: "forward",
    fromArtifactId: rollbackDeployment.sourceSha,
    targetArtifactId: sourceSha,
    activeServiceWorker: { byteLength: 100, sha256: hash("c") },
    offlineControllerIdentity: { buildId: sourceSha },
    controllerChangeCount: 1,
    naturalActivation: {
      promptCloseAll: promptCloseAllDrill(profileIndex),
    },
  };
};

const pwaEvidence = (policy, hostValue) => {
  const profileTransitions = ["browser-tab", "installed-pwa"].map(
    (profileId, profileIndex) => ({
      schemaVersion: 1,
      kind: "managed-device-profile-transition/v1",
      profileId,
      currentSourceSha: sourceSha,
      rollbackSourceSha: rollbackDeployment.sourceSha,
      profilePathSha256: hostValue.profiles[profileIndex].profilePathSha256,
      observations: {
        initialForward: rawPwaObservation(profileIndex, 0),
        rollback: rawPwaObservation(profileIndex, 1),
        finalForward: rawPwaObservation(profileIndex, 2),
      },
    }),
  );
  const derived = derivePwaMulticlientEvidence({
    profileTransitions,
    host: hostValue,
    sourceSha,
    rollbackSourceSha: rollbackDeployment.sourceSha,
    devicePolicy: policy.managedDeviceExecution,
  });
  return {
    profileLaunches: structuredClone(derived.profileLaunches),
    profileTransitions,
    transitions: structuredClone(derived.transitions),
  };
};

const idbEvidence = (policy) => ({
  profiles: ["browser-tab", "installed-pwa"].map((profileId, index) => {
    const conflictFixture = {
      orphanStorageKey: `esp:idb-fallback:v1:eventMetadata:data:orphan-${index}`,
      rawValue: `conflict-${index}`,
    };
    const rawReceipt = {
      schemaVersion: 1,
      kind: "managed-device-idb-profile-probe/v1",
      profileId,
      sourceSha,
      profilePathSha256: host(policy).profiles[index].profilePathSha256,
      browserProcessId: 321 + index,
      controller: {
        scriptUrl: "http://127.0.0.1:4173/sw.js",
        sourceBytesBase64: Buffer.from("service-worker-source").toString(
          "base64",
        ),
      },
      database: rawDatabase(index, 3),
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
    };
    const derived = deriveIdbDeviceProfileEvidence({
      rawReceipt,
      expectedProfile: policy.managedDeviceExecution.deviceProfiles[index],
      dbContract,
    });
    return {
      profileId,
      rawReceipt,
      ...structuredClone(derived),
    };
  }),
});

const payload = (authority, policy) => {
  const hostValue = host(policy);
  return {
    schemaVersion: 1,
    kind: "managed-device-raw-authority/v1",
    authority,
    namespace,
    sourceSha,
    collectorIdentity: {
      repository: approvalPolicy.repository,
      workflowPath: ".github/workflows/release.yml",
      sourceSha,
      runId,
      runAttempt,
    },
    oidcReceipt: oidcReceipt(),
    externalPrerequisitePolicySha256:
      verifyExternalPrerequisitePolicy(policy).policySha256,
    deployment: structuredClone(deployment),
    rollbackDeployment:
      authority === "pwa-multiclient-drill"
        ? structuredClone(rollbackDeployment)
        : null,
    observedAt: now,
    host: hostValue,
    evidence:
      authority === "pwa-multiclient-drill"
        ? pwaEvidence(policy, hostValue)
        : idbEvidence(policy),
  };
};

const validation = (authority, policy) => ({
  authority,
  externalPolicy: policy,
  approvalPolicy,
  dbContract,
  expectedSourceSha: sourceSha,
  expectedRunId: runId,
  expectedRunAttempt: runAttempt,
  expectedDeployment: deployment,
  expectedRollbackDeployment:
    authority === "pwa-multiclient-drill" ? rollbackDeployment : null,
});

test("fails managed-device policy before any live adapter can start", () => {
  assert.throws(
    () => assertConfiguredManagedDeviceExecution(baseExternalPolicy),
    /unconfigured/,
  );
});

for (const authority of ["pwa-multiclient-drill", "idb-device-compatibility"]) {
  test(`${authority} signs canonical raw evidence and derives its result`, () => {
    const policy = configuredExternalPolicy();
    const receipt = createSignedManagedDeviceReceipt({
      payload: payload(authority, policy),
      privateKeyPem,
      publicKeyPem,
      validation: validation(authority, policy),
    });
    const verified = assertSignedManagedDeviceReceipt(
      receipt,
      validation(authority, policy),
    );
    assert.match(verified.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      authority === "pwa-multiclient-drill"
        ? verified.result.transitionCount
        : verified.result.profileCount,
      authority === "pwa-multiclient-drill" ? 3 : 2,
    );

    const tampered = structuredClone(receipt);
    tampered.payload.observedAt = "2026-08-09T00:00:01.000Z";
    assert.throws(
      () =>
        assertSignedManagedDeviceReceipt(
          tampered,
          validation(authority, policy),
        ),
      /signature/,
    );
  });
}

test("rejects caller client/status/installed claims and incomplete PWA lifecycle", () => {
  const policy = configuredExternalPolicy();
  for (const mutate of [
    (value) => {
      value.evidence.clientKind = "installed-pwa";
    },
    (value) => {
      value.evidence.status = "passed";
    },
    (value) => {
      value.evidence.installed = true;
    },
    (value) => {
      value.evidence.transitions[1].phase = "forward";
    },
    (value) => {
      value.evidence.transitions[2].cleanupPhysicalDeleteCount = 1;
    },
    (value) => {
      value.evidence.profileLaunches[1].displayMode = "browser";
    },
  ]) {
    const candidate = payload("pwa-multiclient-drill", policy);
    mutate(candidate);
    assert.throws(
      () =>
        createSignedManagedDeviceReceipt({
          payload: candidate,
          privateKeyPem,
          publicKeyPem,
          validation: validation("pwa-multiclient-drill", policy),
        }),
      /unexpected|transition|cleanup|launch|summaries|raw device receipts/,
    );
  }
});

test("rejects incomplete or tampered prompt-close browser evidence", () => {
  const policy = configuredExternalPolicy();
  for (const mutate of [
    (value) => {
      delete value.preflush.action;
    },
    (value) => {
      value.postflush.unexpected = true;
    },
    (value) => {
      value.failedClosed.closeGuidanceVisible = true;
    },
    (value) => {
      value.snapshotRequests[1].flushCount = 0;
    },
    (value) => {
      value.snapshotRequests[1].productionFlushResponseCount = 0;
    },
    (value) => {
      value.interaction.eventAutosaveBlockerObserved = false;
    },
    (value) => {
      value.interaction.eventAutosaveMutationPersistedAfterInitialAction = false;
    },
    (value) => {
      value.controllerBeforeClose.clients[0].controllerChangeCountDelta = 1;
    },
    (value) => {
      value.release.remainingOriginClientCount = 1;
    },
    (value) => {
      value.naturalActivation.versionId = "substituted";
    },
  ]) {
    const candidate = payload("pwa-multiclient-drill", policy);
    const promptCloseAll =
      candidate.evidence.profileTransitions[0].observations.finalForward
        .naturalActivation.promptCloseAll;
    mutate(promptCloseAll);
    assert.throws(
      () =>
        createSignedManagedDeviceReceipt({
          payload: candidate,
          privateKeyPem,
          publicKeyPem,
          validation: validation("pwa-multiclient-drill", policy),
        }),
      /Prompt-close/,
    );
  }
});

test("rejects IDB invalid/conflict, fingerprint, syncQueue, and cleanup drift", () => {
  const policy = configuredExternalPolicy();
  for (const mutate of [
    (value) => {
      value.evidence.profiles[0].invalid.outcome = "valid";
    },
    (value) => {
      value.evidence.profiles[0].conflict.outcome = "resolved";
    },
    (value) => {
      value.evidence.profiles[0].database.version += 1;
    },
    (value) => {
      value.evidence.profiles[0].syncQueue.wireVersion = 1;
    },
    (value) => {
      value.evidence.profiles[0].recovery.candidateCount = 1;
    },
    (value) => {
      value.evidence.profiles[0].cleanup.callCount = 1;
    },
  ]) {
    const candidate = payload("idb-device-compatibility", policy);
    mutate(candidate);
    assert.throws(
      () =>
        createSignedManagedDeviceReceipt({
          payload: candidate,
          privateKeyPem,
          publicKeyPem,
          validation: validation("idb-device-compatibility", policy),
        }),
      /IDB|cleanup/,
    );
  }
});

test("rejects an attestation key outside the configured fingerprint", () => {
  const policy = configuredExternalPolicy();
  policy.managedDeviceExecution.attestation.publicKeyFingerprintSha256 =
    hash("f");
  const candidate = payload("pwa-multiclient-drill", policy);
  const receipt = createSignedManagedDeviceReceipt({
    payload: candidate,
    privateKeyPem,
    publicKeyPem,
    validation: validation("pwa-multiclient-drill", policy),
  });
  assert.throws(
    () =>
      assertSignedManagedDeviceReceipt(
        receipt,
        validation("pwa-multiclient-drill", policy),
      ),
    /fingerprint/,
  );
});
