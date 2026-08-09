import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACCEPTANCE_PERFORMANCE_REQUIREMENTS } from "../lib/performance-evidence-identity.mjs";

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

test("derives the accepted gate and performance requirement from Release State", () => {
  assert.match(workflow, /^ {6}acceptance_requirements_run_id:$/m);
  assert.match(workflow, /^ {6}acceptance_requirements_sha256:$/m);
  assert.match(workflow, /^ {6}performance_evidence_run_id:$/m);
  assert.match(workflow, /^ {6}performance_evidence_sha256:$/m);
  assert.match(workflow, /^ {6}performance_raw_samples_run_id:$/m);
  assert.match(workflow, /^ {6}performance_raw_samples_sha256:$/m);
  assert.doesNotMatch(workflow, /^ {6}accepted_gate:$/m);

  const resolver = stepBody(
    "Verify reviewed authoritative acceptance requirements",
    "Download reviewed acceptance evidence",
  );
  assert.match(
    resolver,
    /release:lifecycle -- describe-acceptance-requirements/,
  );
  assert.match(
    resolver,
    /\$reviewedRequirementsHash -ne \$env:REQUESTED_ACCEPTANCE_REQUIREMENTS_SHA256/,
  );
  assert.match(
    resolver,
    /\$currentRequirementsHash -ne \$env:REQUESTED_ACCEPTANCE_REQUIREMENTS_SHA256/,
  );
  assert.match(resolver, /\$requirements\.performanceEvidenceKind -eq 'none'/);
  assert.match(resolver, /performance evidence is forbidden for accepted gate/);
  assert.match(
    resolver,
    /requires reviewed performance evidence from a prior run/,
  );
  assert.match(
    resolver,
    /performance_kind=\$\(\$requirements\.performanceEvidenceKind\)/,
  );
  assert.match(resolver, /accepted_gate=\$\(\$requirements\.acceptedGate\)/);

  const ownDownload = stepBody(
    "Download reviewed own-gate performance evidence",
    "Download reviewed inherited performance closure",
  );
  assert.match(
    ownDownload,
    /performance_kind == 'own-gate-performance-evidence\/v1'/,
  );
  assert.match(ownDownload, /actions\/download-artifact@v4/);
  assert.match(
    ownDownload,
    /name: foundation-performance-own-gate-evidence-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    ownDownload,
    /run-id: \$\{\{ inputs\.performance_evidence_run_id \}\}/,
  );
  const inheritedDownload = stepBody(
    "Download reviewed inherited performance closure",
    "Produce canonical acceptance inputs from reviewed sources",
  );
  assert.match(
    inheritedDownload,
    /performance_kind == 'performance-inherited-closure\/v1'/,
  );
  assert.match(inheritedDownload, /actions\/download-artifact@v4/);
  assert.match(
    inheritedDownload,
    /name: foundation-performance-inherited-closure-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    inheritedDownload,
    /run-id: \$\{\{ inputs\.performance_evidence_run_id \}\}/,
  );
  assert.ok(
    workflow.indexOf("Verify reviewed authoritative acceptance requirements") <
      workflow.indexOf("Download reviewed own-gate performance evidence"),
  );
});

test("requires a separately reviewed authoritative requirements artifact", () => {
  assert.match(workflow, /^ {10}- produce-acceptance-requirements$/m);
  const producer = stepBody(
    "Produce authoritative acceptance requirements",
    "Upload authoritative acceptance requirements",
  );
  assert.match(
    producer,
    /release:lifecycle -- describe-acceptance-requirements/,
  );
  assert.match(producer, /acceptance-requirements\.json/);

  const download = stepBody(
    "Download reviewed authoritative acceptance requirements",
    "Verify reviewed authoritative acceptance requirements",
  );
  assert.match(download, /actions\/download-artifact@v4/);
  assert.match(
    download,
    /name: foundation-acceptance-requirements-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    download,
    /run-id: \$\{\{ inputs\.acceptance_requirements_run_id \}\}/,
  );
  assert.equal(
    (
      workflow.match(
        /REQUESTED_ACCEPTANCE_REQUIREMENTS_RUN_ID -eq \$env:GITHUB_RUN_ID/g,
      ) ?? []
    ).length,
    2,
  );
});

