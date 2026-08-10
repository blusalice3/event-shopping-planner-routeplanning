import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertArtifactManifest,
  assertReleaseIdentity,
  assertReleasePackageIndex,
  publicPathToOutputPath,
} from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  CSP_HEADER_NAMES,
  renderCspHeaders,
  resolveProviderEnvironmentContract,
} from "../lib/csp-delivery.mjs";
import {
  contentAddressedObjectPath,
  parseContentAddressedUri,
} from "../lib/content-addressed-store.mjs";
import { verifyReleasePackage } from "../verify-release-artifact.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
  NAMESPACE_PATTERN,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  compareUtf8,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";
import { assertVercelObservationEvidence } from "./collect-vercel-observation.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";
import { repositoryRoot } from "./prebuiltDeployment.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ROLES = new Set(["standard", "containment"]);
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_OBSERVATION_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ROUTE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ROUTE_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_ROUTES = 512;
const PROVIDER_EVIDENCE_KEYS = [
  "artifactManifestHash",
  "deploymentUrl",
  "environmentPresenceEvidenceHash",
  "packageIndexHash",
  "providerConfigurationHash",
  "providerDeploymentId",
  "providerPolicyHash",
  "providerProjectId",
  "publicIdentity",
  "releasePolicyHash",
  "releaseRole",
  "requiredDbCompatibility",
  "routeProbeEvidenceHash",
  "schemaVersion",
  "sourceSha",
  "variantId",
];
const DEPLOYMENT_RECEIPT_KEYS = [
  "archive",
  "authoritativeRequest",
  "cli",
  "deployment",
  "idempotencyKey",
  "manifest",
  "packageIndexSha256",
  "productionBinding",
  "provider",
  "receiptKind",
  "releaseRole",
  "schemaVersion",
  "sourceSha",
  "variantId",
];
const SECURITY_HEADER_NAMES = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
];
const SECRET_NAME_PATTERN =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|CA_PEM|PRIVATE_KEY)(?:$|_)/i;
const PUBLIC_PATH_PATTERN = /^\/(?!\/)[^\\?#%]*$/;

const parseCanonicalJson = (bytes, label) => {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  if (input.length === 0) throw new Error(`${label} is empty`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  const value = parseJsonStrict(text, label);
  if (!canonicalJsonBytes(value).equals(input)) {
    throw new Error(`${label} must use canonical JSON bytes`);
  }
  return value;
};

const assertRole = (role) => {
  if (!ROLES.has(role)) {
    throw new Error("Deployment binding role must be standard or containment");
  }
  return role;
};

const assertStore = (store, namespace) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error("Deployment binding evidence store is invalid");
  }
};

const assertSafePackageRoot = async (packageRoot) => {
  const resolved = path.resolve(packageRoot);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Verified release package root is not a regular directory");
  }
  return resolved;
};

const readBoundedRegularFile = async (filePath, maximumBytes, label) => {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`${label} size or file type is forbidden`);
  }
  const bytes = await readFile(filePath);
  if (bytes.length !== metadata.size) {
    throw new Error(`${label} changed while it was read`);
  }
  return bytes;
};

const readPackageObject = async ({
  packageRoot,
  reference,
  expectedKind,
  maximumBytes,
  label,
}) => {
  const parsed = parseContentAddressedUri(reference?.uri, expectedKind);
  if (parsed.sha256 !== reference?.sha256) {
    throw new Error(`${label} URI/hash binding differs`);
  }
  const objectPath = contentAddressedObjectPath(
    packageRoot,
    parsed.sha256,
    parsed.kind,
  );
  const bytes = await readBoundedRegularFile(objectPath, maximumBytes, label);
  if (sha256Bytes(bytes) !== reference.sha256) {
    throw new Error(`${label} bytes differ from their content address`);
  }
  return { bytes, path: objectPath };
};

const selectArtifactReference = (index, role) => {
  const candidates =
    index.packageKind === "source-hardened-pair"
      ? index.artifacts.filter((entry) => entry.releaseRole === role)
      : index.packageKind === "legacy-bootstrap-single" &&
          index.artifact.releaseRole === role
        ? [index.artifact]
        : [];
  if (candidates.length !== 1) {
    throw new Error(`Release package has no unambiguous ${role} artifact`);
  }
  return candidates[0];
};

const secretValues = (environment) =>
  Object.entries(environment ?? {})
    .filter(
      ([name, value]) =>
        SECRET_NAME_PATTERN.test(name) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => Buffer.from(value, "utf8"));

const assertNoSecretBytes = (bytes, secrets, label) => {
  if (secrets.some((secret) => bytes.includes(secret))) {
    throw new Error(`${label} contains a protected secret value`);
  }
};

const assertFreshDate = (value, policy, nowMilliseconds, label) => {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    nowMilliseconds - timestamp >
      policy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    timestamp - nowMilliseconds >
      policy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(`${label} is stale, future, or invalid`);
  }
  return timestamp;
};

const assertImmutableDeploymentUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Deployment receipt URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      url.hostname,
    )
  ) {
    throw new Error("Deployment receipt URL is not an immutable HTTPS origin");
  }
  return `https://${url.hostname.toLowerCase()}`;
};

const assertReferenceShape = (value, label) => {
  assertExactKeys(value, ["sha256", "uri"], label);
  if (!SHA256_PATTERN.test(value.sha256) || typeof value.uri !== "string") {
    throw new Error(`${label} is invalid`);
  }
};

