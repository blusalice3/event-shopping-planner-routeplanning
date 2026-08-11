const HOST = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)*[a-z0-9-]+$/u;
const DATABASE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u;
const ROLE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLACEHOLDER =
  /(?:^|[._-])(?:changeme|example|local|placeholder|replace|sample|test|todo)(?:$|[._-])/iu;

export const ARTIFACT_DRILL_BINDING_BLOCKERS = Object.freeze([
  "artifact-drill-database-host-unconfigured",
  "artifact-drill-database-name-unconfigured",
  "artifact-drill-administrator-role-unconfigured",
  "artifact-drill-executor-role-unconfigured",
  "artifact-drill-denied-reader-projection-role-unconfigured",
  "artifact-drill-ca-unobserved",
  "artifact-drill-preview-alias-suffix-unconfigured",
]);

export const ARTIFACT_DRILL_IMPLEMENTATION_BLOCKERS = Object.freeze([
  "artifact-drill-build-provider-adapter-unimplemented",
  "artifact-drill-receipt-semantics-incomplete",
  "artifact-drill-collector-identity-unbound",
  "artifact-drill-all-role-membership-unverified",
]);

export const ARTIFACT_DRILL_IMPLEMENTATION_CAPABILITIES = Object.freeze({
  liveProviderBuildAdapterImplemented: true,
  operationReceiptSemanticValidatorsImplemented: true,
  collectorIdentityBindingImplemented: true,
  roleMembershipClosedSetImplemented: true,
});

const ROOT_KEYS = Object.freeze([
  "allowedDrillAdministratorRoles",
  "allowedDrillDatabases",
  "allowedDrillExecutorRoles",
  "allowedDrillHosts",
  "allowedDeniedReaderProjectionRoles",
  "bindingStatus",
  "blockerCodes",
  "connectTimeoutMilliseconds",
  "databaseCaEnvironmentName",
  "databaseCaSha256",
  "drillAdministratorDatabaseUrlEnvironmentName",
  "drillExecutorDatabaseUrlEnvironmentName",
  "implementation",
  "deniedReaderProjectionDatabaseUrlEnvironmentName",
  "providerPreviewAliasSuffix",
  "schemaResetMode",
  "schemaVersion",
  "statementTimeoutMilliseconds",
]);

const IMPLEMENTATION_KEYS = Object.freeze(
  Object.keys(ARTIFACT_DRILL_IMPLEMENTATION_CAPABILITIES),
);
const ALL_BLOCKERS = Object.freeze([
  ...ARTIFACT_DRILL_BINDING_BLOCKERS,
  ...ARTIFACT_DRILL_IMPLEMENTATION_BLOCKERS,
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertClosedStringArray = ({
  value,
  pattern,
  label,
  lowercase = false,
}) => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  let previous = null;
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !pattern.test(entry) ||
      (lowercase && entry !== entry.toLowerCase()) ||
      PLACEHOLDER.test(entry) ||
      (previous !== null && compareUtf8(previous, entry) >= 0)
    ) {
      throw new Error(
        `${label} contains invalid, placeholder, duplicate, or unsorted values`,
      );
    }
    previous = entry;
  }
  return value;
};

