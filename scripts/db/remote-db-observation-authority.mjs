import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  assertStoredGitHubOidcReceipt,
} from "../release-state/githubOidc.mjs";
import { readReviewedWorkflowRunAuthority } from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  assertVercelObservationEvidence,
} from "../provider/collect-vercel-observation.mjs";
import { assertRemoteDbObservation } from "./remote-db-observation.mjs";

export const REMOTE_DB_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.remote-db-observation+json;version=1";
export const REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.remote-db-observation-production+json;version=1";
export const REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.reviewed-remote-db-observation-production+json;version=1";
export const REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-policy+json;version=1";

const MAX_OBSERVATION_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const PRODUCTION_OPERATION = "collect-remote-db-observation";

const assertReleaseOidcPolicy = (approvalPolicy) => {
  if (
    !REPOSITORY_PATTERN.test(approvalPolicy?.repository ?? "") ||
    approvalPolicy.workflowRef !==
      `${approvalPolicy.repository}/${RELEASE_WORKFLOW_PATH}@refs/heads/main`
  ) {
    throw new Error("Remote DB producer OIDC workflow policy is invalid");
  }
};

const assertStore = (store) => {
  if (
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error("Remote DB observation store is incomplete");
  }
};

const assertReference = ({ namespace, reference }) => {
  if (
    typeof namespace !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(namespace) ||
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    Object.keys(reference).sort().join("\n") !== "sha256\nuri" ||
    !SHA256_PATTERN.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error("Remote DB observation reference is invalid");
  }
};

const sameReference = (left, right) =>
  left?.uri === right?.uri && left?.sha256 === right?.sha256;

const assertProductionIdentity = ({
  namespace,
  sourceSha,
  runId,
  runAttempt,
  observationReference,
  providerObservationReference,
  providerPolicyReference,
  producerOidcReference,
}) => {
  for (const reference of [
    observationReference,
    providerObservationReference,
    providerPolicyReference,
    producerOidcReference,
  ]) {
    assertReference({ namespace, reference });
  }
  if (
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !RUN_ID_PATTERN.test(runId ?? "") ||
    !RUN_ID_PATTERN.test(runAttempt ?? "")
  ) {
    throw new Error("Remote DB observation production identity is invalid");
  }
};

const productionAuthorityValue = ({
  namespace,
  sourceSha,
  runId,
  runAttempt,
  observationReference,
  providerObservationReference,
  providerPolicyReference,
  producerOidcReference,
}) => ({
  schemaVersion: 1,
  authorityKind: "protected-remote-db-observation-production/v1",
  namespace,
  sourceSha,
  workflowPath: RELEASE_WORKFLOW_PATH,
  operation: PRODUCTION_OPERATION,
  runId,
  runAttempt,
  observation: { ...observationReference },
  providerObservation: { ...providerObservationReference },
  providerPolicy: { ...providerPolicyReference },
  producerOidc: { ...producerOidcReference },
});

