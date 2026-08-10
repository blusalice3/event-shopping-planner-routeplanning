#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [packageJson, releaseStateStorePolicy, dbCompatibilityContract] =
  await Promise.all([
    readJsonStrict(path.join(root, "package.json")),
    readJsonStrict(path.join(root, "config", "release-state-store.json")),
    readJsonStrict(path.join(root, "config", "db-compatibility-contract.json")),
  ]);
const cspContractMigration = await readFile(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260808000000_csp_report_contract.sql",
  ),
  "utf8",
);
const cspUpgradeMatch = cspContractMigration.match(
  /-- CSP_REPORT_CONTRACT_UPGRADE_BEGIN([\s\S]*?)-- CSP_REPORT_CONTRACT_UPGRADE_END/u,
);
if (!cspUpgradeMatch) {
  throw new Error("CSP report contract upgrade block is missing");
}
const cspReportContractUpgradeSql = cspUpgradeMatch[1];
const expectedReleaseStateMigrationPaths = [
  "ops/release-state/migrations/0001_release_state_store.sql",
  "ops/release-state/migrations/0002_acceptance_evidence_chains.sql",
  "ops/release-state/migrations/0003_phase_exit_attestations.sql",
];
if (
  !Array.isArray(releaseStateStorePolicy.migrations) ||
  releaseStateStorePolicy.migrations.length !==
    expectedReleaseStateMigrationPaths.length ||
  releaseStateStorePolicy.migrations.some(
    (migration, index) =>
      migration?.path !== expectedReleaseStateMigrationPaths[index] ||
      typeof migration.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(migration.sha256),
  )
) {
  throw new Error("Disposable DB Release State migration order differs");
}
const releaseStateStoreMigrations = await Promise.all(
  releaseStateStorePolicy.migrations.map(async (migration) => {
    const bytes = await readFile(path.join(root, ...migration.path.split("/")));
    if (sha256Bytes(bytes) !== migration.sha256) {
      throw new Error(
        `Disposable DB Release State migration hash differs: ${migration.path}`,
      );
    }
    return bytes.toString("utf8");
  }),
);
if (process.versions.node !== packageJson.engines.node) {
  throw new Error(
    `Disposable DB gate requires Node ${packageJson.engines.node}; received ${process.versions.node}`,
  );
}
if (process.platform !== "linux") {
  throw new Error(
    "Disposable DB gate is CI-only and requires a Linux Docker host",
  );
}

const supabaseEntry = path.join(
  root,
  "node_modules",
  "supabase",
  "dist",
  "supabase.js",
);
const excludedServices = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
].join(",");

