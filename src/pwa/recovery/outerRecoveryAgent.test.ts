// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PromptCloseAllReleaseIdentity,
  VerifiedWorkerIdentity,
} from "../releaseIdentityProtocol";
import {
  appendRoleEntryModule,
  getVersionedIdentityPath,
  identityMatchesRuntime,
  readRuntimeBuildMeta,
  startOuterRecoveryAgent,
  type OuterRecoveryAgentDependencies,
  type RuntimeBuildMeta,
} from "./outerRecoveryAgent";
import { resetUpdateBlockerRegistryForTests } from "./updateBlockerRegistry";

const SOURCE_SHA = "a".repeat(40);
const VARIANT_ID = "b".repeat(64);
const SHA = "c".repeat(64);

const identity: PromptCloseAllReleaseIdentity = {
  schemaVersion: 1,
  sourceSha: SOURCE_SHA,
  buildId: SOURCE_SHA,
  variantId: VARIANT_ID,
  releaseRole: "standard",
  requiredDbCompatibilityFingerprint: SHA,
  pwaLifecycle: "prompt-close-all-v1",
  roleEntryUrl: "/assets/standard-entry.js",
  roleEntrySha256: SHA,
  serviceWorkerUrl: "/sw.js",
  serviceWorkerSha256: SHA,
  outerAgentUrl: "/assets/outer-agent.js",
  outerAgentSha256: SHA,
};

const meta: RuntimeBuildMeta = {
  sourceSha: SOURCE_SHA,
  buildId: SOURCE_SHA,
  variantId: VARIANT_ID,
  releaseRole: "standard",
  outerAgentUrl: "/assets/outer-agent.js",
};

const canonicalize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
};

const runtimeDocument = (
  overrides: Partial<Record<keyof RuntimeBuildMeta, string>> = {},
): Document => {
  const runtime = { ...meta, ...overrides };
  const created = document.implementation.createHTMLDocument("runtime");
  const values = {
    "event-shopping-planner-source-sha": runtime.sourceSha,
    "event-shopping-planner-build-id": runtime.buildId,
    "event-shopping-planner-variant-id": runtime.variantId,
    "event-shopping-planner-release-role": runtime.releaseRole,
    "event-shopping-planner-outer-agent-url": runtime.outerAgentUrl,
  };
  for (const [name, content] of Object.entries(values)) {
    const element = created.createElement("meta");
    element.name = name;
    element.content = content;
    created.head.appendChild(element);
  }
  return created;
};

const verifiedWorkerIdentity = (
  workerState: "active" | "waiting" = "active",
  value: PromptCloseAllReleaseIdentity = identity,
): VerifiedWorkerIdentity => ({
  workerState,
  scriptUrl: "https://planner.test/sw.js",
  versionedIdentityUrl: `https://planner.test${getVersionedIdentityPath(value)}`,
  canonicalIdentityBytes: canonicalize(value),
  identity: value,
});

const registration = (
  waiting: ServiceWorker | null = null,
  installing: ServiceWorker | null = null,
) =>
  Object.assign(new EventTarget(), {
    installing,
    waiting,
    update: vi.fn<() => Promise<unknown>>(async () => undefined),
  });

const serviceWorker = (
  state: ServiceWorkerState = "installing",
): ServiceWorker => {
  const worker = new EventTarget() as ServiceWorker;
  Object.defineProperty(worker, "state", {
    configurable: true,
    value: state,
    writable: true,
  });
  return worker;
};

const transitionWorker = (
  worker: ServiceWorker,
  state: ServiceWorkerState,
): void => {
  Object.defineProperty(worker, "state", {
    configurable: true,
    value: state,
    writable: true,
  });
  worker.dispatchEvent(new Event("statechange"));
};

const serviceWorkerContainer = ({
  controller = {} as ServiceWorker,
  currentRegistration = registration(),
  registrationError,
}: {
  controller?: ServiceWorker | null;
  currentRegistration?: ReturnType<typeof registration>;
  registrationError?: Error;
} = {}): NonNullable<OuterRecoveryAgentDependencies["serviceWorker"]> => ({
  controller,
  getRegistration: vi.fn(async () => {
    if (registrationError) throw registrationError;
    return currentRegistration;
  }),
  addEventListener: vi.fn(),
});

