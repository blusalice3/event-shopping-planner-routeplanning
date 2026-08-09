import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { assertArtifactManifest } from "../lib/artifact-contract.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  POLICY_ACTIVATION_CLOSURE_KIND,
  derivePolicyActivationTransition,
} from "./policyActivation.mjs";
import { assertPolicyCompatibilityEntries } from "./policyCompatibility.mjs";
import {
  POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE,
  validatePolicyActivationQaPackage,
} from "./policyActivationQaPackage.mjs";
import {
  POLICY_QA_COMMAND_RECEIPT_MEDIA_TYPE,
  POLICY_QA_DEPLOYMENT_OBSERVATION_MEDIA_TYPE,
  POLICY_QA_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
  POLICY_QA_DRILL_MEDIA_TYPE,
  POLICY_QA_EXECUTION_MEDIA_TYPE,
  POLICY_QA_EXECUTION_SUBJECT_MEDIA_TYPE,
  POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE,
  POLICY_QA_ROUTE_PROBE_MEDIA_TYPE,
  assertPolicyActivationQaDeploymentOutsideProductionDomains,
  assertPolicyActivationQaExecutionSubject,
  derivePolicyActivationQaDrillDomain,
} from "./policyActivationQaExecution.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

export const POLICY_ACTIVATION_DRILL_KIND =
  "policy-activation-recovery-drill/v1";
const RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-closure-receipt+json;version=1";
const BUNDLE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-closure+json;version=1";
const HTTP_TRANSACTION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-http-transaction+json;version=1";
const OIDC_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1";
const RECEIPT_KINDS = Object.freeze({
  nonProductionQa: "policy-non-production-qa/v1",
  schemaValidation: "policy-schema-validation/v1",
  monotonicity: "policy-monotonicity-validation/v1",
  predecessorCompatibility: "policy-predecessor-compatibility/v1",
  rollbackContainmentDrill: "policy-rollback-containment-drill/v1",
});
const FORBIDDEN_RESULT_FIELDS = [
  "activePolicyReference",
  "approvalPolicyReference",
  "closureBundle",
  "closureEvidenceRefs",
  "drillPassed",
  "nonProductionQa",
  "proposedPolicyReference",
  "qaPackageReference",
  "receiptResults",
  "rollbackInventory",
];

const evidenceReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    !SHA256_PATTERN.test(reference.sha256) ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} is not immutable Release State evidence`);
  }
  return reference;
};

export const assertPolicyQaExecutionEvidenceSet = ({
  actual,
  expected,
  namespace,
}) => {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    throw new Error("Policy QA execution evidence set is invalid");
  }
  for (const [label, references] of [
    ["actual", actual],
    ["expected", expected],
  ]) {
    references.forEach((reference, index) =>
      assertReference(
        reference,
        namespace,
        `Policy QA ${label} evidence ${index}`,
      ),
    );
  }
  const canonicalExpected = [...expected].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.sha256, "utf8"),
      Buffer.from(right.sha256, "utf8"),
    ),
  );
  if (
    new Set(canonicalExpected.map((item) => item.sha256)).size !==
      canonicalExpected.length ||
    !sameCanonicalValue(actual, canonicalExpected)
  ) {
    throw new Error(
      "Policy QA execution evidence set has missing or extra objects",
    );
  }
  return actual;
};

const readCanonical = async ({ store, namespace, reference, label }) => {
  assertReference(reference, namespace, label);
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  return {
    bytes: stored.bytes,
    mediaType: stored.mediaType,
    value: parseCanonicalJsonBytes(stored.bytes, label),
  };
};

const putCanonical = async ({ store, namespace, value, mediaType, label }) => {
  const bytes = canonicalJsonBytes(value);
  const sha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.byteLength !== bytes.length ||
    receipt.mediaType !== mediaType ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256 });
  if (!stored?.bytes?.equals(bytes)) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return { bytes, reference: evidenceReference(namespace, sha256) };
};

const assertConfiguredProviderPolicy = (policy) => {
  if (
    policy?.bindingStatus !== "configured" ||
    typeof policy.expectedProjectId !== "string" ||
    policy.expectedProjectId.length === 0 ||
    typeof policy.expectedTeamId !== "string" ||
    policy.expectedTeamId.length === 0 ||
    !Array.isArray(policy.ownedProductionDomains) ||
    !Number.isSafeInteger(policy.observationPolicy?.maxResponseAgeSeconds) ||
    policy.observationPolicy.maxResponseAgeSeconds <= 0 ||
    !Number.isSafeInteger(
      policy.observationPolicy?.maxFutureClockSkewSeconds,
    ) ||
    policy.observationPolicy.maxFutureClockSkewSeconds < 0 ||
    typeof policy.observationPolicy.apiBaseUrl !== "string"
  ) {
    throw new Error("Policy activation provider policy is not configured");
  }
  return policy;
};

const assertConfiguredApprovalPolicy = (policy) => {
  if (
    policy?.bindingStatus !== "configured" ||
    policy.trustedIssuer !== "https://token.actions.githubusercontent.com" ||
    typeof policy.oidcAudience !== "string" ||
    policy.oidcAudience.length === 0 ||
    typeof policy.repository !== "string" ||
    policy.repository.length === 0 ||
    typeof policy.workflowRef !== "string" ||
    policy.workflowRef.length === 0 ||
    typeof policy.protectedEnvironment !== "string" ||
    policy.protectedEnvironment.length === 0 ||
    !Number.isSafeInteger(policy.oidcClockSkewSeconds) ||
    policy.oidcClockSkewSeconds < 0 ||
    policy.oidcClockSkewSeconds > 300 ||
    !Number.isSafeInteger(policy.oidcMaxTokenAgeSeconds) ||
    policy.oidcMaxTokenAgeSeconds < 60 ||
    policy.oidcMaxTokenAgeSeconds > 900
  ) {
    throw new Error("Policy activation approval policy is not configured");
  }
  return policy;
};

const assertFreshTimestamp = ({
  value,
  providerPolicy,
  nowMilliseconds,
  label,
}) => {
  const timestamp = Date.parse(value);
  const age = nowMilliseconds - timestamp;
  if (
    !Number.isFinite(timestamp) ||
    age > providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    age < -providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(`${label} is outside provider freshness`);
  }
  return timestamp;
};

const readHttpTransaction = async ({
  store,
  namespace,
  reference,
  providerPolicy,
  nowMilliseconds,
  expectedMethod,
  expectedUrl,
  expectedStatus,
  expectedBodySha256,
  expectedContentType,
  requireHsts,
  label,
}) => {
  const stored = await readCanonical({
    store,
    namespace,
    reference,
    label,
  });
  const transaction = stored.value;
  assertExactKeys(
    transaction,
    [
      "evidenceKind",
      "observedAt",
      "request",
      "response",
      "schemaVersion",
      "transactionSha256",
    ],
    label,
  );
  assertExactKeys(
    transaction.request,
    ["body", "bodySha256", "method", "url"],
    `${label} request`,
  );
  assertExactKeys(
    transaction.response,
    ["body", "bodySha256", "headers", "headersSha256", "status"],
    `${label} response`,
  );
  assertExactKeys(
    transaction.response.headers,
    ["contentType", "date", "etag", "location", "strictTransportSecurity"],
    `${label} response headers`,
  );
  const requestBodyNull =
    transaction.request.body === null &&
    transaction.request.bodySha256 === null;
  if (!requestBodyNull) {
    assertReference(
      transaction.request.body,
      namespace,
      `${label} request body`,
    );
    if (transaction.request.bodySha256 !== transaction.request.body.sha256) {
      throw new Error(`${label} request body hash differs`);
    }
  }
  assertReference(
    transaction.response.body,
    namespace,
    `${label} response body`,
  );
  const headersSha256 = sha256Bytes(
    canonicalJsonBytes(transaction.response.headers),
  );
  const transactionSha256 = sha256Bytes(
    canonicalJsonBytes({
      observedAt: transaction.observedAt,
      request: transaction.request,
      response: {
        ...transaction.response,
        headersSha256,
      },
    }),
  );
  if (
    stored.mediaType !== HTTP_TRANSACTION_MEDIA_TYPE ||
    transaction.schemaVersion !== 1 ||
    transaction.evidenceKind !== "policy-activation-http-transaction/v1" ||
    transaction.request.method !== expectedMethod ||
    transaction.request.url !== expectedUrl ||
    transaction.response.status !== expectedStatus ||
    transaction.response.bodySha256 !== transaction.response.body.sha256 ||
    transaction.response.headersSha256 !== headersSha256 ||
    transaction.transactionSha256 !== transactionSha256 ||
    (expectedBodySha256 !== undefined &&
      transaction.response.bodySha256 !== expectedBodySha256) ||
    typeof transaction.response.headers.contentType !== "string" ||
    !transaction.response.headers.contentType.startsWith(expectedContentType) ||
    (requireHsts &&
      (typeof transaction.response.headers.strictTransportSecurity !==
        "string" ||
        transaction.response.headers.strictTransportSecurity.length === 0))
  ) {
    throw new Error(
      `${label} route, status, header, or body binding is invalid`,
    );
  }
  const observedAt = assertFreshTimestamp({
    value: transaction.observedAt,
    providerPolicy,
    nowMilliseconds,
    label: `${label} observedAt`,
  });
  const responseAt = assertFreshTimestamp({
    value: transaction.response.headers.date,
    providerPolicy,
    nowMilliseconds,
    label: `${label} Date header`,
  });
  if (
    responseAt >
    observedAt +
      providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(`${label} response Date follows its observation`);
  }
  const bodyReferences = [transaction.response.body];
  if (!requestBodyNull) bodyReferences.push(transaction.request.body);
  const bodies = await Promise.all(
    bodyReferences.map((bodyReference) =>
      assertEvidenceObjectAvailable({
        store,
        namespace,
        reference: bodyReference,
        label: `${label} body`,
      }),
    ),
  );
  if (
    bodies.some(
      (body, index) => sha256Bytes(body.bytes) !== bodyReferences[index].sha256,
    )
  ) {
    throw new Error(`${label} body bytes differ from their reviewed hash`);
  }
  return {
    transaction,
    requestBodyBytes: requestBodyNull ? null : bodies.at(-1).bytes,
    responseBodyBytes: bodies[0].bytes,
    observedAt,
  };
};

const validateStoredOidcReceipt = async ({
  store,
  namespace,
  reference,
  approvalPolicy,
  executorSourceSha,
  workflowRunId,
  completedAt,
  nowMilliseconds,
}) => {
  const stored = await readCanonical({
    store,
    namespace,
    reference,
    label: "Policy drill GitHub OIDC verification receipt",
  });
  const receipt = stored.value;
  assertExactKeys(
    receipt,
    [
      "audience",
      "claims",
      "issuer",
      "kind",
      "schemaVersion",
      "signingKey",
      "subject",
      "tokenSha256",
      "verifiedAt",
    ],
    "Policy drill GitHub OIDC verification receipt",
  );
  assertExactKeys(
    receipt.signingKey,
    ["jwkThumbprintSha256", "kid"],
    "Policy drill GitHub OIDC signing key",
  );
  assertExactKeys(
    receipt.claims,
    [
      "environment",
      "eventName",
      "expiresAt",
      "issuedAt",
      "jti",
      "notBefore",
      "ref",
      "refProtected",
      "repository",
      "runAttempt",
      "runId",
      "sourceSha",
      "workflowRef",
      "workflowSha",
    ],
    "Policy drill GitHub OIDC claims",
  );
  const completed = Date.parse(completedAt);
  const issued = Date.parse(receipt.claims.issuedAt);
  const notBefore = Date.parse(receipt.claims.notBefore);
  const expires = Date.parse(receipt.claims.expiresAt);
  const verified = Date.parse(receipt.verifiedAt);
  const expectedSubject = `repo:${approvalPolicy.repository}:environment:${approvalPolicy.protectedEnvironment.replaceAll(
    ":",
    "%3A",
  )}`;
  const skewMilliseconds = approvalPolicy.oidcClockSkewSeconds * 1000;
  const maximumTokenAgeMilliseconds =
    approvalPolicy.oidcMaxTokenAgeSeconds * 1000;
  if (
    stored.mediaType !== OIDC_MEDIA_TYPE ||
    approvalPolicy?.bindingStatus !== "configured" ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "github-actions-oidc-verification/v1" ||
    receipt.issuer !== approvalPolicy.trustedIssuer ||
    receipt.audience !== approvalPolicy.oidcAudience ||
    receipt.subject !== expectedSubject ||
    receipt.claims.repository !== approvalPolicy.repository ||
    receipt.claims.workflowRef !== approvalPolicy.workflowRef ||
    receipt.claims.environment !== approvalPolicy.protectedEnvironment ||
    receipt.claims.sourceSha !== executorSourceSha ||
    receipt.claims.workflowSha !== executorSourceSha ||
    receipt.claims.runId !== workflowRunId ||
    !/^[1-9][0-9]*$/.test(receipt.claims.runId) ||
    !/^[1-9][0-9]*$/.test(receipt.claims.runAttempt) ||
    receipt.claims.eventName !== "workflow_dispatch" ||
    receipt.claims.ref !== "refs/heads/main" ||
    receipt.claims.refProtected !== true ||
    typeof receipt.claims.jti !== "string" ||
    receipt.claims.jti.length === 0 ||
    !SHA256_PATTERN.test(receipt.tokenSha256) ||
    !SHA256_PATTERN.test(receipt.signingKey.jwkThumbprintSha256) ||
    typeof receipt.signingKey.kid !== "string" ||
    receipt.signingKey.kid.length === 0 ||
    ![completed, issued, notBefore, expires, verified].every(Number.isFinite) ||
    completed < notBefore ||
    completed > expires ||
    verified < issued ||
    verified > completed ||
    expires <= nowMilliseconds - skewMilliseconds ||
    notBefore > nowMilliseconds + skewMilliseconds ||
    issued > nowMilliseconds + skewMilliseconds ||
    issued < nowMilliseconds - maximumTokenAgeMilliseconds - skewMilliseconds ||
    expires <= issued ||
    expires - issued > maximumTokenAgeMilliseconds + 2 * skewMilliseconds
  ) {
    throw new Error("Policy drill GitHub OIDC authority is invalid or expired");
  }
  return receipt;
};

const validateQaDeploymentObservation = async ({
  store,
  namespace,
  reference,
  packageReference,
  proposedPolicyReference,
  artifact,
  manifest,
  providerPolicy,
  approvalPolicy,
  executorSourceSha,
  nowMilliseconds,
}) => {
  const stored = await readCanonical({
    store,
    namespace,
    reference,
    label: `Policy QA ${artifact.releaseRole} deployment observation`,
  });
  const observation = stored.value;
  assertExactKeys(
    observation,
    [
      "bindingId",
      "deploymentReceipt",
      "deploymentUrl",
      "drillDomain",
      "environment",
      "evidenceKind",
      "namespace",
      "observedAt",
      "operationId",
      "proposedReleasePolicy",
      "providerDeploymentId",
      "providerProjectId",
      "qaPackage",
      "releaseRole",
      "routeProbe",
      "schemaVersion",
      "sourceSha",
      "variantId",
    ],
    "Policy QA deployment observation",
  );
  if (
    stored.mediaType !== POLICY_QA_DEPLOYMENT_OBSERVATION_MEDIA_TYPE ||
    observation.schemaVersion !== 1 ||
    observation.evidenceKind !== "policy-activation-qa-deployment/v1" ||
    observation.namespace !== namespace ||
    observation.environment !== "non-production" ||
    observation.bindingId !== artifact.bindingId ||
    observation.releaseRole !== artifact.releaseRole ||
    observation.variantId !== artifact.variantId ||
    !sameCanonicalValue(observation.qaPackage, packageReference) ||
    !sameCanonicalValue(
      observation.proposedReleasePolicy,
      proposedPolicyReference,
    ) ||
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    typeof observation.providerDeploymentId !== "string" ||
    observation.providerDeploymentId.length === 0 ||
    typeof observation.deploymentUrl !== "string" ||
    !observation.deploymentUrl.startsWith("https://") ||
    observation.sourceSha !== manifest.sourceSha ||
    typeof observation.drillDomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      observation.drillDomain,
    ) ||
    providerPolicy.ownedProductionDomains.includes(observation.drillDomain) ||
    observation.drillDomain !==
      derivePolicyActivationQaDrillDomain({
        namespace,
        operationId: observation.operationId,
        providerPolicy,
      })
  ) {
    throw new Error("Policy QA deployment observation binding is invalid");
  }
  const deploymentUrl = new URL(observation.deploymentUrl);
  assertPolicyActivationQaDeploymentOutsideProductionDomains({
    deploymentUrl: observation.deploymentUrl,
    providerPolicy,
  });
  if (
    deploymentUrl.username !== "" ||
    deploymentUrl.password !== "" ||
    deploymentUrl.search !== "" ||
    deploymentUrl.hash !== ""
  ) {
    throw new Error(
      "Policy QA deployment URL is not an immutable HTTPS origin",
    );
  }
  const lookupUrl = new URL(
    `/v13/deployments/${encodeURIComponent(deploymentUrl.hostname)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  lookupUrl.searchParams.set("teamId", providerPolicy.expectedTeamId);
  lookupUrl.searchParams.sort();
  const [receiptObject, routeProbeObject] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: observation.deploymentReceipt,
      label: `Policy QA ${artifact.releaseRole} deployment receipt`,
    }),
    readCanonical({
      store,
      namespace,
      reference: observation.routeProbe,
      label: `Policy QA ${artifact.releaseRole} route probe`,
    }),
  ]);
  const receipt = receiptObject.value;
  assertExactKeys(
    receipt,
    [
      "archive",
      "bindingId",
      "cli",
      "completedAt",
      "deploymentUrl",
      "environment",
      "executorSourceSha",
      "issuerReceipt",
      "manifest",
      "namespace",
      "operationId",
      "proposedReleasePolicy",
      "providerDeploymentId",
      "providerLookup",
      "providerProjectId",
      "qaPackage",
      "receiptKind",
      "releaseRole",
      "schemaVersion",
      "startedAt",
      "variantId",
      "workflowRunId",
    ],
    "Policy QA deployment receipt",
  );
  assertExactKeys(
    receipt.cli,
    ["operation", "package", "version"],
    "Policy QA deployment CLI receipt",
  );
  const routeProbe = routeProbeObject.value;
  assertExactKeys(
    routeProbe,
    [
      "bindingId",
      "deploymentUrl",
      "evidenceKind",
      "manifest",
      "namespace",
      "observedAt",
      "providerDeploymentId",
      "providerProjectId",
      "publicIdentity",
      "releaseRole",
      "routes",
      "runtimeHtmlIdentity",
      "schemaVersion",
    ],
    "Policy QA route probe",
  );
  const providerLookup = await readHttpTransaction({
    store,
    namespace,
    reference: receipt.providerLookup,
    providerPolicy,
    nowMilliseconds,
    expectedMethod: "GET",
    expectedUrl: lookupUrl.href,
    expectedStatus: 200,
    expectedContentType: "application/json",
    requireHsts: false,
    label: `Policy QA ${artifact.releaseRole} provider deployment lookup`,
  });
  const providerBody = parseJsonStrict(
    providerLookup.responseBodyBytes.toString("utf8"),
    "Policy QA provider deployment response",
  );
  const expectedRoutes = Object.entries(manifest.publicResponseHashes);
  if (
    receiptObject.mediaType !== POLICY_QA_DEPLOYMENT_RECEIPT_MEDIA_TYPE ||
    routeProbeObject.mediaType !== POLICY_QA_ROUTE_PROBE_MEDIA_TYPE ||
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== "policy-activation-qa-deployment-receipt/v1" ||
    receipt.namespace !== namespace ||
    receipt.operationId !== observation.operationId ||
    receipt.environment !== "non-production" ||
    receipt.bindingId !== observation.bindingId ||
    receipt.releaseRole !== observation.releaseRole ||
    receipt.variantId !== observation.variantId ||
    !sameCanonicalValue(receipt.manifest, artifact.manifest) ||
    !sameCanonicalValue(receipt.archive, artifact.archive) ||
    !sameCanonicalValue(receipt.qaPackage, packageReference) ||
    !sameCanonicalValue(
      receipt.proposedReleasePolicy,
      proposedPolicyReference,
    ) ||
    receipt.providerProjectId !== observation.providerProjectId ||
    receipt.providerDeploymentId !== observation.providerDeploymentId ||
    receipt.deploymentUrl !== observation.deploymentUrl ||
    receipt.cli.package !== "vercel" ||
    receipt.cli.operation !== "deploy-prebuilt-preview-skip-domain" ||
    !/^[1-9][0-9]*$/.test(receipt.workflowRunId) ||
    routeProbe.schemaVersion !== 1 ||
    routeProbe.evidenceKind !== "policy-activation-qa-route-probe/v1" ||
    routeProbe.namespace !== namespace ||
    routeProbe.bindingId !== observation.bindingId ||
    routeProbe.releaseRole !== observation.releaseRole ||
    !sameCanonicalValue(routeProbe.manifest, artifact.manifest) ||
    routeProbe.deploymentUrl !== observation.deploymentUrl ||
    routeProbe.providerProjectId !== observation.providerProjectId ||
    routeProbe.providerDeploymentId !== observation.providerDeploymentId ||
    !Array.isArray(routeProbe.routes) ||
    routeProbe.routes.length !== expectedRoutes.length ||
    providerBody?.id !== observation.providerDeploymentId ||
    providerBody?.projectId !== observation.providerProjectId ||
    providerBody?.ownerId !== providerPolicy.expectedTeamId ||
    providerBody?.url !== deploymentUrl.hostname ||
    providerBody?.readyState !== "READY" ||
    providerBody?.target !== null ||
    providerLookup.observedAt > Date.parse(receipt.completedAt) ||
    Date.parse(receipt.completedAt) !== Date.parse(observation.observedAt) ||
    Date.parse(routeProbe.observedAt) !== Date.parse(observation.observedAt)
  ) {
    throw new Error(
      "Policy QA deployment receipt or route probe binding is invalid",
    );
  }
  await validateStoredOidcReceipt({
    store,
    namespace,
    reference: receipt.issuerReceipt,
    approvalPolicy,
    executorSourceSha,
    workflowRunId: receipt.workflowRunId,
    completedAt: receipt.completedAt,
    nowMilliseconds,
  });
  for (let index = 0; index < expectedRoutes.length; index += 1) {
    const [publicPath, expectedHash] = expectedRoutes[index];
    const route = routeProbe.routes[index];
    assertExactKeys(
      route,
      [
        "body",
        "bodySha256",
        "byteLength",
        "cacheControl",
        "contentType",
        "etag",
        "path",
        "requestUrl",
        "responseDate",
        "responseUrl",
        "securityHeaders",
        "status",
      ],
      `Policy QA route ${publicPath}`,
    );
    assertReference(
      route.body,
      namespace,
      `Policy QA route ${publicPath} body`,
    );
    assertExactKeys(
      route.securityHeaders,
      [
        "content-security-policy",
        "permissions-policy",
        "referrer-policy",
        "strict-transport-security",
        "x-content-type-options",
        "x-frame-options",
      ],
      `Policy QA route ${publicPath} security headers`,
    );
    const body = await assertEvidenceObjectAvailable({
      store,
      namespace,
      reference: route.body,
      label: `Policy QA route ${publicPath} body`,
    });
    if (
      route.path !== publicPath ||
      route.requestUrl !== `${observation.deploymentUrl}${publicPath}` ||
      route.responseUrl !== route.requestUrl ||
      route.status !== 200 ||
      (publicPath === "/" &&
        !route.contentType?.toLowerCase().includes("text/html")) ||
      (providerPolicy.hstsOwner === "provider" &&
        typeof route.securityHeaders["strict-transport-security"] !==
          "string") ||
      route.bodySha256 !== expectedHash ||
      route.body.sha256 !== expectedHash ||
      sha256Bytes(body.bytes) !== expectedHash ||
      route.byteLength !== body.bytes.length ||
      !Number.isFinite(Date.parse(route.responseDate))
    ) {
      throw new Error(`Policy QA public route proof differs: ${publicPath}`);
    }
    assertFreshTimestamp({
      value: route.responseDate,
      providerPolicy,
      nowMilliseconds,
      label: `Policy QA route ${publicPath} Date`,
    });
  }
  return {
    ...observation,
    deploymentIssuerReceipt: receipt.issuerReceipt,
    deploymentWorkflowRunId: receipt.workflowRunId,
  };
};

