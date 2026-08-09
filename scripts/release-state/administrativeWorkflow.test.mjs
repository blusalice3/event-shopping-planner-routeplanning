import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const workflow = await readFile(
  path.join(root, ".github", "workflows", "release.yml"),
  "utf8",
);

const stepBody = (name, nextName) => {
  const start = workflow.indexOf(`      - name: ${name}`);
  const end = workflow.indexOf(`      - name: ${nextName}`, start + 1);
  assert.notEqual(start, -1, `workflow step is absent: ${name}`);
  assert.notEqual(end, -1, `workflow step boundary is absent: ${nextName}`);
  return workflow.slice(start, end);
};

test("connects every administrative transition through a separate subject run", () => {
  for (const operation of [
    "produce-state-initialization-subject",
    "initialize-release-state",
    "produce-db-contract-activation-subject",
    "activate-db-contract",
    "produce-operation-abort-subject",
    "abort-pending-operation",
  ]) {
    assert.match(workflow, new RegExp(`- ${operation}`));
  }

  const producer = stepBody(
    "Produce authoritative administrative transition subject",
    "Upload state initialization subject",
  );
  assert.match(producer, /produce-state-initialized/);
  assert.match(producer, /produce-db-contract-activated/);
  assert.match(producer, /produce-operation-aborted/);
  assert.doesNotMatch(producer, /release:administrative -- execute/);

  const executor = stepBody(
    "Execute reviewed administrative transition",
    "Upload administrative transition result",
  );
  assert.doesNotMatch(executor, /produce-state-initialized/);
  assert.doesNotMatch(executor, /produce-db-contract-activated/);
  assert.doesNotMatch(executor, /produce-operation-aborted/);
  const hashCheck = executor.indexOf(
    "$actualSubjectHash -ne $env:REQUESTED_SUBJECT_SHA256",
  );
  const execute = executor.indexOf("release:administrative -- execute");
  assert.ok(hashCheck >= 0 && execute > hashCheck);
  assert.match(executor, /--subject-sha256 \$env:REQUESTED_SUBJECT_SHA256/);
});

test("downloads reviewed administrative bytes by an exact prior run id", () => {
  for (const [downloadStep, artifact] of [
    [
      "Download reviewed state initialization subject",
      "foundation-state-initialization-subject",
    ],
    [
      "Download reviewed DB contract activation subject",
      "foundation-db-contract-activation-subject",
    ],
    [
      "Download reviewed operation abort subject",
      "foundation-operation-abort-subject",
    ],
  ]) {
    const start = workflow.indexOf(`      - name: ${downloadStep}`);
    assert.notEqual(start, -1);
    const body = workflow.slice(
      start,
      workflow.indexOf("\n      - name:", start + 1),
    );
    assert.match(body, /actions\/download-artifact@v4/);
    assert.match(body, new RegExp(`name: ${artifact}-`));
    assert.match(body, /run-id: \$\{\{ inputs\.subject_run_id \}\}/);
  }
  assert.equal(
    (workflow.match(/REQUESTED_SUBJECT_RUN_ID -eq \$env:GITHUB_RUN_ID/g) ?? [])
      .length >= 4,
    true,
  );
});
