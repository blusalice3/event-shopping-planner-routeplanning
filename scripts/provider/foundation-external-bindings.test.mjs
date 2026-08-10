import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { writeExactCreateOnlyFile } from "../lib/exact-file-write.mjs";
import {
  assertFoundationP0aControlStoreReceipt,
  assertFoundationP0aDatabaseReceipt,
  collectAndStoreFoundationExternalBindings,
  observeFoundationP0aDatabase,
  readStoredFoundationExternalBindingsAuthority,
} from "./foundation-external-bindings.mjs";
import {
  assertConfiguredFoundationP0aAuthorities,
  assertFoundationP0aAuthoritiesPolicy,
} from "./foundation-p0a-authorities-policy.mjs";
import {
  parseFoundationExternalBindingsArguments,
  runFoundationExternalBindingsCli,
} from "./collect-foundation-external-bindings.mjs";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../../config/${name}`, import.meta.url), "utf8"),
  );

const [baseP0a, baseProvider, baseDatabase, baseStore, baseApproval] =
  await Promise.all([
    load("foundation-p0a-authorities.json"),
    load("provider-policy.json"),
    load("db-compatibility-contract.json"),
    load("release-state-store.json"),
    load("approval-policy.json"),
  ]);

const NOW = Date.parse("2026-08-09T04:05:06.000Z");
const namespace = "foundation-p0a-test";
const sourceSha = "1".repeat(40);
const appCa = "-----BEGIN CERTIFICATE-----\napp-ca\n-----END CERTIFICATE-----";
const storeCa =
  "-----BEGIN CERTIFICATE-----\nstore-ca\n-----END CERTIFICATE-----";
const oidcReceipt = {
  uri: `release-state://${namespace}/evidence/${"a".repeat(64)}`,
  sha256: "a".repeat(64),
};

test("shared exact create-only writer rejects same-inode final-byte replacement", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-exact-output-"),
  );
  try {
    const outputPath = path.join(temporaryRoot, "authority.json");
    const expected = Buffer.from('{"authority":"expected"}', "utf8");
    const replacement = Buffer.from('{"authority":"replaced"}', "utf8");
    assert.equal(replacement.length, expected.length);
    await assert.rejects(
      writeExactCreateOnlyFile(
        {
          outputPath,
          bytes: expected,
          label: "Race fixture",
          maximumBytes: 1024,
        },
        {
          afterFinalMetadata: async ({ outputPath: committedPath }) => {
            const handle = await open(committedPath, "r+");
            try {
              await handle.write(replacement, 0, replacement.length, 0);
              await handle.sync();
            } finally {
              await handle.close();
            }
          },
        },
      ),
      /bytes differ after commit/,
    );
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    const written = await writeExactCreateOnlyFile({
      outputPath,
      bytes: expected,
      label: "Race fixture",
      maximumBytes: 1024,
    });
    assert.deepEqual(await readFile(written.path), expected);
    await assert.rejects(
      writeExactCreateOnlyFile({
        outputPath,
        bytes: expected,
        label: "Race fixture",
        maximumBytes: 1024,
      }),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

const wafRule = (id, route) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: route }] }],
  rateLimit: null,
});

