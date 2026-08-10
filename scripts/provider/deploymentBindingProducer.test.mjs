import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  contentAddressedObjectPath,
  writeContentAddressedObject,
} from "../lib/content-addressed-store.mjs";
import { renderCspHeaders } from "../lib/csp-delivery.mjs";
import { OUTER_AGENT_ENTRY_MODULE } from "../lib/outer-agent-contract.mjs";
import { POLICY_ACTIVATION_QA_BUILD_PURPOSE } from "../lib/release-build-input.mjs";
import { computeVariantId } from "../lib/release-policy.mjs";
import { produceDeploymentBinding } from "./deploymentBindingProducer.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";

const NAMESPACE = "deployment-producer-test";
const SOURCE_SHA = "1".repeat(40);
const FIXED_TIME = "2026-08-06T00:00:00.000Z";
const FIXED_NOW = Date.parse(FIXED_TIME);
const BUILD_AUTHORITY_SHA = "6".repeat(64);
const BUILD_AUTHORITY = Object.freeze({
  uri: `release-state://${NAMESPACE}/evidence/${BUILD_AUTHORITY_SHA}`,
  sha256: BUILD_AUTHORITY_SHA,
});
const DEPLOYMENT_URL = "https://immutable-binding-test.vercel.app";
const CSP_POLICY = {
  schemaVersion: 1,
  directives: {
    "default-src": ["'self'"],
    "object-src": ["'none'"],
  },
  securityHeaders: {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=()",
  },
};
const RELEASE_POLICY = {
  schemaVersion: 1,
  dimensions: {
    releaseRole: ["standard", "containment"],
    pwaLifecycle: ["legacy-auto-update-v1"],
    cssDelivery: ["cdn"],
    cspMode: ["none"],
    xlsxExecution: ["main"],
    listEngine: ["full"],
    listDefault: ["full"],
    persistenceArchitecture: ["monolith"],
  },
};
const STANDARD_DIMENSIONS = {
  releaseRole: "standard",
  pwaLifecycle: "legacy-auto-update-v1",
  cssDelivery: "cdn",
  cspMode: "none",
  xlsxExecution: "main",
  listEngine: "full",
  listDefault: "full",
  persistenceArchitecture: "monolith",
};
const PROVIDER_POLICY = {
  schemaVersion: 1,
  provider: "vercel",
  bindingStatus: "configured",
  blockerCodes: [],
  expectedProjectId: "project-test",
  expectedTeamId: "team-test",
  ownedProductionDomains: ["app.example.test"],
  productionEnvironmentName: "production",
  requiredEnvironmentNames: ["REQUIRED_ENV"],
  cspReportEnvironmentNames: [],
  forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
  hstsOwner: "provider",
  hstsPolicy: {
    minimumMaxAgeSeconds: 3600,
    requireIncludeSubDomains: true,
    requirePreload: false,
  },
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
  },
};
const TOOLCHAIN_POLICY = {
  schemaVersion: 1,
  packages: { vercel: "58.5.1" },
};
const DB_COMPATIBILITY = {
  contractUri: "urn:test:db:v1",
  fingerprint: "4".repeat(64),
};
const DB_CONTRACT = { schemaVersion: 1 };

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

class FakeStore {
  constructor(events) {
    this.namespace = NAMESPACE;
    this.events = events;
    this.values = new Map();
  }

  async putEvidence({ bytes, mediaType }) {
    this.events.push("store");
    const storedBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(storedBytes);
    const replayed = this.values.has(sha256);
    this.values.set(sha256, {
      bytes: storedBytes,
      mediaType,
      committedAt: FIXED_TIME,
    });
    return {
      uri: `release-state://${NAMESPACE}/evidence/${sha256}`,
      sha256,
      mediaType,
      byteLength: storedBytes.length,
      committedAt: FIXED_TIME,
      replayed,
    };
  }

  async readEvidence({ sha256 }) {
    const stored = this.values.get(sha256);
    return stored
      ? {
          bytes: Buffer.from(stored.bytes),
          mediaType: stored.mediaType,
          committedAt: stored.committedAt,
        }
      : null;
  }
}

