import { setTimeout as delay } from "node:timers/promises";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  assertExactKeys,
  assertImmutableObjectReference,
  isRecord,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  collectAndStoreProductionRequestGraphOidcAuthority,
  deriveBrowserPhaseExitCollectorIdentity,
  readStoredProductionRequestGraphOidcAuthority,
} from "../browser/production-request-graph.mjs";
import {
  BACKUP_RESTORE_INTEGRITY_FUNCTION,
  BACKUP_RESTORE_INTEGRITY_QUERY_NAME,
  assertConfiguredBackupRestorePolicy,
} from "./backup-restore-rehearsal-policy.mjs";

export const BACKUP_RESTORE_REHEARSAL_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.backup-restore-rehearsal-raw+json;version=1";
export const BACKUP_RESTORE_REHEARSAL_FILE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.backup-restore-rehearsal+json;version=1";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAXIMUM_RAW_BYTES = 8 * 1024 * 1024;
const MAXIMUM_RECEIPTS = 512;
const MAXIMUM_REHEARSAL_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const MAXIMUM_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000;
const EMPTY_SHA256 = sha256Bytes(Buffer.alloc(0));
const ALLOWED_OPTION_KEYS = [
  "current",
  "environment",
  "namespace",
  "oidcAuthority",
  "oidcReceipt",
  "prerequisitePolicy",
  "providerContract",
  "store",
];
const PROVIDER_RECEIPT_KEYS = [
  "completedAt",
  "contentType",
  "method",
  "operation",
  "providerRequestId",
  "requestBodyByteLength",
  "requestBodySha256",
  "responseBodyByteLength",
  "responseBodySha256",
  "startedAt",
  "status",
  "url",
];
const PROVIDER_RESULT_KEYS = ["normalized", "receipt"];
const NORMALIZED_RESPONSE_KEYS = ["recoveryPointAt", "resourceId", "state"];
const DATABASE_RECEIPT_KEYS = [
  "authorization",
  "compatibilityFingerprint",
  "database",
  "databaseHead",
  "host",
  "integritySha256",
  "observedAt",
  "postgresMajor",
  "projectRef",
  "queryName",
  "role",
  "target",
  "tlsMode",
  "transactionReadOnly",
];
const DATABASE_AUTHORIZATION_KEYS = [
  "denialProbes",
  "memberships",
  "ownedObjectCount",
  "privileges",
  "roleAttributes",
];
const DATABASE_ROLE_ATTRIBUTE_KEYS = [
  "bypassRls",
  "createDatabase",
  "createRole",
  "replication",
  "superuser",
];
const DATABASE_PRIVILEGE_KEYS = [
  "allTablesSelect",
  "anyTableDelete",
  "anyTableInsert",
  "anyTableReferences",
  "anyTableTrigger",
  "anyTableTruncate",
  "anyTableUpdate",
  "databaseCreate",
  "integrityFunctionExecute",
  "integrityFunctionSecurityDefiner",
  "schemaCreate",
  "schemaUsage",
  "tableCount",
];
const DATABASE_DENIAL_PROBE_KEYS = ["operation", "sqlState", "targetSha256"];
const DENIAL_SQL_STATE = "42501";
const RAW_KEYS = [
  "collector",
  "database",
  "kind",
  "namespace",
  "observedAt",
  "policy",
  "provider",
  "releaseStateHead",
  "schemaVersion",
  "sourceSha",
];
const POLICY_PROJECTION_KEYS = [
  "owner",
  "prerequisitePolicySha256",
  "provider",
  "providerContractSha256",
  "recoveryPointObjectiveSeconds",
  "recoveryTimeObjectiveSeconds",
  "restoreProjectRef",
  "restoredNamespace",
  "sourceProjectRef",
];
const COLLECTOR_KEYS = ["identity", "oidcReceipt"];
const PROVIDER_KEYS = [
  "backupId",
  "backupReceipts",
  "cleanupCompletedAt",
  "cleanupReceipts",
  "recoveryPointAt",
  "restoreId",
  "restoreReceipts",
];
const DATABASE_KEYS = ["expectedCompatibilityFingerprint", "restore", "source"];
const OBSERVATION_KEYS = [
  "collectorIdentity",
  "kind",
  "namespace",
  "observedAt",
  "oidcReceipt",
  "rawRehearsal",
  "releaseStateHead",
  "result",
  "schemaVersion",
  "sourceSha",
];
const RESULT_KEYS = [
  "backupCompletedAt",
  "backupId",
  "dataLossObserved",
  "integrityCheckSha256",
  "observedRecoveryPointSeconds",
  "observedRecoveryTimeSeconds",
  "outcome",
  "recoveryPointObjectiveSeconds",
  "recoveryTimeObjectiveSeconds",
  "rehearsalId",
  "restoreCompletedAt",
  "restoreStartedAt",
  "restoredHead",
  "restoredNamespace",
  "sourceHead",
];

const clockMilliseconds = (clock) => {
  const value = Number(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value))
    throw new Error("Backup rehearsal clock is invalid");
  return value;
};

const timestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
};

const assertHead = (head, label) => {
  assertExactKeys(head, ["eventHash", "sequence"], label);
  if (
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    !SHA256.test(head.eventHash ?? "")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return head;
};

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertStore = (store, namespace) => {
  if (
    store?.namespace !== namespace ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function"
  ) {
    throw new Error("Backup rehearsal immutable store binding is invalid");
  }
};

const assertNoCallerAuthority = (options) => {
  if (!isRecord(options)) {
    throw new Error("Backup rehearsal collector options are invalid");
  }
  assertExactKeys(
    options,
    ALLOWED_OPTION_KEYS,
    "Backup rehearsal collector options",
  );
};

const safeHeader = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value);
  if (
    Buffer.byteLength(normalized, "utf8") > 256 ||
    [...normalized].some((character) => character.codePointAt(0) < 0x20)
  ) {
    throw new Error("Backup provider response header is unsafe");
  }
  return normalized;
};

const renderString = (value, variables, encode) =>
  value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name) => {
    const replacement = variables[name];
    if (typeof replacement !== "string" || replacement.length === 0) {
      throw new Error(`Backup provider placeholder ${name} is absent`);
    }
    return encode ? encodeURIComponent(replacement) : replacement;
  });

const renderTemplate = (value, variables) => {
  if (typeof value === "string") {
    return /^\{[A-Za-z][A-Za-z0-9]*\}$/u.test(value)
      ? renderString(value, variables, false)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplate(entry, variables));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        renderTemplate(entry, variables),
      ]),
    );
  }
  return value;
};

const pointerValue = (value, pointer, label) => {
  let current = value;
  for (const segment of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isRecord(current) && !Array.isArray(current)) {
      throw new Error(`${label} JSON pointer has no value`);
    }
    if (!Object.hasOwn(current, segment)) {
      throw new Error(`${label} JSON pointer has no value`);
    }
    current = current[segment];
  }
  return current;
};

const expectedProviderUrl = ({
  prerequisitePolicy,
  providerContract,
  operation,
  variables,
}) => {
  const descriptor = providerContract.api.operations[operation];
  const path = renderString(descriptor.pathTemplate, variables, true);
  const url = new URL(path, prerequisitePolicy.backupRestore.apiOrigin);
  if (
    url.origin !== prerequisitePolicy.backupRestore.apiOrigin ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Backup provider operation escaped its configured API origin",
    );
  }
  return url.href;
};

const expectedProviderRequestBytes = ({
  providerContract,
  operation,
  variables,
}) => {
  const template =
    providerContract.api.operations[operation].requestBodyTemplate;
  return template === null
    ? Buffer.alloc(0)
    : canonicalJsonBytes(renderTemplate(template, variables));
};

