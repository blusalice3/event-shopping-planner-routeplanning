#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
  FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE,
  putFoundationBaselineClosureAuthority,
  resolveBootstrapFoundationSource,
  resolveCleanFoundationSource,
  resolveFoundationBaselineClosure,
  resolveFoundationBaselinePolicyBindings,
  resolveFoundationBaselineProducerOidc,
  resolveHistoricalFoundationBaseline,
} from "../lib/foundation-baseline-closure-authority.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import { putRemoteDbObservationOidcAuthority } from "../db/remote-db-observation-authority.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const FLAGS = Object.freeze([
  "--bootstrap-source-sha",
  "--namespace",
  "--output",
  "--provider-binding-sha256",
  "--provider-observation-sha256",
  "--provider-policy-sha256",
  "--raw-dist-manifest",
  "--raw-dist-manifest-sha256",
  "--recovery-rehearsal-sha256",
  "--run-id",
  "--source-sha",
]);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_RAW_DIST_MANIFEST_BYTES = 16 * 1024 * 1024;
const OPERATION = "produce-foundation-baseline-closure";

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required baseline closure environment is absent: ${name}`);
  }
  return value;
};

const referenceFromHash = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

export const parseFoundationBaselineClosureArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== FLAGS.length * 2) {
    throw new Error("Foundation baseline closure arguments are incomplete");
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
      throw new Error(`Invalid foundation baseline closure flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
    !SOURCE_SHA_PATTERN.test(values["--bootstrap-source-sha"]) ||
    !RUN_ID_PATTERN.test(values["--run-id"]) ||
    [
      "--provider-binding-sha256",
      "--provider-observation-sha256",
      "--provider-policy-sha256",
      "--raw-dist-manifest-sha256",
      "--recovery-rehearsal-sha256",
    ].some((flag) => !SHA256_PATTERN.test(values[flag]))
  ) {
    throw new Error("Foundation baseline closure identity is invalid");
  }
  return values;
};

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const readRawDistManifestSnapshot = async (filePath) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Raw dist manifest must be a regular non-link file");
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error("Raw dist manifest path is aliased");
  }
  const description = { path: resolved, ...describeExactFile(metadata) };
  const bytes = await readExactRegularFile({
    description,
    maximumBytes: MAXIMUM_RAW_DIST_MANIFEST_BYTES,
    label: "Raw dist manifest",
  });
  return {
    bytes,
    async assertUnchanged() {
      const current = await readExactRegularFile({
        description,
        maximumBytes: MAXIMUM_RAW_DIST_MANIFEST_BYTES,
        label: "Raw dist manifest",
      });
      if (!current.equals(bytes)) {
        throw new Error("Raw dist manifest changed during baseline closure");
      }
    },
  };
};

const verifyHistoricalBaseline = () => {
  execFileSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "verify-foundation-baseline.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: "pipe",
      windowsHide: true,
    },
  );
};

