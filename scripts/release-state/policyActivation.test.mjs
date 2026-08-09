import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  activateReleasePolicy,
  buildAuthoritativePolicyActivationSubject,
  deriveP8MinimumSafetyFloorTransition,
  derivePolicyActivationTransition,
  validatePolicyActivationClosureBundle,
} from "./policyActivation.mjs";
import {
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const policyTemplate = JSON.parse(
  await readFile(path.join(root, "config", "release-variants.json"), "utf8"),
);
const namespace = "policy-activation-test";
const executorSourceSha = "a".repeat(40);
const targetSourceSha = "b".repeat(40);
const sha = (character) => character.repeat(64);
const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${sha(character)}`,
  sha256: sha(character),
});
const previousReleasePolicy = reference("1");
const proposedReleasePolicy = reference("2");
const activeReleasePolicy = reference("3");
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: sha("d"),
};
const preP8Floors = Object.fromEntries(
  Object.entries(policyTemplate.minimumSafetyFloors).filter(
    ([key]) => key !== "styleSrcAttr",
  ),
);
const initialAcceptedFloors = structuredClone(
  policyTemplate.acceptedStandardFloors,
);

const binding = {
  bindingId: "standard-p0",
  sourceSha: targetSourceSha,
  buildId: targetSourceSha,
  variantId: sha("4"),
  releaseRole: "standard",
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: "deployment-test",
  deploymentUrl: "https://standard.example.test",
  artifactArchive: reference("5"),
  artifactArchiveAvailability: reference("6"),
  packageIndex: reference("7"),
  artifactManifest: reference("8"),
  providerEvidence: reference("9"),
  releasePolicy: previousReleasePolicy,
  providerPolicy: reference("a"),
  providerConfigurationHash: sha("b"),
  requiredDbCompatibility: dbCompatibility,
};
const compatibilityEntry = {
  predecessorPolicy: previousReleasePolicy,
  eligibleBindingIds: [binding.bindingId],
  allowedActions: ["rollback"],
  minimumSafetyFloors: preP8Floors,
  requiredDbCompatibility: dbCompatibility,
  expiresAt: "2027-08-01T00:00:00.000Z",
  owner: "foundation-release-owner",
};

const previousPolicy = {
  ...structuredClone(policyTemplate),
  activationStatus: "active",
  activationBlockers: [],
  compatiblePredecessorPolicies: [],
};
const proposedPolicy = {
  ...structuredClone(policyTemplate),
  activationStatus: "proposed",
  activationBlockers: ["non-production-qa-pending"],
  acceptedStandardFloors: {
    ...initialAcceptedFloors,
    pwaLifecycle: "prompt-close-all-v1",
  },
  compatiblePredecessorPolicies: [compatibilityEntry],
};
const nextActivePolicy = {
  ...structuredClone(proposedPolicy),
  activationStatus: "active",
  activationBlockers: [],
};
const transition = {
  activationGate: "P1-PWA",
  behaviorDimensionChange: {
    dimension: "pwaLifecycle",
    from: "legacy-auto-update-v1",
    to: "prompt-close-all-v1",
  },
  minimumSafetyFloorChange: null,
  minimumSafetyFloors: preP8Floors,
};

test("derives one exact proposed-to-active phase transition", () => {
  assert.deepEqual(
    derivePolicyActivationTransition({
      previousPolicy,
      proposedPolicy,
      activePolicy: nextActivePolicy,
      acceptedGate: "P0-RELEASE",
      acceptedStandardFloors: initialAcceptedFloors,
      currentFloors: preP8Floors,
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
    }),
    transition,
  );
  assert.throws(
    () =>
      derivePolicyActivationTransition({
        previousPolicy,
        proposedPolicy,
        activePolicy: {
          ...nextActivePolicy,
          policyId: "tampered-policy",
        },
        acceptedGate: "P0-RELEASE",
        acceptedStandardFloors: initialAcceptedFloors,
        currentFloors: preP8Floors,
        previousReleasePolicy,
        proposedReleasePolicy,
        activeReleasePolicy,
      }),
    /static policy projection|beyond status/,
  );
  const skipped = structuredClone(proposedPolicy);
  skipped.acceptedStandardFloors.cssDelivery = "local";
  const skippedActive = {
    ...structuredClone(skipped),
    activationStatus: "active",
    activationBlockers: [],
  };
  assert.throws(
    () =>
      derivePolicyActivationTransition({
        previousPolicy,
        proposedPolicy: skipped,
        activePolicy: skippedActive,
        acceptedGate: "P0-RELEASE",
        acceptedStandardFloors: initialAcceptedFloors,
        currentFloors: preP8Floors,
        previousReleasePolicy,
        proposedReleasePolicy,
        activeReleasePolicy,
      }),
    /exactly one phase gate/,
  );
  assert.throws(
    () =>
      derivePolicyActivationTransition({
        previousPolicy,
        proposedPolicy,
        activePolicy: nextActivePolicy,
        acceptedGate: "P1-PWA",
        acceptedStandardFloors: initialAcceptedFloors,
        currentFloors: preP8Floors,
        previousReleasePolicy,
        proposedReleasePolicy,
        activeReleasePolicy,
      }),
    /exact successor of the accepted gate/,
  );
});

test("keeps policy bytes fixed for the P8 minimum-floor variant", () => {
  const p8Policy = {
    ...structuredClone(previousPolicy),
    acceptedStandardFloors: Object.fromEntries(
      Object.entries(policyTemplate.targetStandard).filter(
        ([key]) => key !== "releaseRole",
      ),
    ),
  };
  assert.deepEqual(
    derivePolicyActivationTransition({
      previousPolicy: p8Policy,
      proposedPolicy: p8Policy,
      activePolicy: p8Policy,
      acceptedGate: "P8-CLEAN",
      acceptedStandardFloors: p8Policy.acceptedStandardFloors,
      currentFloors: preP8Floors,
      previousReleasePolicy,
      proposedReleasePolicy: previousReleasePolicy,
      activeReleasePolicy: previousReleasePolicy,
    }),
    deriveP8MinimumSafetyFloorTransition({
      releasePolicy: p8Policy,
      currentFloors: preP8Floors,
    }),
  );
  assert.throws(
    () =>
      derivePolicyActivationTransition({
        previousPolicy: p8Policy,
        proposedPolicy: p8Policy,
        activePolicy: p8Policy,
        acceptedGate: "P7-IDB",
        acceptedStandardFloors: p8Policy.acceptedStandardFloors,
        currentFloors: preP8Floors,
        previousReleasePolicy,
        proposedReleasePolicy: previousReleasePolicy,
        activeReleasePolicy: previousReleasePolicy,
      }),
    /exact successor of the accepted gate/,
  );
});

const buildClosureHarness = ({ tamperField } = {}) => {
  const objects = new Map();
  const put = (value) => {
    const bytes = canonicalJsonBytes(value);
    const digest = sha256Bytes(bytes);
    objects.set(digest, {
      bytes,
      mediaType: "application/json",
    });
    return {
      uri: `release-state://${namespace}/evidence/${digest}`,
      sha256: digest,
    };
  };
  const results = {
    nonProductionQa: {
      qaPackage: put({ evidenceKind: "qa-package-index" }),
      standardManifest: put({ evidenceKind: "qa-standard-manifest" }),
      companionManifest: put({ evidenceKind: "qa-companion-manifest" }),
      standardArchive: put({ evidenceKind: "qa-standard-archive" }),
      companionArchive: put({ evidenceKind: "qa-companion-archive" }),
      standardDeploymentObservation: put({
        evidenceKind: "qa-standard-deployment",
      }),
      companionDeploymentObservation: put({
        evidenceKind: "qa-companion-deployment",
      }),
      sourceSha: targetSourceSha,
      toolchainPolicyHash: sha("a"),
      nonPromotable: true,
    },
    schemaValidation: { policySchema: "release-policy/v1", valid: true },
    monotonicity: {
      behaviorDimensionChange: transition.behaviorDimensionChange,
      minimumSafetyFloorChange: null,
      minimumSafetyFloors: preP8Floors,
    },
    predecessorCompatibility: {
      compatible: true,
      closedBlockers: proposedPolicy.activationBlockers,
      compatibility: [compatibilityEntry],
    },
    rollbackContainmentDrill: {
      rollbackDrill: put({ evidenceKind: "rollback-drill" }),
      rollbackCommandReceipt: put({ evidenceKind: "rollback-command" }),
      rollbackProviderObservation: put({ evidenceKind: "rollback-provider" }),
      containmentDrill: put({ evidenceKind: "containment-drill" }),
      containmentCommandReceipt: put({
        evidenceKind: "containment-command",
      }),
      containmentProviderObservation: put({
        evidenceKind: "containment-provider",
      }),
    },
  };
  const kinds = {
    nonProductionQa: "policy-non-production-qa/v1",
    schemaValidation: "policy-schema-validation/v1",
    monotonicity: "policy-monotonicity-validation/v1",
    predecessorCompatibility: "policy-predecessor-compatibility/v1",
    rollbackContainmentDrill: "policy-rollback-containment-drill/v1",
  };
  const receipts = Object.fromEntries(
    Object.entries(kinds).map(([field, receiptKind]) => [
      field,
      put({
        schemaVersion: 1,
        receiptKind,
        namespace,
        operationId,
        activationGate: transition.activationGate,
        previousReleasePolicy,
        proposedReleasePolicy,
        activeReleasePolicy,
        status: field === tamperField ? "failed" : "passed",
        result: results[field],
      }),
    ]),
  );
  const closureBundleReference = put({
    schemaVersion: 1,
    bundleKind: "policy-activation-closure/v1",
    namespace,
    operationId,
    activationGate: transition.activationGate,
    previousReleasePolicy,
    proposedReleasePolicy,
    activeReleasePolicy,
    receipts,
  });
  return {
    closureBundleReference,
    store: {
      async readEvidence({ sha256: digest }) {
        return objects.get(digest) ?? null;
      },
    },
  };
};

