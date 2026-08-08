import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseReleaseLifecycleArguments,
  runReleaseLifecycleCli,
} from "./execute-release-lifecycle.mjs";

const namespace = "lifecycle-cli";
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
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://executor:secret@db.example.test/foundation?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
  GITHUB_TOKEN: "g".repeat(20),
};

test("accepts only strict lifecycle command flags", () => {
  assert.equal(
    parseReleaseLifecycleArguments([
      "accept-standard",
      "--namespace",
      namespace,
      "--evidence",
      "evidence.json",
      "--evidence-sha256",
      "f".repeat(64),
      "--continuous-probe",
      "continuous.json",
      "--continuous-probe-sha256",
      "e".repeat(64),
      "--output",
      "result.json",
    ]).command,
    "accept-standard",
  );
  assert.throws(
    () =>
      parseReleaseLifecycleArguments([
        "accept-standard",
        "--namespace",
        namespace,
        "--evidence",
        "evidence.json",
        "--evidence-sha256",
        "f".repeat(64),
        "--continuous-probe",
        "continuous.json",
        "--continuous-probe-sha256",
        "e".repeat(64),
        "--output",
        "result.json",
        "--roles",
        "caller",
      ]),
    /Invalid release lifecycle command/,
  );
  assert.equal(
    parseReleaseLifecycleArguments([
      "accept-standard",
      "--namespace",
      namespace,
      "--evidence",
      "evidence.json",
      "--evidence-sha256",
      "f".repeat(64),
      "--continuous-probe",
      "continuous.json",
      "--continuous-probe-sha256",
      "e".repeat(64),
      "--companion-recovery-drill",
      "recovery.json",
      "--companion-recovery-drill-sha256",
      "d".repeat(64),
      "--output",
      "result.json",
    ]).command,
    "accept-standard",
  );
});

test("rejects an output path that aliases a lifecycle input", async () => {
  await assert.rejects(
    runReleaseLifecycleCli({
      arguments_: [
        "accept-standard",
        "--namespace",
        namespace,
        "--evidence",
        "same.json",
        "--evidence-sha256",
        "f".repeat(64),
        "--continuous-probe",
        "continuous.json",
        "--continuous-probe-sha256",
        "e".repeat(64),
        "--output",
        "same.json",
      ],
      environment,
      workingDirectory: path.resolve("scripts", "fixtures", "lifecycle-cli"),
    }),
    /output and inputs must use distinct paths/,
  );
});

test("rejects acceptance bytes that differ from the reviewed hash before opening the store", async () => {
  const evidenceBytes = canonicalJsonBytes({
    release: { commitSha: sourceSha },
  });
  const continuousProbeBytes = canonicalJsonBytes({
    evidenceKind: "continuous-production-probe/v1",
  });
  let storeOpened = false;
  await assert.rejects(
    runReleaseLifecycleCli(
      {
        arguments_: [
          "accept-standard",
          "--namespace",
          namespace,
          "--evidence",
          "evidence.json",
          "--evidence-sha256",
          "f".repeat(64),
          "--continuous-probe",
          "continuous.json",
          "--continuous-probe-sha256",
          sha256Bytes(continuousProbeBytes),
          "--output",
          "result.json",
        ],
        environment,
        workingDirectory: path.resolve("scripts", "fixtures", "lifecycle-cli"),
      },
      {
        loadJson: async (filePath) =>
          filePath.endsWith("release-state-store.json")
            ? {
                databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
              }
            : approvalPolicy,
        lstatImpl: async (filePath) => {
          if (path.basename(filePath) === "result.json") {
            const error = new Error("missing");
            error.code = "ENOENT";
            throw error;
          }
          const bytes =
            path.basename(filePath) === "continuous.json"
              ? continuousProbeBytes
              : evidenceBytes;
          return {
            size: bytes.length,
            isFile: () => true,
            isSymbolicLink: () => false,
          };
        },
        readFileImpl: async (filePath) =>
          Buffer.from(
            path.basename(filePath) === "continuous.json"
              ? continuousProbeBytes
              : evidenceBytes,
          ),
        createStore: async () => {
          storeOpened = true;
          throw new Error("must not open");
        },
      },
    ),
    /differs from the reviewed SHA-256/,
  );
  assert.equal(storeOpened, false);
});

