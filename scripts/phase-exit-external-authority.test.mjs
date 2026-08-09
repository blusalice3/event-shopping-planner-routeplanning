import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import yazl from "yazl";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
  PHASE_EXIT_EXTERNAL_AUTHORITIES,
  PHASE_EXIT_EXTERNAL_READER_BRANCHES,
  assertCurrentAcceptedPhaseExitDeployment,
  buildBrowserPhaseExitEvidence,
  buildManagedDevicePhaseExitEvidence,
  getPhaseExitCollectorArtifactIdentity,
  projectPhaseExitAuthorityReleaseContext,
  projectPhaseExitAuthoritySubject,
  readPhaseExitArtifactCollectorEvidence,
  resolveExternalPhaseExitAuthorities,
} from "./lib/phase-exit-external-authority.mjs";
import {
  REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  putRemoteDbProviderObservationAuthority,
} from "./db/remote-db-observation-authority.mjs";
import { VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE } from "./provider/collect-vercel-observation.mjs";
import { GITHUB_OIDC_RECEIPT_MEDIA_TYPE } from "./release-state/githubOidc.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "./release-state/reviewedWorkflowRunAuthority.mjs";
import {
  GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE,
  GITHUB_WORKFLOW_ARTIFACT_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
  readBoundReviewedWorkflowArtifactAuthority,
} from "./release-state/reviewedWorkflowArtifactAuthority.mjs";
import { collectAndStoreFoundationExternalBindings } from "./provider/foundation-external-bindings.mjs";
import { collectAndStoreBackupRestoreRehearsal } from "./provider/backup-restore-rehearsal.mjs";
import { collectAndStoreStartupWafObservation } from "./provider/startup-waf-observation.mjs";
import { providerConfigurationHash } from "./provider/providerConfiguration.mjs";
import { publishPhaseExitAuthorityBundle } from "./release-state/phaseExitAuthorityPublisher.mjs";

const namespace = "phase-authority-live";
const sourceSha = "a".repeat(40);
const bootstrapSourceSha = "d".repeat(40);
const hash = (character) => character.repeat(64);
const now = Date.now();
const observedAt = new Date(now - 30_000).toISOString();
const isoBefore = (seconds) => new Date(now - seconds * 1_000).toISOString();

const createSingleFileZip = async (fileName, bytes) => {
  const zip = new yazl.ZipFile();
  const chunks = [];
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  zip.addBuffer(Buffer.from(bytes), fileName);
  zip.end();
  await once(zip.outputStream, "end");
  return Buffer.concat(chunks);
};

const createAuthorityMemoryStore = ({
  storeNamespace = namespace,
  current = {
    head: { sequence: 0, eventHash: null },
    snapshot: null,
    records: [],
  },
} = {}) => {
  const objects = new Map();
  return {
    namespace: storeNamespace,
    objects,
    async readHead() {
      return { ...current.head };
    },
    async readEvents({ afterSequence = 0 } = {}) {
      return current.records
        .filter(({ sequence }) => sequence > afterSequence)
        .map((record) => structuredClone(record));
    },
    async putEvidence({ bytes, mediaType }) {
      const input = Buffer.from(bytes);
      const sha256 = sha256Bytes(input);
      const committedAt = new Date(now - 10_000).toISOString();
      const existing = objects.get(sha256);
      if (existing !== undefined && existing.mediaType !== mediaType) {
        throw new Error("Fixture immutable media type conflict");
      }
      objects.set(sha256, { bytes: input, mediaType, committedAt });
      return {
        uri: `release-state://${storeNamespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: input.length,
        committedAt,
        replayed: existing !== undefined,
      };
    },
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { ...stored, bytes: Buffer.from(stored.bytes) };
    },
  };
};

const putAuthorityFixtureValue = async (store, value, mediaType) => {
  const bytes = canonicalJsonBytes(value);
  const receipt = await store.putEvidence({ bytes, mediaType });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putAuthorityFixtureBytes = async (store, bytes, mediaType) => {
  const receipt = await store.putEvidence({ bytes, mediaType });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const createReviewedArtifactFixture = async ({
  authority,
  approvalPolicy,
  fileBytes,
  runId,
  runAttempt = "1",
  store,
}) => {
  const identity = getPhaseExitCollectorArtifactIdentity({
    authority,
    sourceSha,
    runAttempt,
  });
  const workflowPath = PHASE_EXIT_EXTERNAL_AUTHORITIES.find(
    (candidate) => candidate.authority === authority,
  ).collectorWorkflowPath;
  const putValue = (value, mediaType) =>
    putAuthorityFixtureValue(store, value, mediaType);
  const reviewedRunApi = await putValue(
    {
      id: runId,
      run_attempt: Number(runAttempt),
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: workflowPath,
      repository: { full_name: approvalPolicy.repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  const reviewedRun = await putValue(
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository: approvalPolicy.repository,
      runId,
      runAttempt,
      workflowPath,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse: reviewedRunApi,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
  const archiveBytes = await createSingleFileZip(identity.fileName, fileBytes);
  const artifactId = String(80_000 + Number(runId));
  const archive = await putAuthorityFixtureBytes(
    store,
    archiveBytes,
    GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE,
  );
  const artifactFile = await putAuthorityFixtureBytes(
    store,
    fileBytes,
    identity.fileMediaType,
  );
  const apiResponse = await putValue(
    {
      total_count: 1,
      artifacts: [
        {
          id: artifactId,
          name: identity.artifactName,
          expired: false,
          size_in_bytes: archiveBytes.length,
          digest: `sha256:${sha256Bytes(archiveBytes)}`,
          archive_download_url:
            `https://api.github.com/repos/${approvalPolicy.repository}` +
            `/actions/artifacts/${artifactId}/zip`,
          workflow_run: { id: runId, head_sha: sourceSha },
        },
      ],
    },
    GITHUB_WORKFLOW_ARTIFACT_RESPONSE_MEDIA_TYPE,
  );
  const reference = await putValue(
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-artifact/v1",
      repository: approvalPolicy.repository,
      runId,
      runAttempt,
      sourceSha,
      workflowPath,
      artifactId,
      artifactName: identity.artifactName,
      artifactDigestSha256: sha256Bytes(archiveBytes),
      fileName: identity.fileName,
      artifactFileMediaType: identity.fileMediaType,
      reviewedWorkflowRun: reviewedRun,
      artifactApiResponse: apiResponse,
      artifactArchive: archive,
      artifactFile,
    },
    REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
  );
  const readback = await readBoundReviewedWorkflowArtifactAuthority({
    namespace: store.namespace,
    repository: approvalPolicy.repository,
    expectedSourceSha: sourceSha,
    expectedWorkflowPath: workflowPath,
    expectedArtifactNameTemplate: identity.artifactName.replace(
      runAttempt,
      "{runAttempt}",
    ),
    expectedFileName: identity.fileName,
    expectedFileMediaType: identity.fileMediaType,
    reference,
    store,
  });
  return {
    reference,
    readback: {
      ...readback,
      artifactReceipt: readback.receipt,
      receipt: readback.workflowRun.receipt,
    },
  };
};
const implementedAuthorities = PHASE_EXIT_EXTERNAL_AUTHORITIES.filter(
  ({ collectorImplemented }) => collectorImplemented,
);
const genericFixtureAuthorities = implementedAuthorities.filter(
  ({ authority }) =>
    ["quality-run", "physical-performance", "remote-db", "retention"].includes(
      authority,
    ),
);

const expectedReaderBranchByAuthority = Object.freeze({
  "external-bindings": "derived-reviewed-artifact",
  "bootstrap-recovery-drill": "derived-reviewed-artifact",
  "quality-run": "generic-reviewed-artifact",
  "physical-performance": "physical-performance-artifact",
  "artifact-provider-control-store-drill": "derived-reviewed-artifact",
  "remote-db": "reviewed-remote-db-production",
  retention: "generic-reviewed-artifact",
  "backup-restore-rehearsal": "derived-reviewed-artifact",
  "startup-waf-observation": "derived-reviewed-artifact",
  "pwa-multiclient-drill": "managed-device-reviewed-stage-set",
  "production-request-graph": "derived-reviewed-artifact",
  "csp-report-observation": "derived-reviewed-artifact",
  "deployed-csp-flow": "derived-reviewed-artifact",
  "idb-device-compatibility": "managed-device-reviewed-stage-set",
});

test("closes reader selection over every implemented external authority", () => {
  assert.equal(PHASE_EXIT_EXTERNAL_READER_BRANCHES.length, 14);
  assert.deepEqual(
    PHASE_EXIT_EXTERNAL_READER_BRANCHES.map(({ authority }) => authority),
    implementedAuthorities.map(({ authority }) => authority),
  );
  for (const branch of PHASE_EXIT_EXTERNAL_READER_BRANCHES) {
    assert.equal(
      branch.readerKind,
      expectedReaderBranchByAuthority[branch.authority],
      `reader branch for ${branch.authority}`,
    );
    assert.equal(
      branch.gate,
      implementedAuthorities.find(
        ({ authority }) => authority === branch.authority,
      )?.gate,
    );
  }
  assert.deepEqual(
    Object.keys(expectedReaderBranchByAuthority),
    implementedAuthorities.map(({ authority }) => authority),
  );
});

const positiveReaderCoverage = Object.freeze([
  {
    authority: "external-bindings",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName:
      "derives P0-BASELINE external bindings from a reviewed artifact and raw immutable authority",
  },
  {
    authority: "bootstrap-recovery-drill",
    file: "scripts/provider/foundation-bootstrap-recovery.test.mjs",
    testName:
      "collects and rederives build-less bootstrap recovery with an initialization-ready full binding",
  },
  {
    authority: "quality-run",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName:
      "resolves the four legacy collector authorities from their formal chain",
  },
  {
    authority: "physical-performance",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName: "resolves P0 physical performance only at the P0-RELEASE exit",
  },
  {
    authority: "artifact-provider-control-store-drill",
    file: "scripts/provider/artifact-control-store-drill.test.mjs",
    testName: "stores, reads back, and rejects tamper/media/store mismatch",
  },
  {
    authority: "remote-db",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName:
      "resolves the complete P0-DATA reviewed artifact and raw authority bundle",
  },
  {
    authority: "retention",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName:
      "resolves the complete P0-DATA reviewed artifact and raw authority bundle",
  },
  {
    authority: "backup-restore-rehearsal",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName:
      "derives P0-DATA backup closure from a reviewed artifact and raw immutable authority",
  },
  {
    authority: "startup-waf-observation",
    file: "scripts/phase-exit-external-authority.test.mjs",
    testName:
      "derives P0-DATA startup WAF closure from a reviewed artifact and raw immutable transcript",
  },
  {
    authority: "pwa-multiclient-drill",
    file: "scripts/release-state/managedDeviceReviewedStageSetAuthority.test.mjs",
    testName:
      "stores a canonical closed set and derives order only from reviewed runs",
  },
  {
    authority: "production-request-graph",
    file: "scripts/browser/production-request-graph.test.mjs",
    testName: "stores, reads back, and re-summarizes the canonical raw graph",
  },
  {
    authority: "csp-report-observation",
    file: "scripts/browser/csp-report-observation.test.mjs",
    testName:
      "collector derives its result only from trusted browser and DB observations",
  },
  {
    authority: "deployed-csp-flow",
    file: "scripts/browser/deployed-csp-flow.test.mjs",
    testName: "stores, re-reads, and re-derives the immutable CSP trace",
  },
  {
    authority: "idb-device-compatibility",
    file: "scripts/release-state/managedDeviceReviewedStageSetAuthority.test.mjs",
    testName:
      "stores a canonical closed set and derives order only from reviewed runs",
  },
]);

