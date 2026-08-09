import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { createReleaseEvent } from "../release-state/releaseStateReducer.mjs";
import {
  promotePreparedOperation,
  validatePreparedPromotionResult,
} from "./preparedPromotion.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";
import {
  parsePromotePreparedCliArguments,
  resolvePromotePreparedCliPaths,
} from "./promote-prepared.mjs";

const FIXED_NOW = Date.parse("2026-08-06T00:00:10.000Z");
const FIXED_DATE = "Thu, 06 Aug 2026 00:00:10 GMT";
const SOURCE_SHA = "a".repeat(40);
const TOKEN = "vercel_test_token_1234567890";
const NAMESPACE = "foundation-test";
const TEAM_ID = "team_expected";
const PROJECT_ID = "prj_expected";
const TARGET_ID = "dpl_target";
const PREVIOUS_ID = "dpl_previous";
const DOMAINS = ["app.example.test", "www.example.test"];

const reference = (suffix) => ({
  uri: `release-state://${NAMESPACE}/evidence/${suffix.repeat(64)}`,
  sha256: suffix.repeat(64),
});

const providerPolicy = {
  schemaVersion: 1,
  bindingStatus: "configured",
  provider: "vercel",
  expectedTeamId: TEAM_ID,
  expectedProjectId: PROJECT_ID,
  ownedProductionDomains: DOMAINS,
  productionEnvironmentName: "production",
  providerNodeFamily: "24.x",
  productionBranch: "main",
  autoAssignCustomProductionDomains: false,
  gitProductionAutoDeploy: false,
  allowedPreviewBranches: [],
  requiredEnvironmentNames: ["VERCEL_DEPLOYMENT_ID"],
  cspReportEnvironmentNames: [],
  forbiddenEnvironmentNames: [],
  rawRequestByteCeilings: {
    persistenceReleaseAMetrics: 1024,
    cspReport: 16384,
    googleSheetsCsv: 512,
  },
  wafRules: {
    metricsRoute: { id: "waf_metrics" },
    cspReportRoute: { id: "waf_csp" },
    googleSheetsCsvRoute: { id: "waf_csv" },
  },
  logPolicy: {
    allowedFields: ["requestId"],
    retentionDays: 1,
    retentionObservation: {
      kind: "vercel-runtime-plan-v1",
      observabilityPlus: false,
      drainId: null,
      jsonPointer: "/plan",
    },
  },
  hstsOwner: "provider",
  hstsPolicy: {
    minimumMaxAgeSeconds: 31536000,
    requireIncludeSubDomains: true,
    requirePreload: true,
  },
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    firewallConfigVersion: "active",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
    requireEtag: true,
  },
  requiredConfigurationEvidence: [
    "project",
    "team",
    "domains",
    "environment-presence",
    "git-integration",
    "waf",
    "log-retention",
    "hsts",
  ],
  blockerCodes: [],
};

const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "100",
  GITHUB_SHA: SOURCE_SHA,
  RELEASE_STATE_NAMESPACE: NAMESPACE,
  VERCEL_ORG_ID: TEAM_ID,
  VERCEL_PROJECT_ID: PROJECT_ID,
  VERCEL_TOKEN: TOKEN,
};

const toolchainPolicy = {
  schemaVersion: 1,
  packages: { vercel: "58.5.1" },
};

const fullProviderObservation = ({
  observedAt = "2026-08-06T00:00:10.000Z",
  etag = '"provider-fixture"',
  overrides = {},
} = {}) => ({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt,
  providerTeamId: TEAM_ID,
  providerProjectId: PROJECT_ID,
  ownedProductionDomains: DOMAINS,
  providerNodeFamily: "24.x",
  evidenceReceipts: [
    {
      kind: "fixture",
      responseDate: FIXED_DATE,
      etag,
      bodySha256: "1".repeat(64),
    },
  ],
  ...overrides,
});
const PROVIDER_CONFIGURATION_HASH = providerConfigurationHash(
  fullProviderObservation(),
);

