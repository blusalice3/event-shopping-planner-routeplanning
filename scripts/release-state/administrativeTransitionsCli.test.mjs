import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseAdministrativeArguments,
  runAdministrativeTransitionsCli,
} from "./administrative-transitions.mjs";

const namespace = "administrative-cli-test";
const operationId = "activate-db-v2";
const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const common = [
  "--namespace",
  namespace,
  "--operation-id",
  operationId,
  "--output",
  "result.json",
  "--run-id",
  "12345",
  "--source-sha",
  sourceSha,
];

test("parses only the exact administrative command flag set", () => {
  const parsed = parseAdministrativeArguments([
    "produce-db-contract-activated",
    ...common,
    "--db-contract-sha256",
    digest,
  ]);
  assert.equal(parsed.command, "produce-db-contract-activated");
  assert.equal(parsed.values["--db-contract-sha256"], digest);
  for (const argv of [
    [],
    ["unknown", ...common],
    ["produce-db-contract-activated", ...common, "--db-contract-sha256", "bad"],
    ["produce-db-contract-activated", ...common, "--output", "duplicate.json"],
  ]) {
    assert.throws(() => parseAdministrativeArguments(argv));
  }
});

const policies = [
  { bindingStatus: "configured" },
  {
    databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
  },
  { bindingStatus: "configured" },
];
const env = {
  RELEASE_STATE_DATABASE_URL: "postgres://fixture",
  RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
  GITHUB_TOKEN: "github-token",
};

test("produces reviewed subject bytes with exclusive output and closes the store", async () => {
  const subject = {
    schemaVersion: 1,
    subjectKind: "db-contract-activation-subject/v1",
    namespace,
    operationId,
    executorSourceSha: sourceSha,
  };
  const subjectBytes = canonicalJsonBytes(subject);
  let closed = false;
  let write;
  const output = [];
  const result = await runAdministrativeTransitionsCli(
    {
      argv: [
        "produce-db-contract-activated",
        ...common,
        "--db-contract-sha256",
        digest,
      ],
      env,
      cwd: "D:\\fixture",
      stdout: { write: (value) => output.push(value) },
    },
    {
      loadJson: async (filePath) =>
        filePath.endsWith("approval-policy.json")
          ? policies[0]
          : filePath.endsWith("release-state-store.json")
            ? policies[1]
            : policies[2],
      assertEnvironment: () => undefined,
      createStore: async () => ({
        namespace,
        close: async () => {
          closed = true;
        },
      }),
      buildDbActivation: async (options) => {
        assert.equal(options.executorSourceSha, sourceSha);
        assert.equal(options.dbContractReference.sha256, digest);
        return {
          subject,
          subjectBytes,
          subjectSha256: sha256Bytes(subjectBytes),
        };
      },
      writeFileImpl: async (filePath, bytes, options) => {
        write = { filePath, bytes: Buffer.from(bytes), options };
      },
    },
  );
  assert.equal(closed, true);
  assert.equal(write.options.flag, "wx");
  assert.deepEqual(write.bytes, subjectBytes);
  assert.equal(result.subjectSha256, sha256Bytes(subjectBytes));
  assert.match(output.join(""), /subjectSha256/);
});

test("execute binds the reviewed identity and refuses input/output aliasing", async () => {
  const subjectBytes = canonicalJsonBytes({
    namespace,
    operationId,
    executorSourceSha: sourceSha,
  });
  const argv = [
    "execute",
    ...common,
    "--subject",
    "subject.json",
    "--subject-sha256",
    sha256Bytes(subjectBytes),
  ];
  let closed = false;
  const dependencies = {
    loadJson: async (filePath) =>
      filePath.endsWith("approval-policy.json")
        ? policies[0]
        : filePath.endsWith("release-state-store.json")
          ? policies[1]
          : policies[2],
    assertEnvironment: () => undefined,
    createStore: async () => ({
      namespace,
      close: async () => {
        closed = true;
      },
    }),
    readFileImpl: async () => subjectBytes,
    execute: async (options) => {
      assert.equal(options.expectedExecutorSourceSha, sourceSha);
      assert.equal(options.expectedSubjectSha256, sha256Bytes(subjectBytes));
      return { schemaVersion: 1, resultKind: "fixture/v1" };
    },
    writeFileImpl: async (_filePath, _bytes, options) => {
      assert.deepEqual(options, { encoding: "utf8", flag: "wx" });
    },
  };
  await runAdministrativeTransitionsCli(
    { argv, env, cwd: "D:\\fixture", stdout: { write: () => undefined } },
    dependencies,
  );
  assert.equal(closed, true);

  const aliased = [...argv];
  aliased[aliased.indexOf("--output") + 1] = "subject.json";
  await assert.rejects(
    runAdministrativeTransitionsCli(
      {
        argv: aliased,
        env,
        cwd: "D:\\fixture",
        stdout: { write: () => undefined },
      },
      dependencies,
    ),
    /must not overwrite/,
  );
});

test("execute rejects a reviewed subject whose operation differs from CLI authority", async () => {
  const subjectBytes = canonicalJsonBytes({
    namespace,
    operationId: "different-operation",
    executorSourceSha: sourceSha,
  });
  let executed = false;
  await assert.rejects(
    runAdministrativeTransitionsCli(
      {
        argv: [
          "execute",
          ...common,
          "--subject",
          "subject.json",
          "--subject-sha256",
          sha256Bytes(subjectBytes),
        ],
        env,
        cwd: "D:\\fixture",
        stdout: { write: () => undefined },
      },
      {
        loadJson: async (filePath) =>
          filePath.endsWith("approval-policy.json") ? policies[0] : policies[1],
        assertEnvironment: () => undefined,
        createStore: async () => ({ close: async () => undefined }),
        readFileImpl: async () => subjectBytes,
        execute: async () => {
          executed = true;
        },
      },
    ),
    /differs from reviewed CLI identity/,
  );
  assert.equal(executed, false);
});
