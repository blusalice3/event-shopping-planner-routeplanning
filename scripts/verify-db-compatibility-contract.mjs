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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(
  root,
  "config",
  "db-compatibility-contract.json",
);
const migrationDirectory = path.join(root, "supabase", "migrations");
const hardeningMigrationName =
  "20260805000000_persistence_release_a_hardening.sql";
const cspContractMigrationName = "20260808000000_csp_report_contract.sql";
const [contract, hardeningMigrationBytes, cspContractMigrationBytes] =
  await Promise.all([
    readJsonStrict(contractPath),
    readFile(path.join(migrationDirectory, hardeningMigrationName)),
    readFile(path.join(migrationDirectory, cspContractMigrationName)),
  ]);
const migrationChecksums = Object.freeze({
  [hardeningMigrationName]: sha256Bytes(hardeningMigrationBytes),
  [cspContractMigrationName]: sha256Bytes(cspContractMigrationBytes),
});
const fingerprint = sha256Json(contract);

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

const evidenceArgumentIndex = process.argv.indexOf("--remote-evidence");
let remoteEvidenceValidated = false;
if (evidenceArgumentIndex !== -1) {
  const evidencePath = process.argv[evidenceArgumentIndex + 1];
  if (!evidencePath) throw new Error("--remote-evidence requires a file");
  const evidence = await readJsonStrict(path.resolve(evidencePath));
  const requiredTables = [...contract.remote.requiredTables].sort();
  const observedTables = [...(evidence.requiredTables ?? [])].sort();
  const requiredFunctions = [...contract.remote.requiredFunctions].sort();
  const observedFunctions = [...(evidence.requiredFunctions ?? [])].sort();
  if (
    evidence.schemaVersion !== 1 ||
    evidence.contractFingerprint !== fingerprint ||
    !hasExactMigrationChecksums(evidence.migrationChecksums) ||
    evidence.migrationsApplied !== true ||
    evidence.serviceRoleRawSelect !== false ||
    evidence.serviceRoleRawInsert !== true ||
    evidence.cspServiceRoleRawSelect !== false ||
    evidence.cspServiceRoleRawInsert !== true ||
    evidence.cspObjectsPresent !== true ||
    evidence.operatorBoundedFunctionOnly !== true ||
    evidence.cspApplicationCredentialReachable !== false ||
    requiredTables.length !== observedTables.length ||
    requiredTables.some((table, index) => table !== observedTables[index]) ||
    requiredFunctions.length !== observedFunctions.length ||
    requiredFunctions.some(
      (functionName, index) => functionName !== observedFunctions[index],
    ) ||
    !Number.isFinite(new Date(evidence.observedAt).getTime())
  ) {
    throw new Error(
      "Remote DB evidence does not match the compatibility contract",
    );
  }
  remoteEvidenceValidated = true;
}

if (
  process.argv.includes("--require-remote") &&
  (contract.remote.observationStatus !== "observed" || !remoteEvidenceValidated)
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
