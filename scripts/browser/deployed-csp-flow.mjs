import { chromium } from "playwright";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { renderCspPolicyValue } from "../lib/csp-delivery.mjs";
import {
  assertExactKeys,
  assertImmutableObjectReference,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  assertProductionRequestGraphProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority,
  deriveBrowserPhaseExitCollectorIdentity,
  readStoredProductionRequestGraphOidcAuthority,
  resolveProductionRequestGraphBinding,
} from "./production-request-graph.mjs";
import {
  CSP_FULL_FLOW_IDS,
  runCspFullFlows,
} from "./csp-full-flow-adapter.mjs";

export const DEPLOYED_CSP_FLOW_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.deployed-csp-flow-raw+json;version=1";
export const DEPLOYED_CSP_FLOW_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.deployed-csp-flow-observation+json;version=1";

export {
  assertProductionRequestGraphProtectedWorkflow as assertDeployedCspFlowProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority as collectAndStoreDeployedCspFlowOidcAuthority,
};

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_RAW_BYTES = 16 * 1024 * 1024;

const canonicalTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
};

const assertHead = (head) => {
  assertExactKeys(
    head,
    ["eventHash", "sequence"],
    "Deployed CSP Release State head",
  );
  if (
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    !SHA256.test(head.eventHash ?? "")
  ) {
    throw new Error("Deployed CSP Release State head is invalid");
  }
};

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const bindingProjection = (value, namespace, sourceSha) => {
  assertExactKeys(
    value,
    [
      "bindingId",
      "deploymentUrl",
      "policyEligibility",
      "providerDeploymentId",
      "providerProjectId",
      "releaseRole",
      "selection",
      "sourceSha",
    ],
    "Deployed CSP binding",
  );
  if (
    value.sourceSha !== sourceSha ||
    !NAMESPACE.test(namespace) ||
    !["standard", "containment"].includes(value.releaseRole) ||
    !["active-production", "prepared-production"].includes(value.selection) ||
    !["active", "compatible-predecessor"].includes(value.policyEligibility) ||
    typeof value.bindingId !== "string" ||
    value.bindingId.length === 0 ||
    typeof value.providerDeploymentId !== "string" ||
    value.providerDeploymentId.length === 0 ||
    typeof value.providerProjectId !== "string" ||
    value.providerProjectId.length === 0
  ) {
    throw new Error("Deployed CSP binding is invalid");
  }
  const url = new URL(value.deploymentUrl);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )) ||
    url.hash !== ""
  ) {
    throw new Error("Deployed CSP binding URL is invalid");
  }
};

const EXPECTED_CHECKPOINTS = Object.freeze({
  "api-error": ["api-status"],
  "blob-download": ["download-bytes"],
  normal: ["application-ready"],
  offline: ["offline-controlled"],
  "pwa-update": ["controlled", "scope-path"],
  recovery: ["versioned-identity-requests"],
  worker: ["worker-path", "worker-result"],
});

const assertFlow = (flow, expectedHeader) => {
  assertExactKeys(
    flow,
    ["checkpoints", "id", "outcome", "responses", "violations"],
    "Deployed CSP flow",
  );
  if (
    !CSP_FULL_FLOW_IDS.includes(flow.id) ||
    flow.outcome !== "succeeded" ||
    !Array.isArray(flow.responses) ||
    flow.responses.length < 1 ||
    !Array.isArray(flow.checkpoints) ||
    !Array.isArray(flow.violations)
  ) {
    throw new Error(`Deployed CSP flow ${String(flow.id)} is invalid`);
  }
  for (const response of flow.responses) {
    assertExactKeys(
      response,
      ["enforcedHeader", "path", "reportOnlyHeader", "status"],
      `Deployed CSP ${flow.id} response`,
    );
    if (
      response.enforcedHeader !== expectedHeader ||
      response.reportOnlyHeader !== null ||
      typeof response.path !== "string" ||
      !response.path.startsWith("/") ||
      !Number.isSafeInteger(response.status) ||
      response.status < 200 ||
      response.status >= 400
    ) {
      throw new Error(`Deployed CSP ${flow.id} response differs from policy`);
    }
  }
  const checkpointIds = [];
  for (const checkpoint of flow.checkpoints) {
    assertExactKeys(
      checkpoint,
      ["id", "value"],
      `Deployed CSP ${flow.id} checkpoint`,
    );
    if (
      typeof checkpoint.id !== "string" ||
      typeof checkpoint.value !== "string"
    ) {
      throw new Error(`Deployed CSP ${flow.id} checkpoint is invalid`);
    }
    checkpointIds.push(checkpoint.id);
  }
  if (!sameCanonicalValue(checkpointIds, EXPECTED_CHECKPOINTS[flow.id])) {
    throw new Error(`Deployed CSP ${flow.id} checkpoints differ`);
  }
  for (const violation of flow.violations) {
    assertExactKeys(
      violation,
      [
        "blockedUri",
        "disposition",
        "documentUri",
        "effectiveDirective",
        "sourceFile",
      ],
      `Deployed CSP ${flow.id} violation`,
    );
    if (Object.values(violation).some((value) => typeof value !== "string")) {
      throw new Error(`Deployed CSP ${flow.id} violation is invalid`);
    }
  }
};

