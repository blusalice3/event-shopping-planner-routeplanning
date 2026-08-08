#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import {
  buildAuthoritativePromotionSubject,
  buildAuthoritativeProviderAliasObservation,
} from "./authoritativeInputProducers.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
} from "./releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_FLAGS = {
  "promotion-subject": [
    "--containment-binding",
    "--evidence-set",
    "--namespace",
    "--operation-id",
    "--output",
    "--standard-binding",
  ],
  "provider-observation": ["--namespace", "--output"],
};

export const parseAuthoritativeInputProducerArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      "Usage: produce-protected-input.mjs <promotion-subject|provider-observation> [strict flags]",
    );
  }
  const [command, ...tokens] = argv;
  const expectedFlags = COMMAND_FLAGS[command];
  if (!expectedFlags || tokens.length !== expectedFlags.length * 2) {
    throw new Error(`Invalid authoritative input command: ${command}`);
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
      throw new Error(`Invalid or duplicate authoritative input flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== expectedFlags.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    (command === "promotion-subject" &&
      !OPERATION_ID_PATTERN.test(values["--operation-id"]))
  ) {
    throw new Error("Authoritative input arguments are incomplete or invalid");
  }
  return { command, values };
};

const requireEnvironment = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required producer environment is absent: ${name}`);
  }
  return value;
};

const readBoundedFile = async (filePath, readFileImpl) => {
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw new Error("Authoritative producer input is empty or oversized");
  }
  return bytes;
};

const resolveOutputPath = (value, cwd) => path.resolve(cwd, value);

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

const assertDistinctPaths = (paths) => {
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      "Authoritative producer output must not overwrite an input",
    );
  }
};

export const runAuthoritativeInputProducerCli = async (
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
    buildPromotionSubject = buildAuthoritativePromotionSubject,
    buildProviderObservation = buildAuthoritativeProviderAliasObservation,
  } = {},
) => {
  const { command, values } = parseAuthoritativeInputProducerArguments(argv);
  const namespace = values["--namespace"];
  if (requireEnvironment(env, "RELEASE_STATE_NAMESPACE") !== namespace) {
    throw new Error(
      "Release State namespace differs from the producer environment",
    );
  }
  const storePolicy = await loadJson(
    path.join(root, "config", "release-state-store.json"),
  );
  const output = resolveOutputPath(values["--output"], cwd);
  const store = await createBoundStore({
    env,
    namespace,
    storePolicy,
    createStore,
  });

  try {
    let result;
    if (command === "promotion-subject") {
      const inputPaths = {
        standard: path.resolve(cwd, values["--standard-binding"]),
        containment: path.resolve(cwd, values["--containment-binding"]),
        evidenceSet: path.resolve(cwd, values["--evidence-set"]),
      };
      assertDistinctPaths([...Object.values(inputPaths), output]);
      const [standardBindingBytes, containmentBindingBytes, evidenceSetBytes] =
        await Promise.all([
          readBoundedFile(inputPaths.standard, readFileImpl),
          readBoundedFile(inputPaths.containment, readFileImpl),
          readBoundedFile(inputPaths.evidenceSet, readFileImpl),
        ]);
      result = await buildPromotionSubject({
        store,
        namespace,
        operationId: values["--operation-id"],
        standardBindingBytes,
        containmentBindingBytes,
        evidenceSetBytes,
      });
      await writeFileImpl(output, result.subjectBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative promotion subject: ${result.subjectSha256}\n`,
      );
    } else {
      const providerPolicy = await loadJson(
        path.join(root, "config", "provider-policy.json"),
      );
      result = await buildProviderObservation({
        store,
        namespace,
        providerPolicy,
        providerToken: requireEnvironment(env, "VERCEL_TOKEN"),
      });
      await writeFileImpl(output, result.observationBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative provider observation: ${result.observationSha256}\n`,
      );
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
  await runAuthoritativeInputProducerCli();
}
