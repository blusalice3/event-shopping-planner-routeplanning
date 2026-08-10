import { createHash } from "node:crypto";
import { buildCanonicalBackup } from "./canonicalPublicFixtures.mjs";

export const PUBLIC_FOUNDATION_ADAPTER_CONTRACT = "public-artifact-surface-v1";

export const PUBLIC_FOUNDATION_SCENARIO_IDS = Object.freeze([
  "foundation-startup-cold",
  "foundation-startup-warm",
  "foundation-full-list",
  "foundation-indexeddb-current",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DATABASE_NAME = "EventShoppingPlannerDB";
const DATA_KEY = "data";
const CURRENT_DATABASE_VERSION = 5;
const MAX_FORWARD_DATABASE_VERSION = 7;
const REQUIRED_DATABASE_STORES = Object.freeze([
  "dayModes",
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "hallDefinitions",
  "hallRouteSettings",
  "mapData",
  "mapRotationSettings",
  "mapViewportSettings",
  "routeSettings",
  "syncQueue",
]);
const REQUIRED_ASSERTIONS = Object.freeze(["scenario-completed"]);
const REQUIRED_TELEMETRY = Object.freeze(["durationMs"]);
const COLD_STORAGE_TYPES =
  "cookies,indexeddb,local_storage,service_workers,cache_storage";
const FULL_LIST_CARDINALITY = 4;
const FULL_LIST_SEED = 8_090_501;
const INDEXED_DB_CARDINALITY = 4;
const INDEXED_DB_SEED = 8_090_502;

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameStringSet = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((value) => right.includes(value)) &&
  right.every((value) => left.includes(value));

const assertFiniteNonnegative = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite nonnegative number`);
  }
};

const assertTargetUrl = (targetUrl) => {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("Public foundation target URL is invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Public foundation target URL is not a safe artifact URL");
  }
  return parsed;
};

const assertArtifactBinding = (artifactBinding) => {
  if (
    !isRecord(artifactBinding) ||
    !SHA256_PATTERN.test(artifactBinding.archiveSha256 ?? "") ||
    !Array.isArray(artifactBinding.outputFiles) ||
    !artifactBinding.outputFiles.some(
      (file) =>
        isRecord(file) &&
        file.path === "static/release-identity.json" &&
        SHA256_PATTERN.test(file.sha256 ?? "") &&
        Number.isSafeInteger(file.size) &&
        file.size > 0,
    )
  ) {
    throw new Error(
      "Public foundation adapter requires a content-bound release identity",
    );
  }
};

const assertAdapterOptions = (options, scenarioId) => {
  if (
    !isRecord(options) ||
    options.scenarioId !== scenarioId ||
    options.adapterKind !== "foundation-browser" ||
    !Buffer.isBuffer(options.fixtureBytes) ||
    !sameStringSet(options.requiredAssertions, REQUIRED_ASSERTIONS) ||
    !sameStringSet(options.requiredTelemetry, REQUIRED_TELEMETRY) ||
    typeof options.warmup !== "boolean" ||
    !(
      options.sampleIndex === null ||
      (Number.isSafeInteger(options.sampleIndex) && options.sampleIndex >= 0)
    ) ||
    typeof options.page?.evaluate !== "function" ||
    typeof options.page?.goto !== "function" ||
    typeof options.page?.locator !== "function" ||
    typeof options.browserContext?.clearCookies !== "function" ||
    typeof options.browserContext?.newCDPSession !== "function"
  ) {
    throw new Error(
      `${scenarioId}: public foundation adapter input is invalid`,
    );
  }
  assertArtifactBinding(options.artifactBinding);
  return assertTargetUrl(options.targetUrl);
};

const executeBrowserOperation = async (input) => {
  const twoAnimationFrames = () =>
    new Promise((resolve) =>
      globalThis.requestAnimationFrame(() =>
        globalThis.requestAnimationFrame(resolve),
      ),
    );
  const readDatabaseRecord = () =>
    new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const openRequest = globalThis.indexedDB.open(input.databaseName);
      openRequest.onerror = () =>
        reject(openRequest.error ?? new Error("IndexedDB open failed"));
      openRequest.onblocked = () => reject(new Error("IndexedDB open blocked"));
      openRequest.onsuccess = () => {
        const database = openRequest.result;
        const storeNames = Array.from(database.objectStoreNames).sort();
        if (!database.objectStoreNames.contains(input.storeName)) {
          const version = database.version;
          database.close();
          resolve({
            durationMs: performance.now() - startedAt,
            matched: false,
            storeNames,
            version,
          });
          return;
        }
        const transaction = database.transaction(input.storeName, "readonly");
        const recordRequest = transaction
          .objectStore(input.storeName)
          .get(input.dataKey);
        recordRequest.onerror = () =>
          reject(recordRequest.error ?? new Error("IndexedDB read failed"));
        recordRequest.onsuccess = () => {
          let serialized = "";
          try {
            serialized = JSON.stringify(recordRequest.result);
          } catch {
            serialized = "";
          }
          const result = {
            durationMs: performance.now() - startedAt,
            matched:
              serialized.includes(input.eventName) &&
              serialized.includes(input.lastItemId),
            storeNames,
            version: database.version,
          };
          database.close();
          resolve(result);
        };
      };
    });

  if (input.operation === "standard-artifact") {
    const meta = (name) =>
      globalThis.document
        .querySelector(`meta[name="${name}"]`)
        ?.content.trim() ?? null;
    return {
      buildId: meta("event-shopping-planner-build-id"),
      releaseRole: meta("event-shopping-planner-release-role"),
      sourceSha: meta("event-shopping-planner-source-sha"),
      variantId: meta("event-shopping-planner-variant-id"),
    };
  }
  if (input.operation === "navigation-observation") {
    await twoAnimationFrames();
    const navigation = performance.getEntriesByType("navigation").at(-1);
    if (!navigation) return null;
    return {
      durationMs: Math.max(
        performance.now(),
        navigation.domComplete,
        navigation.loadEventEnd,
      ),
      navigationType: navigation.type,
      serviceWorkerControlled: navigator.serviceWorker?.controller !== null,
      serviceWorkerStartMs: navigation.workerStart,
    };
  }
  if (input.operation === "prime-state") {
    if (!("serviceWorker" in navigator) || !("caches" in globalThis)) {
      return { active: false, cacheCount: 0 };
    }
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Service Worker readiness timed out")),
          input.timeoutMs,
        ),
      ),
    ]);
    return {
      active: registration.active !== null,
      cacheCount: (await globalThis.caches.keys()).length,
    };
  }
  if (input.operation === "clock") {
    return performance.now();
  }
  if (input.operation === "clock-after-frames") {
    await twoAnimationFrames();
    return performance.now();
  }
  if (input.operation === "indexeddb-ready") {
    return readDatabaseRecord();
  }
  if (input.operation === "measure-indexeddb") {
    return readDatabaseRecord();
  }
  throw new Error("Unknown public foundation browser operation");
};

const runBrowserOperation = (page, request) =>
  page.evaluate(executeBrowserOperation, request);

const assertStandardArtifact = async (page) => {
  const identity = await runBrowserOperation(page, {
    operation: "standard-artifact",
  });
  if (
    !isRecord(identity) ||
    identity.releaseRole !== "standard" ||
    !GIT_SHA_PATTERN.test(identity.sourceSha ?? "") ||
    identity.buildId !== identity.sourceSha ||
    !SHA256_PATTERN.test(identity.variantId ?? "")
  ) {
    throw new Error(
      "Public foundation scenarios run only against a source-bound standard artifact",
    );
  }
};

const assertLongTaskObservation = (observation, label) => {
  if (!isRecord(observation) || observation.longTaskSupported !== true) {
    throw new Error(`${label}: Chromium long-task observation is unavailable`);
  }
  for (const metric of [
    "durationMs",
    "longTaskCount",
    "longTaskDurationMs",
    "maxLongTaskMs",
  ]) {
    assertFiniteNonnegative(observation[metric], `${label}.${metric}`);
  }
};

const readCdpTrace = async (session, stream) => {
  let serialized = "";
  try {
    for (;;) {
      const chunk = await session.send("IO.read", { handle: stream });
      if (!isRecord(chunk) || typeof chunk.data !== "string") {
        throw new Error("CDP trace stream returned an invalid chunk");
      }
      serialized += chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64").toString("utf8")
        : chunk.data;
      if (chunk.eof === true) break;
    }
  } finally {
    await session.send("IO.close", { handle: stream });
  }
  let trace;
  try {
    trace = JSON.parse(serialized);
  } catch {
    throw new Error("CDP trace stream is not valid JSON");
  }
  if (!isRecord(trace) || !Array.isArray(trace.traceEvents)) {
    throw new Error("CDP trace does not contain timeline events");
  }
  return trace.traceEvents;
};

const summarizeCdpLongTasks = (traceEvents) => {
  const rendererMainThreads = new Set(
    traceEvents
      .filter(
        (event) =>
          event?.ph === "M" &&
          event.name === "thread_name" &&
          event.args?.name === "CrRendererMain" &&
          Number.isSafeInteger(event.pid) &&
          Number.isSafeInteger(event.tid),
      )
      .map((event) => `${event.pid}:${event.tid}`),
  );
  if (rendererMainThreads.size === 0) {
    throw new Error("CDP trace did not identify the renderer main thread");
  }
  const longTaskDurations = traceEvents
    .filter(
      (event) =>
        event?.ph === "X" &&
        event.name === "RunTask" &&
        rendererMainThreads.has(`${event.pid}:${event.tid}`) &&
        typeof event.dur === "number" &&
        Number.isFinite(event.dur) &&
        event.dur >= 50_000,
    )
    .map((event) => event.dur / 1_000);
  return {
    longTaskCount: longTaskDurations.length,
    longTaskDurationMs: longTaskDurations.reduce(
      (total, duration) => total + duration,
      0,
    ),
    maxLongTaskMs: longTaskDurations.reduce(
      (maximum, duration) => Math.max(maximum, duration),
      0,
    ),
    longTaskSupported: true,
  };
};

const startCdpLongTaskTrace = async ({ browserContext, page }) => {
  const session = await browserContext.newCDPSession(page);
  try {
    await session.send("Tracing.start", {
      categories: "devtools.timeline",
      options: "record-as-much-as-possible",
      transferMode: "ReturnAsStream",
    });
  } catch (error) {
    if (typeof session.detach === "function") await session.detach();
    throw error;
  }
  let stopPromise = null;
  return {
    stop() {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        try {
          const completed = new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("CDP trace completion timed out")),
              30_000,
            );
            session.once("Tracing.tracingComplete", (event) => {
              clearTimeout(timeout);
              resolve(event);
            });
          });
          await session.send("Tracing.end");
          const completion = await completed;
          if (!isRecord(completion) || typeof completion.stream !== "string") {
            throw new Error("CDP trace did not return a stream");
          }
          return summarizeCdpLongTasks(
            await readCdpTrace(session, completion.stream),
          );
        } finally {
          if (typeof session.detach === "function") await session.detach();
        }
      })();
      return stopPromise;
    },
  };
};

const measureWithCdpLongTasks = async ({ browserContext, measure, page }) => {
  const trace = await startCdpLongTaskTrace({ browserContext, page });
  try {
    const measured = await measure();
    return { ...measured, ...(await trace.stop()) };
  } catch (error) {
    await trace.stop().catch(() => {});
    throw error;
  }
};

const clearColdBrowserState = async ({ browserContext, page, target }) => {
  await browserContext.clearCookies();
  const session = await browserContext.newCDPSession(page);
  try {
    await session.send("Network.enable");
    await session.send("Network.clearBrowserCache");
    await session.send("Storage.clearDataForOrigin", {
      origin: target.origin,
      storageTypes: COLD_STORAGE_TYPES,
    });
    const usage = await session.send("Storage.getUsageAndQuota", {
      origin: target.origin,
    });
    const dirtyStorage = (usage?.usageBreakdown ?? []).filter(
      ({ storageType, usage: usedBytes }) =>
        ["cache_storage", "indexeddb"].includes(storageType) && usedBytes !== 0,
    );
    if (dirtyStorage.length > 0) {
      throw new Error("Cold foundation storage was not cleared");
    }
  } finally {
    if (typeof session.detach === "function") await session.detach();
  }
};

const waitForApplication = async (page) => {
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.locator("#root").waitFor({ state: "attached" });
  await page.waitForFunction(
    () =>
      (globalThis.document.querySelector("#root")?.childElementCount ?? 0) > 0,
  );
};

const assertNavigationResponse = (response, label) => {
  if (!response || typeof response.ok !== "function" || !response.ok()) {
    throw new Error(`${label}: standard artifact navigation failed`);
  }
};

const navigateApplication = async ({ page, target }) => {
  const response = await page.goto(target.toString(), { waitUntil: "load" });
  assertNavigationResponse(response, "Foundation navigation");
  await waitForApplication(page);
  await assertStandardArtifact(page);
  const observation = await runBrowserOperation(page, {
    operation: "navigation-observation",
  });
  if (!isRecord(observation)) {
    throw new Error("Foundation navigation timing is unavailable");
  }
  assertFiniteNonnegative(
    observation.durationMs,
    "Foundation navigation.durationMs",
  );
  assertFiniteNonnegative(
    observation.serviceWorkerStartMs,
    "Foundation navigation.serviceWorkerStartMs",
  );
  if (observation.navigationType !== "navigate") {
    throw new Error("Cold/prime navigation did not use navigation timing");
  }
  return observation;
};

const reloadApplication = async (page) => {
  const response = await page.reload({ waitUntil: "load" });
  assertNavigationResponse(response, "Foundation reload");
  await waitForApplication(page);
  await assertStandardArtifact(page);
  const observation = await runBrowserOperation(page, {
    operation: "navigation-observation",
  });
  if (!isRecord(observation)) {
    throw new Error("Foundation reload timing is unavailable");
  }
  assertFiniteNonnegative(
    observation.durationMs,
    "Foundation reload.durationMs",
  );
  assertFiniteNonnegative(
    observation.serviceWorkerStartMs,
    "Foundation reload.serviceWorkerStartMs",
  );
  if (
    observation.navigationType !== "reload" ||
    observation.serviceWorkerControlled !== true
  ) {
    throw new Error(
      "Warm foundation reload is not controlled by the primed Service Worker",
    );
  }
  return observation;
};

const buildTrackedFixtureBinding = (scenarioId, fixtureBytes) => {
  const digest = sha256Bytes(fixtureBytes);
  return {
    adapterContract: PUBLIC_FOUNDATION_ADAPTER_CONTRACT,
    fixturePayload: {
      generator: `${scenarioId}-tracked-fixture-v1`,
      seed: 0,
      cardinality: 1,
      payloadSha256: digest,
      semanticSha256: digest,
    },
    faultInjection: null,
    setup: null,
  };
};

const buildGeneratedFixtureBinding = ({
  backup,
  generator,
  seed,
  cardinality,
}) => ({
  adapterContract: PUBLIC_FOUNDATION_ADAPTER_CONTRACT,
  fixturePayload: {
    generator,
    seed,
    cardinality,
    payloadSha256: backup.payloadSha256,
    semanticSha256: backup.semanticSha256,
  },
  faultInjection: null,
  setup: null,
});

const resultFromMeasurement = ({ durationMs, executionBinding }) => {
  assertFiniteNonnegative(durationMs, "Public foundation durationMs");
  return {
    metrics: { durationMs },
    assertions: { "scenario-completed": true },
    executionBinding,
  };
};

const indexedDbRequest = ({ eventName, lastItemId, operation }) => ({
  operation,
  databaseName: DATABASE_NAME,
  dataKey: DATA_KEY,
  storeName: "eventLists",
  eventName,
  lastItemId,
});

const waitForIndexedDbFixture = async ({ page, eventName, lastItemId }) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observation = await runBrowserOperation(
      page,
      indexedDbRequest({
        eventName,
        lastItemId,
        operation: "indexeddb-ready",
      }),
    );
    if (observation?.matched === true) return observation;
    await page.waitForTimeout(50);
  }
  throw new Error(
    "Public backup fixture was not committed to current IndexedDB",
  );
};

const restoreBackupThroughPublicUi = async ({
  backup,
  browserContext,
  eventName,
  page,
  target,
}) => {
  await clearColdBrowserState({ browserContext, page, target });
  await navigateApplication({ page, target });
  await page
    .locator('input[aria-label="バックアップファイルを選択"]')
    .setInputFiles({
      name: "foundation-public-performance-backup.json",
      mimeType: "application/json",
      buffer: backup.bytes,
    });
  const dialog = page.getByRole("dialog", {
    name: "バックアップからイベントを復元",
  });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("radio", { name: /同名で置換/ }).check();
  await dialog.getByRole("button", { name: "置換して復元" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: eventName }).waitFor({
    state: "visible",
  });
  const items = backup.document.data.eventLists[eventName];
  const lastItemId = items.at(-1)?.id;
  if (typeof lastItemId !== "string") {
    throw new Error("Generated public backup contains no measurable item");
  }
  await waitForIndexedDbFixture({ page, eventName, lastItemId });
  return { lastItemId };
};

const coldStartupAdapter = async (options) => {
  const target = assertAdapterOptions(options, "foundation-startup-cold");
  await clearColdBrowserState({
    browserContext: options.browserContext,
    page: options.page,
    target,
  });
  const observation = await measureWithCdpLongTasks({
    browserContext: options.browserContext,
    page: options.page,
    measure: () => navigateApplication({ page: options.page, target }),
  });
  assertLongTaskObservation(observation, "Foundation cold startup");
  if (
    observation.serviceWorkerControlled !== false ||
    observation.serviceWorkerStartMs !== 0
  ) {
    throw new Error("Cold startup was served by a pre-existing Service Worker");
  }
  return resultFromMeasurement({
    durationMs: observation.durationMs,
    executionBinding: buildTrackedFixtureBinding(
      options.scenarioId,
      options.fixtureBytes,
    ),
  });
};

const warmStartupAdapter = async (options) => {
  const target = assertAdapterOptions(options, "foundation-startup-warm");
  await clearColdBrowserState({
    browserContext: options.browserContext,
    page: options.page,
    target,
  });
  await navigateApplication({ page: options.page, target });
  const primeState = await runBrowserOperation(options.page, {
    operation: "prime-state",
    timeoutMs: 15_000,
  });
  if (primeState?.active !== true || primeState.cacheCount < 1) {
    throw new Error(
      "Warm startup prime did not establish an active cached Service Worker",
    );
  }
  const observation = await measureWithCdpLongTasks({
    browserContext: options.browserContext,
    page: options.page,
    measure: () => reloadApplication(options.page),
  });
  assertLongTaskObservation(observation, "Foundation warm startup");
  return resultFromMeasurement({
    durationMs: observation.durationMs,
    executionBinding: buildTrackedFixtureBinding(
      options.scenarioId,
      options.fixtureBytes,
    ),
  });
};

const fullListAdapter = async (options) => {
  const target = assertAdapterOptions(options, "foundation-full-list");
  const eventName = "公開UIフルリスト性能計測";
  const backup = buildCanonicalBackup({
    eventName,
    rowCount: FULL_LIST_CARDINALITY,
    seed: FULL_LIST_SEED,
  });
  const { lastItemId } = await restoreBackupThroughPublicUi({
    backup,
    browserContext: options.browserContext,
    eventName,
    page: options.page,
    target,
  });
  await options.page.getByRole("button", { name: "イベント一覧" }).click();
  await options.page
    .getByRole("heading", { name: "保存済みの即売会リスト" })
    .waitFor({ state: "visible" });
  const observation = await measureWithCdpLongTasks({
    browserContext: options.browserContext,
    page: options.page,
    measure: async () => {
      const startedAt = await runBrowserOperation(options.page, {
        operation: "clock",
      });
      assertFiniteNonnegative(startedAt, "Foundation full list start clock");
      await options.page.getByText(eventName, { exact: true }).last().click();
      await options.page
        .locator(`[data-item-id="${lastItemId}"]`)
        .waitFor({ state: "visible" });
      const renderedCount = await options.page
        .locator("[data-item-id]")
        .count();
      if (renderedCount !== FULL_LIST_CARDINALITY) {
        throw new Error(
          "Full-list public UI did not render the canonical cardinality",
        );
      }
      const finishedAt = await runBrowserOperation(options.page, {
        operation: "clock-after-frames",
      });
      assertFiniteNonnegative(finishedAt, "Foundation full list finish clock");
      if (finishedAt < startedAt) {
        throw new Error("Foundation full-list clock moved backwards");
      }
      return { durationMs: finishedAt - startedAt };
    },
  });
  assertLongTaskObservation(observation, "Foundation full list");
  return resultFromMeasurement({
    durationMs: observation.durationMs,
    executionBinding: buildGeneratedFixtureBinding({
      backup,
      generator: "public-backup-full-list-v1",
      seed: FULL_LIST_SEED,
      cardinality: FULL_LIST_CARDINALITY,
    }),
  });
};

const indexedDbCurrentAdapter = async (options) => {
  const target = assertAdapterOptions(options, "foundation-indexeddb-current");
  const eventName = "公開UI IndexedDB性能計測";
  const backup = buildCanonicalBackup({
    eventName,
    rowCount: INDEXED_DB_CARDINALITY,
    seed: INDEXED_DB_SEED,
  });
  const { lastItemId } = await restoreBackupThroughPublicUi({
    backup,
    browserContext: options.browserContext,
    eventName,
    page: options.page,
    target,
  });
  const observation = await measureWithCdpLongTasks({
    browserContext: options.browserContext,
    page: options.page,
    measure: () =>
      runBrowserOperation(
        options.page,
        indexedDbRequest({
          eventName,
          lastItemId,
          operation: "measure-indexeddb",
        }),
      ),
  });
  assertLongTaskObservation(observation, "Foundation current IndexedDB");
  if (
    observation.matched !== true ||
    observation.version < CURRENT_DATABASE_VERSION ||
    observation.version > MAX_FORWARD_DATABASE_VERSION ||
    !sameStringSet(observation.storeNames, REQUIRED_DATABASE_STORES)
  ) {
    throw new Error(
      "Current IndexedDB measurement did not read the canonical committed result",
    );
  }
  return resultFromMeasurement({
    durationMs: observation.durationMs,
    executionBinding: buildGeneratedFixtureBinding({
      backup,
      generator: "public-backup-indexeddb-current-v1",
      seed: INDEXED_DB_SEED,
      cardinality: INDEXED_DB_CARDINALITY,
    }),
  });
};

export const publicFoundationScenarioAdapters = Object.freeze({
  "foundation-startup-cold": coldStartupAdapter,
  "foundation-startup-warm": warmStartupAdapter,
  "foundation-full-list": fullListAdapter,
  "foundation-indexeddb-current": indexedDbCurrentAdapter,
});

if (
  JSON.stringify(Object.keys(publicFoundationScenarioAdapters)) !==
  JSON.stringify(PUBLIC_FOUNDATION_SCENARIO_IDS)
) {
  throw new Error("Public foundation adapter dispatch is incomplete");
}
