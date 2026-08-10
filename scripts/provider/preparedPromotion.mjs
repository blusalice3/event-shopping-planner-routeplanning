import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  assertProviderPolicyConfigured,
  collectVercelProviderObservation,
} from "./collect-vercel-observation.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";
import { buildClosedVercelCommandEnvironment } from "./vercel-command-environment.mjs";
import { hashReleaseEvent } from "../release-state/releaseStateReducer.mjs";
import {
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertDeploymentBinding,
  assertExactKeys,
  assertImmutableObjectReference,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const PREPARED_RESULT_KEYS = [
  "approvalRefs",
  "committedAt",
  "event",
  "eventHash",
  "eventUri",
  "head",
  "replayed",
  "subjectReference",
  "subjectSha256",
];
const EVENT_KEYS = [
  "appendId",
  "approvalRefs",
  "eventType",
  "evidenceRefs",
  "namespace",
  "operationId",
  "payload",
  "payloadSha256",
  "previousEventHash",
  "schemaVersion",
  "sequence",
];
const PENDING_OPERATION_KEYS = [
  "approvalRefs",
  "companionBinding",
  "emergencyRecoveryBinding",
  "expectedState",
  "kind",
  "operationId",
  "originBinding",
  "originCompanionBinding",
  "preparedAt",
  "previousBinding",
  "targetBinding",
];
const APPROVAL_KEYS = [
  "approvalId",
  "approvedAt",
  "decision",
  "issuerReceiptSha256",
  "issuerReceiptUri",
  "operationId",
  "protectedEnvironment",
  "providerReviewerId",
  "role",
  "sha256",
  "subjectSha256",
  "trustedIssuer",
  "uri",
  "workflowRunId",
];
const REQUIRED_APPROVAL_ROLES = ["releaseOwner", "dataSafetyReviewer"];
const PREPARED_OPERATION_KINDS = new Set([
  "promote-standard",
  "rollback-standard",
  "activate-containment",
  "redeploy-standard",
  "redeploy-containment",
]);
const FORBIDDEN_CALLER_AUTHORITY_FIELDS = [
  "deploymentId",
  "deploymentUrl",
  "domains",
  "idempotencyKey",
  "operationId",
  "providerProjectId",
  "releaseRole",
  "role",
  "sourceSha",
  "target",
  "targetBinding",
  "teamId",
];
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const UTF8_COMPARE = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const containsControlCharacter = (value) =>
  typeof value === "string" &&
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

const assertBoundedString = (value, label, maximum = 4096) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const assertIsoTimestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const assertNoCallerAuthority = (options) => {
  for (const field of FORBIDDEN_CALLER_AUTHORITY_FIELDS) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `Caller-supplied ${field} is forbidden; promotion authority comes from the prepared event`,
      );
    }
  }
};

const assertEvidenceReferencePresent = (event, reference, label) => {
  if (
    !event.evidenceRefs.some(
      (candidate) =>
        candidate.uri === reference.uri &&
        candidate.sha256 === reference.sha256,
    )
  ) {
    throw new Error(`${label} is absent from prepared event evidence`);
  }
};

const assertApprovalSet = ({
  approvals,
  event,
  operation,
  subjectSha256,
  environment,
}) => {
  if (
    !Array.isArray(approvals) ||
    approvals.length !== REQUIRED_APPROVAL_ROLES.length
  ) {
    throw new Error("Prepared promotion requires exactly two approvals");
  }
  const approvalIds = new Set();
  for (let index = 0; index < approvals.length; index += 1) {
    const approval = approvals[index];
    assertExactKeys(
      approval,
      APPROVAL_KEYS,
      `Prepared approval ${String(index + 1)}`,
    );
    assertImmutableObjectReference(
      { uri: approval.uri, sha256: approval.sha256 },
      event.namespace,
      "Prepared approval receipt",
    );
    assertImmutableObjectReference(
      {
        uri: approval.issuerReceiptUri,
        sha256: approval.issuerReceiptSha256,
      },
      event.namespace,
      "Prepared approval issuer receipt",
    );
    if (
      approval.role !== REQUIRED_APPROVAL_ROLES[index] ||
      approval.operationId !== event.operationId ||
      approval.subjectSha256 !== subjectSha256 ||
      approval.trustedIssuer !==
        "https://token.actions.githubusercontent.com" ||
      approval.decision !== "APPROVED" ||
      approval.workflowRunId !== environment.GITHUB_RUN_ID ||
      typeof approval.protectedEnvironment !== "string" ||
      approval.protectedEnvironment.length === 0 ||
      typeof approval.approvalId !== "string" ||
      approval.approvalId.length === 0 ||
      typeof approval.providerReviewerId !== "string" ||
      approval.providerReviewerId.length === 0
    ) {
      throw new Error("Prepared approval binding is invalid");
    }
    assertIsoTimestamp(approval.approvedAt, "Prepared approval time");
    approvalIds.add(approval.approvalId);
    assertEvidenceReferencePresent(event, approval, "Prepared approval");
    assertEvidenceReferencePresent(
      event,
      {
        uri: approval.issuerReceiptUri,
        sha256: approval.issuerReceiptSha256,
      },
      "Prepared approval issuer",
    );
  }
  if (
    approvalIds.size !== approvals.length ||
    !sameCanonicalValue(approvals, event.approvalRefs) ||
    !sameCanonicalValue(approvals, operation.approvalRefs)
  ) {
    throw new Error("Prepared approvals are ambiguous or differ");
  }
};

