import assert from "node:assert/strict";
import test from "node:test";

import {
  POLICY_QA_EXECUTION_SUBJECT_KIND,
  assertPolicyActivationQaDeploymentOutsideProductionDomains,
  assertPolicyActivationQaExecutionSubject,
  derivePolicyActivationQaDrillDomain,
  executeAndStorePolicyQaHttpTransaction,
  runPolicyActivationQaDrillSequence,
  storePolicyActivationQaFailureJournal,
} from "./policyActivationQaExecution.mjs";

const providerPolicy = {
  bindingStatus: "configured",
  provider: "vercel",
  expectedProjectId: "prj_foundation",
  expectedTeamId: "team_foundation",
  ownedProductionDomains: ["planner.example.test"],
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
  },
};

const reference = (suffix) => ({
  uri: `release-state://foundation-prod/evidence/${suffix.repeat(64).slice(0, 64)}`,
  sha256: suffix.repeat(64).slice(0, 64),
});

const binding = (bindingId) => ({ bindingId });
const manifest = (releaseRole) => ({ releaseRole });

test("derives a deterministic operation-bound non-production alias", () => {
  const first = derivePolicyActivationQaDrillDomain({
    namespace: "foundation-prod",
    operationId: "policy-P3-00000001",
    providerPolicy,
  });
  const second = derivePolicyActivationQaDrillDomain({
    namespace: "foundation-prod",
    operationId: "policy-P3-00000001",
    providerPolicy,
  });
  const other = derivePolicyActivationQaDrillDomain({
    namespace: "foundation-prod",
    operationId: "policy-P4-00000001",
    providerPolicy,
  });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^policy-qa-[0-9a-f]{24}\.vercel\.app$/);
  assert.equal(providerPolicy.ownedProductionDomains.includes(first), false);
});

test("rejects preview origins on an owned production domain or subdomain", () => {
  for (const deploymentUrl of [
    "https://planner.example.test",
    "https://preview.planner.example.test",
  ]) {
    assert.throws(
      () =>
        assertPolicyActivationQaDeploymentOutsideProductionDomains({
          deploymentUrl,
          providerPolicy,
        }),
      /overlaps production authority/,
    );
  }
  assert.equal(
    assertPolicyActivationQaDeploymentOutsideProductionDomains({
      deploymentUrl: "https://preview-unowned.vercel.app",
      providerPolicy,
    }),
    "https://preview-unowned.vercel.app",
  );
});

test("requires the exact authoritative Policy QA subject evidence set", () => {
  const references = Array.from({ length: 8 }, (_, index) =>
    reference(String(index + 1)),
  );
  const subject = {
    schemaVersion: 1,
    subjectKind: POLICY_QA_EXECUTION_SUBJECT_KIND,
    namespace: "foundation-prod",
    operationId: "policy-P3-00000001",
    executorSourceSha: "a".repeat(40),
    targetSourceSha: "b".repeat(40),
    expectedState: { sequence: 1, eventHash: "f".repeat(64) },
    activationGate: "P3-XLSX",
    previousReleasePolicy: references[0],
    proposedReleasePolicy: references[1],
    activeReleasePolicy: references[2],
    approvalPolicy: references[3],
    providerPolicy: references[4],
    cspPolicy: references[5],
    toolchainPolicy: references[6],
    qaPackage: references[7],
    drillDomain: derivePolicyActivationQaDrillDomain({
      namespace: "foundation-prod",
      operationId: "policy-P3-00000001",
      providerPolicy,
    }),
    evidenceRefs: [...references].sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.sha256, "utf8"),
        Buffer.from(right.sha256, "utf8"),
      ),
    ),
  };
  const snapshot = {
    sequence: 1,
    eventHash: "f".repeat(64),
    pendingOperation: null,
    pendingAcceptance: null,
    acceptedStandard: {},
    activeReleasePolicy: references[0],
  };
  assert.doesNotThrow(() =>
    assertPolicyActivationQaExecutionSubject({
      subject,
      snapshot,
      providerPolicy,
    }),
  );
  assert.throws(
    () =>
      assertPolicyActivationQaExecutionSubject({
        subject: {
          ...subject,
          evidenceRefs: [...subject.evidenceRefs, reference("9")].sort(
            (left, right) =>
              Buffer.compare(
                Buffer.from(left.sha256, "utf8"),
                Buffer.from(right.sha256, "utf8"),
              ),
          ),
        },
        snapshot,
        providerPolicy,
      }),
    /missing or extra/,
  );
});

