import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CSP_BLOCKED_TARGET_VALUES,
  CSP_EFFECTIVE_DIRECTIVE_VALUES,
  CSP_REPORT_BLOCKED_TARGET_COLUMN,
  normalizeEffectiveDirective,
} from "../api/csp-report.mjs";
import {
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import { hasFinalRemoteDbAuthority } from "./lib/db-compatibility-authority.mjs";
import {
  assertRemoteDbObservation,
  assertRemoteDbObservationAuthority,
} from "./db/remote-db-observation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(
  root,
  "config",
  "db-compatibility-contract.json",
);
const migrationDirectory = path.join(root, "supabase", "migrations");
const baselineMigrationName =
  "20260803000000_persistence_release_a_metrics.sql";
const hardeningMigrationName =
  "20260805000000_persistence_release_a_hardening.sql";
const cspContractMigrationName = "20260808000000_csp_report_contract.sql";
const cspDeploymentAggregateMigrationName =
  "20260809000000_csp_report_deployment_aggregate.sql";
const applicationObserverMigrationName =
  "20260810000000_foundation_application_observer.sql";
const backupIntegrityMigrationName =
  "20260810010000_foundation_backup_integrity.sql";
const [
  contract,
  baselineMigrationBytes,
  hardeningMigrationBytes,
  cspContractMigrationBytes,
  cspDeploymentAggregateMigrationBytes,
  applicationObserverMigrationBytes,
  backupIntegrityMigrationBytes,
] = await Promise.all([
  readJsonStrict(contractPath),
  readFile(path.join(migrationDirectory, baselineMigrationName)),
  readFile(path.join(migrationDirectory, hardeningMigrationName)),
  readFile(path.join(migrationDirectory, cspContractMigrationName)),
  readFile(path.join(migrationDirectory, cspDeploymentAggregateMigrationName)),
  readFile(path.join(migrationDirectory, applicationObserverMigrationName)),
  readFile(path.join(migrationDirectory, backupIntegrityMigrationName)),
]);
const migrationChecksums = Object.freeze({
  [baselineMigrationName]: sha256Bytes(baselineMigrationBytes),
  [hardeningMigrationName]: sha256Bytes(hardeningMigrationBytes),
  [cspContractMigrationName]: sha256Bytes(cspContractMigrationBytes),
  [cspDeploymentAggregateMigrationName]: sha256Bytes(
    cspDeploymentAggregateMigrationBytes,
  ),
  [applicationObserverMigrationName]: sha256Bytes(
    applicationObserverMigrationBytes,
  ),
  [backupIntegrityMigrationName]: sha256Bytes(backupIntegrityMigrationBytes),
});
const fingerprint = sha256Json(contract);
assertRemoteDbObservationAuthority(contract.remote?.observationAuthority);
const expectedObserverManagedSchemas = [
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
];
if (
  !Array.isArray(contract.remote?.observerManagedSchemas) ||
  contract.remote.observerManagedSchemas.length !==
    expectedObserverManagedSchemas.length ||
  contract.remote.observerManagedSchemas.some(
    (schema, index) => schema !== expectedObserverManagedSchemas[index],
  )
) {
  throw new Error("DB observer managed schema boundary differs");
}
if (
  !Array.isArray(contract.remote?.observerManagedSchemaUsage) ||
  contract.remote.observerManagedSchemaUsage.length !== 1 ||
  contract.remote.observerManagedSchemaUsage[0] !== "net"
) {
  throw new Error("DB observer managed schema usage baseline differs");
}
if (
  !Array.isArray(contract.remote?.observerManagedRelationPrivilegeBaseline) ||
  !Array.isArray(contract.remote?.observerManagedSequencePrivilegeBaseline) ||
  sha256Json(contract.remote?.observerManagedRelationPrivilegeBaseline) !==
    "d68230bf81591fed333b62c494f32f35c88e6aaa62b7e0e92c072e02af0ad5d8" ||
  sha256Json(contract.remote?.observerManagedSequencePrivilegeBaseline) !==
    "e8058aa0167ff6b03b676ed73b097c7f80eab75fdca83d12cea5cfb1616861c3"
) {
  throw new Error("DB observer managed object privilege baseline differs");
}
const expectedMigrationVersions = Object.keys(migrationChecksums).map(
  (name) => /^([0-9]{14})_/u.exec(name)?.[1],
);
const expectedMigrationHistoryAuthority = [
  [
    "20260803000000",
    "persistence_release_a_metrics",
    17,
    "ed810d9c19d47104d9695fe05ea4636dbcd88613eb6f95643a9f5bde9f592fbc",
  ],
  [
    "20260805000000",
    "persistence_release_a_hardening",
    35,
    "e6eb73862c5bc3715c664a3725761f4cb1b9f8d4cd4d0bcbcb5baadd9a49ba64",
  ],
  [
    "20260808000000",
    "csp_report_contract",
    10,
    "f45d299169dcf51e15f4c064fd581abd4b8e42e51c8bec67d0a02773d462b619",
  ],
  [
    "20260809000000",
    "csp_report_deployment_aggregate",
    6,
    "50effb2560f8529c80dccd1f914af701c3690e183da4d61a04c6391dffee2580",
  ],
  [
    "20260810000000",
    "foundation_application_observer",
    38,
    "fbf9ca53751e77b42ca7f505ef097b00105cce40396c44648bcb05bab0ce7cb2",
  ],
  [
    "20260810010000",
    "foundation_backup_integrity",
    10,
    "e0803d6864264737aaa280b04e0d8c99c403b4a3eafcc33eb869ff62c613566a",
  ],
].map(([version, migrationName, statementCount, statementsSha256]) => ({
  version,
  migrationName,
  statementCount,
  statementsSha256,
}));
if (
  !Array.isArray(contract.remote?.migrationHistory) ||
  contract.remote.migrationHistory.length !==
    expectedMigrationVersions.length ||
  contract.remote.migrationHistory.some(
    (entry, index) =>
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !==
        "migrationName,statementCount,statementsSha256,version" ||
      entry.version !== expectedMigrationVersions[index] ||
      !/^[a-z0-9_]{1,128}$/u.test(entry.migrationName) ||
      !Number.isSafeInteger(entry.statementCount) ||
      entry.statementCount < 1 ||
      !/^[0-9a-f]{64}$/u.test(entry.statementsSha256),
  )
) {
  throw new Error("DB exact migration history authority differs");
}
if (
  sha256Json(contract.remote.migrationHistory) !==
  sha256Json(expectedMigrationHistoryAuthority)
) {
  throw new Error("DB migration history statement authority differs");
}

