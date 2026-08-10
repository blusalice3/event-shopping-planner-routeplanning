import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPhaseExitQualityRunSource,
  runPhaseExitQualityRunSourceCli,
} from "./produce-phase-exit-quality-run-source.mjs";
import { canonicalJsonBytes } from "./lib/canonical-json.mjs";

const repository = "foundation/example";
const sourceSha = "a".repeat(40);
const environment = () => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: "20001",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/quality.yml@refs/heads/main`,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
});

test("builds the closed exact-toolchain main-push quality source", () => {
  const value = buildPhaseExitQualityRunSource({
    env: environment(),
    now: () => Date.parse("2026-08-09T00:00:00.000Z"),
    nodeVersion: "24.19.0",
    npmVersion: "11.19.0",
  });
  assert.equal(value.kind, "phase-exit-quality-run-source/v1");
  assert.equal(value.headSha, sourceSha);
  assert.equal(value.observedAt, "2026-08-09T00:00:00.000Z");
  assert.equal(value.checks.length, 15);
  assert.deepEqual([...value.checks].sort(), value.checks);
});

for (const [name, mutate] of [
  ["pull request", (env) => (env.GITHUB_EVENT_NAME = "pull_request")],
  ["unprotected branch", (env) => (env.GITHUB_REF = "refs/heads/feature")],
  ["wrong workflow", (env) => (env.GITHUB_WORKFLOW_REF = "wrong")],
]) {
  test(`rejects ${name} substitution`, () => {
    const env = environment();
    mutate(env);
    assert.throws(
      () =>
        buildPhaseExitQualityRunSource({
          env,
          nodeVersion: "24.19.0",
          npmVersion: "11.19.0",
        }),
      /exact protected main run/u,
    );
  });
}

test("writes canonical bytes once and rejects argument or overwrite substitution", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "quality-source-test-"),
  );
  try {
    const outputPath = path.join(temporaryRoot, "quality-run-source.json");
    await runPhaseExitQualityRunSourceCli({
      argv: ["--output", outputPath],
      env: environment(),
      now: () => Date.parse("2026-08-09T00:00:00.000Z"),
      npmVersion: "11.19.0",
    });
    const bytes = await readFile(outputPath);
    assert.ok(
      bytes.equals(canonicalJsonBytes(JSON.parse(bytes.toString("utf8")))),
    );
    await assert.rejects(
      runPhaseExitQualityRunSourceCli({
        argv: ["--output", outputPath],
        env: environment(),
        npmVersion: "11.19.0",
      }),
      /EEXIST/u,
    );
    await writeFile(path.join(temporaryRoot, "unrelated"), "x");
    await assert.rejects(
      runPhaseExitQualityRunSourceCli({
        argv: ["--", "--output", path.join(temporaryRoot, "other.json")],
        env: environment(),
        npmVersion: "11.19.0",
      }),
      /requires exactly/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
