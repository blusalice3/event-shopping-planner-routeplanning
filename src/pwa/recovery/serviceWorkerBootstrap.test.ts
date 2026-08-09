import { describe, expect, it, vi } from "vitest";
import { registerPromptCloseAllServiceWorker } from "./serviceWorkerBootstrap";

describe("prompt-close-all service worker bootstrap", () => {
  it("reports unsupported without a service worker container", async () => {
    vi.stubGlobal("navigator", undefined);
    try {
      await expect(registerPromptCloseAllServiceWorker()).resolves.toEqual({
        status: "unsupported",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(
      registerPromptCloseAllServiceWorker(undefined),
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("registers the fixed classic worker without update-cache reuse", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    const container = {
      register,
    } as unknown as ServiceWorkerContainer;

    await expect(
      registerPromptCloseAllServiceWorker(container, "/versioned-sw.js"),
    ).resolves.toEqual({ status: "registered", registration });
    expect(register).toHaveBeenCalledWith("/versioned-sw.js", {
      scope: "/",
      type: "classic",
      updateViaCache: "none",
    });
  });

  it("returns a closed Error for registration failures", async () => {
    const expected = new Error("registration denied");
    const errorContainer = {
      register: vi.fn(async () => {
        throw expected;
      }),
    } as unknown as ServiceWorkerContainer;
    const nonErrorContainer = {
      register: vi.fn(async () => {
        throw "registration denied";
      }),
    } as unknown as ServiceWorkerContainer;

    await expect(
      registerPromptCloseAllServiceWorker(errorContainer),
    ).resolves.toEqual({ status: "failed", error: expected });
    await expect(
      registerPromptCloseAllServiceWorker(nonErrorContainer),
    ).resolves.toEqual({
      status: "failed",
      error: new Error("Service Worker registration failed."),
    });
  });
});
