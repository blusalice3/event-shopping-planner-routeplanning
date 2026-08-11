import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import { manifestTreeHash } from "./lib/file-manifest.mjs";
import {
  DEPLOYMENT_BINDING_MEDIA_TYPE,
  FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
  FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
  RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
  putFoundationBaselineClosureAuthority,
  readFoundationBaselineClosureAuthority,
  readFoundationBaselineClosureForPhaseExit,
  resolveBootstrapFoundationSource,
  resolveCleanFoundationSource,
  resolveFoundationBaselineClosure,
  resolveFoundationBaselinePolicyBindings,
  resolveFoundationBaselineProducerOidc,
  resolveHistoricalFoundationBaseline,
} from "./lib/foundation-baseline-closure-authority.mjs";
import {
  putRemoteDbObservationOidcAuthority,
  putRemoteDbProviderObservationAuthority,
} from "./db/remote-db-observation-authority.mjs";
import { providerConfigurationHash } from "./provider/providerConfiguration.mjs";
import { FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE } from "./provider/foundation-bootstrap-deployment-seed.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "./release-state/reviewedWorkflowRunAuthority.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
} from "./release-state/releaseWorkflowValidation.mjs";
import { collectReviewedWorkflowArtifactAuthority } from "./release-state/reviewedWorkflowArtifactAuthority.mjs";

const NOW = Date.parse("2026-08-09T04:05:06.000Z");
const NAMESPACE = "foundation-baseline-test";
const CURRENT_RUN_ID = "100";
const RECOVERY_RUN_ID = "90";
const SEED_RUN_ID = "80";
const RUN_ATTEMPT = "1";
const CONTROL_CA = "control-store-ca";
const APPLICATION_CA = "application-database-ca";
const COMMITTED_AT = new Date(NOW - 180_000).toISOString();

const [
  BASE_PROVIDER_POLICY,
  BASE_DATABASE_CONTRACT,
  BASE_STORE_POLICY,
  BASE_APPROVAL_POLICY,
  HISTORICAL_BASELINE,
  BASE_P0A_POLICY,
] = await Promise.all(
  [
    "../config/provider-policy.json",
    "../config/db-compatibility-contract.json",
    "../config/release-state-store.json",
    "../config/approval-policy.json",
    "../config/foundation-baseline.json",
    "../config/foundation-p0a-authorities.json",
  ].map(async (relativePath) =>
    JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")),
  ),
);

const providerWafRule = (id, route) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: route }] }],
  rateLimit: null,
});

