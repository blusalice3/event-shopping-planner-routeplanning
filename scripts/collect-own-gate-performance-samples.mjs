#!/usr/bin/env node

import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalizeJson,
  readJsonStrict,
  sha256Bytes,
} from "./lib/canonical-json.mjs";
import { main as collectPerformanceSamples } from "./collect-performance-samples.mjs";
import { resolveCleanOwnGatePerformanceSource } from "./produce-own-gate-performance-evidence.mjs";
import { createPostgresReleaseStateStore } from "./release-state/postgresStore.mjs";
import { resolvePendingAcceptanceRequirements } from "./release-state/lifecycleExecution.mjs";
import {
  assertAuthoritativeRawPerformanceSamples,
  assertUnchangedOwnGatePerformanceCollection,
  buildProtectedRawPerformanceArtifact,
  parseProtectedRawPerformanceArtifact,
  resolveAuthoritativeOwnGatePerformanceCollection,
} from "./release-state/ownGatePerformanceCollection.mjs";
import { GITHUB_OIDC_RECEIPT_MEDIA_TYPE } from "./release-state/acceptanceEvidenceAuthority.mjs";
import {
  assertVerifiedGitHubOidcResult,
  deriveGitHubOidcPolicy,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./release-state/githubOidc.mjs";
import { NAMESPACE_PATTERN } from "./release-state/releaseWorkflowValidation.mjs";
import { verifyPerformancePolicy } from "./verify-performance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGUMENT_NAMES = new Set(["--namespace", "--output"]);
const MAX_RAW_SAMPLES_BYTES = 64 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const EXPECTED_RUNNER_BINDING = Object.freeze({
  RUNNER_ENVIRONMENT: "self-hosted",
  RUNNER_OS: "Windows",
  RUNNER_ARCH: "X64",
  FOUNDATION_PERFORMANCE_RUNNER_LABELS:
    "self-hosted,Windows,X64,foundation-performance",
  FOUNDATION_PROTECTED_ENVIRONMENT: "foundation-performance",
});
const PERFORMANCE_WORKFLOW_PATH = ".github/workflows/performance-evidence.yml";
const usage =
  "Usage: collect-own-gate-performance-samples.mjs " +
  "--namespace <release-state-namespace> --output <raw-performance-samples.json>";

export const parseOwnGatePerformanceCollectionArguments = (arguments_) => {
  const values = { "--namespace": null, "--output": null };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!ARGUMENT_NAMES.has(argument)) {
      throw new Error(
        `Unknown own-gate performance collector argument: ${argument}`,
      );
    }
    const value = arguments_[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      ARGUMENT_NAMES.has(value) ||
      seen.has(argument)
    ) {
      throw new Error(
        `Own-gate performance collector argument ${argument} is invalid`,
      );
    }
    values[argument] = value;
    seen.add(argument);
    index += 1;
  }
  if (
    values["--namespace"] === null ||
    values["--output"] === null ||
    !NAMESPACE_PATTERN.test(values["--namespace"])
  ) {
    throw new Error(usage);
  }
  return {
    namespace: values["--namespace"],
    outputPath: values["--output"],
  };
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required performance collector environment is absent: ${name}`,
    );
  }
  return value;
};

export const assertProtectedSelfHostedPerformanceEnvironment = ({
  environment,
  namespace,
  sourceSha,
  repository,
}) => {
  const runId = requireEnvironment(environment, "GITHUB_RUN_ID");
  if (
    typeof repository !== "string" ||
    repository.length === 0 ||
    !RUN_ID_PATTERN.test(runId) ||
    !RUN_ID_PATTERN.test(requireEnvironment(environment, "GITHUB_RUN_ATTEMPT"))
  ) {
    throw new Error("Protected performance collector run identity is invalid");
  }
  const exact = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: `${repository}/${PERFORMANCE_WORKFLOW_PATH}@refs/heads/main`,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: sourceSha,
    RELEASE_STATE_NAMESPACE: namespace,
    ...EXPECTED_RUNNER_BINDING,
  };
  for (const [name, expected] of Object.entries(exact)) {
    if (requireEnvironment(environment, name) !== expected) {
      throw new Error(
        `Protected self-hosted performance environment ${name} differs from policy`,
      );
    }
  }
  return runId;
};

export const derivePerformanceCollectorOidcPolicy = (approvalPolicy) =>
  deriveGitHubOidcPolicy({
    basePolicy: approvalPolicy,
    workflowPath: PERFORMANCE_WORKFLOW_PATH,
    protectedEnvironment:
      EXPECTED_RUNNER_BINDING.FOUNDATION_PROTECTED_ENVIRONMENT,
  });

const collectPerformanceCollectorIdentity = async ({
  environment,
  approvalPolicy,
  sourceSha,
  runId,
  store,
  namespace,
  requestOidcToken,
  verifyOidcToken,
  nowMilliseconds,
}) => {
  const policy = derivePerformanceCollectorOidcPolicy(approvalPolicy);
  const token = await requestOidcToken({
    requestUrl: requireEnvironment(environment, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    requestToken: requireEnvironment(
      environment,
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    ),
    audience: policy.oidcAudience,
  });
  const verified = await verifyOidcToken({
    token,
    policy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    nowMs: nowMilliseconds,
  });
  assertVerifiedGitHubOidcResult(verified);
  const bytes = Buffer.from(verified.receiptBytes);
  const sha256 = sha256Bytes(bytes);
  const reference = {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
  const receipt = await store.putEvidence({
    bytes,
    mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  });
  const stored = await store.readEvidence({ sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== GITHUB_OIDC_RECEIPT_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    !stored?.bytes?.equals(bytes) ||
    stored.mediaType !== GITHUB_OIDC_RECEIPT_MEDIA_TYPE ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error("Performance collector OIDC immutable receipt differs");
  }
  return reference;
};

const assertOutputAvailable = async (outputPath, lstatImpl) => {
  try {
    await lstatImpl(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Raw performance samples output already exists");
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

const readBoundedRawSamples = async (filePath, readFileImpl) => {
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_RAW_SAMPLES_BYTES
  ) {
    throw new Error("Collected raw performance samples are empty or oversized");
  }
  return bytes;
};

const buildCollectorArguments = ({ authority, paths }) => [
  "--artifact",
  paths.archive,
  "--artifact-manifest",
  paths.manifest,
  "--environment",
  paths.environment,
  "--evidence-id",
  authority.evidenceId,
  "--gate",
  authority.performanceGate,
  "--output",
  paths.raw,
  "--target-url",
  authority.deploymentUrl,
];

export const runOwnGatePerformanceCollectionCli = async (
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
    mkdtempImpl = mkdtemp,
    removeImpl = rm,
    loadJson = readJsonStrict,
    verifyPolicy = verifyPerformancePolicy,
    resolveSource = resolveCleanOwnGatePerformanceSource,
    createStore = createPostgresReleaseStateStore,
    resolveRequirements = resolvePendingAcceptanceRequirements,
    resolveCollection = resolveAuthoritativeOwnGatePerformanceCollection,
    collectSamples = collectPerformanceSamples,
    requestOidcToken = requestGitHubOidcToken,
    verifyOidcToken = verifyGitHubOidcTokenFromIssuer,
    collectIdentity = collectPerformanceCollectorIdentity,
    clock = Date.now,
  } = {},
) => {
  const parsed = parseOwnGatePerformanceCollectionArguments(arguments_);
  const outputPath = path.resolve(workingDirectory, parsed.outputPath);
  await assertOutputAvailable(outputPath, lstatImpl);
  const [approvalPolicy, storePolicy, context, sourceState] = await Promise.all(
    [
      loadJson(path.join(root, "config", "approval-policy.json")),
      loadJson(path.join(root, "config", "release-state-store.json")),
      verifyPolicy({ root }),
      resolveSource({ environment }),
    ],
  );
  const runId = assertProtectedSelfHostedPerformanceEnvironment({
    environment,
    namespace: parsed.namespace,
    sourceSha: sourceState.gitCommitSha,
    repository: approvalPolicy.repository,
  });
  const store = await createBoundStore({
    environment,
    namespace: parsed.namespace,
    storePolicy,
    createStore,
  });
  let temporaryDirectory = null;
  let rawSamplesBytes;
  try {
    const nowMilliseconds = clock();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("Performance collector clock is invalid");
    }
    const collectorIdentity = await collectIdentity({
      environment,
      approvalPolicy,
      sourceSha: sourceState.gitCommitSha,
      runId,
      store,
      namespace: parsed.namespace,
      requestOidcToken,
      verifyOidcToken,
      nowMilliseconds,
    });
    temporaryDirectory = await mkdtempImpl(
      path.join(os.tmpdir(), "esp-own-gate-performance-"),
    );
    const requirementsBefore = await resolveRequirements({ store });
    const collectionBefore = await resolveCollection({
      store,
      requirements: requirementsBefore,
      sourceState,
      context,
      runId,
    });
    const paths = {
      archive: path.join(temporaryDirectory, "artifact.zip"),
      manifest: path.join(temporaryDirectory, "artifact-manifest.json"),
      environment: path.join(
        temporaryDirectory,
        "performance-environment.json",
      ),
      raw: path.join(temporaryDirectory, "raw-performance-samples.json"),
    };
    await Promise.all([
      writeFileImpl(paths.archive, collectionBefore.archiveBytes, {
        flag: "wx",
        mode: 0o600,
      }),
      writeFileImpl(paths.manifest, collectionBefore.manifestBytes, {
        flag: "wx",
        mode: 0o600,
      }),
      writeFileImpl(
        paths.environment,
        `${canonicalizeJson(collectionBefore.authority.environment)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      ),
    ]);
    await collectSamples({
      argv: buildCollectorArguments({
        authority: collectionBefore.authority,
        paths,
      }),
    });
    const collectedSamplesBytes = await readBoundedRawSamples(
      paths.raw,
      readFileImpl,
    );
    const collectedSamples = assertAuthoritativeRawPerformanceSamples({
      bytes: collectedSamplesBytes,
      authority: collectionBefore.authority,
    });
    rawSamplesBytes = buildProtectedRawPerformanceArtifact({
      samples: collectedSamples,
      collectorIdentity,
    });
    parseProtectedRawPerformanceArtifact({
      bytes: rawSamplesBytes,
      namespace: parsed.namespace,
    });

    const requirementsAfter = await resolveRequirements({ store });
    const collectionAfter = await resolveCollection({
      store,
      requirements: requirementsAfter,
      sourceState,
      context,
      runId,
    });
    assertUnchangedOwnGatePerformanceCollection({
      before: {
        requirements: requirementsBefore,
        collection: collectionBefore,
      },
      after: {
        requirements: requirementsAfter,
        collection: collectionAfter,
      },
    });
  } finally {
    try {
      await store.close();
    } finally {
      if (temporaryDirectory !== null) {
        await removeImpl(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
  await writeFileImpl(outputPath, rawSamplesBytes, {
    flag: "wx",
    mode: 0o600,
  });
  stdout.write(
    `PASS authoritative own-gate raw performance samples: ${sha256Bytes(rawSamplesBytes)}\n`,
  );
  return { outputPath, rawSamplesSha256: sha256Bytes(rawSamplesBytes) };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOwnGatePerformanceCollectionCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
