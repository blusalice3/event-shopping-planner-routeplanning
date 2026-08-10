import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Bytes } from "../lib/canonical-json.mjs";
import { CSP_FULL_FLOW_IDS } from "./csp-full-flow-adapter.mjs";
import {
  assertDeployedCspFlowObservation,
  assertDeployedCspFlowRaw,
  collectAndStoreDeployedCspFlow,
  observeDeployedCspFlow,
  putDeployedCspFlow,
  readStoredDeployedCspFlow,
  summarizeDeployedCspFlow,
} from "./deployed-csp-flow.mjs";
import {
  parseDeployedCspFlowArguments,
  writeDeployedCspFlowOutput,
} from "./collect-deployed-csp-flow.mjs";

const namespace = "deployed-csp-test";
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const otherSourceSha = "89abcdef0123456789abcdef0123456789abcdef";
const repository = "owner/repository";
const eventHash = "e".repeat(64);
const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
  sha256: character.repeat(64),
});
const activePolicy = reference("a");
const oidcReceipt = reference("8");
const dbCompatibility = {
  contractUri: "urn:event-shopping-planner:db-compatibility:v1",
  fingerprint: "b".repeat(64),
};
const cspPolicy = {
  schemaVersion: 1,
  policyId: "web-foundation-csp-v1",
  reportEndpoint: "/api/csp-report",
  directives: {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "worker-src": ["'self'"],
    "style-src-attr": ["'none'"],
    "img-src": ["'self'", "data:", "blob:"],
    "connect-src": ["'self'"],
    "report-uri": ["/api/csp-report"],
  },
  securityHeaders: {},
  temporaryExceptions: [],
  forbiddenTokens: {},
};
const expectedHeader = Object.entries(cspPolicy.directives)
  .map(([name, values]) => `${name} ${values.join(" ")}`)
  .join("; ");

const binding = ({
  source = sourceSha,
  deploymentUrl = "https://production.example.test/",
  suffix = "current",
} = {}) => ({
  bindingId: `deployment-binding:standard:${suffix}`,
  sourceSha: source,
  buildId: source,
  variantId: "c".repeat(64),
  releaseRole: "standard",
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${suffix}`,
  deploymentUrl,
  artifactArchive: reference("1"),
  artifactArchiveAvailability: reference("2"),
  packageIndex: reference("3"),
  artifactManifest: reference("4"),
  providerEvidence: reference("5"),
  releasePolicy: activePolicy,
  providerPolicy: reference("6"),
  providerConfigurationHash: "7".repeat(64),
  requiredDbCompatibility: dbCompatibility,
});

const currentState = (active = binding()) => ({
  head: { sequence: 3, eventHash },
  records: [],
  snapshot: {
    activeProduction: active,
    pendingOperation: null,
    activeReleasePolicy: activePolicy,
    activePolicyCompatibility: [],
    currentDbCompatibility: dbCompatibility,
    minimumSafetyFloors: {},
  },
});

const projection = (selectedBinding) => ({
  bindingId: selectedBinding.bindingId,
  sourceSha: selectedBinding.sourceSha,
  releaseRole: selectedBinding.releaseRole,
  providerProjectId: selectedBinding.providerProjectId,
  providerDeploymentId: selectedBinding.providerDeploymentId,
  deploymentUrl: selectedBinding.deploymentUrl,
  selection: "active-production",
  policyEligibility: "active",
});

const memoryStore = ({ storeNamespace = namespace } = {}) => {
  const objects = new Map();
  return {
    namespace: storeNamespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = "2026-08-09T00:00:01.000Z";
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        mediaType,
        committedAt,
      });
      return {
        uri: `release-state://${storeNamespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
        replayed: false,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
  };
};

