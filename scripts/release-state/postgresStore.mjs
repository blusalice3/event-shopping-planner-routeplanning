import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { putEvidenceObject, readEvidenceObject } from "./evidenceStore.mjs";

const assertConfiguredStorePolicy = (policy) => {
  if (policy.bindingStatus !== "configured") {
    throw new Error(
      `Release State store is not configured: ${(policy.blockerCodes ?? []).join(", ")}`,
    );
  }
};

const validateConnectionBinding = (connectionString, policy) => {
  assertConfiguredStorePolicy(policy);
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Release State URL must use PostgreSQL");
  }
  if (!policy.allowedHosts.includes(parsed.hostname)) {
    throw new Error("Release State host is not allowlisted");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!policy.allowedDatabases.includes(database)) {
    throw new Error("Release State database is not allowlisted");
  }
  const role = decodeURIComponent(parsed.username);
  if (!policy.allowedExecutorRoles.includes(role)) {
    throw new Error("Release State executor role is not allowlisted");
  }
  if (
    parsed.password.length === 0 ||
    (parsed.port !== "" && parsed.port !== "5432") ||
    parsed.hash !== ""
  ) {
    throw new Error("Release State URL authority is invalid");
  }
  const queryNames = [...new Set(parsed.searchParams.keys())];
  if (
    queryNames.length !== 1 ||
    queryNames[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error("Release State connection requires sslmode=verify-full");
  }
  return { database, host: parsed.hostname, parsed, role };
};

const normalizeReceipt = (row) => ({
  namespace: row.namespace,
  sequence: Number(row.sequence),
  eventHash: row.event_hash,
  committedAt: new Date(row.committed_at).toISOString(),
  replayed: row.replayed,
});

