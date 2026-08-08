import { afterEach, describe, expect, it } from "vitest";
import {
  captureLocalBlockerSnapshot,
  resetUpdateBlockerRegistryForTests,
} from "../../pwa/updateBlockerRegistry";
import { appRuntime } from "./appRuntime";

afterEach(() => {
  resetUpdateBlockerRegistryForTests();
});

describe("appRuntime update blocker port", () => {
  it("registers and unregisters an app-owned blocker through the neutral port", async () => {
    const unregister = appRuntime.registerUpdateBlocker({
      id: "event-autosave",
      label: "イベントを保存中",
      isBlocking: () => true,
    });

    await expect(
      captureLocalBlockerSnapshot("client-a", false),
    ).resolves.toMatchObject({
      blockers: [{ id: "event-autosave", label: "イベントを保存中" }],
    });

    unregister();

    await expect(
      captureLocalBlockerSnapshot("client-a", false),
    ).resolves.toMatchObject({ blockers: [] });
  });
});
