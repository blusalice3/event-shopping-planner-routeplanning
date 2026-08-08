import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureLocalBlockerSnapshot,
  installUpdateBlockerResponder,
  registerUpdateBlocker,
  requestAllClientBlockerSnapshots,
  resetUpdateBlockerRegistryForTests,
} from "./updateBlockerRegistry";

afterEach(() => {
  resetUpdateBlockerRegistryForTests();
});

describe("outer recovery update blocker registry", () => {
  it("registers, filters, flushes, and unregisters blockers", async () => {
    const flush = vi.fn(async () => undefined);
    const unregister = registerUpdateBlocker({
      id: "pending-save",
      label: "保存中",
      isBlocking: () => true,
      flush,
    });
    registerUpdateBlocker({
      id: "idle-view",
      label: "待機中",
      isBlocking: () => false,
    });

    await expect(
      captureLocalBlockerSnapshot("client-a", true),
    ).resolves.toMatchObject({
      clientId: "client-a",
      responsive: true,
      blockers: [{ id: "pending-save", label: "保存中" }],
      flushError: false,
    });
    expect(flush).toHaveBeenCalledOnce();

    unregister();
    unregister();
    await expect(
      captureLocalBlockerSnapshot("client-a", false),
    ).resolves.toMatchObject({ blockers: [], flushError: false });
  });

  it("fails closed for inspection and flush failures", async () => {
    registerUpdateBlocker({
      id: "unknown-save",
      label: "保存状態不明",
      isBlocking: () => {
        throw new Error("inspection failed");
      },
      flush: async () => {
        throw new Error("flush failed");
      },
    });

    await expect(
      captureLocalBlockerSnapshot("client-b", true),
    ).resolves.toMatchObject({
      blockers: [{ id: "unknown-save", label: "保存状態不明" }],
      flushError: true,
    });
  });

  it.each([
    [" invalid", "保存中"],
    ["", "保存中"],
    ["save", " "],
    ["save", "x".repeat(161)],
  ])("rejects invalid blocker identity %j", (id, label) => {
    expect(() =>
      registerUpdateBlocker({
        id,
        label,
        isBlocking: () => true,
      }),
    ).toThrow(/invalid ID or label/);
  });

  it("rejects duplicate blocker IDs", () => {
    const blocker = {
      id: "save",
      label: "保存中",
      isBlocking: () => true,
    };
    registerUpdateBlocker(blocker);
    expect(() => registerUpdateBlocker(blocker)).toThrow(/already registered/);
  });

  it("ignores invalid messages and replies through source or controller", async () => {
    let listener: ((event: MessageEvent) => void) | undefined;
    const sourcePostMessage = vi.fn();
    const controllerPostMessage = vi.fn();
    const addEventListener = vi.fn(
      (_type: string, nextListener: EventListenerOrEventListenerObject) => {
        listener = nextListener as (event: MessageEvent) => void;
      },
    );
    const container = {
      controller: { postMessage: controllerPostMessage },
      addEventListener,
    } as unknown as ServiceWorkerContainer;
    installUpdateBlockerResponder(container);
    installUpdateBlockerResponder(container);
    expect(addEventListener).toHaveBeenCalledOnce();

    listener?.({ data: null } as MessageEvent);
    listener?.({
      data: {
        type: "PWA_BLOCKER_SNAPSHOT_REQUEST",
        protocolVersion: 2,
        requestId: "wrong",
        clientId: "client-a",
        flush: true,
      },
    } as MessageEvent);
    expect(sourcePostMessage).not.toHaveBeenCalled();

    const request = {
      type: "PWA_BLOCKER_SNAPSHOT_REQUEST",
      protocolVersion: 1,
      requestId: "request-1",
      clientId: "client-a",
      flush: false,
    };
    listener?.({
      data: request,
      source: { postMessage: sourcePostMessage },
    } as unknown as MessageEvent);
    await vi.waitFor(() => expect(sourcePostMessage).toHaveBeenCalledOnce());

    listener?.({
      data: { ...request, requestId: "request-2" },
      source: null,
    } as unknown as MessageEvent);
    await vi.waitFor(() =>
      expect(controllerPostMessage).toHaveBeenCalledOnce(),
    );
  });

  it("resolves a cloned all-client snapshot response", async () => {
    const sourceSnapshot = {
      clientId: "client-a",
      capturedAt: "2026-08-06T00:00:00.000Z",
      responsive: true,
      blockers: [{ id: "save", label: "保存中" }],
      flushError: false,
    };
    const port1 = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null as (() => void) | null,
      start: vi.fn(),
      close: vi.fn(),
    };
    const port2 = {};
    const worker = {
      postMessage: vi.fn(() => {
        port1.onmessage?.({
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
      channelFactory: () => ({ port1, port2 }),
    });

    expect(snapshots).toEqual([sourceSnapshot]);
    expect(snapshots[0]).not.toBe(sourceSnapshot);
    expect(snapshots[0].blockers[0]).not.toBe(sourceSnapshot.blockers[0]);
    expect(port1.start).toHaveBeenCalledOnce();
    expect(port1.close).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-1", flush: true }),
      [port2],
    );
  });

  it("rejects invalid responses and channel failures", async () => {
    const makeChannel = () => {
      const port1 = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        onmessageerror: null as (() => void) | null,
        close: vi.fn(),
      };
      return { port1, port2: {} };
    };
    const invalidChannel = makeChannel();
    const invalidWorker = {
      postMessage: vi.fn(() => {
        invalidChannel.port1.onmessage?.({ data: { type: "wrong" } });
      }),
    };
    await expect(
      requestAllClientBlockerSnapshots(invalidWorker, false, {
        timeoutMs: 100,
        requestIdFactory: () => "request-2",
        channelFactory: () => invalidChannel,
      }),
    ).rejects.toThrow(/Invalid client blocker response/);

    const errorChannel = makeChannel();
    const errorWorker = {
      postMessage: vi.fn(() => {
        errorChannel.port1.onmessageerror?.();
      }),
    };
    await expect(
      requestAllClientBlockerSnapshots(errorWorker, false, {
        timeoutMs: 100,
        requestIdFactory: () => "request-3",
        channelFactory: () => errorChannel,
      }),
    ).rejects.toThrow(/channel failed/);
  });

  it("times out a worker that never responds using default channel authority", async () => {
    await expect(
      requestAllClientBlockerSnapshots({ postMessage: vi.fn() }, false, {
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out after 1 ms/);
  });
});
