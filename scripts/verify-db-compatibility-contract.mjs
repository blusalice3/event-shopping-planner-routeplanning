import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260805000000_persistence_release_a_hardening.sql",
);
const contract = await readJsonStrict(contractPath);
const migrationBytes = await readFile(migrationPath);
const migrationSha256 = sha256Bytes(migrationBytes);
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
if (contract.remote.migrationSha256 !== migrationSha256) {
  throw new Error("DB hardening migration hash differs from the contract");
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

const migrationText = migrationBytes.toString("utf8");
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
  if (!migrationText.toLowerCase().includes(requiredFragment.toLowerCase())) {
    throw new Error(`DB hardening migration lacks: ${requiredFragment}`);
  }
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
    evidence.migrationSha256 !== migrationSha256 ||
    evidence.migrationApplied !== true ||
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
        migrationSha256,
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
