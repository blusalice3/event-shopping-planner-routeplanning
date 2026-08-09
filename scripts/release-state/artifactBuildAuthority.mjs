import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  RELEASE_DIMENSION_KEYS,
  assertDimensionObject,
  projectContainmentDimensions,
  verifyPhaseSequence,
} from "../lib/release-policy.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  NORMAL_POLICY_ACTIVATION_GATES,
  RELEASE_PHASE_GATES,
  nextReleasePhaseGate,
} from "./phaseGates.mjs";
import { derivePolicyActivationTransition } from "./policyActivation.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  assertImmutableObjectReference,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

export const ARTIFACT_BUILD_REQUIREMENTS_KIND =
  "authoritative-artifact-build-requirements/v1";
export const ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-build-requirements+json;version=1";
export const RELEASE_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-policy+json;version=1";
export const PROVIDER_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-policy+json;version=1";
export const TOOLCHAIN_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.toolchain-policy+json;version=1";
export const CSP_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.csp-policy+json;version=1";

const PRODUCTION_PURPOSE = "production";
const POLICY_QA_PURPOSE = "policy-activation-qa";
const BUILD_PURPOSE = Object.freeze({
  [PRODUCTION_PURPOSE]: "production",
  [POLICY_QA_PURPOSE]: "non-promotable-policy-activation-qa",
});
const FLOOR_KEYS = RELEASE_DIMENSION_KEYS.filter(
  (key) => key !== "releaseRole",
);
const COMMON_BUILD_INPUT_KEYS = [
  "cspPolicyBytes",
  "executorSourceSha",
  "namespace",
  "operationId",
  "purpose",
  "store",
  "targetSourceSha",
  "toolchainPolicyBytes",
];
const QA_BUILD_INPUT_KEYS = [
  ...COMMON_BUILD_INPUT_KEYS,
  "activePolicyReference",
  "proposedPolicyReference",
];
const VALIDATE_INPUT_KEYS = [
  "checkoutSourceSha",
  "expectedSha256",
  "requirementsBytes",
  "store",
];
const COMMON_REQUIREMENT_KEYS = [
  "acceptedGate",
  "buildPurpose",
  "containmentDimensions",
  "cspPolicy",
  "currentDbCompatibility",
  "executorSourceSha",
  "expectedState",
  "namespace",
  "operationId",
  "promotable",
  "providerPolicy",
  "purpose",
  "releasePolicy",
  "requirementsKind",
  "schemaVersion",
  "standardDimensions",
  "targetGate",
  "targetSourceSha",
  "toolchainPolicy",
];
const QA_REQUIREMENT_KEYS = [
  ...COMMON_REQUIREMENT_KEYS,
  "activeReleasePolicy",
  "previousReleasePolicy",
  "proposedReleasePolicy",
];

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertPurpose = (purpose) => {
  if (purpose !== PRODUCTION_PURPOSE && purpose !== POLICY_QA_PURPOSE) {
    throw new Error("Artifact build purpose is invalid");
  }
  return purpose;
};

const assertStore = (store) => {
  if (
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error("Release State store does not provide evidence operations");
  }
  return store;
};

const assertIdentity = ({
  store,
  namespace,
  operationId,
  executorSourceSha,
  targetSourceSha,
}) => {
  assertStore(store);
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    (typeof store.namespace === "string" && store.namespace !== namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !SOURCE_SHA_PATTERN.test(executorSourceSha) ||
    !SOURCE_SHA_PATTERN.test(targetSourceSha)
  ) {
    throw new Error("Artifact build authority identity is invalid");
  }
};

