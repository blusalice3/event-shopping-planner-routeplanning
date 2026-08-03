import {
  sanitizePersistenceReleaseAMetricEvent,
  subscribePersistenceReleaseAMetrics,
  type PersistenceReleaseAMetricEvent,
  type PersistenceReleaseAMetricSink,
} from "./persistenceReleaseAMetrics";

export const PERSISTENCE_RELEASE_A_METRICS_ENDPOINT =
  "/api/persistence-release-a-metrics";

export type PersistenceReleaseABrowserFamily =
  | "chromium"
  | "firefox"
  | "safari"
  | "other";

export type PersistenceReleaseAAppMode = "browser-tab" | "installed-pwa";

interface PersistenceReleaseAMetricsRequest {
  readonly schemaVersion: 1;
  readonly event: PersistenceReleaseAMetricEvent;
  readonly buildId: string;
  readonly browserFamily: PersistenceReleaseABrowserFamily;
  readonly appMode: PersistenceReleaseAAppMode;
  readonly online: boolean;
}

type MetricsFetch = (
  input: string,
  init: RequestInit,
) => Promise<unknown> | unknown;

export interface PersistenceReleaseAMetricsBackendOptions {
  readonly fetch?: MetricsFetch | null;
  readonly subscribe?: (
    sink: PersistenceReleaseAMetricSink,
  ) => (() => void) | void;
  readonly buildId?: unknown;
  readonly getUserAgent?: () => string;
  readonly getOnline?: () => boolean;
  readonly getAppMode?: () => PersistenceReleaseAAppMode;
}

const normalizeBuildId = (value: unknown): string => {
  if (typeof value !== "string") return "unknown-source";
  if (value === "unknown-source") return value;
  return /^[0-9a-f]{7,64}$/i.test(value)
    ? value.toLowerCase()
    : "unknown-source";
};

export const classifyPersistenceReleaseABrowserFamily = (
  userAgent: string,
): PersistenceReleaseABrowserFamily => {
  if (/(?:firefox|fxios)\//i.test(userAgent)) return "firefox";
  if (/(?:edg|opr|chrome|crios|chromium)\//i.test(userAgent)) {
    return "chromium";
  }
  if (/safari\//i.test(userAgent)) return "safari";
  return "other";
};

const getDefaultUserAgent = (): string => {
  try {
    return typeof navigator === "undefined" ? "" : navigator.userAgent;
  } catch {
    return "";
  }
};

const getDefaultOnline = (): boolean => {
  try {
    return typeof navigator === "undefined" ||
      typeof navigator.onLine !== "boolean"
      ? true
      : navigator.onLine;
  } catch {
    return true;
  }
};

const getDefaultAppMode = (): PersistenceReleaseAAppMode => {
  try {
    const standaloneDisplay =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches;
    const iosStandalone =
      typeof navigator !== "undefined" &&
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return standaloneDisplay || iosStandalone ? "installed-pwa" : "browser-tab";
  } catch {
    return "browser-tab";
  }
};

const getDefaultFetch = (): MetricsFetch | null => {
  try {
    return typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : null;
  } catch {
    return null;
  }
};

const getConfiguredBuildId = (): unknown =>
  import.meta.env.VITE_APP_BUILD_ID as unknown;

const safeEnvironmentValue = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

export const createPersistenceReleaseAMetricsBackendSink = ({
  fetch: configuredFetch,
  buildId = getConfiguredBuildId(),
  getUserAgent = getDefaultUserAgent,
  getOnline = getDefaultOnline,
  getAppMode = getDefaultAppMode,
}: PersistenceReleaseAMetricsBackendOptions = {}): PersistenceReleaseAMetricSink => {
  const fetchMetric =
    configuredFetch === undefined ? getDefaultFetch() : configuredFetch;
  const normalizedBuildId = normalizeBuildId(buildId);

  return (event): void => {
    const strictEvent = sanitizePersistenceReleaseAMetricEvent(event);
    if (strictEvent === null || fetchMetric === null) return;

    const request: PersistenceReleaseAMetricsRequest = {
      schemaVersion: 1,
      event: strictEvent,
      buildId: normalizedBuildId,
      browserFamily: classifyPersistenceReleaseABrowserFamily(
        safeEnvironmentValue(getUserAgent, ""),
      ),
      appMode: safeEnvironmentValue(getAppMode, "browser-tab"),
      online: safeEnvironmentValue(getOnline, true),
    };

    try {
      void Promise.resolve(
        fetchMetric(PERSISTENCE_RELEASE_A_METRICS_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          cache: "no-store",
          credentials: "omit",
          keepalive: true,
          mode: "same-origin",
          referrerPolicy: "no-referrer",
        }),
      ).catch(() => undefined);
    } catch {
      // Production metrics are best effort and never affect persistence.
    }
  };
};

let installedBackend: {
  readonly uninstall: () => void;
} | null = null;

export const installPersistenceReleaseAMetricsBackend = (
  options: PersistenceReleaseAMetricsBackendOptions = {},
): (() => void) => {
  if (installedBackend !== null) return installedBackend.uninstall;

  const sink = createPersistenceReleaseAMetricsBackendSink(options);
  const subscribe = options.subscribe ?? subscribePersistenceReleaseAMetrics;
  let unsubscribe: (() => void) | void;
  try {
    unsubscribe = subscribe(sink);
  } catch {
    return () => undefined;
  }

  let active = true;
  const uninstall = (): void => {
    if (!active) return;
    active = false;
    try {
      unsubscribe?.();
    } catch {
      // Uninstall is also best effort.
    }
    if (installedBackend?.uninstall === uninstall) {
      installedBackend = null;
    }
  };
  installedBackend = { uninstall };
  return uninstall;
};
