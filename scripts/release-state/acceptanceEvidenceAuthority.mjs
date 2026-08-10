import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  assertExactKeys,
  assertImmutableObjectReference,
  compareUtf8,
  isRecord,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

export const CONTINUOUS_PROBE_SOURCE_KIND =
  "continuous-production-probe-source/v2";
export const CONTINUOUS_PROBE_SAMPLE_KIND =
  "continuous-production-probe-sample/v1";
export const CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-probe-sample+json;version=1";
export const CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-probe-chain-commit+json;version=1";
export const CONTINUOUS_HTTP_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-http-receipt+json;version=1";
export const CONTINUOUS_HTTP_BODY_MEDIA_TYPE = "application/octet-stream";
export const CONTINUOUS_PROVIDER_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-provider-receipt+json;version=1";
export const CONTINUOUS_PROVIDER_RESPONSE_MEDIA_TYPE =
  "application/vnd.vercel.alias-response+json";
export const GITHUB_OIDC_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1";
export const RELEASE_A_AUTHORITY_BUNDLE_KIND =
  "release-a-evidence-authority/v1";
export const RELEASE_A_AUTHORITY_BUNDLE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-a-evidence-authority+json;version=1";
export const RELEASE_A_AUTHORITY_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-a-observation-receipt+json;version=1";
export const RELEASE_A_RAW_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-a-raw-observation+json;version=1";
export const RELEASE_A_SOURCE_RESPONSE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-a-evidence+json;version=1";
export const RELEASE_A_SOURCE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-a-source-receipt+json;version=1";
export const RELEASE_A_AUTHORITY_SOURCE_KIND =
  "release-a-evidence-authority-source/v1";
export const COMPANION_RECOVERY_SOURCE_KIND =
  "companion-recovery-drill-source/v2";
export const CONTINUOUS_CHAIN_AUTHORITY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-chain-authority+json;version=1";

const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_CHAIN_LENGTH = 4096;
const MAX_RELEASE_A_REFERENCES = 8192;
const HTTP_TIMEOUT_MILLISECONDS = 15_000;
const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SOURCE_KEYS = [
  "authorityBundle",
  "sampleChainHead",
  "schemaVersion",
  "sourceKind",
];
const SAMPLE_KEYS = [
  "collectorIdentity",
  "evidenceKind",
  "namespace",
  "operationId",
  "previousSample",
  "results",
  "schemaVersion",
  "sourceSha",
  "standardBindingId",
];
const SAMPLE_RESULT_KEYS = [
  "httpReceipt",
  "productionDomain",
  "providerDeploymentId",
  "providerLookupReceipt",
  "responseSha256",
  "status",
];
const CHAIN_COMMIT_KEYS = [
  "bindingId",
  "commitKind",
  "namespace",
  "operationId",
  "previousCommit",
  "sampleReference",
  "schemaVersion",
  "sequence",
  "sourceSha",
];
const HTTP_RECEIPT_KEYS = [
  "bindingId",
  "bodyReference",
  "bodySha256",
  "buildId",
  "collectedAt",
  "contentType",
  "namespace",
  "operationId",
  "productionDomain",
  "providerDeploymentId",
  "providerProjectId",
  "receiptKind",
  "requestUrl",
  "responseDate",
  "responseUrl",
  "schemaVersion",
  "sourceSha",
  "status",
  "variantId",
];
const PROVIDER_RECEIPT_KEYS = [
  "bindingId",
  "collectedAt",
  "namespace",
  "operationId",
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
const OIDC_RECEIPT_KEYS = [
  "audience",
  "claims",
  "issuer",
  "kind",
  "schemaVersion",
  "signingKey",
  "subject",
  "tokenSha256",
  "verifiedAt",
];
const AUTHORITY_BUNDLE_KEYS = [
  "collectorIdentity",
  "evidenceKind",
  "namespace",
  "operationId",
  "receipts",
  "releaseAEvidenceSha256",
  "schemaVersion",
  "sourceSha",
];
const AUTHORITY_RECEIPT_KEYS = [
  "assertionSha256",
  "evidenceKind",
  "evidencePath",
  "namespace",
  "operationId",
  "originalReference",
  "schemaVersion",
  "sourceReference",
  "sourceSha",
];
const AUTHORITY_SOURCE_KEYS = ["references", "schemaVersion", "sourceKind"];
const AUTHORITY_SOURCE_REFERENCE_KEYS = [
  "evidencePath",
  "originalReference",
  "sourceReference",
];
const RAW_OBSERVATION_KEYS = [
  "assertion",
  "collectorIdentity",
  "evidenceKind",
  "evidencePath",
  "namespace",
  "operationId",
  "schemaVersion",
  "sourceTransaction",
  "sourceSha",
];
const RELEASE_A_SOURCE_RECEIPT_KEYS = [
  "bodyReference",
  "bodySha256",
  "collectedAt",
  "collectorIdentity",
  "contentType",
  "namespace",
  "operationId",
  "receiptKind",
  "releaseAEvidenceSha256",
  "requestUrl",
  "responseDate",
  "responseUrl",
  "schemaVersion",
  "sourceSha",
  "status",
];
const CONTINUOUS_CHAIN_AUTHORITY_KEYS = [
  "collectorIdentity",
  "evidenceKind",
  "namespace",
  "operationId",
  "schemaVersion",
  "sourceSha",
  "standardBindingId",
];
const EVENT_REFERENCE_PATTERN = (namespace) =>
  new RegExp(
    `^release-state://${namespace}/events/([1-9][0-9]*)/([0-9a-f]{64})$`,
  );

const assertStore = (store, namespace) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error("Acceptance evidence Release State store is invalid");
  }
};

const assertCanonicalTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical ISO timestamp`);
  }
  return milliseconds;
};

const assertHttpTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds)) {
    throw new Error(`${label} is invalid`);
  }
  return milliseconds;
};

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const putExactEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const input = Buffer.from(bytes);
  const expected = immutableReference(namespace, input);
  const receipt = await store.putEvidence({ bytes: input, mediaType });
  if (
    receipt?.uri !== expected.uri ||
    receipt?.sha256 !== expected.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== input.length ||
    typeof receipt.committedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new Error(`${label} immutable-store receipt differs`);
  }
  const stored = await store.readEvidence({ sha256: expected.sha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    !stored.bytes.equals(input) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return { reference: expected, committedAt: receipt.committedAt };
};

const readExactEvidence = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
  canonical = false,
}) => {
  assertImmutableObjectReference(reference, namespace, label);
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType ||
    !Number.isFinite(Date.parse(stored.committedAt))
  ) {
    throw new Error(`${label} immutable object is missing or differs`);
  }
  if (canonical) parseCanonicalJsonBytes(stored.bytes, label);
  return stored;
};

const readBoundedResponse = async (response, label) => {
  if (
    !response ||
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.arrayBuffer !== "function" ||
    typeof response.headers?.get !== "function" ||
    response.redirected === true
  ) {
    throw new Error(`${label} response is invalid or redirected`);
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_HTTP_BYTES)
  ) {
    throw new Error(`${label} response is oversized`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_HTTP_BYTES) {
    throw new Error(`${label} response is oversized`);
  }
  return bytes;
};

const fetchExact = async ({ fetchImpl, url, headers, label }) => {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw new Error(`${label} request failed`);
  }
  if (response.url !== url) {
    throw new Error(`${label} response URL differs`);
  }
  return { response, bytes: await readBoundedResponse(response, label) };
};

const parseProviderDeploymentId = (bytes, productionDomain, projectId) => {
  let value;
  try {
    value = parseJsonStrict(bytes.toString("utf8"), "Provider alias response");
  } catch {
    throw new Error("Provider alias response is not strict JSON");
  }
  const topLevel = value?.deploymentId;
  const nested = value?.deployment?.id;
  const deploymentId = topLevel ?? nested;
  if (
    value?.alias !== productionDomain ||
    value?.projectId !== projectId ||
    (value?.redirect !== null && value?.redirect !== undefined) ||
    typeof deploymentId !== "string" ||
    deploymentId.length === 0 ||
    deploymentId.length > 255 ||
    (topLevel !== undefined && topLevel !== deploymentId) ||
    (nested !== undefined && nested !== deploymentId)
  ) {
    throw new Error("Provider alias response identity differs");
  }
  return deploymentId;
};

const assertPublicIdentityBody = (bytes, binding) => {
  const value = parseCanonicalJsonBytes(bytes, "Continuous public identity");
  if (
    value.sourceSha !== binding.sourceSha ||
    value.buildId !== binding.buildId ||
    (binding.publicIdentityKind === "release-identity-v1" &&
      (value.variantId !== binding.variantId ||
        value.releaseRole !== binding.releaseRole)) ||
    (binding.publicIdentityKind === "legacy-bootstrap-v1" &&
      (value.kind !== "event-shopping-planner-release-capabilities" ||
        value.version !== 1 ||
        value.releaseChannel !== "release-a"))
  ) {
    throw new Error("Continuous public identity differs from the binding");
  }
  return value;
};

const assertProviderPolicy = (providerPolicy, binding) => {
  if (
    !isRecord(providerPolicy) ||
    providerPolicy.bindingStatus !== "configured" ||
    providerPolicy.expectedProjectId !== binding.providerProjectId ||
    typeof providerPolicy.expectedTeamId !== "string" ||
    providerPolicy.expectedTeamId.length === 0 ||
    !Array.isArray(providerPolicy.ownedProductionDomains) ||
    providerPolicy.ownedProductionDomains.length === 0 ||
    !isRecord(providerPolicy.observationPolicy) ||
    typeof providerPolicy.observationPolicy.apiBaseUrl !== "string" ||
    !Number.isSafeInteger(
      providerPolicy.observationPolicy.maxFutureClockSkewSeconds,
    ) ||
    !Number.isSafeInteger(
      providerPolicy.observationPolicy.maxResponseAgeSeconds,
    )
  ) {
    throw new Error("Continuous collector provider policy is invalid");
  }
  const domains = [...providerPolicy.ownedProductionDomains].sort(compareUtf8);
  if (
    new Set(domains).size !== domains.length ||
    domains.some(
      (domain) =>
        typeof domain !== "string" ||
        !DOMAIN_PATTERN.test(domain) ||
        domain !== domain.toLowerCase(),
    )
  ) {
    throw new Error("Continuous collector production domains are invalid");
  }
  return domains;
};

const assertOidcReceipt = async ({
  store,
  namespace,
  reference,
  sourceSha,
}) => {
  const stored = await readExactEvidence({
    store,
    namespace,
    reference,
    mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
    label: "Continuous collector OIDC receipt",
    canonical: true,
  });
  const receipt = parseCanonicalJsonBytes(
    stored.bytes,
    "Continuous collector OIDC receipt",
  );
  assertExactKeys(
    receipt,
    OIDC_RECEIPT_KEYS,
    "Continuous collector OIDC receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "github-actions-oidc-verification/v1" ||
    receipt.issuer !== "https://token.actions.githubusercontent.com" ||
    receipt.claims?.sourceSha !== sourceSha ||
    receipt.claims?.workflowSha !== sourceSha ||
    receipt.claims?.eventName !== "workflow_dispatch" ||
    receipt.claims?.ref !== "refs/heads/main" ||
    receipt.claims?.refProtected !== true ||
    typeof receipt.claims?.workflowRef !== "string" ||
    !receipt.claims.workflowRef.endsWith(
      "/.github/workflows/release.yml@refs/heads/main",
    ) ||
    typeof receipt.claims.runId !== "string" ||
    !/^[1-9][0-9]*$/.test(receipt.claims.runId) ||
    typeof receipt.claims.runAttempt !== "string" ||
    !/^[1-9][0-9]*$/.test(receipt.claims.runAttempt) ||
    typeof receipt.claims.jti !== "string" ||
    receipt.claims.jti.length === 0
  ) {
    throw new Error("Continuous collector OIDC identity is not protected");
  }
  const verifiedAt = assertCanonicalTimestamp(
    receipt.verifiedAt,
    "Continuous collector OIDC verification time",
  );
  const issuedAt = assertCanonicalTimestamp(
    receipt.claims.issuedAt,
    "Continuous collector OIDC issue time",
  );
  const notBefore = assertCanonicalTimestamp(
    receipt.claims.notBefore,
    "Continuous collector OIDC not-before",
  );
  const expiresAt = assertCanonicalTimestamp(
    receipt.claims.expiresAt,
    "Continuous collector OIDC expiration",
  );
  const committedAt = assertCanonicalTimestamp(
    stored.committedAt,
    "Continuous collector OIDC store commit",
  );
  if (
    notBefore > verifiedAt ||
    issuedAt > verifiedAt ||
    expiresAt <= verifiedAt ||
    committedAt < verifiedAt ||
    committedAt > expiresAt
  ) {
    throw new Error("Continuous collector OIDC timing is invalid");
  }
  return receipt;
};

const identityPath = (binding) =>
  binding.publicIdentityKind === "release-identity-v1"
    ? "/release-identity.json"
    : "/release-capabilities.json";

const validateContinuousChainAuthority = async ({
  store,
  namespace,
  pendingAcceptance,
  reference,
}) => {
  const stored = await readExactEvidence({
    store,
    namespace,
    reference,
    mediaType: CONTINUOUS_CHAIN_AUTHORITY_MEDIA_TYPE,
    label: "Continuous chain authority",
    canonical: true,
  });
  const authority = parseCanonicalJsonBytes(
    stored.bytes,
    "Continuous chain authority",
  );
  assertExactKeys(
    authority,
    CONTINUOUS_CHAIN_AUTHORITY_KEYS,
    "Continuous chain authority",
  );
  const binding = pendingAcceptance.standardBinding;
  if (
    authority.schemaVersion !== 1 ||
    authority.evidenceKind !== "continuous-chain-authority/v1" ||
    authority.namespace !== namespace ||
    authority.operationId !== pendingAcceptance.operationId ||
    authority.sourceSha !== binding.sourceSha ||
    authority.standardBindingId !== binding.bindingId
  ) {
    throw new Error(
      "Continuous chain authority differs from pending acceptance",
    );
  }
  await assertOidcReceipt({
    store,
    namespace,
    reference: authority.collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  return authority;
};

export const initializeContinuousProbeCollection = async ({
  store,
  namespace,
  pendingAcceptance,
  collectorIdentity,
}) => {
  assertStore(store, namespace);
  const binding = pendingAcceptance?.standardBinding;
  if (!isRecord(binding) || binding.releaseRole !== "standard") {
    throw new Error("Continuous chain initialization binding is invalid");
  }
  await assertOidcReceipt({
    store,
    namespace,
    reference: collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  const authorityBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "continuous-chain-authority/v1",
    namespace,
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    standardBindingId: binding.bindingId,
    collectorIdentity: structuredClone(collectorIdentity),
  });
  const stored = await putExactEvidence({
    store,
    namespace,
    bytes: authorityBytes,
    mediaType: CONTINUOUS_CHAIN_AUTHORITY_MEDIA_TYPE,
    label: "Continuous chain authority",
  });
  return {
    authorityReference: stored.reference,
    source: {
      schemaVersion: 2,
      sourceKind: CONTINUOUS_PROBE_SOURCE_KIND,
      authorityBundle: stored.reference,
      sampleChainHead: null,
    },
  };
};

export const createEmptyContinuousProbeSource = ({
  namespace,
  authorityBundle,
}) => {
  assertImmutableObjectReference(
    authorityBundle,
    namespace,
    "Release A authority bundle",
  );
  return {
    schemaVersion: 2,
    sourceKind: CONTINUOUS_PROBE_SOURCE_KIND,
    authorityBundle: structuredClone(authorityBundle),
    sampleChainHead: null,
  };
};

const resolveContinuousChainCommit = async ({
  store,
  namespace,
  reference,
  pendingAcceptance,
}) => {
  const stored = await readExactEvidence({
    store,
    namespace,
    reference,
    mediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
    label: "Continuous chain commit",
    canonical: true,
  });
  const commit = parseCanonicalJsonBytes(
    stored.bytes,
    "Continuous chain commit",
  );
  assertExactKeys(commit, CHAIN_COMMIT_KEYS, "Continuous chain commit");
  const binding = pendingAcceptance.standardBinding;
  if (
    commit.schemaVersion !== 1 ||
    commit.commitKind !== "continuous-probe-chain-commit/v1" ||
    commit.namespace !== namespace ||
    commit.operationId !== pendingAcceptance.operationId ||
    commit.sourceSha !== binding.sourceSha ||
    commit.bindingId !== binding.bindingId ||
    !Number.isSafeInteger(commit.sequence) ||
    commit.sequence < 1
  ) {
    throw new Error("Continuous chain commit binding differs");
  }
  assertImmutableObjectReference(
    commit.sampleReference,
    namespace,
    "Continuous chain commit sample",
  );
  if (commit.previousCommit !== null) {
    assertImmutableObjectReference(
      commit.previousCommit,
      namespace,
      "Continuous previous chain commit",
    );
  }
  return { commit, reference: structuredClone(reference), stored };
};

const assertCanonicalContinuousChainHead = async ({
  store,
  pendingAcceptance,
  expectedHead,
  expectedSequence = null,
}) => {
  if (typeof store.readAcceptanceEvidenceChain !== "function") {
    throw new Error("Canonical continuous chain-head store is unavailable");
  }
  const binding = pendingAcceptance.standardBinding;
  const head = await store.readAcceptanceEvidenceChain({
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    bindingId: binding.bindingId,
  });
  if (
    head === null ||
    !sameCanonicalValue(head.head, expectedHead) ||
    (expectedSequence !== null && head.sequence !== expectedSequence)
  ) {
    throw new Error("Continuous source differs from the canonical CAS head");
  }
  return head;
};

const eventReferenceForRecord = (namespace, record) => ({
  uri: `release-state://${namespace}/events/${record.sequence}/${record.eventHash}`,
  sha256: record.eventHash,
});

const resolveEventReference = ({ current, namespace, reference, label }) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  const match = reference.uri.match(EVENT_REFERENCE_PATTERN(namespace));
  if (!match || match[2] !== reference.sha256) {
    throw new Error(`${label} is not a Release State event reference`);
  }
  const sequence = Number(match[1]);
  const candidates = current?.records?.filter(
    (record) =>
      record.sequence === sequence &&
      record.eventHash === reference.sha256 &&
      sameCanonicalValue(eventReferenceForRecord(namespace, record), reference),
  );
  if (candidates?.length !== 1) {
    throw new Error(`${label} is absent or ambiguous`);
  }
  return candidates[0];
};

const jsonPointer = (segments) =>
  `/${segments
    .map((segment) =>
      String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
    )
    .join("/")}`;

