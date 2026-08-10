#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict, sha256Bytes } from "./lib/canonical-json.mjs";
import { GITHUB_OIDC_RECEIPT_MEDIA_TYPE } from "./release-state/acceptanceEvidenceAuthority.mjs";
import {
  assertStoredGitHubOidcReceipt,
  deriveGitHubOidcPolicy,
} from "./release-state/githubOidc.mjs";
import { createPostgresReleaseStateStore } from "./release-state/postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./release-state/protected-release.mjs";
import { resolvePendingAcceptanceRequirements } from "./release-state/lifecycleExecution.mjs";
import { parseProtectedRawPerformanceArtifact } from "./release-state/ownGatePerformanceCollection.mjs";
import {
  assertAuthoritativeOwnGatePerformanceRequirements,
  assertUnchangedOwnGatePerformanceRequirements,
  produceAuthoritativeOwnGatePerformanceEvidence,
} from "./release-state/ownGatePerformanceEvidence.mjs";
import { collectReviewedWorkflowRunAuthority } from "./release-state/reviewedWorkflowRunAuthority.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  parseCanonicalJsonBytes,
} from "./release-state/releaseWorkflowValidation.mjs";
import { verifyPerformancePolicy } from "./verify-performance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RAW_SAMPLES_BYTES = 64 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const PERFORMANCE_WORKFLOW_PATH = ".github/workflows/performance-evidence.yml";
const ARGUMENT_NAMES = new Set([
  "--namespace",
  "--raw-samples",
  "--raw-samples-sha256",
  "--raw-samples-run-id",
  "--raw-samples-run-attempt",
  "--output",
  "--receipt-output",
]);
const usage =
  "Usage: produce-own-gate-performance-evidence.mjs " +
  "--namespace <release-state-namespace> --raw-samples <reviewed-json> " +
  "--raw-samples-sha256 <sha256> --raw-samples-run-id <prior-run-id> " +
  "--raw-samples-run-attempt <prior-run-attempt> " +
  "--output <performance-evidence.json> " +
  "--receipt-output <producer-receipt.json>";

export const parseOwnGatePerformanceEvidenceArguments = (arguments_) => {
  const values = Object.fromEntries(
    [...ARGUMENT_NAMES].map((argument) => [argument, null]),
  );
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!ARGUMENT_NAMES.has(argument)) {
      throw new Error(`Unknown own-gate performance argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      ARGUMENT_NAMES.has(value) ||
      seen.has(argument)
    ) {
      throw new Error(`Own-gate performance argument ${argument} is invalid`);
    }
    values[argument] = value;
    seen.add(argument);
    index += 1;
  }
  if ([...ARGUMENT_NAMES].some((argument) => values[argument] === null)) {
    throw new Error(usage);
  }
  if (
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SHA256_PATTERN.test(values["--raw-samples-sha256"]) ||
    !RUN_ID_PATTERN.test(values["--raw-samples-run-id"]) ||
    !RUN_ID_PATTERN.test(values["--raw-samples-run-attempt"])
  ) {
    throw new Error("Own-gate performance authority arguments are invalid");
  }
  return {
    namespace: values["--namespace"],
    rawSamplesPath: values["--raw-samples"],
    expectedRawSamplesSha256: values["--raw-samples-sha256"],
    rawSamplesRunId: values["--raw-samples-run-id"],
    rawSamplesRunAttempt: values["--raw-samples-run-attempt"],
    outputPath: values["--output"],
    receiptOutputPath: values["--receipt-output"],
  };
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required own-gate performance environment is absent: ${name}`,
    );
  }
  return value;
};

const pathIdentity = (value) =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;

const resolvePaths = (parsed, workingDirectory) => {
  const paths = {
    rawSamples: path.resolve(workingDirectory, parsed.rawSamplesPath),
    output: path.resolve(workingDirectory, parsed.outputPath),
    receiptOutput: path.resolve(workingDirectory, parsed.receiptOutputPath),
  };
  const identities = Object.values(paths).map(pathIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      "Own-gate performance inputs and outputs must use distinct paths",
    );
  }
  return paths;
};

