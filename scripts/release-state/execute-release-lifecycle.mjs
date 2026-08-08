#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  acceptPendingStandardRelease,
  recordPreparedPromotionAssignment,
  recordPreparedPromotionLifecycle,
} from "./lifecycleExecution.mjs";
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
const COMMAND_FLAGS = {
  "record-assignment": [
    "--assignment-authority",
    "--namespace",
    "--output",
    "--prepared-result",
    "--promotion-receipt",
  ],
  "record-promotion": [
    "--assignment-authority",
    "--assignment-validation",
    "--namespace",
    "--output",
    "--prepared-result",
    "--production-probe",
    "--promotion-receipt",
  ],
  "accept-standard": [
    "--continuous-probe",
    "--continuous-probe-sha256",
    "--evidence",
    "--evidence-sha256",
    "--namespace",
    "--output",
  ],
};
const ACCEPTANCE_RECOVERY_FLAGS = [
  "--companion-recovery-drill",
  "--companion-recovery-drill-sha256",
];

export const parseReleaseLifecycleArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length === 0) {
    throw new Error(
      "Usage: execute-release-lifecycle.mjs <record-assignment|record-promotion|accept-standard> [strict flags]",
    );
  }
  const [command, ...tokens] = arguments_;
  const baseFlags = COMMAND_FLAGS[command];
  const flagSets =
    command === "accept-standard"
      ? [baseFlags, [...baseFlags, ...ACCEPTANCE_RECOVERY_FLAGS]]
      : [baseFlags];
  if (
    !baseFlags ||
    !flagSets.some((flags) => tokens.length === flags.length * 2)
  ) {
    throw new Error(`Invalid release lifecycle command: ${String(command)}`);
  }
  const allowedFlags = [...new Set(flagSets.flat())];
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !allowedFlags.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid, duplicate, or forbidden lifecycle option: ${String(flag)}`,
      );
    }
    values[flag] = value;
  }
  const providedFlags = Object.keys(values).sort();
  const exactFlagSet = flagSets.some(
    (flags) =>
      flags.length === providedFlags.length &&
      [...flags].sort().every((flag, index) => flag === providedFlags[index]),
  );
  if (
    !exactFlagSet ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    (command === "accept-standard" &&
      (!SHA256_PATTERN.test(values["--evidence-sha256"]) ||
        !SHA256_PATTERN.test(values["--continuous-probe-sha256"]) ||
        (Object.hasOwn(values, "--companion-recovery-drill-sha256") &&
          !SHA256_PATTERN.test(values["--companion-recovery-drill-sha256"]))))
  ) {
    throw new Error("Release lifecycle arguments are incomplete or invalid");
  }
  return { command, values };
};

const resolveDistinctPaths = ({ command, values }, workingDirectory) => {
  const inputFlags = command.startsWith("record-")
    ? ["--prepared-result", "--promotion-receipt", "--assignment-authority"]
    : ["--evidence"];
  if (command === "record-promotion") {
    inputFlags.push("--assignment-validation", "--production-probe");
  }
  if (
    command === "accept-standard" &&
    Object.hasOwn(values, "--continuous-probe")
  ) {
    inputFlags.push("--continuous-probe");
  }
  if (
    command === "accept-standard" &&
    Object.hasOwn(values, "--companion-recovery-drill")
  ) {
    inputFlags.push("--companion-recovery-drill");
  }
  const paths = Object.fromEntries(
    [...inputFlags, "--output"].map((flag) => [
      flag,
      path.resolve(workingDirectory, values[flag]),
    ]),
  );
  const identities = Object.values(paths).map((value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("Lifecycle output and inputs must use distinct paths");
  }
  return paths;
};

const readBoundedRegularFile = async (
  filePath,
  { lstatImpl = lstat, readFileImpl = readFile } = {},
) => {
  const metadata = await lstatImpl(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_INPUT_BYTES
  ) {
    throw new Error("Lifecycle input path, type, or size is invalid");
  }
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== metadata.size ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw new Error("Lifecycle input changed while being read");
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
  throw new Error("Lifecycle output already exists");
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required lifecycle environment is absent: ${name}`);
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

const sourceFromPreparedResult = (bytes) => {
  const result = parseCanonicalJsonBytes(bytes, "Prepared promotion result");
  const sourceSha =
    result.event?.payload?.pendingOperation?.targetBinding?.sourceSha;
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("Prepared promotion source identity is invalid");
  }
  return sourceSha;
};

const sourceFromAcceptanceEvidence = (bytes) => {
  const evidence = parseCanonicalJsonBytes(
    bytes,
    "Release A acceptance evidence",
  );
  const sourceSha = evidence.release?.commitSha;
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("Acceptance evidence source identity is invalid");
  }
  return sourceSha;
};

