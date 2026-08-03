import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const PREVIEW_URL = process.env.ESP_PREVIEW_URL ?? "http://127.0.0.1:4173/";
const ROLLBACK_MODE = process.env.ESP_ROLLBACK_MODE === "true";
const requestedTransitionMode = process.env.ESP_TRANSITION_MODE?.trim() ?? "";
const TRANSITION_MODE = ROLLBACK_MODE
  ? "rollback"
  : requestedTransitionMode === "rollback" ||
      requestedTransitionMode === "forward"
    ? requestedTransitionMode
    : null;
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
const ROLLBACK_SAVE_EVENT_NAME = "RELEASE_A_ROLLBACK_SAVE";
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
    "Chrome or Edge was not found. Set CHROME_PATH to a Chromium executable.",
  );
};

const reservePort = async () =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a Chromium debugging port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.on("message", (rawMessage) => {
      const message = JSON.parse(rawMessage.toString());
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              `${message.error.message ?? "CDP command failed"} (${message.error.code ?? "unknown"})`,
            ),
          );
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }

      const listeners = this.listeners.get(message.method);
      if (!listeners) return;
      listeners.forEach((listener) => listener(message.params ?? {}));
    });
  }

  static async connect(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await withTimeout(
      new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      10_000,
      "Chromium DevTools connection",
    );
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  once(method, timeoutMs = 15_000) {
    return withTimeout(
      new Promise((resolve) => {
        const listeners = this.listeners.get(method) ?? new Set();
        const listener = (params) => {
          listeners.delete(listener);
          resolve(params);
        };
        listeners.add(listener);
        this.listeners.set(method, listeners);
      }),
      timeoutMs,
      method,
    );
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

  close() {
    const closeError = new Error("Chromium DevTools connection closed.");
    this.pending.forEach(({ reject }) => reject(closeError));
    this.pending.clear();
    this.socket.terminate();
  }
}

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return await response.json();
};

const waitForDevTools = async (port) => {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fetchJson(endpoint);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("Chromium DevTools endpoint did not start.");
};

const createTarget = async (port) => {
  const target = await fetchJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable"),
  ]);
  return { id: target.id, client };
};

const closeTarget = async (port, target) => {
  target.client.close();
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, {
      method: "PUT",
    });
  } catch {
    // The Chromium process shutdown path will close remaining targets.
  }
};

const installBrowserInstrumentation = async (client) => {
  const source = `(() => {
    const legacyKeys = new Set(${JSON.stringify(
      Object.keys(SYNTHETIC_LEGACY_SOURCES),
    )});
    const deleteCountKey = ${JSON.stringify(LEGACY_DELETE_COUNT_KEY)};
    const controllerChangeCountKey = ${JSON.stringify(
      CONTROLLER_CHANGE_COUNT_KEY,
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
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
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

const collectActiveServiceWorkerSourceEvidence = async (
  port,
  serviceWorkerUrl,
) => {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targetList = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const workerTargets = targetList
        .filter(
          ({ type, url, webSocketDebuggerUrl }) =>
            type === "service_worker" &&
            url === serviceWorkerUrl &&
            typeof webSocketDebuggerUrl === "string",
        )
        .reverse();
      for (const workerTarget of workerTargets) {
        const workerClient = await CdpClient.connect(
          workerTarget.webSocketDebuggerUrl,
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
          workerClient.close();
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

const ensureControlledApplication = async (client) => {
  await evaluate(client, "navigator.serviceWorker.ready.then(() => true)");
  await reload(client);
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
        .find((source) => /\\/assets\\/index-[^/]+\\.js$/.test(source));
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
      for (const key of legacySourceKeys) {
        const value = localStorage.getItem(key);
        legacySourceEvidence[key] = {
          present: value !== null,
          length: value?.length ?? 0,
          hash: await hash(value),
        };
      }
      return {
        legacySources: legacySourceEvidence,
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
          ["syncQueue", "eventMetadata", "eventLists"],
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
        return {
          dbVersion: database.version,
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
  const submitted = await evaluate(
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
      document.querySelector("#eventName")?.form?.requestSubmit();
      return true;
    })()`,
  );
  assert(submitted, "Rollback UI could not submit the new-list form.");
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
}

const ownsProfileDirectory = REQUESTED_PROFILE_DIRECTORY === null;
const profileDirectory = REQUESTED_PROFILE_DIRECTORY
  ? path.resolve(REQUESTED_PROFILE_DIRECTORY)
  : await mkdtemp(path.join(tmpdir(), "esp-release-a-browser-"));
if (REQUESTED_PROFILE_DIRECTORY) {
  await mkdir(profileDirectory, { recursive: true });
}
const debugPort = await reservePort();
const chromePath = await findChrome();
const standaloneBootstrapUrl = new URL("/manifest.webmanifest", PREVIEW_URL);
standaloneBootstrapUrl.hostname =
  standaloneBootstrapUrl.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
