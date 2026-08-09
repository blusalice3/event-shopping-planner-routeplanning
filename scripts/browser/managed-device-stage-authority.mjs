import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  hashReleaseEvent,
  replayReleaseEvents,
} from "../release-state/releaseStateReducer.mjs";
import { assertStoredGitHubOidcReceipt } from "../release-state/githubOidc.mjs";
import {
  assertDeploymentBinding,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  deriveBrowserPhaseExitCollectorIdentity,
} from "./production-request-graph.mjs";
import {
  assertConfiguredManagedDeviceExecution,
  deriveIdbDeviceProfileEvidence,
  managedDevicePublicKeyFingerprint,
} from "./managed-device-authority.mjs";

export const MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.managed-device-stage-receipt+json;version=1";
export const MANAGED_DEVICE_MULTISTAGE_MEDIA_TYPES = Object.freeze({
  "idb-device-compatibility":
    "application/vnd.event-shopping-planner.idb-device-compatibility-multistage+json;version=1",
  "pwa-multiclient-drill":
    "application/vnd.event-shopping-planner.pwa-multiclient-drill-multistage+json;version=1",
});

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const ALIAS_EVENT_TYPES = new Set([
  "package-redeploy-activated",
  "release-accepted",
  "rollback-activated",
  "state-reconciled",
]);
const CLIENT_IDS = Object.freeze(["browser-tab", "installed-pwa"]);
export const MANAGED_DEVICE_LEGACY_KEYS = Object.freeze([
  "dayModes",
  "eventMetadata",
  "eventShoppingLists",
  "executeModeItems",
  "hallDefinitions",
  "hallRouteSettings",
  "mapData",
  "mapRotationSettings",
  "mapViewportSettings",
  "routeSettings",
  "syncQueue",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => sameCanonicalValue(left, right);
const exactKeys = (value, expected, label) => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
};
const assertSha256 = (value, label) => {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256`);
  }
};
const assertTimestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
};
const decodeBase64 = (value, label) => {
  if (typeof value !== "string" || !BASE64.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return bytes;
};

const snapshotAt = (current, sequence) => {
  if (
    !Array.isArray(current?.records) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > current.records.length
  ) {
    throw new Error("Managed device Release State sequence is invalid");
  }
  return replayReleaseEvents(
    current.records.slice(0, sequence).map(({ event }) => event),
  );
};

const assertRecord = (record, sequence, namespace) => {
  if (
    !isRecord(record) ||
    record.sequence !== sequence ||
    record.event?.sequence !== sequence ||
    record.event?.namespace !== namespace ||
    !SHA256.test(record.eventHash ?? "") ||
    record.eventHash !== hashReleaseEvent(record.event) ||
    record.previousHash !== record.event.previousEventHash ||
    !Number.isFinite(Date.parse(record.committedAt))
  ) {
    throw new Error("Managed device Release State record differs");
  }
};

export const deriveManagedDeviceLegacySentinelValues = ({
  activationEventHash,
  profileId,
}) => {
  if (
    !SHA256.test(activationEventHash ?? "") ||
    !CLIENT_IDS.includes(profileId)
  ) {
    throw new Error("Managed device legacy sentinel identity is invalid");
  }
  return Object.freeze(
    Object.fromEntries(
      MANAGED_DEVICE_LEGACY_KEYS.map((key) => [
        key,
        canonicalJsonBytes({
          activationEventHash,
          key,
          kind: "managed-device-legacy-sentinel/v1",
          profileId,
        }).toString("utf8"),
      ]),
    ),
  );
};

export const resolveManagedDeviceLiveStageState = ({ current, namespace }) => {
  if (
    !isRecord(current?.snapshot) ||
    !NAMESPACE.test(namespace ?? "") ||
    current.snapshot.pendingOperation !== null ||
    current.snapshot.pendingAcceptance !== null ||
    current.snapshot.activeProduction?.releaseRole !== "standard" ||
    current.snapshot.acceptedStandard === null ||
    !same(
      current.snapshot.activeProduction,
      current.snapshot.acceptedStandard,
    ) ||
    current.head?.sequence !== current.records?.length ||
    current.head?.eventHash !== current.records?.at(-1)?.eventHash
  ) {
    throw new Error("Managed device stage requires an idle active standard");
  }
  assertDeploymentBinding(current.snapshot.activeProduction, {
    namespace,
    allowLegacyBootstrap: false,
    label: "Managed device active production binding",
  });
  let activation = null;
  for (let sequence = current.records.length; sequence >= 1; sequence -= 1) {
    const record = current.records[sequence - 1];
    assertRecord(record, sequence, namespace);
    if (!ALIAS_EVENT_TYPES.has(record.event.eventType)) continue;
    const candidate = snapshotAt(current, sequence);
    const before = sequence === 1 ? null : snapshotAt(current, sequence - 1);
    if (
      candidate.activeProduction?.releaseRole === "standard" &&
      same(candidate.activeProduction, current.snapshot.activeProduction) &&
      !same(candidate.activeProduction, before?.activeProduction)
    ) {
      activation = record;
      break;
    }
  }
  if (activation === null) {
    throw new Error("Managed device active alias event is absent");
  }
  const authority = Object.freeze({
    head: structuredClone(current.head),
    activation: Object.freeze({
      sequence: activation.sequence,
      eventHash: activation.eventHash,
      previousHash: activation.previousHash,
      committedAt: new Date(activation.committedAt).toISOString(),
      event: structuredClone(activation.event),
    }),
    activeBinding: structuredClone(current.snapshot.activeProduction),
  });
  return Object.freeze({
    authority,
    authoritySha256: sha256Json(authority),
    deploymentSourceSha: current.snapshot.activeProduction.sourceSha,
  });
};

export const resolveManagedDeviceMultistageSequence = ({
  current,
  namespace,
  expectedCollectorSourceSha,
}) => {
  if (!SOURCE_SHA.test(expectedCollectorSourceSha ?? "")) {
    throw new Error("Managed device multistage source is invalid");
  }
  const live = resolveManagedDeviceLiveStageState({ current, namespace });
  const transitions = [];
  let previousActive = null;
  for (let sequence = 1; sequence <= current.records.length; sequence += 1) {
    const record = current.records[sequence - 1];
    assertRecord(record, sequence, namespace);
    const snapshot = snapshotAt(current, sequence);
    const active = snapshot.activeProduction;
    if (
      ALIAS_EVENT_TYPES.has(record.event.eventType) &&
      active?.releaseRole === "standard" &&
      !same(active, previousActive)
    ) {
      transitions.push(
        Object.freeze({
          activation: Object.freeze({
            sequence: record.sequence,
            eventHash: record.eventHash,
            previousHash: record.previousHash,
            committedAt: new Date(record.committedAt).toISOString(),
            event: structuredClone(record.event),
          }),
          activeBinding: structuredClone(active),
        }),
      );
    }
    previousActive = active;
  }
  const selected = transitions.slice(-3);
  if (selected.length !== 3) {
    throw new Error("Managed device multistage transition set is incomplete");
  }
  const [initial, rollback, final] = selected;
  if (
    initial.activeBinding.sourceSha !== expectedCollectorSourceSha ||
    rollback.activeBinding.sourceSha === expectedCollectorSourceSha ||
    final.activeBinding.sourceSha !== expectedCollectorSourceSha ||
    !same(initial.activeBinding, final.activeBinding) ||
    rollback.activation.event.eventType !== "rollback-activated" ||
    final.activation.event.eventType !== "rollback-activated" ||
    final.activation.eventHash !== live.authority.activation.eventHash ||
    !same(final.activeBinding, live.authority.activeBinding)
  ) {
    throw new Error("Managed device multistage live ancestry differs");
  }
  const authority = Object.freeze({
    head: structuredClone(current.head),
    stages: Object.freeze(
      selected.map((stage, index) =>
        Object.freeze({
          role: ["initial-forward", "rollback", "final-forward"][index],
          ...stage,
        }),
      ),
    ),
  });
  return Object.freeze({
    authority,
    authoritySha256: sha256Json(authority),
  });
};

export const assertManagedDeviceStageState = ({
  authority,
  current,
  namespace,
}) => {
  exactKeys(
    authority,
    ["activation", "activeBinding", "head"],
    "Managed device stage state authority",
  );
  exactKeys(
    authority.head,
    ["eventHash", "sequence"],
    "Managed device stage head",
  );
  exactKeys(
    authority.activation,
    ["committedAt", "event", "eventHash", "previousHash", "sequence"],
    "Managed device stage activation",
  );
  const headSequence = authority.head.sequence;
  const activationSequence = authority.activation.sequence;
  if (
    !Number.isSafeInteger(headSequence) ||
    !Number.isSafeInteger(activationSequence) ||
    activationSequence < 1 ||
    headSequence < activationSequence ||
    headSequence > current.records.length
  ) {
    throw new Error("Managed device stage historical range is invalid");
  }
  const headRecord = current.records[headSequence - 1];
  const activationRecord = current.records[activationSequence - 1];
  assertRecord(headRecord, headSequence, namespace);
  assertRecord(activationRecord, activationSequence, namespace);
  if (
    headRecord.eventHash !== authority.head.eventHash ||
    activationRecord.eventHash !== authority.activation.eventHash ||
    activationRecord.previousHash !== authority.activation.previousHash ||
    new Date(activationRecord.committedAt).toISOString() !==
      authority.activation.committedAt ||
    !same(activationRecord.event, authority.activation.event)
  ) {
    throw new Error("Managed device stage event readback differs");
  }
  const historical = {
    head: structuredClone(authority.head),
    records: current.records.slice(0, headSequence),
    snapshot: snapshotAt(current, headSequence),
  };
  const resolved = resolveManagedDeviceLiveStageState({
    current: historical,
    namespace,
  });
  if (!same(resolved.authority, authority)) {
    throw new Error("Managed device stage is not the live alias authority");
  }
  return resolved;
};

const commandArguments = (observation, profile, device) => {
  const bytes = decodeBase64(
    observation.cdp.browserArgumentsBytesBase64,
    `Managed device ${profile.id} browser arguments`,
  );
  const arguments_ = parseJsonStrict(
    bytes.toString("utf8"),
    `Managed device ${profile.id} browser arguments`,
  );
  if (
    !Array.isArray(arguments_) ||
    !canonicalJsonBytes(arguments_).equals(bytes) ||
    arguments_.some((value) => typeof value !== "string")
  ) {
    throw new Error("Managed device browser arguments are not canonical");
  }
  const lower = arguments_.map((value) => value.toLowerCase());
  const exactSwitch = (name, expected) =>
    lower.includes(`--${name}=${expected.toLowerCase()}`);
  if (
    !exactSwitch("user-data-dir", profile.profileRoot) ||
    !exactSwitch("profile-directory", profile.profileName) ||
    !lower.some((value) => /^--remote-debugging-port=[1-9][0-9]*$/u.test(value))
  ) {
    throw new Error("Managed device browser profile/CDP arguments differ");
  }
  const appArguments = lower.filter(
    (value) => value.startsWith("--app=") || value.startsWith("--app-id="),
  );
  if (
    (profile.id === "browser-tab" && appArguments.length !== 0) ||
    (profile.id === "installed-pwa" &&
      (appArguments.length !== 1 ||
        !exactSwitch(
          "app-id",
          device.installedPwaLaunchAuthority.applicationId,
        )))
  ) {
    throw new Error("Managed device client launch mode differs");
  }
  return arguments_;
};

const assertPwaSnapshot = ({
  snapshot,
  sourceSha,
  productionOrigin,
  deploymentUrl,
}) => {
  exactKeys(
    snapshot,
    [
      "capabilityBytesBase64",
      "controller",
      "immutableDeployment",
      "legacyRawValues",
      "offlineCapabilityBytesBase64",
    ],
    "Managed device PWA snapshot",
  );
  const capabilityBytes = decodeBase64(
    snapshot.capabilityBytesBase64,
    "Managed device online capability",
  );
  const offlineBytes = decodeBase64(
    snapshot.offlineCapabilityBytesBase64,
    "Managed device offline capability",
  );
  if (!capabilityBytes.equals(offlineBytes)) {
    throw new Error("Managed device offline capability bytes differ");
  }
  const capability = parseJsonStrict(
    capabilityBytes.toString("utf8"),
    "Managed device capability",
  );
  if (
    capability.sourceSha !== sourceSha ||
    capability.buildId !== sourceSha ||
    capability.releaseChannel !== "release-a" ||
    capability.legacyLocalStorageCleanup !== "forced-off"
  ) {
    throw new Error("Managed device capability source differs");
  }
  exactKeys(
    snapshot.controller,
    ["activeState", "scriptUrl", "sourceBytesBase64"],
    "Managed device controller",
  );
  const controllerBytes = decodeBase64(
    snapshot.controller.sourceBytesBase64,
    "Managed device controller source",
  );
  if (
    snapshot.controller.activeState !== "activated" ||
    controllerBytes.length === 0 ||
    new URL(snapshot.controller.scriptUrl).origin !== productionOrigin ||
    !isRecord(snapshot.legacyRawValues)
  ) {
    throw new Error("Managed device controller/raw legacy snapshot differs");
  }
  exactKeys(
    snapshot.immutableDeployment,
    [
      "capabilityBytesBase64",
      "capabilityUrl",
      "controllerBytesBase64",
      "controllerUrl",
      "deploymentUrl",
    ],
    "Managed device immutable deployment snapshot",
  );
  const immutableCapabilityBytes = decodeBase64(
    snapshot.immutableDeployment.capabilityBytesBase64,
    "Managed device immutable capability",
  );
  const immutableControllerBytes = decodeBase64(
    snapshot.immutableDeployment.controllerBytesBase64,
    "Managed device immutable controller",
  );
  const deployment = new URL(deploymentUrl);
  const controller = new URL(snapshot.controller.scriptUrl);
  const expectedCapabilityUrl = new URL(
    "/release-capabilities.json",
    deployment,
  ).href;
  const expectedControllerUrl = new URL(
    `${controller.pathname}${controller.search}`,
    deployment,
  ).href;
  if (
    deployment.protocol !== "https:" ||
    deployment.username !== "" ||
    deployment.password !== "" ||
    deployment.hash !== "" ||
    snapshot.immutableDeployment.deploymentUrl !== deployment.href ||
    snapshot.immutableDeployment.capabilityUrl !== expectedCapabilityUrl ||
    snapshot.immutableDeployment.controllerUrl !== expectedControllerUrl ||
    !immutableCapabilityBytes.equals(capabilityBytes) ||
    !immutableControllerBytes.equals(controllerBytes)
  ) {
    throw new Error("Managed device immutable deployment bytes differ");
  }
  return Object.freeze({
    capabilitySha256: sha256Bytes(capabilityBytes),
    controllerSha256: sha256Bytes(controllerBytes),
    legacyRawSha256: sha256Json(snapshot.legacyRawValues),
  });
};

const assertClientObservation = ({
  observation,
  profile,
  device,
  dbContract,
  sourceSha,
  productionOrigin,
  browserExecutableSha256,
  deploymentUrl,
}) => {
  exactKeys(
    observation,
    [
      "cdp",
      "clientKind",
      "idbRawReceipt",
      "installedMode",
      "process",
      "profileId",
      "profilePathSha256",
      "profileRootSha256",
      "pwa",
    ],
    `Managed device ${profile.id} observation`,
  );
  exactKeys(
    observation.process,
    ["cimCommandLineBytesBase64", "executableSha256", "processId"],
    `Managed device ${profile.id} process`,
  );
  exactKeys(
    observation.cdp,
    [
      "browserArgumentsBytesBase64",
      "browserVersion",
      "targetType",
      "targetUrl",
    ],
    `Managed device ${profile.id} CDP`,
  );
  if (
    observation.profileId !== profile.id ||
    observation.clientKind !== profile.clientKind ||
    observation.installedMode !== profile.installedMode ||
    observation.profileRootSha256 !==
      sha256Bytes(Buffer.from(profile.profileRoot, "utf8")) ||
    observation.profilePathSha256 !==
      sha256Bytes(Buffer.from(profile.profilePath, "utf8")) ||
    !Number.isSafeInteger(observation.process.processId) ||
    observation.process.processId < 1 ||
    observation.process.executableSha256 !== browserExecutableSha256 ||
    observation.cdp.browserVersion !== device.browser.exactVersion ||
    observation.cdp.targetType !== "page" ||
    new URL(observation.cdp.targetUrl).origin !== productionOrigin
  ) {
    throw new Error("Managed device client identity differs");
  }
  assertSha256(
    observation.process.executableSha256,
    "Managed device browser executable",
  );
  const cimCommandLine = decodeBase64(
    observation.process.cimCommandLineBytesBase64,
    "Managed device CIM command line",
  ).toString("utf8");
  if (
    !cimCommandLine.toLowerCase().includes(profile.profileRoot.toLowerCase()) ||
    !cimCommandLine
      .toLowerCase()
      .includes(`--profile-directory=${profile.profileName}`.toLowerCase()) ||
    (profile.id === "installed-pwa" &&
      !cimCommandLine
        .toLowerCase()
        .includes(
          `--app-id=${device.installedPwaLaunchAuthority.applicationId}`,
        )) ||
    (profile.id === "browser-tab" && /--app(?:-id)?=/iu.test(cimCommandLine))
  ) {
    throw new Error("Managed device CIM launch authority differs");
  }
  commandArguments(observation, profile, device);
  const pwa = assertPwaSnapshot({
    snapshot: observation.pwa,
    sourceSha,
    productionOrigin,
    deploymentUrl,
  });
  const idb = deriveIdbDeviceProfileEvidence({
    rawReceipt: observation.idbRawReceipt,
    expectedProfile: profile,
    dbContract,
  });
  if (
    observation.idbRawReceipt.sourceSha !== sourceSha ||
    observation.idbRawReceipt.browserProcessId !==
      observation.process.processId ||
    observation.idbRawReceipt.profilePathSha256 !==
      observation.profilePathSha256 ||
    new URL(observation.idbRawReceipt.controller.scriptUrl).origin !==
      productionOrigin ||
    idb.controllerSourceSha256 !== pwa.controllerSha256
  ) {
    throw new Error("Managed device IDB/process/controller binding differs");
  }
  return Object.freeze({
    pwa,
    idb: Object.freeze({
      ...idb,
      checkpointSha256: sha256Json(
        observation.idbRawReceipt.database.raw.checkpoint,
      ),
      rawDatabaseSha256: sha256Json(observation.idbRawReceipt.database.raw),
    }),
  });
};

export const summarizeManagedDeviceStagePayload = ({
  payload,
  externalPolicy,
  dbContract,
}) => {
  const device = assertConfiguredManagedDeviceExecution(externalPolicy).device;
  exactKeys(
    payload.observation,
    [
      "browser",
      "closures",
      "cycles",
      "legacySentinels",
      "deviceFingerprintSha256",
      "operatingSystem",
      "policy",
      "runnerGroup",
      "runnerLabels",
    ],
    "Managed device stage observation",
  );
  const observation = payload.observation;
  exactKeys(
    observation.operatingSystem,
    ["architecture", "family", "release"],
    "Managed device operating system",
  );
  exactKeys(
    observation.browser,
    ["binaryPath", "binarySha256", "enrollmentIdSha256", "family", "version"],
    "Managed device browser authority",
  );
  exactKeys(
    observation.policy,
    [
      "applicationId",
      "forceInstallPolicyName",
      "forceInstallPolicyValueSha256",
      "installUrl",
      "shortcutArgumentsSha256",
      "shortcutPathSha256",
    ],
    "Managed device install policy authority",
  );
  if (
    observation.runnerGroup !== device.runnerGroup ||
    !same(observation.runnerLabels, device.requiredLabels) ||
    !same(observation.operatingSystem, device.operatingSystem) ||
    observation.browser.family !== device.browser.family ||
    observation.browser.binaryPath !== device.browser.binaryPath ||
    observation.browser.version !== device.browser.exactVersion ||
    !SHA256.test(observation.browser.binarySha256 ?? "") ||
    observation.browser.enrollmentIdSha256 !==
      device.browser.managedEnrollmentIdSha256 ||
    observation.policy.forceInstallPolicyName !==
      device.installedPwaLaunchAuthority.forceInstallPolicyName ||
    observation.policy.forceInstallPolicyValueSha256 !==
      device.installedPwaLaunchAuthority.forceInstallPolicyValueSha256 ||
    observation.policy.applicationId !==
      device.installedPwaLaunchAuthority.applicationId ||
    observation.policy.installUrl !==
      device.installedPwaLaunchAuthority.installUrl ||
    !SHA256.test(observation.policy.shortcutArgumentsSha256 ?? "") ||
    !SHA256.test(observation.policy.shortcutPathSha256 ?? "") ||
    !Array.isArray(observation.cycles) ||
    observation.cycles.length !== 2 ||
    !Array.isArray(observation.closures) ||
    observation.closures.length !== 2
  ) {
    throw new Error("Managed device host authority differs");
  }
  const productionOrigin = new URL(
    device.installedPwaLaunchAuthority.installUrl,
  ).origin;
  const cycleNames = ["initial", "reopened"];
  if (
    !Array.isArray(observation.legacySentinels) ||
    observation.legacySentinels.length !== device.deviceProfiles.length
  ) {
    throw new Error("Managed device legacy sentinel set differs");
  }
  const expectedLegacySentinels = observation.legacySentinels.map(
    (sentinel, index) => {
      exactKeys(
        sentinel,
        ["profileId", "rawValues", "rawValuesSha256"],
        "Managed device legacy sentinel",
      );
      const expected = deriveManagedDeviceLegacySentinelValues({
        activationEventHash: payload.releaseState.activation.eventHash,
        profileId: device.deviceProfiles[index].id,
      });
      if (
        sentinel.profileId !== device.deviceProfiles[index].id ||
        !same(sentinel.rawValues, expected) ||
        sentinel.rawValuesSha256 !== sha256Json(expected)
      ) {
        throw new Error("Managed device legacy sentinel authority differs");
      }
      return expected;
    },
  );
  const derivedCycles = observation.cycles.map((cycle, cycleIndex) => {
    exactKeys(cycle, ["clients", "cycle"], "Managed device cycle");
    if (
      cycle.cycle !== cycleNames[cycleIndex] ||
      !Array.isArray(cycle.clients) ||
      cycle.clients.length !== device.deviceProfiles.length
    ) {
      throw new Error("Managed device cycle set differs");
    }
    return cycle.clients.map((client, profileIndex) => {
      const derived = assertClientObservation({
        observation: client,
        profile: device.deviceProfiles[profileIndex],
        device,
        dbContract,
        sourceSha: payload.releaseState.activeBinding.sourceSha,
        productionOrigin,
        browserExecutableSha256: observation.browser.binarySha256,
        deploymentUrl: payload.releaseState.activeBinding.deploymentUrl,
      });
      if (
        !same(client.pwa.legacyRawValues, expectedLegacySentinels[profileIndex])
      ) {
        throw new Error("Managed device seeded legacy values changed");
      }
      return derived;
    });
  });
  const allProcessIds = [];
  observation.closures.forEach((closure, cycleIndex) => {
    exactKeys(
      closure,
      ["closedAt", "cycle", "processIds", "remainingProcessCount"],
      "Managed device process closure",
    );
    assertTimestamp(closure.closedAt, "Managed device process closedAt");
    const expectedProcessIds = observation.cycles[cycleIndex].clients.map(
      ({ process }) => process.processId,
    );
    if (
      closure.cycle !== cycleNames[cycleIndex] ||
      closure.remainingProcessCount !== 0 ||
      !same(closure.processIds, expectedProcessIds)
    ) {
      throw new Error("Managed device process closure differs");
    }
    allProcessIds.push(...closure.processIds);
  });
  if (
    new Set(allProcessIds).size !== allProcessIds.length ||
    Date.parse(observation.closures[0].closedAt) >=
      Date.parse(observation.closures[1].closedAt)
  ) {
    throw new Error("Managed device close/reopen process ancestry differs");
  }
  for (let index = 0; index < device.deviceProfiles.length; index += 1) {
    const initial = observation.cycles[0].clients[index];
    const reopened = observation.cycles[1].clients[index];
    const initialDerived = derivedCycles[0][index];
    const reopenedDerived = derivedCycles[1][index];
    if (
      initial.process.processId === reopened.process.processId ||
      initial.pwa.controller.sourceBytesBase64 !==
        reopened.pwa.controller.sourceBytesBase64 ||
      initialDerived.pwa.capabilitySha256 !==
        reopenedDerived.pwa.capabilitySha256 ||
      initialDerived.pwa.legacyRawSha256 !==
        reopenedDerived.pwa.legacyRawSha256 ||
      initialDerived.idb.database.fingerprintSha256 !==
        reopenedDerived.idb.database.fingerprintSha256 ||
      !same(initialDerived.idb.invalid, reopenedDerived.idb.invalid) ||
      !same(initialDerived.idb.conflict, reopenedDerived.idb.conflict) ||
      !same(initialDerived.idb.syncQueue, reopenedDerived.idb.syncQueue) ||
      !same(initialDerived.idb.recovery, reopenedDerived.idb.recovery) ||
      !same(initialDerived.idb.cleanup, reopenedDerived.idb.cleanup) ||
      initialDerived.idb.checkpointSha256 !==
        reopenedDerived.idb.checkpointSha256 ||
      initialDerived.idb.rawDatabaseSha256 !==
        reopenedDerived.idb.rawDatabaseSha256
    ) {
      throw new Error("Managed device close/reopen evidence differs");
    }
  }
  const computedDeviceFingerprint = deriveManagedDeviceFingerprint({
    observation,
    device,
  });
  if (observation.deviceFingerprintSha256 !== computedDeviceFingerprint) {
    throw new Error("Managed device fingerprint differs");
  }
  return Object.freeze({
    deviceFingerprintSha256: computedDeviceFingerprint,
    deploymentSourceSha: payload.releaseState.activeBinding.sourceSha,
    closureSha256: sha256Json(observation.closures),
    legacySentinelSha256: sha256Json(observation.legacySentinels),
    clients: Object.freeze(
      device.deviceProfiles.map((profile, index) => ({
        profileId: profile.id,
        controllerSha256: derivedCycles[1][index].pwa.controllerSha256,
        capabilitySha256: derivedCycles[1][index].pwa.capabilitySha256,
        legacyRawSha256: derivedCycles[1][index].pwa.legacyRawSha256,
        databaseFingerprintSha256:
          derivedCycles[1][index].idb.database.fingerprintSha256,
        invalid: derivedCycles[1][index].idb.invalid,
        conflict: derivedCycles[1][index].idb.conflict,
        syncQueue: derivedCycles[1][index].idb.syncQueue,
        recovery: derivedCycles[1][index].idb.recovery,
        cleanup: derivedCycles[1][index].idb.cleanup,
        checkpointSha256: derivedCycles[1][index].idb.checkpointSha256,
        rawDatabaseSha256: derivedCycles[1][index].idb.rawDatabaseSha256,
      })),
    ),
  });
};

export const deriveManagedDeviceFingerprint = ({ observation, device }) =>
  sha256Json({
    runnerGroup: observation.runnerGroup,
    runnerLabels: observation.runnerLabels,
    operatingSystem: observation.operatingSystem,
    browser: observation.browser,
    policy: observation.policy,
    profiles: device.deviceProfiles.map(({ id, profilePath, profileRoot }) => ({
      id,
      profilePath,
      profileRoot,
    })),
    attestation: device.attestation.publicKeyFingerprintSha256,
  });

export const assertManagedDeviceStagePayload = (
  payload,
  {
    externalPolicy,
    approvalPolicy,
    dbContract,
    current,
    expectedCollectorSourceSha,
    expectedRunId,
    expectedRunAttempt,
  },
) => {
  exactKeys(
    payload,
    [
      "collectorIdentity",
      "collectorSourceSha",
      "externalPrerequisitePolicySha256",
      "kind",
      "namespace",
      "observation",
      "observedAt",
      "oidcReceipt",
      "releaseState",
      "schemaVersion",
    ],
    "Managed device stage payload",
  );
  const configured = assertConfiguredManagedDeviceExecution(externalPolicy);
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "managed-device-stage-raw-authority/v1" ||
    payload.collectorSourceSha !== expectedCollectorSourceSha ||
    !SOURCE_SHA.test(payload.collectorSourceSha ?? "") ||
    !NAMESPACE.test(payload.namespace ?? "") ||
    payload.externalPrerequisitePolicySha256 !== configured.policySha256
  ) {
    throw new Error("Managed device stage identity differs");
  }
  assertTimestamp(payload.observedAt, "Managed device stage observedAt");
  assertBrowserPhaseExitCollectorIdentity(
    payload.collectorIdentity,
    expectedCollectorSourceSha,
  );
  if (
    payload.collectorIdentity.repository !== approvalPolicy.repository ||
    payload.collectorIdentity.runId !== expectedRunId ||
    payload.collectorIdentity.runAttempt !== expectedRunAttempt
  ) {
    throw new Error("Managed device stage collector identity differs");
  }
  assertStoredGitHubOidcReceipt({
    receipt: payload.oidcReceipt,
    policy: approvalPolicy,
    expectedSourceSha: expectedCollectorSourceSha,
    expectedRunId,
    expectedRunAttempt,
  });
  assertManagedDeviceStageState({
    authority: payload.releaseState,
    current,
    namespace: payload.namespace,
  });
  const result = summarizeManagedDeviceStagePayload({
    payload,
    externalPolicy,
    dbContract,
  });
  if (
    Date.parse(payload.observedAt) <
      Date.parse(payload.releaseState.activation.committedAt) ||
    Date.parse(payload.observedAt) <
      Date.parse(payload.observation.closures[1].closedAt)
  ) {
    throw new Error("Managed device stage predates its alias event");
  }
  return Object.freeze({ payload, result });
};

const publicSpki = (key) => key.export({ format: "der", type: "spki" });

export const createSignedManagedDeviceStageReceipt = ({
  payload,
  privateKeyPem,
  publicKeyPem,
  validation,
}) => {
  assertManagedDeviceStagePayload(payload, validation);
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(publicKeyPem);
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Managed device stage signing keys are not Ed25519");
  }
  const payloadBytes = canonicalJsonBytes(payload);
  const signature = signBytes(null, payloadBytes, privateKey);
  if (!verifyBytes(null, payloadBytes, publicKey, signature)) {
    throw new Error("Managed device stage signing keys differ");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-stage-signed-receipt/v1",
    payload: structuredClone(payload),
    signature: Object.freeze({
      algorithm: "ed25519",
      publicKeySpkiBase64: publicSpki(publicKey).toString("base64"),
      signatureBase64: signature.toString("base64"),
    }),
  });
};

export const assertSignedManagedDeviceStageReceipt = (receipt, validation) => {
  exactKeys(
    receipt,
    ["kind", "payload", "schemaVersion", "signature"],
    "Managed device stage receipt",
  );
  exactKeys(
    receipt.signature,
    ["algorithm", "publicKeySpkiBase64", "signatureBase64"],
    "Managed device stage signature",
  );
  const configured = assertConfiguredManagedDeviceExecution(
    validation.externalPolicy,
  );
  const publicKeyBytes = decodeBase64(
    receipt.signature.publicKeySpkiBase64,
    "Managed device stage public key",
  );
  const signature = decodeBase64(
    receipt.signature.signatureBase64,
    "Managed device stage signature",
  );
  const publicKey = createPublicKey({
    key: publicKeyBytes,
    format: "der",
    type: "spki",
  });
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "managed-device-stage-signed-receipt/v1" ||
    receipt.signature.algorithm !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    managedDevicePublicKeyFingerprint(publicKey) !==
      configured.device.attestation.publicKeyFingerprintSha256 ||
    !verifyBytes(
      null,
      canonicalJsonBytes(receipt.payload),
      publicKey,
      signature,
    )
  ) {
    throw new Error("Managed device stage signature differs");
  }
  const asserted = assertManagedDeviceStagePayload(receipt.payload, validation);
  return Object.freeze({
    ...asserted,
    receiptSha256: sha256Json(receipt),
  });
};

const assertReviewedStage = (stage) => {
  exactKeys(
    stage,
    ["receipt", "runAttempt", "runId"],
    "Reviewed managed device stage",
  );
  if (
    typeof stage.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(stage.runId) ||
    typeof stage.runAttempt !== "string" ||
    !/^[1-9][0-9]*$/u.test(stage.runAttempt)
  ) {
    throw new Error("Reviewed managed device run identity differs");
  }
};

export const aggregateManagedDeviceStages = ({
  authority,
  reviewedStages,
  externalPolicy,
  approvalPolicy,
  dbContract,
  current,
  expectedCollectorSourceSha,
}) => {
  if (
    !Object.hasOwn(MANAGED_DEVICE_MULTISTAGE_MEDIA_TYPES, authority) ||
    !Array.isArray(reviewedStages) ||
    reviewedStages.length !== 3
  ) {
    throw new Error("Managed device multistage authority set differs");
  }
  const asserted = reviewedStages.map((stage) => {
    assertReviewedStage(stage);
    return assertSignedManagedDeviceStageReceipt(stage.receipt, {
      externalPolicy,
      approvalPolicy,
      dbContract,
      current,
      expectedCollectorSourceSha,
      expectedRunId: stage.runId,
      expectedRunAttempt: stage.runAttempt,
    });
  });
  if (new Set(reviewedStages.map(({ runId }) => runId)).size !== 3) {
    throw new Error("Managed device stages require three distinct runs");
  }
  const sequence = resolveManagedDeviceMultistageSequence({
    current,
    namespace: asserted[0].payload.namespace,
    expectedCollectorSourceSha,
  });
  return aggregateValidatedManagedDeviceStages({
    authority,
    validatedStages: asserted,
    current,
    expectedCollectorSourceSha,
    sequenceAuthority: sequence.authority,
  });
};

export const aggregateValidatedManagedDeviceStages = ({
  authority,
  validatedStages,
  current,
  expectedCollectorSourceSha,
  sequenceAuthority,
}) => {
  if (
    !Object.hasOwn(MANAGED_DEVICE_MULTISTAGE_MEDIA_TYPES, authority) ||
    !Array.isArray(validatedStages) ||
    validatedStages.length !== 3 ||
    !SOURCE_SHA.test(expectedCollectorSourceSha ?? "")
  ) {
    throw new Error("Validated managed device stage set differs");
  }
  const asserted = [...validatedStages];
  asserted.forEach((stage) => {
    exactKeys(
      stage,
      ["payload", "receiptSha256", "result"],
      "Validated managed device stage",
    );
    assertSha256(stage.receiptSha256, "Managed device stage receipt");
  });
  if (
    new Set(asserted.map(({ payload }) => payload.collectorIdentity?.runId))
      .size !== 3
  ) {
    throw new Error("Managed device stages require three distinct runs");
  }
  asserted.sort(
    (left, right) =>
      left.payload.releaseState.activation.sequence -
      right.payload.releaseState.activation.sequence,
  );
  const [initial, rollback, final] = asserted;
  const sources = asserted.map(({ result }) => result.deploymentSourceSha);
  const sequences = asserted.map(
    ({ payload }) => payload.releaseState.activation.sequence,
  );
  exactKeys(
    sequenceAuthority,
    ["head", "stages"],
    "Managed device multistage sequence authority",
  );
  if (
    !same(sequenceAuthority.head, current?.head) ||
    !Array.isArray(sequenceAuthority.stages) ||
    sequenceAuthority.stages.length !== 3 ||
    sequenceAuthority.stages.some(
      (stage, index) =>
        stage.role !==
          ["initial-forward", "rollback", "final-forward"][index] ||
        !same(
          stage.activation,
          asserted[index].payload.releaseState.activation,
        ) ||
        !same(
          stage.activeBinding,
          asserted[index].payload.releaseState.activeBinding,
        ),
    )
  ) {
    throw new Error("Managed device reviewed stages differ from live ancestry");
  }
  if (
    sources[0] !== expectedCollectorSourceSha ||
    sources[1] === sources[0] ||
    sources[2] !== sources[0] ||
    rollback.payload.releaseState.activation.event.eventType !==
      "rollback-activated" ||
    final.payload.releaseState.activation.event.eventType !==
      "rollback-activated" ||
    !(sequences[0] < sequences[1] && sequences[1] < sequences[2]) ||
    !same(final.payload.releaseState.head, current?.head) ||
    !same(
      final.payload.releaseState.activeBinding,
      current?.snapshot?.activeProduction,
    ) ||
    Date.parse(initial.payload.observedAt) >=
      Date.parse(rollback.payload.releaseState.activation.committedAt) ||
    Date.parse(rollback.payload.observedAt) >=
      Date.parse(final.payload.releaseState.activation.committedAt)
  ) {
    throw new Error("Managed device forward/rollback/forward ancestry differs");
  }
  const deviceFingerprints = new Set(
    asserted.map(({ result }) => result.deviceFingerprintSha256),
  );
  if (deviceFingerprints.size !== 1) {
    throw new Error("Managed device stages used different devices");
  }
  for (let clientIndex = 0; clientIndex < CLIENT_IDS.length; clientIndex += 1) {
    const clients = asserted.map(({ result }) => result.clients[clientIndex]);
    if (
      clients.some(({ profileId }) => profileId !== CLIENT_IDS[clientIndex]) ||
      clients[0].controllerSha256 === clients[1].controllerSha256 ||
      clients[0].controllerSha256 !== clients[2].controllerSha256 ||
      clients[0].legacyRawSha256 !== clients[1].legacyRawSha256 ||
      clients[0].legacyRawSha256 !== clients[2].legacyRawSha256 ||
      new Set(clients.map(({ checkpointSha256 }) => checkpointSha256)).size !==
        1 ||
      new Set(clients.map(({ rawDatabaseSha256 }) => rawDatabaseSha256))
        .size !== 1 ||
      new Set(clients.map(({ syncQueue }) => syncQueue.journalSha256)).size !==
        1 ||
      clients.some(
        ({ cleanup }) =>
          cleanup.callCount !== 0 || cleanup.physicalDeleteCount !== 0,
      )
    ) {
      throw new Error("Managed device client stage semantics differ");
    }
    if (
      authority === "idb-device-compatibility" &&
      new Set(
        clients.map(
          ({ databaseFingerprintSha256 }) => databaseFingerprintSha256,
        ),
      ).size !== 1
    ) {
      throw new Error("Managed device IDB fingerprint changed across stages");
    }
  }
  const document = Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-multistage-authority/v1",
    authority,
    sourceSha: expectedCollectorSourceSha,
    deviceFingerprintSha256: initial.result.deviceFingerprintSha256,
    releaseStateSequenceSha256: sha256Json(sequenceAuthority),
    stages: Object.freeze(
      asserted.map(({ payload, receiptSha256 }, index) => ({
        role: ["initial-forward", "rollback", "final-forward"][index],
        runId: payload.collectorIdentity.runId,
        runAttempt: payload.collectorIdentity.runAttempt,
        receiptSha256,
        activation: structuredClone(payload.releaseState.activation),
        bindingId: payload.releaseState.activeBinding.bindingId,
        sourceSha: payload.releaseState.activeBinding.sourceSha,
      })),
    ),
    result: Object.freeze({
      clientKinds: Object.freeze(["browser-tab", "installed-pwa"]),
      transitionCount: 3,
      finalSourceSha: sources[2],
      databaseFingerprintSha256:
        authority === "idb-device-compatibility"
          ? final.result.clients[0].databaseFingerprintSha256
          : null,
    }),
  });
  return Object.freeze({
    document,
    sha256: sha256Json(document),
    stages: asserted,
  });
};

export const deriveManagedDeviceStageCollectorIdentity = ({
  sourceSha,
  approvalPolicy,
  runId,
  runAttempt,
}) =>
  deriveBrowserPhaseExitCollectorIdentity({
    sourceSha,
    oidcAuthority: { approvalPolicy, runId, runAttempt },
  });