export const assertDeployedCspFlowRaw = (raw) => {
  assertExactKeys(
    raw,
    [
      "binding",
      "flows",
      "kind",
      "namespace",
      "observedAt",
      "policy",
      "releaseIdentity",
      "releaseStateHead",
      "reportSink",
      "schemaVersion",
      "sourceSha",
    ],
    "Deployed CSP raw trace",
  );
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== "deployed-csp-flow-raw/v1" ||
    !NAMESPACE.test(raw.namespace ?? "") ||
    !SOURCE_SHA.test(raw.sourceSha ?? "") ||
    !Array.isArray(raw.flows) ||
    raw.flows.length !== CSP_FULL_FLOW_IDS.length
  ) {
    throw new Error("Deployed CSP raw trace identity is invalid");
  }
  canonicalTimestamp(raw.observedAt, "Deployed CSP observation time");
  assertHead(raw.releaseStateHead);
  bindingProjection(raw.binding, raw.namespace, raw.sourceSha);
  assertExactKeys(
    raw.policy,
    ["headerName", "headerValue", "policySha256", "reportEndpoint"],
    "Deployed CSP policy",
  );
  if (
    raw.policy.headerName !== "Content-Security-Policy" ||
    !SHA256.test(raw.policy.policySha256 ?? "") ||
    typeof raw.policy.headerValue !== "string" ||
    raw.policy.headerValue.length === 0 ||
    typeof raw.policy.reportEndpoint !== "string" ||
    !raw.policy.reportEndpoint.startsWith("/")
  ) {
    throw new Error("Deployed CSP policy trace is invalid");
  }
  assertExactKeys(
    raw.releaseIdentity,
    ["buildId", "releaseRole", "sourceSha", "variantId"],
    "Deployed CSP release identity",
  );
  if (
    raw.releaseIdentity.sourceSha !== raw.sourceSha ||
    raw.releaseIdentity.buildId !== raw.sourceSha ||
    raw.releaseIdentity.releaseRole !== raw.binding.releaseRole ||
    typeof raw.releaseIdentity.variantId !== "string" ||
    raw.releaseIdentity.variantId.length === 0
  ) {
    throw new Error("Deployed CSP release identity differs from binding");
  }
  assertExactKeys(
    raw.reportSink,
    ["endpoint", "method", "status"],
    "Deployed CSP report sink",
  );
  if (
    raw.reportSink.endpoint !== raw.policy.reportEndpoint ||
    raw.reportSink.method !== "POST" ||
    raw.reportSink.status !== 204
  ) {
    throw new Error("Deployed CSP report sink differs");
  }
  const flowIds = raw.flows.map(({ id }) => id);
  if (!sameCanonicalValue(flowIds, CSP_FULL_FLOW_IDS)) {
    throw new Error("Deployed CSP flow set is incomplete");
  }
  raw.flows.forEach((flow) => assertFlow(flow, raw.policy.headerValue));
  return raw;
};

export const summarizeDeployedCspFlow = (raw, cspPolicy) => {
  assertDeployedCspFlowRaw(raw);
  const expectedHeader = renderCspPolicyValue(cspPolicy);
  const policySha256 = sha256Json(cspPolicy);
  const unexpectedViolationCount = raw.flows.reduce(
    (count, flow) => count + flow.violations.length,
    0,
  );
  if (
    raw.policy.policySha256 !== policySha256 ||
    raw.policy.headerValue !== expectedHeader ||
    raw.policy.reportEndpoint !== cspPolicy.reportEndpoint ||
    unexpectedViolationCount !== 0
  ) {
    throw new Error("Deployed CSP raw trace differs from configured policy");
  }
  return {
    deploymentId: raw.binding.providerDeploymentId,
    headerName: raw.policy.headerName,
    policySha256,
    reportEndpoint: raw.policy.reportEndpoint,
    reportRouteStatus: raw.reportSink.status,
    flows: raw.flows.map(({ id, outcome }) => ({ id, outcome })),
    unexpectedViolationCount,
    outcome: "succeeded",
    traceSha256: sha256Bytes(canonicalJsonBytes(raw)),
  };
};

