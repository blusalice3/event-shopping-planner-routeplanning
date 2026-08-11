import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { computeRoleEntryGraphHash } from "../lib/artifact-contract.mjs";
import { manifestTreeHash } from "../lib/file-manifest.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import {
  DEPLOYMENT_BINDING_MEDIA_TYPE,
  RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
} from "../lib/foundation-baseline-closure-authority.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  FOUNDATION_BOOTSTRAP_RECOVERY_RAW_MEDIA_TYPE,
  assertFoundationBootstrapRecoveryObservation,
  assertFoundationBootstrapRecoveryOperations,
  assertFoundationBootstrapStateInitializationSubject,
  cleanupFoundationBootstrapPreview,
  collectAndStoreFoundationBootstrapRecovery,
  executeFoundationBootstrapPreviewRecovery,
  readStoredFoundationBootstrapRecoveryAuthority,
} from "./foundation-bootstrap-recovery.mjs";
import { buildClosedVercelCommandEnvironment } from "./vercel-command-environment.mjs";
import {
  parseFoundationBootstrapRecoveryArguments,
  runFoundationBootstrapRecoveryCli,
} from "./collect-foundation-bootstrap-recovery.mjs";
import {
  assertFoundationBootstrapDeploymentSeedAuthority,
  parseFoundationBootstrapDeploymentSeedArguments,
  readStoredFoundationBootstrapDeploymentSeedAuthority,
  recordFoundationBootstrapDeploymentSeed,
  reviewFoundationBootstrapDeploymentSeed,
  runFoundationBootstrapDeploymentSeedCli,
} from "./foundation-bootstrap-deployment-seed.mjs";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../../config/${name}`, import.meta.url), "utf8"),
  );

const [
  baseP0a,
  baseProvider,
  baseDatabase,
  baseStore,
  baseApproval,
  baseFoundation,
  toolchainPolicy,
  releasePolicy,
] = await Promise.all([
  load("foundation-p0a-authorities.json"),
  load("provider-policy.json"),
  load("db-compatibility-contract.json"),
  load("release-state-store.json"),
  load("approval-policy.json"),
  load("foundation-baseline.json"),
  load("toolchain-versions.json"),
  load("release-variants.json"),
]);

const NOW = Date.parse("2026-08-09T04:05:06.000Z");
const namespace = "foundation-bootstrap-test";
const sourceSha = "1".repeat(40);
const bootstrapSourceSha = "2".repeat(40);
const bootstrapTreeSha = "3".repeat(40);
const runId = "7101";
const runAttempt = "2";
const committedAt = new Date(NOW).toISOString();
const oidcReceipt = {
  uri: `release-state://${namespace}/evidence/${"a".repeat(64)}`,
  sha256: "a".repeat(64),
};
const reviewedWorkflowRun = {
  uri: `release-state://${namespace}/evidence/${"b".repeat(64)}`,
  sha256: "b".repeat(64),
};
const bootstrapSeedAuthority = {
  uri: `release-state://${namespace}/evidence/${"c".repeat(64)}`,
  sha256: "c".repeat(64),
};

const wafRule = (id, route) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: route }] }],
  rateLimit: null,
});

