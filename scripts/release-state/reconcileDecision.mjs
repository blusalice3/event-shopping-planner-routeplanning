import { parseJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  NAMESPACE_PATTERN,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  compareUtf8,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";

export const PROVIDER_ALIAS_OBSERVATION_KIND = "provider-alias-observation/v1";
export const RECONCILE_DECISION_KIND = "release-state-reconcile-decision/v1";

const OBSERVATION_KEYS = [
  "assignments",
  "namespace",
  "observationKind",
  "observedBinding",
  "providerProjectId",
  "providerReceiptReferences",
  "schemaVersion",
];
const ASSIGNMENT_KEYS = ["assignedDeploymentId", "productionDomain"];
const PROVIDER_RECEIPT_KEYS = [
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
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PROVIDER_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1";
const PROVIDER_RESPONSE_MEDIA_TYPE =
  "application/vnd.vercel.alias-response+json";

const sortedUniqueStrings = (values) => [...new Set(values)].sort(compareUtf8);

const assertProviderPolicy = (policy) => {
  if (
    policy?.bindingStatus !== "configured" ||
    typeof policy.expectedTeamId !== "string" ||
    policy.expectedTeamId.length === 0 ||
    typeof policy.expectedProjectId !== "string" ||
    policy.expectedProjectId.length === 0 ||
    !Array.isArray(policy.ownedProductionDomains) ||
    policy.ownedProductionDomains.length === 0 ||
    policy.ownedProductionDomains.some(
      (domain) => typeof domain !== "string" || !DOMAIN_PATTERN.test(domain),
    ) ||
    sortedUniqueStrings(policy.ownedProductionDomains).length !==
      policy.ownedProductionDomains.length ||
    policy.observationPolicy?.apiBaseUrl !== "https://api.vercel.com" ||
    !Number.isSafeInteger(policy.observationPolicy?.maxResponseAgeSeconds) ||
    policy.observationPolicy.maxResponseAgeSeconds < 0 ||
    !Number.isSafeInteger(
      policy.observationPolicy?.maxFutureClockSkewSeconds,
    ) ||
    policy.observationPolicy.maxFutureClockSkewSeconds < 0
  ) {
    throw new Error(
      `Provider policy is not configured: ${(policy?.blockerCodes ?? []).join(", ")}`,
    );
  }
};

const parseObservation = (observationBytes) => {
  const observation = parseCanonicalJsonBytes(
    observationBytes,
    "Provider alias observation",
  );
  assertExactKeys(observation, OBSERVATION_KEYS, "Provider alias observation");
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !== PROVIDER_ALIAS_OBSERVATION_KIND ||
    !NAMESPACE_PATTERN.test(observation.namespace) ||
    typeof observation.providerProjectId !== "string" ||
    observation.providerProjectId.length === 0 ||
    !Array.isArray(observation.assignments) ||
    !Array.isArray(observation.providerReceiptReferences)
  ) {
    throw new Error("Provider alias observation identity is invalid");
  }
  for (const assignment of observation.assignments) {
    assertExactKeys(assignment, ASSIGNMENT_KEYS, "Provider assignment");
    if (
      typeof assignment.productionDomain !== "string" ||
      !DOMAIN_PATTERN.test(assignment.productionDomain) ||
      typeof assignment.assignedDeploymentId !== "string" ||
      assignment.assignedDeploymentId.length === 0 ||
      assignment.assignedDeploymentId.length > 255
    ) {
      throw new Error("Provider assignment shape is invalid");
    }
  }
  const sortedReceiptReferences = sortAndDedupeReferences(
    observation.providerReceiptReferences,
    observation.namespace,
  );
  if (
    sortedReceiptReferences.length !==
      observation.providerReceiptReferences.length ||
    !sameCanonicalValue(
      sortedReceiptReferences,
      observation.providerReceiptReferences,
    )
  ) {
    throw new Error(
      "Provider receipt references must be distinct and UTF-8 sorted",
    );
  }
  return observation;
};

const validateReceiptRequestUrl = ({
  requestUrl,
  productionDomain,
  expectedTeamId,
}) => {
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    throw new Error("Provider receipt request URL is invalid");
  }
  const expectedPath = `/v4/aliases/${encodeURIComponent(productionDomain)}`;
  if (
    parsed.origin !== "https://api.vercel.com" ||
    parsed.pathname !== expectedPath ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    [...parsed.searchParams.keys()].join("\n") !== "teamId" ||
    parsed.searchParams.getAll("teamId").length !== 1 ||
    parsed.searchParams.get("teamId") !== expectedTeamId
  ) {
    throw new Error("Provider receipt request URL differs from policy");
  }
};

