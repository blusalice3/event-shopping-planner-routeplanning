import {
  parseCanonicalReleaseIdentity,
  queryReleaseIdentity,
  type PromptCloseAllReleaseIdentity,
  type ReleaseIdentity,
  type VerifiedWorkerIdentity,
} from "../releaseIdentityProtocol";
import {
  installUpdateBlockerResponder,
  requestAllClientBlockerSnapshots,
  type UpdateBlockerSnapshot,
} from "./updateBlockerRegistry";
import { renderRecoveryRoot, renderWaitingUpdateNotice } from "./recoveryRoot";

const OUTER_AGENT_HOST_ID = "pwa-outer-agent-host";

type WaitingWorkerOwnership = Readonly<{
  generation: number;
  worker: ServiceWorker;
}>;

const ensureOuterAgentHost = (applicationRoot: HTMLElement): HTMLElement => {
  const ownerDocument = applicationRoot.ownerDocument;
  const existing = ownerDocument.getElementById(OUTER_AGENT_HOST_ID);
  if (
    existing instanceof HTMLElement &&
    existing !== applicationRoot &&
    !applicationRoot.contains(existing)
  ) {
    return existing;
  }
  if (existing && existing !== applicationRoot) existing.remove();

  const host = ownerDocument.createElement("div");
  host.id = OUTER_AGENT_HOST_ID;
  host.dataset.pwaOuterAgentHost = "true";
  if (applicationRoot.parentNode) {
    applicationRoot.parentNode.insertBefore(host, applicationRoot);
  } else {
    ownerDocument.body.appendChild(host);
  }
  return host;
};

const cleanupOuterAgentHost = (host: HTMLElement): void => {
  if (!host.hasChildNodes()) host.remove();
};

export type RuntimeBuildMeta = {
  sourceSha: string;
  buildId: string;
  variantId: string;
  releaseRole: "standard" | "containment";
  outerAgentUrl: string;
};

export type OuterRecoveryAgentResult =
  | {
      status: "role-started";
      identity: PromptCloseAllReleaseIdentity;
      source: "controller" | "network-first-install";
    }
  | { status: "recovery"; reasonCode: string }
  | { status: "unsupported"; reasonCode: string };

type RegistrationLike = {
  installing: ServiceWorker | null;
  waiting: ServiceWorker | null;
  update(): Promise<unknown>;
  addEventListener(
    type: "updatefound",
    listener: EventListenerOrEventListenerObject,
  ): void;
};

type ServiceWorkerContainerLike = {
  controller: ServiceWorker | null;
  getRegistration(scope?: string): Promise<RegistrationLike | undefined>;
  addEventListener: ServiceWorkerContainer["addEventListener"];
};

export type OuterRecoveryAgentDependencies = {
  root: HTMLElement;
  document: Document;
  location: Location;
  serviceWorker?: ServiceWorkerContainerLike;
  fetch: typeof fetch;
  currentOuterAgentUrl: string;
  loadRoleEntry: (identity: PromptCloseAllReleaseIdentity) => Promise<void>;
  queryIdentity: typeof queryReleaseIdentity;
  requestBlockerSnapshots: typeof requestAllClientBlockerSnapshots;
};

const getMeta = (document: Document, name: string): string | null =>
  document
    .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    ?.content.trim() ?? null;

export const readRuntimeBuildMeta = (
  document: Document,
  currentOuterAgentUrl: string,
): RuntimeBuildMeta | null => {
  const buildId = getMeta(document, "event-shopping-planner-build-id");
  const sourceSha =
    getMeta(document, "event-shopping-planner-source-sha") ?? buildId;
  const variantId = getMeta(document, "event-shopping-planner-variant-id");
  const releaseRole = getMeta(document, "event-shopping-planner-release-role");
  const declaredOuterAgentUrl =
    getMeta(document, "event-shopping-planner-outer-agent-url") ??
    new URL(currentOuterAgentUrl, document.baseURI).pathname;
  if (
    !sourceSha ||
    !buildId ||
    !variantId ||
    (releaseRole !== "standard" && releaseRole !== "containment")
  ) {
    return null;
  }
  return {
    sourceSha,
    buildId,
    variantId,
    releaseRole,
    outerAgentUrl: declaredOuterAgentUrl,
  };
};

