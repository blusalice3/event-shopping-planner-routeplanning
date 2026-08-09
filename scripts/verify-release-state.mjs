import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  hashReleaseEvent,
  replayReleaseEvents,
} from "./release-state/releaseStateReducer.mjs";
import {
  assertReleaseEventMatchesSchema,
  assertReleaseStateSnapshotMatchesSchema,
} from "./release-state/releaseStateSchema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(
  root,
  "ops",
  "release-state",
  "migrations",
);
const expectedMigrationPaths = [
  "ops/release-state/migrations/0001_release_state_store.sql",
  "ops/release-state/migrations/0002_acceptance_evidence_chains.sql",
  "ops/release-state/migrations/0003_phase_exit_attestations.sql",
];
const [
  storePolicy,
  approvalPolicy,
  releaseStateSchema,
  migrationBytes,
  migrationDirectoryEntries,
] = await Promise.all([
  readJsonStrict(path.join(root, "config", "release-state-store.json")),
  readJsonStrict(path.join(root, "config", "approval-policy.json")),
  readJsonStrict(path.join(root, "config", "release-state.schema.json")),
  Promise.all(
    expectedMigrationPaths.map((migrationPath) =>
      readFile(path.join(root, ...migrationPath.split("/"))),
    ),
  ),
  readdir(migrationDirectory),
]);
const migrationReferences = expectedMigrationPaths.map(
  (migrationPath, index) => ({
    path: migrationPath,
    sha256: sha256Bytes(migrationBytes[index]),
  }),
);
const migrationSetSha256 = sha256Json(migrationReferences);
const migrationFileNames = migrationDirectoryEntries
  .filter((entry) => entry.endsWith(".sql"))
  .sort();
const expectedMigrationFileNames = expectedMigrationPaths.map((migrationPath) =>
  path.basename(migrationPath),
);
const hasClosedMigrationSet =
  Array.isArray(storePolicy.migrations) &&
  storePolicy.migrations.length === migrationReferences.length &&
  storePolicy.migrations.every(
    (reference, index) =>
      reference !== null &&
      typeof reference === "object" &&
      !Array.isArray(reference) &&
      Object.keys(reference).sort().join("\n") === "path\nsha256" &&
      reference.path === migrationReferences[index].path &&
      reference.sha256 === migrationReferences[index].sha256,
  ) &&
  migrationFileNames.join("\n") === expectedMigrationFileNames.join("\n") &&
  storePolicy.migrationSetSha256 === migrationSetSha256;