const outputFile = (filePath, bytes) => ({
  path: filePath,
  sha256: sha256Bytes(bytes),
  size: bytes.length,
});

const providerObservation = ({ environmentReceipt = true } = {}) => ({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  observedAt: FIXED_TIME,
  providerProjectId: PROVIDER_POLICY.expectedProjectId,
  providerTeamId: PROVIDER_POLICY.expectedTeamId,
  productionEnvironmentName: "production",
  presentEnvironmentNames: ["REQUIRED_ENV"],
  evidenceReceipts: environmentReceipt
    ? [
        {
          kind: "environment-presence",
          method: "GET",
          requestUrl:
            "https://api.vercel.com/v10/projects/project-test/env?decrypt=false&teamId=team-test",
          status: 200,
          responseDate: FIXED_TIME,
          etag: '"env"',
          contentType: "application/json",
          strictTransportSecurity: null,
          bodySha256: "5".repeat(64),
          responseSha256: "6".repeat(64),
        },
      ]
    : [],
});

const observationValidator = (observation, policy, now) => {
  assert.equal(policy, PROVIDER_POLICY);
  const timestamp = Date.parse(observation.observedAt);
  if (
    !Number.isFinite(timestamp) ||
    now - timestamp > policy.observationPolicy.maxResponseAgeSeconds * 1000
  ) {
    throw new Error("fixture provider observation is stale");
  }
  return observation;
};

