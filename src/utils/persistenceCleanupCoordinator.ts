export const PERSISTENCE_LEGACY_CLEANUP_BUILD_FLAG =
  "VITE_PERSISTENCE_LEGACY_CLEANUP" as const;
export const PERSISTENCE_LEGACY_CLEANUP_ENABLED_VALUE = "true" as const;
export const PERSISTENCE_LEGACY_CLEANUP_LOCK_NAME =
  "event-shopping-planner:persistence-legacy-cleanup" as const;
export const MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION =
  "other-tabs-closed" as const;
export const DEFAULT_PERSISTENCE_CLEANUP_CHECK_TIMEOUT_MS = 5_000;

export type PersistenceCleanupMode = "auto" | "manual";

export type PersistenceCleanupDeferredReason =
  | "runtime-kill-switch-unknown"
  | "web-locks-unsupported"
  | "exclusive-lock-unavailable"
  | "exclusive-lock-not-proven"
  | "exclusive-lock-request-failed"
  | "service-worker-state-unknown"
  | "service-worker-unsupported"
  | "service-worker-registration-missing"
  | "service-worker-not-active"
  | "service-worker-update-waiting"
  | "service-worker-version-unconfigured"
  | "service-worker-version-unknown"
  | "service-worker-version-mismatch"
  | "supported-client-version-unconfigured"
  | "client-handshake-unknown"
  | "client-version-unknown"
  | "unsupported-client-version"
  | "unresponsive-client"
  | "client-quiescence-unknown"
  | "client-not-quiescent";

export type PersistenceCleanupBlockedReason =
  | "feature-flag-disabled"
  | "runtime-kill-switch-active"
  | "manual-other-tabs-not-confirmed"
  | "cleanup-task-failed"
  | "exclusive-lock-lifecycle-failed";

export type PersistenceCleanupPhysicalDeferredReason =
  | "cleanup-not-ready"
  | "migration-journal-cas-failed"
  | "legacy-source-remove-failed"
  | "legacy-source-missing-after-claim";

export type PersistenceCleanupPhysicalBlockedReason =
  | "migration-journal-invalid"
  | "migration-archive-invalid"
  | "committed-target-invalid"
  | "legacy-storage-unavailable"
  | "legacy-source-changed"
  | "legacy-source-reappeared"
  | "legacy-source-missing-before-claim"
  | "legacy-source-digest-mismatch";

export type PersistenceCleanupResult<T = void> =
  | {
      status: "completed";
      mode: PersistenceCleanupMode;
      value: T;
    }
  | {
      status: "cleanup-deferred";
      mode: PersistenceCleanupMode;
      reason: PersistenceCleanupDeferredReason;
    }
  | {
      status: "cleanup-blocked";
      mode: PersistenceCleanupMode;
      reason: PersistenceCleanupBlockedReason;
    };

export type PersistenceCleanupSafetyRevalidation =
  | { readonly status: "safe" }
  | {
      readonly status: "cleanup-deferred";
      readonly reason: PersistenceCleanupDeferredReason;
    }
  | {
      readonly status: "cleanup-blocked";
      readonly reason: PersistenceCleanupBlockedReason;
    };

export interface PersistenceCleanupTaskContext {
  /**
   * Revalidates the applicable safety proof while the coordinator still owns
   * the cleanup lock. Destructive tasks must call this immediately before
   * every irreversible operation.
   */
  readonly revalidateSafety: () => Promise<PersistenceCleanupSafetyRevalidation>;
}

/**
 * The event deliberately contains only closed enums. Raw values, keys, client
 * identifiers, error messages, and an arbitrary payload are not accepted.
 */
export type PersistenceCleanupMetricEvent =
  | {
      name: "persistence-cleanup-attempted";
      mode: PersistenceCleanupMode;
    }
  | {
      name: "persistence-cleanup-task-started";
      mode: PersistenceCleanupMode;
    }
  | {
      name: "persistence-cleanup-deferred";
      mode: PersistenceCleanupMode;
      reason: PersistenceCleanupDeferredReason;
    }
  | {
      name: "persistence-cleanup-blocked";
      mode: PersistenceCleanupMode;
      reason: PersistenceCleanupBlockedReason;
    }
  | {
      name: "persistence-cleanup-completed";
      mode: PersistenceCleanupMode;
    }
  | {
      name: "persistence-cleanup-key-confirmed-removed";
      mode: PersistenceCleanupMode;
    }
  | {
      name: "persistence-cleanup-physical-deferred";
      mode: PersistenceCleanupMode;
      reason:
        | PersistenceCleanupDeferredReason
        | PersistenceCleanupPhysicalDeferredReason;
    }
  | {
      name: "persistence-cleanup-physical-blocked";
      mode: PersistenceCleanupMode;
      reason:
        | PersistenceCleanupBlockedReason
        | PersistenceCleanupPhysicalBlockedReason;
    };

