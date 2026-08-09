import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium as playwrightChromium } from "playwright";
import {
  assertLegacyRollbackCapabilityAbsence,
  assertPromptCloseAllBrowserDrill,
  resolvePromptCloseAllDrillMode,
  resolveRollbackActivationMode,
  resolveRollbackTargetCapabilityMode,
} from "./browser/prompt-close-all-drill-authority.mjs";
import { ServiceWorkerActivationTracker } from "./lib/service-worker-activation-tracker.mjs";

const PREVIEW_URL = process.env.ESP_PREVIEW_URL ?? "http://127.0.0.1:4173/";
const ROLLBACK_MODE = process.env.ESP_ROLLBACK_MODE === "true";
const requestedTransitionMode = process.env.ESP_TRANSITION_MODE?.trim() ?? "";
const TRANSITION_MODE = ROLLBACK_MODE
  ? "rollback"
  : requestedTransitionMode === "rollback" ||
      requestedTransitionMode === "forward"
    ? requestedTransitionMode
    : null;
const PROMPT_CLOSE_DRILL_MODE = resolvePromptCloseAllDrillMode({
  transitionMode: TRANSITION_MODE,
  configuredMode: process.env.ESP_PROMPT_CLOSE_DRILL,
});
const ROLLBACK_TARGET_CAPABILITY_MODE = resolveRollbackTargetCapabilityMode({
  transitionMode: TRANSITION_MODE,
  configuredMode: process.env.ESP_ROLLBACK_TARGET_CAPABILITY,
});
const ROLLBACK_ACTIVATION_MODE = resolveRollbackActivationMode({
  transitionMode: TRANSITION_MODE,
  configuredMode: process.env.ESP_ROLLBACK_ACTIVATION,
});
const ALLOW_DIRTY_BUILD = process.env.ESP_ALLOW_DIRTY_BUILD === "true";
const REQUESTED_PROFILE_DIRECTORY =
  process.env.ESP_BROWSER_PROFILE_DIR?.trim() || null;
const EXPECTED_FROM_ARTIFACT_ID =
  process.env.ESP_EXPECTED_FROM_ARTIFACT_ID?.trim() || null;
const TARGET_ARTIFACT_ID = process.env.ESP_TARGET_ARTIFACT_ID?.trim() || null;
const EXPECTED_TARGET_BUILD_ID =
  process.env.ESP_EXPECTED_TARGET_BUILD_ID?.trim() || null;
const EXPECTED_INDEX_SHA256 =
  process.env.ESP_EXPECTED_INDEX_SHA256?.trim().toLowerCase() || null;
const EXPECTED_SERVICE_WORKER_SHA256 =
  process.env.ESP_EXPECTED_SW_SHA256?.trim().toLowerCase() || null;
const EXPECTED_MAIN_ASSET = process.env.ESP_EXPECTED_MAIN_ASSET?.trim() || null;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  playwrightChromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const METRICS_STORAGE_KEY = "__esp_internal__:release-a-metrics:v1";
const ARTIFACT_MARKER_FILE_NAME = "esp-active-artifact-marker-v1.txt";
const LEGACY_DELETE_COUNT_KEY =
  "__esp_internal__:browser-test:legacy-delete-count:v1";
const CONTROLLER_CHANGE_COUNT_KEY =
  "__esp_internal__:browser-test:controller-change-count:v1";
const PWA_UPDATE_PROBE_STATE_KEY =
  "__esp_internal__:browser-test:pwa-update-probe-state:v1";
const PWA_UPDATE_PROBE_TRACE_KEY =
  "__esp_internal__:browser-test:pwa-update-probe-trace:v1";
const ROLLBACK_SAVE_EVENT_NAME = "RELEASE_A_ROLLBACK_SAVE";
const PROMPT_CLOSE_ITEM_TITLE = "Prompt Close Saved Item";
const PROMPT_CLOSE_AUTOSAVE_ARM_REMARK = "PWA autosave blocker armed";
const PROMPT_CLOSE_AUTOSAVE_REMARK = "PWA save-flush evidence";
const SYNTHETIC_METADATA =
  '{"A10_FIXTURE":{"title":"synthetic-event","phase":"release-a-browser"}}';
const SYNTHETIC_SYNC_QUEUE =
  '{"pending":[{"id":"synthetic-operation","kind":"archive-only"}]}';
const SYNTHETIC_LEGACY_SOURCES = Object.freeze({
  eventShoppingLists:
    '{"A10_FIXTURE":[{"id":"synthetic-item","title":"synthetic-item"}]}',
  eventMetadata: SYNTHETIC_METADATA,
  executeModeItems: "{}",
  dayModes: "{}",
  mapData: "{}",
  mapRotationSettings: "{}",
  routeSettings: "{}",
  hallDefinitions: "{}",
  hallRouteSettings: "{}",
  mapViewportSettings: "{}",
  syncQueue: SYNTHETIC_SYNC_QUEUE,
});

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256Text = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const createExpectedLegacyFixtureEvidence = () => ({
  legacySources: Object.fromEntries(
    Object.entries(SYNTHETIC_LEGACY_SOURCES).map(([key, value]) => [
      key,
      {
        present: true,
        length: value.length,
        hash: sha256Text(value),
      },
    ]),
  ),
  metadataLength: SYNTHETIC_METADATA.length,
  metadataHash: sha256Text(SYNTHETIC_METADATA),
  syncQueueLength: SYNTHETIC_SYNC_QUEUE.length,
  syncQueueHash: sha256Text(SYNTHETIC_SYNC_QUEUE),
});

const withTimeout = (promise, milliseconds, label) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms.`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });

const findChrome = async () => {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next known Chromium installation.
    }
  }
  throw new Error(
    "A Playwright Chromium, Chrome, or Edge executable was not found. Set CHROME_PATH to a Chromium executable.",
  );
};

class PlaywrightPageClient {
  constructor(session) {
    this.session = session;
  }

  send(method, params = {}) {
    return withTimeout(
      this.session.send(method, params),
      30_000,
      `CDP ${method}`,
    );
  }

  once(method, timeoutMs = 15_000) {
    let listener;
    const event = new Promise((resolve) => {
      listener = (params) => resolve(params);
      this.session.once(method, listener);
    });
    return withTimeout(event, timeoutMs, method).finally(() => {
      if (listener) this.session.off(method, listener);
    });
  }

  on(method, listener) {
    this.session.on(method, listener);
    return () => this.session.off(method, listener);
  }

  async close() {
    await this.session.detach().catch(() => undefined);
  }
}

const createTarget = async (context, existingPage = null) => {
  const page = existingPage ?? (await context.newPage());
  const client = new PlaywrightPageClient(await context.newCDPSession(page));
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable"),
  ]);
  return { page, client };
};

const closeTarget = async (target) => {
  await target.client.close();
  await target.page.close({ runBeforeUnload: false }).catch(() => undefined);
};

const selectUniqueStandaloneStartupPage = async (
  context,
  timeoutMs = 15_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let observations = [];
  while (Date.now() < deadline) {
    const pages = context.pages();
    observations = await Promise.all(
      pages.map(async (page) => {
        try {
          return {
            page,
            url: page.url(),
            standalone: await page.evaluate(
              () => matchMedia("(display-mode: standalone)").matches,
            ),
          };
        } catch {
          return { page, url: page.url(), standalone: false };
        }
      }),
    );
    const candidates = observations.filter(({ standalone }) => standalone);
    if (candidates.length > 1) {
      throw new Error("Chromium exposed multiple standalone startup pages.");
    }
    if (candidates.length === 1) {
      const selected = candidates[0].page;
      for (const observation of observations) {
        if (observation.page !== selected) {
          await observation.page
            .close({ runBeforeUnload: false })
            .catch(() => undefined);
        }
      }
      return selected;
    }
    await delay(100);
  }
  throw new Error(
    `A unique standalone startup page was not observed: ${JSON.stringify(
      observations.map(({ url, standalone }) => ({ url, standalone })),
    )}`,
  );
};

const installBrowserInstrumentation = async (
  client,
  pwaUpdateProbeMode = "none",
) => {
  assert(
    ["none", "save-blocker", "trace-only"].includes(pwaUpdateProbeMode),
    "PWA update probe mode is invalid.",
  );
  const source = `(() => {
    const legacyKeys = new Set(${JSON.stringify(
      Object.keys(SYNTHETIC_LEGACY_SOURCES),
    )});
    const deleteCountKey = ${JSON.stringify(LEGACY_DELETE_COUNT_KEY)};
    const controllerChangeCountKey = ${JSON.stringify(
      CONTROLLER_CHANGE_COUNT_KEY,
    )};
    const pwaUpdateProbeMode = ${JSON.stringify(pwaUpdateProbeMode)};
    const pwaUpdateProbeStateKey = ${JSON.stringify(
      PWA_UPDATE_PROBE_STATE_KEY,
    )};
    const pwaUpdateProbeTraceKey = ${JSON.stringify(
      PWA_UPDATE_PROBE_TRACE_KEY,
    )};
    const readCounter = (key) => {
      try {
        const value = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
      } catch {
        return 0;
      }
    };
    const writeCounter = (key, value) => {
      try {
        sessionStorage.setItem(key, String(value));
      } catch {
        // Browser evidence is best effort; the verifier will fail if unavailable.
      }
    };
    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function instrumentedRemoveItem(key) {
      if (this === globalThis.localStorage && legacyKeys.has(String(key))) {
        writeCounter(deleteCountKey, readCounter(deleteCountKey) + 1);
      }
      return originalRemoveItem.call(this, key);
    };
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      writeCounter(
        controllerChangeCountKey,
        readCounter(controllerChangeCountKey) + 1,
      );
    });
    const emptyPwaUpdateTrace = () => ({
      inspectionCount: 0,
      flushCount: 0,
      productionInspectionCount: 0,
      productionFlushCount: 0,
      productionFlushResponseCount: 0,
      productionCleanFlushResponseCount: 0,
    });
    const readPwaUpdateTrace = () => {
      try {
        const parsed = JSON.parse(
          sessionStorage.getItem(pwaUpdateProbeTraceKey) ?? "{}",
        );
        const trace = emptyPwaUpdateTrace();
        for (const key of Object.keys(trace)) {
          if (Number.isSafeInteger(parsed[key]) && parsed[key] >= 0) {
            trace[key] = parsed[key];
          }
        }
        return trace;
      } catch {
        return emptyPwaUpdateTrace();
      }
    };
    const writePwaUpdateTrace = (trace) => {
      sessionStorage.setItem(pwaUpdateProbeTraceKey, JSON.stringify(trace));
    };
    const pendingProductionFlushRequestIds = new Set();
    globalThis.addEventListener("message", (event) => {
      if (
        pwaUpdateProbeMode === "none" ||
        event.source !== globalThis ||
        event.origin !== globalThis.location.origin ||
        sessionStorage.getItem(pwaUpdateProbeStateKey) !== "armed" ||
        typeof event.data !== "object" ||
        event.data === null
      ) {
        return;
      }
      const value = event.data;
      if (
        value.type === "ESP_PWA_ROLE_BLOCKER_SNAPSHOT_REQUEST" &&
        value.protocolVersion === 1 &&
        typeof value.requestId === "string" &&
        typeof value.flush === "boolean"
      ) {
        const trace = readPwaUpdateTrace();
        if (value.flush) {
          trace.productionFlushCount += 1;
          pendingProductionFlushRequestIds.add(value.requestId);
        } else {
          trace.productionInspectionCount += 1;
        }
        writePwaUpdateTrace(trace);
        return;
      }
      if (
        value.type !== "ESP_PWA_ROLE_BLOCKER_SNAPSHOT_RESPONSE" ||
        value.protocolVersion !== 1 ||
        typeof value.requestId !== "string" ||
        !pendingProductionFlushRequestIds.delete(value.requestId)
      ) {
        return;
      }
      const trace = readPwaUpdateTrace();
      trace.productionFlushResponseCount += 1;
      if (
        typeof value.snapshot === "object" &&
        value.snapshot !== null &&
        value.snapshot.responsive === true &&
        value.snapshot.flushError === false &&
        Array.isArray(value.snapshot.blockers) &&
        value.snapshot.blockers.length === 0
      ) {
        trace.productionCleanFlushResponseCount += 1;
      }
      writePwaUpdateTrace(trace);
    });
    navigator.serviceWorker?.addEventListener("message", (event) => {
      const request = event.data;
      let probeState = null;
      try {
        probeState = sessionStorage.getItem(pwaUpdateProbeStateKey);
      } catch {
        return;
      }
      if (
        pwaUpdateProbeMode === "none" ||
        probeState !== "armed" ||
        typeof request !== "object" ||
        request === null ||
        request.type !== "PWA_BLOCKER_SNAPSHOT_REQUEST" ||
        request.protocolVersion !== 1 ||
        typeof request.requestId !== "string" ||
        typeof request.clientId !== "string" ||
        typeof request.flush !== "boolean"
      ) {
        return;
      }
      const trace = readPwaUpdateTrace();
      if (request.flush) trace.flushCount += 1;
      else trace.inspectionCount += 1;
      writePwaUpdateTrace(trace);
      if (pwaUpdateProbeMode === "trace-only") return;
      if (request.flush) return;
      event.stopImmediatePropagation();
      const response = {
        type: "PWA_BLOCKER_SNAPSHOT_RESPONSE",
        protocolVersion: 1,
        requestId: request.requestId,
        snapshot: {
          clientId: request.clientId,
          capturedAt: new Date().toISOString(),
          responsive: true,
          blockers: [
            {
              id: "release-a-managed-save",
              label: "更新前の保存テスト",
            },
          ],
          flushError: false,
        },
      };
      const target = event.source ?? navigator.serviceWorker.controller;
      target?.postMessage(response);
    });
  })();`;
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source });
};

const collectBrowserInstrumentationEvidence = async (client) =>
  await evaluate(
    client,
    `(() => {
      const readCounter = (key) => {
        try {
          const value = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
          return Number.isSafeInteger(value) && value >= 0 ? value : -1;
        } catch {
          return -1;
        }
      };
      return {
        legacyDeleteCount: readCounter(${JSON.stringify(
          LEGACY_DELETE_COUNT_KEY,
        )}),
        controllerChangeCount: readCounter(${JSON.stringify(
          CONTROLLER_CHANGE_COUNT_KEY,
        )}),
      };
    })()`,
  );

const navigate = async (client, url) => {
  const loaded = client.once("Page.loadEventFired");
  const navigation = await client.send("Page.navigate", { url });
  if (navigation.errorText) {
    throw new Error(`Navigation failed: ${navigation.errorText}`);
  }
  await loaded;
};

const reload = async (client) => {
  const loaded = client.once("Page.loadEventFired", 20_000);
  await client.send("Page.reload", { ignoreCache: false });
  await loaded;
};

const evaluate = async (client, expression) => {
  let response;
  try {
    response = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
  } catch (error) {
    const expressionLabel = expression
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    throw new Error(
      `${error instanceof Error ? error.message : "Browser evaluation failed."} Expression: ${expressionLabel}`,
    );
  }
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser evaluation failed.",
    );
  }
  return response.result?.value;
};

const waitForExpression = async (
  client,
  expression,
  label,
  timeoutMs = 20_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} was not observed.${lastError ? ` ${lastError.message}` : ""}`,
  );
};

