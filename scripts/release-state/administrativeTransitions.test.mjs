import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  buildAuthoritativeDbContractActivationSubject as buildDbSubjectCore,
  buildAuthoritativeOperationAbortSubject,
  buildAuthoritativeStateInitializationSubject as buildInitializationSubjectCore,
  executeAdministrativeTransition as executeAdministrativeTransitionCore,
} from "./administrativeTransitions.mjs";
import { REMOTE_DB_OBSERVATION_MEDIA_TYPE } from "../db/remote-db-observation-authority.mjs";
import {
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import { validateProviderAliasObservationEvidence } from "./reconcileDecision.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const baseReleasePolicy = JSON.parse(
  await readFile(path.join(root, "config", "release-variants.json"), "utf8"),
);
baseReleasePolicy.activationStatus = "active";
baseReleasePolicy.activationBlockers = [];
const baseDbContract = JSON.parse(
  await readFile(
    path.join(root, "config", "db-compatibility-contract.json"),
    "utf8",
  ),
);
const namespace = "administrative-test";
const sourceSha = "a".repeat(40);
const sha = (character) => character.repeat(64);
const remoteObservationTime = "2026-08-09T00:00:00.000Z";
const remoteObservationNowMs = Date.parse("2026-08-09T00:04:00.000Z");

const makeEvidenceStore = () => {
  const evidence = new Map();
  const store = {
    namespace,
    async putEvidence({ bytes, mediaType }) {
      const objectBytes = Buffer.from(bytes);
      const digest = sha256Bytes(objectBytes);
      const replayed = evidence.has(digest);
      evidence.set(digest, {
        bytes: objectBytes,
        mediaType,
        committedAt: "2026-08-09T00:00:00.000Z",
      });
      return {
        uri: `release-state://${namespace}/evidence/${digest}`,
        sha256: digest,
        mediaType,
        byteLength: objectBytes.length,
        committedAt: "2026-08-09T00:00:00.000Z",
        replayed,
      };
    },
    async readEvidence({ sha256: digest }) {
      const stored = evidence.get(digest);
      return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : null;
    },
  };
  const putJson = async (value, mediaType = "application/json") => {
    const bytes = canonicalJsonBytes(value);
    const receipt = await store.putEvidence({ bytes, mediaType });
    return { uri: receipt.uri, sha256: receipt.sha256 };
  };
  return { store, evidence, putJson };
};

