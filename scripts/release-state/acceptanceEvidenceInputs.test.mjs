import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  COMPANION_RECOVERY_SOURCE_KIND,
  CONTINUOUS_CHAIN_AUTHORITY_MEDIA_TYPE,
  CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
  CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE,
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  RELEASE_A_AUTHORITY_BUNDLE_MEDIA_TYPE,
  RELEASE_A_AUTHORITY_RECEIPT_MEDIA_TYPE,
  RELEASE_A_AUTHORITY_SOURCE_KIND,
  collectReleaseAEvidenceAuthority,
  collectContinuousProductionSample,
  initializeContinuousProbeCollection,
  produceReleaseAEvidenceAuthorityBundle,
} from "./acceptanceEvidenceAuthority.mjs";
import {
  produceCompanionRecoveryDrill,
  produceContinuousProductionProbe,
  validateCompanionRecoveryDrill,
  validateContinuousProductionProbe,
} from "./acceptanceEvidenceInputs.mjs";
import {
  assertCompanionRecoveryEvidenceSchema,
  assertCompanionRecoverySourceSchema,
  assertContinuousProbeEvidenceSchema,
  assertContinuousProbeSourceSchema,
} from "./acceptanceEvidenceSchemas.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "./reviewedWorkflowRunAuthority.mjs";

const namespace = "acceptance-input-test";
const sourceSha = "a".repeat(40);
const operationId = "acceptance-input-operation";
const startedAt = "2026-08-06T00:00:00.000Z";
const endedAt = "2026-08-06T00:10:00.000Z";
const nowMilliseconds = Date.parse(endedAt);
const domains = ["a.example.test", "b.example.test"];

const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});
const eventReference = (sequence, sha256) => ({
  uri: `release-state://${namespace}/events/${sequence}/${sha256}`,
  sha256,
});
const binding = (role, suffix) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: suffix.repeat(64),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${role}-${suffix}`,
  deploymentUrl: `https://${role}-${suffix}.example.test`,
  artifactArchive: reference(
    role === "standard" ? "9".repeat(64) : "a".repeat(64),
  ),
  artifactArchiveAvailability: reference(
    role === "standard" ? "b".repeat(64) : "c".repeat(64),
  ),
  packageIndex: reference("1".repeat(64)),
  artifactManifest: reference(
    role === "standard" ? "2".repeat(64) : "3".repeat(64),
  ),
  providerEvidence: reference(
    role === "standard" ? "4".repeat(64) : "5".repeat(64),
  ),
  releasePolicy: reference("6".repeat(64)),
  providerPolicy: reference("d".repeat(64)),
  providerConfigurationHash: "e".repeat(64),
  requiredDbCompatibility: {
    contractUri: "urn:test:db:v1",
    fingerprint: "f".repeat(64),
  },
});

const observationEventHash = "8".repeat(64);
const pendingAcceptance = {
  operationId,
  standardBinding: binding("standard", "a"),
  companionBinding: binding("containment", "b"),
  assignmentValidationEvidence: reference("7".repeat(64)),
  observationStartedEvent: eventReference(5, observationEventHash),
  observationNotBefore: startedAt,
  minimumObservationEndsAt: endedAt,
};
const releaseAEvidence = {
  release: { releaseId: operationId, commitSha: sourceSha },
  canary: { buildSha: sourceSha, startedAt, endedAt },
  automatedGates: {
    rollback: {
      status: "PASS",
      command: "npm run test:release-a-rollback",
      commitSha: sourceSha,
      completedAt: endedAt,
      evidenceRef: "artifact://release-a/companion-recovery",
    },
  },
};
const releaseAEvidenceBytes = canonicalJsonBytes(releaseAEvidence);
const releaseAEvidenceSha256 = sha256Bytes(releaseAEvidenceBytes);
const providerPolicy = {
  bindingStatus: "configured",
  expectedProjectId: "project-test",
  expectedTeamId: "team-test",
  ownedProductionDomains: domains,
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.test/",
    maxFutureClockSkewSeconds: 30,
    maxResponseAgeSeconds: 300,
  },
};
const approvalPolicy = { repository: "owner/repository" };

class MemoryStore {
  constructor() {
    this.namespace = namespace;
    this.evidence = new Map();
    this.acceptanceChains = new Map();
    this.commitAt = startedAt;
    this.failAtomicAppendAfterSample = false;
  }

  async putEvidence({ bytes, mediaType }) {
    const objectBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(objectBytes);
    const existing = this.evidence.get(sha256);
    if (
      existing &&
      (!existing.bytes.equals(objectBytes) || existing.mediaType !== mediaType)
    ) {
      throw new Error("fixture evidence collision");
    }
    if (!existing) {
      this.evidence.set(sha256, {
        bytes: objectBytes,
        mediaType,
        committedAt: this.commitAt,
      });
    }
    const stored = this.evidence.get(sha256);
    return {
      ...reference(sha256),
      mediaType: stored.mediaType,
      byteLength: stored.bytes.length,
      committedAt: stored.committedAt,
      replayed: Boolean(existing),
    };
  }

  async readEvidence({ sha256 }) {
    const stored = this.evidence.get(sha256);
    return stored
      ? {
          bytes: Buffer.from(stored.bytes),
          mediaType: stored.mediaType,
          committedAt: stored.committedAt,
        }
      : null;
  }

