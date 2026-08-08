import type {
  PromptCloseAllReleaseIdentity,
  ReleaseIdentity,
} from "../releaseIdentityProtocol";
import type { UpdateBlockerSnapshot } from "./updateBlockerRegistry";

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
): void => {
  let notice = root.querySelector<HTMLElement>("[data-pwa-update-notice]");
  if (!notice) {
    notice = document.createElement("aside");
    notice.dataset.pwaUpdateNotice = "true";
    notice.setAttribute("role", "status");
    root.prepend(notice);
  } else {
    clearRoot(notice);
  }

  appendText(notice, "h2", "更新の準備ができました");
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

  if (activeBlockers.length > 0 || unresponsive > 0 || flushFailures > 0) {
    appendText(
      notice,
      "p",
      "保存待ち、保存失敗、または応答していない画面があります。すべて確認してください。",
    );
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
  } else {
    appendText(
      notice,
      "p",
      "保存が完了しました。更新を適用するには、すべてのタブとPWAウィンドウを閉じてください。",
    );
  }
  notice.dataset.variantId = identity.variantId;
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
