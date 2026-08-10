import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { assertArtifactManifest } from "../lib/artifact-contract.mjs";
import {
  RELEASE_DIMENSION_KEYS,
  verifyPhaseSequence,
} from "../lib/release-policy.mjs";
import { assertRequiredApprovalSet } from "./approvalResolver.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  deriveLifecycleAppendId,
  deriveRollbackInventory,
} from "./lifecycleExecution.mjs";
import {
  assertBindingPolicyEligible,
  assertPolicyCompatibilityEntries,
} from "./policyCompatibility.mjs";
import { validateP8FloorActivationClosure } from "./p8FloorActivationClosure.mjs";
import { NORMAL_POLICY_ACTIVATION_GATES } from "./phaseGates.mjs";
import { collectAndStorePolicyActivationApprovals } from "./promotionPreparation.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertArtifactArchiveAvailable,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  collectBindingEvidenceReferences,
  compareUtf8,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
} from "./releaseWorkflowValidation.mjs";

export const POLICY_ACTIVATION_GATE = "P8-CLEAN";
export const POLICY_ACTIVATION_SUBJECT_KIND = "policy-activation-subject/v2";
export const POLICY_ACTIVATION_CLOSURE_KIND = "policy-activation-closure/v1";

const POLICY_ACTIVATION_ROLES = [
  "releaseOwner",
  "dataSafetyReviewer",
  "operationsReviewer",
];
const RECEIPT_FIELDS = Object.freeze({
  nonProductionQa: "policy-non-production-qa/v1",
  schemaValidation: "policy-schema-validation/v1",
  monotonicity: "policy-monotonicity-validation/v1",
  predecessorCompatibility: "policy-predecessor-compatibility/v1",
  rollbackContainmentDrill: "policy-rollback-containment-drill/v1",
});
const NORMAL_POLICY_GATES = new Set(NORMAL_POLICY_ACTIVATION_GATES);
const SUBJECT_KEYS = [
  "activationGate",
  "activePolicyCompatibility",
  "activeReleasePolicy",
  "behaviorDimensionChange",
  "closureBundle",
  "closureEvidenceRefs",
  "executorSourceSha",
  "expectedState",
  "minimumSafetyFloorChange",
  "minimumSafetyFloors",
  "namespace",
  "operationId",
  "previousReleasePolicy",
  "proposedReleasePolicy",
  "rollbackInventory",
  "schemaVersion",
  "subjectKind",
  "targetSourceSha",
];
const PAYLOAD_KEYS = [
  "activationGate",
  "activePolicyCompatibility",
  "activeReleasePolicy",
  "behaviorDimensionChange",
  "closureBundle",
  "closureEvidenceRefs",
  "minimumSafetyFloorChange",
  "minimumSafetyFloors",
  "previousReleasePolicy",
  "proposedReleasePolicy",
  "rollbackInventory",
];
const FORBIDDEN_CALLER_AUTHORITY_FIELDS = [
  "activationGate",
  "activePolicyCompatibility",
  "activeReleasePolicy",
  "approvalRefs",
  "behaviorDimensionChange",
  "expectedState",
  "minimumSafetyFloorChange",
  "minimumSafetyFloors",
  "previousReleasePolicy",
  "rollbackInventory",
  "snapshot",
  "targetSourceSha",
];
const POLICY_TRANSITION_MUTABLE_KEYS = new Set([
  "acceptedStandardFloors",
  "activationBlockers",
  "activationStatus",
  "compatiblePredecessorPolicies",
]);

const assertNoCallerAuthority = (options) => {
  if (options === null || typeof options !== "object") {
    throw new Error("Policy activation options are invalid");
  }
  for (const field of FORBIDDEN_CALLER_AUTHORITY_FIELDS) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `Caller-supplied ${field} is forbidden; policy activation authority is derived internally`,
      );
    }
  }
};

const assertStore = (store) => {
  if (
    !store ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function" ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    typeof store.compareAndAppend !== "function"
  ) {
    throw new Error(
      "Policy activation requires Release State replay, evidence, and CAS operations",
    );
  }
};

const evidenceReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const eventReference = (namespace, record) => ({
  uri:
    `release-state://${namespace}/events/${record.sequence}/` +
    record.eventHash,
  sha256: record.eventHash,
});

const assertImmutableEvidenceReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    !SHA256_PATTERN.test(reference.sha256) ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} is not an immutable evidence reference`);
  }
  return reference;
};

const readCanonicalEvidence = async ({
  store,
  namespace,
  reference,
  label,
}) => {
  assertImmutableEvidenceReference(reference, namespace, label);
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  return parseCanonicalJsonBytes(stored.bytes, label);
};

const standardFloorsFromDimensions = (dimensions) =>
  Object.fromEntries(
    RELEASE_DIMENSION_KEYS.filter((key) => key !== "releaseRole").map((key) => [
      key,
      dimensions[key],
    ]),
  );

const policyStaticProjection = (policy) =>
  Object.fromEntries(
    Object.entries(policy).filter(
      ([key]) => !POLICY_TRANSITION_MUTABLE_KEYS.has(key),
    ),
  );

const assertBlockerSet = (blockers, { empty, label }) => {
  if (
    !Array.isArray(blockers) ||
    blockers.some(
      (blocker) => typeof blocker !== "string" || blocker.length === 0,
    ) ||
    new Set(blockers).size !== blockers.length ||
    !sameCanonicalValue(blockers, [...blockers].sort(compareUtf8)) ||
    (empty ? blockers.length !== 0 : blockers.length === 0)
  ) {
    throw new Error(`${label} activation blockers are invalid`);
  }
};

const phaseTransitions = (policy) => {
  let current = standardFloorsFromDimensions(policy.initialStandard);
  return policy.phaseSequence.map((phase) => {
    const before = current;
    const after =
      phase.change === null ? before : { ...before, ...phase.change };
    current = after;
    return { phase, before, after };
  });
};

const assertAcceptedGateAuthorizesActivation = ({
  policy,
  acceptedGate,
  activationGate,
}) => {
  const gates = policy.phaseSequence.map((phase) => phase.gate);
  const acceptedIndex = gates.indexOf(acceptedGate);
  if (
    acceptedIndex < 0 ||
    (activationGate === POLICY_ACTIVATION_GATE
      ? acceptedGate !== POLICY_ACTIVATION_GATE
      : gates[acceptedIndex + 1] !== activationGate)
  ) {
    throw new Error(
      "Policy activation is not the exact successor of the accepted gate",
    );
  }
};

export const deriveP8MinimumSafetyFloorTransition = ({
  releasePolicy,
  currentFloors,
}) => {
  verifyPhaseSequence(releasePolicy);
  const matches = releasePolicy.phaseSequence.filter(
    (phase) => phase?.gate === POLICY_ACTIVATION_GATE,
  );
  if (matches.length !== 1) {
    throw new Error("Release policy must define exactly one P8-CLEAN phase");
  }
  const [phase] = matches;
  assertExactKeys(
    phase,
    ["change", "gate", "minimumSafetyFloorChange"],
    "P8-CLEAN release policy phase",
  );
  if (
    phase.change !== null ||
    !sameCanonicalValue(phase.minimumSafetyFloorChange, {
      styleSrcAttr: "none",
    })
  ) {
    throw new Error("P8-CLEAN must activate only styleSrcAttr none");
  }
  const predecessorFloors = Object.fromEntries(
    Object.entries(releasePolicy.minimumSafetyFloors).filter(
      ([key]) => !Object.hasOwn(phase.minimumSafetyFloorChange, key),
    ),
  );
  const nextFloors = { ...currentFloors, ...phase.minimumSafetyFloorChange };
  if (
    !sameCanonicalValue(currentFloors, predecessorFloors) ||
    !sameCanonicalValue(nextFloors, releasePolicy.minimumSafetyFloors)
  ) {
    throw new Error(
      "Current minimum safety floors are not the exact P8 predecessor",
    );
  }
  return {
    activationGate: POLICY_ACTIVATION_GATE,
    behaviorDimensionChange: null,
    minimumSafetyFloorChange: structuredClone(phase.minimumSafetyFloorChange),
    minimumSafetyFloors: structuredClone(nextFloors),
  };
};

export const derivePolicyActivationTransition = ({
  previousPolicy,
  proposedPolicy,
  activePolicy,
  acceptedGate,
  acceptedStandardFloors,
  currentFloors,
  previousReleasePolicy,
  proposedReleasePolicy,
  activeReleasePolicy,
}) => {
  verifyPhaseSequence(previousPolicy);
  verifyPhaseSequence(proposedPolicy);
  verifyPhaseSequence(activePolicy);
  if (
    previousPolicy.activationStatus !== "active" ||
    !Array.isArray(previousPolicy.activationBlockers) ||
    previousPolicy.activationBlockers.length !== 0 ||
    !sameCanonicalValue(
      previousPolicy.acceptedStandardFloors,
      acceptedStandardFloors,
    ) ||
    !sameCanonicalValue(
      policyStaticProjection(previousPolicy),
      policyStaticProjection(proposedPolicy),
    ) ||
    !sameCanonicalValue(
      policyStaticProjection(proposedPolicy),
      policyStaticProjection(activePolicy),
    )
  ) {
    throw new Error(
      "Policy predecessor or static policy projection is invalid",
    );
  }

  const p8Only = sameCanonicalValue(
    previousPolicy.acceptedStandardFloors,
    proposedPolicy.acceptedStandardFloors,
  );
  if (p8Only) {
    if (
      !sameCanonicalValue(previousReleasePolicy, proposedReleasePolicy) ||
      !sameCanonicalValue(previousReleasePolicy, activeReleasePolicy) ||
      !sameCanonicalValue(previousPolicy, proposedPolicy) ||
      !sameCanonicalValue(previousPolicy, activePolicy)
    ) {
      throw new Error(
        "P8-CLEAN floor-only activation must preserve policy bytes",
      );
    }
    const transition = deriveP8MinimumSafetyFloorTransition({
      releasePolicy: activePolicy,
      currentFloors,
    });
    assertAcceptedGateAuthorizesActivation({
      policy: activePolicy,
      acceptedGate,
      activationGate: transition.activationGate,
    });
    return transition;
  }

  if (
    sameCanonicalValue(previousReleasePolicy, proposedReleasePolicy) ||
    sameCanonicalValue(proposedReleasePolicy, activeReleasePolicy) ||
    sameCanonicalValue(previousReleasePolicy, activeReleasePolicy) ||
    proposedPolicy.activationStatus !== "proposed" ||
    activePolicy.activationStatus !== "active"
  ) {
    throw new Error(
      "Policy activation references or status transition is invalid",
    );
  }
  assertBlockerSet(proposedPolicy.activationBlockers, {
    empty: false,
    label: "Proposed policy",
  });
  assertBlockerSet(activePolicy.activationBlockers, {
    empty: true,
    label: "Active policy",
  });
  const proposedWithoutStatus = {
    ...proposedPolicy,
    activationStatus: activePolicy.activationStatus,
    activationBlockers: activePolicy.activationBlockers,
  };
  if (!sameCanonicalValue(proposedWithoutStatus, activePolicy)) {
    throw new Error(
      "Active policy differs from proposed bytes beyond status and blocker closure",
    );
  }
  const matches = phaseTransitions(proposedPolicy).filter(
    ({ phase, before, after }) =>
      phase.change !== null &&
      sameCanonicalValue(before, previousPolicy.acceptedStandardFloors) &&
      sameCanonicalValue(after, proposedPolicy.acceptedStandardFloors),
  );
  if (matches.length !== 1 || !NORMAL_POLICY_GATES.has(matches[0].phase.gate)) {
    throw new Error(
      "Policy activation does not advance exactly one phase gate",
    );
  }
  const [{ phase }] = matches;
  assertAcceptedGateAuthorizesActivation({
    policy: proposedPolicy,
    acceptedGate,
    activationGate: phase.gate,
  });
  const changedDimensions = Object.entries(phase.change);
  if (changedDimensions.length !== 1) {
    throw new Error(
      "Policy activation phase must change one behavior dimension",
    );
  }
  const [[dimension, to]] = changedDimensions;
  return {
    activationGate: phase.gate,
    behaviorDimensionChange: {
      dimension,
      from: previousPolicy.acceptedStandardFloors[dimension],
      to,
    },
    minimumSafetyFloorChange: null,
    minimumSafetyFloors: structuredClone(currentFloors),
  };
};

const validateReceiptResult = async ({
  store,
  namespace,
  receipt,
  field,
  transition,
  blockers,
  activePolicyCompatibility,
}) => {
  if (field === "nonProductionQa") {
    assertExactKeys(
      receipt.result,
      [
        "companionArchive",
        "companionDeploymentObservation",
        "companionManifest",
        "nonPromotable",
        "qaPackage",
        "sourceSha",
        "standardArchive",
        "standardDeploymentObservation",
        "standardManifest",
        "toolchainPolicyHash",
      ],
      "Non-production QA receipt result",
    );
    if (
      receipt.result.nonPromotable !== true ||
      !SOURCE_SHA_PATTERN.test(receipt.result.sourceSha) ||
      !SHA256_PATTERN.test(receipt.result.toolchainPolicyHash)
    ) {
      throw new Error("Non-production QA receipt identity is invalid");
    }
    for (const [label, reference] of [
      ["QA package", receipt.result.qaPackage],
      ["QA standard manifest", receipt.result.standardManifest],
      ["QA containment manifest", receipt.result.companionManifest],
      ["QA standard archive", receipt.result.standardArchive],
      ["QA containment archive", receipt.result.companionArchive],
      [
        "QA standard deployment observation",
        receipt.result.standardDeploymentObservation,
      ],
      [
        "QA containment deployment observation",
        receipt.result.companionDeploymentObservation,
      ],
    ]) {
      await assertEvidenceObjectAvailable({
        store,
        namespace,
        reference,
        label,
      });
    }
  } else if (field === "schemaValidation") {
    assertExactKeys(
      receipt.result,
      ["policySchema", "valid"],
      "Policy schema receipt result",
    );
    if (
      receipt.result.policySchema !== "release-policy/v1" ||
      receipt.result.valid !== true
    ) {
      throw new Error("Policy schema receipt did not pass");
    }
  } else if (field === "monotonicity") {
    assertExactKeys(
      receipt.result,
      [
        "behaviorDimensionChange",
        "minimumSafetyFloorChange",
        "minimumSafetyFloors",
      ],
      "Policy monotonicity receipt result",
    );
    if (
      !sameCanonicalValue(
        receipt.result.behaviorDimensionChange,
        transition.behaviorDimensionChange,
      ) ||
      !sameCanonicalValue(
        receipt.result.minimumSafetyFloorChange,
        transition.minimumSafetyFloorChange,
      ) ||
      !sameCanonicalValue(
        receipt.result.minimumSafetyFloors,
        transition.minimumSafetyFloors,
      )
    ) {
      throw new Error(
        "Policy monotonicity receipt differs from the transition",
      );
    }
  } else if (field === "predecessorCompatibility") {
    assertExactKeys(
      receipt.result,
      ["compatibility", "compatible", "closedBlockers"],
      "Policy predecessor receipt result",
    );
    if (
      receipt.result.compatible !== true ||
      !sameCanonicalValue(receipt.result.closedBlockers, blockers) ||
      !sameCanonicalValue(
        receipt.result.compatibility,
        activePolicyCompatibility,
      )
    ) {
      throw new Error("Policy predecessor compatibility receipt is invalid");
    }
  } else {
    assertExactKeys(
      receipt.result,
      [
        "containmentCommandReceipt",
        "containmentDrill",
        "containmentProviderObservation",
        "rollbackCommandReceipt",
        "rollbackDrill",
        "rollbackProviderObservation",
      ],
      "Policy recovery drill receipt result",
    );
    for (const [label, reference] of Object.entries(receipt.result)) {
      await assertEvidenceObjectAvailable({
        store,
        namespace,
        reference,
        label: `Policy recovery drill ${label}`,
      });
    }
  }
};

const validateClosureBundleDetails = async ({
  store,
  namespace,
  closureBundleReference,
  previousReleasePolicy,
  proposedReleasePolicy,
  activeReleasePolicy,
  transition,
  blockers,
  operationId,
  activePolicyCompatibility,
}) => {
  const bundle = await readCanonicalEvidence({
    store,
    namespace,
    reference: closureBundleReference,
    label: "Policy activation closure bundle",
  });
  assertExactKeys(
    bundle,
    [
      "activationGate",
      "activeReleasePolicy",
      "bundleKind",
      "namespace",
      "operationId",
      "previousReleasePolicy",
      "proposedReleasePolicy",
      "receipts",
      "schemaVersion",
    ],
    "Policy activation closure bundle",
  );
  assertExactKeys(
    bundle.receipts,
    Object.keys(RECEIPT_FIELDS),
    "Policy activation closure receipts",
  );
  if (
    bundle.schemaVersion !== 1 ||
    bundle.bundleKind !== POLICY_ACTIVATION_CLOSURE_KIND ||
    bundle.namespace !== namespace ||
    bundle.operationId !== operationId ||
    bundle.activationGate !== transition.activationGate ||
    !sameCanonicalValue(bundle.previousReleasePolicy, previousReleasePolicy) ||
    !sameCanonicalValue(bundle.proposedReleasePolicy, proposedReleasePolicy) ||
    !sameCanonicalValue(bundle.activeReleasePolicy, activeReleasePolicy)
  ) {
    throw new Error("Policy activation closure bundle identity is invalid");
  }
  const references = [];
  let targetSourceSha = null;
  for (const [field, receiptKind] of Object.entries(RECEIPT_FIELDS)) {
    const reference = assertImmutableEvidenceReference(
      bundle.receipts[field],
      namespace,
      `Policy closure receipt ${field}`,
    );
    const receipt = await readCanonicalEvidence({
      store,
      namespace,
      reference,
      label: `Policy closure receipt ${field}`,
    });
    assertExactKeys(
      receipt,
      [
        "activationGate",
        "activeReleasePolicy",
        "namespace",
        "operationId",
        "previousReleasePolicy",
        "proposedReleasePolicy",
        "receiptKind",
        "result",
        "schemaVersion",
        "status",
      ],
      `Policy closure receipt ${field}`,
    );
    if (
      receipt.schemaVersion !== 1 ||
      receipt.receiptKind !== receiptKind ||
      receipt.namespace !== namespace ||
      receipt.operationId !== operationId ||
      receipt.status !== "passed" ||
      receipt.activationGate !== transition.activationGate ||
      !sameCanonicalValue(
        receipt.previousReleasePolicy,
        previousReleasePolicy,
      ) ||
      !sameCanonicalValue(
        receipt.proposedReleasePolicy,
        proposedReleasePolicy,
      ) ||
      !sameCanonicalValue(receipt.activeReleasePolicy, activeReleasePolicy)
    ) {
      throw new Error(`Policy closure receipt ${field} identity is invalid`);
    }
    await validateReceiptResult({
      store,
      namespace,
      receipt,
      field,
      transition,
      blockers,
      activePolicyCompatibility,
    });
    if (field === "nonProductionQa") {
      targetSourceSha = receipt.result.sourceSha;
    }
    references.push(reference);
  }
  if (!SOURCE_SHA_PATTERN.test(targetSourceSha)) {
    throw new Error("Policy activation QA target source is invalid");
  }
  return {
    references: sortAndDedupeReferences(references, namespace),
    targetSourceSha,
  };
};

export const validatePolicyActivationClosureBundle = async (options) =>
  (await validateClosureBundleDetails(options)).references;

const assertCurrentBindingsRemainEligible = ({ snapshot, nextSnapshot }) => {
  for (const [label, binding] of [
    ["Active production", snapshot.activeProduction],
    ["Accepted standard", snapshot.acceptedStandard],
    ["Containment companion", snapshot.containmentCompanion],
    ["Bootstrap recovery", snapshot.bootstrapRecovery],
  ]) {
    if (binding === null) continue;
    assertBindingPolicyEligible({
      snapshot: nextSnapshot,
      binding,
      action: binding.releaseRole === "standard" ? "rollback" : "containment",
      label,
    });
  }
};

export const derivePolicyActivationSubject = async (
  {
    store,
    namespace,
    operationId,
    executorSourceSha,
    proposedPolicyReference,
    activePolicyReference,
    closureBundleReference,
    current,
    nowMilliseconds,
  },
  {
    validateP8ClosureImpl = validateP8FloorActivationClosure,
    validateNormalClosureImpl = validateClosureBundleDetails,
    deriveRollbackInventoryImpl = deriveRollbackInventory,
  } = {},
) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !SOURCE_SHA_PATTERN.test(executorSourceSha) ||
    store.namespace !== namespace ||
    current.records[0]?.event?.namespace !== namespace
  ) {
    throw new Error(
      "Policy activation namespace, operation, or executor is invalid",
    );
  }
  const snapshot = current.snapshot;
  if (
    snapshot.pendingOperation !== null ||
    snapshot.pendingAcceptance !== null ||
    snapshot.acceptedStandard === null ||
    !sameCanonicalValue(snapshot.activeProduction, snapshot.acceptedStandard)
  ) {
    throw new Error(
      "Policy activation requires an idle active accepted standard",
    );
  }
  const previousReleasePolicy = snapshot.activeReleasePolicy;
  const [previousPolicy, proposedPolicy, activePolicy] = await Promise.all([
    readCanonicalEvidence({
      store,
      namespace,
      reference: previousReleasePolicy,
      label: "Previous active release policy",
    }),
    readCanonicalEvidence({
      store,
      namespace,
      reference: proposedPolicyReference,
      label: "Proposed release policy",
    }),
    readCanonicalEvidence({
      store,
      namespace,
      reference: activePolicyReference,
      label: "Target active release policy",
    }),
  ]);
  const transition = derivePolicyActivationTransition({
    previousPolicy,
    proposedPolicy,
    activePolicy,
    acceptedGate: snapshot.acceptedGate,
    acceptedStandardFloors: snapshot.acceptedStandardFloors,
    currentFloors: snapshot.minimumSafetyFloors,
    previousReleasePolicy,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
  });
  const declaredPolicyCompatibility = structuredClone(
    activePolicy.compatiblePredecessorPolicies,
  );
  let activePolicyCompatibility;
  if (transition.activationGate === POLICY_ACTIVATION_GATE) {
    if (
      !sameCanonicalValue(
        snapshot.activePolicyCompatibility,
        declaredPolicyCompatibility,
      )
    ) {
      throw new Error(
        "P8 live predecessor compatibility differs from the active policy",
      );
    }
    assertPolicyCompatibilityEntries(declaredPolicyCompatibility, {
      namespace,
      minimumSafetyFloors: snapshot.minimumSafetyFloors,
      currentDbCompatibility: snapshot.currentDbCompatibility,
    });
    activePolicyCompatibility = [];
  } else {
    activePolicyCompatibility = declaredPolicyCompatibility;
    assertPolicyCompatibilityEntries(activePolicyCompatibility, {
      namespace,
      minimumSafetyFloors: transition.minimumSafetyFloors,
      currentDbCompatibility: snapshot.currentDbCompatibility,
      nowMilliseconds,
    });
  }
  const closureValidation =
    transition.activationGate === POLICY_ACTIVATION_GATE
      ? await validateP8ClosureImpl({
          store,
          namespace,
          operationId,
          executorSourceSha,
          current,
          releasePolicy: activePolicy,
          releasePolicyReference: activePolicyReference,
          transition,
          closureBundleReference,
          nowMilliseconds,
        })
      : await validateNormalClosureImpl({
          store,
          namespace,
          closureBundleReference,
          previousReleasePolicy,
          proposedReleasePolicy: proposedPolicyReference,
          activeReleasePolicy: activePolicyReference,
          transition,
          blockers: proposedPolicy.activationBlockers,
          operationId,
          activePolicyCompatibility,
        });
  const closureEvidenceRefs = closureValidation.references;
  await assertArtifactArchiveAvailable({
    store,
    namespace,
    binding: snapshot.acceptedStandard,
    label: "Policy activation accepted standard",
  });
  const manifest = await readCanonicalEvidence({
    store,
    namespace,
    reference: snapshot.acceptedStandard.artifactManifest,
    label: "Policy activation accepted artifact manifest",
  });
  assertArtifactManifest(manifest, previousPolicy);
  if (
    !sameCanonicalValue(
      standardFloorsFromDimensions(manifest.dimensions),
      snapshot.acceptedStandardFloors,
    )
  ) {
    throw new Error("Accepted standard manifest differs from accepted floors");
  }
  const nextSnapshot = {
    ...snapshot,
    activeReleasePolicy: activePolicyReference,
    activePolicyCompatibility,
    minimumSafetyFloors: transition.minimumSafetyFloors,
  };
  assertCurrentBindingsRemainEligible({ snapshot, nextSnapshot });
  const rollbackInventory = await deriveRollbackInventoryImpl({
    store,
    current: { ...current, snapshot: nextSnapshot },
    releasePolicy: activePolicy,
    minimumAcceptedGate: snapshot.acceptedGate,
    minimumAcceptedFloors: snapshot.acceptedStandardFloors,
  });
  if (
    transition.activationGate === POLICY_ACTIVATION_GATE &&
    (!sameCanonicalValue(
      activePolicyCompatibility,
      closureValidation.activePolicyCompatibility,
    ) ||
      !sameCanonicalValue(
        rollbackInventory,
        closureValidation.rollbackInventory,
      ))
  ) {
    throw new Error(
      "P8 floor closure eligibility differs from live Release State",
    );
  }
  return {
    schemaVersion: 1,
    subjectKind: POLICY_ACTIVATION_SUBJECT_KIND,
    namespace,
    operationId,
    executorSourceSha,
    targetSourceSha: closureValidation.targetSourceSha,
    expectedState: structuredClone(current.head),
    activationGate: transition.activationGate,
    previousReleasePolicy: structuredClone(previousReleasePolicy),
    proposedReleasePolicy: structuredClone(proposedPolicyReference),
    activeReleasePolicy: structuredClone(activePolicyReference),
    behaviorDimensionChange: transition.behaviorDimensionChange,
    minimumSafetyFloorChange: transition.minimumSafetyFloorChange,
    minimumSafetyFloors: transition.minimumSafetyFloors,
    activePolicyCompatibility,
    closureBundle: structuredClone(closureBundleReference),
    closureEvidenceRefs,
    rollbackInventory,
  };
};

export const buildAuthoritativePolicyActivationSubject = async (
  options,
  {
    readState = readCurrentReleaseState,
    deriveSubjectImpl = derivePolicyActivationSubject,
    nowMilliseconds = Date.now(),
  } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    proposedPolicySha256,
    activePolicySha256,
    closureBundleSha256,
  } = options;
  assertStore(store);
  if (
    !SHA256_PATTERN.test(proposedPolicySha256) ||
    !SHA256_PATTERN.test(activePolicySha256) ||
    !SHA256_PATTERN.test(closureBundleSha256)
  ) {
    throw new Error("Policy activation evidence SHA-256 input is invalid");
  }
  const current = await readState({ store });
  const subject = await deriveSubjectImpl({
    store,
    namespace,
    operationId,
    executorSourceSha,
    proposedPolicyReference: evidenceReference(namespace, proposedPolicySha256),
    activePolicyReference: evidenceReference(namespace, activePolicySha256),
    closureBundleReference: evidenceReference(namespace, closureBundleSha256),
    current,
    nowMilliseconds,
  });
  const subjectBytes = canonicalJsonBytes(subject);
  return {
    subject,
    subjectBytes,
    subjectSha256: sha256Bytes(subjectBytes),
    expectedState: subject.expectedState,
  };
};

const payloadFromSubject = (subject) =>
  Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, subject[key]]));

const putSubject = async ({
  store,
  namespace,
  subjectBytes,
  subjectSha256,
}) => {
  const receipt = await store.putEvidence({
    bytes: subjectBytes,
    mediaType:
      "application/vnd.event-shopping-planner.policy-activation-subject+json;version=2",
  });
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${subjectSha256}` ||
    receipt.sha256 !== subjectSha256 ||
    receipt.byteLength !== subjectBytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(
      "Policy activation subject immutable-store receipt is invalid",
    );
  }
  const stored = await store.readEvidence({ sha256: subjectSha256 });
  if (!stored?.bytes?.equals(subjectBytes)) {
    throw new Error("Stored policy activation subject differs");
  }
  return { uri: receipt.uri, sha256: subjectSha256 };
};