const validateProviderReceiptChain = async ({
  store,
  namespace,
  observation,
  providerPolicy,
  nowMilliseconds,
}) => {
  if (
    observation.providerReceiptReferences.length !==
    observation.assignments.length
  ) {
    throw new Error("Provider receipt count differs from assignments");
  }
  const assignmentsByDomain = new Map(
    observation.assignments.map((assignment) => [
      assignment.productionDomain,
      assignment,
    ]),
  );
  const observedReceiptDomains = new Set();
  const responseReferences = [];
  for (const receiptReference of observation.providerReceiptReferences) {
    const storedReceipt = await assertEvidenceObjectAvailable({
      store,
      reference: receiptReference,
      namespace,
      label: "Provider alias read receipt",
    });
    if (storedReceipt.mediaType !== PROVIDER_RECEIPT_MEDIA_TYPE) {
      throw new Error("Provider alias receipt media type is invalid");
    }
    const receipt = parseCanonicalJsonBytes(
      storedReceipt.bytes,
      "Provider alias read receipt",
    );
    assertExactKeys(
      receipt,
      PROVIDER_RECEIPT_KEYS,
      "Provider alias read receipt",
    );
    const assignment = assignmentsByDomain.get(receipt.productionDomain);
    const providerTimestamp = Date.parse(receipt.providerDate);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.receiptKind !== "vercel-alias-read-receipt/v1" ||
      assignment === undefined ||
      observedReceiptDomains.has(receipt.productionDomain) ||
      receipt.providerProjectId !== observation.providerProjectId ||
      receipt.providerDeploymentId !== assignment.assignedDeploymentId ||
      receipt.status !== 200 ||
      receipt.requestUrl !== receipt.responseUrl ||
      !Number.isFinite(providerTimestamp) ||
      receipt.providerDate !== new Date(providerTimestamp).toISOString() ||
      nowMilliseconds - providerTimestamp >
        providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
      providerTimestamp - nowMilliseconds >
        providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000 ||
      receipt.responseSha256 !== receipt.responseReference?.sha256
    ) {
      throw new Error("Provider alias receipt binding is invalid");
    }
    validateReceiptRequestUrl({
      requestUrl: receipt.requestUrl,
      productionDomain: receipt.productionDomain,
      expectedTeamId: providerPolicy.expectedTeamId,
    });
    const storedResponse = await assertEvidenceObjectAvailable({
      store,
      reference: receipt.responseReference,
      namespace,
      label: "Provider alias API response",
    });
    if (storedResponse.mediaType !== PROVIDER_RESPONSE_MEDIA_TYPE) {
      throw new Error("Provider alias response media type is invalid");
    }
    const responseBody = parseJsonStrict(
      storedResponse.bytes.toString("utf8"),
      "Provider alias API response",
    );
    const responseDeploymentId =
      responseBody?.deploymentId ?? responseBody?.deployment?.id;
    if (
      responseBody?.alias !== receipt.productionDomain ||
      responseBody?.projectId !== receipt.providerProjectId ||
      responseDeploymentId !== receipt.providerDeploymentId
    ) {
      throw new Error("Provider alias response differs from its receipt");
    }
    observedReceiptDomains.add(receipt.productionDomain);
    responseReferences.push(receipt.responseReference);
  }
  if (observedReceiptDomains.size !== assignmentsByDomain.size) {
    throw new Error("Provider alias receipts do not cover assignments");
  }
  return sortAndDedupeReferences(
    [...observation.providerReceiptReferences, ...responseReferences],
    namespace,
  );
};