const assertExpectedState = (head, label = "Expected Release State") => {
  assertExactKeys(head, ["eventHash", "sequence"], label);
  if (
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    typeof head.eventHash !== "string" ||
    !SHA256_PATTERN.test(head.eventHash)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return head;
};

const assertDbCompatibility = (value) => {
  assertExactKeys(
    value,
    ["contractUri", "fingerprint"],
    "Current DB compatibility",
  );
  if (
    typeof value.contractUri !== "string" ||
    value.contractUri.length === 0 ||
    value.contractUri.length > 2048 ||
    !SHA256_PATTERN.test(value.fingerprint)
  ) {
    throw new Error("Current DB compatibility is invalid");
  }
  return value;
};

const floorsFromDimensions = (dimensions) =>
  Object.fromEntries(FLOOR_KEYS.map((key) => [key, dimensions[key]]));

const phaseStates = (policy) => {
  verifyPhaseSequence(policy);
  const gates = policy.phaseSequence.map((phase) => phase.gate);
  if (!sameCanonicalValue(gates, RELEASE_PHASE_GATES)) {
    throw new Error(
      "Release policy phase gates differ from the canonical sequence",
    );
  }
  let standard = structuredClone(policy.initialStandard);
  return policy.phaseSequence.map((phase) => {
    if (phase.change !== null) standard = { ...standard, ...phase.change };
    return {
      gate: phase.gate,
      floors: floorsFromDimensions(standard),
    };
  });
};

const assertSnapshotPredecessor = ({ snapshot, states }) => {
  const acceptedGate = snapshot.acceptedGate;
  if (acceptedGate === null) {
    if (
      snapshot.acceptedStandard !== null ||
      !sameCanonicalValue(snapshot.acceptedStandardFloors, {})
    ) {
      throw new Error(
        "Unaccepted Release State has accepted standard authority",
      );
    }
    return;
  }
  const state = states.find((entry) => entry.gate === acceptedGate);
  if (
    !state ||
    snapshot.acceptedStandard === null ||
    !sameCanonicalValue(snapshot.acceptedStandardFloors, state.floors)
  ) {
    throw new Error("Accepted Release State does not match its phase gate");
  }
};

const assertIdleSnapshot = (snapshot) => {
  if (
    !snapshot ||
    snapshot.pendingOperation !== null ||
    snapshot.pendingAcceptance !== null
  ) {
    throw new Error("Artifact builds require an idle Release State snapshot");
  }
};

const readCanonicalReference = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (stored.mediaType !== mediaType) {
    throw new Error(`${label} media type is invalid`);
  }
  return {
    bytes: Buffer.from(stored.bytes),
    value: parseCanonicalJsonBytes(stored.bytes, label),
  };
};

const putCanonicalBytes = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const input = Buffer.from(bytes ?? "");
  const value = parseCanonicalJsonBytes(input, label);
  if (value?.schemaVersion !== 1) {
    throw new Error(`${label} schema version is invalid`);
  }
  const reference = referenceFor(namespace, input);
  const receipt = await store.putEvidence({ bytes: input, mediaType });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.byteLength !== input.length ||
    receipt.mediaType !== mediaType ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !stored?.bytes?.equals(input) ||
    stored.mediaType !== mediaType ||
    sha256Bytes(stored.bytes) !== reference.sha256
  ) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return reference;
};

const assertConfiguredProviderPolicy = (policy) => {
  if (
    policy?.schemaVersion !== 1 ||
    policy.bindingStatus !== "configured" ||
    typeof policy.expectedTeamId !== "string" ||
    policy.expectedTeamId.length === 0 ||
    typeof policy.expectedProjectId !== "string" ||
    policy.expectedProjectId.length === 0 ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0
  ) {
    throw new Error("Provider policy is not configured for artifact builds");
  }
  return policy;
};

const assertReleasePolicyState = (policy, status, blockersEmpty) => {
  verifyPhaseSequence(policy);
  if (
    policy.schemaVersion !== 1 ||
    policy.activationStatus !== status ||
    !Array.isArray(policy.activationBlockers) ||
    (blockersEmpty
      ? policy.activationBlockers.length !== 0
      : policy.activationBlockers.length === 0)
  ) {
    throw new Error(`Release policy is not a valid ${status} authority`);
  }
  return policy;
};

const assertReferenceMedia = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) =>
  readCanonicalReference({
    store,
    namespace,
    reference,
    mediaType,
    label,
  });

const providerReferenceFromSnapshot = (snapshot) => {
  const reference =
    snapshot.acceptedStandard?.providerPolicy ??
    snapshot.bootstrapRecovery?.providerPolicy;
  if (!reference) {
    throw new Error("Release State has no authoritative provider policy");
  }
  return reference;
};