const configuredPolicies = () => {
  const p0aPolicy = structuredClone(baseP0a);
  p0aPolicy.bindingStatus = "configured";
  p0aPolicy.applicationDatabase = {
    provisioningStatus: "provisioned",
    credentialOwner: "github-team:db-observers",
    backupOwner: "github-team:db-backup",
    restoreOwner: "github-team:db-restore",
  };
  p0aPolicy.controlStore = {
    namespaceStatus: "uninitialized",
    credentialOwner: "github-team:release-state",
  };
  p0aPolicy.bootstrapRecovery.deploymentBindingSha256 = "b".repeat(64);
  p0aPolicy.blockerCodes = [];

  const providerPolicy = structuredClone(baseProvider);
  Object.assign(providerPolicy, {
    bindingStatus: "configured",
    expectedTeamId: "team_p0a",
    expectedProjectId: "project_p0a",
    ownedProductionDomains: ["production.example.test"],
    requiredEnvironmentNames: ["REQUIRED_ENV"],
    cspReportEnvironmentNames: [],
    forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
    wafRules: {
      metricsRoute: wafRule(
        "metrics-rule",
        "/api/persistence-release-a-metrics",
      ),
      cspReportRoute: wafRule("csp-rule", "/api/csp-report"),
      googleSheetsCsvRoute: wafRule("sheets-rule", "/api/google-sheets-csv"),
    },
    logPolicy: {
      ...providerPolicy.logPolicy,
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

  const databaseContract = structuredClone(baseDatabase);
  databaseContract.remote.observationAuthority = {
    ...databaseContract.remote.observationAuthority,
    bindingStatus: "configured",
    allowedHosts: ["application-db.example.test"],
    allowedDatabases: ["foundation_app"],
    allowedObserverRoles: ["foundation_observer"],
    productionCaSha256: sha256Bytes(Buffer.from(appCa)),
  };

  const storePolicy = structuredClone(baseStore);
  Object.assign(storePolicy, {
    bindingStatus: "configured",
    allowedHosts: ["control-db.example.test"],
    allowedDatabases: ["release_state"],
    allowedExecutorRoles: ["release_executor"],
    backupOwner: "github-team:control-backup",
    restoreOwner: "github-team:control-restore",
    productionCaSha256: sha256Bytes(Buffer.from(storeCa)),
    blockerCodes: [],
  });

  const approvalPolicy = structuredClone(baseApproval);
  approvalPolicy.bindingStatus = "configured";
  approvalPolicy.roles.releaseOwner.reviewerTeam = "github-team-release";
  approvalPolicy.roles.dataSafetyReviewer.reviewerTeam =
    "github-team-data-safety";
  approvalPolicy.roles.operationsReviewer.reviewerTeam =
    "github-team-operations";
  approvalPolicy.blockerCodes = [];
  return {
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  };
};

const environment = {
  GITHUB_SHA: sourceSha,
  VERCEL_TOKEN: "provider-token-must-not-be-stored",
  DB_COMPATIBILITY_OBSERVER_DATABASE_URL:
    "postgresql://foundation_observer:secret@application-db.example.test/foundation_app?sslmode=verify-full",
  DB_COMPATIBILITY_OBSERVER_CA_PEM: appCa,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://release_executor:secret@control-db.example.test/release_state?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: storeCa,
};

const uninitialized = Object.freeze({
  head: { sequence: 0, eventHash: null },
  snapshot: null,
  records: [],
});

const memoryStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async readHead() {
      return { sequence: 0, eventHash: null };
    },
    async readEvents() {
      return [];
    },
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = new Date(NOW).toISOString();
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

const databaseReceipt = (policies) => ({
  engine: "postgresql",
  postgresMajor: 17,
  host: "application-db.example.test",
  database: "foundation_app",
  observerRole: "foundation_observer",
  tlsMode: "verify-full",
  productionCaSha256:
    policies.databaseContract.remote.observationAuthority.productionCaSha256,
  transactionReadOnly: true,
  provisioningStatus: "provisioned",
  credentialOwner: "github-team:db-observers",
  backupOwner: "github-team:db-backup",
  restoreOwner: "github-team:db-restore",
  observedAt: new Date(NOW).toISOString(),
});

const providerAuthorityDependencies = (store, policies) => ({
  collectProviderObservation: async () => ({
    schemaVersion: 1,
    evidenceKind: "fixture-provider-observation/v1",
  }),
  putProviderObservation: async ({ bytes, providerPolicy }) => {
    const observation = await store.putEvidence({
      bytes,
      mediaType: "fixture/provider-observation",
    });
    const policy = await store.putEvidence({
      bytes: canonicalJsonBytes(providerPolicy),
      mediaType: "fixture/provider-policy",
    });
    return {
      reference: { uri: observation.uri, sha256: observation.sha256 },
      policyReference: { uri: policy.uri, sha256: policy.sha256 },
    };
  },
  readProviderObservation: async () => ({
    providerPolicy: policies.providerPolicy,
    observation: { evidenceKind: "fixture-provider-observation/v1" },
  }),
});

const collectFixture = async (overrides = {}) => {
  const policies = configuredPolicies();
  const store = memoryStore();
  const provider = providerAuthorityDependencies(store, policies);
  const observation = await collectAndStoreFoundationExternalBindings(
    {
      ...policies,
      environment,
      namespace,
      oidcAuthority: {
        approvalPolicy: policies.approvalPolicy,
        runId: "7001",
        runAttempt: "2",
      },
      oidcReceipt,
      store,
      ...(overrides.options ?? {}),
    },
    {
      readOidcAuthority: async () => ({ receipt: { trusted: true } }),
      observeDatabase: async () => databaseReceipt(policies),
      readControlState: async () => uninitialized,
      clock: () => NOW,
      ...provider,
      ...(overrides.dependencies ?? {}),
    },
  );
  return { observation, policies, store, provider };
};

test("closes configured P0A contracts while current repository policy remains fail-closed", () => {
  assert.equal(
    assertFoundationP0aAuthoritiesPolicy(baseP0a).bindingStatus,
    "unconfigured",
  );
  assert.throws(
    () =>
      assertConfiguredFoundationP0aAuthorities({
        p0aPolicy: baseP0a,
        providerPolicy: baseProvider,
        databaseContract: baseDatabase,
        storePolicy: baseStore,
        approvalPolicy: baseApproval,
      }),
    /not configured/,
  );
  assert.doesNotThrow(() =>
    assertConfiguredFoundationP0aAuthorities(configuredPolicies()),
  );
});

test("collects provider, P0A database, uninitialized store, approval, and OIDC into immutable refs", async () => {
  const fixture = await collectFixture();
  assert.equal(fixture.observation.result.provider.projectId, "project_p0a");
  assert.equal(
    fixture.observation.result.applicationDatabase.contractUri,
    fixture.policies.databaseContract.contractUri,
  );
  const stored = fixture.store.objects.get(
    fixture.observation.rawAuthority.sha256,
  );
  const raw = JSON.parse(stored.bytes.toString("utf8"));
  assert.equal(raw.references.applicationDatabase.sha256.length, 64);
  assert.equal(raw.references.controlStore.sha256.length, 64);
  assert.equal(stored.bytes.includes(Buffer.from("secret", "utf8")), false);
  const readback = await readStoredFoundationExternalBindingsAuthority(
    {
      store: fixture.store,
      namespace,
      reference: fixture.observation.rawAuthority,
      ...fixture.policies,
      now: () => NOW,
    },
    {
      readOidcAuthority: async () => ({ receipt: { trusted: true } }),
      readControlState: async () => uninitialized,
      readProviderObservation: fixture.provider.readProviderObservation,
    },
  );
  assert.deepEqual(readback.result, fixture.observation.result);
});

test("rejects caller authority, initialized namespace, non-read-only DB, stale and tampered raw", async () => {
  const policies = configuredPolicies();
  await assert.rejects(
    collectAndStoreFoundationExternalBindings({
      ...policies,
      environment,
      namespace,
      oidcAuthority: {
        approvalPolicy: policies.approvalPolicy,
        runId: "7001",
        runAttempt: "2",
      },
      oidcReceipt,
      store: memoryStore(),
      sourceSha,
    }),
    /unknown or missing fields/,
  );
  await assert.rejects(
    collectAndStoreFoundationExternalBindings(
      {
        ...policies,
        environment,
        namespace,
        oidcAuthority: {
          approvalPolicy: policies.approvalPolicy,
          runId: "7001",
          runAttempt: "2",
          callerStatus: "succeeded",
        },
        oidcReceipt,
        store: memoryStore(),
      },
      {
        readOidcAuthority: async () => ({}),
      },
    ),
    /OIDC authority has unknown or missing fields/,
  );
  await assert.rejects(
    collectFixture({
      dependencies: {
        readControlState: async () => ({
          head: { sequence: 1, eventHash: "f".repeat(64) },
          snapshot: {},
          records: [{}],
        }),
      },
    }),
    /initialized/,
  );
  await assert.rejects(
    collectFixture({
      dependencies: {
        observeDatabase: async () => ({
          ...databaseReceipt(policies),
          transactionReadOnly: false,
        }),
      },
    }),
    /database receipt differs/,
  );
  const fixture = await collectFixture();
  await assert.rejects(
    readStoredFoundationExternalBindingsAuthority(
      {
        store: fixture.store,
        namespace,
        reference: fixture.observation.rawAuthority,
        ...fixture.policies,
        now: () => NOW + 6 * 60 * 1_000,
      },
      {
        readOidcAuthority: async () => ({}),
        readControlState: async () => uninitialized,
        readProviderObservation: fixture.provider.readProviderObservation,
      },
    ),
    /stale/,
  );
  const object = fixture.store.objects.get(
    fixture.observation.rawAuthority.sha256,
  );
  object.bytes = Buffer.concat([object.bytes, Buffer.from(" ")]);
  await assert.rejects(
    readStoredFoundationExternalBindingsAuthority({
      store: fixture.store,
      namespace,
      reference: fixture.observation.rawAuthority,
      ...fixture.policies,
      now: () => NOW,
    }),
    /tampered/,
  );
});

test("default P0A DB observer uses verify-full read-only identity query", async () => {
  const policies = configuredPolicies();
  const authority = policies.databaseContract.remote.observationAuthority;
  const queries = [];
  const client = {
    async connect() {},
    async query(query) {
      queries.push(query);
      if (typeof query === "object") {
        return {
          rowCount: 1,
          rows: [
            {
              database: "foundation_app",
              observer_role: "foundation_observer",
              server_version_num: 170_002,
              transaction_read_only: true,
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    async end() {},
  };
  const receipt = await observeFoundationP0aDatabase(
    {
      connection: {
        runtimeConnectionString: "postgresql://redacted.invalid/db",
        ca: appCa,
        host: "application-db.example.test",
        database: "foundation_app",
        observerRole: "foundation_observer",
      },
      authority,
      owners: policies.p0aPolicy.applicationDatabase,
      clock: () => NOW,
    },
    { createClient: async () => client },
  );
  assert.equal(receipt.transactionReadOnly, true);
  assert.equal(
    queries[0],
    "begin transaction isolation level repeatable read read only",
  );
  assert.match(queries[1].text, /transaction_read_only/u);
});

test("external CLI forbids source/hash/status/url/bool and fails unconfigured before authority I/O", async () => {
  assert.deepEqual(
    parseFoundationExternalBindingsArguments([
      "--namespace",
      namespace,
      "--output",
      "external.json",
    ]),
    { namespace, outputPath: "external.json" },
  );
  for (const flag of [
    "--source-sha",
    "--hash",
    "--status",
    "--url",
    "--succeeded",
  ]) {
    assert.throws(
      () =>
        parseFoundationExternalBindingsArguments([
          "--namespace",
          namespace,
          flag,
          "caller-value",
        ]),
      /arguments are invalid/,
    );
  }
  let protectedCalls = 0;
  let storeCalls = 0;
  await assert.rejects(
    runFoundationExternalBindingsCli(
      {
        argv: ["--namespace", namespace, "--output", "external.json"],
        environment: {},
      },
      {
        loadPolicy: async (filePath) => {
          if (filePath.endsWith("foundation-p0a-authorities.json")) {
            return baseP0a;
          }
          if (filePath.endsWith("provider-policy.json")) return baseProvider;
          if (filePath.endsWith("db-compatibility-contract.json")) {
            return baseDatabase;
          }
          if (filePath.endsWith("release-state-store.json")) return baseStore;
          return baseApproval;
        },
        assertProtected: async () => {
          protectedCalls += 1;
        },
        createStore: async () => {
          storeCalls += 1;
        },
      },
    ),
    /not configured/,
  );
  assert.equal(protectedCalls, 0);
  assert.equal(storeCalls, 0);
});

test("receipt validators reject caller status fields", () => {
  const policies = configuredPolicies();
  assert.throws(
    () =>
      assertFoundationP0aDatabaseReceipt(
        { ...databaseReceipt(policies), callerStatus: "passed" },
        {
          authority: policies.databaseContract.remote.observationAuthority,
          owners: policies.p0aPolicy.applicationDatabase,
        },
      ),
    /unknown or missing fields/,
  );
  const control = {
    namespace,
    namespaceStatus: "uninitialized",
    head: { sequence: 0, eventHash: null },
    engine: "postgresql",
    postgresMajor: 17,
    host: "control-db.example.test",
    database: "release_state",
    executorRole: "release_executor",
    tlsMode: "verify-full",
    productionCaSha256: sha256Bytes(Buffer.from(storeCa)),
    credentialOwner: "github-team:release-state",
    backupOwner: "github-team:control-backup",
    restoreOwner: "github-team:control-restore",
    observedAt: new Date(NOW).toISOString(),
  };
  assert.doesNotThrow(() =>
    assertFoundationP0aControlStoreReceipt(control, {
      namespace,
      storePolicy: policies.storePolicy,
      p0aPolicy: policies.p0aPolicy,
      connection: {
        host: control.host,
        database: control.database,
        role: control.executorRole,
      },
    }),
  );
});
