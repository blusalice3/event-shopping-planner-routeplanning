import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  readStoredRemoteDbProviderObservationAuthority,
  putRemoteDbProviderObservationAuthority,
} from "../db/remote-db-observation-authority.mjs";
import {
  assertExactKeys,
  isRecord,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import { validateConnectionBinding } from "../release-state/postgresStore.mjs";
import { readStoredProductionRequestGraphOidcAuthority } from "../browser/production-request-graph.mjs";
import { collectVercelProviderObservation } from "./collect-vercel-observation.mjs";
import {
  assertConfiguredFoundationP0aAuthorities,
  assertFoundationP0aCa,
} from "./foundation-p0a-authorities-policy.mjs";

export const FOUNDATION_EXTERNAL_BINDINGS_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-external-bindings-raw+json;version=1";
export const FOUNDATION_EXTERNAL_BINDINGS_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-external-bindings+json;version=1";
export const FOUNDATION_P0A_DATABASE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-p0a-database-receipt+json;version=1";
export const FOUNDATION_P0A_CONTROL_STORE_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-p0a-control-store-receipt+json;version=1";
export const FOUNDATION_P0A_DATABASE_CONTRACT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-p0a-database-contract+json;version=1";
export const FOUNDATION_P0A_STORE_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-p0a-store-policy+json;version=1";
export const FOUNDATION_P0A_APPROVAL_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-p0a-approval-policy+json;version=1";
export const FOUNDATION_P0A_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.foundation-p0a-policy+json;version=1";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const MAXIMUM_OBJECT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_AGE_MILLISECONDS = 5 * 60 * 1_000;
const FUTURE_SKEW_MILLISECONDS = 30 * 1_000;
const OPTION_KEYS = [
  "approvalPolicy",
  "databaseContract",
  "environment",
  "namespace",
  "oidcAuthority",
  "oidcReceipt",
  "p0aPolicy",
  "providerPolicy",
  "store",
  "storePolicy",
];

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], `${label} reference`);
  if (
    !SHA256.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} immutable reference is invalid`);
  }
  return reference;
};

const timestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
};

const clockMilliseconds = (clock) => {
  const value = Number(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value)) {
    throw new Error("Foundation external binding clock is invalid");
  }
  return value;
};

const assertStore = (store, namespace) => {
  if (
    store?.namespace !== namespace ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function"
  ) {
    throw new Error("Foundation external binding store is invalid");
  }
};

const parseCanonical = (bytes, label) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAXIMUM_OBJECT_BYTES
  ) {
    throw new Error(`${label} is empty or oversized`);
  }
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
};

const putCanonical = async ({ store, namespace, value, mediaType, label }) => {
  const bytes = canonicalJsonBytes(value);
  const reference = referenceFor(namespace, bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  const readback = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string" ||
    !Buffer.isBuffer(readback?.bytes) ||
    !readback.bytes.equals(bytes) ||
    readback.mediaType !== mediaType ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable put/readback differs`);
  }
  return Object.freeze({ reference: Object.freeze(reference), receipt });
};

