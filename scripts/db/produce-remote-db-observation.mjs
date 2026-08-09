#!/usr/bin/env node

import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "../release-state/githubOidc.mjs";
import { assertProtectedWorkflowEnvironment } from "../release-state/protected-release.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { runRemoteDbObservationCli } from "./collect-remote-db-observation.mjs";
import {
  REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  putRemoteDbObservationAuthority,
  putRemoteDbObservationOidcAuthority,
  putRemoteDbObservationProductionAuthority,
  putRemoteDbProviderObservationAuthority,
} from "./remote-db-observation-authority.mjs";
import { VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE } from "../provider/collect-vercel-observation.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const FLAGS = Object.freeze([
  "--authority-output",
  "--namespace",
  "--output",
  "--provider-observation",
  "--run-id",
  "--source-sha",
]);
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const MAX_PROVIDER_OBSERVATION_BYTES = 4 * 1024 * 1024;
const PRODUCTION_OPERATION = "collect-remote-db-observation";

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required protected DB observation environment is absent: ${name}`,
    );
  }
  return value;
};

export const parseProtectedRemoteDbObservationArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== FLAGS.length * 2) {
    throw new Error("Protected remote DB observation arguments are incomplete");
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
      throw new Error(`Invalid protected DB observation flag: ${flag}`);
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== FLAGS.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    !SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
    !RUN_ID_PATTERN.test(values["--run-id"])
  ) {
    throw new Error("Protected remote DB observation identity is invalid");
  }
  const output = path.resolve(values["--output"]);
  const authorityOutput = path.resolve(values["--authority-output"]);
  const providerObservation = path.resolve(values["--provider-observation"]);
  const comparable = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (
    new Set(
      [output, authorityOutput, providerObservation].map((value) =>
        comparable(value),
      ),
    ).size !== 3
  ) {
    throw new Error(
      "Protected DB observation inputs and outputs must be distinct",
    );
  }
  return values;
};

const readProviderObservationSnapshot = async ({ filePath }) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      "Protected provider observation path is not a regular file",
    );
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error("Protected provider observation path is aliased");
  }
  const description = { path: resolved, ...describeExactFile(metadata) };
  const bytes = await readExactRegularFile({
    description,
    maximumBytes: MAX_PROVIDER_OBSERVATION_BYTES,
    label: "Protected provider observation",
  });
  return {
    bytes,
    async assertUnchanged() {
      const current = await readExactRegularFile({
        description,
        maximumBytes: MAX_PROVIDER_OBSERVATION_BYTES,
        label: "Protected provider observation",
      });
      if (!current.equals(bytes)) {
        throw new Error(
          "Protected provider observation changed during DB collection",
        );
      }
    },
  };
};

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

const createBoundStore = ({ environment, namespace, policy, createStore }) => {
  if (
    policy?.bindingStatus !== "configured" ||
    policy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State store is not configured for DB observation");
  }
  return createStore({
    connectionString: requireEnvironment(
      environment,
      policy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

export const runProtectedRemoteDbObservationCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    assertEnvironment = assertProtectedWorkflowEnvironment,
    collectObservation = runRemoteDbObservationCli,
    createStore = createPostgresReleaseStateStore,
    storeObservation = putRemoteDbObservationAuthority,
    storeProviderObservation = putRemoteDbProviderObservationAuthority,
    storeOidcReceipt = putRemoteDbObservationOidcAuthority,
    storeProduction = putRemoteDbObservationProductionAuthority,
    readProviderObservation = readProviderObservationSnapshot,
    collectOidcReceipt = collectProducerOidcReceipt,
    fetchImpl = fetch,
    writeFileImpl = writeFile,
    now = Date.now,
  } = {},
) => {
  const values = parseProtectedRemoteDbObservationArguments(argv);
  const namespace = values["--namespace"];
  const sourceSha = values["--source-sha"];
  const workflowRunId = values["--run-id"];
  const [approvalPolicy, storePolicy, contract, providerPolicy] =
    await Promise.all([
      loadJson(path.join(repositoryRoot, "config", "approval-policy.json")),
      loadJson(path.join(repositoryRoot, "config", "release-state-store.json")),
      loadJson(
        path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
      ),
      loadJson(path.join(repositoryRoot, "config", "provider-policy.json")),
    ]);
  assertEnvironment({
    env,
    approvalPolicy,
    namespace,
    sourceSha,
    runId: workflowRunId,
  });
  const runAttempt = requireEnvironment(env, "GITHUB_RUN_ATTEMPT");
  if (!RUN_ID_PATTERN.test(runAttempt)) {
    throw new Error("Protected DB observation run attempt is invalid");
  }
  if (requireEnvironment(env, "REQUESTED_OPERATION") !== PRODUCTION_OPERATION) {
    throw new Error("Protected DB observation operation binding is invalid");
  }
  const providerObservationPath = path.resolve(
    cwd,
    values["--provider-observation"],
  );
  const providerSnapshot = await readProviderObservation({
    filePath: providerObservationPath,
  });
  const nowMilliseconds = Number(now());
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Protected DB observation clock is invalid");
  }
  const [collected, oidcReceiptBytes] = await Promise.all([
    collectObservation({
      argv: [
        "--provider-observation",
        providerObservationPath,
        "--output",
        path.resolve(cwd, values["--output"]),
      ],
      env,
      cwd,
      stdout: { write: () => undefined },
    }),
    collectOidcReceipt({
      environment: env,
      approvalPolicy,
      sourceSha,
      runId: workflowRunId,
      nowMilliseconds,
      fetchImpl,
    }),
  ]);
  await providerSnapshot.assertUnchanged();
  const store = await createBoundStore({
    environment: env,
    namespace,
    policy: storePolicy,
    createStore,
  });
  try {
    const [stored, storedProvider, storedOidc] = await Promise.all([
      storeObservation({
        store,
        namespace,
        bytes: collected.bytes,
        contract,
        now,
      }),
      storeProviderObservation({
        store,
        namespace,
        bytes: providerSnapshot.bytes,
        providerPolicy,
        now,
      }),
      storeOidcReceipt({
        store,
        namespace,
        receiptBytes: oidcReceiptBytes,
        approvalPolicy,
        sourceSha,
        runId: workflowRunId,
        runAttempt,
      }),
    ]);
    if (stored.reference.sha256 !== collected.sha256) {
      throw new Error(
        "Stored remote DB observation differs from collected canonical bytes",
      );
    }
    const production = await storeProduction({
      store,
      namespace,
      sourceSha,
      runId: workflowRunId,
      runAttempt,
      observationReference: stored.reference,
      providerObservationReference: storedProvider.reference,
      providerPolicyReference: storedProvider.policyReference,
      producerOidcReference: storedOidc.reference,
      contract,
      approvalPolicy,
      now,
    });
    const result = {
      schemaVersion: 1,
      resultKind: "remote-db-observation-stored/v1",
      namespace,
      sourceSha,
      workflowRunId,
      runAttempt,
      mediaTypes: {
        observation: REMOTE_DB_OBSERVATION_MEDIA_TYPE,
        providerObservation: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
        providerPolicy: REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
        producerOidc: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
        production: REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
      },
      observation: stored.reference,
      providerObservation: storedProvider.reference,
      providerPolicy: storedProvider.policyReference,
      producerOidc: storedOidc.reference,
      production: production.reference,
    };
    const resultBytes = canonicalJsonBytes(result);
    await writeFileImpl(
      path.resolve(cwd, values["--authority-output"]),
      resultBytes,
      { flag: "wx", mode: 0o600 },
    );
    stdout.write(`${resultBytes.toString("utf8")}\n`);
    return result;
  } finally {
    await store.close?.();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runProtectedRemoteDbObservationCli().catch(() => {
    process.stderr.write("Protected remote DB observation failed\n");
    process.exitCode = 1;
  });
}
