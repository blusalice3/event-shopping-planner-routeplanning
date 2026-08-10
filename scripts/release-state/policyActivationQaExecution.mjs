import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  assertArtifactManifest,
  assertManifestMatchesOutput,
} from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { verifyDeterministicZip } from "../deterministic-zip.mjs";
import { probeImmutableDeployment } from "../provider/deploymentBindingProducer.mjs";
import {
  extractPrebuiltArchive,
  repositoryRoot,
} from "../provider/prebuiltDeployment.mjs";
import { resolvePinnedVercelCli } from "../provider/preparedPromotion.mjs";
import { buildClosedVercelCommandEnvironment } from "../provider/vercel-command-environment.mjs";
import {
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import { derivePolicyActivationTransition } from "./policyActivation.mjs";
import {
  POLICY_ACTIVATION_QA_ARCHIVE_MEDIA_TYPE,
  POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE,
  validatePolicyActivationQaPackage,
} from "./policyActivationQaPackage.mjs";
import { NORMAL_POLICY_ACTIVATION_GATES } from "./phaseGates.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

export const POLICY_QA_EXECUTION_SUBJECT_KIND =
  "policy-activation-qa-execution-subject/v1";
export const POLICY_QA_EXECUTION_KIND = "policy-activation-qa-execution/v1";
export const POLICY_QA_EXECUTION_FAILURE_KIND =
  "policy-activation-qa-execution-recovery-required/v1";
export const POLICY_QA_DEPLOYMENT_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-deployment-receipt+json;version=1";
export const POLICY_QA_DEPLOYMENT_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-deployment-observation+json;version=1";
export const POLICY_QA_ROUTE_PROBE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-route-probe+json;version=1";
export const POLICY_QA_DRILL_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-drill+json;version=1";
export const POLICY_QA_COMMAND_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-drill-command+json;version=1";
export const POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-drill-observation+json;version=1";
export const POLICY_QA_HTTP_TRANSACTION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-http-transaction+json;version=1";
export const POLICY_QA_EXECUTION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-execution+json;version=1";
export const POLICY_QA_EXECUTION_FAILURE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-execution-recovery-required+json;version=1";
export const POLICY_QA_EXECUTION_SUBJECT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-execution-subject+json;version=1";

const OIDC_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1";
const BINARY_MEDIA_TYPE = "application/octet-stream";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UTF8_COMPARE = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    !SHA256_PATTERN.test(reference.sha256) ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} is not immutable Release State evidence`);
  }
  return reference;
};

const putBytes = async ({ store, namespace, bytes, mediaType, label }) => {
  const input = Buffer.from(bytes ?? "");
  if (input.length === 0) throw new Error(`${label} is empty`);
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
  if (!stored?.bytes?.equals(input) || stored.mediaType !== mediaType) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return reference;
};

const putCanonical = ({ store, namespace, value, mediaType, label }) =>
  putBytes({
    store,
    namespace,
    bytes: canonicalJsonBytes(value),
    mediaType,
    label,
  });

const readCanonical = async ({
  store,
  namespace,
  reference,
  label,
  expectedMediaType,
}) => {
  assertReference(reference, namespace, label);
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (
    expectedMediaType !== undefined &&
    stored.mediaType !== expectedMediaType
  ) {
    throw new Error(`${label} media type is invalid`);
  }
  return {
    bytes: stored.bytes,
    mediaType: stored.mediaType,
    value: parseCanonicalJsonBytes(stored.bytes, label),
  };
};

const assertConfiguredProviderPolicy = (policy) => {
  if (
    policy?.bindingStatus !== "configured" ||
    policy.provider !== "vercel" ||
    typeof policy.expectedProjectId !== "string" ||
    policy.expectedProjectId.length === 0 ||
    typeof policy.expectedTeamId !== "string" ||
    policy.expectedTeamId.length === 0 ||
    !Array.isArray(policy.ownedProductionDomains) ||
    policy.ownedProductionDomains.length === 0 ||
    !Number.isSafeInteger(policy.observationPolicy?.maxResponseAgeSeconds) ||
    policy.observationPolicy.maxResponseAgeSeconds <= 0 ||
    !Number.isSafeInteger(
      policy.observationPolicy?.maxFutureClockSkewSeconds,
    ) ||
    policy.observationPolicy.maxFutureClockSkewSeconds < 0 ||
    typeof policy.observationPolicy.apiBaseUrl !== "string"
  ) {
    throw new Error("Policy QA provider policy is not configured");
  }
  const domains = [...policy.ownedProductionDomains].sort(UTF8_COMPARE);
  if (
    new Set(domains).size !== domains.length ||
    domains.some(
      (domain, index) =>
        domain !== policy.ownedProductionDomains[index] ||
        domain !== domain.toLowerCase() ||
        !DOMAIN_PATTERN.test(domain),
    )
  ) {
    throw new Error("Policy QA production domain set is invalid");
  }
  return policy;
};

const assertConfiguredApprovalPolicy = (policy) => {
  if (
    policy?.bindingStatus !== "configured" ||
    policy.trustedIssuer !== "https://token.actions.githubusercontent.com" ||
    typeof policy.oidcAudience !== "string" ||
    policy.oidcAudience.length === 0 ||
    typeof policy.repository !== "string" ||
    policy.repository.length === 0 ||
    typeof policy.workflowRef !== "string" ||
    policy.workflowRef.length === 0 ||
    typeof policy.protectedEnvironment !== "string" ||
    policy.protectedEnvironment.length === 0
  ) {
    throw new Error("Policy QA approval policy is not configured");
  }
  return policy;
};

export const derivePolicyActivationQaDrillDomain = ({
  namespace,
  operationId,
  providerPolicy,
}) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw new Error("Policy QA drill identity is invalid");
  }
  assertConfiguredProviderPolicy(providerPolicy);
  const suffix = sha256Json({
    namespace,
    operationId,
    providerProjectId: providerPolicy.expectedProjectId,
  }).slice(0, 24);
  const domain = `policy-qa-${suffix}.vercel.app`;
  if (
    providerPolicy.ownedProductionDomains.includes(domain) ||
    providerPolicy.ownedProductionDomains.some(
      (productionDomain) =>
        domain === productionDomain || domain.endsWith(`.${productionDomain}`),
    )
  ) {
    throw new Error("Policy QA drill domain overlaps production authority");
  }
  return domain;
};

export const assertPolicyActivationQaDeploymentOutsideProductionDomains = ({
  deploymentUrl,
  providerPolicy,
}) => {
  assertConfiguredProviderPolicy(providerPolicy);
  let parsed;
  try {
    parsed = new URL(deploymentUrl);
  } catch {
    throw new Error("Policy QA deployment URL is invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    providerPolicy.ownedProductionDomains.some(
      (productionDomain) =>
        hostname === productionDomain ||
        hostname.endsWith(`.${productionDomain}`),
    )
  ) {
    throw new Error("Policy QA deployment URL overlaps production authority");
  }
  return deploymentUrl;
};

const sortReferences = (references, namespace) => {
  const unique = new Map();
  for (const reference of references) {
    assertReference(reference, namespace, "Policy QA subject evidence");
    unique.set(reference.sha256, reference);
  }
  return [...unique.values()].sort((left, right) =>
    UTF8_COMPARE(left.sha256, right.sha256),
  );
};

const subjectKeys = [
  "activationGate",
  "activeReleasePolicy",
  "approvalPolicy",
  "cspPolicy",
  "drillDomain",
  "evidenceRefs",
  "executorSourceSha",
  "expectedState",
  "namespace",
  "operationId",
  "previousReleasePolicy",
  "proposedReleasePolicy",
  "providerPolicy",
  "qaPackage",
  "schemaVersion",
  "subjectKind",
  "targetSourceSha",
  "toolchainPolicy",
];

export const assertPolicyActivationQaExecutionSubject = ({
  subject,
  snapshot,
  providerPolicy,
}) => {
  assertExactKeys(subject, subjectKeys, "Policy QA execution subject");
  assertExactKeys(
    subject.expectedState,
    ["eventHash", "sequence"],
    "Policy QA expected state",
  );
  if (
    subject.schemaVersion !== 1 ||
    subject.subjectKind !== POLICY_QA_EXECUTION_SUBJECT_KIND ||
    !NAMESPACE_PATTERN.test(subject.namespace) ||
    !OPERATION_ID_PATTERN.test(subject.operationId) ||
    !SOURCE_SHA_PATTERN.test(subject.executorSourceSha) ||
    !SOURCE_SHA_PATTERN.test(subject.targetSourceSha) ||
    !NORMAL_POLICY_ACTIVATION_GATES.includes(subject.activationGate) ||
    subject.expectedState.sequence !== snapshot.sequence ||
    subject.expectedState.eventHash !== snapshot.eventHash ||
    snapshot.pendingOperation !== null ||
    snapshot.pendingAcceptance !== null ||
    snapshot.acceptedStandard === null ||
    !sameCanonicalValue(
      subject.previousReleasePolicy,
      snapshot.activeReleasePolicy,
    ) ||
    subject.drillDomain !==
      derivePolicyActivationQaDrillDomain({
        namespace: subject.namespace,
        operationId: subject.operationId,
        providerPolicy,
      }) ||
    !Array.isArray(subject.evidenceRefs)
  ) {
    throw new Error("Policy QA execution subject state binding is invalid");
  }
  const authoritativeReferences = [
    ["Previous policy", subject.previousReleasePolicy],
    ["Proposed policy", subject.proposedReleasePolicy],
    ["Active policy", subject.activeReleasePolicy],
    ["Approval policy", subject.approvalPolicy],
    ["Provider policy", subject.providerPolicy],
    ["CSP policy", subject.cspPolicy],
    ["Toolchain policy", subject.toolchainPolicy],
    ["QA package", subject.qaPackage],
  ];
  for (const [label, reference] of authoritativeReferences) {
    assertReference(reference, subject.namespace, label);
  }
  const expectedEvidenceRefs = sortReferences(
    authoritativeReferences.map(([, reference]) => reference),
    subject.namespace,
  );
  if (!sameCanonicalValue(subject.evidenceRefs, expectedEvidenceRefs)) {
    throw new Error(
      "Policy QA execution subject evidence has missing or extra objects",
    );
  }
  return subject;
};

export const buildAuthoritativePolicyActivationQaExecutionSubject = async (
  options,
  { readState = readCurrentReleaseState } = {},
) => {
  const forbidden = [
    "subject",
    "expectedState",
    "drillDomain",
    "evidenceRefs",
    "providerPolicy",
    "proposedPolicy",
    "activePolicy",
  ];
  for (const field of forbidden) {
    if (Object.hasOwn(options ?? {}, field)) {
      throw new Error(`Caller-supplied Policy QA ${field} is forbidden`);
    }
  }
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    targetSourceSha,
    proposedPolicyReference,
    activePolicyReference,
    approvalPolicyReference,
    qaPackageReference,
    cspPolicyBytes,
    toolchainPolicyBytes,
  } = options ?? {};
  if (
    !store ||
    store.namespace !== namespace ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !SOURCE_SHA_PATTERN.test(executorSourceSha) ||
    !SOURCE_SHA_PATTERN.test(targetSourceSha) ||
    !Buffer.isBuffer(cspPolicyBytes) ||
    !Buffer.isBuffer(toolchainPolicyBytes)
  ) {
    throw new Error("Policy QA execution subject inputs are invalid");
  }
  for (const [label, reference] of [
    ["Proposed policy", proposedPolicyReference],
    ["Active policy", activePolicyReference],
    ["Approval policy", approvalPolicyReference],
    ["QA package", qaPackageReference],
  ]) {
    assertReference(reference, namespace, label);
  }
  const current = await readState({ store });
  if (
    current.snapshot.pendingOperation !== null ||
    current.snapshot.pendingAcceptance !== null ||
    current.snapshot.acceptedStandard === null
  ) {
    throw new Error("Policy QA subject requires an idle accepted state");
  }
  const previousPolicyReference = current.snapshot.activeReleasePolicy;
  const providerPolicyReference =
    current.snapshot.acceptedStandard.providerPolicy;
  const [
    previousObject,
    proposedObject,
    activeObject,
    providerObject,
    approvalObject,
  ] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: previousPolicyReference,
      label: "Policy QA previous active policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: proposedPolicyReference,
      label: "Policy QA proposed policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: activePolicyReference,
      label: "Policy QA target active policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: providerPolicyReference,
      label: "Policy QA provider policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: approvalPolicyReference,
      label: "Policy QA approval policy",
    }),
  ]);
  const providerPolicy = assertConfiguredProviderPolicy(providerObject.value);
  assertConfiguredApprovalPolicy(approvalObject.value);
  const transition = derivePolicyActivationTransition({
    previousPolicy: previousObject.value,
    proposedPolicy: proposedObject.value,
    activePolicy: activeObject.value,
    acceptedGate: current.snapshot.acceptedGate,
    acceptedStandardFloors: current.snapshot.acceptedStandardFloors,
    currentFloors: current.snapshot.minimumSafetyFloors,
    previousReleasePolicy: previousPolicyReference,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
  });
  if (!NORMAL_POLICY_ACTIVATION_GATES.includes(transition.activationGate)) {
    throw new Error(
      "Policy QA execution does not accept floor-only activation",
    );
  }
  const [cspPolicyReference, toolchainPolicyReference] = await Promise.all([
    putBytes({
      store,
      namespace,
      bytes: cspPolicyBytes,
      mediaType:
        "application/vnd.event-shopping-planner.csp-policy+json;version=1",
      label: "Policy QA CSP policy",
    }),
    putBytes({
      store,
      namespace,
      bytes: toolchainPolicyBytes,
      mediaType:
        "application/vnd.event-shopping-planner.toolchain-policy+json;version=1",
      label: "Policy QA toolchain policy",
    }),
  ]);
  const toolchainPolicy = parseCanonicalJsonBytes(
    toolchainPolicyBytes,
    "Policy QA toolchain policy",
  );
  const qaPackage = await validatePolicyActivationQaPackage({
    store,
    namespace,
    packageReference: qaPackageReference,
    proposedPolicy: proposedObject.value,
    proposedPolicyReference,
    activationGate: transition.activationGate,
    executorSourceSha,
  });
  if (
    qaPackage.sourceSha !== targetSourceSha ||
    qaPackage.toolchainPolicyHash !== sha256Json(toolchainPolicy)
  ) {
    throw new Error("Policy QA package source or toolchain differs");
  }
  const evidenceRefs = sortReferences(
    [
      previousPolicyReference,
      proposedPolicyReference,
      activePolicyReference,
      approvalPolicyReference,
      providerPolicyReference,
      cspPolicyReference,
      toolchainPolicyReference,
      qaPackageReference,
    ],
    namespace,
  );
  const subject = {
    schemaVersion: 1,
    subjectKind: POLICY_QA_EXECUTION_SUBJECT_KIND,
    namespace,
    operationId,
    executorSourceSha,
    targetSourceSha,
    activationGate: transition.activationGate,
    expectedState: {
      sequence: current.head.sequence,
      eventHash: current.head.eventHash,
    },
    previousReleasePolicy: previousPolicyReference,
    proposedReleasePolicy: proposedPolicyReference,
    activeReleasePolicy: activePolicyReference,
    approvalPolicy: approvalPolicyReference,
    providerPolicy: providerPolicyReference,
    cspPolicy: cspPolicyReference,
    toolchainPolicy: toolchainPolicyReference,
    qaPackage: qaPackageReference,
    drillDomain: derivePolicyActivationQaDrillDomain({
      namespace,
      operationId,
      providerPolicy,
    }),
    evidenceRefs,
  };
  assertPolicyActivationQaExecutionSubject({
    subject,
    snapshot: current.snapshot,
    providerPolicy,
  });
  const subjectBytes = canonicalJsonBytes(subject);
  const subjectReference = await putBytes({
    store,
    namespace,
    bytes: subjectBytes,
    mediaType: POLICY_QA_EXECUTION_SUBJECT_MEDIA_TYPE,
    label: "Policy QA execution subject",
  });
  return {
    subject,
    subjectBytes,
    subjectReference,
    subjectSha256: subjectReference.sha256,
  };
};

const readBoundedResponse = async (response, label) => {
  const declared = response?.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_HTTP_BYTES)
  ) {
    throw new Error(`${label} response is oversized`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_HTTP_BYTES) {
    throw new Error(`${label} response is oversized`);
  }
  return bytes;
};

const safeResponseHeaders = (headers) => ({
  contentType: headers.get("content-type"),
  date: headers.get("date"),
  etag: headers.get("etag"),
  location: headers.get("location"),
  strictTransportSecurity: headers.get("strict-transport-security"),
});

export const executeAndStorePolicyQaHttpTransaction = async ({
  store,
  namespace,
  method,
  url,
  requestBody = null,
  headers = {},
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  secrets = [],
  label,
}) => {
  const requestBytes =
    requestBody === null
      ? null
      : Buffer.isBuffer(requestBody)
        ? Buffer.from(requestBody)
        : canonicalJsonBytes(requestBody);
  const response = await fetchImpl(url, {
    method,
    redirect: "error",
    cache: "no-store",
    headers,
    ...(requestBytes === null ? {} : { body: requestBytes }),
    signal: AbortSignal.timeout(30_000),
  });
  if (
    !response ||
    !Number.isSafeInteger(response.status) ||
    (typeof response.url === "string" &&
      response.url.length > 0 &&
      response.url !== url) ||
    response.redirected === true
  ) {
    throw new Error(`${label} response URL/status is invalid`);
  }
  const responseBytes = await readBoundedResponse(response, label);
  if (
    !Array.isArray(secrets) ||
    secrets.some((secret) => typeof secret !== "string" || secret.length < 8)
  ) {
    throw new Error(`${label} secret scan input is invalid`);
  }
  const responseHeaders = safeResponseHeaders(response.headers);
  for (const [value, evidenceLabel] of [
    [requestBytes, `${label} request body`],
    [responseBytes, `${label} response body`],
    [canonicalJsonBytes(responseHeaders), `${label} response headers`],
  ]) {
    if (value !== null) assertNoSecretBytes(value, secrets, evidenceLabel);
  }
  const [requestReference, responseReference] = await Promise.all([
    requestBytes === null
      ? null
      : putBytes({
          store,
          namespace,
          bytes: requestBytes,
          mediaType: BINARY_MEDIA_TYPE,
          label: `${label} request body`,
        }),
    putBytes({
      store,
      namespace,
      bytes: responseBytes,
      mediaType: BINARY_MEDIA_TYPE,
      label: `${label} response body`,
    }),
  ]);
  const observedAt = new Date(clock()).toISOString();
  const request = {
    body: requestReference,
    bodySha256: requestReference?.sha256 ?? null,
    method,
    url,
  };
  const responseValue = {
    body: responseReference,
    bodySha256: responseReference.sha256,
    headers: responseHeaders,
    headersSha256: sha256Bytes(canonicalJsonBytes(responseHeaders)),
    status: response.status,
  };
  const transaction = {
    schemaVersion: 1,
    evidenceKind: "policy-activation-http-transaction/v1",
    observedAt,
    request,
    response: responseValue,
    transactionSha256: sha256Bytes(
      canonicalJsonBytes({
        observedAt,
        request,
        response: responseValue,
      }),
    ),
  };
  const reference = await putCanonical({
    store,
    namespace,
    value: transaction,
    mediaType: POLICY_QA_HTTP_TRANSACTION_MEDIA_TYPE,
    label,
  });
  return { transaction, reference, requestBytes, responseBytes };
};

const providerSecretValues = (environment) =>
  Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === "string" &&
        value.length >= 8 &&
        /(?:TOKEN|SECRET|PASSWORD|PRIVATE|SERVICE_ROLE|DATABASE_URL|API_KEY)/i.test(
          name,
        ),
    )
    .map(([, value]) => value);

const assertNoSecretBytes = (value, secrets, label) => {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value ?? ""), "utf8");
  if (secrets.some((secret) => bytes.includes(Buffer.from(secret, "utf8")))) {
    throw new Error(`${label} contains a provider secret`);
  }
};

const assertPolicyQaProviderEnvironment = ({ environment, providerPolicy }) => {
  const token = environment?.VERCEL_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 4096 ||
    [...token].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    environment.VERCEL_PROJECT_ID !== providerPolicy.expectedProjectId ||
    environment.VERCEL_ORG_ID !== providerPolicy.expectedTeamId
  ) {
    throw new Error("Policy QA Vercel environment binding is invalid");
  }
  return { token, secrets: providerSecretValues(environment) };
};

const parseSinglePreviewDeploymentUrl = (stdout) => {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("Policy QA deploy output has an ambiguous URL");
  }
  let value;
  try {
    value = new URL(lines[0]);
  } catch {
    throw new Error("Policy QA deploy output is not an HTTPS URL");
  }
  if (
    value.protocol !== "https:" ||
    value.username !== "" ||
    value.password !== "" ||
    value.port !== "" ||
    value.pathname !== "/" ||
    value.search !== "" ||
    value.hash !== "" ||
    !DOMAIN_PATTERN.test(value.hostname.toLowerCase())
  ) {
    throw new Error(
      "Policy QA deployment URL is not an immutable HTTPS origin",
    );
  }
  return `https://${value.hostname.toLowerCase()}`;
};