const createFixture = async ({
  environmentReceipt = true,
  observationTime = FIXED_TIME,
} = {}) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "deployment-binding-producer-"),
  );
  const packageRoot = path.join(temporaryRoot, "package");
  await mkdir(packageRoot, { recursive: true });
  const variantId = computeVariantId(RELEASE_POLICY, STANDARD_DIMENSIONS);
  const capabilityBytes = canonicalJsonBytes({
    kind: "event-shopping-planner-release-capabilities",
    version: 1,
    buildId: SOURCE_SHA,
    sourceSha: SOURCE_SHA,
    sourceState: "clean",
    releaseChannel: "release-a",
    legacyLocalStorageCleanup: "forced-off",
  });
  const roleBytes = Buffer.from("globalThis.__role='standard';\n");
  const serviceWorkerBytes = Buffer.from(
    "self.addEventListener('fetch',()=>{});\n",
  );
  const htmlBytes = Buffer.from(
    "<!doctype html><html><head>" +
      `<meta name="event-shopping-planner-build-id" content="${SOURCE_SHA}">` +
      `<meta name="event-shopping-planner-source-sha" content="${SOURCE_SHA}">` +
      "</head><body>fixture</body></html>\n",
  );
  const identity = {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    variantId,
    releaseRole: "standard",
    requiredDbCompatibilityFingerprint: DB_COMPATIBILITY.fingerprint,
    pwaLifecycle: "legacy-auto-update-v1",
    appEntryUrl: "/assets/release-role.js",
    appEntrySha256: sha256Bytes(roleBytes),
    serviceWorkerUrl: "/sw.js",
    serviceWorkerSha256: sha256Bytes(serviceWorkerBytes),
  };
  const identityBytes = canonicalJsonBytes(identity);
  const graph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha: SOURCE_SHA,
    releaseRole: "standard",
    variantId,
    entryModule: OUTER_AGENT_ENTRY_MODULE,
    entryFile: "/assets/release-role.js",
    modules: [
      {
        id: OUTER_AGENT_ENTRY_MODULE,
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: "/assets/release-role.js",
        sha256: sha256Bytes(roleBytes),
        size: roleBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: [OUTER_AGENT_ENTRY_MODULE],
      },
    ],
  };
  const graphBytes = canonicalJsonBytes(graph);
  const publicBodies = new Map([
    ["/", htmlBytes],
    ["/assets/release-role.js", roleBytes],
    ["/release-capabilities.json", capabilityBytes],
    [`/release-capabilities.${SOURCE_SHA}.json`, capabilityBytes],
    ["/release-identity.json", identityBytes],
    [`/release-identity.${SOURCE_SHA}.${variantId}.json`, identityBytes],
    ["/release-role-graph.json", graphBytes],
    ["/sw.js", serviceWorkerBytes],
  ]);
  const declaredPaths = [...publicBodies.keys()]
    .filter((publicPath) => publicPath !== "/assets/release-role.js")
    .sort(compareUtf8);
  const publicResponseHashes = Object.fromEntries(
    declaredPaths.map((publicPath) => [
      publicPath,
      sha256Bytes(publicBodies.get(publicPath)),
    ]),
  );
  const outputFiles = [
    outputFile("static/index.html", htmlBytes),
    outputFile("static/assets/release-role.js", roleBytes),
    outputFile("static/release-capabilities.json", capabilityBytes),
    outputFile(
      `static/release-capabilities.${SOURCE_SHA}.json`,
      capabilityBytes,
    ),
    outputFile("static/release-identity.json", identityBytes),
    outputFile(
      `static/release-identity.${SOURCE_SHA}.${variantId}.json`,
      identityBytes,
    ),
    outputFile("static/release-role-graph.json", graphBytes),
    outputFile("static/sw.js", serviceWorkerBytes),
  ].sort((left, right) => compareUtf8(left.path, right.path));
  const observation = {
    ...providerObservation({ environmentReceipt }),
    observedAt: observationTime,
  };
  const manifest = {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    variantId,
    releaseRole: "standard",
    dimensions: STANDARD_DIMENSIONS,
    buildAuthority: BUILD_AUTHORITY,
    targetGate: "P0-RELEASE",
    buildPurpose: "production",
    promotable: true,
    buildInputClosureHash: "7".repeat(64),
    lockfileSha256: "8".repeat(64),
    toolchainPolicyHash: sha256Json(TOOLCHAIN_POLICY),
    publicBuildEnvHash: "9".repeat(64),
    providerConfigurationHash: providerConfigurationHash(observation),
    providerPolicyHash: sha256Json(PROVIDER_POLICY),
    releasePolicyHash: sha256Json(RELEASE_POLICY),
    requiredDbCompatibility: DB_COMPATIBILITY,
    publicIdentityKind: "release-identity-v1",
    bootstrap: null,
    publicResponseHashes,
    roleEntryGraph: graph,
    roleEntryGraphHash: sha256Json(graph),
    outputFiles,
  };
  const manifestObject = await writeContentAddressedObject({
    packageRoot,
    bytes: canonicalJsonBytes(manifest),
    kind: "artifact-manifest.json",
  });
  const archiveBytes = Buffer.from("fixture verified archive");
  const archiveObject = await writeContentAddressedObject({
    packageRoot,
    bytes: archiveBytes,
    kind: "artifact.zip",
  });
  const reference = {
    releaseRole: "standard",
    variantId,
    manifest: {
      uri: manifestObject.uri,
      sha256: manifestObject.sha256,
    },
    archive: {
      uri: archiveObject.uri,
      sha256: archiveObject.sha256,
    },
  };
  const index = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    buildAuthority: BUILD_AUTHORITY,
    targetGate: "P0-RELEASE",
    buildPurpose: "production",
    promotable: true,
    toolchainPolicyHash: manifest.toolchainPolicyHash,
    providerConfigurationHash: manifest.providerConfigurationHash,
    providerPolicyHash: manifest.providerPolicyHash,
    releasePolicyHash: manifest.releasePolicyHash,
    requiredDbCompatibility: DB_COMPATIBILITY,
    artifacts: [
      reference,
      {
        ...reference,
        releaseRole: "containment",
        variantId: "a".repeat(64),
      },
    ],
  };
  const indexBytes = canonicalJsonBytes(index);
  await writeFile(
    path.join(packageRoot, "release-package-index.json"),
    indexBytes,
  );
  const receipt = {
    schemaVersion: 1,
    receiptKind: "vercel-prebuilt-deployment-v1",
    idempotencyKey: "release:fixture:123456789",
    provider: "vercel",
    sourceSha: SOURCE_SHA,
    variantId,
    releaseRole: "standard",
    packageIndexSha256: sha256Bytes(indexBytes),
    manifest: reference.manifest,
    archive: {
      ...reference.archive,
      size: archiveBytes.length,
    },
    productionBinding: {
      verified: true,
      providerConfigurationHash: manifest.providerConfigurationHash,
      providerObservationSha256: sha256Json(observation),
      providerPolicySha256: sha256Json(PROVIDER_POLICY),
    },
    deployment: {
      id: "deployment-authoritative",
      url: DEPLOYMENT_URL,
      projectId: PROVIDER_POLICY.expectedProjectId,
      teamId: PROVIDER_POLICY.expectedTeamId,
      target: "production",
      readyState: "READY",
    },
    authoritativeRequest: {
      url:
        "https://api.vercel.com/v13/deployments/" +
        "immutable-binding-test.vercel.app?teamId=team-test",
      status: 200,
      date: FIXED_TIME,
      etag: '"deployment"',
      responseSha256: "b".repeat(64),
    },
    cli: {
      package: "vercel",
      version: TOOLCHAIN_POLICY.packages.vercel,
      operation: "deploy-prebuilt-prod-skip-domain",
    },
  };
  const events = [];
  const store = new FakeStore(events);
  const productionVerifier = async (options) => {
    events.push("verify");
    assert.equal(options.requireProductionBindings, true);
    assert.equal(store.values.size, 0);
    return {
      index,
      packageIndexSha256: sha256Bytes(indexBytes),
      productionEligible: true,
    };
  };
  const fetchImpl = async (requestUrl) => {
    events.push("fetch");
    const parsed = new URL(requestUrl);
    const body = publicBodies.get(parsed.pathname);
    if (!body) {
      return {
        status: 404,
        url: requestUrl,
        redirected: false,
        headers: { get: () => null },
        async arrayBuffer() {
          return Buffer.from("missing");
        },
      };
    }
    const headers = new Map(
      Object.entries({
        date: FIXED_TIME,
        etag: `"${sha256Bytes(body)}"`,
        "content-length": String(body.length),
        "content-type":
          parsed.pathname === "/"
            ? "text/html; charset=utf-8"
            : parsed.pathname.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "text/javascript; charset=utf-8",
        "cache-control":
          parsed.pathname === "/sw.js"
            ? "public, max-age=0, must-revalidate"
            : parsed.pathname === "/release-identity.json"
              ? "private, no-store"
              : parsed.pathname ===
                  `/release-identity.${SOURCE_SHA}.${variantId}.json`
                ? "public, max-age=31536000, immutable"
                : null,
        ...Object.fromEntries(
          Object.entries(
            renderCspHeaders({
              cspMode: manifest.dimensions.cspMode,
              cspPolicy: CSP_POLICY,
            }),
          ).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=()",
        "strict-transport-security": "max-age=63072000; includeSubDomains",
      }).filter(([, value]) => value !== null),
    );
    return {
      status: 200,
      url: requestUrl,
      redirected: false,
      headers: {
        get(name) {
          return headers.get(name.toLowerCase()) ?? null;
        },
      },
      async arrayBuffer() {
        return body;
      },
    };
  };
  return {
    temporaryRoot,
    packageRoot,
    index,
    indexBytes,
    manifest,
    reference,
    observation,
    receipt,
    publicBodies,
    events,
    store,
    productionVerifier,
    fetchImpl,
    options: {
      packageRoot,
      role: "standard",
      deploymentReceiptBytes: canonicalJsonBytes(receipt),
      providerObservationBytes: canonicalJsonBytes(observation),
      namespace: NAMESPACE,
      store,
      releasePolicy: RELEASE_POLICY,
      toolchainPolicy: TOOLCHAIN_POLICY,
      providerPolicy: PROVIDER_POLICY,
      dbContract: DB_CONTRACT,
      cspPolicy: CSP_POLICY,
      environment: {},
    },
    dependencies: {
      productionVerifier,
      providerObservationValidator: observationValidator,
      fetchImpl,
      now: () => FIXED_NOW,
    },
  };
};

