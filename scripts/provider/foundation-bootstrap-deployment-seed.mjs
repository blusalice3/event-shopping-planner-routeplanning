import path from "node:path";
import process from "node:process";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectAndStoreProductionRequestGraphOidcAuthority,
  readStoredProductionRequestGraphOidcAuthority,
} from "../browser/production-request-graph.mjs";
import { readStoredRemoteDbProviderObservationAuthority } from "../db/remote-db-observation-authority.mjs";
import { assertReleasePackageIndex } from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { writeExactCreateOnlyFile } from "../lib/exact-file-write.mjs";
import { manifestTreeHash } from "../lib/file-manifest.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "../release-state/protected-release.mjs";
import { collectReviewedWorkflowRunAuthority } from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertExactKeys,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertConfiguredFoundationP0aAuthorities,
  assertFoundationP0aBootstrapSeedPrerequisites,
} from "./foundation-p0a-authorities-policy.mjs";

export const FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-bootstrap-deployment-seed+json;version=1";
const DEPLOYMENT_BINDING_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.deployment-binding+json;version=1";
const RELEASE_PACKAGE_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-package-index+json;version=1";
const PROVIDER_ENVIRONMENT_PRESENCE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.environment-presence+json;version=1";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKFLOW_PATH = ".github/workflows/release.yml";
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const MAXIMUM_INPUT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Foundation bootstrap seed environment is absent: ${name}`);
  }
  return value;
};

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return Object.freeze({
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  });
};

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], `${label} reference`);
  if (
    !SHA256.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} reference is invalid`);
  }
  return reference;
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
  return value;
};

const assertRawDistManifest = (manifest) => {
  assertExactKeys(
    manifest,
    ["files", "schemaVersion", "treeSha256"],
    "Foundation bootstrap seed raw dist manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    !SHA256.test(manifest.treeSha256 ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifestTreeHash(manifest.files) !== manifest.treeSha256
  ) {
    throw new Error("Foundation bootstrap seed raw dist manifest differs");
  }
  return manifest;
};

const readExactFile = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return readExactRegularFile({
    description: { path: resolved, ...describeExactFile(metadata) },
    maximumBytes: MAXIMUM_INPUT_BYTES,
    label,
  });
};

const parseCanonical = (bytes, label) => {
  const input = Buffer.from(bytes ?? "");
  if (input.length === 0) throw new Error(`${label} is empty`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  const value = parseJsonStrict(text, label);
  if (!canonicalJsonBytes(value).equals(input)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
};

const readStoredCanonical = async ({
  store,
  namespace,
  reference,
  label,
  mediaType = null,
}) => {
  assertReference(reference, namespace, label);
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    (mediaType !== null && stored.mediaType !== mediaType)
  ) {
    throw new Error(`${label} is absent or failed immutable verification`);
  }
  return Object.freeze({
    bytes: Buffer.from(stored.bytes),
    value: parseCanonical(stored.bytes, label),
  });
};

const putCanonical = async ({ store, namespace, value }) => {
  const bytes = canonicalJsonBytes(value);
  const reference = referenceFor(namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE,
  });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error("Foundation bootstrap deployment seed store differs");
  }
  return Object.freeze({ bytes, reference, receipt });
};

