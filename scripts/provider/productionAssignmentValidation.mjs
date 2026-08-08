import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { buildAuthoritativeProviderAliasObservation } from "../release-state/authoritativeInputProducers.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import { decideProviderReconciliation } from "../release-state/reconcileDecision.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  assertImmutableObjectReference,
  compareUtf8,
  isRecord,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";
import { assertVercelObservationEvidence } from "./collect-vercel-observation.mjs";
import { validatePreparedPromotionResult } from "./preparedPromotion.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PUBLIC_PATH_PATTERN = /^\/(?!\/)[^\\?#%]*$/;
const MAX_PREPARED_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_PROMOTION_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_ASSIGNMENT_AUTHORITY_BYTES = 64 * 1024;
const MAX_STORED_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_ROUTE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_DECLARED_ROUTES = 512;
const MAX_HTTP_REQUESTS = 4096;
const HTTP_TIMEOUT_MILLISECONDS = 15_000;
const SECRET_NAME_PATTERN =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|CA_PEM|PRIVATE_KEY)(?:$|_)/i;
const FORBIDDEN_CALLER_AUTHORITY_FIELDS = [
  "assignmentValidation",
  "assignments",
  "deploymentId",
  "deploymentUrl",
  "domains",
  "productionProbe",
  "providerDeploymentId",
  "providerProjectId",
  "result",
  "route",
  "routes",
  "target",
  "targetBinding",
];
const PROMOTION_RECEIPT_KEYS = [
  "afterObservation",
  "afterProviderObservation",
  "approvalReferences",
  "assignmentEvidence",
  "beforeObservation",
  "beforeProviderObservation",
  "cli",
  "companion",
  "completedAt",
  "idempotencyKey",
  "outcome",
  "preparedEvent",
  "provider",
  "providerBinding",
  "receiptKind",
  "schemaVersion",
  "sourceSha",
  "target",
];
const PREPARED_EVENT_KEYS = [
  "committedAt",
  "operationId",
  "sequence",
  "sha256",
  "uri",
];
const TARGET_KEYS = [
  "bindingId",
  "deploymentUrl",
  "providerDeploymentEvidenceSha256",
  "providerDeploymentId",
  "releaseRole",
];
const COMPANION_KEYS = [
  "bindingId",
  "providerDeploymentEvidenceSha256",
  "providerDeploymentId",
  "releaseRole",
];
const PROVIDER_BINDING_KEYS = [
  "afterProviderObservationSha256",
  "beforeProviderObservationSha256",
  "providerConfigurationHash",
  "providerPolicySha256",
  "providerProjectId",
  "providerTeamId",
];
const ASSIGNMENT_EVIDENCE_KEYS = [
  "assignmentApiReceiptSetHash",
  "assignments",
  "evidenceKind",
  "providerProjectId",
  "schemaVersion",
];
const ASSIGNMENT_VALIDATION_KEYS = [
  "assignmentReceiptSha256",
  "assignmentReceiptUri",
  "assignments",
  "evidenceKind",
  "productionProbeEvidenceHash",
  "providerProjectId",
  "schemaVersion",
];
const ASSIGNMENT_AUTHORITY_KEYS = [
  "assignmentReceipt",
  "evidenceKind",
  "namespace",
  "preparedResultSha256",
  "promotionReceipt",
  "providerAssignmentObservation",
  "providerDeploymentId",
  "providerProjectId",
  "schemaVersion",
  "targetBindingId",
];
const IMMUTABLE_REFERENCE_KEYS = ["sha256", "uri"];
const ASSIGNMENT_KEYS = [
  "assignedDeploymentId",
  "previousDeploymentId",
  "productionDomain",
];
const OBSERVATION_WRAPPER_KEYS = ["sha256", "value"];
const APPROVAL_REFERENCE_KEYS = ["role", "sha256", "uri"];
const CLI_KEYS = ["executed", "operation", "package", "version"];
const DOMAIN_OBSERVATION_KEYS = [
  "observationKind",
  "observedAt",
  "phase",
  "providerProjectId",
  "providerTeamId",
  "receipts",
  "schemaVersion",
];
const DOMAIN_RECEIPT_WRAPPER_KEYS = [
  "productionDomain",
  "receipt",
  "receiptSha256",
];
const DOMAIN_RECEIPT_KEYS = [
  "assignedDeploymentId",
  "bodySha256",
  "etag",
  "method",
  "phase",
  "productionDomain",
  "providerProjectId",
  "receiptKind",
  "requestUrl",
  "responseDate",
  "schemaVersion",
  "status",
];
const ROUTE_PROBE_KEYS = [
  "cspPolicy",
  "deploymentReceipt",
  "deploymentUrl",
  "evidenceKind",
  "namespace",
  "observedAt",
  "providerDeploymentId",
  "providerProjectId",
  "routes",
  "runtimeHtmlIdentity",
  "schemaVersion",
];
const IMMUTABLE_ROUTE_RECEIPT_KEYS = [
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
];
const SECURITY_HEADER_KEYS = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
];
const HTTP_RECEIPT_KEYS = [
  "allow",
  "bodySha256",
  "byteLength",
  "cacheControl",
  "contentType",
  "etag",
  "method",
  "path",
  "requestUrl",
  "responseDate",
  "responseUrl",
  "securityHeaders",
  "status",
];
const PRODUCTION_PROBE_KEYS = [
  "evidenceKind",
  "immutableApiReceipts",
  "immutableRouteProbeEvidenceHash",
  "observedAt",
  "providerAssignmentObservation",
  "providerDeploymentEvidenceHash",
  "providerDeploymentId",
  "providerProjectId",
  "results",
  "schemaVersion",
];
const PRODUCTION_RESULT_KEYS = [
  "productionDomain",
  "providerDeploymentId",
  "receipts",
  "responseSha256",
  "status",
];
const PROMOTION_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.prepared-promotion-receipt+json;version=1";
const ASSIGNMENT_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-assignment-receipt+json;version=1";
const PROVIDER_ASSIGNMENT_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-alias-observation+json;version=1";
const PROVIDER_ALIAS_RESPONSE_MEDIA_TYPE =
  "application/vnd.vercel.alias-response+json";
const PROVIDER_ALIAS_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1";
const PROVIDER_ALIAS_OBSERVATION_KEYS = [
  "assignments",
  "namespace",
  "observationKind",
  "observedBinding",
  "providerProjectId",
  "providerReceiptReferences",
  "schemaVersion",
];
const PROVIDER_ALIAS_ASSIGNMENT_KEYS = [
  "assignedDeploymentId",
  "productionDomain",
];
const PROVIDER_ALIAS_RECEIPT_KEYS = [
  "productionDomain",
  "providerDate",
  "providerDeploymentId",
  "providerProjectId",
  "receiptKind",
  "requestUrl",
  "responseReference",
  "responseSha256",
  "responseUrl",
  "schemaVersion",
  "status",
];
const API_ROUTE_EXPECTATIONS = Object.freeze([
  {
    path: "/api",
    status: 404,
    body: Buffer.from('{"error":"api-not-found"}'),
    cacheControl: "no-store",
    contentType: "application/json",
    allow: null,
  },
  {
    path: "/api/__foundation-assignment-validation__",
    status: 404,
    body: Buffer.from('{"error":"api-not-found"}'),
    cacheControl: "no-store",
    contentType: "application/json",
    allow: null,
  },
  {
    path: "/api/persistence-release-a-metrics",
    status: 405,
    body: Buffer.from('{"error":"method-not-allowed"}'),
    cacheControl: "no-store",
    contentType: "application/json",
    allow: "POST",
  },
  {
    path: "/api/csp-report",
    status: 405,
    body: Buffer.alloc(0),
    cacheControl: "no-store",
    contentType: null,
    allow: "POST",
  },
  {
    path: "/api/google-sheets-csv",
    status: 405,
    body: Buffer.alloc(0),
    cacheControl: "no-store",
    contentType: null,
    allow: "POST",
  },
]);

const assertNoCallerAuthority = (options) => {
  if (!isRecord(options)) {
    throw new Error("Production assignment validation options are invalid");
  }
  for (const field of FORBIDDEN_CALLER_AUTHORITY_FIELDS) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `Caller-supplied ${field} is forbidden; assignment authority comes from replayed state`,
      );
    }
  }
};

const assertStore = (store, namespace) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !store ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function" ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error(
      "Production assignment Release State store binding is invalid",
    );
  }
};

