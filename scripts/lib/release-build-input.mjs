import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Json,
} from "./canonical-json.mjs";
import {
  assertDimensionObject,
  computeVariantId,
  projectContainmentDimensions,
} from "./release-policy.mjs";

export const RELEASE_BUILD_INPUT_ENV = "FOUNDATION_RELEASE_BUILD_INPUT_JSON";
export const RELEASE_BUILD_PURPOSES = Object.freeze([
  "production",
  "qa-xlsx-main",
  "qa-list-force-full",
]);

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_ROLES = new Set(["standard", "containment"]);
const SOURCE_STATES = new Set(["clean", "dirty", "provider-immutable"]);
const BUILD_PURPOSES = new Set(RELEASE_BUILD_PURPOSES);
const BUILD_INPUT_KEYS = Object.freeze([
  "schemaVersion",
  "sourceSha",
  "sourceState",
  "releaseRole",
  "variantId",
  "dimensions",
  "dbFingerprint",
  "buildPurpose",
  "nonPromotable",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (value, expectedKeys, label) => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an unexpected property set`);
  }
};

const assertSha = (value, pattern, label) => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const sameCanonicalValue = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const selectEnvironmentBinding = (environment, names, label) => {
  const bindings = names
    .filter((name) => environment[name] !== undefined)
    .map((name) => [name, String(environment[name])]);
  if (bindings.length === 0) return null;
  const [, selected] = bindings[0];
  for (const [name, value] of bindings.slice(1)) {
    if (value !== selected) {
      throw new Error(
        `${label} conflicts between ${bindings[0][0]} and ${name}`,
      );
    }
  }
  return selected;
};

const parseCanonicalDimensions = (serialized, label) => {
  const dimensions = parseJsonStrict(serialized, label);
  if (!canonicalJsonBytes(dimensions).equals(Buffer.from(serialized, "utf8"))) {
    throw new Error(`${label} must use exact canonical JSON bytes`);
  }
  return dimensions;
};

export const assertReleaseBuildInput = (input, policy) => {
  assertExactKeys(input, BUILD_INPUT_KEYS, "ReleaseBuildInput");
  if (input.schemaVersion !== 1) {
    throw new Error("ReleaseBuildInput schemaVersion must be 1");
  }
  assertSha(input.sourceSha, SOURCE_SHA_PATTERN, "ReleaseBuildInput.sourceSha");
  if (!SOURCE_STATES.has(input.sourceState)) {
    throw new Error("ReleaseBuildInput.sourceState is invalid");
  }
  if (!RELEASE_ROLES.has(input.releaseRole)) {
    throw new Error("ReleaseBuildInput.releaseRole is invalid");
  }
  assertDimensionObject(policy, input.dimensions);
  if (input.dimensions.releaseRole !== input.releaseRole) {
    throw new Error("ReleaseBuildInput role and dimensions differ");
  }
  const expectedVariantId = computeVariantId(policy, input.dimensions);
  assertSha(input.variantId, SHA256_PATTERN, "ReleaseBuildInput.variantId");
  if (input.variantId !== expectedVariantId) {
    throw new Error("ReleaseBuildInput variantId differs from dimensions");
  }
  assertSha(
    input.dbFingerprint,
    SHA256_PATTERN,
    "ReleaseBuildInput.dbFingerprint",
  );
  if (!BUILD_PURPOSES.has(input.buildPurpose)) {
    throw new Error("ReleaseBuildInput.buildPurpose is invalid");
  }
  if (
    typeof input.nonPromotable !== "boolean" ||
    input.nonPromotable !== (input.buildPurpose !== "production")
  ) {
    throw new Error(
      "ReleaseBuildInput.nonPromotable differs from buildPurpose",
    );
  }
  if (input.nonPromotable && input.releaseRole !== "standard") {
    throw new Error("Nonproduction QA builds must use the standard role");
  }
  return input;
};

export const createReleaseBuildInput = ({
  policy,
  sourceSha,
  sourceState,
  releaseRole,
  dimensions,
  variantId = computeVariantId(policy, dimensions),
  dbFingerprint,
  buildPurpose = "production",
}) =>
  assertReleaseBuildInput(
    {
      schemaVersion: 1,
      sourceSha,
      sourceState,
      releaseRole,
      variantId,
      dimensions,
      dbFingerprint,
      buildPurpose,
      nonPromotable: buildPurpose !== "production",
    },
    policy,
  );

export const serializeReleaseBuildInput = (input, policy) =>
  canonicalJsonBytes(assertReleaseBuildInput(input, policy)).toString("utf8");

export const parseReleaseBuildInput = (serialized, policy) => {
  const input = parseJsonStrict(serialized, RELEASE_BUILD_INPUT_ENV);
  if (!canonicalJsonBytes(input).equals(Buffer.from(serialized, "utf8"))) {
    throw new Error(
      `${RELEASE_BUILD_INPUT_ENV} must use exact canonical JSON bytes`,
    );
  }
  return assertReleaseBuildInput(input, policy);
};

const assertScalarConflict = (canonicalValue, suppliedValue, label) => {
  if (
    canonicalValue !== null &&
    suppliedValue !== null &&
    suppliedValue !== canonicalValue
  ) {
    throw new Error(`${label} conflicts with ${RELEASE_BUILD_INPUT_ENV}`);
  }
};

const assertObjectConflict = (canonicalValue, suppliedValue, label) => {
  if (
    canonicalValue !== null &&
    suppliedValue !== null &&
    !sameCanonicalValue(suppliedValue, canonicalValue)
  ) {
    throw new Error(`${label} conflicts with ${RELEASE_BUILD_INPUT_ENV}`);
  }
};

export const resolveReleaseBuildInput = ({
  policy,
  environment = process.env,
  gitSourceSha,
  gitSourceState,
  providerCommitSha = null,
  cliRole = null,
  cliDimensions = null,
  cliBuildPurpose = null,
  defaultDbFingerprint = "0".repeat(64),
  requireClean = false,
  requireCliForNonProduction = false,
}) => {
  assertSha(gitSourceSha, SOURCE_SHA_PATTERN, "gitSourceSha");
  assertSha(defaultDbFingerprint, SHA256_PATTERN, "defaultDbFingerprint");
  if (!SOURCE_STATES.has(gitSourceState)) {
    throw new Error("gitSourceState is invalid");
  }
  if (providerCommitSha !== null) {
    assertSha(providerCommitSha, SOURCE_SHA_PATTERN, "providerCommitSha");
    if (providerCommitSha !== gitSourceSha) {
      throw new Error("Provider commit SHA does not match the checkout");
    }
  }
  if (cliBuildPurpose !== null && !BUILD_PURPOSES.has(cliBuildPurpose)) {
    throw new Error("cliBuildPurpose is invalid");
  }

  const environmentSourceSha = selectEnvironmentBinding(
    environment,
    ["FOUNDATION_RELEASE_SOURCE_SHA", "FOUNDATION_SOURCE_SHA"],
    "release source SHA",
  );
  const environmentSourceState = selectEnvironmentBinding(
    environment,
    ["FOUNDATION_RELEASE_SOURCE_STATE", "FOUNDATION_SOURCE_STATE"],
    "release source state",
  );
  const environmentRole = selectEnvironmentBinding(
    environment,
    ["FOUNDATION_RELEASE_ROLE"],
    "release role",
  );
  const environmentVariantId = selectEnvironmentBinding(
    environment,
    ["FOUNDATION_RELEASE_VARIANT_ID", "FOUNDATION_VARIANT_ID"],
    "release variant ID",
  );
  const environmentDbFingerprint = selectEnvironmentBinding(
    environment,
    ["FOUNDATION_RELEASE_DB_FINGERPRINT", "FOUNDATION_DB_FINGERPRINT"],
    "release DB fingerprint",
  );
  const serializedDimensions = selectEnvironmentBinding(
    environment,
    ["FOUNDATION_RELEASE_DIMENSIONS_JSON"],
    "release dimensions",
  );
  const environmentDimensions =
    serializedDimensions === null
      ? null
      : parseCanonicalDimensions(
          serializedDimensions,
          "FOUNDATION_RELEASE_DIMENSIONS_JSON",
        );

  const canonicalSerialized =
    environment[RELEASE_BUILD_INPUT_ENV] === undefined
      ? null
      : String(environment[RELEASE_BUILD_INPUT_ENV]);
  let input;
  if (canonicalSerialized !== null) {
    input = parseReleaseBuildInput(canonicalSerialized, policy);
    assertScalarConflict(input.sourceSha, environmentSourceSha, "source SHA");
    assertScalarConflict(
      input.sourceState,
      environmentSourceState,
      "source state",
    );
    assertScalarConflict(input.releaseRole, environmentRole, "release role");
    assertScalarConflict(input.releaseRole, cliRole, "CLI release role");
    assertScalarConflict(
      input.buildPurpose,
      cliBuildPurpose,
      "CLI build purpose",
    );
    assertScalarConflict(input.variantId, environmentVariantId, "variant ID");
    assertScalarConflict(
      input.dbFingerprint,
      environmentDbFingerprint,
      "DB fingerprint",
    );
    assertObjectConflict(
      input.dimensions,
      environmentDimensions,
      "environment dimensions",
    );
    assertObjectConflict(input.dimensions, cliDimensions, "CLI dimensions");
  } else {
    assertScalarConflict(environmentRole, cliRole, "CLI release role");
    assertObjectConflict(
      environmentDimensions,
      cliDimensions,
      "CLI dimensions",
    );
    const dimensions =
      cliDimensions ??
      environmentDimensions ??
      (cliRole === "containment" || environmentRole === "containment"
        ? projectContainmentDimensions(policy, policy.targetStandard)
        : { ...policy.targetStandard });
    assertDimensionObject(policy, dimensions);
    const releaseRole =
      cliRole ?? environmentRole ?? dimensions.releaseRole ?? "standard";
    input = createReleaseBuildInput({
      policy,
      sourceSha: environmentSourceSha ?? providerCommitSha ?? gitSourceSha,
      sourceState:
        environmentSourceState ??
        (providerCommitSha === null ? gitSourceState : "provider-immutable"),
      releaseRole,
      dimensions,
      variantId: environmentVariantId ?? computeVariantId(policy, dimensions),
      dbFingerprint: environmentDbFingerprint ?? defaultDbFingerprint,
      buildPurpose: cliBuildPurpose ?? "production",
    });
  }

  if (
    requireCliForNonProduction &&
    input.nonPromotable &&
    cliBuildPurpose !== input.buildPurpose
  ) {
    throw new Error(
      "Nonproduction QA build input must originate from the matching CLI option",
    );
  }

  if (input.sourceSha !== gitSourceSha) {
    throw new Error("Release source SHA does not match the checkout");
  }
  if (providerCommitSha !== null && input.sourceSha !== providerCommitSha) {
    throw new Error("Release source SHA does not match the provider commit");
  }
  if (providerCommitSha === null && input.sourceState !== gitSourceState) {
    throw new Error("Release source state does not match the checkout");
  }
  if (providerCommitSha !== null && input.sourceState === "dirty") {
    throw new Error("Provider release source state cannot be dirty");
  }
  if (input.dbFingerprint !== defaultDbFingerprint) {
    throw new Error(
      "Release DB fingerprint does not match the checked-in contract",
    );
  }
  if (requireClean && gitSourceState !== "clean") {
    throw new Error("Canonical release builds require a clean checkout");
  }
  return input;
};

export const releaseBuildInputEnvironment = (input, policy) => ({
  [RELEASE_BUILD_INPUT_ENV]: serializeReleaseBuildInput(input, policy),
  FOUNDATION_RELEASE_SOURCE_SHA: input.sourceSha,
  FOUNDATION_RELEASE_SOURCE_STATE: input.sourceState,
  FOUNDATION_RELEASE_ROLE: input.releaseRole,
  FOUNDATION_RELEASE_VARIANT_ID: input.variantId,
  FOUNDATION_RELEASE_DIMENSIONS_JSON: canonicalJsonBytes(
    input.dimensions,
  ).toString("utf8"),
  FOUNDATION_RELEASE_DB_FINGERPRINT: input.dbFingerprint,
});

export const releaseBuildInputHash = (input, policy) =>
  sha256Json(assertReleaseBuildInput(input, policy));

export const bindReleaseBuildLauncher = (input, policy) => {
  return releaseBuildInputEnvironment(input, policy);
};

export const assertReleaseBuildLauncherBinding = (
  input,
  policy,
  cliBuildPurpose = null,
) => {
  assertReleaseBuildInput(input, policy);
  if (input.nonPromotable && cliBuildPurpose !== input.buildPurpose) {
    throw new Error(
      "Nonproduction QA build lacks the matching canonical CLI launcher binding",
    );
  }
  return input;
};
