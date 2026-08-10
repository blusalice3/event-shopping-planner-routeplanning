import {
  ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
  ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
  ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
  cloneUpdateBlockerSnapshot,
  isBridgeRequestId,
  isClientId,
  isRecord,
  isRoleBlockerSnapshotResponse,
  isUpdateBlockerSnapshot,
  type RoleBlockerSnapshotRequest,
  type UpdateBlockerSnapshot,
} from "./updateBlockerBridgeProtocol";

export type WorkerBlockerSnapshotResponse = {
  type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE";
  protocolVersion: 1;
  requestId: string;
  snapshots: UpdateBlockerSnapshot[];
};

type ClientSnapshotRequest = {
  type: "PWA_BLOCKER_SNAPSHOT_REQUEST";
  protocolVersion: 1;
  requestId: string;
  clientId: string;
  flush: boolean;
};

type ClientSnapshotResponse = {
  type: "PWA_BLOCKER_SNAPSHOT_RESPONSE";
  protocolVersion: 1;
  requestId: string;
  snapshot: UpdateBlockerSnapshot;
};

type WorkerMessageTarget = {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
};

type MessagePortLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
  start?: () => void;
  close?: () => void;
};

type MessageChannelLike = {
  port1: MessagePortLike;
  port2: unknown;
};

export type OuterBlockerBridgeWindow = {
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

type ServiceWorkerMessageTarget = {
  readonly scriptURL: string;
  postMessage(message: unknown): void;
};

type ServiceWorkerContainerTarget = {
  addEventListener(
    type: "message",
    listener: EventListenerOrEventListenerObject,
  ): void;
};

export const DEFAULT_ROLE_BLOCKER_BRIDGE_TIMEOUT_MS = 600;

const isWorkerRequestId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isClientSnapshotRequest = (
  value: unknown,
): value is ClientSnapshotRequest =>
  isRecord(value) &&
  hasExactKeys(value, [
    "clientId",
    "flush",
    "protocolVersion",
    "requestId",
    "type",
  ]) &&
  value.type === "PWA_BLOCKER_SNAPSHOT_REQUEST" &&
  value.protocolVersion === 1 &&
  isWorkerRequestId(value.requestId) &&
  isClientId(value.clientId) &&
  typeof value.flush === "boolean";

const isWorkerBlockerSnapshotResponse = (
  value: unknown,
  expectedRequestId: string,
): value is WorkerBlockerSnapshotResponse => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "requestId",
      "snapshots",
      "type",
    ]) ||
    value.type !== "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE" ||
    value.protocolVersion !== 1 ||
    value.requestId !== expectedRequestId ||
    !Array.isArray(value.snapshots) ||
    !value.snapshots.every(isUpdateBlockerSnapshot)
  ) {
    return false;
  }
  return (
    new Set(value.snapshots.map(({ clientId }) => clientId)).size ===
    value.snapshots.length
  );
};

const sourceHasExpectedOrigin = (
  source: unknown,
  expectedOrigin: string,
): source is ServiceWorkerMessageTarget => {
  if (
    !isRecord(source) ||
    typeof source.scriptURL !== "string" ||
    typeof source.postMessage !== "function"
  ) {
    return false;
  }
  try {
    return new URL(source.scriptURL).origin === expectedOrigin;
  } catch {
    return false;
  }
};

export const requestRoleBlockerSnapshot = (
  clientId: string,
  flush: boolean,
  options: {
    bridgeWindow?: OuterBlockerBridgeWindow;
    timeoutMs?: number;
    requestIdFactory?: () => string;
  } = {},
): Promise<UpdateBlockerSnapshot> => {
  const bridgeWindow =
    options.bridgeWindow ?? (window as unknown as OuterBlockerBridgeWindow);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_BLOCKER_BRIDGE_TIMEOUT_MS;
  const requestId = (options.requestIdFactory ?? (() => crypto.randomUUID()))();
  if (!isClientId(clientId)) {
    return Promise.reject(
      new Error("Role blocker bridge client ID is invalid."),
    );
  }
  if (!isBridgeRequestId(requestId)) {
    return Promise.reject(
      new Error("Role blocker bridge request ID is invalid."),
    );
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs >= 1_000
  ) {
    return Promise.reject(
      new Error("Role blocker bridge timeout must be between 1 and 999 ms."),
    );
  }

  const request: RoleBlockerSnapshotRequest = {
    type: ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
    protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
    requestId,
    clientId,
    flush,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let received = false;
    let pendingSnapshot: UpdateBlockerSnapshot | null = null;
    let duplicateObservationTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (duplicateObservationTimer !== null) {
        clearTimeout(duplicateObservationTimer);
      }
      bridgeWindow.removeEventListener("message", onMessage);
      callback();
    };
    const onMessage = (event: MessageEvent): void => {
      if (
        event.source !== (bridgeWindow as unknown as MessageEventSource) ||
        event.origin !== bridgeWindow.location.origin ||
        !isRecord(event.data) ||
        event.data.type !== ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE ||
        event.data.requestId !== requestId
      ) {
        return;
      }
      if (
        !isRoleBlockerSnapshotResponse(event.data) ||
        event.data.snapshot.clientId !== clientId
      ) {
        finish(() =>
          reject(new Error("Role blocker bridge response is invalid.")),
        );
        return;
      }
      if (received) {
        finish(() =>
          reject(
            new Error("Role blocker bridge returned duplicate responses."),
          ),
        );
        return;
      }
      received = true;
      pendingSnapshot = cloneUpdateBlockerSnapshot(event.data.snapshot);
      duplicateObservationTimer = setTimeout(() => {
        const snapshot = pendingSnapshot;
        if (!snapshot) {
          finish(() =>
            reject(new Error("Role blocker bridge lost its response.")),
          );
          return;
        }
        finish(() => resolve(snapshot));
      }, 0);
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(`Role blocker bridge timed out after ${timeoutMs} ms.`),
          ),
        ),
      timeoutMs,
    );
    bridgeWindow.addEventListener("message", onMessage);
    try {
      bridgeWindow.postMessage(request, bridgeWindow.location.origin);
    } catch (error) {
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error("Role blocker bridge request could not be sent."),
        ),
      );
    }
  });
};