const knownProviderStates = (states) =>
  new Set([
    ...states.backupPending,
    states.backupReady,
    ...states.restorePending,
    states.restoreReady,
    ...states.cleanupPending,
    states.cleanupReady,
    ...states.failed,
  ]);

export const executeBackupProviderOperation = async ({
  prerequisitePolicy,
  providerContract,
  operation,
  variables,
  token,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Backup provider fetch executor is unavailable");
  }
  const descriptor = providerContract.api.operations[operation];
  if (!isRecord(descriptor)) {
    throw new Error("Backup provider operation is not declared");
  }
  const url = expectedProviderUrl({
    prerequisitePolicy,
    providerContract,
    operation,
    variables,
  });
  const requestValue =
    descriptor.requestBodyTemplate === null
      ? null
      : renderTemplate(descriptor.requestBodyTemplate, variables);
  const requestBytes =
    requestValue === null ? Buffer.alloc(0) : canonicalJsonBytes(requestValue);
  const startedAt = new Date(clockMilliseconds(clock)).toISOString();
  const response = await fetchImpl(url, {
    method: descriptor.method,
    redirect: "error",
    signal: AbortSignal.timeout(
      providerContract.api.requestTimeoutMilliseconds,
    ),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(requestValue === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(requestValue === null ? {} : { body: requestBytes }),
  });
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > providerContract.api.maximumResponseBytes
  ) {
    throw new Error("Backup provider response is oversized");
  }
  const responseBytes = Buffer.from(await response.arrayBuffer());
  const completedAt = new Date(clockMilliseconds(clock)).toISOString();
  if (responseBytes.length > providerContract.api.maximumResponseBytes) {
    throw new Error("Backup provider response is oversized");
  }
  const contentType = safeHeader(response.headers.get("content-type"));
  if (
    !descriptor.successStatusCodes.includes(response.status) ||
    typeof contentType !== "string" ||
    !contentType.toLowerCase().includes("application/json") ||
    responseBytes.length === 0
  ) {
    throw new Error(`Backup provider ${operation} response is unexpected`);
  }
  const responseValue = parseJsonStrict(
    responseBytes.toString("utf8"),
    `Backup provider ${operation} response`,
  );
  const resourceId = pointerValue(
    responseValue,
    descriptor.response.resourceIdPointer,
    `Backup provider ${operation} resource ID`,
  );
  const state = pointerValue(
    responseValue,
    descriptor.response.statePointer,
    `Backup provider ${operation} state`,
  );
  const recoveryPointAt =
    descriptor.response.recoveryPointAtPointer === null
      ? null
      : pointerValue(
          responseValue,
          descriptor.response.recoveryPointAtPointer,
          `Backup provider ${operation} recovery point`,
        );
  const result = {
    receipt: {
      operation,
      method: descriptor.method,
      url,
      startedAt,
      completedAt,
      status: response.status,
      contentType,
      providerRequestId: safeHeader(
        response.headers.get("x-request-id") ??
          response.headers.get("sb-request-id"),
      ),
      requestBodySha256:
        requestBytes.length === 0 ? EMPTY_SHA256 : sha256Bytes(requestBytes),
      requestBodyByteLength: requestBytes.length,
      responseBodySha256: sha256Bytes(responseBytes),
      responseBodyByteLength: responseBytes.length,
    },
    normalized: { resourceId, state, recoveryPointAt },
  };
  return assertBackupProviderOperationResult(result, {
    prerequisitePolicy,
    providerContract,
    operation,
    variables,
  });
};

export const assertBackupProviderOperationResult = (
  result,
  { prerequisitePolicy, providerContract, operation, variables },
) => {
  assertExactKeys(result, PROVIDER_RESULT_KEYS, `Backup provider ${operation}`);
  assertExactKeys(
    result.receipt,
    PROVIDER_RECEIPT_KEYS,
    `Backup provider ${operation} receipt`,
  );
  assertExactKeys(
    result.normalized,
    NORMALIZED_RESPONSE_KEYS,
    `Backup provider ${operation} normalized response`,
  );
  const descriptor = providerContract.api.operations[operation];
  const expectedRequestBytes = expectedProviderRequestBytes({
    providerContract,
    operation,
    variables,
  });
  const startedAt = timestamp(
    result.receipt.startedAt,
    `Backup provider ${operation} start`,
  );
  const completedAt = timestamp(
    result.receipt.completedAt,
    `Backup provider ${operation} completion`,
  );
  if (
    result.receipt.operation !== operation ||
    result.receipt.method !== descriptor.method ||
    result.receipt.url !==
      expectedProviderUrl({
        prerequisitePolicy,
        providerContract,
        operation,
        variables,
      }) ||
    completedAt < startedAt ||
    !descriptor.successStatusCodes.includes(result.receipt.status) ||
    typeof result.receipt.contentType !== "string" ||
    !result.receipt.contentType.toLowerCase().includes("application/json") ||
    (result.receipt.providerRequestId !== null &&
      (typeof result.receipt.providerRequestId !== "string" ||
        result.receipt.providerRequestId.length === 0 ||
        Buffer.byteLength(result.receipt.providerRequestId, "utf8") > 256 ||
        [...result.receipt.providerRequestId].some(
          (character) => character.codePointAt(0) < 0x20,
        ))) ||
    result.receipt.requestBodySha256 !==
      (expectedRequestBytes.length === 0
        ? EMPTY_SHA256
        : sha256Bytes(expectedRequestBytes)) ||
    result.receipt.requestBodyByteLength !== expectedRequestBytes.length ||
    !SHA256.test(result.receipt.responseBodySha256 ?? "") ||
    !Number.isSafeInteger(result.receipt.responseBodyByteLength) ||
    result.receipt.responseBodyByteLength < 1 ||
    result.receipt.responseBodyByteLength >
      providerContract.api.maximumResponseBytes ||
    !OPAQUE_ID.test(result.normalized.resourceId ?? "") ||
    typeof result.normalized.state !== "string" ||
    !knownProviderStates(providerContract.api.states).has(
      result.normalized.state,
    )
  ) {
    throw new Error(`Backup provider ${operation} receipt is invalid`);
  }
  const requiresRecoveryPoint =
    descriptor.response.recoveryPointAtPointer !== null;
  if (requiresRecoveryPoint !== (result.normalized.recoveryPointAt !== null)) {
    throw new Error(
      `Backup provider ${operation} recovery point is incomplete`,
    );
  }
  if (result.normalized.recoveryPointAt !== null) {
    timestamp(
      result.normalized.recoveryPointAt,
      `Backup provider ${operation} recovery point`,
    );
  }
  return result;
};

const assertDatabaseConnection = ({
  connectionString,
  ca,
  authority,
  target,
}) => {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`Backup ${target} database URL is invalid`);
  }
  const role = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const allowedSearch =
    parsed.search === "" ||
    (parsed.searchParams.size === 1 &&
      parsed.searchParams.get("sslmode") === "verify-full");
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.password.length === 0 ||
    parsed.hash !== "" ||
    !allowedSearch ||
    !authority.allowedHosts.includes(parsed.hostname.toLowerCase()) ||
    !authority.allowedDatabases.includes(database) ||
    !authority.allowedRoles.includes(role) ||
    sha256Bytes(Buffer.from(ca, "utf8")) !== authority.caSha256
  ) {
    throw new Error(
      `Backup ${target} database connection differs from configured authority`,
    );
  }
  return {
    connectionString,
    ca,
    projection: {
      host: parsed.hostname.toLowerCase(),
      database,
      role,
    },
  };
};

const quotePostgresIdentifier = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Backup denial probe identifier is invalid");
  }
  return `"${value.replaceAll('"', '""')}"`;
};

