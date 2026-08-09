import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  computeVariantId,
  projectContainmentDimensions,
  verifyPhaseSequence,
} from "./lib/release-policy.mjs";
import {
  ARTIFACT_DRILL_BUILD_PURPOSE,
  assertReleaseBuildLauncherBinding,
  bindReleaseBuildLauncher,
  createReleaseBuildInput,
  POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  RELEASE_BUILD_PURPOSE_ENV,
  releaseBuildInputEnvironment,
  resolveReleaseBuildInput,
} from "./lib/release-build-input.mjs";

const policy = JSON.parse(
  await readFile(new URL("../config/release-variants.json", import.meta.url)),
);
const architecturePolicy = JSON.parse(
  await readFile(
    new URL("../config/architecture-policy.json", import.meta.url),
  ),
);

test("forbids the removed bootstrap entry and keeps the outer agent closed", async () => {
  const staleBootstrapRule =
    architecturePolicy.forbiddenProductionPathRules.find(
      ({ id }) => id === "no-stale-bootstrap-entry",
    );
  assert.ok(staleBootstrapRule);
  const staleBootstrapPattern = new RegExp(staleBootstrapRule.pathRegex);
  assert.equal(staleBootstrapPattern.test("src/bootstrap.ts"), true);
  assert.equal(
    staleBootstrapPattern.test("src/pwa/recovery/serviceWorkerBootstrap.ts"),
    false,
  );
  await assert.rejects(
    access(new URL("../src/" + "bootstrap.ts", import.meta.url)),
  );

  const outerAgentRule = architecturePolicy.entryGraphRules.find(
    ({ id }) => id === "outer-agent-closed-graph",
  );
  assert.equal(
    new RegExp(outerAgentRule.forbiddenTargetRegex).test("src/bootstrap.ts"),
    true,
  );
});

test("feature UI persistence is constrained to typed adapters", () => {
  const blockDetectionRule = architecturePolicy.forbiddenImportRules.find(
    ({ id }) => id === "ui-direct-block-detection-storage",
  );
  assert.ok(blockDetectionRule);
  assert.equal(
    new RegExp(blockDetectionRule.sourceRegex).test(
      "src/features/app-shell/components/AppOverlayLayer.tsx",
    ) &&
      new RegExp(blockDetectionRule.targetRegex).test(
        "src/utils/blockDetectionSettingsStorage.ts",
      ),
    true,
  );

  const browserStorageRule = architecturePolicy.forbiddenTextRules.find(
    ({ id }) => id === "ui-no-direct-browser-storage-mutation",
  );
  assert.ok(browserStorageRule);
  const sourcePattern = new RegExp(browserStorageRule.sourceRegex);
  const textPattern = new RegExp(browserStorageRule.pattern, "u");
  assert.equal(
    sourcePattern.test(
      "src/features/space-navigation/hooks/useSpaceNavigatorSettings.ts",
    ) && textPattern.test("window.localStorage.setItem(key, value)"),
    true,
  );
  assert.equal(
    sourcePattern.test(
      "src/features/shopping-list/preference/localStorageListRendererPreferenceAdapter.ts",
    ),
    false,
  );
});

test("release phases change at most one behavior dimension and reach target", () => {
  assert.equal(verifyPhaseSequence(policy), true);
});

test("release phases bind minimum safety-floor activation to the policy target", () => {
  const wrongTarget = structuredClone(policy);
  wrongTarget.phaseSequence.find(
    ({ gate }) => gate === "P8-CLEAN",
  ).minimumSafetyFloorChange.styleSrcAttr = "unsafe-inline";
  assert.throws(
    () => verifyPhaseSequence(wrongTarget),
    /does not reach the policy target/,
  );

  const mixedChange = structuredClone(policy);
  mixedChange.phaseSequence.find(({ gate }) => gate === "P8-CLEAN").change = {
    cspMode: "enforced",
  };
  assert.throws(
    () => verifyPhaseSequence(mixedChange),
    /cannot change a behavior dimension and a minimum safety floor together/,
  );

  const unknownFloor = structuredClone(policy);
  unknownFloor.phaseSequence.find(
    ({ gate }) => gate === "P8-CLEAN",
  ).minimumSafetyFloorChange.unknownFloor = "strict";
  assert.throws(
    () => verifyPhaseSequence(unknownFloor),
    /changes unknown minimum safety floor unknownFloor/,
  );

  const duplicateActivation = structuredClone(policy);
  duplicateActivation.phaseSequence.push({
    gate: "P9-INVALID",
    change: null,
    minimumSafetyFloorChange: { styleSrcAttr: "none" },
  });
  assert.throws(
    () => verifyPhaseSequence(duplicateActivation),
    /activates minimum safety floor styleSrcAttr more than once/,
  );
});

