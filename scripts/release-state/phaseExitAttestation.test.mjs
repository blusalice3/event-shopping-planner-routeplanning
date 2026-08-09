import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_REQUIRED_AUTHORITIES,
  PHASE_EXIT_SUBJECT_KIND_BY_GATE,
} from "./phaseGates.mjs";
import {
  PHASE_EXIT_ATTESTATION_MEDIA_TYPE,
  appendPhaseExitAttestation,
  assertPhaseExitAttestation,
  buildPhaseExitAttestation,
  putPhaseExitAttestation,
  readPhaseExitAttestation,
  readPhaseExitAttestationLedger,
  validatePreInitializationPhaseExitSeed,
  validatePhaseExitAttestationChain,
} from "./phaseExitAttestation.mjs";
import { parsePhaseExitAttestationArguments } from "./attest-phase-exit.mjs";
import { derivePhaseExitSupportingEvent } from "./phaseExitSupportingEvent.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
  replayReleaseEvents,
} from "./releaseStateReducer.mjs";

const namespace = "phase-attestation-test";
const sourceSha = "a".repeat(40);
const bootstrapSourceSha = "d".repeat(40);
const issuedAt = "2026-08-09T00:00:00.000Z";
const fixtureIsAncestor = async (ancestor, descendant) =>
  ancestor === descendant ||
  (ancestor === bootstrapSourceSha && descendant === sourceSha);

const createStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = issuedAt;
      const replayed = objects.has(sha256);
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        mediaType,
        committedAt,
      });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
        replayed,
      };
    },
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { ...stored, bytes: Buffer.from(stored.bytes) };
    },
  };
};

let nextEvidence = 0;
const authoritySet = (gate) =>
  PHASE_EXIT_REQUIRED_AUTHORITIES[gate].map((id) => {
    nextEvidence += 1;
    const sha256 = nextEvidence.toString(16).padStart(64, "0");
    return {
      id,
      evidence: [
        {
          uri: `release-state://${namespace}/evidence/${sha256}`,
          sha256,
        },
      ],
    };
  });

const fallbackSupport = (gate, head, subjectSourceSha) => ({
  sequence: head.sequence,
  eventHash: head.eventHash,
  eventType:
    gate === "P0-DATA"
      ? "state-initialized"
      : gate === "P0-PROMOTE"
        ? "assignment-validated"
        : "release-accepted",
  gate,
  sourceSha: subjectSourceSha,
  bindingId: gate === "P0-DATA" ? "bootstrap:candidate" : `binding:${gate}`,
});

const subjectFor = (
  gate,
  head,
  subjectSourceSha = sourceSha,
  supportingEvent = null,
) => {
  const kind = PHASE_EXIT_SUBJECT_KIND_BY_GATE[gate];
  if (kind === "repository-phase-subject/v1") {
    return { kind, sourceSha: subjectSourceSha };
  }
  if (kind === "disposable-drill-subject/v1") {
    return {
      kind,
      sourceSha: subjectSourceSha,
      drillId: "artifact-drill-fixture",
    };
  }
  if (kind === "state-initialized-bootstrap-subject/v1") {
    return {
      kind,
      executorSourceSha: subjectSourceSha,
      bootstrapSourceSha,
      bootstrapBinding: {
        artifactArchiveSha256: "8".repeat(64),
        bindingId: "bootstrap:candidate",
        packageIndexSha256: "9".repeat(64),
        providerDeploymentId: "bootstrap-recovery-1",
        releaseRole: "containment",
        sourceSha: bootstrapSourceSha,
      },
      rawDistManifestSha256: "7".repeat(64),
      releaseStateHead: head,
      supportingEvent:
        supportingEvent ?? fallbackSupport(gate, head, subjectSourceSha),
    };
  }
  return {
    kind,
    sourceSha: subjectSourceSha,
    releaseStateHead: head,
    supportingEvent:
      supportingEvent ?? fallbackSupport(gate, head, subjectSourceSha),
  };
};