const normalizeLocalPath = (value: string, origin: string): string | null => {
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
};

export const getVersionedIdentityPath = (identity: ReleaseIdentity): string =>
  `/release-identity.${identity.sourceSha}.${identity.variantId}.json`;

export const identityMatchesRuntime = (
  identity: ReleaseIdentity,
  meta: RuntimeBuildMeta,
  currentOuterAgentUrl: string,
  origin: string,
): identity is PromptCloseAllReleaseIdentity => {
  if (identity.pwaLifecycle !== "prompt-close-all-v1") return false;
  const actualOuterPath = normalizeLocalPath(currentOuterAgentUrl, origin);
  return (
    identity.sourceSha === meta.sourceSha &&
    identity.buildId === meta.buildId &&
    identity.variantId === meta.variantId &&
    identity.releaseRole === meta.releaseRole &&
    normalizeLocalPath(identity.outerAgentUrl, origin) ===
      normalizeLocalPath(meta.outerAgentUrl, origin) &&
    normalizeLocalPath(identity.outerAgentUrl, origin) === actualOuterPath &&
    normalizeLocalPath(identity.roleEntryUrl, origin) !== null &&
    normalizeLocalPath(identity.serviceWorkerUrl, origin) !== null
  );
};

export const appendRoleEntryModule = (
  document: Document,
  identity: PromptCloseAllReleaseIdentity,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = identity.roleEntryUrl;
    script.dataset.releaseRole = identity.releaseRole;
    script.dataset.variantId = identity.variantId;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Verified role entry could not be loaded.")),
      { once: true },
    );
    document.head.appendChild(script);
  });

