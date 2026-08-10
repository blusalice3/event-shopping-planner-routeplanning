import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  assertBackupDatabaseReceipt,
  assertSafeRestoreProjectForCleanup,
  collectAndStoreBackupRestoreRehearsal,
  executeBackupProviderOperation,
  readStoredBackupRestoreRehearsal,
} from "./backup-restore-rehearsal.mjs";
import {
  assertBackupRestoreProviderContract,
  assertConfiguredBackupRestorePolicy,
} from "./backup-restore-rehearsal-policy.mjs";

const basePrerequisitePolicy = JSON.parse(
  await readFile(
    new URL(
      "../../config/phase-exit-external-prerequisites.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const unconfiguredProviderContract = JSON.parse(
  await readFile(
    new URL(
      "../../config/backup-restore-provider-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const sourceSha = "1".repeat(40);
const namespace = "backup-rehearsal-test";
const fingerprint = "2".repeat(64);
const databaseHead = "3".repeat(64);
const integritySha256 = "4".repeat(64);
const sourceProjectRef = "abcdefghijklmnopqrst";
const restoreProjectRef = "abcdefghijklmnopqrsu";
const migrationVersion = "20260810010000";
const sourceCa =
  "-----BEGIN CERTIFICATE-----\nsource-ca-fixture\n-----END CERTIFICATE-----";
const restoreCa =
  "-----BEGIN CERTIFICATE-----\nrestore-ca-fixture\n-----END CERTIFICATE-----";
const token = "backup-provider-token-must-never-appear";
const recoveryPointAt = "2026-08-09T12:03:00.000Z";
const sourceProject = Object.freeze({
  ref: sourceProjectRef,
  organizationSlug: "organization-authority-1",
  name: "event-shopping-production",
  region: "ap-northeast-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  databaseHost: "source.db.acme.test",
  status: "ACTIVE_HEALTHY",
});
const restoreProject = Object.freeze({
  ref: restoreProjectRef,
  organizationSlug: "organization-authority-1",
  name: "phase-exit-backup-restore-run-1",
  region: "ap-northeast-1",
  createdAt: "2026-08-09T12:03:30.000Z",
  databaseHost: "restore.db.acme.test",
  status: "ACTIVE_HEALTHY",
});
const oidcReceipt = {
  uri: `release-state://${namespace}/evidence/${"a".repeat(64)}`,
  sha256: "a".repeat(64),
};
const current = {
  head: { sequence: 7, eventHash: "b".repeat(64) },
  records: [{ event: { namespace } }],
  snapshot: {
    currentDbCompatibility: {
      contractUri: "urn:event-shopping-planner:db-compatibility:v1",
      fingerprint,
    },
  },
};
const oidcAuthority = {
  approvalPolicy: { repository: "acme/planner" },
  runId: "7001",
  runAttempt: "2",
};

const configuredPrerequisitePolicy = () => {
  const policy = structuredClone(basePrerequisitePolicy);
  policy.backupRestore = {
    ...policy.backupRestore,
    bindingStatus: "configured",
    provider: "supabase",
    apiOrigin: "https://api.supabase.com",
    sourceProjectRef,
    restoreTarget: {
      ...policy.backupRestore.restoreTarget,
      projectRef: restoreProjectRef,
    },
    owner: "github-team:acme/backup-operators",
  };
  policy.blockerCodes = policy.blockerCodes.filter(
    (code) => !code.startsWith("backup-"),
  );
  return policy;
};

const operation = (method, pathTemplate, successStatusCodes) => ({
  method,
  pathTemplate,
  successStatusCodes,
});

const configuredProviderContract = () => ({
  schemaVersion: 2,
  kind: "backup-restore-provider-contract/v2",
  bindingStatus: "configured",
  provider: "supabase",
  api: {
    authentication: {
      scheme: "bearer",
      credentialEnvironmentName: "FOUNDATION_BACKUP_API_TOKEN",
    },
    restoreMode: "dashboard-new-project",
    backupReadyState: "COMPLETED",
    projectReadyState: "ACTIVE_HEALTHY",
    maximumResponseBytes: 64 * 1024,
    requestTimeoutMilliseconds: 5000,
    cleanupPolling: { intervalMilliseconds: 100, maximumAttempts: 4 },
    operations: {
      confirmRestoreDeleted: operation(
        "GET",
        "/v1/projects/{restoreProjectRef}",
        [200, 404],
      ),
      deleteRestoreProject: operation(
        "DELETE",
        "/v1/projects/{restoreProjectRef}",
        [200],
      ),
      getRestoreProject: operation(
        "GET",
        "/v1/projects/{restoreProjectRef}",
        [200],
      ),
      getSourceProject: operation(
        "GET",
        "/v1/projects/{sourceProjectRef}",
        [200],
      ),
      listSourceBackups: operation(
        "GET",
        "/v1/projects/{sourceProjectRef}/database/backups",
        [200],
      ),
    },
  },
  database: {
    connectTimeoutMilliseconds: 5000,
    statementTimeoutMilliseconds: 10_000,
    postgresMajor: 17,
    tlsMode: "verify-full",
    integrityFunction: "read_foundation_backup_restore_integrity",
    integrityMigrationVersion: migrationVersion,
    queryName: "foundation-backup-restore-integrity-v2",
    source: {
      databaseUrlEnvironmentName: "FOUNDATION_BACKUP_SOURCE_DATABASE_URL",
      databaseCaEnvironmentName: "FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM",
      allowedHosts: ["source.db.acme.test"],
      allowedPorts: [5432],
      allowedDatabases: ["postgres"],
      allowedRoles: ["foundation_backup_source_reader"],
      caSha256: sha256Bytes(Buffer.from(sourceCa)),
    },
    restore: {
      databaseUrlEnvironmentName: "FOUNDATION_BACKUP_RESTORE_DATABASE_URL",
      databaseCaEnvironmentName: "FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM",
      allowedHosts: ["restore.db.acme.test"],
      allowedPorts: [5432],
      allowedDatabases: ["postgres"],
      allowedRoles: ["foundation_backup_restore_reader"],
      caSha256: sha256Bytes(Buffer.from(restoreCa)),
    },
  },
});

const environment = {
  GITHUB_SHA: sourceSha,
  FOUNDATION_BACKUP_API_TOKEN: token,
  FOUNDATION_BACKUP_SOURCE_DATABASE_URL:
    "postgresql://foundation_backup_source_reader:source-password@source.db.acme.test/postgres?sslmode=verify-full",
  FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM: sourceCa,
  FOUNDATION_BACKUP_RESTORE_DATABASE_URL:
    "postgresql://foundation_backup_restore_reader:restore-password@restore.db.acme.test/postgres?sslmode=verify-full",
  FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM: restoreCa,
};

const operationTimes = Object.freeze({
  listSourceBackups: ["2026-08-09T12:04:00.000Z", "2026-08-09T12:04:01.000Z"],
  getSourceProject: ["2026-08-09T12:04:02.000Z", "2026-08-09T12:04:03.000Z"],
  getRestoreProject: ["2026-08-09T12:04:04.000Z", "2026-08-09T12:04:05.000Z"],
  recheckRestoreProject: [
    "2026-08-09T12:04:05.600Z",
    "2026-08-09T12:04:05.700Z",
  ],
  deleteRestoreProject: [
    "2026-08-09T12:04:06.000Z",
    "2026-08-09T12:04:07.000Z",
  ],
  confirmRestoreDeleted: [
    "2026-08-09T12:04:08.000Z",
    "2026-08-09T12:04:09.000Z",
  ],
});

const renderPath = (template, variables) =>
  template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name) =>
    encodeURIComponent(variables[name]),
  );

const providerResult = (
  contract,
  operationName,
  variables,
  {
    project,
    pendingCleanup = false,
    pendingCleanupProject = restoreProject,
    pendingCleanupState = "ACTIVE_HEALTHY",
    occurrence = 1,
  } = {},
) => {
  const descriptor = contract.api.operations[operationName];
  let normalized;
  let status = descriptor.successStatusCodes[0];
  if (operationName === "listSourceBackups") {
    normalized = {
      resourceId: "77",
      state: "COMPLETED",
      backup: {
        id: "77",
        insertedAt: "2026-08-09T12:00:00.000Z",
        isPhysicalBackup: true,
        region: "ap-northeast-1",
        recoveryPointAt,
      },
      project: null,
    };
  } else if (operationName === "getSourceProject") {
    const value = project ?? sourceProject;
    normalized = {
      resourceId: value.ref,
      state: value.status,
      backup: null,
      project: { ...value },
    };
  } else if (operationName === "getRestoreProject") {
    const value = project ?? restoreProject;
    normalized = {
      resourceId: value.ref,
      state: value.status,
      backup: null,
      project: { ...value },
    };
  } else if (operationName === "confirmRestoreDeleted" && pendingCleanup) {
    normalized = {
      resourceId: restoreProjectRef,
      state: pendingCleanupState,
      backup: null,
      project: {
        ...pendingCleanupProject,
        status: pendingCleanupState,
      },
    };
    status = 200;
  } else {
    normalized = {
      resourceId: restoreProjectRef,
      state: "deleted",
      backup: null,
      project: null,
    };
    status = operationName === "confirmRestoreDeleted" ? 404 : 200;
  }
  const responseBytes = canonicalJsonBytes({ operationName, status });
  return {
    receipt: {
      operation: operationName,
      method: descriptor.method,
      url: new URL(
        renderPath(descriptor.pathTemplate, variables),
        "https://api.supabase.com",
      ).href,
      startedAt:
        operationName === "getRestoreProject" && occurrence > 1
          ? operationTimes.recheckRestoreProject[0]
          : operationTimes[operationName][0],
      completedAt:
        operationName === "getRestoreProject" && occurrence > 1
          ? operationTimes.recheckRestoreProject[1]
          : operationTimes[operationName][1],
      status,
      contentType: "application/json",
      providerRequestId: `request-${operationName}`,
      requestBodySha256: sha256Bytes(Buffer.alloc(0)),
      requestBodyByteLength: 0,
      responseBodySha256: sha256Bytes(responseBytes),
      responseBodyByteLength: responseBytes.length,
    },
    normalized,
  };
};

const databaseReceipt = (target) => ({
  target,
  projectRef: target === "source" ? sourceProjectRef : restoreProjectRef,
  host: `${target}.db.acme.test`,
  port: 5432,
  database: "postgres",
  role:
    target === "source"
      ? "foundation_backup_source_reader"
      : "foundation_backup_restore_reader",
  tlsMode: "verify-full",
  transactionReadOnly: true,
  postgresMajor: 17,
  queryName: "foundation-backup-restore-integrity-v2",
  observedAt: "2026-08-09T12:04:05.500Z",
  authorization: {
    roleAttributes: {
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
    },
    memberships: [],
    ownedObjectCount: 0,
    privileges: {
      schemaUsage: true,
      schemaCreate: false,
      databaseCreate: false,
      tableCount: 4,
      anyTableSelect: false,
      anyTableInsert: false,
      anyTableUpdate: false,
      anyTableDelete: false,
      anyTableTruncate: false,
      anyTableReferences: false,
      anyTableTrigger: false,
      integrityFunctionExecute: true,
      integrityFunctionSecurityDefiner: true,
      executablePublicFunctions: [
        "public.read_foundation_backup_restore_integrity()",
      ],
    },
    denialProbes: [
      {
        operation: "delete-known-public-table",
        sqlState: "42501",
        targetSha256: "5".repeat(64),
      },
      {
        operation: "create-public-table",
        sqlState: "42501",
        targetSha256: "6".repeat(64),
      },
    ],
  },
  databaseHead,
  migrationVersion,
  compatibilityFingerprint: fingerprint,
  integritySha256,
});

const memoryStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = "2026-08-09T12:04:10.000Z";
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        mediaType,
        committedAt,
      });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
        replayed: false,
      };
    },
    async readEvidence({ sha256 }) {
      const value = objects.get(sha256);
      return value === undefined
        ? null
        : { ...value, bytes: Buffer.from(value.bytes) };
    },
  };
};

