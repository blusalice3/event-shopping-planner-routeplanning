import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installUpdateBlockerResponder,
  requestAllClientBlockerSnapshots,
  requestRoleBlockerSnapshot,
  resetUpdateBlockerRegistryForTests,
  type OuterBlockerBridgeWindow,
  type UpdateBlockerSnapshot,
} from "./updateBlockerRegistry";
import {
  ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
  ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
  ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
} from "./updateBlockerBridgeProtocol";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const snapshot = (
  overrides: Partial<UpdateBlockerSnapshot> = {},
): UpdateBlockerSnapshot => ({
  clientId: "client-a",
  capturedAt: "2026-08-10T00:00:00.000Z",
  responsive: true,
  blockers: [{ id: "event-autosave", label: "イベントを保存中" }],
  flushError: false,
  ...overrides,
});

class FakeBridgeWindow implements OuterBlockerBridgeWindow {
  readonly location = { origin: "https://planner.test" };
  readonly listeners = new Set<(event: MessageEvent) => void>();
  onPostMessage: ((message: unknown, targetOrigin: string) => void) | null =
    null;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }

  postMessage(message: unknown, targetOrigin: string): void {
    this.onPostMessage?.(message, targetOrigin);
    queueMicrotask(() => this.dispatch(message));
  }

  dispatch(
    data: unknown,
    options: { origin?: string; source?: unknown } = {},
  ): void {
    const event = {
      data,
      origin: options.origin ?? this.location.origin,
      source: options.source ?? this,
    } as unknown as MessageEvent;
    [...this.listeners].forEach((listener) => listener(event));
  }
}

const installExactRoleResponse = (
  bridge: FakeBridgeWindow,
  value: UpdateBlockerSnapshot = snapshot(),
): void => {
  bridge.onPostMessage = (message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !==
        ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE
    ) {
      return;
    }
    const request = message as { requestId: string };
    queueMicrotask(() =>
      bridge.dispatch({
        type: ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
        protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        snapshot: value,
      }),
    );
  };
};

afterEach(() => {
  resetUpdateBlockerRegistryForTests();
  vi.useRealTimers();
});

describe("outer update blocker role bridge", () => {
  it("accepts one exact same-window same-origin response and clones it", async () => {
    const bridge = new FakeBridgeWindow();
    const sourceSnapshot = snapshot();
    installExactRoleResponse(bridge, sourceSnapshot);

    const result = await requestRoleBlockerSnapshot("client-a", false, {
      bridgeWindow: bridge,
      timeoutMs: 100,
      requestIdFactory: () => REQUEST_ID,
    });

    expect(result).toEqual(sourceSnapshot);
    expect(result).not.toBe(sourceSnapshot);
    expect(result.blockers[0]).not.toBe(sourceSnapshot.blockers[0]);
    expect(bridge.listeners).toHaveLength(0);
  });

  it("ignores foreign source/origin and rejects a malformed correlated response", async () => {
    const bridge = new FakeBridgeWindow();
    bridge.onPostMessage = (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !==
          ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE
      ) {
        return;
      }
      const requestId = (message as { requestId: string }).requestId;
      queueMicrotask(() => {
        const response = {
          type: ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
          protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
          requestId,
          snapshot: snapshot(),
        };
        bridge.dispatch(response, { origin: "https://attacker.test" });
        bridge.dispatch(response, { source: {} });
        bridge.dispatch({ ...response, extra: true });
      });
    };

    await expect(
      requestRoleBlockerSnapshot("client-a", false, {
        bridgeWindow: bridge,
        timeoutMs: 100,
        requestIdFactory: () => REQUEST_ID,
      }),
    ).rejects.toThrow(/response is invalid/);
  });

  it("rejects duplicate responses and times out when the role is absent", async () => {
    const duplicateBridge = new FakeBridgeWindow();
    duplicateBridge.onPostMessage = (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !==
          ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE
      ) {
        return;
      }
      const response = {
        type: ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
        protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
        requestId: (message as { requestId: string }).requestId,
        snapshot: snapshot(),
      };
      queueMicrotask(() => {
        duplicateBridge.dispatch(response);
        duplicateBridge.dispatch(response);
      });
    };

    await expect(
      requestRoleBlockerSnapshot("client-a", true, {
        bridgeWindow: duplicateBridge,
        timeoutMs: 100,
        requestIdFactory: () => REQUEST_ID,
      }),
    ).rejects.toThrow(/duplicate responses/);

    const absentBridge = new FakeBridgeWindow();
    await expect(
      requestRoleBlockerSnapshot("client-a", true, {
        bridgeWindow: absentBridge,
        timeoutMs: 1,
        requestIdFactory: () => REQUEST_ID,
      }),
    ).rejects.toThrow(/timed out after 1 ms/);
    expect(absentBridge.listeners).toHaveLength(0);
  });

  it.each([0, 1_000, 1.5])(
    "rejects an unsafe bridge timeout %s",
    async (timeoutMs) => {
      await expect(
        requestRoleBlockerSnapshot("client-a", false, {
          bridgeWindow: new FakeBridgeWindow(),
          timeoutMs,
          requestIdFactory: () => REQUEST_ID,
        }),
      ).rejects.toThrow(/timeout must be between 1 and 999 ms/);
    },
  );
});

