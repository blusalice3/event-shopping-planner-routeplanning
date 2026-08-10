import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { assertArtifactDrillBuildAuthority } from "../lib/artifact-drill-build-authority.mjs";
import { assertExactKeys } from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  BROWSER_PHASE_EXIT_WORKFLOW_PATH,
} from "../browser/production-request-graph.mjs";

export const ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-build-receipt+json;version=1";
export const ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-archive-receipt+json;version=1";
export const ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-preview-deployment-receipt+json;version=1";
export const ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-provider-observation+json;version=1";
export const ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-preview-assignment-receipt+json;version=1";
export const ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-preview-redeploy-receipt+json;version=1";
export const ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-preview-reconcile-receipt+json;version=1";
export const ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-provider-cleanup-receipt+json;version=1";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,255}$/u;
const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const PURPOSE = "non-promotable-artifact-drill";

const assertHash = (value, label) => {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} is invalid`);
};

const assertCanonicalHttpDate = (value, label) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toUTCString() !== value
  ) {
    throw new Error(`${label} is not a canonical HTTP date`);
  }
};

const assertHttpsOrigin = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !DOMAIN.test(parsed.hostname.toLowerCase())
  ) {
    throw new Error(`${label} is not an immutable HTTPS origin`);
  }
  return parsed;
};

export const assertArtifactDrillReceiptAuthority = (
  authority,
  expected = {},
) => {
  assertExactKeys(
    authority,
    [
      "collectorIdentity",
      "databaseEndpointSha256",
      "databasePolicySha256",
      "drillNamespace",
      "providerPolicySha256",
      "sourceSha",
      "toolchainSha256",
    ],
    "Artifact drill receipt authority",
  );
  assertBrowserPhaseExitCollectorIdentity(
    authority.collectorIdentity,
    authority.sourceSha,
  );
  if (
    authority.collectorIdentity.workflowPath !==
      BROWSER_PHASE_EXIT_WORKFLOW_PATH ||
    !SOURCE_SHA.test(authority.sourceSha ?? "") ||
    !NAMESPACE.test(authority.drillNamespace ?? "")
  ) {
    throw new Error("Artifact drill receipt authority identity is invalid");
  }
  for (const key of [
    "databaseEndpointSha256",
    "databasePolicySha256",
    "providerPolicySha256",
    "toolchainSha256",
  ]) {
    assertHash(authority[key], `Artifact drill authority ${key}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const differs =
      key === "collectorIdentity"
        ? !canonicalJsonBytes(authority[key]).equals(canonicalJsonBytes(value))
        : authority[key] !== value;
    if (differs) {
      throw new Error(`Artifact drill receipt authority ${key} differs`);
    }
  }
  return authority;
};

const assertBootstrapVerification = (value) => {
  assertExactKeys(
    value,
    [
      "artifactArchiveSha256",
      "artifactManifestSha256",
      "packageIndexSha256",
      "preserved",
      "rawDistFileCount",
      "rawDistManifestSha256",
      "rawDistTreeSha256",
      "releaseIdentityAbsent",
      "sourceSha",
    ],
    "Artifact drill bootstrap verification",
  );
  for (const key of [
    "packageIndexSha256",
    "artifactArchiveSha256",
    "artifactManifestSha256",
    "rawDistManifestSha256",
    "rawDistTreeSha256",
  ]) {
    assertHash(value[key], `Artifact drill bootstrap ${key}`);
  }
  if (value.preserved !== true || value.releaseIdentityAbsent !== true) {
    throw new Error("Artifact drill bootstrap raw-dist was not preserved");
  }
  if (
    !SOURCE_SHA.test(value.sourceSha ?? "") ||
    !Number.isSafeInteger(value.rawDistFileCount) ||
    value.rawDistFileCount < 1
  ) {
    throw new Error("Artifact drill bootstrap inventory is invalid");
  }
  return value;
};

const assertRoleBuild = (role) => {
  assertExactKeys(
    role,
    [
      "archiveSha256",
      "capabilitySha256",
      "dbFingerprint",
      "manifestSha256",
      "policySha256",
      "role",
    ],
    "Artifact drill receipt role",
  );
  if (!["containment", "standard"].includes(role.role)) {
    throw new Error("Artifact drill receipt role is invalid");
  }
  for (const key of [
    "archiveSha256",
    "capabilitySha256",
    "dbFingerprint",
    "manifestSha256",
    "policySha256",
  ]) {
    assertHash(role[key], `Artifact drill receipt role ${key}`);
  }
  return role;
};

