import { execFileSync } from "node:child_process";
import { assertReleasePackageIndex } from "./artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import { assertSafeRelativePath, manifestTreeHash } from "./file-manifest.mjs";
import {
  readStoredRemoteDbObservationOidcAuthority,
  readStoredRemoteDbProviderObservationAuthority,
} from "../db/remote-db-observation-authority.mjs";
import { assertRemoteDbObservationAuthority } from "../db/remote-db-observation.mjs";
import { assertProviderPolicyConfigured } from "../provider/collect-vercel-observation.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import { validateConnectionBinding } from "../release-state/postgresStore.mjs";
import { readReviewedWorkflowRunAuthority } from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";

export const FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-baseline-closure+json;version=1";
export const FOUNDATION_HISTORICAL_BASELINE_EVIDENCE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-historical-baseline-evidence+json;version=1";
export const FOUNDATION_DATABASE_PROVISIONING_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-database-provisioning-policy+json;version=1";
export const FOUNDATION_CONTROL_STORE_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-control-store-policy+json;version=1";
export const FOUNDATION_APPROVAL_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-approval-policy+json;version=1";
export const FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.raw-dist-manifest+json;version=1";
export const FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-bootstrap-recovery-rehearsal+json;version=2";
export const DEPLOYMENT_BINDING_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.deployment-binding+json;version=1";
export const RELEASE_PACKAGE_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-package-index+json;version=1";

const HISTORICAL_IMPLEMENTATION_TREE_SHA =
  "806794df6222053235139e7ef6684f4aa6538b3d";
const HISTORICAL_MEASUREMENT_SOURCE_SHA =
  "638dc0d2b05a09da9ea09e3f25e00bb36e1b2994";
const HISTORICAL_BASELINE_EVIDENCE_SHA256 =
  "a5997fe5fdbb9e410aa81ec37197092fcb717957a68ba9f31f4fc63431564aeb";
const HISTORICAL_BASELINE_OBJECT_SHA256 =
  "b4366d44633733233d307765f04c837eccc270cbe5ba13c519621eb7fbf1772d";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const REHEARSAL_OPERATION = "rehearse-foundation-bootstrap-recovery";
const CLOSURE_MAXIMUM_AGE_MILLISECONDS = 60 * 60 * 1_000;
const REHEARSAL_MAXIMUM_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MILLISECONDS = 30_000;
const MAXIMUM_OBJECT_BYTES = 16 * 1024 * 1024;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

const cleanSourceResolutions = new WeakMap();
const bootstrapSourceResolutions = new WeakMap();
const historicalBaselineResolutions = new WeakSet();
const policyBindingResolutions = new WeakMap();
const producerOidcResolutions = new WeakMap();
const closureResolutions = new WeakMap();

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");

const sameCanonicalValue = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertStore = (store, namespace) => {
  if (
    !store ||
    store.namespace !== namespace ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error("Foundation baseline closure store binding is invalid");
  }
};

const assertReference = ({ namespace, reference, label }) => {
  if (
    !exactKeys(reference, ["sha256", "uri"]) ||
    !SHA256_PATTERN.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} immutable reference is invalid`);
  }
  return reference;
};

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const normalizeNow = (now) => {
  const value = typeof now === "function" ? Number(now()) : Number(now);
  if (!Number.isFinite(value)) {
    throw new Error("Foundation baseline closure clock is invalid");
  }
  return value;
};

const canonicalTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
};

const assertFresh = ({ timestamp, nowMilliseconds, maximumAge, label }) => {
  if (
    nowMilliseconds - timestamp > maximumAge ||
    timestamp - nowMilliseconds > FUTURE_SKEW_MILLISECONDS
  ) {
    throw new Error(`${label} is stale or future-dated`);
  }
};

const parseCanonicalBytes = (bytes, label) => {
  const input = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from("");
  if (input.length === 0 || input.length > MAXIMUM_OBJECT_BYTES) {
    throw new Error(`${label} is empty or oversized`);
  }
  const value = parseJsonStrict(input.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(input)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return { bytes: input, value };
};

const readCanonicalStored = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) => {
  assertReference({ namespace, reference, label });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} is absent or differs from immutable storage`);
  }
  return {
    ...parseCanonicalBytes(stored.bytes, label),
    committedAt: stored.committedAt,
    reference: { ...reference },
  };
};