export type PersistenceCleanupMetricSink = (
  event: PersistenceCleanupMetricEvent,
) => void | Promise<void>;

export interface PersistenceCleanupLock {
  readonly name: string;
  readonly mode: "exclusive" | "shared";
}

export interface PersistenceCleanupLockManager {
  request<T>(
    name: string,
    options: {
      readonly mode: "exclusive";
      readonly ifAvailable: true;
    },
    callback: (lock: PersistenceCleanupLock | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface PersistenceCleanupClientObservation {
  /**
   * A protocol/application version, not a client identifier.
   * null means that the version could not be proved.
   */
  readonly version: string | null;
  readonly response: "responsive" | "unresponsive";
  readonly quiescence: "quiescent" | "active" | "unknown";
}

export type PersistenceCleanupClientHandshakeProof =
  | {
      /**
       * The provider proved that enumeration and the handshake both completed.
       * The coordinator still audits every observation below.
       */
      readonly status: "complete";
      readonly clients: readonly PersistenceCleanupClientObservation[];
    }
  | {
      readonly status: "unknown";
    };

export type PersistenceCleanupServiceWorkerProof =
  | {
      readonly status: "complete";
      readonly hasActiveWorker: boolean;
      readonly hasWaitingWorker: boolean;
      readonly activeWorkerVersion: string | null;
    }
  | {
      readonly status: "unknown" | "unsupported" | "registration-missing";
    };

interface PersistenceCleanupCommonRequest<T> {
  /**
   * Test-only override. Non-test builds always read
   * VITE_PERSISTENCE_LEGACY_CLEANUP and ignore this value.
   */
  readonly buildFlagValue?: unknown;
  /**
   * Must explicitly resolve to false. Missing, rejected, timed-out, or
   * non-boolean states fail closed.
   */
  readonly isRuntimeKillSwitchActive?: () => boolean | PromiseLike<boolean>;
  /**
   * Test-only override. Non-test builds always inspect navigator.locks and
   * ignore this value.
   */
  readonly lockManager?: PersistenceCleanupLockManager | null;
  readonly safetyCheckTimeoutMs?: number;
  readonly cleanupTask: (
    context: PersistenceCleanupTaskContext,
  ) => T | PromiseLike<T>;
  readonly metricSink?: PersistenceCleanupMetricSink;
}

export interface AutomaticPersistenceCleanupRequest<
  T = void,
> extends PersistenceCleanupCommonRequest<T> {
  readonly mode: "auto";
  readonly supportedClientVersions: readonly string[];
  readonly supportedServiceWorkerVersions: readonly string[];
  readonly getClientHandshakeProof: () =>
    | PersistenceCleanupClientHandshakeProof
    | PromiseLike<PersistenceCleanupClientHandshakeProof>;
  readonly getServiceWorkerProof: () =>
    | PersistenceCleanupServiceWorkerProof
    | PromiseLike<PersistenceCleanupServiceWorkerProof>;
}

export interface ManualPersistenceCleanupRequest<
  T = void,
> extends PersistenceCleanupCommonRequest<T> {
  readonly mode: "manual";
  /**
   * The UI must only pass this literal after the user confirms that every
   * other tab and installed-PWA window has been closed.
   */
  readonly otherTabsClosedConfirmation?: typeof MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION;
}

export type PersistenceCleanupRequest<T = void> =
  | AutomaticPersistenceCleanupRequest<T>
  | ManualPersistenceCleanupRequest<T>;

type SafetyCheckResult<T> =
  | { status: "value"; value: T }
  | { status: "failed" }
  | { status: "timed-out" };

const readPersistenceLegacyCleanupBuildFlag = (): unknown =>
  import.meta.env.VITE_PERSISTENCE_LEGACY_CLEANUP;

export const isPersistenceLegacyCleanupBuildEnabled = (
  testOverride?: unknown,
): boolean => {
  const value =
    import.meta.env.MODE === "test" && testOverride !== undefined
      ? testOverride
      : readPersistenceLegacyCleanupBuildFlag();
  return value === PERSISTENCE_LEGACY_CLEANUP_ENABLED_VALUE;
};

const resolveSafetyCheckTimeout = (timeoutMs: number | undefined): number =>
  typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_PERSISTENCE_CLEANUP_CHECK_TIMEOUT_MS;

const runSafetyCheck = async <T>(
  check: () => T | PromiseLike<T>,
  timeoutMs: number,
): Promise<SafetyCheckResult<T>> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const checkPromise = Promise.resolve()
    .then(check)
    .then(
      (value): SafetyCheckResult<T> => ({ status: "value", value }),
      (): SafetyCheckResult<T> => ({ status: "failed" }),
    );
  const timeoutPromise = new Promise<SafetyCheckResult<T>>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ status: "timed-out" }),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([checkPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};

export const emitPersistenceCleanupMetric = (
  sink: PersistenceCleanupMetricSink | undefined,
  event: PersistenceCleanupMetricEvent,
): void => {
  if (!sink) return;

  try {
    void Promise.resolve(sink(event)).catch(() => undefined);
  } catch {
    // Metrics are best effort and must never influence cleanup safety.
  }
};

const emitMetric = emitPersistenceCleanupMetric;

const deferred = <T>(
  mode: PersistenceCleanupMode,
  reason: PersistenceCleanupDeferredReason,
  sink: PersistenceCleanupMetricSink | undefined,
): PersistenceCleanupResult<T> => {
  emitMetric(sink, {
    name: "persistence-cleanup-deferred",
    mode,
    reason,
  });
  return { status: "cleanup-deferred", mode, reason };
};

const blocked = <T>(
  mode: PersistenceCleanupMode,
  reason: PersistenceCleanupBlockedReason,
  sink: PersistenceCleanupMetricSink | undefined,
): PersistenceCleanupResult<T> => {
  emitMetric(sink, {
    name: "persistence-cleanup-blocked",
    mode,
    reason,
  });
  return { status: "cleanup-blocked", mode, reason };
};

const inspectRuntimeKillSwitch = async (
  check: (() => boolean | PromiseLike<boolean>) | undefined,
  timeoutMs: number,
): Promise<"active" | "inactive" | "unknown"> => {
  if (!check) return "unknown";

  const result = await runSafetyCheck(check, timeoutMs);
  if (result.status !== "value" || typeof result.value !== "boolean") {
    return "unknown";
  }
  return result.value ? "active" : "inactive";
};

const getBrowserLockManager = (): PersistenceCleanupLockManager | null => {
  if (typeof navigator === "undefined") return null;

  const candidate = (
    navigator as Navigator & {
      readonly locks?: unknown;
    }
  ).locks;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { request?: unknown }).request !== "function"
  ) {
    return null;
  }
  return candidate as PersistenceCleanupLockManager;
};

