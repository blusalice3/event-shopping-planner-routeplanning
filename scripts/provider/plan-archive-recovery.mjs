#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "../lib/canonical-json.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import {
  NAMESPACE_PATTERN,
  SOURCE_SHA_PATTERN,
} from "../release-state/releaseWorkflowValidation.mjs";
import { writeDeploymentBindingCreateOnly } from "./produce-deployment-binding.mjs";
import {
  ARCHIVE_RECOVERY_ACTIONS,
  planArtifactRecovery,
} from "./archiveRecovery.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const FLAGS = [
  "--action",
  "--binding-id",
  "--namespace",
  "--output",
  "--source-sha",
];

export const parseArchiveRecoveryArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== FLAGS.length * 2) {
    throw new Error("Artifact recovery dry-run requires five strict flags");
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
      throw new Error(`Invalid artifact recovery option: ${String(flag)}`);
    }
    values[flag] = value;
  }
  if (
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
    !ARCHIVE_RECOVERY_ACTIONS.includes(values["--action"])
  ) {
    throw new Error("Artifact recovery arguments are invalid");
  }
  return values;
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required artifact recovery environment is absent: ${name}`,
    );
  }
  return value;
};

export const runArchiveRecoveryCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    createStore = createPostgresReleaseStateStore,
    planner = planArtifactRecovery,
    writeOutput = writeDeploymentBindingCreateOnly,
  } = {},
) => {
  const values = parseArchiveRecoveryArguments(argv);
  const namespace = values["--namespace"];
  if (
    requireEnvironment(environment, "RELEASE_STATE_NAMESPACE") !== namespace
  ) {
    throw new Error("Artifact recovery namespace differs from its environment");
  }
  const storePolicy = await loadJson(
    path.join(root, "config", "release-state-store.json"),
  );
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  const store = await createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const result = await planner({
      store,
      namespace,
      action: values["--action"],
      bindingId: values["--binding-id"],
      expectedSourceSha: values["--source-sha"],
    });
    await writeOutput(
      path.resolve(cwd, values["--output"]),
      canonicalJsonBytes(result),
    );
    stdout.write(
      `PASS artifact recovery dry-run ${result.action}: ${result.binding.bindingId}\n`,
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
  await runArchiveRecoveryCli();
}
