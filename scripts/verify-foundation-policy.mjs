import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict, sha256Json } from "./lib/canonical-json.mjs";
import {
  projectContainmentDimensions,
  verifyPhaseSequence,
} from "./lib/release-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDirectory = path.join(root, "config");
const contractDirectory = path.join(root, "contracts");

const jsonFiles = async (directory) =>
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, "en"));

const files = [
  ...(await jsonFiles(configDirectory)),
  ...(await jsonFiles(contractDirectory)),
];
const hashes = {};
for (const file of files) {
  const value = await readJsonStrict(file);
  hashes[path.relative(root, file).replaceAll("\\", "/")] = sha256Json(value);
}

const assertClosedKeys = (value, expectedKeys, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} has an unexpected field set`);
  }
};

const assertBlockerCodes = (value, label) => {
  if (
    !Array.isArray(value) ||
    value.some((code) => typeof code !== "string" || code.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} blockerCodes must be unique non-empty strings`);
  }
  return value;
};

const activationBlockers = (authority, label) => {
  if (
    authority.schemaVersion !== 1 ||
    !["configured", "unconfigured"].includes(authority.activationStatus)
  ) {
    throw new Error(`${label} activation status is invalid`);
  }
  const blockerCodes = assertBlockerCodes(authority.blockerCodes, label);
  if (
    (authority.activationStatus === "configured") !==
    (blockerCodes.length === 0)
  ) {
    throw new Error(`${label} activation status differs from blockerCodes`);
  }
  return blockerCodes;
};

const policy = await readJsonStrict(
  path.join(configDirectory, "release-variants.json"),
);
verifyPhaseSequence(policy);
projectContainmentDimensions(policy, policy.initialStandard);
projectContainmentDimensions(policy, policy.targetStandard);

const providerPolicy = await readJsonStrict(
  path.join(configDirectory, "provider-policy.json"),
);
const stateStorePolicy = await readJsonStrict(
  path.join(configDirectory, "release-state-store.json"),
);
const approvalPolicy = await readJsonStrict(
  path.join(configDirectory, "approval-policy.json"),
);
const dbContract = await readJsonStrict(
  path.join(configDirectory, "db-compatibility-contract.json"),
);
const foundationBaseline = await readJsonStrict(
  path.join(configDirectory, "foundation-baseline.json"),
);
const metricsRetentionPolicy = await readJsonStrict(
  path.join(configDirectory, "metrics-retention-policy.json"),
);
const startupBurstContract = await readJsonStrict(
  path.join(contractDirectory, "persistence-release-a-startup-bursts-v1.json"),
);
const [
  legacyContinuousSourceSchema,
  legacyCompanionSourceSchema,
  continuousSourceSchema,
  companionSourceSchema,
  continuousEvidenceSchema,
  companionEvidenceSchema,
  ...acceptanceProductionModules
] = await Promise.all([
  readJsonStrict(
    path.join(
      contractDirectory,
      "continuous-production-probe-source-v1.schema.json",
    ),
  ),
  readJsonStrict(
    path.join(
      contractDirectory,
      "companion-recovery-drill-source-v1.schema.json",
    ),
  ),
  readJsonStrict(
    path.join(
      contractDirectory,
      "continuous-production-probe-source-v2.schema.json",
    ),
  ),
  readJsonStrict(
    path.join(
      contractDirectory,
      "companion-recovery-drill-source-v2.schema.json",
    ),
  ),
  readJsonStrict(
    path.join(contractDirectory, "continuous-production-probe-v1.schema.json"),
  ),
  readJsonStrict(
    path.join(contractDirectory, "companion-recovery-drill-v1.schema.json"),
  ),
  ...[
    "acceptanceEvidenceAuthority.mjs",
    "acceptanceEvidenceInputs.mjs",
    "collect-acceptance-evidence-source.mjs",
  ].map((fileName) =>
    readFile(path.join(root, "scripts", "release-state", fileName), "utf8"),
  ),
]);

