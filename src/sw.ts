import {
  RELEASE_IDENTITY_PROTOCOL_VERSION,
  RELEASE_IDENTITY_RESPONSE_TYPE,
  createReleaseIdentityErrorResponse,
  isGetReleaseIdentityRequest,
  type GetReleaseIdentityRequest,
  type ReleaseIdentityResponse,
} from "./pwa/releaseIdentityProtocol";
import type {
  UpdateBlockerSnapshot,
  WorkerBlockerSnapshotResponse,
} from "./pwa/recovery/updateBlockerRegistry";

type PrecacheEntry = string | { url: string; revision?: string | null };

type ExtendableEventLike = Event & {
  waitUntil(promise: Promise<unknown>): void;
};

type FetchEventLike = Event & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

type MessageSourceLike = {
  id?: string;
  postMessage(message: unknown): void;
};

type MessageEventLike = Event & {
  data: unknown;
  ports: Array<{ postMessage(message: unknown): void }>;
  source: MessageSourceLike | null;
};

type ClientLike = {
  id: string;
  postMessage(message: unknown): void;
};

type WorkerGlobalLike = {
  location: {
    href: string;
    origin: string;
  };
  clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<ClientLike[]>;
  };
  addEventListener(
    type: "install" | "activate" | "fetch" | "message",
    listener: EventListener,
  ): void;
};

const workerGlobal = globalThis as unknown as WorkerGlobalLike;
// `self.__WB_MANIFEST` is the exact injectManifest replacement point.
const precacheEntries =
  (self as unknown as { __WB_MANIFEST?: PrecacheEntry[] }).__WB_MANIFEST ?? [];
const precacheUrls = precacheEntries.map((entry) =>
  typeof entry === "string" ? entry : entry.url,
);
const versionedIdentityUrl =
  precacheUrls.find((url) =>
    /(?:^|\/)release-identity\.[0-9a-f]{40}\.[0-9a-f]{64}\.json$/i.test(url),
  ) ?? null;
const cacheDiscriminator =
  versionedIdentityUrl
    ?.match(/release-identity\.([0-9a-f]{40})\.([0-9a-f]{64})\.json$/i)
    ?.slice(1)
    .join("-") ?? "unbound";
const CACHE_PREFIX = "event-shopping-planner-precache-";
const CACHE_NAME = `${CACHE_PREFIX}${cacheDiscriminator}`;

const absoluteUrl = (value: string): string =>
  new URL(value, workerGlobal.location.origin).href;

const validatePrecacheContract = (): void => {
  if (!versionedIdentityUrl) {
    throw new Error(
      "A source/variant-addressed release identity must be precached.",
    );
  }
  const stableIdentityUrl = new URL(
    "/release-identity.json",
    workerGlobal.location.origin,
  ).href;
  const seen = new Set<string>();
  for (const value of precacheUrls) {
    const url = new URL(value, workerGlobal.location.origin);
    if (url.origin !== workerGlobal.location.origin) {
      throw new Error("Precache contains a cross-origin resource.");
    }
    if (url.href === stableIdentityUrl) {
      throw new Error("Stable release identity must not be precached.");
    }
    if (seen.has(url.href)) {
      throw new Error("Precache contains a duplicate URL.");
    }
    seen.add(url.href);
  }
};

const install = async (): Promise<void> => {
  validatePrecacheContract();
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(precacheUrls.map(absoluteUrl));
};

const activate = async (): Promise<void> => {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  );
  // Deliberately leave control takeover to natural browser activation.
};

const handleFetch = async (request: Request): Promise<Response> => {
  const requestUrl = new URL(request.url);
  if (
    request.method !== "GET" ||
    requestUrl.origin !== workerGlobal.location.origin
  ) {
    return fetch(request);
  }
  const cache = await caches.open(CACHE_NAME);
  // Static preview/CDN responses can vary on Origin while module and
  // crossorigin stylesheet requests add that header only at runtime. The
  // cache itself is same-origin and source/variant-addressed, so the response
  // bytes are already bound more strictly than Vary can express here.
  const cached = await cache.match(request, {
    ignoreSearch: false,
    ignoreVary: true,
  });
  if (cached) return cached;

  if (request.mode === "navigate") {
    try {
      return await fetch(request);
    } catch {
      const fallback = await cache.match(absoluteUrl("/index.html"));
      if (fallback) return fallback;
      throw new Error("Offline navigation fallback is unavailable.");
    }
  }
  return fetch(request);
};

