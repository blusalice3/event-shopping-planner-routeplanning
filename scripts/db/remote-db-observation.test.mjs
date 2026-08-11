import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  parseRemoteDbObservationArguments,
  runRemoteDbObservationCli,
} from "./collect-remote-db-observation.mjs";
import {
  REMOTE_DB_OBSERVATION_KEYS,
  assertRemoteDbObservation,
  assertRemoteDbObservationAuthority,
  collectRemoteDbObservation,
} from "./remote-db-observation.mjs";
import {
  REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  putRemoteDbObservationAuthority,
  putRemoteDbObservationOidcAuthority,
  putRemoteDbObservationProductionAuthority,
  putRemoteDbProviderObservationAuthority,
  putReviewedRemoteDbObservationProductionAuthority,
  readRemoteDbObservationProductionAuthority,
  readReviewedRemoteDbObservationProductionAuthority,
  readStoredRemoteDbObservationAuthority,
} from "./remote-db-observation-authority.mjs";
import { VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE } from "../provider/collect-vercel-observation.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  parseProtectedRemoteDbObservationArguments,
  runProtectedRemoteDbObservationCli,
} from "./produce-remote-db-observation.mjs";

const NOW = Date.parse("2026-08-09T04:05:06.000Z");
const OBSERVER_CA = "observer-secret-ca";
const MIGRATION_BYTES = Object.freeze({
  "20260803000000_persistence_release_a_metrics.sql": Buffer.from(
    "baseline migration fixture\n",
    "utf8",
  ),
  "20260805000000_persistence_release_a_hardening.sql": Buffer.from(
    "hardening migration fixture\n",
    "utf8",
  ),
  "20260808000000_csp_report_contract.sql": Buffer.from(
    "CSP migration fixture\n",
    "utf8",
  ),
  "20260809000000_csp_report_deployment_aggregate.sql": Buffer.from(
    "CSP deployment aggregate fixture\n",
    "utf8",
  ),
  "20260810000000_foundation_application_observer.sql": Buffer.from(
    "application observer fixture\n",
    "utf8",
  ),
  "20260810010000_foundation_backup_integrity.sql": Buffer.from(
    "backup integrity fixture\n",
    "utf8",
  ),
});
const MIGRATION_CHECKSUMS = Object.freeze(
  Object.fromEntries(
    Object.entries(MIGRATION_BYTES).map(([name, bytes]) => [
      name,
      sha256Bytes(bytes),
    ]),
  ),
);
const MIGRATION_HISTORY = Object.freeze([
  {
    version: "20260803000000",
    migrationName: "persistence_release_a_metrics",
    statementCount: 17,
    statementsSha256: "1".repeat(64),
  },
  {
    version: "20260805000000",
    migrationName: "persistence_release_a_hardening",
    statementCount: 35,
    statementsSha256: "2".repeat(64),
  },
  {
    version: "20260808000000",
    migrationName: "csp_report_contract",
    statementCount: 10,
    statementsSha256: "3".repeat(64),
  },
  {
    version: "20260809000000",
    migrationName: "csp_report_deployment_aggregate",
    statementCount: 6,
    statementsSha256: "4".repeat(64),
  },
  {
    version: "20260810000000",
    migrationName: "foundation_application_observer",
    statementCount: 29,
    statementsSha256: "5".repeat(64),
  },
  {
    version: "20260810010000",
    migrationName: "foundation_backup_integrity",
    statementCount: 10,
    statementsSha256: "6".repeat(64),
  },
]);
const REQUIRED_TABLES = Object.freeze([
  "public.persistence_release_a_metric_events",
  "public.csp_violation_reports",
]);
const REQUIRED_FUNCTIONS = Object.freeze([
  "public.read_persistence_release_a_metrics",
  "public.retain_persistence_release_a_metrics",
  "public.read_csp_violation_aggregates",
  "public.read_csp_deployment_violation_aggregates",
  "public.retain_csp_violation_reports",
]);
const OBSERVER_MANAGED_SCHEMAS = Object.freeze([
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
const OBSERVER_MANAGED_RELATION_BASELINE = Object.freeze([
  {
    columnPrivileges: ["SELECT"],
    objectName: "cron.job",
    privileges: ["SELECT"],
  },
  {
    columnPrivileges: ["SELECT"],
    objectName: "cron.job_run_details",
    privileges: ["DELETE", "SELECT"],
  },
  {
    columnPrivileges: ["SELECT"],
    objectName: "extensions.pg_stat_statements",
    privileges: ["SELECT"],
  },
  {
    columnPrivileges: ["SELECT"],
    objectName: "extensions.pg_stat_statements_info",
    privileges: ["SELECT"],
  },
  {
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
  },
  {
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
  },
]);
const OBSERVER_MANAGED_SEQUENCE_BASELINE = Object.freeze([
  {
    objectName: "net.http_request_queue_id_seq",
    privileges: ["SELECT", "UPDATE", "USAGE"],
  },
]);
const OBSERVATION_AUTHORITY = Object.freeze({
  bindingStatus: "configured",
  postgresMajor: 17,
  databaseUrlEnvironmentName: "DB_COMPATIBILITY_OBSERVER_DATABASE_URL",
  databaseCaEnvironmentName: "DB_COMPATIBILITY_OBSERVER_CA_PEM",
  tlsMode: "verify-full",
  allowedHosts: ["db.example.test"],
  allowedDatabases: ["postgres"],
  allowedObserverRoles: ["foundation_db_observer"],
  serviceRole: "service_role",
  productionCaSha256: sha256Bytes(Buffer.from(OBSERVER_CA, "utf8")),
  connectTimeoutMilliseconds: 5_000,
  statementTimeoutMilliseconds: 15_000,
  maximumObservationAgeSeconds: 300,
  maximumFutureClockSkewSeconds: 30,
});
const CONTRACT = Object.freeze({
  schemaVersion: 1,
  contractStatus: "remote-verified",
  contractUri: "urn:event-shopping-planner:db-compatibility:test-v1",
  remote: {
    observationStatus: "observed",
    observationAuthority: OBSERVATION_AUTHORITY,
    requiredTables: REQUIRED_TABLES,
    requiredFunctions: REQUIRED_FUNCTIONS,
    observerManagedSchemas: OBSERVER_MANAGED_SCHEMAS,
    observerManagedSchemaUsage: ["net"],
    observerManagedRelationPrivilegeBaseline:
      OBSERVER_MANAGED_RELATION_BASELINE,
    observerManagedSequencePrivilegeBaseline:
      OBSERVER_MANAGED_SEQUENCE_BASELINE,
    migrationHistory: MIGRATION_HISTORY,
    migrationChecksums: MIGRATION_CHECKSUMS,
  },
  blockerCodes: [],
});
const BASE_PROVIDER_POLICY = JSON.parse(
  await readFile(
    new URL("../../config/provider-policy.json", import.meta.url),
    "utf8",
  ),
);
const providerWafRule = (id, route) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: route }] }],
  rateLimit: null,
});
const PROVIDER_POLICY = Object.freeze({
  ...BASE_PROVIDER_POLICY,
  bindingStatus: "configured",
  expectedTeamId: "team_test",
  expectedProjectId: "prj_test",
  ownedProductionDomains: ["example.test"],
  requiredEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  cspReportEnvironmentNames: [
    "CSP_REPORT_DB_SERVICE_ROLE_KEY",
    "CSP_REPORT_DB_URL",
  ],
  forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
  wafRules: {
    metricsRoute: providerWafRule(
      "rule_metrics",
      "/api/persistence-release-a-metrics",
    ),
    cspReportRoute: providerWafRule("rule_csp", "/api/csp-report"),
    googleSheetsCsvRoute: providerWafRule(
      "rule_sheets",
      "/api/google-sheets-csv",
    ),
  },
  logPolicy: {
    ...BASE_PROVIDER_POLICY.logPolicy,
    retentionDays: 1,
    retentionObservation: {
      kind: "vercel-runtime-plan-v1",
      observabilityPlus: false,
      drainId: null,
      jsonPointer: null,
    },
  },
  hstsPolicy: {
    minimumMaxAgeSeconds: 31_536_000,
    requireIncludeSubDomains: true,
    requirePreload: false,
  },
  blockerCodes: [],
});
const providerRequestUrl = (pathname, query = {}) => {
  const url = new URL(pathname, PROVIDER_POLICY.observationPolicy.apiBaseUrl);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, String(value));
  }
  url.searchParams.sort();
  return url.href;
};
const providerReceipt = (kind, requestUrl, { hsts = null } = {}) => {
  const value = {
    kind,
    method: "GET",
    requestUrl,
    status: 200,
    responseDate: new Date(NOW).toUTCString(),
    etag: null,
    contentType: kind.startsWith("hsts:") ? null : "application/json",
    strictTransportSecurity: hsts,
    bodySha256: "2".repeat(64),
  };
  return {
    ...value,
    responseSha256: sha256Json({
      status: value.status,
      responseDate: value.responseDate,
      etag: value.etag,
      contentType: value.contentType,
      strictTransportSecurity: value.strictTransportSecurity,
      bodySha256: value.bodySha256,
    }),
  };
};
const PROVIDER_OBSERVATION = Object.freeze({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: new Date(NOW).toISOString(),
  providerTeamId: "team_test",
  providerProjectId: "prj_test",
  productionEnvironmentName: "production",
  providerNodeFamily: "24.x",
  productionBranch: "main",
  autoAssignCustomProductionDomains: false,
  gitProductionAutoDeploy: false,
  gitPreviewAutoDeploy: false,
  gitIntegration: {
    connected: true,
    provider: "github",
    productionBranch: "main",
  },
  allowedPreviewBranches: [],
  ownedProductionDomains: ["example.test"],
  presentEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  rawRequestByteCeilings: PROVIDER_POLICY.rawRequestByteCeilings,
  wafRules: PROVIDER_POLICY.wafRules,
  logPolicy: PROVIDER_POLICY.logPolicy,
  logRetentionEvidence: {
    kind: "vercel-runtime-plan-v1",
    plan: "pro",
    activeLogDrainIds: ["drain_logs"],
    retentionDays: 1,
  },
  hstsOwner: "provider",
  hstsPolicy: PROVIDER_POLICY.hstsPolicy,
  hsts: [
    {
      domain: "example.test",
      maxAgeSeconds: 63_072_000,
      includeSubDomains: true,
      preload: false,
    },
  ],
  configurationEvidenceKinds: [
    ...PROVIDER_POLICY.requiredConfigurationEvidence,
  ].sort(),
  evidenceReceipts: [
    providerReceipt("team", providerRequestUrl("/v2/teams/team_test")),
    providerReceipt(
      "project",
      providerRequestUrl("/v9/projects/prj_test", { teamId: "team_test" }),
    ),
    providerReceipt(
      "domains",
      providerRequestUrl("/v9/projects/prj_test/domains", {
        teamId: "team_test",
        limit: 100,
        production: true,
      }),
    ),
    providerReceipt(
      "environment-presence",
      providerRequestUrl("/v10/projects/prj_test/env", {
        teamId: "team_test",
        decrypt: false,
      }),
    ),
    providerReceipt(
      "waf",
      providerRequestUrl("/v1/security/firewall/config/active", {
        projectId: "prj_test",
        teamId: "team_test",
      }),
    ),
    providerReceipt(
      "log-retention",
      providerRequestUrl("/v1/drains", {
        includeMetadata: true,
        projectId: "prj_test",
        teamId: "team_test",
      }),
    ),
    providerReceipt("hsts:example.test", "https://example.test/", {
      hsts: "max-age=63072000; includeSubDomains",
    }),
  ].sort((left, right) => left.kind.localeCompare(right.kind)),
});
const APPROVAL_POLICY = Object.freeze({
  bindingStatus: "configured",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  oidcAudience: "urn:event-shopping-planner:foundation-release-state",
  oidcClockSkewSeconds: 60,
  oidcMaxTokenAgeSeconds: 600,
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
  blockerCodes: [],
});
const oidcReceipt = ({ sourceSha, runId, runAttempt }) => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: APPROVAL_POLICY.trustedIssuer,
  audience: APPROVAL_POLICY.oidcAudience,
  subject: "repo:owner/repository:environment:foundation-release-state",
  tokenSha256: "3".repeat(64),
  signingKey: {
    kid: "fixture-key",
    jwkThumbprintSha256: "4".repeat(64),
  },
  claims: {
    repository: APPROVAL_POLICY.repository,
    workflowRef: APPROVAL_POLICY.workflowRef,
    workflowSha: sourceSha,
    environment: APPROVAL_POLICY.protectedEnvironment,
    runId,
    runAttempt,
    sourceSha,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    refProtected: true,
    jti: "remote-db-fixture",
    issuedAt: new Date(NOW - 60_000).toISOString(),
    notBefore: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 540_000).toISOString(),
  },
  verifiedAt: new Date(NOW).toISOString(),
});

