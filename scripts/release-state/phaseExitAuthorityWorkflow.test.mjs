import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { PHASE_EXIT_EXTERNAL_AUTHORITIES } from "../lib/phase-exit-external-authority.mjs";
import { parsePhaseExitAuthorityArguments } from "./publish-phase-exit-authority-bundle.mjs";
import { RELEASE_DISPATCH_OPERATION_SCHEMAS } from "./releaseDispatchRequest.mjs";
import { RELEASE_OPERATION_REQUIRED_PREDECESSOR } from "./releaseOperationPhaseExit.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const [release, quality, retention, publisher, artifactAuthority, packageText] =
  await Promise.all(
    [
      ".github/workflows/release.yml",
      ".github/workflows/quality.yml",
      ".github/workflows/metrics-retention.yml",
      "scripts/release-state/publish-phase-exit-authority-bundle.mjs",
      "scripts/release-state/reviewedWorkflowArtifactAuthority.mjs",
      "package.json",
    ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")),
  );
const releaseWorkflow = yaml.load(release);
const packageJson = JSON.parse(packageText);

test("release accepts only a closed three-input protected dispatch", () => {
  const inputs = releaseWorkflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), [
    "source_sha",
    "operation",
    "request_json",
  ]);
  assert.ok(Object.keys(inputs).length <= 25);
  for (const operation of [
    "produce-phase-exit-authority-bundle",
    "publish-phase-exit-authority-bundle",
    "collect-startup-waf-observation",
    "collect-production-request-graph",
    "collect-csp-report-observation",
    "collect-deployed-csp-flow",
    "collect-artifact-control-store-drill",
    "collect-backup-restore-rehearsal",
    "collect-foundation-external-bindings",
    "collect-foundation-bootstrap-recovery",
    "collect-managed-device-live-stage",
    "collect-pwa-multiclient-drill",
    "attest-phase-exit",
  ]) {
    assert.ok(Object.hasOwn(RELEASE_DISPATCH_OPERATION_SCHEMAS, operation));
    assert.match(release, new RegExp(operation, "u"));
  }
  assert.match(release, /one exact target-gate collector set/u);
  assert.match(
    release,
    /phase authority inputs are forbidden for this operation/u,
  );
});

test("every closed dispatch operation reaches an executable operation-scoped path", () => {
  const jobs = Object.entries(releaseWorkflow.jobs);
  for (const operation of Object.keys(RELEASE_DISPATCH_OPERATION_SCHEMAS)) {
    const exactCondition = `inputs.operation == '${operation}'`;
    const scopedSteps = jobs.flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter(
          (step) =>
            String(step.if ?? "").includes(exactCondition) &&
            (typeof step.run === "string" || typeof step.uses === "string"),
        )
        .map((step) => `${jobName}:${step.name ?? step.uses}`),
    );
    const exclusiveJobs = jobs.filter(
      ([, job]) =>
        String(job.if ?? "").includes(exactCondition) &&
        (job.steps ?? []).some(
          (step) =>
            typeof step.run === "string" &&
            !String(step.run).includes("release-dispatch-request.mjs"),
        ) &&
        (job.steps ?? []).some(
          (step) => step.uses === "actions/upload-artifact@v4",
        ),
    );
    assert.ok(
      scopedSteps.length > 0 || exclusiveJobs.length === 1,
      `release workflow can silently succeed without handling ${operation}`,
    );
  }
});