test("runs setup, rollback, containment, and final restoration in exact order", async () => {
  const standard = binding("qa-standard");
  const accepted = binding("accepted-standard");
  const companion = binding("qa-companion");
  const calls = [];
  const result = await runPolicyActivationQaDrillSequence({
    stepOptions: { operationId: "policy-P3-00000001" },
    standardBinding: standard,
    standardManifest: manifest("standard"),
    acceptedBinding: accepted,
    acceptedManifest: manifest("standard"),
    companionBinding: companion,
    companionManifest: manifest("containment"),
    assignAndObserveAlias: async (options) => {
      calls.push({
        action: options.action,
        source: options.sourceBinding?.bindingId ?? null,
        target: options.targetBinding.bindingId,
      });
      return {
        action: options.action,
        targetBinding: options.targetBinding,
        drill: reference(String(calls.length)),
      };
    },
  });
  assert.deepEqual(calls, [
    { action: "initial-standard", source: null, target: "qa-standard" },
    {
      action: "rollback",
      source: "qa-standard",
      target: "accepted-standard",
    },
    {
      action: "containment",
      source: "accepted-standard",
      target: "qa-companion",
    },
    {
      action: "final-standard",
      source: "qa-companion",
      target: "qa-standard",
    },
  ]);
  assert.equal(result.primaryError, null);
  assert.equal(result.cleanupError, null);
  assert.equal(result.finalStandard.targetBinding, standard);
});

test("restores the QA standard after a partial drill failure", async () => {
  const standard = binding("qa-standard");
  const accepted = binding("accepted-standard");
  const companion = binding("qa-companion");
  const calls = [];
  const result = await runPolicyActivationQaDrillSequence({
    stepOptions: {},
    standardBinding: standard,
    standardManifest: manifest("standard"),
    acceptedBinding: accepted,
    acceptedManifest: manifest("standard"),
    companionBinding: companion,
    companionManifest: manifest("containment"),
    assignAndObserveAlias: async (options) => {
      calls.push(options.action);
      if (options.action === "containment") {
        throw new Error("containment probe failed");
      }
      return {
        action: options.action,
        targetBinding: options.targetBinding,
        drill: reference(String(calls.length)),
      };
    },
  });
  assert.deepEqual(calls, [
    "initial-standard",
    "rollback",
    "containment",
    "final-standard",
  ]);
  assert.match(result.primaryError.message, /containment probe failed/);
  assert.equal(result.cleanupError, null);
  assert.equal(result.finalStandard.targetBinding, standard);
});

test("reports an unverified cleanup when final restoration also fails", async () => {
  const result = await runPolicyActivationQaDrillSequence({
    stepOptions: {},
    standardBinding: binding("qa-standard"),
    standardManifest: manifest("standard"),
    acceptedBinding: binding("accepted-standard"),
    acceptedManifest: manifest("standard"),
    companionBinding: binding("qa-companion"),
    companionManifest: manifest("containment"),
    assignAndObserveAlias: async ({ action, targetBinding }) => {
      if (action === "containment") throw new Error("primary failure");
      if (action === "final-standard") throw new Error("cleanup failure");
      return { action, targetBinding, drill: reference("a") };
    },
  });
  assert.match(result.primaryError.message, /primary failure/);
  assert.match(result.cleanupError.message, /cleanup failure/);
  assert.equal(result.finalStandard, null);
});

