import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parsePolicyActivationQaArguments,
  runPolicyActivationQaCli,
} from "./policy-activation-qa.mjs";

const namespace = "foundation-prod";
const operationId = "policy-P3-00000001";
const sourceSha = "a".repeat(40);
const runId = "101";

const argvFor = ({
  subjectSha256,
  subject = "subject.json",
  output = "execution.json",
}) => [
  "execute",
  "--namespace",
  namespace,
  "--operation-id",
  operationId,
  "--output",
  output,
  "--run-id",
  runId,
  "--source-sha",
  sourceSha,
  "--subject",
  subject,
  "--subject-sha256",
  subjectSha256,
];

test("parses only the closed Policy QA execute command", () => {
  const values = parsePolicyActivationQaArguments(
    argvFor({ subjectSha256: "b".repeat(64) }),
  );
  assert.equal(values["--operation-id"], operationId);
  assert.throws(
    () =>
      parsePolicyActivationQaArguments([
        ...argvFor({ subjectSha256: "b".repeat(64) }),
        "--unknown",
        "value",
      ]),
    /flags are incomplete/,
  );
  assert.throws(
    () =>
      parsePolicyActivationQaArguments(
        argvFor({ subjectSha256: "not-a-hash" }),
      ),
    /identity is invalid/,
  );
});

test("binds protected CLI flags to reviewed subject bytes before execution", async () => {
  const subjectBytes = canonicalJsonBytes({
    namespace,
    operationId,
    executorSourceSha: sourceSha,
  });
  const subjectSha256 = sha256Bytes(subjectBytes);
  const executionBytes = canonicalJsonBytes({ executionKind: "fixture" });
  let closed = false;
  let written = null;
  let executed = null;
  const output = [];
  const result = await runPolicyActivationQaCli(
    {
      argv: argvFor({ subjectSha256 }),
      env: {
        RELEASE_STATE_NAMESPACE: namespace,
        RELEASE_STATE_DATABASE_URL: "postgres://fixture",
        RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
        GITHUB_SHA: sourceSha,
        GITHUB_RUN_ID: runId,
      },
      cwd: "D:\\fixture",
      stdout: { write: (value) => output.push(value) },
    },
    {
      loadJson: async (filePath) =>
        filePath.endsWith("approval-policy.json")
          ? { bindingStatus: "configured" }
          : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
      readFileImpl: async () => subjectBytes,
      writeFileImpl: async (filePath, bytes, options) => {
        written = { filePath, bytes, options };
      },
      createStore: () => ({
        namespace,
        async close() {
          closed = true;
        },
      }),
      assertEnvironment: () => {},
      execute: async (options) => {
        executed = options;
        return {
          executionBytes,
          executionSha256: sha256Bytes(executionBytes),
        };
      },
    },
  );
  assert.equal(executed.expectedSubjectSha256, subjectSha256);
  assert.equal(executed.workflowRunId, runId);
  assert.deepEqual(executed.subjectBytes, subjectBytes);
  assert.deepEqual(written.bytes, executionBytes);
  assert.equal(written.options.flag, "wx");
  assert.equal(result.operationId, operationId);
  assert.equal(closed, true);
  assert.match(output.join(""), /policy-activation-qa-execution-result/);
});

test("rejects CLI identity drift and output overwrite before provider execution", async () => {
  const subjectBytes = canonicalJsonBytes({
    namespace,
    operationId: "different-operation",
    executorSourceSha: sourceSha,
  });
  let executed = false;
  await assert.rejects(
    runPolicyActivationQaCli(
      {
        argv: argvFor({
          subjectSha256: sha256Bytes(subjectBytes),
          subject: "same.json",
          output: "same.json",
        }),
        env: {
          RELEASE_STATE_NAMESPACE: namespace,
          RELEASE_STATE_DATABASE_URL: "postgres://fixture",
          RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
          GITHUB_SHA: sourceSha,
          GITHUB_RUN_ID: runId,
        },
        cwd: "D:\\fixture",
      },
      {
        loadJson: async (filePath) =>
          filePath.endsWith("approval-policy.json")
            ? {}
            : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
        readFileImpl: async () => subjectBytes,
        createStore: () => ({ close: async () => {} }),
        assertEnvironment: () => {},
        execute: async () => {
          executed = true;
        },
      },
    ),
    /must not overwrite/,
  );
  assert.equal(executed, false);
});
