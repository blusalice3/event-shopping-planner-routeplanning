#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { exactFileIdentity } from "../lib/exact-file-identity.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { NAMESPACE_PATTERN } from "../release-state/releaseWorkflowValidation.mjs";
import { produceDeploymentBinding } from "./deploymentBindingProducer.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const FLAGS = [
  "--deployment-receipt",
  "--namespace",
  "--output",
  "--package",
  "--provider-observation",
  "--role",
];

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export const parseDeploymentBindingProducerArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== 1 + FLAGS.length * 2) {
    throw new Error(
      "Usage: produce-deployment-binding.mjs deployment-binding [strict flags]",
    );
  }
  const [command, ...tokens] = argv;
  if (command !== "deployment-binding") {
    throw new Error(`Invalid deployment binding producer command: ${command}`);
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !FLAGS.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid or duplicate deployment binding producer flag: ${flag}`,
      );
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !["standard", "containment"].includes(values["--role"])
  ) {
    throw new Error("Deployment binding producer arguments are invalid");
  }
  return values;
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required deployment binding environment is absent: ${name}`,
    );
  }
  return value;
};

const assertUnaliasedPath = async (filePath, expectedType, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (
    metadata.isSymbolicLink() ||
    (expectedType === "file" && !metadata.isFile()) ||
    (expectedType === "directory" && !metadata.isDirectory())
  ) {
    throw new Error(`${label} type or path alias is forbidden`);
  }
  const canonical = await realpath(resolved);
  if (comparablePath(canonical) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return {
    path: resolved,
    ...describeExactFile(metadata),
  };
};

const readBoundedInput = (description, openFile) =>
  readExactRegularFile({
    description,
    maximumBytes: MAX_INPUT_BYTES,
    label: "Deployment binding producer input",
    openFile,
  });

export const resolveDeploymentBindingProducerPaths = async (values, cwd) => {
  const packageRoot = await assertUnaliasedPath(
    path.resolve(cwd, values["--package"]),
    "directory",
    "Verified package root",
  );
  const receipt = await assertUnaliasedPath(
    path.resolve(cwd, values["--deployment-receipt"]),
    "file",
    "Deployment receipt",
  );
  const observation = await assertUnaliasedPath(
    path.resolve(cwd, values["--provider-observation"]),
    "file",
    "Provider observation",
  );
  if (receipt.identity === observation.identity) {
    throw new Error(
      "Deployment receipt and provider observation must be distinct files",
    );
  }
  const output = path.resolve(cwd, values["--output"]);
  const relativeOutput = path.relative(packageRoot.path, output);
  if (
    relativeOutput === "" ||
    (!relativeOutput.startsWith(`..${path.sep}`) &&
      relativeOutput !== ".." &&
      !path.isAbsolute(relativeOutput))
  ) {
    throw new Error("Deployment binding output must be outside the package");
  }
  if (
    [receipt.path, observation.path].some(
      (input) => comparablePath(input) === comparablePath(output),
    )
  ) {
    throw new Error("Deployment binding output must not overwrite an input");
  }
  return {
    packageRoot: packageRoot.path,
    receipt,
    observation,
    output,
  };
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

const assertCommittedOutputPath = async ({
  resolved,
  description,
  readOutputMetadata,
}) => {
  const metadata = await readOutputMetadata(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Deployment binding output path changed after commit");
  }
  const current = describeExactFile(metadata);
  if (
    current.identity !== description.identity ||
    current.size !== description.size
  ) {
    throw new Error("Deployment binding output path changed after commit");
  }
};

export const writeDeploymentBindingCreateOnly = async (
  outputPath,
  bytes,
  { readCommittedFile = readExactRegularFile, readOutputMetadata = lstat } = {},
) => {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const parent = await assertUnaliasedPath(
    path.dirname(resolved),
    "directory",
    "Deployment binding output directory",
  );
  if (comparablePath(parent.path) !== comparablePath(path.dirname(resolved))) {
    throw new Error("Deployment binding output directory is aliased");
  }
  const temporary = path.join(
    parent.path,
    `.${path.basename(resolved)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let temporaryHandle;
  let temporaryDescription;
  let temporaryRetired = false;
  let linked = false;
  try {
    temporaryHandle = await open(temporary, "wx", 0o600);
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    temporaryDescription = {
      path: temporary,
      ...describeExactFile(await temporaryHandle.stat({ bigint: true })),
    };
    await link(temporary, resolved);
    linked = true;
    temporaryDescription = {
      path: temporary,
      ...describeExactFile(await temporaryHandle.stat({ bigint: true })),
    };
    await assertCommittedOutputPath({
      resolved,
      description: temporaryDescription,
      readOutputMetadata,
    });
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await unlink(temporary);
    temporaryRetired = true;
    await assertCommittedOutputPath({
      resolved,
      description: temporaryDescription,
      readOutputMetadata,
    });
    const finalizedBytes = await readCommittedFile({
      description: { ...temporaryDescription, path: resolved },
      maximumBytes: bytes.length,
      label: "Finalized deployment binding output",
      requireDescriptionTimestamps: false,
    });
    if (!finalizedBytes.equals(bytes)) {
      throw new Error("Finalized deployment binding output bytes differ");
    }
    await assertCommittedOutputPath({
      resolved,
      description: temporaryDescription,
      readOutputMetadata,
    });
    const committedBytes = await readCommittedFile({
      description: { ...temporaryDescription, path: resolved },
      maximumBytes: bytes.length,
      label: "Deployment binding output",
      requireDescriptionTimestamps: false,
    });
    if (!committedBytes.equals(bytes)) {
      throw new Error("Deployment binding output committed bytes differ");
    }
    await assertCommittedOutputPath({
      resolved,
      description: temporaryDescription,
      readOutputMetadata,
    });
    const settledBytes = await readCommittedFile({
      description: { ...temporaryDescription, path: resolved },
      maximumBytes: bytes.length,
      label: "Settled deployment binding output",
      requireDescriptionTimestamps: false,
    });
    if (!settledBytes.equals(bytes)) {
      throw new Error("Settled deployment binding output bytes differ");
    }
  } catch (error) {
    if (linked && temporaryDescription !== undefined) {
      const current = await lstat(resolved, { bigint: true }).catch(() => null);
      if (
        current !== null &&
        !current.isSymbolicLink() &&
        exactFileIdentity(current) === temporaryDescription.identity
      ) {
        await unlink(resolved);
      }
    }
    throw error;
  } finally {
    await temporaryHandle?.close();
    if (!temporaryRetired) {
      await unlink(temporary).catch(() => {});
    }
  }
};

export const runDeploymentBindingProducerCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    openFile = open,
    createStore = createPostgresReleaseStateStore,
    producer = produceDeploymentBinding,
    writeOutput = writeDeploymentBindingCreateOnly,
  } = {},
) => {
  const values = parseDeploymentBindingProducerArguments(argv);
  const namespace = values["--namespace"];
  if (
    requireEnvironment(environment, "RELEASE_STATE_NAMESPACE") !== namespace
  ) {
    throw new Error(
      "Release State namespace differs from producer environment",
    );
  }
  const paths = await resolveDeploymentBindingProducerPaths(values, cwd);
  const [
    deploymentReceiptBytes,
    providerObservationBytes,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    dbContract,
    cspPolicy,
    storePolicy,
  ] = await Promise.all([
    readBoundedInput(paths.receipt, openFile),
    readBoundedInput(paths.observation, openFile),
    loadJson(path.join(root, "config", "release-variants.json")),
    loadJson(path.join(root, "config", "toolchain-versions.json")),
    loadJson(path.join(root, "config", "provider-policy.json")),
    loadJson(path.join(root, "config", "db-compatibility-contract.json")),
    loadJson(path.join(root, "config", "csp-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
  ]);
  const store = await createBoundStore({
    environment,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    const result = await producer({
      packageRoot: paths.packageRoot,
      role: values["--role"],
      deploymentReceiptBytes,
      providerObservationBytes,
      namespace,
      store,
      releasePolicy,
      toolchainPolicy,
      providerPolicy,
      dbContract,
      cspPolicy,
      environment,
    });
    await writeOutput(paths.output, result.bindingBytes);
    stdout.write(
      `PASS authoritative deployment binding: ${result.bindingSha256}\n`,
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
  await runDeploymentBindingProducerCli();
}