const binding = ({
  role,
  deploymentId,
  suffix,
  deploymentUrl = `https://${deploymentId}.vercel.app`,
}) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha: SOURCE_SHA,
  buildId: SOURCE_SHA,
  variantId: suffix.repeat(64),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: PROJECT_ID,
  providerDeploymentId: deploymentId,
  deploymentUrl,
  artifactArchive: reference(role === "standard" ? "a" : "b"),
  artifactArchiveAvailability: reference(role === "standard" ? "c" : "d"),
  packageIndex: reference("1"),
  artifactManifest: reference(role === "standard" ? "2" : "3"),
  providerEvidence: reference(role === "standard" ? "4" : "5"),
  releasePolicy: reference("6"),
  providerPolicy: {
    uri: `release-state://${NAMESPACE}/evidence/` + sha256Json(providerPolicy),
    sha256: sha256Json(providerPolicy),
  },
  providerConfigurationHash: PROVIDER_CONFIGURATION_HASH,
  requiredDbCompatibility: {
    contractUri: "release-state://foundation-test/evidence/db",
    fingerprint: "8".repeat(64),
  },
});

const approval = ({ role, suffix }) => ({
  uri: reference(suffix).uri,
  sha256: reference(suffix).sha256,
  approvalId: `approval-${suffix}`,
  operationId: "promote-fixture",
  subjectSha256: "b".repeat(64),
  trustedIssuer: "https://token.actions.githubusercontent.com",
  issuerReceiptUri: reference("c").uri,
  issuerReceiptSha256: reference("c").sha256,
  workflowRunId: "100",
  protectedEnvironment: "foundation-release-state",
  providerReviewerId: `reviewer-${suffix}`,
  role,
  decision: "APPROVED",
  approvedAt: "2026-08-06T00:00:00.000Z",
});

const preparedFixture = () => {
  const targetBinding = binding({
    role: "standard",
    deploymentId: TARGET_ID,
    suffix: "a",
  });
  const companionBinding = binding({
    role: "containment",
    deploymentId: "dpl_companion",
    suffix: "d",
  });
  const previousBinding = binding({
    role: "standard",
    deploymentId: PREVIOUS_ID,
    suffix: "e",
  });
  const approvals = [
    approval({ role: "releaseOwner", suffix: "9" }),
    approval({ role: "dataSafetyReviewer", suffix: "f" }),
  ];
  const subjectReference = reference("b");
  const event = createReleaseEvent({
    namespace: NAMESPACE,
    sequence: 2,
    eventType: "promotion-prepared",
    operationId: "promote-fixture",
    appendId: "12345678-1234-4123-8123-123456789abc",
    previousEventHash: "0".repeat(64),
    payload: {
      pendingOperation: {
        operationId: "promote-fixture",
        kind: "promote-standard",
        expectedState: {
          sequence: 1,
          eventHash: "0".repeat(64),
        },
        targetBinding,
        originBinding: null,
        originCompanionBinding: null,
        companionBinding,
        previousBinding,
        emergencyRecoveryBinding: companionBinding,
        approvalRefs: approvals,
        preparedAt: "2026-08-06T00:00:00.000Z",
      },
    },
    evidenceRefs: [
      subjectReference,
      reference("c"),
      ...approvals.map(({ uri, sha256 }) => ({ uri, sha256 })),
    ],
    approvalRefs: approvals,
  });
  const eventHash = sha256Bytes(canonicalJsonBytes(event));
  const result = {
    replayed: false,
    subjectSha256: subjectReference.sha256,
    subjectReference,
    approvalRefs: approvals,
    event,
    eventHash,
    eventUri: `release-state://${NAMESPACE}/events/${event.sequence}/${eventHash}`,
    committedAt: "2026-08-06T00:00:01.000Z",
    head: { sequence: event.sequence, eventHash },
  };
  return {
    result,
    bytes: canonicalJsonBytes(result),
    targetBinding,
  };
};

const aliasResponse = (domain, deploymentId, overrides = {}) =>
  new Response(
    JSON.stringify({
      alias: domain,
      projectId: PROJECT_ID,
      deploymentId,
      deployment: { id: deploymentId, url: `${deploymentId}.vercel.app` },
      redirect: null,
      ...overrides,
    }),
    {
      status: 200,
      headers: {
        date: FIXED_DATE,
        etag: `"${domain}-${deploymentId}"`,
        "content-type": "application/json",
      },
    },
  );

const createFetch = (state) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const domain = decodeURIComponent(
      new URL(url).pathname.replace("/v4/aliases/", ""),
    );
    return aliasResponse(domain, state.get(domain));
  };
  return { calls, fetchImpl };
};