const configuredPolicies = () => {
  const p0aPolicy = structuredClone(baseP0a);
  p0aPolicy.bindingStatus = "configured";
  p0aPolicy.applicationDatabase = {
    provisioningStatus: "provisioned",
    credentialOwner: "github-team:db-observers",
    backupOwner: "github-team:db-backup",
    restoreOwner: "github-team:db-restore",
  };
  p0aPolicy.controlStore = {
    namespaceStatus: "uninitialized",
    credentialOwner: "github-team:release-state",
  };
  p0aPolicy.bootstrapRecovery.previewAliasSuffix =
    "preview.blusalice3-foundation.dev";
  p0aPolicy.blockerCodes = [];

  const providerPolicy = structuredClone(baseProvider);
  Object.assign(providerPolicy, {
    bindingStatus: "configured",
    expectedTeamId: "team_p0a",
    expectedProjectId: "project_p0a",
    ownedProductionDomains: ["production.example.test"],
    requiredEnvironmentNames: ["REQUIRED_ENV"],
    cspReportEnvironmentNames: [],
    forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
    wafRules: {
      metricsRoute: wafRule(
        "metrics-rule",
        "/api/persistence-release-a-metrics",
      ),
      cspReportRoute: wafRule("csp-rule", "/api/csp-report"),
      googleSheetsCsvRoute: wafRule("sheets-rule", "/api/google-sheets-csv"),
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

  const databaseContract = structuredClone(baseDatabase);
  databaseContract.remote.observationAuthority = {
    ...databaseContract.remote.observationAuthority,
    bindingStatus: "configured",
    allowedHosts: ["application-db.example.test"],
    allowedDatabases: ["foundation_app"],
    allowedObserverRoles: ["foundation_observer"],
    productionCaSha256: "4".repeat(64),
  };

  const storePolicy = structuredClone(baseStore);
  Object.assign(storePolicy, {
    bindingStatus: "configured",
    allowedHosts: ["control-db.example.test"],
    allowedDatabases: ["release_state"],
    allowedExecutorRoles: ["release_executor"],
    backupOwner: "github-team:control-backup",
    restoreOwner: "github-team:control-restore",
    productionCaSha256: "5".repeat(64),
    blockerCodes: [],
  });

  const approvalPolicy = structuredClone(baseApproval);
  approvalPolicy.bindingStatus = "configured";
  approvalPolicy.roles.releaseOwner.reviewerTeam = "github-team-release";
  approvalPolicy.roles.dataSafetyReviewer.reviewerTeam =
    "github-team-data-safety";
  approvalPolicy.roles.operationsReviewer.reviewerTeam =
    "github-team-operations";
  approvalPolicy.blockerCodes = [];

  const foundationBaseline = structuredClone(baseFoundation);
  return {
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    foundationBaseline,
    toolchainPolicy,
  };
};

const memoryStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const objectBytes = Buffer.from(bytes);
      const sha256 = sha256Bytes(objectBytes);
      objects.set(sha256, {
        bytes: objectBytes,
        mediaType,
        committedAt,
      });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: objectBytes.length,
        committedAt,
        replayed: false,
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

const referenceFromReceipt = (receipt) => ({
  uri: receipt.uri,
  sha256: receipt.sha256,
});

const putJson = async (store, value, mediaType = "application/json") =>
  referenceFromReceipt(
    await store.putEvidence({ bytes: canonicalJsonBytes(value), mediaType }),
  );

const createBindingArtifact = async (store, policies) => {
  const providerPolicyReference = await putJson(
    store,
    policies.providerPolicy,
    "application/vnd.event-shopping-planner.provider-policy+json;version=1",
  );
  const releasePolicyReference = await putJson(
    store,
    releasePolicy,
    "application/vnd.event-shopping-planner.release-policy+json;version=1",
  );
  const routeBodies = {
    "/": Buffer.from("bootstrap-index", "utf8"),
    "/index.html": Buffer.from("bootstrap-index", "utf8"),
    "/persistence-release-a-capability.json": Buffer.from(
      "bootstrap-capability",
      "utf8",
    ),
    "/sw.js": Buffer.from("bootstrap-worker", "utf8"),
  };
  const publicResponseHashes = Object.fromEntries(
    Object.entries(routeBodies).map(([route, bytes]) => [
      route,
      sha256Bytes(bytes),
    ]),
  );
  const rawFiles = [
    {
      path: "index.html",
      sha256: publicResponseHashes["/index.html"],
      size: routeBodies["/index.html"].length,
    },
    {
      path: "persistence-release-a-capability.json",
      sha256: publicResponseHashes["/persistence-release-a-capability.json"],
      size: routeBodies["/persistence-release-a-capability.json"].length,
    },
    {
      path: "sw.js",
      sha256: publicResponseHashes["/sw.js"],
      size: routeBodies["/sw.js"].length,
    },
  ];
  const rawDistManifest = {
    schemaVersion: 1,
    treeSha256: manifestTreeHash(rawFiles),
    files: rawFiles,
  };
  const rawDistReference = await putJson(store, rawDistManifest);
  const providerConfigurationHash = "6".repeat(64);
  const bootstrapInput = {
    schemaVersion: 1,
    sourceSha: bootstrapSourceSha,
    nodeVersion: "24.19.0",
    npmVersion: "11.19.0",
    lockfileSha256: "7".repeat(64),
    rawDistManifest: rawDistReference,
    metricsDisabledTemplateSha256: "8".repeat(64),
    apiNotFoundTemplateSha256: "9".repeat(64),
    stagingVerifierSha256: "a".repeat(64),
    generatedPackageSha256: "b".repeat(64),
    generatedLockfileSha256: "c".repeat(64),
    generatedVercelConfigSha256: "d".repeat(64),
    providerProjectId: policies.providerPolicy.expectedProjectId,
    providerConfigurationHash,
  };
  const bootstrapInputReference = await putJson(store, bootstrapInput);
  const dimensions = projectContainmentDimensions(
    releasePolicy,
    releasePolicy.initialStandard,
  );
  const variantId = computeVariantId(releasePolicy, dimensions);
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "legacy-static-entry-v1",
    sourceSha: bootstrapSourceSha,
    releaseRole: "containment",
    variantId,
    entryModule: "legacy-bootstrap:index.html",
    entryFile: "/index.html",
    modules: [
      {
        id: "legacy-bootstrap:index.html",
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: "/index.html",
        sha256: publicResponseHashes["/index.html"],
        size: routeBodies["/index.html"].length,
        staticImports: [],
        dynamicImports: [],
        modules: ["legacy-bootstrap:index.html"],
      },
    ],
  };
  const requiredDbCompatibility = {
    contractUri: policies.databaseContract.contractUri,
    fingerprint: "e".repeat(64),
  };
  const manifest = {
    schemaVersion: 1,
    sourceSha: bootstrapSourceSha,
    buildId: bootstrapSourceSha,
    variantId,
    releaseRole: "containment",
    dimensions,
    buildAuthority: null,
    targetGate: null,
    buildPurpose: "legacy-bootstrap",
    promotable: false,
    buildInputClosureHash: "f".repeat(64),
    lockfileSha256: "1".repeat(64),
    toolchainPolicyHash: sha256Json(toolchainPolicy),
    publicBuildEnvHash: "2".repeat(64),
    providerConfigurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility,
    publicIdentityKind: "legacy-bootstrap-v1",
    bootstrap: {
      inputUri: bootstrapInputReference.uri,
      inputSha256: bootstrapInputReference.sha256,
      rawDistManifestUri: rawDistReference.uri,
      rawDistManifestSha256: rawDistReference.sha256,
    },
    publicResponseHashes,
    roleEntryGraph,
    roleEntryGraphHash: computeRoleEntryGraphHash(roleEntryGraph),
    outputFiles: [
      {
        path: "static/index.html",
        sha256: publicResponseHashes["/index.html"],
        size: routeBodies["/index.html"].length,
      },
      {
        path: "static/persistence-release-a-capability.json",
        sha256: publicResponseHashes["/persistence-release-a-capability.json"],
        size: routeBodies["/persistence-release-a-capability.json"].length,
      },
      {
        path: "static/sw.js",
        sha256: publicResponseHashes["/sw.js"],
        size: routeBodies["/sw.js"].length,
      },
    ],
  };
  const manifestReference = await putJson(
    store,
    manifest,
    "application/vnd.event-shopping-planner.artifact-manifest+json;version=1",
  );
  const archiveBytes = Buffer.from("foundation-bootstrap-archive", "utf8");
  const archiveReceipt = await store.putEvidence({
    bytes: archiveBytes,
    mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
  });
  const archiveReference = referenceFromReceipt(archiveReceipt);
  const packageIndex = {
    schemaVersion: 1,
    packageKind: "legacy-bootstrap-single",
    sourceSha: bootstrapSourceSha,
    buildId: bootstrapSourceSha,
    buildAuthority: null,
    targetGate: null,
    buildPurpose: "legacy-bootstrap",
    promotable: false,
    toolchainPolicyHash: sha256Json(toolchainPolicy),
    providerConfigurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility,
    bootstrapInput: bootstrapInputReference,
    rawDistManifest: rawDistReference,
    artifact: {
      releaseRole: "containment",
      variantId,
      manifest: manifestReference,
      archive: archiveReference,
    },
  };
  const packageIndexReference = await putJson(
    store,
    packageIndex,
    RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
  );
  const bindingId = "foundation-bootstrap-binding";
  const providerEvidence = {
    schemaVersion: 1,
    providerProjectId: policies.providerPolicy.expectedProjectId,
    providerDeploymentId: "deployment-bootstrap-live",
    deploymentUrl: "https://bootstrap.production.example.test",
    sourceSha: bootstrapSourceSha,
    variantId,
    releaseRole: "containment",
    artifactManifestHash: manifestReference.sha256,
    packageIndexHash: packageIndexReference.sha256,
    providerConfigurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility,
    publicIdentity: { identityKind: "legacy-bootstrap-v1" },
    routeProbeEvidenceHash: "3".repeat(64),
    environmentPresenceEvidenceHash: "4".repeat(64),
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
    namespace,
    bindingId,
    sourceSha: bootstrapSourceSha,
    variantId,
    releaseRole: "containment",
    artifactManifest: manifestReference,
    artifactArchive: {
      ...archiveReference,
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
      byteLength: archiveBytes.length,
      committedAt,
    },
  };
  const availabilityReference = await putJson(
    store,
    availability,
    ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  );
  const binding = {
    bindingId,
    sourceSha: bootstrapSourceSha,
    buildId: bootstrapSourceSha,
    variantId,
    releaseRole: "containment",
    publicIdentityKind: "legacy-bootstrap-v1",
    providerProjectId: policies.providerPolicy.expectedProjectId,
    providerDeploymentId: "deployment-bootstrap-live",
    deploymentUrl: "https://bootstrap.production.example.test",
    artifactArchive: archiveReference,
    artifactArchiveAvailability: availabilityReference,
    packageIndex: packageIndexReference,
    artifactManifest: manifestReference,
    providerEvidence: providerEvidenceReference,
    releasePolicy: releasePolicyReference,
    providerPolicy: providerPolicyReference,
    providerConfigurationHash,
    requiredDbCompatibility,
  };
  const bindingReference = await putJson(
    store,
    binding,
    DEPLOYMENT_BINDING_MEDIA_TYPE,
  );
  policies.p0aPolicy.bootstrapRecovery.deploymentBindingSha256 =
    bindingReference.sha256;
  policies.p0aPolicy.bootstrapRecovery.deploymentSeedAuthoritySha256 =
    "c".repeat(64);
  policies.p0aPolicy.bootstrapRecovery.bootstrapSourceSha = bootstrapSourceSha;
  policies.p0aPolicy.bootstrapRecovery.rawDistManifestSha256 =
    rawDistReference.sha256;
  const receipt = {
    schemaVersion: 1,
    kind: "foundation-bootstrap-materialization-receipt/v1",
    sourceSha: bootstrapSourceSha,
    commitTreeSha: bootstrapTreeSha,
    bindingId,
    bindingReference,
    packageIndexSha256: packageIndexReference.sha256,
    manifestSha256: manifestReference.sha256,
    archiveSha256: archiveReference.sha256,
    rawDistManifestSha256: rawDistReference.sha256,
    bootstrapInputSha256: bootstrapInputReference.sha256,
    fileCount: manifest.outputFiles.length,
  };
  return {
    binding,
    bindingReference,
    manifest,
    archiveBytes,
    rawDistManifest,
    expectedRoutes: publicResponseHashes,
    receipt,
  };
};

const providerProjection = () => ({
  requestUrl: "https://api.vercel.com/v13/deployments/deployment-preview",
  status: 200,
  date: "Sun, 09 Aug 2026 04:04:06 GMT",
  etag: '"fixture"',
  responseSha256: "5".repeat(64),
  projectId: "project_p0a",
  teamId: "team_p0a",
  target: null,
  readyState: "READY",
});

const operationsFor = (artifact) => {
  const alias = "p0a-fixture.containment.preview.example.test";
  const deployment = (stage, deploymentId) => ({
    schemaVersion: 1,
    kind: "foundation-bootstrap-preview-deployment-receipt/v1",
    stage,
    target: "preview",
    deploymentId,
    previewUrl: `https://${stage}.preview.example.test/`,
    archiveSha256: artifact.receipt.archiveSha256,
    manifestSha256: artifact.receipt.manifestSha256,
    provider: providerProjection(),
    routes: Object.entries(artifact.expectedRoutes).map(
      ([route, bodySha256]) => ({ path: route, status: 200, bodySha256 }),
    ),
  });
  const forward = deployment("forward", "deployment-forward-preview");
  const recovery = deployment("recovery", "deployment-recovery-preview");
  const assignment = (stage, deploymentReceipt) => ({
    schemaVersion: 1,
    kind: "foundation-bootstrap-preview-assignment-receipt/v1",
    stage,
    alias,
    deploymentId: deploymentReceipt.deploymentId,
    command: {
      requestUrl: `https://api.vercel.com/v2/deployments/${deploymentReceipt.deploymentId}/aliases?teamId=team_p0a`,
      status: 200,
      responseSha256: "6".repeat(64),
    },
    observation: {
      requestUrl: `https://api.vercel.com/v4/aliases/${alias}?teamId=team_p0a`,
      status: 200,
      responseSha256: "7".repeat(64),
      observedDeploymentId: deploymentReceipt.deploymentId,
      observedProjectId: "project_p0a",
    },
  });
  const completedAt = new Date(NOW).toISOString();
  return {
    startedAt: new Date(NOW - 60_000).toISOString(),
    completedAt,
    deployments: [forward, recovery],
    assignments: [
      assignment("forward", forward),
      assignment("recovery", recovery),
    ],
    providerObservation: {
      schemaVersion: 1,
      kind: "foundation-bootstrap-provider-observation/v1",
      projectId: "project_p0a",
      teamId: "team_p0a",
      forwardDeploymentId: forward.deploymentId,
      recoveryDeploymentId: recovery.deploymentId,
    },
    cleanup: {
      schemaVersion: 1,
      kind: "foundation-bootstrap-preview-cleanup-receipt/v1",
      alias,
      aliasDeleteStatus: 204,
      aliasDeleteResponseSha256: "8".repeat(64),
      aliasVerifyStatus: 404,
      aliasVerifyResponseSha256: "9".repeat(64),
      deployments: [forward, recovery].map((entry, index) => ({
        deploymentId: entry.deploymentId,
        deleteStatus: 204,
        deleteResponseSha256: `${index + 1}`.repeat(64),
        verifyStatus: 404,
        verifyResponseSha256: `${index + 3}`.repeat(64),
      })),
      completedAt,
    },
  };
};

const createFixture = async () => {
  const policies = configuredPolicies();
  const store = memoryStore();
  const artifact = await createBindingArtifact(store, policies);
  const operations = operationsFor(artifact);
  const bootstrapSourceResolution = {
    gitCommitSha: bootstrapSourceSha,
    treeSha: bootstrapTreeSha,
  };
  const dependencies = {
    readOidcAuthority: async () => ({ receipt: { trusted: true } }),
    readSeedAuthority: async () => ({
      authority: {
        runId: "7001",
        runAttempt: "1",
        workflowSourceSha: bootstrapSourceSha,
      },
      binding: artifact.binding,
      reference: bootstrapSeedAuthority,
    }),
    readWorkflowRun: async () => ({ receipt: { reviewed: true } }),
    assertBootstrapSource: (resolution) => resolution,
    materialize: async () => artifact,
    executeRecovery: async () => operations,
    clock: () => NOW,
  };
  const options = {
    ...policies,
    bootstrapSeedAuthority,
    bootstrapSourceResolution,
    environment: {
      GITHUB_SHA: sourceSha,
      VERCEL_TOKEN: "provider-secret-must-not-be-stored",
      GITHUB_TOKEN: "github-secret-must-not-be-stored",
    },
    namespace,
    oidcAuthority: {
      approvalPolicy: policies.approvalPolicy,
      runId,
      runAttempt,
    },
    oidcReceipt,
    reviewedWorkflowRun,
    store,
  };
  const observation = await collectAndStoreFoundationBootstrapRecovery(
    options,
    dependencies,
  );
  return {
    artifact,
    bootstrapSourceResolution,
    dependencies,
    observation,
    operations,
    options,
    policies,
    store,
  };
};

const markBootstrapSeedPending = (policies) => {
  policies.p0aPolicy.bindingStatus = "bootstrap-seed-pending";
  policies.p0aPolicy.blockerCodes = [
    "p0a-bootstrap-deployment-binding-seed-pending",
  ];
  policies.p0aPolicy.bootstrapRecovery.bootstrapSourceSha = null;
  policies.p0aPolicy.bootstrapRecovery.deploymentBindingSha256 = null;
  policies.p0aPolicy.bootstrapRecovery.deploymentSeedAuthoritySha256 = null;
  policies.p0aPolicy.bootstrapRecovery.rawDistManifestSha256 = null;
  return policies;
};

const seedOidcReader = async (options) => {
  assert.equal(options.sourceSha, bootstrapSourceSha);
  assert.equal(options.runId, "7001");
  assert.equal(options.runAttempt, "1");
  return {
    receipt: { verifiedAt: committedAt },
    readback: { receipt: { verifiedAt: committedAt } },
  };
};

test("bootstrap seed parser and CLI reject caller selectors and wrong operation before authority I/O", async () => {
  assert.deepEqual(
    parseFoundationBootstrapDeploymentSeedArguments([
      "--namespace",
      namespace,
      "--binding",
      "binding.json",
      "--output",
      "seed.json",
    ]),
    {
      namespace,
      bindingPath: "binding.json",
      outputPath: "seed.json",
    },
  );
  for (const injected of [
    ["--source-sha", sourceSha],
    ["--run-id", runId],
    ["--binding-sha256", "f".repeat(64)],
    ["--status", "passed"],
  ]) {
    assert.throws(
      () =>
        parseFoundationBootstrapDeploymentSeedArguments([
          "--namespace",
          namespace,
          "--binding",
          "binding.json",
          "--output",
          "seed.json",
          ...injected,
        ]),
      /Usage|arguments/u,
    );
  }
  let policyReads = 0;
  await assert.rejects(
    runFoundationBootstrapDeploymentSeedCli(
      {
        argv: [
          "--namespace",
          namespace,
          "--binding",
          "binding.json",
          "--output",
          "seed.json",
        ],
        environment: { REQUESTED_OPERATION: "caller-selected-operation" },
      },
      {
        loadPolicy: async () => {
          policyReads += 1;
          throw new Error("must not read policy");
        },
      },
    ),
    /operation differs/u,
  );
  assert.equal(policyReads, 0);
});

test("bootstrap seed CLI requires pending policy and protected current workflow identity", async (t) => {
  const policies = markBootstrapSeedPending(configuredPolicies());
  const store = memoryStore();
  const artifact = await createBindingArtifact(store, policies);
  markBootstrapSeedPending(policies);
  store.close = async () => undefined;
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-bootstrap-seed-cli-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const bindingPath = path.join(temporaryRoot, "binding.json");
  await writeFile(
    bindingPath,
    store.objects.get(artifact.bindingReference.sha256).bytes,
  );
  const byName = new Map([
    ["foundation-p0a-authorities.json", policies.p0aPolicy],
    ["provider-policy.json", policies.providerPolicy],
    ["db-compatibility-contract.json", policies.databaseContract],
    ["release-state-store.json", policies.storePolicy],
    ["approval-policy.json", policies.approvalPolicy],
    ["foundation-baseline.json", policies.foundationBaseline],
  ]);
  let protectedOptions = null;
  let recordOptions = null;
  const result = await runFoundationBootstrapDeploymentSeedCli(
    {
      argv: [
        "--namespace",
        namespace,
        "--binding",
        bindingPath,
        "--output",
        path.join(temporaryRoot, "seed.json"),
      ],
      environment: {
        REQUESTED_OPERATION: "seed-foundation-bootstrap-deployment-binding",
        GITHUB_SHA: bootstrapSourceSha,
        GITHUB_RUN_ID: "7001",
        GITHUB_RUN_ATTEMPT: "1",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
        RELEASE_STATE_DATABASE_URL: "postgresql://fixture",
        RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
      },
      cwd: temporaryRoot,
      stdout: { write: () => undefined },
    },
    {
      loadPolicy: async (filePath) => byName.get(path.basename(filePath)),
      assertProtected: (options) => {
        protectedOptions = options;
      },
      createStore: async () => store,
      collectOidc: async () => ({ reference: oidcReceipt }),
      recordSeed: async (options) => {
        recordOptions = options;
        return {
          authorityBytes: canonicalJsonBytes({ fixture: "seed" }),
          authorityReference: bootstrapSeedAuthority,
        };
      },
      writeOutput: async () => undefined,
    },
  );
  assert.equal(protectedOptions.sourceSha, bootstrapSourceSha);
  assert.equal(protectedOptions.runId, "7001");
  assert.equal(
    recordOptions.oidcAuthority.workflowSourceSha,
    bootstrapSourceSha,
  );
  assert.equal(recordOptions.oidcAuthority.runId, "7001");
  assert.deepEqual(result.authorityReference, bootstrapSeedAuthority);
});

test("bootstrap seed records, rereads, and reviews only its configured prior run and hashes", async () => {
  const policies = markBootstrapSeedPending(configuredPolicies());
  const store = memoryStore();
  const artifact = await createBindingArtifact(store, policies);
  markBootstrapSeedPending(policies);
  const bindingBytes = store.objects.get(
    artifact.bindingReference.sha256,
  ).bytes;
  const recorded = await recordFoundationBootstrapDeploymentSeed(
    {
      store,
      namespace,
      bindingBytes,
      oidcReceipt,
      oidcAuthority: {
        approvalPolicy: policies.approvalPolicy,
        workflowSourceSha: bootstrapSourceSha,
        runId: "7001",
        runAttempt: "1",
      },
      ...policies,
    },
    { readOidcAuthority: seedOidcReader },
  );
  Object.assign(policies.p0aPolicy, {
    bindingStatus: "configured",
    blockerCodes: [],
  });
  Object.assign(policies.p0aPolicy.bootstrapRecovery, {
    bootstrapSourceSha,
    rawDistManifestSha256: recorded.authority.rawDistManifest.sha256,
    deploymentBindingSha256: recorded.bindingReference.sha256,
    deploymentSeedAuthoritySha256: recorded.authorityReference.sha256,
  });
  const reread = await readStoredFoundationBootstrapDeploymentSeedAuthority(
    {
      store,
      namespace,
      reference: recorded.authorityReference,
      ...policies,
    },
    { readOidcAuthority: seedOidcReader },
  );
  assert.ok(reread.bytes.equals(recorded.authorityBytes));
  let reviewedOptions = null;
  const reviewed = await reviewFoundationBootstrapDeploymentSeed(
    {
      store,
      namespace,
      githubToken: "github-token-for-test",
      ...policies,
    },
    {
      readStoredAuthority: (options) =>
        readStoredFoundationBootstrapDeploymentSeedAuthority(options, {
          readOidcAuthority: seedOidcReader,
        }),
      collectReviewedRun: async (options) => {
        reviewedOptions = options;
        return { receipt: { reviewed: true } };
      },
    },
  );
  assert.equal(reviewedOptions.expectedRunId, "7001");
  assert.equal(reviewedOptions.expectedRunAttempt, "1");
  assert.equal(reviewedOptions.expectedSourceSha, bootstrapSourceSha);
  assert.equal(reviewed.seed.authority.runId, "7001");
  assert.throws(
    () =>
      assertFoundationBootstrapDeploymentSeedAuthority({
        ...recorded.authority,
        workflowSourceSha: sourceSha,
      }),
    /identity differs/u,
  );

  const wrongSource = structuredClone(policies.p0aPolicy);
  wrongSource.bootstrapRecovery.bootstrapSourceSha = sourceSha;
  await assert.rejects(
    readStoredFoundationBootstrapDeploymentSeedAuthority(
      {
        store,
        namespace,
        reference: recorded.authorityReference,
        ...policies,
        p0aPolicy: wrongSource,
      },
      { readOidcAuthority: seedOidcReader },
    ),
    /identity differs/u,
  );
  const tampered = store.objects.get(recorded.authorityReference.sha256);
  tampered.bytes = Buffer.concat([tampered.bytes, Buffer.from(" ")]);
  await assert.rejects(
    readStoredFoundationBootstrapDeploymentSeedAuthority(
      {
        store,
        namespace,
        reference: recorded.authorityReference,
        ...policies,
      },
      { readOidcAuthority: seedOidcReader },
    ),
    /immutable verification/u,
  );
});

test("bootstrap seed rejects wrong source, run, and non-containment binding", async () => {
  const policies = markBootstrapSeedPending(configuredPolicies());
  const store = memoryStore();
  const artifact = await createBindingArtifact(store, policies);
  markBootstrapSeedPending(policies);
  const record = (bindingBytes, oidcAuthority = {}) =>
    recordFoundationBootstrapDeploymentSeed(
      {
        store,
        namespace,
        bindingBytes,
        oidcReceipt,
        oidcAuthority: {
          approvalPolicy: policies.approvalPolicy,
          workflowSourceSha: bootstrapSourceSha,
          runId: "7001",
          runAttempt: "1",
          ...oidcAuthority,
        },
        ...policies,
      },
      { readOidcAuthority: seedOidcReader },
    );
  const wrongSourceBinding = {
    ...artifact.binding,
    sourceSha,
    buildId: sourceSha,
  };
  await assert.rejects(
    record(canonicalJsonBytes(wrongSourceBinding)),
    /not store-bound|source/u,
  );
  await assert.rejects(
    record(
      canonicalJsonBytes({
        ...artifact.binding,
        releaseRole: "standard",
      }),
    ),
    /role|containment/u,
  );
  await assert.rejects(
    record(store.objects.get(artifact.bindingReference.sha256).bytes, {
      runId: "0",
    }),
    /options differ/u,
  );
});

test("collects and rederives build-less bootstrap recovery with an initialization-ready full binding", async () => {
  const fixture = await createFixture();
  assertFoundationBootstrapRecoveryObservation(fixture.observation);
  const projection = fixture.observation.stateInitializationSubject;
  assert.equal(projection.acceptedStandard, null);
  assert.equal(projection.activeProduction, null);
  assert.equal(projection.pendingOperation, null);
  assert.equal(projection.expectedState.sequence, 0);
  assert.equal(
    projection.bootstrapRecovery.providerDeploymentId,
    "deployment-bootstrap-live",
  );
  assert.deepEqual(
    projection.immutableReferences.packageIndex,
    fixture.artifact.binding.packageIndex,
  );
  assert.deepEqual(
    projection.immutableReferences.providerEvidence,
    fixture.artifact.binding.providerEvidence,
  );
  const rawStored = fixture.store.objects.get(
    fixture.observation.rawAuthority.sha256,
  );
  assert.equal(rawStored.bytes.includes(Buffer.from("provider-secret")), false);
  assert.equal(rawStored.bytes.includes(Buffer.from("github-secret")), false);
  const readback = await readStoredFoundationBootstrapRecoveryAuthority(
    {
      store: fixture.store,
      namespace,
      reference: fixture.observation.rawAuthority,
      ...fixture.policies,
      bootstrapSourceResolution: fixture.bootstrapSourceResolution,
    },
    {
      readOidcAuthority: fixture.dependencies.readOidcAuthority,
      readSeedAuthority: fixture.dependencies.readSeedAuthority,
      readWorkflowRun: fixture.dependencies.readWorkflowRun,
      assertBootstrapSource: fixture.dependencies.assertBootstrapSource,
      now: () => NOW,
    },
  );
  assert.deepEqual(readback.result, fixture.observation.result);
  assert.deepEqual(
    readback.stateInitializationSubject.bootstrapRecovery,
    fixture.artifact.binding,
  );
});

test("rejects caller authority and invalid cleanup or state projection semantics", async () => {
  const fixture = await createFixture();
  const legacyObservation = structuredClone(fixture.observation);
  legacyObservation.schemaVersion = 1;
  legacyObservation.kind = "foundation-bootstrap-recovery-observation/v1";
  assert.throws(
    () => assertFoundationBootstrapRecoveryObservation(legacyObservation),
    /observation is invalid/,
  );
  await assert.rejects(
    collectAndStoreFoundationBootstrapRecovery(fixture.options, {
      ...fixture.dependencies,
      readSeedAuthority: async () => ({
        authority: {
          runId,
          runAttempt,
          workflowSourceSha: sourceSha,
        },
        binding: fixture.artifact.binding,
        reference: bootstrapSeedAuthority,
      }),
    }),
    /not a prior dual-source run/u,
  );
  await assert.rejects(
    collectAndStoreFoundationBootstrapRecovery(
      { ...fixture.options, sourceSha: sourceSha },
      fixture.dependencies,
    ),
    /unknown or missing fields/,
  );
  await assert.rejects(
    collectAndStoreFoundationBootstrapRecovery(
      {
        ...fixture.options,
        oidcAuthority: {
          ...fixture.options.oidcAuthority,
          callerStatus: "succeeded",
        },
      },
      fixture.dependencies,
    ),
    /OIDC authority has unknown or missing fields/,
  );
  const cleanupTamper = structuredClone(fixture.operations);
  cleanupTamper.cleanup.deployments[0].verifyStatus = 200;
  assert.throws(
    () =>
      assertFoundationBootstrapRecoveryOperations(cleanupTamper, {
        artifact: fixture.artifact,
        providerPolicy: fixture.policies.providerPolicy,
        alias: fixture.operations.assignments[0].alias,
        maximumRecoverySeconds: 900,
      }),
    /cleanup did not close preview state/,
  );
  const projectionTamper = structuredClone(
    fixture.observation.stateInitializationSubject,
  );
  projectionTamper.pendingOperation = { callerAccepted: true };
  assert.throws(
    () => assertFoundationBootstrapStateInitializationSubject(projectionTamper),
    /projection differs/,
  );
  const bindingTamper = structuredClone(
    fixture.observation.stateInitializationSubject,
  );
  bindingTamper.bootstrapRecovery.providerDeploymentId = "caller-deployment-id";
  assert.throws(
    () => assertFoundationBootstrapStateInitializationSubject(bindingTamper),
    /projected binding differs/,
  );
});

test("readback rejects stale evidence, current-policy drift, and immutable receipt tamper", async () => {
  const fixture = await createFixture();
  const read = (overrides = {}, dependencies = {}) =>
    readStoredFoundationBootstrapRecoveryAuthority(
      {
        store: fixture.store,
        namespace,
        reference: fixture.observation.rawAuthority,
        ...fixture.policies,
        bootstrapSourceResolution: fixture.bootstrapSourceResolution,
        ...overrides,
      },
      {
        readOidcAuthority: fixture.dependencies.readOidcAuthority,
        readSeedAuthority: fixture.dependencies.readSeedAuthority,
        readWorkflowRun: fixture.dependencies.readWorkflowRun,
        assertBootstrapSource: fixture.dependencies.assertBootstrapSource,
        now: () => NOW,
        ...dependencies,
      },
    );
  await assert.rejects(
    read({}, { now: () => NOW + 31 * 24 * 60 * 60 * 1_000 }),
    /stale or future/,
  );
  const driftedProvider = structuredClone(fixture.policies.providerPolicy);
  driftedProvider.expectedProjectId = "project_drifted";
  await assert.rejects(
    read({ providerPolicy: driftedProvider }),
    /policy snapshot differs|provider policy/u,
  );
  const raw = JSON.parse(
    fixture.store.objects
      .get(fixture.observation.rawAuthority.sha256)
      .bytes.toString("utf8"),
  );
  const legacyRawReference = referenceFromReceipt(
    await fixture.store.putEvidence({
      bytes: canonicalJsonBytes({
        ...raw,
        schemaVersion: 1,
        kind: "foundation-bootstrap-recovery-raw/v1",
      }),
      mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_RAW_MEDIA_TYPE,
    }),
  );
  await assert.rejects(
    read({ reference: legacyRawReference }),
    /raw identity differs/u,
  );
  const wrongMediaReference = referenceFromReceipt(
    await fixture.store.putEvidence({
      bytes: canonicalJsonBytes({
        ...raw,
        schemaVersion: 1,
        kind: "foundation-bootstrap-recovery-raw/v1",
      }),
      mediaType:
        "application/vnd.event-shopping-planner.foundation-bootstrap-recovery-raw+json;version=1",
    }),
  );
  await assert.rejects(
    read({ reference: wrongMediaReference }),
    /media type differs/u,
  );
  const rawStored = fixture.store.objects.get(
    fixture.observation.rawAuthority.sha256,
  );
  rawStored.bytes = canonicalJsonBytes({
    ...raw,
    schemaVersion: 1,
    kind: "foundation-bootstrap-recovery-raw/v1",
  });
  await assert.rejects(read(), /immutable verification/u);
  rawStored.bytes = canonicalJsonBytes(raw);
  const operation = fixture.store.objects.get(
    raw.operationReceipts.recoveryDeployment.sha256,
  );
  operation.bytes = Buffer.concat([operation.bytes, Buffer.from(" ", "utf8")]);
  await assert.rejects(read(), /immutable verification|canonical/u);
});

test("preview executor performs forward/recovery and always cleans a partial failure", async () => {
  const fixture = await createFixture();
  const expected = fixture.operations;
  const calls = [];
  const environment = {
    VERCEL_TOKEN: "provider-fixture-token",
    VERCEL_PROJECT_ID: fixture.policies.providerPolicy.expectedProjectId,
    VERCEL_ORG_ID: fixture.policies.providerPolicy.expectedTeamId,
  };
  const common = {
    artifact: fixture.artifact,
    namespace,
    executorSourceSha: sourceSha,
    runId,
    runAttempt,
    p0aPolicy: fixture.policies.p0aPolicy,
    providerPolicy: fixture.policies.providerPolicy,
    toolchainPolicy,
    environment,
    root: process.cwd(),
  };
  const result = await executeFoundationBootstrapPreviewRecovery(common, {
    deploy: async ({ stage }) => {
      calls.push(`deploy:${stage}`);
      return expected.deployments[stage === "forward" ? 0 : 1];
    },
    assign: async ({ stage, alias }) => {
      calls.push(`assign:${stage}`);
      const assignment = structuredClone(
        expected.assignments[stage === "forward" ? 0 : 1],
      );
      assignment.alias = alias;
      assignment.observation.requestUrl = `https://api.vercel.com/v4/aliases/${alias}?teamId=team_p0a`;
      return assignment;
    },
    cleanupDeployment: async ({ deployments, alias }) => {
      calls.push(`cleanup:${deployments.length}`);
      return { ...expected.cleanup, alias };
    },
    clock: () => NOW - 60_000,
  });
  assert.deepEqual(result.deployments, expected.deployments);
  assert.equal(result.assignments[0].stage, "forward");
  assert.equal(result.assignments[1].stage, "recovery");
  assert.equal(result.cleanup.alias, result.assignments[0].alias);
  assert.deepEqual(calls, [
    "deploy:forward",
    "assign:forward",
    "deploy:recovery",
    "assign:recovery",
    "cleanup:2",
  ]);

  const partialCalls = [];
  await assert.rejects(
    executeFoundationBootstrapPreviewRecovery(common, {
      deploy: async ({ stage }) => {
        partialCalls.push(`deploy:${stage}`);
        return expected.deployments[0];
      },
      assign: async () => {
        partialCalls.push("assign:failed");
        throw new Error("fixture assignment failure");
      },
      cleanupDeployment: async ({ deployments }) => {
        partialCalls.push(`cleanup:${deployments.length}`);
        return { completedAt: new Date(NOW).toISOString() };
      },
      clock: () => NOW - 60_000,
    }),
    /fixture assignment failure/,
  );
  assert.deepEqual(partialCalls, [
    "deploy:forward",
    "assign:failed",
    "cleanup:1",
  ]);

  for (const failure of [
    { label: "provider-resolution", deploymentId: null },
    { label: "route-probe", deploymentId: "dpl_route_probe_failure" },
  ]) {
    const compensationCalls = [];
    await assert.rejects(
      executeFoundationBootstrapPreviewRecovery(common, {
        commandRunner: async () => ({
          status: 0,
          stdout: `https://forward-${failure.label}.vercel.app/\n`,
        }),
        resolveDeployment: async () => {
          compensationCalls.push(`failed:${failure.label}`);
          if (failure.deploymentId === null) {
            throw new Error(`fixture ${failure.label} failure`);
          }
          return { deployment: { id: failure.deploymentId } };
        },
        fetchImpl: async () =>
          new Response("fixture route probe failure", { status: 500 }),
        materializeArchive: async () => {},
        cleanupDeployment: async ({ deployments }) => {
          compensationCalls.push(`cleanup:${deployments.length}`);
          assert.equal(deployments.length, 1);
          assert.equal(deployments[0].deploymentId, failure.deploymentId);
          assert.match(deployments[0].previewUrl, /\.vercel\.app\/$/u);
          return { completedAt: new Date(NOW).toISOString() };
        },
        clock: () => NOW - 60_000,
      }),
      failure.deploymentId === null
        ? new RegExp(`fixture ${failure.label} failure`, "u")
        : /immutable route differs/u,
    );
    assert.deepEqual(compensationCalls, [
      `failed:${failure.label}`,
      "cleanup:1",
    ]);
  }
});

test("Vercel child environment excludes control-store, GitHub, OIDC, and database secrets", () => {
  const closed = buildClosedVercelCommandEnvironment({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\tools",
    PATHEXT: ".EXE;.CMD",
    TEMP: "C:\\temp",
    TMP: "C:\\temp",
    CI: "true",
    VERCEL_TOKEN: "vercel-provider-token",
    VERCEL_PROJECT_ID: "project_p0a",
    VERCEL_ORG_ID: "team_p0a",
    RELEASE_STATE_DATABASE_URL: "postgresql://control-secret",
    RELEASE_STATE_DATABASE_CA_PEM: "control-ca-secret",
    GITHUB_TOKEN: "github-secret",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
    DB_COMPATIBILITY_OBSERVER_DATABASE_URL: "postgresql://app-secret",
  });
  assert.deepEqual(Object.keys(closed).sort(), [
    "CI",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_TOKEN",
  ]);
  for (const forbidden of [
    "RELEASE_STATE_DATABASE_URL",
    "RELEASE_STATE_DATABASE_CA_PEM",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "DB_COMPATIBILITY_OBSERVER_DATABASE_URL",
  ]) {
    assert.equal(Object.hasOwn(closed, forbidden), false);
  }

  const buildEnvironment = buildClosedVercelCommandEnvironment(
    {
      VERCEL_TOKEN: "vercel-provider-token",
      VERCEL_PROJECT_ID: "project_p0a",
      VERCEL_ORG_ID: "team_p0a",
      GITHUB_TOKEN: "github-secret",
    },
    {
      additionalEnvironment: {
        FOUNDATION_RELEASE_SOURCE_SHA: "a".repeat(40),
        FOUNDATION_CANONICAL_BUILD_PURPOSE: "non-promotable-artifact-drill",
        VERCEL: "1",
        VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
        VITE_APP_BUILD_ID: "a".repeat(40),
      },
    },
  );
  assert.equal(buildEnvironment.FOUNDATION_RELEASE_SOURCE_SHA, "a".repeat(40));
  assert.equal(Object.hasOwn(buildEnvironment, "GITHUB_TOKEN"), false);
  assert.throws(
    () =>
      buildClosedVercelCommandEnvironment(closed, {
        additionalEnvironment: { GITHUB_TOKEN: "must-not-pass" },
      }),
    /build environment binding is invalid/u,
  );
  assert.throws(
    () =>
      buildClosedVercelCommandEnvironment({
        VERCEL_TOKEN: "vercel-provider-token",
        VERCEL_PROJECT_ID: "project_p0a",
        VERCEL_ORG_ID: "team_p0a",
        PATH: "C:\\tools",
        Path: "C:\\other-tools",
      }),
    /ambiguous PATH/u,
  );
});

test("bootstrap cleanup is idempotent and attempts every target before failing", async () => {
  const fixture = await createFixture();
  const providerPolicy = fixture.policies.providerPolicy;
  const deployments = fixture.operations.deployments;
  const alias = fixture.operations.assignments[0].alias;
  const calls = [];
  const notFound = () => new Response(null, { status: 404 });
  const receipt = await cleanupFoundationBootstrapPreview({
    alias,
    deployments,
    providerPolicy,
    token: "provider-fixture-token",
    fetchImpl: async (url, options) => {
      calls.push(`${options.method}:${new URL(url).pathname}`);
      return notFound();
    },
    clock: () => NOW,
  });
  assert.equal(receipt.aliasDeleteStatus, 404);
  assert.deepEqual(
    receipt.deployments.map(({ deleteStatus, verifyStatus }) => [
      deleteStatus,
      verifyStatus,
    ]),
    [
      [404, 404],
      [404, 404],
    ],
  );
  assert.equal(calls.length, 6);

  const attempted = [];
  await assert.rejects(
    cleanupFoundationBootstrapPreview({
      alias,
      deployments,
      providerPolicy,
      token: "provider-fixture-token",
      fetchImpl: async (url, options) => {
        const request = `${options.method}:${new URL(url).pathname}`;
        attempted.push(request);
        if (
          options.method === "DELETE" &&
          request.includes(encodeURIComponent(deployments[0].deploymentId))
        ) {
          throw new Error("injected first deployment deletion failure");
        }
        return notFound();
      },
      clock: () => NOW,
    }),
    /did not close every resource/,
  );
  assert.equal(attempted.length, 6);
  assert.equal(
    attempted.some((request) => request.includes(deployments[1].deploymentId)),
    true,
  );
});

test("CLI only accepts namespace/output and fails unconfigured before protected or external I/O", async () => {
  assert.deepEqual(
    parseFoundationBootstrapRecoveryArguments([
      "--namespace",
      namespace,
      "--output",
      "bootstrap.json",
    ]),
    { namespace, outputPath: "bootstrap.json" },
  );
  for (const flag of [
    "--source-sha",
    "--hash",
    "--status",
    "--url",
    "--accepted",
  ]) {
    assert.throws(
      () =>
        parseFoundationBootstrapRecoveryArguments([
          "--namespace",
          namespace,
          flag,
          "caller-value",
        ]),
      /arguments are invalid/,
    );
  }
  let protectedCalls = 0;
  let storeCalls = 0;
  let reviewedCalls = 0;
  await assert.rejects(
    runFoundationBootstrapRecoveryCli(
      {
        argv: ["--namespace", namespace, "--output", "bootstrap.json"],
        environment: {},
      },
      {
        loadPolicy: async (filePath) => {
          if (filePath.endsWith("foundation-p0a-authorities.json")) {
            return baseP0a;
          }
          if (filePath.endsWith("provider-policy.json")) return baseProvider;
          if (filePath.endsWith("db-compatibility-contract.json")) {
            return baseDatabase;
          }
          if (filePath.endsWith("release-state-store.json")) return baseStore;
          if (filePath.endsWith("approval-policy.json")) return baseApproval;
          if (filePath.endsWith("artifact-control-store-drill.json")) {
            throw new Error(
              "P0A recovery must not load the P0C artifact policy",
            );
          }
          if (filePath.endsWith("foundation-baseline.json")) {
            return baseFoundation;
          }
          return toolchainPolicy;
        },
        assertProtected: async () => {
          protectedCalls += 1;
        },
        createStore: async () => {
          storeCalls += 1;
        },
        collectReviewedRun: async () => {
          reviewedCalls += 1;
        },
      },
    ),
    /not configured/,
  );
  assert.equal(protectedCalls, 0);
  assert.equal(storeCalls, 0);
  assert.equal(reviewedCalls, 0);
});