const withoutReferenceFields = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.endsWith("Ref")),
  );

const collectReleaseAEvidenceReferences = (evidence) => {
  const entries = [];
  const visit = (value, segments) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...segments, index]));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childSegments = [...segments, key];
      if (key.endsWith("Ref") && typeof child === "string") {
        entries.push({
          evidencePath: jsonPointer(childSegments),
          originalReference: child,
          assertion: withoutReferenceFields(value),
        });
      } else {
        visit(child, childSegments);
      }
    }
  };
  visit(evidence, []);
  entries.sort((left, right) =>
    compareUtf8(left.evidencePath, right.evidencePath),
  );
  if (
    entries.length === 0 ||
    entries.length > MAX_RELEASE_A_REFERENCES ||
    new Set(entries.map(({ evidencePath }) => evidencePath)).size !==
      entries.length
  ) {
    throw new Error("Release A evidence reference set is invalid");
  }
  return entries;
};

export const putReleaseARawObservation = async ({
  store,
  namespace,
  operationId,
  sourceSha,
  evidencePath,
  assertion,
  collectorIdentity,
  sourceTransaction,
}) => {
  assertStore(store, namespace);
  await assertOidcReceipt({
    store,
    namespace,
    reference: collectorIdentity,
    sourceSha,
  });
  if (
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    typeof evidencePath !== "string" ||
    !evidencePath.startsWith("/") ||
    !isRecord(assertion)
  ) {
    throw new Error("Release A raw observation identity is invalid");
  }
  assertImmutableObjectReference(
    sourceTransaction,
    namespace,
    "Release A source transaction",
  );
  const bytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "release-a-raw-observation/v1",
    namespace,
    operationId,
    sourceSha,
    evidencePath,
    assertion: structuredClone(assertion),
    collectorIdentity: structuredClone(collectorIdentity),
    sourceTransaction: structuredClone(sourceTransaction),
  });
  return (
    await putExactEvidence({
      store,
      namespace,
      bytes,
      mediaType: RELEASE_A_RAW_OBSERVATION_MEDIA_TYPE,
      label: `Release A raw observation ${evidencePath}`,
    })
  ).reference;
};

const resolveReleaseASourceReference = async ({
  store,
  current,
  namespace,
  reference,
  expected,
  operationId,
  sourceSha,
  releaseAEvidence,
  releaseAEvidenceSha256,
}) => {
  if (reference.uri.startsWith(`release-state://${namespace}/evidence/`)) {
    const stored = await readExactEvidence({
      store,
      namespace,
      reference,
      mediaType: RELEASE_A_RAW_OBSERVATION_MEDIA_TYPE,
      label: `Release A raw observation ${expected.evidencePath}`,
      canonical: true,
    });
    const observation = parseCanonicalJsonBytes(
      stored.bytes,
      `Release A raw observation ${expected.evidencePath}`,
    );
    assertExactKeys(
      observation,
      RAW_OBSERVATION_KEYS,
      `Release A raw observation ${expected.evidencePath}`,
    );
    if (
      observation.schemaVersion !== 1 ||
      observation.evidenceKind !== "release-a-raw-observation/v1" ||
      observation.namespace !== namespace ||
      observation.operationId !== operationId ||
      observation.sourceSha !== sourceSha ||
      observation.evidencePath !== expected.evidencePath ||
      !sameCanonicalValue(observation.assertion, expected.assertion)
    ) {
      throw new Error("Release A raw observation differs from its assertion");
    }
    await assertOidcReceipt({
      store,
      namespace,
      reference: observation.collectorIdentity,
      sourceSha,
    });
    const transactionStored = await readExactEvidence({
      store,
      namespace,
      reference: observation.sourceTransaction,
      mediaType: RELEASE_A_SOURCE_RECEIPT_MEDIA_TYPE,
      label: `Release A source transaction ${expected.evidencePath}`,
      canonical: true,
    });
    const transaction = parseCanonicalJsonBytes(
      transactionStored.bytes,
      `Release A source transaction ${expected.evidencePath}`,
    );
    assertExactKeys(
      transaction,
      RELEASE_A_SOURCE_RECEIPT_KEYS,
      `Release A source transaction ${expected.evidencePath}`,
    );
    if (
      transaction.schemaVersion !== 1 ||
      transaction.receiptKind !== "release-a-source-http-response/v1" ||
      transaction.namespace !== namespace ||
      transaction.operationId !== operationId ||
      transaction.sourceSha !== sourceSha ||
      transaction.releaseAEvidenceSha256 !== releaseAEvidenceSha256 ||
      transaction.status !== 200 ||
      transaction.bodySha256 !== transaction.bodyReference?.sha256 ||
      !/^application\/json(?:\s*;|$)/i.test(transaction.contentType)
    ) {
      throw new Error("Release A source transaction binding differs");
    }
    if (
      !sameCanonicalValue(
        transaction.collectorIdentity,
        observation.collectorIdentity,
      )
    ) {
      throw new Error("Release A source transaction collector differs");
    }
    await assertOidcReceipt({
      store,
      namespace,
      reference: transaction.collectorIdentity,
      sourceSha,
    });
    const bodyStored = await readExactEvidence({
      store,
      namespace,
      reference: transaction.bodyReference,
      mediaType: RELEASE_A_SOURCE_RESPONSE_MEDIA_TYPE,
      label: "Release A source response",
      canonical: true,
    });
    const bodyEvidence = parseCanonicalJsonBytes(
      bodyStored.bytes,
      "Release A source response",
    );
    const bodyEntry = collectReleaseAEvidenceReferences(bodyEvidence).find(
      ({ evidencePath }) => evidencePath === expected.evidencePath,
    );
    if (
      sha256Bytes(bodyStored.bytes) !== releaseAEvidenceSha256 ||
      !sameCanonicalValue(bodyEvidence, releaseAEvidence) ||
      bodyEntry?.originalReference !== expected.originalReference ||
      !sameCanonicalValue(bodyEntry?.assertion, expected.assertion) ||
      Date.parse(transactionStored.committedAt) <
        assertCanonicalTimestamp(
          transaction.collectedAt,
          "Release A source collection time",
        ) ||
      !Number.isFinite(Date.parse(transaction.responseDate))
    ) {
      throw new Error("Release A source response differs from frozen evidence");
    }
    return reference;
  }
  const eventRecord = resolveEventReference({
    current,
    namespace,
    reference,
    label: `Release A event observation ${expected.evidencePath}`,
  });
  if (
    expected.evidencePath !== "/automatedGates/rollback/evidenceRef" ||
    eventRecord.event.eventType !== "package-redeploy-activated" ||
    eventRecord.event.operationId === operationId
  ) {
    throw new Error(
      "Release A event observation is not an independent recovery drill",
    );
  }
  return reference;
};

export const produceReleaseAEvidenceAuthorityBundle = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  releaseAEvidence,
  releaseAEvidenceSha256,
  source,
  collectorIdentity,
}) => {
  assertStore(store, namespace);
  const binding = pendingAcceptance?.standardBinding;
  if (
    !isRecord(binding) ||
    releaseAEvidence?.release?.releaseId !== pendingAcceptance.operationId ||
    releaseAEvidence.release?.commitSha !== binding.sourceSha ||
    releaseAEvidence.canary?.buildSha !== binding.buildId ||
    !SHA256_PATTERN.test(releaseAEvidenceSha256) ||
    sha256Json(releaseAEvidence) !== releaseAEvidenceSha256
  ) {
    throw new Error("Release A authority evidence identity is invalid");
  }
  await assertOidcReceipt({
    store,
    namespace,
    reference: collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  assertExactKeys(source, AUTHORITY_SOURCE_KEYS, "Release A authority source");
  if (
    source.schemaVersion !== 1 ||
    source.sourceKind !== RELEASE_A_AUTHORITY_SOURCE_KIND ||
    !Array.isArray(source.references)
  ) {
    throw new Error("Release A authority source identity is invalid");
  }
  const expected = collectReleaseAEvidenceReferences(releaseAEvidence);
  if (source.references.length !== expected.length) {
    throw new Error("Release A authority source reference set is incomplete");
  }
  const receipts = [];
  for (const [index, sourceEntry] of source.references.entries()) {
    assertExactKeys(
      sourceEntry,
      AUTHORITY_SOURCE_REFERENCE_KEYS,
      `Release A authority source reference ${index}`,
    );
    const expectedEntry = expected[index];
    if (
      sourceEntry.evidencePath !== expectedEntry.evidencePath ||
      sourceEntry.originalReference !== expectedEntry.originalReference
    ) {
      throw new Error("Release A authority source order or reference differs");
    }
    assertExactKeys(
      sourceEntry.sourceReference,
      ["sha256", "uri"],
      `Release A authority source object ${index}`,
    );
    await resolveReleaseASourceReference({
      store,
      current,
      namespace,
      reference: sourceEntry.sourceReference,
      expected: expectedEntry,
      operationId: pendingAcceptance.operationId,
      sourceSha: binding.sourceSha,
      releaseAEvidence,
      releaseAEvidenceSha256,
    });
    const receiptBytes = canonicalJsonBytes({
      schemaVersion: 1,
      evidenceKind: "release-a-observation-receipt/v1",
      namespace,
      operationId: pendingAcceptance.operationId,
      sourceSha: binding.sourceSha,
      evidencePath: expectedEntry.evidencePath,
      originalReference: expectedEntry.originalReference,
      assertionSha256: sha256Json(expectedEntry.assertion),
      sourceReference: structuredClone(sourceEntry.sourceReference),
    });
    receipts.push(
      (
        await putExactEvidence({
          store,
          namespace,
          bytes: receiptBytes,
          mediaType: RELEASE_A_AUTHORITY_RECEIPT_MEDIA_TYPE,
          label: `Release A authority receipt ${expectedEntry.evidencePath}`,
        })
      ).reference,
    );
  }
  const bundleBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: RELEASE_A_AUTHORITY_BUNDLE_KIND,
    namespace,
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    releaseAEvidenceSha256,
    collectorIdentity: structuredClone(collectorIdentity),
    receipts,
  });
  const stored = await putExactEvidence({
    store,
    namespace,
    bytes: bundleBytes,
    mediaType: RELEASE_A_AUTHORITY_BUNDLE_MEDIA_TYPE,
    label: "Release A authority bundle",
  });
  return {
    bundle: parseCanonicalJsonBytes(bundleBytes, "Release A authority bundle"),
    bundleBytes,
    reference: stored.reference,
    sha256: stored.reference.sha256,
  };
};