const deriveRequirements = async ({
  store,
  namespace,
  operationId,
  executorSourceSha,
  targetSourceSha,
  purpose,
  proposedPolicyReference,
  activePolicyReference,
  toolchainPolicyReference,
  cspPolicyReference,
  current,
}) => {
  assertExpectedState(current.head);
  const { snapshot } = current;
  assertIdleSnapshot(snapshot);
  if (snapshot.acceptedGate === RELEASE_PHASE_GATES.at(-1)) {
    throw new Error(
      "Accepted release gate cannot advance outside the phase sequence",
    );
  }
  assertDbCompatibility(snapshot.currentDbCompatibility);
  const providerPolicyReference = providerReferenceFromSnapshot(snapshot);
  const previousPolicyReference = snapshot.activeReleasePolicy;
  assertImmutableObjectReference(
    previousPolicyReference,
    namespace,
    "Active release policy",
  );
  assertImmutableObjectReference(
    providerPolicyReference,
    namespace,
    "Provider policy",
  );
  assertImmutableObjectReference(
    toolchainPolicyReference,
    namespace,
    "Toolchain policy",
  );
  assertImmutableObjectReference(cspPolicyReference, namespace, "CSP policy");

  const [previousPolicyObject, providerPolicyObject] = await Promise.all([
    readCanonicalReference({
      store,
      namespace,
      reference: previousPolicyReference,
      mediaType: RELEASE_POLICY_MEDIA_TYPE,
      label: "Active release policy",
    }),
    readCanonicalReference({
      store,
      namespace,
      reference: providerPolicyReference,
      mediaType: PROVIDER_POLICY_MEDIA_TYPE,
      label: "Provider policy",
    }),
  ]);
  assertConfiguredProviderPolicy(providerPolicyObject.value);

  let selectedPolicy;
  let releasePolicyReference;
  let targetGate;
  let qaFields = {};
  if (purpose === PRODUCTION_PURPOSE) {
    if (executorSourceSha !== targetSourceSha) {
      throw new Error("Production builds must execute from the target source");
    }
    selectedPolicy = assertReleasePolicyState(
      previousPolicyObject.value,
      "active",
      true,
    );
    const states = phaseStates(selectedPolicy);
    assertSnapshotPredecessor({ snapshot, states });
    targetGate = nextReleasePhaseGate(snapshot.acceptedGate);
    const targetState = states.find((entry) => entry.gate === targetGate);
    if (
      !targetState ||
      !sameCanonicalValue(
        selectedPolicy.acceptedStandardFloors,
        targetState.floors,
      )
    ) {
      throw new Error(
        "Active release policy does not authorize the next production gate",
      );
    }
    releasePolicyReference = previousPolicyReference;
  } else {
    assertImmutableObjectReference(
      proposedPolicyReference,
      namespace,
      "Proposed release policy",
    );
    assertImmutableObjectReference(
      activePolicyReference,
      namespace,
      "Prospective active release policy",
    );
    const [proposedPolicyObject, activePolicyObject] = await Promise.all([
      readCanonicalReference({
        store,
        namespace,
        reference: proposedPolicyReference,
        mediaType: RELEASE_POLICY_MEDIA_TYPE,
        label: "Proposed release policy",
      }),
      readCanonicalReference({
        store,
        namespace,
        reference: activePolicyReference,
        mediaType: RELEASE_POLICY_MEDIA_TYPE,
        label: "Prospective active release policy",
      }),
    ]);
    assertReleasePolicyState(previousPolicyObject.value, "active", true);
    assertReleasePolicyState(proposedPolicyObject.value, "proposed", false);
    assertReleasePolicyState(activePolicyObject.value, "active", true);
    const states = phaseStates(proposedPolicyObject.value);
    assertSnapshotPredecessor({ snapshot, states });
    const transition = derivePolicyActivationTransition({
      previousPolicy: previousPolicyObject.value,
      proposedPolicy: proposedPolicyObject.value,
      activePolicy: activePolicyObject.value,
      acceptedGate: snapshot.acceptedGate,
      acceptedStandardFloors: snapshot.acceptedStandardFloors,
      currentFloors: snapshot.minimumSafetyFloors,
      previousReleasePolicy: previousPolicyReference,
      proposedReleasePolicy: proposedPolicyReference,
      activeReleasePolicy: activePolicyReference,
    });
    targetGate = nextReleasePhaseGate(snapshot.acceptedGate);
    if (
      transition.activationGate !== targetGate ||
      !NORMAL_POLICY_ACTIVATION_GATES.includes(targetGate)
    ) {
      throw new Error(
        "Policy QA builds require an exact behavior-policy successor gate",
      );
    }
    selectedPolicy = proposedPolicyObject.value;
    releasePolicyReference = proposedPolicyReference;
    qaFields = {
      previousReleasePolicy: structuredClone(previousPolicyReference),
      proposedReleasePolicy: structuredClone(proposedPolicyReference),
      activeReleasePolicy: structuredClone(activePolicyReference),
    };
  }

  const standardDimensions = {
    releaseRole: "standard",
    ...selectedPolicy.acceptedStandardFloors,
  };
  assertDimensionObject(selectedPolicy, standardDimensions);
  const containmentDimensions = projectContainmentDimensions(
    selectedPolicy,
    standardDimensions,
  );
  return {
    schemaVersion: 1,
    requirementsKind: ARTIFACT_BUILD_REQUIREMENTS_KIND,
    namespace,
    operationId,
    purpose,
    buildPurpose: BUILD_PURPOSE[purpose],
    promotable: purpose === PRODUCTION_PURPOSE,
    executorSourceSha,
    targetSourceSha,
    expectedState: structuredClone(current.head),
    acceptedGate: snapshot.acceptedGate,
    targetGate,
    releasePolicy: structuredClone(releasePolicyReference),
    providerPolicy: structuredClone(providerPolicyReference),
    currentDbCompatibility: structuredClone(snapshot.currentDbCompatibility),
    toolchainPolicy: structuredClone(toolchainPolicyReference),
    cspPolicy: structuredClone(cspPolicyReference),
    standardDimensions,
    containmentDimensions,
    ...qaFields,
  };
};

