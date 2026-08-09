import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { canonicalJsonBytes, parseJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
  sameExactFileDescription,
} from "../lib/exact-file-read.mjs";
import { assertConfiguredManagedDeviceExecution } from "./managed-device-authority.mjs";

const execFileAsync = promisify(execFile);
const POWERSHELL_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const MAXIMUM_RECEIPT_BYTES = 16 * 1024 * 1024;
const CHILD_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "ComSpec",
  "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
  "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
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
const environmentValue = (environment, name) => {
  const exact = environment?.[name];
  if (typeof exact === "string") return exact;
  const matched = Object.keys(environment ?? {}).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return matched === undefined ? undefined : environment[matched];
};

export const projectManagedDeviceLiveStageEnvironment = (environment) => {
  const projected = {};
  for (const name of CHILD_ENVIRONMENT_NAMES) {
    const value = environmentValue(environment, name);
    if (typeof value === "string" && value.length > 0) projected[name] = value;
  }
  for (const required of [
    "APPDATA",
    "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
    "FOUNDATION_DEVICE_RUNNER_GROUP",
    "FOUNDATION_DEVICE_RUNNER_LABELS",
    "PATH",
    "ProgramData",
    "RUNNER_TEMP",
    "SystemRoot",
  ]) {
    if (typeof projected[required] !== "string") {
      throw new Error(
        `Managed device live child environment is absent: ${required}`,
      );
    }
  }
  return Object.freeze(projected);
};

const exactFile = async (value, label) => {
  const resolved = path.resolve(value);
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    comparablePath(await realpath(resolved)) !== comparablePath(resolved)
  ) {
    throw new Error(`${label} is not an exact regular file`);
  }
  return resolved;
};

const readExactReceipt = async (value) => {
  const resolved = path.resolve(value);
  const metadata = await lstat(resolved, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    comparablePath(await realpath(resolved)) !== comparablePath(resolved)
  ) {
    throw new Error("Managed device live stage receipt is not exact");
  }
  const description = { path: resolved, ...describeExactFile(metadata) };
  const bytes = await readExactRegularFile({
    description,
    maximumBytes: MAXIMUM_RECEIPT_BYTES,
    label: "Managed device live stage receipt",
  });
  const finalMetadata = await lstat(resolved, { bigint: true });
  if (!finalMetadata.isFile() || finalMetadata.isSymbolicLink()) {
    throw new Error("Managed device live stage receipt changed after read");
  }
  const finalDescription = describeExactFile(finalMetadata);
  if (!sameExactFileDescription(description, finalDescription)) {
    throw new Error("Managed device live stage receipt changed after read");
  }
  return bytes;
};

export const executeManagedDeviceLiveStagePowerShell = async (
  { request, externalPolicy, environment = process.env, repositoryRoot },
  {
    platform = process.platform,
    run = execFileAsync,
    resolvePowerShell = exactFile,
  } = {},
) => {
  assertConfiguredManagedDeviceExecution(externalPolicy);
  if (platform !== "win32") {
    throw new Error("Managed device live stage requires Windows");
  }
  if (
    request?.kind !== "managed-device-stage-execution-request/v1" ||
    typeof repositoryRoot !== "string" ||
    !path.isAbsolute(repositoryRoot)
  ) {
    throw new Error("Managed device live stage request paths differ");
  }
  const runnerTemp = environmentValue(environment, "RUNNER_TEMP");
  if (typeof runnerTemp !== "string" || !path.isAbsolute(runnerTemp)) {
    throw new Error("Managed device live stage RUNNER_TEMP is invalid");
  }
  const childEnvironment =
    projectManagedDeviceLiveStageEnvironment(environment);
  const powerShell = await resolvePowerShell(
    environment.FOUNDATION_DEVICE_POWERSHELL_PATH ?? POWERSHELL_PATH,
    "Managed device PowerShell",
  );
  const scriptPath = await exactFile(
    path.join(
      repositoryRoot,
      "scripts",
      "collect-managed-device-live-stage.ps1",
    ),
    "Managed device live stage script",
  );
  const temporaryRoot = await mkdtemp(
    path.join(path.resolve(runnerTemp), "managed-device-live-stage-"),
  );
  const requestPath = path.join(temporaryRoot, "request.json");
  const outputPath = path.join(temporaryRoot, "signed-stage-receipt.json");
  try {
    await writeFile(requestPath, canonicalJsonBytes(request), {
      flag: "wx",
      mode: 0o600,
    });
    const result = await run(
      powerShell,
      [
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
        "-RepositoryRoot",
        repositoryRoot,
      ],
      {
        cwd: repositoryRoot,
        env: childEnvironment,
        encoding: "utf8",
        windowsHide: true,
        timeout: 45 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (typeof result?.stderr !== "string" || result.stderr.trim() !== "") {
      throw new Error("Managed device live stage PowerShell emitted stderr");
    }
    const bytes = await readExactReceipt(outputPath);
    if (bytes.length < 1 || bytes.length > MAXIMUM_RECEIPT_BYTES) {
      throw new Error(
        "Managed device live stage receipt is empty or oversized",
      );
    }
    const receipt = parseJsonStrict(
      bytes.toString("utf8"),
      "Managed device live stage receipt",
    );
    if (!canonicalJsonBytes(receipt).equals(bytes)) {
      throw new Error("Managed device live stage receipt is not canonical");
    }
    return receipt;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
};
