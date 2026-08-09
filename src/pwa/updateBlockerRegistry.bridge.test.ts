import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureLocalBlockerSnapshot,
  installRoleUpdateBlockerBridge,
  registerUpdateBlocker,
  resetUpdateBlockerRegistryForTests,
  type RoleBlockerBridgeWindow,
} from "./updateBlockerRegistry";
import {
  requestRoleBlockerSnapshot,
  type OuterBlockerBridgeWindow,
} from "./recovery/updateBlockerRegistry";
import {
  ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
  ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
  ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
} from "./recovery/updateBlockerBridgeProtocol";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

class FakeBridgeWindow
  implements RoleBlockerBridgeWindow, OuterBlockerBridgeWindow
{
  readonly location = { origin: "https://planner.test" };
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly messages: unknown[] = [];
  addCount = 0;
  removeCount = 0;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  postMessage(message: unknown, _targetOrigin: string): void {
    this.messages.push(message);
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

const bridges: FakeBridgeWindow[] = [];
const createBridge = (): FakeBridgeWindow => {
  const bridge = new FakeBridgeWindow();
  bridges.push(bridge);
  return bridge;
};

afterEach(() => {
  bridges.forEach((bridge) => resetUpdateBlockerRegistryForTests(bridge));
  bridges.length = 0;
  resetUpdateBlockerRegistryForTests();
});

describe("role-owned update blocker message bridge", () => {
  it("exposes the real role registry and flushes it through an isolated outer requester", async () => {
    const bridge = createBridge();
    installRoleUpdateBlockerBridge(bridge);
    let blocking = true;
    const flush = vi.fn(async () => {
      blocking = false;
    });
    registerUpdateBlocker({
      id: "event-autosave",
      label: "イベントを保存中",
      isBlocking: () => blocking,
      flush,
    });

    await expect(
      requestRoleBlockerSnapshot("browser-client", false, {
        bridgeWindow: bridge,
        timeoutMs: 100,
        requestIdFactory: () => REQUEST_ID,
      }),
    ).resolves.toMatchObject({
      clientId: "browser-client",
      responsive: true,
      blockers: [{ id: "event-autosave", label: "イベントを保存中" }],
      flushError: false,
    });
    expect(flush).not.toHaveBeenCalled();

    await expect(
      requestRoleBlockerSnapshot("browser-client", true, {
        bridgeWindow: bridge,
        timeoutMs: 100,
        requestIdFactory: () => "33333333-3333-4333-8333-333333333333",
      }),
    ).resolves.toMatchObject({ blockers: [], flushError: false });
    expect(flush).toHaveBeenCalledOnce();
    await expect(
      captureLocalBlockerSnapshot("browser-client", false),
    ).resolves.toMatchObject({ blockers: [] });
  });

  it("installs one listener and handles a duplicate request ID only once", async () => {
    const bridge = createBridge();
    const dispose = installRoleUpdateBlockerBridge(bridge);
    const disposeDuplicate = installRoleUpdateBlockerBridge(bridge);
    expect(bridge.addCount).toBe(1);
    disposeDuplicate();
    expect(bridge.removeCount).toBe(0);

    let blocking = true;
    const flush = vi.fn(async () => {
      blocking = false;
    });
    registerUpdateBlocker({
      id: "event-autosave",
      label: "イベントを保存中",
      isBlocking: () => blocking,
      flush,
    });
    const request = {
      type: ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
      protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
      requestId: REQUEST_ID,
      clientId: "client-a",
      flush: true,
    };
    bridge.dispatch(request);
    bridge.dispatch(request);

    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        bridge.messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { type?: unknown }).type ===
              ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
        ),
      ).toHaveLength(1),
    );
    dispose();
    expect(bridge.listeners).toHaveLength(0);
  });

  it("ignores cross-origin, foreign-source, and non-exact requests", async () => {
    const bridge = createBridge();
    installRoleUpdateBlockerBridge(bridge);
    const request = {
      type: ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
      protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
      requestId: REQUEST_ID,
      clientId: "client-a",
      flush: false,
    };
    bridge.dispatch(request, { origin: "https://attacker.test" });
    bridge.dispatch(request, { source: {} });
    bridge.dispatch({ ...request, extra: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      bridge.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type ===
            ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
      ),
    ).toHaveLength(0);
  });

  it("returns a fail-closed blocker after a role flush rejects", async () => {
    const bridge = createBridge();
    installRoleUpdateBlockerBridge(bridge);
    registerUpdateBlocker({
      id: "event-autosave",
      label: "イベントを保存中",
      isBlocking: () => true,
      flush: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });

    await expect(
      requestRoleBlockerSnapshot("client-a", true, {
        bridgeWindow: bridge,
        timeoutMs: 100,
        requestIdFactory: () => REQUEST_ID,
      }),
    ).resolves.toMatchObject({
      blockers: [{ id: "event-autosave", label: "イベントを保存中" }],
      flushError: true,
    });
  });

  it("lets the containment role answer cleanly with an empty registry", async () => {
    const bridge = createBridge();
    installRoleUpdateBlockerBridge(bridge);

    await expect(
      requestRoleBlockerSnapshot("containment-client", true, {
        bridgeWindow: bridge,
        timeoutMs: 100,
        requestIdFactory: () => REQUEST_ID,
      }),
    ).resolves.toMatchObject({
      clientId: "containment-client",
      responsive: true,
      blockers: [],
      flushError: false,
    });
  });

  it("rejects a poisoned duplicate-listener ownership marker", () => {
    const bridge = createBridge();
    Object.defineProperty(
      bridge,
      Symbol.for("event-shopping-planner.role-blocker-bridge.v1"),
      { configurable: true, value: { kind: "attacker" } },
    );
    expect(() => installRoleUpdateBlockerBridge(bridge)).toThrow(
      /ownership is invalid/,
    );
  });
});
