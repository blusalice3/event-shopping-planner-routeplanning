#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [packageJson, releaseStateStorePolicy] = await Promise.all([
  readJsonStrict(path.join(root, "package.json")),
  readJsonStrict(path.join(root, "config", "release-state-store.json")),
]);
const cspContractMigration = await readFile(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260808000000_csp_report_contract.sql",
  ),
  "utf8",
);
const cspUpgradeMatch = cspContractMigration.match(
  /-- CSP_REPORT_CONTRACT_UPGRADE_BEGIN([\s\S]*?)-- CSP_REPORT_CONTRACT_UPGRADE_END/u,
);
if (!cspUpgradeMatch) {
  throw new Error("CSP report contract upgrade block is missing");
}
const cspReportContractUpgradeSql = cspUpgradeMatch[1];
const expectedReleaseStateMigrationPaths = [
  "ops/release-state/migrations/0001_release_state_store.sql",
  "ops/release-state/migrations/0002_acceptance_evidence_chains.sql",
  "ops/release-state/migrations/0003_phase_exit_attestations.sql",
];
if (
  !Array.isArray(releaseStateStorePolicy.migrations) ||
  releaseStateStorePolicy.migrations.length !==
    expectedReleaseStateMigrationPaths.length ||
  releaseStateStorePolicy.migrations.some(
    (migration, index) =>
      migration?.path !== expectedReleaseStateMigrationPaths[index] ||
      typeof migration.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(migration.sha256),
  )
) {
  throw new Error("Disposable DB Release State migration order differs");
}
const releaseStateStoreMigrations = await Promise.all(
  releaseStateStorePolicy.migrations.map(async (migration) => {
    const bytes = await readFile(path.join(root, ...migration.path.split("/")));
    if (sha256Bytes(bytes) !== migration.sha256) {
      throw new Error(
        `Disposable DB Release State migration hash differs: ${migration.path}`,
      );
    }
    return bytes.toString("utf8");
  }),
);
if (process.versions.node !== packageJson.engines.node) {
  throw new Error(
    `Disposable DB gate requires Node ${packageJson.engines.node}; received ${process.versions.node}`,
  );
}
if (process.platform !== "linux") {
  throw new Error(
    "Disposable DB gate is CI-only and requires a Linux Docker host",
  );
}

const supabaseEntry = path.join(
  root,
  "node_modules",
  "supabase",
  "dist",
  "supabase.js",
);
const excludedServices = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
].join(",");