export const assertArtifactDrillBuildReceipt = (receipt, expected = {}) => {
  assertExactKeys(
    receipt,
    [
      "attempt",
      "authority",
      "bootstrapVerification",
      "buildAuthority",
      "buildPurpose",
      "kind",
      "packageArchiveSha256",
      "packageIndexSha256",
      "roles",
      "schemaVersion",
    ],
    "Artifact drill build receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-build-receipt/v1" ||
    receipt.buildPurpose !== PURPOSE ||
    ![1, 2].includes(receipt.attempt) ||
    (expected.attempt !== undefined && receipt.attempt !== expected.attempt) ||
    !Array.isArray(receipt.roles) ||
    receipt.roles.length !== 2 ||
    receipt.roles.map(({ role }) => role).join(",") !== "containment,standard"
  ) {
    throw new Error("Artifact drill build receipt semantics are invalid");
  }
  assertExactKeys(
    receipt.buildAuthority,
    ["document", "reference"],
    "Artifact drill build authority receipt",
  );
  assertExactKeys(
    receipt.buildAuthority.reference,
    ["sha256", "uri"],
    "Artifact drill build authority reference",
  );
  assertArtifactDrillBuildAuthority(receipt.buildAuthority.document, {
    sourceSha: receipt.authority.sourceSha,
    bootstrapVerification: receipt.bootstrapVerification,
  });
  const buildAuthoritySha256 = sha256Bytes(
    canonicalJsonBytes(receipt.buildAuthority.document),
  );
  if (
    receipt.buildAuthority.reference.sha256 !== buildAuthoritySha256 ||
    receipt.buildAuthority.reference.uri !==
      `artifact://sha256/${buildAuthoritySha256}/artifact-drill-build-authority.json` ||
    receipt.buildAuthority.document.toolchainPolicySha256 !==
      receipt.authority.toolchainSha256 ||
    receipt.buildAuthority.document.providerPolicySha256 !==
      receipt.authority.providerPolicySha256
  ) {
    throw new Error("Artifact drill build authority receipt differs");
  }
  for (const key of ["packageArchiveSha256", "packageIndexSha256"]) {
    assertHash(receipt[key], `Artifact drill build ${key}`);
  }
  receipt.roles.forEach(assertRoleBuild);
  assertBootstrapVerification(receipt.bootstrapVerification);
  return receipt;
};

export const assertArtifactDrillArchiveReceipt = (receipt, expected = {}) => {
  assertExactKeys(
    receipt,
    [
      "authority",
      "bootstrapVerification",
      "capabilityVerified",
      "dbBindingVerified",
      "extractedManifestSha256",
      "kind",
      "manifestVerified",
      "policyBindingVerified",
      "schemaVersion",
    ],
    "Artifact drill archive receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-archive-receipt/v1" ||
    receipt.capabilityVerified !== true ||
    receipt.dbBindingVerified !== true ||
    receipt.manifestVerified !== true ||
    receipt.policyBindingVerified !== true
  ) {
    throw new Error("Artifact drill archive receipt semantics are invalid");
  }
  assertHash(
    receipt.extractedManifestSha256,
    "Artifact drill extracted manifest",
  );
  assertBootstrapVerification(receipt.bootstrapVerification);
  return receipt;
};

const assertProviderRequest = (request, { expectedTeamId } = {}) => {
  assertExactKeys(
    request,
    [
      "date",
      "deploymentTarget",
      "etag",
      "projectId",
      "readyState",
      "requestUrl",
      "responseSha256",
      "status",
      "teamId",
    ],
    "Artifact drill provider request",
  );
  let requestUrl;
  try {
    requestUrl = new URL(request.requestUrl);
  } catch {
    throw new Error("Artifact drill provider request URL is invalid");
  }
  if (
    requestUrl.protocol !== "https:" ||
    requestUrl.hostname !== "api.vercel.com" ||
    requestUrl.username !== "" ||
    requestUrl.password !== "" ||
    request.status !== 200 ||
    request.deploymentTarget !== null ||
    request.readyState !== "READY" ||
    !SAFE_IDENTIFIER.test(request.projectId ?? "") ||
    !SAFE_IDENTIFIER.test(request.teamId ?? "") ||
    (expectedTeamId !== undefined && request.teamId !== expectedTeamId) ||
    typeof request.etag !== "string" ||
    request.etag.length < 1 ||
    request.etag.length > 512
  ) {
    throw new Error("Artifact drill provider request semantics are invalid");
  }
  assertCanonicalHttpDate(
    request.date,
    "Artifact drill provider response Date",
  );
  assertHash(request.responseSha256, "Artifact drill provider response");
  return request;
};