const executePrivilegeDenialProbe = async ({
  client,
  operation,
  statement,
  target,
}) => {
  let began = false;
  let primaryError = null;
  let receipt = null;
  try {
    await client.query(
      "begin transaction isolation level read committed read write",
    );
    began = true;
    try {
      await client.query(statement);
      primaryError = new Error(
        `Backup database ${operation} denial probe unexpectedly succeeded`,
      );
    } catch (error) {
      if (error?.code !== DENIAL_SQL_STATE) {
        primaryError = error;
      } else {
        receipt = {
          operation,
          sqlState: error.code,
          targetSha256: sha256Json(target),
        };
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (began) {
      try {
        await client.query("rollback");
      } catch (error) {
        if (primaryError === null) primaryError = error;
        else {
          primaryError = new AggregateError(
            [primaryError, error],
            `Backup database ${operation} denial and rollback both failed`,
          );
        }
      }
    }
  }
  if (primaryError !== null) throw primaryError;
  return receipt;
};

export const observeBackupRestoreDatabase = async ({
  connection,
  authority,
  databaseContract,
  target,
  projectRef,
  clock = Date.now,
  createClient,
}) => {
  const makeClient =
    createClient ??
    (async (options) => {
      const { Client } = await import("pg");
      return new Client(options);
    });
  const client = await makeClient({
    connectionString: connection.connectionString,
    ssl: { ca: connection.ca, rejectUnauthorized: true },
    application_name: `foundation-backup-${target}-integrity`,
    connectionTimeoutMillis: databaseContract.connectTimeoutMilliseconds,
    statement_timeout: databaseContract.statementTimeoutMilliseconds,
  });
  let began = false;
  try {
    await client.connect();
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    began = true;
    const identity = await client.query({
      name: `${BACKUP_RESTORE_INTEGRITY_QUERY_NAME}-identity`,
      text: "select current_user as role, session_user as session_role, current_database() as database, current_setting('transaction_read_only') as read_only, current_setting('server_version_num') as server_version_num",
      values: [],
    });
    const observedIdentity = identity?.rows?.[0];
    if (
      identity?.rows?.length !== 1 ||
      observedIdentity.role !== connection.projection.role ||
      observedIdentity.session_role !== connection.projection.role ||
      observedIdentity.database !== connection.projection.database ||
      observedIdentity.read_only !== "on" ||
      Math.floor(Number(observedIdentity.server_version_num) / 10_000) !==
        databaseContract.postgresMajor
    ) {
      throw new Error(`Backup ${target} database identity differs`);
    }
    assertExactKeys(
      observedIdentity,
      ["database", "read_only", "role", "server_version_num", "session_role"],
      `Backup ${target} database identity`,
    );
    const [roleResult, membershipResult, ownershipResult, privilegeResult] =
      await Promise.all([
        client.query({
          name: `${BACKUP_RESTORE_INTEGRITY_QUERY_NAME}-role-authority`,
          text: "select rolsuper as superuser, rolcreaterole as create_role, rolcreatedb as create_database, rolreplication as replication, rolbypassrls as bypass_rls from pg_catalog.pg_roles where rolname = current_user",
          values: [],
        }),
        client.query({
          name: `${BACKUP_RESTORE_INTEGRITY_QUERY_NAME}-memberships`,
          text: "select rolname as role from pg_catalog.pg_roles where rolname <> current_user and pg_catalog.pg_has_role(current_user, oid, 'MEMBER') order by rolname",
          values: [],
        }),
        client.query({
          name: `${BACKUP_RESTORE_INTEGRITY_QUERY_NAME}-ownership`,
          text: "select ((select count(*) from pg_catalog.pg_class where relowner = role.oid) + (select count(*) from pg_catalog.pg_proc where proowner = role.oid) + (select count(*) from pg_catalog.pg_namespace where nspowner = role.oid) + (select count(*) from pg_catalog.pg_type where typowner = role.oid) + (select count(*) from pg_catalog.pg_database where datdba = role.oid) + (select count(*) from pg_catalog.pg_extension where extowner = role.oid))::text as owned_object_count from pg_catalog.pg_roles role where role.rolname = current_user",
          values: [],
        }),
        client.query({
          name: `${BACKUP_RESTORE_INTEGRITY_QUERY_NAME}-privileges`,
          text: `with public_tables as (select c.oid, n.nspname as schema_name, c.relname as relation_name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.oid) select (select count(*)::text from public_tables) as table_count, (select schema_name from public_tables limit 1) as first_relation_schema, (select relation_name from public_tables limit 1) as first_relation_name, pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE') as schema_usage, pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') as schema_create, pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') as database_create, (select coalesce(bool_and(pg_catalog.has_table_privilege(current_user, oid, 'SELECT')), true) from public_tables) as all_tables_select, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'INSERT')), false) from public_tables) as any_table_insert, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'UPDATE')), false) from public_tables) as any_table_update, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'DELETE')), false) from public_tables) as any_table_delete, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'TRUNCATE')), false) from public_tables) as any_table_truncate, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'REFERENCES')), false) from public_tables) as any_table_references, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'TRIGGER')), false) from public_tables) as any_table_trigger, pg_catalog.has_function_privilege(current_user, pg_catalog.to_regprocedure('public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()'), 'EXECUTE') as integrity_function_execute, (select prosecdef from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()')) as integrity_function_security_definer`,
          values: [],
        }),
      ]);
    const roleRow = roleResult?.rows?.[0];
    const ownershipRow = ownershipResult?.rows?.[0];
    const privilegeRow = privilegeResult?.rows?.[0];
    if (
      roleResult?.rows?.length !== 1 ||
      ownershipResult?.rows?.length !== 1 ||
      privilegeResult?.rows?.length !== 1 ||
      !Array.isArray(membershipResult?.rows) ||
      membershipResult.rows.some(
        (row) =>
          Object.keys(row).length !== 1 ||
          typeof row.role !== "string" ||
          row.role.length === 0,
      )
    ) {
      throw new Error(
        `Backup ${target} database authorization result is invalid`,
      );
    }
    assertExactKeys(
      roleRow,
      [
        "bypass_rls",
        "create_database",
        "create_role",
        "replication",
        "superuser",
      ],
      `Backup ${target} database role authority`,
    );
    assertExactKeys(
      ownershipRow,
      ["owned_object_count"],
      `Backup ${target} database ownership`,
    );
    assertExactKeys(
      privilegeRow,
      [
        "all_tables_select",
        "any_table_delete",
        "any_table_insert",
        "any_table_references",
        "any_table_trigger",
        "any_table_truncate",
        "any_table_update",
        "database_create",
        "first_relation_name",
        "first_relation_schema",
        "integrity_function_execute",
        "integrity_function_security_definer",
        "schema_create",
        "schema_usage",
        "table_count",
      ],
      `Backup ${target} database privileges`,
    );
    const tableCount = Number(privilegeRow.table_count);
    const memberships = membershipResult.rows.map(({ role }) => role);
    const ownedObjectCount = Number(ownershipRow.owned_object_count);
    const roleAttributes = {
      superuser: roleRow.superuser,
      createRole: roleRow.create_role,
      createDatabase: roleRow.create_database,
      replication: roleRow.replication,
      bypassRls: roleRow.bypass_rls,
    };
    const privileges = {
      schemaUsage: privilegeRow.schema_usage,
      schemaCreate: privilegeRow.schema_create,
      databaseCreate: privilegeRow.database_create,
      tableCount,
      allTablesSelect: privilegeRow.all_tables_select,
      anyTableInsert: privilegeRow.any_table_insert,
      anyTableUpdate: privilegeRow.any_table_update,
      anyTableDelete: privilegeRow.any_table_delete,
      anyTableTruncate: privilegeRow.any_table_truncate,
      anyTableReferences: privilegeRow.any_table_references,
      anyTableTrigger: privilegeRow.any_table_trigger,
      integrityFunctionExecute: privilegeRow.integrity_function_execute,
      integrityFunctionSecurityDefiner:
        privilegeRow.integrity_function_security_definer,
    };
    if (
      Object.values(roleAttributes).some((value) => value !== false) ||
      memberships.length !== 0 ||
      !Number.isSafeInteger(ownedObjectCount) ||
      ownedObjectCount !== 0 ||
      !Number.isSafeInteger(tableCount) ||
      tableCount < 1 ||
      privilegeRow.first_relation_schema !== "public" ||
      typeof privilegeRow.first_relation_name !== "string" ||
      privilegeRow.first_relation_name.length === 0 ||
      privileges.schemaUsage !== true ||
      privileges.schemaCreate !== false ||
      privileges.databaseCreate !== false ||
      [
        privileges.anyTableInsert,
        privileges.anyTableUpdate,
        privileges.anyTableDelete,
        privileges.anyTableTruncate,
        privileges.anyTableReferences,
        privileges.anyTableTrigger,
      ].some((value) => value !== false) ||
      privileges.integrityFunctionExecute !== true ||
      privileges.integrityFunctionSecurityDefiner !== true
    ) {
      throw new Error(
        `Backup ${target} database role is not least-privilege read-only`,
      );
    }
    const result = await client.query({
      name: BACKUP_RESTORE_INTEGRITY_QUERY_NAME,
      text: `select database_head, compatibility_fingerprint, integrity_sha256 from public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()`,
      values: [],
    });
    if (result?.rows?.length !== 1) {
      throw new Error(`Backup ${target} database integrity result is invalid`);
    }
    const row = result.rows[0];
    assertExactKeys(
      row,
      ["compatibility_fingerprint", "database_head", "integrity_sha256"],
      `Backup ${target} database integrity row`,
    );
    await client.query("commit");
    began = false;
    const dmlTarget = {
      schema: privilegeRow.first_relation_schema,
      relation: privilegeRow.first_relation_name,
    };
    const ddlTarget = {
      schema: "public",
      relation: `foundation_backup_restore_denial_${sha256Json({ projectRef, target, role: connection.projection.role }).slice(0, 12)}`,
    };
    const denialProbes = [];
    denialProbes.push(
      await executePrivilegeDenialProbe({
        client,
        operation: "delete-known-public-table",
        statement: `delete from ${quotePostgresIdentifier(dmlTarget.schema)}.${quotePostgresIdentifier(dmlTarget.relation)} where false`,
        target: dmlTarget,
      }),
    );
    denialProbes.push(
      await executePrivilegeDenialProbe({
        client,
        operation: "create-public-table",
        statement: `create table ${quotePostgresIdentifier(ddlTarget.schema)}.${quotePostgresIdentifier(ddlTarget.relation)} (probe integer)`,
        target: ddlTarget,
      }),
    );
    const receipt = {
      target,
      projectRef,
      host: connection.projection.host,
      database: connection.projection.database,
      role: connection.projection.role,
      tlsMode: "verify-full",
      transactionReadOnly: true,
      postgresMajor: databaseContract.postgresMajor,
      queryName: BACKUP_RESTORE_INTEGRITY_QUERY_NAME,
      observedAt: new Date(clockMilliseconds(clock)).toISOString(),
      authorization: {
        roleAttributes,
        memberships,
        ownedObjectCount,
        privileges,
        denialProbes,
      },
      databaseHead: row.database_head,
      compatibilityFingerprint: row.compatibility_fingerprint,
      integritySha256: row.integrity_sha256,
    };
    return assertBackupDatabaseReceipt(receipt, {
      target,
      projectRef,
      authority,
      expectedFingerprint: row.compatibility_fingerprint,
    });
  } catch (error) {
    if (began) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the authoritative verification failure.
      }
    }
    throw error;
  } finally {
    await client.end();
  }
};