const assertOutputAvailable = async (filePath, lstatImpl) => {
  try {
    await lstatImpl(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Own-gate performance output already exists");
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
    metadata.size > MAX_RAW_SAMPLES_BYTES
  ) {
    throw new Error("Reviewed raw performance samples file is invalid");
  }
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== metadata.size ||
    bytes.length > MAX_RAW_SAMPLES_BYTES
  ) {
    throw new Error("Reviewed raw performance samples changed while read");
  }
  return bytes;
};

const execGit = (arguments_, options = {}) =>
  execFileSync("git", arguments_, {
    cwd: root,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

export const resolveCleanOwnGatePerformanceSource = async ({ environment }) => {
  const packageJson = await readJsonStrict(path.join(root, "package.json"));
  if (process.versions.node !== packageJson.engines.node) {
    throw new Error(
      `Own-gate performance producer requires Node ${packageJson.engines.node}; received ${process.versions.node}`,
    );
  }
  if (
    execGit(["status", "--porcelain", "--untracked-files=all"]).trim() !== ""
  ) {
    throw new Error("Own-gate performance producer requires a clean Git tree");
  }
  const gitCommitSha = execGit(["rev-parse", "HEAD"]).trim();
  if (requireEnvironment(environment, "GITHUB_SHA") !== gitCommitSha) {
    throw new Error(
      "Own-gate performance workflow source differs from clean HEAD",
    );
  }
  const treeBytes = execGit(
    ["ls-tree", "-r", "-z", "--full-tree", gitCommitSha],
    { encoding: null },
  );
  return {
    gitCommitSha,
    sourceClosureSha256: sha256Bytes(treeBytes),
    treeState: "clean",
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

export const resolveRawCollectorAuthority = async ({
  rawArtifactBytes,
  rawSamplesRunId,
  rawSamplesRunAttempt,
  sourceSha,
  namespace,
  approvalPolicy,
  environment,
  store,
  collectRunAuthority,
}) => {
  const artifact = parseProtectedRawPerformanceArtifact({
    bytes: rawArtifactBytes,
    namespace,
  });
  const stored = await store.readEvidence({
    sha256: artifact.collectorIdentity.sha256,
  });
  if (
    !stored?.bytes ||
    sha256Bytes(stored.bytes) !== artifact.collectorIdentity.sha256 ||
    stored.mediaType !== GITHUB_OIDC_RECEIPT_MEDIA_TYPE
  ) {
    throw new Error("Raw performance collector OIDC identity is absent");
  }
  const receipt = parseCanonicalJsonBytes(
    stored.bytes,
    "Raw performance collector OIDC identity",
  );
  const oidcPolicy = deriveGitHubOidcPolicy({
    basePolicy: approvalPolicy,
    workflowPath: PERFORMANCE_WORKFLOW_PATH,
    protectedEnvironment: "foundation-performance",
  });
  assertStoredGitHubOidcReceipt({
    receipt,
    policy: oidcPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: rawSamplesRunId,
    expectedRunAttempt: rawSamplesRunAttempt,
  });
  const runAuthority = await collectRunAuthority({
    githubToken: requireEnvironment(environment, "GITHUB_TOKEN"),
    namespace,
    repository: approvalPolicy.repository,
    expectedRunId: rawSamplesRunId,
    expectedRunAttempt: rawSamplesRunAttempt,
    expectedSourceSha: sourceSha,
    expectedWorkflowPath: PERFORMANCE_WORKFLOW_PATH,
    store,
  });
  return {
    collectorAuthority: {
      collectorIdentity: structuredClone(artifact.collectorIdentity),
      workflowRunAuthority: structuredClone(runAuthority.receipt),
    },
  };
};

export const runOwnGatePerformanceEvidenceProducerCli = async (
  {
    arguments_ = process.argv.slice(2),
    environment = process.env,
    workingDirectory = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    lstatImpl = lstat,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    loadJson = readJsonStrict,
    verifyPolicy = verifyPerformancePolicy,
    createStore = createPostgresReleaseStateStore,
    resolveRequirements = resolvePendingAcceptanceRequirements,
    resolveSource = resolveCleanOwnGatePerformanceSource,
    produceEvidence = produceAuthoritativeOwnGatePerformanceEvidence,
    resolveCollectorAuthority = resolveRawCollectorAuthority,
    collectRunAuthority = collectReviewedWorkflowRunAuthority,
    clock = Date.now,
  } = {},
) => {
  const parsed = parseOwnGatePerformanceEvidenceArguments(arguments_);
  const paths = resolvePaths(parsed, workingDirectory);
  await Promise.all([
    assertOutputAvailable(paths.output, lstatImpl),
    assertOutputAvailable(paths.receiptOutput, lstatImpl),
  ]);
  const rawSamplesBytes = await readBoundedRegularFile(paths.rawSamples, {
    lstatImpl,
    readFileImpl,
  });
  const [approvalPolicy, storePolicy, context, sourceState] = await Promise.all(
    [
      loadJson(path.join(root, "config", "approval-policy.json")),
      loadJson(path.join(root, "config", "release-state-store.json")),
      verifyPolicy({ root }),
      resolveSource({ environment }),
    ],
  );
  const currentRunId = requireEnvironment(environment, "GITHUB_RUN_ID");
  const currentRunAttempt = requireEnvironment(
    environment,
    "GITHUB_RUN_ATTEMPT",
  );
  assertProtectedWorkflowEnvironment({
    env: environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha: sourceState.gitCommitSha,
    runId: currentRunId,
  });
  const nowMilliseconds = clock();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Own-gate performance producer clock is invalid");
  }
  const producedAtUtc = new Date(nowMilliseconds).toISOString();
  const store = await createBoundStore({
    environment,
    namespace: parsed.namespace,
    storePolicy,
    createStore,
  });
  let produced;
  try {
    const requirementsBefore = await resolveRequirements({ store });
    assertAuthoritativeOwnGatePerformanceRequirements({
      requirements: requirementsBefore,
      expectedNamespace: parsed.namespace,
      expectedSourceSha: sourceState.gitCommitSha,
    });
    const rawAuthority = await resolveCollectorAuthority({
      rawArtifactBytes: rawSamplesBytes,
      rawSamplesRunId: parsed.rawSamplesRunId,
      rawSamplesRunAttempt: parsed.rawSamplesRunAttempt,
      sourceSha: sourceState.gitCommitSha,
      namespace: parsed.namespace,
      approvalPolicy,
      environment,
      store,
      collectRunAuthority,
    });
    produced = await produceEvidence({
      requirements: requirementsBefore,
      rawSamplesBytes,
      collectorAuthority: rawAuthority.collectorAuthority,
      expectedRawSamplesSha256: parsed.expectedRawSamplesSha256,
      rawSamplesRunId: parsed.rawSamplesRunId,
      rawSamplesRunAttempt: parsed.rawSamplesRunAttempt,
      currentRunId,
      currentRunAttempt,
      sourceState,
      context,
      producedAtUtc,
    });
    const requirementsAfter = await resolveRequirements({ store });
    assertAuthoritativeOwnGatePerformanceRequirements({
      requirements: requirementsAfter,
      expectedNamespace: parsed.namespace,
      expectedSourceSha: sourceState.gitCommitSha,
    });
    assertUnchangedOwnGatePerformanceRequirements({
      before: requirementsBefore,
      after: requirementsAfter,
    });
  } finally {
    await store.close();
  }
  await Promise.all([
    writeFileImpl(paths.output, produced.evidenceBytes, {
      flag: "wx",
      mode: 0o600,
    }),
    writeFileImpl(paths.receiptOutput, produced.receiptBytes, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  stdout.write(
    `PASS own-gate performance evidence: ${produced.receipt.receipt.performanceGate} ${sha256Bytes(produced.evidenceBytes)}\n`,
  );
  return {
    ...produced,
    outputPath: paths.output,
    receiptOutputPath: paths.receiptOutput,
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOwnGatePerformanceEvidenceProducerCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
