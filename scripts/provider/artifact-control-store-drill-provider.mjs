import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { verifyDeterministicZip } from "../deterministic-zip.mjs";
import { buildClosedVercelCommandEnvironment } from "./vercel-command-environment.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { assertManifestMatchesOutput } from "../lib/artifact-contract.mjs";
import { resolveContentAddressedObject } from "../lib/content-addressed-store.mjs";
import { probeImmutableDeployment } from "./deploymentBindingProducer.mjs";
import { extractPrebuiltArchive } from "./prebuiltDeployment.mjs";
import { resolvePinnedVercelCli } from "./preparedPromotion.mjs";
import {
  ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE,
  assertArtifactDrillArchiveReceipt,
  assertArtifactDrillAssignmentReceipt,
  assertArtifactDrillBuildReceipt,
  assertArtifactDrillDeploymentReceipt,
  assertArtifactDrillProviderObservationReceipt,
  assertArtifactDrillProviderCleanupReceipt,
  assertArtifactDrillReconcileReceipt,
  assertArtifactDrillRedeployReceipt,
  putCanonicalArtifactDrillReceipt,
} from "./artifact-control-store-drill-receipts.mjs";
import { assertPreparedArtifactDrillBootstrapRawDist } from "./artifact-control-store-drill-bootstrap.mjs";

const MAXIMUM_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const PURPOSE = "non-promotable-artifact-drill";
const ROLES = Object.freeze(["containment", "standard"]);
const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

const assertProviderEnvironment = ({ environment, providerPolicy }) => {
  const token = environment?.VERCEL_TOKEN;
  if (
    providerPolicy?.provider !== "vercel" ||
    providerPolicy.bindingStatus !== "configured" ||
    typeof providerPolicy.expectedProjectId !== "string" ||
    typeof providerPolicy.expectedTeamId !== "string" ||
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 4096 ||
    environment.VERCEL_PROJECT_ID !== providerPolicy.expectedProjectId ||
    environment.VERCEL_ORG_ID !== providerPolicy.expectedTeamId
  ) {
    throw new Error(
      "Artifact drill preview provider authority is not configured",
    );
  }
  return Object.freeze({ token });
};

const productionDomains = (providerPolicy) => [
  ...(providerPolicy.ownedProductionDomains ?? []),
  ...(providerPolicy.productionDomains ?? []),
  ...(providerPolicy.productionAliases ?? []),
];

const assertOutsideProductionDomains = (hostname, forbiddenAliases) => {
  const candidate = hostname.toLowerCase();
  for (const domain of forbiddenAliases) {
    const forbidden = domain.toLowerCase();
    if (
      candidate === forbidden ||
      candidate.endsWith(`.${forbidden}`) ||
      forbidden.endsWith(`.${candidate}`)
    ) {
      throw new Error(
        "Artifact drill preview authority overlaps production domain",
      );
    }
  }
};

export const deriveArtifactDrillPreviewDomains = ({
  drillNamespace,
  aliasSuffix,
  forbiddenAliases,
}) => {
  if (
    typeof aliasSuffix !== "string" ||
    aliasSuffix.length < 3 ||
    aliasSuffix !== aliasSuffix.toLowerCase()
  ) {
    throw new Error("Artifact drill preview alias suffix is not configured");
  }
  const domains = ROLES.map((role) =>
    `${drillNamespace}.${role}.${aliasSuffix}`.toLowerCase(),
  );
  for (const domain of domains) {
    if (domain.length > 253) {
      throw new Error("Artifact drill preview alias is oversized");
    }
    assertOutsideProductionDomains(domain, forbiddenAliases);
  }
  if (new Set(domains).size !== domains.length) {
    throw new Error("Artifact drill preview aliases are ambiguous");
  }
  return Object.freeze(
    Object.fromEntries(ROLES.map((role, index) => [role, domains[index]])),
  );
};

export const assertArtifactDrillPreviewOnlyArguments = (arguments_) => {
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
    arguments_.includes("--prod") ||
    arguments_.filter((value) => value === "deploy").length !== 1 ||
    arguments_.filter((value) => value === "--prebuilt").length !== 1 ||
    arguments_.filter((value) => value === "--skip-domain").length !== 1 ||
    arguments_.filter((value) => value === "--yes").length !== 1 ||
    arguments_.filter((value) => value === "--cwd").length !== 1
  ) {
    throw new Error("Artifact drill Vercel command is not preview-only");
  }
  return arguments_;
};

const defaultCommandRunner = ({ executable, arguments_, cwd, environment }) =>
  spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });

const parseSinglePreviewUrl = (stdout) => {
  const lines = String(stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const urls = [
    ...new Set(
      lines
        .flatMap((line) => line.match(/https:\/\/[^\s]+/gu) ?? [])
        .map((value) => value.replace(/[),.;]+$/u, "")),
    ),
  ];
  if (urls.length !== 1) {
    throw new Error("Artifact drill Vercel output lacks one preview URL");
  }
  const parsed = new URL(urls[0]);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Artifact drill Vercel preview URL is invalid");
  }
  return `https://${parsed.hostname.toLowerCase()}/`;
};