const chromium = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-background-mode",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--no-default-browser-check",
    "--no-first-run",
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDirectory}`,
    `--app=${standaloneBootstrapUrl.href}`,
  ],
  {
    stdio: "ignore",
    windowsHide: true,
  },
);
const targets = [];
let standaloneDebugPort = null;
let standaloneTarget = null;
let browserClient = null;

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
  const devToolsVersion = await waitForDevTools(debugPort);
  assert(
    typeof devToolsVersion.webSocketDebuggerUrl === "string",
    "Chromium browser DevTools target is missing.",
  );
  browserClient = await CdpClient.connect(devToolsVersion.webSocketDebuggerUrl);
  const startupTargets = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/list`,
  );
  const startupAppTarget = startupTargets.find(({ type }) => type === "page");
  assert(startupAppTarget, "Initial standalone app-window target is missing.");
  standaloneDebugPort = debugPort;
  standaloneTarget = {
    id: startupAppTarget.id,
    client: await CdpClient.connect(startupAppTarget.webSocketDebuggerUrl),
  };
  await Promise.all([
    standaloneTarget.client.send("Page.enable"),
    standaloneTarget.client.send("Runtime.enable"),
    standaloneTarget.client.send("Network.enable"),
  ]);
  await installBrowserInstrumentation(standaloneTarget.client);

  const primary = await createTarget(debugPort);
  targets.push(primary);
  await installBrowserInstrumentation(primary.client);
  await navigate(primary.client, PREVIEW_URL);
  await ensureControlledApplication(primary.client);
  if (TRANSITION_MODE === "rollback") {
    assert(
      (await readArtifactMarker()) === EXPECTED_FROM_ARTIFACT_ID,
      "Rollback profile does not contain the expected source artifact marker.",
    );
    await evaluate(
      primary.client,
      "navigator.serviceWorker.getRegistration().then((registration) => registration.update()).then(() => true)",
    );
    await delay(1_500);
    await reload(primary.client);
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
    const activeRollbackWorker = await collectActiveServiceWorkerSourceEvidence(
      debugPort,
      new URL("/sw.js", PREVIEW_URL).href,
    );
    assert(
      activeRollbackWorker.sha256 === EXPECTED_SERVICE_WORKER_SHA256,
      "Active rollback Service Worker does not match the expected artifact.",
    );
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

    await createRollbackSavedEventThroughUi(primary.client);
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
    assert(
      rollbackInstrumentation.controllerChangeCount >= 1,
      "Rollback did not observe a Service Worker controller change.",
    );
    assert(
      await writeArtifactMarker(TARGET_ARTIFACT_ID),
      "Rollback artifact marker could not be persisted.",
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          result: "PASS",
          mode: "rollback",
          browser: path.basename(chromePath),
          previewOrigin: new URL(PREVIEW_URL).origin,
          fromArtifactId: EXPECTED_FROM_ARTIFACT_ID,
          targetArtifactId: TARGET_ARTIFACT_ID,
          rollbackArtifactLoaded: true,
          indexSha256: previewIndexSha256,
          activeServiceWorker: activeRollbackWorker,
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
    await evaluate(
      primary.client,
      "navigator.serviceWorker.getRegistration().then((registration) => registration.update()).then(() => true)",
    );
    await delay(1_500);
    await reload(primary.client);
    await ensureControlledApplication(primary.client);
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
    await waitForExpression(
      primary.client,
      `Number.parseInt(
        sessionStorage.getItem(${JSON.stringify(
          CONTROLLER_CHANGE_COUNT_KEY,
        )}) ?? "0",
        10,
      ) >= 1`,
      "forward Service Worker controller change",
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
      debugPort,
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
    await navigate(standaloneTarget.client, PREVIEW_URL);
    await ensureControlledApplication(standaloneTarget.client);
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
      forwardInstrumentation.controllerChangeCount >= 1,
      "Forward update did not observe a Service Worker controller change.",
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
          browser: path.basename(chromePath),
          previewOrigin: new URL(PREVIEW_URL).origin,
          fromArtifactId: EXPECTED_FROM_ARTIFACT_ID,
          targetArtifactId: TARGET_ARTIFACT_ID,
          indexSha256: previewIndexSha256,
          activeServiceWorker: activeForwardWorker,
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
            unchanged: true,
            physicalDeleteCount: forwardInstrumentation.legacyDeleteCount,
          },
          rollbackSavedEvent: forwardDatabase.rollbackSavedEvent,
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

    const secondary = await createTarget(debugPort);
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
      debugPort,
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

    process.stdout.write(
      `${JSON.stringify(
        {
          result: "PREFLIGHT_PASS",
          observedAt: new Date().toISOString(),
          browser: path.basename(chromePath),
          browserVersion: devToolsVersion.Browser ?? null,
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
            unchanged: true,
            physicalDeleteCount: finalInstrumentation.legacyDeleteCount,
          },
          recoveryScreenVisible: finalProbe.recoveryVisible,
          startupMetricRecorded: finalProbe.startupReadyCount >= 1,
        },
        null,
        2,
      )}\n`,
    );
  }
} finally {
  if (standaloneTarget && standaloneDebugPort !== null) {
    await closeTarget(standaloneDebugPort, standaloneTarget).catch(
      () => undefined,
    );
  }
  await Promise.all(
    targets.map((target) => closeTarget(debugPort, target)),
  ).catch(() => undefined);
  if (browserClient) {
    await withTimeout(
      browserClient.send("Browser.close"),
      2_000,
      "Graceful Chromium shutdown request",
    ).catch(() => undefined);
    browserClient.close();
  }
  const waitForChromiumExit = async (timeoutMs) =>
    await withTimeout(
      new Promise((resolve) => {
        if (chromium.exitCode !== null || chromium.signalCode !== null) {
          resolve();
          return;
        }
        chromium.once("exit", resolve);
      }),
      timeoutMs,
      "Chromium shutdown",
    ).then(
      () => true,
      () => false,
    );
  if (!(await waitForChromiumExit(5_000))) {
    chromium.kill();
    await waitForChromiumExit(5_000);
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
