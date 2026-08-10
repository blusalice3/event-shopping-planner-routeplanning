import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { contentAddressedObjectPath } from "../lib/content-addressed-store.mjs";
import { PRE_PROMOTION_EVIDENCE_CATEGORIES } from "./prePromotionEvidence.mjs";
import { executePrePromotionEvidenceCollection } from "./prePromotionEvidenceExecution.mjs";
import { createStoredPrePromotionFixture } from "./prePromotionEvidenceTestFixture.mjs";

const namespace = "prepromotion-execution-test";
const sourceSha = "a".repeat(40);
const workflowRunId = "501";
const runAttempt = 3;
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
    const stored = this.evidence.get(sha256);
    return stored
      ? {
          bytes: Buffer.from(stored.bytes),
          mediaType: stored.mediaType,
          committedAt: stored.committedAt,
        }
      : null;
  }
}

const loadReleasePolicy = async () => ({
  ...JSON.parse(
    await readFile(
      new URL("../../config/release-variants.json", import.meta.url),
      "utf8",
    ),
  ),
  activationStatus: "active",
  activationBlockers: [],
});

const oidcReceiptBytes = () =>
  canonicalJsonBytes({
    schemaVersion: 1,
    kind: "github-actions-oidc-verification/v1",
    issuer: "https://token.actions.githubusercontent.com",
    audience: "urn:test:release-state",
    subject: "repo:test/repository:environment:foundation-release-state",
    tokenSha256: "9".repeat(64),
    signingKey: {
      kid: "fixture",
      jwkThumbprintSha256: "7".repeat(64),
    },
    claims: {
      repository: "test/repository",
      workflowRef:
        "test/repository/.github/workflows/release.yml@refs/heads/main",
      workflowSha: sourceSha,
      environment: "foundation-release-state",
      runId: workflowRunId,
      runAttempt: String(runAttempt),
      sourceSha,
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      refProtected: true,
      jti: "execution-fixture",
      issuedAt: "2026-08-06T00:00:00.000Z",
      notBefore: "2026-08-06T00:00:00.000Z",
      expiresAt: "2026-08-06T00:10:00.000Z",
    },
    verifiedAt: "2026-08-06T00:00:00.000Z",
  });

const writeBuiltPackage = async ({
  output,
  fixture,
  corruptArchive = false,
}) => {
  await mkdir(output, { recursive: true });
  const indexStored = await fixture.store.readEvidence({
    sha256: fixture.packageIndexReference.sha256,
  });
  await writeFile(
    path.join(output, "release-package-index.json"),
    indexStored.bytes,
  );
  for (const artifact of fixture.packageIndex.artifacts) {
    const binding =
      artifact.releaseRole === "standard"
        ? fixture.standard
        : fixture.containment;
    const manifestStored = await fixture.store.readEvidence({
      sha256: binding.artifactManifest.sha256,
    });
    const archiveStored = await fixture.store.readEvidence({
      sha256: binding.artifactArchive.sha256,
    });
    const manifestPath = contentAddressedObjectPath(
      output,
      artifact.manifest.sha256,
      "artifact.json",
    );
    const archivePath = contentAddressedObjectPath(
      output,
      artifact.archive.sha256,
      "artifact.zip",
    );
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifestStored.bytes);
    await writeFile(
      archivePath,
      corruptArchive && artifact.releaseRole === "containment"
        ? Buffer.from("corrupt")
        : archiveStored.bytes,
    );
  }
};

const createHarness = async ({
  dirty = false,
  failScript = null,
  corruptSecondBuild = false,
  leakSecret = false,
} = {}) => {
  const temporaryParent = await mkdtemp(
    path.join(os.tmpdir(), "prepromotion-execution-test-"),
  );
  const repositoryRoot = path.join(temporaryParent, "repository");
  const buildRoot = path.join(temporaryParent, "builds");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(buildRoot, { recursive: true }),
  ]);
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
  const buildRequirementsStored = await store.readEvidence({
    sha256: fixture.buildAuthority.sha256,
  });
  const buildRequirementsPath = path.join(
    temporaryParent,
    "artifact-build-requirements.json",
  );
  const providerObservationPath = path.join(
    temporaryParent,
    "provider-observation.json",
  );
  const providerObservationBytes = canonicalJsonBytes({ schemaVersion: 1 });
  await Promise.all([
    writeFile(buildRequirementsPath, buildRequirementsStored.bytes),
    writeFile(providerObservationPath, providerObservationBytes),
  ]);
  const calls = [];
  let buildCount = 0;
  const environment = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret-token",
    RELEASE_STATE_DATABASE_URL: "postgres://secret-connection-string",
  };
  const runCommand = async (request) => {
    calls.push(
      structuredClone({
        executable: request.executable,
        arguments: request.arguments,
        cwd: request.cwd,
      }),
    );
    if (request.executable === "git" && request.arguments[0] === "rev-parse") {
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(`${sourceSha}\n`),
        stderr: Buffer.alloc(0),
      };
    }
    if (request.executable === "git") {
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(dirty ? " M tracked-file\n" : ""),
        stderr: Buffer.alloc(0),
      };
    }
    const script = request.arguments[1];
    if (script === "artifact:build") {
      buildCount += 1;
      const outputIndex = request.arguments.indexOf("--output") + 1;
      await writeBuiltPackage({
        output: request.arguments[outputIndex],
        fixture: { ...fixture, store },
        corruptArchive: corruptSecondBuild && buildCount === 2,
      });
    }
    return {
      status: script === failScript ? 1 : 0,
      signal: null,
      stdout: Buffer.from(
        leakSecret
          ? `${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}\n`
          : `PASS ${script}\n`,
      ),
      stderr: Buffer.alloc(0),
    };
  };
  const options = {
    store,
    namespace,
    sourceSha,
    workflowRunId,
    runAttempt,
    repositoryRoot,
    standardBinding: fixture.standard,
    containmentBinding: fixture.containment,
    buildRequirementsBytes: buildRequirementsStored.bytes,
    buildRequirementsSha256: fixture.buildAuthority.sha256,
    buildRequirementsPath,
    providerObservationBytes,
    providerObservationSha256: sha256Bytes(providerObservationBytes),
    providerObservationPath,
    environment,
    approvalPolicy: { oidcAudience: "urn:test:release-state" },
  };
  return {
    ...fixture,
    store,
    calls,
    options,
    buildRoot,
    cleanup: () => rm(temporaryParent, { recursive: true, force: true }),
    dependencies: {
      runCommand,
      obtainOidcReceiptBytes: async () => oidcReceiptBytes(),
      createTemporaryRoot: async () => buildRoot,
      removeTemporaryRoot: async () => undefined,
    },
  };
};