export const assertBackupDatabaseReceipt = (
  receipt,
  { target, projectRef, authority, expectedFingerprint },
) => {
  assertExactKeys(
    receipt,
    DATABASE_RECEIPT_KEYS,
    `Backup ${target} database receipt`,
  );
  const authorization = receipt.authorization;
  assertExactKeys(
    authorization,
    DATABASE_AUTHORIZATION_KEYS,
    `Backup ${target} database authorization`,
  );
  assertExactKeys(
    authorization.roleAttributes,
    DATABASE_ROLE_ATTRIBUTE_KEYS,
    `Backup ${target} database role attributes`,
  );
  assertExactKeys(
    authorization.privileges,
    DATABASE_PRIVILEGE_KEYS,
    `Backup ${target} database privileges`,
  );
  if (
    Object.values(authorization.roleAttributes).some(
      (value) => value !== false,
    ) ||
    !Array.isArray(authorization.memberships) ||
    authorization.memberships.length !== 0 ||
    authorization.ownedObjectCount !== 0 ||
    !Number.isSafeInteger(authorization.privileges.tableCount) ||
    authorization.privileges.tableCount < 1 ||
    authorization.privileges.schemaUsage !== true ||
    authorization.privileges.schemaCreate !== false ||
    authorization.privileges.databaseCreate !== false ||
    [
      authorization.privileges.anyTableInsert,
      authorization.privileges.anyTableUpdate,
      authorization.privileges.anyTableDelete,
      authorization.privileges.anyTableTruncate,
      authorization.privileges.anyTableReferences,
      authorization.privileges.anyTableTrigger,
    ].some((value) => value !== false) ||
    typeof authorization.privileges.allTablesSelect !== "boolean" ||
    authorization.privileges.integrityFunctionExecute !== true ||
    authorization.privileges.integrityFunctionSecurityDefiner !== true ||
    !Array.isArray(authorization.denialProbes) ||
    authorization.denialProbes.length !== 2
  ) {
    throw new Error(`Backup ${target} database authorization is invalid`);
  }
  const expectedDenialOperations = [
    "delete-known-public-table",
    "create-public-table",
  ];
  authorization.denialProbes.forEach((probe, index) => {
    assertExactKeys(
      probe,
      DATABASE_DENIAL_PROBE_KEYS,
      `Backup ${target} database denial probe`,
    );
    if (
      probe.operation !== expectedDenialOperations[index] ||
      probe.sqlState !== DENIAL_SQL_STATE ||
      !SHA256.test(probe.targetSha256 ?? "")
    ) {
      throw new Error(`Backup ${target} database denial probe is invalid`);
    }
  });
  timestamp(receipt.observedAt, `Backup ${target} database observation`);
  if (
    receipt.target !== target ||
    receipt.projectRef !== projectRef ||
    !authority.allowedHosts.includes(receipt.host) ||
    !authority.allowedDatabases.includes(receipt.database) ||
    !authority.allowedRoles.includes(receipt.role) ||
    receipt.tlsMode !== "verify-full" ||
    receipt.transactionReadOnly !== true ||
    receipt.postgresMajor !== 17 ||
    receipt.queryName !== BACKUP_RESTORE_INTEGRITY_QUERY_NAME ||
    !SHA256.test(receipt.databaseHead ?? "") ||
    receipt.compatibilityFingerprint !== expectedFingerprint ||
    !SHA256.test(receipt.integritySha256 ?? "")
  ) {
    throw new Error(`Backup ${target} database receipt is invalid`);
  }
  return receipt;
};

const requireCredential = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length < 8) {
    throw new Error(`Backup rehearsal credential is absent: ${name}`);
  }
  return value;
};

