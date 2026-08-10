import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { writeDeploymentBindingCreateOnly } from "../provider/produce-deployment-binding.mjs";
import { deriveManagedDeviceLegacySentinelValues } from "./managed-device-stage-authority.mjs";

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

const readJson = async (value, label, { canonical = true } = {}) => {
  const resolved = await exactFile(value, label);
  const bytes = await readFile(resolved);
  const document = parseJsonStrict(bytes.toString("utf8"), label);
  if (canonical && !canonicalJsonBytes(document).equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
  return document;
};

export const parseManagedDeviceLegacySentinelArguments = (arguments_) => {
  const allowed = ["--launch", "--output", "--request"];
  if (!Array.isArray(arguments_) || arguments_.length !== allowed.length * 2) {
    throw new Error("Managed device legacy sentinel arguments are invalid");
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
      throw new Error("Managed device legacy sentinel arguments are invalid");
    }
    values.set(flag, value);
  }
  return Object.freeze({
    launchPath: values.get("--launch"),
    outputPath: values.get("--output"),
    requestPath: values.get("--request"),
  });
};

const prepareProfile = async ({
  launch,
  profile,
  productionOrigin,
  activationEventHash,
}) => {
  const endpoint = new URL(launch.cdpEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("Managed device legacy sentinel CDP endpoint differs");
  }
  const browser = await chromium.connectOverCDP(endpoint.href);
  try {
    const browserSession = await browser.newBrowserCDPSession();
    const [commandLine, processInfo] = await Promise.all([
      browserSession.send("Browser.getBrowserCommandLine"),
      browserSession.send("SystemInfo.getProcessInfo"),
    ]);
    const arguments_ = commandLine.arguments.map((value) =>
      value.toLowerCase(),
    );
    const browserProcessIds = processInfo.processInfo
      .filter(({ type }) => type === "browser")
      .map(({ id }) => id);
    if (
      browserProcessIds.length !== 1 ||
      browserProcessIds[0] !== launch.processId ||
      !arguments_.includes(
        `--user-data-dir=${profile.profileRoot.toLowerCase()}`,
      ) ||
      !arguments_.includes(
        `--profile-directory=${profile.profileName.toLowerCase()}`,
      ) ||
      arguments_.some(
        (value) => value.startsWith("--app=") || value.startsWith("--app-id="),
      )
    ) {
      throw new Error("Managed device legacy sentinel process differs");
    }
    const contexts = browser.contexts();
    if (contexts.length !== 1 || contexts[0].pages().length !== 1) {
      throw new Error("Managed device legacy sentinel context differs");
    }
    const page = contexts[0].pages()[0];
    if (page.url() !== "about:blank") {
      throw new Error("Managed device legacy sentinel page is not blank");
    }
    const session = await contexts[0].newCDPSession(page);
    await session.send("DOMStorage.enable");
    const storageId = {
      securityOrigin: productionOrigin,
      isLocalStorage: true,
    };
    const rawValues = deriveManagedDeviceLegacySentinelValues({
      activationEventHash,
      profileId: profile.id,
    });
    await Promise.all(
      Object.entries(rawValues).map(([key, value]) =>
        session.send("DOMStorage.setDOMStorageItem", {
          storageId,
          key,
          value,
        }),
      ),
    );
    const observed = Object.fromEntries(
      (await session.send("DOMStorage.getDOMStorageItems", { storageId }))
        .entries,
    );
    if (
      Object.entries(rawValues).some(([key, value]) => observed[key] !== value)
    ) {
      throw new Error("Managed device legacy sentinel readback differs");
    }
    return Object.freeze({
      profileId: profile.id,
      rawValues,
      rawValuesSha256: sha256Json(rawValues),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
};

export const prepareManagedDeviceLegacySentinels = async (arguments_) => {
  const parsed = parseManagedDeviceLegacySentinelArguments(arguments_);
  const [request, launch] = await Promise.all([
    readJson(parsed.requestPath, "Managed device stage request"),
    readJson(parsed.launchPath, "Managed device sentinel launch", {
      canonical: false,
    }),
  ]);
  const profiles =
    request.externalPolicy?.managedDeviceExecution?.deviceProfiles;
  if (
    request.kind !== "managed-device-stage-execution-request/v1" ||
    !Array.isArray(profiles) ||
    profiles.length !== 2 ||
    launch.kind !== "managed-device-legacy-sentinel-launch/v1" ||
    !Array.isArray(launch.clients) ||
    launch.clients.length !== 2 ||
    !CLIENT_IDS.every(
      (id, index) =>
        profiles[index].id === id && launch.clients[index].profileId === id,
    )
  ) {
    throw new Error("Managed device legacy sentinel authority differs");
  }
  const activationEventHash = request.releaseState?.activation?.eventHash;
  const productionOrigin = new URL(
    request.externalPolicy.managedDeviceExecution.installedPwaLaunchAuthority
      .installUrl,
  ).origin;
  const prepared = await Promise.all(
    profiles.map((profile, index) =>
      prepareProfile({
        launch: launch.clients[index],
        profile,
        productionOrigin,
        activationEventHash,
      }),
    ),
  );
  const document = Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-legacy-sentinel-authority/v1",
    activationEventHash,
    profiles: prepared,
  });
  await writeDeploymentBindingCreateOnly(
    path.resolve(parsed.outputPath),
    canonicalJsonBytes(document),
  );
  return document;
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await prepareManagedDeviceLegacySentinels(process.argv.slice(2));
