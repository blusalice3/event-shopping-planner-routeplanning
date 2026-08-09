// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  register: vi.fn(),
  render: vi.fn(),
  start: vi.fn(),
}));

vi.mock("./outerRecoveryAgent", () => ({
  startOuterRecoveryAgent: dependencies.start,
}));

vi.mock("./recoveryRoot", () => ({
  renderRecoveryRoot: dependencies.render,
}));

vi.mock("./serviceWorkerBootstrap", () => ({
  registerPromptCloseAllServiceWorker: dependencies.register,
}));

const importEntry = async (): Promise<void> => {
  await import("./outerAgentEntry");
};

const expectLoadingScreenHidden = (): void => {
  expect(document.getElementById("loading-screen")).toHaveClass("hidden");
};

describe("outer recovery agent entry", () => {
  beforeEach(() => {
    vi.resetModules();
    dependencies.register.mockReset();
    dependencies.render.mockReset();
    dependencies.start.mockReset();
    document.head.innerHTML = "";
    document.body.innerHTML =
      '<div id="loading-screen"></div><main id="root"></main>';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("delegates development startup to the role entry", async () => {
    vi.stubEnv("DEV", true);

    await importEntry();

    const roleEntry = document.head.querySelector<HTMLScriptElement>(
      'script[type="module"]',
    );
    expect(roleEntry?.getAttribute("src")).toBe("/src/index.tsx");
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
    expect(dependencies.render).not.toHaveBeenCalled();
    expectLoadingScreenHidden();
  });

  it("renders a closed recovery state when service worker registration fails", async () => {
    vi.stubEnv("DEV", false);
    dependencies.register.mockResolvedValue({
      status: "failed",
      error: new Error("registration denied"),
    });

    await importEntry();
    await vi.waitFor(() => expect(dependencies.render).toHaveBeenCalledOnce());

    expect(dependencies.render).toHaveBeenCalledWith(
      document.getElementById("root"),
      "service-worker-registration-failed",
    );
    expect(dependencies.start).not.toHaveBeenCalled();
    expectLoadingScreenHidden();
  });

  it("starts the outer recovery agent after service worker bootstrap", async () => {
    vi.stubEnv("DEV", false);
    dependencies.register.mockResolvedValue({ status: "unsupported" });
    dependencies.start.mockResolvedValue(undefined);

    await importEntry();
    await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalledOnce());

    expect(dependencies.render).not.toHaveBeenCalled();
    expectLoadingScreenHidden();
  });

  it("creates a recovery root and closes on an unhandled startup error", async () => {
    vi.stubEnv("DEV", false);
    document.getElementById("root")?.remove();
    dependencies.register.mockResolvedValue({ status: "registered" });
    dependencies.start.mockRejectedValue(new Error("identity unavailable"));

    await importEntry();
    await vi.waitFor(() => expect(dependencies.render).toHaveBeenCalledOnce());

    const root = document.getElementById("root");
    expect(root).toBeInstanceOf(HTMLElement);
    expect(root?.parentElement).toBe(document.body);
    expect(dependencies.render).toHaveBeenCalledWith(
      root,
      "outer-agent-unhandled-error",
    );
    expectLoadingScreenHidden();
  });
});