  async appendAcceptanceSample({
    operationId,
    sourceSha: expectedSourceSha,
    bindingId,
    expectedPreviousCommit,
    expectedSequence,
    sampleBytes,
    sampleMediaType,
    commitBytes,
    commitMediaType,
  }) {
    const chainKey = `${operationId}\n${expectedSourceSha}\n${bindingId}`;
    const head = this.acceptanceChains.get(chainKey) ?? null;
    const sampleObjectBytes = Buffer.from(sampleBytes);
    const commitObjectBytes = Buffer.from(commitBytes);
    const sampleSha256 = sha256Bytes(sampleObjectBytes);
    const commitSha256 = sha256Bytes(commitObjectBytes);
    const asReceipt = (sha256, stored, replayed) => ({
      ...reference(sha256),
      mediaType: stored.mediaType,
      byteLength: stored.bytes.length,
      committedAt: stored.committedAt,
      replayed,
    });
    if (
      head?.sequence === expectedSequence + 1 &&
      head.head.sha256 === commitSha256
    ) {
      const storedSample = this.evidence.get(sampleSha256);
      const storedCommit = this.evidence.get(commitSha256);
      if (
        !storedSample?.bytes.equals(sampleObjectBytes) ||
        storedSample.mediaType !== sampleMediaType ||
        !storedCommit?.bytes.equals(commitObjectBytes) ||
        storedCommit.mediaType !== commitMediaType ||
        storedSample.committedAt !== storedCommit.committedAt
      ) {
        throw new Error("fixture acceptance replay differs");
      }
      return {
        sample: asReceipt(sampleSha256, storedSample, true),
        commit: asReceipt(commitSha256, storedCommit, true),
      };
    }
    if (
      (head?.sequence ?? 0) !== expectedSequence ||
      (head === null
        ? expectedPreviousCommit !== null
        : head.head.sha256 !== expectedPreviousCommit?.sha256 ||
          head.head.uri !== expectedPreviousCommit?.uri)
    ) {
      throw new Error("fixture acceptance chain CAS conflict");
    }
    if (this.evidence.has(sampleSha256) || this.evidence.has(commitSha256)) {
      throw new Error("fixture acceptance objects predate atomic append");
    }
    const evidenceSnapshot = new Map(this.evidence);
    const chainsSnapshot = new Map(this.acceptanceChains);
    try {
      const storedSample = {
        bytes: sampleObjectBytes,
        mediaType: sampleMediaType,
        committedAt: this.commitAt,
      };
      const storedCommit = {
        bytes: commitObjectBytes,
        mediaType: commitMediaType,
        committedAt: this.commitAt,
      };
      this.evidence.set(sampleSha256, storedSample);
      if (this.failAtomicAppendAfterSample) {
        this.failAtomicAppendAfterSample = false;
        throw new Error("fixture acceptance atomic failure");
      }
      this.evidence.set(commitSha256, storedCommit);
      const commit = asReceipt(commitSha256, storedCommit, false);
      this.acceptanceChains.set(chainKey, {
        sequence: expectedSequence + 1,
        head: { uri: commit.uri, sha256: commit.sha256 },
        updatedAt: commit.committedAt,
      });
      return {
        sample: asReceipt(sampleSha256, storedSample, false),
        commit,
      };
    } catch (error) {
      this.evidence = evidenceSnapshot;
      this.acceptanceChains = chainsSnapshot;
      throw error;
    }
  }

  async readAcceptanceEvidenceChain({ operationId, sourceSha, bindingId }) {
    const value = this.acceptanceChains.get(
      `${operationId}\n${sourceSha}\n${bindingId}`,
    );
    return value ? structuredClone(value) : null;
  }
}

