import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  assertProtectedSelfHostedPerformanceEnvironment,
  parseOwnGatePerformanceCollectionArguments,
  runOwnGatePerformanceCollectionCli,
} from "./collect-own-gate-performance-samples.mjs";
import { canonicalJsonBytes, sha256Bytes } from "./lib/canonical-json.mjs";
import {
  assertAuthoritativeRawPerformanceSamples,
  parseProtectedRawPerformanceArtifact,
  deriveReviewedPerformanceEnvironment,
  resolveAuthoritativeOwnGatePerformanceCollection,
} from "./release-state/ownGatePerformanceCollection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const namespace = "performance-collection-test";
const sourceSha = "a".repeat(40);
const sourceClosureSha256 = "b".repeat(64);
const archiveBytes = Buffer.from("authoritative performance archive\n");
const archiveSha256 = sha256Bytes(archiveBytes);
const manifestBytes = canonicalJsonBytes({
  schemaVersion: 1,
  sourceSha,
  releaseRole: "standard",
});
const manifestSha256 = sha256Bytes(manifestBytes);
const runId = "8675309";
const expectedState = { sequence: 41, eventHash: "c".repeat(64) };
const sourceState = {
  gitCommitSha: sourceSha,
  sourceClosureSha256,
  treeState: "clean",
};
const performanceGate = "P3-XLSX";
const acceptedGate = "P3-XLSX";
const scenarioId = "xlsx-worker-import-valid";
const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});
const collectorIdentity = reference("e".repeat(64));

const binding = {
  artifactManifest: reference(manifestSha256),
  artifactArchive: reference(archiveSha256),
  artifactArchiveAvailability: reference("1".repeat(64)),
  bindingId: "pending-standard-performance",
  buildId: sourceSha,
  deploymentUrl: "https://performance.example.test/",
  packageIndex: reference("2".repeat(64)),
  providerConfigurationHash: "3".repeat(64),
  providerDeploymentId: "deployment-performance",
  providerEvidence: reference("4".repeat(64)),
  providerPolicy: reference("5".repeat(64)),
  providerProjectId: "project-performance",
  publicIdentityKind: "release-identity-v1",
  releasePolicy: reference("6".repeat(64)),
  releaseRole: "standard",
  requiredDbCompatibility: {
    contractUri: "urn:event-shopping-planner:db-compatibility:test",
    fingerprint: "7".repeat(64),
  },
  sourceSha,
  variantId: "8".repeat(64),
};

const requirements = {
  schemaVersion: 1,
  requirementKind: "standard-acceptance-requirements/v1",
  namespace,
  operationId: "accept-performance-p3",
  sourceSha,
  expectedArtifactSha256: archiveSha256,
  expectedState,
  acceptedGate,
  performanceEvidenceKind: "own-gate-performance-evidence/v1",
  performanceGate,
};

const environment = {
  machineProfile: {
    os: "win32-10.0.26100-x64",
    cpu: "Canonical Physical CPU",
    memoryBytes: 34_359_738_368,
    powerMode: "best-performance-ac",
  },
  browser: {
    family: "chromium",
    version: "140.0.7339.16",
    channel: "chromium",
  },
};

const context = {
  errors: [],
  budgets: {
    machineProfile: { status: "bound", ...environment.machineProfile },
    browser: structuredClone(environment.browser),
  },
  gateMap: new Map([
    [
      performanceGate,
      {
        gate: performanceGate,
        inherits: ["P0-TOOLCHAIN"],
        evidenceScope: "own",
        scenarioIds: [scenarioId],
        temporaryExceptions: [],
      },
    ],
  ]),
};

const currentState = () => ({
  head: structuredClone(expectedState),
  snapshot: {
    pendingAcceptance: {
      operationId: requirements.operationId,
      standardBinding: structuredClone(binding),
    },
    pendingOperation: {
      operationId: requirements.operationId,
      targetBinding: structuredClone(binding),
    },
  },
});

