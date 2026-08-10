import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const PROFILE_ID = /^(?:browser-tab|installed-pwa)$/u;
const MAXIMUM_JSON_BYTES = 8 * 1024 * 1024;
const MAXIMUM_LOG_BYTES = 2 * 1024 * 1024;
const PREVIEW_READY_TIMEOUT_MILLISECONDS = 60_000;
const VERIFIER_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const assertExactDirectory = async (value, label) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(value);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return resolved;
};

const assertExactFile = async (value, label) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(value);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return resolved;
};

const parseArguments = (arguments_) => {
  const flags = [
    "--browser-path",
    "--current-dist",
    "--current-source",
    "--output",
    "--profile-dir",
    "--profile-id",
    "--rollback-dist",
    "--rollback-source",
  ];
  if (!Array.isArray(arguments_) || arguments_.length !== flags.length * 2) {
    throw new Error("Managed device transition arguments are invalid");
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !flags.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Managed device transition arguments are invalid");
    }
    values.set(flag, value);
  }
  if (
    !SOURCE_SHA.test(values.get("--current-source") ?? "") ||
    !SOURCE_SHA.test(values.get("--rollback-source") ?? "") ||
    values.get("--current-source") === values.get("--rollback-source") ||
    !PROFILE_ID.test(values.get("--profile-id") ?? "")
  ) {
    throw new Error("Managed device transition identity is invalid");
  }
  return Object.freeze({
    browserPath: values.get("--browser-path"),
    currentDist: values.get("--current-dist"),
    currentSource: values.get("--current-source"),
    outputPath: values.get("--output"),
    profileDir: values.get("--profile-dir"),
    profileId: values.get("--profile-id"),
    rollbackDist: values.get("--rollback-dist"),
    rollbackSource: values.get("--rollback-source"),
  });
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readArtifactEvidence = async ({ distRoot, expectedSource, label }) => {
  const [indexBytes, serviceWorkerBytes, capabilityBytes, identityBytes] =
    await Promise.all([
      readFile(path.join(distRoot, "index.html")),
      readFile(path.join(distRoot, "sw.js")),
      readFile(path.join(distRoot, "release-capabilities.json")),
      readFile(path.join(distRoot, "release-identity.json")),
    ]);
  if (
    indexBytes.length === 0 ||
    serviceWorkerBytes.length === 0 ||
    capabilityBytes.length === 0 ||
    identityBytes.length === 0 ||
    indexBytes.length > MAXIMUM_JSON_BYTES ||
    serviceWorkerBytes.length > MAXIMUM_JSON_BYTES ||
    capabilityBytes.length > MAXIMUM_JSON_BYTES ||
    identityBytes.length > MAXIMUM_JSON_BYTES
  ) {
    throw new Error(`${label} artifact is empty or oversized`);
  }
  const capability = parseJsonStrict(
    capabilityBytes.toString("utf8"),
    `${label} capability`,
  );
  if (
    capability.buildId !== expectedSource ||
    capability.sourceSha !== expectedSource
  ) {
    throw new Error(`${label} capability source differs`);
  }
  const identity = parseJsonStrict(
    identityBytes.toString("utf8"),
    `${label} release identity`,
  );
  if (
    identity.schemaVersion !== 1 ||
    identity.buildId !== expectedSource ||
    identity.sourceSha !== expectedSource ||
    !["legacy-auto-update-v1", "prompt-close-all-v1"].includes(
      identity.pwaLifecycle,
    )
  ) {
    throw new Error(`${label} PWA lifecycle identity differs`);
  }
  const indexSource = indexBytes.toString("utf8");
  const matches = [
    ...indexSource.matchAll(
      /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["'](?<asset>\/assets\/[A-Za-z0-9._-]+\.js)["'][^>]*>/giu,
    ),
    ...indexSource.matchAll(
      /<script\b[^>]*\bsrc\s*=\s*["'](?<asset>\/assets\/[A-Za-z0-9._-]+\.js)["'][^>]*\btype\s*=\s*["']module["'][^>]*>/giu,
    ),
  ];
  const assets = [...new Set(matches.map((match) => match.groups?.asset))];
  if (assets.length !== 1) {
    throw new Error(`${label} module asset is ambiguous`);
  }
  await assertExactFile(
    path.join(distRoot, assets[0].slice(1)),
    `${label} module asset`,
  );
  return Object.freeze({
    indexSha256: sha256(indexBytes),
    mainAsset: assets[0],
    pwaLifecycle: identity.pwaLifecycle,
    serviceWorkerSha256: sha256(serviceWorkerBytes),
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
          reject(new Error("Managed device preview port is invalid"));
        } else resolve(port);
      });
    });
  });