export const validateNonPromotablePolicyQaPackage = async (
  {
    store,
    namespace,
    packageReference,
    standardDeploymentObservationReference,
    companionDeploymentObservationReference,
    proposedPolicy,
    proposedPolicyReference,
    activationGate,
    executorSourceSha,
    providerPolicy,
    approvalPolicy,
    nowMilliseconds,
  },
  { validatePackage = validatePolicyActivationQaPackage } = {},
) => {
  const index = await validatePackage({
    store,
    namespace,
    packageReference,
    proposedPolicy,
    proposedPolicyReference,
    activationGate,
    executorSourceSha,
  });
  const [standardManifestObject, companionManifestObject] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: index.artifacts[0].manifest,
      label: "Policy QA standard manifest",
    }),
    readCanonical({
      store,
      namespace,
      reference: index.artifacts[1].manifest,
      label: "Policy QA containment manifest",
    }),
  ]);
  const [standardObservation, companionObservation] = await Promise.all([
    validateQaDeploymentObservation({
      store,
      namespace,
      reference: standardDeploymentObservationReference,
      packageReference,
      proposedPolicyReference,
      artifact: index.artifacts[0],
      manifest: standardManifestObject.value,
      providerPolicy,
      approvalPolicy,
      executorSourceSha,
      nowMilliseconds,
    }),
    validateQaDeploymentObservation({
      store,
      namespace,
      reference: companionDeploymentObservationReference,
      packageReference,
      proposedPolicyReference,
      artifact: index.artifacts[1],
      manifest: companionManifestObject.value,
      providerPolicy,
      approvalPolicy,
      executorSourceSha,
      nowMilliseconds,
    }),
  ]);
  if (
    standardObservation.sourceSha !== index.sourceSha ||
    companionObservation.sourceSha !== index.sourceSha ||
    standardObservation.providerProjectId !==
      companionObservation.providerProjectId ||
    standardObservation.providerDeploymentId ===
      companionObservation.providerDeploymentId ||
    standardObservation.drillDomain !== companionObservation.drillDomain
  ) {
    throw new Error(
      "Policy QA deployment pair is not source-bound and independent",
    );
  }
  return {
    receiptResult: {
      qaPackage: packageReference,
      standardManifest: index.artifacts[0].manifest,
      companionManifest: index.artifacts[1].manifest,
      standardArchive: index.artifacts[0].archive,
      companionArchive: index.artifacts[1].archive,
      standardDeploymentObservation: standardDeploymentObservationReference,
      companionDeploymentObservation: companionDeploymentObservationReference,
      sourceSha: index.sourceSha,
      toolchainPolicyHash: index.toolchainPolicyHash,
      nonPromotable: true,
    },
    packageIndex: index,
    standardTarget: standardObservation,
    companionTarget: companionObservation,
  };
};

