import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parsePrePromotionEvidenceCollectorArguments,
  runPrePromotionEvidenceCollectorCli,
} from "./collect-prepromotion-evidence.mjs";

const namespace = "prepromotion-cli-test";
const sourceSha = "a".repeat(40);
const runId = "700";

const argumentsFor = ({
  standard = "standard.json",
  containment = "containment.json",
  requirements = "requirements.json",
  requirementsSha256 = "b".repeat(64),
  observation = "observation.json",
  observationSha256 = "c".repeat(64),
  output = "source.json",
} = {}) => [
  "--namespace",
  namespace,
  "--source-sha",
  sourceSha,
  "--run-id",
  runId,
  "--standard-binding",
  standard,
  "--containment-binding",
  containment,
  "--build-requirements",
  requirements,
  "--build-requirements-sha256",
  requirementsSha256,
  "--provider-observation",
  observation,
  "--provider-observation-sha256",
  observationSha256,
  "--output",
  output,
];

const environment = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token-value",
  ACTIONS_ID_TOKEN_REQUEST_URL:
    "https://token.actions.githubusercontent.com/example",
  GITHUB_RUN_ATTEMPT: "2",
  RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
  RELEASE_STATE_DATABASE_URL:
    "postgres://role:password@db.example.test/release?sslmode=verify-full",
};

const createInputs = async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "prepromotion-cli-test-"),
  );
  const bytes = {
    standard: canonicalJsonBytes({ binding: "standard" }),
    containment: canonicalJsonBytes({ binding: "containment" }),
    requirements: canonicalJsonBytes({ requirementsKind: "fixture" }),
    observation: canonicalJsonBytes({ evidenceKind: "fixture-observation" }),
  };
  await Promise.all([
    writeFile(path.join(directory, "standard.json"), bytes.standard),
    writeFile(path.join(directory, "containment.json"), bytes.containment),
    writeFile(path.join(directory, "requirements.json"), bytes.requirements),
    writeFile(path.join(directory, "observation.json"), bytes.observation),
  ]);
  return { directory, bytes };
};

test("parses only the closed collector flag set and forbids execution JSON", () => {
  const values = parsePrePromotionEvidenceCollectorArguments(argumentsFor());
  assert.equal(values["--namespace"], namespace);
  assert.throws(
    () =>
      parsePrePromotionEvidenceCollectorArguments([
        ...argumentsFor(),
        "--executions",
        "caller-results.json",
      ]),
    /Usage|Invalid/u,
  );
  const duplicate = argumentsFor();
  duplicate[duplicate.indexOf("--output")] = "--standard-binding";
  assert.throws(
    () => parsePrePromotionEvidenceCollectorArguments(duplicate),
    /duplicate/u,
  );
});

test("validates canonical regular inputs before opening the store and writes with wx", async () => {
  const fixture = await createInputs();
  let closed = false;
  let created = false;
  let executed = false;
  try {
    const sourceBytes = canonicalJsonBytes({ sourceKind: "fixture-source" });
    const result = await runPrePromotionEvidenceCollectorCli(
      {
        argv: argumentsFor({
          requirementsSha256: sha256Bytes(fixture.bytes.requirements),
          observationSha256: sha256Bytes(fixture.bytes.observation),
        }),
        env: environment,
        cwd: fixture.directory,
        stdout: { write: () => true },
      },
      {
        loadJson: async (filePath) =>
          filePath.endsWith("approval-policy.json")
            ? { bindingStatus: "configured" }
            : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
        assertEnvironment: ({
          namespace: actualNamespace,
          sourceSha: actualSource,
        }) => {
          assert.equal(actualNamespace, namespace);
          assert.equal(actualSource, sourceSha);
        },
        createStore: async ({ namespace: actualNamespace }) => {
          created = true;
          assert.equal(actualNamespace, namespace);
          return {
            close: async () => {
              closed = true;
            },
          };
        },
        executeCollection: async (options) => {
          executed = true;
          assert.equal(options.workflowRunId, runId);
          assert.equal(options.runAttempt, 2);
          assert.deepEqual(options.standardBinding, { binding: "standard" });
          assert.deepEqual(options.containmentBinding, {
            binding: "containment",
          });
          assert.ok(
            options.buildRequirementsBytes.equals(fixture.bytes.requirements),
          );
          assert.ok(
            options.providerObservationBytes.equals(fixture.bytes.observation),
          );
          return {
            sourceBytes,
            sourceSha256: sha256Bytes(sourceBytes),
          };
        },
        writeFileImpl: async (filePath, data, options) => {
          assert.equal(options.flag, "wx");
          await writeFile(filePath, data, options);
        },
      },
    );
    assert.equal(created, true);
    assert.equal(executed, true);
    assert.equal(closed, true);
    assert.ok(
      (await readFile(path.join(fixture.directory, "source.json"))).equals(
        sourceBytes,
      ),
    );
    assert.equal(result.sourceSha256, sha256Bytes(sourceBytes));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects case-folded path alias, symlink input, noncanonical bytes, and hash drift before store access", async () => {
  const fixture = await createInputs();
  let storeCalls = 0;
  const commonDependencies = {
    loadJson: async (filePath) =>
      filePath.endsWith("approval-policy.json")
        ? { bindingStatus: "configured" }
        : { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" },
    assertEnvironment: () => undefined,
    createStore: async () => {
      storeCalls += 1;
      return { close: async () => undefined };
    },
  };
  try {
    await assert.rejects(
      runPrePromotionEvidenceCollectorCli(
        {
          argv: argumentsFor({
            standard: "CasePath.json",
            output: "casepath.JSON",
            requirementsSha256: sha256Bytes(fixture.bytes.requirements),
            observationSha256: sha256Bytes(fixture.bytes.observation),
          }),
          env: environment,
          cwd: fixture.directory,
        },
        commonDependencies,
      ),
      /must not overwrite/u,
    );
    const outputPath = path.join(fixture.directory, "source.json");
    const symlinkStatus = {
      isFile: () => true,
      isSymbolicLink: () => true,
      size: fixture.bytes.standard.length,
    };
    await assert.rejects(
      runPrePromotionEvidenceCollectorCli(
        {
          argv: argumentsFor({
            requirementsSha256: sha256Bytes(fixture.bytes.requirements),
            observationSha256: sha256Bytes(fixture.bytes.observation),
          }),
          env: environment,
          cwd: fixture.directory,
        },
        {
          ...commonDependencies,
          lstatImpl: async (filePath) => {
            if (filePath === outputPath) {
              const error = new Error("absent");
              error.code = "ENOENT";
              throw error;
            }
            return symlinkStatus;
          },
        },
      ),
      /regular file/u,
    );
    await writeFile(
      path.join(fixture.directory, "observation.json"),
      '{\n  "evidenceKind": "fixture-observation"\n}\n',
      "utf8",
    );
    await assert.rejects(
      runPrePromotionEvidenceCollectorCli(
        {
          argv: argumentsFor({
            requirementsSha256: sha256Bytes(fixture.bytes.requirements),
            observationSha256: sha256Bytes(fixture.bytes.observation),
          }),
          env: environment,
          cwd: fixture.directory,
        },
        commonDependencies,
      ),
      /canonical JSON/u,
    );
    assert.equal(storeCalls, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
