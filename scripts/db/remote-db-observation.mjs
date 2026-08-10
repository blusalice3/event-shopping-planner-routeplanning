import { sha256Json } from "../lib/canonical-json.mjs";

const UTF8_COMPARE = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const REQUIRED_POSTGRES_MAJOR = 17;
const DATABASE_URL_ENVIRONMENT_NAME = "DB_COMPATIBILITY_OBSERVER_DATABASE_URL";
const DATABASE_CA_ENVIRONMENT_NAME = "DB_COMPATIBILITY_OBSERVER_CA_PEM";
const METRICS_TABLE = "public.persistence_release_a_metric_events";
const CSP_TABLE = "public.csp_violation_reports";
const METRICS_SEQUENCE = "public.persistence_release_a_metric_events_id_seq";
const CSP_SEQUENCE = "public.csp_violation_reports_id_seq";
const CSP_DORMANT_PRINCIPALS = Object.freeze(["anon", "authenticated"]);
const CSP_ROUTINE_SIGNATURES = Object.freeze([
  "public.read_csp_deployment_violation_aggregates(timestamp with time zone, timestamp with time zone, text, text, integer)",
  "public.read_csp_violation_aggregates(timestamp with time zone, timestamp with time zone, integer)",
  "public.retain_csp_violation_reports(boolean, integer, integer)",
]);
const FUNCTION_ARGUMENTS = Object.freeze({
  "public.read_persistence_release_a_metrics":
    "timestamp with time zone, timestamp with time zone, integer",
  "public.retain_persistence_release_a_metrics": "boolean, integer, integer",
  "public.read_csp_violation_aggregates":
    "timestamp with time zone, timestamp with time zone, integer",
  "public.read_csp_deployment_violation_aggregates":
    "timestamp with time zone, timestamp with time zone, text, text, integer",
  "public.retain_csp_violation_reports": "boolean, integer, integer",
});
const REQUIRED_FUNCTION_AUTHORITIES = Object.freeze([
  Object.freeze({
    definitionSha256:
      "d840ff64e316a5e0726e3168e7c44e4c8a1bde7229521a01f3fb9298d9150d9a",
    identityArguments:
      "timestamp with time zone, timestamp with time zone, text, text, integer",
    language: "plpgsql",
    leakproof: false,
    owner: "postgres",
    parallel: "u",
    qualifiedName: "public.read_csp_deployment_violation_aggregates",
    result:
      "TABLE(effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
    securityDefiner: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definitionSha256:
      "0bd18e5377c32f27fa8a72c7c7b2d4dbc497cd076c2c7c28584bfc02497fb712",
    identityArguments:
      "timestamp with time zone, timestamp with time zone, integer",
    language: "plpgsql",
    leakproof: false,
    owner: "postgres",
    parallel: "u",
    qualifiedName: "public.read_csp_violation_aggregates",
    result:
      "TABLE(source_sha text, effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
    securityDefiner: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definitionSha256:
      "a26aae5d280b49cf403721cbcd7eff85c6b78e258301dcd69df8925d40e6cb63",
    identityArguments:
      "timestamp with time zone, timestamp with time zone, integer",
    language: "plpgsql",
    leakproof: false,
    owner: "postgres",
    parallel: "u",
    qualifiedName: "public.read_persistence_release_a_metrics",
    result:
      "TABLE(received_at timestamp with time zone, build_id text, browser_family text, app_mode text, online boolean, event_name text, outcome text, duration_bucket text, cleanup_mode text, cleanup_reason text)",
    securityDefiner: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definitionSha256:
      "7bfbffd5e152d0fe6fce71e5b3a6390a84a0578143aa3e6f0d68060ea603d6a9",
    identityArguments: "boolean, integer, integer",
    language: "plpgsql",
    leakproof: false,
    owner: "postgres",
    parallel: "u",
    qualifiedName: "public.retain_csp_violation_reports",
    result:
      "TABLE(cutoff timestamp with time zone, affected_rows bigint, batch_count integer, dry_run boolean)",
    securityDefiner: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definitionSha256:
      "a2518f229ae4ac700702713bab16790c966f78a61b4d4b74b2722ecea8bf9cc2",
    identityArguments: "boolean, integer, integer",
    language: "plpgsql",
    leakproof: false,
    owner: "postgres",
    parallel: "u",
    qualifiedName: "public.retain_persistence_release_a_metrics",
    result:
      "TABLE(cutoff timestamp with time zone, affected_rows bigint, batch_count integer, dry_run boolean)",
    securityDefiner: true,
    strict: false,
    volatility: "v",
  }),
]);
const OBSERVER_BOUNDED_FUNCTION_AUTHORITIES = Object.freeze(
  REQUIRED_FUNCTION_AUTHORITIES.filter(({ qualifiedName }) =>
    qualifiedName.includes(".read_"),
  ).map((authority) =>
    Object.freeze({
      definitionSha256: authority.definitionSha256,
      execute: true,
      executeGrantable: false,
      language: authority.language,
      owner: authority.owner,
      result: authority.result,
      signature: `${authority.qualifiedName}(${authority.identityArguments})`,
    }),
  ),
);
const OBSERVER_EXECUTABLE_PUBLIC_FUNCTIONS = Object.freeze(
  OBSERVER_BOUNDED_FUNCTION_AUTHORITIES.map(({ signature }) => signature),
);
const PROVIDER_MANAGED_SCHEMAS = Object.freeze([
  "_realtime",
  "auth",
  "cron",
  "extensions",
  "graphql",
  "graphql_public",
  "net",
  "pgbouncer",
  "realtime",
  "storage",
  "supabase_functions",
  "vault",
]);
const PROVIDER_MANAGED_SCHEMA_USAGE = Object.freeze(["net"]);
const PROVIDER_MANAGED_RELATION_PRIVILEGE_BASELINE = Object.freeze([
  Object.freeze({
    columnPrivileges: ["SELECT"],
    objectName: "cron.job",
    privileges: ["SELECT"],
  }),
  Object.freeze({
    columnPrivileges: ["SELECT"],
    objectName: "cron.job_run_details",
    privileges: ["DELETE", "SELECT"],
  }),
  Object.freeze({
    columnPrivileges: ["SELECT"],
    objectName: "extensions.pg_stat_statements",
    privileges: ["SELECT"],
  }),
  Object.freeze({
    columnPrivileges: ["SELECT"],
    objectName: "extensions.pg_stat_statements_info",
    privileges: ["SELECT"],
  }),
  Object.freeze({
    columnPrivileges: ["INSERT", "REFERENCES", "SELECT", "UPDATE"],
    objectName: "net._http_response",
    privileges: [
      "DELETE",
      "INSERT",
      "MAINTAIN",
      "REFERENCES",
      "SELECT",
      "TRIGGER",
      "TRUNCATE",
      "UPDATE",
    ],
  }),
  Object.freeze({
    columnPrivileges: ["INSERT", "REFERENCES", "SELECT", "UPDATE"],
    objectName: "net.http_request_queue",
    privileges: [
      "DELETE",
      "INSERT",
      "MAINTAIN",
      "REFERENCES",
      "SELECT",
      "TRIGGER",
      "TRUNCATE",
      "UPDATE",
    ],
  }),
]);
const PROVIDER_MANAGED_SEQUENCE_PRIVILEGE_BASELINE = Object.freeze([
  Object.freeze({
    objectName: "net.http_request_queue_id_seq",
    privileges: ["SELECT", "UPDATE", "USAGE"],
  }),
]);
const OBSERVER_AUTHORIZATION_KEYS = Object.freeze([
  "boundedFunctions",
  "currentDatabase",
  "databaseCreateAuthorities",
  "managedFunctionDirectAuthorities",
  "managedObjectDirectAuthorities",
  "memberships",
  "ownedObjectCount",
  "relationPrivileges",
  "schemaPrivileges",
  "sequencePrivileges",
]);
const OBSERVER_RELATION_PRIVILEGE_KEYS = Object.freeze([
  "columnInsert",
  "columnInsertGrantable",
  "columnReferences",
  "columnReferencesGrantable",
  "columnSelect",
  "columnSelectGrantable",
  "columnUpdate",
  "columnUpdateGrantable",
  "delete",
  "deleteGrantable",
  "insert",
  "insertGrantable",
  "maintain",
  "maintainGrantable",
  "objectName",
  "references",
  "referencesGrantable",
  "select",
  "selectGrantable",
  "trigger",
  "triggerGrantable",
  "truncate",
  "truncateGrantable",
  "update",
  "updateGrantable",
]);
const OBSERVER_SEQUENCE_PRIVILEGE_KEYS = Object.freeze([
  "objectName",
  "select",
  "selectGrantable",
  "update",
  "updateGrantable",
  "usage",
  "usageGrantable",
]);
const OBSERVER_SCHEMA_PRIVILEGE_KEYS = Object.freeze([
  "create",
  "createGrantable",
  "objectName",
  "usage",
  "usageGrantable",
]);
const OBSERVER_DATABASE_PRIVILEGE_KEYS = Object.freeze([
  "connect",
  "connectGrantable",
  "create",
  "createGrantable",
  "temporary",
  "temporaryGrantable",
]);
const OBSERVER_FUNCTION_AUTHORITY_KEYS = Object.freeze([
  "definitionSha256",
  "execute",
  "executeGrantable",
  "language",
  "owner",
  "result",
  "signature",
]);
const SERVICE_ROLE_TABLE_PRIVILEGE_KEYS = Object.freeze([
  "object_name",
  "service_column_insert",
  "service_column_insert_grantable",
  "service_column_references",
  "service_column_references_grantable",
  "service_column_select",
  "service_column_select_grantable",
  "service_column_update",
  "service_column_update_grantable",
  "service_delete",
  "service_delete_grantable",
  "service_insert",
  "service_insert_grantable",
  "service_maintain",
  "service_maintain_grantable",
  "service_references",
  "service_references_grantable",
  "service_select",
  "service_select_grantable",
  "service_trigger",
  "service_trigger_grantable",
  "service_truncate",
  "service_truncate_grantable",
  "service_update",
  "service_update_grantable",
]);
const SERVICE_ROLE_SEQUENCE_PRIVILEGE_KEYS = Object.freeze([
  "identity_bound",
  "object_name",
  "service_select",
  "service_select_grantable",
  "service_update",
  "service_update_grantable",
  "service_usage",
  "service_usage_grantable",
]);
const MIGRATION_HISTORY_AUTHORITY_KEYS = Object.freeze([
  "migrationName",
  "statementCount",
  "statementsSha256",
  "version",
]);
const MIGRATION_HISTORY_RELATION = "supabase_migrations.schema_migrations";
const EXPECTED_OBSERVER_CURRENT_DATABASE = Object.freeze({
  connect: true,
  connectGrantable: false,
  create: false,
  createGrantable: false,
  temporary: true,
  temporaryGrantable: false,
});
const EXPECTED_OBSERVER_SCHEMA_PRIVILEGES = Object.freeze([
  Object.freeze({
    create: false,
    createGrantable: false,
    objectName: "net",
    usage: true,
    usageGrantable: false,
  }),
  Object.freeze({
    create: false,
    createGrantable: false,
    objectName: "public",
    usage: true,
    usageGrantable: false,
  }),
  Object.freeze({
    create: false,
    createGrantable: false,
    objectName: "supabase_migrations",
    usage: true,
    usageGrantable: false,
  }),
]);
const relationPrivilegeAuthority = (
  objectName,
  privileges,
  columnPrivileges = privileges.filter((privilege) =>
    ["INSERT", "REFERENCES", "SELECT", "UPDATE"].includes(privilege),
  ),
) =>
  Object.freeze({
    columnInsert: columnPrivileges.includes("INSERT"),
    columnInsertGrantable: false,
    columnReferences: columnPrivileges.includes("REFERENCES"),
    columnReferencesGrantable: false,
    columnSelect: columnPrivileges.includes("SELECT"),
    columnSelectGrantable: false,
    columnUpdate: columnPrivileges.includes("UPDATE"),
    columnUpdateGrantable: false,
    delete: privileges.includes("DELETE"),
    deleteGrantable: false,
    insert: privileges.includes("INSERT"),
    insertGrantable: false,
    maintain: privileges.includes("MAINTAIN"),
    maintainGrantable: false,
    objectName,
    references: privileges.includes("REFERENCES"),
    referencesGrantable: false,
    select: privileges.includes("SELECT"),
    selectGrantable: false,
    trigger: privileges.includes("TRIGGER"),
    triggerGrantable: false,
    truncate: privileges.includes("TRUNCATE"),
    truncateGrantable: false,
    update: privileges.includes("UPDATE"),
    updateGrantable: false,
  });
