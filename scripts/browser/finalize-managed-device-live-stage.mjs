import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { writeDeploymentBindingCreateOnly } from "../provider/produce-deployment-binding.mjs";
import {
  createSignedManagedDeviceStageReceipt,
  deriveManagedDeviceFingerprint,
} from "./managed-device-stage-authority.mjs";

const MAXIMUM_BYTES = 32 * 1024 * 1024;
const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

export const parseManagedDeviceStageFinalizerArguments = (arguments_) => {
  const allowed = [
    "--host",
    "--initial",
    "--output",
    "--reopened",
    "--request",
  ];
  if (!Array.isArray(arguments_) || arguments_.length !== allowed.length * 2) {
    throw new Error("Managed device stage finalizer arguments are invalid");
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
      throw new Error("Managed device stage finalizer arguments are invalid");
    }
    values.set(flag, value);
  }
  return values;
};

const readJson = async (filePath, label, { canonical = true } = {}) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = path.resolve(filePath);
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
  const bytes = await readFile(resolved);
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (canonical && !canonicalJsonBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
};

const requireSecret = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`Managed device stage signing material is absent: ${name}`);
  }
  return value;
};

const writeCreateOnly = async (outputPath, receipt) => {
  const resolved = path.resolve(outputPath);
  const bytes = canonicalJsonBytes(receipt);
  await writeDeploymentBindingCreateOnly(resolved, bytes);
  return Object.freeze({
    path: resolved,
    bytes,
    sha256: sha256Bytes(bytes),
  });
};

export const finalizeManagedDeviceLiveStage = async (arguments_) => {
  const values = parseManagedDeviceStageFinalizerArguments(arguments_);
  const [request, host, initial, reopened] = await Promise.all([
    readJson(values.get("--request"), "Managed device stage request"),
    readJson(values.get("--host"), "Managed device stage host", {
      canonical: false,
    }),
    readJson(values.get("--initial"), "Managed device initial cycle"),
    readJson(values.get("--reopened"), "Managed device reopened cycle"),
  ]);
  if (
    request.schemaVersion !== 1 ||
    request.kind !== "managed-device-stage-execution-request/v1" ||
    initial.kind !== "managed-device-live-cycle-observation/v1" ||
    initial.cycle !== "initial" ||
    reopened.kind !== "managed-device-live-cycle-observation/v1" ||
    reopened.cycle !== "reopened"
  ) {
    throw new Error("Managed device live stage inputs differ");
  }
  const observationWithoutFingerprint = Object.freeze({
    ...host,
    cycles: Object.freeze([
      Object.freeze({ cycle: initial.cycle, clients: initial.clients }),
      Object.freeze({ cycle: reopened.cycle, clients: reopened.clients }),
    ]),
  });
  const observation = Object.freeze({
    ...observationWithoutFingerprint,
    deviceFingerprintSha256: deriveManagedDeviceFingerprint({
      observation: observationWithoutFingerprint,
      device: request.externalPolicy.managedDeviceExecution,
    }),
  });
  const payload = Object.freeze({
    schemaVersion: 1,
    kind: "managed-device-stage-raw-authority/v1",
    namespace: request.namespace,
    collectorSourceSha: request.collectorSourceSha,
    collectorIdentity: request.collectorIdentity,
    oidcReceipt: request.oidcReceipt,
    externalPrerequisitePolicySha256: request.externalPrerequisitePolicySha256,
    releaseState: request.releaseState,
    observedAt: new Date().toISOString(),
    observation,
  });
  const receipt = createSignedManagedDeviceStageReceipt({
    payload,
    privateKeyPem: requireSecret(
      "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    ),
    publicKeyPem: requireSecret("FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM"),
    validation: {
      externalPolicy: request.externalPolicy,
      approvalPolicy: request.approvalPolicy,
      dbContract: request.dbContract,
      current: request.current,
      expectedCollectorSourceSha: request.collectorSourceSha,
      expectedRunId: request.collectorIdentity.runId,
      expectedRunAttempt: request.collectorIdentity.runAttempt,
    },
  });
  const written = await writeCreateOnly(values.get("--output"), receipt);
  return Object.freeze({ receipt, ...written });
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await finalizeManagedDeviceLiveStage(process.argv.slice(2));