export const storeProviderAliasObservation = async ({
  store,
  observationBytes: suppliedBytes,
}) => {
  if (!store || typeof store.putEvidence !== "function") {
    throw new Error("Release State store lacks immutable evidence writes");
  }
  const observationBytes = Buffer.isBuffer(suppliedBytes)
    ? suppliedBytes
    : Buffer.from(suppliedBytes ?? "");
  const observation = parseObservation(observationBytes);
  if (
    typeof store.namespace === "string" &&
    store.namespace !== observation.namespace
  ) {
    throw new Error(
      "Provider observation namespace differs from the evidence store",
    );
  }
  const sha256 = sha256Bytes(observationBytes);
  const mediaType =
    "application/vnd.event-shopping-planner.provider-alias-observation+json;version=1";
  const receipt = await store.putEvidence({
    bytes: observationBytes,
    mediaType,
  });
  if (
    !receipt ||
    receipt.sha256 !== sha256 ||
    receipt.uri !==
      `release-state://${observation.namespace}/evidence/${sha256}` ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== observationBytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error("Provider observation immutable-store receipt is invalid");
  }
  return {
    uri: receipt.uri,
    sha256: receipt.sha256,
  };
};

const createDecision = ({
  namespace,
  operationId,
  head,
  observationSha256,
  status,
  action,
  reasonCodes,
  targetBindingId,
  observedDeploymentId,
}) => ({
  schemaVersion: 1,
  decisionKind: RECONCILE_DECISION_KIND,
  namespace,
  operationId,
  expectedState: {
    sequence: head.sequence,
    eventHash: head.eventHash,
  },
  observationSha256,
  status,
  action,
  reasonCodes: sortedUniqueStrings(reasonCodes),
  targetBindingId,
  observedDeploymentId,
});