const functionRow = ({
  definitionSha256,
  identityArguments,
  qualifiedName,
  result,
}) => ({
  configuration: ["search_path=pg_catalog, public"],
  definition_sha256: definitionSha256,
  function_language: "plpgsql",
  function_owner: "postgres",
  function_result: result,
  identity_arguments: identityArguments,
  leakproof: false,
  parallel: "u",
  qualified_name: qualifiedName,
  security_definer: true,
  strict: false,
  volatility: "v",
});
const FUNCTION_ROWS = Object.freeze([
  functionRow({
    definitionSha256:
      "d840ff64e316a5e0726e3168e7c44e4c8a1bde7229521a01f3fb9298d9150d9a",
    identityArguments:
      "timestamp with time zone, timestamp with time zone, text, text, integer",
    qualifiedName: "public.read_csp_deployment_violation_aggregates",
    result:
      "TABLE(effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
  }),
  functionRow({
    definitionSha256:
      "0bd18e5377c32f27fa8a72c7c7b2d4dbc497cd076c2c7c28584bfc02497fb712",
    identityArguments:
      "timestamp with time zone, timestamp with time zone, integer",
    qualifiedName: "public.read_csp_violation_aggregates",
    result:
      "TABLE(source_sha text, effective_directive text, disposition text, blocked_target text, violation_count bigint, first_received_at timestamp with time zone, last_received_at timestamp with time zone)",
  }),
  functionRow({
    definitionSha256:
      "a26aae5d280b49cf403721cbcd7eff85c6b78e258301dcd69df8925d40e6cb63",
    identityArguments:
      "timestamp with time zone, timestamp with time zone, integer",
    qualifiedName: "public.read_persistence_release_a_metrics",
    result:
      "TABLE(received_at timestamp with time zone, build_id text, browser_family text, app_mode text, online boolean, event_name text, outcome text, duration_bucket text, cleanup_mode text, cleanup_reason text)",
  }),
  functionRow({
    definitionSha256:
      "7bfbffd5e152d0fe6fce71e5b3a6390a84a0578143aa3e6f0d68060ea603d6a9",
    identityArguments: "boolean, integer, integer",
    qualifiedName: "public.retain_csp_violation_reports",
    result:
      "TABLE(cutoff timestamp with time zone, affected_rows bigint, batch_count integer, dry_run boolean)",
  }),
  functionRow({
    definitionSha256:
      "a2518f229ae4ac700702713bab16790c966f78a61b4d4b74b2722ecea8bf9cc2",
    identityArguments: "boolean, integer, integer",
    qualifiedName: "public.retain_persistence_release_a_metrics",
    result:
      "TABLE(cutoff timestamp with time zone, affected_rows bigint, batch_count integer, dry_run boolean)",
  }),
]);