export const readFoundationBootstrapSeedProviderObservationBinding = async ({
  store,
  namespace,
  binding,
  providerPolicy,
}) => {
  const evidence = await validateProviderEvidenceForBinding({
    store,
    namespace,
    binding,
    label: "Foundation bootstrap seed binding",
  });
  const environmentPresenceReference = {
    uri:
      `release-state://${namespace}/evidence/` +
      evidence.environmentPresenceEvidenceHash,
    sha256: evidence.environmentPresenceEvidenceHash,
  };
  const environmentStored = await readStoredCanonical({
    store,
    namespace,
    reference: environmentPresenceReference,
    label: "Foundation bootstrap seed environment presence",
    mediaType: PROVIDER_ENVIRONMENT_PRESENCE_MEDIA_TYPE,
  });
  const environmentPresence = environmentStored.value;
  assertExactKeys(
    environmentPresence,
    [
      "evidenceKind",
      "forbiddenEnvironmentNames",
      "namespace",
      "observedAt",
      "presentEnvironmentNames",
      "productionEnvironmentName",
      "providerConfigurationHash",
      "providerObservation",
      "providerProjectId",
      "providerTeamId",
      "receipt",
      "requiredEnvironmentNames",
      "schemaVersion",
    ],
    "Foundation bootstrap seed environment presence",
  );
  assertReference(
    environmentPresence.providerObservation,
    namespace,
    "Bootstrap seed provider observation",
  );
  if (
    environmentPresence.schemaVersion !== 1 ||
    environmentPresence.evidenceKind !== "provider-environment-presence/v1" ||
    environmentPresence.namespace !== namespace ||
    environmentPresence.providerProjectId !== binding.providerProjectId ||
    environmentPresence.providerTeamId !== providerPolicy.expectedTeamId ||
    environmentPresence.productionEnvironmentName !==
      providerPolicy.productionEnvironmentName ||
    environmentPresence.providerConfigurationHash !==
      binding.providerConfigurationHash
  ) {
    throw new Error(
      "Foundation bootstrap seed provider observation chain differs",
    );
  }
  const provider = await readStoredRemoteDbProviderObservationAuthority({
    store,
    namespace,
    reference: environmentPresence.providerObservation,
    policyReference: binding.providerPolicy,
  });
  if (!sameCanonicalValue(provider.providerPolicy, providerPolicy)) {
    throw new Error("Foundation bootstrap seed provider policy differs");
  }
  return Object.freeze({
    observation: Object.freeze({ ...environmentPresence.providerObservation }),
    policy: Object.freeze({ ...binding.providerPolicy }),
  });
};

export const assertFoundationBootstrapDeploymentSeedAuthority = (
  authority,
  {
    namespace = authority?.namespace,
    bootstrapSourceSha = authority?.bootstrapSourceSha,
    workflowSourceSha = authority?.workflowSourceSha,
    repository = authority?.repository,
    runId = authority?.runId,
    runAttempt = authority?.runAttempt,
  } = {},
) => {
  assertExactKeys(
    authority,
    [
      "artifactArchive",
      "artifactArchiveAvailability",
      "binding",
      "bindingId",
      "bootstrapSourceSha",
      "kind",
      "namespace",
      "oidcReceipt",
      "packageIndex",
      "providerEvidence",
      "rawDistManifest",
      "recordedAt",
      "repository",
      "runAttempt",
      "runId",
      "schemaVersion",
      "workflowPath",
      "workflowSourceSha",
    ],
    "Foundation bootstrap deployment seed authority",
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.kind !== "foundation-bootstrap-deployment-seed/v1" ||
    authority.namespace !== namespace ||
    !NAMESPACE.test(authority.namespace ?? "") ||
    authority.bootstrapSourceSha !== bootstrapSourceSha ||
    authority.workflowSourceSha !== workflowSourceSha ||
    authority.bootstrapSourceSha !== authority.workflowSourceSha ||
    !SOURCE_SHA.test(authority.bootstrapSourceSha ?? "") ||
    !SOURCE_SHA.test(authority.workflowSourceSha ?? "") ||
    authority.repository !== repository ||
    typeof authority.repository !== "string" ||
    authority.workflowPath !== WORKFLOW_PATH ||
    authority.runId !== runId ||
    authority.runAttempt !== runAttempt ||
    !RUN_ID.test(authority.runId ?? "") ||
    !RUN_ID.test(authority.runAttempt ?? "") ||
    typeof authority.bindingId !== "string" ||
    authority.bindingId.length === 0
  ) {
    throw new Error("Foundation bootstrap deployment seed identity differs");
  }
  canonicalTimestamp(
    authority.recordedAt,
    "Foundation bootstrap deployment seed time",
  );
  for (const [name, reference] of Object.entries({
    artifactArchive: authority.artifactArchive,
    artifactArchiveAvailability: authority.artifactArchiveAvailability,
    binding: authority.binding,
    oidcReceipt: authority.oidcReceipt,
    packageIndex: authority.packageIndex,
    providerEvidence: authority.providerEvidence,
    rawDistManifest: authority.rawDistManifest,
  })) {
    assertReference(reference, authority.namespace, `Bootstrap seed ${name}`);
  }
  return authority;
};