const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${sha(character)}`,
  sha256: sha(character),
});

const dbObservationRunAuthorityReference = reference("a");
const currentWorkflowRunId = "12345";
const validateDbObservationRun = async () => dbObservationRunAuthorityReference;
const phaseExitAttestationReferences = [
  reference("b"),
  reference("c"),
  reference("d"),
];
const phaseExitAttestationSeed = [
  {
    gate: "P0-BASELINE",
    sourceSha,
    subjectKind: "repository-phase-subject/v1",
    attestation: phaseExitAttestationReferences[0],
    predecessor: null,
  },
  {
    gate: "P0-TOOLCHAIN",
    sourceSha,
    subjectKind: "repository-phase-subject/v1",
    attestation: phaseExitAttestationReferences[1],
    predecessor: phaseExitAttestationReferences[0],
  },
  {
    gate: "P0-ARTIFACT",
    sourceSha,
    subjectKind: "disposable-drill-subject/v1",
    attestation: phaseExitAttestationReferences[2],
    predecessor: phaseExitAttestationReferences[1],
  },
];
const validatePhaseExitSeed = async ({ references, currentSourceSha }) => {
  assert.deepEqual(references, phaseExitAttestationReferences);
  assert.equal(currentSourceSha, sourceSha);
  return phaseExitAttestationSeed;
};
const buildAuthoritativeStateInitializationSubject = (options, dependencies) =>
  buildInitializationSubjectCore(
    {
      ...options,
      dbObservationRunAuthorityReference,
      currentWorkflowRunId,
      phaseExitAttestationReferences,
    },
    { validateDbObservationRun, validatePhaseExitSeed, ...dependencies },
  );
const buildAuthoritativeDbContractActivationSubject = (options, dependencies) =>
  buildDbSubjectCore(
    {
      ...options,
      dbObservationRunAuthorityReference,
      currentWorkflowRunId,
    },
    { validateDbObservationRun, ...dependencies },
  );
const executeAdministrativeTransition = (options, dependencies) =>
  executeAdministrativeTransitionCore(options, {
    validateDbObservationRun,
    validatePhaseExitSeed,
    ...dependencies,
  });

const putDbObservation = (harness, value) =>
  harness.putJson(value, REMOTE_DB_OBSERVATION_MEDIA_TYPE);

const dbContract = (version) => {
  const contract = structuredClone(baseDbContract);
  contract.contractStatus = "remote-verified";
  contract.contractUri = `urn:test:db:v${version}`;
  contract.remote.observationStatus = "observed";
  contract.remote.observationAuthority = {
    ...contract.remote.observationAuthority,
    bindingStatus: "configured",
    allowedHosts: ["db.example.test"],
    allowedDatabases: ["postgres"],
    allowedObserverRoles: ["foundation_db_observer"],
    productionCaSha256: sha("c"),
  };
  contract.blockerCodes = [];
  return contract;
};

const dbObservation = (contract, overrides = {}) => ({
  schemaVersion: 1,
  contractFingerprint: sha256Json(contract),
  migrationChecksums: { ...contract.remote.migrationChecksums },
  migrationsApplied: true,
  serviceRoleRawSelect: false,
  serviceRoleRawInsert: true,
  cspServiceRoleRawSelect: false,
  cspServiceRoleRawInsert: true,
  cspObjectsPresent: true,
  operatorBoundedFunctionOnly: true,
  cspApplicationCredentialReachable: false,
  requiredTables: [...contract.remote.requiredTables],
  requiredFunctions: [...contract.remote.requiredFunctions],
  observedAt: remoteObservationTime,
  ...overrides,
});

const binding = ({
  role = "containment",
  identity = "release-identity-v1",
  requiredDbCompatibility,
  releasePolicy,
  providerPolicy,
  deploymentId = "deployment-before",
} = {}) => ({
  bindingId: `${role}-${deploymentId}`,
  sourceSha,
  buildId: sourceSha,
  variantId: sha("2"),
  releaseRole: role,
  publicIdentityKind: identity,
  providerProjectId: "project-test",
  providerDeploymentId: deploymentId,
  deploymentUrl: `https://${deploymentId}.example.test`,
  artifactArchive: reference("3"),
  artifactArchiveAvailability: reference("4"),
  packageIndex: reference("5"),
  artifactManifest: reference("6"),
  providerEvidence: reference("7"),
  releasePolicy,
  providerPolicy,
  providerConfigurationHash: sha("8"),
  requiredDbCompatibility,
});

const emptyCurrent = {
  head: { sequence: 0, eventHash: null },
  snapshot: null,
  records: [],
};

