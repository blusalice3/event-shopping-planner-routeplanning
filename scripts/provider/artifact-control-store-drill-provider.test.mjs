import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  assertArtifactDrillAssignmentReceipt,
  assertArtifactDrillBuildReceipt,
  assertArtifactDrillDeploymentReceipt,
  assertArtifactDrillProviderCleanupReceipt,
  assertArtifactDrillReconcileReceipt,
  assertArtifactDrillRedeployReceipt,
  ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
} from "./artifact-control-store-drill-receipts.mjs";
import {
  assertArtifactDrillPreviewOnlyArguments,
  cleanupArtifactDrillProviderResources,
  deriveArtifactDrillPreviewDomains,
  executeArtifactControlStoreLiveOperations,
} from "./artifact-control-store-drill-provider.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const drillNamespace = "artifact-drill-0123456789abcdef0123456789abcdef";
const hash = (character) => character.repeat(64);
const providerPolicy = {
  expectedProjectId: "project-id",
  expectedTeamId: "team-id",
};
const forbiddenAliases = ["app.example.com", "www.example.com"];
const authority = {
  collectorIdentity: {
    repository: "owner/repository",
    workflowPath: ".github/workflows/release.yml",
    sourceSha,
    runId: "12345",
    runAttempt: "1",
  },
  databaseEndpointSha256: hash("1"),
  databasePolicySha256: hash("2"),
  drillNamespace,
  providerPolicySha256: hash("3"),
  sourceSha,
  toolchainSha256: hash("4"),
};
const provider = (hostname = "preview.vercel.app") => ({
  date: "Sun, 09 Aug 2026 00:00:00 GMT",
  deploymentTarget: null,
  etag: '"deployment"',
  projectId: providerPolicy.expectedProjectId,
  readyState: "READY",
  requestUrl: `https://api.vercel.com/v13/deployments/${hostname}?teamId=team-id`,
  responseSha256: hash("5"),
  status: 200,
  teamId: providerPolicy.expectedTeamId,
});
const expected = { authority, forbiddenAliases, providerPolicy };

test("accepts only the exact preview-only Vercel command shape", () => {
  const command = [
    "C:/vercel/index.js",
    "deploy",
    "--prebuilt",
    "--skip-domain",
    "--yes",
    "--cwd",
    "C:/preview-root",
  ];
  assert.equal(assertArtifactDrillPreviewOnlyArguments(command), command);
  for (const mutation of [
    [...command.slice(0, 3), "--prod", ...command.slice(3)],
    [...command, "--force"],
    command.filter((value) => value !== "--skip-domain"),
    command.with(1, "build"),
    command.with(2, "--target=production"),
  ]) {
    assert.throws(
      () => assertArtifactDrillPreviewOnlyArguments(mutation),
      /preview-only/,
    );
  }
});

test("derives role-scoped aliases and denies every production overlap direction", () => {
  const domains = deriveArtifactDrillPreviewDomains({
    drillNamespace,
    aliasSuffix: "drill.example.net",
    forbiddenAliases,
  });
  assert.deepEqual(domains, {
    containment: `${drillNamespace}.containment.drill.example.net`,
    standard: `${drillNamespace}.standard.drill.example.net`,
  });
  for (const aliasSuffix of [
    "app.example.com",
    "preview.app.example.com",
    `${"a".repeat(240)}.net`,
  ]) {
    assert.throws(
      () =>
        deriveArtifactDrillPreviewDomains({
          drillNamespace,
          aliasSuffix,
          forbiddenAliases,
        }),
      /overlaps|oversized/,
    );
  }
});

