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
const MAXIMUM_ARTIFACT_DOCUMENT_BYTES = 1024 * 1024;
const MAXIMUM_RECEIPT_BYTES = 32 * 1024 * 1024;
const POWERSHELL_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
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

const assertExactDirectory = async (directoryPath, label) => {
  if (typeof directoryPath !== "string" || !path.isAbsolute(directoryPath)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(directoryPath);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through an alias`);
  }
  return resolved;
};

const readCanonicalArtifactDocument = async ({ distRoot, fileName, label }) => {
  const documentPath = path.join(distRoot, fileName);
  const metadata = await lstat(documentPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAXIMUM_ARTIFACT_DOCUMENT_BYTES
  ) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  if (
    comparablePath(await realpath(documentPath)) !==
    comparablePath(documentPath)
  ) {
    throw new Error(`${label} resolves through an alias`);
  }
  const bytes = await readFile(documentPath);
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (!bytes.equals(canonicalJsonBytes(value))) {
    throw new Error(`${label} is not canonical`);
  }
  return Object.freeze({ bytes, value });
};

const assertStrictPwaArtifact = async ({
  artifact,
  expectedSourceSha,
  label,
}) => {
  if (
    artifact?.binding?.releaseRole !== "standard" ||
    artifact.binding.sourceSha !== expectedSourceSha
  ) {
    throw new Error(`${label} binding source differs`);
  }
  const distRoot = await assertExactDirectory(
    artifact.distRoot,
    `${label} dist`,
  );
  const [capabilityDocument, identityDocument] = await Promise.all([
    readCanonicalArtifactDocument({
      distRoot,
      fileName: "release-capabilities.json",
      label: `${label} capability`,
    }),
    readCanonicalArtifactDocument({
      distRoot,
      fileName: "release-identity.json",
      label: `${label} identity`,
    }),
  ]);
  const capability = capabilityDocument.value;
  const identity = identityDocument.value;
  if (
    capability.kind !== "event-shopping-planner-release-capabilities" ||
    capability.version !== 1 ||
    capability.buildMode !== "release-a" ||
    capability.buildId !== expectedSourceSha ||
    capability.sourceSha !== expectedSourceSha ||
    capability.sourceState !== "clean" ||
    capability.releaseChannel !== "release-a" ||
    capability.legacyLocalStorageCleanup !== "forced-off"
  ) {
    throw new Error(`${label} capability source differs`);
  }
  if (
    identity.schemaVersion !== 1 ||
    identity.buildId !== expectedSourceSha ||
    identity.sourceSha !== expectedSourceSha ||
    identity.releaseRole !== "standard" ||
    identity.variantId !== artifact.binding.variantId ||
    identity.pwaLifecycle !== "prompt-close-all-v1"
  ) {
    throw new Error(`${label} prompt-close identity differs`);
  }
  const [versionedCapability, versionedIdentity] = await Promise.all([
    readCanonicalArtifactDocument({
      distRoot,
      fileName: `release-capabilities.${expectedSourceSha}.json`,
      label: `${label} versioned capability`,
    }),
    readCanonicalArtifactDocument({
      distRoot,
      fileName: `release-identity.${expectedSourceSha}.${identity.variantId}.json`,
      label: `${label} versioned identity`,
    }),
  ]);
  if (
    !capabilityDocument.bytes.equals(versionedCapability.bytes) ||
    !identityDocument.bytes.equals(versionedIdentity.bytes)
  ) {
    throw new Error(`${label} stable/versioned identity bytes differ`);
  }
  return Object.freeze({ ...artifact, distRoot });
};

export const prepareManagedDevicePowerShellArtifacts = async ({
  request,
  artifacts,
}) => {
  if (request?.authority === "idb-device-compatibility") {
    if (artifacts?.rollback !== null) {
      throw new Error("Managed IDB collector rejects a rollback artifact");
    }
    const distRoot = await assertExactDirectory(
      artifacts?.current?.distRoot,
      "Managed current artifact",
    );
    return Object.freeze({
      current: Object.freeze({ ...artifacts.current, distRoot }),
      rollback: null,
    });
  }
  if (
    request?.authority !== "pwa-multiclient-drill" ||
    request.sourceSha !== request.deployment?.sourceSha ||
    request.rollbackDeployment?.sourceSha === request.sourceSha
  ) {
    throw new Error("Managed PWA artifact request identity differs");
  }
  const [current, rollback] = await Promise.all([
    assertStrictPwaArtifact({
      artifact: artifacts?.current,
      expectedSourceSha: request.sourceSha,
      label: "Managed current artifact",
    }),
    assertStrictPwaArtifact({
      artifact: artifacts?.rollback,
      expectedSourceSha: request.rollbackDeployment?.sourceSha,
      label: "Managed rollback artifact",
    }),
  ]);
  return Object.freeze({ current, rollback });
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
  const preparedArtifacts = await prepareManagedDevicePowerShellArtifacts({
    request,
    artifacts,
  });
  const currentDist = preparedArtifacts.current.distRoot;
  const rollbackDist = preparedArtifacts.rollback?.distRoot ?? null;
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