const assertMatchingPromotionPair = (standard, companion) => {
  if (
    standard.sourceSha !== companion.sourceSha ||
    standard.providerProjectId !== companion.providerProjectId ||
    standard.providerConfigurationHash !==
      companion.providerConfigurationHash ||
    !sameCanonicalValue(standard.providerPolicy, companion.providerPolicy) ||
    !sameCanonicalValue(standard.releasePolicy, companion.releasePolicy) ||
    !sameCanonicalValue(
      standard.requiredDbCompatibility,
      companion.requiredDbCompatibility,
    )
  ) {
    throw new Error(
      "Prepared standard and containment bindings are not an exact pair",
    );
  }
};

const assertPackageRedeployIdentity = (origin, target) => {
  if (
    origin.providerDeploymentId === target.providerDeploymentId ||
    origin.sourceSha !== target.sourceSha ||
    origin.buildId !== target.buildId ||
    origin.variantId !== target.variantId ||
    origin.releaseRole !== target.releaseRole ||
    origin.publicIdentityKind !== target.publicIdentityKind ||
    origin.providerProjectId !== target.providerProjectId ||
    origin.providerConfigurationHash !== target.providerConfigurationHash ||
    !sameCanonicalValue(origin.artifactArchive, target.artifactArchive) ||
    !sameCanonicalValue(origin.packageIndex, target.packageIndex) ||
    !sameCanonicalValue(origin.artifactManifest, target.artifactManifest) ||
    !sameCanonicalValue(origin.releasePolicy, target.releasePolicy) ||
    !sameCanonicalValue(origin.providerPolicy, target.providerPolicy) ||
    !sameCanonicalValue(
      origin.requiredDbCompatibility,
      target.requiredDbCompatibility,
    )
  ) {
    throw new Error("Prepared package redeploy changed immutable identity");
  }
};

const assertOwnedDomains = (policy) => {
  const domains = policy.ownedProductionDomains;
  const sorted = [...domains].sort(UTF8_COMPARE);
  if (
    domains.length === 0 ||
    new Set(domains).size !== domains.length ||
    domains.some(
      (domain) =>
        typeof domain !== "string" ||
        domain !== domain.toLowerCase() ||
        !DOMAIN_PATTERN.test(domain),
    ) ||
    domains.some((domain, index) => domain !== sorted[index])
  ) {
    throw new Error(
      "Owned production domains must be a non-empty UTF-8 sorted canonical set",
    );
  }
  return domains;
};

const requireEnvironment = (environment, name) =>
  assertBoundedString(
    environment?.[name],
    `Required promotion environment ${name}`,
  );

export const assertPreparedPromotionEnvironment = ({
  environment,
  providerPolicy,
  event,
  operation,
}) => {
  const exact = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: `refs/heads/${providerPolicy.productionBranch}`,
    GITHUB_REF_PROTECTED: "true",
    RELEASE_STATE_NAMESPACE: event.namespace,
    VERCEL_ORG_ID: providerPolicy.expectedTeamId,
    VERCEL_PROJECT_ID: providerPolicy.expectedProjectId,
  };
  for (const [name, expected] of Object.entries(exact)) {
    if (requireEnvironment(environment, name) !== expected) {
      throw new Error(
        `Promotion environment ${name} differs from the prepared binding`,
      );
    }
  }
  const workflowSourceSha = requireEnvironment(environment, "GITHUB_SHA");
  if (
    !SOURCE_SHA_PATTERN.test(workflowSourceSha) ||
    (operation.kind === "promote-standard" &&
      workflowSourceSha !== operation.targetBinding.sourceSha)
  ) {
    throw new Error(
      "Promotion environment GITHUB_SHA differs from the protected operation",
    );
  }
  if (
    !RUN_ID_PATTERN.test(requireEnvironment(environment, "GITHUB_RUN_ID")) ||
    !RUN_ID_PATTERN.test(requireEnvironment(environment, "GITHUB_RUN_ATTEMPT"))
  ) {
    throw new Error("Protected promotion run identity is invalid");
  }
  const token = requireEnvironment(environment, "VERCEL_TOKEN");
  if (token.length < 16) {
    throw new Error("VERCEL_TOKEN is absent or invalid");
  }
  return token;
};