const expectedStores = [
  "dayModes",
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "hallDefinitions",
  "hallRouteSettings",
  "mapData",
  "mapRotationSettings",
  "mapViewportSettings",
  "routeSettings",
  "syncQueue",
];
const actualStores = Object.keys(contract.indexedDb?.stores ?? {}).sort();
if (
  actualStores.length !== expectedStores.length ||
  actualStores.some((store, index) => store !== expectedStores[index])
) {
  throw new Error("IndexedDB store contract differs from the version 5 schema");
}
if (
  contract.indexedDb.name !== "EventShoppingPlannerDB" ||
  contract.indexedDb.version !== 5 ||
  contract.indexedDb.forwardCompatibilityCeiling !== 7
) {
  throw new Error("IndexedDB identity/version contract is invalid");
}
if (
  Object.values(contract.indexedDb.stores).some(
    (store) =>
      store.keyPath !== null ||
      !Array.isArray(store.indexes) ||
      store.indexes.length !== 0,
  )
) {
  throw new Error(
    "IndexedDB stores must remain key-out-of-line with no indexes",
  );
}
if (
  contract.releaseA.releaseChannel !== "release-a" ||
  contract.releaseA.legacyLocalStorageCleanup !== "forced-off" ||
  contract.releaseA.legacyPhysicalDeletion !== "forbidden"
) {
  throw new Error("Release A hard-off is absent from DB compatibility");
}
const hasExactMigrationChecksums = (candidate) => {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  const expectedEntries = Object.entries(migrationChecksums);
  const actualKeys = Object.keys(candidate);
  return (
    actualKeys.length === expectedEntries.length &&
    expectedEntries.every(([name, checksum]) => candidate[name] === checksum)
  );
};
if (!hasExactMigrationChecksums(contract.remote.migrationChecksums)) {
  throw new Error("DB migration checksums differ from the contract");
}
if (
  contract.remote.requiredPrivilegeFloor?.serviceRoleRawInsert !== true ||
  contract.remote.requiredPrivilegeFloor?.serviceRoleRawSelect !== false ||
  contract.remote.requiredPrivilegeFloor?.cspServiceRoleRawInsert !== true ||
  contract.remote.requiredPrivilegeFloor?.cspServiceRoleRawSelect !== false ||
  contract.remote.requiredPrivilegeFloor?.operatorBoundedFunctionOnly !==
    true ||
  contract.remote.requiredPrivilegeFloor
    ?.cspApplicationCredentialDormantUntilPhase2B !== true
) {
  throw new Error("DB compatibility privilege floor is invalid");
}