const PROVIDER_POLICY = Object.freeze({
  ...BASE_PROVIDER_POLICY,
  bindingStatus: "configured",
  expectedTeamId: "team_foundation",
  expectedProjectId: "project_foundation",
  ownedProductionDomains: ["foundation.test"],
  requiredEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  cspReportEnvironmentNames: [
    "CSP_REPORT_DB_SERVICE_ROLE_KEY",
    "CSP_REPORT_DB_URL",
  ],
  forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
  wafRules: {
    metricsRoute: providerWafRule(
      "rule_metrics",
      "/api/persistence-release-a-metrics",
    ),
    cspReportRoute: providerWafRule("rule_csp", "/api/csp-report"),
    googleSheetsCsvRoute: providerWafRule(
      "rule_sheets",
      "/api/google-sheets-csv",
    ),
  },
  logPolicy: {
    ...BASE_PROVIDER_POLICY.logPolicy,
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

const providerRequestUrl = (pathname, query = {}) => {
  const url = new URL(pathname, PROVIDER_POLICY.observationPolicy.apiBaseUrl);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, String(value));
  }
  url.searchParams.sort();
  return url.href;
};

const providerReceipt = (kind, requestUrl, { hsts = null } = {}) => {
  const value = {
    kind,
    method: "GET",
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

const PROVIDER_OBSERVATION = Object.freeze({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: new Date(NOW).toISOString(),
  providerTeamId: PROVIDER_POLICY.expectedTeamId,
  providerProjectId: PROVIDER_POLICY.expectedProjectId,
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
  ownedProductionDomains: ["foundation.test"],
  presentEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  rawRequestByteCeilings: PROVIDER_POLICY.rawRequestByteCeilings,
  wafRules: PROVIDER_POLICY.wafRules,
  logPolicy: PROVIDER_POLICY.logPolicy,
  logRetentionEvidence: {
    kind: "vercel-runtime-plan-v1",
    plan: "pro",
    activeLogDrainIds: ["drain_foundation"],
    retentionDays: 1,
  },
  hstsOwner: "provider",
  hstsPolicy: PROVIDER_POLICY.hstsPolicy,
  hsts: [
    {
      domain: "foundation.test",
      maxAgeSeconds: 63_072_000,
      includeSubDomains: true,
      preload: false,
    },
  ],
  configurationEvidenceKinds: [
    ...PROVIDER_POLICY.requiredConfigurationEvidence,
  ].sort(),
  evidenceReceipts: [
    providerReceipt(
      "team",
      providerRequestUrl(`/v2/teams/${PROVIDER_POLICY.expectedTeamId}`),
    ),
    providerReceipt(
      "project",
      providerRequestUrl(`/v9/projects/${PROVIDER_POLICY.expectedProjectId}`, {
        teamId: PROVIDER_POLICY.expectedTeamId,
      }),
    ),
    providerReceipt(
      "domains",
      providerRequestUrl(
        `/v9/projects/${PROVIDER_POLICY.expectedProjectId}/domains`,
        {
          teamId: PROVIDER_POLICY.expectedTeamId,
          limit: 100,
          production: true,
        },
      ),
    ),
    providerReceipt(
      "environment-presence",
      providerRequestUrl(
        `/v10/projects/${PROVIDER_POLICY.expectedProjectId}/env`,
        { teamId: PROVIDER_POLICY.expectedTeamId, decrypt: false },
      ),
    ),
    providerReceipt(
      "waf",
      providerRequestUrl("/v1/security/firewall/config/active", {
        projectId: PROVIDER_POLICY.expectedProjectId,
        teamId: PROVIDER_POLICY.expectedTeamId,
      }),
    ),
    providerReceipt(
      "log-retention",
      providerRequestUrl("/v1/drains", {
        includeMetadata: true,
        projectId: PROVIDER_POLICY.expectedProjectId,
        teamId: PROVIDER_POLICY.expectedTeamId,
      }),
    ),
    providerReceipt("hsts:foundation.test", "https://foundation.test/", {
      hsts: "max-age=63072000; includeSubDomains",
    }),
  ].sort((left, right) => left.kind.localeCompare(right.kind)),
});

const DATABASE_CONTRACT = Object.freeze({
  ...BASE_DATABASE_CONTRACT,
  contractStatus: "local-specification",
  remote: {
    ...BASE_DATABASE_CONTRACT.remote,
    observationStatus: "unobserved",
    observationAuthority: {
      ...BASE_DATABASE_CONTRACT.remote.observationAuthority,
      bindingStatus: "configured",
      allowedHosts: ["application-db.foundation.test"],
      allowedDatabases: ["foundation"],
      allowedObserverRoles: ["foundation_observer"],
      productionCaSha256: sha256Bytes(Buffer.from(APPLICATION_CA)),
    },
  },
  blockerCodes: [
    "remote-schema-unobserved",
    "remote-privileges-unobserved",
    "hardening-migration-unapplied",
  ],
});

const STORE_POLICY = Object.freeze({
  ...BASE_STORE_POLICY,
  bindingStatus: "configured",
  allowedHosts: ["control-db.foundation.test"],
  allowedDatabases: ["release_state"],
  allowedExecutorRoles: ["foundation_executor"],
  backupOwner: "foundation-backup-owner",
  restoreOwner: "foundation-restore-owner",
  productionCaSha256: sha256Bytes(Buffer.from(CONTROL_CA)),
  blockerCodes: [],
});

const APPROVAL_POLICY = Object.freeze({
  ...BASE_APPROVAL_POLICY,
  bindingStatus: "configured",
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  roles: {
    releaseOwner: { reviewerTeam: "release-owners" },
    dataSafetyReviewer: { reviewerTeam: "data-safety" },
    operationsReviewer: { reviewerTeam: "operations" },
  },
  blockerCodes: [],
});

const createStore = () => {
  const objects = new Map();
  const store = {
    namespace: NAMESPACE,
    async putEvidence({ bytes, mediaType }) {
      const input = Buffer.from(bytes);
      const sha256 = sha256Bytes(input);
      const existing = objects.get(sha256);
      if (existing && existing.mediaType !== mediaType) {
        throw new Error("Immutable fixture media type conflict");
      }
      objects.set(sha256, {
        bytes: input,
        mediaType,
        committedAt: existing?.committedAt ?? COMMITTED_AT,
      });
      return {
        uri: `release-state://${NAMESPACE}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: input.length,
        committedAt: objects.get(sha256).committedAt,
        replayed: existing !== undefined,
      };
    },
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : null;
    },
  };
  return { objects, store };
};

const putJson = async (store, value, mediaType) => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const oidcReceipt = ({ sourceSha, runId, jti }) => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: APPROVAL_POLICY.trustedIssuer,
  audience: APPROVAL_POLICY.oidcAudience,
  subject: "repo:owner/repository:environment:foundation-release-state",
  tokenSha256: "3".repeat(64),
  signingKey: {
    kid: "fixture-key",
    jwkThumbprintSha256: "4".repeat(64),
  },
  claims: {
    repository: APPROVAL_POLICY.repository,
    workflowRef: APPROVAL_POLICY.workflowRef,
    workflowSha: sourceSha,
    environment: APPROVAL_POLICY.protectedEnvironment,
    runId,
    runAttempt: RUN_ATTEMPT,
    sourceSha,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    refProtected: true,
    jti,
    issuedAt: new Date(NOW - 60_000).toISOString(),
    notBefore: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 540_000).toISOString(),
  },
  verifiedAt: new Date(NOW).toISOString(),
});

const createGitFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "foundation-baseline-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await writeFile(path.join(root, "foundation.txt"), "bootstrap\n", "utf8");
  execFileSync("git", ["add", "foundation.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "bootstrap"], { cwd: root });
  const bootstrapSourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeFile(path.join(root, "foundation.txt"), "closure\n", "utf8");
  execFileSync("git", ["add", "foundation.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "closure"], { cwd: root });
  const closureSourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, bootstrapSourceSha, closureSourceSha };
};

const createRawDist = (content = "bootstrap static bytes\n") => {
  const bytes = Buffer.from(content);
  const files = [
    { path: "index.html", sha256: sha256Bytes(bytes), size: bytes.length },
  ];
  const manifest = {
    schemaVersion: 1,
    treeSha256: manifestTreeHash(files),
    files,
  };
  return { bytes: canonicalJsonBytes(manifest), manifest };
};

const createReviewedRun = async ({
  store,
  sourceSha,
  runId = RECOVERY_RUN_ID,
}) => {
  const apiResponse = await putJson(
    store,
    {
      id: Number(runId),
      run_attempt: Number(RUN_ATTEMPT),
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: APPROVAL_POLICY.repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  return putJson(
    store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository: APPROVAL_POLICY.repository,
      runId,
      runAttempt: RUN_ATTEMPT,
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

const createZip = async (entries) => {
  const zip = new yazl.ZipFile();
  const chunks = [];
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  for (const [name, bytes] of entries) {
    zip.addBuffer(Buffer.from(bytes), name);
  }
  zip.end();
  await once(zip.outputStream, "end");
  return Buffer.concat(chunks);
};

const createReviewedRecoveryArtifact = async ({
  store,
  executorSourceSha,
  recoveryReference,
  recoveryOidcReference,
}) => {
  const fileName = "foundation-bootstrap-recovery.json";
  const fileMediaType =
    "application/vnd.event-shopping-planner.foundation-bootstrap-recovery+json;version=2";
  const artifactId = "40001";
  const artifactName = `foundation-bootstrap-recovery-${executorSourceSha}-${RUN_ATTEMPT}`;
  const fileBytes = canonicalJsonBytes({
    schemaVersion: 2,
    kind: "foundation-bootstrap-recovery-observation/v2",
    namespace: NAMESPACE,
    sourceSha: executorSourceSha,
    observedAt: new Date(NOW).toISOString(),
    collectorIdentity: {
      repository: APPROVAL_POLICY.repository,
      workflowPath: ".github/workflows/release.yml",
      sourceSha: executorSourceSha,
      runId: RECOVERY_RUN_ID,
      runAttempt: RUN_ATTEMPT,
    },
    rawAuthority: recoveryReference,
    rehearsalAuthority: recoveryReference,
    oidcReceipt: recoveryOidcReference,
    stateInitializationSubject: {
      initialized: false,
      namespace: NAMESPACE,
    },
    result: { outcome: "succeeded" },
  });
  const archiveBytes = await createZip([[fileName, fileBytes]]);
  const artifact = {
    id: Number(artifactId),
    name: artifactName,
    expired: false,
    size_in_bytes: archiveBytes.length,
    digest: `sha256:${sha256Bytes(archiveBytes)}`,
    archive_download_url:
      `https://api.github.com/repos/${APPROVAL_POLICY.repository}/actions/` +
      `artifacts/${artifactId}/zip`,
    workflow_run: {
      id: Number(RECOVERY_RUN_ID),
      head_sha: executorSourceSha,
    },
  };
  const fetchImpl = async (url) => {
    if (url.endsWith(`/actions/runs/${RECOVERY_RUN_ID}`)) {
      return new Response(
        JSON.stringify({
          id: Number(RECOVERY_RUN_ID),
          run_attempt: Number(RUN_ATTEMPT),
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: executorSourceSha,
          path: ".github/workflows/release.yml",
          repository: { full_name: APPROVAL_POLICY.repository },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(`/actions/runs/${RECOVERY_RUN_ID}/artifacts?`)) {
      return new Response(
        JSON.stringify({ total_count: 1, artifacts: [artifact] }),
        {
          status: 200,
          headers: { "content-type": "application/vnd.github+json" },
        },
      );
    }
    if (url.endsWith(`/actions/artifacts/${artifactId}/zip`)) {
      return new Response(archiveBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`Unexpected reviewed recovery artifact URL: ${url}`);
  };
  return collectReviewedWorkflowArtifactAuthority({
    fetchImpl,
    githubToken: "github-token-for-test",
    namespace: NAMESPACE,
    repository: APPROVAL_POLICY.repository,
    expectedRunId: RECOVERY_RUN_ID,
    expectedRunAttempt: RUN_ATTEMPT,
    expectedSourceSha: executorSourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    expectedArtifactName: artifactName,
    expectedFileName: fileName,
    expectedFileMediaType: fileMediaType,
    store,
  });
};

const createBootstrapAuthorities = async ({
  store,
  bootstrapSourceSha,
  provider,
  rawDist,
  recoverySourceSha = bootstrapSourceSha,
  executorSourceSha,
  bindingSourceSha = bootstrapSourceSha,
}) => {
  const rawDistReference = {
    uri: `artifact://sha256/${sha256Bytes(rawDist.bytes)}/raw-dist-manifest.json`,
    sha256: sha256Bytes(rawDist.bytes),
  };
  const rawDistStoreReceipt = await store.putEvidence({
    bytes: rawDist.bytes,
    mediaType:
      "application/vnd.event-shopping-planner.raw-dist-manifest+json;version=1",
  });
  const rawDistStoreReference = {
    uri: rawDistStoreReceipt.uri,
    sha256: rawDistStoreReceipt.sha256,
  };
  const artifactManifest = await putJson(
    store,
    { schemaVersion: 1, fixture: "bootstrap-manifest" },
    "application/vnd.event-shopping-planner.artifact-manifest+json;version=1",
  );
  const releasePolicy = await putJson(
    store,
    { schemaVersion: 1, fixture: "release-policy" },
    "application/vnd.event-shopping-planner.release-policy+json;version=1",
  );
  const archiveBytes = Buffer.from("durable bootstrap archive");
  const archiveReceipt = await store.putEvidence({
    bytes: archiveBytes,
    mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
  });
  const artifactArchive = {
    uri: archiveReceipt.uri,
    sha256: archiveReceipt.sha256,
  };
  const variantId = "5".repeat(64);
  const dbCompatibility = {
    contractUri: DATABASE_CONTRACT.contractUri,
    fingerprint: sha256Json(DATABASE_CONTRACT),
  };
  const packageIndex = {
    schemaVersion: 1,
    packageKind: "legacy-bootstrap-single",
    sourceSha: bindingSourceSha,
    buildId: bindingSourceSha,
    buildAuthority: null,
    targetGate: null,
    buildPurpose: "legacy-bootstrap",
    promotable: false,
    toolchainPolicyHash: "6".repeat(64),
    providerConfigurationHash: providerConfigurationHash(PROVIDER_OBSERVATION),
    providerPolicyHash: provider.policyReference.sha256,
    releasePolicyHash: releasePolicy.sha256,
    requiredDbCompatibility: dbCompatibility,
    bootstrapInput: {
      uri: `artifact://sha256/${"7".repeat(64)}/bootstrap-input.json`,
      sha256: "7".repeat(64),
    },
    rawDistManifest: rawDistReference,
    artifact: {
      releaseRole: "containment",
      variantId,
      manifest: artifactManifest,
      archive: artifactArchive,
    },
  };
  const packageReference = await putJson(
    store,
    packageIndex,
    RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
  );
  const bindingId = "foundation-bootstrap-binding";
  const providerEvidence = {
    schemaVersion: 1,
    providerProjectId: PROVIDER_POLICY.expectedProjectId,
    providerDeploymentId: "deployment-bootstrap",
    deploymentUrl: "https://bootstrap.foundation.test",
    sourceSha: bindingSourceSha,
    variantId,
    releaseRole: "containment",
    artifactManifestHash: artifactManifest.sha256,
    packageIndexHash: packageReference.sha256,
    providerConfigurationHash: providerConfigurationHash(PROVIDER_OBSERVATION),
    providerPolicyHash: provider.policyReference.sha256,
    releasePolicyHash: releasePolicy.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentity: { identityKind: "legacy-bootstrap-v1" },
    routeProbeEvidenceHash: "8".repeat(64),
    environmentPresenceEvidenceHash: "9".repeat(64),
  };
  const providerEvidenceReference = await putJson(
    store,
    providerEvidence,
    "application/vnd.event-shopping-planner.provider-deployment-evidence+json;version=1",
  );
  const availability = {
    schemaVersion: 1,
    evidenceKind: "artifact-archive-availability/v1",
    availability: "available",
    namespace: NAMESPACE,
    bindingId,
    sourceSha: bindingSourceSha,
    variantId,
    releaseRole: "containment",
    artifactManifest,
    artifactArchive: {
      ...artifactArchive,
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
      byteLength: archiveBytes.length,
      committedAt: archiveReceipt.committedAt,
    },
  };
  const availabilityReference = await putJson(
    store,
    availability,
    ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  );
  const binding = {
    bindingId,
    sourceSha: bindingSourceSha,
    buildId: bindingSourceSha,
    variantId,
    releaseRole: "containment",
    publicIdentityKind: "legacy-bootstrap-v1",
    providerProjectId: PROVIDER_POLICY.expectedProjectId,
    providerDeploymentId: "deployment-bootstrap",
    deploymentUrl: "https://bootstrap.foundation.test",
    artifactArchive,
    artifactArchiveAvailability: availabilityReference,
    packageIndex: packageReference,
    artifactManifest,
    providerEvidence: providerEvidenceReference,
    releasePolicy,
    providerPolicy: provider.policyReference,
    providerConfigurationHash: providerConfigurationHash(PROVIDER_OBSERVATION),
    requiredDbCompatibility: dbCompatibility,
  };
  const bindingReference = await putJson(
    store,
    binding,
    DEPLOYMENT_BINDING_MEDIA_TYPE,
  );
  const recoveryOidc = await putRemoteDbObservationOidcAuthority({
    store,
    namespace: NAMESPACE,
    receiptBytes: canonicalJsonBytes(
      oidcReceipt({
        sourceSha: executorSourceSha,
        runId: RECOVERY_RUN_ID,
        jti: "recovery-fixture",
      }),
    ),
    approvalPolicy: APPROVAL_POLICY,
    sourceSha: executorSourceSha,
    runId: RECOVERY_RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const seedOidc = await putRemoteDbObservationOidcAuthority({
    store,
    namespace: NAMESPACE,
    receiptBytes: canonicalJsonBytes(
      oidcReceipt({
        sourceSha: bindingSourceSha,
        runId: SEED_RUN_ID,
        jti: "bootstrap-seed-fixture",
      }),
    ),
    approvalPolicy: APPROVAL_POLICY,
    sourceSha: bindingSourceSha,
    runId: SEED_RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const reviewedWorkflowRun = await createReviewedRun({
    store,
    sourceSha: bindingSourceSha,
    runId: SEED_RUN_ID,
  });
  const bootstrapDeploymentSeed = await putJson(
    store,
    {
      schemaVersion: 1,
      kind: "foundation-bootstrap-deployment-seed/v1",
      namespace: NAMESPACE,
      repository: APPROVAL_POLICY.repository,
      workflowPath: ".github/workflows/release.yml",
      bootstrapSourceSha: bindingSourceSha,
      workflowSourceSha: bindingSourceSha,
      runId: SEED_RUN_ID,
      runAttempt: RUN_ATTEMPT,
      recordedAt: new Date(NOW).toISOString(),
      oidcReceipt: seedOidc.reference,
      bindingId: binding.bindingId,
      binding: bindingReference,
      packageIndex: binding.packageIndex,
      rawDistManifest: rawDistStoreReference,
      providerEvidence: binding.providerEvidence,
      artifactArchive: binding.artifactArchive,
      artifactArchiveAvailability: binding.artifactArchiveAvailability,
    },
    FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE,
  );
  const recovery = {
    schemaVersion: 1,
    evidenceKind: "foundation-bootstrap-recovery-rehearsal/v2",
    namespace: NAMESPACE,
    sourceSha: recoverySourceSha,
    executorSourceSha,
    operation: "rehearse-foundation-bootstrap-recovery",
    workflowPath: ".github/workflows/release.yml",
    repository: APPROVAL_POLICY.repository,
    runId: RECOVERY_RUN_ID,
    runAttempt: RUN_ATTEMPT,
    bootstrapDeploymentSeed,
    reviewedWorkflowRun,
    producerOidc: recoveryOidc.reference,
    startedAt: new Date(NOW - 120_000).toISOString(),
    completedAt: new Date(NOW - 60_000).toISOString(),
    recoveryBindingId: binding.bindingId,
    recoveryDeploymentId: binding.providerDeploymentId,
    rawDistManifestSha256: rawDistReference.sha256,
    artifactArchiveSha256: artifactArchive.sha256,
    restoredArtifactSha256: artifactArchive.sha256,
    recoveryTimeSeconds: 60,
    dataLossObserved: false,
    outcome: "succeeded",
  };
  const recoveryReference = await putJson(
    store,
    recovery,
    FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
  );
  const reviewedRecoveryArtifact = await createReviewedRecoveryArtifact({
    store,
    executorSourceSha,
    recoveryReference,
    recoveryOidcReference: recoveryOidc.reference,
  });
  return {
    binding,
    bindingReference,
    recovery,
    recoveryReference,
    reviewedRecoveryArtifact,
  };
};

const createResolutionFixture = async ({
  bindingSourceMismatch = false,
  recoverySourceMismatch = false,
} = {}) => {
  const git = await createGitFixture();
  const harness = createStore();
  const sourceResolution = resolveCleanFoundationSource({
    expectedSourceSha: git.closureSourceSha,
    cwd: git.root,
  });
  const bootstrapSourceResolution = resolveBootstrapFoundationSource({
    bootstrapSourceSha: git.bootstrapSourceSha,
    cwd: git.root,
  });
  const historicalBaselineResolution =
    resolveHistoricalFoundationBaseline(HISTORICAL_BASELINE);
  const policyBindingResolution = resolveFoundationBaselinePolicyBindings({
    store: harness.store,
    namespace: NAMESPACE,
    providerPolicy: PROVIDER_POLICY,
    databaseContract: DATABASE_CONTRACT,
    controlStorePolicy: STORE_POLICY,
    approvalPolicy: APPROVAL_POLICY,
    controlStoreConnectionString:
      "postgresql://foundation_executor:secret@control-db.foundation.test/release_state?sslmode=verify-full",
    controlStoreCa: CONTROL_CA,
    applicationDatabaseConnectionString:
      "postgresql://foundation_observer:secret@application-db.foundation.test/foundation?sslmode=verify-full",
    applicationDatabaseCa: APPLICATION_CA,
  });
  const provider = await putRemoteDbProviderObservationAuthority({
    store: harness.store,
    namespace: NAMESPACE,
    bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
    providerPolicy: PROVIDER_POLICY,
    now: () => NOW,
  });
  const producerOidcStored = await putRemoteDbObservationOidcAuthority({
    store: harness.store,
    namespace: NAMESPACE,
    receiptBytes: canonicalJsonBytes(
      oidcReceipt({
        sourceSha: git.closureSourceSha,
        runId: CURRENT_RUN_ID,
        jti: "closure-fixture",
      }),
    ),
    approvalPolicy: APPROVAL_POLICY,
    sourceSha: git.closureSourceSha,
    runId: CURRENT_RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const producerOidcResolution = await resolveFoundationBaselineProducerOidc({
    store: harness.store,
    policyBindingResolution,
    reference: producerOidcStored.reference,
    sourceResolution,
    runId: CURRENT_RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const rawDist = createRawDist();
  const bootstrap = await createBootstrapAuthorities({
    store: harness.store,
    bootstrapSourceSha: git.bootstrapSourceSha,
    executorSourceSha: git.closureSourceSha,
    provider,
    rawDist,
    recoverySourceSha: recoverySourceMismatch
      ? git.closureSourceSha
      : git.bootstrapSourceSha,
    bindingSourceSha: bindingSourceMismatch
      ? git.closureSourceSha
      : git.bootstrapSourceSha,
  });
  const common = {
    store: harness.store,
    sourceResolution,
    bootstrapSourceResolution,
    historicalBaselineResolution,
    policyBindingResolution,
    producerOidcResolution,
    providerBindingReference: bootstrap.bindingReference,
    providerObservationReference: provider.reference,
    providerPolicyReference: provider.policyReference,
    rawDistManifestBytes: rawDist.bytes,
    recoveryRehearsalReference: bootstrap.recoveryReference,
    reviewedRecoveryArtifactReference:
      bootstrap.reviewedRecoveryArtifact.reference,
    currentWorkflowRunId: CURRENT_RUN_ID,
    now: () => NOW,
  };
  return { bootstrap, common, git, harness, rawDist };
};

const configuredP0aPolicy = ({ bootstrap, git, rawDist }) => ({
  ...structuredClone(BASE_P0A_POLICY),
  bindingStatus: "configured",
  blockerCodes: [],
  applicationDatabase: {
    provisioningStatus: "provisioned",
    credentialOwner: "github-team:database-observers",
    backupOwner: "github-team:database-backup",
    restoreOwner: "github-team:database-restore",
  },
  controlStore: {
    namespaceStatus: "uninitialized",
    credentialOwner: "github-team:release-state",
  },
  bootstrapRecovery: {
    ...BASE_P0A_POLICY.bootstrapRecovery,
    bootstrapSourceSha: git.bootstrapSourceSha,
    rawDistManifestSha256: sha256Bytes(rawDist.bytes),
    deploymentBindingSha256: bootstrap.bindingReference.sha256,
    deploymentSeedAuthoritySha256:
      bootstrap.recovery.bootstrapDeploymentSeed.sha256,
    previewAliasSuffix: "preview.foundation.dev",
  },
});

test("closes P0A with an independent provider-bound bootstrap source before P0D", async (t) => {
  const fixture = await createResolutionFixture();
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  assert.notEqual(fixture.git.closureSourceSha, fixture.git.bootstrapSourceSha);
  const resolution = await resolveFoundationBaselineClosure(fixture.common);
  const stored = await putFoundationBaselineClosureAuthority({
    store: fixture.harness.store,
    resolution,
  });
  assert.equal(
    stored.closure.bootstrap.bootstrapBaselineSourceSha,
    fixture.git.bootstrapSourceSha,
  );
  assert.equal(
    stored.closure.applicationDatabase.historicalBaseline.fingerprint,
    null,
  );
  assert.deepEqual(stored.closure.applicationDatabase.statusAtClosure, {
    contractStatus: "local-specification",
    observationStatus: "unobserved",
  });
  assert.equal(DATABASE_CONTRACT.remote.observationStatus, "unobserved");
  assert.equal(
    fixture.harness.objects.get(stored.reference.sha256).mediaType,
    FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
  );
  const phaseExitOptions = {
    store: fixture.harness.store,
    reference: stored.reference,
    expectedSourceSha: fixture.git.closureSourceSha,
    cwd: fixture.git.root,
    providerPolicy: PROVIDER_POLICY,
    databaseContract: DATABASE_CONTRACT,
    controlStorePolicy: STORE_POLICY,
    approvalPolicy: APPROVAL_POLICY,
    p0aPolicy: configuredP0aPolicy(fixture),
    currentWorkflowRunId: CURRENT_RUN_ID,
    now: () => NOW,
  };
  const phaseExitReadback =
    await readFoundationBaselineClosureForPhaseExit(phaseExitOptions);
  assert.equal(
    phaseExitReadback.recoveryRehearsal.executorSourceSha,
    fixture.git.closureSourceSha,
  );
  for (const [field, value, error] of [
    ["bootstrapSourceSha", "f".repeat(40), /closure source binding differs/u],
    [
      "rawDistManifestSha256",
      "e".repeat(64),
      /closure source binding differs/u,
    ],
    [
      "deploymentBindingSha256",
      "d".repeat(64),
      /closure source binding differs/u,
    ],
    [
      "deploymentSeedAuthoritySha256",
      "c".repeat(64),
      /bootstrap seed binding differs/u,
    ],
  ]) {
    const p0aPolicy = configuredP0aPolicy(fixture);
    p0aPolicy.bootstrapRecovery[field] = value;
    await assert.rejects(
      readFoundationBaselineClosureForPhaseExit({
        ...phaseExitOptions,
        p0aPolicy,
      }),
      error,
    );
  }
  const phase0dPolicyResolution = resolveFoundationBaselinePolicyBindings({
    store: fixture.harness.store,
    namespace: NAMESPACE,
    providerPolicy: PROVIDER_POLICY,
    databaseContract: {
      ...DATABASE_CONTRACT,
      contractStatus: "remote-verified",
      remote: { ...DATABASE_CONTRACT.remote, observationStatus: "observed" },
      blockerCodes: [],
    },
    controlStorePolicy: STORE_POLICY,
    approvalPolicy: APPROVAL_POLICY,
    controlStoreConnectionString:
      "postgresql://foundation_executor:secret@control-db.foundation.test/release_state?sslmode=verify-full",
    controlStoreCa: CONTROL_CA,
    applicationDatabaseConnectionString:
      "postgresql://foundation_observer:secret@application-db.foundation.test/foundation?sslmode=verify-full",
    applicationDatabaseCa: APPLICATION_CA,
  });
  const afterPhase0d = await readFoundationBaselineClosureAuthority({
    store: fixture.harness.store,
    reference: stored.reference,
    sourceResolution: fixture.common.sourceResolution,
    bootstrapSourceResolution: fixture.common.bootstrapSourceResolution,
    policyBindingResolution: phase0dPolicyResolution,
    currentWorkflowRunId: CURRENT_RUN_ID,
    now: () => NOW,
  });
  assert.equal(afterPhase0d.reference.sha256, stored.reference.sha256);
});

test("rejects arbitrary resolution objects and arbitrary immutable hashes", async (t) => {
  const fixture = await createResolutionFixture();
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  await assert.rejects(
    putFoundationBaselineClosureAuthority({
      store: fixture.harness.store,
      resolution: { passed: true, sha256: "f".repeat(64) },
    }),
    /live resolution/u,
  );
  await assert.rejects(
    resolveFoundationBaselineClosure({
      ...fixture.common,
      providerBindingReference: {
        uri: `release-state://${NAMESPACE}/evidence/${"f".repeat(64)}`,
        sha256: "f".repeat(64),
      },
    }),
    /absent|immutable/u,
  );
});

test("rejects recovery evidence whose source differs from bootstrap binding", async (t) => {
  const fixture = await createResolutionFixture({
    recoverySourceMismatch: true,
  });
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  await assert.rejects(
    resolveFoundationBaselineClosure(fixture.common),
    /recovery rehearsal binding differs/u,
  );
});

test("rejects a deployment/package source that differs from the selected bootstrap source", async (t) => {
  const fixture = await createResolutionFixture({
    bindingSourceMismatch: true,
  });
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  await assert.rejects(
    resolveFoundationBaselineClosure(fixture.common),
    /bootstrap binding differs/u,
  );
});

test("rejects a raw-dist manifest that differs from the bootstrap package", async (t) => {
  const fixture = await createResolutionFixture();
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  await assert.rejects(
    resolveFoundationBaselineClosure({
      ...fixture.common,
      rawDistManifestBytes: createRawDist("different bytes\n").bytes,
    }),
    /raw dist manifest differs/u,
  );
});

test("rejects dirty closure source after its branded resolution", async (t) => {
  const fixture = await createResolutionFixture();
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.git.root, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    resolveFoundationBaselineClosure(fixture.common),
    /dirty or differs/u,
  );
});

test("readback rejects stale, wrong-source, extra-key, and tampered closure bytes", async (t) => {
  const fixture = await createResolutionFixture();
  t.after(() => rm(fixture.git.root, { recursive: true, force: true }));
  const resolution = await resolveFoundationBaselineClosure(fixture.common);
  const stored = await putFoundationBaselineClosureAuthority({
    store: fixture.harness.store,
    resolution,
  });
  await assert.rejects(
    readFoundationBaselineClosureAuthority({
      store: fixture.harness.store,
      reference: stored.reference,
      sourceResolution: fixture.common.sourceResolution,
      bootstrapSourceResolution: fixture.common.bootstrapSourceResolution,
      policyBindingResolution: fixture.common.policyBindingResolution,
      currentWorkflowRunId: CURRENT_RUN_ID,
      now: () => NOW + 2 * 60 * 60 * 1_000,
    }),
    /stale/u,
  );
  const object = fixture.harness.objects.get(stored.reference.sha256);
  const closure = JSON.parse(object.bytes.toString("utf8"));
  const extraKeyReference = await putJson(
    fixture.harness.store,
    { ...closure, callerPassed: true },
    FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
  );
  await assert.rejects(
    readFoundationBaselineClosureAuthority({
      store: fixture.harness.store,
      reference: extraKeyReference,
      sourceResolution: fixture.common.sourceResolution,
      bootstrapSourceResolution: fixture.common.bootstrapSourceResolution,
      policyBindingResolution: fixture.common.policyBindingResolution,
      currentWorkflowRunId: CURRENT_RUN_ID,
      now: () => NOW,
    }),
    /shape or identity/u,
  );
  const reviewedReceiptObject = fixture.harness.objects.get(
    fixture.bootstrap.reviewedRecoveryArtifact.reference.sha256,
  );
  const reviewedReceipt = JSON.parse(
    reviewedReceiptObject.bytes.toString("utf8"),
  );
  const reviewedFileObject = fixture.harness.objects.get(
    reviewedReceipt.artifactFile.sha256,
  );
  const reviewedFileBytes = Buffer.from(reviewedFileObject.bytes);
  reviewedFileObject.bytes = Buffer.concat([
    reviewedFileObject.bytes,
    Buffer.from(" "),
  ]);
  await assert.rejects(
    readFoundationBaselineClosureAuthority({
      store: fixture.harness.store,
      reference: stored.reference,
      sourceResolution: fixture.common.sourceResolution,
      bootstrapSourceResolution: fixture.common.bootstrapSourceResolution,
      policyBindingResolution: fixture.common.policyBindingResolution,
      currentWorkflowRunId: CURRENT_RUN_ID,
      now: () => NOW,
    }),
    /immutable object is absent or differs/u,
  );
  reviewedFileObject.bytes = reviewedFileBytes;
  await writeFile(
    path.join(fixture.git.root, "foundation.txt"),
    "third\n",
    "utf8",
  );
  execFileSync("git", ["add", "foundation.txt"], { cwd: fixture.git.root });
  execFileSync("git", ["commit", "-m", "third"], { cwd: fixture.git.root });
  const wrongSource = resolveCleanFoundationSource({
    expectedSourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.git.root,
      encoding: "utf8",
    }).trim(),
    cwd: fixture.git.root,
  });
  await assert.rejects(
    readFoundationBaselineClosureAuthority({
      store: fixture.harness.store,
      reference: stored.reference,
      sourceResolution: wrongSource,
      bootstrapSourceResolution: fixture.common.bootstrapSourceResolution,
      policyBindingResolution: fixture.common.policyBindingResolution,
      currentWorkflowRunId: CURRENT_RUN_ID,
      now: () => NOW,
    }),
    /shape or identity/u,
  );
  object.bytes = canonicalJsonBytes({ ...closure, callerPassed: true });
  await assert.rejects(
    readFoundationBaselineClosureAuthority({
      store: fixture.harness.store,
      reference: stored.reference,
      sourceResolution: wrongSource,
      bootstrapSourceResolution: fixture.common.bootstrapSourceResolution,
      policyBindingResolution: fixture.common.policyBindingResolution,
      currentWorkflowRunId: CURRENT_RUN_ID,
      now: () => NOW,
    }),
    /immutable storage/u,
  );
});

test("configured P0A database binding rejects unconfigured authority without requiring P0D observation", () => {
  const harness = createStore();
  assert.throws(
    () =>
      resolveFoundationBaselinePolicyBindings({
        store: harness.store,
        namespace: NAMESPACE,
        providerPolicy: PROVIDER_POLICY,
        databaseContract: BASE_DATABASE_CONTRACT,
        controlStorePolicy: STORE_POLICY,
        approvalPolicy: APPROVAL_POLICY,
        controlStoreConnectionString:
          "postgresql://foundation_executor:secret@control-db.foundation.test/release_state?sslmode=verify-full",
        controlStoreCa: CONTROL_CA,
        applicationDatabaseConnectionString:
          "postgresql://foundation_observer:secret@application-db.foundation.test/foundation?sslmode=verify-full",
        applicationDatabaseCa: APPLICATION_CA,
      }),
    /not configured/u,
  );
});
