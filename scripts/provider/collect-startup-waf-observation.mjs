#!/usr/bin/env node

import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { assertProtectedWorkflowEnvironment } from "../release-state/protected-release.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import {
  NAMESPACE_PATTERN,
  SOURCE_SHA_PATTERN,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  STARTUP_WAF_MEDIA_TYPES,
  STARTUP_WAF_OPERATION,
  collectAndStoreStartupWafObservation,
} from "./startup-waf-observation.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const FLAGS = Object.freeze(["--namespace", "--output", "--source-sha"]);
const MAX_FIXTURE_BYTES = 1024 * 1024;

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required startup WAF environment is absent: ${name}`);
  }
  return value;
};

export const parseStartupWafObservationArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== FLAGS.length * 2) {
    throw new Error(
      "Usage: collect-startup-waf-observation.mjs --namespace <value> --source-sha <sha> --output <path>",
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
      throw new Error(`Invalid startup WAF collector flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"])
  ) {
    throw new Error("Startup WAF collector identity is invalid");
  }
  return values;
};

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const readExactFixture = async ({ fixturePath, root = repositoryRoot }) => {
  const resolved = path.resolve(root, fixturePath);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Startup WAF fixture escapes the repository");
  }
  const metadata = await lstat(resolved, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Startup WAF fixture is not a regular file");
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error("Startup WAF fixture path is aliased");
  }
  return readExactRegularFile({
    description: { path: resolved, ...describeExactFile(metadata) },
    maximumBytes: MAX_FIXTURE_BYTES,
    label: "Startup WAF fixture",
  });
};

export const loadStartupWafFixtures = async ({ startupContract, root }) => {
  if (!Array.isArray(startupContract?.profiles)) {
    throw new Error("Startup WAF profile contract is invalid");
  }
  const pairs = await Promise.all(
    startupContract.profiles.map(async (profile) => [
      profile.id,
      await readExactFixture({ fixturePath: profile.fixturePath, root }),
    ]),
  );
  if (
    pairs.some(([id]) => typeof id !== "string") ||
    new Set(pairs.map(([id]) => id)).size !== pairs.length
  ) {
    throw new Error("Startup WAF fixture identities are ambiguous");
  }
  return new Map(pairs);
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

export const writeStartupWafResultCreateOnly = async (
  outputPath,
  bytes,
  { lstatImpl = lstat, realpathImpl = realpath, openImpl = open } = {},
) => {
  const resolved = path.resolve(outputPath);
  const parent = path.dirname(resolved);
  const parentMetadata = await lstatImpl(parent, { bigint: true });
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Startup WAF output directory is not a regular directory");
  }
  if (comparablePath(await realpathImpl(parent)) !== comparablePath(parent)) {
    throw new Error("Startup WAF output directory is aliased");
  }
  const handle = await openImpl(resolved, "wx", 0o600);
  let descriptorIdentity;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Startup WAF output descriptor changed type");
    }
    descriptorIdentity = describeExactFile(metadata).identity;
  } finally {
    await handle.close();
  }
  const committedMetadata = await lstatImpl(resolved, { bigint: true });
  const committedDescription = {
    path: resolved,
    ...describeExactFile(committedMetadata),
  };
  if (
    committedMetadata.isSymbolicLink() ||
    !committedMetadata.isFile() ||
    committedDescription.identity !== descriptorIdentity
  ) {
    throw new Error("Startup WAF output path differs from its descriptor");
  }
  const readback = await readExactRegularFile({
    description: committedDescription,
    maximumBytes: bytes.length,
    label: "Startup WAF output",
    requireDescriptionTimestamps: false,
  });
  if (!readback.equals(bytes)) {
    throw new Error("Startup WAF output descriptor readback differs");
  }
};

export const runStartupWafObservationCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    root = repositoryRoot,
    loadJson = readJsonStrict,
    loadFixtures = loadStartupWafFixtures,
    assertEnvironment = assertProtectedWorkflowEnvironment,
    createStore = createPostgresReleaseStateStore,
    collect = collectAndStoreStartupWafObservation,
    launchBrowser = async () => {
      const { chromium } = await import("@playwright/test");
      return chromium.launch({ headless: true });
    },
    writeResult = writeStartupWafResultCreateOnly,
  } = {},
) => {
  const values = parseStartupWafObservationArguments(argv);
  const namespace = values["--namespace"];
  const sourceSha = values["--source-sha"];
  const [
    approvalPolicy,
    storePolicy,
    providerPolicy,
    startupContract,
    metricsContract,
  ] = await Promise.all([
    loadJson(path.join(root, "config", "approval-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
    loadJson(path.join(root, "config", "provider-policy.json")),
    loadJson(
      path.join(
        root,
        "contracts",
        "persistence-release-a-startup-bursts-v1.json",
      ),
    ),
    loadJson(
      path.join(root, "contracts", "persistence-release-a-metrics-v1.json"),
    ),
  ]);
  assertEnvironment({
    env,
    approvalPolicy,
    namespace,
    sourceSha,
    runId: requireEnvironment(env, "GITHUB_RUN_ID"),
  });
  if (
    requireEnvironment(env, "REQUESTED_OPERATION") !== STARTUP_WAF_OPERATION
  ) {
    throw new Error("Startup WAF protected operation binding differs");
  }
  const fixtures = await loadFixtures({ startupContract, root });
  const store = await createBoundStore({
    environment: env,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    const collected = await collect(
      {
        store,
        namespace,
        sourceSha,
        providerPolicy,
        approvalPolicy,
        startupContract,
        metricsContract,
        fixtures,
        environment: env,
      },
      { launchBrowser },
    );
    const result = {
      schemaVersion: 1,
      resultKind: "startup-waf-observation-stored/v1",
      namespace,
      sourceSha,
      workflowRunId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      mediaTypes: STARTUP_WAF_MEDIA_TYPES,
      authority: collected.reference,
      transcript: collected.transcriptReference,
    };
    const bytes = canonicalJsonBytes(result);
    await writeResult(path.resolve(cwd, values["--output"]), bytes);
    stdout.write(`${bytes.toString("utf8")}\n`);
    return result;
  } finally {
    await store.close?.();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runStartupWafObservationCli().catch(() => {
    process.stderr.write("Startup WAF observation failed\n");
    process.exitCode = 1;
  });
}