const assertSeedPolicies = ({
  p0aPolicy,
  providerPolicy,
  databaseContract,
  storePolicy,
  approvalPolicy,
  requireConfigured,
}) =>
  requireConfigured
    ? assertConfiguredFoundationP0aAuthorities({
        p0aPolicy,
        providerPolicy,
        databaseContract,
        storePolicy,
        approvalPolicy,
      })
    : assertFoundationP0aBootstrapSeedPrerequisites({
        p0aPolicy,
        providerPolicy,
        databaseContract,
        storePolicy,
        approvalPolicy,
      });

export const readStoredFoundationBootstrapDeploymentSeedAuthority = async (
  {
    store,
    namespace,
    reference,
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    requireConfigured = true,
  },
  { readOidcAuthority = readStoredProductionRequestGraphOidcAuthority } = {},
) => {
  assertSeedPolicies({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    requireConfigured,
  });
  if (store?.namespace !== namespace) {
    throw new Error("Foundation bootstrap seed store namespace differs");
  }
  if (
    requireConfigured &&
    reference?.sha256 !==
      p0aPolicy.bootstrapRecovery.deploymentSeedAuthoritySha256
  ) {
    throw new Error("Foundation bootstrap seed policy reference differs");
  }
  const stored = await readStoredCanonical({
    store,
    namespace,
    reference,
    label: "Foundation bootstrap deployment seed authority",
    mediaType: FOUNDATION_BOOTSTRAP_DEPLOYMENT_SEED_MEDIA_TYPE,
  });
  const authority = assertFoundationBootstrapDeploymentSeedAuthority(
    stored.value,
    {
      namespace,
      bootstrapSourceSha: requireConfigured
        ? p0aPolicy.bootstrapRecovery.bootstrapSourceSha
        : stored.value?.workflowSourceSha,
      workflowSourceSha: stored.value?.workflowSourceSha,
      repository: approvalPolicy.repository,
      runId: stored.value?.runId,
      runAttempt: stored.value?.runAttempt,
    },
  );
  const bindingStored = await readStoredCanonical({
    store,
    namespace,
    reference: authority.binding,
    label: "Foundation bootstrap seed binding",
    mediaType: DEPLOYMENT_BINDING_MEDIA_TYPE,
  });
  const binding = assertDeploymentBinding(bindingStored.value, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Foundation bootstrap seed binding",
  });
  if (
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    binding.bindingId !== authority.bindingId ||
    binding.sourceSha !== authority.bootstrapSourceSha ||
    binding.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(binding.artifactArchive, authority.artifactArchive) ||
    !sameCanonicalValue(
      binding.artifactArchiveAvailability,
      authority.artifactArchiveAvailability,
    ) ||
    !sameCanonicalValue(binding.packageIndex, authority.packageIndex) ||
    !sameCanonicalValue(binding.providerEvidence, authority.providerEvidence) ||
    (requireConfigured &&
      authority.binding.sha256 !==
        p0aPolicy.bootstrapRecovery.deploymentBindingSha256)
  ) {
    throw new Error("Foundation bootstrap seed binding differs");
  }
  const [indexStored, providerPolicyStored] = await Promise.all([
    readStoredCanonical({
      store,
      namespace,
      reference: binding.packageIndex,
      label: "Foundation bootstrap seed package index",
      mediaType: RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
    }),
    readStoredCanonical({
      store,
      namespace,
      reference: binding.providerPolicy,
      label: "Foundation bootstrap seed provider policy",
    }),
  ]);
  const index = assertReleasePackageIndex(indexStored.value, {
    expectedBuildPurpose: "production",
  });
  if (
    index.packageKind !== "legacy-bootstrap-single" ||
    index.sourceSha !== authority.bootstrapSourceSha ||
    !sameCanonicalValue(index.rawDistManifest, authority.rawDistManifest) ||
    (requireConfigured &&
      authority.rawDistManifest.sha256 !==
        p0aPolicy.bootstrapRecovery.rawDistManifestSha256) ||
    !sameCanonicalValue(providerPolicyStored.value, providerPolicy)
  ) {
    throw new Error("Foundation bootstrap seed package differs");
  }
  const rawDistStored = await readStoredCanonical({
    store,
    namespace,
    reference: authority.rawDistManifest,
    label: "Foundation bootstrap seed raw dist manifest",
  });
  assertRawDistManifest(rawDistStored.value);
  await Promise.all([
    readOidcAuthority({
      store,
      namespace,
      reference: authority.oidcReceipt,
      approvalPolicy,
      sourceSha: authority.workflowSourceSha,
      runId: authority.runId,
      runAttempt: authority.runAttempt,
    }),
    validateProviderEvidenceForBinding({
      store,
      namespace,
      binding,
      label: "Foundation bootstrap seed binding",
    }),
    assertArtifactArchiveAvailable({
      store,
      namespace,
      binding,
      label: "Foundation bootstrap seed binding",
    }),
  ]);
  return Object.freeze({
    authority: Object.freeze(structuredClone(authority)),
    binding: Object.freeze(structuredClone(binding)),
    bytes: Buffer.from(stored.bytes),
    reference: Object.freeze({ ...reference }),
  });
};