const assertBoundedCanonicalInput = (bytes, maximum, label) => {
  const input = Buffer.from(bytes ?? "");
  if (input.length < 1 || input.length > maximum) {
    throw new Error(`${label} is empty or oversized`);
  }
  const value = parseCanonicalJsonBytes(input, label);
  return { bytes: input, value };
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
  if (secrets.some((secret) => Buffer.from(bytes).includes(secret))) {
    throw new Error(`${label} contains a protected secret value`);
  }
};

const assertIsoTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return milliseconds;
};

const assertFreshDate = ({ value, providerPolicy, nowMilliseconds, label }) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    nowMilliseconds - milliseconds >
      providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    milliseconds - nowMilliseconds >
      providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(`${label} is stale, future, or invalid`);
  }
  return milliseconds;
};

const assertSafePublicPath = (publicPath) => {
  if (
    typeof publicPath !== "string" ||
    publicPath.length === 0 ||
    publicPath.length > 2048 ||
    !PUBLIC_PATH_PATTERN.test(publicPath) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(publicPath) ||
    publicPath.includes("//") ||
    [...publicPath].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(
      `Production route path is unsafe or aliased: ${publicPath}`,
    );
  }
  return publicPath;
};

const assertHttpsOrigin = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} is not an exact HTTPS origin`);
  }
  const origin = `https://${parsed.hostname.toLowerCase()}`;
  if (value !== origin) {
    throw new Error(`${label} is not canonical`);
  }
  return origin;
};

const assertCanonicalWrappedObservation = ({
  wrapper,
  label,
  expectedSha256 = null,
}) => {
  assertExactKeys(wrapper, OBSERVATION_WRAPPER_KEYS, label);
  const sha256 = sha256Json(wrapper.value);
  if (
    wrapper.sha256 !== sha256 ||
    (expectedSha256 !== null && wrapper.sha256 !== expectedSha256)
  ) {
    throw new Error(`${label} hash differs from its canonical value`);
  }
  return wrapper.value;
};