test("executes two independent builds and exact verifier matrices before producing five receipts", async () => {
  const harness = await createHarness();
  try {
    const result = await executePrePromotionEvidenceCollection(
      harness.options,
      harness.dependencies,
    );
    assert.equal(result.source.sourceKind, "pre-promotion-evidence-source/v2");
    assert.deepEqual(
      Object.keys(result.source.evidence).sort(),
      [...PRE_PROMOTION_EVIDENCE_CATEGORIES].sort(),
    );
    assert.equal(result.buildRuns.length, 2);
    const npmCalls = harness.calls.filter(
      (call) => call.executable === "npm" || call.executable === "npm.cmd",
    );
    assert.equal(
      npmCalls.filter((call) => call.arguments[1] === "artifact:build").length,
      2,
    );
    assert.equal(
      npmCalls.filter((call) => call.arguments[1] === "verify:toolchain")
        .length,
      1,
    );
    const outputPaths = npmCalls
      .filter((call) => call.arguments[1] === "artifact:build")
      .map((call) => call.arguments[call.arguments.indexOf("--output") + 1]);
    assert.equal(new Set(outputPaths).size, 2);
    assert.equal(
      npmCalls.some((call) => call.arguments.includes("--executions")),
      false,
    );
  } finally {
    await harness.cleanup();
  }
});

test("fails before receipts when a fixed verifier command returns nonzero", async () => {
  const harness = await createHarness({ failScript: "test:browser" });
  try {
    await assert.rejects(
      executePrePromotionEvidenceCollection(
        harness.options,
        harness.dependencies,
      ),
      /test-browser failed/u,
    );
  } finally {
    await harness.cleanup();
  }
});

test("rejects a second build whose archive bytes differ", async () => {
  const harness = await createHarness({ corruptSecondBuild: true });
  try {
    await assert.rejects(
      executePrePromotionEvidenceCollection(
        harness.options,
        harness.dependencies,
      ),
      /bytes differ|differs/u,
    );
  } finally {
    await harness.cleanup();
  }
});

test("rejects dirty checkout and credential-bearing command output", async () => {
  const dirty = await createHarness({ dirty: true });
  try {
    await assert.rejects(
      executePrePromotionEvidenceCollection(dirty.options, dirty.dependencies),
      /dirty/u,
    );
    assert.equal(
      dirty.calls.some((call) => call.arguments[1] === "artifact:build"),
      false,
    );
  } finally {
    await dirty.cleanup();
  }
  const leaking = await createHarness({ leakSecret: true });
  try {
    await assert.rejects(
      executePrePromotionEvidenceCollection(
        leaking.options,
        leaking.dependencies,
      ),
      /protected credentials/u,
    );
  } finally {
    await leaking.cleanup();
  }
});

test("rejects forged OIDC identity and a build requirements path mismatch", async () => {
  const forged = await createHarness();
  try {
    await assert.rejects(
      executePrePromotionEvidenceCollection(forged.options, {
        ...forged.dependencies,
        obtainOidcReceiptBytes: async () => {
          const value = JSON.parse(oidcReceiptBytes().toString("utf8"));
          value.claims.runId = "999";
          return canonicalJsonBytes(value);
        },
      }),
      /OIDC receipt.*protected workflow run/u,
    );
    await assert.rejects(
      executePrePromotionEvidenceCollection(forged.options, {
        ...forged.dependencies,
        obtainOidcReceiptBytes: async () => {
          const value = JSON.parse(oidcReceiptBytes().toString("utf8"));
          value.callerClaim = true;
          return canonicalJsonBytes(value);
        },
      }),
      /OIDC receipt has unknown or missing fields/u,
    );
  } finally {
    await forged.cleanup();
  }
  const mismatch = await createHarness();
  try {
    await writeFile(mismatch.options.buildRequirementsPath, "{}\n", "utf8");
    await assert.rejects(
      executePrePromotionEvidenceCollection(
        mismatch.options,
        mismatch.dependencies,
      ),
      /file differs/u,
    );
  } finally {
    await mismatch.cleanup();
  }
});
