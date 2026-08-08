export type UpdateBlocker = {
  id: string;
  label: string;
  isBlocking: () => boolean;
  flush?: () => void | Promise<void>;
};

export type UpdateBlockerSnapshot = {
  clientId: string;
  capturedAt: string;
  responsive: boolean;
  blockers: Array<{ id: string; label: string }>;
  flushError: boolean;
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

export type WorkerBlockerSnapshotResponse = {
  type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE";
  protocolVersion: 1;
  requestId: string;
  snapshots: UpdateBlockerSnapshot[];
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

const blockers = new Map<string, UpdateBlocker>();
let responderInstalled = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

export const installUpdateBlockerResponder = (
  serviceWorkerContainer: Pick<
    ServiceWorkerContainer,
    "addEventListener" | "controller"
  > = navigator.serviceWorker,
): void => {
  if (responderInstalled) return;
  responderInstalled = true;
  serviceWorkerContainer.addEventListener("message", ((event: MessageEvent) => {
    const value = event.data;
    if (
      !isRecord(value) ||
      value.type !== "PWA_BLOCKER_SNAPSHOT_REQUEST" ||
      value.protocolVersion !== 1 ||
      typeof value.requestId !== "string" ||
      typeof value.clientId !== "string" ||
      typeof value.flush !== "boolean"
    ) {
      return;
    }
    const request = value as ClientSnapshotRequest;
    void captureLocalBlockerSnapshot(request.clientId, request.flush).then(
      (snapshot) => {
        const response: ClientSnapshotResponse = {
          type: "PWA_BLOCKER_SNAPSHOT_RESPONSE",
          protocolVersion: 1,
          requestId: request.requestId,
          snapshot,
        };
        const source = event.source;
        if (
          source &&
          "postMessage" in source &&
          typeof source.postMessage === "function"
        ) {
          source.postMessage(response);
        } else {
          serviceWorkerContainer.controller?.postMessage(response);
        }
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
      if (
        !isRecord(data) ||
        data.type !== "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE" ||
        data.protocolVersion !== 1 ||
        data.requestId !== requestId ||
        !Array.isArray(data.snapshots)
      ) {
        finish(() => reject(new Error("Invalid client blocker response.")));
        return;
      }
      finish(() =>
        resolve(
          (data as WorkerBlockerSnapshotResponse).snapshots.map((snapshot) => ({
            ...snapshot,
            blockers: snapshot.blockers.map((blocker) => ({ ...blocker })),
          })),
        ),
      );
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
  blockers.clear();
  responderInstalled = false;
};