const expectedAliasRequestUrl = ({ providerPolicy, domain }) => {
  const url = new URL(
    `/v4/aliases/${encodeURIComponent(domain)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  url.searchParams.set("projectId", providerPolicy.expectedProjectId);
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  url.searchParams.sort();
  return url.href;
};

const assertAssignments = ({
  assignments,
  providerPolicy,
  targetDeploymentId,
  label,
}) => {
  if (!Array.isArray(assignments)) {
    throw new Error(`${label} assignments are invalid`);
  }
  const domains = [];
  for (const assignment of assignments) {
    assertExactKeys(assignment, ASSIGNMENT_KEYS, `${label} assignment`);
    if (
      typeof assignment.productionDomain !== "string" ||
      !DOMAIN_PATTERN.test(assignment.productionDomain) ||
      assignment.assignedDeploymentId !== targetDeploymentId ||
      (assignment.previousDeploymentId !== null &&
        (typeof assignment.previousDeploymentId !== "string" ||
          assignment.previousDeploymentId.length === 0 ||
          assignment.previousDeploymentId.length > 255))
    ) {
      throw new Error(`${label} assignment is invalid`);
    }
    domains.push(assignment.productionDomain);
  }
  if (
    !sameCanonicalValue(domains, providerPolicy.ownedProductionDomains) ||
    new Set(domains).size !== domains.length
  ) {
    throw new Error(`${label} does not cover the owned domain set`);
  }
  return assignments;
};

const assertDomainObservation = ({
  observation,
  phase,
  providerPolicy,
  targetDeploymentId,
  previousDeploymentId,
  nowMilliseconds,
}) => {
  assertExactKeys(
    observation,
    DOMAIN_OBSERVATION_KEYS,
    `${phase} domain observation`,
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !== "vercel-owned-domain-assignment/v1" ||
    observation.phase !== phase ||
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    observation.providerTeamId !== providerPolicy.expectedTeamId ||
    !Array.isArray(observation.receipts)
  ) {
    throw new Error(`${phase} domain observation binding is invalid`);
  }
  assertIsoTimestamp(observation.observedAt, `${phase} observation time`);
  const domains = observation.receipts.map((entry) => entry.productionDomain);
  if (
    !sameCanonicalValue(domains, providerPolicy.ownedProductionDomains) ||
    new Set(domains).size !== domains.length
  ) {
    throw new Error(`${phase} domain observation set differs from policy`);
  }
  const responseDates = [];
  const assignedDeploymentIds = new Set();
  for (const entry of observation.receipts) {
    assertExactKeys(
      entry,
      DOMAIN_RECEIPT_WRAPPER_KEYS,
      `${phase} domain receipt`,
    );
    assertExactKeys(
      entry.receipt,
      DOMAIN_RECEIPT_KEYS,
      `${phase} authoritative domain receipt`,
    );
    const receipt = entry.receipt;
    if (
      entry.receiptSha256 !== sha256Json(receipt) ||
      receipt.schemaVersion !== 1 ||
      receipt.receiptKind !== "vercel-domain-assignment-observation/v1" ||
      receipt.phase !== phase ||
      receipt.productionDomain !== entry.productionDomain ||
      receipt.method !== "GET" ||
      receipt.requestUrl !==
        expectedAliasRequestUrl({
          providerPolicy,
          domain: entry.productionDomain,
        }) ||
      receipt.status !== 200 ||
      !SHA256_PATTERN.test(receipt.bodySha256) ||
      !(
        receipt.etag === null ||
        (typeof receipt.etag === "string" &&
          receipt.etag.length > 0 &&
          receipt.etag.length <= 512)
      ) ||
      receipt.providerProjectId !== providerPolicy.expectedProjectId ||
      typeof receipt.assignedDeploymentId !== "string" ||
      receipt.assignedDeploymentId.length === 0 ||
      receipt.assignedDeploymentId.length > 255
    ) {
      throw new Error(`${phase} domain receipt hash or binding is invalid`);
    }
    const responseDate = assertFreshDate({
      value: receipt.responseDate,
      providerPolicy,
      nowMilliseconds,
      label: `${phase} authoritative domain Date`,
    });
    responseDates.push(responseDate);
    assignedDeploymentIds.add(receipt.assignedDeploymentId);
    if (
      phase === "after" &&
      receipt.assignedDeploymentId !== targetDeploymentId
    ) {
      throw new Error(
        "After-promotion domain does not target the prepared deployment",
      );
    }
  }
  const allowedBefore = new Set(
    [targetDeploymentId, previousDeploymentId].filter(
      (value) => typeof value === "string",
    ),
  );
  if (
    assignedDeploymentIds.size !== 1 ||
    (phase === "before" &&
      !allowedBefore.has(
        observation.receipts[0]?.receipt.assignedDeploymentId,
      )) ||
    (phase === "after" &&
      observation.receipts[0]?.receipt.assignedDeploymentId !==
        targetDeploymentId)
  ) {
    throw new Error(
      `${phase} domains do not uniformly target the prepared lineage`,
    );
  }
  return { responseDates, observation };
};

const assertProviderObservation = ({
  observation,
  label,
  providerPolicy,
  expectedConfigurationHash,
  nowMilliseconds,
  validator,
}) => {
  validator(observation, providerPolicy, nowMilliseconds);
  if (
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    observation.providerTeamId !== providerPolicy.expectedTeamId ||
    !sameCanonicalValue(
      observation.ownedProductionDomains,
      providerPolicy.ownedProductionDomains,
    ) ||
    providerConfigurationHash(observation) !== expectedConfigurationHash
  ) {
    throw new Error(`${label} provider observation binding is invalid`);
  }
  return observation.evidenceReceipts.map((receipt) =>
    assertFreshDate({
      value: receipt.responseDate,
      providerPolicy,
      nowMilliseconds,
      label: `${label} provider Date`,
    }),
  );
};

const validatePromotionReceipt = ({
  receiptBytes,
  validatedPrepared,
  providerPolicy,
  toolchainPolicy,
  nowMilliseconds,
  providerObservationValidator,
}) => {
  const receipt = parseCanonicalJsonBytes(
    receiptBytes,
    "Prepared promotion receipt",
  );
  assertExactKeys(receipt, PROMOTION_RECEIPT_KEYS, "Promotion receipt");
  const { result, event, operation, providerPolicySha256 } = validatedPrepared;
  const target = operation.targetBinding;
  const companion = operation.companionBinding;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== "vercel-prepared-promotion/v1" ||
    receipt.provider !== "vercel" ||
    !["promoted", "replayed"].includes(receipt.outcome) ||
    receipt.sourceSha !== target.sourceSha ||
    !SOURCE_SHA_PATTERN.test(receipt.sourceSha)
  ) {
    throw new Error("Promotion receipt identity is invalid");
  }
  assertExactKeys(receipt.preparedEvent, PREPARED_EVENT_KEYS, "Prepared event");
  if (
    receipt.preparedEvent.uri !== result.eventUri ||
    receipt.preparedEvent.sha256 !== result.eventHash ||
    receipt.preparedEvent.sequence !== event.sequence ||
    receipt.preparedEvent.operationId !== event.operationId ||
    receipt.preparedEvent.committedAt !== result.committedAt
  ) {
    throw new Error("Promotion receipt prepared event differs");
  }
  assertExactKeys(receipt.target, TARGET_KEYS, "Promotion target");
  assertExactKeys(receipt.companion, COMPANION_KEYS, "Promotion companion");
  if (
    receipt.target.bindingId !== target.bindingId ||
    receipt.target.releaseRole !== "standard" ||
    receipt.target.providerDeploymentId !== target.providerDeploymentId ||
    receipt.target.deploymentUrl !== target.deploymentUrl ||
    receipt.target.providerDeploymentEvidenceSha256 !==
      target.providerEvidence.sha256 ||
    receipt.companion.bindingId !== companion.bindingId ||
    receipt.companion.releaseRole !== "containment" ||
    receipt.companion.providerDeploymentId !== companion.providerDeploymentId ||
    receipt.companion.providerDeploymentEvidenceSha256 !==
      companion.providerEvidence.sha256
  ) {
    throw new Error("Promotion receipt target pair differs from pending state");
  }
  assertExactKeys(
    receipt.providerBinding,
    PROVIDER_BINDING_KEYS,
    "Promotion provider binding",
  );
  if (
    receipt.providerBinding.providerTeamId !== providerPolicy.expectedTeamId ||
    receipt.providerBinding.providerProjectId !==
      providerPolicy.expectedProjectId ||
    receipt.providerBinding.providerPolicySha256 !== providerPolicySha256 ||
    receipt.providerBinding.providerConfigurationHash !==
      target.providerConfigurationHash ||
    !SHA256_PATTERN.test(
      receipt.providerBinding.beforeProviderObservationSha256,
    ) ||
    !SHA256_PATTERN.test(receipt.providerBinding.afterProviderObservationSha256)
  ) {
    throw new Error("Promotion provider binding differs from policy or target");
  }
  if (
    !Array.isArray(receipt.approvalReferences) ||
    receipt.approvalReferences.length !== result.approvalRefs.length
  ) {
    throw new Error("Promotion approval reference set is invalid");
  }
  receipt.approvalReferences.forEach((reference, index) => {
    assertExactKeys(
      reference,
      APPROVAL_REFERENCE_KEYS,
      "Promotion approval reference",
    );
    const expected = result.approvalRefs[index];
    if (
      reference.role !== expected.role ||
      reference.uri !== expected.uri ||
      reference.sha256 !== expected.sha256
    ) {
      throw new Error("Promotion approval reference differs");
    }
  });
  assertExactKeys(receipt.cli, CLI_KEYS, "Promotion CLI receipt");
  if (
    receipt.cli.package !== "vercel" ||
    receipt.cli.operation !== "promote" ||
    receipt.cli.version !== toolchainPolicy.packages?.vercel ||
    typeof receipt.cli.executed !== "boolean" ||
    (receipt.outcome === "promoted" && receipt.cli.executed !== true) ||
    (receipt.outcome === "replayed" && receipt.cli.executed !== false)
  ) {
    throw new Error("Promotion CLI receipt is invalid");
  }
  const expectedIdempotencyKey = `promotion:${sha256Json({
    kind: "prepared-provider-promotion/v1",
    eventHash: result.eventHash,
    providerTeamId: providerPolicy.expectedTeamId,
    providerProjectId: providerPolicy.expectedProjectId,
    domains: providerPolicy.ownedProductionDomains,
    targetDeploymentId: target.providerDeploymentId,
  })}`;
  if (receipt.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error("Promotion idempotency binding differs");
  }

  const beforeProvider = assertCanonicalWrappedObservation({
    wrapper: receipt.beforeProviderObservation,
    label: "Before provider observation",
    expectedSha256: receipt.providerBinding.beforeProviderObservationSha256,
  });
  const afterProvider = assertCanonicalWrappedObservation({
    wrapper: receipt.afterProviderObservation,
    label: "After provider observation",
    expectedSha256: receipt.providerBinding.afterProviderObservationSha256,
  });
  const before = assertCanonicalWrappedObservation({
    wrapper: receipt.beforeObservation,
    label: "Before domain observation",
  });
  const after = assertCanonicalWrappedObservation({
    wrapper: receipt.afterObservation,
    label: "After domain observation",
  });
  const responseDates = [
    ...assertProviderObservation({
      observation: beforeProvider,
      label: "Before",
      providerPolicy,
      expectedConfigurationHash: target.providerConfigurationHash,
      nowMilliseconds,
      validator: providerObservationValidator,
    }),
    ...assertProviderObservation({
      observation: afterProvider,
      label: "After",
      providerPolicy,
      expectedConfigurationHash: target.providerConfigurationHash,
      nowMilliseconds,
      validator: providerObservationValidator,
    }),
  ];
  const beforeDomains = assertDomainObservation({
    observation: before,
    phase: "before",
    providerPolicy,
    targetDeploymentId: target.providerDeploymentId,
    previousDeploymentId:
      operation.previousBinding?.providerDeploymentId ?? null,
    nowMilliseconds,
  });
  const afterDomains = assertDomainObservation({
    observation: after,
    phase: "after",
    providerPolicy,
    targetDeploymentId: target.providerDeploymentId,
    previousDeploymentId:
      operation.previousBinding?.providerDeploymentId ?? null,
    nowMilliseconds,
  });
  responseDates.push(
    ...beforeDomains.responseDates,
    ...afterDomains.responseDates,
  );
  const completedMilliseconds = assertIsoTimestamp(
    receipt.completedAt,
    "Promotion completedAt",
  );
  if (
    nowMilliseconds - completedMilliseconds >
      providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    completedMilliseconds - nowMilliseconds >
      providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000 ||
    responseDates.some(
      (responseDate) =>
        responseDate > completedMilliseconds ||
        completedMilliseconds - responseDate >
          providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000,
    )
  ) {
    throw new Error(
      "Promotion completedAt is outside authoritative provider Dates",
    );
  }

  assertExactKeys(
    receipt.assignmentEvidence,
    ASSIGNMENT_EVIDENCE_KEYS,
    "Assignment receipt evidence",
  );
  const assignmentEvidence = receipt.assignmentEvidence;
  if (
    assignmentEvidence.schemaVersion !== 1 ||
    assignmentEvidence.evidenceKind !== "assignment-receipt" ||
    assignmentEvidence.providerProjectId !== providerPolicy.expectedProjectId ||
    assignmentEvidence.assignmentApiReceiptSetHash !==
      sha256Json({
        before: before.receipts,
        after: after.receipts,
      })
  ) {
    throw new Error("Assignment receipt evidence binding is invalid");
  }
  assertAssignments({
    assignments: assignmentEvidence.assignments,
    providerPolicy,
    targetDeploymentId: target.providerDeploymentId,
    label: "Assignment receipt evidence",
  });
  const derivedAssignments = after.receipts.map((entry) => ({
    productionDomain: entry.productionDomain,
    previousDeploymentId:
      before.receipts.find(
        (candidate) => candidate.productionDomain === entry.productionDomain,
      )?.receipt.assignedDeploymentId ?? null,
    assignedDeploymentId: entry.receipt.assignedDeploymentId,
  }));
  if (!sameCanonicalValue(derivedAssignments, assignmentEvidence.assignments)) {
    throw new Error(
      "Assignment receipt evidence differs from authoritative observations",
    );
  }
  return {
    receipt,
    assignmentEvidence,
    completedMilliseconds,
  };
};

const assertPreparedState = ({ current, validatedPrepared, namespace }) => {
  const { result, event, operation } = validatedPrepared;
  if (
    !isRecord(current) ||
    !isRecord(current.snapshot) ||
    event.namespace !== namespace ||
    current.snapshot.pendingOperation === null ||
    !sameCanonicalValue(current.snapshot.pendingOperation, operation)
  ) {
    throw new Error(
      "Prepared promotion result differs from the replayed pending operation",
    );
  }
  const records = current.records.filter(
    (record) =>
      record.sequence === event.sequence &&
      record.eventHash === result.eventHash,
  );
  if (
    records.length !== 1 ||
    !sameCanonicalValue(records[0].event, event) ||
    result.head.sequence !== event.sequence ||
    result.head.eventHash !== result.eventHash
  ) {
    throw new Error(
      "Prepared promotion result is not the exact committed state event",
    );
  }
  return current;
};

const readBoundedEvidence = async ({ store, namespace, reference, label }) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (stored.bytes.length > MAX_STORED_EVIDENCE_BYTES) {
    throw new Error(`${label} is oversized`);
  }
  return stored;
};

const immutableEvidenceReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const putVerifiedEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const expected = immutableEvidenceReference(namespace, bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== expected.uri ||
    receipt?.sha256 !== expected.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt differs`);
  }
  const stored = await readBoundedEvidence({
    store,
    namespace,
    reference: expected,
    label,
  });
  if (!stored.bytes.equals(bytes) || stored.mediaType !== mediaType) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return expected;
};

