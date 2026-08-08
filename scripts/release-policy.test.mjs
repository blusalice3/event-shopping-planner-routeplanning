import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  computeVariantId,
  projectContainmentDimensions,
  verifyPhaseSequence,
} from "./lib/release-policy.mjs";
import {
  assertReleaseBuildLauncherBinding,
  bindReleaseBuildLauncher,
  createReleaseBuildInput,
  releaseBuildInputEnvironment,
  resolveReleaseBuildInput,
} from "./lib/release-build-input.mjs";

const policy = JSON.parse(
  await readFile(new URL("../config/release-variants.json", import.meta.url)),
);

test("release phases change at most one behavior dimension and reach target", () => {
  assert.equal(verifyPhaseSequence(policy), true);
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
