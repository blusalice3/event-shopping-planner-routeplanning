import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  parseRemoteDbObservationArguments,
  runRemoteDbObservationCli,
} from "./collect-remote-db-observation.mjs";
import {
  REMOTE_DB_OBSERVATION_KEYS,
  assertRemoteDbObservation,
  assertRemoteDbObservationAuthority,
  collectRemoteDbObservation,
} from "./remote-db-observation.mjs";
import {
  REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  putRemoteDbObservationAuthority,
  putRemoteDbObservationOidcAuthority,
  putRemoteDbObservationProductionAuthority,
  putRemoteDbProviderObservationAuthority,
  putReviewedRemoteDbObservationProductionAuthority,
  readRemoteDbObservationProductionAuthority,
  readReviewedRemoteDbObservationProductionAuthority,
  readStoredRemoteDbObservationAuthority,
} from "./remote-db-observation-authority.mjs";
import { VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE } from "../provider/collect-vercel-observation.mjs";
import {
  GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
} from "../release-state/reviewedWorkflowRunAuthority.mjs";
import {
  parseProtectedRemoteDbObservationArguments,
  runProtectedRemoteDbObservationCli,
} from "./produce-remote-db-observation.mjs";

const NOW = Date.parse("2026-08-09T04:05:06.000Z");
const OBSERVER_CA = "observer-secret-ca";
const MIGRATION_BYTES = Object.freeze({
  "20260805000000_persistence_release_a_hardening.sql": Buffer.from(
    "hardening migration fixture\n",
    "utf8",
  ),
  "20260808000000_csp_report_contract.sql": Buffer.from(
    "CSP migration fixture\n",
    "utf8",
  ),
  "20260809000000_csp_report_deployment_aggregate.sql": Buffer.from(
    "CSP deployment aggregate fixture\n",
    "utf8",
  ),
});
const MIGRATION_CHECKSUMS = Object.freeze(
  Object.fromEntries(
    Object.entries(MIGRATION_BYTES).map(([name, bytes]) => [
      name,
      sha256Bytes(bytes),
    ]),
  ),
);
const REQUIRED_TABLES = Object.freeze([
  "public.persistence_release_a_metric_events",
  "public.csp_violation_reports",
]);
const REQUIRED_FUNCTIONS = Object.freeze([
  "public.read_persistence_release_a_metrics",
  "public.retain_persistence_release_a_metrics",
  "public.read_csp_violation_aggregates",
  "public.read_csp_deployment_violation_aggregates",
  "public.retain_csp_violation_reports",
]);
const OBSERVATION_AUTHORITY = Object.freeze({
  bindingStatus: "configured",
  postgresMajor: 17,
  databaseUrlEnvironmentName: "DB_COMPATIBILITY_OBSERVER_DATABASE_URL",
  databaseCaEnvironmentName: "DB_COMPATIBILITY_OBSERVER_CA_PEM",
  tlsMode: "verify-full",
  allowedHosts: ["db.example.test"],
  allowedDatabases: ["postgres"],
  allowedObserverRoles: ["foundation_db_observer"],
  serviceRole: "service_role",
  productionCaSha256: sha256Bytes(Buffer.from(OBSERVER_CA, "utf8")),
  connectTimeoutMilliseconds: 5_000,
  statementTimeoutMilliseconds: 15_000,
  maximumObservationAgeSeconds: 300,
  maximumFutureClockSkewSeconds: 30,
});
const CONTRACT = Object.freeze({
  schemaVersion: 1,
  contractStatus: "remote-verified",
  contractUri: "urn:event-shopping-planner:db-compatibility:test-v1",
  remote: {
    observationStatus: "observed",
    observationAuthority: OBSERVATION_AUTHORITY,
    requiredTables: REQUIRED_TABLES,
    requiredFunctions: REQUIRED_FUNCTIONS,
    migrationChecksums: MIGRATION_CHECKSUMS,
  },
  blockerCodes: [],
});
const BASE_PROVIDER_POLICY = JSON.parse(
  await readFile(
    new URL("../../config/provider-policy.json", import.meta.url),
    "utf8",
  ),
);
const providerWafRule = (id, route) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: route }] }],
  rateLimit: null,
});
const PROVIDER_POLICY = Object.freeze({
  ...BASE_PROVIDER_POLICY,
  bindingStatus: "configured",
  expectedTeamId: "team_test",
  expectedProjectId: "prj_test",
  ownedProductionDomains: ["example.test"],
  requiredEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  cspReportEnvironmentNames: [
    "CSP_REPORT_DB_SERVICE_ROLE_KEY",
    "CSP_REPORT_DB_URL",
  ],
  forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
  wafRules: {
    metricsRoute: providerWafRule(
      "rule_metrics",
      "/api/persistence-release-a-metrics",
    ),
    cspReportRoute: providerWafRule("rule_csp", "/api/csp-report"),
    googleSheetsCsvRoute: providerWafRule(
      "rule_sheets",
      "/api/google-sheets-csv",
    ),
  },
  logPolicy: {
    ...BASE_PROVIDER_POLICY.logPolicy,
    retentionDays: 1,
    retentionObservation: {
      kind: "vercel-runtime-plan-v1",
      observabilityPlus: false,
      drainId: null,
      jsonPointer: null,
    },
  },
  hstsPolicy: {
    minimumMaxAgeSeconds: 31_536_000,
    requireIncludeSubDomains: true,
    requirePreload: false,
  },
  blockerCodes: [],
});
const providerRequestUrl = (pathname, query = {}) => {
  const url = new URL(pathname, PROVIDER_POLICY.observationPolicy.apiBaseUrl);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, String(value));
  }
  url.searchParams.sort();
  return url.href;
};
const providerReceipt = (kind, requestUrl, { hsts = null } = {}) => {
  const value = {
    kind,
    method: "GET",
    requestUrl,
    status: 200,
    responseDate: new Date(NOW).toUTCString(),
    etag: null,
    contentType: kind.startsWith("hsts:") ? null : "application/json",
    strictTransportSecurity: hsts,
    bodySha256: "2".repeat(64),
  };
  return {
    ...value,
    responseSha256: sha256Json({
      status: value.status,
      responseDate: value.responseDate,
      etag: value.etag,
      contentType: value.contentType,
      strictTransportSecurity: value.strictTransportSecurity,
      bodySha256: value.bodySha256,
    }),
  };
};
const PROVIDER_OBSERVATION = Object.freeze({
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: new Date(NOW).toISOString(),
  providerTeamId: "team_test",
  providerProjectId: "prj_test",
  productionEnvironmentName: "production",
  providerNodeFamily: "24.x",
  productionBranch: "main",
  autoAssignCustomProductionDomains: false,
  gitProductionAutoDeploy: false,
  gitPreviewAutoDeploy: false,
  gitIntegration: {
    connected: true,
    provider: "github",
    productionBranch: "main",
  },
  allowedPreviewBranches: [],
  ownedProductionDomains: ["example.test"],
  presentEnvironmentNames: ["PERSISTENCE_METRICS_SUPABASE_URL"],
  rawRequestByteCeilings: PROVIDER_POLICY.rawRequestByteCeilings,
  wafRules: PROVIDER_POLICY.wafRules,
  logPolicy: PROVIDER_POLICY.logPolicy,
  logRetentionEvidence: {
    kind: "vercel-runtime-plan-v1",
    plan: "pro",
    activeLogDrainIds: ["drain_logs"],
    retentionDays: 1,
  },
  hstsOwner: "provider",
  hstsPolicy: PROVIDER_POLICY.hstsPolicy,
  hsts: [
    {
      domain: "example.test",
      maxAgeSeconds: 63_072_000,
      includeSubDomains: true,
      preload: false,
    },
  ],
  configurationEvidenceKinds: [
    ...PROVIDER_POLICY.requiredConfigurationEvidence,
  ].sort(),
  evidenceReceipts: [
    providerReceipt("team", providerRequestUrl("/v2/teams/team_test")),
    providerReceipt(
      "project",
      providerRequestUrl("/v9/projects/prj_test", { teamId: "team_test" }),
    ),
    providerReceipt(
      "domains",
      providerRequestUrl("/v9/projects/prj_test/domains", {
        teamId: "team_test",
        limit: 100,
        production: true,
      }),
    ),
    providerReceipt(
      "environment-presence",
      providerRequestUrl("/v10/projects/prj_test/env", {
        teamId: "team_test",
        decrypt: false,
      }),
    ),
    providerReceipt(
      "waf",
      providerRequestUrl("/v1/security/firewall/config/active", {
        projectId: "prj_test",
        teamId: "team_test",
      }),
    ),
    providerReceipt(
      "log-retention",
      providerRequestUrl("/v1/drains", {
        includeMetadata: true,
        projectId: "prj_test",
        teamId: "team_test",
      }),
    ),
    providerReceipt("hsts:example.test", "https://example.test/", {
      hsts: "max-age=63072000; includeSubDomains",
    }),
  ].sort((left, right) => left.kind.localeCompare(right.kind)),
});
const APPROVAL_POLICY = Object.freeze({
  bindingStatus: "configured",
  trustedIssuer: "https://token.actions.githubusercontent.com",
  oidcAudience: "urn:event-shopping-planner:foundation-release-state",
  oidcClockSkewSeconds: 60,
  oidcMaxTokenAgeSeconds: 600,
  repository: "owner/repository",
  workflowRef: "owner/repository/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
  blockerCodes: [],
});
const oidcReceipt = ({ sourceSha, runId, runAttempt }) => ({
  schemaVersion: 1,
  kind: "github-actions-oidc-verification/v1",
  issuer: APPROVAL_POLICY.trustedIssuer,
  audience: APPROVAL_POLICY.oidcAudience,
  subject: "repo:owner/repository:environment:foundation-release-state",
  tokenSha256: "3".repeat(64),
  signingKey: {
    kid: "fixture-key",
    jwkThumbprintSha256: "4".repeat(64),
  },
  claims: {
    repository: APPROVAL_POLICY.repository,
    workflowRef: APPROVAL_POLICY.workflowRef,
    workflowSha: sourceSha,
    environment: APPROVAL_POLICY.protectedEnvironment,
    runId,
    runAttempt,
    sourceSha,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    refProtected: true,
    jti: "remote-db-fixture",
    issuedAt: new Date(NOW - 60_000).toISOString(),
    notBefore: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 540_000).toISOString(),
  },
  verifiedAt: new Date(NOW).toISOString(),
});