const parseDeploymentReceipt = ({
  bytes,
  index,
  artifactReference,
  manifest,
  providerObservation,
  providerPolicy,
  toolchainPolicy,
  nowMilliseconds,
}) => {
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error("Prebuilt deployment receipt is oversized");
  }
  const receipt = parseCanonicalJson(bytes, "Prebuilt deployment receipt");
  assertExactKeys(receipt, DEPLOYMENT_RECEIPT_KEYS, "Deployment receipt");
  assertExactKeys(
    receipt.archive,
    ["sha256", "size", "uri"],
    "Deployment receipt archive",
  );
  assertReferenceShape(receipt.manifest, "Deployment receipt manifest");
  assertExactKeys(
    receipt.productionBinding,
    [
      "providerConfigurationHash",
      "providerObservationSha256",
      "providerPolicySha256",
      "verified",
    ],
    "Deployment receipt production binding",
  );
  assertExactKeys(
    receipt.deployment,
    ["id", "projectId", "readyState", "target", "teamId", "url"],
    "Deployment receipt provider deployment",
  );
  assertExactKeys(
    receipt.authoritativeRequest,
    ["date", "etag", "responseSha256", "status", "url"],
    "Deployment receipt authoritative request",
  );
  assertExactKeys(
    receipt.cli,
    ["operation", "package", "version"],
    "Deployment receipt CLI",
  );
  const deploymentUrl = assertImmutableDeploymentUrl(receipt.deployment.url);
  const expectedRequest = new URL(
    `/v13/deployments/${encodeURIComponent(new URL(deploymentUrl).hostname)}`,
    "https://api.vercel.com",
  );
  expectedRequest.searchParams.set("teamId", providerPolicy.expectedTeamId);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== "vercel-prebuilt-deployment-v1" ||
    receipt.provider !== "vercel" ||
    typeof receipt.idempotencyKey !== "string" ||
    receipt.idempotencyKey.length < 16 ||
    receipt.sourceSha !== index.sourceSha ||
    receipt.sourceSha !== manifest.sourceSha ||
    receipt.variantId !== artifactReference.variantId ||
    receipt.variantId !== manifest.variantId ||
    receipt.releaseRole !== artifactReference.releaseRole ||
    receipt.releaseRole !== manifest.releaseRole ||
    receipt.packageIndexSha256 !== sha256Json(index) ||
    receipt.manifest.uri !== artifactReference.manifest.uri ||
    receipt.manifest.sha256 !== artifactReference.manifest.sha256 ||
    receipt.archive.uri !== artifactReference.archive.uri ||
    receipt.archive.sha256 !== artifactReference.archive.sha256 ||
    !Number.isSafeInteger(receipt.archive.size) ||
    receipt.archive.size < 1 ||
    receipt.productionBinding.verified !== true ||
    receipt.productionBinding.providerConfigurationHash !==
      providerConfigurationHash(providerObservation) ||
    receipt.productionBinding.providerObservationSha256 !==
      sha256Json(providerObservation) ||
    receipt.productionBinding.providerPolicySha256 !==
      sha256Json(providerPolicy) ||
    typeof receipt.deployment.id !== "string" ||
    receipt.deployment.id.length < 1 ||
    receipt.deployment.id.length > 255 ||
    receipt.deployment.projectId !== providerPolicy.expectedProjectId ||
    receipt.deployment.teamId !== providerPolicy.expectedTeamId ||
    receipt.deployment.target !== "production" ||
    receipt.deployment.readyState !== "READY" ||
    receipt.deployment.url !== deploymentUrl ||
    receipt.authoritativeRequest.url !== expectedRequest.href ||
    receipt.authoritativeRequest.status !== 200 ||
    typeof receipt.authoritativeRequest.etag !== "string" ||
    receipt.authoritativeRequest.etag.length < 1 ||
    !SHA256_PATTERN.test(receipt.authoritativeRequest.responseSha256) ||
    receipt.cli.package !== "vercel" ||
    receipt.cli.version !== toolchainPolicy.packages?.vercel ||
    receipt.cli.operation !== "deploy-prebuilt-prod-skip-domain"
  ) {
    throw new Error("Prebuilt deployment receipt binding differs");
  }
  assertFreshDate(
    receipt.authoritativeRequest.date,
    providerPolicy,
    nowMilliseconds,
    "Deployment receipt provider Date",
  );
  return receipt;
};

const assertPackageBindings = ({
  verified,
  index,
  indexBytes,
  manifest,
  artifactReference,
  role,
  releasePolicy,
  providerPolicy,
  providerObservation,
}) => {
  const indexHash = sha256Bytes(indexBytes);
  const stableConfigurationHash =
    providerConfigurationHash(providerObservation);
  if (
    verified?.productionEligible !== true ||
    verified.packageIndexSha256 !== indexHash ||
    !sameCanonicalValue(verified.index, index) ||
    artifactReference.releaseRole !== role ||
    artifactReference.variantId !== manifest.variantId ||
    manifest.releaseRole !== role ||
    manifest.sourceSha !== index.sourceSha ||
    manifest.buildId !== index.buildId ||
    manifest.providerConfigurationHash !== stableConfigurationHash ||
    index.providerConfigurationHash !== stableConfigurationHash ||
    manifest.providerPolicyHash !== sha256Json(providerPolicy) ||
    index.providerPolicyHash !== sha256Json(providerPolicy) ||
    manifest.releasePolicyHash !== sha256Json(releasePolicy) ||
    index.releasePolicyHash !== sha256Json(releasePolicy) ||
    !sameCanonicalValue(
      manifest.requiredDbCompatibility,
      index.requiredDbCompatibility,
    )
  ) {
    throw new Error(
      "Production verifier, package index, manifest, or policy binding differs",
    );
  }
  return { indexHash, stableConfigurationHash };
};