export const recordFoundationBootstrapDeploymentSeed = async (
  {
    store,
    namespace,
    bindingBytes,
    oidcReceipt,
    oidcAuthority,
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  },
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    readStoredAuthority = readStoredFoundationBootstrapDeploymentSeedAuthority,
  } = {},
) => {
  assertSeedPolicies({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    requireConfigured: false,
  });
  if (
    store?.namespace !== namespace ||
    !RUN_ID.test(oidcAuthority?.runId ?? "") ||
    !RUN_ID.test(oidcAuthority?.runAttempt ?? "") ||
    !sameCanonicalValue(oidcAuthority?.approvalPolicy, approvalPolicy)
  ) {
    throw new Error("Foundation bootstrap deployment seed options differ");
  }
  const workflowSourceSha = oidcAuthority?.workflowSourceSha;
  const bootstrapSourceSha = workflowSourceSha;
  if (
    !SOURCE_SHA.test(workflowSourceSha ?? "") ||
    p0aPolicy.bootstrapRecovery.bootstrapSourceSha !== null ||
    p0aPolicy.bootstrapRecovery.rawDistManifestSha256 !== null
  ) {
    throw new Error("Foundation bootstrap seed baseline is not pending");
  }
  const bindingInput = Buffer.from(bindingBytes ?? "");
  const binding = assertDeploymentBinding(
    parseCanonical(bindingInput, "Foundation bootstrap seed binding input"),
    {
      namespace,
      expectedRole: "containment",
      allowLegacyBootstrap: true,
      label: "Foundation bootstrap seed binding input",
    },
  );
  const bindingReference = referenceFor(namespace, bindingInput);
  const bindingStored = await store.readEvidence({
    sha256: bindingReference.sha256,
  });
  if (
    !Buffer.isBuffer(bindingStored?.bytes) ||
    !bindingStored.bytes.equals(bindingInput) ||
    bindingStored.mediaType !== DEPLOYMENT_BINDING_MEDIA_TYPE ||
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    binding.sourceSha !== bootstrapSourceSha
  ) {
    throw new Error("Foundation bootstrap seed binding is not store-bound");
  }
  const oidc = await readOidcAuthority({
    store,
    namespace,
    reference: oidcReceipt,
    approvalPolicy,
    sourceSha: workflowSourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
  });
  const recordedAt = canonicalTimestamp(
    oidc?.receipt?.verifiedAt ?? oidc?.readback?.receipt?.verifiedAt,
    "Foundation bootstrap seed OIDC verification time",
  );
  const indexStored = await readStoredCanonical({
    store,
    namespace,
    reference: binding.packageIndex,
    label: "Foundation bootstrap seed package index",
    mediaType: RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
  });
  const index = assertReleasePackageIndex(indexStored.value, {
    expectedBuildPurpose: "production",
  });
  if (
    index.packageKind !== "legacy-bootstrap-single" ||
    index.sourceSha !== bootstrapSourceSha
  ) {
    throw new Error("Foundation bootstrap seed immutable package differs");
  }
  const authority = assertFoundationBootstrapDeploymentSeedAuthority(
    {
      schemaVersion: 1,
      kind: "foundation-bootstrap-deployment-seed/v1",
      namespace,
      repository: approvalPolicy.repository,
      workflowPath: WORKFLOW_PATH,
      bootstrapSourceSha,
      workflowSourceSha,
      runId: oidcAuthority.runId,
      runAttempt: oidcAuthority.runAttempt,
      recordedAt,
      oidcReceipt: { ...oidcReceipt },
      bindingId: binding.bindingId,
      binding: { ...bindingReference },
      packageIndex: { ...binding.packageIndex },
      rawDistManifest: {
        uri: `release-state://${namespace}/evidence/${index.rawDistManifest.sha256}`,
        sha256: index.rawDistManifest.sha256,
      },
      providerEvidence: { ...binding.providerEvidence },
      artifactArchive: { ...binding.artifactArchive },
      artifactArchiveAvailability: {
        ...binding.artifactArchiveAvailability,
      },
    },
    {
      namespace,
      bootstrapSourceSha,
      workflowSourceSha,
      repository: approvalPolicy.repository,
      runId: oidcAuthority.runId,
      runAttempt: oidcAuthority.runAttempt,
    },
  );
  const stored = await putCanonical({ store, namespace, value: authority });
  const verified = await readStoredAuthority(
    {
      store,
      namespace,
      reference: stored.reference,
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
      requireConfigured: false,
    },
    { readOidcAuthority },
  );
  if (!verified.bytes.equals(stored.bytes)) {
    throw new Error("Foundation bootstrap deployment seed readback differs");
  }
  return Object.freeze({
    authority: Object.freeze(structuredClone(authority)),
    authorityBytes: Buffer.from(stored.bytes),
    authorityReference: Object.freeze({ ...stored.reference }),
    binding: Object.freeze(structuredClone(binding)),
    bindingReference,
  });
};