const fixture = async (initialAssignments = DOMAINS.map(() => PREVIOUS_ID)) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prepared-promotion-"));
  const receiptPath = path.join(root, "receipt.json");
  const state = new Map(
    DOMAINS.map((domain, index) => [domain, initialAssignments[index]]),
  );
  const provider = createFetch(state);
  const commands = [];
  const configurationObservations = [];
  const prepared = preparedFixture();
  const baseOptions = {
    preparedResultBytes: prepared.bytes,
    providerPolicy,
    toolchainPolicy,
    receiptPath,
    root,
    environment,
  };
  const dependencies = {
    fetchImpl: provider.fetchImpl,
    clock: () => FIXED_NOW,
    resolveCli: async () => ({
      cliPath: path.join(root, "node_modules", "vercel", "cli.js"),
      version: "58.5.1",
    }),
    collectProviderObservation: async () => {
      const observation = fullProviderObservation({
        observedAt:
          configurationObservations.length === 0
            ? "2026-08-06T00:00:09.000Z"
            : "2026-08-06T00:00:10.000Z",
        etag:
          configurationObservations.length === 0
            ? '"provider-before"'
            : '"provider-after"',
      });
      configurationObservations.push(observation);
      return observation;
    },
    commandRunner: async (invocation) => {
      commands.push(invocation);
      for (const domain of DOMAINS) state.set(domain, TARGET_ID);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return {
    root,
    receiptPath,
    state,
    provider,
    commands,
    configurationObservations,
    prepared,
    baseOptions,
    dependencies,
  };
};

test("promotes one prepared standard target and writes canonical before/after evidence", async () => {
  const context = await fixture();
  try {
    const result = await promotePreparedOperation(
      context.baseOptions,
      context.dependencies,
    );
    assert.equal(result.replayed, false);
    assert.equal(result.receipt.outcome, "promoted");
    assert.equal(context.commands.length, 1);
    assert.equal(context.configurationObservations.length, 2);
    assert.equal(context.provider.calls.length, DOMAINS.length * 2);
    assert.deepEqual(context.commands[0], {
      executable: process.execPath,
      arguments: [
        path.join(context.root, "node_modules", "vercel", "cli.js"),
        "promote",
        context.prepared.targetBinding.deploymentUrl,
        "--yes",
      ],
      cwd: context.root,
      environment,
    });
    assert.equal(context.commands[0].arguments.includes(TOKEN), false);
    const receiptBytes = await readFile(context.receiptPath);
    assert.equal(receiptBytes.equals(canonicalJsonBytes(result.receipt)), true);
    assert.equal(receiptBytes.includes(Buffer.from(TOKEN)), false);
    assert.equal(
      result.receipt.providerBinding.providerConfigurationHash,
      context.prepared.targetBinding.providerConfigurationHash,
    );
    assert.notEqual(
      result.receipt.providerBinding.beforeProviderObservationSha256,
      result.receipt.providerBinding.afterProviderObservationSha256,
    );
    assert.notEqual(
      result.receipt.providerBinding.beforeProviderObservationSha256,
      result.receipt.providerBinding.providerConfigurationHash,
    );
    assert.equal(
      result.receipt.assignmentEvidence.assignments.every(
        ({ previousDeploymentId, assignedDeploymentId }) =>
          previousDeploymentId === PREVIOUS_ID &&
          assignedDeploymentId === TARGET_ID,
      ),
      true,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("treats an all-target observation as an idempotent replay", async () => {
  const context = await fixture(DOMAINS.map(() => TARGET_ID));
  try {
    const result = await promotePreparedOperation(
      context.baseOptions,
      context.dependencies,
    );
    assert.equal(result.replayed, true);
    assert.equal(result.receipt.outcome, "replayed");
    assert.equal(result.receipt.cli.executed, false);
    assert.equal(context.commands.length, 0);
    assert.equal(context.configurationObservations.length, 2);
    assert.equal(context.provider.calls.length, DOMAINS.length * 2);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("fails closed before mutation for partial or unknown assignments", async () => {
  for (const assignments of [
    [PREVIOUS_ID, TARGET_ID],
    [PREVIOUS_ID, "dpl_unknown"],
  ]) {
    const context = await fixture(assignments);
    try {
      await assert.rejects(
        promotePreparedOperation(context.baseOptions, context.dependencies),
        /blocked by (partial|unknown) production assignments/,
      );
      assert.equal(context.commands.length, 0);
      assert.equal(context.provider.calls.length, DOMAINS.length);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  }
});

test("rejects command output containing the provider token", async () => {
  const context = await fixture();
  try {
    context.dependencies.commandRunner = async (invocation) => {
      context.commands.push(invocation);
      for (const domain of DOMAINS) context.state.set(domain, TARGET_ID);
      return { status: 0, stdout: `unexpected ${TOKEN}`, stderr: "" };
    };
    await assert.rejects(
      promotePreparedOperation(context.baseOptions, context.dependencies),
      /stdout contains VERCEL_TOKEN/,
    );
    await assert.rejects(readFile(context.receiptPath), /ENOENT/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("refuses an existing receipt before provider observation or mutation", async () => {
  const context = await fixture();
  try {
    await writeFile(context.receiptPath, "existing", {
      encoding: "utf8",
      flag: "wx",
    });
    await assert.rejects(
      promotePreparedOperation(context.baseOptions, context.dependencies),
      /receipt output already exists/,
    );
    assert.equal(context.provider.calls.length, 0);
    assert.equal(context.commands.length, 0);
    assert.equal(context.configurationObservations.length, 0);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects full provider configuration drift before and after promotion", async () => {
  const beforeDrift = await fixture();
  try {
    beforeDrift.dependencies.collectProviderObservation = async () =>
      fullProviderObservation({
        overrides: { providerNodeFamily: "20.x" },
      });
    await assert.rejects(
      promotePreparedOperation(
        beforeDrift.baseOptions,
        beforeDrift.dependencies,
      ),
      /Before-promotion full provider configuration differs/,
    );
    assert.equal(beforeDrift.commands.length, 0);
    assert.equal(beforeDrift.provider.calls.length, 0);
  } finally {
    await rm(beforeDrift.root, { recursive: true, force: true });
  }

  const afterDrift = await fixture();
  try {
    let configurationCalls = 0;
    afterDrift.dependencies.collectProviderObservation = async () => {
      configurationCalls += 1;
      return fullProviderObservation({
        overrides:
          configurationCalls === 1 ? {} : { providerNodeFamily: "20.x" },
      });
    };
    await assert.rejects(
      promotePreparedOperation(afterDrift.baseOptions, afterDrift.dependencies),
      /After-promotion full provider configuration differs/,
    );
    assert.equal(afterDrift.commands.length, 1);
    assert.equal(afterDrift.provider.calls.length, DOMAINS.length * 2);
    await assert.rejects(readFile(afterDrift.receiptPath), /ENOENT/);
  } finally {
    await rm(afterDrift.root, { recursive: true, force: true });
  }
});

test("validates prepared event hash and the exact protected source/run", () => {
  const prepared = preparedFixture();
  const tampered = {
    ...prepared.result,
    eventHash: "f".repeat(64),
  };
  assert.throws(
    () =>
      validatePreparedPromotionResult({
        preparedResultBytes: canonicalJsonBytes(tampered),
        providerPolicy,
        environment,
        nowMilliseconds: FIXED_NOW,
      }),
    /event hash, URI, or commit head differs/,
  );
  assert.throws(
    () =>
      validatePreparedPromotionResult({
        preparedResultBytes: prepared.bytes,
        providerPolicy,
        environment: { ...environment, GITHUB_RUN_ID: "101" },
        nowMilliseconds: FIXED_NOW,
      }),
    /approval binding is invalid/,
  );
  assert.throws(
    () =>
      validatePreparedPromotionResult({
        preparedResultBytes: prepared.bytes,
        providerPolicy,
        environment: { ...environment, VERCEL_TOKEN: "short" },
        nowMilliseconds: FIXED_NOW,
      }),
    /VERCEL_TOKEN is absent or invalid/,
  );
});

test("CLI rejects unknown/duplicate authority flags and path reuse", () => {
  assert.throws(
    () =>
      parsePromotePreparedCliArguments([
        "--prepared-result",
        "prepared.json",
        "--target",
        TARGET_ID,
      ]),
    /forbidden prepared promotion option/,
  );
  assert.throws(
    () =>
      parsePromotePreparedCliArguments([
        "--prepared-result",
        "prepared.json",
        "--prepared-result",
        "other.json",
      ]),
    /duplicate/,
  );
  assert.throws(
    () =>
      resolvePromotePreparedCliPaths({
        preparedResultPath: "same.json",
        receiptPath: "same.json",
      }),
    /paths must be distinct/,
  );
});
