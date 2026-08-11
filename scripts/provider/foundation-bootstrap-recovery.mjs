import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { verifyDeterministicZip } from "../deterministic-zip.mjs";
import {
  assertArtifactManifest,
  assertBootstrapInput,
  assertManifestMatchesOutput,
  assertReleasePackageIndex,
} from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { manifestTreeHash } from "../lib/file-manifest.mjs";
import { assertBootstrapStaticOutput } from "../lib/artifact-builder-core.mjs";
import {
  DEPLOYMENT_BINDING_MEDIA_TYPE,
  FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
  RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
  assertLiveBootstrapFoundationSource,
} from "../lib/foundation-baseline-closure-authority.mjs";
import { readStoredProductionRequestGraphOidcAuthority } from "../browser/production-request-graph.mjs";
import { readReviewedWorkflowRunAuthority } from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";
import { resolveAuthoritativeVercelDeployment } from "./prebuiltDeployment.mjs";
import { extractPrebuiltArchive } from "./prebuiltDeployment.mjs";
import { resolvePinnedVercelCli } from "./preparedPromotion.mjs";
import { assertConfiguredFoundationP0aAuthorities } from "./foundation-p0a-authorities-policy.mjs";
import { readStoredFoundationBootstrapDeploymentSeedAuthority } from "./foundation-bootstrap-deployment-seed.mjs";
import { buildClosedVercelCommandEnvironment } from "./vercel-command-environment.mjs";

export const FOUNDATION_BOOTSTRAP_RECOVERY_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-bootstrap-recovery-raw+json;version=2";
export const FOUNDATION_BOOTSTRAP_RECOVERY_OPERATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-bootstrap-recovery-operation+json;version=1";
export const FOUNDATION_BOOTSTRAP_RECOVERY_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-bootstrap-recovery+json;version=2";
export const FOUNDATION_BOOTSTRAP_POLICY_SNAPSHOT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-bootstrap-policy-snapshot+json;version=2";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAXIMUM_OBJECT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_PROVIDER_BYTES = 4 * 1024 * 1024;
const MAXIMUM_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MILLISECONDS = 30_000;
const REHEARSAL_OPERATION = "rehearse-foundation-bootstrap-recovery";
const WORKFLOW_PATH = ".github/workflows/release.yml";
const OPTION_KEYS = [
  "approvalPolicy",
  "bootstrapSeedAuthority",
  "bootstrapSourceResolution",
  "databaseContract",
  "environment",
  "foundationBaseline",
  "namespace",
  "oidcAuthority",
  "oidcReceipt",
  "p0aPolicy",
  "providerPolicy",
  "reviewedWorkflowRun",
  "store",
  "storePolicy",
  "toolchainPolicy",
];

const assertFoundationBootstrapPreviewOnlyArguments = (arguments_) => {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length !== 7 ||
    typeof arguments_[0] !== "string" ||
    arguments_[0].length === 0 ||
    arguments_[1] !== "deploy" ||
    arguments_[2] !== "--prebuilt" ||
    arguments_[3] !== "--skip-domain" ||
    arguments_[4] !== "--yes" ||
    arguments_[5] !== "--cwd" ||
    typeof arguments_[6] !== "string" ||
    arguments_[6].length === 0 ||
    arguments_.includes("--prod")
  ) {
    throw new Error("Foundation bootstrap Vercel command is not preview-only");
  }
  return arguments_;
};

const deriveFoundationBootstrapPreviewAlias = ({
  namespace,
  aliasSuffix,
  forbiddenAliases,
}) => {
  const alias = `${namespace}.containment.${aliasSuffix}`.toLowerCase();
  if (!DOMAIN.test(alias) || alias.length > 253) {
    throw new Error("Foundation bootstrap preview alias is invalid");
  }
  for (const domain of forbiddenAliases) {
    const forbidden = domain.toLowerCase();
    if (
      alias === forbidden ||
      alias.endsWith(`.${forbidden}`) ||
      forbidden.endsWith(`.${alias}`)
    ) {
      throw new Error(
        "Foundation bootstrap preview authority overlaps production domain",
      );
    }
  }
  return alias;
};

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], `${label} reference`);
  if (
    !SHA256.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} immutable reference is invalid`);
  }
  return reference;
};

const timestamp = (value, label) => {
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

const clockMilliseconds = (clock) => {
  const value = Number(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value)) {
    throw new Error("Foundation bootstrap recovery clock is invalid");
  }
  return value;
};

const assertStore = (store, namespace) => {
  if (
    store?.namespace !== namespace ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error("Foundation bootstrap recovery store is invalid");
  }
};

const parseCanonical = (bytes, label) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAXIMUM_OBJECT_BYTES
  ) {
    throw new Error(`${label} is empty or oversized`);
  }
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
};

const readEvidence = async ({
  store,
  namespace,
  reference,
  label,
  mediaType = null,
  canonical = false,
}) => {
  assertReference(reference, namespace, label);
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (mediaType !== null && stored.mediaType !== mediaType) {
    throw new Error(`${label} media type differs`);
  }
  return {
    ...stored,
    value: canonical ? parseCanonical(stored.bytes, label) : null,
  };
};

const putCanonical = async ({ store, namespace, value, mediaType, label }) => {
  const bytes = canonicalJsonBytes(value);
  const reference = referenceFor(namespace, bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  const readback = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string" ||
    !Buffer.isBuffer(readback?.bytes) ||
    !readback.bytes.equals(bytes) ||
    readback.mediaType !== mediaType ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable put/readback differs`);
  }
  return Object.freeze({ reference: Object.freeze(reference), receipt });
};

const bindingReference = (namespace, p0aPolicy) => ({
  uri:
    `release-state://${namespace}/evidence/` +
    p0aPolicy.bootstrapRecovery.deploymentBindingSha256,
  sha256: p0aPolicy.bootstrapRecovery.deploymentBindingSha256,
});

const assertRawDistManifest = (manifest) => {
  assertExactKeys(
    manifest,
    ["files", "schemaVersion", "treeSha256"],
    "Foundation bootstrap raw dist manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    !SHA256.test(manifest.treeSha256 ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifestTreeHash(manifest.files) !== manifest.treeSha256
  ) {
    throw new Error("Foundation bootstrap raw dist manifest differs");
  }
  return manifest;
};

const releaseStateReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const expectedRoutes = ({ manifest, requiredRoutes }) => {
  const available = manifest.publicResponseHashes ?? {};
  const result = {};
  for (const route of requiredRoutes) {
    const sha256 = available[route];
    if (!SHA256.test(sha256 ?? "")) {
      throw new Error(`Foundation bootstrap route is absent: ${route}`);
    }
    result[route] = sha256;
  }
  return result;
};

