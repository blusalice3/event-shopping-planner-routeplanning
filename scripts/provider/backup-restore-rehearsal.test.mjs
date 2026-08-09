import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  assertBackupDatabaseReceipt,
  assertBackupRestoreRehearsalRaw,
  collectAndStoreBackupRestoreRehearsal,
  executeBackupProviderOperation,
  observeBackupRestoreDatabase,
  readStoredBackupRestoreRehearsal,
  readStoredBackupRestoreRehearsalAuthority,
  summarizeBackupRestoreRehearsal,
} from "./backup-restore-rehearsal.mjs";
import {
  assertBackupRestoreProviderContract,
  assertConfiguredBackupRestorePolicy,
} from "./backup-restore-rehearsal-policy.mjs";
import {
  parseBackupRestoreRehearsalArguments,
  runBackupRestoreRehearsalCli,
} from "./collect-backup-restore-rehearsal.mjs";

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
const sourceCa =
  "-----BEGIN CERTIFICATE-----\nsource-ca-fixture\n-----END CERTIFICATE-----";
const restoreCa =
  "-----BEGIN CERTIFICATE-----\nrestore-ca-fixture\n-----END CERTIFICATE-----";
const token = "backup-provider-token-must-never-appear";
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

const responseShape = (recoveryPoint) => ({
  resourceIdPointer: "/id",
  statePointer: "/state",
  recoveryPointAtPointer: recoveryPoint ? "/recovery_point_at" : null,
});

const operation = (
  method,
  pathTemplate,
  requestBodyTemplate,
  recoveryPoint,
  status,
) => ({
  method,
  pathTemplate,
  requestBodyTemplate,
  successStatusCodes: [status],
  response: responseShape(recoveryPoint),
});

const configuredProviderContract = () => ({
  schemaVersion: 1,
  kind: "backup-restore-provider-contract/v1",
  bindingStatus: "configured",
  provider: "supabase",
  api: {
    authentication: {
      scheme: "bearer",
      credentialEnvironmentName: "FOUNDATION_BACKUP_API_TOKEN",
    },
    backupMode: "pitr",
    maximumResponseBytes: 64 * 1024,
    requestTimeoutMilliseconds: 5000,
    polling: { intervalMilliseconds: 100, maximumAttempts: 4 },
    operations: {
      cleanupRestore: operation(
        "DELETE",
        "/v1/projects/{restoreProjectRef}/restores/{restoreId}",
        null,
        false,
        202,
      ),
      createBackup: operation(
        "POST",
        "/v1/projects/{sourceProjectRef}/backups",
        { type: "pitr" },
        true,
        202,
      ),
      getBackup: operation(
        "GET",
        "/v1/projects/{sourceProjectRef}/backups/{backupId}",
        null,
        true,
        200,
      ),
      getCleanup: operation(
        "GET",
        "/v1/projects/{restoreProjectRef}/restores/{restoreId}",
        null,
        false,
        200,
      ),
      getRestore: operation(
        "GET",
        "/v1/projects/{restoreProjectRef}/restores/{restoreId}",
        null,
        false,
        200,
      ),
      restoreBackup: operation(
        "POST",
        "/v1/projects/{restoreProjectRef}/restores",
        { backup_id: "{backupId}" },
        false,
        202,
      ),
    },
    states: {
      backupPending: ["backup-pending"],
      backupReady: "backup-ready",
      cleanupPending: ["cleanup-pending"],
      cleanupReady: "cleanup-ready",
      failed: ["failed"],
      restorePending: ["restore-pending"],
      restoreReady: "restore-ready",
    },
  },
  database: {
    connectTimeoutMilliseconds: 5000,
    statementTimeoutMilliseconds: 10_000,
    postgresMajor: 17,
    tlsMode: "verify-full",
    integrityFunction: "read_foundation_backup_restore_integrity",
    queryName: "foundation-backup-restore-integrity-v1",
    source: {
      databaseUrlEnvironmentName: "FOUNDATION_BACKUP_SOURCE_DATABASE_URL",
      databaseCaEnvironmentName: "FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM",
      allowedHosts: ["source.db.acme.test"],
      allowedDatabases: ["app_source"],
      allowedRoles: ["backup_source"],
      caSha256: sha256Bytes(Buffer.from(sourceCa)),
    },
    restore: {
      databaseUrlEnvironmentName: "FOUNDATION_BACKUP_RESTORE_DATABASE_URL",
      databaseCaEnvironmentName: "FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM",
      allowedHosts: ["restore.db.acme.test"],
      allowedDatabases: ["app_restore"],
      allowedRoles: ["backup_restore"],
      caSha256: sha256Bytes(Buffer.from(restoreCa)),
    },
  },
});

