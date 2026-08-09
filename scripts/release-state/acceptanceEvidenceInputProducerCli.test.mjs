import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import "./acceptanceEvidenceCollectorCli.cases.mjs";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseAcceptanceEvidenceInputArguments,
  runAcceptanceEvidenceInputProducerCli,
} from "./produce-acceptance-evidence-input.mjs";

const namespace = "acceptance-producer-test";
const sourceSha = "a".repeat(40);
const approvalPolicy = {
  bindingStatus: "configured",
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
};
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: approvalPolicy.repository,
  GITHUB_WORKFLOW_REF: approvalPolicy.workflowRef,
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: "200",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: "github-token-fixture",
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://executor:secret@db.example.test/foundation?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
};
const releaseAEvidenceBytes = canonicalJsonBytes({
  release: {
    releaseId: "pending-operation",
    commitSha: sourceSha,
  },
});
const sourceBytes = canonicalJsonBytes({
  schemaVersion: 1,
  sourceKind: "fixture-source/v1",
});
const collectorReceiptBytes = canonicalJsonBytes({
  schemaVersion: 1,
  evidenceKind: "acceptance-collector-receipt/v1",
});

const argumentsFor = (command, sourceHash = sha256Bytes(sourceBytes)) => [
  command,
  "--namespace",
  namespace,
  "--collector-receipt",
  "acceptance-collector-receipt.json",
  "--collector-receipt-sha256",
  sha256Bytes(collectorReceiptBytes),
  "--release-evidence",
  "release-a.json",
  "--release-evidence-sha256",
  sha256Bytes(releaseAEvidenceBytes),
  "--source",
  "source.json",
  "--source-sha256",
  sourceHash,
  "--output",
  "output.json",
];

test("accepts only the exact canonical input producer flags", () => {
  assert.equal(
    parseAcceptanceEvidenceInputArguments(argumentsFor("continuous-probe"))
      .command,
    "continuous-probe",
  );
  assert.throws(
    () =>
      parseAcceptanceEvidenceInputArguments([
        ...argumentsFor("companion-recovery"),
        "--snapshot",
        "caller.json",
      ]),
    /Usage/,
  );
  const duplicate = argumentsFor("continuous-probe");
  duplicate[duplicate.indexOf("--source")] = "--namespace";
  assert.throws(
    () => parseAcceptanceEvidenceInputArguments(duplicate),
    /Invalid or duplicate/,
  );
});

const harness = ({ sourceHash = sha256Bytes(sourceBytes) } = {}) => {
  const workingDirectory = path.resolve(
    "scripts",
    "fixtures",
    "acceptance-producer",
  );
  const inputs = {
    "acceptance-collector-receipt.json": collectorReceiptBytes,
    "release-a.json": releaseAEvidenceBytes,
    "source.json": sourceBytes,
  };
  const writes = [];
  let opened = false;
  const store = {
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  const dependencies = {
    loadJson: async (filePath) => {
      if (filePath.endsWith("approval-policy.json")) return approvalPolicy;
      if (filePath.endsWith("release-state-store.json")) {
        return {
          databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
        };
      }
      if (filePath.endsWith("provider-policy.json")) {
        return {
          observationPolicy: { maxFutureClockSkewSeconds: 30 },
        };
      }
      throw new Error(`Unexpected policy: ${filePath}`);
    },
    lstatImpl: async (filePath) => {
      const bytes = inputs[path.basename(filePath)];
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
    },
    readFileImpl: async (filePath) =>
      Buffer.from(inputs[path.basename(filePath)]),
    writeFileImpl: async (...writeArguments) => {
      writes.push(writeArguments);
    },
    createStore: async (options) => {
      opened = true;
      assert.equal(options.namespace, namespace);
      return store;
    },
    readState: async () => ({
      snapshot: {
        pendingAcceptance: {
          operationId: "pending-operation",
        },
      },
    }),
    resolveCollectorAuthority: async () => ({
      workflowRunAuthority: {
        receipt: {
          uri: `release-state://${namespace}/evidence/${"f".repeat(64)}`,
          sha256: "f".repeat(64),
        },
      },
    }),
    clock: () => Date.parse("2026-08-07T00:00:00.000Z"),
  };
  return {
    arguments_: argumentsFor("continuous-probe", sourceHash),
    workingDirectory,
    writes,
    store,
    dependencies,
    wasOpened: () => opened,
  };
};

test("rejects source hash drift before opening Release State", async () => {
  const fixture = harness({ sourceHash: "f".repeat(64) });
  await assert.rejects(
    runAcceptanceEvidenceInputProducerCli(
      {
        arguments_: fixture.arguments_,
        environment,
        workingDirectory: fixture.workingDirectory,
      },
      fixture.dependencies,
    ),
    /differs from its reviewed SHA-256/,
  );
  assert.equal(fixture.wasOpened(), false);
});

test("derives from replayed pending state and writes create-only evidence", async () => {
  const fixture = harness();
  const producedBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "continuous-production-probe/v1",
  });
  fixture.dependencies.produceContinuous = async (options) => {
    assert.equal(options.namespace, namespace);
    assert.equal(options.pendingAcceptance.operationId, "pending-operation");
    assert.equal(options.expectedSourceSha256, sha256Bytes(sourceBytes));
    return {
      evidence: JSON.parse(producedBytes.toString("utf8")),
      evidenceBytes: producedBytes,
      sha256: sha256Bytes(producedBytes),
    };
  };
  const result = await runAcceptanceEvidenceInputProducerCli(
    {
      arguments_: fixture.arguments_,
      environment,
      workingDirectory: fixture.workingDirectory,
      stdout: { write() {} },
    },
    fixture.dependencies,
  );
  assert.equal(result.sha256, sha256Bytes(producedBytes));
  assert.equal(fixture.store.closed, true);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0][2].flag, "wx");
  assert.equal(fixture.writes[0][2].mode, 0o600);
});