test("derives state initialization exclusively from an empty store and immutable evidence", async () => {
  const harness = makeEvidenceStore();
  const releasePolicyReference = await harness.putJson(baseReleasePolicy);
  const providerPolicyReference = await harness.putJson({ configured: true });
  const finalDb = dbContract(1);
  const dbContractReference = await harness.putJson(finalDb);
  const dbObservationReference = await putDbObservation(
    harness,
    dbObservation(finalDb),
  );
  const currentDbCompatibility = {
    contractUri: finalDb.contractUri,
    fingerprint: sha256Json(finalDb),
  };
  const bootstrap = binding({
    identity: "legacy-bootstrap-v1",
    requiredDbCompatibility: currentDbCompatibility,
    releasePolicy: releasePolicyReference,
    providerPolicy: providerPolicyReference,
    deploymentId: "bootstrap",
  });
  const bootstrapRecoveryReference = await harness.putJson(bootstrap);
  const legacyObservationReference = await harness.putJson({ legacy: true });
  const built = await buildAuthoritativeStateInitializationSubject(
    {
      store: {
        ...harness.store,
        readHead: async () => emptyCurrent.head,
        readEvents: async () => [],
        compareAndAppend: async () => null,
      },
      namespace,
      operationId: "initialize-state",
      executorSourceSha: sourceSha,
      bootstrapRecoveryReference,
      legacyObservationReference,
      dbContractReference,
      dbObservationReference,
      activeReleasePolicyReference: releasePolicyReference,
    },
    {
      readState: async () => emptyCurrent,
      verifyBindingEvidence: async () => [],
      validateProviderObservation: async () => ({
        observationReference: legacyObservationReference,
        providerReceiptChainReferences: [],
      }),
      nowMs: remoteObservationNowMs,
    },
  );
  assert.equal(
    built.subject.currentDbCompatibility.fingerprint,
    dbContractReference.sha256,
  );
  assert.equal(built.subject.bootstrapRecovery.bindingId, bootstrap.bindingId);
  assert.equal(built.subject.minimumSafetyFloors.styleSrcAttr, undefined);
  assert.equal(built.subject.expectedState.sequence, 0);
  assert.deepEqual(
    built.subject.dbObservationReference,
    dbObservationReference,
  );
  assert.deepEqual(
    built.subject.dbObservationRunAuthorityReference,
    dbObservationRunAuthorityReference,
  );
  assert.ok(
    built.subject.sourceEvidenceRefs.some(
      ({ sha256 }) => sha256 === dbObservationReference.sha256,
    ),
  );
  assert.ok(
    built.subject.sourceEvidenceRefs.some(
      ({ sha256 }) => sha256 === dbObservationRunAuthorityReference.sha256,
    ),
  );

  let executionCurrent = structuredClone(emptyCurrent);
  const executionStore = {
    ...harness.store,
    async readHead() {
      return executionCurrent.head;
    },
    async readEvents() {
      return executionCurrent.records;
    },
    async compareAndAppend({ expectedSequence, expectedHash, event }) {
      assert.equal(expectedSequence, executionCurrent.head.sequence);
      assert.equal(expectedHash, executionCurrent.head.eventHash);
      const eventHash = hashReleaseEvent(event);
      executionCurrent = {
        head: { sequence: event.sequence, eventHash },
        snapshot: reduceReleaseState(executionCurrent.snapshot, event),
        records: [
          {
            sequence: event.sequence,
            eventHash,
            previousHash: event.previousEventHash,
            event,
            committedAt: remoteObservationTime,
          },
        ],
      };
      return {
        namespace,
        sequence: event.sequence,
        eventHash,
        committedAt: remoteObservationTime,
        replayed: false,
      };
    },
  };
  const initialized = await executeAdministrativeTransition(
    {
      store: executionStore,
      subjectBytes: built.subjectBytes,
      expectedSubjectSha256: built.subjectSha256,
      expectedExecutorSourceSha: sourceSha,
      expectedRunId: "12345",
    },
    {
      readState: async () => executionCurrent,
      verifyBindingEvidence: async () => [],
      validateProviderObservation: async () => ({
        observationReference: legacyObservationReference,
        providerReceiptChainReferences: [],
      }),
      nowMs: remoteObservationNowMs,
    },
  );
  assert.equal(initialized.replayed, false);
  assert.equal(
    Object.hasOwn(
      executionCurrent.records[0].event.payload,
      "dbObservationReference",
    ),
    false,
  );
  assert.ok(
    executionCurrent.records[0].event.evidenceRefs.some(
      ({ sha256 }) => sha256 === dbObservationReference.sha256,
    ),
  );

  const proposedPolicy = {
    ...structuredClone(baseReleasePolicy),
    activationStatus: "proposed",
  };
  const proposedPolicyReference = await harness.putJson(proposedPolicy);
  const proposedBootstrap = {
    ...bootstrap,
    releasePolicy: proposedPolicyReference,
  };
  const proposedBootstrapReference = await harness.putJson(proposedBootstrap);
  await assert.rejects(
    buildAuthoritativeStateInitializationSubject(
      {
        store: {
          ...harness.store,
          readHead: async () => emptyCurrent.head,
          readEvents: async () => [],
          compareAndAppend: async () => null,
        },
        namespace,
        operationId: "initialize-proposed-policy",
        executorSourceSha: sourceSha,
        bootstrapRecoveryReference: proposedBootstrapReference,
        legacyObservationReference,
        dbContractReference,
        dbObservationReference,
        activeReleasePolicyReference: proposedPolicyReference,
      },
      {
        readState: async () => emptyCurrent,
        verifyBindingEvidence: async () => [],
        validateProviderObservation: async () => ({
          observationReference: legacyObservationReference,
          providerReceiptChainReferences: [],
        }),
        nowMs: remoteObservationNowMs,
      },
    ),
    /not explicitly active/,
  );

  await assert.rejects(
    buildAuthoritativeStateInitializationSubject(
      {
        store: {
          ...harness.store,
          readHead: async () => ({ sequence: 1, eventHash: sha("f") }),
          readEvents: async () => [],
          compareAndAppend: async () => null,
        },
        namespace,
        operationId: "initialize-state",
        executorSourceSha: sourceSha,
        bootstrapRecoveryReference,
        legacyObservationReference,
        dbContractReference,
        dbObservationReference,
        activeReleasePolicyReference: releasePolicyReference,
      },
      {
        readState: async () => ({
          ...emptyCurrent,
          head: { sequence: 1, eventHash: sha("f") },
        }),
        validatePhaseExitSeed: async () => {
          throw new Error("after-init seed validation must not run");
        },
      },
    ),
    /empty namespace/,
  );
});

