import "./styles/tailwind.css";
import "./styles/global.css";
import { startOuterRecoveryAgent } from "./pwa/recovery/outerRecoveryAgent";
import { renderRecoveryRoot } from "./pwa/recovery/recoveryRoot";
import { registerPromptCloseAllServiceWorker } from "./pwa/serviceWorkerBootstrap";

const ensureRoot = (): HTMLElement =>
  document.getElementById("root") ??
  (() => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
  })();

const bootstrap = async (): Promise<void> => {
  try {
    if (import.meta.env.DEV) {
      await import("./index");
      return;
    }
    const registration = await registerPromptCloseAllServiceWorker();
    if (registration.status === "failed") {
      renderRecoveryRoot(ensureRoot(), "service-worker-registration-failed");
      return;
    }
    await startOuterRecoveryAgent();
  } finally {
    document.getElementById("loading-screen")?.classList.add("hidden");
  }
};

void bootstrap().catch(() => {
  renderRecoveryRoot(ensureRoot(), "outer-agent-unhandled-error");
  document.getElementById("loading-screen")?.classList.add("hidden");
});