export const decideProviderReconciliation = async (
  options,
  { readState = readCurrentReleaseState, now = Date.now } = {},
) => {
  if (Object.hasOwn(options, "snapshot")) {
    throw new Error(
      "Caller-supplied snapshot is forbidden; Release State is replayed from the store",
    );
  }
  const { store, observationBytes: suppliedBytes, providerPolicy } = options;
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function"
  ) {
    throw new Error("Release State store lacks reconcile read operations");
  }
  assertProviderPolicy(providerPolicy);
  const observationBytes = Buffer.isBuffer(suppliedBytes)
    ? suppliedBytes
    : Buffer.from(suppliedBytes ?? "");
  const observation = parseObservation(observationBytes);
  const nowMilliseconds = now();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Provider reconciliation clock is invalid");
  }
  const current = await readState({ store });
  const namespace = current.records[0]?.event?.namespace;
  if (
    observation.namespace !== namespace ||
    (store.namespace !== undefined && store.namespace !== namespace)
  ) {
    throw new Error(
      "Provider observation namespace differs from the replayed state",
    );
  }

  const observationSha256 = sha256Bytes(observationBytes);
  const observationReference = {
    uri: `release-state://${namespace}/evidence/` + observationSha256,
    sha256: observationSha256,
  };
  const reasons = [];
  try {
    const storedObservation = await assertEvidenceObjectAvailable({
      store,
      reference: observationReference,
      namespace,
      label: "Provider alias observation",
    });
    if (!storedObservation.bytes.equals(observationBytes)) {
      reasons.push("provider-observation-bytes-differ");
    }
  } catch {
    reasons.push("provider-observation-unverifiable");
  }
  let providerReceiptChainReferences = [];
  try {
    providerReceiptChainReferences = await validateProviderReceiptChain({
      store,
      namespace,
      observation,
      providerPolicy,
      nowMilliseconds,
    });
  } catch {
    reasons.push("provider-receipt-chain-unverifiable");
  }

  const pending = current.snapshot.pendingOperation;
  if (pending === null) {
    reasons.push("no-pending-operation");
  }
  if (
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    (pending !== null &&
      observation.providerProjectId !== pending.targetBinding.providerProjectId)
  ) {
    reasons.push("provider-project-mismatch");
  }

  const expectedDomains = sortedUniqueStrings(
    providerPolicy.ownedProductionDomains,
  );
  const observedDomains = observation.assignments.map(
    ({ productionDomain }) => productionDomain,
  );
  const distinctObservedDomains = sortedUniqueStrings(observedDomains);
  if (distinctObservedDomains.length !== observedDomains.length) {
    reasons.push("ambiguous-production-domain");
  }
  if (
    expectedDomains.some((domain) => !distinctObservedDomains.includes(domain))
  ) {
    reasons.push("partial-production-domain-set");
  }
  if (
    distinctObservedDomains.some((domain) => !expectedDomains.includes(domain))
  ) {
    reasons.push("unknown-production-domain");
  }
  const sortedAssignments = [...observation.assignments].sort((left, right) =>
    compareUtf8(left.productionDomain, right.productionDomain),
  );
  if (!sameCanonicalValue(sortedAssignments, observation.assignments)) {
    reasons.push("noncanonical-assignment-order");
  }

  const deploymentIds = sortedUniqueStrings(
    observation.assignments.map(
      ({ assignedDeploymentId }) => assignedDeploymentId,
    ),
  );
  if (deploymentIds.length !== 1) {
    reasons.push("ambiguous-provider-assignment");
  }
  const observedDeploymentId =
    deploymentIds.length === 1 ? deploymentIds[0] : null;
  const target = pending?.targetBinding ?? null;
  if (target !== null && observedDeploymentId !== null) {
    if (observedDeploymentId !== target.providerDeploymentId) {
      const knownRecoveryIds = [
        pending.previousBinding?.providerDeploymentId,
        pending.emergencyRecoveryBinding?.providerDeploymentId,
      ].filter(Boolean);
      reasons.push(
        knownRecoveryIds.includes(observedDeploymentId)
          ? "provider-assignment-not-target"
          : "unknown-provider-deployment",
      );
    }
  }

  if (observation.observedBinding === null) {
    reasons.push("unknown-provider-binding");
  } else {
    try {
      assertDeploymentBinding(observation.observedBinding, {
        namespace,
        expectedRole: target?.releaseRole ?? null,
        allowLegacyBootstrap: true,
        label: "Observed provider binding",
      });
      if (
        target === null ||
        !sameCanonicalValue(observation.observedBinding, target)
      ) {
        reasons.push("provider-binding-mismatch");
      } else {
        await validateProviderEvidenceForBinding({
          store,
          namespace,
          binding: observation.observedBinding,
          label: "Observed provider binding",
        });
      }
    } catch {
      reasons.push("provider-binding-unverifiable");
    }
  }

  const ready = reasons.length === 0;
  return {
    ...createDecision({
      namespace,
      operationId: pending?.operationId ?? null,
      head: current.head,
      observationSha256,
      status: ready ? "ready" : "blocked",
      action: ready ? "append-state-reconciled" : null,
      reasonCodes: reasons,
      targetBindingId: target?.bindingId ?? null,
      observedDeploymentId,
    }),
    observationReference,
    eventPlan: ready
      ? {
          eventType: "state-reconciled",
          operationId: pending.operationId,
          expectedState: {
            sequence: current.head.sequence,
            eventHash: current.head.eventHash,
          },
          payload: {
            reconciliationKind: "provider-target-assigned/v1",
            observedBinding: target,
            providerObservation: observationReference,
          },
          evidenceRefs: sortAndDedupeReferences(
            [
              observationReference,
              target.providerEvidence,
              ...providerReceiptChainReferences,
            ],
            namespace,
          ),
        }
      : null,
  };
};
