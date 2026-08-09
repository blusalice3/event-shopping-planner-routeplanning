import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  assertNamedPrePromotionEvidence,
  resolveNamedPrePromotionEvidence,
} from "./prePromotionEvidence.mjs";
import { validatePromotionSubject } from "./promotionPreparation.mjs";
import {
  PROVIDER_ALIAS_OBSERVATION_KIND,
  decideProviderReconciliation,
  resolvePendingProviderAuthority,
  storeProviderAliasObservation,
} from "./reconcileDecision.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  collectBindingEvidenceReferences,
  compareUtf8,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";
import {
  collectReviewedWorkflowRunAuthority,
  readBoundReviewedWorkflowRunAuthority,
} from "./reviewedWorkflowRunAuthority.mjs";

export const PRE_PROMOTION_EVIDENCE_SET_KIND = "pre-promotion-evidence-set/v2";
export const PRE_PROMOTION_EVIDENCE_SOURCE_KIND =
  "pre-promotion-evidence-source/v2";
const VERCEL_API_ORIGIN = "https://api.vercel.com";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
const MAX_PROVIDER_TOKEN_LENGTH = 4096;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FORBIDDEN_DERIVED_FIELDS = [
  "emergencyRecoveryBinding",
  "expectedState",
  "previousBinding",
  "snapshot",
];

const assertNoDerivedInput = (options) => {
  if (options === null || typeof options !== "object") {
    throw new Error("Authoritative producer options are invalid");
  }
  for (const field of FORBIDDEN_DERIVED_FIELDS) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `Caller-supplied ${field} is forbidden; it is derived from replayed state`,
      );
    }
  }
};

const replayedNamespace = (current) =>
  current.records[0]?.event?.namespace ?? null;

const deriveEmergencyRecovery = (snapshot) => {
  if (snapshot.activeProduction?.releaseRole === "containment") {
    return snapshot.activeProduction;
  }
  return snapshot.containmentCompanion ?? snapshot.bootstrapRecovery;
};

const parseEvidenceSet = async ({
  bytes,
  namespace,
  sourceSha,
  repository,
  store,
}) => {
  const evidenceSet = parseCanonicalJsonBytes(
    bytes,
    "Pre-promotion evidence set",
  );
  assertExactKeys(
    evidenceSet,
    [
      "evidence",
      "evidenceKind",
      "namespace",
      "schemaVersion",
      "workflowRunAuthority",
    ],
    "Pre-promotion evidence set",
  );
  if (
    evidenceSet.schemaVersion !== 1 ||
    evidenceSet.evidenceKind !== PRE_PROMOTION_EVIDENCE_SET_KIND ||
    evidenceSet.namespace !== namespace
  ) {
    throw new Error("Pre-promotion evidence set identity is invalid");
  }
  assertNamedPrePromotionEvidence(evidenceSet.evidence, namespace);
  await readBoundReviewedWorkflowRunAuthority({
    namespace,
    repository,
    expectedSourceSha: sourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    reference: evidenceSet.workflowRunAuthority,
    store,
  });
  return evidenceSet;
};

export const buildAuthoritativePrePromotionEvidenceSet = async (
  options,
  {
    readState = readCurrentReleaseState,
    collectRunAuthority = collectReviewedWorkflowRunAuthority,
  } = {},
) => {
  assertNoDerivedInput(options);
  const {
    store,
    namespace,
    sourceSha,
    sourceBytes,
    expectedSourceSha256,
    currentRunId,
    githubToken,
    repository,
  } = options;
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !SOURCE_SHA_PATTERN.test(sourceSha) ||
    !Buffer.isBuffer(sourceBytes) ||
    !SHA256_PATTERN.test(expectedSourceSha256) ||
    sha256Bytes(sourceBytes) !== expectedSourceSha256 ||
    !/^[1-9][0-9]{0,19}$/.test(currentRunId ?? "") ||
    typeof githubToken !== "string" ||
    githubToken.length < 8 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")
  ) {
    throw new Error("Pre-promotion evidence source binding is invalid");
  }
  const current = await readState({ store });
  if (
    replayedNamespace(current) !== namespace ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error(
      "Pre-promotion evidence namespace differs from replayed Release State",
    );
  }
  const source = parseCanonicalJsonBytes(
    sourceBytes,
    "Pre-promotion evidence source",
  );
  assertExactKeys(
    source,
    ["evidence", "namespace", "schemaVersion", "sourceKind", "sourceSha"],
    "Pre-promotion evidence source",
  );
  if (
    source.schemaVersion !== 1 ||
    source.sourceKind !== PRE_PROMOTION_EVIDENCE_SOURCE_KIND ||
    source.namespace !== namespace ||
    source.sourceSha !== sourceSha
  ) {
    throw new Error("Pre-promotion evidence source identity is invalid");
  }
  assertNamedPrePromotionEvidence(source.evidence, namespace);
  const resolved = await resolveNamedPrePromotionEvidence({
    store,
    namespace,
    namedEvidence: source.evidence,
    snapshot: current.snapshot,
  });
  if (resolved.workflowRun.workflowRunId === currentRunId) {
    throw new Error(
      "Pre-promotion evidence source must come from a distinct prior run",
    );
  }
  const workflowRunAuthority = await collectRunAuthority({
    githubToken,
    namespace,
    repository,
    expectedRunId: resolved.workflowRun.workflowRunId,
    expectedRunAttempt: String(resolved.workflowRun.runAttempt),
    expectedSourceSha: sourceSha,
    expectedWorkflowPath: ".github/workflows/release.yml",
    store,
  });
  const evidenceSet = {
    schemaVersion: 1,
    evidenceKind: PRE_PROMOTION_EVIDENCE_SET_KIND,
    namespace,
    evidence: source.evidence,
    workflowRunAuthority: workflowRunAuthority.receipt,
  };
  const evidenceSetBytes = canonicalJsonBytes(evidenceSet);
  return {
    evidenceSet,
    evidenceSetBytes,
    evidenceSetSha256: sha256Bytes(evidenceSetBytes),
    sourceSha,
    sourceEvidenceSha256: expectedSourceSha256,
  };
};