const collectFixture = async ({
  providerOverride,
  databaseOverride,
  environmentOverride,
  providerContractOverride,
} = {}) => {
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  if (providerContractOverride) providerContractOverride(providerContract);
  const runtimeEnvironment = { ...environment, ...environmentOverride };
  const store = memoryStore();
  const calls = [];
  const operationCounts = new Map();
  const observation = await collectAndStoreBackupRestoreRehearsal(
    {
      current,
      environment: runtimeEnvironment,
      namespace,
      oidcAuthority,
      oidcReceipt,
      prerequisitePolicy,
      providerContract,
      store,
    },
    {
      readOidcAuthority: async () => ({ receipt: { trusted: true } }),
      executeProviderOperation: async ({ operation: name, variables }) => {
        calls.push(name);
        const count = (operationCounts.get(name) ?? 0) + 1;
        operationCounts.set(name, count);
        if (providerOverride) {
          const replacement = providerOverride({
            name,
            variables,
            contract: providerContract,
            calls,
            count,
          });
          if (replacement !== undefined) return replacement;
        }
        return providerResult(providerContract, name, variables, {
          occurrence: count,
        });
      },
      observeDatabase: async (options) => {
        const { target } = options;
        if (databaseOverride) {
          const replacement = databaseOverride(target, options);
          if (replacement !== undefined) return replacement;
        }
        return databaseReceipt(target);
      },
      sleep: async () => {},
      readState: async () => current,
    },
  );
  return {
    observation,
    store,
    calls,
    prerequisitePolicy,
    providerContract,
  };
};