const FUNCTION_ROWS = Object.freeze([
  {
    qualified_name: "public.read_csp_deployment_violation_aggregates",
    identity_arguments:
      "timestamp with time zone, timestamp with time zone, text, text, integer",
    security_definer: true,
    configuration: ["search_path=pg_catalog, public"],
  },
  {
    qualified_name: "public.read_csp_violation_aggregates",
    identity_arguments:
      "timestamp with time zone, timestamp with time zone, integer",
    security_definer: true,
    configuration: ["search_path=pg_catalog, public"],
  },
  {
    qualified_name: "public.read_persistence_release_a_metrics",
    identity_arguments:
      "timestamp with time zone, timestamp with time zone, integer",
    security_definer: true,
    configuration: ["search_path=pg_catalog, public"],
  },
  {
    qualified_name: "public.retain_csp_violation_reports",
    identity_arguments: "boolean, integer, integer",
    security_definer: true,
    configuration: ["search_path=pg_catalog, public"],
  },
  {
    qualified_name: "public.retain_persistence_release_a_metrics",
    identity_arguments: "boolean, integer, integer",
    security_definer: true,
    configuration: ["search_path=pg_catalog, public"],
  },
]);

const falseObserverPrivileges = Object.freeze({
  observer_select: false,
  observer_insert: false,
  observer_update: false,
  observer_delete: false,
  observer_truncate: false,
  observer_references: false,
  observer_trigger: false,
});