const verifyBindingEvidence = async ({
  store,
  namespace,
  bindings,
  extraReferences,
}) => {
  for (const [label, binding] of bindings) {
    await validateProviderEvidenceForBinding({
      store,
      namespace,
      binding,
      label,
    });
  }
  const references = sortAndDedupeReferences(
    [
      ...extraReferences,
      ...bindings.flatMap(([, binding]) =>
        collectBindingEvidenceReferences(binding),
      ),
    ],
    namespace,
  );
  for (const reference of references) {
    await assertEvidenceObjectAvailable({
      store,
      reference,
      namespace,
      label: "Authoritative input evidence",
    });
  }
  return references;
};

export const buildAuthoritativePromotionSubject = async (
  options,
  { readState = readCurrentReleaseState } = {},
) => {
  assertNoDerivedInput(options);
  const {
    store,
    namespace,
    operationId,
    standardBindingBytes,
    containmentBindingBytes,
    evidenceSetBytes,
  } = options;
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw new Error("Promotion subject producer binding is invalid");
  }
  const current = await readState({ store });
  if (
    replayedNamespace(current) !== namespace ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error(
      "Promotion subject namespace differs from replayed Release State",
    );
  }
  const standard = parseCanonicalJsonBytes(
    standardBindingBytes,
    "Standard deployment binding",
  );
  const companion = parseCanonicalJsonBytes(
    containmentBindingBytes,
    "Containment deployment binding",
  );
  assertDeploymentBinding(standard, {
    namespace,
    expectedRole: "standard",
    label: "Promotion target",
  });
  assertDeploymentBinding(companion, {
    namespace,
    expectedRole: "containment",
    label: "Promotion companion",
  });
  const emergencyRecoveryBinding = deriveEmergencyRecovery(current.snapshot);
  if (emergencyRecoveryBinding === null) {
    throw new Error("Replayed state has no emergency recovery binding");
  }
  const evidenceSet = await parseEvidenceSet({
    bytes: evidenceSetBytes,
    namespace,
    sourceSha: standard.sourceSha,
    repository: null,
    store,
  });
  const resolvedPrePromotionEvidence = await resolveNamedPrePromotionEvidence({
    store,
    namespace,
    namedEvidence: evidenceSet.evidence,
    bindings: { standard, containment: companion },
    snapshot: current.snapshot,
  });
  const subject = {
    schemaVersion: 1,
    subjectKind: "promotion-preparation-subject/v1",
    namespace,
    operationId,
    operationKind: "promote-standard",
    expectedState: {
      sequence: current.snapshot.sequence,
      eventHash: current.snapshot.eventHash,
    },
    targetBinding: standard,
    companionBinding: companion,
    previousBinding: current.snapshot.activeProduction,
    emergencyRecoveryBinding,
    evidenceRefs: resolvedPrePromotionEvidence.references,
  };
  validatePromotionSubject({ subject, snapshot: current.snapshot });
  await verifyBindingEvidence({
    store,
    namespace,
    bindings: [
      ["Promotion target", standard],
      ["Promotion companion", companion],
      ...(subject.previousBinding === null
        ? []
        : [["Promotion previous", subject.previousBinding]]),
      ["Promotion emergency recovery", emergencyRecoveryBinding],
    ],
    extraReferences: [
      ...resolvedPrePromotionEvidence.references,
      evidenceSet.workflowRunAuthority,
    ],
  });
  const subjectBytes = canonicalJsonBytes(subject);
  return {
    subject,
    subjectBytes,
    subjectSha256: sha256Bytes(subjectBytes),
    expectedState: subject.expectedState,
  };
};