const defaultPolicyQaCommandRunner = ({
  executable,
  arguments: arguments_,
  cwd,
  environment,
}) =>
  spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  });

export const buildPolicyQaVercelCommandEnvironment = (environment) =>
  buildClosedVercelCommandEnvironment(environment);

const selectQaArtifact = (index, role) => {
  const candidates = index.artifacts.filter(
    (artifact) => artifact.releaseRole === role,
  );
  if (candidates.length !== 1) {
    throw new Error(`Policy QA package has no exact ${role} artifact`);
  }
  return candidates[0];
};

const readPolicyQaArtifact = async ({
  store,
  namespace,
  artifact,
  proposedPolicy,
}) => {
  const [manifestObject, archiveObject] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: artifact.manifest,
      expectedMediaType: POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE,
      label: `Policy QA ${artifact.releaseRole} manifest`,
    }),
    assertEvidenceObjectAvailable({
      store,
      namespace,
      reference: artifact.archive,
      label: `Policy QA ${artifact.releaseRole} archive`,
    }),
  ]);
  if (archiveObject.mediaType !== POLICY_ACTIVATION_QA_ARCHIVE_MEDIA_TYPE) {
    throw new Error(
      `Policy QA ${artifact.releaseRole} archive media type is invalid`,
    );
  }
  assertArtifactManifest(manifestObject.value, proposedPolicy, {
    expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  });
  if (
    manifestObject.value.releaseRole !== artifact.releaseRole ||
    manifestObject.value.variantId !== artifact.variantId ||
    sha256Bytes(archiveObject.bytes) !== artifact.archive.sha256
  ) {
    throw new Error(
      `Policy QA ${artifact.releaseRole} artifact binding differs`,
    );
  }
  return {
    manifest: manifestObject.value,
    manifestBytes: manifestObject.bytes,
    archiveBytes: archiveObject.bytes,
  };
};

