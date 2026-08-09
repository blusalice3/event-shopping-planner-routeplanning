import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE } from "../db/remote-db-observation-authority.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";
import {
  STARTUP_WAF_OBSERVATION_MEDIA_TYPE,
  STARTUP_WAF_OPERATION,
  aggregateStartupWafTranscript,
  collectAndStoreStartupWafObservation,
  readStartupWafObservationAuthority,
  resolveStartupWafBinding,
} from "./startup-waf-observation.mjs";
import {
  parseStartupWafObservationArguments,
  runStartupWafObservationCli,
  writeStartupWafResultCreateOnly,
} from "./collect-startup-waf-observation.mjs";

const NOW = Date.parse("2026-08-09T04:05:06.000Z");
const SOURCE_SHA = "a".repeat(40);
const BOOTSTRAP_SOURCE_SHA = "b".repeat(40);
const NAMESPACE = "foundation-production";
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";

const baseProviderPolicy = parseJsonStrict(
  await readFile(
    new URL("../../config/provider-policy.json", import.meta.url),
    "utf8",
  ),
);
const baseApprovalPolicy = parseJsonStrict(
  await readFile(
    new URL("../../config/approval-policy.json", import.meta.url),
    "utf8",
  ),
);
const metricsContract = parseJsonStrict(
  await readFile(
    new URL(
      "../../contracts/persistence-release-a-metrics-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const startupContractSource = parseJsonStrict(
  await readFile(
    new URL(
      "../../contracts/persistence-release-a-startup-bursts-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const wafRule = (id, route, rateLimit = null) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: route }] }],
  rateLimit,
});

const providerPolicy = Object.freeze({
  ...baseProviderPolicy,
  bindingStatus: "configured",
  expectedTeamId: "team_test",
  expectedProjectId: "prj_test",
  ownedProductionDomains: ["example.test"],
  requiredEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  cspReportEnvironmentNames: [],
  forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
  wafRules: {
    metricsRoute: wafRule(
      "rule_metrics",
      "/api/persistence-release-a-metrics",
      {
        algo: "fixed_window",
        keys: ["ip"],
        limit: 5,
        window: 60,
      },
    ),
    cspReportRoute: wafRule("rule_csp", "/api/csp-report"),
    googleSheetsCsvRoute: wafRule("rule_sheets", "/api/google-sheets-csv"),
  },
  logPolicy: {
    ...baseProviderPolicy.logPolicy,
    retentionDays: 1,
    retentionObservation: {
      kind: "vercel-runtime-plan-v1",
      observabilityPlus: false,
      drainId: null,
      jsonPointer: null,
    },
  },
  hstsPolicy: {
    minimumMaxAgeSeconds: 31_536_000,
    requireIncludeSubDomains: true,
    requirePreload: false,
  },
  blockerCodes: [],
});

const approvalPolicy = Object.freeze({
  ...baseApprovalPolicy,
  bindingStatus: "configured",
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
  blockerCodes: [],
});

const providerRequestUrl = (pathname, query = {}) => {
  const url = new URL(pathname, providerPolicy.observationPolicy.apiBaseUrl);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, String(value));
  }
  url.searchParams.sort();
  return url.href;
};

const providerReceipt = (kind, requestUrl, { hsts = null } = {}) => {
  const value = {
    kind,
    method: kind.startsWith("hsts:") ? "HEAD" : "GET",
    requestUrl,
    status: 200,
    responseDate: new Date(NOW).toUTCString(),
    etag: null,
    contentType: kind.startsWith("hsts:") ? null : "application/json",
    strictTransportSecurity: hsts,
    bodySha256: "2".repeat(64),
  };
  return {
    ...value,
    responseSha256: sha256Json({
      status: value.status,
      responseDate: value.responseDate,
      etag: value.etag,
      contentType: value.contentType,
      strictTransportSecurity: value.strictTransportSecurity,
      bodySha256: value.bodySha256,
    }),
  };
};

const createProviderObservation = (policy = providerPolicy) => ({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: new Date(NOW).toISOString(),
  providerTeamId: policy.expectedTeamId,
  providerProjectId: policy.expectedProjectId,
  productionEnvironmentName: "production",
  providerNodeFamily: "24.x",
  productionBranch: "main",
  autoAssignCustomProductionDomains: false,
  gitProductionAutoDeploy: false,
  gitPreviewAutoDeploy: false,
  gitIntegration: {
    connected: true,
    provider: "github",
    productionBranch: "main",
  },
  allowedPreviewBranches: [],
  ownedProductionDomains: [...policy.ownedProductionDomains],
  presentEnvironmentNames: [...policy.requiredEnvironmentNames],
  rawRequestByteCeilings: policy.rawRequestByteCeilings,
  wafRules: policy.wafRules,
  logPolicy: policy.logPolicy,
  logRetentionEvidence: {
    kind: "vercel-runtime-plan-v1",
    plan: "pro",
    activeLogDrainIds: [],
    retentionDays: 1,
  },
  hstsOwner: "provider",
  hstsPolicy: policy.hstsPolicy,
  hsts: [
    {
      domain: "example.test",
      maxAgeSeconds: 63_072_000,
      includeSubDomains: true,
      preload: false,
    },
  ],
  configurationEvidenceKinds: [...policy.requiredConfigurationEvidence].sort(),
  evidenceReceipts: [
    providerReceipt("team", providerRequestUrl("/v2/teams/team_test")),
    providerReceipt(
      "project",
      providerRequestUrl("/v9/projects/prj_test", { teamId: "team_test" }),
    ),
    providerReceipt(
      "domains",
      providerRequestUrl("/v9/projects/prj_test/domains", {
        teamId: "team_test",
        limit: 100,
        production: true,
      }),
    ),
    providerReceipt(
      "environment-presence",
      providerRequestUrl("/v10/projects/prj_test/env", {
        teamId: "team_test",
        decrypt: false,
      }),
    ),
    providerReceipt(
      "waf",
      providerRequestUrl("/v1/security/firewall/config/active", {
        projectId: "prj_test",
        teamId: "team_test",
      }),
    ),
    providerReceipt(
      "log-retention",
      providerRequestUrl("/v1/drains", {
        includeMetadata: true,
        projectId: "prj_test",
        teamId: "team_test",
      }),
    ),
    providerReceipt("hsts:example.test", "https://example.test/", {
      hsts: "max-age=63072000; includeSubDomains",
    }),
  ].sort((left, right) => left.kind.localeCompare(right.kind)),
});

const oidcReceipt = ({ extra = {} } = {}) => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: approvalPolicy.trustedIssuer,
  audience: approvalPolicy.oidcAudience,
  subject: "repo:owner/repository:environment:foundation-release-state",
  tokenSha256: "3".repeat(64),
  signingKey: {
    kid: "fixture-key",
    jwkThumbprintSha256: "4".repeat(64),
  },
  claims: {
    repository: approvalPolicy.repository,
    workflowRef: approvalPolicy.workflowRef,
    workflowSha: SOURCE_SHA,
    environment: approvalPolicy.protectedEnvironment,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    sourceSha: SOURCE_SHA,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    refProtected: true,
    jti: "startup-waf-fixture",
    issuedAt: new Date(NOW - 60_000).toISOString(),
    notBefore: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 540_000).toISOString(),
  },
  verifiedAt: new Date(NOW).toISOString(),
  ...extra,
});

