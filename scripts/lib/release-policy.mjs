import { sha256Json } from "./canonical-json.mjs";

export const RELEASE_DIMENSION_KEYS = Object.freeze([
  "releaseRole",
  "pwaLifecycle",
  "cssDelivery",
  "cspMode",
  "xlsxExecution",
  "listEngine",
  "listDefault",
  "persistenceArchitecture",
]);

const hasExactKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

export const assertDimensionObject = (policy, dimensions) => {
  if (!hasExactKeys(dimensions, RELEASE_DIMENSION_KEYS)) {
    throw new Error(
      "Release dimensions must contain the exact dimension key set",
    );
  }
  for (const key of RELEASE_DIMENSION_KEYS) {
    const allowed = policy.dimensions?.[key];
    if (!Array.isArray(allowed) || !allowed.includes(dimensions[key])) {
      throw new Error(
        `Unsupported release dimension ${key}=${dimensions[key]}`,
      );
    }
  }
  if (dimensions.releaseRole === "standard") {
    if (
      dimensions.xlsxExecution === "disabled" ||
      dimensions.listEngine === "disabled" ||
      dimensions.listDefault === "disabled"
    ) {
      throw new Error(
        "Standard variants cannot disable XLSX or list dimensions",
      );
    }
  }
  if (
    dimensions.xlsxExecution === "disabled" ||
    dimensions.listEngine === "disabled" ||
    dimensions.listDefault === "disabled"
  ) {
    if (
      dimensions.releaseRole !== "containment" ||
      dimensions.pwaLifecycle !== "prompt-close-all-v1" ||
      dimensions.xlsxExecution !== "disabled" ||
      dimensions.listEngine !== "disabled" ||
      dimensions.listDefault !== "disabled"
    ) {
      throw new Error(
        "Disabled dimensions require the prompt-close-all containment projection",
      );
    }
  }
  return dimensions;
};

export const computeVariantId = (policy, dimensions) => {
  assertDimensionObject(policy, dimensions);
  return sha256Json(dimensions);
};

export const projectContainmentDimensions = (policy, standardDimensions) => {
  assertDimensionObject(policy, standardDimensions);
  if (standardDimensions.releaseRole !== "standard") {
    throw new Error("Containment projection requires a standard variant");
  }
  const projection =
    policy.containmentProjection?.[standardDimensions.pwaLifecycle];
  if (!projection) {
    throw new Error(
      `Missing containment projection for ${standardDimensions.pwaLifecycle}`,
    );
  }
  const containment = {
    ...standardDimensions,
    ...projection,
  };
  assertDimensionObject(policy, containment);
  return containment;
};

export const countBehaviorDimensionChanges = (before, after) =>
  RELEASE_DIMENSION_KEYS.filter(
    (key) => key !== "releaseRole" && before[key] !== after[key],
  ).length;

export const verifyPhaseSequence = (policy) => {
  let current = { ...policy.initialStandard };
  assertDimensionObject(policy, current);
  for (const phase of policy.phaseSequence ?? []) {
    if (phase.change === null) continue;
    if (
      phase.change === undefined ||
      typeof phase.change !== "object" ||
      Array.isArray(phase.change)
    ) {
      throw new Error(`Invalid phase change at ${phase.gate}`);
    }
    const next = { ...current, ...phase.change };
    assertDimensionObject(policy, next);
    if (countBehaviorDimensionChanges(current, next) !== 1) {
      throw new Error(
        `${phase.gate} must change exactly one behavior dimension`,
      );
    }
    current = next;
  }
  const target = policy.targetStandard;
  assertDimensionObject(policy, target);
  if (RELEASE_DIMENSION_KEYS.some((key) => current[key] !== target[key])) {
    throw new Error("Phase sequence does not reach targetStandard");
  }
  return true;
};
