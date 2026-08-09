import { sha256Bytes } from "../lib/canonical-json.mjs";
import { assertProviderPolicyConfigured } from "./collect-vercel-observation.mjs";

export const FOUNDATION_P0A_AUTHORITIES_POLICY_KIND =
  "foundation-p0a-authorities-policy/v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{2,127}$/u;
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,254}$/u;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");

const sortedDistinct = (values, label) => {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some(
      (value, index) =>
        typeof value !== "string" ||
        value.length === 0 ||
        !value.startsWith("/") ||
        value.includes("#") ||
        (index > 0 && values[index - 1].localeCompare(value) >= 0),
    )
  ) {
    throw new Error(`${label} must be a sorted distinct route set`);
  }
  return values;
};

const assertConfiguredApproval = (policy) => {
  const teams = Object.values(policy?.roles ?? {}).map(
    (entry) => entry?.reviewerTeam,
  );
  if (
    !isRecord(policy) ||
    policy.bindingStatus !== "configured" ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0 ||
    typeof policy.repository !== "string" ||
    !policy.workflowRef?.endsWith(
      "/.github/workflows/release.yml@refs/heads/main",
    ) ||
    typeof policy.protectedEnvironment !== "string" ||
    teams.length !== 3 ||
    teams.some((team) => !SAFE_OWNER.test(team ?? "")) ||
    new Set(teams).size !== teams.length
  ) {
    throw new Error("Foundation P0A approval policy is not configured");
  }
  return policy;
};

const assertConfiguredStore = (policy) => {
  if (
    !isRecord(policy) ||
    policy.bindingStatus !== "configured" ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0 ||
    policy.engine !== "postgresql" ||
    policy.postgresMajor !== 17 ||
    policy.tlsMode !== "verify-full" ||
    policy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL" ||
    !Array.isArray(policy.allowedHosts) ||
    policy.allowedHosts.length === 0 ||
    !Array.isArray(policy.allowedDatabases) ||
    policy.allowedDatabases.length === 0 ||
    !Array.isArray(policy.allowedExecutorRoles) ||
    policy.allowedExecutorRoles.length === 0 ||
    !SHA256.test(policy.productionCaSha256 ?? "") ||
    !SAFE_OWNER.test(policy.backupOwner ?? "") ||
    !SAFE_OWNER.test(policy.restoreOwner ?? "")
  ) {
    throw new Error("Foundation P0A control store policy is not configured");
  }
  return policy;
};

const assertConfiguredDatabase = (contract) => {
  const authority = contract?.remote?.observationAuthority;
  if (
    !isRecord(contract) ||
    !["local-specification", "remote-verified"].includes(
      contract.contractStatus,
    ) ||
    !["unobserved", "observed"].includes(contract.remote?.observationStatus) ||
    !isRecord(authority) ||
    authority.bindingStatus !== "configured" ||
    authority.postgresMajor !== 17 ||
    authority.tlsMode !== "verify-full" ||
    !ENVIRONMENT_NAME.test(authority.databaseUrlEnvironmentName ?? "") ||
    !ENVIRONMENT_NAME.test(authority.databaseCaEnvironmentName ?? "") ||
    !Array.isArray(authority.allowedHosts) ||
    authority.allowedHosts.length === 0 ||
    !Array.isArray(authority.allowedDatabases) ||
    authority.allowedDatabases.length === 0 ||
    !Array.isArray(authority.allowedObserverRoles) ||
    authority.allowedObserverRoles.length === 0 ||
    !SHA256.test(authority.productionCaSha256 ?? "")
  ) {
    throw new Error(
      "Foundation P0A application database authority is not configured",
    );
  }
  return authority;
};