const baseResponses = () => ({
  "foundation-remote-db-observer-identity-v1": [
    {
      observer_role: "foundation_db_observer",
      session_role: "foundation_db_observer",
      read_only: "on",
      server_version_num: "170003",
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      service_role_member: false,
    },
  ],
  "foundation-remote-db-migrations-v1": [
    { version: "20260805000000" },
    { version: "20260808000000" },
    { version: "20260809000000" },
  ],
  "foundation-remote-db-relations-v1": [
    {
      qualified_name: "public.csp_violation_reports",
      relkind: "r",
      row_security: true,
    },
    {
      qualified_name: "public.persistence_release_a_metric_events",
      relkind: "r",
      row_security: true,
    },
  ],
  "foundation-remote-db-functions-v1": FUNCTION_ROWS,
  "foundation-remote-db-table-privileges-v1": [
    {
      object_name: "public.csp_violation_reports",
      service_select: false,
      service_insert: true,
      ...falseObserverPrivileges,
    },
    {
      object_name: "public.persistence_release_a_metric_events",
      service_select: false,
      service_insert: true,
      ...falseObserverPrivileges,
    },
  ],
  "foundation-remote-db-function-privileges-v1": FUNCTION_ROWS.map((row) => ({
    function_signature: `${row.qualified_name}(${row.identity_arguments})`,
    service_execute: false,
    observer_execute: row.qualified_name.includes(".read_"),
  })),
  "foundation-remote-db-csp-constraints-v1": [
    {
      constraint_name: "csp_violation_reports_blocked_target_check",
      validated: true,
    },
    {
      constraint_name: "csp_violation_reports_effective_directive_check",
      validated: true,
    },
  ],
});

const createFakeClient = ({ reverseRows = false, mutate } = {}) => {
  const responses = baseResponses();
  mutate?.(responses);
  const calls = [];
  return {
    calls,
    connected: false,
    ended: false,
    async connect() {
      this.connected = true;
    },
    async end() {
      this.ended = true;
    },
    async query(statement) {
      const text = typeof statement === "string" ? statement : statement.text;
      calls.push({
        name: typeof statement === "string" ? null : statement.name,
        text,
        values: typeof statement === "string" ? undefined : statement.values,
      });
      if (typeof statement === "string") {
        const command = statement.trim().toLowerCase();
        if (
          command.startsWith("begin transaction") ||
          command === "commit" ||
          command === "rollback"
        ) {
          return { rows: [], rowCount: null };
        }
        throw new Error(`Unexpected transaction command: ${command}`);
      }
      if (!Object.hasOwn(responses, statement.name)) {
        throw new Error(`Unexpected prepared query: ${statement.name}`);
      }
      const rows = structuredClone(responses[statement.name]);
      if (reverseRows) rows.reverse();
      return { rows, rowCount: rows.length };
    },
  };
};

const validEvidence = () => ({
  schemaVersion: 1,
  contractFingerprint: sha256Json(CONTRACT),
  migrationChecksums: { ...MIGRATION_CHECKSUMS },
  migrationsApplied: true,
  serviceRoleRawSelect: false,
  serviceRoleRawInsert: true,
  cspServiceRoleRawSelect: false,
  cspServiceRoleRawInsert: true,
  cspObjectsPresent: true,
  operatorBoundedFunctionOnly: true,
  cspApplicationCredentialReachable: false,
  requiredTables: [...REQUIRED_TABLES],
  requiredFunctions: [...REQUIRED_FUNCTIONS],
  observedAt: new Date(NOW).toISOString(),
});