test("deployment receipt rejects production target, domain, and provider drift", () => {
  const receipt = {
    schemaVersion: 1,
    kind: "artifact-drill-preview-deployment-receipt/v1",
    authority,
    deploymentId: "deployment-id",
    previewUrl: "https://preview.vercel.app/",
    packageArchiveSha256: hash("6"),
    manifestSha256: hash("7"),
    provider: provider(),
    role: "standard",
    routeProbes: [{ path: "/", responseSha256: hash("8"), status: 200 }],
    target: "preview",
  };
  assert.equal(
    assertArtifactDrillDeploymentReceipt(receipt, expected),
    receipt,
  );
  for (const mutate of [
    (value) => (value.target = "production"),
    (value) => (value.provider.deploymentTarget = "production"),
    (value) => (value.provider.projectId = "other-project"),
    (value) => {
      value.previewUrl = "https://app.example.com/";
      value.provider.requestUrl =
        "https://api.vercel.com/v13/deployments/app.example.com?teamId=team-id";
    },
  ]) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    assert.throws(
      () => assertArtifactDrillDeploymentReceipt(candidate, expected),
      /invalid|differs|production|semantics/,
    );
  }
});

test("alias receipt binds the mutation and authoritative readback", () => {
  const domain = `${drillNamespace}.standard.drill.example.net`;
  const receipt = {
    schemaVersion: 1,
    kind: "artifact-drill-preview-assignment-receipt/v1",
    authority,
    deploymentId: "deployment-id",
    domain,
    provider: {
      commandRequestUrl:
        "https://api.vercel.com/v2/deployments/deployment-id/aliases?teamId=team-id",
      commandResponseSha256: hash("8"),
      date: "Sun, 09 Aug 2026 00:00:00 GMT",
      etag: '"alias"',
      observedDeploymentId: "deployment-id",
      observedProjectId: providerPolicy.expectedProjectId,
      requestUrl: `https://api.vercel.com/v4/aliases/${domain}?teamId=team-id`,
      responseSha256: hash("9"),
      status: 200,
    },
  };
  const assignmentExpected = {
    ...expected,
    aliasSuffix: "drill.example.net",
  };
  assert.equal(
    assertArtifactDrillAssignmentReceipt(receipt, assignmentExpected),
    receipt,
  );
  for (const mutate of [
    (value) => (value.provider.observedDeploymentId = "other"),
    (value) => (value.provider.observedProjectId = "other"),
    (value) =>
      (value.provider.commandRequestUrl =
        "https://api.vercel.com/v2/deployments/other/aliases?teamId=team-id"),
    (value) => (value.domain = "app.example.com"),
  ]) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    assert.throws(
      () => assertArtifactDrillAssignmentReceipt(candidate, assignmentExpected),
      /invalid|differs|overlaps/,
    );
  }
});

test("redeploy and reconcile require a new deployment and exact two-domain mapping", () => {
  const redeploy = {
    schemaVersion: 1,
    kind: "artifact-drill-preview-redeploy-receipt/v1",
    authority,
    firstDeploymentId: "deployment-first",
    redeployedDeploymentId: "deployment-second",
    previewUrl: "https://preview.vercel.app/",
    packageArchiveSha256: hash("6"),
    manifestSha256: hash("7"),
    provider: provider(),
    routeProbes: [{ path: "/", responseSha256: hash("8"), status: 200 }],
  };
  assert.equal(
    assertArtifactDrillRedeployReceipt(redeploy, expected),
    redeploy,
  );
  assert.throws(
    () =>
      assertArtifactDrillRedeployReceipt(
        { ...redeploy, redeployedDeploymentId: redeploy.firstDeploymentId },
        expected,
      ),
    /invalid/,
  );
  const productionRedeploy = structuredClone(redeploy);
  productionRedeploy.previewUrl = `https://${forbiddenAliases[0]}/`;
  productionRedeploy.provider.requestUrl = `https://api.vercel.com/v13/deployments/${forbiddenAliases[0]}?teamId=team-id`;
  assert.throws(
    () => assertArtifactDrillRedeployReceipt(productionRedeploy, expected),
    /production domain/,
  );
  const reconcile = {
    schemaVersion: 1,
    kind: "artifact-drill-preview-reconcile-receipt/v1",
    authority,
    assignments: ["containment", "standard"].map((role, index) => ({
      deploymentId: `deployment-${role}`,
      domain: `${drillNamespace}.${role}.drill.example.net`,
      responseSha256: hash(index === 0 ? "a" : "b"),
    })),
  };
  assert.equal(
    assertArtifactDrillReconcileReceipt(reconcile, expected),
    reconcile,
  );
  assert.throws(
    () =>
      assertArtifactDrillReconcileReceipt(
        { ...reconcile, assignments: [reconcile.assignments[0]] },
        expected,
      ),
    /invalid/,
  );
});