const validateCommandReceipt = async ({
  store,
  receipt,
  namespace,
  drill,
  expectedAction,
  targetBinding,
  providerPolicy,
  approvalPolicy,
  approvalPolicyReference,
  executorSourceSha,
  nowMilliseconds,
}) => {
  assertExactKeys(
    receipt,
    [
      "action",
      "approvalPolicy",
      "completedAt",
      "drillId",
      "executorSourceSha",
      "issuerReceipt",
      "namespace",
      "providerCommandEvidence",
      "receiptKind",
      "schemaVersion",
      "sourceBindingId",
      "targetBindingId",
      "workflowRunId",
    ],
    "Policy drill command receipt",
  );
  assertReference(
    receipt.issuerReceipt,
    namespace,
    "Policy drill issuer receipt",
  );
  assertReference(
    receipt.approvalPolicy,
    namespace,
    "Policy drill approval policy",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== `policy-${expectedAction}-drill-command/v1` ||
    receipt.namespace !== namespace ||
    receipt.drillId !== drill.drillId ||
    receipt.action !== expectedAction ||
    !sameCanonicalValue(receipt.approvalPolicy, approvalPolicyReference) ||
    receipt.sourceBindingId !== drill.sourceBindingId ||
    receipt.targetBindingId !== drill.targetBindingId ||
    receipt.executorSourceSha !== executorSourceSha ||
    typeof receipt.workflowRunId !== "string" ||
    !/^[1-9][0-9]*$/.test(receipt.workflowRunId) ||
    !Number.isFinite(Date.parse(receipt.completedAt))
  ) {
    throw new Error("Policy drill command receipt identity is invalid");
  }
  const commandUrl = new URL(
    `/v2/deployments/${encodeURIComponent(targetBinding.providerDeploymentId)}/aliases`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  commandUrl.searchParams.set("teamId", providerPolicy.expectedTeamId);
  commandUrl.searchParams.sort();
  const command = await readHttpTransaction({
    store,
    namespace,
    reference: receipt.providerCommandEvidence,
    providerPolicy,
    nowMilliseconds,
    expectedMethod: "POST",
    expectedUrl: commandUrl.href,
    expectedStatus: 200,
    expectedContentType: "application/json",
    requireHsts: false,
    label: `Policy ${expectedAction} drill provider command`,
  });
  if (command.requestBodyBytes === null) {
    throw new Error("Policy drill provider command has no request body");
  }
  const requestBody = parseJsonStrict(
    command.requestBodyBytes.toString("utf8"),
    "Policy drill provider command request",
  );
  const responseBody = parseJsonStrict(
    command.responseBodyBytes.toString("utf8"),
    "Policy drill provider command response",
  );
  if (
    !sameCanonicalValue(requestBody, { alias: drill.drillDomain }) ||
    responseBody?.alias !== drill.drillDomain ||
    Date.parse(receipt.completedAt) !== command.observedAt
  ) {
    throw new Error("Policy drill provider command body or time is invalid");
  }
  await validateStoredOidcReceipt({
    store,
    namespace,
    reference: receipt.issuerReceipt,
    approvalPolicy,
    executorSourceSha,
    workflowRunId: receipt.workflowRunId,
    completedAt: receipt.completedAt,
    nowMilliseconds,
  });
  return {
    completedAt: Date.parse(receipt.completedAt),
    issuerReceipt: receipt.issuerReceipt,
    workflowRunId: receipt.workflowRunId,
  };
};

const validateProviderObservation = async ({
  store,
  observation,
  namespace,
  drill,
  expectedAction,
  targetBinding,
  targetManifest,
  providerPolicy,
  nowMilliseconds,
}) => {
  assertExactKeys(
    observation,
    [
      "action",
      "drillDomain",
      "drillId",
      "namespace",
      "observationKind",
      "observedAt",
      "observedDomains",
      "providerDeploymentId",
      "providerProjectId",
      "publicResponse",
      "schemaVersion",
    ],
    "Policy drill provider observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !== "policy-drill-provider-observation/v1" ||
    observation.namespace !== namespace ||
    observation.drillId !== drill.drillId ||
    observation.action !== expectedAction ||
    observation.providerProjectId !== targetBinding.providerProjectId ||
    observation.providerDeploymentId !== targetBinding.providerDeploymentId ||
    observation.drillDomain !== drill.drillDomain ||
    !Array.isArray(observation.observedDomains) ||
    observation.observedDomains.length === 0 ||
    !sameCanonicalValue(observation.observedDomains, [drill.drillDomain])
  ) {
    throw new Error("Policy drill provider observation identity is invalid");
  }
  const publicResponse = await readHttpTransaction({
    store,
    namespace,
    reference: observation.publicResponse,
    providerPolicy,
    nowMilliseconds,
    expectedMethod: "GET",
    expectedUrl: `https://${drill.drillDomain}/`,
    expectedStatus: 200,
    expectedBodySha256: targetManifest.publicResponseHashes["/"],
    expectedContentType: "text/html",
    requireHsts: true,
    label: `Policy ${expectedAction} drill public observation`,
  });
  if (Date.parse(observation.observedAt) !== publicResponse.observedAt) {
    throw new Error(
      "Policy drill observation time differs from public response",
    );
  }
  return { observedAt: publicResponse.observedAt };
};

export const validatePolicyDrillEvidence = async ({
  store,
  namespace,
  reference,
  expectedAction,
  previousReleasePolicy,
  proposedReleasePolicy,
  activeReleasePolicy,
  qaPackageIndex,
  sourceBinding,
  targetBinding,
  targetManifest,
  providerPolicy,
  approvalPolicy,
  approvalPolicyReference,
  executorSourceSha,
  nowMilliseconds,
}) => {
  const drillObject = await readCanonical({
    store,
    namespace,
    reference,
    label: `Policy ${expectedAction} drill`,
  });
  const drill = drillObject.value;
  assertExactKeys(
    drill,
    [
      "action",
      "activeReleasePolicy",
      "commandReceipt",
      "drillDomain",
      "drillId",
      "drillKind",
      "namespace",
      "previousReleasePolicy",
      "proposedReleasePolicy",
      "providerObservation",
      "qaPackageIndex",
      "schemaVersion",
      "sourceBindingId",
      "status",
      "targetBindingId",
    ],
    `Policy ${expectedAction} drill`,
  );
  if (
    drillObject.mediaType !== POLICY_QA_DRILL_MEDIA_TYPE ||
    drill.schemaVersion !== 1 ||
    drill.drillKind !== POLICY_ACTIVATION_DRILL_KIND ||
    drill.namespace !== namespace ||
    drill.action !== expectedAction ||
    drill.status !== "passed" ||
    typeof drill.drillId !== "string" ||
    drill.drillId.length === 0 ||
    drill.sourceBindingId !== (sourceBinding?.bindingId ?? null) ||
    drill.targetBindingId !== targetBinding.bindingId ||
    typeof drill.drillDomain !== "string" ||
    !sameCanonicalValue(drill.previousReleasePolicy, previousReleasePolicy) ||
    !sameCanonicalValue(drill.proposedReleasePolicy, proposedReleasePolicy) ||
    !sameCanonicalValue(drill.activeReleasePolicy, activeReleasePolicy) ||
    !sameCanonicalValue(drill.qaPackageIndex, qaPackageIndex)
  ) {
    throw new Error(`Policy ${expectedAction} drill binding is invalid`);
  }
  const [commandObject, observationObject] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: drill.commandReceipt,
      label: `Policy ${expectedAction} command receipt`,
    }),
    readCanonical({
      store,
      namespace,
      reference: drill.providerObservation,
      label: `Policy ${expectedAction} provider observation`,
    }),
  ]);
  if (
    commandObject.mediaType !== POLICY_QA_COMMAND_RECEIPT_MEDIA_TYPE ||
    observationObject.mediaType !== POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE
  ) {
    throw new Error(
      `Policy ${expectedAction} drill evidence media type is invalid`,
    );
  }
  const command = await validateCommandReceipt({
    store,
    receipt: commandObject.value,
    namespace,
    drill,
    expectedAction,
    targetBinding,
    providerPolicy,
    approvalPolicy,
    approvalPolicyReference,
    executorSourceSha,
    nowMilliseconds,
  });
  const observation = await validateProviderObservation({
    store,
    observation: observationObject.value,
    namespace,
    drill,
    expectedAction,
    targetBinding,
    targetManifest,
    providerPolicy,
    nowMilliseconds,
  });
  if (command.completedAt > observation.observedAt) {
    throw new Error("Policy drill observation precedes its provider command");
  }
  return {
    drill: reference,
    commandReceipt: drill.commandReceipt,
    providerObservation: drill.providerObservation,
    completedAt: command.completedAt,
    observedAt: observation.observedAt,
    drillDomain: drill.drillDomain,
    issuerReceipt: command.issuerReceipt,
    workflowRunId: command.workflowRunId,
  };
};