export const validateReleaseAEvidenceAuthorityBundle = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  releaseAEvidence,
  releaseAEvidenceSha256,
  reference,
}) => {
  const stored = await readExactEvidence({
    store,
    namespace,
    reference,
    mediaType: RELEASE_A_AUTHORITY_BUNDLE_MEDIA_TYPE,
    label: "Release A authority bundle",
    canonical: true,
  });
  const bundle = parseCanonicalJsonBytes(
    stored.bytes,
    "Release A authority bundle",
  );
  assertExactKeys(bundle, AUTHORITY_BUNDLE_KEYS, "Release A authority bundle");
  const binding = pendingAcceptance.standardBinding;
  if (
    bundle.schemaVersion !== 1 ||
    bundle.evidenceKind !== RELEASE_A_AUTHORITY_BUNDLE_KIND ||
    bundle.namespace !== namespace ||
    bundle.operationId !== pendingAcceptance.operationId ||
    bundle.sourceSha !== binding.sourceSha ||
    bundle.releaseAEvidenceSha256 !== releaseAEvidenceSha256 ||
    sha256Json(releaseAEvidence) !== releaseAEvidenceSha256 ||
    !Array.isArray(bundle.receipts)
  ) {
    throw new Error("Release A authority bundle identity differs");
  }
  await assertOidcReceipt({
    store,
    namespace,
    reference: bundle.collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  const expected = collectReleaseAEvidenceReferences(releaseAEvidence);
  if (bundle.receipts.length !== expected.length) {
    throw new Error("Release A authority receipt set is incomplete");
  }
  for (const [index, receiptReference] of bundle.receipts.entries()) {
    const receiptStored = await readExactEvidence({
      store,
      namespace,
      reference: receiptReference,
      mediaType: RELEASE_A_AUTHORITY_RECEIPT_MEDIA_TYPE,
      label: `Release A authority receipt ${index}`,
      canonical: true,
    });
    const receipt = parseCanonicalJsonBytes(
      receiptStored.bytes,
      `Release A authority receipt ${index}`,
    );
    assertExactKeys(
      receipt,
      AUTHORITY_RECEIPT_KEYS,
      `Release A authority receipt ${index}`,
    );
    const expectedEntry = expected[index];
    if (
      receipt.schemaVersion !== 1 ||
      receipt.evidenceKind !== "release-a-observation-receipt/v1" ||
      receipt.namespace !== namespace ||
      receipt.operationId !== pendingAcceptance.operationId ||
      receipt.sourceSha !== binding.sourceSha ||
      receipt.evidencePath !== expectedEntry.evidencePath ||
      receipt.originalReference !== expectedEntry.originalReference ||
      receipt.assertionSha256 !== sha256Json(expectedEntry.assertion)
    ) {
      throw new Error("Release A authority receipt differs from the evidence");
    }
    await resolveReleaseASourceReference({
      store,
      current,
      namespace,
      reference: receipt.sourceReference,
      expected: expectedEntry,
      operationId: pendingAcceptance.operationId,
      sourceSha: binding.sourceSha,
      releaseAEvidence,
      releaseAEvidenceSha256,
    });
  }
  return bundle;
};

export const collectReleaseAEvidenceAuthority = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  providerPolicy,
  evidenceUrl,
  evidenceToken,
  collectorIdentity,
  continuousSource,
  rollbackTerminalEvent = null,
  validateEvidence,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
}) => {
  assertStore(store, namespace);
  const binding = pendingAcceptance?.standardBinding;
  if (
    !isRecord(binding) ||
    binding.releaseRole !== "standard" ||
    typeof validateEvidence !== "function" ||
    typeof fetchImpl !== "function" ||
    typeof evidenceToken !== "string" ||
    evidenceToken.length < 8
  ) {
    throw new Error("Release A authority collector options are invalid");
  }
  assertExactKeys(continuousSource, SOURCE_KEYS, "Continuous probe source");
  if (
    continuousSource.schemaVersion !== 2 ||
    continuousSource.sourceKind !== CONTINUOUS_PROBE_SOURCE_KIND ||
    continuousSource.sampleChainHead === null
  ) {
    throw new Error("Release A authority requires a nonempty continuous chain");
  }
  assertImmutableObjectReference(
    continuousSource.sampleChainHead,
    namespace,
    "Continuous sample chain head",
  );
  await validateContinuousChainAuthority({
    store,
    namespace,
    pendingAcceptance,
    reference: continuousSource.authorityBundle,
  });
  await assertCanonicalContinuousChainHead({
    store,
    pendingAcceptance,
    expectedHead: continuousSource.sampleChainHead,
  });
  await assertOidcReceipt({
    store,
    namespace,
    reference: collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  let parsedUrl;
  try {
    parsedUrl = new URL(evidenceUrl);
  } catch {
    throw new Error("Release A evidence endpoint is invalid");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new Error("Release A evidence endpoint is not trusted HTTPS");
  }
  const nowMilliseconds = Number(clock());
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Release A authority collector clock is invalid");
  }
  const transaction = await fetchExact({
    fetchImpl,
    url: parsedUrl.href,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${evidenceToken}`,
    },
    label: "Release A evidence source",
  });
  if (
    transaction.response.status !== 200 ||
    !/^application\/json(?:\s*;|$)/i.test(
      transaction.response.headers.get("content-type") ?? "",
    )
  ) {
    throw new Error("Release A evidence source response did not pass");
  }
  const releaseAEvidence = parseCanonicalJsonBytes(
    transaction.bytes,
    "Release A evidence source",
  );
  const validationErrors = await validateEvidence(releaseAEvidence, {
    nowMs: nowMilliseconds,
  });
  if (!Array.isArray(validationErrors) || validationErrors.length !== 0) {
    throw new Error("Release A evidence source failed the frozen v1 verifier");
  }
  if (
    releaseAEvidence.release?.releaseId !== pendingAcceptance.operationId ||
    releaseAEvidence.release?.commitSha !== binding.sourceSha ||
    releaseAEvidence.canary?.buildSha !== binding.buildId
  ) {
    throw new Error("Release A evidence source binding differs");
  }
  const releaseAEvidenceSha256 = sha256Bytes(transaction.bytes);
  const body = await putExactEvidence({
    store,
    namespace,
    bytes: transaction.bytes,
    mediaType: RELEASE_A_SOURCE_RESPONSE_MEDIA_TYPE,
    label: "Release A evidence source response",
  });
  const collectedAt = new Date(nowMilliseconds).toISOString();
  const receiptBytes = canonicalJsonBytes({
    schemaVersion: 1,
    receiptKind: "release-a-source-http-response/v1",
    namespace,
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    releaseAEvidenceSha256,
    collectorIdentity: structuredClone(collectorIdentity),
    collectedAt,
    requestUrl: parsedUrl.href,
    responseUrl: transaction.response.url,
    status: transaction.response.status,
    responseDate: transaction.response.headers.get("date"),
    contentType: transaction.response.headers.get("content-type"),
    bodySha256: body.reference.sha256,
    bodyReference: body.reference,
  });
  const sourceTransaction = (
    await putExactEvidence({
      store,
      namespace,
      bytes: receiptBytes,
      mediaType: RELEASE_A_SOURCE_RECEIPT_MEDIA_TYPE,
      label: "Release A evidence source receipt",
    })
  ).reference;
  assertReceiptTiming({
    collectedAt,
    responseDate: transaction.response.headers.get("date"),
    committedAt: (
      await store.readEvidence({ sha256: sourceTransaction.sha256 })
    ).committedAt,
    providerPolicy,
    label: "Release A evidence source receipt",
  });
  const entries = collectReleaseAEvidenceReferences(releaseAEvidence);
  const sourceReferences = [];
  for (const entry of entries) {
    let sourceReference;
    if (
      entry.evidencePath === "/automatedGates/rollback/evidenceRef" &&
      rollbackTerminalEvent !== null
    ) {
      sourceReference = structuredClone(rollbackTerminalEvent);
    } else {
      sourceReference = await putReleaseARawObservation({
        store,
        namespace,
        operationId: pendingAcceptance.operationId,
        sourceSha: binding.sourceSha,
        evidencePath: entry.evidencePath,
        assertion: entry.assertion,
        collectorIdentity,
        sourceTransaction,
      });
    }
    sourceReferences.push({
      evidencePath: entry.evidencePath,
      originalReference: entry.originalReference,
      sourceReference,
    });
  }
  const authority = await produceReleaseAEvidenceAuthorityBundle({
    store,
    current,
    namespace,
    pendingAcceptance,
    releaseAEvidence,
    releaseAEvidenceSha256,
    source: {
      schemaVersion: 1,
      sourceKind: RELEASE_A_AUTHORITY_SOURCE_KIND,
      references: sourceReferences,
    },
    collectorIdentity,
  });
  return {
    releaseAEvidence,
    releaseAEvidenceBytes: Buffer.from(transaction.bytes),
    releaseAEvidenceSha256,
    sourceTransaction,
    authority,
    authoritySource: {
      schemaVersion: 1,
      sourceKind: RELEASE_A_AUTHORITY_SOURCE_KIND,
      references: structuredClone(sourceReferences),
    },
    continuousSource: {
      ...structuredClone(continuousSource),
      authorityBundle: authority.reference,
    },
  };
};

export const createCompanionRecoverySource = ({
  current,
  namespace,
  pendingAcceptance,
  authorityBundle,
  terminalEventSha256,
}) => {
  assertImmutableObjectReference(
    authorityBundle,
    namespace,
    "Release A authority bundle",
  );
  if (!SHA256_PATTERN.test(terminalEventSha256)) {
    throw new Error("Companion terminal event SHA-256 is invalid");
  }
  const matches = current?.records?.filter(
    (record) =>
      record.eventHash === terminalEventSha256 &&
      record.event.eventType === "package-redeploy-activated" &&
      record.event.operationId !== pendingAcceptance.operationId,
  );
  if (matches?.length !== 1) {
    throw new Error("Companion terminal event is absent or ambiguous");
  }
  const standardReturns = current.records.filter(
    (record) =>
      record.event.eventType === "observation-started" &&
      record.event.operationId === pendingAcceptance.operationId &&
      sameCanonicalValue(
        record.event.payload?.pendingAcceptance,
        pendingAcceptance,
      ) &&
      record.sequence > matches[0].sequence,
  );
  if (standardReturns.length !== 1) {
    throw new Error("Companion standard-return event is absent or ambiguous");
  }
  return {
    schemaVersion: 2,
    sourceKind: COMPANION_RECOVERY_SOURCE_KIND,
    authorityBundle: structuredClone(authorityBundle),
    packageRedeployTerminalEvent: eventReferenceForRecord(
      namespace,
      matches[0],
    ),
    standardReturnEvent: eventReferenceForRecord(namespace, standardReturns[0]),
  };
};

export const collectContinuousProductionSample = async ({
  store,
  namespace,
  pendingAcceptance,
  providerPolicy,
  providerToken,
  collectorIdentity,
  priorSource,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
}) => {
  assertStore(store, namespace);
  const binding = pendingAcceptance?.standardBinding;
  if (
    !isRecord(binding) ||
    pendingAcceptance.operationId === undefined ||
    binding.releaseRole !== "standard" ||
    typeof providerToken !== "string" ||
    providerToken.length < 8 ||
    typeof fetchImpl !== "function" ||
    typeof store.appendAcceptanceSample !== "function"
  ) {
    throw new Error("Continuous collector options are invalid");
  }
  assertExactKeys(priorSource, SOURCE_KEYS, "Continuous probe source");
  if (
    priorSource.schemaVersion !== 2 ||
    priorSource.sourceKind !== CONTINUOUS_PROBE_SOURCE_KIND ||
    (priorSource.sampleChainHead !== null &&
      !isRecord(priorSource.sampleChainHead))
  ) {
    throw new Error("Continuous probe prior source identity is invalid");
  }
  assertImmutableObjectReference(
    priorSource.authorityBundle,
    namespace,
    "Release A authority bundle",
  );
  await validateContinuousChainAuthority({
    store,
    namespace,
    pendingAcceptance,
    reference: priorSource.authorityBundle,
  });
  let priorCommit = null;
  if (priorSource.sampleChainHead !== null) {
    assertImmutableObjectReference(
      priorSource.sampleChainHead,
      namespace,
      "Continuous prior chain commit",
    );
    priorCommit = (
      await resolveContinuousChainCommit({
        store,
        namespace,
        reference: priorSource.sampleChainHead,
        pendingAcceptance,
      })
    ).commit;
  }
  const collectorReceipt = await assertOidcReceipt({
    store,
    namespace,
    reference: collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  if (priorSource.sampleChainHead !== null) {
    const previousResolved = await resolveContinuousSample({
      store,
      namespace,
      reference: priorCommit.sampleReference,
      pendingAcceptance,
      providerPolicy,
    });
    const previousCollector = await assertOidcReceipt({
      store,
      namespace,
      reference: previousResolved.collectorIdentity,
      sourceSha: binding.sourceSha,
    });
    if (
      previousCollector.claims.runId === collectorReceipt.claims.runId ||
      previousCollector.claims.jti === collectorReceipt.claims.jti
    ) {
      throw new Error(
        "Continuous sample must be appended by a distinct protected run",
      );
    }
  }
  const domains = assertProviderPolicy(providerPolicy, binding);
  const clockValue = Number(clock());
  if (!Number.isFinite(clockValue)) {
    throw new Error("Continuous collection clock is invalid");
  }
  const collectedAt = new Date(clockValue).toISOString();
  assertCanonicalTimestamp(collectedAt, "Continuous collection time");
  const results = [];
  for (const productionDomain of domains) {
    const providerUrl = new URL(
      `/v4/aliases/${encodeURIComponent(productionDomain)}`,
      providerPolicy.observationPolicy.apiBaseUrl,
    );
    providerUrl.searchParams.set("teamId", providerPolicy.expectedTeamId);
    const providerTransaction = await fetchExact({
      fetchImpl,
      url: providerUrl.href,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${providerToken}`,
      },
      label: `Provider alias ${productionDomain}`,
    });
    const providerDeploymentId = parseProviderDeploymentId(
      providerTransaction.bytes,
      productionDomain,
      binding.providerProjectId,
    );
    if (
      providerTransaction.response.status !== 200 ||
      providerDeploymentId !== binding.providerDeploymentId
    ) {
      throw new Error("Provider alias drifted from the pending deployment");
    }
    const providerBody = await putExactEvidence({
      store,
      namespace,
      bytes: providerTransaction.bytes,
      mediaType: CONTINUOUS_PROVIDER_RESPONSE_MEDIA_TYPE,
      label: `Provider alias response ${productionDomain}`,
    });
    const providerReceiptBytes = canonicalJsonBytes({
      schemaVersion: 1,
      receiptKind: "continuous-provider-alias-lookup/v1",
      namespace,
      operationId: pendingAcceptance.operationId,
      bindingId: binding.bindingId,
      productionDomain,
      providerProjectId: binding.providerProjectId,
      providerDeploymentId,
      collectedAt,
      requestUrl: providerUrl.href,
      responseUrl: providerTransaction.response.url,
      status: providerTransaction.response.status,
      providerDate: providerTransaction.response.headers.get("date"),
      responseSha256: providerBody.reference.sha256,
      responseReference: providerBody.reference,
    });
    const providerReceipt = await putExactEvidence({
      store,
      namespace,
      bytes: providerReceiptBytes,
      mediaType: CONTINUOUS_PROVIDER_RECEIPT_MEDIA_TYPE,
      label: `Provider alias receipt ${productionDomain}`,
    });

    const requestUrl = `https://${productionDomain}${identityPath(binding)}`;
    const httpTransaction = await fetchExact({
      fetchImpl,
      url: requestUrl,
      headers: { Accept: "application/json" },
      label: `Production identity ${productionDomain}`,
    });
    if (httpTransaction.response.status !== 200) {
      throw new Error("Production identity request did not pass");
    }
    assertPublicIdentityBody(httpTransaction.bytes, binding);
    const httpBody = await putExactEvidence({
      store,
      namespace,
      bytes: httpTransaction.bytes,
      mediaType: CONTINUOUS_HTTP_BODY_MEDIA_TYPE,
      label: `Production identity body ${productionDomain}`,
    });
    const httpReceiptBytes = canonicalJsonBytes({
      schemaVersion: 1,
      receiptKind: "continuous-production-http-response/v1",
      namespace,
      operationId: pendingAcceptance.operationId,
      bindingId: binding.bindingId,
      sourceSha: binding.sourceSha,
      buildId: binding.buildId,
      variantId: binding.variantId,
      productionDomain,
      providerProjectId: binding.providerProjectId,
      providerDeploymentId,
      collectedAt,
      requestUrl,
      responseUrl: httpTransaction.response.url,
      status: httpTransaction.response.status,
      responseDate: httpTransaction.response.headers.get("date"),
      contentType: httpTransaction.response.headers.get("content-type"),
      bodySha256: httpBody.reference.sha256,
      bodyReference: httpBody.reference,
    });
    const httpReceipt = await putExactEvidence({
      store,
      namespace,
      bytes: httpReceiptBytes,
      mediaType: CONTINUOUS_HTTP_RECEIPT_MEDIA_TYPE,
      label: `Production identity receipt ${productionDomain}`,
    });
    results.push({
      productionDomain,
      providerDeploymentId,
      status: "PASS",
      responseSha256: httpBody.reference.sha256,
      httpReceipt: httpReceipt.reference,
      providerLookupReceipt: providerReceipt.reference,
    });
  }
  const sampleBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: CONTINUOUS_PROBE_SAMPLE_KIND,
    namespace,
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    standardBindingId: binding.bindingId,
    collectorIdentity: structuredClone(collectorIdentity),
    previousSample: structuredClone(priorCommit?.sampleReference ?? null),
    results,
  });
  const sampleReference = immutableReference(namespace, sampleBytes);
  const commitBytes = canonicalJsonBytes({
    schemaVersion: 1,
    commitKind: "continuous-probe-chain-commit/v1",
    namespace,
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    bindingId: binding.bindingId,
    sequence: (priorCommit?.sequence ?? 0) + 1,
    previousCommit: structuredClone(priorSource.sampleChainHead),
    sampleReference,
  });
  const commitReference = immutableReference(namespace, commitBytes);
  const appended = await store.appendAcceptanceSample({
    operationId: pendingAcceptance.operationId,
    sourceSha: binding.sourceSha,
    bindingId: binding.bindingId,
    expectedPreviousCommit: priorSource.sampleChainHead,
    expectedSequence: priorCommit?.sequence ?? 0,
    sampleBytes,
    sampleMediaType: CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE,
    commitBytes,
    commitMediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
  });
  if (
    appended?.sample?.uri !== sampleReference.uri ||
    appended.sample.sha256 !== sampleReference.sha256 ||
    appended.sample.mediaType !== CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE ||
    appended?.commit?.uri !== commitReference.uri ||
    appended.commit.sha256 !== commitReference.sha256 ||
    appended.commit.mediaType !== CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE ||
    !Number.isFinite(Date.parse(appended.sample.committedAt)) ||
    !Number.isFinite(Date.parse(appended.commit.committedAt)) ||
    Date.parse(appended.commit.committedAt) <
      Date.parse(appended.sample.committedAt)
  ) {
    throw new Error("Continuous sample atomic append receipt differs");
  }
  await Promise.all([
    readExactEvidence({
      store,
      namespace,
      reference: sampleReference,
      mediaType: CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE,
      label: "Continuous production sample",
      canonical: true,
    }),
    readExactEvidence({
      store,
      namespace,
      reference: commitReference,
      mediaType: CONTINUOUS_PROBE_CHAIN_COMMIT_MEDIA_TYPE,
      label: "Continuous chain commit",
      canonical: true,
    }),
  ]);
  return {
    source: {
      ...structuredClone(priorSource),
      sampleChainHead: commitReference,
    },
    sampleReference,
    commitReference,
    committedAt: appended.sample.committedAt,
  };
};