const observerExecutableFunctionRows = Object.freeze([
  {
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
  },
  {
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
  },
  {
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
  },
]);

const migrationHistoryPrivilegeRow = Object.freeze({
  object_name: "supabase_migrations.schema_migrations",
  observer_column_insert: false,
  observer_column_insert_grantable: false,
  observer_column_references: false,
  observer_column_references_grantable: false,
  observer_column_select: true,
  observer_column_select_grantable: false,
  observer_column_update: false,
  observer_column_update_grantable: false,
  observer_delete: false,
  observer_delete_grantable: false,
  observer_insert: false,
  observer_insert_grantable: false,
  observer_maintain: false,
  observer_maintain_grantable: false,
  observer_references: false,
  observer_references_grantable: false,
  observer_select: true,
  observer_select_grantable: false,
  observer_trigger: false,
  observer_trigger_grantable: false,
  observer_truncate: false,
  observer_truncate_grantable: false,
  observer_update: false,
  observer_update_grantable: false,
});
const observerManagedRelationRow = ({
  columnPrivileges,
  objectName,
  privileges,
}) => ({
  ...migrationHistoryPrivilegeRow,
  object_name: objectName,
  observer_column_insert: columnPrivileges.includes("INSERT"),
  observer_column_references: columnPrivileges.includes("REFERENCES"),
  observer_column_select: columnPrivileges.includes("SELECT"),
  observer_column_update: columnPrivileges.includes("UPDATE"),
  observer_delete: privileges.includes("DELETE"),
  observer_insert: privileges.includes("INSERT"),
  observer_maintain: privileges.includes("MAINTAIN"),
  observer_references: privileges.includes("REFERENCES"),
  observer_select: privileges.includes("SELECT"),
  observer_trigger: privileges.includes("TRIGGER"),
  observer_truncate: privileges.includes("TRUNCATE"),
  observer_update: privileges.includes("UPDATE"),
});
const observerManagedSequenceRow = ({ objectName, privileges }) => ({
  object_name: objectName,
  observer_select: privileges.includes("SELECT"),
  observer_select_grantable: false,
  observer_update: privileges.includes("UPDATE"),
  observer_update_grantable: false,
  observer_usage: privileges.includes("USAGE"),
  observer_usage_grantable: false,
});