const existingActivation = async ({
  store,
  current,
  subject,
  subjectBytes,
  subjectReference,
  appendId,
}) => {
  const matches = current.records.filter(
    (record) => record.event.appendId === appendId,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error("Policy activation idempotency key is ambiguous");
  }
  const [record] = matches;
  if (
    record.event.eventType !== "policy-activated" ||
    record.event.operationId !== subject.operationId ||
    record.event.sequence !== subject.expectedState.sequence + 1 ||
    record.event.previousEventHash !== subject.expectedState.eventHash ||
    !sameCanonicalValue(record.event.payload, payloadFromSubject(subject)) ||
    !record.event.evidenceRefs.some((reference) =>
      sameCanonicalValue(reference, subjectReference),
    )
  ) {
    throw new Error("Existing policy activation differs from retry input");
  }
  assertRequiredApprovalSet(record.event.approvalRefs, POLICY_ACTIVATION_ROLES);
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace: subject.namespace,
    reference: subjectReference,
    label: "Policy activation subject",
  });
  if (!stored.bytes.equals(subjectBytes)) {
    throw new Error("Stored policy activation subject differs on retry");
  }
  return {
    schemaVersion: 1,
    resultKind: "policy-activated/v2",
    operationId: subject.operationId,
    executorSourceSha: subject.executorSourceSha,
    targetSourceSha: subject.targetSourceSha,
    subject: subjectReference,
    approvals: structuredClone(record.event.approvalRefs),
    event: eventReference(subject.namespace, record),
    replayed: true,
    head: current.head,
  };
};