const initializedCurrent = ({ nextDb, activeProduction = null } = {}) => {
  const oldDb = {
    contractUri: "urn:test:db:v1",
    fingerprint: sha("d"),
  };
  const bootstrapRecovery = {
    sourceSha,
  };
  return {
    head: { sequence: 1, eventHash: sha("1") },
    snapshot: {
      sequence: 1,
      eventHash: sha("1"),
      activeProduction,
      acceptedStandard: null,
      acceptedStandardFloors: {},
      bootstrapRecovery,
      pendingOperation: null,
      pendingAcceptance: null,
      rollbackInventory: [],
      currentDbCompatibility: oldDb,
      activeReleasePolicy: nextDb.releasePolicyReference,
    },
    records: [{ event: { namespace } }],
  };
};

test("derives DB activation only from a distinct reviewed producer authority", async () => {
  const harness = makeEvidenceStore();
  const releasePolicyReference = await harness.putJson(baseReleasePolicy);
  const nextContract = dbContract(2);
  const dbContractReference = await harness.putJson(nextContract);
  const dbObservationReference = await putDbObservation(
    harness,
    dbObservation(nextContract),
  );
  const producerRunId = "10001";
  const runAuthorityReference = await harness.putJson({
    authorityKind: "reviewed-remote-db-observation-production/v1",
    producerRunId,
  });
  const validateProducerAuthority = async (options) => {
    assert.deepEqual(options.reference, runAuthorityReference);
    assert.deepEqual(options.observationReference, dbObservationReference);
    assert.equal(options.sourceSha, sourceSha);
    if (options.currentWorkflowRunId === producerRunId) {
      throw new Error(
        "Remote DB observation must come from a distinct completed prior run",
      );
    }
    return { authority: { runId: producerRunId } };
  };
  const current = initializedCurrent({
    nextDb: { releasePolicyReference },
  });
  const store = {
    ...harness.store,
    readHead: async () => current.head,
    readEvents: async () => current.records,
    compareAndAppend: async () => null,
  };
  const options = {
    store,
    namespace,
    operationId: "activate-db-reviewed-producer",
    executorSourceSha: sourceSha,
    dbContractReference,
    dbObservationReference,
    dbObservationRunAuthorityReference: runAuthorityReference,
    currentWorkflowRunId: "12345",
  };
  const built = await buildDbSubjectCore(options, {
    readState: async () => current,
    validateDbObservationRun: validateProducerAuthority,
    nowMs: remoteObservationNowMs,
  });
  assert.deepEqual(
    built.subject.dbObservationRunAuthorityReference,
    runAuthorityReference,
  );
  await assert.rejects(
    buildDbSubjectCore(
      { ...options, currentWorkflowRunId: producerRunId },
      {
        readState: async () => current,
        validateDbObservationRun: validateProducerAuthority,
        nowMs: remoteObservationNowMs,
      },
    ),
    /distinct completed prior run/u,
  );
});

