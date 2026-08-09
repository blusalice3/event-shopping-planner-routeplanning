import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  parseOwnGatePerformanceEvidenceArguments,
  resolveRawCollectorAuthority,
  runOwnGatePerformanceEvidenceProducerCli,
} from "./produce-own-gate-performance-evidence.mjs";
import { canonicalJsonBytes, sha256Bytes } from "./lib/canonical-json.mjs";
import { buildPerformanceEvidenceEnvelope } from "./lib/performance-evidence-builder.mjs";
import { validateOwnGatePerformanceForInheritedClosure } from "./lib/performance-inherited-closure.mjs";
import { GITHUB_OIDC_RECEIPT_MEDIA_TYPE } from "./release-state/acceptanceEvidenceAuthority.mjs";
import { buildProtectedRawPerformanceArtifact } from "./release-state/ownGatePerformanceCollection.mjs";
import {
  assertAuthoritativeOwnGatePerformanceRequirements,
  ownGatePerformanceEvidenceArtifactName,
  ownGateRawSamplesArtifactName,
  ownGateRawSamplesEvidenceId,
  produceAuthoritativeOwnGatePerformanceEvidence,
} from "./release-state/ownGatePerformanceEvidence.mjs";
import { collectReviewedWorkflowRunAuthority } from "./release-state/reviewedWorkflowRunAuthority.mjs";

const namespace = "own-gate-performance-test";
const sourceSha = "a".repeat(40);
const sourceClosureSha256 = "b".repeat(64);
const rawRunId = "1966";
const currentRunId = "1967";
const producedAtUtc = "2026-08-09T12:00:00.000Z";
const scenarioId = "xlsx-worker-import-valid";
const fixtureSha256 = "c".repeat(64);
const sourceState = {
  gitCommitSha: sourceSha,
  sourceClosureSha256,
  treeState: "clean",
};
const requirements = {
  schemaVersion: 1,
  requirementKind: "standard-acceptance-requirements/v1",
  namespace,
  operationId: "accept-p3-performance",
  sourceSha,
  expectedArtifactSha256: "1".repeat(64),
  expectedState: { sequence: 17, eventHash: "d".repeat(64) },
  acceptedGate: "P3-XLSX",
  performanceEvidenceKind: "own-gate-performance-evidence/v1",
  performanceGate: "P3-XLSX",
};
const environment = {
  machineProfile: {
    os: "Windows 11",
    cpu: "Canonical CPU",
    memoryBytes: 34_359_738_368,
    powerMode: "best-performance-ac",
  },
  browser: {
    family: "chromium",
    version: "140.0.7339.16",
    channel: "chromium",
  },
};
const releaseVariant = {
  releaseRole: "standard",
  xlsxExecution: "worker",
  listEngine: "full",
  listDefault: "full",
};
const executionBinding = {
  adapterContract: "public-artifact-surface-v1",
  fixturePayload: {
    generator: "own-gate-producer-test-v1",
    seed: 1967,
    cardinality: 50_000,
    payloadSha256: "e".repeat(64),
    semanticSha256: "f".repeat(64),
  },
  faultInjection: null,
  setup: null,
};
const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});
const collectorAuthority = {
  collectorIdentity: reference("0".repeat(64)),
  workflowRunAuthority: reference("9".repeat(64)),
};

const createContextAndRawSamples = () => {
  const budget = {
    id: scenarioId,
    primaryMetric: "durationMs",
    supplementaryCeilings: {},
    pendingState: null,
    measurement: { medianMs: 1, p95Ms: 1 },
    absoluteCeilingMs: 2,
    regressionReference: null,
    regressionCeilingPercent: null,
    evidenceSha256: null,
  };
  const gateRequirement = {
    gate: "P3-XLSX",
    inherits: [],
    evidenceScope: "own",
    scenarioIds: [scenarioId],
    temporaryExceptions: [],
  };
  const budgets = {
    machineProfile: structuredClone(environment.machineProfile),
    browser: structuredClone(environment.browser),
    gateRequirements: [gateRequirement],
    scenarios: [budget],
  };
  budgets.machineProfile.status = "bound";
  const context = {
    errors: [],
    uiScenarios: { schemaVersion: 1, scenarios: [] },
    budgets,
    xlsxLimits: { schemaVersion: 1 },
    gateMap: new Map([["P3-XLSX", gateRequirement]]),
    scenarioMap: new Map([[scenarioId, { id: scenarioId, fixtureSha256 }]]),
    budgetMap: new Map([[scenarioId, budget]]),
    fixtureMap: new Map([
      [scenarioId, { requiredAssertions: ["scenario-completed"] }],
    ]),
    pendingScenarioIds: [],
    blockerMap: new Map(),
  };
  const input = {
    schemaVersion: 1,
    evidenceId: ownGateRawSamplesEvidenceId({
      performanceGate: "P3-XLSX",
      runId: rawRunId,
    }),
    gate: "P3-XLSX",
    collectedAtUtc: "2026-08-09T11:00:00.000Z",
    source: {
      ...sourceState,
      artifactSha256: "1".repeat(64),
      releaseVariant: structuredClone(releaseVariant),
    },
    environment: structuredClone(environment),
    scenarios: [
      {
        id: scenarioId,
        samples: Array.from({ length: 30 }, () => 1),
        supplementarySamples: {},
        outcomeAssertions: { "scenario-completed": true },
        executionBinding: structuredClone(executionBinding),
      },
    ],
  };
  const draft = buildPerformanceEvidenceEnvelope({ context, input });
  budget.evidenceSha256 = draft.evidenceSha256;
  return { context, input };
};