const currentFixture = () => {
  const initialized = createReleaseEvent({
    namespace,
    sequence: 1,
    eventType: "state-initialized",
    operationId: "initialize:fixture",
    appendId: "10000000-0000-4000-8000-000000000001",
    previousEventHash: null,
    payload: {
      executorSourceSha: sourceSha,
      bootstrapRecovery: {
        bindingId: "bootstrap:candidate",
        sourceSha: bootstrapSourceSha,
      },
    },
    evidenceRefs: [],
    approvalRefs: [],
  });
  const initializedHash = hashReleaseEvent(initialized);
  const operationId = "promote:fixture";
  const targetBinding = {
    bindingId: "binding:P0-PROMOTE",
    sourceSha,
  };
  const pendingOperation = {
    operationId,
    kind: "promote-standard",
    expectedState: { sequence: 1, eventHash: initializedHash },
    targetBinding,
    originBinding: null,
    originCompanionBinding: null,
    companionBinding: { bindingId: "binding:companion", sourceSha },
    previousBinding: null,
    emergencyRecoveryBinding: {
      bindingId: "bootstrap:candidate",
      sourceSha: bootstrapSourceSha,
    },
    approvalRefs: [],
    preparedAt: "2026-08-09T00:00:00.000Z",
  };
  const prepared = createReleaseEvent({
    namespace,
    sequence: 2,
    eventType: "promotion-prepared",
    operationId,
    appendId: "20000000-0000-4000-8000-000000000002",
    previousEventHash: initializedHash,
    payload: { pendingOperation },
    evidenceRefs: [],
    approvalRefs: [],
  });
  const preparedHash = hashReleaseEvent(prepared);
  const preparedReference = {
    uri: `release-state://${namespace}/events/2/${preparedHash}`,
    sha256: preparedHash,
  };
  const assignmentReceipt = {
    uri: `release-state://${namespace}/evidence/${"8".repeat(64)}`,
    sha256: "8".repeat(64),
  };
  const assigned = createReleaseEvent({
    namespace,
    sequence: 3,
    eventType: "deployment-assigned",
    operationId,
    appendId: "30000000-0000-4000-8000-000000000003",
    previousEventHash: preparedHash,
    payload: {
      assignmentReceipt,
      promotionReceipt: {
        uri: `release-state://${namespace}/evidence/${"9".repeat(64)}`,
        sha256: "9".repeat(64),
      },
      targetBinding,
    },
    evidenceRefs: [preparedReference],
    approvalRefs: [],
  });
  const assignedHash = hashReleaseEvent(assigned);
  const validated = createReleaseEvent({
    namespace,
    sequence: 4,
    eventType: "assignment-validated",
    operationId,
    appendId: "40000000-0000-4000-8000-000000000004",
    previousEventHash: assignedHash,
    payload: {
      assignmentReceipt,
      assignmentValidation: {
        uri: `release-state://${namespace}/evidence/${"a".repeat(64)}`,
        sha256: "a".repeat(64),
      },
      productionProbe: {
        uri: `release-state://${namespace}/evidence/${"b".repeat(64)}`,
        sha256: "b".repeat(64),
      },
      targetBinding,
    },
    evidenceRefs: [
      {
        uri: `release-state://${namespace}/events/3/${assignedHash}`,
        sha256: assignedHash,
      },
    ],
    approvalRefs: [],
  });
  const validatedHash = hashReleaseEvent(validated);
  const pendingAcceptance = { operationId, standardBinding: targetBinding };
  const observation = createReleaseEvent({
    namespace,
    sequence: 5,
    eventType: "observation-started",
    operationId,
    appendId: "50000000-0000-4000-8000-000000000005",
    previousEventHash: validatedHash,
    payload: { pendingAcceptance },
    evidenceRefs: [],
    approvalRefs: [],
  });
  const observationHash = hashReleaseEvent(observation);
  return {
    head: { sequence: 5, eventHash: observationHash },
    snapshot: { pendingOperation, pendingAcceptance },
    records: [
      { sequence: 1, eventHash: initializedHash, event: initialized },
      { sequence: 2, eventHash: preparedHash, event: prepared },
      { sequence: 3, eventHash: assignedHash, event: assigned },
      { sequence: 4, eventHash: validatedHash, event: validated },
      { sequence: 5, eventHash: observationHash, event: observation },
    ],
  };
};

const putPreInitializationChain = async (store) => {
  const references = [];
  let predecessor = null;
  for (const gate of FORMAL_PHASE_EXIT_GATES.slice(0, 3)) {
    const stored = await putPhaseExitAttestation({
      store,
      attestation: buildPhaseExitAttestation({
        namespace,
        gate,
        sourceSha,
        subject: subjectFor(gate, null),
        authorities: authoritySet(gate),
        predecessor,
        issuedAt,
      }),
    });
    references.push(stored.reference);
    predecessor = stored.reference;
  }
  return references;
};

test("builds, stores, and reads one canonical closed phase exit attestation", async () => {
  const store = createStore();
  const attestation = buildPhaseExitAttestation({
    namespace,
    gate: "P0-BASELINE",
    sourceSha,
    subject: subjectFor("P0-BASELINE", null),
    authorities: authoritySet("P0-BASELINE"),
    predecessor: null,
    issuedAt,
  });
  const published = await putPhaseExitAttestation({ store, attestation });
  assert.equal(published.receipt.mediaType, PHASE_EXIT_ATTESTATION_MEDIA_TYPE);
  const readback = await readPhaseExitAttestation({
    store,
    reference: published.reference,
  });
  assert.deepEqual(readback.attestation, attestation);
  const chain = await validatePhaseExitAttestationChain({
    store,
    head: published.reference,
    current: currentFixture(),
    currentSourceSha: sourceSha,
  });
  assert.deepEqual(
    chain.map(({ attestation: value }) => value.gate),
    ["P0-BASELINE"],
  );
});

test("rejects missing, extra, reordered, and cross-gate authority sets", () => {
  const base = buildPhaseExitAttestation({
    namespace,
    gate: "P0-TOOLCHAIN",
    sourceSha,
    subject: subjectFor("P0-TOOLCHAIN", null),
    authorities: authoritySet("P0-TOOLCHAIN"),
    predecessor: {
      uri: `release-state://${namespace}/evidence/${"e".repeat(64)}`,
      sha256: "e".repeat(64),
    },
    issuedAt,
  });
  for (const authorities of [
    base.authorities.slice(0, 1),
    [...base.authorities, base.authorities[0]],
    [...base.authorities].reverse(),
    [
      base.authorities[0],
      { ...base.authorities[1], id: "physical-performance" },
    ],
  ]) {
    assert.throws(
      () => assertPhaseExitAttestation({ ...base, authorities }),
      /authority set/u,
    );
  }
});