export const activateReleasePolicy = async (
  options,
  {
    readState = readCurrentReleaseState,
    collectApprovals = collectAndStorePolicyActivationApprovals,
    deriveSubjectImpl = derivePolicyActivationSubject,
    now = Date.now,
  } = {},
) => {
  assertNoCallerAuthority(options);
  const {
    store,
    subjectBytes: suppliedSubjectBytes,
    expectedSubjectSha256,
    expectedExecutorSourceSha,
    expectedRunId,
    approvalPolicy,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl = fetch,
  } = options;
  assertStore(store);
  const subjectBytes = Buffer.isBuffer(suppliedSubjectBytes)
    ? suppliedSubjectBytes
    : Buffer.from(suppliedSubjectBytes ?? "");
  const subject = parseCanonicalJsonBytes(
    subjectBytes,
    "Policy activation subject",
  );
  assertExactKeys(subject, SUBJECT_KEYS, "Policy activation subject");
  const subjectSha256 = sha256Bytes(subjectBytes);
  if (
    subject.schemaVersion !== 1 ||
    subject.subjectKind !== POLICY_ACTIVATION_SUBJECT_KIND ||
    !NAMESPACE_PATTERN.test(subject.namespace) ||
    !OPERATION_ID_PATTERN.test(subject.operationId) ||
    !SOURCE_SHA_PATTERN.test(subject.executorSourceSha) ||
    !SOURCE_SHA_PATTERN.test(subject.targetSourceSha) ||
    !SHA256_PATTERN.test(expectedSubjectSha256) ||
    expectedSubjectSha256 !== subjectSha256 ||
    subject.executorSourceSha !== expectedExecutorSourceSha
  ) {
    throw new Error(
      "Policy activation subject identity or executor binding is invalid",
    );
  }
  const subjectReference = evidenceReference(subject.namespace, subjectSha256);
  const initialNowMilliseconds = now();
  if (!Number.isFinite(initialNowMilliseconds)) {
    throw new Error("Policy activation clock is invalid");
  }
  const appendId = deriveLifecycleAppendId({
    kind: "policy-activated",
    namespace: subject.namespace,
    operationId: subject.operationId,
    evidenceSha256: subjectSha256,
  });
  let current = await readState({ store });
  const existing = await existingActivation({
    store,
    current,
    subject,
    subjectBytes,
    subjectReference,
    appendId,
  });
  if (existing) return existing;
  const authoritativeSubject = await deriveSubjectImpl({
    store,
    namespace: subject.namespace,
    operationId: subject.operationId,
    executorSourceSha: subject.executorSourceSha,
    proposedPolicyReference: subject.proposedReleasePolicy,
    activePolicyReference: subject.activeReleasePolicy,
    closureBundleReference: subject.closureBundle,
    current,
    nowMilliseconds: initialNowMilliseconds,
  });
  if (!sameCanonicalValue(subject, authoritativeSubject)) {
    throw new Error(
      "Policy activation subject differs from authoritative state",
    );
  }
  const storedSubjectReference = await putSubject({
    store,
    namespace: subject.namespace,
    subjectBytes,
    subjectSha256,
  });
  const approvalSet = await collectApprovals({
    store,
    namespace: subject.namespace,
    policy: approvalPolicy,
    operationId: subject.operationId,
    subjectSha256,
    expectedSourceSha: subject.executorSourceSha,
    expectedRunId,
    oidcRequestUrl,
    oidcRequestToken,
    githubToken,
    fetchImpl,
    nowMs: initialNowMilliseconds,
  });
  assertRequiredApprovalSet(approvalSet.approvalRefs, POLICY_ACTIVATION_ROLES);
  for (const approval of approvalSet.approvalRefs) {
    if (
      approval.operationId !== subject.operationId ||
      approval.subjectSha256 !== subjectSha256 ||
      approval.protectedEnvironment !== approvalPolicy.protectedEnvironment ||
      approval.trustedIssuer !== approvalPolicy.trustedIssuer
    ) {
      throw new Error(
        "Policy activation approval differs from reviewed subject",
      );
    }
  }
  current = await readState({ store });
  const refreshedNowMilliseconds = now();
  if (
    !Number.isFinite(refreshedNowMilliseconds) ||
    refreshedNowMilliseconds < initialNowMilliseconds
  ) {
    throw new Error("Policy activation clock regressed during approval");
  }
  assertPolicyCompatibilityEntries(subject.activePolicyCompatibility, {
    namespace: subject.namespace,
    minimumSafetyFloors: subject.minimumSafetyFloors,
    currentDbCompatibility: current.snapshot.currentDbCompatibility,
    nowMilliseconds: refreshedNowMilliseconds,
  });
  const refreshed = await deriveSubjectImpl({
    store,
    namespace: subject.namespace,
    operationId: subject.operationId,
    executorSourceSha: subject.executorSourceSha,
    proposedPolicyReference: subject.proposedReleasePolicy,
    activePolicyReference: subject.activeReleasePolicy,
    closureBundleReference: subject.closureBundle,
    current,
    nowMilliseconds: refreshedNowMilliseconds,
  });
  if (!sameCanonicalValue(subject, refreshed)) {
    throw new Error("Release State changed during policy activation approval");
  }
  const evidenceRefs = sortAndDedupeReferences(
    [
      storedSubjectReference,
      subject.previousReleasePolicy,
      subject.proposedReleasePolicy,
      subject.activeReleasePolicy,
      subject.closureBundle,
      ...subject.closureEvidenceRefs,
      ...collectBindingEvidenceReferences(current.snapshot.acceptedStandard),
      ...subject.rollbackInventory.flatMap((entry) => [
        entry.acceptedEvent,
        ...collectBindingEvidenceReferences(entry.binding),
      ]),
      approvalSet.issuerReceiptReference,
      ...approvalSet.approvalRefs.map(({ uri, sha256 }) => ({ uri, sha256 })),
    ],
    subject.namespace,
  );
  const event = createReleaseEvent({
    namespace: subject.namespace,
    sequence: current.snapshot.sequence + 1,
    eventType: "policy-activated",
    operationId: subject.operationId,
    appendId,
    previousEventHash: current.snapshot.eventHash,
    payload: payloadFromSubject(subject),
    evidenceRefs,
    approvalRefs: approvalSet.approvalRefs,
  });
  reduceReleaseState(current.snapshot, event);
  const eventHash = hashReleaseEvent(event);
  const receipt = await store.compareAndAppend({
    expectedSequence: current.snapshot.sequence,
    expectedHash: current.snapshot.eventHash,
    event,
  });
  if (
    receipt?.namespace !== subject.namespace ||
    receipt.sequence !== event.sequence ||
    receipt.eventHash !== eventHash ||
    typeof receipt.replayed !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new Error("Policy activation CAS receipt differs from the event");
  }
  const committed = await readState({ store });
  const record = committed.records.find(
    (candidate) =>
      candidate.sequence === event.sequence &&
      candidate.eventHash === eventHash &&
      candidate.event.appendId === appendId,
  );
  if (
    !record ||
    !sameCanonicalValue(
      committed.snapshot.activeReleasePolicy,
      subject.activeReleasePolicy,
    )
  ) {
    throw new Error("Committed policy activation was not recovered by replay");
  }
  return {
    schemaVersion: 1,
    resultKind: "policy-activated/v2",
    operationId: subject.operationId,
    executorSourceSha: subject.executorSourceSha,
    targetSourceSha: subject.targetSourceSha,
    subject: subjectReference,
    approvals: approvalSet.approvalRefs,
    event: eventReference(subject.namespace, record),
    replayed: receipt.replayed,
    head: committed.head,
  };
};

export const activateP8MinimumSafetyFloor = activateReleasePolicy;
