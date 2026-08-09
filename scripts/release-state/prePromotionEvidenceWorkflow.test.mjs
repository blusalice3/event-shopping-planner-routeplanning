import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
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

test("keeps the protected release workflow valid YAML", () => {
  const document = yaml.load(workflow);
  assert.equal(document.name, "Foundation release");
  assert.ok(document.jobs.release.steps.length > 0);
});

test("requires exact reviewed authority from three distinct prior runs", () => {
  const schema =
    RELEASE_DISPATCH_OPERATION_SCHEMAS["collect-prepromotion-evidence-source"];
  assert.ok(schema);
  for (const input of [
    "artifact_build_requirements_run_id",
    "artifact_build_requirements_sha256",
    "standard_deployment_run_id",
    "standard_deployment_binding_sha256",
    "containment_deployment_run_id",
    "containment_deployment_binding_sha256",
  ]) {
    assert.ok(schema.required.includes(input), input);
  }

  const validation = stepBody("Validate reviewed dispatch inputs", "Pin npm");
  assert.match(
    validation,
    /'collect-prepromotion-evidence-source' \{[\s\S]*\$authorityRunIds = @\(/,
  );
  assert.match(
    validation,
    /REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_RUN_ID,[\s\S]*REQUESTED_STANDARD_DEPLOYMENT_RUN_ID,[\s\S]*REQUESTED_CONTAINMENT_DEPLOYMENT_RUN_ID/,
  );
  assert.match(validation, /\$_ -eq \$env:GITHUB_RUN_ID/);
  assert.match(
    validation,
    /@\(\$authorityRunIds \| Select-Object -Unique\)\.Count -ne 3/,
  );
  assert.match(
    validation,
    /REQUESTED_STANDARD_DEPLOYMENT_BINDING_SHA256 -eq \$env:REQUESTED_CONTAINMENT_DEPLOYMENT_BINDING_SHA256/,
  );
  assert.match(
    validation,
    /reviewed deployment binding hashes are forbidden for this operation/,
  );
  assert.match(
    validation,
    /REQUESTED_PREPROMOTION_EVIDENCE_SOURCE_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );
});

test("downloads exact reviewed requirements and both immutable deployment bindings", () => {
  const requirements = stepBody(
    "Download reviewed production artifact build requirements",
    "Download reviewed standard deployment for pre-promotion collection",
  );
  assert.match(requirements, /collect-prepromotion-evidence-source/);
  assert.match(
    requirements,
    /name: foundation-artifact-build-requirements-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    requirements,
    /run-id: \$\{\{ env\.REQUESTED_ARTIFACT_BUILD_REQUIREMENTS_RUN_ID \}\}/,
  );

  for (const [role, runInput] of [
    ["standard", "standard_deployment_run_id"],
    ["containment", "containment_deployment_run_id"],
  ]) {
    const current =
      role === "standard"
        ? "Download reviewed standard deployment for pre-promotion collection"
        : "Download reviewed containment deployment for pre-promotion collection";
    const next =
      role === "standard"
        ? "Download reviewed containment deployment for pre-promotion collection"
        : "Download reviewed Policy QA artifact build requirements";
    const download = stepBody(current, next);
    assert.match(download, /actions\/download-artifact@v4/);
    assert.match(
      download,
      new RegExp(
        `name: foundation-deployment-\\$\\{\\{ inputs\\.source_sha \\}\\}-${role}`,
      ),
    );
    assert.match(
      download,
      new RegExp(
        `run-id: \\$\\{\\{ env\\.REQUESTED_${runInput.toUpperCase()} \\}\\}`,
      ),
    );
  }
});

test("collects fresh provider state and runs only the protected collector CLI", () => {
  const provider = stepBody(
    "Collect authoritative provider configuration",
    "Verify source and foundation policies",
  );
  assert.match(provider, /collect-prepromotion-evidence-source/);
  assert.match(provider, /npm run provider:observe/);

  const policy = stepBody(
    "Verify source and foundation policies",
    "Collect protected pre-promotion evidence source",
  );
  assert.match(policy, /collect-prepromotion-evidence-source/);
  assert.match(policy, /verify:provider-policy -- --require-configured/);

  const collector = stepBody(
    "Collect protected pre-promotion evidence source",
    "Upload protected pre-promotion evidence source",
  );
  assert.match(collector, /Assert-ExactFlatArtifactFiles/);
  assert.match(
    collector,
    /@\('deployment-binding\.json', 'prebuilt-deployment-receipt\.json'\)/,
  );
  const requirementsHash = collector.indexOf("$actualRequirementsHash -ne");
  const standardHash = collector.indexOf("$actualStandardBindingHash -ne");
  const containmentHash = collector.indexOf(
    "$actualContainmentBindingHash -ne",
  );
  const execution = collector.indexOf(
    "npm run release:collect-prepromotion-evidence",
  );
  assert.ok(
    requirementsHash >= 0 &&
      standardHash > requirementsHash &&
      containmentHash > standardHash &&
      execution > containmentHash,
  );
  for (const flag of [
    "--namespace",
    "--source-sha",
    "--run-id",
    "--standard-binding",
    "--containment-binding",
    "--build-requirements",
    "--build-requirements-sha256",
    "--provider-observation",
    "--provider-observation-sha256",
    "--output",
  ]) {
    assert.match(collector, new RegExp(flag));
  }
  assert.doesNotMatch(collector, /--executions|--result|exitCode/);
  assert.match(
    collector,
    /npm run release:collect-prepromotion-evidence[\s\S]*if \(\$LASTEXITCODE -ne 0\) \{/,
  );
  assert.match(collector, /VERCEL_ORG_ID/);
  assert.match(collector, /VERCEL_PROJECT_ID/);
  assert.match(collector, /VERCEL_TOKEN/);
});

test("publishes one source file for a separately reviewed producer run", () => {
  const upload = stepBody(
    "Upload protected pre-promotion evidence source",
    "Build and verify reviewed immutable package",
  );
  assert.match(upload, /actions\/upload-artifact@v4/);
  assert.match(
    upload,
    /name: foundation-prepromotion-evidence-source-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    upload,
    /prepromotion-evidence-source-output\/pre-promotion-evidence-source\.json/,
  );

  const reviewedDownload = stepBody(
    "Download reviewed pre-promotion evidence source",
    "Produce canonical pre-promotion evidence set",
  );
  assert.match(
    reviewedDownload,
    /run-id: \$\{\{ env\.REQUESTED_PREPROMOTION_EVIDENCE_SOURCE_RUN_ID \}\}/,
  );
  const producer = stepBody(
    "Produce canonical pre-promotion evidence set",
    "Upload canonical pre-promotion evidence set",
  );
  assert.match(producer, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  const reviewedHash = producer.indexOf(
    "$actualSourceHash -ne $env:REQUESTED_PREPROMOTION_EVIDENCE_SOURCE_SHA256",
  );
  const produce = producer.indexOf(
    "npm run release:produce-input -- prepromotion-evidence-set",
  );
  assert.ok(reviewedHash >= 0 && produce > reviewedHash);
  assert.ok(
    workflow.indexOf("Upload protected pre-promotion evidence source") <
      workflow.indexOf("Download reviewed pre-promotion evidence source"),
  );

  for (const preservedOperation of [
    "produce-own-gate-performance-evidence",
    "produce-acceptance-requirements",
    "produce-acceptance-inputs",
    "accept-standard",
  ]) {
    assert.ok(
      Object.hasOwn(RELEASE_DISPATCH_OPERATION_SCHEMAS, preservedOperation),
      preservedOperation,
    );
  }
});