test("validates historical subject heads and rejects history tampering", async () => {
  const store = createStore();
  const current = currentFixture();
  let predecessor = null;
  let head = null;
  for (const gate of FORMAL_PHASE_EXIT_GATES.slice(0, 5)) {
    const subjectHead =
      gate === "P0-DATA"
        ? {
            sequence: current.records[0].sequence,
            eventHash: current.records[0].eventHash,
          }
        : current.head;
    const supportingEvent =
      FORMAL_PHASE_EXIT_GATES.indexOf(gate) < 3
        ? null
        : derivePhaseExitSupportingEvent({
            current,
            gate,
            sourceSha,
            subjectHead,
          });
    const attestation = buildPhaseExitAttestation({
      namespace,
      gate,
      sourceSha,
      subject: subjectFor(gate, subjectHead, sourceSha, supportingEvent),
      authorities: authoritySet(gate),
      predecessor,
      issuedAt,
    });
    const stored = await putPhaseExitAttestation({ store, attestation });
    predecessor = stored.reference;
    head = stored.reference;
  }
  const chain = await validatePhaseExitAttestationChain({
    store,
    head,
    current,
    currentSourceSha: sourceSha,
    isSourceAncestor: fixtureIsAncestor,
  });
  assert.equal(chain.at(-1).attestation.gate, "P0-PROMOTE");
  await assert.rejects(
    validatePhaseExitAttestationChain({
      store,
      head,
      current: {
        ...current,
        records: [{ sequence: 1, eventHash: "0".repeat(64) }],
      },
      currentSourceSha: sourceSha,
      isSourceAncestor: fixtureIsAncestor,
    }),
    /not an ancestor/u,
  );
});