const assertRouteProbes = (routes) => {
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > 1024) {
    throw new Error("Artifact drill route probe receipt set is invalid");
  }
  let previous = null;
  for (const route of routes) {
    assertExactKeys(
      route,
      ["path", "responseSha256", "status"],
      "Artifact drill route probe receipt",
    );
    if (
      typeof route.path !== "string" ||
      !route.path.startsWith("/") ||
      route.path.includes("#") ||
      (previous !== null && previous.localeCompare(route.path) >= 0) ||
      !Number.isSafeInteger(route.status) ||
      route.status < 200 ||
      route.status >= 400
    ) {
      throw new Error("Artifact drill route probe receipt is invalid");
    }
    assertHash(route.responseSha256, "Artifact drill route response");
    previous = route.path;
  }
  return routes;
};

export const assertArtifactDrillDeploymentReceipt = (
  receipt,
  expected = {},
) => {
  assertExactKeys(
    receipt,
    [
      "authority",
      "deploymentId",
      "kind",
      "manifestSha256",
      "packageArchiveSha256",
      "previewUrl",
      "provider",
      "role",
      "routeProbes",
      "schemaVersion",
      "target",
    ],
    "Artifact drill preview deployment receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  const preview = assertHttpsOrigin(
    receipt.previewUrl,
    "Artifact drill preview deployment",
  );
  const provider = assertProviderRequest(receipt.provider, {
    expectedTeamId: expected.providerPolicy?.expectedTeamId,
  });
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-preview-deployment-receipt/v1" ||
    receipt.target !== "preview" ||
    !["containment", "standard"].includes(receipt.role) ||
    !SAFE_IDENTIFIER.test(receipt.deploymentId ?? "") ||
    provider.projectId !== expected.providerPolicy?.expectedProjectId ||
    !provider.requestUrl.includes(
      `/deployments/${encodeURIComponent(preview.hostname)}`,
    )
  ) {
    throw new Error("Artifact drill preview deployment receipt is invalid");
  }
  if (
    (expected.forbiddenAliases ?? []).some((domain) => {
      const candidate = domain.toLowerCase();
      return (
        preview.hostname === candidate ||
        preview.hostname.endsWith(`.${candidate}`)
      );
    })
  ) {
    throw new Error("Artifact drill preview receipt reached production domain");
  }
  assertHash(receipt.manifestSha256, "Artifact drill deployed manifest");
  assertHash(receipt.packageArchiveSha256, "Artifact drill deployed archive");
  assertRouteProbes(receipt.routeProbes);
  return receipt;
};

export const assertArtifactDrillProviderObservationReceipt = (
  receipt,
  expected = {},
) => {
  assertExactKeys(
    receipt,
    [
      "authority",
      "deployments",
      "kind",
      "projectId",
      "schemaVersion",
      "teamId",
    ],
    "Artifact drill provider observation receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-provider-observation/v1" ||
    receipt.projectId !== expected.providerPolicy?.expectedProjectId ||
    receipt.teamId !== expected.providerPolicy?.expectedTeamId ||
    !Array.isArray(receipt.deployments) ||
    receipt.deployments.length !== 2
  ) {
    throw new Error("Artifact drill provider observation receipt is invalid");
  }
  for (const item of receipt.deployments) {
    assertExactKeys(
      item,
      ["deploymentId", "previewUrl", "responseSha256", "role"],
      "Artifact drill provider deployment observation",
    );
    if (
      !SAFE_IDENTIFIER.test(item.deploymentId ?? "") ||
      !["containment", "standard"].includes(item.role)
    ) {
      throw new Error(
        "Artifact drill provider deployment observation is invalid",
      );
    }
    assertHttpsOrigin(item.previewUrl, "Artifact drill provider preview URL");
    assertHash(
      item.responseSha256,
      "Artifact drill provider observation response",
    );
  }
  if (
    receipt.deployments
      .map(({ role }) => role)
      .sort()
      .join(",") !== "containment,standard"
  ) {
    throw new Error("Artifact drill provider role set differs");
  }
  return receipt;
};