test("requires all five typed closure receipts and rejects a failed receipt", async () => {
  const valid = buildClosureHarness();
  const references = await validatePolicyActivationClosureBundle({
    store: valid.store,
    namespace,
    closureBundleReference: valid.closureBundleReference,
    previousReleasePolicy,
    proposedReleasePolicy,
    activeReleasePolicy,
    transition,
    blockers: proposedPolicy.activationBlockers,
    operationId,
    activePolicyCompatibility: [compatibilityEntry],
  });
  assert.equal(references.length, 5);
  const failed = buildClosureHarness({ tamperField: "schemaValidation" });
  await assert.rejects(
    validatePolicyActivationClosureBundle({
      store: failed.store,
      namespace,
      closureBundleReference: failed.closureBundleReference,
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      transition,
      blockers: proposedPolicy.activationBlockers,
      operationId,
      activePolicyCompatibility: [compatibilityEntry],
    }),
    /identity is invalid/,
  );
});

const closureEvidenceRefs = ["c", "d", "e", "f", "0"]
  .map(reference)
  .sort((left, right) => Buffer.from(left.uri).compare(Buffer.from(right.uri)));
const closureBundle = reference("4");
const initialSnapshot = {
  sequence: 1,
  eventHash: sha("f"),
  legacyObservedProduction: null,
  activeProduction: binding,
  acceptedStandard: binding,
  acceptedStandardEvent: reference("e"),
  acceptedGate: "P0-RELEASE",
  bootstrapRecovery: null,
  containmentCompanion: null,
  pendingOperation: null,
  pendingAcceptance: null,
  containmentIncident: null,
  standardRecovery: null,
  rollbackInventory: [],
  minimumSafetyFloors: preP8Floors,
  acceptedStandardFloors: initialAcceptedFloors,
  currentDbCompatibility: dbCompatibility,
  activeReleasePolicy: previousReleasePolicy,
  activePolicyCompatibility: [],
};
const operationId = "activate-p1-policy";
const subject = {
  schemaVersion: 1,
  subjectKind: "policy-activation-subject/v2",
  namespace,
  operationId,
  executorSourceSha,
  targetSourceSha,
  expectedState: {
    sequence: initialSnapshot.sequence,
    eventHash: initialSnapshot.eventHash,
  },
  ...transition,
  previousReleasePolicy,
  proposedReleasePolicy,
  activeReleasePolicy,
  activePolicyCompatibility: [compatibilityEntry],
  closureBundle,
  closureEvidenceRefs,
  rollbackInventory: [],
};
const subjectBytes = canonicalJsonBytes(subject);
const subjectSha256 = sha256Bytes(subjectBytes);