const readIdentity = async ({ context, binding }) => {
  const origin = new URL(binding.deploymentUrl).origin;
  const response = await context.request.get(
    `${origin}/release-identity.json`,
    {
      failOnStatusCode: false,
      headers: { "cache-control": "no-store" },
    },
  );
  if (!response.ok())
    throw new Error("Deployed CSP release identity unavailable");
  const identity = parseJsonStrict(
    await response.text(),
    "Deployed CSP release identity",
  );
  return {
    sourceSha: identity.sourceSha,
    buildId: identity.buildId,
    releaseRole: identity.releaseRole,
    variantId: identity.variantId,
  };
};

export const observeDeployedCspFlow = async ({
  binding,
  namespace,
  releaseStateHead,
  bindingSelection,
  cspPolicy,
  now = () => Date.now(),
  browserType = chromium,
  runFlows = runCspFullFlows,
}) => {
  const observedAt = new Date(Number(now())).toISOString();
  canonicalTimestamp(observedAt, "Deployed CSP observation time");
  const deploymentUrl = binding.deploymentUrl;
  const target = new URL(deploymentUrl);
  if (
    target.protocol !== "https:" &&
    !(
      target.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(target.hostname)
    )
  ) {
    throw new Error("Deployed CSP target URL is not trusted");
  }
  const expectedCspHeader = renderCspPolicyValue(cspPolicy);
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    let releaseIdentity;
    let reportSink;
    try {
      releaseIdentity = await readIdentity({ context, binding });
      const reportResponse = await context.request.post(
        new URL(cspPolicy.reportEndpoint, deploymentUrl).href,
        {
          data: {
            "csp-report": {
              "blocked-uri": "data:",
              disposition: "enforce",
              "document-uri": new URL(deploymentUrl).origin,
              "effective-directive": "img-src",
            },
          },
          failOnStatusCode: false,
          headers: { "content-type": "application/csp-report" },
        },
      );
      reportSink = {
        endpoint: cspPolicy.reportEndpoint,
        method: "POST",
        status: reportResponse.status(),
      };
    } finally {
      await context.close();
    }
    const flows = await runFlows({
      browser,
      deploymentUrl,
      expectedCspHeader,
    });
    return {
      schemaVersion: 1,
      kind: "deployed-csp-flow-raw/v1",
      namespace,
      sourceSha: binding.sourceSha,
      observedAt,
      releaseStateHead: { ...releaseStateHead },
      binding: { ...bindingSelection },
      policy: {
        policySha256: sha256Json(cspPolicy),
        headerName: "Content-Security-Policy",
        headerValue: expectedCspHeader,
        reportEndpoint: cspPolicy.reportEndpoint,
      },
      releaseIdentity,
      reportSink,
      flows,
    };
  } finally {
    await browser.close();
  }
};

export const readStoredDeployedCspFlow = async ({
  store,
  namespace,
  reference,
  cspPolicy,
}) => {
  if (store?.namespace !== namespace) {
    throw new Error("Deployed CSP store namespace differs");
  }
  assertImmutableObjectReference(
    reference,
    namespace,
    "Deployed CSP raw trace reference",
  );
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== DEPLOYED_CSP_FLOW_RAW_MEDIA_TYPE ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error("Stored deployed CSP raw trace differs");
  }
  const raw = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Stored deployed CSP raw trace",
  );
  if (!canonicalJsonBytes(raw).equals(stored.bytes)) {
    throw new Error("Stored deployed CSP raw trace is not canonical");
  }
  return {
    bytes: Buffer.from(stored.bytes),
    committedAt: stored.committedAt,
    raw,
    result: summarizeDeployedCspFlow(raw, cspPolicy),
  };
};

export const putDeployedCspFlow = async ({ store, raw, cspPolicy }) => {
  if (store?.namespace !== raw?.namespace) {
    throw new Error("Deployed CSP store namespace differs");
  }
  summarizeDeployedCspFlow(raw, cspPolicy);
  const bytes = canonicalJsonBytes(raw);
  if (bytes.length > MAXIMUM_RAW_BYTES)
    throw new Error("Deployed CSP raw trace is oversized");
  const reference = immutableReference(raw.namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: DEPLOYED_CSP_FLOW_RAW_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== DEPLOYED_CSP_FLOW_RAW_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string"
  ) {
    throw new Error("Deployed CSP immutable receipt differs");
  }
  const readback = await readStoredDeployedCspFlow({
    store,
    namespace: raw.namespace,
    reference,
    cspPolicy,
  });
  if (
    !readback.bytes.equals(bytes) ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error("Deployed CSP immutable readback differs");
  }
  return { reference, readback };
};