export const assertArtifactDrillAssignmentReceipt = (
  receipt,
  expected = {},
) => {
  assertExactKeys(
    receipt,
    [
      "authority",
      "deploymentId",
      "domain",
      "kind",
      "provider",
      "schemaVersion",
    ],
    "Artifact drill preview assignment receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  assertExactKeys(
    receipt.provider,
    [
      "commandRequestUrl",
      "commandResponseSha256",
      "date",
      "etag",
      "observedDeploymentId",
      "observedProjectId",
      "requestUrl",
      "responseSha256",
      "status",
    ],
    "Artifact drill alias provider receipt",
  );
  const domain = receipt.domain?.toLowerCase();
  let commandUrl;
  try {
    commandUrl = new URL(receipt.provider.commandRequestUrl);
  } catch {
    throw new Error("Artifact drill alias command URL is invalid");
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-preview-assignment-receipt/v1" ||
    !SAFE_IDENTIFIER.test(receipt.deploymentId ?? "") ||
    !DOMAIN.test(domain ?? "") ||
    domain !== receipt.domain ||
    !domain.startsWith(`${receipt.authority.drillNamespace}.`) ||
    (expected.aliasSuffix !== undefined &&
      !domain.endsWith(`.${expected.aliasSuffix}`)) ||
    receipt.provider.status !== 200 ||
    receipt.provider.observedDeploymentId !== receipt.deploymentId ||
    receipt.provider.observedProjectId !==
      expected.providerPolicy?.expectedProjectId ||
    commandUrl.protocol !== "https:" ||
    commandUrl.hostname !== "api.vercel.com" ||
    !commandUrl.pathname.endsWith(
      `/deployments/${encodeURIComponent(receipt.deploymentId)}/aliases`,
    ) ||
    typeof receipt.provider.etag !== "string" ||
    receipt.provider.etag.length < 1
  ) {
    throw new Error("Artifact drill preview assignment receipt is invalid");
  }
  let requestUrl;
  try {
    requestUrl = new URL(receipt.provider.requestUrl);
  } catch {
    throw new Error("Artifact drill alias observation URL is invalid");
  }
  if (
    requestUrl.protocol !== "https:" ||
    requestUrl.hostname !== "api.vercel.com" ||
    !requestUrl.pathname.endsWith(`/${encodeURIComponent(domain)}`)
  ) {
    throw new Error("Artifact drill alias observation endpoint differs");
  }
  for (const forbidden of expected.forbiddenAliases ?? []) {
    const candidate = forbidden.toLowerCase();
    if (domain === candidate || domain.endsWith(`.${candidate}`)) {
      throw new Error("Artifact drill assignment overlaps a production domain");
    }
  }
  assertCanonicalHttpDate(receipt.provider.date, "Artifact drill alias Date");
  assertHash(
    receipt.provider.commandResponseSha256,
    "Artifact drill alias command response",
  );
  assertHash(receipt.provider.responseSha256, "Artifact drill alias response");
  return receipt;
};

export const assertArtifactDrillRedeployReceipt = (receipt, expected = {}) => {
  assertExactKeys(
    receipt,
    [
      "authority",
      "firstDeploymentId",
      "kind",
      "manifestSha256",
      "packageArchiveSha256",
      "previewUrl",
      "provider",
      "redeployedDeploymentId",
      "routeProbes",
      "schemaVersion",
    ],
    "Artifact drill redeploy receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  const preview = assertHttpsOrigin(
    receipt.previewUrl,
    "Artifact drill redeploy preview",
  );
  const provider = assertProviderRequest(receipt.provider, {
    expectedTeamId: expected.providerPolicy?.expectedTeamId,
  });
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-preview-redeploy-receipt/v1" ||
    !SAFE_IDENTIFIER.test(receipt.firstDeploymentId ?? "") ||
    !SAFE_IDENTIFIER.test(receipt.redeployedDeploymentId ?? "") ||
    receipt.firstDeploymentId === receipt.redeployedDeploymentId ||
    provider.projectId !== expected.providerPolicy?.expectedProjectId ||
    !provider.requestUrl.includes(
      `/deployments/${encodeURIComponent(preview.hostname)}`,
    )
  ) {
    throw new Error("Artifact drill preview redeploy receipt is invalid");
  }
  if (
    (expected.forbiddenAliases ?? []).some((domain) => {
      const candidate = domain.toLowerCase();
      return (
        preview.hostname === candidate ||
        preview.hostname.endsWith(`.${candidate}`)
      );
    })
  ) {
    throw new Error(
      "Artifact drill redeploy receipt reached production domain",
    );
  }
  assertHash(receipt.manifestSha256, "Artifact drill redeploy manifest");
  assertHash(receipt.packageArchiveSha256, "Artifact drill redeploy archive");
  assertRouteProbes(receipt.routeProbes);
  return receipt;
};