class MemoryStore {
  constructor(namespace = NAMESPACE) {
    this.namespace = namespace;
    this.objects = new Map();
    this.badReceipt = false;
  }

  async putEvidence({ bytes, mediaType }) {
    const input = Buffer.from(bytes);
    const sha256 = sha256Bytes(input);
    const existing = this.objects.get(sha256);
    if (existing && existing.mediaType !== mediaType) {
      throw new Error("Immutable media type conflict");
    }
    this.objects.set(sha256, {
      bytes: input,
      mediaType,
      committedAt: new Date(NOW).toISOString(),
    });
    return {
      uri: `release-state://${this.namespace}/evidence/${sha256}`,
      sha256: this.badReceipt ? "0".repeat(64) : sha256,
      mediaType,
      byteLength: input.length,
      committedAt: new Date(NOW).toISOString(),
      replayed: existing !== undefined,
    };
  }

  async readEvidence({ sha256 }) {
    const stored = this.objects.get(sha256);
    return stored
      ? {
          bytes: Buffer.from(stored.bytes),
          mediaType: stored.mediaType,
          committedAt: stored.committedAt,
        }
      : null;
  }
}

const putFixtureObject = async (store, value, mediaType) => {
  const bytes = canonicalJsonBytes(value);
  const receipt = await store.putEvidence({ bytes, mediaType });
  return { uri: receipt.uri, sha256: sha256Bytes(bytes) };
};

