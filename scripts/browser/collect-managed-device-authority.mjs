import { createPrivateKey } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
  sameExactFileIdentityAndSize,
} from "../lib/exact-file-read.mjs";
import { readAndVerifyExternalPrerequisitePolicy } from "../lib/phase-exit-external-prerequisites.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  assertStoredGitHubOidcReceipt,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "../release-state/githubOidc.mjs";
import {
  assertProductionRequestGraphProtectedWorkflow,
  deriveBrowserPhaseExitCollectorIdentity,
} from "./production-request-graph.mjs";
import {
  assertConfiguredManagedDeviceExecution,
  assertSignedManagedDeviceReceipt,
  managedDevicePublicKeyFingerprint,
  MANAGED_DEVICE_AUTHORITIES,
} from "./managed-device-authority.mjs";
import { executeManagedDevicePowerShell } from "./managed-device-powershell.mjs";
import { materializeManagedDeviceStandardDist } from "./managed-device-package.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_INPUT_BYTES = 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 32 * 1024 * 1024;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const createDefaultStore = async (options) => {
  const { createPostgresReleaseStateStore } =
    await import("../release-state/postgresStore.mjs");
  return createPostgresReleaseStateStore(options);
};

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Managed device environment is absent: ${name}`);
  }
  return value;
};

export const parseManagedDeviceCollectorArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length !== 8) {
    throw new Error(
      "Usage: collect-managed-device-authority.mjs --authority <pwa-multiclient-drill|idb-device-compatibility> --namespace <namespace> --source-sha <sha> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--authority", "--namespace", "--output", "--source-sha"].includes(
        flag,
      ) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Managed device collector arguments are invalid");
    }
    values.set(flag, value);
  }
  const authority = values.get("--authority");
  const namespace = values.get("--namespace");
  const sourceSha = values.get("--source-sha");
  if (
    !MANAGED_DEVICE_AUTHORITIES.includes(authority) ||
    !NAMESPACE.test(namespace ?? "") ||
    !SOURCE_SHA.test(sourceSha ?? "")
  ) {
    throw new Error("Managed device collector identity is invalid");
  }
  return Object.freeze({
    authority,
    namespace,
    outputPath: values.get("--output"),
    sourceSha,
  });
};

const readExactJson = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  const bytes = await readExactRegularFile({
    description: { path: resolved, ...describeExactFile(metadata) },
    maximumBytes: MAXIMUM_INPUT_BYTES,
    label,
  });
  return parseJsonStrict(bytes.toString("utf8"), label);
};

export const assertManagedDeviceRunnerPreflight = ({
  environment,
  devicePolicy,
}) => {
  const labels = requireEnvironment(
    environment,
    "FOUNDATION_DEVICE_RUNNER_LABELS",
  ).split(",");
  if (
    requireEnvironment(environment, "FOUNDATION_DEVICE_RUNNER_GROUP") !==
      devicePolicy.runnerGroup ||
    !canonicalJsonBytes(labels).equals(
      canonicalJsonBytes(devicePolicy.requiredLabels),
    )
  ) {
    throw new Error("Managed device runner group or labels differ");
  }
  const publicKeyPem = requireEnvironment(
    environment,
    "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
  );
  const privateKeyPem = requireEnvironment(
    environment,
    "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
  );
  const expected = devicePolicy.attestation.publicKeyFingerprintSha256;
  if (
    managedDevicePublicKeyFingerprint(publicKeyPem) !== expected ||
    managedDevicePublicKeyFingerprint(createPrivateKey(privateKeyPem)) !==
      expected
  ) {
    throw new Error("Managed device attestation key binding differs");
  }
  return Object.freeze({ privateKeyPem, publicKeyPem });
};

const collectDefaultOidc = async ({
  environment,
  approvalPolicy,
  sourceSha,
  runId,
  runAttempt,
}) => {
  const token = await requestGitHubOidcToken({
    requestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: approvalPolicy.oidcAudience,
  });
  const verified = await verifyGitHubOidcTokenFromIssuer({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
  });
  assertVerifiedGitHubOidcResult(verified);
  assertStoredGitHubOidcReceipt({
    receipt: verified.receipt,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
  });
  return verified.receipt;
};

const sameDescriptor = (metadata, description) =>
  metadata.isFile() &&
  !metadata.isSymbolicLink() &&
  sameExactFileIdentityAndSize(describeExactFile(metadata), description);

const assertCommittedOutput = async ({ resolved, description, bytes }) => {
  const firstMetadata = await lstat(resolved, { bigint: true });
  if (!sameDescriptor(firstMetadata, description)) {
    throw new Error("Managed device output path changed");
  }
  const first = await readExactRegularFile({
    description: { path: resolved, ...description },
    maximumBytes: bytes.length,
    label: "Managed device output",
    requireDescriptionTimestamps: false,
  });
  const finalMetadata = await lstat(resolved, { bigint: true });
  if (!sameDescriptor(finalMetadata, description) || !first.equals(bytes)) {
    throw new Error("Managed device output readback differs");
  }
};

export const writeManagedDeviceCollectorOutput = async (
  outputPath,
  receipt,
) => {
  const bytes = canonicalJsonBytes(receipt);
  if (bytes.length === 0 || bytes.length > MAXIMUM_OUTPUT_BYTES) {
    throw new Error("Managed device output is empty or oversized");
  }
  const resolved = path.resolve(outputPath);
  try {
    await lstat(resolved);
    throw new Error("Managed device output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await open(temporary, "wx+", 0o600);
  let linked = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const description = describeExactFile(await handle.stat({ bigint: true }));
    const descriptorBytes = Buffer.alloc(bytes.length);
    const read = await handle.read(descriptorBytes, 0, bytes.length, 0);
    if (
      description.size !== bytes.length ||
      read.bytesRead !== bytes.length ||
      !descriptorBytes.equals(bytes)
    ) {
      throw new Error("Managed device temporary output differs");
    }
    await link(temporary, resolved);
    linked = true;
    await unlink(temporary);
    await handle.close();
    await assertCommittedOutput({ resolved, description, bytes });
    return Object.freeze({ bytes, path: resolved, sha256: sha256Bytes(bytes) });
  } finally {
    await handle.close().catch(() => undefined);
    if (!linked) await unlink(temporary).catch(() => undefined);
  }
};

export const runManagedDeviceCollectorCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadExternalPolicy = readAndVerifyExternalPrerequisitePolicy,
    loadPolicy = readExactJson,
    assertProtected = assertProductionRequestGraphProtectedWorkflow,
    createStore = createDefaultStore,
    readState = readCurrentReleaseState,
    resolveDeployment,
    collectOidc = collectDefaultOidc,
    execute = executeManagedDevicePowerShell,
    writeOutput = writeManagedDeviceCollectorOutput,
  } = {},
) => {
  const parsed = parseManagedDeviceCollectorArguments(argv);
  const external = await loadExternalPolicy(
    path.join(root, "config", "phase-exit-external-prerequisites.json"),
  );
  const configured = assertConfiguredManagedDeviceExecution(external.policy);
  assertManagedDeviceRunnerPreflight({
    environment,
    devicePolicy: configured.device,
  });
  const [
    approvalPolicy,
    storePolicy,
    dbContract,
    toolchainPolicy,
    providerPolicy,
    cspPolicy,
  ] = await Promise.all([
    loadPolicy(
      path.join(root, "config", "approval-policy.json"),
      "Managed device approval policy",
    ),
    loadPolicy(
      path.join(root, "config", "release-state-store.json"),
      "Managed device Release State policy",
    ),
    loadPolicy(
      path.join(root, "config", "db-compatibility-contract.json"),
      "Managed device DB compatibility contract",
    ),
    loadPolicy(
      path.join(root, "config", "toolchain-versions.json"),
      "Managed device toolchain policy",
    ),
    loadPolicy(
      path.join(root, "config", "provider-policy.json"),
      "Managed device provider policy",
    ),
    loadPolicy(
      path.join(root, "config", "csp-policy.json"),
      "Managed device CSP policy",
    ),
  ]);
  const workflow = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha: parsed.sourceSha,
  });
  if (storePolicy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL") {
    throw new Error("Managed device Release State binding differs");
  }
  const store = await createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace: parsed.namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const current = await readState({ store, requireInitialized: true });
    const resolver =
      resolveDeployment ??
      (await import("./managed-device-authority.mjs"))
        .resolveManagedDeviceAcceptedDeployment;
    const selected = resolver({
      current,
      namespace: parsed.namespace,
      sourceSha: parsed.sourceSha,
      requireRollback: parsed.authority === "pwa-multiclient-drill",
    });
    const oidcReceipt = await collectOidc({
      environment,
      approvalPolicy,
      sourceSha: parsed.sourceSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
    });
    const collectorIdentity = deriveBrowserPhaseExitCollectorIdentity({
      sourceSha: parsed.sourceSha,
      oidcAuthority: {
        approvalPolicy,
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
      },
    });
    const request = {
      schemaVersion: 1,
      kind: "managed-device-execution-request/v1",
      authority: parsed.authority,
      namespace: parsed.namespace,
      sourceSha: parsed.sourceSha,
      collectorIdentity,
      oidcReceipt,
      externalPolicy: external.policy,
      approvalPolicy,
      dbContract,
      deployment: selected.projection,
      rollbackDeployment: selected.rollbackProjection,
    };
    const runnerTemp = path.resolve(
      requireEnvironment(environment, "RUNNER_TEMP"),
    );
    const artifactRoot = await mkdtemp(
      path.join(runnerTemp, "managed-device-packages-"),
    );
    let receipt;
    try {
      const currentArtifact = await materializeManagedDeviceStandardDist({
        store,
        namespace: parsed.namespace,
        binding: selected.binding,
        packageRoot: path.join(artifactRoot, "current-package"),
        distRoot: path.join(artifactRoot, "current-dist"),
        toolchainPolicy,
        providerPolicy,
        dbContract,
        cspPolicy,
      });
      const rollbackArtifact =
        selected.rollbackBinding === null
          ? null
          : await materializeManagedDeviceStandardDist({
              store,
              namespace: parsed.namespace,
              binding: selected.rollbackBinding,
              packageRoot: path.join(artifactRoot, "rollback-package"),
              distRoot: path.join(artifactRoot, "rollback-dist"),
              toolchainPolicy,
              providerPolicy,
              dbContract,
              cspPolicy,
            });
      receipt = await execute({
        request,
        artifacts: {
          current: currentArtifact,
          rollback: rollbackArtifact,
        },
        externalPolicy: external.policy,
        environment,
        repositoryRoot: root,
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true, maxRetries: 3 });
    }
    const verified = assertSignedManagedDeviceReceipt(receipt, {
      authority: parsed.authority,
      externalPolicy: external.policy,
      approvalPolicy,
      dbContract,
      expectedSourceSha: parsed.sourceSha,
      expectedRunId: workflow.runId,
      expectedRunAttempt: workflow.runAttempt,
      expectedDeployment: selected.projection,
      expectedRollbackDeployment: selected.rollbackProjection,
    });
    await writeOutput(path.resolve(cwd, parsed.outputPath), receipt);
    stdout.write(`PASS ${parsed.authority}: ${verified.sha256}\n`);
    return verified;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runManagedDeviceCollectorCli();
