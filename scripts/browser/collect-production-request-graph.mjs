import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJsonBytes, parseJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  assertProductionRequestGraphObservation,
  assertProductionRequestGraphProtectedWorkflow,
  collectAndStoreProductionRequestGraph,
  collectAndStoreProductionRequestGraphOidcAuthority,
} from "./production-request-graph.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_POLICY_BYTES = 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;

const createDefaultStore = async (options) => {
  const { createPostgresReleaseStateStore } =
    await import("../release-state/postgresStore.mjs");
  return createPostgresReleaseStateStore(options);
};

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Production request graph environment is absent: ${name}`);
  }
  return value;
};

export const parseProductionRequestGraphArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length !== 6) {
    throw new Error(
      "Usage: collect-production-request-graph.mjs --namespace <namespace> --source-sha <sha> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--namespace", "--output", "--source-sha"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Production request graph arguments are invalid");
    }
    values.set(flag, value);
  }
  const namespace = values.get("--namespace");
  const sourceSha = values.get("--source-sha");
  if (
    !NAMESPACE_PATTERN.test(namespace ?? "") ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "")
  ) {
    throw new Error(
      "Production request graph namespace or source SHA is invalid",
    );
  }
  return Object.freeze({
    namespace,
    sourceSha,
    outputPath: values.get("--output"),
  });
};

const exactFileDescription = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return {
    path: resolved,
    ...describeExactFile(metadata),
  };
};

const readExactJson = async (filePath, label) => {
  const bytes = await readExactRegularFile({
    description: await exactFileDescription(filePath, label),
    maximumBytes: MAXIMUM_POLICY_BYTES,
    label,
  });
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  return value;
};

const assertOutputAbsent = async (outputPath) => {
  try {
    await lstat(outputPath);
    throw new Error("Production request graph output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

export const writeProductionRequestGraphOutput = async (
  outputPath,
  observation,
) => {
  assertProductionRequestGraphObservation(observation);
  const resolved = path.resolve(outputPath);
  const bytes = canonicalJsonBytes(observation);
  if (bytes.length < 1 || bytes.length > MAXIMUM_OUTPUT_BYTES) {
    throw new Error("Production request graph output is empty or oversized");
  }
  await assertOutputAbsent(resolved);
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const description = {
      path: resolved,
      ...describeExactFile(await handle.stat({ bigint: true })),
    };
    const readback = await readExactRegularFile({
      description,
      maximumBytes: bytes.length,
      label: "Production request graph output",
      requireDescriptionTimestamps: false,
    });
    if (!readback.equals(bytes)) {
      throw new Error("Production request graph output readback differs");
    }
  } finally {
    await handle.close();
  }
  return Object.freeze({ path: resolved, bytes });
};

export const runProductionRequestGraphCollectorCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadPolicy = readExactJson,
    createStore = createDefaultStore,
    readState = readCurrentReleaseState,
    collect = collectAndStoreProductionRequestGraph,
    collectOidc = collectAndStoreProductionRequestGraphOidcAuthority,
    assertProtected = assertProductionRequestGraphProtectedWorkflow,
    writeOutput = writeProductionRequestGraphOutput,
  } = {},
) => {
  const parsed = parseProductionRequestGraphArguments(argv);
  const outputPath = path.resolve(cwd, parsed.outputPath);
  const [approvalPolicy, storePolicy] = await Promise.all([
    loadPolicy(
      path.join(root, "config", "approval-policy.json"),
      "Production request graph approval policy",
    ),
    loadPolicy(
      path.join(root, "config", "release-state-store.json"),
      "Production request graph store policy",
    ),
  ]);
  const workflowAuthority = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha: parsed.sourceSha,
  });
  if (storePolicy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL") {
    throw new Error("Production request graph store binding is invalid");
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
    const oidc = await collectOidc({
      store,
      namespace: parsed.namespace,
      sourceSha: parsed.sourceSha,
      runId: workflowAuthority.runId,
      runAttempt: workflowAuthority.runAttempt,
      approvalPolicy,
      environment,
    });
    const observation = await collect({
      current,
      store,
      namespace: parsed.namespace,
      sourceSha: parsed.sourceSha,
      oidcReceipt: oidc.reference,
      oidcAuthority: {
        approvalPolicy,
        runId: workflowAuthority.runId,
        runAttempt: workflowAuthority.runAttempt,
      },
    });
    await writeOutput(outputPath, observation);
    stdout.write(
      `PASS production request graph: ${observation.rawGraph.sha256}\n`,
    );
    return observation;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runProductionRequestGraphCollectorCli();
}