test("keeps one executable positive readback route for every reader branch", async () => {
  assert.deepEqual(
    positiveReaderCoverage.map(({ authority }) => authority),
    PHASE_EXIT_EXTERNAL_READER_BRANCHES.map(({ authority }) => authority),
  );
  const packageManifest = await readJsonStrict("package.json");
  const foundationCommands = [
    packageManifest.scripts?.["pretest:foundation"],
    packageManifest.scripts?.["test:foundation"],
  ].join(" ");
  const sourceByFile = new Map(
    await Promise.all(
      [...new Set(positiveReaderCoverage.map(({ file }) => file))].map(
        async (file) => [file, await readFile(file, "utf8")],
      ),
    ),
  );
  for (const { authority, file, testName } of positiveReaderCoverage) {
    assert.match(
      foundationCommands,
      new RegExp(file.replaceAll("/", "[/\\\\]"), "u"),
      `${authority} positive route must execute in test:foundation`,
    );
    assert.equal(
      sourceByFile.get(file).includes(`test("${testName}"`),
      true,
      `${authority} positive route must remain explicit`,
    );
  }
});

const [
  providerBase,
  approvalBase,
  storeBase,
  databaseBase,
  retentionBase,
  startupBase,
  cspPolicy,
  backupRestorePrerequisiteBase,
  backupRestoreProviderBase,
  artifactDrillBase,
  releasePolicyBase,
  toolchainPolicyBase,
  foundationBaselineBase,
  p0aBase,
] = await Promise.all(
  [
    "config/provider-policy.json",
    "config/approval-policy.json",
    "config/release-state-store.json",
    "config/db-compatibility-contract.json",
    "config/metrics-retention-policy.json",
    "contracts/persistence-release-a-startup-bursts-v1.json",
    "config/csp-policy.json",
    "config/phase-exit-external-prerequisites.json",
    "config/backup-restore-provider-contract.json",
    "config/artifact-control-store-drill.json",
    "config/release-variants.json",
    "config/toolchain-versions.json",
    "config/foundation-baseline.json",
    "config/foundation-p0a-authorities.json",
  ].map((path) => readJsonStrict(path)),
);