const armPwaUpdateProbe = async (client) =>
  await evaluate(
    client,
    `(() => {
      sessionStorage.setItem(
        ${JSON.stringify(PWA_UPDATE_PROBE_STATE_KEY)},
        "armed",
      );
      sessionStorage.setItem(
        ${JSON.stringify(PWA_UPDATE_PROBE_TRACE_KEY)},
        JSON.stringify({
          inspectionCount: 0,
          flushCount: 0,
          productionInspectionCount: 0,
          productionFlushCount: 0,
          productionFlushResponseCount: 0,
          productionCleanFlushResponseCount: 0,
        }),
      );
      return true;
    })()`,
  );

const collectPromptCloseAllUiEvidence = async (client) =>
  await evaluate(
    client,
    `(() => (async () => {
      const notice = document.querySelector("[data-pwa-update-notice]");
      const action = notice?.querySelector("[data-pwa-save-and-flush]");
      const count = (name) => {
        const value = Number.parseInt(notice?.dataset[name] ?? "-1", 10);
        return Number.isSafeInteger(value) && value >= 0 ? value : -1;
      };
      const trace = (() => {
        try {
          const value = JSON.parse(
            sessionStorage.getItem(
              ${JSON.stringify(PWA_UPDATE_PROBE_TRACE_KEY)},
            ) ?? "{}",
          );
          const readCount = (key) =>
            Number.isSafeInteger(value[key]) && value[key] >= 0
              ? value[key]
              : -1;
          return {
            inspectionCount: readCount("inspectionCount"),
            flushCount: readCount("flushCount"),
            productionInspectionCount: readCount(
              "productionInspectionCount",
            ),
            productionFlushCount: readCount("productionFlushCount"),
            productionFlushResponseCount: readCount(
              "productionFlushResponseCount",
            ),
            productionCleanFlushResponseCount: readCount(
              "productionCleanFlushResponseCount",
            ),
          };
        } catch {
          return {
            inspectionCount: -1,
            flushCount: -1,
            productionInspectionCount: -1,
            productionFlushCount: -1,
            productionFlushResponseCount: -1,
            productionCleanFlushResponseCount: -1,
          };
        }
      })();
      const registration = await navigator.serviceWorker.getRegistration();
      const controllerChangeCount = Number.parseInt(
        sessionStorage.getItem(
          ${JSON.stringify(CONTROLLER_CHANGE_COUNT_KEY)},
        ) ?? "0",
        10,
      );
      return {
        phase: notice?.dataset.pwaUpdatePhase ?? null,
        snapshotCount: count("pwaSnapshotCount"),
        responsiveCount: count("pwaResponsiveCount"),
        blockerCount: count("pwaBlockerCount"),
        unresponsiveCount: count("pwaUnresponsiveCount"),
        flushFailureCount: count("pwaFlushFailureCount"),
        saveOperationCount: count("pwaSaveOperationCount"),
        saveOperation: notice?.dataset.saveOperation ?? null,
        action: action?.dataset.pwaSaveAction ?? null,
        actionVisible: Boolean(action),
        closeGuidanceVisible:
          notice?.dataset.pwaCloseGuidance === "true",
        activeState: registration?.active?.state ?? null,
        waitingState: registration?.waiting?.state ?? null,
        controllerState: navigator.serviceWorker.controller?.state ?? null,
        controllerScriptUrl:
          navigator.serviceWorker.controller?.scriptURL ?? null,
        controllerChangeCount:
          Number.isSafeInteger(controllerChangeCount) &&
          controllerChangeCount >= 0
            ? controllerChangeCount
            : -1,
        snapshotRequests: trace,
      };
    })())()`,
  );

const waitForPromptCloseAllPhase = async (
  client,
  phase,
  label,
  timeoutMs = 20_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastEvidence = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastEvidence = await collectPromptCloseAllUiEvidence(client);
      lastError = null;
      if (lastEvidence.phase === phase) return lastEvidence;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `${label} was not observed: ${JSON.stringify({
      expectedPhase: phase,
      lastEvidence,
      lastError,
    })}`,
  );
};

const requestProductionEventAutosaveSnapshot = async (client, flush) =>
  await evaluate(
    client,
    `(() => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const clientId = "release-a-primary-production-bridge";
      const timeout = setTimeout(() => {
        globalThis.removeEventListener("message", onMessage);
        reject(new Error("Production role blocker inspection timed out."));
      }, 1_500);
      const onMessage = (event) => {
        if (
          event.source !== globalThis ||
          event.origin !== globalThis.location.origin ||
          typeof event.data !== "object" ||
          event.data === null ||
          event.data.type !== "ESP_PWA_ROLE_BLOCKER_SNAPSHOT_RESPONSE" ||
          event.data.protocolVersion !== 1 ||
          event.data.requestId !== requestId
        ) {
          return;
        }
        clearTimeout(timeout);
        globalThis.removeEventListener("message", onMessage);
        const snapshot = event.data.snapshot;
        const eventAutosave = Array.isArray(snapshot?.blockers)
          ? snapshot.blockers.find(
              (blocker) =>
                blocker?.id === "event-autosave" &&
                blocker?.label === "イベントを保存中",
            )
          : null;
        resolve({
          responsive: snapshot?.responsive === true,
          flushError: snapshot?.flushError === true,
          blockerCount: Array.isArray(snapshot?.blockers)
            ? snapshot.blockers.length
            : -1,
          eventAutosaveObserved: Boolean(eventAutosave),
        });
      };
      globalThis.addEventListener("message", onMessage);
      globalThis.postMessage(
        {
          type: "ESP_PWA_ROLE_BLOCKER_SNAPSHOT_REQUEST",
          protocolVersion: 1,
          requestId,
          clientId,
          flush: ${JSON.stringify(flush)},
        },
        globalThis.location.origin,
      );
    }))()`,
  );

const inspectProductionEventAutosaveBlocker = async (client) =>
  requestProductionEventAutosaveSnapshot(client, false);

const flushProductionEventAutosave = async (client) =>
  requestProductionEventAutosaveSnapshot(client, true);

const waitForProductionEventAutosaveBlocker = async (
  client,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let evidence = null;
  while (Date.now() < deadline) {
    evidence = await inspectProductionEventAutosaveBlocker(client);
    if (
      evidence.responsive === true &&
      evidence.flushError === false &&
      evidence.blockerCount >= 1 &&
      evidence.eventAutosaveObserved === true
    ) {
      return evidence;
    }
    await delay(100);
  }
  throw new Error(
    `Production event-autosave blocker was not observed: ${JSON.stringify(
      evidence,
    )}`,
  );
};

