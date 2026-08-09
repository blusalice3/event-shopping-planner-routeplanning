/* global document, indexedDB */

import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import net from "node:net";
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

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const PROFILE_ID = /^(?:browser-tab|installed-pwa)$/u;
const TIMEOUT = 60_000;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const exactPath = async (value, type, label) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(value);
  const metadata = await lstat(resolved);
  if (
    metadata.isSymbolicLink() ||
    (type === "file" ? !metadata.isFile() : !metadata.isDirectory()) ||
    comparablePath(await realpath(resolved)) !== comparablePath(resolved)
  ) {
    throw new Error(`${label} is not an exact ${type}`);
  }
  return resolved;
};

const parseArguments = (arguments_) => {
  const allowed = [
    "--browser-path",
    "--current-dist",
    "--output",
    "--profile-dir",
    "--profile-id",
    "--source-sha",
  ];
  if (!Array.isArray(arguments_) || arguments_.length !== allowed.length * 2) {
    throw new Error("Managed IDB probe arguments are invalid");
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
      throw new Error("Managed IDB probe arguments are invalid");
    }
    values.set(flag, value);
  }
  if (
    !PROFILE_ID.test(values.get("--profile-id") ?? "") ||
    !SOURCE_SHA.test(values.get("--source-sha") ?? "")
  ) {
    throw new Error("Managed IDB probe identity is invalid");
  }
  return Object.freeze({
    browserPath: values.get("--browser-path"),
    currentDist: values.get("--current-dist"),
    outputPath: values.get("--output"),
    profileDir: values.get("--profile-dir"),
    profileId: values.get("--profile-id"),
    sourceSha: values.get("--source-sha"),
  });
};

const reservePort = async () =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port) || port < 1) {
          reject(new Error("Managed IDB preview port is invalid"));
        } else resolve(port);
      });
    });
  });