const assertClosedImmutableReference = (reference, namespace, label) => {
  assertExactKeys(reference, IMMUTABLE_REFERENCE_KEYS, label);
  assertImmutableObjectReference(reference, namespace, label);
  return reference;
};

const readExactEvidence = async ({
  store,
  namespace,
  reference,
  expectedBytes,
  expectedMediaType,
  label,
}) => {
  const stored = await readBoundedEvidence({
    store,
    namespace,
    reference,
    label,
  });
  if (
    stored.mediaType !== expectedMediaType ||
    (expectedBytes !== undefined && !stored.bytes.equals(expectedBytes))
  ) {
    throw new Error(`${label} immutable-store content differs`);
  }
  return stored;
};

const parseStrictUtf8Json = (bytes, label) => {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return parseJsonStrict(text, label);
};

const assertProviderAliasRequestUrl = ({
  requestUrl,
  productionDomain,
  providerPolicy,
}) => {
  const expected = new URL(
    `/v4/aliases/${encodeURIComponent(productionDomain)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  expected.searchParams.set("teamId", providerPolicy.expectedTeamId);
  if (requestUrl !== expected.href) {
    throw new Error("Provider alias receipt request URL differs from policy");
  }
};

const validateProviderAliasObservationChain = async ({
  store,
  namespace,
  observationReference,
  target,
  assignmentEvidence,
  providerPolicy,
  nowMilliseconds,
  requireFresh,
}) => {
  const storedObservation = await readExactEvidence({
    store,
    namespace,
    reference: observationReference,
    expectedMediaType: PROVIDER_ASSIGNMENT_OBSERVATION_MEDIA_TYPE,
    label: "Provider assignment observation",
  });
  const observation = parseCanonicalJsonBytes(
    storedObservation.bytes,
    "Provider assignment observation",
  );
  assertExactKeys(
    observation,
    PROVIDER_ALIAS_OBSERVATION_KEYS,
    "Provider assignment observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !== "provider-alias-observation/v1" ||
    observation.namespace !== namespace ||
    observation.providerProjectId !== target.providerProjectId ||
    !sameCanonicalValue(observation.observedBinding, target) ||
    !Array.isArray(observation.assignments) ||
    !Array.isArray(observation.providerReceiptReferences)
  ) {
    throw new Error("Provider assignment observation identity differs");
  }
  const expectedAssignments = assignmentEvidence.assignments
    .map(({ productionDomain, assignedDeploymentId }) => ({
      productionDomain,
      assignedDeploymentId,
    }))
    .sort((left, right) =>
      compareUtf8(left.productionDomain, right.productionDomain),
    );
  for (const assignment of observation.assignments) {
    assertExactKeys(
      assignment,
      PROVIDER_ALIAS_ASSIGNMENT_KEYS,
      "Provider alias assignment",
    );
  }
  const observedAssignments = [...observation.assignments].sort((left, right) =>
    compareUtf8(left.productionDomain, right.productionDomain),
  );
  if (
    !sameCanonicalValue(observation.assignments, observedAssignments) ||
    !sameCanonicalValue(observation.assignments, expectedAssignments) ||
    !sameCanonicalValue(
      observation.assignments.map(({ productionDomain }) => productionDomain),
      [...providerPolicy.ownedProductionDomains].sort(compareUtf8),
    ) ||
    observation.assignments.some(
      ({ assignedDeploymentId }) =>
        assignedDeploymentId !== target.providerDeploymentId,
    ) ||
    observation.providerReceiptReferences.length !==
      observation.assignments.length
  ) {
    throw new Error(
      "Provider assignment observation differs from the reviewed assignment",
    );
  }
  const sortedReceiptReferences = [
    ...observation.providerReceiptReferences,
  ].sort((left, right) => compareUtf8(left.uri, right.uri));
  if (
    !sameCanonicalValue(
      observation.providerReceiptReferences,
      sortedReceiptReferences,
    ) ||
    new Set(observation.providerReceiptReferences.map(({ sha256 }) => sha256))
      .size !== observation.providerReceiptReferences.length
  ) {
    throw new Error(
      "Provider assignment receipt references are ambiguous or unordered",
    );
  }

  const assignmentsByDomain = new Map(
    observation.assignments.map((assignment) => [
      assignment.productionDomain,
      assignment,
    ]),
  );
  const receiptDomains = new Set();
  const responseReferences = [];
  for (const receiptReference of observation.providerReceiptReferences) {
    assertClosedImmutableReference(
      receiptReference,
      namespace,
      "Provider alias receipt reference",
    );
    const storedReceipt = await readExactEvidence({
      store,
      namespace,
      reference: receiptReference,
      expectedMediaType: PROVIDER_ALIAS_RECEIPT_MEDIA_TYPE,
      label: "Provider alias read receipt",
    });
    const receipt = parseCanonicalJsonBytes(
      storedReceipt.bytes,
      "Provider alias read receipt",
    );
    assertExactKeys(
      receipt,
      PROVIDER_ALIAS_RECEIPT_KEYS,
      "Provider alias read receipt",
    );
    const assignment = assignmentsByDomain.get(receipt.productionDomain);
    const providerMilliseconds = assertIsoTimestamp(
      receipt.providerDate,
      "Provider alias authoritative Date",
    );
    if (
      receipt.schemaVersion !== 1 ||
      receipt.receiptKind !== "vercel-alias-read-receipt/v1" ||
      assignment === undefined ||
      receiptDomains.has(receipt.productionDomain) ||
      receipt.providerProjectId !== target.providerProjectId ||
      receipt.providerDeploymentId !== assignment.assignedDeploymentId ||
      receipt.status !== 200 ||
      receipt.requestUrl !== receipt.responseUrl ||
      receipt.responseSha256 !== receipt.responseReference?.sha256
    ) {
      throw new Error("Provider alias read receipt binding differs");
    }
    if (requireFresh) {
      assertFreshDate({
        value: receipt.providerDate,
        providerPolicy,
        nowMilliseconds,
        label: "Provider alias authoritative Date",
      });
    }
    assertProviderAliasRequestUrl({
      requestUrl: receipt.requestUrl,
      productionDomain: receipt.productionDomain,
      providerPolicy,
    });
    assertClosedImmutableReference(
      receipt.responseReference,
      namespace,
      "Provider alias response reference",
    );
    const storedResponse = await readExactEvidence({
      store,
      namespace,
      reference: receipt.responseReference,
      expectedMediaType: PROVIDER_ALIAS_RESPONSE_MEDIA_TYPE,
      label: "Provider alias API response",
    });
    if (receipt.responseSha256 !== sha256Bytes(storedResponse.bytes)) {
      throw new Error("Provider alias raw response hash differs");
    }
    const body = parseStrictUtf8Json(
      storedResponse.bytes,
      "Provider alias API response",
    );
    const topLevelDeploymentId = body?.deploymentId;
    const nestedDeploymentId = body?.deployment?.id;
    const derivedDeploymentId =
      topLevelDeploymentId ?? nestedDeploymentId ?? null;
    if (
      body?.alias !== receipt.productionDomain ||
      body?.projectId !== receipt.providerProjectId ||
      (body?.redirect !== null && body?.redirect !== undefined) ||
      typeof derivedDeploymentId !== "string" ||
      derivedDeploymentId.length === 0 ||
      derivedDeploymentId.length > 255 ||
      (topLevelDeploymentId !== undefined &&
        topLevelDeploymentId !== derivedDeploymentId) ||
      (nestedDeploymentId !== undefined &&
        nestedDeploymentId !== derivedDeploymentId) ||
      derivedDeploymentId !== receipt.providerDeploymentId
    ) {
      throw new Error(
        "Provider alias raw response differs from its assignment receipt",
      );
    }
    receiptDomains.add(receipt.productionDomain);
    responseReferences.push(receipt.responseReference);
    void providerMilliseconds;
  }
  if (receiptDomains.size !== assignmentsByDomain.size) {
    throw new Error("Provider alias receipts do not cover every assignment");
  }
  return {
    observation,
    observationBytes: storedObservation.bytes,
    providerReceiptChainReferences: [
      ...observation.providerReceiptReferences,
      ...responseReferences,
    ].sort((left, right) => compareUtf8(left.uri, right.uri)),
  };
};

export const validateProductionAssignmentAuthority = async ({
  store,
  namespace,
  authorityBytes: suppliedAuthorityBytes,
  preparedResultBytes: suppliedPreparedResultBytes,
  promotionReceiptBytes: suppliedPromotionReceiptBytes,
  validatedPrepared,
  providerPolicy,
  nowMilliseconds = Date.now(),
  requireFresh = true,
}) => {
  assertStore(store, namespace);
  if (
    typeof requireFresh !== "boolean" ||
    (requireFresh && !Number.isFinite(nowMilliseconds))
  ) {
    throw new Error("Assignment authority freshness binding is invalid");
  }
  const authorityInput = assertBoundedCanonicalInput(
    suppliedAuthorityBytes,
    MAX_ASSIGNMENT_AUTHORITY_BYTES,
    "Production assignment authority",
  );
  const preparedInput = assertBoundedCanonicalInput(
    suppliedPreparedResultBytes,
    MAX_PREPARED_RESULT_BYTES,
    "Prepared promotion result",
  );
  const promotionInput = assertBoundedCanonicalInput(
    suppliedPromotionReceiptBytes,
    MAX_PROMOTION_RECEIPT_BYTES,
    "Prepared promotion receipt",
  );
  const target = validatedPrepared?.operation?.targetBinding;
  const assignmentEvidence = promotionInput.value?.assignmentEvidence;
  if (!isRecord(target) || !isRecord(assignmentEvidence)) {
    throw new Error("Assignment authority reviewed inputs are invalid");
  }
  const authority = authorityInput.value;
  assertExactKeys(
    authority,
    ASSIGNMENT_AUTHORITY_KEYS,
    "Production assignment authority",
  );
  for (const [name, reference] of [
    ["Promotion receipt", authority.promotionReceipt],
    ["Assignment receipt", authority.assignmentReceipt],
    [
      "Provider assignment observation",
      authority.providerAssignmentObservation,
    ],
  ]) {
    assertClosedImmutableReference(reference, namespace, name);
  }
  const expectedPromotionReference = immutableEvidenceReference(
    namespace,
    promotionInput.bytes,
  );
  const assignmentReceiptBytes = canonicalJsonBytes(assignmentEvidence);
  const expectedAssignmentReference = immutableEvidenceReference(
    namespace,
    assignmentReceiptBytes,
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.evidenceKind !== "production-assignment-authority/v1" ||
    authority.namespace !== namespace ||
    authority.preparedResultSha256 !== sha256Bytes(preparedInput.bytes) ||
    authority.targetBindingId !== target.bindingId ||
    authority.providerProjectId !== target.providerProjectId ||
    authority.providerDeploymentId !== target.providerDeploymentId ||
    !sameCanonicalValue(
      authority.promotionReceipt,
      expectedPromotionReference,
    ) ||
    !sameCanonicalValue(
      authority.assignmentReceipt,
      expectedAssignmentReference,
    )
  ) {
    throw new Error(
      "Production assignment authority differs from its reviewed inputs",
    );
  }
  await Promise.all([
    readExactEvidence({
      store,
      namespace,
      reference: authority.promotionReceipt,
      expectedBytes: promotionInput.bytes,
      expectedMediaType: PROMOTION_RECEIPT_MEDIA_TYPE,
      label: "Promotion receipt",
    }),
    readExactEvidence({
      store,
      namespace,
      reference: authority.assignmentReceipt,
      expectedBytes: assignmentReceiptBytes,
      expectedMediaType: ASSIGNMENT_RECEIPT_MEDIA_TYPE,
      label: "Assignment receipt",
    }),
  ]);
  const providerAssignment = await validateProviderAliasObservationChain({
    store,
    namespace,
    observationReference: authority.providerAssignmentObservation,
    target,
    assignmentEvidence,
    providerPolicy,
    nowMilliseconds,
    requireFresh,
  });
  return {
    authority,
    authorityBytes: authorityInput.bytes,
    authoritySha256: sha256Bytes(authorityInput.bytes),
    assignmentReceiptBytes,
    providerAssignmentObservation: providerAssignment.observation,
    providerAssignmentObservationBytes: providerAssignment.observationBytes,
    providerReceiptChainReferences:
      providerAssignment.providerReceiptChainReferences,
  };
};

const assertNullableHeader = (value, label, maximum = 8192) => {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length > maximum ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== 0x09 && (codePoint <= 0x1f || codePoint === 0x7f);
      }))
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const validateStoredRouteProbe = async ({
  store,
  namespace,
  target,
  providerEvidence,
  secrets,
}) => {
  const reference = {
    uri:
      `release-state://${namespace}/evidence/` +
      providerEvidence.routeProbeEvidenceHash,
    sha256: providerEvidence.routeProbeEvidenceHash,
  };
  const stored = await readBoundedEvidence({
    store,
    namespace,
    reference,
    label: "Immutable route probe evidence",
  });
  assertNoSecretBytes(stored.bytes, secrets, "Immutable route probe evidence");
  const probe = parseCanonicalJsonBytes(
    stored.bytes,
    "Immutable route probe evidence",
  );
  assertExactKeys(probe, ROUTE_PROBE_KEYS, "Immutable route probe evidence");
  if (
    probe.schemaVersion !== 1 ||
    probe.evidenceKind !== "immutable-deployment-route-probe/v1" ||
    probe.namespace !== namespace ||
    probe.providerProjectId !== target.providerProjectId ||
    probe.providerDeploymentId !== target.providerDeploymentId ||
    probe.deploymentUrl !== target.deploymentUrl ||
    !Array.isArray(probe.routes) ||
    probe.routes.length < 3 ||
    probe.routes.length > MAX_DECLARED_ROUTES
  ) {
    throw new Error("Immutable route probe differs from the target deployment");
  }
  assertIsoTimestamp(probe.observedAt, "Immutable route probe observedAt");
  assertImmutableObjectReference(
    probe.deploymentReceipt,
    namespace,
    "Immutable route probe deployment receipt",
  );
  assertImmutableObjectReference(
    probe.cspPolicy,
    namespace,
    "Immutable route probe CSP policy",
  );
  await Promise.all([
    readBoundedEvidence({
      store,
      namespace,
      reference: probe.deploymentReceipt,
      label: "Immutable deployment receipt",
    }),
    readBoundedEvidence({
      store,
      namespace,
      reference: probe.cspPolicy,
      label: "Immutable CSP policy",
    }),
  ]);
  assertExactKeys(
    probe.runtimeHtmlIdentity,
    ["buildId", "sourceSha"],
    "Immutable runtime HTML identity",
  );
  if (
    probe.runtimeHtmlIdentity.sourceSha !== target.sourceSha ||
    probe.runtimeHtmlIdentity.buildId !== target.buildId
  ) {
    throw new Error("Immutable runtime HTML identity differs from target");
  }
  const routes = new Map();
  let previousPath = null;
  for (const route of probe.routes) {
    assertExactKeys(
      route,
      IMMUTABLE_ROUTE_RECEIPT_KEYS,
      "Immutable route receipt",
    );
    assertSafePublicPath(route.path);
    assertExactKeys(
      route.securityHeaders,
      SECURITY_HEADER_KEYS,
      "Immutable route security headers",
    );
    if (previousPath !== null && compareUtf8(previousPath, route.path) >= 0) {
      throw new Error(
        "Immutable route receipts are duplicated or out of order",
      );
    }
    previousPath = route.path;
    const expectedUrl = `${target.deploymentUrl}${route.path}`;
    if (
      route.requestUrl !== expectedUrl ||
      route.responseUrl !== expectedUrl ||
      route.status !== 200 ||
      !SHA256_PATTERN.test(route.bodySha256) ||
      !Number.isSafeInteger(route.byteLength) ||
      route.byteLength < 0 ||
      route.byteLength > MAX_ROUTE_RESPONSE_BYTES
    ) {
      throw new Error("Immutable route receipt binding is invalid");
    }
    assertNullableHeader(route.etag, "Immutable route ETag", 512);
    assertNullableHeader(route.contentType, "Immutable route content type");
    assertNullableHeader(route.cacheControl, "Immutable route cache control");
    for (const [name, value] of Object.entries(route.securityHeaders)) {
      assertNullableHeader(value, `Immutable route ${name}`);
    }
    if (!Number.isFinite(Date.parse(route.responseDate))) {
      throw new Error("Immutable route response Date is invalid");
    }
    routes.set(route.path, route);
  }
  for (const requiredPath of ["/", "/release-capabilities.json", "/sw.js"]) {
    if (!routes.has(requiredPath)) {
      throw new Error(`Immutable route probe is missing ${requiredPath}`);
    }
  }
  if (
    target.publicIdentityKind === "release-identity-v1" &&
    !routes.has("/release-identity.json")
  ) {
    throw new Error("Immutable route probe is missing ReleaseIdentity");
  }
  return { probe, reference, routes };
};