const captureRouteFetch =
  ({ fetchImpl, captures }) =>
  async (url, init) => {
    const response = await fetchImpl(url, init);
    if (typeof response?.clone !== "function") {
      throw new Error("Policy QA public route response cannot be captured");
    }
    const clone = response.clone();
    const bytes = Buffer.from(await clone.arrayBuffer());
    if (bytes.length > MAX_HTTP_BYTES) {
      throw new Error("Policy QA public route response exceeds its ceiling");
    }
    if (captures.has(String(url))) {
      throw new Error("Policy QA public route was probed more than once");
    }
    captures.set(String(url), bytes);
    return response;
  };

const providerDeploymentLookupUrl = ({ deploymentUrl, providerPolicy }) => {
  const url = new URL(
    `/v13/deployments/${encodeURIComponent(new URL(deploymentUrl).hostname)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  url.searchParams.sort();
  return url.href;
};

const parseProviderDeployment = ({ bytes, deploymentUrl, providerPolicy }) => {
  const value = parseJsonStrict(
    bytes.toString("utf8"),
    "Policy QA provider deployment response",
  );
  const normalizedUrl =
    typeof value.url === "string" && !value.url.startsWith("http")
      ? `https://${value.url}`
      : value.url;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    normalizedUrl !== deploymentUrl ||
    value.projectId !== providerPolicy.expectedProjectId ||
    value.ownerId !== providerPolicy.expectedTeamId ||
    value.target !== null ||
    value.readyState !== "READY"
  ) {
    throw new Error("Policy QA preview deployment provider binding differs");
  }
  return {
    providerDeploymentId: value.id,
    providerProjectId: value.projectId,
    providerTeamId: value.ownerId,
  };
};