assertClosedKeys(
  stateStorePolicy,
  [
    "schemaVersion",
    "bindingStatus",
    "engine",
    "postgresMajor",
    "timezone",
    "databaseUrlEnvironmentName",
    "tlsMode",
    "allowedHosts",
    "allowedDatabases",
    "allowedExecutorRoles",
    "connectTimeoutMilliseconds",
    "statementTimeoutMilliseconds",
    "maximumEvidenceObjectBytes",
    "credentialRotationDays",
    "productionCaSha256",
    "localContainerImage",
    "migrations",
    "migrationSetSha256",
    "blockerCodes",
  ],
  "Release State store policy",
);
const expectedReleaseStateMigrations = [
  "ops/release-state/migrations/0001_release_state_store.sql",
  "ops/release-state/migrations/0002_acceptance_evidence_chains.sql",
];
if (
  !Array.isArray(stateStorePolicy.migrations) ||
  stateStorePolicy.migrations.length !==
    expectedReleaseStateMigrations.length ||
  stateStorePolicy.migrations.some((migration, index) => {
    try {
      assertClosedKeys(
        migration,
        ["path", "sha256"],
        `Release State migration ${index}`,
      );
    } catch {
      return true;
    }
    return (
      migration.path !== expectedReleaseStateMigrations[index] ||
      !/^[0-9a-f]{64}$/.test(migration.sha256)
    );
  }) ||
  !/^[0-9a-f]{64}$/.test(stateStorePolicy.migrationSetSha256)
) {
  throw new Error("Release State ordered migration authority is invalid");
}

if (
  legacyContinuousSourceSchema["x-foundation-lifecycle"] !== "migration-only" ||
  legacyCompanionSourceSchema["x-foundation-lifecycle"] !== "migration-only" ||
  continuousSourceSchema.$id !==
    "urn:event-shopping-planner:continuous-production-probe-source:v2" ||
  continuousSourceSchema.properties?.sourceKind?.const !==
    "continuous-production-probe-source/v2" ||
  companionSourceSchema.$id !==
    "urn:event-shopping-planner:companion-recovery-drill-source:v2" ||
  companionSourceSchema.properties?.sourceKind?.const !==
    "companion-recovery-drill-source/v2" ||
  continuousSourceSchema.additionalProperties !== false ||
  companionSourceSchema.additionalProperties !== false ||
  continuousEvidenceSchema.additionalProperties !== false ||
  companionEvidenceSchema.additionalProperties !== false ||
  !continuousEvidenceSchema.required?.includes("releaseAEvidenceAuthority") ||
  !continuousEvidenceSchema.$defs?.sample?.required?.includes(
    "sampleChainCommit",
  ) ||
  !continuousEvidenceSchema.$defs?.sample?.required?.includes(
    "sampleEvidence",
  ) ||
  !companionEvidenceSchema.required?.includes("releaseAEvidenceAuthority") ||
  JSON.stringify(continuousEvidenceSchema).includes(
    "continuous-production-probe-source:v1",
  ) ||
  JSON.stringify(companionEvidenceSchema).includes(
    "companion-recovery-drill-source:v1",
  )
) {
  throw new Error("Acceptance authority JSON Schema set is not closed");
}
for (const productionModule of acceptanceProductionModules) {
  if (
    productionModule.includes("continuous-production-probe-source/v1") ||
    productionModule.includes("companion-recovery-drill-source/v1") ||
    productionModule.includes("continuous-production-probe-source-v1.schema") ||
    productionModule.includes("companion-recovery-drill-source-v1.schema")
  ) {
    throw new Error(
      "Production acceptance code reaches a migration-only source",
    );
  }
}

