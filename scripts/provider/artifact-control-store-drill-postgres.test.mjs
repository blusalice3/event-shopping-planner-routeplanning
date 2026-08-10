import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
  assertArtifactControlStorePostgresReceipt,
  assertConfiguredArtifactControlStoreDrillPolicy,
  executeArtifactControlStorePostgresDrill,
  inspectArtifactControlStoreUnprivilegedRole,
  resolveArtifactControlStoreDrillConnections,
  openDisposableArtifactControlStoreDrill,
} from "./artifact-control-store-drill-postgres.mjs";

const ca =
  "-----BEGIN CERTIFICATE-----\nartifact-drill-test-ca\n-----END CERTIFICATE-----\n";
const policy = () => ({
  schemaVersion: 1,
  bindingStatus: "configured",
  databaseCaEnvironmentName: "ARTIFACT_DRILL_DATABASE_CA_PEM",
  drillAdministratorDatabaseUrlEnvironmentName:
    "ARTIFACT_DRILL_ADMIN_DATABASE_URL",
  drillExecutorDatabaseUrlEnvironmentName:
    "ARTIFACT_DRILL_EXECUTOR_DATABASE_URL",
  deniedReaderProjectionDatabaseUrlEnvironmentName:
    "ARTIFACT_DRILL_DENIED_READER_DATABASE_URL",
  allowedDrillHosts: ["drill-db.acme.com"],
  allowedDrillDatabases: ["artifact_drill"],
  allowedDrillAdministratorRoles: ["drill_admin"],
  allowedDrillExecutorRoles: ["drill_executor"],
  allowedDeniedReaderProjectionRoles: ["drill_denied_reader"],
  databaseCaSha256: sha256Bytes(Buffer.from(ca, "utf8")),
  connectTimeoutMilliseconds: 5000,
  statementTimeoutMilliseconds: 15000,
  schemaResetMode: "dedicated-database-foundation-release-schema",
  providerPreviewAliasSuffix: "drill.acme.com",
  implementation: {
    liveProviderBuildAdapterImplemented: true,
    operationReceiptSemanticValidatorsImplemented: true,
    collectorIdentityBindingImplemented: true,
    roleMembershipClosedSetImplemented: true,
  },
  blockerCodes: [],
});
const environment = () => ({
  RELEASE_STATE_DATABASE_URL:
    "postgresql://production_executor:production-secret@production-db.acme.com/production_release?sslmode=verify-full",
  ARTIFACT_DRILL_DATABASE_CA_PEM: ca,
  ARTIFACT_DRILL_ADMIN_DATABASE_URL:
    "postgresql://drill_admin:administrator-secret@drill-db.acme.com/artifact_drill?sslmode=verify-full",
  ARTIFACT_DRILL_EXECUTOR_DATABASE_URL:
    "postgresql://drill_executor:executor-secret@drill-db.acme.com/artifact_drill?sslmode=verify-full",
  ARTIFACT_DRILL_DENIED_READER_DATABASE_URL:
    "postgresql://drill_denied_reader:denied-reader-secret@drill-db.acme.com/artifact_drill?sslmode=verify-full",
});
const releaseStorePolicy = JSON.parse(
  await readFile(
    new URL("../../config/release-state-store.json", import.meta.url),
    "utf8",
  ),
);
const disposableStorePolicy = () => ({
  ...releaseStorePolicy,
  bindingStatus: "configured",
  allowedHosts: ["production-db.acme.com"],
  allowedDatabases: ["production_release"],
});

test("accepts only the closed configured dedicated database authority", () => {
  const value = policy();
  assert.equal(assertConfiguredArtifactControlStoreDrillPolicy(value), value);
  assert.throws(
    () =>
      assertConfiguredArtifactControlStoreDrillPolicy({
        ...policy(),
        callerDatabaseUrl: "postgresql://caller",
      }),
    /unknown or missing fields/,
  );
});

test("connection resolution requires all three separated credentials", () => {
  const resolved = resolveArtifactControlStoreDrillConnections({
    policy: policy(),
    environment: environment(),
  });
  assert.equal(resolved.administrator.role, "drill_admin");
  assert.equal(resolved.executor.role, "drill_executor");
  assert.equal(resolved.deniedReaderProjection.role, "drill_denied_reader");
  const missingEnvironment = {};
  assert.throws(
    () =>
      resolveArtifactControlStoreDrillConnections({
        policy: policy(),
        environment: missingEnvironment,
      }),
    /environment is absent/,
  );
});