const environment = {
  GITHUB_SHA: sourceSha,
  FOUNDATION_BACKUP_API_TOKEN: token,
  FOUNDATION_BACKUP_SOURCE_DATABASE_URL:
    "postgresql://backup_source:source-password@source.db.acme.test/app_source?sslmode=verify-full",
  FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM: sourceCa,
  FOUNDATION_BACKUP_RESTORE_DATABASE_URL:
    "postgresql://backup_restore:restore-password@restore.db.acme.test/app_restore?sslmode=verify-full",
  FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM: restoreCa,
};

const operationTimes = {
  createBackup: ["2026-08-09T12:05:00.000Z", "2026-08-09T12:05:01.000Z"],
  getBackup: ["2026-08-09T12:05:04.000Z", "2026-08-09T12:05:05.000Z"],
  restoreBackup: ["2026-08-09T12:05:06.000Z", "2026-08-09T12:05:07.000Z"],
  getRestore: ["2026-08-09T12:05:49.000Z", "2026-08-09T12:05:50.000Z"],
  cleanupRestore: ["2026-08-09T12:05:51.000Z", "2026-08-09T12:05:52.000Z"],
  getCleanup: ["2026-08-09T12:05:54.000Z", "2026-08-09T12:05:55.000Z"],
};
const operationState = {
  createBackup: "backup-pending",
  getBackup: "backup-ready",
  restoreBackup: "restore-pending",
  getRestore: "restore-ready",
  cleanupRestore: "cleanup-pending",
  getCleanup: "cleanup-ready",
};

const renderPath = (template, variables) =>
  template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name) =>
    encodeURIComponent(variables[name]),
  );

const renderBody = (value, variables) => {
  if (typeof value === "string" && /^\{[A-Za-z][A-Za-z0-9]*\}$/u.test(value)) {
    return variables[value.slice(1, -1)];
  }
  if (Array.isArray(value))
    return value.map((entry) => renderBody(entry, variables));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        renderBody(entry, variables),
      ]),
    );
  }
  return value;
};

const providerResult = (
  contract,
  operationName,
  variables,
  { state = operationState[operationName], resourceId } = {},
) => {
  const descriptor = contract.api.operations[operationName];
  const id =
    resourceId ??
    (["createBackup", "getBackup"].includes(operationName)
      ? "backup-id-immutable"
      : "restore-id-immutable");
  const requestBytes =
    descriptor.requestBodyTemplate === null
      ? Buffer.alloc(0)
      : canonicalJsonBytes(
          renderBody(descriptor.requestBodyTemplate, variables),
        );
  const recoveryPointAt =
    descriptor.response.recoveryPointAtPointer === null
      ? null
      : "2026-08-09T12:03:00.000Z";
  const responseBytes = canonicalJsonBytes({
    id,
    state,
    ...(recoveryPointAt === null ? {} : { recovery_point_at: recoveryPointAt }),
  });
  return {
    receipt: {
      operation: operationName,
      method: descriptor.method,
      url: new URL(
        renderPath(descriptor.pathTemplate, variables),
        "https://api.supabase.com",
      ).href,
      startedAt: operationTimes[operationName][0],
      completedAt: operationTimes[operationName][1],
      status: descriptor.successStatusCodes[0],
      contentType: "application/json",
      providerRequestId: `request-${operationName}`,
      requestBodySha256:
        requestBytes.length === 0
          ? sha256Bytes(Buffer.alloc(0))
          : sha256Bytes(requestBytes),
      requestBodyByteLength: requestBytes.length,
      responseBodySha256: sha256Bytes(responseBytes),
      responseBodyByteLength: responseBytes.length,
    },
    normalized: { resourceId: id, state, recoveryPointAt },
  };
};

