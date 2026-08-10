import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  PRE_PROMOTION_EVIDENCE_CATEGORIES,
  PRE_PROMOTION_EVIDENCE_MEDIA_TYPES,
  prePromotionVerifierCommands,
  resolveNamedPrePromotionEvidence,
  resolvePrePromotionEvidenceReferences,
  storePrePromotionCategoryReceipt,
  storePrePromotionVerifierRunReceipt,
} from "./prePromotionEvidence.mjs";
import { createStoredPrePromotionFixture } from "./prePromotionEvidenceTestFixture.mjs";

const namespace = "prepromotion-test";
const sourceSha = "a".repeat(40);
const dbCompatibility = {
  contractUri: "urn:test:db:v1",
  fingerprint: "d".repeat(64),
};
const providerPolicy = {
  bindingStatus: "configured",
  expectedTeamId: "team-test",
  expectedProjectId: "project-test",
  ownedProductionDomains: ["a.example.test", "b.example.test"],
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
  },
};

class FakeStore {
  constructor() {
    this.namespace = namespace;
    this.evidence = new Map();
  }

  async putEvidence({ bytes, mediaType }) {
    const storedBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(storedBytes);
    const replayed = this.evidence.has(sha256);
    this.evidence.set(sha256, {
      bytes: storedBytes,
      mediaType,
      committedAt: "2026-08-06T00:00:00.000Z",
    });
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
      mediaType,
      byteLength: storedBytes.length,
      committedAt: "2026-08-06T00:00:00.000Z",
      replayed,
    };
  }

  async readEvidence({ sha256 }) {
    const value = this.evidence.get(sha256);
    return value
      ? {
          bytes: Buffer.from(value.bytes),
          mediaType: value.mediaType,
          committedAt: value.committedAt,
        }
      : null;
  }
}

const loadReleasePolicy = async () => {
  const policy = JSON.parse(
    await readFile(
      new URL("../../config/release-variants.json", import.meta.url),
      "utf8",
    ),
  );
  return {
    ...policy,
    activationStatus: "active",
    activationBlockers: [],
  };
};

const createFixture = async () => {
  const store = new FakeStore();
  const releasePolicy = await loadReleasePolicy();
  const fixture = await createStoredPrePromotionFixture({
    store,
    namespace,
    sourceSha,
    dbCompatibility,
    providerPolicy,
    releasePolicy,
  });
  return { ...fixture, store, releasePolicy };
};

test("resolves exactly five source-bound pre-promotion receipts recursively", async () => {
  const fixture = await createFixture();
  const result = await resolveNamedPrePromotionEvidence({
    store: fixture.store,
    namespace,
    namedEvidence: fixture.namedEvidence,
    bindings: {
      standard: fixture.standard,
      containment: fixture.containment,
    },
    snapshot: {
      activeReleasePolicy: fixture.releasePolicyReference,
      currentDbCompatibility: dbCompatibility,
    },
  });
  assert.deepEqual(
    Object.keys(result.receipts),
    PRE_PROMOTION_EVIDENCE_CATEGORIES,
  );
  assert.equal(result.references.length, 5);
  assert.equal(result.identity.sourceSha, sourceSha);
  assert.deepEqual(result.identity.packageIndex, fixture.packageIndexReference);
  assert.deepEqual(
    await resolvePrePromotionEvidenceReferences({
      store: fixture.store,
      namespace,
      references: result.references,
      bindings: {
        standard: fixture.standard,
        containment: fixture.containment,
      },
    }).then(({ namedEvidence }) => namedEvidence),
    fixture.namedEvidence,
  );
});

test("rejects missing, extra, wrong-media, arbitrary, and tampered receipts", async () => {
  const fixture = await createFixture();
  const missing = { ...fixture.namedEvidence };
  delete missing.qa;
  await assert.rejects(
    resolveNamedPrePromotionEvidence({
      store: fixture.store,
      namespace,
      namedEvidence: missing,
    }),
    /unknown or missing fields/u,
  );
  await assert.rejects(
    resolveNamedPrePromotionEvidence({
      store: fixture.store,
      namespace,
      namedEvidence: {
        ...fixture.namedEvidence,
        arbitrary: fixture.namedEvidence.qa,
      },
    }),
    /unknown or missing fields/u,
  );

  const qaStored = fixture.store.evidence.get(fixture.namedEvidence.qa.sha256);
  qaStored.mediaType = "application/json";
  await assert.rejects(
    resolveNamedPrePromotionEvidence({
      store: fixture.store,
      namespace,
      namedEvidence: fixture.namedEvidence,
    }),
    /media type is invalid/u,
  );
  qaStored.mediaType = PRE_PROMOTION_EVIDENCE_MEDIA_TYPES.qa;
  qaStored.bytes = canonicalJsonBytes({ result: "PASS" });
  await assert.rejects(
    resolveNamedPrePromotionEvidence({
      store: fixture.store,
      namespace,
      namedEvidence: fixture.namedEvidence,
    }),
    /immutable verification/u,
  );
});

test("rejects binding, policy, DB, package, and variant drift", async () => {
  const fixture = await createFixture();
  const base = {
    store: fixture.store,
    namespace,
    namedEvidence: fixture.namedEvidence,
  };
  for (const mutation of [
    (binding) => {
      binding.sourceSha = "b".repeat(40);
    },
    (binding) => {
      binding.variantId = "f".repeat(64);
    },
    (binding) => {
      binding.packageIndex = fixture.namedEvidence.qa;
    },
    (binding) => {
      binding.releasePolicy = fixture.namedEvidence.security;
    },
    (binding) => {
      binding.requiredDbCompatibility.fingerprint = "f".repeat(64);
    },
  ]) {
    const standard = structuredClone(fixture.standard);
    mutation(standard);
    await assert.rejects(
      resolveNamedPrePromotionEvidence({
        ...base,
        bindings: { standard, containment: fixture.containment },
      }),
      /differs|invalid/u,
    );
  }
  await assert.rejects(
    resolveNamedPrePromotionEvidence({
      ...base,
      snapshot: {
        activeReleasePolicy: fixture.namedEvidence.security,
        currentDbCompatibility: dbCompatibility,
      },
    }),
    /current policy or DB/u,
  );
});

test("receipt builders reject duplicate builds and caller-forged command results", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    storePrePromotionCategoryReceipt({
      store: fixture.store,
      namespace,
      standardBinding: fixture.standard,
      containmentBinding: fixture.containment,
      category: "reproducibility",
      proof: {
        firstBuildRun: fixture.buildRuns[0],
        secondBuildRun: fixture.buildRuns[0],
      },
    }),
    /two distinct build runs/u,
  );
  const forged = prePromotionVerifierCommands("qa").map((command) => ({
    id: command.id,
    targetBuildOrdinal: command.targetBuildOrdinal,
    exitCode: 0,
    stdoutBytes: Buffer.from("PASS\n"),
    stderrBytes: Buffer.alloc(0),
  }));
  forged[0].exitCode = 1;
  await assert.rejects(
    storePrePromotionVerifierRunReceipt({
      store: fixture.store,
      namespace,
      standardBinding: fixture.standard,
      containmentBinding: fixture.containment,
      category: "qa",
      workflowRunId: "101",
      runAttempt: 1,
      issuerReceiptReference: fixture.issuerReceipts.verifiers.qa,
      executions: forged,
    }),
    /command result is invalid/u,
  );
});
