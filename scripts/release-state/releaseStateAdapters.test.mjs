import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import test from "node:test";
import {
  assertRequiredApprovalSet,
  resolveApprovalReference,
} from "./approvalResolver.mjs";
import { putEvidenceObject, releaseEvidenceUri } from "./evidenceStore.mjs";
import {
  createPostgresReleaseStateStore,
  validateConnectionBinding,
} from "./postgresStore.mjs";
import { fetchGitHubProtectedEnvironmentApprovals } from "./githubApprovalReceipt.mjs";
import { verifyGitHubOidcToken } from "./githubOidc.mjs";
import { sha256Bytes } from "../lib/canonical-json.mjs";

const sha = (character) => character.repeat(64);
const namespace = "foundation-test";
const ca = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
const storePolicy = {
  bindingStatus: "configured",
  blockerCodes: [],
  allowedHosts: ["release-state.example.test"],
  allowedDatabases: ["foundation"],
  allowedExecutorRoles: ["release_executor"],
  connectTimeoutMilliseconds: 5000,
  statementTimeoutMilliseconds: 15000,
  productionCaSha256: sha256Bytes(Buffer.from(ca, "utf8")),
};
const connectionString =
  "postgresql://release_executor:secret@release-state.example.test/foundation?sslmode=verify-full";

test("rejects Release State connection drift and a mismatched CA", async () => {
  assert.deepEqual(
    validateConnectionBinding(connectionString, storePolicy).database,
    "foundation",
  );
  assert.throws(
    () =>
      validateConnectionBinding(
        `${connectionString}&application_name=unreviewed`,
        storePolicy,
      ),
    /sslmode=verify-full/,
  );
  assert.throws(
    () =>
      validateConnectionBinding(
        `${connectionString}&sslmode=verify-full`,
        storePolicy,
      ),
    /sslmode=verify-full/,
  );
  await assert.rejects(
    createPostgresReleaseStateStore({
      connectionString,
      namespace,
      policy: storePolicy,
      ca: `${ca}tampered`,
    }),
    /CA fingerprint differs/,
  );
});

const approvalPolicy = {
  bindingStatus: "configured",
  blockerCodes: [],
  trustedIssuer: "https://token.actions.githubusercontent.com",
  oidcAudience: "urn:event-shopping-planner:foundation-release-state",
  oidcClockSkewSeconds: 60,
  oidcMaxTokenAgeSeconds: 600,
  repository: "blusalice3/event-shopping-planner-routeplanning",
  workflowRef:
    "blusalice3/event-shopping-planner-routeplanning/.github/workflows/release.yml@refs/heads/main",
  protectedEnvironment: "foundation-release-state",
  roles: {
    releaseOwner: { reviewerTeam: "team-release" },
    dataSafetyReviewer: { reviewerTeam: "team-data" },
    operationsReviewer: { reviewerTeam: "team-operations" },
  },
};
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const nowMs = Date.parse("2026-08-01T00:05:00.000Z");
const oidcClaims = {
  iss: approvalPolicy.trustedIssuer,
  aud: approvalPolicy.oidcAudience,
  sub: `repo:${approvalPolicy.repository}:environment:${approvalPolicy.protectedEnvironment}`,
  repository: approvalPolicy.repository,
  workflow_ref: approvalPolicy.workflowRef,
  workflow_sha: sourceSha,
  environment: approvalPolicy.protectedEnvironment,
  run_id: "12345",
  run_attempt: "1",
  sha: sourceSha,
  event_name: "workflow_dispatch",
  ref: "refs/heads/main",
  ref_protected: "true",
  jti: "oidc-jti-fixture",
  iat: Math.floor(nowMs / 1000) - 60,
  nbf: Math.floor(nowMs / 1000) - 60,
  exp: Math.floor(nowMs / 1000) + 540,
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "fixture-key",
  key_ops: ["verify"],
  use: "sig",
};
const discovery = {
  issuer: approvalPolicy.trustedIssuer,
  jwks_uri: "https://token.actions.githubusercontent.com/.well-known/jwks",
  id_token_signing_alg_values_supported: ["RS256"],
};
const jwks = { keys: [publicJwk] };
const jwtForClaims = (claims) => {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = signBytes(
    "RSA-SHA256",
    Buffer.from(signingInput, "ascii"),
    privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
};
const verifiedOidcForClaims = (claims = oidcClaims) =>
  verifyGitHubOidcToken({
    token: jwtForClaims(claims),
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: oidcClaims.run_id,
    discovery,
    jwks,
    nowMs,
  });
const operationId = "promote-standard-fixture";
const subjectSha256 = sha("a");
const githubApiResponse = (url, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    url,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-length") {
          return String(bytes.length);
        }
        if (name.toLowerCase() === "date") {
          return new Date(nowMs).toUTCString();
        }
        return null;
      },
    },
    async arrayBuffer() {
      return bytes;
    },
  };
};
const githubApprovalFetch = async (input) => {
  const url = String(input);
  if (url.endsWith(`/actions/runs/${oidcClaims.run_id}/approvals`)) {
    return githubApiResponse(url, 200, [
      {
        state: "approved",
        comment: "fixture approval",
        environments: [
          {
            id: 101,
            name: approvalPolicy.protectedEnvironment,
          },
        ],
        user: {
          id: 201,
          login: "release-reviewer",
          node_id: "fixture-reviewer-node",
        },
      },
    ]);
  }
  if (url.includes("/teams/team-release/memberships/release-reviewer")) {
    return githubApiResponse(url, 200, {
      state: "active",
      role: "member",
    });
  }
  return githubApiResponse(url, 404, {
    message: "Not Found",
  });
};
const [verifiedApprovalResult] = await fetchGitHubProtectedEnvironmentApprovals(
  {
    policy: approvalPolicy,
    githubToken: "github-token-fixture-value",
    operationId,
    subjectSha256,
    expectedRunId: oidcClaims.run_id,
    fetchImpl: githubApprovalFetch,
  },
);
const resolveFixtureApproval = (
  candidateClaims = oidcClaims,
  candidateApproval = verifiedApprovalResult,
) => {
  const receiptSha256 = sha256Bytes(candidateApproval.receiptBytes);
  const verifiedOidcResult = verifiedOidcForClaims(candidateClaims);
  const issuerReceiptSha256 = sha256Bytes(verifiedOidcResult.receiptBytes);
  return resolveApprovalReference({
    policy: approvalPolicy,
    receiptReference: {
      uri: `release-state://${namespace}/evidence/${receiptSha256}`,
      sha256: receiptSha256,
    },
    issuerReceiptReference: {
      uri: `release-state://${namespace}/evidence/${issuerReceiptSha256}`,
      sha256: issuerReceiptSha256,
    },
    verifiedApprovalResult: candidateApproval,
    verifiedOidcResult,
    operationId,
    subjectSha256,
  });
};