const approval = (role, character) => ({
  uri: reference(character).uri,
  sha256: reference(character).sha256,
  approvalId: `approval-${role}`,
  operationId,
  subjectSha256,
  trustedIssuer: "https://token.actions.githubusercontent.com",
  issuerReceiptUri: reference("1").uri,
  issuerReceiptSha256: reference("1").sha256,
  workflowRunId: "12345",
  protectedEnvironment: "foundation-release-state",
  providerReviewerId: `reviewer-${role}`,
  role,
  decision: "APPROVED",
  approvedAt: "2026-08-03T00:00:00.000Z",
});
const approvals = [
  approval("releaseOwner", "6"),
  approval("dataSafetyReviewer", "7"),
  approval("operationsReviewer", "8"),
];

const makeActivationHarness = () => {
  let current = {
    head: {
      sequence: initialSnapshot.sequence,
      eventHash: initialSnapshot.eventHash,
    },
    snapshot: structuredClone(initialSnapshot),
    records: [
      {
        sequence: 1,
        eventHash: initialSnapshot.eventHash,
        event: { appendId: "initial" },
      },
    ],
  };
  const evidence = new Map();
  const store = {
    namespace,
    async readHead() {
      return current.head;
    },
    async readEvents() {
      return current.records;
    },
    async putEvidence({ bytes, mediaType }) {
      const value = Buffer.from(bytes);
      const digest = sha256Bytes(value);
      evidence.set(digest, { bytes: value, mediaType });
      return {
        uri: `release-state://${namespace}/evidence/${digest}`,
        sha256: digest,
        byteLength: value.length,
        mediaType,
        replayed: false,
      };
    },
    async readEvidence({ sha256: digest }) {
      return evidence.get(digest) ?? null;
    },
    async compareAndAppend({ expectedSequence, expectedHash, event }) {
      assert.equal(expectedSequence, current.head.sequence);
      assert.equal(expectedHash, current.head.eventHash);
      const eventHash = hashReleaseEvent(event);
      current = {
        head: { sequence: event.sequence, eventHash },
        snapshot: reduceReleaseState(current.snapshot, event),
        records: [
          ...current.records,
          { sequence: event.sequence, eventHash, event },
        ],
      };
      return {
        namespace,
        sequence: event.sequence,
        eventHash,
        replayed: false,
        committedAt: "2026-08-03T00:00:00.000Z",
      };
    },
  };
  return { store, readState: async () => current, current: () => current };
};