export const assertArtifactDrillReconcileReceipt = (receipt, expected = {}) => {
  assertExactKeys(
    receipt,
    ["assignments", "authority", "kind", "schemaVersion"],
    "Artifact drill reconcile receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-preview-reconcile-receipt/v1" ||
    !Array.isArray(receipt.assignments) ||
    receipt.assignments.length !== 2
  ) {
    throw new Error("Artifact drill reconcile receipt is invalid");
  }
  let previous = null;
  for (const assignment of receipt.assignments) {
    assertExactKeys(
      assignment,
      ["deploymentId", "domain", "responseSha256"],
      "Artifact drill reconcile assignment",
    );
    if (
      !SAFE_IDENTIFIER.test(assignment.deploymentId ?? "") ||
      !DOMAIN.test(assignment.domain ?? "") ||
      !assignment.domain.startsWith(`${receipt.authority.drillNamespace}.`) ||
      (previous !== null && previous.localeCompare(assignment.domain) >= 0)
    ) {
      throw new Error("Artifact drill reconcile assignment is invalid");
    }
    assertHash(assignment.responseSha256, "Artifact drill reconcile response");
    previous = assignment.domain;
  }
  return receipt;
};

const assertCleanupRequest = (
  value,
  { method, requestUrl, allowedStatuses, label },
) => {
  assertExactKeys(
    value,
    ["method", "requestUrl", "responseSha256", "status"],
    label,
  );
  if (
    value.method !== method ||
    value.requestUrl !== requestUrl ||
    !allowedStatuses.includes(value.status)
  ) {
    throw new Error(`${label} semantics are invalid`);
  }
  assertHash(value.responseSha256, `${label} response`);
  return value;
};

const cleanupApiUrl = ({ pathname, teamId }) => {
  const url = new URL(pathname, "https://api.vercel.com");
  url.searchParams.set("teamId", teamId);
  return url.href;
};