const securityHeaderProjection = (headers) =>
  Object.fromEntries(
    SECURITY_HEADER_KEYS.map((name) => [name, headers.get(name)]),
  );

const readBoundedHttpBody = async (response, pathName) => {
  const declared = response.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_ROUTE_RESPONSE_BYTES)
  ) {
    throw new Error(`Production route response is oversized: ${pathName}`);
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
            `Production route response stream is invalid: ${pathName}`,
          );
        }
        byteLength += value.byteLength;
        if (byteLength > MAX_ROUTE_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `Production route response is oversized: ${pathName}`,
          );
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
    throw new Error(`Production route response is oversized: ${pathName}`);
  }
  return bytes;
};

const fetchRoute = async ({
  origin,
  pathName,
  fetchImpl,
  providerPolicy,
  clock,
  secrets,
  budget,
}) => {
  assertSafePublicPath(pathName);
  const requestUrl = new URL(pathName, `${origin}/`).href;
  if (requestUrl !== `${origin}${pathName}`) {
    throw new Error(`Production route resolves through an alias: ${pathName}`);
  }
  budget.requests += 1;
  if (budget.requests > MAX_HTTP_REQUESTS) {
    throw new Error("Production route request count exceeds its ceiling");
  }
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw new Error(`Production route request failed: ${pathName}`);
  }
  if (
    !response ||
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.arrayBuffer !== "function" ||
    response.url !== requestUrl ||
    response.redirected === true ||
    typeof response.headers?.get !== "function"
  ) {
    throw new Error(`Production route is partial or redirected: ${pathName}`);
  }
  const bytes = await readBoundedHttpBody(response, pathName);
  budget.bytes += bytes.length;
  if (budget.bytes > MAX_TOTAL_RESPONSE_BYTES) {
    throw new Error("Production route bytes exceed their total ceiling");
  }
  assertNoSecretBytes(bytes, secrets, `Production route ${pathName}`);
  const responseDate = response.headers.get("date");
  const responseMilliseconds = assertFreshDate({
    value: responseDate,
    providerPolicy,
    nowMilliseconds: Number(clock()),
    label: `Production route Date ${pathName}`,
  });
  const receipt = {
    method: "GET",
    path: pathName,
    requestUrl,
    responseUrl: response.url,
    status: response.status,
    responseDate,
    etag: response.headers.get("etag"),
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    allow: response.headers.get("allow"),
    securityHeaders: securityHeaderProjection(response.headers),
    bodySha256: sha256Bytes(bytes),
    byteLength: bytes.length,
  };
  for (const [name, value] of [
    ["ETag", receipt.etag],
    ["content type", receipt.contentType],
    ["cache control", receipt.cacheControl],
    ["Allow", receipt.allow],
  ]) {
    assertNullableHeader(value, `Production route ${name}`);
  }
  for (const [name, value] of Object.entries(receipt.securityHeaders)) {
    assertNullableHeader(value, `Production route ${name}`);
  }
  return { bytes, receipt, responseMilliseconds };
};

