import type {
  PromptCloseAllReleaseIdentity,
  ReleaseIdentity,
} from "../releaseIdentityProtocol";
import type { UpdateBlockerSnapshot } from "./updateBlockerRegistry";

export type WaitingUpdateNoticeOptions =
  | {
      phase: "save-required" | "save-incomplete" | "snapshot-error";
      onSaveAndFlush: () => void | Promise<void>;
    }
  | {
      phase: "ready-to-close";
    };

const clearRoot = (root: HTMLElement): void => {
  while (root.firstChild) root.firstChild.remove();
};

const appendText = (
  parent: HTMLElement,
  tagName: "h1" | "h2" | "p" | "li",
  text: string,
): HTMLElement => {
  const element = document.createElement(tagName);
  element.textContent = text;
  parent.appendChild(element);
  return element;
};

export const renderRecoveryRoot = (
  root: HTMLElement,
  reasonCode: string,
  options: {
    onCheckForUpdate?: () => void | Promise<void>;
  } = {},
): void => {
  clearRoot(root);
  root.dataset.pwaRecovery = "true";
  const section = document.createElement("section");
  section.setAttribute("role", "alert");
  section.setAttribute("aria-labelledby", "pwa-recovery-title");
  const title = appendText(
    section,
    "h1",
    "安全のためアプリを起動できませんでした",
  );
  title.id = "pwa-recovery-title";
  appendText(
    section,
    "p",
    "保存データは変更していません。通信を確認し、更新を再確認してください。",
  );
  const diagnostic = appendText(section, "p", `診断コード: ${reasonCode}`);
  diagnostic.dataset.diagnosticCode = reasonCode;

  if (options.onCheckForUpdate) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "更新を再確認";
    button.addEventListener("click", () => {
      button.disabled = true;
      void Promise.resolve(options.onCheckForUpdate?.()).finally(() => {
        button.disabled = false;
      });
    });
    section.appendChild(button);
  }
  root.appendChild(section);
};

export const renderWaitingUpdateNotice = (
  root: HTMLElement,
  identity: PromptCloseAllReleaseIdentity,
  snapshots: UpdateBlockerSnapshot[],
  options: WaitingUpdateNoticeOptions,
): void => {
  let notice = root.querySelector<HTMLElement>("[data-pwa-update-notice]");
  const previousSaveOperationCount = Number.parseInt(
    notice?.dataset.pwaSaveOperationCount ?? "0",
    10,
  );
  const saveOperationCount =
    Number.isSafeInteger(previousSaveOperationCount) &&
    previousSaveOperationCount >= 0
      ? previousSaveOperationCount
      : 0;
  if (!notice) {
    notice = document.createElement("aside");
    notice.dataset.pwaUpdateNotice = "true";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    root.prepend(notice);
  } else {
    clearRoot(notice);
  }
  notice.setAttribute("aria-busy", "false");
  notice.dataset.saveOperation = "idle";
  notice.dataset.pwaSaveOperationCount = String(saveOperationCount);

  const titles: Record<WaitingUpdateNoticeOptions["phase"], string> = {
    "save-required": "更新を適用する前に保存してください",
    "save-incomplete": "更新前の保存を完了できませんでした",
    "snapshot-error": "更新前の保存状態を確認できません",
    "ready-to-close": "更新の準備ができました",
  };
  appendText(notice, "h2", titles[options.phase]);
  const activeBlockers = snapshots.flatMap((snapshot) =>
    snapshot.blockers.map((blocker) => ({
      clientId: snapshot.clientId,
      ...blocker,
    })),
  );
  const unresponsive = snapshots.filter(
    (snapshot) => !snapshot.responsive,
  ).length;
  const flushFailures = snapshots.filter(
    (snapshot) => snapshot.flushError,
  ).length;
  const hasBlockingState =
    activeBlockers.length > 0 || unresponsive > 0 || flushFailures > 0;

  if (options.phase === "snapshot-error") {
    appendText(
      notice,
      "p",
      "すべての画面の保存状態を確認できないため、閉じる案内には進みません。保存を再試行してください。",
    );
  } else if (hasBlockingState) {
    appendText(
      notice,
      "p",
      "保存待ち、保存失敗、または応答していない画面があります。すべて確認してください。",
    );
  } else if (options.phase === "save-required") {
    appendText(
      notice,
      "p",
      "開いているすべての画面のデータを保存し、更新しても安全か確認します。",
    );
  } else if (options.phase === "save-incomplete" && !hasBlockingState) {
    appendText(
      notice,
      "p",
      "開いている画面から保存完了を確認できませんでした。保存を再試行してください。",
    );
  }

  if (hasBlockingState) {
    const list = document.createElement("ul");
    activeBlockers.forEach((blocker) => {
      appendText(list, "li", `${blocker.label} (${blocker.clientId})`);
    });
    if (unresponsive > 0) {
      appendText(list, "li", `応答なし: ${unresponsive}画面`);
    }
    if (flushFailures > 0) {
      appendText(list, "li", `保存失敗: ${flushFailures}画面`);
    }
    notice.appendChild(list);
  }

  if (options.phase === "ready-to-close") {
    appendText(
      notice,
      "p",
      "保存が完了しました。更新を適用するには、すべてのタブとPWAウィンドウを閉じてください。",
    );
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent =
      options.phase === "save-required" ? "保存して更新準備" : "保存を再試行";
    button.dataset.pwaSaveAndFlush = "true";
    button.dataset.pwaSaveAction =
      options.phase === "save-required" ? "save-and-flush" : "retry";
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      notice.setAttribute("aria-busy", "true");
      notice.dataset.saveOperation = "running";
      notice.dataset.pwaSaveOperationCount = String(
        Number.parseInt(notice.dataset.pwaSaveOperationCount ?? "0", 10) + 1,
      );
      void Promise.resolve()
        .then(() => options.onSaveAndFlush())
        .catch(() => {
          if (!notice.contains(button)) return;
          renderWaitingUpdateNotice(root, identity, snapshots, {
            phase: "snapshot-error",
            onSaveAndFlush: options.onSaveAndFlush,
          });
        })
        .finally(() => {
          if (!notice.contains(button)) return;
          button.disabled = false;
          notice.setAttribute("aria-busy", "false");
          notice.dataset.saveOperation = "idle";
        });
    });
    notice.appendChild(button);
  }
  notice.dataset.variantId = identity.variantId;
  notice.dataset.pwaUpdatePhase = options.phase;
  notice.dataset.pwaSnapshotCount = String(snapshots.length);
  notice.dataset.pwaResponsiveCount = String(snapshots.length - unresponsive);
  notice.dataset.pwaBlockerCount = String(activeBlockers.length);
  notice.dataset.pwaUnresponsiveCount = String(unresponsive);
  notice.dataset.pwaFlushFailureCount = String(flushFailures);
  notice.dataset.pwaCloseGuidance = String(options.phase === "ready-to-close");
};

export const describeIdentityForDiagnostics = (
  identity: ReleaseIdentity,
): Record<string, string | number> => ({
  schemaVersion: identity.schemaVersion,
  sourceSha: identity.sourceSha,
  buildId: identity.buildId,
  variantId: identity.variantId,
  releaseRole: identity.releaseRole,
  pwaLifecycle: identity.pwaLifecycle,
});