describe("outer Service Worker blocker responder", () => {
  it("bridges only an exact request from the current same-origin waiting worker", async () => {
    const bridge = new FakeBridgeWindow();
    installExactRoleResponse(bridge, snapshot({ blockers: [] }));
    let listener: ((event: MessageEvent) => void) | undefined;
    const addEventListener = vi.fn(
      (_type: string, next: EventListenerOrEventListenerObject) => {
        listener = next as (event: MessageEvent) => void;
      },
    );
    const container = { addEventListener };
    const waitingWorker = {
      scriptURL: "https://planner.test/sw.js",
      postMessage: vi.fn(),
    };
    installUpdateBlockerResponder(container, {
      bridgeWindow: bridge,
      bridgeTimeoutMs: 100,
      requestIdFactory: () => REQUEST_ID,
      getExpectedWorker: () => waitingWorker,
    });
    installUpdateBlockerResponder(container, {
      bridgeWindow: bridge,
      getExpectedWorker: () => waitingWorker,
    });
    expect(addEventListener).toHaveBeenCalledOnce();

    const request = {
      type: "PWA_BLOCKER_SNAPSHOT_REQUEST",
      protocolVersion: 1,
      requestId: "worker-request-1",
      clientId: "client-a",
      flush: true,
    };
    listener?.({
      data: { ...request, extra: true },
      origin: bridge.location.origin,
      source: waitingWorker,
    } as unknown as MessageEvent);
    listener?.({
      data: request,
      origin: "https://attacker.test",
      source: waitingWorker,
    } as unknown as MessageEvent);
    listener?.({
      data: request,
      origin: bridge.location.origin,
      source: {
        scriptURL: "https://planner.test/sw.js",
        postMessage: vi.fn(),
      },
    } as unknown as MessageEvent);
    expect(waitingWorker.postMessage).not.toHaveBeenCalled();

    listener?.({
      data: request,
      origin: bridge.location.origin,
      source: waitingWorker,
    } as unknown as MessageEvent);

    await vi.waitFor(() =>
      expect(waitingWorker.postMessage).toHaveBeenCalled(),
    );
    expect(waitingWorker.postMessage).toHaveBeenCalledWith({
      type: "PWA_BLOCKER_SNAPSHOT_RESPONSE",
      protocolVersion: 1,
      requestId: request.requestId,
      snapshot: expect.objectContaining({
        clientId: "client-a",
        responsive: true,
        blockers: [],
        flushError: false,
      }),
    });
  });

  it("returns an explicit fail-closed snapshot when the role bridge times out", async () => {
    const bridge = new FakeBridgeWindow();
    let listener: ((event: MessageEvent) => void) | undefined;
    const container = {
      addEventListener(
        _type: string,
        next: EventListenerOrEventListenerObject,
      ) {
        listener = next as (event: MessageEvent) => void;
      },
    };
    const waitingWorker = {
      scriptURL: "https://planner.test/sw.js",
      postMessage: vi.fn(),
    };
    installUpdateBlockerResponder(container, {
      bridgeWindow: bridge,
      bridgeTimeoutMs: 1,
      requestIdFactory: () => REQUEST_ID,
      getExpectedWorker: () => waitingWorker,
    });

    listener?.({
      data: {
        type: "PWA_BLOCKER_SNAPSHOT_REQUEST",
        protocolVersion: 1,
        requestId: "worker-request-2",
        clientId: "client-a",
        flush: true,
      },
      origin: bridge.location.origin,
      source: waitingWorker,
    } as unknown as MessageEvent);

    await vi.waitFor(() =>
      expect(waitingWorker.postMessage).toHaveBeenCalled(),
    );
    expect(waitingWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "worker-request-2",
        snapshot: expect.objectContaining({
          clientId: "client-a",
          responsive: false,
          blockers: [],
          flushError: true,
        }),
      }),
    );
  });
});