const readBoundedProviderResponse = async ({ response, expectedUrl }) => {
  if (
    !response ||
    response.status !== 200 ||
    typeof response.arrayBuffer !== "function" ||
    (response.url && response.url !== expectedUrl)
  ) {
    throw new Error("Vercel alias API response binding is invalid");
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Vercel alias API response is oversized");
  }
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  if (
    bodyBytes.length === 0 ||
    bodyBytes.length > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Vercel alias API response is empty or oversized");
  }
  const providerDate = response.headers?.get?.("date");
  if (!Number.isFinite(Date.parse(providerDate ?? ""))) {
    throw new Error("Vercel alias API response lacks an authoritative Date");
  }
  return { bodyBytes, providerDate };
};

export const collectVercelAliasAssignments = async ({
  domains,
  expectedProjectId,
  expectedTeamId,
  token,
  fetchImpl = fetch,
}) => {
  if (
    !Array.isArray(domains) ||
    domains.length === 0 ||
    domains.some(
      (domain) => typeof domain !== "string" || !DOMAIN_PATTERN.test(domain),
    ) ||
    typeof expectedProjectId !== "string" ||
    expectedProjectId.length === 0 ||
    typeof expectedTeamId !== "string" ||
    expectedTeamId.length === 0 ||
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > MAX_PROVIDER_TOKEN_LENGTH ||
    [...token].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Vercel alias collector binding is invalid");
  }
  const orderedDomains = [...domains].sort(compareUtf8);
  if (new Set(orderedDomains).size !== orderedDomains.length) {
    throw new Error("Owned production domains are not distinct");
  }
  const results = [];
  for (const productionDomain of orderedDomains) {
    const url = new URL(
      `/v4/aliases/${encodeURIComponent(productionDomain)}`,
      VERCEL_API_ORIGIN,
    );
    url.searchParams.set("teamId", expectedTeamId);
    const requestUrl = url.toString();
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const { bodyBytes, providerDate } = await readBoundedProviderResponse({
      response,
      expectedUrl: requestUrl,
    });
    const body = parseJsonStrict(
      bodyBytes.toString("utf8"),
      "Vercel alias API response",
    );
    const deploymentId = body?.deploymentId ?? body?.deployment?.id;
    if (
      body?.alias !== productionDomain ||
      body?.projectId !== expectedProjectId ||
      typeof deploymentId !== "string" ||
      deploymentId.length === 0 ||
      (body?.deployment?.id !== undefined &&
        body.deployment.id !== deploymentId)
    ) {
      throw new Error(
        `Vercel alias API response differs for ${productionDomain}`,
      );
    }
    results.push({
      productionDomain,
      providerProjectId: body.projectId,
      providerDeploymentId: deploymentId,
      requestUrl,
      responseUrl: response.url || requestUrl,
      status: response.status,
      providerDate,
      bodyBytes,
      responseSha256: sha256Bytes(bodyBytes),
    });
  }
  return results;
};

const putVerifiedEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const sha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    !receipt ||
    receipt.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