test("derives approval role from exact authoritative workflow/team bindings", () => {
  const reference = resolveFixtureApproval();
  assert.equal(reference.role, "releaseOwner");
  assert.equal(reference.workflowRunId, oidcClaims.run_id);

  assert.throws(
    () =>
      resolveFixtureApproval({
        ...oidcClaims,
        workflow_ref: `attacker/${oidcClaims.workflow_ref}/suffix`,
      }),
    /protected release job/,
  );
});

test("rejects forged, expired, or signature-tampered OIDC evidence", () => {
  const receiptSha256 = sha256Bytes(verifiedApprovalResult.receiptBytes);
  assert.throws(
    () =>
      resolveApprovalReference({
        policy: approvalPolicy,
        receiptReference: {
          uri: `release-state://${namespace}/evidence/${receiptSha256}`,
          sha256: receiptSha256,
        },
        issuerReceiptReference: {
          uri: `release-state://${namespace}/evidence/${sha("b")}`,
          sha256: sha("b"),
        },
        verifiedApprovalResult,
        verifiedOidcResult: {
          receipt: {},
          receiptBytes: Buffer.from("{}"),
        },
        operationId,
        subjectSha256,
      }),
    /not cryptographically verified/,
  );
  assert.throws(
    () =>
      verifiedOidcForClaims({
        ...oidcClaims,
        exp: Math.floor(nowMs / 1000) - 120,
      }),
    /expired or outside/,
  );
  const validToken = jwtForClaims(oidcClaims);
  const [header, payload, signature] = validToken.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...oidcClaims, repository: "attacker/repository" }),
  ).toString("base64url");
  assert.throws(
    () =>
      verifyGitHubOidcToken({
        token: `${header}.${tamperedPayload}.${signature}`,
        policy: approvalPolicy,
        expectedSourceSha: sourceSha,
        expectedRunId: oidcClaims.run_id,
        discovery,
        jwks,
        nowMs,
      }),
    /signature is invalid/,
  );
  assert.ok(payload.length > 0);
});

test("requires exactly one authoritative reviewer-team membership", async () => {
  await assert.rejects(
    fetchGitHubProtectedEnvironmentApprovals({
      policy: approvalPolicy,
      githubToken: "github-token-fixture-value",
      operationId,
      subjectSha256,
      expectedRunId: oidcClaims.run_id,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith(`/actions/runs/${oidcClaims.run_id}/approvals`)) {
          return githubApprovalFetch(url);
        }
        return githubApiResponse(url, 200, {
          state: "active",
          role: "member",
        });
      },
    }),
    /exactly one configured approval team/,
  );
});

test("requires an exact, distinct approval role set", () => {
  const base = {
    approvalId: "approval-1",
    providerReviewerId: "reviewer-1",
    role: "releaseOwner",
    decision: "APPROVED",
    approvedAt: "2026-08-01T00:00:00.000Z",
  };
  assert.throws(
    () =>
      assertRequiredApprovalSet(
        [
          base,
          {
            ...base,
            approvalId: "approval-2",
            providerReviewerId: "reviewer-2",
          },
        ],
        ["releaseOwner"],
      ),
    /exactly the required roles/,
  );
});

test("validates immutable evidence input and receipt bindings", async () => {
  const bytes = Buffer.from("evidence");
  const expectedHash = sha256Bytes(bytes);
  const client = {
    async query() {
      return {
        rowCount: 1,
        rows: [
          {
            namespace,
            sha256: expectedHash,
            media_type: "application/json",
            byte_length: bytes.length,
            committed_at: "2026-08-01T00:00:00.000Z",
            replayed: false,
          },
        ],
      };
    },
  };
  const stored = await putEvidenceObject({
    client,
    namespace,
    bytes,
    mediaType: "application/json",
  });
  assert.equal(
    stored.uri,
    `release-state://${namespace}/evidence/${expectedHash}`,
  );
  assert.throws(
    () => releaseEvidenceUri("../escape", expectedHash),
    /namespace is invalid/,
  );
});
