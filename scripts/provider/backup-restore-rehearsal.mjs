import { timingSafeEqual } from "node:crypto";
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
  "application/vnd.event-shopping-planner.backup-restore-rehearsal-raw+json;version=2";
export const BACKUP_RESTORE_REHEARSAL_FILE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.backup-restore-rehearsal+json;version=2";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DATABASE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const RFC3339_TIMESTAMP =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,9}))?(?<offset>Z|(?<offsetSign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;
const MAXIMUM_RAW_BYTES = 8 * 1024 * 1024;
const MAXIMUM_RECEIPTS = 512;
const MAXIMUM_REHEARSAL_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const MAXIMUM_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000;
const EMPTY_SHA256 = sha256Bytes(Buffer.alloc(0));
const PROJECT_READY_STATE = "ACTIVE_HEALTHY";
const DELETED_STATE = "deleted";
const CLEANUP_PENDING_STATES = new Set([
  PROJECT_READY_STATE,
  "GOING_DOWN",
  "INACTIVE",
]);
const BACKUP_READER_EXECUTABLE_PUBLIC_FUNCTIONS = Object.freeze([
  `public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()`,
]);
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
const PROVIDER_NORMALIZED_KEYS = ["backup", "project", "resourceId", "state"];
const PROVIDER_BACKUP_KEYS = [
  "id",
  "insertedAt",
  "isPhysicalBackup",
  "region",
  "recoveryPointAt",
];
const PROVIDER_PROJECT_KEYS = [
  "createdAt",
  "databaseHost",
  "name",
  "organizationSlug",
  "ref",
  "region",
  "status",
];
const DATABASE_RECEIPT_KEYS = [
  "authorization",
  "compatibilityFingerprint",
  "database",
  "databaseHead",
  "host",
  "integritySha256",
  "migrationVersion",
  "observedAt",
  "port",
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
  "anyTableSelect",
  "anyTableDelete",
  "anyTableInsert",
  "anyTableReferences",
  "anyTableTrigger",
  "anyTableTruncate",
  "anyTableUpdate",
  "databaseCreate",
  "executablePublicFunctions",
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

const timestampFromUnixSeconds = (value, label) => {
  const milliseconds = value * 1000;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > 8_640_000_000_000_000
  ) {
    throw new Error(`${label} is not a Unix timestamp`);
  }
  return new Date(milliseconds).toISOString();
};

