import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, sha256Bytes } from "./lib/canonical-json.mjs";
import { ACCEPTANCE_PERFORMANCE_REQUIREMENTS } from "./lib/performance-evidence-identity.mjs";
import {
  assertPhaseExitReadinessManifest,
  buildPhaseExitReadiness,
  resolveRepositoryPhaseExitReadiness,
} from "./lib/phase-exit-readiness.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./release-state/releaseStateReducer.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_REQUIRED_AUTHORITIES,
  RELEASE_PHASE_GATES,
} from "./release-state/phaseGates.mjs";
import {
  PHASE_EXIT_ATTESTATION_MEDIA_TYPE,
  buildPhaseExitAttestation,
} from "./release-state/phaseExitAttestation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositorySourceSha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).stdout.trim();
const manifest = JSON.parse(
  await readFile(
    path.join(root, "config", "phase-exit-readiness.json"),
    "utf8",
  ),
);

const namespace = "phase-readiness-live";
const sourceSha = repositorySourceSha;
const sha = (character) => character.repeat(64);
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: sha("d"),
};
const objectRef = (character) => ({
  uri: `release-state://${namespace}/evidence/${sha(character)}`,
  sha256: sha(character),
});
const policyRef = objectRef("1");
const binding = (role, suffix) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: sha(suffix),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${role}-${suffix}`,
  deploymentUrl: `https://${role}-${suffix}.example.test`,
  artifactArchive: objectRef("7"),
  artifactArchiveAvailability: objectRef("8"),
  packageIndex: objectRef("2"),
  artifactManifest: objectRef("3"),
  providerEvidence: objectRef("4"),
  releasePolicy: policyRef,
  providerPolicy: objectRef("5"),
  providerConfigurationHash: sha("6"),
  requiredDbCompatibility: dbCompatibility,
});
const approval = (operationId, role, suffix) => ({
  uri: `release-state://${namespace}/evidence/${sha(suffix)}`,
  sha256: sha(suffix),
  approvalId: `approval-${suffix}`,
  operationId,
  subjectSha256: sha("7"),
  trustedIssuer: "https://token.actions.githubusercontent.com",
  issuerReceiptUri: `release-state://${namespace}/evidence/${sha("8")}`,
  issuerReceiptSha256: sha("8"),
  workflowRunId: `run-${suffix}`,
  protectedEnvironment: "foundation-release-state",
  providerReviewerId: `reviewer-${suffix}`,
  role,
  decision: "APPROVED",
  approvedAt: "2026-08-01T00:00:00.000Z",
});

const createPreInitializationAttestations = () => {
  const evidence = new Map();
  const seed = [];
  let predecessor = null;
  let nextEvidence = 16;
  for (const gate of FORMAL_PHASE_EXIT_GATES.slice(0, 3)) {
    const subject =
      gate === "P0-ARTIFACT"
        ? {
            kind: "disposable-drill-subject/v1",
            sourceSha: repositorySourceSha,
            drillId: "artifact-drill-readiness",
          }
        : {
            kind: "repository-phase-subject/v1",
            sourceSha: repositorySourceSha,
          };
    const authorities = PHASE_EXIT_REQUIRED_AUTHORITIES[gate].map((id) => {
      const digest = nextEvidence.toString(16).padStart(64, "0");
      nextEvidence += 1;
      return {
        id,
        evidence: [
          {
            uri: `release-state://${namespace}/evidence/${digest}`,
            sha256: digest,
          },
        ],
      };
    });
    const attestation = buildPhaseExitAttestation({
      namespace,
      gate,
      sourceSha: repositorySourceSha,
      subject,
      authorities,
      predecessor,
      issuedAt: "2026-08-02T00:00:00.000Z",
    });
    const bytes = canonicalJsonBytes(attestation);
    const digest = sha256Bytes(bytes);
    const reference = {
      uri: `release-state://${namespace}/evidence/${digest}`,
      sha256: digest,
    };
    evidence.set(digest, {
      bytes,
      mediaType: PHASE_EXIT_ATTESTATION_MEDIA_TYPE,
      committedAt: "2026-08-02T00:00:01.000Z",
    });
    seed.push({
      gate,
      sourceSha: repositorySourceSha,
      subjectKind: subject.kind,
      attestation: reference,
      predecessor,
    });
    predecessor = reference;
  }
  return { evidence, seed };
};