const assertReceiptTiming = ({
  collectedAt,
  responseDate,
  committedAt,
  providerPolicy,
  label,
}) => {
  const collectedMilliseconds = assertCanonicalTimestamp(
    collectedAt,
    `${label} collection time`,
  );
  const responseMilliseconds = assertHttpTimestamp(
    responseDate,
    `${label} response Date`,
  );
  const committedMilliseconds = assertCanonicalTimestamp(
    committedAt,
    `${label} store commit`,
  );
  const maximumAge =
    providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000;
  const maximumFuture =
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000;
  if (
    collectedMilliseconds > committedMilliseconds + maximumFuture ||
    responseMilliseconds > collectedMilliseconds + maximumFuture ||
    collectedMilliseconds - responseMilliseconds > maximumAge
  ) {
    throw new Error(`${label} timing differs from its provider transaction`);
  }
};

const resolveContinuousSample = async ({
  store,
  namespace,
  reference,
  pendingAcceptance,
  providerPolicy,
}) => {
  const stored = await readExactEvidence({
    store,
    namespace,
    reference,
    mediaType: CONTINUOUS_PROBE_SAMPLE_MEDIA_TYPE,
    label: "Continuous production sample",
    canonical: true,
  });
  const sample = parseCanonicalJsonBytes(
    stored.bytes,
    "Continuous production sample",
  );
  assertExactKeys(sample, SAMPLE_KEYS, "Continuous production sample");
  const binding = pendingAcceptance.standardBinding;
  if (
    sample.schemaVersion !== 1 ||
    sample.evidenceKind !== CONTINUOUS_PROBE_SAMPLE_KIND ||
    sample.namespace !== namespace ||
    sample.operationId !== pendingAcceptance.operationId ||
    sample.sourceSha !== binding.sourceSha ||
    sample.standardBindingId !== binding.bindingId ||
    !Array.isArray(sample.results)
  ) {
    throw new Error(
      "Continuous sample identity differs from pending acceptance",
    );
  }
  if (sample.previousSample !== null) {
    assertImmutableObjectReference(
      sample.previousSample,
      namespace,
      "Continuous previous sample",
    );
  }
  const collectorReceipt = await assertOidcReceipt({
    store,
    namespace,
    reference: sample.collectorIdentity,
    sourceSha: binding.sourceSha,
  });
  const domains = assertProviderPolicy(providerPolicy, binding);
  if (sample.results.length !== domains.length) {
    throw new Error("Continuous sample does not cover every production domain");
  }
  const results = [];
  for (const [index, result] of sample.results.entries()) {
    assertExactKeys(
      result,
      SAMPLE_RESULT_KEYS,
      `Continuous sample result ${index}`,
    );
    const productionDomain = domains[index];
    if (
      result.productionDomain !== productionDomain ||
      result.providerDeploymentId !== binding.providerDeploymentId ||
      result.status !== "PASS" ||
      !SHA256_PATTERN.test(result.responseSha256)
    ) {
      throw new Error("Continuous sample result drifted from the binding");
    }
    const providerStored = await readExactEvidence({
      store,
      namespace,
      reference: result.providerLookupReceipt,
      mediaType: CONTINUOUS_PROVIDER_RECEIPT_MEDIA_TYPE,
      label: `Continuous provider receipt ${productionDomain}`,
      canonical: true,
    });
    const providerReceipt = parseCanonicalJsonBytes(
      providerStored.bytes,
      `Continuous provider receipt ${productionDomain}`,
    );
    assertExactKeys(
      providerReceipt,
      PROVIDER_RECEIPT_KEYS,
      `Continuous provider receipt ${productionDomain}`,
    );
    const expectedProviderUrl = new URL(
      `/v4/aliases/${encodeURIComponent(productionDomain)}`,
      providerPolicy.observationPolicy.apiBaseUrl,
    );
    expectedProviderUrl.searchParams.set(
      "teamId",
      providerPolicy.expectedTeamId,
    );
    if (
      providerReceipt.schemaVersion !== 1 ||
      providerReceipt.receiptKind !== "continuous-provider-alias-lookup/v1" ||
      providerReceipt.namespace !== namespace ||
      providerReceipt.operationId !== pendingAcceptance.operationId ||
      providerReceipt.bindingId !== binding.bindingId ||
      providerReceipt.productionDomain !== productionDomain ||
      providerReceipt.providerProjectId !== binding.providerProjectId ||
      providerReceipt.providerDeploymentId !== binding.providerDeploymentId ||
      providerReceipt.requestUrl !== expectedProviderUrl.href ||
      providerReceipt.responseUrl !== expectedProviderUrl.href ||
      providerReceipt.status !== 200 ||
      providerReceipt.responseSha256 !==
        providerReceipt.responseReference?.sha256
    ) {
      throw new Error("Continuous provider receipt binding differs");
    }
    assertReceiptTiming({
      collectedAt: providerReceipt.collectedAt,
      responseDate: providerReceipt.providerDate,
      committedAt: providerStored.committedAt,
      providerPolicy,
      label: `Continuous provider receipt ${productionDomain}`,
    });
    const providerResponse = await readExactEvidence({
      store,
      namespace,
      reference: providerReceipt.responseReference,
      mediaType: CONTINUOUS_PROVIDER_RESPONSE_MEDIA_TYPE,
      label: `Continuous provider response ${productionDomain}`,
    });
    if (
      sha256Bytes(providerResponse.bytes) !== providerReceipt.responseSha256 ||
      parseProviderDeploymentId(
        providerResponse.bytes,
        productionDomain,
        binding.providerProjectId,
      ) !== binding.providerDeploymentId
    ) {
      throw new Error("Continuous provider raw response differs");
    }

    const httpStored = await readExactEvidence({
      store,
      namespace,
      reference: result.httpReceipt,
      mediaType: CONTINUOUS_HTTP_RECEIPT_MEDIA_TYPE,
      label: `Continuous HTTP receipt ${productionDomain}`,
      canonical: true,
    });
    const httpReceipt = parseCanonicalJsonBytes(
      httpStored.bytes,
      `Continuous HTTP receipt ${productionDomain}`,
    );
    assertExactKeys(
      httpReceipt,
      HTTP_RECEIPT_KEYS,
      `Continuous HTTP receipt ${productionDomain}`,
    );
    const expectedRequestUrl = `https://${productionDomain}${identityPath(binding)}`;
    if (
      httpReceipt.schemaVersion !== 1 ||
      httpReceipt.receiptKind !== "continuous-production-http-response/v1" ||
      httpReceipt.namespace !== namespace ||
      httpReceipt.operationId !== pendingAcceptance.operationId ||
      httpReceipt.bindingId !== binding.bindingId ||
      httpReceipt.sourceSha !== binding.sourceSha ||
      httpReceipt.buildId !== binding.buildId ||
      httpReceipt.variantId !== binding.variantId ||
      httpReceipt.productionDomain !== productionDomain ||
      httpReceipt.providerProjectId !== binding.providerProjectId ||
      httpReceipt.providerDeploymentId !== binding.providerDeploymentId ||
      httpReceipt.requestUrl !== expectedRequestUrl ||
      httpReceipt.responseUrl !== expectedRequestUrl ||
      httpReceipt.status !== 200 ||
      typeof httpReceipt.contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(httpReceipt.contentType) ||
      httpReceipt.bodySha256 !== result.responseSha256 ||
      httpReceipt.bodySha256 !== httpReceipt.bodyReference?.sha256
    ) {
      throw new Error("Continuous HTTP receipt binding differs");
    }
    assertReceiptTiming({
      collectedAt: httpReceipt.collectedAt,
      responseDate: httpReceipt.responseDate,
      committedAt: httpStored.committedAt,
      providerPolicy,
      label: `Continuous HTTP receipt ${productionDomain}`,
    });
    if (httpReceipt.collectedAt !== providerReceipt.collectedAt) {
      throw new Error(
        "Continuous HTTP/provider transactions are from different samples",
      );
    }
    if (
      Date.parse(providerStored.committedAt) > Date.parse(stored.committedAt) ||
      Date.parse(httpStored.committedAt) > Date.parse(stored.committedAt)
    ) {
      throw new Error(
        "Continuous raw transaction was committed after its sample",
      );
    }
    const httpBody = await readExactEvidence({
      store,
      namespace,
      reference: httpReceipt.bodyReference,
      mediaType: CONTINUOUS_HTTP_BODY_MEDIA_TYPE,
      label: `Continuous HTTP body ${productionDomain}`,
    });
    if (sha256Bytes(httpBody.bytes) !== result.responseSha256) {
      throw new Error("Continuous HTTP raw body hash differs");
    }
    assertPublicIdentityBody(httpBody.bytes, binding);
    results.push(structuredClone(result));
  }
  return {
    reference: structuredClone(reference),
    previousSample: structuredClone(sample.previousSample),
    observedAt: stored.committedAt,
    collectorIdentity: structuredClone(sample.collectorIdentity),
    collectorRunId: collectorReceipt.claims.runId,
    collectorJti: collectorReceipt.claims.jti,
    results,
  };
};

