import { startOuterRecoveryAgent } from "./outerRecoveryAgent";
import { renderRecoveryRoot } from "./recoveryRoot";
import { registerPromptCloseAllServiceWorker } from "./serviceWorkerBootstrap";

const ensureRoot = (): HTMLElement =>
  document.getElementById("root") ??
  (() => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
  })();

const loadDevelopmentRole = (): void => {
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/src/index.tsx";
  document.head.appendChild(script);
};

const bootstrapOuterAgent = async (): Promise<void> => {
  try {
    if (import.meta.env.DEV) {
      loadDevelopmentRole();
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

void bootstrapOuterAgent().catch(() => {
  renderRecoveryRoot(ensureRoot(), "outer-agent-unhandled-error");
  document.getElementById("loading-screen")?.classList.add("hidden");
});