const createLiveReleaseStateFixture = () => {
  const phaseExit = createPreInitializationAttestations();
  const events = [];
  let snapshot = null;
  const append = ({
    eventType,
    operationId,
    payload,
    approvalRefs = [],
    evidenceRefs = [objectRef("9")],
  }) => {
    const sequence = events.length + 1;
    const event = createReleaseEvent({
      namespace,
      sequence,
      eventType,
      operationId,
      appendId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      previousEventHash: snapshot?.eventHash ?? null,
      payload,
      approvalRefs,
      evidenceRefs,
    });
    snapshot = reduceReleaseState(snapshot, event);
    events.push(event);
    return event;
  };
  const currentHeadRef = () => ({
    uri:
      `release-state://${namespace}/events/${snapshot.sequence}/` +
      snapshot.eventHash,
    sha256: snapshot.eventHash,
  });

  const bootstrap = {
    ...binding("containment", "b"),
    publicIdentityKind: "legacy-bootstrap-v1",
  };
  const initialized = append({
    eventType: "state-initialized",
    operationId: "initialize",
    payload: {
      acceptedGate: null,
      executorSourceSha: sourceSha,
      legacyObservedProduction: {
        observationUri: objectRef("c").uri,
        observationSha256: sha("c"),
      },
      bootstrapRecovery: bootstrap,
      minimumSafetyFloors: {
        releaseChannel: "release-a",
        legacyLocalStorageCleanup: "forced-off",
      },
      currentDbCompatibility: dbCompatibility,
      activeReleasePolicy: policyRef,
      phaseExitAttestationSeed: phaseExit.seed,
    },
    evidenceRefs: [
      objectRef("9"),
      ...phaseExit.seed.map(({ attestation }) => attestation),
    ],
  });

  const standard = binding("standard", "e");
  const companion = binding("containment", "f");
  const operationId = "promote-standard-test";
  const preparationApprovals = [
    approval(operationId, "releaseOwner", "a"),
    approval(operationId, "dataSafetyReviewer", "b"),
  ];
  append({
    eventType: "promotion-prepared",
    operationId,
    payload: {
      pendingOperation: {
        operationId,
        kind: "promote-standard",
        expectedState: {
          sequence: snapshot.sequence,
          eventHash: snapshot.eventHash,
        },
        targetBinding: standard,
        originBinding: null,
        originCompanionBinding: null,
        companionBinding: companion,
        previousBinding: null,
        emergencyRecoveryBinding: snapshot.bootstrapRecovery,
        approvalRefs: preparationApprovals,
        preparedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    approvalRefs: preparationApprovals,
  });
  const assignmentReceipt = objectRef("c");
  append({
    eventType: "deployment-assigned",
    operationId,
    payload: {
      assignmentReceipt,
      promotionReceipt: objectRef("d"),
      targetBinding: standard,
    },
    evidenceRefs: [currentHeadRef()],
  });
  const assignmentValidated = append({
    eventType: "assignment-validated",
    operationId,
    payload: {
      assignmentReceipt,
      assignmentValidation: objectRef("e"),
      productionProbe: objectRef("f"),
      targetBinding: standard,
    },
    evidenceRefs: [currentHeadRef()],
  });
  append({
    eventType: "observation-started",
    operationId,
    payload: {
      pendingAcceptance: {
        operationId,
        standardBinding: standard,
        companionBinding: companion,
        assignmentValidationEvidence: objectRef("0"),
        observationStartedEvent: objectRef("f"),
        observationNotBefore: "2026-08-01T00:00:00.000Z",
        minimumObservationEndsAt: "2026-08-02T00:00:00.000Z",
      },
    },
  });
  const acceptanceApprovals = [
    approval(operationId, "releaseOwner", "1"),
    approval(operationId, "dataSafetyReviewer", "2"),
    approval(operationId, "operationsReviewer", "3"),
  ];
  const accepted = append({
    eventType: "release-accepted",
    operationId,
    payload: {
      acceptedGate: "P0-RELEASE",
      releaseRole: "standard",
      observedThrough: "2026-08-02T00:00:01.000Z",
      acceptedStandardFloors: {
        pwaLifecycle: "legacy-auto-update-v1",
      },
      rollbackInventory: [],
      clearBootstrapRecovery: false,
    },
    approvalRefs: acceptanceApprovals,
  });

  const records = events.map((event) => ({
    sequence: event.sequence,
    eventHash: hashReleaseEvent(event),
    previousHash: event.previousEventHash,
    event: structuredClone(event),
    committedAt: "2026-08-03T00:00:00.000Z",
  }));
  const store = {
    namespace,
    async readHead() {
      const last = records.at(-1);
      return { sequence: last.sequence, eventHash: last.eventHash };
    },
    async readEvents({ afterSequence = 0 } = {}) {
      return records
        .filter(({ sequence }) => sequence > afterSequence)
        .map((record) => structuredClone(record));
    },
    async readEvidence({ sha256 }) {
      const stored = phaseExit.evidence.get(sha256);
      return stored === undefined
        ? null
        : { ...stored, bytes: Buffer.from(stored.bytes) };
    },
  };
  return {
    accepted,
    assignmentValidated,
    initialized,
    phaseExitSeed: phaseExit.seed,
    records,
    store,
  };
};

const authority = (report, gate, authorityId) =>
  report.exits
    .find((exit) => exit.gate === gate)
    .authorities.find(({ id }) => id === authorityId);

test("keeps the 16 formal exits separate from the 11 release acceptance gates", () => {
  assert.deepEqual(Object.keys(ACCEPTANCE_PERFORMANCE_REQUIREMENTS), [
    ...FORMAL_PHASE_EXIT_GATES,
  ]);
  assert.deepEqual(FORMAL_PHASE_EXIT_GATES.slice(5), RELEASE_PHASE_GATES);
  assertPhaseExitReadinessManifest(manifest);
});

test("reports the repository-only authority boundary as zero of sixteen", async () => {
  const resolved = await resolveRepositoryPhaseExitReadiness();
  const report = buildPhaseExitReadiness(resolved);
  assert.deepEqual(report.summary, {
    completed: 0,
    total: 16,
    nextExit: "P0-BASELINE",
  });
  assert.equal(report.releaseState, null);
  assert.equal(report.productionActivationReady, false);
  assert.ok(report.exits[1].blockerCodes.includes("prior-exit-incomplete"));
  assert.deepEqual(
    report.exits[0].authorities.map(({ id }) => id),
    manifest.authorities["P0-BASELINE"],
  );
});

test("rejects caller supplied hashes, blockers, and accepted gate", () => {
  const forgedResolution = {
    source: { sha: sourceSha, state: "clean" },
    releaseState: { acceptedGate: "P8-CLEAN" },
    evidenceSha256: [sha("f")],
  };
  assert.throws(
    () => buildPhaseExitReadiness({ manifest, resolution: forgedResolution }),
    /Trusted phase exit authority resolution is required/,
  );
  assert.throws(
    () =>
      buildPhaseExitReadiness({
        manifest,
        resolution: forgedResolution,
        acceptedReleaseGate: "P8-CLEAN",
        directBlockersByGate: new Map(),
        verifiedAuthorityEvidenceByGate: new Map(),
      }),
    /builder options are invalid/,
  );
});

test("resolves live gate authorities only from a replayed store", async () => {
  const fixture = createLiveReleaseStateFixture();
  const resolved = await resolveRepositoryPhaseExitReadiness({
    releaseStateStore: fixture.store,
  });
  const report = buildPhaseExitReadiness(resolved);
  assert.deepEqual(report.releaseState, {
    namespace,
    head: {
      sequence: fixture.records.length,
      eventHash: hashReleaseEvent(fixture.accepted),
    },
    acceptedGate: "P0-RELEASE",
    phaseExitLedger: fixture.phaseExitSeed.map(
      ({ gate, sourceSha: attestedSourceSha, attestation }) => ({
        gate,
        sourceSha: attestedSourceSha,
        attestation,
        event: {
          uri:
            `release-state://${namespace}/events/1/` +
            hashReleaseEvent(fixture.initialized),
          sha256: hashReleaseEvent(fixture.initialized),
        },
      }),
    ),
  });
  assert.deepEqual(authority(report, "P0-DATA", "state-initialized").evidence, [
    {
      uri:
        `release-state://${namespace}/events/1/` +
        hashReleaseEvent(fixture.initialized),
      sha256: hashReleaseEvent(fixture.initialized),
    },
  ]);
  assert.deepEqual(
    authority(report, "P0-PROMOTE", "assignment-validated").evidence,
    [],
  );
  assert.ok(
    report.exits
      .find(({ gate }) => gate === "P0-PROMOTE")
      .blockerCodes.includes(
        "authority-evidence-unobserved:assignment-validated",
      ),
  );
  assert.equal(
    authority(report, "P0-RELEASE", "accepted-gate").evidence[0].sha256,
    hashReleaseEvent(fixture.accepted),
  );
  assert.ok(
    !report.exits
      .find(({ gate }) => gate === "P0-RELEASE")
      .blockerCodes.includes("accepted-gate-unobserved"),
  );
  assert.ok(
    report.exits
      .find(({ gate }) => gate === "P1-PWA")
      .blockerCodes.includes("accepted-gate-unobserved"),
  );
});

test("rejects a manifest sequence or authority drift", () => {
  const reordered = structuredClone(manifest);
  [reordered.formalExitSequence[0], reordered.formalExitSequence[1]] = [
    reordered.formalExitSequence[1],
    reordered.formalExitSequence[0],
  ];
  assert.throws(() => assertPhaseExitReadinessManifest(reordered));
  const unknown = structuredClone(manifest);
  unknown.authorities["P0-BASELINE"].push("caller-claimed-pass");
  assert.throws(() => assertPhaseExitReadinessManifest(unknown));
  const weakened = structuredClone(manifest);
  weakened.authorities["P8-CLEAN"].pop();
  assert.throws(() => assertPhaseExitReadinessManifest(weakened));
});

test("labels a blocked CLI snapshot as a report, never a pass", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-phase-exit-readiness.mjs")],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^REPORT phase exit readiness: 0\/16; blocked;/);
  assert.doesNotMatch(result.stdout, /^PASS/u);
});