const rawSamplesValue = (authority) => ({
  schemaVersion: 1,
  evidenceId: authority.evidenceId,
  gate: authority.performanceGate,
  collectedAtUtc: "2026-08-09T14:00:00.000Z",
  source: {
    ...structuredClone(authority.source),
    artifactSha256: authority.artifactArchiveSha256,
    releaseVariant: {
      releaseRole: "standard",
      xlsxExecution: "worker",
      listEngine: "full",
      listDefault: "full",
    },
  },
  environment: structuredClone(authority.environment),
  scenarios: authority.scenarioIds.map((id) => ({
    id,
    samples: Array.from({ length: 30 }, () => 1),
    supplementarySamples: { heapBytes: Array.from({ length: 30 }, () => 2) },
    outcomeAssertions: { "scenario-completed": true },
    executionBinding: {
      adapterContract: "public-artifact-surface-v1",
      fixturePayload: {
        generator: "collector-test-v1",
        seed: 1,
        cardinality: 1,
        payloadSha256: "9".repeat(64),
        semanticSha256: "d".repeat(64),
      },
      faultInjection: null,
      setup: null,
    },
  })),
});

const rawSamplesBytes = (authority) =>
  Buffer.concat([
    canonicalJsonBytes(rawSamplesValue(authority)),
    Buffer.from("\n", "utf8"),
  ]);

const resolveCollection = (overrides = {}) =>
  resolveAuthoritativeOwnGatePerformanceCollection(
    { store: { namespace }, requirements, sourceState, context, runId },
    {
      readState: async () => currentState(),
      verifyArchive: async () => ({
        archive: {
          bytes: archiveBytes,
          mediaType:
            "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
        },
      }),
      readEvidence: async () => ({
        bytes: manifestBytes,
        mediaType:
          "application/vnd.event-shopping-planner.artifact-manifest+json;version=1",
      }),
      ...overrides,
    },
  );

const workflowEnvironment = (overrides = {}) => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_WORKFLOW_REF:
    "owner/repository/.github/workflows/performance-evidence.yml@refs/heads/main",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: "1",
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL: "postgresql://release-state.example.test/db",
  RELEASE_STATE_DATABASE_CA_PEM: "test-ca",
  RUNNER_ENVIRONMENT: "self-hosted",
  RUNNER_OS: "Windows",
  RUNNER_ARCH: "X64",
  FOUNDATION_PERFORMANCE_RUNNER_LABELS:
    "self-hosted,Windows,X64,foundation-performance",
  FOUNDATION_PROTECTED_ENVIRONMENT: "foundation-performance",
  ...overrides,
});

test("derives collection authority from pending standard live objects", async () => {
  const result = await resolveCollection();
  assert.equal(result.authority.acceptedGate, acceptedGate);
  assert.equal(result.authority.performanceGate, performanceGate);
  assert.equal(result.authority.deploymentUrl, binding.deploymentUrl);
  assert.equal(result.authority.artifactArchiveSha256, archiveSha256);
  assert.equal(result.authority.artifactManifestSha256, manifestSha256);
  assert.deepEqual(result.authority.environment, environment);
  assert.deepEqual(result.authority.scenarioIds, [scenarioId]);
  assert.equal(result.authority.collectorContract.sampleCount, 30);
  assert.equal(result.authority.collectorContract.warmupSamples, 1);
  assert.equal(result.archiveBytes.equals(archiveBytes), true);
  assert.equal(result.manifestBytes.equals(manifestBytes), true);
});

test("fails closed on state, archive, manifest, and physical binding drift", async () => {
  await assert.rejects(
    resolveCollection({
      readState: async () => ({
        ...currentState(),
        head: { ...expectedState, sequence: expectedState.sequence + 1 },
      }),
    }),
    /pending acceptance changed/,
  );
  await assert.rejects(
    resolveCollection({
      verifyArchive: async () => ({
        archive: { bytes: Buffer.from("wrong"), mediaType: "archive" },
      }),
    }),
    /archive failed live readback/,
  );
  await assert.rejects(
    resolveCollection({
      readEvidence: async () => ({
        bytes: manifestBytes,
        mediaType: "application/json",
      }),
    }),
    /manifest failed live readback/,
  );
  assert.throws(
    () =>
      deriveReviewedPerformanceEnvironment({
        ...context,
        budgets: {
          ...context.budgets,
          machineProfile: {
            ...context.budgets.machineProfile,
            status: "external-binding-required",
          },
        },
      }),
    /physical machine and Chromium binding is incomplete/,
  );
});