const requiredRelationRows = Object.freeze([
  {
    qualified_name: "public.csp_violation_reports",
    relkind: "r",
    row_security: true,
    force_row_security: false,
    persistence: "p",
    replica_identity: "d",
    relation_owner: "postgres",
  },
  {
    qualified_name: "public.persistence_release_a_metric_events",
    relkind: "r",
    row_security: true,
    force_row_security: false,
    persistence: "p",
    replica_identity: "d",
    relation_owner: "postgres",
  },
]);
const columnRow = (
  objectName,
  ordinal,
  dataType,
  notNull,
  defaultExpression = null,
  identity = "",
) => ({
  object_name: objectName,
  ordinal,
  data_type: dataType,
  not_null: notNull,
  identity,
  generated: "",
  default_expression: defaultExpression,
});
const requiredColumnRows = Object.freeze([
  columnRow("public.csp_violation_reports.id", 1, "bigint", true, null, "a"),
  columnRow(
    "public.csp_violation_reports.received_at",
    2,
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ),
  columnRow(
    "public.csp_violation_reports.schema_version",
    3,
    "smallint",
    true,
    "1",
  ),
  columnRow(
    "public.csp_violation_reports.effective_directive",
    4,
    "text",
    true,
  ),
  columnRow("public.csp_violation_reports.disposition", 5, "text", true),
  columnRow("public.csp_violation_reports.blocked_target", 6, "text", true),
  columnRow("public.csp_violation_reports.source_sha", 7, "text", true),
  columnRow(
    "public.csp_violation_reports.provider_deployment_id",
    8,
    "text",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.id",
    1,
    "bigint",
    true,
    null,
    "a",
  ),
  columnRow(
    "public.persistence_release_a_metric_events.received_at",
    2,
    "timestamp with time zone",
    true,
    "now()",
  ),
  columnRow(
    "public.persistence_release_a_metric_events.schema_version",
    3,
    "smallint",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.event_version",
    4,
    "smallint",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.event_name",
    5,
    "text",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.outcome",
    6,
    "text",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.duration_bucket",
    7,
    "text",
    false,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.cleanup_mode",
    8,
    "text",
    false,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.cleanup_reason",
    9,
    "text",
    false,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.build_id",
    10,
    "text",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.browser_family",
    11,
    "text",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.app_mode",
    12,
    "text",
    true,
  ),
  columnRow(
    "public.persistence_release_a_metric_events.online",
    13,
    "boolean",
    true,
  ),
]);
const constraintRow = (objectName, constraintName, constraintType, sha256) => ({
  object_name: objectName,
  constraint_name: constraintName,
  constraint_type: constraintType,
  validated: true,
  definition_sha256: sha256,
});
const requiredConstraintRows = Object.freeze([
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_blocked_target_check",
    "c",
    "0fa27a8b1088a469706d420cf2c1d682994760d7cfa02a5dc2048457e068f083",
  ),
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_disposition_check",
    "c",
    "9e74a5ed76caa073ffd8aa01c9672e1f7d02db71b40e72e7d01a9dd5fc99aa5c",
  ),
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_effective_directive_check",
    "c",
    "318baa76c9070355215fd667e454cf88c6b60a8408330994c5f1f73578dffe39",
  ),
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_pkey",
    "p",
    "8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5",
  ),
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_provider_deployment_id_check",
    "c",
    "cba5a772e493925359436258e19adf9270cab5ac2010eb61abb0846a59a8c964",
  ),
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_schema_version_check",
    "c",
    "99dafe6cdfeabc897fc0d1ab5cb666d4cb549e9e2e1e627c33b75a55c29a39a2",
  ),
  constraintRow(
    "public.csp_violation_reports",
    "csp_violation_reports_source_sha_check",
    "c",
    "f24874f633de2e4fe0ff42b4012e67694ecd8fd28eaf00bf33c86c0808bb9509",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_app_mode_check",
    "c",
    "a78f4a8c56a95d04dc719005f78629bded832e47674f052296a558fdaf147b23",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_browser_family_check",
    "c",
    "7f71ba486f64af1d5057b0acaecd9548175803bbcfcabfa04d9a1d40ecf96507",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_build_id_check",
    "c",
    "9d2f4350ee087797fa77ff965dcfa7f369a502c6e23af55f6eb3aa1111731eb3",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_cleanup_mode_check",
    "c",
    "d5d9fffb4c1d2263ada5ee848aa86d2a20429280f11ff15fa49be20c0e8354a2",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_cleanup_reason_check",
    "c",
    "c9dc06b7d5db54b1a52e419ee153a356021a87d1501f174e039d293c1a156e3d",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_duration_check",
    "c",
    "ca4f1f49c835b90d3d6c2931469aecb8dfc0532c3d74b44418746a3e7ee8aea5",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_event_version_check",
    "c",
    "b373ca94512ba2d708d90360e7bcaca55cd523c78e33a0f451a5d384562d5f53",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_events_pkey",
    "p",
    "8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_name_check",
    "c",
    "beb86dfaf28d75363e14bfa51d54c97e4239e8554a3da0ef87911289cfb1a373",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_outcome_check",
    "c",
    "ce8eeb09a2d79ab4c76011631dfc81427e1a7dc05b8f809463230d21ce3bc0c2",
  ),
  constraintRow(
    "public.persistence_release_a_metric_events",
    "persistence_release_a_metric_schema_version_check",
    "c",
    "99dafe6cdfeabc897fc0d1ab5cb666d4cb549e9e2e1e627c33b75a55c29a39a2",
  ),
]);
const serviceRoleTableRow = (objectName) => ({
  object_name: objectName,
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
const serviceRoleSequenceRow = (objectName) => ({
  object_name: objectName,
  identity_bound: true,
  service_usage: true,
  service_select: false,
  service_update: false,
  service_usage_grantable: false,
  service_select_grantable: false,
  service_update_grantable: false,
});

const baseResponses = () => ({
  "foundation-remote-db-observer-identity-v3": [
    {
      observer_role: "foundation_db_observer",
      session_role: "foundation_db_observer",
      read_only: "on",
      server_version_num: "170003",
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolinherit: false,
      database_connect: true,
      database_connect_grantable: false,
      database_create: false,
      database_create_grantable: false,
      database_temporary: true,
      database_temporary_grantable: false,
      service_role_member: false,
    },
  ],
  "foundation-remote-db-observer-memberships-v2": [],
  "foundation-remote-db-observer-owned-objects-v2": [
    { owned_object_count: "0" },
  ],
  "foundation-remote-db-observer-relation-privileges-v3": [
    ...OBSERVER_MANAGED_RELATION_BASELINE.map(observerManagedRelationRow),
    { ...migrationHistoryPrivilegeRow },
  ],
  "foundation-remote-db-observer-executable-functions-v3":
    observerExecutableFunctionRows.map((row) => ({ ...row })),
  "foundation-remote-db-observer-managed-function-acl-v3": [],
  "foundation-remote-db-observer-managed-object-acl-v1": [],
  "foundation-remote-db-observer-sequence-privileges-v3":
    OBSERVER_MANAGED_SEQUENCE_BASELINE.map(observerManagedSequenceRow),
  "foundation-remote-db-observer-schema-privileges-v3": [
    {
      object_name: "net",
      observer_usage: true,
      observer_usage_grantable: false,
      observer_create: false,
      observer_create_grantable: false,
    },
    {
      object_name: "public",
      observer_usage: true,
      observer_usage_grantable: false,
      observer_create: false,
      observer_create_grantable: false,
    },
    {
      object_name: "supabase_migrations",
      observer_usage: true,
      observer_usage_grantable: false,
      observer_create: false,
      observer_create_grantable: false,
    },
  ],
  "foundation-remote-db-observer-database-create-privileges-v3": [],
  "foundation-remote-db-migrations-v2": MIGRATION_HISTORY.map((entry) => ({
    version: entry.version,
    migration_name: entry.migrationName,
    statement_count: entry.statementCount,
    statements_sha256: entry.statementsSha256,
  })),
  "foundation-remote-db-relations-v2": requiredRelationRows.map((row) => ({
    ...row,
  })),
  "foundation-remote-db-columns-v1": requiredColumnRows.map((row) => ({
    ...row,
  })),
  "foundation-remote-db-constraints-v2": requiredConstraintRows.map((row) => ({
    ...row,
  })),
  "foundation-remote-db-policies-v1": [],
  "foundation-remote-db-triggers-v1": [],
  "foundation-remote-db-functions-v2": FUNCTION_ROWS.map((row) => ({
    ...row,
  })),
  "foundation-remote-db-table-privileges-v2": [
    serviceRoleTableRow("public.csp_violation_reports"),
    serviceRoleTableRow("public.persistence_release_a_metric_events"),
  ],
  "foundation-remote-db-service-role-sequence-privileges-v1": [
    serviceRoleSequenceRow("public.csp_violation_reports_id_seq"),
    serviceRoleSequenceRow("public.persistence_release_a_metric_events_id_seq"),
  ],
  "foundation-remote-db-csp-dormant-authority-v1": [],
  "foundation-remote-db-function-privileges-v2": FUNCTION_ROWS.map((row) => ({
    function_signature: `${row.qualified_name}(${row.identity_arguments})`,
    service_execute: false,
    service_execute_grantable: false,
    observer_execute: row.qualified_name.includes(".read_"),
    observer_execute_grantable: false,
  })),
});

const createFakeClient = ({ reverseRows = false, mutate } = {}) => {
  const responses = baseResponses();
  mutate?.(responses);
  const calls = [];
  return {
    calls,
    connected: false,
    ended: false,
    async connect() {
      this.connected = true;
    },
    async end() {
      this.ended = true;
    },
    async query(statement) {
      const text = typeof statement === "string" ? statement : statement.text;
      calls.push({
        name: typeof statement === "string" ? null : statement.name,
        text,
        values: typeof statement === "string" ? undefined : statement.values,
      });
      if (typeof statement === "string") {
        const command = statement.trim().toLowerCase();
        if (
          command.startsWith("begin transaction") ||
          command === "commit" ||
          command === "rollback"
        ) {
          return { rows: [], rowCount: null };
        }
        throw new Error(`Unexpected transaction command: ${command}`);
      }
      if (!Object.hasOwn(responses, statement.name)) {
        throw new Error(`Unexpected prepared query: ${statement.name}`);
      }
      const rows = structuredClone(responses[statement.name]);
      if (reverseRows) rows.reverse();
      return { rows, rowCount: rows.length };
    },
  };
};

const validEvidence = () => ({
  schemaVersion: 1,
  contractFingerprint: sha256Json(CONTRACT),
  migrationChecksums: { ...MIGRATION_CHECKSUMS },
  migrationsApplied: true,
  serviceRoleRawSelect: false,
  serviceRoleRawInsert: true,
  cspServiceRoleRawSelect: false,
  cspServiceRoleRawInsert: true,
  cspObjectsPresent: true,
  operatorBoundedFunctionOnly: true,
  cspApplicationCredentialReachable: false,
  requiredTables: [...REQUIRED_TABLES],
  requiredFunctions: [...REQUIRED_FUNCTIONS],
  observedAt: new Date(NOW).toISOString(),
});

test("remote DB observation authority is closed and explicitly configurable", () => {
  assert.equal(
    assertRemoteDbObservationAuthority(OBSERVATION_AUTHORITY, {
      requireConfigured: true,
    }),
    OBSERVATION_AUTHORITY,
  );
  assert.throws(
    () =>
      assertRemoteDbObservationAuthority({
        ...OBSERVATION_AUTHORITY,
        unreviewedProperty: true,
      }),
    /authority is invalid/u,
  );

  const unconfiguredAuthority = {
    ...OBSERVATION_AUTHORITY,
    bindingStatus: "unconfigured",
    allowedHosts: [],
    allowedDatabases: [],
    allowedObserverRoles: [],
    productionCaSha256: null,
  };
  assert.equal(
    assertRemoteDbObservationAuthority(unconfiguredAuthority),
    unconfiguredAuthority,
  );
  assert.throws(
    () =>
      assertRemoteDbObservationAuthority(unconfiguredAuthority, {
        requireConfigured: true,
      }),
    /authority is not configured/u,
  );
  assert.throws(
    () =>
      assertRemoteDbObservationAuthority({
        ...unconfiguredAuthority,
        allowedHosts: ["db.example.test"],
      }),
    /authority is invalid/u,
  );
});

test("shared remote DB assertion closes the existing 14-key evidence shape", () => {
  const evidence = validEvidence();
  assert.deepEqual(
    Object.keys(evidence).sort(),
    [...REMOTE_DB_OBSERVATION_KEYS].sort(),
  );
  assert.equal(
    assertRemoteDbObservation(evidence, {
      contract: CONTRACT,
      migrationChecksums: MIGRATION_CHECKSUMS,
      now: NOW,
    }),
    evidence,
  );
  assert.throws(
    () =>
      assertRemoteDbObservation(
        { ...evidence, unreviewedProperty: true },
        {
          contract: CONTRACT,
          migrationChecksums: MIGRATION_CHECKSUMS,
          now: NOW,
        },
      ),
    /does not match the compatibility contract/u,
  );
  assert.throws(
    () =>
      assertRemoteDbObservation(
        { ...evidence, serviceRoleRawSelect: true },
        {
          contract: CONTRACT,
          migrationChecksums: MIGRATION_CHECKSUMS,
          now: NOW,
        },
      ),
    /does not match the compatibility contract/u,
  );
  assert.throws(
    () =>
      assertRemoteDbObservation(
        {
          ...evidence,
          requiredTables: [
            ...evidence.requiredTables,
            evidence.requiredTables[0],
          ],
        },
        {
          contract: CONTRACT,
          migrationChecksums: MIGRATION_CHECKSUMS,
          now: NOW,
        },
      ),
    /does not match the compatibility contract/u,
  );
  for (const observedAt of [
    new Date(
      NOW - (OBSERVATION_AUTHORITY.maximumObservationAgeSeconds + 1) * 1_000,
    ).toISOString(),
    new Date(
      NOW + (OBSERVATION_AUTHORITY.maximumFutureClockSkewSeconds + 1) * 1_000,
    ).toISOString(),
  ]) {
    assert.throws(
      () =>
        assertRemoteDbObservation(
          { ...evidence, observedAt },
          {
            contract: CONTRACT,
            migrationChecksums: MIGRATION_CHECKSUMS,
            now: NOW,
          },
        ),
      /does not match the compatibility contract/u,
    );
  }
});

test("collector uses a read-only repeatable snapshot and emits deterministic evidence", async () => {
  const firstClient = createFakeClient();
  const secondClient = createFakeClient({ reverseRows: true });
  const options = {
    contract: CONTRACT,
    migrationChecksums: MIGRATION_CHECKSUMS,
    providerPolicy: PROVIDER_POLICY,
    providerObservation: PROVIDER_OBSERVATION,
    expectedObserverRole: "foundation_db_observer",
    now: NOW,
  };
  const first = await collectRemoteDbObservation({
    ...options,
    client: firstClient,
  });
  const second = await collectRemoteDbObservation({
    ...options,
    client: secondClient,
  });
  assert.deepEqual(canonicalJsonBytes(first), canonicalJsonBytes(second));
  assert.deepEqual(first, {
    ...validEvidence(),
    requiredTables: [...REQUIRED_TABLES].sort(),
    requiredFunctions: [...REQUIRED_FUNCTIONS].sort(),
  });
  assert.match(
    firstClient.calls[0].text,
    /^begin transaction isolation level repeatable read read only$/u,
  );
  assert.equal(firstClient.calls.at(-1).text, "commit");
  for (const call of firstClient.calls.filter(({ name }) => name !== null)) {
    assert.match(call.text.trimStart(), /^(?:select|with)\b/u);
  }
  for (const queryName of [
    "foundation-remote-db-observer-identity-v3",
    "foundation-remote-db-table-privileges-v2",
    "foundation-remote-db-function-privileges-v2",
  ]) {
    assert.equal(
      firstClient.calls
        .find(({ name }) => name === queryName)
        .values.includes(OBSERVATION_AUTHORITY.serviceRole),
      true,
    );
  }
});

test("collector rolls back on missing schema, elevated observer, or CSP credential reachability", async () => {
  const cases = [
    {
      mutate(responses) {
        responses["foundation-remote-db-relations-v2"].pop();
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /relation row set is incomplete/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-migrations-v2"].push({
          migration_name: "unreviewed_future",
          statement_count: 1,
          statements_sha256: "f".repeat(64),
          version: "20260811000000",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact migration history differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-relations-v2"][0].relation_owner =
          "unexpected_owner";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /required relation contract differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-columns-v1"][0].data_type = "text";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /required column contract differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-constraints-v2"][0].definition_sha256 =
          "f".repeat(64);
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /required constraint contract differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-policies-v1"].push({
          policy_name: "permissive_insert",
          permissive: true,
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /policy or trigger set differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-triggers-v1"].push({
          trigger_name: "unreviewed_trigger",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /policy or trigger set differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-functions-v2"][3].definition_sha256 =
          "f".repeat(64);
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /required function definition differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-table-privileges-v2"
        ][0].service_insert = false;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /service role table authority differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-table-privileges-v2"
        ][0].service_delete = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /service role table authority differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-table-privileges-v2"
        ][0].service_maintain = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /service role table authority differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-table-privileges-v2"
        ][0].service_insert_grantable = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /service role table authority differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-service-role-sequence-privileges-v1"
        ][0].service_usage = false;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /service role sequence authority differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-csp-dormant-authority-v1"].push({
          grantable: false,
          object_name: "public.csp_violation_reports",
          object_type: "table",
          principal: "anon",
          privilege: "INSERT",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /CSP dormant principal authority differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-csp-dormant-authority-v1"].push({
          grantable: false,
          object_name:
            "public.read_csp_violation_aggregates(timestamp with time zone, timestamp with time zone, integer)",
          object_type: "routine",
          principal: "PUBLIC",
          privilege: "EXECUTE",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /CSP dormant principal authority differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-csp-dormant-authority-v1"].push({
          grantable: false,
          object_name: "public.csp_violation_reports",
          object_type: "column",
          principal: "authenticated",
          privilege: "INSERT",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /CSP dormant principal authority differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-function-privileges-v2"
        ][1].service_execute = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /routine privilege authority differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-function-privileges-v2"
        ][1].service_execute_grantable = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /routine privilege authority differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-identity-v3"][0].rolsuper =
          true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-memberships-v2"].push({
          role: "unapproved_set_role",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /memberships are not empty/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-owned-objects-v2"
        ][0].owned_object_count = "1";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /ownership is not empty/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-relation-privileges-v3"
        ].splice(0, 1);
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-relation-privileges-v3"
        ][0].observer_delete = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-managed-object-acl-v1"].push({
          grantable: false,
          object_name: "net.http_request_queue",
          object_type: "relation",
          privilege: "SELECT",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-sequence-privileges-v3"].push({
          object_name: "public.unapproved_sequence",
          observer_select: true,
          observer_select_grantable: false,
          observer_update: false,
          observer_update_grantable: false,
          observer_usage: true,
          observer_usage_grantable: false,
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-schema-privileges-v3"
        ][0].observer_create = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-identity-v3"
        ][0].database_create = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-executable-functions-v3"].push(
          {
            ...observerExecutableFunctionRows[0],
            definition_sha256: "f".repeat(64),
            function_signature: "public.unapproved_function()",
          },
        );
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-relation-privileges-v3"].push({
          ...migrationHistoryPrivilegeRow,
          object_name: "public.unrelated_table",
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-relation-privileges-v3"
        ][0].observer_select_grantable = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-relation-privileges-v3"
        ][0].observer_column_select_grantable = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-relation-privileges-v3"].push({
          ...migrationHistoryPrivilegeRow,
          object_name: "public.column_only_probe",
          observer_column_select: true,
          observer_select: false,
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-relation-privileges-v3"].push({
          ...migrationHistoryPrivilegeRow,
          object_name: "storage.maintain_probe",
          observer_column_select: false,
          observer_maintain: true,
          observer_select: false,
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-executable-functions-v3"
        ][0].definition_sha256 = "f".repeat(64);
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-executable-functions-v3"
        ][0].observer_execute_grantable = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-managed-function-acl-v3"].push(
          {
            function_signature: "auth.direct_observer_probe()",
            observer_execute_grantable: false,
          },
        );
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-schema-privileges-v3"].push({
          object_name: "private_application",
          observer_create: false,
          observer_create_grantable: false,
          observer_usage: true,
          observer_usage_grantable: false,
        });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-database-create-privileges-v3"
        ].push({ database_name: "unapproved_database" });
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /exact authorization differs/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-identity-v3"
        ][0].database_temporary_grantable = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-table-privileges-v2"
        ][1].service_column_select = true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /service role table authority differs/u,
    },
    {
      mutate(responses) {
        const identity =
          responses["foundation-remote-db-observer-identity-v3"][0];
        identity.observer_role = "wrong_observer";
        identity.session_role = "wrong_observer";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-identity-v3"
        ][0].server_version_num = "160010";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      providerObservation: {
        presentEnvironmentNames: ["CSP_REPORT_DB_URL"],
      },
      pattern: /does not match the compatibility contract/u,
    },
    {
      contract: {
        ...CONTRACT,
        remote: {
          ...CONTRACT.remote,
          observerManagedRelationPrivilegeBaseline: [
            ...OBSERVER_MANAGED_RELATION_BASELINE,
            {
              columnPrivileges: ["SELECT"],
              objectName: "storage.unreviewed_platform_object",
              privileges: ["SELECT"],
            },
          ],
        },
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observation authority is invalid/u,
      beforeTransaction: true,
    },
  ];
  for (const fixture of cases) {
    const client = createFakeClient({ mutate: fixture.mutate });
    await assert.rejects(
      collectRemoteDbObservation({
        client,
        contract: fixture.contract ?? CONTRACT,
        migrationChecksums: MIGRATION_CHECKSUMS,
        providerPolicy: PROVIDER_POLICY,
        providerObservation: fixture.providerObservation,
        expectedObserverRole: "foundation_db_observer",
        now: NOW,
      }),
      fixture.pattern,
    );
    if (fixture.beforeTransaction) {
      assert.deepEqual(client.calls, []);
    } else {
      assert.equal(client.calls.at(-1).text, "rollback");
      assert.equal(
        client.calls.some(({ text }) => text === "commit"),
        false,
      );
    }
  }
});

