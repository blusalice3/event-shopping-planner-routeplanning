import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJsonStrict } from "../lib/canonical-json.mjs";
import { readAndVerifyExternalPrerequisitePolicy } from "../lib/phase-exit-external-prerequisites.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  assertStoredGitHubOidcReceipt,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "../release-state/githubOidc.mjs";
import {
  assertManagedDeviceRunnerPreflight,
  writeManagedDeviceCollectorOutput,
} from "./collect-managed-device-authority.mjs";
import { assertConfiguredManagedDeviceExecution } from "./managed-device-authority.mjs";
import { executeManagedDeviceLiveStagePowerShell } from "./managed-device-live-stage-powershell.mjs";
import {
  assertSignedManagedDeviceStageReceipt,
  deriveManagedDeviceStageCollectorIdentity,
  resolveManagedDeviceLiveStageState,
} from "./managed-device-stage-authority.mjs";
import { assertProductionRequestGraphProtectedWorkflow } from "./production-request-graph.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_POLICY_BYTES = 1024 * 1024;
const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const createDefaultStore = async (options) => {
  const { createPostgresReleaseStateStore } =
    await import("../release-state/postgresStore.mjs");
  return createPostgresReleaseStateStore(options);
};

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Managed device stage environment is absent: ${name}`);
  }
  return value;
};

const readExactJson = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    comparablePath(await realpath(resolved)) !== comparablePath(resolved) ||
    metadata.size < 1 ||
    metadata.size > MAXIMUM_POLICY_BYTES
  ) {
    throw new Error(`${label} is not an exact bounded file`);
  }
  return parseJsonStrict((await readFile(resolved)).toString("utf8"), label);
};

export const parseManagedDeviceLiveStageArguments = (arguments_) => {
  const allowed = ["--namespace", "--output", "--source-sha"];
  if (!Array.isArray(arguments_) || arguments_.length !== allowed.length * 2) {
    throw new Error(
      "Usage: collect-managed-device-live-stage.mjs --namespace <namespace> --source-sha <collector-sha> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Managed device live stage arguments are invalid");
    }
    values.set(flag, value);
  }
  const namespace = values.get("--namespace");
  const sourceSha = values.get("--source-sha");
  if (!NAMESPACE.test(namespace ?? "") || !SOURCE_SHA.test(sourceSha ?? "")) {
    throw new Error("Managed device live stage identity is invalid");
  }
  return Object.freeze({
    namespace,
    outputPath: values.get("--output"),
    sourceSha,
  });
};

const collectOidc = async ({
  environment,
  approvalPolicy,
  sourceSha,
  runId,
  runAttempt,
}) => {
  const token = await requestGitHubOidcToken({
    requestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: approvalPolicy.oidcAudience,
  });
  const verified = await verifyGitHubOidcTokenFromIssuer({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
  });
  assertVerifiedGitHubOidcResult(verified);
  assertStoredGitHubOidcReceipt({
    receipt: verified.receipt,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
  });
  return verified.receipt;
};

export const runManagedDeviceLiveStageCollector = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadExternalPolicy = readAndVerifyExternalPrerequisitePolicy,
    loadPolicy = readExactJson,
    assertProtected = assertProductionRequestGraphProtectedWorkflow,
    createStore = createDefaultStore,
    readState = readCurrentReleaseState,
    resolveState = resolveManagedDeviceLiveStageState,
    collectOidcReceipt = collectOidc,
    execute = executeManagedDeviceLiveStagePowerShell,
    writeOutput = writeManagedDeviceCollectorOutput,
  } = {},
) => {
  const parsed = parseManagedDeviceLiveStageArguments(argv);
  const external = await loadExternalPolicy(
    path.join(root, "config", "phase-exit-external-prerequisites.json"),
  );
  const configured = assertConfiguredManagedDeviceExecution(external.policy);
  assertManagedDeviceRunnerPreflight({
    environment,
    devicePolicy: configured.device,
  });
  const [approvalPolicy, storePolicy, dbContract] = await Promise.all([
    loadPolicy(
      path.join(root, "config", "approval-policy.json"),
      "Managed device stage approval policy",
    ),
    loadPolicy(
      path.join(root, "config", "release-state-store.json"),
      "Managed device stage Release State policy",
    ),
    loadPolicy(
      path.join(root, "config", "db-compatibility-contract.json"),
      "Managed device stage DB contract",
    ),
  ]);
  const workflow = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha: parsed.sourceSha,
  });
  if (storePolicy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL") {
    throw new Error("Managed device stage Release State binding differs");
  }
  const store = await createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace: parsed.namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const current = await readState({ store, requireInitialized: true });
    const state = resolveState({ current, namespace: parsed.namespace });
    const oidcReceipt = await collectOidcReceipt({
      environment,
      approvalPolicy,
      sourceSha: parsed.sourceSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
    });
    const collectorIdentity = deriveManagedDeviceStageCollectorIdentity({
      sourceSha: parsed.sourceSha,
      approvalPolicy,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
    });
    const request = Object.freeze({
      schemaVersion: 1,
      kind: "managed-device-stage-execution-request/v1",
      namespace: parsed.namespace,
      collectorSourceSha: parsed.sourceSha,
      collectorIdentity,
      oidcReceipt,
      externalPrerequisitePolicySha256: configured.policySha256,
      externalPolicy: external.policy,
      approvalPolicy,
      dbContract,
      releaseState: state.authority,
      current,
    });
    const receipt = await execute({
      request,
      externalPolicy: external.policy,
      environment,
      repositoryRoot: root,
    });
    const asserted = assertSignedManagedDeviceStageReceipt(receipt, {
      externalPolicy: external.policy,
      approvalPolicy,
      dbContract,
      current,
      expectedCollectorSourceSha: parsed.sourceSha,
      expectedRunId: workflow.runId,
      expectedRunAttempt: workflow.runAttempt,
    });
    await writeOutput(path.resolve(cwd, parsed.outputPath), receipt);
    stdout.write(`PASS managed-device-live-stage: ${asserted.receiptSha256}\n`);
    return asserted;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runManagedDeviceLiveStageCollector();