test("accepts only raw samples bound to authoritative source, artifact, environment, and 30 samples", async () => {
  const { authority } = await resolveCollection();
  const bytes = rawSamplesBytes(authority);
  assert.equal(
    assertAuthoritativeRawPerformanceSamples({ bytes, authority }).gate,
    performanceGate,
  );
  const wrongArtifact = rawSamplesValue(authority);
  wrongArtifact.source.artifactSha256 = "0".repeat(64);
  assert.throws(
    () =>
      assertAuthoritativeRawPerformanceSamples({
        bytes: canonicalJsonBytes(wrongArtifact),
        authority,
      }),
    /source, artifact, gate, or environment authority/,
  );
  const shortSamples = rawSamplesValue(authority);
  shortSamples.scenarios[0].samples.pop();
  assert.throws(
    () =>
      assertAuthoritativeRawPerformanceSamples({
        bytes: canonicalJsonBytes(shortSamples),
        authority,
      }),
    /authoritative scenario closure/,
  );
});

test("CLI surface forbids caller gate, dimensions, artifact, target, adapter, and evidence identity", () => {
  assert.deepEqual(
    parseOwnGatePerformanceCollectionArguments([
      "--namespace",
      namespace,
      "--output",
      "raw-performance-samples.json",
    ]),
    { namespace, outputPath: "raw-performance-samples.json" },
  );
  for (const forbidden of [
    "--gate",
    "--dimensions",
    "--artifact",
    "--artifact-manifest",
    "--environment",
    "--target-url",
    "--adapter-module",
    "--evidence-id",
  ]) {
    assert.throws(
      () =>
        parseOwnGatePerformanceCollectionArguments([
          "--namespace",
          namespace,
          "--output",
          "raw.json",
          forbidden,
          "caller-value",
        ]),
      /Unknown own-gate performance collector argument/,
    );
  }
});

test("requires the dedicated protected physical Windows runner binding", () => {
  assert.equal(
    assertProtectedSelfHostedPerformanceEnvironment({
      environment: workflowEnvironment(),
      namespace,
      sourceSha,
      repository: "owner/repository",
    }),
    runId,
  );
  for (const [name, value] of [
    ["RUNNER_ENVIRONMENT", "github-hosted"],
    ["RUNNER_OS", "Linux"],
    ["FOUNDATION_PROTECTED_ENVIRONMENT", "unprotected"],
    [
      "GITHUB_WORKFLOW_REF",
      "owner/repository/.github/workflows/release.yml@refs/heads/main",
    ],
  ]) {
    assert.throws(
      () =>
        assertProtectedSelfHostedPerformanceEnvironment({
          environment: workflowEnvironment({ [name]: value }),
          namespace,
          sourceSha,
          repository: "owner/repository",
        }),
      /differs from policy/,
    );
  }
});