test("remote DB observation authority is closed and explicitly configurable", () => {
  assert.equal(
    assertRemoteDbObservationAuthority(OBSERVATION_AUTHORITY, {
      requireConfigured: true,
    }),
    OBSERVATION_AUTHORITY,
  );
  assert.throws(
    () =>
      assertRemoteDbObservationAuthority({
        ...OBSERVATION_AUTHORITY,
        unreviewedProperty: true,
      }),
    /authority is invalid/u,
  );

  const unconfiguredAuthority = {
    ...OBSERVATION_AUTHORITY,
    bindingStatus: "unconfigured",
    allowedHosts: [],
    allowedDatabases: [],
    allowedObserverRoles: [],
    productionCaSha256: null,
  };
  assert.equal(
    assertRemoteDbObservationAuthority(unconfiguredAuthority),
    unconfiguredAuthority,
  );
  assert.throws(
    () =>
      assertRemoteDbObservationAuthority(unconfiguredAuthority, {
        requireConfigured: true,
      }),
    /authority is not configured/u,
  );
  assert.throws(
    () =>
      assertRemoteDbObservationAuthority({
        ...unconfiguredAuthority,
        allowedHosts: ["db.example.test"],
      }),
    /authority is invalid/u,
  );
});

test("shared remote DB assertion closes the existing 14-key evidence shape", () => {
  const evidence = validEvidence();
  assert.deepEqual(
    Object.keys(evidence).sort(),
    [...REMOTE_DB_OBSERVATION_KEYS].sort(),
  );
  assert.equal(
    assertRemoteDbObservation(evidence, {
      contract: CONTRACT,
      migrationChecksums: MIGRATION_CHECKSUMS,
      now: NOW,
    }),
    evidence,
  );
  assert.throws(
    () =>
      assertRemoteDbObservation(
        { ...evidence, unreviewedProperty: true },
        {
          contract: CONTRACT,
          migrationChecksums: MIGRATION_CHECKSUMS,
          now: NOW,
        },
      ),
    /does not match the compatibility contract/u,
  );
  assert.throws(
    () =>
      assertRemoteDbObservation(
        { ...evidence, serviceRoleRawSelect: true },
        {
          contract: CONTRACT,
          migrationChecksums: MIGRATION_CHECKSUMS,
          now: NOW,
        },
      ),
    /does not match the compatibility contract/u,
  );
  assert.throws(
    () =>
      assertRemoteDbObservation(
        {
          ...evidence,
          requiredTables: [
            ...evidence.requiredTables,
            evidence.requiredTables[0],
          ],
        },
        {
          contract: CONTRACT,
          migrationChecksums: MIGRATION_CHECKSUMS,
          now: NOW,
        },
      ),
    /does not match the compatibility contract/u,
  );
  for (const observedAt of [
    new Date(
      NOW - (OBSERVATION_AUTHORITY.maximumObservationAgeSeconds + 1) * 1_000,
    ).toISOString(),
    new Date(
      NOW + (OBSERVATION_AUTHORITY.maximumFutureClockSkewSeconds + 1) * 1_000,
    ).toISOString(),
  ]) {
    assert.throws(
      () =>
        assertRemoteDbObservation(
          { ...evidence, observedAt },
          {
            contract: CONTRACT,
            migrationChecksums: MIGRATION_CHECKSUMS,
            now: NOW,
          },
        ),
      /does not match the compatibility contract/u,
    );
  }
});

test("collector uses a read-only repeatable snapshot and emits deterministic evidence", async () => {
  const firstClient = createFakeClient();
  const secondClient = createFakeClient({ reverseRows: true });
  const options = {
    contract: CONTRACT,
    migrationChecksums: MIGRATION_CHECKSUMS,
    providerPolicy: PROVIDER_POLICY,
    providerObservation: PROVIDER_OBSERVATION,
    expectedObserverRole: "foundation_db_observer",
    now: NOW,
  };
  const first = await collectRemoteDbObservation({
    ...options,
    client: firstClient,
  });
  const second = await collectRemoteDbObservation({
    ...options,
    client: secondClient,
  });
  assert.deepEqual(canonicalJsonBytes(first), canonicalJsonBytes(second));
  assert.deepEqual(first, {
    ...validEvidence(),
    requiredTables: [...REQUIRED_TABLES].sort(),
    requiredFunctions: [...REQUIRED_FUNCTIONS].sort(),
  });
  assert.match(
    firstClient.calls[0].text,
    /^begin transaction isolation level repeatable read read only$/u,
  );
  assert.equal(firstClient.calls.at(-1).text, "commit");
  for (const call of firstClient.calls.filter(({ name }) => name !== null)) {
    assert.match(call.text.trimStart(), /^select\b/u);
  }
  for (const queryName of [
    "foundation-remote-db-observer-identity-v1",
    "foundation-remote-db-table-privileges-v1",
    "foundation-remote-db-function-privileges-v1",
  ]) {
    assert.equal(
      firstClient.calls
        .find(({ name }) => name === queryName)
        .values.includes(OBSERVATION_AUTHORITY.serviceRole),
      true,
    );
  }
});

