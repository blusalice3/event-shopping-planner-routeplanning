import {
  parseCanonicalReleaseIdentity,
  type ReleaseIdentity,
} from "../releaseIdentityProtocol";
import { describeIdentityForDiagnostics } from "../recovery/recoveryRoot";

const appendText = (
  parent: HTMLElement,
  tag: "h1" | "p",
  text: string,
): void => {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.appendChild(element);
};

const readCurrentIdentity = async (): Promise<ReleaseIdentity | null> => {
  try {
    const response = await fetch("/release-identity.json", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    return parseCanonicalReleaseIdentity(await response.text());
  } catch {
    return null;
  }
};

export const mountContainmentRole = async (
  root: HTMLElement = document.getElementById("root") ??
    (() => {
      const created = document.createElement("div");
      created.id = "root";
      document.body.appendChild(created);
      return created;
    })(),
): Promise<void> => {
  root.replaceChildren();
  root.dataset.containmentRole = "true";
  const section = document.createElement("section");
  section.setAttribute("aria-labelledby", "containment-title");
  const heading = document.createElement("h1");
  heading.id = "containment-title";
  heading.textContent = "読み取り専用の復旧モード";
  section.appendChild(heading);
  appendText(
    section,
    "p",
    "この画面は保存データを変更しません。通常版の更新を確認できます。",
  );

  const identity = await readCurrentIdentity();
  if (identity) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(
      describeIdentityForDiagnostics(identity),
      null,
      2,
    );
    section.appendChild(pre);
  }

  const updateButton = document.createElement("button");
  updateButton.type = "button";
  updateButton.textContent = "更新を確認";
  updateButton.addEventListener("click", () => {
    updateButton.disabled = true;
    void navigator.serviceWorker
      ?.getRegistration("/")
      .then((registration) => registration?.update())
      .finally(() => {
        updateButton.disabled = false;
      });
  });
  section.appendChild(updateButton);
  root.appendChild(section);
};

void mountContainmentRole();