export const assertArtifactDrillProviderCleanupReceipt = (
  receipt,
  expected = {},
) => {
  assertExactKeys(
    receipt,
    [
      "aliases",
      "authority",
      "deployments",
      "kind",
      "projectId",
      "schemaVersion",
      "teamId",
    ],
    "Artifact drill provider cleanup receipt",
  );
  assertArtifactDrillReceiptAuthority(receipt.authority, expected.authority);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-provider-cleanup-receipt/v1" ||
    receipt.projectId !== expected.providerPolicy?.expectedProjectId ||
    receipt.teamId !== expected.providerPolicy?.expectedTeamId ||
    !Array.isArray(receipt.aliases) ||
    !Array.isArray(receipt.deployments)
  ) {
    throw new Error("Artifact drill provider cleanup receipt is invalid");
  }

  let previousAlias = null;
  for (const alias of receipt.aliases) {
    assertExactKeys(
      alias,
      ["deletion", "deploymentId", "domain", "preDelete", "readback"],
      "Artifact drill alias cleanup",
    );
    const domain = alias.domain?.toLowerCase();
    if (
      !DOMAIN.test(domain ?? "") ||
      domain !== alias.domain ||
      !domain.startsWith(`${receipt.authority.drillNamespace}.`) ||
      (expected.aliasSuffix !== undefined &&
        !domain.endsWith(`.${expected.aliasSuffix}`)) ||
      !SAFE_IDENTIFIER.test(alias.deploymentId ?? "") ||
      (previousAlias !== null && previousAlias.localeCompare(domain) >= 0)
    ) {
      throw new Error("Artifact drill alias cleanup identity is invalid");
    }
    for (const forbidden of expected.forbiddenAliases ?? []) {
      const candidate = forbidden.toLowerCase();
      if (
        domain === candidate ||
        domain.endsWith(`.${candidate}`) ||
        candidate.endsWith(`.${domain}`)
      ) {
        throw new Error(
          "Artifact drill cleanup attempted a production alias deletion",
        );
      }
    }
    const lookupUrl = cleanupApiUrl({
      pathname: `/v4/aliases/${encodeURIComponent(domain)}`,
      teamId: receipt.teamId,
    });
    const deleteUrl = cleanupApiUrl({
      pathname: `/v2/aliases/${encodeURIComponent(domain)}`,
      teamId: receipt.teamId,
    });
    assertCleanupRequest(alias.preDelete, {
      method: "GET",
      requestUrl: lookupUrl,
      allowedStatuses: [200, 404],
      label: "Artifact drill alias cleanup pre-read",
    });
    assertCleanupRequest(alias.deletion, {
      method: "DELETE",
      requestUrl: deleteUrl,
      allowedStatuses: [200, 404],
      label: "Artifact drill alias cleanup deletion",
    });
    assertCleanupRequest(alias.readback, {
      method: "GET",
      requestUrl: lookupUrl,
      allowedStatuses: [404],
      label: "Artifact drill alias cleanup readback",
    });
    previousAlias = domain;
  }

  let previousDeployment = null;
  for (const deployment of receipt.deployments) {
    assertExactKeys(
      deployment,
      ["deletion", "deploymentId", "preDelete", "previewUrl", "readback"],
      "Artifact drill deployment cleanup",
    );
    const preview = assertHttpsOrigin(
      deployment.previewUrl,
      "Artifact drill cleanup preview deployment",
    );
    if (
      !SAFE_IDENTIFIER.test(deployment.deploymentId ?? "") ||
      (previousDeployment !== null &&
        previousDeployment.localeCompare(deployment.deploymentId) >= 0)
    ) {
      throw new Error("Artifact drill deployment cleanup identity is invalid");
    }
    for (const forbidden of expected.forbiddenAliases ?? []) {
      const candidate = forbidden.toLowerCase();
      if (
        preview.hostname === candidate ||
        preview.hostname.endsWith(`.${candidate}`) ||
        candidate.endsWith(`.${preview.hostname}`)
      ) {
        throw new Error(
          "Artifact drill cleanup attempted a production deployment deletion",
        );
      }
    }
    const preDeleteUrl = cleanupApiUrl({
      pathname: `/v13/deployments/${encodeURIComponent(preview.hostname)}`,
      teamId: receipt.teamId,
    });
    const deploymentUrl = cleanupApiUrl({
      pathname: `/v13/deployments/${encodeURIComponent(deployment.deploymentId)}`,
      teamId: receipt.teamId,
    });
    assertCleanupRequest(deployment.preDelete, {
      method: "GET",
      requestUrl: preDeleteUrl,
      allowedStatuses: [200, 404],
      label: "Artifact drill deployment cleanup pre-read",
    });
    assertCleanupRequest(deployment.deletion, {
      method: "DELETE",
      requestUrl: deploymentUrl,
      allowedStatuses: [200, 404],
      label: "Artifact drill deployment cleanup deletion",
    });
    assertCleanupRequest(deployment.readback, {
      method: "GET",
      requestUrl: deploymentUrl,
      allowedStatuses: [404],
      label: "Artifact drill deployment cleanup readback",
    });
    previousDeployment = deployment.deploymentId;
  }
  return receipt;
};

export const parseCanonicalArtifactDrillReceipt = ({
  bytes,
  label,
  validator,
  expected,
}) => {
  const receipt = parseJsonStrict(bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(receipt).equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
  return validator(receipt, expected);
};

export const putCanonicalArtifactDrillReceipt = async ({
  store,
  value,
  mediaType,
  validator,
  expected,
}) => {
  validator(value, expected);
  const bytes = canonicalJsonBytes(value);
  const sha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  const stored = await store.readEvidence({ sha256 });
  if (
    receipt?.uri !== `release-state://${store.namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== mediaType
  ) {
    throw new Error("Artifact drill immutable operation receipt differs");
  }
  parseCanonicalArtifactDrillReceipt({
    bytes: stored.bytes,
    label: "Artifact drill immutable operation receipt",
    validator,
    expected,
  });
  return Object.freeze({ sha256, uri: receipt.uri });
};