const EXPECTED_OBSERVER_RELATION_PRIVILEGES = Object.freeze(
  [
    ...PROVIDER_MANAGED_RELATION_PRIVILEGE_BASELINE.map(
      ({ columnPrivileges, objectName, privileges }) =>
        relationPrivilegeAuthority(objectName, privileges, columnPrivileges),
    ),
    relationPrivilegeAuthority(MIGRATION_HISTORY_RELATION, ["SELECT"]),
  ].sort((left, right) => UTF8_COMPARE(left.objectName, right.objectName)),
);
const EXPECTED_OBSERVER_SEQUENCE_PRIVILEGES = Object.freeze(
  PROVIDER_MANAGED_SEQUENCE_PRIVILEGE_BASELINE.map(
    ({ objectName, privileges }) =>
      Object.freeze({
        objectName,
        select: privileges.includes("SELECT"),
        selectGrantable: false,
        update: privileges.includes("UPDATE"),
        updateGrantable: false,
        usage: privileges.includes("USAGE"),
        usageGrantable: false,
      }),
  ),
);
const REQUIRED_RELATION_AUTHORITY_KEYS = Object.freeze([
  "forceRowSecurity",
  "objectName",
  "owner",
  "persistence",
  "relationKind",
  "replicaIdentity",
  "rowSecurity",
]);
const REQUIRED_RELATION_AUTHORITIES = Object.freeze(
  [CSP_TABLE, METRICS_TABLE].sort(UTF8_COMPARE).map((objectName) =>
    Object.freeze({
      forceRowSecurity: false,
      objectName,
      owner: "postgres",
      persistence: "p",
      relationKind: "r",
      replicaIdentity: "d",
      rowSecurity: true,
    }),
  ),
);
const REQUIRED_COLUMN_AUTHORITY_KEYS = Object.freeze([
  "dataType",
  "defaultExpression",
  "generated",
  "identity",
  "notNull",
  "objectName",
  "ordinal",
]);
const columnAuthority = (
  objectName,
  ordinal,
  dataType,
  notNull,
  defaultExpression = null,
  identity = "",
) =>
  Object.freeze({
    dataType,
    defaultExpression,
    generated: "",
    identity,
    notNull,
    objectName,
    ordinal,
  });
const REQUIRED_COLUMN_AUTHORITIES = Object.freeze([
  columnAuthority(`${CSP_TABLE}.id`, 1, "bigint", true, null, "a"),
  columnAuthority(
    `${CSP_TABLE}.received_at`,
    2,
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ),
  columnAuthority(`${CSP_TABLE}.schema_version`, 3, "smallint", true, "1"),
  columnAuthority(`${CSP_TABLE}.effective_directive`, 4, "text", true),
  columnAuthority(`${CSP_TABLE}.disposition`, 5, "text", true),
  columnAuthority(`${CSP_TABLE}.blocked_target`, 6, "text", true),
  columnAuthority(`${CSP_TABLE}.source_sha`, 7, "text", true),
  columnAuthority(`${CSP_TABLE}.provider_deployment_id`, 8, "text", true),
  columnAuthority(`${METRICS_TABLE}.id`, 1, "bigint", true, null, "a"),
  columnAuthority(
    `${METRICS_TABLE}.received_at`,
    2,
    "timestamp with time zone",
    true,
    "now()",
  ),
  columnAuthority(`${METRICS_TABLE}.schema_version`, 3, "smallint", true),
  columnAuthority(`${METRICS_TABLE}.event_version`, 4, "smallint", true),
  columnAuthority(`${METRICS_TABLE}.event_name`, 5, "text", true),
  columnAuthority(`${METRICS_TABLE}.outcome`, 6, "text", true),
  columnAuthority(`${METRICS_TABLE}.duration_bucket`, 7, "text", false),
  columnAuthority(`${METRICS_TABLE}.cleanup_mode`, 8, "text", false),
  columnAuthority(`${METRICS_TABLE}.cleanup_reason`, 9, "text", false),
  columnAuthority(`${METRICS_TABLE}.build_id`, 10, "text", true),
  columnAuthority(`${METRICS_TABLE}.browser_family`, 11, "text", true),
  columnAuthority(`${METRICS_TABLE}.app_mode`, 12, "text", true),
  columnAuthority(`${METRICS_TABLE}.online`, 13, "boolean", true),
]);
const REQUIRED_CONSTRAINT_AUTHORITY_KEYS = Object.freeze([
  "constraintName",
  "definitionSha256",
  "objectName",
  "type",
  "validated",
]);
const constraintAuthority = (
  objectName,
  constraintName,
  type,
  definitionSha256,
) =>
  Object.freeze({
    constraintName,
    definitionSha256,
    objectName,
    type,
    validated: true,
  });
const REQUIRED_CONSTRAINT_AUTHORITIES = Object.freeze([
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_blocked_target_check",
    "c",
    "0fa27a8b1088a469706d420cf2c1d682994760d7cfa02a5dc2048457e068f083",
  ),
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_disposition_check",
    "c",
    "9e74a5ed76caa073ffd8aa01c9672e1f7d02db71b40e72e7d01a9dd5fc99aa5c",
  ),
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_effective_directive_check",
    "c",
    "318baa76c9070355215fd667e454cf88c6b60a8408330994c5f1f73578dffe39",
  ),
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_pkey",
    "p",
    "8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5",
  ),
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_provider_deployment_id_check",
    "c",
    "cba5a772e493925359436258e19adf9270cab5ac2010eb61abb0846a59a8c964",
  ),
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_schema_version_check",
    "c",
    "99dafe6cdfeabc897fc0d1ab5cb666d4cb549e9e2e1e627c33b75a55c29a39a2",
  ),
  constraintAuthority(
    CSP_TABLE,
    "csp_violation_reports_source_sha_check",
    "c",
    "f24874f633de2e4fe0ff42b4012e67694ecd8fd28eaf00bf33c86c0808bb9509",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_app_mode_check",
    "c",
    "a78f4a8c56a95d04dc719005f78629bded832e47674f052296a558fdaf147b23",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_browser_family_check",
    "c",
    "7f71ba486f64af1d5057b0acaecd9548175803bbcfcabfa04d9a1d40ecf96507",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_build_id_check",
    "c",
    "9d2f4350ee087797fa77ff965dcfa7f369a502c6e23af55f6eb3aa1111731eb3",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_cleanup_mode_check",
    "c",
    "d5d9fffb4c1d2263ada5ee848aa86d2a20429280f11ff15fa49be20c0e8354a2",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_cleanup_reason_check",
    "c",
    "c9dc06b7d5db54b1a52e419ee153a356021a87d1501f174e039d293c1a156e3d",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_duration_check",
    "c",
    "ca4f1f49c835b90d3d6c2931469aecb8dfc0532c3d74b44418746a3e7ee8aea5",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_event_version_check",
    "c",
    "b373ca94512ba2d708d90360e7bcaca55cd523c78e33a0f451a5d384562d5f53",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_events_pkey",
    "p",
    "8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_name_check",
    "c",
    "beb86dfaf28d75363e14bfa51d54c97e4239e8554a3da0ef87911289cfb1a373",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_outcome_check",
    "c",
    "ce8eeb09a2d79ab4c76011631dfc81427e1a7dc05b8f809463230d21ce3bc0c2",
  ),
  constraintAuthority(
    METRICS_TABLE,
    "persistence_release_a_metric_schema_version_check",
    "c",
    "99dafe6cdfeabc897fc0d1ab5cb666d4cb549e9e2e1e627c33b75a55c29a39a2",
  ),
]);
const REQUIRED_FUNCTION_AUTHORITY_KEYS = Object.freeze([
  "definitionSha256",
  "identityArguments",
  "language",
  "leakproof",
  "owner",
  "parallel",
  "qualifiedName",
  "result",
  "securityDefiner",
  "strict",
  "volatility",
]);

export const REMOTE_DB_OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "contractFingerprint",
  "migrationChecksums",
  "migrationsApplied",
  "serviceRoleRawSelect",
  "serviceRoleRawInsert",
  "cspServiceRoleRawSelect",
  "cspServiceRoleRawInsert",
  "cspObjectsPresent",
  "operatorBoundedFunctionOnly",
  "cspApplicationCredentialReachable",
  "requiredTables",
  "requiredFunctions",
  "observedAt",
]);

