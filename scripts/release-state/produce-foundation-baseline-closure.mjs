#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { writeExactCreateOnlyFile } from "../lib/exact-file-write.mjs";
import {
  FOUNDATION_BOOTSTRAP_RECOVERY_OBSERVATION_MEDIA_TYPE,
  assertFoundationBootstrapRecoveryObservation,
  readStoredFoundationBootstrapRecoveryAuthority,
} from "../provider/foundation-bootstrap-recovery.mjs";
import {
  readFoundationBootstrapSeedProviderObservationBinding,
  readStoredFoundationBootstrapDeploymentSeedAuthority,
} from "../provider/foundation-bootstrap-deployment-seed.mjs";
import { assertConfiguredFoundationP0aAuthorities } from "../provider/foundation-p0a-authorities-policy.mjs";
import { putRemoteDbObservationOidcAuthority } from "../db/remote-db-observation-authority.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import {
  REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
  collectReviewedWorkflowArtifactAuthority,
} from "./reviewedWorkflowArtifactAuthority.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const OPERATION = "produce-foundation-baseline-closure";
const WORKFLOW_PATH = ".github/workflows/release.yml";
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAXIMUM_GITHUB_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_DISCOVERY_RUNS = 1_000;
const DISCOVERY_PAGE_SIZE = 100;
const MAXIMUM_RAW_DIST_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required baseline closure environment is absent: ${name}`);
  }
  return value;
};

const sameCanonicalValue = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const referenceFromHash = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const githubHeaders = (githubToken) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${githubToken}`,
  "user-agent": "event-shopping-planner-foundation-release",
  "x-github-api-version": "2022-11-28",
});

const fetchGithubJson = async ({ fetchImpl, githubToken, url, label }) => {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: githubHeaders(githubToken),
      redirect: "follow",
    });
  } catch {
    throw new Error(`${label} request failed`);
  }
  if (
    response?.status !== 200 ||
    !/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/iu.test(
      response.headers?.get?.("content-type") ?? "",
    ) ||
    typeof response.arrayBuffer !== "function"
  ) {
    throw new Error(`${label} request failed`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAXIMUM_GITHUB_RESPONSE_BYTES) {
    throw new Error(`${label} response is empty or oversized`);
  }
  return parseJsonStrict(bytes.toString("utf8"), label);
};

const exactArtifactName = ({ sourceSha, runAttempt }) =>
  `foundation-bootstrap-recovery-${sourceSha}-${runAttempt}`;

