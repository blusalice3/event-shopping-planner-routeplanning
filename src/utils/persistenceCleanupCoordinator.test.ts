import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION,
  PERSISTENCE_LEGACY_CLEANUP_LOCK_NAME,
  coordinatePersistenceLegacyCleanup,
  isPersistenceLegacyCleanupBuildEnabled,
  type AutomaticPersistenceCleanupRequest,
  type PersistenceCleanupClientHandshakeProof,
  type PersistenceCleanupLock,
  type PersistenceCleanupLockManager,
  type PersistenceCleanupMetricEvent,
  type PersistenceCleanupServiceWorkerProof,
} from "./persistenceCleanupCoordinator";

const SUPPORTED_VERSION = "release-b-v1";
const SUPPORTED_SW_VERSION = "release-b-sw-v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

const completeClientProof = (
  overrides: Partial<
    Extract<
      PersistenceCleanupClientHandshakeProof,
      { status: "complete" }
    >["clients"][number]
  > = {},
): PersistenceCleanupClientHandshakeProof => ({
  status: "complete",
  clients: [
    {
      version: SUPPORTED_VERSION,
      response: "responsive",
      quiescence: "quiescent",
      ...overrides,
    },
  ],
});

const activeServiceWorkerProof = (): PersistenceCleanupServiceWorkerProof => ({
  status: "complete",
  hasActiveWorker: true,
  hasWaitingWorker: false,
  activeWorkerVersion: SUPPORTED_SW_VERSION,
});

const createLockManager = (
  lockFactory: (name: string) => PersistenceCleanupLock | null = (name) => ({
    name,
    mode: "exclusive",
  }),
): PersistenceCleanupLockManager => ({
  request: async <T>(
    name: string,
    _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: PersistenceCleanupLock | null) => T | PromiseLike<T>,
  ): Promise<T> => await callback(lockFactory(name)),
});

const createAutomaticRequest = (
  overrides: Partial<AutomaticPersistenceCleanupRequest<string>> = {},
): AutomaticPersistenceCleanupRequest<string> => ({
  mode: "auto",
  buildFlagValue: "true",
  isRuntimeKillSwitchActive: () => false,
  lockManager: createLockManager(),
  supportedClientVersions: [SUPPORTED_VERSION],
  supportedServiceWorkerVersions: [SUPPORTED_SW_VERSION],
  getClientHandshakeProof: completeClientProof,
  getServiceWorkerProof: activeServiceWorkerProof,
  cleanupTask: () => "cleanup-complete",
  ...overrides,
});

describe("isPersistenceLegacyCleanupBuildEnabled", () => {
  it("exactな文字列trueだけを有効とし、既定値と類似値をfail closedにする", () => {
    expect(isPersistenceLegacyCleanupBuildEnabled("true")).toBe(true);
    expect(isPersistenceLegacyCleanupBuildEnabled(undefined)).toBe(false);
    expect(isPersistenceLegacyCleanupBuildEnabled("TRUE")).toBe(false);
    expect(isPersistenceLegacyCleanupBuildEnabled("1")).toBe(false);
    expect(isPersistenceLegacyCleanupBuildEnabled(true)).toBe(false);
  });

  it("production modeではtest overrideで静的OFF flagを迂回できない", () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("VITE_PERSISTENCE_LEGACY_CLEANUP", "false");

    expect(isPersistenceLegacyCleanupBuildEnabled("true")).toBe(false);
  });
});