const arbitraryReference = (digit) => ({
  uri: `release-state://${NAMESPACE}/evidence/${digit.repeat(64)}`,
  sha256: digit.repeat(64),
});

const configuredStartupContract = () => ({
  ...structuredClone(startupContractSource),
  activationStatus: "configured",
  blockerCodes: [],
});

const loadFixtureBytes = async () => {
  const pairs = await Promise.all(
    startupContractSource.profiles.map(async (profile) => [
      profile.id,
      await readFile(new URL(`../../${profile.fixturePath}`, import.meta.url)),
    ]),
  );
  return new Map(pairs);
};

const createStateFixture = async ({ postInitialization = false } = {}) => {
  const store = new MemoryStore();
  const observation = createProviderObservation();
  const policyReference = await putFixtureObject(
    store,
    providerPolicy,
    REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  );
  const manifestReference = arbitraryReference("6");
  const packageReference = arbitraryReference("7");
  const releasePolicyReference = arbitraryReference("8");
  const dbCompatibility = {
    contractUri: "urn:event-shopping-planner:db:test-v1",
    fingerprint: "9".repeat(64),
  };
  const providerEvidence = {
    schemaVersion: 1,
    sourceSha: BOOTSTRAP_SOURCE_SHA,
    variantId: "b".repeat(64),
    releaseRole: "containment",
    providerProjectId: "prj_test",
    providerDeploymentId: "dpl_bootstrap",
    deploymentUrl: "https://bootstrap-preview.vercel.app",
    artifactManifestHash: manifestReference.sha256,
    packageIndexHash: packageReference.sha256,
    providerConfigurationHash: providerConfigurationHash(observation),
    providerPolicyHash: policyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentity: { identityKind: "legacy-bootstrap-v1" },
    routeProbeEvidenceHash: "c".repeat(64),
    environmentPresenceEvidenceHash: "d".repeat(64),
  };
  const providerEvidenceReference = await putFixtureObject(
    store,
    providerEvidence,
    "application/vnd.event-shopping-planner.provider-deployment-evidence+json;version=1",
  );
  const binding = {
    bindingId: "binding-bootstrap-recovery",
    sourceSha: BOOTSTRAP_SOURCE_SHA,
    buildId: BOOTSTRAP_SOURCE_SHA,
    variantId: "b".repeat(64),
    releaseRole: "containment",
    publicIdentityKind: "legacy-bootstrap-v1",
    providerProjectId: "prj_test",
    providerDeploymentId: "dpl_bootstrap",
    deploymentUrl: "https://bootstrap-preview.vercel.app",
    artifactArchive: arbitraryReference("1"),
    artifactArchiveAvailability: arbitraryReference("2"),
    packageIndex: packageReference,
    artifactManifest: manifestReference,
    providerEvidence: providerEvidenceReference,
    providerPolicy: policyReference,
    releasePolicy: releasePolicyReference,
    providerConfigurationHash: providerConfigurationHash(observation),
    requiredDbCompatibility: dbCompatibility,
  };
  const initializationRecord = {
    sequence: 1,
    eventHash: "f".repeat(64),
    event: {
      namespace: NAMESPACE,
      sequence: 1,
      previousEventHash: null,
      eventType: "state-initialized",
      operationId: "initialize-bootstrap-recovery",
      payload: {
        executorSourceSha: SOURCE_SHA,
        bootstrapRecovery: binding,
      },
    },
  };
  const phaseExitRecord = {
    sequence: 2,
    eventHash: "0".repeat(64),
    event: {
      eventType: "phase-exit-attested",
      operationId: "attest-p0-artifact",
      payload: { gate: "P0-ARTIFACT" },
    },
  };
  const current = {
    head: {
      sequence: postInitialization ? 2 : 1,
      eventHash: postInitialization
        ? phaseExitRecord.eventHash
        : initializationRecord.eventHash,
    },
    snapshot: {
      currentDbCompatibility: dbCompatibility,
      pendingOperation: null,
      pendingAcceptance: null,
      activeProduction: null,
      acceptedStandard: null,
      acceptedGate: null,
      bootstrapRecovery: binding,
    },
    records: postInitialization
      ? [initializationRecord, phaseExitRecord]
      : [initializationRecord],
  };
  return {
    store,
    current,
    binding,
    observation,
    startupContract: configuredStartupContract(),
    fixtures: await loadFixtureBytes(),
    readState: async () => current,
  };
};