const configuredPolicies = () => {
  const providerPolicy = structuredClone(providerBase);
  const wafRule = (id, route) => ({
    id,
    active: true,
    action: "deny",
    conditionGroup: [
      { conditions: [{ type: "path", op: "eq", value: route }] },
    ],
    rateLimit: null,
  });
  Object.assign(providerPolicy, {
    bindingStatus: "configured",
    expectedTeamId: "team-foundation",
    expectedProjectId: "project-foundation",
    ownedProductionDomains: ["app.example.test"],
    requiredEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
    forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
    wafRules: {
      metricsRoute: wafRule(
        "rule-metrics",
        "/api/persistence-release-a-metrics",
      ),
      cspReportRoute: wafRule("rule-csp", "/api/csp-report"),
      googleSheetsCsvRoute: wafRule("rule-sheets", "/api/google-sheets-csv"),
    },
    logPolicy: {
      ...providerPolicy.logPolicy,
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
  const approvalPolicy = structuredClone(approvalBase);
  approvalPolicy.bindingStatus = "configured";
  approvalPolicy.roles = {
    releaseOwner: { reviewerTeam: "team-release" },
    dataSafetyReviewer: { reviewerTeam: "team-data" },
    operationsReviewer: { reviewerTeam: "team-operations" },
  };
  approvalPolicy.blockerCodes = [];
  const storePolicy = structuredClone(storeBase);
  Object.assign(storePolicy, {
    bindingStatus: "configured",
    allowedHosts: ["control.example.test"],
    allowedDatabases: ["foundation_release"],
    allowedExecutorRoles: ["foundation_release_executor"],
    productionCaSha256: hash("1"),
    backupOwner: "foundation-backup",
    restoreOwner: "foundation-restore",
    blockerCodes: [],
  });
  const databaseContract = structuredClone(databaseBase);
  databaseContract.contractStatus = "remote-verified";
  databaseContract.remote.observationStatus = "observed";
  Object.assign(databaseContract.remote.observationAuthority, {
    bindingStatus: "configured",
    allowedHosts: ["database.example.test"],
    allowedDatabases: ["foundation_app"],
    allowedObserverRoles: ["foundation_observer"],
    serviceRole: "service_role",
    productionCaSha256: hash("2"),
    maximumObservationAgeSeconds: 300,
    maximumFutureClockSkewSeconds: 30,
  });
  databaseContract.blockerCodes = [];
  const retentionPolicy = structuredClone(retentionBase);
  Object.assign(retentionPolicy, {
    activationStatus: "configured",
    backupRetentionOwner: "foundation-backup",
    blockerCodes: [],
  });
  const startupBurstContract = structuredClone(startupBase);
  Object.assign(startupBurstContract, {
    activationStatus: "configured",
    blockerCodes: [],
  });
  const foundationBaseline = structuredClone(foundationBaselineBase);
  foundationBaseline.bootstrapBaselineSourceSha = bootstrapSourceSha;
  foundationBaseline.baselineEvidence.artifactObservation.rawDistManifestSha256 =
    hash("9");
  return {
    providerPolicy,
    approvalPolicy,
    storePolicy,
    databaseContract,
    retentionPolicy,
    startupBurstContract,
    backupRestorePrerequisitePolicy: structuredClone(
      backupRestorePrerequisiteBase,
    ),
    backupRestoreProviderContract: structuredClone(backupRestoreProviderBase),
    artifactDrillPolicy: structuredClone(artifactDrillBase),
    releasePolicy: structuredClone(releasePolicyBase),
    toolchainPolicy: structuredClone(toolchainPolicyBase),
    foundationBaseline,
    p0aPolicy: structuredClone(p0aBase),
  };
};

const deploymentBinding = {
  bindingId: "standard-phase-authority",
  sourceSha,
  buildId: sourceSha,
  variantId: hash("3"),
  releaseRole: "standard",
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-foundation",
  providerDeploymentId: "deployment-foundation",
  deploymentUrl: "https://app.example.test",
  artifactArchive: {
    uri: `release-state://${namespace}/evidence/${hash("7")}`,
    sha256: hash("7"),
  },
  packageIndex: {
    uri: `release-state://${namespace}/evidence/${hash("6")}`,
    sha256: hash("6"),
  },
};

const bootstrapRecoveryBinding = {
  ...deploymentBinding,
  sourceSha: bootstrapSourceSha,
  bindingId: "bootstrap-recovery-phase-authority",
  releaseRole: "containment",
  publicIdentityKind: "legacy-bootstrap-v1",
  providerDeploymentId: "bootstrap-recovery-deployment",
  deploymentUrl: "https://bootstrap-preview.example.test",
};

const makeCurrent = (databaseContract, { preRelease = false } = {}) => {
  const eventHash = hash("e");
  const bootstrapRecovery = preRelease
    ? structuredClone(bootstrapRecoveryBinding)
    : null;
  return {
    head: { sequence: 1, eventHash },
    snapshot: {
      currentDbCompatibility: {
        contractUri: databaseContract.contractUri,
        fingerprint: sha256Json(databaseContract),
      },
      activeProduction: preRelease ? null : structuredClone(deploymentBinding),
      acceptedStandard: preRelease ? null : structuredClone(deploymentBinding),
      acceptedGate: preRelease ? null : "P0-RELEASE",
      pendingOperation: null,
      pendingAcceptance: null,
      containmentCompanion: null,
      bootstrapRecovery,
    },
    records: [
      {
        sequence: 1,
        eventHash,
        event: {
          namespace,
          eventType: "state-initialized",
          payload: { bootstrapRecovery, executorSourceSha: sourceSha },
        },
      },
    ],
  };
};

const providerRequestUrl = (policy, pathname, query = {}) => {
  const url = new URL(pathname, policy.observationPolicy.apiBaseUrl);
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
    responseDate: new Date(now).toUTCString(),
    etag: null,
    contentType: kind.startsWith("hsts:") ? null : "application/json",
    strictTransportSecurity: hsts,
    bodySha256: hash("2"),
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

const remoteProviderObservation = (policy) => ({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: policy.provider,
  observedAt,
  providerTeamId: policy.expectedTeamId,
  providerProjectId: policy.expectedProjectId,
  productionEnvironmentName: policy.productionEnvironmentName,
  providerNodeFamily: policy.providerNodeFamily,
  productionBranch: policy.productionBranch,
  autoAssignCustomProductionDomains: policy.autoAssignCustomProductionDomains,
  gitProductionAutoDeploy: policy.gitProductionAutoDeploy,
  gitPreviewAutoDeploy: false,
  gitIntegration: {
    connected: true,
    provider: "github",
    productionBranch: policy.productionBranch,
  },
  allowedPreviewBranches: policy.allowedPreviewBranches,
  ownedProductionDomains: policy.ownedProductionDomains,
  presentEnvironmentNames: policy.requiredEnvironmentNames,
  rawRequestByteCeilings: policy.rawRequestByteCeilings,
  wafRules: policy.wafRules,
  logPolicy: policy.logPolicy,
  logRetentionEvidence: {
    kind: "vercel-runtime-plan-v1",
    plan: "pro",
    activeLogDrainIds: ["drain-foundation"],
    retentionDays: policy.logPolicy.retentionDays,
  },
  hstsOwner: policy.hstsOwner,
  hstsPolicy: policy.hstsPolicy,
  hsts: policy.ownedProductionDomains.map((domain) => ({
    domain,
    maxAgeSeconds: 63_072_000,
    includeSubDomains: true,
    preload: false,
  })),
  configurationEvidenceKinds: [...policy.requiredConfigurationEvidence].sort(),
  evidenceReceipts: [
    providerReceipt(
      "team",
      providerRequestUrl(policy, `/v2/teams/${policy.expectedTeamId}`),
    ),
    providerReceipt(
      "project",
      providerRequestUrl(policy, `/v9/projects/${policy.expectedProjectId}`, {
        teamId: policy.expectedTeamId,
      }),
    ),
    providerReceipt(
      "domains",
      providerRequestUrl(
        policy,
        `/v9/projects/${policy.expectedProjectId}/domains`,
        { teamId: policy.expectedTeamId, limit: 100, production: true },
      ),
    ),
    providerReceipt(
      "environment-presence",
      providerRequestUrl(
        policy,
        `/v10/projects/${policy.expectedProjectId}/env`,
        { teamId: policy.expectedTeamId, decrypt: false },
      ),
    ),
    providerReceipt(
      "waf",
      providerRequestUrl(policy, "/v1/security/firewall/config/active", {
        projectId: policy.expectedProjectId,
        teamId: policy.expectedTeamId,
      }),
    ),
    providerReceipt(
      "log-retention",
      providerRequestUrl(policy, "/v1/drains", {
        includeMetadata: true,
        projectId: policy.expectedProjectId,
        teamId: policy.expectedTeamId,
      }),
    ),
    ...policy.ownedProductionDomains.map((domain) =>
      providerReceipt(`hsts:${domain}`, `https://${domain}/`, {
        hsts: "max-age=63072000; includeSubDomains",
      }),
    ),
  ].sort((left, right) => left.kind.localeCompare(right.kind)),
});

const remoteProducerOidcReceipt = ({ approvalPolicy, runId, runAttempt }) => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: approvalPolicy.trustedIssuer,
  audience: approvalPolicy.oidcAudience,
  subject: `repo:${approvalPolicy.repository}:environment:${approvalPolicy.protectedEnvironment}`,
  tokenSha256: hash("3"),
  signingKey: {
    kid: "phase-authority-fixture-key",
    jwkThumbprintSha256: hash("4"),
  },
  claims: {
    repository: approvalPolicy.repository,
    workflowRef: approvalPolicy.workflowRef,
    workflowSha: sourceSha,
    environment: approvalPolicy.protectedEnvironment,
    runId,
    runAttempt,
    sourceSha,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    refProtected: true,
    jti: "phase-authority-remote-db",
    issuedAt: new Date(now - 60_000).toISOString(),
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 540_000).toISOString(),
  },
  verifiedAt: new Date(now).toISOString(),
});

const ownGatePerformanceEvidence = ({ current }) => {
  const evidence = {
    gate: "P0-TOOLCHAIN",
    collectedAtUtc: observedAt,
    source: {
      gitCommitSha: sourceSha,
      sourceClosureSha256: hash("4"),
      treeState: "clean",
      artifactSha256: hash("7"),
    },
  };
  const envelope = {
    schemaVersion: 1,
    evidence,
    evidenceSha256: sha256Json(evidence),
  };
  const receipt = {
    kind: "own-gate-performance-evidence-producer-receipt/v1",
    namespace,
    operationId: "phase-authority-performance",
    acceptedGate: "P0-RELEASE",
    performanceGate: "P0-TOOLCHAIN",
    source: {
      gitCommitSha: sourceSha,
      sourceClosureSha256: hash("4"),
      treeState: "clean",
    },
    authoritativeState: { ...current.head },
    requirementsSha256: hash("5"),
    artifactArchiveSha256: hash("7"),
    rawSamplesArtifact: {
      name: `foundation-performance-raw-samples-${sourceSha}-1`,
      runId: "100",
      runAttempt: "1",
      sha256: hash("6"),
      collectorIdentity: {
        uri: `release-state://${namespace}/evidence/${hash("8")}`,
        sha256: hash("8"),
      },
      workflowRunAuthority: {
        uri: `release-state://${namespace}/evidence/${hash("9")}`,
        sha256: hash("9"),
      },
    },
    producerRunId: "101",
    producerRunAttempt: "1",
    performanceEvidence: {
      name: `foundation-performance-own-gate-evidence-${sourceSha}-1`,
      envelopeSha256: sha256Bytes(canonicalJsonBytes(envelope)),
      evidenceSha256: envelope.evidenceSha256,
    },
    producedAtUtc: observedAt,
  };
  return {
    ...envelope,
    producerReceipt: {
      schemaVersion: 1,
      receipt,
      receiptSha256: sha256Json(receipt),
    },
  };
};

const externalBindingsResult = (policies) => {
  const remote = policies.databaseContract.remote.observationAuthority;
  return {
    provider: {
      provider: policies.providerPolicy.provider,
      teamId: policies.providerPolicy.expectedTeamId,
      projectId: policies.providerPolicy.expectedProjectId,
      ownedProductionDomains: policies.providerPolicy.ownedProductionDomains,
      productionEnvironmentName:
        policies.providerPolicy.productionEnvironmentName,
      productionBranch: policies.providerPolicy.productionBranch,
      configurationSha256: sha256Json(policies.providerPolicy),
    },
    approval: {
      repository: policies.approvalPolicy.repository,
      workflowRef: policies.approvalPolicy.workflowRef,
      protectedEnvironment: policies.approvalPolicy.protectedEnvironment,
      reviewerTeams: Object.fromEntries(
        Object.entries(policies.approvalPolicy.roles).map(([role, value]) => [
          role,
          value.reviewerTeam,
        ]),
      ),
      configurationSha256: sha256Json(policies.approvalPolicy),
    },
    controlStore: {
      engine: policies.storePolicy.engine,
      postgresMajor: policies.storePolicy.postgresMajor,
      allowedHosts: policies.storePolicy.allowedHosts,
      allowedDatabases: policies.storePolicy.allowedDatabases,
      allowedExecutorRoles: policies.storePolicy.allowedExecutorRoles,
      productionCaSha256: policies.storePolicy.productionCaSha256,
      backupOwner: policies.storePolicy.backupOwner,
      restoreOwner: policies.storePolicy.restoreOwner,
      configurationSha256: sha256Json(policies.storePolicy),
    },
    applicationDatabase: {
      contractUri: policies.databaseContract.contractUri,
      contractFingerprint: sha256Json(policies.databaseContract),
      allowedHosts: remote.allowedHosts,
      allowedDatabases: remote.allowedDatabases,
      allowedObserverRoles: remote.allowedObserverRoles,
      productionCaSha256: remote.productionCaSha256,
      configurationSha256: sha256Json(remote),
    },
  };
};

const remoteDbEvidence = (databaseContract) => ({
  schemaVersion: 1,
  contractFingerprint: sha256Json(databaseContract),
  migrationChecksums: databaseContract.remote.migrationChecksums,
  migrationsApplied: true,
  serviceRoleRawSelect: false,
  serviceRoleRawInsert: true,
  cspServiceRoleRawSelect: false,
  cspServiceRoleRawInsert: true,
  cspObjectsPresent: true,
  operatorBoundedFunctionOnly: true,
  cspApplicationCredentialReachable: false,
  requiredTables: databaseContract.remote.requiredTables,
  requiredFunctions: databaseContract.remote.requiredFunctions,
  observedAt,
});

const retentionEvidence = (policy) => ({
  schemaVersion: 1,
  observedAt,
  lastSuccessByTarget: Object.fromEntries(
    policy.requiredTargets.map((target) => [target, isoBefore(60)]),
  ),
  cronSchedule: policy.cron.schedule,
  cronActive: true,
  batchSize: policy.batchSize,
  maximumBatchesPerRun: policy.maximumBatchesPerRun,
  lockTimeoutMilliseconds: policy.lockTimeoutMilliseconds,
  statementTimeoutMilliseconds: policy.statementTimeoutMilliseconds,
  dryRunByTarget: Object.fromEntries(
    policy.requiredTargets.map((target) => [
      target,
      {
        succeeded: true,
        affectedRows: 0,
        batchCount: 0,
        cutoff: isoBefore(90),
      },
    ]),
  ),
  backupRetentionOwner: policy.backupRetentionOwner,
  collectorIdentity: null,
});

const customResults = ({ policies, current, releaseContext }) => ({
  "external-bindings": externalBindingsResult(policies),
  "bootstrap-recovery-drill": {
    drillId: "bootstrap-recovery-20260809",
    startedAt: isoBefore(120),
    completedAt: isoBefore(60),
    recoveryBindingId: deploymentBinding.bindingId,
    recoveryDeploymentId: deploymentBinding.providerDeploymentId,
    rawDistManifestSha256: hash("b"),
    artifactArchiveSha256: deploymentBinding.artifactArchive.sha256,
    restoredArtifactSha256: deploymentBinding.artifactArchive.sha256,
    recoveryTimeSeconds: 60,
    dataLossObserved: false,
    outcome: "succeeded",
  },
  "quality-run": {
    repository: policies.approvalPolicy.repository,
    workflowPath: ".github/workflows/quality.yml",
    workflowRunId: "20000",
    workflowRunAttempt: "1",
    event: "push",
    headBranch: "main",
    headSha: sourceSha,
    status: "completed",
    conclusion: "success",
    nodeVersion: "24.19.0",
    npmVersion: "11.19.0",
    checks: [
      "api",
      "architecture",
      "artifact",
      "audit",
      "browser",
      "coverage",
      "dependency-usage",
      "encoding",
      "format",
      "foundation",
      "integration",
      "lint",
      "typecheck",
      "unit",
      "worker",
    ],
  },
  "artifact-provider-control-store-drill": {
    drillNamespace: "phase-artifact-drill",
    generatedArchiveSha256: hash("a"),
    regeneratedArchiveSha256: hash("a"),
    extractedManifestSha256: hash("b"),
    providerDeploymentReceiptSha256: hash("c"),
    providerObservationSha256: hash("d"),
    controlStoreReceiptSha256: hash("e"),
    routeProbeCount: 8,
    casConflictDenied: true,
    credentialDenialVerified: true,
    multiDomainAssignmentVerified: true,
    packageRedeployVerified: true,
    reconcileVerified: true,
    outcome: "succeeded",
  },
  "backup-restore-rehearsal": {
    rehearsalId: "backup-restore-20260809",
    backupId: "backup-123",
    backupCompletedAt: isoBefore(180),
    restoreStartedAt: isoBefore(120),
    restoreCompletedAt: isoBefore(60),
    restoredNamespace: "phase-authority-restore",
    sourceHead: { ...current.head },
    restoredHead: { ...current.head },
    integrityCheckSha256: hash("c"),
    recoveryPointObjectiveSeconds: 300,
    observedRecoveryPointSeconds: 60,
    recoveryTimeObjectiveSeconds: 120,
    observedRecoveryTimeSeconds: 60,
    dataLossObserved: false,
    outcome: "succeeded",
  },
  "startup-waf-observation": {
    provider: policies.providerPolicy.provider,
    deploymentId: deploymentBinding.providerDeploymentId,
    wafConfigurationSha256: hash("d"),
    profileResults: policies.startupBurstContract.profiles.map((profile) => {
      const expectedRequestCount = profile.expectedTuples.reduce(
        (sum, tuple) => sum + tuple.maximumCount,
        0,
      );
      return {
        id: profile.id,
        expectedRequestCount,
        allowedRequestCount: expectedRequestCount,
        rateLimitedRequestCount: 0,
      };
    }),
    overLimitProbe: {
      sentRequestCount: 20,
      allowedRequestCount: 10,
      rateLimitedRequestCount: 10,
    },
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    outcome: "succeeded",
  },
  "pwa-multiclient-drill": {
    deploymentId: deploymentBinding.providerDeploymentId,
    controllerSourceSha: sourceSha,
    clients: [
      {
        clientIdSha256: hash("a"),
        clientKind: "browser-tab",
        browserFamily: "chromium",
        browserVersion: "140.0.0.0",
        closedBeforeActivation: true,
        nextLaunchControlled: true,
        offlineCapabilityVerified: true,
        rollbackForwardVerified: true,
        legacyDeleteCount: 0,
      },
      {
        clientIdSha256: hash("b"),
        clientKind: "installed-pwa",
        browserFamily: "chromium",
        browserVersion: "140.0.0.0",
        closedBeforeActivation: true,
        nextLaunchControlled: true,
        offlineCapabilityVerified: true,
        rollbackForwardVerified: true,
        legacyDeleteCount: 0,
      },
    ],
    outcome: "succeeded",
  },
  "production-request-graph": {
    deploymentId: deploymentBinding.providerDeploymentId,
    graphSha256: hash("e"),
    totalRequestCount: 24,
    sameOriginRequestCount: 24,
    tailwindCdnRequestCount: 0,
    remoteFontRequestCount: 0,
    runtimeCssWriteCount: 0,
    unexpectedOrigins: [],
    outcome: "succeeded",
  },
  "csp-report-observation": {
    deploymentId: deploymentBinding.providerDeploymentId,
    headerName: "Content-Security-Policy-Report-Only",
    reportEndpoint: cspPolicy.reportEndpoint,
    reportRouteStatus: 204,
    canonicalScenarioCount: 12,
    unexpectedFirstPartyViolationCount: 0,
    expectedNoiseCount: 1,
    storedSanitizedReportCount: 1,
    databaseFingerprint: releaseContext.dbCompatibility.fingerprint,
    outcome: "succeeded",
  },
  "deployed-csp-flow": {
    deploymentId: deploymentBinding.providerDeploymentId,
    headerName: "Content-Security-Policy",
    policySha256: sha256Json(cspPolicy),
    reportEndpoint: cspPolicy.reportEndpoint,
    reportRouteStatus: 204,
    flows: [
      "api-error",
      "blob-download",
      "normal",
      "offline",
      "pwa-update",
      "recovery",
      "worker",
    ].map((id) => ({ id, outcome: "succeeded" })),
    unexpectedViolationCount: 0,
    outcome: "succeeded",
  },
  "idb-device-compatibility": {
    deploymentId: deploymentBinding.providerDeploymentId,
    indexedDbContractSha256: sha256Json(policies.databaseContract.indexedDb),
    clients: [
      {
        clientIdSha256: hash("c"),
        browserFamily: "chromium",
        browserVersion: "140.0.0.0",
        installedMode: false,
        compatibilityOutcome: "compatible",
        rawConflictEvidencePreserved: true,
        syncQueueSemanticsPreserved: true,
        cleanupCallCount: 0,
      },
      {
        clientIdSha256: hash("d"),
        browserFamily: "chromium",
        browserVersion: "140.0.0.0",
        installedMode: true,
        compatibilityOutcome: "compatible",
        rawConflictEvidencePreserved: true,
        syncQueueSemanticsPreserved: true,
        cleanupCallCount: 0,
      },
    ],
    outcome: "succeeded",
  },
});

const kinds = {
  "external-bindings": "phase-exit-external-bindings/v1",
  "bootstrap-recovery-drill": "phase-exit-bootstrap-recovery-drill/v1",
  "quality-run": "phase-exit-quality-run/v1",
  "artifact-provider-control-store-drill":
    "phase-exit-artifact-provider-control-store-drill/v1",
  "backup-restore-rehearsal": "phase-exit-backup-restore-rehearsal/v1",
  "startup-waf-observation": "phase-exit-startup-waf-observation/v1",
  "pwa-multiclient-drill": "phase-exit-pwa-multiclient-drill/v1",
  "production-request-graph": "phase-exit-production-request-graph/v1",
  "csp-report-observation": "phase-exit-csp-report-observation/v1",
  "deployed-csp-flow": "phase-exit-deployed-csp-flow/v1",
  "idb-device-compatibility": "phase-exit-idb-device-compatibility/v1",
};

const createExternalBindingsReviewedArtifactFixture = async () => {
  const policies = configuredPolicies();
  const applicationCa =
    "-----BEGIN CERTIFICATE-----\nphase-exit-application-ca\n-----END CERTIFICATE-----";
  const controlCa =
    "-----BEGIN CERTIFICATE-----\nphase-exit-control-ca\n-----END CERTIFICATE-----";
  Object.assign(policies.p0aPolicy, {
    bindingStatus: "configured",
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
    blockerCodes: [],
  });
  policies.p0aPolicy.bootstrapRecovery.deploymentBindingSha256 = hash("b");
  Object.assign(policies.databaseContract.remote.observationAuthority, {
    bindingStatus: "configured",
    allowedHosts: ["database.example.test"],
    allowedDatabases: ["foundation_app"],
    allowedObserverRoles: ["foundation_observer"],
    productionCaSha256: sha256Bytes(Buffer.from(applicationCa, "utf8")),
  });
  Object.assign(policies.storePolicy, {
    bindingStatus: "configured",
    allowedHosts: ["control.example.test"],
    allowedDatabases: ["foundation_release"],
    allowedExecutorRoles: ["foundation_release_executor"],
    productionCaSha256: sha256Bytes(Buffer.from(controlCa, "utf8")),
    backupOwner: "github-team:control-backup",
    restoreOwner: "github-team:control-restore",
    blockerCodes: [],
  });
  const current = {
    head: { sequence: 0, eventHash: null },
    snapshot: null,
    records: [],
  };
  const store = createAuthorityMemoryStore({ current });
  const runId = "61001";
  const runAttempt = "1";
  const oidcValue = remoteProducerOidcReceipt({
    approvalPolicy: policies.approvalPolicy,
    runId,
    runAttempt,
  });
  const oidcReceipt = await putAuthorityFixtureValue(
    store,
    oidcValue,
    GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  );
  const observation = await collectAndStoreFoundationExternalBindings(
    {
      approvalPolicy: policies.approvalPolicy,
      databaseContract: policies.databaseContract,
      environment: {
        GITHUB_SHA: sourceSha,
        VERCEL_TOKEN: "fixture-provider-token",
        DB_COMPATIBILITY_OBSERVER_DATABASE_URL:
          "postgresql://foundation_observer:secret@database.example.test/foundation_app?sslmode=verify-full",
        DB_COMPATIBILITY_OBSERVER_CA_PEM: applicationCa,
        RELEASE_STATE_DATABASE_URL:
          "postgresql://foundation_release_executor:secret@control.example.test/foundation_release?sslmode=verify-full",
        RELEASE_STATE_DATABASE_CA_PEM: controlCa,
      },
      namespace,
      oidcAuthority: {
        approvalPolicy: policies.approvalPolicy,
        runId,
        runAttempt,
      },
      oidcReceipt,
      p0aPolicy: policies.p0aPolicy,
      providerPolicy: policies.providerPolicy,
      store,
      storePolicy: policies.storePolicy,
    },
    {
      collectProviderObservation: async () =>
        remoteProviderObservation(policies.providerPolicy),
      putProviderObservation: putRemoteDbProviderObservationAuthority,
      observeDatabase: async () => ({
        engine: "postgresql",
        postgresMajor: 17,
        host: "database.example.test",
        database: "foundation_app",
        observerRole: "foundation_observer",
        tlsMode: "verify-full",
        productionCaSha256:
          policies.databaseContract.remote.observationAuthority
            .productionCaSha256,
        transactionReadOnly: true,
        provisioningStatus: "provisioned",
        credentialOwner: "github-team:database-observers",
        backupOwner: "github-team:database-backup",
        restoreOwner: "github-team:database-restore",
        observedAt,
      }),
      clock: () => Date.parse(observedAt),
    },
  );
  const artifact = await createReviewedArtifactFixture({
    authority: "external-bindings",
    approvalPolicy: policies.approvalPolicy,
    fileBytes: canonicalJsonBytes(observation),
    runId,
    runAttempt,
    store,
  });
  const subject = {
    kind: "repository-phase-subject/v1",
    sourceSha,
  };
  const releaseContext = projectPhaseExitAuthorityReleaseContext({
    current,
    namespace,
  });
  const raw = await readPhaseExitArtifactCollectorEvidence({
    authority: "external-bindings",
    collectorAuthority: artifact.readback,
    store,
    namespace,
    sourceSha,
    subject,
    releaseContext,
    current,
    ...policies,
  });
  const evidence = buildBrowserPhaseExitEvidence({
    authority: "external-bindings",
    observation: raw.observation,
    collectorAuthority: artifact.reference,
    subject,
    sourceSha,
  });
  return { artifact, evidence, observation, policies, raw, store };
};

test("derives P0-BASELINE external bindings from a reviewed artifact and raw immutable authority", async () => {
  const fixture = await createExternalBindingsReviewedArtifactFixture();
  assert.deepEqual(fixture.raw.observation, fixture.observation);
  assert.deepEqual(fixture.evidence.value.result, fixture.observation.result);
  assert.equal(
    fixture.evidence.value.collectorAuthority.sha256,
    fixture.artifact.reference.sha256,
  );
  assert.equal(
    fixture.evidence.bytes.equals(canonicalJsonBytes(fixture.evidence.value)),
    true,
  );
});

const configureBackupRestoreFixture = (policies) => {
  const sourceProjectRef = "abcdefghijklmnopqrst";
  const restoreProjectRef = "abcdefghijklmnopqrsu";
  const sourceCa =
    "-----BEGIN CERTIFICATE-----\nphase-exit-backup-source\n-----END CERTIFICATE-----";
  const restoreCa =
    "-----BEGIN CERTIFICATE-----\nphase-exit-backup-restore\n-----END CERTIFICATE-----";
  const prerequisitePolicy = policies.backupRestorePrerequisitePolicy;
  prerequisitePolicy.backupRestore = {
    ...prerequisitePolicy.backupRestore,
    bindingStatus: "configured",
    provider: "supabase",
    apiOrigin: "https://api.supabase.com",
    sourceProjectRef,
    restoreTarget: {
      ...prerequisitePolicy.backupRestore.restoreTarget,
      projectRef: restoreProjectRef,
    },
    owner: "github-team:acme/backup-operators",
  };
  prerequisitePolicy.blockerCodes = prerequisitePolicy.blockerCodes.filter(
    (code) => !code.startsWith("backup-"),
  );
  const response = (recoveryPoint) => ({
    resourceIdPointer: "/id",
    statePointer: "/state",
    recoveryPointAtPointer: recoveryPoint ? "/recovery_point_at" : null,
  });
  const operation = (
    method,
    pathTemplate,
    requestBodyTemplate,
    recoveryPoint,
    status,
  ) => ({
    method,
    pathTemplate,
    requestBodyTemplate,
    successStatusCodes: [status],
    response: response(recoveryPoint),
  });
  const providerContract = {
    schemaVersion: 1,
    kind: "backup-restore-provider-contract/v1",
    bindingStatus: "configured",
    provider: "supabase",
    api: {
      authentication: {
        scheme: "bearer",
        credentialEnvironmentName: "FOUNDATION_BACKUP_API_TOKEN",
      },
      backupMode: "pitr",
      maximumResponseBytes: 64 * 1024,
      requestTimeoutMilliseconds: 5_000,
      polling: { intervalMilliseconds: 100, maximumAttempts: 4 },
      operations: {
        cleanupRestore: operation(
          "DELETE",
          "/v1/projects/{restoreProjectRef}/restores/{restoreId}",
          null,
          false,
          202,
        ),
        createBackup: operation(
          "POST",
          "/v1/projects/{sourceProjectRef}/backups",
          { type: "pitr" },
          true,
          202,
        ),
        getBackup: operation(
          "GET",
          "/v1/projects/{sourceProjectRef}/backups/{backupId}",
          null,
          true,
          200,
        ),
        getCleanup: operation(
          "GET",
          "/v1/projects/{restoreProjectRef}/restores/{restoreId}",
          null,
          false,
          200,
        ),
        getRestore: operation(
          "GET",
          "/v1/projects/{restoreProjectRef}/restores/{restoreId}",
          null,
          false,
          200,
        ),
        restoreBackup: operation(
          "POST",
          "/v1/projects/{restoreProjectRef}/restores",
          { backup_id: "{backupId}" },
          false,
          202,
        ),
      },
      states: {
        backupPending: ["backup-pending"],
        backupReady: "backup-ready",
        cleanupPending: ["cleanup-pending"],
        cleanupReady: "cleanup-ready",
        failed: ["failed"],
        restorePending: ["restore-pending"],
        restoreReady: "restore-ready",
      },
    },
    database: {
      connectTimeoutMilliseconds: 5_000,
      statementTimeoutMilliseconds: 10_000,
      postgresMajor: 17,
      tlsMode: "verify-full",
      integrityFunction: "read_foundation_backup_restore_integrity",
      queryName: "foundation-backup-restore-integrity-v1",
      source: {
        databaseUrlEnvironmentName: "FOUNDATION_BACKUP_SOURCE_DATABASE_URL",
        databaseCaEnvironmentName: "FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM",
        allowedHosts: ["source.db.example.test"],
        allowedDatabases: ["app_source"],
        allowedRoles: ["backup_source"],
        caSha256: sha256Bytes(Buffer.from(sourceCa, "utf8")),
      },
      restore: {
        databaseUrlEnvironmentName: "FOUNDATION_BACKUP_RESTORE_DATABASE_URL",
        databaseCaEnvironmentName: "FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM",
        allowedHosts: ["restore.db.example.test"],
        allowedDatabases: ["app_restore"],
        allowedRoles: ["backup_restore"],
        caSha256: sha256Bytes(Buffer.from(restoreCa, "utf8")),
      },
    },
  };
  policies.backupRestoreProviderContract = providerContract;
  return {
    prerequisitePolicy,
    providerContract,
    sourceProjectRef,
    restoreProjectRef,
    environment: {
      GITHUB_SHA: sourceSha,
      FOUNDATION_BACKUP_API_TOKEN: "fixture-backup-token",
      FOUNDATION_BACKUP_SOURCE_DATABASE_URL:
        "postgresql://backup_source:secret@source.db.example.test/app_source?sslmode=verify-full",
      FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM: sourceCa,
      FOUNDATION_BACKUP_RESTORE_DATABASE_URL:
        "postgresql://backup_restore:secret@restore.db.example.test/app_restore?sslmode=verify-full",
      FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM: restoreCa,
    },
  };
};

const createBackupProviderResult = ({ contract, operationName, variables }) => {
  const descriptor = contract.api.operations[operationName];
  const offsets = {
    createBackup: [95, 94],
    getBackup: [90, 89],
    restoreBackup: [85, 84],
    getRestore: [50, 49],
    cleanupRestore: [48, 47],
    getCleanup: [45, 44],
  }[operationName];
  const state = {
    createBackup: "backup-pending",
    getBackup: "backup-ready",
    restoreBackup: "restore-pending",
    getRestore: "restore-ready",
    cleanupRestore: "cleanup-pending",
    getCleanup: "cleanup-ready",
  }[operationName];
  const resourceId = ["createBackup", "getBackup"].includes(operationName)
    ? "backup-id-immutable"
    : "restore-id-immutable";
  const render = (value) => {
    if (
      typeof value === "string" &&
      /^\{[A-Za-z][A-Za-z0-9]*\}$/u.test(value)
    ) {
      return variables[value.slice(1, -1)];
    }
    if (Array.isArray(value)) return value.map(render);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, render(entry)]),
      );
    }
    return value;
  };
  const requestBytes =
    descriptor.requestBodyTemplate === null
      ? Buffer.alloc(0)
      : canonicalJsonBytes(render(descriptor.requestBodyTemplate));
  const recoveryPointAt = descriptor.response.recoveryPointAtPointer
    ? new Date(now - 120_000).toISOString()
    : null;
  const responseBytes = canonicalJsonBytes({
    id: resourceId,
    state,
    ...(recoveryPointAt === null ? {} : { recovery_point_at: recoveryPointAt }),
  });
  const path = descriptor.pathTemplate.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/gu,
    (_match, name) => encodeURIComponent(variables[name]),
  );
  return {
    receipt: {
      operation: operationName,
      method: descriptor.method,
      url: new URL(path, "https://api.supabase.com").href,
      startedAt: new Date(now - offsets[0] * 1_000).toISOString(),
      completedAt: new Date(now - offsets[1] * 1_000).toISOString(),
      status: descriptor.successStatusCodes[0],
      contentType: "application/json",
      providerRequestId: `request-${operationName}`,
      requestBodySha256: sha256Bytes(requestBytes),
      requestBodyByteLength: requestBytes.length,
      responseBodySha256: sha256Bytes(responseBytes),
      responseBodyByteLength: responseBytes.length,
    },
    normalized: { resourceId, state, recoveryPointAt },
  };
};