test("derives a forward DB transition and rejects stale or active-package-inexact contracts", async () => {
  const harness = makeEvidenceStore();
  const releasePolicyReference = await harness.putJson(baseReleasePolicy);
  const nextContract = dbContract(2);
  const dbContractReference = await harness.putJson(nextContract);
  const dbObservationReference = await putDbObservation(
    harness,
    dbObservation(nextContract),
  );
  const current = initializedCurrent({
    nextDb: { releasePolicyReference },
  });
  const store = {
    ...harness.store,
    readHead: async () => current.head,
    readEvents: async () => current.records,
    compareAndAppend: async () => null,
  };
  const built = await buildAuthoritativeDbContractActivationSubject(
    {
      store,
      namespace,
      operationId: "activate-db-v2",
      executorSourceSha: sourceSha,
      dbContractReference,
      dbObservationReference,
    },
    { readState: async () => current, nowMs: remoteObservationNowMs },
  );
  assert.deepEqual(
    built.subject.previousDbCompatibility,
    current.snapshot.currentDbCompatibility,
  );
  assert.equal(
    built.subject.currentDbCompatibility.fingerprint,
    dbContractReference.sha256,
  );
  assert.deepEqual(built.subject.rollbackInventory, []);
  assert.deepEqual(
    built.subject.dbObservationReference,
    dbObservationReference,
  );
  assert.deepEqual(
    built.subject.dbObservationRunAuthorityReference,
    dbObservationRunAuthorityReference,
  );

  await assert.rejects(
    buildAuthoritativeDbContractActivationSubject(
      {
        store,
        namespace,
        operationId: "activate-db-v2",
        executorSourceSha: sourceSha,
        dbContractReference,
        dbObservationReference,
      },
      {
        readState: async () => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            activeProduction: binding({
              role: "standard",
              requiredDbCompatibility: current.snapshot.currentDbCompatibility,
              releasePolicy: releasePolicyReference,
              providerPolicy: reference("9"),
            }),
          },
        }),
        nowMs: remoteObservationNowMs,
      },
    ),
    /Active production/,
  );
});

test("requires an immutable, exact, and fresh remote DB observation for activation", async () => {
  const harness = makeEvidenceStore();
  const releasePolicyReference = await harness.putJson(baseReleasePolicy);
  const nextContract = dbContract(2);
  const dbContractReference = await harness.putJson(nextContract);
  const current = initializedCurrent({
    nextDb: { releasePolicyReference },
  });
  const store = {
    ...harness.store,
    readHead: async () => current.head,
    readEvents: async () => current.records,
    compareAndAppend: async () => null,
  };
  const build = (dbObservationReference) =>
    buildAuthoritativeDbContractActivationSubject(
      {
        store,
        namespace,
        operationId: "activate-db-observation-proof",
        executorSourceSha: sourceSha,
        dbContractReference,
        dbObservationReference,
      },
      { readState: async () => current, nowMs: remoteObservationNowMs },
    );

  await assert.rejects(
    build(reference("e")),
    /Stored remote DB observation authority differs/,
  );

  const firstMigration = Object.keys(nextContract.remote.migrationChecksums)[0];
  for (const evidence of [
    dbObservation(nextContract, { contractFingerprint: sha("f") }),
    dbObservation(nextContract, {
      migrationChecksums: {
        ...nextContract.remote.migrationChecksums,
        [firstMigration]: sha("f"),
      },
    }),
    dbObservation(nextContract, {
      observedAt: "2026-08-08T23:54:59.000Z",
    }),
  ]) {
    const observationReference = await putDbObservation(harness, evidence);
    await assert.rejects(
      build(observationReference),
      /does not match the compatibility contract/,
    );
  }
});

const abortCurrent = ({ latestType = "promotion-prepared" } = {}) => {
  const db = { contractUri: "urn:test:db:v1", fingerprint: sha("d") };
  const policy = reference("1");
  const providerPolicy = reference("9");
  const activeProduction = binding({
    role: "standard",
    requiredDbCompatibility: db,
    releasePolicy: policy,
    providerPolicy,
    deploymentId: "deployment-before",
  });
  const target = binding({
    role: "standard",
    requiredDbCompatibility: db,
    releasePolicy: policy,
    providerPolicy,
    deploymentId: "deployment-target",
  });
  const operationId = "abort-prepared-operation";
  const pendingOperation = {
    operationId,
    kind: "redeploy-standard",
    expectedState: { sequence: 1, eventHash: sha("0") },
    targetBinding: target,
    originBinding: activeProduction,
    originCompanionBinding: null,
    companionBinding: null,
    previousBinding: activeProduction,
    emergencyRecoveryBinding: activeProduction,
    approvalRefs: [],
    preparedAt: "2026-08-09T00:00:00.000Z",
  };
  return {
    operationId,
    activeProduction,
    target,
    current: {
      head: { sequence: 2, eventHash: sha("2") },
      snapshot: {
        sequence: 2,
        eventHash: sha("2"),
        activeProduction,
        pendingOperation,
        pendingAcceptance: null,
      },
      records: [
        { event: { namespace, eventType: "state-initialized" } },
        { event: { namespace, eventType: latestType, operationId } },
      ],
    },
  };
};

