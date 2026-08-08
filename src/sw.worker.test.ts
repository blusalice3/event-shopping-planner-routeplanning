import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateBlockerSnapshot } from "./pwa/recovery/updateBlockerRegistry";

type TestClient = {
  id: string;
  postMessage: ReturnType<typeof vi.fn>;
};

type WorkerMessageEvent = Event & {
  data: unknown;
  ports: Array<{ postMessage(message: unknown): void }>;
  source: TestClient | null;
  waitUntil(promise: Promise<unknown>): void;
};

type WorkerFetchEvent = Event & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

type WorkerExtendableEvent = Event & {
  waitUntil(promise: Promise<unknown>): void;
};

const createClient = (id: string): TestClient => ({
  id,
  postMessage: vi.fn(),
});

const createSnapshot = (
  clientId: string,
  blockers: UpdateBlockerSnapshot["blockers"] = [],
): UpdateBlockerSnapshot => ({
  clientId,
  capturedAt: "2026-08-08T00:00:00.000Z",
  responsive: true,
  blockers,
  flushError: false,
});

const bootWorkerListeners = async (
  clients: TestClient[],
): Promise<Map<string, EventListener>> => {
  vi.resetModules();
  const listeners = new Map<string, EventListener>();
  vi.stubGlobal("self", {
    __WB_MANIFEST: [
      "/index.html",
      `/release-identity.${"1".repeat(40)}.${"2".repeat(64)}.json`,
    ],
  });
  vi.stubGlobal("location", {
    href: "https://planner.test/sw.js",
    origin: "https://planner.test",
  });
  vi.stubGlobal("clients", {
    matchAll: vi.fn(async () => clients),
  });
  vi.stubGlobal(
    "addEventListener",
    vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
  );

  await import("./sw");
  return listeners;
};

const bootWorker = async (clients: TestClient[]): Promise<EventListener> => {
  const listeners = await bootWorkerListeners(clients);
  const listener = listeners.get("message");
  if (!listener) throw new Error("Service Worker message listener is missing.");
  return listener;
};

const dispatchMessage = (
  listener: EventListener,
  data: unknown,
  options: {
    source?: TestClient | null;
    portPostMessage?: (message: unknown) => void;
  } = {},
): Promise<unknown> => {
  let task: Promise<unknown> | undefined;
  const event = {
    data,
    ports: options.portPostMessage
      ? [{ postMessage: options.portPostMessage }]
      : [],
    source: options.source ?? null,
    waitUntil(promise: Promise<unknown>) {
      task = promise;
    },
  } as unknown as WorkerMessageEvent;
  listener(event);
  if (!task)
    throw new Error("Service Worker did not extend the message event.");
  return task;
};

const aggregateRequest = (requestId: string, flush = true) => ({
  type: "PWA_GET_ALL_BLOCKER_SNAPSHOTS",
  protocolVersion: 1,
  requestId,
  flush,
});