const runSupabase = (arguments_, { allowFailure = false } = {}) => {
  const result = spawnSync(
    process.execPath,
    [supabaseEntry, ...arguments_, "--workdir", root],
    {
      cwd: root,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      stdio: allowFailure ? "pipe" : "inherit",
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Supabase ${arguments_.join(" ")} failed`);
  }
  return result;
};

const scalar = async (client, text) => {
  const result = await client.query(text);
  if (result.rows.length !== 1 || Object.keys(result.rows[0]).length !== 1) {
    throw new Error(`Disposable DB scalar query is ambiguous: ${text}`);
  }
  return Object.values(result.rows[0])[0];
};

/**
 * @param {unknown} error
 * @param {string} expectedCode
 * @param {RegExp | null} [messagePattern]
 */
const isPostgresError = (error, expectedCode, messagePattern = null) => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== expectedCode
  ) {
    return false;
  }
  if (messagePattern === null) return true;
  return (
    "message" in error &&
    typeof error.message === "string" &&
    messagePattern.test(error.message)
  );
};

const RELEASE_STATE_NAMESPACE = "foundation-disposable-control";
const RELEASE_STATE_UPGRADE_NAMESPACE = "foundation-disposable-control-upgrade";
const RELEASE_STATE_EXECUTOR = "foundation_disposable_release_executor";
const RELEASE_STATE_DENIED_EXECUTOR = "foundation_disposable_release_denied";
const RELEASE_STATE_EXECUTOR_PASSWORD = "disposable-release-executor";
const RELEASE_STATE_DENIED_PASSWORD = "disposable-release-denied";
const ACCEPTANCE_OPERATION_ID = "disposable-acceptance-chain";
const ACCEPTANCE_SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const ACCEPTANCE_BINDING_ID = "disposable-standard-binding";
const ACCEPTANCE_SAMPLE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-probe-sample+json;version=1";
const ACCEPTANCE_COMMIT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.continuous-probe-chain-commit+json;version=1";
const ACCEPTANCE_CHAIN_ID = sha256Bytes(
  Buffer.from(
    `${RELEASE_STATE_NAMESPACE}\n${ACCEPTANCE_OPERATION_ID}\n${ACCEPTANCE_SOURCE_SHA}\n${ACCEPTANCE_BINDING_ID}`,
    "utf8",
  ),
);

const acceptanceReference = (sha256) => ({
  sha256,
  uri: `release-state://${RELEASE_STATE_NAMESPACE}/evidence/${sha256}`,
});

const createAcceptancePair = ({
  marker,
  previousCommit = null,
  previousSample = null,
  sequence,
}) => {
  const sampleBytes = canonicalJsonBytes({
    collectorIdentity: { marker },
    evidenceKind: "continuous-production-probe-sample/v1",
    namespace: RELEASE_STATE_NAMESPACE,
    operationId: ACCEPTANCE_OPERATION_ID,
    previousSample,
    results: [],
    schemaVersion: 1,
    sourceSha: ACCEPTANCE_SOURCE_SHA,
    standardBindingId: ACCEPTANCE_BINDING_ID,
  });
  const sampleReference = acceptanceReference(sha256Bytes(sampleBytes));
  const commitBytes = canonicalJsonBytes({
    bindingId: ACCEPTANCE_BINDING_ID,
    commitKind: "continuous-probe-chain-commit/v1",
    namespace: RELEASE_STATE_NAMESPACE,
    operationId: ACCEPTANCE_OPERATION_ID,
    previousCommit,
    sampleReference,
    schemaVersion: 1,
    sequence,
    sourceSha: ACCEPTANCE_SOURCE_SHA,
  });
  return {
    commitBytes,
    commitReference: acceptanceReference(sha256Bytes(commitBytes)),
    sampleBytes,
    sampleReference,
  };
};

const appendAcceptancePair = (
  client,
  {
    bindingId = ACCEPTANCE_BINDING_ID,
    chainId = ACCEPTANCE_CHAIN_ID,
    commitBytes,
    commitMediaType = ACCEPTANCE_COMMIT_MEDIA_TYPE,
    expectedHeadSha,
    expectedSequence,
    operationId = ACCEPTANCE_OPERATION_ID,
    sampleBytes,
    sampleMediaType = ACCEPTANCE_SAMPLE_MEDIA_TYPE,
    sourceSha = ACCEPTANCE_SOURCE_SHA,
  },
) =>
  client.query({
    text: `select *
      from foundation_release.append_acceptance_evidence_chain(
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13
      )`,
    values: [
      RELEASE_STATE_NAMESPACE,
      chainId,
      operationId,
      sourceSha,
      bindingId,
      expectedSequence,
      expectedHeadSha,
      sha256Bytes(sampleBytes),
      sampleMediaType,
      sampleBytes,
      sha256Bytes(commitBytes),
      commitMediaType,
      commitBytes,
    ],
  });

const readAcceptanceChain = (
  client,
  {
    bindingId = ACCEPTANCE_BINDING_ID,
    chainId = ACCEPTANCE_CHAIN_ID,
    operationId = ACCEPTANCE_OPERATION_ID,
    sourceSha = ACCEPTANCE_SOURCE_SHA,
  } = {},
) =>
  client.query({
    text: `select *
      from foundation_release.read_acceptance_evidence_chain(
        $1, $2, $3, $4, $5
      )`,
    values: [
      RELEASE_STATE_NAMESPACE,
      chainId,
      operationId,
      sourceSha,
      bindingId,
    ],
  });

const createReleaseStateEvent = ({
  appendId,
  operationId,
  namespace = RELEASE_STATE_NAMESPACE,
  eventType = "operation-aborted",
  sequence = 1,
  previousEventHash = null,
  payload = {},
  evidenceRefs = [],
}) => {
  return {
    approvalRefs: [],
    appendId,
    evidenceRefs,
    eventType,
    namespace,
    operationId,
    payload,
    payloadSha256: sha256Bytes(canonicalJsonBytes(payload)),
    previousEventHash,
    schemaVersion: 1,
    sequence,
  };
};

const createPhaseExitReleaseStateEvent = ({
  appendId,
  marker,
  namespace,
  operationId,
  previousEventHash,
  sequence,
}) => {
  const attestationSha256 = sha256Bytes(
    Buffer.from(`${namespace}\n${marker}`, "utf8"),
  );
  const attestation = {
    sha256: attestationSha256,
    uri: `release-state://${namespace}/evidence/${attestationSha256}`,
  };
  return createReleaseStateEvent({
    appendId,
    operationId,
    namespace,
    eventType: "phase-exit-attested",
    sequence,
    previousEventHash,
    payload: {
      gate: "P0-BASELINE",
      sourceSha: ACCEPTANCE_SOURCE_SHA,
      subjectKind: "repository-phase-subject/v1",
      attestation,
      predecessor: null,
    },
    evidenceRefs: [attestation],
  });
};

const appendReleaseStateEvent = (
  client,
  event,
  { expectedSequence = 0, expectedHash = null } = {},
) =>
  client.query({
    text: `select *
      from foundation_release.compare_and_append($1, $2, $3, $4, $5)`,
    values: [
      event.namespace,
      expectedSequence,
      expectedHash,
      event.appendId,
      canonicalJsonBytes(event),
    ],
  });

const putReleaseEvidence = ({
  bytes,
  client,
  mediaType = "application/json",
  sha256 = sha256Bytes(bytes),
}) =>
  client.query({
    text: `select *
      from foundation_release.put_evidence_if_absent($1, $2, $3, $4)`,
    values: [RELEASE_STATE_NAMESPACE, sha256, mediaType, bytes],
  });

const connectReleaseStateRole = async ({ Client, password, user }) => {
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user,
    password,
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "foundation-disposable-release-state-gate",
  });
  await client.connect();
  return client;
};

