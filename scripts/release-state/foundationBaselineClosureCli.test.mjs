import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE } from "../lib/foundation-baseline-closure-authority.mjs";
import {
  discoverFoundationBootstrapRecoveryRun,
  parseFoundationBaselineClosureArguments,
  runFoundationBaselineClosureCli,
} from "./produce-foundation-baseline-closure.mjs";

const namespace = "foundation-baseline-cli-test";
const sourceSha = "a".repeat(40);
const bootstrapSourceSha = "b".repeat(40);
const currentRunId = "200";
const recoveryRunId = "190";
const runAttempt = "2";
const hash = (character) => character.repeat(64);
const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const jsonResponse = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/vnd.github+json" },
  });

test("parser accepts only namespace/output and rejects caller run, hash, source, and input paths", () => {
  assert.deepEqual(
    parseFoundationBaselineClosureArguments([
      "--namespace",
      namespace,
      "--output",
      "closure.json",
    ]),
    { namespace, outputPath: "closure.json" },
  );
  for (const injected of [
    ["--source-sha", sourceSha],
    ["--run-id", recoveryRunId],
    ["--recovery-sha256", hash("1")],
    ["--raw-dist-manifest", "caller.json"],
  ]) {
    assert.throws(
      () =>
        parseFoundationBaselineClosureArguments([
          "--namespace",
          namespace,
          "--output",
          "closure.json",
          ...injected,
        ]),
      /Usage|arguments/u,
    );
  }
});

