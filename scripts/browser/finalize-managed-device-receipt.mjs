import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { verifyExternalPrerequisitePolicy } from "../lib/phase-exit-external-prerequisites.mjs";
import {
  createSignedManagedDeviceReceipt,
  deriveIdbDeviceProfileEvidence,
  derivePwaMulticlientEvidence,
} from "./managed-device-authority.mjs";

const MAXIMUM_INPUT_BYTES = 32 * 1024 * 1024;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const parseArguments = (arguments_) => {
  const allowed = [
    "--browser-idb",
    "--browser-transition",
    "--current-dist",
    "--host",
    "--output",
    "--pwa-idb",
    "--pwa-transition",
    "--request",
  ];
  if (!Array.isArray(arguments_) || arguments_.length !== 12) {
    throw new Error("Managed device finalizer arguments are invalid");
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
      throw new Error("Managed device finalizer arguments are invalid");
    }
    values.set(flag, value);
  }
  for (const required of [
    "--current-dist",
    "--host",
    "--output",
    "--request",
  ]) {
    if (!values.has(required)) {
      throw new Error("Managed device finalizer argument set is incomplete");
    }
  }
  return values;
};

const readExactJson = async (filePath, label, { canonical = true } = {}) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  if (metadata.size < 1 || metadata.size > MAXIMUM_INPUT_BYTES) {
    throw new Error(`${label} is empty or oversized`);
  }
  const bytes = await readFile(resolved);
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (canonical && !canonicalJsonBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
};

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`Managed device finalizer secret is absent: ${name}`);
  }
  return value;
};

const assertCurrentArtifact = async (distRoot, sourceSha) => {
  const resolved = path.resolve(distRoot);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Managed device current dist is invalid");
  }
  const capability = await readExactJson(
    path.join(resolved, "release-capabilities.json"),
    "Managed device current capability",
  );
  if (
    capability.buildId !== sourceSha ||
    capability.sourceSha !== sourceSha ||
    capability.releaseChannel !== "release-a" ||
    capability.legacyLocalStorageCleanup !== "forced-off"
  ) {
    throw new Error("Managed device current capability differs");
  }
};

const completeHost = ({ hostBase, rawDocuments }) => {
  if (
    !Array.isArray(hostBase?.profiles) ||
    hostBase.profiles.length !== rawDocuments.length
  ) {
    throw new Error("Managed device host profile set differs");
  }
  return Object.freeze({
    ...structuredClone(hostBase),
    profiles: hostBase.profiles.map((profile, index) => {
      const raw = rawDocuments[index];
      if (
        raw.profileId !== profile.profileId ||
        raw.profilePathSha256 !== profile.profilePathSha256
      ) {
        throw new Error("Managed device host/raw profile binding differs");
      }
      const reopenedProcessId =
        raw.kind === "managed-device-profile-transition/v1"
          ? raw.observations.finalForward.browserProcessId
          : raw.browserProcessId;
      return Object.freeze({ ...profile, reopenedProcessId });
    }),
  });
};

const buildPwaEvidence = ({ values, request, hostBase }) => {
  const documents = [
    readExactJson(
      values.get("--browser-transition"),
      "Managed browser transition",
    ),
    readExactJson(values.get("--pwa-transition"), "Managed PWA transition"),
  ];
  return Promise.all(documents).then((profileTransitions) => {
    const host = completeHost({ hostBase, rawDocuments: profileTransitions });
    const derived = derivePwaMulticlientEvidence({
      profileTransitions,
      host,
      sourceSha: request.sourceSha,
      rollbackSourceSha: request.rollbackDeployment.sourceSha,
      devicePolicy: request.externalPolicy.managedDeviceExecution,
    });
    return Object.freeze({
      host,
      evidence: Object.freeze({
        profileLaunches: derived.profileLaunches,
        profileTransitions,
        transitions: derived.transitions,
      }),
    });
  });
};

const buildIdbEvidence = async ({ values, request, hostBase }) => {
  const rawDocuments = await Promise.all([
    readExactJson(values.get("--browser-idb"), "Managed browser IDB probe"),
    readExactJson(values.get("--pwa-idb"), "Managed PWA IDB probe"),
  ]);
  const host = completeHost({ hostBase, rawDocuments });
  const profiles = rawDocuments.map((rawReceipt, index) => {
    const profileId =
      request.externalPolicy.managedDeviceExecution.deviceProfiles[index];
    const derived = deriveIdbDeviceProfileEvidence({
      rawReceipt,
      expectedProfile: profileId,
      dbContract: request.dbContract,
    });
    return Object.freeze({
      profileId: profileId.id,
      rawReceipt,
      ...derived,
    });
  });
  return Object.freeze({
    host,
    evidence: Object.freeze({ profiles }),
  });
};