export const REMOTE_DB_OBSERVATION_AUTHORITY_KEYS = Object.freeze([
  "bindingStatus",
  "postgresMajor",
  "databaseUrlEnvironmentName",
  "databaseCaEnvironmentName",
  "tlsMode",
  "allowedHosts",
  "allowedDatabases",
  "allowedObserverRoles",
  "serviceRole",
  "productionCaSha256",
  "connectTimeoutMilliseconds",
  "statementTimeoutMilliseconds",
  "maximumObservationAgeSeconds",
  "maximumFutureClockSkewSeconds",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sortedStrings = (values) => [...values].sort(UTF8_COMPARE);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const actual = sortedStrings(Object.keys(value));
  const expected = sortedStrings(expectedKeys);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const hasExactStringSet = (candidate, expected) => {
  if (
    !Array.isArray(candidate) ||
    candidate.some((value) => typeof value !== "string")
  ) {
    return false;
  }
  const actualValues = sortedStrings(candidate);
  const expectedValues = sortedStrings(expected);
  return (
    new Set(actualValues).size === actualValues.length &&
    actualValues.length === expectedValues.length &&
    actualValues.every((value, index) => value === expectedValues[index])
  );
};

const hasExactChecksums = (candidate, expected) => {
  if (!isRecord(candidate) || !isRecord(expected)) return false;
  const expectedEntries = Object.entries(expected);
  const actualKeys = Object.keys(candidate);
  return (
    actualKeys.length === expectedEntries.length &&
    expectedEntries.every(
      ([name, checksum]) =>
        typeof checksum === "string" && candidate[name] === checksum,
    )
  );
};

const hasExactRecordSet = (candidate, expected, keys) =>
  Array.isArray(candidate) &&
  candidate.length === expected.length &&
  candidate.every((entry) => hasExactKeys(entry, keys)) &&
  sha256Json(candidate) === sha256Json(expected);

const isExactServiceRoleTablePrivilege = (row) =>
  hasExactKeys(row, SERVICE_ROLE_TABLE_PRIVILEGE_KEYS) &&
  isAuthorityString(row.object_name, 255) &&
  row.service_insert === true &&
  row.service_column_insert === true &&
  SERVICE_ROLE_TABLE_PRIVILEGE_KEYS.filter(
    (key) =>
      key !== "object_name" &&
      key !== "service_insert" &&
      key !== "service_column_insert",
  ).every((key) => row[key] === false);

const isExactServiceRoleSequencePrivilege = (row) =>
  hasExactKeys(row, SERVICE_ROLE_SEQUENCE_PRIVILEGE_KEYS) &&
  isAuthorityString(row.object_name, 255) &&
  row.identity_bound === true &&
  row.service_usage === true &&
  SERVICE_ROLE_SEQUENCE_PRIVILEGE_KEYS.filter(
    (key) =>
      key !== "identity_bound" &&
      key !== "object_name" &&
      key !== "service_usage",
  ).every((key) => row[key] === false);

const isExactMigrationHistoryAuthority = (candidate) =>
  isRecord(candidate) &&
  hasExactKeys(candidate, MIGRATION_HISTORY_AUTHORITY_KEYS) &&
  /^\d{14}$/u.test(candidate.version) &&
  /^[a-z0-9_]{1,128}$/u.test(candidate.migrationName) &&
  Number.isSafeInteger(candidate.statementCount) &&
  candidate.statementCount > 0 &&
  /^[0-9a-f]{64}$/u.test(candidate.statementsSha256);

const hasExactObserverAuthorization = (authorization) => {
  if (
    !hasExactKeys(authorization, OBSERVER_AUTHORIZATION_KEYS) ||
    !hasExactStringSet(authorization.memberships, []) ||
    authorization.ownedObjectCount !== 0 ||
    !hasExactKeys(
      authorization.currentDatabase,
      OBSERVER_DATABASE_PRIVILEGE_KEYS,
    ) ||
    sha256Json(authorization.currentDatabase) !==
      sha256Json(EXPECTED_OBSERVER_CURRENT_DATABASE) ||
    !hasExactStringSet(authorization.databaseCreateAuthorities, []) ||
    !hasExactStringSet(authorization.managedFunctionDirectAuthorities, []) ||
    !hasExactStringSet(authorization.managedObjectDirectAuthorities, []) ||
    !hasExactRecordSet(
      authorization.boundedFunctions,
      OBSERVER_BOUNDED_FUNCTION_AUTHORITIES,
      OBSERVER_FUNCTION_AUTHORITY_KEYS,
    ) ||
    !hasExactRecordSet(
      authorization.schemaPrivileges,
      EXPECTED_OBSERVER_SCHEMA_PRIVILEGES,
      OBSERVER_SCHEMA_PRIVILEGE_KEYS,
    ) ||
    !hasExactRecordSet(
      authorization.relationPrivileges,
      EXPECTED_OBSERVER_RELATION_PRIVILEGES,
      OBSERVER_RELATION_PRIVILEGE_KEYS,
    ) ||
    !hasExactRecordSet(
      authorization.sequencePrivileges,
      EXPECTED_OBSERVER_SEQUENCE_PRIVILEGES,
      OBSERVER_SEQUENCE_PRIVILEGE_KEYS,
    )
  ) {
    return false;
  }
  return true;
};

const hasControlCharacter = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const isAuthorityString = (value, maximumBytes = 255) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= maximumBytes &&
  !hasControlCharacter(value);

const isSortedUniqueAuthorityStrings = (values, maximumBytes = 255) =>
  Array.isArray(values) &&
  values.every((value) => isAuthorityString(value, maximumBytes)) &&
  new Set(values).size === values.length &&
  values.every(
    (value, index) => index === 0 || UTF8_COMPARE(values[index - 1], value) < 0,
  );

export const assertRemoteDbObservationAuthority = (
  authority,
  { requireConfigured = false } = {},
) => {
  if (
    !hasExactKeys(authority, REMOTE_DB_OBSERVATION_AUTHORITY_KEYS) ||
    (authority.bindingStatus !== "configured" &&
      authority.bindingStatus !== "unconfigured") ||
    authority.postgresMajor !== REQUIRED_POSTGRES_MAJOR ||
    authority.databaseUrlEnvironmentName !== DATABASE_URL_ENVIRONMENT_NAME ||
    authority.databaseCaEnvironmentName !== DATABASE_CA_ENVIRONMENT_NAME ||
    authority.tlsMode !== "verify-full" ||
    !isSortedUniqueAuthorityStrings(authority.allowedHosts) ||
    authority.allowedHosts.some((host) => host !== host.toLowerCase()) ||
    !isSortedUniqueAuthorityStrings(authority.allowedDatabases, 63) ||
    !isSortedUniqueAuthorityStrings(authority.allowedObserverRoles, 63) ||
    !isAuthorityString(authority.serviceRole, 63) ||
    (authority.productionCaSha256 !== null &&
      (typeof authority.productionCaSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(authority.productionCaSha256))) ||
    !Number.isSafeInteger(authority.connectTimeoutMilliseconds) ||
    authority.connectTimeoutMilliseconds < 1 ||
    authority.connectTimeoutMilliseconds > 60_000 ||
    !Number.isSafeInteger(authority.statementTimeoutMilliseconds) ||
    authority.statementTimeoutMilliseconds < 1 ||
    authority.statementTimeoutMilliseconds > 60_000 ||
    !Number.isSafeInteger(authority.maximumObservationAgeSeconds) ||
    authority.maximumObservationAgeSeconds < 1 ||
    authority.maximumObservationAgeSeconds > 3_600 ||
    !Number.isSafeInteger(authority.maximumFutureClockSkewSeconds) ||
    authority.maximumFutureClockSkewSeconds < 0 ||
    authority.maximumFutureClockSkewSeconds > 300
  ) {
    throw new Error("Remote DB observation authority is invalid");
  }
  if (
    (authority.bindingStatus === "configured" &&
      (authority.allowedHosts.length === 0 ||
        authority.allowedDatabases.length === 0 ||
        authority.allowedObserverRoles.length === 0 ||
        authority.allowedObserverRoles.includes(authority.serviceRole) ||
        authority.productionCaSha256 === null)) ||
    (authority.bindingStatus === "unconfigured" &&
      (authority.allowedHosts.length !== 0 ||
        authority.allowedDatabases.length !== 0 ||
        authority.allowedObserverRoles.length !== 0 ||
        authority.productionCaSha256 !== null))
  ) {
    throw new Error("Remote DB observation authority is invalid");
  }
  if (requireConfigured && authority.bindingStatus !== "configured") {
    throw new Error("Remote DB observation authority is not configured");
  }
  return authority;
};

const assertObservationExpectation = ({ contract, migrationChecksums }) => {
  if (
    !isRecord(contract) ||
    !isRecord(contract.remote) ||
    !Array.isArray(contract.remote.requiredTables) ||
    !Array.isArray(contract.remote.requiredFunctions) ||
    !isSortedUniqueAuthorityStrings(
      contract.remote.observerManagedSchemas,
      63,
    ) ||
    !hasExactStringSet(
      contract.remote.observerManagedSchemas,
      PROVIDER_MANAGED_SCHEMAS,
    ) ||
    !hasExactStringSet(
      contract.remote.observerManagedSchemaUsage,
      PROVIDER_MANAGED_SCHEMA_USAGE,
    ) ||
    !Array.isArray(contract.remote.observerManagedRelationPrivilegeBaseline) ||
    sha256Json(contract.remote.observerManagedRelationPrivilegeBaseline) !==
      sha256Json(PROVIDER_MANAGED_RELATION_PRIVILEGE_BASELINE) ||
    !Array.isArray(contract.remote.observerManagedSequencePrivilegeBaseline) ||
    sha256Json(contract.remote.observerManagedSequencePrivilegeBaseline) !==
      sha256Json(PROVIDER_MANAGED_SEQUENCE_PRIVILEGE_BASELINE) ||
    !Array.isArray(contract.remote.migrationHistory) ||
    contract.remote.migrationHistory.some(
      (entry) => !isExactMigrationHistoryAuthority(entry),
    ) ||
    !hasExactStringSet(
      contract.remote.migrationHistory.map(({ version }) => version),
      migrationVersions(migrationChecksums),
    ) ||
    !hasExactChecksums(contract.remote.migrationChecksums, migrationChecksums)
  ) {
    throw new Error("Remote DB observation authority is invalid");
  }
  return assertRemoteDbObservationAuthority(
    contract.remote.observationAuthority,
    { requireConfigured: true },
  );
};

export const assertRemoteDbObservation = (
  evidence,
  { contract, migrationChecksums, now = Date.now },
) => {
  const authority = assertObservationExpectation({
    contract,
    migrationChecksums,
  });
  const observedAt =
    typeof evidence?.observedAt === "string"
      ? Date.parse(evidence.observedAt)
      : Number.NaN;
  const nowMilliseconds = clockMilliseconds(now);
  const canonicalObservedAt =
    Number.isFinite(observedAt) &&
    new Date(observedAt).toISOString() === evidence.observedAt;
  if (
    !hasExactKeys(evidence, REMOTE_DB_OBSERVATION_KEYS) ||
    evidence.schemaVersion !== 1 ||
    evidence.contractFingerprint !== sha256Json(contract) ||
    !hasExactChecksums(evidence.migrationChecksums, migrationChecksums) ||
    evidence.migrationsApplied !== true ||
    evidence.serviceRoleRawSelect !== false ||
    evidence.serviceRoleRawInsert !== true ||
    evidence.cspServiceRoleRawSelect !== false ||
    evidence.cspServiceRoleRawInsert !== true ||
    evidence.operatorBoundedFunctionOnly !== true ||
    evidence.cspApplicationCredentialReachable !== false ||
    !hasExactStringSet(
      evidence.requiredTables,
      contract.remote.requiredTables,
    ) ||
    !hasExactStringSet(
      evidence.requiredFunctions,
      contract.remote.requiredFunctions,
    ) ||
    !canonicalObservedAt ||
    observedAt <
      nowMilliseconds - authority.maximumObservationAgeSeconds * 1_000 ||
    observedAt >
      nowMilliseconds + authority.maximumFutureClockSkewSeconds * 1_000
  ) {
    throw new Error(
      "Remote DB evidence does not match the compatibility contract",
    );
  }
  return evidence;
};

const requireSingleRow = (result, label) => {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    (typeof result.rowCount === "number" && result.rowCount !== 1)
  ) {
    throw new Error(`Remote DB ${label} query is ambiguous`);
  }
  return result.rows[0];
};

const requireExactRows = (result, expectedCount, label) => {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== expectedCount ||
    (typeof result.rowCount === "number" && result.rowCount !== expectedCount)
  ) {
    throw new Error(`Remote DB ${label} row set is incomplete`);
  }
  return result.rows;
};