test("discovery excludes the current run and selects the latest completed exact recovery artifact", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.includes("/actions/workflows/") && url.includes("/runs?")) {
      return jsonResponse({
        total_count: 3,
        workflow_runs: [
          {
            id: Number(currentRunId),
            run_attempt: 1,
            head_sha: sourceSha,
            head_branch: "main",
            path: ".github/workflows/release.yml",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 180,
            run_attempt: 1,
            head_sha: sourceSha,
            head_branch: "main",
            path: ".github/workflows/release.yml",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
          {
            id: Number(recoveryRunId),
            run_attempt: Number(runAttempt),
            head_sha: sourceSha,
            head_branch: "main",
            path: ".github/workflows/release.yml",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    const match = /\/actions\/runs\/(\d+)\/artifacts/u.exec(url);
    if (match !== null) {
      const runId = match[1];
      const attempt = runId === recoveryRunId ? runAttempt : "1";
      return jsonResponse({
        total_count: 1,
        artifacts: [
          {
            name: `foundation-bootstrap-recovery-${sourceSha}-${attempt}`,
            expired: false,
            workflow_run: { id: Number(runId), head_sha: sourceSha },
          },
        ],
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const selected = await discoverFoundationBootstrapRecoveryRun({
    fetchImpl,
    githubToken: "github-token",
    repository: "owner/repository",
    sourceSha,
    currentRunId,
  });
  assert.deepEqual(selected, {
    runId: recoveryRunId,
    runAttempt,
    artifactName: `foundation-bootstrap-recovery-${sourceSha}-${runAttempt}`,
  });
  assert.equal(
    requested.some((url) =>
      url.includes(`/actions/runs/${currentRunId}/artifacts`),
    ),
    false,
  );
});

test("discovery fails closed when only the current run can be observed", async () => {
  await assert.rejects(
    discoverFoundationBootstrapRecoveryRun({
      githubToken: "github-token",
      repository: "owner/repository",
      sourceSha,
      currentRunId,
      fetchImpl: async () =>
        jsonResponse({
          total_count: 1,
          workflow_runs: [
            {
              id: Number(currentRunId),
              run_attempt: 1,
              head_sha: sourceSha,
              head_branch: "main",
              path: ".github/workflows/release.yml",
              event: "workflow_dispatch",
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
    }),
    /No completed prior/u,
  );
});

test("discovery follows bounded workflow-run pages before reviewing the exact artifact", async () => {
  const requests = [];
  const invalidRun = (id) => ({
    id,
    run_attempt: 1,
    head_sha: sourceSha,
    head_branch: "main",
    path: ".github/workflows/release.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
  });
  const priorRun = {
    ...invalidRun(Number(recoveryRunId)),
    run_attempt: Number(runAttempt),
    event: "workflow_dispatch",
  };
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("/actions/workflows/") && url.includes("/runs?")) {
      const page = new URL(url).searchParams.get("page");
      return jsonResponse({
        total_count: 101,
        workflow_runs:
          page === "1"
            ? Array.from({ length: 100 }, (_, index) =>
                invalidRun(1_000 + index),
              )
            : [priorRun],
      });
    }
    if (url.includes(`/actions/runs/${recoveryRunId}/artifacts?`)) {
      return jsonResponse({
        total_count: 1,
        artifacts: [
          {
            name: `foundation-bootstrap-recovery-${sourceSha}-${runAttempt}`,
            expired: false,
            workflow_run: {
              id: Number(recoveryRunId),
              head_sha: sourceSha,
            },
          },
        ],
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  assert.deepEqual(
    await discoverFoundationBootstrapRecoveryRun({
      fetchImpl,
      githubToken: "github-token",
      repository: "owner/repository",
      sourceSha,
      currentRunId,
    }),
    {
      runId: recoveryRunId,
      runAttempt,
      artifactName: `foundation-bootstrap-recovery-${sourceSha}-${runAttempt}`,
    },
  );
  assert.equal(
    requests.filter((url) => url.includes("/actions/workflows/")).length,
    2,
  );
});

const closureHarness = ({ selectCurrentRun = false } = {}) => {
  const rawDistBytes = canonicalJsonBytes({ fixture: "raw-dist" });
  const rawDistReference = reference(sha256Bytes(rawDistBytes));
  const recoveryRehearsal = reference(hash("3"));
  const reviewedReference = reference(hash("4"));
  const seedReference = reference(hash("5"));
  const bindingReference = reference(hash("6"));
  const providerObservation = reference(hash("7"));
  const providerPolicyReference = reference(hash("8"));
  const closureReference = reference(hash("9"));
  const producerOidcReference = reference(hash("0"));
  const store = {
    namespace,
    closed: false,
    async readEvidence({ sha256 }) {
      return sha256 === rawDistReference.sha256
        ? {
            bytes: rawDistBytes,
            mediaType: FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE,
          }
        : null;
    },
    async close() {
      this.closed = true;
    },
  };
  const sourceResolution = { kind: "source" };
  const bootstrapResolution = { kind: "bootstrap" };
  const historicalResolution = { kind: "historical" };
  const policyResolution = { kind: "policies" };
  const producerResolution = { kind: "producer" };
  const closureResolution = { kind: "closure" };
  const observation = {
    namespace,
    sourceSha,
    collectorIdentity: {
      repository: "owner/repository",
      runId: recoveryRunId,
      runAttempt,
    },
    rawAuthority: reference(hash("1")),
    rehearsalAuthority: recoveryRehearsal,
    oidcReceipt: reference(hash("2")),
    result: { outcome: "succeeded" },
  };
  const recovery = {
    raw: {
      sourceSha,
      collector: {
        runId: recoveryRunId,
        runAttempt,
        oidcReceipt: observation.oidcReceipt,
      },
      rehearsal: recoveryRehearsal,
      bootstrap: {
        seedAuthority: seedReference,
        bindingReference,
      },
    },
    result: observation.result,
  };
  let closureArguments = null;
  let reviewedArguments = null;
  let written = null;
  const policies = {
    approval: { repository: "owner/repository" },
    store: { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
    database: {
      remote: {
        observationAuthority: {
          databaseUrlEnvironmentName: "APP_DB_URL",
          databaseCaEnvironmentName: "APP_DB_CA",
        },
      },
    },
    provider: { provider: "configured" },
    baseline: { historical: true },
    p0a: {
      githubCredentialEnvironmentName: "GITHUB_TOKEN",
      bootstrapRecovery: {
        bootstrapSourceSha,
        rawDistManifestSha256: rawDistReference.sha256,
        previewAliasSuffix: "preview.blusalice3-foundation.dev",
      },
    },
    toolchain: { configured: true },
  };
  const dependencies = {
    loadJson: async (filePath) => {
      if (filePath.endsWith("approval-policy.json")) return policies.approval;
      if (filePath.endsWith("release-state-store.json")) return policies.store;
      if (filePath.endsWith("db-compatibility-contract.json"))
        return policies.database;
      if (filePath.endsWith("provider-policy.json")) return policies.provider;
      if (filePath.endsWith("foundation-baseline.json"))
        return policies.baseline;
      if (filePath.endsWith("foundation-p0a-authorities.json"))
        return policies.p0a;
      if (filePath.endsWith("artifact-control-store-drill.json")) {
        throw new Error("P0A closure must not load the P0C artifact policy");
      }
      return policies.toolchain;
    },
    assertP0a: () => undefined,
    assertProtected: () => undefined,
    verifyBaseline: () => undefined,
    createStore: async () => store,
    discoverRecovery: async () => ({
      runId: selectCurrentRun ? currentRunId : recoveryRunId,
      runAttempt,
      artifactName: `foundation-bootstrap-recovery-${sourceSha}-${runAttempt}`,
    }),
    collectReviewedArtifact: async (options) => {
      reviewedArguments = options;
      return {
        reference: reviewedReference,
        fileBytes: Buffer.from("reviewed fixture"),
      };
    },
    readRecoveryObservation: () => observation,
    readRecovery: async () => recovery,
    readSeed: async () => ({
      authority: { rawDistManifest: rawDistReference },
      binding: { bindingId: "bootstrap" },
    }),
    readSeedProviderObservation: async () => ({
      observation: providerObservation,
      policy: providerPolicyReference,
    }),
    resolveSource: () => sourceResolution,
    resolveBootstrapSource: () => bootstrapResolution,
    resolveHistorical: () => historicalResolution,
    resolvePolicies: () => policyResolution,
    resolveProducerOidc: async () => producerResolution,
    resolveClosure: async (options) => {
      closureArguments = options;
      return closureResolution;
    },
    storeClosure: async () => ({ reference: closureReference }),
    collectOidcReceipt: async () => Buffer.from("oidc"),
    storeOidcReceipt: async () => ({ reference: producerOidcReference }),
    writeOutput: async (options) => {
      written = options;
    },
    now: () => 123_456,
  };
  return {
    dependencies,
    get closureArguments() {
      return closureArguments;
    },
    get reviewedArguments() {
      return reviewedArguments;
    },
    get written() {
      return written;
    },
    store,
    reviewedReference,
    recoveryRehearsal,
  };
};

test("protected CLI reviews a prior recovery artifact and embeds its authority in closure v2", async () => {
  const harness = closureHarness();
  const stdout = [];
  const result = await runFoundationBaselineClosureCli(
    {
      argv: ["--namespace", namespace, "--output", "closure.json"],
      environment: {
        GITHUB_SHA: sourceSha,
        GITHUB_RUN_ID: currentRunId,
        GITHUB_RUN_ATTEMPT: "1",
        REQUESTED_OPERATION: "produce-foundation-baseline-closure",
        RELEASE_STATE_DATABASE_URL: "control-url",
        RELEASE_STATE_DATABASE_CA_PEM: "control-ca",
        APP_DB_URL: "application-url",
        APP_DB_CA: "application-ca",
        GITHUB_TOKEN: "github-token",
      },
      cwd: "C:\\fixture",
      stdout: { write: (value) => stdout.push(value) },
    },
    harness.dependencies,
  );
  assert.equal(harness.reviewedArguments.expectedRunId, recoveryRunId);
  assert.equal(harness.reviewedArguments.expectedRunAttempt, runAttempt);
  assert.notEqual(harness.reviewedArguments.expectedRunId, currentRunId);
  assert.deepEqual(
    harness.closureArguments.reviewedRecoveryArtifactReference,
    harness.reviewedReference,
  );
  assert.deepEqual(
    harness.closureArguments.recoveryRehearsalReference,
    harness.recoveryRehearsal,
  );
  assert.equal(result.resultKind, "foundation-baseline-closure-stored/v2");
  assert.equal(result.schemaVersion, 2);
  assert.equal(harness.written.bytes.equals(canonicalJsonBytes(result)), true);
  assert.equal(stdout.join(""), `${harness.written.bytes.toString("utf8")}\n`);
  assert.equal(harness.store.closed, true);
});

test("protected CLI refuses to review its own current run", async () => {
  const harness = closureHarness({ selectCurrentRun: true });
  await assert.rejects(
    runFoundationBaselineClosureCli(
      {
        argv: ["--namespace", namespace, "--output", "closure.json"],
        environment: {
          GITHUB_SHA: sourceSha,
          GITHUB_RUN_ID: currentRunId,
          GITHUB_RUN_ATTEMPT: "1",
          REQUESTED_OPERATION: "produce-foundation-baseline-closure",
          RELEASE_STATE_DATABASE_URL: "control-url",
          RELEASE_STATE_DATABASE_CA_PEM: "control-ca",
          APP_DB_URL: "application-url",
          APP_DB_CA: "application-ca",
          GITHUB_TOKEN: "github-token",
        },
      },
      harness.dependencies,
    ),
    /not prior and exact/u,
  );
  assert.equal(harness.reviewedArguments, null);
  assert.equal(harness.store.closed, true);
});