const identityResponse = async (
  request: GetReleaseIdentityRequest,
): Promise<ReleaseIdentityResponse> => {
  if (!versionedIdentityUrl) {
    return createReleaseIdentityErrorResponse(
      request.requestId,
      request.expectedWorkerState,
      "IDENTITY_NOT_PRECACHED",
    );
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(absoluteUrl(versionedIdentityUrl));
    if (!response) {
      return createReleaseIdentityErrorResponse(
        request.requestId,
        request.expectedWorkerState,
        "IDENTITY_NOT_PRECACHED",
      );
    }
    return {
      type: RELEASE_IDENTITY_RESPONSE_TYPE,
      protocolVersion: RELEASE_IDENTITY_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      workerState: request.expectedWorkerState,
      scriptUrl: workerGlobal.location.href,
      versionedIdentityUrl: new URL(
        versionedIdentityUrl,
        workerGlobal.location.origin,
      ).pathname,
      canonicalIdentityBytes: await response.text(),
    };
  } catch {
    return createReleaseIdentityErrorResponse(
      request.requestId,
      request.expectedWorkerState,
      "IDENTITY_READ_FAILED",
    );
  }
};

type PendingBlockerCollection = {
  expectedClientIds: Set<string>;
  snapshots: Map<string, UpdateBlockerSnapshot>;
  resolve: (snapshots: UpdateBlockerSnapshot[]) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingBlockerCollections = new Map<string, PendingBlockerCollection>();

const collectBlockerSnapshots = async (
  requestId: string,
  flush: boolean,
  timeoutMs = 1_000,
): Promise<UpdateBlockerSnapshot[]> => {
  const clients = await workerGlobal.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  if (clients.length === 0) return [];

  return new Promise((resolve) => {
    const expectedClientIds = new Set(clients.map(({ id }) => id));
    const snapshots = new Map<string, UpdateBlockerSnapshot>();
    const finish = (): void => {
      const collection = pendingBlockerCollections.get(requestId);
      if (!collection) return;
      clearTimeout(collection.timeout);
      pendingBlockerCollections.delete(requestId);
      resolve(
        clients.map(
          ({ id }) =>
            snapshots.get(id) ?? {
              clientId: id,
              capturedAt: new Date().toISOString(),
              responsive: false,
              blockers: [],
              flushError: false,
            },
        ),
      );
    };
    const timeout = setTimeout(finish, timeoutMs);
    pendingBlockerCollections.set(requestId, {
      expectedClientIds,
      snapshots,
      resolve,
      timeout,
    });
    clients.forEach((client) => {
      try {
        client.postMessage({
          type: "PWA_BLOCKER_SNAPSHOT_REQUEST",
          protocolVersion: 1,
          requestId,
          clientId: client.id,
          flush,
        });
      } catch {
        // A client can close after matchAll(). Keep collecting the remaining
        // clients and report this one as unresponsive when the timeout fires.
      }
    });
  });
};

const handleMessage = async (event: MessageEventLike): Promise<void> => {
  if (isGetReleaseIdentityRequest(event.data)) {
    event.ports[0]?.postMessage(await identityResponse(event.data));
    return;
  }
  const value = event.data;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;

  if (
    record.type === "PWA_GET_ALL_BLOCKER_SNAPSHOTS" &&
    record.protocolVersion === 1 &&
    typeof record.requestId === "string" &&
    typeof record.flush === "boolean"
  ) {
    const snapshots = await collectBlockerSnapshots(
      record.requestId,
      record.flush,
    );
    const response: WorkerBlockerSnapshotResponse = {
      type: "PWA_ALL_BLOCKER_SNAPSHOTS_RESPONSE",
      protocolVersion: 1,
      requestId: record.requestId,
      snapshots,
    };
    event.ports[0]?.postMessage(response);
    return;
  }

  if (
    record.type === "PWA_BLOCKER_SNAPSHOT_RESPONSE" &&
    record.protocolVersion === 1 &&
    typeof record.requestId === "string" &&
    typeof record.snapshot === "object" &&
    record.snapshot !== null &&
    event.source?.id
  ) {
    const collection = pendingBlockerCollections.get(record.requestId);
    if (!collection || !collection.expectedClientIds.has(event.source.id)) {
      return;
    }
    const snapshot = record.snapshot as UpdateBlockerSnapshot;
    if (snapshot.clientId !== event.source.id) return;
    collection.snapshots.set(event.source.id, snapshot);
    if (collection.snapshots.size === collection.expectedClientIds.size) {
      clearTimeout(collection.timeout);
      pendingBlockerCollections.delete(record.requestId);
      collection.resolve([...collection.snapshots.values()]);
    }
  }
};

workerGlobal.addEventListener("install", ((event: ExtendableEventLike) => {
  event.waitUntil(install());
}) as EventListener);
workerGlobal.addEventListener("activate", ((event: ExtendableEventLike) => {
  event.waitUntil(activate());
}) as EventListener);
workerGlobal.addEventListener("fetch", ((event: FetchEventLike) => {
  event.respondWith(handleFetch(event.request));
}) as EventListener);
workerGlobal.addEventListener("message", ((event: MessageEventLike) => {
  const task = handleMessage(event);
  const extendable = event as MessageEventLike & {
    waitUntil?: (promise: Promise<unknown>) => void;
  };
  extendable.waitUntil?.(task);
}) as EventListener);