const resolveCredentials = ({ environment, providerContract }) => {
  const token = requireCredential(
    environment,
    providerContract.api.authentication.credentialEnvironmentName,
  );
  const sourceAuthority = providerContract.database.source;
  const restoreAuthority = providerContract.database.restore;
  const source = assertDatabaseConnection({
    connectionString: requireCredential(
      environment,
      sourceAuthority.databaseUrlEnvironmentName,
    ),
    ca: requireCredential(
      environment,
      sourceAuthority.databaseCaEnvironmentName,
    ),
    authority: sourceAuthority,
    target: "source",
  });
  const restore = assertDatabaseConnection({
    connectionString: requireCredential(
      environment,
      restoreAuthority.databaseUrlEnvironmentName,
    ),
    ca: requireCredential(
      environment,
      restoreAuthority.databaseCaEnvironmentName,
    ),
    authority: restoreAuthority,
    target: "restore",
  });
  if (
    source.connectionString === restore.connectionString ||
    source.projection.role === restore.projection.role
  ) {
    throw new Error("Backup source and restore database authorities overlap");
  }
  return {
    token,
    source,
    restore,
    secretValues: [
      token,
      source.connectionString,
      source.ca,
      restore.connectionString,
      restore.ca,
    ],
  };
};

const restoredNamespaceFor = ({ prefix, sourceSha, runId, runAttempt }) => {
  const suffix = sha256Json({ sourceSha, runId, runAttempt }).slice(0, 12);
  const namespace = `${prefix}-${suffix}`;
  if (!NAMESPACE.test(namespace)) {
    throw new Error("Backup restore namespace is invalid");
  }
  return namespace;
};

const assertLifecycleState = (state, { pending, ready, failed, label }) => {
  if (state === ready) return "ready";
  if (pending.includes(state)) return "pending";
  if (failed.includes(state)) {
    throw new Error(`${label} entered a provider failure state`);
  }
  throw new Error(`${label} returned an unknown provider state`);
};

const pollProviderResource = async ({
  initial,
  getOperation,
  variables,
  execute,
  pending,
  ready,
  failed,
  label,
  maximumAttempts,
  intervalMilliseconds,
  sleep,
}) => {
  const receipts = [initial];
  const resourceId = initial.normalized.resourceId;
  let current = initial;
  let attempts = 0;
  while (
    assertLifecycleState(current.normalized.state, {
      pending,
      ready,
      failed,
      label,
    }) === "pending"
  ) {
    if (attempts >= maximumAttempts) {
      throw new Error(`${label} polling exceeded the configured maximum`);
    }
    attempts += 1;
    await sleep(intervalMilliseconds);
    current = await execute(getOperation, variables(resourceId));
    if (current.normalized.resourceId !== resourceId) {
      throw new Error(`${label} immutable provider ID changed while polling`);
    }
    receipts.push(current);
  }
  return { final: current, receipts, resourceId };
};

const assertSecretSafeBytes = (bytes, secrets) => {
  for (const secret of secrets) {
    if (
      typeof secret === "string" &&
      secret.length >= 8 &&
      bytes.includes(Buffer.from(secret, "utf8"))
    ) {
      throw new Error("Backup rehearsal raw authority contains a credential");
    }
  }
};

const assertRawReceiptList = ({
  receipts,
  operations,
  prerequisitePolicy,
  providerContract,
  variablesFor,
  resourceId,
  recoveryPointAt,
  pending,
  ready,
}) => {
  if (
    !Array.isArray(receipts) ||
    receipts.length < 1 ||
    receipts.length > MAXIMUM_RECEIPTS
  ) {
    throw new Error("Backup provider receipt list is invalid");
  }
  receipts.forEach((result, index) => {
    const operation = operations.includes(result?.receipt?.operation)
      ? result.receipt.operation
      : null;
    if (operation === null) {
      throw new Error("Backup provider receipt operation is invalid");
    }
    assertBackupProviderOperationResult(result, {
      prerequisitePolicy,
      providerContract,
      operation,
      variables: variablesFor(result, index),
    });
    if (
      result.normalized.resourceId !== resourceId ||
      result.normalized.recoveryPointAt !== recoveryPointAt ||
      (index === receipts.length - 1
        ? result.normalized.state !== ready
        : !pending.includes(result.normalized.state))
    ) {
      throw new Error("Backup provider receipt lifecycle is invalid");
    }
  });
};

