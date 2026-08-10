import process from "node:process";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  assertStoredGitHubOidcReceipt,
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "../release-state/githubOidc.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  assertImmutableObjectReference,
  compareUtf8,
  isRecord,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  putRemoteDbObservationOidcAuthority,
  putRemoteDbProviderObservationAuthority,
  readStoredRemoteDbObservationOidcAuthority,
  readStoredRemoteDbProviderObservationAuthority,
} from "../db/remote-db-observation-authority.mjs";
import {
  VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  assertProviderPolicyConfigured,
  collectVercelProviderObservation,
} from "./collect-vercel-observation.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";

export const STARTUP_WAF_TRANSCRIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.startup-waf-probe-transcript+json;version=1";
export const STARTUP_WAF_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.startup-waf-observation+json;version=1";
export const STARTUP_WAF_OPERATION = "collect-startup-waf-observation";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_RATE_LIMIT = 512;
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const EXPECTED_PROFILES = new Map([
  ["fresh", "ready"],
  ["populated-no-recovery", "ready"],
  ["recovery-candidate", "recovery-required"],
]);
const bindingResolutions = new WeakSet();

const TRANSCRIPT_KEYS = [
  "binding",
  "collectedAt",
  "metricsContractSha256",
  "namespace",
  "operation",
  "overLimitProbe",
  "probeTarget",
  "producerOidc",
  "profiles",
  "providerObservation",
  "providerPolicy",
  "releaseState",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sourceSha",
  "startupContractSha256",
  "transcriptKind",
  "waf",
];
const AUTHORITY_KEYS = [
  "authorityKind",
  "binding",
  "namespace",
  "operation",
  "producerOidc",
  "providerObservation",
  "providerPolicy",
  "result",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sourceSha",
  "transcript",
];
const RESPONSE_KEYS = [
  "bodyByteLength",
  "bodySha256",
  "classification",
  "contentType",
  "ordinal",
  "requestSha256",
  "responseDate",
  "responseSha256",
  "responseUrlSha256",
  "retryAfter",
  "status",
];
const PROFILE_TRANSCRIPT_KEYS = [
  "expectedRequestCount",
  "fixtureSha256",
  "id",
  "responses",
];
const BINDING_KEYS = [
  "bindingId",
  "deploymentUrl",
  "providerConfigurationHash",
  "providerDeploymentId",
  "providerProjectId",
  "publicIdentityKind",
  "releaseRole",
  "requiredDbCompatibility",
  "sourceSha",
];
const RELEASE_STATE_KEYS = [
  "bootstrapInitializedEvent",
  "eventHash",
  "operationId",
  "sequence",
];
const PROBE_TARGET_KEYS = ["endpoint", "originSha256"];
const WAF_KEYS = ["configurationSha256", "configuredLimit", "ruleId"];
const OVER_LIMIT_TRANSCRIPT_KEYS = [
  "configuredLimit",
  "responses",
  "sentRequestCount",
];
const RESULT_KEYS = [
  "deploymentId",
  "falseNegativeCount",
  "falsePositiveCount",
  "outcome",
  "overLimitProbe",
  "profileResults",
  "provider",
  "wafConfigurationSha256",
];

const requireString = (value, label, maximum = 2_048) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const assertStore = (store, namespace) => {
  if (
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error("Startup WAF Release State store binding is invalid");
  }
};

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const readExactStoredBytes = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) => {
  assertImmutableObjectReference(reference, namespace, label);
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (
    !Buffer.isBuffer(stored.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAX_EVIDENCE_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} immutable readback differs`);
  }
  return Buffer.from(stored.bytes);
};

const putExactStoredBytes = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const input = Buffer.from(bytes);
  const reference = immutableReference(namespace, input);
  const receipt = await store.putEvidence({ bytes: input, mediaType });
  if (
    receipt?.uri !== reference.uri ||
    receipt?.sha256 !== reference.sha256 ||
    receipt?.mediaType !== mediaType ||
    receipt?.byteLength !== input.length ||
    typeof receipt?.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt differs`);
  }
  const readback = await readExactStoredBytes({
    store,
    namespace,
    reference,
    mediaType,
    label,
  });
  if (!readback.equals(input)) {
    throw new Error(`${label} immutable-store bytes differ`);
  }
  return { reference, bytes: input };
};

const parseCanonicalStoredJson = (bytes, label) =>
  parseCanonicalJsonBytes(bytes, label);

const eventReference = (namespace, record) => ({
  uri: `release-state://${namespace}/events/${record.sequence}/${record.eventHash}`,
  sha256: record.eventHash,
});

const startupBindingProjection = (binding) => ({
  bindingId: binding.bindingId,
  sourceSha: binding.sourceSha,
  releaseRole: binding.releaseRole,
  publicIdentityKind: binding.publicIdentityKind,
  providerProjectId: binding.providerProjectId,
  providerDeploymentId: binding.providerDeploymentId,
  deploymentUrl: binding.deploymentUrl,
  providerConfigurationHash: binding.providerConfigurationHash,
  requiredDbCompatibility: structuredClone(binding.requiredDbCompatibility),
});

const assertStateHeadUnchanged = async ({
  store,
  initial,
  readState = readCurrentReleaseState,
}) => {
  const final = await readState({ store });
  if (
    final.head.sequence !== initial.head.sequence ||
    final.head.eventHash !== initial.head.eventHash
  ) {
    throw new Error(
      "Release State head changed during startup WAF observation",
    );
  }
};