export const reviewFoundationBootstrapDeploymentSeed = async (
  options,
  {
    readStoredAuthority = readStoredFoundationBootstrapDeploymentSeedAuthority,
    collectReviewedRun = collectReviewedWorkflowRunAuthority,
  } = {},
) => {
  const reference = {
    uri:
      `release-state://${options.namespace}/evidence/` +
      options.p0aPolicy.bootstrapRecovery.deploymentSeedAuthoritySha256,
    sha256: options.p0aPolicy.bootstrapRecovery.deploymentSeedAuthoritySha256,
  };
  const seed = await readStoredAuthority({ ...options, reference });
  const reviewed = await collectReviewedRun({
    githubToken: options.githubToken,
    namespace: options.namespace,
    repository: options.approvalPolicy.repository,
    expectedRunId: seed.authority.runId,
    expectedRunAttempt: seed.authority.runAttempt,
    expectedSourceSha: seed.authority.workflowSourceSha,
    expectedWorkflowPath: WORKFLOW_PATH,
    store: options.store,
  });
  return Object.freeze({ seed, reviewed });
};

export const parseFoundationBootstrapDeploymentSeedArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== 6) {
    throw new Error(
      "Usage: foundation-bootstrap-deployment-seed.mjs --namespace <namespace> --binding <file> --output <new-file>",
    );
  }
  const allowed = new Set(["--namespace", "--binding", "--output"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Foundation bootstrap deployment seed arguments are invalid",
      );
    }
    values.set(flag, value);
  }
  if (!NAMESPACE.test(values.get("--namespace") ?? "")) {
    throw new Error(
      "Foundation bootstrap deployment seed namespace is invalid",
    );
  }
  return Object.freeze({
    namespace: values.get("--namespace"),
    bindingPath: values.get("--binding"),
    outputPath: values.get("--output"),
  });
};