test("CAS-appends the complete 16-gate chain through semantic release history and P8 floor activation", async () => {
  const store = createStore();
  const preInitialization = await putPreInitializationChain(store);
  const seed = await validatePreInitializationPhaseExitSeed({
    store,
    references: preInitialization,
    currentSourceSha: sourceSha,
    isSourceAncestor: fixtureIsAncestor,
  });
  let referenceCounter = 1000;
  const immutableReference = (label) => {
    referenceCounter += 1;
    const sha256 = sha256Bytes(
      Buffer.from(`${label}:${referenceCounter}`, "utf8"),
    );
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
    };
  };
  const policyReference = immutableReference("release-policy");
  const databaseCompatibility = {
    contractUri: "urn:event-shopping-planner:test:db:v1",
    fingerprint: "6".repeat(64),
  };
  const binding = ({
    bindingId,
    role,
    bindingSourceSha = sourceSha,
    legacy = false,
    artifactArchive = immutableReference(`${bindingId}:archive`),
    packageIndex = immutableReference(`${bindingId}:package`),
    deploymentId = `deployment:${bindingId}`,
  }) => ({
    bindingId,
    sourceSha: bindingSourceSha,
    buildId: bindingSourceSha,
    variantId: sha256Bytes(Buffer.from(`${bindingId}:variant`, "utf8")),
    releaseRole: role,
    publicIdentityKind: legacy ? "legacy-bootstrap-v1" : "release-identity-v1",
    providerProjectId: "project-phase-attestation",
    providerDeploymentId: deploymentId,
    deploymentUrl: `https://${sha256Bytes(Buffer.from(bindingId)).slice(0, 12)}.example.test`,
    artifactArchive,
    artifactArchiveAvailability: immutableReference(
      `${bindingId}:availability`,
    ),
    packageIndex,
    artifactManifest: immutableReference(`${bindingId}:manifest`),
    providerEvidence: immutableReference(`${bindingId}:provider-evidence`),
    releasePolicy: policyReference,
    providerPolicy: immutableReference(`${bindingId}:provider-policy`),
    providerConfigurationHash: sha256Bytes(
      Buffer.from(`${bindingId}:provider-configuration`, "utf8"),
    ),
    requiredDbCompatibility: databaseCompatibility,
  });
  const bootstrap = binding({
    bindingId: "bootstrap:candidate",
    role: "containment",
    bindingSourceSha: bootstrapSourceSha,
    legacy: true,
    artifactArchive: {
      uri: `release-state://${namespace}/evidence/${"8".repeat(64)}`,
      sha256: "8".repeat(64),
    },
    packageIndex: {
      uri: `release-state://${namespace}/evidence/${"9".repeat(64)}`,
      sha256: "9".repeat(64),
    },
    deploymentId: "bootstrap-recovery-1",
  });
  let approvalCounter = 0;
  const approval = (operationId, role) => {
    approvalCounter += 1;
    const evidence = immutableReference(
      `${operationId}:${role}:${approvalCounter}`,
    );
    const issuerReceipt = immutableReference(
      `${operationId}:issuer:${approvalCounter}`,
    );
    return {
      ...evidence,
      approvalId: `approval-${approvalCounter}`,
      operationId,
      subjectSha256: sha256Bytes(Buffer.from(`${operationId}:subject`)),
      trustedIssuer: "https://token.actions.githubusercontent.com",
      issuerReceiptUri: issuerReceipt.uri,
      issuerReceiptSha256: issuerReceipt.sha256,
      workflowRunId: String(90_000 + approvalCounter),
      protectedEnvironment: "foundation-release-state",
      providerReviewerId: `reviewer-${approvalCounter}`,
      role,
      decision: "APPROVED",
      approvedAt: issuedAt,
    };
  };
  let current = null;
  const appendEvent = (event) => {
    const snapshot = reduceReleaseState(current?.snapshot ?? null, event);
    const eventHash = hashReleaseEvent(event);
    const record = {
      sequence: event.sequence,
      eventHash,
      previousHash: event.previousEventHash,
      committedAt: issuedAt,
      event,
    };
    current = {
      head: { sequence: event.sequence, eventHash },
      snapshot,
      records: [...(current?.records ?? []), record],
    };
    return record;
  };
  const createAndAppend = ({
    eventType,
    operationId,
    payload,
    evidenceRefs = [],
    approvalRefs = [],
  }) =>
    appendEvent(
      createReleaseEvent({
        namespace,
        sequence: (current?.head.sequence ?? 0) + 1,
        eventType,
        operationId,
        previousEventHash: current?.head.eventHash ?? null,
        payload,
        evidenceRefs,
        approvalRefs,
      }),
    );
  const initial = createAndAppend({
    eventType: "state-initialized",
    operationId: "initialize:complete-chain",
    payload: {
      acceptedGate: null,
      executorSourceSha: sourceSha,
      legacyObservedProduction: {
        observationUri: immutableReference("legacy-observation").uri,
        observationSha256: immutableReference("legacy-observation-hash").sha256,
      },
      bootstrapRecovery: bootstrap,
      minimumSafetyFloors: {
        releaseChannel: "release-a",
        legacyLocalStorageCleanup: "forced-off",
      },
      currentDbCompatibility: databaseCompatibility,
      activeReleasePolicy: policyReference,
      phaseExitAttestationSeed: seed,
    },
    evidenceRefs: seed.map(({ attestation }) => attestation),
  });
  store.compareAndAppend = async ({
    expectedSequence,
    expectedHash,
    event,
  }) => {
    assert.equal(expectedSequence, current.head.sequence);
    assert.equal(expectedHash, current.head.eventHash);
    const record = appendEvent(event);
    return {
      namespace,
      sequence: record.sequence,
      eventHash: record.eventHash,
      replayed: false,
    };
  };
  const chainReferences = [...preInitialization];
  const subjectByGate = new Map();
  const appendAttestation = async (gate, subjectHead) => {
    const supportingEvent = derivePhaseExitSupportingEvent({
      current,
      gate,
      sourceSha,
      subjectHead,
    });
    const subject = subjectFor(gate, subjectHead, sourceSha, supportingEvent);
    subjectByGate.set(gate, subject);
    const stored = await putPhaseExitAttestation({
      store,
      attestation: buildPhaseExitAttestation({
        namespace,
        gate,
        sourceSha,
        subject,
        authorities: authoritySet(gate),
        predecessor: chainReferences.at(-1),
        issuedAt,
      }),
    });
    const gateIndex = FORMAL_PHASE_EXIT_GATES.indexOf(gate);
    await appendPhaseExitAttestation(
      {
        store,
        attestationReference: stored.reference,
        operationId: `attest:${gate}`,
        appendId:
          `90000000-0000-4000-8000-` + String(gateIndex + 1).padStart(12, "0"),
        currentSourceSha: sourceSha,
        isSourceAncestor: fixtureIsAncestor,
      },
      { readState: async () => current },
    );
    chainReferences.push(stored.reference);
    return stored.reference;
  };
  await appendAttestation("P0-DATA", {
    sequence: initial.sequence,
    eventHash: initial.eventHash,
  });

  const headReference = () => ({
    uri:
      `release-state://${namespace}/events/${current.head.sequence}/` +
      current.head.eventHash,
    sha256: current.head.eventHash,
  });
  const preparePromotion = (gate, ordinal) => {
    const operationId = `promote:${gate}`;
    const standard = binding({
      bindingId:
        gate === "P0-PROMOTE" ? "binding:P0-PROMOTE" : `binding:${gate}`,
      role: "standard",
    });
    const companion = {
      ...binding({
        bindingId: `companion:${gate}`,
        role: "containment",
      }),
      providerPolicy: standard.providerPolicy,
      providerConfigurationHash: standard.providerConfigurationHash,
    };
    const preparationApprovals = [
      approval(operationId, "releaseOwner"),
      approval(operationId, "dataSafetyReviewer"),
    ];
    const pendingOperation = {
      operationId,
      kind: "promote-standard",
      expectedState: { ...current.head },
      targetBinding: standard,
      originBinding: null,
      originCompanionBinding: null,
      companionBinding: companion,
      previousBinding: current.snapshot.activeProduction,
      emergencyRecoveryBinding: current.snapshot.bootstrapRecovery,
      approvalRefs: preparationApprovals,
      preparedAt: issuedAt,
    };
    const prepared = createAndAppend({
      eventType: "promotion-prepared",
      operationId,
      payload: { pendingOperation },
      evidenceRefs: [immutableReference(`${operationId}:preparation`)],
      approvalRefs: preparationApprovals,
    });
    const assignmentReceipt = immutableReference(`${operationId}:assignment`);
    const assigned = createAndAppend({
      eventType: "deployment-assigned",
      operationId,
      payload: {
        assignmentReceipt,
        promotionReceipt: immutableReference(`${operationId}:promotion`),
        targetBinding: standard,
      },
      evidenceRefs: [
        {
          uri:
            `release-state://${namespace}/events/${prepared.sequence}/` +
            prepared.eventHash,
          sha256: prepared.eventHash,
        },
      ],
    });
    createAndAppend({
      eventType: "assignment-validated",
      operationId,
      payload: {
        assignmentReceipt,
        assignmentValidation: immutableReference(
          `${operationId}:assignment-validation`,
        ),
        productionProbe: immutableReference(`${operationId}:probe`),
        targetBinding: standard,
      },
      evidenceRefs: [
        {
          uri:
            `release-state://${namespace}/events/${assigned.sequence}/` +
            assigned.eventHash,
          sha256: assigned.eventHash,
        },
      ],
    });
    createAndAppend({
      eventType: "observation-started",
      operationId,
      payload: {
        pendingAcceptance: {
          operationId,
          standardBinding: standard,
          companionBinding: companion,
          assignmentValidationEvidence: immutableReference(
            `${operationId}:validation-evidence`,
          ),
          observationStartedEvent: immutableReference(
            `${operationId}:observation`,
          ),
          observationNotBefore: "2026-08-01T00:00:00.000Z",
          minimumObservationEndsAt: "2026-08-02T00:00:00.000Z",
        },
      },
      evidenceRefs: [headReference()],
    });
    return { operationId, standard, companion, ordinal };
  };
  let promotion = preparePromotion("P0-PROMOTE", 0);
  await appendAttestation("P0-PROMOTE", { ...current.head });

  for (const [index, gate] of FORMAL_PHASE_EXIT_GATES.slice(5).entries()) {
    if (index > 0) {
      promotion = preparePromotion(gate, index);
    }
    const acceptanceApprovals = [
      approval(promotion.operationId, "releaseOwner"),
      approval(promotion.operationId, "dataSafetyReviewer"),
      approval(promotion.operationId, "operationsReviewer"),
    ];
    const floors = { pwaLifecycle: "legacy-auto-update-v1" };
    const inventory = [
      {
        binding: promotion.standard,
        acceptedEvent: immutableReference(`${gate}:accepted-inventory`),
        acceptedGate: gate,
        acceptedStandardFloors: floors,
        evaluatedPolicy: policyReference,
        eligibleActions: ["package-redeploy", "rollback"],
        eligibility: "eligible",
        reasonCodes: [],
      },
    ];
    createAndAppend({
      eventType: "release-accepted",
      operationId: promotion.operationId,
      payload: {
        acceptedGate: gate,
        releaseRole: "standard",
        observedThrough: "2026-08-02T00:00:01.000Z",
        acceptedStandardFloors: floors,
        rollbackInventory: inventory,
        clearBootstrapRecovery: false,
      },
      evidenceRefs: [immutableReference(`${gate}:acceptance-evidence`)],
      approvalRefs: acceptanceApprovals,
    });
    if (gate === "P8-CLEAN") {
      const floorOperationId = "activate:P8-CLEAN:minimum-floor";
      const floorApprovals = [
        approval(floorOperationId, "releaseOwner"),
        approval(floorOperationId, "dataSafetyReviewer"),
        approval(floorOperationId, "operationsReviewer"),
      ];
      const closureBundle = immutableReference("p8:closure-bundle");
      const closureEvidenceRefs = Array.from({ length: 5 }, (_, ordinal) =>
        immutableReference(`p8:closure:${ordinal}`),
      );
      createAndAppend({
        eventType: "policy-activated",
        operationId: floorOperationId,
        payload: {
          activationGate: "P8-CLEAN",
          previousReleasePolicy: policyReference,
          proposedReleasePolicy: policyReference,
          activeReleasePolicy: policyReference,
          behaviorDimensionChange: null,
          minimumSafetyFloorChange: { styleSrcAttr: "none" },
          minimumSafetyFloors: {
            ...current.snapshot.minimumSafetyFloors,
            styleSrcAttr: "none",
          },
          activePolicyCompatibility: [],
          closureBundle,
          closureEvidenceRefs,
          rollbackInventory: inventory,
        },
        evidenceRefs: [closureBundle, ...closureEvidenceRefs],
        approvalRefs: floorApprovals,
      });
    }
    await appendAttestation(gate, { ...current.head });
  }

  const chain = await validatePhaseExitAttestationChain({
    store,
    head: chainReferences.at(-1),
    current,
    currentSourceSha: sourceSha,
    isSourceAncestor: fixtureIsAncestor,
  });
  assert.deepEqual(
    chain.map(({ attestation }) => attestation.gate),
    FORMAL_PHASE_EXIT_GATES,
  );
  assert.deepEqual(
    readPhaseExitAttestationLedger(current).map(({ gate }) => gate),
    FORMAL_PHASE_EXIT_GATES,
  );
  assert.deepEqual(
    replayReleaseEvents(current.records.map(({ event }) => event)),
    current.snapshot,
  );
  assert.equal(
    current.records.some(
      ({ event }) =>
        event.eventType === "policy-activated" &&
        event.payload.activationGate === "P8-CLEAN",
    ),
    true,
  );

  const skipped = await putPhaseExitAttestation({
    store,
    attestation: buildPhaseExitAttestation({
      namespace,
      gate: "P0-RELEASE",
      sourceSha,
      subject: subjectByGate.get("P0-RELEASE"),
      authorities: authoritySet("P0-RELEASE"),
      predecessor: chainReferences[3],
      issuedAt,
    }),
  });
  await assert.rejects(
    validatePhaseExitAttestationChain({
      store,
      head: skipped.reference,
      current,
      currentSourceSha: sourceSha,
      isSourceAncestor: fixtureIsAncestor,
    }),
    /skips or reorders/u,
  );
  await assert.rejects(
    appendPhaseExitAttestation(
      {
        store,
        attestationReference: chainReferences.at(-1),
        operationId: "attest:P8-CLEAN:duplicate",
        appendId: "a0000000-0000-4000-8000-000000000001",
        currentSourceSha: sourceSha,
        isSourceAncestor: fixtureIsAncestor,
      },
      { readState: async () => current },
    ),
    /does not bind the live Release State head|does not extend/u,
  );
});