const assertReceiptMatchesBaseline = ({ receipt, baseline, label }) => {
  if (
    receipt.path !== baseline.path ||
    receipt.status !== baseline.status ||
    receipt.bodySha256 !== baseline.bodySha256 ||
    receipt.byteLength !== baseline.byteLength ||
    receipt.etag !== baseline.etag ||
    receipt.contentType !== baseline.contentType ||
    receipt.cacheControl !== baseline.cacheControl ||
    (Object.hasOwn(baseline, "allow") && receipt.allow !== baseline.allow) ||
    !sameCanonicalValue(receipt.securityHeaders, baseline.securityHeaders)
  ) {
    throw new Error(`${label} differs from its immutable route`);
  }
};

const assertApiOwnership = ({ receipt, expectation, rootSecurityHeaders }) => {
  if (
    receipt.path !== expectation.path ||
    receipt.status !== expectation.status ||
    receipt.bodySha256 !== sha256Bytes(expectation.body) ||
    receipt.byteLength !== expectation.body.length ||
    receipt.cacheControl !== expectation.cacheControl ||
    receipt.allow !== expectation.allow ||
    (expectation.contentType !== null &&
      (typeof receipt.contentType !== "string" ||
        !receipt.contentType
          .toLowerCase()
          .includes(expectation.contentType))) ||
    !sameCanonicalValue(receipt.securityHeaders, rootSecurityHeaders)
  ) {
    throw new Error(
      `Immutable API route ownership differs: ${expectation.path}`,
    );
  }
};

const parseRuntimeHtmlIdentity = (bytes) => {
  let html;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Production HTML is not valid UTF-8");
  }
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
        throw new Error(`Production HTML duplicates ${name}`);
      }
      values.set(name, attributes.get("content"));
    }
  }
  return {
    buildId: values.get("event-shopping-planner-build-id"),
    sourceSha: values.get("event-shopping-planner-source-sha"),
  };
};

const assertDomainPublicIdentity = ({
  bytesByPath,
  target,
  providerEvidence,
  immutableProbe,
}) => {
  const runtimeIdentity = parseRuntimeHtmlIdentity(bytesByPath.get("/"));
  if (
    !sameCanonicalValue(runtimeIdentity, immutableProbe.runtimeHtmlIdentity) ||
    runtimeIdentity.sourceSha !== target.sourceSha ||
    runtimeIdentity.buildId !== target.buildId
  ) {
    throw new Error("Production HTML identity differs from immutable target");
  }
  const capabilityBytes = bytesByPath.get("/release-capabilities.json");
  const serviceWorkerBytes = bytesByPath.get("/sw.js");
  if (!capabilityBytes || !serviceWorkerBytes) {
    throw new Error("Production identity routes are incomplete");
  }
  const capability = parseCanonicalJsonBytes(
    capabilityBytes,
    "Production release capability",
  );
  if (
    capability.kind !== "event-shopping-planner-release-capabilities" ||
    capability.version !== 1 ||
    capability.sourceSha !== target.sourceSha ||
    capability.buildId !== target.buildId ||
    capability.sourceState !== "clean" ||
    capability.releaseChannel !== "release-a" ||
    capability.legacyLocalStorageCleanup !== "forced-off" ||
    capability.nonPromotable === true ||
    capability.buildPurpose !== undefined
  ) {
    throw new Error("Production release capability differs from target");
  }
  const identity = providerEvidence.publicIdentity;
  if (identity.identityKind === "release-identity-v1") {
    const identityBytes = bytesByPath.get("/release-identity.json");
    if (
      !identityBytes ||
      sha256Bytes(identityBytes) !== identity.identitySha256
    ) {
      throw new Error("Production ReleaseIdentity hash differs");
    }
    const parsedIdentity = parseCanonicalJsonBytes(
      identityBytes,
      "Production ReleaseIdentity",
    );
    if (
      !sameCanonicalValue(parsedIdentity, identity.identity) ||
      parsedIdentity.sourceSha !== target.sourceSha ||
      parsedIdentity.buildId !== target.buildId ||
      parsedIdentity.variantId !== target.variantId ||
      parsedIdentity.releaseRole !== target.releaseRole ||
      parsedIdentity.serviceWorkerSha256 !== sha256Bytes(serviceWorkerBytes)
    ) {
      throw new Error("Production ReleaseIdentity differs from target");
    }
    for (const [key, publicPath] of Object.entries(parsedIdentity).filter(
      ([key]) => key.endsWith("Url"),
    )) {
      assertSafePublicPath(publicPath);
      const hashKey = `${key.slice(0, -"Url".length)}Sha256`;
      const routeBytes = bytesByPath.get(publicPath);
      if (
        !routeBytes ||
        !SHA256_PATTERN.test(parsedIdentity[hashKey]) ||
        sha256Bytes(routeBytes) !== parsedIdentity[hashKey]
      ) {
        throw new Error(`Production ReleaseIdentity route differs: ${key}`);
      }
    }
  } else if (
    identity.identityKind !== "legacy-bootstrap-v1" ||
    identity.sourceSha !== target.sourceSha ||
    identity.buildId !== target.buildId ||
    identity.sourceState !== "clean" ||
    identity.htmlMetaSha256 !== sha256Json(runtimeIdentity) ||
    identity.capabilitySha256 !== sha256Bytes(capabilityBytes) ||
    identity.serviceWorkerSha256 !== sha256Bytes(serviceWorkerBytes)
  ) {
    throw new Error("Production legacy identity differs from target");
  }
};