test("collector rolls back on missing schema, elevated observer, or CSP credential reachability", async () => {
  const cases = [
    {
      mutate(responses) {
        responses["foundation-remote-db-relations-v1"].pop();
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /relation row set is incomplete/u,
    },
    {
      mutate(responses) {
        responses["foundation-remote-db-observer-identity-v1"][0].rolsuper =
          true;
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      mutate(responses) {
        const identity =
          responses["foundation-remote-db-observer-identity-v1"][0];
        identity.observer_role = "wrong_observer";
        identity.session_role = "wrong_observer";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      mutate(responses) {
        responses[
          "foundation-remote-db-observer-identity-v1"
        ][0].server_version_num = "160010";
      },
      providerObservation: PROVIDER_OBSERVATION,
      pattern: /observer role authority is invalid/u,
    },
    {
      providerObservation: {
        presentEnvironmentNames: ["CSP_REPORT_DB_URL"],
      },
      pattern: /does not match the compatibility contract/u,
    },
  ];
  for (const fixture of cases) {
    const client = createFakeClient({ mutate: fixture.mutate });
    await assert.rejects(
      collectRemoteDbObservation({
        client,
        contract: CONTRACT,
        migrationChecksums: MIGRATION_CHECKSUMS,
        providerPolicy: PROVIDER_POLICY,
        providerObservation: fixture.providerObservation,
        expectedObserverRole: "foundation_db_observer",
        now: NOW,
      }),
      fixture.pattern,
    );
    assert.equal(client.calls.at(-1).text, "rollback");
    assert.equal(
      client.calls.some(({ text }) => text === "commit"),
      false,
    );
  }
});

test("collector CLI binds TLS credentials, writes canonical bytes with wx, and logs no secret", async () => {
  const client = createFakeClient();
  const writes = [];
  const output = [];
  const observerPassword = "observer-secret-value";
  let clientOptions;
  const result = await runRemoteDbObservationCli(
    {
      argv: [
        "--provider-observation",
        "provider-observation.json",
        "--output",
        "remote-db-observation.json",
      ],
      env: {
        DB_COMPATIBILITY_OBSERVER_DATABASE_URL:
          `postgresql://foundation_db_observer:${observerPassword}` +
          "@db.example.test:5432/postgres?sslmode=verify-full",
        DB_COMPATIBILITY_OBSERVER_CA_PEM: OBSERVER_CA,
      },
      cwd: "C:\\fixture",
      stdout: { write: (value) => output.push(value) },
    },
    {
      loadJson: async (filePath) => {
        const name = pathBasename(filePath);
        if (name === "db-compatibility-contract.json") return CONTRACT;
        if (name === "provider-policy.json") return PROVIDER_POLICY;
        if (name === "provider-observation.json") return PROVIDER_OBSERVATION;
        throw new Error(`Unexpected JSON path: ${name}`);
      },
      readFileImpl: async (filePath) => {
        const bytes = MIGRATION_BYTES[pathBasename(filePath)];
        if (!bytes) throw new Error("Unexpected migration path");
        return bytes;
      },
      writeFileImpl: async (filePath, bytes, options) => {
        writes.push({ filePath, bytes: Buffer.from(bytes), options });
      },
      createClient: async (options) => {
        clientOptions = options;
        return client;
      },
      validateProviderObservation: () => {},
      now: NOW,
    },
  );
  assert.equal(client.connected, true);
  assert.equal(client.ended, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, "wx");
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(writes[0].bytes, canonicalJsonBytes(result.evidence));
  assert.equal(clientOptions.ssl.ca, OBSERVER_CA);
  assert.equal(clientOptions.ssl.rejectUnauthorized, true);
  assert.equal(clientOptions.connectionString.includes("sslmode"), false);
  assert.equal(
    clientOptions.connectionTimeoutMillis,
    OBSERVATION_AUTHORITY.connectTimeoutMilliseconds,
  );
  assert.equal(
    clientOptions.statement_timeout,
    OBSERVATION_AUTHORITY.statementTimeoutMilliseconds,
  );
  const publicOutput = `${output.join("")}\n${writes[0].bytes.toString("utf8")}`;
  assert.equal(publicOutput.includes(observerPassword), false);
  assert.equal(publicOutput.includes(OBSERVER_CA), false);
  assert.match(
    output.join(""),
    /^PASS wrote remote DB observation [0-9a-f]{64}\n$/u,
  );
});

test("collector CLI rejects host, database, role, and CA outside configured authority", async () => {
  const validUrl =
    "postgresql://foundation_db_observer:secret" +
    "@db.example.test:5432/postgres?sslmode=verify-full";
  const fixtures = [
    {
      url: validUrl.replace("db.example.test", "wrong.example.test"),
      ca: OBSERVER_CA,
    },
    {
      url: validUrl.replace("/postgres?", "/wrong_database?"),
      ca: OBSERVER_CA,
    },
    {
      url: validUrl.replace(
        "foundation_db_observer:secret",
        "wrong_observer:secret",
      ),
      ca: OBSERVER_CA,
    },
    { url: validUrl, ca: "wrong-ca" },
  ];

  for (const fixture of fixtures) {
    let clientCreations = 0;
    await assert.rejects(
      runRemoteDbObservationCli(
        {
          argv: [
            "--provider-observation",
            "provider-observation.json",
            "--output",
            "remote-db-observation.json",
          ],
          env: {
            DB_COMPATIBILITY_OBSERVER_DATABASE_URL: fixture.url,
            DB_COMPATIBILITY_OBSERVER_CA_PEM: fixture.ca,
          },
          cwd: "C:\\fixture",
        },
        {
          loadJson: async (filePath) => {
            const name = pathBasename(filePath);
            if (name === "db-compatibility-contract.json") return CONTRACT;
            if (name === "provider-policy.json") return PROVIDER_POLICY;
            if (name === "provider-observation.json") {
              return PROVIDER_OBSERVATION;
            }
            throw new Error(`Unexpected JSON path: ${name}`);
          },
          readFileImpl: async (filePath) => {
            const bytes = MIGRATION_BYTES[pathBasename(filePath)];
            if (!bytes) throw new Error("Unexpected migration path");
            return bytes;
          },
          writeFileImpl: async () => {
            throw new Error("Invalid authority must not write evidence");
          },
          createClient: async () => {
            clientCreations += 1;
            throw new Error("Invalid authority must not create a client");
          },
          validateProviderObservation: () => {},
          now: NOW,
        },
      ),
      /connection authority is invalid/u,
    );
    assert.equal(clientCreations, 0);
  }
});

test("collector CLI rejects malformed and aliasing arguments", () => {
  assert.throws(
    () => parseRemoteDbObservationArguments(["--output", "only.json"]),
    /Usage/u,
  );
  assert.throws(
    () =>
      parseRemoteDbObservationArguments([
        "--output",
        "first.json",
        "--output",
        "second.json",
      ]),
    /duplicate/u,
  );
});

const createEvidenceStore = () => {
  const objects = new Map();
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    store: {
      namespace: "remote-db-authority-test",
      async putEvidence({ bytes, mediaType }) {
        const input = Buffer.from(bytes);
        const sha256 = sha256Bytes(input);
        const committedAt = "2026-08-09T04:05:07.000Z";
        objects.set(sha256, { bytes: input, mediaType, committedAt });
        return {
          uri: `release-state://remote-db-authority-test/evidence/${sha256}`,
          sha256,
          mediaType,
          byteLength: input.length,
          committedAt,
          replayed: false,
        };
      },
      async readEvidence({ sha256 }) {
        const stored = objects.get(sha256);
        return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : null;
      },
      async close() {
        closed = true;
      },
    },
    objects,
  };
};

const putStoreJson = async (store, value, mediaType) => {
  const receipt = await store.putEvidence({
    bytes: canonicalJsonBytes(value),
    mediaType,
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

test("stores canonical remote DB authority with exact media type and readback", async () => {
  const harness = createEvidenceStore();
  const bytes = canonicalJsonBytes(validEvidence());
  const stored = await putRemoteDbObservationAuthority({
    store: harness.store,
    namespace: harness.store.namespace,
    bytes,
    contract: CONTRACT,
    now: () => NOW,
  });
  assert.equal(stored.reference.sha256, sha256Bytes(bytes));
  assert.equal(
    harness.objects.get(stored.reference.sha256).mediaType,
    REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  );
  const readback = await readStoredRemoteDbObservationAuthority({
    store: harness.store,
    namespace: harness.store.namespace,
    reference: stored.reference,
    contract: CONTRACT,
    now: () => NOW,
  });
  assert.deepEqual(readback.observation, validEvidence());
  harness.objects.get(stored.reference.sha256).mediaType = "application/json";
  await assert.rejects(
    readStoredRemoteDbObservationAuthority({
      store: harness.store,
      namespace: harness.store.namespace,
      reference: stored.reference,
      contract: CONTRACT,
      now: () => NOW,
    }),
    /Stored remote DB observation authority differs/u,
  );
});

test("binds an observation to its exact successful producer run", async () => {
  const harness = createEvidenceStore();
  const namespace = harness.store.namespace;
  const sourceSha = "a".repeat(40);
  const runId = "12345";
  const runAttempt = "2";
  const repository = "owner/repository";
  const observation = await putRemoteDbObservationAuthority({
    store: harness.store,
    namespace,
    bytes: canonicalJsonBytes(validEvidence()),
    contract: CONTRACT,
    now: () => NOW,
  });
  const provider = await putRemoteDbProviderObservationAuthority({
    store: harness.store,
    namespace,
    bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
    providerPolicy: PROVIDER_POLICY,
    now: () => NOW,
  });
  const producerOidc = await putRemoteDbObservationOidcAuthority({
    store: harness.store,
    namespace,
    receiptBytes: canonicalJsonBytes(
      oidcReceipt({ sourceSha, runId, runAttempt }),
    ),
    approvalPolicy: APPROVAL_POLICY,
    sourceSha,
    runId,
    runAttempt,
  });
  await assert.rejects(
    putRemoteDbObservationOidcAuthority({
      store: harness.store,
      namespace,
      receiptBytes: canonicalJsonBytes(
        oidcReceipt({ sourceSha, runId, runAttempt }),
      ),
      approvalPolicy: {
        ...APPROVAL_POLICY,
        workflowRef:
          "owner/repository/.github/workflows/performance-evidence.yml@refs/heads/main",
      },
      sourceSha,
      runId,
      runAttempt,
    }),
    /OIDC workflow policy is invalid/u,
  );
  const production = await putRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    sourceSha,
    runId,
    runAttempt,
    observationReference: observation.reference,
    providerObservationReference: provider.reference,
    providerPolicyReference: provider.policyReference,
    producerOidcReference: producerOidc.reference,
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.equal(
    harness.objects.get(production.reference.sha256).mediaType,
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  assert.equal(
    harness.objects.get(provider.reference.sha256).mediaType,
    VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  );
  assert.equal(
    harness.objects.get(provider.policyReference.sha256).mediaType,
    REMOTE_DB_PROVIDER_POLICY_MEDIA_TYPE,
  );
  const productionReadback = await readRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    reference: production.reference,
    observationReference: observation.reference,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.deepEqual(
    productionReadback.providerObservation.observation,
    PROVIDER_OBSERVATION,
  );
  const apiResponse = await putStoreJson(
    harness.store,
    {
      id: Number(runId),
      run_attempt: Number(runAttempt),
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  const reviewedWorkflowRun = await putStoreJson(
    harness.store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository,
      runId,
      runAttempt,
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
  const reviewed = await putReviewedRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    sourceSha,
    producerRunId: runId,
    producerRunAttempt: runAttempt,
    currentWorkflowRunId: "54321",
    repository,
    observationReference: observation.reference,
    productionReceiptReference: production.reference,
    reviewedWorkflowRunReference: reviewedWorkflowRun,
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.equal(
    harness.objects.get(reviewed.reference.sha256).mediaType,
    REVIEWED_REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  const resolved = await readReviewedRemoteDbObservationProductionAuthority({
    store: harness.store,
    namespace,
    reference: reviewed.reference,
    observationReference: observation.reference,
    expectedSourceSha: sourceSha,
    currentWorkflowRunId: "54321",
    contract: CONTRACT,
    approvalPolicy: APPROVAL_POLICY,
    now: () => NOW,
  });
  assert.equal(resolved.authority.runId, runId);
  const unrelatedApiResponse = await putStoreJson(
    harness.store,
    {
      id: 99999,
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
      repository: { full_name: repository },
    },
    GITHUB_WORKFLOW_RUN_RESPONSE_MEDIA_TYPE,
  );
  const unrelatedSuccessfulRun = await putStoreJson(
    harness.store,
    {
      schemaVersion: 1,
      kind: "reviewed-github-workflow-run/v1",
      repository,
      runId: "99999",
      runAttempt: "1",
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: sourceSha,
      apiResponse: unrelatedApiResponse,
    },
    REVIEWED_WORKFLOW_RUN_RECEIPT_MEDIA_TYPE,
  );
  await assert.rejects(
    putReviewedRemoteDbObservationProductionAuthority({
      store: harness.store,
      namespace,
      sourceSha,
      producerRunId: runId,
      producerRunAttempt: runAttempt,
      currentWorkflowRunId: "54321",
      repository,
      observationReference: observation.reference,
      productionReceiptReference: production.reference,
      reviewedWorkflowRunReference: unrelatedSuccessfulRun,
      contract: CONTRACT,
      approvalPolicy: APPROVAL_POLICY,
      now: () => NOW,
    }),
    /Reviewed GitHub workflow run receipt binding differs/u,
  );
  await assert.rejects(
    readReviewedRemoteDbObservationProductionAuthority({
      store: harness.store,
      namespace,
      reference: reviewed.reference,
      observationReference: observation.reference,
      expectedSourceSha: sourceSha,
      currentWorkflowRunId: runId,
      contract: CONTRACT,
      approvalPolicy: APPROVAL_POLICY,
      now: () => NOW,
    }),
    /distinct completed prior run|binding differs/u,
  );
  harness.objects.get(provider.reference.sha256).mediaType = "application/json";
  await assert.rejects(
    readReviewedRemoteDbObservationProductionAuthority({
      store: harness.store,
      namespace,
      reference: reviewed.reference,
      observationReference: observation.reference,
      expectedSourceSha: sourceSha,
      currentWorkflowRunId: "54321",
      contract: CONTRACT,
      approvalPolicy: APPROVAL_POLICY,
      now: () => NOW,
    }),
    /provider observation.*absent|provider observation.*differs/iu,
  );
});

test("protected collector stores closed authority and emits only secret-safe references", async () => {
  const harness = createEvidenceStore();
  const bytes = canonicalJsonBytes(validEvidence());
  const output = [];
  const writes = [];
  const sourceSha = "a".repeat(40);
  let protectedOptions;
  let collectorRuntime;
  let providerSnapshotChecked = false;
  const result = await runProtectedRemoteDbObservationCli(
    {
      argv: [
        "--namespace",
        harness.store.namespace,
        "--authority-output",
        "remote-db-observation-authority.json",
        "--output",
        "remote-db-observation.json",
        "--provider-observation",
        "provider-observation.json",
        "--run-id",
        "12345",
        "--source-sha",
        sourceSha,
      ],
      env: {
        GITHUB_RUN_ATTEMPT: "2",
        REQUESTED_OPERATION: "collect-remote-db-observation",
        RELEASE_STATE_DATABASE_URL: "postgres://release-state-secret",
        RELEASE_STATE_DATABASE_CA_PEM: "release-state-secret-ca",
      },
      cwd: "C:\\fixture",
      stdout: { write: (value) => output.push(value) },
    },
    {
      loadJson: async (filePath) => {
        const name = pathBasename(filePath);
        if (name === "approval-policy.json") {
          return APPROVAL_POLICY;
        }
        if (name === "release-state-store.json") {
          return {
            bindingStatus: "configured",
            databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
          };
        }
        if (name === "db-compatibility-contract.json") return CONTRACT;
        if (name === "provider-policy.json") return PROVIDER_POLICY;
        throw new Error(`Unexpected protected JSON path: ${name}`);
      },
      assertEnvironment: (options) => {
        protectedOptions = options;
      },
      collectObservation: async (runtime) => {
        collectorRuntime = runtime;
        return { bytes, sha256: sha256Bytes(bytes) };
      },
      readProviderObservation: async () => ({
        bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
        async assertUnchanged() {
          providerSnapshotChecked = true;
        },
      }),
      collectOidcReceipt: async () =>
        canonicalJsonBytes(
          oidcReceipt({ sourceSha, runId: "12345", runAttempt: "2" }),
        ),
      createStore: async (options) => {
        assert.equal(
          options.connectionString,
          "postgres://release-state-secret",
        );
        assert.equal(options.ca, "release-state-secret-ca");
        return harness.store;
      },
      writeFileImpl: async (filePath, outputBytes, options) => {
        writes.push({ filePath, bytes: Buffer.from(outputBytes), options });
      },
      now: () => NOW,
    },
  );
  assert.equal(protectedOptions.sourceSha, sourceSha);
  assert.equal(protectedOptions.runId, "12345");
  assert.equal(
    collectorRuntime.argv.includes("provider-observation.json"),
    false,
  );
  assert.match(collectorRuntime.argv.join(" "), /provider-observation\.json/u);
  assert.equal(providerSnapshotChecked, true);
  assert.equal(result.observation.sha256, sha256Bytes(bytes));
  assert.equal(result.mediaTypes.observation, REMOTE_DB_OBSERVATION_MEDIA_TYPE);
  assert.equal(
    result.mediaTypes.providerObservation,
    VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  );
  assert.equal(
    result.mediaTypes.production,
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  assert.equal(
    harness.objects.get(result.production.sha256).mediaType,
    REMOTE_DB_OBSERVATION_PRODUCTION_MEDIA_TYPE,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, "wx");
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(JSON.parse(writes[0].bytes.toString("utf8")), result);
  assert.equal(harness.closed, true);
  const publicOutput = output.join("");
  assert.equal(publicOutput.includes("release-state-secret"), false);
  assert.deepEqual(JSON.parse(publicOutput), result);
});

test("protected collector rejects local environment spoof without trusted OIDC", async () => {
  const sourceSha = "a".repeat(40);
  const argv = [
    "--namespace",
    "remote-db-authority-test",
    "--authority-output",
    "remote-db-observation-authority.json",
    "--output",
    "remote-db-observation.json",
    "--provider-observation",
    "provider-observation.json",
    "--run-id",
    "12345",
    "--source-sha",
    sourceSha,
  ];
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: APPROVAL_POLICY.repository,
    GITHUB_WORKFLOW_REF: APPROVAL_POLICY.workflowRef,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    RELEASE_STATE_NAMESPACE: "remote-db-authority-test",
    REQUESTED_OPERATION: "collect-remote-db-observation",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example.test/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "attacker-controlled-request-token",
  };
  let storeCreated = false;
  await assert.rejects(
    runProtectedRemoteDbObservationCli(
      { argv, env, cwd: "C:\\fixture", stdout: { write: () => undefined } },
      {
        loadJson: async (filePath) => {
          const name = pathBasename(filePath);
          if (name === "approval-policy.json") return APPROVAL_POLICY;
          if (name === "release-state-store.json") {
            return {
              bindingStatus: "configured",
              databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
            };
          }
          if (name === "db-compatibility-contract.json") return CONTRACT;
          if (name === "provider-policy.json") return PROVIDER_POLICY;
          throw new Error(`Unexpected protected JSON path: ${name}`);
        },
        collectObservation: async () => {
          const bytes = canonicalJsonBytes(validEvidence());
          return { bytes, sha256: sha256Bytes(bytes) };
        },
        readProviderObservation: async () => ({
          bytes: canonicalJsonBytes(PROVIDER_OBSERVATION),
          assertUnchanged: async () => undefined,
        }),
        createStore: async () => {
          storeCreated = true;
          throw new Error("store must not be reached");
        },
        fetchImpl: async () => {
          throw new Error("untrusted OIDC URL must fail before fetch");
        },
        now: () => NOW,
      },
    ),
    /OIDC request URL is not trusted/u,
  );
  assert.equal(storeCreated, false);
});

test("protected collector rejects incomplete, duplicate, and aliased inputs", () => {
  assert.throws(
    () => parseProtectedRemoteDbObservationArguments([]),
    /incomplete/u,
  );
  assert.throws(
    () =>
      parseProtectedRemoteDbObservationArguments([
        "--namespace",
        "remote-db-authority-test",
        "--authority-output",
        "same.json",
        "--output",
        "same.json",
        "--provider-observation",
        "same.json",
        "--run-id",
        "12345",
        "--source-sha",
        "a".repeat(40),
      ]),
    /must be distinct/u,
  );
});

const pathBasename = (filePath) =>
  String(filePath).replaceAll("\\", "/").split("/").at(-1);