test("release guards and pins source before repository code and scopes secrets to steps", () => {
  for (const jobName of [
    "release",
    "browser-authority",
    "managed-device-authority",
  ]) {
    const job = releaseWorkflow.jobs[jobName];
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/u);
    assert.match(job.if, /github\.ref_protected == true/u);
    assert.match(job.if, /github\.sha == inputs\.source_sha/u);
    assert.equal(
      Object.keys(job.env ?? {}).some((name) => name.includes("DATABASE_URL")),
      false,
    );
    const checkoutIndex = job.steps.findIndex(
      (step) => step.uses === "actions/checkout@v4",
    );
    const guardIndex = job.steps.findIndex((step) =>
      String(step.name ?? "").startsWith("Guard "),
    );
    const repositoryCodeIndex = job.steps.findIndex((step) =>
      String(step.run ?? "").includes("release-dispatch-request.mjs"),
    );
    assert.ok(checkoutIndex >= 0 && guardIndex > checkoutIndex);
    assert.equal(job.steps[checkoutIndex].with.ref, "${{ inputs.source_sha }}");
    assert.ok(repositoryCodeIndex > guardIndex);
  }
  assert.doesNotMatch(release, /run:\s*.*\$\{\{\s*inputs\.request_json/u);
});

test("release never promotes a caller-supplied generic candidate", () => {
  assert.doesNotMatch(release, /phase-exit-authority-candidate/u);
  assert.doesNotMatch(publisher, /collector-manifest|candidateRunId/u);
  assert.doesNotMatch(
    release,
    /actions\/download-artifact@v4[\s\S]{0,300}phase-exit-authority/u,
  );
  assert.match(
    release,
    /foundation-phase-exit-authority-package-\$\{\{ inputs\.source_sha \}\}-\$\{\{ env\.REQUESTED_TARGET_GATE \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(
    release,
    /path: \$\{\{ runner\.temp \}\}\/phase-exit-authority-produced\/phase-exit-authority-package\.json/u,
  );
  assert.match(release, /overwrite: false/u);
  assert.match(release, /include-hidden-files: false/u);
});

test("quality and retention bind fixed attempt-qualified canonical artifacts", () => {
  assert.match(
    quality,
    /node scripts\/produce-phase-exit-quality-run-source\.mjs --output/u,
  );
  assert.match(
    quality,
    /name: foundation-phase-exit-quality-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(
    quality,
    /path: \$\{\{ runner\.temp \}\}\/quality-run-source\.json/u,
  );
  assert.match(
    retention,
    /if: github\.event_name == 'schedule'[\s\S]{0,400}verify:metrics-retention -- --live\s/u,
  );
  assert.match(
    retention,
    /if: github\.event_name == 'workflow_dispatch'[\s\S]{0,500}verify:metrics-retention -- --live --output/u,
  );
  assert.match(
    retention,
    /name: foundation-phase-exit-retention-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
});

test("P0 baseline collectors publish exact attempt-bound artifacts before state initialization", () => {
  for (const [operation, command, artifact, fileName] of [
    [
      "collect-foundation-external-bindings",
      "provider:foundation-external-bindings:collect",
      "foundation-external-bindings",
      "foundation-external-bindings.json",
    ],
    [
      "collect-foundation-bootstrap-recovery",
      "provider:foundation-bootstrap-recovery:collect",
      "foundation-bootstrap-recovery",
      "foundation-bootstrap-recovery.json",
    ],
  ]) {
    assert.ok(Object.hasOwn(RELEASE_DISPATCH_OPERATION_SCHEMAS, operation));
    assert.match(
      release,
      new RegExp(`inputs\\.operation == '${operation}'`, "u"),
    );
    assert.match(release, new RegExp(`npm run ${command} --`, "u"));
    assert.match(
      release,
      new RegExp(
        `name: ${artifact}-\\$\\{\\{ inputs\\.source_sha \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`,
        "u",
      ),
    );
    assert.match(release, new RegExp(`path: .*${fileName}`, "u"));
  }
  assert.match(
    release,
    /'P0-BASELINE'[\s\S]{0,650}--external-bindings-run-id[\s\S]{0,300}--bootstrap-recovery-run-id/u,
  );
});

test("browser authorities pin toolchain and upload exact attempt-qualified files", () => {
  const browser = releaseWorkflow.jobs["browser-authority"];
  const installDependencies = browser.steps.findIndex(
    ({ name }) => name === "Install exact browser collector dependencies",
  );
  const verifyToolchain = browser.steps.findIndex(
    ({ name }) => name === "Verify exact browser collector toolchain",
  );
  const installChromium = browser.steps.findIndex(
    ({ name }) =>
      name === "Install Chromium for protected production observation",
  );
  assert.ok(
    installDependencies >= 0 &&
      verifyToolchain > installDependencies &&
      installChromium > verifyToolchain,
  );
  assert.match(
    browser.steps[verifyToolchain].run,
    /^npm run verify:toolchain\nif \(\$LASTEXITCODE -ne 0\) \{/u,
  );
  assert.match(
    browser.steps[installChromium].run,
    /^npm exec -- playwright install --with-deps chromium\nif \(\$LASTEXITCODE -ne 0\) \{/u,
  );
  for (const [prefix, fileName] of [
    ["foundation-startup-waf-observation", "startup-waf-observation.json"],
    [
      "foundation-production-request-graph",
      "production-request-graph-observation.json",
    ],
    ["foundation-csp-report-observation", "csp-report-observation.json"],
    ["foundation-deployed-csp-flow", "deployed-csp-flow-observation.json"],
  ]) {
    assert.match(
      release,
      new RegExp(
        `name: ${prefix}-\\$\\{\\{ inputs\\.source_sha \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`,
        "u",
      ),
    );
    assert.match(release, new RegExp(`path: .*${fileName}`, "u"));
  }
});

test("managed device live and strict PWA collectors are the exact two protected job operations", () => {
  const managed = releaseWorkflow.jobs["managed-device-authority"];
  assert.match(
    managed.if,
    /inputs\.operation == 'collect-managed-device-live-stage'/u,
  );
  assert.match(
    managed.if,
    /inputs\.operation == 'collect-pwa-multiclient-drill'/u,
  );
  assert.equal(
    [...managed.if.matchAll(/inputs\.operation == '[^']+'/gu)].length,
    2,
  );
  assert.deepEqual(managed["runs-on"], {
    group: "foundation-managed-devices",
    labels: ["Windows", "X64", "foundation-device", "managed", "self-hosted"],
  });
  assert.deepEqual(managed.permissions, {
    actions: "read",
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(Object.keys(managed.env), [
    "REQUESTED_SOURCE_SHA",
    "REQUESTED_OPERATION",
    "RELEASE_STATE_NAMESPACE",
  ]);
  const guard = managed.steps.find(
    ({ name }) => name === "Guard managed device authority protected source",
  );
  assert.match(
    guard.run,
    /@\('collect-managed-device-live-stage', 'collect-pwa-multiclient-drill'\) -notcontains/u,
  );
  const liveCollection = managed.steps.find(
    ({ name }) => name === "Collect exact managed device live stage",
  );
  assert.equal(
    liveCollection.if,
    "inputs.operation == 'collect-managed-device-live-stage'",
  );
  assert.match(liveCollection.run, /browser:managed-device-stage:collect/u);
  const strictCollection = managed.steps.find(
    ({ name }) => name === "Collect exact PWA multiclient drill",
  );
  assert.equal(
    strictCollection.if,
    "inputs.operation == 'collect-pwa-multiclient-drill'",
  );
  assert.match(strictCollection.run, /browser:pwa-multiclient:collect/u);
  assert.match(strictCollection.run, /pwa-multiclient-drill\.json/u);
  for (const secretName of [
    "RELEASE_STATE_DATABASE_URL",
    "RELEASE_STATE_DATABASE_CA_PEM",
    "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
  ]) {
    assert.ok(Object.hasOwn(liveCollection.env, secretName));
    assert.ok(Object.hasOwn(strictCollection.env, secretName));
    assert.equal(Object.hasOwn(managed.env ?? {}, secretName), false);
  }
  const liveUpload = managed.steps.find(
    ({ name }) => name === "Upload exact managed device live stage",
  );
  assert.equal(
    liveUpload.if,
    "inputs.operation == 'collect-managed-device-live-stage'",
  );
  assert.equal(liveUpload.uses, "actions/upload-artifact@v4");
  assert.equal(
    liveUpload.with.name,
    "foundation-managed-device-live-stage-${{ inputs.source_sha }}-${{ github.run_attempt }}",
  );
  assert.equal(
    liveUpload.with.path,
    "${{ runner.temp }}/managed-device-live-stage.json",
  );
  const strictUpload = managed.steps.find(
    ({ name }) => name === "Upload exact PWA multiclient drill",
  );
  assert.equal(
    strictUpload.if,
    "inputs.operation == 'collect-pwa-multiclient-drill'",
  );
  assert.equal(strictUpload.uses, "actions/upload-artifact@v4");
  assert.equal(
    strictUpload.with.name,
    "foundation-pwa-multiclient-drill-${{ inputs.source_sha }}-${{ github.run_attempt }}",
  );
  assert.equal(
    strictUpload.with.path,
    "${{ runner.temp }}/pwa-multiclient-drill.json",
  );
  for (const jobName of ["release", "browser-authority"]) {
    for (const operation of [
      "collect-managed-device-live-stage",
      "collect-pwa-multiclient-drill",
    ]) {
      assert.match(
        releaseWorkflow.jobs[jobName].if,
        new RegExp(`inputs\\.operation != '${operation}'`, "u"),
      );
    }
  }
  const nonManagedJobs = Object.fromEntries(
    Object.entries(releaseWorkflow.jobs).filter(
      ([name]) => name !== "managed-device-authority",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(nonManagedJobs),
    /browser:pwa-multiclient:collect|foundation-pwa-multiclient-drill-|pwa-multiclient-drill\.json/u,
  );
});

test("P1 strict receipt environment is phase-scoped and producer-only", () => {
  const validation = releaseWorkflow.jobs.release.steps.find(
    ({ name }) => name === "Validate reviewed dispatch inputs",
  ).run;
  for (const name of [
    "REQUESTED_PHASE_AUTHORITY_PWA_RECEIPT_RUN_ID",
    "REQUESTED_PHASE_AUTHORITY_PWA_RECEIPT_RUN_ATTEMPT",
  ]) {
    assert.equal(
      [...validation.matchAll(new RegExp(`\\$env:${name}`, "gu"))].length,
      2,
    );
  }
  assert.match(
    validation,
    /phase authority inputs are forbidden for this operation/u,
  );
  assert.match(
    validation,
    /phase authority publication requires an exact reviewed package/u,
  );
  const production = releaseWorkflow.jobs.release.steps.find(
    ({ name }) =>
      name ===
      "Produce reviewed phase authority package from fixed collector artifacts",
  ).run;
  assert.match(
    production,
    /'P1-PWA'[\s\S]*--pwa-receipt-run-id[\s\S]*--pwa-receipt-run-attempt[\s\S]*--managed-device-run-1-id/u,
  );
  assert.doesNotMatch(production, /'P7-IDB'[\s\S]{0,450}--pwa-receipt-run/u);
});

test("publisher binds every implemented collector through immutable reviewed authority", () => {
  for (const authority of [
    "external-bindings",
    "bootstrap-recovery-drill",
    "quality-run",
    "artifact-provider-control-store-drill",
    "physical-performance",
    "retention",
    "backup-restore-rehearsal",
    "startup-waf-observation",
    "production-request-graph",
    "csp-report-observation",
    "deployed-csp-flow",
    "pwa-multiclient-drill",
    "idb-device-compatibility",
  ]) {
    assert.match(publisher, new RegExp(`"${authority}"`, "u"));
  }
  assert.match(publisher, /collectReviewedWorkflowArtifactAuthority/u);
  assert.match(
    publisher,
    /readReviewedRemoteDbObservationProductionAuthority/u,
  );
  assert.match(publisher, /putReviewedRemoteDbObservationProductionAuthority/u);
  assert.match(publisher, /validatePhaseExitAuthorityBundle/u);
  assert.match(publisher, /publishPhaseExitAuthorityBundle/u);

  const implemented = PHASE_EXIT_EXTERNAL_AUTHORITIES.filter(
    ({ collectorImplemented }) => collectorImplemented,
  );
  assert.equal(implemented.length, 14);
  for (const authority of [
    "external-bindings",
    "bootstrap-recovery-drill",
    "artifact-provider-control-store-drill",
  ]) {
    assert.equal(
      PHASE_EXIT_EXTERNAL_AUTHORITIES.find(
        (definition) => definition.authority === authority,
      ).collectorImplemented,
      true,
    );
  }
  for (const authority of [
    "pwa-multiclient-drill",
    "idb-device-compatibility",
  ]) {
    assert.equal(
      PHASE_EXIT_EXTERNAL_AUTHORITIES.find(
        (definition) => definition.authority === authority,
      ).collectorImplemented,
      true,
    );
  }
  assert.match(publisher, /putManagedDeviceReviewedStageSetAuthority/u);
  assert.match(publisher, /readManagedDeviceReviewedStageSetAuthority/u);
  assert.match(publisher, /PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE/u);
  assert.match(publisher, /PWA_STRICT_RECEIPT_FILE_NAME/u);
  assert.match(publisher, /putPwaReviewedFormalClosureAuthority/u);
  assert.match(publisher, /readPwaReviewedFormalClosureAuthority/u);
  assert.match(publisher, /buildManagedDevicePhaseExitEvidence/u);
});

test("artifact authority verifies API digest, ZIP, exact entry, attempt, and readback", () => {
  assert.match(artifactAuthority, /\^sha256:\(\[0-9a-f\]\{64\}\)\$/u);
  assert.match(
    artifactAuthority,
    /sha256Bytes\(archiveBytes\) !== metadata\.digestSha256/u,
  );
  assert.match(artifactAuthority, /extractExactFile/u);
  assert.match(
    artifactAuthority,
    /GitHub workflow artifact archive file set is not exact/u,
  );
  assert.match(artifactAuthority, /expectedArtifactNameTemplate\.replace/u);
  assert.match(artifactAuthority, /readReviewedWorkflowRunAuthority/u);
});

test("package CLI requires the exact target-gate collector set", () => {
  const common = [
    "--namespace",
    "phase-authority-live",
    "--source-sha",
    "a".repeat(40),
    "--target-gate",
    "P0-DATA",
    "--output",
    "output.json",
  ];
  const produce = [
    "produce",
    ...common,
    "--retention-run-id",
    "102",
    "--retention-run-attempt",
    "1",
    "--backup-restore-run-id",
    "103",
    "--backup-restore-run-attempt",
    "1",
    "--startup-waf-run-id",
    "104",
    "--startup-waf-run-attempt",
    "1",
    "--remote-db-observation-sha256",
    "c".repeat(64),
    "--remote-db-production-sha256",
    "b".repeat(64),
    "--remote-db-run-id",
    "105",
    "--remote-db-run-attempt",
    "1",
  ];
  assert.equal(
    parsePhaseExitAuthorityArguments(produce).values.backupRestoreRunId,
    "103",
  );
  const baselineProduce = [
    "produce",
    ...common.map((value) => (value === "P0-DATA" ? "P0-BASELINE" : value)),
    "--external-bindings-run-id",
    "106",
    "--external-bindings-run-attempt",
    "2",
    "--bootstrap-recovery-run-id",
    "107",
    "--bootstrap-recovery-run-attempt",
    "3",
  ];
  assert.deepEqual(parsePhaseExitAuthorityArguments(baselineProduce).values, {
    namespace: "phase-authority-live",
    sourceSha: "a".repeat(40),
    targetGate: "P0-BASELINE",
    outputPath: "output.json",
    externalBindingsRunId: "106",
    externalBindingsRunAttempt: "2",
    bootstrapRecoveryRunId: "107",
    bootstrapRecoveryRunAttempt: "3",
  });
  const artifactProduce = [
    "produce",
    ...common.map((value) => (value === "P0-DATA" ? "P0-ARTIFACT" : value)),
    "--artifact-drill-run-id",
    "108",
    "--artifact-drill-run-attempt",
    "4",
  ];
  assert.deepEqual(parsePhaseExitAuthorityArguments(artifactProduce).values, {
    namespace: "phase-authority-live",
    sourceSha: "a".repeat(40),
    targetGate: "P0-ARTIFACT",
    outputPath: "output.json",
    artifactDrillRunId: "108",
    artifactDrillRunAttempt: "4",
  });
  const managedSelectors = [
    "--managed-device-run-1-id",
    "110",
    "--managed-device-run-1-attempt",
    "1",
    "--managed-device-run-2-id",
    "111",
    "--managed-device-run-2-attempt",
    "2",
    "--managed-device-run-3-id",
    "112",
    "--managed-device-run-3-attempt",
    "3",
  ];
  const pwaProduce = [
    "produce",
    ...common.map((value) => (value === "P0-DATA" ? "P1-PWA" : value)),
    "--pwa-receipt-run-id",
    "109",
    "--pwa-receipt-run-attempt",
    "4",
    ...managedSelectors,
  ];
  assert.deepEqual(parsePhaseExitAuthorityArguments(pwaProduce).values, {
    namespace: "phase-authority-live",
    sourceSha: "a".repeat(40),
    targetGate: "P1-PWA",
    outputPath: "output.json",
    pwaReceiptRunId: "109",
    pwaReceiptRunAttempt: "4",
    managedDeviceRun1Id: "110",
    managedDeviceRun1Attempt: "1",
    managedDeviceRun2Id: "111",
    managedDeviceRun2Attempt: "2",
    managedDeviceRun3Id: "112",
    managedDeviceRun3Attempt: "3",
  });
  const pwaWithoutStrictReceipt = [
    "produce",
    ...common.map((value) => (value === "P0-DATA" ? "P1-PWA" : value)),
    ...managedSelectors,
  ];
  assert.throws(
    () => parsePhaseExitAuthorityArguments(pwaWithoutStrictReceipt),
    /argument|requires/u,
  );
  const idbProduce = [
    "produce",
    ...common.map((value) => (value === "P0-DATA" ? "P7-IDB" : value)),
    ...managedSelectors,
  ];
  assert.deepEqual(parsePhaseExitAuthorityArguments(idbProduce).values, {
    namespace: "phase-authority-live",
    sourceSha: "a".repeat(40),
    targetGate: "P7-IDB",
    outputPath: "output.json",
    managedDeviceRun1Id: "110",
    managedDeviceRun1Attempt: "1",
    managedDeviceRun2Id: "111",
    managedDeviceRun2Attempt: "2",
    managedDeviceRun3Id: "112",
    managedDeviceRun3Attempt: "3",
  });
  for (const invalid of [
    [...idbProduce, "--pwa-receipt-run-id", "109"],
    [...pwaProduce, "--client-kind", "installed-pwa"],
  ]) {
    assert.throws(
      () => parsePhaseExitAuthorityArguments(invalid),
      /argument|requires/u,
    );
  }
  for (const invalid of [
    produce.slice(0, -2),
    [...produce, "--caller-approved", "true"],
    [...produce, "--quality-run-id", "106"],
    produce.map((value) => (value === "b".repeat(64) ? "c".repeat(63) : value)),
    ["produce", "--", ...common],
    [...baselineProduce, "--quality-run-id", "108"],
    [...artifactProduce, "--quality-run-id", "109"],
  ]) {
    assert.throws(
      () => parsePhaseExitAuthorityArguments(invalid),
      /argument|requires|identity/u,
    );
  }
});

test("workflow verifies every non-exempt predecessor before operation steps", () => {
  const steps = releaseWorkflow.jobs.release.steps;
  const normalizeIndex = steps.findIndex(
    ({ name }) => name === "Normalize closed release dispatch request",
  );
  const predecessorIndex = steps.findIndex(
    ({ name }) => name === "Require immutable formal predecessor exit",
  );
  const predecessor = steps[predecessorIndex];
  const firstOperationIndex = steps.findIndex(
    ({ name }) => name === "Produce authoritative artifact build requirements",
  );
  assert.ok(
    normalizeIndex >= 0 &&
      predecessorIndex > normalizeIndex &&
      firstOperationIndex > predecessorIndex,
  );
  assert.match(predecessor.run, /release:verify-operation-predecessor/u);
  assert.match(predecessor.run, /--candidate-gate/u);
  for (const [operation, required] of Object.entries(
    RELEASE_OPERATION_REQUIRED_PREDECESSOR,
  )) {
    if (required === null) {
      assert.doesNotMatch(predecessor.if, new RegExp(`'${operation}'`, "u"));
    } else {
      assert.match(predecessor.if, new RegExp(`'${operation}'`, "u"));
    }
  }
  const artifactDrill = steps.find(
    ({ name }) =>
      name === "Collect non-promotable artifact/provider/control-store drill",
  );
  assert.equal(
    Object.hasOwn(artifactDrill.env, "RELEASE_STATE_DATABASE_URL"),
    false,
  );
});

test("foundation suite contains every formal collector contract", () => {
  const command = packageJson.scripts["test:foundation"];
  for (const testPath of [
    "scripts/browser/production-request-graph.test.mjs",
    "scripts/browser/csp-report-observation.test.mjs",
    "scripts/browser/deployed-csp-flow.test.mjs",
    "scripts/provider/startup-waf-observation.test.mjs",
    "scripts/provider/foundation-external-bindings.test.mjs",
    "scripts/provider/foundation-bootstrap-recovery.test.mjs",
    "scripts/provider/artifact-control-store-drill.test.mjs",
    "scripts/release-state/releaseDispatchRequest.test.mjs",
  ]) {
    assert.match(command, new RegExp(testPath.replaceAll("/", "\\/"), "u"));
  }
});