export const deployPolicyActivationQaArtifact = async ({
  store,
  namespace,
  subject,
  packageIndex,
  artifact,
  proposedPolicy,
  providerPolicy,
  cspPolicy,
  toolchainPolicy,
  issuerReceipt,
  workflowRunId,
  environment = process.env,
  root = repositoryRoot,
  stagingParent = os.tmpdir(),
  fetchImpl = globalThis.fetch,
  commandRunner = defaultPolicyQaCommandRunner,
  clock = Date.now,
}) => {
  assertPolicyActivationQaExecutionSubject({
    subject,
    snapshot: {
      sequence: subject.expectedState.sequence,
      eventHash: subject.expectedState.eventHash,
      pendingOperation: null,
      pendingAcceptance: null,
      acceptedStandard: {},
      activeReleasePolicy: subject.previousReleasePolicy,
    },
    providerPolicy,
  });
  assertReference(issuerReceipt, namespace, "Policy QA issuer receipt");
  if (!/^[1-9][0-9]*$/.test(workflowRunId)) {
    throw new Error("Policy QA workflow run ID is invalid");
  }
  const { token, secrets } = assertPolicyQaProviderEnvironment({
    environment,
    providerPolicy,
  });
  const { manifest, archiveBytes } = await readPolicyQaArtifact({
    store,
    namespace,
    artifact,
    proposedPolicy,
  });
  const deployRoot = await mkdtemp(
    path.join(
      path.resolve(stagingParent),
      `foundation-policy-qa-${artifact.releaseRole}-${artifact.archive.sha256.slice(0, 12)}-`,
    ),
  );
  const archivePath = path.join(deployRoot, `${artifact.releaseRole}.zip`);
  const outputRoot = path.join(deployRoot, ".vercel", "output");
  const startedAt = new Date(clock()).toISOString();
  try {
    await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
    await verifyDeterministicZip({
      archivePath,
      expectedFiles: manifest.outputFiles,
    });
    await mkdir(outputRoot, { recursive: true });
    await extractPrebuiltArchive({
      archivePath,
      destination: outputRoot,
      expectedFiles: manifest.outputFiles,
    });
    await assertManifestMatchesOutput(outputRoot, manifest);
    const cli = await resolvePinnedVercelCli({ root, toolchainPolicy });
    const arguments_ = [
      cli.cliPath,
      "deploy",
      "--prebuilt",
      "--skip-domain",
      "--yes",
      "--cwd",
      deployRoot,
    ];
    arguments_.forEach((argument) =>
      assertNoSecretBytes(argument, secrets, "Policy QA Vercel CLI argument"),
    );
    const result = await commandRunner({
      executable: process.execPath,
      arguments: arguments_,
      cwd: deployRoot,
      environment: buildPolicyQaVercelCommandEnvironment(environment),
    });
    if (result?.error !== undefined) throw result.error;
    assertNoSecretBytes(
      result?.stdout ?? "",
      secrets,
      "Policy QA deploy stdout",
    );
    assertNoSecretBytes(
      result?.stderr ?? "",
      secrets,
      "Policy QA deploy stderr",
    );
    if (result?.status !== 0) {
      throw new Error(
        `Policy QA preview deploy failed with status ${String(result?.status)}`,
      );
    }
    const deploymentUrl = parseSinglePreviewDeploymentUrl(result.stdout);
    assertPolicyActivationQaDeploymentOutsideProductionDomains({
      deploymentUrl,
      providerPolicy,
    });
    const deploymentLookup = await executeAndStorePolicyQaHttpTransaction({
      store,
      namespace,
      fetchImpl,
      clock,
      method: "GET",
      url: providerDeploymentLookupUrl({ deploymentUrl, providerPolicy }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      secrets,
      expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
      label: `Policy QA ${artifact.releaseRole} provider deployment lookup`,
    });
    if (deploymentLookup.transaction.response.status !== 200) {
      throw new Error("Policy QA provider deployment lookup failed");
    }
    const provider = parseProviderDeployment({
      bytes: deploymentLookup.responseBytes,
      deploymentUrl,
      providerPolicy,
    });
    const captures = new Map();
    const probe = await probeImmutableDeployment({
      deploymentUrl,
      manifest,
      index: packageIndex,
      packageRoot: deployRoot,
      providerPolicy,
      cspPolicy,
      expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
      fetchImpl: captureRouteFetch({ fetchImpl, captures }),
      nowMilliseconds: clock(),
      secrets,
    });
    const routes = [];
    for (const evidence of probe.routes) {
      const bytes = captures.get(evidence.requestUrl);
      if (!bytes || sha256Bytes(bytes) !== evidence.bodySha256) {
        throw new Error(`Policy QA route capture differs: ${evidence.path}`);
      }
      const body = await putBytes({
        store,
        namespace,
        bytes,
        mediaType: BINARY_MEDIA_TYPE,
        label: `Policy QA ${artifact.releaseRole} route ${evidence.path}`,
      });
      routes.push({ ...evidence, body: body.reference });
    }
    const completedAt = new Date(clock()).toISOString();
    const routeProbe = {
      schemaVersion: 1,
      evidenceKind: "policy-activation-qa-route-probe/v1",
      namespace,
      bindingId: artifact.bindingId,
      releaseRole: artifact.releaseRole,
      manifest: artifact.manifest,
      deploymentUrl,
      providerProjectId: provider.providerProjectId,
      providerDeploymentId: provider.providerDeploymentId,
      observedAt: completedAt,
      routes,
      publicIdentity: probe.publicIdentity,
      runtimeHtmlIdentity: probe.runtimeHtmlIdentity,
    };
    const routeProbeReference = await putCanonical({
      store,
      namespace,
      value: routeProbe,
      mediaType: POLICY_QA_ROUTE_PROBE_MEDIA_TYPE,
      label: `Policy QA ${artifact.releaseRole} route probe`,
    });
    const receipt = {
      schemaVersion: 1,
      receiptKind: "policy-activation-qa-deployment-receipt/v1",
      namespace,
      operationId: subject.operationId,
      workflowRunId,
      executorSourceSha: subject.executorSourceSha,
      issuerReceipt,
      qaPackage: subject.qaPackage,
      proposedReleasePolicy: subject.proposedReleasePolicy,
      bindingId: artifact.bindingId,
      releaseRole: artifact.releaseRole,
      variantId: artifact.variantId,
      manifest: artifact.manifest,
      archive: artifact.archive,
      environment: "non-production",
      providerProjectId: provider.providerProjectId,
      providerDeploymentId: provider.providerDeploymentId,
      deploymentUrl,
      providerLookup: deploymentLookup.reference,
      cli: {
        package: "vercel",
        version: cli.version,
        operation: "deploy-prebuilt-preview-skip-domain",
      },
      startedAt,
      completedAt,
    };
    const receiptReference = await putCanonical({
      store,
      namespace,
      value: receipt,
      mediaType: POLICY_QA_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
      label: `Policy QA ${artifact.releaseRole} deployment receipt`,
    });
    const observation = {
      schemaVersion: 1,
      evidenceKind: "policy-activation-qa-deployment/v1",
      namespace,
      operationId: subject.operationId,
      bindingId: artifact.bindingId,
      releaseRole: artifact.releaseRole,
      variantId: artifact.variantId,
      sourceSha: packageIndex.sourceSha,
      qaPackage: subject.qaPackage,
      proposedReleasePolicy: subject.proposedReleasePolicy,
      environment: "non-production",
      drillDomain: subject.drillDomain,
      providerProjectId: provider.providerProjectId,
      providerDeploymentId: provider.providerDeploymentId,
      deploymentUrl,
      deploymentReceipt: receiptReference,
      routeProbe: routeProbeReference,
      observedAt: completedAt,
    };
    const observationReference = await putCanonical({
      store,
      namespace,
      value: observation,
      mediaType: POLICY_QA_DEPLOYMENT_OBSERVATION_MEDIA_TYPE,
      label: `Policy QA ${artifact.releaseRole} deployment observation`,
    });
    return {
      binding: observation,
      deploymentReceipt: receiptReference,
      deploymentObservation: observationReference,
      routeProbe: routeProbeReference,
    };
  } finally {
    await rm(deployRoot, { recursive: true, force: true });
  }
};

const aliasCommandUrl = ({ target, providerPolicy }) => {
  const url = new URL(
    `/v2/deployments/${encodeURIComponent(target.providerDeploymentId)}/aliases`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  url.searchParams.sort();
  return url.href;
};

const aliasLookupUrl = ({ drillDomain, providerPolicy }) => {
  const url = new URL(
    `/v4/aliases/${encodeURIComponent(drillDomain)}`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  url.searchParams.set("teamId", providerPolicy.expectedTeamId);
  url.searchParams.sort();
  return url.href;
};

const assertTargetBinding = ({
  target,
  providerPolicy,
  drillDomain,
  label,
}) => {
  if (
    typeof target?.bindingId !== "string" ||
    target.bindingId.length === 0 ||
    typeof target.providerDeploymentId !== "string" ||
    target.providerDeploymentId.length === 0 ||
    target.providerProjectId !== providerPolicy.expectedProjectId ||
    typeof target.deploymentUrl !== "string" ||
    !target.deploymentUrl.startsWith("https://") ||
    (target.drillDomain !== undefined && target.drillDomain !== drillDomain)
  ) {
    throw new Error(`${label} binding is invalid`);
  }
  return target;
};

const assertPublicAliasResponse = ({
  result,
  manifest,
  providerPolicy,
  nowMilliseconds,
  label,
}) => {
  const transaction = result.transaction;
  const date = Date.parse(transaction.response.headers.date);
  if (
    transaction.response.status !== 200 ||
    sha256Bytes(result.responseBytes) !== manifest.publicResponseHashes["/"] ||
    !transaction.response.headers.contentType
      ?.toLowerCase()
      .includes("text/html") ||
    (providerPolicy.hstsOwner === "provider" &&
      typeof transaction.response.headers.strictTransportSecurity !==
        "string") ||
    !Number.isFinite(date) ||
    date <
      nowMilliseconds -
        providerPolicy.observationPolicy.maxResponseAgeSeconds * 1000 ||
    date >
      nowMilliseconds +
        providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1000
  ) {
    throw new Error(`${label} public alias observation differs`);
  }
};

export const observeUnusedPolicyActivationQaAlias = async ({
  store,
  namespace,
  subject,
  providerPolicy,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
}) => {
  const { token, secrets } = assertPolicyQaProviderEnvironment({
    environment,
    providerPolicy,
  });
  const lookup = await executeAndStorePolicyQaHttpTransaction({
    store,
    namespace,
    fetchImpl,
    clock,
    method: "GET",
    url: aliasLookupUrl({
      drillDomain: subject.drillDomain,
      providerPolicy,
    }),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    secrets,
    label: "Policy QA initial alias observation",
  });
  if (lookup.transaction.response.status !== 404) {
    throw new Error("Policy QA derived alias is already assigned or ambiguous");
  }
  const observedAt = lookup.transaction.observedAt;
  const observation = {
    schemaVersion: 1,
    observationKind: "policy-drill-provider-observation/v1",
    namespace,
    drillId: `${subject.operationId}:before`,
    action: "before",
    drillDomain: subject.drillDomain,
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: null,
    observedDomains: [subject.drillDomain],
    providerResponse: lookup.reference,
    publicResponse: null,
    observedAt,
  };
  const reference = await putCanonical({
    store,
    namespace,
    value: observation,
    mediaType: POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE,
    label: "Policy QA initial alias observation",
  });
  return { observation, reference };
};

const POLICY_QA_DRILL_ACTIONS = new Set([
  "initial-standard",
  "rollback",
  "containment",
  "final-standard",
]);

export const assignAndObservePolicyActivationQaAlias = async ({
  store,
  namespace,
  subject,
  action,
  sourceBinding,
  targetBinding,
  targetManifest,
  providerPolicy,
  issuerReceipt,
  workflowRunId,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
}) => {
  if (!POLICY_QA_DRILL_ACTIONS.has(action)) {
    throw new Error("Policy QA drill action is invalid");
  }
  assertReference(issuerReceipt, namespace, "Policy QA drill issuer receipt");
  if (!/^[1-9][0-9]*$/.test(workflowRunId)) {
    throw new Error("Policy QA drill workflow run ID is invalid");
  }
  const source =
    sourceBinding === null
      ? null
      : assertTargetBinding({
          target: sourceBinding,
          providerPolicy,
          drillDomain: subject.drillDomain,
          label: "Policy QA drill source",
        });
  const target = assertTargetBinding({
    target: targetBinding,
    providerPolicy,
    drillDomain: subject.drillDomain,
    label: "Policy QA drill target",
  });
  if (
    targetManifest?.releaseRole !== target.releaseRole ||
    targetManifest?.variantId !== target.variantId ||
    targetManifest?.sourceSha !== target.sourceSha
  ) {
    throw new Error(`Policy QA ${action} target manifest differs`);
  }
  const { token, secrets } = assertPolicyQaProviderEnvironment({
    environment,
    providerPolicy,
  });
  const command = await executeAndStorePolicyQaHttpTransaction({
    store,
    namespace,
    fetchImpl,
    clock,
    method: "POST",
    url: aliasCommandUrl({ target, providerPolicy }),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    requestBody: { alias: subject.drillDomain },
    secrets,
    label: `Policy QA ${action} alias command`,
  });
  if (command.transaction.response.status !== 200) {
    throw new Error(`Policy QA ${action} alias command failed`);
  }
  const commandResponse = parseJsonStrict(
    command.responseBytes.toString("utf8"),
    `Policy QA ${action} alias response`,
  );
  if (
    commandResponse?.alias !== subject.drillDomain ||
    (commandResponse.deploymentId !== undefined &&
      commandResponse.deploymentId !== target.providerDeploymentId)
  ) {
    throw new Error(`Policy QA ${action} alias response differs`);
  }
  const publicResponse = await executeAndStorePolicyQaHttpTransaction({
    store,
    namespace,
    fetchImpl,
    clock,
    method: "GET",
    url: `https://${subject.drillDomain}/`,
    headers: { Accept: "text/html" },
    secrets,
    label: `Policy QA ${action} public observation`,
  });
  assertPublicAliasResponse({
    result: publicResponse,
    manifest: targetManifest,
    providerPolicy,
    nowMilliseconds: clock(),
    label: `Policy QA ${action}`,
  });
  const completedAt = command.transaction.observedAt;
  const observedAt = publicResponse.transaction.observedAt;
  if (Date.parse(completedAt) > Date.parse(observedAt)) {
    throw new Error(`Policy QA ${action} observation precedes command`);
  }
  const drillId = `${subject.operationId}:${action}`;
  const receipt = {
    schemaVersion: 1,
    receiptKind: `policy-${action}-drill-command/v1`,
    namespace,
    drillId,
    action,
    sourceBindingId: source?.bindingId ?? null,
    targetBindingId: target.bindingId,
    executorSourceSha: subject.executorSourceSha,
    workflowRunId,
    approvalPolicy: subject.approvalPolicy,
    issuerReceipt,
    providerCommandEvidence: command.reference,
    completedAt,
  };
  const commandReceipt = await putCanonical({
    store,
    namespace,
    value: receipt,
    mediaType: POLICY_QA_COMMAND_RECEIPT_MEDIA_TYPE,
    label: `Policy QA ${action} command receipt`,
  });
  const observation = {
    schemaVersion: 1,
    observationKind: "policy-drill-provider-observation/v1",
    namespace,
    drillId,
    action,
    drillDomain: subject.drillDomain,
    providerProjectId: target.providerProjectId,
    providerDeploymentId: target.providerDeploymentId,
    observedDomains: [subject.drillDomain],
    publicResponse: publicResponse.reference,
    observedAt,
  };
  const providerObservation = await putCanonical({
    store,
    namespace,
    value: observation,
    mediaType: POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE,
    label: `Policy QA ${action} provider observation`,
  });
  const drill = {
    schemaVersion: 1,
    drillKind: "policy-activation-recovery-drill/v1",
    namespace,
    drillId,
    action,
    status: "passed",
    drillDomain: subject.drillDomain,
    sourceBindingId: source?.bindingId ?? null,
    targetBindingId: target.bindingId,
    previousReleasePolicy: subject.previousReleasePolicy,
    proposedReleasePolicy: subject.proposedReleasePolicy,
    activeReleasePolicy: subject.activeReleasePolicy,
    qaPackageIndex: subject.qaPackage,
    commandReceipt,
    providerObservation,
  };
  const drillReference = await putCanonical({
    store,
    namespace,
    value: drill,
    mediaType: POLICY_QA_DRILL_MEDIA_TYPE,
    label: `Policy QA ${action} drill`,
  });
  return {
    action,
    sourceBinding: source,
    targetBinding: target,
    commandReceipt,
    providerObservation,
    drill: drillReference,
    completedAt,
    observedAt,
  };
};

const obtainPolicyQaIssuerReceipt = async ({
  approvalPolicy,
  executorSourceSha,
  workflowRunId,
  environment,
  fetchImpl,
  nowMilliseconds,
}) => {
  const token = await requestGitHubOidcToken({
    requestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: approvalPolicy.oidcAudience,
    fetchImpl,
  });
  const verified = await verifyGitHubOidcTokenFromIssuer({
    token,
    policy: approvalPolicy,
    expectedSourceSha: executorSourceSha,
    expectedRunId: workflowRunId,
    nowMs: nowMilliseconds,
    fetchImpl,
  });
  assertVerifiedGitHubOidcResult(verified);
  return verified;
};

const readExecutionAuthority = async ({
  store,
  namespace,
  subjectBytes,
  expectedSubjectSha256,
  readState,
}) => {
  if (
    !Buffer.isBuffer(subjectBytes) ||
    !SHA256_PATTERN.test(expectedSubjectSha256) ||
    sha256Bytes(subjectBytes) !== expectedSubjectSha256
  ) {
    throw new Error("Policy QA reviewed execution subject hash differs");
  }
  const subject = parseCanonicalJsonBytes(
    subjectBytes,
    "Policy QA reviewed execution subject",
  );
  const subjectReference = referenceFor(namespace, subjectBytes);
  const storedSubject = await readCanonical({
    store,
    namespace,
    reference: subjectReference,
    expectedMediaType: POLICY_QA_EXECUTION_SUBJECT_MEDIA_TYPE,
    label: "Policy QA reviewed execution subject",
  });
  if (!sameCanonicalValue(storedSubject.value, subject)) {
    throw new Error("Policy QA reviewed subject differs from immutable store");
  }
  const current = await readState({ store });
  const providerObject = await readCanonical({
    store,
    namespace,
    reference: subject.providerPolicy,
    label: "Policy QA execution provider policy",
  });
  const providerPolicy = assertConfiguredProviderPolicy(providerObject.value);
  assertPolicyActivationQaExecutionSubject({
    subject,
    snapshot: current.snapshot,
    providerPolicy,
  });
  if (
    current.head.sequence !== subject.expectedState.sequence ||
    current.head.eventHash !== subject.expectedState.eventHash
  ) {
    throw new Error("Policy QA execution state head changed after review");
  }
  const [
    previousObject,
    proposedObject,
    activeObject,
    approvalObject,
    cspObject,
    toolchainObject,
  ] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: subject.previousReleasePolicy,
      label: "Policy QA execution previous policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: subject.proposedReleasePolicy,
      label: "Policy QA execution proposed policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: subject.activeReleasePolicy,
      label: "Policy QA execution prospective active policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: subject.approvalPolicy,
      label: "Policy QA execution approval policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: subject.cspPolicy,
      label: "Policy QA execution CSP policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: subject.toolchainPolicy,
      label: "Policy QA execution toolchain policy",
    }),
  ]);
  const approvalPolicy = assertConfiguredApprovalPolicy(approvalObject.value);
  const packageIndex = await validatePolicyActivationQaPackage({
    store,
    namespace,
    packageReference: subject.qaPackage,
    proposedPolicy: proposedObject.value,
    proposedPolicyReference: subject.proposedReleasePolicy,
    activationGate: subject.activationGate,
    executorSourceSha: subject.executorSourceSha,
  });
  if (packageIndex.sourceSha !== subject.targetSourceSha) {
    throw new Error("Policy QA execution package source differs from subject");
  }
  const acceptedBinding = current.snapshot.acceptedStandard;
  const acceptedManifestObject = await readCanonical({
    store,
    namespace,
    reference: acceptedBinding.artifactManifest,
    expectedMediaType: POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE,
    label: "Policy QA accepted standard manifest",
  });
  assertArtifactManifest(acceptedManifestObject.value, previousObject.value);
  if (
    acceptedBinding.releaseRole !== "standard" ||
    acceptedManifestObject.value.releaseRole !== "standard" ||
    acceptedManifestObject.value.variantId !== acceptedBinding.variantId ||
    acceptedManifestObject.value.sourceSha !== acceptedBinding.sourceSha ||
    acceptedBinding.providerProjectId !== providerPolicy.expectedProjectId
  ) {
    throw new Error("Policy QA accepted rollback binding differs");
  }
  return {
    subject,
    subjectReference,
    current,
    previousPolicy: previousObject.value,
    proposedPolicy: proposedObject.value,
    activePolicy: activeObject.value,
    approvalPolicy,
    providerPolicy,
    cspPolicy: cspObject.value,
    toolchainPolicy: toolchainObject.value,
    packageIndex,
    acceptedBinding,
    acceptedManifest: acceptedManifestObject.value,
  };
};