const resolveLockManager = <T>(
  request: PersistenceCleanupCommonRequest<T>,
): PersistenceCleanupLockManager | null =>
  import.meta.env.MODE === "test" && request.lockManager !== undefined
    ? request.lockManager
    : getBrowserLockManager();

const inspectServiceWorkerProof = async (
  request: AutomaticPersistenceCleanupRequest<unknown>,
  timeoutMs: number,
): Promise<PersistenceCleanupDeferredReason | null> => {
  const supportedVersions = new Set(
    request.supportedServiceWorkerVersions.filter(
      (version) => typeof version === "string" && version.length > 0,
    ),
  );
  if (supportedVersions.size === 0) {
    return "service-worker-version-unconfigured";
  }

  const result = await runSafetyCheck(request.getServiceWorkerProof, timeoutMs);
  if (result.status !== "value") return "service-worker-state-unknown";

  const proof = result.value;
  if (
    typeof proof !== "object" ||
    proof === null ||
    typeof (proof as { status?: unknown }).status !== "string"
  ) {
    return "service-worker-state-unknown";
  }
  switch (proof.status) {
    case "unknown":
      return "service-worker-state-unknown";
    case "unsupported":
      return "service-worker-unsupported";
    case "registration-missing":
      return "service-worker-registration-missing";
    case "complete":
      if (proof.hasWaitingWorker) return "service-worker-update-waiting";
      if (!proof.hasActiveWorker) return "service-worker-not-active";
      if (
        typeof proof.activeWorkerVersion !== "string" ||
        proof.activeWorkerVersion.length === 0
      ) {
        return "service-worker-version-unknown";
      }
      if (!supportedVersions.has(proof.activeWorkerVersion)) {
        return "service-worker-version-mismatch";
      }
      return null;
  }
};

