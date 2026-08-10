import { sha256Json } from "../lib/canonical-json.mjs";

const UTF8_COMPARE = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const REQUIRED_POSTGRES_MAJOR = 17;
const DATABASE_URL_ENVIRONMENT_NAME = "DB_COMPATIBILITY_OBSERVER_DATABASE_URL";
const DATABASE_CA_ENVIRONMENT_NAME = "DB_COMPATIBILITY_OBSERVER_CA_PEM";
const METRICS_TABLE = "public.persistence_release_a_metric_events";
const CSP_TABLE = "public.csp_violation_reports";
const CSP_CONSTRAINTS = Object.freeze([
  "csp_violation_reports_blocked_target_check",
  "csp_violation_reports_effective_directive_check",
]);
const FUNCTION_ARGUMENTS = Object.freeze({
  "public.read_persistence_release_a_metrics":
    "timestamp with time zone, timestamp with time zone, integer",
  "public.retain_persistence_release_a_metrics": "boolean, integer, integer",
  "public.read_csp_violation_aggregates":
    "timestamp with time zone, timestamp with time zone, integer",
  "public.read_csp_deployment_violation_aggregates":
    "timestamp with time zone, timestamp with time zone, text, text, integer",
  "public.retain_csp_violation_reports": "boolean, integer, integer",
});

export const REMOTE_DB_OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "contractFingerprint",
  "migrationChecksums",
  "migrationsApplied",
  "serviceRoleRawSelect",
  "serviceRoleRawInsert",
  "cspServiceRoleRawSelect",
  "cspServiceRoleRawInsert",
  "cspObjectsPresent",
  "operatorBoundedFunctionOnly",
  "cspApplicationCredentialReachable",
  "requiredTables",
  "requiredFunctions",
  "observedAt",
]);