const verifyReleaseStateControlStore = async ({ Client, administrator }) => {
  const phaseExitMigration = releaseStateStoreMigrations.at(-1);
  for (const migration of releaseStateStoreMigrations.slice(0, -1)) {
    await administrator.query(migration);
  }
  await administrator.query(`
    create role ${RELEASE_STATE_EXECUTOR}
      login password '${RELEASE_STATE_EXECUTOR_PASSWORD}';
    create role ${RELEASE_STATE_DENIED_EXECUTOR}
      login password '${RELEASE_STATE_DENIED_PASSWORD}';
    grant usage on schema foundation_release
      to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.compare_and_append(
      text,
      bigint,
      text,
      uuid,
      bytea
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.put_evidence_if_absent(
      text,
      text,
      text,
      bytea
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.append_acceptance_evidence_chain(
      text,
      text,
      text,
      text,
      text,
      bigint,
      text,
      text,
      text,
      bytea,
      text,
      text,
      bytea
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    grant execute on function foundation_release.read_acceptance_evidence_chain(
      text,
      text,
      text,
      text,
      text
    ) to ${RELEASE_STATE_EXECUTOR}, ${RELEASE_STATE_DENIED_EXECUTOR};
    insert into foundation_release.release_state_namespace_roles (
      namespace,
      executor_role
    ) values (
      '${RELEASE_STATE_NAMESPACE}',
      '${RELEASE_STATE_EXECUTOR}'
    ), (
      '${RELEASE_STATE_UPGRADE_NAMESPACE}',
      '${RELEASE_STATE_EXECUTOR}'
    );
  `);

  const executor = await connectReleaseStateRole({
    Client,
    password: RELEASE_STATE_EXECUTOR_PASSWORD,
    user: RELEASE_STATE_EXECUTOR,
  });
  const deniedExecutor = await connectReleaseStateRole({
    Client,
    password: RELEASE_STATE_DENIED_PASSWORD,
    user: RELEASE_STATE_DENIED_EXECUTOR,
  });
  try {
    const upgradeInitialEvent = createReleaseStateEvent({
      appendId: "33333333-3333-4333-8333-333333333333",
      operationId: "disposable-control-store-upgrade-initial",
      namespace: RELEASE_STATE_UPGRADE_NAMESPACE,
      eventType: "state-initialized",
    });
    const upgradeInitialAppend = await appendReleaseStateEvent(
      executor,
      upgradeInitialEvent,
    );
    const upgradeInitialHash = sha256Bytes(
      canonicalJsonBytes(upgradeInitialEvent),
    );
    if (
      upgradeInitialAppend.rowCount !== 1 ||
      Number(upgradeInitialAppend.rows[0].sequence) !== 1 ||
      upgradeInitialAppend.rows[0].event_hash !== upgradeInitialHash ||
      upgradeInitialAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State pre-upgrade append differs");
    }
    const upgradePhaseExitEvent = createPhaseExitReleaseStateEvent({
      appendId: "44444444-4444-4444-8444-444444444444",
      marker: "existing-namespace-upgrade",
      namespace: RELEASE_STATE_UPGRADE_NAMESPACE,
      operationId: "disposable-control-store-upgrade-phase-exit",
      previousEventHash: upgradeInitialHash,
      sequence: 2,
    });
    await assert.rejects(
      appendReleaseStateEvent(executor, upgradePhaseExitEvent, {
        expectedSequence: 1,
        expectedHash: upgradeInitialHash,
      }),
      (error) =>
        isPostgresError(error, "22023", /event envelope does not match/u),
    );

    await administrator.query(phaseExitMigration);
    const upgradedPhaseExitAppend = await appendReleaseStateEvent(
      executor,
      upgradePhaseExitEvent,
      { expectedSequence: 1, expectedHash: upgradeInitialHash },
    );
    const upgradePhaseExitHash = sha256Bytes(
      canonicalJsonBytes(upgradePhaseExitEvent),
    );
    if (
      upgradedPhaseExitAppend.rowCount !== 1 ||
      Number(upgradedPhaseExitAppend.rows[0].sequence) !== 2 ||
      upgradedPhaseExitAppend.rows[0].event_hash !== upgradePhaseExitHash ||
      upgradedPhaseExitAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State phase exit upgrade append differs");
    }

    await administrator.query(phaseExitMigration);
    const upgradedPhaseExitReplay = await appendReleaseStateEvent(
      executor,
      upgradePhaseExitEvent,
      { expectedSequence: 1, expectedHash: upgradeInitialHash },
    );
    if (
      upgradedPhaseExitReplay.rowCount !== 1 ||
      upgradedPhaseExitReplay.rows[0].event_hash !== upgradePhaseExitHash ||
      upgradedPhaseExitReplay.rows[0].replayed !== true
    ) {
      throw new Error("Release State phase exit upgrade replay differs");
    }
    const upgradedHistory = await administrator.query({
      text: `select sequence, event_hash
        from foundation_release.release_state_events
        where namespace = $1
        order by sequence`,
      values: [RELEASE_STATE_UPGRADE_NAMESPACE],
    });
    if (
      upgradedHistory.rowCount !== 2 ||
      Number(upgradedHistory.rows[0].sequence) !== 1 ||
      upgradedHistory.rows[0].event_hash !== upgradeInitialHash ||
      Number(upgradedHistory.rows[1].sequence) !== 2 ||
      upgradedHistory.rows[1].event_hash !== upgradePhaseExitHash
    ) {
      throw new Error("Release State phase exit upgrade changed prior history");
    }

    const unknownEvent = createReleaseStateEvent({
      appendId: "66666666-6666-4666-8666-666666666666",
      operationId: "disposable-control-store-unknown-event",
      eventType: "caller-defined-event",
    });
    await assert.rejects(
      appendReleaseStateEvent(executor, unknownEvent),
      (error) =>
        isPostgresError(error, "22023", /event envelope does not match/u),
    );

    const event = createReleaseStateEvent({
      appendId: "11111111-1111-4111-8111-111111111111",
      operationId: "disposable-control-store-append",
    });
    const eventBytes = canonicalJsonBytes(event);
    const firstAppend = await appendReleaseStateEvent(executor, event);
    if (
      firstAppend.rowCount !== 1 ||
      Number(firstAppend.rows[0].sequence) !== 1 ||
      firstAppend.rows[0].event_hash !== sha256Bytes(eventBytes) ||
      firstAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State initial CAS receipt differs");
    }

    const replayedAppend = await appendReleaseStateEvent(executor, event);
    if (
      replayedAppend.rowCount !== 1 ||
      replayedAppend.rows[0].event_hash !== firstAppend.rows[0].event_hash ||
      replayedAppend.rows[0].replayed !== true
    ) {
      throw new Error("Release State idempotent append receipt differs");
    }

    const freshPhaseExitEvent = createPhaseExitReleaseStateEvent({
      appendId: "55555555-5555-4555-8555-555555555555",
      marker: "fresh-ordered-migrations",
      namespace: RELEASE_STATE_NAMESPACE,
      operationId: "disposable-control-store-fresh-phase-exit",
      previousEventHash: firstAppend.rows[0].event_hash,
      sequence: 2,
    });
    const freshPhaseExitAppend = await appendReleaseStateEvent(
      executor,
      freshPhaseExitEvent,
      { expectedSequence: 1, expectedHash: firstAppend.rows[0].event_hash },
    );
    if (
      freshPhaseExitAppend.rowCount !== 1 ||
      Number(freshPhaseExitAppend.rows[0].sequence) !== 2 ||
      freshPhaseExitAppend.rows[0].event_hash !==
        sha256Bytes(canonicalJsonBytes(freshPhaseExitEvent)) ||
      freshPhaseExitAppend.rows[0].replayed !== false
    ) {
      throw new Error("Release State fresh phase exit append differs");
    }

    const conflictingEvent = createReleaseStateEvent({
      appendId: "22222222-2222-4222-8222-222222222222",
      operationId: "disposable-control-store-conflict",
    });
    await assert.rejects(
      appendReleaseStateEvent(executor, conflictingEvent),
      (error) => isPostgresError(error, "40001", /compare-and-swap failed/u),
    );
    await assert.rejects(
      appendReleaseStateEvent(deniedExecutor, event),
      (error) =>
        isPostgresError(error, "42501", /release namespace executor denied/u),
    );
    await assert.rejects(
      deniedExecutor.query(
        "select sequence from foundation_release.release_state_heads",
      ),
      (error) => isPostgresError(error, "42501"),
    );

    const evidenceBytes = canonicalJsonBytes({
      kind: "disposable-release-evidence/v1",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
    });
    const evidenceSha256 = sha256Bytes(evidenceBytes);
    const firstEvidence = await putReleaseEvidence({
      bytes: evidenceBytes,
      client: executor,
    });
    if (
      firstEvidence.rowCount !== 1 ||
      firstEvidence.rows[0].sha256 !== evidenceSha256 ||
      Number(firstEvidence.rows[0].byte_length) !== evidenceBytes.length ||
      firstEvidence.rows[0].replayed !== false
    ) {
      throw new Error("Release State initial evidence receipt differs");
    }

    const replayedEvidence = await putReleaseEvidence({
      bytes: evidenceBytes,
      client: executor,
    });
    if (
      replayedEvidence.rowCount !== 1 ||
      replayedEvidence.rows[0].sha256 !== evidenceSha256 ||
      replayedEvidence.rows[0].replayed !== true
    ) {
      throw new Error("Release State idempotent evidence receipt differs");
    }
    await assert.rejects(
      putReleaseEvidence({
        bytes: evidenceBytes,
        client: executor,
        mediaType: "application/octet-stream",
      }),
      (error) =>
        isPostgresError(error, "23505", /different metadata or bytes/u),
    );
    await assert.rejects(
      putReleaseEvidence({
        bytes: Buffer.from("tampered", "utf8"),
        client: executor,
        sha256: evidenceSha256,
      }),
      (error) => isPostgresError(error, "22000", /SHA-256 mismatch/u),
    );
    await assert.rejects(
      administrator.query(`
        update foundation_release.release_evidence_objects
        set media_type = 'application/octet-stream'
        where namespace = '${RELEASE_STATE_NAMESPACE}'
      `),
      (error) => isPostgresError(error, "55000", /records are immutable/u),
    );
    await assert.rejects(
      administrator.query(`
        delete from foundation_release.release_state_events
        where namespace = '${RELEASE_STATE_NAMESPACE}'
      `),
      (error) => isPostgresError(error, "55000", /records are immutable/u),
    );

    const firstAcceptancePair = createAcceptancePair({
      marker: "first",
      sequence: 1,
    });
    const firstAcceptanceAppend = await appendAcceptancePair(executor, {
      ...firstAcceptancePair,
      expectedHeadSha: null,
      expectedSequence: 0,
    });
    if (
      firstAcceptanceAppend.rowCount !== 1 ||
      Number(firstAcceptanceAppend.rows[0].chain_sequence) !== 1 ||
      firstAcceptanceAppend.rows[0].chain_head_sha !==
        firstAcceptancePair.commitReference.sha256 ||
      firstAcceptanceAppend.rows[0].sample_committed_at.toISOString() !==
        firstAcceptanceAppend.rows[0].commit_committed_at.toISOString() ||
      firstAcceptanceAppend.rows[0].replayed !== false
    ) {
      throw new Error("Acceptance chain initial atomic append differs");
    }
    const firstAcceptanceReplay = await appendAcceptancePair(executor, {
      ...firstAcceptancePair,
      expectedHeadSha: null,
      expectedSequence: 0,
    });
    if (
      firstAcceptanceReplay.rowCount !== 1 ||
      firstAcceptanceReplay.rows[0].chain_head_sha !==
        firstAcceptancePair.commitReference.sha256 ||
      firstAcceptanceReplay.rows[0].replayed !== true
    ) {
      throw new Error("Acceptance chain idempotent replay differs");
    }
    const firstAcceptanceHead = await readAcceptanceChain(executor);
    if (
      firstAcceptanceHead.rowCount !== 1 ||
      Number(firstAcceptanceHead.rows[0].sequence) !== 1 ||
      firstAcceptanceHead.rows[0].head_sha !==
        firstAcceptancePair.commitReference.sha256 ||
      firstAcceptanceHead.rows[0].operation_id !== ACCEPTANCE_OPERATION_ID ||
      firstAcceptanceHead.rows[0].source_sha !== ACCEPTANCE_SOURCE_SHA ||
      firstAcceptanceHead.rows[0].binding_id !== ACCEPTANCE_BINDING_ID
    ) {
      throw new Error("Acceptance chain canonical head differs");
    }

    const staleAcceptancePair = createAcceptancePair({
      marker: "stale-origin",
      sequence: 1,
    });
    await assert.rejects(
      appendAcceptancePair(executor, {
        ...staleAcceptancePair,
        expectedHeadSha: null,
        expectedSequence: 0,
      }),
      (error) => isPostgresError(error, "40001", /compare-and-swap failed/u),
    );
    await assert.rejects(
      appendAcceptancePair(executor, {
        ...staleAcceptancePair,
        chainId: "f".repeat(64),
        expectedHeadSha: null,
        expectedSequence: 0,
      }),
      (error) => isPostgresError(error, "22023", /arguments are invalid/u),
    );
    await assert.rejects(
      appendAcceptancePair(executor, {
        ...staleAcceptancePair,
        expectedHeadSha: null,
        expectedSequence: 0,
        sampleMediaType: "application/json",
      }),
      (error) => isPostgresError(error, "22023", /arguments are invalid/u),
    );

    const secondAcceptancePair = createAcceptancePair({
      marker: "second",
      previousCommit: firstAcceptancePair.commitReference,
      previousSample: firstAcceptancePair.sampleReference,
      sequence: 2,
    });
    await administrator.query(`
      create function foundation_release.foundation_disposable_reject_chain_update()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'disposable acceptance rollback probe';
      end;
      $$;
      create trigger foundation_disposable_reject_chain_update
      before update on foundation_release.acceptance_evidence_chains
      for each row execute function
        foundation_release.foundation_disposable_reject_chain_update();
    `);
    try {
      await assert.rejects(
        appendAcceptancePair(executor, {
          ...secondAcceptancePair,
          expectedHeadSha: firstAcceptancePair.commitReference.sha256,
          expectedSequence: 1,
        }),
        /disposable acceptance rollback probe/u,
      );
    } finally {
      await administrator.query(`
        drop trigger foundation_disposable_reject_chain_update
          on foundation_release.acceptance_evidence_chains;
        drop function
          foundation_release.foundation_disposable_reject_chain_update();
      `);
    }
    const rolledBackAcceptanceObjects = Number(
      await scalar(
        administrator,
        `select count(*)::integer
         from foundation_release.release_evidence_objects
         where namespace = '${RELEASE_STATE_NAMESPACE}'
           and sha256 in (
             '${secondAcceptancePair.sampleReference.sha256}',
             '${secondAcceptancePair.commitReference.sha256}'
           )`,
      ),
    );
    const headAfterRollback = await readAcceptanceChain(executor);
    if (
      rolledBackAcceptanceObjects !== 0 ||
      Number(headAfterRollback.rows[0].sequence) !== 1 ||
      headAfterRollback.rows[0].head_sha !==
        firstAcceptancePair.commitReference.sha256
    ) {
      throw new Error("Acceptance chain failed append was not atomic");
    }

    const secondAcceptanceAppend = await appendAcceptancePair(executor, {
      ...secondAcceptancePair,
      expectedHeadSha: firstAcceptancePair.commitReference.sha256,
      expectedSequence: 1,
    });
    if (
      secondAcceptanceAppend.rowCount !== 1 ||
      Number(secondAcceptanceAppend.rows[0].chain_sequence) !== 2 ||
      secondAcceptanceAppend.rows[0].chain_head_sha !==
        secondAcceptancePair.commitReference.sha256 ||
      secondAcceptanceAppend.rows[0].replayed !== false
    ) {
      throw new Error("Acceptance chain second atomic append differs");
    }
    const secondAcceptanceReplay = await appendAcceptancePair(executor, {
      ...secondAcceptancePair,
      expectedHeadSha: firstAcceptancePair.commitReference.sha256,
      expectedSequence: 1,
    });
    if (secondAcceptanceReplay.rows[0].replayed !== true) {
      throw new Error("Acceptance chain second replay differs");
    }

    const invalidCommitBytes = canonicalJsonBytes({
      bindingId: ACCEPTANCE_BINDING_ID,
      commitKind: "continuous-probe-chain-commit/v1",
      namespace: RELEASE_STATE_NAMESPACE,
      operationId: "different-operation",
      previousCommit: secondAcceptancePair.commitReference,
      sampleReference: secondAcceptancePair.sampleReference,
      schemaVersion: 1,
      sequence: 3,
      sourceSha: ACCEPTANCE_SOURCE_SHA,
    });
    await assert.rejects(
      appendAcceptancePair(executor, {
        commitBytes: invalidCommitBytes,
        expectedHeadSha: secondAcceptancePair.commitReference.sha256,
        expectedSequence: 2,
        sampleBytes: secondAcceptancePair.sampleBytes,
      }),
      (error) =>
        isPostgresError(error, "22023", /commit document binding is invalid/u),
    );

    const thirdAcceptancePair = createAcceptancePair({
      marker: "denied",
      previousCommit: secondAcceptancePair.commitReference,
      previousSample: secondAcceptancePair.sampleReference,
      sequence: 3,
    });
    await assert.rejects(
      appendAcceptancePair(deniedExecutor, {
        ...thirdAcceptancePair,
        expectedHeadSha: secondAcceptancePair.commitReference.sha256,
        expectedSequence: 2,
      }),
      (error) => isPostgresError(error, "42501", /executor is not authorized/u),
    );
    await assert.rejects(readAcceptanceChain(deniedExecutor), (error) =>
      isPostgresError(error, "42501", /reader is not authorized/u),
    );
    await assert.rejects(
      readAcceptanceChain(executor, { chainId: "e".repeat(64) }),
      (error) => isPostgresError(error, "22023", /reader identity is invalid/u),
    );
    for (const statement of [
      "select * from foundation_release.acceptance_evidence_chains",
      `update foundation_release.acceptance_evidence_chains
       set updated_at = clock_timestamp()`,
      "delete from foundation_release.acceptance_evidence_chains",
    ]) {
      await assert.rejects(executor.query(statement), (error) =>
        isPostgresError(error, "42501"),
      );
    }
  } finally {
    await Promise.allSettled([executor.end(), deniedExecutor.end()]);
  }
};