const requireRows = (result, label) => {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    (typeof result.rowCount === "number" &&
      result.rowCount !== result.rows.length)
  ) {
    throw new Error(`Remote DB ${label} row set is invalid`);
  }
  return result.rows;
};

const migrationVersions = (migrationChecksums) =>
  sortedStrings(
    Object.keys(migrationChecksums).map((name) => {
      const match = /^(\d{14})_[a-z0-9_]+\.sql$/u.exec(name);
      if (!match) {
        throw new Error("Remote DB migration identity is invalid");
      }
      return match[1];
    }),
  );

const functionSignature = (row) =>
  `${row.qualified_name}(${row.identity_arguments})`;

const hasSearchPathAuthority = (configuration) =>
  Array.isArray(configuration) &&
  configuration.includes("search_path=pg_catalog, public");

const clockMilliseconds = (now) => {
  const milliseconds = typeof now === "function" ? Number(now()) : Number(now);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Remote DB observation clock is invalid");
  }
  return milliseconds;
};

const identityQuery = (serviceRole) => ({
  name: "foundation-remote-db-observer-identity-v3",
  text: `
    select
      current_user::text as observer_role,
      session_user::text as session_role,
      current_setting('transaction_read_only') as read_only,
      current_setting('server_version_num') as server_version_num,
      roles.rolsuper,
      roles.rolcreaterole,
      roles.rolcreatedb,
      roles.rolreplication,
      roles.rolbypassrls,
      roles.rolcanlogin,
      roles.rolinherit,
      pg_catalog.has_database_privilege(
        current_user, current_database(), 'CONNECT'
      ) as database_connect,
      pg_catalog.has_database_privilege(
        current_user, current_database(), 'CONNECT WITH GRANT OPTION'
      ) as database_connect_grantable,
      pg_catalog.has_database_privilege(
        current_user, current_database(), 'CREATE'
      ) as database_create,
      pg_catalog.has_database_privilege(
        current_user, current_database(), 'CREATE WITH GRANT OPTION'
      ) as database_create_grantable,
      pg_catalog.has_database_privilege(
        current_user, current_database(), 'TEMPORARY'
      ) as database_temporary,
      pg_catalog.has_database_privilege(
        current_user, current_database(), 'TEMPORARY WITH GRANT OPTION'
      ) as database_temporary_grantable,
      pg_catalog.pg_has_role(current_user, $1::name, 'MEMBER')
        as service_role_member
    from pg_catalog.pg_roles roles
    where roles.rolname = current_user
  `,
  values: [serviceRole],
});

const observerMembershipsQuery = Object.freeze({
  name: "foundation-remote-db-observer-memberships-v2",
  text: `
    select roles.rolname::text as role
    from pg_catalog.pg_roles roles
    where roles.rolname <> current_user
      and pg_catalog.pg_has_role(current_user, roles.oid, 'MEMBER')
    order by role
  `,
  values: [],
});

const observerOwnershipQuery = Object.freeze({
  name: "foundation-remote-db-observer-owned-objects-v2",
  text: `
    select count(*)::text as owned_object_count
    from pg_catalog.pg_shdepend ownership
    where ownership.refclassid =
        pg_catalog.to_regclass('pg_catalog.pg_authid')
      and ownership.refobjid = (
        select roles.oid
        from pg_catalog.pg_roles roles
        where roles.rolname = current_user
      )
      and ownership.deptype = 'o'
  `,
  values: [],
});

const observerRelationPrivilegesQuery = Object.freeze({
  name: "foundation-remote-db-observer-relation-privileges-v3",
  text: `
    with observed as (
      select
        namespace.nspname || '.' || relation.relname as object_name,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'SELECT'
        ) as observer_select,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'INSERT'
        ) as observer_insert,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'UPDATE'
        ) as observer_update,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'DELETE'
        ) as observer_delete,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'TRUNCATE'
        ) as observer_truncate,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'REFERENCES'
        ) as observer_references,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'TRIGGER'
        ) as observer_trigger,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'MAINTAIN'
        ) as observer_maintain,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'SELECT WITH GRANT OPTION'
        ) as observer_select_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'INSERT WITH GRANT OPTION'
        ) as observer_insert_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'UPDATE WITH GRANT OPTION'
        ) as observer_update_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'DELETE WITH GRANT OPTION'
        ) as observer_delete_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'TRUNCATE WITH GRANT OPTION'
        ) as observer_truncate_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'REFERENCES WITH GRANT OPTION'
        ) as observer_references_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'TRIGGER WITH GRANT OPTION'
        ) as observer_trigger_grantable,
        pg_catalog.has_table_privilege(
          current_user, relation.oid, 'MAINTAIN WITH GRANT OPTION'
        ) as observer_maintain_grantable,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'SELECT'
        ) as observer_column_select,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'INSERT'
        ) as observer_column_insert,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'UPDATE'
        ) as observer_column_update,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'REFERENCES'
        ) as observer_column_references,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'SELECT WITH GRANT OPTION'
        ) as observer_column_select_grantable,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'INSERT WITH GRANT OPTION'
        ) as observer_column_insert_grantable,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'UPDATE WITH GRANT OPTION'
        ) as observer_column_update_grantable,
        pg_catalog.has_any_column_privilege(
          current_user, relation.oid, 'REFERENCES WITH GRANT OPTION'
        ) as observer_column_references_grantable
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where relation.relkind in ('r', 'p', 'v', 'm', 'f')
        and namespace.nspname not like 'pg\\_%' escape '\\'
        and namespace.nspname <> 'information_schema'
    )
    select *
    from observed
    where observer_select
      or observer_insert
      or observer_update
      or observer_delete
      or observer_truncate
      or observer_references
      or observer_trigger
      or observer_maintain
      or observer_select_grantable
      or observer_insert_grantable
      or observer_update_grantable
      or observer_delete_grantable
      or observer_truncate_grantable
      or observer_references_grantable
      or observer_trigger_grantable
      or observer_maintain_grantable
      or observer_column_select
      or observer_column_insert
      or observer_column_update
      or observer_column_references
      or observer_column_select_grantable
      or observer_column_insert_grantable
      or observer_column_update_grantable
      or observer_column_references_grantable
    order by object_name
  `,
  values: [],
});

const observerExecutablePublicFunctionsQuery = Object.freeze({
  name: "foundation-remote-db-observer-executable-functions-v3",
  text: `
    select
      namespace.nspname || '.' || function_definition.proname || '(' ||
        pg_catalog.oidvectortypes(function_definition.proargtypes) || ')' as
        function_signature,
      pg_catalog.has_function_privilege(
        current_user, function_definition.oid, 'EXECUTE'
      ) as observer_execute,
      pg_catalog.has_function_privilege(
        current_user, function_definition.oid, 'EXECUTE WITH GRANT OPTION'
      ) as observer_execute_grantable,
      pg_catalog.pg_get_userbyid(function_definition.proowner) as function_owner,
      language.lanname as function_language,
      pg_catalog.pg_get_function_result(function_definition.oid) as function_result,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(function_definition.oid), 'UTF8'
          )
        ),
        'hex'
      ) as definition_sha256
    from pg_catalog.pg_proc function_definition
    join pg_catalog.pg_namespace namespace
      on namespace.oid = function_definition.pronamespace
    join pg_catalog.pg_language language
      on language.oid = function_definition.prolang
    where namespace.nspname not like 'pg\\_%' escape '\\'
      and namespace.nspname <> 'information_schema'
      and namespace.nspname <> all($1::text[])
      and (
        pg_catalog.has_function_privilege(
          current_user, function_definition.oid, 'EXECUTE'
        )
        or pg_catalog.has_function_privilege(
          current_user, function_definition.oid, 'EXECUTE WITH GRANT OPTION'
        )
      )
    order by function_signature
  `,
  values: [PROVIDER_MANAGED_SCHEMAS],
});

const observerManagedFunctionDirectPrivilegesQuery = Object.freeze({
  name: "foundation-remote-db-observer-managed-function-acl-v3",
  text: `
    select
      namespace.nspname || '.' || function_definition.proname || '(' ||
        pg_catalog.oidvectortypes(function_definition.proargtypes) || ')' as
        function_signature,
      function_acl.is_grantable as observer_execute_grantable
    from pg_catalog.pg_proc function_definition
    join pg_catalog.pg_namespace namespace
      on namespace.oid = function_definition.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        function_definition.proacl,
        pg_catalog.acldefault('f', function_definition.proowner)
      )
    ) function_acl
    where namespace.nspname = any($1::text[])
      and function_acl.grantee = (
        select roles.oid
        from pg_catalog.pg_roles roles
        where roles.rolname = current_user
      )
      and function_acl.privilege_type = 'EXECUTE'
    order by function_signature
  `,
  values: [PROVIDER_MANAGED_SCHEMAS],
});