const validateProductionAssignmentContext = async (
  options,
  { readState, validatePreparedResult, providerObservationValidator, clock },
  { requireFreshPromotion = true } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    preparedResultBytes: suppliedPreparedResultBytes,
    promotionReceiptBytes: suppliedPromotionReceiptBytes,
    namespace,
    store,
    providerPolicy,
    toolchainPolicy,
    environment = process.env,
  } = options;
  assertStore(store, namespace);
  const startedAt = Number(clock());
  if (!Number.isFinite(startedAt)) {
    throw new Error("Production assignment clock is invalid");
  }
  const preparedInput = assertBoundedCanonicalInput(
    suppliedPreparedResultBytes,
    MAX_PREPARED_RESULT_BYTES,
    "Prepared promotion result",
  );
  const promotionInput = assertBoundedCanonicalInput(
    suppliedPromotionReceiptBytes,
    MAX_PROMOTION_RECEIPT_BYTES,
    "Prepared promotion receipt",
  );
  const secrets = secretValues(environment);
  assertNoSecretBytes(
    preparedInput.bytes,
    secrets,
    "Prepared promotion result",
  );
  assertNoSecretBytes(
    promotionInput.bytes,
    secrets,
    "Prepared promotion receipt",
  );
  const validatedPrepared = validatePreparedResult({
    preparedResultBytes: preparedInput.bytes,
    providerPolicy,
    environment,
    nowMilliseconds: startedAt,
  });
  if (validatedPrepared.event.namespace !== namespace) {
    throw new Error("Prepared promotion namespace differs from Release State");
  }
  const initialState = assertPreparedState({
    current: await readState({ store }),
    validatedPrepared,
    namespace,
  });
  const promotionValidationMilliseconds = requireFreshPromotion
    ? startedAt
    : Date.parse(promotionInput.value?.completedAt);
  if (!Number.isFinite(promotionValidationMilliseconds)) {
    throw new Error("Prepared promotion receipt completion time is invalid");
  }
  const promotion = validatePromotionReceipt({
    receiptBytes: promotionInput.bytes,
    validatedPrepared,
    providerPolicy,
    toolchainPolicy,
    nowMilliseconds: promotionValidationMilliseconds,
    providerObservationValidator,
  });
  const target = validatedPrepared.operation.targetBinding;
  assertHttpsOrigin(target.deploymentUrl, "Prepared deployment URL");
  const providerEvidence = await validateProviderEvidenceForBinding({
    store,
    namespace,
    binding: target,
    label: "Production assignment target",
  });
  const immutable = await validateStoredRouteProbe({
    store,
    namespace,
    target,
    providerEvidence,
    secrets,
  });
  return {
    environment,
    immutable,
    initialState,
    namespace,
    preparedInput,
    promotion,
    promotionInput,
    providerEvidence,
    providerPolicy,
    secrets,
    startedAt,
    store,
    target,
    toolchainPolicy,
    validatedPrepared,
  };
};

const assertReleaseHeadUnchanged = async ({ context, readState, label }) => {
  const finalState = assertPreparedState({
    current: await readState({ store: context.store }),
    validatedPrepared: context.validatedPrepared,
    namespace: context.namespace,
  });
  if (
    finalState.head.sequence !== context.initialState.head.sequence ||
    finalState.head.eventHash !== context.initialState.head.eventHash
  ) {
    throw new Error(`Release State head changed during ${label}`);
  }
};

export const prepareProductionAssignmentAuthority = async (
  options,
  {
    readState = readCurrentReleaseState,
    validatePreparedResult = validatePreparedPromotionResult,
    providerObservationValidator = assertVercelObservationEvidence,
    buildAssignmentObservation = buildAuthoritativeProviderAliasObservation,
    reconcileProviderAssignment = decideProviderReconciliation,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
  } = {},
) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Production assignment fetch is unavailable");
  }
  const context = await validateProductionAssignmentContext(
    options,
    {
      readState,
      validatePreparedResult,
      providerObservationValidator,
      clock,
    },
    {
      requireFreshPromotion: true,
    },
  );
  const promotionReceiptReference = await putVerifiedEvidence({
    store: context.store,
    namespace: context.namespace,
    bytes: context.promotionInput.bytes,
    mediaType: PROMOTION_RECEIPT_MEDIA_TYPE,
    label: "Promotion receipt",
  });
  const assignmentReceiptBytes = canonicalJsonBytes(
    context.promotion.assignmentEvidence,
  );
  const assignmentReceiptReference = await putVerifiedEvidence({
    store: context.store,
    namespace: context.namespace,
    bytes: assignmentReceiptBytes,
    mediaType: ASSIGNMENT_RECEIPT_MEDIA_TYPE,
    label: "Assignment receipt",
  });
  const providerAssignment = await buildAssignmentObservation(
    {
      store: context.store,
      namespace: context.namespace,
      providerPolicy: context.providerPolicy,
      providerToken: context.validatedPrepared.token,
      fetchImpl,
    },
    {
      readState,
      decideReconciliation: (reconcileOptions, dependencies = {}) =>
        reconcileProviderAssignment(reconcileOptions, {
          ...dependencies,
          readState,
        }),
      now: clock,
    },
  );
  assertClosedImmutableReference(
    providerAssignment?.observationReference,
    context.namespace,
    "Provider assignment observation",
  );
  const authority = {
    schemaVersion: 1,
    evidenceKind: "production-assignment-authority/v1",
    namespace: context.namespace,
    preparedResultSha256: sha256Bytes(context.preparedInput.bytes),
    targetBindingId: context.target.bindingId,
    providerProjectId: context.target.providerProjectId,
    providerDeploymentId: context.target.providerDeploymentId,
    promotionReceipt: promotionReceiptReference,
    assignmentReceipt: assignmentReceiptReference,
    providerAssignmentObservation: providerAssignment.observationReference,
  };
  const authorityBytes = canonicalJsonBytes(authority);
  const validatedAuthority = await validateProductionAssignmentAuthority({
    store: context.store,
    namespace: context.namespace,
    authorityBytes,
    preparedResultBytes: context.preparedInput.bytes,
    promotionReceiptBytes: context.promotionInput.bytes,
    validatedPrepared: context.validatedPrepared,
    providerPolicy: context.providerPolicy,
    nowMilliseconds: context.startedAt,
    requireFresh: true,
  });
  await assertReleaseHeadUnchanged({
    context,
    readState,
    label: "assignment authority preparation",
  });
  return {
    assignmentAuthority: authority,
    assignmentAuthorityBytes: authorityBytes,
    assignmentAuthoritySha256: validatedAuthority.authoritySha256,
    promotionReceiptReference,
    assignmentReceiptReference,
    providerAssignmentObservationReference:
      providerAssignment.observationReference,
    providerReceiptChainReferences:
      validatedAuthority.providerReceiptChainReferences,
  };
};