export const validatePreparedPromotionResult = ({
  preparedResultBytes,
  providerPolicy,
  environment,
  nowMilliseconds = Date.now(),
}) => {
  assertProviderPolicyConfigured(providerPolicy);
  const domains = assertOwnedDomains(providerPolicy);
  const result = parseCanonicalJsonBytes(
    preparedResultBytes,
    "Prepared promotion result",
  );
  assertExactKeys(result, PREPARED_RESULT_KEYS, "Prepared promotion result");
  assertExactKeys(result.event, EVENT_KEYS, "Prepared promotion event");
  assertExactKeys(
    result.event?.payload,
    ["pendingOperation"],
    "Prepared promotion payload",
  );
  const event = result.event;
  const operation = event.payload.pendingOperation;
  assertExactKeys(
    operation,
    PENDING_OPERATION_KEYS,
    "Prepared promotion operation",
  );
  assertExactKeys(
    operation.expectedState,
    ["eventHash", "sequence"],
    "Prepared expected state",
  );
  assertExactKeys(
    result.head,
    ["eventHash", "sequence"],
    "Prepared state head",
  );
  if (result.replayed !== true && result.replayed !== false) {
    throw new Error("Prepared promotion replay marker is invalid");
  }
  if (
    event.schemaVersion !== 1 ||
    event.eventType !== "promotion-prepared" ||
    !OPERATION_ID_PATTERN.test(event.operationId) ||
    event.operationId !== operation.operationId ||
    !PREPARED_OPERATION_KINDS.has(operation.kind) ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 2 ||
    !Number.isSafeInteger(operation.expectedState.sequence) ||
    operation.expectedState.sequence !== event.sequence - 1 ||
    operation.expectedState.eventHash !== event.previousEventHash ||
    !SHA256_PATTERN.test(event.previousEventHash) ||
    !UUID_V4_PATTERN.test(event.appendId) ||
    event.payloadSha256 !== sha256Json(event.payload)
  ) {
    throw new Error("Prepared promotion event identity is invalid");
  }
  if (
    hashReleaseEvent(event) !== result.eventHash ||
    result.head.sequence !== event.sequence ||
    result.head.eventHash !== result.eventHash ||
    result.eventUri !==
      `release-state://${event.namespace}/events/${event.sequence}/${result.eventHash}`
  ) {
    throw new Error(
      "Prepared promotion event hash, URI, or commit head differs",
    );
  }
  assertIsoTimestamp(result.committedAt, "Prepared event commit time");
  assertIsoTimestamp(operation.preparedAt, "Prepared operation time");
  if (
    Date.parse(operation.preparedAt) > Date.parse(result.committedAt) ||
    Date.parse(result.committedAt) >
      nowMilliseconds +
        providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error("Prepared promotion timestamps are inconsistent");
  }
  if (!SOURCE_SHA_PATTERN.test(operation.targetBinding?.sourceSha)) {
    throw new Error("Prepared promotion source binding is invalid");
  }

  const containmentOperation = [
    "activate-containment",
    "redeploy-containment",
  ].includes(operation.kind);
  assertDeploymentBinding(operation.targetBinding, {
    namespace: event.namespace,
    expectedRole: containmentOperation ? "containment" : "standard",
    label: "Prepared promotion target",
  });
  const companionRequired = [
    "promote-standard",
    "rollback-standard",
    "redeploy-standard",
  ].includes(operation.kind);
  if (companionRequired) {
    assertDeploymentBinding(operation.companionBinding, {
      namespace: event.namespace,
      expectedRole: "containment",
      label: "Prepared containment companion",
    });
    assertMatchingPromotionPair(
      operation.targetBinding,
      operation.companionBinding,
    );
  } else if (operation.companionBinding !== null) {
    throw new Error("Prepared containment operation cannot claim a companion");
  }
  assertDeploymentBinding(operation.emergencyRecoveryBinding, {
    namespace: event.namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Prepared emergency recovery",
  });
  if (operation.previousBinding !== null) {
    assertDeploymentBinding(operation.previousBinding, {
      namespace: event.namespace,
      allowLegacyBootstrap: true,
      label: "Prepared previous production",
    });
  }
  if (operation.kind === "redeploy-standard") {
    assertDeploymentBinding(operation.originBinding, {
      namespace: event.namespace,
      expectedRole: "standard",
      label: "Prepared standard redeploy origin",
    });
    assertDeploymentBinding(operation.originCompanionBinding, {
      namespace: event.namespace,
      expectedRole: "containment",
      label: "Prepared containment redeploy origin companion",
    });
    assertMatchingPromotionPair(
      operation.originBinding,
      operation.originCompanionBinding,
    );
    assertPackageRedeployIdentity(
      operation.originBinding,
      operation.targetBinding,
    );
    assertPackageRedeployIdentity(
      operation.originCompanionBinding,
      operation.companionBinding,
    );
  } else if (operation.kind === "redeploy-containment") {
    assertDeploymentBinding(operation.originBinding, {
      namespace: event.namespace,
      expectedRole: "containment",
      label: "Prepared containment redeploy origin",
    });
    if (operation.originCompanionBinding !== null) {
      throw new Error("Prepared containment redeploy origin is ambiguous");
    }
    assertPackageRedeployIdentity(
      operation.originBinding,
      operation.targetBinding,
    );
  } else if (
    operation.originBinding !== null ||
    operation.originCompanionBinding !== null
  ) {
    throw new Error("Prepared non-redeploy operation cannot claim origins");
  }
  if (
    operation.previousBinding?.providerDeploymentId ===
    operation.targetBinding.providerDeploymentId
  ) {
    throw new Error("Prepared previous and target deployments are identical");
  }

  const providerPolicySha256 = sha256Json(providerPolicy);
  const operationBindings = [
    operation.targetBinding,
    operation.companionBinding,
    operation.originBinding,
    operation.originCompanionBinding,
    operation.emergencyRecoveryBinding,
  ].filter(Boolean);
  for (const binding of operationBindings) {
    if (
      binding.providerProjectId !== providerPolicy.expectedProjectId ||
      binding.providerPolicy.sha256 !== providerPolicySha256 ||
      binding.providerPolicy.uri !==
        `release-state://${event.namespace}/evidence/${providerPolicySha256}` ||
      !SHA256_PATTERN.test(binding.providerConfigurationHash)
    ) {
      throw new Error(
        "Prepared promotion provider policy or stable configuration binding differs",
      );
    }
  }

  assertExactKeys(
    result.subjectReference,
    ["sha256", "uri"],
    "Prepared promotion subject reference",
  );
  assertImmutableObjectReference(
    result.subjectReference,
    event.namespace,
    "Prepared promotion subject reference",
  );
  if (
    result.subjectSha256 !== result.subjectReference.sha256 ||
    !SHA256_PATTERN.test(result.subjectSha256)
  ) {
    throw new Error("Prepared promotion subject hash differs");
  }
  assertEvidenceReferencePresent(
    event,
    result.subjectReference,
    "Prepared promotion subject",
  );
  if (
    !Array.isArray(event.evidenceRefs) ||
    new Set(event.evidenceRefs.map((reference) => reference.uri)).size !==
      event.evidenceRefs.length
  ) {
    throw new Error("Prepared promotion evidence set is invalid");
  }
  for (const reference of event.evidenceRefs) {
    assertImmutableObjectReference(
      reference,
      event.namespace,
      "Prepared promotion evidence",
    );
  }

  const token = assertPreparedPromotionEnvironment({
    environment,
    providerPolicy,
    event,
    operation,
  });
  assertApprovalSet({
    approvals: result.approvalRefs,
    event,
    operation,
    subjectSha256: result.subjectSha256,
    environment,
  });
  return {
    result,
    event,
    operation,
    domains,
    token,
    providerPolicySha256,
  };
};

