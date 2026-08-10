import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  POLICY_ACTIVATION_DRILL_KIND,
  assertPolicyQaExecutionEvidenceSet,
  buildAuthoritativePolicyActivationClosure,
  validateNonPromotablePolicyQaPackage,
  validatePolicyDrillEvidence,
} from "./policyActivationClosure.mjs";
import {
  POLICY_QA_COMMAND_RECEIPT_MEDIA_TYPE,
  POLICY_QA_DEPLOYMENT_OBSERVATION_MEDIA_TYPE,
  POLICY_QA_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
  POLICY_QA_DRILL_MEDIA_TYPE,
  POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE,
  POLICY_QA_ROUTE_PROBE_MEDIA_TYPE,
  derivePolicyActivationQaDrillDomain,
} from "./policyActivationQaExecution.mjs";

const namespace = "foundation-production";
const executorSourceSha = "e".repeat(40);
const targetSourceSha = "a".repeat(40);
const nowMilliseconds = Date.parse("2026-08-09T05:00:00.000Z");
const HTTP_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-http-transaction+json;version=1";
const OIDC_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1";

const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const createStore = () => {
  const objects = new Map();
  const putBytes = (bytes, mediaType = "application/octet-stream") => {
    const sha256 = sha256Bytes(bytes);
    objects.set(sha256, { bytes: Buffer.from(bytes), mediaType });
    return reference(sha256);
  };
  const putJson = (value, mediaType = "application/json") =>
    putBytes(canonicalJsonBytes(value), mediaType);
  return {
    namespace,
    putBytes,
    putJson,
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { bytes: Buffer.from(stored.bytes), mediaType: stored.mediaType };
    },
  };
};

test("forbids auxiliary policy and package references at the closure boundary", async () => {
  for (const field of [
    "proposedPolicyReference",
    "activePolicyReference",
    "approvalPolicyReference",
    "qaPackageReference",
  ]) {
    await assert.rejects(
      buildAuthoritativePolicyActivationClosure({
        store: {},
        namespace,
        operationId: "policy-P1-00000001",
        executorSourceSha,
        qaExecutionReference: reference("1".repeat(64)),
        [field]: reference("2".repeat(64)),
      }),
      /Caller-supplied policy closure/,
    );
  }
});

test("requires the exact canonical QA execution evidence object set", () => {
  const expected = [reference("b".repeat(64)), reference("a".repeat(64))];
  const canonical = [expected[1], expected[0]];
  assert.deepEqual(
    assertPolicyQaExecutionEvidenceSet({
      actual: canonical,
      expected,
      namespace,
    }),
    canonical,
  );
  assert.throws(
    () =>
      assertPolicyQaExecutionEvidenceSet({
        actual: canonical.slice(0, 1),
        expected,
        namespace,
      }),
    /missing or extra/,
  );
  assert.throws(
    () =>
      assertPolicyQaExecutionEvidenceSet({
        actual: [...canonical, reference("c".repeat(64))],
        expected,
        namespace,
      }),
    /missing or extra/,
  );
});

const storeHttpTransaction = ({
  store,
  method,
  url,
  observedAt,
  requestBody = null,
  responseBody,
  status = 200,
  contentType = "application/json",
  hsts = false,
}) => {
  const requestBytes =
    requestBody === null
      ? null
      : Buffer.isBuffer(requestBody)
        ? requestBody
        : canonicalJsonBytes(requestBody);
  const responseBytes = Buffer.isBuffer(responseBody)
    ? responseBody
    : canonicalJsonBytes(responseBody);
  const requestReference =
    requestBytes === null ? null : store.putBytes(requestBytes);
  const responseReference = store.putBytes(responseBytes);
  const headers = {
    contentType,
    date: observedAt,
    etag: null,
    location: null,
    strictTransportSecurity: hsts ? "max-age=31536000" : null,
  };
  const headersSha256 = sha256Bytes(canonicalJsonBytes(headers));
  const request = {
    body: requestReference,
    bodySha256: requestReference?.sha256 ?? null,
    method,
    url,
  };
  const response = {
    body: responseReference,
    bodySha256: responseReference.sha256,
    headers,
    headersSha256,
    status,
  };
  const transactionSha256 = sha256Bytes(
    canonicalJsonBytes({ observedAt, request, response }),
  );
  return store.putJson(
    {
      schemaVersion: 1,
      evidenceKind: "policy-activation-http-transaction/v1",
      observedAt,
      request,
      response,
      transactionSha256,
    },
    HTTP_MEDIA_TYPE,
  );
};