test("collector CLI binds TLS credentials, writes canonical bytes with wx, and logs no secret", async () => {
  const client = createFakeClient();
  const writes = [];
  const output = [];
  const observerPassword = "observer-secret-value";
  let clientOptions;
  const result = await runRemoteDbObservationCli(
    {
      argv: [
        "--provider-observation",
        "provider-observation.json",
        "--output",
        "remote-db-observation.json",
      ],
      env: {
        DB_COMPATIBILITY_OBSERVER_DATABASE_URL:
          `postgresql://foundation_db_observer:${observerPassword}` +
          "@db.example.test:5432/postgres?sslmode=verify-full",
        DB_COMPATIBILITY_OBSERVER_CA_PEM: OBSERVER_CA,
      },
      cwd: "C:\\fixture",
      stdout: { write: (value) => output.push(value) },
    },
    {
      loadJson: async (filePath) => {
        const name = pathBasename(filePath);
        if (name === "db-compatibility-contract.json") return CONTRACT;
        if (name === "provider-policy.json") return PROVIDER_POLICY;
        if (name === "provider-observation.json") return PROVIDER_OBSERVATION;
        throw new Error(`Unexpected JSON path: ${name}`);
      },
      readFileImpl: async (filePath) => {
        const bytes = MIGRATION_BYTES[pathBasename(filePath)];
        if (!bytes) throw new Error("Unexpected migration path");
        return bytes;
      },
      writeFileImpl: async (filePath, bytes, options) => {
        writes.push({ filePath, bytes: Buffer.from(bytes), options });
      },
      createClient: async (options) => {
        clientOptions = options;
        return client;
      },
      validateProviderObservation: () => {},
      now: NOW,
    },
  );
  assert.equal(client.connected, true);
  assert.equal(client.ended, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, "wx");
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(writes[0].bytes, canonicalJsonBytes(result.evidence));
  assert.equal(clientOptions.ssl.ca, OBSERVER_CA);
  assert.equal(clientOptions.ssl.rejectUnauthorized, true);
  assert.equal(clientOptions.connectionString.includes("sslmode"), false);
  assert.equal(
    clientOptions.connectionTimeoutMillis,
    OBSERVATION_AUTHORITY.connectTimeoutMilliseconds,
  );
  assert.equal(
    clientOptions.statement_timeout,
    OBSERVATION_AUTHORITY.statementTimeoutMilliseconds,
  );
  const publicOutput = `${output.join("")}\n${writes[0].bytes.toString("utf8")}`;
  assert.equal(publicOutput.includes(observerPassword), false);
  assert.equal(publicOutput.includes(OBSERVER_CA), false);
  assert.match(
    output.join(""),
    /^PASS wrote remote DB observation [0-9a-f]{64}\n$/u,
  );
});