const withFixture = async (options, callback) => {
  const fixture = await createFixture(options);
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
};

test("reruns production verification, probes immutable routes, and stores a closed binding chain", async () => {
  await withFixture({}, async (fixture) => {
    const result = await produceDeploymentBinding(
      fixture.options,
      fixture.dependencies,
    );

    assert.equal(fixture.events[0], "verify");
    assert.equal(
      fixture.events.slice(1, 9).every((event) => event === "fetch"),
      true,
    );
    assert.equal(
      fixture.events.slice(9).every((event) => event === "store"),
      true,
    );
    assert.equal(result.bindingSha256, sha256Bytes(result.bindingBytes));
    assert.equal(
      result.binding.providerConfigurationHash,
      providerConfigurationHash(fixture.observation),
    );
    assert.equal(
      result.providerEvidence.publicIdentity.identityKind,
      "release-identity-v1",
    );
    assert.deepEqual(
      result.providerEvidence.publicIdentity.identity,
      JSON.parse(
        fixture.publicBodies.get("/release-identity.json").toString("utf8"),
      ),
    );
    for (const reference of [
      result.binding.artifactArchive,
      result.binding.artifactArchiveAvailability,
      result.binding.packageIndex,
      result.binding.artifactManifest,
      result.binding.providerEvidence,
      result.binding.releasePolicy,
      result.binding.providerPolicy,
      result.routeProbeReference,
      result.environmentPresenceReference,
      result.bindingReference,
    ]) {
      assert.ok(fixture.store.values.has(reference.sha256));
      assert.equal(
        reference.uri,
        `release-state://${NAMESPACE}/evidence/${reference.sha256}`,
      );
    }
    assert.equal(
      fixture.store.values.get(result.binding.artifactArchive.sha256).mediaType,
      "application/vnd.event-shopping-planner.artifact-archive+zip;version=1",
    );
    const archiveAvailability = JSON.parse(
      fixture.store.values
        .get(result.binding.artifactArchiveAvailability.sha256)
        .bytes.toString("utf8"),
    );
    assert.equal(archiveAvailability.availability, "available");
    assert.equal(
      archiveAvailability.artifactArchive.sha256,
      result.binding.artifactArchive.sha256,
    );
    const routeEvidence = JSON.parse(
      fixture.store.values
        .get(result.routeProbeReference.sha256)
        .bytes.toString("utf8"),
    );
    assert.equal(routeEvidence.routes.length, 8);
    assert.equal(
      routeEvidence.routes.some(
        ({ path: routePath }) => routePath === "/assets/release-role.js",
      ),
      true,
    );
    const environmentEvidence = JSON.parse(
      fixture.store.values
        .get(result.environmentPresenceReference.sha256)
        .bytes.toString("utf8"),
    );
    assert.equal(environmentEvidence.receipt.kind, "environment-presence");
  });
});