const assertProductionProbeShape = (probe, namespace) => {
  assertExactKeys(probe, PRODUCTION_PROBE_KEYS, "Production probe evidence");
  assertClosedImmutableReference(
    probe.providerAssignmentObservation,
    namespace,
    "Production probe provider assignment observation",
  );
  if (
    probe.schemaVersion !== 1 ||
    probe.evidenceKind !== "production-assignment-probe/v1" ||
    !SHA256_PATTERN.test(probe.providerDeploymentEvidenceHash) ||
    !SHA256_PATTERN.test(probe.immutableRouteProbeEvidenceHash) ||
    !Array.isArray(probe.immutableApiReceipts) ||
    !Array.isArray(probe.results)
  ) {
    throw new Error("Production probe evidence shape is invalid");
  }
  for (const receipt of probe.immutableApiReceipts) {
    assertExactKeys(receipt, HTTP_RECEIPT_KEYS, "Immutable API receipt");
  }
  for (const result of probe.results) {
    assertExactKeys(result, PRODUCTION_RESULT_KEYS, "Production probe result");
    if (
      result.status !== "PASS" ||
      !SHA256_PATTERN.test(result.responseSha256) ||
      result.responseSha256 !== sha256Json(result.receipts) ||
      !Array.isArray(result.receipts)
    ) {
      throw new Error("Production probe result shape is invalid");
    }
    for (const receipt of result.receipts) {
      assertExactKeys(receipt, HTTP_RECEIPT_KEYS, "Production route receipt");
    }
  }
  return probe;
};

export const produceProductionAssignmentValidation = async (
  options,
  {
    readState = readCurrentReleaseState,
    validatePreparedResult = validatePreparedPromotionResult,
    providerObservationValidator = assertVercelObservationEvidence,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
  } = {},
) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Production assignment fetch is unavailable");
  }
  const context = await validateProductionAssignmentContext(
    options,
    {
      readState,
      validatePreparedResult,
      providerObservationValidator,
      clock,
    },
    {
      requireFreshPromotion: false,
    },
  );
  const validatedAuthority = await validateProductionAssignmentAuthority({
    store: context.store,
    namespace: context.namespace,
    authorityBytes: options.assignmentAuthorityBytes,
    preparedResultBytes: context.preparedInput.bytes,
    promotionReceiptBytes: context.promotionInput.bytes,
    validatedPrepared: context.validatedPrepared,
    providerPolicy: context.providerPolicy,
    nowMilliseconds: context.startedAt,
    requireFresh: false,
  });
  const {
    immutable,
    namespace,
    promotion,
    providerEvidence,
    providerPolicy,
    secrets,
    target,
  } = context;

  const declaredPaths = [...immutable.routes.keys()];
  const apiPaths = API_ROUTE_EXPECTATIONS.map(({ path }) => path);
  const allPaths = [...new Set([...declaredPaths, ...apiPaths])].sort(
    compareUtf8,
  );
  const domains = providerPolicy.ownedProductionDomains;
  const requestCount = apiPaths.length + domains.length * allPaths.length;
  if (
    requestCount < 1 ||
    requestCount > MAX_HTTP_REQUESTS ||
    domains.length === 0
  ) {
    throw new Error("Production assignment route set exceeds its ceiling");
  }
  const budget = { requests: 0, bytes: 0 };
  const responseDates = [];
  const immutableApiReceipts = [];
  const immutableApiBaselines = new Map();
  const rootSecurityHeaders =
    immutable.routes.get("/")?.securityHeaders ?? null;
  if (rootSecurityHeaders === null) {
    throw new Error("Immutable root security headers are absent");
  }
  for (const expectation of [...API_ROUTE_EXPECTATIONS].sort((left, right) =>
    compareUtf8(left.path, right.path),
  )) {
    const result = await fetchRoute({
      origin: target.deploymentUrl,
      pathName: expectation.path,
      fetchImpl,
      providerPolicy,
      clock,
      secrets,
      budget,
    });
    assertApiOwnership({
      receipt: result.receipt,
      expectation,
      rootSecurityHeaders,
    });
    responseDates.push(result.responseMilliseconds);
    immutableApiReceipts.push(result.receipt);
    immutableApiBaselines.set(expectation.path, result.receipt);
  }

  const results = [];
  for (const productionDomain of domains) {
    const origin = `https://${productionDomain}`;
    const receipts = [];
    const bytesByPath = new Map();
    for (const pathName of allPaths) {
      const result = await fetchRoute({
        origin,
        pathName,
        fetchImpl,
        providerPolicy,
        clock,
        secrets,
        budget,
      });
      const baseline =
        immutable.routes.get(pathName) ?? immutableApiBaselines.get(pathName);
      if (!baseline) {
        throw new Error(
          `Production route has no immutable baseline: ${pathName}`,
        );
      }
      assertReceiptMatchesBaseline({
        receipt: result.receipt,
        baseline,
        label: `Production route ${productionDomain}${pathName}`,
      });
      responseDates.push(result.responseMilliseconds);
      receipts.push(result.receipt);
      bytesByPath.set(pathName, result.bytes);
    }
    assertDomainPublicIdentity({
      bytesByPath,
      target,
      providerEvidence,
      immutableProbe: immutable.probe,
    });
    results.push({
      productionDomain,
      providerDeploymentId: target.providerDeploymentId,
      status: "PASS",
      responseSha256: sha256Json(receipts),
      receipts,
    });
  }
  if (
    !sameCanonicalValue(
      results.map(({ productionDomain }) => productionDomain),
      domains,
    ) ||
    results.some(
      ({ providerDeploymentId }) =>
        providerDeploymentId !== target.providerDeploymentId,
    ) ||
    promotion.assignmentEvidence.assignments.some(
      ({ assignedDeploymentId }) =>
        assignedDeploymentId !== target.providerDeploymentId,
    )
  ) {
    throw new Error(
      "Production domains do not uniformly target the promoted deployment",
    );
  }
  if (responseDates.length === 0) {
    throw new Error("Production assignment produced no authoritative Dates");
  }
  const observedMilliseconds = Math.max(...responseDates);
  if (observedMilliseconds + 999 < promotion.completedMilliseconds) {
    throw new Error(
      "Production probe predates the completed promotion receipt",
    );
  }
  const productionProbe = assertProductionProbeShape(
    {
      schemaVersion: 1,
      evidenceKind: "production-assignment-probe/v1",
      providerProjectId: target.providerProjectId,
      providerDeploymentId: target.providerDeploymentId,
      providerDeploymentEvidenceHash: target.providerEvidence.sha256,
      immutableRouteProbeEvidenceHash: immutable.reference.sha256,
      providerAssignmentObservation:
        validatedAuthority.authority.providerAssignmentObservation,
      observedAt: new Date(observedMilliseconds).toISOString(),
      immutableApiReceipts,
      results,
    },
    namespace,
  );
  const productionProbeBytes = canonicalJsonBytes(productionProbe);
  const assignmentValidation = {
    schemaVersion: 1,
    evidenceKind: "assignment-validation",
    providerProjectId: target.providerProjectId,
    assignmentReceiptUri: validatedAuthority.authority.assignmentReceipt.uri,
    assignmentReceiptSha256:
      validatedAuthority.authority.assignmentReceipt.sha256,
    assignments: promotion.assignmentEvidence.assignments,
    productionProbeEvidenceHash: sha256Bytes(productionProbeBytes),
  };
  assertExactKeys(
    assignmentValidation,
    ASSIGNMENT_VALIDATION_KEYS,
    "Assignment validation evidence",
  );
  assertImmutableObjectReference(
    {
      uri: assignmentValidation.assignmentReceiptUri,
      sha256: assignmentValidation.assignmentReceiptSha256,
    },
    namespace,
    "Assignment validation receipt",
  );
  assertAssignments({
    assignments: assignmentValidation.assignments,
    providerPolicy,
    targetDeploymentId: target.providerDeploymentId,
    label: "Assignment validation",
  });
  const assignmentValidationBytes = canonicalJsonBytes(assignmentValidation);
  for (const [bytes, label] of [
    [assignmentValidationBytes, "Assignment validation evidence"],
    [productionProbeBytes, "Production probe evidence"],
  ]) {
    assertNoSecretBytes(bytes, secrets, label);
  }

  await assertReleaseHeadUnchanged({
    context,
    readState,
    label: "production assignment validation",
  });
  return {
    assignmentAuthority: validatedAuthority.authority,
    assignmentAuthoritySha256: validatedAuthority.authoritySha256,
    assignmentValidation,
    assignmentValidationBytes,
    assignmentValidationSha256: sha256Bytes(assignmentValidationBytes),
    productionProbe,
    productionProbeBytes,
    productionProbeSha256: sha256Bytes(productionProbeBytes),
  };
};
