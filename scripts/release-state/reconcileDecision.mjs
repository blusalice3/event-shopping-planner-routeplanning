import { parseJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { reduceReleaseState } from "./releaseStateReducer.mjs";
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
export const PROVIDER_ALIAS_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-alias-observation+json;version=1";
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
const PROVIDER_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-policy+json;version=1";

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

export const resolvePendingProviderAuthority = async (
  { store, current: suppliedCurrent = null },
  { readState = readCurrentReleaseState } = {},
) => {
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function"
  ) {
    throw new Error("Release State store lacks provider authority reads");
  }
  const current = suppliedCurrent ?? (await readState({ store }));
  const namespace = current.records[0]?.event?.namespace;
  const pending = current.snapshot.pendingOperation;
  if (pending === null || !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error("Provider authority requires a replayed pending operation");
  }
  const candidateBindings = [
    ["target", pending.targetBinding],
    ["previous", pending.previousBinding],
    ["emergency", pending.emergencyRecoveryBinding],
  ].filter(([, binding]) => binding !== null);
  for (const [kind, binding] of candidateBindings) {
    assertDeploymentBinding(binding, {
      namespace,
      allowLegacyBootstrap: true,
      label: `Pending ${kind} provider binding`,
    });
    await validateProviderEvidenceForBinding({
      store,
      namespace,
      binding,
      label: `Pending ${kind} provider binding`,
    });
  }
  const policyReference = candidateBindings[0]?.[1]?.providerPolicy;
  if (
    policyReference === undefined ||
    candidateBindings.some(
      ([, binding]) =>
        !sameCanonicalValue(binding.providerPolicy, policyReference),
    )
  ) {
    throw new Error("Pending provider bindings do not share one policy");
  }
  const storedPolicy = await assertEvidenceObjectAvailable({
    store,
    reference: policyReference,
    namespace,
    label: "Pending provider policy",
  });
  if (storedPolicy.mediaType !== PROVIDER_POLICY_MEDIA_TYPE) {
    throw new Error("Pending provider policy media type is invalid");
  }
  const providerPolicy = parseCanonicalJsonBytes(
    storedPolicy.bytes,
    "Pending provider policy",
  );
  assertProviderPolicy(providerPolicy);
  if (
    candidateBindings.some(
      ([, binding]) =>
        binding.providerProjectId !== providerPolicy.expectedProjectId,
    )
  ) {
    throw new Error("Pending provider binding project differs from policy");
  }
  return {
    current,
    namespace,
    pending,
    providerPolicy,
    providerPolicyReference: policyReference,
    candidateBindings: Object.fromEntries(candidateBindings),
  };
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
  freshnessRequired = true,
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
      (freshnessRequired &&
        (nowMilliseconds - providerTimestamp >
          providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
          providerTimestamp - nowMilliseconds >
            providerPolicy.observationPolicy.maxFutureClockSkewSeconds *
              1000)) ||
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
  const mediaType = PROVIDER_ALIAS_OBSERVATION_MEDIA_TYPE;
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

export const validateProviderAliasObservationEvidence = async (
  {
    store,
    observationBytes: suppliedBytes,
    providerPolicy,
    namespace,
    expectedBinding = undefined,
    freshnessRequired = true,
  },
  { now = Date.now } = {},
) => {
  if (!store || typeof store.readEvidence !== "function") {
    throw new Error("Release State store lacks provider evidence reads");
  }
  assertProviderPolicy(providerPolicy);
  const observationBytes = Buffer.isBuffer(suppliedBytes)
    ? suppliedBytes
    : Buffer.from(suppliedBytes ?? "");
  const observation = parseObservation(observationBytes);
  if (
    observation.namespace !== namespace ||
    (store.namespace !== undefined && store.namespace !== namespace)
  ) {
    throw new Error("Provider observation namespace differs from the store");
  }
  const nowMilliseconds = now();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Provider observation clock is invalid");
  }
  const observationSha256 = sha256Bytes(observationBytes);
  const observationReference = {
    uri: `release-state://${namespace}/evidence/${observationSha256}`,
    sha256: observationSha256,
  };
  const storedObservation = await assertEvidenceObjectAvailable({
    store,
    reference: observationReference,
    namespace,
    label: "Provider alias observation",
  });
  if (
    storedObservation.mediaType !== PROVIDER_ALIAS_OBSERVATION_MEDIA_TYPE ||
    !storedObservation.bytes.equals(observationBytes)
  ) {
    throw new Error("Stored provider observation bytes differ");
  }
  const providerReceiptChainReferences = await validateProviderReceiptChain({
    store,
    namespace,
    observation,
    providerPolicy,
    nowMilliseconds,
    freshnessRequired,
  });
  const providerResponseReferences = [];
  for (const reference of providerReceiptChainReferences) {
    const stored = await assertEvidenceObjectAvailable({
      store,
      reference,
      namespace,
      label: "Provider receipt-chain object",
    });
    if (stored.mediaType === PROVIDER_RESPONSE_MEDIA_TYPE) {
      providerResponseReferences.push(reference);
    }
  }
  const expectedDomains = sortedUniqueStrings(
    providerPolicy.ownedProductionDomains,
  );
  const assignments = [...observation.assignments].sort((left, right) =>
    compareUtf8(left.productionDomain, right.productionDomain),
  );
  if (
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(assignments, observation.assignments) ||
    !sameCanonicalValue(
      assignments.map(({ productionDomain }) => productionDomain),
      expectedDomains,
    )
  ) {
    throw new Error(
      "Provider observation is partial, ambiguous, or noncanonical",
    );
  }
  const deploymentIds = sortedUniqueStrings(
    assignments.map(({ assignedDeploymentId }) => assignedDeploymentId),
  );
  if (deploymentIds.length !== 1) {
    throw new Error("Provider observation deployment assignment is ambiguous");
  }
  if (expectedBinding === null) {
    if (observation.observedBinding !== null) {
      throw new Error("Legacy provider observation must not claim a binding");
    }
  } else if (expectedBinding !== undefined) {
    assertDeploymentBinding(expectedBinding, {
      namespace,
      allowLegacyBootstrap: true,
      label: "Expected provider binding",
    });
    if (
      !sameCanonicalValue(observation.observedBinding, expectedBinding) ||
      deploymentIds[0] !== expectedBinding.providerDeploymentId ||
      observation.providerProjectId !== expectedBinding.providerProjectId
    ) {
      throw new Error("Provider observation differs from the expected binding");
    }
    await validateProviderEvidenceForBinding({
      store,
      namespace,
      binding: expectedBinding,
      label: "Expected provider binding",
    });
  }
  return {
    observation,
    observationReference,
    providerReceiptChainReferences,
    providerResponseReferences: sortAndDedupeReferences(
      providerResponseReferences,
      namespace,
    ),
    observedDeploymentId: deploymentIds[0],
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

const releaseEventReference = (namespace, record) => ({
  uri:
    `release-state://${namespace}/events/${record.sequence}/` +
    record.eventHash,
  sha256: record.eventHash,
});

const resolveAcceptedAuthority = ({ current, namespace, binding }) => {
  const references = [];
  if (
    sameCanonicalValue(current.snapshot.acceptedStandard, binding) &&
    current.snapshot.acceptedStandardEvent !== null
  ) {
    references.push(current.snapshot.acceptedStandardEvent);
  }
  for (const entry of current.snapshot.rollbackInventory) {
    if (sameCanonicalValue(entry.binding, binding)) {
      references.push(entry.acceptedEvent);
    }
  }
  const distinct = [
    ...new Map(
      references.map((reference) => [reference.uri, reference]),
    ).values(),
  ];
  if (distinct.length !== 1) {
    throw new Error(
      "Reconcile rollback accepted authority is absent or ambiguous",
    );
  }
  let replayed = null;
  let accepted = null;
  const authorizedBindings = [];
  for (const record of current.records) {
    const previous = replayed;
    replayed = reduceReleaseState(replayed, record.event);
    const reference = releaseEventReference(namespace, record);
    if (sameCanonicalValue(reference, distinct[0])) {
      if (
        accepted !== null ||
        record.event.eventType !== "release-accepted" ||
        !sameCanonicalValue(replayed.acceptedStandardEvent, reference) ||
        replayed.acceptedGate !== record.event.payload.acceptedGate ||
        !sameCanonicalValue(
          replayed.acceptedStandardFloors,
          record.event.payload.acceptedStandardFloors,
        )
      ) {
        throw new Error(
          "Reconcile accepted event does not authorize the observed standard",
        );
      }
      accepted = {
        originAcceptedEvent: reference,
        originAcceptedGate: record.event.payload.acceptedGate,
        originAcceptedStandardFloors: structuredClone(
          record.event.payload.acceptedStandardFloors,
        ),
      };
      authorizedBindings.push(structuredClone(replayed.acceptedStandard));
      continue;
    }
    if (
      accepted !== null &&
      record.event.eventType === "package-redeploy-activated" &&
      record.event.payload.releaseRole === "standard" &&
      sameCanonicalValue(
        record.event.payload.originAcceptedEvent,
        distinct[0],
      ) &&
      authorizedBindings.some((candidate) =>
        sameCanonicalValue(
          candidate,
          previous?.pendingOperation?.originBinding,
        ),
      ) &&
      sameCanonicalValue(
        replayed.acceptedStandard,
        record.event.payload.standardBinding,
      ) &&
      sameCanonicalValue(replayed.acceptedStandardEvent, distinct[0]) &&
      replayed.acceptedGate === accepted.originAcceptedGate &&
      sameCanonicalValue(
        replayed.acceptedStandardFloors,
        accepted.originAcceptedStandardFloors,
      )
    ) {
      authorizedBindings.push(
        structuredClone(record.event.payload.standardBinding),
      );
    }
  }
  if (
    accepted === null ||
    !authorizedBindings.some((candidate) =>
      sameCanonicalValue(candidate, binding),
    )
  ) {
    throw new Error(
      "Reconcile accepted event does not authorize the observed standard",
    );
  }
  return accepted;
};

const containmentTerminalPlan = ({
  binding,
  current,
  nowMilliseconds,
  pending,
}) => {
  const legacy = binding.publicIdentityKind === "legacy-bootstrap-v1";
  return {
    eventType: legacy
      ? "temporary-containment-activated"
      : "containment-activated",
    targetBinding: binding,
    payload: {
      binding,
      activatedAt: new Date(nowMilliseconds).toISOString(),
      recoveryDeadline: new Date(
        nowMilliseconds + (legacy ? 6 : 24) * 60 * 60 * 1000,
      ).toISOString(),
      targetStandard: current.snapshot.acceptedStandard,
    },
    approvalRefs: pending.approvalRefs,
  };
};

const buildReconciliationTerminalPlan = ({
  current,
  namespace,
  observedBinding,
  observedKind,
  nowMilliseconds,
  pending,
}) => {
  if (observedKind === "target") {
    if (pending.kind === "promote-standard") return null;
    if (pending.kind === "rollback-standard") {
      return {
        eventType: "rollback-activated",
        targetBinding: pending.targetBinding,
        payload: {
          binding: pending.targetBinding,
          companionBinding: pending.companionBinding,
          ...resolveAcceptedAuthority({
            current,
            namespace,
            binding: pending.targetBinding,
          }),
        },
        approvalRefs: pending.approvalRefs,
      };
    }
    if (pending.kind === "activate-containment") {
      return containmentTerminalPlan({
        binding: pending.targetBinding,
        current,
        nowMilliseconds,
        pending,
      });
    }
    if (pending.kind === "redeploy-containment") {
      const terminal = containmentTerminalPlan({
        binding: pending.targetBinding,
        current,
        nowMilliseconds,
        pending,
      });
      return {
        ...terminal,
        eventType: "package-redeploy-activated",
        payload: { ...terminal.payload, releaseRole: "containment" },
      };
    }
    if (pending.kind === "redeploy-standard") {
      const accepted = resolveAcceptedAuthority({
        current,
        namespace,
        binding: pending.originBinding,
      });
      return {
        eventType: "package-redeploy-activated",
        targetBinding: pending.targetBinding,
        payload: {
          releaseRole: "standard",
          standardBinding: pending.targetBinding,
          companionBinding: pending.companionBinding,
          ...accepted,
        },
        approvalRefs: pending.approvalRefs,
      };
    }
    throw new Error("Reconcile target operation kind is unsupported");
  }
  if (
    observedKind === "previous" &&
    observedBinding.releaseRole === "standard"
  ) {
    return {
      eventType: "operation-aborted",
      targetBinding: observedBinding,
      payload: {},
      approvalRefs: [],
    };
  }
  if (observedBinding.releaseRole !== "containment") {
    throw new Error("Reconcile recovery binding role is unsupported");
  }
  return containmentTerminalPlan({
    binding: observedBinding,
    current,
    nowMilliseconds,
    pending,
  });
};

export const decideProviderReconciliation = async (
  options,
  { readState = readCurrentReleaseState, now = Date.now } = {},
) => {
  if (
    Object.hasOwn(options, "snapshot") ||
    Object.hasOwn(options, "providerPolicy")
  ) {
    throw new Error(
      "Caller-supplied snapshot or provider policy is forbidden; authority is replayed from Release State",
    );
  }
  const { store, observationBytes: suppliedBytes } = options;
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function"
  ) {
    throw new Error("Release State store lacks reconcile read operations");
  }
  const observationBytes = Buffer.isBuffer(suppliedBytes)
    ? suppliedBytes
    : Buffer.from(suppliedBytes ?? "");
  const observation = parseObservation(observationBytes);
  const nowMilliseconds = now();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Provider reconciliation clock is invalid");
  }
  const current = await readState({ store });
  const authority = await resolvePendingProviderAuthority(
    { store, current },
    { readState },
  );
  const { namespace, pending, providerPolicy } = authority;
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
    if (
      storedObservation.mediaType !== PROVIDER_ALIAS_OBSERVATION_MEDIA_TYPE ||
      !storedObservation.bytes.equals(observationBytes)
    ) {
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

  if (
    observation.providerProjectId !== providerPolicy.expectedProjectId ||
    observation.providerProjectId !== pending.targetBinding.providerProjectId
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
  const target = pending.targetBinding;
  const bindingCandidates = [
    ["target", target],
    ["previous", pending.previousBinding],
    ["emergency", pending.emergencyRecoveryBinding],
  ].filter(([, binding]) => binding !== null);
  const deploymentMatches =
    observedDeploymentId === null
      ? []
      : bindingCandidates.filter(
          ([, binding]) =>
            binding.providerDeploymentId === observedDeploymentId,
        );
  if (deploymentMatches.length === 0 && observedDeploymentId !== null) {
    reasons.push("unknown-provider-deployment");
  }
  const observedCandidate = deploymentMatches[0] ?? null;
  if (
    deploymentMatches.some(
      ([, binding]) =>
        !sameCanonicalValue(binding, observedCandidate?.[1] ?? null),
    )
  ) {
    reasons.push("ambiguous-known-provider-deployment");
  }

  if (observation.observedBinding === null) {
    reasons.push("unknown-provider-binding");
  } else {
    try {
      assertDeploymentBinding(observation.observedBinding, {
        namespace,
        allowLegacyBootstrap: true,
        label: "Observed provider binding",
      });
      if (
        observedCandidate === null ||
        !sameCanonicalValue(observation.observedBinding, observedCandidate[1])
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

  const observedKind = observedCandidate?.[0] ?? null;
  const observedBinding = observedCandidate?.[1] ?? null;
  if (
    observedKind === "previous" &&
    pending.originBinding !== null &&
    sameCanonicalValue(observedBinding, pending.originBinding)
  ) {
    reasons.push("provider-previous-is-redeploy-origin");
  }

  const reconciliationKinds = {
    target: "provider-target-assigned/v1",
    previous: "provider-previous-assigned/v1",
    emergency: "provider-emergency-assigned/v1",
  };

  let terminalPlan = null;
  if (reasons.length === 0) {
    try {
      terminalPlan = buildReconciliationTerminalPlan({
        current,
        namespace,
        observedBinding,
        observedKind,
        nowMilliseconds,
        pending,
      });
    } catch {
      reasons.push("recovery-terminal-authority-unresolved");
    }
  }
  const ready = reasons.length === 0;
  return {
    ...createDecision({
      namespace,
      operationId: pending.operationId,
      head: current.head,
      observationSha256,
      status: ready ? "ready" : "blocked",
      action: ready ? "append-state-reconciled" : null,
      reasonCodes: reasons,
      targetBindingId: target.bindingId,
      observedDeploymentId,
    }),
    observationReference,
    terminalPlan: ready ? terminalPlan : null,
    eventPlan: ready
      ? {
          eventType: "state-reconciled",
          operationId: pending.operationId,
          expectedState: {
            sequence: current.head.sequence,
            eventHash: current.head.eventHash,
          },
          payload: {
            reconciliationKind: reconciliationKinds[observedKind],
            observedBinding,
            providerObservation: observationReference,
          },
          evidenceRefs: sortAndDedupeReferences(
            [
              observationReference,
              observedBinding.providerEvidence,
              ...providerReceiptChainReferences,
            ],
            namespace,
          ),
        }
      : null,
  };
};
