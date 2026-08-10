const CLIENT_ROLES = Object.freeze([
  "primary",
  "secondary",
  "standalone-equivalent",
]);

const PROMPT_CLOSE_DRILL_MODES = Object.freeze(["required", "disabled"]);
const ROLLBACK_TARGET_CAPABILITY_MODES = Object.freeze([
  "required",
  "legacy-absent",
]);
const ROLLBACK_ACTIVATION_MODES = Object.freeze([
  "auto-takeover",
  "natural-after-client-release",
]);

export const resolvePromptCloseAllDrillMode = ({
  transitionMode,
  configuredMode,
}) => {
  if (![null, "rollback", "forward"].includes(transitionMode)) {
    throw new Error("Prompt-close transition mode is invalid");
  }
  if (
    configuredMode !== undefined &&
    !PROMPT_CLOSE_DRILL_MODES.includes(configuredMode)
  ) {
    throw new Error(
      "ESP_PROMPT_CLOSE_DRILL must be exactly required or disabled",
    );
  }
  if (transitionMode === "forward") {
    return configuredMode ?? "required";
  }
  if (configuredMode === "required") {
    throw new Error("Prompt-close drill requires a forward transition");
  }
  return "disabled";
};

export const resolveRollbackTargetCapabilityMode = ({
  transitionMode,
  configuredMode,
}) => {
  if (![null, "rollback", "forward"].includes(transitionMode)) {
    throw new Error("Rollback target capability transition mode is invalid");
  }
  if (
    configuredMode !== undefined &&
    !ROLLBACK_TARGET_CAPABILITY_MODES.includes(configuredMode)
  ) {
    throw new Error(
      "ESP_ROLLBACK_TARGET_CAPABILITY must be exactly required or legacy-absent",
    );
  }
  if (transitionMode === "rollback") {
    return configuredMode ?? "required";
  }
  if (configuredMode !== undefined) {
    throw new Error(
      "Rollback target capability mode requires a rollback transition",
    );
  }
  return "required";
};

export const resolveRollbackActivationMode = ({
  transitionMode,
  configuredMode,
}) => {
  if (![null, "rollback", "forward"].includes(transitionMode)) {
    throw new Error("Rollback activation transition mode is invalid");
  }
  if (
    configuredMode !== undefined &&
    !ROLLBACK_ACTIVATION_MODES.includes(configuredMode)
  ) {
    throw new Error(
      "ESP_ROLLBACK_ACTIVATION must be exactly auto-takeover or natural-after-client-release",
    );
  }
  if (transitionMode === "rollback") {
    if (configuredMode === undefined) {
      throw new Error("Rollback activation mode must be configured explicitly");
    }
    return configuredMode;
  }
  if (configuredMode !== undefined) {
    throw new Error("Rollback activation mode requires a rollback transition");
  }
  return null;
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected, label) => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
};

export const assertLegacyRollbackCapabilityAbsence = (value) => {
  exactKeys(
    value,
    ["contentType", "observation", "status"],
    "Legacy rollback capability observation",
  );
  if (
    !Number.isSafeInteger(value.status) ||
    typeof value.contentType !== "string" ||
    !["release-capability", "html-fallback", "other"].includes(
      value.observation,
    ) ||
    value.observation === "release-capability" ||
    !(
      value.status === 404 ||
      (value.status === 200 && value.observation === "html-fallback")
    )
  ) {
    throw new Error(
      "Legacy rollback target unexpectedly exposes a versioned capability",
    );
  }
  return value;
};

const nonnegativeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a nonnegative integer`);
  }
};

const assertPhase = (value, expected, label, extraKeys = []) => {
  exactKeys(
    value,
    [
      "action",
      "actionVisible",
      "blockerCount",
      "closeGuidanceVisible",
      "flushFailureCount",
      "phase",
      "responsiveCount",
      "saveOperationCount",
      "snapshotCount",
      "unresponsiveCount",
      ...extraKeys,
    ],
    label,
  );
  for (const key of [
    "blockerCount",
    "flushFailureCount",
    "responsiveCount",
    "saveOperationCount",
    "snapshotCount",
    "unresponsiveCount",
  ]) {
    nonnegativeInteger(value[key], `${label} ${key}`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw new Error(`${label} ${key} differs`);
    }
  }
};

export const assertPromptCloseAllBrowserDrill = (
  value,
  {
    expectedFromArtifactId = null,
    expectedServiceWorkerUrl = null,
    expectedTargetArtifactId = null,
  } = {},
) => {
  exactKeys(
    value,
    [
      "blockerFixture",
      "clientRoles",
      "controllerBeforeClose",
      "failedClosed",
      "interaction",
      "kind",
      "naturalActivation",
      "postflush",
      "preflush",
      "release",
      "schemaVersion",
      "snapshotRequests",
    ],
    "Prompt-close browser drill",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "prompt-close-all-browser-drill/v1" ||
    value.blockerFixture !==
      "synthetic-protocol-blocker-with-real-event-autosave-persistence" ||
    JSON.stringify(value.clientRoles) !== JSON.stringify(CLIENT_ROLES)
  ) {
    throw new Error("Prompt-close browser drill identity differs");
  }

  exactKeys(
    value.interaction,
    [
      "eventAutosaveBlockerObserved",
      "eventAutosaveMutationPersistedAfterInitialAction",
      "initialAction",
      "operationCount",
      "persistedItemCount",
      "retryAction",
    ],
    "Prompt-close browser interaction",
  );
  nonnegativeInteger(
    value.interaction.operationCount,
    "Prompt-close operation count",
  );
  nonnegativeInteger(
    value.interaction.persistedItemCount,
    "Prompt-close persisted item count",
  );
  if (
    value.interaction.initialAction !== "playwright-click" ||
    value.interaction.retryAction !== "playwright-click" ||
    value.interaction.operationCount !== 2 ||
    value.interaction.eventAutosaveBlockerObserved !== true ||
    value.interaction.eventAutosaveMutationPersistedAfterInitialAction !==
      true ||
    value.interaction.persistedItemCount < 1
  ) {
    throw new Error("Prompt-close browser interaction differs");
  }

  assertPhase(
    value.preflush,
    {
      phase: "save-required",
      snapshotCount: 3,
      responsiveCount: 3,
      unresponsiveCount: 0,
      flushFailureCount: 0,
      saveOperationCount: 0,
      action: "save-and-flush",
      actionVisible: true,
      closeGuidanceVisible: false,
    },
    "Prompt-close preflush",
  );
  if (value.preflush.blockerCount < 1) {
    throw new Error("Prompt-close preflush blocker is absent");
  }

  assertPhase(
    value.failedClosed,
    {
      cause: "script-execution-disabled-unresponsive-client",
      phase: "save-incomplete",
      snapshotCount: 3,
      responsiveCount: 2,
      blockerCount: 0,
      unresponsiveCount: 1,
      flushFailureCount: 0,
      saveOperationCount: 1,
      action: "retry",
      actionVisible: true,
      closeGuidanceVisible: false,
    },
    "Prompt-close failed-closed",
    ["cause"],
  );

  assertPhase(
    value.postflush,
    {
      phase: "ready-to-close",
      snapshotCount: 3,
      responsiveCount: 3,
      blockerCount: 0,
      unresponsiveCount: 0,
      flushFailureCount: 0,
      saveOperationCount: 2,
      action: null,
      actionVisible: false,
      closeGuidanceVisible: true,
    },
    "Prompt-close postflush",
  );

  if (
    !Array.isArray(value.snapshotRequests) ||
    value.snapshotRequests.length !== CLIENT_ROLES.length
  ) {
    throw new Error("Prompt-close snapshot request set differs");
  }
  value.snapshotRequests.forEach((request, index) => {
    exactKeys(
      request,
      [
        "flushCount",
        "inspectionCount",
        "productionCleanFlushResponseCount",
        "productionFlushCount",
        "productionFlushResponseCount",
        "role",
      ],
      "Prompt-close snapshot request",
    );
    nonnegativeInteger(
      request.inspectionCount,
      "Prompt-close inspection request count",
    );
    nonnegativeInteger(request.flushCount, "Prompt-close flush request count");
    nonnegativeInteger(
      request.productionFlushCount,
      "Prompt-close production flush request count",
    );
    nonnegativeInteger(
      request.productionFlushResponseCount,
      "Prompt-close production flush response count",
    );
    nonnegativeInteger(
      request.productionCleanFlushResponseCount,
      "Prompt-close production clean flush response count",
    );
    if (
      request.role !== CLIENT_ROLES[index] ||
      request.inspectionCount < 1 ||
      request.flushCount < 1 ||
      request.productionFlushCount < 1 ||
      request.productionFlushResponseCount < 1 ||
      request.productionCleanFlushResponseCount < 1 ||
      request.productionFlushResponseCount > request.productionFlushCount ||
      request.productionCleanFlushResponseCount >
        request.productionFlushResponseCount
    ) {
      throw new Error("Prompt-close client snapshot requests differ");
    }
  });

  exactKeys(
    value.controllerBeforeClose,
    ["clients", "fromArtifactId", "targetArtifactId", "waitingVersionId"],
    "Prompt-close controller evidence",
  );
  if (
    typeof value.controllerBeforeClose.fromArtifactId !== "string" ||
    typeof value.controllerBeforeClose.targetArtifactId !== "string" ||
    typeof value.controllerBeforeClose.waitingVersionId !== "string" ||
    value.controllerBeforeClose.waitingVersionId.length === 0 ||
    (expectedFromArtifactId !== null &&
      value.controllerBeforeClose.fromArtifactId !== expectedFromArtifactId) ||
    (expectedTargetArtifactId !== null &&
      value.controllerBeforeClose.targetArtifactId !==
        expectedTargetArtifactId) ||
    !Array.isArray(value.controllerBeforeClose.clients) ||
    value.controllerBeforeClose.clients.length !== CLIENT_ROLES.length
  ) {
    throw new Error("Prompt-close controller identity differs");
  }
  value.controllerBeforeClose.clients.forEach((client, index) => {
    exactKeys(
      client,
      [
        "activeState",
        "controllerChangeCountDelta",
        "controllerScriptUrl",
        "controllerState",
        "role",
        "waitingState",
      ],
      "Prompt-close controller client",
    );
    if (
      client.role !== CLIENT_ROLES[index] ||
      client.activeState !== "activated" ||
      client.waitingState !== "installed" ||
      client.controllerState !== "activated" ||
      client.controllerChangeCountDelta !== 0 ||
      typeof client.controllerScriptUrl !== "string" ||
      (expectedServiceWorkerUrl !== null &&
        client.controllerScriptUrl !== expectedServiceWorkerUrl)
    ) {
      throw new Error("Prompt-close controller client differs");
    }
  });

  exactKeys(
    value.release,
    [
      "releasedClientCount",
      "releasedTargetCount",
      "remainingOriginClientCount",
      "startedAfterReadyToClose",
    ],
    "Prompt-close client release",
  );
  if (
    value.release.releasedClientCount !== 3 ||
    value.release.releasedTargetCount !== 3 ||
    value.release.remainingOriginClientCount !== 0 ||
    value.release.startedAfterReadyToClose !== true
  ) {
    throw new Error("Prompt-close client release differs");
  }

  exactKeys(
    value.naturalActivation,
    ["outcome", "reopenedClientCount", "stableAfterReopen", "versionId"],
    "Prompt-close natural activation",
  );
  if (
    value.naturalActivation.outcome !== "natural-after-all-clients-closed" ||
    value.naturalActivation.versionId !==
      value.controllerBeforeClose.waitingVersionId ||
    value.naturalActivation.stableAfterReopen !== true ||
    value.naturalActivation.reopenedClientCount !== 2
  ) {
    throw new Error("Prompt-close natural activation differs");
  }
  return value;
};
