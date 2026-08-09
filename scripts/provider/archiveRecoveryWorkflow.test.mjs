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
  const startMarker = `      - name: ${name}`;
  const endMarker = `      - name: ${nextName}`;
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `workflow step is absent: ${name}`);
  assert.notEqual(end, -1, `workflow step boundary is absent: ${nextName}`);
  return workflow.slice(start, end);
};

test("separates archive recovery subject production from reviewed mutation", () => {
  assert.match(
    workflow,
    /inputs\.operation == 'produce-archive-recovery-subject'/,
  );
  assert.match(
    workflow,
    /inputs\.operation == 'execute-reviewed-archive-recovery'/,
  );
  assert.doesNotMatch(workflow, /- execute-archive-recovery\s*$/m);

  const producer = stepBody(
    "Produce authoritative archive recovery subject",
    "Upload authoritative archive recovery subject",
  );
  assert.match(producer, /release:execute-archive-recovery -- materialize/);
  assert.match(producer, /release:deploy-prebuilt/);
  assert.match(
    producer,
    /'run', 'release:execute-archive-recovery', '--', 'subject'/,
  );
  assert.doesNotMatch(producer, /release:promote-prepared/);
  assert.doesNotMatch(producer, /record-promotion/);

  const executor = stepBody(
    "Execute reviewed archive recovery",
    "Upload archive recovery execution and reconcile material",
  );
  assert.doesNotMatch(executor, /--', 'subject'/);
  assert.doesNotMatch(executor, /release:deploy-prebuilt/);
  assert.doesNotMatch(executor, /-- materialize/);
  const hashCheck = executor.indexOf(
    "$actualSubjectHash -ne $env:REQUESTED_SUBJECT_SHA256",
  );
  const prepare = executor.indexOf(
    "release:execute-archive-recovery -- prepare",
  );
  assert.ok(hashCheck >= 0 && prepare > hashCheck);
  assert.match(executor, /--subject-sha256 \$env:REQUESTED_SUBJECT_SHA256/);
  assert.match(executor, /release:promote-prepared/);
  assert.match(executor, /record-assignment/);
  assert.match(executor, /record-promotion/);
});

test("downloads the exact prior subject artifact and rejects same-run review", () => {
  const download = stepBody(
    "Download reviewed archive recovery subject",
    "Execute reviewed archive recovery",
  );
  assert.match(download, /actions\/download-artifact@v4/);
  assert.match(
    download,
    /name: foundation-archive-recovery-subject-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(download, /run-id: \$\{\{ env\.REQUESTED_SUBJECT_RUN_ID \}\}/);

  assert.match(workflow, /REQUESTED_SUBJECT_RUN_ID -eq \$env:GITHUB_RUN_ID/);
  assert.match(
    workflow,
    /archive recovery subject must come from a prior workflow run/,
  );
});