const resolveBootstrapInitialization = ({
  current,
  binding,
  namespace,
  executorSourceSha,
}) => {
  const initialized = current.records?.[0];
  if (
    initialized?.sequence !== 1 ||
    initialized?.event?.eventType !== "state-initialized" ||
    initialized.event.namespace !== namespace ||
    initialized.event.sequence !== 1 ||
    initialized.event.previousEventHash !== null ||
    typeof initialized.event.operationId !== "string" ||
    initialized.event.operationId.length === 0 ||
    !SHA256_PATTERN.test(initialized.eventHash ?? "") ||
    initialized.event.payload?.executorSourceSha !== executorSourceSha ||
    !sameCanonicalValue(initialized.event.payload?.bootstrapRecovery, binding)
  ) {
    throw new Error(
      "Startup WAF bootstrap recovery has no exact state-initialized binding",
    );
  }
  return Object.freeze({
    operationId: initialized.event.operationId,
    bootstrapInitializedEvent: eventReference(namespace, initialized),
    head: Object.freeze({
      sequence: initialized.sequence,
      eventHash: initialized.eventHash,
    }),
  });
};

export const resolveStartupWafBinding = async (
  { store, namespace, sourceSha, providerPolicy },
  { readState = readCurrentReleaseState } = {},
) => {
  assertStore(store, namespace);
  if (!SOURCE_SHA_PATTERN.test(sourceSha ?? "")) {
    throw new Error("Startup WAF source SHA is invalid");
  }
  assertProviderPolicyConfigured(providerPolicy);
  const current = await readState({ store });
  const snapshot = current?.snapshot;
  if (!snapshot || snapshot.currentDbCompatibility === undefined) {
    throw new Error("Startup WAF Release State snapshot is unavailable");
  }
  const binding = snapshot.bootstrapRecovery;
  if (!binding) {
    throw new Error("Startup WAF has no bootstrap recovery binding");
  }
  if (
    snapshot.activeProduction !== null ||
    snapshot.acceptedStandard !== null ||
    snapshot.acceptedGate !== null ||
    snapshot.pendingOperation !== null ||
    snapshot.pendingAcceptance !== null
  ) {
    throw new Error(
      "Startup WAF requires initialized pre-release state without managed production",
    );
  }
  assertDeploymentBinding(binding, {
    namespace,
    expectedRole: "containment",
    allowLegacyBootstrap: true,
    label: "Startup WAF bootstrap recovery binding",
  });
  if (
    binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    binding.providerProjectId !== providerPolicy.expectedProjectId ||
    !sameCanonicalValue(
      binding.requiredDbCompatibility,
      snapshot.currentDbCompatibility,
    )
  ) {
    throw new Error("Startup WAF source, provider, or DB binding differs");
  }
  const storedPolicyBytes = await readExactStoredBytes({
    store,
    namespace,
    reference: binding.providerPolicy,
    mediaType: REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
    label: "Startup WAF provider policy",
  });
  const storedPolicy = parseCanonicalStoredJson(
    storedPolicyBytes,
    "Startup WAF provider policy",
  );
  if (!sameCanonicalValue(storedPolicy, providerPolicy)) {
    throw new Error("Startup WAF configured provider policy differs");
  }
  await validateProviderEvidenceForBinding({
    store,
    namespace,
    binding,
    label: "Startup WAF target binding",
  });
  const initialization = resolveBootstrapInitialization({
    current,
    binding,
    namespace,
    executorSourceSha: sourceSha,
  });
  const resolution = Object.freeze({
    current,
    binding: structuredClone(binding),
    initialization,
    providerPolicyReference: structuredClone(binding.providerPolicy),
    providerEvidenceReference: structuredClone(binding.providerEvidence),
  });
  bindingResolutions.add(resolution);
  return resolution;
};

const assertResolution = (resolution) => {
  if (!isRecord(resolution) || !bindingResolutions.has(resolution)) {
    throw new Error("Startup WAF binding was not resolved from live state");
  }
  return resolution;
};

const validateStartupContract = ({ startupContract, fixtures }) => {
  assertExactKeys(
    startupContract,
    ["activationStatus", "blockerCodes", "profiles", "schemaVersion"],
    "Startup WAF contract",
  );
  if (
    startupContract.schemaVersion !== 1 ||
    startupContract.activationStatus !== "configured" ||
    !Array.isArray(startupContract.blockerCodes) ||
    startupContract.blockerCodes.length !== 0 ||
    !Array.isArray(startupContract.profiles) ||
    startupContract.profiles.length !== EXPECTED_PROFILES.size
  ) {
    throw new Error("Startup WAF contract is not production configured");
  }
  const seen = new Set();
  const profiles = startupContract.profiles.map((profile) => {
    assertExactKeys(
      profile,
      [
        "expectedTuples",
        "fixturePath",
        "fixtureSha256",
        "id",
        "quietPeriodMilliseconds",
        "startupCompletion",
      ],
      "Startup WAF profile",
    );
    const expectedCompletion = EXPECTED_PROFILES.get(profile.id);
    const fixtureBytes = fixtures.get(profile.id);
    if (
      seen.has(profile.id) ||
      expectedCompletion === undefined ||
      profile.startupCompletion !== expectedCompletion ||
      profile.quietPeriodMilliseconds !== 2_000 ||
      !SHA256_PATTERN.test(profile.fixtureSha256 ?? "") ||
      !Buffer.isBuffer(fixtureBytes) ||
      sha256Bytes(fixtureBytes) !== profile.fixtureSha256 ||
      !Array.isArray(profile.expectedTuples) ||
      profile.expectedTuples.length === 0
    ) {
      throw new Error(`Startup WAF profile differs: ${profile?.id}`);
    }
    seen.add(profile.id);
    const fixture = parseJsonStrict(
      fixtureBytes.toString("utf8"),
      `Startup WAF fixture ${profile.id}`,
    );
    assertExactKeys(
      fixture,
      ["indexedDb", "localStorage", "profileId", "schemaVersion"],
      `Startup WAF fixture ${profile.id}`,
    );
    if (fixture.schemaVersion !== 1 || fixture.profileId !== profile.id) {
      throw new Error(`Startup WAF fixture identity differs: ${profile.id}`);
    }
    let requestCount = 0;
    const payloadEvents = [];
    for (const tuple of profile.expectedTuples) {
      assertExactKeys(
        tuple,
        ["eventName", "maximumCount", "minimumCount", "outcome"],
        `Startup WAF tuple ${profile.id}`,
      );
      if (
        tuple.eventName !== "startup" ||
        tuple.outcome !== profile.startupCompletion ||
        !Number.isSafeInteger(tuple.minimumCount) ||
        !Number.isSafeInteger(tuple.maximumCount) ||
        tuple.minimumCount < 1 ||
        tuple.maximumCount < tuple.minimumCount ||
        tuple.maximumCount > 32
      ) {
        throw new Error(`Startup WAF tuple differs: ${profile.id}`);
      }
      requestCount += tuple.maximumCount;
      for (let index = 0; index < tuple.maximumCount; index += 1) {
        payloadEvents.push({ name: tuple.eventName, outcome: tuple.outcome });
      }
    }
    return {
      id: profile.id,
      fixtureSha256: profile.fixtureSha256,
      expectedRequestCount: requestCount,
      payloadEvents,
    };
  });
  return profiles.sort((left, right) => compareUtf8(left.id, right.id));
};