const runSupabase = (arguments_, { allowFailure = false } = {}) => {
  const result = spawnSync(
    process.execPath,
    [supabaseEntry, ...arguments_, "--workdir", root],
    {
      cwd: root,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      stdio: allowFailure ? "pipe" : "inherit",
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Supabase ${arguments_.join(" ")} failed`);
  }
  return result;
};

const scalar = async (client, text) => {
  const result = await client.query(text);
  if (result.rows.length !== 1 || Object.keys(result.rows[0]).length !== 1) {
    throw new Error(`Disposable DB scalar query is ambiguous: ${text}`);
  }
  return Object.values(result.rows[0])[0];
};

/**
 * @param {unknown} error
 * @param {string} expectedCode
 * @param {RegExp | null} [messagePattern]
 */
const isPostgresError = (error, expectedCode, messagePattern = null) => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== expectedCode
  ) {
    return false;
  }
  if (messagePattern === null) return true;
  return (
    "message" in error &&
    typeof error.message === "string" &&
    messagePattern.test(error.message)
  );
};

const FOUNDATION_OBSERVER_ROLE = "foundation_db_observer";
const FOUNDATION_BACKUP_SOURCE_ROLE = "foundation_backup_source_reader";
const FOUNDATION_BACKUP_RESTORE_ROLE = "foundation_backup_restore_reader";
const FOUNDATION_ROLE_PASSWORDS = Object.freeze({
  [FOUNDATION_OBSERVER_ROLE]: "disposable-foundation-observer",
  [FOUNDATION_BACKUP_SOURCE_ROLE]: "disposable-backup-source",
  [FOUNDATION_BACKUP_RESTORE_ROLE]: "disposable-backup-restore",
});
const UTF8_COMPARE = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const METRICS_TABLE = "public.persistence_release_a_metric_events";
const CSP_TABLE = "public.csp_violation_reports";
const METRICS_SEQUENCE = "public.persistence_release_a_metric_events_id_seq";
const CSP_SEQUENCE = "public.csp_violation_reports_id_seq";
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
const REQUIRED_MIGRATION_VERSIONS = Object.freeze([
  "20260803000000",
  "20260805000000",
  "20260808000000",
  "20260809000000",
  "20260810000000",
  "20260810010000",
]);
const EXPECTED_OBSERVER_FUNCTIONS = Object.freeze([
  Object.freeze({
    definition_sha256:
      "d840ff64e316a5e0726e3168e7c44e4c8a1bde7229521a01f3fb9298d9150d9a",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
    function_signature:
      "public.read_csp_deployment_violation_aggregates(timestamp with time zone, timestamp with time zone, text, text, integer)",
    observer_execute: true,
    observer_execute_grantable: false,
  }),
  Object.freeze({
    definition_sha256:
      "0bd18e5377c32f27fa8a72c7c7b2d4dbc497cd076c2c7c28584bfc02497fb712",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(source_sha text, effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
    function_signature:
      "public.read_csp_violation_aggregates(timestamp with time zone, timestamp with time zone, integer)",
    observer_execute: true,
    observer_execute_grantable: false,
  }),
  Object.freeze({
    definition_sha256:
      "a26aae5d280b49cf403721cbcd7eff85c6b78e258301dcd69df8925d40e6cb63",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(received_at timestamp with time zone, build_id text, browser_family text, app_mode text, online boolean, event_name text, outcome text, duration_bucket text, cleanup_mode text, cleanup_reason text)",
    function_signature:
      "public.read_persistence_release_a_metrics(timestamp with time zone, timestamp with time zone, integer)",
    observer_execute: true,
    observer_execute_grantable: false,
  }),
]);
const REQUIRED_FUNCTION_AUTHORITIES = Object.freeze([
  Object.freeze({
    definition_sha256:
      "d840ff64e316a5e0726e3168e7c44e4c8a1bde7229521a01f3fb9298d9150d9a",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
    identity_arguments:
      "timestamp with time zone, timestamp with time zone, text, text, integer",
    leakproof: false,
    parallel: "u",
    qualified_name: "public.read_csp_deployment_violation_aggregates",
    security_definer: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definition_sha256:
      "0bd18e5377c32f27fa8a72c7c7b2d4dbc497cd076c2c7c28584bfc02497fb712",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(source_sha text, effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
    identity_arguments:
      "timestamp with time zone, timestamp with time zone, integer",
    leakproof: false,
    parallel: "u",
    qualified_name: "public.read_csp_violation_aggregates",
    security_definer: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definition_sha256:
      "a26aae5d280b49cf403721cbcd7eff85c6b78e258301dcd69df8925d40e6cb63",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(received_at timestamp with time zone, build_id text, browser_family text, app_mode text, online boolean, event_name text, outcome text, duration_bucket text, cleanup_mode text, cleanup_reason text)",
    identity_arguments:
      "timestamp with time zone, timestamp with time zone, integer",
    leakproof: false,
    parallel: "u",
    qualified_name: "public.read_persistence_release_a_metrics",
    security_definer: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definition_sha256:
      "7bfbffd5e152d0fe6fce71e5b3a6390a84a0578143aa3e6f0d68060ea603d6a9",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(cutoff timestamp with time zone, affected_rows bigint, batch_count integer, dry_run boolean)",
    identity_arguments: "boolean, integer, integer",
    leakproof: false,
    parallel: "u",
    qualified_name: "public.retain_csp_violation_reports",
    security_definer: true,
    strict: false,
    volatility: "v",
  }),
  Object.freeze({
    definition_sha256:
      "a2518f229ae4ac700702713bab16790c966f78a61b4d4b74b2722ecea8bf9cc2",
    function_language: "plpgsql",
    function_owner: "postgres",
    function_result:
      "TABLE(cutoff timestamp with time zone, affected_rows bigint, batch_count integer, dry_run boolean)",
    identity_arguments: "boolean, integer, integer",
    leakproof: false,
    parallel: "u",
    qualified_name: "public.retain_persistence_release_a_metrics",
    security_definer: true,
    strict: false,
    volatility: "v",
  }),
]);
const REQUIRED_RELATION_AUTHORITIES = Object.freeze(
  [CSP_TABLE, METRICS_TABLE].sort(UTF8_COMPARE).map((object_name) =>
    Object.freeze({
      force_row_security: false,
      object_name,
      persistence: "p",
      relation_kind: "r",
      relation_owner: "postgres",
      replica_identity: "d",
      row_security: true,
    }),
  ),
);
const columnAuthority = (
  object_name,
  ordinal,
  data_type,
  not_null,
  default_expression = null,
  identity = "",
) =>
  Object.freeze({
    data_type,
    default_expression,
    generated: "",
    identity,
    not_null,
    object_name,
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
const constraintAuthority = (
  object_name,
  constraint_name,
  constraint_type,
  definition_sha256,
) =>
  Object.freeze({
    constraint_name,
    constraint_type,
    definition_sha256,
    object_name,
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

const assertDenied42501 = async (client, statement) => {
  await client.query("begin transaction read write");
  try {
    await assert.rejects(client.query(statement), (error) =>
      isPostgresError(error, "42501"),
    );
  } finally {
    await client.query("rollback");
  }
};

const connectFoundationRole = async ({ Client, role }) => {
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: role,
    password: FOUNDATION_ROLE_PASSWORDS[role],
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: `foundation-disposable-${role}`,
  });
  await client.connect();
  return client;
};

const connectManagedAdministrator = async ({ Client }) => {
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: "supabase_admin",
    password: "postgres",
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "foundation-disposable-managed-administrator",
  });
  await client.connect();
  return client;
};

const observerRelationAuthority = ({
  object_name,
  select = false,
  insert = false,
  update = false,
  delete: canDelete = false,
  truncate = false,
  references = false,
  trigger = false,
  maintain = false,
}) =>
  Object.freeze({
    object_name,
    observer_select: select,
    observer_insert: insert,
    observer_update: update,
    observer_delete: canDelete,
    observer_truncate: truncate,
    observer_references: references,
    observer_trigger: trigger,
    observer_maintain: maintain,
    observer_select_grantable: false,
    observer_insert_grantable: false,
    observer_update_grantable: false,
    observer_delete_grantable: false,
    observer_truncate_grantable: false,
    observer_references_grantable: false,
    observer_trigger_grantable: false,
    observer_maintain_grantable: false,
    observer_column_select: select,
    observer_column_insert: insert,
    observer_column_update: update,
    observer_column_references: references,
    observer_column_select_grantable: false,
    observer_column_insert_grantable: false,
    observer_column_update_grantable: false,
    observer_column_references_grantable: false,
  });
const EXPECTED_OBSERVER_RELATIONS = Object.freeze([
  observerRelationAuthority({ object_name: "cron.job", select: true }),
  observerRelationAuthority({
    object_name: "cron.job_run_details",
    delete: true,
    select: true,
  }),
  observerRelationAuthority({
    object_name: "extensions.pg_stat_statements",
    select: true,
  }),
  observerRelationAuthority({
    object_name: "extensions.pg_stat_statements_info",
    select: true,
  }),
  observerRelationAuthority({
    object_name: "net._http_response",
    delete: true,
    insert: true,
    maintain: true,
    references: true,
    select: true,
    trigger: true,
    truncate: true,
    update: true,
  }),
  observerRelationAuthority({
    object_name: "net.http_request_queue",
    delete: true,
    insert: true,
    maintain: true,
    references: true,
    select: true,
    trigger: true,
    truncate: true,
    update: true,
  }),
  observerRelationAuthority({
    object_name: "supabase_migrations.schema_migrations",
    select: true,
  }),
]);
const EXPECTED_OBSERVER_SEQUENCES = Object.freeze([
  Object.freeze({
    object_name: "net.http_request_queue_id_seq",
    observer_select: true,
    observer_select_grantable: false,
    observer_update: true,
    observer_update_grantable: false,
    observer_usage: true,
    observer_usage_grantable: false,
  }),
]);
const EXPECTED_OBSERVER_SCHEMAS = Object.freeze([
  Object.freeze({
    object_name: "net",
    observer_create: false,
    observer_create_grantable: false,
    observer_usage: true,
    observer_usage_grantable: false,
  }),
  Object.freeze({
    object_name: "public",
    observer_create: false,
    observer_create_grantable: false,
    observer_usage: true,
    observer_usage_grantable: false,
  }),
  Object.freeze({
    object_name: "supabase_migrations",
    observer_create: false,
    observer_create_grantable: false,
    observer_usage: true,
    observer_usage_grantable: false,
  }),
]);
const OBSERVER_RELATION_PRIVILEGE_FIELDS = Object.freeze([
  Object.freeze(["DELETE", "observer_delete"]),
  Object.freeze(["INSERT", "observer_insert"]),
  Object.freeze(["MAINTAIN", "observer_maintain"]),
  Object.freeze(["REFERENCES", "observer_references"]),
  Object.freeze(["SELECT", "observer_select"]),
  Object.freeze(["TRIGGER", "observer_trigger"]),
  Object.freeze(["TRUNCATE", "observer_truncate"]),
  Object.freeze(["UPDATE", "observer_update"]),
]);
const OBSERVER_COLUMN_PRIVILEGE_FIELDS = Object.freeze([
  Object.freeze(["INSERT", "observer_column_insert"]),
  Object.freeze(["REFERENCES", "observer_column_references"]),
  Object.freeze(["SELECT", "observer_column_select"]),
  Object.freeze(["UPDATE", "observer_column_update"]),
]);
const OBSERVER_SEQUENCE_PRIVILEGE_FIELDS = Object.freeze([
  Object.freeze(["SELECT", "observer_select"]),
  Object.freeze(["UPDATE", "observer_update"]),
  Object.freeze(["USAGE", "observer_usage"]),
]);
const isProviderManagedObject = (objectName) =>
  PROVIDER_MANAGED_SCHEMAS.includes(objectName.split(".", 1)[0]);
assert.deepEqual(
  dbCompatibilityContract.remote.observerManagedSchemas,
  PROVIDER_MANAGED_SCHEMAS,
);
assert.deepEqual(
  dbCompatibilityContract.remote.observerManagedSchemaUsage,
  EXPECTED_OBSERVER_SCHEMAS.filter(
    ({ object_name: objectName, observer_usage: observerUsage }) =>
      observerUsage && PROVIDER_MANAGED_SCHEMAS.includes(objectName),
  ).map(({ object_name: objectName }) => objectName),
);
assert.deepEqual(
  dbCompatibilityContract.remote.observerManagedRelationPrivilegeBaseline,
  EXPECTED_OBSERVER_RELATIONS.filter(({ object_name: objectName }) =>
    isProviderManagedObject(objectName),
  ).map((authority) => ({
    objectName: authority.object_name,
    columnPrivileges: OBSERVER_COLUMN_PRIVILEGE_FIELDS.filter(
      ([, field]) => authority[field],
    ).map(([privilege]) => privilege),
    privileges: OBSERVER_RELATION_PRIVILEGE_FIELDS.filter(
      ([, field]) => authority[field],
    ).map(([privilege]) => privilege),
  })),
);
assert.deepEqual(
  dbCompatibilityContract.remote.observerManagedSequencePrivilegeBaseline,
  EXPECTED_OBSERVER_SEQUENCES.filter(({ object_name: objectName }) =>
    isProviderManagedObject(objectName),
  ).map((authority) => ({
    objectName: authority.object_name,
    privileges: OBSERVER_SEQUENCE_PRIVILEGE_FIELDS.filter(
      ([, field]) => authority[field],
    ).map(([privilege]) => privilege),
  })),
);

const readObserverIdentity = async (client) => {
  const result = await client.query(
    `select
      current_user::text as role,
      session_user::text as session_role,
      current_setting('default_transaction_read_only') as read_only,
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
      ) as database_temporary_grantable`,
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
};

const readObserverRelationPrivileges = async (client) => {
  const result = await client.query(`
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
  `);
  return result.rows;
};

const readObserverExecutableFunctions = async (client) => {
  const result = await client.query({
    text: `select
      namespace.nspname || '.' || function_definition.proname || '(' ||
        pg_catalog.oidvectortypes(function_definition.proargtypes) || ')'
        as function_signature,
      pg_catalog.has_function_privilege(
        current_user, function_definition.oid, 'EXECUTE'
      ) as observer_execute,
      pg_catalog.has_function_privilege(
        current_user,
        function_definition.oid,
        'EXECUTE WITH GRANT OPTION'
      ) as observer_execute_grantable,
      pg_catalog.pg_get_userbyid(function_definition.proowner)
        as function_owner,
      language.lanname as function_language,
      pg_catalog.pg_get_function_result(function_definition.oid)
        as function_result,
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
          current_user,
          function_definition.oid,
          'EXECUTE WITH GRANT OPTION'
        )
      )
    order by function_signature`,
    values: [PROVIDER_MANAGED_SCHEMAS],
  });
  return result.rows;
};

const readObserverManagedDirectFunctions = async (client) => {
  const result = await client.query({
    text: `select
      namespace.nspname || '.' || function_definition.proname || '(' ||
        pg_catalog.oidvectortypes(function_definition.proargtypes) || ')'
        as function_signature,
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
    order by function_signature`,
    values: [PROVIDER_MANAGED_SCHEMAS],
  });
  return result.rows;
};

const readObserverSequencePrivileges = async (client) => {
  const result = await client.query(`
    with observed as (
      select
        namespace.nspname || '.' || sequence_definition.relname
          as object_name,
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
          current_user,
          sequence_definition.oid,
          'USAGE WITH GRANT OPTION'
        ) as observer_usage_grantable,
        pg_catalog.has_sequence_privilege(
          current_user,
          sequence_definition.oid,
          'SELECT WITH GRANT OPTION'
        ) as observer_select_grantable,
        pg_catalog.has_sequence_privilege(
          current_user,
          sequence_definition.oid,
          'UPDATE WITH GRANT OPTION'
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
  `);
  return result.rows;
};

const readObserverSchemaPrivileges = async (client) => {
  const result = await client.query(`with observed as (
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
      or observer_usage
      or observer_usage_grantable
    order by object_name`);
  return result.rows;
};

const readObserverDatabaseCreatePrivileges = async (client) => {
  const result = await client.query(`
    select database_definition.datname::text as database_name
    from pg_catalog.pg_database database_definition
    where pg_catalog.has_database_privilege(
        current_user, database_definition.oid, 'CREATE'
      )
      or pg_catalog.has_database_privilege(
        current_user,
        database_definition.oid,
        'CREATE WITH GRANT OPTION'
      )
    order by database_name
  `);
  return result.rows;
};

const assertExactObserverAuthorization = async (observer) => {
  const identity = await readObserverIdentity(observer);
  const relations = await readObserverRelationPrivileges(observer);
  const functions = await readObserverExecutableFunctions(observer);
  const managedDirectFunctions =
    await readObserverManagedDirectFunctions(observer);
  const sequences = await readObserverSequencePrivileges(observer);
  const schemas = await readObserverSchemaPrivileges(observer);
  const databaseCreatePrivileges =
    await readObserverDatabaseCreatePrivileges(observer);
  assert.deepEqual(identity, {
    role: FOUNDATION_OBSERVER_ROLE,
    session_role: FOUNDATION_OBSERVER_ROLE,
    read_only: "on",
    database_connect: true,
    database_connect_grantable: false,
    database_create: false,
    database_create_grantable: false,
    database_temporary: true,
    database_temporary_grantable: false,
  });
  assert.deepEqual(relations, EXPECTED_OBSERVER_RELATIONS);
  assert.deepEqual(functions, EXPECTED_OBSERVER_FUNCTIONS);
  assert.deepEqual(managedDirectFunctions, []);
  assert.deepEqual(sequences, EXPECTED_OBSERVER_SEQUENCES);
  assert.deepEqual(schemas, EXPECTED_OBSERVER_SCHEMAS);
  assert.deepEqual(databaseCreatePrivileges, []);
};

const readMigrationHistory = async (client) => {
  const result = await client.query(`
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
  `);
  return result.rows;
};

const expectedMigrationHistory = () => {
  const history = dbCompatibilityContract?.remote?.migrationHistory;
  if (!Array.isArray(history)) {
    throw new Error("Disposable DB migration history contract is missing");
  }
  assert.deepEqual(
    history.map(({ version }) => version),
    REQUIRED_MIGRATION_VERSIONS,
  );
  return history.map(
    ({ migrationName, statementCount, statementsSha256, version }) => ({
      migration_name: migrationName,
      statement_count: statementCount,
      statements_sha256: statementsSha256,
      version,
    }),
  );
};

const verifyExactMigrationHistory = async ({ administrator, observer }) => {
  const expected = expectedMigrationHistory();
  assert.deepEqual(await readMigrationHistory(observer), expected);

  const futureVersion = "99999999999999";
  try {
    await administrator.query({
      text: `
      insert into supabase_migrations.schema_migrations (
        version,
        name,
        statements
      ) values (
        $1,
        'foundation_disposable_future_probe',
        array['select 1']::text[]
      )
    `,
      values: [futureVersion],
    });
    assert.notDeepEqual(await readMigrationHistory(observer), expected);
  } finally {
    await administrator.query({
      text: `delete from supabase_migrations.schema_migrations
        where version = $1`,
      values: [futureVersion],
    });
  }
  assert.deepEqual(await readMigrationHistory(observer), expected);
};

const readApplicationObjectMetadata = async (client) => {
  const requiredTables = [CSP_TABLE, METRICS_TABLE];
  const requiredFunctions = REQUIRED_FUNCTION_AUTHORITIES.map(
    ({ qualified_name: qualifiedName }) => qualifiedName,
  );
  const relations = await client.query({
    text: `select
          namespace.nspname || '.' || relation.relname as object_name,
          relation.relkind::text as relation_kind,
          relation.relrowsecurity as row_security,
          relation.relforcerowsecurity as force_row_security,
          relation.relpersistence::text as persistence,
          relation.relreplident::text as replica_identity,
          pg_catalog.pg_get_userbyid(relation.relowner) as relation_owner
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname || '.' || relation.relname = any($1::text[])
        order by object_name`,
    values: [requiredTables],
  });
  const columns = await client.query({
    text: `select
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
        order by namespace.nspname, relation.relname, attribute.attnum`,
    values: [requiredTables],
  });
  const constraints = await client.query({
    text: `select
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
        order by object_name, constraint_name`,
    values: [requiredTables],
  });
  const policies = await client.query({
    text: `select policy.polname::text as policy_name
        from pg_catalog.pg_policy policy
        join pg_catalog.pg_class relation on relation.oid = policy.polrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname || '.' || relation.relname = any($1::text[])
        order by namespace.nspname, relation.relname, policy_name`,
    values: [requiredTables],
  });
  const triggers = await client.query({
    text: `select
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
        order by object_name, trigger_name`,
    values: [requiredTables],
  });
  const functions = await client.query({
    text: `select
          namespace.nspname || '.' || function_definition.proname
            as qualified_name,
          pg_catalog.oidvectortypes(function_definition.proargtypes)
            as identity_arguments,
          function_definition.prosecdef as security_definer,
          function_definition.proconfig as configuration,
          pg_catalog.pg_get_userbyid(function_definition.proowner)
            as function_owner,
          language.lanname as function_language,
          pg_catalog.pg_get_function_result(function_definition.oid)
            as function_result,
          function_definition.proleakproof as leakproof,
          function_definition.provolatile::text as volatility,
          function_definition.proparallel::text as parallel,
          function_definition.proisstrict as strict,
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.pg_get_functiondef(function_definition.oid),
                'UTF8'
              )
            ),
            'hex'
          ) as definition_sha256
        from pg_catalog.pg_proc function_definition
        join pg_catalog.pg_namespace namespace
          on namespace.oid = function_definition.pronamespace
        join pg_catalog.pg_language language
          on language.oid = function_definition.prolang
        where namespace.nspname || '.' || function_definition.proname =
          any($1::text[])
        order by qualified_name, identity_arguments`,
    values: [requiredFunctions],
  });
  const functionRows = functions.rows.map(({ configuration, ...authority }) => {
    assert.deepEqual(configuration, ["search_path=pg_catalog, public"]);
    return authority;
  });
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    functions: functionRows,
    policies: policies.rows,
    relations: relations.rows,
    triggers: triggers.rows,
  };
};

const verifyApplicationObjectMetadata = async (administrator) => {
  const metadata = await readApplicationObjectMetadata(administrator);
  assert.deepEqual(metadata.relations, REQUIRED_RELATION_AUTHORITIES);
  assert.deepEqual(metadata.columns, REQUIRED_COLUMN_AUTHORITIES);
  assert.deepEqual(metadata.constraints, REQUIRED_CONSTRAINT_AUTHORITIES);
  assert.deepEqual(metadata.functions, REQUIRED_FUNCTION_AUTHORITIES);
  assert.deepEqual(metadata.policies, []);
  assert.deepEqual(metadata.triggers, []);

  await administrator.query("begin");
  try {
    await administrator.query(`
      alter table ${CSP_TABLE}
        drop constraint csp_violation_reports_disposition_check;
      alter table ${CSP_TABLE}
        add constraint csp_violation_reports_disposition_check
        check (
          disposition in ('enforce', 'report', 'unknown')
          and pg_catalog.length(disposition) > 0
        );
    `);
    const mutated = await readApplicationObjectMetadata(administrator);
    assert.notDeepEqual(mutated.constraints, REQUIRED_CONSTRAINT_AUTHORITIES);
  } finally {
    await administrator.query("rollback");
  }

  await administrator.query("begin");
  try {
    await administrator.query(`
      create or replace function public.read_csp_violation_aggregates(
        requested_from timestamptz,
        requested_to timestamptz,
        requested_limit integer default 1000
      )
      returns table (
        source_sha text,
        effective_directive text,
        disposition text,
        blocked_target text,
        violation_count bigint,
        first_received_at timestamptz,
        last_received_at timestamptz
      )
      language plpgsql
      security definer
      set search_path = pg_catalog, public
      as $function$
      begin
        return;
      end;
      $function$;
    `);
    const mutated = await readApplicationObjectMetadata(administrator);
    assert.notDeepEqual(mutated.functions, REQUIRED_FUNCTION_AUTHORITIES);
  } finally {
    await administrator.query("rollback");
  }
  const restored = await readApplicationObjectMetadata(administrator);
  assert.deepEqual(restored.constraints, REQUIRED_CONSTRAINT_AUTHORITIES);
  assert.deepEqual(restored.functions, REQUIRED_FUNCTION_AUTHORITIES);
};

const readServiceRoleTablePrivileges = async (client) => {
  const result = await client.query({
    text: `select
      requested.object_name,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'SELECT'
      ) as service_select,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'SELECT'
      ) as service_column_select,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'INSERT'
      ) as service_insert,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'INSERT'
      ) as service_column_insert,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'UPDATE'
      ) as service_update,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'DELETE'
      ) as service_delete,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'TRUNCATE'
      ) as service_truncate,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'REFERENCES'
      ) as service_references,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'TRIGGER'
      ) as service_trigger,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'MAINTAIN'
      ) as service_maintain,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'SELECT WITH GRANT OPTION'
      ) as service_select_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'INSERT WITH GRANT OPTION'
      ) as service_insert_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'UPDATE WITH GRANT OPTION'
      ) as service_update_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'DELETE WITH GRANT OPTION'
      ) as service_delete_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'TRUNCATE WITH GRANT OPTION'
      ) as service_truncate_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'REFERENCES WITH GRANT OPTION'
      ) as service_references_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'TRIGGER WITH GRANT OPTION'
      ) as service_trigger_grantable,
      pg_catalog.has_table_privilege(
        'service_role', requested.object_name, 'MAINTAIN WITH GRANT OPTION'
      ) as service_maintain_grantable,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'SELECT WITH GRANT OPTION'
      ) as service_column_select_grantable,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'INSERT WITH GRANT OPTION'
      ) as service_column_insert_grantable,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'UPDATE'
      ) as service_column_update,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'UPDATE WITH GRANT OPTION'
      ) as service_column_update_grantable,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'REFERENCES'
      ) as service_column_references,
      pg_catalog.has_any_column_privilege(
        'service_role', requested.object_name, 'REFERENCES WITH GRANT OPTION'
      ) as service_column_references_grantable
    from unnest($1::text[]) as requested(object_name)
    order by requested.object_name`,
    values: [[CSP_TABLE, METRICS_TABLE]],
  });
  return result.rows;
};

const expectedServiceRoleTablePrivileges = (object_name) => ({
  object_name,
  service_select: false,
  service_column_select: false,
  service_insert: true,
  service_column_insert: true,
  service_update: false,
  service_delete: false,
  service_truncate: false,
  service_references: false,
  service_trigger: false,
  service_maintain: false,
  service_select_grantable: false,
  service_insert_grantable: false,
  service_update_grantable: false,
  service_delete_grantable: false,
  service_truncate_grantable: false,
  service_references_grantable: false,
  service_trigger_grantable: false,
  service_maintain_grantable: false,
  service_column_select_grantable: false,
  service_column_insert_grantable: false,
  service_column_update: false,
  service_column_update_grantable: false,
  service_column_references: false,
  service_column_references_grantable: false,
});
const EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES = Object.freeze([
  Object.freeze(expectedServiceRoleTablePrivileges(CSP_TABLE)),
  Object.freeze(expectedServiceRoleTablePrivileges(METRICS_TABLE)),
]);

const readServiceRoleSequencePrivileges = async (client) => {
  const result = await client.query({
    text: `select
      requested.object_name,
      pg_catalog.has_sequence_privilege(
        'service_role', requested.object_name, 'USAGE'
      ) as service_usage,
      pg_catalog.has_sequence_privilege(
        'service_role', requested.object_name, 'SELECT'
      ) as service_select,
      pg_catalog.has_sequence_privilege(
        'service_role', requested.object_name, 'UPDATE'
      ) as service_update,
      pg_catalog.has_sequence_privilege(
        'service_role',
        requested.object_name,
        'USAGE WITH GRANT OPTION'
      ) as service_usage_grantable,
      pg_catalog.has_sequence_privilege(
        'service_role',
        requested.object_name,
        'SELECT WITH GRANT OPTION'
      ) as service_select_grantable,
      pg_catalog.has_sequence_privilege(
        'service_role',
        requested.object_name,
        'UPDATE WITH GRANT OPTION'
      ) as service_update_grantable
    from unnest($1::text[]) as requested(object_name)
    order by requested.object_name`,
    values: [[CSP_SEQUENCE, METRICS_SEQUENCE]],
  });
  return result.rows;
};

const expectedServiceRoleSequencePrivileges = (object_name) => ({
  object_name,
  service_select: false,
  service_select_grantable: false,
  service_update: false,
  service_update_grantable: false,
  service_usage: true,
  service_usage_grantable: false,
});
const EXPECTED_SERVICE_ROLE_SEQUENCE_PRIVILEGES = Object.freeze([
  Object.freeze(expectedServiceRoleSequencePrivileges(CSP_SEQUENCE)),
  Object.freeze(expectedServiceRoleSequencePrivileges(METRICS_SEQUENCE)),
]);

const verifyServiceRoleAuthority = async (administrator) => {
  assert.deepEqual(
    await readServiceRoleTablePrivileges(administrator),
    EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES,
  );
  assert.deepEqual(
    await readServiceRoleSequencePrivileges(administrator),
    EXPECTED_SERVICE_ROLE_SEQUENCE_PRIVILEGES,
  );

  await administrator.query(
    `grant select (id) on table ${METRICS_TABLE} to service_role`,
  );
  try {
    const mutated = await readServiceRoleTablePrivileges(administrator);
    const metrics = mutated.find(
      ({ object_name: name }) => name === METRICS_TABLE,
    );
    assert.equal(metrics?.service_select, false);
    assert.equal(metrics?.service_column_select, true);
    assert.notDeepEqual(mutated, EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES);
  } finally {
    await administrator.query(
      `revoke select (id) on table ${METRICS_TABLE} from service_role`,
    );
  }
  assert.deepEqual(
    await readServiceRoleTablePrivileges(administrator),
    EXPECTED_SERVICE_ROLE_TABLE_PRIVILEGES,
  );
};

const CSP_ROUTINE_SIGNATURES = Object.freeze([
  "public.read_csp_deployment_violation_aggregates(timestamp with time zone, timestamp with time zone, text, text, integer)",
  "public.read_csp_violation_aggregates(timestamp with time zone, timestamp with time zone, integer)",
  "public.retain_csp_violation_reports(boolean, integer, integer)",
]);

const readCspDormantAuthority = async (client) => {
  const result = await client.query({
    text: `with requested_principals as (
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
            case
              when relation.relkind = 'S' then 'S'::"char"
              else 'r'::"char"
            end,
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
    order by principal, object_type, object_name, privilege, grantable`,
    values: [
      ["anon", "authenticated"],
      CSP_ROUTINE_SIGNATURES,
      CSP_TABLE,
      CSP_SEQUENCE,
    ],
  });
  return result.rows;
};

const readCspPolicies = async (client) => {
  const result = await client.query(`
    select policy.polname::text as policy_name
    from pg_catalog.pg_policy policy
    where policy.polrelid = pg_catalog.to_regclass('${CSP_TABLE}')
    order by policy_name
  `);
  return result.rows;
};

const verifyCspDormantAuthority = async (administrator) => {
  const assertClosed = async () => {
    assert.deepEqual(await readCspDormantAuthority(administrator), []);
    assert.deepEqual(await readCspPolicies(administrator), []);
  };
  const assertAuthorityDetected = async () => {
    assert.ok((await readCspDormantAuthority(administrator)).length > 0);
  };
  await assertClosed();

  await administrator.query(
    `grant select (blocked_target) on table ${CSP_TABLE} to anon`,
  );
  try {
    await assertAuthorityDetected();
  } finally {
    await administrator.query(
      `revoke select (blocked_target) on table ${CSP_TABLE} from anon`,
    );
  }

  await administrator.query(`grant select on table ${CSP_TABLE} to public`);
  try {
    await assertAuthorityDetected();
  } finally {
    await administrator.query(
      `revoke select on table ${CSP_TABLE} from public`,
    );
  }

  await administrator.query(
    `grant usage on sequence ${CSP_SEQUENCE} to public`,
  );
  try {
    await assertAuthorityDetected();
  } finally {
    await administrator.query(
      `revoke usage on sequence ${CSP_SEQUENCE} from public`,
    );
  }

  await administrator.query(`
    grant execute on function public.read_csp_violation_aggregates(
      timestamptz,
      timestamptz,
      integer
    ) to public
  `);
  try {
    await assertAuthorityDetected();
  } finally {
    await administrator.query(`
      revoke execute on function public.read_csp_violation_aggregates(
        timestamptz,
        timestamptz,
        integer
      ) from public
    `);
  }

  await administrator.query(`
    create policy foundation_disposable_csp_public_probe
      on ${CSP_TABLE}
      for select
      to public
      using (true)
  `);
  try {
    assert.deepEqual(await readCspPolicies(administrator), [
      { policy_name: "foundation_disposable_csp_public_probe" },
    ]);
  } finally {
    await administrator.query(`
      drop policy foundation_disposable_csp_public_probe on ${CSP_TABLE}
    `);
  }
  await assertClosed();
};

const verifyDisposableManagedRelationBaseline = async (observer) => {
  assert.deepEqual(
    await readObserverRelationPrivileges(observer),
    EXPECTED_OBSERVER_RELATIONS,
  );
  assert.deepEqual(
    await readObserverSequencePrivileges(observer),
    EXPECTED_OBSERVER_SEQUENCES,
  );
};

const verifyObserverMutationDetection = async ({
  administrator,
  managedAdministrator,
  observer,
}) => {
  const probeTable = "public.foundation_observer_authority_probe";
  const probeSequence = "public.foundation_observer_authority_probe_seq";
  const probeFunction = "public.foundation_observer_authority_probe()";
  const privateSchema = "foundation_observer_private_probe";
  const unknownManagedTable =
    "extensions.foundation_observer_unknown_table_probe";
  const unknownManagedSequence =
    "extensions.foundation_observer_unknown_sequence_probe";
  const unknownManagedFunction =
    "extensions.foundation_observer_unknown_function_probe()";
  await administrator.query(`
    create table ${probeTable} (id integer, payload text);
    create sequence ${probeSequence};
    create function ${probeFunction}
      returns integer
      language sql
      as 'select 1';
    create schema ${privateSchema};
    create table ${privateSchema}.private_table (id integer);
    create table ${unknownManagedTable} (id integer);
    create sequence ${unknownManagedSequence};
    create function ${unknownManagedFunction}
      returns integer
      language sql
      as 'select 1';
    revoke all on table ${probeTable} from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on sequence ${probeSequence}
      from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on function ${probeFunction}
      from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on schema ${privateSchema}
      from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on table ${privateSchema}.private_table
      from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on table ${unknownManagedTable}
      from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on sequence ${unknownManagedSequence}
      from public, ${FOUNDATION_OBSERVER_ROLE};
    revoke all on function ${unknownManagedFunction}
      from public, ${FOUNDATION_OBSERVER_ROLE};
  `);
  try {
    await assertExactObserverAuthorization(observer);

    await managedAdministrator.query(
      "revoke delete on table cron.job_run_details from public",
    );
    try {
      const mutated = await readObserverRelationPrivileges(observer);
      assert.equal(
        mutated.find(
          ({ object_name: objectName }) =>
            objectName === "cron.job_run_details",
        )?.observer_delete,
        false,
      );
      assert.notDeepEqual(mutated, EXPECTED_OBSERVER_RELATIONS);
    } finally {
      await managedAdministrator.query(
        "grant delete on table cron.job_run_details to public",
      );
    }

    await managedAdministrator.query(
      "grant update on table cron.job to public",
    );
    try {
      const mutated = await readObserverRelationPrivileges(observer);
      assert.equal(
        mutated.find(({ object_name: objectName }) => objectName === "cron.job")
          ?.observer_update,
        true,
      );
      assert.notDeepEqual(mutated, EXPECTED_OBSERVER_RELATIONS);
    } finally {
      await managedAdministrator.query(
        "revoke update on table cron.job from public",
      );
    }

    await managedAdministrator.query(`
      grant select on table cron.job
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const mutated = await readObserverRelationPrivileges(observer);
      assert.equal(
        mutated.find(({ object_name: objectName }) => objectName === "cron.job")
          ?.observer_select_grantable,
        true,
      );
      assert.notDeepEqual(mutated, EXPECTED_OBSERVER_RELATIONS);
    } finally {
      await managedAdministrator.query(`
        revoke select on table cron.job from ${FOUNDATION_OBSERVER_ROLE}
      `);
    }

    await administrator.query(`
      grant select on table ${unknownManagedTable} to public;
      grant usage on sequence ${unknownManagedSequence} to public;
    `);
    try {
      assert.ok(
        (await readObserverRelationPrivileges(observer)).some(
          ({ object_name: objectName }) => objectName === unknownManagedTable,
        ),
      );
      assert.ok(
        (await readObserverSequencePrivileges(observer)).some(
          ({ object_name: objectName }) =>
            objectName === unknownManagedSequence,
        ),
      );
    } finally {
      await administrator.query(`
        revoke select on table ${unknownManagedTable} from public;
        revoke usage on sequence ${unknownManagedSequence} from public;
      `);
    }

    await assertExactObserverAuthorization(observer);

    await administrator.query(`
      grant select (id) on table ${probeTable}
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const probe = (await readObserverRelationPrivileges(observer)).find(
        ({ object_name: objectName }) => objectName === probeTable,
      );
      assert.equal(probe?.observer_select, false);
      assert.equal(probe?.observer_column_select, true);
      assert.equal(probe?.observer_column_select_grantable, true);
    } finally {
      await administrator.query(
        `revoke all on table ${probeTable} from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant select, maintain on table ${probeTable}
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const probe = (await readObserverRelationPrivileges(observer)).find(
        ({ object_name: objectName }) => objectName === probeTable,
      );
      assert.equal(probe?.observer_select, true);
      assert.equal(probe?.observer_select_grantable, true);
      assert.equal(probe?.observer_maintain, true);
      assert.equal(probe?.observer_maintain_grantable, true);
    } finally {
      await administrator.query(
        `revoke all on table ${probeTable} from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant usage on sequence ${probeSequence}
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const probe = (await readObserverSequencePrivileges(observer)).find(
        ({ object_name: objectName }) => objectName === probeSequence,
      );
      assert.equal(probe?.observer_usage, true);
      assert.equal(probe?.observer_usage_grantable, true);
    } finally {
      await administrator.query(
        `revoke all on sequence ${probeSequence} from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant execute on function ${probeFunction}
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const probe = (await readObserverExecutableFunctions(observer)).find(
        ({ function_signature: signature }) => signature === probeFunction,
      );
      assert.equal(probe?.observer_execute, true);
      assert.equal(probe?.observer_execute_grantable, true);
    } finally {
      await administrator.query(
        `revoke all on function ${probeFunction} from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant usage on schema ${privateSchema} to ${FOUNDATION_OBSERVER_ROLE};
      grant select on table ${privateSchema}.private_table
        to ${FOUNDATION_OBSERVER_ROLE};
    `);
    try {
      assert.ok(
        (await readObserverSchemaPrivileges(observer)).some(
          ({ object_name: objectName, observer_usage: usage }) =>
            objectName === privateSchema && usage,
        ),
      );
      assert.ok(
        (await readObserverRelationPrivileges(observer)).some(
          ({ object_name: objectName, observer_select: select }) =>
            objectName === `${privateSchema}.private_table` && select,
        ),
      );
    } finally {
      await administrator.query(`
        revoke all on table ${privateSchema}.private_table
          from ${FOUNDATION_OBSERVER_ROLE};
        revoke all on schema ${privateSchema}
          from ${FOUNDATION_OBSERVER_ROLE};
      `);
    }

    await administrator.query(`
      grant create on schema ${privateSchema}
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const probe = (await readObserverSchemaPrivileges(observer)).find(
        ({ object_name: objectName }) => objectName === privateSchema,
      );
      assert.equal(probe?.observer_create, true);
      assert.equal(probe?.observer_create_grantable, true);
    } finally {
      await administrator.query(
        `revoke all on schema ${privateSchema} from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant create on database postgres
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const identity = await readObserverIdentity(observer);
      assert.equal(identity.database_create, true);
      assert.equal(identity.database_create_grantable, true);
      assert.deepEqual(await readObserverDatabaseCreatePrivileges(observer), [
        { database_name: "postgres" },
      ]);
    } finally {
      await administrator.query(
        `revoke create on database postgres from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant temporary on database postgres
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      const identity = await readObserverIdentity(observer);
      assert.equal(identity.database_temporary, true);
      assert.equal(identity.database_temporary_grantable, true);
    } finally {
      await administrator.query(
        `revoke temporary on database postgres from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await administrator.query(`
      grant execute on function ${unknownManagedFunction}
        to ${FOUNDATION_OBSERVER_ROLE} with grant option
    `);
    try {
      assert.deepEqual(await readObserverManagedDirectFunctions(observer), [
        {
          function_signature: unknownManagedFunction,
          observer_execute_grantable: true,
        },
      ]);
    } finally {
      await administrator.query(
        `revoke all on function ${unknownManagedFunction} from ${FOUNDATION_OBSERVER_ROLE}`,
      );
    }

    await assertExactObserverAuthorization(observer);
  } finally {
    await managedAdministrator.query(`
      grant delete on table cron.job_run_details to public;
      revoke update on table cron.job from public;
      revoke select on table cron.job from ${FOUNDATION_OBSERVER_ROLE};
    `);
    await administrator.query(`
      revoke create on database postgres from ${FOUNDATION_OBSERVER_ROLE};
      revoke temporary on database postgres from ${FOUNDATION_OBSERVER_ROLE};
      revoke all on function ${unknownManagedFunction}
        from ${FOUNDATION_OBSERVER_ROLE};
      drop schema if exists ${privateSchema} cascade;
      drop table if exists ${unknownManagedTable};
      drop sequence if exists ${unknownManagedSequence};
      drop function if exists ${unknownManagedFunction};
      drop table if exists ${probeTable};
      drop sequence if exists ${probeSequence};
      drop function if exists ${probeFunction};
    `);
  }
};

const verifyFoundationDatabaseRoles = async ({ Client, administrator }) => {
  const roleNames = [
    FOUNDATION_BACKUP_RESTORE_ROLE,
    FOUNDATION_BACKUP_SOURCE_ROLE,
    FOUNDATION_OBSERVER_ROLE,
  ];
  const roleAuthority = await administrator.query({
    text: `select
      rolname,
      rolcanlogin,
      rolinherit,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls,
      rolpassword is null as passwordless
    from pg_catalog.pg_authid
    where rolname = any($1::name[])
    order by rolname`,
    values: [roleNames],
  });
  assert.deepEqual(
    roleAuthority.rows.map((row) => row.rolname),
    roleNames,
  );
  if (
    roleAuthority.rows.some(
      (role) =>
        role.rolcanlogin !== true ||
        role.rolinherit !== false ||
        role.rolsuper !== false ||
        role.rolcreatedb !== false ||
        role.rolcreaterole !== false ||
        role.rolreplication !== false ||
        role.rolbypassrls !== false ||
        role.passwordless !== true,
    )
  ) {
    throw new Error("Disposable DB foundation role attributes differ");
  }
  const membershipCount = Number(
    await scalar(
      administrator,
      `select count(*)::integer
       from pg_catalog.pg_auth_members membership
       where membership.member = any(
           array(
             select oid from pg_catalog.pg_roles
             where rolname in (
               '${FOUNDATION_OBSERVER_ROLE}',
               '${FOUNDATION_BACKUP_SOURCE_ROLE}',
               '${FOUNDATION_BACKUP_RESTORE_ROLE}'
             )
           )
         )`,
    ),
  );
  if (membershipCount !== 0) {
    throw new Error("Disposable DB foundation roles have memberships");
  }
  const ownedObjectCount = Number(
    await scalar(
      administrator,
      `with foundation_roles as (
         select oid from pg_catalog.pg_roles
         where rolname in (
           '${FOUNDATION_OBSERVER_ROLE}',
           '${FOUNDATION_BACKUP_SOURCE_ROLE}',
           '${FOUNDATION_BACKUP_RESTORE_ROLE}'
         )
       ), owners as (
         select relowner as owner from pg_catalog.pg_class
         union all select proowner from pg_catalog.pg_proc
         union all select nspowner from pg_catalog.pg_namespace
         union all select typowner from pg_catalog.pg_type
         union all select datdba from pg_catalog.pg_database
         union all select extowner from pg_catalog.pg_extension
       )
       select count(*)::integer
       from owners
       where owner = any(array(select oid from foundation_roles))`,
    ),
  );
  if (ownedObjectCount !== 0) {
    throw new Error("Disposable DB foundation roles own database objects");
  }

  const rolePrivileges = await administrator.query({
    text: `select
      requested.role_name,
      has_schema_privilege(requested.role_name, 'public', 'USAGE') as public_usage,
      has_schema_privilege(requested.role_name, 'public', 'CREATE') as public_create,
      (
        select coalesce(
          bool_or(
            has_table_privilege(requested.role_name, relation.oid, 'SELECT')
          ),
          false
        )
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relkind in ('r', 'p')
      ) as any_public_table_select,
      has_table_privilege(
        requested.role_name,
        'public.persistence_release_a_metric_events',
        'SELECT'
      ) as metrics_select,
      has_table_privilege(
        requested.role_name,
        'public.csp_violation_reports',
        'SELECT'
      ) as csp_select,
      has_table_privilege(
        requested.role_name,
        'supabase_migrations.schema_migrations',
        'SELECT'
      ) as migration_select,
      has_function_privilege(
        requested.role_name,
        'public.read_persistence_release_a_metrics(timestamptz,timestamptz,integer)',
        'EXECUTE'
      ) as metrics_execute,
      has_function_privilege(
        requested.role_name,
        'public.read_csp_violation_aggregates(timestamptz,timestamptz,integer)',
        'EXECUTE'
      ) as csp_execute,
      has_function_privilege(
        requested.role_name,
        'public.read_csp_deployment_violation_aggregates(timestamptz,timestamptz,text,text,integer)',
        'EXECUTE'
      ) as csp_deployment_execute,
      has_function_privilege(
        requested.role_name,
        'public.read_foundation_backup_restore_integrity()',
        'EXECUTE'
      ) as integrity_execute,
      has_function_privilege(
        requested.role_name,
        'public.retain_persistence_release_a_metrics(boolean,integer,integer)',
        'EXECUTE'
      ) as retention_execute
    from unnest($1::text[]) as requested(role_name)
    order by requested.role_name`,
    values: [roleNames],
  });
  for (const privilege of rolePrivileges.rows) {
    const observer = privilege.role_name === FOUNDATION_OBSERVER_ROLE;
    if (
      privilege.public_usage !== true ||
      privilege.public_create !== false ||
      privilege.any_public_table_select !== false ||
      privilege.metrics_select !== false ||
      privilege.csp_select !== false ||
      privilege.migration_select !== observer ||
      privilege.metrics_execute !== observer ||
      privilege.csp_execute !== observer ||
      privilege.csp_deployment_execute !== observer ||
      privilege.integrity_execute !== !observer ||
      privilege.retention_execute !== false
    ) {
      throw new Error(
        `Disposable DB ${privilege.role_name} privilege floor differs`,
      );
    }
  }

  await administrator.query(`
    alter role ${FOUNDATION_OBSERVER_ROLE}
      password '${FOUNDATION_ROLE_PASSWORDS[FOUNDATION_OBSERVER_ROLE]}';
    alter role ${FOUNDATION_BACKUP_SOURCE_ROLE}
      password '${FOUNDATION_ROLE_PASSWORDS[FOUNDATION_BACKUP_SOURCE_ROLE]}';
    alter role ${FOUNDATION_BACKUP_RESTORE_ROLE}
      password '${FOUNDATION_ROLE_PASSWORDS[FOUNDATION_BACKUP_RESTORE_ROLE]}';
  `);
  const [managedAdministrator, observer, sourceReader, restoreReader] =
    await Promise.all([
      connectManagedAdministrator({ Client }),
      connectFoundationRole({ Client, role: FOUNDATION_OBSERVER_ROLE }),
      connectFoundationRole({ Client, role: FOUNDATION_BACKUP_SOURCE_ROLE }),
      connectFoundationRole({ Client, role: FOUNDATION_BACKUP_RESTORE_ROLE }),
    ]);
  try {
    const observerIdentity = await observer.query(
      `select
        current_user as role,
        session_user as session_role,
        current_setting('default_transaction_read_only') as read_only`,
    );
    assert.deepEqual(observerIdentity.rows, [
      {
        role: FOUNDATION_OBSERVER_ROLE,
        session_role: FOUNDATION_OBSERVER_ROLE,
        read_only: "on",
      },
    ]);
    const observerMemberships = await observer.query(
      `select roles.rolname::text as role
       from pg_catalog.pg_roles roles
       where roles.rolname <> current_user
         and pg_catalog.pg_has_role(current_user, roles.oid, 'MEMBER')
       order by role`,
    );
    assert.deepEqual(observerMemberships.rows, []);
    const observerOwnership = await observer.query(
      `select count(*)::integer as owned_object_count
       from pg_catalog.pg_shdepend ownership
       where ownership.refclassid =
           pg_catalog.to_regclass('pg_catalog.pg_authid')
         and ownership.refobjid = (
           select roles.oid
           from pg_catalog.pg_roles roles
           where roles.rolname = current_user
         )
         and ownership.deptype = 'o'`,
    );
    assert.deepEqual(observerOwnership.rows, [{ owned_object_count: 0 }]);

    await verifyDisposableManagedRelationBaseline(observer);
    await assertExactObserverAuthorization(observer);
    await verifyObserverMutationDetection({
      administrator,
      managedAdministrator,
      observer,
    });
    await verifyExactMigrationHistory({ administrator, observer });
    await observer.query(`select * from public.read_persistence_release_a_metrics(
      clock_timestamp() - interval '1 minute',
      clock_timestamp() + interval '1 minute',
      10
    )`);
    await observer.query(`select * from public.read_csp_violation_aggregates(
      clock_timestamp() - interval '1 minute',
      clock_timestamp() + interval '1 minute',
      10
    )`);
    await observer.query({
      text: `select * from public.read_csp_deployment_violation_aggregates(
        clock_timestamp() - interval '1 minute',
        clock_timestamp() + interval '1 minute',
        $1,
        $2,
        10
      )`,
      values: [
        "89abcdef0123456789abcdef0123456789abcdef",
        "deployment_disposable_csp_1",
      ],
    });
    for (const statement of [
      "select * from public.persistence_release_a_metric_events limit 1",
      `insert into public.persistence_release_a_metric_events (
        schema_version,
        event_version,
        event_name,
        outcome,
        build_id,
        browser_family,
        app_mode,
        online
      ) values (
        1,
        1,
        'startup',
        'ready',
        '0123456789abcdef0123456789abcdef01234567',
        'chromium',
        'browser-tab',
        true
      )`,
      "create table public.foundation_observer_forbidden(id integer)",
    ]) {
      await assertDenied42501(observer, statement);
    }

    const integrityRows = [];
    for (const [client, role] of [
      [sourceReader, FOUNDATION_BACKUP_SOURCE_ROLE],
      [restoreReader, FOUNDATION_BACKUP_RESTORE_ROLE],
    ]) {
      const identity = await client.query(
        `select
          current_user as role,
          session_user as session_role,
          current_setting('default_transaction_read_only') as read_only`,
      );
      assert.deepEqual(identity.rows, [
        { role, session_role: role, read_only: "on" },
      ]);
      const executablePublicFunctions = await client.query(
        `select pg_catalog.format(
          '%I.%I(%s)',
          namespace.nspname,
          function_definition.proname,
          pg_catalog.pg_get_function_identity_arguments(function_definition.oid)
        ) as function_signature
        from pg_catalog.pg_proc function_definition
        join pg_catalog.pg_namespace namespace
          on namespace.oid = function_definition.pronamespace
        where namespace.nspname = 'public'
          and pg_catalog.has_function_privilege(
            current_user,
            function_definition.oid,
            'EXECUTE'
          )
        order by function_signature`,
      );
      assert.deepEqual(executablePublicFunctions.rows, [
        {
          function_signature:
            "public.read_foundation_backup_restore_integrity()",
        },
      ]);
      const integrity = await client.query(
        "select * from public.read_foundation_backup_restore_integrity()",
      );
      if (
        integrity.rowCount !== 1 ||
        !/^[0-9a-f]{64}$/u.test(integrity.rows[0].database_head) ||
        integrity.rows[0].migration_version !== "20260810010000" ||
        !/^[0-9a-f]{64}$/u.test(integrity.rows[0].integrity_sha256)
      ) {
        throw new Error(`Disposable DB ${role} integrity result differs`);
      }
      integrityRows.push(integrity.rows[0]);
      for (const statement of [
        "select * from public.csp_violation_reports limit 1",
        "delete from public.csp_violation_reports where false",
        `create table public.${role}_forbidden(id integer)`,
      ]) {
        await assertDenied42501(client, statement);
      }
    }
    assert.deepEqual(integrityRows[0], integrityRows[1]);
  } finally {
    await Promise.allSettled([
      managedAdministrator.end(),
      observer.end(),
      sourceReader.end(),
      restoreReader.end(),
    ]);
  }
};

const RELEASE_STATE_NAMESPACE = "foundation-disposable-control";
const RELEASE_STATE_UPGRADE_NAMESPACE = "foundation-disposable-control-upgrade";
const RELEASE_STATE_EXECUTOR = "foundation_disposable_release_executor";
const RELEASE_STATE_DENIED_EXECUTOR = "foundation_disposable_release_denied";
const RELEASE_STATE_EXECUTOR_PASSWORD = "disposable-release-executor";
const RELEASE_STATE_DENIED_PASSWORD = "disposable-release-denied";
const ACCEPTANCE_OPERATION_ID = "disposable-acceptance-chain";
const ACCEPTANCE_SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const ACCEPTANCE_BINDING_ID = "disposable-standard-binding";
const ACCEPTANCE_SAMPLE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-probe-sample+json;version=1";
const ACCEPTANCE_COMMIT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-probe-chain-commit+json;version=1";
const ACCEPTANCE_CHAIN_ID = sha256Bytes(
  Buffer.from(
    `${RELEASE_STATE_NAMESPACE}\n${ACCEPTANCE_OPERATION_ID}\n${ACCEPTANCE_SOURCE_SHA}\n${ACCEPTANCE_BINDING_ID}`,
    "utf8",
  ),
);

const acceptanceReference = (sha256) => ({
  sha256,
  uri: `release-state://${RELEASE_STATE_NAMESPACE}/evidence/${sha256}`,
});

const createAcceptancePair = ({
  marker,
  previousCommit = null,
  previousSample = null,
  sequence,
}) => {
  const sampleBytes = canonicalJsonBytes({
    collectorIdentity: { marker },
    evidenceKind: "continuous-production-probe-sample/v1",
    namespace: RELEASE_STATE_NAMESPACE,
    operationId: ACCEPTANCE_OPERATION_ID,
    previousSample,
    results: [],
    schemaVersion: 1,
    sourceSha: ACCEPTANCE_SOURCE_SHA,
    standardBindingId: ACCEPTANCE_BINDING_ID,
  });
  const sampleReference = acceptanceReference(sha256Bytes(sampleBytes));
  const commitBytes = canonicalJsonBytes({
    bindingId: ACCEPTANCE_BINDING_ID,
    commitKind: "continuous-probe-chain-commit/v1",
    namespace: RELEASE_STATE_NAMESPACE,
    operationId: ACCEPTANCE_OPERATION_ID,
    previousCommit,
    sampleReference,
    schemaVersion: 1,
    sequence,
    sourceSha: ACCEPTANCE_SOURCE_SHA,
  });
  return {
    commitBytes,
    commitReference: acceptanceReference(sha256Bytes(commitBytes)),
    sampleBytes,
    sampleReference,
  };
};

const appendAcceptancePair = (
  client,
  {
    bindingId = ACCEPTANCE_BINDING_ID,
    chainId = ACCEPTANCE_CHAIN_ID,
    commitBytes,
    commitMediaType = ACCEPTANCE_COMMIT_MEDIA_TYPE,
    expectedHeadSha,
    expectedSequence,
    operationId = ACCEPTANCE_OPERATION_ID,
    sampleBytes,
    sampleMediaType = ACCEPTANCE_SAMPLE_MEDIA_TYPE,
    sourceSha = ACCEPTANCE_SOURCE_SHA,
  },
) =>
  client.query({
    text: `select *
      from foundation_release.append_acceptance_evidence_chain(
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13
      )`,
    values: [
      RELEASE_STATE_NAMESPACE,
      chainId,
      operationId,
      sourceSha,
      bindingId,
      expectedSequence,
      expectedHeadSha,
      sha256Bytes(sampleBytes),
      sampleMediaType,
      sampleBytes,
      sha256Bytes(commitBytes),
      commitMediaType,
      commitBytes,
    ],
  });

const readAcceptanceChain = (
  client,
  {
    bindingId = ACCEPTANCE_BINDING_ID,
    chainId = ACCEPTANCE_CHAIN_ID,
    operationId = ACCEPTANCE_OPERATION_ID,
    sourceSha = ACCEPTANCE_SOURCE_SHA,
  } = {},
) =>
  client.query({
    text: `select *
      from foundation_release.read_acceptance_evidence_chain(
        $1, $2, $3, $4, $5
      )`,
    values: [
      RELEASE_STATE_NAMESPACE,
      chainId,
      operationId,
      sourceSha,
      bindingId,
    ],
  });

const createReleaseStateEvent = ({
  appendId,
  operationId,
  namespace = RELEASE_STATE_NAMESPACE,
  eventType = "operation-aborted",
  sequence = 1,
  previousEventHash = null,
  payload = {},
  evidenceRefs = [],
}) => {
  return {
    approvalRefs: [],
    appendId,
    evidenceRefs,
    eventType,
    namespace,
    operationId,
    payload,
    payloadSha256: sha256Bytes(canonicalJsonBytes(payload)),
    previousEventHash,
    schemaVersion: 1,
    sequence,
  };
};

const createPhaseExitReleaseStateEvent = ({
  appendId,
  marker,
  namespace,
  operationId,
  previousEventHash,
  sequence,
}) => {
  const attestationSha256 = sha256Bytes(
    Buffer.from(`${namespace}\n${marker}`, "utf8"),
  );
  const attestation = {
    sha256: attestationSha256,
    uri: `release-state://${namespace}/evidence/${attestationSha256}`,
  };
  return createReleaseStateEvent({
    appendId,
    operationId,
    namespace,
    eventType: "phase-exit-attested",
    sequence,
    previousEventHash,
    payload: {
      gate: "P0-BASELINE",
      sourceSha: ACCEPTANCE_SOURCE_SHA,
      subjectKind: "repository-phase-subject/v1",
      attestation,
      predecessor: null,
    },
    evidenceRefs: [attestation],
  });
};

const appendReleaseStateEvent = (
  client,
  event,
  { expectedSequence = 0, expectedHash = null } = {},
) =>
  client.query({
    text: `select *
      from foundation_release.compare_and_append($1, $2, $3, $4, $5)`,
    values: [
      event.namespace,
      expectedSequence,
      expectedHash,
      event.appendId,
      canonicalJsonBytes(event),
    ],
  });

const putReleaseEvidence = ({
  bytes,
  client,
  mediaType = "application/json",
  sha256 = sha256Bytes(bytes),
}) =>
  client.query({
    text: `select *
      from foundation_release.put_evidence_if_absent($1, $2, $3, $4)`,
    values: [RELEASE_STATE_NAMESPACE, sha256, mediaType, bytes],
  });

const connectReleaseStateRole = async ({ Client, password, user }) => {
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user,
    password,
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "foundation-disposable-release-state-gate",
  });
  await client.connect();
  return client;
};