const observerManagedObjectDirectPrivilegesQuery = Object.freeze({
  name: "foundation-remote-db-observer-managed-object-acl-v1",
  text: `
    select
      case
        when relation.relkind = 'S' then 'sequence'
        else 'relation'
      end as object_type,
      namespace.nspname || '.' || relation.relname as object_name,
      relation_acl.privilege_type::text as privilege,
      relation_acl.is_grantable as grantable
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(relation.relacl) relation_acl
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and relation_acl.grantee = (
        select roles.oid
        from pg_catalog.pg_roles roles
        where roles.rolname = current_user
      )
    union all
    select
      'column'::text,
      namespace.nspname || '.' || relation.relname || '.' ||
        attribute.attname,
      column_acl.privilege_type::text,
      column_acl.is_grantable
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) column_acl
    where namespace.nspname = any($1::text[])
      and attribute.attnum > 0
      and not attribute.attisdropped
      and column_acl.grantee = (
        select roles.oid
        from pg_catalog.pg_roles roles
        where roles.rolname = current_user
      )
    union all
    select
      'schema'::text,
      namespace.nspname,
      schema_acl.privilege_type::text,
      schema_acl.is_grantable
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) schema_acl
    where namespace.nspname = any($1::text[])
      and schema_acl.grantee = (
        select roles.oid
        from pg_catalog.pg_roles roles
        where roles.rolname = current_user
      )
    order by object_type, object_name, privilege, grantable
  `,
  values: [PROVIDER_MANAGED_SCHEMAS],
});

const observerSequencePrivilegesQuery = Object.freeze({
  name: "foundation-remote-db-observer-sequence-privileges-v3",
  text: `
    with observed as (
      select
        namespace.nspname || '.' || sequence_definition.relname as object_name,
        pg_catalog.has_sequence_privilege(
          current_user, sequence_definition.oid, 'USAGE'
        ) as observer_usage,
        pg_catalog.has_sequence_privilege(
          current_user, sequence_definition.oid, 'SELECT'
        ) as observer_select,
        pg_catalog.has_sequence_privilege(
          current_user, sequence_definition.oid, 'UPDATE'
        ) as observer_update,
        pg_catalog.has_sequence_privilege(
          current_user, sequence_definition.oid, 'USAGE WITH GRANT OPTION'
        ) as observer_usage_grantable,
        pg_catalog.has_sequence_privilege(
          current_user, sequence_definition.oid, 'SELECT WITH GRANT OPTION'
        ) as observer_select_grantable,
        pg_catalog.has_sequence_privilege(
          current_user, sequence_definition.oid, 'UPDATE WITH GRANT OPTION'
        ) as observer_update_grantable
      from pg_catalog.pg_class sequence_definition
      join pg_catalog.pg_namespace namespace
        on namespace.oid = sequence_definition.relnamespace
      where sequence_definition.relkind = 'S'
        and namespace.nspname not like 'pg\\_%' escape '\\'
        and namespace.nspname <> 'information_schema'
    )
    select *
    from observed
    where observer_usage
      or observer_select
      or observer_update
      or observer_usage_grantable
      or observer_select_grantable
      or observer_update_grantable
    order by object_name
  `,
  values: [],
});

const observerSchemaPrivilegesQuery = Object.freeze({
  name: "foundation-remote-db-observer-schema-privileges-v3",
  text: `
    with observed as (
      select
        namespace.nspname as object_name,
        pg_catalog.has_schema_privilege(
          current_user, namespace.oid, 'USAGE'
        ) as observer_usage,
        pg_catalog.has_schema_privilege(
          current_user, namespace.oid, 'USAGE WITH GRANT OPTION'
        ) as observer_usage_grantable,
        pg_catalog.has_schema_privilege(
          current_user, namespace.oid, 'CREATE'
        ) as observer_create,
        pg_catalog.has_schema_privilege(
          current_user, namespace.oid, 'CREATE WITH GRANT OPTION'
        ) as observer_create_grantable
      from pg_catalog.pg_namespace namespace
      where namespace.nspname not like 'pg\\_%' escape '\\'
        and namespace.nspname <> 'information_schema'
    )
    select
      object_name,
      observer_usage,
      observer_usage_grantable,
      observer_create,
      observer_create_grantable
    from observed
    where observer_create
      or observer_create_grantable
      or observer_usage_grantable
      or observer_usage
    order by object_name
  `,
  values: [],
});

const observerDatabaseCreatePrivilegesQuery = Object.freeze({
  name: "foundation-remote-db-observer-database-create-privileges-v3",
  text: `
    select database_definition.datname::text as database_name
    from pg_catalog.pg_database database_definition
    where pg_catalog.has_database_privilege(
        current_user, database_definition.oid, 'CREATE'
      )
      or pg_catalog.has_database_privilege(
        current_user, database_definition.oid, 'CREATE WITH GRANT OPTION'
      )
    order by database_name
  `,
  values: [],
});

const migrationsQuery = () => ({
  name: "foundation-remote-db-migrations-v2",
  text: `
    select
      version::text as version,
      name::text as migration_name,
      pg_catalog.cardinality(statements)::integer as statement_count,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(pg_catalog.array_to_string(statements, E'\\n'), ''),
            'UTF8'
          )
        ),
        'hex'
      ) as statements_sha256
    from supabase_migrations.schema_migrations
    order by version
  `,
  values: [],
});

const relationsQuery = (requiredTables) => ({
  name: "foundation-remote-db-relations-v2",
  text: `
    select
      n.nspname || '.' || c.relname as qualified_name,
      c.relkind,
      c.relrowsecurity as row_security,
      c.relforcerowsecurity as force_row_security,
      c.relpersistence as persistence,
      c.relreplident as replica_identity,
      pg_catalog.pg_get_userbyid(c.relowner) as relation_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = any($1::text[])
    order by qualified_name
  `,
  values: [requiredTables],
});

const columnsQuery = (requiredTables) => ({
  name: "foundation-remote-db-columns-v1",
  text: `
    select
      namespace.nspname || '.' || relation.relname || '.' ||
        attribute.attname as object_name,
      attribute.attnum::integer as ordinal,
      pg_catalog.format_type(
        attribute.atttypid, attribute.atttypmod
      ) as data_type,
      attribute.attnotnull as not_null,
      attribute.attidentity::text as identity,
      attribute.attgenerated::text as generated,
      pg_catalog.pg_get_expr(
        default_definition.adbin, default_definition.adrelid
      ) as default_expression
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    left join pg_catalog.pg_attrdef default_definition
      on default_definition.adrelid = attribute.attrelid
      and default_definition.adnum = attribute.attnum
    where namespace.nspname || '.' || relation.relname = any($1::text[])
      and attribute.attnum > 0
      and not attribute.attisdropped
    order by namespace.nspname, relation.relname, attribute.attnum
  `,
  values: [requiredTables],
});

const constraintsQuery = (requiredTables) => ({
  name: "foundation-remote-db-constraints-v2",
  text: `
    select
      namespace.nspname || '.' || relation.relname as object_name,
      constraint_definition.conname::text as constraint_name,
      constraint_definition.contype::text as constraint_type,
      constraint_definition.convalidated as validated,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_constraintdef(
              constraint_definition.oid, true
            ),
            'UTF8'
          )
        ),
        'hex'
      ) as definition_sha256
    from pg_catalog.pg_constraint constraint_definition
    join pg_catalog.pg_class relation
      on relation.oid = constraint_definition.conrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname || '.' || relation.relname = any($1::text[])
    order by object_name, constraint_name
  `,
  values: [requiredTables],
});

const policiesQuery = (requiredTables) => ({
  name: "foundation-remote-db-policies-v1",
  text: `
    select
      namespace.nspname || '.' || relation.relname as object_name,
      policy.polname::text as policy_name,
      policy.polpermissive as permissive,
      policy.polcmd::text as command,
      coalesce(
        (
          select pg_catalog.array_agg(
            case
              when requested_role.role_oid = 0 then 'PUBLIC'
              else role.rolname
            end
            order by requested_role.role_oid
          )
          from pg_catalog.unnest(policy.polroles)
            as requested_role(role_oid)
          left join pg_catalog.pg_roles role
            on role.oid = requested_role.role_oid
        ),
        '{}'::text[]
      ) as roles,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
            'UTF8'
          )
        ),
        'hex'
      ) as using_sha256,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(
              pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
              ''
            ),
            'UTF8'
          )
        ),
        'hex'
      ) as check_sha256
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname || '.' || relation.relname = any($1::text[])
    order by object_name, policy_name
  `,
  values: [requiredTables],
});

const triggersQuery = (requiredTables) => ({
  name: "foundation-remote-db-triggers-v1",
  text: `
    select
      namespace.nspname || '.' || relation.relname as object_name,
      trigger_definition.tgname::text as trigger_name,
      trigger_definition.tgisinternal as internal,
      trigger_definition.tgenabled::text as enabled,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_triggerdef(trigger_definition.oid, true),
            'UTF8'
          )
        ),
        'hex'
      ) as definition_sha256
    from pg_catalog.pg_trigger trigger_definition
    join pg_catalog.pg_class relation
      on relation.oid = trigger_definition.tgrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname || '.' || relation.relname = any($1::text[])
    order by object_name, trigger_name
  `,
  values: [requiredTables],
});

const functionsQuery = (requiredFunctions) => ({
  name: "foundation-remote-db-functions-v2",
  text: `
    select
      n.nspname || '.' || p.proname as qualified_name,
      pg_catalog.oidvectortypes(p.proargtypes) as identity_arguments,
      p.prosecdef as security_definer,
      p.proconfig as configuration,
      pg_catalog.pg_get_userbyid(p.proowner) as function_owner,
      language.lanname as function_language,
      pg_catalog.pg_get_function_result(p.oid) as function_result,
      p.proleakproof as leakproof,
      p.provolatile::text as volatility,
      p.proparallel::text as parallel,
      p.proisstrict as strict,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(p.oid), 'UTF8'
          )
        ),
        'hex'
      ) as definition_sha256
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language language on language.oid = p.prolang
    where n.nspname || '.' || p.proname = any($1::text[])
    order by qualified_name, identity_arguments
  `,
  values: [requiredFunctions],
});

const tablePrivilegesQuery = (requiredTables, serviceRole) => ({
  name: "foundation-remote-db-table-privileges-v2",
  text: `
    select
      requested.object_name,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'SELECT'
      ) as service_select,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'SELECT'
      ) as service_column_select,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'INSERT'
      ) as service_insert,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'INSERT'
      ) as service_column_insert,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'UPDATE'
      ) as service_update,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'DELETE'
      ) as service_delete,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'TRUNCATE'
      ) as service_truncate,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'REFERENCES'
      ) as service_references,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'TRIGGER'
      ) as service_trigger,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'MAINTAIN'
      ) as service_maintain,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'SELECT WITH GRANT OPTION'
      ) as service_select_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'INSERT WITH GRANT OPTION'
      ) as service_insert_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'UPDATE WITH GRANT OPTION'
      ) as service_update_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'DELETE WITH GRANT OPTION'
      ) as service_delete_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'TRUNCATE WITH GRANT OPTION'
      ) as service_truncate_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'REFERENCES WITH GRANT OPTION'
      ) as service_references_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'TRIGGER WITH GRANT OPTION'
      ) as service_trigger_grantable,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'MAINTAIN WITH GRANT OPTION'
      ) as service_maintain_grantable,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'SELECT WITH GRANT OPTION'
      ) as service_column_select_grantable,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'INSERT WITH GRANT OPTION'
      ) as service_column_insert_grantable,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'UPDATE'
      ) as service_column_update,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'UPDATE WITH GRANT OPTION'
      ) as service_column_update_grantable,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'REFERENCES'
      ) as service_column_references,
      pg_catalog.has_any_column_privilege(
        $2, requested.object_name, 'REFERENCES WITH GRANT OPTION'
      ) as service_column_references_grantable
    from unnest($1::text[]) as requested(object_name)
    order by requested.object_name
  `,
  values: [requiredTables, serviceRole],
});