const readJson = async (filePath, label) =>
  parseJsonStrict(
    (await readExactFile(filePath, label)).toString("utf8"),
    label,
  );

export const runFoundationBootstrapDeploymentSeedCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadPolicy = readJson,
    assertProtected = assertProtectedWorkflowEnvironment,
    createStore = createPostgresReleaseStateStore,
    collectOidc = collectAndStoreProductionRequestGraphOidcAuthority,
    recordSeed = recordFoundationBootstrapDeploymentSeed,
    writeOutput = writeExactCreateOnlyFile,
  } = {},
) => {
  const parsed = parseFoundationBootstrapDeploymentSeedArguments(argv);
  if (
    requireEnvironment(environment, "REQUESTED_OPERATION") !==
    "seed-foundation-bootstrap-deployment-binding"
  ) {
    throw new Error("Foundation bootstrap seed operation differs");
  }
  const [
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  ] = await Promise.all([
    loadPolicy(
      path.join(root, "config", "foundation-p0a-authorities.json"),
      "Foundation P0A authority policy",
    ),
    loadPolicy(
      path.join(root, "config", "provider-policy.json"),
      "Foundation provider policy",
    ),
    loadPolicy(
      path.join(root, "config", "db-compatibility-contract.json"),
      "Foundation database contract",
    ),
    loadPolicy(
      path.join(root, "config", "release-state-store.json"),
      "Foundation control store policy",
    ),
    loadPolicy(
      path.join(root, "config", "approval-policy.json"),
      "Foundation approval policy",
    ),
  ]);
  assertFoundationP0aBootstrapSeedPrerequisites({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  });
  const workflowSourceSha = requireEnvironment(environment, "GITHUB_SHA");
  if (
    !SOURCE_SHA.test(workflowSourceSha) ||
    p0aPolicy.bootstrapRecovery.bootstrapSourceSha !== null ||
    p0aPolicy.bootstrapRecovery.rawDistManifestSha256 !== null
  ) {
    throw new Error("Foundation bootstrap seed baseline is not pending");
  }
  assertProtected({
    env: environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha: workflowSourceSha,
    runId: requireEnvironment(environment, "GITHUB_RUN_ID"),
  });
  for (const name of [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]) {
    requireEnvironment(environment, name);
  }
  const store = await createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace: parsed.namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const runId = requireEnvironment(environment, "GITHUB_RUN_ID");
    const runAttempt = requireEnvironment(environment, "GITHUB_RUN_ATTEMPT");
    const oidc = await collectOidc({
      store,
      namespace: parsed.namespace,
      sourceSha: workflowSourceSha,
      runId,
      runAttempt,
      approvalPolicy,
      environment,
    });
    const result = await recordSeed({
      store,
      namespace: parsed.namespace,
      bindingBytes: await readExactFile(
        path.resolve(cwd, parsed.bindingPath),
        "Foundation bootstrap seed binding",
      ),
      oidcReceipt: oidc.reference,
      oidcAuthority: {
        approvalPolicy,
        workflowSourceSha,
        runId,
        runAttempt,
      },
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
    });
    await writeOutput({
      outputPath: path.resolve(cwd, parsed.outputPath),
      bytes: result.authorityBytes,
      label: "Foundation bootstrap deployment seed authority",
      maximumBytes: MAXIMUM_OUTPUT_BYTES,
    });
    stdout.write(
      `PASS foundation bootstrap deployment seed: ${result.authorityReference.sha256}\n`,
    );
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runFoundationBootstrapDeploymentSeedCli();