test("journals a successful preview when its deployment pair fails before alias mutation", async () => {
  const objects = new Map();
  const store = {
    namespace: "foundation-prod",
    async putEvidence({ bytes, mediaType }) {
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uri = `release-state://foundation-prod/evidence/${sha256}`;
      objects.set(sha256, { bytes: Buffer.from(bytes), mediaType });
      return {
        uri,
        sha256,
        byteLength: bytes.length,
        mediaType,
        replayed: false,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
  };
  const successfulPreview = reference("d");
  const journal = await storePolicyActivationQaFailureJournal({
    store,
    namespace: store.namespace,
    subject: {
      operationId: "policy-P3-00000001",
      drillDomain: "policy-qa-0123456789abcdef01234567.vercel.app",
    },
    workflowRunId: "101",
    providerPolicy,
    environment: { VERCEL_TOKEN: "secret-token-value" },
    standardDeployment: { deploymentObservation: successfulPreview },
    companionDeployment: null,
    aliasMutationAttempted: false,
    cleanupVerified: true,
    primaryError: new Error("companion preview failed"),
    clock: () => Date.parse("2026-08-09T01:02:03.000Z"),
  });
  assert.deepEqual(journal.failure.standardDeployment, successfulPreview);
  assert.equal(journal.failure.companionDeployment, null);
  assert.equal(journal.failure.beforeAlias, null);
  assert.equal(journal.failure.aliasMutationAttempted, false);
  assert.equal(journal.failure.cleanupVerified, true);
});

test("rejects a falsely verified post-alias cleanup before immutable storage", async () => {
  let writes = 0;
  const store = {
    namespace: "foundation-prod",
    async putEvidence() {
      writes += 1;
      throw new Error("must not store an inconsistent failure journal");
    },
  };
  const standardBinding = {
    bindingId: "qa-standard",
    providerProjectId: providerPolicy.expectedProjectId,
    providerDeploymentId: "deployment-standard",
  };
  const common = {
    store,
    namespace: store.namespace,
    subject: {
      operationId: "policy-P3-00000001",
      drillDomain: "policy-qa-0123456789abcdef01234567.vercel.app",
    },
    workflowRunId: "101",
    providerPolicy,
    environment: {},
    standardDeployment: { binding: standardBinding },
    companionDeployment: { binding: { bindingId: "qa-companion" } },
    beforeAlias: { reference: reference("b") },
    completedSteps: [],
    aliasMutationAttempted: true,
    cleanupVerified: true,
    primaryError: new Error("drill failed"),
  };
  await assert.rejects(
    storePolicyActivationQaFailureJournal({ ...common, cleanup: null }),
    /verified cleanup is not the QA standard/,
  );
  await assert.rejects(
    storePolicyActivationQaFailureJournal({
      ...common,
      cleanup: {
        action: "rollback",
        targetBinding: standardBinding,
        providerObservation: reference("c"),
        drill: reference("d"),
      },
    }),
    /verified cleanup is not the QA standard/,
  );
  assert.equal(writes, 0);
});

test("requires an explicit recovery-required state when cleanup is unverified", async () => {
  const store = {
    namespace: "foundation-prod",
    async putEvidence() {
      throw new Error("must not store an inconsistent failure journal");
    },
  };
  await assert.rejects(
    storePolicyActivationQaFailureJournal({
      store,
      namespace: store.namespace,
      subject: {
        operationId: "policy-P3-00000001",
        drillDomain: "policy-qa-0123456789abcdef01234567.vercel.app",
      },
      workflowRunId: "101",
      providerPolicy,
      environment: {},
      standardDeployment: { binding: { bindingId: "qa-standard" } },
      companionDeployment: { binding: { bindingId: "qa-companion" } },
      beforeAlias: { reference: reference("b") },
      aliasMutationAttempted: true,
      cleanupVerified: false,
      primaryError: new Error("drill failed"),
      cleanupError: null,
    }),
    /recovery-required cleanup state is inconsistent/,
  );
});

test("stores canonical HTTP request/response evidence with exact body hashes", async () => {
  const objects = new Map();
  const store = {
    namespace: "foundation-prod",
    async putEvidence({ bytes, mediaType }) {
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uri = `release-state://foundation-prod/evidence/${sha256}`;
      objects.set(sha256, { bytes: Buffer.from(bytes), mediaType });
      return {
        uri,
        sha256,
        byteLength: bytes.length,
        mediaType,
        replayed: false,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
  };
  const observedAt = "2026-08-09T01:02:03.000Z";
  const responseBody = Buffer.from('{"alias":"qa.example.test"}', "utf8");
  const headers = new Headers({
    "content-type": "application/json",
    date: observedAt,
    etag: '"qa"',
  });
  const result = await executeAndStorePolicyQaHttpTransaction({
    store,
    namespace: store.namespace,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(String(url), "https://api.vercel.com/v2/example");
      return {
        status: 200,
        url: String(url),
        redirected: false,
        headers,
        async arrayBuffer() {
          return responseBody;
        },
      };
    },
    clock: () => Date.parse(observedAt),
    method: "POST",
    url: "https://api.vercel.com/v2/example",
    headers: { "content-type": "application/json" },
    requestBody: { alias: "qa.example.test" },
    label: "fixture provider command",
  });
  assert.equal(result.transaction.request.method, "POST");
  assert.equal(result.transaction.response.status, 200);
  assert.equal(result.transaction.observedAt, observedAt);
  assert.equal(
    result.transaction.response.bodySha256,
    result.transaction.response.body.sha256,
  );
  const storedResponse = await store.readEvidence({
    sha256: result.transaction.response.body.sha256,
  });
  assert.deepEqual(storedResponse.bytes, responseBody);
});

test("rejects provider responses that echo a secret before immutable storage", async () => {
  let writes = 0;
  const secret = "vercel-secret-token-value";
  const store = {
    namespace: "foundation-prod",
    async putEvidence() {
      writes += 1;
      throw new Error("must not store secret evidence");
    },
  };
  await assert.rejects(
    executeAndStorePolicyQaHttpTransaction({
      store,
      namespace: store.namespace,
      fetchImpl: async (url) => ({
        status: 500,
        url: String(url),
        redirected: false,
        headers: new Headers({
          "content-type": "application/json",
          date: "2026-08-09T01:02:03.000Z",
        }),
        async arrayBuffer() {
          return Buffer.from(`{"debug":"${secret}"}`, "utf8");
        },
      }),
      clock: () => Date.parse("2026-08-09T01:02:03.000Z"),
      method: "GET",
      url: "https://api.vercel.com/v2/example",
      secrets: [secret],
      label: "fixture secret response",
    }),
    /contains a provider secret/,
  );
  assert.equal(writes, 0);
});