const assertPolicyStructure = (policy) => {
  if (!sameKeys(policy, ROOT_KEYS)) {
    throw new Error("Artifact drill policy has unknown or missing fields");
  }
  if (
    policy.schemaVersion !== 1 ||
    !["configured", "unconfigured"].includes(policy.bindingStatus) ||
    policy.databaseCaEnvironmentName !== "ARTIFACT_DRILL_DATABASE_CA_PEM" ||
    policy.drillAdministratorDatabaseUrlEnvironmentName !==
      "ARTIFACT_DRILL_ADMIN_DATABASE_URL" ||
    policy.drillExecutorDatabaseUrlEnvironmentName !==
      "ARTIFACT_DRILL_EXECUTOR_DATABASE_URL" ||
    policy.deniedReaderProjectionDatabaseUrlEnvironmentName !==
      "ARTIFACT_DRILL_DENIED_READER_DATABASE_URL" ||
    policy.schemaResetMode !== "dedicated-database-foundation-release-schema" ||
    policy.connectTimeoutMilliseconds !== 5000 ||
    policy.statementTimeoutMilliseconds !== 15000
  ) {
    throw new Error("Artifact drill fixed policy values differ");
  }

  assertClosedStringArray({
    value: policy.allowedDrillHosts,
    pattern: HOST,
    label: "Artifact drill hosts",
    lowercase: true,
  });
  assertClosedStringArray({
    value: policy.allowedDrillDatabases,
    pattern: DATABASE,
    label: "Artifact drill databases",
  });
  assertClosedStringArray({
    value: policy.allowedDrillAdministratorRoles,
    pattern: ROLE,
    label: "Artifact drill administrator roles",
  });
  assertClosedStringArray({
    value: policy.allowedDrillExecutorRoles,
    pattern: ROLE,
    label: "Artifact drill executor roles",
  });
  assertClosedStringArray({
    value: policy.allowedDeniedReaderProjectionRoles,
    pattern: ROLE,
    label: "Artifact drill denied reader projection roles",
  });
  const roleBindings = [
    ...policy.allowedDrillAdministratorRoles,
    ...policy.allowedDrillExecutorRoles,
    ...policy.allowedDeniedReaderProjectionRoles,
  ];
  if (new Set(roleBindings).size !== roleBindings.length) {
    throw new Error(
      "Artifact drill role bindings contain duplicate cross-role authority",
    );
  }

  if (
    !(
      policy.databaseCaSha256 === null ||
      (SHA256.test(policy.databaseCaSha256) &&
        !/^(.)\1{63}$/u.test(policy.databaseCaSha256))
    )
  ) {
    throw new Error(
      "Artifact drill database CA fingerprint is invalid or placeholder",
    );
  }
  if (
    !(
      policy.providerPreviewAliasSuffix === null ||
      (typeof policy.providerPreviewAliasSuffix === "string" &&
        policy.providerPreviewAliasSuffix ===
          policy.providerPreviewAliasSuffix.toLowerCase() &&
        policy.providerPreviewAliasSuffix.includes(".") &&
        HOST.test(policy.providerPreviewAliasSuffix) &&
        !PLACEHOLDER.test(policy.providerPreviewAliasSuffix))
    )
  ) {
    throw new Error(
      "Artifact drill preview alias suffix is invalid or placeholder",
    );
  }

  if (!sameKeys(policy.implementation, IMPLEMENTATION_KEYS)) {
    throw new Error(
      "Artifact drill implementation flags have unknown or missing fields",
    );
  }
  for (const key of IMPLEMENTATION_KEYS) {
    if (
      typeof policy.implementation[key] !== "boolean" ||
      policy.implementation[key] !==
        ARTIFACT_DRILL_IMPLEMENTATION_CAPABILITIES[key]
    ) {
      throw new Error(
        `Artifact drill implementation capability differs from repository code: ${key}`,
      );
    }
  }

  if (!Array.isArray(policy.blockerCodes)) {
    throw new Error("Artifact drill blockerCodes must be an array");
  }
  let previousIndex = -1;
  for (const blocker of policy.blockerCodes) {
    const index = ALL_BLOCKERS.indexOf(blocker);
    if (index < 0 || index <= previousIndex) {
      throw new Error(
        "Artifact drill blockerCodes contain unknown, duplicate, or unsorted values",
      );
    }
    previousIndex = index;
  }
  return policy;
};

export const deriveArtifactControlStoreDrillPolicyState = (policy) => {
  assertPolicyStructure(policy);
  const blockers = [];
  if (policy.allowedDrillHosts.length === 0) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[0]);
  }
  if (policy.allowedDrillDatabases.length === 0) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[1]);
  }
  if (policy.allowedDrillAdministratorRoles.length === 0) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[2]);
  }
  if (policy.allowedDrillExecutorRoles.length === 0) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[3]);
  }
  if (policy.allowedDeniedReaderProjectionRoles.length === 0) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[4]);
  }
  if (policy.databaseCaSha256 === null) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[5]);
  }
  if (policy.providerPreviewAliasSuffix === null) {
    blockers.push(ARTIFACT_DRILL_BINDING_BLOCKERS[6]);
  }
  for (let index = 0; index < IMPLEMENTATION_KEYS.length; index += 1) {
    if (
      ARTIFACT_DRILL_IMPLEMENTATION_CAPABILITIES[IMPLEMENTATION_KEYS[index]] !==
      true
    ) {
      blockers.push(ARTIFACT_DRILL_IMPLEMENTATION_BLOCKERS[index]);
    }
  }
  return Object.freeze({
    bindingStatus: blockers.length === 0 ? "configured" : "unconfigured",
    blockerCodes: Object.freeze([...blockers]),
  });
};

export const verifyArtifactControlStoreDrillPolicy = (policy) => {
  const derived = deriveArtifactControlStoreDrillPolicyState(policy);
  if (
    policy.bindingStatus !== derived.bindingStatus ||
    policy.blockerCodes.length !== derived.blockerCodes.length ||
    policy.blockerCodes.some(
      (blocker, index) => blocker !== derived.blockerCodes[index],
    )
  ) {
    throw new Error(
      "Artifact drill policy status/blockerCodes differ from derived authority",
    );
  }
  return Object.freeze({
    bindingStatus: derived.bindingStatus,
    blockerCodes: derived.blockerCodes,
    configured: derived.bindingStatus === "configured",
  });
};

export const assertConfiguredArtifactControlStoreDrillPolicy = (policy) => {
  const report = verifyArtifactControlStoreDrillPolicy(policy);
  if (!report.configured) {
    throw new Error(
      `Artifact drill database policy is not configured: ${report.blockerCodes.join(", ")}`,
    );
  }
  return policy;
};
