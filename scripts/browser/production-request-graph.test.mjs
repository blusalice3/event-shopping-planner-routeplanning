import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  PRODUCTION_REQUEST_GRAPH_RAW_MEDIA_TYPE,
  assertProductionRequestGraphObservation,
  assertProductionRequestGraphProtectedWorkflow,
  assertProductionRequestGraphRaw,
  collectAndStoreProductionRequestGraph,
  collectAndStoreProductionRequestGraphOidcAuthority,
  observeProductionRequestGraph,
  putProductionRequestGraph,
  readStoredProductionRequestGraph,
  resolveProductionRequestGraphBinding,
  summarizeProductionRequestGraph,
} from "./production-request-graph.mjs";
import {
  parseProductionRequestGraphArguments,
  writeProductionRequestGraphOutput,
} from "./collect-production-request-graph.mjs";

const namespace = "request-graph-test";
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const otherSourceSha = "89abcdef0123456789abcdef0123456789abcdef";
const repository = "owner/repository";
const oidcAuthority = {
  approvalPolicy: { repository },
  runId: "12345",
  runAttempt: "1",
};
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

const binding = ({
  source = sourceSha,
  suffix = "current",
  deploymentUrl = "https://current.example.test/",
  role = "standard",
} = {}) => ({
  bindingId: `deployment-binding:${role}:${suffix}`,
  sourceSha: source,
  buildId: source,
  variantId: (suffix === "current" ? "c" : "d").repeat(64),
  releaseRole: role,
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

const currentState = ({
  active = binding(),
  pendingOperation = null,
} = {}) => ({
  head: { sequence: 3, eventHash },
  records: [],
  snapshot: {
    activeProduction: active,
    pendingOperation,
    activeReleasePolicy: activePolicy,
    activePolicyCompatibility: [],
    currentDbCompatibility: dbCompatibility,
    minimumSafetyFloors: {},
  },
});

const selection = (selectedBinding, overrides = {}) => ({
  bindingId: selectedBinding.bindingId,
  sourceSha: selectedBinding.sourceSha,
  releaseRole: selectedBinding.releaseRole,
  providerProjectId: selectedBinding.providerProjectId,
  providerDeploymentId: selectedBinding.providerDeploymentId,
  deploymentUrl: selectedBinding.deploymentUrl,
  selection: "active-production",
  policyEligibility: "active",
  ...overrides,
});

const rawGraph = (selectedBinding = binding(), overrides = {}) => ({
  schemaVersion: 1,
  kind: "production-request-graph-raw/v1",
  namespace,
  sourceSha: selectedBinding.sourceSha,
  observedAt: "2026-08-09T00:00:00.000Z",
  releaseStateHead: { sequence: 3, eventHash },
  binding: selection(selectedBinding),
  applicationOrigin: new URL(selectedBinding.deploymentUrl).origin,
  document: {
    requestedOrigin: new URL(selectedBinding.deploymentUrl).origin,
    requestedPath: "/",
    responseOrigin: new URL(selectedBinding.deploymentUrl).origin,
    responsePath: "/",
    responseStatus: 200,
  },
  requests: [
    {
      sequence: 1,
      origin: new URL(selectedBinding.deploymentUrl).origin,
      path: "/",
      method: "GET",
      resourceType: "document",
      navigation: true,
      redirectFrom: null,
      responseStatus: 200,
      responseContentType: "text/html; charset=utf-8",
    },
  ],
  runtimeCssWrites: [],
  ...overrides,
});

const memoryStore = ({ namespace: storeNamespace = namespace } = {}) => {
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

const startServer = async (handler) => {
  const server = http.createServer(handler);
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

const htmlHandler =
  ({
    inlineStyle = false,
    runtimeCss = false,
    runtimeRule = false,
    redirect = null,
  } = {}) =>
  (request, response) => {
    if (redirect !== null && request.url === "/") {
      response.writeHead(302, { Location: `${redirect}/` });
      response.end();
      return;
    }
    if (request.url === "/release-identity.json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          sourceSha,
          buildId: sourceSha,
          releaseRole: "standard",
          variantId: "c".repeat(64),
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head></head><body>request graph${
        runtimeCss
          ? "<script>const style=document.createElement('style');style.textContent='body{color:red}';document.head.append(style)</script>"
          : ""
      }${
        runtimeRule
          ? "<script>const sheet=new CSSStyleSheet();sheet.insertRule('body{color:blue}')</script>"
          : ""
      }${
        inlineStyle ? "<script>document.body.style.color='green'</script>" : ""
      }</body></html>`,
    );
  };

test("observes a canonical same-origin graph from a local HTTP fixture", async () => {
  const server = await startServer(htmlHandler());
  try {
    const selectedBinding = binding({ deploymentUrl: `${server.origin}/` });
    const raw = await observeProductionRequestGraph({
      binding: selectedBinding,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: selection(selectedBinding),
      now: () => Date.parse("2026-08-09T00:00:00.000Z"),
      allowInsecureLocalhost: true,
    });
    const summary = summarizeProductionRequestGraph(raw);
    assert.equal(summary.totalRequestCount >= 2, true);
    assert.equal(summary.sameOriginRequestCount, summary.totalRequestCount);
    assert.equal(summary.runtimeCssWriteCount, 0);
    assert.deepEqual(summary.unexpectedOrigins, []);
  } finally {
    await server.close();
  }
});

test("rejects a navigation that redirects to a different origin", async () => {
  const destination = await startServer(htmlHandler());
  const source = await startServer(
    htmlHandler({ redirect: destination.origin }),
  );
  try {
    const selectedBinding = binding({ deploymentUrl: `${source.origin}/` });
    await assert.rejects(
      observeProductionRequestGraph({
        binding: selectedBinding,
        namespace,
        releaseStateHead: { sequence: 3, eventHash },
        bindingSelection: selection(selectedBinding),
        allowInsecureLocalhost: true,
      }),
      /changed origin/,
    );
  } finally {
    await Promise.all([source.close(), destination.close()]);
  }
});

test("rejects runtime CSS writes observed in the browser", async () => {
  const server = await startServer(htmlHandler({ runtimeCss: true }));
  try {
    const selectedBinding = binding({ deploymentUrl: `${server.origin}/` });
    const raw = await observeProductionRequestGraph({
      binding: selectedBinding,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: selection(selectedBinding),
      allowInsecureLocalhost: true,
    });
    assert.equal(raw.runtimeCssWrites.length > 0, true);
    assert.throws(
      () => summarizeProductionRequestGraph(raw),
      /forbidden runtime edges/,
    );
  } finally {
    await server.close();
  }
});

test("allows element inline styles because P2A only blocks runtime stylesheets", async () => {
  const server = await startServer(htmlHandler({ inlineStyle: true }));
  try {
    const selectedBinding = binding({ deploymentUrl: `${server.origin}/` });
    const raw = await observeProductionRequestGraph({
      binding: selectedBinding,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: selection(selectedBinding),
      allowInsecureLocalhost: true,
    });
    assert.equal(raw.runtimeCssWrites.length, 0);
    assert.equal(summarizeProductionRequestGraph(raw).outcome, "succeeded");
  } finally {
    await server.close();
  }
});

test("rejects CSSOM rule injection observed in the browser", async () => {
  const server = await startServer(htmlHandler({ runtimeRule: true }));
  try {
    const selectedBinding = binding({ deploymentUrl: `${server.origin}/` });
    const raw = await observeProductionRequestGraph({
      binding: selectedBinding,
      namespace,
      releaseStateHead: { sequence: 3, eventHash },
      bindingSelection: selection(selectedBinding),
      allowInsecureLocalhost: true,
    });
    assert.equal(raw.runtimeCssWrites.length > 0, true);
    assert.throws(
      () => summarizeProductionRequestGraph(raw),
      /forbidden runtime edges/,
    );
  } finally {
    await server.close();
  }
});

test("resolves only the exact current source and ignores old inventory bindings", () => {
  const selected = resolveProductionRequestGraphBinding({
    current: currentState(),
    namespace,
    sourceSha,
  });
  assert.equal(
    selected.binding.bindingId,
    "deployment-binding:standard:current",
  );

  const old = binding({ source: sourceSha, suffix: "old" });
  const differentCurrent = currentState({
    active: binding({ source: otherSourceSha }),
  });
  differentCurrent.snapshot.rollbackInventory = [
    {
      binding: old,
      eligibility: "eligible",
    },
  ];
  assert.throws(
    () =>
      resolveProductionRequestGraphBinding({
        current: differentCurrent,
        namespace,
        sourceSha,
      }),
    /No exact current or prepared production binding/,
  );
});

test("requires assigned and validated events for a prepared production binding", () => {
  const prepared = binding({ suffix: "prepared" });
  const operation = {
    operationId: "prepare-p2a",
    targetBinding: prepared,
  };
  const current = currentState({ active: null, pendingOperation: operation });
  assert.throws(
    () =>
      resolveProductionRequestGraphBinding({ current, namespace, sourceSha }),
    /lacks assigned and validated authority/,
  );
  current.records = ["deployment-assigned", "assignment-validated"].map(
    (eventType) => ({
      event: {
        eventType,
        operationId: operation.operationId,
        payload: { targetBinding: prepared },
      },
    }),
  );
  const selected = resolveProductionRequestGraphBinding({
    current,
    namespace,
    sourceSha,
  });
  assert.equal(selected.projection.selection, "prepared-production");
});

test("stores, reads back, and re-summarizes the canonical raw graph", async () => {
  const store = memoryStore();
  const raw = rawGraph();
  const stored = await putProductionRequestGraph({ store, raw });
  assert.equal(
    stored.reference.sha256,
    summarizeProductionRequestGraph(raw).graphSha256,
  );
  const readback = await readStoredProductionRequestGraph({
    store,
    namespace,
    reference: stored.reference,
  });
  assert.deepEqual(readback.raw, raw);
  assert.equal(readback.result.graphSha256, stored.reference.sha256);
});

test("rejects tampered stored bytes, mismatched receipts, and extra raw keys", async () => {
  const raw = rawGraph();
  const bytes = canonicalJsonBytes(raw);
  const rawReference = {
    uri: `release-state://${namespace}/evidence/${sha256Bytes(bytes)}`,
    sha256: sha256Bytes(bytes),
  };
  const tamperedStore = memoryStore();
  tamperedStore.objects.set(rawReference.sha256, {
    bytes: Buffer.concat([bytes, Buffer.from(" ")]),
    mediaType: PRODUCTION_REQUEST_GRAPH_RAW_MEDIA_TYPE,
    committedAt: "2026-08-09T00:00:01.000Z",
  });
  await assert.rejects(
    readStoredProductionRequestGraph({
      store: tamperedStore,
      namespace,
      reference: rawReference,
    }),
    /differs from its reference/,
  );

  const mismatchedStore = memoryStore({ namespace: "other-request-graph" });
  await assert.rejects(
    putProductionRequestGraph({ store: mismatchedStore, raw }),
    /store namespace differs/,
  );
  assert.throws(
    () => assertProductionRequestGraphRaw({ ...raw, callerClaim: true }),
    /unknown or missing fields/,
  );
});

test("collector derives result from observation and never accepts caller result fields", async () => {
  const store = memoryStore();
  const current = currentState();
  const observation = await collectAndStoreProductionRequestGraph(
    {
      current,
      store,
      namespace,
      sourceSha,
      oidcReceipt,
      oidcAuthority,
      now: () => Date.parse("2026-08-09T00:00:00.000Z"),
      observe: async ({ binding: selectedBinding }) =>
        rawGraph(selectedBinding),
    },
    { readOidcAuthority: async () => ({}) },
  );
  assert.equal(observation.rawGraph.sha256, observation.result.graphSha256);
  assert.equal(observation.result.outcome, "succeeded");
  assert.deepEqual(observation.collectorIdentity, {
    repository,
    workflowPath: ".github/workflows/release.yml",
    sourceSha,
    runId: "12345",
    runAttempt: "1",
  });
  assert.throws(
    () =>
      assertProductionRequestGraphObservation({
        ...observation,
        collectorIdentity: {
          ...observation.collectorIdentity,
          runAttempt: "0",
        },
      }),
    /collector identity is invalid/,
  );
  assert.throws(
    () =>
      parseProductionRequestGraphArguments([
        "--namespace",
        namespace,
        "--source-sha",
        sourceSha,
        "--url",
        "https://caller.example.test",
      ]),
    /invalid/,
  );
});

test("OIDC authority is verified, immutably stored, and read back", async () => {
  const store = memoryStore();
  const approvalPolicy = {
    oidcAudience: "urn:event-shopping-planner:foundation-release-state",
  };
  const receipt = {
    kind: "test-verified-github-oidc/v1",
    runAttempt: "1",
    runId: "12345",
    sourceSha,
  };
  const receiptBytes = canonicalJsonBytes(receipt);
  const calls = [];
  const input = {
    store,
    namespace,
    sourceSha,
    runId: "12345",
    runAttempt: "1",
    approvalPolicy,
    environment: {
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://token.actions.githubusercontent.com/",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-request-token",
    },
    nowMilliseconds: Date.parse("2026-08-09T00:00:00.000Z"),
  };
  const dependencies = {
    requestToken: async (options) => {
      calls.push(["request", options.audience]);
      assert.equal(options.requestToken, "opaque-request-token");
      return "signed-token";
    },
    verifyToken: async (options) => {
      calls.push(["verify", options.token]);
      assert.equal(options.expectedSourceSha, sourceSha);
      assert.equal(options.expectedRunId, "12345");
      return { receipt, receiptBytes };
    },
    assertVerified: (verified) => {
      calls.push(["assert-verified", verified.receipt.runId]);
    },
    assertStoredReceipt: ({ receipt: assertedReceipt, expectedRunAttempt }) => {
      calls.push(["assert-stored", expectedRunAttempt]);
      assert.deepEqual(assertedReceipt, receipt);
    },
  };
  const stored = await collectAndStoreProductionRequestGraphOidcAuthority(
    input,
    dependencies,
  );
  assert.deepEqual(calls, [
    ["request", approvalPolicy.oidcAudience],
    ["verify", "signed-token"],
    ["assert-verified", "12345"],
    ["assert-stored", "1"],
    ["assert-stored", "1"],
  ]);
  assert.equal(stored.reference.sha256, sha256Bytes(receiptBytes));
  assert.deepEqual(stored.readback.receipt, receipt);
  assert.deepEqual(stored.readback.bytes, receiptBytes);

  await assert.rejects(
    collectAndStoreProductionRequestGraphOidcAuthority(
      {
        ...input,
        store: memoryStore({ namespace: "other-request-graph" }),
      },
      dependencies,
    ),
    /OIDC store namespace differs/,
  );

  const tamperedStore = memoryStore();
  const putEvidence = tamperedStore.putEvidence.bind(tamperedStore);
  tamperedStore.putEvidence = async (options) => {
    const putReceipt = await putEvidence(options);
    tamperedStore.objects.get(putReceipt.sha256).bytes = Buffer.concat([
      options.bytes,
      Buffer.from(" "),
    ]);
    return putReceipt;
  };
  await assert.rejects(
    collectAndStoreProductionRequestGraphOidcAuthority(
      { ...input, store: tamperedStore },
      dependencies,
    ),
    /Stored production request graph OIDC receipt differs/,
  );
});

test("protected authority requires exact workflow and OIDC environments", async () => {
  const approvalPolicy = {
    bindingStatus: "configured",
    blockerCodes: [],
    repository: "owner/repository",
    workflowRef:
      "owner/repository/.github/workflows/release.yml@refs/heads/main",
  };
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: approvalPolicy.repository,
    GITHUB_WORKFLOW_REF: approvalPolicy.workflowRef,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_PROTECTED: "true",
    RELEASE_STATE_NAMESPACE: namespace,
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://token.actions.githubusercontent.com/",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-token",
  };
  assert.deepEqual(
    await assertProductionRequestGraphProtectedWorkflow({
      environment,
      approvalPolicy,
      namespace,
      sourceSha,
    }),
    { runId: "12345", runAttempt: "1" },
  );
  await assert.rejects(
    () =>
      assertProductionRequestGraphProtectedWorkflow({
        environment: { ...environment, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
        approvalPolicy,
        namespace,
        sourceSha,
      }),
    /OIDC environment is absent/,
  );
});

test("writes output with create-only descriptor readback", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "request-graph-"));
  try {
    const store = memoryStore();
    const observation = await collectAndStoreProductionRequestGraph(
      {
        current: currentState(),
        store,
        namespace,
        sourceSha,
        oidcReceipt,
        oidcAuthority,
        observe: async ({ binding: selectedBinding }) =>
          rawGraph(selectedBinding),
      },
      { readOidcAuthority: async () => ({}) },
    );
    const outputPath = path.join(temporaryRoot, "observation.json");
    const written = await writeProductionRequestGraphOutput(
      outputPath,
      observation,
    );
    assert.deepEqual(await readFile(outputPath), written.bytes);
    await assert.rejects(
      writeProductionRequestGraphOutput(outputPath, observation),
      /already exists/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