const providerPolicy = {
  bindingStatus: "configured",
  provider: "vercel",
  expectedProjectId: "project-qa",
  expectedTeamId: "team-qa",
  ownedProductionDomains: ["app.example.test"],
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.test/",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
  },
};

const approvalPolicy = {
  bindingStatus: "configured",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  oidcAudience: "urn:foundation-release-state",
  oidcClockSkewSeconds: 60,
  oidcMaxTokenAgeSeconds: 600,
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
};

const buildQaHarness = async ({
  publicStatus = 200,
  publicUrlSuffix = "/",
  publicContentType = "text/html; charset=utf-8",
  stale = false,
  standardDeploymentHostname = null,
} = {}) => {
  const store = createStore();
  const packageReference = reference("1".repeat(64));
  const proposedPolicyReference = reference("2".repeat(64));
  const operationId = "policy-P1-00000001";
  const deploymentAt = new Date(
    nowMilliseconds - (stale ? 700_000 : 60_000),
  ).toISOString();
  const publicAt = new Date(
    nowMilliseconds - (stale ? 690_000 : 50_000),
  ).toISOString();
  const drillDomain = derivePolicyActivationQaDrillDomain({
    namespace,
    operationId,
    providerPolicy,
  });
  const issuerReceipt = store.putJson(
    {
      schemaVersion: 1,
      kind: "github-actions-oidc-verification/v1",
      issuer: approvalPolicy.trustedIssuer,
      audience: approvalPolicy.oidcAudience,
      subject: `repo:${approvalPolicy.repository}:environment:${approvalPolicy.protectedEnvironment}`,
      tokenSha256: "a".repeat(64),
      signingKey: { kid: "key-1", jwkThumbprintSha256: "b".repeat(64) },
      claims: {
        repository: approvalPolicy.repository,
        workflowRef: approvalPolicy.workflowRef,
        workflowSha: executorSourceSha,
        environment: approvalPolicy.protectedEnvironment,
        runId: "101",
        runAttempt: "1",
        sourceSha: executorSourceSha,
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        refProtected: true,
        jti: "qa-deploy-jti",
        issuedAt: new Date(nowMilliseconds - 120_000).toISOString(),
        notBefore: new Date(nowMilliseconds - 120_000).toISOString(),
        expiresAt: new Date(nowMilliseconds + 120_000).toISOString(),
      },
      verifiedAt: new Date(nowMilliseconds - 90_000).toISOString(),
    },
    OIDC_MEDIA_TYPE,
  );
  const artifacts = [];
  const observationReferences = [];
  for (const [role, suffix] of [
    ["standard", "standard"],
    ["containment", "companion"],
  ]) {
    const publicBody = Buffer.from(`<html>${role}</html>`, "utf8");
    const manifest = {
      sourceSha: targetSourceSha,
      publicResponseHashes: { "/": sha256Bytes(publicBody) },
    };
    const manifestReference = store.putJson(manifest);
    const artifact = {
      bindingId: `policy-qa-operation-${suffix}`,
      releaseRole: role,
      variantId: (role === "standard" ? "3" : "4").repeat(64),
      manifest: manifestReference,
      archive: reference((role === "standard" ? "5" : "6").repeat(64)),
      archiveAvailability: reference(
        (role === "standard" ? "7" : "8").repeat(64),
      ),
    };
    artifacts.push(artifact);
    const deploymentUrl =
      role === "standard" && standardDeploymentHostname !== null
        ? `https://${standardDeploymentHostname}`
        : `https://qa-${suffix}.example.test`;
    const deploymentId = `deployment-${suffix}`;
    const lookupUrl = new URL(
      `/v13/deployments/${new URL(deploymentUrl).hostname}`,
      providerPolicy.observationPolicy.apiBaseUrl,
    );
    lookupUrl.searchParams.set("teamId", providerPolicy.expectedTeamId);
    lookupUrl.searchParams.sort();
    const providerLookup = storeHttpTransaction({
      store,
      method: "GET",
      url: lookupUrl.href,
      observedAt: deploymentAt,
      responseBody: {
        id: deploymentId,
        projectId: providerPolicy.expectedProjectId,
        ownerId: providerPolicy.expectedTeamId,
        url: new URL(deploymentUrl).hostname,
        readyState: "READY",
        target: null,
      },
    });
    const routeBody = store.putBytes(publicBody);
    const routeProbe = store.putJson(
      {
        schemaVersion: 1,
        evidenceKind: "policy-activation-qa-route-probe/v1",
        namespace,
        bindingId: artifact.bindingId,
        releaseRole: role,
        manifest: artifact.manifest,
        deploymentUrl,
        providerProjectId: providerPolicy.expectedProjectId,
        providerDeploymentId: deploymentId,
        observedAt: publicAt,
        routes: [
          {
            path: "/",
            requestUrl: new URL(publicUrlSuffix, `${deploymentUrl}/`).href,
            responseUrl: new URL(publicUrlSuffix, `${deploymentUrl}/`).href,
            status: publicStatus,
            responseDate: publicAt,
            etag: '"qa"',
            contentType: publicContentType,
            cacheControl: null,
            securityHeaders: {
              "content-security-policy": null,
              "permissions-policy": null,
              "referrer-policy": null,
              "strict-transport-security": "max-age=31536000",
              "x-content-type-options": null,
              "x-frame-options": null,
            },
            bodySha256: routeBody.sha256,
            byteLength: publicBody.length,
            body: routeBody,
          },
        ],
        publicIdentity: { identityKind: "release-identity-v1" },
        runtimeHtmlIdentity: {
          buildId: targetSourceSha,
          sourceSha: targetSourceSha,
        },
      },
      POLICY_QA_ROUTE_PROBE_MEDIA_TYPE,
    );
    const deploymentReceipt = store.putJson(
      {
        schemaVersion: 1,
        receiptKind: "policy-activation-qa-deployment-receipt/v1",
        namespace,
        operationId,
        workflowRunId: "101",
        executorSourceSha,
        issuerReceipt,
        qaPackage: packageReference,
        proposedReleasePolicy: proposedPolicyReference,
        bindingId: artifact.bindingId,
        releaseRole: role,
        variantId: artifact.variantId,
        manifest: artifact.manifest,
        archive: artifact.archive,
        environment: "non-production",
        providerProjectId: providerPolicy.expectedProjectId,
        providerDeploymentId: deploymentId,
        deploymentUrl,
        providerLookup,
        cli: {
          package: "vercel",
          version: "50.5.0",
          operation: "deploy-prebuilt-preview-skip-domain",
        },
        startedAt: new Date(Date.parse(deploymentAt) - 1000).toISOString(),
        completedAt: publicAt,
      },
      POLICY_QA_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
    );
    observationReferences.push(
      store.putJson(
        {
          schemaVersion: 1,
          evidenceKind: "policy-activation-qa-deployment/v1",
          namespace,
          operationId,
          environment: "non-production",
          bindingId: artifact.bindingId,
          releaseRole: role,
          variantId: artifact.variantId,
          qaPackage: packageReference,
          proposedReleasePolicy: proposedPolicyReference,
          providerProjectId: providerPolicy.expectedProjectId,
          providerDeploymentId: deploymentId,
          deploymentUrl,
          sourceSha: targetSourceSha,
          drillDomain,
          deploymentReceipt,
          routeProbe,
          observedAt: publicAt,
        },
        POLICY_QA_DEPLOYMENT_OBSERVATION_MEDIA_TYPE,
      ),
    );
  }
  const index = {
    sourceSha: targetSourceSha,
    toolchainPolicyHash: "9".repeat(64),
    artifacts,
  };
  const validate = () =>
    validateNonPromotablePolicyQaPackage(
      {
        store,
        namespace,
        packageReference,
        standardDeploymentObservationReference: observationReferences[0],
        companionDeploymentObservationReference: observationReferences[1],
        proposedPolicy: {},
        proposedPolicyReference,
        activationGate: "P1-PWA",
        executorSourceSha,
        providerPolicy,
        approvalPolicy,
        nowMilliseconds,
      },
      { validatePackage: async () => index },
    );
  return { validate };
};