const assertRequirementsShape = (requirements) => {
  const purpose = assertPurpose(requirements?.purpose);
  assertExactKeys(
    requirements,
    purpose === POLICY_QA_PURPOSE
      ? QA_REQUIREMENT_KEYS
      : COMMON_REQUIREMENT_KEYS,
    "Artifact build requirements",
  );
  if (
    requirements.schemaVersion !== 1 ||
    requirements.requirementsKind !== ARTIFACT_BUILD_REQUIREMENTS_KIND ||
    !NAMESPACE_PATTERN.test(requirements.namespace) ||
    !OPERATION_ID_PATTERN.test(requirements.operationId) ||
    !SOURCE_SHA_PATTERN.test(requirements.executorSourceSha) ||
    !SOURCE_SHA_PATTERN.test(requirements.targetSourceSha) ||
    requirements.buildPurpose !== BUILD_PURPOSE[purpose] ||
    requirements.promotable !== (purpose === PRODUCTION_PURPOSE) ||
    !RELEASE_PHASE_GATES.includes(requirements.targetGate) ||
    !(
      requirements.acceptedGate === null ||
      RELEASE_PHASE_GATES.includes(requirements.acceptedGate)
    )
  ) {
    throw new Error("Artifact build requirements identity is invalid");
  }
  assertExpectedState(requirements.expectedState);
  assertDbCompatibility(requirements.currentDbCompatibility);
  for (const [field, label] of [
    ["releasePolicy", "Release policy"],
    ["providerPolicy", "Provider policy"],
    ["toolchainPolicy", "Toolchain policy"],
    ["cspPolicy", "CSP policy"],
    ...(purpose === POLICY_QA_PURPOSE
      ? [
          ["previousReleasePolicy", "Previous release policy"],
          ["proposedReleasePolicy", "Proposed release policy"],
          ["activeReleasePolicy", "Prospective active release policy"],
        ]
      : []),
  ]) {
    assertImmutableObjectReference(
      requirements[field],
      requirements.namespace,
      label,
    );
  }
  return requirements;
};