export const resolveContinuousProbeSource = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  providerPolicy,
  releaseAEvidence,
  releaseAEvidenceSha256,
  source,
  maximumGapSeconds,
}) => {
  assertStore(store, namespace);
  assertExactKeys(source, SOURCE_KEYS, "Continuous probe source");
  if (
    source.schemaVersion !== 2 ||
    source.sourceKind !== CONTINUOUS_PROBE_SOURCE_KIND ||
    !Number.isSafeInteger(maximumGapSeconds) ||
    maximumGapSeconds < 1
  ) {
    throw new Error("Continuous probe source identity is invalid");
  }
  await validateReleaseAEvidenceAuthorityBundle({
    store,
    current,
    namespace,
    pendingAcceptance,
    releaseAEvidence,
    releaseAEvidenceSha256,
    reference: source.authorityBundle,
  });
  if (source.sampleChainHead === null) {
    throw new Error("Continuous production sample chain is empty");
  }
  assertImmutableObjectReference(
    source.sampleChainHead,
    namespace,
    "Continuous sample chain head",
  );
  await assertCanonicalContinuousChainHead({
    store,
    pendingAcceptance,
    expectedHead: source.sampleChainHead,
  });
  const reverse = [];
  const visitedCommits = new Set();
  const visitedSamples = new Set();
  let cursor = source.sampleChainHead;
  while (cursor !== null) {
    if (
      visitedCommits.has(cursor.sha256) ||
      reverse.length >= MAX_CHAIN_LENGTH
    ) {
      throw new Error(
        "Continuous sample chain is duplicated, forked, or cyclic",
      );
    }
    visitedCommits.add(cursor.sha256);
    const resolvedCommit = await resolveContinuousChainCommit({
      store,
      namespace,
      reference: cursor,
      pendingAcceptance,
    });
    if (visitedSamples.has(resolvedCommit.commit.sampleReference.sha256)) {
      throw new Error("Continuous sample chain reuses an immutable sample");
    }
    visitedSamples.add(resolvedCommit.commit.sampleReference.sha256);
    const sample = await resolveContinuousSample({
      store,
      namespace,
      reference: resolvedCommit.commit.sampleReference,
      pendingAcceptance,
      providerPolicy,
    });
    reverse.push({ ...sample, chainCommit: resolvedCommit });
    cursor = resolvedCommit.commit.previousCommit;
  }
  const chain = reverse.reverse();
  await assertCanonicalContinuousChainHead({
    store,
    pendingAcceptance,
    expectedHead: source.sampleChainHead,
    expectedSequence: chain.length,
  });
  let previousMilliseconds = null;
  const collectorReferences = new Set();
  const collectorRuns = new Set();
  const collectorJtis = new Set();
  for (const [index, sample] of chain.entries()) {
    const milliseconds = assertCanonicalTimestamp(
      sample.observedAt,
      "Continuous sample committedAt",
    );
    if (
      sample.chainCommit.commit.sequence !== index + 1 ||
      (index === 0
        ? sample.previousSample !== null
        : !sameCanonicalValue(
            sample.previousSample,
            chain[index - 1].reference,
          )) ||
      (index === 0
        ? sample.chainCommit.commit.previousCommit !== null
        : !sameCanonicalValue(
            sample.chainCommit.commit.previousCommit,
            chain[index - 1].chainCommit.reference,
          )) ||
      (previousMilliseconds !== null &&
        (milliseconds <= previousMilliseconds ||
          milliseconds - previousMilliseconds > maximumGapSeconds * 1000))
    ) {
      throw new Error(
        "Continuous sample chain contains a duplicate, fork, gap, or regression",
      );
    }
    if (
      collectorReferences.has(sample.collectorIdentity.sha256) ||
      collectorRuns.has(sample.collectorRunId) ||
      collectorJtis.has(sample.collectorJti)
    ) {
      throw new Error(
        "Continuous sample chain reuses a protected collector run",
      );
    }
    collectorReferences.add(sample.collectorIdentity.sha256);
    collectorRuns.add(sample.collectorRunId);
    collectorJtis.add(sample.collectorJti);
    previousMilliseconds = milliseconds;
  }
  return {
    authorityBundle: structuredClone(source.authorityBundle),
    samples: chain.map(({ reference, chainCommit, observedAt, results }) => ({
      observedAt,
      sampleEvidence: reference,
      sampleChainCommit: chainCommit.reference,
      results,
    })),
  };
};

