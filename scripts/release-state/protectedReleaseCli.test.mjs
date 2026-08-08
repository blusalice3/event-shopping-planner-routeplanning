import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../lib/canonical-json.mjs";
import {
  assertProtectedWorkflowEnvironment,
  parseProtectedReleaseArguments,
  runProtectedReleaseCli,
} from "./protected-release.mjs";

const namespace = "foundation-test";
const sourceSha = "a".repeat(40);
const subjectBytes = Buffer.from('{"canonical":"subject"}');
const subjectSha256 = sha256Bytes(subjectBytes);
const approvalPolicy = {
  bindingStatus: "configured",
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
};
const storePolicy = {
  bindingStatus: "configured",
  databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
};
const providerPolicy = {
  bindingStatus: "configured",
  expectedProjectId: "project-test",
  ownedProductionDomains: ["app.example.test"],
};
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: approvalPolicy.repository,
  GITHUB_WORKFLOW_REF: approvalPolicy.workflowRef,
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: "100",
  GITHUB_RUN_ATTEMPT: "1",
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://executor:secret@db.example.test/foundation?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "test-ca",
  ACTIONS_ID_TOKEN_REQUEST_URL:
    "https://token.actions.githubusercontent.com/test",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
  GITHUB_TOKEN: "github-token",
};

const loadJson = async (filePath) => {
  switch (path.basename(filePath)) {
    case "approval-policy.json":
      return approvalPolicy;
    case "release-state-store.json":
      return storePolicy;
    case "provider-policy.json":
      return providerPolicy;
    default:
      throw new Error(`unexpected policy path: ${filePath}`);
  }
};

test("accepts only the exact command flags and rejects snapshot or role injection", () => {
  const parsed = parseProtectedReleaseArguments([
    "prepare-promotion",
    "--namespace",
    namespace,
    "--subject",
    "subject.json",
    "--subject-sha256",
    subjectSha256,
    "--source-sha",
    sourceSha,
    "--run-id",
    "100",
    "--output",
    "result.json",
  ]);
  assert.equal(parsed.command, "prepare-promotion");
  assert.equal(parsed.values["--source-sha"], sourceSha);

  assert.throws(
    () =>
      parseProtectedReleaseArguments([
        "prepare-promotion",
        "--namespace",
        namespace,
        "--subject",
        "subject.json",
        "--subject-sha256",
        subjectSha256,
        "--source-sha",
        sourceSha,
        "--run-id",
        "100",
        "--snapshot",
        "snapshot.json",
      ]),
    /Invalid or duplicate|Invalid protected release command/,
  );
  assert.throws(
    () =>
      parseProtectedReleaseArguments([
        "reconcile",
        "--namespace",
        namespace,
        "--provider-observation",
        "observation.json",
        "--role",
        "releaseOwner",
      ]),
    /Invalid or duplicate|Invalid protected release command/,
  );
});

test("binds source, run, repository, workflow, protected ref, and namespace to environment", () => {
  assert.doesNotThrow(() =>
    assertProtectedWorkflowEnvironment({
      env: environment,
      approvalPolicy,
      namespace,
      sourceSha,
      runId: "100",
    }),
  );
  assert.throws(
    () =>
      assertProtectedWorkflowEnvironment({
        env: { ...environment, GITHUB_WORKFLOW_REF: "owner/repository/evil" },
        approvalPolicy,
        namespace,
        sourceSha,
        runId: "100",
      }),
    /GITHUB_WORKFLOW_REF differs/,
  );
  assert.throws(
    () =>
      assertProtectedWorkflowEnvironment({
        env: { ...environment, GITHUB_SHA: "b".repeat(40) },
        approvalPolicy,
        namespace,
        sourceSha,
        runId: "100",
      }),
    /GITHUB_SHA differs/,
  );
});

