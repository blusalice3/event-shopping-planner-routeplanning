import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { assertConfiguredArtifactControlStoreDrillPolicy } from "../lib/artifact-control-store-drill-policy.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";

export { assertConfiguredArtifactControlStoreDrillPolicy };

export const ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-drill-control-store-receipt+json;version=1";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const ROLE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u;
const HOST = /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/u;
const DATABASE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCHEMA = "foundation_release";

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const nonEmptyDistinct = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every((value) => typeof value === "string" && value.length > 0) &&
  new Set(values).size === values.length;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Artifact drill database environment is absent: ${name}`);
  }
  return value;
};

const parseConnection = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  const queryNames = [...new Set(parsed.searchParams.keys())];
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const role = decodeURIComponent(parsed.username);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !HOST.test(parsed.hostname) ||
    !DATABASE.test(database) ||
    !ROLE.test(role) ||
    parsed.password.length < 8 ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "5432") ||
    queryNames.length !== 1 ||
    queryNames[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error(`${label} URL authority is invalid`);
  }
  return Object.freeze({
    database,
    endpoint: `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${database}`,
    host: parsed.hostname.toLowerCase(),
    parsed,
    role,
  });
};

export const resolveArtifactControlStoreDrillConnections = ({
  policy,
  environment,
}) => {
  assertConfiguredArtifactControlStoreDrillPolicy(policy);
  const ca = requireEnvironment(environment, policy.databaseCaEnvironmentName);
  if (sha256Bytes(Buffer.from(ca, "utf8")) !== policy.databaseCaSha256) {
    throw new Error("Artifact drill database CA fingerprint differs");
  }
  const administrator = parseConnection(
    requireEnvironment(
      environment,
      policy.drillAdministratorDatabaseUrlEnvironmentName,
    ),
    "Artifact drill administrator",
  );
  const executor = parseConnection(
    requireEnvironment(
      environment,
      policy.drillExecutorDatabaseUrlEnvironmentName,
    ),
    "Artifact drill executor",
  );
  const productionReader = parseConnection(
    requireEnvironment(
      environment,
      policy.productionReaderDatabaseUrlEnvironmentName,
    ),
    "Artifact drill production reader",
  );
  for (const connection of [administrator, executor, productionReader]) {
    if (
      !policy.allowedDrillHosts.includes(connection.host) ||
      !policy.allowedDrillDatabases.includes(connection.database)
    ) {
      throw new Error(
        "Artifact drill connection is outside the dedicated database",
      );
    }
  }
  if (
    administrator.endpoint !== executor.endpoint ||
    administrator.endpoint !== productionReader.endpoint ||
    !policy.allowedDrillAdministratorRoles.includes(administrator.role) ||
    !policy.allowedDrillExecutorRoles.includes(executor.role) ||
    !policy.allowedProductionReaderRoles.includes(productionReader.role) ||
    new Set([administrator.role, executor.role, productionReader.role]).size !==
      3 ||
    administrator.parsed.password === executor.parsed.password ||
    administrator.parsed.password === productionReader.parsed.password ||
    executor.parsed.password === productionReader.parsed.password
  ) {
    throw new Error(
      "Artifact drill database roles or credentials are not separated",
    );
  }
  return Object.freeze({ administrator, ca, executor, productionReader });
};

const runtimeConnectionString = (connection) => {
  const value = new URL(connection.parsed);
  value.searchParams.delete("sslmode");
  return value.toString();
};

const createPool = async ({ connection, ca, policy }) => {
  const { Pool } = await import("pg");
  return new Pool({
    application_name: "event-shopping-planner-artifact-drill",
    connectionString: runtimeConnectionString(connection),
    connectionTimeoutMillis: policy.connectTimeoutMilliseconds,
    max: 1,
    ssl: { ca, rejectUnauthorized: true },
    statement_timeout: policy.statementTimeoutMilliseconds,
  });
};

const assertSessionIdentity = async ({ pool, expected, label }) => {
  const result = await pool.query({
    name: `artifact-drill-session-${label}-v1`,
    text: "select session_user::text as role, current_database()::text as database",
  });
  if (
    result.rowCount !== 1 ||
    result.rows[0]?.role !== expected.role ||
    result.rows[0]?.database !== expected.database
  ) {
    throw new Error(`Artifact drill ${label} session identity differs`);
  }
};

export const inspectArtifactControlStoreUnprivilegedRole = async ({
  pool,
  expected,
  label,
}) => {
  const result = await pool.query({
    name: `artifact-drill-role-authority-${label}-v1`,
    text: `
      select
        r.rolsuper,
        r.rolcreaterole,
        r.rolcreatedb,
        r.rolcanlogin,
        r.rolreplication,
        r.rolbypassrls,
        not exists (
          select 1
          from pg_catalog.pg_roles granted
          where granted.oid <> r.oid
            and pg_has_role(session_user, granted.oid, 'member')
        ) as membership_closed_set
      from pg_catalog.pg_roles r
      where r.rolname = session_user
    `,
  });
  const row = result.rows[0];
  if (
    result.rowCount !== 1 ||
    row?.rolsuper !== false ||
    row.rolcreaterole !== false ||
    row.rolcreatedb !== false ||
    row.rolcanlogin !== true ||
    row.rolreplication !== false ||
    row.rolbypassrls !== false ||
    row.membership_closed_set !== true
  ) {
    throw new Error(`Artifact drill ${label} role authority is overprivileged`);
  }
  return Object.freeze({
    canLogin: true,
    createDatabase: false,
    createRole: false,
    memberOfAnyRole: false,
    replication: false,
    roleSha256: sha256Bytes(Buffer.from(expected.role, "utf8")),
    rowSecurityBypass: false,
    superuser: false,
  });
};

const inspectStorePrivileges = async ({ pool, label }) => {
  const result = await pool.query({
    name: `artifact-drill-store-privileges-${label}-v1`,
    text: `
      select
        has_schema_privilege(session_user, 'foundation_release', 'USAGE') as schema_usage,
        has_schema_privilege(session_user, 'foundation_release', 'CREATE') as schema_create,
        has_table_privilege(
          session_user,
          'foundation_release.release_evidence_objects',
          'SELECT'
        ) as evidence_select,
        has_table_privilege(session_user, 'foundation_release.release_evidence_objects', 'INSERT') as evidence_insert,
        has_table_privilege(session_user, 'foundation_release.release_evidence_objects', 'UPDATE') as evidence_update,
        has_table_privilege(session_user, 'foundation_release.release_evidence_objects', 'DELETE') as evidence_delete,
        has_table_privilege(session_user, 'foundation_release.release_evidence_objects', 'TRUNCATE') as evidence_truncate,
        has_table_privilege(session_user, 'foundation_release.release_evidence_objects', 'REFERENCES') as evidence_references,
        has_table_privilege(session_user, 'foundation_release.release_evidence_objects', 'TRIGGER') as evidence_trigger,
        has_function_privilege(
          session_user,
          'foundation_release.put_evidence_if_absent(text,text,text,bytea)',
          'EXECUTE'
        ) as put_function_execute,
        has_function_privilege(
          session_user,
          'foundation_release.compare_and_append(text,bigint,text,uuid,bytea)',
          'EXECUTE'
        ) as append_function_execute
    `,
  });
  const row = result.rows[0];
  if (
    result.rowCount !== 1 ||
    row?.schema_usage !== true ||
    row.schema_create !== false ||
    row.evidence_select !== true ||
    row.evidence_insert !== false ||
    row.evidence_update !== false ||
    row.evidence_delete !== false ||
    row.evidence_truncate !== false ||
    row.evidence_references !== false ||
    row.evidence_trigger !== false ||
    row.put_function_execute !== true ||
    row.append_function_execute !== true
  ) {
    throw new Error(
      `Artifact drill ${label} direct privilege boundary differs`,
    );
  }
  return Object.freeze({
    directEvidenceWrite: false,
    functionExecute: true,
    schemaCreate: false,
    schemaUsage: true,
    selectEvidence: true,
  });
};

const observeDirectWriteDenial = async ({
  pool,
  namespace,
  label,
  roleSha256,
}) => {
  const attempts = [
    {
      operation: "direct-table-insert",
      query: {
        text: `
          insert into foundation_release.release_state_heads (
            namespace,
            sequence,
            event_hash
          ) values ($1, 0, null)
        `,
        values: [`${namespace.slice(0, 48)}-denied`],
      },
    },
    {
      operation: "schema-ddl-create",
      query: {
        text: "create table foundation_release.artifact_drill_forbidden(value integer)",
      },
    },
  ];
  const receipts = [];
  for (const attempt of attempts) {
    let denial;
    try {
      await pool.query(attempt.query);
    } catch (error) {
      denial = sqlErrorReceipt(
        error,
        `${label}-${attempt.operation}`,
        roleSha256,
      );
    }
    if (denial?.sqlstate !== "42501") {
      throw new Error(`Artifact drill ${label} direct write was not denied`);
    }
    receipts.push(denial);
  }
  return Object.freeze(receipts);
};

const loadMigrations = async (storePolicy) => {
  if (
    storePolicy?.bindingStatus !== "configured" ||
    !Array.isArray(storePolicy.migrations) ||
    storePolicy.migrations.length < 1
  ) {
    throw new Error(
      "Artifact drill Release State migration policy is not configured",
    );
  }
  const migrations = [];
  for (const entry of storePolicy.migrations) {
    if (
      !exactKeys(entry, ["path", "sha256"]) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("ops/release-state/migrations/") ||
      !SHA256.test(entry.sha256 ?? "")
    ) {
      throw new Error("Artifact drill migration entry is invalid");
    }
    const bytes = await readFile(path.join(root, ...entry.path.split("/")));
    if (sha256Bytes(bytes) !== entry.sha256) {
      throw new Error(`Artifact drill migration hash differs: ${entry.path}`);
    }
    migrations.push(bytes.toString("utf8"));
  }
  return migrations;
};

const assertDedicatedDatabaseOutsideProduction = ({
  connections,
  storePolicy,
}) => {
  if (
    storePolicy?.bindingStatus !== "configured" ||
    !nonEmptyDistinct(storePolicy.allowedHosts) ||
    !storePolicy.allowedHosts.every((value) => HOST.test(value)) ||
    !nonEmptyDistinct(storePolicy.allowedDatabases) ||
    !storePolicy.allowedDatabases.every((value) => DATABASE.test(value))
  ) {
    throw new Error(
      "Artifact drill production Release State endpoint policy is not configured",
    );
  }
  const drill = connections.executor;
  if (
    storePolicy.allowedHosts.includes(drill.host) &&
    storePolicy.allowedDatabases.includes(drill.database)
  ) {
    throw new Error(
      "Artifact drill dedicated database overlaps a production Release State endpoint",
    );
  }
};

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const closePools = async (pools) => {
  const settled = await Promise.allSettled(pools.map((pool) => pool.end()));
  return settled
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
};

const aggregateFailures = (errors, message) => {
  const failures = errors.filter((error) => error !== null);
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
};

const cleanupDisposableSchema = async ({
  administratorPool,
  connections,
  namespace,
}) => {
  const client = await administratorPool.connect();
  let transactionStarted = false;
  let receipt = null;
  try {
    await client.query("begin");
    transactionStarted = true;
    await client.query(`drop schema if exists ${SCHEMA} cascade`);
    const result = await client.query({
      name: "artifact-drill-cleanup-observation-v2",
      text: `
        select
          to_regnamespace('foundation_release') is null as schema_removed,
          to_regclass('foundation_release.release_state_heads') is null as heads_removed,
          to_regclass('foundation_release.release_state_namespace_roles') is null as namespace_roles_removed,
          to_regclass('foundation_release.release_state_events') is null as events_removed,
          to_regclass('foundation_release.release_evidence_objects') is null as evidence_removed,
          to_regprocedure(
            'foundation_release.put_evidence_if_absent(text,text,text,bytea)'
          ) is null as put_function_removed,
          to_regprocedure(
            'foundation_release.compare_and_append(text,bigint,text,uuid,bytea)'
          ) is null as append_function_removed,
          clock_timestamp() at time zone 'utc' as observed_at
      `,
    });
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      row?.schema_removed !== true ||
      row.heads_removed !== true ||
      row.namespace_roles_removed !== true ||
      row.events_removed !== true ||
      row.evidence_removed !== true ||
      row.put_function_removed !== true ||
      row.append_function_removed !== true
    ) {
      throw new Error("Artifact drill database cleanup was not observed");
    }
    const observedAt = new Date(row.observed_at).toISOString();
    await client.query("commit");
    transactionStarted = false;
    receipt = Object.freeze({
      schemaVersion: 1,
      kind: "artifact-drill-database-cleanup-receipt/v1",
      databaseEndpointSha256: sha256Json({
        endpoint: connections.executor.endpoint,
      }),
      administratorRoleSha256: sha256Bytes(
        Buffer.from(connections.administrator.role, "utf8"),
      ),
      namespace,
      observedAt,
      removed: true,
    });
  } catch (error) {
    let rollbackError = null;
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch (caught) {
        rollbackError = caught;
      }
    }
    throw aggregateFailures(
      [error, rollbackError],
      "Artifact drill database cleanup transaction failed",
    );
  } finally {
    client.release();
  }
  return receipt;
};

const provisionSchema = async ({
  administratorPool,
  executor,
  reader,
  namespace,
  migrations,
}) => {
  await administratorPool.query(`drop schema if exists ${SCHEMA} cascade`);
  for (const migration of migrations) await administratorPool.query(migration);
  await administratorPool.query({
    name: "artifact-drill-provision-namespace-v1",
    text: `
      insert into foundation_release.release_state_namespace_roles (
        namespace,
        executor_role
      ) values ($1, $2::name)
    `,
    values: [namespace, executor.role],
  });
  for (const role of [executor.role, reader.role]) {
    const identifier = quoteIdentifier(role);
    await administratorPool.query(
      `grant usage on schema ${SCHEMA} to ${identifier}`,
    );
    await administratorPool.query(
      `grant select on all tables in schema ${SCHEMA} to ${identifier}`,
    );
    await administratorPool.query(
      `grant execute on function foundation_release.put_evidence_if_absent(text,text,text,bytea) to ${identifier}`,
    );
    await administratorPool.query(
      `grant execute on function foundation_release.compare_and_append(text,bigint,text,uuid,bytea) to ${identifier}`,
    );
  }
};

const disposableStorePolicy = ({ policy, connection }) => ({
  bindingStatus: "configured",
  allowedHosts: [connection.host],
  allowedDatabases: [connection.database],
  allowedExecutorRoles: [connection.role],
  connectTimeoutMilliseconds: policy.connectTimeoutMilliseconds,
  statementTimeoutMilliseconds: policy.statementTimeoutMilliseconds,
  productionCaSha256: policy.databaseCaSha256,
});

export const openDisposableArtifactControlStoreDrill = async (
  { policy, storePolicy, environment = process.env, namespace },
  {
    poolFactory = createPool,
    storeFactory = createPostgresReleaseStateStore,
  } = {},
) => {
  if (!NAMESPACE.test(namespace ?? "")) {
    throw new Error("Artifact drill disposable namespace is invalid");
  }
  const connections = resolveArtifactControlStoreDrillConnections({
    policy,
    environment,
  });
  assertDedicatedDatabaseOutsideProduction({ connections, storePolicy });
  const migrations = await loadMigrations(storePolicy);
  const poolResults = await Promise.allSettled(
    [
      connections.administrator,
      connections.executor,
      connections.productionReader,
    ].map((connection) =>
      poolFactory({ connection, ca: connections.ca, policy }),
    ),
  );
  const pools = poolResults
    .filter(({ status }) => status === "fulfilled")
    .map(({ value }) => value);
  const poolOpenErrors = poolResults
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (poolOpenErrors.length > 0) {
    const closeErrors = await closePools(pools);
    throw aggregateFailures(
      [...poolOpenErrors, ...closeErrors],
      "Artifact drill database pools failed to open or close",
    );
  }
  const [administratorPool, executorInspectionPool, productionReaderPool] =
    pools;
  let drillStore = null;
  let cleaned = false;
  let provisionStarted = false;
  try {
    await Promise.all([
      assertSessionIdentity({
        pool: administratorPool,
        expected: connections.administrator,
        label: "administrator",
      }),
      assertSessionIdentity({
        pool: productionReaderPool,
        expected: connections.productionReader,
        label: "production-reader",
      }),
      assertSessionIdentity({
        pool: executorInspectionPool,
        expected: connections.executor,
        label: "executor",
      }),
    ]);
    const [administratorRole, executorRole, productionReaderRole] =
      await Promise.all([
        inspectArtifactControlStoreUnprivilegedRole({
          pool: administratorPool,
          expected: connections.administrator,
          label: "administrator",
        }),
        inspectArtifactControlStoreUnprivilegedRole({
          pool: executorInspectionPool,
          expected: connections.executor,
          label: "executor",
        }),
        inspectArtifactControlStoreUnprivilegedRole({
          pool: productionReaderPool,
          expected: connections.productionReader,
          label: "production-reader",
        }),
      ]);
    provisionStarted = true;
    await provisionSchema({
      administratorPool,
      executor: connections.executor,
      reader: connections.productionReader,
      namespace,
      migrations,
    });
    const [executorPrivileges, productionReaderPrivileges] = await Promise.all([
      inspectStorePrivileges({
        pool: executorInspectionPool,
        label: "executor",
      }),
      inspectStorePrivileges({
        pool: productionReaderPool,
        label: "production-reader",
      }),
    ]);
    const [executorDirectDenials, productionReaderDirectDenials] =
      await Promise.all([
        observeDirectWriteDenial({
          pool: executorInspectionPool,
          namespace,
          label: "executor",
          roleSha256: executorRole.roleSha256,
        }),
        observeDirectWriteDenial({
          pool: productionReaderPool,
          namespace,
          label: "production-reader",
          roleSha256: productionReaderRole.roleSha256,
        }),
      ]);
    drillStore = await storeFactory({
      ca: connections.ca,
      connectionString: connections.executor.parsed.toString(),
      namespace,
      policy: disposableStorePolicy({
        policy,
        connection: connections.executor,
      }),
    });
    return {
      drillStore,
      productionReaderPool,
      identity: Object.freeze({
        databaseEndpointSha256: sha256Json({
          endpoint: connections.executor.endpoint,
        }),
        administratorRoleSha256: sha256Bytes(
          Buffer.from(connections.administrator.role, "utf8"),
        ),
        executorRoleSha256: sha256Bytes(
          Buffer.from(connections.executor.role, "utf8"),
        ),
        productionReaderRoleSha256: sha256Bytes(
          Buffer.from(connections.productionReader.role, "utf8"),
        ),
        roleAuthority: {
          administrator: administratorRole,
          executor: {
            ...executorRole,
            directDenials: executorDirectDenials,
            privileges: executorPrivileges,
          },
          productionReader: {
            ...productionReaderRole,
            directDenials: productionReaderDirectDenials,
            privileges: productionReaderPrivileges,
          },
        },
      }),
      async cleanup() {
        if (cleaned)
          throw new Error("Artifact drill database cleanup replayed");
        cleaned = true;
        const failures = [];
        if (drillStore !== null) {
          try {
            await drillStore.close();
          } catch (error) {
            failures.push(error);
          } finally {
            drillStore = null;
          }
        }
        let cleanupReceipt = null;
        try {
          cleanupReceipt = await cleanupDisposableSchema({
            administratorPool,
            connections,
            namespace,
          });
        } catch (error) {
          failures.push(error);
        }
        failures.push(...(await closePools(pools)));
        if (failures.length > 0) {
          throw aggregateFailures(
            failures,
            "Artifact drill database cleanup failed closed",
          );
        }
        return cleanupReceipt;
      },
    };
  } catch (error) {
    const failures = [error];
    if (drillStore !== null) {
      try {
        await drillStore.close();
      } catch (caught) {
        failures.push(caught);
      } finally {
        drillStore = null;
      }
    }
    if (provisionStarted) {
      try {
        await cleanupDisposableSchema({
          administratorPool,
          connections,
          namespace,
        });
      } catch (caught) {
        failures.push(caught);
      }
    }
    failures.push(...(await closePools(pools)));
    throw aggregateFailures(
      failures,
      "Artifact drill database open/provision cleanup failed closed",
    );
  }
};

const deterministicUuid = (value) => {
  const digest = sha256Json(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const sqlErrorReceipt = (error, operation, roleSha256) => {
  const receipt = {
    schemaVersion: 1,
    kind: "artifact-drill-postgres-error/v1",
    operation,
    roleSha256,
    sqlstate: error?.code ?? null,
  };
  if (
    !SHA256.test(roleSha256) ||
    !/^[0-9A-Z]{5}$/u.test(receipt.sqlstate ?? "")
  ) {
    throw new Error(
      `Artifact drill ${operation} did not return PostgreSQL SQLSTATE`,
    );
  }
  return receipt;
};

const assertRoleProjection = (role, label, { direct = false } = {}) => {
  const baseKeys = [
    "canLogin",
    "createDatabase",
    "createRole",
    "memberOfAnyRole",
    "replication",
    "roleSha256",
    "rowSecurityBypass",
    "superuser",
  ];
  if (
    !exactKeys(
      role,
      direct ? [...baseKeys, "directDenials", "privileges"] : baseKeys,
    ) ||
    role.canLogin !== true ||
    role.createDatabase !== false ||
    role.createRole !== false ||
    role.memberOfAnyRole !== false ||
    role.replication !== false ||
    role.rowSecurityBypass !== false ||
    role.superuser !== false ||
    !SHA256.test(role.roleSha256 ?? "")
  ) {
    throw new Error(`Artifact drill ${label} role projection is invalid`);
  }
  if (!direct) return role;
  if (
    !exactKeys(role.privileges, [
      "directEvidenceWrite",
      "functionExecute",
      "schemaCreate",
      "schemaUsage",
      "selectEvidence",
    ]) ||
    role.privileges.directEvidenceWrite !== false ||
    role.privileges.functionExecute !== true ||
    role.privileges.schemaCreate !== false ||
    role.privileges.schemaUsage !== true ||
    role.privileges.selectEvidence !== true ||
    !Array.isArray(role.directDenials) ||
    role.directDenials.length !== 2
  ) {
    throw new Error(
      `Artifact drill ${label} direct privilege projection differs`,
    );
  }
  const expectedOperations = [
    `${label}-direct-table-insert`,
    `${label}-schema-ddl-create`,
  ];
  for (let index = 0; index < role.directDenials.length; index += 1) {
    const denial = role.directDenials[index];
    if (
      !exactKeys(denial, [
        "kind",
        "operation",
        "roleSha256",
        "schemaVersion",
        "sqlstate",
      ]) ||
      denial.schemaVersion !== 1 ||
      denial.kind !== "artifact-drill-postgres-error/v1" ||
      denial.operation !== expectedOperations[index] ||
      denial.roleSha256 !== role.roleSha256 ||
      denial.sqlstate !== "42501"
    ) {
      throw new Error(`Artifact drill ${label} direct denial differs`);
    }
  }
  return role;
};

export const assertArtifactControlStoreRoleAuthority = (authority) => {
  if (
    !exactKeys(authority, ["administrator", "executor", "productionReader"])
  ) {
    throw new Error("Artifact drill role authority fields are invalid");
  }
  assertRoleProjection(authority.administrator, "administrator");
  assertRoleProjection(authority.executor, "executor", { direct: true });
  assertRoleProjection(authority.productionReader, "production-reader", {
    direct: true,
  });
  if (
    new Set([
      authority.administrator.roleSha256,
      authority.executor.roleSha256,
      authority.productionReader.roleSha256,
    ]).size !== 3
  ) {
    throw new Error("Artifact drill role authority identities are ambiguous");
  }
  return authority;
};

const putCanonicalReceipt = async (store, value, mediaType) => {
  const bytes = canonicalJsonBytes(value);
  const receipt = await store.putEvidence({ bytes, mediaType });
  const readback = await store.readEvidence({ sha256: sha256Bytes(bytes) });
  if (
    receipt?.sha256 !== sha256Bytes(bytes) ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    !Buffer.isBuffer(readback?.bytes) ||
    !readback.bytes.equals(bytes) ||
    readback.mediaType !== mediaType
  ) {
    throw new Error("Artifact drill PostgreSQL receipt put/readback differs");
  }
  return { bytes, reference: { uri: receipt.uri, sha256: receipt.sha256 } };
};

export const executeArtifactControlStorePostgresDrill = async ({
  drillStore,
  productionReaderPool,
  namespace,
  identity,
}) => {
  if (
    drillStore?.namespace !== namespace ||
    !NAMESPACE.test(namespace ?? "") ||
    !exactKeys(identity, [
      "administratorRoleSha256",
      "databaseEndpointSha256",
      "executorRoleSha256",
      "productionReaderRoleSha256",
      "roleAuthority",
    ]) ||
    [
      identity.administratorRoleSha256,
      identity.databaseEndpointSha256,
      identity.executorRoleSha256,
      identity.productionReaderRoleSha256,
    ].some((value) => !SHA256.test(value))
  ) {
    throw new Error("Artifact drill PostgreSQL execution authority is invalid");
  }
  assertArtifactControlStoreRoleAuthority(identity.roleAuthority);
  if (
    identity.administratorRoleSha256 !==
      identity.roleAuthority.administrator.roleSha256 ||
    identity.executorRoleSha256 !==
      identity.roleAuthority.executor.roleSha256 ||
    identity.productionReaderRoleSha256 !==
      identity.roleAuthority.productionReader.roleSha256
  ) {
    throw new Error("Artifact drill PostgreSQL role authority hashes differ");
  }
  const objectBytes = canonicalJsonBytes({
    schemaVersion: 1,
    kind: "artifact-drill-put-readback-probe/v1",
    namespace,
  });
  const mediaType =
    "application/vnd.event-shopping-planner.artifact-drill-put-readback+json;version=1";
  const firstPut = await drillStore.putEvidence({
    bytes: objectBytes,
    mediaType,
  });
  const secondPut = await drillStore.putEvidence({
    bytes: objectBytes,
    mediaType,
  });
  const objectHash = sha256Bytes(objectBytes);
  const readback = await drillStore.readEvidence({ sha256: objectHash });
  if (
    firstPut?.sha256 !== objectHash ||
    firstPut.replayed !== false ||
    secondPut?.sha256 !== objectHash ||
    secondPut.replayed !== true ||
    firstPut.committedAt !== secondPut.committedAt ||
    !Buffer.isBuffer(readback?.bytes) ||
    !readback.bytes.equals(objectBytes) ||
    readback.mediaType !== mediaType
  ) {
    throw new Error("Artifact drill evidence idempotency/readback failed");
  }

  const payload = { drill: true, namespace };
  const event = {
    schemaVersion: 1,
    namespace,
    sequence: 1,
    eventType: "state-initialized",
    operationId: `artifact-drill:${sha256Json({ namespace }).slice(0, 24)}`,
    appendId: deterministicUuid({ namespace, kind: "first" }),
    previousEventHash: null,
    payload,
    payloadSha256: sha256Json(payload),
    evidenceRefs: [],
    approvalRefs: [],
  };
  if (!UUID.test(event.appendId)) {
    throw new Error("Artifact drill deterministic append ID is invalid");
  }
  const firstAppend = await drillStore.compareAndAppend({
    expectedSequence: 0,
    expectedHash: null,
    event,
  });
  const replayAppend = await drillStore.compareAndAppend({
    expectedSequence: 0,
    expectedHash: null,
    event,
  });
  if (
    firstAppend?.replayed !== false ||
    replayAppend?.replayed !== true ||
    firstAppend.eventHash !== replayAppend.eventHash ||
    firstAppend.sequence !== 1 ||
    replayAppend.sequence !== 1
  ) {
    throw new Error("Artifact drill CAS idempotency failed");
  }
  const conflictingEvent = {
    ...event,
    appendId: deterministicUuid({ namespace, kind: "conflict" }),
    operationId: `${event.operationId}:conflict`,
  };
  let casError;
  try {
    await drillStore.compareAndAppend({
      expectedSequence: 0,
      expectedHash: null,
      event: conflictingEvent,
    });
  } catch (error) {
    casError = error;
  }
  const casConflict = sqlErrorReceipt(
    casError,
    "compare-and-append-stale-head",
    identity.executorRoleSha256,
  );
  if (casConflict.sqlstate !== "40001") {
    throw new Error("Artifact drill CAS rejection SQLSTATE differs");
  }

  let denialError;
  try {
    await productionReaderPool.query({
      name: "artifact-drill-production-reader-write-denial-v1",
      text: `
        select *
        from foundation_release.put_evidence_if_absent($1, $2, $3, $4)
      `,
      values: [namespace, objectHash, mediaType, objectBytes],
    });
  } catch (error) {
    denialError = error;
  }
  const credentialDenial = sqlErrorReceipt(
    denialError,
    "production-reader-put-evidence",
    identity.productionReaderRoleSha256,
  );
  if (credentialDenial.sqlstate !== "42501") {
    throw new Error("Artifact drill production-reader denial SQLSTATE differs");
  }

  const receiptValue = {
    schemaVersion: 1,
    kind: "artifact-drill-control-store-receipt/v1",
    namespace,
    databaseEndpointSha256: identity.databaseEndpointSha256,
    administratorRoleSha256: identity.administratorRoleSha256,
    executorRoleSha256: identity.executorRoleSha256,
    productionReaderRoleSha256: identity.productionReaderRoleSha256,
    roleAuthority: identity.roleAuthority,
    immutableEvidence: {
      committedAt: firstPut.committedAt,
      mediaType,
      objectSha256: objectHash,
      putReadbackVerified: true,
    },
    idempotency: {
      appendEventHash: firstAppend.eventHash,
      appendReplayObserved: true,
      evidenceReplayObserved: true,
    },
    casConflict,
    credentialDenial,
  };
  const stored = await putCanonicalReceipt(
    drillStore,
    receiptValue,
    ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
  );
  return Object.freeze({
    casConflictDenied: casConflict.sqlstate === "40001",
    credentialDenialVerified: credentialDenial.sqlstate === "42501",
    idempotencyVerified: true,
    putReadbackVerified: true,
    receiptSha256: stored.reference.sha256,
  });
};

export const assertArtifactControlStorePostgresReceipt = (receipt) => {
  if (
    !exactKeys(receipt, [
      "administratorRoleSha256",
      "casConflict",
      "credentialDenial",
      "databaseEndpointSha256",
      "executorRoleSha256",
      "idempotency",
      "immutableEvidence",
      "kind",
      "namespace",
      "productionReaderRoleSha256",
      "roleAuthority",
      "schemaVersion",
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "artifact-drill-control-store-receipt/v1" ||
    !NAMESPACE.test(receipt.namespace ?? "") ||
    [
      receipt.administratorRoleSha256,
      receipt.databaseEndpointSha256,
      receipt.executorRoleSha256,
      receipt.productionReaderRoleSha256,
    ].some((value) => !SHA256.test(value ?? "")) ||
    new Set([
      receipt.administratorRoleSha256,
      receipt.executorRoleSha256,
      receipt.productionReaderRoleSha256,
    ]).size !== 3 ||
    !exactKeys(receipt.casConflict, [
      "kind",
      "operation",
      "roleSha256",
      "schemaVersion",
      "sqlstate",
    ]) ||
    receipt.casConflict.kind !== "artifact-drill-postgres-error/v1" ||
    receipt.casConflict.operation !== "compare-and-append-stale-head" ||
    receipt.casConflict.roleSha256 !== receipt.executorRoleSha256 ||
    receipt.casConflict.sqlstate !== "40001" ||
    !exactKeys(receipt.credentialDenial, [
      "kind",
      "operation",
      "roleSha256",
      "schemaVersion",
      "sqlstate",
    ]) ||
    receipt.credentialDenial.kind !== "artifact-drill-postgres-error/v1" ||
    receipt.credentialDenial.operation !== "production-reader-put-evidence" ||
    receipt.credentialDenial.roleSha256 !==
      receipt.productionReaderRoleSha256 ||
    receipt.credentialDenial.sqlstate !== "42501" ||
    !exactKeys(receipt.immutableEvidence, [
      "committedAt",
      "mediaType",
      "objectSha256",
      "putReadbackVerified",
    ]) ||
    !SHA256.test(receipt.immutableEvidence.objectSha256 ?? "") ||
    typeof receipt.immutableEvidence.committedAt !== "string" ||
    new Date(receipt.immutableEvidence.committedAt).toISOString() !==
      receipt.immutableEvidence.committedAt ||
    typeof receipt.immutableEvidence.mediaType !== "string" ||
    !receipt.immutableEvidence.mediaType.startsWith("application/") ||
    receipt.immutableEvidence?.putReadbackVerified !== true ||
    !exactKeys(receipt.idempotency, [
      "appendEventHash",
      "appendReplayObserved",
      "evidenceReplayObserved",
    ]) ||
    !SHA256.test(receipt.idempotency.appendEventHash ?? "") ||
    receipt.idempotency?.appendReplayObserved !== true ||
    receipt.idempotency?.evidenceReplayObserved !== true
  ) {
    throw new Error("Artifact drill PostgreSQL receipt semantics are invalid");
  }
  assertArtifactControlStoreRoleAuthority(receipt.roleAuthority);
  if (
    receipt.administratorRoleSha256 !==
      receipt.roleAuthority.administrator.roleSha256 ||
    receipt.executorRoleSha256 !== receipt.roleAuthority.executor.roleSha256 ||
    receipt.productionReaderRoleSha256 !==
      receipt.roleAuthority.productionReader.roleSha256
  ) {
    throw new Error("Artifact drill PostgreSQL receipt role hashes differ");
  }
  return receipt;
};
