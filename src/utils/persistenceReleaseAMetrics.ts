export const PERSISTENCE_RELEASE_A_METRICS_STORAGE_KEY =
  "__esp_internal__:release-a-metrics:v1";
export const PERSISTENCE_RELEASE_A_METRIC_EVENT =
  "event-shopping-planner:persistence-release-a-metric";

const METRICS_KIND =
  "event-shopping-planner-persistence-release-a-metrics" as const;
const METRICS_VERSION = 1 as const;
const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;

export type PersistenceStartupDurationBucket =
  | "lt-250ms"
  | "250-999ms"
  | "1-2999ms"
  | "3-9999ms"
  | "gte-10s";

export type PersistenceReleaseAMetricEvent =
  | {
      readonly version: 1;
      readonly name: "checkpoint-adoption";
      readonly outcome:
        | "adopted"
        | "already-absorbed"
        | "not-needed"
        | "failed"
        | "conflict";
    }
  | {
      readonly version: 1;
      readonly name: "fallback-repair";
      readonly outcome: "succeeded" | "failed" | "conflict";
    }
  | {
      readonly version: 1;
      readonly name: "load";
      readonly outcome: "succeeded" | "missing" | "failed" | "conflict";
    }
  | {
      readonly version: 1;
      readonly name: "save";
      readonly outcome: "succeeded" | "failed";
    }
  | {
      readonly version: 1;
      readonly name: "startup";
      readonly outcome: "ready" | "recovery-required";
      readonly durationBucket: PersistenceStartupDurationBucket;
    };

export type PersistenceReleaseAMetricSink = (
  event: PersistenceReleaseAMetricEvent,
) => void | Promise<void>;

export interface PersistenceReleaseAMetricsSnapshot {
  readonly kind: typeof METRICS_KIND;
  readonly version: typeof METRICS_VERSION;
  readonly observationWindowStartedAt: string;
  readonly updatedAt: string;
  readonly counters: {
    readonly checkpointAdoption: {
      readonly adopted: number;
      readonly alreadyAbsorbed: number;
      readonly notNeeded: number;
      readonly failed: number;
      readonly conflict: number;
    };
    readonly fallbackRepair: {
      readonly succeeded: number;
      readonly failed: number;
      readonly conflict: number;
    };
    readonly load: {
      readonly succeeded: number;
      readonly missing: number;
      readonly failed: number;
      readonly conflict: number;
    };
    readonly save: {
      readonly succeeded: number;
      readonly failed: number;
    };
    readonly startup: {
      readonly ready: number;
      readonly recoveryRequired: number;
    };
    readonly startupDuration: Record<PersistenceStartupDurationBucket, number>;
  };
}

export interface PersistenceReleaseARateSummary {
  readonly checkpointAdoptionRate: number | null;
  readonly fallbackRepairSuccessRate: number | null;
  readonly conflictRate: number | null;
  readonly saveFailureRate: number | null;
  readonly startupRecoveryRequiredRate: number | null;
}

interface MetricsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistenceReleaseAMetricRecorder {
  record(event: PersistenceReleaseAMetricEvent): boolean;
  snapshot(): PersistenceReleaseAMetricsSnapshot;
  reset(): PersistenceReleaseAMetricsSnapshot;
  subscribe(sink: PersistenceReleaseAMetricSink): () => void;
}

export interface PersistenceReleaseAMetricRecorderOptions {
  readonly storage?: MetricsStorage | null;
  readonly sink?: PersistenceReleaseAMetricSink;
  readonly now?: () => number;
}

