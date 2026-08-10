/* global document, indexedDB */

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { writeDeploymentBindingCreateOnly } from "../provider/produce-deployment-binding.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const TIMEOUT = 60_000;
const MAXIMUM_BYTES = 32 * 1024 * 1024;
const CLIENT_IDS = Object.freeze(["browser-tab", "installed-pwa"]);

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const exactFile = async (value, label) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(value);
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    comparablePath(await realpath(resolved)) !== comparablePath(resolved) ||
    metadata.size < 1 ||
    metadata.size > MAXIMUM_BYTES
  ) {
    throw new Error(`${label} is not an exact bounded file`);
  }
  return resolved;
};

const readCanonicalJson = async (value, label, { canonical = true } = {}) => {
  const resolved = await exactFile(value, label);
  const bytes = await readFile(resolved);
  const document = parseJsonStrict(bytes.toString("utf8"), label);
  if (canonical && !canonicalJsonBytes(document).equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
  return document;
};

export const parseManagedDeviceLiveProbeArguments = (arguments_) => {
  const allowed = ["--launch", "--output", "--request"];
  if (!Array.isArray(arguments_) || arguments_.length !== allowed.length * 2) {
    throw new Error("Managed device live probe arguments are invalid");
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Managed device live probe arguments are invalid");
    }
    values.set(flag, value);
  }
  return Object.freeze({
    launchPath: values.get("--launch"),
    outputPath: values.get("--output"),
    requestPath: values.get("--request"),
  });
};

const waitForApplication = async (page, productionUrl) => {
  const origin = new URL(productionUrl).origin;
  if (new URL(page.url()).origin !== origin) {
    await page.goto(productionUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
  }
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector("#root")?.childElementCount) &&
      Boolean(navigator.serviceWorker.controller),
    undefined,
    { timeout: TIMEOUT },
  );
};

const collectDatabase = async (page) =>
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("EventShoppingPlannerDB");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const names = [...database.objectStoreNames];
      const transaction = database.transaction(names, "readonly");
      const read = (storeName, key) =>
        new Promise((resolve, reject) => {
          const request = transaction.objectStore(storeName).get(key);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result ?? null);
        });
      const journal = await read(
        "syncQueue",
        "__esp_internal__:migration:v1:legacy-local-storage",
      );
      const archive = journal?.archiveKey
        ? await read("syncQueue", journal.archiveKey)
        : null;
      const checkpoint = await read(
        "syncQueue",
        "__esp_internal__:checkpoint:v1:eventMetadata:data",
      );
      const syncQueuePayload = await read("syncQueue", "data");
      const stores = names
        .map((name) => {
          const store = transaction.objectStore(name);
          return {
            indexes: [...store.indexNames].sort(),
            keyPath: store.keyPath,
            name,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        name: database.name,
        version: database.version,
        stores,
        raw: { archive, checkpoint, journal, syncQueuePayload },
      };
    } finally {
      database.close();
    }
  });

const recoveryVisible = async (page) =>
  await page.evaluate(() =>
    [...document.querySelectorAll("h1, h2")].some((heading) =>
      heading.textContent?.includes("保存データを安全に読み込めません"),
    ),
  );