const readBoundedResponse = async (response) => {
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength !== null &&
    declaredLength !== undefined &&
    (!/^[0-9]+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new Error("Vercel alias response exceeds the size ceiling");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Vercel alias response size is invalid");
  }
  return bytes;
};

const assertFreshProviderDate = ({
  responseDate,
  providerPolicy,
  nowMilliseconds,
  domain,
}) => {
  const timestamp = Date.parse(responseDate);
  const age = nowMilliseconds - timestamp;
  if (
    !Number.isFinite(timestamp) ||
    age > providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    age < -providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(
      `Vercel alias observation for ${domain} is outside the freshness window`,
    );
  }
};

const aliasRequestUrl = ({ providerPolicy, domain }) => {
  const url = new URL(
    `/v4/aliases/${encodeURIComponent(domain)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  url.searchParams.set("projectId", providerPolicy.expectedProjectId);
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  url.searchParams.sort();
  return url.href;
};

const safeProviderString = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !containsControlCharacter(value)
    ? value
    : null;

const deriveAliasAssignment = ({
  body,
  responseStatus,
  domain,
  providerPolicy,
}) => {
  if (
    responseStatus !== 200 ||
    !isRecord(body) ||
    body.alias !== domain ||
    body.projectId !== providerPolicy.expectedProjectId ||
    (body.redirect !== null && body.redirect !== undefined)
  ) {
    return {
      providerProjectId: safeProviderString(body?.projectId),
      assignedDeploymentId: null,
    };
  }
  const topLevelId = safeProviderString(body.deploymentId);
  const nestedId = safeProviderString(body.deployment?.id);
  if (topLevelId === null || (nestedId !== null && nestedId !== topLevelId)) {
    return {
      providerProjectId: body.projectId,
      assignedDeploymentId: null,
    };
  }
  return {
    providerProjectId: body.projectId,
    assignedDeploymentId: topLevelId,
  };
};

const fetchAliasReceipt = async ({
  providerPolicy,
  domain,
  token,
  phase,
  fetchImpl,
  nowMilliseconds,
}) => {
  const requestUrl = aliasRequestUrl({ providerPolicy, domain });
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Vercel alias request failed for ${domain}`);
  }
  if (
    !response ||
    !Number.isSafeInteger(response.status) ||
    (typeof response.url === "string" &&
      response.url.length > 0 &&
      response.url !== requestUrl)
  ) {
    throw new Error(
      `Vercel alias response URL/status is invalid for ${domain}`,
    );
  }
  const bytes = await readBoundedResponse(response);
  const responseDate = response.headers?.get?.("date");
  const etag = response.headers?.get?.("etag");
  if (
    typeof responseDate !== "string" ||
    (providerPolicy.observationPolicy.requireEtag &&
      (typeof etag !== "string" || etag.length === 0 || etag.length > 512))
  ) {
    throw new Error(`Vercel alias response headers are invalid for ${domain}`);
  }
  assertFreshProviderDate({
    responseDate,
    providerPolicy,
    nowMilliseconds,
    domain,
  });
  let body = null;
  try {
    body = parseJsonStrict(bytes.toString("utf8"), requestUrl);
  } catch {
    body = null;
  }
  const assignment = deriveAliasAssignment({
    body,
    responseStatus: response.status,
    domain,
    providerPolicy,
  });
  const receipt = {
    schemaVersion: 1,
    receiptKind: "vercel-domain-assignment-observation/v1",
    phase,
    productionDomain: domain,
    method: "GET",
    requestUrl,
    status: response.status,
    responseDate,
    etag: typeof etag === "string" ? etag : null,
    bodySha256: sha256Bytes(bytes),
    providerProjectId: assignment.providerProjectId,
    assignedDeploymentId: assignment.assignedDeploymentId,
  };
  return {
    productionDomain: domain,
    receiptSha256: sha256Json(receipt),
    receipt,
  };
};

