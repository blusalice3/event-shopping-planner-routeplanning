import { canonicalJsonBytes, sha256Json } from "../lib/canonical-json.mjs";
import {
  BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST,
  verifyExternalPrerequisitePolicy,
} from "../lib/phase-exit-external-prerequisites.mjs";
import {
  assertExactKeys,
  isRecord,
} from "../release-state/releaseWorkflowValidation.mjs";

export const BACKUP_RESTORE_PROVIDER_CONTRACT_KIND =
  "backup-restore-provider-contract/v1";
export const BACKUP_RESTORE_PROVIDER = "supabase";
export const BACKUP_RESTORE_INTEGRITY_FUNCTION =
  "read_foundation_backup_restore_integrity";
export const BACKUP_RESTORE_INTEGRITY_QUERY_NAME =
  "foundation-backup-restore-integrity-v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const POSTGRES_ROLE = /^[a-z_][a-z0-9_.-]{0,126}$/u;
const PATH_TEMPLATE =
  /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|\{[a-zA-Z][a-zA-Z0-9]*\})+$/u;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/u;
const STATE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PLACEHOLDER = /^\{([a-zA-Z][a-zA-Z0-9]*)\}$/u;
const ALLOWED_PLACEHOLDERS = new Set([
  "backupId",
  "restoreId",
  "restoreProjectRef",
  "sourceProjectRef",
]);

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
  "backupMode",
  "maximumResponseBytes",
  "operations",
  "polling",
  "requestTimeoutMilliseconds",
  "states",
];
const AUTH_KEYS = ["credentialEnvironmentName", "scheme"];
const POLLING_KEYS = ["intervalMilliseconds", "maximumAttempts"];
const OPERATION_NAMES = [
  "cleanupRestore",
  "createBackup",
  "getBackup",
  "getCleanup",
  "getRestore",
  "restoreBackup",
];
const OPERATION_KEYS = [
  "method",
  "pathTemplate",
  "requestBodyTemplate",
  "response",
  "successStatusCodes",
];
const RESPONSE_KEYS = [
  "recoveryPointAtPointer",
  "resourceIdPointer",
  "statePointer",
];
const STATE_KEYS = [
  "backupPending",
  "backupReady",
  "cleanupPending",
  "cleanupReady",
  "failed",
  "restorePending",
  "restoreReady",
];
const DATABASE_KEYS = [
  "connectTimeoutMilliseconds",
  "integrityFunction",
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
  "allowedRoles",
  "caSha256",
  "databaseCaEnvironmentName",
  "databaseUrlEnvironmentName",
];

const OPERATION_CONTRACTS = Object.freeze({
  createBackup: {
    method: "POST",
    requiredPlaceholders: ["sourceProjectRef"],
    recoveryPoint: true,
  },
  getBackup: {
    method: "GET",
    requiredPlaceholders: ["backupId", "sourceProjectRef"],
    recoveryPoint: true,
  },
  restoreBackup: {
    method: "POST",
    requiredPlaceholders: ["backupId", "restoreProjectRef"],
    recoveryPoint: false,
  },
  getRestore: {
    method: "GET",
    requiredPlaceholders: ["restoreId", "restoreProjectRef"],
    recoveryPoint: false,
  },
  cleanupRestore: {
    method: "DELETE",
    requiredPlaceholders: ["restoreId", "restoreProjectRef"],
    recoveryPoint: false,
  },
  getCleanup: {
    method: "GET",
    requiredPlaceholders: ["restoreId", "restoreProjectRef"],
    recoveryPoint: false,
  },
});

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

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
  return values;
};