class AttachedServiceWorkerClient {
  constructor(browserSession, sessionId) {
    this.browserSession = browserSession;
    this.sessionId = sessionId;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.handleMessage = (event) => {
      if (event.sessionId !== this.sessionId) return;
      const message = JSON.parse(event.message);
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              `${message.error.message ?? "Service Worker CDP command failed"} (${message.error.code ?? "unknown"})`,
            ),
          );
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }

      const listeners = this.listeners.get(message.method);
      listeners?.forEach((listener) => listener(message.params ?? {}));
    };
    browserSession.on("Target.receivedMessageFromTarget", this.handleMessage);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.browserSession
          .send("Target.sendMessageToTarget", {
            sessionId: this.sessionId,
            message: JSON.stringify({ id, method, params }),
          })
          .catch((error) => {
            this.pending.delete(id);
            reject(error);
          });
      }),
      30_000,
      `Service Worker CDP ${method}`,
    ).finally(() => {
      this.pending.delete(id);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  async close() {
    this.browserSession.off(
      "Target.receivedMessageFromTarget",
      this.handleMessage,
    );
    const closeError = new Error("Service Worker CDP session closed.");
    this.pending.forEach(({ reject }) => reject(closeError));
    this.pending.clear();
    await this.browserSession
      .send("Target.detachFromTarget", { sessionId: this.sessionId })
      .catch(() => undefined);
  }
}

const attachServiceWorkerTarget = async (browserSession, targetId) => {
  // Playwright has no public API for reading the exact running worker source.
  // Keep this protocol adapter scoped to that evidence only; all browser/page
  // lifecycle and ordinary CDP commands remain owned by Playwright.
  const { sessionId } = await browserSession.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  return new AttachedServiceWorkerClient(browserSession, sessionId);
};

const collectActiveServiceWorkerSourceEvidence = async (
  browserSession,
  serviceWorkerUrl,
) => {
  let lastError;
  await browserSession.send("Target.setDiscoverTargets", { discover: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { targetInfos } = await browserSession.send("Target.getTargets");
      const workerTargets = targetInfos
        .filter(
          ({ type, url }) =>
            type === "service_worker" && url === serviceWorkerUrl,
        )
        .reverse();
      for (const workerTarget of workerTargets) {
        const workerClient = await attachServiceWorkerTarget(
          browserSession,
          workerTarget.targetId,
        );
        try {
          const parsedScripts = [];
          const unsubscribe = workerClient.on(
            "Debugger.scriptParsed",
            (script) => {
              parsedScripts.push(script);
            },
          );
          await workerClient.send("Debugger.enable");
          await delay(100);
          unsubscribe();
          const serviceWorkerScript = parsedScripts.find(
            ({ url }) => url === serviceWorkerUrl,
          );
          if (!serviceWorkerScript) continue;
          const { scriptSource } = await workerClient.send(
            "Debugger.getScriptSource",
            {
              scriptId: serviceWorkerScript.scriptId,
            },
          );
          if (typeof scriptSource !== "string" || scriptSource.length === 0) {
            continue;
          }
          return {
            byteLength: Buffer.byteLength(scriptSource, "utf8"),
            sha256: sha256Text(scriptSource),
          };
        } finally {
          await workerClient.close();
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Active Service Worker source could not be inspected.${
      lastError ? ` ${lastError.message}` : ""
    }`,
  );
};

const waitForNaturalServiceWorkerActivation = async (
  pageClient,
  serviceWorkerUrl,
  requestUpdate,
  prepareClientsForRelease,
  releaseClients,
  reopenClients,
  timeoutMs = 20_000,
) => {
  const tracker = new ServiceWorkerActivationTracker(serviceWorkerUrl);
  const waitForTrackedState = async (predicate, label, deadline) => {
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await delay(100);
    }
    throw new Error(
      `${label} was not observed. Tracker: ${JSON.stringify(tracker.describe())}`,
    );
  };

  const unsubscribe = pageClient.on(
    "ServiceWorker.workerVersionUpdated",
    (event) => tracker.observe(event),
  );
  try {
    await pageClient.send("ServiceWorker.enable");
    await waitForTrackedState(
      () => tracker.isBaselineReady(),
      "stable Service Worker baseline",
      Date.now() + timeoutMs,
    );
    const baselineVersionIds = tracker.freezeBaselineVersionIds();
    const updateEvidence = await requestUpdate();
    const waitingVersionId = await waitForTrackedState(
      () => tracker.getNewInstalledVersionId(),
      "installed waiting Service Worker",
      Date.now() + timeoutMs,
    );
    const promptCloseAllEvidence = prepareClientsForRelease
      ? await prepareClientsForRelease({
          waitingVersionId,
          baselineVersionIds,
          updateEvidence,
        })
      : null;
    if (promptCloseAllEvidence) {
      assert(
        tracker.getNewInstalledVersionId() === waitingVersionId,
        "Target Service Worker changed before every client was ready to close.",
      );
    }
    tracker.markClientsReleaseStarted(waitingVersionId);
    const releaseEvidence = await releaseClients();
    await waitForTrackedState(
      () => tracker.isNaturalActivationComplete(),
      "natural Service Worker activation",
      Date.now() + timeoutMs,
    );
    const reopenEvidence = await reopenClients();
    const reopenedAt = Date.now();
    await waitForTrackedState(
      () =>
        Date.now() - reopenedAt >= 300 && tracker.isNaturalActivationComplete(),
      "stable Service Worker activation after client reopen",
      Date.now() + timeoutMs,
    );
    const result = {
      versionId: waitingVersionId,
      baselineVersionIds,
      updateEvidence,
      reopenEvidence,
      ...releaseEvidence,
    };
    if (promptCloseAllEvidence) {
      result.promptCloseAll = {
        ...promptCloseAllEvidence,
        release: {
          ...releaseEvidence,
          startedAfterReadyToClose: true,
        },
        naturalActivation: {
          outcome: "natural-after-all-clients-closed",
          versionId: waitingVersionId,
          stableAfterReopen: true,
          reopenedClientCount: Object.keys(reopenEvidence).length,
        },
      };
    }
    return result;
  } finally {
    unsubscribe();
    await pageClient.send("ServiceWorker.disable").catch(() => undefined);
  }
};

const requestTargetServiceWorkerUpdate = async (client) =>
  evaluate(
    client,
    `(() => (async () => {
      const previousRegistration =
        await navigator.serviceWorker.getRegistration();
      if (!previousRegistration) {
        throw new Error("Existing Service Worker registration is missing.");
      }
      const previousInstalling = previousRegistration.installing;
      const previousWaiting = previousRegistration.waiting;
      let updateFoundCount = 0;
      const onUpdateFound = () => {
        updateFoundCount += 1;
      };
      previousRegistration.addEventListener("updatefound", onUpdateFound);
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          type: "classic",
          updateViaCache: "none",
        });
        const candidate = await new Promise((resolve, reject) => {
          const deadline = Date.now() + 15_000;
          const inspect = () => {
            const installing = registration.installing;
            const waiting = registration.waiting;
            if (installing && installing !== previousInstalling) {
              resolve(installing);
              return;
            }
            if (waiting && waiting !== previousWaiting) {
              resolve(waiting);
              return;
            }
            if (Date.now() >= deadline) {
              reject(
                new Error("New target Service Worker candidate was not observed."),
              );
              return;
            }
            setTimeout(inspect, 50);
          };
          inspect();
        });
        await new Promise((resolve, reject) => {
          let timeout;
          const finish = (error) => {
            clearTimeout(timeout);
            candidate.removeEventListener("statechange", inspect);
            if (error) reject(error);
            else resolve();
          };
          const inspect = () => {
            if (candidate.state === "installed") {
              finish();
            } else if (
              candidate.state === "activating" ||
              candidate.state === "activated" ||
              candidate.state === "redundant"
            ) {
              finish(
                new Error(
                  "Target Service Worker reached " +
                    candidate.state +
                    " before client release.",
                ),
              );
            }
          };
          candidate.addEventListener("statechange", inspect);
          timeout = setTimeout(
            () => finish(new Error("Target Service Worker install timed out.")),
            15_000,
          );
          inspect();
        });
        return {
          candidateState: candidate.state,
          candidateScriptUrl: candidate.scriptURL,
          hadPreviousWaiting: previousWaiting !== null,
          updateFoundCount,
        };
      } finally {
        previousRegistration.removeEventListener("updatefound", onUpdateFound);
      }
    })())`,
  );

const waitForControlledApplication = async (client) => {
  await evaluate(client, "navigator.serviceWorker.ready.then(() => true)");
  await waitForExpression(
    client,
    "Boolean(navigator.serviceWorker.controller)",
    "active Service Worker controller",
  );
  await waitForExpression(
    client,
    "Boolean(document.querySelector('#root')?.childElementCount)",
    "rendered application root",
  );
};

const ensureControlledApplication = async (client) => {
  await evaluate(client, "navigator.serviceWorker.ready.then(() => true)");
  await reload(client);
  await waitForControlledApplication(client);
};

const waitForReleaseAStartupMetric = async (client) => {
  await waitForExpression(
    client,
    `(() => {
      try {
        const metrics = JSON.parse(
          sessionStorage.getItem(${JSON.stringify(METRICS_STORAGE_KEY)}) ??
            "null",
        );
        return (metrics?.counters?.startup?.ready ?? 0) >= 1;
      } catch {
        return false;
      }
    })()`,
    "Release A startup metric",
  );
};

const collectOnlineProbe = async (client) =>
  await evaluate(
    client,
    `(async () => {
      const capability = await fetch("/release-capabilities.json", {
        cache: "no-store",
      }).then((response) => response.json());
      const manifest = await fetch("/manifest.webmanifest", {
        cache: "no-store",
      }).then((response) => response.json());
      const registration = await navigator.serviceWorker.ready;
      const serviceWorkerSource = await fetch(registration.active.scriptURL, {
        cache: "no-store",
      }).then((response) => response.text());
      const mainScript = [...document.scripts]
        .map((script) => script.src)
        .find((source) =>
          /\\/assets\\/(?:index-[^/]+|release-role)\\.js$/.test(source),
        );
      const metrics = JSON.parse(
        sessionStorage.getItem(${JSON.stringify(METRICS_STORAGE_KEY)}) ?? "null",
      );
      return {
        secureContext: window.isSecureContext,
        buildMode: capability.buildMode,
        buildId: capability.buildId,
        sourceSha: capability.sourceSha,
        sourceState: capability.sourceState,
        releaseChannel: capability.releaseChannel,
        cleanupCapability: capability.legacyLocalStorageCleanup,
        appBuildId:
          document.querySelector(
            'meta[name="event-shopping-planner-build-id"]',
          )?.content ?? null,
        serviceWorkerHasBuildId: serviceWorkerSource.includes(
          "release-capabilities." + capability.buildId + ".json",
        ),
        serviceWorkerScriptUrl: registration.active?.scriptURL ?? null,
        manifestDisplay: manifest.display,
        manifestStartUrl: manifest.start_url,
        controlled: Boolean(navigator.serviceWorker.controller),
        activeState: registration.active?.state ?? null,
        waiting: Boolean(registration.waiting),
        installing: Boolean(registration.installing),
        mainAssetCached: Boolean(mainScript && (await caches.match(mainScript))),
        mainScriptPath: mainScript ? new URL(mainScript).pathname : null,
        recoveryVisible: [...document.querySelectorAll("h1, h2")].some(
          (heading) =>
            heading.textContent?.includes("保存データを安全に読み込めません"),
        ),
        startupReadyCount: metrics?.counters?.startup?.ready ?? 0,
      };
    })()`,
  );

const installSyntheticLegacyFixture = async (client) =>
  await evaluate(
    client,
    `(async () => {
      const legacySources = ${JSON.stringify(SYNTHETIC_LEGACY_SOURCES)};
      for (const [key, value] of Object.entries(legacySources)) {
        localStorage.setItem(key, value);
      }
      const hash = async (value) => {
        const bytes = new TextEncoder().encode(value);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      };
      const legacySourceEvidence = {};
      for (const [key, value] of Object.entries(legacySources)) {
        legacySourceEvidence[key] = {
          present: true,
          length: value.length,
          hash: await hash(value),
        };
      }
      const metadata = legacySources.eventMetadata;
      const syncQueue = legacySources.syncQueue;
      return {
        legacySources: legacySourceEvidence,
        metadataLength: metadata.length,
        metadataHash: await hash(metadata),
        syncQueueLength: syncQueue.length,
        syncQueueHash: await hash(syncQueue),
      };
    })()`,
  );

const collectFixtureEvidence = async (client) =>
  await evaluate(
    client,
    `(async () => {
      const legacySourceKeys = ${JSON.stringify(
        Object.keys(SYNTHETIC_LEGACY_SOURCES),
      )};
      const metadata = localStorage.getItem("eventMetadata");
      const syncQueue = localStorage.getItem("syncQueue");
      const hash = async (value) => {
        const bytes = new TextEncoder().encode(value ?? "");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      };
      const legacySourceEvidence = {};
      const rawValues = {};
      for (const key of legacySourceKeys) {
        const value = localStorage.getItem(key);
        rawValues[key] = value;
        legacySourceEvidence[key] = {
          present: value !== null,
          length: value?.length ?? 0,
          hash: await hash(value),
        };
      }
      return {
        legacySources: legacySourceEvidence,
        rawValues,
        metadataPresent: metadata !== null,
        metadataLength: metadata?.length ?? 0,
        metadataHash: await hash(metadata),
        syncQueuePresent: syncQueue !== null,
        syncQueueLength: syncQueue?.length ?? 0,
        syncQueueHash: await hash(syncQueue),
        protectedStatusVisible: Boolean(
          document.querySelector(
            '[aria-label="保存済み・旧データ保全中"]',
          ),
        ),
        rendered: Boolean(document.querySelector("#root")?.childElementCount),
      };
    })()`,
  );

const collectRollbackDatabaseEvidence = async (client) =>
  await evaluate(
    client,
    `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("EventShoppingPlannerDB");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        const transaction = database.transaction(
          [...database.objectStoreNames],
          "readonly",
        );
        const read = (storeName, key) =>
          new Promise((resolve, reject) => {
            const request = transaction.objectStore(storeName).get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          });
        const journal = await read(
          "syncQueue",
          "__esp_internal__:migration:v1:legacy-local-storage",
        );
        const archive = journal?.archiveKey
          ? await read("syncQueue", journal.archiveKey)
          : null;
        const eventMetadataCheckpoint = await read(
          "syncQueue",
          "__esp_internal__:checkpoint:v1:eventMetadata:data",
        );
        const eventLists = await read("eventLists", "data");
        const syncQueuePayload = await read("syncQueue", "data");
        const stores = [...database.objectStoreNames]
          .map((name) => {
            const store = transaction.objectStore(name);
            return {
              name,
              keyPath: store.keyPath,
              indexes: [...store.indexNames].sort(),
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name));
        return {
          dbVersion: database.version,
          databaseName: database.name,
          stores,
          journalSchemaVersion: journal?.schemaVersion ?? null,
          journalPhase: journal?.phase ?? null,
          journalDataMigrationStatus: journal?.dataMigrationStatus ?? null,
          journalEntries: journal?.entries?.length ?? null,
          archiveSchemaVersion: archive?.schemaVersion ?? null,
          archivedSyncQueue: Boolean(
            archive?.entries?.some(
              (entry) =>
                entry.sourceKind === "preserved-legacy-sync-queue",
            ),
          ),
          checkpoint: {
            kind: eventMetadataCheckpoint?.kind ?? null,
            version: eventMetadataCheckpoint?.version ?? null,
            storeName: eventMetadataCheckpoint?.storeName ?? null,
            key: eventMetadataCheckpoint?.key ?? null,
            committedRevisionPresent:
              typeof eventMetadataCheckpoint?.committedRoot?.revision ===
                "string" &&
              eventMetadataCheckpoint.committedRoot.revision.length > 0,
            digestAlgorithm:
              eventMetadataCheckpoint?.committedRoot?.digest?.algorithm ?? null,
            absorbedCandidateCount:
              eventMetadataCheckpoint?.absorbedCandidates?.length ?? null,
          },
          rollbackSavedEvent: {
            present: Array.isArray(eventLists?.[${JSON.stringify(
              ROLLBACK_SAVE_EVENT_NAME,
            )}]),
            itemCount: Array.isArray(eventLists?.[${JSON.stringify(
              ROLLBACK_SAVE_EVENT_NAME,
            )}])
              ? eventLists[${JSON.stringify(ROLLBACK_SAVE_EVENT_NAME)}].length
              : 0,
          },
          raw: {
            archive,
            checkpoint: eventMetadataCheckpoint,
            journal,
            syncQueuePayload,
          },
        };
      } finally {
        database.close();
      }
    })()`,
  );

const readArtifactMarker = async () => {
  try {
    return (
      await readFile(path.join(profileDirectory, ARTIFACT_MARKER_FILE_NAME), {
        encoding: "utf8",
      })
    ).trim();
  } catch {
    return null;
  }
};

const writeArtifactMarker = async (artifactId) => {
  const markerPath = path.join(profileDirectory, ARTIFACT_MARKER_FILE_NAME);
  await writeFile(markerPath, `${artifactId}\n`, { encoding: "utf8" });
  return (await readArtifactMarker()) === artifactId;
};

const waitForRollbackSavedEventCommit = async (client, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastEvidence = null;
  while (Date.now() < deadline) {
    lastEvidence = await collectRollbackDatabaseEvidence(client);
    if (
      lastEvidence.rollbackSavedEvent.present &&
      lastEvidence.rollbackSavedEvent.itemCount >= 1
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `Rollback normal save was not committed to IndexedDB. Last evidence: ${JSON.stringify(
      lastEvidence?.rollbackSavedEvent ?? null,
    )}`,
  );
};

const collectPersistedEventEvidence = async (client, eventName) =>
  await evaluate(
    client,
    `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("EventShoppingPlannerDB");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        const transaction = database.transaction("eventLists", "readonly");
        const eventLists = await new Promise((resolve, reject) => {
          const request = transaction.objectStore("eventLists").get("data");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        const items = eventLists?.[${JSON.stringify(eventName)}];
        const matchingAtomicCreationCount = Array.isArray(items)
          ? items.filter(
              (item) =>
                item?.title === ${JSON.stringify(PROMPT_CLOSE_ITEM_TITLE)} &&
                item?.remarks === "",
            ).length
          : 0;
        const matchingAutosaveMutationCount = Array.isArray(items)
          ? items.filter(
              (item) =>
                item?.title === ${JSON.stringify(PROMPT_CLOSE_ITEM_TITLE)} &&
                item?.remarks === ${JSON.stringify(PROMPT_CLOSE_AUTOSAVE_REMARK)},
            ).length
          : 0;
        return {
          present: Array.isArray(items),
          itemCount: Array.isArray(items) ? items.length : 0,
          atomicCreationClean: matchingAtomicCreationCount === 1,
          autosaveMutationCommitted: matchingAutosaveMutationCount === 1,
        };
      } finally {
        database.close();
      }
    })()`,
  );

const waitForPersistedEventCreation = async (
  client,
  eventName,
  timeoutMs = 20_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastEvidence = null;
  while (Date.now() < deadline) {
    lastEvidence = await collectPersistedEventEvidence(client, eventName);
    if (
      lastEvidence.present &&
      lastEvidence.itemCount >= 1 &&
      lastEvidence.atomicCreationClean
    ) {
      return lastEvidence;
    }
    await delay(100);
  }
  throw new Error(
    `Prompt-close event creation was not committed atomically. Last evidence: ${JSON.stringify(
      lastEvidence,
    )}`,
  );
};

const waitForAutosaveMutationCommit = async (
  client,
  eventName,
  timeoutMs = 20_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastEvidence = null;
  while (Date.now() < deadline) {
    lastEvidence = await collectPersistedEventEvidence(client, eventName);
    if (
      lastEvidence.present &&
      lastEvidence.itemCount >= 1 &&
      lastEvidence.autosaveMutationCommitted
    ) {
      return lastEvidence;
    }
    await delay(100);
  }
  throw new Error(
    `Prompt-close save was not committed to IndexedDB. Last evidence: ${JSON.stringify(
      lastEvidence,
    )}`,
  );
};

const createPromptClosePendingEventThroughUi = async (page, eventName) => {
  await page
    .getByRole("button", { name: "新規リスト作成", exact: true })
    .click();
  await page.locator("#eventName").waitFor({ state: "visible" });
  const formValues = [
    ["#eventName", eventName],
    ["#circles", "Prompt Close Circle"],
    ["#event-dates", "1日目"],
    ["#blocks", "A"],
    ["#numbers", "01a"],
    ["#titles", PROMPT_CLOSE_ITEM_TITLE],
    ["#prices", "100"],
  ];
  // These are controlled React inputs. Serialize interactions and verify the
  // reflected values so concurrent fills cannot submit a partial fixture.
  for (const [selector, value] of formValues) {
    await page.locator(selector).fill(value);
  }
  for (const [selector, value] of formValues) {
    assert(
      (await page.locator(selector).inputValue()) === value,
      `Prompt-close fixture form value differs for ${selector}.`,
    );
  }
  assert(
    await page
      .locator("form:has(#eventName)")
      .evaluate(
        (form) => form instanceof HTMLFormElement && form.checkValidity(),
      ),
    "Prompt-close fixture form is invalid before submission.",
  );
  const acceptDialog = async (dialog) => {
    await dialog.accept();
  };
  page.on("dialog", acceptDialog);
  try {
    await page.locator("form:has(#eventName) button[type=submit]").click();
  } finally {
    page.off("dialog", acceptDialog);
  }
  await page.waitForFunction(
    (expectedEventName) =>
      globalThis.document.body.textContent?.includes(expectedEventName) ===
      true,
    eventName,
  );
};

const applyPromptCloseAutosaveMutationThroughUi = async (
  page,
  eventName,
  expectedPreviousRemarks,
  remarks,
) => {
  const itemRow = page.getByRole("listitem", {
    name: `A01a Prompt Close Circle ${PROMPT_CLOSE_ITEM_TITLE}`,
    exact: true,
  });
  await itemRow.waitFor({ state: "visible" });
  assert(
    (await itemRow.count()) === 1,
    "Prompt-close fixture item row is not unique.",
  );
  const remarksInput = itemRow.getByRole("textbox", {
    name: "利用者メモ",
    exact: true,
  });
  await remarksInput.waitFor({ state: "visible" });
  assert(
    (await remarksInput.count()) === 1,
    "Prompt-close fixture autosave input is not unique.",
  );
  const previousRemarks = await remarksInput.inputValue();
  assert(
    previousRemarks === expectedPreviousRemarks,
    `Prompt-close fixture autosave input differs before mutation for ${eventName}.`,
  );
  await remarksInput.fill(remarks);
  assert(
    (await remarksInput.inputValue()) === remarks,
    `Prompt-close fixture autosave mutation was not applied for ${eventName}.`,
  );
};

const createPromptClosePendingEventAndArmAutosave = async (
  page,
  client,
  eventName,
) => {
  await createPromptClosePendingEventThroughUi(page, eventName);
  await waitForPersistedEventCreation(client, eventName);
  // Event creation is atomically persisted and clean. This public UI mutation
  // exercises the separate debounced autosave path used by the update blocker.
  await applyPromptCloseAutosaveMutationThroughUi(
    page,
    eventName,
    "",
    PROMPT_CLOSE_AUTOSAVE_ARM_REMARK,
  );
};

const createRollbackSavedEventThroughUi = async (client) => {
  const eventName = JSON.stringify(ROLLBACK_SAVE_EVENT_NAME);
  const opened = await evaluate(
    client,
    `(() => {
      if (document.body.textContent?.includes(${eventName})) return "existing";
      const button = [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent?.trim() === "新規リスト作成",
      );
      if (!button) return "missing";
      button.click();
      return "opened";
    })()`,
  );
  assert(opened !== "missing", "Rollback UI cannot open new-list creation.");
  if (opened === "existing") return;

  await waitForExpression(
    client,
    `Boolean(document.querySelector("#eventName") && document.querySelector("#circles"))`,
    "rollback new-list form",
  );
  const populated = await evaluate(
    client,
    `(() => {
      const setValue = (selector, value) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) return false;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const values = [
        ["#eventName", ${eventName}],
        ["#circles", "Rollback Circle"],
        ["#event-dates", "1日目"],
        ["#blocks", "A"],
        ["#numbers", "01a"],
        ["#titles", "Rollback Saved Item"],
        ["#prices", "100"],
      ];
      if (!values.every(([selector, value]) => setValue(selector, value))) {
        return false;
      }
      return true;
    })()`,
  );
  assert(populated, "Rollback UI could not populate the new-list form.");
  await evaluate(
    client,
    `new Promise((resolve) =>
      setTimeout(() => setTimeout(() => resolve(true), 0), 0),
    )`,
  );
  await waitForExpression(
    client,
    `[
      ["#eventName", ${eventName}],
      ["#circles", "Rollback Circle"],
      ["#event-dates", "1日目"],
      ["#blocks", "A"],
      ["#numbers", "01a"],
      ["#titles", "Rollback Saved Item"],
      ["#prices", "100"],
    ].every(
      ([selector, value]) => document.querySelector(selector)?.value === value,
    )`,
    "rollback new-list controlled values",
  );
  const submission = await evaluate(
    client,
    `(() => {
      const form = document.querySelector("#eventName")?.form;
      const submitButton = form?.querySelector('button[type="submit"]');
      if (!form || !submitButton || !form.checkValidity()) {
        return { submitted: false, alertMessages: [] };
      }
      const alertMessages = [];
      const originalAlert = window.alert;
      window.alert = (message) => {
        alertMessages.push(String(message));
      };
      try {
        form.requestSubmit(submitButton);
        return { submitted: true, alertMessages };
      } finally {
        window.alert = originalAlert;
      }
    })()`,
  );
  assert(
    submission?.submitted,
    "Rollback UI could not submit the new-list form.",
  );
  assert(
    submission.alertMessages.some((message) =>
      message.includes("items imported into a new event"),
    ),
    `Rollback UI did not reach its successful import path. Alerts: ${JSON.stringify(
      submission.alertMessages,
    )}`,
  );
  await waitForExpression(
    client,
    `document.body.textContent?.includes(${eventName})`,
    "rollback-saved event render",
  );
  await waitForExpression(
    client,
    `Boolean(
      document.querySelector('[aria-label="保存済み・旧データ保全中"]') ||
      document.querySelector('[aria-label="保存済み"]')
    )`,
    "rollback normal save completion",
  );
  await waitForRollbackSavedEventCommit(client);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertOnlineProbe = (probe) => {
  assert(probe.secureContext, "Localhost is not a secure browser context.");
  assert(probe.buildMode === "release-a", "Build mode is not release-a.");
  assert(
    /^[0-9a-f]{40}$/i.test(probe.buildId) && probe.sourceSha === probe.buildId,
    "Release A build does not identify an exact full source SHA.",
  );
  assert(
    ["clean", "provider-immutable"].includes(probe.sourceState) ||
      (ALLOW_DIRTY_BUILD && probe.sourceState === "dirty"),
    "Release A source state is not clean/provider-immutable.",
  );
  assert(probe.releaseChannel === "release-a", "Release channel is not A.");
  assert(
    probe.cleanupCapability === "forced-off",
    "Legacy cleanup is not forced off.",
  );
  assert(probe.appBuildId === probe.buildId, "App build identity mismatch.");
  assert(
    probe.serviceWorkerHasBuildId,
    "Service Worker build identity mismatch.",
  );
  assert(
    probe.manifestDisplay === "standalone",
    "PWA display is not standalone.",
  );
  assert(probe.manifestStartUrl === "/", "PWA start URL is not root.");
  assert(probe.controlled, "Page is not controlled by a Service Worker.");
  assert(probe.activeState === "activated", "Service Worker is not activated.");
  assert(!probe.waiting, "A waiting Service Worker remains.");
  assert(!probe.installing, "An installing Service Worker remains.");
  assert(probe.mainAssetCached, "Current main asset is not precached.");
  assert(!probe.recoveryVisible, "Unexpected recovery screen is visible.");
  assert(probe.startupReadyCount >= 1, "Startup metric was not recorded.");
};

const assertFixtureUnchanged = (before, after, label) => {
  for (const [key, expected] of Object.entries(before.legacySources ?? {})) {
    const actual = after.legacySources?.[key];
    assert(actual?.present, `${label}: ${key} legacy source is missing.`);
    assert(
      actual.length === expected.length && actual.hash === expected.hash,
      `${label}: ${key} legacy source changed.`,
    );
  }
  assert(after.metadataPresent, `${label}: metadata source is missing.`);
  assert(after.syncQueuePresent, `${label}: syncQueue source is missing.`);
  assert(
    after.metadataLength === before.metadataLength &&
      after.metadataHash === before.metadataHash,
    `${label}: metadata source changed.`,
  );
  assert(
    after.syncQueueLength === before.syncQueueLength &&
      after.syncQueueHash === before.syncQueueHash,
    `${label}: syncQueue source changed.`,
  );
  assert(after.protectedStatusVisible, `${label}: protected status is absent.`);
  assert(after.rendered, `${label}: application did not render.`);
};

const collectOfflineControllerBuildIdentity = async (client, buildId) => {
  await client.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
  try {
    return await evaluate(
      client,
      `fetch(${JSON.stringify(
        `/release-capabilities.${buildId}.json`,
      )}, { cache: "no-store" })
        .then((response) => {
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }
          return response.json();
        })
        .then((capability) => ({
          buildId: capability.buildId,
          sourceSha: capability.sourceSha,
          sourceState: capability.sourceState,
          releaseChannel: capability.releaseChannel,
          cleanupCapability: capability.legacyLocalStorageCleanup,
        }))`,
    );
  } finally {
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });
  }
};

const collectLegacyCapabilityAbsence = async (client, requestedPath) => {
  const observation = await evaluate(
    client,
    `fetch(${JSON.stringify(requestedPath)}, { cache: "no-store" })
      .then(async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        const normalizedBody = body.trimStart().toLowerCase();
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          // A legacy Vite preview can return its HTML fallback for an absent file.
        }
        const releaseCapability =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          parsed.kind === "event-shopping-planner-release-capabilities";
        const htmlFallback =
          contentType.toLowerCase().includes("text/html") &&
          (normalizedBody.startsWith("<!doctype html") ||
            normalizedBody.startsWith("<html"));
        return {
          status: response.status,
          contentType,
          observation: releaseCapability
            ? "release-capability"
            : htmlFallback
              ? "html-fallback"
              : "other",
        };
      })`,
  );
  assertLegacyRollbackCapabilityAbsence(observation);
  return {
    requestedPath,
    status: observation.status,
    observation:
      observation.status === 404 ? "not-found" : observation.observation,
  };
};

if (TRANSITION_MODE) {
  assert(
    REQUESTED_PROFILE_DIRECTORY !== null,
    "Transition verification requires ESP_BROWSER_PROFILE_DIR.",
  );
  assert(
    EXPECTED_FROM_ARTIFACT_ID &&
      TARGET_ARTIFACT_ID &&
      EXPECTED_INDEX_SHA256 &&
      EXPECTED_SERVICE_WORKER_SHA256 &&
      EXPECTED_MAIN_ASSET,
    "Transition verification requires from/target artifact IDs, index/SW SHA-256 values, and the main asset path.",
  );
  assert(
    /^[0-9a-f]{64}$/.test(EXPECTED_INDEX_SHA256) &&
      /^[0-9a-f]{64}$/.test(EXPECTED_SERVICE_WORKER_SHA256),
    "Transition artifact hashes must be lowercase SHA-256 hex.",
  );
  if (TRANSITION_MODE === "forward") {
    assert(
      EXPECTED_TARGET_BUILD_ID !== null,
      "Forward verification requires ESP_EXPECTED_TARGET_BUILD_ID.",
    );
  }
  if (TRANSITION_MODE === "rollback") {
    assert(
      ROLLBACK_TARGET_CAPABILITY_MODE === "required"
        ? EXPECTED_TARGET_BUILD_ID === TARGET_ARTIFACT_ID
        : EXPECTED_TARGET_BUILD_ID === null,
      "Rollback target build ID must match its capability mode.",
    );
  }
}

const ownsProfileDirectory = REQUESTED_PROFILE_DIRECTORY === null;
const profileDirectory = REQUESTED_PROFILE_DIRECTORY
  ? path.resolve(REQUESTED_PROFILE_DIRECTORY)
  : await mkdtemp(path.join(tmpdir(), "esp-release-a-browser-"));
if (REQUESTED_PROFILE_DIRECTORY) {
  await mkdir(profileDirectory, { recursive: true });
}
const browserExecutablePath = await findChrome();
const standaloneBootstrapUrl = new URL("/manifest.webmanifest", PREVIEW_URL);
standaloneBootstrapUrl.hostname =
  standaloneBootstrapUrl.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
const targets = [];
let standaloneTarget = null;
let browserClient = null;
let browserContext = null;
let browserVersion = null;

try {
  const previewResponse = await fetch(PREVIEW_URL);
  const previewBody = await previewResponse.text();
  assert(
    previewResponse.ok,
    `Preview returned HTTP ${previewResponse.status}.`,
  );
  const serviceWorkerResponse = await fetch(new URL("/sw.js", PREVIEW_URL));
  const serviceWorkerCacheControl =
    serviceWorkerResponse.headers.get("cache-control") ?? "";
  const serviceWorkerBody = await serviceWorkerResponse.text();
  assert(
    serviceWorkerResponse.ok &&
      serviceWorkerResponse.headers
        .get("content-type")
        ?.includes("javascript") &&
      !serviceWorkerBody.toLowerCase().includes("<!doctype"),
    "/sw.js is missing or was rewritten to HTML.",
  );
  assert(
    /(no-cache|no-store)/i.test(serviceWorkerCacheControl) ||
      (/max-age\s*=\s*0/i.test(serviceWorkerCacheControl) &&
        /must-revalidate/i.test(serviceWorkerCacheControl)),
    "/sw.js does not require HTTP revalidation.",
  );
  const previewIndexSha256 = sha256Text(previewBody);
  const networkServiceWorkerSha256 = sha256Text(serviceWorkerBody);
  if (TRANSITION_MODE) {
    assert(
      previewIndexSha256 === EXPECTED_INDEX_SHA256,
      "Served transition index.html does not match the expected artifact.",
    );
    assert(
      networkServiceWorkerSha256 === EXPECTED_SERVICE_WORKER_SHA256,
      "Served transition Service Worker does not match the expected artifact.",
    );
  }
  browserContext = await playwrightChromium.launchPersistentContext(
    profileDirectory,
    {
      executablePath: browserExecutablePath,
      headless: true,
      serviceWorkers: "allow",
      viewport: null,
      args: [
        "--disable-background-mode",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-gpu",
        "--no-default-browser-check",
        "--no-first-run",
        `--app=${standaloneBootstrapUrl.href}`,
      ],
    },
  );
  const browser = browserContext.browser();
  assert(browser, "Playwright persistent Chromium browser is missing.");
  browserClient = await browser.newBrowserCDPSession();
  const devToolsVersion = await browserClient.send("Browser.getVersion");
  browserVersion = devToolsVersion.product ?? browser.version();
  const browserProcesses = await browserClient.send(
    "SystemInfo.getProcessInfo",
  );
  const browserProcessIds = browserProcesses.processInfo
    .filter(({ type }) => type === "browser")
    .map(({ id }) => id);
  assert(
    browserProcessIds.length === 1 &&
      Number.isSafeInteger(browserProcessIds[0]) &&
      browserProcessIds[0] > 0,
    "Chromium browser process identity is ambiguous.",
  );
  const browserProcessId = browserProcessIds[0];
  const startupAppPage =
    await selectUniqueStandaloneStartupPage(browserContext);
  standaloneTarget = await createTarget(browserContext, startupAppPage);
  await installBrowserInstrumentation(
    standaloneTarget.client,
    PROMPT_CLOSE_DRILL_MODE === "required" ? "trace-only" : "none",
  );

  const primary = await createTarget(browserContext);
  targets.push(primary);
  await installBrowserInstrumentation(
    primary.client,
    PROMPT_CLOSE_DRILL_MODE === "required" ? "save-blocker" : "none",
  );
  await navigate(primary.client, PREVIEW_URL);
  await ensureControlledApplication(primary.client);
  if (TRANSITION_MODE === "rollback") {
    assert(
      (await readArtifactMarker()) === EXPECTED_FROM_ARTIFACT_ID,
      "Rollback profile does not contain the expected source artifact marker.",
    );
    let rollbackNaturalActivation = null;
    if (ROLLBACK_ACTIVATION_MODE === "natural-after-client-release") {
      const previewOrigin = new URL(PREVIEW_URL).origin;
      const hasPreviewOrigin = (page) => {
        try {
          return new URL(page.url()).origin === previewOrigin;
        } catch {
          return false;
        }
      };
      rollbackNaturalActivation = await waitForNaturalServiceWorkerActivation(
        primary.client,
        new URL("/sw.js", PREVIEW_URL).href,
        () => requestTargetServiceWorkerUpdate(primary.client),
        null,
        async () => {
          const originPages = browserContext.pages().filter(hasPreviewOrigin);
          assert(
            originPages.length > 0,
            "Rollback transition has no controlled origin client to release.",
          );
          await Promise.all(
            originPages.map((page) =>
              page.goto("about:blank", { waitUntil: "load" }),
            ),
          );
          const remainingOriginClientCount = browserContext
            .pages()
            .filter(hasPreviewOrigin).length;
          assert(
            remainingOriginClientCount === 0,
            "Rollback transition did not release every controlled origin client.",
          );
          return {
            releasedClientCount: originPages.length,
            releasedTargetCount: originPages.length,
            remainingOriginClientCount,
          };
        },
        async () => {
          await navigate(primary.client, PREVIEW_URL);
          await waitForControlledApplication(primary.client);
          return { primary: true };
        },
      );
    } else {
      await evaluate(
        primary.client,
        "navigator.serviceWorker.getRegistration().then((registration) => registration.update()).then(() => true)",
      );
      await delay(1_500);
      await reload(primary.client);
    }
    await ensureControlledApplication(primary.client);
    await waitForExpression(
      primary.client,
      EXPECTED_TARGET_BUILD_ID
        ? `document.querySelector(
            'meta[name="event-shopping-planner-build-id"]',
          )?.content === ${JSON.stringify(EXPECTED_TARGET_BUILD_ID)}`
        : `!document.querySelector(
            'meta[name="event-shopping-planner-build-id"]',
          )`,
      "expected rollback artifact build marker",
    );
    await waitForExpression(
      primary.client,
      `[...document.scripts].some(
        (script) =>
          script.src &&
          new URL(script.src, document.baseURI).pathname ===
            ${JSON.stringify(EXPECTED_MAIN_ASSET)},
      )`,
      "expected rollback main asset",
    );
    await waitForExpression(
      primary.client,
      `Boolean(document.querySelector(
        '[aria-label="保存済み・旧データ保全中"]',
      ))`,
      "rollback legacy source protection status",
    );
    if (!rollbackNaturalActivation) {
      await waitForExpression(
        primary.client,
        `Number.parseInt(
          sessionStorage.getItem(${JSON.stringify(
            CONTROLLER_CHANGE_COUNT_KEY,
          )}) ?? "0",
          10,
        ) >= 1`,
        "rollback Service Worker controller change",
      );
    }
    const activeRollbackWorker = await collectActiveServiceWorkerSourceEvidence(
      browserClient,
      new URL("/sw.js", PREVIEW_URL).href,
    );
    assert(
      activeRollbackWorker.sha256 === EXPECTED_SERVICE_WORKER_SHA256,
      "Active rollback Service Worker does not match the expected artifact.",
    );
    const rollbackOfflineControllerIdentity =
      ROLLBACK_TARGET_CAPABILITY_MODE === "required"
        ? await collectOfflineControllerBuildIdentity(
            primary.client,
            TARGET_ARTIFACT_ID,
          )
        : null;
    if (rollbackOfflineControllerIdentity) {
      assert(
        rollbackOfflineControllerIdentity.buildId === TARGET_ARTIFACT_ID &&
          rollbackOfflineControllerIdentity.sourceSha === TARGET_ARTIFACT_ID &&
          rollbackOfflineControllerIdentity.sourceState === "clean" &&
          rollbackOfflineControllerIdentity.releaseChannel === "release-a" &&
          rollbackOfflineControllerIdentity.cleanupCapability === "forced-off",
        "Rollback target versioned capability identity differs.",
      );
    }
    const rollbackVersionedCapabilityEvidence =
      rollbackOfflineControllerIdentity
        ? {
            expectation: "required",
            requestedPath: `/release-capabilities.${TARGET_ARTIFACT_ID}.json`,
            status: 200,
            observation: "offline-cached",
          }
        : {
            expectation: "legacy-absent",
            stable: await collectLegacyCapabilityAbsence(
              primary.client,
              "/release-capabilities.json",
            ),
            versioned: await collectLegacyCapabilityAbsence(
              primary.client,
              `/release-capabilities.${TARGET_ARTIFACT_ID}.json`,
            ),
          };
    const expectedFixture = createExpectedLegacyFixtureEvidence();
    const rollbackFixture = await collectFixtureEvidence(primary.client);
    assertFixtureUnchanged(
      expectedFixture,
      rollbackFixture,
      "rollback startup",
    );
    const rollbackDatabaseBeforeSave = await collectRollbackDatabaseEvidence(
      primary.client,
    );
    assert(
      rollbackDatabaseBeforeSave.dbVersion >= 5 &&
        rollbackDatabaseBeforeSave.dbVersion <= 7,
      "Rollback reader opened an incompatible database version.",
    );
    assert(
      rollbackDatabaseBeforeSave.journalSchemaVersion === 2 &&
        ["verified", "cleanup-ready"].includes(
          rollbackDatabaseBeforeSave.journalPhase,
        ) &&
        rollbackDatabaseBeforeSave.journalDataMigrationStatus === "verified",
      "Rollback reader could not read the Release A journal.",
    );
    assert(
      rollbackDatabaseBeforeSave.archiveSchemaVersion === 1 &&
        rollbackDatabaseBeforeSave.archivedSyncQueue,
      "Rollback reader could not read the legacy syncQueue archive.",
    );
    assert(
      rollbackDatabaseBeforeSave.checkpoint.kind ===
        "event-shopping-planner-persistence-checkpoint" &&
        rollbackDatabaseBeforeSave.checkpoint.version === 1 &&
        rollbackDatabaseBeforeSave.checkpoint.storeName === "eventMetadata" &&
        rollbackDatabaseBeforeSave.checkpoint.key === "data" &&
        rollbackDatabaseBeforeSave.checkpoint.committedRevisionPresent &&
        rollbackDatabaseBeforeSave.checkpoint.digestAlgorithm === "SHA-256",
      "Rollback reader could not read the Release A checkpoint.",
    );

    if (ROLLBACK_ACTIVATION_MODE === "natural-after-client-release") {
      await createPromptClosePendingEventAndArmAutosave(
        primary.page,
        primary.client,
        ROLLBACK_SAVE_EVENT_NAME,
      );
      await waitForProductionEventAutosaveBlocker(primary.client);
      await applyPromptCloseAutosaveMutationThroughUi(
        primary.page,
        ROLLBACK_SAVE_EVENT_NAME,
        PROMPT_CLOSE_AUTOSAVE_ARM_REMARK,
        PROMPT_CLOSE_AUTOSAVE_REMARK,
      );
      const rollbackFlush = await flushProductionEventAutosave(primary.client);
      assert(
        rollbackFlush.responsive === true &&
          rollbackFlush.flushError === false &&
          rollbackFlush.blockerCount === 0,
        `Rollback production autosave flush did not finish cleanly: ${JSON.stringify(
          rollbackFlush,
        )}`,
      );
      await waitForAutosaveMutationCommit(
        primary.client,
        ROLLBACK_SAVE_EVENT_NAME,
      );
    } else {
      await createRollbackSavedEventThroughUi(primary.client);
    }
    let rollbackDatabase = await collectRollbackDatabaseEvidence(
      primary.client,
    );
    assert(
      rollbackDatabase.rollbackSavedEvent.present &&
        rollbackDatabase.rollbackSavedEvent.itemCount >= 1,
      "Rollback normal save was not committed to IndexedDB.",
    );
    await reload(primary.client);
    await ensureControlledApplication(primary.client);
    await waitForExpression(
      primary.client,
      `document.body.textContent?.includes(${JSON.stringify(
        ROLLBACK_SAVE_EVENT_NAME,
      )})`,
      "rollback normal save after reload",
    );
    rollbackDatabase = await collectRollbackDatabaseEvidence(primary.client);
    assert(
      rollbackDatabase.rollbackSavedEvent.present &&
        rollbackDatabase.rollbackSavedEvent.itemCount >= 1,
      "Rollback normal save was not retained after reload.",
    );
    const finalRollbackFixture = await collectFixtureEvidence(primary.client);
    assertFixtureUnchanged(
      expectedFixture,
      finalRollbackFixture,
      "rollback save and reload",
    );
    await navigate(standaloneTarget.client, PREVIEW_URL);
    await ensureControlledApplication(standaloneTarget.client);
    await waitForExpression(
      standaloneTarget.client,
      `document.body.textContent?.includes(${JSON.stringify(
        ROLLBACK_SAVE_EVENT_NAME,
      )})`,
      "rollback-saved event in standalone app-window",
    );
    const rollbackStandaloneFixture = await collectFixtureEvidence(
      standaloneTarget.client,
    );
    assertFixtureUnchanged(
      expectedFixture,
      rollbackStandaloneFixture,
      "rollback standalone app-window",
    );
    const rollbackStandaloneMedia = await evaluate(
      standaloneTarget.client,
      'matchMedia("(display-mode: standalone)").matches',
    );
    assert(
      rollbackStandaloneMedia,
      "Rollback standalone app-window lost standalone display mode.",
    );
    const rollbackRecoveryVisible = await evaluate(
      primary.client,
      `[...document.querySelectorAll("h1, h2")].some(
        (heading) =>
          heading.textContent?.includes(
            "保存データを安全に読み込めません",
          ),
      )`,
    );
    assert(
      !rollbackRecoveryVisible,
      "Rollback unexpectedly entered the recovery screen.",
    );
    const rollbackInstrumentation = await collectBrowserInstrumentationEvidence(
      primary.client,
    );
    assert(
      rollbackInstrumentation.legacyDeleteCount === 0,
      "Rollback attempted to delete a protected legacy source.",
    );
    if (rollbackNaturalActivation) {
      assert(
        typeof rollbackNaturalActivation.versionId === "string" &&
          rollbackNaturalActivation.versionId.length > 0 &&
          rollbackNaturalActivation.remainingOriginClientCount === 0,
        "Rollback did not complete natural Service Worker activation.",
      );
    } else {
      assert(
        rollbackInstrumentation.controllerChangeCount >= 1,
        "Rollback did not observe a Service Worker controller change.",
      );
    }
    assert(
      await writeArtifactMarker(TARGET_ARTIFACT_ID),
      "Rollback artifact marker could not be persisted.",
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          result: "PASS",
          mode: "rollback",
          browser: path.basename(browserExecutablePath),
          browserProcessId,
          previewOrigin: new URL(PREVIEW_URL).origin,
          fromArtifactId: EXPECTED_FROM_ARTIFACT_ID,
          targetArtifactId: TARGET_ARTIFACT_ID,
          rollbackArtifactLoaded: true,
          indexSha256: previewIndexSha256,
          activeServiceWorker: activeRollbackWorker,
          versionedCapability: rollbackVersionedCapabilityEvidence,
          offlineControllerIdentity: rollbackOfflineControllerIdentity,
          naturalActivation: rollbackNaturalActivation,
          activationMode: ROLLBACK_ACTIVATION_MODE,
          serviceWorkerResponseCacheControl: serviceWorkerCacheControl,
          legacySources: {
            metadataPresent: finalRollbackFixture.metadataPresent,
            metadataLength: finalRollbackFixture.metadataLength,
            metadataHash: finalRollbackFixture.metadataHash,
            syncQueuePresent: finalRollbackFixture.syncQueuePresent,
            syncQueueLength: finalRollbackFixture.syncQueueLength,
            syncQueueHash: finalRollbackFixture.syncQueueHash,
            protectedLegacySourceCount: Object.keys(
              finalRollbackFixture.legacySources,
            ).length,
            rawValues: finalRollbackFixture.rawValues,
            unchanged: true,
            physicalDeleteCount: rollbackInstrumentation.legacyDeleteCount,
          },
          controllerChangeCount: rollbackInstrumentation.controllerChangeCount,
          surfaces: {
            normalTab: true,
            standaloneAppWindowEquivalent: rollbackStandaloneMedia,
            sameProfile: true,
            installedPwa: false,
          },
          database: rollbackDatabase,
          recoveryScreenVisible: rollbackRecoveryVisible,
        },
        null,
        2,
      )}\n`,
    );
  } else if (TRANSITION_MODE === "forward") {
    assert(
      (await readArtifactMarker()) === EXPECTED_FROM_ARTIFACT_ID,
      "Forward profile does not contain the expected rollback artifact marker.",
    );
    const previewOrigin = new URL(PREVIEW_URL).origin;
    const hasPreviewOrigin = (page) => {
      try {
        return new URL(page.url()).origin === previewOrigin;
      } catch {
        return false;
      }
    };

    let promptCloseSecondary = null;
    let promptCloseClients = null;
    let baselineControllerChangeCounts = null;
    let promptCloseEventName = null;
    if (PROMPT_CLOSE_DRILL_MODE === "required") {
      await navigate(standaloneTarget.client, PREVIEW_URL);
      await ensureControlledApplication(standaloneTarget.client);

      promptCloseSecondary = await createTarget(browserContext);
      targets.push(promptCloseSecondary);
      await installBrowserInstrumentation(
        promptCloseSecondary.client,
        "trace-only",
      );
      await navigate(promptCloseSecondary.client, PREVIEW_URL);
      await ensureControlledApplication(promptCloseSecondary.client);

      promptCloseClients = [
        { role: "primary", target: primary },
        { role: "secondary", target: promptCloseSecondary },
        { role: "standalone-equivalent", target: standaloneTarget },
      ];
      assert(
        browserContext.pages().filter(hasPreviewOrigin).length ===
          promptCloseClients.length,
        "Prompt-close drill requires exactly three same-origin clients.",
      );
      baselineControllerChangeCounts = Object.fromEntries(
        await Promise.all(
          promptCloseClients.map(async ({ role, target }) => [
            role,
            (await collectBrowserInstrumentationEvidence(target.client))
              .controllerChangeCount,
          ]),
        ),
      );
      await Promise.all(
        promptCloseClients.map(({ target }) =>
          armPwaUpdateProbe(target.client),
        ),
      );
      promptCloseEventName = `RELEASE_A_PROMPT_CLOSE_SAVE_${Date.now()}`;
      const eventBeforeSave = await collectPersistedEventEvidence(
        primary.client,
        promptCloseEventName,
      );
      assert(
        !eventBeforeSave.present,
        "Prompt-close save fixture already exists before user action.",
      );
    }

    const naturalActivation = await waitForNaturalServiceWorkerActivation(
      primary.client,
      new URL("/sw.js", PREVIEW_URL).href,
      () => requestTargetServiceWorkerUpdate(primary.client),
      PROMPT_CLOSE_DRILL_MODE === "required"
        ? async ({ waitingVersionId }) => {
            const preflush = await waitForPromptCloseAllPhase(
              primary.client,
              "save-required",
              "prompt-close save-required phase",
            );
            assert(
              preflush.snapshotCount === 3 &&
                preflush.responsiveCount === 3 &&
                preflush.blockerCount >= 1 &&
                preflush.unresponsiveCount === 0 &&
                preflush.flushFailureCount === 0 &&
                preflush.saveOperationCount === 0 &&
                preflush.action === "save-and-flush" &&
                preflush.actionVisible &&
                !preflush.closeGuidanceVisible,
              `Prompt-close preflush evidence differs: ${JSON.stringify(preflush)}`,
            );
            assert(
              preflush.activeState === "activated" &&
                preflush.waitingState === "installed" &&
                preflush.controllerState === "activated",
              "Prompt-close preflush did not preserve the active/waiting roles.",
            );

            await createPromptClosePendingEventAndArmAutosave(
              primary.page,
              primary.client,
              promptCloseEventName,
            );
            const eventAutosaveInspection =
              await waitForProductionEventAutosaveBlocker(primary.client);
            assert(
              eventAutosaveInspection.responsive === true &&
                eventAutosaveInspection.flushError === false &&
                eventAutosaveInspection.blockerCount >= 1 &&
                eventAutosaveInspection.eventAutosaveObserved === true,
              `Production event-autosave blocker was not observed before the initial action: ${JSON.stringify(
                eventAutosaveInspection,
              )}`,
            );

            await promptCloseSecondary.client.send(
              "Emulation.setScriptExecutionDisabled",
              { value: true },
            );
            let failedClosed;
            try {
              // Re-arm the debounce immediately before the trusted action. The
              // final marker is what the production flush must persist.
              await applyPromptCloseAutosaveMutationThroughUi(
                primary.page,
                promptCloseEventName,
                PROMPT_CLOSE_AUTOSAVE_ARM_REMARK,
                PROMPT_CLOSE_AUTOSAVE_REMARK,
              );
              await primary.page
                .locator(
                  '[data-pwa-save-and-flush][data-pwa-save-action="save-and-flush"]',
                )
                .click();
              failedClosed = await waitForPromptCloseAllPhase(
                primary.client,
                "save-incomplete",
                "prompt-close fail-closed phase",
              );
              assert(
                failedClosed.snapshotCount === 3 &&
                  failedClosed.responsiveCount === 2 &&
                  failedClosed.blockerCount === 0 &&
                  failedClosed.unresponsiveCount === 1 &&
                  failedClosed.flushFailureCount === 0 &&
                  failedClosed.saveOperationCount === 1 &&
                  failedClosed.action === "retry" &&
                  failedClosed.actionVisible &&
                  !failedClosed.closeGuidanceVisible,
                `Prompt-close fail-closed evidence differs: ${JSON.stringify(
                  failedClosed,
                )}`,
              );
            } finally {
              await promptCloseSecondary.client.send(
                "Emulation.setScriptExecutionDisabled",
                { value: false },
              );
            }

            const resumedSecondary =
              await requestProductionEventAutosaveSnapshot(
                promptCloseSecondary.client,
                false,
              );
            assert(
              resumedSecondary.responsive === true &&
                resumedSecondary.flushError === false &&
                resumedSecondary.blockerCount === 0,
              `Prompt-close secondary did not recover its production blocker bridge: ${JSON.stringify(
                resumedSecondary,
              )}`,
            );

            const eventAfterInitialAction = await waitForAutosaveMutationCommit(
              primary.client,
              promptCloseEventName,
            );
            await primary.page
              .locator(
                '[data-pwa-save-and-flush][data-pwa-save-action="retry"]',
              )
              .click();
            const postflush = await waitForPromptCloseAllPhase(
              primary.client,
              "ready-to-close",
              "prompt-close ready-to-close phase",
            );
            assert(
              postflush.snapshotCount === 3 &&
                postflush.responsiveCount === 3 &&
                postflush.blockerCount === 0 &&
                postflush.unresponsiveCount === 0 &&
                postflush.flushFailureCount === 0 &&
                postflush.saveOperationCount === 2 &&
                postflush.action === null &&
                !postflush.actionVisible &&
                postflush.closeGuidanceVisible,
              `Prompt-close postflush evidence differs: ${JSON.stringify(
                postflush,
              )}`,
            );
            assert(
              postflush.activeState === "activated" &&
                postflush.waitingState === "installed" &&
                postflush.controllerState === "activated",
              "Prompt-close user action activated the waiting worker prematurely.",
            );

            const clientEvidence = await Promise.all(
              promptCloseClients.map(async ({ role, target }) => ({
                role,
                evidence: await collectPromptCloseAllUiEvidence(target.client),
              })),
            );
            clientEvidence.forEach(({ role, evidence }) => {
              assert(
                evidence.snapshotRequests.inspectionCount >= 1 &&
                  evidence.snapshotRequests.flushCount >= 1 &&
                  evidence.snapshotRequests.productionFlushCount >= 1 &&
                  evidence.snapshotRequests.productionFlushResponseCount >= 1 &&
                  evidence.snapshotRequests.productionCleanFlushResponseCount >=
                    1,
                `Prompt-close ${role} did not observe production inspect/flush requests and clean responses.`,
              );
              assert(
                evidence.activeState === "activated" &&
                  evidence.waitingState === "installed" &&
                  evidence.controllerState === "activated" &&
                  evidence.controllerChangeCount ===
                    baselineControllerChangeCounts[role],
                `Prompt-close ${role} changed controller before client release.`,
              );
            });

            const projectPhase = (evidence) => ({
              phase: evidence.phase,
              snapshotCount: evidence.snapshotCount,
              responsiveCount: evidence.responsiveCount,
              blockerCount: evidence.blockerCount,
              unresponsiveCount: evidence.unresponsiveCount,
              flushFailureCount: evidence.flushFailureCount,
              saveOperationCount: evidence.saveOperationCount,
              action: evidence.action,
              actionVisible: evidence.actionVisible,
              closeGuidanceVisible: evidence.closeGuidanceVisible,
            });
            return {
              schemaVersion: 1,
              kind: "prompt-close-all-browser-drill/v1",
              clientRoles: promptCloseClients.map(({ role }) => role),
              blockerFixture:
                "synthetic-protocol-blocker-with-real-event-autosave-persistence",
              interaction: {
                initialAction: "playwright-click",
                retryAction: "playwright-click",
                operationCount: postflush.saveOperationCount,
                eventAutosaveBlockerObserved:
                  eventAutosaveInspection.eventAutosaveObserved,
                eventAutosaveMutationPersistedAfterInitialAction:
                  eventAfterInitialAction.autosaveMutationCommitted,
                persistedItemCount: eventAfterInitialAction.itemCount,
              },
              preflush: projectPhase(preflush),
              failedClosed: {
                cause: "script-execution-disabled-unresponsive-client",
                ...projectPhase(failedClosed),
              },
              postflush: projectPhase(postflush),
              snapshotRequests: clientEvidence.map(({ role, evidence }) => ({
                role,
                inspectionCount: evidence.snapshotRequests.inspectionCount,
                flushCount: evidence.snapshotRequests.flushCount,
                productionFlushCount:
                  evidence.snapshotRequests.productionFlushCount,
                productionFlushResponseCount:
                  evidence.snapshotRequests.productionFlushResponseCount,
                productionCleanFlushResponseCount:
                  evidence.snapshotRequests.productionCleanFlushResponseCount,
              })),
              controllerBeforeClose: {
                fromArtifactId: EXPECTED_FROM_ARTIFACT_ID,
                targetArtifactId: TARGET_ARTIFACT_ID,
                waitingVersionId,
                clients: clientEvidence.map(({ role, evidence }) => ({
                  role,
                  activeState: evidence.activeState,
                  waitingState: evidence.waitingState,
                  controllerState: evidence.controllerState,
                  controllerScriptUrl: evidence.controllerScriptUrl,
                  controllerChangeCountDelta:
                    evidence.controllerChangeCount -
                    baselineControllerChangeCounts[role],
                })),
              },
            };
          }
        : null,
      async () => {
        const originPages = browserContext.pages().filter(hasPreviewOrigin);
        assert(
          originPages.length > 0,
          "Forward transition has no controlled origin client to release.",
        );
        const releasePages = new Set([
          primary.page,
          standaloneTarget.page,
          ...originPages,
        ]);
        await Promise.all(
          [...releasePages].map((page) =>
            page.goto("about:blank", { waitUntil: "load" }),
          ),
        );
        assert(
          browserContext.pages().filter(hasPreviewOrigin).length === 0,
          "Forward transition did not release every controlled origin client.",
        );
        return {
          releasedClientCount: originPages.length,
          releasedTargetCount: releasePages.size,
          remainingOriginClientCount: browserContext
            .pages()
            .filter(hasPreviewOrigin).length,
        };
      },
      async () => {
        const collectRegistrationState = (client) =>
          evaluate(
            client,
            `navigator.serviceWorker.getRegistration().then((registration) => ({
              activeScriptUrl: registration?.active?.scriptURL ?? null,
              activeState: registration?.active?.state ?? null,
              installing: Boolean(registration?.installing),
              waiting: Boolean(registration?.waiting),
            }))`,
          );
        const assertStableRegistration = (state, label) => {
          assert(
            state.activeScriptUrl === new URL("/sw.js", PREVIEW_URL).href &&
              state.activeState === "activated" &&
              !state.installing &&
              !state.waiting,
            `${label} observed an unstable Service Worker registration.`,
          );
        };

        await navigate(primary.client, PREVIEW_URL);
        await waitForControlledApplication(primary.client);
        await waitForReleaseAStartupMetric(primary.client);
        const primaryRegistration = await collectRegistrationState(
          primary.client,
        );
        assertStableRegistration(primaryRegistration, "Primary reopen");

        await navigate(standaloneTarget.client, PREVIEW_URL);
        await waitForControlledApplication(standaloneTarget.client);
        await waitForReleaseAStartupMetric(standaloneTarget.client);
        const standaloneRegistration = await collectRegistrationState(
          standaloneTarget.client,
        );
        assertStableRegistration(standaloneRegistration, "Standalone reopen");
        return { primaryRegistration, standaloneRegistration };
      },
    );
    if (PROMPT_CLOSE_DRILL_MODE === "required") {
      assertPromptCloseAllBrowserDrill(naturalActivation.promptCloseAll, {
        expectedFromArtifactId: EXPECTED_FROM_ARTIFACT_ID,
        expectedServiceWorkerUrl: new URL("/sw.js", PREVIEW_URL).href,
        expectedTargetArtifactId: TARGET_ARTIFACT_ID,
      });
    } else {
      assert(
        !Object.hasOwn(naturalActivation, "promptCloseAll"),
        "Disabled prompt-close drill emitted prompt evidence.",
      );
    }
    await waitForExpression(
      primary.client,
      `document.querySelector(
        'meta[name="event-shopping-planner-build-id"]',
      )?.content === ${JSON.stringify(EXPECTED_TARGET_BUILD_ID)}`,
      "forward Release A build marker",
    );
    await waitForExpression(
      primary.client,
      `[...document.scripts].some(
        (script) =>
          script.src &&
          new URL(script.src, document.baseURI).pathname ===
            ${JSON.stringify(EXPECTED_MAIN_ASSET)},
      )`,
      "forward Release A main asset",
    );
    await waitForReleaseAStartupMetric(primary.client);
    const forwardProbe = await collectOnlineProbe(primary.client);
    assertOnlineProbe(forwardProbe);
    assert(
      forwardProbe.buildId === EXPECTED_TARGET_BUILD_ID &&
        TARGET_ARTIFACT_ID === EXPECTED_TARGET_BUILD_ID,
      "Forward app identity does not match the target artifact.",
    );
    const activeForwardWorker = await collectActiveServiceWorkerSourceEvidence(
      browserClient,
      new URL("/sw.js", PREVIEW_URL).href,
    );
    assert(
      activeForwardWorker.sha256 === EXPECTED_SERVICE_WORKER_SHA256,
      "Active forward Service Worker does not match the target artifact.",
    );
    const offlineControllerIdentity =
      await collectOfflineControllerBuildIdentity(
        primary.client,
        forwardProbe.buildId,
      );
    assert(
      offlineControllerIdentity.buildId === forwardProbe.buildId &&
        offlineControllerIdentity.sourceSha === forwardProbe.buildId &&
        offlineControllerIdentity.releaseChannel === "release-a" &&
        offlineControllerIdentity.cleanupCapability === "forced-off",
      "Active controller cannot serve the target build identity offline.",
    );
    const forwardFixture = await collectFixtureEvidence(primary.client);
    assertFixtureUnchanged(
      createExpectedLegacyFixtureEvidence(),
      forwardFixture,
      "forward update",
    );
    const forwardDatabase = await collectRollbackDatabaseEvidence(
      primary.client,
    );
    assert(
      forwardDatabase.rollbackSavedEvent.present &&
        forwardDatabase.rollbackSavedEvent.itemCount >= 1,
      "Rollback-saved event was not retained after the forward update.",
    );
    await waitForExpression(
      standaloneTarget.client,
      `document.body.textContent?.includes(${JSON.stringify(
        ROLLBACK_SAVE_EVENT_NAME,
      )})`,
      "rollback-saved event after forward update in standalone app-window",
    );
    await waitForReleaseAStartupMetric(standaloneTarget.client);
    const forwardStandaloneProbe = await collectOnlineProbe(
      standaloneTarget.client,
    );
    assertOnlineProbe(forwardStandaloneProbe);
    const forwardStandaloneFixture = await collectFixtureEvidence(
      standaloneTarget.client,
    );
    assertFixtureUnchanged(
      forwardFixture,
      forwardStandaloneFixture,
      "forward standalone app-window",
    );
    const forwardStandaloneMedia = await evaluate(
      standaloneTarget.client,
      'matchMedia("(display-mode: standalone)").matches',
    );
    assert(
      forwardStandaloneMedia,
      "Forward standalone app-window lost standalone display mode.",
    );
    const forwardInstrumentation = await collectBrowserInstrumentationEvidence(
      primary.client,
    );
    assert(
      forwardInstrumentation.legacyDeleteCount === 0,
      "Forward update attempted to delete a protected legacy source.",
    );
    assert(
      await writeArtifactMarker(TARGET_ARTIFACT_ID),
      "Forward artifact marker could not be persisted.",
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          result: "PASS",
          mode: "forward",
          browser: path.basename(browserExecutablePath),
          browserProcessId,
          previewOrigin: new URL(PREVIEW_URL).origin,
          fromArtifactId: EXPECTED_FROM_ARTIFACT_ID,
          targetArtifactId: TARGET_ARTIFACT_ID,
          indexSha256: previewIndexSha256,
          activeServiceWorker: activeForwardWorker,
          naturalActivation,
          offlineControllerIdentity,
          controllerChangeCount: forwardInstrumentation.controllerChangeCount,
          legacySources: {
            metadataPresent: forwardFixture.metadataPresent,
            metadataLength: forwardFixture.metadataLength,
            metadataHash: forwardFixture.metadataHash,
            syncQueuePresent: forwardFixture.syncQueuePresent,
            syncQueueLength: forwardFixture.syncQueueLength,
            syncQueueHash: forwardFixture.syncQueueHash,
            protectedLegacySourceCount: Object.keys(
              forwardFixture.legacySources,
            ).length,
            rawValues: forwardFixture.rawValues,
            unchanged: true,
            physicalDeleteCount: forwardInstrumentation.legacyDeleteCount,
          },
          rollbackSavedEvent: forwardDatabase.rollbackSavedEvent,
          database: forwardDatabase,
          surfaces: {
            normalTab: true,
            standaloneAppWindowEquivalent: forwardStandaloneMedia,
            sameProfile: true,
            installedPwa: false,
          },
          recoveryScreenVisible: forwardProbe.recoveryVisible,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    await waitForReleaseAStartupMetric(primary.client);
    const initialProbe = await collectOnlineProbe(primary.client);
    assertOnlineProbe(initialProbe);
    assert(
      await writeArtifactMarker(initialProbe.buildId),
      "Release A artifact marker could not be persisted.",
    );
    const [installability, appManifest] = await Promise.all([
      primary.client.send("Page.getInstallabilityErrors"),
      primary.client.send("Page.getAppManifest"),
    ]);
    assert(
      (installability.installabilityErrors ?? []).length === 0,
      "Chromium reported PWA installability errors.",
    );
    assert(
      (appManifest.errors ?? []).length === 0 &&
        typeof appManifest.url === "string" &&
        appManifest.url.endsWith("/manifest.webmanifest"),
      "Chromium could not validate the PWA manifest.",
    );

    const fixture = await installSyntheticLegacyFixture(primary.client);
    await reload(primary.client);
    await waitForExpression(
      primary.client,
      `Boolean(document.querySelector(
        '[aria-label="保存済み・旧データ保全中"]',
      ))`,
      "legacy source protection status",
    );
    const primaryFixture = await collectFixtureEvidence(primary.client);
    assertFixtureUnchanged(fixture, primaryFixture, "primary tab");

    const secondary = await createTarget(browserContext);
    targets.push(secondary);
    await installBrowserInstrumentation(secondary.client);
    await navigate(secondary.client, PREVIEW_URL);
    await ensureControlledApplication(secondary.client);
    await waitForReleaseAStartupMetric(secondary.client);
    const secondaryProbe = await collectOnlineProbe(secondary.client);
    assertOnlineProbe(secondaryProbe);
    const secondaryFixture = await collectFixtureEvidence(secondary.client);
    assertFixtureUnchanged(fixture, secondaryFixture, "second tab");

    await navigate(standaloneTarget.client, PREVIEW_URL);
    await waitForExpression(
      standaloneTarget.client,
      "Boolean(document.querySelector('#root')?.childElementCount)",
      "standalone app-window render",
    );
    await ensureControlledApplication(standaloneTarget.client);
    await waitForReleaseAStartupMetric(standaloneTarget.client);
    const standaloneProbe = await collectOnlineProbe(standaloneTarget.client);
    assertOnlineProbe(standaloneProbe);
    const standaloneMedia = await evaluate(
      standaloneTarget.client,
      'matchMedia("(display-mode: standalone)").matches',
    );
    assert(standaloneMedia, "Standalone display-mode preflight failed.");
    const standaloneFixture = await collectFixtureEvidence(
      standaloneTarget.client,
    );
    assertFixtureUnchanged(
      fixture,
      standaloneFixture,
      "same-profile standalone app-window",
    );

    await primary.client.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: "none",
    });
    await reload(primary.client);
    await waitForExpression(
      primary.client,
      "Boolean(document.querySelector('#root')?.childElementCount)",
      "offline application render",
    );
    await waitForExpression(
      primary.client,
      `Boolean(document.querySelector(
      '[aria-label="保存済み・旧データ保全中"]',
    ))`,
      "offline legacy source protection status",
    );
    const offlineFixture = await collectFixtureEvidence(primary.client);
    assertFixtureUnchanged(fixture, offlineFixture, "offline reload");

    await primary.client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });
    await evaluate(
      primary.client,
      "navigator.serviceWorker.getRegistration().then((registration) => registration.update()).then(() => true)",
    );
    await reload(primary.client);
    await waitForReleaseAStartupMetric(primary.client);
    await waitForExpression(
      primary.client,
      `Boolean(document.querySelector(
        '[aria-label="保存済み・旧データ保全中"]',
      ))`,
      "online resume legacy source protection status",
    );
    const finalProbe = await collectOnlineProbe(primary.client);
    assertOnlineProbe(finalProbe);
    const finalFixture = await collectFixtureEvidence(primary.client);
    assertFixtureUnchanged(fixture, finalFixture, "online resume");
    const finalInstrumentation = await collectBrowserInstrumentationEvidence(
      primary.client,
    );
    assert(
      finalInstrumentation.legacyDeleteCount === 0,
      "Release A attempted to delete a protected legacy source.",
    );
    const activeServiceWorker = await collectActiveServiceWorkerSourceEvidence(
      browserClient,
      finalProbe.serviceWorkerScriptUrl,
    );
    assert(
      activeServiceWorker.sha256 === networkServiceWorkerSha256,
      "Active Service Worker source differs from the served Release A artifact.",
    );
    const offlineControllerIdentity =
      await collectOfflineControllerBuildIdentity(
        primary.client,
        finalProbe.buildId,
      );
    assert(
      offlineControllerIdentity.buildId === finalProbe.buildId &&
        offlineControllerIdentity.sourceSha === finalProbe.buildId &&
        offlineControllerIdentity.releaseChannel === "release-a" &&
        offlineControllerIdentity.cleanupCapability === "forced-off",
      "Active controller cannot serve the Release A build identity offline.",
    );
    const preflightDatabase = await collectRollbackDatabaseEvidence(
      primary.client,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          result: "PREFLIGHT_PASS",
          observedAt: new Date().toISOString(),
          browser: path.basename(browserExecutablePath),
          browserProcessId,
          browserVersion,
          previewOrigin: new URL(PREVIEW_URL).origin,
          buildId: finalProbe.buildId,
          sourceState: finalProbe.sourceState,
          cleanupCapability: finalProbe.cleanupCapability,
          indexSha256: previewIndexSha256,
          serviceWorkerResponseCacheControl: serviceWorkerCacheControl,
          serviceWorker: {
            controlled: finalProbe.controlled,
            activeState: finalProbe.activeState,
            waiting: finalProbe.waiting,
            installing: finalProbe.installing,
            buildIdentityMatched: finalProbe.serviceWorkerHasBuildId,
            currentMainAssetCached: finalProbe.mainAssetCached,
            activeSource: activeServiceWorker,
            offlineControllerIdentity,
          },
          surfaces: {
            normalTab: true,
            secondTab: true,
            installable: true,
            standaloneAppWindowEquivalent: standaloneMedia,
            sameProfile: true,
            installedPwa: false,
          },
          offlineReload: true,
          onlineResume: true,
          legacySources: {
            metadataPresent: finalFixture.metadataPresent,
            metadataLength: finalFixture.metadataLength,
            metadataHash: finalFixture.metadataHash,
            syncQueuePresent: finalFixture.syncQueuePresent,
            syncQueueLength: finalFixture.syncQueueLength,
            syncQueueHash: finalFixture.syncQueueHash,
            protectedLegacySourceCount: Object.keys(finalFixture.legacySources)
              .length,
            rawValues: finalFixture.rawValues,
            unchanged: true,
            physicalDeleteCount: finalInstrumentation.legacyDeleteCount,
          },
          database: preflightDatabase,
          recoveryScreenVisible: finalProbe.recoveryVisible,
          startupMetricRecorded: finalProbe.startupReadyCount >= 1,
        },
        null,
        2,
      )}\n`,
    );
  }
} finally {
  if (standaloneTarget) {
    await closeTarget(standaloneTarget).catch(() => undefined);
  }
  await Promise.all(targets.map((target) => closeTarget(target))).catch(
    () => undefined,
  );
  if (browserClient) {
    await browserClient.detach().catch(() => undefined);
  }
  if (browserContext) {
    await withTimeout(
      browserContext.close(),
      10_000,
      "Playwright persistent context shutdown",
    ).catch(async () => {
      await browserContext
        .browser()
        ?.close()
        .catch(() => undefined);
    });
  }

  const expectedPrefix = path.join(tmpdir(), "esp-release-a-browser-");
  if (
    ownsProfileDirectory &&
    path.resolve(profileDirectory).startsWith(path.resolve(expectedPrefix))
  ) {
    await rm(profileDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
  }
}