const assertMetricsContract = (contract) => {
  if (
    !isRecord(contract) ||
    contract.schemaVersion !== 1 ||
    contract.transport?.endpoint !== "/api/persistence-release-a-metrics" ||
    contract.transport?.method !== "POST" ||
    contract.transport?.credentials !== "omit" ||
    contract.transport?.cache !== "no-store" ||
    contract.transport?.maximumBytes !== 1_024 ||
    !contract.events?.startup?.durationBuckets?.includes("lt-250ms")
  ) {
    throw new Error("Startup WAF metrics contract differs");
  }
  return contract;
};

const resolveWafRule = ({ providerObservation, providerPolicy, profiles }) => {
  const policyRule = providerPolicy.wafRules?.metricsRoute;
  const observedRule = providerObservation.wafRules?.metricsRoute;
  if (!sameCanonicalValue(policyRule, observedRule)) {
    throw new Error("Startup WAF provider rule drifted from policy");
  }
  assertExactKeys(
    observedRule,
    ["action", "active", "conditionGroup", "id", "rateLimit"],
    "Startup WAF metrics rule",
  );
  const rateLimit = observedRule.rateLimit;
  assertExactKeys(
    rateLimit,
    ["algo", "keys", "limit", "window"],
    "Startup WAF rate limit",
  );
  if (
    observedRule.active !== true ||
    typeof observedRule.action !== "string" ||
    !Array.isArray(observedRule.conditionGroup) ||
    !isRecord(rateLimit) ||
    rateLimit.algo !== "fixed_window" ||
    !Number.isSafeInteger(rateLimit.window) ||
    rateLimit.window < 10 ||
    rateLimit.window > 3_600 ||
    !Array.isArray(rateLimit.keys) ||
    rateLimit.keys.length === 0 ||
    new Set(rateLimit.keys).size !== rateLimit.keys.length ||
    rateLimit.keys.some((key) => typeof key !== "string" || key.length === 0) ||
    !Number.isSafeInteger(rateLimit.limit) ||
    rateLimit.limit < 2 ||
    rateLimit.limit > MAX_RATE_LIMIT
  ) {
    throw new Error("Startup WAF metrics rate-limit rule is invalid");
  }
  const normalRequests = profiles.reduce(
    (total, profile) => total + profile.expectedRequestCount,
    0,
  );
  if (normalRequests >= rateLimit.limit) {
    throw new Error(
      "Startup WAF normal profile set reaches the configured limit",
    );
  }
  const endpoint = "/api/persistence-release-a-metrics";
  const conditions = observedRule.conditionGroup.flatMap((group) => {
    assertExactKeys(group, ["conditions"], "Startup WAF condition group");
    if (!Array.isArray(group.conditions) || group.conditions.length === 0) {
      throw new Error("Startup WAF condition group is empty");
    }
    return group.conditions;
  });
  for (const condition of conditions) {
    assertExactKeys(
      condition,
      ["op", "type", "value"],
      "Startup WAF condition",
    );
  }
  if (
    !conditions.some(
      (condition) =>
        condition.type === "path" &&
        condition.op === "eq" &&
        condition.value === endpoint,
    )
  ) {
    throw new Error("Startup WAF metrics rule does not bind the metrics route");
  }
  return {
    configuredLimit: rateLimit.limit,
    ruleId: requireString(observedRule.id, "Startup WAF rule ID", 255),
    configurationSha256: sha256Json({
      providerConfigurationHash: providerConfigurationHash(providerObservation),
      metricsRoute: observedRule,
      ownedProductionDomains: providerObservation.ownedProductionDomains,
    }),
  };
};

const startupMetricsRequestBytes = ({ sourceSha, event }) =>
  canonicalJsonBytes({
    schemaVersion: 1,
    buildId: sourceSha,
    browserFamily: "chromium",
    appMode: "browser-tab",
    online: true,
    event: {
      version: 1,
      name: event.name,
      outcome: event.outcome,
      durationBucket: "lt-250ms",
    },
  });

const responseHeader = (response, name) => {
  const headers = response.headers();
  return headers[name.toLowerCase()] ?? null;
};