const inspectClientProof = async (
  request: AutomaticPersistenceCleanupRequest<unknown>,
  timeoutMs: number,
): Promise<PersistenceCleanupDeferredReason | null> => {
  const supportedVersions = new Set(
    request.supportedClientVersions.filter(
      (version) => typeof version === "string" && version.length > 0,
    ),
  );
  if (supportedVersions.size === 0) {
    return "supported-client-version-unconfigured";
  }

  const result = await runSafetyCheck(
    request.getClientHandshakeProof,
    timeoutMs,
  );
  if (
    result.status !== "value" ||
    typeof result.value !== "object" ||
    result.value === null ||
    result.value.status !== "complete" ||
    !Array.isArray(result.value.clients)
  ) {
    return "client-handshake-unknown";
  }

  const clients = result.value.clients;
  if (clients.length === 0) return "client-handshake-unknown";
  if (clients.some((client) => typeof client !== "object" || client === null)) {
    return "client-handshake-unknown";
  }
  if (clients.some((client) => client.response !== "responsive")) {
    return "unresponsive-client";
  }
  if (
    clients.some(
      (client) =>
        typeof client.version !== "string" || client.version.length === 0,
    )
  ) {
    return "client-version-unknown";
  }
  if (
    clients.some(
      (client) =>
        client.version !== null && !supportedVersions.has(client.version),
    )
  ) {
    return "unsupported-client-version";
  }
  if (clients.some((client) => client.quiescence === "unknown")) {
    return "client-quiescence-unknown";
  }
  if (clients.some((client) => client.quiescence !== "quiescent")) {
    return "client-not-quiescent";
  }
  return null;
};

const revalidateCleanupSafety = async <T>(
  request: PersistenceCleanupRequest<T>,
  timeoutMs: number,
): Promise<PersistenceCleanupSafetyRevalidation> => {
  const initialKillSwitch = await inspectRuntimeKillSwitch(
    request.isRuntimeKillSwitchActive,
    timeoutMs,
  );
  if (initialKillSwitch === "unknown") {
    return {
      status: "cleanup-deferred",
      reason: "runtime-kill-switch-unknown",
    };
  }
  if (initialKillSwitch === "active") {
    return {
      status: "cleanup-blocked",
      reason: "runtime-kill-switch-active",
    };
  }

  if (request.mode === "auto") {
    const serviceWorkerReason = await inspectServiceWorkerProof(
      request,
      timeoutMs,
    );
    if (serviceWorkerReason) {
      return { status: "cleanup-deferred", reason: serviceWorkerReason };
    }

    const clientReason = await inspectClientProof(request, timeoutMs);
    if (clientReason) {
      return { status: "cleanup-deferred", reason: clientReason };
    }

    const finalKillSwitch = await inspectRuntimeKillSwitch(
      request.isRuntimeKillSwitchActive,
      timeoutMs,
    );
    if (finalKillSwitch === "unknown") {
      return {
        status: "cleanup-deferred",
        reason: "runtime-kill-switch-unknown",
      };
    }
    if (finalKillSwitch === "active") {
      return {
        status: "cleanup-blocked",
        reason: "runtime-kill-switch-active",
      };
    }
  }

  return { status: "safe" };
};

const runCleanupTask = async <T>(
  request: PersistenceCleanupRequest<T>,
  timeoutMs: number,
): Promise<PersistenceCleanupResult<T>> => {
  emitMetric(request.metricSink, {
    name: "persistence-cleanup-task-started",
    mode: request.mode,
  });
  try {
    const value = await request.cleanupTask({
      revalidateSafety: () => revalidateCleanupSafety(request, timeoutMs),
    });
    emitMetric(request.metricSink, {
      name: "persistence-cleanup-completed",
      mode: request.mode,
    });
    return { status: "completed", mode: request.mode, value };
  } catch {
    return blocked(request.mode, "cleanup-task-failed", request.metricSink);
  }
};

const runAfterFinalKillSwitchCheck = async <T>(
  request: PersistenceCleanupRequest<T>,
  timeoutMs: number,
): Promise<PersistenceCleanupResult<T>> => {
  const killSwitch = await inspectRuntimeKillSwitch(
    request.isRuntimeKillSwitchActive,
    timeoutMs,
  );
  if (killSwitch === "unknown") {
    return deferred(
      request.mode,
      "runtime-kill-switch-unknown",
      request.metricSink,
    );
  }
  if (killSwitch === "active") {
    return blocked(
      request.mode,
      "runtime-kill-switch-active",
      request.metricSink,
    );
  }
  return runCleanupTask(request, timeoutMs);
};