const canonicalRawBytes = (input) =>
  Buffer.concat([
    canonicalJsonBytes({
      schemaVersion: 1,
      artifactKind: "protected-own-gate-performance-raw/v1",
      collectorIdentity: collectorAuthority.collectorIdentity,
      samples: input,
    }),
    Buffer.from("\n", "utf8"),
  ]);

const produce = async ({
  mutateInput = () => {},
  requirement = requirements,
  rawSamplesRunId = rawRunId,
  activeRunId = currentRunId,
  expectedHash,
} = {}) => {
  const { context, input } = createContextAndRawSamples();
  mutateInput(input, context);
  const rawSamplesBytes = canonicalRawBytes(input);
  return produceAuthoritativeOwnGatePerformanceEvidence({
    requirements: requirement,
    rawSamplesBytes,
    expectedRawSamplesSha256: expectedHash ?? sha256Bytes(rawSamplesBytes),
    rawSamplesRunId,
    currentRunId: activeRunId,
    sourceState,
    context,
    producedAtUtc,
    collectorAuthority,
  });
};

const cliArguments = [
  "--namespace",
  namespace,
  "--raw-samples",
  "raw-performance-samples.json",
  "--raw-samples-sha256",
  "2".repeat(64),
  "--raw-samples-run-id",
  rawRunId,
  "--output",
  "performance-evidence.json",
  "--receipt-output",
  "performance-evidence-producer-receipt.json",
];

test("derives P0 own evidence from P0-RELEASE without collapsing its performance gate", () => {
  const p0 = {
    ...requirements,
    acceptedGate: "P0-RELEASE",
    performanceGate: "P0-TOOLCHAIN",
  };
  assert.equal(
    assertAuthoritativeOwnGatePerformanceRequirements({
      requirements: p0,
      expectedNamespace: namespace,
      expectedSourceSha: sourceSha,
    }).performanceGate,
    "P0-TOOLCHAIN",
  );
});

test("builds and verifies canonical own-gate evidence with provenance", async () => {
  const result = await produce();
  assert.equal(result.envelope.evidence.gate, "P3-XLSX");
  assert.equal(result.envelope.evidence.sampleCount, 30);
  assert.equal(result.receipt.receipt.acceptedGate, "P3-XLSX");
  assert.equal(result.receipt.receipt.performanceGate, "P3-XLSX");
  assert.deepEqual(result.receipt.receipt.authoritativeState, {
    sequence: 17,
    eventHash: "d".repeat(64),
  });
  assert.deepEqual(result.receipt.receipt.rawSamplesArtifact, {
    name: ownGateRawSamplesArtifactName(sourceSha),
    runId: rawRunId,
    sha256: result.receipt.receipt.rawSamplesArtifact.sha256,
    collectorIdentity: collectorAuthority.collectorIdentity,
    workflowRunAuthority: collectorAuthority.workflowRunAuthority,
  });
  assert.equal(
    result.receipt.receipt.performanceEvidence.name,
    ownGatePerformanceEvidenceArtifactName(sourceSha),
  );
  assert.equal(
    result.receipt.receipt.performanceEvidence.envelopeSha256,
    sha256Bytes(
      canonicalJsonBytes({
        schemaVersion: result.envelope.schemaVersion,
        evidence: result.envelope.evidence,
        evidenceSha256: result.envelope.evidenceSha256,
      }),
    ),
  );
  assert.deepEqual(result.envelope.producerReceipt, result.receipt);
});