const readProbeResponse = async ({
  response,
  ordinal,
  requestBytes,
  expectedUrl,
  collectedAtMilliseconds,
  providerPolicy,
}) => {
  if (!response || typeof response.status !== "function") {
    throw new Error("Startup WAF browser response is invalid");
  }
  const actualUrl = response.url();
  if (actualUrl !== expectedUrl) {
    throw new Error("Startup WAF response URL differs");
  }
  const body = Buffer.from(await response.body());
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error("Startup WAF response body is oversized");
  }
  const status = response.status();
  const responseDate = responseHeader(response, "date");
  const responseMilliseconds = Date.parse(responseDate ?? "");
  const maximumAge =
    providerPolicy.observationPolicy.maxResponseAgeSeconds * 1_000;
  const maximumFutureSkew =
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1_000;
  if (
    !Number.isFinite(responseMilliseconds) ||
    collectedAtMilliseconds - responseMilliseconds > maximumAge ||
    responseMilliseconds - collectedAtMilliseconds > maximumFutureSkew
  ) {
    throw new Error("Startup WAF response Date is outside provider freshness");
  }
  const classification =
    status === 202 ? "allowed" : status === 429 ? "rate-limited" : "unexpected";
  const receipt = {
    ordinal,
    status,
    classification,
    responseDate: new Date(responseMilliseconds).toISOString(),
    contentType: responseHeader(response, "content-type"),
    retryAfter: responseHeader(response, "retry-after"),
    requestSha256: sha256Bytes(requestBytes),
    responseUrlSha256: sha256Bytes(Buffer.from(actualUrl, "utf8")),
    bodyByteLength: body.length,
    bodySha256: sha256Bytes(body),
    responseSha256: "",
  };
  receipt.responseSha256 = sha256Json(
    Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== "responseSha256"),
    ),
  );
  return receipt;
};

const sendProbeSeries = async ({
  browser,
  origin,
  endpoint,
  sourceSha,
  events,
  providerPolicy,
  clock,
}) => {
  const context = await browser.newContext({
    serviceWorkers: "block",
    extraHTTPHeaders: {
      Origin: origin,
      "Cache-Control": "no-store",
    },
  });
  const url = new URL(endpoint, `${origin}/`).href;
  const receipts = [];
  try {
    for (let index = 0; index < events.length; index += 1) {
      const requestBytes = startupMetricsRequestBytes({
        sourceSha,
        event: events[index],
      });
      const response = await context.request.fetch(url, {
        method: "POST",
        data: requestBytes,
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "Cache-Control": "no-store",
        },
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: REQUEST_TIMEOUT_MILLISECONDS,
      });
      receipts.push(
        await readProbeResponse({
          response,
          ordinal: index + 1,
          requestBytes,
          expectedUrl: url,
          collectedAtMilliseconds: Number(clock()),
          providerPolicy,
        }),
      );
    }
  } finally {
    await context.close();
  }
  return receipts;
};

const assertResponseReceipt = ({
  receipt,
  ordinal,
  expectedRequestSha256,
  expectedResponseUrlSha256,
  collectedAtMilliseconds,
  providerPolicy,
}) => {
  assertExactKeys(receipt, RESPONSE_KEYS, "Startup WAF response receipt");
  const date = Date.parse(receipt.responseDate);
  const maximumAge =
    providerPolicy.observationPolicy.maxResponseAgeSeconds * 1_000;
  const futureSkew =
    providerPolicy.observationPolicy.maxFutureClockSkewSeconds * 1_000;
  const expectedResponseHash = sha256Json(
    Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== "responseSha256"),
    ),
  );
  if (
    receipt.ordinal !== ordinal ||
    !Number.isSafeInteger(receipt.status) ||
    !["allowed", "rate-limited", "unexpected"].includes(
      receipt.classification,
    ) ||
    (receipt.status === 202) !== (receipt.classification === "allowed") ||
    (receipt.status === 429) !== (receipt.classification === "rate-limited") ||
    (receipt.classification === "unexpected" &&
      [202, 429].includes(receipt.status)) ||
    !Number.isFinite(date) ||
    collectedAtMilliseconds - date > maximumAge ||
    date - collectedAtMilliseconds > futureSkew ||
    receipt.requestSha256 !== expectedRequestSha256 ||
    receipt.responseUrlSha256 !== expectedResponseUrlSha256 ||
    !SHA256_PATTERN.test(receipt.bodySha256 ?? "") ||
    !Number.isSafeInteger(receipt.bodyByteLength) ||
    receipt.bodyByteLength < 0 ||
    receipt.bodyByteLength > MAX_RESPONSE_BYTES ||
    receipt.responseSha256 !== expectedResponseHash ||
    (receipt.contentType !== null && typeof receipt.contentType !== "string") ||
    (receipt.retryAfter !== null && typeof receipt.retryAfter !== "string")
  ) {
    throw new Error("Startup WAF response receipt differs");
  }
};