let installedResponderTargets = new WeakSet<object>();

export const installUpdateBlockerResponder = (
  serviceWorkerContainer: ServiceWorkerContainerTarget = navigator.serviceWorker as unknown as ServiceWorkerContainerTarget,
  options: {
    bridgeWindow?: OuterBlockerBridgeWindow;
    bridgeTimeoutMs?: number;
    requestIdFactory?: () => string;
    getExpectedWorker?: () => unknown;
  } = {},
): void => {
  if (installedResponderTargets.has(serviceWorkerContainer)) return;
  installedResponderTargets.add(serviceWorkerContainer);
  const bridgeWindow =
    options.bridgeWindow ?? (window as unknown as OuterBlockerBridgeWindow);
  const expectedOrigin = bridgeWindow.location.origin;

  serviceWorkerContainer.addEventListener("message", ((event: MessageEvent) => {
    if (
      event.origin !== expectedOrigin ||
      !isClientSnapshotRequest(event.data) ||
      !sourceHasExpectedOrigin(event.source, expectedOrigin) ||
      (options.getExpectedWorker !== undefined &&
        options.getExpectedWorker() !== event.source)
    ) {
      return;
    }
    const request = event.data;
    const source = event.source;
    void requestRoleBlockerSnapshot(request.clientId, request.flush, {
      bridgeWindow,
      timeoutMs: options.bridgeTimeoutMs,
      requestIdFactory: options.requestIdFactory,
    }).then(
      (snapshot) => {
        const response: ClientSnapshotResponse = {
          type: "PWA_BLOCKER_SNAPSHOT_RESPONSE",
          protocolVersion: 1,
          requestId: request.requestId,
          snapshot,
        };
        source.postMessage(response);
      },
      () => {
        const response: ClientSnapshotResponse = {
          type: "PWA_BLOCKER_SNAPSHOT_RESPONSE",
          protocolVersion: 1,
          requestId: request.requestId,
          snapshot: {
            clientId: request.clientId,
            capturedAt: new Date().toISOString(),
            responsive: false,
            blockers: [],
            flushError: request.flush,
          },
        };
        source.postMessage(response);
      },
    );
  }) as EventListener);
};

export const requestAllClientBlockerSnapshots = (
  worker: WorkerMessageTarget,
  flush: boolean,
  options: {
    timeoutMs?: number;
    requestIdFactory?: () => string;
    channelFactory?: () => MessageChannelLike;
  } = {},
): Promise<UpdateBlockerSnapshot[]> => {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const requestId = (options.requestIdFactory ?? (() => crypto.randomUUID()))();
  const channel = (
    options.channelFactory ??
    (() => new MessageChannel() as unknown as MessageChannelLike)
  )();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close?.();
      callback();
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Client blocker snapshot timed out after ${timeoutMs} ms.`,
            ),
          ),
        ),
      timeoutMs,
    );
    channel.port1.onmessageerror = () =>
      finish(() => reject(new Error("Client blocker channel failed.")));
    channel.port1.onmessage = ({ data }: { data: unknown }) => {
      if (!isWorkerBlockerSnapshotResponse(data, requestId)) {
        finish(() => reject(new Error("Invalid client blocker response.")));
        return;
      }
      finish(() => resolve(data.snapshots.map(cloneUpdateBlockerSnapshot)));
    };
    channel.port1.start?.();
    worker.postMessage(
      {
        type: "PWA_GET_ALL_BLOCKER_SNAPSHOTS",
        protocolVersion: 1,
        requestId,
        flush,
      },
      [channel.port2],
    );
  });
};

export const resetUpdateBlockerRegistryForTests = (): void => {
  installedResponderTargets = new WeakSet<object>();
};

export type { UpdateBlockerSnapshot } from "./updateBlockerBridgeProtocol";