export const assertBackupRestoreRehearsalRaw = (
  raw,
  { prerequisitePolicy, providerContract },
) => {
  const configured = assertConfiguredBackupRestorePolicy({
    prerequisitePolicy,
    providerContract,
  });
  assertExactKeys(raw, RAW_KEYS, "Backup rehearsal raw authority");
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== "backup-restore-rehearsal-raw/v1" ||
    !NAMESPACE.test(raw.namespace ?? "") ||
    !SOURCE_SHA.test(raw.sourceSha ?? "")
  ) {
    throw new Error("Backup rehearsal raw identity is invalid");
  }
  timestamp(raw.observedAt, "Backup rehearsal observation");
  assertHead(raw.releaseStateHead, "Backup rehearsal Release State head");
  assertExactKeys(
    raw.policy,
    POLICY_PROJECTION_KEYS,
    "Backup rehearsal policy",
  );
  const backup = configured.backup;
  if (
    raw.policy.prerequisitePolicySha256 !==
      configured.prerequisitePolicySha256 ||
    raw.policy.providerContractSha256 !== configured.providerContractSha256 ||
    raw.policy.provider !== backup.provider ||
    raw.policy.sourceProjectRef !== backup.sourceProjectRef ||
    raw.policy.restoreProjectRef !== backup.restoreTarget.projectRef ||
    raw.policy.owner !== backup.owner ||
    raw.policy.recoveryPointObjectiveSeconds !==
      backup.recoveryPointObjectiveSeconds ||
    raw.policy.recoveryTimeObjectiveSeconds !==
      backup.recoveryTimeObjectiveSeconds ||
    !NAMESPACE.test(raw.policy.restoredNamespace ?? "") ||
    !raw.policy.restoredNamespace.startsWith(
      `${backup.restoreTarget.namespacePrefix}-`,
    ) ||
    raw.policy.restoredNamespace === raw.namespace
  ) {
    throw new Error("Backup rehearsal raw policy binding differs");
  }
  assertExactKeys(raw.collector, COLLECTOR_KEYS, "Backup rehearsal collector");
  assertBrowserPhaseExitCollectorIdentity(
    raw.collector.identity,
    raw.sourceSha,
  );
  assertImmutableObjectReference(
    raw.collector.oidcReceipt,
    raw.namespace,
    "Backup rehearsal OIDC receipt",
  );
  assertExactKeys(raw.provider, PROVIDER_KEYS, "Backup rehearsal provider");
  if (
    !OPAQUE_ID.test(raw.provider.backupId ?? "") ||
    !OPAQUE_ID.test(raw.provider.restoreId ?? "")
  ) {
    throw new Error("Backup rehearsal provider resource identity is invalid");
  }
  timestamp(raw.provider.recoveryPointAt, "Backup rehearsal recovery point");
  timestamp(raw.provider.cleanupCompletedAt, "Backup rehearsal cleanup");
  const state = providerContract.api.states;
  assertRawReceiptList({
    receipts: raw.provider.backupReceipts,
    operations: ["createBackup", "getBackup"],
    prerequisitePolicy,
    providerContract,
    resourceId: raw.provider.backupId,
    recoveryPointAt: raw.provider.recoveryPointAt,
    pending: state.backupPending,
    ready: state.backupReady,
    variablesFor: () => ({
      sourceProjectRef: raw.policy.sourceProjectRef,
      backupId: raw.provider.backupId,
    }),
  });
  assertRawReceiptList({
    receipts: raw.provider.restoreReceipts,
    operations: ["restoreBackup", "getRestore"],
    prerequisitePolicy,
    providerContract,
    resourceId: raw.provider.restoreId,
    recoveryPointAt: null,
    pending: state.restorePending,
    ready: state.restoreReady,
    variablesFor: () => ({
      backupId: raw.provider.backupId,
      restoreProjectRef: raw.policy.restoreProjectRef,
      restoreId: raw.provider.restoreId,
    }),
  });
  assertRawReceiptList({
    receipts: raw.provider.cleanupReceipts,
    operations: ["cleanupRestore", "getCleanup"],
    prerequisitePolicy,
    providerContract,
    resourceId: raw.provider.restoreId,
    recoveryPointAt: null,
    pending: state.cleanupPending,
    ready: state.cleanupReady,
    variablesFor: () => ({
      restoreProjectRef: raw.policy.restoreProjectRef,
      restoreId: raw.provider.restoreId,
    }),
  });
  for (const [receipts, firstOperation, pollOperation] of [
    [raw.provider.backupReceipts, "createBackup", "getBackup"],
    [raw.provider.restoreReceipts, "restoreBackup", "getRestore"],
    [raw.provider.cleanupReceipts, "cleanupRestore", "getCleanup"],
  ]) {
    if (
      receipts[0].receipt.operation !== firstOperation ||
      receipts
        .slice(1)
        .some(({ receipt }) => receipt.operation !== pollOperation)
    ) {
      throw new Error("Backup provider receipt sequence is invalid");
    }
  }
  if (
    raw.provider.cleanupCompletedAt !==
    raw.provider.cleanupReceipts.at(-1).receipt.completedAt
  ) {
    throw new Error("Backup provider cleanup completion differs");
  }
  const backupCompleted = timestamp(
    raw.provider.backupReceipts.at(-1).receipt.completedAt,
    "Backup provider backup completion",
  );
  const restoreStarted = timestamp(
    raw.provider.restoreReceipts[0].receipt.startedAt,
    "Backup provider restore start",
  );
  const restoreCompleted = timestamp(
    raw.provider.restoreReceipts.at(-1).receipt.completedAt,
    "Backup provider restore completion",
  );
  const cleanupStarted = timestamp(
    raw.provider.cleanupReceipts[0].receipt.startedAt,
    "Backup provider cleanup start",
  );
  if (
    backupCompleted > restoreStarted ||
    restoreStarted >= restoreCompleted ||
    restoreCompleted > cleanupStarted ||
    timestamp(raw.observedAt, "Backup rehearsal observation") !==
      timestamp(
        raw.provider.cleanupCompletedAt,
        "Backup provider cleanup completion",
      )
  ) {
    throw new Error("Backup provider lifecycle chronology is invalid");
  }
  assertExactKeys(raw.database, DATABASE_KEYS, "Backup rehearsal database");
  if (
    raw.database.expectedCompatibilityFingerprint !==
    raw.database.source.compatibilityFingerprint
  ) {
    throw new Error("Backup rehearsal expected DB fingerprint differs");
  }
  assertBackupDatabaseReceipt(raw.database.source, {
    target: "source",
    projectRef: raw.policy.sourceProjectRef,
    authority: providerContract.database.source,
    expectedFingerprint: raw.database.expectedCompatibilityFingerprint,
  });
  assertBackupDatabaseReceipt(raw.database.restore, {
    target: "restore",
    projectRef: raw.policy.restoreProjectRef,
    authority: providerContract.database.restore,
    expectedFingerprint: raw.database.expectedCompatibilityFingerprint,
  });
  if (
    raw.database.source.role === raw.database.restore.role ||
    raw.database.source.databaseHead !== raw.database.restore.databaseHead ||
    raw.database.source.integritySha256 !==
      raw.database.restore.integritySha256 ||
    raw.database.source.compatibilityFingerprint !==
      raw.database.restore.compatibilityFingerprint
  ) {
    throw new Error("Backup restored database integrity differs from source");
  }
  for (const receipt of [raw.database.source, raw.database.restore]) {
    const observedAt = timestamp(
      receipt.observedAt,
      `Backup ${receipt.target} database observation`,
    );
    if (observedAt < restoreCompleted || observedAt > cleanupStarted) {
      throw new Error("Backup database observation is outside restore closure");
    }
  }
  return raw;
};

export const summarizeBackupRestoreRehearsal = (
  raw,
  { prerequisitePolicy, providerContract },
) => {
  assertBackupRestoreRehearsalRaw(raw, {
    prerequisitePolicy,
    providerContract,
  });
  const backupCompletedAt =
    raw.provider.backupReceipts.at(-1).receipt.completedAt;
  const restoreStartedAt = raw.provider.restoreReceipts[0].receipt.startedAt;
  const restoreCompletedAt =
    raw.provider.restoreReceipts.at(-1).receipt.completedAt;
  const databaseVerifiedAt = Math.max(
    timestamp(
      raw.database.source.observedAt,
      "Backup source database verification",
    ),
    timestamp(
      raw.database.restore.observedAt,
      "Backup restored database verification",
    ),
  );
  const recoveryPointMilliseconds = timestamp(
    raw.provider.recoveryPointAt,
    "Backup rehearsal recovery point",
  );
  const backupRequestMilliseconds = timestamp(
    raw.provider.backupReceipts[0].receipt.startedAt,
    "Backup rehearsal backup start",
  );
  const observedRecoveryPointSeconds = Math.ceil(
    (backupRequestMilliseconds - recoveryPointMilliseconds) / 1000,
  );
  const observedRecoveryTimeSeconds = Math.ceil(
    (databaseVerifiedAt -
      timestamp(restoreStartedAt, "Backup rehearsal restore start")) /
      1000,
  );
  if (
    observedRecoveryPointSeconds < 0 ||
    observedRecoveryPointSeconds > raw.policy.recoveryPointObjectiveSeconds ||
    observedRecoveryTimeSeconds < 0 ||
    observedRecoveryTimeSeconds > raw.policy.recoveryTimeObjectiveSeconds
  ) {
    throw new Error("Backup rehearsal exceeds its RPO or RTO");
  }
  const databaseComparison = {
    expectedCompatibilityFingerprint:
      raw.database.expectedCompatibilityFingerprint,
    source: raw.database.source,
    restore: raw.database.restore,
  };
  const result = {
    rehearsalId: sha256Json({
      namespace: raw.namespace,
      sourceSha: raw.sourceSha,
      releaseStateHead: raw.releaseStateHead,
      backupId: raw.provider.backupId,
      restoreId: raw.provider.restoreId,
    }),
    backupId: raw.provider.backupId,
    backupCompletedAt,
    restoreStartedAt,
    restoreCompletedAt,
    restoredNamespace: raw.policy.restoredNamespace,
    sourceHead: { ...raw.releaseStateHead },
    restoredHead: { ...raw.releaseStateHead },
    integrityCheckSha256: sha256Json(databaseComparison),
    recoveryPointObjectiveSeconds: raw.policy.recoveryPointObjectiveSeconds,
    observedRecoveryPointSeconds,
    recoveryTimeObjectiveSeconds: raw.policy.recoveryTimeObjectiveSeconds,
    observedRecoveryTimeSeconds,
    dataLossObserved: false,
    outcome: "succeeded",
  };
  return assertBackupRestoreRehearsalResult(result, {
    releaseStateHead: raw.releaseStateHead,
    namespace: raw.namespace,
  });
};

