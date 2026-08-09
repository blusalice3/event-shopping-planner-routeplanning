import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { GITHUB_OIDC_RECEIPT_MEDIA_TYPE } from "./acceptanceEvidenceAuthority.mjs";
import {
  ACCEPTANCE_COLLECTOR_RECEIPT_MEDIA_TYPE,
  parseAcceptanceCollectorArguments,
  runAcceptanceCollectorCli,
} from "./collect-acceptance-evidence-source.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "./reviewedWorkflowRunAuthority.mjs";

const namespace = "acceptance-collector-test";
const sourceSha = "a".repeat(40);
const operationId = "acceptance-collector-operation";
const startedAt = "2026-08-06T00:00:00.000Z";
const domains = ["a.example.test", "b.example.test"];
const workingDirectory = path.resolve(
  "scripts",
  "fixtures",
  "acceptance-collector",
);

const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const binding = (role, suffix) => ({
  bindingId: `${role}-${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: suffix.repeat(64),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-test",
  providerDeploymentId: `deployment-${role}-${suffix}`,
  deploymentUrl: `https://${role}-${suffix}.example.test`,
  artifactArchive: reference(
    role === "standard" ? "9".repeat(64) : "a".repeat(64),
  ),
  artifactArchiveAvailability: reference(
    role === "standard" ? "b".repeat(64) : "c".repeat(64),
  ),
  packageIndex: reference("1".repeat(64)),
  artifactManifest: reference(
    role === "standard" ? "2".repeat(64) : "3".repeat(64),
  ),
  providerEvidence: reference(
    role === "standard" ? "4".repeat(64) : "5".repeat(64),
  ),
  releasePolicy: reference("6".repeat(64)),
  providerPolicy: reference("d".repeat(64)),
  providerConfigurationHash: "e".repeat(64),
  requiredDbCompatibility: {
    contractUri: "urn:test:db:v1",
    fingerprint: "f".repeat(64),
  },
});

const pendingAcceptance = {
  operationId,
  standardBinding: binding("standard", "a"),
  companionBinding: binding("containment", "b"),
  assignmentValidationEvidence: reference("7".repeat(64)),
  observationStartedEvent: {
    uri: `release-state://${namespace}/events/5/${"8".repeat(64)}`,
    sha256: "8".repeat(64),
  },
  observationNotBefore: startedAt,
  minimumObservationEndsAt: "2026-08-07T00:00:00.000Z",
};

const releaseAEvidenceBytes = canonicalJsonBytes({
  release: { releaseId: operationId, commitSha: sourceSha },
  canary: { buildSha: sourceSha, startedAt, endedAt: startedAt },
  automatedGates: {
    rollback: {
      status: "PASS",
      command: "npm run test:release-a-rollback",
      commitSha: sourceSha,
      completedAt: startedAt,
      evidenceRef: "artifact://release-a/rollback-recovery-drill",
    },
  },
});

const approvalPolicy = {
  bindingStatus: "configured",
  blockerCodes: [],
  oidcAudience: "urn:test:release-state",
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  oidcClockSkewSeconds: 60,
  oidcMaxTokenAgeSeconds: 600,
};
const storePolicy = {
  databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
};
const providerPolicy = {
  bindingStatus: "configured",
  expectedProjectId: "project-test",
  expectedTeamId: "team-test",
  ownedProductionDomains: domains,
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.test/",
    maxFutureClockSkewSeconds: 30,
    maxResponseAgeSeconds: 300,
  },
};

class MemoryStore {
  constructor() {
    this.namespace = namespace;
    this.evidence = new Map();
    this.acceptanceChains = new Map();
    this.commitAt = startedAt;
    this.closeCalls = 0;
  }

  async close() {
    this.closeCalls += 1;
  }

