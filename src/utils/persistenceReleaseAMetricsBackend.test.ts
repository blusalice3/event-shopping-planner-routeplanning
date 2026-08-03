import { describe, expect, it, vi } from "vitest";
import type { PersistenceReleaseAMetricEvent } from "./persistenceReleaseAMetrics";
import {
  PERSISTENCE_RELEASE_A_METRICS_ENDPOINT,
  classifyPersistenceReleaseABrowserFamily,
  createPersistenceReleaseAMetricsBackendSink,
  installPersistenceReleaseAMetricsBackend,
} from "./persistenceReleaseAMetricsBackend";

describe("Release A production metrics backend", () => {
  it("posts only the strict event and the approved coarse context", () => {
    const fetchMetric = vi.fn<
      (input: string, init: RequestInit) => Promise<void>
    >(async () => undefined);
    let online = false;
    const sink = createPersistenceReleaseAMetricsBackendSink({
      fetch: fetchMetric,
      buildId: "A234567",
      getUserAgent: () =>
        "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36 private-data",
      getAppMode: () => "installed-pwa",
      getOnline: () => online,
    });
    const unsafeEvent = {
      version: 1,
      name: "startup",
      outcome: "recovery-required",
      durationBucket: "3-9999ms",
      payload: { title: "利用者データ" },
      error: "raw error",
      revision: 42,
      digest: "private-digest",
      key: "eventLists",
      arbitrary: "must-not-leave-the-browser",
    } as unknown as PersistenceReleaseAMetricEvent;

    sink(unsafeEvent);

    expect(fetchMetric).toHaveBeenCalledTimes(1);
    expect(fetchMetric).toHaveBeenCalledWith(
      PERSISTENCE_RELEASE_A_METRICS_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
        mode: "same-origin",
        referrerPolicy: "no-referrer",
      }),
    );
    const requestInit = fetchMetric.mock.calls[0]?.[1];
    const transmitted = JSON.parse(String(requestInit?.body));
    expect(transmitted).toEqual({
      schemaVersion: 1,
      event: {
        version: 1,
        name: "startup",
        outcome: "recovery-required",
        durationBucket: "3-9999ms",
      },
      buildId: "a234567",
      browserFamily: "chromium",
      appMode: "installed-pwa",
      online: false,
    });
    expect(JSON.stringify(transmitted)).not.toMatch(
      /利用者データ|raw error|revision|digest|eventLists|arbitrary/,
    );

    online = true;
    sink({ version: 1, name: "save", outcome: "succeeded" });
    expect(
      JSON.parse(String(fetchMetric.mock.calls[1]?.[1]?.body)).online,
    ).toBe(true);
  });

  it("drops invalid events and normalizes an untrusted build ID", () => {
    const fetchMetric = vi.fn<
      (input: string, init: RequestInit) => Promise<void>
    >(async () => undefined);
    const sink = createPersistenceReleaseAMetricsBackendSink({
      fetch: fetchMetric,
      buildId: "customer@example.com",
    });

    sink({
      version: 1,
      name: "save",
      outcome: "unsupported",
    } as unknown as PersistenceReleaseAMetricEvent);
    expect(fetchMetric).not.toHaveBeenCalled();

    sink({ version: 1, name: "save", outcome: "failed" });
    expect(
      JSON.parse(String(fetchMetric.mock.calls[0]?.[1]?.body)).buildId,
    ).toBe("unknown-source");
  });

  it("forwards a closed cleanup outcome without key or payload details", () => {
    const fetchMetric = vi.fn<
      (input: string, init: RequestInit) => Promise<void>
    >(async () => undefined);
    const sink = createPersistenceReleaseAMetricsBackendSink({
      fetch: fetchMetric,
      buildId: "a234567",
    });

    sink({
      version: 1,
      name: "cleanup",
      outcome: "key-confirmed-removed",
      mode: "manual",
      key: "eventMetadata",
      payload: "利用者データ",
    } as unknown as PersistenceReleaseAMetricEvent);

    expect(
      JSON.parse(String(fetchMetric.mock.calls[0]?.[1]?.body)).event,
    ).toEqual({
      version: 1,
      name: "cleanup",
      outcome: "key-confirmed-removed",
      mode: "manual",
    });
  });

  it("contains synchronous and asynchronous transport failures", async () => {
    const syncFailure = createPersistenceReleaseAMetricsBackendSink({
      fetch: () => {
        throw new Error("network unavailable");
      },
    });
    const asyncFailure = createPersistenceReleaseAMetricsBackendSink({
      fetch: async () => {
        throw new Error("backend unavailable");
      },
    });

    expect(() =>
      syncFailure({ version: 1, name: "load", outcome: "failed" }),
    ).not.toThrow();
    expect(() =>
      asyncFailure({ version: 1, name: "load", outcome: "failed" }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it.each([
    ["Mozilla/5.0 Edg/126.0 Chrome/126.0", "chromium"],
    ["Mozilla/5.0 CriOS/126.0 Mobile Safari/604.1", "chromium"],
    ["Mozilla/5.0 Firefox/128.0", "firefox"],
    ["Mozilla/5.0 FxiOS/128.0 Mobile Safari/605.1", "firefox"],
    ["Mozilla/5.0 Version/17.5 Safari/605.1", "safari"],
    ["custom-agent", "other"],
  ] as const)("coarsens %s to %s", (userAgent, expected) => {
    expect(classifyPersistenceReleaseABrowserFamily(userAgent)).toBe(expected);
  });

  it("installs one subscription and can be safely reinstalled", () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const fetchMetric = vi.fn<
      (input: string, init: RequestInit) => Promise<void>
    >(async () => undefined);
    const first = installPersistenceReleaseAMetricsBackend({
      subscribe,
      fetch: fetchMetric,
    });
    const second = installPersistenceReleaseAMetricsBackend({
      subscribe,
      fetch: fetchMetric,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    first();
    second();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const third = installPersistenceReleaseAMetricsBackend({
      subscribe,
      fetch: fetchMetric,
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
    third();
  });
});