export const assertBackupRestoreRehearsalResult = (
  result,
  { releaseStateHead, namespace },
) => {
  assertExactKeys(result, RESULT_KEYS, "Backup rehearsal result");
  for (const key of [
    "backupCompletedAt",
    "restoreStartedAt",
    "restoreCompletedAt",
  ]) {
    timestamp(result[key], `Backup rehearsal result ${key}`);
  }
  if (
    !SHA256.test(result.rehearsalId ?? "") ||
    !OPAQUE_ID.test(result.backupId ?? "") ||
    !NAMESPACE.test(result.restoredNamespace ?? "") ||
    result.restoredNamespace === namespace ||
    !sameCanonicalValue(result.sourceHead, releaseStateHead) ||
    !sameCanonicalValue(result.restoredHead, releaseStateHead) ||
    !SHA256.test(result.integrityCheckSha256 ?? "") ||
    result.dataLossObserved !== false ||
    result.outcome !== "succeeded"
  ) {
    throw new Error("Backup rehearsal result identity differs");
  }
  for (const key of [
    "recoveryPointObjectiveSeconds",
    "observedRecoveryPointSeconds",
    "recoveryTimeObjectiveSeconds",
    "observedRecoveryTimeSeconds",
  ]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) {
      throw new Error(`Backup rehearsal result ${key} is invalid`);
    }
  }
  if (
    result.observedRecoveryPointSeconds >
      result.recoveryPointObjectiveSeconds ||
    result.observedRecoveryTimeSeconds > result.recoveryTimeObjectiveSeconds
  ) {
    throw new Error("Backup rehearsal result exceeds its objectives");
  }
  return result;
};

export const readStoredBackupRestoreRehearsal = async ({
  store,
  namespace,
  reference,
  prerequisitePolicy,
  providerContract,
}) => {
  assertStore(store, namespace);
  assertImmutableObjectReference(
    reference,
    namespace,
    "Backup rehearsal raw reference",
  );
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length < 1 ||
    stored.bytes.length > MAXIMUM_RAW_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== BACKUP_RESTORE_REHEARSAL_RAW_MEDIA_TYPE ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error("Stored backup rehearsal authority differs");
  }
  timestamp(stored.committedAt, "Backup rehearsal immutable commit");
  const raw = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Stored backup rehearsal authority",
  );
  if (!canonicalJsonBytes(raw).equals(stored.bytes)) {
    throw new Error("Stored backup rehearsal authority is not canonical JSON");
  }
  return {
    bytes: Buffer.from(stored.bytes),
    committedAt: stored.committedAt,
    raw,
    result: summarizeBackupRestoreRehearsal(raw, {
      prerequisitePolicy,
      providerContract,
    }),
  };
};