export const buildAuthoritativeProviderAliasObservation = async (
  options,
  {
    readState = readCurrentReleaseState,
    collectAssignments = collectVercelAliasAssignments,
    decideReconciliation = decideProviderReconciliation,
    now = Date.now,
  } = {},
) => {
  if (options === null || typeof options !== "object") {
    throw new Error("Authoritative provider producer options are invalid");
  }
  if (
    Object.hasOwn(options, "assignments") ||
    Object.hasOwn(options, "observedBinding") ||
    Object.hasOwn(options, "snapshot") ||
    Object.hasOwn(options, "providerPolicy")
  ) {
    throw new Error(
      "Caller-supplied assignments, binding, snapshot, or provider policy are forbidden",
    );
  }
  const { store, namespace, providerToken, fetchImpl = fetch } = options;
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw new Error("Provider observation producer binding is invalid");
  }
  const current = await readState({ store });
  if (
    replayedNamespace(current) !== namespace ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error(
      "Provider observation namespace differs from replayed Release State",
    );
  }
  const pending = current.snapshot.pendingOperation;
  if (pending === null) {
    throw new Error("Provider observation requires a pending operation");
  }
  const authority = await resolvePendingProviderAuthority({ store, current });
  const { providerPolicy } = authority;
  const collected = await collectAssignments({
    domains: providerPolicy.ownedProductionDomains,
    expectedProjectId: providerPolicy.expectedProjectId,
    expectedTeamId: providerPolicy.expectedTeamId,
    token: providerToken,
    fetchImpl,
  });
  if (!Array.isArray(collected)) {
    throw new Error("Provider alias collector did not return receipts");
  }

  const receiptReferences = [];
  const assignments = [];
  const observedAt = now();
  if (!Number.isFinite(observedAt)) {
    throw new Error("Provider observation clock is invalid");
  }
  for (const result of collected) {
    const providerTimestamp = Date.parse(result?.providerDate ?? "");
    if (
      !Buffer.isBuffer(result?.bodyBytes) ||
      result.status !== 200 ||
      result.responseSha256 !== sha256Bytes(result.bodyBytes) ||
      result.requestUrl !== result.responseUrl ||
      !Number.isFinite(providerTimestamp) ||
      observedAt - providerTimestamp >
        providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
      providerTimestamp - observedAt >
        providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000 ||
      result.providerProjectId !== providerPolicy.expectedProjectId
    ) {
      throw new Error("Provider alias collector receipt is invalid");
    }
    const responseReference = await putVerifiedEvidence({
      store,
      namespace,
      bytes: result.bodyBytes,
      mediaType: "application/vnd.vercel.alias-response+json",
      label: "Vercel alias response",
    });
    const receiptBytes = canonicalJsonBytes({
      schemaVersion: 1,
      receiptKind: "vercel-alias-read-receipt/v1",
      productionDomain: result.productionDomain,
      providerProjectId: result.providerProjectId,
      providerDeploymentId: result.providerDeploymentId,
      requestUrl: result.requestUrl,
      responseUrl: result.responseUrl,
      status: result.status,
      providerDate: new Date(result.providerDate).toISOString(),
      responseSha256: result.responseSha256,
      responseReference,
    });
    receiptReferences.push(
      await putVerifiedEvidence({
        store,
        namespace,
        bytes: receiptBytes,
        mediaType:
          "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1",
        label: "Vercel alias read receipt",
      }),
    );
    assignments.push({
      productionDomain: result.productionDomain,
      assignedDeploymentId: result.providerDeploymentId,
    });
  }
  assignments.sort((left, right) =>
    compareUtf8(left.productionDomain, right.productionDomain),
  );
  const expectedDomains = [...providerPolicy.ownedProductionDomains].sort(
    compareUtf8,
  );
  if (
    assignments.length !== expectedDomains.length ||
    new Set(assignments.map(({ productionDomain }) => productionDomain))
      .size !== expectedDomains.length ||
    !sameCanonicalValue(
      assignments.map(({ productionDomain }) => productionDomain),
      expectedDomains,
    )
  ) {
    throw new Error("Provider alias collection is partial or ambiguous");
  }
  const deploymentIds = new Set(
    assignments.map(({ assignedDeploymentId }) => assignedDeploymentId),
  );
  if (deploymentIds.size !== 1) {
    throw new Error("Provider alias deployment is ambiguous or unknown");
  }
  const [observedDeploymentId] = deploymentIds;
  const matchingBindings = [
    ...new Map(
      Object.values(authority.candidateBindings)
        .filter(
          (binding) => binding.providerDeploymentId === observedDeploymentId,
        )
        .map((binding) => [binding.bindingId, binding]),
    ).values(),
  ];
  if (matchingBindings.length !== 1) {
    throw new Error("Provider alias deployment is ambiguous or unknown");
  }
  const observedBinding = matchingBindings[0];
  const observation = {
    schemaVersion: 1,
    observationKind: PROVIDER_ALIAS_OBSERVATION_KIND,
    namespace,
    providerProjectId: providerPolicy.expectedProjectId,
    assignments,
    observedBinding,
    providerReceiptReferences: receiptReferences.sort((left, right) =>
      compareUtf8(left.uri, right.uri),
    ),
  };
  const observationBytes = canonicalJsonBytes(observation);
  const observationReference = await storeProviderAliasObservation({
    store,
    observationBytes,
  });
  const decision = await decideReconciliation(
    {
      store,
      observationBytes,
    },
    {
      now: () => observedAt,
    },
  );
  if (decision.status !== "ready") {
    throw new Error(
      `Provider observation failed reconcile validation: ${decision.reasonCodes.join(", ")}`,
    );
  }
  return {
    observation,
    observationBytes,
    observationSha256: sha256Bytes(observationBytes),
    observationReference,
    providerReceiptReferences: observation.providerReceiptReferences,
    decision,
  };
};
