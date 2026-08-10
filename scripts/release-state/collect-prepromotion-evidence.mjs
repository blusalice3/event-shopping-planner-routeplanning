#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import { executePrePromotionEvidenceCollection } from "./prePromotionEvidenceExecution.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  parseCanonicalJsonBytes,
} from "./releaseWorkflowValidation.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const FLAGS = Object.freeze([
  "--build-requirements",
  "--build-requirements-sha256",
  "--containment-binding",
  "--namespace",
  "--output",
  "--provider-observation",
  "--provider-observation-sha256",
  "--run-id",
  "--source-sha",
  "--standard-binding",
]);

export const parsePrePromotionEvidenceCollectorArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== FLAGS.length * 2) {
    throw new Error(
      "Usage: collect-prepromotion-evidence.mjs --namespace <name> --source-sha <sha> --run-id <id> --standard-binding <json> --containment-binding <json> --build-requirements <json> --build-requirements-sha256 <sha256> --provider-observation <json> --provider-observation-sha256 <sha256> --output <json>",
    );
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !FLAGS.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid or duplicate pre-promotion collector flag: ${flag}`,
      );
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
    !RUN_ID_PATTERN.test(values["--run-id"]) ||
    !SHA256_PATTERN.test(values["--build-requirements-sha256"]) ||
    !SHA256_PATTERN.test(values["--provider-observation-sha256"])
  ) {
    throw new Error("Pre-promotion collector identity arguments are invalid");
  }
  return values;
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required pre-promotion environment is absent: ${name}`);
  }
  return value;
};

const readBoundedRegularFile = async (filePath, lstatImpl, readFileImpl) => {
  const status = await lstatImpl(filePath);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1) {
    throw new Error("Pre-promotion collector input must be a regular file");
  }
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== status.size ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw new Error("Pre-promotion collector input is empty or oversized");
  }
  return bytes;
};

const createBoundStore = ({
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

const resolvePaths = (values, cwd) => {
  const paths = {
    buildRequirements: path.resolve(cwd, values["--build-requirements"]),
    containmentBinding: path.resolve(cwd, values["--containment-binding"]),
    output: path.resolve(cwd, values["--output"]),
    providerObservation: path.resolve(cwd, values["--provider-observation"]),
    standardBinding: path.resolve(cwd, values["--standard-binding"]),
  };
  const pathIdentities = Object.values(paths).map((value) =>
    value.toLocaleLowerCase("en-US"),
  );
  if (new Set(pathIdentities).size !== Object.keys(paths).length) {
    throw new Error(
      "Pre-promotion collector output must not overwrite an input",
    );
  }
  return paths;
};

export const runPrePromotionEvidenceCollectorCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    lstatImpl = lstat,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    createStore = createPostgresReleaseStateStore,
    assertEnvironment = assertProtectedWorkflowEnvironment,
    executeCollection = executePrePromotionEvidenceCollection,
  } = {},
) => {
  const values = parsePrePromotionEvidenceCollectorArguments(argv);
  const namespace = values["--namespace"];
  const sourceSha = values["--source-sha"];
  const workflowRunId = values["--run-id"];
  const paths = resolvePaths(values, cwd);
  const [approvalPolicy, storePolicy] = await Promise.all([
    loadJson(path.join(repositoryRoot, "config", "approval-policy.json")),
    loadJson(path.join(repositoryRoot, "config", "release-state-store.json")),
  ]);
  assertEnvironment({
    env,
    approvalPolicy,
    namespace,
    sourceSha,
    runId: workflowRunId,
  });
  requireEnvironment(env, "ACTIONS_ID_TOKEN_REQUEST_URL");
  requireEnvironment(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const runAttemptText = requireEnvironment(env, "GITHUB_RUN_ATTEMPT");
  if (!RUN_ID_PATTERN.test(runAttemptText)) {
    throw new Error("Pre-promotion workflow run attempt is invalid");
  }
  try {
    await lstatImpl(paths.output);
    throw new Error("Pre-promotion collector output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const [
    standardBindingBytes,
    containmentBindingBytes,
    buildRequirementsBytes,
    providerObservationBytes,
  ] = await Promise.all([
    readBoundedRegularFile(paths.standardBinding, lstatImpl, readFileImpl),
    readBoundedRegularFile(paths.containmentBinding, lstatImpl, readFileImpl),
    readBoundedRegularFile(paths.buildRequirements, lstatImpl, readFileImpl),
    readBoundedRegularFile(paths.providerObservation, lstatImpl, readFileImpl),
  ]);
  const standardBinding = parseCanonicalJsonBytes(
    standardBindingBytes,
    "Pre-promotion standard binding",
  );
  const containmentBinding = parseCanonicalJsonBytes(
    containmentBindingBytes,
    "Pre-promotion containment binding",
  );
  parseCanonicalJsonBytes(
    buildRequirementsBytes,
    "Pre-promotion build requirements",
  );
  parseCanonicalJsonBytes(providerObservationBytes, "Provider observation");
  if (
    sha256Bytes(buildRequirementsBytes) !==
      values["--build-requirements-sha256"] ||
    sha256Bytes(providerObservationBytes) !==
      values["--provider-observation-sha256"]
  ) {
    throw new Error("Pre-promotion collector input hash differs");
  }
  const store = await createBoundStore({
    environment: env,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    const result = await executeCollection({
      store,
      namespace,
      sourceSha,
      workflowRunId,
      runAttempt: Number(runAttemptText),
      repositoryRoot,
      standardBinding,
      containmentBinding,
      buildRequirementsBytes,
      buildRequirementsSha256: values["--build-requirements-sha256"],
      buildRequirementsPath: paths.buildRequirements,
      providerObservationBytes,
      providerObservationSha256: values["--provider-observation-sha256"],
      providerObservationPath: paths.providerObservation,
      environment: env,
      approvalPolicy,
    });
    await writeFileImpl(paths.output, result.sourceBytes, {
      flag: "wx",
      mode: 0o600,
    });
    stdout.write(`PASS pre-promotion evidence source ${result.sourceSha256}\n`);
    return result;
  } finally {
    await store.close?.();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPrePromotionEvidenceCollectorCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
