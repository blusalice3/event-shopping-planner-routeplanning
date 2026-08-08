import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";

export const GITHUB_OIDC_DISCOVERY_URL =
  "https://token.actions.githubusercontent.com/.well-known/openid-configuration";
export const GITHUB_OIDC_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

const verifiedResults = new WeakSet();
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_JWKS_BYTES = 512 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]*$/;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
};

const decodeBase64UrlJson = (segment, label) => {
  if (!BASE64URL.test(segment)) {
    throw new Error(`${label} is not canonical base64url`);
  }
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return parseJsonStrict(bytes.toString("utf8"), label);
};

const assertPolicy = (policy) => {
  if (
    !isRecord(policy) ||
    policy.trustedIssuer !== "https://token.actions.githubusercontent.com" ||
    typeof policy.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository) ||
    typeof policy.workflowRef !== "string" ||
    !policy.workflowRef.endsWith(
      "/.github/workflows/release.yml@refs/heads/main",
    ) ||
    typeof policy.protectedEnvironment !== "string" ||
    policy.protectedEnvironment.length === 0 ||
    typeof policy.oidcAudience !== "string" ||
    policy.oidcAudience.length === 0 ||
    !Number.isSafeInteger(policy.oidcClockSkewSeconds) ||
    policy.oidcClockSkewSeconds < 0 ||
    policy.oidcClockSkewSeconds > 300 ||
    !Number.isSafeInteger(policy.oidcMaxTokenAgeSeconds) ||
    policy.oidcMaxTokenAgeSeconds < 60 ||
    policy.oidcMaxTokenAgeSeconds > 900
  ) {
    throw new Error("Approval OIDC policy is invalid");
  }
};

const assertIssuerMetadata = (discovery) => {
  if (
    !isRecord(discovery) ||
    discovery.issuer !== "https://token.actions.githubusercontent.com" ||
    discovery.jwks_uri !== GITHUB_OIDC_JWKS_URL ||
    !Array.isArray(discovery.id_token_signing_alg_values_supported) ||
    discovery.id_token_signing_alg_values_supported.length !== 1 ||
    discovery.id_token_signing_alg_values_supported[0] !== "RS256"
  ) {
    throw new Error("GitHub OIDC discovery metadata differs");
  }
};

const selectVerificationKey = (jwks, kid) => {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) {
    throw new Error("GitHub OIDC JWKS is invalid");
  }
  const candidates = jwks.keys.filter((key) => key?.kid === kid);
  if (candidates.length !== 1) {
    throw new Error("GitHub OIDC signing key is missing or ambiguous");
  }
  const [key] = candidates;
  if (
    !isRecord(key) ||
    key.kty !== "RSA" ||
    key.alg !== "RS256" ||
    key.use !== "sig" ||
    typeof key.n !== "string" ||
    !BASE64URL.test(key.n) ||
    typeof key.e !== "string" ||
    !BASE64URL.test(key.e) ||
    key.d !== undefined ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) ||
        key.key_ops.length !== 1 ||
        key.key_ops[0] !== "verify"))
  ) {
    throw new Error("GitHub OIDC signing key is not an RS256 verification key");
  }
  return key;
};

const expectedSubject = (policy) =>
  `repo:${policy.repository}:environment:${policy.protectedEnvironment.replaceAll(
    ":",
    "%3A",
  )}`;

const assertClaims = ({
  claims,
  policy,
  expectedSourceSha,
  expectedRunId,
  nowMs,
}) => {
  if (!isRecord(claims)) {
    throw new Error("GitHub OIDC claims are invalid");
  }
  for (const claim of [
    "iss",
    "aud",
    "sub",
    "jti",
    "repository",
    "workflow_ref",
    "workflow_sha",
    "environment",
    "run_id",
    "run_attempt",
    "sha",
    "event_name",
    "ref",
  ]) {
    requireNonEmptyString(claims[claim], `GitHub OIDC claim ${claim}`);
  }
  if (
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.nbf)
  ) {
    throw new Error("GitHub OIDC time claims are invalid");
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const skew = policy.oidcClockSkewSeconds;
  if (
    claims.iss !== policy.trustedIssuer ||
    claims.aud !== policy.oidcAudience ||
    claims.sub !== expectedSubject(policy) ||
    claims.repository !== policy.repository ||
    claims.workflow_ref !== policy.workflowRef ||
    claims.environment !== policy.protectedEnvironment ||
    claims.event_name !== "workflow_dispatch" ||
    claims.ref !== "refs/heads/main" ||
    ![true, "true"].includes(claims.ref_protected) ||
    claims.sha !== expectedSourceSha ||
    claims.workflow_sha !== expectedSourceSha ||
    claims.run_id !== expectedRunId ||
    !RUN_ID.test(claims.run_id) ||
    !RUN_ID.test(claims.run_attempt)
  ) {
    throw new Error("GitHub OIDC claims differ from the protected release job");
  }
  if (
    claims.exp <= nowSeconds - skew ||
    claims.nbf > nowSeconds + skew ||
    claims.iat > nowSeconds + skew ||
    claims.iat < nowSeconds - policy.oidcMaxTokenAgeSeconds - skew ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > policy.oidcMaxTokenAgeSeconds + 2 * skew
  ) {
    throw new Error(
      "GitHub OIDC token is expired or outside its allowed window",
    );
  }
};

