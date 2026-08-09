import { assertArtifactManifest } from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { RELEASE_POLICY_MEDIA_TYPE } from "../release-state/artifactBuildAuthority.mjs";
import { replayReleaseEvents } from "../release-state/releaseStateReducer.mjs";
import {
  assertDeploymentBinding,
  assertExactKeys,
  assertImmutableObjectReference,
  compareUtf8,
  isRecord,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";

export const CSP_REPORT_ARTIFACT_MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";
export const CSP_REPORT_PRODUCTION_PROBE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.production-probe+json;version=1";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_RATE_LIMIT = 512;
const REPORT_ENDPOINT = "/api/csp-report";
const API_NOT_FOUND_BYTES = Buffer.from('{"error":"api-not-found"}', "utf8");
const API_NOT_FOUND_SHA256 = sha256Bytes(API_NOT_FOUND_BYTES);

const EVENT_REFERENCE_KEYS = ["sequence", "sha256", "uri"];
const BINDING_PROJECTION_KEYS = [
  "artifactManifest",
  "bindingId",
  "cspMode",
  "providerConfigurationHash",
  "providerDeploymentId",
  "releaseRole",
  "sourceSha",
];
const ROUTE_TRANSITION_KEYS = [
  "allow",
  "bodyByteLength",
  "bodySha256",
  "cacheControl",
  "contentType",
  "method",
  "path",
  "productionReceiptSetSha256",
  "status",
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
const HTTP_RECEIPT_KEYS = [
  "allow",
  "bodySha256",
  "byteLength",
  "cacheControl",
  "contentType",
  "etag",
  "method",
  "path",
  "requestUrl",
  "responseDate",
  "responseUrl",
  "securityHeaders",
  "status",
];

const eventReference = (namespace, record) => ({
  sequence: record.sequence,
  uri: `release-state://${namespace}/events/${record.sequence}/${record.eventHash}`,
  sha256: record.eventHash,
});

const assertEventReference = (reference, namespace, label) => {
  assertExactKeys(reference, EVENT_REFERENCE_KEYS, label);
  if (
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence < 1 ||
    !SHA256.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/events/${reference.sequence}/${reference.sha256}`
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const readCanonicalEvidence = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) => {
  assertImmutableObjectReference(reference, namespace, label);
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAXIMUM_EVIDENCE_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} immutable evidence differs`);
  }
  const value = parseJsonStrict(stored.bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(stored.bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return { bytes: Buffer.from(stored.bytes), value };
};

const resolveBindingProjection = async ({
  store,
  namespace,
  binding,
  label,
}) => {
  assertDeploymentBinding(binding, { namespace, label });
  const [manifestStored, policyStored] = await Promise.all([
    readCanonicalEvidence({
      store,
      namespace,
      reference: binding.artifactManifest,
      mediaType: CSP_REPORT_ARTIFACT_MANIFEST_MEDIA_TYPE,
      label: `${label} artifact manifest`,
    }),
    readCanonicalEvidence({
      store,
      namespace,
      reference: binding.releasePolicy,
      mediaType: RELEASE_POLICY_MEDIA_TYPE,
      label: `${label} release policy`,
    }),
  ]);
  const manifest = assertArtifactManifest(
    manifestStored.value,
    policyStored.value,
  );
  if (
    manifest.sourceSha !== binding.sourceSha ||
    manifest.buildId !== binding.buildId ||
    manifest.variantId !== binding.variantId ||
    manifest.releaseRole !== binding.releaseRole ||
    manifest.dimensions?.releaseRole !== binding.releaseRole ||
    !["none", "report-only", "enforced"].includes(manifest.dimensions?.cspMode)
  ) {
    throw new Error(`${label} artifact identity differs from its binding`);
  }
  return {
    bindingId: binding.bindingId,
    sourceSha: binding.sourceSha,
    releaseRole: binding.releaseRole,
    providerDeploymentId: binding.providerDeploymentId,
    providerConfigurationHash: binding.providerConfigurationHash,
    artifactManifest: { ...binding.artifactManifest },
    cspMode: manifest.dimensions.cspMode,
  };
};

const assertBindingProjection = (projection, namespace, label) => {
  assertExactKeys(projection, BINDING_PROJECTION_KEYS, label);
  assertImmutableObjectReference(
    projection.artifactManifest,
    namespace,
    `${label} artifact manifest`,
  );
  if (
    typeof projection.bindingId !== "string" ||
    projection.bindingId.length === 0 ||
    !SOURCE_SHA.test(projection.sourceSha ?? "") ||
    !["standard", "containment"].includes(projection.releaseRole) ||
    typeof projection.providerDeploymentId !== "string" ||
    projection.providerDeploymentId.length === 0 ||
    !SHA256.test(projection.providerConfigurationHash ?? "") ||
    !["none", "report-only", "enforced"].includes(projection.cspMode)
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const assertApiNotFoundReceipt = (receipt, label) => {
  assertExactKeys(receipt, HTTP_RECEIPT_KEYS, label);
  if (
    receipt.path !== REPORT_ENDPOINT ||
    receipt.method !== "GET" ||
    receipt.status !== 404 ||
    receipt.bodySha256 !== API_NOT_FOUND_SHA256 ||
    receipt.byteLength !== API_NOT_FOUND_BYTES.length ||
    receipt.cacheControl !== "no-store" ||
    receipt.allow !== null ||
    typeof receipt.contentType !== "string" ||
    !receipt.contentType.toLowerCase().includes("application/json")
  ) {
    throw new Error(`${label} does not prove the pre-P2B JSON 404 contract`);
  }
  return {
    method: receipt.method,
    path: receipt.path,
    status: receipt.status,
    bodySha256: receipt.bodySha256,
    bodyByteLength: receipt.byteLength,
    cacheControl: receipt.cacheControl,
    contentType: receipt.contentType,
    allow: receipt.allow,
  };
};

const resolvePreP2BRouteAuthority = async ({
  store,
  namespace,
  current,
  acceptedRecord,
  priorSnapshot,
}) => {
  const matching = current.records.filter(
    (record) =>
      record.sequence < acceptedRecord.sequence &&
      record.event?.eventType === "assignment-validated" &&
      record.event.operationId === acceptedRecord.event.operationId &&
      sameCanonicalValue(
        record.event.payload?.targetBinding,
        priorSnapshot.acceptedStandard,
      ),
  );
  if (matching.length !== 1) {
    throw new Error(
      "Pre-P2B accepted standard has no exact assignment-validated event",
    );
  }
  const record = matching[0];
  const reference = record.event.payload?.productionProbe;
  if (
    !record.event.evidenceRefs?.some((candidate) =>
      sameCanonicalValue(candidate, reference),
    )
  ) {
    throw new Error(
      "Pre-P2B production probe is absent from lifecycle evidence",
    );
  }
  const stored = await readCanonicalEvidence({
    store,
    namespace,
    reference,
    mediaType: CSP_REPORT_PRODUCTION_PROBE_MEDIA_TYPE,
    label: "Pre-P2B production probe",
  });
  const probe = stored.value;
  assertExactKeys(probe, PRODUCTION_PROBE_KEYS, "Pre-P2B production probe");
  if (
    probe.schemaVersion !== 1 ||
    probe.evidenceKind !== "production-assignment-probe/v1" ||
    probe.providerProjectId !==
      priorSnapshot.acceptedStandard.providerProjectId ||
    probe.providerDeploymentId !==
      priorSnapshot.acceptedStandard.providerDeploymentId ||
    !Array.isArray(probe.immutableApiReceipts) ||
    !Array.isArray(probe.results) ||
    probe.results.length < 1
  ) {
    throw new Error("Pre-P2B production probe identity differs");
  }
  const immutable = probe.immutableApiReceipts.filter(
    ({ path }) => path === REPORT_ENDPOINT,
  );
  if (immutable.length !== 1) {
    throw new Error("Pre-P2B immutable report route receipt is not exact");
  }
  const route = assertApiNotFoundReceipt(
    immutable[0],
    "Pre-P2B immutable report route",
  );
  const productionReceipts = probe.results.map((result, index) => {
    const receipts = Array.isArray(result?.receipts)
      ? result.receipts.filter(({ path }) => path === REPORT_ENDPOINT)
      : [];
    if (
      typeof result?.productionDomain !== "string" ||
      result.productionDomain.length === 0 ||
      result.providerDeploymentId !==
        priorSnapshot.acceptedStandard.providerDeploymentId ||
      result.status !== "PASS" ||
      receipts.length !== 1
    ) {
      throw new Error(`Pre-P2B production result ${index + 1} is incomplete`);
    }
    const contract = assertApiNotFoundReceipt(
      receipts[0],
      `Pre-P2B production report route ${index + 1}`,
    );
    if (
      contract.status !== route.status ||
      contract.bodySha256 !== route.bodySha256 ||
      contract.bodyByteLength !== route.bodyByteLength ||
      contract.cacheControl !== route.cacheControl ||
      contract.allow !== route.allow
    ) {
      throw new Error(
        "Pre-P2B production report route differs from immutable route",
      );
    }
    return { productionDomain: result.productionDomain, ...contract };
  });
  productionReceipts.sort((left, right) =>
    compareUtf8(left.productionDomain, right.productionDomain),
  );
  return {
    assignmentValidatedEvent: eventReference(namespace, record),
    productionProbe: { ...reference },
    route: {
      ...route,
      productionReceiptSetSha256: sha256Json(productionReceipts),
    },
  };
};

export const assertCspReportPhaseStateAuthority = (authority) => {
  assertExactKeys(
    authority,
    [
      "acceptedGate",
      "acceptedStandard",
      "containmentCompanion",
      "pendingAcceptance",
      "pendingOperation",
      "preP2B",
      "releaseStateHead",
    ],
    "CSP report phase-state authority",
  );
  const namespace = authority.preP2B?.acceptedEvent?.uri?.match(
    /^release-state:\/\/([^/]+)\//u,
  )?.[1];
  if (
    !NAMESPACE.test(namespace ?? "") ||
    authority.acceptedGate !== "P2B-REPORT" ||
    authority.pendingOperation !== null ||
    authority.pendingAcceptance !== null
  ) {
    throw new Error("CSP report current Release State is not terminal P2B");
  }
  assertExactKeys(
    authority.releaseStateHead,
    ["eventHash", "sequence"],
    "CSP report Release State head",
  );
  if (
    !Number.isSafeInteger(authority.releaseStateHead.sequence) ||
    authority.releaseStateHead.sequence < 1 ||
    !SHA256.test(authority.releaseStateHead.eventHash ?? "")
  ) {
    throw new Error("CSP report Release State head is invalid");
  }
  assertBindingProjection(
    authority.acceptedStandard,
    namespace,
    "CSP report accepted standard",
  );
  assertBindingProjection(
    authority.containmentCompanion,
    namespace,
    "CSP report containment companion",
  );
  if (
    authority.acceptedStandard.releaseRole !== "standard" ||
    authority.containmentCompanion.releaseRole !== "containment" ||
    authority.acceptedStandard.cspMode !== "report-only" ||
    authority.containmentCompanion.cspMode !== "report-only" ||
    authority.acceptedStandard.sourceSha !==
      authority.containmentCompanion.sourceSha
  ) {
    throw new Error("CSP report current standard/companion policy differs");
  }
  assertExactKeys(
    authority.preP2B,
    [
      "acceptedEvent",
      "acceptedGate",
      "acceptedStandard",
      "assignmentValidatedEvent",
      "containmentCompanion",
      "productionProbe",
      "reportRoute",
    ],
    "CSP report pre-P2B authority",
  );
  if (authority.preP2B.acceptedGate !== "P2A-LOCAL") {
    throw new Error("CSP report pre-P2B accepted gate differs");
  }
  for (const [label, reference] of [
    ["CSP report pre-P2B accepted event", authority.preP2B.acceptedEvent],
    [
      "CSP report pre-P2B assignment event",
      authority.preP2B.assignmentValidatedEvent,
    ],
  ]) {
    assertEventReference(reference, namespace, label);
  }
  assertImmutableObjectReference(
    authority.preP2B.productionProbe,
    namespace,
    "CSP report pre-P2B production probe",
  );
  assertBindingProjection(
    authority.preP2B.acceptedStandard,
    namespace,
    "CSP report pre-P2B standard",
  );
  assertBindingProjection(
    authority.preP2B.containmentCompanion,
    namespace,
    "CSP report pre-P2B companion",
  );
  if (
    authority.preP2B.acceptedStandard.releaseRole !== "standard" ||
    authority.preP2B.containmentCompanion.releaseRole !== "containment" ||
    authority.preP2B.acceptedStandard.cspMode !== "none" ||
    authority.preP2B.containmentCompanion.cspMode !== "none"
  ) {
    throw new Error("CSP report pre-P2B standard/companion policy differs");
  }
  const route = authority.preP2B.reportRoute;
  assertExactKeys(route, ROUTE_TRANSITION_KEYS, "CSP report pre-P2B route");
  if (
    route.path !== REPORT_ENDPOINT ||
    route.method !== "GET" ||
    route.status !== 404 ||
    route.bodySha256 !== API_NOT_FOUND_SHA256 ||
    route.bodyByteLength !== API_NOT_FOUND_BYTES.length ||
    route.cacheControl !== "no-store" ||
    route.allow !== null ||
    typeof route.contentType !== "string" ||
    !route.contentType.toLowerCase().includes("application/json") ||
    !SHA256.test(route.productionReceiptSetSha256 ?? "")
  ) {
    throw new Error("CSP report pre-P2B route transition is invalid");
  }
  return authority;
};

export const resolveCspReportPhaseStateAuthority = async ({
  store,
  current,
  namespace,
  sourceSha,
}) => {
  if (
    !NAMESPACE.test(namespace ?? "") ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !isRecord(current?.snapshot) ||
    !Array.isArray(current.records) ||
    current.snapshot.pendingOperation !== null ||
    current.snapshot.pendingAcceptance !== null ||
    current.snapshot.acceptedGate !== "P2B-REPORT" ||
    !sameCanonicalValue(
      current.snapshot.activeProduction,
      current.snapshot.acceptedStandard,
    ) ||
    current.snapshot.acceptedStandard?.sourceSha !== sourceSha ||
    current.snapshot.acceptedStandardFloors?.cspMode !== "report-only"
  ) {
    throw new Error("Live Release State does not provide terminal P2B closure");
  }
  const currentStandard = current.snapshot.acceptedStandard;
  const currentCompanion = current.snapshot.containmentCompanion;
  assertDeploymentBinding(currentStandard, {
    namespace,
    expectedRole: "standard",
    label: "Current P2B accepted standard",
  });
  assertDeploymentBinding(currentCompanion, {
    namespace,
    expectedRole: "containment",
    label: "Current P2B containment companion",
  });
  const acceptedRecords = current.records.filter(
    ({ event }) =>
      event?.eventType === "release-accepted" &&
      event.payload?.acceptedGate === "P2A-LOCAL",
  );
  if (acceptedRecords.length !== 1) {
    throw new Error("Release State has no exact pre-P2B P2A acceptance");
  }
  const priorAcceptedRecord = acceptedRecords[0];
  const priorSnapshot = replayReleaseEvents(
    current.records
      .slice(0, priorAcceptedRecord.sequence)
      .map((record) => structuredClone(record.event)),
  );
  if (
    priorSnapshot.acceptedGate !== "P2A-LOCAL" ||
    priorSnapshot.pendingOperation !== null ||
    priorSnapshot.pendingAcceptance !== null ||
    !sameCanonicalValue(
      priorSnapshot.activeProduction,
      priorSnapshot.acceptedStandard,
    ) ||
    priorSnapshot.acceptedStandardFloors?.cspMode !== "none"
  ) {
    throw new Error("Pre-P2B Release State is not terminal P2A");
  }
  const [
    acceptedStandard,
    containmentCompanion,
    priorStandard,
    priorCompanion,
  ] = await Promise.all([
    resolveBindingProjection({
      store,
      namespace,
      binding: currentStandard,
      label: "Current P2B accepted standard",
    }),
    resolveBindingProjection({
      store,
      namespace,
      binding: currentCompanion,
      label: "Current P2B containment companion",
    }),
    resolveBindingProjection({
      store,
      namespace,
      binding: priorSnapshot.acceptedStandard,
      label: "Pre-P2B accepted standard",
    }),
    resolveBindingProjection({
      store,
      namespace,
      binding: priorSnapshot.containmentCompanion,
      label: "Pre-P2B containment companion",
    }),
  ]);
  if (
    acceptedStandard.cspMode !== "report-only" ||
    containmentCompanion.cspMode !== "report-only" ||
    priorStandard.cspMode !== "none" ||
    priorCompanion.cspMode !== "none"
  ) {
    throw new Error(
      "CSP report artifact dimensions do not prove none to report-only",
    );
  }
  const priorRoute = await resolvePreP2BRouteAuthority({
    store,
    namespace,
    current,
    acceptedRecord: priorAcceptedRecord,
    priorSnapshot,
  });
  const authority = {
    releaseStateHead: { ...current.head },
    acceptedGate: current.snapshot.acceptedGate,
    pendingOperation: null,
    pendingAcceptance: null,
    acceptedStandard,
    containmentCompanion,
    preP2B: {
      acceptedGate: "P2A-LOCAL",
      acceptedEvent: eventReference(namespace, priorAcceptedRecord),
      acceptedStandard: priorStandard,
      containmentCompanion: priorCompanion,
      assignmentValidatedEvent: priorRoute.assignmentValidatedEvent,
      productionProbe: priorRoute.productionProbe,
      reportRoute: priorRoute.route,
    },
  };
  return assertCspReportPhaseStateAuthority(authority);
};

export const deriveCspReportWafAuthority = ({
  providerObservation,
  providerPolicy,
  reportEndpoint = REPORT_ENDPOINT,
}) => {
  const expected = providerPolicy?.wafRules?.cspReportRoute;
  const observed = providerObservation?.wafRules?.cspReportRoute;
  if (!isRecord(expected) || !sameCanonicalValue(expected, observed)) {
    throw new Error("CSP report live provider WAF rule drifted from policy");
  }
  assertExactKeys(
    observed,
    ["action", "active", "conditionGroup", "id", "rateLimit"],
    "CSP report WAF rule",
  );
  const rateLimit = observed.rateLimit;
  assertExactKeys(
    rateLimit,
    ["algo", "keys", "limit", "window"],
    "CSP report WAF rate limit",
  );
  if (
    observed.active !== true ||
    typeof observed.id !== "string" ||
    observed.id.length === 0 ||
    observed.action !== "rate_limit" ||
    rateLimit.algo !== "fixed_window" ||
    !Number.isSafeInteger(rateLimit.limit) ||
    rateLimit.limit < 2 ||
    rateLimit.limit > MAXIMUM_RATE_LIMIT ||
    !Number.isSafeInteger(rateLimit.window) ||
    rateLimit.window < 10 ||
    rateLimit.window > 3600 ||
    !Array.isArray(rateLimit.keys) ||
    rateLimit.keys.length === 0 ||
    new Set(rateLimit.keys).size !== rateLimit.keys.length ||
    rateLimit.keys.some((key) => typeof key !== "string" || key.length === 0)
  ) {
    throw new Error("CSP report WAF rate semantics are invalid");
  }
  if (
    !Array.isArray(observed.conditionGroup) ||
    observed.conditionGroup.length === 0
  ) {
    throw new Error("CSP report WAF condition groups are invalid");
  }
  const conditions = observed.conditionGroup.flatMap((group) => {
    assertExactKeys(group, ["conditions"], "CSP report WAF condition group");
    if (!Array.isArray(group.conditions) || group.conditions.length === 0) {
      throw new Error("CSP report WAF condition group is empty");
    }
    return group.conditions;
  });
  for (const condition of conditions) {
    assertExactKeys(
      condition,
      ["op", "type", "value"],
      "CSP report WAF condition",
    );
  }
  if (
    !conditions.some(
      (condition) =>
        condition.type === "path" &&
        condition.op === "eq" &&
        condition.value === reportEndpoint,
    ) ||
    !conditions.some(
      (condition) =>
        condition.type === "method" &&
        condition.op === "eq" &&
        condition.value === "POST",
    )
  ) {
    throw new Error("CSP report WAF does not bind exact POST route semantics");
  }
  return {
    ruleId: observed.id,
    action: observed.action,
    limit: rateLimit.limit,
    windowSeconds: rateLimit.window,
    keys: [...rateLimit.keys],
    configurationSha256: sha256Json({
      providerConfigurationHash: providerConfigurationHash(providerObservation),
      cspReportRoute: observed,
      ownedProductionDomains: providerObservation.ownedProductionDomains,
    }),
  };
};

export const assertCspReportWafAuthority = (authority) => {
  assertExactKeys(
    authority,
    [
      "action",
      "configurationSha256",
      "keys",
      "limit",
      "ruleId",
      "windowSeconds",
    ],
    "CSP report WAF authority",
  );
  if (
    typeof authority.ruleId !== "string" ||
    authority.ruleId.length === 0 ||
    authority.action !== "rate_limit" ||
    !SHA256.test(authority.configurationSha256 ?? "") ||
    !Number.isSafeInteger(authority.limit) ||
    authority.limit < 2 ||
    authority.limit > MAXIMUM_RATE_LIMIT ||
    !Number.isSafeInteger(authority.windowSeconds) ||
    authority.windowSeconds < 10 ||
    authority.windowSeconds > 3600 ||
    !Array.isArray(authority.keys) ||
    authority.keys.length === 0 ||
    new Set(authority.keys).size !== authority.keys.length ||
    authority.keys.some((key) => typeof key !== "string" || key.length === 0)
  ) {
    throw new Error("CSP report WAF authority is invalid");
  }
  return authority;
};