const createBackupDatabaseReceipt = ({
  target,
  current,
  sourceProjectRef,
  restoreProjectRef,
}) => ({
  target,
  projectRef: target === "source" ? sourceProjectRef : restoreProjectRef,
  host: `${target}.db.example.test`,
  database: target === "source" ? "app_source" : "app_restore",
  role: target === "source" ? "backup_source" : "backup_restore",
  tlsMode: "verify-full",
  transactionReadOnly: true,
  postgresMajor: 17,
  queryName: "foundation-backup-restore-integrity-v1",
  observedAt: new Date(now - 48_000).toISOString(),
  authorization: {
    roleAttributes: {
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
    },
    memberships: [],
    ownedObjectCount: 0,
    privileges: {
      schemaUsage: true,
      schemaCreate: false,
      databaseCreate: false,
      tableCount: 4,
      allTablesSelect: true,
      anyTableInsert: false,
      anyTableUpdate: false,
      anyTableDelete: false,
      anyTableTruncate: false,
      anyTableReferences: false,
      anyTableTrigger: false,
      integrityFunctionExecute: true,
      integrityFunctionSecurityDefiner: true,
    },
    denialProbes: [
      {
        operation: "delete-known-public-table",
        sqlState: "42501",
        targetSha256: hash("5"),
      },
      {
        operation: "create-public-table",
        sqlState: "42501",
        targetSha256: hash("6"),
      },
    ],
  },
  databaseHead: hash("3"),
  compatibilityFingerprint: current.snapshot.currentDbCompatibility.fingerprint,
  integritySha256: hash("4"),
});

