import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJsonBytes, parseJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { writeExactCreateOnlyFile } from "../lib/exact-file-write.mjs";
import { assertProductionRequestGraphProtectedWorkflow } from "../browser/production-request-graph.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  assertBackupRestoreRehearsalObservation,
  collectAndStoreBackupRestoreOidcAuthority,
  collectAndStoreBackupRestoreRehearsal,
} from "./backup-restore-rehearsal.mjs";
import { assertConfiguredBackupRestorePolicy } from "./backup-restore-rehearsal-policy.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_POLICY_BYTES = 4 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 1024 * 1024;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Backup rehearsal environment is absent: ${name}`);
  }
  return value;
};

export const parseBackupRestoreRehearsalArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length !== 4) {
    throw new Error(
      "Usage: collect-backup-restore-rehearsal.mjs --namespace <namespace> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--namespace", "--output"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Backup rehearsal arguments are invalid");
    }
    values.set(flag, value);
  }
  const namespace = values.get("--namespace");
  if (!NAMESPACE.test(namespace ?? "")) {
    throw new Error("Backup rehearsal namespace is invalid");
  }
  return {
    namespace,
    outputPath: values.get("--output"),
  };
};

const exactFile = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return { path: resolved, ...describeExactFile(metadata) };
};

const readExactJson = async (filePath, label) => {
  const bytes = await readExactRegularFile({
    description: await exactFile(filePath, label),
    maximumBytes: MAXIMUM_POLICY_BYTES,
    label,
  });
  return parseJsonStrict(bytes.toString("utf8"), label);
};

const createReleaseStateStore = async (options) => {
  const { createPostgresReleaseStateStore } =
    await import("../release-state/postgresStore.mjs");
  return createPostgresReleaseStateStore(options);
};

export const writeBackupRestoreRehearsalOutput = async (
  outputPath,
  observation,
) => {
  assertBackupRestoreRehearsalObservation(observation);
  const bytes = canonicalJsonBytes(observation);
  const written = await writeExactCreateOnlyFile({
    outputPath,
    bytes,
    label: "Backup rehearsal",
    maximumBytes: MAXIMUM_OUTPUT_BYTES,
  });
  return { path: written.path, bytes: written.bytes };
};

export const runBackupRestoreRehearsalCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadPolicy = readExactJson,
    assertProtected = assertProductionRequestGraphProtectedWorkflow,
    createStore = createReleaseStateStore,
    readState = readCurrentReleaseState,
    collectOidc = collectAndStoreBackupRestoreOidcAuthority,
    collect = collectAndStoreBackupRestoreRehearsal,
    writeOutput = writeBackupRestoreRehearsalOutput,
  } = {},
) => {
  const parsed = parseBackupRestoreRehearsalArguments(argv);
  const [approvalPolicy, storePolicy, prerequisitePolicy, providerContract] =
    await Promise.all([
      loadPolicy(
        path.join(root, "config", "approval-policy.json"),
        "Backup rehearsal approval policy",
      ),
      loadPolicy(
        path.join(root, "config", "release-state-store.json"),
        "Backup rehearsal store policy",
      ),
      loadPolicy(
        path.join(root, "config", "phase-exit-external-prerequisites.json"),
        "Backup rehearsal prerequisite policy",
      ),
      loadPolicy(
        path.join(root, "config", "backup-restore-provider-contract.json"),
        "Backup rehearsal provider contract",
      ),
    ]);

  // This is deliberately before protected OIDC, Release State, provider, or DB I/O.
  assertConfiguredBackupRestorePolicy({
    prerequisitePolicy,
    providerContract,
  });
  const sourceSha = requireEnvironment(environment, "GITHUB_SHA");
  if (!SOURCE_SHA.test(sourceSha)) {
    throw new Error("Backup rehearsal protected source SHA is invalid");
  }
  const workflow = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha,
  });
  const store = await createStore({
    connectionString: requireEnvironment(
      environment,
      "RELEASE_STATE_DATABASE_URL",
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
      sourceSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
      approvalPolicy,
      environment,
    });
    const observation = await collect(
      {
        current,
        environment,
        namespace: parsed.namespace,
        oidcAuthority: {
          approvalPolicy,
          runId: workflow.runId,
          runAttempt: workflow.runAttempt,
        },
        oidcReceipt: oidc.reference,
        prerequisitePolicy,
        providerContract,
        store,
      },
      { readState },
    );
    await writeOutput(path.resolve(cwd, parsed.outputPath), observation);
    stdout.write(
      `PASS backup/restore rehearsal: ${observation.rawRehearsal.sha256}\n`,
    );
    return observation;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runBackupRestoreRehearsalCli();