const createBoundStore = ({ environment, namespace, policy, createStore }) =>
  createStore({
    connectionString: requireEnvironment(
      environment,
      policy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });

const collectProducerOidcReceipt = async ({
  environment,
  approvalPolicy,
  sourceSha,
  runId,
  nowMilliseconds,
  fetchImpl,
}) => {
  const token = await requestGitHubOidcToken({
    requestUrl: requireEnvironment(environment, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    requestToken: requireEnvironment(
      environment,
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    ),
    audience: approvalPolicy.oidcAudience,
    fetchImpl,
  });
  const verified = await verifyGitHubOidcTokenFromIssuer({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    nowMs: nowMilliseconds,
    fetchImpl,
  });
  assertVerifiedGitHubOidcResult(verified);
  return verified.receiptBytes;
};

export const runFoundationBaselineClosureCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    assertEnvironment = assertProtectedWorkflowEnvironment,
    verifyBaseline = verifyHistoricalBaseline,
    readRawDistManifest = readRawDistManifestSnapshot,
    createStore = createPostgresReleaseStateStore,
    resolveSource = resolveCleanFoundationSource,
    resolveBootstrapSource = resolveBootstrapFoundationSource,
    resolveHistorical = resolveHistoricalFoundationBaseline,
    resolvePolicies = resolveFoundationBaselinePolicyBindings,
    resolveProducerOidc = resolveFoundationBaselineProducerOidc,
    resolveClosure = resolveFoundationBaselineClosure,
    storeClosure = putFoundationBaselineClosureAuthority,
    collectOidcReceipt = collectProducerOidcReceipt,
    storeOidcReceipt = putRemoteDbObservationOidcAuthority,
    fetchImpl = fetch,
    writeFileImpl = writeFile,
    now = Date.now,
  } = {},
) => {
  const values = parseFoundationBaselineClosureArguments(argv);
  const namespace = values["--namespace"];
  const sourceSha = values["--source-sha"];
  const bootstrapSourceSha = values["--bootstrap-source-sha"];
  const currentWorkflowRunId = values["--run-id"];
  const outputPath = path.resolve(cwd, values["--output"]);
  const rawDistManifestPath = path.resolve(cwd, values["--raw-dist-manifest"]);
  if (comparablePath(outputPath) === comparablePath(rawDistManifestPath)) {
    throw new Error("Baseline closure output must not overwrite its input");
  }
  const [
    approvalPolicy,
    storePolicy,
    databaseContract,
    providerPolicy,
    baseline,
  ] = await Promise.all([
    loadJson(path.join(repositoryRoot, "config", "approval-policy.json")),
    loadJson(path.join(repositoryRoot, "config", "release-state-store.json")),
    loadJson(
      path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
    ),
    loadJson(path.join(repositoryRoot, "config", "provider-policy.json")),
    loadJson(path.join(repositoryRoot, "config", "foundation-baseline.json")),
  ]);
  assertEnvironment({
    env,
    approvalPolicy,
    namespace,
    sourceSha,
    runId: currentWorkflowRunId,
  });
  if (requireEnvironment(env, "REQUESTED_OPERATION") !== OPERATION) {
    throw new Error("Foundation baseline closure operation binding is invalid");
  }
  verifyBaseline();
  const rawDistSnapshot = await readRawDistManifest({
    filePath: rawDistManifestPath,
  });
  if (
    sha256Bytes(rawDistSnapshot.bytes) !== values["--raw-dist-manifest-sha256"]
  ) {
    throw new Error("Raw dist manifest differs from its reviewed SHA-256");
  }
  const connectionString = requireEnvironment(
    env,
    storePolicy.databaseUrlEnvironmentName,
  );
  const ca = requireEnvironment(env, "RELEASE_STATE_DATABASE_CA_PEM");
  const applicationDatabaseAuthority =
    databaseContract.remote.observationAuthority;
  const applicationDatabaseConnectionString = requireEnvironment(
    env,
    applicationDatabaseAuthority.databaseUrlEnvironmentName,
  );
  const applicationDatabaseCa = requireEnvironment(
    env,
    applicationDatabaseAuthority.databaseCaEnvironmentName,
  );
  const runAttempt = requireEnvironment(env, "GITHUB_RUN_ATTEMPT");
  if (!RUN_ID_PATTERN.test(runAttempt)) {
    throw new Error("Foundation baseline closure run attempt is invalid");
  }
  const nowMilliseconds = Number(now());
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Foundation baseline closure clock is invalid");
  }
  const [oidcReceiptBytes, store] = await Promise.all([
    collectOidcReceipt({
      environment: env,
      approvalPolicy,
      sourceSha,
      runId: currentWorkflowRunId,
      nowMilliseconds,
      fetchImpl,
    }),
    createBoundStore({
      environment: env,
      namespace,
      policy: storePolicy,
      createStore,
    }),
  ]);
  try {
    const sourceResolution = resolveSource({
      expectedSourceSha: sourceSha,
      cwd: repositoryRoot,
    });
    const bootstrapSourceResolution = resolveBootstrapSource({
      bootstrapSourceSha,
      cwd: repositoryRoot,
    });
    const historicalBaselineResolution = resolveHistorical(baseline);
    const policyBindingResolution = resolvePolicies({
      store,
      namespace,
      providerPolicy,
      databaseContract,
      controlStorePolicy: storePolicy,
      approvalPolicy,
      controlStoreConnectionString: connectionString,
      controlStoreCa: ca,
      applicationDatabaseConnectionString,
      applicationDatabaseCa,
    });
    const producerOidcStored = await storeOidcReceipt({
      store,
      namespace,
      receiptBytes: oidcReceiptBytes,
      approvalPolicy,
      sourceSha,
      runId: currentWorkflowRunId,
      runAttempt,
    });
    const producerOidcResolution = await resolveProducerOidc({
      store,
      policyBindingResolution,
      reference: producerOidcStored.reference,
      sourceResolution,
      runId: currentWorkflowRunId,
      runAttempt,
    });
    const resolution = await resolveClosure({
      store,
      sourceResolution,
      bootstrapSourceResolution,
      historicalBaselineResolution,
      policyBindingResolution,
      producerOidcResolution,
      providerBindingReference: referenceFromHash(
        namespace,
        values["--provider-binding-sha256"],
      ),
      providerObservationReference: referenceFromHash(
        namespace,
        values["--provider-observation-sha256"],
      ),
      providerPolicyReference: referenceFromHash(
        namespace,
        values["--provider-policy-sha256"],
      ),
      rawDistManifestBytes: rawDistSnapshot.bytes,
      recoveryRehearsalReference: referenceFromHash(
        namespace,
        values["--recovery-rehearsal-sha256"],
      ),
      currentWorkflowRunId,
      now,
    });
    await rawDistSnapshot.assertUnchanged();
    const stored = await storeClosure({ store, resolution });
    await rawDistSnapshot.assertUnchanged();
    const result = {
      schemaVersion: 1,
      resultKind: "foundation-baseline-closure-stored/v1",
      namespace,
      sourceSha,
      bootstrapSourceSha,
      workflowRunId: currentWorkflowRunId,
      workflowRunAttempt: runAttempt,
      mediaType: FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
      reference: stored.reference,
      producerOidc: {
        mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
        reference: producerOidcStored.reference,
      },
      rawDistManifest: {
        mediaType: FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE,
        sha256: values["--raw-dist-manifest-sha256"],
      },
    };
    const resultBytes = canonicalJsonBytes(result);
    await writeFileImpl(outputPath, resultBytes, { flag: "wx", mode: 0o600 });
    stdout.write(`${resultBytes.toString("utf8")}\n`);
    return result;
  } finally {
    await store.close?.();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runFoundationBaselineClosureCli().catch(() => {
    process.stderr.write("Foundation baseline closure failed\n");
    process.exitCode = 1;
  });
}
