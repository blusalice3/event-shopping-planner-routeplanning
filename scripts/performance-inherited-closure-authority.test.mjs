import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import { resolveAuthoritativePerformanceClosureEntries } from "./lib/performance-inherited-closure-authority.mjs";
import { PERFORMANCE_INHERITED_GATES } from "./lib/performance-inherited-closure.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
} from "./release-state/releaseWorkflowValidation.mjs";

const namespace = "performance-authority-test";
const sourceSha = "a".repeat(40);
const timestamp = "2026-08-09T00:00:00.000Z";
const approvalPolicy = {
  bindingStatus: "configured",
  repository: "example/event-shopping-planner",
  workflowRef:
    "example/event-shopping-planner/.github/workflows/release.yml@refs/heads/main",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  protectedEnvironment: "foundation-release-state",
  roles: {
    releaseOwner: { reviewerTeam: "release-owners" },
    dataSafetyReviewer: { reviewerTeam: "data-safety-reviewers" },
    operationsReviewer: { reviewerTeam: "operations-reviewers" },
  },
};

const buildFixture = ({
  legacyPerformanceGate = null,
  wrongArchiveGate = null,
  producedAfterAcceptanceGate = null,
} = {}) => {
  const evidence = new Map();
  const put = (value, mediaType = "application/json") => {
    const bytes = Buffer.isBuffer(value)
      ? Buffer.from(value)
      : canonicalJsonBytes(value);
    const digest = sha256Bytes(bytes);
    evidence.set(digest, { bytes, mediaType, committedAt: timestamp });
    return {
      uri: `release-state://${namespace}/evidence/${digest}`,
      sha256: digest,
    };
  };
  const commonProviderEvidence = put({ kind: "provider-evidence" });
  const commonReleasePolicy = put({ kind: "release-policy" });
  const commonProviderPolicy = put({ kind: "provider-policy" });
  const records = [];
  const eventHashes = {};
  for (const [gateIndex, gate] of PERFORMANCE_INHERITED_GATES.entries()) {
    const operationId = `accept-${gate.toLowerCase()}`;
    const acceptedGate = gate === "P0-TOOLCHAIN" ? "P0-RELEASE" : gate;
    const eventSequence = (gateIndex + 1) * 10;
    const previousEventHash = (gateIndex + 10).toString(16).padStart(64, "0");
    const expectedState = {
      sequence: eventSequence - 1,
      eventHash: previousEventHash,
    };
    const packageIndex = put(
      { gate, kind: "package-index" },
      "application/vnd.event-shopping-planner.release-package-index+json;version=1",
    );
    const artifactManifest = put(
      { gate, kind: "artifact-manifest" },
      "application/vnd.event-shopping-planner.artifact-manifest+json;version=1",
    );
    const archiveBytes = Buffer.from(`archive:${gate}\n`, "utf8");
    const artifactArchive = put(archiveBytes, ARTIFACT_ARCHIVE_MEDIA_TYPE);
    const variantId = (gateIndex + 1).toString(16).padStart(64, "0");
    const bindingId = `binding-${gate.toLowerCase()}`;
    const availabilityValue = {
      schemaVersion: 1,
      evidenceKind: "artifact-archive-availability/v1",
      namespace,
      bindingId,
      sourceSha,
      variantId,
      releaseRole: "standard",
      artifactManifest,
      artifactArchive: {
        ...artifactArchive,
        mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
        byteLength: archiveBytes.length,
        committedAt: timestamp,
      },
      availability: "available",
    };
    const artifactArchiveAvailability = put(
      availabilityValue,
      ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
    );
    const standardBinding = {
      artifactManifest,
      bindingId,
      buildId: sourceSha,
      deploymentUrl: `https://${gateIndex}.example.test`,
      packageIndex,
      providerConfigurationHash: "2".repeat(64),
      providerDeploymentId: `deployment-${gateIndex}`,
      providerEvidence: commonProviderEvidence,
      providerPolicy: commonProviderPolicy,
      providerProjectId: "project-test",
      publicIdentityKind: "release-identity-v1",
      releasePolicy: commonReleasePolicy,
      releaseRole: "standard",
      requiredDbCompatibility: {
        contractUri: "urn:test:db:v1",
        fingerprint: "3".repeat(64),
      },
      sourceSha,
      variantId,
      artifactArchive,
      artifactArchiveAvailability,
    };
    const evidenceArtifactSha256 =
      gate === wrongArchiveGate ? "9".repeat(64) : artifactArchive.sha256;
    const collectedAtUtc = "2026-08-08T22:00:00.000Z";
    const producedAtUtc =
      gate === producedAfterAcceptanceGate
        ? "2026-08-09T01:00:00.000Z"
        : "2026-08-08T23:00:00.000Z";
    const performanceEvidence = {
      gate,
      collectedAtUtc,
      source: {
        gitCommitSha: sourceSha,
        sourceClosureSha256: "4".repeat(64),
        treeState: "clean",
        artifactSha256: evidenceArtifactSha256,
      },
    };
    const baseEnvelope = {
      schemaVersion: 1,
      evidence: performanceEvidence,
      evidenceSha256: sha256Json(performanceEvidence),
    };
    const receiptRequirements = {
      schemaVersion: 1,
      requirementKind: "standard-acceptance-requirements/v1",
      namespace,
      operationId,
      sourceSha,
      expectedArtifactSha256: evidenceArtifactSha256,
      expectedState,
      acceptedGate,
      performanceEvidenceKind: "own-gate-performance-evidence/v1",
      performanceGate: gate,
    };
    const producerReceiptBody = {
      kind: "own-gate-performance-evidence-producer-receipt/v1",
      namespace,
      operationId,
      acceptedGate,
      performanceGate: gate,
      source: {
        gitCommitSha: sourceSha,
        sourceClosureSha256: "4".repeat(64),
        treeState: "clean",
      },
      authoritativeState: expectedState,
      requirementsSha256: sha256Json(receiptRequirements),
      artifactArchiveSha256: evidenceArtifactSha256,
      rawSamplesArtifact: {
        name: `foundation-performance-raw-samples-${sourceSha}-1`,
        runId: `${10 + gateIndex}`,
        runAttempt: "1",
        sha256: "5".repeat(64),
        collectorIdentity: {
          uri: `release-state://${namespace}/evidence/${"6".repeat(64)}`,
          sha256: "6".repeat(64),
        },
        workflowRunAuthority: {
          uri: `release-state://${namespace}/evidence/${"7".repeat(64)}`,
          sha256: "7".repeat(64),
        },
      },
      producerRunId: `${50 + gateIndex}`,
      producerRunAttempt: "1",
      performanceEvidence: {
        name: `foundation-performance-own-gate-evidence-${sourceSha}-1`,
        envelopeSha256: sha256Bytes(canonicalJsonBytes(baseEnvelope)),
        evidenceSha256: baseEnvelope.evidenceSha256,
      },
      producedAtUtc,
    };
    const performance = put(
      gate === legacyPerformanceGate
        ? baseEnvelope
        : {
            ...baseEnvelope,
            producerReceipt: {
              schemaVersion: 1,
              receipt: producerReceiptBody,
              receiptSha256: sha256Json(producerReceiptBody),
            },
          },
      "application/vnd.event-shopping-planner.performance-evidence+json;version=1",
    );
    const issuer = put(
      {
        schemaVersion: 1,
        kind: "github-actions-oidc-verification/v1",
        issuer: approvalPolicy.trustedIssuer,
        verifiedAt: timestamp,
        claims: {
          repository: approvalPolicy.repository,
          workflowRef: approvalPolicy.workflowRef,
          environment: approvalPolicy.protectedEnvironment,
          runId: `${100 + gateIndex}`,
          sourceSha,
          expiresAt: "2026-08-09T00:10:00.000Z",
        },
      },
      "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1",
    );
    const approvalRefs = [
      "releaseOwner",
      "dataSafetyReviewer",
      "operationsReviewer",
    ].map((role, roleIndex) => {
      const approvalId = `${gate.toLowerCase()}-approval-${roleIndex}`;
      const providerReviewerId = `${gate.toLowerCase()}-reviewer-${roleIndex}`;
      const receipt = put(
        {
          schemaVersion: 1,
          kind: "github-protected-environment-approval/v1",
          approvalId,
          operationId,
          subjectSha256: "pending",
          decision: "APPROVED",
          providerReviewerId,
          providerReviewerTeamIds: [approvalPolicy.roles[role].reviewerTeam],
          role,
          workflowRunId: `${100 + gateIndex}`,
          protectedEnvironment: approvalPolicy.protectedEnvironment,
          approvedAt: timestamp,
        },
        "application/vnd.event-shopping-planner.github-approval-receipt+json;version=1",
      );
      return {
        ...receipt,
        approvalId,
        operationId,
        subjectSha256: "pending",
        trustedIssuer: approvalPolicy.trustedIssuer,
        issuerReceiptUri: issuer.uri,
        issuerReceiptSha256: issuer.sha256,
        workflowRunId: `${100 + gateIndex}`,
        protectedEnvironment: approvalPolicy.protectedEnvironment,
        providerReviewerId,
        role,
        decision: "APPROVED",
        approvedAt: timestamp,
      };
    });
    const subjectValue = {
      schemaVersion: 1,
      subjectKind: "standard-acceptance-subject/v1",
      namespace,
      operationId,
      acceptedGate,
      expectedState,
      performanceEvidence: performance,
      standardBinding,
    };
    let subject = put(
      subjectValue,
      "application/vnd.event-shopping-planner.standard-acceptance-subject+json;version=1",
    );
    for (const approval of approvalRefs) {
      approval.subjectSha256 = subject.sha256;
      const stored = evidence.get(approval.sha256);
      const receipt = JSON.parse(stored.bytes.toString("utf8"));
      receipt.subjectSha256 = subject.sha256;
      evidence.delete(approval.sha256);
      const replacement = put(
        receipt,
        "application/vnd.event-shopping-planner.github-approval-receipt+json;version=1",
      );
      approval.uri = replacement.uri;
      approval.sha256 = replacement.sha256;
    }
    const event = {
      schemaVersion: 1,
      namespace,
      sequence: eventSequence,
      eventType: "release-accepted",
      operationId,
      previousEventHash,
      payload: {
        acceptedGate,
        observedThrough: timestamp,
      },
      evidenceRefs: [
        subject,
        performance,
        packageIndex,
        artifactManifest,
        artifactArchiveAvailability,
        issuer,
        ...approvalRefs.map(({ uri, sha256 }) => ({ uri, sha256 })),
      ],
      approvalRefs,
    };
    const eventHash = sha256Bytes(canonicalJsonBytes(event));
    records.push({ sequence: event.sequence, eventHash, event });
    eventHashes[gate] = eventHash;
  }
  const store = {
    namespace,
    async readHead() {
      const record = records.at(-1);
      return { sequence: record.sequence, eventHash: record.eventHash };
    },
    async readEvents() {
      return records;
    },
    async readEvidence({ sha256 }) {
      const stored = evidence.get(sha256);
      return stored
        ? {
            bytes: Buffer.from(stored.bytes),
            mediaType: stored.mediaType,
            committedAt: stored.committedAt,
          }
        : null;
    },
  };
  return { evidence, eventHashes, records, store };
};