const readProviderResponse = async (response, label) => {
  const declared = response?.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^[0-9]+$/u.test(declared) ||
      Number(declared) > MAXIMUM_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new Error(`${label} response is oversized`);
  }
  if (typeof response?.arrayBuffer !== "function") {
    throw new Error(`${label} response is unavailable`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
    throw new Error(`${label} response bytes are invalid`);
  }
  return Object.freeze({
    bytes,
    date: response.headers.get("date"),
    etag: response.headers.get("etag"),
    sha256: sha256Bytes(bytes),
    status: response.status,
  });
};

const providerFetch = async ({
  fetchImpl,
  token,
  url,
  method = "GET",
  body,
  label,
}) => {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  const response = await fetchImpl(url, {
    method,
    redirect: "error",
    headers,
    ...(body === undefined ? {} : { body: canonicalJsonBytes(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const receipt = await readProviderResponse(response, label);
  const value = parseJsonStrict(receipt.bytes.toString("utf8"), label);
  return Object.freeze({ ...receipt, value });
};

const providerCleanupFetch = async ({
  fetchImpl,
  token,
  url,
  method,
  label,
}) => {
  const response = await fetchImpl(url, {
    method,
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const declared = response?.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^[0-9]+$/u.test(declared) ||
      Number(declared) > MAXIMUM_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new Error(`${label} response is oversized`);
  }
  if (
    !Number.isSafeInteger(response?.status) ||
    typeof response?.arrayBuffer !== "function"
  ) {
    throw new Error(`${label} response is unavailable`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
    throw new Error(`${label} response bytes are oversized`);
  }
  let value = null;
  if (bytes.length > 0) {
    value = parseJsonStrict(bytes.toString("utf8"), label);
  } else {
    throw new Error(`${label} returned an empty response`);
  }
  return Object.freeze({
    method,
    requestUrl: url,
    responseSha256: sha256Bytes(bytes),
    status: response.status,
    value,
  });
};

const deploymentLookupUrl = ({ deploymentUrl, providerPolicy }) => {
  const url = new URL(
    `/v13/deployments/${encodeURIComponent(new URL(deploymentUrl).hostname)}`,
    "https://api.vercel.com",
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  return url.href;
};

const deploymentDeleteUrl = ({ deploymentId, providerPolicy }) => {
  const url = new URL(
    `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    "https://api.vercel.com",
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  return url.href;
};

const defaultResolvePreviewDeployment = async ({
  deploymentUrl,
  providerPolicy,
  token,
  fetchImpl,
}) => {
  const requestUrl = deploymentLookupUrl({ deploymentUrl, providerPolicy });
  const response = await providerFetch({
    fetchImpl,
    token,
    url: requestUrl,
    label: "Artifact drill provider deployment lookup",
  });
  const normalizedUrl =
    typeof response.value.url === "string" &&
    !response.value.url.startsWith("http")
      ? `https://${response.value.url}/`
      : response.value.url?.endsWith("/")
        ? response.value.url
        : `${response.value.url}/`;
  if (
    response.status !== 200 ||
    normalizedUrl !== deploymentUrl ||
    response.value.projectId !== providerPolicy.expectedProjectId ||
    response.value.ownerId !== providerPolicy.expectedTeamId ||
    response.value.target !== null ||
    response.value.readyState !== "READY" ||
    typeof response.value.id !== "string" ||
    response.value.id.length === 0
  ) {
    throw new Error("Artifact drill provider preview binding differs");
  }
  return Object.freeze({
    deploymentId: response.value.id,
    provider: Object.freeze({
      date: response.date,
      deploymentTarget: null,
      etag: response.etag,
      projectId: response.value.projectId,
      readyState: response.value.readyState,
      requestUrl,
      responseSha256: response.sha256,
      status: response.status,
      teamId: response.value.ownerId,
    }),
  });
};

const defaultBuildPackage = async (options) => {
  const { buildNonPromotableArtifactDrillPackage } =
    await import("../build-release-artifact.mjs");
  if (typeof buildNonPromotableArtifactDrillPackage !== "function") {
    throw new Error("Artifact drill dedicated build purpose is unavailable");
  }
  return buildNonPromotableArtifactDrillPackage(options);
};

const defaultPrepareRawDist = ({ bootstrapMaterialization }) =>
  assertPreparedArtifactDrillBootstrapRawDist(bootstrapMaterialization);

const normalizedRoleBuilds = (roles) =>
  [...roles]
    .map((role) => ({
      archiveSha256: role.archiveSha256,
      capabilitySha256: role.capabilitySha256,
      dbFingerprint: role.dbFingerprint,
      manifestSha256: role.manifestSha256,
      policySha256: role.policySha256,
      role: role.role,
    }))
    .sort((left, right) => left.role.localeCompare(right.role));

const buildOneAttempt = async ({
  attempt,
  authority,
  buildOptions,
  workRoot,
  drillStore,
  buildPackage,
}) => {
  const packageRoot = path.join(workRoot, `package-${attempt}`);
  const scratchRoot = path.join(workRoot, `scratch-${attempt}`);
  const built = await buildPackage({
    ...buildOptions,
    packageRoot,
    scratchRoot,
  });
  const roles = normalizedRoleBuilds(built?.roles ?? []);
  const pairHash = sha256Json({
    kind: "artifact-drill-package-pair/v1",
    roles: roles.map(({ archiveSha256, role }) => ({ archiveSha256, role })),
  });
  const value = {
    schemaVersion: 1,
    kind: "artifact-drill-build-receipt/v1",
    attempt,
    authority,
    buildPurpose: PURPOSE,
    buildAuthority: structuredClone(built?.authority),
    packageArchiveSha256: pairHash,
    packageIndexSha256: built?.packageIndex?.sha256,
    bootstrapVerification: built?.bootstrapVerification,
    roles,
  };
  const reference = await putCanonicalArtifactDrillReceipt({
    store: drillStore,
    value,
    mediaType: ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
    validator: assertArtifactDrillBuildReceipt,
    expected: { attempt, authority },
  });
  return Object.freeze({ built, receipt: value, reference });
};

const readAndExtractArtifacts = async ({ attempt, workRoot }) => {
  const index = parseJsonStrict(
    attempt.built.packageIndex.bytes.toString("utf8"),
    "Artifact drill package index",
  );
  const artifacts = [];
  for (const role of attempt.built.roles) {
    const manifestObject = await resolveContentAddressedObject({
      packageRoot: attempt.built.packageRoot,
      reference: role.manifestReference,
      expectedKind: "artifact-manifest.json",
    });
    const archiveObject = await resolveContentAddressedObject({
      packageRoot: attempt.built.packageRoot,
      reference: role.archiveReference,
      expectedKind: "artifact.zip",
    });
    const manifest = parseJsonStrict(
      manifestObject.bytes.toString("utf8"),
      `${role.role} artifact manifest`,
    );
    if (
      sha256Bytes(manifestObject.bytes) !== role.manifestSha256 ||
      sha256Bytes(archiveObject.bytes) !== role.archiveSha256
    ) {
      throw new Error("Artifact drill content-addressed build object differs");
    }
    await verifyDeterministicZip({
      archivePath: archiveObject.path,
      expectedFiles: manifest.outputFiles,
    });
    const extractedRoot = path.join(
      workRoot,
      "archive-verification",
      role.role,
    );
    await mkdir(extractedRoot, { recursive: true });
    await extractPrebuiltArchive({
      archivePath: archiveObject.path,
      destination: extractedRoot,
      expectedFiles: manifest.outputFiles,
    });
    await assertManifestMatchesOutput(extractedRoot, manifest);
    artifacts.push(
      Object.freeze({
        archiveObject,
        index,
        manifest,
        manifestObject,
        packageRoot: attempt.built.packageRoot,
        role: role.role,
      }),
    );
  }
  return artifacts.sort((left, right) => left.role.localeCompare(right.role));
};

const deployPreviewArtifact = async ({
  artifact,
  authority,
  drillStore,
  providerPolicy,
  cspPolicy,
  toolchainPolicy,
  environment,
  forbiddenAliases,
  workRoot,
  fetchImpl,
  commandRunner,
  resolvePreviewDeployment,
  root,
  nowMilliseconds,
  token,
  storeReceipt = true,
  trackDeployment = () => {},
}) => {
  const deployRoot = await mkdtemp(
    path.join(workRoot, `deploy-${artifact.role}-`),
  );
  const outputRoot = path.join(deployRoot, ".vercel", "output");
  await mkdir(outputRoot, { recursive: true });
  await extractPrebuiltArchive({
    archivePath: artifact.archiveObject.path,
    destination: outputRoot,
    expectedFiles: artifact.manifest.outputFiles,
  });
  await assertManifestMatchesOutput(outputRoot, artifact.manifest);
  const cli = await resolvePinnedVercelCli({ root, toolchainPolicy });
  const arguments_ = assertArtifactDrillPreviewOnlyArguments([
    cli.cliPath,
    "deploy",
    "--prebuilt",
    "--skip-domain",
    "--yes",
    "--cwd",
    deployRoot,
  ]);
  const result = await commandRunner({
    executable: process.execPath,
    arguments_: arguments_,
    cwd: deployRoot,
    environment: buildClosedVercelCommandEnvironment(environment),
  });
  if (result?.error !== undefined) throw result.error;
  if (result?.status !== 0) {
    throw new Error(
      `Artifact drill preview deploy failed with status ${String(result?.status)}`,
    );
  }
  const previewUrl = parseSinglePreviewUrl(result.stdout);
  assertOutsideProductionDomains(
    new URL(previewUrl).hostname,
    forbiddenAliases,
  );
  trackDeployment({ deploymentId: null, previewUrl });
  const resolved = await resolvePreviewDeployment({
    deploymentUrl: previewUrl,
    providerPolicy,
    token,
    fetchImpl,
  });
  trackDeployment({ deploymentId: resolved.deploymentId, previewUrl });
  const probe = await probeImmutableDeployment({
    deploymentUrl: previewUrl.slice(0, -1),
    manifest: artifact.manifest,
    index: artifact.index,
    packageRoot: artifact.packageRoot,
    providerPolicy,
    cspPolicy,
    fetchImpl,
    nowMilliseconds,
    secrets: [token],
    expectedBuildPurpose: PURPOSE,
  });
  const routeProbes = probe.routes
    .map((route) => ({
      path: route.path,
      responseSha256: route.bodySha256,
      status: route.status,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const value = {
    schemaVersion: 1,
    kind: "artifact-drill-preview-deployment-receipt/v1",
    authority,
    role: artifact.role,
    target: "preview",
    deploymentId: resolved.deploymentId,
    previewUrl,
    packageArchiveSha256: sha256Bytes(artifact.archiveObject.bytes),
    manifestSha256: sha256Bytes(artifact.manifestObject.bytes),
    provider: resolved.provider,
    routeProbes,
  };
  const expected = { authority, forbiddenAliases, providerPolicy };
  assertArtifactDrillDeploymentReceipt(value, expected);
  const reference = storeReceipt
    ? await putCanonicalArtifactDrillReceipt({
        store: drillStore,
        value,
        mediaType: ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
        validator: assertArtifactDrillDeploymentReceipt,
        expected,
      })
    : null;
  return Object.freeze({ artifact, receipt: value, reference });
};

const aliasCommandUrl = ({ deploymentId, providerPolicy }) => {
  const url = new URL(
    `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`,
    "https://api.vercel.com",
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  return url.href;
};

const aliasLookupUrl = ({ domain, providerPolicy }) => {
  const url = new URL(
    `/v4/aliases/${encodeURIComponent(domain)}`,
    "https://api.vercel.com",
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  return url.href;
};

const aliasDeleteUrl = ({ domain, providerPolicy }) => {
  const url = new URL(
    `/v2/aliases/${encodeURIComponent(domain)}`,
    "https://api.vercel.com",
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  return url.href;
};

const assignAndObserveAlias = async ({
  deployment,
  domain,
  authority,
  providerPolicy,
  aliasSuffix,
  forbiddenAliases,
  drillStore,
  token,
  fetchImpl,
  trackAlias = () => {},
}) => {
  const commandRequestUrl = aliasCommandUrl({
    deploymentId: deployment.receipt.deploymentId,
    providerPolicy,
  });
  trackAlias({
    deploymentId: deployment.receipt.deploymentId,
    domain,
  });
  const command = await providerFetch({
    fetchImpl,
    token,
    url: commandRequestUrl,
    method: "POST",
    body: { alias: domain },
    label: "Artifact drill alias command",
  });
  if (
    command.status !== 200 ||
    command.value?.alias !== domain ||
    (command.value.deploymentId !== undefined &&
      command.value.deploymentId !== deployment.receipt.deploymentId)
  ) {
    throw new Error("Artifact drill alias command response differs");
  }
  const requestUrl = aliasLookupUrl({ domain, providerPolicy });
  const lookup = await providerFetch({
    fetchImpl,
    token,
    url: requestUrl,
    label: "Artifact drill alias lookup",
  });
  const observedDeploymentId =
    lookup.value?.deploymentId ?? lookup.value?.deployment?.id;
  const observedProjectId =
    lookup.value?.projectId ?? lookup.value?.project?.id;
  const value = {
    schemaVersion: 1,
    kind: "artifact-drill-preview-assignment-receipt/v1",
    authority,
    deploymentId: deployment.receipt.deploymentId,
    domain,
    provider: {
      commandRequestUrl,
      commandResponseSha256: command.sha256,
      date: lookup.date,
      etag: lookup.etag,
      observedDeploymentId,
      observedProjectId,
      requestUrl,
      responseSha256: lookup.sha256,
      status: lookup.status,
    },
  };
  const expected = {
    aliasSuffix,
    authority,
    forbiddenAliases,
    providerPolicy,
  };
  const reference = await putCanonicalArtifactDrillReceipt({
    store: drillStore,
    value,
    mediaType: ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE,
    validator: assertArtifactDrillAssignmentReceipt,
    expected,
  });
  return Object.freeze({ receipt: value, reference });
};

const observeAlias = async ({
  domain,
  deploymentId,
  providerPolicy,
  token,
  fetchImpl,
}) => {
  const response = await providerFetch({
    fetchImpl,
    token,
    url: aliasLookupUrl({ domain, providerPolicy }),
    label: "Artifact drill reconcile alias lookup",
  });
  const observedDeploymentId =
    response.value?.deploymentId ?? response.value?.deployment?.id;
  const observedProjectId =
    response.value?.projectId ?? response.value?.project?.id;
  if (
    response.status !== 200 ||
    observedDeploymentId !== deploymentId ||
    observedProjectId !== providerPolicy.expectedProjectId
  ) {
    throw new Error("Artifact drill reconcile alias mapping differs");
  }
  return Object.freeze({
    deploymentId,
    domain,
    responseSha256: response.sha256,
  });
};

const cleanupProjection = ({ method, requestUrl, responseSha256, status }) =>
  Object.freeze({ method, requestUrl, responseSha256, status });

const cleanupAlias = async ({ resource, providerPolicy, token, fetchImpl }) => {
  const lookupUrl = aliasLookupUrl({
    domain: resource.domain,
    providerPolicy,
  });
  const preDelete = await providerCleanupFetch({
    fetchImpl,
    token,
    url: lookupUrl,
    method: "GET",
    label: "Artifact drill alias cleanup pre-read",
  });
  if (![200, 404].includes(preDelete.status)) {
    throw new Error("Artifact drill alias cleanup pre-read status differs");
  }
  if (preDelete.status === 200) {
    const observedDeploymentId =
      preDelete.value?.deploymentId ?? preDelete.value?.deployment?.id;
    const observedProjectId =
      preDelete.value?.projectId ?? preDelete.value?.project?.id;
    if (
      observedDeploymentId !== resource.deploymentId ||
      observedProjectId !== providerPolicy.expectedProjectId
    ) {
      throw new Error(
        "Artifact drill alias cleanup refused a foreign provider binding",
      );
    }
  }
  const deletion = await providerCleanupFetch({
    fetchImpl,
    token,
    url: aliasDeleteUrl({ domain: resource.domain, providerPolicy }),
    method: "DELETE",
    label: "Artifact drill alias cleanup deletion",
  });
  if (![200, 404].includes(deletion.status)) {
    throw new Error("Artifact drill alias cleanup deletion status differs");
  }
  if (deletion.status === 200 && deletion.value?.status !== "SUCCESS") {
    throw new Error("Artifact drill alias cleanup deletion response differs");
  }
  const readback = await providerCleanupFetch({
    fetchImpl,
    token,
    url: lookupUrl,
    method: "GET",
    label: "Artifact drill alias cleanup readback",
  });
  if (readback.status !== 404) {
    throw new Error("Artifact drill alias cleanup was not observed");
  }
  return Object.freeze({
    domain: resource.domain,
    deploymentId: resource.deploymentId,
    preDelete: cleanupProjection(preDelete),
    deletion: cleanupProjection(deletion),
    readback: cleanupProjection(readback),
  });
};

const cleanupDeployment = async ({
  resource,
  providerPolicy,
  token,
  fetchImpl,
}) => {
  const preDeleteUrl = deploymentLookupUrl({
    deploymentUrl: resource.previewUrl,
    providerPolicy,
  });
  const preDelete = await providerCleanupFetch({
    fetchImpl,
    token,
    url: preDeleteUrl,
    method: "GET",
    label: "Artifact drill deployment cleanup pre-read",
  });
  if (![200, 404].includes(preDelete.status)) {
    throw new Error(
      "Artifact drill deployment cleanup pre-read status differs",
    );
  }
  const observedDeploymentId =
    preDelete.status === 200
      ? preDelete.value?.id
      : new URL(resource.previewUrl).hostname;
  if (preDelete.status === 200) {
    const observedUrl =
      typeof preDelete.value?.url === "string" &&
      !preDelete.value.url.startsWith("http")
        ? `https://${preDelete.value.url}/`
        : preDelete.value?.url?.endsWith("/")
          ? preDelete.value.url
          : `${preDelete.value?.url}/`;
    if (
      observedUrl !== resource.previewUrl ||
      preDelete.value?.projectId !== providerPolicy.expectedProjectId ||
      preDelete.value?.ownerId !== providerPolicy.expectedTeamId ||
      preDelete.value?.target !== null ||
      (resource.deploymentId !== null &&
        preDelete.value?.id !== resource.deploymentId) ||
      typeof preDelete.value?.id !== "string" ||
      preDelete.value.id.length === 0
    ) {
      throw new Error(
        "Artifact drill deployment cleanup refused a production or foreign binding",
      );
    }
  }
  const deleteUrl = deploymentDeleteUrl({
    deploymentId: observedDeploymentId,
    providerPolicy,
  });
  const deletion = await providerCleanupFetch({
    fetchImpl,
    token,
    url: deleteUrl,
    method: "DELETE",
    label: "Artifact drill deployment cleanup deletion",
  });
  if (![200, 404].includes(deletion.status)) {
    throw new Error(
      "Artifact drill deployment cleanup deletion status differs",
    );
  }
  if (
    deletion.status === 200 &&
    (deletion.value?.uid !== observedDeploymentId ||
      deletion.value?.state !== "DELETED")
  ) {
    throw new Error(
      "Artifact drill deployment cleanup deletion response differs",
    );
  }
  const readback = await providerCleanupFetch({
    fetchImpl,
    token,
    url: deleteUrl,
    method: "GET",
    label: "Artifact drill deployment cleanup readback",
  });
  if (readback.status !== 404) {
    throw new Error("Artifact drill deployment cleanup was not observed");
  }
  return Object.freeze({
    deploymentId: observedDeploymentId,
    previewUrl: resource.previewUrl,
    preDelete: cleanupProjection(preDelete),
    deletion: cleanupProjection(deletion),
    readback: cleanupProjection(readback),
  });
};

const settledCleanupValues = async (promises, label) => {
  const settled = await Promise.allSettled(promises);
  const errors = settled
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, `${label} failed`);
  }
  return settled.map(({ value }) => value);
};

export const cleanupArtifactDrillProviderResources = async ({
  authority,
  resources,
  drillStore,
  providerPolicy,
  aliasSuffix,
  forbiddenAliases,
  token,
  fetchImpl,
}) => {
  if (
    drillStore?.namespace !== authority?.drillNamespace ||
    !Array.isArray(resources?.aliases) ||
    !Array.isArray(resources?.deployments) ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error("Artifact drill provider cleanup authority is invalid");
  }
  const aliases = resources.aliases
    .map((resource) => Object.freeze({ ...resource }))
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const deployments = resources.deployments
    .map((resource) => Object.freeze({ ...resource }))
    .sort((left, right) => left.previewUrl.localeCompare(right.previewUrl));
  if (
    new Set(aliases.map(({ domain }) => domain)).size !== aliases.length ||
    new Set(deployments.map(({ previewUrl }) => previewUrl)).size !==
      deployments.length
  ) {
    throw new Error("Artifact drill provider cleanup resources are ambiguous");
  }
  for (const alias of aliases) {
    if (
      typeof alias.domain !== "string" ||
      !DOMAIN.test(alias.domain) ||
      !alias.domain.startsWith(`${authority.drillNamespace}.`) ||
      !alias.domain.endsWith(`.${aliasSuffix}`) ||
      typeof alias.deploymentId !== "string" ||
      alias.deploymentId.length === 0
    ) {
      throw new Error("Artifact drill provider cleanup alias is unsafe");
    }
    assertOutsideProductionDomains(alias.domain, forbiddenAliases);
  }
  for (const deployment of deployments) {
    const preview = new URL(deployment.previewUrl);
    if (
      preview.protocol !== "https:" ||
      preview.username !== "" ||
      preview.password !== "" ||
      preview.port !== "" ||
      preview.pathname !== "/" ||
      preview.search !== "" ||
      preview.hash !== "" ||
      (deployment.deploymentId !== null &&
        (typeof deployment.deploymentId !== "string" ||
          deployment.deploymentId.length === 0))
    ) {
      throw new Error("Artifact drill provider cleanup deployment is unsafe");
    }
    assertOutsideProductionDomains(preview.hostname, forbiddenAliases);
  }

  const [aliasResult, deploymentResult] = await Promise.allSettled([
    settledCleanupValues(
      aliases.map((resource) =>
        cleanupAlias({
          resource,
          providerPolicy,
          token,
          fetchImpl,
        }),
      ),
      "Artifact drill alias cleanup",
    ),
    settledCleanupValues(
      deployments.map((resource) =>
        cleanupDeployment({
          resource,
          providerPolicy,
          token,
          fetchImpl,
        }),
      ),
      "Artifact drill deployment cleanup",
    ),
  ]);
  const errors = [aliasResult, deploymentResult]
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Artifact drill provider cleanup failed");
  }
  const value = {
    schemaVersion: 1,
    kind: "artifact-drill-provider-cleanup-receipt/v1",
    authority,
    projectId: providerPolicy.expectedProjectId,
    teamId: providerPolicy.expectedTeamId,
    aliases: aliasResult.value,
    deployments: deploymentResult.value.sort((left, right) =>
      left.deploymentId.localeCompare(right.deploymentId),
    ),
  };
  const expected = {
    aliasSuffix,
    authority,
    forbiddenAliases,
    providerPolicy,
  };
  const reference = await putCanonicalArtifactDrillReceipt({
    store: drillStore,
    value,
    mediaType: ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
    validator: assertArtifactDrillProviderCleanupReceipt,
    expected,
  });
  return Object.freeze({ receipt: Object.freeze(value), reference });
};

export const executeArtifactControlStoreLiveOperations = async (
  {
    authority,
    drillNamespace,
    forbiddenAliases,
    previewOnly,
    sourceSha,
    drillStore,
    controlStoreExecutor,
    providerPolicy,
    artifactDrillPolicy,
    bootstrapMaterialization,
    buildOptions,
    cspPolicy,
    toolchainPolicy,
    environment = process.env,
    root = process.cwd(),
    stagingParent = os.tmpdir(),
    nowMilliseconds = Date.now(),
  },
  {
    buildPackage = defaultBuildPackage,
    commandRunner = defaultCommandRunner,
    fetchImpl = globalThis.fetch,
    prepareRawDist = defaultPrepareRawDist,
    resolvePreviewDeployment = defaultResolvePreviewDeployment,
    cleanupProviderResources = cleanupArtifactDrillProviderResources,
  } = {},
) => {
  if (
    previewOnly !== true ||
    sourceSha !== authority?.sourceSha ||
    drillStore?.namespace !== drillNamespace ||
    typeof controlStoreExecutor !== "function" ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error("Artifact drill live execution authority is invalid");
  }
  const { token } = assertProviderEnvironment({
    environment,
    providerPolicy,
  });
  const allForbidden = [
    ...new Set([...forbiddenAliases, ...productionDomains(providerPolicy)]),
  ];
  const previewDomains = deriveArtifactDrillPreviewDomains({
    drillNamespace,
    aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
    forbiddenAliases: allForbidden,
  });
  const workRoot = await mkdtemp(
    path.join(path.resolve(stagingParent), "foundation-artifact-drill-"),
  );
  let controlStorePromise = null;
  let operations = null;
  let executionError = null;
  let providerCleanup = null;
  const trackedAliases = new Map();
  const trackedDeployments = new Map();
  const trackAlias = ({ domain, deploymentId }) => {
    const existing = trackedAliases.get(domain);
    if (existing !== undefined && existing.deploymentId !== deploymentId) {
      throw new Error("Artifact drill alias cleanup tracking is ambiguous");
    }
    trackedAliases.set(domain, Object.freeze({ domain, deploymentId }));
  };
  const trackDeployment = ({ previewUrl, deploymentId }) => {
    const existing = trackedDeployments.get(previewUrl);
    if (
      existing !== undefined &&
      existing.deploymentId !== null &&
      deploymentId !== null &&
      existing.deploymentId !== deploymentId
    ) {
      throw new Error(
        "Artifact drill deployment cleanup tracking is ambiguous",
      );
    }
    trackedDeployments.set(
      previewUrl,
      Object.freeze({
        previewUrl,
        deploymentId: deploymentId ?? existing?.deploymentId ?? null,
      }),
    );
  };
  try {
    controlStorePromise = Promise.resolve().then(controlStoreExecutor);
    if (Object.hasOwn(buildOptions ?? {}, "rawDistRoot")) {
      throw new Error("Artifact drill raw dist cannot be caller supplied");
    }
    const rawDistRoot = await prepareRawDist({ bootstrapMaterialization });
    const effectiveBuildOptions = { ...buildOptions, rawDistRoot };
    const attempts = [];
    for (const attempt of [1, 2]) {
      attempts.push(
        await buildOneAttempt({
          attempt,
          authority,
          buildOptions: effectiveBuildOptions,
          workRoot,
          drillStore,
          buildPackage,
        }),
      );
    }
    if (
      attempts[0].receipt.packageArchiveSha256 !==
        attempts[1].receipt.packageArchiveSha256 ||
      attempts[0].receipt.packageIndexSha256 !==
        attempts[1].receipt.packageIndexSha256 ||
      !canonicalJsonBytes(attempts[0].receipt.roles).equals(
        canonicalJsonBytes(attempts[1].receipt.roles),
      ) ||
      !canonicalJsonBytes(attempts[0].receipt.bootstrapVerification).equals(
        canonicalJsonBytes(attempts[1].receipt.bootstrapVerification),
      )
    ) {
      throw new Error("Artifact drill independent builds are not reproducible");
    }
    const artifacts = await readAndExtractArtifacts({
      attempt: attempts[0],
      workRoot,
    });
    const archiveValue = {
      schemaVersion: 1,
      kind: "artifact-drill-archive-receipt/v1",
      authority,
      bootstrapVerification: attempts[0].receipt.bootstrapVerification,
      capabilityVerified: true,
      dbBindingVerified: true,
      extractedManifestSha256: sha256Json(
        artifacts.map(({ manifestObject, role }) => ({
          manifestSha256: sha256Bytes(manifestObject.bytes),
          role,
        })),
      ),
      manifestVerified: true,
      policyBindingVerified: true,
    };
    const archiveReference = await putCanonicalArtifactDrillReceipt({
      store: drillStore,
      value: archiveValue,
      mediaType: ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE,
      validator: assertArtifactDrillArchiveReceipt,
      expected: { authority },
    });
    const deployments = await Promise.all(
      artifacts.map((artifact) =>
        deployPreviewArtifact({
          artifact,
          authority,
          drillStore,
          providerPolicy,
          cspPolicy,
          toolchainPolicy,
          environment,
          forbiddenAliases: allForbidden,
          workRoot,
          fetchImpl,
          commandRunner,
          resolvePreviewDeployment,
          root,
          nowMilliseconds,
          token,
          trackDeployment,
        }),
      ),
    );
    const providerValue = {
      schemaVersion: 1,
      kind: "artifact-drill-provider-observation/v1",
      authority,
      projectId: providerPolicy.expectedProjectId,
      teamId: providerPolicy.expectedTeamId,
      deployments: deployments
        .map(({ receipt }) => ({
          deploymentId: receipt.deploymentId,
          previewUrl: receipt.previewUrl,
          responseSha256: receipt.provider.responseSha256,
          role: receipt.role,
        }))
        .sort((left, right) => left.role.localeCompare(right.role)),
    };
    const providerReference = await putCanonicalArtifactDrillReceipt({
      store: drillStore,
      value: providerValue,
      mediaType: ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE,
      validator: assertArtifactDrillProviderObservationReceipt,
      expected: { authority, providerPolicy },
    });
    const assignments = await Promise.all(
      deployments.map((deployment) =>
        assignAndObserveAlias({
          deployment,
          domain: previewDomains[deployment.receipt.role],
          authority,
          providerPolicy,
          aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
          forbiddenAliases: allForbidden,
          drillStore,
          token,
          fetchImpl,
          trackAlias,
        }),
      ),
    );
    const standardArtifact = artifacts.find(({ role }) => role === "standard");
    const standardDeployment = deployments.find(
      ({ receipt }) => receipt.role === "standard",
    );
    const redeployed = await deployPreviewArtifact({
      artifact: standardArtifact,
      authority,
      drillStore,
      providerPolicy,
      cspPolicy,
      toolchainPolicy,
      environment,
      forbiddenAliases: allForbidden,
      workRoot,
      fetchImpl,
      commandRunner,
      resolvePreviewDeployment,
      root,
      nowMilliseconds,
      token,
      storeReceipt: false,
      trackDeployment,
    });
    const redeployValue = {
      schemaVersion: 1,
      kind: "artifact-drill-preview-redeploy-receipt/v1",
      authority,
      firstDeploymentId: standardDeployment.receipt.deploymentId,
      redeployedDeploymentId: redeployed.receipt.deploymentId,
      previewUrl: redeployed.receipt.previewUrl,
      packageArchiveSha256: redeployed.receipt.packageArchiveSha256,
      manifestSha256: redeployed.receipt.manifestSha256,
      provider: redeployed.receipt.provider,
      routeProbes: redeployed.receipt.routeProbes,
    };
    const redeployReference = await putCanonicalArtifactDrillReceipt({
      store: drillStore,
      value: redeployValue,
      mediaType: ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE,
      validator: assertArtifactDrillRedeployReceipt,
      expected: { authority, forbiddenAliases: allForbidden, providerPolicy },
    });
    const reconciledAssignments = await Promise.all(
      assignments.map(({ receipt }) =>
        observeAlias({
          domain: receipt.domain,
          deploymentId: receipt.deploymentId,
          providerPolicy,
          token,
          fetchImpl,
        }),
      ),
    );
    const reconcileValue = {
      schemaVersion: 1,
      kind: "artifact-drill-preview-reconcile-receipt/v1",
      authority,
      assignments: reconciledAssignments.sort((left, right) =>
        left.domain.localeCompare(right.domain),
      ),
    };
    const reconcileReference = await putCanonicalArtifactDrillReceipt({
      store: drillStore,
      value: reconcileValue,
      mediaType: ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE,
      validator: assertArtifactDrillReconcileReceipt,
      expected: { authority },
    });
    const controlStore = await controlStorePromise;
    operations = Object.freeze({
      toolchain: {
        node: toolchainPolicy.runtime.node,
        npm: toolchainPolicy.runtime.npm,
      },
      builds: attempts.map(({ receipt, reference }) => ({
        attempt: receipt.attempt,
        packageArchiveSha256: receipt.packageArchiveSha256,
        packageIndexSha256: receipt.packageIndexSha256,
        receiptSha256: reference.sha256,
        roles: receipt.roles,
      })),
      archiveVerification: {
        capabilityVerified: true,
        dbBindingVerified: true,
        extractedManifestSha256: archiveValue.extractedManifestSha256,
        manifestVerified: true,
        policyBindingVerified: true,
        receiptSha256: archiveReference.sha256,
      },
      deployments: deployments.map(({ receipt, reference }) => ({
        deploymentId: receipt.deploymentId,
        previewUrl: receipt.previewUrl,
        receiptSha256: reference.sha256,
        role: receipt.role,
        target: "preview",
      })),
      providerObservationSha256: providerReference.sha256,
      routeProbes: deployments.flatMap(({ receipt }) =>
        receipt.routeProbes.map(({ path, status }) => ({
          deploymentId: receipt.deploymentId,
          path,
          status,
        })),
      ),
      controlStore,
      assignments: assignments.map(({ receipt, reference }) => ({
        deploymentId: receipt.deploymentId,
        domain: receipt.domain,
        receiptSha256: reference.sha256,
        verified: true,
      })),
      redeploy: { receiptSha256: redeployReference.sha256, verified: true },
      reconcile: { receiptSha256: reconcileReference.sha256, verified: true },
    });
  } catch (error) {
    executionError = error;
  }

  const failures = executionError === null ? [] : [executionError];
  if (controlStorePromise !== null) {
    try {
      await controlStorePromise;
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  try {
    providerCleanup = await cleanupProviderResources({
      authority,
      resources: {
        aliases: [...trackedAliases.values()],
        deployments: [...trackedDeployments.values()],
      },
      drillStore,
      providerPolicy,
      aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
      forbiddenAliases: allForbidden,
      token,
      fetchImpl,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(workRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Artifact drill live execution or cleanup failed",
    );
  }
  if (operations === null || providerCleanup === null) {
    throw new Error("Artifact drill live execution did not produce cleanup");
  }
  return Object.freeze({
    ...operations,
    providerCleanup: Object.freeze({
      aliasCount: providerCleanup.receipt.aliases.length,
      deploymentCount: providerCleanup.receipt.deployments.length,
      receiptSha256: providerCleanup.reference.sha256,
      verified: true,
    }),
  });
};