const assertInteger = (value, minimum, maximum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its closed integer bounds`);
  }
};

const templatePlaceholders = (value, label, depth = 0) => {
  if (depth > 8) throw new Error(`${label} exceeds the maximum depth`);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return [];
  }
  if (typeof value === "string") {
    const match = value.match(PLACEHOLDER);
    if (match === null) {
      if (
        value.length > 512 ||
        [...value].some((character) => character.codePointAt(0) < 0x20)
      ) {
        throw new Error(`${label} contains an invalid string`);
      }
      return [];
    }
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) {
      throw new Error(`${label} contains an unknown placeholder`);
    }
    return [match[1]];
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new Error(`${label} is oversized`);
    return value.flatMap((entry, index) =>
      templatePlaceholders(entry, `${label}[${index}]`, depth + 1),
    );
  }
  if (!isRecord(value) || Object.keys(value).length > 32) {
    throw new Error(`${label} is not a bounded plain JSON template`);
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) ||
      /token|authorization|password|secret/iu.test(key)
    ) {
      throw new Error(`${label} contains an unsafe member`);
    }
    return templatePlaceholders(entry, `${label}.${key}`, depth + 1);
  });
};

const containsExactJsonValue = (value, expected) =>
  value === expected ||
  (Array.isArray(value) &&
    value.some((entry) => containsExactJsonValue(entry, expected))) ||
  (isRecord(value) &&
    Object.values(value).some((entry) =>
      containsExactJsonValue(entry, expected),
    ));

const pathPlaceholders = (pathTemplate, label) => {
  if (
    typeof pathTemplate !== "string" ||
    pathTemplate.length > 1024 ||
    !PATH_TEMPLATE.test(pathTemplate) ||
    pathTemplate.includes("//") ||
    pathTemplate.includes("?") ||
    pathTemplate.includes("#") ||
    pathTemplate.includes("..")
  ) {
    throw new Error(`${label} path template is invalid`);
  }
  const placeholders = [
    ...pathTemplate.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu),
  ].map((match) => match[1]);
  if (
    placeholders.some((placeholder) => !ALLOWED_PLACEHOLDERS.has(placeholder))
  ) {
    throw new Error(`${label} path contains an unknown placeholder`);
  }
  return placeholders;
};

const assertOperation = (name, operation) => {
  const semantics = OPERATION_CONTRACTS[name];
  assertExactKeys(operation, OPERATION_KEYS, `Backup API ${name}`);
  if (operation.method !== semantics.method) {
    throw new Error(`Backup API ${name} method is invalid`);
  }
  const placeholders = [
    ...pathPlaceholders(operation.pathTemplate, `Backup API ${name}`),
  ];
  if (["GET", "DELETE"].includes(operation.method)) {
    if (operation.requestBodyTemplate !== null) {
      throw new Error(`Backup API ${name} must not declare a request body`);
    }
  } else {
    if (!isRecord(operation.requestBodyTemplate)) {
      throw new Error(`Backup API ${name} request body must be an object`);
    }
    placeholders.push(
      ...templatePlaceholders(
        operation.requestBodyTemplate,
        `Backup API ${name} request body`,
      ),
    );
    if (canonicalJsonBytes(operation.requestBodyTemplate).length > 16 * 1024) {
      throw new Error(`Backup API ${name} request body is oversized`);
    }
    if (
      name === "createBackup" &&
      !containsExactJsonValue(operation.requestBodyTemplate, "pitr")
    ) {
      throw new Error("Backup API createBackup does not bind exact PITR mode");
    }
  }
  if (
    new Set(placeholders).size !== placeholders.length ||
    !semantics.requiredPlaceholders.every((value) =>
      placeholders.includes(value),
    )
  ) {
    throw new Error(`Backup API ${name} placeholder binding is incomplete`);
  }
  if (
    !Array.isArray(operation.successStatusCodes) ||
    operation.successStatusCodes.length < 1 ||
    operation.successStatusCodes.length > 4 ||
    operation.successStatusCodes.some(
      (status) => !Number.isSafeInteger(status) || status < 200 || status > 299,
    ) ||
    new Set(operation.successStatusCodes).size !==
      operation.successStatusCodes.length ||
    operation.successStatusCodes.some(
      (status, index) =>
        index > 0 && operation.successStatusCodes[index - 1] >= status,
    )
  ) {
    throw new Error(`Backup API ${name} success status set is invalid`);
  }
  assertExactKeys(
    operation.response,
    RESPONSE_KEYS,
    `Backup API ${name} response`,
  );
  for (const key of ["resourceIdPointer", "statePointer"]) {
    if (!JSON_POINTER.test(operation.response[key] ?? "")) {
      throw new Error(`Backup API ${name} ${key} is invalid`);
    }
  }
  if (
    semantics.recoveryPoint !==
    (operation.response.recoveryPointAtPointer !== null)
  ) {
    throw new Error(`Backup API ${name} recovery-point response is invalid`);
  }
  if (
    operation.response.recoveryPointAtPointer !== null &&
    !JSON_POINTER.test(operation.response.recoveryPointAtPointer)
  ) {
    throw new Error(`Backup API ${name} recovery-point pointer is invalid`);
  }
};

const assertStates = (states) => {
  assertExactKeys(states, STATE_KEYS, "Backup API states");
  for (const key of [
    "backupPending",
    "cleanupPending",
    "failed",
    "restorePending",
  ]) {
    assertSortedUniqueStrings(states[key], `Backup API ${key}`, {
      pattern: STATE,
    });
  }
  for (const key of ["backupReady", "cleanupReady", "restoreReady"]) {
    if (!STATE.test(states[key] ?? "")) {
      throw new Error(`Backup API ${key} state is invalid`);
    }
  }
  for (const [pending, ready] of [
    [states.backupPending, states.backupReady],
    [states.restorePending, states.restoreReady],
    [states.cleanupPending, states.cleanupReady],
  ]) {
    if (
      pending.includes(ready) ||
      pending.some((state) => states.failed.includes(state)) ||
      states.failed.includes(ready)
    ) {
      throw new Error(
        "Backup API lifecycle states overlap within an operation",
      );
    }
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
  assertSortedUniqueStrings(
    authority.allowedDatabases,
    `Backup ${kind} allowed databases`,
    { pattern: POSTGRES_IDENTIFIER },
  );
  assertSortedUniqueStrings(
    authority.allowedRoles,
    `Backup ${kind} allowed roles`,
    { pattern: POSTGRES_ROLE },
  );
};

export const assertBackupRestoreProviderContract = (
  contract,
  { requireConfigured = false } = {},
) => {
  assertExactKeys(contract, ROOT_KEYS, "Backup/restore provider contract");
  if (
    contract.schemaVersion !== 1 ||
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
  if (contract.api.backupMode !== "pitr") {
    throw new Error("Backup provider mode must be exact PITR");
  }
  assertExactKeys(
    contract.api.authentication,
    AUTH_KEYS,
    "Backup provider API authentication",
  );
  if (
    contract.api.authentication.scheme !== "bearer" ||
    contract.api.authentication.credentialEnvironmentName !==
      "FOUNDATION_BACKUP_API_TOKEN"
  ) {
    throw new Error("Backup provider API authentication is invalid");
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
    contract.api.polling,
    POLLING_KEYS,
    "Backup provider polling",
  );
  assertInteger(
    contract.api.polling.intervalMilliseconds,
    100,
    60_000,
    "Backup provider polling interval",
  );
  assertInteger(
    contract.api.polling.maximumAttempts,
    1,
    240,
    "Backup provider polling attempts",
  );
  assertExactKeys(
    contract.api.operations,
    OPERATION_NAMES,
    "Backup provider operations",
  );
  for (const name of OPERATION_NAMES) {
    assertOperation(name, contract.api.operations[name]);
  }
  assertStates(contract.api.states);

  assertExactKeys(
    contract.database,
    DATABASE_KEYS,
    "Backup database verification",
  );
  if (
    contract.database.postgresMajor !== 17 ||
    contract.database.tlsMode !== "verify-full" ||
    contract.database.integrityFunction !== BACKUP_RESTORE_INTEGRITY_FUNCTION ||
    contract.database.queryName !== BACKUP_RESTORE_INTEGRITY_QUERY_NAME
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
  if (
    contract.database.restore.allowedRoles.some((role) => sourceRoles.has(role))
  ) {
    throw new Error("Backup source and restore database roles overlap");
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
    providerContract.api.polling.intervalMilliseconds *
      providerContract.api.polling.maximumAttempts >
    backup.recoveryTimeObjectiveSeconds * 1000
  ) {
    throw new Error("Backup provider polling exceeds the configured RTO");
  }
  return Object.freeze({
    prerequisitePolicySha256: sha256Json(prerequisitePolicy),
    providerContractSha256: sha256Json(providerContract),
    backup,
    providerContract,
  });
};
