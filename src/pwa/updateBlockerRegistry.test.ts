import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureLocalBlockerSnapshot,
  registerUpdateBlocker,
  resetUpdateBlockerRegistryForTests,
} from "./updateBlockerRegistry";

afterEach(() => {
  resetUpdateBlockerRegistryForTests();
});

describe("update blocker registry", () => {
  it("flushes active blockers before returning a snapshot", async () => {
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
    registerUpdateBlocker({
      id: "idle-overlay",
      label: "待機中",
      isBlocking: () => false,
    });

    await expect(
      captureLocalBlockerSnapshot("client-a", false),
    ).resolves.toMatchObject({
      blockers: [{ id: "event-autosave", label: "イベントを保存中" }],
      flushError: false,
    });
    expect(flush).not.toHaveBeenCalled();

    await expect(
      captureLocalBlockerSnapshot("client-a", true),
    ).resolves.toEqual({
      clientId: "client-a",
      capturedAt: expect.any(String),
      responsive: true,
      blockers: [],
      flushError: false,
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("fails closed when blocker inspection or flush throws", async () => {
    registerUpdateBlocker({
      id: "unknown-save-state",
      label: "保存状態を確認できません",
      isBlocking: () => {
        throw new Error("inspection failed");
      },
      flush: async () => {
        throw new Error("flush failed");
      },
    });

    const snapshot = await captureLocalBlockerSnapshot("client-b", true);
    expect(snapshot.blockers).toHaveLength(1);
    expect(snapshot.flushError).toBe(true);
  });

  it("rejects duplicate blocker IDs", () => {
    registerUpdateBlocker({
      id: "save",
      label: "保存中",
      isBlocking: () => true,
    });
    expect(() =>
      registerUpdateBlocker({
        id: "save",
        label: "別の保存",
        isBlocking: () => true,
      }),
    ).toThrow(/already registered/);
  });
});
