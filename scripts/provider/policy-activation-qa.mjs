#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import { assertProtectedWorkflowEnvironment } from "../release-state/protected-release.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { executePolicyActivationQaExecution } from "../release-state/policyActivationQaExecution.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  parseCanonicalJsonBytes,
} from "../release-state/releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_SUBJECT_BYTES = 4 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const EXECUTE_FLAGS = [
  "--namespace",
  "--operation-id",
  "--output",
  "--run-id",
  "--source-sha",
  "--subject",
  "--subject-sha256",
];

export const parsePolicyActivationQaArguments = (argv) => {
  if (!Array.isArray(argv) || argv[0] !== "execute") {
    throw new Error("Policy QA command must be execute");
  }
  const tokens = argv.slice(1);
  if (tokens.length !== EXECUTE_FLAGS.length * 2) {
    throw new Error("Policy QA execute flags are incomplete");
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !EXECUTE_FLAGS.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid or duplicate Policy QA flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== EXECUTE_FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !OPERATION_ID_PATTERN.test(values["--operation-id"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
    !SHA256_PATTERN.test(values["--subject-sha256"]) ||
    !RUN_ID_PATTERN.test(values["--run-id"])
  ) {
    throw new Error("Policy QA execute identity is invalid");
  }
  return values;
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required Policy QA environment is absent: ${name}`);
  }
  return value;
};

const readBoundedSubject = async (filePath, readFileImpl) => {
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_SUBJECT_BYTES
  ) {
    throw new Error("Policy QA execution subject is empty or oversized");
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
    throw new Error("Policy QA Release State store policy is invalid");
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

export const runPolicyActivationQaCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    createStore = createPostgresReleaseStateStore,
    assertEnvironment = assertProtectedWorkflowEnvironment,
    execute = executePolicyActivationQaExecution,
  } = {},
) => {
  const values = parsePolicyActivationQaArguments(argv);
  const namespace = values["--namespace"];
  const operationId = values["--operation-id"];
  const sourceSha = values["--source-sha"];
  const runId = values["--run-id"];
  if (
    requireEnvironment(env, "RELEASE_STATE_NAMESPACE") !== namespace ||
    requireEnvironment(env, "GITHUB_SHA") !== sourceSha ||
    requireEnvironment(env, "GITHUB_RUN_ID") !== runId
  ) {
    throw new Error("Policy QA protected workflow identity differs");
  }
  const [approvalPolicy, storePolicy] = await Promise.all([
    loadJson(path.join(root, "config", "approval-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
  ]);
  assertEnvironment({
    env,
    approvalPolicy,
    namespace,
    sourceSha,
    runId,
  });
  const subjectPath = path.resolve(cwd, values["--subject"]);
  const outputPath = path.resolve(cwd, values["--output"]);
  if (subjectPath === outputPath) {
    throw new Error("Policy QA output must not overwrite its reviewed subject");
  }
  const subjectBytes = await readBoundedSubject(subjectPath, readFileImpl);
  if (sha256Bytes(subjectBytes) !== values["--subject-sha256"]) {
    throw new Error("Policy QA reviewed subject SHA-256 differs");
  }
  const subject = parseCanonicalJsonBytes(
    subjectBytes,
    "Policy QA reviewed execution subject",
  );
  if (
    subject.namespace !== namespace ||
    subject.operationId !== operationId ||
    subject.executorSourceSha !== sourceSha
  ) {
    throw new Error("Policy QA CLI flags differ from reviewed subject");
  }
  const store = await createBoundStore({
    environment: env,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    const result = await execute({
      store,
      namespace,
      subjectBytes,
      expectedSubjectSha256: values["--subject-sha256"],
      workflowRunId: runId,
      environment: env,
    });
    await writeFileImpl(outputPath, result.executionBytes, {
      flag: "wx",
      mode: 0o600,
    });
    const output = {
      schemaVersion: 1,
      resultKind: "policy-activation-qa-execution-result/v1",
      namespace,
      operationId,
      subjectSha256: values["--subject-sha256"],
      executionSha256: result.executionSha256,
      output: outputPath,
    };
    stdout.write(`${JSON.stringify(output)}\n`);
    return output;
  } finally {
    await store.close?.();
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPolicyActivationQaCli().catch((error) => {
    const evidence = error?.evidenceReference?.sha256
      ? ` evidence=${error.evidenceReference.sha256}`
      : "";
    process.stderr.write(
      `Policy activation QA failed: ${error.message}${evidence}\n`,
    );
    process.exitCode = 1;
  });
}
