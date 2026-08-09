import assert from "node:assert/strict";
import test from "node:test";

import { createManagedDeviceVerifierEnvironment } from "./run-managed-device-transition.mjs";

const base = {
  KEEP: "bound",
  ESP_PROMPT_CLOSE_DRILL: "poison",
  ESP_ROLLBACK_TARGET_CAPABILITY: "poison",
  ESP_ROLLBACK_ACTIVATION: "poison",
  ESP_EXPECTED_TARGET_BUILD_ID: "poison",
  ESP_ALLOW_DIRTY_BUILD: "true",
};
const sourceA = "a".repeat(40);
const sourceB = "b".repeat(40);
const evidence = (pwaLifecycle) => ({
  indexSha256: "1".repeat(64),
  serviceWorkerSha256: "2".repeat(64),
  mainAsset: "/assets/app.js",
  pwaLifecycle,
});
const common = {
  baseEnvironment: base,
  browserPath: "C:\\Chrome\\chrome.exe",
  fromSource: sourceA,
  origin: "http://127.0.0.1:4173/",
  profileDir: "C:\\Profile",
  targetSource: sourceB,
};

test("managed rollback requires capability and derives target activation lifecycle", () => {
  const automatic = createManagedDeviceVerifierEnvironment({
    ...common,
    evidence: evidence("legacy-auto-update-v1"),
    mode: "rollback",
  });
  assert.equal(automatic.KEEP, "bound");
  assert.equal(automatic.ESP_EXPECTED_TARGET_BUILD_ID, sourceB);
  assert.equal(automatic.ESP_ROLLBACK_TARGET_CAPABILITY, "required");
  assert.equal(automatic.ESP_ROLLBACK_ACTIVATION, "auto-takeover");
  assert.equal(automatic.ESP_PROMPT_CLOSE_DRILL, undefined);
  assert.equal(automatic.ESP_ALLOW_DIRTY_BUILD, undefined);

  const natural = createManagedDeviceVerifierEnvironment({
    ...common,
    evidence: evidence("prompt-close-all-v1"),
    mode: "rollback",
  });
  assert.equal(natural.ESP_ROLLBACK_ACTIVATION, "natural-after-client-release");
});

test("managed forward derives prompt operation from the source lifecycle", () => {
  for (const [sourcePwaLifecycle, expected] of [
    ["legacy-auto-update-v1", "disabled"],
    ["prompt-close-all-v1", "required"],
  ]) {
    const environment = createManagedDeviceVerifierEnvironment({
      ...common,
      evidence: evidence("prompt-close-all-v1"),
      mode: "forward",
      sourcePwaLifecycle,
    });
    assert.equal(environment.ESP_EXPECTED_TARGET_BUILD_ID, sourceB);
    assert.equal(environment.ESP_PROMPT_CLOSE_DRILL, expected);
    assert.equal(environment.ESP_ROLLBACK_TARGET_CAPABILITY, undefined);
    assert.equal(environment.ESP_ROLLBACK_ACTIVATION, undefined);
  }
});

test("managed verifier environment rejects unknown lifecycle identities", () => {
  assert.throws(
    () =>
      createManagedDeviceVerifierEnvironment({
        ...common,
        evidence: evidence("unknown"),
        mode: "rollback",
      }),
    /target PWA lifecycle is invalid/,
  );
  assert.throws(
    () =>
      createManagedDeviceVerifierEnvironment({
        ...common,
        evidence: evidence("prompt-close-all-v1"),
        mode: "forward",
        sourcePwaLifecycle: "unknown",
      }),
    /source PWA lifecycle is invalid/,
  );
});