test("build receipt retains and hashes the complete build authority document", () => {
  const bootstrapVerification = {
    sourceSha,
    packageIndexSha256: hash("1"),
    artifactManifestSha256: hash("2"),
    artifactArchiveSha256: hash("3"),
    rawDistManifestSha256: hash("4"),
    rawDistTreeSha256: hash("5"),
    rawDistFileCount: 3,
    preserved: true,
    releaseIdentityAbsent: true,
  };
  const document = {
    schemaVersion: 1,
    authorityKind: "artifact-drill-build-authority/v1",
    sourceSha,
    targetGate: "P0-ARTIFACT",
    buildPurpose: "non-promotable-artifact-drill",
    promotable: false,
    releasePolicySha256: hash("6"),
    toolchainPolicySha256: authority.toolchainSha256,
    providerPolicySha256: authority.providerPolicySha256,
    providerObservationSha256: hash("7"),
    providerConfigurationHash: hash("8"),
    cspPolicySha256: hash("9"),
    dbCompatibility: {
      contractUri: "urn:fixture:db-contract",
      fingerprint: hash("a"),
    },
    foundationBaselineSha256: hash("b"),
    standardDimensions: { releaseRole: "standard" },
    containmentDimensions: { releaseRole: "containment" },
    bootstrapVerification,
  };
  const sha256 = sha256Bytes(canonicalJsonBytes(document));
  const receipt = {
    schemaVersion: 1,
    kind: "artifact-drill-build-receipt/v1",
    attempt: 1,
    authority,
    bootstrapVerification,
    buildAuthority: {
      document,
      reference: {
        uri: `artifact://sha256/${sha256}/artifact-drill-build-authority.json`,
        sha256,
      },
    },
    buildPurpose: "non-promotable-artifact-drill",
    packageArchiveSha256: hash("c"),
    packageIndexSha256: hash("d"),
    roles: ["containment", "standard"].map((role, index) => ({
      archiveSha256: hash(index === 0 ? "e" : "f"),
      capabilitySha256: hash("1"),
      dbFingerprint: hash("2"),
      manifestSha256: hash(index === 0 ? "3" : "4"),
      policySha256: hash("5"),
      role,
    })),
  };
  assert.equal(
    assertArtifactDrillBuildReceipt(receipt, { authority, attempt: 1 }),
    receipt,
  );
  const tampered = structuredClone(receipt);
  tampered.buildAuthority.document.cspPolicySha256 = hash("c");
  assert.throws(
    () => assertArtifactDrillBuildReceipt(tampered, { authority, attempt: 1 }),
    /authority receipt differs/,
  );
});