export const assertFoundationP0aAuthoritiesPolicy = (
  policy,
  { requireConfigured = false } = {},
) => {
  if (
    !exactKeys(policy, [
      "applicationDatabase",
      "bindingStatus",
      "blockerCodes",
      "bootstrapRecovery",
      "controlStore",
      "githubCredentialEnvironmentName",
      "kind",
      "providerCredentialEnvironmentName",
      "schemaVersion",
    ]) ||
    policy.schemaVersion !== 1 ||
    policy.kind !== FOUNDATION_P0A_AUTHORITIES_POLICY_KIND ||
    !["configured", "unconfigured"].includes(policy.bindingStatus) ||
    !ENVIRONMENT_NAME.test(policy.providerCredentialEnvironmentName ?? "") ||
    !ENVIRONMENT_NAME.test(policy.githubCredentialEnvironmentName ?? "") ||
    !Array.isArray(policy.blockerCodes) ||
    !exactKeys(policy.applicationDatabase, [
      "backupOwner",
      "credentialOwner",
      "provisioningStatus",
      "restoreOwner",
    ]) ||
    !exactKeys(policy.controlStore, ["credentialOwner", "namespaceStatus"]) ||
    !exactKeys(policy.bootstrapRecovery, [
      "cleanupMode",
      "deploymentBindingSha256",
      "maximumRecoverySeconds",
      "requiredRoutes",
    ]) ||
    !Number.isSafeInteger(policy.bootstrapRecovery.maximumRecoverySeconds) ||
    policy.bootstrapRecovery.maximumRecoverySeconds < 1 ||
    policy.bootstrapRecovery.cleanupMode !==
      "delete-alias-and-preview-deployments"
  ) {
    throw new Error("Foundation P0A authority policy is invalid");
  }
  sortedDistinct(
    policy.bootstrapRecovery.requiredRoutes,
    "Foundation bootstrap required routes",
  );
  if (policy.bindingStatus === "unconfigured") {
    if (
      policy.blockerCodes.length === 0 ||
      policy.applicationDatabase.provisioningStatus !== "unconfigured" ||
      policy.applicationDatabase.credentialOwner !== null ||
      policy.applicationDatabase.backupOwner !== null ||
      policy.applicationDatabase.restoreOwner !== null ||
      policy.controlStore.namespaceStatus !== "unconfigured" ||
      policy.controlStore.credentialOwner !== null ||
      policy.bootstrapRecovery.deploymentBindingSha256 !== null
    ) {
      throw new Error("Unconfigured Foundation P0A policy is not closed");
    }
    if (requireConfigured) {
      throw new Error(
        `Foundation P0A authority policy is not configured: ${policy.blockerCodes.join(", ")}`,
      );
    }
    return policy;
  }
  if (
    policy.blockerCodes.length !== 0 ||
    policy.applicationDatabase.provisioningStatus !== "provisioned" ||
    !SAFE_OWNER.test(policy.applicationDatabase.credentialOwner ?? "") ||
    !SAFE_OWNER.test(policy.applicationDatabase.backupOwner ?? "") ||
    !SAFE_OWNER.test(policy.applicationDatabase.restoreOwner ?? "") ||
    policy.controlStore.namespaceStatus !== "uninitialized" ||
    !SAFE_OWNER.test(policy.controlStore.credentialOwner ?? "") ||
    !SHA256.test(policy.bootstrapRecovery.deploymentBindingSha256 ?? "")
  ) {
    throw new Error("Configured Foundation P0A policy is incomplete");
  }
  return policy;
};

export const assertConfiguredFoundationP0aAuthorities = ({
  p0aPolicy,
  providerPolicy,
  databaseContract,
  storePolicy,
  approvalPolicy,
  artifactDrillPolicy = null,
  requireBootstrap = false,
}) => {
  assertFoundationP0aAuthoritiesPolicy(p0aPolicy, {
    requireConfigured: true,
  });
  assertProviderPolicyConfigured(providerPolicy);
  const databaseAuthority = assertConfiguredDatabase(databaseContract);
  assertConfiguredStore(storePolicy);
  assertConfiguredApproval(approvalPolicy);
  if (
    p0aPolicy.providerCredentialEnvironmentName !== "VERCEL_TOKEN" ||
    p0aPolicy.githubCredentialEnvironmentName !== "GITHUB_TOKEN"
  ) {
    throw new Error("Foundation P0A credential environment allowlist differs");
  }
  if (requireBootstrap) {
    if (
      !isRecord(artifactDrillPolicy) ||
      artifactDrillPolicy.bindingStatus !== "configured" ||
      !Array.isArray(artifactDrillPolicy.blockerCodes) ||
      artifactDrillPolicy.blockerCodes.length !== 0 ||
      typeof artifactDrillPolicy.providerPreviewAliasSuffix !== "string" ||
      artifactDrillPolicy.providerPreviewAliasSuffix.length === 0
    ) {
      throw new Error(
        "Foundation bootstrap preview authority is not configured",
      );
    }
  }
  return Object.freeze({
    databaseAuthority,
    applicationDatabaseOwners: Object.freeze({
      ...p0aPolicy.applicationDatabase,
    }),
    controlStoreOwner: p0aPolicy.controlStore.credentialOwner,
    databaseCaSha256: databaseAuthority.productionCaSha256,
    storeCaSha256: storePolicy.productionCaSha256,
  });
};

export const assertFoundationP0aCa = (value, expectedSha256, label) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    sha256Bytes(Buffer.from(value, "utf8")) !== expectedSha256
  ) {
    throw new Error(`${label} CA differs from configured authority`);
  }
  return value;
};