test("rejects same-run and overlapping acceptance artifact producers", () => {
  const validation = stepBody("Validate reviewed dispatch inputs", "Pin npm");

  assert.equal(
    (
      validation.match(
        /REQUESTED_ACCEPTANCE_EVIDENCE_RUN_ID -eq \$env:GITHUB_RUN_ID/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (
      validation.match(
        /REQUESTED_ACCEPTANCE_INPUTS_RUN_ID -eq \$env:GITHUB_RUN_ID/g,
      ) ?? []
    ).length,
    1,
  );
  assert.match(
    validation,
    /'produce-acceptance-inputs' \{[\s\S]*acceptance input artifacts must come from distinct producer runs/,
  );
  assert.match(
    validation,
    /'produce-acceptance-inputs' \{[\s\S]*REQUESTED_ACCEPTANCE_COLLECTOR_RECEIPT_SHA256 -notmatch \$sha256Pattern/,
  );
  assert.match(
    validation,
    /'accept-standard' \{[\s\S]*acceptance artifacts must come from distinct producer runs/,
  );
  assert.equal(
    (validation.match(/\$producerRunIds \| Select-Object -Unique/g) ?? [])
      .length,
    2,
  );
});

test("forbids dummy performance evidence for non-performance acceptance gates", () => {
  for (const gate of [
    "P1-PWA",
    "P2A-LOCAL",
    "P2B-REPORT",
    "P4-CSP",
    "P6-APP",
    "P7-IDB",
  ]) {
    assert.equal(ACCEPTANCE_PERFORMANCE_REQUIREMENTS[gate], null, gate);
  }
  assert.equal(
    ACCEPTANCE_PERFORMANCE_REQUIREMENTS["P0-RELEASE"],
    "P0-TOOLCHAIN",
  );
  assert.equal(
    ACCEPTANCE_PERFORMANCE_REQUIREMENTS["P8-CLEAN"],
    "performance-inherited-closure/v1",
  );

  const resolver = stepBody(
    "Verify reviewed authoritative acceptance requirements",
    "Download reviewed acceptance evidence",
  );
  assert.match(resolver, /if \(\$hasPerformanceRun -or \$hasPerformanceHash\)/);
  assert.match(
    resolver,
    /performanceEvidenceKind -notin @\([\s\S]*own-gate-performance-evidence\/v1[\s\S]*performance-inherited-closure\/v1/,
  );
});

test("binds reviewed performance bytes conditionally into preparation and acceptance", () => {
  const producer = stepBody(
    "Produce canonical acceptance inputs from reviewed sources",
    "Upload canonical acceptance inputs",
  );
  const executor = stepBody(
    "Accept the standard release after fresh observation",
    "Upload acceptance result",
  );

  assert.match(producer, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(producer, /--collector-receipt \$collectorReceiptPath/);
  assert.match(
    producer,
    /--collector-receipt-sha256 \$env:REQUESTED_ACCEPTANCE_COLLECTOR_RECEIPT_SHA256/,
  );

  for (const body of [producer, executor]) {
    assert.match(
      body,
      /REQUIRED_PERFORMANCE_KIND: \$\{\{ steps\.acceptance_requirements\.outputs\.performance_kind \}\}/,
    );
    assert.match(
      body,
      /\$performanceInputPath = Join-Path \$env:RUNNER_TEMP 'performance-input'/,
    );
    assert.match(
      body,
      /\$performancePath = Join-Path \$performanceInputPath 'performance-evidence\.json'/,
    );
    assert.match(
      body,
      /performance evidence exists for a gate that forbids it/,
    );
    assert.match(
      body,
      /if \(\$env:REQUIRED_PERFORMANCE_KIND -ne 'none'\) \{[\s\S]*'--performance-evidence'[\s\S]*'--performance-evidence-sha256'/,
    );
    assert.match(
      body,
      /Get-FileHash -LiteralPath \$performancePath -Algorithm SHA256/,
    );
    assert.match(
      body,
      /\$actualPerformanceHash -ne \$env:REQUESTED_PERFORMANCE_EVIDENCE_SHA256/,
    );
    assert.doesNotMatch(
      body,
      /collect-performance-samples|build-performance-evidence/,
    );
  }
});

test("binds each acceptance collector continuation to reviewed run authority", () => {
  const collector = stepBody(
    "Collect immutable acceptance authority and production samples",
    "Upload appendable acceptance collector chain",
  );

  assert.match(collector, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(collector, /'--prior-receipt'/);
  assert.match(
    collector,
    /'--prior-receipt-sha256',[\s\S]*REQUESTED_ACCEPTANCE_COLLECTOR_RECEIPT_SHA256/,
  );
});

test("builds the P8 inherited closure from four immutable accepted events", () => {
  assert.match(workflow, /^ {10}- produce-performance-inherited-closure$/m);
  for (const input of [
    "p0_accepted_event_sha256",
    "p3_accepted_event_sha256",
    "p5d_accepted_event_sha256",
    "p5e_accepted_event_sha256",
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}:$`, "m"));
  }
  assert.match(workflow, /acceptedEventHashes \| Select-Object -Unique/);

  const builder = stepBody(
    "Build authoritative inherited performance closure",
    "Upload authoritative inherited performance closure",
  );
  assert.match(builder, /performance:inherited-closure:build/);
  assert.match(
    builder,
    /--closure-id "perf-closure-\$env:REQUESTED_SOURCE_SHA"/,
  );
  assert.match(builder, /--p0-accepted-event-sha256/);
  assert.match(builder, /--p3-accepted-event-sha256/);
  assert.match(builder, /--p5d-accepted-event-sha256/);
  assert.match(builder, /--p5e-accepted-event-sha256/);
  assert.match(builder, /performance-evidence\.json/);

  const upload = stepBody(
    "Upload authoritative inherited performance closure",
    "Download reviewed prior acceptance collector chain",
  );
  assert.match(
    upload,
    /name: foundation-performance-inherited-closure-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    upload,
    /performance-closure-output\/performance-evidence\.json/,
  );
});

test("produces own-gate evidence only from reviewed raw samples and live requirements", () => {
  assert.match(workflow, /^ {10}- produce-own-gate-performance-evidence$/m);
  const validation = stepBody("Validate reviewed dispatch inputs", "Pin npm");
  assert.match(
    validation,
    /'produce-own-gate-performance-evidence' \{[\s\S]*requires only reviewed raw samples from a distinct prior run/,
  );
  assert.match(
    validation,
    /REQUESTED_PERFORMANCE_RAW_SAMPLES_RUN_ID -eq \$env:GITHUB_RUN_ID/,
  );

  const download = stepBody(
    "Download reviewed raw performance samples",
    "Produce authoritative own-gate performance evidence",
  );
  assert.match(download, /actions\/download-artifact@v4/);
  assert.match(
    download,
    /name: foundation-performance-raw-samples-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    download,
    /run-id: \$\{\{ inputs\.performance_raw_samples_run_id \}\}/,
  );

  const producer = stepBody(
    "Produce authoritative own-gate performance evidence",
    "Upload authoritative own-gate performance evidence",
  );
  assert.match(producer, /performance:own-gate-evidence:produce/);
  assert.match(producer, /--raw-samples-run-id/);
  assert.match(producer, /REQUESTED_PERFORMANCE_RAW_SAMPLES_SHA256/);
  assert.match(
    producer,
    /reviewed raw performance artifact file set is not closed/,
  );
  assert.match(
    producer,
    /own-gate performance evidence artifact file set is not closed/,
  );
  assert.match(producer, /if \(\$LASTEXITCODE -ne 0\)/);
  assert.doesNotMatch(producer, /--gate|--input-envelope|--evidence /);

  const upload = stepBody(
    "Upload authoritative own-gate performance evidence",
    "Build authoritative inherited performance closure",
  );
  assert.match(
    upload,
    /name: foundation-performance-own-gate-evidence-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(
    upload,
    /performance-own-gate-output\/performance-evidence\.json/,
  );
});