test("collector CLI rejects host, database, role, and CA outside configured authority", async () => {
  const validUrl =
    "postgresql://foundation_db_observer:secret" +
    "@db.example.test:5432/postgres?sslmode=verify-full";
  const fixtures = [
    {
      url: validUrl.replace("db.example.test", "wrong.example.test"),
      ca: OBSERVER_CA,
    },
    {
      url: validUrl.replace("/postgres?", "/wrong_database?"),
      ca: OBSERVER_CA,
    },
    {
      url: validUrl.replace(
        "foundation_db_observer:secret",
        "wrong_observer:secret",
      ),
      ca: OBSERVER_CA,
    },
    { url: validUrl, ca: "wrong-ca" },
  ];

  for (const fixture of fixtures) {
    let clientCreations = 0;
    await assert.rejects(
      runRemoteDbObservationCli(
        {
          argv: [
            "--provider-observation",
            "provider-observation.json",
            "--output",
            "remote-db-observation.json",
          ],
          env: {
            DB_COMPATIBILITY_OBSERVER_DATABASE_URL: fixture.url,
            DB_COMPATIBILITY_OBSERVER_CA_PEM: fixture.ca,
          },
          cwd: "C:\\fixture",
        },
        {
          loadJson: async (filePath) => {
            const name = pathBasename(filePath);
            if (name === "db-compatibility-contract.json") return CONTRACT;
            if (name === "provider-policy.json") return PROVIDER_POLICY;
            if (name === "provider-observation.json") {
              return PROVIDER_OBSERVATION;
            }
            throw new Error(`Unexpected JSON path: ${name}`);
          },
          readFileImpl: async (filePath) => {
            const bytes = MIGRATION_BYTES[pathBasename(filePath)];
            if (!bytes) throw new Error("Unexpected migration path");
            return bytes;
          },
          writeFileImpl: async () => {
            throw new Error("Invalid authority must not write evidence");
          },
          createClient: async () => {
            clientCreations += 1;
            throw new Error("Invalid authority must not create a client");
          },
          validateProviderObservation: () => {},
          now: NOW,
        },
      ),
      /connection authority is invalid/u,
    );
    assert.equal(clientCreations, 0);
  }
});