test("production deployment binding rejects a policy QA package index", async () => {
  await withFixture({}, async (fixture) => {
    const qaIndex = structuredClone(fixture.index);
    qaIndex.buildPurpose = POLICY_ACTIVATION_QA_BUILD_PURPOSE;
    qaIndex.promotable = false;
    await writeFile(
      path.join(fixture.packageRoot, "release-package-index.json"),
      canonicalJsonBytes(qaIndex),
    );
    await assert.rejects(
      produceDeploymentBinding(fixture.options, fixture.dependencies),
      /purpose\/promotable binding is invalid/,
    );
    assert.deepEqual(fixture.events, ["verify"]);
    assert.equal(fixture.store.values.size, 0);
  });
});

test("fails closed for receipt tampering, stale evidence, and role mismatch", async () => {
  await withFixture({}, async (fixture) => {
    const tamperedReceipt = {
      ...fixture.receipt,
      variantId: "f".repeat(64),
    };
    await assert.rejects(
      produceDeploymentBinding(
        {
          ...fixture.options,
          deploymentReceiptBytes: canonicalJsonBytes(tamperedReceipt),
        },
        fixture.dependencies,
      ),
      /receipt binding differs/,
    );
    assert.equal(fixture.store.values.size, 0);
  });
  await withFixture({}, async (fixture) => {
    const staleReceipt = {
      ...fixture.receipt,
      authoritativeRequest: {
        ...fixture.receipt.authoritativeRequest,
        date: "2026-08-05T00:00:00.000Z",
      },
    };
    await assert.rejects(
      produceDeploymentBinding(
        {
          ...fixture.options,
          deploymentReceiptBytes: canonicalJsonBytes(staleReceipt),
        },
        fixture.dependencies,
      ),
      /stale, future, or invalid/,
    );
  });
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      produceDeploymentBinding(
        { ...fixture.options, role: "containment" },
        fixture.dependencies,
      ),
      /manifest|binding differs/i,
    );
  });
  await withFixture({}, async (fixture) => {
    await writeFile(
      contentAddressedObjectPath(
        fixture.packageRoot,
        fixture.reference.archive.sha256,
        "artifact.zip",
      ),
      Buffer.alloc(fixture.receipt.archive.size, 0x78),
    );
    await assert.rejects(
      produceDeploymentBinding(fixture.options, fixture.dependencies),
      /artifact archive bytes differ from their content address/,
    );
    assert.equal(fixture.store.values.size, 0);
  });
});