test("accepts only the official read/inspect/delete Supabase API contract", () => {
  assert.equal(
    assertBackupRestoreProviderContract(unconfiguredProviderContract)
      .bindingStatus,
    "unconfigured",
  );
  const providerContract = configuredProviderContract();
  const configured = assertConfiguredBackupRestorePolicy({
    prerequisitePolicy: configuredPrerequisitePolicy(),
    providerContract,
  });
  assert.equal(
    configured.providerContract.api.restoreMode,
    "dashboard-new-project",
  );
  assert.equal(
    Object.values(providerContract.api.operations).some(
      ({ method, pathTemplate }) =>
        method === "POST" || pathTemplate.includes("restore-pitr"),
    ),
    false,
  );

  for (const mutate of [
    (contract) => {
      contract.api.operations.listSourceBackups.pathTemplate =
        "/v1/projects/{sourceProjectRef}/database/backups/restore-pitr";
    },
    (contract) => {
      contract.api.operations.getRestoreProject.method = "POST";
    },
    (contract) => {
      contract.api.restoreMode = "in-place";
    },
    (contract) => {
      contract.database.source.allowedPorts = [6543];
    },
    (contract) => {
      contract.database.source.allowedDatabases = ["application"];
    },
    (contract) => {
      contract.database.source.allowedHosts.push("zz-secondary.db.acme.test");
    },
    (contract) => {
      contract.database.source.allowedRoles = ["additional_backup_reader"];
    },
  ]) {
    const drifted = configuredProviderContract();
    mutate(drifted);
    assert.throws(
      () =>
        assertBackupRestoreProviderContract(drifted, {
          requireConfigured: true,
        }),
      /official endpoint|authority|in-place|ports|database name/u,
    );
  }
});