test("P8 inherited validation projects a formal four-key artifact before the closed verifier", async () => {
  const result = await produce();
  const { context } = createContextAndRawSamples();
  const projected = validateOwnGatePerformanceForInheritedClosure({
    context,
    gate: "P3-XLSX",
    reviewedPerformance: {
      artifactKind: "own-gate-performance-evidence/v1",
      value: result.envelope,
    },
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "evidence",
    "evidenceSha256",
    "schemaVersion",
  ]);
});

test("rejects same-run, tampered, wrong-source, late, and noncanonical raw artifacts", async () => {
  await assert.rejects(
    produce({ activeRunId: rawRunId }),
    /distinct prior workflow run/,
  );
  await assert.rejects(
    produce({ expectedHash: "0".repeat(64) }),
    /reviewed SHA-256/,
  );
  await assert.rejects(
    produce({
      mutateInput(input) {
        input.evidenceId = "perf-own-gate-p3-xlsx-999999";
      },
    }),
    /authoritative gate or clean source/,
  );
  await assert.rejects(
    produce({
      mutateInput(input) {
        input.source.sourceClosureSha256 = "9".repeat(64);
      },
    }),
    /authoritative gate or clean source/,
  );
  await assert.rejects(
    produce({
      mutateInput(input) {
        input.source.artifactSha256 = "9".repeat(64);
      },
    }),
    /authoritative artifact archive/,
  );
  await assert.rejects(
    produce({
      mutateInput(input) {
        input.collectedAtUtc = "2026-08-09T13:00:00.000Z";
      },
    }),
    /collected after/,
  );
  const { context, input } = createContextAndRawSamples();
  const noncanonical = Buffer.from(
    `${JSON.stringify(input, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    produceAuthoritativeOwnGatePerformanceEvidence({
      requirements,
      rawSamplesBytes: noncanonical,
      expectedRawSamplesSha256: sha256Bytes(noncanonical),
      rawSamplesRunId: rawRunId,
      currentRunId,
      sourceState,
      context,
      producedAtUtc,
      collectorAuthority,
    }),
    /canonical JSON bytes/,
  );
});

test("rejects incomplete samples and false functional assertions through the canonical builder", async () => {
  await assert.rejects(
    produce({
      mutateInput(input) {
        input.scenarios[0].samples.pop();
      },
    }),
    /exactly 30/,
  );
  await assert.rejects(
    produce({
      mutateInput(input) {
        input.scenarios[0].outcomeAssertions["scenario-completed"] = false;
      },
    }),
    /required true assertions/,
  );
});

test("rejects non-own acceptance gates and P8 inherited closure reuse", async () => {
  for (const requirement of [
    {
      ...requirements,
      acceptedGate: "P1-PWA",
      performanceEvidenceKind: "none",
      performanceGate: null,
    },
    {
      ...requirements,
      acceptedGate: "P8-CLEAN",
      performanceEvidenceKind: "performance-inherited-closure/v1",
      performanceGate: "P8-CLEAN",
    },
  ]) {
    await assert.rejects(produce({ requirement }), /does not require own-gate/);
  }
});

test("CLI has no caller gate, envelope, or file-only production mode", () => {
  assert.equal(
    parseOwnGatePerformanceEvidenceArguments(cliArguments).rawSamplesRunId,
    rawRunId,
  );
  for (const forbidden of ["--gate", "--evidence", "--input-envelope"]) {
    assert.throws(
      () =>
        parseOwnGatePerformanceEvidenceArguments([
          ...cliArguments,
          forbidden,
          "caller-value",
        ]),
      /Unknown own-gate performance argument/,
    );
  }
});

const performanceApprovalPolicy = {
  trustedIssuer: "https://token.actions.githubusercontent.com",
  oidcAudience: "urn:event-shopping-planner:foundation-release-state",
  oidcClockSkewSeconds: 60,
  oidcMaxTokenAgeSeconds: 600,
  repository: "fixture/repository",
  workflowRef:
    "fixture/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
};

const performanceOidcReceipt = (overrides = {}) => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: performanceApprovalPolicy.trustedIssuer,
  audience: performanceApprovalPolicy.oidcAudience,
  subject: "repo:fixture/repository:environment:foundation-performance",
  tokenSha256: "2".repeat(64),
  signingKey: { kid: "test-key", jwkThumbprintSha256: "3".repeat(64) },
  claims: {
    repository: "fixture/repository",
    workflowRef:
      "fixture/repository/.github/workflows/performance-evidence.yml@refs/heads/main",
    workflowSha: sourceSha,
    environment: "foundation-performance",
    runId: rawRunId,
    runAttempt: "1",
    sourceSha,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    refProtected: true,
    jti: "performance-oidc-test",
    issuedAt: "2026-08-09T10:00:00.000Z",
    notBefore: "2026-08-09T10:00:00.000Z",
    expiresAt: "2026-08-09T10:10:00.000Z",
    ...(overrides.claims ?? {}),
  },
  verifiedAt: "2026-08-09T10:00:01.000Z",
  ...Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== "claims"),
  ),
});

test("raw producer rejects stored collector OIDC drift in workflow, head, ref, and run", async () => {
  const { input } = createContextAndRawSamples();
  for (const claims of [
    { workflowRef: performanceApprovalPolicy.workflowRef },
    { workflowSha: "8".repeat(40) },
    { sourceSha: "8".repeat(40) },
    { ref: "refs/heads/feature" },
    { refProtected: false },
    { runId: "9999" },
    { runAttempt: "0" },
  ]) {
    const receiptBytes = canonicalJsonBytes(performanceOidcReceipt({ claims }));
    const collectorIdentity = reference(sha256Bytes(receiptBytes));
    const rawArtifactBytes = buildProtectedRawPerformanceArtifact({
      samples: input,
      collectorIdentity,
    });
    await assert.rejects(
      resolveRawCollectorAuthority({
        rawArtifactBytes,
        rawSamplesRunId: rawRunId,
        sourceSha,
        namespace,
        approvalPolicy: performanceApprovalPolicy,
        environment: { GITHUB_TOKEN: "github-test-token" },
        store: {
          namespace,
          async readEvidence() {
            return {
              bytes: receiptBytes,
              mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
            };
          },
        },
        collectRunAuthority: async () => {
          throw new Error("run authority must not be queried");
        },
      }),
      /OIDC receipt differs from verified authority/,
    );
  }
});

const memoryEvidenceStore = () => {
  const evidence = new Map();
  return {
    namespace,
    evidence,
    async putEvidence({ bytes, mediaType }) {
      const inputBytes = Buffer.from(bytes);
      const sha256 = sha256Bytes(inputBytes);
      const committedAt = "2026-08-09T12:00:00.000Z";
      evidence.set(sha256, { bytes: inputBytes, mediaType, committedAt });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: inputBytes.length,
        committedAt,
      };
    },
    async readEvidence({ sha256 }) {
      return evidence.get(sha256) ?? null;
    },
  };
};

const githubRunResponse = (overrides = {}) => ({
  id: Number(rawRunId),
  run_attempt: 1,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: sourceSha,
  path: ".github/workflows/performance-evidence.yml",
  repository: { full_name: "fixture/repository" },
  ...overrides,
});

test("reviewed run authority rejects wrong workflow, head, ref, run, and conclusion", async () => {
  for (const override of [
    { path: ".github/workflows/release.yml" },
    { head_sha: "8".repeat(40) },
    { head_branch: "feature" },
    { id: 9999 },
    { run_attempt: 2 },
    { event: "push" },
    { status: "in_progress", conclusion: null },
    { conclusion: "failure" },
    { repository: { full_name: "other/repository" } },
  ]) {
    const body = Buffer.from(
      JSON.stringify(githubRunResponse(override)),
      "utf8",
    );
    await assert.rejects(
      collectReviewedWorkflowRunAuthority({
        githubToken: "github-test-token",
        namespace,
        repository: "fixture/repository",
        expectedRunId: rawRunId,
        expectedRunAttempt: "1",
        expectedSourceSha: sourceSha,
        expectedWorkflowPath: ".github/workflows/performance-evidence.yml",
        store: memoryEvidenceStore(),
        fetchImpl: async () => ({
          status: 200,
          headers: { get: () => "application/vnd.github+json" },
          arrayBuffer: async () => body,
        }),
      }),
      /differs from protected authority/,
    );
  }
});

test("reviewed release run authority rejects wrong path, head, attempt, status, and conclusion", async () => {
  const expectedWorkflowPath = ".github/workflows/release.yml";
  for (const override of [
    { path: ".github/workflows/performance-evidence.yml" },
    { head_sha: "8".repeat(40) },
    { head_branch: "feature" },
    { id: 9999 },
    { run_attempt: 2 },
    { event: "push" },
    { status: "in_progress", conclusion: null },
    { conclusion: "failure" },
    { repository: { full_name: "other/repository" } },
  ]) {
    const body = Buffer.from(
      JSON.stringify(
        githubRunResponse({ path: expectedWorkflowPath, ...override }),
      ),
      "utf8",
    );
    await assert.rejects(
      collectReviewedWorkflowRunAuthority({
        githubToken: "github-test-token",
        namespace,
        repository: "fixture/repository",
        expectedRunId: rawRunId,
        expectedRunAttempt: "1",
        expectedSourceSha: sourceSha,
        expectedWorkflowPath,
        store: memoryEvidenceStore(),
        fetchImpl: async () => ({
          status: 200,
          headers: { get: () => "application/vnd.github+json" },
          arrayBuffer: async () => body,
        }),
      }),
      /differs from protected authority/,
    );
  }
});

const metadataFor = (size) => ({
  size,
  isFile: () => true,
  isSymbolicLink: () => false,
});

const createCliEnvironment = () => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "fixture/repository",
  GITHUB_WORKFLOW_REF:
    "fixture/repository/.github/workflows/release.yml@refs/heads/main",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: currentRunId,
  GITHUB_RUN_ATTEMPT: "1",
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL: "postgres://fixture",
  RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
});

const runCli = async ({
  requirementsSequence = [requirements, requirements],
  environment: suppliedEnvironment,
} = {}) => {
  const { context, input } = createContextAndRawSamples();
  const rawSamplesBytes = canonicalRawBytes(input);
  const arguments_ = [...cliArguments];
  arguments_[arguments_.indexOf("--raw-samples-sha256") + 1] =
    sha256Bytes(rawSamplesBytes);
  const writes = [];
  let requirementsIndex = 0;
  let closed = 0;
  const result = await runOwnGatePerformanceEvidenceProducerCli(
    {
      arguments_,
      environment: suppliedEnvironment ?? createCliEnvironment(),
      workingDirectory: "D:/own-gate-performance-test",
      stdout: { write() {} },
    },
    {
      lstatImpl: async (filePath) => {
        if (filePath.endsWith("raw-performance-samples.json")) {
          return metadataFor(rawSamplesBytes.length);
        }
        const error = new Error("absent");
        error.code = "ENOENT";
        throw error;
      },
      readFileImpl: async () => rawSamplesBytes,
      writeFileImpl: async (...values) => writes.push(values),
      loadJson: async (filePath) =>
        filePath.endsWith("approval-policy.json")
          ? {
              bindingStatus: "configured",
              blockerCodes: [],
              repository: "fixture/repository",
              workflowRef:
                "fixture/repository/.github/workflows/release.yml@refs/heads/main",
            }
          : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
      verifyPolicy: async () => context,
      resolveSource: async () => sourceState,
      createStore: async () => ({
        namespace,
        async close() {
          closed += 1;
        },
      }),
      resolveRequirements: async () =>
        requirementsSequence[requirementsIndex++] ??
        requirementsSequence.at(-1),
      resolveCollectorAuthority: async ({ rawArtifactBytes }) => ({
        rawSamples: JSON.parse(rawArtifactBytes.toString("utf8")).samples,
        collectorAuthority: structuredClone(collectorAuthority),
      }),
      clock: () => Date.parse(producedAtUtc),
    },
  );
  return { result, writes, closed };
};

test("CLI replays authoritative requirements before and after building and writes a closed pair", async () => {
  const { result, writes, closed } = await runCli();
  assert.equal(closed, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual(
    new Set(writes.map(([filePath]) => path.basename(filePath))),
    new Set([
      "performance-evidence.json",
      "performance-evidence-producer-receipt.json",
    ]),
  );
  assert.ok(writes.every(([, , options]) => options.flag === "wx"));
  assert.equal(result.receipt.receipt.rawSamplesArtifact.runId, rawRunId);
});

test("CLI fails closed when Release State changes and without protected workflow authority", async () => {
  await assert.rejects(
    runCli({
      requirementsSequence: [
        requirements,
        {
          ...requirements,
          expectedState: { sequence: 18, eventHash: "3".repeat(64) },
        },
      ],
    }),
    /changed during performance evidence production/,
  );
  const environmentWithoutWorkflowAuthority = createCliEnvironment();
  delete environmentWithoutWorkflowAuthority.GITHUB_ACTIONS;
  await assert.rejects(
    runCli({ environment: environmentWithoutWorkflowAuthority }),
    /protected workflow environment is absent/,
  );
});