test("fails closed for partial routes, response aliases, secrets, and environment receipt gaps", async () => {
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      produceDeploymentBinding(fixture.options, {
        ...fixture.dependencies,
        fetchImpl: async (requestUrl, init) => {
          const response = await fixture.fetchImpl(requestUrl, init);
          if (new URL(requestUrl).pathname === "/sw.js") {
            return { ...response, status: 404 };
          }
          return response;
        },
      }),
      /partial or aliased/,
    );
  });
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      produceDeploymentBinding(fixture.options, {
        ...fixture.dependencies,
        fetchImpl: async (requestUrl, init) => {
          const response = await fixture.fetchImpl(requestUrl, init);
          if (new URL(requestUrl).pathname !== "/") return response;
          let reads = 0;
          return {
            ...response,
            body: {
              getReader() {
                return {
                  async read() {
                    reads += 1;
                    return reads <= 2
                      ? {
                          done: false,
                          value: new Uint8Array(3 * 1024 * 1024),
                        }
                      : { done: true, value: undefined };
                  },
                  async cancel() {},
                  releaseLock() {},
                };
              },
            },
          };
        },
      }),
      /response is oversized/,
    );
  });
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      produceDeploymentBinding(fixture.options, {
        ...fixture.dependencies,
        fetchImpl: async (requestUrl, init) => {
          const response = await fixture.fetchImpl(requestUrl, init);
          if (new URL(requestUrl).pathname === "/") {
            return { ...response, url: `${requestUrl}index.html` };
          }
          return response;
        },
      }),
      /partial or aliased/,
    );
  });
  await withFixture({}, async (fixture) => {
    const secret = "secret-route-value";
    await assert.rejects(
      produceDeploymentBinding(
        {
          ...fixture.options,
          environment: { API_TOKEN: secret },
        },
        {
          ...fixture.dependencies,
          fetchImpl: async (requestUrl, init) => {
            const response = await fixture.fetchImpl(requestUrl, init);
            if (new URL(requestUrl).pathname !== "/") return response;
            return {
              ...response,
              async arrayBuffer() {
                return Buffer.from(secret);
              },
            };
          },
        },
      ),
      /protected secret value/,
    );
  });
  await withFixture({ environmentReceipt: false }, async (fixture) => {
    await assert.rejects(
      produceDeploymentBinding(fixture.options, fixture.dependencies),
      /environment-presence evidence is incomplete/,
    );
  });
});

test("rejects stale provider observation before verifier, fetch, or store", async () => {
  await withFixture(
    { observationTime: "2026-08-05T00:00:00.000Z" },
    async (fixture) => {
      await assert.rejects(
        produceDeploymentBinding(fixture.options, fixture.dependencies),
        /provider observation is stale/,
      );
      assert.deepEqual(fixture.events, []);
      assert.equal(fixture.store.values.size, 0);
    },
  );
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      produceDeploymentBinding(
        {
          ...fixture.options,
          providerObservationBytes: Buffer.alloc(4 * 1024 * 1024 + 1),
        },
        fixture.dependencies,
      ),
      /Provider observation is empty or oversized/,
    );
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.store.values.size, 0);
  });
});