const putJson = async (store, value, mediaType = "application/json") => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putWorkflowRunAuthority = async (store, runId = "400") => {
  const apiResponse = await putJson(
    store,
    {
      id: Number(runId),
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: approvalPolicy.repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  return putJson(
    store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository: approvalPolicy.repository,
      runId,
      runAttempt: "1",
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
};

const putCollectorIdentity = (
  store,
  {
    runId = "100",
    jti = `fixture-jti-${runId}`,
    transform = (value) => value,
  } = {},
) => {
  const verifiedAt = store.commitAt;
  const expiresAt = new Date(
    Date.parse(verifiedAt) + 15 * 60 * 1000,
  ).toISOString();
  return putJson(
    store,
    transform({
      schemaVersion: 1,
      kind: "github-actions-oidc-verification/v1",
      issuer: "https://token.actions.githubusercontent.com",
      audience: "release-state",
      subject: "repo:owner/repository:environment:production-release",
      tokenSha256: "0".repeat(64),
      signingKey: { kid: "test", jwkThumbprintSha256: "1".repeat(64) },
      claims: {
        repository: "owner/repository",
        workflowRef:
          "owner/repository/.github/workflows/release.yml@refs/heads/main",
        workflowSha: sourceSha,
        environment: "production-release",
        runId,
        runAttempt: "1",
        sourceSha,
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        refProtected: true,
        jti,
        issuedAt: verifiedAt,
        notBefore: verifiedAt,
        expiresAt,
      },
      verifiedAt,
    }),
    GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  );
};

const response = ({
  url,
  bytes,
  date,
  status = 200,
  responseUrl = url,
  redirected = false,
}) => ({
  status,
  url: responseUrl,
  redirected,
  headers: {
    get(name) {
      const key = name.toLowerCase();
      if (key === "content-length") return String(bytes.length);
      if (key === "content-type") return "application/json; charset=utf-8";
      if (key === "date") return new Date(date).toUTCString();
      return null;
    },
  },
  arrayBuffer: async () => bytes,
});

const buildContinuousFixture = async () => {
  const store = new MemoryStore();
  const sourceWorkflowAuthority = await putWorkflowRunAuthority(store);
  const collectorIdentity = await putCollectorIdentity(store);
  let source = (
    await initializeContinuousProbeCollection({
      store,
      namespace,
      pendingAcceptance,
      collectorIdentity,
    })
  ).source;
  for (let index = 0; index < 3; index += 1) {
    const observedAt = new Date(
      Date.parse(startedAt) + index * 5 * 60 * 1000,
    ).toISOString();
    store.commitAt = observedAt;
    const sampleCollectorIdentity = await putCollectorIdentity(store, {
      runId: String(200 + index),
    });
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const isProvider = parsed.hostname === "api.vercel.test";
      const productionDomain = isProvider
        ? decodeURIComponent(parsed.pathname.split("/").at(-1))
        : parsed.hostname;
      const bytes = isProvider
        ? canonicalJsonBytes({
            alias: productionDomain,
            projectId: pendingAcceptance.standardBinding.providerProjectId,
            deploymentId:
              pendingAcceptance.standardBinding.providerDeploymentId,
            redirect: null,
          })
        : canonicalJsonBytes({
            schemaVersion: 1,
            sourceSha,
            buildId: sourceSha,
            variantId: pendingAcceptance.standardBinding.variantId,
            releaseRole: "standard",
          });
      return response({ url, bytes, date: observedAt });
    };
    source = (
      await collectContinuousProductionSample({
        store,
        namespace,
        pendingAcceptance,
        providerPolicy,
        providerToken: "provider-token-test",
        collectorIdentity: sampleCollectorIdentity,
        priorSource: source,
        fetchImpl,
        clock: () => Date.parse(observedAt),
      })
    ).source;
  }
  const finalCollectorIdentity = await putCollectorIdentity(store, {
    runId: "300",
  });
  const evidenceUrl = "https://observability.example.test/release-a.json";
  const finalized = await collectReleaseAEvidenceAuthority({
    store,
    current: { records: [] },
    namespace,
    pendingAcceptance,
    providerPolicy,
    evidenceUrl,
    evidenceToken: "observability-token-test",
    collectorIdentity: finalCollectorIdentity,
    continuousSource: source,
    validateEvidence: () => [],
    fetchImpl: async (url) =>
      response({ url, bytes: releaseAEvidenceBytes, date: endedAt }),
    clock: () => nowMilliseconds,
  });
  return {
    store,
    current: { records: [] },
    source: finalized.continuousSource,
    sourceWorkflowAuthority,
    approvalPolicy,
  };
};

test("produces and revalidates a store-backed all-domain probe chain", async () => {
  const fixture = await buildContinuousFixture();
  const sourceBytes = canonicalJsonBytes(fixture.source);
  const produced = await produceContinuousProductionProbe({
    ...fixture,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    providerPolicy,
    nowMilliseconds,
  });
  assert.equal(produced.evidence.sampleCount, 3);
  assert.deepEqual(
    await validateContinuousProductionProbe({
      store: fixture.store,
      current: fixture.current,
      bytes: produced.evidenceBytes,
      expectedSha256: produced.sha256,
      namespace,
      pendingAcceptance,
      releaseAEvidence,
      releaseAEvidenceSha256,
      providerPolicy,
      nowMilliseconds,
    }),
    produced.evidence,
  );
});

test("continuous evidence rejects a missing finalized-source workflow authority", async () => {
  const fixture = await buildContinuousFixture();
  const sourceBytes = canonicalJsonBytes(fixture.source);
  const produced = await produceContinuousProductionProbe({
    ...fixture,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    providerPolicy,
    nowMilliseconds,
  });
  fixture.store.evidence.delete(fixture.sourceWorkflowAuthority.sha256);
  await assert.rejects(
    validateContinuousProductionProbe({
      store: fixture.store,
      current: fixture.current,
      bytes: produced.evidenceBytes,
      expectedSha256: produced.sha256,
      namespace,
      pendingAcceptance,
      releaseAEvidence,
      releaseAEvidenceSha256,
      providerPolicy,
      approvalPolicy,
      nowMilliseconds,
    }),
    /workflow run receipt is absent/,
  );
});

test("rejects missing raw receipts and a non-authoritative v1 source", async () => {
  const fixture = await buildContinuousFixture();
  const sourceBytes = canonicalJsonBytes(fixture.source);
  const produced = await produceContinuousProductionProbe({
    ...fixture,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    providerPolicy,
    nowMilliseconds,
  });
  const sample = produced.evidence.samples[1];
  fixture.store.evidence.delete(sample.results[0].httpReceipt.sha256);
  await assert.rejects(
    validateContinuousProductionProbe({
      store: fixture.store,
      current: fixture.current,
      bytes: produced.evidenceBytes,
      expectedSha256: produced.sha256,
      namespace,
      pendingAcceptance,
      releaseAEvidence,
      releaseAEvidenceSha256,
      providerPolicy,
      nowMilliseconds,
    }),
    /missing or differs/,
  );

  const selfReported = canonicalJsonBytes({
    schemaVersion: 1,
    sourceKind: "continuous-production-probe-source/v1",
    samples: [],
  });
  await assert.rejects(
    produceContinuousProductionProbe({
      store: fixture.store,
      current: fixture.current,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes: selfReported,
      expectedSourceSha256: sha256Bytes(selfReported),
      providerPolicy,
      nowMilliseconds,
    }),
    /source (?:identity is invalid|has unknown or missing fields|v2 schema mismatch)/,
  );
});

test("continuous collector rejects OIDC, provider, and HTTP transaction drift", async (t) => {
  const oidcCases = [
    [
      "source claim",
      (receipt) => ({
        ...receipt,
        claims: { ...receipt.claims, sourceSha: "b".repeat(40) },
      }),
    ],
    [
      "workflow SHA",
      (receipt) => ({
        ...receipt,
        claims: { ...receipt.claims, workflowSha: "b".repeat(40) },
      }),
    ],
    [
      "protected ref",
      (receipt) => ({
        ...receipt,
        claims: { ...receipt.claims, refProtected: false },
      }),
    ],
    [
      "run identity",
      (receipt) => ({
        ...receipt,
        claims: { ...receipt.claims, runId: "0" },
      }),
    ],
  ];
  for (const [label, transform] of oidcCases) {
    await t.test(`OIDC ${label}`, async () => {
      const store = new MemoryStore();
      const collectorIdentity = await putCollectorIdentity(store, {
        transform,
      });
      await assert.rejects(
        initializeContinuousProbeCollection({
          store,
          namespace,
          pendingAcceptance,
          collectorIdentity,
        }),
        /OIDC identity is not protected/,
      );
    });
  }

  const transactionCases = [
    [
      "provider alias",
      ({ kind, body }) =>
        kind === "provider" ? { body: { ...body, alias: "other.test" } } : {},
      /Provider alias response identity differs/,
    ],
    [
      "provider project",
      ({ kind, body }) =>
        kind === "provider" ? { body: { ...body, projectId: "other" } } : {},
      /Provider alias response identity differs/,
    ],
    [
      "provider deployment",
      ({ kind, body }) =>
        kind === "provider" ? { body: { ...body, deploymentId: "other" } } : {},
      /pending deployment/,
    ],
    [
      "provider status",
      ({ kind }) => (kind === "provider" ? { status: 503 } : {}),
      /pending deployment/,
    ],
    [
      "provider redirect",
      ({ kind }) => (kind === "provider" ? { redirected: true } : {}),
      /invalid or redirected/,
    ],
    [
      "public status",
      ({ kind }) => (kind === "public" ? { status: 503 } : {}),
      /did not pass/,
    ],
    [
      "public redirect",
      ({ kind }) => (kind === "public" ? { redirected: true } : {}),
      /invalid or redirected/,
    ],
    [
      "public body",
      ({ kind, body }) =>
        kind === "public"
          ? { body: { ...body, sourceSha: "b".repeat(40) } }
          : {},
      /identity differs/,
    ],
    [
      "response URL",
      ({ kind }) =>
        kind === "public"
          ? { responseUrl: "https://redirect.example.test/identity.json" }
          : {},
      /response URL differs/,
    ],
  ];
  for (const [label, mutate, expectedError] of transactionCases) {
    await t.test(label, async () => {
      const store = new MemoryStore();
      const authorityIdentity = await putCollectorIdentity(store);
      const source = (
        await initializeContinuousProbeCollection({
          store,
          namespace,
          pendingAcceptance,
          collectorIdentity: authorityIdentity,
        })
      ).source;
      store.commitAt = startedAt;
      const sampleIdentity = await putCollectorIdentity(store, {
        runId: "200",
      });
      const fetchImpl = async (url) => {
        const parsed = new URL(url);
        const kind =
          parsed.hostname === "api.vercel.test" ? "provider" : "public";
        const productionDomain =
          kind === "provider"
            ? decodeURIComponent(parsed.pathname.split("/").at(-1))
            : parsed.hostname;
        const body =
          kind === "provider"
            ? {
                alias: productionDomain,
                projectId: pendingAcceptance.standardBinding.providerProjectId,
                deploymentId:
                  pendingAcceptance.standardBinding.providerDeploymentId,
                redirect: null,
              }
            : {
                schemaVersion: 1,
                sourceSha,
                buildId: sourceSha,
                variantId: pendingAcceptance.standardBinding.variantId,
                releaseRole: "standard",
              };
        const changed = mutate({ kind, body, productionDomain });
        return response({
          url,
          bytes: canonicalJsonBytes(changed.body ?? body),
          date: startedAt,
          status: changed.status,
          responseUrl: changed.responseUrl,
          redirected: changed.redirected,
        });
      };
      await assert.rejects(
        collectContinuousProductionSample({
          store,
          namespace,
          pendingAcceptance,
          providerPolicy,
          providerToken: "provider-token-test",
          collectorIdentity: sampleIdentity,
          priorSource: source,
          fetchImpl,
          clock: () => Date.parse(startedAt),
        }),
        expectedError,
      );
    });
  }
});

test("continuous source rejects operation, binding, domain, and collector-run drift", async (t) => {
  const cases = [
    [
      "operation",
      (value) => ({ ...value, operationId: "other-operation" }),
      providerPolicy,
    ],
    [
      "binding",
      (value) => ({
        ...value,
        standardBinding: {
          ...value.standardBinding,
          bindingId: "other-binding",
        },
      }),
      providerPolicy,
    ],
    [
      "domain set",
      (value) => value,
      { ...providerPolicy, ownedProductionDomains: [domains[0]] },
    ],
  ];
  for (const [label, changePending, changedPolicy] of cases) {
    await t.test(label, async () => {
      const fixture = await buildContinuousFixture();
      const sourceBytes = canonicalJsonBytes(fixture.source);
      await assert.rejects(
        produceContinuousProductionProbe({
          ...fixture,
          namespace,
          pendingAcceptance: changePending(structuredClone(pendingAcceptance)),
          releaseAEvidenceBytes,
          expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
          sourceBytes,
          expectedSourceSha256: sha256Bytes(sourceBytes),
          providerPolicy: changedPolicy,
          nowMilliseconds,
        }),
        /differs|binding|domain|authority/,
      );
    });
  }

  await t.test("reused protected run", async () => {
    const fixture = await buildContinuousFixture();
    const chainAuthoritySha256 = [...fixture.store.evidence.entries()].find(
      ([, stored]) =>
        stored.mediaType === CONTINUOUS_CHAIN_AUTHORITY_MEDIA_TYPE,
    )?.[0];
    assert.ok(chainAuthoritySha256);
    fixture.store.commitAt = endedAt;
    const repeatedIdentity = await putCollectorIdentity(fixture.store, {
      runId: "202",
      jti: "fixture-jti-202-new-reference",
    });
    await assert.rejects(
      collectContinuousProductionSample({
        store: fixture.store,
        namespace,
        pendingAcceptance,
        providerPolicy,
        providerToken: "provider-token-test",
        collectorIdentity: repeatedIdentity,
        priorSource: {
          ...fixture.source,
          authorityBundle: reference(chainAuthoritySha256),
        },
        fetchImpl: async () => {
          throw new Error("fetch must not run");
        },
        clock: () => nowMilliseconds,
      }),
      /distinct protected run/,
    );
  });
});

test("Release A authority rejects media, bytes, path, assertion, and set drift", async (t) => {
  const produceFrom = async (fixture) => {
    const sourceBytes = canonicalJsonBytes(fixture.source);
    return produceContinuousProductionProbe({
      ...fixture,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes,
      expectedSourceSha256: sha256Bytes(sourceBytes),
      providerPolicy,
      nowMilliseconds,
    });
  };
  const authorityObjects = (fixture) => {
    const bundleStored = fixture.store.evidence.get(
      fixture.source.authorityBundle.sha256,
    );
    const bundle = JSON.parse(bundleStored.bytes.toString("utf8"));
    const receiptReference = bundle.receipts[0];
    const receiptStored = fixture.store.evidence.get(receiptReference.sha256);
    const receipt = JSON.parse(receiptStored.bytes.toString("utf8"));
    return { bundle, bundleStored, receipt, receiptReference, receiptStored };
  };
  const replaceAuthority = async ({ fixture, changeReceipt, changeBundle }) => {
    const { bundle, receipt } = authorityObjects(fixture);
    let receipts = bundle.receipts;
    if (changeReceipt) {
      const changedReceipt = changeReceipt(structuredClone(receipt));
      const changedReference = await putJson(
        fixture.store,
        changedReceipt,
        RELEASE_A_AUTHORITY_RECEIPT_MEDIA_TYPE,
      );
      receipts = [changedReference, ...bundle.receipts.slice(1)];
    }
    const changedBundle = changeBundle
      ? changeBundle({ ...structuredClone(bundle), receipts })
      : { ...structuredClone(bundle), receipts };
    fixture.source.authorityBundle = await putJson(
      fixture.store,
      changedBundle,
      RELEASE_A_AUTHORITY_BUNDLE_MEDIA_TYPE,
    );
  };
  const cases = [
    [
      "receipt media",
      async (fixture) => {
        authorityObjects(fixture).receiptStored.mediaType = "application/json";
      },
    ],
    [
      "receipt bytes",
      async (fixture) => {
        authorityObjects(fixture).receiptStored.bytes = canonicalJsonBytes({
          tampered: true,
        });
      },
    ],
    [
      "evidence path",
      (fixture) =>
        replaceAuthority({
          fixture,
          changeReceipt: (receipt) => ({
            ...receipt,
            evidencePath: "/unexpected/path",
          }),
        }),
    ],
    [
      "assertion hash",
      (fixture) =>
        replaceAuthority({
          fixture,
          changeReceipt: (receipt) => ({
            ...receipt,
            assertionSha256: "f".repeat(64),
          }),
        }),
    ],
    [
      "missing receipt",
      (fixture) =>
        replaceAuthority({
          fixture,
          changeBundle: (bundle) => ({ ...bundle, receipts: [] }),
        }),
    ],
    [
      "extra receipt",
      (fixture) =>
        replaceAuthority({
          fixture,
          changeBundle: (bundle) => ({
            ...bundle,
            receipts: [...bundle.receipts, bundle.receipts[0]],
          }),
        }),
    ],
    [
      "missing raw source",
      async (fixture) => {
        const { receipt } = authorityObjects(fixture);
        fixture.store.evidence.delete(receipt.sourceReference.sha256);
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const fixture = await buildContinuousFixture();
      await mutate(fixture);
      await assert.rejects(
        produceFrom(fixture),
        /authority|receipt|missing|differs|path/i,
      );
    });
  }
});

const putCompanionFixture = async () => {
  const store = new MemoryStore();
  const sourceWorkflowAuthority = await putWorkflowRunAuthority(store);
  const collectorIdentity = await putCollectorIdentity(store);
  const companion = pendingAcceptance.companionBinding;
  const assignmentReceipt = await putJson(
    store,
    {
      schemaVersion: 1,
      evidenceKind: "assignment-receipt",
      providerProjectId: companion.providerProjectId,
      assignmentApiReceiptSetHash: "2".repeat(64),
      assignments: domains.map((productionDomain) => ({
        productionDomain,
        previousDeploymentId: "previous-deployment",
        assignedDeploymentId: companion.providerDeploymentId,
      })),
    },
    "application/vnd.event-shopping-planner.provider-assignment-receipt+json;version=1",
  );
  const providerAssignmentObservation = await putJson(store, {
    schemaVersion: 1,
    observationKind: "provider-alias-observation/v1",
    namespace,
    providerProjectId: companion.providerProjectId,
    observedBinding: {
      bindingId: companion.bindingId,
      providerDeploymentId: companion.providerDeploymentId,
    },
    assignments: domains.map((productionDomain) => ({
      productionDomain,
      assignedDeploymentId: companion.providerDeploymentId,
    })),
    providerReceiptReferences: [],
  });
  const routeReceipt = {
    path: "/release-identity.json",
    requestUrl: "https://a.example.test/release-identity.json",
    responseUrl: "https://a.example.test/release-identity.json",
    status: 200,
    bodySha256: "3".repeat(64),
  };
  const probe = {
    schemaVersion: 1,
    evidenceKind: "production-assignment-probe/v1",
    providerProjectId: companion.providerProjectId,
    providerDeploymentId: companion.providerDeploymentId,
    providerDeploymentEvidenceHash: companion.providerEvidence.sha256,
    immutableRouteProbeEvidenceHash: "4".repeat(64),
    providerAssignmentObservation,
    observedAt: endedAt,
    immutableApiReceipts: [],
    results: domains.map((productionDomain) => {
      const receipts = [
        {
          ...routeReceipt,
          requestUrl: `https://${productionDomain}/release-identity.json`,
          responseUrl: `https://${productionDomain}/release-identity.json`,
        },
      ];
      return {
        productionDomain,
        providerDeploymentId: companion.providerDeploymentId,
        status: "PASS",
        responseSha256: sha256Json(receipts),
        receipts,
      };
    }),
  };
  const productionProbe = await putJson(
    store,
    probe,
    "application/vnd.event-shopping-planner.production-probe+json;version=1",
  );
  const assignmentValidation = await putJson(
    store,
    {
      schemaVersion: 1,
      evidenceKind: "assignment-validation",
      providerProjectId: companion.providerProjectId,
      assignmentReceiptUri: assignmentReceipt.uri,
      assignmentReceiptSha256: assignmentReceipt.sha256,
      assignments: domains.map((productionDomain) => ({
        productionDomain,
        previousDeploymentId: "previous-deployment",
        assignedDeploymentId: companion.providerDeploymentId,
      })),
      productionProbeEvidenceHash: productionProbe.sha256,
    },
    "application/vnd.event-shopping-planner.provider-assignment-validation+json;version=1",
  );
  const hashes = ["1", "2", "3", "4", "8", "9"].map((value) =>
    value.repeat(64),
  );
  const refs = hashes.map((hash, index) => eventReference(index + 1, hash));
  const records = [
    {
      sequence: 1,
      eventHash: hashes[0],
      committedAt: "2026-08-06T00:05:00.000Z",
      event: {
        eventType: "promotion-prepared",
        operationId: "independent-recovery",
        previousEventHash: "0".repeat(64),
        evidenceRefs: [],
        payload: {
          pendingOperation: {
            kind: "redeploy-containment",
            targetBinding: companion,
          },
        },
      },
    },
    {
      sequence: 2,
      eventHash: hashes[1],
      committedAt: "2026-08-06T00:06:00.000Z",
      event: {
        eventType: "deployment-assigned",
        operationId: "independent-recovery",
        previousEventHash: hashes[0],
        evidenceRefs: [refs[0]],
        payload: { targetBinding: companion },
      },
    },
    {
      sequence: 3,
      eventHash: hashes[2],
      committedAt: "2026-08-06T00:07:00.000Z",
      event: {
        eventType: "assignment-validated",
        operationId: "independent-recovery",
        previousEventHash: hashes[1],
        evidenceRefs: [refs[1]],
        payload: {
          targetBinding: companion,
          assignmentValidation,
          productionProbe,
        },
      },
    },
    {
      sequence: 4,
      eventHash: hashes[3],
      committedAt: endedAt,
      event: {
        eventType: "package-redeploy-activated",
        operationId: "independent-recovery",
        previousEventHash: hashes[2],
        evidenceRefs: [refs[2]],
        payload: { releaseRole: "containment", binding: companion },
      },
    },
    {
      sequence: 5,
      eventHash: hashes[4],
      committedAt: endedAt,
      event: {
        eventType: "assignment-validated",
        operationId,
        previousEventHash: hashes[3],
        evidenceRefs: [refs[3]],
        payload: {},
      },
    },
    {
      sequence: 6,
      eventHash: hashes[5],
      committedAt: endedAt,
      event: {
        eventType: "observation-started",
        operationId,
        previousEventHash: hashes[4],
        evidenceRefs: [refs[4]],
        payload: { pendingAcceptance },
      },
    },
  ];
  const current = { records };
  const authority = await produceReleaseAEvidenceAuthorityBundle({
    store,
    current,
    namespace,
    pendingAcceptance,
    releaseAEvidence,
    releaseAEvidenceSha256,
    collectorIdentity,
    source: {
      schemaVersion: 1,
      sourceKind: RELEASE_A_AUTHORITY_SOURCE_KIND,
      references: [
        {
          evidencePath: "/automatedGates/rollback/evidenceRef",
          originalReference:
            releaseAEvidence.automatedGates.rollback.evidenceRef,
          sourceReference: refs[3],
        },
      ],
    },
  });
  const source = {
    schemaVersion: 2,
    sourceKind: COMPANION_RECOVERY_SOURCE_KIND,
    authorityBundle: authority.reference,
    packageRedeployTerminalEvent: refs[3],
    standardReturnEvent: refs[5],
  };
  return { store, current, source, sourceWorkflowAuthority, approvalPolicy };
};

test("produces and revalidates a Release State companion recovery chain", async () => {
  const fixture = await putCompanionFixture();
  const sourceBytes = canonicalJsonBytes(fixture.source);
  const produced = await produceCompanionRecoveryDrill({
    ...fixture,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes,
    expectedSourceSha256: sha256Bytes(sourceBytes),
    nowMilliseconds,
    futureClockSkewSeconds: 30,
    providerPolicy,
  });
  assert.equal(
    produced.evidence.companion.providerDeploymentId,
    pendingAcceptance.companionBinding.providerDeploymentId,
  );
  assert.deepEqual(
    await validateCompanionRecoveryDrill({
      store: fixture.store,
      current: fixture.current,
      bytes: produced.evidenceBytes,
      expectedSha256: produced.sha256,
      namespace,
      pendingAcceptance,
      releaseAEvidence,
      releaseAEvidenceSha256,
      nowMilliseconds,
      futureClockSkewSeconds: 30,
      providerPolicy,
    }),
    produced.evidence,
  );
});

test("companion recovery rejects predecessor, order, target, probe, and terminal drift", async (t) => {
  const produceFrom = (fixture) => {
    const sourceBytes = canonicalJsonBytes(fixture.source);
    return produceCompanionRecoveryDrill({
      ...fixture,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes,
      expectedSourceSha256: sha256Bytes(sourceBytes),
      nowMilliseconds,
      futureClockSkewSeconds: 30,
      providerPolicy,
    });
  };
  const cases = [
    [
      "recovery predecessor",
      async (fixture) => {
        fixture.current.records[3].event.previousEventHash = "f".repeat(64);
      },
    ],
    [
      "standard-return order",
      async (fixture) => {
        fixture.source.standardReturnEvent = structuredClone(
          fixture.source.packageRedeployTerminalEvent,
        );
      },
    ],
    [
      "standard-return predecessor",
      async (fixture) => {
        fixture.current.records[4].event.eventType = "deployment-assigned";
      },
    ],
    [
      "companion target",
      async (fixture) => {
        fixture.current.records[3].event.payload.binding = {
          ...fixture.current.records[3].event.payload.binding,
          providerDeploymentId: "other-deployment",
        };
      },
    ],
    [
      "terminal event",
      async (fixture) => {
        fixture.current.records[3].event.eventType = "containment-activated";
      },
    ],
    [
      "terminal operation",
      async (fixture) => {
        fixture.current.records[3].event.operationId = operationId;
      },
    ],
    [
      "probe media",
      async (fixture) => {
        const reference =
          fixture.current.records[2].event.payload.productionProbe;
        fixture.store.evidence.get(reference.sha256).mediaType =
          "application/json";
      },
    ],
    [
      "probe status",
      async (fixture) => {
        const assignmentRecord = fixture.current.records[2];
        const oldProbeReference =
          assignmentRecord.event.payload.productionProbe;
        const oldProbe = JSON.parse(
          fixture.store.evidence
            .get(oldProbeReference.sha256)
            .bytes.toString("utf8"),
        );
        oldProbe.results[0].status = "FAIL";
        const productionProbe = await putJson(
          fixture.store,
          oldProbe,
          "application/vnd.event-shopping-planner.production-probe+json;version=1",
        );
        const oldValidationReference =
          assignmentRecord.event.payload.assignmentValidation;
        const validation = JSON.parse(
          fixture.store.evidence
            .get(oldValidationReference.sha256)
            .bytes.toString("utf8"),
        );
        validation.productionProbeEvidenceHash = productionProbe.sha256;
        const assignmentValidation = await putJson(
          fixture.store,
          validation,
          "application/vnd.event-shopping-planner.provider-assignment-validation+json;version=1",
        );
        assignmentRecord.event.payload.productionProbe = productionProbe;
        assignmentRecord.event.payload.assignmentValidation =
          assignmentValidation;
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const fixture = await putCompanionFixture();
      await mutate(fixture);
      await assert.rejects(
        produceFrom(fixture),
        /companion|predecessor|probe|terminal|missing|differs|pass|recovery/i,
      );
    });
  }
});

test("rejects artifact-only recovery sources and missing terminal events", async () => {
  const fixture = await putCompanionFixture();
  const selfReported = canonicalJsonBytes({
    schemaVersion: 1,
    sourceKind: "companion-recovery-drill-source/v1",
    status: "PASS",
    command: "npm run test:release-a-rollback",
    startedAt,
    completedAt: endedAt,
    drillEvidenceRef: "artifact://release-a/self-report",
    companion: {},
    steps: [],
  });
  await assert.rejects(
    produceCompanionRecoveryDrill({
      ...fixture,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes: selfReported,
      expectedSourceSha256: sha256Bytes(selfReported),
      nowMilliseconds,
      futureClockSkewSeconds: 30,
      providerPolicy,
    }),
    /source|keys/,
  );

  const missing = structuredClone(fixture.source);
  missing.packageRedeployTerminalEvent = eventReference(40, "9".repeat(64));
  const missingBytes = canonicalJsonBytes(missing);
  await assert.rejects(
    produceCompanionRecoveryDrill({
      ...fixture,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes: missingBytes,
      expectedSourceSha256: sha256Bytes(missingBytes),
      nowMilliseconds,
      futureClockSkewSeconds: 30,
      providerPolicy,
    }),
    /absent or ambiguous/,
  );
});

test("sample store timestamps remain the authoritative chain clock", async () => {
  const fixture = await buildContinuousFixture();
  const head = fixture.source.sampleChainHead;
  const headObject = fixture.store.evidence.get(head.sha256);
  assert.equal(headObject.mediaType, CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE);
  const headCommit = JSON.parse(headObject.bytes.toString("utf8"));
  const sampleObject = fixture.store.evidence.get(
    headCommit.sampleReference.sha256,
  );
  assert.equal(sampleObject.mediaType, CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE);
  sampleObject.committedAt = "2026-08-06T00:20:00.000Z";
  const sourceBytes = canonicalJsonBytes(fixture.source);
  await assert.rejects(
    produceContinuousProductionProbe({
      ...fixture,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes,
      expectedSourceSha256: sha256Bytes(sourceBytes),
      providerPolicy,
      nowMilliseconds: Date.parse("2026-08-06T00:20:00.000Z"),
    }),
    /duplicate, fork, gap, or regression/,
  );
});

test("continuous chain rejects duplicate samples and cycle aliases", async (t) => {
  const produceFrom = (fixture) => {
    const sourceBytes = canonicalJsonBytes(fixture.source);
    return produceContinuousProductionProbe({
      ...fixture,
      namespace,
      pendingAcceptance,
      releaseAEvidenceBytes,
      expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
      sourceBytes,
      expectedSourceSha256: sha256Bytes(sourceBytes),
      providerPolicy,
      nowMilliseconds,
    });
  };

  await t.test("duplicate immutable sample", async () => {
    const fixture = await buildContinuousFixture();
    const priorHead = structuredClone(fixture.source.sampleChainHead);
    const priorCommit = JSON.parse(
      fixture.store.evidence.get(priorHead.sha256).bytes.toString("utf8"),
    );
    const duplicateCommit = {
      ...priorCommit,
      sequence: priorCommit.sequence + 1,
      previousCommit: priorHead,
    };
    const receipt = await fixture.store.putEvidence({
      bytes: canonicalJsonBytes(duplicateCommit),
      mediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
    });
    fixture.source.sampleChainHead = {
      uri: receipt.uri,
      sha256: receipt.sha256,
    };
    fixture.store.acceptanceChains.set(
      `${operationId}\n${sourceSha}\n${pendingAcceptance.standardBinding.bindingId}`,
      {
        sequence: duplicateCommit.sequence,
        head: structuredClone(fixture.source.sampleChainHead),
        updatedAt: receipt.committedAt,
      },
    );
    await assert.rejects(produceFrom(fixture), /reuses an immutable sample/);
  });

  await t.test(
    "cycle alias without a content-address fixed point",
    async () => {
      const fixture = await buildContinuousFixture();
      const forgedSha256 = "f".repeat(64);
      const forgedReference = reference(forgedSha256);
      fixture.store.evidence.set(forgedSha256, {
        bytes: canonicalJsonBytes({
          schemaVersion: 1,
          commitKind: "continuous-probe-chain-commit/v1",
          namespace,
          operationId,
          sourceSha,
          bindingId: pendingAcceptance.standardBinding.bindingId,
          sequence: 4,
          previousCommit: forgedReference,
          sampleReference: reference("e".repeat(64)),
        }),
        mediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
        committedAt: endedAt,
      });
      fixture.source.sampleChainHead = forgedReference;
      fixture.store.acceptanceChains.set(
        `${operationId}\n${sourceSha}\n${pendingAcceptance.standardBinding.bindingId}`,
        {
          sequence: 4,
          head: forgedReference,
          updatedAt: endedAt,
        },
      );
      await assert.rejects(
        produceFrom(fixture),
        /immutable object is missing or differs/,
      );
    },
  );
});

test("memory acceptance chain rejects forks, replays idempotently, and rolls back", async () => {
  const fixture = await buildContinuousFixture();
  const headBefore = await fixture.store.readAcceptanceEvidenceChain({
    operationId,
    sourceSha,
    bindingId: pendingAcceptance.standardBinding.bindingId,
  });
  const headObject = fixture.store.evidence.get(headBefore.head.sha256);
  const headCommit = JSON.parse(headObject.bytes.toString("utf8"));
  const sampleObject = fixture.store.evidence.get(
    headCommit.sampleReference.sha256,
  );
  const replay = await fixture.store.appendAcceptanceSample({
    operationId,
    sourceSha,
    bindingId: pendingAcceptance.standardBinding.bindingId,
    expectedPreviousCommit: headCommit.previousCommit,
    expectedSequence: headCommit.sequence - 1,
    sampleBytes: sampleObject.bytes,
    sampleMediaType: sampleObject.mediaType,
    commitBytes: headObject.bytes,
    commitMediaType: headObject.mediaType,
  });
  assert.equal(replay.sample.replayed, true);
  assert.equal(replay.commit.replayed, true);

  await assert.rejects(
    fixture.store.appendAcceptanceSample({
      operationId,
      sourceSha,
      bindingId: pendingAcceptance.standardBinding.bindingId,
      expectedPreviousCommit: null,
      expectedSequence: 0,
      sampleBytes: canonicalJsonBytes({ fork: true }),
      sampleMediaType: CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE,
      commitBytes: canonicalJsonBytes({ fork: true }),
      commitMediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
    }),
    /CAS conflict/,
  );

  const nextSampleBytes = canonicalJsonBytes({
    collectorIdentity: reference("f".repeat(64)),
    evidenceKind: "continuous-production-probe-sample/v1",
    namespace,
    operationId,
    previousSample: headCommit.sampleReference,
    results: [],
    schemaVersion: 1,
    sourceSha,
    standardBindingId: pendingAcceptance.standardBinding.bindingId,
  });
  const nextSampleReference = reference(sha256Bytes(nextSampleBytes));
  const nextCommitBytes = canonicalJsonBytes({
    bindingId: pendingAcceptance.standardBinding.bindingId,
    commitKind: "continuous-probe-chain-commit/v1",
    namespace,
    operationId,
    previousCommit: headBefore.head,
    sampleReference: nextSampleReference,
    schemaVersion: 1,
    sequence: headBefore.sequence + 1,
    sourceSha,
  });
  const evidenceCountBefore = fixture.store.evidence.size;
  fixture.store.failAtomicAppendAfterSample = true;
  await assert.rejects(
    fixture.store.appendAcceptanceSample({
      operationId,
      sourceSha,
      bindingId: pendingAcceptance.standardBinding.bindingId,
      expectedPreviousCommit: headBefore.head,
      expectedSequence: headBefore.sequence,
      sampleBytes: nextSampleBytes,
      sampleMediaType: CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE,
      commitBytes: nextCommitBytes,
      commitMediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
    }),
    /atomic failure/,
  );
  assert.equal(fixture.store.evidence.size, evidenceCountBefore);
  assert.equal(fixture.store.evidence.has(nextSampleReference.sha256), false);
  assert.deepEqual(
    await fixture.store.readAcceptanceEvidenceChain({
      operationId,
      sourceSha,
      bindingId: pendingAcceptance.standardBinding.bindingId,
    }),
    headBefore,
  );
});

test("authority source and final evidence schemas reject unknown and missing fields", async () => {
  const continuousFixture = await buildContinuousFixture();
  const continuousSourceBytes = canonicalJsonBytes(continuousFixture.source);
  const continuousProduced = await produceContinuousProductionProbe({
    ...continuousFixture,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes: continuousSourceBytes,
    expectedSourceSha256: sha256Bytes(continuousSourceBytes),
    providerPolicy,
    nowMilliseconds,
  });
  const companionFixture = await putCompanionFixture();
  const companionSourceBytes = canonicalJsonBytes(companionFixture.source);
  const companionProduced = await produceCompanionRecoveryDrill({
    ...companionFixture,
    namespace,
    pendingAcceptance,
    releaseAEvidenceBytes,
    expectedReleaseAEvidenceSha256: releaseAEvidenceSha256,
    sourceBytes: companionSourceBytes,
    expectedSourceSha256: sha256Bytes(companionSourceBytes),
    nowMilliseconds,
    futureClockSkewSeconds: 30,
    providerPolicy,
  });
  const cases = [
    [
      assertContinuousProbeSourceSchema,
      continuousFixture.source,
      "authorityBundle",
    ],
    [
      assertContinuousProbeEvidenceSchema,
      continuousProduced.evidence,
      "releaseAEvidenceAuthority",
    ],
    [
      assertCompanionRecoverySourceSchema,
      companionFixture.source,
      "packageRedeployTerminalEvent",
    ],
    [
      assertCompanionRecoveryEvidenceSchema,
      companionProduced.evidence,
      "releaseAEvidenceAuthority",
    ],
  ];
  for (const [assertSchema, validValue, requiredField] of cases) {
    assert.doesNotThrow(() => assertSchema(validValue));
    assert.throws(
      () => assertSchema({ ...structuredClone(validValue), unexpected: true }),
      /schema mismatch.*unexpected.*not allowed/,
    );
    const missing = structuredClone(validValue);
    delete missing[requiredField];
    assert.throws(
      () => assertSchema(missing),
      new RegExp(`schema mismatch.*${requiredField} is required`, "u"),
    );
  }
});