test("commits one three-approval CAS and idempotently replays it", async () => {
  const harness = makeActivationHarness();
  const options = {
    store: harness.store,
    subjectBytes,
    expectedSubjectSha256: subjectSha256,
    expectedExecutorSourceSha: executorSourceSha,
    expectedRunId: "12345",
    approvalPolicy: {
      protectedEnvironment: "foundation-release-state",
      trustedIssuer: "https://token.actions.githubusercontent.com",
    },
    oidcRequestUrl: "https://oidc.example.test",
    oidcRequestToken: "token",
    githubToken: "github-token",
  };
  const dependencies = {
    readState: harness.readState,
    deriveSubjectImpl: async () => structuredClone(subject),
    collectApprovals: async () => ({
      approvalRefs: approvals,
      issuerReceiptReference: reference("9"),
    }),
  };
  const first = await activateReleasePolicy(options, dependencies);
  assert.equal(first.replayed, false);
  assert.deepEqual(
    harness.current().snapshot.activeReleasePolicy,
    activeReleasePolicy,
  );
  const replay = await activateReleasePolicy(options, dependencies);
  assert.equal(replay.replayed, true);
  assert.equal(harness.current().records.length, 2);
});

test("fails closed when predecessor compatibility expires during approval", async () => {
  const harness = makeActivationHarness();
  const times = [
    Date.parse("2026-08-03T00:00:00.000Z"),
    Date.parse("2028-08-03T00:00:00.000Z"),
  ];
  await assert.rejects(
    activateReleasePolicy(
      {
        store: harness.store,
        subjectBytes,
        expectedSubjectSha256: subjectSha256,
        expectedExecutorSourceSha: executorSourceSha,
        expectedRunId: "12345",
        approvalPolicy: {
          protectedEnvironment: "foundation-release-state",
          trustedIssuer: "https://token.actions.githubusercontent.com",
        },
      },
      {
        readState: harness.readState,
        deriveSubjectImpl: async () => structuredClone(subject),
        collectApprovals: async () => ({
          approvalRefs: approvals,
          issuerReceiptReference: reference("9"),
        }),
        now: () => times.shift(),
      },
    ),
    /safety, expiry, DB, or owner binding is invalid/,
  );
  assert.equal(harness.current().records.length, 1);
});

test("producer and executor reject caller authority and executor tamper", async () => {
  const harness = makeActivationHarness();
  await assert.rejects(
    buildAuthoritativePolicyActivationSubject(
      {
        store: harness.store,
        namespace,
        operationId,
        executorSourceSha,
        proposedPolicySha256: proposedReleasePolicy.sha256,
        activePolicySha256: activeReleasePolicy.sha256,
        closureBundleSha256: closureBundle.sha256,
        activeReleasePolicy,
      },
      { readState: harness.readState },
    ),
    /Caller-supplied activeReleasePolicy is forbidden/,
  );
  await assert.rejects(
    activateReleasePolicy(
      {
        store: harness.store,
        subjectBytes,
        expectedSubjectSha256: subjectSha256,
        expectedExecutorSourceSha: "0".repeat(40),
      },
      { readState: harness.readState },
    ),
    /executor binding is invalid/,
  );
});