const runAutomaticCleanupInsideLock = async <T>(
  request: AutomaticPersistenceCleanupRequest<T>,
  timeoutMs: number,
): Promise<PersistenceCleanupResult<T>> => {
  const killSwitch = await inspectRuntimeKillSwitch(
    request.isRuntimeKillSwitchActive,
    timeoutMs,
  );
  if (killSwitch === "unknown") {
    return deferred(
      request.mode,
      "runtime-kill-switch-unknown",
      request.metricSink,
    );
  }
  if (killSwitch === "active") {
    return blocked(
      request.mode,
      "runtime-kill-switch-active",
      request.metricSink,
    );
  }

  const serviceWorkerReason = await inspectServiceWorkerProof(
    request,
    timeoutMs,
  );
  if (serviceWorkerReason) {
    return deferred(request.mode, serviceWorkerReason, request.metricSink);
  }

  // The client proof is intentionally the last external proof so quiescence is
  // observed as close as possible to the destructive task.
  const clientReason = await inspectClientProof(request, timeoutMs);
  if (clientReason) {
    return deferred(request.mode, clientReason, request.metricSink);
  }

  return runAfterFinalKillSwitchCheck(request, timeoutMs);
};

const runWithExclusiveLock = async <T>(
  request: PersistenceCleanupRequest<T>,
  lockManager: PersistenceCleanupLockManager,
  operation: () => Promise<PersistenceCleanupResult<T>>,
): Promise<PersistenceCleanupResult<T>> => {
  let callbackResult: PersistenceCleanupResult<T> | undefined;

  try {
    await lockManager.request(
      PERSISTENCE_LEGACY_CLEANUP_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          callbackResult = deferred(
            request.mode,
            "exclusive-lock-unavailable",
            request.metricSink,
          );
          return callbackResult;
        }
        if (
          lock.name !== PERSISTENCE_LEGACY_CLEANUP_LOCK_NAME ||
          lock.mode !== "exclusive"
        ) {
          callbackResult = deferred(
            request.mode,
            "exclusive-lock-not-proven",
            request.metricSink,
          );
          return callbackResult;
        }

        callbackResult = await operation();
        return callbackResult;
      },
    );

    if (!callbackResult) {
      return deferred(
        request.mode,
        "exclusive-lock-not-proven",
        request.metricSink,
      );
    }
    return callbackResult;
  } catch {
    if (
      callbackResult?.status === "completed" ||
      callbackResult?.reason === "cleanup-task-failed"
    ) {
      return blocked(
        request.mode,
        "exclusive-lock-lifecycle-failed",
        request.metricSink,
      );
    }
    return deferred(
      request.mode,
      "exclusive-lock-request-failed",
      request.metricSink,
    );
  }
};

/**
 * Coordinates only the safety gate. The supplied task owns journal/archive
 * validation and key-by-key cleanup; this module never reads or deletes
 * localStorage/IndexedDB data itself.
 */
export const coordinatePersistenceLegacyCleanup = async <T = void>(
  request: PersistenceCleanupRequest<T>,
): Promise<PersistenceCleanupResult<T>> => {
  emitMetric(request.metricSink, {
    name: "persistence-cleanup-attempted",
    mode: request.mode,
  });

  if (!isPersistenceLegacyCleanupBuildEnabled(request.buildFlagValue)) {
    return blocked(request.mode, "feature-flag-disabled", request.metricSink);
  }

  const timeoutMs = resolveSafetyCheckTimeout(request.safetyCheckTimeoutMs);
  const initialKillSwitch = await inspectRuntimeKillSwitch(
    request.isRuntimeKillSwitchActive,
    timeoutMs,
  );
  if (initialKillSwitch === "unknown") {
    return deferred(
      request.mode,
      "runtime-kill-switch-unknown",
      request.metricSink,
    );
  }
  if (initialKillSwitch === "active") {
    return blocked(
      request.mode,
      "runtime-kill-switch-active",
      request.metricSink,
    );
  }

  const lockManager = resolveLockManager(request);

  if (request.mode === "auto") {
    if (!lockManager) {
      return deferred(
        request.mode,
        "web-locks-unsupported",
        request.metricSink,
      );
    }
    return runWithExclusiveLock(request, lockManager, () =>
      runAutomaticCleanupInsideLock(request, timeoutMs),
    );
  }

  if (
    request.otherTabsClosedConfirmation !==
    MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION
  ) {
    return blocked(
      request.mode,
      "manual-other-tabs-not-confirmed",
      request.metricSink,
    );
  }

  // Manual cleanup may proceed without a lock only when Web Locks do not
  // exist. If the API exists, proving acquisition remains mandatory.
  if (!lockManager) {
    return runAfterFinalKillSwitchCheck(request, timeoutMs);
  }
  return runWithExclusiveLock(request, lockManager, () =>
    runAfterFinalKillSwitchCheck(request, timeoutMs),
  );
};
