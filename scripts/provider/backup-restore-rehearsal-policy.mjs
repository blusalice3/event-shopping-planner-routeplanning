import { sha256Json } from "../lib/canonical-json.mjs";
import {
  BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST,
  verifyExternalPrerequisitePolicy,
} from "../lib/phase-exit-external-prerequisites.mjs";
import {
  assertExactKeys,
  isRecord,
} from "../release-state/releaseWorkflowValidation.mjs";

export const BACKUP_RESTORE_PROVIDER_CONTRACT_KIND =
  "backup-restore-provider-contract/v2";
export const BACKUP_RESTORE_PROVIDER = "supabase";
export const BACKUP_RESTORE_INTEGRITY_FUNCTION =
  "read_foundation_backup_restore_integrity";
export const BACKUP_RESTORE_INTEGRITY_QUERY_NAME =
  "foundation-backup-restore-integrity-v2";

const SHA256 = /^[0-9a-f]{64}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const POSTGRES_ROLE = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATION_VERSION = /^[0-9]{14}$/u;

const ROOT_KEYS = [
  "api",
  "bindingStatus",
  "database",
  "kind",
  "provider",
  "schemaVersion",
];
const API_KEYS = [
  "authentication",
  "backupReadyState",
  "cleanupPolling",
  "maximumResponseBytes",
  "operations",
  "projectReadyState",
  "requestTimeoutMilliseconds",
  "restoreMode",
];
const AUTH_KEYS = ["credentialEnvironmentName", "scheme"];
const POLLING_KEYS = ["intervalMilliseconds", "maximumAttempts"];
const OPERATION_KEYS = ["method", "pathTemplate", "successStatusCodes"];
const OPERATION_CONTRACTS = Object.freeze({
  confirmRestoreDeleted: {
    method: "GET",
    pathTemplate: "/v1/projects/{restoreProjectRef}",
    successStatusCodes: [200, 404],
  },
  deleteRestoreProject: {
    method: "DELETE",
    pathTemplate: "/v1/projects/{restoreProjectRef}",
    successStatusCodes: [200],
  },
  getRestoreProject: {
    method: "GET",
    pathTemplate: "/v1/projects/{restoreProjectRef}",
    successStatusCodes: [200],
  },
  getSourceProject: {
    method: "GET",
    pathTemplate: "/v1/projects/{sourceProjectRef}",
    successStatusCodes: [200],
  },
  listSourceBackups: {
    method: "GET",
    pathTemplate: "/v1/projects/{sourceProjectRef}/database/backups",
    successStatusCodes: [200],
  },
});
const OPERATION_NAMES = Object.keys(OPERATION_CONTRACTS).sort();
const DATABASE_KEYS = [
  "connectTimeoutMilliseconds",
  "integrityFunction",
  "integrityMigrationVersion",
  "postgresMajor",
  "queryName",
  "restore",
  "source",
  "statementTimeoutMilliseconds",
  "tlsMode",
];
const DATABASE_AUTHORITY_KEYS = [
  "allowedDatabases",
  "allowedHosts",
  "allowedPorts",
  "allowedRoles",
  "caSha256",
  "databaseCaEnvironmentName",
  "databaseUrlEnvironmentName",
];

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertInteger = (value, minimum, maximum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its closed integer bounds`);
  }
};

const assertSortedUniqueStrings = (
  values,
  label,
  { pattern, minimum = 1, maximum = 64, transform = (value) => value } = {},
) => {
  if (
    !Array.isArray(values) ||
    values.length < minimum ||
    values.length > maximum ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        (pattern !== undefined && !pattern.test(value)) ||
        transform(value) !== value,
    ) ||
    new Set(values).size !== values.length ||
    values.some(
      (value, index) => index > 0 && compareUtf8(values[index - 1], value) >= 0,
    )
  ) {
    throw new Error(`${label} must be a sorted distinct closed string set`);
  }
};

const assertExactOperation = (name, operation) => {
  const expected = OPERATION_CONTRACTS[name];
  assertExactKeys(operation, OPERATION_KEYS, `Backup API ${name}`);
  if (
    operation.method !== expected.method ||
    operation.pathTemplate !== expected.pathTemplate ||
    !Array.isArray(operation.successStatusCodes) ||
    operation.successStatusCodes.length !==
      expected.successStatusCodes.length ||
    operation.successStatusCodes.some(
      (status, index) => status !== expected.successStatusCodes[index],
    )
  ) {
    throw new Error(`Backup API ${name} differs from the official endpoint`);
  }
};

const assertDatabaseAuthority = (authority, kind) => {
  assertExactKeys(
    authority,
    DATABASE_AUTHORITY_KEYS,
    `Backup ${kind} database authority`,
  );
  const expectedPrefix =
    kind === "source"
      ? "FOUNDATION_BACKUP_SOURCE"
      : "FOUNDATION_BACKUP_RESTORE";
  if (
    authority.databaseUrlEnvironmentName !== `${expectedPrefix}_DATABASE_URL` ||
    authority.databaseCaEnvironmentName !==
      `${expectedPrefix}_DATABASE_CA_PEM` ||
    !SHA256.test(authority.caSha256 ?? "")
  ) {
    throw new Error(`Backup ${kind} database credential authority is invalid`);
  }
  assertSortedUniqueStrings(
    authority.allowedHosts,
    `Backup ${kind} allowed hosts`,
    { pattern: HOST, transform: (value) => value.toLowerCase() },
  );
  if (authority.allowedHosts.length !== 1) {
    throw new Error(`Backup ${kind} database host authority is not exact`);
  }
  if (
    !Array.isArray(authority.allowedPorts) ||
    authority.allowedPorts.length !== 1 ||
    authority.allowedPorts[0] !== 5432
  ) {
    throw new Error(`Backup ${kind} database ports are invalid`);
  }
  assertSortedUniqueStrings(
    authority.allowedDatabases,
    `Backup ${kind} allowed databases`,
    { pattern: POSTGRES_IDENTIFIER },
  );
  if (
    authority.allowedDatabases.length !== 1 ||
    authority.allowedDatabases[0] !== "postgres"
  ) {
    throw new Error(`Backup ${kind} database name is invalid`);
  }
  assertSortedUniqueStrings(
    authority.allowedRoles,
    `Backup ${kind} allowed roles`,
    { pattern: POSTGRES_ROLE },
  );
  const expectedRole = `foundation_backup_${kind}_reader`;
  if (
    authority.allowedRoles.length !== 1 ||
    authority.allowedRoles[0] !== expectedRole
  ) {
    throw new Error(`Backup ${kind} database role authority is invalid`);
  }
};

export const assertBackupRestoreProviderContract = (
  contract,
  { requireConfigured = false } = {},
) => {
  assertExactKeys(contract, ROOT_KEYS, "Backup/restore provider contract");
  if (
    contract.schemaVersion !== 2 ||
    contract.kind !== BACKUP_RESTORE_PROVIDER_CONTRACT_KIND ||
    !["configured", "unconfigured"].includes(contract.bindingStatus) ||
    ![null, BACKUP_RESTORE_PROVIDER].includes(contract.provider)
  ) {
    throw new Error("Backup/restore provider contract identity is invalid");
  }
  if (contract.bindingStatus === "unconfigured") {
    if (
      contract.provider !== null ||
      contract.api !== null ||
      contract.database !== null
    ) {
      throw new Error(
        "Unconfigured backup/restore provider contract contains authority",
      );
    }
    if (requireConfigured) {
      throw new Error("Backup/restore provider contract is not configured");
    }
    return contract;
  }
  if (
    contract.provider !== BACKUP_RESTORE_PROVIDER ||
    !isRecord(contract.api) ||
    !isRecord(contract.database)
  ) {
    throw new Error(
      "Configured backup/restore provider contract is incomplete",
    );
  }

  assertExactKeys(contract.api, API_KEYS, "Backup provider API contract");
  assertExactKeys(
    contract.api.authentication,
    AUTH_KEYS,
    "Backup provider API authentication",
  );
  if (
    contract.api.authentication.scheme !== "bearer" ||
    contract.api.authentication.credentialEnvironmentName !==
      "FOUNDATION_BACKUP_API_TOKEN" ||
    contract.api.restoreMode !== "dashboard-new-project" ||
    contract.api.backupReadyState !== "COMPLETED" ||
    contract.api.projectReadyState !== "ACTIVE_HEALTHY"
  ) {
    throw new Error("Backup provider API authority is invalid");
  }
  assertInteger(
    contract.api.maximumResponseBytes,
    1024,
    4 * 1024 * 1024,
    "Backup provider maximum response bytes",
  );
  assertInteger(
    contract.api.requestTimeoutMilliseconds,
    1,
    60_000,
    "Backup provider request timeout",
  );
  assertExactKeys(
    contract.api.cleanupPolling,
    POLLING_KEYS,
    "Backup cleanup polling",
  );
  assertInteger(
    contract.api.cleanupPolling.intervalMilliseconds,
    100,
    60_000,
    "Backup cleanup polling interval",
  );
  assertInteger(
    contract.api.cleanupPolling.maximumAttempts,
    1,
    240,
    "Backup cleanup polling attempts",
  );
  assertExactKeys(
    contract.api.operations,
    OPERATION_NAMES,
    "Backup provider operations",
  );
  for (const name of OPERATION_NAMES) {
    assertExactOperation(name, contract.api.operations[name]);
  }
  if (
    Object.values(contract.api.operations).some(
      ({ method, pathTemplate }) =>
        method === "POST" || pathTemplate.includes("restore-pitr"),
    )
  ) {
    throw new Error("Backup contract must never perform in-place PITR");
  }

  assertExactKeys(
    contract.database,
    DATABASE_KEYS,
    "Backup database verification",
  );
  if (
    contract.database.postgresMajor !== 17 ||
    contract.database.tlsMode !== "verify-full" ||
    contract.database.integrityFunction !== BACKUP_RESTORE_INTEGRITY_FUNCTION ||
    contract.database.queryName !== BACKUP_RESTORE_INTEGRITY_QUERY_NAME ||
    !MIGRATION_VERSION.test(contract.database.integrityMigrationVersion ?? "")
  ) {
    throw new Error("Backup database verification contract is invalid");
  }
  assertInteger(
    contract.database.connectTimeoutMilliseconds,
    1,
    60_000,
    "Backup database connect timeout",
  );
  assertInteger(
    contract.database.statementTimeoutMilliseconds,
    1,
    60_000,
    "Backup database statement timeout",
  );
  assertDatabaseAuthority(contract.database.source, "source");
  assertDatabaseAuthority(contract.database.restore, "restore");
  const sourceRoles = new Set(contract.database.source.allowedRoles);
  const sourceHosts = new Set(contract.database.source.allowedHosts);
  const sourceDatabases = new Set(contract.database.source.allowedDatabases);
  if (
    contract.database.restore.allowedRoles.some((role) =>
      sourceRoles.has(role),
    ) ||
    (contract.database.restore.allowedHosts.some((host) =>
      sourceHosts.has(host),
    ) &&
      contract.database.restore.allowedDatabases.some((database) =>
        sourceDatabases.has(database),
      ))
  ) {
    throw new Error("Backup source and restore database authorities overlap");
  }
  return contract;
};

export const assertConfiguredBackupRestorePolicy = ({
  prerequisitePolicy,
  providerContract,
}) => {
  verifyExternalPrerequisitePolicy(prerequisitePolicy);
  assertBackupRestoreProviderContract(providerContract, {
    requireConfigured: true,
  });
  const backup = prerequisitePolicy.backupRestore;
  if (
    backup.bindingStatus !== "configured" ||
    backup.provider !== BACKUP_RESTORE_PROVIDER ||
    backup.apiOrigin !== "https://api.supabase.com" ||
    typeof backup.sourceProjectRef !== "string" ||
    typeof backup.restoreTarget?.projectRef !== "string" ||
    backup.restoreTarget.environment !== "nonproduction" ||
    backup.sourceProjectRef === backup.restoreTarget.projectRef ||
    typeof backup.restoreTarget.namespacePrefix !== "string" ||
    typeof backup.owner !== "string" ||
    !Array.isArray(backup.credentialEnvironmentAllowlist) ||
    backup.credentialEnvironmentAllowlist.length !==
      BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST.length ||
    backup.credentialEnvironmentAllowlist.some(
      (name, index) => name !== BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST[index],
    ) ||
    providerContract.provider !== backup.provider
  ) {
    throw new Error("Backup/restore prerequisite is not configured");
  }
  if (
    providerContract.api.cleanupPolling.intervalMilliseconds *
      providerContract.api.cleanupPolling.maximumAttempts >
    backup.recoveryTimeObjectiveSeconds * 1000
  ) {
    throw new Error("Backup cleanup polling exceeds the configured RTO");
  }
  return Object.freeze({
    prerequisitePolicySha256: sha256Json(prerequisitePolicy),
    providerContractSha256: sha256Json(providerContract),
    backup,
    providerContract,
  });
};