test("runs prepare-promotion with an injected store and no caller authority fields", async () => {
  const writes = [];
  const messages = [];
  const store = {
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  let received;
  const result = await runProtectedReleaseCli(
    {
      argv: [
        "prepare-promotion",
        "--namespace",
        namespace,
        "--subject",
        "subject.json",
        "--subject-sha256",
        subjectSha256,
        "--source-sha",
        sourceSha,
        "--run-id",
        "100",
        "--output",
        "result.json",
      ],
      env: environment,
      cwd: "C:\\fixture",
      stdout: {
        write(value) {
          messages.push(value);
        },
      },
    },
    {
      loadJson,
      readFileImpl: async () => subjectBytes,
      writeFileImpl: async (...args) => {
        writes.push(args);
      },
      createStore: async (binding) => {
        assert.equal(binding.namespace, namespace);
        assert.equal(
          binding.connectionString,
          environment.RELEASE_STATE_DATABASE_URL,
        );
        assert.equal(binding.ca, environment.RELEASE_STATE_DATABASE_CA_PEM);
        return store;
      },
      prepare: async (options) => {
        received = options;
        return {
          schemaVersion: 1,
          status: "prepared",
        };
      },
    },
  );
  assert.equal(result.status, "prepared");
  assert.equal(received.expectedSourceSha, sourceSha);
  assert.equal(received.expectedSubjectSha256, subjectSha256);
  assert.equal(received.expectedRunId, "100");
  assert.equal(Object.hasOwn(received, "snapshot"), false);
  assert.equal(Object.hasOwn(received, "approvalRefs"), false);
  assert.equal(Object.hasOwn(received, "roles"), false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].flag, "wx");
  assert.equal(messages.length, 1);
  assert.equal(store.closed, true);
});

test("writes a blocked read-only reconcile decision and then fails the command closed", async () => {
  const writes = [];
  const store = {
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  let observationRecorded = false;
  await assert.rejects(
    runProtectedReleaseCli(
      {
        argv: [
          "reconcile",
          "--namespace",
          namespace,
          "--provider-observation",
          "observation.json",
          "--output",
          "decision.json",
        ],
        env: environment,
        cwd: "C:\\fixture",
        stdout: { write() {} },
      },
      {
        loadJson,
        readFileImpl: async () => Buffer.from('{"canonical":"observation"}'),
        writeFileImpl: async (...args) => {
          writes.push(args);
        },
        createStore: async () => store,
        recordProviderObservation: async ({ observationBytes }) => {
          assert.equal(
            observationBytes.toString("utf8"),
            '{"canonical":"observation"}',
          );
          observationRecorded = true;
        },
        decideReconcile: async (options) => {
          assert.equal(observationRecorded, true);
          assert.equal(Object.hasOwn(options, "snapshot"), false);
          return {
            schemaVersion: 1,
            status: "blocked",
            reasonCodes: ["partial-production-domain-set"],
          };
        },
      },
    ),
    /Reconcile is blocked: partial-production-domain-set/,
  );
  assert.equal(writes.length, 1);
  assert.equal(observationRecorded, true);
  assert.equal(store.closed, true);
});

test("executes the ready reconcile event plan before writing the protected result", async () => {
  const writes = [];
  const store = {
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  const decision = {
    schemaVersion: 1,
    status: "ready",
    operationId: "operation-ready",
    eventPlan: {
      eventType: "state-reconciled",
    },
  };
  let appended = false;
  const result = await runProtectedReleaseCli(
    {
      argv: [
        "reconcile",
        "--namespace",
        namespace,
        "--provider-observation",
        "observation.json",
        "--output",
        "decision.json",
      ],
      env: environment,
      cwd: "C:\\fixture",
      stdout: { write() {} },
    },
    {
      loadJson,
      readFileImpl: async () => Buffer.from('{"canonical":"observation"}'),
      writeFileImpl: async (...args) => {
        writes.push(args);
      },
      createStore: async () => store,
      recordProviderObservation: async () => {},
      decideReconcile: async () => decision,
      appendReconcile: async (options) => {
        assert.equal(options.store, store);
        assert.equal(options.decision, decision);
        appended = true;
        return {
          ...decision,
          appended: true,
          replayed: false,
        };
      },
    },
  );
  assert.equal(appended, true);
  assert.equal(result.appended, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].flag, "wx");
  assert.equal(store.closed, true);
});