const normalizeRfc3339Timestamp = (value, label) => {
  const match =
    typeof value === "string" ? RFC3339_TIMESTAMP.exec(value) : null;
  if (match === null) {
    throw new Error(`${label} is not an RFC 3339 timestamp`);
  }
  const components = Object.fromEntries(
    Object.entries(match.groups).map(([key, entry]) => [
      key,
      entry === undefined ? 0 : Number(entry),
    ]),
  );
  const civil = new Date(0);
  civil.setUTCFullYear(components.year, components.month - 1, components.day);
  civil.setUTCHours(
    components.hour,
    components.minute,
    components.second,
    Number((match.groups.fraction ?? "").padEnd(3, "0").slice(0, 3)),
  );
  if (
    civil.getUTCFullYear() !== components.year ||
    civil.getUTCMonth() !== components.month - 1 ||
    civil.getUTCDate() !== components.day ||
    civil.getUTCHours() !== components.hour ||
    civil.getUTCMinutes() !== components.minute ||
    civil.getUTCSeconds() !== components.second ||
    components.offsetHour > 23 ||
    components.offsetMinute > 59
  ) {
    throw new Error(`${label} is not an RFC 3339 timestamp`);
  }
  const offsetDirection = match.groups.offsetSign === "-" ? -1 : 1;
  const offsetMilliseconds =
    (components.offsetHour * 60 + components.offsetMinute) *
    60_000 *
    offsetDirection;
  return new Date(civil.getTime() - offsetMilliseconds).toISOString();
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

const normalizeProject = (
  value,
  expectedRef,
  label,
  { allowedStatuses = new Set([PROJECT_READY_STATE]) } = {},
) => {
  if (!isRecord(value) || !isRecord(value.database)) {
    throw new Error(`${label} response is invalid`);
  }
  const project = {
    ref: value.ref,
    organizationSlug: value.organization_slug,
    name: value.name,
    region: value.region,
    createdAt: normalizeRfc3339Timestamp(value.created_at, `${label} creation`),
    databaseHost:
      typeof value.database.host === "string"
        ? value.database.host.toLowerCase()
        : value.database.host,
    status: value.status,
  };
  assertExactKeys(project, PROVIDER_PROJECT_KEYS, `${label} project`);
  if (
    project.ref !== expectedRef ||
    !OPAQUE_ID.test(project.organizationSlug ?? "") ||
    typeof project.name !== "string" ||
    project.name.length === 0 ||
    Buffer.byteLength(project.name, "utf8") > 128 ||
    typeof project.region !== "string" ||
    project.region.length === 0 ||
    !DATABASE_HOST.test(project.databaseHost ?? "") ||
    !allowedStatuses.has(project.status)
  ) {
    throw new Error(`${label} project authority is invalid`);
  }
  return project;
};

const normalizeBackup = (value, providerContract) => {
  if (
    !isRecord(value) ||
    value.walg_enabled !== true ||
    value.pitr_enabled !== true ||
    !Array.isArray(value.backups) ||
    !isRecord(value.physical_backup_data)
  ) {
    throw new Error("Supabase physical PITR backup authority is unavailable");
  }
  const completed = value.backups
    .filter(
      (entry) =>
        isRecord(entry) &&
        entry.is_physical_backup === true &&
        entry.status === providerContract.api.backupReadyState &&
        Number.isSafeInteger(entry.id) &&
        entry.id >= 0 &&
        typeof entry.inserted_at === "string",
    )
    .map((entry) => ({
      id: String(entry.id),
      insertedAt: normalizeRfc3339Timestamp(
        entry.inserted_at,
        "Supabase backup insertion",
      ),
    }));
  completed.sort(
    (left, right) => Date.parse(right.insertedAt) - Date.parse(left.insertedAt),
  );
  if (completed.length === 0 || !OPAQUE_ID.test(completed[0].id)) {
    throw new Error("Supabase has no completed physical backup");
  }
  const recoveryPointAt = timestampFromUnixSeconds(
    value.physical_backup_data.latest_physical_backup_date_unix,
    "Supabase latest PITR recovery point",
  );
  timestampFromUnixSeconds(
    value.physical_backup_data.earliest_physical_backup_date_unix,
    "Supabase earliest PITR recovery point",
  );
  if (
    typeof value.region !== "string" ||
    value.region.length === 0 ||
    value.physical_backup_data.earliest_physical_backup_date_unix >
      value.physical_backup_data.latest_physical_backup_date_unix
  ) {
    throw new Error("Supabase PITR recovery window is invalid");
  }
  return {
    id: completed[0].id,
    insertedAt: completed[0].insertedAt,
    isPhysicalBackup: true,
    region: value.region,
    recoveryPointAt,
  };
};

const normalizeProviderResponse = ({
  operation,
  responseValue,
  responseStatus,
  variables,
  providerContract,
}) => {
  if (operation === "listSourceBackups") {
    const backup = normalizeBackup(responseValue, providerContract);
    return {
      resourceId: backup.id,
      state: providerContract.api.backupReadyState,
      backup,
      project: null,
    };
  }
  if (operation === "getSourceProject") {
    const project = normalizeProject(
      responseValue,
      variables.sourceProjectRef,
      "Supabase source",
    );
    return {
      resourceId: project.ref,
      state: project.status,
      backup: null,
      project,
    };
  }
  if (operation === "getRestoreProject") {
    const project = normalizeProject(
      responseValue,
      variables.restoreProjectRef,
      "Supabase restore",
    );
    return {
      resourceId: project.ref,
      state: project.status,
      backup: null,
      project,
    };
  }
  if (operation === "deleteRestoreProject") {
    if (
      !isRecord(responseValue) ||
      responseValue.ref !== variables.restoreProjectRef
    ) {
      throw new Error("Supabase cleanup deleted an unexpected project");
    }
    return {
      resourceId: variables.restoreProjectRef,
      state: DELETED_STATE,
      backup: null,
      project: null,
    };
  }
  if (operation === "confirmRestoreDeleted") {
    if (responseStatus === 200) {
      const project = normalizeProject(
        responseValue,
        variables.restoreProjectRef,
        "Supabase cleanup",
        { allowedStatuses: CLEANUP_PENDING_STATES },
      );
      return {
        resourceId: project.ref,
        state: project.status,
        backup: null,
        project,
      };
    }
    return {
      resourceId: variables.restoreProjectRef,
      state: DELETED_STATE,
      backup: null,
      project: null,
    };
  }
  throw new Error("Backup provider operation is not declared");
};

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
  const requestBytes = Buffer.alloc(0);
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
    },
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
  if (!descriptor.successStatusCodes.includes(response.status)) {
    throw new Error(`Backup provider ${operation} response is unexpected`);
  }
  if (
    responseBytes.length === 0 ||
    typeof contentType !== "string" ||
    !contentType.toLowerCase().includes("application/json")
  ) {
    throw new Error(`Backup provider ${operation} response is not JSON`);
  }
  const responseValue = parseJsonStrict(
    responseBytes.toString("utf8"),
    `Backup provider ${operation} response`,
  );
  const normalized = normalizeProviderResponse({
    operation,
    responseValue,
    responseStatus: response.status,
    variables,
    providerContract,
  });
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
    normalized,
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
    PROVIDER_NORMALIZED_KEYS,
    `Backup provider ${operation} normalized response`,
  );
  const descriptor = providerContract.api.operations[operation];
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
    result.receipt.requestBodySha256 !== EMPTY_SHA256 ||
    result.receipt.requestBodyByteLength !== 0 ||
    !SHA256.test(result.receipt.responseBodySha256 ?? "") ||
    !Number.isSafeInteger(result.receipt.responseBodyByteLength) ||
    result.receipt.responseBodyByteLength < 1 ||
    result.receipt.responseBodyByteLength >
      providerContract.api.maximumResponseBytes ||
    !OPAQUE_ID.test(result.normalized.resourceId ?? "") ||
    typeof result.normalized.state !== "string"
  ) {
    throw new Error(`Backup provider ${operation} receipt is invalid`);
  }
  if (operation === "listSourceBackups") {
    assertExactKeys(
      result.normalized.backup,
      PROVIDER_BACKUP_KEYS,
      "Backup provider backup",
    );
    timestamp(result.normalized.backup.insertedAt, "Backup insertion");
    timestamp(
      result.normalized.backup.recoveryPointAt,
      "Backup recovery point",
    );
    if (
      result.normalized.project !== null ||
      result.normalized.resourceId !== result.normalized.backup.id ||
      result.normalized.state !== providerContract.api.backupReadyState ||
      result.normalized.backup.isPhysicalBackup !== true ||
      typeof result.normalized.backup.region !== "string" ||
      result.normalized.backup.region.length === 0
    ) {
      throw new Error("Backup provider backup result is invalid");
    }
  } else if (["getSourceProject", "getRestoreProject"].includes(operation)) {
    assertExactKeys(
      result.normalized.project,
      PROVIDER_PROJECT_KEYS,
      "Backup provider project",
    );
    timestamp(result.normalized.project.createdAt, "Backup project creation");
    const expectedRef =
      operation === "getSourceProject"
        ? variables.sourceProjectRef
        : variables.restoreProjectRef;
    if (
      result.normalized.backup !== null ||
      result.normalized.project.ref !== expectedRef ||
      result.normalized.resourceId !== expectedRef ||
      result.normalized.state !== providerContract.api.projectReadyState ||
      result.normalized.project.status !==
        providerContract.api.projectReadyState ||
      !OPAQUE_ID.test(result.normalized.project.organizationSlug ?? "") ||
      typeof result.normalized.project.name !== "string" ||
      result.normalized.project.name.length === 0 ||
      typeof result.normalized.project.region !== "string" ||
      result.normalized.project.region.length === 0 ||
      !DATABASE_HOST.test(result.normalized.project.databaseHost ?? "")
    ) {
      throw new Error("Backup provider project result is invalid");
    }
  } else if (
    operation === "confirmRestoreDeleted" &&
    CLEANUP_PENDING_STATES.has(result.normalized.state)
  ) {
    assertExactKeys(
      result.normalized.project,
      PROVIDER_PROJECT_KEYS,
      "Backup cleanup project",
    );
    if (
      result.receipt.status !== 200 ||
      result.normalized.backup !== null ||
      result.normalized.project.ref !== variables.restoreProjectRef ||
      result.normalized.resourceId !== variables.restoreProjectRef ||
      result.normalized.project.status !== result.normalized.state ||
      !OPAQUE_ID.test(result.normalized.project.organizationSlug ?? "") ||
      typeof result.normalized.project.name !== "string" ||
      result.normalized.project.name.length === 0 ||
      typeof result.normalized.project.region !== "string" ||
      result.normalized.project.region.length === 0 ||
      !DATABASE_HOST.test(result.normalized.project.databaseHost ?? "")
    ) {
      throw new Error("Backup provider cleanup polling result is invalid");
    }
  } else if (
    result.normalized.backup !== null ||
    result.normalized.project !== null ||
    result.normalized.resourceId !== variables.restoreProjectRef ||
    result.normalized.state !== DELETED_STATE
  ) {
    throw new Error("Backup provider cleanup result is invalid");
  }
  return result;
};