const injectedReadState = async ({ store }) => ({
  head: await store.readHead(),
  snapshot: {},
  records: await store.readEvents({ afterSequence: 0 }),
});

test("resolves closure inputs only from authoritative event and object reads", async () => {
  const fixture = buildFixture();
  const result = await resolveAuthoritativePerformanceClosureEntries({
    store: fixture.store,
    acceptedEventSha256ByGate: fixture.eventHashes,
    approvalPolicy,
    readState: injectedReadState,
  });
  assert.equal(result.entries.length, 4);
  assert.deepEqual(
    result.entries.map(({ gate }) => gate),
    PERFORMANCE_INHERITED_GATES,
  );
  for (const entry of result.entries) {
    assert.equal(
      sha256Bytes(entry.acceptedEventBytes),
      entry.expectedAcceptedEventSha256,
    );
    assert.equal(
      sha256Bytes(entry.performanceEvidenceBytes),
      entry.expectedPerformanceEvidenceSha256,
    );
  }
});

test("rejects a missing OIDC object and live archive tampering", async () => {
  const missingIssuer = buildFixture();
  const issuerSha256 =
    missingIssuer.records[0].event.approvalRefs[0].issuerReceiptSha256;
  missingIssuer.evidence.delete(issuerSha256);
  await assert.rejects(
    resolveAuthoritativePerformanceClosureEntries({
      store: missingIssuer.store,
      acceptedEventSha256ByGate: missingIssuer.eventHashes,
      approvalPolicy,
      readState: injectedReadState,
    }),
    /absent or failed immutable verification/,
  );

  const tamperedArchive = buildFixture();
  const archiveSha256 = tamperedArchive.records[0].event.evidenceRefs.find(
    (reference) => {
      const stored = tamperedArchive.evidence.get(reference.sha256);
      return stored?.mediaType === ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE;
    },
  ).sha256;
  const availability = JSON.parse(
    tamperedArchive.evidence.get(archiveSha256).bytes.toString("utf8"),
  );
  tamperedArchive.evidence.get(availability.artifactArchive.sha256).bytes =
    Buffer.from("tampered");
  await assert.rejects(
    resolveAuthoritativePerformanceClosureEntries({
      store: tamperedArchive.store,
      acceptedEventSha256ByGate: tamperedArchive.eventHashes,
      approvalPolicy,
      readState: injectedReadState,
    }),
    /content-addressed digest/,
  );
});

