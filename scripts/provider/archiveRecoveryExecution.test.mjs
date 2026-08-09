import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  hashReleaseEvent,
  reduceReleaseState,
} from "../release-state/releaseStateReducer.mjs";
import {
  buildArchiveRecoverySubject,
  prepareArchiveRecovery,
} from "./archiveRecoveryExecution.mjs";
import {
  parseArchiveRecoveryExecutionArguments,
  runArchiveRecoveryExecutionCli,
} from "./execute-archive-recovery.mjs";

const namespace = "archive-execution-test";
const sourceSha = "a".repeat(40);
const committedAt = "2026-08-09T00:00:00.000Z";

const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
  sha256: character.repeat(64),
});

const binding = (releaseRole, suffix, overrides = {}) => ({
  bindingId: `deployment-binding:${releaseRole}:${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: (releaseRole === "standard" ? "1" : "2").repeat(64),
  releaseRole,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${suffix}`,
  deploymentUrl: `https://deployment-${suffix}.example.test`,
  artifactArchive: reference("3"),
  artifactArchiveAvailability: reference("4"),
  packageIndex: reference("5"),
  artifactManifest: reference(releaseRole === "standard" ? "6" : "7"),
  providerEvidence: reference(releaseRole === "standard" ? "8" : "9"),
  releasePolicy: reference("b"),
  providerPolicy: reference("c"),
  providerConfigurationHash: "d".repeat(64),
  requiredDbCompatibility: {
    contractUri: "urn:test:db:v1",
    fingerprint: "e".repeat(64),
  },
  ...overrides,
});

const inventoryEntry = (standard) => ({
  binding: standard,
  acceptedEvent: {
    uri: `release-state://${namespace}/events/6/${"f".repeat(64)}`,
    sha256: "f".repeat(64),
  },
  acceptedGate: "P0-RELEASE",
  acceptedStandardFloors: { pwaLifecycle: "legacy-auto-update-v1" },
  evaluatedPolicy: reference("b"),
  eligibleActions: ["package-redeploy", "rollback"],
  eligibility: "eligible",
  reasonCodes: [],
});

const createCurrent = () => {
  const standard = binding("standard", "origin-standard");
  const companion = binding("containment", "origin-companion");
  const snapshot = {
    namespace,
    sequence: 7,
    eventHash: "0".repeat(64),
    legacyObservedProduction: null,
    activeProduction: null,
    acceptedStandard: standard,
    acceptedStandardEvent: inventoryEntry(standard).acceptedEvent,
    acceptedGate: "P0-RELEASE",
    bootstrapRecovery: null,
    containmentCompanion: companion,
    pendingOperation: null,
    pendingAcceptance: null,
    containmentIncident: null,
    standardRecovery: null,
    rollbackInventory: [inventoryEntry(standard)],
    minimumSafetyFloors: {},
    acceptedStandardFloors: { pwaLifecycle: "legacy-auto-update-v1" },
    currentDbCompatibility: standard.requiredDbCompatibility,
    activeReleasePolicy: standard.releasePolicy,
  };
  return {
    standard,
    companion,
    head: { sequence: snapshot.sequence, eventHash: snapshot.eventHash },
    snapshot,
    records: [],
  };
};

test("builds authoritative subjects for all four archive recovery actions", () => {
  for (const action of [
    "rollback",
    "activate-containment",
    "redeploy-standard",
    "redeploy-containment",
  ]) {
    const current = createCurrent();
    const targetStandard = binding("standard", "new-standard");
    const targetCompanion = binding("containment", "new-companion");
    const targetContainment = binding("containment", "new-containment");
    const containmentAction = action.includes("containment");
    const result = buildArchiveRecoverySubject({
      current,
      namespace,
      operationId: `recover-${action}`,
      action,
      bindingId: containmentAction
        ? current.companion.bindingId
        : current.standard.bindingId,
      expectedArchivedSourceSha: sourceSha,
      targetBinding:
        action === "redeploy-standard"
          ? targetStandard
          : action === "redeploy-containment"
            ? targetContainment
            : null,
      companionBinding: action === "redeploy-standard" ? targetCompanion : null,
    });
    assert.equal(result.subject.recoveryAction, action);
    assert.equal(
      result.subject.operationKind,
      {
        rollback: "rollback-standard",
        "activate-containment": "activate-containment",
        "redeploy-standard": "redeploy-standard",
        "redeploy-containment": "redeploy-containment",
      }[action],
    );
    assert.equal(result.subjectSha256, sha256Bytes(result.subjectBytes));
    assert.ok(result.subject.evidenceRefs.length > 0);
  }
});

test("rejects a package redeploy that changes immutable archive identity", () => {
  const current = createCurrent();
  const target = binding("standard", "new-standard", {
    artifactArchive: reference("a"),
  });
  assert.throws(
    () =>
      buildArchiveRecoverySubject({
        current,
        namespace,
        operationId: "recover-wrong-archive",
        action: "redeploy-standard",
        bindingId: current.standard.bindingId,
        expectedArchivedSourceSha: sourceSha,
        targetBinding: target,
        companionBinding: binding("containment", "new-companion"),
      }),
    /target pair differs|immutable/i,
  );
});