const createBrowser = ({
  normalStatus = 202,
  overLimitStatuses = null,
} = {}) => {
  let contextIndex = 0;
  const contextCounts = [];
  const browser = {
    async newContext(options) {
      assert.equal(options.serviceWorkers, "block");
      const thisContext = contextIndex;
      contextIndex += 1;
      let requestIndex = 0;
      return {
        request: {
          async fetch(url, options_) {
            assert.equal(
              url,
              "https://bootstrap-preview.vercel.app/api/persistence-release-a-metrics",
            );
            assert.equal(options_.method, "POST");
            const request = parseJsonStrict(options_.data.toString("utf8"));
            assert.equal(request.buildId, BOOTSTRAP_SOURCE_SHA);
            const statuses =
              thisContext < 3
                ? [normalStatus]
                : (overLimitStatuses ?? [202, 202, 202, 202, 202, 429]);
            const status = statuses[requestIndex] ?? statuses.at(-1);
            requestIndex += 1;
            return {
              status: () => status,
              url: () => url,
              headers: () => ({
                date: new Date(NOW).toUTCString(),
                "content-type": "application/json",
                ...(status === 429 ? { "retry-after": "60" } : {}),
              }),
              body: async () =>
                Buffer.from(
                  status === 429
                    ? '{"error":"rate-limited"}'
                    : '{"accepted":true}',
                  "utf8",
                ),
            };
          },
        },
        async close() {
          contextCounts.push(requestIndex);
        },
      };
    },
    async close() {},
  };
  return { browser, contextCounts };
};

const environment = Object.freeze({
  GITHUB_RUN_ID: RUN_ID,
  GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
  VERCEL_TOKEN: "vercel-token-that-must-never-appear",
});

const collectPositive = async (fixture, browserOptions = {}) => {
  const browser = createBrowser(browserOptions);
  const collected = await collectAndStoreStartupWafObservation(
    {
      store: fixture.store,
      namespace: NAMESPACE,
      sourceSha: SOURCE_SHA,
      providerPolicy,
      approvalPolicy,
      startupContract: fixture.startupContract,
      metricsContract,
      fixtures: fixture.fixtures,
      environment,
    },
    {
      readState: fixture.readState,
      collectProviderObservation: async () => fixture.observation,
      collectProducerOidc: async () => canonicalJsonBytes(oidcReceipt()),
      launchBrowser: async () => browser.browser,
      clock: () => NOW,
    },
  );
  return { ...collected, contextCounts: browser.contextCounts };
};