export const verifyGitHubOidcToken = ({
  token,
  policy,
  expectedSourceSha,
  expectedRunId,
  discovery,
  jwks,
  nowMs = Date.now(),
}) => {
  assertPolicy(policy);
  assertIssuerMetadata(discovery);
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
  ) {
    throw new Error("GitHub OIDC token is missing or oversized");
  }
  if (!SOURCE_SHA.test(expectedSourceSha) || !RUN_ID.test(expectedRunId)) {
    throw new Error("Expected release source or workflow run is invalid");
  }
  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new Error("GitHub OIDC token is not a compact JWS");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  const header = decodeBase64UrlJson(encodedHeader, "GitHub OIDC header");
  const claims = decodeBase64UrlJson(encodedClaims, "GitHub OIDC claims");
  if (
    !isRecord(header) ||
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    typeof header.kid !== "string" ||
    header.kid.length === 0 ||
    header.jku !== undefined ||
    header.x5u !== undefined ||
    !BASE64URL.test(encodedSignature)
  ) {
    throw new Error("GitHub OIDC JOSE header is invalid");
  }
  const key = selectVerificationKey(jwks, header.kid);
  const signingInput = Buffer.from(
    `${encodedHeader}.${encodedClaims}`,
    "ascii",
  );
  const signature = Buffer.from(encodedSignature, "base64url");
  if (
    signature.length === 0 ||
    !verifySignature(
      "RSA-SHA256",
      signingInput,
      createPublicKey({ key, format: "jwk" }),
      signature,
    )
  ) {
    throw new Error("GitHub OIDC signature is invalid");
  }
  assertClaims({
    claims,
    policy,
    expectedSourceSha,
    expectedRunId,
    nowMs,
  });

  const receipt = {
    schemaVersion: 1,
    kind: "github-actions-oidc-verification/v1",
    issuer: claims.iss,
    audience: claims.aud,
    subject: claims.sub,
    tokenSha256: sha256Bytes(Buffer.from(token, "ascii")),
    signingKey: {
      kid: header.kid,
      jwkThumbprintSha256: sha256Json({
        e: key.e,
        kty: key.kty,
        n: key.n,
      }),
    },
    claims: {
      repository: claims.repository,
      workflowRef: claims.workflow_ref,
      workflowSha: claims.workflow_sha,
      environment: claims.environment,
      runId: claims.run_id,
      runAttempt: claims.run_attempt,
      sourceSha: claims.sha,
      eventName: claims.event_name,
      ref: claims.ref,
      refProtected: true,
      jti: claims.jti,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      notBefore: new Date(claims.nbf * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    },
    verifiedAt: new Date(nowMs).toISOString(),
  };
  const result = {
    receipt,
    receiptBytes: canonicalJsonBytes(receipt),
  };
  verifiedResults.add(result);
  return result;
};

const readBoundedJsonResponse = async (response, maximumBytes, label) => {
  if (
    !response ||
    response.status !== 200 ||
    typeof response.arrayBuffer !== "function"
  ) {
    throw new Error(`${label} request failed`);
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`${label} response is oversized`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new Error(`${label} response is empty or oversized`);
  }
  return parseJsonStrict(bytes.toString("utf8"), label);
};

const fetchExactJson = async ({
  url,
  maximumBytes,
  label,
  fetchImpl,
  headers,
}) => {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.url && response.url !== url) {
    throw new Error(`${label} response URL differs`);
  }
  return readBoundedJsonResponse(response, maximumBytes, label);
};

export const fetchGitHubOidcIssuerDocuments = async ({
  fetchImpl = fetch,
} = {}) => {
  const discovery = await fetchExactJson({
    url: GITHUB_OIDC_DISCOVERY_URL,
    maximumBytes: MAX_DISCOVERY_BYTES,
    label: "GitHub OIDC discovery",
    fetchImpl,
  });
  assertIssuerMetadata(discovery);
  const jwks = await fetchExactJson({
    url: GITHUB_OIDC_JWKS_URL,
    maximumBytes: MAX_JWKS_BYTES,
    label: "GitHub OIDC JWKS",
    fetchImpl,
  });
  return { discovery, jwks };
};

export const requestGitHubOidcToken = async ({
  requestUrl,
  requestToken,
  audience,
  fetchImpl = fetch,
}) => {
  if (
    typeof requestUrl !== "string" ||
    typeof requestToken !== "string" ||
    requestToken.length < 20 ||
    typeof audience !== "string" ||
    audience.length === 0
  ) {
    throw new Error("GitHub Actions OIDC request binding is missing");
  }
  const url = new URL(requestUrl);
  if (
    url.protocol !== "https:" ||
    !(
      url.hostname === "token.actions.githubusercontent.com" ||
      url.hostname.endsWith(".actions.githubusercontent.com")
    ) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("GitHub Actions OIDC request URL is not trusted");
  }
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const value = await readBoundedJsonResponse(
    response,
    MAX_TOKEN_BYTES * 2,
    "GitHub Actions OIDC token",
  );
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.value !== "string"
  ) {
    throw new Error("GitHub Actions OIDC token response is invalid");
  }
  return value.value;
};

export const verifyGitHubOidcTokenFromIssuer = async ({
  token,
  policy,
  expectedSourceSha,
  expectedRunId,
  nowMs = Date.now(),
  fetchImpl = fetch,
}) => {
  const { discovery, jwks } = await fetchGitHubOidcIssuerDocuments({
    fetchImpl,
  });
  return verifyGitHubOidcToken({
    token,
    policy,
    expectedSourceSha,
    expectedRunId,
    discovery,
    jwks,
    nowMs,
  });
};

export const assertVerifiedGitHubOidcResult = (result) => {
  if (!isRecord(result) || !verifiedResults.has(result)) {
    throw new Error("Approval OIDC result was not cryptographically verified");
  }
  return result;
};
