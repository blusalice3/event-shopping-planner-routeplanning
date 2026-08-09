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

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const verifyMinimumSafetyFloorChange = (
  policy,
  phase,
  activatedSafetyFloorKeys,
) => {
  const change = phase.minimumSafetyFloorChange;
  if (change === undefined) return;
  if (!isRecord(policy.minimumSafetyFloors)) {
    throw new Error("Release policy minimumSafetyFloors must be an object");
  }
  if (!isRecord(change) || Object.keys(change).length === 0) {
    throw new Error(
      `${phase.gate} minimumSafetyFloorChange must be a non-empty object`,
    );
  }
  if (phase.change !== null) {
    throw new Error(
      `${phase.gate} cannot change a behavior dimension and a minimum safety floor together`,
    );
  }
  for (const [key, value] of Object.entries(change)) {
    if (!Object.hasOwn(policy.minimumSafetyFloors, key)) {
      throw new Error(
        `${phase.gate} changes unknown minimum safety floor ${key}`,
      );
    }
    if (policy.minimumSafetyFloors[key] !== value) {
      throw new Error(
        `${phase.gate} minimum safety floor ${key} does not reach the policy target`,
      );
    }
    if (activatedSafetyFloorKeys.has(key)) {
      throw new Error(
        `${phase.gate} activates minimum safety floor ${key} more than once`,
      );
    }
    activatedSafetyFloorKeys.add(key);
  }
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
  const activatedSafetyFloorKeys = new Set();
  assertDimensionObject(policy, current);
  for (const phase of policy.phaseSequence ?? []) {
    verifyMinimumSafetyFloorChange(policy, phase, activatedSafetyFloorKeys);
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