const boundedLog = (chunks) => {
  const bytes = Buffer.concat(chunks);
  return bytes
    .subarray(Math.max(0, bytes.length - MAXIMUM_LOG_BYTES))
    .toString("utf8");
};

const startPreview = async ({ distRoot, port }) => {
  const viteCli = await assertExactFile(
    path.join(root, "node_modules", "vite", "bin", "vite.js"),
    "Managed device Vite CLI",
  );
  const stdout = [];
  const stderr = [];
  const child = spawn(
    process.execPath,
    [
      viteCli,
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
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const origin = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MILLISECONDS;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Managed device preview exited early: ${boundedLog([...stdout, ...stderr])}`,
        );
      }
      try {
        const response = await fetch(origin, { redirect: "error" });
        if (response.status === 200) return Object.freeze({ child, origin });
      } catch {
        // The bound local server may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Managed device preview did not become ready: ${boundedLog([...stdout, ...stderr])}`,
    );
  } catch (error) {
    child.kill();
    throw error;
  }
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

const transitionEnvironmentKeys = Object.freeze([
  "ESP_TRANSITION_MODE",
  "ESP_ROLLBACK_MODE",
  "ESP_EXPECTED_FROM_ARTIFACT_ID",
  "ESP_TARGET_ARTIFACT_ID",
  "ESP_EXPECTED_TARGET_BUILD_ID",
  "ESP_EXPECTED_INDEX_SHA256",
  "ESP_EXPECTED_SW_SHA256",
  "ESP_EXPECTED_MAIN_ASSET",
  "ESP_PROMPT_CLOSE_DRILL",
  "ESP_ROLLBACK_TARGET_CAPABILITY",
  "ESP_ROLLBACK_ACTIVATION",
  "ESP_ALLOW_DIRTY_BUILD",
]);

const rollbackActivationModeForLifecycle = (pwaLifecycle) => {
  if (pwaLifecycle === "legacy-auto-update-v1") return "auto-takeover";
  if (pwaLifecycle === "prompt-close-all-v1") {
    return "natural-after-client-release";
  }
  throw new Error("Managed device target PWA lifecycle is invalid");
};

export const createManagedDeviceVerifierEnvironment = ({
  baseEnvironment,
  browserPath,
  evidence,
  fromSource = null,
  mode = null,
  origin,
  profileDir,
  sourcePwaLifecycle = null,
  targetSource = null,
}) => {
  const environment = { ...baseEnvironment };
  for (const key of transitionEnvironmentKeys) {
    delete environment[key];
  }
  environment.CHROME_PATH = browserPath;
  environment.ESP_PREVIEW_URL = origin;
  environment.ESP_BROWSER_PROFILE_DIR = profileDir;
  if (mode !== null) {
    environment.ESP_TRANSITION_MODE = mode;
    environment.ESP_EXPECTED_FROM_ARTIFACT_ID = fromSource;
    environment.ESP_TARGET_ARTIFACT_ID = targetSource;
    environment.ESP_EXPECTED_INDEX_SHA256 = evidence.indexSha256;
    environment.ESP_EXPECTED_SW_SHA256 = evidence.serviceWorkerSha256;
    environment.ESP_EXPECTED_MAIN_ASSET = evidence.mainAsset;
    environment.ESP_EXPECTED_TARGET_BUILD_ID = targetSource;
    if (mode === "rollback") {
      environment.ESP_ROLLBACK_TARGET_CAPABILITY = "required";
      environment.ESP_ROLLBACK_ACTIVATION = rollbackActivationModeForLifecycle(
        evidence.pwaLifecycle,
      );
    } else if (mode === "forward") {
      environment.ESP_PROMPT_CLOSE_DRILL =
        sourcePwaLifecycle === "prompt-close-all-v1"
          ? "required"
          : sourcePwaLifecycle === "legacy-auto-update-v1"
            ? "disabled"
            : (() => {
                throw new Error(
                  "Managed device source PWA lifecycle is invalid",
                );
              })();
    }
  }
  return environment;
};

const runVerifier = async (options) => {
  const environment = createManagedDeviceVerifierEnvironment({
    ...options,
    baseEnvironment: process.env,
  });
  const verifier = path.join(root, "scripts", "verify-release-a-browser.mjs");
  const result = await execFileAsync(process.execPath, [verifier], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: MAXIMUM_JSON_BYTES,
    timeout: VERIFIER_TIMEOUT_MILLISECONDS,
    windowsHide: true,
  });
  if (result.stderr.trim() !== "") {
    throw new Error("Managed device browser verifier emitted stderr");
  }
  const document = parseJsonStrict(
    result.stdout.trim(),
    "Managed device browser verifier output",
  );
  if (
    !Number.isSafeInteger(document.browserProcessId) ||
    document.browserProcessId < 1
  ) {
    throw new Error("Managed device browser process was not observed");
  }
  return document;
};