test("accepts source-bound nonpromotable QA deployments through exact public routes", async () => {
  const harness = await buildQaHarness();
  const result = await harness.validate();
  assert.equal(result.receiptResult.nonPromotable, true);
  assert.equal(result.receiptResult.sourceSha, targetSourceSha);
});

for (const [label, options, pattern] of [
  ["wrong status", { publicStatus: 503 }, /public route proof/],
  ["wrong route", { publicUrlSuffix: "/wrong" }, /public route proof/],
  [
    "wrong content type",
    { publicContentType: "application/json" },
    /public route proof/,
  ],
  ["stale observation", { stale: true }, /outside provider freshness/],
  [
    "owned production deployment origin",
    { standardDeploymentHostname: "app.example.test" },
    /overlaps production authority/,
  ],
  [
    "production subdomain deployment origin",
    { standardDeploymentHostname: "preview.app.example.test" },
    /overlaps production authority/,
  ],
]) {
  test(`rejects a QA deployment with ${label}`, async () => {
    const harness = await buildQaHarness(options);
    await assert.rejects(harness.validate(), pattern);
  });
}

const buildDrillHarness = async ({
  issuer = approvalPolicy.trustedIssuer,
  sourceSha = executorSourceSha,
  commandStatus = 200,
  publicStatus = 200,
  publicContentType = "text/html",
  stale = false,
  publicBody = Buffer.from("accepted-standard", "utf8"),
} = {}) => {
  const store = createStore();
  const drillDomain = "policy-drill.example.test";
  const drillId = "rollback-drill-1";
  const commandAt = new Date(
    nowMilliseconds - (stale ? 700_000 : 30_000),
  ).toISOString();
  const observationAt = new Date(
    nowMilliseconds - (stale ? 690_000 : 20_000),
  ).toISOString();
  const sourceBinding = {
    bindingId: "qa-standard-binding",
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: "qa-standard-deployment",
  };
  const targetBinding = {
    bindingId: "accepted-standard-binding",
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: "accepted-standard-deployment",
  };
  const targetManifest = {
    publicResponseHashes: {
      "/": sha256Bytes(Buffer.from("accepted-standard", "utf8")),
    },
  };
  const approvalPolicyReference = store.putJson(approvalPolicy);
  const commandUrl = new URL(
    `/v2/deployments/${targetBinding.providerDeploymentId}/aliases`,
    providerPolicy.observationPolicy.apiBaseUrl,
  );
  commandUrl.searchParams.set("teamId", providerPolicy.expectedTeamId);
  commandUrl.searchParams.sort();
  const providerCommandEvidence = storeHttpTransaction({
    store,
    method: "POST",
    url: commandUrl.href,
    observedAt: commandAt,
    requestBody: { alias: drillDomain },
    responseBody: { alias: drillDomain },
    status: commandStatus,
  });
  const issuerReceipt = store.putJson(
    {
      schemaVersion: 1,
      kind: "github-actions-oidc-verification/v1",
      issuer,
      audience: approvalPolicy.oidcAudience,
      subject: `repo:${approvalPolicy.repository}:environment:${approvalPolicy.protectedEnvironment}`,
      tokenSha256: "a".repeat(64),
      signingKey: { kid: "key-1", jwkThumbprintSha256: "b".repeat(64) },
      claims: {
        repository: approvalPolicy.repository,
        workflowRef: approvalPolicy.workflowRef,
        workflowSha: sourceSha,
        environment: approvalPolicy.protectedEnvironment,
        runId: "101",
        runAttempt: "1",
        sourceSha,
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        refProtected: true,
        jti: "oidc-jti-1",
        issuedAt: new Date(nowMilliseconds - 60_000).toISOString(),
        notBefore: new Date(nowMilliseconds - 60_000).toISOString(),
        expiresAt: new Date(nowMilliseconds + 120_000).toISOString(),
      },
      verifiedAt: new Date(nowMilliseconds - 40_000).toISOString(),
    },
    OIDC_MEDIA_TYPE,
  );
  const commandReceipt = store.putJson(
    {
      schemaVersion: 1,
      receiptKind: "policy-rollback-drill-command/v1",
      namespace,
      drillId,
      action: "rollback",
      approvalPolicy: approvalPolicyReference,
      sourceBindingId: sourceBinding.bindingId,
      targetBindingId: targetBinding.bindingId,
      executorSourceSha,
      workflowRunId: "101",
      completedAt: commandAt,
      issuerReceipt,
      providerCommandEvidence,
    },
    POLICY_QA_COMMAND_RECEIPT_MEDIA_TYPE,
  );
  const publicResponse = storeHttpTransaction({
    store,
    method: "GET",
    url: `https://${drillDomain}/`,
    observedAt: observationAt,
    responseBody: publicBody,
    status: publicStatus,
    contentType: publicContentType,
    hsts: true,
  });
  const providerObservation = store.putJson(
    {
      schemaVersion: 1,
      observationKind: "policy-drill-provider-observation/v1",
      namespace,
      drillId,
      action: "rollback",
      providerProjectId: targetBinding.providerProjectId,
      providerDeploymentId: targetBinding.providerDeploymentId,
      drillDomain,
      observedDomains: [drillDomain],
      publicResponse,
      observedAt: observationAt,
    },
    POLICY_QA_PROVIDER_OBSERVATION_MEDIA_TYPE,
  );
  const previousReleasePolicy = reference("c".repeat(64));
  const proposedReleasePolicy = reference("d".repeat(64));
  const activeReleasePolicy = reference("e".repeat(64));
  const qaPackageIndex = reference("f".repeat(64));
  const drill = store.putJson(
    {
      schemaVersion: 1,
      drillKind: POLICY_ACTIVATION_DRILL_KIND,
      namespace,
      drillId,
      action: "rollback",
      status: "passed",
      drillDomain,
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      qaPackageIndex,
      sourceBindingId: sourceBinding.bindingId,
      targetBindingId: targetBinding.bindingId,
      commandReceipt,
      providerObservation,
    },
    POLICY_QA_DRILL_MEDIA_TYPE,
  );
  const validate = () =>
    validatePolicyDrillEvidence({
      store,
      namespace,
      reference: drill,
      expectedAction: "rollback",
      previousReleasePolicy,
      proposedReleasePolicy,
      activeReleasePolicy,
      qaPackageIndex,
      sourceBinding,
      targetBinding,
      targetManifest,
      providerPolicy,
      approvalPolicy,
      approvalPolicyReference,
      executorSourceSha,
      nowMilliseconds,
    });
  return { validate };
};

test("accepts a fresh hash-bound rollback drill with trusted OIDC authority", async () => {
  const harness = await buildDrillHarness();
  const result = await harness.validate();
  assert.equal(result.drillDomain, "policy-drill.example.test");
});

for (const [label, options, pattern] of [
  [
    "untrusted issuer",
    { issuer: "https://issuer.example.test" },
    /OIDC authority/,
  ],
  ["wrong executor source", { sourceSha: "0".repeat(40) }, /OIDC authority/],
  [
    "failed alias command",
    { commandStatus: 500 },
    /route, status, header, or body/,
  ],
  [
    "failed public probe",
    { publicStatus: 500 },
    /route, status, header, or body/,
  ],
  [
    "wrong response header",
    { publicContentType: "application/json" },
    /route, status, header, or body/,
  ],
  [
    "tampered public body",
    { publicBody: Buffer.from("tampered", "utf8") },
    /route, status, header, or body/,
  ],
  ["stale provider evidence", { stale: true }, /outside provider freshness/],
]) {
  test(`rejects drill evidence with ${label}`, async () => {
    const harness = await buildDrillHarness(options);
    await assert.rejects(harness.validate(), pattern);
  });
}