export const assertDeployedCspFlowObservation = (observation) => {
  assertExactKeys(
    observation,
    [
      "binding",
      "collectorIdentity",
      "kind",
      "namespace",
      "observedAt",
      "oidcReceipt",
      "rawTrace",
      "releaseStateHead",
      "result",
      "schemaVersion",
      "sourceSha",
    ],
    "Deployed CSP observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.kind !== "deployed-csp-flow-observation/v1" ||
    !NAMESPACE.test(observation.namespace ?? "") ||
    !SOURCE_SHA.test(observation.sourceSha ?? "")
  ) {
    throw new Error("Deployed CSP observation identity is invalid");
  }
  canonicalTimestamp(observation.observedAt, "Deployed CSP observation time");
  assertBrowserPhaseExitCollectorIdentity(
    observation.collectorIdentity,
    observation.sourceSha,
  );
  assertHead(observation.releaseStateHead);
  bindingProjection(
    observation.binding,
    observation.namespace,
    observation.sourceSha,
  );
  assertImmutableObjectReference(
    observation.oidcReceipt,
    observation.namespace,
    "Deployed CSP OIDC receipt",
  );
  assertImmutableObjectReference(
    observation.rawTrace,
    observation.namespace,
    "Deployed CSP raw trace",
  );
  assertExactKeys(
    observation.result,
    [
      "deploymentId",
      "flows",
      "headerName",
      "outcome",
      "policySha256",
      "reportEndpoint",
      "reportRouteStatus",
      "traceSha256",
      "unexpectedViolationCount",
    ],
    "Deployed CSP result",
  );
  if (
    observation.result.traceSha256 !== observation.rawTrace.sha256 ||
    observation.result.deploymentId !==
      observation.binding.providerDeploymentId ||
    observation.result.outcome !== "succeeded" ||
    observation.result.unexpectedViolationCount !== 0 ||
    observation.result.headerName !== "Content-Security-Policy" ||
    observation.result.reportRouteStatus !== 204 ||
    !sameCanonicalValue(
      observation.result.flows.map(({ id }) => id),
      CSP_FULL_FLOW_IDS,
    ) ||
    !SHA256.test(observation.result.policySha256 ?? "") ||
    !SHA256.test(observation.result.traceSha256 ?? "") ||
    typeof observation.result.reportEndpoint !== "string" ||
    !observation.result.reportEndpoint.startsWith("/")
  ) {
    throw new Error("Deployed CSP observation result differs");
  }
  for (const flow of observation.result.flows) {
    assertExactKeys(flow, ["id", "outcome"], "Deployed CSP result flow");
    if (!CSP_FULL_FLOW_IDS.includes(flow.id) || flow.outcome !== "succeeded") {
      throw new Error("Deployed CSP observation result flow differs");
    }
  }
  return observation;
};

export const collectAndStoreDeployedCspFlow = async (
  {
    current,
    store,
    namespace,
    sourceSha,
    oidcReceipt,
    oidcAuthority,
    cspPolicy,
    observe = observeDeployedCspFlow,
    now = () => Date.now(),
  },
  { readOidcAuthority = readStoredProductionRequestGraphOidcAuthority } = {},
) => {
  await readOidcAuthority({
    store,
    namespace,
    reference: oidcReceipt,
    approvalPolicy: oidcAuthority.approvalPolicy,
    sourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
  });
  const selected = resolveProductionRequestGraphBinding({
    current,
    namespace,
    sourceSha,
    nowMilliseconds: Number(now()),
  });
  const collectorIdentity = deriveBrowserPhaseExitCollectorIdentity({
    sourceSha,
    oidcAuthority,
  });
  const raw = await observe({
    binding: selected.binding,
    namespace,
    releaseStateHead: current.head,
    bindingSelection: selected.projection,
    cspPolicy,
    now,
  });
  if (
    raw.namespace !== namespace ||
    raw.sourceSha !== sourceSha ||
    !sameCanonicalValue(raw.releaseStateHead, current.head) ||
    !sameCanonicalValue(raw.binding, selected.projection) ||
    raw.releaseIdentity.sourceSha !== selected.binding.sourceSha ||
    raw.releaseIdentity.buildId !== selected.binding.buildId ||
    raw.releaseIdentity.releaseRole !== selected.binding.releaseRole ||
    raw.releaseIdentity.variantId !== selected.binding.variantId
  ) {
    throw new Error("Deployed CSP observation changed its authority");
  }
  const stored = await putDeployedCspFlow({ store, raw, cspPolicy });
  const observation = {
    schemaVersion: 1,
    kind: "deployed-csp-flow-observation/v1",
    namespace,
    sourceSha,
    collectorIdentity,
    observedAt: raw.observedAt,
    releaseStateHead: { ...current.head },
    binding: { ...selected.projection },
    oidcReceipt: { ...oidcReceipt },
    rawTrace: { ...stored.reference },
    result: { ...stored.readback.result },
  };
  assertDeployedCspFlowObservation(observation);
  return observation;
};