const injectAndObserve = async ({ page, storageKey, rawValue, label }) => {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: storageKey,
    value: rawValue,
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("h1, h2")].some((heading) =>
        heading.textContent?.includes("保存データを安全に読み込めません"),
      ),
    undefined,
    { timeout: TIMEOUT },
  );
  const observation = await page.evaluate((key) => {
    const bodyText = document.body.textContent ?? "";
    return {
      rawRetained: localStorage.getItem(key),
      candidateCount: document.querySelectorAll(
        'input[name="persistence-recovery-candidate"]',
      ).length,
      recoveryVisible: [...document.querySelectorAll("h1, h2")].some(
        (heading) =>
          heading.textContent?.includes("保存データを安全に読み込めません"),
      ),
      bodyText,
    };
  }, storageKey);
  if (
    observation.recoveryVisible !== true ||
    observation.rawRetained !== rawValue
  ) {
    throw new Error(`Managed device ${label} outcome was not observed`);
  }
  await page.evaluate((key) => localStorage.removeItem(key), storageKey);
  await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForFunction(
    () => Boolean(document.querySelector("#root")?.childElementCount),
    undefined,
    { timeout: TIMEOUT },
  );
  if (await recoveryVisible(page)) {
    throw new Error(`Managed device ${label} fixture did not retire`);
  }
  return Object.freeze({
    bodyTextSha256: sha256Bytes(Buffer.from(observation.bodyText, "utf8")),
    candidateCount: observation.candidateCount,
    rawRetained: observation.rawRetained,
    recoveryVisible: observation.recoveryVisible,
  });
};

const browserVersion = (product) => {
  const match = /\/(\d+\.\d+\.\d+\.\d+)$/u.exec(product ?? "");
  if (!match) throw new Error("Managed device CDP browser version is invalid");
  return match[1];
};