const dependencies = (
  overrides: Partial<OuterRecoveryAgentDependencies> = {},
): OuterRecoveryAgentDependencies => ({
  root: document.createElement("div"),
  document: runtimeDocument(),
  location: { origin: "https://planner.test" } as Location,
  serviceWorker: serviceWorkerContainer(),
  fetch: vi.fn() as unknown as typeof fetch,
  currentOuterAgentUrl: "https://planner.test/assets/outer-agent.js",
  loadRoleEntry: vi.fn(async () => undefined),
  queryIdentity: vi.fn(async () => verifiedWorkerIdentity()),
  requestBlockerSnapshots: vi.fn(async () => []),
  ...overrides,
});

afterEach(() => {
  resetUpdateBlockerRegistryForTests();
});

describe("outer recovery runtime identity gate", () => {
  it("accepts only an exact source, variant, role, and local outer path", () => {
    expect(
      identityMatchesRuntime(
        identity,
        meta,
        "https://planner.test/assets/outer-agent.js",
        "https://planner.test",
      ),
    ).toBe(true);
    expect(
      identityMatchesRuntime(
        { ...identity, variantId: "d".repeat(64) },
        meta,
        "https://planner.test/assets/outer-agent.js",
        "https://planner.test",
      ),
    ).toBe(false);
  });

  it("rejects a cross-origin role entry", () => {
    expect(
      identityMatchesRuntime(
        {
          ...identity,
          roleEntryUrl: "https://attacker.test/entry.js",
        },
        meta,
        "https://planner.test/assets/outer-agent.js",
        "https://planner.test",
      ),
    ).toBe(false);
  });

  it("reads only a complete runtime meta envelope", () => {
    expect(
      readRuntimeBuildMeta(
        runtimeDocument(),
        "https://planner.test/assets/outer-agent.js",
      ),
    ).toEqual(meta);

    const invalid = runtimeDocument({
      releaseRole: "invalid",
    });
    expect(
      readRuntimeBuildMeta(
        invalid,
        "https://planner.test/assets/outer-agent.js",
      ),
    ).toBeNull();

    const fallback = runtimeDocument();
    fallback
      .querySelector('[name="event-shopping-planner-source-sha"]')
      ?.remove();
    expect(
      readRuntimeBuildMeta(
        fallback,
        "https://planner.test/assets/outer-agent.js",
      )?.sourceSha,
    ).toBe(SOURCE_SHA);
  });

  it("loads the verified role entry through a module element", async () => {
    const created = document.implementation.createHTMLDocument("role");
    const loaded = appendRoleEntryModule(created, identity);
    const script = created.head.querySelector("script");
    expect(script).not.toBeNull();
    expect(script?.getAttribute("type")).toBe("module");
    expect(script?.getAttribute("src")).toBe(identity.roleEntryUrl);
    expect(script?.getAttribute("data-release-role")).toBe("standard");
    script?.dispatchEvent(new Event("load"));
    await expect(loaded).resolves.toBeUndefined();

    const failed = appendRoleEntryModule(created, identity);
    created.head
      .querySelectorAll("script")
      .item(1)
      .dispatchEvent(new Event("error"));
    await expect(failed).rejects.toThrow(/could not be loaded/);
  });

  it("fails closed for invalid meta, unsupported workers, and registration errors", async () => {
    const invalidDocument = runtimeDocument();
    invalidDocument
      .querySelector('[name="event-shopping-planner-variant-id"]')
      ?.remove();
    const invalid = dependencies({ document: invalidDocument });
    await expect(startOuterRecoveryAgent(invalid)).resolves.toEqual({
      status: "recovery",
      reasonCode: "html-meta-invalid",
    });
    expect(invalid.root).toHaveAttribute("data-pwa-recovery", "true");

    const unsupported = dependencies({ serviceWorker: undefined });
    await expect(startOuterRecoveryAgent(unsupported)).resolves.toEqual({
      status: "unsupported",
      reasonCode: "service-worker-unsupported",
    });

    const failedRegistration = dependencies({
      serviceWorker: serviceWorkerContainer({
        registrationError: new Error("denied"),
      }),
    });
    await expect(startOuterRecoveryAgent(failedRegistration)).resolves.toEqual({
      status: "recovery",
      reasonCode: "registration-read-failed",
    });
  });

  it("starts a controller-bound role only after exact worker verification", async () => {
    const queryIdentity = vi.fn(async () => verifiedWorkerIdentity());
    const loadRoleEntry = vi.fn(async () => undefined);
    const bound = dependencies({ queryIdentity, loadRoleEntry });

    await expect(startOuterRecoveryAgent(bound)).resolves.toEqual({
      status: "role-started",
      identity,
      source: "controller",
    });
    expect(queryIdentity).toHaveBeenCalledWith(
      bound.serviceWorker?.controller,
      "active",
    );
    expect(loadRoleEntry).toHaveBeenCalledWith(identity);
  });

  it("renders retry recovery for a controller identity mismatch", async () => {
    const currentRegistration = registration();
    const mismatch = {
      ...verifiedWorkerIdentity(),
      scriptUrl: "https://planner.test/wrong-sw.js",
    };
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity: vi.fn(async () => mismatch),
    });

    await expect(startOuterRecoveryAgent(bound)).resolves.toEqual({
      status: "recovery",
      reasonCode: "active-worker-identity-mismatch",
    });
    bound.root.querySelector("button")?.click();
    await Promise.resolve();
    expect(currentRegistration.update).toHaveBeenCalledOnce();
  });

  it("starts a first-install role only when stable and versioned bytes match", async () => {
    const bytes = canonicalize(identity);
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => bytes,
    })) as unknown as typeof fetch;
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ controller: null }),
      fetch: fetcher,
    });

    await expect(startOuterRecoveryAgent(bound)).resolves.toEqual({
      status: "role-started",
      identity,
      source: "network-first-install",
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/release-identity.json",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      getVersionedIdentityPath(identity),
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("fails closed for unavailable first-install identity and role entry", async () => {
    const currentRegistration = registration();
    const unavailable = dependencies({
      serviceWorker: serviceWorkerContainer({
        controller: null,
        currentRegistration,
      }),
      fetch: vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    await expect(startOuterRecoveryAgent(unavailable)).resolves.toEqual({
      status: "recovery",
      reasonCode: "first-install-identity-unavailable",
    });
    unavailable.root.querySelector("button")?.click();
    await Promise.resolve();
    expect(currentRegistration.update).toHaveBeenCalledOnce();

    const roleFailure = dependencies({
      loadRoleEntry: vi.fn(async () => {
        throw new Error("chunk unavailable");
      }),
    });
    await expect(startOuterRecoveryAgent(roleFailure)).resolves.toEqual({
      status: "recovery",
      reasonCode: "role-entry-load-failed",
    });
  });

  it("ignores an invalid waiting worker without replacing the active role", async () => {
    const waiting = {} as ServiceWorker;
    const currentRegistration = registration(waiting);
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce({
        ...verifiedWorkerIdentity("waiting"),
        scriptUrl: "https://planner.test/unexpected-sw.js",
      });
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
    });

    await expect(startOuterRecoveryAgent(bound)).resolves.toMatchObject({
      status: "role-started",
      source: "controller",
    });
    await vi.waitFor(() => expect(queryIdentity).toHaveBeenCalledTimes(2));
    expect(bound.root.querySelector("[data-pwa-update-notice]")).toBeNull();
  });

  it("renders a save-complete notice after a valid waiting worker reports no blockers", async () => {
    const waiting = {} as ServiceWorker;
    const currentRegistration = registration(waiting);
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce(verifiedWorkerIdentity("waiting"));
    const requestBlockerSnapshots = vi.fn(async () => []);
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });

    await expect(startOuterRecoveryAgent(bound)).resolves.toMatchObject({
      status: "role-started",
      source: "controller",
    });
    await vi.waitFor(() =>
      expect(requestBlockerSnapshots).toHaveBeenCalledWith(waiting, true),
    );
    await vi.waitFor(() =>
      expect(
        bound.root.querySelector("[data-pwa-update-notice]"),
      ).toHaveTextContent("保存が完了しました"),
    );
  });

  it("discovers an updatefound worker after its installed statechange", async () => {
    const currentRegistration = registration();
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce(verifiedWorkerIdentity("waiting"));
    const requestBlockerSnapshots = vi.fn(async () => []);
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });

    await expect(startOuterRecoveryAgent(bound)).resolves.toMatchObject({
      status: "role-started",
      source: "controller",
    });

    const installing = serviceWorker();
    currentRegistration.installing = installing;
    currentRegistration.dispatchEvent(new Event("updatefound"));
    currentRegistration.waiting = installing;
    transitionWorker(installing, "installed");

    await vi.waitFor(() =>
      expect(requestBlockerSnapshots).toHaveBeenCalledWith(installing, true),
    );
    expect(bound.root.querySelector("[data-pwa-update-notice]")).not.toBeNull();
  });

  it("discovers a worker that is already installed when updatefound fires", async () => {
    const currentRegistration = registration();
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce(verifiedWorkerIdentity("waiting"));
    const requestBlockerSnapshots = vi.fn(async () => []);
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });
    await startOuterRecoveryAgent(bound);

    const installed = serviceWorker("installed");
    currentRegistration.installing = installed;
    currentRegistration.waiting = installed;
    currentRegistration.dispatchEvent(new Event("updatefound"));

    await vi.waitFor(() =>
      expect(requestBlockerSnapshots).toHaveBeenCalledWith(installed, true),
    );
  });

  it("deduplicates repeated lifecycle events for the same waiting worker", async () => {
    const currentRegistration = registration();
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce(verifiedWorkerIdentity("waiting"));
    const requestBlockerSnapshots = vi.fn(async () => []);
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });
    await startOuterRecoveryAgent(bound);

    const installed = serviceWorker("installed");
    currentRegistration.installing = installed;
    currentRegistration.waiting = installed;
    currentRegistration.dispatchEvent(new Event("updatefound"));
    currentRegistration.dispatchEvent(new Event("updatefound"));
    installed.dispatchEvent(new Event("statechange"));

    await vi.waitFor(() => expect(requestBlockerSnapshots).toHaveBeenCalled());
    expect(queryIdentity).toHaveBeenCalledTimes(2);
    expect(requestBlockerSnapshots).toHaveBeenCalledOnce();
  });

  it("ignores stale installing workers and invalid waiting identities", async () => {
    const currentRegistration = registration();
    const invalidIdentity = {
      ...verifiedWorkerIdentity("waiting"),
      scriptUrl: "https://planner.test/unexpected-sw.js",
    };
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce(invalidIdentity);
    const requestBlockerSnapshots = vi.fn(async () => []);
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });
    await startOuterRecoveryAgent(bound);

    const stale = serviceWorker();
    currentRegistration.installing = stale;
    currentRegistration.dispatchEvent(new Event("updatefound"));
    const current = serviceWorker("installed");
    currentRegistration.installing = current;
    currentRegistration.waiting = current;
    currentRegistration.dispatchEvent(new Event("updatefound"));
    currentRegistration.waiting = stale;
    transitionWorker(stale, "installed");
    currentRegistration.waiting = current;
    current.dispatchEvent(new Event("statechange"));

    await vi.waitFor(() => expect(queryIdentity).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestBlockerSnapshots).not.toHaveBeenCalled();
    expect(bound.root.querySelector("[data-pwa-update-notice]")).toBeNull();
    expect(bound.root).not.toHaveAttribute("data-pwa-recovery");
  });

  it("keeps the current role when a discovered worker identity query fails", async () => {
    const currentRegistration = registration();
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockRejectedValueOnce(new Error("waiting identity unavailable"));
    const requestBlockerSnapshots = vi.fn(async () => []);
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });
    await startOuterRecoveryAgent(bound);

    const installed = serviceWorker("installed");
    currentRegistration.installing = installed;
    currentRegistration.waiting = installed;
    currentRegistration.dispatchEvent(new Event("updatefound"));

    await vi.waitFor(() => expect(queryIdentity).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestBlockerSnapshots).not.toHaveBeenCalled();
    expect(bound.root.querySelector("[data-pwa-update-notice]")).toBeNull();
    expect(bound.root).not.toHaveAttribute("data-pwa-recovery");
  });

  it("does not render a false save-complete notice when blocker aggregation fails", async () => {
    const waiting = {} as ServiceWorker;
    const currentRegistration = registration(waiting);
    const queryIdentity = vi
      .fn()
      .mockResolvedValueOnce(verifiedWorkerIdentity())
      .mockResolvedValueOnce(verifiedWorkerIdentity("waiting"));
    const requestBlockerSnapshots = vi.fn(async () => {
      throw new Error("snapshot channel unavailable");
    });
    const bound = dependencies({
      serviceWorker: serviceWorkerContainer({ currentRegistration }),
      queryIdentity,
      requestBlockerSnapshots,
    });

    await expect(startOuterRecoveryAgent(bound)).resolves.toMatchObject({
      status: "role-started",
      source: "controller",
    });
    await vi.waitFor(() =>
      expect(requestBlockerSnapshots).toHaveBeenCalledWith(waiting, true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bound.root.querySelector("[data-pwa-update-notice]")).toBeNull();
    expect(bound.root).not.toHaveTextContent("保存が完了しました");
  });
});