export const aggregateStartupWafTranscript = ({
  transcript,
  providerPolicy,
  providerObservation,
  expectedProfiles,
}) => {
  assertExactKeys(transcript, TRANSCRIPT_KEYS, "Startup WAF transcript");
  if (
    transcript.schemaVersion !== 1 ||
    transcript.transcriptKind !== "startup-waf-probe-transcript/v1" ||
    transcript.operation !== STARTUP_WAF_OPERATION ||
    !SOURCE_SHA_PATTERN.test(transcript.sourceSha ?? "") ||
    !RUN_ID_PATTERN.test(transcript.runId ?? "") ||
    !RUN_ID_PATTERN.test(transcript.runAttempt ?? "") ||
    !SHA256_PATTERN.test(transcript.startupContractSha256 ?? "") ||
    !SHA256_PATTERN.test(transcript.metricsContractSha256 ?? "") ||
    !Array.isArray(transcript.profiles)
  ) {
    throw new Error("Startup WAF transcript identity differs");
  }
  assertExactKeys(transcript.binding, BINDING_KEYS, "Startup WAF binding");
  assertExactKeys(
    transcript.releaseState,
    RELEASE_STATE_KEYS,
    "Startup WAF Release State binding",
  );
  assertExactKeys(
    transcript.probeTarget,
    PROBE_TARGET_KEYS,
    "Startup WAF probe target",
  );
  assertExactKeys(transcript.waf, WAF_KEYS, "Startup WAF rule binding");
  for (const [label, reference] of [
    ["provider observation", transcript.providerObservation],
    ["provider policy", transcript.providerPolicy],
    ["producer OIDC", transcript.producerOidc],
  ]) {
    assertImmutableObjectReference(reference, transcript.namespace, label);
  }
  assertExactKeys(
    transcript.releaseState.bootstrapInitializedEvent,
    ["sha256", "uri"],
    "Startup WAF bootstrap initialization event",
  );
  assertExactKeys(
    transcript.binding.requiredDbCompatibility,
    ["contractUri", "fingerprint"],
    "Startup WAF DB binding",
  );
  if (
    transcript.binding.releaseRole !== "containment" ||
    transcript.binding.publicIdentityKind !== "legacy-bootstrap-v1" ||
    !SOURCE_SHA_PATTERN.test(transcript.binding.sourceSha ?? "") ||
    (() => {
      try {
        const deploymentUrl = new URL(transcript.binding.deploymentUrl);
        return (
          deploymentUrl.protocol !== "https:" ||
          deploymentUrl.username !== "" ||
          deploymentUrl.password !== "" ||
          deploymentUrl.hash !== ""
        );
      } catch {
        return true;
      }
    })() ||
    !SHA256_PATTERN.test(transcript.binding.providerConfigurationHash ?? "") ||
    !SHA256_PATTERN.test(
      transcript.binding.requiredDbCompatibility.fingerprint ?? "",
    ) ||
    !Number.isSafeInteger(transcript.releaseState.sequence) ||
    transcript.releaseState.sequence < 1 ||
    !SHA256_PATTERN.test(transcript.releaseState.eventHash ?? "") ||
    typeof transcript.releaseState.operationId !== "string" ||
    transcript.releaseState.operationId.length === 0 ||
    !SHA256_PATTERN.test(
      transcript.releaseState.bootstrapInitializedEvent.sha256 ?? "",
    ) ||
    !new RegExp(
      `^release-state://${transcript.namespace}/events/[1-9][0-9]*/` +
        `${transcript.releaseState.bootstrapInitializedEvent.sha256}$`,
    ).test(transcript.releaseState.bootstrapInitializedEvent.uri) ||
    transcript.probeTarget.endpoint !== "/api/persistence-release-a-metrics" ||
    !SHA256_PATTERN.test(transcript.probeTarget.originSha256 ?? "") ||
    !SHA256_PATTERN.test(transcript.waf.configurationSha256 ?? "") ||
    !Number.isSafeInteger(transcript.waf.configuredLimit) ||
    typeof transcript.waf.ruleId !== "string" ||
    transcript.waf.ruleId.length === 0
  ) {
    throw new Error("Startup WAF transcript binding differs");
  }
  const collectedAtMilliseconds = Date.parse(transcript.collectedAt);
  if (!Number.isFinite(collectedAtMilliseconds)) {
    throw new Error("Startup WAF transcript time is invalid");
  }
  const expectedProfileIds = [...EXPECTED_PROFILES.keys()].sort(compareUtf8);
  const actualProfileIds = transcript.profiles.map(({ id }) => id);
  if (
    actualProfileIds.length !== expectedProfileIds.length ||
    actualProfileIds.some((id, index) => id !== expectedProfileIds[index])
  ) {
    throw new Error("Startup WAF transcript profile set differs");
  }
  if (
    !Array.isArray(expectedProfiles) ||
    expectedProfiles.length !== transcript.profiles.length
  ) {
    throw new Error("Startup WAF resolved profile contract is absent");
  }
  const expectedOrigin = new URL(transcript.binding.deploymentUrl).origin;
  const expectedUrl = new URL(
    transcript.probeTarget.endpoint,
    `${expectedOrigin}/`,
  ).href;
  const expectedResponseUrlSha256 = sha256Bytes(
    Buffer.from(expectedUrl, "utf8"),
  );
  if (
    transcript.probeTarget.originSha256 !==
    sha256Bytes(Buffer.from(expectedOrigin, "utf8"))
  ) {
    throw new Error("Startup WAF probe origin differs from bootstrap binding");
  }
  const resolvedWaf = resolveWafRule({
    providerObservation,
    providerPolicy,
    profiles: expectedProfiles,
  });
  if (
    transcript.waf.ruleId !== resolvedWaf.ruleId ||
    transcript.waf.configuredLimit !== resolvedWaf.configuredLimit ||
    transcript.waf.configurationSha256 !== resolvedWaf.configurationSha256 ||
    transcript.binding.providerConfigurationHash !==
      providerConfigurationHash(providerObservation)
  ) {
    throw new Error("Startup WAF transcript rule authority differs");
  }
  let falsePositiveCount = 0;
  let unexpectedCount = 0;
  const profileResults = transcript.profiles.map((profile) => {
    assertExactKeys(
      profile,
      PROFILE_TRANSCRIPT_KEYS,
      "Startup WAF profile transcript",
    );
    const expectedProfile = expectedProfiles.find(
      (candidate) => candidate.id === profile.id,
    );
    if (
      expectedProfile === undefined ||
      profile.fixtureSha256 !== expectedProfile.fixtureSha256 ||
      profile.expectedRequestCount !== expectedProfile.expectedRequestCount ||
      !Number.isSafeInteger(profile.expectedRequestCount) ||
      profile.expectedRequestCount < 1 ||
      !SHA256_PATTERN.test(profile.fixtureSha256 ?? "") ||
      !Array.isArray(profile.responses) ||
      profile.responses.length !== profile.expectedRequestCount
    ) {
      throw new Error(`Startup WAF profile transcript differs: ${profile.id}`);
    }
    profile.responses.forEach((receipt, index) =>
      assertResponseReceipt({
        receipt,
        ordinal: index + 1,
        expectedRequestSha256: sha256Bytes(
          startupMetricsRequestBytes({
            sourceSha: transcript.binding.sourceSha,
            event: expectedProfile.payloadEvents[index],
          }),
        ),
        expectedResponseUrlSha256,
        collectedAtMilliseconds,
        providerPolicy,
      }),
    );
    const allowedRequestCount = profile.responses.filter(
      ({ classification }) => classification === "allowed",
    ).length;
    const rateLimitedRequestCount = profile.responses.filter(
      ({ classification }) => classification === "rate-limited",
    ).length;
    unexpectedCount += profile.responses.filter(
      ({ classification }) => classification === "unexpected",
    ).length;
    falsePositiveCount += rateLimitedRequestCount;
    return {
      id: profile.id,
      expectedRequestCount: profile.expectedRequestCount,
      allowedRequestCount,
      rateLimitedRequestCount,
    };
  });
  assertExactKeys(
    transcript.overLimitProbe,
    OVER_LIMIT_TRANSCRIPT_KEYS,
    "Startup WAF over-limit transcript",
  );
  const overLimit = transcript.overLimitProbe;
  if (
    !Number.isSafeInteger(overLimit.configuredLimit) ||
    overLimit.configuredLimit < 2 ||
    overLimit.configuredLimit > MAX_RATE_LIMIT ||
    overLimit.sentRequestCount !== overLimit.configuredLimit + 1 ||
    !Array.isArray(overLimit.responses) ||
    overLimit.responses.length !== overLimit.sentRequestCount
  ) {
    throw new Error("Startup WAF over-limit probe count differs");
  }
  overLimit.responses.forEach((receipt, index) =>
    assertResponseReceipt({
      receipt,
      ordinal: index + 1,
      expectedRequestSha256: sha256Bytes(
        startupMetricsRequestBytes({
          sourceSha: transcript.binding.sourceSha,
          event: { name: "startup", outcome: "ready" },
        }),
      ),
      expectedResponseUrlSha256,
      collectedAtMilliseconds,
      providerPolicy,
    }),
  );
  const allowedRequestCount = overLimit.responses.filter(
    ({ classification }) => classification === "allowed",
  ).length;
  const rateLimitedRequestCount = overLimit.responses.filter(
    ({ classification }) => classification === "rate-limited",
  ).length;
  unexpectedCount += overLimit.responses.filter(
    ({ classification }) => classification === "unexpected",
  ).length;
  const falseNegativeCount =
    (rateLimitedRequestCount === 0 ? 1 : 0) +
    Math.max(0, allowedRequestCount - overLimit.configuredLimit);
  const result = {
    provider: "vercel",
    deploymentId: transcript.binding.providerDeploymentId,
    wafConfigurationSha256: transcript.waf.configurationSha256,
    profileResults,
    overLimitProbe: {
      sentRequestCount: overLimit.sentRequestCount,
      allowedRequestCount,
      rateLimitedRequestCount,
    },
    falsePositiveCount,
    falseNegativeCount,
    outcome:
      falsePositiveCount === 0 &&
      falseNegativeCount === 0 &&
      unexpectedCount === 0
        ? "succeeded"
        : "failed",
  };
  if (result.outcome !== "succeeded") {
    throw new Error(
      `Startup WAF observation failed: falsePositive=${falsePositiveCount}, falseNegative=${falseNegativeCount}, unexpected=${unexpectedCount}`,
    );
  }
  return result;
};