const CHECKPOINT_OUTCOMES = new Set([
  "adopted",
  "already-absorbed",
  "not-needed",
  "failed",
  "conflict",
]);
const REPAIR_OUTCOMES = new Set(["succeeded", "failed", "conflict"]);
const LOAD_OUTCOMES = new Set(["succeeded", "missing", "failed", "conflict"]);
const SAVE_OUTCOMES = new Set(["succeeded", "failed"]);
const STARTUP_OUTCOMES = new Set(["ready", "recovery-required"]);
const STARTUP_DURATION_BUCKETS = new Set<PersistenceStartupDurationBucket>([
  "lt-250ms",
  "250-999ms",
  "1-2999ms",
  "3-9999ms",
  "gte-10s",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sanitizeMetricEvent = (
  value: unknown,
): PersistenceReleaseAMetricEvent | null => {
  if (!isRecord(value) || value.version !== 1) return null;
  const outcome = value.outcome;
  if (typeof outcome !== "string") return null;

  switch (value.name) {
    case "checkpoint-adoption":
      return CHECKPOINT_OUTCOMES.has(outcome)
        ? {
            version: 1,
            name: "checkpoint-adoption",
            outcome: outcome as Extract<
              PersistenceReleaseAMetricEvent,
              { name: "checkpoint-adoption" }
            >["outcome"],
          }
        : null;
    case "fallback-repair":
      return REPAIR_OUTCOMES.has(outcome)
        ? {
            version: 1,
            name: "fallback-repair",
            outcome: outcome as Extract<
              PersistenceReleaseAMetricEvent,
              { name: "fallback-repair" }
            >["outcome"],
          }
        : null;
    case "load":
      return LOAD_OUTCOMES.has(outcome)
        ? {
            version: 1,
            name: "load",
            outcome: outcome as Extract<
              PersistenceReleaseAMetricEvent,
              { name: "load" }
            >["outcome"],
          }
        : null;
    case "save":
      return SAVE_OUTCOMES.has(outcome)
        ? {
            version: 1,
            name: "save",
            outcome: outcome as Extract<
              PersistenceReleaseAMetricEvent,
              { name: "save" }
            >["outcome"],
          }
        : null;
    case "startup": {
      const durationBucket = value.durationBucket;
      return STARTUP_OUTCOMES.has(outcome) &&
        typeof durationBucket === "string" &&
        STARTUP_DURATION_BUCKETS.has(
          durationBucket as PersistenceStartupDurationBucket,
        )
        ? {
            version: 1,
            name: "startup",
            outcome: outcome as Extract<
              PersistenceReleaseAMetricEvent,
              { name: "startup" }
            >["outcome"],
            durationBucket: durationBucket as PersistenceStartupDurationBucket,
          }
        : null;
    }
    default:
      return null;
  }
};

const createEmptySnapshot = (
  now: number,
): PersistenceReleaseAMetricsSnapshot => {
  const timestamp = new Date(now).toISOString();
  return {
    kind: METRICS_KIND,
    version: METRICS_VERSION,
    observationWindowStartedAt: timestamp,
    updatedAt: timestamp,
    counters: {
      checkpointAdoption: {
        adopted: 0,
        alreadyAbsorbed: 0,
        notNeeded: 0,
        failed: 0,
        conflict: 0,
      },
      fallbackRepair: {
        succeeded: 0,
        failed: 0,
        conflict: 0,
      },
      load: {
        succeeded: 0,
        missing: 0,
        failed: 0,
        conflict: 0,
      },
      save: {
        succeeded: 0,
        failed: 0,
      },
      startup: {
        ready: 0,
        recoveryRequired: 0,
      },
      startupDuration: {
        "lt-250ms": 0,
        "250-999ms": 0,
        "1-2999ms": 0,
        "3-9999ms": 0,
        "gte-10s": 0,
      },
    },
  };
};

const safeCounter = (value: unknown): number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_COUNTER_VALUE
    ? value
    : 0;

const safeTimestamp = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : fallback;
};

const hydrateSnapshot = (
  rawValue: string | null,
  now: number,
): PersistenceReleaseAMetricsSnapshot => {
  const empty = createEmptySnapshot(now);
  if (rawValue === null) return empty;

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (
      !isRecord(parsed) ||
      parsed.kind !== METRICS_KIND ||
      parsed.version !== METRICS_VERSION ||
      !isRecord(parsed.counters)
    ) {
      return empty;
    }
    const checkpoint = isRecord(parsed.counters.checkpointAdoption)
      ? parsed.counters.checkpointAdoption
      : {};
    const repair = isRecord(parsed.counters.fallbackRepair)
      ? parsed.counters.fallbackRepair
      : {};
    const load = isRecord(parsed.counters.load) ? parsed.counters.load : {};
    const save = isRecord(parsed.counters.save) ? parsed.counters.save : {};
    const startup = isRecord(parsed.counters.startup)
      ? parsed.counters.startup
      : {};
    const duration = isRecord(parsed.counters.startupDuration)
      ? parsed.counters.startupDuration
      : {};
    return {
      kind: METRICS_KIND,
      version: METRICS_VERSION,
      observationWindowStartedAt: safeTimestamp(
        parsed.observationWindowStartedAt,
        empty.observationWindowStartedAt,
      ),
      updatedAt: safeTimestamp(parsed.updatedAt, empty.updatedAt),
      counters: {
        checkpointAdoption: {
          adopted: safeCounter(checkpoint.adopted),
          alreadyAbsorbed: safeCounter(checkpoint.alreadyAbsorbed),
          notNeeded: safeCounter(checkpoint.notNeeded),
          failed: safeCounter(checkpoint.failed),
          conflict: safeCounter(checkpoint.conflict),
        },
        fallbackRepair: {
          succeeded: safeCounter(repair.succeeded),
          failed: safeCounter(repair.failed),
          conflict: safeCounter(repair.conflict),
        },
        load: {
          succeeded: safeCounter(load.succeeded),
          missing: safeCounter(load.missing),
          failed: safeCounter(load.failed),
          conflict: safeCounter(load.conflict),
        },
        save: {
          succeeded: safeCounter(save.succeeded),
          failed: safeCounter(save.failed),
        },
        startup: {
          ready: safeCounter(startup.ready),
          recoveryRequired: safeCounter(startup.recoveryRequired),
        },
        startupDuration: {
          "lt-250ms": safeCounter(duration["lt-250ms"]),
          "250-999ms": safeCounter(duration["250-999ms"]),
          "1-2999ms": safeCounter(duration["1-2999ms"]),
          "3-9999ms": safeCounter(duration["3-9999ms"]),
          "gte-10s": safeCounter(duration["gte-10s"]),
        },
      },
    };
  } catch {
    return empty;
  }
};