const putExactAuthority = async ({
  store,
  namespace,
  value,
  mediaType,
  label,
}) => {
  const bytes = canonicalJsonBytes(value);
  const sha256 = sha256Bytes(bytes);
  const reference = {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
  const receipt = await store.putEvidence({ bytes, mediaType });
  const stored = await store.readEvidence({ sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return { reference, receipt, bytes };
};

const readCanonicalStoredValue = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) => {
  assertReference({ namespace, reference });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAX_OBSERVATION_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} is absent or differs from immutable authority`);
  }
  const value = parseJsonStrict(stored.bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(stored.bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return {
    value,
    bytes: Buffer.from(stored.bytes),
    mediaType: stored.mediaType,
    committedAt: stored.committedAt,
    reference: { ...reference },
  };
};

export const assertRemoteDbObservationBytes = ({
  bytes,
  contract,
  now = Date.now,
}) => {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  if (input.length === 0 || input.length > MAX_OBSERVATION_BYTES) {
    throw new Error("Remote DB observation bytes are empty or oversized");
  }
  const observation = parseJsonStrict(
    input.toString("utf8"),
    "Remote DB observation",
  );
  if (!canonicalJsonBytes(observation).equals(input)) {
    throw new Error("Remote DB observation bytes are not canonical JSON");
  }
  assertRemoteDbObservation(observation, {
    contract,
    migrationChecksums: contract?.remote?.migrationChecksums,
    now,
  });
  return observation;
};

export const readStoredRemoteDbObservationAuthority = async ({
  store,
  namespace,
  reference,
  contract,
  now = Date.now,
}) => {
  assertStore(store);
  assertReference({ namespace, reference });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== REMOTE_DB_OBSERVATION_MEDIA_TYPE
  ) {
    throw new Error("Stored remote DB observation authority differs");
  }
  const observation = assertRemoteDbObservationBytes({
    bytes: stored.bytes,
    contract,
    now,
  });
  return {
    observation,
    bytes: Buffer.from(stored.bytes),
    mediaType: stored.mediaType,
    committedAt: stored.committedAt,
    reference: { ...reference },
  };
};

export const putRemoteDbObservationAuthority = async ({
  store,
  namespace,
  bytes,
  contract,
  now = Date.now,
}) => {
  assertStore(store);
  const input = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from("");
  assertRemoteDbObservationBytes({ bytes: input, contract, now });
  const sha256 = sha256Bytes(input);
  const reference = {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
  assertReference({ namespace, reference });
  const receipt = await store.putEvidence({
    bytes: input,
    mediaType: REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== REMOTE_DB_OBSERVATION_MEDIA_TYPE ||
    receipt.byteLength !== input.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error("Remote DB observation immutable-store receipt differs");
  }
  const stored = await readStoredRemoteDbObservationAuthority({
    store,
    namespace,
    reference,
    contract,
    now,
  });
  if (
    !stored.bytes.equals(input) ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error("Remote DB observation immutable-store readback differs");
  }
  return { reference, receipt, observation: stored.observation };
};

export const assertRemoteDbProviderObservationBytes = (
  { bytes, providerPolicy, now = Date.now },
  { validateProviderObservation = assertVercelObservationEvidence } = {},
) => {
  const input = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from("");
  if (input.length === 0 || input.length > MAX_OBSERVATION_BYTES) {
    throw new Error("Remote DB provider observation is empty or oversized");
  }
  const observation = parseJsonStrict(
    input.toString("utf8"),
    "Remote DB provider observation",
  );
  if (!canonicalJsonBytes(observation).equals(input)) {
    throw new Error("Remote DB provider observation is not canonical JSON");
  }
  validateProviderObservation(observation, providerPolicy, now);
  return observation;
};

export const putRemoteDbProviderObservationAuthority = async (
  { store, namespace, bytes, providerPolicy, now = Date.now },
  dependencies,
) => {
  assertStore(store);
  const observation = assertRemoteDbProviderObservationBytes(
    { bytes, providerPolicy, now },
    dependencies,
  );
  const [storedPolicy, storedObservation] = await Promise.all([
    putExactAuthority({
      store,
      namespace,
      value: providerPolicy,
      mediaType: REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
      label: "Remote DB provider policy",
    }),
    putExactAuthority({
      store,
      namespace,
      value: observation,
      mediaType: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
      label: "Remote DB provider observation",
    }),
  ]);
  return {
    reference: storedObservation.reference,
    policyReference: storedPolicy.reference,
    observation,
  };
};

export const readStoredRemoteDbProviderObservationAuthority = async (
  { store, namespace, reference, policyReference, now = Date.now },
  dependencies,
) => {
  assertStore(store);
  const [storedPolicy, storedObservation] = await Promise.all([
    readCanonicalStoredValue({
      store,
      namespace,
      reference: policyReference,
      mediaType: REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
      label: "Remote DB provider policy",
    }),
    readCanonicalStoredValue({
      store,
      namespace,
      reference,
      mediaType: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
      label: "Remote DB provider observation",
    }),
  ]);
  const observation = assertRemoteDbProviderObservationBytes(
    {
      bytes: storedObservation.bytes,
      providerPolicy: storedPolicy.value,
      now,
    },
    dependencies,
  );
  return {
    observation,
    providerPolicy: storedPolicy.value,
    bytes: storedObservation.bytes,
    reference: storedObservation.reference,
    policyReference: storedPolicy.reference,
  };
};

export const putRemoteDbObservationOidcAuthority = async ({
  store,
  namespace,
  receiptBytes,
  approvalPolicy,
  sourceSha,
  runId,
  runAttempt,
}) => {
  assertStore(store);
  assertReleaseOidcPolicy(approvalPolicy);
  const input = Buffer.isBuffer(receiptBytes)
    ? Buffer.from(receiptBytes)
    : Buffer.from("");
  const receipt = parseJsonStrict(
    input.toString("utf8"),
    "Remote DB OIDC receipt",
  );
  if (!canonicalJsonBytes(receipt).equals(input)) {
    throw new Error("Remote DB OIDC receipt is not canonical JSON");
  }
  assertStoredGitHubOidcReceipt({
    receipt,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
  });
  return putExactAuthority({
    store,
    namespace,
    value: receipt,
    mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
    label: "Remote DB producer OIDC receipt",
  });
};

export const readStoredRemoteDbObservationOidcAuthority = async ({
  store,
  namespace,
  reference,
  approvalPolicy,
  sourceSha,
  runId,
  runAttempt,
}) => {
  assertReleaseOidcPolicy(approvalPolicy);
  assertStore(store);
  const stored = await readCanonicalStoredValue({
    store,
    namespace,
    reference,
    mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
    label: "Remote DB producer OIDC receipt",
  });
  assertStoredGitHubOidcReceipt({
    receipt: stored.value,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
  });
  return stored;
};

export const putRemoteDbObservationProductionAuthority = async ({
  store,
  namespace,
  sourceSha,
  runId,
  runAttempt,
  observationReference,
  providerObservationReference,
  providerPolicyReference,
  producerOidcReference,
  contract,
  approvalPolicy,
  now = Date.now,
}) => {
  assertStore(store);
  assertProductionIdentity({
    namespace,
    sourceSha,
    runId,
    runAttempt,
    observationReference,
    providerObservationReference,
    providerPolicyReference,
    producerOidcReference,
  });
  await Promise.all([
    readStoredRemoteDbObservationAuthority({
      store,
      namespace,
      reference: observationReference,
      contract,
      now,
    }),
    readStoredRemoteDbProviderObservationAuthority({
      store,
      namespace,
      reference: providerObservationReference,
      policyReference: providerPolicyReference,
      now,
    }),
    readStoredRemoteDbObservationOidcAuthority({
      store,
      namespace,
      reference: producerOidcReference,
      approvalPolicy,
      sourceSha,
      runId,
      runAttempt,
    }),
  ]);
  const value = productionAuthorityValue({
    namespace,
    sourceSha,
    runId,
    runAttempt,
    observationReference,
    providerObservationReference,
    providerPolicyReference,
    producerOidcReference,
  });
  const stored = await putExactAuthority({
    store,
    namespace,
    value,
    mediaType: REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
    label: "Remote DB observation production receipt",
  });
  await readRemoteDbObservationProductionAuthority({
    store,
    namespace,
    reference: stored.reference,
    observationReference,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
    contract,
    approvalPolicy,
    now,
  });
  return stored;
};

export const readRemoteDbObservationProductionAuthority = async ({
  store,
  namespace,
  reference,
  observationReference,
  expectedSourceSha,
  expectedRunId,
  expectedRunAttempt,
  contract,
  approvalPolicy,
  now = Date.now,
}) => {
  assertStore(store);
  const stored = await readCanonicalStoredValue({
    store,
    namespace,
    reference,
    mediaType: REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
    label: "Remote DB observation production receipt",
  });
  const authority = stored.value;
  const exactKeys = [
    "authorityKind",
    "namespace",
    "observation",
    "operation",
    "providerObservation",
    "providerPolicy",
    "producerOidc",
    "runAttempt",
    "runId",
    "schemaVersion",
    "sourceSha",
    "workflowPath",
  ];
  if (
    authority === null ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    Object.keys(authority).sort().join("\n") !== exactKeys.sort().join("\n") ||
    authority.schemaVersion !== 1 ||
    authority.authorityKind !==
      "protected-remote-db-observation-production/v1" ||
    authority.namespace !== namespace ||
    authority.sourceSha !== expectedSourceSha ||
    authority.runId !== expectedRunId ||
    authority.runAttempt !== expectedRunAttempt ||
    authority.workflowPath !== RELEASE_WORKFLOW_PATH ||
    authority.operation !== PRODUCTION_OPERATION ||
    !sameReference(authority.observation, observationReference)
  ) {
    throw new Error("Remote DB observation production receipt binding differs");
  }
  assertProductionIdentity({
    namespace,
    sourceSha: authority.sourceSha,
    runId: authority.runId,
    runAttempt: authority.runAttempt,
    observationReference: authority.observation,
    providerObservationReference: authority.providerObservation,
    providerPolicyReference: authority.providerPolicy,
    producerOidcReference: authority.producerOidc,
  });
  const [remoteObservation, providerObservation, producerOidc] =
    await Promise.all([
      readStoredRemoteDbObservationAuthority({
        store,
        namespace,
        reference: authority.observation,
        contract,
        now,
      }),
      readStoredRemoteDbProviderObservationAuthority({
        store,
        namespace,
        reference: authority.providerObservation,
        policyReference: authority.providerPolicy,
        now,
      }),
      readStoredRemoteDbObservationOidcAuthority({
        store,
        namespace,
        reference: authority.producerOidc,
        approvalPolicy,
        sourceSha: authority.sourceSha,
        runId: authority.runId,
        runAttempt: authority.runAttempt,
      }),
    ]);
  return {
    authority,
    bytes: stored.bytes,
    reference: stored.reference,
    remoteObservation,
    providerObservation,
    producerOidc,
  };
};

export const readReviewedRemoteDbObservationProductionAuthority = async ({
  store,
  namespace,
  reference,
  observationReference,
  expectedSourceSha,
  currentWorkflowRunId,
  contract,
  approvalPolicy,
  now = Date.now,
}) => {
  assertStore(store);
  assertReference({ namespace, reference });
  assertReference({ namespace, reference: observationReference });
  if (
    !SOURCE_SHA_PATTERN.test(expectedSourceSha ?? "") ||
    !RUN_ID_PATTERN.test(currentWorkflowRunId ?? "")
  ) {
    throw new Error("Reviewed remote DB production identity is invalid");
  }
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE
  ) {
    throw new Error("Reviewed remote DB production authority is absent");
  }
  const authority = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Reviewed remote DB production authority",
  );
  if (!canonicalJsonBytes(authority).equals(stored.bytes)) {
    throw new Error("Reviewed remote DB production authority is not canonical");
  }
  const exactKeys = [
    "authorityKind",
    "namespace",
    "observation",
    "operation",
    "providerObservation",
    "providerPolicy",
    "producerOidc",
    "productionReceipt",
    "repository",
    "reviewedWorkflowRun",
    "runAttempt",
    "runId",
    "schemaVersion",
    "sourceSha",
    "workflowPath",
  ];
  if (
    authority === null ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    Object.keys(authority).sort().join("\n") !== exactKeys.sort().join("\n") ||
    authority.schemaVersion !== 1 ||
    authority.authorityKind !==
      "reviewed-remote-db-observation-production/v1" ||
    authority.namespace !== namespace ||
    authority.sourceSha !== expectedSourceSha ||
    authority.workflowPath !== RELEASE_WORKFLOW_PATH ||
    authority.operation !== PRODUCTION_OPERATION ||
    !RUN_ID_PATTERN.test(authority.runId ?? "") ||
    !RUN_ID_PATTERN.test(authority.runAttempt ?? "") ||
    !REPOSITORY_PATTERN.test(authority.repository ?? "") ||
    authority.repository !== approvalPolicy?.repository ||
    !sameReference(authority.observation, observationReference)
  ) {
    throw new Error("Reviewed remote DB production authority binding differs");
  }
  if (authority.runId === currentWorkflowRunId) {
    throw new Error(
      "Remote DB observation must come from a distinct completed prior run",
    );
  }
  assertReference({ namespace, reference: authority.productionReceipt });
  assertReference({ namespace, reference: authority.providerObservation });
  assertReference({ namespace, reference: authority.providerPolicy });
  assertReference({ namespace, reference: authority.producerOidc });
  assertReference({ namespace, reference: authority.reviewedWorkflowRun });
  const [production] = await Promise.all([
    readRemoteDbObservationProductionAuthority({
      store,
      namespace,
      reference: authority.productionReceipt,
      observationReference,
      expectedSourceSha,
      expectedRunId: authority.runId,
      expectedRunAttempt: authority.runAttempt,
      contract,
      approvalPolicy,
      now,
    }),
    readReviewedWorkflowRunAuthority({
      namespace,
      repository: authority.repository,
      expectedRunId: authority.runId,
      expectedRunAttempt: authority.runAttempt,
      expectedSourceSha,
      expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
      reference: authority.reviewedWorkflowRun,
      store,
    }),
  ]);
  if (
    !sameReference(
      authority.providerObservation,
      production.authority.providerObservation,
    ) ||
    !sameReference(
      authority.providerPolicy,
      production.authority.providerPolicy,
    ) ||
    !sameReference(authority.producerOidc, production.authority.producerOidc)
  ) {
    throw new Error("Reviewed remote DB production provenance differs");
  }
  return {
    authority,
    bytes: Buffer.from(stored.bytes),
    reference,
    remoteObservation: production.remoteObservation,
    providerObservation: production.providerObservation,
    producerOidc: production.producerOidc,
  };
};

export const putReviewedRemoteDbObservationProductionAuthority = async ({
  store,
  namespace,
  sourceSha,
  producerRunId,
  producerRunAttempt,
  currentWorkflowRunId,
  repository,
  observationReference,
  productionReceiptReference,
  reviewedWorkflowRunReference,
  contract,
  approvalPolicy,
  now = Date.now,
}) => {
  assertStore(store);
  assertReference({ namespace, reference: observationReference });
  assertReference({ namespace, reference: productionReceiptReference });
  assertReference({ namespace, reference: reviewedWorkflowRunReference });
  if (
    producerRunId === currentWorkflowRunId ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !RUN_ID_PATTERN.test(producerRunId ?? "") ||
    !RUN_ID_PATTERN.test(producerRunAttempt ?? "") ||
    !RUN_ID_PATTERN.test(currentWorkflowRunId ?? "") ||
    !REPOSITORY_PATTERN.test(repository ?? "") ||
    repository !== approvalPolicy?.repository
  ) {
    throw new Error(
      "Remote DB observation producer must be a distinct prior run",
    );
  }
  const [production] = await Promise.all([
    readRemoteDbObservationProductionAuthority({
      store,
      namespace,
      reference: productionReceiptReference,
      observationReference,
      expectedSourceSha: sourceSha,
      expectedRunId: producerRunId,
      expectedRunAttempt: producerRunAttempt,
      contract,
      approvalPolicy,
      now,
    }),
    readReviewedWorkflowRunAuthority({
      namespace,
      repository,
      expectedRunId: producerRunId,
      expectedRunAttempt: producerRunAttempt,
      expectedSourceSha: sourceSha,
      expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
      reference: reviewedWorkflowRunReference,
      store,
    }),
  ]);
  const value = {
    schemaVersion: 1,
    authorityKind: "reviewed-remote-db-observation-production/v1",
    namespace,
    sourceSha,
    workflowPath: RELEASE_WORKFLOW_PATH,
    operation: PRODUCTION_OPERATION,
    runId: producerRunId,
    runAttempt: producerRunAttempt,
    repository,
    observation: { ...observationReference },
    providerObservation: {
      ...production.authority.providerObservation,
    },
    providerPolicy: { ...production.authority.providerPolicy },
    producerOidc: { ...production.authority.producerOidc },
    productionReceipt: { ...productionReceiptReference },
    reviewedWorkflowRun: { ...reviewedWorkflowRunReference },
  };
  const stored = await putExactAuthority({
    store,
    namespace,
    value,
    mediaType: REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
    label: "Reviewed remote DB production authority",
  });
  await readReviewedRemoteDbObservationProductionAuthority({
    store,
    namespace,
    reference: stored.reference,
    observationReference,
    expectedSourceSha: sourceSha,
    currentWorkflowRunId,
    contract,
    approvalPolicy,
    now,
  });
  return stored;
};