const verifyReleaseStateControlStore = async ({ Client, administrator }) => {
  const phaseExitMigration = releaseStateStoreMigrations.at(-1);
  for (const migration of releaseStateStoreMigrations.slice(0, -1)) {
    await administrator.query(migration);
  }
  await administrator.query(`
    create role ${RELEASE_STATE_EXECUTOR}
      login password '${RELEASE_STATE_EXECUTOR_PASSWORD}';
    create role ${RELEASE_STATE_DENIED_EXECUTOR}
      login password '${RELEASE_STATE_DENIED_PASSWORD}';
    grant usage on schema foundation_release
      to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.compare_and_append(
      text,
      bigint,
      text,
      uuid,
      bytea
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.put_evidence_if_absent(
      text,
      text,
      text,
      bytea
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.append_acceptance_evidence_chain(
      text,
      text,
      text,
      text,
      text,
      bigint,
      text,
      text,
      text,
      bytea,
      text,
      text,
      bytea
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.read_acceptance_evidence_chain(
      text,
      text,
      text,
      text,
      text
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    insert into foundation_release.release_state_namespace_roles (
      namespace,
      executor_role
    ) values (
      '${RELEASE_STATE_NAMESPACE}',
      '${RELEASE_STATE_EXECUTOR}'
    ), (
      '${RELEASE_STATE_UPGRADE_NAMESPACE}',
      '${RELEASE_STATE_EXECUTOR}'
    );
  `);

  const executor = await connectReleaseStateRole({
    Client,
    password: RELEASE_STATE_EXECUTOR_PASSWORD,
    user: RELEASE_STATE_EXECUTOR,
  });
  const deniedExecutor = await connectReleaseStateRole({
    Client,
    password: RELEASE_STATE_DENIED_PASSWORD,
    user: RELEASE_STATE_DENIED_EXECUTOR,
  });
  try {
    const upgradeInitialEvent = createReleaseStateEvent({
      appendId: "33333333-3333-4333-8333-333333333333",
      operationId: "disposable-control-store-upgrade-initial",
      namespace: RELEASE_STATE_UPGRADE_NAMESPACE,
      eventType: "state-initialized",
    });
    const upgradeInitialAppend = await appendReleaseStateEvent(
      executor,
      upgradeInitialEvent,
    );
    const upgradeInitialHash = sha256Bytes(
      canonicalJsonBytes(upgradeInitialEvent),
    );
    if (
      upgradeInitialAppend.rowCount !== 1 ||
      Number(upgradeInitialAppend.rows[0].sequence) !== 1 ||
      upgradeInitialAppend.rows[0].event_hash !== upgradeInitialHash ||
      upgradeInitialAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State pre-upgrade append differs");
    }
    const upgradePhaseExitEvent = createPhaseExitReleaseStateEvent({
      appendId: "44444444-4444-4444-8444-444444444444",
      marker: "existing-namespace-upgrade",
      namespace: RELEASE_STATE_UPGRADE_NAMESPACE,
      operationId: "disposable-control-store-upgrade-phase-exit",
      previousEventHash: upgradeInitialHash,
      sequence: 2,
    });
    await assert.rejects(
      appendReleaseStateEvent(executor, upgradePhaseExitEvent, {
        expectedSequence: 1,
        expectedHash: upgradeInitialHash,
      }),
      (error) =>
        isPostgresError(error, "22023", /event envelope does not match/u),
    );

    await administrator.query(phaseExitMigration);
    const upgradedPhaseExitAppend = await appendReleaseStateEvent(
      executor,
      upgradePhaseExitEvent,
      { expectedSequence: 1, expectedHash: upgradeInitialHash },
    );
    const upgradePhaseExitHash = sha256Bytes(
      canonicalJsonBytes(upgradePhaseExitEvent),
    );
    if (
      upgradedPhaseExitAppend.rowCount !== 1 ||
      Number(upgradedPhaseExitAppend.rows[0].sequence) !== 2 ||
      upgradedPhaseExitAppend.rows[0].event_hash !== upgradePhaseExitHash ||
      upgradedPhaseExitAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State phase exit upgrade append differs");
    }

    await administrator.query(phaseExitMigration);
    const upgradedPhaseExitReplay = await appendReleaseStateEvent(
      executor,
      upgradePhaseExitEvent,
      { expectedSequence: 1, expectedHash: upgradeInitialHash },
    );
    if (
      upgradedPhaseExitReplay.rowCount !== 1 ||
      upgradedPhaseExitReplay.rows[0].event_hash !== upgradePhaseExitHash ||
      upgradedPhaseExitReplay.rows[0].replayed !== true
    ) {
      throw new Error("Release State phase exit upgrade replay differs");
    }
    const upgradedHistory = await administrator.query({
      text: `select sequence, event_hash
        from foundation_release.release_state_events
        where namespace = $1
        order by sequence`,
      values: [RELEASE_STATE_UPGRADE_NAMESPACE],
    });
    if (
      upgradedHistory.rowCount !== 2 ||
      Number(upgradedHistory.rows[0].sequence) !== 1 ||
      upgradedHistory.rows[0].event_hash !== upgradeInitialHash ||
      Number(upgradedHistory.rows[1].sequence) !== 2 ||
      upgradedHistory.rows[1].event_hash !== upgradePhaseExitHash
    ) {
      throw new Error("Release State phase exit upgrade changed prior history");
    }

    const unknownEvent = createReleaseStateEvent({
      appendId: "66666666-6666-4666-8666-666666666666",
      operationId: "disposable-control-store-unknown-event",
      eventType: "caller-defined-event",
    });
    await assert.rejects(
      appendReleaseStateEvent(executor, unknownEvent),
      (error) =>
        isPostgresError(error, "22023", /event envelope does not match/u),
    );

    const event = createReleaseStateEvent({
      appendId: "11111111-1111-4111-8111-111111111111",
      operationId: "disposable-control-store-append",
    });
    const eventBytes = canonicalJsonBytes(event);
    const firstAppend = await appendReleaseStateEvent(executor, event);
    if (
      firstAppend.rowCount !== 1 ||
      Number(firstAppend.rows[0].sequence) !== 1 ||
      firstAppend.rows[0].event_hash !== sha256Bytes(eventBytes) ||
      firstAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State initial CAS receipt differs");
    }

    const replayedAppend = await appendReleaseStateEvent(executor, event);
    if (
      replayedAppend.rowCount !== 1 ||
      replayedAppend.rows[0].event_hash !== firstAppend.rows[0].event_hash ||
      replayedAppend.rows[0].replayed !== true
    ) {
      throw new Error("Release State idempotent append receipt differs");
    }

    const freshPhaseExitEvent = createPhaseExitReleaseStateEvent({
      appendId: "55555555-5555-4555-8555-555555555555",
      marker: "fresh-ordered-migrations",
      namespace: RELEASE_STATE_NAMESPACE,
      operationId: "disposable-control-store-fresh-phase-exit",
      previousEventHash: firstAppend.rows[0].event_hash,
      sequence: 2,
    });
    const freshPhaseExitAppend = await appendReleaseStateEvent(
      executor,
      freshPhaseExitEvent,
      { expectedSequence: 1, expectedHash: firstAppend.rows[0].event_hash },
    );
    if (
      freshPhaseExitAppend.rowCount !== 1 ||
      Number(freshPhaseExitAppend.rows[0].sequence) !== 2 ||
      freshPhaseExitAppend.rows[0].event_hash !==
        sha256Bytes(canonicalJsonBytes(freshPhaseExitEvent)) ||
      freshPhaseExitAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State fresh phase exit append differs");
    }

    const conflictingEvent = createReleaseStateEvent({
      appendId: "22222222-2222-4222-8222-222222222222",
      operationId: "disposable-control-store-conflict",
    });
    await assert.rejects(
      appendReleaseStateEvent(executor, conflictingEvent),
      (error) => isPostgresError(error, "40001", /compare-and-swap failed/u),
    );
    await assert.rejects(
      appendReleaseStateEvent(deniedExecutor, event),
      (error) =>
        isPostgresError(error, "42501", /release namespace executor denied/u),
    );
    await assert.rejects(
      deniedExecutor.query(
        "select sequence from foundation_release.release_state_heads",
      ),
      (error) => isPostgresError(error, "42501"),
    );

    const evidenceBytes = canonicalJsonBytes({
      kind: "disposable-release-evidence/v1",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
    });
    const evidenceSha256 = sha256Bytes(evidenceBytes);
    const firstEvidence = await putReleaseEvidence({
      bytes: evidenceBytes,
      client: executor,
    });
    if (
      firstEvidence.rowCount !== 1 ||
      firstEvidence.rows[0].sha256 !== evidenceSha256 ||
      Number(firstEvidence.rows[0].byte_length) !== evidenceBytes.length ||
      firstEvidence.rows[0].replayed !== false
    ) {
      throw new Error("Release State initial evidence receipt differs");
    }

    const replayedEvidence = await putReleaseEvidence({
      bytes: evidenceBytes,
      client: executor,
    });
    if (
      replayedEvidence.rowCount !== 1 ||
      replayedEvidence.rows[0].sha256 !== evidenceSha256 ||
      replayedEvidence.rows[0].replayed !== true
    ) {
      throw new Error("Release State idempotent evidence receipt differs");
    }
    await assert.rejects(
      putReleaseEvidence({
        bytes: evidenceBytes,
        client: executor,
        mediaType: "application/octet-stream",
      }),
      (error) =>
        isPostgresError(error, "23505", /different metadata or bytes/u),
    );
    await assert.rejects(
      putReleaseEvidence({
        bytes: Buffer.from("tampered", "utf8"),
        client: executor,
        sha256: evidenceSha256,
      }),
      (error) => isPostgresError(error, "22000", /SHA-256 mismatch/u),
    );
    await assert.rejects(
      administrator.query(`
        update foundation_release.release_evidence_objects
        set media_type = 'application/octet-stream'
        where namespace = '${RELEASE_STATE_NAMESPACE}'
      `),
      (error) => isPostgresError(error, "55000", /records are immutable/u),
    );
    await assert.rejects(
      administrator.query(`
        delete from foundation_release.release_state_events
        where namespace = '${RELEASE_STATE_NAMESPACE}'
      `),
      (error) => isPostgresError(error, "55000", /records are immutable/u),
    );

    const firstAcceptancePair = createAcceptancePair({
      marker: "first",
      sequence: 1,
    });
    const firstAcceptanceAppend = await appendAcceptancePair(executor, {
      ...firstAcceptancePair,
      expectedHeadSha: null,
      expectedSequence: 0,
    });
    if (
      firstAcceptanceAppend.rowCount !== 1 ||
      Number(firstAcceptanceAppend.rows[0].chain_sequence) !== 1 ||
      firstAcceptanceAppend.rows[0].chain_head_sha !==
        firstAcceptancePair.commitReference.sha256 ||
      firstAcceptanceAppend.rows[0].sample_committed_at.toISOString() !==
        firstAcceptanceAppend.rows[0].commit_committed_at.toISOString() ||
      firstAcceptanceAppend.rows[0].replayed !== false
    ) {
      throw new Error("Acceptance chain initial atomic append differs");
    }
    const firstAcceptanceReplay = await appendAcceptancePair(executor, {
      ...firstAcceptancePair,
      expectedHeadSha: null,
      expectedSequence: 0,
    });
    if (
      firstAcceptanceReplay.rowCount !== 1 ||
      firstAcceptanceReplay.rows[0].chain_head_sha !==
        firstAcceptancePair.commitReference.sha256 ||
      firstAcceptanceReplay.rows[0].replayed !== true
    ) {
      throw new Error("Acceptance chain idempotent replay differs");
    }
    const firstAcceptanceHead = await readAcceptanceChain(executor);
    if (
      firstAcceptanceHead.rowCount !== 1 ||
      Number(firstAcceptanceHead.rows[0].sequence) !== 1 ||
      firstAcceptanceHead.rows[0].head_sha !==
        firstAcceptancePair.commitReference.sha256 ||
      firstAcceptanceHead.rows[0].operation_id !== ACCEPTANCE_OPERATION_ID ||
      firstAcceptanceHead.rows[0].source_sha !== ACCEPTANCE_SOURCE_SHA ||
      firstAcceptanceHead.rows[0].binding_id !== ACCEPTANCE_BINDING_ID
    ) {
      throw new Error("Acceptance chain canonical head differs");
    }

    const staleAcceptancePair = createAcceptancePair({
      marker: "stale-origin",
      sequence: 1,
    });
    await assert.rejects(
      appendAcceptancePair(executor, {
        ...staleAcceptancePair,
        expectedHeadSha: null,
        expectedSequence: 0,
      }),
      (error) => isPostgresError(error, "40001", /compare-and-swap failed/u),
    );
    await assert.rejects(
      appendAcceptancePair(executor, {
        ...staleAcceptancePair,
        chainId: "f".repeat(64),
        expectedHeadSha: null,
        expectedSequence: 0,
      }),
      (error) => isPostgresError(error, "22023", /arguments are invalid/u),
    );
    await assert.rejects(
      appendAcceptancePair(executor, {
        ...staleAcceptancePair,
        expectedHeadSha: null,
        expectedSequence: 0,
        sampleMediaType: "application/json",
      }),
      (error) => isPostgresError(error, "22023", /arguments are invalid/u),
    );

    const secondAcceptancePair = createAcceptancePair({
      marker: "second",
      previousCommit: firstAcceptancePair.commitReference,
      previousSample: firstAcceptancePair.sampleReference,
      sequence: 2,
    });
    await administrator.query(`
      create function foundation_release.foundation_disposable_reject_chain_update()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'disposable acceptance rollback probe';
      end;
      $$;
      create trigger foundation_disposable_reject_chain_update
      before update on foundation_release.acceptance_evidence_chains
      for each row execute function
        foundation_release.foundation_disposable_reject_chain_update();
    `);
    try {
      await assert.rejects(
        appendAcceptancePair(executor, {
          ...secondAcceptancePair,
          expectedHeadSha: firstAcceptancePair.commitReference.sha256,
          expectedSequence: 1,
        }),
        /disposable acceptance rollback probe/u,
      );
    } finally {
      await administrator.query(`
        drop trigger foundation_disposable_reject_chain_update
          on foundation_release.acceptance_evidence_chains;
        drop function
          foundation_release.foundation_disposable_reject_chain_update();
      `);
    }
    const rolledBackAcceptanceObjects = Number(
      await scalar(
        administrator,
        `select count(*)::integer
         from foundation_release.release_evidence_objects
         where namespace = '${RELEASE_STATE_NAMESPACE}'
           and sha256 in (
             '${secondAcceptancePair.sampleReference.sha256}',
             '${secondAcceptancePair.commitReference.sha256}'
           )`,
      ),
    );
    const headAfterRollback = await readAcceptanceChain(executor);
    if (
      rolledBackAcceptanceObjects !== 0 ||
      Number(headAfterRollback.rows[0].sequence) !== 1 ||
      headAfterRollback.rows[0].head_sha !==
        firstAcceptancePair.commitReference.sha256
    ) {
      throw new Error("Acceptance chain failed append was not atomic");
    }

    const secondAcceptanceAppend = await appendAcceptancePair(executor, {
      ...secondAcceptancePair,
      expectedHeadSha: firstAcceptancePair.commitReference.sha256,
      expectedSequence: 1,
    });
    if (
      secondAcceptanceAppend.rowCount !== 1 ||
      Number(secondAcceptanceAppend.rows[0].chain_sequence) !== 2 ||
      secondAcceptanceAppend.rows[0].chain_head_sha !==
        secondAcceptancePair.commitReference.sha256 ||
      secondAcceptanceAppend.rows[0].replayed !== false
    ) {
      throw new Error("Acceptance chain second atomic append differs");
    }
    const secondAcceptanceReplay = await appendAcceptancePair(executor, {
      ...secondAcceptancePair,
      expectedHeadSha: firstAcceptancePair.commitReference.sha256,
      expectedSequence: 1,
    });
    if (secondAcceptanceReplay.rows[0].replayed !== true) {
      throw new Error("Acceptance chain second replay differs");
    }

    const invalidCommitBytes = canonicalJsonBytes({
      bindingId: ACCEPTANCE_BINDING_ID,
      commitKind: "continuous-probe-chain-commit/v1",
      namespace: RELEASE_STATE_NAMESPACE,
      operationId: "different-operation",
      previousCommit: secondAcceptancePair.commitReference,
      sampleReference: secondAcceptancePair.sampleReference,
      schemaVersion: 1,
      sequence: 3,
      sourceSha: ACCEPTANCE_SOURCE_SHA,
    });
    await assert.rejects(
      appendAcceptancePair(executor, {
        commitBytes: invalidCommitBytes,
        expectedHeadSha: secondAcceptancePair.commitReference.sha256,
        expectedSequence: 2,
        sampleBytes: secondAcceptancePair.sampleBytes,
      }),
      (error) =>
        isPostgresError(error, "22023", /commit document binding is invalid/u),
    );

    const thirdAcceptancePair = createAcceptancePair({
      marker: "denied",
      previousCommit: secondAcceptancePair.commitReference,
      previousSample: secondAcceptancePair.sampleReference,
      sequence: 3,
    });
    await assert.rejects(
      appendAcceptancePair(deniedExecutor, {
        ...thirdAcceptancePair,
        expectedHeadSha: secondAcceptancePair.commitReference.sha256,
        expectedSequence: 2,
      }),
      (error) => isPostgresError(error, "42501", /executor is not authorized/u),
    );
    await assert.rejects(readAcceptanceChain(deniedExecutor), (error) =>
      isPostgresError(error, "42501", /reader is not authorized/u),
    );
    await assert.rejects(
      readAcceptanceChain(executor, { chainId: "e".repeat(64) }),
      (error) => isPostgresError(error, "22023", /reader identity is invalid/u),
    );
    for (const statement of [
      "select * from foundation_release.acceptance_evidence_chains",
      `update foundation_release.acceptance_evidence_chains
       set updated_at = clock_timestamp()`,
      "delete from foundation_release.acceptance_evidence_chains",
    ]) {
      await assert.rejects(executor.query(statement), (error) =>
        isPostgresError(error, "42501"),
      );
    }
  } finally {
    await Promise.allSettled([executor.end(), deniedExecutor.end()]);
  }
};