export const REMOTE_DB_OBSERVATION_AUTHORITY_KEYS = Object.freeze([
  "bindingStatus",
  "postgresMajor",
  "databaseUrlEnvironmentName",
  "databaseCaEnvironmentName",
  "tlsMode",
  "allowedHosts",
  "allowedDatabases",
  "allowedObserverRoles",
  "serviceRole",
  "productionCaSha256",
  "connectTimeoutMilliseconds",
  "statementTimeoutMilliseconds",
  "maximumObservationAgeSeconds",
  "maximumFutureClockSkewSeconds",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sortedStrings = (values) => [...values].sort(UTF8_COMPARE);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const actual = sortedStrings(Object.keys(value));
  const expected = sortedStrings(expectedKeys);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const hasExactStringSet = (candidate, expected) => {
  if (
    !Array.isArray(candidate) ||
    candidate.some((value) => typeof value !== "string")
  ) {
    return false;
  }
  const actualValues = sortedStrings(candidate);
  const expectedValues = sortedStrings(expected);
  return (
    new Set(actualValues).size === actualValues.length &&
    actualValues.length === expectedValues.length &&
    actualValues.every((value, index) => value === expectedValues[index])
  );
};

const hasExactChecksums = (candidate, expected) => {
  if (!isRecord(candidate) || !isRecord(expected)) return false;
  const expectedEntries = Object.entries(expected);
  const actualKeys = Object.keys(candidate);
  return (
    actualKeys.length === expectedEntries.length &&
    expectedEntries.every(
      ([name, checksum]) =>
        typeof checksum === "string" && candidate[name] === checksum,
    )
  );
};

const hasControlCharacter = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const isAuthorityString = (value, maximumBytes = 255) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= maximumBytes &&
  !hasControlCharacter(value);

const isSortedUniqueAuthorityStrings = (values, maximumBytes = 255) =>
  Array.isArray(values) &&
  values.every((value) => isAuthorityString(value, maximumBytes)) &&
  new Set(values).size === values.length &&
  values.every(
    (value, index) => index === 0 || UTF8_COMPARE(values[index - 1], value) < 0,
  );

export const assertRemoteDbObservationAuthority = (
  authority,
  { requireConfigured = false } = {},
) => {
  if (
    !hasExactKeys(authority, REMOTE_DB_OBSERVATION_AUTHORITY_KEYS) ||
    (authority.bindingStatus !== "configured" &&
      authority.bindingStatus !== "unconfigured") ||
    authority.postgresMajor !== REQUIRED_POSTGRES_MAJOR ||
    authority.databaseUrlEnvironmentName !== DATABASE_URL_ENVIRONMENT_NAME ||
    authority.databaseCaEnvironmentName !== DATABASE_CA_ENVIRONMENT_NAME ||
    authority.tlsMode !== "verify-full" ||
    !isSortedUniqueAuthorityStrings(authority.allowedHosts) ||
    authority.allowedHosts.some((host) => host !== host.toLowerCase()) ||
    !isSortedUniqueAuthorityStrings(authority.allowedDatabases, 63) ||
    !isSortedUniqueAuthorityStrings(authority.allowedObserverRoles, 63) ||
    !isAuthorityString(authority.serviceRole, 63) ||
    (authority.productionCaSha256 !== null &&
      (typeof authority.productionCaSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(authority.productionCaSha256))) ||
    !Number.isSafeInteger(authority.connectTimeoutMilliseconds) ||
    authority.connectTimeoutMilliseconds < 1 ||
    authority.connectTimeoutMilliseconds > 60_000 ||
    !Number.isSafeInteger(authority.statementTimeoutMilliseconds) ||
    authority.statementTimeoutMilliseconds < 1 ||
    authority.statementTimeoutMilliseconds > 60_000 ||
    !Number.isSafeInteger(authority.maximumObservationAgeSeconds) ||
    authority.maximumObservationAgeSeconds < 1 ||
    authority.maximumObservationAgeSeconds > 3_600 ||
    !Number.isSafeInteger(authority.maximumFutureClockSkewSeconds) ||
    authority.maximumFutureClockSkewSeconds < 0 ||
    authority.maximumFutureClockSkewSeconds > 300
  ) {
    throw new Error("Remote DB observation authority is invalid");
  }
  if (
    (authority.bindingStatus === "configured" &&
      (authority.allowedHosts.length === 0 ||
        authority.allowedDatabases.length === 0 ||
        authority.allowedObserverRoles.length === 0 ||
        authority.allowedObserverRoles.includes(authority.serviceRole) ||
        authority.productionCaSha256 === null)) ||
    (authority.bindingStatus === "unconfigured" &&
      (authority.allowedHosts.length !== 0 ||
        authority.allowedDatabases.length !== 0 ||
        authority.allowedObserverRoles.length !== 0 ||
        authority.productionCaSha256 !== null))
  ) {
    throw new Error("Remote DB observation authority is invalid");
  }
  if (requireConfigured && authority.bindingStatus !== "configured") {
    throw new Error("Remote DB observation authority is not configured");
  }
  return authority;
};

const assertObservationExpectation = ({ contract, migrationChecksums }) => {
  if (
    !isRecord(contract) ||
    !isRecord(contract.remote) ||
    !Array.isArray(contract.remote.requiredTables) ||
    !Array.isArray(contract.remote.requiredFunctions) ||
    !hasExactChecksums(contract.remote.migrationChecksums, migrationChecksums)
  ) {
    throw new Error("Remote DB observation authority is invalid");
  }
  return assertRemoteDbObservationAuthority(
    contract.remote.observationAuthority,
    { requireConfigured: true },
  );
};

export const assertRemoteDbObservation = (
  evidence,
  { contract, migrationChecksums, now = Date.now },
) => {
  const authority = assertObservationExpectation({
    contract,
    migrationChecksums,
  });
  const observedAt =
    typeof evidence?.observedAt === "string"
      ? Date.parse(evidence.observedAt)
      : Number.NaN;
  const nowMilliseconds = clockMilliseconds(now);
  const canonicalObservedAt =
    Number.isFinite(observedAt) &&
    new Date(observedAt).toISOString() === evidence.observedAt;
  if (
    !hasExactKeys(evidence, REMOTE_DB_OBSERVATION_KEYS) ||
    evidence.schemaVersion !== 1 ||
    evidence.contractFingerprint !== sha256Json(contract) ||
    !hasExactChecksums(evidence.migrationChecksums, migrationChecksums) ||
    evidence.migrationsApplied !== true ||
    evidence.serviceRoleRawSelect !== false ||
    evidence.serviceRoleRawInsert !== true ||
    evidence.cspServiceRoleRawSelect !== false ||
    evidence.cspServiceRoleRawInsert !== true ||
    evidence.cspObjectsPresent !== true ||
    evidence.operatorBoundedFunctionOnly !== true ||
    evidence.cspApplicationCredentialReachable !== false ||
    !hasExactStringSet(
      evidence.requiredTables,
      contract.remote.requiredTables,
    ) ||
    !hasExactStringSet(
      evidence.requiredFunctions,
      contract.remote.requiredFunctions,
    ) ||
    !canonicalObservedAt ||
    observedAt <
      nowMilliseconds - authority.maximumObservationAgeSeconds * 1_000 ||
    observedAt >
      nowMilliseconds + authority.maximumFutureClockSkewSeconds * 1_000
  ) {
    throw new Error(
      "Remote DB evidence does not match the compatibility contract",
    );
  }
  return evidence;
};

const requireSingleRow = (result, label) => {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    (typeof result.rowCount === "number" && result.rowCount !== 1)
  ) {
    throw new Error(`Remote DB ${label} query is ambiguous`);
  }
  return result.rows[0];
};

const requireExactRows = (result, expectedCount, label) => {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== expectedCount ||
    (typeof result.rowCount === "number" && result.rowCount !== expectedCount)
  ) {
    throw new Error(`Remote DB ${label} row set is incomplete`);
  }
  return result.rows;
};