export const putBackupRestoreRehearsal = async ({
  store,
  raw,
  prerequisitePolicy,
  providerContract,
  secretValues = [],
}) => {
  summarizeBackupRestoreRehearsal(raw, {
    prerequisitePolicy,
    providerContract,
  });
  assertStore(store, raw.namespace);
  const bytes = canonicalJsonBytes(raw);
  if (bytes.length < 1 || bytes.length > MAXIMUM_RAW_BYTES) {
    throw new Error("Backup rehearsal raw authority is oversized");
  }
  assertSecretSafeBytes(bytes, secretValues);
  const reference = referenceFor(raw.namespace, bytes);
  const receipt = await store.putEvidence({
    bytes,
    mediaType: BACKUP_RESTORE_REHEARSAL_RAW_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== BACKUP_RESTORE_REHEARSAL_RAW_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string"
  ) {
    throw new Error("Backup rehearsal immutable receipt differs");
  }
  const readback = await readStoredBackupRestoreRehearsal({
    store,
    namespace: raw.namespace,
    reference,
    prerequisitePolicy,
    providerContract,
  });
  if (
    !readback.bytes.equals(bytes) ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error("Backup rehearsal immutable readback differs");
  }
  return { reference, readback };
};

export const assertBackupRestoreRehearsalObservation = (observation) => {
  assertExactKeys(
    observation,
    OBSERVATION_KEYS,
    "Backup rehearsal observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.kind !== "backup-restore-rehearsal-observation/v1" ||
    !NAMESPACE.test(observation.namespace ?? "") ||
    !SOURCE_SHA.test(observation.sourceSha ?? "")
  ) {
    throw new Error("Backup rehearsal observation identity is invalid");
  }
  timestamp(observation.observedAt, "Backup rehearsal observation time");
  assertBrowserPhaseExitCollectorIdentity(
    observation.collectorIdentity,
    observation.sourceSha,
  );
  assertHead(
    observation.releaseStateHead,
    "Backup rehearsal observation Release State head",
  );
  assertImmutableObjectReference(
    observation.oidcReceipt,
    observation.namespace,
    "Backup rehearsal observation OIDC receipt",
  );
  assertImmutableObjectReference(
    observation.rawRehearsal,
    observation.namespace,
    "Backup rehearsal raw authority",
  );
  assertBackupRestoreRehearsalResult(observation.result, {
    releaseStateHead: observation.releaseStateHead,
    namespace: observation.namespace,
  });
  return observation;
};

export const readStoredBackupRestoreRehearsalAuthority = async (
  {
    store,
    namespace,
    reference,
    prerequisitePolicy,
    providerContract,
    current,
    approvalPolicy,
    now = Date.now,
  },
  { readOidcAuthority = readStoredProductionRequestGraphOidcAuthority } = {},
) => {
  const stored = await readStoredBackupRestoreRehearsal({
    store,
    namespace,
    reference,
    prerequisitePolicy,
    providerContract,
  });
  const nowMilliseconds = clockMilliseconds(now);
  const observedAt = timestamp(
    stored.raw.observedAt,
    "Stored backup rehearsal observation",
  );
  if (
    observedAt < nowMilliseconds - MAXIMUM_REHEARSAL_AGE_MILLISECONDS ||
    observedAt > nowMilliseconds + MAXIMUM_FUTURE_SKEW_MILLISECONDS
  ) {
    throw new Error("Stored backup rehearsal authority is stale or future");
  }
  if (
    !sameCanonicalValue(stored.raw.releaseStateHead, current?.head) ||
    stored.raw.database.expectedCompatibilityFingerprint !==
      current?.snapshot?.currentDbCompatibility?.fingerprint
  ) {
    throw new Error(
      "Stored backup rehearsal differs from current Release State authority",
    );
  }
  await readOidcAuthority({
    store,
    namespace,
    reference: stored.raw.collector.oidcReceipt,
    approvalPolicy,
    sourceSha: stored.raw.sourceSha,
    runId: stored.raw.collector.identity.runId,
    runAttempt: stored.raw.collector.identity.runAttempt,
  });
  return stored;
};

export const collectAndStoreBackupRestoreRehearsal = async (
  options,
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    executeProviderOperation = executeBackupProviderOperation,
    observeDatabase = observeBackupRestoreDatabase,
    sleep = (milliseconds) => delay(milliseconds),
    clock = Date.now,
    readState = null,
  } = {},
) => {
  assertNoCallerAuthority(options);
  const configured = assertConfiguredBackupRestorePolicy({
    prerequisitePolicy: options.prerequisitePolicy,
    providerContract: options.providerContract,
  });
  const {
    current,
    environment,
    namespace,
    oidcAuthority,
    oidcReceipt,
    prerequisitePolicy,
    providerContract,
    store,
  } = options;
  const sourceSha = environment?.GITHUB_SHA;
  if (
    !NAMESPACE.test(namespace ?? "") ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !isRecord(current?.snapshot?.currentDbCompatibility) ||
    !SHA256.test(current.snapshot.currentDbCompatibility.fingerprint ?? "")
  ) {
    throw new Error("Backup rehearsal Release State binding is invalid");
  }
  assertHead(current.head, "Backup rehearsal current Release State head");
  assertStore(store, namespace);
  const identity = deriveBrowserPhaseExitCollectorIdentity({
    sourceSha,
    oidcAuthority,
  });
  await readOidcAuthority({
    store,
    namespace,
    reference: oidcReceipt,
    approvalPolicy: oidcAuthority.approvalPolicy,
    sourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
  });
  const credentials = resolveCredentials({ environment, providerContract });
  const backup = configured.backup;
  const restoredNamespace = restoredNamespaceFor({
    prefix: backup.restoreTarget.namespacePrefix,
    sourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
  });
  const states = providerContract.api.states;
  const execute = async (operation, variables) => {
    const result = await executeProviderOperation({
      prerequisitePolicy,
      providerContract,
      operation,
      variables,
      token: credentials.token,
      clock,
    });
    return assertBackupProviderOperationResult(result, {
      prerequisitePolicy,
      providerContract,
      operation,
      variables,
    });
  };
  const createBackup = await execute("createBackup", {
    sourceProjectRef: backup.sourceProjectRef,
  });
  const settledBackup = await pollProviderResource({
    initial: createBackup,
    getOperation: "getBackup",
    variables: (backupId) => ({
      sourceProjectRef: backup.sourceProjectRef,
      backupId,
    }),
    execute,
    pending: states.backupPending,
    ready: states.backupReady,
    failed: states.failed,
    label: "Backup creation",
    maximumAttempts: providerContract.api.polling.maximumAttempts,
    intervalMilliseconds: providerContract.api.polling.intervalMilliseconds,
    sleep,
  });
  const backupId = settledBackup.resourceId;
  let restoreId = null;
  let settledRestore = null;
  let database = null;
  let cleanup = null;
  let primaryError = null;
  let cleanupError = null;
  try {
    const restore = await execute("restoreBackup", {
      backupId,
      restoreProjectRef: backup.restoreTarget.projectRef,
    });
    restoreId = restore.normalized.resourceId;
    settledRestore = await pollProviderResource({
      initial: restore,
      getOperation: "getRestore",
      variables: (id) => ({
        restoreProjectRef: backup.restoreTarget.projectRef,
        restoreId: id,
      }),
      execute,
      pending: states.restorePending,
      ready: states.restoreReady,
      failed: states.failed,
      label: "Backup restore",
      maximumAttempts: providerContract.api.polling.maximumAttempts,
      intervalMilliseconds: providerContract.api.polling.intervalMilliseconds,
      sleep,
    });
    const expectedFingerprint =
      current.snapshot.currentDbCompatibility.fingerprint;
    const [sourceDatabase, restoreDatabase] = await Promise.all([
      observeDatabase({
        connection: credentials.source,
        authority: providerContract.database.source,
        databaseContract: providerContract.database,
        target: "source",
        projectRef: backup.sourceProjectRef,
        clock,
      }),
      observeDatabase({
        connection: credentials.restore,
        authority: providerContract.database.restore,
        databaseContract: providerContract.database,
        target: "restore",
        projectRef: backup.restoreTarget.projectRef,
        clock,
      }),
    ]);
    assertBackupDatabaseReceipt(sourceDatabase, {
      target: "source",
      projectRef: backup.sourceProjectRef,
      authority: providerContract.database.source,
      expectedFingerprint,
    });
    assertBackupDatabaseReceipt(restoreDatabase, {
      target: "restore",
      projectRef: backup.restoreTarget.projectRef,
      authority: providerContract.database.restore,
      expectedFingerprint,
    });
    if (
      sourceDatabase.role === restoreDatabase.role ||
      sourceDatabase.databaseHead !== restoreDatabase.databaseHead ||
      sourceDatabase.integritySha256 !== restoreDatabase.integritySha256 ||
      sourceDatabase.compatibilityFingerprint !==
        restoreDatabase.compatibilityFingerprint
    ) {
      throw new Error("Backup restored database differs from source integrity");
    }
    database = {
      expectedCompatibilityFingerprint: expectedFingerprint,
      source: sourceDatabase,
      restore: restoreDatabase,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (restoreId !== null) {
      try {
        const cleanupInitial = await execute("cleanupRestore", {
          restoreProjectRef: backup.restoreTarget.projectRef,
          restoreId,
        });
        cleanup = await pollProviderResource({
          initial: cleanupInitial,
          getOperation: "getCleanup",
          variables: (id) => ({
            restoreProjectRef: backup.restoreTarget.projectRef,
            restoreId: id,
          }),
          execute,
          pending: states.cleanupPending,
          ready: states.cleanupReady,
          failed: states.failed,
          label: "Backup restore cleanup",
          maximumAttempts: providerContract.api.polling.maximumAttempts,
          intervalMilliseconds:
            providerContract.api.polling.intervalMilliseconds,
          sleep,
        });
        if (cleanup.resourceId !== restoreId) {
          cleanupError = new Error(
            "Backup cleanup changed the immutable restore ID",
          );
        }
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (primaryError !== null || cleanupError !== null) {
    if (primaryError !== null && cleanupError !== null) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Backup rehearsal and cleanup both failed",
      );
    }
    throw primaryError ?? cleanupError;
  }
  if (
    settledRestore === null ||
    database === null ||
    cleanup === null ||
    restoreId === null
  ) {
    throw new Error("Backup rehearsal did not produce complete closure");
  }
  const raw = {
    schemaVersion: 1,
    kind: "backup-restore-rehearsal-raw/v1",
    namespace,
    sourceSha,
    observedAt: cleanup.final.receipt.completedAt,
    releaseStateHead: { ...current.head },
    policy: {
      prerequisitePolicySha256: configured.prerequisitePolicySha256,
      providerContractSha256: configured.providerContractSha256,
      provider: backup.provider,
      sourceProjectRef: backup.sourceProjectRef,
      restoreProjectRef: backup.restoreTarget.projectRef,
      restoredNamespace,
      owner: backup.owner,
      recoveryPointObjectiveSeconds: backup.recoveryPointObjectiveSeconds,
      recoveryTimeObjectiveSeconds: backup.recoveryTimeObjectiveSeconds,
    },
    collector: {
      identity,
      oidcReceipt: { ...oidcReceipt },
    },
    provider: {
      backupId,
      restoreId,
      recoveryPointAt: settledBackup.final.normalized.recoveryPointAt,
      backupReceipts: settledBackup.receipts,
      restoreReceipts: settledRestore.receipts,
      cleanupReceipts: cleanup.receipts,
      cleanupCompletedAt: cleanup.final.receipt.completedAt,
    },
    database,
  };
  const stored = await putBackupRestoreRehearsal({
    store,
    raw,
    prerequisitePolicy,
    providerContract,
    secretValues: credentials.secretValues,
  });
  if (typeof readState === "function") {
    const final = await readState({ store, requireInitialized: true });
    if (!sameCanonicalValue(final.head, current.head)) {
      throw new Error("Release State changed during backup rehearsal");
    }
  }
  const observation = {
    schemaVersion: 1,
    kind: "backup-restore-rehearsal-observation/v1",
    namespace,
    sourceSha,
    collectorIdentity: identity,
    observedAt: raw.observedAt,
    releaseStateHead: { ...current.head },
    oidcReceipt: { ...oidcReceipt },
    rawRehearsal: { ...stored.reference },
    result: stored.readback.result,
  };
  return assertBackupRestoreRehearsalObservation(observation);
};

export {
  collectAndStoreProductionRequestGraphOidcAuthority as collectAndStoreBackupRestoreOidcAuthority,
  readStoredProductionRequestGraphOidcAuthority as readStoredBackupRestoreOidcAuthority,
};