test("P0-DATA binds distinct ancestor bootstrap and executor sources to exact initialization history", async () => {
  const store = createStore();
  const current = currentFixture();
  const references = await putPreInitializationChain(store);
  const subjectHead = {
    sequence: current.records[0].sequence,
    eventHash: current.records[0].eventHash,
  };
  const supportingEvent = derivePhaseExitSupportingEvent({
    current,
    gate: "P0-DATA",
    sourceSha,
    subjectHead,
  });
  const subject = subjectFor(
    "P0-DATA",
    subjectHead,
    sourceSha,
    supportingEvent,
  );
  const stored = await putPhaseExitAttestation({
    store,
    attestation: buildPhaseExitAttestation({
      namespace,
      gate: "P0-DATA",
      sourceSha,
      subject,
      authorities: authoritySet("P0-DATA"),
      predecessor: references.at(-1),
      issuedAt,
    }),
  });
  const chain = await validatePhaseExitAttestationChain({
    store,
    head: stored.reference,
    current,
    currentSourceSha: sourceSha,
    isSourceAncestor: fixtureIsAncestor,
  });
  assert.equal(
    chain.at(-1).attestation.subject.bootstrapSourceSha,
    bootstrapSourceSha,
  );

  await assert.rejects(
    validatePhaseExitAttestationChain({
      store,
      head: stored.reference,
      current,
      currentSourceSha: sourceSha,
      isSourceAncestor: async (ancestor, descendant) => ancestor === descendant,
    }),
    /bootstrap source is not repository ancestry/u,
  );

  const substituted = structuredClone(subject);
  substituted.supportingEvent.bindingId = "bootstrap:substituted";
  const substitutedStored = await putPhaseExitAttestation({
    store,
    attestation: buildPhaseExitAttestation({
      namespace,
      gate: "P0-DATA",
      sourceSha,
      subject: substituted,
      authorities: authoritySet("P0-DATA"),
      predecessor: references.at(-1),
      issuedAt,
    }),
  });
  await assert.rejects(
    validatePhaseExitAttestationChain({
      store,
      head: substitutedStored.reference,
      current,
      currentSourceSha: sourceSha,
      isSourceAncestor: fixtureIsAncestor,
    }),
    /differs from exact history/u,
  );

  assert.throws(
    () =>
      buildPhaseExitAttestation({
        namespace,
        gate: "P0-DATA",
        sourceSha,
        subject: {
          ...subject,
          releaseStateHead: { ...current.head },
        },
        authorities: authoritySet("P0-DATA"),
        predecessor: references.at(-1),
        issuedAt,
      }),
    /supporting event schema/u,
  );
});

