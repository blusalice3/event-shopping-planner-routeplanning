import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertProductionRequestGraphProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority,
} from "../browser/production-request-graph.mjs";
import { canonicalJsonBytes, parseJsonStrict } from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { writeExactCreateOnlyFile } from "../lib/exact-file-write.mjs";
import { resolveBootstrapFoundationSource } from "../lib/foundation-baseline-closure-authority.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { collectReviewedWorkflowRunAuthority } from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  assertFoundationBootstrapRecoveryObservation,
  collectAndStoreFoundationBootstrapRecovery,
} from "./foundation-bootstrap-recovery.mjs";
import { assertConfiguredFoundationP0aAuthorities } from "./foundation-p0a-authorities-policy.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const MAXIMUM_POLICY_BYTES = 4 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 16 * 1024 * 1024;
const WORKFLOW_PATH = ".github/workflows/release.yml";

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Foundation bootstrap environment is absent: ${name}`);
  }
  return value;
};

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const readJson = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  const bytes = await readExactRegularFile({
    description: { path: resolved, ...describeExactFile(metadata) },
    maximumBytes: MAXIMUM_POLICY_BYTES,
    label,
  });
  return parseJsonStrict(bytes.toString("utf8"), label);
};

export const parseFoundationBootstrapRecoveryArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== 4) {
    throw new Error(
      "Usage: collect-foundation-bootstrap-recovery.mjs --namespace <namespace> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--namespace", "--output"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Foundation bootstrap recovery arguments are invalid");
    }
    values.set(flag, value);
  }
  const namespace = values.get("--namespace");
  if (!NAMESPACE.test(namespace ?? "")) {
    throw new Error("Foundation bootstrap recovery namespace is invalid");
  }
  return Object.freeze({ namespace, outputPath: values.get("--output") });
};

export const writeFoundationBootstrapRecoveryOutput = async (
  outputPath,
  observation,
) => {
  assertFoundationBootstrapRecoveryObservation(observation);
  const bytes = canonicalJsonBytes(observation);
  const written = await writeExactCreateOnlyFile({
    outputPath,
    bytes,
    label: "Foundation bootstrap recovery",
    maximumBytes: MAXIMUM_OUTPUT_BYTES,
  });
  return Object.freeze({ path: written.path, bytes: written.bytes });
};

export const runFoundationBootstrapRecoveryCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadPolicy = readJson,
    assertProtected = assertProductionRequestGraphProtectedWorkflow,
    createStore = createPostgresReleaseStateStore,
    collectOidc = collectAndStoreProductionRequestGraphOidcAuthority,
    collectReviewedRun = collectReviewedWorkflowRunAuthority,
    resolveBootstrapSource = resolveBootstrapFoundationSource,
    collect = collectAndStoreFoundationBootstrapRecovery,
    writeOutput = writeFoundationBootstrapRecoveryOutput,
  } = {},
) => {
  const parsed = parseFoundationBootstrapRecoveryArguments(argv);
  const [
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    artifactDrillPolicy,
    foundationBaseline,
    toolchainPolicy,
  ] = await Promise.all([
    loadPolicy(
      path.join(root, "config", "foundation-p0a-authorities.json"),
      "Foundation P0A authority policy",
    ),
    loadPolicy(
      path.join(root, "config", "provider-policy.json"),
      "Foundation provider policy",
    ),
    loadPolicy(
      path.join(root, "config", "db-compatibility-contract.json"),
      "Foundation database contract",
    ),
    loadPolicy(
      path.join(root, "config", "release-state-store.json"),
      "Foundation control store policy",
    ),
    loadPolicy(
      path.join(root, "config", "approval-policy.json"),
      "Foundation approval policy",
    ),
    loadPolicy(
      path.join(root, "config", "artifact-control-store-drill.json"),
      "Foundation artifact drill policy",
    ),
    loadPolicy(
      path.join(root, "config", "foundation-baseline.json"),
      "Foundation baseline",
    ),
    loadPolicy(
      path.join(root, "config", "toolchain-versions.json"),
      "Foundation toolchain policy",
    ),
  ]);
  // Deliberately precedes protected-workflow, store, GitHub, and provider I/O.
  assertConfiguredFoundationP0aAuthorities({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    artifactDrillPolicy,
    requireBootstrap: true,
  });
  if (!SOURCE_SHA.test(foundationBaseline?.bootstrapBaselineSourceSha ?? "")) {
    throw new Error("Foundation bootstrap baseline source is not configured");
  }
  const sourceSha = requireEnvironment(environment, "GITHUB_SHA");
  if (!SOURCE_SHA.test(sourceSha)) {
    throw new Error("Foundation bootstrap protected source is invalid");
  }
  const bootstrapSourceResolution = resolveBootstrapSource({
    bootstrapSourceSha: foundationBaseline.bootstrapBaselineSourceSha,
    cwd: root,
  });
  const workflow = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha,
  });
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
    const [oidc, reviewed] = await Promise.all([
      collectOidc({
        store,
        namespace: parsed.namespace,
        sourceSha,
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
        approvalPolicy,
        environment,
      }),
      collectReviewedRun({
        githubToken: requireEnvironment(
          environment,
          p0aPolicy.githubCredentialEnvironmentName,
        ),
        namespace: parsed.namespace,
        repository: approvalPolicy.repository,
        expectedRunId: workflow.runId,
        expectedRunAttempt: workflow.runAttempt,
        expectedSourceSha: sourceSha,
        expectedWorkflowPath: WORKFLOW_PATH,
        store,
      }),
    ]);
    const observation = await collect({
      approvalPolicy,
      artifactDrillPolicy,
      bootstrapSourceResolution,
      databaseContract,
      environment,
      foundationBaseline,
      namespace: parsed.namespace,
      oidcAuthority: {
        approvalPolicy,
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
      },
      oidcReceipt: oidc.reference,
      p0aPolicy,
      providerPolicy,
      reviewedWorkflowRun: reviewed.receipt,
      store,
      storePolicy,
      toolchainPolicy,
    });
    await writeOutput(path.resolve(cwd, parsed.outputPath), observation);
    stdout.write(
      `PASS foundation bootstrap recovery: ${observation.rawAuthority.sha256}\n`,
    );
    return observation;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runFoundationBootstrapRecoveryCli();