export const assertFoundationBootstrapMaterializationReceipt = (
  receipt,
  expected,
) => {
  assertExactKeys(
    receipt,
    [
      "archiveSha256",
      "bindingId",
      "bindingReference",
      "bootstrapInputSha256",
      "commitTreeSha",
      "fileCount",
      "kind",
      "manifestSha256",
      "packageIndexSha256",
      "rawDistManifestSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "Foundation bootstrap materialization receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "foundation-bootstrap-materialization-receipt/v1" ||
    receipt.sourceSha !== expected.sourceSha ||
    receipt.commitTreeSha !== expected.commitTreeSha ||
    receipt.bindingId !== expected.bindingId ||
    receipt.archiveSha256 !== expected.archiveSha256 ||
    receipt.manifestSha256 !== expected.manifestSha256 ||
    receipt.packageIndexSha256 !== expected.packageIndexSha256 ||
    receipt.rawDistManifestSha256 !== expected.rawDistManifestSha256 ||
    receipt.bootstrapInputSha256 !== expected.bootstrapInputSha256 ||
    !Number.isSafeInteger(receipt.fileCount) ||
    receipt.fileCount !== expected.fileCount
  ) {
    throw new Error("Foundation bootstrap materialization identity differs");
  }
  assertReference(
    receipt.bindingReference,
    expected.namespace,
    "Foundation bootstrap materialized binding",
  );
  for (const key of [
    "archiveSha256",
    "bootstrapInputSha256",
    "manifestSha256",
    "packageIndexSha256",
    "rawDistManifestSha256",
  ]) {
    if (!SHA256.test(receipt[key] ?? "")) {
      throw new Error(`Foundation bootstrap materialization ${key} is invalid`);
    }
  }
  return receipt;
};

export const materializeFoundationBootstrapArtifact = async ({
  store,
  namespace,
  p0aPolicy,
  providerPolicy,
  bootstrapSourceResolution,
  requiredRoutes,
  workRoot,
}) => {
  assertLiveBootstrapFoundationSource(bootstrapSourceResolution);
  const reference = bindingReference(namespace, p0aPolicy);
  const bindingStored = await readEvidence({
    store,
    namespace,
    reference,
    mediaType: DEPLOYMENT_BINDING_MEDIA_TYPE,
    label: "Foundation bootstrap deployment binding",
    canonical: true,
  });
  const binding = assertDeploymentBinding(bindingStored.value, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Foundation bootstrap deployment binding",
  });
  if (
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    binding.sourceSha !== bootstrapSourceResolution.gitCommitSha
  ) {
    throw new Error("Foundation bootstrap binding source differs");
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
  const indexStored = await readEvidence({
    store,
    namespace,
    reference: binding.packageIndex,
    mediaType: RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
    label: "Foundation bootstrap package index",
    canonical: true,
  });
  const index = assertReleasePackageIndex(indexStored.value, {
    expectedBuildPurpose: "production",
  });
  if (
    index.packageKind !== "legacy-bootstrap-single" ||
    index.sourceSha !== bootstrapSourceResolution.gitCommitSha ||
    index.artifact.releaseRole !== "containment" ||
    index.artifact.archive.sha256 !== binding.artifactArchive.sha256 ||
    index.artifact.manifest.sha256 !== binding.artifactManifest.sha256
  ) {
    throw new Error("Foundation bootstrap package index differs");
  }
  const [
    manifestStored,
    archiveStored,
    rawDistStored,
    bootstrapInputStored,
    releasePolicyStored,
    providerPolicyStored,
  ] = await Promise.all([
    readEvidence({
      store,
      namespace,
      reference: binding.artifactManifest,
      label: "Foundation bootstrap artifact manifest",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: binding.artifactArchive,
      label: "Foundation bootstrap artifact archive",
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
    }),
    readEvidence({
      store,
      namespace,
      reference: releaseStateReference(namespace, index.rawDistManifest.sha256),
      label: "Foundation bootstrap raw dist manifest",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: releaseStateReference(namespace, index.bootstrapInput.sha256),
      label: "Foundation bootstrap input",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: binding.releasePolicy,
      label: "Foundation bootstrap release policy",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: binding.providerPolicy,
      label: "Foundation bootstrap provider policy",
      canonical: true,
    }),
  ]);
  const manifest = assertArtifactManifest(
    manifestStored.value,
    releasePolicyStored.value,
  );
  const rawDistManifest = assertRawDistManifest(rawDistStored.value);
  assertBootstrapInput(bootstrapInputStored.value);
  if (
    manifest.sourceSha !== bootstrapSourceResolution.gitCommitSha ||
    manifest.releaseRole !== "containment" ||
    binding.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(providerPolicyStored.value, providerPolicy) ||
    sha256Bytes(manifestStored.bytes) !== binding.artifactManifest.sha256 ||
    sha256Bytes(archiveStored.bytes) !== binding.artifactArchive.sha256 ||
    sha256Bytes(rawDistStored.bytes) !== index.rawDistManifest.sha256 ||
    sha256Bytes(bootstrapInputStored.bytes) !== index.bootstrapInput.sha256
  ) {
    throw new Error("Foundation bootstrap immutable objects differ");
  }
  const archivePath = path.join(workRoot, "bootstrap-artifact.zip");
  const outputRoot = path.join(workRoot, "verified-output");
  await mkdir(outputRoot, { recursive: true });
  await writeFile(archivePath, archiveStored.bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await verifyDeterministicZip({
    archivePath,
    expectedFiles: manifest.outputFiles,
  });
  await extractPrebuiltArchive({
    archivePath,
    destination: outputRoot,
    expectedFiles: manifest.outputFiles,
  });
  await Promise.all([
    assertManifestMatchesOutput(outputRoot, manifest),
    assertBootstrapStaticOutput({ outputRoot, rawDistManifest }),
  ]);
  const receipt = assertFoundationBootstrapMaterializationReceipt(
    {
      schemaVersion: 1,
      kind: "foundation-bootstrap-materialization-receipt/v1",
      sourceSha: bootstrapSourceResolution.gitCommitSha,
      commitTreeSha: bootstrapSourceResolution.treeSha,
      bindingId: binding.bindingId,
      bindingReference: { ...reference },
      packageIndexSha256: sha256Bytes(indexStored.bytes),
      manifestSha256: sha256Bytes(manifestStored.bytes),
      archiveSha256: sha256Bytes(archiveStored.bytes),
      rawDistManifestSha256: sha256Bytes(rawDistStored.bytes),
      bootstrapInputSha256: sha256Bytes(bootstrapInputStored.bytes),
      fileCount: manifest.outputFiles.length,
    },
    {
      namespace,
      sourceSha: bootstrapSourceResolution.gitCommitSha,
      commitTreeSha: bootstrapSourceResolution.treeSha,
      bindingId: binding.bindingId,
      archiveSha256: binding.artifactArchive.sha256,
      manifestSha256: binding.artifactManifest.sha256,
      packageIndexSha256: binding.packageIndex.sha256,
      rawDistManifestSha256: index.rawDistManifest.sha256,
      bootstrapInputSha256: index.bootstrapInput.sha256,
      fileCount: manifest.outputFiles.length,
    },
  );
  return Object.freeze({
    binding,
    index,
    manifest,
    archiveBytes: Buffer.from(archiveStored.bytes),
    rawDistManifest,
    rawDistRoot: path.join(outputRoot, "static"),
    expectedRoutes: expectedRoutes({ manifest, requiredRoutes }),
    receipt,
  });
};

const defaultCommandRunner = ({ executable, arguments_, cwd, environment }) =>
  spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });

const singlePreviewUrl = (stdout) => {
  const text = Buffer.isBuffer(stdout)
    ? stdout.toString("utf8")
    : String(stdout);
  const urls = [...text.matchAll(/https:\/\/[A-Za-z0-9.-]+/gu)].map(
    ([value]) => value,
  );
  if (new Set(urls).size !== 1) {
    throw new Error("Foundation bootstrap deploy output lacks one preview URL");
  }
  const url = new URL(urls[0]);
  if (url.protocol !== "https:" || !DOMAIN.test(url.hostname)) {
    throw new Error("Foundation bootstrap preview URL is invalid");
  }
  return `${url.origin}/`;
};

