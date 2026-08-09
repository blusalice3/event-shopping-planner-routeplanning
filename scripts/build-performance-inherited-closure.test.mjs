import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePerformanceInheritedClosureArguments,
  runPerformanceInheritedClosureCli,
} from "./build-performance-inherited-closure.mjs";
import { canonicalJsonBytes, sha256Bytes } from "./lib/canonical-json.mjs";
import { PERFORMANCE_INHERITED_GATES } from "./lib/performance-inherited-closure.mjs";

const hashes = Object.fromEntries(
  PERFORMANCE_INHERITED_GATES.map((gate, index) => [
    gate,
    (index + 1).toString(16).padStart(64, "0"),
  ]),
);
const arguments_ = [
  "--namespace",
  "performance-closure-test",
  "--closure-id",
  "perf-closure-cli-contract",
  "--p0-accepted-event-sha256",
  hashes["P0-TOOLCHAIN"],
  "--p3-accepted-event-sha256",
  hashes["P3-XLSX"],
  "--p5d-accepted-event-sha256",
  hashes["P5-DUAL"],
  "--p5e-accepted-event-sha256",
  hashes["P5-LIST"],
  "--output",
  "performance-evidence.json",
];

test("parses only four distinct historical event hashes", () => {
  assert.deepEqual(
    parsePerformanceInheritedClosureArguments(arguments_)
      .acceptedEventSha256ByGate,
    hashes,
  );
  assert.throws(
    () =>
      parsePerformanceInheritedClosureArguments([
        ...arguments_,
        "--accepted-event-file",
        "event.json",
      ]),
    /Unknown performance closure argument/,
  );
  const duplicate = [...arguments_];
  duplicate[duplicate.indexOf("--p3-accepted-event-sha256") + 1] =
    hashes["P0-TOOLCHAIN"];
  assert.throws(
    () => parsePerformanceInheritedClosureArguments(duplicate),
    /must be distinct/,
  );
});

test("builds only after authoritative store resolution and closes the store", async () => {
  const writes = [];
  const received = {};
  let closed = 0;
  const envelope = {
    schemaVersion: 1,
    closure: { kind: "performance-inherited-closure/v1" },
    closureSha256: "a".repeat(64),
  };
  const result = await runPerformanceInheritedClosureCli(
    {
      arguments_,
      environment: {
        GITHUB_SHA: "b".repeat(40),
        RELEASE_STATE_DATABASE_URL: "postgres://fixture",
        RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
      },
      workingDirectory: "D:/fixture",
      stdout: { write() {} },
    },
    {
      lstatImpl: async () => {
        const error = new Error("absent");
        error.code = "ENOENT";
        throw error;
      },
      writeFileImpl: async (...values) => writes.push(values),
      loadJson: async (filePath) => ({
        fixture: filePath,
        databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
      }),
      verifyPolicy: async () => ({ errors: [] }),
      resolveP8Source: async () => ({
        gitCommitSha: "b".repeat(40),
        sourceClosureSha256: "c".repeat(64),
        treeState: "clean",
      }),
      createStore: async (options) => {
        received.store = options;
        return {
          namespace: "performance-closure-test",
          async close() {
            closed += 1;
          },
        };
      },
      resolveEntries: async (options) => {
        received.authority = options;
        return {
          entries: PERFORMANCE_INHERITED_GATES.map((gate) => ({ gate })),
        };
      },
      buildClosure: (options) => {
        received.build = options;
        return envelope;
      },
      clock: () => Date.parse("2026-08-09T00:00:00.000Z"),
    },
  );
  assert.equal(closed, 1);
  assert.deepEqual(received.authority.acceptedEventSha256ByGate, hashes);
  assert.equal(received.build.createdAtUtc, "2026-08-09T00:00:00.000Z");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][2], { flag: "wx", mode: 0o600 });
  assert.deepEqual(writes[0][1], canonicalJsonBytes(envelope));
  assert.equal(result.sha256, sha256Bytes(canonicalJsonBytes(envelope)));
});

test("closes the authoritative store when closure validation fails", async () => {
  let closed = 0;
  await assert.rejects(
    runPerformanceInheritedClosureCli(
      {
        arguments_,
        environment: {
          RELEASE_STATE_DATABASE_URL: "postgres://fixture",
          RELEASE_STATE_DATABASE_CA_PEM: "fixture-ca",
        },
      },
      {
        lstatImpl: async () => {
          const error = new Error("absent");
          error.code = "ENOENT";
          throw error;
        },
        loadJson: async () => ({
          databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
        }),
        verifyPolicy: async () => ({ errors: [] }),
        resolveP8Source: async () => ({
          gitCommitSha: "b".repeat(40),
          sourceClosureSha256: "c".repeat(64),
          treeState: "clean",
        }),
        createStore: async () => ({
          namespace: "performance-closure-test",
          async close() {
            closed += 1;
          },
        }),
        resolveEntries: async () => ({ entries: [] }),
        buildClosure: () => {
          throw new Error("fixture closure rejected");
        },
      },
    ),
    /fixture closure rejected/,
  );
  assert.equal(closed, 1);
});