const migrationVersions = (migrationChecksums) =>
  sortedStrings(
    Object.keys(migrationChecksums).map((name) => {
      const match = /^(\d{14})_[a-z0-9_]+\.sql$/u.exec(name);
      if (!match) {
        throw new Error("Remote DB migration identity is invalid");
      }
      return match[1];
    }),
  );

const functionSignature = (row) =>
  `${row.qualified_name}(${row.identity_arguments})`;

const hasSearchPathAuthority = (configuration) =>
  Array.isArray(configuration) &&
  configuration.includes("search_path=pg_catalog, public");

const clockMilliseconds = (now) => {
  const milliseconds = typeof now === "function" ? Number(now()) : Number(now);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Remote DB observation clock is invalid");
  }
  return milliseconds;
};

const identityQuery = (serviceRole) => ({
  name: "foundation-remote-db-observer-identity-v1",
  text: `
    select
      current_user::text as observer_role,
      session_user::text as session_role,
      current_setting('transaction_read_only') as read_only,
      current_setting('server_version_num') as server_version_num,
      roles.rolsuper,
      roles.rolcreaterole,
      roles.rolcreatedb,
      roles.rolreplication,
      roles.rolbypassrls,
      pg_catalog.pg_has_role(current_user, $1::name, 'MEMBER')
        as service_role_member
    from pg_catalog.pg_roles roles
    where roles.rolname = current_user
  `,
  values: [serviceRole],
});

const migrationsQuery = (versions) => ({
  name: "foundation-remote-db-migrations-v1",
  text: `
    select version::text as version
    from supabase_migrations.schema_migrations
    where version = any($1::text[])
    order by version
  `,
  values: [versions],
});

const relationsQuery = (requiredTables) => ({
  name: "foundation-remote-db-relations-v1",
  text: `
    select
      n.nspname || '.' || c.relname as qualified_name,
      c.relkind,
      c.relrowsecurity as row_security
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = any($1::text[])
    order by qualified_name
  `,
  values: [requiredTables],
});

const functionsQuery = (requiredFunctions) => ({
  name: "foundation-remote-db-functions-v1",
  text: `
    select
      n.nspname || '.' || p.proname as qualified_name,
      pg_catalog.oidvectortypes(p.proargtypes) as identity_arguments,
      p.prosecdef as security_definer,
      p.proconfig as configuration
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname || '.' || p.proname = any($1::text[])
    order by qualified_name, identity_arguments
  `,
  values: [requiredFunctions],
});

const tablePrivilegesQuery = (requiredTables, serviceRole) => ({
  name: "foundation-remote-db-table-privileges-v1",
  text: `
    select
      requested.object_name,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'SELECT'
      ) as service_select,
      pg_catalog.has_table_privilege(
        $2, requested.object_name, 'INSERT'
      ) as service_insert,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'SELECT'
      ) as observer_select,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'INSERT'
      ) as observer_insert,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'UPDATE'
      ) as observer_update,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'DELETE'
      ) as observer_delete,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'TRUNCATE'
      ) as observer_truncate,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'REFERENCES'
      ) as observer_references,
      pg_catalog.has_table_privilege(
        current_user, requested.object_name, 'TRIGGER'
      ) as observer_trigger
    from unnest($1::text[]) as requested(object_name)
    order by requested.object_name
  `,
  values: [requiredTables, serviceRole],
});