if (
  storePolicy.schemaVersion !== 1 ||
  storePolicy.engine !== "postgresql" ||
  storePolicy.postgresMajor !== 17 ||
  storePolicy.timezone !== "UTC" ||
  storePolicy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL" ||
  storePolicy.tlsMode !== "verify-full" ||
  storePolicy.maximumEvidenceObjectBytes !== 268435456 ||
  storePolicy.credentialRotationDays !== 90 ||
  !hasClosedMigrationSet
) {
  throw new Error(
    "Release State store policy differs from the protected-store contract",
  );
}
const migrationTexts = migrationBytes.map((bytes) => bytes.toString("utf8"));
for (const requiredFragment of [
  "create table if not exists foundation_release.release_state_heads",
  "create or replace function foundation_release.compare_and_append",
  "create or replace function foundation_release.put_evidence_if_absent",
]) {
  if (!migrationTexts[0].includes(requiredFragment)) {
    throw new Error(`Release State base migration omits ${requiredFragment}`);
  }
}
if (migrationTexts[0].includes("'phase-exit-attested'")) {
  throw new Error(
    "Release State immutable base migration contains a later phase exit event",
  );
}
for (const requiredFragment of [
  "phase-exit-attested",
  "compare_and_append prerequisite differs before phase exit migration",
  "create or replace function foundation_release.compare_and_append",
  "security definer",
]) {
  if (!migrationTexts[2].includes(requiredFragment)) {
    throw new Error(
      `Release State phase exit migration omits ${requiredFragment}`,
    );
  }
}
if (
  /pg_get_functiondef|regexp_replace|execute\s+upgraded_definition/u.test(
    migrationTexts[2],
  )
) {
  throw new Error(
    "Release State phase exit migration uses a dynamic function rewrite",
  );
}
const compareAndAppendPattern =
  /create or replace function foundation_release\.compare_and_append\([\s\S]*?\n\$\$;/u;
const baseCompareAndAppend = migrationTexts[0].match(
  compareAndAppendPattern,
)?.[0];
const upgradedCompareAndAppend = migrationTexts[2].match(
  compareAndAppendPattern,
)?.[0];
if (
  typeof baseCompareAndAppend !== "string" ||
  typeof upgradedCompareAndAppend !== "string" ||
  upgradedCompareAndAppend.replace("      'phase-exit-attested',\n", "") !==
    baseCompareAndAppend
) {
  throw new Error(
    "Release State phase exit migration is not the exact full base function plus its event",
  );
}
for (const requiredFragment of [
  "create table if not exists foundation_release.acceptance_evidence_chains",
  "create or replace function foundation_release.append_acceptance_evidence_chain",
  "create or replace function foundation_release.read_acceptance_evidence_chain",
  "requested_chain_id is distinct from computed_chain_id",
  "pg_advisory_xact_lock",
  "acceptance chain objects already exist outside atomic append",
  "continuous-probe-chain-commit+json;version=1",
  "revoke all on table foundation_release.acceptance_evidence_chains from public",
]) {
  if (!migrationTexts[1].includes(requiredFragment)) {
    throw new Error(`Acceptance chain migration omits ${requiredFragment}`);
  }
}
if (
  approvalPolicy.schemaVersion !== 1 ||
  approvalPolicy.trustedIssuer !==
    "https://token.actions.githubusercontent.com" ||
  approvalPolicy.oidcAudience !==
    "urn:event-shopping-planner:foundation-release-state" ||
  approvalPolicy.oidcClockSkewSeconds !== 60 ||
  approvalPolicy.oidcMaxTokenAgeSeconds !== 600 ||
  approvalPolicy.protectedEnvironment !== "foundation-release-state" ||
  !approvalPolicy.workflowRef?.endsWith(
    "/.github/workflows/release.yml@refs/heads/main",
  )
) {
  throw new Error("Release State approval policy is invalid");
}
if (approvalPolicy.bindingStatus === "configured") {
  const reviewerTeams = Object.values(approvalPolicy.roles ?? {}).map(
    (role) => role.reviewerTeam,
  );
  if (
    reviewerTeams.length !== 3 ||
    reviewerTeams.some(
      (team) => typeof team !== "string" || team.length === 0,
    ) ||
    new Set(reviewerTeams).size !== reviewerTeams.length
  ) {
    throw new Error("Approval reviewer teams must be configured and distinct");
  }
}
if (storePolicy.bindingStatus === "configured") {
  if (
    storePolicy.allowedHosts.length === 0 ||
    storePolicy.allowedDatabases.length === 0 ||
    storePolicy.allowedExecutorRoles.length === 0 ||
    typeof storePolicy.backupOwner !== "string" ||
    storePolicy.backupOwner.length === 0 ||
    typeof storePolicy.restoreOwner !== "string" ||
    storePolicy.restoreOwner.length === 0 ||
    typeof storePolicy.productionCaSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(storePolicy.productionCaSha256) ||
    typeof storePolicy.localContainerImage !== "string" ||
    !storePolicy.localContainerImage.includes("@sha256:")
  ) {
    throw new Error("Configured Release State store binding is incomplete");
  }
}
if (
  releaseStateSchema.$ref !== "#/$defs/releaseEventEnvelope" ||
  releaseStateSchema.$defs?.releaseEventEnvelope?.additionalProperties !== false
) {
  throw new Error("Release State schema does not close the event envelope");
}
const declaredEventTypes =
  releaseStateSchema.$defs.releaseEventEnvelope.properties?.eventType?.enum ??
  [];
const eventPayloadBranches =
  releaseStateSchema.$defs.releaseEventEnvelope.allOf?.[0]?.oneOf ?? [];
const mappedEventTypes = eventPayloadBranches.map(
  (branch) => branch.properties?.eventType?.const,
);
if (
  declaredEventTypes.length !== mappedEventTypes.length ||
  new Set(mappedEventTypes).size !== mappedEventTypes.length ||
  declaredEventTypes.some((eventType) => !mappedEventTypes.includes(eventType))
) {
  throw new Error(
    "Release State schema must map every event type to one payload schema",
  );
}
for (const branch of eventPayloadBranches) {
  const payloadReference = branch.properties?.payload?.$ref;
  const definitionName = payloadReference?.match(/^#\/\$defs\/([^/]+)$/)?.[1];
  const payloadDefinition = releaseStateSchema.$defs?.[definitionName];
  const isClosed =
    payloadDefinition?.additionalProperties === false ||
    (Array.isArray(payloadDefinition?.oneOf) &&
      payloadDefinition.oneOf.length > 0 &&
      payloadDefinition.oneOf.every(
        (variant) => variant.additionalProperties === false,
      ));
  if (!definitionName || !isClosed) {
    throw new Error(
      `Release State event payload schema is not closed: ${payloadReference ?? "missing"}`,
    );
  }
}
for (const definition of [
  "legacyProductionObservation",
  "containmentIncident",
  "standardRecovery",
  "rollbackInventoryEntry",
]) {
  if (releaseStateSchema.$defs?.[definition]?.additionalProperties !== false) {
    throw new Error(
      `Release State schema definition is not closed: ${definition}`,
    );
  }
}
const migrationText = migrationBytes[0].toString("utf8").toLowerCase();
for (const fragment of [
  "insert into foundation_release.release_state_heads",
  "on conflict (namespace) do nothing",
  "event envelope does not match cas arguments",
  "append id replay bytes differ",
  "on conflict (namespace, sha256) do nothing",
  "revoke all on all tables in schema foundation_release from public",
]) {
  if (!migrationText.includes(fragment)) {
    throw new Error(`Release State migration lacks: ${fragment}`);
  }
}
if (
  process.argv.includes("--require-configured") &&
  (storePolicy.bindingStatus !== "configured" ||
    approvalPolicy.bindingStatus !== "configured")
) {
  throw new Error(
    `Release State remains unconfigured: ${[
      ...(storePolicy.blockerCodes ?? []),
      ...(approvalPolicy.blockerCodes ?? []),
    ].join(", ")}`,
  );
}

const inputIndex = process.argv.indexOf("--events");
if (inputIndex === -1) {
  console.log(
    `PASS Release State static contract ${sha256Json(releaseStateSchema)}; migrations ${migrationSetSha256}; store ${storePolicy.bindingStatus}.`,
  );
  process.exitCode = 0;
} else if (!process.argv[inputIndex + 1]) {
  throw new Error("--events requires a file");
} else {
  const inputPath = path.resolve(root, process.argv[inputIndex + 1]);
  const input = parseJsonStrict(await readFile(inputPath, "utf8"), inputPath);
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.events) ||
    !Array.isArray(input.receipts)
  ) {
    throw new Error("Release State verification input is invalid");
  }
  if (
    input.events.length !== input.receipts.length ||
    input.events.length === 0
  ) {
    throw new Error("Release State event and receipt counts must match");
  }
  let previousCommittedAt = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < input.events.length; index += 1) {
    const event = input.events[index];
    const receipt = input.receipts[index];
    assertReleaseEventMatchesSchema(
      event,
      releaseStateSchema,
      `Release State event ${index + 1}`,
    );
    const eventHash = hashReleaseEvent(event);
    const committedAt = new Date(receipt.committedAt).getTime();
    if (
      receipt.sequence !== event.sequence ||
      receipt.eventHash !== eventHash ||
      receipt.namespace !== event.namespace ||
      typeof receipt.replayed !== "boolean" ||
      !Number.isFinite(committedAt) ||
      committedAt < previousCommittedAt
    ) {
      throw new Error(`Release State receipt mismatch at event ${index + 1}`);
    }
    previousCommittedAt = committedAt;
    if (
      typeof receipt.canonicalEventSha256 === "string" &&
      receipt.canonicalEventSha256 !== eventHash
    ) {
      throw new Error(`Canonical event hash mismatch at event ${index + 1}`);
    }
  }
  const snapshot = replayReleaseEvents(input.events);
  assertReleaseStateSnapshotMatchesSchema(
    snapshot,
    releaseStateSchema,
    "Release State terminal snapshot",
  );
  if (snapshot.eventHash !== input.receipts.at(-1).eventHash) {
    throw new Error("Release State terminal head does not match receipts");
  }
  console.log(
    `PASS Release State: ${input.events.length} events; head ${snapshot.sequence}/${snapshot.eventHash}; input ${sha256Bytes(await readFile(inputPath))}.`,
  );
}