const collectBackupRestoreReviewedArtifactFixture = async ({
  policies,
  current,
  store,
  runId = "62001",
}) => {
  const configured = configureBackupRestoreFixture(policies);
  const runAttempt = "1";
  const oidcReceipt = await putAuthorityFixtureValue(
    store,
    remoteProducerOidcReceipt({
      approvalPolicy: policies.approvalPolicy,
      runId,
      runAttempt,
    }),
    GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  );
  const observation = await collectAndStoreBackupRestoreRehearsal(
    {
      current,
      environment: configured.environment,
      namespace,
      oidcAuthority: {
        approvalPolicy: policies.approvalPolicy,
        runId,
        runAttempt,
      },
      oidcReceipt,
      prerequisitePolicy: configured.prerequisitePolicy,
      providerContract: configured.providerContract,
      store,
    },
    {
      executeProviderOperation: async ({ operation, variables }) =>
        createBackupProviderResult({
          contract: configured.providerContract,
          operationName: operation,
          variables,
        }),
      observeDatabase: async ({ target }) =>
        createBackupDatabaseReceipt({
          target,
          current,
          sourceProjectRef: configured.sourceProjectRef,
          restoreProjectRef: configured.restoreProjectRef,
        }),
      sleep: async () => {},
      clock: () => now - 40_000,
      readState: async () => current,
    },
  );
  const artifact = await createReviewedArtifactFixture({
    authority: "backup-restore-rehearsal",
    approvalPolicy: policies.approvalPolicy,
    fileBytes: canonicalJsonBytes(observation),
    runId,
    runAttempt,
    store,
  });
  const subject = projectPhaseExitAuthoritySubject({
    current,
    targetGate: "P0-DATA",
    sourceSha,
    foundationBaseline: policies.foundationBaseline,
  });
  const releaseContext = projectPhaseExitAuthorityReleaseContext({ current });
  const raw = await readPhaseExitArtifactCollectorEvidence({
    authority: "backup-restore-rehearsal",
    collectorAuthority: artifact.readback,
    store,
    namespace,
    sourceSha,
    subject,
    releaseContext,
    current,
    ...policies,
  });
  const evidence = buildBrowserPhaseExitEvidence({
    authority: "backup-restore-rehearsal",
    observation: raw.observation,
    collectorAuthority: artifact.reference,
    subject,
    sourceSha,
  });
  return { artifact, evidence, observation, raw };
};

const createBackupRestoreReviewedArtifactFixture = async () => {
  const policies = configuredPolicies();
  const current = makeCurrent(policies.databaseContract, { preRelease: true });
  const store = createAuthorityMemoryStore({ current });
  return collectBackupRestoreReviewedArtifactFixture({
    policies,
    current,
    store,
  });
};

test("derives P0-DATA backup closure from a reviewed artifact and raw immutable authority", async () => {
  const fixture = await createBackupRestoreReviewedArtifactFixture();
  assert.deepEqual(fixture.raw.observation, fixture.observation);
  assert.deepEqual(fixture.evidence.value.result, fixture.observation.result);
  assert.equal(
    fixture.evidence.value.collectorAuthority.sha256,
    fixture.artifact.reference.sha256,
  );
});