export const observeOwnedProductionDomains = async ({
  providerPolicy,
  domains,
  token,
  phase,
  fetchImpl = globalThis.fetch,
  nowMilliseconds = Date.now(),
}) => {
  if (!["before", "after"].includes(phase)) {
    throw new Error("Provider assignment observation phase is invalid");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Provider fetch implementation is unavailable");
  }
  const receipts = await Promise.all(
    domains.map((domain) =>
      fetchAliasReceipt({
        providerPolicy,
        domain,
        token,
        phase,
        fetchImpl,
        nowMilliseconds,
      }),
    ),
  );
  const observation = {
    schemaVersion: 1,
    observationKind: "vercel-owned-domain-assignment/v1",
    phase,
    observedAt: new Date(nowMilliseconds).toISOString(),
    providerTeamId: providerPolicy.expectedTeamId,
    providerProjectId: providerPolicy.expectedProjectId,
    receipts,
  };
  return {
    observation,
    observationSha256: sha256Json(observation),
  };
};

export const classifyPreparedPromotionObservation = ({
  observation,
  targetDeploymentId,
  previousDeploymentId,
}) => {
  const assignments = observation.observation.receipts.map(
    (reference) => reference.receipt.assignedDeploymentId,
  );
  if (
    assignments.length === 0 ||
    assignments.some((deploymentId) => deploymentId === null)
  ) {
    return "unknown";
  }
  if (
    assignments.every((deploymentId) => deploymentId === targetDeploymentId)
  ) {
    return "target";
  }
  if (
    previousDeploymentId !== null &&
    assignments.every((deploymentId) => deploymentId === previousDeploymentId)
  ) {
    return "previous";
  }
  if (
    previousDeploymentId !== null &&
    assignments.every(
      (deploymentId) =>
        deploymentId === previousDeploymentId ||
        deploymentId === targetDeploymentId,
    )
  ) {
    return "partial";
  }
  return "unknown";
};