export const buildAuthoritativeArtifactBuildRequirements = async (
  options,
  { readState = readCurrentReleaseState } = {},
) => {
  const purpose = assertPurpose(options?.purpose);
  assertExactKeys(
    options,
    purpose === POLICY_QA_PURPOSE
      ? QA_BUILD_INPUT_KEYS
      : COMMON_BUILD_INPUT_KEYS,
    "Artifact build authority input",
  );
  assertIdentity(options);
  const [toolchainPolicyReference, cspPolicyReference, current] =
    await Promise.all([
      putCanonicalBytes({
        store: options.store,
        namespace: options.namespace,
        bytes: options.toolchainPolicyBytes,
        mediaType: TOOLCHAIN_POLICY_MEDIA_TYPE,
        label: "Toolchain policy",
      }),
      putCanonicalBytes({
        store: options.store,
        namespace: options.namespace,
        bytes: options.cspPolicyBytes,
        mediaType: CSP_POLICY_MEDIA_TYPE,
        label: "CSP policy",
      }),
      readState({ store: options.store }),
    ]);
  const requirements = await deriveRequirements({
    ...options,
    purpose,
    toolchainPolicyReference,
    cspPolicyReference,
    current,
  });
  assertRequirementsShape(requirements);
  const requirementsBytes = canonicalJsonBytes(requirements);
  const requirementsReference = await putCanonicalBytes({
    store: options.store,
    namespace: options.namespace,
    bytes: requirementsBytes,
    mediaType: ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
    label: "Artifact build requirements",
  });
  return {
    requirements,
    requirementsBytes,
    requirementsSha256: requirementsReference.sha256,
    requirementsReference,
  };
};

export const validateAuthoritativeArtifactBuildRequirements = async (
  options,
  { readState = readCurrentReleaseState } = {},
) => {
  assertExactKeys(
    options,
    VALIDATE_INPUT_KEYS,
    "Artifact build requirements validation input",
  );
  assertStore(options.store);
  if (
    !SHA256_PATTERN.test(options.expectedSha256) ||
    !SOURCE_SHA_PATTERN.test(options.checkoutSourceSha)
  ) {
    throw new Error(
      "Artifact build requirements validation identity is invalid",
    );
  }
  const requirementsBytes = Buffer.from(options.requirementsBytes ?? "");
  if (sha256Bytes(requirementsBytes) !== options.expectedSha256) {
    throw new Error("Artifact build requirements reviewed SHA differs");
  }
  const requirements = assertRequirementsShape(
    parseCanonicalJsonBytes(requirementsBytes, "Artifact build requirements"),
  );
  if (
    typeof options.store.namespace === "string" &&
    options.store.namespace !== requirements.namespace
  ) {
    throw new Error("Artifact build requirements namespace differs from store");
  }
  if (requirements.targetSourceSha !== options.checkoutSourceSha) {
    throw new Error("Artifact build checkout source differs from requirements");
  }
  const requirementsReference = referenceFor(
    requirements.namespace,
    requirementsBytes,
  );
  const [storedRequirements, toolchainPolicy, cspPolicy, current] =
    await Promise.all([
      assertEvidenceObjectAvailable({
        store: options.store,
        namespace: requirements.namespace,
        reference: requirementsReference,
        label: "Artifact build requirements",
      }),
      assertReferenceMedia({
        store: options.store,
        namespace: requirements.namespace,
        reference: requirements.toolchainPolicy,
        mediaType: TOOLCHAIN_POLICY_MEDIA_TYPE,
        label: "Toolchain policy",
      }),
      assertReferenceMedia({
        store: options.store,
        namespace: requirements.namespace,
        reference: requirements.cspPolicy,
        mediaType: CSP_POLICY_MEDIA_TYPE,
        label: "CSP policy",
      }),
      readState({ store: options.store }),
    ]);
  if (
    storedRequirements.mediaType !== ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE ||
    !storedRequirements.bytes.equals(requirementsBytes)
  ) {
    throw new Error("Stored artifact build requirements differ from review");
  }
  const rederived = await deriveRequirements({
    store: options.store,
    namespace: requirements.namespace,
    operationId: requirements.operationId,
    executorSourceSha: requirements.executorSourceSha,
    targetSourceSha: requirements.targetSourceSha,
    purpose: requirements.purpose,
    proposedPolicyReference: requirements.proposedReleasePolicy,
    activePolicyReference: requirements.activeReleasePolicy,
    toolchainPolicyReference: requirements.toolchainPolicy,
    cspPolicyReference: requirements.cspPolicy,
    current,
  });
  if (
    toolchainPolicy.value.schemaVersion !== 1 ||
    cspPolicy.value.schemaVersion !== 1 ||
    !sameCanonicalValue(rederived, requirements)
  ) {
    throw new Error(
      "Artifact build requirements differ from current authoritative state",
    );
  }
  return {
    requirements,
    requirementsSha256: options.expectedSha256,
    requirementsReference,
  };
};
