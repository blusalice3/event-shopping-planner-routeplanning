import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toDatabaseRow,
  validatePersistenceReleaseAMetricsRequest,
} from "../api/persistence-release-a-metrics.mjs";
import {
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = await readJsonStrict(
  path.join(root, "contracts", "persistence-release-a-metrics-v1.json"),
);
const startupContract = await readJsonStrict(
  path.join(root, "contracts", "persistence-release-a-startup-bursts-v1.json"),
);
const [clientSource, apiSource, migrationSource, providerPolicy] =
  await Promise.all([
    readFile(
      path.join(root, "src", "utils", "persistenceReleaseAMetrics.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "api", "persistence-release-a-metrics.mjs"),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "supabase",
        "migrations",
        "20260803000000_persistence_release_a_metrics.sql",
      ),
      "utf8",
    ),
    readJsonStrict(path.join(root, "config", "provider-policy.json")),
  ]);

if (
  contract.transport.endpoint !== "/api/persistence-release-a-metrics" ||
  contract.transport.method !== "POST" ||
  contract.transport.credentials !== "omit" ||
  contract.transport.cache !== "no-store" ||
  contract.transport.keepalive !== true ||
  contract.transport.maximumBytes !== 1024 ||
  contract.handler.upstreamTimeoutMilliseconds !== 5000 ||
  contract.handler.redirect !== "error" ||
  contract.handler.prefer !== "return=minimal"
) {
  throw new Error("Metrics transport/handler contract is invalid");
}
const expectedStartupProfiles = new Map([
  ["fresh", "ready"],
  ["populated-no-recovery", "ready"],
  ["recovery-candidate", "recovery-required"],
]);
if (
  startupContract.schemaVersion !== 1 ||
  startupContract.profiles.length !== expectedStartupProfiles.size
) {
  throw new Error("Startup burst characterization identity is invalid");
}
for (const profile of startupContract.profiles) {
  const expectedOutcome = expectedStartupProfiles.get(profile.id);
  const fixturePath = path.resolve(root, profile.fixturePath ?? "");
  const fixtureBytes = await readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  if (
    expectedOutcome === undefined ||
    profile.startupCompletion !== expectedOutcome ||
    profile.quietPeriodMilliseconds !== 2000 ||
    profile.fixtureSha256 !== sha256Bytes(fixtureBytes) ||
    fixture.profileId !== profile.id ||
    fixture.schemaVersion !== 1 ||
    profile.expectedTuples.length !== 1 ||
    profile.expectedTuples[0].eventName !== "startup" ||
    profile.expectedTuples[0].outcome !== expectedOutcome ||
    profile.expectedTuples[0].minimumCount !== 1 ||
    profile.expectedTuples[0].maximumCount !== 1
  ) {
    throw new Error(`Startup burst fixture differs: ${profile.id}`);
  }
}
for (const environmentName of contract.handler.requiredEnvironmentNames) {
  if (
    !apiSource.includes(environmentName) ||
    !providerPolicy.requiredEnvironmentNames.includes(environmentName)
  ) {
    throw new Error(
      `Required metrics environment is not bound end-to-end: ${environmentName}`,
    );
  }
}
for (const environmentName of contract.handler.forbiddenEnvironmentNames) {
  if (
    !apiSource.includes(environmentName) ||
    !providerPolicy.forbiddenEnvironmentNames.includes(environmentName)
  ) {
    throw new Error(
      `Forbidden metrics environment is not denied end-to-end: ${environmentName}`,
    );
  }
}
for (const [condition, response] of Object.entries(
  contract.handler.responses,
)) {
  const bodyValue = Object.values(response.body)[0];
  if (
    !apiSource.includes(String(response.status)) ||
    (condition !== "accepted" && !apiSource.includes(`"${condition}"`)) ||
    (condition === "accepted" && bodyValue !== true)
  ) {
    throw new Error(
      `Metrics response is absent from the handler: ${condition}`,
    );
  }
}

const baseRequest = {
  schemaVersion: 1,
  buildId: "a".repeat(40),
  browserFamily: "chromium",
  appMode: "browser-tab",
  online: true,
};
const requests = [];
for (const [name, eventContract] of Object.entries(contract.events)) {
  if (name === "cleanup") {
    for (const mode of eventContract.modes) {
      for (const outcome of eventContract.outcomesWithoutReason) {
        requests.push({
          ...baseRequest,
          event: { version: 1, name, outcome, mode },
        });
      }
      for (const outcome of eventContract.outcomesWithReason) {
        for (const reason of eventContract.reasonsByOutcome[outcome]) {
          requests.push({
            ...baseRequest,
            event: { version: 1, name, outcome, mode, reason },
          });
        }
      }
    }
    continue;
  }
  for (const outcome of eventContract.outcomes) {
    if (name === "startup") {
      for (const durationBucket of eventContract.durationBuckets) {
        requests.push({
          ...baseRequest,
          event: { version: 1, name, outcome, durationBucket },
        });
      }
    } else {
      requests.push({
        ...baseRequest,
        event: { version: 1, name, outcome },
      });
    }
  }
}

const expectedDatabaseKeys = [...contract.databaseColumns].sort();
for (const request of requests) {
  if (!validatePersistenceReleaseAMetricsRequest(request)) {
    throw new Error(
      `API rejected a characterized request: ${JSON.stringify(request.event)}`,
    );
  }
  const row = toDatabaseRow(request);
  const actualDatabaseKeys = Object.keys(row).sort();
  if (
    actualDatabaseKeys.length !== expectedDatabaseKeys.length ||
    actualDatabaseKeys.some((key, index) => key !== expectedDatabaseKeys[index])
  ) {
    throw new Error(
      "API to SQL mapping differs from the characterized columns",
    );
  }
  if (
    row.schema_version !== request.schemaVersion ||
    row.event_version !== request.event.version ||
    row.event_name !== request.event.name ||
    row.outcome !== request.event.outcome ||
    row.build_id !== request.buildId ||
    row.browser_family !== request.browserFamily ||
    row.app_mode !== request.appMode ||
    row.online !== request.online
  ) {
    throw new Error("API to SQL mapping changed a characterized value");
  }
  for (const value of Object.values(request.event)) {
    if (typeof value !== "string") continue;
    for (const [owner, source] of [
      ["client", clientSource],
      ["API", apiSource],
      ["SQL", migrationSource],
    ]) {
      if (!source.includes(value)) {
        throw new Error(
          `${owner} does not contain characterized event value: ${value}`,
        );
      }
    }
  }
}

for (const request of requests.slice(0, 10)) {
  if (
    validatePersistenceReleaseAMetricsRequest({
      ...request,
      userContent: "must-never-be-accepted",
    })
  ) {
    throw new Error("Metrics API accepted an unknown top-level field");
  }
}

for (const request of requests) {
  for (const key of contract.requestKeys) {
    const withoutKey = { ...request };
    delete withoutKey[key];
    if (validatePersistenceReleaseAMetricsRequest(withoutKey)) {
      throw new Error(`Metrics API accepted a request without ${key}`);
    }
  }
  if (
    validatePersistenceReleaseAMetricsRequest({
      ...request,
      event: { ...request.event, uncharacterized: true },
    })
  ) {
    throw new Error("Metrics API accepted an unknown event field");
  }
}
if (
  !apiSource.includes('redirect: "error"') ||
  !apiSource.includes("AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)") ||
  !apiSource.includes('prefer: "return=minimal"') ||
  !apiSource.includes('new TextDecoder("utf-8", { fatal: true })')
) {
  throw new Error("Metrics upstream or UTF-8 hardening is incomplete");
}

console.log(
  `PASS metrics characterization: ${requests.length} closed requests; contract ${sha256Json(contract)}.`,
);
