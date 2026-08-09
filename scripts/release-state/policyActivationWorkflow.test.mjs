import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NORMAL_POLICY_ACTIVATION_GATES,
  POLICY_ACTIVATION_GATES,
} from "./phaseGates.mjs";
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

test("connects every policy gate through QA, closure, reviewed subject, and CAS", () => {
  for (const operation of [
    "produce-artifact-build-requirements",
    "produce-policy-activation-qa-build-requirements",
    "build-policy-activation-qa",
    "produce-policy-activation-qa-package",
    "produce-policy-activation-qa-execution-subject",
    "execute-policy-activation-qa",
    "produce-policy-activation-closure",
    "produce-policy-activation-subject",
    "activate-policy",
    "activate-policy-floor",
  ]) {
    assert.ok(Object.hasOwn(RELEASE_DISPATCH_OPERATION_SCHEMAS, operation));
  }
  assert.deepEqual(
    POLICY_ACTIVATION_GATES.filter((gate) => gate !== "P8-CLEAN"),
    NORMAL_POLICY_ACTIVATION_GATES,
  );

  const subject = stepBody(
    "Produce authoritative generic policy activation subject",
    "Upload authoritative generic policy activation subject",
  );
  for (const flag of [
    "--proposed-policy-sha256",
    "--active-policy-sha256",
    "--closure-bundle-sha256",
    "--source-sha",
  ]) {
    assert.match(subject, new RegExp(flag));
  }
  assert.doesNotMatch(subject, /minimum-safety-floors/);

  const activation = stepBody(
    "Activate the reviewed generic policy transition",
    "Upload policy activation result",
  );
  const hashCheck = activation.indexOf(
    "$actualSubjectHash -ne $env:REQUESTED_SUBJECT_SHA256",
  );
  const execution = activation.indexOf(
    "release:lifecycle -- $activationCommand",
  );
  assert.ok(hashCheck >= 0 && execution > hashCheck);
  assert.match(activation, /'activate-policy-floor'/);
  assert.match(activation, /'activate-policy'/);
});

test("builds a nonpromotable pair and rejects it from the production package path", () => {
  const qa = stepBody(
    "Build immutable nonpromotable policy QA package",
    "Upload immutable nonpromotable policy QA package",
  );
  assert.match(qa, /policy-activation-qa-package/);
  assert.match(qa, /candidate package source differs/);
  assert.match(qa, /non-promotable-policy-activation-qa/);
  assert.match(qa, /REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_SHA256/);
  assert.match(qa, /artifact-manifest\.json/);
  assert.match(qa, /artifact\.zip/);
  assert.match(qa, /Get-FileHash -LiteralPath \$objectPath/);
  assert.doesNotMatch(qa, /artifact:build|deploy:prebuilt|prepare-and-promote/);

  const validationStart = workflow.indexOf(
    "            'produce-policy-activation-qa-package' {",
  );
  const validationEnd = workflow.indexOf(
    "            'produce-policy-activation-qa-execution-subject' {",
    validationStart,
  );
  assert.ok(validationStart >= 0 && validationEnd > validationStart);
  const packageValidation = workflow.slice(validationStart, validationEnd);
  for (const gate of NORMAL_POLICY_ACTIVATION_GATES) {
    assert.match(packageValidation, new RegExp(`'${gate}'`));
  }
  assert.doesNotMatch(packageValidation, /P8-CLEAN/);

  const closure = stepBody(
    "Produce authoritative policy activation closure",
    "Upload authoritative policy activation closure",
  );
  assert.match(closure, /--qa-execution-sha256/);
  assert.doesNotMatch(
    closure,
    /--(?:proposed-policy|active-policy|approval-policy|qa-package)-sha256|qa-standard-deployment|qa-companion-deployment|rollback-drill|containment-drill/,
  );
  const closureValidationStart = workflow.indexOf(
    "            'produce-policy-activation-closure' {",
  );
  const closureValidationEnd = workflow.indexOf(
    "            'produce-policy-activation-subject' {",
    closureValidationStart,
  );
  assert.ok(
    closureValidationStart >= 0 &&
      closureValidationEnd > closureValidationStart,
  );
  const closureValidation = workflow.slice(
    closureValidationStart,
    closureValidationEnd,
  );
  assert.match(closureValidation, /REQUESTED_POLICY_QA_EXECUTION_SHA256/);
  assert.match(closureValidation, /\$hasQaRun -ne \$hasQaHash/);
  assert.match(closureValidation, /live P8 floor-only branch/);
  assert.doesNotMatch(
    closureValidation,
    /REQUESTED_(?:PROPOSED_RELEASE_POLICY|ACTIVE_RELEASE_POLICY|APPROVAL_POLICY|POLICY_QA_PACKAGE)_SHA256/,
  );
});

