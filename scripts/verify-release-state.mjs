import { readFile } from "node:fs/promises";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [storePolicy, approvalPolicy, releaseStateSchema, migrationBytes] =
  await Promise.all([
    readJsonStrict(path.join(root, "config", "release-state-store.json")),
    readJsonStrict(path.join(root, "config", "approval-policy.json")),
    readJsonStrict(path.join(root, "config", "release-state.schema.json")),
    readFile(
      path.join(
        root,
        "ops",
        "release-state",
        "migrations",
        "0001_release_state_store.sql",
      ),
    ),
  ]);
const migrationSha256 = sha256Bytes(migrationBytes);
if (
  storePolicy.schemaVersion !== 1 ||
  storePolicy.engine !== "postgresql" ||
  storePolicy.postgresMajor !== 17 ||
  storePolicy.timezone !== "UTC" ||
  storePolicy.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL" ||
  storePolicy.tlsMode !== "verify-full" ||
  storePolicy.maximumEvidenceObjectBytes !== 268435456 ||
  storePolicy.credentialRotationDays !== 90 ||
  storePolicy.migrationChecksums?.["0001_release_state_store.sql"] !==
    migrationSha256
) {
  throw new Error(
    "Release State store policy differs from the protected-store contract",
  );
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
const migrationText = migrationBytes.toString("utf8").toLowerCase();
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
    `PASS Release State static contract ${sha256Json(releaseStateSchema)}; migration ${migrationSha256}; store ${storePolicy.bindingStatus}.`,
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
  if (snapshot.eventHash !== input.receipts.at(-1).eventHash) {
    throw new Error("Release State terminal head does not match receipts");
  }
  console.log(
    `PASS Release State: ${input.events.length} events; head ${snapshot.sequence}/${snapshot.eventHash}; input ${sha256Bytes(await readFile(inputPath))}.`,
  );
}