const clientResponse = (
  requestId: string,
  snapshot: UpdateBlockerSnapshot,
) => ({
  type: "PWA_BLOCKER_SNAPSHOT_RESPONSE",
  protocolVersion: 1,
  requestId,
  snapshot,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Service Worker blocker snapshot aggregation", () => {
  it("aggregates snapshots from every matched client", async () => {
    const clients = [
      createClient("client-a"),
      createClient("client-b"),
      createClient("client-c"),
    ];
    const listener = await bootWorker(clients);
    const postResponse = vi.fn();
    const requestId = "aggregate-all";

    const aggregateTask = dispatchMessage(
      listener,
      aggregateRequest(requestId),
      { portPostMessage: postResponse },
    );
    await vi.waitFor(() => {
      for (const client of clients) {
        expect(client.postMessage).toHaveBeenCalledWith({
          type: "PWA_BLOCKER_SNAPSHOT_REQUEST",
          protocolVersion: 1,
          requestId,
          clientId: client.id,
          flush: true,
        });
      }
    });

    const snapshots = [
      createSnapshot("client-a", [{ id: "save", label: "保存中" }]),
      createSnapshot("client-b"),
      createSnapshot("client-c", [{ id: "export", label: "出力中" }]),
    ];
    await Promise.all(
      snapshots.map((snapshot, index) =>
        dispatchMessage(listener, clientResponse(requestId, snapshot), {
          source: clients[index],
        }),
      ),
    );
    await aggregateTask;

    expect(postResponse).toHaveBeenCalledOnce();
    expect(postResponse).toHaveBeenCalledWith({
      type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE",
      protocolVersion: 1,
      requestId,
      snapshots,
    });
  });

  it("reports silent and already-closed clients as unresponsive", async () => {
    vi.useFakeTimers();
    const responsive = createClient("client-responsive");
    const silent = createClient("client-silent");
    const closed = createClient("client-closed");
    closed.postMessage.mockImplementation(() => {
      throw new Error("Client is already closed.");
    });
    const listener = await bootWorker([responsive, silent, closed]);
    const postResponse = vi.fn();
    const requestId = "aggregate-fail-closed";

    const aggregateTask = dispatchMessage(
      listener,
      aggregateRequest(requestId),
      { portPostMessage: postResponse },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(responsive.postMessage).toHaveBeenCalledOnce();
    expect(silent.postMessage).toHaveBeenCalledOnce();
    expect(closed.postMessage).toHaveBeenCalledOnce();

    const responsiveSnapshot = createSnapshot("client-responsive");
    await dispatchMessage(
      listener,
      clientResponse(requestId, responsiveSnapshot),
      { source: responsive },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await aggregateTask;

    expect(postResponse).toHaveBeenCalledOnce();
    const response = postResponse.mock.calls[0]?.[0] as {
      snapshots: UpdateBlockerSnapshot[];
    };
    expect(response.snapshots).toEqual([
      responsiveSnapshot,
      expect.objectContaining({
        clientId: "client-silent",
        responsive: false,
        blockers: [],
        flushError: false,
      }),
      expect.objectContaining({
        clientId: "client-closed",
        responsive: false,
        blockers: [],
        flushError: false,
      }),
    ]);

    const lateSnapshot = createSnapshot("client-silent", [
      { id: "late-save", label: "遅延保存" },
    ]);
    await dispatchMessage(listener, clientResponse(requestId, lateSnapshot), {
      source: silent,
    });
    expect(postResponse).toHaveBeenCalledOnce();

    const nextPostResponse = vi.fn();
    const nextRequestId = "aggregate-after-late-response";
    const nextTask = dispatchMessage(
      listener,
      aggregateRequest(nextRequestId, false),
      { portPostMessage: nextPostResponse },
    );
    await Promise.resolve();
    await Promise.resolve();
    const nextResponsiveSnapshot = createSnapshot("client-responsive");
    await dispatchMessage(
      listener,
      clientResponse(nextRequestId, nextResponsiveSnapshot),
      { source: responsive },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await nextTask;

    const nextResponse = nextPostResponse.mock.calls[0]?.[0] as {
      snapshots: UpdateBlockerSnapshot[];
    };
    expect(nextResponse.snapshots).toEqual([
      nextResponsiveSnapshot,
      expect.objectContaining({
        clientId: "client-silent",
        responsive: false,
        blockers: [],
      }),
      expect.objectContaining({
        clientId: "client-closed",
        responsive: false,
        blockers: [],
      }),
    ]);
    expect(nextResponse.snapshots).not.toContainEqual(lateSnapshot);
  });
});

describe("Service Worker offline precache fetch", () => {
  it("serves same-origin module requests despite an Origin Vary mismatch", async () => {
    const cachedResponse = new Response("export const cached = true;", {
      headers: {
        "Content-Type": "text/javascript",
        Vary: "Origin",
      },
    });
    const match = vi.fn(
      async (
        _request: Request,
        options?: CacheQueryOptions,
      ): Promise<Response | undefined> =>
        options?.ignoreVary ? cachedResponse : undefined,
    );
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({ match })),
    });
    const networkFetch = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", networkFetch);
    const listeners = await bootWorkerListeners([]);
    const fetchListener = listeners.get("fetch");
    if (!fetchListener) {
      throw new Error("Service Worker fetch listener is missing.");
    }
    const request = new Request(
      "https://planner.test/assets/outer-recovery-agent.js",
      {
        headers: { Origin: "https://planner.test" },
      },
    );
    let responseTask: Promise<Response> | undefined;
    const event = {
      request,
      respondWith(response: Promise<Response> | Response) {
        responseTask = Promise.resolve(response);
      },
    } as unknown as WorkerFetchEvent;

    fetchListener(event);

    await expect(responseTask).resolves.toBe(cachedResponse);
    expect(match).toHaveBeenCalledWith(request, {
      ignoreSearch: false,
      ignoreVary: true,
    });
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("Service Worker cache activation", () => {
  it("deletes only stale owned precaches and preserves the current and foreign caches", async () => {
    const currentCache = `event-shopping-planner-precache-${"1".repeat(40)}-${"2".repeat(64)}`;
    const staleOwnedCache =
      "event-shopping-planner-precache-stale-source-stale-variant";
    const foreignCache = "another-application-precache-v1";
    const similarlyNamedForeignCache = "event-shopping-planner-runtime-v1";
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => [
        staleOwnedCache,
        currentCache,
        foreignCache,
        similarlyNamedForeignCache,
      ]),
      delete: deleteCache,
    });
    const listeners = await bootWorkerListeners([]);
    const activateListener = listeners.get("activate");
    if (!activateListener) {
      throw new Error("Service Worker activate listener is missing.");
    }
    let activationTask: Promise<unknown> | undefined;
    const event = {
      waitUntil(promise: Promise<unknown>) {
        activationTask = promise;
      },
    } as unknown as WorkerExtendableEvent;

    activateListener(event);

    await expect(activationTask).resolves.toBeUndefined();
    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith(staleOwnedCache);
    expect(deleteCache).not.toHaveBeenCalledWith(currentCache);
    expect(deleteCache).not.toHaveBeenCalledWith(foreignCache);
    expect(deleteCache).not.toHaveBeenCalledWith(similarlyNamedForeignCache);
  });
});
