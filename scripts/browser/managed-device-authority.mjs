import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { verifyExternalPrerequisitePolicy } from "../lib/phase-exit-external-prerequisites.mjs";
import { assertStoredGitHubOidcReceipt } from "../release-state/githubOidc.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  resolveProductionRequestGraphBinding,
} from "./production-request-graph.mjs";
import { assertPromptCloseAllBrowserDrill } from "./prompt-close-all-drill-authority.mjs";

export const MANAGED_DEVICE_AUTHORITIES = Object.freeze([
  "idb-device-compatibility",
  "pwa-multiclient-drill",
]);

export const MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES = Object.freeze({
  "idb-device-compatibility":
    "application/vnd.event-shopping-planner.idb-device-compatibility+json;version=1",
  "pwa-multiclient-drill":
    "application/vnd.event-shopping-planner.pwa-multiclient-drill+json;version=1",
});

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\\[^\0\r\n]+$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (value, expected, label) => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has an unexpected property set`);
  }
};

const assertSha256 = (value, label) => {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} is invalid`);
};

const assertTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not canonical`);
  }
  return milliseconds;
};

const sameJson = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertString = (value, label, maximum = 1024) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const assertProcessId = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid`);
  }
};

const assertHttpsOriginOrPath = (
  value,
  label,
  { allowLoopback = false } = {},
) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    (url.protocol !== "https:" &&
      !(
        allowLoopback &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} is not a trusted HTTPS URL`);
  }
  return url;
};

const deviceBlocker = (code) =>
  code.startsWith("device-") ||
  code === "installed-pwa-launch-authority-unconfigured";

export const assertConfiguredManagedDeviceExecution = (policy) => {
  const report = verifyExternalPrerequisitePolicy(policy);
  const device = policy.managedDeviceExecution;
  const blockers = report.blockerCodes.filter(deviceBlocker);
  if (
    device?.bindingStatus !== "configured" ||
    device.installedPwaLaunchAuthority?.bindingStatus !== "configured" ||
    blockers.length !== 0
  ) {
    throw new Error(
      `Managed device execution is unconfigured: ${blockers.join(", ") || "binding-status"}`,
    );
  }
  return Object.freeze({
    device,
    policySha256: report.policySha256,
  });
};

export const resolveManagedDeviceAcceptedDeployment = ({
  current,
  namespace,
  sourceSha,
  nowMilliseconds = Date.now(),
  requireRollback = false,
}) => {
  const selected = resolveProductionRequestGraphBinding({
    current,
    namespace,
    sourceSha,
    nowMilliseconds,
  });
  const accepted = current?.snapshot?.acceptedStandard;
  const active = current?.snapshot?.activeProduction;
  if (
    current.snapshot.pendingOperation !== null ||
    selected.projection.selection !== "active-production" ||
    selected.binding.releaseRole !== "standard" ||
    selected.binding.sourceSha !== sourceSha ||
    accepted === null ||
    active === null ||
    !sameJson(accepted, active) ||
    !sameJson(selected.binding, accepted)
  ) {
    throw new Error(
      "Managed device drill requires the exact idle active accepted standard",
    );
  }
  const rollbackEntries = (current.snapshot.rollbackInventory ?? []).filter(
    (entry) =>
      entry.eligibility === "eligible" &&
      entry.eligibleActions?.includes("rollback") &&
      entry.binding?.releaseRole === "standard" &&
      entry.binding.sourceSha !== sourceSha,
  );
  if (requireRollback && rollbackEntries.length !== 1) {
    throw new Error(
      "Managed device PWA drill requires exactly one current eligible rollback binding",
    );
  }
  const rollbackBinding = requireRollback ? rollbackEntries[0].binding : null;
  const rollbackProjection =
    rollbackBinding === null
      ? null
      : Object.freeze({
          bindingId: rollbackBinding.bindingId,
          deploymentUrl: rollbackBinding.deploymentUrl,
          policyEligibility: "current-rollback-inventory",
          providerDeploymentId: rollbackBinding.providerDeploymentId,
          providerProjectId: rollbackBinding.providerProjectId,
          releaseRole: rollbackBinding.releaseRole,
          selection: "eligible-rollback-standard",
          sourceSha: rollbackBinding.sourceSha,
        });
  return Object.freeze({
    binding: selected.binding,
    projection: Object.freeze({
      ...selected.projection,
      selection: "active-accepted-standard",
    }),
    rollbackBinding,
    rollbackProjection,
  });
};

const exportPublicSpki = (publicKey) =>
  publicKey.export({ format: "der", type: "spki" });

export const managedDevicePublicKeyFingerprint = (publicKeyInput) => {
  const publicKey = createPublicKey(publicKeyInput);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Managed device attestation key is not Ed25519");
  }
  return sha256Bytes(exportPublicSpki(publicKey));
};

const assertPublicKey = ({ publicKeySpkiBase64, expectedFingerprint }) => {
  if (
    typeof publicKeySpkiBase64 !== "string" ||
    !BASE64.test(publicKeySpkiBase64)
  ) {
    throw new Error("Managed device attestation public key is not canonical");
  }
  const bytes = Buffer.from(publicKeySpkiBase64, "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64") !== publicKeySpkiBase64 ||
    sha256Bytes(bytes) !== expectedFingerprint
  ) {
    throw new Error(
      "Managed device attestation public key fingerprint differs",
    );
  }
  const publicKey = createPublicKey({
    key: bytes,
    format: "der",
    type: "spki",
  });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Managed device attestation public key is not Ed25519");
  }
  return publicKey;
};

const assertDeployment = (
  deployment,
  expected = null,
  selection = "active-accepted-standard",
) => {
  assertExactKeys(
    deployment,
    [
      "bindingId",
      "deploymentUrl",
      "policyEligibility",
      "providerDeploymentId",
      "providerProjectId",
      "releaseRole",
      "selection",
      "sourceSha",
    ],
    "Managed device deployment",
  );
  if (
    deployment.releaseRole !== "standard" ||
    deployment.selection !== selection ||
    !SOURCE_SHA.test(deployment.sourceSha ?? "")
  ) {
    throw new Error("Managed device deployment is not an accepted standard");
  }
  for (const key of [
    "bindingId",
    "providerDeploymentId",
    "providerProjectId",
  ]) {
    assertString(deployment[key], `Managed device deployment ${key}`, 255);
  }
  assertHttpsOriginOrPath(
    deployment.deploymentUrl,
    "Managed device deployment URL",
  );
  assertString(
    deployment.policyEligibility,
    "Managed device deployment policy eligibility",
    64,
  );
  if (expected !== null && !sameJson(deployment, expected)) {
    throw new Error(
      "Managed device deployment differs from current acceptance",
    );
  }
};

const assertHostProfile = (profile, expected) => {
  assertExactKeys(
    profile,
    [
      "initialProcessId",
      "profileId",
      "profileName",
      "profilePathSha256",
      "reopenedProcessId",
    ],
    "Managed device profile observation",
  );
  if (
    profile.profileId !== expected.id ||
    profile.profileName !== expected.profileName ||
    profile.initialProcessId === profile.reopenedProcessId
  ) {
    throw new Error("Managed device profile observation differs from policy");
  }
  assertProcessId(profile.initialProcessId, "Managed device initial process");
  assertProcessId(profile.reopenedProcessId, "Managed device reopened process");
  assertSha256(profile.profilePathSha256, "Managed device profile path");
};

const assertManagedHost = (host, devicePolicy) => {
  assertExactKeys(
    host,
    [
      "appLaunch",
      "browser",
      "operatingSystem",
      "policy",
      "profiles",
      "runnerGroup",
      "runnerLabels",
    ],
    "Managed device host",
  );
  if (
    host.runnerGroup !== devicePolicy.runnerGroup ||
    !sameJson(host.runnerLabels, devicePolicy.requiredLabels)
  ) {
    throw new Error("Managed device runner authority differs");
  }
  assertExactKeys(
    host.operatingSystem,
    ["architecture", "buildNumber", "family", "release"],
    "Managed device operating system",
  );
  if (
    host.operatingSystem.family !== devicePolicy.operatingSystem.family ||
    host.operatingSystem.release !== devicePolicy.operatingSystem.release ||
    host.operatingSystem.architecture !==
      devicePolicy.operatingSystem.architecture ||
    !/^[0-9]+(?:\.[0-9]+){0,3}$/u.test(host.operatingSystem.buildNumber ?? "")
  ) {
    throw new Error("Managed device operating system differs");
  }
  assertExactKeys(
    host.browser,
    ["binaryPath", "binarySha256", "enrollmentIdSha256", "family", "version"],
    "Managed device browser",
  );
  if (
    host.browser.family !== devicePolicy.browser.family ||
    host.browser.binaryPath !== devicePolicy.browser.binaryPath ||
    host.browser.version !== devicePolicy.browser.exactVersion ||
    !WINDOWS_ABSOLUTE_PATH.test(host.browser.binaryPath ?? "") ||
    host.browser.enrollmentIdSha256 !==
      devicePolicy.browser.managedEnrollmentIdSha256
  ) {
    throw new Error("Managed device browser authority differs");
  }
  assertSha256(host.browser.binarySha256, "Managed device browser binary");
  assertExactKeys(
    host.policy,
    [
      "applicationId",
      "forceInstallPolicyName",
      "forceInstallPolicyValueSha256",
      "installUrl",
      "observedPolicyResult",
    ],
    "Managed PWA policy observation",
  );
  const launch = devicePolicy.installedPwaLaunchAuthority;
  if (
    host.policy.forceInstallPolicyName !== launch.forceInstallPolicyName ||
    host.policy.forceInstallPolicyValueSha256 !==
      launch.forceInstallPolicyValueSha256 ||
    host.policy.installUrl !== launch.installUrl ||
    host.policy.applicationId !== launch.applicationId ||
    host.policy.observedPolicyResult !== launch.requiredPolicyStatus
  ) {
    throw new Error("Managed PWA force-install policy differs");
  }
  assertExactKeys(
    host.appLaunch,
    [
      "applicationId",
      "argumentsSha256",
      "processCommandLineSha256",
      "processExecutableSha256",
      "shortcutPathSha256",
      "targetBinarySha256",
    ],
    "Managed PWA application launch",
  );
  if (host.appLaunch.applicationId !== launch.applicationId) {
    throw new Error("Managed PWA application launch ID differs");
  }
  for (const key of Object.keys(host.appLaunch).filter((key) =>
    key.endsWith("Sha256"),
  )) {
    assertSha256(host.appLaunch[key], `Managed PWA application launch ${key}`);
  }
  if (
    !Array.isArray(host.profiles) ||
    host.profiles.length !== devicePolicy.deviceProfiles.length
  ) {
    throw new Error("Managed device profile set differs");
  }
  host.profiles.forEach((profile, index) =>
    assertHostProfile(profile, devicePolicy.deviceProfiles[index]),
  );
};

const assertHashProjection = (value, keys, label) => {
  assertExactKeys(value, keys, label);
  for (const key of keys.filter((key) => key.endsWith("Sha256"))) {
    assertSha256(value[key], `${label} ${key}`);
  }
};

const assertTransition = (transition, index, profileIds) => {
  assertExactKeys(
    transition,
    [
      "checkpoint",
      "cleanupPhysicalDeleteCount",
      "closedProcessIds",
      "controller",
      "fromBuildId",
      "journal",
      "legacyRawSha256",
      "phase",
      "profileIds",
      "reopenedProcessIds",
      "sequence",
      "toBuildId",
    ],
    "Managed PWA transition",
  );
  const phase = ["forward", "rollback", "forward"][index];
  if (
    transition.sequence !== index + 1 ||
    transition.phase !== phase ||
    !SOURCE_SHA.test(transition.fromBuildId ?? "") ||
    !SOURCE_SHA.test(transition.toBuildId ?? "") ||
    transition.fromBuildId === transition.toBuildId ||
    transition.cleanupPhysicalDeleteCount !== 0 ||
    !sameJson(transition.profileIds, profileIds)
  ) {
    throw new Error("Managed PWA transition semantics differ");
  }
  for (const key of ["closedProcessIds", "reopenedProcessIds"]) {
    if (
      !Array.isArray(transition[key]) ||
      transition[key].length !== profileIds.length ||
      new Set(transition[key]).size !== transition[key].length
    ) {
      throw new Error(`Managed PWA transition ${key} differs`);
    }
    transition[key].forEach((id) =>
      assertProcessId(id, `Managed PWA transition ${key}`),
    );
  }
  if (
    transition.closedProcessIds.some((id) =>
      transition.reopenedProcessIds.includes(id),
    )
  ) {
    throw new Error("Managed PWA transition did not close every client");
  }
  assertExactKeys(
    transition.controller,
    ["changeCount", "offlineIdentitySha256", "scriptSourceSha256", "scriptUrl"],
    "Managed PWA controller evidence",
  );
  if (
    !Number.isSafeInteger(transition.controller.changeCount) ||
    transition.controller.changeCount < 1
  ) {
    throw new Error("Managed PWA controller change was not observed");
  }
  assertHttpsOriginOrPath(
    transition.controller.scriptUrl,
    "Managed PWA controller script",
    { allowLoopback: true },
  );
  assertSha256(
    transition.controller.offlineIdentitySha256,
    "Managed PWA offline controller identity",
  );
  assertSha256(
    transition.controller.scriptSourceSha256,
    "Managed PWA controller source",
  );
  assertHashProjection(
    transition.checkpoint,
    ["digestSha256", "key", "kind", "revisionSha256", "storeName", "version"],
    "Managed PWA checkpoint",
  );
  if (
    transition.checkpoint.kind !==
      "event-shopping-planner-persistence-checkpoint" ||
    transition.checkpoint.version !== 1 ||
    transition.checkpoint.storeName !== "eventMetadata" ||
    transition.checkpoint.key !== "data"
  ) {
    throw new Error("Managed PWA checkpoint semantics differ");
  }
  assertHashProjection(
    transition.journal,
    [
      "archiveSha256",
      "dataMigrationOutcome",
      "entryCount",
      "phase",
      "rawSha256",
      "schemaVersion",
    ],
    "Managed PWA migration journal",
  );
  if (
    transition.journal.schemaVersion !== 2 ||
    !["verified", "cleanup-ready"].includes(transition.journal.phase) ||
    transition.journal.dataMigrationOutcome !== "verified" ||
    !Number.isSafeInteger(transition.journal.entryCount) ||
    transition.journal.entryCount < 0
  ) {
    throw new Error("Managed PWA migration journal semantics differ");
  }
  assertSha256(transition.legacyRawSha256, "Managed PWA legacy raw evidence");
};

const assertRawBrowserProcess = (value, label) => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertProcessId(value.browserProcessId, `${label} browser process`);
  assertString(value.previewOrigin, `${label} preview origin`);
  const origin = new URL(value.previewOrigin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(`${label} did not use the isolated loopback origin`);
  }
};

const rawTransitionDocuments = ({
  profileTransitions,
  profileIds,
  sourceSha,
  rollbackSourceSha,
}) => {
  if (
    !Array.isArray(profileTransitions) ||
    profileTransitions.length !== profileIds.length
  ) {
    throw new Error("Managed PWA raw profile transition set differs");
  }
  return profileTransitions.map((document, index) => {
    assertExactKeys(
      document,
      [
        "currentSourceSha",
        "kind",
        "observations",
        "profileId",
        "profilePathSha256",
        "rollbackSourceSha",
        "schemaVersion",
      ],
      "Managed PWA raw profile transition",
    );
    assertExactKeys(
      document.observations,
      ["finalForward", "initialForward", "rollback"],
      "Managed PWA raw transition observations",
    );
    if (
      document.schemaVersion !== 1 ||
      document.kind !== "managed-device-profile-transition/v1" ||
      document.profileId !== profileIds[index] ||
      document.currentSourceSha !== sourceSha ||
      document.rollbackSourceSha !== rollbackSourceSha
    ) {
      throw new Error("Managed PWA raw transition identity differs");
    }
    assertSha256(
      document.profilePathSha256,
      "Managed PWA raw transition profile path",
    );
    const { initialForward, rollback, finalForward } = document.observations;
    for (const [label, observation] of [
      ["initial forward", initialForward],
      ["rollback", rollback],
      ["final forward", finalForward],
    ]) {
      assertRawBrowserProcess(
        observation,
        `Managed PWA ${document.profileId} ${label}`,
      );
    }
    if (
      initialForward.result !== "PREFLIGHT_PASS" ||
      initialForward.buildId !== sourceSha ||
      initialForward.serviceWorker?.controlled !== true ||
      initialForward.serviceWorker?.activeState !== "activated" ||
      initialForward.serviceWorker?.buildIdentityMatched !== true ||
      initialForward.surfaces?.normalTab !== true ||
      initialForward.surfaces?.standaloneAppWindowEquivalent !== true ||
      rollback.result !== "PASS" ||
      rollback.mode !== "rollback" ||
      rollback.fromArtifactId !== sourceSha ||
      rollback.targetArtifactId !== rollbackSourceSha ||
      rollback.rollbackArtifactLoaded !== true ||
      rollback.surfaces?.normalTab !== true ||
      rollback.surfaces?.standaloneAppWindowEquivalent !== true ||
      finalForward.result !== "PASS" ||
      finalForward.mode !== "forward" ||
      finalForward.fromArtifactId !== rollbackSourceSha ||
      finalForward.targetArtifactId !== sourceSha ||
      finalForward.surfaces?.normalTab !== true ||
      finalForward.surfaces?.standaloneAppWindowEquivalent !== true ||
      initialForward.recoveryScreenVisible !== false ||
      rollback.recoveryScreenVisible !== false ||
      finalForward.recoveryScreenVisible !== false
    ) {
      throw new Error("Managed PWA raw browser lifecycle differs");
    }
    assertPromptCloseAllBrowserDrill(
      finalForward.naturalActivation?.promptCloseAll,
      {
        expectedFromArtifactId: rollbackSourceSha,
        expectedServiceWorkerUrl: new URL("/sw.js", finalForward.previewOrigin)
          .href,
        expectedTargetArtifactId: sourceSha,
      },
    );
    return document;
  });
};

const rawDatabaseProjection = (documents, observationName) => {
  const databases = documents.map(
    (document) => document.observations[observationName].database,
  );
  const checkpoints = databases.map((database) => database?.raw?.checkpoint);
  const journals = databases.map((database) => database?.raw?.journal);
  const archives = databases.map((database) => database?.raw?.archive);
  for (const checkpoint of checkpoints) {
    if (
      checkpoint?.kind !== "event-shopping-planner-persistence-checkpoint" ||
      checkpoint.version !== 1 ||
      checkpoint.storeName !== "eventMetadata" ||
      checkpoint.key !== "data" ||
      typeof checkpoint.committedRoot?.revision !== "string" ||
      checkpoint.committedRoot.revision.length === 0 ||
      checkpoint.committedRoot.digest?.algorithm !== "SHA-256" ||
      typeof checkpoint.committedRoot.digest?.value !== "string" ||
      checkpoint.committedRoot.digest.value.length === 0
    ) {
      throw new Error("Managed PWA raw checkpoint differs");
    }
  }
  for (const journal of journals) {
    if (
      journal?.schemaVersion !== 2 ||
      !["verified", "cleanup-ready"].includes(journal.phase) ||
      journal.dataMigrationStatus !== "verified" ||
      !Array.isArray(journal.entries)
    ) {
      throw new Error("Managed PWA raw migration journal differs");
    }
  }
  if (archives.some((archive) => archive?.schemaVersion !== 1)) {
    throw new Error("Managed PWA raw migration archive differs");
  }
  return Object.freeze({
    checkpoint: Object.freeze({
      kind: checkpoints[0].kind,
      version: checkpoints[0].version,
      storeName: checkpoints[0].storeName,
      key: checkpoints[0].key,
      revisionSha256: sha256Json(
        checkpoints.map(({ committedRoot }) => committedRoot.revision),
      ),
      digestSha256: sha256Json(
        checkpoints.map(({ committedRoot }) => committedRoot.digest.value),
      ),
    }),
    journal: Object.freeze({
      schemaVersion: journals[0].schemaVersion,
      phase: journals[0].phase,
      dataMigrationOutcome: journals[0].dataMigrationStatus,
      entryCount: journals.reduce(
        (total, journal) => total + journal.entries.length,
        0,
      ),
      archiveSha256: sha256Json(archives),
      rawSha256: sha256Json(journals),
    }),
  });
};

const rawControllerProjection = (documents, observationName) => {
  const observations = documents.map(
    (document) => document.observations[observationName],
  );
  const activeSources = observations.map((observation) =>
    observationName === "initialForward"
      ? observation.serviceWorker?.activeSource
      : observation.activeServiceWorker,
  );
  const identities = observations.map((observation) =>
    observationName === "initialForward"
      ? observation.serviceWorker?.offlineControllerIdentity
      : observation.offlineControllerIdentity,
  );
  if (
    activeSources.some(
      (source) =>
        !Number.isSafeInteger(source?.byteLength) ||
        source.byteLength < 1 ||
        !SHA256.test(source.sha256 ?? ""),
    ) ||
    identities.some((identity) => !isRecord(identity)) ||
    new Set(activeSources.map(({ sha256 }) => sha256)).size !== 1 ||
    new Set(identities.map((identity) => sha256Json(identity))).size !== 1 ||
    new Set(observations.map(({ previewOrigin }) => previewOrigin)).size !== 1
  ) {
    throw new Error("Managed PWA raw controller source differs");
  }
  const rawCount = observations.reduce(
    (maximum, observation) =>
      Math.max(maximum, observation.controllerChangeCount ?? 0),
    0,
  );
  if (
    observationName === "finalForward" &&
    observations.some((observation) => !isRecord(observation.naturalActivation))
  ) {
    throw new Error("Managed PWA natural activation receipt is absent");
  }
  return Object.freeze({
    changeCount: Math.max(1, rawCount),
    scriptUrl: new URL("/sw.js", observations[0].previewOrigin).href,
    scriptSourceSha256: activeSources[0].sha256,
    offlineIdentitySha256: sha256Json(identities[0]),
  });
};

export const derivePwaMulticlientEvidence = ({
  profileTransitions,
  host,
  sourceSha,
  rollbackSourceSha,
  devicePolicy,
}) => {
  const profileIds = devicePolicy.deviceProfiles.map(({ id }) => id);
  const documents = rawTransitionDocuments({
    profileTransitions,
    profileIds,
    sourceSha,
    rollbackSourceSha,
  });
  if (
    !Array.isArray(host?.profiles) ||
    host.profiles.length !== profileIds.length ||
    host.profiles.some(
      (profile, index) =>
        profile.profileId !== profileIds[index] ||
        profile.profilePathSha256 !== documents[index].profilePathSha256 ||
        profile.reopenedProcessId !==
          documents[index].observations.finalForward.browserProcessId,
    )
  ) {
    throw new Error("Managed PWA host/profile transition binding differs");
  }
  const observationNames = ["initialForward", "rollback", "finalForward"];
  const sourcePairs = [
    [rollbackSourceSha, sourceSha],
    [sourceSha, rollbackSourceSha],
    [rollbackSourceSha, sourceSha],
  ];
  const processIds = Object.fromEntries(
    observationNames.map((name) => [
      name,
      documents.map((document) => document.observations[name].browserProcessId),
    ]),
  );
  const transitions = observationNames.map((observationName, index) => {
    const rawLegacyValues = documents.map(
      (document) =>
        document.observations[observationName].legacySources?.rawValues,
    );
    if (
      rawLegacyValues.some((value) => !isRecord(value)) ||
      new Set(rawLegacyValues.map((value) => sha256Json(value))).size !== 1
    ) {
      throw new Error("Managed PWA raw legacy source differs between profiles");
    }
    const database = rawDatabaseProjection(documents, observationName);
    return Object.freeze({
      sequence: index + 1,
      phase: ["forward", "rollback", "forward"][index],
      fromBuildId: sourcePairs[index][0],
      toBuildId: sourcePairs[index][1],
      profileIds: [...profileIds],
      closedProcessIds:
        index === 0
          ? host.profiles.map(({ initialProcessId }) => initialProcessId)
          : processIds[observationNames[index - 1]],
      reopenedProcessIds: processIds[observationName],
      controller: rawControllerProjection(documents, observationName),
      checkpoint: database.checkpoint,
      journal: database.journal,
      legacyRawSha256: sha256Json(rawLegacyValues[0]),
      cleanupPhysicalDeleteCount: documents.reduce(
        (total, document) =>
          total +
          document.observations[observationName].legacySources
            .physicalDeleteCount,
        0,
      ),
    });
  });
  return Object.freeze({
    profileLaunches: Object.freeze(
      devicePolicy.deviceProfiles.map(({ id }) => ({
        profileId: id,
        displayMode: id === "installed-pwa" ? "standalone" : "browser",
        launchAuthority:
          id === "installed-pwa"
            ? "windows-installed-pwa-shortcut"
            : "managed-browser-binary",
      })),
    ),
    transitions: Object.freeze(transitions),
  });
};

export const summarizePwaMulticlientPayload = (payload, devicePolicy) => {
  const evidence = payload.evidence;
  assertExactKeys(
    evidence,
    ["profileLaunches", "profileTransitions", "transitions"],
    "Managed PWA raw evidence",
  );
  const profileIds = devicePolicy.deviceProfiles.map(({ id }) => id);
  const derived = derivePwaMulticlientEvidence({
    profileTransitions: evidence.profileTransitions,
    host: payload.host,
    sourceSha: payload.sourceSha,
    rollbackSourceSha: payload.rollbackDeployment.sourceSha,
    devicePolicy,
  });
  if (
    !sameJson(evidence.profileLaunches, derived.profileLaunches) ||
    !sameJson(evidence.transitions, derived.transitions)
  ) {
    throw new Error("Managed PWA summaries differ from raw device receipts");
  }
  if (
    !Array.isArray(evidence.profileLaunches) ||
    evidence.profileLaunches.length !== profileIds.length ||
    !Array.isArray(evidence.transitions) ||
    evidence.transitions.length !== 3
  ) {
    throw new Error("Managed PWA evidence set differs");
  }
  evidence.profileLaunches.forEach((launch, index) => {
    assertExactKeys(
      launch,
      ["displayMode", "launchAuthority", "profileId"],
      "Managed PWA profile launch",
    );
    const expected = devicePolicy.deviceProfiles[index];
    if (
      launch.profileId !== expected.id ||
      launch.displayMode !==
        (expected.id === "installed-pwa" ? "standalone" : "browser") ||
      launch.launchAuthority !==
        (expected.id === "installed-pwa"
          ? "windows-installed-pwa-shortcut"
          : "managed-browser-binary")
    ) {
      throw new Error(
        "Managed PWA profile launch was not independently observed",
      );
    }
  });
  evidence.transitions.forEach((transition, index) =>
    assertTransition(transition, index, profileIds),
  );
  const [first, rollback, final] = evidence.transitions;
  if (
    first.fromBuildId !== rollback.toBuildId ||
    first.toBuildId !== rollback.fromBuildId ||
    rollback.toBuildId !== final.fromBuildId ||
    rollback.fromBuildId !== final.toBuildId ||
    final.toBuildId !== payload.sourceSha ||
    new Set(evidence.transitions.map(({ legacyRawSha256 }) => legacyRawSha256))
      .size !== 1
  ) {
    throw new Error("Managed PWA forward/rollback/forward chain differs");
  }
  return Object.freeze({
    clientKinds: Object.freeze(
      devicePolicy.deviceProfiles.map(({ clientKind }) => clientKind),
    ),
    finalBuildId: final.toBuildId,
    legacyRawSha256: final.legacyRawSha256,
    transitionCount: evidence.transitions.length,
  });
};

const expectedIndexedDbStores = (dbContract) =>
  Object.entries(dbContract.indexedDb.stores)
    .map(([name, value]) => ({
      indexes: value.indexes,
      keyPath: value.keyPath,
      name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const decodeCanonicalBase64 = (value, label) => {
  if (typeof value !== "string" || !BASE64.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new Error(`${label} is empty or noncanonical`);
  }
  return bytes;
};

export const deriveIdbDeviceProfileEvidence = ({
  rawReceipt,
  expectedProfile,
  dbContract,
}) => {
  assertExactKeys(
    rawReceipt,
    [
      "browserProcessId",
      "cleanup",
      "conflict",
      "controller",
      "database",
      "invalid",
      "kind",
      "profileId",
      "profilePathSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "Managed IDB raw profile receipt",
  );
  if (
    rawReceipt.schemaVersion !== 1 ||
    rawReceipt.kind !== "managed-device-idb-profile-probe/v1" ||
    rawReceipt.profileId !== expectedProfile.id ||
    !SOURCE_SHA.test(rawReceipt.sourceSha ?? "")
  ) {
    throw new Error("Managed IDB raw profile identity differs");
  }
  assertProcessId(
    rawReceipt.browserProcessId,
    "Managed IDB raw browser process",
  );
  assertSha256(rawReceipt.profilePathSha256, "Managed IDB raw profile path");
  assertExactKeys(
    rawReceipt.controller,
    ["scriptUrl", "sourceBytesBase64"],
    "Managed IDB raw controller",
  );
  assertHttpsOriginOrPath(
    rawReceipt.controller.scriptUrl,
    "Managed IDB raw controller URL",
    { allowLoopback: true },
  );
  const controllerBytes = decodeCanonicalBase64(
    rawReceipt.controller.sourceBytesBase64,
    "Managed IDB raw controller source",
  );
  assertExactKeys(
    rawReceipt.database,
    ["name", "raw", "stores", "version"],
    "Managed IDB raw database",
  );
  assertExactKeys(
    rawReceipt.database.raw,
    ["archive", "checkpoint", "journal", "syncQueuePayload"],
    "Managed IDB raw database records",
  );
  const expectedStores = expectedIndexedDbStores(dbContract);
  if (
    rawReceipt.database.name !== dbContract.indexedDb.name ||
    rawReceipt.database.version !== dbContract.indexedDb.version ||
    !sameJson(rawReceipt.database.stores, expectedStores)
  ) {
    throw new Error("Managed IDB raw database fingerprint differs");
  }
  const invalid = rawReceipt.invalid;
  assertExactKeys(
    invalid,
    ["fixture", "observation"],
    "Managed IDB raw invalid receipt",
  );
  assertExactKeys(
    invalid.fixture,
    ["rawValue", "storageKey"],
    "Managed IDB invalid fixture",
  );
  assertExactKeys(
    invalid.observation,
    ["bodyTextSha256", "candidateCount", "rawRetained", "recoveryVisible"],
    "Managed IDB invalid observation",
  );
  if (
    invalid.fixture.rawValue !== "{" ||
    !/^esp:idb-fallback:v1:eventMetadata:data:/u.test(
      invalid.fixture.storageKey ?? "",
    ) ||
    invalid.observation.recoveryVisible !== true ||
    invalid.observation.rawRetained !== invalid.fixture.rawValue ||
    !Number.isSafeInteger(invalid.observation.candidateCount) ||
    invalid.observation.candidateCount < 1
  ) {
    throw new Error("Managed IDB invalid raw outcome differs");
  }
  assertSha256(
    invalid.observation.bodyTextSha256,
    "Managed IDB invalid screen",
  );
  const conflict = rawReceipt.conflict;
  assertExactKeys(
    conflict,
    ["fixture", "fixtureBytesBase64", "observation"],
    "Managed IDB raw conflict receipt",
  );
  const conflictFixtureBytes = decodeCanonicalBase64(
    conflict.fixtureBytesBase64,
    "Managed IDB conflict fixture bytes",
  );
  const parsedConflict = JSON.parse(conflictFixtureBytes.toString("utf8"));
  if (!sameJson(parsedConflict, conflict.fixture)) {
    throw new Error("Managed IDB conflict fixture bytes differ");
  }
  assertExactKeys(
    conflict.observation,
    ["bodyTextSha256", "candidateCount", "rawRetained", "recoveryVisible"],
    "Managed IDB conflict observation",
  );
  if (
    conflict.observation.recoveryVisible !== true ||
    conflict.observation.rawRetained !== conflict.fixture.rawValue ||
    !Number.isSafeInteger(conflict.observation.candidateCount) ||
    conflict.observation.candidateCount < 2
  ) {
    throw new Error("Managed IDB conflict raw outcome differs");
  }
  assertSha256(
    conflict.observation.bodyTextSha256,
    "Managed IDB conflict screen",
  );
  const { archive, checkpoint, journal, syncQueuePayload } =
    rawReceipt.database.raw;
  if (
    checkpoint?.kind !== "event-shopping-planner-persistence-checkpoint" ||
    checkpoint.version !==
      dbContract.indexedDb.compatibilityVersions.repairCheckpoint ||
    typeof checkpoint.committedRoot?.revision !== "string" ||
    checkpoint.committedRoot.revision.length === 0 ||
    journal?.schemaVersion !==
      dbContract.indexedDb.compatibilityVersions.migrationJournal ||
    archive?.schemaVersion !==
      dbContract.indexedDb.compatibilityVersions.migrationArchive
  ) {
    throw new Error("Managed IDB recovery records differ");
  }
  assertExactKeys(
    rawReceipt.cleanup,
    ["callCount", "physicalDeleteCount"],
    "Managed IDB raw cleanup",
  );
  if (
    rawReceipt.cleanup.callCount !== 0 ||
    rawReceipt.cleanup.physicalDeleteCount !== 0
  ) {
    throw new Error("Managed IDB raw cleanup was not hard-off");
  }
  const database = {
    name: rawReceipt.database.name,
    version: rawReceipt.database.version,
    stores: rawReceipt.database.stores,
  };
  return Object.freeze({
    database: Object.freeze({
      ...database,
      fingerprintSha256: sha256Json(database),
    }),
    invalid: Object.freeze({
      outcome: "invalid",
      fixtureSha256: sha256Json(invalid.fixture),
      rawSha256: sha256Json(invalid.observation),
    }),
    conflict: Object.freeze({
      outcome: "conflict",
      fixtureSha256: sha256Bytes(conflictFixtureBytes),
      rawSha256: sha256Json(conflict.observation),
    }),
    syncQueue: Object.freeze({
      wireVersion: dbContract.indexedDb.compatibilityVersions.syncQueueWire,
      payloadSha256: sha256Json(syncQueuePayload),
      journalSha256: sha256Json(journal),
      archiveSha256: sha256Json(archive),
    }),
    recovery: Object.freeze({
      checkpointVersion: checkpoint.version,
      candidateCount: conflict.observation.candidateCount,
      selectedRevisionSha256: sha256Bytes(
        Buffer.from(checkpoint.committedRoot.revision, "utf8"),
      ),
      rawSha256: sha256Json({ checkpoint, conflict: conflict.observation }),
    }),
    cleanup: structuredClone(rawReceipt.cleanup),
    controllerSourceSha256: sha256Bytes(controllerBytes),
  });
};

const assertIdbProfile = (profile, expectedProfile, dbContract) => {
  assertExactKeys(
    profile,
    [
      "cleanup",
      "conflict",
      "controllerSourceSha256",
      "database",
      "invalid",
      "profileId",
      "rawReceipt",
      "recovery",
      "syncQueue",
    ],
    "Managed IDB profile evidence",
  );
  if (profile.profileId !== expectedProfile.id) {
    throw new Error("Managed IDB profile identity differs");
  }
  const derived = deriveIdbDeviceProfileEvidence({
    rawReceipt: profile.rawReceipt,
    expectedProfile,
    dbContract,
  });
  for (const key of [
    "cleanup",
    "conflict",
    "controllerSourceSha256",
    "database",
    "invalid",
    "recovery",
    "syncQueue",
  ]) {
    if (!sameJson(profile[key], derived[key])) {
      throw new Error(`Managed IDB ${key} differs from raw device receipt`);
    }
  }
  assertExactKeys(
    profile.database,
    ["fingerprintSha256", "name", "stores", "version"],
    "Managed IDB database",
  );
  const expectedStores = expectedIndexedDbStores(dbContract);
  const fingerprint = {
    name: profile.database.name,
    stores: profile.database.stores,
    version: profile.database.version,
  };
  if (
    profile.database.name !== dbContract.indexedDb.name ||
    profile.database.version !== dbContract.indexedDb.version ||
    !sameJson(profile.database.stores, expectedStores) ||
    profile.database.fingerprintSha256 !== sha256Json(fingerprint)
  ) {
    throw new Error("Managed IDB database fingerprint differs");
  }
  for (const [key, outcome] of [
    ["invalid", "invalid"],
    ["conflict", "conflict"],
  ]) {
    assertExactKeys(
      profile[key],
      ["fixtureSha256", "outcome", "rawSha256"],
      `Managed IDB ${key} evidence`,
    );
    if (profile[key].outcome !== outcome) {
      throw new Error(`Managed IDB ${key} outcome differs`);
    }
    assertSha256(profile[key].fixtureSha256, `Managed IDB ${key} fixture`);
    assertSha256(profile[key].rawSha256, `Managed IDB ${key} raw evidence`);
  }
  assertHashProjection(
    profile.syncQueue,
    ["archiveSha256", "journalSha256", "payloadSha256", "wireVersion"],
    "Managed IDB syncQueue",
  );
  if (
    profile.syncQueue.wireVersion !==
    dbContract.indexedDb.compatibilityVersions.syncQueueWire
  ) {
    throw new Error("Managed IDB syncQueue wire version differs");
  }
  assertHashProjection(
    profile.recovery,
    [
      "candidateCount",
      "checkpointVersion",
      "rawSha256",
      "selectedRevisionSha256",
    ],
    "Managed IDB recovery",
  );
  if (
    profile.recovery.checkpointVersion !==
      dbContract.indexedDb.compatibilityVersions.repairCheckpoint ||
    !Number.isSafeInteger(profile.recovery.candidateCount) ||
    profile.recovery.candidateCount < 2
  ) {
    throw new Error("Managed IDB recovery evidence differs");
  }
  assertExactKeys(
    profile.cleanup,
    ["callCount", "physicalDeleteCount"],
    "Managed IDB cleanup",
  );
  if (
    profile.cleanup.callCount !== 0 ||
    profile.cleanup.physicalDeleteCount !== 0
  ) {
    throw new Error("Managed IDB cleanup was not hard-off");
  }
  assertSha256(profile.controllerSourceSha256, "Managed IDB controller source");
};

export const summarizeIdbDeviceCompatibilityPayload = (
  payload,
  devicePolicy,
  dbContract,
) => {
  const evidence = payload.evidence;
  assertExactKeys(evidence, ["profiles"], "Managed IDB raw evidence");
  if (
    !Array.isArray(evidence.profiles) ||
    evidence.profiles.length !== devicePolicy.deviceProfiles.length
  ) {
    throw new Error("Managed IDB profile evidence set differs");
  }
  evidence.profiles.forEach((profile, index) => {
    assertIdbProfile(profile, devicePolicy.deviceProfiles[index], dbContract);
    if (
      profile.rawReceipt.profilePathSha256 !==
        payload.host.profiles[index].profilePathSha256 ||
      profile.rawReceipt.browserProcessId !==
        payload.host.profiles[index].reopenedProcessId
    ) {
      throw new Error("Managed IDB host/profile raw receipt binding differs");
    }
  });
  const fingerprints = new Set(
    evidence.profiles.map(({ database }) => database.fingerprintSha256),
  );
  if (fingerprints.size !== 1) {
    throw new Error("Managed IDB profile fingerprints differ");
  }
  return Object.freeze({
    databaseFingerprintSha256: evidence.profiles[0].database.fingerprintSha256,
    profileCount: evidence.profiles.length,
    storeCount: evidence.profiles[0].database.stores.length,
  });
};

export const assertManagedDevicePayload = (
  payload,
  {
    authority,
    externalPolicy,
    approvalPolicy,
    dbContract,
    expectedSourceSha,
    expectedRunId,
    expectedRunAttempt,
    expectedDeployment = null,
    expectedRollbackDeployment = null,
  },
) => {
  assertExactKeys(
    payload,
    [
      "authority",
      "collectorIdentity",
      "deployment",
      "evidence",
      "externalPrerequisitePolicySha256",
      "host",
      "kind",
      "namespace",
      "observedAt",
      "oidcReceipt",
      "rollbackDeployment",
      "schemaVersion",
      "sourceSha",
    ],
    "Managed device signed payload",
  );
  const configured = assertConfiguredManagedDeviceExecution(externalPolicy);
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "managed-device-raw-authority/v1" ||
    payload.authority !== authority ||
    !MANAGED_DEVICE_AUTHORITIES.includes(payload.authority) ||
    !NAMESPACE.test(payload.namespace ?? "") ||
    payload.sourceSha !== expectedSourceSha ||
    !SOURCE_SHA.test(payload.sourceSha ?? "") ||
    payload.externalPrerequisitePolicySha256 !== configured.policySha256
  ) {
    throw new Error("Managed device payload authority differs");
  }
  assertTimestamp(payload.observedAt, "Managed device observation time");
  assertBrowserPhaseExitCollectorIdentity(
    payload.collectorIdentity,
    expectedSourceSha,
  );
  if (
    payload.collectorIdentity.repository !== approvalPolicy.repository ||
    payload.collectorIdentity.runId !== expectedRunId ||
    payload.collectorIdentity.runAttempt !== expectedRunAttempt
  ) {
    throw new Error("Managed device collector identity differs");
  }
  assertStoredGitHubOidcReceipt({
    receipt: payload.oidcReceipt,
    policy: approvalPolicy,
    expectedSourceSha,
    expectedRunId,
    expectedRunAttempt,
  });
  assertDeployment(payload.deployment, expectedDeployment);
  if (authority === "pwa-multiclient-drill") {
    assertDeployment(
      payload.rollbackDeployment,
      expectedRollbackDeployment,
      "eligible-rollback-standard",
    );
    if (
      payload.rollbackDeployment.sourceSha === payload.sourceSha ||
      payload.rollbackDeployment.deploymentUrl ===
        payload.deployment.deploymentUrl
    ) {
      throw new Error("Managed device rollback deployment is not distinct");
    }
  } else if (payload.rollbackDeployment !== null) {
    throw new Error("Managed IDB authority must not carry a rollback claim");
  }
  assertManagedHost(payload.host, configured.device);
  const result =
    authority === "pwa-multiclient-drill"
      ? summarizePwaMulticlientPayload(payload, configured.device)
      : summarizeIdbDeviceCompatibilityPayload(
          payload,
          configured.device,
          dbContract,
        );
  return Object.freeze({ payload, result });
};

export const createSignedManagedDeviceReceipt = ({
  payload,
  privateKeyPem,
  publicKeyPem,
  validation,
}) => {
  assertManagedDevicePayload(payload, validation);
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(publicKeyPem);
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Managed device signing keys are not Ed25519");
  }
  const publicKeySpki = exportPublicSpki(publicKey);
  const signature = signBytes(null, canonicalJsonBytes(payload), privateKey);
  if (!verifyBytes(null, canonicalJsonBytes(payload), publicKey, signature)) {
    throw new Error("Managed device private and public keys differ");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-signed-receipt/v1",
    payload: structuredClone(payload),
    signature: {
      algorithm: "ed25519",
      publicKeySpkiBase64: publicKeySpki.toString("base64"),
      signatureBase64: signature.toString("base64"),
    },
  });
};

export const assertSignedManagedDeviceReceipt = (receipt, validation) => {
  assertExactKeys(
    receipt,
    ["kind", "payload", "schemaVersion", "signature"],
    "Managed device signed receipt",
  );
  assertExactKeys(
    receipt.signature,
    ["algorithm", "publicKeySpkiBase64", "signatureBase64"],
    "Managed device signature",
  );
  const configured = assertConfiguredManagedDeviceExecution(
    validation.externalPolicy,
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "managed-device-signed-receipt/v1" ||
    receipt.signature.algorithm !== "ed25519" ||
    typeof receipt.signature.signatureBase64 !== "string" ||
    !BASE64.test(receipt.signature.signatureBase64)
  ) {
    throw new Error("Managed device signature envelope differs");
  }
  const publicKey = assertPublicKey({
    publicKeySpkiBase64: receipt.signature.publicKeySpkiBase64,
    expectedFingerprint:
      configured.device.attestation.publicKeyFingerprintSha256,
  });
  const signature = Buffer.from(receipt.signature.signatureBase64, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== receipt.signature.signatureBase64 ||
    !verifyBytes(
      null,
      canonicalJsonBytes(receipt.payload),
      publicKey,
      signature,
    )
  ) {
    throw new Error("Managed device receipt signature is invalid");
  }
  const verified = assertManagedDevicePayload(receipt.payload, validation);
  return Object.freeze({
    receipt,
    result: verified.result,
    sha256: sha256Bytes(canonicalJsonBytes(receipt)),
  });
};