const serviceRoleSequencePrivilegesQuery = (serviceRole) => ({
  name: "foundation-remote-db-service-role-sequence-privileges-v1",
  text: `
    with requested as (
      select
        ($1::text[])[requested_index] as object_name,
        ($2::text[])[requested_index] as table_name,
        ($3::text[])[requested_index] as column_name
      from pg_catalog.generate_subscripts(
        $1::text[], 1
      ) as requested_ordinal(requested_index)
    )
    select
      requested.object_name,
      pg_catalog.pg_get_serial_sequence(
        requested.table_name, requested.column_name
      ) = requested.object_name as identity_bound,
      pg_catalog.has_sequence_privilege(
        $4, requested.object_name, 'USAGE'
      ) as service_usage,
      pg_catalog.has_sequence_privilege(
        $4, requested.object_name, 'SELECT'
      ) as service_select,
      pg_catalog.has_sequence_privilege(
        $4, requested.object_name, 'UPDATE'
      ) as service_update,
      pg_catalog.has_sequence_privilege(
        $4, requested.object_name, 'USAGE WITH GRANT OPTION'
      ) as service_usage_grantable,
      pg_catalog.has_sequence_privilege(
        $4, requested.object_name, 'SELECT WITH GRANT OPTION'
      ) as service_select_grantable,
      pg_catalog.has_sequence_privilege(
        $4, requested.object_name, 'UPDATE WITH GRANT OPTION'
      ) as service_update_grantable
    from requested
    order by requested.object_name
  `,
  values: [
    [CSP_SEQUENCE, METRICS_SEQUENCE],
    [CSP_TABLE, METRICS_TABLE],
    ["id", "id"],
    serviceRole,
  ],
});

const cspDormantAuthorityQuery = Object.freeze({
  name: "foundation-remote-db-csp-dormant-authority-v1",
  text: `
    with requested_principals as (
      select principal
      from unnest($1::text[]) as requested(principal)
    ),
    requested_routines as (
      select signature, pg_catalog.to_regprocedure(signature) as routine_oid
      from unnest($2::text[]) as requested(signature)
    ),
    public_relation_acl as (
      select
        'PUBLIC'::text as principal,
        case when relation.relkind = 'S' then 'sequence' else 'table' end
          as object_type,
        namespace.nspname || '.' || relation.relname as object_name,
        relation_acl.privilege_type::text as privilege,
        relation_acl.is_grantable as grantable
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            case when relation.relkind = 'S' then 'S'::"char" else 'r'::"char" end,
            relation.relowner
          )
        )
      ) relation_acl
      where namespace.nspname = 'public'
        and relation.relname in (
          'csp_violation_reports',
          'csp_violation_reports_id_seq'
        )
        and relation_acl.grantee = 0
    ),
    public_column_acl as (
      select
        'PUBLIC'::text as principal,
        'column'::text as object_type,
        namespace.nspname || '.' || relation.relname || '.' ||
          attribute.attname as object_name,
        column_acl.privilege_type::text as privilege,
        column_acl.is_grantable as grantable
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        attribute.attacl
      ) column_acl
      where namespace.nspname = 'public'
        and relation.relname = 'csp_violation_reports'
        and attribute.attnum > 0
        and not attribute.attisdropped
        and column_acl.grantee = 0
    ),
    public_routine_acl as (
      select
        'PUBLIC'::text as principal,
        'routine'::text as object_type,
        requested.signature as object_name,
        routine_acl.privilege_type::text as privilege,
        routine_acl.is_grantable as grantable
      from requested_routines requested
      join pg_catalog.pg_proc routine on routine.oid = requested.routine_oid
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          routine.proacl,
          pg_catalog.acldefault('f'::"char", routine.proowner)
        )
      ) routine_acl
      where routine_acl.grantee = 0
    ),
    effective_principal_authority as (
      select
        requested.principal,
        'table'::text as object_type,
        $3::text as object_name,
        privilege.name as privilege,
        pg_catalog.has_table_privilege(
          requested.principal, $3::text, privilege.name
        ) as granted,
        pg_catalog.has_table_privilege(
          requested.principal,
          $3::text,
          privilege.name || ' WITH GRANT OPTION'
        ) as grantable
      from requested_principals requested
      cross join (values
        ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
        ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
      ) privilege(name)
      union all
      select
        requested.principal,
        'column'::text,
        $3::text,
        privilege.name,
        pg_catalog.has_any_column_privilege(
          requested.principal, $3::text, privilege.name
        ),
        pg_catalog.has_any_column_privilege(
          requested.principal,
          $3::text,
          privilege.name || ' WITH GRANT OPTION'
        )
      from requested_principals requested
      cross join (values
        ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
      ) privilege(name)
      union all
      select
        requested.principal,
        'sequence'::text,
        $4::text,
        privilege.name,
        pg_catalog.has_sequence_privilege(
          requested.principal, $4::text, privilege.name
        ),
        pg_catalog.has_sequence_privilege(
          requested.principal,
          $4::text,
          privilege.name || ' WITH GRANT OPTION'
        )
      from requested_principals requested
      cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) privilege(name)
      union all
      select
        requested.principal,
        'routine'::text,
        routine.signature,
        'EXECUTE'::text,
        pg_catalog.has_function_privilege(
          requested.principal, routine.routine_oid, 'EXECUTE'
        ),
        pg_catalog.has_function_privilege(
          requested.principal,
          routine.routine_oid,
          'EXECUTE WITH GRANT OPTION'
        )
      from requested_principals requested
      cross join requested_routines routine
    )
    select principal, object_type, object_name, privilege, grantable
    from public_relation_acl
    union all
    select principal, object_type, object_name, privilege, grantable
    from public_column_acl
    union all
    select principal, object_type, object_name, privilege, grantable
    from public_routine_acl
    union all
    select principal, object_type, object_name, privilege, grantable
    from effective_principal_authority
    where granted or grantable
    order by principal, object_type, object_name, privilege, grantable
  `,
  values: [
    CSP_DORMANT_PRINCIPALS,
    CSP_ROUTINE_SIGNATURES,
    CSP_TABLE,
    CSP_SEQUENCE,
  ],
});

const functionPrivilegesQuery = (signatures, serviceRole) => ({
  name: "foundation-remote-db-function-privileges-v2",
  text: `
    select
      requested.function_signature,
      pg_catalog.has_function_privilege(
        $2, requested.function_signature, 'EXECUTE'
      ) as service_execute,
      pg_catalog.has_function_privilege(
        $2,
        requested.function_signature,
        'EXECUTE WITH GRANT OPTION'
      ) as service_execute_grantable,
      pg_catalog.has_function_privilege(
        current_user, requested.function_signature, 'EXECUTE'
      ) as observer_execute,
      pg_catalog.has_function_privilege(
        current_user,
        requested.function_signature,
        'EXECUTE WITH GRANT OPTION'
      ) as observer_execute_grantable
    from unnest($1::text[]) as requested(function_signature)
    order by requested.function_signature
  `,
  values: [signatures, serviceRole],
});

