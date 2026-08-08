#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  produceCompanionRecoveryDrill,
  produceContinuousProductionProbe,
} from "./acceptanceEvidenceInputs.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  parseCanonicalJsonBytes,
} from "./releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const COMMANDS = ["companion-recovery", "continuous-probe"];
const FLAGS = [
  "--namespace",
  "--output",
  "--release-evidence",
  "--release-evidence-sha256",
  "--source",
  "--source-sha256",
];

export const parseAcceptanceEvidenceInputArguments = (arguments_) => {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length !== 1 + FLAGS.length * 2
  ) {
    throw new Error(
      "Usage: produce-acceptance-evidence-input.mjs <continuous-probe|companion-recovery> [strict flags]",
    );
  }
  const [command, ...tokens] = arguments_;
  if (!COMMANDS.includes(command)) {
    throw new Error(`Invalid acceptance evidence input command: ${command}`);
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
        `Invalid or duplicate acceptance evidence input option: ${String(flag)}`,
      );
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SHA256_PATTERN.test(values["--release-evidence-sha256"]) ||
    !SHA256_PATTERN.test(values["--source-sha256"])
  ) {
    throw new Error("Acceptance evidence input arguments are invalid");
  }
  return { command, values };
};

const resolveDistinctPaths = (values, workingDirectory) => {
  const paths = Object.fromEntries(
    ["--release-evidence", "--source", "--output"].map((flag) => [
      flag,
      path.resolve(workingDirectory, values[flag]),
    ]),
  );
  const identities = Object.values(paths).map((value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      "Acceptance evidence producer inputs and output must be distinct",
    );
  }
  return paths;
};

const readBoundedRegularFile = async (
  filePath,
  { lstatImpl, readFileImpl },
) => {
  const metadata = await lstatImpl(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_INPUT_BYTES
  ) {
    throw new Error("Acceptance evidence producer input is invalid");
  }
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== metadata.size ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw new Error("Acceptance evidence producer input changed while read");
  }
  return bytes;
};

const assertOutputAvailable = async (filePath, lstatImpl) => {
  try {
    await lstatImpl(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Acceptance evidence producer output already exists");
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required acceptance evidence producer environment is absent: ${name}`,
    );
  }
  return value;
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

export const runAcceptanceEvidenceInputProducerCli = async (
  {
    arguments_ = process.argv.slice(2),
    environment = process.env,
    workingDirectory = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    lstatImpl = lstat,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    createStore = createPostgresReleaseStateStore,
    readState = readCurrentReleaseState,
    produceContinuous = produceContinuousProductionProbe,
    produceRecovery = produceCompanionRecoveryDrill,
    clock = Date.now,
  } = {},
) => {
  const parsed = parseAcceptanceEvidenceInputArguments(arguments_);
  const paths = resolveDistinctPaths(parsed.values, workingDirectory);
  await assertOutputAvailable(paths["--output"], lstatImpl);
  const inputOptions = { lstatImpl, readFileImpl };
  const [releaseAEvidenceBytes, sourceBytes] = await Promise.all([
    readBoundedRegularFile(paths["--release-evidence"], inputOptions),
    readBoundedRegularFile(paths["--source"], inputOptions),
  ]);
  const expectedReleaseAEvidenceSha256 =
    parsed.values["--release-evidence-sha256"];
  const expectedSourceSha256 = parsed.values["--source-sha256"];
  if (
    sha256Bytes(releaseAEvidenceBytes) !== expectedReleaseAEvidenceSha256 ||
    sha256Bytes(sourceBytes) !== expectedSourceSha256
  ) {
    throw new Error(
      "Acceptance evidence producer input differs from its reviewed SHA-256",
    );
  }
  const releaseAEvidence = parseCanonicalJsonBytes(
    releaseAEvidenceBytes,
    "Release A evidence",
  );
  const sourceSha = releaseAEvidence.release?.commitSha;
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("Release A evidence source identity is invalid");
  }
  const namespace = parsed.values["--namespace"];
  const [approvalPolicy, storePolicy, providerPolicy] = await Promise.all([
    loadJson(path.join(root, "config", "approval-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
    loadJson(path.join(root, "config", "provider-policy.json")),
  ]);
  const runId = requireEnvironment(environment, "GITHUB_RUN_ID");
  assertProtectedWorkflowEnvironment({
    env: environment,
    approvalPolicy,
    namespace,
    sourceSha,
    runId,
  });
  const store = await createBoundStore({
    environment,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    const current = await readState({ store });
    const pendingAcceptance = current.snapshot.pendingAcceptance;
    if (
      pendingAcceptance === null ||
      pendingAcceptance.operationId !== releaseAEvidence.release?.releaseId
    ) {
      throw new Error(
        "Acceptance evidence producer lacks a matching pending acceptance",
      );
    }
    const nowMilliseconds = clock();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("Acceptance evidence producer clock is invalid");
    }
    const common = {
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256,
      sourceBytes,
      expectedSourceSha256,
      nowMilliseconds,
    };
    const produced =
      parsed.command === "continuous-probe"
        ? await produceContinuous({
            ...common,
            providerPolicy,
          })
        : await produceRecovery({
            ...common,
            futureClockSkewSeconds:
              providerPolicy.observationPolicy.maxFutureClockSkewSeconds,
          });
    if (
      !produced ||
      !Buffer.isBuffer(produced.evidenceBytes) ||
      produced.sha256 !== sha256Bytes(produced.evidenceBytes)
    ) {
      throw new Error("Acceptance evidence producer result is invalid");
    }
    await writeFileImpl(paths["--output"], produced.evidenceBytes, {
      flag: "wx",
      mode: 0o600,
    });
    stdout.write(
      `PASS acceptance evidence ${parsed.command}: ${produced.sha256}\n`,
    );
    return produced;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runAcceptanceEvidenceInputProducerCli();
}