test("derives every source-hardened build from a distinct reviewed requirements run", () => {
  const producer = stepBody(
    "Produce authoritative artifact build requirements",
    "Upload production artifact build requirements",
  );
  assert.match(producer, /artifact-build-requirements/);
  assert.match(producer, /policy-activation-qa-build-requirements/);
  assert.match(producer, /--proposed-policy-sha256/);
  assert.match(producer, /--active-policy-sha256/);
  assert.match(producer, /--target-gate \$env:REQUESTED_CANDIDATE_GATE/);
  assert.doesNotMatch(producer, /standard-dimensions/);

  const productionDownload = stepBody(
    "Download reviewed production artifact build requirements",
    "Download reviewed Policy QA artifact build requirements",
  );
  assert.match(
    productionDownload,
    /run-id: \$\{\{ env\.REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_RUN_ID \}\}/,
  );
  const build = stepBody(
    "Build and verify reviewed immutable package",
    "Upload verified immutable package",
  );
  const hashCheck = build.indexOf(
    "$actualRequirementsHash -ne $env:REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_SHA256",
  );
  const execution = build.indexOf("npm run artifact:build");
  assert.ok(hashCheck >= 0 && execution > hashCheck);
  assert.match(build, /--build-requirements/);
  assert.match(build, /--build-requirements-sha256/);
  assert.doesNotMatch(build, /--standard-dimensions/);
  assert.match(
    workflow,
    /foundation-release-\$\{\{ inputs\.source_sha \}\}-\$\{\{ env\.REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_SHA256 \}\}/,
  );
  assert.match(
    workflow,
    /foundation-policy-qa-build-\$\{\{ env\.REQUESTED_POLICY_TARGET_SOURCE_SHA \}\}-\$\{\{ env\.REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_SHA256 \}\}/,
  );
  assert.match(
    workflow,
    /REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );
});

test("runs Policy QA and closure from two distinct reviewed prior-run artifacts", () => {
  const subjectDownload = stepBody(
    "Download reviewed Policy QA execution subject",
    "Execute reviewed nonproduction Policy QA and recovery drills",
  );
  assert.match(
    subjectDownload,
    /run-id: \$\{\{ env\.REQUESTED_POLICY_QA_EXECUTION_SUBJECT_RUN_ID \}\}/,
  );
  const execution = stepBody(
    "Execute reviewed nonproduction Policy QA and recovery drills",
    "Upload reviewed Policy QA execution bundle",
  );
  assert.match(execution, /REQUESTED_POLICY_QA_EXECUTION_SUBJECT_SHA256/);
  assert.match(execution, /release:execute-policy-activation-qa/);
  assert.doesNotMatch(execution, /--prod/);
  const executionDownload = stepBody(
    "Download reviewed Policy QA execution bundle",
    "Produce authoritative policy activation closure",
  );
  assert.match(
    executionDownload,
    /run-id: \$\{\{ env\.REQUESTED_POLICY_QA_EXECUTION_RUN_ID \}\}/,
  );
  assert.match(
    executionDownload,
    /env\.REQUESTED_POLICY_QA_EXECUTION_RUN_ID != ''/,
  );
  assert.match(
    workflow,
    /REQUESTED_POLICY_QA_EXECUTION_SUBJECT_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );
  assert.match(
    workflow,
    /REQUESTED_POLICY_QA_EXECUTION_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );
});

test("routes the P8 floor-only chain through the formal predecessor verifier", () => {
  const predecessor = stepBody(
    "Require immutable formal predecessor exit",
    "Verify protected source identity",
  );
  for (const operation of [
    "produce-policy-activation-closure",
    "produce-policy-activation-subject",
    "activate-policy-floor",
  ]) {
    assert.match(predecessor, new RegExp(operation));
  }
  assert.match(predecessor, /release:verify-operation-predecessor/);

  const closure = stepBody(
    "Produce authoritative policy activation closure",
    "Upload authoritative policy activation closure",
  );
  assert.match(
    closure,
    /if \(-not \[string\]::IsNullOrEmpty\(\$env:REQUESTED_POLICY_QA_EXECUTION_RUN_ID\)\)/,
  );
  assert.match(closure, /\$producerArguments \+= @\('--output'/);
  assert.doesNotMatch(closure, /accepted-gate|minimum-safety-floor/);
});

test("downloads the exact prior reviewed subject before policy mutation", () => {
  const download = stepBody(
    "Download reviewed policy activation subject",
    "Activate the reviewed generic policy transition",
  );
  assert.match(download, /actions\/download-artifact@v4/);
  assert.match(
    download,
    /name: foundation-policy-activation-subject-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(download, /run-id: \$\{\{ env\.REQUESTED_SUBJECT_RUN_ID \}\}/);
  assert.equal(
    (workflow.match(/REQUESTED_SUBJECT_RUN_ID -eq \$env:GITHUB_RUN_ID/g) ?? [])
      .length >= 5,
    true,
  );
});