test("binds operation abort to a fresh all-domain pre-operation observation", async () => {
  const fixture = abortCurrent();
  const observationBytes = canonicalJsonBytes({ fresh: true });
  const observationReference = {
    uri: `release-state://${namespace}/evidence/${sha256Bytes(observationBytes)}`,
    sha256: sha256Bytes(observationBytes),
  };
  const store = {
    namespace,
    readHead: async () => fixture.current.head,
    readEvents: async () => fixture.current.records,
    readEvidence: async () => null,
    putEvidence: async () => null,
    compareAndAppend: async () => null,
  };
  const dependencies = {
    readState: async () => fixture.current,
    storeObservation: async () => observationReference,
    validateProviderObservation: async () => ({
      observationReference,
      observedDeploymentId: fixture.activeProduction.providerDeploymentId,
      providerReceiptChainReferences: [reference("e")],
    }),
    readProviderPolicy: async () => ({ configured: true }),
  };
  const built = await buildAuthoritativeOperationAbortSubject(
    {
      store,
      namespace,
      operationId: fixture.operationId,
      executorSourceSha: sourceSha,
      providerObservationBytes: observationBytes,
    },
    dependencies,
  );
  assert.equal(
    built.subject.preOperationActiveProduction.bindingId,
    fixture.activeProduction.bindingId,
  );
  assert.equal(
    built.subject.providerObservationReference.sha256,
    observationReference.sha256,
  );

  for (const [latestType, pattern] of [
    ["deployment-assigned", /exact prepared head/],
    ["assignment-validated", /exact prepared head/],
  ]) {
    const changed = abortCurrent({ latestType });
    await assert.rejects(
      buildAuthoritativeOperationAbortSubject(
        {
          store,
          namespace,
          operationId: changed.operationId,
          executorSourceSha: sourceSha,
          providerObservationBytes: observationBytes,
        },
        { ...dependencies, readState: async () => changed.current },
      ),
      pattern,
    );
  }
  await assert.rejects(
    buildAuthoritativeOperationAbortSubject(
      {
        store,
        namespace,
        operationId: fixture.operationId,
        executorSourceSha: sourceSha,
        providerObservationBytes: observationBytes,
      },
      {
        ...dependencies,
        validateProviderObservation: async () => ({
          observationReference,
          observedDeploymentId: fixture.target.providerDeploymentId,
          providerReceiptChainReferences: [],
        }),
      },
    ),
    /target-bound/,
  );

  const legacyBytes = canonicalJsonBytes({ legacy: "production" });
  const legacyReference = {
    uri: `release-state://${namespace}/evidence/${sha256Bytes(legacyBytes)}`,
    sha256: sha256Bytes(legacyBytes),
  };
  const legacyFixture = abortCurrent();
  legacyFixture.current.snapshot = {
    ...legacyFixture.current.snapshot,
    activeProduction: null,
    legacyObservedProduction: {
      observationUri: legacyReference.uri,
      observationSha256: legacyReference.sha256,
    },
    pendingOperation: {
      ...legacyFixture.current.snapshot.pendingOperation,
      previousBinding: null,
    },
  };
  const identity = {
    providerProjectId: "project-test",
    assignments: [
      {
        productionDomain: "app.example.test",
        assignedDeploymentId: "legacy-deployment",
      },
    ],
  };
  const legacyStore = {
    ...store,
    readEvidence: async ({ sha256: candidate }) =>
      candidate === legacyReference.sha256
        ? {
            bytes: legacyBytes,
            mediaType: "application/json",
            committedAt: "2026-08-09T00:00:00.000Z",
          }
        : null,
  };
  const legacyBuilt = await buildAuthoritativeOperationAbortSubject(
    {
      store: legacyStore,
      namespace,
      operationId: legacyFixture.operationId,
      executorSourceSha: sourceSha,
      providerObservationBytes: observationBytes,
    },
    {
      readState: async () => legacyFixture.current,
      storeObservation: async () => observationReference,
      readProviderPolicy: async () => ({}),
      validateProviderObservation: async ({ observationBytes: bytes }) => ({
        observationReference: bytes.equals(legacyBytes)
          ? legacyReference
          : observationReference,
        observedDeploymentId: "legacy-deployment",
        observation: identity,
        providerReceiptChainReferences: [],
        providerResponseReferences: [reference("d")],
      }),
    },
  );
  assert.equal(legacyBuilt.subject.preOperationActiveProduction, null);
  assert.deepEqual(
    legacyBuilt.subject.legacyProductionObservationReference,
    legacyReference,
  );
});