const collectBoundProviderConfiguration = async ({
  providerPolicy,
  domains,
  token,
  expectedConfigurationHash,
  phase,
  fetchImpl,
  clock,
  collectProviderObservation,
  configurationHash,
}) => {
  const observedAtMilliseconds = clock();
  const observation = await collectProviderObservation({
    policy: providerPolicy,
    token,
    fetchImpl,
    now: () => observedAtMilliseconds,
  });
  if (
    !isRecord(observation) ||
    observation.schemaVersion !== 1 ||
    observation.evidenceKind !== "vercel-provider-observation-v1" ||
    observation.provider !== "vercel" ||
    observation.providerTeamId !== providerPolicy.expectedTeamId ||
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(observation.ownedProductionDomains, domains) ||
    !Array.isArray(observation.evidenceReceipts)
  ) {
    throw new Error(
      `${phase} full provider configuration observation binding is invalid`,
    );
  }
  const observationTimestamp = Date.parse(observation.observedAt);
  const age = observedAtMilliseconds - observationTimestamp;
  if (
    !Number.isFinite(observationTimestamp) ||
    age > providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    age < -providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(
      `${phase} full provider configuration observation is stale`,
    );
  }
  const stableHash = configurationHash(observation);
  if (
    !SHA256_PATTERN.test(stableHash) ||
    stableHash !== expectedConfigurationHash
  ) {
    throw new Error(
      `${phase} full provider configuration differs from the prepared binding`,
    );
  }
  const observationBytes = canonicalJsonBytes(observation);
  assertTokenAbsent(
    observationBytes,
    token,
    `${phase} full provider configuration observation`,
  );
  return {
    observation,
    providerObservationSha256: sha256Bytes(observationBytes),
    providerConfigurationHash: stableHash,
  };
};

export const resolvePinnedVercelCli = async ({
  root = repositoryRoot,
  toolchainPolicy,
}) => {
  if (
    !isRecord(toolchainPolicy) ||
    toolchainPolicy.schemaVersion !== 1 ||
    typeof toolchainPolicy.packages?.vercel !== "string"
  ) {
    throw new Error("Pinned toolchain policy is invalid");
  }
  const require = createRequire(path.join(root, "package.json"));
  const manifestPath = require.resolve("vercel/package.json");
  const manifest = parseJsonStrict(
    await readFile(manifestPath, "utf8"),
    manifestPath,
  );
  if (
    manifest.name !== "vercel" ||
    manifest.version !== toolchainPolicy.packages.vercel ||
    typeof manifest.bin?.vercel !== "string"
  ) {
    throw new Error("Pinned local Vercel CLI identity differs");
  }
  const packageRoot = path.dirname(manifestPath);
  const cliPath = path.resolve(packageRoot, manifest.bin.vercel);
  const relative = path.relative(packageRoot, cliPath);
  const metadata = await lstat(cliPath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error("Pinned local Vercel CLI path/type is invalid");
  }
  return { cliPath, version: manifest.version };
};

const defaultCommandRunner = ({
  executable,
  arguments: arguments_,
  cwd,
  environment,
}) =>
  spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  });

const assertTokenAbsent = (value, token, label) => {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value ?? ""), "utf8");
  if (bytes.includes(Buffer.from(token, "utf8"))) {
    throw new Error(`${label} contains VERCEL_TOKEN`);
  }
};

const assertCommandResult = ({ result, error, token }) => {
  if (error !== null) {
    throw new Error("Pinned Vercel promote command could not be executed");
  }
  const stdout = result?.stdout ?? "";
  const stderr = result?.stderr ?? "";
  if (
    Buffer.byteLength(String(stdout), "utf8") > MAX_COMMAND_OUTPUT_BYTES ||
    Buffer.byteLength(String(stderr), "utf8") > MAX_COMMAND_OUTPUT_BYTES
  ) {
    throw new Error("Pinned Vercel promote output exceeds the size ceiling");
  }
  assertTokenAbsent(stdout, token, "Pinned Vercel promote stdout");
  assertTokenAbsent(stderr, token, "Pinned Vercel promote stderr");
  if (result?.error !== undefined || result?.status !== 0) {
    throw new Error(
      `Pinned Vercel promote failed with status ${String(result?.status)}`,
    );
  }
};