const COMPANION_SOURCE_KEYS = [
  "authorityBundle",
  "packageRedeployTerminalEvent",
  "schemaVersion",
  "sourceKind",
  "standardReturnEvent",
];
const ASSIGNMENT_VALIDATION_KEYS = [
  "assignmentReceiptSha256",
  "assignmentReceiptUri",
  "assignments",
  "evidenceKind",
  "productionProbeEvidenceHash",
  "providerProjectId",
  "schemaVersion",
];
const PRODUCTION_PROBE_KEYS = [
  "evidenceKind",
  "immutableApiReceipts",
  "immutableRouteProbeEvidenceHash",
  "observedAt",
  "providerAssignmentObservation",
  "providerDeploymentEvidenceHash",
  "providerDeploymentId",
  "providerProjectId",
  "results",
  "schemaVersion",
];
const PRODUCTION_PROBE_RESULT_KEYS = [
  "productionDomain",
  "providerDeploymentId",
  "receipts",
  "responseSha256",
  "status",
];
const ASSIGNMENT_VALIDATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-assignment-validation+json;version=1";
const PRODUCTION_PROBE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.production-probe+json;version=1";

const matchingPredecessor = ({
  current,
  namespace,
  record,
  eventType,
  label,
}) => {
  const predecessor = current.records.find(
    (candidate) =>
      candidate.sequence === record.sequence - 1 &&
      candidate.eventHash === record.event.previousEventHash,
  );
  if (
    !predecessor ||
    predecessor.event.eventType !== eventType ||
    !record.event.evidenceRefs.some((reference) =>
      sameCanonicalValue(
        reference,
        eventReferenceForRecord(namespace, predecessor),
      ),
    )
  ) {
    throw new Error(`${label} lifecycle predecessor is absent`);
  }
  return predecessor;
};

const samePackageIdentity = (left, right) =>
  left?.sourceSha === right?.sourceSha &&
  left?.buildId === right?.buildId &&
  left?.variantId === right?.variantId &&
  left?.releaseRole === "containment" &&
  right?.releaseRole === "containment" &&
  left?.providerProjectId === right?.providerProjectId &&
  left?.providerConfigurationHash === right?.providerConfigurationHash &&
  sameCanonicalValue(left?.packageIndex, right?.packageIndex) &&
  sameCanonicalValue(left?.artifactManifest, right?.artifactManifest) &&
  sameCanonicalValue(left?.releasePolicy, right?.releasePolicy) &&
  sameCanonicalValue(left?.providerPolicy, right?.providerPolicy) &&
  sameCanonicalValue(
    left?.requiredDbCompatibility,
    right?.requiredDbCompatibility,
  );

