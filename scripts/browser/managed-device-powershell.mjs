import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalJsonBytes, parseJsonStrict } from "../lib/canonical-json.mjs";
import { assertConfiguredManagedDeviceExecution } from "./managed-device-authority.mjs";

const execFileAsync = promisify(execFile);
const MAXIMUM_RECEIPT_BYTES = 32 * 1024 * 1024;
const POWERSHELL_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const CHILD_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "ComSpec",
  "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
  "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
  "FOUNDATION_DEVICE_PROFILE_ROOT",
  "FOUNDATION_DEVICE_RUNNER_GROUP",
  "FOUNDATION_DEVICE_RUNNER_LABELS",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ProgramData",
  "RUNNER_TEMP",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const requireSecret = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`Managed device secret environment is absent: ${name}`);
  }
  return value;
};

const environmentValue = (environment, name) => {
  const exact = environment?.[name];
  if (typeof exact === "string") return exact;
  const matched = Object.keys(environment ?? {}).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return matched === undefined ? undefined : environment[matched];
};

export const projectManagedDeviceChildEnvironment = (environment) => {
  const projected = {};
  for (const name of CHILD_ENVIRONMENT_NAMES) {
    const value = environmentValue(environment, name);
    if (typeof value === "string" && value.length > 0) projected[name] = value;
  }
  for (const required of [
    "APPDATA",
    "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
    "FOUNDATION_DEVICE_PROFILE_ROOT",
    "FOUNDATION_DEVICE_RUNNER_GROUP",
    "FOUNDATION_DEVICE_RUNNER_LABELS",
    "PATH",
    "ProgramData",
    "RUNNER_TEMP",
    "SystemRoot",
  ]) {
    if (typeof projected[required] !== "string") {
      throw new Error(
        `Managed device child environment is absent: ${required}`,
      );
    }
  }
  return Object.freeze(projected);
};

const assertExactPowerShell = async (configuredPath = POWERSHELL_PATH) => {
  const resolved = path.resolve(configuredPath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      "Managed device PowerShell executable is not a regular file",
    );
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(
      "Managed device PowerShell executable resolves through an alias",
    );
  }
  return resolved;
};

export const executeManagedDevicePowerShell = async (
  {
    request,
    artifacts,
    externalPolicy,
    environment = process.env,
    repositoryRoot,
  },
  {
    platform = process.platform,
    run = execFileAsync,
    resolvePowerShell = assertExactPowerShell,
  } = {},
) => {
  assertConfiguredManagedDeviceExecution(externalPolicy);
  if (platform !== "win32") {
    throw new Error("Managed device execution requires Windows");
  }
  const runnerTemp = environment.RUNNER_TEMP;
  if (
    typeof runnerTemp !== "string" ||
    !path.isAbsolute(runnerTemp) ||
    typeof repositoryRoot !== "string" ||
    !path.isAbsolute(repositoryRoot)
  ) {
    throw new Error("Managed device execution paths are invalid");
  }
  const currentDist = artifacts?.current?.distRoot;
  const rollbackDist = artifacts?.rollback?.distRoot ?? null;
  if (
    typeof currentDist !== "string" ||
    !path.isAbsolute(currentDist) ||
    (request.authority === "pwa-multiclient-drill" &&
      (typeof rollbackDist !== "string" || !path.isAbsolute(rollbackDist))) ||
    (request.authority === "idb-device-compatibility" && rollbackDist !== null)
  ) {
    throw new Error("Managed device materialized artifacts are invalid");
  }
  requireSecret(environment, "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM");
  requireSecret(environment, "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM");
  const childEnvironment = projectManagedDeviceChildEnvironment(environment);
  const powerShell = await resolvePowerShell(
    environment.FOUNDATION_DEVICE_POWERSHELL_PATH ?? POWERSHELL_PATH,
  );
  const temporaryRoot = await mkdtemp(
    path.join(path.resolve(runnerTemp), "managed-device-authority-"),
  );
  const requestPath = path.join(temporaryRoot, "request.json");
  const outputPath = path.join(temporaryRoot, "signed-receipt.json");
  const scriptPath = path.join(
    repositoryRoot,
    "scripts",
    "collect-managed-device-raw.ps1",
  );
  await assertExactPowerShell(scriptPath);
  try {
    await writeFile(requestPath, canonicalJsonBytes(request), {
      flag: "wx",
      mode: 0o600,
    });
    const arguments_ = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-File",
      scriptPath,
      "-RequestPath",
      requestPath,
      "-OutputPath",
      outputPath,
      "-CurrentDistPath",
      currentDist,
      "-RepositoryRoot",
      repositoryRoot,
    ];
    if (rollbackDist !== null) {
      arguments_.push("-RollbackDistPath", rollbackDist);
    }
    const result = await run(powerShell, arguments_, {
      cwd: repositoryRoot,
      env: childEnvironment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (typeof result?.stderr !== "string" || result.stderr.trim() !== "") {
      throw new Error("Managed device PowerShell emitted stderr");
    }
    const bytes = await readFile(outputPath);
    if (bytes.length === 0 || bytes.length > MAXIMUM_RECEIPT_BYTES) {
      throw new Error("Managed device receipt is empty or oversized");
    }
    const receipt = parseJsonStrict(
      bytes.toString("utf8"),
      "Managed device PowerShell receipt",
    );
    if (!bytes.equals(canonicalJsonBytes(receipt))) {
      throw new Error("Managed device PowerShell receipt is not canonical");
    }
    return receipt;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
};