const assertSafePublicPath = (publicPath) => {
  if (
    typeof publicPath !== "string" ||
    publicPath.length === 0 ||
    publicPath.length > 2048 ||
    !PUBLIC_PATH_PATTERN.test(publicPath) ||
    [...publicPath].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(publicPath) ||
    publicPath.includes("//")
  ) {
    throw new Error(`Public route path is unsafe or aliased: ${publicPath}`);
  }
  return publicPath;
};

const securityHeaderProjection = (headers) =>
  Object.fromEntries(
    SECURITY_HEADER_NAMES.map((name) => [name, headers.get(name)]),
  );

const expectedSecurityHeaders = (manifest, cspPolicy) => {
  if (manifest.publicIdentityKind !== "release-identity-v1") return {};
  return Object.fromEntries(
    Object.entries(
      renderCspHeaders({
        cspMode: manifest.dimensions.cspMode,
        cspPolicy,
      }),
    ).map(([name, value]) => [name.toLowerCase(), value]),
  );
};

const assertHsts = (header, providerPolicy) => {
  if (providerPolicy.hstsOwner !== "provider") return;
  const directives =
    typeof header === "string"
      ? header
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  const maximumAge = Number(
    directives
      .find((value) => /^max-age=/i.test(value))
      ?.slice("max-age=".length),
  );
  if (
    !Number.isSafeInteger(maximumAge) ||
    maximumAge < providerPolicy.hstsPolicy.minimumMaxAgeSeconds ||
    (providerPolicy.hstsPolicy.requireIncludeSubDomains &&
      !directives.some((value) => /^includesubdomains$/i.test(value))) ||
    (providerPolicy.hstsPolicy.requirePreload &&
      !directives.some((value) => /^preload$/i.test(value)))
  ) {
    throw new Error("Immutable deployment HSTS response differs from policy");
  }
};

const expectedCacheControl = (manifest, publicPath) => {
  if (manifest.publicIdentityKind !== "release-identity-v1") return null;
  if (publicPath === "/sw.js") {
    return "public, max-age=0, must-revalidate";
  }
  if (publicPath === "/release-identity.json") {
    return "private, no-store";
  }
  if (
    publicPath ===
    `/release-identity.${manifest.sourceSha}.${manifest.variantId}.json`
  ) {
    return "public, max-age=31536000, immutable";
  }
  return null;
};

const assertContentType = (publicPath, contentType) => {
  const expected =
    publicPath === "/"
      ? "text/html"
      : publicPath.endsWith(".json")
        ? "application/json"
        : publicPath.endsWith(".js")
          ? "javascript"
          : null;
  if (
    expected !== null &&
    (typeof contentType !== "string" ||
      !contentType.toLowerCase().includes(expected))
  ) {
    throw new Error(`Public route content type differs: ${publicPath}`);
  }
};

const readBoundedHttpBody = async (response, publicPath) => {
  const declared = response.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_ROUTE_RESPONSE_BYTES)
  ) {
    throw new Error(`Public route response is oversized: ${publicPath}`);
  }
  let bytes;
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new Error(
            `Public route response stream is invalid: ${publicPath}`,
          );
        }
        byteLength += value.byteLength;
        if (byteLength > MAX_ROUTE_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`Public route response is oversized: ${publicPath}`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    bytes = Buffer.concat(chunks, byteLength);
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length > MAX_ROUTE_RESPONSE_BYTES) {
    throw new Error(`Public route response is oversized: ${publicPath}`);
  }
  return bytes;
};