test("CLI internally supplies authoritative collector arguments and publishes one raw file after stable readback", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "own-gate-performance-cli-test-"),
  );
  const outputPath = path.join(directory, "raw-performance-samples.json");
  const collection = await resolveCollection();
  const store = { namespace, close: async () => {} };
  let collectionReads = 0;
  try {
    const result = await runOwnGatePerformanceCollectionCli(
      {
        arguments_: ["--namespace", namespace, "--output", outputPath],
        environment: workflowEnvironment(),
        workingDirectory: directory,
        stdout: { write() {} },
      },
      {
        loadJson: async (filePath) =>
          path.basename(filePath) === "approval-policy.json"
            ? { repository: "owner/repository" }
            : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
        verifyPolicy: async () => context,
        resolveSource: async () => sourceState,
        createStore: async () => store,
        collectIdentity: async () => structuredClone(collectorIdentity),
        resolveRequirements: async () => structuredClone(requirements),
        resolveCollection: async () => {
          collectionReads += 1;
          return {
            authority: structuredClone(collection.authority),
            archiveBytes: Buffer.from(collection.archiveBytes),
            manifestBytes: Buffer.from(collection.manifestBytes),
          };
        },
        collectSamples: async ({ argv }) => {
          const values = Object.fromEntries(
            Array.from({ length: argv.length / 2 }, (_, index) => [
              argv[index * 2],
              argv[index * 2 + 1],
            ]),
          );
          assert.equal(values["--gate"], performanceGate);
          assert.equal(values["--target-url"], binding.deploymentUrl);
          assert.equal(
            values["--evidence-id"],
            collection.authority.evidenceId,
          );
          assert.equal(Object.hasOwn(values, "--adapter-module"), false);
          assert.equal(
            (await readFile(values["--artifact"])).equals(archiveBytes),
            true,
          );
          assert.equal(
            (await readFile(values["--artifact-manifest"])).equals(
              manifestBytes,
            ),
            true,
          );
          assert.deepEqual(
            JSON.parse(await readFile(values["--environment"], "utf8")),
            environment,
          );
          await writeFile(
            values["--output"],
            rawSamplesBytes(collection.authority),
            {
              flag: "wx",
            },
          );
        },
      },
    );
    assert.equal(collectionReads, 2);
    assert.equal(result.outputPath, outputPath);
    const protectedArtifact = parseProtectedRawPerformanceArtifact({
      bytes: await readFile(outputPath),
      namespace,
    });
    assert.deepEqual(protectedArtifact.collectorIdentity, collectorIdentity);
    assert.deepEqual(
      protectedArtifact.samples,
      rawSamplesValue(collection.authority),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI does not publish raw evidence when pending authority drifts after collection", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "own-gate-performance-drift-test-"),
  );
  const outputPath = path.join(directory, "raw-performance-samples.json");
  const collection = await resolveCollection();
  let readCount = 0;
  try {
    await assert.rejects(
      runOwnGatePerformanceCollectionCli(
        {
          arguments_: ["--namespace", namespace, "--output", outputPath],
          environment: workflowEnvironment(),
          workingDirectory: directory,
          stdout: { write() {} },
        },
        {
          loadJson: async (filePath) =>
            path.basename(filePath) === "approval-policy.json"
              ? { repository: "owner/repository" }
              : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
          verifyPolicy: async () => context,
          resolveSource: async () => sourceState,
          createStore: async () => ({ namespace, close: async () => {} }),
          collectIdentity: async () => structuredClone(collectorIdentity),
          resolveRequirements: async () => structuredClone(requirements),
          resolveCollection: async () => {
            readCount += 1;
            const value = {
              authority: structuredClone(collection.authority),
              archiveBytes: Buffer.from(collection.archiveBytes),
              manifestBytes: Buffer.from(collection.manifestBytes),
            };
            if (readCount === 2) value.authority.bindingId = "drifted-binding";
            return value;
          },
          collectSamples: async ({ argv }) => {
            const outputIndex = argv.indexOf("--output") + 1;
            await writeFile(
              argv[outputIndex],
              rawSamplesBytes(collection.authority),
              { flag: "wx" },
            );
          },
        },
      ),
      /pending artifact changed/,
    );
    await assert.rejects(readFile(outputPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dedicated workflow is a protected create-only physical collector with no caller authority", async () => {
  const workflowPath = path.join(
    root,
    ".github",
    "workflows",
    "performance-evidence.yml",
  );
  const workflow = await readFile(workflowPath, "utf8");
  const document = yaml.load(workflow);
  assert.equal(document.name, "Foundation physical performance evidence");
  assert.deepEqual(Object.keys(document.on), ["workflow_dispatch"]);
  assert.deepEqual(document.on.workflow_dispatch, null);
  assert.deepEqual(document.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(document.concurrency, {
    group: "foundation-performance-${{ github.sha }}",
    "cancel-in-progress": false,
  });
  const job = document.jobs["collect-own-gate-performance"];
  assert.deepEqual(job["runs-on"], [
    "self-hosted",
    "Windows",
    "X64",
    "foundation-performance",
  ]);
  assert.equal(job.environment, "foundation-performance");
  assert.equal(job["timeout-minutes"], 720);
  assert.equal(
    job.env.FOUNDATION_PERFORMANCE_RUNNER_LABELS,
    "self-hosted,Windows,X64,foundation-performance",
  );
  const collection = job.steps.find(
    (step) => step.name === "Collect authoritative physical samples",
  );
  assert.match(
    collection.run,
    /performance:own-gate-samples:collect -- -- --namespace \$env:RELEASE_STATE_NAMESPACE --output \$outputPath/,
  );
  assert.match(
    collection.run,
    /Raw performance output directory already exists/,
  );
  assert.match(
    collection.run,
    /\$files\.Count -ne 1 -or \$files\[0\]\.Name -ne 'raw-performance-samples\.json'/,
  );
  assert.match(
    collection.run,
    /Raw performance run\/source\/SHA-256:[\s\S]*\$env:GITHUB_RUN_ID[\s\S]*\$env:GITHUB_SHA[\s\S]*\$rawSha256/,
  );
  for (const forbidden of [
    "--gate",
    "--dimensions",
    "--artifact",
    "--artifact-manifest",
    "--environment",
    "--target-url",
    "--adapter-module",
    "--evidence-id",
  ]) {
    assert.doesNotMatch(collection.run, new RegExp(forbidden));
  }
  const nativeCommandLines = workflow
    .split(/\r?\n/)
    .map((line, index, lines) => ({
      line: line.trim(),
      next: lines[index + 1]?.trim(),
    }))
    .filter(({ line }) => line.startsWith("npm "));
  assert.equal(nativeCommandLines.length, 4);
  assert.match(
    workflow,
    /npm exec --yes --package=npm@11\.19\.0 -- npm run verify:toolchain/,
  );
  assert.equal(
    nativeCommandLines.every(({ next }) =>
      next?.startsWith("if ($LASTEXITCODE -ne 0)"),
    ),
    true,
  );
});

test("raw artifact has exactly one upload producer and release reviews its prior run and digest", async () => {
  const workflowsDirectory = path.join(root, ".github", "workflows");
  const workflowFiles = (await readdir(workflowsDirectory)).filter((name) =>
    name.endsWith(".yml"),
  );
  const rawUploadProducers = [];
  for (const fileName of workflowFiles) {
    const document = yaml.load(
      await readFile(path.join(workflowsDirectory, fileName), "utf8"),
    );
    for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (
          step.uses === "actions/upload-artifact@v4" &&
          typeof step.with?.name === "string" &&
          step.with.name.startsWith("foundation-performance-raw-samples-")
        ) {
          rawUploadProducers.push({ fileName, jobName, step });
        }
      }
    }
  }
  assert.equal(rawUploadProducers.length, 1);
  assert.equal(rawUploadProducers[0].fileName, "performance-evidence.yml");
  assert.equal(
    rawUploadProducers[0].step.with.name,
    "foundation-performance-raw-samples-${{ github.sha }}-${{ github.run_attempt }}",
  );
  assert.equal(
    rawUploadProducers[0].step.with.path,
    "${{ runner.temp }}/foundation-performance-raw-output/raw-performance-samples.json",
  );
  assert.equal(rawUploadProducers[0].step.with.overwrite, false);

  const releaseWorkflow = await readFile(
    path.join(workflowsDirectory, "release.yml"),
    "utf8",
  );
  assert.match(
    releaseWorkflow,
    /name: foundation-performance-raw-samples-\$\{\{ inputs\.source_sha \}\}-\$\{\{ env\.REQUESTED_PERFORMANCE_RAW_SAMPLES_RUN_ATTEMPT \}\}[\s\S]*?run-id: \$\{\{ env\.REQUESTED_PERFORMANCE_RAW_SAMPLES_RUN_ID \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /\$actualRawSamplesHash -ne \$env:REQUESTED_PERFORMANCE_RAW_SAMPLES_SHA256/,
  );
  assert.match(
    releaseWorkflow,
    /--raw-samples-sha256 \$env:REQUESTED_PERFORMANCE_RAW_SAMPLES_SHA256[\s\S]*?--raw-samples-run-id \$env:REQUESTED_PERFORMANCE_RAW_SAMPLES_RUN_ID/,
  );
  assert.match(
    releaseWorkflow,
    /REQUESTED_PERFORMANCE_RAW_SAMPLES_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );
});
