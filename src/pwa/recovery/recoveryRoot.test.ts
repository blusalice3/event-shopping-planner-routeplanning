// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PromptCloseAllReleaseIdentity } from "../releaseIdentityProtocol";
import {
  describeIdentityForDiagnostics,
  renderRecoveryRoot,
  renderWaitingUpdateNotice,
} from "./recoveryRoot";

const identity: PromptCloseAllReleaseIdentity = {
  schemaVersion: 1,
  sourceSha: "a".repeat(40),
  buildId: "a".repeat(40),
  variantId: "b".repeat(64),
  releaseRole: "standard",
  requiredDbCompatibilityFingerprint: "c".repeat(64),
  pwaLifecycle: "prompt-close-all-v1",
  roleEntryUrl: "/assets/standard-entry.js",
  roleEntrySha256: "d".repeat(64),
  serviceWorkerUrl: "/sw.js",
  serviceWorkerSha256: "e".repeat(64),
  outerAgentUrl: "/assets/outer-agent.js",
  outerAgentSha256: "f".repeat(64),
};

describe("outer recovery root", () => {
  it("replaces stale UI with a closed diagnostic", () => {
    const root = document.createElement("div");
    root.appendChild(document.createElement("span"));

    renderRecoveryRoot(root, "active-worker-identity-mismatch");

    expect(root.dataset.pwaRecovery).toBe("true");
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.querySelector("h1")).toHaveTextContent(
      "安全のためアプリを起動できませんでした",
    );
    expect(root.querySelector("[data-diagnostic-code]")).toHaveTextContent(
      "active-worker-identity-mismatch",
    );
    expect(root.querySelector("button")).toBeNull();
  });

  it("disables the retry action until its asynchronous check settles", async () => {
    const root = document.createElement("div");
    let resolveCheck: (() => void) | undefined;
    const onCheckForUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    renderRecoveryRoot(root, "registration-read-failed", {
      onCheckForUpdate,
    });
    const button = root.querySelector("button");
    expect(button).not.toBeNull();

    fireEvent.click(button!);
    expect(button).toBeDisabled();
    expect(onCheckForUpdate).toHaveBeenCalledOnce();
    resolveCheck?.();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("renders blockers and then reuses the notice for a clear update", () => {
    const root = document.createElement("div");
    renderWaitingUpdateNotice(root, identity, [
      {
        clientId: "client-a",
        capturedAt: "2026-08-06T00:00:00.000Z",
        responsive: true,
        blockers: [{ id: "save", label: "保存中" }],
        flushError: false,
      },
      {
        clientId: "client-b",
        capturedAt: "2026-08-06T00:00:00.000Z",
        responsive: false,
        blockers: [],
        flushError: true,
      },
    ]);

    const notice = root.querySelector("[data-pwa-update-notice]");
    expect(notice).not.toBeNull();
    expect(notice).toHaveAttribute("data-variant-id", identity.variantId);
    expect(notice?.querySelectorAll("li")).toHaveLength(2);
    expect(notice).toHaveTextContent("保存中 (client-a)");
    expect(notice).toHaveTextContent("応答なし: 1画面");

    renderWaitingUpdateNotice(root, identity, [
      {
        clientId: "client-a",
        capturedAt: "2026-08-06T00:01:00.000Z",
        responsive: true,
        blockers: [],
        flushError: false,
      },
    ]);

    expect(root.querySelector("[data-pwa-update-notice]")).toBe(notice);
    expect(notice?.querySelector("ul")).toBeNull();
    expect(notice).toHaveTextContent("すべてのタブとPWAウィンドウを閉じて");
  });

  it("projects only public identity diagnostics", () => {
    expect(describeIdentityForDiagnostics(identity)).toEqual({
      schemaVersion: 1,
      sourceSha: identity.sourceSha,
      buildId: identity.buildId,
      variantId: identity.variantId,
      releaseRole: "standard",
      pwaLifecycle: "prompt-close-all-v1",
    });
  });
});