test("collects bootstrap recovery probes and reaggregates immutable authority", async () => {
  const fixture = await createStateFixture();
  const collected = await collectPositive(fixture);
  assert.deepEqual(collected.contextCounts, [1, 1, 1, 6]);
  assert.equal(collected.result.outcome, "succeeded");
  assert.equal(collected.result.falsePositiveCount, 0);
  assert.equal(collected.result.falseNegativeCount, 0);
  assert.equal(collected.result.deploymentId, "dpl_bootstrap");
  assert.equal(collected.authority.sourceSha, SOURCE_SHA);
  assert.equal(collected.authority.binding.sourceSha, BOOTSTRAP_SOURCE_SHA);
  assert.notEqual(
    collected.authority.sourceSha,
    collected.authority.binding.sourceSha,
  );
  assert.equal(collected.result.overLimitProbe.rateLimitedRequestCount, 1);
  const readback = await readStartupWafObservationAuthority({
    store: fixture.store,
    namespace: NAMESPACE,
    reference: collected.reference,
    expectedSourceSha: SOURCE_SHA,
    providerPolicy,
    approvalPolicy,
    startupContract: fixture.startupContract,
    metricsContract,
    fixtures: fixture.fixtures,
    readState: fixture.readState,
  });
  assert.deepEqual(readback.result, collected.result);
  assert.equal(
    collected.authorityBytes.includes(Buffer.from(environment.VERCEL_TOKEN)),
    false,
  );
});

test("resolves the initialized bootstrap binding after prior phase attestations", async () => {
  const fixture = await createStateFixture({ postInitialization: true });
  const resolution = await resolveStartupWafBinding(
    {
      store: fixture.store,
      namespace: NAMESPACE,
      sourceSha: SOURCE_SHA,
      providerPolicy,
    },
    { readState: fixture.readState },
  );
  assert.equal(resolution.binding.bindingId, "binding-bootstrap-recovery");
  assert.equal(
    resolution.initialization.bootstrapInitializedEvent.sha256,
    "f".repeat(64),
  );
});

test("rejects a caller source and pending standard substitution", async () => {
  const fixture = await createStateFixture({ postInitialization: true });
  await assert.rejects(
    resolveStartupWafBinding(
      {
        store: fixture.store,
        namespace: NAMESPACE,
        sourceSha: "b".repeat(40),
        providerPolicy,
      },
      { readState: fixture.readState },
    ),
    /state-initialized binding/u,
  );
  fixture.current.snapshot.pendingOperation = {
    operationId: "old-operation",
    targetBinding: {
      ...fixture.binding,
      bindingId: "binding-old",
      sourceSha: "b".repeat(40),
      buildId: "b".repeat(40),
      releaseRole: "standard",
      publicIdentityKind: "release-identity-v1",
    },
  };
  await assert.rejects(
    resolveStartupWafBinding(
      {
        store: fixture.store,
        namespace: NAMESPACE,
        sourceSha: SOURCE_SHA,
        providerPolicy,
      },
      { readState: fixture.readState },
    ),
    /without managed production/u,
  );
});

test("rejects bootstrap source substitution independently from the executor", async () => {
  const fixture = await createStateFixture({ postInitialization: true });
  fixture.current.snapshot.bootstrapRecovery = {
    ...structuredClone(fixture.binding),
    sourceSha: "c".repeat(40),
    buildId: "c".repeat(40),
  };
  await assert.rejects(
    resolveStartupWafBinding(
      {
        store: fixture.store,
        namespace: NAMESPACE,
        sourceSha: SOURCE_SHA,
        providerPolicy,
      },
      { readState: fixture.readState },
    ),
    /provider evidence|state-initialized binding/u,
  );
});

test("rejects managed-production and bootstrap containment misuse", async () => {
  const managed = await createStateFixture();
  managed.current.snapshot.activeProduction = structuredClone(managed.binding);
  await assert.rejects(
    resolveStartupWafBinding(
      {
        store: managed.store,
        namespace: NAMESPACE,
        sourceSha: SOURCE_SHA,
        providerPolicy,
      },
      { readState: managed.readState },
    ),
    /without managed production/u,
  );

  const standard = await createStateFixture();
  standard.current.snapshot.bootstrapRecovery.releaseRole = "standard";
  standard.current.snapshot.bootstrapRecovery.publicIdentityKind =
    "release-identity-v1";
  await assert.rejects(
    resolveStartupWafBinding(
      {
        store: standard.store,
        namespace: NAMESPACE,
        sourceSha: SOURCE_SHA,
        providerPolicy,
      },
      { readState: standard.readState },
    ),
    /role is invalid/u,
  );
});