const cloneSnapshot = (
  snapshot: PersistenceReleaseAMetricsSnapshot,
): PersistenceReleaseAMetricsSnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as PersistenceReleaseAMetricsSnapshot;

const increment = (value: number): number =>
  value >= MAX_COUNTER_VALUE ? MAX_COUNTER_VALUE : value + 1;

const withIncrementedEvent = (
  previous: PersistenceReleaseAMetricsSnapshot,
  event: PersistenceReleaseAMetricEvent,
  now: number,
): PersistenceReleaseAMetricsSnapshot => {
  const next = cloneSnapshot(previous);
  const mutableCounters = next.counters as {
    checkpointAdoption: {
      adopted: number;
      alreadyAbsorbed: number;
      notNeeded: number;
      failed: number;
      conflict: number;
    };
    fallbackRepair: {
      succeeded: number;
      failed: number;
      conflict: number;
    };
    load: {
      succeeded: number;
      missing: number;
      failed: number;
      conflict: number;
    };
    save: { succeeded: number; failed: number };
    startup: { ready: number; recoveryRequired: number };
    startupDuration: Record<PersistenceStartupDurationBucket, number>;
  };

  switch (event.name) {
    case "checkpoint-adoption":
      if (event.outcome === "already-absorbed") {
        mutableCounters.checkpointAdoption.alreadyAbsorbed = increment(
          mutableCounters.checkpointAdoption.alreadyAbsorbed,
        );
      } else if (event.outcome === "not-needed") {
        mutableCounters.checkpointAdoption.notNeeded = increment(
          mutableCounters.checkpointAdoption.notNeeded,
        );
      } else {
        mutableCounters.checkpointAdoption[event.outcome] = increment(
          mutableCounters.checkpointAdoption[event.outcome],
        );
      }
      break;
    case "fallback-repair":
      mutableCounters.fallbackRepair[event.outcome] = increment(
        mutableCounters.fallbackRepair[event.outcome],
      );
      break;
    case "load":
      mutableCounters.load[event.outcome] = increment(
        mutableCounters.load[event.outcome],
      );
      break;
    case "save":
      mutableCounters.save[event.outcome] = increment(
        mutableCounters.save[event.outcome],
      );
      break;
    case "startup": {
      const startupOutcome =
        event.outcome === "recovery-required" ? "recoveryRequired" : "ready";
      mutableCounters.startup[startupOutcome] = increment(
        mutableCounters.startup[startupOutcome],
      );
      mutableCounters.startupDuration[event.durationBucket] = increment(
        mutableCounters.startupDuration[event.durationBucket],
      );
      break;
    }
  }

  return {
    ...next,
    updatedAt: new Date(now).toISOString(),
  };
};

const readStorage = (
  storage: MetricsStorage | null,
  now: number,
): PersistenceReleaseAMetricsSnapshot => {
  if (!storage) return createEmptySnapshot(now);
  try {
    return hydrateSnapshot(
      storage.getItem(PERSISTENCE_RELEASE_A_METRICS_STORAGE_KEY),
      now,
    );
  } catch {
    return createEmptySnapshot(now);
  }
};