const startFixture = async ({ header = expectedHeader } = {}) => {
  const identity = {
    sourceSha,
    buildId: sourceSha,
    releaseRole: "standard",
    variantId: "c".repeat(64),
    roleEntryUrl: "/assets/role-entry.js",
    outerAgentSha256: "d".repeat(64),
  };
  const identityText = JSON.stringify(identity);
  const cspHeaders = { "content-security-policy": header };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/csp-report" && request.method === "POST") {
      request.resume();
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (
      url.pathname === "/release-identity.json" ||
      url.pathname === `/release-identity.${sourceSha}.${"c".repeat(64)}.json`
    ) {
      response.writeHead(200, {
        ...cspHeaders,
        "content-type": "application/json; charset=utf-8",
      });
      response.end(identityText);
      return;
    }
    if (url.pathname === "/assets/role-entry.js") {
      response.writeHead(200, {
        ...cspHeaders,
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end('const worker="xlsx.worker-fixture.js";');
      return;
    }
    if (url.pathname === "/assets/xlsx.worker-fixture.js") {
      response.writeHead(200, {
        ...cspHeaders,
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(
        'self.onmessage=(event)=>self.postMessage({type:"XLSX_ERROR",protocolVersion:1,requestId:event.data.requestId,kind:"unknown",errorCode:"INVALID_REQUEST"});',
      );
      return;
    }
    if (url.pathname === "/sw.js") {
      response.writeHead(200, {
        ...cspHeaders,
        "cache-control": "no-cache",
        "content-type": "text/javascript; charset=utf-8",
        "service-worker-allowed": "/",
      });
      response.end(
        'self.addEventListener("install",event=>event.waitUntil(caches.open("csp-v1").then(cache=>cache.addAll(["/","/app.js"]))));self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));self.addEventListener("fetch",event=>{const path=new URL(event.request.url).pathname;if(event.request.mode==="navigate"||path==="/app.js")event.respondWith(fetch(event.request).catch(()=>caches.match(event.request).then(response=>response??caches.match("/"))));});',
      );
      return;
    }
    if (url.pathname === "/app.js") {
      response.writeHead(200, {
        ...cspHeaders,
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(
        `(async()=>{const root=document.querySelector("#root");root.textContent="ready";navigator.serviceWorker.register("/sw.js");const identity=await fetch("/release-identity.json",{cache:"no-store"}).then(r=>r.json());const versioned=await fetch("/release-identity.${sourceSha}.${"c".repeat(64)}.json",{cache:"no-store"}).then(r=>r.json());if(versioned.outerAgentSha256!==identity.outerAgentSha256){root.dataset.pwaRecovery="true";root.textContent="";const diagnostic=document.createElement("span");diagnostic.dataset.diagnosticCode="first-install-identity-unavailable";diagnostic.textContent="recovery";root.append(diagnostic);}})();`,
      );
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, {
        ...cspHeaders,
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        '<!doctype html><html><body><div id="loading-screen" hidden></div><div id="root"></div><script src="/app.js"></script></body></html>',
      );
      return;
    }
    response.writeHead(404, cspHeaders);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const clone = (value) => JSON.parse(JSON.stringify(value));

test("observes all seven deployed CSP flows from a local browser fixture", async () => {
  const fixture = await startFixture();
  try {
    const selected = binding({ deploymentUrl: `${fixture.origin}/` });
    const raw = await observeDeployedCspFlow({
      binding: selected,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: projection(selected),
      cspPolicy,
      now: () => Date.parse("2026-08-09T00:00:00.000Z"),
    });
    assert.deepEqual(
      raw.flows.map(({ id }) => id),
      CSP_FULL_FLOW_IDS,
    );
    assert.equal(summarizeDeployedCspFlow(raw, cspPolicy).outcome, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("rejects an exact CSP response header drift", async () => {
  const fixture = await startFixture({
    header: `${expectedHeader}; object-src 'none'`,
  });
  try {
    const selected = binding({ deploymentUrl: `${fixture.origin}/` });
    await assert.rejects(
      observeDeployedCspFlow({
        binding: selected,
        namespace,
        releaseStateHead: { sequence: 3, eventHash },
        bindingSelection: projection(selected),
        cspPolicy,
      }),
      /header differs/,
    );
  } finally {
    await fixture.close();
  }
});

test("rejects missing flows, browser violations, and extra raw fields", async () => {
  const fixture = await startFixture();
  try {
    const selected = binding({ deploymentUrl: `${fixture.origin}/` });
    const raw = await observeDeployedCspFlow({
      binding: selected,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: projection(selected),
      cspPolicy,
    });
    const missing = clone(raw);
    missing.flows.pop();
    assert.throws(
      () => assertDeployedCspFlowRaw(missing),
      /identity is invalid/,
    );
    const violated = clone(raw);
    violated.flows[0].violations.push({
      blockedUri: "https://blocked.example/asset.js",
      disposition: "enforce",
      documentUri: `${fixture.origin}/`,
      effectiveDirective: "script-src-elem",
      sourceFile: `${fixture.origin}/app.js`,
    });
    assert.throws(
      () => summarizeDeployedCspFlow(violated, cspPolicy),
      /differs from configured policy/,
    );
    assert.throws(
      () => assertDeployedCspFlowRaw({ ...raw, callerOutcome: "succeeded" }),
      /unknown or missing fields/,
    );
  } finally {
    await fixture.close();
  }
});

test("stores, re-reads, and re-derives the immutable CSP trace", async () => {
  const fixture = await startFixture();
  try {
    const selected = binding({ deploymentUrl: `${fixture.origin}/` });
    const raw = await observeDeployedCspFlow({
      binding: selected,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: projection(selected),
      cspPolicy,
    });
    const store = memoryStore();
    const stored = await putDeployedCspFlow({ store, raw, cspPolicy });
    const readback = await readStoredDeployedCspFlow({
      store,
      namespace,
      reference: stored.reference,
      cspPolicy,
    });
    assert.deepEqual(readback.raw, raw);
    assert.equal(readback.result.traceSha256, stored.reference.sha256);

    store.objects.get(stored.reference.sha256).bytes = Buffer.concat([
      readback.bytes,
      Buffer.from(" "),
    ]);
    await assert.rejects(
      readStoredDeployedCspFlow({
        store,
        namespace,
        reference: stored.reference,
        cspPolicy,
      }),
      /raw trace differs/,
    );
    store.objects.get(stored.reference.sha256).bytes = readback.bytes;
    store.objects.get(stored.reference.sha256).mediaType = "application/json";
    await assert.rejects(
      readStoredDeployedCspFlow({
        store,
        namespace,
        reference: stored.reference,
        cspPolicy,
      }),
      /raw trace differs/,
    );
    await assert.rejects(
      putDeployedCspFlow({
        store: memoryStore({ storeNamespace: "other-csp-store" }),
        raw,
        cspPolicy,
      }),
      /store namespace differs/,
    );
  } finally {
    await fixture.close();
  }
});

test("collector rejects old sources and requires trusted OIDC authority", async () => {
  const store = memoryStore();
  const args = {
    current: currentState(binding({ source: otherSourceSha })),
    store,
    namespace,
    sourceSha,
    oidcReceipt,
    oidcAuthority: {
      approvalPolicy: { repository },
      runId: "12345",
      runAttempt: "1",
    },
    cspPolicy,
    observe: async () => {
      throw new Error("old binding must not be observed");
    },
  };
  await assert.rejects(
    collectAndStoreDeployedCspFlow(args, {
      readOidcAuthority: async () => ({}),
    }),
    /No exact current or prepared production binding/,
  );
  await assert.rejects(
    collectAndStoreDeployedCspFlow(
      { ...args, current: currentState() },
      {
        readOidcAuthority: async () => {
          throw new Error("trusted OIDC receipt missing");
        },
      },
    ),
    /trusted OIDC receipt missing/,
  );
  for (const [flag, value] of [
    ["--url", "https://caller.example.test"],
    ["--policy-sha", "f".repeat(64)],
    ["--outcome", "succeeded"],
    ["--violation-count", "0"],
  ]) {
    assert.throws(
      () =>
        parseDeployedCspFlowArguments([
          "--namespace",
          namespace,
          "--source-sha",
          sourceSha,
          flag,
          value,
        ]),
      /invalid/,
    );
  }
});

test("writes a create-only exact observation file", async () => {
  const fixture = await startFixture();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "deployed-csp-"));
  try {
    const selected = binding({ deploymentUrl: `${fixture.origin}/` });
    const raw = await observeDeployedCspFlow({
      binding: selected,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: projection(selected),
      cspPolicy,
    });
    const authorityBinding = binding();
    const authorityRaw = {
      ...raw,
      binding: projection(authorityBinding),
    };
    const observation = await collectAndStoreDeployedCspFlow(
      {
        current: currentState(authorityBinding),
        store: memoryStore(),
        namespace,
        sourceSha,
        oidcReceipt,
        oidcAuthority: {
          approvalPolicy: { repository },
          runId: "12345",
          runAttempt: "1",
        },
        cspPolicy,
        observe: async () => authorityRaw,
      },
      { readOidcAuthority: async () => ({}) },
    );
    assert.equal(observation.collectorIdentity.runId, "12345");
    assert.equal(observation.collectorIdentity.runAttempt, "1");
    assert.throws(
      () =>
        assertDeployedCspFlowObservation({
          ...observation,
          collectorIdentity: {
            ...observation.collectorIdentity,
            workflowPath: ".github/workflows/other.yml",
          },
        }),
      /collector identity is invalid/,
    );
    const outputPath = path.join(temporaryRoot, "observation.json");
    const written = await writeDeployedCspFlowOutput(outputPath, observation);
    assert.deepEqual(await readFile(outputPath), written.bytes);
    await assert.rejects(
      writeDeployedCspFlowOutput(outputPath, observation),
      /already exists/,
    );
  } finally {
    await Promise.all([
      fixture.close(),
      rm(temporaryRoot, { recursive: true, force: true }),
    ]);
  }
});
