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
const terminalCliArguments = [
  "--terminal-bundle",
  "terminal-bundle.json",
  "--terminal-bundle-sha256",
  "b".repeat(64),
  "--terminal-object-set",
  "terminal-objects.json",
  "--terminal-object-set-sha256",
  "c".repeat(64),
];
const performanceCliArguments = [
  "--performance-evidence",
  "performance.json",
  "--performance-evidence-sha256",
  "d".repeat(64),
];

test("accepts only strict lifecycle command flags", () => {
  assert.equal(
    parseReleaseLifecycleArguments([
      "describe-acceptance-requirements",
      "--namespace",
      namespace,
      "--output",
      "requirements.json",
    ]).command,
    "describe-acceptance-requirements",
  );
  assert.throws(
    () =>
      parseReleaseLifecycleArguments([
        "describe-acceptance-requirements",
        "--namespace",
        namespace,
        "--performance-evidence",
        "caller.json",
        "--output",
        "requirements.json",
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
      ...performanceCliArguments,
      ...terminalCliArguments,
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
        ...performanceCliArguments,
        ...terminalCliArguments,
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
      ...performanceCliArguments,
      "--companion-recovery-drill",
      "recovery.json",
      "--companion-recovery-drill-sha256",
      "d".repeat(64),
      ...terminalCliArguments,
      "--output",
      "result.json",
    ]).command,
    "accept-standard",
  );
  assert.equal(
    parseReleaseLifecycleArguments([
      "activate-policy-floor",
      "--namespace",
      namespace,
      "--subject",
      "policy-activation-subject.json",
      "--subject-sha256",
      "a".repeat(64),
      "--output",
      "policy-activation-result.json",
    ]).command,
    "activate-policy-floor",
  );
  assert.equal(
    parseReleaseLifecycleArguments([
      "activate-policy",
      "--namespace",
      namespace,
      "--subject",
      "policy-activation-subject.json",
      "--subject-sha256",
      "b".repeat(64),
      "--output",
      "policy-activation-result.json",
    ]).command,
    "activate-policy",
  );
  assert.throws(
    () =>
      parseReleaseLifecycleArguments([
        "activate-policy-floor",
        "--namespace",
        namespace,
        "--subject",
        "policy-activation-subject.json",
        "--subject-sha256",
        "a".repeat(64),
        "--minimum-safety-floors",
        "caller.json",
        "--output",
        "policy-activation-result.json",
      ]),
    /Invalid release lifecycle command/,
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
        ...performanceCliArguments,
        ...terminalCliArguments,
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
  const performanceEvidenceBody = { gate: "P0-RELEASE" };
  const performanceEvidenceBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidence: performanceEvidenceBody,
    evidenceSha256: sha256Bytes(canonicalJsonBytes(performanceEvidenceBody)),
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
          "--performance-evidence",
          "performance.json",
          "--performance-evidence-sha256",
          sha256Bytes(performanceEvidenceBytes),
          ...terminalCliArguments,
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
              : path.basename(filePath) === "performance.json"
                ? performanceEvidenceBytes
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
              : path.basename(filePath) === "performance.json"
                ? performanceEvidenceBytes
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
  const performanceEvidenceBody = { gate: "P0-RELEASE", sourceSha };
  const performanceEvidenceBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidence: performanceEvidenceBody,
    evidenceSha256: sha256Bytes(canonicalJsonBytes(performanceEvidenceBody)),
  });
  const terminalBundleBytes = canonicalJsonBytes({ terminal: "bundle" });
  const terminalObjectSetBytes = canonicalJsonBytes({ terminal: "objects" });
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
  } else if (command === "prepare-acceptance-bundle") {
    inputs = {
      "evidence.json": evidenceBytes,
      "continuous.json": continuousProbeBytes,
      "performance.json": performanceEvidenceBytes,
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
      "--performance-evidence",
      "performance.json",
      "--performance-evidence-sha256",
      sha256Bytes(performanceEvidenceBytes),
      "--terminal-bundle-output",
      "terminal-bundle.json",
      "--terminal-object-set-output",
      "terminal-objects.json",
      "--output",
      "result.json",
    ];
  } else {
    inputs = {
      "evidence.json": evidenceBytes,
      "continuous.json": continuousProbeBytes,
      "performance.json": performanceEvidenceBytes,
      "terminal-bundle.json": terminalBundleBytes,
      "terminal-objects.json": terminalObjectSetBytes,
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
      "--performance-evidence",
      "performance.json",
      "--performance-evidence-sha256",
      sha256Bytes(performanceEvidenceBytes),
      "--terminal-bundle",
      "terminal-bundle.json",
      "--terminal-bundle-sha256",
      sha256Bytes(terminalBundleBytes),
      "--terminal-object-set",
      "terminal-objects.json",
      "--terminal-object-set-sha256",
      sha256Bytes(terminalObjectSetBytes),
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
        if (filePath.endsWith("db-compatibility-contract.json")) {
          return { contractUri: "urn:test:db:v1", schemaVersion: 1 };
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
      prepareAcceptance: async (options) => {
        assert.equal(options.expectedRunId, environment.GITHUB_RUN_ID);
        assert.equal(
          JSON.parse(options.dbCompatibilityContractBytes.toString("utf8"))
            .contractUri,
          "urn:test:db:v1",
        );
        return {
          schemaVersion: 1,
          resultKind: "standard-acceptance-terminal-bundle-prepared/v1",
          operationId: "operation-prepare",
          bundle: { terminal: "bundle" },
          bundleBytes: terminalBundleBytes,
          bundleSha256: sha256Bytes(terminalBundleBytes),
          objectSet: { terminal: "objects" },
          objectSetBytes: terminalObjectSetBytes,
          objectSetSha256: sha256Bytes(terminalObjectSetBytes),
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
        assert.equal(
          options.expectedPerformanceEvidenceSha256,
          sha256Bytes(performanceEvidenceBytes),
        );
        assert.equal(
          options.expectedTerminalBundleSha256,
          sha256Bytes(terminalBundleBytes),
        );
        assert.equal(
          options.expectedTerminalObjectSetSha256,
          sha256Bytes(terminalObjectSetBytes),
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
  assert.equal(writes.length, command === "prepare-acceptance-bundle" ? 3 : 1);
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

test("record-promotion writes reconcile material while a recovery remains pending", async () => {
  const operation = {
    operationId: "recover-terminal-cas",
    kind: "activate-containment",
    targetBinding: {
      bindingId: "deployment-binding:recovery-target",
      sourceSha: "b".repeat(40),
    },
  };
  const inputs = {
    "prepared.json": canonicalJsonBytes({
      event: { payload: { pendingOperation: operation } },
    }),
    "receipt.json": canonicalJsonBytes({ receipt: "promoted" }),
    "authority.json": canonicalJsonBytes({ authority: true }),
    "validation.json": canonicalJsonBytes({ validation: true }),
    "probe.json": canonicalJsonBytes({ probe: true }),
  };
  const writes = [];
  const store = { async close() {} };
  await assert.rejects(
    runReleaseLifecycleCli(
      {
        arguments_: [
          "record-promotion",
          "--namespace",
          namespace,
          "--prepared-result",
          "prepared.json",
          "--promotion-receipt",
          "receipt.json",
          "--assignment-authority",
          "authority.json",
          "--assignment-validation",
          "validation.json",
          "--production-probe",
          "probe.json",
          "--output",
          "recovery-result.json",
        ],
        environment,
        workingDirectory: path.resolve("scripts", "fixtures", "lifecycle-cli"),
        stdout: { write() {} },
      },
      {
        loadJson: async (filePath) => {
          if (filePath.endsWith("release-state-store.json")) {
            return { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" };
          }
          if (filePath.endsWith("approval-policy.json")) return approvalPolicy;
          return { bindingStatus: "configured" };
        },
        lstatImpl: async (filePath) => {
          const bytes = inputs[path.basename(filePath)];
          if (bytes === undefined) {
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
        readFileImpl: async (filePath) => inputs[path.basename(filePath)],
        writeFileImpl: async (...args) => {
          writes.push(args);
        },
        createStore: async () => store,
        recordLifecycle: async () => {
          throw new Error("terminal CAS conflict");
        },
        readState: async () => ({
          head: { sequence: 9, eventHash: "f".repeat(64) },
          snapshot: { pendingOperation: operation },
          records: [
            {
              event: {
                eventType: "deployment-assigned",
                operationId: operation.operationId,
              },
            },
          ],
        }),
      },
    ),
    /terminal CAS conflict/,
  );
  assert.equal(writes.length, 1);
  const reconcile = JSON.parse(writes[0][1].toString("utf8"));
  assert.equal(reconcile.resultKind, "recovery-reconcile-required/v1");
  assert.equal(reconcile.status, "pending-provider-reconcile");
  assert.equal(reconcile.targetBindingId, operation.targetBinding.bindingId);
  assert.equal(reconcile.providerObservationRequired, true);
  assert.equal(writes[0][2].flag, "wx");
});

test("prepare-acceptance-bundle CLI writes the reviewed bundle closure", async () => {
  const result = await runFixture({ command: "prepare-acceptance-bundle" });
  assert.equal(result.operationId, "operation-prepare");
});

test("accept-standard CLI derives source/run and writes create-only output", async () => {
  const result = await runFixture({ command: "accept-standard" });
  assert.equal(result.operationId, "operation-accept");
});

test("describes acceptance requirements from the authoritative pending state", async () => {
  const writes = [];
  const store = {
    namespace,
    async close() {},
  };
  const authoritativeRequirements = {
    schemaVersion: 1,
    requirementKind: "standard-acceptance-requirements/v1",
    namespace,
    operationId: "operation-acceptance",
    sourceSha,
    expectedArtifactSha256: "b".repeat(64),
    expectedState: { sequence: 7, eventHash: "a".repeat(64) },
    acceptedGate: "P1-PWA",
    performanceEvidenceKind: "none",
    performanceGate: null,
  };
  let receivedStore;
  const result = await runReleaseLifecycleCli(
    {
      arguments_: [
        "describe-acceptance-requirements",
        "--namespace",
        namespace,
        "--output",
        "requirements.json",
      ],
      environment,
      workingDirectory: path.resolve("scripts", "fixtures", "lifecycle-cli"),
      stdout: { write() {} },
    },
    {
      loadJson: async (filePath) =>
        filePath.endsWith("release-state-store.json")
          ? { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" }
          : approvalPolicy,
      lstatImpl: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      writeFileImpl: async (...args) => {
        writes.push(args);
      },
      createStore: async () => store,
      describeAcceptanceRequirements: async ({ store: received }) => {
        receivedStore = received;
        return authoritativeRequirements;
      },
    },
  );
  assert.equal(receivedStore, store);
  assert.deepEqual(result, authoritativeRequirements);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].flag, "wx");
  assert.deepEqual(
    JSON.parse(writes[0][1].toString("utf8")),
    authoritativeRequirements,
  );
});

test("generic policy activation CLI binds the reviewed subject and derives authority", async () => {
  const subjectBytes = canonicalJsonBytes({
    executorSourceSha: sourceSha,
  });
  const subjectSha256 = sha256Bytes(subjectBytes);
  const writes = [];
  const store = {
    namespace,
    async close() {},
  };
  let received;
  const result = await runReleaseLifecycleCli(
    {
      arguments_: [
        "activate-policy",
        "--namespace",
        namespace,
        "--subject",
        "policy-activation-subject.json",
        "--subject-sha256",
        subjectSha256,
        "--output",
        "policy-activation-result.json",
      ],
      environment,
      workingDirectory: path.resolve("scripts", "fixtures", "lifecycle-cli"),
      stdout: { write() {} },
    },
    {
      loadJson: async (filePath) =>
        filePath.endsWith("release-state-store.json")
          ? { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" }
          : approvalPolicy,
      lstatImpl: async (filePath) => {
        if (path.basename(filePath) === "policy-activation-result.json") {
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        }
        return {
          size: subjectBytes.length,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      },
      readFileImpl: async () => subjectBytes,
      writeFileImpl: async (...args) => {
        writes.push(args);
      },
      createStore: async () => store,
      activatePolicy: async (options) => {
        received = options;
        return {
          schemaVersion: 1,
          resultKind: "policy-activated/v2",
          operationId: "activate-p1-policy",
        };
      },
    },
  );
  assert.equal(received.expectedSubjectSha256, subjectSha256);
  assert.equal(received.expectedExecutorSourceSha, sourceSha);
  assert.equal(received.expectedRunId, environment.GITHUB_RUN_ID);
  assert.equal(Object.hasOwn(received, "minimumSafetyFloors"), false);
  assert.equal(
    received.oidcRequestUrl,
    environment.ACTIONS_ID_TOKEN_REQUEST_URL,
  );
  assert.equal(result.operationId, "activate-p1-policy");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].flag, "wx");
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
          ...performanceCliArguments,
          ...terminalCliArguments,
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
