import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RELEASE_DISPATCH_OPERATION_SCHEMAS } from "./releaseDispatchRequest.mjs";

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
    assert.ok(Object.hasOwn(RELEASE_DISPATCH_OPERATION_SCHEMAS, operation));
  }

  const producer = stepBody(
    "Produce authoritative administrative transition subject",
    "Upload state initialization subject",
  );
  assert.match(producer, /produce-state-initialized/);
  assert.match(producer, /produce-db-contract-activated/);
  assert.equal(
    (
      producer.match(
        /--db-observation-sha256 \$env:REQUESTED_DB_OBSERVATION_SHA256/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (
      producer.match(
        /--db-observation-production-sha256 \$env:REQUESTED_DB_OBSERVATION_PRODUCTION_SHA256/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (
      producer.match(
        /--db-observation-run-id \$env:REQUESTED_DB_OBSERVATION_RUN_ID/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (
      producer.match(
        /--db-observation-run-attempt \$env:REQUESTED_DB_OBSERVATION_RUN_ATTEMPT/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(producer, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  for (const gate of ["BASELINE", "TOOLCHAIN", "ARTIFACT"]) {
    assert.match(
      producer,
      new RegExp(
        `--p0-${gate.toLowerCase()}-attestation-sha256 \\$env:REQUESTED_P0_${gate}_ATTESTATION_SHA256`,
        "u",
      ),
    );
  }
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
  assert.match(
    executor,
    /APPROVAL_GITHUB_TOKEN: \$\{\{ secrets\.FOUNDATION_APPROVAL_GITHUB_TOKEN \}\}/,
  );
  assert.doesNotMatch(executor, /^\s+GITHUB_TOKEN:/mu);
  assert.match(executor, /--subject-sha256 \$env:REQUESTED_SUBJECT_SHA256/);
  for (const operation of [
    "produce-state-initialization-subject",
    "produce-db-contract-activation-subject",
  ]) {
    const required = RELEASE_DISPATCH_OPERATION_SCHEMAS[operation].required;
    for (const field of [
      "db_observation_sha256",
      "db_observation_production_sha256",
      "db_observation_run_id",
      "db_observation_run_attempt",
    ]) {
      assert.ok(required.includes(field), `${operation}/${field}`);
    }
  }
  for (const field of [
    "p0_baseline_attestation_sha256",
    "p0_toolchain_attestation_sha256",
    "p0_artifact_attestation_sha256",
  ]) {
    assert.ok(
      RELEASE_DISPATCH_OPERATION_SCHEMAS[
        "produce-state-initialization-subject"
      ].required.includes(field),
      field,
    );
  }
  assert.equal(
    (
      workflow.match(
        /\$env:REQUESTED_DB_OBSERVATION_SHA256 -notmatch \$sha256Pattern/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (
      workflow.match(
        /\$env:REQUESTED_DB_OBSERVATION_PRODUCTION_SHA256 -notmatch \$sha256Pattern/g,
      ) ?? []
    ).length,
    3,
  );
});

test("collects remote DB authority only in a protected producer run", () => {
  assert.ok(
    Object.hasOwn(
      RELEASE_DISPATCH_OPERATION_SCHEMAS,
      "collect-remote-db-observation",
    ),
  );
  const jobEnvironment = workflow.slice(
    workflow.indexOf("jobs:"),
    workflow.indexOf("    steps:"),
  );
  assert.doesNotMatch(
    jobEnvironment,
    /DB_COMPATIBILITY_OBSERVER_(?:DATABASE_URL|CA_PEM)/,
  );

  const collector = stepBody(
    "Collect and store protected remote DB observation",
    "Upload protected remote DB observation",
  );
  assert.match(
    collector,
    /DB_COMPATIBILITY_OBSERVER_DATABASE_URL: \$\{\{ secrets\.DB_COMPATIBILITY_OBSERVER_DATABASE_URL \}\}/,
  );
  assert.match(
    collector,
    /DB_COMPATIBILITY_OBSERVER_CA_PEM: \$\{\{ secrets\.DB_COMPATIBILITY_OBSERVER_CA_PEM \}\}/,
  );
  assert.match(
    collector,
    /npm run db:observe:protected -- --namespace \$env:RELEASE_STATE_NAMESPACE/,
  );
  assert.match(collector, /--provider-observation \$providerObservationPath/);
  assert.match(collector, /--authority-output \$authorityPath/);
  assert.match(collector, /--output \$observationPath/);
  assert.match(collector, /Remote DB production authority SHA-256/);
  assert.match(collector, /authority\.mediaTypes\.providerObservation/);
  assert.match(collector, /'producerOidc', 'production'/);
  assert.doesNotMatch(collector, /REQUESTED_DB_OBSERVATION_SHA256/);

  const upload = stepBody(
    "Upload protected remote DB observation",
    "Collect protected pre-promotion evidence source",
  );
  assert.match(upload, /foundation-remote-db-observation-/);
  assert.match(upload, /remote-db-observation-output/);
  assert.match(workflow, /id-token: write/);
  assert.match(
    workflow,
    /REQUESTED_DB_OBSERVATION_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );
  assert.match(
    workflow,
    /remote DB observation authority inputs are forbidden for this operation/,
  );
  assert.doesNotMatch(workflow, /db_observation_(?:json|status):/);
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
    assert.match(body, /run-id: \$\{\{ env\.REQUESTED_SUBJECT_RUN_ID \}\}/);
  }
  assert.equal(
    (workflow.match(/REQUESTED_SUBJECT_RUN_ID -eq \$env:GITHUB_RUN_ID/g) ?? [])
      .length >= 4,
    true,
  );
});
