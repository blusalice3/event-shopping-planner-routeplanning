// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const identity = {
  schemaVersion: 1,
  sourceSha: "a".repeat(40),
  buildId: "a".repeat(40),
  variantId: "b".repeat(64),
  releaseRole: "containment",
  requiredDbCompatibilityFingerprint: "c".repeat(64),
  pwaLifecycle: "prompt-close-all-v1",
  roleEntryUrl: "/assets/containment-entry.js",
  roleEntrySha256: "d".repeat(64),
  serviceWorkerUrl: "/sw.js",
  serviceWorkerSha256: "e".repeat(64),
  outerAgentUrl: "/assets/outer-agent.js",
  outerAgentSha256: "f".repeat(64),
} as const;

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

const setServiceWorker = (value: unknown): void => {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value,
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("read-only containment entry", () => {
  it("mounts verified public diagnostics and checks for an update", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const update = vi.fn(async () => undefined);
    const getRegistration = vi.fn(async () => ({ update }));
    setServiceWorker({ getRegistration });
    const fetcher = vi.fn(async () => ({
      ok: true,
      text: async () => canonicalize(identity),
    }));
    vi.stubGlobal("fetch", fetcher);

    await import("./index");
    const root = document.getElementById("root");
    await vi.waitFor(() =>
      expect(root).toHaveAttribute("data-containment-role", "true"),
    );
    expect(root).toHaveTextContent("読み取り専用の復旧モード");
    expect(root?.querySelector("pre")).toHaveTextContent(identity.variantId);
    expect(fetcher).toHaveBeenCalledWith("/release-identity.json", {
      cache: "no-store",
      credentials: "same-origin",
    });

    root?.querySelector("button")?.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(getRegistration).toHaveBeenCalledWith("/");
  });

  it("creates its root and stays read-only when identity fetch fails", async () => {
    setServiceWorker({
      getRegistration: vi.fn(async () => undefined),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await import("./index");
    await vi.waitFor(() =>
      expect(document.getElementById("root")).toHaveAttribute(
        "data-containment-role",
        "true",
      ),
    );
    expect(document.querySelector("pre")).toBeNull();
    expect(document.body).toHaveTextContent(
      "この画面は保存データを変更しません",
    );
  });
});
