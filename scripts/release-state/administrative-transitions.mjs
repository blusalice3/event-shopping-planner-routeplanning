#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  buildAuthoritativeDbContractActivationSubject,
  buildAuthoritativeOperationAbortSubject,
  buildAuthoritativeStateInitializationSubject,
  executeAdministrativeTransition,
} from "./administrativeTransitions.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  parseCanonicalJsonBytes,
} from "./releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const COMMON_FLAGS = [
  "--namespace",
  "--operation-id",
  "--output",
  "--run-id",
  "--source-sha",
];
const COMMAND_FLAGS = Object.freeze({
  "produce-state-initialized": [
    ...COMMON_FLAGS,
    "--bootstrap-recovery-sha256",
    "--db-contract-sha256",
    "--legacy-observation-sha256",
    "--release-policy-sha256",
  ],
  "produce-db-contract-activated": [...COMMON_FLAGS, "--db-contract-sha256"],
  "produce-operation-aborted": [...COMMON_FLAGS, "--provider-observation"],
  execute: [...COMMON_FLAGS, "--subject", "--subject-sha256"],
});

export const parseAdministrativeArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Administrative transition command is required");
  }
  const [command, ...tokens] = argv;
  const expected = COMMAND_FLAGS[command];
  if (!expected || tokens.length !== expected.length * 2) {
    throw new Error(`Invalid administrative transition command: ${command}`);
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !expected.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid or duplicate administrative flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== expected.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !OPERATION_ID_PATTERN.test(values["--operation-id"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
    !RUN_ID_PATTERN.test(values["--run-id"])
  ) {
    throw new Error("Administrative transition identity arguments are invalid");
  }
  for (const flag of expected.filter((candidate) =>
    candidate.endsWith("-sha256"),
  )) {
    if (!SHA256_PATTERN.test(values[flag])) {
      throw new Error(`Administrative hash argument is invalid: ${flag}`);
    }
  }
  return { command, values };
};

const requireEnvironment = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required administrative environment is absent: ${name}`);
  }
  return value;
};

const createBoundStore = ({ env, namespace, storePolicy, createStore }) => {
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  return createStore({
    connectionString: requireEnvironment(
      env,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(env, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

const evidenceReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const readBounded = async (filePath, readFileImpl) => {
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw new Error("Administrative input is empty or oversized");
  }
  return bytes;
};

const resolveOutput = (values, cwd, inputFlag = null) => {
  const output = path.resolve(cwd, values["--output"]);
  if (inputFlag !== null && output === path.resolve(cwd, values[inputFlag])) {
    throw new Error("Administrative output must not overwrite its input");
  }
  return output;
};

export const runAdministrativeTransitionsCli = async (
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
    buildInitialization = buildAuthoritativeStateInitializationSubject,
    buildDbActivation = buildAuthoritativeDbContractActivationSubject,
    buildAbort = buildAuthoritativeOperationAbortSubject,
    execute = executeAdministrativeTransition,
  } = {},
) => {
  const { command, values } = parseAdministrativeArguments(argv);
  const namespace = values["--namespace"];
  const operationId = values["--operation-id"];
  const sourceSha = values["--source-sha"];
  const runId = values["--run-id"];
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
  const store = await createBoundStore({
    env,
    namespace,
    storePolicy,
    createStore,
  });
  let output;
  try {
    if (command === "execute") {
      const input = path.resolve(cwd, values["--subject"]);
      const subjectBytes = await readBounded(input, readFileImpl);
      const subject = parseCanonicalJsonBytes(
        subjectBytes,
        "Administrative transition subject",
      );
      if (
        sha256Bytes(subjectBytes) !== values["--subject-sha256"] ||
        subject.namespace !== namespace ||
        subject.operationId !== operationId ||
        subject.executorSourceSha !== sourceSha
      ) {
        throw new Error(
          "Administrative subject differs from reviewed CLI identity",
        );
      }
      output = await execute({
        store,
        subjectBytes,
        expectedSubjectSha256: values["--subject-sha256"],
        expectedExecutorSourceSha: sourceSha,
        expectedRunId: runId,
        approvalPolicy,
        oidcRequestUrl: requireEnvironment(env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
        oidcRequestToken: requireEnvironment(
          env,
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        ),
        githubToken: requireEnvironment(env, "GITHUB_TOKEN"),
      });
      await writeFileImpl(
        resolveOutput(values, cwd, "--subject"),
        `${JSON.stringify(output, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } else {
      let built;
      if (command === "produce-state-initialized") {
        built = await buildInitialization({
          store,
          namespace,
          operationId,
          executorSourceSha: sourceSha,
          bootstrapRecoveryReference: evidenceReference(
            namespace,
            values["--bootstrap-recovery-sha256"],
          ),
          legacyObservationReference: evidenceReference(
            namespace,
            values["--legacy-observation-sha256"],
          ),
          dbContractReference: evidenceReference(
            namespace,
            values["--db-contract-sha256"],
          ),
          activeReleasePolicyReference: evidenceReference(
            namespace,
            values["--release-policy-sha256"],
          ),
        });
      } else if (command === "produce-db-contract-activated") {
        built = await buildDbActivation({
          store,
          namespace,
          operationId,
          executorSourceSha: sourceSha,
          dbContractReference: evidenceReference(
            namespace,
            values["--db-contract-sha256"],
          ),
        });
      } else {
        const input = path.resolve(cwd, values["--provider-observation"]);
        built = await buildAbort({
          store,
          namespace,
          operationId,
          executorSourceSha: sourceSha,
          providerObservationBytes: await readBounded(input, readFileImpl),
        });
      }
      if (built.subject.executorSourceSha !== sourceSha) {
        throw new Error("Produced subject differs from protected source SHA");
      }
      await writeFileImpl(
        resolveOutput(
          values,
          cwd,
          command === "produce-operation-aborted"
            ? "--provider-observation"
            : null,
        ),
        built.subjectBytes,
        { flag: "wx" },
      );
      output = {
        schemaVersion: 1,
        resultKind: `${command}-subject/v1`,
        namespace,
        operationId,
        subjectSha256: built.subjectSha256,
        output: path.resolve(cwd, values["--output"]),
      };
    }
  } finally {
    await store.close?.();
  }
  stdout.write(`${JSON.stringify(output)}\n`);
  return output;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runAdministrativeTransitionsCli().catch((error) => {
    process.stderr.write(
      `Administrative transition failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