test("rejects legacy own-gate envelopes and producer receipts bound to another archive", async () => {
  const legacy = buildFixture({
    legacyPerformanceGate: "P3-XLSX",
  });
  await assert.rejects(
    resolveAuthoritativePerformanceClosureEntries({
      store: legacy.store,
      acceptedEventSha256ByGate: legacy.eventHashes,
      approvalPolicy,
      readState: injectedReadState,
    }),
    /identity or content SHA-256 is invalid/,
  );

  const wrongArchive = buildFixture({
    wrongArchiveGate: "P5-DUAL",
  });
  await assert.rejects(
    resolveAuthoritativePerformanceClosureEntries({
      store: wrongArchive.store,
      acceptedEventSha256ByGate: wrongArchive.eventHashes,
      approvalPolicy,
      readState: injectedReadState,
    }),
    /differs from authoritative acceptance requirements/,
  );
});

test("rejects performance evidence produced after its accepted observation", async () => {
  const fixture = buildFixture({
    producedAfterAcceptanceGate: "P5-LIST",
  });
  await assert.rejects(
    resolveAuthoritativePerformanceClosureEntries({
      store: fixture.store,
      acceptedEventSha256ByGate: fixture.eventHashes,
      approvalPolicy,
      readState: injectedReadState,
    }),
    /produced after acceptance observation/,
  );
});

test("uses full authoritative replay by default", async () => {
  const fixture = buildFixture();
  await assert.rejects(
    resolveAuthoritativePerformanceClosureEntries({
      store: fixture.store,
      acceptedEventSha256ByGate: fixture.eventHashes,
      approvalPolicy,
    }),
    /head and event count differ|failed replay binding/,
  );
});
