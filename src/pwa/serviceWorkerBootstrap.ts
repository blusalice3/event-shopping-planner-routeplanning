export type ServiceWorkerRegistrationResult =
  | { status: "unsupported" }
  | { status: "registered"; registration: ServiceWorkerRegistration }
  | { status: "failed"; error: Error };

export const registerPromptCloseAllServiceWorker = async (
  container: ServiceWorkerContainer | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.serviceWorker,
  scriptUrl = "/sw.js",
): Promise<ServiceWorkerRegistrationResult> => {
  if (!container) return { status: "unsupported" };
  try {
    const registration = await container.register(scriptUrl, {
      scope: "/",
      type: "classic",
      updateViaCache: "none",
    });
    return { status: "registered", registration };
  } catch (error) {
    return {
      status: "failed",
      error:
        error instanceof Error
          ? error
          : new Error("Service Worker registration failed."),
    };
  }
};