export const assertPromotionReceiptOutputAvailable = async (receiptPath) => {
  const resolved = path.resolve(receiptPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
  throw new Error("Prepared promotion receipt output already exists");
};

export const writeCanonicalPromotionReceipt = async ({
  receiptPath,
  receipt,
  token,
}) => {
  const resolved = path.resolve(receiptPath);
  const bytes = canonicalJsonBytes(receipt);
  assertTokenAbsent(bytes, token, "Prepared promotion receipt");
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, resolved);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Prepared promotion receipt output already exists");
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { path: resolved, bytes };
};

const observationAssignment = (observation, domain) => {
  const matches = observation.observation.receipts.filter(
    (entry) => entry.productionDomain === domain,
  );
  if (matches.length !== 1) {
    throw new Error("Provider assignment observation domain set is ambiguous");
  }
  return matches[0].receipt.assignedDeploymentId;
};

const createPromotionReceipt = ({
  validated,
  providerPolicy,
  beforeProviderConfiguration,
  afterProviderConfiguration,
  before,
  after,
  outcome,
  cliVersion,
  commandExecuted,
  completedAt,
}) => {
  const { result, event, operation, domains, providerPolicySha256 } = validated;
  const target = operation.targetBinding;
  const idempotencyKey = `promotion:${sha256Json({
    kind: "prepared-provider-promotion/v1",
    eventHash: result.eventHash,
    providerTeamId: providerPolicy.expectedTeamId,
    providerProjectId: providerPolicy.expectedProjectId,
    domains,
    targetDeploymentId: target.providerDeploymentId,
  })}`;
  const receiptSet = {
    before: before.observation.receipts,
    after: after.observation.receipts,
  };
  const assignments = domains.map((productionDomain) => ({
    productionDomain,
    previousDeploymentId: observationAssignment(before, productionDomain),
    assignedDeploymentId: observationAssignment(after, productionDomain),
  }));
  const assignmentEvidence = {
    schemaVersion: 1,
    evidenceKind: "assignment-receipt",
    providerProjectId: providerPolicy.expectedProjectId,
    assignments,
    assignmentApiReceiptSetHash: sha256Json(receiptSet),
  };
  return {
    schemaVersion: 1,
    receiptKind: "vercel-prepared-promotion/v1",
    provider: "vercel",
    outcome,
    idempotencyKey,
    completedAt,
    preparedEvent: {
      uri: result.eventUri,
      sha256: result.eventHash,
      sequence: event.sequence,
      operationId: event.operationId,
      committedAt: result.committedAt,
    },
    sourceSha: target.sourceSha,
    target: {
      bindingId: target.bindingId,
      releaseRole: target.releaseRole,
      providerDeploymentId: target.providerDeploymentId,
      deploymentUrl: target.deploymentUrl,
      providerDeploymentEvidenceSha256: target.providerEvidence.sha256,
    },
    companion:
      operation.companionBinding === null
        ? null
        : {
            bindingId: operation.companionBinding.bindingId,
            releaseRole: operation.companionBinding.releaseRole,
            providerDeploymentId:
              operation.companionBinding.providerDeploymentId,
            providerDeploymentEvidenceSha256:
              operation.companionBinding.providerEvidence.sha256,
          },
    approvalReferences: result.approvalRefs.map((approval) => ({
      role: approval.role,
      uri: approval.uri,
      sha256: approval.sha256,
    })),
    providerBinding: {
      providerTeamId: providerPolicy.expectedTeamId,
      providerProjectId: providerPolicy.expectedProjectId,
      providerPolicySha256,
      providerConfigurationHash: target.providerConfigurationHash,
      beforeProviderObservationSha256:
        beforeProviderConfiguration.providerObservationSha256,
      afterProviderObservationSha256:
        afterProviderConfiguration.providerObservationSha256,
    },
    beforeProviderObservation: {
      sha256: beforeProviderConfiguration.providerObservationSha256,
      value: beforeProviderConfiguration.observation,
    },
    afterProviderObservation: {
      sha256: afterProviderConfiguration.providerObservationSha256,
      value: afterProviderConfiguration.observation,
    },
    beforeObservation: {
      sha256: before.observationSha256,
      value: before.observation,
    },
    afterObservation: {
      sha256: after.observationSha256,
      value: after.observation,
    },
    assignmentEvidence,
    cli: {
      package: "vercel",
      version: cliVersion,
      operation: "promote",
      executed: commandExecuted,
    },
  };
};