const probeOneRoute = async ({
  deploymentUrl,
  publicPath,
  expectedHash,
  manifest,
  providerPolicy,
  cspPolicy,
  fetchImpl,
  nowMilliseconds,
  secrets,
}) => {
  assertSafePublicPath(publicPath);
  if (!SHA256_PATTERN.test(expectedHash)) {
    throw new Error(`Public route hash is invalid: ${publicPath}`);
  }
  const requestUrl = new URL(publicPath, `${deploymentUrl}/`).href;
  if (requestUrl !== `${deploymentUrl}${publicPath}`) {
    throw new Error(
      `Public route resolves through a path alias: ${publicPath}`,
    );
  }
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Immutable deployment probe failed: ${publicPath}`);
  }
  if (
    !response ||
    response.status !== 200 ||
    typeof response.arrayBuffer !== "function" ||
    response.url !== requestUrl ||
    response.redirected === true
  ) {
    throw new Error(
      `Immutable deployment route is partial or aliased: ${publicPath}`,
    );
  }
  const bytes = await readBoundedHttpBody(response, publicPath);
  assertNoSecretBytes(bytes, secrets, `Public route ${publicPath}`);
  if (sha256Bytes(bytes) !== expectedHash) {
    throw new Error(`Public route body hash differs: ${publicPath}`);
  }
  const responseDate = response.headers.get("date");
  assertFreshDate(
    responseDate,
    providerPolicy,
    nowMilliseconds,
    `Public route Date ${publicPath}`,
  );
  const contentType = response.headers.get("content-type");
  assertContentType(publicPath, contentType);
  const cacheControl = response.headers.get("cache-control");
  const expectedCache = expectedCacheControl(manifest, publicPath);
  if (expectedCache !== null && cacheControl !== expectedCache) {
    throw new Error(`Public route cache policy differs: ${publicPath}`);
  }
  const securityHeaders = securityHeaderProjection(response.headers);
  const expectedHeaders = expectedSecurityHeaders(manifest, cspPolicy);
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    if (response.headers.get(name) !== expected) {
      throw new Error(`Public route security header differs: ${publicPath}`);
    }
  }
  for (const name of CSP_HEADER_NAMES.map((value) => value.toLowerCase())) {
    if (
      !Object.hasOwn(expectedHeaders, name) &&
      response.headers.get(name) !== null
    ) {
      throw new Error(`Public route has an inactive CSP header: ${publicPath}`);
    }
  }
  assertHsts(securityHeaders["strict-transport-security"], providerPolicy);
  return {
    bytes,
    evidence: {
      path: publicPath,
      requestUrl,
      responseUrl: response.url,
      status: response.status,
      responseDate: new Date(Date.parse(responseDate)).toISOString(),
      etag: response.headers.get("etag"),
      contentType,
      cacheControl,
      securityHeaders,
      bodySha256: expectedHash,
      byteLength: bytes.length,
    },
  };
};

const parseRuntimeHtmlIdentity = (bytes, index) => {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const values = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map();
    for (const attribute of match[0].matchAll(
      /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3]);
    }
    const name = attributes.get("name");
    if (
      name === "event-shopping-planner-build-id" ||
      name === "event-shopping-planner-source-sha"
    ) {
      if (values.has(name)) {
        throw new Error(`Runtime HTML contains duplicate ${name} metadata`);
      }
      values.set(name, attributes.get("content"));
    }
  }
  const identity = {
    buildId: values.get("event-shopping-planner-build-id"),
    sourceSha: values.get("event-shopping-planner-source-sha"),
  };
  if (
    identity.buildId !== index.buildId ||
    identity.sourceSha !== index.sourceSha
  ) {
    throw new Error("Runtime HTML source metadata differs from package");
  }
  return identity;
};

const parseCapability = (
  bytes,
  manifest,
  expectedBuildPurpose = "production",
) => {
  const capability = parseCanonicalJson(bytes, "Deployed release capability");
  const expectedNonPromotable = expectedBuildPurpose !== "production";
  if (
    capability.kind !== "event-shopping-planner-release-capabilities" ||
    capability.version !== 1 ||
    capability.buildId !== manifest.buildId ||
    capability.sourceSha !== manifest.sourceSha ||
    capability.sourceState !== "clean" ||
    capability.releaseChannel !== "release-a" ||
    capability.legacyLocalStorageCleanup !== "forced-off" ||
    (capability.nonPromotable === true) !== expectedNonPromotable ||
    (capability.buildPurpose ?? "production") !== expectedBuildPurpose
  ) {
    throw new Error("Deployed release capability differs from manifest");
  }
  return capability;
};

const derivePublicIdentity = async ({
  manifest,
  index,
  packageRoot,
  routeResults,
  probeAdditionalRoute,
  expectedBuildPurpose,
}) => {
  const rootResult = routeResults.get("/");
  const capabilityResult = routeResults.get("/release-capabilities.json");
  const serviceWorkerResult = routeResults.get("/sw.js");
  if (!rootResult || !capabilityResult || !serviceWorkerResult) {
    throw new Error("Required public identity routes are incomplete");
  }
  const runtimeHtmlIdentity = parseRuntimeHtmlIdentity(rootResult.bytes, index);
  parseCapability(capabilityResult.bytes, manifest, expectedBuildPurpose);
  if (manifest.publicIdentityKind === "release-identity-v1") {
    const identityResult = routeResults.get("/release-identity.json");
    if (!identityResult) {
      throw new Error("Stable deployed ReleaseIdentity is absent");
    }
    const identity = parseCanonicalJson(
      identityResult.bytes,
      "Deployed ReleaseIdentity",
    );
    const outputFilesByPath = new Map(
      manifest.outputFiles.map((file) => [file.path, file]),
    );
    assertReleaseIdentity(identity, {
      manifest,
      outputFilesByPath,
      expectedBuildPurpose,
    });
    for (const [key, publicPath] of Object.entries(identity).filter(([key]) =>
      key.endsWith("Url"),
    )) {
      assertSafePublicPath(publicPath);
      const hashKey = `${key.slice(0, -"Url".length)}Sha256`;
      const output = outputFilesByPath.get(publicPathToOutputPath(publicPath));
      if (!output || output.sha256 !== identity[hashKey]) {
        throw new Error(`ReleaseIdentity route differs: ${key}`);
      }
      await probeAdditionalRoute(publicPath, identity[hashKey]);
    }
    return {
      publicIdentity: {
        identityKind: "release-identity-v1",
        identity,
        identitySha256: sha256Bytes(identityResult.bytes),
      },
      runtimeHtmlIdentity,
    };
  }

  const rawDistObject = await readPackageObject({
    packageRoot,
    reference: index.rawDistManifest,
    expectedKind: "raw-dist-manifest.json",
    maximumBytes: MAX_MANIFEST_BYTES,
    label: "Raw dist manifest",
  });
  const rawDistManifest = parseCanonicalJson(
    rawDistObject.bytes,
    "Raw dist manifest",
  );
  if (
    rawDistManifest.schemaVersion !== 1 ||
    !SHA256_PATTERN.test(rawDistManifest.treeSha256) ||
    manifest.bootstrap?.inputUri !== index.bootstrapInput.uri ||
    manifest.bootstrap?.inputSha256 !== index.bootstrapInput.sha256 ||
    manifest.bootstrap?.rawDistManifestUri !== index.rawDistManifest.uri ||
    manifest.bootstrap?.rawDistManifestSha256 !== index.rawDistManifest.sha256
  ) {
    throw new Error("Legacy bootstrap immutable identity differs");
  }
  return {
    publicIdentity: {
      identityKind: "legacy-bootstrap-v1",
      sourceSha: index.sourceSha,
      buildId: index.buildId,
      sourceState: "clean",
      capabilitySha256: sha256Bytes(capabilityResult.bytes),
      htmlMetaSha256: sha256Json(runtimeHtmlIdentity),
      serviceWorkerSha256: sha256Bytes(serviceWorkerResult.bytes),
      rawDistTreeSha256: rawDistManifest.treeSha256,
      rawDistManifestUri: index.rawDistManifest.uri,
      rawDistManifestSha256: index.rawDistManifest.sha256,
      bootstrapInputUri: index.bootstrapInput.uri,
      bootstrapInputSha256: index.bootstrapInput.sha256,
    },
    runtimeHtmlIdentity,
  };
};

export const probeImmutableDeployment = async ({
  deploymentUrl,
  manifest,
  index,
  packageRoot,
  providerPolicy,
  cspPolicy,
  fetchImpl,
  nowMilliseconds,
  secrets,
  expectedBuildPurpose = "production",
}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Immutable deployment fetch is unavailable");
  }
  const declared = Object.entries(manifest.publicResponseHashes);
  if (declared.length < 3 || declared.length > MAX_PUBLIC_ROUTES) {
    throw new Error(
      "Manifest public route declaration is partial or oversized",
    );
  }
  const routeResults = new Map();
  let totalBytes = 0;
  const probeAdditionalRoute = async (publicPath, expectedHash) => {
    const existing = routeResults.get(publicPath);
    if (existing) {
      if (sha256Bytes(existing.bytes) !== expectedHash) {
        throw new Error(`Public route has conflicting hashes: ${publicPath}`);
      }
      return existing;
    }
    if (routeResults.size >= MAX_PUBLIC_ROUTES) {
      throw new Error("Public route probe count exceeds its ceiling");
    }
    const result = await probeOneRoute({
      deploymentUrl,
      publicPath,
      expectedHash,
      manifest,
      providerPolicy,
      cspPolicy,
      fetchImpl,
      nowMilliseconds,
      secrets,
    });
    totalBytes += result.bytes.length;
    if (totalBytes > MAX_TOTAL_ROUTE_BYTES) {
      throw new Error("Public route probe bytes exceed their total ceiling");
    }
    routeResults.set(publicPath, result);
    return result;
  };
  for (const [publicPath, expectedHash] of [...declared].sort(
    ([left], [right]) => compareUtf8(left, right),
  )) {
    await probeAdditionalRoute(publicPath, expectedHash);
  }
  const identity = await derivePublicIdentity({
    manifest,
    index,
    packageRoot,
    routeResults,
    probeAdditionalRoute,
    expectedBuildPurpose,
  });
  return {
    routes: [...routeResults.values()]
      .map(({ evidence }) => evidence)
      .sort((left, right) => compareUtf8(left.path, right.path)),
    publicIdentity: identity.publicIdentity,
    runtimeHtmlIdentity: identity.runtimeHtmlIdentity,
  };
};

const immutableReferenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const putVerifiedEvidenceWithReceipt = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const expected = immutableReferenceFor(namespace, bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== expected.uri ||
    receipt?.sha256 !== expected.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    !Number.isFinite(Date.parse(receipt.committedAt)) ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt differs`);
  }
  const stored = await assertEvidenceObjectAvailable({
    store,
    reference: expected,
    namespace,
    label,
  });
  if (!stored.bytes.equals(bytes) || stored.mediaType !== mediaType) {
    throw new Error(`${label} immutable-store replay differs`);
  }
  return { reference: expected, receipt: structuredClone(receipt) };
};