test("stores approvals and CAS-appends a recovery pending operation", async () => {
  const current = createCurrent();
  const built = buildArchiveRecoverySubject({
    current,
    namespace,
    operationId: "recover-rollback-cas",
    action: "rollback",
    bindingId: current.standard.bindingId,
    expectedArchivedSourceSha: sourceSha,
  });
  let committedRecord = null;
  const store = {
    namespace,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
        replayed: false,
      };
    },
    async compareAndAppend({ expectedSequence, expectedHash, event }) {
      assert.equal(expectedSequence, current.snapshot.sequence);
      assert.equal(expectedHash, current.snapshot.eventHash);
      committedRecord = {
        sequence: event.sequence,
        eventHash: hashReleaseEvent(event),
        previousHash: event.previousEventHash,
        event,
        committedAt,
      };
      return {
        namespace,
        sequence: event.sequence,
        eventHash: committedRecord.eventHash,
        committedAt,
        replayed: false,
      };
    },
  };
  const approval = (role, character) => ({
    uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
    sha256: character.repeat(64),
    issuerReceiptUri: `release-state://${namespace}/evidence/${"9".repeat(64)}`,
    issuerReceiptSha256: "9".repeat(64),
    approvalId: `approval-${role}`,
    operationId: built.subject.operationId,
    subjectSha256: built.subjectSha256,
    trustedIssuer: "https://token.actions.githubusercontent.com",
    workflowRunId: "100",
    protectedEnvironment: "foundation-release-state",
    providerReviewerId: `reviewer-${role}`,
    role,
    decision: "APPROVED",
    approvedAt: committedAt,
  });
  const approvals = [
    approval("releaseOwner", "1"),
    approval("dataSafetyReviewer", "2"),
  ];
  const readState = async () => {
    if (committedRecord === null) return current;
    const snapshot = reduceReleaseState(
      current.snapshot,
      committedRecord.event,
    );
    return {
      head: { sequence: snapshot.sequence, eventHash: snapshot.eventHash },
      snapshot,
      records: [committedRecord],
    };
  };
  const result = await prepareArchiveRecovery(
    {
      store,
      subjectBytes: built.subjectBytes,
      expectedSubjectSha256: built.subjectSha256,
      approvalPolicy: {},
      expectedExecutorSourceSha: "f".repeat(40),
      expectedRunId: "100",
    },
    {
      readState,
      validateEvidence: async ({ subject }) => subject.evidenceRefs,
      collectApprovals: async () => ({
        approvalRefs: approvals,
        issuerReceiptReference: reference("9"),
        verifiedAt: committedAt,
      }),
    },
  );
  assert.equal(result.event.eventType, "promotion-prepared");
  assert.equal(result.event.payload.pendingOperation.kind, "rollback-standard");
  assert.deepEqual(result.event.approvalRefs, approvals);
  assert.equal(result.head.sequence, 8);
  assert.ok(canonicalJsonBytes(result).length > 0);
});

test("protected recovery CLI parses strict action shapes and materializes state-derived bindings", async () => {
  const base = [
    "subject",
    "--action",
    "redeploy-standard",
    "--binding-id",
    "deployment-binding:standard:origin-standard",
    "--namespace",
    namespace,
    "--operation-id",
    "recover-cli-standard",
    "--output",
    "subject.json",
    "--source-sha",
    sourceSha,
    "--target-binding",
    "target.json",
    "--companion-binding",
    "companion.json",
  ];
  assert.equal(parseArchiveRecoveryExecutionArguments(base).command, "subject");
  assert.throws(
    () =>
      parseArchiveRecoveryExecutionArguments(
        base.filter((value) => value !== "--companion-binding"),
      ),
    /invalid|incomplete/i,
  );

  const current = createCurrent();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "recovery-cli-"));
  let closed = false;
  let materializedBindings = null;
  try {
    const result = await runArchiveRecoveryExecutionCli(
      {
        argv: [
          "materialize",
          "--action",
          "rollback",
          "--binding-id",
          current.standard.bindingId,
          "--namespace",
          namespace,
          "--output",
          "materialized.json",
          "--package",
          "package",
          "--source-sha",
          sourceSha,
        ],
        environment: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "example/repository",
          GITHUB_WORKFLOW_REF:
            "example/repository/.github/workflows/release.yml@refs/heads/main",
          GITHUB_REF: "refs/heads/main",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF_PROTECTED: "true",
          GITHUB_RUN_ID: "100",
          GITHUB_RUN_ATTEMPT: "1",
          RELEASE_STATE_NAMESPACE: namespace,
          RELEASE_STATE_DATABASE_URL: "postgresql://fixture.invalid/test",
          RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
        },
        cwd: temporaryRoot,
        stdout: { write() {} },
      },
      {
        loadJson: async (filePath) =>
          filePath.endsWith("approval-policy.json")
            ? {
                bindingStatus: "configured",
                repository: "example/repository",
                workflowRef:
                  "example/repository/.github/workflows/release.yml@refs/heads/main",
              }
            : filePath.endsWith("release-state-store.json")
              ? { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" }
              : { schemaVersion: 1 },
        createStore: async () => ({
          namespace,
          async close() {
            closed = true;
          },
        }),
        readState: async () => current,
        materialize: async ({ bindings }) => {
          materializedBindings = bindings;
          return { schemaVersion: 1, status: "materialized" };
        },
        writeOutput: async (outputPath, value) => ({
          path: outputPath,
          bytes: canonicalJsonBytes(value),
        }),
      },
    );
    assert.equal(result.status, "materialized");
    assert.deepEqual(
      materializedBindings.map((value) => value.releaseRole),
      ["standard", "containment"],
    );
    assert.equal(closed, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