const functionPrivilegesQuery = (signatures, serviceRole) => ({
  name: "foundation-remote-db-function-privileges-v1",
  text: `
    select
      requested.function_signature,
      pg_catalog.has_function_privilege(
        $2, requested.function_signature, 'EXECUTE'
      ) as service_execute,
      pg_catalog.has_function_privilege(
        current_user, requested.function_signature, 'EXECUTE'
      ) as observer_execute
    from unnest($1::text[]) as requested(function_signature)
    order by requested.function_signature
  `,
  values: [signatures, serviceRole],
});

const cspConstraintsQuery = Object.freeze({
  name: "foundation-remote-db-csp-constraints-v1",
  text: `
    select constraint_definition.conname as constraint_name,
      constraint_definition.convalidated as validated
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid =
        pg_catalog.to_regclass('public.csp_violation_reports')
      and constraint_definition.conname = any($1::text[])
    order by constraint_definition.conname
  `,
  values: [CSP_CONSTRAINTS],
});

const observerHasRawPrivilege = (row) =>
  [
    "observer_select",
    "observer_insert",
    "observer_update",
    "observer_delete",
    "observer_truncate",
    "observer_references",
    "observer_trigger",
  ].some((key) => row[key] !== false);

export const collectRemoteDbObservation = async ({
  client,
  contract,
  migrationChecksums,
  providerPolicy,
  providerObservation,
  expectedObserverRole,
  now = Date.now,
}) => {
  const authority = assertObservationExpectation({
    contract,
    migrationChecksums,
  });
  if (
    !client ||
    typeof client.query !== "function" ||
    !isAuthorityString(expectedObserverRole, 63) ||
    !authority.allowedObserverRoles.includes(expectedObserverRole) ||
    !isRecord(providerPolicy) ||
    !Array.isArray(providerPolicy.cspReportEnvironmentNames) ||
    providerPolicy.cspReportEnvironmentNames.length === 0 ||
    providerPolicy.cspReportEnvironmentNames.some(
      (name) => typeof name !== "string" || name.length === 0,
    ) ||
    !isRecord(providerObservation) ||
    !Array.isArray(providerObservation.presentEnvironmentNames) ||
    providerObservation.presentEnvironmentNames.some(
      (name) => typeof name !== "string" || name.length === 0,
    )
  ) {
    throw new Error("Remote DB collector input is invalid");
  }
  const nowMilliseconds = clockMilliseconds(now);

  const requiredTables = sortedStrings(contract.remote.requiredTables);
  const requiredFunctions = sortedStrings(contract.remote.requiredFunctions);
  if (
    !hasExactStringSet(requiredTables, [METRICS_TABLE, CSP_TABLE]) ||
    !hasExactStringSet(requiredFunctions, Object.keys(FUNCTION_ARGUMENTS))
  ) {
    throw new Error("Remote DB v1 object authority is invalid");
  }

  let transactionStarted = false;
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    transactionStarted = true;

    const identity = requireSingleRow(
      await client.query(identityQuery(authority.serviceRole)),
      "observer identity",
    );
    const serverVersionNumber = Number(identity.server_version_num);
    if (
      identity.observer_role !== expectedObserverRole ||
      identity.session_role !== expectedObserverRole ||
      identity.read_only !== "on" ||
      !Number.isSafeInteger(serverVersionNumber) ||
      Math.trunc(serverVersionNumber / 10_000) !== authority.postgresMajor ||
      identity.rolsuper !== false ||
      identity.rolcreaterole !== false ||
      identity.rolcreatedb !== false ||
      identity.rolreplication !== false ||
      identity.rolbypassrls !== false ||
      identity.service_role_member !== false
    ) {
      throw new Error("Remote DB observer role authority is invalid");
    }

    const versions = migrationVersions(migrationChecksums);
    const observedMigrations = requireExactRows(
      await client.query(migrationsQuery(versions)),
      versions.length,
      "migration",
    ).map((row) => String(row.version));
    const migrationsApplied = hasExactStringSet(observedMigrations, versions);

    const relationRows = requireExactRows(
      await client.query(relationsQuery(requiredTables)),
      requiredTables.length,
      "relation",
    );
    const observedTables = relationRows.map((row) => row.qualified_name);
    if (
      !hasExactStringSet(observedTables, requiredTables) ||
      relationRows.some(
        (row) =>
          (row.relkind !== "r" && row.relkind !== "p") ||
          row.row_security !== true,
      )
    ) {
      throw new Error("Remote DB required relation contract differs");
    }

    const functionRows = requireExactRows(
      await client.query(functionsQuery(requiredFunctions)),
      requiredFunctions.length,
      "function",
    );
    const observedFunctions = functionRows.map((row) => row.qualified_name);
    if (
      !hasExactStringSet(observedFunctions, requiredFunctions) ||
      functionRows.some(
        (row) =>
          row.identity_arguments !== FUNCTION_ARGUMENTS[row.qualified_name] ||
          row.security_definer !== true ||
          !hasSearchPathAuthority(row.configuration),
      )
    ) {
      throw new Error("Remote DB bounded function contract differs");
    }

    const tablePrivilegeRows = requireExactRows(
      await client.query(
        tablePrivilegesQuery(requiredTables, authority.serviceRole),
      ),
      requiredTables.length,
      "table privilege",
    );
    const privilegesByTable = new Map(
      tablePrivilegeRows.map((row) => [row.object_name, row]),
    );
    if (
      privilegesByTable.size !== requiredTables.length ||
      requiredTables.some((table) => !privilegesByTable.has(table))
    ) {
      throw new Error("Remote DB table privilege target set differs");
    }
    const metricsPrivileges = privilegesByTable.get(METRICS_TABLE);
    const cspPrivileges = privilegesByTable.get(CSP_TABLE);
    const serviceRoleRawSelect = metricsPrivileges.service_select;
    const serviceRoleRawInsert = metricsPrivileges.service_insert;
    const cspServiceRoleRawSelect = cspPrivileges.service_select;
    const cspServiceRoleRawInsert = cspPrivileges.service_insert;

    const functionSignatures = sortedStrings(
      functionRows.map(functionSignature),
    );
    const functionPrivilegeRows = requireExactRows(
      await client.query(
        functionPrivilegesQuery(functionSignatures, authority.serviceRole),
      ),
      functionSignatures.length,
      "function privilege",
    );
    const functionPrivilegesBySignature = new Map(
      functionPrivilegeRows.map((row) => [row.function_signature, row]),
    );
    const operatorFunctionAuthority = functionRows.every((row) => {
      const privileges = functionPrivilegesBySignature.get(
        functionSignature(row),
      );
      const isReadFunction = row.qualified_name.includes(".read_");
      return (
        privileges &&
        privileges.service_execute === false &&
        privileges.observer_execute === isReadFunction
      );
    });
    const operatorBoundedFunctionOnly =
      tablePrivilegeRows.every((row) => !observerHasRawPrivilege(row)) &&
      operatorFunctionAuthority;

    const constraintRows = requireExactRows(
      await client.query(cspConstraintsQuery),
      CSP_CONSTRAINTS.length,
      "CSP constraint",
    );
    const cspObjectsPresent =
      hasExactStringSet(
        constraintRows.map((row) => row.constraint_name),
        CSP_CONSTRAINTS,
      ) &&
      constraintRows.every((row) => row.validated === true) &&
      observedTables.includes(CSP_TABLE) &&
      observedFunctions.includes("public.read_csp_violation_aggregates") &&
      observedFunctions.includes("public.retain_csp_violation_reports");

    const presentEnvironmentNames = new Set(
      providerObservation.presentEnvironmentNames,
    );
    const cspApplicationCredentialReachable =
      providerPolicy.cspReportEnvironmentNames.some((name) =>
        presentEnvironmentNames.has(name),
      );

    const evidence = {
      schemaVersion: 1,
      contractFingerprint: sha256Json(contract),
      migrationChecksums: { ...migrationChecksums },
      migrationsApplied,
      serviceRoleRawSelect,
      serviceRoleRawInsert,
      cspServiceRoleRawSelect,
      cspServiceRoleRawInsert,
      cspObjectsPresent,
      operatorBoundedFunctionOnly,
      cspApplicationCredentialReachable,
      requiredTables,
      requiredFunctions,
      observedAt: new Date(nowMilliseconds).toISOString(),
    };
    assertRemoteDbObservation(evidence, {
      contract,
      migrationChecksums,
      now: nowMilliseconds,
    });
    await client.query("commit");
    transactionStarted = false;
    return evidence;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the authoritative collection failure.
      }
    }
    throw error;
  }
};