test("nonproduction QA build purpose is CLI-bound and nonpromotable", () => {
  const sourceSha = "e".repeat(40);
  const dbFingerprint = "f".repeat(64);
  const input = resolveReleaseBuildInput({
    policy,
    environment: {},
    gitSourceSha: sourceSha,
    gitSourceState: "dirty",
    cliBuildPurpose: "qa-xlsx-main",
    defaultDbFingerprint: dbFingerprint,
    requireCliForNonProduction: true,
  });
  assert.equal(input.buildPurpose, "qa-xlsx-main");
  assert.equal(input.nonPromotable, true);
  const environment = bindReleaseBuildLauncher(input, policy);
  assert.equal(environment[RELEASE_BUILD_PURPOSE_ENV], "qa-xlsx-main");
  const rebound = resolveReleaseBuildInput({
    policy,
    environment,
    gitSourceSha: sourceSha,
    gitSourceState: "dirty",
    defaultDbFingerprint: dbFingerprint,
  });
  assert.equal(
    assertReleaseBuildLauncherBinding(rebound, policy, "qa-xlsx-main"),
    rebound,
  );
  assert.throws(
    () =>
      resolveReleaseBuildInput({
        policy,
        environment,
        gitSourceSha: sourceSha,
        gitSourceState: "dirty",
        defaultDbFingerprint: dbFingerprint,
        requireCliForNonProduction: true,
      }),
    /must originate from the matching CLI option/,
  );
});

test("nonproduction QA build purpose rejects containment", () => {
  assert.throws(
    () =>
      createReleaseBuildInput({
        policy,
        sourceSha: "1".repeat(40),
        sourceState: "clean",
        releaseRole: "containment",
        dimensions: projectContainmentDimensions(policy, policy.targetStandard),
        dbFingerprint: "2".repeat(64),
        buildPurpose: "qa-list-force-full",
      }),
    /must use the standard role/,
  );
});

test("policy activation QA build purpose permits an exact role pair", () => {
  const sourceSha = "3".repeat(40);
  const dbFingerprint = "4".repeat(64);
  const standardDimensions = { ...policy.targetStandard };
  const containmentDimensions = projectContainmentDimensions(
    policy,
    standardDimensions,
  );
  const inputs = [
    createReleaseBuildInput({
      policy,
      sourceSha,
      sourceState: "clean",
      releaseRole: "standard",
      dimensions: standardDimensions,
      dbFingerprint,
      buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    }),
    createReleaseBuildInput({
      policy,
      sourceSha,
      sourceState: "clean",
      releaseRole: "containment",
      dimensions: containmentDimensions,
      dbFingerprint,
      buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    }),
  ];
  assert.deepEqual(
    inputs.map(({ releaseRole, buildPurpose, nonPromotable }) => ({
      releaseRole,
      buildPurpose,
      nonPromotable,
    })),
    [
      {
        releaseRole: "standard",
        buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
        nonPromotable: true,
      },
      {
        releaseRole: "containment",
        buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
        nonPromotable: true,
      },
    ],
  );
});

test("artifact drill purpose permits only a closed nonpromotable role pair", () => {
  const sourceSha = "5".repeat(40);
  const dbFingerprint = "6".repeat(64);
  const standardDimensions = { ...policy.initialStandard };
  const containmentDimensions = projectContainmentDimensions(
    policy,
    standardDimensions,
  );
  const inputs = [standardDimensions, containmentDimensions].map((dimensions) =>
    createReleaseBuildInput({
      policy,
      sourceSha,
      sourceState: "clean",
      releaseRole: dimensions.releaseRole,
      dimensions,
      dbFingerprint,
      buildPurpose: ARTIFACT_DRILL_BUILD_PURPOSE,
    }),
  );
  assert.deepEqual(
    inputs.map(({ releaseRole, buildPurpose, nonPromotable }) => ({
      releaseRole,
      buildPurpose,
      nonPromotable,
    })),
    [
      {
        releaseRole: "standard",
        buildPurpose: ARTIFACT_DRILL_BUILD_PURPOSE,
        nonPromotable: true,
      },
      {
        releaseRole: "containment",
        buildPurpose: ARTIFACT_DRILL_BUILD_PURPOSE,
        nonPromotable: true,
      },
    ],
  );
  assert.throws(
    () =>
      createReleaseBuildInput({
        policy,
        sourceSha,
        sourceState: "clean",
        releaseRole: "standard",
        dimensions: standardDimensions,
        dbFingerprint,
        buildPurpose: "non-promotable-unknown-purpose",
      }),
    /buildPurpose is invalid/,
  );
});