test("collector CLI rejects malformed and aliasing arguments", () => {
  assert.throws(
    () => parseRemoteDbObservationArguments(["--output", "only.json"]),
    /Usage/u,
  );
  assert.throws(
    () =>
      parseRemoteDbObservationArguments([
        "--output",
        "first.json",
        "--output",
        "second.json",
      ]),
    /duplicate/u,
  );
});

const createEvidenceStore = () => {
  const objects = new Map();
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    store: {
      namespace: "remote-db-authority-test",
      async putEvidence({ bytes, mediaType }) {
        const input = Buffer.from(bytes);
        const sha256 = sha256Bytes(input);
        const committedAt = "2026-08-09T04:05:07.000Z";
        objects.set(sha256, { bytes: input, mediaType, committedAt });
        return {
          uri: `release-state://remote-db-authority-test/evidence/${sha256}`,
          sha256,
          mediaType,
          byteLength: input.length,
          committedAt,
          replayed: false,
        };
      },
      async readEvidence({ sha256 }) {
        const stored = objects.get(sha256);
        return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : null;
      },
      async close() {
        closed = true;
      },
    },
    objects,
  };
};

const putStoreJson = async (store, value, mediaType) => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

test("stores canonical remote DB authority with exact media type and readback", async () => {
  const harness = createEvidenceStore();
  const bytes = canonicalJsonBytes(validEvidence());
  const stored = await putRemoteDbObservationAuthority({
    store: harness.store,
    namespace: harness.store.namespace,
    bytes,
    contract: CONTRACT,
    now: () => NOW,
  });
  assert.equal(stored.reference.sha256, sha256Bytes(bytes));
  assert.equal(
    harness.objects.get(stored.reference.sha256).mediaType,
    REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  );
  const readback = await readStoredRemoteDbObservationAuthority({
    store: harness.store,
    namespace: harness.store.namespace,
    reference: stored.reference,
    contract: CONTRACT,
    now: () => NOW,
  });
  assert.deepEqual(readback.observation, validEvidence());
  harness.objects.get(stored.reference.sha256).mediaType = "application/json";
  await assert.rejects(
    readStoredRemoteDbObservationAuthority({
      store: harness.store,
      namespace: harness.store.namespace,
      reference: stored.reference,
      contract: CONTRACT,
      now: () => NOW,
    }),
    /Stored remote DB observation authority differs/u,
  );
});