const startPreview = async (distRoot, port) => {
  const vite = await exactPath(
    path.join(root, "node_modules", "vite", "bin", "vite.js"),
    "file",
    "Managed IDB Vite CLI",
  );
  const output = [];
  const child = spawn(
    process.execPath,
    [
      vite,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--outDir",
      distRoot,
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const origin = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Managed IDB preview exited: ${Buffer.concat(output).toString("utf8")}`,
      );
    }
    try {
      const response = await fetch(origin, { redirect: "error" });
      if (response.status === 200) return Object.freeze({ child, origin });
    } catch {
      // The isolated loopback preview may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("Managed IDB preview did not become ready");
};

const stopPreview = async (preview) => {
  if (!preview || preview.child.exitCode !== null) return;
  preview.child.kill();
  await Promise.race([
    new Promise((resolve) => preview.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (preview.child.exitCode === null) preview.child.kill("SIGKILL");
};

const waitForApplication = async (page, origin) => {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
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
    throw new Error(`Managed IDB ${label} outcome was not observed`);
  }
  await page.evaluate((key) => localStorage.removeItem(key), storageKey);
  await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForFunction(
    () => Boolean(document.querySelector("#root")?.childElementCount),
    undefined,
    { timeout: TIMEOUT },
  );
  if (await recoveryVisible(page)) {
    throw new Error(`Managed IDB ${label} fixture did not cleanly retire`);
  }
  return Object.freeze({
    bodyTextSha256: sha256Bytes(Buffer.from(observation.bodyText, "utf8")),
    candidateCount: observation.candidateCount,
    rawRetained: observation.rawRetained,
    recoveryVisible: observation.recoveryVisible,
  });
};

const writeCreateOnly = async (outputPath, document) => {
  const resolved = path.resolve(outputPath);
  const bytes = canonicalJsonBytes(document);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await import("node:fs/promises").then(({ link }) =>
      link(temporary, resolved),
    );
    await unlink(temporary);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
};

export const runManagedDeviceIdbProbe = async (arguments_) => {
  const parsed = parseArguments(arguments_);
  const [browserPath, distRoot, profileDir] = await Promise.all([
    exactPath(parsed.browserPath, "file", "Managed IDB browser"),
    exactPath(parsed.currentDist, "directory", "Managed IDB artifact"),
    exactPath(parsed.profileDir, "directory", "Managed IDB profile"),
  ]);
  const capabilityBytes = await readFile(
    path.join(distRoot, "release-capabilities.json"),
  );
  const capability = parseJsonStrict(
    capabilityBytes.toString("utf8"),
    "Managed IDB release capability",
  );
  if (
    capability.buildId !== parsed.sourceSha ||
    capability.sourceSha !== parsed.sourceSha
  ) {
    throw new Error("Managed IDB artifact source differs");
  }
  const conflictFixtureBytes = await readFile(
    path.join(
      root,
      "src",
      "test",
      "fixtures",
      "d2389a0-orphan-runtime-fallback.json",
    ),
  );
  const conflictFixture = parseJsonStrict(
    conflictFixtureBytes.toString("utf8"),
    "Managed IDB conflict fixture",
  );
  const invalidFixture = Object.freeze({
    storageKey: "esp:idb-fallback:v1:eventMetadata:data:managed-device-invalid",
    rawValue: "{",
  });
  const port = await reservePort();
  let preview = null;
  let context = null;
  try {
    preview = await startPreview(distRoot, port);
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: browserPath,
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
      ],
    });
    const browser = context.browser();
    if (!browser) throw new Error("Managed IDB browser is absent");
    const browserClient = await browser.newBrowserCDPSession();
    const processInfo = await browserClient.send("SystemInfo.getProcessInfo");
    const browserIds = processInfo.processInfo
      .filter(({ type }) => type === "browser")
      .map(({ id }) => id);
    if (browserIds.length !== 1 || !Number.isSafeInteger(browserIds[0])) {
      throw new Error("Managed IDB browser process is ambiguous");
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await page.addInitScript(() => {
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
    await waitForApplication(page, preview.origin);
    const controller = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const scriptUrl = navigator.serviceWorker.controller?.scriptURL ?? null;
      return {
        scriptUrl,
        activeState: registration?.active?.state ?? null,
      };
    });
    if (
      controller.activeState !== "activated" ||
      controller.scriptUrl !== new URL("/sw.js", preview.origin).href
    ) {
      throw new Error("Managed IDB controller is not active");
    }
    const controllerResponse = await fetch(controller.scriptUrl, {
      cache: "no-store",
      redirect: "error",
    });
    const controllerBytes = Buffer.from(await controllerResponse.arrayBuffer());
    if (!controllerResponse.ok || controllerBytes.length === 0) {
      throw new Error("Managed IDB controller source is unavailable");
    }
    const databaseBefore = await collectDatabase(page);
    const invalid = await injectAndObserve({
      page,
      storageKey: invalidFixture.storageKey,
      rawValue: invalidFixture.rawValue,
      label: "invalid fixture",
    });
    const conflict = await injectAndObserve({
      page,
      storageKey: conflictFixture.orphanStorageKey,
      rawValue: conflictFixture.rawValue,
      label: "conflict fixture",
    });
    const databaseAfter = await collectDatabase(page);
    if (sha256Json(databaseBefore) !== sha256Json(databaseAfter)) {
      throw new Error("Managed IDB database changed during fault probes");
    }
    const cleanupCallCount = await page.evaluate(() =>
      Number.parseInt(
        sessionStorage.getItem(
          "__esp_internal__:managed-device-cleanup-calls:v1",
        ) ?? "0",
        10,
      ),
    );
    const document = Object.freeze({
      schemaVersion: 1,
      kind: "managed-device-idb-profile-probe/v1",
      profileId: parsed.profileId,
      sourceSha: parsed.sourceSha,
      profilePathSha256: sha256Bytes(Buffer.from(profileDir, "utf8")),
      browserProcessId: browserIds[0],
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
        callCount: cleanupCallCount,
        physicalDeleteCount: 0,
      }),
    });
    await writeCreateOnly(parsed.outputPath, document);
    return document;
  } finally {
    await context?.close().catch(() => undefined);
    await stopPreview(preview);
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runManagedDeviceIdbProbe(process.argv.slice(2));