const writeCreateOnly = async (outputPath, document) => {
  const bytes = canonicalJsonBytes(document);
  const resolved = path.resolve(outputPath);
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
  const readback = await readFile(resolved);
  if (!readback.equals(bytes)) {
    throw new Error("Managed device transition output readback differs");
  }
};

export const runManagedDeviceTransition = async (arguments_) => {
  const parsed = parseArguments(arguments_);
  const [browserPath, currentDist, rollbackDist, profileDir] =
    await Promise.all([
      assertExactFile(parsed.browserPath, "Managed device browser"),
      assertExactDirectory(parsed.currentDist, "Managed device current dist"),
      assertExactDirectory(parsed.rollbackDist, "Managed device rollback dist"),
      assertExactDirectory(parsed.profileDir, "Managed device profile"),
    ]);
  const [currentEvidence, rollbackEvidence] = await Promise.all([
    readArtifactEvidence({
      distRoot: currentDist,
      expectedSource: parsed.currentSource,
      label: "Managed device current",
    }),
    readArtifactEvidence({
      distRoot: rollbackDist,
      expectedSource: parsed.rollbackSource,
      label: "Managed device rollback",
    }),
  ]);
  const port = await reservePort();
  let preview = null;
  try {
    preview = await startPreview({ distRoot: currentDist, port });
    const initialForward = await runVerifier({
      browserPath,
      evidence: currentEvidence,
      origin: preview.origin,
      profileDir,
    });
    await stopPreview(preview);
    preview = await startPreview({ distRoot: rollbackDist, port });
    const rollback = await runVerifier({
      browserPath,
      evidence: rollbackEvidence,
      fromSource: parsed.currentSource,
      mode: "rollback",
      origin: preview.origin,
      profileDir,
      targetSource: parsed.rollbackSource,
    });
    await stopPreview(preview);
    preview = await startPreview({ distRoot: currentDist, port });
    const finalForward = await runVerifier({
      browserPath,
      evidence: currentEvidence,
      fromSource: parsed.rollbackSource,
      mode: "forward",
      origin: preview.origin,
      profileDir,
      sourcePwaLifecycle: rollbackEvidence.pwaLifecycle,
      targetSource: parsed.currentSource,
    });
    const document = Object.freeze({
      schemaVersion: 1,
      kind: "managed-device-profile-transition/v1",
      profileId: parsed.profileId,
      currentSourceSha: parsed.currentSource,
      rollbackSourceSha: parsed.rollbackSource,
      profilePathSha256: sha256Bytes(Buffer.from(profileDir, "utf8")),
      observations: Object.freeze({
        initialForward,
        rollback,
        finalForward,
      }),
    });
    await writeCreateOnly(parsed.outputPath, document);
    return document;
  } finally {
    await stopPreview(preview);
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runManagedDeviceTransition(process.argv.slice(2));