test("binds an observation to its exact successful producer run", async () => {
  const harness = createEvidenceStore();
  const namespace = harness.store.namespace;
  const sourceSha = "a".repeat(40);
  const runId = "12345";
  const runAttempt = "2";
  const repository = "owner/repository";
  const observation = await putRemoteDbObservationAuthority({
    store: harness.store,
    namespace,
    bytes: canonicalJsonBytes(validEvidence()),
    contract: CONTRACT,
    now: () => NOW,
  });
  const provider = await putRemoteDbProviderObservationAuthority({
    store: harness.store,
    namespace,
    bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
    providerPolicy: PROVIDER_POLICY,
    now: () => NOW,
  });
  const producerOidc = await putRemoteDbObservationOidcAuthority({
    store: harness.store,
    namespace,
    receiptBytes: canonicalJsonBytes(
      oidcReceipt({ sourceSha, runId, runAttempt }),
    ),
    approvalPolicy: APPROVAL_POLICY,
    sourceSha,
    runId,
    runAttempt,
  });
  await assert.rejects(
    putRemoteDbObservationOidcAuthority({
      store: harness.store,
      namespace,
      receiptBytes: canonicalJsonBytes(
        oidcReceipt({ sourceSha, runId, runAttempt }),
      ),
      approvalPolicy: {
        ...APPROVAL_POLICY,
        workflowRef:
          "owner/repository/.github/workflows/performance-evidence.yml@refs/heads/main",
      },
      sourceSha,
      runId,
      runAttempt,
    }),
    /OIDC workflow policy is invalid/u,
  );
  const production = await putRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    sourceSha,
    runId,
    runAttempt,
    observationReference: observation.reference,
    providerObservationReference: provider.reference,
    providerPolicyReference: provider.policyReference,
    producerOidcReference: producerOidc.reference,
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.equal(
    harness.objects.get(production.reference.sha256).mediaType,
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  assert.equal(
    harness.objects.get(provider.reference.sha256).mediaType,
    VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  );
  assert.equal(
    harness.objects.get(provider.policyReference.sha256).mediaType,
    REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  );
  const productionReadback = await readRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    reference: production.reference,
    observationReference: observation.reference,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.deepEqual(
    productionReadback.providerObservation.observation,
    PROVIDER_OBSERVATION,
  );
  const apiResponse = await putStoreJson(
    harness.store,
    {
      id: Number(runId),
      run_attempt: Number(runAttempt),
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  const reviewedWorkflowRun = await putStoreJson(
    harness.store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository,
      runId,
      runAttempt,
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
  const reviewed = await putReviewedRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    sourceSha,
    producerRunId: runId,
    producerRunAttempt: runAttempt,
    currentWorkflowRunId: "54321",
    repository,
    observationReference: observation.reference,
    productionReceiptReference: production.reference,
    reviewedWorkflowRunReference: reviewedWorkflowRun,
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.equal(
    harness.objects.get(reviewed.reference.sha256).mediaType,
    REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  const resolved = await readReviewedRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    reference: reviewed.reference,
    observationReference: observation.reference,
    expectedSourceSha: sourceSha,
    currentWorkflowRunId: "54321",
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.equal(resolved.authority.runId, runId);
  const unrelatedApiResponse = await putStoreJson(
    harness.store,
    {
      id: 99999,
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  const unrelatedSuccessfulRun = await putStoreJson(
    harness.store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository,
      runId: "99999",
      runAttempt: "1",
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse: unrelatedApiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
  await assert.rejects(
    putReviewedRemoteDbObservationProductionAuthority({
      store: harness.store,
      namespace,
      sourceSha,
      producerRunId: runId,
      producerRunAttempt: runAttempt,
      currentWorkflowRunId: "54321",
      repository,
      observationReference: observation.reference,
      productionReceiptReference: production.reference,
      reviewedWorkflowRunReference: unrelatedSuccessfulRun,
      contract: CONTRACT,
      approvalPolicy: APPROVAL_POLICY,
      now: () => NOW,
    }),
    /Reviewed GitHub workflow run receipt binding differs/u,
  );
  await assert.rejects(
    readReviewedRemoteDbObservationProductionAuthority({
      store: harness.store,
      namespace,
      reference: reviewed.reference,
      observationReference: observation.reference,
      expectedSourceSha: sourceSha,
      currentWorkflowRunId: runId,
      contract: CONTRACT,
      approvalPolicy: APPROVAL_POLICY,
      now: () => NOW,
    }),
    /distinct completed prior run|binding differs/u,
  );
  harness.objects.get(provider.reference.sha256).mediaType = "application/json";
  await assert.rejects(
    readReviewedRemoteDbObservationProductionAuthority({
      store: harness.store,
      namespace,
      reference: reviewed.reference,
      observationReference: observation.reference,
      expectedSourceSha: sourceSha,
      currentWorkflowRunId: "54321",
      contract: CONTRACT,
      approvalPolicy: APPROVAL_POLICY,
      now: () => NOW,
    }),
    /provider observation.*absent|provider observation.*differs/iu,
  );
});

test("protected collector stores closed authority and emits only secret-safe references", async () => {
  const harness = createEvidenceStore();
  const bytes = canonicalJsonBytes(validEvidence());
  const output = [];
  const writes = [];
  const sourceSha = "a".repeat(40);
  let protectedOptions;
  let collectorRuntime;
  let providerSnapshotChecked = false;
  const result = await runProtectedRemoteDbObservationCli(
    {
      argv: [
        "--namespace",
        harness.store.namespace,
        "--authority-output",
        "remote-db-observation-authority.json",
        "--output",
        "remote-db-observation.json",
        "--provider-observation",
        "provider-observation.json",
        "--run-id",
        "12345",
        "--source-sha",
        sourceSha,
      ],
      env: {
        GITHUB_RUN_ATTEMPT: "2",
        REQUESTED_OPERATION: "collect-remote-db-observation",
        RELEASE_STATE_DATABASE_URL: "postgres://release-state-secret",
        RELEASE_STATE_DATABASE_CA_PEM: "release-state-secret-ca",
      },
      cwd: "C:\\fixture",
      stdout: { write: (value) => output.push(value) },
    },
    {
      loadJson: async (filePath) => {
        const name = pathBasename(filePath);
        if (name === "approval-policy.json") {
          return APPROVAL_POLICY;
        }
        if (name === "release-state-store.json") {
          return {
            bindingStatus: "configured",
            databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
          };
        }
        if (name === "db-compatibility-contract.json") return CONTRACT;
        if (name === "provider-policy.json") return PROVIDER_POLICY;
        throw new Error(`Unexpected protected JSON path: ${name}`);
      },
      assertEnvironment: (options) => {
        protectedOptions = options;
      },
      collectObservation: async (runtime) => {
        collectorRuntime = runtime;
        return { bytes, sha256: sha256Bytes(bytes) };
      },
      readProviderObservation: async () => ({
        bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
        async assertUnchanged() {
          providerSnapshotChecked = true;
        },
      }),
      collectOidcReceipt: async () =>
        canonicalJsonBytes(
          oidcReceipt({ sourceSha, runId: "12345", runAttempt: "2" }),
        ),
      createStore: async (options) => {
        assert.equal(
          options.connectionString,
          "postgres://release-state-secret",
        );
        assert.equal(options.ca, "release-state-secret-ca");
        return harness.store;
      },
      writeFileImpl: async (filePath, outputBytes, options) => {
        writes.push({ filePath, bytes: Buffer.from(outputBytes), options });
      },
      now: () => NOW,
    },
  );
  assert.equal(protectedOptions.sourceSha, sourceSha);
  assert.equal(protectedOptions.runId, "12345");
  assert.equal(
    collectorRuntime.argv.includes("provider-observation.json"),
    false,
  );
  assert.match(collectorRuntime.argv.join(" "), /provider-observation\.json/u);
  assert.equal(providerSnapshotChecked, true);
  assert.equal(result.observation.sha256, sha256Bytes(bytes));
  assert.equal(result.mediaTypes.observation, REMOTE_DB_OBSERVATION_MEDIA_TYPE);
  assert.equal(
    result.mediaTypes.providerObservation,
    VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  );
  assert.equal(
    result.mediaTypes.production,
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  assert.equal(
    harness.objects.get(result.production.sha256).mediaType,
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, "wx");
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(JSON.parse(writes[0].bytes.toString("utf8")), result);
  assert.equal(harness.closed, true);
  const publicOutput = output.join("");
  assert.equal(publicOutput.includes("release-state-secret"), false);
  assert.deepEqual(JSON.parse(publicOutput), result);
});

test("protected collector rejects local environment spoof without trusted OIDC", async () => {
  const sourceSha = "a".repeat(40);
  const argv = [
    "--namespace",
    "remote-db-authority-test",
    "--authority-output",
    "remote-db-observation-authority.json",
    "--output",
    "remote-db-observation.json",
    "--provider-observation",
    "provider-observation.json",
    "--run-id",
    "12345",
    "--source-sha",
    sourceSha,
  ];
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: APPROVAL_POLICY.repository,
    GITHUB_WORKFLOW_REF: APPROVAL_POLICY.workflowRef,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    RELEASE_STATE_NAMESPACE: "remote-db-authority-test",
    REQUESTED_OPERATION: "collect-remote-db-observation",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example.test/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "attacker-controlled-request-token",
  };
  let storeCreated = false;
  await assert.rejects(
    runProtectedRemoteDbObservationCli(
      { argv, env, cwd: "C:\\fixture", stdout: { write: () => undefined } },
      {
        loadJson: async (filePath) => {
          const name = pathBasename(filePath);
          if (name === "approval-policy.json") return APPROVAL_POLICY;
          if (name === "release-state-store.json") {
            return {
              bindingStatus: "configured",
              databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
            };
          }
          if (name === "db-compatibility-contract.json") return CONTRACT;
          if (name === "provider-policy.json") return PROVIDER_POLICY;
          throw new Error(`Unexpected protected JSON path: ${name}`);
        },
        collectObservation: async () => {
          const bytes = canonicalJsonBytes(validEvidence());
          return { bytes, sha256: sha256Bytes(bytes) };
        },
        readProviderObservation: async () => ({
          bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
          assertUnchanged: async () => undefined,
        }),
        createStore: async () => {
          storeCreated = true;
          throw new Error("store must not be reached");
        },
        fetchImpl: async () => {
          throw new Error("untrusted OIDC URL must fail before fetch");
        },
        now: () => NOW,
      },
    ),
    /OIDC request URL is not trusted/u,
  );
  assert.equal(storeCreated, false);
});

test("protected collector rejects incomplete, duplicate, and aliased inputs", () => {
  assert.throws(
    () => parseProtectedRemoteDbObservationArguments([]),
    /incomplete/u,
  );
  assert.throws(
    () =>
      parseProtectedRemoteDbObservationArguments([
        "--namespace",
        "remote-db-authority-test",
        "--authority-output",
        "same.json",
        "--output",
        "same.json",
        "--provider-observation",
        "same.json",
        "--run-id",
        "12345",
        "--source-sha",
        "a".repeat(40),
      ]),
    /must be distinct/u,
  );
});

const pathBasename = (filePath) =>
  String(filePath).replaceAll("\\", "/").split("/").at(-1);