export const runReleaseLifecycleCli = async (
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
    recordAssignment = recordPreparedPromotionAssignment,
    recordLifecycle = recordPreparedPromotionLifecycle,
    acceptRelease = acceptPendingStandardRelease,
  } = {},
) => {
  const parsed = parseReleaseLifecycleArguments(arguments_);
  const paths = resolveDistinctPaths(parsed, workingDirectory);
  await assertOutputAvailable(paths["--output"], lstatImpl);
  const namespace = parsed.values["--namespace"];
  const [storePolicy, approvalPolicy] = await Promise.all([
    loadJson(path.join(root, "config", "release-state-store.json")),
    loadJson(path.join(root, "config", "approval-policy.json")),
  ]);
  const inputOptions = { lstatImpl, readFileImpl };
  let sourceSha;
  let input;
  if (parsed.command.startsWith("record-")) {
    const commonInputs = await Promise.all([
      readBoundedRegularFile(paths["--prepared-result"], inputOptions),
      readBoundedRegularFile(paths["--promotion-receipt"], inputOptions),
      readBoundedRegularFile(paths["--assignment-authority"], inputOptions),
      loadJson(path.join(root, "config", "provider-policy.json")),
    ]);
    const [
      preparedResultBytes,
      promotionReceiptBytes,
      assignmentAuthorityBytes,
      providerPolicy,
    ] = commonInputs;
    sourceSha = sourceFromPreparedResult(preparedResultBytes);
    input = {
      preparedResultBytes,
      promotionReceiptBytes,
      assignmentAuthorityBytes,
      providerPolicy,
    };
    if (parsed.command === "record-promotion") {
      const [assignmentValidationBytes, productionProbeBytes] =
        await Promise.all([
          readBoundedRegularFile(
            paths["--assignment-validation"],
            inputOptions,
          ),
          readBoundedRegularFile(paths["--production-probe"], inputOptions),
        ]);
      input.assignmentValidationBytes = assignmentValidationBytes;
      input.productionProbeBytes = productionProbeBytes;
    }
  } else {
    const [evidenceBytes, continuousProbeBytes] = await Promise.all([
      readBoundedRegularFile(paths["--evidence"], inputOptions),
      readBoundedRegularFile(paths["--continuous-probe"], inputOptions),
    ]);
    const expectedEvidenceSha256 = parsed.values["--evidence-sha256"];
    const expectedContinuousProbeSha256 =
      parsed.values["--continuous-probe-sha256"];
    if (sha256Bytes(evidenceBytes) !== expectedEvidenceSha256) {
      throw new Error("Acceptance evidence differs from the reviewed SHA-256");
    }
    if (sha256Bytes(continuousProbeBytes) !== expectedContinuousProbeSha256) {
      throw new Error(
        "Continuous production probe differs from the reviewed SHA-256",
      );
    }
    sourceSha = sourceFromAcceptanceEvidence(evidenceBytes);
    input = {
      evidenceBytes,
      expectedEvidenceSha256,
      continuousProbeBytes,
      expectedContinuousProbeSha256,
    };
    if (Object.hasOwn(parsed.values, "--companion-recovery-drill")) {
      const companionRecoveryDrillBytes = await readBoundedRegularFile(
        paths["--companion-recovery-drill"],
        inputOptions,
      );
      const expectedCompanionRecoveryDrillSha256 =
        parsed.values["--companion-recovery-drill-sha256"];
      if (
        sha256Bytes(companionRecoveryDrillBytes) !==
        expectedCompanionRecoveryDrillSha256
      ) {
        throw new Error(
          "Companion recovery drill differs from the reviewed SHA-256",
        );
      }
      input.companionRecoveryDrillBytes = companionRecoveryDrillBytes;
      input.expectedCompanionRecoveryDrillSha256 =
        expectedCompanionRecoveryDrillSha256;
    }
  }
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
    let result;
    if (parsed.command === "record-assignment") {
      result = await recordAssignment({
        store,
        ...input,
        environment,
      });
    } else if (parsed.command === "record-promotion") {
      result = await recordLifecycle({
        store,
        ...input,
        environment,
      });
    } else {
      result = await acceptRelease({
        store,
        ...input,
        approvalPolicy,
        expectedRunId: runId,
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
    const outputBytes = canonicalJsonBytes(result);
    await writeFileImpl(paths["--output"], outputBytes, {
      flag: "wx",
      mode: 0o600,
    });
    stdout.write(
      `PASS release lifecycle ${parsed.command}: ${result.operationId}\n`,
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
  await runReleaseLifecycleCli();
}