export const discoverFoundationBootstrapRecoveryRun = async ({
  fetchImpl = fetch,
  githubToken,
  repository,
  sourceSha,
  currentRunId,
}) => {
  if (
    typeof fetchImpl !== "function" ||
    typeof githubToken !== "string" ||
    githubToken.length < 8 ||
    !REPOSITORY.test(repository ?? "") ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !RUN_ID.test(currentRunId ?? "")
  ) {
    throw new Error("Bootstrap recovery discovery identity is invalid");
  }
  const repositoryPath = repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const workflow = encodeURIComponent(WORKFLOW_PATH);
  const query = new URLSearchParams({
    branch: "main",
    event: "workflow_dispatch",
    head_sha: sourceSha,
    status: "completed",
    per_page: String(DISCOVERY_PAGE_SIZE),
  });
  const workflowRuns = [];
  let totalCount = null;
  for (
    let page = 1;
    page <= MAXIMUM_DISCOVERY_RUNS / DISCOVERY_PAGE_SIZE;
    page += 1
  ) {
    query.set("page", String(page));
    const runs = await fetchGithubJson({
      fetchImpl,
      githubToken,
      url:
        `https://api.github.com/repos/${repositoryPath}/actions/workflows/` +
        `${workflow}/runs?${query.toString()}`,
      label: "Bootstrap recovery workflow discovery",
    });
    if (
      !Number.isSafeInteger(runs?.total_count) ||
      runs.total_count < 1 ||
      runs.total_count > MAXIMUM_DISCOVERY_RUNS ||
      !Array.isArray(runs.workflow_runs) ||
      runs.workflow_runs.length > DISCOVERY_PAGE_SIZE ||
      (totalCount !== null && runs.total_count !== totalCount)
    ) {
      throw new Error("Bootstrap recovery workflow discovery is incomplete");
    }
    totalCount = runs.total_count;
    workflowRuns.push(...runs.workflow_runs);
    if (workflowRuns.length >= totalCount) break;
    if (runs.workflow_runs.length !== DISCOVERY_PAGE_SIZE) {
      throw new Error("Bootstrap recovery workflow discovery is incomplete");
    }
  }
  if (
    workflowRuns.length !== totalCount ||
    new Set(workflowRuns.map((run) => String(run?.id ?? ""))).size !==
      workflowRuns.length
  ) {
    throw new Error("Bootstrap recovery workflow discovery is incomplete");
  }
  const completed = workflowRuns.flatMap((run) => {
    const runId = String(run?.id ?? "");
    const runAttempt = String(run?.run_attempt ?? "");
    return RUN_ID.test(runId) &&
      RUN_ID.test(runAttempt) &&
      runId !== currentRunId &&
      run.head_sha === sourceSha &&
      run.head_branch === "main" &&
      run.path === WORKFLOW_PATH &&
      run.event === "workflow_dispatch" &&
      run.status === "completed" &&
      run.conclusion === "success"
      ? [{ runId, runAttempt }]
      : [];
  });
  const candidates = [];
  for (const run of completed) {
    const artifactName = exactArtifactName({
      sourceSha,
      runAttempt: run.runAttempt,
    });
    const artifactSet = await fetchGithubJson({
      fetchImpl,
      githubToken,
      url:
        `https://api.github.com/repos/${repositoryPath}/actions/runs/` +
        `${run.runId}/artifacts?name=${encodeURIComponent(artifactName)}` +
        `&per_page=${DISCOVERY_PAGE_SIZE}`,
      label: "Bootstrap recovery artifact discovery",
    });
    if (
      !Number.isSafeInteger(artifactSet?.total_count) ||
      artifactSet.total_count < 0 ||
      artifactSet.total_count > 1 ||
      !Array.isArray(artifactSet.artifacts) ||
      artifactSet.artifacts.length !== artifactSet.total_count
    ) {
      throw new Error("Bootstrap recovery artifact discovery is incomplete");
    }
    const exact = artifactSet.artifacts.filter(
      (artifact) =>
        artifact?.name === artifactName &&
        artifact.expired === false &&
        String(artifact.workflow_run?.id ?? "") === run.runId &&
        artifact.workflow_run?.head_sha === sourceSha,
    );
    if (exact.length > 1) {
      throw new Error("Bootstrap recovery artifact discovery is ambiguous");
    }
    if (exact.length === 1) {
      candidates.push({ ...run, artifactName });
    }
  }
  if (candidates.length === 0) {
    throw new Error("No completed prior bootstrap recovery artifact exists");
  }
  candidates.sort((left, right) => {
    const runOrder = BigInt(left.runId) - BigInt(right.runId);
    if (runOrder !== 0n) return runOrder < 0n ? -1 : 1;
    const attemptOrder = BigInt(left.runAttempt) - BigInt(right.runAttempt);
    return attemptOrder < 0n ? -1 : attemptOrder > 0n ? 1 : 0;
  });
  return Object.freeze({ ...candidates.at(-1) });
};

export const parseFoundationBaselineClosureArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== 4) {
    throw new Error(
      "Usage: produce-foundation-baseline-closure.mjs --namespace <namespace> --output <new-file>",
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
      throw new Error("Foundation baseline closure arguments are invalid");
    }
    values.set(flag, value);
  }
  const namespace = values.get("--namespace");
  if (!NAMESPACE.test(namespace ?? "")) {
    throw new Error("Foundation baseline closure namespace is invalid");
  }
  return Object.freeze({ namespace, outputPath: values.get("--output") });
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

const readCanonicalRecoveryObservation = (bytes) => {
  const input = Buffer.from(bytes ?? "");
  const observation = assertFoundationBootstrapRecoveryObservation(
    parseJsonStrict(
      input.toString("utf8"),
      "Reviewed foundation bootstrap recovery observation",
    ),
  );
  if (!canonicalJsonBytes(observation).equals(input)) {
    throw new Error("Reviewed bootstrap recovery observation is not canonical");
  }
  return observation;
};

const readRawDistManifest = async ({ store, reference }) => {
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAXIMUM_RAW_DIST_MANIFEST_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE
  ) {
    throw new Error("Foundation raw dist manifest is absent or differs");
  }
  return Buffer.from(stored.bytes);
};

export const runFoundationBaselineClosureCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson,
    assertP0a = assertConfiguredFoundationP0aAuthorities,
    assertProtected = assertProtectedWorkflowEnvironment,
    verifyBaseline = verifyHistoricalBaseline,
    createStore = createPostgresReleaseStateStore,
    discoverRecovery = discoverFoundationBootstrapRecoveryRun,
    collectReviewedArtifact = collectReviewedWorkflowArtifactAuthority,
    readRecovery = readStoredFoundationBootstrapRecoveryAuthority,
    readSeed = readStoredFoundationBootstrapDeploymentSeedAuthority,
    readSeedProviderObservation = readFoundationBootstrapSeedProviderObservationBinding,
    readRecoveryObservation = readCanonicalRecoveryObservation,
    readRawManifest = readRawDistManifest,
    resolveSource = resolveCleanFoundationSource,
    resolveBootstrapSource = resolveBootstrapFoundationSource,
    resolveHistorical = resolveHistoricalFoundationBaseline,
    resolvePolicies = resolveFoundationBaselinePolicyBindings,
    resolveProducerOidc = resolveFoundationBaselineProducerOidc,
    resolveClosure = resolveFoundationBaselineClosure,
    storeClosure = putFoundationBaselineClosureAuthority,
    collectOidcReceipt = collectProducerOidcReceipt,
    storeOidcReceipt = putRemoteDbObservationOidcAuthority,
    writeOutput = writeExactCreateOnlyFile,
    fetchImpl = fetch,
    now = Date.now,
  } = {},
) => {
  const parsed = parseFoundationBaselineClosureArguments(argv);
  const readPolicy =
    loadJson ??
    (async (filePath) =>
      parseJsonStrict(
        await readFile(filePath, "utf8"),
        path.basename(filePath),
      ));
  const [
    approvalPolicy,
    storePolicy,
    databaseContract,
    providerPolicy,
    baseline,
    p0aPolicy,
    toolchainPolicy,
  ] = await Promise.all([
    readPolicy(path.join(repositoryRoot, "config", "approval-policy.json")),
    readPolicy(path.join(repositoryRoot, "config", "release-state-store.json")),
    readPolicy(
      path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
    ),
    readPolicy(path.join(repositoryRoot, "config", "provider-policy.json")),
    readPolicy(path.join(repositoryRoot, "config", "foundation-baseline.json")),
    readPolicy(
      path.join(repositoryRoot, "config", "foundation-p0a-authorities.json"),
    ),
    readPolicy(path.join(repositoryRoot, "config", "toolchain-versions.json")),
  ]);
  assertP0a({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    requireBootstrap: true,
  });
  const sourceSha = requireEnvironment(environment, "GITHUB_SHA");
  const currentRunId = requireEnvironment(environment, "GITHUB_RUN_ID");
  const currentRunAttempt = requireEnvironment(
    environment,
    "GITHUB_RUN_ATTEMPT",
  );
  if (
    !SOURCE_SHA.test(sourceSha) ||
    !RUN_ID.test(currentRunId) ||
    !RUN_ID.test(currentRunAttempt) ||
    requireEnvironment(environment, "REQUESTED_OPERATION") !== OPERATION
  ) {
    throw new Error("Foundation baseline closure workflow identity is invalid");
  }
  assertProtected({
    env: environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha,
    runId: currentRunId,
  });
  verifyBaseline();
  const sourceResolution = resolveSource({
    expectedSourceSha: sourceSha,
    cwd: repositoryRoot,
  });
  const bootstrapSourceResolution = resolveBootstrapSource({
    bootstrapSourceSha: p0aPolicy.bootstrapRecovery.bootstrapSourceSha,
    cwd: repositoryRoot,
  });
  const historicalBaselineResolution = resolveHistorical(baseline);
  const connectionString = requireEnvironment(
    environment,
    storePolicy.databaseUrlEnvironmentName,
  );
  const ca = requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM");
  const applicationAuthority = databaseContract.remote.observationAuthority;
  const applicationDatabaseConnectionString = requireEnvironment(
    environment,
    applicationAuthority.databaseUrlEnvironmentName,
  );
  const applicationDatabaseCa = requireEnvironment(
    environment,
    applicationAuthority.databaseCaEnvironmentName,
  );
  const githubToken = requireEnvironment(
    environment,
    p0aPolicy.githubCredentialEnvironmentName,
  );
  const nowMilliseconds = Number(now());
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Foundation baseline closure clock is invalid");
  }
  const store = await createStore({
    connectionString,
    namespace: parsed.namespace,
    policy: storePolicy,
    ca,
  });
  try {
    const [oidcReceiptBytes, selectedRecovery] = await Promise.all([
      collectOidcReceipt({
        environment,
        approvalPolicy,
        sourceSha,
        runId: currentRunId,
        nowMilliseconds,
        fetchImpl,
      }),
      discoverRecovery({
        fetchImpl,
        githubToken,
        repository: approvalPolicy.repository,
        sourceSha,
        currentRunId,
      }),
    ]);
    if (
      selectedRecovery.runId === currentRunId ||
      !RUN_ID.test(selectedRecovery.runId ?? "") ||
      !RUN_ID.test(selectedRecovery.runAttempt ?? "") ||
      selectedRecovery.artifactName !==
        exactArtifactName({
          sourceSha,
          runAttempt: selectedRecovery.runAttempt,
        })
    ) {
      throw new Error("Selected bootstrap recovery run is not prior and exact");
    }
    const reviewedRecovery = await collectReviewedArtifact({
      fetchImpl,
      githubToken,
      namespace: parsed.namespace,
      repository: approvalPolicy.repository,
      expectedRunId: selectedRecovery.runId,
      expectedRunAttempt: selectedRecovery.runAttempt,
      expectedSourceSha: sourceSha,
      expectedWorkflowPath: WORKFLOW_PATH,
      expectedArtifactName: selectedRecovery.artifactName,
      expectedFileName: "foundation-bootstrap-recovery.json",
      expectedFileMediaType:
        FOUNDATION_BOOTSTRAP_RECOVERY_OBSERVATION_MEDIA_TYPE,
      store,
    });
    const observation = readRecoveryObservation(reviewedRecovery.fileBytes);
    if (
      observation.namespace !== parsed.namespace ||
      observation.sourceSha !== sourceSha ||
      observation.collectorIdentity.repository !== approvalPolicy.repository ||
      observation.collectorIdentity.runId !== selectedRecovery.runId ||
      observation.collectorIdentity.runAttempt !== selectedRecovery.runAttempt
    ) {
      throw new Error(
        "Reviewed bootstrap recovery observation identity differs",
      );
    }
    const recovery = await readRecovery({
      store,
      namespace: parsed.namespace,
      reference: observation.rawAuthority,
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
      foundationBaseline: baseline,
      toolchainPolicy,
      bootstrapSourceResolution,
    });
    if (
      recovery.raw.sourceSha !== sourceSha ||
      recovery.raw.collector.runId !== selectedRecovery.runId ||
      recovery.raw.collector.runAttempt !== selectedRecovery.runAttempt ||
      !sameCanonicalValue(
        recovery.raw.rehearsal,
        observation.rehearsalAuthority,
      ) ||
      !sameCanonicalValue(recovery.result, observation.result) ||
      !sameCanonicalValue(
        recovery.raw.collector.oidcReceipt,
        observation.oidcReceipt,
      )
    ) {
      throw new Error("Reviewed bootstrap recovery store authority differs");
    }
    const seed = await readSeed({
      store,
      namespace: parsed.namespace,
      reference: recovery.raw.bootstrap.seedAuthority,
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
    });
    const rawDistManifestBytes = await readRawManifest({
      store,
      reference: seed.authority.rawDistManifest,
    });
    const seedProviderObservation = await readSeedProviderObservation({
      store,
      namespace: parsed.namespace,
      binding: seed.binding,
      providerPolicy,
    });
    const policyBindingResolution = resolvePolicies({
      store,
      namespace: parsed.namespace,
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
      namespace: parsed.namespace,
      receiptBytes: oidcReceiptBytes,
      approvalPolicy,
      sourceSha,
      runId: currentRunId,
      runAttempt: currentRunAttempt,
    });
    const producerOidcResolution = await resolveProducerOidc({
      store,
      policyBindingResolution,
      reference: producerOidcStored.reference,
      sourceResolution,
      runId: currentRunId,
      runAttempt: currentRunAttempt,
    });
    const resolution = await resolveClosure({
      store,
      sourceResolution,
      bootstrapSourceResolution,
      historicalBaselineResolution,
      policyBindingResolution,
      producerOidcResolution,
      providerBindingReference: recovery.raw.bootstrap.bindingReference,
      providerObservationReference: seedProviderObservation.observation,
      providerPolicyReference: seedProviderObservation.policy,
      rawDistManifestBytes,
      recoveryRehearsalReference: recovery.raw.rehearsal,
      reviewedRecoveryArtifactReference: reviewedRecovery.reference,
      currentWorkflowRunId: currentRunId,
      now: () => nowMilliseconds,
    });
    const stored = await storeClosure({ store, resolution });
    const result = {
      schemaVersion: 2,
      resultKind: "foundation-baseline-closure-stored/v2",
      namespace: parsed.namespace,
      sourceSha,
      bootstrapSourceSha: p0aPolicy.bootstrapRecovery.bootstrapSourceSha,
      workflowRunId: currentRunId,
      workflowRunAttempt: currentRunAttempt,
      mediaType: FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
      reference: stored.reference,
      producerOidc: {
        mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
        reference: producerOidcStored.reference,
      },
      reviewedBootstrapRecovery: {
        mediaType: REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
        reference: reviewedRecovery.reference,
        runId: selectedRecovery.runId,
        runAttempt: selectedRecovery.runAttempt,
      },
      rawDistManifest: {
        mediaType: FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE,
        reference: referenceFromHash(
          parsed.namespace,
          sha256Bytes(rawDistManifestBytes),
        ),
      },
    };
    const resultBytes = canonicalJsonBytes(result);
    await writeOutput({
      outputPath: path.resolve(cwd, parsed.outputPath),
      bytes: resultBytes,
      label: "Foundation baseline closure result",
      maximumBytes: MAXIMUM_OUTPUT_BYTES,
    });
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
