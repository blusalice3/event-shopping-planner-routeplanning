const OS_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
]);
const VERCEL_ENVIRONMENT_KEYS = Object.freeze([
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
]);
const VERCEL_BUILD_ENVIRONMENT_KEYS = new Set([
  "FOUNDATION_ARTIFACT_BUILD_REQUIREMENTS_SHA256",
  "FOUNDATION_CANONICAL_BUILD_PURPOSE",
  "FOUNDATION_OUTER_AGENT_BUNDLE_PATH",
  "FOUNDATION_OUTER_AGENT_GRAPH_PATH",
  "FOUNDATION_RELEASE_BUILD_INPUT_JSON",
  "FOUNDATION_RELEASE_DB_FINGERPRINT",
  "FOUNDATION_RELEASE_DIMENSIONS_JSON",
  "FOUNDATION_RELEASE_ROLE",
  "FOUNDATION_RELEASE_SOURCE_SHA",
  "FOUNDATION_RELEASE_SOURCE_STATE",
  "FOUNDATION_RELEASE_VARIANT_ID",
  "VERCEL",
  "VERCEL_GIT_COMMIT_SHA",
  "VITE_APP_BUILD_ID",
  "VITE_PERSISTENCE_LEGACY_CLEANUP",
  "VITE_PERSISTENCE_RELEASE_CHANNEL",
]);

const findEnvironmentValue = (environment, expectedKey) => {
  const matches = Object.keys(environment).filter(
    (key) => key.toLowerCase() === expectedKey.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new Error(`Vercel command environment has ambiguous ${expectedKey}`);
  }
  return matches.length === 1 ? environment[matches[0]] : undefined;
};

const assertEnvironmentRecord = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
};

export const buildClosedVercelCommandEnvironment = (
  environment,
  { additionalEnvironment = {} } = {},
) => {
  assertEnvironmentRecord(environment, "Vercel command environment");
  assertEnvironmentRecord(
    additionalEnvironment,
    "Vercel build additional environment",
  );
  const result = {};
  for (const key of OS_ENVIRONMENT_KEYS) {
    const value = findEnvironmentValue(environment, key);
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  for (const key of VERCEL_ENVIRONMENT_KEYS) {
    const value = findEnvironmentValue(environment, key);
    if (typeof value !== "string" || value.length < 3) {
      throw new Error(`Vercel command authority is absent: ${key}`);
    }
    result[key] = value;
  }
  for (const [key, value] of Object.entries(additionalEnvironment)) {
    if (
      !VERCEL_BUILD_ENVIRONMENT_KEYS.has(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 1024 * 1024
    ) {
      throw new Error(`Vercel build environment binding is invalid: ${key}`);
    }
    result[key] = value;
  }
  return Object.freeze(result);
};
