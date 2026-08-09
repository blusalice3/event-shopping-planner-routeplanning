#!/usr/bin/env node

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "../release-state/protected-release.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  parseCanonicalJsonBytes,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  ARCHIVE_RECOVERY_ACTIONS,
  materializeArtifactRecoveryPackage,
  selectRecoveryBinding,
} from "./archiveRecovery.mjs";
import {
  buildArchiveRecoverySubject,
  prepareArchiveRecovery,
  resolveRecoveryPackageBindings,
} from "./archiveRecoveryExecution.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_FLAGS = Object.freeze({
  materialize: [
    "--action",
    "--binding-id",
    "--namespace",
    "--output",
    "--package",
    "--source-sha",
  ],
  subject: [
    "--action",
    "--binding-id",
    "--namespace",
    "--operation-id",
    "--output",
    "--source-sha",
  ],
  prepare: [
    "--namespace",
    "--output",
    "--run-id",
    "--source-sha",
    "--subject",
    "--subject-sha256",
  ],
});
const REDEPLOY_FLAGS = Object.freeze({
  "redeploy-standard": ["--companion-binding", "--target-binding"],
  "redeploy-containment": ["--target-binding"],
});

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required archive recovery environment is absent: ${name}`);
  }
  return value;
};

export const parseArchiveRecoveryExecutionArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length < 1) {
    throw new Error(
      "Usage: execute-archive-recovery.mjs <materialize|subject|prepare> [strict flags]",
    );
  }
  const [command, ...tokens] = argv;
  const baseFlags = COMMAND_FLAGS[command];
  if (baseFlags === undefined || tokens.length % 2 !== 0) {
    throw new Error(`Invalid archive recovery command: ${String(command)}`);
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--") ||
      Object.hasOwn(values, flag)
    ) {
      throw new Error("Archive recovery contains an invalid or duplicate flag");
    }
    values[flag] = value;
  }
  const action = values["--action"];
  const expectedFlags = [
    ...baseFlags,
    ...(command === "subject" ? (REDEPLOY_FLAGS[action] ?? []) : []),
  ].sort();
  const actualFlags = Object.keys(values).sort();
  if (
    expectedFlags.length !== actualFlags.length ||
    expectedFlags.some((flag, index) => flag !== actualFlags[index]) ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    (command !== "prepare" &&
      (!ARCHIVE_RECOVERY_ACTIONS.includes(action) ||
        !SOURCE_SHA_PATTERN.test(values["--source-sha"]))) ||
    (command === "subject" &&
      !OPERATION_ID_PATTERN.test(values["--operation-id"])) ||
    (command === "prepare" &&
      (!SHA256_PATTERN.test(values["--subject-sha256"]) ||
        !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !/^[1-9][0-9]*$/.test(values["--run-id"])))
  ) {
    throw new Error("Archive recovery arguments are incomplete or invalid");
  }
  return { command, values };
};

const readBoundedFile = async (filePath) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_INPUT_BYTES
  ) {
    throw new Error("Archive recovery input type or size is invalid");
  }
  const bytes = await readFile(resolved);
  if (bytes.length !== metadata.size) {
    throw new Error("Archive recovery input changed while read");
  }
  return bytes;
};

const assertOutputAbsent = async (outputPath) => {
  try {
    await lstat(path.resolve(outputPath));
    throw new Error("Archive recovery output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const writeCanonicalCreateOnly = async (outputPath, value) => {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const bytes = canonicalJsonBytes(value);
  await writeFile(resolved, bytes, { flag: "wx", mode: 0o600 });
  return { bytes, path: resolved };
};

const createBoundStore = async ({
  environment,
  namespace,
  storePolicy,
  createStore,
}) => {
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  return createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

export const runArchiveRecoveryExecutionCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    readFileImpl = readBoundedFile,
    createStore = createPostgresReleaseStateStore,
    readState = readCurrentReleaseState,
    materialize = materializeArtifactRecoveryPackage,
    buildSubject = buildArchiveRecoverySubject,
    prepare = prepareArchiveRecovery,
    writeOutput = writeCanonicalCreateOnly,
  } = {},
) => {
  const { command, values } = parseArchiveRecoveryExecutionArguments(argv);
  const namespace = values["--namespace"];
  if (
    requireEnvironment(environment, "RELEASE_STATE_NAMESPACE") !== namespace
  ) {
    throw new Error("Archive recovery namespace differs from its environment");
  }
  const [approvalPolicy, storePolicy, releasePolicy] = await Promise.all([
    loadJson(path.join(root, "config", "approval-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
    loadJson(path.join(root, "config", "release-variants.json")),
  ]);
  assertProtectedWorkflowEnvironment({
    env: environment,
    approvalPolicy,
    namespace,
    sourceSha: command === "prepare" ? values["--source-sha"] : null,
    runId: command === "prepare" ? values["--run-id"] : null,
  });
  const outputPath = path.resolve(cwd, values["--output"]);
  await assertOutputAbsent(outputPath);
  const store = await createBoundStore({
    environment,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    let result;
    if (command === "materialize") {
      const packageRoot = path.resolve(cwd, values["--package"]);
      await assertOutputAbsent(packageRoot);
      const current = await readState({ store, requireInitialized: true });
      const archivedBinding = selectRecoveryBinding({
        snapshot: current.snapshot,
        action: values["--action"],
        bindingId: values["--binding-id"],
      });
      if (archivedBinding.sourceSha !== values["--source-sha"]) {
        throw new Error("Artifact recovery archive source differs");
      }
      const bindings = resolveRecoveryPackageBindings({
        current,
        archivedBinding,
        namespace,
      });
      result = await materialize({
        store,
        namespace,
        bindings,
        packageRoot,
        releasePolicy,
      });
    } else if (command === "subject") {
      const current = await readState({ store, requireInitialized: true });
      const targetBinding = Object.hasOwn(values, "--target-binding")
        ? parseCanonicalJsonBytes(
            await readFileImpl(path.resolve(cwd, values["--target-binding"])),
            "Artifact recovery target binding",
          )
        : null;
      const companionBinding = Object.hasOwn(values, "--companion-binding")
        ? parseCanonicalJsonBytes(
            await readFileImpl(
              path.resolve(cwd, values["--companion-binding"]),
            ),
            "Artifact recovery companion binding",
          )
        : null;
      const produced = buildSubject({
        current,
        namespace,
        operationId: values["--operation-id"],
        action: values["--action"],
        bindingId: values["--binding-id"],
        expectedArchivedSourceSha: values["--source-sha"],
        targetBinding,
        companionBinding,
      });
      result = produced.subject;
    } else {
      const subjectBytes = await readFileImpl(
        path.resolve(cwd, values["--subject"]),
      );
      result = await prepare({
        store,
        subjectBytes,
        expectedSubjectSha256: values["--subject-sha256"],
        approvalPolicy,
        expectedExecutorSourceSha: values["--source-sha"],
        expectedRunId: values["--run-id"],
        oidcRequestUrl: requireEnvironment(
          environment,
          "ACTIONS_ID_TOKEN_REQUEST_URL",
        ),
        oidcRequestToken: requireEnvironment(
          environment,
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        ),
        githubToken: requireEnvironment(environment, "GITHUB_TOKEN"),
      });
    }
    const written = await writeOutput(outputPath, result);
    stdout.write(
      `PASS archive recovery ${command}: ${sha256Bytes(written.bytes)}\n`,
    );
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runArchiveRecoveryExecutionCli();
}