test("connection resolution compares decoded credential bytes", () => {
  const equivalentCredentials = environment();
  equivalentCredentials.ARTIFACT_DRILL_ADMIN_DATABASE_URL =
    "postgresql://drill_admin:shared-secret%21@drill-db.acme.com/artifact_drill?sslmode=verify-full";
  equivalentCredentials.ARTIFACT_DRILL_EXECUTOR_DATABASE_URL =
    "postgresql://drill_executor:shared-secret!@drill-db.acme.com/artifact_drill?sslmode=verify-full";
  assert.throws(
    () =>
      resolveArtifactControlStoreDrillConnections({
        policy: policy(),
        environment: equivalentCredentials,
      }),
    /roles or credentials are not separated/,
  );
});

test("legacy production-reader secret cannot satisfy the denied projection", () => {
  const legacyEnvironment = environment();
  delete legacyEnvironment.ARTIFACT_DRILL_DENIED_READER_DATABASE_URL;
  legacyEnvironment.ARTIFACT_DRILL_PRODUCTION_READER_DATABASE_URL =
    "postgresql://production_reader:legacy-secret@drill-db.acme.com/artifact_drill?sslmode=verify-full";
  assert.throws(
    () =>
      resolveArtifactControlStoreDrillConnections({
        policy: policy(),
        environment: legacyEnvironment,
      }),
    /environment is absent: ARTIFACT_DRILL_DENIED_READER_DATABASE_URL/,
  );
});

test("refuses a production endpoint overlap before opening any pool", async () => {
  let poolCallCount = 0;
  const overlappingEnvironment = environment();
  overlappingEnvironment.RELEASE_STATE_DATABASE_URL =
    "postgresql://production_executor:production-secret@drill-db.acme.com/artifact_drill?sslmode=verify-full";
  await assert.rejects(
    openDisposableArtifactControlStoreDrill(
      {
        policy: policy(),
        storePolicy: {
          bindingStatus: "configured",
          databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
          allowedHosts: ["drill-db.acme.com"],
          allowedDatabases: ["artifact_drill"],
          migrations: [],
        },
        environment: overlappingEnvironment,
        namespace: "artifact-drill-test",
      },
      {
        poolFactory: async () => {
          poolCallCount += 1;
          throw new Error("must not connect");
        },
      },
    ),
    /overlaps a production Release State endpoint/,
  );
  assert.equal(poolCallCount, 0);
});

test("refuses production credential reuse before opening any pool", async () => {
  let poolCallCount = 0;
  const reusedEnvironment = environment();
  reusedEnvironment.RELEASE_STATE_DATABASE_URL =
    "postgresql://production_executor:executor-secret@production-db.acme.com/production_release?sslmode=verify-full";
  await assert.rejects(
    openDisposableArtifactControlStoreDrill(
      {
        policy: policy(),
        storePolicy: disposableStorePolicy(),
        environment: reusedEnvironment,
        namespace: "artifact-drill-test",
      },
      {
        poolFactory: async () => {
          poolCallCount += 1;
          throw new Error("must not connect");
        },
      },
    ),
    /production Release State credentials are not separated/,
  );
  assert.equal(poolCallCount, 0);
});

test("role inspection proves the closed set across every PostgreSQL role", async () => {
  let query;
  const projection = await inspectArtifactControlStoreUnprivilegedRole({
    pool: {
      async query(value) {
        query = value;
        return {
          rowCount: 1,
          rows: [
            {
              rolsuper: false,
              rolcreaterole: false,
              rolcreatedb: false,
              rolcanlogin: true,
              rolreplication: false,
              rolbypassrls: false,
              membership_closed_set: true,
            },
          ],
        };
      },
    },
    expected: { role: "drill_executor" },
    label: "executor",
  });
  assert.equal(projection.memberOfAnyRole, false);
  assert.match(query.text, /from pg_catalog\.pg_roles granted/u);
  assert.match(
    query.text,
    /pg_has_role\(session_user, granted\.oid, 'member'\)/u,
  );
  assert.equal(Object.hasOwn(query, "values"), false);
  await assert.rejects(
    inspectArtifactControlStoreUnprivilegedRole({
      pool: {
        async query() {
          return {
            rowCount: 1,
            rows: [
              {
                rolsuper: false,
                rolcreaterole: false,
                rolcreatedb: false,
                rolcanlogin: true,
                rolreplication: false,
                rolbypassrls: false,
                membership_closed_set: false,
              },
            ],
          };
        },
      },
      expected: { role: "drill_executor" },
      label: "executor",
    }),
    /overprivileged/,
  );
});