test("provider observation verifier fails closed for missing, tampered, and stale receipts", async () => {
  const harness = makeEvidenceStore();
  const now = Date.parse("2026-08-09T00:00:00.000Z");
  const providerPolicy = {
    bindingStatus: "configured",
    expectedTeamId: "team-test",
    expectedProjectId: "project-test",
    ownedProductionDomains: ["app.example.test"],
    observationPolicy: {
      apiBaseUrl: "https://api.vercel.com",
      maxResponseAgeSeconds: 300,
      maxFutureClockSkewSeconds: 30,
    },
  };
  const responseBytes = canonicalJsonBytes({
    alias: "app.example.test",
    projectId: "project-test",
    deploymentId: "deployment-before",
  });
  const responseReceipt = await harness.store.putEvidence({
    bytes: responseBytes,
    mediaType: "application/vnd.vercel.alias-response+json",
  });
  const responseReference = {
    uri: responseReceipt.uri,
    sha256: responseReceipt.sha256,
  };
  const receiptValue = (providerDate) => ({
    schemaVersion: 1,
    receiptKind: "vercel-alias-read-receipt/v1",
    productionDomain: "app.example.test",
    providerProjectId: "project-test",
    providerDeploymentId: "deployment-before",
    requestUrl:
      "https://api.vercel.com/v4/aliases/app.example.test?teamId=team-test",
    responseUrl:
      "https://api.vercel.com/v4/aliases/app.example.test?teamId=team-test",
    status: 200,
    providerDate,
    responseSha256: responseReference.sha256,
    responseReference,
  });
  const receiptReference = await harness.putJson(
    receiptValue("2026-08-09T00:00:00.000Z"),
    "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1",
  );
  const observation = (providerReceiptReferences) => ({
    schemaVersion: 1,
    observationKind: "provider-alias-observation/v1",
    namespace,
    providerProjectId: "project-test",
    assignments: [
      {
        productionDomain: "app.example.test",
        assignedDeploymentId: "deployment-before",
      },
    ],
    observedBinding: null,
    providerReceiptReferences,
  });
  const validate = async (value, freshnessRequired = true) => {
    const bytes = canonicalJsonBytes(value);
    await harness.store.putEvidence({
      bytes,
      mediaType:
        "application/vnd.event-shopping-planner.provider-alias-observation+json;version=1",
    });
    return validateProviderAliasObservationEvidence(
      {
        store: harness.store,
        namespace,
        observationBytes: bytes,
        providerPolicy,
        expectedBinding: null,
        freshnessRequired,
      },
      { now: () => now },
    );
  };
  await validate(observation([receiptReference]));
  await assert.rejects(
    validate(observation([reference("f")])),
    /absent|immutable verification/,
  );

  const staleReference = await harness.putJson(
    receiptValue("2026-08-08T00:00:00.000Z"),
    "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1",
  );
  await assert.rejects(
    validate(observation([staleReference])),
    /binding is invalid/,
  );
  await validate(observation([staleReference]), false);

  harness.evidence.set(receiptReference.sha256, {
    bytes: canonicalJsonBytes({ tampered: true }),
    mediaType:
      "application/vnd.event-shopping-planner.vercel-alias-receipt+json;version=1",
    committedAt: "2026-08-09T00:00:00.000Z",
  });
  await assert.rejects(
    validate(observation([receiptReference])),
    /immutable verification|content hash/,
  );
});