test("rejects fresh provider drift from the live binding", async () => {
  const fixture = await createStateFixture();
  fixture.observation = {
    ...fixture.observation,
    wafRules: {
      ...fixture.observation.wafRules,
      metricsRoute: {
        ...fixture.observation.wafRules.metricsRoute,
        rateLimit: {
          ...fixture.observation.wafRules.metricsRoute.rateLimit,
          limit: 6,
        },
      },
    },
  };
  await assert.rejects(collectPositive(fixture), /configuration drifted/u);
});

test("rejects startup contract profile drift", async () => {
  const fixture = await createStateFixture();
  fixture.startupContract.profiles[0].id = "caller-profile";
  await assert.rejects(collectPositive(fixture), /profile differs/u);
});

test("rejects an over-limit probe with no 429", async () => {
  const fixture = await createStateFixture();
  await assert.rejects(
    collectPositive(fixture, {
      overLimitStatuses: [202, 202, 202, 202, 202, 202],
    }),
    /falseNegative=[1-9]/u,
  );
});

test("rejects a normal-profile 429 as a false positive", async () => {
  const fixture = await createStateFixture();
  await assert.rejects(
    collectPositive(fixture, { normalStatus: 429 }),
    /falsePositive=3/u,
  );
});

test("rejects immutable tamper and media substitution", async () => {
  const fixture = await createStateFixture();
  const collected = await collectPositive(fixture);
  const stored = fixture.store.objects.get(collected.reference.sha256);
  stored.bytes = Buffer.from(stored.bytes);
  stored.bytes[0] ^= 1;
  await assert.rejects(
    readStartupWafObservationAuthority({
      store: fixture.store,
      namespace: NAMESPACE,
      reference: collected.reference,
      expectedSourceSha: SOURCE_SHA,
      providerPolicy,
      approvalPolicy,
      startupContract: fixture.startupContract,
      metricsContract,
      fixtures: fixture.fixtures,
      readState: fixture.readState,
    }),
    /immutable/u,
  );
  stored.bytes = collected.authorityBytes;
  stored.mediaType = "application/json";
  await assert.rejects(
    readStartupWafObservationAuthority({
      store: fixture.store,
      namespace: NAMESPACE,
      reference: collected.reference,
      expectedSourceSha: SOURCE_SHA,
      providerPolicy,
      approvalPolicy,
      startupContract: fixture.startupContract,
      metricsContract,
      fixtures: fixture.fixtures,
      readState: fixture.readState,
    }),
    /immutable readback differs/u,
  );
});

test("rejects a forged immutable-store receipt", async () => {
  const fixture = await createStateFixture();
  fixture.store.badReceipt = true;
  await assert.rejects(collectPositive(fixture), /readback differs/u);
});

test("rejects OIDC receipts with an extra property", async () => {
  const fixture = await createStateFixture();
  await assert.rejects(
    collectAndStoreStartupWafObservation(
      {
        store: fixture.store,
        namespace: NAMESPACE,
        sourceSha: SOURCE_SHA,
        providerPolicy,
        approvalPolicy,
        startupContract: fixture.startupContract,
        metricsContract,
        fixtures: fixture.fixtures,
        environment,
      },
      {
        readState: fixture.readState,
        collectProviderObservation: async () => fixture.observation,
        collectProducerOidc: async () =>
          canonicalJsonBytes(oidcReceipt({ extra: { callerStatus: true } })),
        launchBrowser: async () => createBrowser().browser,
        clock: () => NOW,
      },
    ),
    /Stored GitHub OIDC receipt differs/u,
  );
});