const providerRequest = async ({
  fetchImpl,
  token,
  url,
  method = "GET",
  body = null,
  allowedStatuses,
  label,
}) => {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  let requestBody;
  if (body !== null) {
    requestBody = canonicalJsonBytes(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetchImpl(url, {
    method,
    headers,
    body: requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAXIMUM_PROVIDER_BYTES)
  ) {
    throw new Error(`${label} response is oversized`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length > MAXIMUM_PROVIDER_BYTES ||
    !allowedStatuses.includes(response.status)
  ) {
    throw new Error(`${label} response status or size differs`);
  }
  const date = response.headers.get("date");
  const etag = response.headers.get("etag");
  const value =
    bytes.length === 0
      ? null
      : parseJsonStrict(bytes.toString("utf8"), `${label} response`);
  return Object.freeze({
    url,
    method,
    status: response.status,
    date,
    etag,
    bodySha256: sha256Bytes(bytes),
    value,
  });
};

const probeRoutes = async ({
  fetchImpl,
  previewUrl,
  expectedRoutes: routes,
}) => {
  const receipts = [];
  for (const [route, expectedSha256] of Object.entries(routes)) {
    const url = new URL(route, previewUrl).href;
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      response.status !== 200 ||
      bytes.length > MAXIMUM_OBJECT_BYTES ||
      sha256Bytes(bytes) !== expectedSha256
    ) {
      throw new Error(`Foundation bootstrap immutable route differs: ${route}`);
    }
    receipts.push({
      path: route,
      status: response.status,
      bodySha256: sha256Bytes(bytes),
    });
  }
  return receipts;
};

export const assertFoundationBootstrapDeploymentReceipt = (
  receipt,
  { stage, artifact, providerPolicy },
) => {
  assertExactKeys(
    receipt,
    [
      "archiveSha256",
      "deploymentId",
      "kind",
      "manifestSha256",
      "previewUrl",
      "provider",
      "routes",
      "schemaVersion",
      "stage",
      "target",
    ],
    "Foundation bootstrap deployment receipt",
  );
  let preview;
  try {
    preview = new URL(receipt.previewUrl);
  } catch {
    throw new Error("Foundation bootstrap preview receipt URL is invalid");
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "foundation-bootstrap-preview-deployment-receipt/v1" ||
    receipt.stage !== stage ||
    receipt.target !== "preview" ||
    !SAFE_ID.test(receipt.deploymentId ?? "") ||
    preview.protocol !== "https:" ||
    providerPolicy.ownedProductionDomains.some(
      (domain) =>
        preview.hostname === domain || preview.hostname.endsWith(`.${domain}`),
    ) ||
    receipt.archiveSha256 !== artifact.receipt.archiveSha256 ||
    receipt.manifestSha256 !== artifact.receipt.manifestSha256 ||
    receipt.provider.projectId !== providerPolicy.expectedProjectId ||
    receipt.provider.teamId !== providerPolicy.expectedTeamId ||
    receipt.provider.target !== null ||
    receipt.provider.readyState !== "READY"
  ) {
    throw new Error("Foundation bootstrap preview deployment differs");
  }
  assertExactKeys(
    receipt.provider,
    [
      "date",
      "etag",
      "projectId",
      "readyState",
      "requestUrl",
      "responseSha256",
      "status",
      "target",
      "teamId",
    ],
    "Foundation bootstrap deployment provider receipt",
  );
  let providerRequestUrl;
  try {
    providerRequestUrl = new URL(receipt.provider.requestUrl);
  } catch {
    throw new Error("Foundation bootstrap provider request URL is invalid");
  }
  if (
    providerRequestUrl.protocol !== "https:" ||
    providerRequestUrl.hostname !== "api.vercel.com" ||
    receipt.provider.status !== 200 ||
    !SHA256.test(receipt.provider.responseSha256 ?? "") ||
    (receipt.provider.date !== null &&
      typeof receipt.provider.date !== "string") ||
    (receipt.provider.etag !== null &&
      typeof receipt.provider.etag !== "string")
  ) {
    throw new Error(
      "Foundation bootstrap provider deployment evidence differs",
    );
  }
  const expectedRoutes = Object.entries(artifact.expectedRoutes);
  if (
    !Array.isArray(receipt.routes) ||
    receipt.routes.length !== expectedRoutes.length
  ) {
    throw new Error("Foundation bootstrap route receipt set differs");
  }
  for (let index = 0; index < expectedRoutes.length; index += 1) {
    const [route, sha256] = expectedRoutes[index];
    const observed = receipt.routes[index];
    assertExactKeys(observed, ["bodySha256", "path", "status"]);
    if (
      observed.path !== route ||
      observed.status !== 200 ||
      observed.bodySha256 !== sha256
    ) {
      throw new Error("Foundation bootstrap route hash differs");
    }
  }
  return receipt;
};

const deploymentProviderProjection = (resolution) => ({
  requestUrl: resolution.request.url,
  status: resolution.request.status,
  date: resolution.request.date,
  etag: resolution.request.etag,
  responseSha256: resolution.request.responseSha256,
  projectId: resolution.deployment.projectId,
  teamId: resolution.deployment.teamId,
  target: resolution.deployment.target,
  readyState: resolution.deployment.readyState,
});

const materializePreviewArchive = async ({
  archivePath,
  outputRoot,
  artifact,
}) => {
  await extractPrebuiltArchive({
    archivePath,
    destination: outputRoot,
    expectedFiles: artifact.manifest.outputFiles,
  });
  await assertManifestMatchesOutput(outputRoot, artifact.manifest);
};

const deployPreview = async ({
  stage,
  artifact,
  workRoot,
  environment,
  providerPolicy,
  toolchainPolicy,
  root,
  token,
  fetchImpl,
  commandRunner,
  resolveDeployment,
  trackDeployment,
  materializeArchive,
}) => {
  const deployRoot = await mkdtemp(path.join(workRoot, `deploy-${stage}-`));
  const outputRoot = path.join(deployRoot, ".vercel", "output");
  const archivePath = path.join(deployRoot, "artifact.zip");
  await mkdir(outputRoot, { recursive: true });
  await writeFile(archivePath, artifact.archiveBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await materializeArchive({ archivePath, outputRoot, artifact });
  const cli = await resolvePinnedVercelCli({ root, toolchainPolicy });
  const arguments_ = assertFoundationBootstrapPreviewOnlyArguments([
    cli.cliPath,
    "deploy",
    "--prebuilt",
    "--skip-domain",
    "--yes",
    "--cwd",
    deployRoot,
  ]);
  const command = await commandRunner({
    executable: process.execPath,
    arguments_,
    cwd: deployRoot,
    environment: buildClosedVercelCommandEnvironment(environment),
  });
  if (command?.error !== undefined) throw command.error;
  if (command?.status !== 0) {
    throw new Error(`Foundation bootstrap preview deploy failed: ${stage}`);
  }
  const previewUrl = singlePreviewUrl(command.stdout);
  trackDeployment({ stage, previewUrl, deploymentId: null });
  const resolution = await resolveDeployment({
    deploymentUrl: previewUrl,
    expectedTeamId: providerPolicy.expectedTeamId,
    token,
    fetchImpl,
  });
  trackDeployment({
    stage,
    previewUrl,
    deploymentId: resolution.deployment.id,
  });
  const routes = await probeRoutes({
    fetchImpl,
    previewUrl,
    expectedRoutes: artifact.expectedRoutes,
  });
  return assertFoundationBootstrapDeploymentReceipt(
    {
      schemaVersion: 1,
      kind: "foundation-bootstrap-preview-deployment-receipt/v1",
      stage,
      target: "preview",
      deploymentId: resolution.deployment.id,
      previewUrl,
      archiveSha256: artifact.receipt.archiveSha256,
      manifestSha256: artifact.receipt.manifestSha256,
      provider: deploymentProviderProjection(resolution),
      routes,
    },
    { stage, artifact, providerPolicy },
  );
};

const aliasUrls = ({ alias, deploymentId, providerPolicy }) => ({
  command: (() => {
    const url = new URL(
      `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`,
      "https://api.vercel.com",
    );
    url.searchParams.set("teamId", providerPolicy.expectedTeamId);
    return url.href;
  })(),
  observe: (() => {
    const url = new URL(
      `/v4/aliases/${encodeURIComponent(alias)}`,
      "https://api.vercel.com",
    );
    url.searchParams.set("teamId", providerPolicy.expectedTeamId);
    return url.href;
  })(),
});

const assignAlias = async ({
  stage,
  deployment,
  alias,
  providerPolicy,
  token,
  fetchImpl,
}) => {
  const urls = aliasUrls({
    alias,
    deploymentId: deployment.deploymentId,
    providerPolicy,
  });
  const command = await providerRequest({
    fetchImpl,
    token,
    url: urls.command,
    method: "POST",
    body: { alias },
    allowedStatuses: [200],
    label: "Foundation bootstrap alias assignment",
  });
  const observation = await providerRequest({
    fetchImpl,
    token,
    url: urls.observe,
    allowedStatuses: [200],
    label: "Foundation bootstrap alias observation",
  });
  const observedDeploymentId =
    observation.value?.deploymentId ?? observation.value?.deployment?.id;
  const observedProjectId =
    observation.value?.projectId ?? observation.value?.project?.id;
  const receipt = {
    schemaVersion: 1,
    kind: "foundation-bootstrap-preview-assignment-receipt/v1",
    stage,
    alias,
    deploymentId: deployment.deploymentId,
    command: {
      requestUrl: command.url,
      status: command.status,
      responseSha256: command.bodySha256,
    },
    observation: {
      requestUrl: observation.url,
      status: observation.status,
      responseSha256: observation.bodySha256,
      observedDeploymentId,
      observedProjectId,
    },
  };
  return assertFoundationBootstrapAssignmentReceipt(receipt, {
    stage,
    alias,
    deployment,
    providerPolicy,
  });
};

export const assertFoundationBootstrapAssignmentReceipt = (
  receipt,
  { stage, alias, deployment, providerPolicy },
) => {
  assertExactKeys(
    receipt,
    [
      "alias",
      "command",
      "deploymentId",
      "kind",
      "observation",
      "schemaVersion",
      "stage",
    ],
    "Foundation bootstrap assignment receipt",
  );
  assertExactKeys(
    receipt.command,
    ["requestUrl", "responseSha256", "status"],
    "Foundation bootstrap assignment command",
  );
  assertExactKeys(
    receipt.observation,
    [
      "observedDeploymentId",
      "observedProjectId",
      "requestUrl",
      "responseSha256",
      "status",
    ],
    "Foundation bootstrap assignment observation",
  );
  let commandUrl;
  let observationUrl;
  try {
    commandUrl = new URL(receipt.command.requestUrl);
    observationUrl = new URL(receipt.observation.requestUrl);
  } catch {
    throw new Error("Foundation bootstrap assignment request URL is invalid");
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "foundation-bootstrap-preview-assignment-receipt/v1" ||
    !["forward", "recovery"].includes(stage) ||
    receipt.stage !== stage ||
    !DOMAIN.test(alias) ||
    receipt.alias !== alias ||
    receipt.deploymentId !== deployment.deploymentId ||
    receipt.deploymentId !== receipt.observation.observedDeploymentId ||
    receipt.observation.observedProjectId !==
      providerPolicy.expectedProjectId ||
    commandUrl.protocol !== "https:" ||
    commandUrl.hostname !== "api.vercel.com" ||
    observationUrl.protocol !== "https:" ||
    observationUrl.hostname !== "api.vercel.com" ||
    receipt.command.status !== 200 ||
    receipt.observation.status !== 200 ||
    !SHA256.test(receipt.command.responseSha256 ?? "") ||
    !SHA256.test(receipt.observation.responseSha256 ?? "")
  ) {
    throw new Error("Foundation bootstrap alias assignment differs");
  }
  return receipt;
};

const cleanupProviderTarget = async ({
  deleteRequest,
  verifyRequest,
  label,
}) => {
  const failures = [];
  let deletion = null;
  let verification = null;
  try {
    deletion = await deleteRequest();
  } catch (error) {
    failures.push(error);
  }
  try {
    verification = await verifyRequest();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} cleanup failed`);
  }
  return { deletion, verification };
};

export const cleanupFoundationBootstrapPreview = async ({
  alias,
  deployments,
  providerPolicy,
  token,
  fetchImpl,
  clock,
}) => {
  if (!Array.isArray(deployments) || deployments.length < 1) {
    throw new Error("Foundation bootstrap cleanup deployment set is empty");
  }
  const aliasUrl = aliasUrls({
    alias,
    deploymentId:
      deployments[0].deploymentId ??
      new URL(deployments[0].previewUrl).hostname,
    providerPolicy,
  }).observe;
  const aliasCleanup = cleanupProviderTarget({
    deleteRequest: () =>
      providerRequest({
        fetchImpl,
        token,
        url: aliasUrl,
        method: "DELETE",
        allowedStatuses: [200, 204, 404],
        label: "Foundation bootstrap alias cleanup",
      }),
    verifyRequest: () =>
      providerRequest({
        fetchImpl,
        token,
        url: aliasUrl,
        allowedStatuses: [404],
        label: "Foundation bootstrap alias cleanup verification",
      }),
    label: "Foundation bootstrap alias",
  });
  const deploymentCleanups = deployments.map(async (deployment) => {
    const deploymentId =
      deployment.deploymentId ?? new URL(deployment.previewUrl).hostname;
    const url = new URL(
      `/v13/deployments/${encodeURIComponent(deploymentId)}`,
      "https://api.vercel.com",
    );
    url.searchParams.set("teamId", providerPolicy.expectedTeamId);
    const target = await cleanupProviderTarget({
      deleteRequest: () =>
        providerRequest({
          fetchImpl,
          token,
          url: url.href,
          method: "DELETE",
          allowedStatuses: [200, 204, 404],
          label: "Foundation bootstrap deployment cleanup",
        }),
      verifyRequest: () =>
        providerRequest({
          fetchImpl,
          token,
          url: url.href,
          allowedStatuses: [404],
          label: "Foundation bootstrap deployment cleanup verification",
        }),
      label: `Foundation bootstrap deployment ${deploymentId}`,
    });
    return {
      deploymentId,
      deleteStatus: target.deletion.status,
      deleteResponseSha256: target.deletion.bodySha256,
      verifyStatus: target.verification.status,
      verifyResponseSha256: target.verification.bodySha256,
    };
  });
  const settled = await Promise.allSettled([
    aliasCleanup,
    ...deploymentCleanups,
  ]);
  const failures = settled
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Foundation bootstrap preview cleanup did not close every resource",
    );
  }
  const aliasResult = settled[0].value;
  const deleted = settled.slice(1).map(({ value }) => value);
  return {
    schemaVersion: 1,
    kind: "foundation-bootstrap-preview-cleanup-receipt/v1",
    alias,
    aliasDeleteStatus: aliasResult.deletion.status,
    aliasDeleteResponseSha256: aliasResult.deletion.bodySha256,
    aliasVerifyStatus: aliasResult.verification.status,
    aliasVerifyResponseSha256: aliasResult.verification.bodySha256,
    deployments: deleted,
    completedAt: new Date(clockMilliseconds(clock)).toISOString(),
  };
};

export const assertFoundationBootstrapRecoveryOperations = (
  operations,
  { artifact, providerPolicy, alias, maximumRecoverySeconds },
) => {
  assertExactKeys(
    operations,
    [
      "assignments",
      "cleanup",
      "completedAt",
      "deployments",
      "providerObservation",
      "startedAt",
    ],
    "Foundation bootstrap recovery operations",
  );
  const startedAt = timestamp(
    operations.startedAt,
    "Foundation bootstrap recovery start",
  );
  const completedAt = timestamp(
    operations.completedAt,
    "Foundation bootstrap recovery completion",
  );
  if (
    completedAt <= startedAt ||
    Math.ceil((completedAt - startedAt) / 1_000) > maximumRecoverySeconds ||
    !Array.isArray(operations.deployments) ||
    operations.deployments.length !== 2 ||
    !Array.isArray(operations.assignments) ||
    operations.assignments.length !== 2
  ) {
    throw new Error("Foundation bootstrap recovery timing differs");
  }
  const [forward, recovery] = operations.deployments;
  assertFoundationBootstrapDeploymentReceipt(forward, {
    stage: "forward",
    artifact,
    providerPolicy,
  });
  assertFoundationBootstrapDeploymentReceipt(recovery, {
    stage: "recovery",
    artifact,
    providerPolicy,
  });
  assertFoundationBootstrapAssignmentReceipt(operations.assignments[0], {
    stage: "forward",
    alias,
    deployment: forward,
    providerPolicy,
  });
  assertFoundationBootstrapAssignmentReceipt(operations.assignments[1], {
    stage: "recovery",
    alias,
    deployment: recovery,
    providerPolicy,
  });
  if (
    forward.deploymentId === recovery.deploymentId ||
    operations.assignments[0].stage !== "forward" ||
    operations.assignments[1].stage !== "recovery" ||
    operations.assignments.some((receipt) => receipt.alias !== alias) ||
    operations.assignments[0].deploymentId !== forward.deploymentId ||
    operations.assignments[1].deploymentId !== recovery.deploymentId
  ) {
    throw new Error("Foundation bootstrap forward/recovery transition differs");
  }
  const provider = operations.providerObservation;
  assertExactKeys(provider, [
    "forwardDeploymentId",
    "kind",
    "projectId",
    "recoveryDeploymentId",
    "schemaVersion",
    "teamId",
  ]);
  if (
    provider.schemaVersion !== 1 ||
    provider.kind !== "foundation-bootstrap-provider-observation/v1" ||
    provider.projectId !== providerPolicy.expectedProjectId ||
    provider.teamId !== providerPolicy.expectedTeamId ||
    provider.forwardDeploymentId !== forward.deploymentId ||
    provider.recoveryDeploymentId !== recovery.deploymentId
  ) {
    throw new Error("Foundation bootstrap provider observation differs");
  }
  const cleanup = operations.cleanup;
  assertExactKeys(cleanup, [
    "alias",
    "aliasDeleteResponseSha256",
    "aliasDeleteStatus",
    "aliasVerifyResponseSha256",
    "aliasVerifyStatus",
    "completedAt",
    "deployments",
    "kind",
    "schemaVersion",
  ]);
  if (
    cleanup.kind !== "foundation-bootstrap-preview-cleanup-receipt/v1" ||
    cleanup.alias !== alias ||
    ![200, 204, 404].includes(cleanup.aliasDeleteStatus) ||
    cleanup.aliasVerifyStatus !== 404 ||
    !Array.isArray(cleanup.deployments) ||
    cleanup.deployments.length !== 2 ||
    cleanup.deployments
      .map(({ deploymentId }) => deploymentId)
      .sort()
      .join("\n") !==
      [forward.deploymentId, recovery.deploymentId].sort().join("\n") ||
    cleanup.deployments.some(
      (receipt) =>
        ![200, 204, 404].includes(receipt.deleteStatus) ||
        receipt.verifyStatus !== 404,
    ) ||
    operations.completedAt !== cleanup.completedAt
  ) {
    throw new Error("Foundation bootstrap cleanup did not close preview state");
  }
  for (const receipt of cleanup.deployments) {
    assertExactKeys(
      receipt,
      [
        "deleteResponseSha256",
        "deleteStatus",
        "deploymentId",
        "verifyResponseSha256",
        "verifyStatus",
      ],
      "Foundation bootstrap deployment cleanup receipt",
    );
    if (!SAFE_ID.test(receipt.deploymentId ?? "")) {
      throw new Error("Foundation bootstrap cleanup deployment ID is invalid");
    }
  }
  for (const value of [
    cleanup.aliasDeleteResponseSha256,
    cleanup.aliasVerifyResponseSha256,
    ...cleanup.deployments.flatMap((receipt) => [
      receipt.deleteResponseSha256,
      receipt.verifyResponseSha256,
    ]),
  ]) {
    if (!SHA256.test(value ?? "")) {
      throw new Error("Foundation bootstrap cleanup response hash is invalid");
    }
  }
  return operations;
};

export const executeFoundationBootstrapPreviewRecovery = async (
  {
    artifact,
    namespace,
    executorSourceSha,
    runId,
    runAttempt,
    p0aPolicy,
    providerPolicy,
    toolchainPolicy,
    environment,
    root,
  },
  {
    fetchImpl = globalThis.fetch,
    commandRunner = defaultCommandRunner,
    resolveDeployment = resolveAuthoritativeVercelDeployment,
    deploy = deployPreview,
    assign = assignAlias,
    cleanupDeployment = cleanupFoundationBootstrapPreview,
    materializeArchive = materializePreviewArchive,
    clock = Date.now,
  } = {},
) => {
  const token = environment?.[p0aPolicy.providerCredentialEnvironmentName];
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    environment?.VERCEL_PROJECT_ID !== providerPolicy.expectedProjectId ||
    environment?.VERCEL_ORG_ID !== providerPolicy.expectedTeamId
  ) {
    throw new Error("Foundation bootstrap provider authority is absent");
  }
  const alias = deriveFoundationBootstrapPreviewAlias({
    namespace: `p0a-${sha256Json({ namespace, executorSourceSha, runId, runAttempt }).slice(0, 12)}`,
    aliasSuffix: p0aPolicy.bootstrapRecovery.previewAliasSuffix,
    forbiddenAliases: [
      ...(providerPolicy.ownedProductionDomains ?? []),
      ...(providerPolicy.productionDomains ?? []),
      ...(providerPolicy.productionAliases ?? []),
    ],
  });
  const workRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-p0a-recovery-"),
  );
  const startedAt = new Date(clockMilliseconds(clock)).toISOString();
  const deployments = [];
  const trackedDeployments = new Map();
  const trackDeployment = ({ stage, previewUrl, deploymentId }) => {
    if (
      !["forward", "recovery"].includes(stage) ||
      typeof previewUrl !== "string" ||
      !DOMAIN.test(new URL(previewUrl).hostname) ||
      (deploymentId !== null && !SAFE_ID.test(deploymentId ?? ""))
    ) {
      throw new Error("Foundation bootstrap cleanup handle is invalid");
    }
    const existing = trackedDeployments.get(previewUrl);
    if (existing !== undefined && existing.stage !== stage) {
      throw new Error("Foundation bootstrap cleanup handle is ambiguous");
    }
    if (
      existing !== undefined &&
      existing.deploymentId !== null &&
      deploymentId !== null &&
      existing.deploymentId !== deploymentId
    ) {
      throw new Error("Foundation bootstrap cleanup deployment differs");
    }
    trackedDeployments.set(previewUrl, {
      stage,
      previewUrl,
      deploymentId: deploymentId ?? existing?.deploymentId ?? null,
    });
  };
  let assignments = [];
  let primaryError = null;
  let cleanup = null;
  let cleanupError = null;
  try {
    const forward = await deploy({
      stage: "forward",
      artifact,
      workRoot,
      environment,
      providerPolicy,
      toolchainPolicy,
      root,
      token,
      fetchImpl,
      commandRunner,
      resolveDeployment,
      trackDeployment,
      materializeArchive,
    });
    trackDeployment({
      stage: "forward",
      previewUrl: forward.previewUrl,
      deploymentId: forward.deploymentId,
    });
    deployments.push(forward);
    const forwardAssignment = await assign({
      stage: "forward",
      deployment: forward,
      alias,
      providerPolicy,
      token,
      fetchImpl,
    });
    const recovery = await deploy({
      stage: "recovery",
      artifact,
      workRoot,
      environment,
      providerPolicy,
      toolchainPolicy,
      root,
      token,
      fetchImpl,
      commandRunner,
      resolveDeployment,
      trackDeployment,
      materializeArchive,
    });
    trackDeployment({
      stage: "recovery",
      previewUrl: recovery.previewUrl,
      deploymentId: recovery.deploymentId,
    });
    deployments.push(recovery);
    const recoveryAssignment = await assign({
      stage: "recovery",
      deployment: recovery,
      alias,
      providerPolicy,
      token,
      fetchImpl,
    });
    assignments = [forwardAssignment, recoveryAssignment];
  } catch (error) {
    primaryError = error;
  } finally {
    if (trackedDeployments.size > 0) {
      try {
        cleanup = await cleanupDeployment({
          alias,
          deployments: [...trackedDeployments.values()],
          providerPolicy,
          token,
          fetchImpl,
          clock,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    await rm(workRoot, { recursive: true, force: true });
  }
  if (primaryError !== null || cleanupError !== null) {
    if (primaryError !== null && cleanupError !== null) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Foundation bootstrap recovery and cleanup both failed",
      );
    }
    throw primaryError ?? cleanupError;
  }
  if (
    deployments.length !== 2 ||
    assignments.length !== 2 ||
    cleanup === null
  ) {
    throw new Error("Foundation bootstrap recovery operations are incomplete");
  }
  const operations = {
    startedAt,
    completedAt: cleanup.completedAt,
    deployments,
    assignments,
    providerObservation: {
      schemaVersion: 1,
      kind: "foundation-bootstrap-provider-observation/v1",
      projectId: providerPolicy.expectedProjectId,
      teamId: providerPolicy.expectedTeamId,
      forwardDeploymentId: deployments[0].deploymentId,
      recoveryDeploymentId: deployments[1].deploymentId,
    },
    cleanup,
  };
  return assertFoundationBootstrapRecoveryOperations(operations, {
    artifact,
    providerPolicy,
    alias,
    maximumRecoverySeconds: p0aPolicy.bootstrapRecovery.maximumRecoverySeconds,
  });
};

const assertExecutionReceipt = (receipt, maximumRecoverySeconds) => {
  assertExactKeys(
    receipt,
    ["alias", "completedAt", "kind", "schemaVersion", "startedAt"],
    "Foundation bootstrap execution receipt",
  );
  const startedAt = timestamp(
    receipt.startedAt,
    "Foundation bootstrap execution start",
  );
  const completedAt = timestamp(
    receipt.completedAt,
    "Foundation bootstrap execution completion",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "foundation-bootstrap-recovery-execution-receipt/v1" ||
    !DOMAIN.test(receipt.alias ?? "") ||
    completedAt <= startedAt ||
    Math.ceil((completedAt - startedAt) / 1_000) > maximumRecoverySeconds
  ) {
    throw new Error("Foundation bootstrap execution receipt differs");
  }
  return receipt;
};

const operationEntries = (artifact, operations) => [
  [
    "execution",
    {
      schemaVersion: 1,
      kind: "foundation-bootstrap-recovery-execution-receipt/v1",
      alias: operations.assignments[0].alias,
      startedAt: operations.startedAt,
      completedAt: operations.completedAt,
    },
  ],
  ["materialization", artifact.receipt],
  ["forwardDeployment", operations.deployments[0]],
  ["recoveryDeployment", operations.deployments[1]],
  ["forwardAssignment", operations.assignments[0]],
  ["recoveryAssignment", operations.assignments[1]],
  ["providerObservation", operations.providerObservation],
  ["cleanup", operations.cleanup],
];

const bootstrapImmutableReferences = (binding) => ({
  artifactArchive: structuredClone(binding.artifactArchive),
  artifactArchiveAvailability: structuredClone(
    binding.artifactArchiveAvailability,
  ),
  artifactManifest: structuredClone(binding.artifactManifest),
  packageIndex: structuredClone(binding.packageIndex),
  providerEvidence: structuredClone(binding.providerEvidence),
  providerPolicy: structuredClone(binding.providerPolicy),
  releasePolicy: structuredClone(binding.releasePolicy),
});

export const deriveFoundationBootstrapStateInitializationSubject = ({
  namespace,
  binding,
  bindingReference: reference,
}) => ({
  schemaVersion: 1,
  kind: "foundation-bootstrap-state-initialization-projection/v1",
  namespace,
  expectedState: { sequence: 0, eventHash: null },
  acceptedStandard: null,
  activeProduction: null,
  pendingOperation: null,
  bootstrapRecoveryReference: structuredClone(reference),
  bootstrapRecovery: structuredClone(binding),
  immutableReferences: bootstrapImmutableReferences(binding),
});

export const assertFoundationBootstrapStateInitializationSubject = (
  subject,
) => {
  assertExactKeys(
    subject,
    [
      "acceptedStandard",
      "activeProduction",
      "bootstrapRecovery",
      "bootstrapRecoveryReference",
      "expectedState",
      "immutableReferences",
      "kind",
      "namespace",
      "pendingOperation",
      "schemaVersion",
    ],
    "Foundation bootstrap state initialization projection",
  );
  assertExactKeys(
    subject.expectedState,
    ["eventHash", "sequence"],
    "Foundation bootstrap state initialization expected state",
  );
  assertExactKeys(
    subject.immutableReferences,
    [
      "artifactArchive",
      "artifactArchiveAvailability",
      "artifactManifest",
      "packageIndex",
      "providerEvidence",
      "providerPolicy",
      "releasePolicy",
    ],
    "Foundation bootstrap immutable reference projection",
  );
  if (
    subject.schemaVersion !== 1 ||
    subject.kind !==
      "foundation-bootstrap-state-initialization-projection/v1" ||
    !NAMESPACE.test(subject.namespace ?? "") ||
    subject.expectedState.sequence !== 0 ||
    subject.expectedState.eventHash !== null ||
    subject.acceptedStandard !== null ||
    subject.activeProduction !== null ||
    subject.pendingOperation !== null
  ) {
    throw new Error(
      "Foundation bootstrap state initialization projection differs",
    );
  }
  assertReference(
    subject.bootstrapRecoveryReference,
    subject.namespace,
    "Foundation bootstrap recovery binding",
  );
  const binding = assertDeploymentBinding(subject.bootstrapRecovery, {
    namespace: subject.namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Foundation bootstrap projected recovery binding",
  });
  if (
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    sha256Json(binding) !== subject.bootstrapRecoveryReference.sha256 ||
    !sameCanonicalValue(
      subject.immutableReferences,
      bootstrapImmutableReferences(binding),
    )
  ) {
    throw new Error("Foundation bootstrap projected binding differs");
  }
  return subject;
};

export const deriveFoundationBootstrapRecoveryResult = ({ rehearsal }) => ({
  drillId: `${rehearsal.runId}:${rehearsal.runAttempt}`,
  startedAt: rehearsal.startedAt,
  completedAt: rehearsal.completedAt,
  recoveryBindingId: rehearsal.recoveryBindingId,
  recoveryDeploymentId: rehearsal.recoveryDeploymentId,
  rawDistManifestSha256: rehearsal.rawDistManifestSha256,
  artifactArchiveSha256: rehearsal.artifactArchiveSha256,
  restoredArtifactSha256: rehearsal.restoredArtifactSha256,
  recoveryTimeSeconds: rehearsal.recoveryTimeSeconds,
  dataLossObserved: rehearsal.dataLossObserved,
  outcome: rehearsal.outcome,
});

const assertResult = (result, rehearsal) => {
  assertExactKeys(
    result,
    [
      "artifactArchiveSha256",
      "completedAt",
      "dataLossObserved",
      "drillId",
      "outcome",
      "rawDistManifestSha256",
      "recoveryBindingId",
      "recoveryDeploymentId",
      "recoveryTimeSeconds",
      "restoredArtifactSha256",
      "startedAt",
    ],
    "Foundation bootstrap recovery result",
  );
  const expected = deriveFoundationBootstrapRecoveryResult({ rehearsal });
  if (!sameCanonicalValue(result, expected)) {
    throw new Error("Foundation bootstrap recovery result was not rederived");
  }
  return result;
};

const rehearsalFor = ({
  namespace,
  executorSourceSha,
  bootstrapSeedAuthority,
  bootstrapSourceResolution,
  oidcAuthority,
  oidcReceipt,
  reviewedWorkflowRun,
  artifact,
  operations,
  approvalPolicy,
}) => {
  const startedAt = timestamp(
    operations.startedAt,
    "Foundation bootstrap recovery start",
  );
  const completedAt = timestamp(
    operations.completedAt,
    "Foundation bootstrap recovery completion",
  );
  return {
    schemaVersion: 1,
    evidenceKind: "foundation-bootstrap-recovery-rehearsal/v2",
    operation: REHEARSAL_OPERATION,
    namespace,
    repository: approvalPolicy.repository,
    workflowPath: WORKFLOW_PATH,
    sourceSha: bootstrapSourceResolution.gitCommitSha,
    executorSourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
    producerOidc: { ...oidcReceipt },
    bootstrapDeploymentSeed: { ...bootstrapSeedAuthority },
    reviewedWorkflowRun: { ...reviewedWorkflowRun },
    startedAt: operations.startedAt,
    completedAt: operations.completedAt,
    recoveryBindingId: artifact.binding.bindingId,
    recoveryDeploymentId: artifact.binding.providerDeploymentId,
    rawDistManifestSha256: artifact.receipt.rawDistManifestSha256,
    artifactArchiveSha256: artifact.receipt.archiveSha256,
    restoredArtifactSha256: artifact.receipt.archiveSha256,
    recoveryTimeSeconds: Math.max(
      1,
      Math.ceil((completedAt - startedAt) / 1_000),
    ),
    dataLossObserved: false,
    outcome: "succeeded",
  };
};

const assertRehearsal = (rehearsal) => {
  assertExactKeys(
    rehearsal,
    [
      "artifactArchiveSha256",
      "bootstrapDeploymentSeed",
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
    ],
    "Foundation bootstrap rehearsal",
  );
  if (
    rehearsal.schemaVersion !== 1 ||
    rehearsal.evidenceKind !== "foundation-bootstrap-recovery-rehearsal/v2" ||
    rehearsal.operation !== REHEARSAL_OPERATION ||
    rehearsal.workflowPath !== WORKFLOW_PATH ||
    !NAMESPACE.test(rehearsal.namespace ?? "") ||
    !SOURCE_SHA.test(rehearsal.sourceSha ?? "") ||
    !SOURCE_SHA.test(rehearsal.executorSourceSha ?? "") ||
    !RUN_ID.test(rehearsal.runId ?? "") ||
    !RUN_ID.test(rehearsal.runAttempt ?? "") ||
    !SAFE_ID.test(rehearsal.recoveryBindingId ?? "") ||
    !SAFE_ID.test(rehearsal.recoveryDeploymentId ?? "") ||
    rehearsal.restoredArtifactSha256 !== rehearsal.artifactArchiveSha256 ||
    rehearsal.dataLossObserved !== false ||
    rehearsal.outcome !== "succeeded"
  ) {
    throw new Error("Foundation bootstrap rehearsal is invalid");
  }
  timestamp(rehearsal.startedAt, "Foundation bootstrap rehearsal start");
  timestamp(rehearsal.completedAt, "Foundation bootstrap rehearsal completion");
  for (const key of [
    "artifactArchiveSha256",
    "rawDistManifestSha256",
    "restoredArtifactSha256",
  ]) {
    if (!SHA256.test(rehearsal[key] ?? "")) {
      throw new Error(`Foundation bootstrap rehearsal ${key} is invalid`);
    }
  }
  assertReference(
    rehearsal.producerOidc,
    rehearsal.namespace,
    "Bootstrap OIDC",
  );
  assertReference(
    rehearsal.bootstrapDeploymentSeed,
    rehearsal.namespace,
    "Bootstrap deployment seed",
  );
  assertReference(
    rehearsal.reviewedWorkflowRun,
    rehearsal.namespace,
    "Bootstrap reviewed workflow run",
  );
  return rehearsal;
};

const policySnapshot = (options) => ({
  p0aPolicy: options.p0aPolicy,
  providerPolicy: options.providerPolicy,
  storePolicy: options.storePolicy,
  databaseContract: options.databaseContract,
  approvalPolicy: options.approvalPolicy,
  foundationBaseline: options.foundationBaseline,
  toolchainPolicy: options.toolchainPolicy,
});

const OPERATION_RECEIPT_NAMES = [
  "cleanup",
  "execution",
  "forwardAssignment",
  "forwardDeployment",
  "materialization",
  "providerObservation",
  "recoveryAssignment",
  "recoveryDeployment",
];

const assertRaw = (raw, { namespace, sourceSha = null }) => {
  assertExactKeys(
    raw,
    [
      "bootstrap",
      "collector",
      "kind",
      "namespace",
      "observedAt",
      "operationReceipts",
      "policySnapshot",
      "rehearsal",
      "schemaVersion",
      "sourceSha",
    ],
    "Foundation bootstrap raw authority",
  );
  if (
    raw.schemaVersion !== 2 ||
    raw.kind !== "foundation-bootstrap-recovery-raw/v2" ||
    raw.namespace !== namespace ||
    !SOURCE_SHA.test(raw.sourceSha ?? "") ||
    (sourceSha !== null && raw.sourceSha !== sourceSha)
  ) {
    throw new Error("Foundation bootstrap raw identity differs");
  }
  timestamp(raw.observedAt, "Foundation bootstrap raw observation");
  assertExactKeys(
    raw.collector,
    ["oidcReceipt", "runAttempt", "runId"],
    "Foundation bootstrap collector identity",
  );
  if (
    !RUN_ID.test(raw.collector.runId ?? "") ||
    !RUN_ID.test(raw.collector.runAttempt ?? "")
  ) {
    throw new Error("Foundation bootstrap collector run identity is invalid");
  }
  assertReference(
    raw.collector.oidcReceipt,
    raw.namespace,
    "Foundation bootstrap collector OIDC",
  );
  assertExactKeys(
    raw.bootstrap,
    [
      "bindingId",
      "bindingReference",
      "commitTreeSha",
      "reviewedSeedWorkflowRun",
      "seedAuthority",
      "sourceSha",
    ],
    "Foundation bootstrap identity",
  );
  if (
    !SOURCE_SHA.test(raw.bootstrap.sourceSha ?? "") ||
    !SOURCE_SHA.test(raw.bootstrap.commitTreeSha ?? "") ||
    !SAFE_ID.test(raw.bootstrap.bindingId ?? "")
  ) {
    throw new Error("Foundation bootstrap source identity is invalid");
  }
  assertReference(
    raw.bootstrap.bindingReference,
    raw.namespace,
    "Foundation bootstrap deployment binding",
  );
  assertReference(
    raw.bootstrap.seedAuthority,
    raw.namespace,
    "Foundation bootstrap deployment seed authority",
  );
  assertReference(
    raw.bootstrap.reviewedSeedWorkflowRun,
    raw.namespace,
    "Foundation bootstrap reviewed seed workflow run",
  );
  assertExactKeys(
    raw.operationReceipts,
    OPERATION_RECEIPT_NAMES,
    "Foundation bootstrap operation receipt set",
  );
  assertReference(
    raw.policySnapshot,
    raw.namespace,
    "Bootstrap policy snapshot",
  );
  assertReference(raw.rehearsal, raw.namespace, "Bootstrap rehearsal");
  for (const reference of Object.values(raw.operationReceipts)) {
    assertReference(reference, raw.namespace, "Bootstrap operation receipt");
  }
  return raw;
};

export const assertFoundationBootstrapRecoveryObservation = (observation) => {
  assertExactKeys(observation, [
    "collectorIdentity",
    "kind",
    "namespace",
    "observedAt",
    "oidcReceipt",
    "rawAuthority",
    "rehearsalAuthority",
    "result",
    "schemaVersion",
    "sourceSha",
    "stateInitializationSubject",
  ]);
  if (
    observation.schemaVersion !== 2 ||
    observation.kind !== "foundation-bootstrap-recovery-observation/v2" ||
    !NAMESPACE.test(observation.namespace ?? "") ||
    !SOURCE_SHA.test(observation.sourceSha ?? "") ||
    observation.collectorIdentity?.sourceSha !== observation.sourceSha ||
    observation.collectorIdentity?.workflowPath !== WORKFLOW_PATH ||
    observation.stateInitializationSubject?.namespace !== observation.namespace
  ) {
    throw new Error("Foundation bootstrap recovery observation is invalid");
  }
  assertExactKeys(
    observation.collectorIdentity,
    ["repository", "runAttempt", "runId", "sourceSha", "workflowPath"],
    "Foundation bootstrap collector identity",
  );
  if (
    !RUN_ID.test(observation.collectorIdentity.runId ?? "") ||
    !RUN_ID.test(observation.collectorIdentity.runAttempt ?? "")
  ) {
    throw new Error("Foundation bootstrap collector run identity is invalid");
  }
  assertExactKeys(
    observation.result,
    [
      "artifactArchiveSha256",
      "completedAt",
      "dataLossObserved",
      "drillId",
      "outcome",
      "rawDistManifestSha256",
      "recoveryBindingId",
      "recoveryDeploymentId",
      "recoveryTimeSeconds",
      "restoredArtifactSha256",
      "startedAt",
    ],
    "Foundation bootstrap observation result",
  );
  timestamp(observation.observedAt, "Foundation bootstrap observation");
  assertReference(
    observation.rawAuthority,
    observation.namespace,
    "Bootstrap raw",
  );
  assertReference(
    observation.rehearsalAuthority,
    observation.namespace,
    "Bootstrap rehearsal",
  );
  assertReference(
    observation.oidcReceipt,
    observation.namespace,
    "Bootstrap observation OIDC",
  );
  assertFoundationBootstrapStateInitializationSubject(
    observation.stateInitializationSubject,
  );
  return observation;
};

const operationReceiptsFrom = async ({ store, namespace, raw }) =>
  Object.fromEntries(
    await Promise.all(
      OPERATION_RECEIPT_NAMES.map(async (name) => {
        const stored = await readEvidence({
          store,
          namespace,
          reference: raw.operationReceipts[name],
          label: `Foundation bootstrap ${name} receipt`,
          mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_OPERATION_MEDIA_TYPE,
          canonical: true,
        });
        return [name, stored.value];
      }),
    ),
  );

export const readStoredFoundationBootstrapRecoveryAuthority = async (
  {
    store,
    namespace,
    reference,
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    foundationBaseline,
    toolchainPolicy,
    bootstrapSourceResolution,
  },
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    readSeedAuthority = readStoredFoundationBootstrapDeploymentSeedAuthority,
    readWorkflowRun = readReviewedWorkflowRunAuthority,
    assertBootstrapSource = assertLiveBootstrapFoundationSource,
    now = Date.now,
  } = {},
) => {
  assertConfiguredFoundationP0aAuthorities({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    requireBootstrap: true,
  });
  if (
    !NAMESPACE.test(namespace ?? "") ||
    p0aPolicy?.bootstrapRecovery?.bootstrapSourceSha !==
      bootstrapSourceResolution?.gitCommitSha
  ) {
    throw new Error("Foundation bootstrap readback identity differs");
  }
  assertExactKeys(
    bootstrapSourceResolution,
    ["gitCommitSha", "treeSha"],
    "Foundation bootstrap source resolution",
  );
  assertStore(store, namespace);
  assertBootstrapSource(bootstrapSourceResolution);
  const rawStored = await readEvidence({
    store,
    namespace,
    reference,
    label: "Foundation bootstrap recovery raw authority",
    mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_RAW_MEDIA_TYPE,
    canonical: true,
  });
  const raw = assertRaw(rawStored.value, { namespace });
  const nowMilliseconds = clockMilliseconds(now);
  const observedAt = timestamp(
    raw.observedAt,
    "Foundation bootstrap recovery observation",
  );
  if (
    observedAt < nowMilliseconds - MAXIMUM_AGE_MILLISECONDS ||
    observedAt > nowMilliseconds + FUTURE_SKEW_MILLISECONDS
  ) {
    throw new Error(
      "Foundation bootstrap recovery authority is stale or future",
    );
  }
  const [bindingStored, snapshotStored, rehearsalStored, receipts] =
    await Promise.all([
      readEvidence({
        store,
        namespace,
        reference: raw.bootstrap.bindingReference,
        label: "Foundation bootstrap deployment binding",
        mediaType: DEPLOYMENT_BINDING_MEDIA_TYPE,
        canonical: true,
      }),
      readEvidence({
        store,
        namespace,
        reference: raw.policySnapshot,
        label: "Foundation bootstrap policy snapshot",
        mediaType: FOUNDATION_BOOTSTRAP_POLICY_SNAPSHOT_MEDIA_TYPE,
        canonical: true,
      }),
      readEvidence({
        store,
        namespace,
        reference: raw.rehearsal,
        label: "Foundation bootstrap recovery rehearsal",
        mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
        canonical: true,
      }),
      operationReceiptsFrom({ store, namespace, raw }),
    ]);
  const expectedSnapshot = policySnapshot({
    p0aPolicy,
    providerPolicy,
    storePolicy,
    databaseContract,
    approvalPolicy,
    foundationBaseline,
    toolchainPolicy,
  });
  if (!sameCanonicalValue(snapshotStored.value, expectedSnapshot)) {
    throw new Error(
      "Foundation bootstrap policy snapshot differs from current policy",
    );
  }
  const binding = assertDeploymentBinding(bindingStored.value, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Foundation bootstrap recovery binding",
  });
  const expectedBindingReference = bindingReference(namespace, p0aPolicy);
  if (
    !sameCanonicalValue(
      raw.bootstrap.bindingReference,
      expectedBindingReference,
    ) ||
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    binding.bindingId !== raw.bootstrap.bindingId ||
    binding.sourceSha !== raw.bootstrap.sourceSha ||
    raw.bootstrap.sourceSha !== bootstrapSourceResolution.gitCommitSha ||
    raw.bootstrap.commitTreeSha !== bootstrapSourceResolution.treeSha
  ) {
    throw new Error("Foundation bootstrap binding readback differs");
  }
  const seed = await readSeedAuthority({
    store,
    namespace,
    reference: raw.bootstrap.seedAuthority,
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  });
  if (
    !sameCanonicalValue(seed.binding, binding) ||
    !sameCanonicalValue(seed.reference, raw.bootstrap.seedAuthority)
  ) {
    throw new Error("Foundation bootstrap reviewed seed binding differs");
  }
  await Promise.all([
    validateProviderEvidenceForBinding({
      store,
      namespace,
      binding,
      label: "Foundation bootstrap recovery binding",
    }),
    assertArtifactArchiveAvailable({
      store,
      namespace,
      binding,
      label: "Foundation bootstrap recovery binding",
    }),
  ]);
  const [
    indexStored,
    manifestStored,
    releasePolicyStored,
    providerPolicyStored,
  ] = await Promise.all([
    readEvidence({
      store,
      namespace,
      reference: binding.packageIndex,
      label: "Foundation bootstrap package index",
      mediaType: RELEASE_PACKAGE_INDEX_MEDIA_TYPE,
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: binding.artifactManifest,
      label: "Foundation bootstrap artifact manifest",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: binding.releasePolicy,
      label: "Foundation bootstrap release policy",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: binding.providerPolicy,
      label: "Foundation bootstrap provider policy",
      canonical: true,
    }),
  ]);
  const index = assertReleasePackageIndex(indexStored.value, {
    expectedBuildPurpose: "production",
  });
  const manifest = assertArtifactManifest(
    manifestStored.value,
    releasePolicyStored.value,
  );
  if (
    index.packageKind !== "legacy-bootstrap-single" ||
    index.sourceSha !== binding.sourceSha ||
    index.artifact.releaseRole !== "containment" ||
    index.artifact.archive.sha256 !== binding.artifactArchive.sha256 ||
    index.artifact.manifest.sha256 !== binding.artifactManifest.sha256 ||
    manifest.sourceSha !== binding.sourceSha ||
    manifest.releaseRole !== "containment" ||
    binding.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(providerPolicyStored.value, providerPolicy)
  ) {
    throw new Error("Foundation bootstrap package readback differs");
  }
  const [rawDistStored, bootstrapInputStored] = await Promise.all([
    readEvidence({
      store,
      namespace,
      reference: releaseStateReference(namespace, index.rawDistManifest.sha256),
      label: "Foundation bootstrap raw dist manifest",
      canonical: true,
    }),
    readEvidence({
      store,
      namespace,
      reference: releaseStateReference(namespace, index.bootstrapInput.sha256),
      label: "Foundation bootstrap input",
      canonical: true,
    }),
  ]);
  assertRawDistManifest(rawDistStored.value);
  assertBootstrapInput(bootstrapInputStored.value);
  const materialization = assertFoundationBootstrapMaterializationReceipt(
    receipts.materialization,
    {
      namespace,
      sourceSha: binding.sourceSha,
      commitTreeSha: bootstrapSourceResolution.treeSha,
      bindingId: binding.bindingId,
      archiveSha256: binding.artifactArchive.sha256,
      manifestSha256: binding.artifactManifest.sha256,
      packageIndexSha256: binding.packageIndex.sha256,
      rawDistManifestSha256: index.rawDistManifest.sha256,
      bootstrapInputSha256: index.bootstrapInput.sha256,
      fileCount: manifest.outputFiles.length,
    },
  );
  const execution = assertExecutionReceipt(
    receipts.execution,
    p0aPolicy.bootstrapRecovery.maximumRecoverySeconds,
  );
  const artifact = {
    binding,
    receipt: materialization,
    expectedRoutes: expectedRoutes({
      manifest,
      requiredRoutes: p0aPolicy.bootstrapRecovery.requiredRoutes,
    }),
  };
  const operations = {
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    deployments: [receipts.forwardDeployment, receipts.recoveryDeployment],
    assignments: [receipts.forwardAssignment, receipts.recoveryAssignment],
    providerObservation: receipts.providerObservation,
    cleanup: receipts.cleanup,
  };
  assertFoundationBootstrapRecoveryOperations(operations, {
    artifact,
    providerPolicy,
    alias: execution.alias,
    maximumRecoverySeconds: p0aPolicy.bootstrapRecovery.maximumRecoverySeconds,
  });
  const rehearsal = assertRehearsal(rehearsalStored.value);
  const rederivedRehearsal = rehearsalFor({
    namespace,
    executorSourceSha: raw.sourceSha,
    bootstrapSeedAuthority: raw.bootstrap.seedAuthority,
    bootstrapSourceResolution,
    oidcAuthority: {
      runId: raw.collector.runId,
      runAttempt: raw.collector.runAttempt,
    },
    oidcReceipt: raw.collector.oidcReceipt,
    reviewedWorkflowRun: raw.bootstrap.reviewedSeedWorkflowRun,
    artifact,
    operations,
    approvalPolicy,
  });
  if (
    raw.observedAt !== rehearsal.completedAt ||
    !sameCanonicalValue(rehearsal, rederivedRehearsal)
  ) {
    throw new Error("Foundation bootstrap rehearsal was not rederived");
  }
  await Promise.all([
    readOidcAuthority({
      store,
      namespace,
      reference: raw.collector.oidcReceipt,
      approvalPolicy,
      sourceSha: raw.sourceSha,
      runId: raw.collector.runId,
      runAttempt: raw.collector.runAttempt,
    }),
    readWorkflowRun({
      namespace,
      repository: approvalPolicy.repository,
      expectedRunId: seed.authority.runId,
      expectedRunAttempt: seed.authority.runAttempt,
      expectedSourceSha: seed.authority.workflowSourceSha,
      expectedWorkflowPath: WORKFLOW_PATH,
      reference: raw.bootstrap.reviewedSeedWorkflowRun,
      store,
    }),
  ]);
  const stateInitializationSubject =
    assertFoundationBootstrapStateInitializationSubject(
      deriveFoundationBootstrapStateInitializationSubject({
        namespace,
        binding,
        bindingReference: raw.bootstrap.bindingReference,
      }),
    );
  const result = assertResult(
    deriveFoundationBootstrapRecoveryResult({ rehearsal }),
    rehearsal,
  );
  return Object.freeze({
    raw: Object.freeze(structuredClone(raw)),
    rehearsal: Object.freeze(structuredClone(rehearsal)),
    result: Object.freeze(structuredClone(result)),
    stateInitializationSubject: Object.freeze(
      structuredClone(stateInitializationSubject),
    ),
    reference: Object.freeze({ ...reference }),
    bytes: Buffer.from(rawStored.bytes),
  });
};

export const collectAndStoreFoundationBootstrapRecovery = async (
  options,
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    readSeedAuthority = readStoredFoundationBootstrapDeploymentSeedAuthority,
    readWorkflowRun = readReviewedWorkflowRunAuthority,
    materialize = materializeFoundationBootstrapArtifact,
    executeRecovery = executeFoundationBootstrapPreviewRecovery,
    readStoredAuthority = readStoredFoundationBootstrapRecoveryAuthority,
    assertBootstrapSource = assertLiveBootstrapFoundationSource,
    clock = Date.now,
    repositoryRoot = process.cwd(),
  } = {},
) => {
  assertExactKeys(
    options,
    OPTION_KEYS,
    "Foundation bootstrap recovery collector options",
  );
  const configured = assertConfiguredFoundationP0aAuthorities({
    ...options,
    requireBootstrap: true,
  });
  void configured;
  const {
    approvalPolicy,
    bootstrapSeedAuthority,
    bootstrapSourceResolution,
    environment,
    foundationBaseline,
    namespace,
    oidcAuthority,
    oidcReceipt,
    p0aPolicy,
    providerPolicy,
    reviewedWorkflowRun,
    store,
    toolchainPolicy,
  } = options;
  assertExactKeys(
    oidcAuthority,
    ["approvalPolicy", "runAttempt", "runId"],
    "Foundation bootstrap OIDC authority",
  );
  assertExactKeys(
    bootstrapSourceResolution,
    ["gitCommitSha", "treeSha"],
    "Foundation bootstrap source resolution",
  );
  if (
    !NAMESPACE.test(namespace ?? "") ||
    !SOURCE_SHA.test(environment?.GITHUB_SHA ?? "") ||
    !RUN_ID.test(oidcAuthority?.runId ?? "") ||
    !RUN_ID.test(oidcAuthority?.runAttempt ?? "") ||
    !sameCanonicalValue(oidcAuthority.approvalPolicy, approvalPolicy) ||
    p0aPolicy?.bootstrapRecovery?.bootstrapSourceSha !==
      bootstrapSourceResolution?.gitCommitSha
  ) {
    throw new Error("Foundation bootstrap recovery collector identity differs");
  }
  assertStore(store, namespace);
  assertBootstrapSource(bootstrapSourceResolution);
  const executorSourceSha = environment.GITHUB_SHA;
  const seed = await readSeedAuthority({
    store,
    namespace,
    reference: bootstrapSeedAuthority,
    p0aPolicy,
    providerPolicy,
    databaseContract: options.databaseContract,
    storePolicy: options.storePolicy,
    approvalPolicy,
  });
  if (
    seed.authority.runId === oidcAuthority.runId ||
    seed.authority.workflowSourceSha === executorSourceSha ||
    bootstrapSeedAuthority.sha256 !==
      p0aPolicy.bootstrapRecovery.deploymentSeedAuthoritySha256 ||
    seed.binding.sourceSha !== bootstrapSourceResolution.gitCommitSha
  ) {
    throw new Error(
      "Foundation bootstrap deployment seed is not a prior dual-source run",
    );
  }
  await Promise.all([
    readOidcAuthority({
      store,
      namespace,
      reference: oidcReceipt,
      approvalPolicy,
      sourceSha: executorSourceSha,
      runId: oidcAuthority.runId,
      runAttempt: oidcAuthority.runAttempt,
    }),
    readWorkflowRun({
      namespace,
      repository: approvalPolicy.repository,
      expectedRunId: seed.authority.runId,
      expectedRunAttempt: seed.authority.runAttempt,
      expectedSourceSha: seed.authority.workflowSourceSha,
      expectedWorkflowPath: WORKFLOW_PATH,
      reference: reviewedWorkflowRun,
      store,
    }),
  ]);
  const workRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-bootstrap-materialize-"),
  );
  let artifact;
  try {
    artifact = await materialize({
      store,
      namespace,
      p0aPolicy,
      providerPolicy,
      bootstrapSourceResolution,
      requiredRoutes: p0aPolicy.bootstrapRecovery.requiredRoutes,
      workRoot,
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
  const operations = await executeRecovery({
    artifact,
    namespace,
    executorSourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
    p0aPolicy,
    providerPolicy,
    toolchainPolicy,
    environment,
    root: repositoryRoot,
  });
  const alias = operations.assignments[0].alias;
  assertFoundationBootstrapRecoveryOperations(operations, {
    artifact,
    providerPolicy,
    alias,
    maximumRecoverySeconds: p0aPolicy.bootstrapRecovery.maximumRecoverySeconds,
  });
  const operationStored = await Promise.all(
    operationEntries(artifact, operations).map(async ([name, value]) => [
      name,
      await putCanonical({
        store,
        namespace,
        value,
        mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_OPERATION_MEDIA_TYPE,
        label: `Foundation bootstrap ${name} receipt`,
      }),
    ]),
  );
  const rehearsal = assertRehearsal(
    rehearsalFor({
      namespace,
      executorSourceSha,
      bootstrapSeedAuthority,
      bootstrapSourceResolution,
      oidcAuthority,
      oidcReceipt,
      reviewedWorkflowRun,
      artifact,
      operations,
      approvalPolicy,
    }),
  );
  const [snapshotStored, rehearsalStored] = await Promise.all([
    putCanonical({
      store,
      namespace,
      value: policySnapshot(options),
      mediaType: FOUNDATION_BOOTSTRAP_POLICY_SNAPSHOT_MEDIA_TYPE,
      label: "Foundation bootstrap policy snapshot",
    }),
    putCanonical({
      store,
      namespace,
      value: rehearsal,
      mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_REHEARSAL_MEDIA_TYPE,
      label: "Foundation bootstrap recovery rehearsal",
    }),
  ]);
  const operationReceipts = Object.fromEntries(
    operationStored.map(([name, stored]) => [name, { ...stored.reference }]),
  );
  const raw = {
    schemaVersion: 2,
    kind: "foundation-bootstrap-recovery-raw/v2",
    namespace,
    sourceSha: executorSourceSha,
    observedAt: rehearsal.completedAt,
    collector: {
      runId: oidcAuthority.runId,
      runAttempt: oidcAuthority.runAttempt,
      oidcReceipt: { ...oidcReceipt },
    },
    bootstrap: {
      sourceSha: bootstrapSourceResolution.gitCommitSha,
      commitTreeSha: bootstrapSourceResolution.treeSha,
      bindingId: artifact.binding.bindingId,
      bindingReference: {
        ...bindingReference(namespace, p0aPolicy),
      },
      seedAuthority: { ...bootstrapSeedAuthority },
      reviewedSeedWorkflowRun: { ...reviewedWorkflowRun },
    },
    policySnapshot: { ...snapshotStored.reference },
    operationReceipts,
    rehearsal: { ...rehearsalStored.reference },
  };
  assertRaw(raw, { namespace, sourceSha: executorSourceSha });
  const rawBytes = canonicalJsonBytes(raw);
  for (const name of [
    p0aPolicy.providerCredentialEnvironmentName,
    p0aPolicy.githubCredentialEnvironmentName,
  ]) {
    const secret = environment[name];
    if (
      typeof secret === "string" &&
      rawBytes.includes(Buffer.from(secret, "utf8"))
    ) {
      throw new Error("Foundation bootstrap authority exposes a credential");
    }
  }
  const rawStored = await putCanonical({
    store,
    namespace,
    value: raw,
    mediaType: FOUNDATION_BOOTSTRAP_RECOVERY_RAW_MEDIA_TYPE,
    label: "Foundation bootstrap recovery raw authority",
  });
  const verified = await readStoredAuthority(
    {
      store,
      namespace,
      reference: rawStored.reference,
      p0aPolicy,
      providerPolicy,
      databaseContract: options.databaseContract,
      storePolicy: options.storePolicy,
      approvalPolicy,
      foundationBaseline,
      toolchainPolicy,
      bootstrapSourceResolution,
    },
    {
      readOidcAuthority,
      readSeedAuthority,
      readWorkflowRun,
      assertBootstrapSource,
      now: clock,
    },
  );
  return Object.freeze(
    assertFoundationBootstrapRecoveryObservation({
      schemaVersion: 2,
      kind: "foundation-bootstrap-recovery-observation/v2",
      namespace,
      sourceSha: executorSourceSha,
      observedAt: verified.rehearsal.completedAt,
      collectorIdentity: {
        repository: approvalPolicy.repository,
        workflowPath: WORKFLOW_PATH,
        sourceSha: executorSourceSha,
        runId: oidcAuthority.runId,
        runAttempt: oidcAuthority.runAttempt,
      },
      oidcReceipt: { ...oidcReceipt },
      rawAuthority: { ...rawStored.reference },
      rehearsalAuthority: { ...rehearsalStored.reference },
      result: { ...verified.result },
      stateInitializationSubject: structuredClone(
        verified.stateInitializationSubject,
      ),
    }),
  );
};