describe("all-client blocker snapshot channel", () => {
  const makeChannel = () => {
    const port1 = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null as (() => void) | null,
      start: vi.fn(),
      close: vi.fn(),
    };
    return { port1, port2: {} };
  };

  it("resolves a deeply cloned, strictly validated response", async () => {
    const sourceSnapshot = snapshot();
    const channel = makeChannel();
    const worker = {
      postMessage: vi.fn(() => {
        channel.port1.onmessage?.({
          data: {
            type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE",
            protocolVersion: 1,
            requestId: "request-1",
            snapshots: [sourceSnapshot],
          },
        });
      }),
    };

    const snapshots = await requestAllClientBlockerSnapshots(worker, true, {
      timeoutMs: 100,
      requestIdFactory: () => "request-1",
      channelFactory: () => channel,
    });

    expect(snapshots).toEqual([sourceSnapshot]);
    expect(snapshots[0]).not.toBe(sourceSnapshot);
    expect(snapshots[0].blockers[0]).not.toBe(sourceSnapshot.blockers[0]);
    expect(channel.port1.start).toHaveBeenCalledOnce();
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-1", flush: true }),
      [channel.port2],
    );
  });

  it.each([
    ["wrong envelope", { type: "wrong" }],
    [
      "malformed nested snapshot",
      {
        type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE",
        protocolVersion: 1,
        requestId: "request-2",
        snapshots: [{ ...snapshot(), blockers: null }],
      },
    ],
    [
      "duplicate client IDs",
      {
        type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE",
        protocolVersion: 1,
        requestId: "request-2",
        snapshots: [snapshot(), snapshot()],
      },
    ],
  ])("rejects %s without hanging", async (_label, data) => {
    const channel = makeChannel();
    const worker = {
      postMessage: vi.fn(() => channel.port1.onmessage?.({ data })),
    };
    await expect(
      requestAllClientBlockerSnapshots(worker, false, {
        timeoutMs: 100,
        requestIdFactory: () => "request-2",
        channelFactory: () => channel,
      }),
    ).rejects.toThrow(/Invalid client blocker response/);
  });

  it("rejects channel failures and timeout", async () => {
    const errorChannel = makeChannel();
    const errorWorker = {
      postMessage: vi.fn(() => errorChannel.port1.onmessageerror?.()),
    };
    await expect(
      requestAllClientBlockerSnapshots(errorWorker, false, {
        timeoutMs: 100,
        requestIdFactory: () => "request-3",
        channelFactory: () => errorChannel,
      }),
    ).rejects.toThrow(/channel failed/);

    await expect(
      requestAllClientBlockerSnapshots({ postMessage: vi.fn() }, false, {
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out after 1 ms/);
  });
});