const collectCapability = async (page) =>
  await page.evaluate(async () => {
    const response = await fetch("/release-capabilities.json", {
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("release capability is unavailable");
    return [...new Uint8Array(await response.arrayBuffer())];
  });

const observeClient = async ({
  launch,
  profile,
  request,
  conflictFixture,
  conflictFixtureBytes,
}) => {
  const browser = await chromium.connectOverCDP(launch.cdpEndpoint);
  try {
    const browserClient = await browser.newBrowserCDPSession();
    const [version, commandLine, processInfo] = await Promise.all([
      browserClient.send("Browser.getVersion"),
      browserClient.send("Browser.getBrowserCommandLine"),
      browserClient.send("SystemInfo.getProcessInfo"),
    ]);
    const browserProcessIds = processInfo.processInfo
      .filter(({ type }) => type === "browser")
      .map(({ id }) => id);
    if (
      browserProcessIds.length !== 1 ||
      browserProcessIds[0] !== launch.processId
    ) {
      throw new Error("Managed device CDP/CIM process identity differs");
    }
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      throw new Error("Managed device CDP context is ambiguous");
    }
    const context = contexts[0];
    await context.addInitScript(() => {
      const legacyKeys = new Set([
        "eventShoppingLists",
        "eventMetadata",
        "executeModeItems",
        "dayModes",
        "mapData",
        "mapRotationSettings",
        "routeSettings",
        "hallDefinitions",
        "hallRouteSettings",
        "mapViewportSettings",
        "syncQueue",
      ]);
      const originalRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function removeItem(key) {
        if (this === localStorage && legacyKeys.has(String(key))) {
          const count = Number.parseInt(
            sessionStorage.getItem(
              "__esp_internal__:managed-device-cleanup-calls:v1",
            ) ?? "0",
            10,
          );
          sessionStorage.setItem(
            "__esp_internal__:managed-device-cleanup-calls:v1",
            String(count + 1),
          );
        }
        return originalRemove.call(this, key);
      };
    });
    const productionOrigin = new URL(
      request.externalPolicy.managedDeviceExecution.installedPwaLaunchAuthority
        .installUrl,
    ).origin;
    const candidatePages = context
      .pages()
      .filter((page) => new URL(page.url()).origin === productionOrigin);
    const page = candidatePages[0] ?? context.pages()[0];
    if (!page) throw new Error("Managed device production page is absent");
    await waitForApplication(
      page,
      request.externalPolicy.managedDeviceExecution.installedPwaLaunchAuthority
        .installUrl,
    );
    if (
      context
        .pages()
        .filter(
          (candidate) => new URL(candidate.url()).origin === productionOrigin,
        ).length !== 1
    ) {
      throw new Error("Managed device production target is ambiguous");
    }
    const controller = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        scriptUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
        activeState: registration?.active?.state ?? null,
      };
    });
    const controllerResponse = await page.request.get(controller.scriptUrl, {
      failOnStatusCode: true,
      maxRedirects: 0,
    });
    const controllerBytes = await controllerResponse.body();
    const capabilityBytes = Buffer.from(await collectCapability(page));
    const deployment = new URL(
      request.releaseState.activeBinding.deploymentUrl,
    );
    const immutableCapabilityUrl = new URL(
      "/release-capabilities.json",
      deployment,
    ).href;
    const controllerUrl = new URL(controller.scriptUrl);
    const immutableControllerUrl = new URL(
      `${controllerUrl.pathname}${controllerUrl.search}`,
      deployment,
    ).href;
    const [immutableCapabilityResponse, immutableControllerResponse] =
      await Promise.all([
        page.request.get(immutableCapabilityUrl, {
          failOnStatusCode: true,
          maxRedirects: 0,
        }),
        page.request.get(immutableControllerUrl, {
          failOnStatusCode: true,
          maxRedirects: 0,
        }),
      ]);
    if (
      immutableCapabilityResponse.url() !== immutableCapabilityUrl ||
      immutableControllerResponse.url() !== immutableControllerUrl
    ) {
      throw new Error("Managed device immutable deployment redirected");
    }
    const [immutableCapabilityBytes, immutableControllerBytes] =
      await Promise.all([
        immutableCapabilityResponse.body(),
        immutableControllerResponse.body(),
      ]);
    if (
      !immutableCapabilityBytes.equals(capabilityBytes) ||
      !immutableControllerBytes.equals(controllerBytes)
    ) {
      throw new Error("Managed device immutable deployment bytes differ");
    }
    await context.setOffline(true);
    let offlineCapabilityBytes;
    try {
      offlineCapabilityBytes = Buffer.from(await collectCapability(page));
    } finally {
      await context.setOffline(false);
    }
    const databaseBefore = await collectDatabase(page);
    const invalidFixture = Object.freeze({
      storageKey:
        "esp:idb-fallback:v1:eventMetadata:data:managed-device-invalid",
      rawValue: "{",
    });
    const invalid = await injectAndObserve({
      page,
      storageKey: invalidFixture.storageKey,
      rawValue: invalidFixture.rawValue,
      label: `${profile.id} invalid fixture`,
    });
    const conflict = await injectAndObserve({
      page,
      storageKey: conflictFixture.orphanStorageKey,
      rawValue: conflictFixture.rawValue,
      label: `${profile.id} conflict fixture`,
    });
    const databaseAfter = await collectDatabase(page);
    if (sha256Json(databaseBefore) !== sha256Json(databaseAfter)) {
      throw new Error("Managed device database changed during fault probes");
    }
    const runtime = await page.evaluate(() => ({
      cleanupCallCount: Number.parseInt(
        sessionStorage.getItem(
          "__esp_internal__:managed-device-cleanup-calls:v1",
        ) ?? "0",
        10,
      ),
      legacyRawValues: Object.fromEntries(
        [
          "dayModes",
          "eventMetadata",
          "eventShoppingLists",
          "executeModeItems",
          "hallDefinitions",
          "hallRouteSettings",
          "mapData",
          "mapRotationSettings",
          "mapViewportSettings",
          "routeSettings",
          "syncQueue",
        ].map((key) => [key, localStorage.getItem(key)]),
      ),
    }));
    const profilePathSha256 = sha256Bytes(
      Buffer.from(profile.profilePath, "utf8"),
    );
    return Object.freeze({
      profileId: profile.id,
      clientKind: profile.clientKind,
      installedMode: profile.installedMode,
      profileRootSha256: sha256Bytes(Buffer.from(profile.profileRoot, "utf8")),
      profilePathSha256,
      process: Object.freeze({
        processId: launch.processId,
        executableSha256: launch.executableSha256,
        cimCommandLineBytesBase64: launch.cimCommandLineBytesBase64,
      }),
      cdp: Object.freeze({
        browserArgumentsBytesBase64: canonicalJsonBytes(
          commandLine.arguments,
        ).toString("base64"),
        browserVersion: browserVersion(version.product),
        targetType: "page",
        targetUrl: page.url(),
      }),
      pwa: Object.freeze({
        capabilityBytesBase64: capabilityBytes.toString("base64"),
        offlineCapabilityBytesBase64: offlineCapabilityBytes.toString("base64"),
        controller: Object.freeze({
          activeState: controller.activeState,
          scriptUrl: controller.scriptUrl,
          sourceBytesBase64: controllerBytes.toString("base64"),
        }),
        immutableDeployment: Object.freeze({
          deploymentUrl: deployment.href,
          capabilityUrl: immutableCapabilityUrl,
          capabilityBytesBase64: immutableCapabilityBytes.toString("base64"),
          controllerUrl: immutableControllerUrl,
          controllerBytesBase64: immutableControllerBytes.toString("base64"),
        }),
        legacyRawValues: runtime.legacyRawValues,
      }),
      idbRawReceipt: Object.freeze({
        schemaVersion: 1,
        kind: "managed-device-idb-profile-probe/v1",
        profileId: profile.id,
        sourceSha: request.releaseState.activeBinding.sourceSha,
        profilePathSha256,
        browserProcessId: launch.processId,
        controller: Object.freeze({
          scriptUrl: controller.scriptUrl,
          sourceBytesBase64: controllerBytes.toString("base64"),
        }),
        database: databaseAfter,
        invalid: Object.freeze({
          fixture: invalidFixture,
          observation: invalid,
        }),
        conflict: Object.freeze({
          fixture: conflictFixture,
          fixtureBytesBase64: conflictFixtureBytes.toString("base64"),
          observation: conflict,
        }),
        cleanup: Object.freeze({
          callCount: runtime.cleanupCallCount,
          physicalDeleteCount: 0,
        }),
      }),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const writeCreateOnly = async (outputPath, document) => {
  const resolved = path.resolve(outputPath);
  const bytes = canonicalJsonBytes(document);
  await writeDeploymentBindingCreateOnly(resolved, bytes);
};

export const runManagedDeviceLiveProbe = async (arguments_) => {
  const parsed = parseManagedDeviceLiveProbeArguments(arguments_);
  const [request, launch, conflictFixtureBytes] = await Promise.all([
    readCanonicalJson(parsed.requestPath, "Managed device stage request"),
    readCanonicalJson(parsed.launchPath, "Managed device launch authority", {
      canonical: false,
    }),
    readFile(
      path.join(
        root,
        "src",
        "test",
        "fixtures",
        "d2389a0-orphan-runtime-fallback.json",
      ),
    ),
  ]);
  const conflictFixture = parseJsonStrict(
    conflictFixtureBytes.toString("utf8"),
    "Managed device conflict fixture",
  );
  const profiles =
    request.externalPolicy?.managedDeviceExecution?.deviceProfiles;
  if (
    request.kind !== "managed-device-stage-execution-request/v1" ||
    !Array.isArray(profiles) ||
    profiles.length !== 2 ||
    launch.kind !== "managed-device-live-launch-authority/v1" ||
    !["initial", "reopened"].includes(launch.cycle) ||
    !Array.isArray(launch.clients) ||
    launch.clients.length !== 2 ||
    !CLIENT_IDS.every(
      (id, index) =>
        launch.clients[index].profileId === id && profiles[index].id === id,
    )
  ) {
    throw new Error("Managed device live probe authority differs");
  }
  const clients = await Promise.all(
    profiles.map((profile, index) =>
      observeClient({
        launch: launch.clients[index],
        profile,
        request,
        conflictFixture,
        conflictFixtureBytes,
      }),
    ),
  );
  const document = Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-live-cycle-observation/v1",
    cycle: launch.cycle,
    clients,
  });
  await writeCreateOnly(parsed.outputPath, document);
  return document;
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runManagedDeviceLiveProbe(process.argv.slice(2));