const fetchCanonicalIdentity = async (
  fetcher: typeof fetch,
  url: string,
): Promise<{ bytes: string; identity: ReleaseIdentity }> => {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Release identity request returned ${response.status}.`);
  }
  const bytes = await response.text();
  return { bytes, identity: parseCanonicalReleaseIdentity(bytes) };
};

const verifyWorkerEnvelope = (
  workerIdentity: VerifiedWorkerIdentity,
  origin: string,
): boolean => {
  const identity = workerIdentity.identity;
  if (identity.pwaLifecycle !== "prompt-close-all-v1") return false;
  return (
    normalizeLocalPath(workerIdentity.scriptUrl, origin) ===
      normalizeLocalPath(identity.serviceWorkerUrl, origin) &&
    normalizeLocalPath(workerIdentity.versionedIdentityUrl, origin) ===
      getVersionedIdentityPath(identity)
  );
};

const defaultDependencies = (): OuterRecoveryAgentDependencies => ({
  root:
    document.getElementById("root") ??
    (() => {
      const root = document.createElement("div");
      root.id = "root";
      document.body.appendChild(root);
      return root;
    })(),
  document,
  location,
  serviceWorker: navigator.serviceWorker,
  fetch,
  currentOuterAgentUrl: import.meta.url,
  loadRoleEntry: (identity) => appendRoleEntryModule(document, identity),
  queryIdentity: queryReleaseIdentity,
  requestBlockerSnapshots: requestAllClientBlockerSnapshots,
});

export const startOuterRecoveryAgent = async (
  dependencyOverrides: Partial<OuterRecoveryAgentDependencies> = {},
): Promise<OuterRecoveryAgentResult> => {
  const dependencies = {
    ...defaultDependencies(),
    ...dependencyOverrides,
  };
  const { root, serviceWorker } = dependencies;
  const meta = readRuntimeBuildMeta(
    dependencies.document,
    dependencies.currentOuterAgentUrl,
  );
  if (!meta) {
    renderRecoveryRoot(root, "html-meta-invalid");
    return { status: "recovery", reasonCode: "html-meta-invalid" };
  }
  if (!serviceWorker) {
    renderRecoveryRoot(root, "service-worker-unsupported");
    return {
      status: "unsupported",
      reasonCode: "service-worker-unsupported",
    };
  }

  let registration: RegistrationLike | undefined;
  try {
    registration = await serviceWorker.getRegistration("/");
  } catch {
    renderRecoveryRoot(root, "registration-read-failed");
    return { status: "recovery", reasonCode: "registration-read-failed" };
  }

  if (registration) {
    installUpdateBlockerResponder(
      serviceWorker as unknown as ServiceWorkerContainer,
      { getExpectedWorker: () => registration?.waiting ?? null },
    );
  }

  const origin = dependencies.location.origin;
  let currentIdentity: PromptCloseAllReleaseIdentity;
  let source: "controller" | "network-first-install";

  if (serviceWorker.controller) {
    try {
      const workerIdentity = await dependencies.queryIdentity(
        serviceWorker.controller,
        "active",
      );
      if (
        !verifyWorkerEnvelope(workerIdentity, origin) ||
        !identityMatchesRuntime(
          workerIdentity.identity,
          meta,
          dependencies.currentOuterAgentUrl,
          origin,
        )
      ) {
        throw new Error("Active worker identity does not match runtime.");
      }
      currentIdentity = workerIdentity.identity;
      source = "controller";
    } catch {
      renderRecoveryRoot(root, "active-worker-identity-mismatch", {
        onCheckForUpdate: async () => {
          await registration?.update();
        },
      });
      return {
        status: "recovery",
        reasonCode: "active-worker-identity-mismatch",
      };
    }
  } else {
    try {
      const stable = await fetchCanonicalIdentity(
        dependencies.fetch,
        "/release-identity.json",
      );
      const versioned = await fetchCanonicalIdentity(
        dependencies.fetch,
        getVersionedIdentityPath(stable.identity),
      );
      if (stable.bytes !== versioned.bytes) {
        throw new Error("Stable and versioned release identity bytes differ.");
      }
      if (
        !identityMatchesRuntime(
          versioned.identity,
          meta,
          dependencies.currentOuterAgentUrl,
          origin,
        )
      ) {
        throw new Error("Network identity does not match runtime.");
      }
      currentIdentity = versioned.identity;
      source = "network-first-install";
    } catch {
      renderRecoveryRoot(root, "first-install-identity-unavailable", {
        onCheckForUpdate: async () => {
          await registration?.update();
        },
      });
      return {
        status: "recovery",
        reasonCode: "first-install-identity-unavailable",
      };
    }
  }

  try {
    await dependencies.loadRoleEntry(currentIdentity);
  } catch {
    renderRecoveryRoot(root, "role-entry-load-failed", {
      onCheckForUpdate: async () => {
        await registration?.update();
      },
    });
    return { status: "recovery", reasonCode: "role-entry-load-failed" };
  }

  if (registration) {
    const attemptedWaitingWorkers = new WeakSet<ServiceWorker>();
    const observedInstallingWorkers = new WeakSet<ServiceWorker>();
    let latestInstallingWorker: ServiceWorker | null = null;
    let waitingGeneration = 0;
    let activeWaitingOwnership: WaitingWorkerOwnership | null = null;
    let updateNoticeHost: HTMLElement | null = null;
    let renderedNotice: {
      ownership: WaitingWorkerOwnership;
      element: HTMLElement;
    } | null = null;

    const removeOwnedNotice = (ownership: WaitingWorkerOwnership): void => {
      if (renderedNotice?.ownership !== ownership) return;
      renderedNotice.element.remove();
      renderedNotice = null;
      if (updateNoticeHost) {
        cleanupOuterAgentHost(updateNoticeHost);
        if (!updateNoticeHost.isConnected) updateNoticeHost = null;
      }
    };

    const claimWaitingWorker = (
      worker: ServiceWorker,
    ): WaitingWorkerOwnership => {
      const previousOwnership = activeWaitingOwnership;
      const ownership = Object.freeze({
        generation: (waitingGeneration += 1),
        worker,
      });
      activeWaitingOwnership = ownership;
      if (previousOwnership) removeOwnedNotice(previousOwnership);
      return ownership;
    };

    const ownsCurrentWaitingWorker = (
      ownership: WaitingWorkerOwnership,
    ): boolean =>
      activeWaitingOwnership === ownership &&
      registration.waiting === ownership.worker;

    const releaseStaleOwnership = (
      ownership: WaitingWorkerOwnership,
    ): boolean => {
      if (ownsCurrentWaitingWorker(ownership)) return false;
      if (activeWaitingOwnership === ownership) activeWaitingOwnership = null;
      removeOwnedNotice(ownership);
      return true;
    };

    const renderOwnedWaitingNotice = (
      ownership: WaitingWorkerOwnership,
      identity: PromptCloseAllReleaseIdentity,
      snapshots: UpdateBlockerSnapshot[],
      options: Parameters<typeof renderWaitingUpdateNotice>[3],
    ): void => {
      if (releaseStaleOwnership(ownership)) return;
      updateNoticeHost ??= ensureOuterAgentHost(root);
      renderWaitingUpdateNotice(updateNoticeHost, identity, snapshots, options);
      const notice = updateNoticeHost.querySelector<HTMLElement>(
        "[data-pwa-update-notice]",
      );
      if (notice) renderedNotice = { ownership, element: notice };
    };

    const discoverWaitingWorker = (worker: ServiceWorker | null): void => {
      if (
        !worker ||
        registration.waiting !== worker ||
        attemptedWaitingWorkers.has(worker)
      ) {
        return;
      }
      attemptedWaitingWorkers.add(worker);
      const ownership = claimWaitingWorker(worker);

      void (async () => {
        try {
          const waitingIdentity = await dependencies.queryIdentity(
            worker,
            "waiting",
          );
          const waitingReleaseIdentity = waitingIdentity.identity;
          if (
            !ownsCurrentWaitingWorker(ownership) ||
            waitingIdentity.workerState !== "waiting" ||
            waitingReleaseIdentity.pwaLifecycle !== "prompt-close-all-v1" ||
            !verifyWorkerEnvelope(waitingIdentity, origin)
          ) {
            return;
          }
          let latestSnapshots: UpdateBlockerSnapshot[] = [];
          const saveAndFlush = async (): Promise<void> => {
            if (releaseStaleOwnership(ownership)) return;
            try {
              const flushedSnapshots =
                await dependencies.requestBlockerSnapshots(worker, true);
              if (releaseStaleOwnership(ownership)) return;
              latestSnapshots = flushedSnapshots;
              const readyToClose =
                flushedSnapshots.length > 0 &&
                flushedSnapshots.every(
                  (snapshot) =>
                    snapshot.responsive &&
                    !snapshot.flushError &&
                    snapshot.blockers.length === 0,
                );
              renderOwnedWaitingNotice(
                ownership,
                waitingReleaseIdentity,
                flushedSnapshots,
                readyToClose
                  ? { phase: "ready-to-close" }
                  : {
                      phase: "save-incomplete",
                      onSaveAndFlush: saveAndFlush,
                    },
              );
            } catch {
              if (releaseStaleOwnership(ownership)) return;
              renderOwnedWaitingNotice(
                ownership,
                waitingReleaseIdentity,
                latestSnapshots,
                {
                  phase: "snapshot-error",
                  onSaveAndFlush: saveAndFlush,
                },
              );
            }
          };

          try {
            latestSnapshots = await dependencies.requestBlockerSnapshots(
              worker,
              false,
            );
            if (releaseStaleOwnership(ownership)) return;
            renderOwnedWaitingNotice(
              ownership,
              waitingReleaseIdentity,
              latestSnapshots,
              { phase: "save-required", onSaveAndFlush: saveAndFlush },
            );
          } catch {
            if (releaseStaleOwnership(ownership)) return;
            renderOwnedWaitingNotice(ownership, waitingReleaseIdentity, [], {
              phase: "snapshot-error",
              onSaveAndFlush: saveAndFlush,
            });
          }
        } catch {
          // Current verified role remains usable. Update discovery fails closed.
        }
      })();
    };

    const observeInstallingWorker = (worker: ServiceWorker | null): void => {
      if (!worker || observedInstallingWorkers.has(worker)) return;
      observedInstallingWorkers.add(worker);

      const onStateChange = (): void => {
        if (
          worker.state !== "installed" ||
          latestInstallingWorker !== worker ||
          registration.waiting !== worker
        ) {
          return;
        }
        discoverWaitingWorker(worker);
      };

      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    };

    const onUpdateFound = (): void => {
      latestInstallingWorker = registration.installing;
      observeInstallingWorker(latestInstallingWorker);
    };

    registration.addEventListener("updatefound", onUpdateFound);
    latestInstallingWorker = registration.installing;
    observeInstallingWorker(latestInstallingWorker);
    discoverWaitingWorker(registration.waiting);
  }

  return { status: "role-started", identity: currentIdentity, source };
};