const databaseReceipt = (target) => ({
  target,
  projectRef: target === "source" ? sourceProjectRef : restoreProjectRef,
  host: `${target}.db.acme.test`,
  database: target === "source" ? "app_source" : "app_restore",
  role: target === "source" ? "backup_source" : "backup_restore",
  tlsMode: "verify-full",
  transactionReadOnly: true,
  postgresMajor: 17,
  queryName: "foundation-backup-restore-integrity-v1",
  observedAt: "2026-08-09T12:05:50.500Z",
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
      allTablesSelect: true,
      anyTableInsert: false,
      anyTableUpdate: false,
      anyTableDelete: false,
      anyTableTruncate: false,
      anyTableReferences: false,
      anyTableTrigger: false,
      integrityFunctionExecute: true,
      integrityFunctionSecurityDefiner: true,
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
  compatibilityFingerprint: fingerprint,
  integritySha256,
});

test("rejects overprivileged or self-claimed database authorization receipts", () => {
  const providerContract = configuredProviderContract();
  const expected = {
    target: "source",
    projectRef: sourceProjectRef,
    authority: providerContract.database.source,
    expectedFingerprint: fingerprint,
  };
  const mutations = [
    (receipt) => {
      receipt.authorization.roleAttributes.superuser = true;
    },
    (receipt) => {
      receipt.authorization.memberships = ["postgres"];
    },
    (receipt) => {
      receipt.authorization.ownedObjectCount = 1;
    },
    (receipt) => {
      receipt.authorization.privileges.anyTableDelete = true;
    },
    (receipt) => {
      receipt.authorization.privileges.schemaCreate = true;
    },
    (receipt) => {
      receipt.authorization.denialProbes[0].sqlState = "25006";
    },
    (receipt) => {
      receipt.authorization.denialProbes[0].operation =
        "caller-claimed-read-only";
    },
  ];
  for (const mutate of mutations) {
    const receipt = databaseReceipt("source");
    mutate(receipt);
    assert.throws(
      () => assertBackupDatabaseReceipt(receipt, expected),
      /authorization|denial|read-only/u,
    );
  }
});

const memoryStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = "2026-08-09T12:06:00.000Z";
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
  extraOptions = {},
} = {}) => {
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  const store = memoryStore();
  const calls = [];
  const observation = await collectAndStoreBackupRestoreRehearsal(
    {
      current,
      environment,
      namespace,
      oidcAuthority,
      oidcReceipt,
      prerequisitePolicy,
      providerContract,
      store,
      ...extraOptions,
    },
    {
      readOidcAuthority: async () => ({ receipt: { trusted: true } }),
      executeProviderOperation: async ({ operation: name, variables }) => {
        calls.push(name);
        if (providerOverride) {
          const replacement = providerOverride({
            name,
            variables,
            contract: providerContract,
            calls,
          });
          if (replacement !== undefined) return replacement;
        }
        return providerResult(providerContract, name, variables);
      },
      observeDatabase: async ({ target }) => {
        if (databaseOverride) {
          const replacement = databaseOverride(target);
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

test("closes configured Supabase API and disjoint TLS DB authority shapes", () => {
  assert.equal(
    assertBackupRestoreProviderContract(unconfiguredProviderContract)
      .bindingStatus,
    "unconfigured",
  );
  assert.throws(
    () =>
      assertBackupRestoreProviderContract(unconfiguredProviderContract, {
        requireConfigured: true,
      }),
    /not configured/,
  );
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  const configured = assertConfiguredBackupRestorePolicy({
    prerequisitePolicy,
    providerContract,
  });
  assert.equal(configured.backup.provider, "supabase");
  assert.match(configured.providerContractSha256, /^[0-9a-f]{64}$/u);

  for (const mutate of [
    (contract) => {
      contract.api.operations.createBackup.method = "GET";
    },
    (contract) => {
      contract.api.operations.restoreBackup.pathTemplate =
        "/v1/projects/{restoreProjectRef}/restores";
      contract.api.operations.restoreBackup.requestBodyTemplate = {};
    },
    (contract) => {
      contract.api.states.restoreReady = contract.api.states.restorePending[0];
    },
    (contract) => {
      contract.database.restore.allowedRoles =
        contract.database.source.allowedRoles;
    },
    (contract) => {
      contract.callerSucceeded = true;
    },
  ]) {
    const drifted = configuredProviderContract();
    mutate(drifted);
    assert.throws(() =>
      assertBackupRestoreProviderContract(drifted, {
        requireConfigured: true,
      }),
    );
  }
});

test("runs backup, immutable-ID poll, nonproduction restore, DB comparison, and cleanup", async () => {
  const { observation, store, calls, prerequisitePolicy, providerContract } =
    await collectFixture();
  assert.deepEqual(calls, [
    "createBackup",
    "getBackup",
    "restoreBackup",
    "getRestore",
    "cleanupRestore",
    "getCleanup",
  ]);
  assert.equal(observation.result.observedRecoveryPointSeconds, 120);
  assert.equal(observation.result.observedRecoveryTimeSeconds, 45);
  assert.equal(observation.result.dataLossObserved, false);
  assert.equal(observation.result.outcome, "succeeded");
  const stored = await readStoredBackupRestoreRehearsal({
    store,
    namespace,
    reference: observation.rawRehearsal,
    prerequisitePolicy,
    providerContract,
  });
  assert.equal(stored.result.backupId, "backup-id-immutable");
  assert.equal(
    stored.raw.database.source.databaseHead,
    stored.raw.database.restore.databaseHead,
  );
  const rawText = stored.bytes.toString("utf8");
  for (const [name, secret] of Object.entries(environment)) {
    if (!name.startsWith("FOUNDATION_BACKUP_")) continue;
    assert.equal(rawText.includes(secret), false);
  }
});

test("RTO includes TLS database integrity verification after provider readiness", async () => {
  const fixture = await collectFixture();
  const stored = fixture.store.objects.get(
    fixture.observation.rawRehearsal.sha256,
  );
  const raw = JSON.parse(stored.bytes.toString("utf8"));
  const prerequisitePolicy = structuredClone(fixture.prerequisitePolicy);
  prerequisitePolicy.backupRestore.recoveryTimeObjectiveSeconds = 44;
  raw.policy.recoveryTimeObjectiveSeconds = 44;
  raw.policy.prerequisitePolicySha256 = sha256Bytes(
    canonicalJsonBytes(prerequisitePolicy),
  );
  assert.throws(
    () =>
      summarizeBackupRestoreRehearsal(raw, {
        prerequisitePolicy,
        providerContract: fixture.providerContract,
      }),
    /exceeds its RPO or RTO/,
  );
});

test("rejects caller authority, production target, unknown state, ID drift, and DB drift", async () => {
  const validOptions = {
    current,
    environment,
    namespace,
    oidcAuthority,
    oidcReceipt,
    prerequisitePolicy: configuredPrerequisitePolicy(),
    providerContract: configuredProviderContract(),
    store: memoryStore(),
    callerStatus: true,
  };
  await assert.rejects(
    collectAndStoreBackupRestoreRehearsal(validOptions),
    /unknown or missing fields/,
  );

  const production = configuredPrerequisitePolicy();
  production.backupRestore.restoreTarget.projectRef =
    production.backupRestore.sourceProjectRef;
  const withoutCallerStatus = { ...validOptions };
  delete withoutCallerStatus.callerStatus;
  await assert.rejects(
    collectAndStoreBackupRestoreRehearsal({
      ...withoutCallerStatus,
      sourceSha,
    }),
    /unknown or missing fields/,
  );
  await assert.rejects(
    collectAndStoreBackupRestoreRehearsal({
      ...withoutCallerStatus,
      prerequisitePolicy: production,
    }),
    /production/,
  );

  await assert.rejects(
    collectFixture({
      providerOverride: ({ name, variables, contract }) =>
        name === "getBackup"
          ? providerResult(contract, name, variables, { state: "alien-state" })
          : undefined,
    }),
    /receipt is invalid|unknown provider state/,
  );
  await assert.rejects(
    collectFixture({
      providerOverride: ({ name, variables, contract }) =>
        name === "getBackup"
          ? providerResult(contract, name, variables, {
              resourceId: "changed-backup-id",
            })
          : undefined,
    }),
    /immutable provider ID changed/,
  );
  const failed = await assert.rejects(
    collectFixture({
      databaseOverride: (target) =>
        target === "restore"
          ? { ...databaseReceipt(target), integritySha256: "9".repeat(64) }
          : undefined,
    }),
    /differs from source integrity/,
  );
  assert.equal(failed, undefined);
});

test("always cleans a created restore after DB verification failure", async () => {
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
    /injected DB integrity failure/,
  );
  assert.deepEqual(calls.slice(-2), ["cleanupRestore", "getCleanup"]);
});

test("rejects tamper, wrong media, stale authority, and current fingerprint drift", async () => {
  const fixture = await collectFixture();
  const reference = fixture.observation.rawRehearsal;
  const original = fixture.store.objects.get(reference.sha256);
  fixture.store.objects.set(reference.sha256, {
    ...original,
    bytes: Buffer.concat([original.bytes, Buffer.from(" ")]),
  });
  await assert.rejects(
    readStoredBackupRestoreRehearsal({
      store: fixture.store,
      namespace,
      reference,
      prerequisitePolicy: fixture.prerequisitePolicy,
      providerContract: fixture.providerContract,
    }),
    /differs/,
  );
  fixture.store.objects.set(reference.sha256, {
    ...original,
    mediaType: "application/json",
  });
  await assert.rejects(
    readStoredBackupRestoreRehearsal({
      store: fixture.store,
      namespace,
      reference,
      prerequisitePolicy: fixture.prerequisitePolicy,
      providerContract: fixture.providerContract,
    }),
    /differs/,
  );
  fixture.store.objects.set(reference.sha256, original);
  let oidcRead = null;
  const live = await readStoredBackupRestoreRehearsalAuthority(
    {
      store: fixture.store,
      namespace,
      reference,
      prerequisitePolicy: fixture.prerequisitePolicy,
      providerContract: fixture.providerContract,
      current,
      approvalPolicy: { repository: "acme/planner" },
      now: () => Date.parse("2026-08-09T12:06:00.000Z"),
    },
    {
      readOidcAuthority: async (options) => {
        oidcRead = options;
      },
    },
  );
  assert.equal(live.result.outcome, "succeeded");
  assert.equal(oidcRead.sourceSha, sourceSha);
  assert.equal(oidcRead.runId, "7001");
  assert.equal(oidcRead.runAttempt, "2");
  await assert.rejects(
    readStoredBackupRestoreRehearsalAuthority({
      store: fixture.store,
      namespace,
      reference,
      prerequisitePolicy: fixture.prerequisitePolicy,
      providerContract: fixture.providerContract,
      current,
      approvalPolicy: {},
      now: () => Date.parse("2026-09-10T12:05:55.000Z"),
    }),
    /stale or future/,
  );
  await assert.rejects(
    readStoredBackupRestoreRehearsalAuthority({
      store: fixture.store,
      namespace,
      reference,
      prerequisitePolicy: fixture.prerequisitePolicy,
      providerContract: fixture.providerContract,
      current: {
        ...current,
        snapshot: {
          currentDbCompatibility: { fingerprint: "8".repeat(64) },
        },
      },
      approvalPolicy: {},
      now: () => Date.parse("2026-08-09T12:06:00.000Z"),
    }),
    /current Release State/,
  );
});

test("generic HTTP executor derives only configured URL/body/status/pointers", async () => {
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  const variables = { sourceProjectRef };
  const responseBody = canonicalJsonBytes({
    id: "backup-id-immutable",
    state: "backup-ready",
    recovery_point_at: "2026-08-09T12:03:00.000Z",
  });
  const requests = [];
  const result = await executeBackupProviderOperation({
    prerequisitePolicy,
    providerContract,
    operation: "createBackup",
    variables,
    token,
    clock: (() => {
      const values = [
        Date.parse("2026-08-09T12:05:00.000Z"),
        Date.parse("2026-08-09T12:05:01.000Z"),
      ];
      return () => values.shift();
    })(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(responseBody, {
        status: 202,
        headers: {
          "content-type": "application/json",
          "x-request-id": "provider-request-1",
        },
      });
    },
  });
  assert.equal(result.normalized.state, "backup-ready");
  assert.equal(
    requests[0].url,
    `https://api.supabase.com/v1/projects/${sourceProjectRef}/backups`,
  );
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(
    result.receipt.requestBodySha256,
    sha256Bytes(canonicalJsonBytes({ type: "pitr" })),
  );
  await assert.rejects(
    executeBackupProviderOperation({
      prerequisitePolicy,
      providerContract,
      operation: "createBackup",
      variables,
      token,
      fetchImpl: async () =>
        new Response('{"error":"unknown"}', {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    }),
    /response is unexpected/,
  );
});

test("default DB executor enforces verify-full read-only identity and fixed integrity function", async () => {
  const queries = [];
  const client = {
    async connect() {},
    async end() {},
    async query(query) {
      queries.push(query);
      if (typeof query === "string") {
        if (/^(?:delete from|create table)/u.test(query)) {
          const error = new Error("permission denied");
          error.code = "42501";
          throw error;
        }
        return { rows: [] };
      }
      if (query.name.endsWith("-identity")) {
        return {
          rows: [
            {
              role: "backup_source",
              session_role: "backup_source",
              database: "app_source",
              read_only: "on",
              server_version_num: "170002",
            },
          ],
        };
      }
      if (query.name.endsWith("-role-authority")) {
        return {
          rows: [
            {
              superuser: false,
              create_role: false,
              create_database: false,
              replication: false,
              bypass_rls: false,
            },
          ],
        };
      }
      if (query.name.endsWith("-memberships")) return { rows: [] };
      if (query.name.endsWith("-ownership")) {
        return { rows: [{ owned_object_count: "0" }] };
      }
      if (query.name.endsWith("-privileges")) {
        return {
          rows: [
            {
              table_count: "4",
              first_relation_schema: "public",
              first_relation_name: "events",
              schema_usage: true,
              schema_create: false,
              database_create: false,
              all_tables_select: true,
              any_table_insert: false,
              any_table_update: false,
              any_table_delete: false,
              any_table_truncate: false,
              any_table_references: false,
              any_table_trigger: false,
              integrity_function_execute: true,
              integrity_function_security_definer: true,
            },
          ],
        };
      }
      return {
        rows: [
          {
            database_head: databaseHead,
            compatibility_fingerprint: fingerprint,
            integrity_sha256: integritySha256,
          },
        ],
      };
    },
  };
  const contract = configuredProviderContract();
  const receipt = await observeBackupRestoreDatabase({
    connection: {
      connectionString: environment.FOUNDATION_BACKUP_SOURCE_DATABASE_URL,
      ca: sourceCa,
      projection: {
        host: "source.db.acme.test",
        database: "app_source",
        role: "backup_source",
      },
    },
    authority: contract.database.source,
    databaseContract: contract.database,
    target: "source",
    projectRef: sourceProjectRef,
    clock: () => Date.parse("2026-08-09T12:05:50.500Z"),
    createClient: async () => client,
  });
  assert.equal(receipt.transactionReadOnly, true);
  assert.equal(receipt.authorization.denialProbes.length, 2);
  assert.equal(
    queries[0],
    "begin transaction isolation level repeatable read read only",
  );
  assert.equal(
    queries.filter(
      (query) =>
        typeof query === "string" &&
        /^(?:delete from|create table)/u.test(query),
    ).length,
    2,
  );
  assert.match(
    queries.find(
      (query) =>
        typeof query === "object" &&
        query.name === "foundation-backup-restore-integrity-v1",
    ).text,
    /read_foundation_backup_restore_integrity/u,
  );

  const wrongSqlStateClient = {
    ...client,
    async query(query) {
      if (
        typeof query === "string" &&
        /^(?:delete from|create table)/u.test(query)
      ) {
        const error = new Error(
          "transaction is read-only, not permission denied",
        );
        error.code = "25006";
        throw error;
      }
      return client.query(query);
    },
  };
  await assert.rejects(
    observeBackupRestoreDatabase({
      connection: {
        connectionString: environment.FOUNDATION_BACKUP_SOURCE_DATABASE_URL,
        ca: sourceCa,
        projection: {
          host: "source.db.acme.test",
          database: "app_source",
          role: "backup_source",
        },
      },
      authority: contract.database.source,
      databaseContract: contract.database,
      target: "source",
      projectRef: sourceProjectRef,
      clock: () => Date.parse("2026-08-09T12:05:50.500Z"),
      createClient: async () => wrongSqlStateClient,
    }),
    (error) => error?.code === "25006",
  );
});

test("CLI forbids authority flags and fails unconfigured before any network/store access", async () => {
  assert.deepEqual(
    parseBackupRestoreRehearsalArguments([
      "--namespace",
      namespace,
      "--output",
      "backup.json",
    ]),
    { namespace, outputPath: "backup.json" },
  );
  for (const argv of [
    ["--namespace", namespace, "--source-sha", sourceSha],
    ["--namespace", namespace, "--status", "succeeded"],
  ]) {
    assert.throws(
      () => parseBackupRestoreRehearsalArguments(argv),
      /arguments are invalid|Usage/,
    );
  }
  let protectedCalls = 0;
  let storeCalls = 0;
  const loadPolicy = async (filePath) => {
    if (filePath.endsWith("phase-exit-external-prerequisites.json")) {
      return basePrerequisitePolicy;
    }
    if (filePath.endsWith("backup-restore-provider-contract.json")) {
      return unconfiguredProviderContract;
    }
    return {};
  };
  await assert.rejects(
    runBackupRestoreRehearsalCli(
      {
        argv: ["--namespace", namespace, "--output", "backup.json"],
        environment: {},
      },
      {
        loadPolicy,
        assertProtected: async () => {
          protectedCalls += 1;
        },
        createStore: async () => {
          storeCalls += 1;
        },
      },
    ),
    /provider contract is not configured/,
  );
  assert.equal(protectedCalls, 0);
  assert.equal(storeCalls, 0);
});

test("configured CLI derives workflow, OIDC, and collector inputs without project or status flags", async () => {
  const fixture = await collectFixture();
  const prerequisitePolicy = configuredPrerequisitePolicy();
  const providerContract = configuredProviderContract();
  const loaded = [];
  let closed = 0;
  let written = null;
  const cliStore = {
    namespace,
    async close() {
      closed += 1;
    },
  };
  const result = await runBackupRestoreRehearsalCli(
    {
      argv: ["--namespace", namespace, "--output", "backup.json"],
      environment: {
        ...environment,
        RELEASE_STATE_DATABASE_URL: "postgresql://release-state.invalid/store",
        RELEASE_STATE_DATABASE_CA_PEM: "release-state-ca",
      },
      cwd: "D:\\fixture",
      stdout: { write() {} },
    },
    {
      loadPolicy: async (filePath) => {
        loaded.push(filePath);
        if (filePath.endsWith("phase-exit-external-prerequisites.json")) {
          return prerequisitePolicy;
        }
        if (filePath.endsWith("backup-restore-provider-contract.json")) {
          return providerContract;
        }
        if (filePath.endsWith("approval-policy.json")) {
          return { repository: "acme/planner" };
        }
        return { bindingStatus: "configured" };
      },
      assertProtected: async ({ namespace: actual, sourceSha: actualSha }) => {
        assert.equal(actual, namespace);
        assert.equal(actualSha, sourceSha);
        return { runId: "7001", runAttempt: "2" };
      },
      createStore: async ({ namespace: actual }) => {
        assert.equal(actual, namespace);
        return cliStore;
      },
      readState: async () => current,
      collectOidc: async (options) => {
        assert.equal(options.sourceSha, sourceSha);
        assert.equal(options.runId, "7001");
        assert.equal(options.runAttempt, "2");
        return { reference: oidcReceipt };
      },
      collect: async (options, dependencies) => {
        assert.deepEqual(Object.keys(options).sort(), [
          "current",
          "environment",
          "namespace",
          "oidcAuthority",
          "oidcReceipt",
          "prerequisitePolicy",
          "providerContract",
          "store",
        ]);
        assert.equal(options.oidcAuthority.runId, "7001");
        assert.equal(typeof dependencies.readState, "function");
        return fixture.observation;
      },
      writeOutput: async (outputPath, observation) => {
        written = { outputPath, observation };
      },
    },
  );
  assert.equal(result, fixture.observation);
  assert.equal(written.observation, fixture.observation);
  assert.equal(closed, 1);
  assert.equal(loaded.length, 4);
});

test("raw authority rejects arbitrary result booleans and receipt normalization tamper", async () => {
  const fixture = await collectFixture();
  const stored = await readStoredBackupRestoreRehearsal({
    store: fixture.store,
    namespace,
    reference: fixture.observation.rawRehearsal,
    prerequisitePolicy: fixture.prerequisitePolicy,
    providerContract: fixture.providerContract,
  });
  const callerStatus = structuredClone(stored.raw);
  callerStatus.restoreSucceeded = true;
  assert.throws(
    () =>
      assertBackupRestoreRehearsalRaw(callerStatus, {
        prerequisitePolicy: fixture.prerequisitePolicy,
        providerContract: fixture.providerContract,
      }),
    /unknown or missing fields/,
  );
  const changed = structuredClone(stored.raw);
  changed.provider.backupReceipts[1].normalized.resourceId = "caller-backup-id";
  assert.throws(
    () =>
      summarizeBackupRestoreRehearsal(changed, {
        prerequisitePolicy: fixture.prerequisitePolicy,
        providerContract: fixture.providerContract,
      }),
    /lifecycle is invalid/,
  );
});