const writeCreateOnly = async (outputPath, receipt) => {
  const resolved = path.resolve(outputPath);
  const bytes = canonicalJsonBytes(receipt);
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    await lstat(resolved);
    throw new Error("Managed device signed receipt already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.tmp`,
  );
  const handle = await open(temporary, "wx+", 0o600);
  let linked = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const descriptor = await handle.stat({ bigint: true });
    const readback = Buffer.alloc(bytes.length);
    const result = await handle.read(readback, 0, bytes.length, 0);
    if (
      !descriptor.isFile() ||
      descriptor.isSymbolicLink() ||
      descriptor.size !== BigInt(bytes.length) ||
      result.bytesRead !== bytes.length ||
      !readback.equals(bytes)
    ) {
      throw new Error("Managed device signed receipt descriptor differs");
    }
    await link(temporary, resolved);
    linked = true;
    await unlink(temporary);
    await handle.close();
    const finalBytes = await readFile(resolved);
    if (!finalBytes.equals(bytes)) {
      throw new Error("Managed device signed receipt readback differs");
    }
    return Object.freeze({ path: resolved, sha256: sha256Bytes(bytes) });
  } finally {
    await handle.close().catch(() => undefined);
    if (!linked) await unlink(temporary).catch(() => undefined);
  }
};

export const finalizeManagedDeviceReceipt = async (arguments_) => {
  const values = parseArguments(arguments_);
  const request = await readExactJson(
    values.get("--request"),
    "Managed device execution request",
  );
  const hostBase = await readExactJson(
    values.get("--host"),
    "Managed device host observation",
    { canonical: false },
  );
  if (
    request.schemaVersion !== 1 ||
    request.kind !== "managed-device-execution-request/v1" ||
    !SOURCE_SHA.test(request.sourceSha ?? "") ||
    !["pwa-multiclient-drill", "idb-device-compatibility"].includes(
      request.authority,
    )
  ) {
    throw new Error("Managed device execution request differs");
  }
  const expectedAuthorityFlags =
    request.authority === "pwa-multiclient-drill"
      ? ["--browser-transition", "--pwa-transition"]
      : ["--browser-idb", "--pwa-idb"];
  const forbiddenAuthorityFlags =
    request.authority === "pwa-multiclient-drill"
      ? ["--browser-idb", "--pwa-idb"]
      : ["--browser-transition", "--pwa-transition"];
  if (
    expectedAuthorityFlags.some((flag) => !values.has(flag)) ||
    forbiddenAuthorityFlags.some((flag) => values.has(flag))
  ) {
    throw new Error("Managed device finalizer authority inputs differ");
  }
  await assertCurrentArtifact(values.get("--current-dist"), request.sourceSha);
  const observed =
    request.authority === "pwa-multiclient-drill"
      ? await buildPwaEvidence({ values, request, hostBase })
      : await buildIdbEvidence({ values, request, hostBase });
  const payload = Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-raw-authority/v1",
    authority: request.authority,
    namespace: request.namespace,
    sourceSha: request.sourceSha,
    collectorIdentity: request.collectorIdentity,
    oidcReceipt: request.oidcReceipt,
    externalPrerequisitePolicySha256: verifyExternalPrerequisitePolicy(
      request.externalPolicy,
    ).policySha256,
    deployment: request.deployment,
    rollbackDeployment: request.rollbackDeployment,
    observedAt: new Date().toISOString(),
    host: observed.host,
    evidence: observed.evidence,
  });
  const receipt = createSignedManagedDeviceReceipt({
    payload,
    privateKeyPem: requireEnvironment(
      "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    ),
    publicKeyPem: requireEnvironment(
      "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
    ),
    validation: {
      authority: request.authority,
      externalPolicy: request.externalPolicy,
      approvalPolicy: request.approvalPolicy,
      dbContract: request.dbContract,
      expectedSourceSha: request.sourceSha,
      expectedRunId: request.collectorIdentity.runId,
      expectedRunAttempt: request.collectorIdentity.runAttempt,
      expectedDeployment: request.deployment,
      expectedRollbackDeployment: request.rollbackDeployment,
    },
  });
  const written = await writeCreateOnly(values.get("--output"), receipt);
  return Object.freeze({ receipt, ...written });
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await finalizeManagedDeviceReceipt(process.argv.slice(2));