const createStartupWafReviewedArtifactFixture = async () => {
  const policies = configuredPolicies();
  policies.providerPolicy.wafRules.metricsRoute.rateLimit = {
    algo: "fixed_window",
    keys: ["ip"],
    limit: 5,
    window: 60,
  };
  const providerObservation = remoteProviderObservation(
    policies.providerPolicy,
  );
  const current = {};
  const store = createAuthorityMemoryStore({ current });
  const policyReference = await putAuthorityFixtureValue(
    store,
    policies.providerPolicy,
    REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  );
  const reference = (character) => ({
    uri: `release-state://${namespace}/evidence/${hash(character)}`,
    sha256: hash(character),
  });
  const dbCompatibility = {
    contractUri: policies.databaseContract.contractUri,
    fingerprint: sha256Json(policies.databaseContract),
  };
  const providerConfiguration = providerConfigurationHash(providerObservation);
  const artifactManifest = reference("1");
  const packageIndex = reference("2");
  const releasePolicy = reference("3");
  const providerEvidence = {
    schemaVersion: 1,
    providerProjectId: policies.providerPolicy.expectedProjectId,
    providerDeploymentId: bootstrapRecoveryBinding.providerDeploymentId,
    deploymentUrl: bootstrapRecoveryBinding.deploymentUrl,
    sourceSha: bootstrapSourceSha,
    variantId: hash("b"),
    releaseRole: "containment",
    artifactManifestHash: artifactManifest.sha256,
    packageIndexHash: packageIndex.sha256,
    providerConfigurationHash: providerConfiguration,
    providerPolicyHash: policyReference.sha256,
    releasePolicyHash: releasePolicy.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentity: { identityKind: "legacy-bootstrap-v1" },
    routeProbeEvidenceHash: hash("c"),
    environmentPresenceEvidenceHash: hash("d"),
  };
  const providerEvidenceReference = await putAuthorityFixtureValue(
    store,
    providerEvidence,
    "application/vnd.event-shopping-planner.provider-deployment-evidence+json;version=1",
  );
  const binding = {
    bindingId: bootstrapRecoveryBinding.bindingId,
    sourceSha: bootstrapSourceSha,
    buildId: bootstrapSourceSha,
    variantId: hash("b"),
    releaseRole: "containment",
    publicIdentityKind: "legacy-bootstrap-v1",
    providerProjectId: policies.providerPolicy.expectedProjectId,
    providerDeploymentId: bootstrapRecoveryBinding.providerDeploymentId,
    deploymentUrl: bootstrapRecoveryBinding.deploymentUrl,
    artifactArchive: bootstrapRecoveryBinding.artifactArchive,
    artifactArchiveAvailability: reference("4"),
    packageIndex,
    artifactManifest,
    providerEvidence: providerEvidenceReference,
    providerPolicy: policyReference,
    releasePolicy,
    providerConfigurationHash: providerConfiguration,
    requiredDbCompatibility: dbCompatibility,
  };
  const initializationRecord = {
    sequence: 1,
    eventHash: hash("e"),
    event: {
      namespace,
      sequence: 1,
      previousEventHash: null,
      eventType: "state-initialized",
      operationId: "initialize-startup-waf-fixture",
      payload: {
        executorSourceSha: sourceSha,
        bootstrapRecovery: binding,
      },
    },
  };
  Object.assign(current, {
    head: { sequence: 1, eventHash: initializationRecord.eventHash },
    snapshot: {
      currentDbCompatibility: dbCompatibility,
      activeProduction: null,
      acceptedStandard: null,
      acceptedGate: null,
      pendingOperation: null,
      pendingAcceptance: null,
      containmentCompanion: null,
      bootstrapRecovery: binding,
    },
    records: [initializationRecord],
  });
  const startupFixtures = new Map(
    await Promise.all(
      policies.startupBurstContract.profiles.map(async (profile) => [
        profile.id,
        await readFile(profile.fixturePath),
      ]),
    ),
  );
  const metricsContract = await readJsonStrict(
    "contracts/persistence-release-a-metrics-v1.json",
  );
  const runId = "63001";
  const runAttempt = "1";
  const oidcValue = remoteProducerOidcReceipt({
    approvalPolicy: policies.approvalPolicy,
    runId,
    runAttempt,
  });
  let contextIndex = 0;
  const browser = {
    async newContext() {
      const currentContext = contextIndex;
      contextIndex += 1;
      let requestIndex = 0;
      return {
        request: {
          async fetch(url) {
            const status =
              currentContext < policies.startupBurstContract.profiles.length ||
              requestIndex < 5
                ? 202
                : 429;
            requestIndex += 1;
            return {
              status: () => status,
              url: () => url,
              headers: () => ({
                date: new Date(now).toUTCString(),
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
        async close() {},
      };
    },
    async close() {},
  };
  const collected = await collectAndStoreStartupWafObservation(
    {
      store,
      namespace,
      sourceSha,
      providerPolicy: policies.providerPolicy,
      approvalPolicy: policies.approvalPolicy,
      startupContract: policies.startupBurstContract,
      metricsContract,
      fixtures: startupFixtures,
      environment: {
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: runAttempt,
        VERCEL_TOKEN: "fixture-provider-token",
      },
    },
    {
      readState: async () => current,
      collectProviderObservation: async () => providerObservation,
      collectProducerOidc: async () => canonicalJsonBytes(oidcValue),
      launchBrowser: async () => browser,
      clock: () => now,
    },
  );
  const collectorOutput = {
    schemaVersion: 1,
    resultKind: "startup-waf-observation-stored/v1",
    namespace,
    sourceSha,
    workflowRunId: runId,
    runAttempt,
    mediaTypes: {
      authority:
        "application/vnd.event-shopping-planner.startup-waf-observation+json;version=1",
    },
    authority: collected.reference,
    transcript: collected.transcriptReference,
  };
  const artifact = await createReviewedArtifactFixture({
    authority: "startup-waf-observation",
    approvalPolicy: policies.approvalPolicy,
    fileBytes: canonicalJsonBytes(collectorOutput),
    runId,
    runAttempt,
    store,
  });
  const subject = projectPhaseExitAuthoritySubject({
    current,
    targetGate: "P0-DATA",
    sourceSha,
    foundationBaseline: policies.foundationBaseline,
  });
  const releaseContext = projectPhaseExitAuthorityReleaseContext({ current });
  const raw = await readPhaseExitArtifactCollectorEvidence({
    authority: "startup-waf-observation",
    collectorAuthority: artifact.readback,
    store,
    namespace,
    sourceSha,
    subject,
    releaseContext,
    current,
    ...policies,
  });
  const evidence = buildBrowserPhaseExitEvidence({
    authority: "startup-waf-observation",
    observation: raw.observation,
    collectorAuthority: artifact.reference,
    subject,
    sourceSha,
  });
  return {
    artifact,
    collected,
    collectorOutput,
    current,
    evidence,
    policies,
    raw,
    store,
    subject,
  };
};

test("derives P0-DATA startup WAF closure from a reviewed artifact and raw immutable transcript", async () => {
  const fixture = await createStartupWafReviewedArtifactFixture();
  assert.deepEqual(fixture.evidence.value.result, fixture.collected.result);
  assert.equal(
    fixture.raw.raw.authority.transcript.sha256,
    fixture.collectorOutput.transcript.sha256,
  );
  assert.equal(
    fixture.evidence.value.collectorAuthority.sha256,
    fixture.artifact.reference.sha256,
  );
});

test("resolves the complete P0-DATA reviewed artifact and raw authority bundle", async () => {
  const startup = await createStartupWafReviewedArtifactFixture();
  const { policies, current, store, subject } = startup;
  const backup = await collectBackupRestoreReviewedArtifactFixture({
    policies,
    current,
    store,
    runId: "62002",
  });
  const retention = retentionEvidence(policies.retentionPolicy);
  retention.collectorIdentity = {
    repository: policies.approvalPolicy.repository,
    workflowPath: ".github/workflows/metrics-retention.yml",
    sourceSha,
    runId: "64001",
    runAttempt: "1",
  };
  const retentionArtifact = await createReviewedArtifactFixture({
    authority: "retention",
    approvalPolicy: policies.approvalPolicy,
    fileBytes: canonicalJsonBytes(retention),
    runId: retention.collectorIdentity.runId,
    store,
  });
  const remote = remoteDbEvidence(policies.databaseContract);
  const remoteReference = await putAuthorityFixtureValue(
    store,
    remote,
    REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  );
  const remoteRun =
    startup.artifact.readback.artifactReceipt.reviewedWorkflowRun;
  const remoteRunId = startup.artifact.readback.receipt.runId;
  const remoteRunAttempt = startup.artifact.readback.receipt.runAttempt;
  const productionReceipt = await putAuthorityFixtureValue(
    store,
    {
      schemaVersion: 1,
      authorityKind: "protected-remote-db-observation-production/v1",
      namespace,
      sourceSha,
      workflowPath: ".github/workflows/release.yml",
      operation: "collect-remote-db-observation",
      runId: remoteRunId,
      runAttempt: remoteRunAttempt,
      observation: remoteReference,
      providerObservation: startup.collected.authority.providerObservation,
      providerPolicy: startup.collected.authority.providerPolicy,
      producerOidc: startup.collected.authority.producerOidc,
    },
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  const reviewedProduction = await putAuthorityFixtureValue(
    store,
    {
      schemaVersion: 1,
      authorityKind: "reviewed-remote-db-observation-production/v1",
      namespace,
      sourceSha,
      workflowPath: ".github/workflows/release.yml",
      operation: "collect-remote-db-observation",
      runId: remoteRunId,
      runAttempt: remoteRunAttempt,
      repository: policies.approvalPolicy.repository,
      observation: remoteReference,
      providerObservation: startup.collected.authority.providerObservation,
      providerPolicy: startup.collected.authority.providerPolicy,
      producerOidc: startup.collected.authority.producerOidc,
      productionReceipt,
      reviewedWorkflowRun: remoteRun,
    },
    REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  const mediaTypeByAuthority = new Map(
    PHASE_EXIT_EXTERNAL_AUTHORITIES.map(({ authority, mediaType }) => [
      authority,
      mediaType,
    ]),
  );
  const retentionReference = await putAuthorityFixtureValue(
    store,
    retention,
    mediaTypeByAuthority.get("retention"),
  );
  const backupReference = await putAuthorityFixtureBytes(
    store,
    backup.evidence.bytes,
    mediaTypeByAuthority.get("backup-restore-rehearsal"),
  );
  const startupReference = await putAuthorityFixtureBytes(
    store,
    startup.evidence.bytes,
    mediaTypeByAuthority.get("startup-waf-observation"),
  );
  const entries = [
    {
      gate: "P0-DATA",
      authority: "remote-db",
      sourceSha,
      observedAt: remote.observedAt,
      subject,
      collectorAuthority: remoteRun,
      productionAuthority: reviewedProduction,
      evidence: remoteReference,
    },
    {
      gate: "P0-DATA",
      authority: "retention",
      sourceSha,
      observedAt: retention.observedAt,
      subject,
      collectorAuthority: retentionArtifact.reference,
      productionAuthority: null,
      evidence: retentionReference,
    },
    {
      gate: "P0-DATA",
      authority: "backup-restore-rehearsal",
      sourceSha,
      observedAt: backup.evidence.observedAt,
      subject,
      collectorAuthority: backup.artifact.reference,
      productionAuthority: null,
      evidence: backupReference,
    },
    {
      gate: "P0-DATA",
      authority: "startup-waf-observation",
      sourceSha,
      observedAt: startup.evidence.observedAt,
      subject,
      collectorAuthority: startup.artifact.reference,
      productionAuthority: null,
      evidence: startupReference,
    },
  ];
  const bundle = {
    schemaVersion: 1,
    kind: "phase-exit-external-authority-bundle/v1",
    namespace,
    sourceSha,
    releaseStateHead: { ...current.head },
    createdAt: observedAt,
    targetGate: "P0-DATA",
    entries,
  };
  const bundleReference = await putAuthorityFixtureValue(
    store,
    bundle,
    PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
  );
  const resolved = await resolveExternalPhaseExitAuthorities({
    store,
    bundleSha256: bundleReference.sha256,
    current,
    sourceSha,
    providerPolicy: policies.providerPolicy,
    approvalPolicy: policies.approvalPolicy,
    storePolicy: policies.storePolicy,
    databaseContract: policies.databaseContract,
    retentionPolicy: policies.retentionPolicy,
    startupBurstContract: policies.startupBurstContract,
    cspPolicy,
    backupRestorePrerequisitePolicy: policies.backupRestorePrerequisitePolicy,
    backupRestoreProviderContract: policies.backupRestoreProviderContract,
    artifactDrillPolicy: policies.artifactDrillPolicy,
    releasePolicy: policies.releasePolicy,
    toolchainPolicy: policies.toolchainPolicy,
    foundationBaseline: policies.foundationBaseline,
    p0aPolicy: policies.p0aPolicy,
    currentWorkflowRunId: "65001",
  });
  assert.deepEqual(
    resolved.references.map(({ authority }) => authority),
    entries.map(({ authority }) => authority),
  );
});

const createFixture = async ({
  targetGate = "P0-TOOLCHAIN",
  mutateValues = () => {},
  mutateBundle = () => {},
  mutateStored = () => {},
} = {}) => {
  const policies = configuredPolicies();
  const current = makeCurrent(policies.databaseContract, {
    preRelease: targetGate === "P0-DATA",
  });
  const releaseContext = projectPhaseExitAuthorityReleaseContext({ current });
  const subject = projectPhaseExitAuthoritySubject({
    current,
    targetGate,
    sourceSha,
    foundationBaseline: policies.foundationBaseline,
  });
  const results = customResults({ policies, current, releaseContext });
  const fixtureAuthorities = genericFixtureAuthorities.filter(
    ({ gate }) => gate === targetGate,
  );
  if (fixtureAuthorities.length === 0) {
    throw new Error(`Fixture target gate has no authorities: ${targetGate}`);
  }
  const values = new Map();
  for (const definition of fixtureAuthorities) {
    let value;
    if (definition.authority === "physical-performance") {
      value = ownGatePerformanceEvidence({ current });
    } else if (definition.authority === "remote-db") {
      value = remoteDbEvidence(policies.databaseContract);
    } else if (definition.authority === "retention") {
      value = retentionEvidence(policies.retentionPolicy);
    } else {
      value = {
        schemaVersion: 1,
        evidenceKind: kinds[definition.authority],
        gate: definition.gate,
        authority: definition.authority,
        sourceSha,
        observedAt,
        subject,
        result: results[definition.authority],
      };
    }
    values.set(definition.authority, value);
  }
  const objects = new Map();
  const putBytes = (input, mediaType) => {
    const bytes = Buffer.from(input);
    const sha256 = sha256Bytes(bytes);
    objects.set(sha256, {
      bytes,
      mediaType,
      committedAt: new Date(now - 10_000).toISOString(),
    });
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
    };
  };
  const putValue = (value, mediaType) =>
    putBytes(canonicalJsonBytes(value), mediaType);
  const collectorReferenceByPath = new Map();
  const collectorRunByPath = new Map();
  const collectorWorkflowPaths = [
    ...new Set(
      fixtureAuthorities.map(
        ({ collectorWorkflowPath }) => collectorWorkflowPath,
      ),
    ),
  ];
  for (const [index, workflowPath] of collectorWorkflowPaths.entries()) {
    const runId = String(20_000 + index);
    const apiResponse = putValue(
      {
        id: runId,
        run_attempt: 1,
        event:
          workflowPath === ".github/workflows/quality.yml"
            ? "push"
            : "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: sourceSha,
        path: workflowPath,
        repository: { full_name: policies.approvalPolicy.repository },
      },
      GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
    );
    const receipt = putValue(
      {
        schemaVersion: 1,
        kind: "reviewed-github-workflow-run/v1",
        repository: policies.approvalPolicy.repository,
        runId,
        runAttempt: "1",
        workflowPath,
        event:
          workflowPath === ".github/workflows/quality.yml"
            ? "push"
            : "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        headBranch: "main",
        headSha: sourceSha,
        apiResponse,
      },
      REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
    );
    collectorReferenceByPath.set(workflowPath, receipt);
    collectorRunByPath.set(workflowPath, { runId, runAttempt: "1" });
  }
  const releaseCollectorRun = collectorRunByPath.get(
    ".github/workflows/release.yml",
  );
  const retentionCollectorRun = collectorRunByPath.get(
    ".github/workflows/metrics-retention.yml",
  );
  if (values.has("retention")) {
    values.get("retention").collectorIdentity = {
      repository: policies.approvalPolicy.repository,
      workflowPath: ".github/workflows/metrics-retention.yml",
      sourceSha,
      runId: retentionCollectorRun.runId,
      runAttempt: retentionCollectorRun.runAttempt,
    };
  }
  mutateValues(values, { policies, current, releaseContext, subject });
  if (values.has("physical-performance")) {
    const performanceValue = values.get("physical-performance");
    performanceValue.producerReceipt.receipt.producerRunId =
      releaseCollectorRun.runId;
    performanceValue.producerReceipt.receipt.producerRunAttempt =
      releaseCollectorRun.runAttempt;
    performanceValue.producerReceipt.receiptSha256 = sha256Json(
      performanceValue.producerReceipt.receipt,
    );
  }
  const collectorReferenceByAuthority = new Map();
  for (const [index, definition] of fixtureAuthorities
    .filter(({ authority }) => authority !== "remote-db")
    .entries()) {
    const run = collectorRunByPath.get(definition.collectorWorkflowPath);
    const identity = getPhaseExitCollectorArtifactIdentity({
      authority: definition.authority,
      sourceSha,
      runAttempt: run.runAttempt,
    });
    let fileBytes;
    if (definition.authority === "quality-run") {
      const result = results[definition.authority];
      fileBytes = canonicalJsonBytes({
        schemaVersion: 1,
        kind: "phase-exit-quality-run-source/v1",
        repository: result.repository,
        workflowPath: result.workflowPath,
        workflowRunId: result.workflowRunId,
        workflowRunAttempt: result.workflowRunAttempt,
        event: result.event,
        headBranch: result.headBranch,
        headSha: result.headSha,
        observedAt,
        nodeVersion: result.nodeVersion,
        npmVersion: result.npmVersion,
        checks: result.checks,
      });
    } else {
      fileBytes = canonicalJsonBytes(values.get(definition.authority));
    }
    const archiveBytes = await createSingleFileZip(
      identity.fileName,
      fileBytes,
    );
    const artifactId = String(40_000 + index);
    const artifactName = identity.artifactName;
    const artifactArchive = putBytes(
      archiveBytes,
      GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE,
    );
    const artifactFile = putBytes(fileBytes, identity.fileMediaType);
    const artifactApiResponse = putValue(
      {
        total_count: 1,
        artifacts: [
          {
            id: artifactId,
            name: artifactName,
            expired: false,
            size_in_bytes: archiveBytes.length,
            digest: `sha256:${sha256Bytes(archiveBytes)}`,
            archive_download_url:
              `https://api.github.com/repos/${policies.approvalPolicy.repository}` +
              `/actions/artifacts/${artifactId}/zip`,
            workflow_run: {
              id: run.runId,
              head_sha: sourceSha,
            },
          },
        ],
      },
      GITHUB_WORKFLOW_ARTIFACT_RESPONSE_MEDIA_TYPE,
    );
    const artifactAuthority = putValue(
      {
        schemaVersion: 1,
        kind: "reviewed-github-workflow-artifact/v1",
        repository: policies.approvalPolicy.repository,
        runId: run.runId,
        runAttempt: run.runAttempt,
        sourceSha,
        workflowPath: definition.collectorWorkflowPath,
        artifactId,
        artifactName,
        artifactDigestSha256: sha256Bytes(archiveBytes),
        fileName: identity.fileName,
        artifactFileMediaType: identity.fileMediaType,
        reviewedWorkflowRun: collectorReferenceByPath.get(
          definition.collectorWorkflowPath,
        ),
        artifactApiResponse,
        artifactArchive,
        artifactFile,
      },
      REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
    );
    collectorReferenceByAuthority.set(definition.authority, artifactAuthority);
  }
  const entries = fixtureAuthorities.map((definition) => {
    const collectorAuthority =
      definition.authority === "remote-db"
        ? collectorReferenceByPath.get(definition.collectorWorkflowPath)
        : collectorReferenceByAuthority.get(definition.authority);
    const value = values.get(definition.authority);
    if (Object.hasOwn(value, "evidenceKind")) {
      value.collectorAuthority = collectorAuthority;
    }
    return {
      gate: definition.gate,
      authority: definition.authority,
      sourceSha,
      observedAt,
      subject,
      collectorAuthority,
      productionAuthority: null,
      evidence: putValue(value, definition.mediaType),
    };
  });
  const remoteEntry = entries.find(
    ({ authority }) => authority === "remote-db",
  );
  if (remoteEntry !== undefined) {
    const releaseWorkflowPath = ".github/workflows/release.yml";
    const remoteProducer = collectorRunByPath.get(releaseWorkflowPath);
    const providerPolicyReference = putValue(
      policies.providerPolicy,
      REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
    );
    const providerObservationReference = putValue(
      remoteProviderObservation(policies.providerPolicy),
      VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
    );
    const producerOidcReference = putValue(
      remoteProducerOidcReceipt({
        approvalPolicy: policies.approvalPolicy,
        runId: remoteProducer.runId,
        runAttempt: remoteProducer.runAttempt,
      }),
      GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
    );
    const productionReceipt = putValue(
      {
        schemaVersion: 1,
        authorityKind: "protected-remote-db-observation-production/v1",
        namespace,
        sourceSha,
        workflowPath: releaseWorkflowPath,
        operation: "collect-remote-db-observation",
        runId: remoteProducer.runId,
        runAttempt: remoteProducer.runAttempt,
        observation: remoteEntry.evidence,
        providerObservation: providerObservationReference,
        providerPolicy: providerPolicyReference,
        producerOidc: producerOidcReference,
      },
      REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
    );
    remoteEntry.productionAuthority = putValue(
      {
        schemaVersion: 1,
        authorityKind: "reviewed-remote-db-observation-production/v1",
        namespace,
        sourceSha,
        workflowPath: releaseWorkflowPath,
        operation: "collect-remote-db-observation",
        runId: remoteProducer.runId,
        runAttempt: remoteProducer.runAttempt,
        repository: policies.approvalPolicy.repository,
        observation: remoteEntry.evidence,
        providerObservation: providerObservationReference,
        providerPolicy: providerPolicyReference,
        producerOidc: producerOidcReference,
        productionReceipt,
        reviewedWorkflowRun: collectorReferenceByPath.get(releaseWorkflowPath),
      },
      REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
    );
  }
  const bundle = {
    schemaVersion: 1,
    kind: "phase-exit-external-authority-bundle/v1",
    namespace,
    sourceSha,
    releaseStateHead: { ...current.head },
    createdAt: observedAt,
    targetGate,
    entries,
  };
  mutateBundle(bundle, {
    values,
    objects,
    policies,
    current,
    releaseContext,
    subject,
  });
  const bundleReference = putValue(
    bundle,
    PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
  );
  const store = {
    namespace,
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { ...stored, bytes: Buffer.from(stored.bytes) };
    },
    async putEvidence({ bytes, mediaType }) {
      const input = Buffer.from(bytes);
      const sha256 = sha256Bytes(input);
      objects.set(sha256, {
        bytes: input,
        mediaType,
        committedAt: new Date(now - 10_000).toISOString(),
      });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: input.length,
        committedAt: new Date(now - 10_000).toISOString(),
        replayed: false,
      };
    },
  };
  mutateStored(objects, {
    bundle,
    bundleReference,
    policies,
    current,
    releaseContext,
    subject,
  });
  return {
    options: {
      store,
      bundleSha256: bundleReference.sha256,
      current,
      sourceSha,
      providerPolicy: policies.providerPolicy,
      approvalPolicy: policies.approvalPolicy,
      storePolicy: policies.storePolicy,
      databaseContract: policies.databaseContract,
      retentionPolicy: policies.retentionPolicy,
      startupBurstContract: policies.startupBurstContract,
      cspPolicy,
      backupRestorePrerequisitePolicy: policies.backupRestorePrerequisitePolicy,
      backupRestoreProviderContract: policies.backupRestoreProviderContract,
      artifactDrillPolicy: policies.artifactDrillPolicy,
      releasePolicy: policies.releasePolicy,
      toolchainPolicy: policies.toolchainPolicy,
      foundationBaseline: policies.foundationBaseline,
      p0aPolicy: policies.p0aPolicy,
      currentWorkflowRunId: "30000",
    },
    objects,
    bundle,
  };
};

test("resolves the four legacy collector authorities from their formal chain", async () => {
  const fixture = await createFixture();
  const resolved = await resolveExternalPhaseExitAuthorities(fixture.options);
  assert.equal(resolved.references.length, fixture.bundle.entries.length);
  assert.deepEqual(
    resolved.references.map(({ authority }) => authority),
    fixture.bundle.entries.map(({ authority }) => authority),
  );
  assert.equal(resolved.bundle.sha256, fixture.options.bundleSha256);
});

test("resolves P0 physical performance only at the P0-RELEASE exit", async () => {
  const fixture = await createFixture({ targetGate: "P0-RELEASE" });
  const resolved = await resolveExternalPhaseExitAuthorities(fixture.options);
  assert.deepEqual(
    resolved.references.map(({ authority }) => authority),
    ["physical-performance"],
  );
  assert.equal(fixture.bundle.entries[0].gate, "P0-RELEASE");
});

test("projects live deployment context separately and rejects historical or wrong-source bindings", () => {
  const policies = configuredPolicies();
  const current = makeCurrent(policies.databaseContract);
  current.records.push({
    sequence: 2,
    eventHash: hash("9"),
    event: {
      namespace,
      historicalDeployment: {
        ...deploymentBinding,
        bindingId: "historical-binding",
        sourceSha: "b".repeat(40),
        providerDeploymentId: "historical-deployment",
      },
    },
  });
  const releaseContext = projectPhaseExitAuthorityReleaseContext({ current });
  assert.deepEqual(Object.keys(releaseContext.deployments), [
    "activeProduction",
    "acceptedStandard",
    "preparedStandard",
    "containmentCompanion",
    "bootstrapRecovery",
  ]);
  assert.equal(
    releaseContext.deployments.activeProduction.providerDeploymentId,
    deploymentBinding.providerDeploymentId,
  );
  assert.equal(
    JSON.stringify(releaseContext).includes("historical-deployment"),
    false,
  );
  assert.throws(
    () =>
      assertCurrentAcceptedPhaseExitDeployment({
        releaseContext,
        sourceSha,
        deploymentId: "historical-deployment",
        minimumAcceptedGate: "P0-RELEASE",
      }),
    /current exact-source accepted production deployment/u,
  );

  const wrongSource = structuredClone(releaseContext);
  wrongSource.deployments.activeProduction.sourceSha = "b".repeat(40);
  wrongSource.deployments.acceptedStandard.sourceSha = "b".repeat(40);
  assert.throws(
    () =>
      assertCurrentAcceptedPhaseExitDeployment({
        releaseContext: wrongSource,
        sourceSha,
        deploymentId: deploymentBinding.providerDeploymentId,
        minimumAcceptedGate: "P0-RELEASE",
      }),
    /current exact-source accepted production deployment/u,
  );
});

test("projects a closed target-gate subject without leaking live production state", () => {
  const policies = configuredPolicies();
  const productionCurrent = makeCurrent(policies.databaseContract);
  assert.deepEqual(
    projectPhaseExitAuthoritySubject({
      current: productionCurrent,
      targetGate: "P0-TOOLCHAIN",
      sourceSha,
      foundationBaseline: policies.foundationBaseline,
    }),
    { kind: "repository-phase-subject/v1", sourceSha },
  );
  assert.deepEqual(
    projectPhaseExitAuthoritySubject({
      current: productionCurrent,
      targetGate: "P2A-LOCAL",
      sourceSha,
      foundationBaseline: policies.foundationBaseline,
    }),
    {
      kind: "release-state-subject/v1",
      sourceSha,
      releaseStateHead: { ...productionCurrent.head },
    },
  );

  const preRelease = makeCurrent(policies.databaseContract, {
    preRelease: true,
  });
  preRelease.records.push({
    sequence: 2,
    eventHash: hash("9"),
    event: {
      namespace,
      eventType: "phase-exit-attested",
      payload: { gate: "P0-ARTIFACT" },
    },
  });
  preRelease.head = { sequence: 2, eventHash: hash("9") };
  const dataSubject = projectPhaseExitAuthoritySubject({
    current: preRelease,
    targetGate: "P0-DATA",
    sourceSha,
    foundationBaseline: policies.foundationBaseline,
  });
  assert.deepEqual(dataSubject, {
    kind: "state-initialized-bootstrap-subject/v1",
    executorSourceSha: sourceSha,
    bootstrapSourceSha,
    bootstrapBinding: {
      artifactArchiveSha256: bootstrapRecoveryBinding.artifactArchive.sha256,
      bindingId: bootstrapRecoveryBinding.bindingId,
      packageIndexSha256: bootstrapRecoveryBinding.packageIndex.sha256,
      providerDeploymentId: bootstrapRecoveryBinding.providerDeploymentId,
      releaseRole: "containment",
      sourceSha: bootstrapSourceSha,
    },
    rawDistManifestSha256:
      policies.foundationBaseline.baselineEvidence.artifactObservation
        .rawDistManifestSha256,
    releaseStateHead: { sequence: 1, eventHash: hash("e") },
  });
  assert.equal(JSON.stringify(dataSubject).includes("activeProduction"), false);
  assert.equal(JSON.stringify(dataSubject).includes("pendingOperation"), false);

  const pendingSubstitution = structuredClone(preRelease);
  pendingSubstitution.snapshot.pendingOperation = {
    targetBinding: structuredClone(deploymentBinding),
  };
  assert.throws(
    () =>
      projectPhaseExitAuthoritySubject({
        current: pendingSubstitution,
        targetGate: "P0-DATA",
        sourceSha,
        foundationBaseline: policies.foundationBaseline,
      }),
    /dual-source initialized bootstrap state/u,
  );

  const standardBootstrap = structuredClone(preRelease);
  standardBootstrap.snapshot.bootstrapRecovery.releaseRole = "standard";
  assert.throws(
    () =>
      projectPhaseExitAuthoritySubject({
        current: standardBootstrap,
        targetGate: "P0-DATA",
        sourceSha,
        foundationBaseline: policies.foundationBaseline,
      }),
    /baseline bootstrap recovery binding/u,
  );
});

test("managed-device authorities derive evidence only from the reviewed stage set", () => {
  const policies = configuredPolicies();
  const collectorAuthority = {
    uri: `release-state://${namespace}/evidence/${hash("8")}`,
    sha256: hash("8"),
  };
  const indexedDbFingerprint = sha256Json({
    name: policies.databaseContract.indexedDb.name,
    version: policies.databaseContract.indexedDb.version,
    stores: Object.entries(policies.databaseContract.indexedDb.stores)
      .map(([name, value]) => ({
        indexes: value.indexes,
        keyPath: value.keyPath,
        name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
  for (const authority of [
    "pwa-multiclient-drill",
    "idb-device-compatibility",
  ]) {
    const definition = PHASE_EXIT_EXTERNAL_AUTHORITIES.find(
      (candidate) => candidate.authority === authority,
    );
    assert.equal(definition.collectorImplemented, true);
    const stages = ["initial-forward", "rollback", "final-forward"].map(
      (role, index) => ({
        role,
        runId: String(101 + index),
        runAttempt: "1",
        receiptSha256: String(index + 1).repeat(64),
        activation: { sequence: index + 1 },
        bindingId: `binding-${index}`,
        sourceSha: index === 1 ? "b".repeat(40) : sourceSha,
      }),
    );
    const document = {
      schemaVersion: 1,
      kind: "managed-device-multistage-authority/v1",
      authority,
      sourceSha,
      deviceFingerprintSha256: hash("3"),
      releaseStateSequenceSha256: hash("4"),
      stages,
      result: {
        clientKinds: ["browser-tab", "installed-pwa"],
        transitionCount: 3,
        finalSourceSha: sourceSha,
        databaseFingerprintSha256:
          authority === "idb-device-compatibility"
            ? indexedDbFingerprint
            : null,
      },
    };
    const readback = {
      aggregated: {
        document,
        sha256: sha256Json(document),
        stages: stages.map((_, index) => ({
          payload: {
            observedAt: new Date(now - (3 - index) * 1_000).toISOString(),
          },
        })),
      },
      setReceipt: { reference: collectorAuthority },
    };
    const built = buildManagedDevicePhaseExitEvidence({
      authority,
      stageSetReadback: readback,
      collectorAuthority,
      subject: { kind: "managed-device-test-subject/v1" },
      sourceSha,
      databaseContract: policies.databaseContract,
    });
    assert.deepEqual(built.value.result, document);
    assert.equal(
      built.observedAt,
      readback.aggregated.stages[2].payload.observedAt,
    );
    assert.throws(
      () =>
        buildManagedDevicePhaseExitEvidence({
          authority,
          stageSetReadback: readback,
          collectorAuthority: {
            uri: `release-state://${namespace}/evidence/${hash("9")}`,
            sha256: hash("9"),
          },
          subject: { kind: "managed-device-test-subject/v1" },
          sourceSha,
          databaseContract: policies.databaseContract,
        }),
      /readback differs/u,
    );
  }
});

test("publishes only a prevalidated reviewed bundle and verifies immutable readback", async () => {
  const fixture = await createFixture();
  const bundleStored = fixture.objects.get(fixture.options.bundleSha256);
  const evidenceBytesByAuthority = new Map(
    fixture.bundle.entries.map((entry) => [
      entry.authority,
      Buffer.from(fixture.objects.get(entry.evidence.sha256).bytes),
    ]),
  );
  for (const entry of fixture.bundle.entries) {
    fixture.objects.delete(entry.evidence.sha256);
  }
  fixture.objects.delete(fixture.options.bundleSha256);

  const published = await publishPhaseExitAuthorityBundle({
    store: fixture.options.store,
    current: fixture.options.current,
    sourceSha: fixture.options.sourceSha,
    currentWorkflowRunId: fixture.options.currentWorkflowRunId,
    bundleBytes: Buffer.from(bundleStored.bytes),
    expectedBundleSha256: fixture.options.bundleSha256,
    evidenceBytesByAuthority,
    providerPolicy: fixture.options.providerPolicy,
    approvalPolicy: fixture.options.approvalPolicy,
    storePolicy: fixture.options.storePolicy,
    databaseContract: fixture.options.databaseContract,
    retentionPolicy: fixture.options.retentionPolicy,
    startupBurstContract: fixture.options.startupBurstContract,
    cspPolicy: fixture.options.cspPolicy,
    backupRestorePrerequisitePolicy:
      fixture.options.backupRestorePrerequisitePolicy,
    backupRestoreProviderContract:
      fixture.options.backupRestoreProviderContract,
    artifactDrillPolicy: fixture.options.artifactDrillPolicy,
    releasePolicy: fixture.options.releasePolicy,
    toolchainPolicy: fixture.options.toolchainPolicy,
    foundationBaseline: fixture.options.foundationBaseline,
    p0aPolicy: fixture.options.p0aPolicy,
  });
  assert.equal(published.bundle.reference.sha256, fixture.options.bundleSha256);
  assert.equal(
    published.evidenceReceipts.length,
    fixture.bundle.entries.length,
  );
  assert.equal(
    published.resolved.references.length,
    fixture.bundle.entries.length,
  );
});

test("publisher rejects an unreviewed evidence byte set before immutable writes", async () => {
  const fixture = await createFixture();
  const bundleStored = fixture.objects.get(fixture.options.bundleSha256);
  const evidenceBytesByAuthority = new Map(
    fixture.bundle.entries.map((entry) => [
      entry.authority,
      Buffer.from(fixture.objects.get(entry.evidence.sha256).bytes),
    ]),
  );
  evidenceBytesByAuthority.set(
    "artifact-provider-control-store-drill",
    Buffer.from("{}", "utf8"),
  );
  let immutableWriteCount = 0;
  const store = {
    namespace: fixture.options.store.namespace,
    readEvidence: fixture.options.store.readEvidence.bind(
      fixture.options.store,
    ),
    async putEvidence(input) {
      immutableWriteCount += 1;
      return fixture.options.store.putEvidence(input);
    },
  };

  await assert.rejects(
    publishPhaseExitAuthorityBundle({
      store,
      current: fixture.options.current,
      sourceSha: fixture.options.sourceSha,
      currentWorkflowRunId: fixture.options.currentWorkflowRunId,
      bundleBytes: Buffer.from(bundleStored.bytes),
      expectedBundleSha256: fixture.options.bundleSha256,
      evidenceBytesByAuthority,
      providerPolicy: fixture.options.providerPolicy,
      approvalPolicy: fixture.options.approvalPolicy,
      storePolicy: fixture.options.storePolicy,
      databaseContract: fixture.options.databaseContract,
      retentionPolicy: fixture.options.retentionPolicy,
      startupBurstContract: fixture.options.startupBurstContract,
      cspPolicy: fixture.options.cspPolicy,
      backupRestorePrerequisitePolicy:
        fixture.options.backupRestorePrerequisitePolicy,
      backupRestoreProviderContract:
        fixture.options.backupRestoreProviderContract,
      artifactDrillPolicy: fixture.options.artifactDrillPolicy,
      releasePolicy: fixture.options.releasePolicy,
      toolchainPolicy: fixture.options.toolchainPolicy,
      foundationBaseline: fixture.options.foundationBaseline,
      p0aPolicy: fixture.options.p0aPolicy,
    }),
    /evidence file set differs from the exact target gate/u,
  );
  assert.equal(immutableWriteCount, 0);
});

test("rejects arbitrary hashes, tamper, wrong media, extra keys, and generic substitution", async (t) => {
  await t.test("arbitrary hash", async () => {
    const fixture = await createFixture();
    fixture.options.bundleSha256 = hash("f");
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /absent, tampered, or mistyped/u,
    );
  });
  await t.test("tampered bytes", async () => {
    const fixture = await createFixture({
      mutateStored(objects, { bundleReference }) {
        objects.get(bundleReference.sha256).bytes = Buffer.from("{}", "utf8");
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /absent, tampered, or mistyped/u,
    );
  });
  await t.test("wrong media type", async () => {
    const fixture = await createFixture({
      mutateStored(objects, { bundle }) {
        const reference = bundle.entries[0].evidence;
        objects.get(reference.sha256).mediaType = "application/json";
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /mistyped/u,
    );
  });
  await t.test("extra key", async () => {
    const fixture = await createFixture({
      targetGate: "P0-TOOLCHAIN",
      mutateValues(values) {
        values.get("quality-run").callerClaimedPass = true;
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /schema is not closed/u,
    );
  });
  await t.test("generic substitution", async () => {
    const fixture = await createFixture({
      targetGate: "P0-TOOLCHAIN",
      mutateValues(values) {
        values.get("quality-run").evidenceKind =
          "phase-exit-production-request-graph/v1";
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /evidence binding differs/u,
    );
  });
  await t.test(
    "generic reviewed run substituted for DB production authority",
    async () => {
      const fixture = await createFixture({
        targetGate: "P0-DATA",
        mutateBundle(bundle) {
          const remote = bundle.entries.find(
            ({ authority }) => authority === "remote-db",
          );
          remote.productionAuthority = remote.collectorAuthority;
        },
      });
      await assert.rejects(
        resolveExternalPhaseExitAuthorities(fixture.options),
        /Reviewed remote DB production authority is absent/u,
      );
    },
  );
  await t.test("same-run collector and DB producer", async () => {
    const fixture = await createFixture();
    fixture.options.currentWorkflowRunId = "20000";
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /distinct completed prior (?:collector )?run/u,
    );
  });
});

test("rejects stale, future, wrong-source, wrong-gate, wrong-subject, duplicate, and semantic drift", async (t) => {
  for (const [name, mutateBundle, pattern] of [
    [
      "stale",
      (bundle) => {
        bundle.entries[0].observedAt = "2020-01-01T00:00:00.000Z";
      },
      /stale or in the future/u,
    ],
    [
      "future",
      (bundle) => {
        bundle.entries[0].observedAt = new Date(
          Date.now() + 10 * 60 * 1_000,
        ).toISOString();
      },
      /stale or in the future/u,
    ],
    [
      "wrong source",
      (bundle) => {
        bundle.sourceSha = "b".repeat(40);
      },
      /identity differs/u,
    ],
    [
      "wrong gate",
      (bundle) => {
        bundle.entries[0].gate = "P1-PWA";
      },
      /wrong, duplicate, or unordered/u,
    ],
    [
      "wrong subject",
      (bundle) => {
        bundle.entries[0].subject = structuredClone(bundle.entries[0].subject);
        bundle.entries[0].subject.sourceSha = "b".repeat(40);
      },
      /subject differs/u,
    ],
    [
      "duplicate authority",
      (bundle) => {
        bundle.entries[1] = structuredClone(bundle.entries[0]);
      },
      /wrong, duplicate, or unordered/u,
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        targetGate: name === "duplicate authority" ? "P0-DATA" : "P0-TOOLCHAIN",
        mutateBundle,
      });
      await assert.rejects(
        resolveExternalPhaseExitAuthorities(fixture.options),
        pattern,
      );
    });
  }
  await t.test("cross-gate subject kind", async () => {
    const fixture = await createFixture({
      targetGate: "P0-DATA",
      mutateBundle(bundle) {
        for (const entry of bundle.entries) {
          entry.subject = {
            kind: "repository-phase-subject/v1",
            sourceSha,
          };
        }
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /subject schema is not closed/u,
    );
  });
  await t.test("remote DB semantic drift", async () => {
    const fixture = await createFixture({
      targetGate: "P0-DATA",
      mutateValues(values) {
        values.get("remote-db").migrationsApplied = false;
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /does not match the compatibility contract/u,
    );
  });
  await t.test("retention collector run-attempt drift", async () => {
    const fixture = await createFixture({
      targetGate: "P0-DATA",
      mutateValues(values) {
        values.get("retention").collectorIdentity.runAttempt = "2";
      },
    });
    await assert.rejects(
      resolveExternalPhaseExitAuthorities(fixture.options),
      /differs from configured policy/u,
    );
  });
});
