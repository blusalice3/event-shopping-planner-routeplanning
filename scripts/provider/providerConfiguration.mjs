import { sha256Json } from "../lib/canonical-json.mjs";

const VOLATILE_OBSERVATION_KEYS = new Set(["observedAt", "evidenceReceipts"]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const providerConfigurationProjection = (observation) => {
  if (!isRecord(observation)) {
    throw new Error("Provider observation must be an object");
  }
  const projection = Object.fromEntries(
    Object.entries(observation).filter(
      ([key]) => !VOLATILE_OBSERVATION_KEYS.has(key),
    ),
  );
  if (Object.keys(projection).length === 0) {
    throw new Error("Provider observation has no configuration fields");
  }
  return projection;
};

export const providerConfigurationHash = (observation) =>
  sha256Json(providerConfigurationProjection(observation));