test("P0-PROMOTE rejects reconciliation, abort, and historical lifecycle substitution", () => {
  const current = currentFixture();
  const premature = structuredClone(current);
  premature.records.pop();
  premature.head = {
    sequence: premature.records.at(-1).sequence,
    eventHash: premature.records.at(-1).eventHash,
  };
  premature.snapshot.pendingAcceptance = null;
  assert.throws(
    () =>
      derivePhaseExitSupportingEvent({
        current: premature,
        gate: "P0-PROMOTE",
        sourceSha,
        subjectHead: premature.head,
      }),
    /exact supporting event is absent/u,
  );

  const reconciled = structuredClone(current);
  reconciled.snapshot.pendingOperation.reconciliationAuthority = {
    reconciliationKind: "provider-target-assigned/v1",
    providerObservation: {
      uri: `release-state://${namespace}/evidence/${"c".repeat(64)}`,
      sha256: "c".repeat(64),
    },
    stateReconciled: {
      uri: `release-state://${namespace}/events/3/${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    },
  };
  assert.throws(
    () =>
      derivePhaseExitSupportingEvent({
        current: reconciled,
        gate: "P0-PROMOTE",
        sourceSha,
        subjectHead: reconciled.head,
      }),
    /exact supporting event is absent/u,
  );

  const aborted = structuredClone(current);
  aborted.snapshot.pendingOperation = null;
  assert.throws(
    () =>
      derivePhaseExitSupportingEvent({
        current: aborted,
        gate: "P0-PROMOTE",
        sourceSha,
        subjectHead: aborted.head,
      }),
    /exact supporting event is absent/u,
  );
});

test("append rederives the latest support and rejects a premature handcrafted attestation", async () => {
  const store = createStore();
  const preInitialization = await putPreInitializationChain(store);
  const current = currentFixture();
  const initializationHead = {
    sequence: current.records[0].sequence,
    eventHash: current.records[0].eventHash,
  };
  const dataSupport = derivePhaseExitSupportingEvent({
    current,
    gate: "P0-DATA",
    sourceSha,
    subjectHead: initializationHead,
  });
  const data = await putPhaseExitAttestation({
    store,
    attestation: buildPhaseExitAttestation({
      namespace,
      gate: "P0-DATA",
      sourceSha,
      subject: subjectFor(
        "P0-DATA",
        initializationHead,
        sourceSha,
        dataSupport,
      ),
      authorities: authoritySet("P0-DATA"),
      predecessor: preInitialization.at(-1),
      issuedAt,
    }),
  });
  const support = derivePhaseExitSupportingEvent({
    current,
    gate: "P0-PROMOTE",
    sourceSha,
    subjectHead: current.head,
  });
  const premature = structuredClone(current);
  premature.records.pop();
  premature.head = {
    sequence: premature.records.at(-1).sequence,
    eventHash: premature.records.at(-1).eventHash,
  };
  premature.snapshot.pendingAcceptance = null;
  const forged = await putPhaseExitAttestation({
    store,
    attestation: buildPhaseExitAttestation({
      namespace,
      gate: "P0-PROMOTE",
      sourceSha,
      subject: subjectFor("P0-PROMOTE", premature.head, sourceSha, support),
      authorities: authoritySet("P0-PROMOTE"),
      predecessor: data.reference,
      issuedAt,
    }),
  });
  await assert.rejects(
    appendPhaseExitAttestation(
      {
        store,
        attestationReference: forged.reference,
        operationId: "attest:premature",
        appendId: "80000000-0000-4000-8000-000000000008",
        currentSourceSha: sourceSha,
        isSourceAncestor: fixtureIsAncestor,
      },
      { readState: async () => premature },
    ),
    /exact current supporting event/u,
  );
});

test("release exit rejects rollback rewrapping of a historical acceptance", () => {
  const binding = { bindingId: "binding:P0-RELEASE", sourceSha };
  const operationId = "accept:fixture";
  const observation = createReleaseEvent({
    namespace,
    sequence: 1,
    eventType: "observation-started",
    operationId,
    appendId: "50000000-0000-4000-8000-000000000005",
    previousEventHash: null,
    payload: { pendingAcceptance: { standardBinding: binding } },
    evidenceRefs: [],
    approvalRefs: [],
  });
  const observationHash = hashReleaseEvent(observation);
  const accepted = createReleaseEvent({
    namespace,
    sequence: 2,
    eventType: "release-accepted",
    operationId,
    appendId: "60000000-0000-4000-8000-000000000006",
    previousEventHash: observationHash,
    payload: { acceptedGate: "P0-RELEASE" },
    evidenceRefs: [],
    approvalRefs: [],
  });
  const acceptedHash = hashReleaseEvent(accepted);
  const acceptedReference = {
    uri: `release-state://${namespace}/events/2/${acceptedHash}`,
    sha256: acceptedHash,
  };
  const current = {
    head: { sequence: 2, eventHash: acceptedHash },
    snapshot: {
      acceptedGate: "P0-RELEASE",
      acceptedStandard: binding,
      acceptedStandardEvent: acceptedReference,
      activeProduction: binding,
      pendingOperation: null,
      pendingAcceptance: null,
      containmentIncident: null,
      standardRecovery: null,
    },
    records: [
      { sequence: 1, eventHash: observationHash, event: observation },
      { sequence: 2, eventHash: acceptedHash, event: accepted },
    ],
  };
  assert.doesNotThrow(() =>
    derivePhaseExitSupportingEvent({
      current,
      gate: "P0-RELEASE",
      sourceSha,
      subjectHead: current.head,
    }),
  );

  const rollback = createReleaseEvent({
    namespace,
    sequence: 3,
    eventType: "rollback-activated",
    operationId: "rollback:fixture",
    appendId: "70000000-0000-4000-8000-000000000007",
    previousEventHash: acceptedHash,
    payload: {},
    evidenceRefs: [],
    approvalRefs: [],
  });
  const rollbackHash = hashReleaseEvent(rollback);
  const restored = structuredClone(current);
  restored.head = { sequence: 3, eventHash: rollbackHash };
  restored.records.push({
    sequence: 3,
    eventHash: rollbackHash,
    event: rollback,
  });
  assert.throws(
    () =>
      derivePhaseExitSupportingEvent({
        current: restored,
        gate: "P0-RELEASE",
        sourceSha,
        subjectHead: restored.head,
      }),
    /current idle accepted binding/u,
  );
});

test("rejects forked source ancestry, time regression, and subject-head regression", async (t) => {
  await t.test("forked source ancestry", async () => {
    const store = createStore();
    const firstSource = "a".repeat(40);
    const siblingSource = "b".repeat(40);
    const currentSource = "c".repeat(40);
    const first = await putPhaseExitAttestation({
      store,
      attestation: buildPhaseExitAttestation({
        namespace,
        gate: "P0-BASELINE",
        sourceSha: firstSource,
        subject: subjectFor("P0-BASELINE", null, firstSource),
        authorities: authoritySet("P0-BASELINE"),
        predecessor: null,
        issuedAt,
      }),
    });
    const second = await putPhaseExitAttestation({
      store,
      attestation: buildPhaseExitAttestation({
        namespace,
        gate: "P0-TOOLCHAIN",
        sourceSha: siblingSource,
        subject: subjectFor("P0-TOOLCHAIN", null, siblingSource),
        authorities: authoritySet("P0-TOOLCHAIN"),
        predecessor: first.reference,
        issuedAt,
      }),
    });
    await assert.rejects(
      validatePhaseExitAttestationChain({
        store,
        head: second.reference,
        current: currentFixture(),
        currentSourceSha: currentSource,
        isSourceAncestor: async (ancestor, descendant) =>
          ancestor === descendant || descendant === currentSource,
      }),
      /forks from its predecessor history/u,
    );
  });

  await t.test("time regression", async () => {
    const store = createStore();
    const first = await putPhaseExitAttestation({
      store,
      attestation: buildPhaseExitAttestation({
        namespace,
        gate: "P0-BASELINE",
        sourceSha,
        subject: subjectFor("P0-BASELINE", null),
        authorities: authoritySet("P0-BASELINE"),
        predecessor: null,
        issuedAt: "2026-08-09T00:00:01.000Z",
      }),
    });
    const second = await putPhaseExitAttestation({
      store,
      attestation: buildPhaseExitAttestation({
        namespace,
        gate: "P0-TOOLCHAIN",
        sourceSha,
        subject: subjectFor("P0-TOOLCHAIN", null),
        authorities: authoritySet("P0-TOOLCHAIN"),
        predecessor: first.reference,
        issuedAt,
      }),
    });
    await assert.rejects(
      validatePhaseExitAttestationChain({
        store,
        head: second.reference,
        current: currentFixture(),
        currentSourceSha: sourceSha,
      }),
      /attestation time regresses/u,
    );
  });

  await t.test("subject predates supporting event", () => {
    const current = currentFixture();
    const supportingEvent = derivePhaseExitSupportingEvent({
      current,
      gate: "P0-PROMOTE",
      sourceSha,
      subjectHead: current.head,
    });
    assert.throws(
      () =>
        buildPhaseExitAttestation({
          namespace,
          gate: "P0-PROMOTE",
          sourceSha,
          subject: subjectFor(
            "P0-PROMOTE",
            {
              sequence: current.records[0].sequence,
              eventHash: current.records[0].eventHash,
            },
            sourceSha,
            supportingEvent,
          ),
          authorities: authoritySet("P0-PROMOTE"),
          predecessor: {
            uri: `release-state://${namespace}/evidence/${"e".repeat(64)}`,
            sha256: "e".repeat(64),
          },
          issuedAt,
        }),
      /supporting event schema|predates/u,
    );
  });
});

test("readback rejects a wrong immutable media type", async () => {
  const store = createStore();
  const attestation = buildPhaseExitAttestation({
    namespace,
    gate: "P0-BASELINE",
    sourceSha,
    subject: subjectFor("P0-BASELINE", null),
    authorities: authoritySet("P0-BASELINE"),
    predecessor: null,
    issuedAt,
  });
  const bytes = canonicalJsonBytes(attestation);
  const sha256 = sha256Bytes(bytes);
  store.objects.set(sha256, {
    bytes,
    mediaType: "application/json",
    committedAt: issuedAt,
  });
  await assert.rejects(
    readPhaseExitAttestation({
      store,
      reference: {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
      },
    }),
    /mistyped/u,
  );
});

test("validates the exact pre-initialization chain and replays its seeded ledger", async () => {
  const store = createStore();
  const references = await putPreInitializationChain(store);
  const seed = await validatePreInitializationPhaseExitSeed({
    store,
    references,
    currentSourceSha: sourceSha,
    isSourceAncestor: async (ancestor, descendant) => ancestor === descendant,
  });
  assert.deepEqual(
    seed.map(({ gate }) => gate),
    FORMAL_PHASE_EXIT_GATES.slice(0, 3),
  );
  const eventHash = "f".repeat(64);
  const ledger = readPhaseExitAttestationLedger({
    records: [
      {
        sequence: 1,
        eventHash,
        event: {
          namespace,
          eventType: "state-initialized",
          payload: { phaseExitAttestationSeed: seed },
        },
      },
    ],
  });
  assert.deepEqual(
    ledger.map(({ gate }) => gate),
    FORMAL_PHASE_EXIT_GATES.slice(0, 3),
  );
  assert.ok(ledger.every(({ event }) => event.sha256 === eventHash));
});

test("rejects unseeded, reordered, substituted, and tampered initialization history", async () => {
  const store = createStore();
  const references = await putPreInitializationChain(store);
  for (const invalidReferences of [
    references.slice(0, 2),
    [references[1], references[0], references[2]],
    [references[0], references[2], references[1]],
  ]) {
    await assert.rejects(
      validatePreInitializationPhaseExitSeed({
        store,
        references: invalidReferences,
        currentSourceSha: sourceSha,
        isSourceAncestor: async (ancestor, descendant) =>
          ancestor === descendant,
      }),
      /three distinct|skips|reorders|substitutes|chain/u,
    );
  }
  const finalStored = store.objects.get(references[2].sha256);
  store.objects.set(references[2].sha256, {
    ...finalStored,
    bytes: Buffer.concat([finalStored.bytes, Buffer.from(" ")]),
  });
  await assert.rejects(
    validatePreInitializationPhaseExitSeed({
      store,
      references,
      currentSourceSha: sourceSha,
      isSourceAncestor: async (ancestor, descendant) => ancestor === descendant,
    }),
    /tampered/u,
  );
  assert.throws(
    () =>
      readPhaseExitAttestationLedger({
        records: [
          {
            sequence: 1,
            eventHash: "f".repeat(64),
            event: {
              namespace,
              eventType: "state-initialized",
              payload: {},
            },
          },
        ],
      }),
    /seed is invalid/u,
  );
});

test("CLI closes predecessor input at the pre-initialization gate boundary", () => {
  const common = [
    "--namespace",
    namespace,
    "--source-sha",
    sourceSha,
    "--operation-id",
    "phase-exit:fixture",
    "--output",
    "phase-exit.json",
  ];
  const argumentsFor = (gate, predecessor = null) => [
    ...common,
    "--target-gate",
    gate,
    ...(predecessor === null
      ? []
      : ["--predecessor-attestation-sha256", predecessor]),
  ];
  assert.equal(
    parsePhaseExitAttestationArguments(
      argumentsFor("P0-TOOLCHAIN", "a".repeat(64)),
    ).predecessorAttestationSha256,
    "a".repeat(64),
  );
  assert.throws(
    () => parsePhaseExitAttestationArguments(argumentsFor("P0-TOOLCHAIN")),
    /incomplete or invalid/u,
  );
  assert.throws(
    () =>
      parsePhaseExitAttestationArguments(
        argumentsFor("P0-DATA", "a".repeat(64)),
      ),
    /incomplete or invalid/u,
  );
});