test("variant IDs bind the exact canonical dimensions", () => {
  const standard = policy.targetStandard;
  const containment = projectContainmentDimensions(policy, standard);
  assert.match(computeVariantId(policy, standard), /^[0-9a-f]{64}$/);
  assert.match(computeVariantId(policy, containment), /^[0-9a-f]{64}$/);
  assert.notEqual(
    computeVariantId(policy, standard),
    computeVariantId(policy, containment),
  );
});

test("prompt-close-all containment has no XLSX or list execution", () => {
  const containment = projectContainmentDimensions(
    policy,
    policy.targetStandard,
  );
  assert.equal(containment.releaseRole, "containment");
  assert.equal(containment.xlsxExecution, "disabled");
  assert.equal(containment.listEngine, "disabled");
  assert.equal(containment.listDefault, "disabled");
});

test("canonical build input preserves an arbitrary phase candidate", () => {
  const dimensions = {
    ...policy.initialStandard,
    pwaLifecycle: "prompt-close-all-v1",
  };
  const sourceSha = "a".repeat(40);
  const dbFingerprint = "b".repeat(64);
  const input = createReleaseBuildInput({
    policy,
    sourceSha,
    sourceState: "clean",
    releaseRole: "standard",
    dimensions,
    dbFingerprint,
  });
  const environment = releaseBuildInputEnvironment(input, policy);
  const resolved = resolveReleaseBuildInput({
    policy,
    environment,
    gitSourceSha: sourceSha,
    gitSourceState: "clean",
    defaultDbFingerprint: dbFingerprint,
  });
  assert.deepEqual(resolved, input);
  assert.equal(resolved.variantId, computeVariantId(policy, dimensions));
});

test("canonical build input rejects CLI and environment conflicts", () => {
  const sourceSha = "c".repeat(40);
  const input = createReleaseBuildInput({
    policy,
    sourceSha,
    sourceState: "clean",
    releaseRole: "standard",
    dimensions: policy.targetStandard,
    dbFingerprint: "d".repeat(64),
  });
  const environment = {
    ...releaseBuildInputEnvironment(input, policy),
    FOUNDATION_RELEASE_ROLE: "containment",
  };
  assert.throws(
    () =>
      resolveReleaseBuildInput({
        policy,
        environment,
        gitSourceSha: sourceSha,
        gitSourceState: "clean",
        cliRole: "standard",
      }),
    /conflicts with FOUNDATION_RELEASE_BUILD_INPUT_JSON/,
  );
});

test("release workflow fails immediately after every native PowerShell command", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const lines = workflow.split("\n");
  const nativeCommandPattern =
    /^\s*(?:\$\w+\s*=\s*)?(?:(?:run:\s+)|(?:&\s+))?(?:npm|node|git)\s/u;
  const embeddedNativeCommandPattern = /\(\s*(?:&\s+)?(?:npm|node|git)\s/u;
  const unguarded = [];
  let nativeCommandCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (embeddedNativeCommandPattern.test(line)) {
      unguarded.push({
        line: index + 1,
        reason:
          "native command is embedded where its exit code cannot be checked",
        source: line.trim(),
      });
      continue;
    }
    if (!nativeCommandPattern.test(line)) {
      continue;
    }

    nativeCommandCount += 1;
    let commandEnd = index;
    while (
      lines[commandEnd]?.trimEnd().endsWith("`") &&
      commandEnd + 1 < lines.length
    ) {
      commandEnd += 1;
    }
    let guardLine = commandEnd + 1;
    while (guardLine < lines.length && lines[guardLine].trim() === "") {
      guardLine += 1;
    }
    if (lines[guardLine]?.trim() !== "if ($LASTEXITCODE -ne 0) {") {
      unguarded.push({
        line: index + 1,
        reason: "missing immediate $LASTEXITCODE guard",
        source: line.trim(),
      });
    }
    index = commandEnd;
  }

  assert.ok(
    nativeCommandCount >= 56,
    `expected the protected workflow native-command surface, found ${nativeCommandCount}`,
  );
  assert.deepEqual(unguarded, []);
});