const resolveAuthoritySourceForPath = async ({
  store,
  namespace,
  bundle,
  evidencePath,
}) => {
  const matches = [];
  for (const reference of bundle.receipts) {
    const stored = await readExactEvidence({
      store,
      namespace,
      reference,
      mediaType: RELEASE_A_AUTHORITY_RECEIPT_MEDIA_TYPE,
      label: "Release A authority receipt",
      canonical: true,
    });
    const receipt = parseCanonicalJsonBytes(
      stored.bytes,
      "Release A authority receipt",
    );
    if (receipt.evidencePath === evidencePath)
      matches.push(receipt.sourceReference);
  }
  if (matches.length !== 1) {
    throw new Error(`Release A authority source is ambiguous: ${evidencePath}`);
  }
  return matches[0];
};

export const resolveCompanionRecoverySource = async ({
  store,
  current,
  namespace,
  pendingAcceptance,
  providerPolicy,
  releaseAEvidence,
  releaseAEvidenceSha256,
  source,
  nowMilliseconds,
  futureClockSkewSeconds,
}) => {
  assertStore(store, namespace);
  assertExactKeys(source, COMPANION_SOURCE_KEYS, "Companion recovery source");
  if (
    source.schemaVersion !== 2 ||
    source.sourceKind !== COMPANION_RECOVERY_SOURCE_KIND ||
    !Number.isFinite(nowMilliseconds) ||
    !Number.isSafeInteger(futureClockSkewSeconds) ||
    futureClockSkewSeconds < 0
  ) {
    throw new Error("Companion recovery source identity is invalid");
  }
  const bundle = await validateReleaseAEvidenceAuthorityBundle({
    store,
    current,
    namespace,
    pendingAcceptance,
    releaseAEvidence,
    releaseAEvidenceSha256,
    reference: source.authorityBundle,
  });
  const terminal = resolveEventReference({
    current,
    namespace,
    reference: source.packageRedeployTerminalEvent,
    label: "Companion package-redeploy terminal",
  });
  const standardReturn = resolveEventReference({
    current,
    namespace,
    reference: source.standardReturnEvent,
    label: "Companion standard-return event",
  });
  if (
    terminal.event.eventType !== "package-redeploy-activated" ||
    terminal.event.payload?.releaseRole !== "containment" ||
    terminal.event.operationId === pendingAcceptance.operationId ||
    standardReturn.event.eventType !== "observation-started" ||
    !sameCanonicalValue(
      standardReturn.event.payload?.pendingAcceptance,
      pendingAcceptance,
    ) ||
    standardReturn.sequence <= terminal.sequence
  ) {
    throw new Error(
      "Companion recovery event chain differs from pending acceptance",
    );
  }
  const standardAssignmentValidated = matchingPredecessor({
    current,
    namespace,
    record: standardReturn,
    eventType: "assignment-validated",
    label: "Companion standard return",
  });
  if (
    !sameCanonicalValue(
      eventReferenceForRecord(namespace, standardAssignmentValidated),
      pendingAcceptance.observationStartedEvent,
    )
  ) {
    throw new Error("Companion standard-return predecessor differs");
  }
  const target = terminal.event.payload.binding;
  if (!samePackageIdentity(target, pendingAcceptance.companionBinding)) {
    throw new Error(
      "Companion package redeploy changed immutable package identity",
    );
  }
  const assignmentValidated = matchingPredecessor({
    current,
    namespace,
    record: terminal,
    eventType: "assignment-validated",
    label: "Companion package redeploy",
  });
  const deploymentAssigned = matchingPredecessor({
    current,
    namespace,
    record: assignmentValidated,
    eventType: "deployment-assigned",
    label: "Companion assignment validation",
  });
  const prepared = matchingPredecessor({
    current,
    namespace,
    record: deploymentAssigned,
    eventType: "promotion-prepared",
    label: "Companion deployment assignment",
  });
  if (
    prepared.event.payload?.pendingOperation?.kind !== "redeploy-containment" ||
    !sameCanonicalValue(
      prepared.event.payload.pendingOperation.targetBinding,
      target,
    ) ||
    !sameCanonicalValue(
      deploymentAssigned.event.payload?.targetBinding,
      target,
    ) ||
    !sameCanonicalValue(
      assignmentValidated.event.payload?.targetBinding,
      target,
    )
  ) {
    throw new Error(
      "Companion recovery execution or assignment binding differs",
    );
  }
  const assignmentValidationReference =
    assignmentValidated.event.payload.assignmentValidation;
  const productionProbeReference =
    assignmentValidated.event.payload.productionProbe;
  const assignmentStored = await readExactEvidence({
    store,
    namespace,
    reference: assignmentValidationReference,
    mediaType: ASSIGNMENT_VALIDATION_MEDIA_TYPE,
    label: "Companion assignment validation",
    canonical: true,
  });
  const assignmentValidation = parseCanonicalJsonBytes(
    assignmentStored.bytes,
    "Companion assignment validation",
  );
  assertExactKeys(
    assignmentValidation,
    ASSIGNMENT_VALIDATION_KEYS,
    "Companion assignment validation",
  );
  const probeStored = await readExactEvidence({
    store,
    namespace,
    reference: productionProbeReference,
    mediaType: PRODUCTION_PROBE_MEDIA_TYPE,
    label: "Companion production probe",
    canonical: true,
  });
  const productionProbe = parseCanonicalJsonBytes(
    probeStored.bytes,
    "Companion production probe",
  );
  assertExactKeys(
    productionProbe,
    PRODUCTION_PROBE_KEYS,
    "Companion production probe",
  );
  const domains = assertProviderPolicy(providerPolicy, target);
  if (
    assignmentValidation.schemaVersion !== 1 ||
    assignmentValidation.evidenceKind !== "assignment-validation" ||
    assignmentValidation.providerProjectId !== target.providerProjectId ||
    assignmentValidation.productionProbeEvidenceHash !==
      productionProbeReference.sha256 ||
    productionProbe.schemaVersion !== 1 ||
    productionProbe.evidenceKind !== "production-assignment-probe/v1" ||
    productionProbe.providerProjectId !== target.providerProjectId ||
    productionProbe.providerDeploymentId !== target.providerDeploymentId ||
    !Array.isArray(productionProbe.results) ||
    productionProbe.results.length !== domains.length
  ) {
    throw new Error(
      "Companion assignment or production probe identity differs",
    );
  }
  for (const [index, result] of productionProbe.results.entries()) {
    assertExactKeys(
      result,
      PRODUCTION_PROBE_RESULT_KEYS,
      `Companion probe ${index}`,
    );
    if (
      result.productionDomain !== domains[index] ||
      result.providerDeploymentId !== target.providerDeploymentId ||
      result.status !== "PASS" ||
      !SHA256_PATTERN.test(result.responseSha256) ||
      !Array.isArray(result.receipts) ||
      result.receipts.length === 0
    ) {
      throw new Error("Companion production probe does not pass every domain");
    }
  }
  const rollbackSource = await resolveAuthoritySourceForPath({
    store,
    namespace,
    bundle,
    evidencePath: "/automatedGates/rollback/evidenceRef",
  });
  if (
    !sameCanonicalValue(rollbackSource, source.packageRedeployTerminalEvent)
  ) {
    throw new Error(
      "Frozen rollback evidence is not the companion terminal event",
    );
  }
  const startedAt = prepared.committedAt;
  const completedAt = terminal.committedAt;
  const startedMilliseconds = assertCanonicalTimestamp(
    startedAt,
    "Companion recovery start",
  );
  const completedMilliseconds = assertCanonicalTimestamp(
    completedAt,
    "Companion recovery completion",
  );
  if (
    completedMilliseconds < startedMilliseconds ||
    completedMilliseconds > nowMilliseconds + futureClockSkewSeconds * 1000 ||
    releaseAEvidence.automatedGates?.rollback?.status !== "PASS" ||
    releaseAEvidence.automatedGates.rollback.command !==
      "npm run test:release-a-rollback" ||
    releaseAEvidence.automatedGates.rollback.commitSha !==
      pendingAcceptance.standardBinding.sourceSha ||
    releaseAEvidence.automatedGates.rollback.completedAt !== completedAt
  ) {
    throw new Error(
      "Companion recovery timing differs from frozen rollback evidence",
    );
  }
  return {
    authorityBundle: structuredClone(source.authorityBundle),
    status: "PASS",
    command: releaseAEvidence.automatedGates.rollback.command,
    startedAt,
    completedAt,
    drillEvidenceRef: source.packageRedeployTerminalEvent.uri,
    companion: {
      bindingId: pendingAcceptance.companionBinding.bindingId,
      sourceSha: pendingAcceptance.companionBinding.sourceSha,
      buildId: pendingAcceptance.companionBinding.buildId,
      variantId: pendingAcceptance.companionBinding.variantId,
      providerProjectId: pendingAcceptance.companionBinding.providerProjectId,
      providerDeploymentId:
        pendingAcceptance.companionBinding.providerDeploymentId,
      packageIndexSha256:
        pendingAcceptance.companionBinding.packageIndex.sha256,
      artifactManifestSha256:
        pendingAcceptance.companionBinding.artifactManifest.sha256,
      providerEvidenceSha256:
        pendingAcceptance.companionBinding.providerEvidence.sha256,
    },
    steps: [
      {
        step: "package-redeploy-without-rebuild",
        status: "PASS",
        evidenceRef: source.packageRedeployTerminalEvent.uri,
      },
      {
        step: "independent-companion-probe",
        status: "PASS",
        evidenceRef: productionProbeReference.uri,
      },
      {
        step: "standard-return",
        status: "PASS",
        evidenceRef: source.standardReturnEvent.uri,
      },
    ],
  };
};