const putVerifiedEvidence = async (options) =>
  (await putVerifiedEvidenceWithReceipt(options)).reference;

const assertEnvironmentPresence = (observation, policy, cspMode) => {
  const receipt = observation.evidenceReceipts.filter(
    (candidate) => candidate.kind === "environment-presence",
  );
  const present = [...observation.presentEnvironmentNames].sort(compareUtf8);
  const environmentContract = resolveProviderEnvironmentContract(
    policy,
    cspMode,
  );
  const required = [...environmentContract.requiredEnvironmentNames].sort(
    compareUtf8,
  );
  const forbidden = [...environmentContract.forbiddenEnvironmentNames].sort(
    compareUtf8,
  );
  if (
    receipt.length !== 1 ||
    required.some((name) => !present.includes(name)) ||
    forbidden.some((name) => present.includes(name))
  ) {
    throw new Error("Provider environment-presence evidence is incomplete");
  }
  return { receipt: receipt[0], present, required, forbidden };
};

const assertProviderDeploymentEvidence = (evidence) => {
  assertExactKeys(
    evidence,
    PROVIDER_EVIDENCE_KEYS,
    "ProviderDeploymentEvidence",
  );
  if (
    evidence.schemaVersion !== 1 ||
    !SOURCE_SHA_PATTERN.test(evidence.sourceSha) ||
    !SHA256_PATTERN.test(evidence.variantId) ||
    !ROLES.has(evidence.releaseRole) ||
    !SHA256_PATTERN.test(evidence.artifactManifestHash) ||
    !SHA256_PATTERN.test(evidence.packageIndexHash) ||
    !SHA256_PATTERN.test(evidence.providerConfigurationHash) ||
    !SHA256_PATTERN.test(evidence.providerPolicyHash) ||
    !SHA256_PATTERN.test(evidence.releasePolicyHash) ||
    !SHA256_PATTERN.test(evidence.routeProbeEvidenceHash) ||
    !SHA256_PATTERN.test(evidence.environmentPresenceEvidenceHash)
  ) {
    throw new Error("ProviderDeploymentEvidence identity is invalid");
  }
  const publicIdentityKeys =
    evidence.publicIdentity?.identityKind === "release-identity-v1"
      ? ["identity", "identityKind", "identitySha256"]
      : [
          "bootstrapInputSha256",
          "bootstrapInputUri",
          "buildId",
          "capabilitySha256",
          "htmlMetaSha256",
          "identityKind",
          "rawDistManifestSha256",
          "rawDistManifestUri",
          "rawDistTreeSha256",
          "serviceWorkerSha256",
          "sourceSha",
          "sourceState",
        ];
  assertExactKeys(
    evidence.publicIdentity,
    publicIdentityKeys,
    "ProviderDeploymentEvidence public identity",
  );
  if (evidence.publicIdentity.identityKind === "release-identity-v1") {
    if (
      evidence.publicIdentity.identity === null ||
      typeof evidence.publicIdentity.identity !== "object" ||
      Array.isArray(evidence.publicIdentity.identity) ||
      !SHA256_PATTERN.test(evidence.publicIdentity.identitySha256)
    ) {
      throw new Error("ProviderDeploymentEvidence ReleaseIdentity is invalid");
    }
  } else if (
    evidence.publicIdentity.identityKind !== "legacy-bootstrap-v1" ||
    !SOURCE_SHA_PATTERN.test(evidence.publicIdentity.sourceSha) ||
    evidence.publicIdentity.buildId !== evidence.publicIdentity.sourceSha ||
    evidence.publicIdentity.sourceState !== "clean" ||
    !SHA256_PATTERN.test(evidence.publicIdentity.capabilitySha256) ||
    !SHA256_PATTERN.test(evidence.publicIdentity.htmlMetaSha256) ||
    !SHA256_PATTERN.test(evidence.publicIdentity.serviceWorkerSha256) ||
    !SHA256_PATTERN.test(evidence.publicIdentity.rawDistTreeSha256) ||
    !SHA256_PATTERN.test(evidence.publicIdentity.rawDistManifestSha256) ||
    !SHA256_PATTERN.test(evidence.publicIdentity.bootstrapInputSha256)
  ) {
    throw new Error(
      "ProviderDeploymentEvidence legacy public identity is invalid",
    );
  }
  return evidence;
};