const hardeningMigrationText = hardeningMigrationBytes.toString("utf8");
const cspContractMigrationText = cspContractMigrationBytes.toString("utf8");
const cspDeploymentAggregateMigrationText =
  cspDeploymentAggregateMigrationBytes.toString("utf8");
const applicationObserverMigrationText =
  applicationObserverMigrationBytes.toString("utf8");
const backupIntegrityMigrationText =
  backupIntegrityMigrationBytes.toString("utf8");
const expectedCspEffectiveDirectiveValues = [
  "base-uri",
  "child-src",
  "connect-src",
  "default-src",
  "font-src",
  "form-action",
  "frame-ancestors",
  "frame-src",
  "img-src",
  "manifest-src",
  "media-src",
  "object-src",
  "script-src",
  "script-src-attr",
  "script-src-elem",
  "style-src",
  "style-src-attr",
  "style-src-elem",
  "worker-src",
  "unknown",
];
const expectedCspBlockedTargetValues = [
  "self",
  "scheme",
  "same-site",
  "cross-site",
  "unknown",
];
const sameOrderedValues = (actual, expected) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);
const readNamedCheckValues = (constraintName, columnName) => {
  const escapedConstraintName = constraintName.replaceAll("_", "\\_");
  const escapedColumnName = columnName.replaceAll("_", "\\_");
  const constraint = cspContractMigrationText.match(
    new RegExp(
      `\\badd\\s+constraint\\s+${escapedConstraintName}\\s+check\\s*\\(\\s*${escapedColumnName}\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`,
      "i",
    ),
  );
  return constraint
    ? [...constraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    : [];
};
const sqlEffectiveDirectiveValues = readNamedCheckValues(
  "csp_violation_reports_effective_directive_check",
  "effective_directive",
);
const sqlBlockedTargetValues = readNamedCheckValues(
  "csp_violation_reports_blocked_target_check",
  "blocked_target",
);
if (
  !sameOrderedValues(
    CSP_EFFECTIVE_DIRECTIVE_VALUES,
    expectedCspEffectiveDirectiveValues,
  ) ||
  !sameOrderedValues(
    sqlEffectiveDirectiveValues,
    expectedCspEffectiveDirectiveValues,
  ) ||
  normalizeEffectiveDirective("script-src-elem") !== "script-src-elem" ||
  normalizeEffectiveDirective("trusted-types") !== "unknown" ||
  normalizeEffectiveDirective("script_src") !== null ||
  CSP_REPORT_BLOCKED_TARGET_COLUMN !== "blocked_target" ||
  !sameOrderedValues(
    CSP_BLOCKED_TARGET_VALUES,
    expectedCspBlockedTargetValues,
  ) ||
  !sameOrderedValues(sqlBlockedTargetValues, expectedCspBlockedTargetValues)
) {
  throw new Error("CSP API and DB closed report contract differ");
}
for (const requiredFragment of [
  "from service_role",
  "revoke all\n  on table public.persistence_release_a_metric_events",
  "grant insert on table public.csp_violation_reports",
  "grant usage on sequence public.csp_violation_reports_id_seq",
  "create table if not exists public.csp_violation_reports",
  "create or replace function public.read_persistence_release_a_metrics",
  "create or replace function public.retain_persistence_release_a_metrics",
  "create or replace function public.read_csp_violation_aggregates",
  "create or replace function public.retain_csp_violation_reports",
  "'17 * * * *'",
  "requested_dry_run is null",
  "requested_batch_size is null",
  "requested_max_batches is null",
]) {
  if (
    !hardeningMigrationText
      .toLowerCase()
      .includes(requiredFragment.toLowerCase())
  ) {
    throw new Error(`DB hardening migration lacks: ${requiredFragment}`);
  }
}
for (const managedSchema of expectedObserverManagedSchemas) {
  for (const forbiddenFragment of [
    `on schema ${managedSchema}`,
    `in schema ${managedSchema}`,
  ]) {
    if (
      applicationObserverMigrationText
        .toLowerCase()
        .includes(forbiddenFragment.toLowerCase())
    ) {
      throw new Error(
        `Application observer migration mutates managed schema ACL: ${managedSchema}`,
      );
    }
  }
}

for (const requiredFragment of [
  "create role foundation_db_observer",
  "login",
  "noinherit",
  "nobypassrls",
  "set default_transaction_read_only = on",
  "revoke create on schema public from public",
  "revoke all on all tables in schema public from public",
  "revoke all on all sequences in schema public from public",
  "revoke execute on all functions in schema public from public",
  "alter default privileges\n  revoke execute on functions from public",
  "alter default privileges in schema public",
  "revoke all on tables from public",
  "revoke all on sequences from public",
  "revoke execute on functions from public",
  "revoke all on schema supabase_migrations from foundation_db_observer",
  "on all tables in schema supabase_migrations",
  "from foundation_db_observer",
  "on all sequences in schema supabase_migrations",
  "on all functions in schema supabase_migrations",
  "revoke all on all tables in schema supabase_migrations from public",
  "revoke all on all sequences in schema supabase_migrations from public",
  "revoke execute on all functions in schema supabase_migrations from public",
  "revoke create on database %I from foundation_db_observer",
  "grant select on table supabase_migrations.schema_migrations",
  "grant execute on function public.read_persistence_release_a_metrics",
  "grant execute on function public.read_csp_violation_aggregates",
  "grant execute on function public.read_csp_deployment_violation_aggregates",
]) {
  if (
    !applicationObserverMigrationText
      .toLowerCase()
      .includes(requiredFragment.toLowerCase())
  ) {
    throw new Error(
      `Application observer migration lacks: ${requiredFragment}`,
    );
  }
}

for (const requiredFragment of [
  "create or replace function public.read_foundation_backup_restore_integrity()",
  "security definer",
  "set search_path = pg_catalog, pg_temp",
  "pg_catalog.sha256(pg_catalog.convert_to(migration.manifest, 'UTF8'))",
  "revoke execute on all functions in schema public from public",
  "alter default privileges in schema public",
  "revoke execute on functions from public",
  "from public, anon, authenticated, service_role, foundation_db_observer",
  "foundation_backup_source_reader",
  "foundation_backup_restore_reader",
  "default_transaction_read_only = on",
  "grant execute on function public.read_foundation_backup_restore_integrity()",
  "supabase_migrations.schema_migrations",
  "pg_catalog.convert_to(to_jsonb(metric)::text, 'UTF8')",
  "pg_catalog.convert_to(to_jsonb(report)::text, 'UTF8')",
  "pg_catalog.convert_to(to_jsonb(audit)::text, 'UTF8')",
  "string_agg(row_sha256, '' order by row_sha256)",
]) {
  if (
    !backupIntegrityMigrationText
      .toLowerCase()
      .includes(requiredFragment.toLowerCase())
  ) {
    throw new Error(`Backup integrity migration lacks: ${requiredFragment}`);
  }
}
if (/hashtextextended|bit_xor/iu.test(backupIntegrityMigrationText)) {
  throw new Error(
    "Backup integrity migration uses a non-cryptographic row hash",
  );
}
const requiredCspMigrationFragments = [
  "-- CSP_REPORT_CONTRACT_UPGRADE_BEGIN",
  "drop constraint if exists csp_violation_reports_effective_directive_check",
  "drop constraint if exists csp_violation_reports_blocked_target_check",
  "set effective_directive = 'unknown'",
  "where effective_directive not in (",
  "when blocked_target in (",
  "then 'scheme'",
  "where blocked_target not in (",
  "add constraint csp_violation_reports_effective_directive_check",
  ") not valid;",
  "validate constraint csp_violation_reports_effective_directive_check",
  "add constraint csp_violation_reports_blocked_target_check",
  ") not valid;",
  "validate constraint csp_violation_reports_blocked_target_check",
  "-- CSP_REPORT_CONTRACT_UPGRADE_END",
];
const normalizedCspContractMigration = cspContractMigrationText.toLowerCase();
let previousCspMigrationFragmentIndex = -1;
for (const requiredFragment of requiredCspMigrationFragments) {
  const fragmentIndex = normalizedCspContractMigration.indexOf(
    requiredFragment.toLowerCase(),
    previousCspMigrationFragmentIndex + 1,
  );
  if (fragmentIndex === -1) {
    throw new Error(`CSP report contract migration lacks: ${requiredFragment}`);
  }
  previousCspMigrationFragmentIndex = fragmentIndex;
}
for (const requiredFragment of [
  "create index if not exists csp_violation_reports_deployment_received_idx",
  "create or replace function public.read_csp_deployment_violation_aggregates",
  "requested_from >= requested_to",
  "requested_to - requested_from > interval '8 days'",
  "reports.received_at >= requested_from",
  "reports.received_at < requested_to",
  "reports.source_sha = requested_source_sha",
  "reports.provider_deployment_id = requested_provider_deployment_id",
  "security definer",
  "revoke all on function public.read_csp_deployment_violation_aggregates",
]) {
  if (
    !cspDeploymentAggregateMigrationText
      .toLowerCase()
      .includes(requiredFragment.toLowerCase())
  ) {
    throw new Error(
      `CSP deployment aggregate migration lacks: ${requiredFragment}`,
    );
  }
}

const evidenceArgumentIndex = process.argv.indexOf("--remote-evidence");
let remoteEvidenceValidated = false;
if (evidenceArgumentIndex !== -1) {
  const evidencePath = process.argv[evidenceArgumentIndex + 1];
  if (!evidencePath) throw new Error("--remote-evidence requires a file");
  const evidence = await readJsonStrict(path.resolve(evidencePath));
  assertRemoteDbObservation(evidence, { contract, migrationChecksums });
  remoteEvidenceValidated = true;
}

if (
  process.argv.includes("--require-remote") &&
  (!hasFinalRemoteDbAuthority(contract) || !remoteEvidenceValidated)
) {
  throw new Error(
    `DB compatibility is not remotely observed: ${(contract.blockerCodes ?? []).join(", ")}`,
  );
}

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contractUri: contract.contractUri,
        fingerprint,
        migrationChecksums,
        remoteObservationStatus: contract.remote.observationStatus,
      },
      null,
      2,
    )}\n`,
  );
} else {
  console.log(
    `PASS DB compatibility contract ${fingerprint}; remote ${contract.remote.observationStatus}.`,
  );
}