const persistSnapshot = (
  storage: MetricsStorage | null,
  snapshot: PersistenceReleaseAMetricsSnapshot,
): void => {
  if (!storage) return;
  try {
    storage.setItem(
      PERSISTENCE_RELEASE_A_METRICS_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    // Metrics are best effort and must not influence persistence behavior.
  }
};

export const createPersistenceReleaseAMetricRecorder = ({
  storage = null,
  sink,
  now = Date.now,
}: PersistenceReleaseAMetricRecorderOptions = {}): PersistenceReleaseAMetricRecorder => {
  let aggregate = readStorage(storage, now());
  const listeners = new Set<PersistenceReleaseAMetricSink>();
  if (sink) listeners.add(sink);

  const notify = (event: PersistenceReleaseAMetricEvent): void => {
    listeners.forEach((listener) => {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // Observability must never alter application persistence behavior.
      }
    });
  };

  return {
    record(event): boolean {
      const sanitized = sanitizeMetricEvent(event);
      if (!sanitized) return false;
      aggregate = withIncrementedEvent(aggregate, sanitized, now());
      persistSnapshot(storage, aggregate);
      notify(sanitized);
      return true;
    },
    snapshot: () => cloneSnapshot(aggregate),
    reset(): PersistenceReleaseAMetricsSnapshot {
      aggregate = createEmptySnapshot(now());
      persistSnapshot(storage, aggregate);
      return cloneSnapshot(aggregate);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const bucketPersistenceStartupDuration = (
  durationMs: number,
): PersistenceStartupDurationBucket => {
  if (!Number.isFinite(durationMs) || durationMs < 250) return "lt-250ms";
  if (durationMs < 1_000) return "250-999ms";
  if (durationMs < 3_000) return "1-2999ms";
  if (durationMs < 10_000) return "3-9999ms";
  return "gte-10s";
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export const calculatePersistenceReleaseARates = (
  snapshot: PersistenceReleaseAMetricsSnapshot,
): PersistenceReleaseARateSummary => {
  const checkpoint = snapshot.counters.checkpointAdoption;
  const checkpointEvaluations =
    checkpoint.adopted +
    checkpoint.alreadyAbsorbed +
    checkpoint.failed +
    checkpoint.conflict;
  const repair = snapshot.counters.fallbackRepair;
  const repairAttempts = repair.succeeded + repair.failed + repair.conflict;
  const load = snapshot.counters.load;
  const loadAttempts =
    load.succeeded + load.missing + load.failed + load.conflict;
  const save = snapshot.counters.save;
  const saveAttempts = save.succeeded + save.failed;
  const startup = snapshot.counters.startup;
  const startupAttempts = startup.ready + startup.recoveryRequired;

  return {
    checkpointAdoptionRate: ratio(
      checkpoint.adopted + checkpoint.alreadyAbsorbed,
      checkpointEvaluations,
    ),
    fallbackRepairSuccessRate: ratio(repair.succeeded, repairAttempts),
    conflictRate: ratio(load.conflict, loadAttempts),
    saveFailureRate: ratio(save.failed, saveAttempts),
    startupRecoveryRequiredRate: ratio(
      startup.recoveryRequired,
      startupAttempts,
    ),
  };
};

const resolveBrowserStorage = (): MetricsStorage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const dispatchBrowserMetric: PersistenceReleaseAMetricSink = (event) => {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(PERSISTENCE_RELEASE_A_METRIC_EVENT, {
      detail: event,
    }),
  );
};

const defaultRecorder = createPersistenceReleaseAMetricRecorder({
  storage: resolveBrowserStorage(),
  sink: dispatchBrowserMetric,
});

export const recordPersistenceReleaseAMetric = (
  event: PersistenceReleaseAMetricEvent,
): boolean => defaultRecorder.record(event);

export const getPersistenceReleaseAMetricsSnapshot =
  (): PersistenceReleaseAMetricsSnapshot => defaultRecorder.snapshot();

export const resetPersistenceReleaseAMetrics =
  (): PersistenceReleaseAMetricsSnapshot => defaultRecorder.reset();

export const subscribePersistenceReleaseAMetrics = (
  sink: PersistenceReleaseAMetricSink,
): (() => void) => defaultRecorder.subscribe(sink);