const secretValues = (environment) =>
  Object.entries(environment)
    .filter(
      ([name, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|CA_PEM|PRIVATE_KEY)/i.test(
          name,
        ) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => Buffer.from(value, "utf8"));

const assertSecretSafe = (bytes, environment, label) => {
  if (secretValues(environment).some((secret) => bytes.includes(secret))) {
    throw new Error(`${label} attempted to expose a protected secret`);
  }
};

export const collectStartupWafProducerOidc = async ({
  environment,
  approvalPolicy,
  sourceSha,
  runId,
  nowMilliseconds,
  fetchImpl = fetch,
}) => {
  const token = await requestGitHubOidcToken({
    requestUrl: requireString(
      environment.ACTIONS_ID_TOKEN_REQUEST_URL,
      "GitHub OIDC request URL",
      8_192,
    ),
    requestToken: requireString(
      environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      "GitHub OIDC request token",
      16_384,
    ),
    audience: approvalPolicy.oidcAudience,
    fetchImpl,
  });
  const verified = await verifyGitHubOidcTokenFromIssuer({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    nowMs: nowMilliseconds,
    fetchImpl,
  });
  assertVerifiedGitHubOidcResult(verified);
  return Buffer.from(verified.receiptBytes);
};

export const collectAndStoreStartupWafObservation = async (
  {
    store,
    namespace,
    sourceSha,
    providerPolicy,
    approvalPolicy,
    startupContract,
    metricsContract,
    fixtures,
    environment = process.env,
  },
  {
    readState = readCurrentReleaseState,
    collectProviderObservation = collectVercelProviderObservation,
    collectProducerOidc = collectStartupWafProducerOidc,
    storeProviderObservation = putRemoteDbProviderObservationAuthority,
    storeProducerOidc = putRemoteDbObservationOidcAuthority,
    launchBrowser,
    clock = Date.now,
    fetchImpl = fetch,
  } = {},
) => {
  assertStore(store, namespace);
  const profiles = validateStartupContract({ startupContract, fixtures });
  assertMetricsContract(metricsContract);
  if (typeof launchBrowser !== "function") {
    throw new Error("Startup WAF browser launcher is unavailable");
  }
  const resolution = assertResolution(
    await resolveStartupWafBinding(
      { store, namespace, sourceSha, providerPolicy },
      { readState },
    ),
  );
  const runId = requireString(environment.GITHUB_RUN_ID, "Startup WAF run ID");
  const runAttempt = requireString(
    environment.GITHUB_RUN_ATTEMPT,
    "Startup WAF run attempt",
  );
  if (!RUN_ID_PATTERN.test(runId) || !RUN_ID_PATTERN.test(runAttempt)) {
    throw new Error("Startup WAF workflow run identity is invalid");
  }
  const startedAt = Number(clock());
  if (!Number.isFinite(startedAt)) {
    throw new Error("Startup WAF clock is invalid");
  }
  const [providerObservation, oidcReceiptBytes] = await Promise.all([
    collectProviderObservation({
      policy: providerPolicy,
      token: requireString(environment.VERCEL_TOKEN, "VERCEL_TOKEN", 4_096),
      fetchImpl,
      now: startedAt,
    }),
    collectProducerOidc({
      environment,
      approvalPolicy,
      sourceSha,
      runId,
      nowMilliseconds: startedAt,
      fetchImpl,
    }),
  ]);
  if (
    providerConfigurationHash(providerObservation) !==
    resolution.binding.providerConfigurationHash
  ) {
    throw new Error("Startup WAF fresh provider configuration drifted");
  }
  const waf = resolveWafRule({
    providerObservation,
    providerPolicy,
    profiles,
  });
  const [storedProvider, storedOidc] = await Promise.all([
    storeProviderObservation({
      store,
      namespace,
      bytes: canonicalJsonBytes(providerObservation),
      providerPolicy,
      now: startedAt,
    }),
    storeProducerOidc({
      store,
      namespace,
      receiptBytes: oidcReceiptBytes,
      approvalPolicy,
      sourceSha,
      runId,
      runAttempt,
    }),
  ]);
  if (
    !sameCanonicalValue(
      storedProvider.policyReference,
      resolution.providerPolicyReference,
    )
  ) {
    throw new Error("Startup WAF stored provider policy differs from binding");
  }
  const origin = new URL(resolution.binding.deploymentUrl).origin;
  const endpoint = metricsContract.transport.endpoint;
  const browser = await launchBrowser();
  let profileTranscripts;
  let overLimitResponses;
  try {
    profileTranscripts = [];
    for (const profile of profiles) {
      const responses = await sendProbeSeries({
        browser,
        origin,
        endpoint,
        sourceSha: resolution.binding.sourceSha,
        events: profile.payloadEvents,
        providerPolicy,
        clock,
      });
      profileTranscripts.push({
        id: profile.id,
        fixtureSha256: profile.fixtureSha256,
        expectedRequestCount: profile.expectedRequestCount,
        responses,
      });
    }
    overLimitResponses = await sendProbeSeries({
      browser,
      origin,
      endpoint,
      sourceSha: resolution.binding.sourceSha,
      events: Array.from({ length: waf.configuredLimit + 1 }, () => ({
        name: "startup",
        outcome: "ready",
      })),
      providerPolicy,
      clock,
    });
  } finally {
    await browser.close();
  }
  const collectedAtMilliseconds = Number(clock());
  if (!Number.isFinite(collectedAtMilliseconds)) {
    throw new Error("Startup WAF completion clock is invalid");
  }
  const binding = startupBindingProjection(resolution.binding);
  const transcript = {
    schemaVersion: 1,
    transcriptKind: "startup-waf-probe-transcript/v1",
    namespace,
    sourceSha,
    operation: STARTUP_WAF_OPERATION,
    runId,
    runAttempt,
    collectedAt: new Date(collectedAtMilliseconds).toISOString(),
    releaseState: {
      sequence: resolution.initialization.head.sequence,
      eventHash: resolution.initialization.head.eventHash,
      operationId: resolution.initialization.operationId,
      bootstrapInitializedEvent:
        resolution.initialization.bootstrapInitializedEvent,
    },
    binding,
    providerObservation: storedProvider.reference,
    providerPolicy: storedProvider.policyReference,
    producerOidc: storedOidc.reference,
    startupContractSha256: sha256Json(startupContract),
    metricsContractSha256: sha256Json(metricsContract),
    probeTarget: {
      originSha256: sha256Bytes(Buffer.from(origin, "utf8")),
      endpoint,
    },
    waf: {
      ruleId: waf.ruleId,
      configuredLimit: waf.configuredLimit,
      configurationSha256: waf.configurationSha256,
    },
    profiles: profileTranscripts.sort((left, right) =>
      compareUtf8(left.id, right.id),
    ),
    overLimitProbe: {
      configuredLimit: waf.configuredLimit,
      sentRequestCount: overLimitResponses.length,
      responses: overLimitResponses,
    },
  };
  const result = aggregateStartupWafTranscript({
    transcript,
    providerPolicy,
    providerObservation,
    expectedProfiles: profiles,
  });
  await assertStateHeadUnchanged({
    store,
    initial: resolution.current,
    readState,
  });
  const transcriptBytes = canonicalJsonBytes(transcript);
  assertSecretSafe(transcriptBytes, environment, "Startup WAF transcript");
  const storedTranscript = await putExactStoredBytes({
    store,
    namespace,
    bytes: transcriptBytes,
    mediaType: STARTUP_WAF_TRANSCRIPT_MEDIA_TYPE,
    label: "Startup WAF transcript",
  });
  const authority = {
    schemaVersion: 1,
    authorityKind: "startup-waf-observation/v1",
    namespace,
    sourceSha,
    operation: STARTUP_WAF_OPERATION,
    runId,
    runAttempt,
    binding,
    transcript: storedTranscript.reference,
    providerObservation: storedProvider.reference,
    providerPolicy: storedProvider.policyReference,
    producerOidc: storedOidc.reference,
    result,
  };
  const authorityBytes = canonicalJsonBytes(authority);
  assertSecretSafe(authorityBytes, environment, "Startup WAF authority");
  const storedAuthority = await putExactStoredBytes({
    store,
    namespace,
    bytes: authorityBytes,
    mediaType: STARTUP_WAF_OBSERVATION_MEDIA_TYPE,
    label: "Startup WAF authority",
  });
  const verified = await readStartupWafObservationAuthority({
    store,
    namespace,
    reference: storedAuthority.reference,
    expectedSourceSha: sourceSha,
    providerPolicy,
    approvalPolicy,
    startupContract,
    metricsContract,
    fixtures,
    requireCurrentBinding: false,
    readState,
  });
  return {
    authority: verified.authority,
    authorityBytes: storedAuthority.bytes,
    reference: storedAuthority.reference,
    transcript: verified.transcript,
    transcriptReference: storedTranscript.reference,
    result: verified.result,
  };
};

export const readStartupWafObservationAuthority = async ({
  store,
  namespace,
  reference,
  expectedSourceSha,
  providerPolicy,
  approvalPolicy,
  startupContract,
  metricsContract,
  fixtures,
  requireCurrentBinding = true,
  readState = readCurrentReleaseState,
}) => {
  assertStore(store, namespace);
  const expectedProfiles = validateStartupContract({
    startupContract,
    fixtures,
  });
  assertMetricsContract(metricsContract);
  const authorityBytes = await readExactStoredBytes({
    store,
    namespace,
    reference,
    mediaType: STARTUP_WAF_OBSERVATION_MEDIA_TYPE,
    label: "Startup WAF authority",
  });
  const authority = parseCanonicalStoredJson(
    authorityBytes,
    "Startup WAF authority",
  );
  assertExactKeys(authority, AUTHORITY_KEYS, "Startup WAF authority");
  if (
    authority.schemaVersion !== 1 ||
    authority.authorityKind !== "startup-waf-observation/v1" ||
    authority.namespace !== namespace ||
    authority.sourceSha !== expectedSourceSha ||
    authority.operation !== STARTUP_WAF_OPERATION ||
    !RUN_ID_PATTERN.test(authority.runId ?? "") ||
    !RUN_ID_PATTERN.test(authority.runAttempt ?? "")
  ) {
    throw new Error("Startup WAF authority identity differs");
  }
  for (const [label, storedReference] of [
    ["transcript", authority.transcript],
    ["provider observation", authority.providerObservation],
    ["provider policy", authority.providerPolicy],
    ["producer OIDC", authority.producerOidc],
  ]) {
    assertImmutableObjectReference(storedReference, namespace, label);
  }
  const transcriptBytes = await readExactStoredBytes({
    store,
    namespace,
    reference: authority.transcript,
    mediaType: STARTUP_WAF_TRANSCRIPT_MEDIA_TYPE,
    label: "Startup WAF transcript",
  });
  const transcript = parseCanonicalStoredJson(
    transcriptBytes,
    "Startup WAF transcript",
  );
  const observationTime = Date.parse(transcript.collectedAt ?? "");
  const [provider, oidc] = await Promise.all([
    readStoredRemoteDbProviderObservationAuthority({
      store,
      namespace,
      reference: authority.providerObservation,
      policyReference: authority.providerPolicy,
      now: observationTime,
    }),
    readStoredRemoteDbObservationOidcAuthority({
      store,
      namespace,
      reference: authority.producerOidc,
      approvalPolicy,
      sourceSha: expectedSourceSha,
      runId: authority.runId,
      runAttempt: authority.runAttempt,
    }),
  ]);
  assertStoredGitHubOidcReceipt({
    receipt: oidc.value,
    policy: approvalPolicy,
    expectedSourceSha,
    expectedRunId: authority.runId,
    expectedRunAttempt: authority.runAttempt,
  });
  if (
    !sameCanonicalValue(provider.providerPolicy, providerPolicy) ||
    providerConfigurationHash(provider.observation) !==
      authority.binding.providerConfigurationHash ||
    !sameCanonicalValue(transcript.binding, authority.binding) ||
    transcript.namespace !== authority.namespace ||
    transcript.sourceSha !== authority.sourceSha ||
    transcript.runId !== authority.runId ||
    transcript.runAttempt !== authority.runAttempt ||
    !sameCanonicalValue(
      transcript.providerObservation,
      authority.providerObservation,
    ) ||
    !sameCanonicalValue(transcript.providerPolicy, authority.providerPolicy) ||
    !sameCanonicalValue(transcript.producerOidc, authority.producerOidc) ||
    transcript.startupContractSha256 !== sha256Json(startupContract) ||
    transcript.metricsContractSha256 !== sha256Json(metricsContract)
  ) {
    throw new Error("Startup WAF authority provenance differs");
  }
  const result = aggregateStartupWafTranscript({
    transcript,
    providerPolicy,
    providerObservation: provider.observation,
    expectedProfiles,
  });
  assertExactKeys(authority.result, RESULT_KEYS, "Startup WAF result");
  if (!sameCanonicalValue(result, authority.result)) {
    throw new Error("Startup WAF summary differs from stored raw transcript");
  }
  if (requireCurrentBinding) {
    const current = await resolveStartupWafBinding(
      { store, namespace, sourceSha: expectedSourceSha, providerPolicy },
      { readState },
    );
    if (
      !sameCanonicalValue(
        startupBindingProjection(current.binding),
        authority.binding,
      ) ||
      !sameCanonicalValue(
        current.providerPolicyReference,
        authority.providerPolicy,
      ) ||
      !sameCanonicalValue(
        current.initialization.bootstrapInitializedEvent,
        transcript.releaseState.bootstrapInitializedEvent,
      )
    ) {
      throw new Error(
        "Startup WAF authority no longer binds bootstrap recovery",
      );
    }
  }
  return {
    authority,
    bytes: authorityBytes,
    reference,
    transcript,
    providerObservation: provider.observation,
    producerOidc: oidc.value,
    result,
  };
};

export const STARTUP_WAF_MEDIA_TYPES = Object.freeze({
  authority: STARTUP_WAF_OBSERVATION_MEDIA_TYPE,
  transcript: STARTUP_WAF_TRANSCRIPT_MEDIA_TYPE,
  providerObservation: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  providerPolicy: REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  producerOidc: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
});