export const promotePreparedOperation = async (
  options,
  {
    fetchImpl = globalThis.fetch,
    commandRunner = defaultCommandRunner,
    resolveCli = resolvePinnedVercelCli,
    writeReceipt = writeCanonicalPromotionReceipt,
    collectProviderObservation = collectVercelProviderObservation,
    configurationHash = providerConfigurationHash,
    clock = Date.now,
  } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    preparedResultBytes,
    providerPolicy,
    toolchainPolicy,
    receiptPath,
    root = repositoryRoot,
    environment = process.env,
  } = options;
  const resolvedReceiptPath =
    await assertPromotionReceiptOutputAvailable(receiptPath);
  const validated = validatePreparedPromotionResult({
    preparedResultBytes,
    providerPolicy,
    environment,
    nowMilliseconds: clock(),
  });
  if (
    !isRecord(toolchainPolicy) ||
    toolchainPolicy.schemaVersion !== 1 ||
    typeof toolchainPolicy.packages?.vercel !== "string"
  ) {
    throw new Error("Pinned toolchain policy is invalid");
  }

  const beforeProviderConfiguration = await collectBoundProviderConfiguration({
    providerPolicy,
    domains: validated.domains,
    token: validated.token,
    expectedConfigurationHash:
      validated.operation.targetBinding.providerConfigurationHash,
    phase: "Before-promotion",
    fetchImpl,
    clock,
    collectProviderObservation,
    configurationHash,
  });
  const before = await observeOwnedProductionDomains({
    providerPolicy,
    domains: validated.domains,
    token: validated.token,
    phase: "before",
    fetchImpl,
    nowMilliseconds: clock(),
  });
  const targetDeploymentId =
    validated.operation.targetBinding.providerDeploymentId;
  const previousDeploymentId =
    validated.operation.previousBinding?.providerDeploymentId ?? null;
  const beforeState = classifyPreparedPromotionObservation({
    observation: before,
    targetDeploymentId,
    previousDeploymentId,
  });
  if (!["target", "previous"].includes(beforeState)) {
    throw new Error(
      `Prepared promotion is blocked by ${beforeState} production assignments`,
    );
  }

  let cliVersion = toolchainPolicy.packages.vercel;
  let commandResult = null;
  let commandError = null;
  let commandExecuted = false;
  if (beforeState === "previous") {
    const cli = await resolveCli({ root, toolchainPolicy });
    cliVersion = cli.version;
    const arguments_ = [
      cli.cliPath,
      "promote",
      validated.operation.targetBinding.deploymentUrl,
      "--yes",
    ];
    for (const argument of arguments_) {
      assertTokenAbsent(argument, validated.token, "Vercel promote argument");
    }
    commandExecuted = true;
    try {
      commandResult = await commandRunner({
        executable: process.execPath,
        arguments: arguments_,
        cwd: root,
        environment: buildClosedVercelCommandEnvironment(environment),
      });
    } catch (error) {
      commandError = error;
    }
  }

  const after = await observeOwnedProductionDomains({
    providerPolicy,
    domains: validated.domains,
    token: validated.token,
    phase: "after",
    fetchImpl,
    nowMilliseconds: clock(),
  });
  const afterState = classifyPreparedPromotionObservation({
    observation: after,
    targetDeploymentId,
    previousDeploymentId,
  });
  if (afterState !== "target") {
    throw new Error(
      `Prepared promotion post-observation is ${afterState}, not target`,
    );
  }
  const afterProviderConfiguration = await collectBoundProviderConfiguration({
    providerPolicy,
    domains: validated.domains,
    token: validated.token,
    expectedConfigurationHash:
      validated.operation.targetBinding.providerConfigurationHash,
    phase: "After-promotion",
    fetchImpl,
    clock,
    collectProviderObservation,
    configurationHash,
  });
  if (commandExecuted) {
    assertCommandResult({
      result: commandResult,
      error: commandError,
      token: validated.token,
    });
  }

  const receipt = createPromotionReceipt({
    validated,
    providerPolicy,
    beforeProviderConfiguration,
    afterProviderConfiguration,
    before,
    after,
    outcome: beforeState === "target" ? "replayed" : "promoted",
    cliVersion,
    commandExecuted,
    completedAt: new Date(clock()).toISOString(),
  });
  const written = await writeReceipt({
    receiptPath: resolvedReceiptPath,
    receipt,
    token: validated.token,
  });
  return {
    receipt,
    receiptPath: written.path,
    receiptSha256: sha256Bytes(written.bytes),
    replayed: beforeState === "target",
  };
};