const executionEvidenceReferences = ({
  authority,
  issuerReceipt,
  standardDeployment,
  companionDeployment,
  beforeAlias,
  initialStandard,
  rollback,
  containment,
  finalStandard,
}) =>
  sortReferences(
    [
      authority.subjectReference,
      issuerReceipt,
      standardDeployment.deploymentReceipt,
      standardDeployment.deploymentObservation,
      standardDeployment.routeProbe,
      companionDeployment.deploymentReceipt,
      companionDeployment.deploymentObservation,
      companionDeployment.routeProbe,
      beforeAlias.reference,
      ...[initialStandard, rollback, containment, finalStandard].flatMap(
        (step) => [step.commandReceipt, step.providerObservation, step.drill],
      ),
    ],
    authority.subject.namespace,
  );

export const runPolicyActivationQaDrillSequence = async ({
  stepOptions,
  standardBinding,
  standardManifest,
  acceptedBinding,
  acceptedManifest,
  companionBinding,
  companionManifest,
  assignAndObserveAlias,
}) => {
  if (typeof assignAndObserveAlias !== "function") {
    throw new Error("Policy QA drill sequence adapter is unavailable");
  }
  let initialStandard = null;
  let rollback = null;
  let containment = null;
  let finalStandard = null;
  let primaryError = null;
  let cleanupError = null;
  try {
    initialStandard = await assignAndObserveAlias({
      ...stepOptions,
      action: "initial-standard",
      sourceBinding: null,
      targetBinding: standardBinding,
      targetManifest: standardManifest,
    });
    rollback = await assignAndObserveAlias({
      ...stepOptions,
      action: "rollback",
      sourceBinding: standardBinding,
      targetBinding: acceptedBinding,
      targetManifest: acceptedManifest,
    });
    containment = await assignAndObserveAlias({
      ...stepOptions,
      action: "containment",
      sourceBinding: acceptedBinding,
      targetBinding: companionBinding,
      targetManifest: companionManifest,
    });
    finalStandard = await assignAndObserveAlias({
      ...stepOptions,
      action: "final-standard",
      sourceBinding: companionBinding,
      targetBinding: standardBinding,
      targetManifest: standardManifest,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (finalStandard === null) {
      try {
        finalStandard = await assignAndObserveAlias({
          ...stepOptions,
          action: "final-standard",
          sourceBinding:
            containment?.targetBinding ??
            rollback?.targetBinding ??
            initialStandard?.targetBinding ??
            null,
          targetBinding: standardBinding,
          targetManifest: standardManifest,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  return {
    initialStandard,
    rollback,
    containment,
    finalStandard,
    primaryError,
    cleanupError,
  };
};

const assertVerifiedPolicyQaFailureCleanup = async ({
  store,
  namespace,
  subject,
  standardDeployment,
  cleanup,
}) => {
  if (
    cleanup?.action !== "final-standard" ||
    !sameCanonicalValue(cleanup.targetBinding, standardDeployment?.binding)
  ) {
    throw new Error(
      "Policy QA failure journal verified cleanup is not the QA standard",
    );
  }
  assertReference(cleanup.drill, namespace, "Policy QA cleanup drill");
  assertReference(
    cleanup.providerObservation,
    namespace,
    "Policy QA cleanup provider observation",
  );
  const [drillObject, observationObject] = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: cleanup.drill,
      expectedMediaType: POLICY_QA_DRILL_MEDIA_TYPE,
      label: "Policy QA cleanup drill",
    }),
    readCanonical({
      store,
      namespace,
      reference: cleanup.providerObservation,
      expectedMediaType: POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE,
      label: "Policy QA cleanup provider observation",
    }),
  ]);
  const drill = drillObject.value;
  const observation = observationObject.value;
  if (
    drill.action !== "final-standard" ||
    drill.status !== "passed" ||
    drill.drillDomain !== subject.drillDomain ||
    drill.targetBindingId !== standardDeployment.binding.bindingId ||
    !sameCanonicalValue(
      drill.providerObservation,
      cleanup.providerObservation,
    ) ||
    observation.action !== "final-standard" ||
    observation.drillDomain !== subject.drillDomain ||
    observation.providerProjectId !==
      standardDeployment.binding.providerProjectId ||
    observation.providerDeploymentId !==
      standardDeployment.binding.providerDeploymentId ||
    !sameCanonicalValue(observation.observedDomains, [subject.drillDomain])
  ) {
    throw new Error(
      "Policy QA failure journal verified cleanup evidence differs",
    );
  }
};

export const storePolicyActivationQaFailureJournal = async ({
  store,
  namespace,
  subject,
  workflowRunId,
  providerPolicy,
  environment,
  standardDeployment = null,
  companionDeployment = null,
  beforeAlias = null,
  completedSteps = [],
  cleanup = null,
  aliasMutationAttempted,
  cleanupVerified,
  primaryError,
  cleanupError = null,
  clock = Date.now,
}) => {
  if (
    typeof aliasMutationAttempted !== "boolean" ||
    typeof cleanupVerified !== "boolean" ||
    !Array.isArray(completedSteps) ||
    !(primaryError instanceof Error) ||
    (cleanupError !== null && !(cleanupError instanceof Error))
  ) {
    throw new Error("Policy QA failure journal inputs are invalid");
  }
  if (!aliasMutationAttempted) {
    if (
      cleanupVerified !== true ||
      cleanup !== null ||
      beforeAlias !== null ||
      completedSteps.length !== 0
    ) {
      throw new Error("Policy QA pre-alias failure journal is inconsistent");
    }
  } else if (
    standardDeployment === null ||
    companionDeployment === null ||
    beforeAlias === null
  ) {
    throw new Error("Policy QA post-alias failure journal is incomplete");
  } else if (cleanupVerified) {
    if (cleanupError !== null) {
      throw new Error(
        "Policy QA verified cleanup cannot retain a cleanup error",
      );
    }
    await assertVerifiedPolicyQaFailureCleanup({
      store,
      namespace,
      subject,
      standardDeployment,
      cleanup,
    });
  } else if (cleanup !== null || cleanupError === null) {
    throw new Error(
      "Policy QA recovery-required cleanup state is inconsistent",
    );
  }
  const secrets = providerSecretValues(environment);
  const primaryFailure = String(primaryError.message || "unknown failure");
  const cleanupFailure =
    cleanupError === null
      ? null
      : String(cleanupError.message || "unknown cleanup failure");
  assertNoSecretBytes(primaryFailure, secrets, "Policy QA primary failure");
  if (cleanupFailure !== null) {
    assertNoSecretBytes(cleanupFailure, secrets, "Policy QA cleanup failure");
  }
  const failure = {
    schemaVersion: 1,
    evidenceKind: POLICY_QA_EXECUTION_FAILURE_KIND,
    namespace,
    operationId: subject.operationId,
    subject: referenceFor(namespace, canonicalJsonBytes(subject)),
    workflowRunId,
    drillDomain: subject.drillDomain,
    providerProductionDomains: providerPolicy.ownedProductionDomains,
    standardDeployment: standardDeployment?.deploymentObservation ?? null,
    companionDeployment: companionDeployment?.deploymentObservation ?? null,
    beforeAlias: beforeAlias?.reference ?? null,
    completedSteps: completedSteps.map((step) => step.drill),
    cleanup: cleanup?.drill ?? null,
    aliasMutationAttempted,
    cleanupVerified,
    primaryFailure,
    cleanupFailure,
    completedAt: new Date(clock()).toISOString(),
  };
  const failureReference = await putCanonical({
    store,
    namespace,
    value: failure,
    mediaType: POLICY_QA_EXECUTION_FAILURE_MEDIA_TYPE,
    label: "Policy QA recovery-required journal",
  });
  return { failure, failureReference };
};

export const executePolicyActivationQaExecution = async (
  {
    store,
    namespace,
    subjectBytes,
    expectedSubjectSha256,
    workflowRunId,
    environment = process.env,
  },
  {
    readState = readCurrentReleaseState,
    obtainIssuerReceipt = obtainPolicyQaIssuerReceipt,
    deployArtifact = deployPolicyActivationQaArtifact,
    observeUnusedAlias = observeUnusedPolicyActivationQaAlias,
    assignAndObserveAlias = assignAndObservePolicyActivationQaAlias,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
  } = {},
) => {
  if (
    !store ||
    store.namespace !== namespace ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !/^[1-9][0-9]*$/.test(workflowRunId)
  ) {
    throw new Error("Policy QA execution inputs are invalid");
  }
  const authority = await readExecutionAuthority({
    store,
    namespace,
    subjectBytes,
    expectedSubjectSha256,
    readState,
  });
  const nowMilliseconds = clock();
  const verifiedIssuer = await obtainIssuerReceipt({
    approvalPolicy: authority.approvalPolicy,
    executorSourceSha: authority.subject.executorSourceSha,
    workflowRunId,
    environment,
    fetchImpl,
    nowMilliseconds,
  });
  if (
    !verifiedIssuer ||
    !Buffer.isBuffer(verifiedIssuer.receiptBytes) ||
    !verifiedIssuer.receipt
  ) {
    throw new Error("Policy QA issuer verifier returned no bound receipt");
  }
  const issuerReceipt = await putBytes({
    store,
    namespace,
    bytes: verifiedIssuer.receiptBytes,
    mediaType: OIDC_MEDIA_TYPE,
    label: "Policy QA issuer receipt",
  });
  if (
    !sameCanonicalValue(
      parseCanonicalJsonBytes(
        verifiedIssuer.receiptBytes,
        "Policy QA issuer receipt",
      ),
      verifiedIssuer.receipt,
    )
  ) {
    throw new Error("Policy QA issuer receipt bytes differ");
  }
  const standardArtifact = selectQaArtifact(authority.packageIndex, "standard");
  const companionArtifact = selectQaArtifact(
    authority.packageIndex,
    "containment",
  );
  const [standardArtifactObject, companionArtifactObject] = await Promise.all([
    readPolicyQaArtifact({
      store,
      namespace,
      artifact: standardArtifact,
      proposedPolicy: authority.proposedPolicy,
    }),
    readPolicyQaArtifact({
      store,
      namespace,
      artifact: companionArtifact,
      proposedPolicy: authority.proposedPolicy,
    }),
  ]);
  const deployOptions = {
    store,
    namespace,
    subject: authority.subject,
    packageIndex: authority.packageIndex,
    proposedPolicy: authority.proposedPolicy,
    providerPolicy: authority.providerPolicy,
    cspPolicy: authority.cspPolicy,
    toolchainPolicy: authority.toolchainPolicy,
    issuerReceipt: issuerReceipt.reference,
    workflowRunId,
    environment,
    fetchImpl,
    clock,
  };
  const deploymentResults = await Promise.allSettled([
    deployArtifact({ ...deployOptions, artifact: standardArtifact }),
    deployArtifact({ ...deployOptions, artifact: companionArtifact }),
  ]);
  const standardDeployment =
    deploymentResults[0].status === "fulfilled"
      ? deploymentResults[0].value
      : null;
  const companionDeployment =
    deploymentResults[1].status === "fulfilled"
      ? deploymentResults[1].value
      : null;
  if (deploymentResults.some((result) => result.status === "rejected")) {
    const primaryError = new AggregateError(
      deploymentResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
      "Policy QA preview deployment pair is incomplete",
    );
    const journal = await storePolicyActivationQaFailureJournal({
      store,
      namespace,
      subject: authority.subject,
      workflowRunId,
      providerPolicy: authority.providerPolicy,
      environment,
      standardDeployment,
      companionDeployment,
      aliasMutationAttempted: false,
      cleanupVerified: true,
      primaryError,
      clock,
    });
    const failureError = new Error(
      "Policy QA preview deployment pair failed before alias mutation",
      { cause: primaryError },
    );
    failureError.evidenceReference = journal.failureReference;
    throw failureError;
  }
  let beforeAlias;
  try {
    beforeAlias = await observeUnusedAlias({
      store,
      namespace,
      subject: authority.subject,
      providerPolicy: authority.providerPolicy,
      environment,
      fetchImpl,
      clock,
    });
  } catch (primaryError) {
    const journal = await storePolicyActivationQaFailureJournal({
      store,
      namespace,
      subject: authority.subject,
      workflowRunId,
      providerPolicy: authority.providerPolicy,
      environment,
      standardDeployment,
      companionDeployment,
      aliasMutationAttempted: false,
      cleanupVerified: true,
      primaryError,
      clock,
    });
    const failureError = new Error(
      "Policy QA alias before-state is unavailable or already assigned",
      { cause: primaryError },
    );
    failureError.evidenceReference = journal.failureReference;
    throw failureError;
  }
  const stepOptions = {
    store,
    namespace,
    subject: authority.subject,
    providerPolicy: authority.providerPolicy,
    issuerReceipt: issuerReceipt.reference,
    workflowRunId,
    environment,
    fetchImpl,
    clock,
  };
  const {
    initialStandard,
    rollback,
    containment,
    finalStandard,
    primaryError,
    cleanupError,
  } = await runPolicyActivationQaDrillSequence({
    stepOptions,
    standardBinding: standardDeployment.binding,
    standardManifest: standardArtifactObject.manifest,
    acceptedBinding: authority.acceptedBinding,
    acceptedManifest: authority.acceptedManifest,
    companionBinding: companionDeployment.binding,
    companionManifest: companionArtifactObject.manifest,
    assignAndObserveAlias,
  });
  const completedAt = new Date(clock()).toISOString();
  if (primaryError !== null || cleanupError !== null) {
    const journal = await storePolicyActivationQaFailureJournal({
      store,
      namespace,
      subject: authority.subject,
      workflowRunId,
      providerPolicy: authority.providerPolicy,
      environment,
      standardDeployment,
      companionDeployment,
      beforeAlias,
      completedSteps: [initialStandard, rollback, containment].filter(Boolean),
      cleanup: finalStandard,
      aliasMutationAttempted: true,
      cleanupVerified: finalStandard !== null && cleanupError === null,
      primaryError: primaryError ?? cleanupError,
      cleanupError,
      clock,
    });
    const failureError = new Error(
      cleanupError === null
        ? `Policy QA drill failed after verified cleanup: ${String(primaryError?.message)}`
        : "Policy QA drill failed and verified cleanup is required",
      { cause: primaryError ?? cleanupError },
    );
    failureError.evidenceReference = journal.failureReference;
    throw failureError;
  }
  const evidenceRefs = executionEvidenceReferences({
    authority,
    issuerReceipt: issuerReceipt.reference,
    standardDeployment,
    companionDeployment,
    beforeAlias,
    initialStandard,
    rollback,
    containment,
    finalStandard,
  });
  const execution = {
    schemaVersion: 1,
    evidenceKind: POLICY_QA_EXECUTION_KIND,
    namespace,
    operationId: authority.subject.operationId,
    subject: authority.subjectReference,
    workflowRunId,
    executorSourceSha: authority.subject.executorSourceSha,
    targetSourceSha: authority.subject.targetSourceSha,
    activationGate: authority.subject.activationGate,
    drillDomain: authority.subject.drillDomain,
    providerProductionDomains: authority.providerPolicy.ownedProductionDomains,
    issuerReceipt: issuerReceipt.reference,
    standardDeployment: standardDeployment.deploymentObservation,
    companionDeployment: companionDeployment.deploymentObservation,
    beforeAlias: beforeAlias.reference,
    initialStandard: initialStandard.drill,
    rollback: rollback.drill,
    containment: containment.drill,
    finalStandard: finalStandard.drill,
    evidenceRefs,
    completedAt,
  };
  const executionBytes = canonicalJsonBytes(execution);
  const executionReference = await putBytes({
    store,
    namespace,
    bytes: executionBytes,
    mediaType: POLICY_QA_EXECUTION_MEDIA_TYPE,
    label: "Policy QA execution bundle",
  });
  return {
    execution,
    executionBytes,
    executionReference,
    executionSha256: executionReference.sha256,
  };
};