const memoryStore = () => {
  const objects = new Map();
  let eventHash = null;
  return {
    namespace: "artifact-drill-test",
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const existing = objects.get(sha256);
      if (existing !== undefined && existing.mediaType !== mediaType) {
        const error = new Error("media conflict");
        error.code = "23505";
        throw error;
      }
      const committedAt = existing?.committedAt ?? "2026-08-09T00:00:00.000Z";
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        committedAt,
        mediaType,
      });
      return {
        uri: `release-state://artifact-drill-test/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
        replayed: existing !== undefined,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
    async compareAndAppend({ expectedSequence, event }) {
      if (eventHash !== null) {
        if (event.appendId.endsWith(eventHash.slice(-12))) {
          return {
            sequence: 1,
            eventHash,
            replayed: true,
            committedAt: "2026-08-09T00:00:00.000Z",
          };
        }
        const error = new Error("stale head");
        error.code = "40001";
        throw error;
      }
      assert.equal(expectedSequence, 0);
      eventHash = sha256Bytes(canonicalJsonBytes(event));
      event.appendId = `${event.appendId.slice(0, -12)}${eventHash.slice(-12)}`;
      return {
        sequence: 1,
        eventHash,
        replayed: false,
        committedAt: "2026-08-09T00:00:00.000Z",
      };
    },
  };
};

const roleProjection = (
  roleSha256,
  label,
  { deniedReader = false, direct = false } = {},
) => ({
  canLogin: true,
  createDatabase: false,
  createRole: false,
  memberOfAnyRole: false,
  replication: false,
  roleSha256,
  rowSecurityBypass: false,
  superuser: false,
  ...(direct
    ? {
        directDenials: ["direct-table-insert", "schema-ddl-create"].map(
          (operation) => ({
            schemaVersion: 1,
            kind: "artifact-drill-postgres-error/v1",
            operation: `${label}-${operation}`,
            roleSha256,
            sqlstate: "42501",
          }),
        ),
        privileges: {
          appendFunctionExecute: !deniedReader,
          directEvidenceWrite: false,
          putFunctionExecute: true,
          schemaCreate: false,
          schemaUsage: true,
          selectEvidence: !deniedReader,
        },
      }
    : {}),
});

const identity = {
  databaseEndpointSha256: "1".repeat(64),
  administratorRoleSha256: "2".repeat(64),
  executorRoleSha256: "3".repeat(64),
  deniedReaderProjectionRoleSha256: "4".repeat(64),
  roleAuthority: {
    administrator: roleProjection("2".repeat(64), "administrator"),
    executor: roleProjection("3".repeat(64), "executor", { direct: true }),
    deniedReaderProjection: roleProjection(
      "4".repeat(64),
      "denied-reader-projection",
      { deniedReader: true, direct: true },
    ),
  },
};

test("derives CAS and denied-reader outcomes from raw PostgreSQL SQLSTATE", async () => {
  const drillStore = memoryStore();
  const deniedReaderProjectionPool = {
    async query() {
      const error = new Error("release namespace executor denied");
      error.code = "42501";
      throw error;
    },
  };
  const result = await executeArtifactControlStorePostgresDrill({
    drillStore,
    deniedReaderProjectionPool,
    namespace: drillStore.namespace,
    identity,
  });
  assert.deepEqual(result, {
    casConflictDenied: true,
    idempotencyVerified: true,
    putReadbackVerified: true,
    readerVisibilityDenied: true,
    readerWriteDenied: true,
    receiptSha256: result.receiptSha256,
  });
  const stored = drillStore.objects.get(result.receiptSha256);
  assert.equal(
    stored.mediaType,
    ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
  );
  const receipt = JSON.parse(stored.bytes.toString("utf8"));
  assert.equal(assertArtifactControlStorePostgresReceipt(receipt), receipt);
  assert.equal(receipt.casConflict.sqlstate, "40001");
  assert.equal(receipt.readerVisibilityDenial.sqlstate, "42501");
  assert.equal(receipt.readerWriteDenial.sqlstate, "42501");
});

test("rejects a caller success value or a non-42501 database denial", async () => {
  for (const code of [null, "25006", "23505"]) {
    const drillStore = memoryStore();
    await assert.rejects(
      executeArtifactControlStorePostgresDrill({
        drillStore,
        deniedReaderProjectionPool: {
          async query() {
            if (code === null) return { rowCount: 1, rows: [{}] };
            const error = new Error("denied");
            error.code = code;
            throw error;
          },
        },
        namespace: drillStore.namespace,
        identity,
      }),
      /SQLSTATE|visibility SQLSTATE differs/,
    );
  }
});

test("receipt validator rejects boolean-only and role-tampered claims", async () => {
  assert.throws(
    () =>
      assertArtifactControlStorePostgresReceipt({
        readerVisibilityDenied: true,
      }),
    /semantics are invalid/,
  );
  const drillStore = memoryStore();
  const result = await executeArtifactControlStorePostgresDrill({
    drillStore,
    deniedReaderProjectionPool: {
      async query() {
        const error = new Error("denied");
        error.code = "42501";
        throw error;
      },
    },
    namespace: drillStore.namespace,
    identity,
  });
  const receipt = JSON.parse(
    drillStore.objects.get(result.receiptSha256).bytes.toString("utf8"),
  );
  receipt.readerVisibilityDenial.roleSha256 = receipt.executorRoleSha256;
  assert.throws(
    () => assertArtifactControlStorePostgresReceipt(receipt),
    /semantics are invalid/,
  );
});

const openFixture = ({ failurePoint = null, cleanupFailure = false } = {}) => {
  const events = [];
  const pools = [];
  const roleRow = {
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: true,
    rolreplication: false,
    rolbypassrls: false,
    membership_closed_set: true,
  };
  const privilegeRow = (deniedReader = false) => ({
    schema_usage: true,
    schema_create: false,
    evidence_select: !deniedReader,
    evidence_insert: false,
    evidence_update: false,
    evidence_delete: false,
    evidence_truncate: false,
    evidence_references: false,
    evidence_trigger: false,
    put_function_execute: true,
    append_function_execute: !deniedReader,
  });
  const poolFactory = async ({ connection }) => {
    const pool = {
      role: connection.role,
      endCount: 0,
      async query(query) {
        const name = typeof query === "object" ? query.name : null;
        const text = typeof query === "string" ? query : query.text;
        events.push(`query:${connection.role}:${name ?? text.slice(0, 24)}`);
        if (name?.startsWith("artifact-drill-session-")) {
          return {
            rowCount: 1,
            rows: [{ role: connection.role, database: connection.database }],
          };
        }
        if (name?.startsWith("artifact-drill-role-authority-")) {
          return { rowCount: 1, rows: [{ ...roleRow }] };
        }
        if (name?.startsWith("artifact-drill-store-privileges-")) {
          if (
            failurePoint === "post-provision-inspection" &&
            connection.role === "drill_executor"
          ) {
            throw new Error("post-provision inspection failed");
          }
          return {
            rowCount: 1,
            rows: [privilegeRow(connection.role === "drill_denied_reader")],
          };
        }
        if (
          connection.role !== "drill_admin" &&
          (text.includes(
            "insert into foundation_release.release_state_heads",
          ) ||
            text.includes("create table foundation_release"))
        ) {
          const error = new Error("direct write denied");
          error.code = "42501";
          throw error;
        }
        if (
          connection.role === "drill_admin" &&
          failurePoint === "migration" &&
          text.includes("create schema if not exists foundation_release")
        ) {
          throw new Error("migration failed");
        }
        if (
          name === "artifact-drill-provision-namespace-v1" &&
          failurePoint === "namespace-binding"
        ) {
          throw new Error("namespace binding failed");
        }
        return { rowCount: 0, rows: [] };
      },
      async connect() {
        assert.equal(connection.role, "drill_admin");
        return {
          async query(query) {
            const name = typeof query === "object" ? query.name : null;
            const text = typeof query === "string" ? query : query.text;
            events.push(`cleanup:${name ?? text}`);
            if (text === "begin" || text === "commit" || text === "rollback") {
              return { rowCount: 0, rows: [] };
            }
            if (text.startsWith("drop schema")) {
              if (cleanupFailure) throw new Error("cleanup drop failed");
              return { rowCount: 0, rows: [] };
            }
            if (name === "artifact-drill-cleanup-observation-v2") {
              return {
                rowCount: 1,
                rows: [
                  {
                    schema_removed: true,
                    heads_removed: true,
                    namespace_roles_removed: true,
                    events_removed: true,
                    evidence_removed: true,
                    put_function_removed: true,
                    append_function_removed: true,
                    observed_at: "2026-08-09T00:00:01.000Z",
                  },
                ],
              };
            }
            throw new Error(
              `Unexpected cleanup query: ${String(name ?? text)}`,
            );
          },
          release() {
            events.push("cleanup:release");
          },
        };
      },
      async end() {
        this.endCount += 1;
        events.push(`end:${connection.role}`);
      },
    };
    pools.push(pool);
    return pool;
  };
  const storeFactory = async ({ namespace }) => {
    if (failurePoint === "store-open") throw new Error("store open failed");
    return {
      namespace,
      async close() {
        events.push("store:close");
      },
    };
  };
  return {
    events,
    pools,
    dependencies: { poolFactory, storeFactory },
    options: {
      policy: policy(),
      storePolicy: disposableStorePolicy(),
      environment: environment(),
      namespace: "artifact-drill-test",
    },
  };
};

test("disposable database success uses transactional semantic cleanup", async () => {
  const fixture = openFixture();
  const disposable = await openDisposableArtifactControlStoreDrill(
    fixture.options,
    fixture.dependencies,
  );
  const cleanup = await disposable.cleanup();
  assert.equal(cleanup.removed, true);
  assert.equal(cleanup.namespace, fixture.options.namespace);
  assert.ok(fixture.events.includes("cleanup:begin"));
  assert.ok(
    fixture.events.includes(
      "cleanup:drop schema if exists foundation_release cascade",
    ),
  );
  assert.ok(fixture.events.includes("cleanup:commit"));
  assert.equal(
    fixture.pools.every(({ endCount }) => endCount === 1),
    true,
  );
  await assert.rejects(disposable.cleanup(), /replayed/);
});

test("partial pool creation closes every successfully opened pool", async () => {
  const fixture = openFixture();
  const originalPoolFactory = fixture.dependencies.poolFactory;
  fixture.dependencies.poolFactory = async (options) => {
    if (options.connection.role === "drill_executor") {
      throw new Error("executor pool open failed");
    }
    return originalPoolFactory(options);
  };
  await assert.rejects(
    openDisposableArtifactControlStoreDrill(
      fixture.options,
      fixture.dependencies,
    ),
    /pool open failed/,
  );
  assert.equal(fixture.pools.length, 2);
  assert.equal(
    fixture.pools.every(({ endCount }) => endCount === 1),
    true,
  );
  assert.equal(
    fixture.events.some((event) => event.startsWith("cleanup:")),
    false,
  );
});

test("every post-provision failure removes schema and closes all pools", async () => {
  for (const failurePoint of [
    "migration",
    "namespace-binding",
    "post-provision-inspection",
    "store-open",
  ]) {
    const fixture = openFixture({ failurePoint });
    await assert.rejects(
      openDisposableArtifactControlStoreDrill(
        fixture.options,
        fixture.dependencies,
      ),
      /failed|binding/,
      failurePoint,
    );
    assert.ok(
      fixture.events.includes(
        "cleanup:drop schema if exists foundation_release cascade",
      ),
      `${failurePoint} must drop the disposable schema`,
    );
    assert.ok(
      fixture.events.includes("cleanup:commit"),
      `${failurePoint} must commit cleanup`,
    );
    assert.equal(
      fixture.pools.every(({ endCount }) => endCount === 1),
      true,
      `${failurePoint} must close every pool`,
    );
  }
});

test("cleanup failure is aggregated with the original provision failure", async () => {
  const fixture = openFixture({
    failurePoint: "post-provision-inspection",
    cleanupFailure: true,
  });
  await assert.rejects(
    openDisposableArtifactControlStoreDrill(
      fixture.options,
      fixture.dependencies,
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /cleanup failed closed/);
      assert.match(
        error.errors.map(({ message }) => message).join("\n"),
        /post-provision inspection failed|cleanup/,
      );
      return true;
    },
  );
  assert.ok(fixture.events.includes("cleanup:rollback"));
  assert.equal(
    fixture.pools.every(({ endCount }) => endCount === 1),
    true,
  );
});

test("normal cleanup failure remains fail-closed and closes all pools", async () => {
  const fixture = openFixture({ cleanupFailure: true });
  const disposable = await openDisposableArtifactControlStoreDrill(
    fixture.options,
    fixture.dependencies,
  );
  await assert.rejects(
    disposable.cleanup(),
    /cleanup drop failed|cleanup failed/,
  );
  assert.ok(fixture.events.includes("cleanup:rollback"));
  assert.equal(
    fixture.pools.every(({ endCount }) => endCount === 1),
    true,
  );
});