const readCanonical = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
}) => {
  assertReference(reference, namespace, label);
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== mediaType ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error(`${label} is absent, tampered, or mistyped`);
  }
  timestamp(stored.committedAt, `${label} immutable commit`);
  return {
    bytes: Buffer.from(stored.bytes),
    value: parseCanonical(stored.bytes, label),
    committedAt: stored.committedAt,
  };
};

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Foundation external binding environment is absent: ${name}`,
    );
  }
  return value;
};

const databaseConnection = ({ environment, authority }) => {
  const connectionString = requireEnvironment(
    environment,
    authority.databaseUrlEnvironmentName,
  );
  const ca = assertFoundationP0aCa(
    requireEnvironment(environment, authority.databaseCaEnvironmentName),
    authority.productionCaSha256,
    "Foundation application database",
  );
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Foundation application database URL is invalid");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const observerRole = decodeURIComponent(parsed.username);
  const queryNames = [...new Set(parsed.searchParams.keys())];
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.password.length === 0 ||
    database.length === 0 ||
    database.includes("/") ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "5432") ||
    queryNames.length !== 1 ||
    queryNames[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "verify-full" ||
    !authority.allowedHosts.includes(parsed.hostname) ||
    !authority.allowedDatabases.includes(database) ||
    !authority.allowedObserverRoles.includes(observerRole)
  ) {
    throw new Error("Foundation application database binding differs");
  }
  const runtime = new URL(parsed);
  runtime.searchParams.delete("sslmode");
  return Object.freeze({
    connectionString,
    runtimeConnectionString: runtime.href,
    ca,
    host: parsed.hostname,
    database,
    observerRole,
  });
};

const defaultCreateDatabaseClient = async ({ connection, authority }) => {
  const { Client } = await import("pg");
  return new Client({
    connectionString: connection.runtimeConnectionString,
    connectionTimeoutMillis: authority.connectTimeoutMilliseconds,
    statement_timeout: authority.statementTimeoutMilliseconds,
    ssl: { ca: connection.ca, rejectUnauthorized: true },
    application_name: "foundation-p0a-database-observer",
  });
};

export const assertFoundationP0aDatabaseReceipt = (
  receipt,
  { authority, owners },
) => {
  assertExactKeys(
    receipt,
    [
      "backupOwner",
      "credentialOwner",
      "database",
      "engine",
      "host",
      "observedAt",
      "observerRole",
      "postgresMajor",
      "productionCaSha256",
      "provisioningStatus",
      "restoreOwner",
      "tlsMode",
      "transactionReadOnly",
    ],
    "Foundation P0A database receipt",
  );
  timestamp(receipt.observedAt, "Foundation P0A database observation");
  if (
    receipt.engine !== "postgresql" ||
    receipt.postgresMajor !== authority.postgresMajor ||
    !authority.allowedHosts.includes(receipt.host) ||
    !authority.allowedDatabases.includes(receipt.database) ||
    !authority.allowedObserverRoles.includes(receipt.observerRole) ||
    receipt.tlsMode !== "verify-full" ||
    receipt.productionCaSha256 !== authority.productionCaSha256 ||
    receipt.transactionReadOnly !== true ||
    receipt.provisioningStatus !== owners.provisioningStatus ||
    receipt.credentialOwner !== owners.credentialOwner ||
    receipt.backupOwner !== owners.backupOwner ||
    receipt.restoreOwner !== owners.restoreOwner
  ) {
    throw new Error("Foundation P0A database receipt differs from policy");
  }
  return receipt;
};

export const observeFoundationP0aDatabase = async (
  { connection, authority, owners, clock = Date.now },
  { createClient = defaultCreateDatabaseClient } = {},
) => {
  const client = await createClient({ connection, authority });
  if (
    typeof client?.connect !== "function" ||
    typeof client.query !== "function" ||
    typeof client.end !== "function"
  ) {
    throw new Error("Foundation P0A database client is invalid");
  }
  try {
    await client.connect();
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    const result = await client.query({
      name: "foundation-p0a-provisioning-binding-v1",
      text: `
        select current_database()::text as database,
               current_user::text as observer_role,
               current_setting('server_version_num')::integer as server_version_num,
               current_setting('transaction_read_only')::boolean as transaction_read_only
      `,
      values: [],
    });
    await client.query("rollback");
    if (
      result?.rowCount !== 1 ||
      !isRecord(result.rows?.[0]) ||
      Object.keys(result.rows[0]).sort().join("\n") !==
        [
          "database",
          "observer_role",
          "server_version_num",
          "transaction_read_only",
        ]
          .sort()
          .join("\n") ||
      result.rows[0].database !== connection.database ||
      result.rows[0].observer_role !== connection.observerRole ||
      Math.trunc(Number(result.rows[0].server_version_num) / 10_000) !==
        authority.postgresMajor ||
      result.rows[0].transaction_read_only !== true
    ) {
      throw new Error("Foundation P0A database identity query differs");
    }
    return assertFoundationP0aDatabaseReceipt(
      {
        engine: "postgresql",
        postgresMajor: authority.postgresMajor,
        host: connection.host,
        database: connection.database,
        observerRole: connection.observerRole,
        tlsMode: "verify-full",
        productionCaSha256: authority.productionCaSha256,
        transactionReadOnly: true,
        provisioningStatus: owners.provisioningStatus,
        credentialOwner: owners.credentialOwner,
        backupOwner: owners.backupOwner,
        restoreOwner: owners.restoreOwner,
        observedAt: new Date(clockMilliseconds(clock)).toISOString(),
      },
      { authority, owners },
    );
  } finally {
    await client.end();
  }
};

const assertUninitializedState = (current) => {
  if (
    !isRecord(current) ||
    !sameCanonicalValue(current.head, { sequence: 0, eventHash: null }) ||
    current.snapshot !== null ||
    !Array.isArray(current.records) ||
    current.records.length !== 0
  ) {
    throw new Error("Foundation control store namespace is initialized");
  }
  return current;
};

export const assertFoundationP0aControlStoreReceipt = (
  receipt,
  { namespace, storePolicy, p0aPolicy, connection },
) => {
  assertExactKeys(
    receipt,
    [
      "backupOwner",
      "credentialOwner",
      "database",
      "engine",
      "executorRole",
      "head",
      "host",
      "namespace",
      "namespaceStatus",
      "observedAt",
      "postgresMajor",
      "productionCaSha256",
      "restoreOwner",
      "tlsMode",
    ],
    "Foundation P0A control store receipt",
  );
  timestamp(receipt.observedAt, "Foundation P0A control store observation");
  if (
    receipt.namespace !== namespace ||
    receipt.namespaceStatus !== "uninitialized" ||
    !sameCanonicalValue(receipt.head, { sequence: 0, eventHash: null }) ||
    receipt.engine !== "postgresql" ||
    receipt.postgresMajor !== storePolicy.postgresMajor ||
    receipt.host !== connection.host ||
    receipt.database !== connection.database ||
    receipt.executorRole !== connection.role ||
    receipt.tlsMode !== "verify-full" ||
    receipt.productionCaSha256 !== storePolicy.productionCaSha256 ||
    receipt.credentialOwner !== p0aPolicy.controlStore.credentialOwner ||
    receipt.backupOwner !== storePolicy.backupOwner ||
    receipt.restoreOwner !== storePolicy.restoreOwner
  ) {
    throw new Error("Foundation P0A control store receipt differs");
  }
  return receipt;
};

export const deriveFoundationExternalBindingsResult = ({
  providerPolicy,
  approvalPolicy,
  storePolicy,
  databaseContract,
}) => {
  const reviewerTeams = Object.fromEntries(
    Object.entries(approvalPolicy.roles).map(([role, value]) => [
      role,
      value.reviewerTeam,
    ]),
  );
  const remoteAuthority = databaseContract.remote.observationAuthority;
  return {
    provider: {
      provider: providerPolicy.provider,
      teamId: providerPolicy.expectedTeamId,
      projectId: providerPolicy.expectedProjectId,
      ownedProductionDomains: providerPolicy.ownedProductionDomains,
      productionEnvironmentName: providerPolicy.productionEnvironmentName,
      productionBranch: providerPolicy.productionBranch,
      configurationSha256: sha256Json(providerPolicy),
    },
    approval: {
      repository: approvalPolicy.repository,
      workflowRef: approvalPolicy.workflowRef,
      protectedEnvironment: approvalPolicy.protectedEnvironment,
      reviewerTeams,
      configurationSha256: sha256Json(approvalPolicy),
    },
    controlStore: {
      engine: storePolicy.engine,
      postgresMajor: storePolicy.postgresMajor,
      allowedHosts: storePolicy.allowedHosts,
      allowedDatabases: storePolicy.allowedDatabases,
      allowedExecutorRoles: storePolicy.allowedExecutorRoles,
      productionCaSha256: storePolicy.productionCaSha256,
      backupOwner: storePolicy.backupOwner,
      restoreOwner: storePolicy.restoreOwner,
      configurationSha256: sha256Json(storePolicy),
    },
    applicationDatabase: {
      contractUri: databaseContract.contractUri,
      contractFingerprint: sha256Json(databaseContract),
      allowedHosts: remoteAuthority.allowedHosts,
      allowedDatabases: remoteAuthority.allowedDatabases,
      allowedObserverRoles: remoteAuthority.allowedObserverRoles,
      productionCaSha256: remoteAuthority.productionCaSha256,
      configurationSha256: sha256Json(remoteAuthority),
    },
  };
};

const assertRaw = (raw, policies) => {
  assertExactKeys(
    raw,
    [
      "collector",
      "kind",
      "namespace",
      "observedAt",
      "references",
      "result",
      "schemaVersion",
      "sourceSha",
    ],
    "Foundation external binding raw authority",
  );
  assertExactKeys(raw.collector, ["oidcReceipt", "runAttempt", "runId"]);
  assertExactKeys(
    raw.references,
    [
      "applicationDatabase",
      "approvalPolicy",
      "databaseContract",
      "p0aPolicy",
      "providerObservation",
      "providerPolicy",
      "storePolicy",
      "controlStore",
    ],
    "Foundation external binding references",
  );
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== "foundation-external-bindings-raw/v1" ||
    !NAMESPACE.test(raw.namespace ?? "") ||
    !SOURCE_SHA.test(raw.sourceSha ?? "") ||
    !RUN_ID.test(raw.collector.runId ?? "") ||
    !RUN_ID.test(raw.collector.runAttempt ?? "")
  ) {
    throw new Error("Foundation external binding raw identity is invalid");
  }
  timestamp(raw.observedAt, "Foundation external binding observation");
  assertReference(raw.collector.oidcReceipt, raw.namespace, "External OIDC");
  for (const [name, reference] of Object.entries(raw.references)) {
    assertReference(reference, raw.namespace, `External ${name}`);
  }
  const expected = deriveFoundationExternalBindingsResult(policies);
  if (!sameCanonicalValue(raw.result, expected)) {
    throw new Error("Foundation external binding result differs");
  }
  return raw;
};

export const assertFoundationExternalBindingsObservation = (observation) => {
  assertExactKeys(
    observation,
    [
      "collectorIdentity",
      "kind",
      "namespace",
      "observedAt",
      "oidcReceipt",
      "rawAuthority",
      "result",
      "schemaVersion",
      "sourceSha",
    ],
    "Foundation external binding observation",
  );
  if (
    observation.schemaVersion !== 1 ||
    observation.kind !== "foundation-external-bindings-observation/v1" ||
    !NAMESPACE.test(observation.namespace ?? "") ||
    !SOURCE_SHA.test(observation.sourceSha ?? "") ||
    observation.collectorIdentity?.sourceSha !== observation.sourceSha ||
    observation.collectorIdentity?.workflowPath !==
      ".github/workflows/release.yml" ||
    !RUN_ID.test(observation.collectorIdentity?.runId ?? "") ||
    !RUN_ID.test(observation.collectorIdentity?.runAttempt ?? "")
  ) {
    throw new Error("Foundation external binding observation is invalid");
  }
  timestamp(observation.observedAt, "Foundation external observation");
  assertReference(
    observation.oidcReceipt,
    observation.namespace,
    "Foundation external observation OIDC",
  );
  assertReference(
    observation.rawAuthority,
    observation.namespace,
    "Foundation external raw authority",
  );
  return observation;
};

export const readStoredFoundationExternalBindingsAuthority = async (
  {
    store,
    namespace,
    reference,
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
    now = Date.now,
  },
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    readControlState = readCurrentReleaseState,
    readProviderObservation = readStoredRemoteDbProviderObservationAuthority,
  } = {},
) => {
  const configured = assertConfiguredFoundationP0aAuthorities({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  });
  assertStore(store, namespace);
  const rawStored = await readCanonical({
    store,
    namespace,
    reference,
    mediaType: FOUNDATION_EXTERNAL_BINDINGS_RAW_MEDIA_TYPE,
    label: "Foundation external binding raw authority",
  });
  const policies = {
    providerPolicy,
    approvalPolicy,
    storePolicy,
    databaseContract,
  };
  const raw = assertRaw(rawStored.value, policies);
  const nowMilliseconds = clockMilliseconds(now);
  const observedAt = timestamp(
    raw.observedAt,
    "Foundation external binding observation",
  );
  if (
    observedAt < nowMilliseconds - MAXIMUM_AGE_MILLISECONDS ||
    observedAt > nowMilliseconds + FUTURE_SKEW_MILLISECONDS
  ) {
    throw new Error("Foundation external binding authority is stale or future");
  }
  const support = await Promise.all([
    readCanonical({
      store,
      namespace,
      reference: raw.references.databaseContract,
      mediaType: FOUNDATION_P0A_DATABASE_CONTRACT_MEDIA_TYPE,
      label: "Foundation P0A database contract",
    }),
    readCanonical({
      store,
      namespace,
      reference: raw.references.storePolicy,
      mediaType: FOUNDATION_P0A_STORE_POLICY_MEDIA_TYPE,
      label: "Foundation P0A store policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: raw.references.approvalPolicy,
      mediaType: FOUNDATION_P0A_APPROVAL_POLICY_MEDIA_TYPE,
      label: "Foundation P0A approval policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: raw.references.p0aPolicy,
      mediaType: FOUNDATION_P0A_POLICY_MEDIA_TYPE,
      label: "Foundation P0A authority policy",
    }),
    readCanonical({
      store,
      namespace,
      reference: raw.references.applicationDatabase,
      mediaType: FOUNDATION_P0A_DATABASE_RECEIPT_MEDIA_TYPE,
      label: "Foundation P0A database receipt",
    }),
    readCanonical({
      store,
      namespace,
      reference: raw.references.controlStore,
      mediaType: FOUNDATION_P0A_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
      label: "Foundation P0A control store receipt",
    }),
    readProviderObservation({
      store,
      namespace,
      reference: raw.references.providerObservation,
      policyReference: raw.references.providerPolicy,
      now,
    }),
    readOidcAuthority({
      store,
      namespace,
      reference: raw.collector.oidcReceipt,
      approvalPolicy,
      sourceSha: raw.sourceSha,
      runId: raw.collector.runId,
      runAttempt: raw.collector.runAttempt,
    }),
    readControlState({ store, requireInitialized: false }),
  ]);
  if (
    !sameCanonicalValue(support[0].value, databaseContract) ||
    !sameCanonicalValue(support[1].value, storePolicy) ||
    !sameCanonicalValue(support[2].value, approvalPolicy) ||
    !sameCanonicalValue(support[3].value, p0aPolicy) ||
    !sameCanonicalValue(support[6].providerPolicy, providerPolicy)
  ) {
    throw new Error("Foundation external binding policy readback differs");
  }
  assertFoundationP0aDatabaseReceipt(support[4].value, {
    authority: configured.databaseAuthority,
    owners: configured.applicationDatabaseOwners,
  });
  const controlConnection = {
    host: support[5].value.host,
    database: support[5].value.database,
    role: support[5].value.executorRole,
  };
  assertFoundationP0aControlStoreReceipt(support[5].value, {
    namespace,
    storePolicy,
    p0aPolicy,
    connection: controlConnection,
  });
  assertUninitializedState(support[8]);
  return Object.freeze({
    raw: Object.freeze(structuredClone(raw)),
    result: Object.freeze(structuredClone(raw.result)),
    reference: Object.freeze({ ...reference }),
    bytes: Buffer.from(rawStored.bytes),
  });
};

export const collectAndStoreFoundationExternalBindings = async (
  options,
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    collectProviderObservation = collectVercelProviderObservation,
    putProviderObservation = putRemoteDbProviderObservationAuthority,
    readProviderObservation = readStoredRemoteDbProviderObservationAuthority,
    observeDatabase = observeFoundationP0aDatabase,
    readControlState = readCurrentReleaseState,
    clock = Date.now,
  } = {},
) => {
  assertExactKeys(
    options,
    OPTION_KEYS,
    "Foundation external binding collector options",
  );
  const {
    approvalPolicy,
    databaseContract,
    environment,
    namespace,
    oidcAuthority,
    oidcReceipt,
    p0aPolicy,
    providerPolicy,
    store,
    storePolicy,
  } = options;
  const configured = assertConfiguredFoundationP0aAuthorities({
    p0aPolicy,
    providerPolicy,
    databaseContract,
    storePolicy,
    approvalPolicy,
  });
  assertExactKeys(
    oidcAuthority,
    ["approvalPolicy", "runAttempt", "runId"],
    "Foundation external binding OIDC authority",
  );
  if (
    !NAMESPACE.test(namespace ?? "") ||
    !SOURCE_SHA.test(environment?.GITHUB_SHA ?? "") ||
    !RUN_ID.test(oidcAuthority?.runId ?? "") ||
    !RUN_ID.test(oidcAuthority?.runAttempt ?? "") ||
    !sameCanonicalValue(oidcAuthority?.approvalPolicy, approvalPolicy)
  ) {
    throw new Error(
      "Foundation external binding collector identity is invalid",
    );
  }
  assertStore(store, namespace);
  assertReference(oidcReceipt, namespace, "Foundation external binding OIDC");
  const sourceSha = environment.GITHUB_SHA;
  await readOidcAuthority({
    store,
    namespace,
    reference: oidcReceipt,
    approvalPolicy,
    sourceSha,
    runId: oidcAuthority.runId,
    runAttempt: oidcAuthority.runAttempt,
  });
  const token = requireEnvironment(
    environment,
    p0aPolicy.providerCredentialEnvironmentName,
  );
  const applicationConnection = databaseConnection({
    environment,
    authority: configured.databaseAuthority,
  });
  const controlConnection = validateConnectionBinding(
    requireEnvironment(environment, storePolicy.databaseUrlEnvironmentName),
    storePolicy,
  );
  assertFoundationP0aCa(
    requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
    storePolicy.productionCaSha256,
    "Foundation control store",
  );
  const nowMilliseconds = clockMilliseconds(clock);
  const [providerObservation, databaseReceipt, current] = await Promise.all([
    collectProviderObservation({
      policy: providerPolicy,
      token,
      now: () => nowMilliseconds,
    }),
    observeDatabase({
      connection: applicationConnection,
      authority: configured.databaseAuthority,
      owners: configured.applicationDatabaseOwners,
      clock: () => nowMilliseconds,
    }),
    readControlState({ store, requireInitialized: false }),
  ]);
  assertUninitializedState(current);
  assertFoundationP0aDatabaseReceipt(databaseReceipt, {
    authority: configured.databaseAuthority,
    owners: configured.applicationDatabaseOwners,
  });
  const controlReceipt = assertFoundationP0aControlStoreReceipt(
    {
      namespace,
      namespaceStatus: "uninitialized",
      head: { sequence: 0, eventHash: null },
      engine: storePolicy.engine,
      postgresMajor: storePolicy.postgresMajor,
      host: controlConnection.host,
      database: controlConnection.database,
      executorRole: controlConnection.role,
      tlsMode: "verify-full",
      productionCaSha256: storePolicy.productionCaSha256,
      credentialOwner: p0aPolicy.controlStore.credentialOwner,
      backupOwner: storePolicy.backupOwner,
      restoreOwner: storePolicy.restoreOwner,
      observedAt: new Date(nowMilliseconds).toISOString(),
    },
    { namespace, storePolicy, p0aPolicy, connection: controlConnection },
  );
  const [providerStored, ...stored] = await Promise.all([
    putProviderObservation({
      store,
      namespace,
      bytes: canonicalJsonBytes(providerObservation),
      providerPolicy,
      now: () => nowMilliseconds,
    }),
    putCanonical({
      store,
      namespace,
      value: databaseContract,
      mediaType: FOUNDATION_P0A_DATABASE_CONTRACT_MEDIA_TYPE,
      label: "Foundation P0A database contract",
    }),
    putCanonical({
      store,
      namespace,
      value: storePolicy,
      mediaType: FOUNDATION_P0A_STORE_POLICY_MEDIA_TYPE,
      label: "Foundation P0A store policy",
    }),
    putCanonical({
      store,
      namespace,
      value: approvalPolicy,
      mediaType: FOUNDATION_P0A_APPROVAL_POLICY_MEDIA_TYPE,
      label: "Foundation P0A approval policy",
    }),
    putCanonical({
      store,
      namespace,
      value: p0aPolicy,
      mediaType: FOUNDATION_P0A_POLICY_MEDIA_TYPE,
      label: "Foundation P0A authority policy",
    }),
    putCanonical({
      store,
      namespace,
      value: databaseReceipt,
      mediaType: FOUNDATION_P0A_DATABASE_RECEIPT_MEDIA_TYPE,
      label: "Foundation P0A database receipt",
    }),
    putCanonical({
      store,
      namespace,
      value: controlReceipt,
      mediaType: FOUNDATION_P0A_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
      label: "Foundation P0A control store receipt",
    }),
  ]);
  const [databaseContractStored, storePolicyStored, approvalPolicyStored] =
    stored;
  const [p0aPolicyStored, databaseStored, controlStored] = stored.slice(3);
  const policies = {
    providerPolicy,
    approvalPolicy,
    storePolicy,
    databaseContract,
  };
  const raw = {
    schemaVersion: 1,
    kind: "foundation-external-bindings-raw/v1",
    namespace,
    sourceSha,
    observedAt: new Date(nowMilliseconds).toISOString(),
    collector: {
      runId: oidcAuthority.runId,
      runAttempt: oidcAuthority.runAttempt,
      oidcReceipt: { ...oidcReceipt },
    },
    references: {
      providerObservation: { ...providerStored.reference },
      providerPolicy: { ...providerStored.policyReference },
      databaseContract: { ...databaseContractStored.reference },
      applicationDatabase: { ...databaseStored.reference },
      storePolicy: { ...storePolicyStored.reference },
      controlStore: { ...controlStored.reference },
      approvalPolicy: { ...approvalPolicyStored.reference },
      p0aPolicy: { ...p0aPolicyStored.reference },
    },
    result: deriveFoundationExternalBindingsResult(policies),
  };
  assertRaw(raw, policies);
  const rawBytes = canonicalJsonBytes(raw);
  for (const secret of [
    token,
    applicationConnection.connectionString,
    applicationConnection.ca,
    requireEnvironment(environment, storePolicy.databaseUrlEnvironmentName),
    requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  ]) {
    if (rawBytes.includes(Buffer.from(secret, "utf8"))) {
      throw new Error("Foundation external binding authority exposes a secret");
    }
  }
  const rawStored = await putCanonical({
    store,
    namespace,
    value: raw,
    mediaType: FOUNDATION_EXTERNAL_BINDINGS_RAW_MEDIA_TYPE,
    label: "Foundation external binding raw authority",
  });
  const readback = await readStoredFoundationExternalBindingsAuthority(
    {
      store,
      namespace,
      reference: rawStored.reference,
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
      now: () => nowMilliseconds,
    },
    { readOidcAuthority, readControlState, readProviderObservation },
  );
  return Object.freeze(
    assertFoundationExternalBindingsObservation({
      schemaVersion: 1,
      kind: "foundation-external-bindings-observation/v1",
      namespace,
      sourceSha,
      observedAt: raw.observedAt,
      collectorIdentity: Object.freeze({
        repository: approvalPolicy.repository,
        workflowPath: ".github/workflows/release.yml",
        sourceSha,
        runId: oidcAuthority.runId,
        runAttempt: oidcAuthority.runAttempt,
      }),
      oidcReceipt: Object.freeze({ ...oidcReceipt }),
      rawAuthority: Object.freeze({ ...rawStored.reference }),
      result: readback.result,
    }),
  );
};