assertClosedKeys(
  foundationBaseline,
  [
    "schemaVersion",
    "implementationTreeBaselineSha",
    "measurementSourceSha",
    "bootstrapBaselineSourceSha",
    "baselineEvidence",
    "baselineEvidenceSha256",
    "externalBindings",
    "blockers",
  ],
  "Foundation baseline",
);
if (
  foundationBaseline.schemaVersion !== 1 ||
  !Array.isArray(foundationBaseline.blockers)
) {
  throw new Error("Foundation baseline blocker authority is invalid");
}
const baselineBlockers = foundationBaseline.blockers.map((blocker) => {
  assertClosedKeys(blocker, ["id", "blocks", "reason"], "Baseline blocker");
  if (
    typeof blocker.id !== "string" ||
    blocker.id.length === 0 ||
    !Array.isArray(blocker.blocks) ||
    blocker.blocks.length === 0 ||
    blocker.blocks.some(
      (gate) => typeof gate !== "string" || gate.length === 0,
    ) ||
    typeof blocker.reason !== "string" ||
    blocker.reason.length === 0
  ) {
    throw new Error("Foundation baseline blocker is invalid");
  }
  return blocker.id;
});
if (new Set(baselineBlockers).size !== baselineBlockers.length) {
  throw new Error("Foundation baseline blocker ids must be unique");
}
const hasBootstrapBaselineBlocker = baselineBlockers.includes(
  "P0-BOOTSTRAP-BASELINE",
);
if (
  (foundationBaseline.bootstrapBaselineSourceSha === null) !==
  hasBootstrapBaselineBlocker
) {
  throw new Error(
    "Foundation bootstrap baseline source and blocker must resolve together",
  );
}
if (
  foundationBaseline.bootstrapBaselineSourceSha !== null &&
  !/^[0-9a-f]{40}$/.test(foundationBaseline.bootstrapBaselineSourceSha)
) {
  throw new Error("Foundation bootstrap baseline source SHA is invalid");
}

assertClosedKeys(
  metricsRetentionPolicy,
  [
    "schemaVersion",
    "primaryRawRetentionDays",
    "cspSanitizedRetentionDays",
    "cron",
    "batchSize",
    "maximumBatchesPerRun",
    "lockTimeoutMilliseconds",
    "statementTimeoutMilliseconds",
    "lastSuccessBlockingAfterSeconds",
    "verificationWorkflowMinute",
    "requiredTargets",
    "deleteOwner",
    "verificationOwner",
    "backupRetentionOwner",
    "activationStatus",
    "blockerCodes",
  ],
  "Metrics retention policy",
);
const retentionBlockers = activationBlockers(
  metricsRetentionPolicy,
  "Metrics retention policy",
);
if (
  metricsRetentionPolicy.activationStatus === "configured" &&
  (typeof metricsRetentionPolicy.backupRetentionOwner !== "string" ||
    metricsRetentionPolicy.backupRetentionOwner.length === 0)
) {
  throw new Error(
    "Configured metrics retention requires a backup retention owner",
  );
}

assertClosedKeys(
  startupBurstContract,
  ["schemaVersion", "profiles", "activationStatus", "blockerCodes"],
  "Startup burst contract",
);
const startupBurstBlockers = activationBlockers(
  startupBurstContract,
  "Startup burst contract",
);

const blockers = [
  ...(policy.activationBlockers ?? []),
  ...(providerPolicy.blockerCodes ?? []),
  ...(stateStorePolicy.blockerCodes ?? []),
  ...(approvalPolicy.blockerCodes ?? []),
  ...(dbContract.blockerCodes ?? []),
  ...baselineBlockers,
  ...retentionBlockers,
  ...startupBurstBlockers,
];

if (
  process.argv.includes("--require-production-ready") &&
  blockers.length > 0
) {
  throw new Error(
    `Foundation production activation blocked: ${[...new Set(blockers)].join(", ")}`,
  );
}

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        policyHashes: hashes,
        productionActivationReady: blockers.length === 0,
        blockerCodes: [...new Set(blockers)].sort(),
      },
      null,
      2,
    )}\n`,
  );
} else {
  console.log(
    `PASS foundation policy: ${files.length} JSON files; production activation ${
      blockers.length === 0 ? "ready" : `blocked (${new Set(blockers).size})`
    }.`,
  );
}