describe("coordinatePersistenceLegacyCleanup auto mode", () => {
  it("build flagが明示的にONでなければproofやtaskを一切呼ばない", async () => {
    const killSwitch = vi.fn(() => false);
    const clientProof = vi.fn(completeClientProof);
    const serviceWorkerProof = vi.fn(activeServiceWorkerProof);
    const cleanupTask = vi.fn(() => "unused");

    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        buildFlagValue: undefined,
        isRuntimeKillSwitchActive: killSwitch,
        getClientHandshakeProof: clientProof,
        getServiceWorkerProof: serviceWorkerProof,
        cleanupTask,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "auto",
      reason: "feature-flag-disabled",
    });
    expect(killSwitch).not.toHaveBeenCalled();
    expect(clientProof).not.toHaveBeenCalled();
    expect(serviceWorkerProof).not.toHaveBeenCalled();
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it("runtime kill switchがactiveなら即時停止する", async () => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        isRuntimeKillSwitchActive: () => true,
        cleanupTask,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "auto",
      reason: "runtime-kill-switch-active",
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["throw", () => Promise.reject(new Error("private failure"))],
    ["non-boolean", () => undefined as unknown as boolean],
  ])(
    "runtime kill switchが%sならunknownとして延期する",
    async (_label, isRuntimeKillSwitchActive) => {
      const cleanupTask = vi.fn(() => "unused");
      const result = await coordinatePersistenceLegacyCleanup(
        createAutomaticRequest({
          isRuntimeKillSwitchActive,
          cleanupTask,
        }),
      );

      expect(result).toEqual({
        status: "cleanup-deferred",
        mode: "auto",
        reason: "runtime-kill-switch-unknown",
      });
      expect(cleanupTask).not.toHaveBeenCalled();
    },
  );

  it("Web Locks非対応なら延期する", async () => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({ lockManager: null, cleanupTask }),
    );

    expect(result).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason: "web-locks-unsupported",
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it("exclusive lockをifAvailableで要求し、そのscope内だけでtaskを実行する", async () => {
    const order: string[] = [];
    const lockManager: PersistenceCleanupLockManager = {
      request: async <T>(
        name: string,
        options: {
          readonly mode: "exclusive";
          readonly ifAvailable: true;
        },
        callback: (lock: PersistenceCleanupLock | null) => T | PromiseLike<T>,
      ): Promise<T> => {
        expect(name).toBe(PERSISTENCE_LEGACY_CLEANUP_LOCK_NAME);
        expect(options).toEqual({
          mode: "exclusive",
          ifAvailable: true,
        });
        order.push("lock-enter");
        const result = await callback({ name, mode: "exclusive" });
        order.push("lock-exit");
        return result;
      },
    };

    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        lockManager,
        isRuntimeKillSwitchActive: vi
          .fn()
          .mockImplementationOnce(() => false)
          .mockImplementationOnce(() => {
            order.push("kill-inside-lock");
            return false;
          })
          .mockImplementationOnce(() => {
            order.push("kill-final");
            return false;
          }),
        getServiceWorkerProof: () => {
          order.push("service-worker");
          return activeServiceWorkerProof();
        },
        getClientHandshakeProof: () => {
          order.push("clients-quiesced");
          return completeClientProof();
        },
        cleanupTask: () => {
          order.push("cleanup-task");
          return "cleanup-complete";
        },
      }),
    );

    expect(result).toEqual({
      status: "completed",
      mode: "auto",
      value: "cleanup-complete",
    });
    expect(order).toEqual([
      "lock-enter",
      "kill-inside-lock",
      "service-worker",
      "clients-quiesced",
      "kill-final",
      "cleanup-task",
      "lock-exit",
    ]);
  });

  it.each([
    [
      "lock取得不可",
      createLockManager(() => null),
      "exclusive-lock-unavailable",
    ],
    [
      "shared lock",
      createLockManager((name) => ({ name, mode: "shared" })),
      "exclusive-lock-not-proven",
    ],
    [
      "別名lock",
      createLockManager(() => ({
        name: "unexpected-lock",
        mode: "exclusive",
      })),
      "exclusive-lock-not-proven",
    ],
  ])("%sではtaskを呼ばない", async (_label, lockManager, reason) => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({ lockManager, cleanupTask }),
    );

    expect(result).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason,
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it("lock requestの例外を延期へ変換する", async () => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        lockManager: {
          request: async () => {
            throw new Error("lock details must not escape");
          },
        },
        cleanupTask,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason: "exclusive-lock-request-failed",
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it.each<
    [string, PersistenceCleanupServiceWorkerProof | (() => never), string]
  >([
    ["unknown", { status: "unknown" }, "service-worker-state-unknown"],
    ["unsupported", { status: "unsupported" }, "service-worker-unsupported"],
    [
      "registration missing",
      { status: "registration-missing" },
      "service-worker-registration-missing",
    ],
    [
      "waiting worker",
      {
        status: "complete",
        hasActiveWorker: true,
        hasWaitingWorker: true,
        activeWorkerVersion: SUPPORTED_SW_VERSION,
      },
      "service-worker-update-waiting",
    ],
    [
      "active worker missing",
      {
        status: "complete",
        hasActiveWorker: false,
        hasWaitingWorker: false,
        activeWorkerVersion: null,
      },
      "service-worker-not-active",
    ],
    [
      "proof throw",
      () => {
        throw new Error("private service worker error");
      },
      "service-worker-state-unknown",
    ],
  ])("%sのService Worker proofを延期する", async (_label, proof, reason) => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        getServiceWorkerProof:
          typeof proof === "function" ? proof : () => proof,
        cleanupTask,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason,
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it.each([
    [
      "対応SW version未設定",
      [] as string[],
      activeServiceWorkerProof(),
      "service-worker-version-unconfigured",
    ],
    [
      "active SW version不明",
      [SUPPORTED_SW_VERSION],
      {
        ...activeServiceWorkerProof(),
        activeWorkerVersion: null,
      },
      "service-worker-version-unknown",
    ],
    [
      "active SW version不一致",
      [SUPPORTED_SW_VERSION],
      {
        ...activeServiceWorkerProof(),
        activeWorkerVersion: "unsupported-sw",
      },
      "service-worker-version-mismatch",
    ],
  ])(
    "%sならcleanupを延期する",
    async (_label, supportedServiceWorkerVersions, proof, expectedReason) => {
      const cleanupTask = vi.fn(() => "unused");
      const result = await coordinatePersistenceLegacyCleanup(
        createAutomaticRequest({
          supportedServiceWorkerVersions,
          getServiceWorkerProof: () => proof,
          cleanupTask,
        }),
      );

      expect(result).toEqual({
        status: "cleanup-deferred",
        mode: "auto",
        reason: expectedReason,
      });
      expect(cleanupTask).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "handshake unknown",
      { status: "unknown" } as const,
      "client-handshake-unknown",
    ],
    [
      "client無し",
      { status: "complete", clients: [] } as const,
      "client-handshake-unknown",
    ],
    [
      "無応答client",
      completeClientProof({ response: "unresponsive" }),
      "unresponsive-client",
    ],
    [
      "version不明client",
      completeClientProof({ version: null }),
      "client-version-unknown",
    ],
    [
      "旧版client",
      completeClientProof({ version: "release-a-old" }),
      "unsupported-client-version",
    ],
    [
      "quiescence不明client",
      completeClientProof({ quiescence: "unknown" }),
      "client-quiescence-unknown",
    ],
    [
      "active client",
      completeClientProof({ quiescence: "active" }),
      "client-not-quiescent",
    ],
  ])("%sを延期しtaskを呼ばない", async (_label, proof, reason) => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        getClientHandshakeProof: () => proof,
        cleanupTask,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason,
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it("client proofのthrowとtimeoutをhandshake unknownへ変換する", async () => {
    const throwingTask = vi.fn(() => "unused");
    const throwingResult = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        getClientHandshakeProof: () => {
          throw new Error("private client error");
        },
        cleanupTask: throwingTask,
      }),
    );
    expect(throwingResult).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason: "client-handshake-unknown",
    });
    expect(throwingTask).not.toHaveBeenCalled();

    const timedOutTask = vi.fn(() => "unused");
    const timedOutResult = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        safetyCheckTimeoutMs: 5,
        getClientHandshakeProof: () =>
          new Promise<PersistenceCleanupClientHandshakeProof>(() => {
            // Intentionally never responds.
          }),
        cleanupTask: timedOutTask,
      }),
    );
    expect(timedOutResult).toEqual({
      status: "cleanup-deferred",
      mode: "auto",
      reason: "client-handshake-unknown",
    });
    expect(timedOutTask).not.toHaveBeenCalled();
  });

  it("最終確認時にkill switchがactiveになった場合はtask直前で停止する", async () => {
    const cleanupTask = vi.fn(() => "unused");
    const killSwitch = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        isRuntimeKillSwitchActive: killSwitch,
        cleanupTask,
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "auto",
      reason: "runtime-kill-switch-active",
    });
    expect(killSwitch).toHaveBeenCalledTimes(3);
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it("task contextはlock内でservice workerとclientの安全証明を再検証する", async () => {
    const serviceWorkerProof = vi.fn(activeServiceWorkerProof);
    const clientProof = vi
      .fn()
      .mockReturnValueOnce(completeClientProof())
      .mockReturnValueOnce(completeClientProof({ response: "unresponsive" }));
    let revalidationResult: unknown;

    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        getServiceWorkerProof: serviceWorkerProof,
        getClientHandshakeProof: clientProof,
        cleanupTask: async ({ revalidateSafety }) => {
          revalidationResult = await revalidateSafety();
          return "cleanup-complete";
        },
      }),
    );

    expect(result).toEqual({
      status: "completed",
      mode: "auto",
      value: "cleanup-complete",
    });
    expect(revalidationResult).toEqual({
      status: "cleanup-deferred",
      reason: "unresponsive-client",
    });
    expect(serviceWorkerProof).toHaveBeenCalledTimes(2);
    expect(clientProof).toHaveBeenCalledTimes(2);
  });

  it("cleanup taskのthrowを内容非公開のblockedへ変換する", async () => {
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        cleanupTask: () => {
          throw new Error("raw localStorage value: secret");
        },
      }),
    );

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "auto",
      reason: "cleanup-task-failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("coordinatePersistenceLegacyCleanup manual mode", () => {
  it("他tabを閉じた明示確認がなければtaskを呼ばない", async () => {
    const cleanupTask = vi.fn(() => "unused");
    const result = await coordinatePersistenceLegacyCleanup({
      mode: "manual",
      buildFlagValue: "true",
      isRuntimeKillSwitchActive: () => false,
      lockManager: null,
      cleanupTask,
    });

    expect(result).toEqual({
      status: "cleanup-blocked",
      mode: "manual",
      reason: "manual-other-tabs-not-confirmed",
    });
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it("Web Locks非対応時は明示確認とkill switch確認により実行できる", async () => {
    const result = await coordinatePersistenceLegacyCleanup({
      mode: "manual",
      buildFlagValue: "true",
      isRuntimeKillSwitchActive: () => false,
      lockManager: null,
      otherTabsClosedConfirmation: MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION,
      cleanupTask: () => "manual-complete",
    });

    expect(result).toEqual({
      status: "completed",
      mode: "manual",
      value: "manual-complete",
    });
  });

  it("Web Locks対応時はexclusive lock取得を必須にする", async () => {
    const unavailableTask = vi.fn(() => "unused");
    const unavailableResult = await coordinatePersistenceLegacyCleanup({
      mode: "manual",
      buildFlagValue: "true",
      isRuntimeKillSwitchActive: () => false,
      lockManager: createLockManager(() => null),
      otherTabsClosedConfirmation: MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION,
      cleanupTask: unavailableTask,
    });
    expect(unavailableResult).toEqual({
      status: "cleanup-deferred",
      mode: "manual",
      reason: "exclusive-lock-unavailable",
    });
    expect(unavailableTask).not.toHaveBeenCalled();

    const availableTask = vi.fn(() => "manual-with-lock");
    const availableResult = await coordinatePersistenceLegacyCleanup({
      mode: "manual",
      buildFlagValue: "true",
      isRuntimeKillSwitchActive: () => false,
      lockManager: createLockManager(),
      otherTabsClosedConfirmation: MANUAL_PERSISTENCE_CLEANUP_CONFIRMATION,
      cleanupTask: availableTask,
    });
    expect(availableResult).toEqual({
      status: "completed",
      mode: "manual",
      value: "manual-with-lock",
    });
    expect(availableTask).toHaveBeenCalledOnce();
  });
});

describe("persistence cleanup metrics", () => {
  it("列挙済みmetadataだけを通知し、metric失敗はcleanupを妨げない", async () => {
    const events: PersistenceCleanupMetricEvent[] = [];
    const result = await coordinatePersistenceLegacyCleanup(
      createAutomaticRequest({
        metricSink: (event) => {
          events.push(event);
          if (event.name === "persistence-cleanup-task-started") {
            throw new Error("metrics offline");
          }
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(events.map((event) => event.name)).toEqual([
      "persistence-cleanup-attempted",
      "persistence-cleanup-task-started",
      "persistence-cleanup-completed",
    ]);
    for (const event of events) {
      expect(event).not.toHaveProperty("payload");
      expect(event).not.toHaveProperty("error");
      expect(event).not.toHaveProperty("clientId");
    }
  });
});