const putCanonicalStored = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const parsed = parseCanonicalBytes(bytes, label);
  const reference = referenceFor(namespace, parsed.bytes);
  const receipt = await store.putEvidence({ bytes: parsed.bytes, mediaType });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== parsed.bytes.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(parsed.bytes) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable put/readback differs`);
  }
  return { reference, receipt };
};

const gitRoot = (cwd) =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).trim();

const assertExactCleanSource = (resolution) => {
  const data = cleanSourceResolutions.get(resolution);
  if (data === undefined) {
    throw new Error("Foundation source resolution is not live");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: data.cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: data.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (head !== resolution.gitCommitSha || status.length !== 0) {
    throw new Error("Foundation baseline source is dirty or differs from HEAD");
  }
};

export const resolveCleanFoundationSource = ({ expectedSourceSha, cwd }) => {
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha ?? "")) {
    throw new Error("Foundation baseline expected source SHA is invalid");
  }
  const resolvedRoot = gitRoot(cwd);
  const resolution = Object.freeze({
    gitCommitSha: expectedSourceSha,
    treeState: "clean",
  });
  cleanSourceResolutions.set(resolution, { cwd: resolvedRoot });
  assertExactCleanSource(resolution);
  return resolution;
};

const assertBootstrapSource = (resolution) => {
  const data = bootstrapSourceResolutions.get(resolution);
  if (data === undefined) {
    throw new Error("Foundation bootstrap source resolution is not live");
  }
  execFileSync(
    "git",
    ["cat-file", "-e", `${resolution.gitCommitSha}^{commit}`],
    {
      cwd: data.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  const treeSha = execFileSync(
    "git",
    ["rev-parse", `${resolution.gitCommitSha}^{tree}`],
    {
      cwd: data.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  ).trim();
  if (treeSha !== resolution.treeSha) {
    throw new Error(
      "Foundation bootstrap commit tree differs after resolution",
    );
  }
};

export const assertLiveBootstrapFoundationSource = (resolution) => {
  assertBootstrapSource(resolution);
  return resolution;
};

export const resolveBootstrapFoundationSource = ({
  bootstrapSourceSha,
  cwd,
}) => {
  if (!SOURCE_SHA_PATTERN.test(bootstrapSourceSha ?? "")) {
    throw new Error("Foundation bootstrap source SHA is invalid");
  }
  const resolvedRoot = gitRoot(cwd);
  execFileSync("git", ["cat-file", "-e", `${bootstrapSourceSha}^{commit}`], {
    cwd: resolvedRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const treeSha = execFileSync(
    "git",
    ["rev-parse", `${bootstrapSourceSha}^{tree}`],
    {
      cwd: resolvedRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  ).trim();
  if (!SOURCE_SHA_PATTERN.test(treeSha)) {
    throw new Error("Foundation bootstrap tree SHA is invalid");
  }
  const resolution = Object.freeze({
    gitCommitSha: bootstrapSourceSha,
    treeSha,
  });
  bootstrapSourceResolutions.set(resolution, { cwd: resolvedRoot });
  return resolution;
};

export const resolveHistoricalFoundationBaseline = (baseline) => {
  if (
    !exactKeys(baseline, [
      "baselineEvidence",
      "baselineEvidenceSha256",
      "blockers",
      "bootstrapBaselineSourceSha",
      "externalBindings",
      "implementationTreeBaselineSha",
      "measurementSourceSha",
      "schemaVersion",
    ]) ||
    baseline.schemaVersion !== 1 ||
    baseline.implementationTreeBaselineSha !==
      HISTORICAL_IMPLEMENTATION_TREE_SHA ||
    baseline.measurementSourceSha !== HISTORICAL_MEASUREMENT_SOURCE_SHA ||
    baseline.bootstrapBaselineSourceSha !== null ||
    baseline.baselineEvidenceSha256 !== HISTORICAL_BASELINE_EVIDENCE_SHA256 ||
    sha256Json(baseline.baselineEvidence) !==
      HISTORICAL_BASELINE_EVIDENCE_SHA256 ||
    sha256Json(baseline) !== HISTORICAL_BASELINE_OBJECT_SHA256
  ) {
    throw new Error(
      "Historical foundation baseline differs from its authority",
    );
  }
  const legacyDatabase = baseline.externalBindings?.metricsDatabase;
  if (
    !exactKeys(legacyDatabase, [
      "backupOwner",
      "fingerprint",
      "projectRef",
      "restoreOwner",
      "status",
    ])
  ) {
    throw new Error("Historical database baseline binding is invalid");
  }
  const resolution = Object.freeze({
    implementationTreeBaselineSha: baseline.implementationTreeBaselineSha,
    measurementSourceSha: baseline.measurementSourceSha,
    baselineEvidenceSha256: baseline.baselineEvidenceSha256,
    evidenceBytes: canonicalJsonBytes(baseline.baselineEvidence),
    legacyDatabase: Object.freeze(structuredClone(legacyDatabase)),
  });
  historicalBaselineResolutions.add(resolution);
  return resolution;
};

const configuredApprovalProjection = (policy) => {
  const roles = policy?.roles;
  const reviewerTeams = {
    dataSafetyReviewer: roles?.dataSafetyReviewer?.reviewerTeam,
    operationsReviewer: roles?.operationsReviewer?.reviewerTeam,
    releaseOwner: roles?.releaseOwner?.reviewerTeam,
  };
  if (
    policy?.bindingStatus !== "configured" ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0 ||
    policy.trustedIssuer !== "https://token.actions.githubusercontent.com" ||
    !REPOSITORY_PATTERN.test(policy.repository ?? "") ||
    policy.workflowRef !==
      `${policy.repository}/${RELEASE_WORKFLOW_PATH}@refs/heads/main` ||
    typeof policy.protectedEnvironment !== "string" ||
    policy.protectedEnvironment.length === 0 ||
    typeof policy.oidcAudience !== "string" ||
    policy.oidcAudience.length === 0 ||
    !Number.isSafeInteger(policy.oidcClockSkewSeconds) ||
    !Number.isSafeInteger(policy.oidcMaxTokenAgeSeconds) ||
    Object.values(reviewerTeams).some(
      (team) => typeof team !== "string" || team.length === 0,
    ) ||
    new Set(Object.values(reviewerTeams)).size !== 3
  ) {
    throw new Error("Foundation approval policy is not configured");
  }
  return {
    schemaVersion: 1,
    policyKind: "foundation-approval-binding/v1",
    trustedIssuer: policy.trustedIssuer,
    oidcAudience: policy.oidcAudience,
    repository: policy.repository,
    workflowRef: policy.workflowRef,
    protectedEnvironment: policy.protectedEnvironment,
    reviewerTeams,
  };
};

const providerProvisioningProjection = (policy) => {
  assertProviderPolicyConfigured(policy);
  return {
    schemaVersion: 1,
    policyKind: "foundation-provider-binding/v1",
    provider: policy.provider,
    teamId: policy.expectedTeamId,
    projectId: policy.expectedProjectId,
    ownedProductionDomains: [...policy.ownedProductionDomains],
    productionEnvironmentName: policy.productionEnvironmentName,
    productionBranch: policy.productionBranch,
  };
};

const databaseProvisioningProjection = (contract) => {
  const authority = contract?.remote?.observationAuthority;
  assertRemoteDbObservationAuthority(authority, { requireConfigured: true });
  if (
    contract.schemaVersion !== 1 ||
    typeof contract.contractUri !== "string" ||
    contract.contractUri.length === 0 ||
    !["local-specification", "remote-verified"].includes(
      contract.contractStatus,
    ) ||
    !["unobserved", "observed"].includes(contract.remote.observationStatus)
  ) {
    throw new Error("Foundation application database binding is invalid");
  }
  return {
    schemaVersion: 1,
    policyKind: "foundation-database-provisioning/v1",
    contractUri: contract.contractUri,
    postgresMajor: authority.postgresMajor,
    databaseUrlEnvironmentName: authority.databaseUrlEnvironmentName,
    databaseCaEnvironmentName: authority.databaseCaEnvironmentName,
    tlsMode: authority.tlsMode,
    allowedHosts: [...authority.allowedHosts],
    allowedDatabases: [...authority.allowedDatabases],
    allowedObserverRoles: [...authority.allowedObserverRoles],
    serviceRole: authority.serviceRole,
    productionCaSha256: authority.productionCaSha256,
  };
};

const controlStoreProjection = (policy) => {
  if (
    !isRecord(policy) ||
    policy.bindingStatus !== "configured" ||
    policy.engine !== "postgresql" ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0 ||
    !Array.isArray(policy.allowedHosts) ||
    policy.allowedHosts.length === 0 ||
    !Array.isArray(policy.allowedDatabases) ||
    policy.allowedDatabases.length === 0 ||
    !Array.isArray(policy.allowedExecutorRoles) ||
    policy.allowedExecutorRoles.length === 0 ||
    typeof policy.backupOwner !== "string" ||
    policy.backupOwner.length === 0 ||
    typeof policy.restoreOwner !== "string" ||
    policy.restoreOwner.length === 0 ||
    !SHA256_PATTERN.test(policy.productionCaSha256 ?? "")
  ) {
    throw new Error("Foundation control store is not configured");
  }
  return {
    schemaVersion: 1,
    policyKind: "foundation-control-store-binding/v1",
    engine: policy.engine,
    postgresMajor: policy.postgresMajor,
    allowedHosts: [...policy.allowedHosts],
    allowedDatabases: [...policy.allowedDatabases],
    allowedExecutorRoles: [...policy.allowedExecutorRoles],
    productionCaSha256: policy.productionCaSha256,
    backupOwner: policy.backupOwner,
    restoreOwner: policy.restoreOwner,
  };
};

const validateApplicationDatabaseConnection = ({
  connectionString,
  ca,
  policy,
}) => {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Foundation database observer URL is invalid");
  }
  let database;
  let observerRole;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    observerRole = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("Foundation database observer URL authority is invalid");
  }
  const queryNames = [...new Set(parsed.searchParams.keys())];
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.password.length === 0 ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.pathname.slice(1).includes("/") ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "5432") ||
    queryNames.length !== 1 ||
    queryNames[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== policy.tlsMode ||
    !policy.allowedHosts.includes(parsed.hostname) ||
    !policy.allowedDatabases.includes(database) ||
    !policy.allowedObserverRoles.includes(observerRole) ||
    typeof ca !== "string" ||
    ca.length === 0 ||
    sha256Bytes(Buffer.from(ca, "utf8")) !== policy.productionCaSha256
  ) {
    throw new Error(
      "Foundation database observer connection binding is invalid",
    );
  }
  return {
    engine: "postgresql",
    host: parsed.hostname,
    database,
    observerRole,
    tlsMode: policy.tlsMode,
    productionCaSha256: policy.productionCaSha256,
  };
};

export const resolveFoundationBaselinePolicyBindings = ({
  store,
  namespace,
  providerPolicy,
  databaseContract,
  controlStorePolicy,
  approvalPolicy,
  controlStoreConnectionString,
  controlStoreCa,
  applicationDatabaseConnectionString,
  applicationDatabaseCa,
}) => {
  if (!NAMESPACE_PATTERN.test(namespace ?? "")) {
    throw new Error("Foundation baseline namespace is invalid");
  }
  assertStore(store, namespace);
  const providerPolicyProjection =
    providerProvisioningProjection(providerPolicy);
  const databasePolicyProjection =
    databaseProvisioningProjection(databaseContract);
  const controlPolicyProjection = controlStoreProjection(controlStorePolicy);
  const approvalPolicyProjection = configuredApprovalProjection(approvalPolicy);
  const controlConnection = validateConnectionBinding(
    controlStoreConnectionString,
    controlStorePolicy,
  );
  if (
    typeof controlStoreCa !== "string" ||
    controlStoreCa.length === 0 ||
    sha256Bytes(Buffer.from(controlStoreCa, "utf8")) !==
      controlStorePolicy.productionCaSha256
  ) {
    throw new Error("Foundation control store CA binding is invalid");
  }
  const applicationDatabaseBinding = validateApplicationDatabaseConnection({
    connectionString: applicationDatabaseConnectionString,
    ca: applicationDatabaseCa,
    policy: databasePolicyProjection,
  });
  const resolution = Object.freeze({
    namespace,
    providerPolicy: structuredClone(providerPolicy),
    approvalPolicy: structuredClone(approvalPolicy),
    providerPolicyProjection: Object.freeze(providerPolicyProjection),
    databasePolicyProjection: Object.freeze(databasePolicyProjection),
    databaseCurrentStatus: Object.freeze({
      contractStatus: databaseContract.contractStatus,
      observationStatus: databaseContract.remote.observationStatus,
    }),
    controlPolicyProjection: Object.freeze(controlPolicyProjection),
    approvalPolicyProjection: Object.freeze(approvalPolicyProjection),
    applicationDatabaseBinding: Object.freeze(applicationDatabaseBinding),
    controlStoreBinding: Object.freeze({
      namespace,
      engine: "postgresql",
      host: controlConnection.host,
      database: controlConnection.database,
      executorRole: controlConnection.role,
      productionCaSha256: controlStorePolicy.productionCaSha256,
      backupOwner: controlStorePolicy.backupOwner,
      restoreOwner: controlStorePolicy.restoreOwner,
    }),
  });
  policyBindingResolutions.set(resolution, { store });
  return resolution;
};

export const resolveFoundationBaselineProducerOidc = async ({
  store,
  policyBindingResolution,
  reference,
  sourceResolution,
  runId,
  runAttempt,
}) => {
  if (
    policyBindingResolutions.get(policyBindingResolution)?.store !== store ||
    !cleanSourceResolutions.has(sourceResolution) ||
    !RUN_ID_PATTERN.test(runId ?? "") ||
    !RUN_ID_PATTERN.test(runAttempt ?? "")
  ) {
    throw new Error("Foundation producer OIDC resolution identity is invalid");
  }
  const namespace = policyBindingResolution.namespace;
  await readStoredRemoteDbObservationOidcAuthority({
    store,
    namespace,
    reference,
    approvalPolicy: policyBindingResolution.approvalPolicy,
    sourceSha: sourceResolution.gitCommitSha,
    runId,
    runAttempt,
  });
  const resolution = Object.freeze({
    reference: Object.freeze({ ...reference }),
    runId,
    runAttempt,
  });
  producerOidcResolutions.set(resolution, {
    store,
    policyBindingResolution,
    sourceResolution,
  });
  return resolution;
};

const assertRawDistManifest = (bytes) => {
  const parsed = parseCanonicalBytes(bytes, "Foundation raw dist manifest");
  const manifest = parsed.value;
  if (
    !exactKeys(manifest, ["files", "schemaVersion", "treeSha256"]) ||
    manifest.schemaVersion !== 1 ||
    !SHA256_PATTERN.test(manifest.treeSha256 ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("Foundation raw dist manifest identity is invalid");
  }
  const folded = new Set();
  let previous = null;
  for (const file of manifest.files) {
    if (
      !exactKeys(file, ["path", "sha256", "size"]) ||
      !SHA256_PATTERN.test(file.sha256 ?? "") ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error("Foundation raw dist manifest file is invalid");
    }
    assertSafeRelativePath(file.path);
    if (
      (previous !== null &&
        Buffer.compare(
          Buffer.from(previous, "utf8"),
          Buffer.from(file.path, "utf8"),
        ) >= 0) ||
      folded.has(file.path.toLocaleLowerCase("en-US"))
    ) {
      throw new Error(
        "Foundation raw dist manifest is unsorted or aliases a path",
      );
    }
    previous = file.path;
    folded.add(file.path.toLocaleLowerCase("en-US"));
  }
  if (manifestTreeHash(manifest.files) !== manifest.treeSha256) {
    throw new Error("Foundation raw dist manifest tree hash differs");
  }
  return parsed;
};

const readBootstrapBinding = async ({
  store,
  namespace,
  reference,
  providerPolicy,
  providerObservation,
  bootstrapSourceResolution,
  databasePolicyProjection,
}) => {
  const stored = await readCanonicalStored({
    store,
    namespace,
    reference,
    mediaType: DEPLOYMENT_BINDING_MEDIA_TYPE,
    label: "Foundation bootstrap deployment binding",
  });
  const binding = assertDeploymentBinding(stored.value, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Foundation bootstrap deployment binding",
  });
  if (
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    binding.sourceSha !== bootstrapSourceResolution.gitCommitSha ||
    binding.providerProjectId !== providerPolicy.expectedProjectId ||
    binding.providerPolicy.sha256 !== sha256Json(providerPolicy) ||
    binding.providerConfigurationHash !==
      providerConfigurationHash(providerObservation) ||
    binding.requiredDbCompatibility.contractUri !==
      databasePolicyProjection.contractUri
  ) {
    throw new Error(
      "Foundation bootstrap binding differs from its authorities",
    );
  }
  await Promise.all([
    validateProviderEvidenceForBinding({
      store,
      namespace,
      binding,
      label: "Foundation bootstrap deployment binding",
    }),
    assertArtifactArchiveAvailable({
      store,
      namespace,
      binding,
      label: "Foundation bootstrap deployment binding",
    }),
  ]);
  const packageIndexStored = await readCanonicalStored({
    store,
    namespace,
    reference: binding.packageIndex,
    mediaType: RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
    label: "Foundation bootstrap release package index",
  });
  const packageIndex = assertReleasePackageIndex(packageIndexStored.value, {
    expectedBuildPurpose: "production",
  });
  if (
    packageIndex.packageKind !== "legacy-bootstrap-single" ||
    packageIndex.sourceSha !== bootstrapSourceResolution.gitCommitSha ||
    packageIndex.artifact.releaseRole !== "containment" ||
    packageIndex.artifact.archive.sha256 !== binding.artifactArchive.sha256 ||
    packageIndex.providerPolicyHash !== binding.providerPolicy.sha256 ||
    packageIndex.providerConfigurationHash !==
      binding.providerConfigurationHash ||
    !sameCanonicalValue(
      packageIndex.requiredDbCompatibility,
      binding.requiredDbCompatibility,
    )
  ) {
    throw new Error("Foundation bootstrap package differs from its deployment");
  }
  return { binding, packageIndex };
};

const assertRecoveryRehearsalShape = (rehearsal) => {
  if (
    !exactKeys(rehearsal, [
      "artifactArchiveSha256",
      "completedAt",
      "dataLossObserved",
      "evidenceKind",
      "executorSourceSha",
      "namespace",
      "operation",
      "outcome",
      "producerOidc",
      "rawDistManifestSha256",
      "recoveryBindingId",
      "recoveryDeploymentId",
      "recoveryTimeSeconds",
      "repository",
      "restoredArtifactSha256",
      "reviewedWorkflowRun",
      "runAttempt",
      "runId",
      "schemaVersion",
      "sourceSha",
      "startedAt",
      "workflowPath",
    ]) ||
    rehearsal.schemaVersion !== 1 ||
    rehearsal.evidenceKind !== "foundation-bootstrap-recovery-rehearsal/v2" ||
    rehearsal.operation !== REHEARSAL_OPERATION ||
    rehearsal.workflowPath !== RELEASE_WORKFLOW_PATH ||
    !REPOSITORY_PATTERN.test(rehearsal.repository ?? "") ||
    !SOURCE_SHA_PATTERN.test(rehearsal.sourceSha ?? "") ||
    !SOURCE_SHA_PATTERN.test(rehearsal.executorSourceSha ?? "") ||
    !RUN_ID_PATTERN.test(rehearsal.runId ?? "") ||
    !RUN_ID_PATTERN.test(rehearsal.runAttempt ?? "") ||
    !SHA256_PATTERN.test(rehearsal.rawDistManifestSha256 ?? "") ||
    !SHA256_PATTERN.test(rehearsal.artifactArchiveSha256 ?? "") ||
    !SHA256_PATTERN.test(rehearsal.restoredArtifactSha256 ?? "") ||
    typeof rehearsal.recoveryBindingId !== "string" ||
    rehearsal.recoveryBindingId.length === 0 ||
    typeof rehearsal.recoveryDeploymentId !== "string" ||
    rehearsal.recoveryDeploymentId.length === 0 ||
    !Number.isSafeInteger(rehearsal.recoveryTimeSeconds) ||
    rehearsal.recoveryTimeSeconds < 1 ||
    rehearsal.dataLossObserved !== false ||
    rehearsal.outcome !== "succeeded"
  ) {
    throw new Error("Foundation bootstrap recovery rehearsal is invalid");
  }
};

const readRecoveryRehearsal = async ({
  store,
  namespace,
  reference,
  expectedSourceSha,
  expectedExecutorSourceSha,
  expectedBinding,
  expectedRawDistManifestSha256,
  approvalPolicy,
  currentWorkflowRunId,
  nowMilliseconds,
}) => {
  const stored = await readCanonicalStored({
    store,
    namespace,
    reference,
    mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
    label: "Foundation bootstrap recovery rehearsal",
  });
  const rehearsal = stored.value;
  assertRecoveryRehearsalShape(rehearsal);
  const startedAt = canonicalTimestamp(
    rehearsal.startedAt,
    "Foundation recovery rehearsal start",
  );
  const completedAt = canonicalTimestamp(
    rehearsal.completedAt,
    "Foundation recovery rehearsal completion",
  );
  assertFresh({
    timestamp: completedAt,
    nowMilliseconds,
    maximumAge: REHEARSAL_MAXIMUM_AGE_MILLISECONDS,
    label: "Foundation recovery rehearsal",
  });
  if (
    rehearsal.namespace !== namespace ||
    rehearsal.repository !== approvalPolicy.repository ||
    rehearsal.sourceSha !== expectedSourceSha ||
    rehearsal.executorSourceSha !== expectedExecutorSourceSha ||
    rehearsal.runId === currentWorkflowRunId ||
    rehearsal.recoveryBindingId !== expectedBinding.bindingId ||
    rehearsal.recoveryDeploymentId !== expectedBinding.providerDeploymentId ||
    rehearsal.rawDistManifestSha256 !== expectedRawDistManifestSha256 ||
    rehearsal.artifactArchiveSha256 !==
      expectedBinding.artifactArchive.sha256 ||
    rehearsal.restoredArtifactSha256 !== rehearsal.artifactArchiveSha256 ||
    completedAt <= startedAt ||
    rehearsal.recoveryTimeSeconds < Math.ceil((completedAt - startedAt) / 1_000)
  ) {
    throw new Error("Foundation recovery rehearsal binding differs");
  }
  await Promise.all([
    readStoredRemoteDbObservationOidcAuthority({
      store,
      namespace,
      reference: rehearsal.producerOidc,
      approvalPolicy,
      sourceSha: rehearsal.executorSourceSha,
      runId: rehearsal.runId,
      runAttempt: rehearsal.runAttempt,
    }),
    readReviewedWorkflowRunAuthority({
      namespace,
      repository: rehearsal.repository,
      expectedRunId: rehearsal.runId,
      expectedRunAttempt: rehearsal.runAttempt,
      expectedSourceSha: rehearsal.executorSourceSha,
      expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
      reference: rehearsal.reviewedWorkflowRun,
      store,
    }),
  ]);
  return rehearsal;
};

export const readFoundationBootstrapRecoveryRehearsalAuthority = (options) =>
  readRecoveryRehearsal(options);

export const putFoundationBootstrapRecoveryRehearsalAuthority = async ({
  store,
  rehearsal,
  expectedBinding,
  expectedRawDistManifestSha256,
  approvalPolicy,
  currentWorkflowRunId,
  now = Date.now,
}) => {
  assertRecoveryRehearsalShape(rehearsal);
  assertStore(store, rehearsal.namespace);
  const bytes = canonicalJsonBytes(rehearsal);
  const stored = await putCanonicalStored({
    store,
    namespace: rehearsal.namespace,
    bytes,
    mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
    label: "Foundation bootstrap recovery rehearsal",
  });
  const readback = await readRecoveryRehearsal({
    store,
    namespace: rehearsal.namespace,
    reference: stored.reference,
    expectedSourceSha: rehearsal.sourceSha,
    expectedExecutorSourceSha: rehearsal.executorSourceSha,
    expectedBinding,
    expectedRawDistManifestSha256,
    approvalPolicy,
    currentWorkflowRunId,
    nowMilliseconds: normalizeNow(now),
  });
  if (!sameCanonicalValue(readback, rehearsal)) {
    throw new Error("Foundation recovery rehearsal readback differs");
  }
  return Object.freeze({
    reference: Object.freeze({ ...stored.reference }),
    receipt: Object.freeze({ ...stored.receipt }),
    rehearsal: Object.freeze(structuredClone(rehearsal)),
  });
};

const supportObject = (namespace, value, mediaType, label) => {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : canonicalJsonBytes(value);
  return { bytes, mediaType, label, reference: referenceFor(namespace, bytes) };
};

const closureKeys = [
  "applicationDatabase",
  "approvalPolicy",
  "authorityKind",
  "bootstrap",
  "closureSource",
  "controlStore",
  "historicalBaseline",
  "namespace",
  "observedAt",
  "producer",
  "provider",
  "schemaVersion",
];

const assertClosureShape = ({
  closure,
  namespace,
  closureSourceResolution,
  bootstrapSourceResolution,
}) => {
  if (
    !exactKeys(closure, closureKeys) ||
    closure.schemaVersion !== 1 ||
    closure.authorityKind !== "foundation-baseline-closure/v1" ||
    closure.namespace !== namespace ||
    !sameCanonicalValue(closure.closureSource, closureSourceResolution) ||
    !exactKeys(closure.producer, ["oidc", "runAttempt", "runId"]) ||
    !exactKeys(closure.provider, [
      "deploymentBinding",
      "observation",
      "policy",
    ]) ||
    !exactKeys(closure.applicationDatabase, [
      "binding",
      "historicalBaseline",
      "provisioningPolicy",
      "statusAtClosure",
    ]) ||
    !exactKeys(closure.applicationDatabase.statusAtClosure, [
      "contractStatus",
      "observationStatus",
    ]) ||
    !["local-specification", "remote-verified"].includes(
      closure.applicationDatabase.statusAtClosure.contractStatus,
    ) ||
    !["unobserved", "observed"].includes(
      closure.applicationDatabase.statusAtClosure.observationStatus,
    ) ||
    !exactKeys(closure.controlStore, ["binding", "policy"]) ||
    !exactKeys(closure.historicalBaseline, [
      "baselineEvidenceSha256",
      "evidence",
      "implementationTreeBaselineSha",
      "measurementSourceSha",
    ]) ||
    closure.historicalBaseline.implementationTreeBaselineSha !==
      HISTORICAL_IMPLEMENTATION_TREE_SHA ||
    closure.historicalBaseline.measurementSourceSha !==
      HISTORICAL_MEASUREMENT_SOURCE_SHA ||
    closure.historicalBaseline.baselineEvidenceSha256 !==
      HISTORICAL_BASELINE_EVIDENCE_SHA256 ||
    !exactKeys(closure.bootstrap, [
      "bootstrapBaselineSourceSha",
      "commitTreeSha",
      "rawDistManifest",
      "recoveryRehearsal",
      "selectionBasis",
    ]) ||
    closure.bootstrap.bootstrapBaselineSourceSha !==
      bootstrapSourceResolution.gitCommitSha ||
    closure.bootstrap.commitTreeSha !== bootstrapSourceResolution.treeSha ||
    closure.bootstrap.selectionBasis !== "provider-bound-source"
  ) {
    throw new Error("Foundation baseline closure shape or identity is invalid");
  }
  for (const [reference, label] of [
    [closure.producer.oidc, "Closure producer OIDC"],
    [closure.historicalBaseline.evidence, "Historical baseline evidence"],
    [closure.provider.deploymentBinding, "Provider deployment binding"],
    [closure.provider.observation, "Provider observation"],
    [closure.provider.policy, "Provider policy"],
    [
      closure.applicationDatabase.provisioningPolicy,
      "Database provisioning policy",
    ],
    [closure.controlStore.policy, "Control store policy"],
    [closure.approvalPolicy, "Approval policy"],
    [closure.bootstrap.rawDistManifest, "Raw dist manifest"],
    [closure.bootstrap.recoveryRehearsal, "Recovery rehearsal"],
  ]) {
    assertReference({ namespace, reference, label });
  }
};

export const resolveFoundationBaselineClosure = async ({
  store,
  sourceResolution,
  bootstrapSourceResolution,
  historicalBaselineResolution,
  policyBindingResolution,
  producerOidcResolution,
  providerBindingReference,
  providerObservationReference,
  providerPolicyReference,
  rawDistManifestBytes,
  recoveryRehearsalReference,
  currentWorkflowRunId,
  now = Date.now,
}) => {
  if (
    !cleanSourceResolutions.has(sourceResolution) ||
    !bootstrapSourceResolutions.has(bootstrapSourceResolution) ||
    !historicalBaselineResolutions.has(historicalBaselineResolution) ||
    policyBindingResolutions.get(policyBindingResolution)?.store !== store ||
    producerOidcResolutions.get(producerOidcResolution)?.store !== store ||
    producerOidcResolutions.get(producerOidcResolution)
      ?.policyBindingResolution !== policyBindingResolution ||
    producerOidcResolutions.get(producerOidcResolution)?.sourceResolution !==
      sourceResolution ||
    producerOidcResolution.runId !== currentWorkflowRunId
  ) {
    throw new Error("Foundation baseline closure requires live resolutions");
  }
  assertExactCleanSource(sourceResolution);
  assertBootstrapSource(bootstrapSourceResolution);
  const namespace = policyBindingResolution.namespace;
  assertStore(store, namespace);
  for (const [reference, label] of [
    [providerBindingReference, "Foundation provider binding"],
    [providerObservationReference, "Foundation provider observation"],
    [providerPolicyReference, "Foundation provider policy"],
    [recoveryRehearsalReference, "Foundation recovery rehearsal"],
  ]) {
    assertReference({ namespace, reference, label });
  }
  const nowMilliseconds = normalizeNow(now);
  const rawDist = assertRawDistManifest(rawDistManifestBytes);
  const provider = await readStoredRemoteDbProviderObservationAuthority({
    store,
    namespace,
    reference: providerObservationReference,
    policyReference: providerPolicyReference,
    now: () => nowMilliseconds,
  });
  if (
    !sameCanonicalValue(
      providerProvisioningProjection(provider.providerPolicy),
      policyBindingResolution.providerPolicyProjection,
    )
  ) {
    throw new Error("Foundation provider observation policy differs");
  }
  const bootstrap = await readBootstrapBinding({
    store,
    namespace,
    reference: providerBindingReference,
    providerPolicy: provider.providerPolicy,
    providerObservation: provider.observation,
    bootstrapSourceResolution,
    databasePolicyProjection: policyBindingResolution.databasePolicyProjection,
  });
  if (
    sha256Bytes(rawDist.bytes) !== bootstrap.packageIndex.rawDistManifest.sha256
  ) {
    throw new Error(
      "Foundation raw dist manifest differs from bootstrap package",
    );
  }
  await readRecoveryRehearsal({
    store,
    namespace,
    reference: recoveryRehearsalReference,
    expectedSourceSha: bootstrapSourceResolution.gitCommitSha,
    expectedExecutorSourceSha: sourceResolution.gitCommitSha,
    expectedBinding: bootstrap.binding,
    expectedRawDistManifestSha256: sha256Bytes(rawDist.bytes),
    approvalPolicy: policyBindingResolution.approvalPolicy,
    currentWorkflowRunId,
    nowMilliseconds,
  });
  const supportObjects = [
    supportObject(
      namespace,
      historicalBaselineResolution.evidenceBytes,
      FOUNDATION_HISTORICAL_BASELINE_EVIDENCE_MEDIA_TYPE,
      "Historical foundation baseline evidence",
    ),
    supportObject(
      namespace,
      policyBindingResolution.databasePolicyProjection,
      FOUNDATION_DATABASE_PROVISIONING_POLICY_MEDIA_TYPE,
      "Foundation database provisioning policy",
    ),
    supportObject(
      namespace,
      policyBindingResolution.controlPolicyProjection,
      FOUNDATION_CONTROL_STORE_POLICY_MEDIA_TYPE,
      "Foundation control store policy",
    ),
    supportObject(
      namespace,
      policyBindingResolution.approvalPolicyProjection,
      FOUNDATION_APPROVAL_POLICY_MEDIA_TYPE,
      "Foundation approval policy",
    ),
    supportObject(
      namespace,
      rawDist.bytes,
      FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE,
      "Foundation raw dist manifest",
    ),
  ];
  const byMediaType = new Map(
    supportObjects.map((object) => [object.mediaType, object]),
  );
  const closure = {
    schemaVersion: 1,
    authorityKind: "foundation-baseline-closure/v1",
    namespace,
    closureSource: { ...sourceResolution },
    observedAt: new Date(nowMilliseconds).toISOString(),
    producer: {
      runId: producerOidcResolution.runId,
      runAttempt: producerOidcResolution.runAttempt,
      oidc: { ...producerOidcResolution.reference },
    },
    historicalBaseline: {
      implementationTreeBaselineSha:
        historicalBaselineResolution.implementationTreeBaselineSha,
      measurementSourceSha: historicalBaselineResolution.measurementSourceSha,
      baselineEvidenceSha256:
        historicalBaselineResolution.baselineEvidenceSha256,
      evidence: {
        ...byMediaType.get(FOUNDATION_HISTORICAL_BASELINE_EVIDENCE_MEDIA_TYPE)
          .reference,
      },
    },
    provider: {
      deploymentBinding: { ...providerBindingReference },
      observation: { ...providerObservationReference },
      policy: { ...providerPolicyReference },
    },
    applicationDatabase: {
      provisioningPolicy: {
        ...byMediaType.get(FOUNDATION_DATABASE_PROVISIONING_POLICY_MEDIA_TYPE)
          .reference,
      },
      binding: { ...policyBindingResolution.applicationDatabaseBinding },
      historicalBaseline: { ...historicalBaselineResolution.legacyDatabase },
      statusAtClosure: { ...policyBindingResolution.databaseCurrentStatus },
    },
    controlStore: {
      policy: {
        ...byMediaType.get(FOUNDATION_CONTROL_STORE_POLICY_MEDIA_TYPE)
          .reference,
      },
      binding: { ...policyBindingResolution.controlStoreBinding },
    },
    approvalPolicy: {
      ...byMediaType.get(FOUNDATION_APPROVAL_POLICY_MEDIA_TYPE).reference,
    },
    bootstrap: {
      bootstrapBaselineSourceSha: bootstrapSourceResolution.gitCommitSha,
      commitTreeSha: bootstrapSourceResolution.treeSha,
      selectionBasis: "provider-bound-source",
      rawDistManifest: {
        ...byMediaType.get(FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE).reference,
      },
      recoveryRehearsal: { ...recoveryRehearsalReference },
    },
  };
  assertClosureShape({
    closure,
    namespace,
    closureSourceResolution: sourceResolution,
    bootstrapSourceResolution,
  });
  assertExactCleanSource(sourceResolution);
  assertBootstrapSource(bootstrapSourceResolution);
  const resolution = Object.freeze({
    closure: Object.freeze(structuredClone(closure)),
    bytes: canonicalJsonBytes(closure),
  });
  closureResolutions.set(resolution, {
    store,
    supportObjects,
    sourceResolution,
    bootstrapSourceResolution,
    policyBindingResolution,
    currentWorkflowRunId,
    nowMilliseconds,
  });
  return resolution;
};

export const readFoundationBaselineClosureAuthority = async ({
  store,
  reference,
  sourceResolution,
  bootstrapSourceResolution,
  policyBindingResolution,
  currentWorkflowRunId,
  now = Date.now,
}) => {
  if (
    !cleanSourceResolutions.has(sourceResolution) ||
    !bootstrapSourceResolutions.has(bootstrapSourceResolution) ||
    policyBindingResolutions.get(policyBindingResolution)?.store !== store ||
    !RUN_ID_PATTERN.test(currentWorkflowRunId ?? "")
  ) {
    throw new Error("Foundation baseline readback requires live resolutions");
  }
  assertExactCleanSource(sourceResolution);
  assertBootstrapSource(bootstrapSourceResolution);
  const namespace = policyBindingResolution.namespace;
  assertStore(store, namespace);
  const stored = await readCanonicalStored({
    store,
    namespace,
    reference,
    mediaType: FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
    label: "Foundation baseline closure",
  });
  const closure = stored.value;
  assertClosureShape({
    closure,
    namespace,
    closureSourceResolution: sourceResolution,
    bootstrapSourceResolution,
  });
  const nowMilliseconds = normalizeNow(now);
  assertFresh({
    timestamp: canonicalTimestamp(
      closure.observedAt,
      "Foundation baseline closure observation",
    ),
    nowMilliseconds,
    maximumAge: CLOSURE_MAXIMUM_AGE_MILLISECONDS,
    label: "Foundation baseline closure",
  });
  const [historical, databasePolicy, controlPolicy, approvalPolicy, rawDist] =
    await Promise.all([
      readCanonicalStored({
        store,
        namespace,
        reference: closure.historicalBaseline.evidence,
        mediaType: FOUNDATION_HISTORICAL_BASELINE_EVIDENCE_MEDIA_TYPE,
        label: "Historical foundation baseline evidence",
      }),
      readCanonicalStored({
        store,
        namespace,
        reference: closure.applicationDatabase.provisioningPolicy,
        mediaType: FOUNDATION_DATABASE_PROVISIONING_POLICY_MEDIA_TYPE,
        label: "Foundation database provisioning policy",
      }),
      readCanonicalStored({
        store,
        namespace,
        reference: closure.controlStore.policy,
        mediaType: FOUNDATION_CONTROL_STORE_POLICY_MEDIA_TYPE,
        label: "Foundation control store policy",
      }),
      readCanonicalStored({
        store,
        namespace,
        reference: closure.approvalPolicy,
        mediaType: FOUNDATION_APPROVAL_POLICY_MEDIA_TYPE,
        label: "Foundation approval policy",
      }),
      readCanonicalStored({
        store,
        namespace,
        reference: closure.bootstrap.rawDistManifest,
        mediaType: FOUNDATION_RAW_DIST_MANIFEST_MEDIA_TYPE,
        label: "Foundation raw dist manifest",
      }),
    ]);
  if (
    historical.reference.sha256 !== HISTORICAL_BASELINE_EVIDENCE_SHA256 ||
    sha256Json(historical.value) !== HISTORICAL_BASELINE_EVIDENCE_SHA256 ||
    !sameCanonicalValue(
      databasePolicy.value,
      policyBindingResolution.databasePolicyProjection,
    ) ||
    !sameCanonicalValue(
      controlPolicy.value,
      policyBindingResolution.controlPolicyProjection,
    ) ||
    !sameCanonicalValue(
      approvalPolicy.value,
      policyBindingResolution.approvalPolicyProjection,
    ) ||
    !sameCanonicalValue(
      closure.applicationDatabase.binding,
      policyBindingResolution.applicationDatabaseBinding,
    ) ||
    !sameCanonicalValue(
      closure.controlStore.binding,
      policyBindingResolution.controlStoreBinding,
    )
  ) {
    throw new Error("Foundation baseline configured binding differs");
  }
  await readStoredRemoteDbObservationOidcAuthority({
    store,
    namespace,
    reference: closure.producer.oidc,
    approvalPolicy: policyBindingResolution.approvalPolicy,
    sourceSha: closure.closureSource.gitCommitSha,
    runId: closure.producer.runId,
    runAttempt: closure.producer.runAttempt,
  });
  const provider = await readStoredRemoteDbProviderObservationAuthority({
    store,
    namespace,
    reference: closure.provider.observation,
    policyReference: closure.provider.policy,
    now: () => nowMilliseconds,
  });
  if (
    !sameCanonicalValue(
      providerProvisioningProjection(provider.providerPolicy),
      policyBindingResolution.providerPolicyProjection,
    )
  ) {
    throw new Error("Foundation provider provisioning binding differs");
  }
  const bootstrap = await readBootstrapBinding({
    store,
    namespace,
    reference: closure.provider.deploymentBinding,
    providerPolicy: provider.providerPolicy,
    providerObservation: provider.observation,
    bootstrapSourceResolution,
    databasePolicyProjection: policyBindingResolution.databasePolicyProjection,
  });
  const rawDistManifest = assertRawDistManifest(rawDist.bytes);
  if (
    bootstrap.packageIndex.rawDistManifest.sha256 !==
      closure.bootstrap.rawDistManifest.sha256 ||
    sha256Bytes(rawDistManifest.bytes) !==
      closure.bootstrap.rawDistManifest.sha256
  ) {
    throw new Error("Foundation bootstrap raw dist binding differs");
  }
  const recoveryRehearsal = await readRecoveryRehearsal({
    store,
    namespace,
    reference: closure.bootstrap.recoveryRehearsal,
    expectedSourceSha: bootstrapSourceResolution.gitCommitSha,
    expectedExecutorSourceSha: sourceResolution.gitCommitSha,
    expectedBinding: bootstrap.binding,
    expectedRawDistManifestSha256: closure.bootstrap.rawDistManifest.sha256,
    approvalPolicy: policyBindingResolution.approvalPolicy,
    currentWorkflowRunId,
    nowMilliseconds,
  });
  assertExactCleanSource(sourceResolution);
  assertBootstrapSource(bootstrapSourceResolution);
  return Object.freeze({
    closure: Object.freeze(structuredClone(closure)),
    bytes: Buffer.from(stored.bytes),
    reference: Object.freeze({ ...reference }),
    bootstrapBinding: Object.freeze(structuredClone(bootstrap.binding)),
    providerObservation: Object.freeze(structuredClone(provider.observation)),
    recoveryRehearsal: Object.freeze(structuredClone(recoveryRehearsal)),
  });
};

const assertStoredConnectionProjection = ({
  closure,
  namespace,
  databasePolicyProjection,
  controlPolicyProjection,
}) => {
  const application = closure.applicationDatabase?.binding;
  const control = closure.controlStore?.binding;
  if (
    !exactKeys(application, [
      "database",
      "engine",
      "host",
      "observerRole",
      "productionCaSha256",
      "tlsMode",
    ]) ||
    application.engine !== "postgresql" ||
    !databasePolicyProjection.allowedHosts.includes(application.host) ||
    !databasePolicyProjection.allowedDatabases.includes(application.database) ||
    !databasePolicyProjection.allowedObserverRoles.includes(
      application.observerRole,
    ) ||
    application.tlsMode !== databasePolicyProjection.tlsMode ||
    application.productionCaSha256 !==
      databasePolicyProjection.productionCaSha256 ||
    !exactKeys(control, [
      "backupOwner",
      "database",
      "engine",
      "executorRole",
      "host",
      "namespace",
      "productionCaSha256",
      "restoreOwner",
    ]) ||
    control.namespace !== namespace ||
    control.engine !== "postgresql" ||
    !controlPolicyProjection.allowedHosts.includes(control.host) ||
    !controlPolicyProjection.allowedDatabases.includes(control.database) ||
    !controlPolicyProjection.allowedExecutorRoles.includes(
      control.executorRole,
    ) ||
    control.productionCaSha256 !== controlPolicyProjection.productionCaSha256 ||
    control.backupOwner !== controlPolicyProjection.backupOwner ||
    control.restoreOwner !== controlPolicyProjection.restoreOwner
  ) {
    throw new Error("Stored foundation connection projection is invalid");
  }
  return { application, control };
};

// This wrapper is the phase-exit/readiness entry point. It derives every
// branded live resolution from the immutable closure and configured policies;
// callers cannot substitute hashes, booleans, or unbranded projections.
export const readFoundationBaselineClosureForPhaseExit = async ({
  store,
  reference,
  expectedSourceSha,
  cwd,
  providerPolicy,
  databaseContract,
  controlStorePolicy,
  approvalPolicy,
  currentWorkflowRunId,
  now = Date.now,
}) => {
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha ?? "")) {
    throw new Error("Foundation phase exit source SHA is invalid");
  }
  const namespace = store?.namespace;
  assertStore(store, namespace);
  const stored = await readCanonicalStored({
    store,
    namespace,
    reference,
    mediaType: FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
    label: "Foundation baseline closure phase-exit source",
  });
  const closure = stored.value;
  const bootstrapSourceSha = closure?.bootstrap?.bootstrapBaselineSourceSha;
  if (
    closure?.closureSource?.gitCommitSha !== expectedSourceSha ||
    !SOURCE_SHA_PATTERN.test(bootstrapSourceSha ?? "")
  ) {
    throw new Error("Foundation phase exit closure source binding differs");
  }
  const sourceResolution = resolveCleanFoundationSource({
    expectedSourceSha,
    cwd,
  });
  const bootstrapSourceResolution = resolveBootstrapFoundationSource({
    bootstrapSourceSha,
    cwd,
  });
  const providerPolicyProjection =
    providerProvisioningProjection(providerPolicy);
  const databasePolicyProjection =
    databaseProvisioningProjection(databaseContract);
  const controlPolicyProjection = controlStoreProjection(controlStorePolicy);
  const approvalPolicyProjection = configuredApprovalProjection(approvalPolicy);
  const connectionProjection = assertStoredConnectionProjection({
    closure,
    namespace,
    databasePolicyProjection,
    controlPolicyProjection,
  });
  const policyBindingResolution = Object.freeze({
    namespace,
    providerPolicy: structuredClone(providerPolicy),
    approvalPolicy: structuredClone(approvalPolicy),
    providerPolicyProjection: Object.freeze(providerPolicyProjection),
    databasePolicyProjection: Object.freeze(databasePolicyProjection),
    databaseCurrentStatus: Object.freeze({
      contractStatus:
        closure.applicationDatabase.statusAtClosure.contractStatus,
      observationStatus:
        closure.applicationDatabase.statusAtClosure.observationStatus,
    }),
    controlPolicyProjection: Object.freeze(controlPolicyProjection),
    approvalPolicyProjection: Object.freeze(approvalPolicyProjection),
    applicationDatabaseBinding: Object.freeze({
      ...connectionProjection.application,
    }),
    controlStoreBinding: Object.freeze({ ...connectionProjection.control }),
  });
  policyBindingResolutions.set(policyBindingResolution, { store });
  return readFoundationBaselineClosureAuthority({
    store,
    reference,
    sourceResolution,
    bootstrapSourceResolution,
    policyBindingResolution,
    currentWorkflowRunId,
    now,
  });
};

export const putFoundationBaselineClosureAuthority = async ({
  store,
  resolution,
}) => {
  const data = closureResolutions.get(resolution);
  if (data === undefined || data.store !== store) {
    throw new Error("Foundation baseline producer requires a live resolution");
  }
  const namespace = resolution.closure.namespace;
  assertExactCleanSource(data.sourceResolution);
  assertBootstrapSource(data.bootstrapSourceResolution);
  const supportReceipts = await Promise.all(
    data.supportObjects.map(async (object) => {
      const stored = await putCanonicalStored({
        store,
        namespace,
        bytes: object.bytes,
        mediaType: object.mediaType,
        label: object.label,
      });
      if (!sameCanonicalValue(stored.reference, object.reference)) {
        throw new Error(`${object.label} reference differs after storage`);
      }
      return stored;
    }),
  );
  const closureStored = await putCanonicalStored({
    store,
    namespace,
    bytes: resolution.bytes,
    mediaType: FOUNDATION_BASELINE_CLOSURE_MEDIA_TYPE,
    label: "Foundation baseline closure",
  });
  const readback = await readFoundationBaselineClosureAuthority({
    store,
    reference: closureStored.reference,
    sourceResolution: data.sourceResolution,
    bootstrapSourceResolution: data.bootstrapSourceResolution,
    policyBindingResolution: data.policyBindingResolution,
    currentWorkflowRunId: data.currentWorkflowRunId,
    now: () => data.nowMilliseconds,
  });
  if (!readback.bytes.equals(resolution.bytes)) {
    throw new Error("Foundation baseline closure readback bytes differ");
  }
  return Object.freeze({
    reference: Object.freeze({ ...closureStored.reference }),
    receipt: Object.freeze({ ...closureStored.receipt }),
    supportReceipts: Object.freeze(
      supportReceipts.map(({ reference, receipt }) =>
        Object.freeze({
          reference: Object.freeze({ ...reference }),
          receipt: Object.freeze({ ...receipt }),
        }),
      ),
    ),
    closure: resolution.closure,
  });
};

export const FOUNDATION_BASELINE_HISTORICAL_AUTHORITY = Object.freeze({
  implementationTreeBaselineSha: HISTORICAL_IMPLEMENTATION_TREE_SHA,
  measurementSourceSha: HISTORICAL_MEASUREMENT_SOURCE_SHA,
  baselineEvidenceSha256: HISTORICAL_BASELINE_EVIDENCE_SHA256,
  baselineObjectSha256: HISTORICAL_BASELINE_OBJECT_SHA256,
});