test("rejects authority and transcript extra properties before aggregation", async () => {
  const fixture = await createStateFixture();
  const collected = await collectPositive(fixture);
  assert.throws(
    () =>
      aggregateStartupWafTranscript({
        transcript: { ...collected.transcript, callerOutcome: true },
        providerPolicy,
        providerObservation: fixture.observation,
        expectedProfiles: collected.transcript.profiles.map((profile) => ({
          id: profile.id,
          fixtureSha256: profile.fixtureSha256,
          expectedRequestCount: profile.expectedRequestCount,
          payloadEvents: Array.from(
            { length: profile.expectedRequestCount },
            () => ({
              name: "startup",
              outcome:
                profile.id === "recovery-candidate"
                  ? "recovery-required"
                  : "ready",
            }),
          ),
        })),
      }),
    /unknown or missing fields/u,
  );
  const authority = {
    ...collected.authority,
    callerStatus: "accepted",
  };
  const replacementBytes = canonicalJsonBytes(authority);
  const replacementReference = await putFixtureObject(
    fixture.store,
    authority,
    STARTUP_WAF_OBSERVATION_MEDIA_TYPE,
  );
  assert.equal(replacementReference.sha256, sha256Bytes(replacementBytes));
  await assert.rejects(
    readStartupWafObservationAuthority({
      store: fixture.store,
      namespace: NAMESPACE,
      reference: replacementReference,
      expectedSourceSha: SOURCE_SHA,
      providerPolicy,
      approvalPolicy,
      startupContract: fixture.startupContract,
      metricsContract,
      fixtures: fixture.fixtures,
      readState: fixture.readState,
    }),
    /unknown or missing fields/u,
  );
});

test("CLI accepts only namespace/source/output and emits reference-only canonical output", async () => {
  assert.deepEqual(
    parseStartupWafObservationArguments([
      "--namespace",
      NAMESPACE,
      "--source-sha",
      SOURCE_SHA,
      "--output",
      "authority.json",
    ]),
    {
      "--namespace": NAMESPACE,
      "--source-sha": SOURCE_SHA,
      "--output": "authority.json",
    },
  );
  assert.throws(
    () =>
      parseStartupWafObservationArguments([
        "--namespace",
        NAMESPACE,
        "--source-sha",
        SOURCE_SHA,
        "--output",
        "authority.json",
        "--url",
        "https://caller.test",
      ]),
    /Usage/u,
  );
  const store = {
    closeCalled: false,
    async close() {
      this.closeCalled = true;
    },
  };
  let written;
  const reference = arbitraryReference("a");
  const transcript = arbitraryReference("b");
  const result = await runStartupWafObservationCli(
    {
      argv: [
        "--namespace",
        NAMESPACE,
        "--source-sha",
        SOURCE_SHA,
        "--output",
        "authority.json",
      ],
      env: {
        GITHUB_RUN_ID: RUN_ID,
        GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
        REQUESTED_OPERATION: STARTUP_WAF_OPERATION,
        RELEASE_STATE_DATABASE_URL:
          "postgresql://executor:password@db.example.test/postgres?sslmode=verify-full",
        RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
      },
      cwd: "C:\\fixture",
      stdout: { write() {} },
    },
    {
      root: "C:\\repo",
      loadJson: async (filePath) => {
        if (filePath.endsWith("approval-policy.json")) return approvalPolicy;
        if (filePath.endsWith("release-state-store.json")) {
          return { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" };
        }
        if (filePath.endsWith("provider-policy.json")) return providerPolicy;
        if (filePath.endsWith("persistence-release-a-startup-bursts-v1.json")) {
          return configuredStartupContract();
        }
        return metricsContract;
      },
      loadFixtures: async () => new Map(),
      assertEnvironment: () => undefined,
      createStore: async () => store,
      collect: async (options) => {
        assert.equal(options.namespace, NAMESPACE);
        return { reference, transcriptReference: transcript };
      },
      launchBrowser: async () => {
        throw new Error("CLI dependency was not forwarded into fake collect");
      },
      writeResult: async (filePath, bytes) => {
        written = { filePath, bytes };
      },
    },
  );
  assert.equal(result.authority.sha256, reference.sha256);
  assert.equal(result.transcript.sha256, transcript.sha256);
  assert.deepEqual(parseJsonStrict(written.bytes.toString("utf8")), result);
  assert.equal(store.closeCalled, true);
});

test("create-only output uses an exact descriptor and refuses overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "startup-waf-"));
  const output = path.join(directory, "authority.json");
  const bytes = canonicalJsonBytes({ safe: true });
  try {
    await writeStartupWafResultCreateOnly(output, bytes);
    assert.deepEqual(await readFile(output), bytes);
    await assert.rejects(
      writeStartupWafResultCreateOnly(output, bytes),
      /EEXIST/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