export const collectRemoteDbObservation = async ({
  client,
  contract,
  migrationChecksums,
  providerPolicy,
  providerObservation,
  expectedObserverRole,
  now = Date.now,
}) => {
  const authority = assertObservationExpectation({
    contract,
    migrationChecksums,
  });
  if (
    !client ||
    typeof client.query !== "function" ||
    !isAuthorityString(expectedObserverRole, 63) ||
    !authority.allowedObserverRoles.includes(expectedObserverRole) ||
    !isRecord(providerPolicy) ||
    !Array.isArray(providerPolicy.cspReportEnvironmentNames) ||
    providerPolicy.cspReportEnvironmentNames.length === 0 ||
    providerPolicy.cspReportEnvironmentNames.some(
      (name) => typeof name !== "string" || name.length === 0,
    ) ||
    !isRecord(providerObservation) ||
    !Array.isArray(providerObservation.presentEnvironmentNames) ||
    providerObservation.presentEnvironmentNames.some(
      (name) => typeof name !== "string" || name.length === 0,
    )
  ) {
    throw new Error("Remote DB collector input is invalid");
  }
  const nowMilliseconds = clockMilliseconds(now);

  const requiredTables = sortedStrings(contract.remote.requiredTables);
  const requiredFunctions = sortedStrings(contract.remote.requiredFunctions);
  if (
    !hasExactStringSet(requiredTables, [METRICS_TABLE, CSP_TABLE]) ||
    !hasExactStringSet(requiredFunctions, Object.keys(FUNCTION_ARGUMENTS))
  ) {
    throw new Error("Remote DB v1 object authority is invalid");
  }

  let transactionStarted = false;
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    transactionStarted = true;

    const identity = requireSingleRow(
      await client.query(identityQuery(authority.serviceRole)),
      "observer identity",
    );
    const serverVersionNumber = Number(identity.server_version_num);
    if (
      identity.observer_role !== expectedObserverRole ||
      identity.session_role !== expectedObserverRole ||
      identity.read_only !== "on" ||
      !Number.isSafeInteger(serverVersionNumber) ||
      Math.trunc(serverVersionNumber / 10_000) !== authority.postgresMajor ||
      identity.rolsuper !== false ||
      identity.rolcreaterole !== false ||
      identity.rolcreatedb !== false ||
      identity.rolreplication !== false ||
      identity.rolbypassrls !== false ||
      identity.rolcanlogin !== true ||
      identity.rolinherit !== false ||
      identity.database_connect !== true ||
      identity.database_connect_grantable !== false ||
      identity.database_create !== false ||
      identity.database_create_grantable !== false ||
      identity.database_temporary !== true ||
      identity.database_temporary_grantable !== false ||
      identity.service_role_member !== false
    ) {
      throw new Error("Remote DB observer role authority is invalid");
    }

    // A PostgreSQL transaction is pinned to one client. Concurrent query calls
    // on that client are deprecated by node-postgres and do not execute in
    // parallel, so keep this authorization snapshot explicitly ordered.
    const membershipResult = await client.query(observerMembershipsQuery);
    const ownershipResult = await client.query(observerOwnershipQuery);
    const relationResult = await client.query(observerRelationPrivilegesQuery);
    const executeResult = await client.query(
      observerExecutablePublicFunctionsQuery,
    );
    const managedFunctionDirectResult = await client.query(
      observerManagedFunctionDirectPrivilegesQuery,
    );
    const managedObjectDirectResult = await client.query(
      observerManagedObjectDirectPrivilegesQuery,
    );
    const sequenceResult = await client.query(observerSequencePrivilegesQuery);
    const schemaResult = await client.query(observerSchemaPrivilegesQuery);
    const databaseCreateResult = await client.query(
      observerDatabaseCreatePrivilegesQuery,
    );
    const membershipRows = requireRows(membershipResult, "observer membership");
    if (
      membershipRows.some(
        (row) =>
          !hasExactKeys(row, ["role"]) || !isAuthorityString(row.role, 63),
      )
    ) {
      throw new Error("Remote DB observer membership result is invalid");
    }
    const memberships = sortedStrings(membershipRows.map(({ role }) => role));
    if (!hasExactStringSet(memberships, [])) {
      throw new Error("Remote DB observer memberships are not empty");
    }
    const ownership = requireSingleRow(ownershipResult, "observer ownership");
    const ownedObjectCount = Number(ownership.owned_object_count);
    if (
      !hasExactKeys(ownership, ["owned_object_count"]) ||
      !Number.isSafeInteger(ownedObjectCount) ||
      ownedObjectCount !== 0
    ) {
      throw new Error("Remote DB observer ownership is not empty");
    }
    const relationRowsWithAuthority = requireRows(
      relationResult,
      "observer relation privilege",
    );
    if (
      relationRowsWithAuthority.some(
        (row) =>
          !hasExactKeys(row, [
            "object_name",
            "observer_column_insert",
            "observer_column_insert_grantable",
            "observer_column_references",
            "observer_column_references_grantable",
            "observer_column_select",
            "observer_column_select_grantable",
            "observer_column_update",
            "observer_column_update_grantable",
            "observer_delete",
            "observer_delete_grantable",
            "observer_insert",
            "observer_insert_grantable",
            "observer_maintain",
            "observer_maintain_grantable",
            "observer_references",
            "observer_references_grantable",
            "observer_select",
            "observer_select_grantable",
            "observer_trigger",
            "observer_trigger_grantable",
            "observer_truncate",
            "observer_truncate_grantable",
            "observer_update",
            "observer_update_grantable",
          ]) || !isAuthorityString(row.object_name, 255),
      )
    ) {
      throw new Error(
        "Remote DB observer relation privilege result is invalid",
      );
    }
    const relationPrivileges = relationRowsWithAuthority
      .map((row) => ({
        columnInsert: row.observer_column_insert,
        columnInsertGrantable: row.observer_column_insert_grantable,
        columnReferences: row.observer_column_references,
        columnReferencesGrantable: row.observer_column_references_grantable,
        columnSelect: row.observer_column_select,
        columnSelectGrantable: row.observer_column_select_grantable,
        columnUpdate: row.observer_column_update,
        columnUpdateGrantable: row.observer_column_update_grantable,
        delete: row.observer_delete,
        deleteGrantable: row.observer_delete_grantable,
        insert: row.observer_insert,
        insertGrantable: row.observer_insert_grantable,
        maintain: row.observer_maintain,
        maintainGrantable: row.observer_maintain_grantable,
        objectName: row.object_name,
        references: row.observer_references,
        referencesGrantable: row.observer_references_grantable,
        select: row.observer_select,
        selectGrantable: row.observer_select_grantable,
        trigger: row.observer_trigger,
        triggerGrantable: row.observer_trigger_grantable,
        truncate: row.observer_truncate,
        truncateGrantable: row.observer_truncate_grantable,
        update: row.observer_update,
        updateGrantable: row.observer_update_grantable,
      }))
      .sort((left, right) => UTF8_COMPARE(left.objectName, right.objectName));
    const executableFunctionRows = requireRows(
      executeResult,
      "observer executable function",
    );
    if (
      executableFunctionRows.some(
        (row) =>
          !hasExactKeys(row, [
            "definition_sha256",
            "function_language",
            "function_owner",
            "function_result",
            "function_signature",
            "observer_execute",
            "observer_execute_grantable",
          ]) ||
          !/^[0-9a-f]{64}$/u.test(row.definition_sha256) ||
          !isAuthorityString(row.function_language, 63) ||
          !isAuthorityString(row.function_owner, 63) ||
          !isAuthorityString(row.function_result, 2_048) ||
          !isAuthorityString(row.function_signature, 512),
      )
    ) {
      throw new Error(
        "Remote DB observer executable function result is invalid",
      );
    }
    const boundedFunctions = executableFunctionRows
      .map((row) => ({
        definitionSha256: row.definition_sha256,
        execute: row.observer_execute,
        executeGrantable: row.observer_execute_grantable,
        language: row.function_language,
        owner: row.function_owner,
        result: row.function_result,
        signature: row.function_signature,
      }))
      .sort((left, right) => UTF8_COMPARE(left.signature, right.signature));
    const managedFunctionDirectRows = requireRows(
      managedFunctionDirectResult,
      "observer managed function direct privilege",
    );
    if (
      managedFunctionDirectRows.some(
        (row) =>
          !hasExactKeys(row, [
            "function_signature",
            "observer_execute_grantable",
          ]) ||
          !isAuthorityString(row.function_signature, 512) ||
          typeof row.observer_execute_grantable !== "boolean",
      )
    ) {
      throw new Error(
        "Remote DB observer managed function direct privilege result is invalid",
      );
    }
    const managedFunctionDirectAuthorities = sortedStrings(
      managedFunctionDirectRows.map(
        ({ function_signature: signature }) => signature,
      ),
    );
    const managedObjectDirectRows = requireRows(
      managedObjectDirectResult,
      "observer managed object direct privilege",
    );
    if (
      managedObjectDirectRows.some(
        (row) =>
          !hasExactKeys(row, [
            "grantable",
            "object_name",
            "object_type",
            "privilege",
          ]) ||
          !isAuthorityString(row.object_name, 255) ||
          !isAuthorityString(row.object_type, 16) ||
          !isAuthorityString(row.privilege, 32) ||
          typeof row.grantable !== "boolean",
      )
    ) {
      throw new Error(
        "Remote DB observer managed object direct privilege result is invalid",
      );
    }
    const managedObjectDirectAuthorities = sortedStrings(
      managedObjectDirectRows.map(
        (row) =>
          `${row.object_type}:${row.object_name}:${row.privilege}:${row.grantable}`,
      ),
    );
    const sequenceRowsWithAuthority = requireRows(
      sequenceResult,
      "observer sequence privilege",
    );
    if (
      sequenceRowsWithAuthority.some(
        (row) =>
          !hasExactKeys(row, [
            "object_name",
            "observer_select",
            "observer_select_grantable",
            "observer_update",
            "observer_update_grantable",
            "observer_usage",
            "observer_usage_grantable",
          ]) || !isAuthorityString(row.object_name, 255),
      )
    ) {
      throw new Error(
        "Remote DB observer sequence privilege result is invalid",
      );
    }
    const sequencePrivileges = sequenceRowsWithAuthority
      .map((row) => ({
        objectName: row.object_name,
        select: row.observer_select,
        selectGrantable: row.observer_select_grantable,
        update: row.observer_update,
        updateGrantable: row.observer_update_grantable,
        usage: row.observer_usage,
        usageGrantable: row.observer_usage_grantable,
      }))
      .sort((left, right) => UTF8_COMPARE(left.objectName, right.objectName));
    const schemaRowsWithAuthority = requireRows(
      schemaResult,
      "observer schema privilege",
    );
    if (
      schemaRowsWithAuthority.some(
        (row) =>
          !hasExactKeys(row, [
            "object_name",
            "observer_create",
            "observer_create_grantable",
            "observer_usage",
            "observer_usage_grantable",
          ]) || !isAuthorityString(row.object_name, 63),
      )
    ) {
      throw new Error("Remote DB observer schema privilege result is invalid");
    }
    const schemaPrivileges = schemaRowsWithAuthority
      .map((row) => ({
        create: row.observer_create,
        createGrantable: row.observer_create_grantable,
        objectName: row.object_name,
        usage: row.observer_usage,
        usageGrantable: row.observer_usage_grantable,
      }))
      .sort((left, right) => UTF8_COMPARE(left.objectName, right.objectName));
    const databaseCreateRows = requireRows(
      databaseCreateResult,
      "observer database CREATE privilege",
    );
    if (
      databaseCreateRows.some(
        (row) =>
          !hasExactKeys(row, ["database_name"]) ||
          !isAuthorityString(row.database_name, 63),
      )
    ) {
      throw new Error(
        "Remote DB observer database CREATE privilege result is invalid",
      );
    }
    const databaseCreateAuthorities = sortedStrings(
      databaseCreateRows.map(({ database_name: name }) => name),
    );
    const observerAuthorization = {
      boundedFunctions,
      currentDatabase: {
        connect: identity.database_connect,
        connectGrantable: identity.database_connect_grantable,
        create: identity.database_create,
        createGrantable: identity.database_create_grantable,
        temporary: identity.database_temporary,
        temporaryGrantable: identity.database_temporary_grantable,
      },
      databaseCreateAuthorities,
      managedFunctionDirectAuthorities,
      managedObjectDirectAuthorities,
      memberships,
      ownedObjectCount,
      relationPrivileges,
      schemaPrivileges,
      sequencePrivileges,
    };
    if (!hasExactObserverAuthorization(observerAuthorization)) {
      throw new Error("Remote DB observer exact authorization differs");
    }

    const expectedMigrationHistory = contract.remote.migrationHistory;
    const migrationRows = requireRows(
      await client.query(migrationsQuery()),
      "migration history",
    );
    if (
      migrationRows.some(
        (row) =>
          !hasExactKeys(row, [
            "migration_name",
            "statement_count",
            "statements_sha256",
            "version",
          ]) ||
          !/^\d{14}$/u.test(row.version) ||
          !/^[a-z0-9_]{1,128}$/u.test(row.migration_name) ||
          !Number.isSafeInteger(Number(row.statement_count)) ||
          Number(row.statement_count) < 1 ||
          !/^[0-9a-f]{64}$/u.test(row.statements_sha256),
      )
    ) {
      throw new Error("Remote DB migration history result is invalid");
    }
    const observedMigrationHistory = migrationRows
      .map((row) => ({
        migrationName: row.migration_name,
        statementCount: Number(row.statement_count),
        statementsSha256: row.statements_sha256,
        version: row.version,
      }))
      .sort((left, right) => UTF8_COMPARE(left.version, right.version));
    const migrationsApplied = hasExactRecordSet(
      observedMigrationHistory,
      expectedMigrationHistory,
      MIGRATION_HISTORY_AUTHORITY_KEYS,
    );
    if (!migrationsApplied) {
      throw new Error("Remote DB exact migration history differs");
    }

    const requiredRelationResult = await client.query(
      relationsQuery(requiredTables),
    );
    const requiredColumnResult = await client.query(
      columnsQuery(requiredTables),
    );
    const requiredConstraintResult = await client.query(
      constraintsQuery(requiredTables),
    );
    const requiredPolicyResult = await client.query(
      policiesQuery(requiredTables),
    );
    const requiredTriggerResult = await client.query(
      triggersQuery(requiredTables),
    );
    const requiredFunctionResult = await client.query(
      functionsQuery(requiredFunctions),
    );
    const relationRows = requireExactRows(
      requiredRelationResult,
      requiredTables.length,
      "relation",
    );
    if (
      relationRows.some(
        (row) =>
          !hasExactKeys(row, [
            "force_row_security",
            "persistence",
            "qualified_name",
            "relation_owner",
            "relkind",
            "replica_identity",
            "row_security",
          ]),
      )
    ) {
      throw new Error("Remote DB required relation result is invalid");
    }
    const relationAuthorities = relationRows
      .map((row) => ({
        forceRowSecurity: row.force_row_security,
        objectName: row.qualified_name,
        owner: row.relation_owner,
        persistence: row.persistence,
        relationKind: row.relkind,
        replicaIdentity: row.replica_identity,
        rowSecurity: row.row_security,
      }))
      .sort((left, right) => UTF8_COMPARE(left.objectName, right.objectName));
    if (
      !hasExactRecordSet(
        relationAuthorities,
        REQUIRED_RELATION_AUTHORITIES,
        REQUIRED_RELATION_AUTHORITY_KEYS,
      )
    ) {
      throw new Error("Remote DB required relation contract differs");
    }
    const columnRows = requireRows(requiredColumnResult, "column authority");
    if (
      columnRows.some(
        (row) =>
          !hasExactKeys(row, [
            "data_type",
            "default_expression",
            "generated",
            "identity",
            "not_null",
            "object_name",
            "ordinal",
          ]) || !Number.isSafeInteger(Number(row.ordinal)),
      )
    ) {
      throw new Error("Remote DB required column result is invalid");
    }
    const columnAuthorities = columnRows
      .map((row) => ({
        dataType: row.data_type,
        defaultExpression: row.default_expression,
        generated: row.generated,
        identity: row.identity,
        notNull: row.not_null,
        objectName: row.object_name,
        ordinal: Number(row.ordinal),
      }))
      .sort(
        (left, right) =>
          UTF8_COMPARE(
            left.objectName.slice(0, left.objectName.lastIndexOf(".")),
            right.objectName.slice(0, right.objectName.lastIndexOf(".")),
          ) || left.ordinal - right.ordinal,
      );
    if (
      !hasExactRecordSet(
        columnAuthorities,
        REQUIRED_COLUMN_AUTHORITIES,
        REQUIRED_COLUMN_AUTHORITY_KEYS,
      )
    ) {
      throw new Error("Remote DB required column contract differs");
    }
    const constraintRows = requireRows(
      requiredConstraintResult,
      "constraint authority",
    );
    if (
      constraintRows.some(
        (row) =>
          !hasExactKeys(row, [
            "constraint_name",
            "constraint_type",
            "definition_sha256",
            "object_name",
            "validated",
          ]) || !/^[0-9a-f]{64}$/u.test(row.definition_sha256),
      )
    ) {
      throw new Error("Remote DB required constraint result is invalid");
    }
    const constraintAuthorities = constraintRows
      .map((row) => ({
        constraintName: row.constraint_name,
        definitionSha256: row.definition_sha256,
        objectName: row.object_name,
        type: row.constraint_type,
        validated: row.validated,
      }))
      .sort(
        (left, right) =>
          UTF8_COMPARE(left.objectName, right.objectName) ||
          UTF8_COMPARE(left.constraintName, right.constraintName),
      );
    if (
      !hasExactRecordSet(
        constraintAuthorities,
        REQUIRED_CONSTRAINT_AUTHORITIES,
        REQUIRED_CONSTRAINT_AUTHORITY_KEYS,
      )
    ) {
      throw new Error("Remote DB required constraint contract differs");
    }
    if (
      requireRows(requiredPolicyResult, "policy authority").length !== 0 ||
      requireRows(requiredTriggerResult, "trigger authority").length !== 0
    ) {
      throw new Error("Remote DB required policy or trigger set differs");
    }

    const functionRows = requireExactRows(
      requiredFunctionResult,
      requiredFunctions.length,
      "function",
    );
    if (
      functionRows.some(
        (row) =>
          !hasExactKeys(row, [
            "configuration",
            "definition_sha256",
            "function_language",
            "function_owner",
            "function_result",
            "identity_arguments",
            "leakproof",
            "parallel",
            "qualified_name",
            "security_definer",
            "strict",
            "volatility",
          ]) ||
          !/^[0-9a-f]{64}$/u.test(row.definition_sha256) ||
          row.identity_arguments !== FUNCTION_ARGUMENTS[row.qualified_name] ||
          row.security_definer !== true ||
          !hasSearchPathAuthority(row.configuration),
      )
    ) {
      throw new Error("Remote DB bounded function contract differs");
    }
    const requiredFunctionAuthorities = functionRows
      .map((row) => ({
        definitionSha256: row.definition_sha256,
        identityArguments: row.identity_arguments,
        language: row.function_language,
        leakproof: row.leakproof,
        owner: row.function_owner,
        parallel: row.parallel,
        qualifiedName: row.qualified_name,
        result: row.function_result,
        securityDefiner: row.security_definer,
        strict: row.strict,
        volatility: row.volatility,
      }))
      .sort(
        (left, right) =>
          UTF8_COMPARE(left.qualifiedName, right.qualifiedName) ||
          UTF8_COMPARE(left.identityArguments, right.identityArguments),
      );
    if (
      !hasExactRecordSet(
        requiredFunctionAuthorities,
        REQUIRED_FUNCTION_AUTHORITIES,
        REQUIRED_FUNCTION_AUTHORITY_KEYS,
      )
    ) {
      throw new Error("Remote DB required function definition differs");
    }

    const tablePrivilegeResult = await client.query(
      tablePrivilegesQuery(requiredTables, authority.serviceRole),
    );
    const serviceSequenceResult = await client.query(
      serviceRoleSequencePrivilegesQuery(authority.serviceRole),
    );
    const cspDormantAuthorityResult = await client.query(
      cspDormantAuthorityQuery,
    );
    const tablePrivilegeRows = requireExactRows(
      tablePrivilegeResult,
      requiredTables.length,
      "table privilege",
    );
    const privilegesByTable = new Map(
      tablePrivilegeRows.map((row) => [row.object_name, row]),
    );
    if (
      privilegesByTable.size !== requiredTables.length ||
      requiredTables.some((table) => !privilegesByTable.has(table)) ||
      tablePrivilegeRows.some((row) => !isExactServiceRoleTablePrivilege(row))
    ) {
      throw new Error("Remote DB service role table authority differs");
    }
    const serviceSequenceRows = requireExactRows(
      serviceSequenceResult,
      2,
      "service role sequence privilege",
    );
    if (
      !hasExactStringSet(
        serviceSequenceRows.map(({ object_name: objectName }) => objectName),
        [CSP_SEQUENCE, METRICS_SEQUENCE],
      ) ||
      serviceSequenceRows.some(
        (row) => !isExactServiceRoleSequencePrivilege(row),
      )
    ) {
      throw new Error("Remote DB service role sequence authority differs");
    }
    const cspDormantAuthorityRows = requireRows(
      cspDormantAuthorityResult,
      "CSP dormant authority",
    );
    if (cspDormantAuthorityRows.length !== 0) {
      throw new Error("Remote DB CSP dormant principal authority differs");
    }
    const metricsPrivileges = privilegesByTable.get(METRICS_TABLE);
    const cspPrivileges = privilegesByTable.get(CSP_TABLE);
    const serviceRoleRawSelect =
      metricsPrivileges.service_select ||
      metricsPrivileges.service_column_select;
    const serviceRoleRawInsert =
      metricsPrivileges.service_insert ||
      metricsPrivileges.service_column_insert;
    const cspServiceRoleRawSelect =
      cspPrivileges.service_select || cspPrivileges.service_column_select;
    const cspServiceRoleRawInsert =
      cspPrivileges.service_insert || cspPrivileges.service_column_insert;

    const functionSignatures = sortedStrings(
      functionRows.map(functionSignature),
    );
    const functionPrivilegeRows = requireExactRows(
      await client.query(
        functionPrivilegesQuery(functionSignatures, authority.serviceRole),
      ),
      functionSignatures.length,
      "function privilege",
    );
    if (
      functionPrivilegeRows.some(
        (row) =>
          !hasExactKeys(row, [
            "function_signature",
            "observer_execute",
            "observer_execute_grantable",
            "service_execute",
            "service_execute_grantable",
          ]) ||
          row.service_execute !== false ||
          row.service_execute_grantable !== false ||
          row.observer_execute_grantable !== false,
      )
    ) {
      throw new Error("Remote DB routine privilege authority differs");
    }
    const functionPrivilegesBySignature = new Map(
      functionPrivilegeRows.map((row) => [row.function_signature, row]),
    );
    const operatorFunctionAuthority = functionRows.every((row) => {
      const privileges = functionPrivilegesBySignature.get(
        functionSignature(row),
      );
      const isReadFunction = OBSERVER_EXECUTABLE_PUBLIC_FUNCTIONS.includes(
        functionSignature(row),
      );
      return (
        privileges &&
        privileges.service_execute === false &&
        privileges.service_execute_grantable === false &&
        privileges.observer_execute === isReadFunction &&
        privileges.observer_execute_grantable === false
      );
    });
    const operatorBoundedFunctionOnly =
      operatorFunctionAuthority &&
      hasExactObserverAuthorization(observerAuthorization);

    const cspObjectsPresent = true;

    const presentEnvironmentNames = new Set(
      providerObservation.presentEnvironmentNames,
    );
    const cspApplicationCredentialReachable =
      providerPolicy.cspReportEnvironmentNames.some((name) =>
        presentEnvironmentNames.has(name),
      );

    const evidence = {
      schemaVersion: 1,
      contractFingerprint: sha256Json(contract),
      migrationChecksums: { ...migrationChecksums },
      migrationsApplied,
      serviceRoleRawSelect,
      serviceRoleRawInsert,
      cspServiceRoleRawSelect,
      cspServiceRoleRawInsert,
      cspObjectsPresent,
      operatorBoundedFunctionOnly,
      cspApplicationCredentialReachable,
      requiredTables,
      requiredFunctions,
      observedAt: new Date(nowMilliseconds).toISOString(),
    };
    assertRemoteDbObservation(evidence, {
      contract,
      migrationChecksums,
      now: nowMilliseconds,
    });
    await client.query("commit");
    transactionStarted = false;
    return evidence;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the authoritative collection failure.
      }
    }
    throw error;
  }
};