let started = false;
try {
  runSupabase(["start", "--exclude", excludedServices]);
  started = true;
  runSupabase(["db", "reset", "--local", "--no-seed"]);

  const { Client } = await import("pg");
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: "postgres",
    password: "postgres",
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "foundation-disposable-db-gate",
  });
  await client.connect();
  try {
    const serverVersion = String(await scalar(client, "show server_version"));
    if (!serverVersion.startsWith("17.")) {
      throw new Error(`Disposable DB must use PostgreSQL 17: ${serverVersion}`);
    }
    const requiredRelations = await client.query(`
      select c.relname, c.relkind
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'persistence_release_a_metric_events',
          'persistence_release_a_metrics_dashboard_24h',
          'persistence_release_a_metrics_dashboard_hourly_24h',
          'persistence_release_a_cleanup_dashboard_24h',
          'csp_violation_reports',
          'foundation_retention_run_audit'
        )
      order by c.relname
    `);
    if (requiredRelations.rowCount !== 6) {
      throw new Error("Disposable DB is missing a required table or view");
    }
    const requiredFunctions = await client.query(`
      select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'read_persistence_release_a_metrics',
          'read_csp_violation_aggregates',
          'read_csp_deployment_violation_aggregates',
          'retain_persistence_release_a_metrics',
          'retain_csp_violation_reports'
        )
      order by p.proname
    `);
    if (requiredFunctions.rowCount !== 5) {
      throw new Error("Disposable DB is missing a bounded operator function");
    }

    const legacyCspSourceSha = "fedcba9876543210fedcba9876543210fedcba98";
    await client.query(`
      alter table public.csp_violation_reports
        drop constraint csp_violation_reports_blocked_target_check;
      alter table public.csp_violation_reports
        add check (
          blocked_target in (
            'self',
            'data',
            'blob',
            'http',
            'https',
            'same-site',
            'cross-site',
            'inline',
            'eval',
            'unknown'
          )
        );
      insert into public.csp_violation_reports (
        schema_version,
        effective_directive,
        disposition,
        blocked_target,
        source_sha,
        provider_deployment_id
      ) values (
        1,
        'script-src',
        'report',
        'data',
        '${legacyCspSourceSha}',
        'deployment_disposable_csp_legacy'
      );
    `);
    const legacyBlockedTargetConstraint = await scalar(
      client,
      `select constraint_name
       from information_schema.check_constraints
       where constraint_schema = 'public'
         and constraint_name like 'csp_violation_reports_blocked_target_check%'`,
    );
    if (
      legacyBlockedTargetConstraint !==
      "csp_violation_reports_blocked_target_check"
    ) {
      throw new Error(
        `Legacy CSP constraint received an unexpected name: ${legacyBlockedTargetConstraint}`,
      );
    }

    await client.query(cspReportContractUpgradeSql);
    const upgradedLegacyTarget = await scalar(
      client,
      `select blocked_target
       from public.csp_violation_reports
       where provider_deployment_id = 'deployment_disposable_csp_legacy'`,
    );
    const upgradedConstraints = await client.query(`
      select conname, convalidated
      from pg_catalog.pg_constraint
      where conrelid = 'public.csp_violation_reports'::regclass
        and contype = 'c'
        and (
          pg_catalog.pg_get_constraintdef(oid) like '%effective_directive%'
          or pg_catalog.pg_get_constraintdef(oid) like '%blocked_target%'
        )
      order by conname
    `);
    const expectedUpgradedConstraintNames = [
      "csp_violation_reports_blocked_target_check",
      "csp_violation_reports_effective_directive_check",
    ];
    if (
      upgradedLegacyTarget !== "scheme" ||
      upgradedConstraints.rowCount !== 2 ||
      upgradedConstraints.rows.some(
        (constraint, index) =>
          constraint.conname !== expectedUpgradedConstraintNames[index],
      ) ||
      upgradedConstraints.rows.some(
        (constraint) => constraint.convalidated !== true,
      )
    ) {
      throw new Error("CSP report contract upgrade was not validated");
    }
    await client.query(
      `delete from public.csp_violation_reports
       where provider_deployment_id = 'deployment_disposable_csp_legacy'`,
    );

    const grants = await client.query(`
      select
        has_table_privilege(
          'service_role',
          'public.persistence_release_a_metric_events',
          'INSERT'
        ) as metrics_insert,
        has_table_privilege(
          'service_role',
          'public.persistence_release_a_metric_events',
          'SELECT'
        ) as metrics_select,
        has_table_privilege(
          'service_role',
          'public.csp_violation_reports',
          'INSERT'
        ) as csp_insert,
        has_table_privilege(
          'service_role',
          'public.csp_violation_reports',
          'SELECT'
        ) as csp_select,
        has_function_privilege(
          'service_role',
          'public.read_persistence_release_a_metrics(timestamptz,timestamptz,integer)',
          'EXECUTE'
        ) as metrics_read_execute,
        has_function_privilege(
          'service_role',
          'public.retain_persistence_release_a_metrics(boolean,integer,integer)',
          'EXECUTE'
        ) as metrics_retention_execute
    `);
    if (
      grants.rowCount !== 1 ||
      grants.rows[0].metrics_insert !== true ||
      grants.rows[0].metrics_select !== false ||
      grants.rows[0].csp_insert !== true ||
      grants.rows[0].csp_select !== false ||
      grants.rows[0].metrics_read_execute !== false ||
      grants.rows[0].metrics_retention_execute !== false
    ) {
      throw new Error("Disposable DB service role privileges differ");
    }
    for (const role of ["anon", "authenticated"]) {
      const roleGrants = await client.query({
        text: `select
          has_table_privilege(
            $1,
            'public.persistence_release_a_metric_events',
            'SELECT'
          ) as can_read,
          has_table_privilege(
            $1,
            'public.persistence_release_a_metric_events',
            'INSERT'
          ) as can_insert`,
        values: [role],
      });
      if (
        roleGrants.rowCount !== 1 ||
        roleGrants.rows[0].can_read ||
        roleGrants.rows[0].can_insert
      ) {
        throw new Error(`Disposable DB grants application access to ${role}`);
      }
    }
    const forbiddenAclCount = Number(
      await scalar(
        client,
        `select count(*)::integer
         from (
           select c.oid
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           cross join lateral pg_catalog.aclexplode(
             coalesce(
               c.relacl,
               pg_catalog.acldefault(
                 case when c.relkind = 'S' then 's' else 'r' end::"char",
                 c.relowner
               )
             )
           ) acl
           where n.nspname = 'public'
             and c.relname in (
               'persistence_release_a_metric_events',
               'persistence_release_a_metric_events_id_seq',
               'persistence_release_a_metrics_dashboard_24h',
               'persistence_release_a_metrics_dashboard_hourly_24h',
               'persistence_release_a_cleanup_dashboard_24h',
               'csp_violation_reports',
               'csp_violation_reports_id_seq',
               'foundation_retention_run_audit',
               'foundation_retention_run_audit_id_seq'
             )
             and (
               acl.grantee = 0
               or pg_catalog.pg_get_userbyid(acl.grantee) in (
                 'anon',
                 'authenticated'
               )
             )
           union all
           select p.oid
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           cross join lateral pg_catalog.aclexplode(
             coalesce(
               p.proacl,
               pg_catalog.acldefault('f'::"char", p.proowner)
             )
           ) acl
           where n.nspname = 'public'
             and p.proname in (
               'read_persistence_release_a_metrics',
               'read_csp_violation_aggregates',
               'read_csp_deployment_violation_aggregates',
               'retain_persistence_release_a_metrics',
               'retain_csp_violation_reports'
             )
             and (
               acl.grantee = 0
               or pg_catalog.pg_get_userbyid(acl.grantee) in (
                 'anon',
                 'authenticated'
               )
             )
         ) forbidden_acl`,
      ),
    );
    if (forbiddenAclCount !== 0) {
      throw new Error(
        `Disposable DB exposes ${forbiddenAclCount} forbidden ACL entries`,
      );
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await client.query(`
        insert into public.persistence_release_a_metric_events (
          schema_version,
          event_version,
          event_name,
          outcome,
          duration_bucket,
          cleanup_mode,
          cleanup_reason,
          build_id,
          browser_family,
          app_mode,
          online
        ) values (
          1,
          1,
          'startup',
          'ready',
          'lt-250ms',
          null,
          null,
          '0123456789abcdef0123456789abcdef01234567',
          'chromium',
          'browser-tab',
          true
        )
      `);
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await assert.rejects(
        client.query(`
          insert into public.persistence_release_a_metric_events (
            schema_version,
            event_version,
            event_name,
            outcome,
            duration_bucket,
            cleanup_mode,
            cleanup_reason,
            build_id,
            browser_family,
            app_mode,
            online
          ) values (
            1,
            1,
            'startup',
            'ready',
            null,
            null,
            null,
            '0123456789abcdef0123456789abcdef01234567',
            'chromium',
            'browser-tab',
            true
          )
        `),
        /persistence_release_a_metric_duration_check/,
      );
    } finally {
      await client.query("rollback");
    }

    const cspSourceSha = "89abcdef0123456789abcdef0123456789abcdef";
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await client.query({
        text: `insert into public.csp_violation_reports (
          schema_version,
          effective_directive,
          disposition,
          blocked_target,
          source_sha,
          provider_deployment_id
        ) values
          (1, 'worker-src', 'report', 'scheme', $1, $2),
          (1, 'unknown', 'report', 'unknown', $1, $3)`,
        values: [
          cspSourceSha,
          "deployment_disposable_csp_1",
          "deployment_disposable_csp_2",
        ],
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await assert.rejects(
        client.query({
          text: `insert into public.csp_violation_reports (
            schema_version,
            effective_directive,
            disposition,
            blocked_target,
            source_sha,
            provider_deployment_id
          ) values (1, 'trusted-types', 'report', 'unknown', $1, $2)`,
          values: [cspSourceSha, "deployment_disposable_csp_invalid"],
        }),
        /csp_violation_reports_effective_directive_check/,
      );
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await assert.rejects(
        client.query("select blocked_target from public.csp_violation_reports"),
        /permission denied for table csp_violation_reports/,
      );
    } finally {
      await client.query("rollback");
    }

    const cspOperatorRole = "foundation_disposable_csp_operator";
    await client.query(`create role ${cspOperatorRole} nologin`);
    try {
      await client.query(
        `grant execute on function public.read_csp_violation_aggregates(
          timestamptz,
          timestamptz,
          integer
        ) to ${cspOperatorRole}`,
      );
      await client.query(
        `grant execute on function public.read_csp_deployment_violation_aggregates(
          timestamptz,
          timestamptz,
          text,
          text,
          integer
        ) to ${cspOperatorRole}`,
      );
      await client.query("begin");
      try {
        await client.query(`set local role ${cspOperatorRole}`);
        await assert.rejects(
          client.query(
            "select blocked_target from public.csp_violation_reports",
          ),
          /permission denied for table csp_violation_reports/,
        );
      } finally {
        await client.query("rollback");
      }

      await client.query("begin");
      try {
        await client.query(`set local role ${cspOperatorRole}`);
        const cspAggregate = await client.query({
          text: `select *
            from public.read_csp_violation_aggregates(
              clock_timestamp() - interval '1 minute',
              clock_timestamp() + interval '1 minute',
              10
            )`,
        });
        const aggregatesByDirective = new Map(
          cspAggregate.rows.map((row) => [row.effective_directive, row]),
        );
        const workerAggregate = aggregatesByDirective.get("worker-src");
        const unknownAggregate = aggregatesByDirective.get("unknown");
        if (
          cspAggregate.rowCount !== 2 ||
          workerAggregate?.source_sha !== cspSourceSha ||
          workerAggregate?.disposition !== "report" ||
          workerAggregate?.blocked_target !== "scheme" ||
          Number(workerAggregate?.violation_count) !== 1 ||
          unknownAggregate?.source_sha !== cspSourceSha ||
          unknownAggregate?.disposition !== "report" ||
          unknownAggregate?.blocked_target !== "unknown" ||
          Number(unknownAggregate?.violation_count) !== 1
        ) {
          throw new Error("Disposable DB CSP operator aggregate differs");
        }
        const deploymentAggregate = await client.query({
          text: `select *
            from public.read_csp_deployment_violation_aggregates(
              clock_timestamp() - interval '1 minute',
              clock_timestamp() + interval '1 minute',
              $1,
              $2,
              10
            )`,
          values: [cspSourceSha, "deployment_disposable_csp_1"],
        });
        if (
          deploymentAggregate.rowCount !== 1 ||
          deploymentAggregate.rows[0].effective_directive !== "worker-src" ||
          Number(deploymentAggregate.rows[0].violation_count) !== 1
        ) {
          throw new Error("Disposable DB deployment CSP aggregate differs");
        }
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query(
        `revoke execute on function public.read_csp_violation_aggregates(
          timestamptz,
          timestamptz,
          integer
        ) from ${cspOperatorRole}`,
      );
      await client.query(
        `revoke execute on function public.read_csp_deployment_violation_aggregates(
          timestamptz,
          timestamptz,
          text,
          text,
          integer
        ) from ${cspOperatorRole}`,
      );
      await client.query(`drop role ${cspOperatorRole}`);
    }

    const retention = await client.query(
      "select * from public.retain_persistence_release_a_metrics(true, 10, 1)",
    );
    if (
      retention.rowCount !== 1 ||
      retention.rows[0].dry_run !== true ||
      Number(retention.rows[0].affected_rows) !== 0
    ) {
      throw new Error("Disposable DB retention dry-run differs");
    }
    const cronJobs = Number(
      await scalar(
        client,
        `select count(*) from cron.job
         where jobname = 'event-shopping-planner-foundation-retention-v1'`,
      ),
    );
    if (cronJobs !== 1) {
      throw new Error(
        "Disposable DB retention schedule is missing or duplicated",
      );
    }
    await verifyReleaseStateControlStore({ Client, administrator: client });
  } finally {
    await client.end();
  }
  process.stdout.write(
    "PASS disposable PostgreSQL 17 application/control migrations, CAS, privileges, immutability, retention, and cron\n",
  );
} finally {
  if (started) {
    const stopped = runSupabase(["stop", "--no-backup"], {
      allowFailure: true,
    });
    if (stopped.status !== 0) {
      process.stderr.write(
        `WARN disposable Supabase cleanup failed: ${stopped.stderr}\n`,
      );
      process.exitCode = 1;
    }
  }
}