export const createPostgresReleaseStateStore = async ({
  connectionString,
  namespace,
  policy,
  ca,
}) => {
  const connection = validateConnectionBinding(connectionString, policy);
  if (typeof ca !== "string" || ca.trim().length === 0) {
    throw new Error("Release State production CA is required");
  }
  if (
    typeof policy.productionCaSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(policy.productionCaSha256) ||
    sha256Bytes(Buffer.from(ca, "utf8")) !== policy.productionCaSha256
  ) {
    throw new Error(
      "Release State production CA fingerprint differs from policy",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(namespace)) {
    throw new Error("Release State namespace is invalid");
  }
  const runtimeUrl = new URL(connection.parsed);
  runtimeUrl.searchParams.delete("sslmode");
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: runtimeUrl.toString(),
    max: 2,
    connectionTimeoutMillis: policy.connectTimeoutMilliseconds,
    statement_timeout: policy.statementTimeoutMilliseconds,
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
    application_name: "event-shopping-planner-foundation-release",
  });

  return {
    namespace,

    async readHead() {
      const result = await pool.query({
        name: "foundation-read-head-v1",
        text: `
          select sequence, event_hash
          from foundation_release.release_state_heads
          where namespace = $1
        `,
        values: [namespace],
      });
      if (result.rowCount === 0) return { sequence: 0, eventHash: null };
      if (result.rowCount !== 1)
        throw new Error("Release State head is ambiguous");
      return {
        sequence: Number(result.rows[0].sequence),
        eventHash: result.rows[0].event_hash,
      };
    },

    async compareAndAppend({ expectedSequence, expectedHash, event }) {
      if (event.namespace !== namespace) {
        throw new Error("Release event namespace does not match store binding");
      }
      if (
        event.sequence !== expectedSequence + 1 ||
        event.previousEventHash !== expectedHash
      ) {
        throw new Error(
          "Release event does not match requested CAS predecessor",
        );
      }
      const eventBytes = canonicalJsonBytes(event);
      const result = await pool.query({
        name: "foundation-compare-append-v1",
        text: `
          select *
          from foundation_release.compare_and_append($1, $2, $3, $4, $5)
        `,
        values: [
          namespace,
          expectedSequence,
          expectedHash,
          event.appendId,
          eventBytes,
        ],
      });
      if (result.rowCount !== 1) {
        throw new Error("Release State append returned no receipt");
      }
      return normalizeReceipt(result.rows[0]);
    },

    async readEvents({ afterSequence = 0 } = {}) {
      const result = await pool.query({
        name: "foundation-read-events-v1",
        text: `
          select sequence, event_hash, previous_hash, event_bytes, committed_at
          from foundation_release.release_state_events
          where namespace = $1 and sequence > $2
          order by sequence asc
        `,
        values: [namespace, afterSequence],
      });
      return result.rows.map((row) => {
        const eventBytes = Buffer.from(row.event_bytes);
        const event = parseJsonStrict(
          eventBytes.toString("utf8"),
          "release event",
        );
        if (
          !canonicalJsonBytes(event).equals(eventBytes) ||
          sha256Bytes(eventBytes) !== row.event_hash ||
          event.namespace !== namespace ||
          event.sequence !== Number(row.sequence) ||
          event.previousEventHash !== row.previous_hash
        ) {
          throw new Error(
            "Stored Release State event failed its immutable binding",
          );
        }
        return {
          sequence: Number(row.sequence),
          eventHash: row.event_hash,
          previousHash: row.previous_hash,
          event,
          committedAt: new Date(row.committed_at).toISOString(),
        };
      });
    },

    async putEvidence({ bytes, mediaType }) {
      return putEvidenceObject({
        client: pool,
        namespace,
        bytes,
        mediaType,
      });
    },

    async readEvidence({ sha256 }) {
      return readEvidenceObject({
        client: pool,
        namespace,
        sha256,
      });
    },

    async appendAcceptanceSample({
      operationId,
      sourceSha,
      bindingId,
      expectedPreviousCommit,
      expectedSequence,
      sampleBytes,
      sampleMediaType,
      commitBytes,
      commitMediaType,
    }) {
      if (
        typeof operationId !== "string" ||
        operationId.length === 0 ||
        !/^[0-9a-f]{40}$/.test(sourceSha) ||
        typeof bindingId !== "string" ||
        bindingId.length === 0 ||
        !Number.isSafeInteger(expectedSequence) ||
        expectedSequence < 0 ||
        (expectedPreviousCommit !== null &&
          (!/^[0-9a-f]{64}$/.test(expectedPreviousCommit?.sha256) ||
            expectedPreviousCommit.uri !==
              `release-state://${namespace}/evidence/${expectedPreviousCommit.sha256}`)) ||
        !Buffer.isBuffer(sampleBytes) ||
        !Buffer.isBuffer(commitBytes)
      ) {
        throw new Error("Acceptance sample atomic append options are invalid");
      }
      const sampleSha256 = sha256Bytes(sampleBytes);
      const commitSha256 = sha256Bytes(commitBytes);
      const commit = parseJsonStrict(
        commitBytes.toString("utf8"),
        "acceptance sample chain commit",
      );
      if (
        !canonicalJsonBytes(commit).equals(commitBytes) ||
        commit.operationId !== operationId ||
        commit.sourceSha !== sourceSha ||
        commit.bindingId !== bindingId ||
        commit.sequence !== expectedSequence + 1 ||
        commit.sampleReference?.sha256 !== sampleSha256 ||
        commit.sampleReference?.uri !==
          `release-state://${namespace}/evidence/${sampleSha256}` ||
        (expectedPreviousCommit === null
          ? commit.previousCommit !== null
          : commit.previousCommit?.sha256 !== expectedPreviousCommit.sha256 ||
            commit.previousCommit?.uri !== expectedPreviousCommit.uri)
      ) {
        throw new Error(
          "Acceptance sample chain commit differs from append request",
        );
      }
      const chainId = sha256Bytes(
        Buffer.from(
          `${namespace}\n${operationId}\n${sourceSha}\n${bindingId}`,
          "utf8",
        ),
      );
      const result = await pool.query({
        name: "foundation-append-acceptance-chain-v1",
        text: `
          select *
          from foundation_release.append_acceptance_evidence_chain(
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13
          )
        `,
        values: [
          namespace,
          chainId,
          operationId,
          sourceSha,
          bindingId,
          expectedSequence,
          expectedPreviousCommit?.sha256 ?? null,
          sampleSha256,
          sampleMediaType,
          sampleBytes,
          commitSha256,
          commitMediaType,
          commitBytes,
        ],
      });
      if (result.rowCount !== 1) {
        throw new Error("Acceptance sample chain append returned no receipt");
      }
      const row = result.rows[0];
      const sampleCommittedAt = new Date(row.sample_committed_at).toISOString();
      const commitCommittedAt = new Date(row.commit_committed_at).toISOString();
      if (
        Number(row.chain_sequence) !== expectedSequence + 1 ||
        row.chain_head_sha !== commitSha256 ||
        typeof row.replayed !== "boolean" ||
        !Number.isFinite(Date.parse(sampleCommittedAt)) ||
        commitCommittedAt !== sampleCommittedAt
      ) {
        throw new Error("Acceptance sample chain append receipt differs");
      }
      return {
        sample: {
          uri: `release-state://${namespace}/evidence/${sampleSha256}`,
          sha256: sampleSha256,
          mediaType: sampleMediaType,
          byteLength: sampleBytes.length,
          committedAt: sampleCommittedAt,
          replayed: row.replayed,
        },
        commit: {
          uri: `release-state://${namespace}/evidence/${commitSha256}`,
          sha256: commitSha256,
          mediaType: commitMediaType,
          byteLength: commitBytes.length,
          committedAt: commitCommittedAt,
          replayed: row.replayed,
        },
      };
    },

    async readAcceptanceEvidenceChain({ operationId, sourceSha, bindingId }) {
      if (
        typeof operationId !== "string" ||
        !/^[0-9a-f]{40}$/.test(sourceSha) ||
        typeof bindingId !== "string" ||
        bindingId.length === 0
      ) {
        throw new Error("Acceptance evidence chain identity is invalid");
      }
      const chainId = sha256Bytes(
        Buffer.from(
          `${namespace}\n${operationId}\n${sourceSha}\n${bindingId}`,
          "utf8",
        ),
      );
      const result = await pool.query({
        name: "foundation-read-acceptance-chain-head-v1",
        text: `
          select *
          from foundation_release.read_acceptance_evidence_chain(
            $1, $2, $3, $4, $5
          )
        `,
        values: [namespace, chainId, operationId, sourceSha, bindingId],
      });
      if (result.rowCount === 0) return null;
      if (result.rowCount !== 1) {
        throw new Error("Acceptance evidence chain head is ambiguous");
      }
      const row = result.rows[0];
      if (
        row.operation_id !== operationId ||
        row.source_sha !== sourceSha ||
        row.binding_id !== bindingId ||
        !Number.isSafeInteger(Number(row.sequence)) ||
        Number(row.sequence) < 1 ||
        !/^[0-9a-f]{64}$/.test(row.head_sha) ||
        !Number.isFinite(new Date(row.updated_at).getTime())
      ) {
        throw new Error("Acceptance evidence chain head differs");
      }
      return {
        sequence: Number(row.sequence),
        head: {
          uri: `release-state://${namespace}/evidence/${row.head_sha}`,
          sha256: row.head_sha,
        },
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    },

    async close() {
      await pool.end();
    },
  };
};

export { validateConnectionBinding };