const runFixture = async ({ command }) => {
  const workingDirectory = path.resolve("scripts", "fixtures", "lifecycle-cli");
  const preparedResultBytes = canonicalJsonBytes({
    event: {
      payload: {
        pendingOperation: {
          targetBinding: { sourceSha },
        },
      },
    },
  });
  const evidenceBytes = canonicalJsonBytes({
    release: { commitSha: sourceSha },
  });
  const continuousProbeBytes = canonicalJsonBytes({
    evidenceKind: "continuous-production-probe/v1",
  });
  let inputs;
  let arguments_;
  if (command.startsWith("record-")) {
    inputs = {
      "prepared.json": preparedResultBytes,
      "receipt.json": canonicalJsonBytes({ receipt: true }),
      "authority.json": canonicalJsonBytes({ authority: true }),
    };
    arguments_ = [
      command,
      "--namespace",
      namespace,
      "--prepared-result",
      "prepared.json",
      "--promotion-receipt",
      "receipt.json",
      "--assignment-authority",
      "authority.json",
    ];
    if (command === "record-promotion") {
      inputs["validation.json"] = canonicalJsonBytes({ validation: true });
      inputs["probe.json"] = canonicalJsonBytes({ probe: true });
      arguments_.push(
        "--assignment-validation",
        "validation.json",
        "--production-probe",
        "probe.json",
      );
    }
    arguments_.push("--output", "result.json");
  } else {
    inputs = {
      "evidence.json": evidenceBytes,
      "continuous.json": continuousProbeBytes,
    };
    arguments_ = [
      command,
      "--namespace",
      namespace,
      "--evidence",
      "evidence.json",
      "--evidence-sha256",
      sha256Bytes(evidenceBytes),
      "--continuous-probe",
      "continuous.json",
      "--continuous-probe-sha256",
      sha256Bytes(continuousProbeBytes),
      "--output",
      "result.json",
    ];
  }
  const writes = [];
  const store = {
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  const result = await runReleaseLifecycleCli(
    {
      arguments_,
      environment,
      workingDirectory,
      stdout: { write() {} },
    },
    {
      loadJson: async (filePath) => {
        if (filePath.endsWith("release-state-store.json")) {
          return {
            databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
          };
        }
        if (filePath.endsWith("approval-policy.json")) {
          return approvalPolicy;
        }
        if (filePath.endsWith("provider-policy.json")) {
          return { bindingStatus: "configured" };
        }
        throw new Error(`Unexpected policy path: ${filePath}`);
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
        assert.equal(options.namespace, namespace);
        assert.equal(options.ca, environment.RELEASE_STATE_DATABASE_CA_PEM);
        return store;
      },
      recordAssignment: async (options) => {
        assert.equal(
          options.preparedResultBytes.toString("utf8"),
          preparedResultBytes.toString("utf8"),
        );
        assert.deepEqual(
          JSON.parse(options.assignmentAuthorityBytes.toString("utf8")),
          { authority: true },
        );
        return {
          schemaVersion: 1,
          resultKind: "promotion-assignment-recorded/v1",
          operationId: "operation-assignment",
        };
      },
      recordLifecycle: async (options) => {
        assert.equal(
          options.preparedResultBytes.toString("utf8"),
          preparedResultBytes.toString("utf8"),
        );
        assert.deepEqual(
          JSON.parse(options.assignmentAuthorityBytes.toString("utf8")),
          { authority: true },
        );
        assert.equal(Object.hasOwn(options, "snapshot"), false);
        return {
          schemaVersion: 1,
          resultKind: "promotion-lifecycle-recorded/v1",
          operationId: "operation-record",
        };
      },
      acceptRelease: async (options) => {
        assert.equal(options.expectedRunId, environment.GITHUB_RUN_ID);
        assert.equal(
          options.expectedEvidenceSha256,
          sha256Bytes(evidenceBytes),
        );
        assert.equal(
          options.expectedContinuousProbeSha256,
          sha256Bytes(continuousProbeBytes),
        );
        assert.equal(Object.hasOwn(options, "roles"), false);
        return {
          schemaVersion: 1,
          resultKind: "standard-release-accepted/v1",
          operationId: "operation-accept",
        };
      },
    },
  );
  assert.equal(store.closed, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].flag, "wx");
  assert.equal(writes[0][2].mode, 0o600);
  return result;
};

test("record-promotion CLI binds protected environment and writes create-only output", async () => {
  const result = await runFixture({ command: "record-promotion" });
  assert.equal(result.operationId, "operation-record");
});

test("record-assignment CLI persists provider mutation before route validation", async () => {
  const result = await runFixture({ command: "record-assignment" });
  assert.equal(result.operationId, "operation-assignment");
});

test("accept-standard CLI derives source/run and writes create-only output", async () => {
  const result = await runFixture({ command: "accept-standard" });
  assert.equal(result.operationId, "operation-accept");
});

test("refuses an existing output before opening the Release State store", async () => {
  let storeOpened = false;
  await assert.rejects(
    runReleaseLifecycleCli(
      {
        arguments_: [
          "accept-standard",
          "--namespace",
          namespace,
          "--evidence",
          "evidence.json",
          "--evidence-sha256",
          "f".repeat(64),
          "--continuous-probe",
          "continuous.json",
          "--continuous-probe-sha256",
          "e".repeat(64),
          "--output",
          "result.json",
        ],
        environment,
        workingDirectory: path.resolve("scripts", "fixtures", "lifecycle-cli"),
      },
      {
        lstatImpl: async () => ({
          size: 1,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
        createStore: async () => {
          storeOpened = true;
          throw new Error("must not open");
        },
      },
    ),
    /output already exists/,
  );
  assert.equal(storeOpened, false);
});