test("executes DB activation once with two reviewed approvals and replays the same append", async () => {
  const harness = makeEvidenceStore();
  const releasePolicyReference = await harness.putJson(baseReleasePolicy);
  const nextContract = dbContract(2);
  const dbContractReference = await harness.putJson(nextContract);
  const dbObservationReference = await putDbObservation(
    harness,
    dbObservation(nextContract),
  );
  let current = initializedCurrent({ nextDb: { releasePolicyReference } });
  const store = {
    ...harness.store,
    async readHead() {
      return current.head;
    },
    async readEvents() {
      return current.records;
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
          {
            sequence: event.sequence,
            eventHash,
            previousHash: event.previousEventHash,
            event,
            committedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      };
      return {
        namespace,
        sequence: event.sequence,
        eventHash,
        committedAt: "2026-08-09T00:00:00.000Z",
        replayed: false,
      };
    },
  };
  const built = await buildAuthoritativeDbContractActivationSubject(
    {
      store,
      namespace,
      operationId: "activate-db-v2",
      executorSourceSha: sourceSha,
      dbContractReference,
      dbObservationReference,
    },
    { readState: async () => current, nowMs: remoteObservationNowMs },
  );
  const approval = (role, suffix) => ({
    uri: reference(suffix).uri,
    sha256: reference(suffix).sha256,
    approvalId: `approval-${suffix}`,
    operationId: built.subject.operationId,
    subjectSha256: built.subjectSha256,
    trustedIssuer: "https://token.actions.githubusercontent.com",
    issuerReceiptUri: reference("f").uri,
    issuerReceiptSha256: reference("f").sha256,
    workflowRunId: "12345",
    protectedEnvironment: "foundation-release-state",
    providerReviewerId: "shared-db-reviewer",
    role,
    decision: "APPROVED",
    approvedAt: "2026-08-09T00:00:00.000Z",
  });
  const collectApprovals = async () => ({
    approvalRefs: [
      approval("releaseOwner", "a"),
      approval("dataSafetyReviewer", "b"),
    ],
    issuerReceiptReference: reference("f"),
  });
  const execute = () =>
    executeAdministrativeTransition(
      {
        store,
        subjectBytes: built.subjectBytes,
        expectedSubjectSha256: built.subjectSha256,
        expectedExecutorSourceSha: sourceSha,
        expectedRunId: "12345",
        approvalPolicy: {},
      },
      {
        readState: async () => current,
        collectApprovals,
        nowMs: remoteObservationNowMs,
      },
    );
  const first = await execute();
  assert.equal(first.replayed, false);
  assert.equal(
    current.snapshot.currentDbCompatibility.fingerprint,
    dbContractReference.sha256,
  );
  assert.equal(
    Object.hasOwn(
      current.records.at(-1).event.payload,
      "dbObservationReference",
    ),
    false,
  );
  assert.ok(
    current.records
      .at(-1)
      .event.evidenceRefs.some(
        ({ sha256 }) => sha256 === dbObservationReference.sha256,
      ),
  );
  const retry = await execute();
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.event, first.event);

  const tampered = Buffer.from(built.subjectBytes);
  tampered[tampered.length - 2] ^= 1;
  await assert.rejects(
    executeAdministrativeTransition(
      {
        store,
        subjectBytes: tampered,
        expectedSubjectSha256: built.subjectSha256,
        expectedExecutorSourceSha: sourceSha,
        expectedRunId: "12345",
      },
      { readState: async () => current },
    ),
  );
  const unknownSubjectBytes = canonicalJsonBytes({
    ...built.subject,
    unknownAuthority: true,
  });
  await assert.rejects(
    executeAdministrativeTransition(
      {
        store,
        subjectBytes: unknownSubjectBytes,
        expectedSubjectSha256: sha256Bytes(unknownSubjectBytes),
        expectedExecutorSourceSha: sourceSha,
        expectedRunId: "12345",
      },
      { readState: async () => current },
    ),
    /unknown or missing fields/,
  );
});