  async putEvidence({ bytes, mediaType }) {
    const objectBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(objectBytes);
    const existing = this.evidence.get(sha256);
    if (
      existing &&
      (!existing.bytes.equals(objectBytes) || existing.mediaType !== mediaType)
    ) {
      throw new Error("fixture evidence collision");
    }
    if (!existing) {
      this.evidence.set(sha256, {
        bytes: objectBytes,
        mediaType,
        committedAt: this.commitAt,
      });
    }
    const stored = this.evidence.get(sha256);
    return {
      ...reference(sha256),
      mediaType: stored.mediaType,
      byteLength: stored.bytes.length,
      committedAt: stored.committedAt,
      replayed: Boolean(existing),
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

  async appendAcceptanceSample({
    operationId: requestedOperationId,
    sourceSha: requestedSourceSha,
    bindingId,
    expectedPreviousCommit,
    expectedSequence,
    sampleBytes,
    sampleMediaType,
    commitBytes,
    commitMediaType,
  }) {
    const key = `${requestedOperationId}\n${requestedSourceSha}\n${bindingId}`;
    const head = this.acceptanceChains.get(key) ?? null;
    if (
      (head?.sequence ?? 0) !== expectedSequence ||
      (head === null
        ? expectedPreviousCommit !== null
        : head.head.sha256 !== expectedPreviousCommit?.sha256 ||
          head.head.uri !== expectedPreviousCommit?.uri)
    ) {
      throw new Error("fixture acceptance chain CAS conflict");
    }
    const sample = await this.putEvidence({
      bytes: sampleBytes,
      mediaType: sampleMediaType,
    });
    const commit = await this.putEvidence({
      bytes: commitBytes,
      mediaType: commitMediaType,
    });
    this.acceptanceChains.set(key, {
      sequence: expectedSequence + 1,
      head: { uri: commit.uri, sha256: commit.sha256 },
      updatedAt: commit.committedAt,
    });
    return { sample, commit };
  }

  async readAcceptanceEvidenceChain({ operationId, sourceSha, bindingId }) {
    const value = this.acceptanceChains.get(
      `${operationId}\n${sourceSha}\n${bindingId}`,
    );
    return value ? structuredClone(value) : null;
  }
}

class VirtualFileSystem {
  constructor() {
    this.files = new Map();
    this.directories = new Set();
    this.writes = [];
  }

  resolve(relativePath) {
    return path.resolve(workingDirectory, relativePath);
  }

  async lstat(filePath) {
    if (this.directories.has(filePath)) {
      return {
        size: 0,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    const bytes = this.files.get(filePath);
    if (!bytes) {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
    return {
      size: bytes.length,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
  }

  async readFile(filePath) {
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error(`missing fixture file: ${filePath}`);
    return Buffer.from(bytes);
  }

  async mkdir(directory, options) {
    assert.deepEqual(options, { recursive: false, mode: 0o700 });
    if (this.directories.has(directory)) throw new Error("directory exists");
    this.directories.add(directory);
  }

  async writeFile(filePath, bytes, options) {
    assert.deepEqual(options, { flag: "wx", mode: 0o600 });
    if (this.files.has(filePath)) throw new Error("file exists");
    const stored = Buffer.from(bytes);
    this.files.set(filePath, stored);
    this.writes.push({ filePath, bytes: stored });
  }
}

const environmentForRun = (runId) => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: approvalPolicy.repository,
  GITHUB_WORKFLOW_REF: approvalPolicy.workflowRef,
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: "github-token-fixture",
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://executor:secret@db.example.test/foundation?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test/token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
  VERCEL_TOKEN: "provider-token-fixture",
  RELEASE_A_EVIDENCE_URL:
    "https://observability.example.test/release-a-evidence.json",
  RELEASE_A_EVIDENCE_TOKEN: "evidence-token-fixture",
});

const response = ({ url, bytes, observedAt }) => ({
  status: 200,
  url,
  redirected: false,
  headers: {
    get(name) {
      const key = name.toLowerCase();
      if (key === "content-length") return String(bytes.length);
      if (key === "content-type") return "application/json; charset=utf-8";
      if (key === "date") return new Date(observedAt).toUTCString();
      return null;
    },
  },
  arrayBuffer: async () => bytes,
});

const argumentsFor = ({
  command,
  outputDirectory,
  priorSource = null,
  priorReceipt = null,
  priorSourceSha256 = null,
  priorReceiptSha256 = null,
}) => {
  const result = [command, "--namespace", namespace];
  if (command !== "initialize") {
    result.push(
      "--prior-source",
      priorSource,
      "--prior-source-sha256",
      priorSourceSha256,
      "--prior-receipt",
      priorReceipt,
      "--prior-receipt-sha256",
      priorReceiptSha256,
    );
  }
  if (command === "finalize") {
    result.push("--companion-terminal-event-sha256", "none");
  }
  result.push("--output-directory", outputDirectory);
  return result;
};

const createHarness = () => {
  const store = new MemoryStore();
  const fileSystem = new VirtualFileSystem();
  let nowMilliseconds = Date.parse(startedAt);
  const dependencies = {
    loadJson: async (filePath) => {
      if (filePath.endsWith("approval-policy.json")) return approvalPolicy;
      if (filePath.endsWith("release-state-store.json")) return storePolicy;
      if (filePath.endsWith("provider-policy.json")) return providerPolicy;
      throw new Error(`unexpected policy: ${filePath}`);
    },
    lstatImpl: fileSystem.lstat.bind(fileSystem),
    readFileImpl: fileSystem.readFile.bind(fileSystem),
    mkdirImpl: fileSystem.mkdir.bind(fileSystem),
    writeFileImpl: fileSystem.writeFile.bind(fileSystem),
    storeFactory: async ({ namespace: requestedNamespace }) => {
      assert.equal(requestedNamespace, namespace);
      return store;
    },
    readState: async () => ({
      snapshot: { pendingAcceptance },
      records: [],
    }),
    collectIdentity: async ({ runId }) => {
      const observedAt = new Date(nowMilliseconds).toISOString();
      store.commitAt = observedAt;
      const expiresAt = new Date(
        nowMilliseconds + 15 * 60 * 1000,
      ).toISOString();
      const bytes = canonicalJsonBytes({
        schemaVersion: 1,
        kind: "github-actions-oidc-verification/v1",
        issuer: "https://token.actions.githubusercontent.com",
        audience: approvalPolicy.oidcAudience,
        subject: "repo:owner/repository:environment:foundation-release-state",
        tokenSha256: sha256Json({ runId, observedAt }),
        signingKey: {
          kid: "fixture",
          jwkThumbprintSha256: "1".repeat(64),
        },
        claims: {
          repository: approvalPolicy.repository,
          workflowRef: approvalPolicy.workflowRef,
          workflowSha: sourceSha,
          environment: approvalPolicy.protectedEnvironment,
          runId,
          runAttempt: "1",
          sourceSha,
          eventName: "workflow_dispatch",
          ref: "refs/heads/main",
          refProtected: true,
          jti: `acceptance-collector-${runId}`,
          issuedAt: observedAt,
          notBefore: observedAt,
          expiresAt,
        },
        verifiedAt: observedAt,
      });
      const receipt = await store.putEvidence({
        bytes,
        mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
      });
      return { uri: receipt.uri, sha256: receipt.sha256 };
    },
    collectRunAuthority: async ({
      expectedRunId,
      expectedRunAttempt,
      expectedSourceSha,
      expectedWorkflowPath,
    }) => {
      const apiResponseBytes = canonicalJsonBytes({
        id: Number(expectedRunId),
        run_attempt: Number(expectedRunAttempt),
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: expectedSourceSha,
        path: expectedWorkflowPath,
        repository: { full_name: approvalPolicy.repository },
      });
      const apiResponse = await store.putEvidence({
        bytes: apiResponseBytes,
        mediaType: GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
      });
      const receiptBytes = canonicalJsonBytes({
        schemaVersion: 1,
        kind: "reviewed-github-workflow-run/v1",
        repository: approvalPolicy.repository,
        runId: expectedRunId,
        runAttempt: expectedRunAttempt,
        workflowPath: expectedWorkflowPath,
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        headBranch: "main",
        headSha: expectedSourceSha,
        apiResponse: { uri: apiResponse.uri, sha256: apiResponse.sha256 },
      });
      const receipt = await store.putEvidence({
        bytes: receiptBytes,
        mediaType: REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
      });
      return {
        apiResponse: { uri: apiResponse.uri, sha256: apiResponse.sha256 },
        receipt: { uri: receipt.uri, sha256: receipt.sha256 },
        receiptBytes,
      };
    },
    validateEvidence: () => [],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      let bytes;
      if (parsed.hostname === "api.vercel.test") {
        const productionDomain = decodeURIComponent(
          parsed.pathname.split("/").at(-1),
        );
        bytes = canonicalJsonBytes({
          alias: productionDomain,
          projectId: pendingAcceptance.standardBinding.providerProjectId,
          deploymentId: pendingAcceptance.standardBinding.providerDeploymentId,
          redirect: null,
        });
      } else if (parsed.hostname === "observability.example.test") {
        bytes = releaseAEvidenceBytes;
      } else {
        bytes = canonicalJsonBytes({
          schemaVersion: 1,
          sourceSha,
          buildId: sourceSha,
          variantId: pendingAcceptance.standardBinding.variantId,
          releaseRole: "standard",
        });
      }
      return response({
        url,
        bytes,
        observedAt: new Date(nowMilliseconds).toISOString(),
      });
    },
    clock: () => nowMilliseconds,
  };
  const run = async ({ command, runId, outputDirectory, prior = null }) => {
    const sourcePath = prior
      ? `${prior.outputDirectory}/continuous-production-probe-source.json`
      : null;
    const receiptPath = prior
      ? `${prior.outputDirectory}/acceptance-collector-receipt.json`
      : null;
    const sourceBytes = sourcePath
      ? fileSystem.files.get(fileSystem.resolve(sourcePath))
      : null;
    const receiptBytes = receiptPath
      ? fileSystem.files.get(fileSystem.resolve(receiptPath))
      : null;
    const arguments_ = argumentsFor({
      command,
      outputDirectory,
      priorSource: sourcePath,
      priorReceipt: receiptPath,
      priorSourceSha256: sourceBytes && sha256Bytes(sourceBytes),
      priorReceiptSha256: receiptBytes && sha256Bytes(receiptBytes),
    });
    const result = await runAcceptanceCollectorCli(
      {
        arguments_,
        environment: environmentForRun(runId),
        workingDirectory,
        stdout: { write() {} },
      },
      dependencies,
    );
    nowMilliseconds += 5 * 60 * 1000;
    return { result, arguments_, outputDirectory, sourcePath, receiptPath };
  };
  return { store, fileSystem, dependencies, run };
};

test("parses only the closed acceptance collector command surfaces", () => {
  assert.equal(
    parseAcceptanceCollectorArguments(
      argumentsFor({ command: "initialize", outputDirectory: "run-100" }),
    ).command,
    "initialize",
  );
  assert.throws(
    () =>
      parseAcceptanceCollectorArguments([
        ...argumentsFor({ command: "initialize", outputDirectory: "run-100" }),
        "--source-sha",
        sourceSha,
      ]),
    /arguments are invalid/,
  );
});

test("collects initialize, append, and finalize through immutable prior-run receipts", async () => {
  const fixture = createHarness();
  const initialized = await fixture.run({
    command: "initialize",
    runId: "100",
    outputDirectory: "run-100",
  });
  const appended = await fixture.run({
    command: "append",
    runId: "101",
    outputDirectory: "run-101",
    prior: initialized,
  });
  const finalized = await fixture.run({
    command: "finalize",
    runId: "102",
    outputDirectory: "run-102",
    prior: appended,
  });
  assert.equal(initialized.result.command, "initialize");
  assert.equal(appended.result.command, "append");
  assert.equal(finalized.result.command, "finalize");
  assert.match(
    finalized.result.outputs.authorityBundle.uri,
    /^release-state:/u,
  );
  assert.match(
    finalized.result.outputs.sourceTransaction.uri,
    /^release-state:/u,
  );
  assert.equal(
    finalized.result.outputs.releaseAEvidenceSha256,
    sha256Bytes(releaseAEvidenceBytes),
  );
  const finalEvidence = fixture.fileSystem.files.get(
    fixture.fileSystem.resolve("run-102/release-a-acceptance-evidence.json"),
  );
  assert.ok(finalEvidence.equals(releaseAEvidenceBytes));
  const receipt = await fixture.store.readEvidence({
    sha256: finalized.result.collectorReceipt.sha256,
  });
  assert.equal(receipt.mediaType, ACCEPTANCE_COLLECTOR_RECEIPT_MEDIA_TYPE);
  assert.equal(fixture.store.closeCalls, 3);
  assert.equal(fixture.fileSystem.writes.length, 7);
});

test("rejects same-run, reviewed-hash, and unstored prior receipt drift", async (t) => {
  const fixture = createHarness();
  await fixture.run({
    command: "initialize",
    runId: "100",
    outputDirectory: "run-100",
  });
  const sourceBytes = fixture.fileSystem.files.get(
    fixture.fileSystem.resolve(
      "run-100/continuous-production-probe-source.json",
    ),
  );
  const receiptBytes = fixture.fileSystem.files.get(
    fixture.fileSystem.resolve("run-100/acceptance-collector-receipt.json"),
  );
  const appendArguments = ({
    outputDirectory,
    sourceHash,
    receiptPath,
    receiptHash,
  }) =>
    argumentsFor({
      command: "append",
      outputDirectory,
      priorSource: "run-100/continuous-production-probe-source.json",
      priorSourceSha256: sourceHash,
      priorReceipt: receiptPath,
      priorReceiptSha256: receiptHash,
    });

  await t.test("same protected run", async () => {
    await assert.rejects(
      runAcceptanceCollectorCli(
        {
          arguments_: appendArguments({
            outputDirectory: "same-run",
            sourceHash: sha256Bytes(sourceBytes),
            receiptPath: "run-100/acceptance-collector-receipt.json",
            receiptHash: sha256Bytes(receiptBytes),
          }),
          environment: environmentForRun("100"),
          workingDirectory,
          stdout: { write() {} },
        },
        fixture.dependencies,
      ),
      /Prior acceptance collector receipt binding differs/,
    );
  });

  await t.test("reviewed source hash", async () => {
    await assert.rejects(
      runAcceptanceCollectorCli(
        {
          arguments_: appendArguments({
            outputDirectory: "wrong-hash",
            sourceHash: "f".repeat(64),
            receiptPath: "run-100/acceptance-collector-receipt.json",
            receiptHash: sha256Bytes(receiptBytes),
          }),
          environment: environmentForRun("101"),
          workingDirectory,
          stdout: { write() {} },
        },
        fixture.dependencies,
      ),
      /reviewed input hash differs/,
    );
  });

  await t.test("unstored prior receipt", async () => {
    const original = JSON.parse(receiptBytes.toString("utf8"));
    const tampered = canonicalJsonBytes({
      ...original,
      createdAt: "2026-08-06T00:00:01.000Z",
    });
    fixture.fileSystem.files.set(
      fixture.fileSystem.resolve("tampered-prior-receipt.json"),
      tampered,
    );
    await assert.rejects(
      runAcceptanceCollectorCli(
        {
          arguments_: appendArguments({
            outputDirectory: "unstored-receipt",
            sourceHash: sha256Bytes(sourceBytes),
            receiptPath: "tampered-prior-receipt.json",
            receiptHash: sha256Bytes(tampered),
          }),
          environment: environmentForRun("101"),
          workingDirectory,
          stdout: { write() {} },
        },
        fixture.dependencies,
      ),
      /Prior acceptance collector receipt is not authoritative/,
    );
  });
});