export const produceDeploymentBinding = async (
  options,
  {
    productionVerifier = verifyReleasePackage,
    providerObservationValidator = assertVercelObservationEvidence,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {},
) => {
  if (
    options === null ||
    typeof options !== "object" ||
    ["binding", "providerEvidence", "routeProbeEvidence"].some((field) =>
      Object.hasOwn(options, field),
    )
  ) {
    throw new Error("Caller-supplied deployment authority is forbidden");
  }
  const {
    packageRoot,
    role,
    deploymentReceiptBytes: suppliedReceiptBytes,
    providerObservationBytes: suppliedObservationBytes,
    namespace,
    store,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    dbContract,
    cspPolicy,
    root = repositoryRoot,
    environment = process.env,
  } = options;
  assertStore(store, namespace);
  const selectedRole = assertRole(role);
  const nowMilliseconds =
    typeof now === "function" ? Number(now()) : Number(now);
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Deployment binding producer clock is invalid");
  }
  const deploymentReceiptBytes = Buffer.from(suppliedReceiptBytes ?? "");
  const providerObservationBytes = Buffer.from(suppliedObservationBytes ?? "");
  if (
    deploymentReceiptBytes.length < 1 ||
    deploymentReceiptBytes.length > MAX_RECEIPT_BYTES
  ) {
    throw new Error("Prebuilt deployment receipt is empty or oversized");
  }
  if (
    providerObservationBytes.length < 1 ||
    providerObservationBytes.length > MAX_PROVIDER_OBSERVATION_BYTES
  ) {
    throw new Error("Provider observation is empty or oversized");
  }
  const secrets = secretValues(environment);
  assertNoSecretBytes(
    deploymentReceiptBytes,
    secrets,
    "Prebuilt deployment receipt",
  );
  assertNoSecretBytes(
    providerObservationBytes,
    secrets,
    "Provider observation",
  );
  const providerObservation = parseCanonicalJson(
    providerObservationBytes,
    "Fresh provider observation",
  );
  providerObservationValidator(
    providerObservation,
    providerPolicy,
    nowMilliseconds,
  );
  const resolvedPackageRoot = await assertSafePackageRoot(packageRoot);

  const verified = await productionVerifier({
    packageRoot: resolvedPackageRoot,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    cspPolicy,
    requireProductionBindings: true,
    root,
    environment,
  });

  const indexPath = path.join(
    resolvedPackageRoot,
    "release-package-index.json",
  );
  const indexBytes = await readBoundedRegularFile(
    indexPath,
    MAX_INDEX_BYTES,
    "Release package index",
  );
  const index = parseCanonicalJson(indexBytes, "Release package index");
  assertReleasePackageIndex(index);
  const artifactReference = selectArtifactReference(index, selectedRole);
  const manifestObject = await readPackageObject({
    packageRoot: resolvedPackageRoot,
    reference: artifactReference.manifest,
    expectedKind: "artifact-manifest.json",
    maximumBytes: MAX_MANIFEST_BYTES,
    label: "Selected artifact manifest",
  });
  const manifest = parseCanonicalJson(
    manifestObject.bytes,
    "Selected artifact manifest",
  );
  assertArtifactManifest(manifest, releasePolicy);
  const { indexHash, stableConfigurationHash } = assertPackageBindings({
    verified,
    index,
    indexBytes,
    manifest,
    artifactReference,
    role: selectedRole,
    releasePolicy,
    providerPolicy,
    providerObservation,
  });
  const deploymentReceipt = parseDeploymentReceipt({
    bytes: deploymentReceiptBytes,
    index,
    artifactReference,
    manifest,
    providerObservation,
    providerPolicy,
    toolchainPolicy,
    nowMilliseconds,
  });
  const archiveObject = await readPackageObject({
    packageRoot: resolvedPackageRoot,
    reference: artifactReference.archive,
    expectedKind: "artifact.zip",
    maximumBytes: MAX_ARCHIVE_BYTES,
    label: "Selected artifact archive",
  });
  if (archiveObject.bytes.length !== deploymentReceipt.archive.size) {
    throw new Error("Selected artifact archive size differs from receipt");
  }
  const deploymentUrl = deploymentReceipt.deployment.url;
  const probe = await probeImmutableDeployment({
    deploymentUrl,
    manifest,
    index,
    packageRoot: resolvedPackageRoot,
    providerPolicy,
    cspPolicy,
    fetchImpl,
    nowMilliseconds,
    secrets,
  });
  const environmentPresence = assertEnvironmentPresence(
    providerObservation,
    providerPolicy,
    manifest.dimensions.cspMode,
  );

  const releasePolicyBytes = canonicalJsonBytes(releasePolicy);
  const providerPolicyBytes = canonicalJsonBytes(providerPolicy);
  const cspPolicyBytes = canonicalJsonBytes(cspPolicy);
  const receiptReference = immutableReferenceFor(
    namespace,
    deploymentReceiptBytes,
  );
  const providerObservationReference = immutableReferenceFor(
    namespace,
    providerObservationBytes,
  );
  const cspPolicyReference = immutableReferenceFor(namespace, cspPolicyBytes);
  const routeProbeBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "immutable-deployment-route-probe/v1",
    namespace,
    providerProjectId: deploymentReceipt.deployment.projectId,
    providerDeploymentId: deploymentReceipt.deployment.id,
    deploymentUrl,
    observedAt: new Date(nowMilliseconds).toISOString(),
    deploymentReceipt: receiptReference,
    cspPolicy: cspPolicyReference,
    runtimeHtmlIdentity: probe.runtimeHtmlIdentity,
    routes: probe.routes,
  });
  const routeProbeReference = immutableReferenceFor(namespace, routeProbeBytes);
  const environmentPresenceBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "provider-environment-presence/v1",
    namespace,
    providerProjectId: providerObservation.providerProjectId,
    providerTeamId: providerObservation.providerTeamId,
    productionEnvironmentName: providerObservation.productionEnvironmentName,
    observedAt: providerObservation.observedAt,
    providerConfigurationHash: stableConfigurationHash,
    providerObservation: providerObservationReference,
    presentEnvironmentNames: environmentPresence.present,
    requiredEnvironmentNames: environmentPresence.required,
    forbiddenEnvironmentNames: environmentPresence.forbidden,
    receipt: environmentPresence.receipt,
  });
  const environmentPresenceReference = immutableReferenceFor(
    namespace,
    environmentPresenceBytes,
  );
  const providerEvidence = assertProviderDeploymentEvidence({
    schemaVersion: 1,
    providerProjectId: deploymentReceipt.deployment.projectId,
    providerDeploymentId: deploymentReceipt.deployment.id,
    deploymentUrl,
    sourceSha: index.sourceSha,
    variantId: artifactReference.variantId,
    releaseRole: selectedRole,
    artifactManifestHash: artifactReference.manifest.sha256,
    packageIndexHash: indexHash,
    providerConfigurationHash: stableConfigurationHash,
    providerPolicyHash: sha256Bytes(providerPolicyBytes),
    releasePolicyHash: sha256Bytes(releasePolicyBytes),
    requiredDbCompatibility: index.requiredDbCompatibility,
    publicIdentity: probe.publicIdentity,
    routeProbeEvidenceHash: routeProbeReference.sha256,
    environmentPresenceEvidenceHash: environmentPresenceReference.sha256,
  });
  const providerEvidenceBytes = canonicalJsonBytes(providerEvidence);
  const providerEvidenceReference = immutableReferenceFor(
    namespace,
    providerEvidenceBytes,
  );
  const packageIndexReference = immutableReferenceFor(namespace, indexBytes);
  const artifactManifestReference = immutableReferenceFor(
    namespace,
    manifestObject.bytes,
  );
  const releasePolicyReference = immutableReferenceFor(
    namespace,
    releasePolicyBytes,
  );
  const providerPolicyReference = immutableReferenceFor(
    namespace,
    providerPolicyBytes,
  );
  const artifactArchiveReference = immutableReferenceFor(
    namespace,
    archiveObject.bytes,
  );
  const bindingId =
    "deployment-binding:" +
    sha256Json({
      namespace,
      providerProjectId: providerEvidence.providerProjectId,
      providerDeploymentId: providerEvidence.providerDeploymentId,
      sourceSha: index.sourceSha,
      variantId: artifactReference.variantId,
      releaseRole: selectedRole,
      artifactArchiveSha256: artifactArchiveReference.sha256,
    });
  assertNoSecretBytes(
    archiveObject.bytes,
    secrets,
    "Selected artifact archive",
  );
  const artifactArchiveStorage = await putVerifiedEvidenceWithReceipt({
    store,
    namespace,
    bytes: archiveObject.bytes,
    mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
    label: "Selected artifact archive",
  });
  const artifactArchiveAvailability = {
    schemaVersion: 1,
    evidenceKind: "artifact-archive-availability/v1",
    availability: "available",
    namespace,
    bindingId,
    sourceSha: index.sourceSha,
    variantId: artifactReference.variantId,
    releaseRole: selectedRole,
    artifactManifest: artifactManifestReference,
    artifactArchive: {
      uri: artifactArchiveStorage.reference.uri,
      sha256: artifactArchiveStorage.reference.sha256,
      mediaType: artifactArchiveStorage.receipt.mediaType,
      byteLength: artifactArchiveStorage.receipt.byteLength,
      committedAt: artifactArchiveStorage.receipt.committedAt,
    },
  };
  const artifactArchiveAvailabilityBytes = canonicalJsonBytes(
    artifactArchiveAvailability,
  );
  const artifactArchiveAvailabilityReference = immutableReferenceFor(
    namespace,
    artifactArchiveAvailabilityBytes,
  );
  const binding = {
    bindingId,
    sourceSha: index.sourceSha,
    buildId: index.buildId,
    variantId: artifactReference.variantId,
    releaseRole: selectedRole,
    publicIdentityKind: manifest.publicIdentityKind,
    providerProjectId: providerEvidence.providerProjectId,
    providerDeploymentId: providerEvidence.providerDeploymentId,
    deploymentUrl,
    artifactArchive: artifactArchiveReference,
    artifactArchiveAvailability: artifactArchiveAvailabilityReference,
    packageIndex: packageIndexReference,
    artifactManifest: artifactManifestReference,
    providerEvidence: providerEvidenceReference,
    releasePolicy: releasePolicyReference,
    providerPolicy: providerPolicyReference,
    providerConfigurationHash: stableConfigurationHash,
    requiredDbCompatibility: index.requiredDbCompatibility,
  };
  assertDeploymentBinding(binding, {
    namespace,
    expectedRole: selectedRole,
    allowLegacyBootstrap: true,
    label: "Produced DeploymentBinding",
  });
  const bindingBytes = canonicalJsonBytes(binding);
  const bootstrapObjects = [];
  if (index.packageKind === "legacy-bootstrap-single") {
    const [bootstrapInputObject, rawDistManifestObject] = await Promise.all([
      readPackageObject({
        packageRoot: resolvedPackageRoot,
        reference: index.bootstrapInput,
        expectedKind: "bootstrap-input.json",
        maximumBytes: MAX_MANIFEST_BYTES,
        label: "Bootstrap input",
      }),
      readPackageObject({
        packageRoot: resolvedPackageRoot,
        reference: index.rawDistManifest,
        expectedKind: "raw-dist-manifest.json",
        maximumBytes: MAX_MANIFEST_BYTES,
        label: "Raw dist manifest",
      }),
    ]);
    parseCanonicalJson(bootstrapInputObject.bytes, "Bootstrap input");
    parseCanonicalJson(rawDistManifestObject.bytes, "Raw dist manifest");
    bootstrapObjects.push(
      [
        bootstrapInputObject.bytes,
        "application/vnd.event-shopping-planner.bootstrap-input+json;version=1",
        "Bootstrap input",
      ],
      [
        rawDistManifestObject.bytes,
        "application/vnd.event-shopping-planner.raw-dist-manifest+json;version=1",
        "Raw dist manifest",
      ],
    );
  }
  const generatedObjects = [
    [
      deploymentReceiptBytes,
      "application/vnd.vercel.prebuilt-deployment-receipt+json;version=1",
      "Prebuilt deployment receipt",
    ],
    [
      providerObservationBytes,
      "application/vnd.event-shopping-planner.vercel-provider-observation+json;version=1",
      "Provider observation",
    ],
    [
      indexBytes,
      "application/vnd.event-shopping-planner.release-package-index+json;version=1",
      "Release package index",
    ],
    [
      manifestObject.bytes,
      "application/vnd.event-shopping-planner.artifact-manifest+json;version=1",
      "Selected artifact manifest",
    ],
    [
      releasePolicyBytes,
      "application/vnd.event-shopping-planner.release-policy+json;version=1",
      "Release policy",
    ],
    [
      providerPolicyBytes,
      "application/vnd.event-shopping-planner.provider-policy+json;version=1",
      "Provider policy",
    ],
    [
      cspPolicyBytes,
      "application/vnd.event-shopping-planner.csp-policy+json;version=1",
      "CSP policy",
    ],
    [
      routeProbeBytes,
      "application/vnd.event-shopping-planner.immutable-route-probe+json;version=1",
      "Immutable route probe",
    ],
    [
      environmentPresenceBytes,
      "application/vnd.event-shopping-planner.environment-presence+json;version=1",
      "Environment presence",
    ],
    [
      providerEvidenceBytes,
      "application/vnd.event-shopping-planner.provider-deployment-evidence+json;version=1",
      "Provider deployment evidence",
    ],
    [
      artifactArchiveAvailabilityBytes,
      ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
      "Artifact archive availability receipt",
    ],
    [
      bindingBytes,
      "application/vnd.event-shopping-planner.deployment-binding+json;version=1",
      "Deployment binding",
    ],
    ...bootstrapObjects,
  ];
  for (const [bytes, , label] of generatedObjects) {
    assertNoSecretBytes(bytes, secrets, label);
  }
  const storedReferences = [];
  for (const [bytes, mediaType, label] of generatedObjects) {
    storedReferences.push([
      label,
      await putVerifiedEvidence({
        store,
        namespace,
        bytes,
        mediaType,
        label,
      }),
    ]);
  }
  await validateProviderEvidenceForBinding({
    store,
    namespace,
    binding,
    label: "Produced DeploymentBinding",
  });
  await assertArtifactArchiveAvailable({
    store,
    namespace,
    binding,
    label: "Produced DeploymentBinding",
  });
  for (const [, reference] of storedReferences) {
    await assertEvidenceObjectAvailable({
      store,
      reference,
      namespace,
      label: "Produced deployment evidence",
    });
  }
  const bindingReference = storedReferences.find(
    ([label]) => label === "Deployment binding",
  )[1];
  return {
    binding,
    bindingBytes,
    bindingSha256: sha256Bytes(bindingBytes),
    bindingReference,
    providerEvidence,
    providerEvidenceReference,
    routeProbeReference,
    environmentPresenceReference,
    deploymentReceiptReference: receiptReference,
    providerObservationReference,
    cspPolicyReference,
    artifactArchiveReference,
    artifactArchiveAvailabilityReference,
  };
};