const cleanupStore = () => {
  const objects = new Map();
  return {
    namespace: drillNamespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        mediaType,
        committedAt: "2026-08-09T00:00:00.000Z",
      });
      return {
        uri: `release-state://${drillNamespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
  };
};

const providerResponse = (status, value = { error: { code: "not_found" } }) => {
  const bytes = canonicalJsonBytes(value);
  return {
    status,
    headers: {
      get(name) {
        return name === "content-length" ? String(bytes.length) : null;
      },
    },
    async arrayBuffer() {
      return bytes;
    },
  };
};

const cleanupResources = () => ({
  aliases: [
    {
      domain: `${drillNamespace}.standard.drill.example.net`,
      deploymentId: "deployment-id",
    },
  ],
  deployments: [
    {
      deploymentId: "deployment-id",
      previewUrl: "https://preview.vercel.app/",
    },
  ],
});

test("provider cleanup deletes only tracked previews and proves idempotent 404 readback", async () => {
  const store = cleanupStore();
  const deletedAliases = new Set();
  const deletedDeployments = new Set();
  const calls = [];
  const fetchImpl = async (requestUrl, options) => {
    const url = new URL(requestUrl);
    const method = options.method;
    calls.push({ method, pathname: url.pathname });
    if (url.pathname.startsWith("/v4/aliases/")) {
      const domain = decodeURIComponent(
        url.pathname.slice("/v4/aliases/".length),
      );
      return deletedAliases.has(domain)
        ? providerResponse(404)
        : providerResponse(200, {
            alias: domain,
            deploymentId: "deployment-id",
            projectId: providerPolicy.expectedProjectId,
          });
    }
    if (url.pathname.startsWith("/v2/aliases/")) {
      const domain = decodeURIComponent(
        url.pathname.slice("/v2/aliases/".length),
      );
      const replayed = deletedAliases.has(domain);
      deletedAliases.add(domain);
      return providerResponse(
        replayed ? 404 : 200,
        replayed ? { error: { code: "not_found" } } : { status: "SUCCESS" },
      );
    }
    const key = decodeURIComponent(
      url.pathname.slice("/v13/deployments/".length),
    );
    const deploymentId = key === "preview.vercel.app" ? "deployment-id" : key;
    if (method === "DELETE") {
      const replayed = deletedDeployments.has(deploymentId);
      deletedDeployments.add(deploymentId);
      return providerResponse(
        replayed ? 404 : 200,
        replayed
          ? { error: { code: "not_found" } }
          : { state: "DELETED", uid: deploymentId },
      );
    }
    return deletedDeployments.has(deploymentId)
      ? providerResponse(404)
      : providerResponse(200, {
          id: "deployment-id",
          url: "preview.vercel.app",
          projectId: providerPolicy.expectedProjectId,
          ownerId: providerPolicy.expectedTeamId,
          target: null,
        });
  };
  const options = {
    authority,
    resources: cleanupResources(),
    drillStore: store,
    providerPolicy,
    aliasSuffix: "drill.example.net",
    forbiddenAliases,
    token: "provider-token",
    fetchImpl,
  };
  const first = await cleanupArtifactDrillProviderResources(options);
  assert.equal(first.receipt.aliases.length, 1);
  assert.equal(first.receipt.deployments.length, 1);
  assert.equal(
    assertArtifactDrillProviderCleanupReceipt(first.receipt, {
      authority,
      aliasSuffix: options.aliasSuffix,
      forbiddenAliases,
      providerPolicy,
    }),
    first.receipt,
  );
  assert.equal(
    store.objects.get(first.reference.sha256).mediaType,
    ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
  );
  const replay = await cleanupArtifactDrillProviderResources(options);
  assert.equal(replay.receipt.aliases[0].preDelete.status, 404);
  assert.equal(replay.receipt.aliases[0].deletion.status, 404);
  assert.equal(replay.receipt.deployments[0].preDelete.status, 404);
  assert.equal(replay.receipt.deployments[0].deletion.status, 404);
  assert.equal(calls.filter(({ method }) => method === "DELETE").length, 4);
});

test("provider cleanup rejects production aliases and foreign projects before DELETE", async () => {
  let networkCallCount = 0;
  await assert.rejects(
    cleanupArtifactDrillProviderResources({
      authority,
      resources: {
        aliases: [
          {
            domain: `${drillNamespace}.app.example.com`,
            deploymentId: "deployment-id",
          },
        ],
        deployments: [],
      },
      drillStore: cleanupStore(),
      providerPolicy,
      aliasSuffix: "app.example.com",
      forbiddenAliases,
      token: "provider-token",
      fetchImpl: async () => {
        networkCallCount += 1;
        return providerResponse(500);
      },
    }),
    /production|overlaps/,
  );
  assert.equal(networkCallCount, 0);

  let deleteCallCount = 0;
  await assert.rejects(
    cleanupArtifactDrillProviderResources({
      authority,
      resources: { aliases: [], deployments: cleanupResources().deployments },
      drillStore: cleanupStore(),
      providerPolicy,
      aliasSuffix: "drill.example.net",
      forbiddenAliases,
      token: "provider-token",
      fetchImpl: async (_requestUrl, options) => {
        if (options.method === "DELETE") deleteCallCount += 1;
        return providerResponse(200, {
          id: "deployment-id",
          url: "preview.vercel.app",
          projectId: "foreign-project",
          ownerId: providerPolicy.expectedTeamId,
          target: null,
        });
      },
    }),
    /cleanup failed/,
  );
  assert.equal(deleteCallCount, 0);
});

test("provider cleanup network or readback failure fails the collector", async () => {
  await assert.rejects(
    cleanupArtifactDrillProviderResources({
      authority,
      resources: { aliases: cleanupResources().aliases, deployments: [] },
      drillStore: cleanupStore(),
      providerPolicy,
      aliasSuffix: "drill.example.net",
      forbiddenAliases,
      token: "provider-token",
      fetchImpl: async (requestUrl, options) => {
        if (options.method === "DELETE") throw new Error("network unavailable");
        const domain = decodeURIComponent(
          new URL(requestUrl).pathname.slice("/v4/aliases/".length),
        );
        return providerResponse(200, {
          alias: domain,
          deploymentId: "deployment-id",
          projectId: providerPolicy.expectedProjectId,
        });
      },
    }),
    /cleanup failed/,
  );
});

test("provider cleanup rejects undocumented or untyped deletion responses", async () => {
  for (const deletionResponse of [
    providerResponse(204, { status: "SUCCESS" }),
    providerResponse(200, { status: "UNKNOWN" }),
  ]) {
    await assert.rejects(
      cleanupArtifactDrillProviderResources({
        authority,
        resources: { aliases: cleanupResources().aliases, deployments: [] },
        drillStore: cleanupStore(),
        providerPolicy,
        aliasSuffix: "drill.example.net",
        forbiddenAliases,
        token: "provider-token",
        fetchImpl: async (requestUrl, options) => {
          if (options.method === "DELETE") return deletionResponse;
          const domain = decodeURIComponent(
            new URL(requestUrl).pathname.slice("/v4/aliases/".length),
          );
          return providerResponse(200, {
            alias: domain,
            deploymentId: "deployment-id",
            projectId: providerPolicy.expectedProjectId,
          });
        },
      }),
      /cleanup failed/,
    );
  }
});

test("live executor aggregates its primary failure with provider cleanup failure", async () => {
  let cleanupCallCount = 0;
  await assert.rejects(
    executeArtifactControlStoreLiveOperations(
      {
        authority,
        drillNamespace,
        forbiddenAliases,
        previewOnly: true,
        sourceSha,
        drillStore: { namespace: drillNamespace },
        controlStoreExecutor: async () => ({ ok: true }),
        providerPolicy: {
          ...providerPolicy,
          provider: "vercel",
          bindingStatus: "configured",
        },
        artifactDrillPolicy: {
          providerPreviewAliasSuffix: "drill.example.net",
        },
        buildOptions: { rawDistRoot: "fixture-raw-dist" },
        cspPolicy: {},
        toolchainPolicy: { runtime: { node: "24.19.0", npm: "11.19.0" } },
        environment: {
          VERCEL_TOKEN: "provider-token",
          VERCEL_PROJECT_ID: providerPolicy.expectedProjectId,
          VERCEL_ORG_ID: providerPolicy.expectedTeamId,
        },
      },
      {
        buildPackage: async () => {
          throw new Error("build failed after control-store start");
        },
        fetchImpl: async () => {
          throw new Error("provider network must not start");
        },
        cleanupProviderResources: async () => {
          cleanupCallCount += 1;
          throw new Error("provider cleanup network failed");
        },
      },
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(
        error.errors.map(({ message }) => message).join("\n"),
        /build failed.*provider cleanup network failed/su,
      );
      return true;
    },
  );
  assert.equal(cleanupCallCount, 1);
});
