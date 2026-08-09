import {
  ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
  ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
  isRoleBlockerSnapshotRequest,
  type RoleBlockerSnapshotResponse,
  type UpdateBlockerSnapshot,
} from "./recovery/updateBlockerBridgeProtocol";

export type UpdateBlocker = {
  id: string;
  label: string;
  isBlocking: () => boolean;
  flush?: () => void | Promise<void>;
};

export type RoleBlockerBridgeWindow = {
  readonly location: { readonly origin: string };
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown, targetOrigin: string): void;
};

type InstalledRoleBridge = {
  kind: "event-shopping-planner-role-blocker-bridge/v1";
  listener: (event: MessageEvent) => void;
};

const ROLE_BRIDGE_INSTALLATION_KEY = Symbol.for(
  "event-shopping-planner.role-blocker-bridge.v1",
);
const blockers = new Map<string, UpdateBlocker>();

const getActiveBlockers = (): UpdateBlocker[] =>
  [...blockers.values()].filter((blocker) => {
    try {
      return blocker.isBlocking();
    } catch {
      return true;
    }
  });

export const registerUpdateBlocker = (blocker: UpdateBlocker): (() => void) => {
  if (
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(blocker.id) ||
    blocker.label.trim().length === 0 ||
    blocker.label.length > 160
  ) {
    throw new TypeError("Update blocker has an invalid ID or label.");
  }
  if (blockers.has(blocker.id)) {
    throw new Error(`Update blocker is already registered: ${blocker.id}`);
  }
  blockers.set(blocker.id, blocker);
  return () => {
    if (blockers.get(blocker.id) === blocker) blockers.delete(blocker.id);
  };
};

export const captureLocalBlockerSnapshot = async (
  clientId: string,
  flush: boolean,
): Promise<UpdateBlockerSnapshot> => {
  let active = getActiveBlockers();
  let flushError = false;
  if (flush) {
    const results = await Promise.allSettled(
      active.map((blocker) => blocker.flush?.()),
    );
    flushError = results.some((result) => result.status === "rejected");
    active = getActiveBlockers();
  }
  return {
    clientId,
    capturedAt: new Date().toISOString(),
    responsive: true,
    blockers: active.map(({ id, label }) => ({ id, label })),
    flushError,
  };
};

const bridgeHostRecord = (
  bridgeWindow: RoleBlockerBridgeWindow,
): Record<PropertyKey, unknown> =>
  bridgeWindow as unknown as Record<PropertyKey, unknown>;

export const installRoleUpdateBlockerBridge = (
  bridgeWindow: RoleBlockerBridgeWindow = window as unknown as RoleBlockerBridgeWindow,
): (() => void) => {
  const host = bridgeHostRecord(bridgeWindow);
  const existing = host[ROLE_BRIDGE_INSTALLATION_KEY];
  if (existing !== undefined) {
    if (
      typeof existing !== "object" ||
      existing === null ||
      (existing as Partial<InstalledRoleBridge>).kind !==
        "event-shopping-planner-role-blocker-bridge/v1" ||
      typeof (existing as Partial<InstalledRoleBridge>).listener !== "function"
    ) {
      throw new Error("Role update blocker bridge ownership is invalid.");
    }
    return () => undefined;
  }

  const seenRequestIds = new Set<string>();
  const requestOrder: string[] = [];
  const listener = (event: MessageEvent): void => {
    if (
      event.source !== (bridgeWindow as unknown as MessageEventSource) ||
      event.origin !== bridgeWindow.location.origin ||
      !isRoleBlockerSnapshotRequest(event.data) ||
      seenRequestIds.has(event.data.requestId)
    ) {
      return;
    }
    const request = event.data;
    seenRequestIds.add(request.requestId);
    requestOrder.push(request.requestId);
    if (requestOrder.length > 256) {
      const expired = requestOrder.shift();
      if (expired) seenRequestIds.delete(expired);
    }

    void captureLocalBlockerSnapshot(request.clientId, request.flush).then(
      (snapshot) => {
        const response: RoleBlockerSnapshotResponse = {
          type: ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
          protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
          requestId: request.requestId,
          snapshot,
        };
        bridgeWindow.postMessage(response, bridgeWindow.location.origin);
      },
    );
  };

  const installation: InstalledRoleBridge = {
    kind: "event-shopping-planner-role-blocker-bridge/v1",
    listener,
  };
  Object.defineProperty(host, ROLE_BRIDGE_INSTALLATION_KEY, {
    configurable: true,
    enumerable: false,
    value: installation,
    writable: false,
  });
  bridgeWindow.addEventListener("message", listener);

  return () => {
    if (host[ROLE_BRIDGE_INSTALLATION_KEY] !== installation) return;
    bridgeWindow.removeEventListener("message", listener);
    Reflect.deleteProperty(host, ROLE_BRIDGE_INSTALLATION_KEY);
  };
};

export const resetUpdateBlockerRegistryForTests = (
  bridgeWindow?: RoleBlockerBridgeWindow,
): void => {
  blockers.clear();
  const target =
    bridgeWindow ??
    (typeof window === "undefined"
      ? undefined
      : (window as unknown as RoleBlockerBridgeWindow));
  if (!target) return;
  const host = bridgeHostRecord(target);
  const installation = host[ROLE_BRIDGE_INSTALLATION_KEY] as
    | InstalledRoleBridge
    | undefined;
  if (
    installation?.kind === "event-shopping-planner-role-blocker-bridge/v1" &&
    typeof installation.listener === "function"
  ) {
    target.removeEventListener("message", installation.listener);
    Reflect.deleteProperty(host, ROLE_BRIDGE_INSTALLATION_KEY);
  }
};

export type { UpdateBlockerSnapshot } from "./recovery/updateBlockerBridgeProtocol";