export const validatePolicyActivationQaExecutionBundle = async ({
  store,
  namespace,
  reference,
  operationId,
  previousReleasePolicy,
  proposedReleasePolicy,
  activeReleasePolicy,
  qaPackageReference,
  current,
  executorSourceSha,
  previousPolicy,
  proposedPolicy,
  activationGate,
  providerPolicy,
  approvalPolicy,
  approvalPolicyReference,
  nowMilliseconds,
}) => {
  const executionObject = await readCanonical({
    store,
    namespace,
    reference,
    label: "Policy QA reviewed execution bundle",
  });
  const execution = executionObject.value;
  assertExactKeys(
    execution,
    [
      "activationGate",
      "beforeAlias",
      "companionDeployment",
      "completedAt",
      "containment",
      "drillDomain",
      "evidenceKind",
      "evidenceRefs",
      "executorSourceSha",
      "finalStandard",
      "initialStandard",
      "issuerReceipt",
      "namespace",
      "operationId",
      "providerProductionDomains",
      "rollback",
      "schemaVersion",
      "standardDeployment",
      "subject",
      "targetSourceSha",
      "workflowRunId",
    ],
    "Policy QA execution bundle",
  );
  const directReferences = [
    execution.subject,
    execution.issuerReceipt,
    execution.standardDeployment,
    execution.companionDeployment,
    execution.beforeAlias,
    execution.initialStandard,
    execution.rollback,
    execution.containment,
    execution.finalStandard,
  ];
  for (const [index, evidenceReference] of directReferences.entries()) {
    assertReference(
      evidenceReference,
      namespace,
      `Policy QA execution reference ${index}`,
    );
  }
  const sortedEvidence = [...execution.evidenceRefs].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.sha256, "utf8"),
      Buffer.from(right.sha256, "utf8"),
    ),
  );
  if (
    executionObject.mediaType !== POLICY_QA_EXECUTION_MEDIA_TYPE ||
    execution.schemaVersion !== 1 ||
    execution.evidenceKind !== "policy-activation-qa-execution/v1" ||
    execution.namespace !== namespace ||
    execution.operationId !== operationId ||
    execution.executorSourceSha !== executorSourceSha ||
    execution.activationGate !== activationGate ||
    !/^[1-9][0-9]*$/.test(execution.workflowRunId) ||
    !Array.isArray(execution.evidenceRefs) ||
    !sameCanonicalValue(execution.evidenceRefs, sortedEvidence) ||
    new Set(execution.evidenceRefs.map((item) => item.sha256)).size !==
      execution.evidenceRefs.length ||
    directReferences.some(
      (direct) =>
        !execution.evidenceRefs.some(
          (candidate) => candidate.sha256 === direct.sha256,
        ),
    ) ||
    !sameCanonicalValue(
      execution.providerProductionDomains,
      providerPolicy.ownedProductionDomains,
    ) ||
    execution.providerProductionDomains.includes(execution.drillDomain) ||
    execution.drillDomain !==
      derivePolicyActivationQaDrillDomain({
        namespace,
        operationId,
        providerPolicy,
      })
  ) {
    throw new Error("Policy QA execution bundle identity is invalid");
  }
  await Promise.all(
    execution.evidenceRefs.map((evidenceReference, index) =>
      assertEvidenceObjectAvailable({
        store,
        namespace,
        reference: evidenceReference,
        label: `Policy QA execution evidence ${index}`,
      }),
    ),
  );
  const subjectObject = await readCanonical({
    store,
    namespace,
    reference: execution.subject,
    label: "Policy QA execution subject",
  });
  const subject = subjectObject.value;
  if (subjectObject.mediaType !== POLICY_QA_EXECUTION_SUBJECT_MEDIA_TYPE) {
    throw new Error("Policy QA execution subject media type is invalid");
  }
  assertPolicyActivationQaExecutionSubject({
    subject,
    snapshot: current.snapshot,
    providerPolicy,
  });
  if (
    subject.operationId !== operationId ||
    subject.executorSourceSha !== executorSourceSha ||
    subject.targetSourceSha !== execution.targetSourceSha ||
    subject.activationGate !== activationGate ||
    !sameCanonicalValue(subject.previousReleasePolicy, previousReleasePolicy) ||
    !sameCanonicalValue(subject.proposedReleasePolicy, proposedReleasePolicy) ||
    !sameCanonicalValue(subject.activeReleasePolicy, activeReleasePolicy) ||
    !sameCanonicalValue(subject.approvalPolicy, approvalPolicyReference) ||
    !sameCanonicalValue(subject.qaPackage, qaPackageReference) ||
    subject.expectedState.sequence !== current.head.sequence ||
    subject.expectedState.eventHash !== current.head.eventHash ||
    subject.drillDomain !== execution.drillDomain
  ) {
    throw new Error(
      "Policy QA execution subject differs from closure authority",
    );
  }
  const qaValidation = await validateNonPromotablePolicyQaPackage({
    store,
    namespace,
    packageReference: qaPackageReference,
    standardDeploymentObservationReference: execution.standardDeployment,
    companionDeploymentObservationReference: execution.companionDeployment,
    proposedPolicy,
    proposedPolicyReference: proposedReleasePolicy,
    activationGate,
    executorSourceSha,
    providerPolicy,
    approvalPolicy,
    nowMilliseconds,
  });
  const [
    acceptedManifestObject,
    standardManifestObject,
    companionManifestObject,
  ] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: current.snapshot.acceptedStandard.artifactManifest,
      label: "Policy QA accepted rollback manifest",
    }),
    readCanonical({
      store,
      namespace,
      reference: qaValidation.packageIndex.artifacts[0].manifest,
      label: "Policy QA standard drill manifest",
    }),
    readCanonical({
      store,
      namespace,
      reference: qaValidation.packageIndex.artifacts[1].manifest,
      label: "Policy QA companion drill manifest",
    }),
  ]);
  if (
    acceptedManifestObject.mediaType !==
    POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE
  ) {
    throw new Error(
      "Policy QA accepted rollback manifest media type is invalid",
    );
  }
  assertArtifactManifest(acceptedManifestObject.value, previousPolicy);
  if (
    current.snapshot.acceptedStandard.releaseRole !== "standard" ||
    acceptedManifestObject.value.releaseRole !== "standard" ||
    acceptedManifestObject.value.sourceSha !==
      current.snapshot.acceptedStandard.sourceSha ||
    acceptedManifestObject.value.variantId !==
      current.snapshot.acceptedStandard.variantId
  ) {
    throw new Error("Policy QA accepted rollback manifest binding differs");
  }
  const beforeObject = await readCanonical({
    store,
    namespace,
    reference: execution.beforeAlias,
    label: "Policy QA before-alias observation",
  });
  const before = beforeObject.value;
  assertExactKeys(
    before,
    [
      "action",
      "drillDomain",
      "drillId",
      "namespace",
      "observationKind",
      "observedAt",
      "observedDomains",
      "providerDeploymentId",
      "providerProjectId",
      "providerResponse",
      "publicResponse",
      "schemaVersion",
    ],
    "Policy QA before-alias observation",
  );
  const aliasLookup = new URL(
    `/v4/aliases/${encodeURIComponent(execution.drillDomain)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  aliasLookup.searchParams.set("teamId", providerPolicy.expectedTeamId);
  aliasLookup.searchParams.sort();
  const beforeTransaction = await readHttpTransaction({
    store,
    namespace,
    reference: before.providerResponse,
    providerPolicy,
    nowMilliseconds,
    expectedMethod: "GET",
    expectedUrl: aliasLookup.href,
    expectedStatus: 404,
    expectedContentType: "application/json",
    requireHsts: false,
    label: "Policy QA before-alias provider observation",
  });
  if (
    beforeObject.mediaType !== POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE ||
    before.schemaVersion !== 1 ||
    before.observationKind !== "policy-drill-provider-observation/v1" ||
    before.namespace !== namespace ||
    before.drillId !== `${operationId}:before` ||
    before.action !== "before" ||
    before.drillDomain !== execution.drillDomain ||
    before.providerProjectId !== providerPolicy.expectedProjectId ||
    before.providerDeploymentId !== null ||
    !sameCanonicalValue(before.observedDomains, [execution.drillDomain]) ||
    before.publicResponse !== null ||
    Date.parse(before.observedAt) !== beforeTransaction.observedAt
  ) {
    throw new Error(
      "Policy QA before-alias observation is not an unused alias",
    );
  }
  const [initial, rollback, containment, final] = await Promise.all([
    validatePolicyDrillEvidence({
      store,
      namespace,
      reference: execution.initialStandard,
      expectedAction: "initial-standard",
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      qaPackageIndex: qaPackageReference,
      sourceBinding: null,
      targetBinding: qaValidation.standardTarget,
      targetManifest: standardManifestObject.value,
      providerPolicy,
      approvalPolicy,
      approvalPolicyReference,
      executorSourceSha,
      nowMilliseconds,
    }),
    validatePolicyDrillEvidence({
      store,
      namespace,
      reference: execution.rollback,
      expectedAction: "rollback",
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      qaPackageIndex: qaPackageReference,
      sourceBinding: qaValidation.standardTarget,
      targetBinding: current.snapshot.acceptedStandard,
      targetManifest: acceptedManifestObject.value,
      providerPolicy,
      approvalPolicy,
      approvalPolicyReference,
      executorSourceSha,
      nowMilliseconds,
    }),
    validatePolicyDrillEvidence({
      store,
      namespace,
      reference: execution.containment,
      expectedAction: "containment",
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      qaPackageIndex: qaPackageReference,
      sourceBinding: current.snapshot.acceptedStandard,
      targetBinding: qaValidation.companionTarget,
      targetManifest: companionManifestObject.value,
      providerPolicy,
      approvalPolicy,
      approvalPolicyReference,
      executorSourceSha,
      nowMilliseconds,
    }),
    validatePolicyDrillEvidence({
      store,
      namespace,
      reference: execution.finalStandard,
      expectedAction: "final-standard",
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      qaPackageIndex: qaPackageReference,
      sourceBinding: qaValidation.companionTarget,
      targetBinding: qaValidation.standardTarget,
      targetManifest: standardManifestObject.value,
      providerPolicy,
      approvalPolicy,
      approvalPolicyReference,
      executorSourceSha,
      nowMilliseconds,
    }),
  ]);
  assertPolicyQaExecutionEvidenceSet({
    actual: execution.evidenceRefs,
    expected: [
      execution.subject,
      execution.issuerReceipt,
      execution.standardDeployment,
      qaValidation.standardTarget.deploymentReceipt,
      qaValidation.standardTarget.routeProbe,
      execution.companionDeployment,
      qaValidation.companionTarget.deploymentReceipt,
      qaValidation.companionTarget.routeProbe,
      execution.beforeAlias,
      initial.commandReceipt,
      initial.providerObservation,
      initial.drill,
      rollback.commandReceipt,
      rollback.providerObservation,
      rollback.drill,
      containment.commandReceipt,
      containment.providerObservation,
      containment.drill,
      final.commandReceipt,
      final.providerObservation,
      final.drill,
    ],
    namespace,
  });
  const issuerReferences = [
    qaValidation.standardTarget.deploymentIssuerReceipt,
    qaValidation.companionTarget.deploymentIssuerReceipt,
    initial.issuerReceipt,
    rollback.issuerReceipt,
    containment.issuerReceipt,
    final.issuerReceipt,
  ];
  const workflowRunIds = [
    qaValidation.standardTarget.deploymentWorkflowRunId,
    qaValidation.companionTarget.deploymentWorkflowRunId,
    initial.workflowRunId,
    rollback.workflowRunId,
    containment.workflowRunId,
    final.workflowRunId,
  ];
  const completedAt = assertFreshTimestamp({
    value: execution.completedAt,
    providerPolicy,
    nowMilliseconds,
    label: "Policy QA execution completedAt",
  });
  if (
    issuerReferences.some(
      (issuerReference) =>
        !sameCanonicalValue(issuerReference, execution.issuerReceipt),
    ) ||
    workflowRunIds.some(
      (workflowRunId) => workflowRunId !== execution.workflowRunId,
    ) ||
    beforeTransaction.observedAt > initial.completedAt ||
    initial.observedAt > rollback.completedAt ||
    rollback.observedAt > containment.completedAt ||
    containment.observedAt > final.completedAt ||
    final.observedAt > completedAt ||
    [initial, rollback, containment, final].some(
      (step) => step.drillDomain !== execution.drillDomain,
    )
  ) {
    throw new Error(
      "Policy QA execution order, issuer, or final restoration differs",
    );
  }
  return {
    qaValidation,
    drills: {
      initialStandardDrill: initial.drill,
      initialStandardCommandReceipt: initial.commandReceipt,
      initialStandardProviderObservation: initial.providerObservation,
      rollbackDrill: rollback.drill,
      rollbackCommandReceipt: rollback.commandReceipt,
      rollbackProviderObservation: rollback.providerObservation,
      containmentDrill: containment.drill,
      containmentCommandReceipt: containment.commandReceipt,
      containmentProviderObservation: containment.providerObservation,
      finalStandardDrill: final.drill,
      finalStandardCommandReceipt: final.commandReceipt,
      finalStandardProviderObservation: final.providerObservation,
      beforeAliasObservation: execution.beforeAlias,
      execution: reference,
    },
  };
};

export const buildAuthoritativePolicyActivationClosure = async (
  options,
  {
    readState = readCurrentReleaseState,
    validateExecution = validatePolicyActivationQaExecutionBundle,
    nowMilliseconds = Date.now(),
  } = {},
) => {
  for (const field of FORBIDDEN_RESULT_FIELDS) {
    if (Object.hasOwn(options ?? {}, field)) {
      throw new Error(`Caller-supplied policy closure ${field} is forbidden`);
    }
  }
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    qaExecutionReference,
  } = options ?? {};
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    store.namespace !== namespace ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !SOURCE_SHA_PATTERN.test(executorSourceSha)
  ) {
    throw new Error("Policy closure producer identity or store is invalid");
  }
  assertReference(qaExecutionReference, namespace, "QA execution");
  const reviewedExecutionObject = await readCanonical({
    store,
    namespace,
    reference: qaExecutionReference,
    label: "Policy QA reviewed execution bundle",
  });
  if (
    reviewedExecutionObject.mediaType !== POLICY_QA_EXECUTION_MEDIA_TYPE ||
    reviewedExecutionObject.value?.operationId !== operationId ||
    reviewedExecutionObject.value?.executorSourceSha !== executorSourceSha
  ) {
    throw new Error("Policy QA reviewed execution identity is invalid");
  }
  assertReference(
    reviewedExecutionObject.value.subject,
    namespace,
    "Policy QA execution subject",
  );
  const reviewedSubjectObject = await readCanonical({
    store,
    namespace,
    reference: reviewedExecutionObject.value.subject,
    label: "Policy QA execution subject",
  });
  const reviewedSubject = reviewedSubjectObject.value;
  if (
    reviewedSubjectObject.mediaType !==
      POLICY_QA_EXECUTION_SUBJECT_MEDIA_TYPE ||
    reviewedSubject?.operationId !== operationId ||
    reviewedSubject?.executorSourceSha !== executorSourceSha
  ) {
    throw new Error("Policy QA reviewed execution subject identity is invalid");
  }
  const proposedPolicyReference = reviewedSubject.proposedReleasePolicy;
  const activePolicyReference = reviewedSubject.activeReleasePolicy;
  const approvalPolicyReference = reviewedSubject.approvalPolicy;
  const qaPackageReference = reviewedSubject.qaPackage;
  for (const [label, reference] of [
    ["Proposed policy", proposedPolicyReference],
    ["Active policy", activePolicyReference],
    ["Approval policy", approvalPolicyReference],
    ["QA package", qaPackageReference],
  ]) {
    assertReference(reference, namespace, label);
  }
  const current = await readState({ store });
  if (
    current.snapshot.pendingOperation !== null ||
    current.snapshot.pendingAcceptance !== null ||
    current.snapshot.acceptedStandard === null
  ) {
    throw new Error("Policy closure requires an idle accepted Release State");
  }
  const previousReleasePolicy = current.snapshot.activeReleasePolicy;
  const [
    previousObject,
    proposedObject,
    activeObject,
    providerPolicyObject,
    approvalPolicyObject,
  ] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: previousReleasePolicy,
      label: "Previous active policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: proposedPolicyReference,
      label: "Proposed policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: activePolicyReference,
      label: "Target active policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: current.snapshot.acceptedStandard.providerPolicy,
      label: "Policy activation provider policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: approvalPolicyReference,
      label: "Policy activation approval policy",
    }),
  ]);
  const providerPolicy = assertConfiguredProviderPolicy(
    providerPolicyObject.value,
  );
  const approvalPolicy = assertConfiguredApprovalPolicy(
    approvalPolicyObject.value,
  );
  const transition = derivePolicyActivationTransition({
    previousPolicy: previousObject.value,
    proposedPolicy: proposedObject.value,
    activePolicy: activeObject.value,
    acceptedGate: current.snapshot.acceptedGate,
    acceptedStandardFloors: current.snapshot.acceptedStandardFloors,
    currentFloors: current.snapshot.minimumSafetyFloors,
    previousReleasePolicy,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
  });
  assertPolicyCompatibilityEntries(
    activeObject.value.compatiblePredecessorPolicies,
    {
      namespace,
      minimumSafetyFloors: transition.minimumSafetyFloors,
      currentDbCompatibility: current.snapshot.currentDbCompatibility,
      nowMilliseconds,
    },
  );
  const executionValidation = await validateExecution({
    store,
    namespace,
    reference: qaExecutionReference,
    operationId,
    previousReleasePolicy,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
    qaPackageReference,
    current,
    activationGate: transition.activationGate,
    executorSourceSha,
    previousPolicy: previousObject.value,
    proposedPolicy: proposedObject.value,
    providerPolicy,
    approvalPolicy,
    approvalPolicyReference,
    nowMilliseconds,
  });
  const { qaValidation, drills } = executionValidation;
  const common = {
    schemaVersion: 1,
    namespace,
    operationId,
    activationGate: transition.activationGate,
    previousReleasePolicy,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
    status: "passed",
  };
  const receiptValues = {
    nonProductionQa: {
      ...common,
      receiptKind: RECEIPT_KINDS.nonProductionQa,
      result: qaValidation.receiptResult,
    },
    schemaValidation: {
      ...common,
      receiptKind: RECEIPT_KINDS.schemaValidation,
      result: { policySchema: "release-policy/v1", valid: true },
    },
    monotonicity: {
      ...common,
      receiptKind: RECEIPT_KINDS.monotonicity,
      result: {
        behaviorDimensionChange: transition.behaviorDimensionChange,
        minimumSafetyFloorChange: transition.minimumSafetyFloorChange,
        minimumSafetyFloors: transition.minimumSafetyFloors,
      },
    },
    predecessorCompatibility: {
      ...common,
      receiptKind: RECEIPT_KINDS.predecessorCompatibility,
      result: {
        compatible: true,
        closedBlockers:
          transition.activationGate === "P8-CLEAN"
            ? []
            : proposedObject.value.activationBlockers,
        compatibility: activeObject.value.compatiblePredecessorPolicies,
      },
    },
    rollbackContainmentDrill: {
      ...common,
      receiptKind: RECEIPT_KINDS.rollbackContainmentDrill,
      result: drills,
    },
  };
  const storedReceipts = {};
  for (const [field, value] of Object.entries(receiptValues)) {
    storedReceipts[field] = (
      await putCanonical({
        store,
        namespace,
        value,
        mediaType: RECEIPT_MEDIA_TYPE,
        label: `Policy closure ${field} receipt`,
      })
    ).reference;
  }
  const bundle = {
    schemaVersion: 1,
    bundleKind: POLICY_ACTIVATION_CLOSURE_KIND,
    namespace,
    operationId,
    activationGate: transition.activationGate,
    previousReleasePolicy,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
    receipts: storedReceipts,
  };
  const storedBundle = await putCanonical({
    store,
    namespace,
    value: bundle,
    mediaType: BUNDLE_MEDIA_TYPE,
    label: "Policy activation closure bundle",
  });
  return {
    bundle,
    bundleBytes: storedBundle.bytes,
    bundleSha256: storedBundle.reference.sha256,
    bundleReference: storedBundle.reference,
    receiptReferences: storedReceipts,
  };
};
