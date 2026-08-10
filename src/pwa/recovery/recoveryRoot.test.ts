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

  it("renders blockers, requires an explicit save, and then shows close-all", () => {
    const root = document.createElement("div");
    const onSaveAndFlush = vi.fn(async () => undefined);
    renderWaitingUpdateNotice(
      root,
      identity,
      [
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
          flushError: false,
        },
        {
          clientId: "client-c",
          capturedAt: "2026-08-06T00:00:00.000Z",
          responsive: true,
          blockers: [],
          flushError: true,
        },
      ],
      {
        phase: "save-required",
        onSaveAndFlush,
      },
    );

    const notice = root.querySelector("[data-pwa-update-notice]");
    expect(notice).not.toBeNull();
    expect(notice).toHaveAttribute("data-variant-id", identity.variantId);
    expect(notice?.querySelectorAll("li")).toHaveLength(3);
    expect(notice).toHaveTextContent("保存中 (client-a)");
    expect(notice).toHaveTextContent("応答なし: 1画面");
    expect(notice).toHaveTextContent("保存失敗: 1画面");
    expect(notice).not.toHaveTextContent("保存が完了しました");
    expect(notice).toHaveAttribute("data-pwa-update-phase", "save-required");
    expect(notice).toHaveAttribute("data-pwa-snapshot-count", "3");
    expect(notice).toHaveAttribute("data-pwa-responsive-count", "2");
    expect(notice).toHaveAttribute("data-pwa-blocker-count", "1");
    expect(notice).toHaveAttribute("data-pwa-unresponsive-count", "1");
    expect(notice).toHaveAttribute("data-pwa-flush-failure-count", "1");
    expect(notice).toHaveAttribute("data-pwa-close-guidance", "false");
    expect(notice).toHaveAttribute("data-pwa-save-operation-count", "0");
    expect(notice?.querySelector("button")).toHaveAttribute(
      "data-pwa-save-action",
      "save-and-flush",
    );
    expect(notice?.querySelector("button")).toHaveTextContent(
      "保存して更新準備",
    );

    renderWaitingUpdateNotice(
      root,
      identity,
      [
        {
          clientId: "client-a",
          capturedAt: "2026-08-06T00:01:00.000Z",
          responsive: true,
          blockers: [],
          flushError: false,
        },
      ],
      { phase: "ready-to-close" },
    );

    expect(root.querySelector("[data-pwa-update-notice]")).toBe(notice);
    expect(notice?.querySelector("ul")).toBeNull();
    expect(notice).toHaveTextContent("すべてのタブとPWAウィンドウを閉じて");
    expect(notice?.querySelector("button")).toBeNull();
    expect(notice).toHaveAttribute("data-pwa-update-phase", "ready-to-close");
    expect(notice).toHaveAttribute("data-pwa-snapshot-count", "1");
    expect(notice).toHaveAttribute("data-pwa-responsive-count", "1");
    expect(notice).toHaveAttribute("data-pwa-blocker-count", "0");
    expect(notice).toHaveAttribute("data-pwa-close-guidance", "true");
    expect(notice).toHaveAttribute("data-pwa-save-operation-count", "0");
  });

  it("disables save while flushing and fails closed when the action rejects", async () => {
    const root = document.createElement("div");
    let rejectSave: ((reason?: unknown) => void) | undefined;
    const onSaveAndFlush = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    renderWaitingUpdateNotice(root, identity, [], {
      phase: "save-required",
      onSaveAndFlush,
    });
    const button = root.querySelector("button");

    fireEvent.click(button!);
    fireEvent.click(button!);
    expect(button).toBeDisabled();
    expect(root.querySelector("[data-pwa-update-notice]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(root.querySelector("[data-pwa-update-notice]")).toHaveAttribute(
      "data-pwa-save-operation-count",
      "1",
    );
    await waitFor(() => expect(onSaveAndFlush).toHaveBeenCalledOnce());
    rejectSave?.(new Error("snapshot unavailable"));

    await waitFor(() =>
      expect(root.querySelector("[data-pwa-update-notice]")).toHaveAttribute(
        "data-pwa-update-phase",
        "snapshot-error",
      ),
    );
    expect(root).not.toHaveTextContent("すべてのタブとPWAウィンドウを閉じて");
    expect(root.querySelector("button")).not.toBeDisabled();
    expect(root.querySelector("[data-pwa-update-notice]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
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
