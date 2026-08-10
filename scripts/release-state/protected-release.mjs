#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { preparePromotion } from "./promotionPreparation.mjs";
import {
  decideProviderReconciliation,
  storeProviderAliasObservation,
} from "./reconcileDecision.mjs";
import { appendReadyReconciliation } from "./lifecycleExecution.mjs";
import {
  NAMESPACE_PATTERN,
  SOURCE_SHA_PATTERN,
} from "./releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const COMMAND_FLAGS = {
  "prepare-promotion": [
    "--namespace",
    "--output",
    "--run-id",
    "--source-sha",
    "--subject",
    "--subject-sha256",
  ],
  reconcile: ["--namespace", "--output", "--provider-observation"],
};
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

export const parseProtectedReleaseArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      "Usage: protected-release.mjs <prepare-promotion|reconcile> [strict flags]",
    );
  }
  const [command, ...tokens] = argv;
  const expectedFlags = COMMAND_FLAGS[command];
  if (!expectedFlags || tokens.length !== expectedFlags.length * 2) {
    throw new Error(`Invalid protected release command: ${command}`);
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !expectedFlags.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid or duplicate protected release flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== expectedFlags.length) {
    throw new Error("Protected release arguments are incomplete");
  }
  if (!NAMESPACE_PATTERN.test(values["--namespace"])) {
    throw new Error("Release State namespace argument is invalid");
  }
  if (
    command === "prepare-promotion" &&
    (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
      !/^[0-9a-f]{64}$/.test(values["--subject-sha256"]) ||
      !RUN_ID_PATTERN.test(values["--run-id"]))
  ) {
    throw new Error("Protected release source SHA or run ID is invalid");
  }
  return { command, values };
};

const requireEnvironment = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required protected workflow environment is absent: ${name}`,
    );
  }
  return value;
};

export const assertProtectedWorkflowEnvironment = ({
  env,
  approvalPolicy,
  namespace,
  sourceSha = null,
  runId = null,
}) => {
  if (approvalPolicy?.bindingStatus !== "configured") {
    throw new Error(
      `Approval policy is not configured: ${(approvalPolicy?.blockerCodes ?? []).join(", ")}`,
    );
  }
  const exact = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: approvalPolicy.repository,
    GITHUB_WORKFLOW_REF: approvalPolicy.workflowRef,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_PROTECTED: "true",
    RELEASE_STATE_NAMESPACE: namespace,
  };
  if (sourceSha !== null) {
    exact.GITHUB_SHA = sourceSha;
    exact.GITHUB_RUN_ID = runId;
  }
  for (const [name, expected] of Object.entries(exact)) {
    if (requireEnvironment(env, name) !== expected) {
      throw new Error(
        `Protected workflow environment ${name} differs from the reviewed binding`,
      );
    }
  }
  if (
    !RUN_ID_PATTERN.test(requireEnvironment(env, "GITHUB_RUN_ID")) ||
    !RUN_ID_PATTERN.test(requireEnvironment(env, "GITHUB_RUN_ATTEMPT"))
  ) {
    throw new Error("Protected workflow run identity is invalid");
  }
};

const readBoundedFile = async (filePath, readFileImpl) => {
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw new Error("Protected release input is empty or oversized");
  }
  return bytes;
};

const resolveDistinctPaths = (inputPath, outputPath, cwd) => {
  const input = path.resolve(cwd, inputPath);
  const output = path.resolve(cwd, outputPath);
  if (input === output) {
    throw new Error("Protected release output must not overwrite its input");
  }
  return { input, output };
};

const createBoundStore = async ({
  env,
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
      env,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(env, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

export const runProtectedReleaseCli = async (
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
    prepare = preparePromotion,
    recordProviderObservation = storeProviderAliasObservation,
    decideReconcile = decideProviderReconciliation,
    appendReconcile = appendReadyReconciliation,
  } = {},
) => {
  const { command, values } = parseProtectedReleaseArguments(argv);
  const namespace = values["--namespace"];
  const [approvalPolicy, storePolicy] = await Promise.all([
    loadJson(path.join(root, "config", "approval-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
  ]);
  assertProtectedWorkflowEnvironment({
    env,
    approvalPolicy,
    namespace,
    sourceSha: command === "prepare-promotion" ? values["--source-sha"] : null,
    runId: command === "prepare-promotion" ? values["--run-id"] : null,
  });
  const inputArgument =
    command === "prepare-promotion"
      ? values["--subject"]
      : values["--provider-observation"];
  const { input, output } = resolveDistinctPaths(
    inputArgument,
    values["--output"],
    cwd,
  );
  const inputBytes = await readBoundedFile(input, readFileImpl);
  const store = await createBoundStore({
    env,
    namespace,
    storePolicy,
    createStore,
  });

  let result;
  try {
    if (command === "prepare-promotion") {
      result = await prepare({
        store,
        subjectBytes: inputBytes,
        approvalPolicy,
        expectedSubjectSha256: values["--subject-sha256"],
        expectedSourceSha: values["--source-sha"],
        expectedRunId: values["--run-id"],
        oidcRequestUrl: requireEnvironment(env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
        oidcRequestToken: requireEnvironment(
          env,
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        ),
        githubToken: requireEnvironment(env, "APPROVAL_GITHUB_TOKEN"),
      });
    } else {
      await recordProviderObservation({
        store,
        observationBytes: inputBytes,
      });
      const decision = await decideReconcile({
        store,
        observationBytes: inputBytes,
      });
      result =
        decision.status === "ready"
          ? await appendReconcile({ store, decision })
          : { ...decision, appended: false };
    }
    const outputBytes = canonicalJsonBytes(result);
    await writeFileImpl(output, outputBytes, {
      flag: "wx",
      mode: 0o600,
    });
    stdout.write(
      `PASS protected release ${command}: ${sha256Bytes(outputBytes)}\n`,
    );
    if (command === "reconcile" && result.status !== "ready") {
      throw new Error(`Reconcile is blocked: ${result.reasonCodes.join(", ")}`);
    }
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runProtectedReleaseCli();
}