const decodeDatabaseUrlComponent = (value, target, component) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Backup ${target} database ${component} is invalid`);
  }
};

const sameCredentialSecret = (left, right) => {
  const leftDigest = Buffer.from(sha256Bytes(Buffer.from(left, "utf8")), "hex");
  const rightDigest = Buffer.from(
    sha256Bytes(Buffer.from(right, "utf8")),
    "hex",
  );
  return timingSafeEqual(leftDigest, rightDigest);
};

const sameDatabaseEndpoint = (left, right) =>
  left.host === right.host &&
  left.port === right.port &&
  left.database === right.database;

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
  const role = decodeDatabaseUrlComponent(parsed.username, target, "role");
  const password = decodeDatabaseUrlComponent(
    parsed.password,
    target,
    "password",
  );
  const database = decodeDatabaseUrlComponent(
    parsed.pathname.slice(1),
    target,
    "name",
  );
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  const allowedSearch =
    parsed.search === "" ||
    (parsed.searchParams.size === 1 &&
      parsed.searchParams.get("sslmode") === "verify-full");
  if (
    parsed.protocol !== "postgresql:" ||
    password.length < 8 ||
    parsed.hash !== "" ||
    !allowedSearch ||
    !authority.allowedHosts.includes(host) ||
    !authority.allowedPorts.includes(port) ||
    !authority.allowedDatabases.includes(database) ||
    !authority.allowedRoles.includes(role) ||
    sha256Bytes(Buffer.from(ca, "utf8")) !== authority.caSha256
  ) {
    throw new Error(
      `Backup ${target} database connection differs from configured authority`,
    );
  }
  const runtimeUrl = new URL(parsed);
  runtimeUrl.searchParams.delete("sslmode");
  return {
    connectionString: runtimeUrl.toString(),
    ca,
    password,
    projection: {
      host,
      port,
      database,
      role,
    },
    secretValues: [connectionString, runtimeUrl.toString(), password],
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
  expectedFingerprint,
  clock = Date.now,
  createClient,
}) => {
  if (!SHA256.test(expectedFingerprint ?? "")) {
    throw new Error(`Backup ${target} expected DB fingerprint is invalid`);
  }
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
    const [
      roleResult,
      membershipResult,
      ownershipResult,
      privilegeResult,
      executableFunctionsResult,
    ] = await Promise.all([
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
        text: `with public_tables as (select c.oid, n.nspname as schema_name, c.relname as relation_name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.oid) select (select count(*)::text from public_tables) as table_count, (select schema_name from public_tables limit 1) as first_relation_schema, (select relation_name from public_tables limit 1) as first_relation_name, pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE') as schema_usage, pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') as schema_create, pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') as database_create, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'SELECT')), false) from public_tables) as any_table_select, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'INSERT')), false) from public_tables) as any_table_insert, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'UPDATE')), false) from public_tables) as any_table_update, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'DELETE')), false) from public_tables) as any_table_delete, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'TRUNCATE')), false) from public_tables) as any_table_truncate, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'REFERENCES')), false) from public_tables) as any_table_references, (select coalesce(bool_or(pg_catalog.has_table_privilege(current_user, oid, 'TRIGGER')), false) from public_tables) as any_table_trigger, pg_catalog.has_function_privilege(current_user, pg_catalog.to_regprocedure('public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()'), 'EXECUTE') as integrity_function_execute, (select prosecdef from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()')) as integrity_function_security_definer`,
        values: [],
      }),
      client.query({
        name: `${BACKUP_RESTORE_INTEGRITY_QUERY_NAME}-executable-public-functions`,
        text: "select pg_catalog.format('%I.%I(%s)', namespace.nspname, function_definition.proname, pg_catalog.pg_get_function_identity_arguments(function_definition.oid)) as function_signature from pg_catalog.pg_proc function_definition join pg_catalog.pg_namespace namespace on namespace.oid = function_definition.pronamespace where namespace.nspname = 'public' and pg_catalog.has_function_privilege(current_user, function_definition.oid, 'EXECUTE') order by function_signature",
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
      !Array.isArray(executableFunctionsResult?.rows) ||
      membershipResult.rows.some(
        (row) =>
          Object.keys(row).length !== 1 ||
          typeof row.role !== "string" ||
          row.role.length === 0,
      ) ||
      executableFunctionsResult.rows.some(
        (row) =>
          Object.keys(row).length !== 1 ||
          typeof row.function_signature !== "string" ||
          row.function_signature.length === 0,
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
        "any_table_select",
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
    const executablePublicFunctions = executableFunctionsResult.rows.map(
      ({ function_signature: functionSignature }) => functionSignature,
    );
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
      anyTableSelect: privilegeRow.any_table_select,
      anyTableInsert: privilegeRow.any_table_insert,
      anyTableUpdate: privilegeRow.any_table_update,
      anyTableDelete: privilegeRow.any_table_delete,
      anyTableTruncate: privilegeRow.any_table_truncate,
      anyTableReferences: privilegeRow.any_table_references,
      anyTableTrigger: privilegeRow.any_table_trigger,
      integrityFunctionExecute: privilegeRow.integrity_function_execute,
      integrityFunctionSecurityDefiner:
        privilegeRow.integrity_function_security_definer,
      executablePublicFunctions,
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
      privileges.integrityFunctionSecurityDefiner !== true ||
      !sameCanonicalValue(
        privileges.executablePublicFunctions,
        BACKUP_READER_EXECUTABLE_PUBLIC_FUNCTIONS,
      )
    ) {
      throw new Error(
        `Backup ${target} database role is not least-privilege read-only`,
      );
    }
    const result = await client.query({
      name: BACKUP_RESTORE_INTEGRITY_QUERY_NAME,
      text: `select database_head, migration_version, integrity_sha256 from public.${BACKUP_RESTORE_INTEGRITY_FUNCTION}()`,
      values: [],
    });
    if (result?.rows?.length !== 1) {
      throw new Error(`Backup ${target} database integrity result is invalid`);
    }
    const row = result.rows[0];
    assertExactKeys(
      row,
      ["database_head", "integrity_sha256", "migration_version"],
      `Backup ${target} database integrity row`,
    );
    if (row.migration_version !== databaseContract.integrityMigrationVersion) {
      throw new Error(
        `Backup ${target} database integrity migration is absent`,
      );
    }
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
      port: connection.projection.port,
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
      migrationVersion: row.migration_version,
      compatibilityFingerprint: expectedFingerprint,
      integritySha256: row.integrity_sha256,
    };
    return assertBackupDatabaseReceipt(receipt, {
      target,
      projectRef,
      authority,
      expectedFingerprint,
      expectedMigrationVersion: databaseContract.integrityMigrationVersion,
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
  {
    target,
    projectRef,
    authority,
    expectedFingerprint,
    expectedMigrationVersion,
  },
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
    authorization.privileges.anyTableSelect !== false ||
    authorization.privileges.integrityFunctionExecute !== true ||
    authorization.privileges.integrityFunctionSecurityDefiner !== true ||
    !sameCanonicalValue(
      authorization.privileges.executablePublicFunctions,
      BACKUP_READER_EXECUTABLE_PUBLIC_FUNCTIONS,
    ) ||
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
    !authority.allowedPorts.includes(receipt.port) ||
    !authority.allowedDatabases.includes(receipt.database) ||
    !authority.allowedRoles.includes(receipt.role) ||
    receipt.tlsMode !== "verify-full" ||
    receipt.transactionReadOnly !== true ||
    receipt.postgresMajor !== 17 ||
    receipt.queryName !== BACKUP_RESTORE_INTEGRITY_QUERY_NAME ||
    !SHA256.test(receipt.databaseHead ?? "") ||
    receipt.migrationVersion !== expectedMigrationVersion ||
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
    sameDatabaseEndpoint(source.projection, restore.projection) ||
    source.projection.role === restore.projection.role ||
    sameCredentialSecret(source.password, restore.password)
  ) {
    throw new Error("Backup source and restore database authorities overlap");
  }
  const sourceConnection = {
    connectionString: source.connectionString,
    ca: source.ca,
    projection: source.projection,
  };
  const restoreConnection = {
    connectionString: restore.connectionString,
    ca: restore.ca,
    projection: restore.projection,
  };
  return {
    token,
    source: sourceConnection,
    restore: restoreConnection,
    secretValues: [
      token,
      ...source.secretValues,
      source.ca,
      ...restore.secretValues,
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

const assertV2ProviderReceipt = ({
  result,
  operation,
  variables,
  prerequisitePolicy,
  providerContract,
}) =>
  assertBackupProviderOperationResult(result, {
    prerequisitePolicy,
    providerContract,
    operation,
    variables,
  });

export const assertSafeRestoreProjectForCleanup = ({
  backup,
  backupReceipt,
  sourceProjectReceipt,
  restoreProjectReceipt,
}) => {
  const sourceProject = sourceProjectReceipt?.normalized?.project;
  const restoreProject = restoreProjectReceipt?.normalized?.project;
  const recoveryPointAt = backupReceipt?.normalized?.backup?.recoveryPointAt;
  if (
    !isRecord(backup) ||
    backup.restoreTarget?.cleanupApproval !==
      "delete-exact-project-after-verification" ||
    sourceProject?.ref !== backup.sourceProjectRef ||
    restoreProject?.ref !== backup.restoreTarget.projectRef ||
    sourceProject.ref === restoreProject.ref ||
    sourceProject.organizationSlug !== restoreProject.organizationSlug ||
    sourceProject.region !== restoreProject.region ||
    sourceProject.databaseHost === restoreProject.databaseHost ||
    backupReceipt?.normalized?.backup?.region !== sourceProject.region ||
    sourceProject.name === restoreProject.name ||
    !restoreProject.name
      .toLowerCase()
      .startsWith(`${backup.restoreTarget.namespacePrefix}-`)
  ) {
    throw new Error("Backup cleanup target identity is not authorized");
  }
  const recoveryPoint = timestamp(
    recoveryPointAt,
    "Backup cleanup recovery point",
  );
  const sourceCreated = timestamp(
    sourceProject.createdAt,
    "Backup cleanup source creation",
  );
  const restoreCreated = timestamp(
    restoreProject.createdAt,
    "Backup cleanup restore creation",
  );
  const restoreInspected = timestamp(
    restoreProjectReceipt.receipt.startedAt,
    "Backup cleanup restore inspection",
  );
  if (
    sourceCreated >= restoreCreated ||
    recoveryPoint > restoreCreated ||
    restoreInspected < restoreCreated ||
    restoreInspected - restoreCreated >
      backup.restoreTarget.maximumProjectAgeSeconds * 1000
  ) {
    throw new Error("Backup cleanup target is not a fresh restored project");
  }
  return { sourceProject, restoreProject, recoveryPointAt };
};

const assertDatabaseProjectBinding = ({
  credentials,
  sourceProjectReceipt,
  restoreProjectReceipt,
}) => {
  const sourceProject = sourceProjectReceipt.normalized.project;
  const restoreProject = restoreProjectReceipt.normalized.project;
  if (
    credentials.source.projection.host !== sourceProject.databaseHost ||
    credentials.restore.projection.host !== restoreProject.databaseHost ||
    sameDatabaseEndpoint(
      credentials.source.projection,
      credentials.restore.projection,
    )
  ) {
    throw new Error(
      "Backup database endpoints differ from inspected project authority",
    );
  }
};

const assertUnchangedRestoreProject = (expected, actual) => {
  if (!sameCanonicalValue(actual, expected)) {
    throw new Error("Backup restore project changed before cleanup");
  }
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
    raw.schemaVersion !== 2 ||
    raw.kind !== "backup-restore-rehearsal-raw/v2" ||
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
    raw.provider.restoreId !== backup.restoreTarget.projectRef ||
    !Array.isArray(raw.provider.backupReceipts) ||
    raw.provider.backupReceipts.length !== 1 ||
    !Array.isArray(raw.provider.restoreReceipts) ||
    raw.provider.restoreReceipts.length !== 3 ||
    !Array.isArray(raw.provider.cleanupReceipts) ||
    raw.provider.cleanupReceipts.length < 2 ||
    raw.provider.cleanupReceipts.length > MAXIMUM_RECEIPTS
  ) {
    throw new Error("Backup rehearsal provider resource identity is invalid");
  }
  timestamp(raw.provider.recoveryPointAt, "Backup rehearsal recovery point");
  timestamp(raw.provider.cleanupCompletedAt, "Backup rehearsal cleanup");

  const backupReceipt = assertV2ProviderReceipt({
    result: raw.provider.backupReceipts[0],
    operation: "listSourceBackups",
    variables: { sourceProjectRef: raw.policy.sourceProjectRef },
    prerequisitePolicy,
    providerContract,
  });
  const sourceProjectReceipt = assertV2ProviderReceipt({
    result: raw.provider.restoreReceipts[0],
    operation: "getSourceProject",
    variables: { sourceProjectRef: raw.policy.sourceProjectRef },
    prerequisitePolicy,
    providerContract,
  });
  const restoreProjectReceipt = assertV2ProviderReceipt({
    result: raw.provider.restoreReceipts[1],
    operation: "getRestoreProject",
    variables: { restoreProjectRef: raw.policy.restoreProjectRef },
    prerequisitePolicy,
    providerContract,
  });
  const cleanupTargetReceipt = assertV2ProviderReceipt({
    result: raw.provider.restoreReceipts[2],
    operation: "getRestoreProject",
    variables: { restoreProjectRef: raw.policy.restoreProjectRef },
    prerequisitePolicy,
    providerContract,
  });
  const deleteReceipt = assertV2ProviderReceipt({
    result: raw.provider.cleanupReceipts[0],
    operation: "deleteRestoreProject",
    variables: { restoreProjectRef: raw.policy.restoreProjectRef },
    prerequisitePolicy,
    providerContract,
  });
  const cleanupPollReceipts = raw.provider.cleanupReceipts
    .slice(1)
    .map((result) =>
      assertV2ProviderReceipt({
        result,
        operation: "confirmRestoreDeleted",
        variables: { restoreProjectRef: raw.policy.restoreProjectRef },
        prerequisitePolicy,
        providerContract,
      }),
    );
  const deletedReceipt = cleanupPollReceipts.at(-1);
  const sourceProject = sourceProjectReceipt.normalized.project;
  const restoreProject = restoreProjectReceipt.normalized.project;
  const cleanupTargetProject = cleanupTargetReceipt.normalized.project;
  const recoveryPoint = timestamp(
    raw.provider.recoveryPointAt,
    "Backup recovery point",
  );
  const restoreCreated = timestamp(
    restoreProject.createdAt,
    "Backup restore project creation",
  );
  const restoreInspected = timestamp(
    restoreProjectReceipt.receipt.startedAt,
    "Backup restore project inspection",
  );
  if (
    backup.restoreTarget.cleanupApproval !==
      "delete-exact-project-after-verification" ||
    backupReceipt.normalized.resourceId !== raw.provider.backupId ||
    backupReceipt.normalized.backup.recoveryPointAt !==
      raw.provider.recoveryPointAt ||
    sourceProject.ref !== raw.policy.sourceProjectRef ||
    restoreProject.ref !== raw.policy.restoreProjectRef ||
    sourceProject.ref === restoreProject.ref ||
    sourceProject.organizationSlug !== restoreProject.organizationSlug ||
    sourceProject.region !== restoreProject.region ||
    sourceProject.databaseHost === restoreProject.databaseHost ||
    !sameCanonicalValue(cleanupTargetProject, restoreProject) ||
    backupReceipt.normalized.backup.region !== sourceProject.region ||
    sourceProject.name === restoreProject.name ||
    !restoreProject.name
      .toLowerCase()
      .startsWith(`${backup.restoreTarget.namespacePrefix}-`) ||
    timestamp(sourceProject.createdAt, "Backup source project creation") >=
      restoreCreated ||
    recoveryPoint > restoreCreated ||
    restoreInspected < restoreCreated ||
    restoreInspected - restoreCreated >
      backup.restoreTarget.maximumProjectAgeSeconds * 1000 ||
    deleteReceipt.normalized.resourceId !== raw.policy.restoreProjectRef ||
    deletedReceipt.normalized.resourceId !== raw.policy.restoreProjectRef ||
    deletedReceipt.normalized.state !== DELETED_STATE ||
    cleanupPollReceipts
      .slice(0, -1)
      .some(
        (receipt) =>
          receipt.normalized.resourceId !== raw.policy.restoreProjectRef ||
          !CLEANUP_PENDING_STATES.has(receipt.normalized.state) ||
          receipt.normalized.project?.ref !== restoreProject.ref ||
          receipt.normalized.project?.organizationSlug !==
            restoreProject.organizationSlug ||
          receipt.normalized.project?.name !== restoreProject.name ||
          receipt.normalized.project?.region !== restoreProject.region ||
          receipt.normalized.project?.createdAt !== restoreProject.createdAt ||
          receipt.normalized.project?.databaseHost !==
            restoreProject.databaseHost ||
          receipt.normalized.project?.status !== receipt.normalized.state,
      ) ||
    raw.provider.cleanupCompletedAt !== deletedReceipt.receipt.completedAt
  ) {
    throw new Error(
      "Backup provider did not prove an approved fresh nonproduction clone",
    );
  }
  const restoreReady = timestamp(
    restoreProjectReceipt.receipt.completedAt,
    "Backup provider restore readiness",
  );
  const cleanupStarted = timestamp(
    deleteReceipt.receipt.startedAt,
    "Backup provider cleanup start",
  );
  const cleanupTargetInspectionStarted = timestamp(
    cleanupTargetReceipt.receipt.startedAt,
    "Backup cleanup target reinspection start",
  );
  if (
    restoreReady > cleanupTargetInspectionStarted ||
    timestamp(
      cleanupTargetReceipt.receipt.completedAt,
      "Backup cleanup target reinspection completion",
    ) > cleanupStarted ||
    timestamp(deleteReceipt.receipt.completedAt, "Backup cleanup deletion") >
      timestamp(
        deletedReceipt.receipt.startedAt,
        "Backup cleanup confirmation",
      ) ||
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
  const databaseExpectation = {
    expectedFingerprint: raw.database.expectedCompatibilityFingerprint,
    expectedMigrationVersion:
      providerContract.database.integrityMigrationVersion,
  };
  assertBackupDatabaseReceipt(raw.database.source, {
    target: "source",
    projectRef: raw.policy.sourceProjectRef,
    authority: providerContract.database.source,
    ...databaseExpectation,
  });
  assertBackupDatabaseReceipt(raw.database.restore, {
    target: "restore",
    projectRef: raw.policy.restoreProjectRef,
    authority: providerContract.database.restore,
    ...databaseExpectation,
  });
  if (
    raw.database.source.role === raw.database.restore.role ||
    (raw.database.source.host === raw.database.restore.host &&
      raw.database.source.port === raw.database.restore.port &&
      raw.database.source.database === raw.database.restore.database) ||
    raw.database.source.migrationVersion !==
      raw.database.restore.migrationVersion ||
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
    if (
      observedAt < restoreReady ||
      observedAt > cleanupTargetInspectionStarted
    ) {
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
  const backupCompletedAt = raw.provider.recoveryPointAt;
  const restoreStartedAt =
    raw.provider.restoreReceipts[1].normalized.project.createdAt;
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
  const restoreCompletedAt = new Date(databaseVerifiedAt).toISOString();
  const observedRecoveryPointSeconds = Math.ceil(
    (timestamp(restoreStartedAt, "Backup restore start") -
      timestamp(raw.provider.recoveryPointAt, "Backup recovery point")) /
      1000,
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
    observation.schemaVersion !== 2 ||
    observation.kind !== "backup-restore-rehearsal-observation/v2" ||
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

  const backupReceipt = await execute("listSourceBackups", {
    sourceProjectRef: backup.sourceProjectRef,
  });
  const sourceProjectReceipt = await execute("getSourceProject", {
    sourceProjectRef: backup.sourceProjectRef,
  });
  const restoreProjectReceipt = await execute("getRestoreProject", {
    restoreProjectRef: backup.restoreTarget.projectRef,
  });
  // No DELETE is reachable until all immutable target-safety checks close.
  assertSafeRestoreProjectForCleanup({
    backup,
    backupReceipt,
    sourceProjectReceipt,
    restoreProjectReceipt,
  });
  assertDatabaseProjectBinding({
    credentials,
    sourceProjectReceipt,
    restoreProjectReceipt,
  });

  const expectedFingerprint =
    current.snapshot.currentDbCompatibility.fingerprint;
  let database = null;
  let primaryError = null;
  let cleanupError = null;
  let cleanupTargetReceipt = null;
  const cleanupReceipts = [];
  try {
    const observations = await Promise.allSettled([
      Promise.resolve().then(() =>
        observeDatabase({
          connection: credentials.source,
          authority: providerContract.database.source,
          databaseContract: providerContract.database,
          target: "source",
          projectRef: backup.sourceProjectRef,
          expectedFingerprint,
          clock,
        }),
      ),
      Promise.resolve().then(() =>
        observeDatabase({
          connection: credentials.restore,
          authority: providerContract.database.restore,
          databaseContract: providerContract.database,
          target: "restore",
          projectRef: backup.restoreTarget.projectRef,
          expectedFingerprint,
          clock,
        }),
      ),
    ]);
    const failures = observations
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => reason);
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Backup database observations failed");
    }
    const [sourceDatabase, restoreDatabase] = observations.map(
      ({ value }) => value,
    );
    const receiptExpectation = {
      expectedFingerprint,
      expectedMigrationVersion:
        providerContract.database.integrityMigrationVersion,
    };
    assertBackupDatabaseReceipt(sourceDatabase, {
      target: "source",
      projectRef: backup.sourceProjectRef,
      authority: providerContract.database.source,
      ...receiptExpectation,
    });
    assertBackupDatabaseReceipt(restoreDatabase, {
      target: "restore",
      projectRef: backup.restoreTarget.projectRef,
      authority: providerContract.database.restore,
      ...receiptExpectation,
    });
    if (
      sourceDatabase.role === restoreDatabase.role ||
      sourceDatabase.migrationVersion !== restoreDatabase.migrationVersion ||
      sourceDatabase.databaseHead !== restoreDatabase.databaseHead ||
      sourceDatabase.integritySha256 !== restoreDatabase.integritySha256
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
    try {
      cleanupTargetReceipt = await execute("getRestoreProject", {
        restoreProjectRef: backup.restoreTarget.projectRef,
      });
      assertUnchangedRestoreProject(
        restoreProjectReceipt.normalized.project,
        cleanupTargetReceipt.normalized.project,
      );
      cleanupReceipts.push(
        await execute("deleteRestoreProject", {
          restoreProjectRef: backup.restoreTarget.projectRef,
        }),
      );
      let deleted = false;
      for (
        let attempt = 0;
        attempt < providerContract.api.cleanupPolling.maximumAttempts;
        attempt += 1
      ) {
        if (attempt > 0) {
          await sleep(providerContract.api.cleanupPolling.intervalMilliseconds);
        }
        const receipt = await execute("confirmRestoreDeleted", {
          restoreProjectRef: backup.restoreTarget.projectRef,
        });
        cleanupReceipts.push(receipt);
        if (receipt.normalized.state === DELETED_STATE) {
          deleted = true;
          break;
        }
      }
      if (!deleted) {
        cleanupError = new Error(
          "Backup restore project cleanup was not confirmed",
        );
      }
    } catch (error) {
      cleanupError = error;
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
    database === null ||
    cleanupTargetReceipt === null ||
    cleanupReceipts.length < 2
  ) {
    throw new Error("Backup rehearsal did not produce complete closure");
  }

  const finalCleanup = cleanupReceipts.at(-1);
  const raw = {
    schemaVersion: 2,
    kind: "backup-restore-rehearsal-raw/v2",
    namespace,
    sourceSha,
    observedAt: finalCleanup.receipt.completedAt,
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
      backupId: backupReceipt.normalized.resourceId,
      restoreId: backup.restoreTarget.projectRef,
      recoveryPointAt: backupReceipt.normalized.backup.recoveryPointAt,
      backupReceipts: [backupReceipt],
      restoreReceipts: [
        sourceProjectReceipt,
        restoreProjectReceipt,
        cleanupTargetReceipt,
      ],
      cleanupReceipts,
      cleanupCompletedAt: finalCleanup.receipt.completedAt,
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
    schemaVersion: 2,
    kind: "backup-restore-rehearsal-observation/v2",
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