let started = false;
try {
  runSupabase(["start", "--exclude", excludedServices]);
  started = true;
  runSupabase(["db", "reset", "--local", "--no-seed"]);

  const { Client } = await import("pg");
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: "postgres",
    password: "postgres",
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "foundation-disposable-db-gate",
  });
  await client.connect();
  try {
    const serverVersion = String(await scalar(client, "show server_version"));
    if (!serverVersion.startsWith("17.")) {
      throw new Error(`Disposable DB must use PostgreSQL 17: ${serverVersion}`);
    }
    const requiredRelations = await client.query(`
      select c.relname, c.relkind
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'persistence_release_a_metric_events',
          'persistence_release_a_metrics_dashboard_24h',
          'persistence_release_a_metrics_dashboard_hourly_24h',
          'persistence_release_a_cleanup_dashboard_24h',
          'csp_violation_reports',
          'foundation_retention_run_audit'
        )
      order by c.relname
    `);
    if (requiredRelations.rowCount !== 6) {
      throw new Error("Disposable DB is missing a required table or view");
    }
    const requiredFunctions = await client.query(`
      select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'read_persistence_release_a_metrics',
          'read_csp_violation_aggregates',
          'read_csp_deployment_violation_aggregates',
          'retain_persistence_release_a_metrics',
          'retain_csp_violation_reports'
        )
      order by p.proname
    `);
    if (requiredFunctions.rowCount !== 5) {
      throw new Error("Disposable DB is missing a bounded operator function");
    }

    const legacyCspSourceSha = "fedcba9876543210fedcba9876543210fedcba98";
    await client.query(`
      alter table public.csp_violation_reports
        drop constraint csp_violation_reports_blocked_target_check;
      alter table public.csp_violation_reports
        add check (
          blocked_target in (
            'self',
            'data',
            'blob',
            'http',
            'https',
            'same-site',
            'cross-site',
            'inline',
            'eval',
            'unknown'
          )
        );
      insert into public.csp_violation_reports (
        schema_version,
        effective_directive,
        disposition,
        blocked_target,
        source_sha,
        provider_deployment_id
      ) values (
        1,
        'script-src',
        'report',
        'data',
        '${legacyCspSourceSha}',
        'deployment_disposable_csp_legacy'
      );
    `);
    const legacyBlockedTargetConstraint = await scalar(
      client,
      `select constraint_name
       from information_schema.check_constraints
       where constraint_schema = 'public'
         and constraint_name like 'csp_violation_reports_blocked_target_check%'`,
    );
    if (
      legacyBlockedTargetConstraint !==
      "csp_violation_reports_blocked_target_check"
    ) {
      throw new Error(
        `Legacy CSP constraint received an unexpected name: ${legacyBlockedTargetConstraint}`,
      );
    }

    await client.query(cspReportContractUpgradeSql);
    const upgradedLegacyTarget = await scalar(
      client,
      `select blocked_target
       from public.csp_violation_reports
       where provider_deployment_id = 'deployment_disposable_csp_legacy'`,
    );
    const upgradedConstraints = await client.query(`
      select conname, convalidated
      from pg_catalog.pg_constraint
      where conrelid = 'public.csp_violation_reports'::regclass
        and contype = 'c'
        and (
          pg_catalog.pg_get_constraintdef(oid) like '%effective_directive%'
          or pg_catalog.pg_get_constraintdef(oid) like '%blocked_target%'
        )
      order by conname
    `);
    const expectedUpgradedConstraintNames = [
      "csp_violation_reports_blocked_target_check",
      "csp_violation_reports_effective_directive_check",
    ];
    if (
      upgradedLegacyTarget !== "scheme" ||
      upgradedConstraints.rowCount !== 2 ||
      upgradedConstraints.rows.some(
        (constraint, index) =>
          constraint.conname !== expectedUpgradedConstraintNames[index],
      ) ||
      upgradedConstraints.rows.some(
        (constraint) => constraint.convalidated !== true,
      )
    ) {
      throw new Error("CSP report contract upgrade was not validated");
    }
    await client.query(
      `delete from public.csp_violation_reports
       where provider_deployment_id = 'deployment_disposable_csp_legacy'`,
    );

    await verifyApplicationObjectMetadata(client);
    await verifyServiceRoleAuthority(client);
    await verifyCspDormantAuthority(client);

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await client.query(`
        insert into public.persistence_release_a_metric_events (
          schema_version,
          event_version,
          event_name,
          outcome,
          duration_bucket,
          cleanup_mode,
          cleanup_reason,
          build_id,
          browser_family,
          app_mode,
          online
        ) values (
          1,
          1,
          'startup',
          'ready',
          'lt-250ms',
          null,
          null,
          '0123456789abcdef0123456789abcdef01234567',
          'chromium',
          'browser-tab',
          true
        )
      `);
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await assert.rejects(
        client.query(`
          insert into public.persistence_release_a_metric_events (
            schema_version,
            event_version,
            event_name,
            outcome,
            duration_bucket,
            cleanup_mode,
            cleanup_reason,
            build_id,
            browser_family,
            app_mode,
            online
          ) values (
            1,
            1,
            'startup',
            'ready',
            null,
            null,
            null,
            '0123456789abcdef0123456789abcdef01234567',
            'chromium',
            'browser-tab',
            true
          )
        `),
        /persistence_release_a_metric_duration_check/,
      );
    } finally {
      await client.query("rollback");
    }

    const cspSourceSha = "89abcdef0123456789abcdef0123456789abcdef";
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await client.query({
        text: `insert into public.csp_violation_reports (
          schema_version,
          effective_directive,
          disposition,
          blocked_target,
          source_sha,
          provider_deployment_id
        ) values
          (1, 'worker-src', 'report', 'scheme', $1, $2),
          (1, 'unknown', 'report', 'unknown', $1, $3)`,
        values: [
          cspSourceSha,
          "deployment_disposable_csp_1",
          "deployment_disposable_csp_2",
        ],
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await assert.rejects(
        client.query({
          text: `insert into public.csp_violation_reports (
            schema_version,
            effective_directive,
            disposition,
            blocked_target,
            source_sha,
            provider_deployment_id
          ) values (1, 'trusted-types', 'report', 'unknown', $1, $2)`,
          values: [cspSourceSha, "deployment_disposable_csp_invalid"],
        }),
        /csp_violation_reports_effective_directive_check/,
      );
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await assert.rejects(
        client.query("select blocked_target from public.csp_violation_reports"),
        /permission denied for table csp_violation_reports/,
      );
    } finally {
      await client.query("rollback");
    }

    const cspOperatorRole = "foundation_disposable_csp_operator";
    await client.query(`create role ${cspOperatorRole} nologin`);
    try {
      // PostgreSQL 17 gives CREATEROLE users SET FALSE on roles they create.
      await client.query(
        `grant ${cspOperatorRole} to current_user
          with admin false, inherit false, set true`,
      );
      await client.query(
        `grant execute on function public.read_csp_violation_aggregates(
          timestamptz,
          timestamptz,
          integer
        ) to ${cspOperatorRole}`,
      );
      await client.query(
        `grant execute on function public.read_csp_deployment_violation_aggregates(
          timestamptz,
          timestamptz,
          text,
          text,
          integer
        ) to ${cspOperatorRole}`,
      );
      await client.query("begin");
      try {
        await client.query(`set local role ${cspOperatorRole}`);
        await assert.rejects(
          client.query(
            "select blocked_target from public.csp_violation_reports",
          ),
          /permission denied for table csp_violation_reports/,
        );
      } finally {
        await client.query("rollback");
      }

      await client.query("begin");
      try {
        await client.query(`set local role ${cspOperatorRole}`);
        const cspAggregate = await client.query({
          text: `select *
            from public.read_csp_violation_aggregates(
              clock_timestamp() - interval '1 minute',
              clock_timestamp() + interval '1 minute',
              10
            )`,
        });
        const aggregatesByDirective = new Map(
          cspAggregate.rows.map((row) => [row.effective_directive, row]),
        );
        const workerAggregate = aggregatesByDirective.get("worker-src");
        const unknownAggregate = aggregatesByDirective.get("unknown");
        if (
          cspAggregate.rowCount !== 2 ||
          workerAggregate?.source_sha !== cspSourceSha ||
          workerAggregate?.disposition !== "report" ||
          workerAggregate?.blocked_target !== "scheme" ||
          Number(workerAggregate?.violation_count) !== 1 ||
          unknownAggregate?.source_sha !== cspSourceSha ||
          unknownAggregate?.disposition !== "report" ||
          unknownAggregate?.blocked_target !== "unknown" ||
          Number(unknownAggregate?.violation_count) !== 1
        ) {
          throw new Error("Disposable DB CSP operator aggregate differs");
        }
        const deploymentAggregate = await client.query({
          text: `select *
            from public.read_csp_deployment_violation_aggregates(
              clock_timestamp() - interval '1 minute',
              clock_timestamp() + interval '1 minute',
              $1,
              $2,
              10
            )`,
          values: [cspSourceSha, "deployment_disposable_csp_1"],
        });
        if (
          deploymentAggregate.rowCount !== 1 ||
          deploymentAggregate.rows[0].effective_directive !== "worker-src" ||
          Number(deploymentAggregate.rows[0].violation_count) !== 1
        ) {
          throw new Error("Disposable DB deployment CSP aggregate differs");
        }
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query(
        `revoke execute on function public.read_csp_violation_aggregates(
          timestamptz,
          timestamptz,
          integer
        ) from ${cspOperatorRole}`,
      );
      await client.query(
        `revoke execute on function public.read_csp_deployment_violation_aggregates(
          timestamptz,
          timestamptz,
          text,
          text,
          integer
        ) from ${cspOperatorRole}`,
      );
      await client.query(`drop role ${cspOperatorRole}`);
    }

    const retention = await client.query(
      "select * from public.retain_persistence_release_a_metrics(true, 10, 1)",
    );
    if (
      retention.rowCount !== 1 ||
      retention.rows[0].dry_run !== true ||
      Number(retention.rows[0].affected_rows) !== 0
    ) {
      throw new Error("Disposable DB retention dry-run differs");
    }
    const cronJobs = Number(
      await scalar(
        client,
        `select count(*) from cron.job
         where jobname = 'event-shopping-planner-foundation-retention-v1'`,
      ),
    );
    if (cronJobs !== 1) {
      throw new Error(
        "Disposable DB retention schedule is missing or duplicated",
      );
    }
    await verifyFoundationDatabaseRoles({ Client, administrator: client });
    await verifyReleaseStateControlStore({ Client, administrator: client });
  } finally {
    await client.end();
  }
  process.stdout.write(
    "PASS disposable PostgreSQL 17 application/control migrations, observer/backup readers, CAS, privileges, immutability, retention, and cron\n",
  );
} finally {
  if (started) {
    const stopped = runSupabase(["stop", "--no-backup"], {
      allowFailure: true,
    });
    if (stopped.status !== 0) {
      process.stderr.write(
        `WARN disposable Supabase cleanup failed: ${stopped.stderr}\n`,
      );
      process.exitCode = 1;
    }
  }
}