test("rejects non-integer backup IDs and invalid RFC 3339 timestamps", async () => {
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  const latestRecoveryUnix = Date.parse(recoveryPointAt) / 1000;
  for (const [id, insertedAt, expected] of [
    ["77", "2026-08-09T12:00:00Z", /no completed physical backup/u],
    [77, "2026-08-09T12:00:00.1234567890Z", /RFC 3339 timestamp/u],
    [77, "2026-02-30T12:00:00Z", /RFC 3339 timestamp/u],
  ]) {
    await assert.rejects(
      executeBackupProviderOperation({
        prerequisitePolicy,
        providerContract,
        operation: "listSourceBackups",
        variables: { sourceProjectRef },
        token,
        clock: () => Date.parse(operationTimes.listSourceBackups[0]),
        fetchImpl: async () =>
          new Response(
            canonicalJsonBytes({
              region: "ap-northeast-1",
              walg_enabled: true,
              pitr_enabled: true,
              backups: [
                {
                  id,
                  is_physical_backup: true,
                  status: "COMPLETED",
                  inserted_at: insertedAt,
                },
              ],
              physical_backup_data: {
                earliest_physical_backup_date_unix: latestRecoveryUnix - 3600,
                latest_physical_backup_date_unix: latestRecoveryUnix,
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      }),
      expected,
    );
  }
});

test("normalizes the official backup list and project response shapes", async () => {
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  const requests = [];
  let backupResponseBytes;
  const latestRecoveryUnix = Date.parse(recoveryPointAt) / 1000;
  const result = await executeBackupProviderOperation({
    prerequisitePolicy,
    providerContract,
    operation: "listSourceBackups",
    variables: { sourceProjectRef },
    token,
    clock: (() => {
      const values = [
        Date.parse(operationTimes.listSourceBackups[0]),
        Date.parse(operationTimes.listSourceBackups[1]),
      ];
      return () => values.shift();
    })(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      backupResponseBytes = canonicalJsonBytes({
        region: "ap-northeast-1",
        walg_enabled: true,
        pitr_enabled: true,
        backups: [
          {
            id: 77,
            is_physical_backup: true,
            status: "COMPLETED",
            inserted_at: "2026-08-09T12:00:00Z",
          },
        ],
        physical_backup_data: {
          earliest_physical_backup_date_unix: latestRecoveryUnix - 3600,
          latest_physical_backup_date_unix: latestRecoveryUnix,
        },
      });
      return new Response(backupResponseBytes, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "provider-request-1",
        },
      });
    },
  });
  assert.equal(result.normalized.resourceId, "77");
  assert.equal(
    result.receipt.responseBodySha256,
    sha256Bytes(backupResponseBytes),
  );
  assert.equal(result.normalized.backup.insertedAt, "2026-08-09T12:00:00.000Z");
  assert.equal(result.normalized.backup.region, "ap-northeast-1");
  assert.equal(result.normalized.backup.recoveryPointAt, recoveryPointAt);
  assert.equal(
    requests[0].url,
    `https://api.supabase.com/v1/projects/${sourceProjectRef}/database/backups`,
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(Object.hasOwn(requests[0].options, "body"), false);

  const cleanupClockValues = [
    Date.parse(operationTimes.confirmRestoreDeleted[0]),
    Date.parse(operationTimes.confirmRestoreDeleted[1]),
  ];
  const cleanupResponseBytes = canonicalJsonBytes({
    ref: restoreProject.ref,
    organization_slug: restoreProject.organizationSlug,
    name: restoreProject.name,
    region: restoreProject.region,
    created_at: "2026-08-09T12:03:30.123456Z",
    status: "GOING_DOWN",
    database: { host: restoreProject.databaseHost },
  });
  const cleanupPending = await executeBackupProviderOperation({
    prerequisitePolicy,
    providerContract,
    operation: "confirmRestoreDeleted",
    variables: { restoreProjectRef },
    token,
    clock: () => cleanupClockValues.shift(),
    fetchImpl: async () =>
      new Response(cleanupResponseBytes, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(cleanupPending.normalized.state, "GOING_DOWN");
  assert.equal(cleanupPending.normalized.project.ref, restoreProjectRef);
  assert.equal(
    cleanupPending.receipt.responseBodySha256,
    sha256Bytes(cleanupResponseBytes),
  );
  assert.equal(
    cleanupPending.normalized.project.createdAt,
    "2026-08-09T12:03:30.123Z",
  );
});

test("fails closed before DELETE for every unsafe restore-project identity", async () => {
  const providerContract = configuredProviderContract();
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const backupReceipt = providerResult(providerContract, "listSourceBackups", {
    sourceProjectRef,
  });
  const sourceReceipt = providerResult(providerContract, "getSourceProject", {
    sourceProjectRef,
  });
  const mutations = [
    { organizationSlug: "other-organization" },
    { region: "us-east-1" },
    { databaseHost: sourceProject.databaseHost },
    { name: "unrelated-staging-project" },
    { ref: sourceProjectRef },
    { createdAt: "2026-08-08T00:00:00.000Z" },
    { createdAt: "2026-08-07T00:00:00.000Z" },
  ];
  for (const mutation of mutations) {
    const changed = { ...restoreProject, ...mutation };
    const restoreReceipt = providerResult(
      providerContract,
      "getRestoreProject",
      { restoreProjectRef },
      { project: changed },
    );
    assert.throws(
      () =>
        assertSafeRestoreProjectForCleanup({
          backup: prerequisitePolicy.backupRestore,
          backupReceipt,
          sourceProjectReceipt: sourceReceipt,
          restoreProjectReceipt: restoreReceipt,
        }),
      /cleanup target/u,
    );
  }

  const calls = [];
  await assert.rejects(
    collectAndStoreBackupRestoreRehearsal(
      {
        current,
        environment,
        namespace,
        oidcAuthority,
        oidcReceipt,
        prerequisitePolicy,
        providerContract,
        store: memoryStore(),
      },
      {
        readOidcAuthority: async () => ({}),
        executeProviderOperation: async ({ operation: name, variables }) => {
          calls.push(name);
          return providerResult(providerContract, name, variables, {
            project:
              name === "getRestoreProject"
                ? { ...restoreProject, organizationSlug: "wrong-org" }
                : undefined,
          });
        },
        observeDatabase: async ({ target }) => databaseReceipt(target),
      },
    ),
    /cleanup target identity/u,
  );
  assert.deepEqual(calls, [
    "listSourceBackups",
    "getSourceProject",
    "getRestoreProject",
  ]);
});

test("collects a new-project restore, compares DB authority, and confirms deletion", async () => {
  const fixture = await collectFixture();
  assert.deepEqual(fixture.calls, [
    "listSourceBackups",
    "getSourceProject",
    "getRestoreProject",
    "getRestoreProject",
    "deleteRestoreProject",
    "confirmRestoreDeleted",
  ]);
  assert.equal(fixture.observation.result.observedRecoveryPointSeconds, 30);
  assert.equal(fixture.observation.result.observedRecoveryTimeSeconds, 36);
  assert.equal(fixture.observation.result.dataLossObserved, false);
  assert.equal(fixture.observation.result.outcome, "succeeded");
  const stored = await readStoredBackupRestoreRehearsal({
    store: fixture.store,
    namespace,
    reference: fixture.observation.rawRehearsal,
    prerequisitePolicy: fixture.prerequisitePolicy,
    providerContract: fixture.providerContract,
  });
  assert.equal(stored.raw.schemaVersion, 2);
  assert.equal(stored.raw.provider.restoreId, restoreProjectRef);
  const rawText = stored.bytes.toString("utf8");
  for (const [name, secret] of Object.entries(environment)) {
    if (!name.startsWith("FOUNDATION_BACKUP_")) continue;
    assert.equal(rawText.includes(secret), false);
  }
});

test("rechecks the exact restore identity immediately before DELETE", async () => {
  const calls = [];
  await assert.rejects(
    collectFixture({
      providerOverride: ({ name, variables, contract, count }) => {
        calls.push(name);
        if (name !== "getRestoreProject" || count !== 2) return undefined;
        return providerResult(contract, name, variables, {
          occurrence: count,
          project: {
            ...restoreProject,
            databaseHost: "replacement.db.acme.test",
          },
        });
      },
    }),
    /changed before cleanup/u,
  );
  assert.equal(calls.includes("deleteRestoreProject"), false);
});

test("pins sanitized TLS URLs to the inspected Management API database hosts", async () => {
  const observedConnections = new Map();
  await collectFixture({
    databaseOverride: (target, { connection }) => {
      observedConnections.set(target, connection);
      return databaseReceipt(target);
    },
  });
  for (const [target, connection] of observedConnections) {
    const runtimeUrl = new URL(connection.connectionString);
    assert.equal(runtimeUrl.search, "", `${target} URL retained query options`);
    assert.equal(runtimeUrl.hash, "");
    assert.equal(connection.projection.port, 5432);
  }

  const calls = [];
  await assert.rejects(
    collectFixture({
      providerOverride: ({ name, variables, contract }) => {
        calls.push(name);
        if (name !== "getRestoreProject") return undefined;
        return providerResult(contract, name, variables, {
          project: {
            ...restoreProject,
            databaseHost: "unrelated.db.acme.test",
          },
        });
      },
    }),
    /database endpoints differ/u,
  );
  assert.equal(calls.includes("deleteRestoreProject"), false);

  await assert.rejects(
    collectFixture({
      environmentOverride: {
        FOUNDATION_BACKUP_SOURCE_DATABASE_URL:
          "postgresql://foundation_backup_source_reader:source-password@source.db.acme.test/postgres?sslmode=disable",
      },
    }),
    /configured authority/u,
  );
});

test("rejects an overlapping database endpoint or decoded password before provider access", async () => {
  let providerCalls = 0;
  await assert.rejects(
    collectFixture({
      providerContractOverride: (contract) => {
        contract.database.restore.allowedHosts = ["source.db.acme.test"];
        contract.database.restore.allowedDatabases = ["postgres"];
      },
      environmentOverride: {
        FOUNDATION_BACKUP_RESTORE_DATABASE_URL:
          "postgresql://foundation_backup_restore_reader:restore-password@source.db.acme.test/postgres?sslmode=verify-full",
      },
      providerOverride: () => {
        providerCalls += 1;
      },
    }),
    /authorities overlap/u,
  );
  assert.equal(providerCalls, 0);

  await assert.rejects(
    collectFixture({
      environmentOverride: {
        FOUNDATION_BACKUP_SOURCE_DATABASE_URL:
          "postgresql://foundation_backup_source_reader:shared%2Dpassword@source.db.acme.test/postgres?sslmode=verify-full",
        FOUNDATION_BACKUP_RESTORE_DATABASE_URL:
          "postgresql://foundation_backup_restore_reader:%73hared-password@restore.db.acme.test/postgres?sslmode=verify-full",
      },
      providerOverride: () => {
        providerCalls += 1;
      },
    }),
    /authorities overlap/u,
  );
  assert.equal(providerCalls, 0);
});

test("polls cleanup and always deletes an authorized target after DB failure", async () => {
  let cleanupPoll = 0;
  const fixture = await collectFixture({
    providerOverride: ({ name, variables, contract }) => {
      if (name !== "confirmRestoreDeleted") return undefined;
      cleanupPoll += 1;
      return providerResult(contract, name, variables, {
        pendingCleanup: cleanupPoll === 1,
        pendingCleanupState: "GOING_DOWN",
      });
    },
  });
  assert.equal(
    fixture.calls.filter((name) => name === "confirmRestoreDeleted").length,
    2,
  );

  const calls = [];
  await assert.rejects(
    collectFixture({
      providerOverride: ({ name }) => {
        calls.push(name);
        return undefined;
      },
      databaseOverride: () => {
        throw new Error("injected DB integrity failure");
      },
    }),
    /Backup database observations failed|injected DB integrity failure/u,
  );
  assert.deepEqual(calls.slice(-2), [
    "deleteRestoreProject",
    "confirmRestoreDeleted",
  ]);
});

test("waits for both database observers to settle before deleting the restore project", async () => {
  const calls = [];
  let releaseRestore;
  const restoreSettled = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const collection = collectFixture({
    providerOverride: ({ name }) => {
      calls.push(name);
      return undefined;
    },
    databaseOverride: (target) => {
      if (target === "source") {
        throw new Error("source observation failed");
      }
      return restoreSettled.then(() => databaseReceipt("restore"));
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("deleteRestoreProject"), false);
  releaseRestore();
  await assert.rejects(collection, /source observation failed/u);
  assert.deepEqual(calls.slice(-2), [
    "deleteRestoreProject",
    "confirmRestoreDeleted",
  ]);
});

test("requires function-only readers with distinct roles and migration head", () => {
  const providerContract = configuredProviderContract();
  const expectation = {
    target: "source",
    projectRef: sourceProjectRef,
    authority: providerContract.database.source,
    expectedFingerprint: fingerprint,
    expectedMigrationVersion: migrationVersion,
  };
  assert.equal(
    assertBackupDatabaseReceipt(databaseReceipt("source"), expectation).role,
    "foundation_backup_source_reader",
  );
  for (const mutate of [
    (receipt) => {
      receipt.authorization.memberships = ["service_role"];
    },
    (receipt) => {
      receipt.authorization.ownedObjectCount = 1;
    },
    (receipt) => {
      receipt.authorization.privileges.anyTableSelect = true;
    },
    (receipt) => {
      receipt.authorization.privileges.anyTableDelete = true;
    },
    (receipt) => {
      receipt.authorization.privileges.integrityFunctionExecute = false;
    },
    (receipt) => {
      receipt.authorization.privileges.executablePublicFunctions.push(
        "public.unapproved_function()",
      );
    },
    (receipt) => {
      receipt.migrationVersion = "20260809000000";
    },
  ]) {
    const receipt = databaseReceipt("source");
    mutate(receipt);
    assert.throws(
      () => assertBackupDatabaseReceipt(receipt, expectation),
      /authorization|receipt/u,
    );
  }
});

test("tracked migrations contain no password and use core PostgreSQL SHA-256", async () => {
  const [observer, integrity] = await Promise.all([
    readFile(
      new URL(
        "../../supabase/migrations/20260810000000_foundation_application_observer.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/20260810010000_foundation_backup_integrity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(observer, /create role foundation_db_observer/iu);
  assert.match(observer, /default_transaction_read_only = on/iu);
  assert.match(
    observer,
    /revoke all on all tables in schema public from public/iu,
  );
  assert.match(
    observer,
    /revoke execute on all functions in schema public from public/iu,
  );
  assert.match(
    observer,
    /alter default privileges\s+revoke execute on functions from public/iu,
  );
  assert.match(
    observer,
    /alter default privileges in schema public[\s\S]*revoke execute on functions from public/iu,
  );
  assert.match(
    observer,
    /revoke all\s+on all tables in schema supabase_migrations\s+from foundation_db_observer/iu,
  );
  assert.match(observer, /errcode = '42710'/iu);
  assert.match(observer, /foundation_db_observer role already exists/iu);
  assert.match(integrity, /pg_catalog\.sha256/iu);
  assert.match(integrity, /set search_path = pg_catalog, pg_temp/iu);
  assert.match(integrity, /string_agg\(row_sha256, '' order by row_sha256\)/iu);
  assert.match(integrity, /errcode = '42710'/iu);
  assert.match(integrity, /foundation_backup_source_reader/iu);
  assert.match(integrity, /foundation_backup_restore_reader/iu);
  assert.match(
    integrity,
    /revoke execute on all functions in schema public from public/iu,
  );
  assert.match(
    integrity,
    /alter default privileges in schema public\s+revoke execute on functions from public/iu,
  );
  assert.doesNotMatch(`${observer}\n${integrity}`, /password\s+['"]/iu);
  assert.doesNotMatch(
    `${observer}\n${integrity}`,
    /create role[^;]*if not exists/iu,
  );
  assert.doesNotMatch(
    integrity,
    /extensions\.digest|restore-pitr|hashtextextended|bit_xor/iu,
  );
});
