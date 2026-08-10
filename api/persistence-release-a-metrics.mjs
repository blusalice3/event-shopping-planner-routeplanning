const MAX_REQUEST_BYTES = 1_024;
const METRICS_TABLE = "persistence_release_a_metric_events";
const UPSTREAM_TIMEOUT_MS = 5_000;
const FULL_SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const FORBIDDEN_ENVIRONMENT_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PERSISTENCE_METRICS_ALLOW_GENERIC_FALLBACK",
];

const CHECKPOINT_OUTCOMES = new Set([
  "adopted",
  "already-absorbed",
  "not-needed",
  "failed",
  "conflict",
]);
const REPAIR_OUTCOMES = new Set(["succeeded", "failed", "conflict"]);
const LOAD_OUTCOMES = new Set(["succeeded", "missing", "failed", "conflict"]);
const SAVE_OUTCOMES = new Set(["succeeded", "failed"]);
const STARTUP_OUTCOMES = new Set(["ready", "recovery-required"]);
const STARTUP_DURATION_BUCKETS = new Set([
  "lt-250ms",
  "250-999ms",
  "1-2999ms",
  "3-9999ms",
  "gte-10s",
]);
const CLEANUP_NO_REASON_OUTCOMES = new Set([
  "attempted",
  "task-started",
  "completed",
  "key-confirmed-removed",
]);
const CLEANUP_DEFERRED_REASONS = new Set([
  "runtime-kill-switch-unknown",
  "web-locks-unsupported",
  "exclusive-lock-unavailable",
  "exclusive-lock-not-proven",
  "exclusive-lock-request-failed",
  "service-worker-state-unknown",
  "service-worker-unsupported",
  "service-worker-registration-missing",
  "service-worker-not-active",
  "service-worker-update-waiting",
  "service-worker-version-unconfigured",
  "service-worker-version-unknown",
  "service-worker-version-mismatch",
  "supported-client-version-unconfigured",
  "client-handshake-unknown",
  "client-version-unknown",
  "unsupported-client-version",
  "unresponsive-client",
  "client-quiescence-unknown",
  "client-not-quiescent",
]);
const CLEANUP_BLOCKED_REASONS = new Set([
  "feature-flag-disabled",
  "runtime-kill-switch-active",
  "manual-other-tabs-not-confirmed",
  "cleanup-task-failed",
  "exclusive-lock-lifecycle-failed",
]);
const CLEANUP_PHYSICAL_DEFERRED_REASONS = new Set([
  ...CLEANUP_DEFERRED_REASONS,
  "cleanup-not-ready",
  "migration-journal-cas-failed",
  "legacy-source-remove-failed",
  "legacy-source-missing-after-claim",
]);
const CLEANUP_PHYSICAL_BLOCKED_REASONS = new Set([
  ...CLEANUP_BLOCKED_REASONS,
  "migration-journal-invalid",
  "migration-archive-invalid",
  "committed-target-invalid",
  "legacy-storage-unavailable",
  "legacy-source-changed",
  "legacy-source-reappeared",
  "legacy-source-missing-before-claim",
  "legacy-source-digest-mismatch",
]);
const BROWSER_FAMILIES = new Set(["chromium", "firefox", "safari", "other"]);
const APP_MODES = new Set(["browser-tab", "installed-pwa"]);

class RequestTooLargeError extends Error {}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
};

const validateEvent = (event) => {
  if (!isRecord(event) || event.version !== 1) return false;
  if (typeof event.name !== "string" || typeof event.outcome !== "string") {
    return false;
  }

  switch (event.name) {
    case "checkpoint-adoption":
      return (
        hasExactKeys(event, ["version", "name", "outcome"]) &&
        CHECKPOINT_OUTCOMES.has(event.outcome)
      );
    case "fallback-repair":
      return (
        hasExactKeys(event, ["version", "name", "outcome"]) &&
        REPAIR_OUTCOMES.has(event.outcome)
      );
    case "load":
      return (
        hasExactKeys(event, ["version", "name", "outcome"]) &&
        LOAD_OUTCOMES.has(event.outcome)
      );
    case "save":
      return (
        hasExactKeys(event, ["version", "name", "outcome"]) &&
        SAVE_OUTCOMES.has(event.outcome)
      );
    case "startup":
      return (
        hasExactKeys(event, ["version", "name", "outcome", "durationBucket"]) &&
        STARTUP_OUTCOMES.has(event.outcome) &&
        STARTUP_DURATION_BUCKETS.has(event.durationBucket)
      );
    case "cleanup": {
      if (
        typeof event.mode !== "string" ||
        (event.mode !== "auto" && event.mode !== "manual")
      ) {
        return false;
      }
      if (CLEANUP_NO_REASON_OUTCOMES.has(event.outcome)) {
        return (
          hasExactKeys(event, ["version", "name", "outcome", "mode"]) &&
          typeof event.mode === "string"
        );
      }
      if (
        !hasExactKeys(event, [
          "version",
          "name",
          "outcome",
          "mode",
          "reason",
        ]) ||
        typeof event.reason !== "string"
      ) {
        return false;
      }
      if (event.outcome === "deferred") {
        return CLEANUP_DEFERRED_REASONS.has(event.reason);
      }
      if (event.outcome === "blocked") {
        return CLEANUP_BLOCKED_REASONS.has(event.reason);
      }
      if (event.outcome === "physical-deferred") {
        return CLEANUP_PHYSICAL_DEFERRED_REASONS.has(event.reason);
      }
      return (
        event.outcome === "physical-blocked" &&
        CLEANUP_PHYSICAL_BLOCKED_REASONS.has(event.reason)
      );
    }
    default:
      return false;
  }
};

export const validatePersistenceReleaseAMetricsRequest = (value) =>
  hasExactKeys(value, [
    "schemaVersion",
    "event",
    "buildId",
    "browserFamily",
    "appMode",
    "online",
  ]) &&
  value.schemaVersion === 1 &&
  validateEvent(value.event) &&
  typeof value.buildId === "string" &&
  (value.buildId === "unknown-source" ||
    /^[0-9a-f]{7,64}$/.test(value.buildId)) &&
  BROWSER_FAMILIES.has(value.browserFamily) &&
  APP_MODES.has(value.appMode) &&
  typeof value.online === "boolean";

const firstHeaderValue = (value) => (Array.isArray(value) ? value[0] : value);

const readHeader = (request, name) => {
  if (typeof request.headers?.get === "function") {
    return request.headers.get(name);
  }
  return firstHeaderValue(
    request.headers?.[name] ?? request.headers?.[name.toLowerCase()],
  );
};

const isSameOriginRequest = (request, allowedOrigin) => {
  const originHeader = readHeader(request, "origin");
  const fetchSite = readHeader(request, "sec-fetch-site");
  if (typeof originHeader !== "string" || fetchSite !== "same-origin") {
    return false;
  }

  const forwardedHost = firstHeaderValue(
    readHeader(request, "x-forwarded-host"),
  );
  const directHost = firstHeaderValue(readHeader(request, "host"));
  const requestHost =
    typeof forwardedHost === "string" && forwardedHost.length > 0
      ? forwardedHost.split(",")[0].trim()
      : typeof directHost === "string"
        ? directHost.trim()
        : "";
  const forwardedProtocol = firstHeaderValue(
    readHeader(request, "x-forwarded-proto"),
  );
  const requestProtocol =
    typeof forwardedProtocol === "string" && forwardedProtocol.length > 0
      ? forwardedProtocol.split(",")[0].trim()
      : request.socket?.encrypted
        ? "https"
        : "http";

  try {
    const origin = new URL(originHeader);
    const requestOrigin = new URL(
      `${requestProtocol}://${requestHost.toLowerCase()}`,
    ).origin;
    return (
      (requestProtocol === "https" || requestProtocol === "http") &&
      origin.origin === requestOrigin &&
      origin.origin === allowedOrigin
    );
  } catch {
    return false;
  }
};

const parseContentLength = (request) => {
  const rawLength = readHeader(request, "content-length");
  if (rawLength === undefined || rawLength === null) return null;
  if (typeof rawLength !== "string" || !/^\d+$/.test(rawLength)) return NaN;
  return Number(rawLength);
};

const parseJsonText = (text) => {
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }
  return JSON.parse(text);
};

const decodeJsonBytes = (bytes) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const readJsonBody = async (request) => {
  const declaredLength = parseContentLength(request);
  if (
    Number.isNaN(declaredLength) ||
    (declaredLength !== null && declaredLength > MAX_REQUEST_BYTES)
  ) {
    throw new RequestTooLargeError();
  }

  if (request.body !== undefined && request.body !== null) {
    if (Buffer.isBuffer(request.body)) {
      return parseJsonText(decodeJsonBytes(request.body));
    }
    if (typeof request.body === "string") {
      return parseJsonText(request.body);
    }
    const serialized = JSON.stringify(request.body);
    if (serialized === undefined) throw new SyntaxError("Invalid JSON body");
    if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
      throw new RequestTooLargeError();
    }
    return request.body;
  }

  if (typeof request[Symbol.asyncIterator] !== "function") {
    throw new SyntaxError("Missing JSON body");
  }
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > MAX_REQUEST_BYTES) {
      throw new RequestTooLargeError();
    }
    chunks.push(buffer);
  }
  return parseJsonText(decodeJsonBytes(Buffer.concat(chunks)));
};

const sendJson = (response, statusCode, body) => {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
};

const isSecureServiceUrl = (url) =>
  url.protocol === "https:" ||
  (url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"));

const getAllowedOrigin = () => {
  const configured = process.env.PERSISTENCE_METRICS_ALLOWED_ORIGIN;
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (!isSecureServiceUrl(parsed) || parsed.origin !== configured) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const normalizeVercelHostname = (value) => {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = value.includes("://")
      ? new URL(value)
      : new URL(`https://${value}`);
    if (
      parsed.protocol !== "https:" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
};

const getSourceHardenedConfiguration = () => {
  if (
    FORBIDDEN_ENVIRONMENT_NAMES.some(
      (name) =>
        typeof process.env[name] === "string" && process.env[name] !== "",
    )
  ) {
    return null;
  }

  const url = process.env.PERSISTENCE_METRICS_SUPABASE_URL;
  const serviceRoleKey =
    process.env.PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY;
  const expectedProjectRef =
    process.env.PERSISTENCE_METRICS_EXPECTED_PROJECT_REF;
  const expectedProviderProjectId =
    process.env.PERSISTENCE_METRICS_EXPECTED_PROVIDER_PROJECT_ID;
  const providerProjectId = process.env.VERCEL_PROJECT_ID;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  const productionHostname = normalizeVercelHostname(
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  );
  const deploymentHostname = normalizeVercelHostname(process.env.VERCEL_URL);
  const allowedOrigin = getAllowedOrigin();
  if (
    !url ||
    !serviceRoleKey ||
    !expectedProjectRef ||
    !expectedProviderProjectId ||
    !providerProjectId ||
    !deploymentId ||
    !productionHostname ||
    !deploymentHostname ||
    !allowedOrigin ||
    expectedProviderProjectId !== providerProjectId
  ) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (
      !isSecureServiceUrl(parsed) ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    const expectedSupabaseHostname =
      `${expectedProjectRef}.supabase.co`.toLowerCase();
    if (parsed.hostname.toLowerCase() !== expectedSupabaseHostname) {
      return null;
    }
    if (new URL(allowedOrigin).hostname.toLowerCase() !== productionHostname) {
      return null;
    }
    return {
      url: parsed,
      serviceRoleKey,
      allowedOrigin,
      deploymentId,
      deploymentHostname,
      providerProjectId,
    };
  } catch {
    return null;
  }
};

export const toDatabaseRow = (request) => ({
  schema_version: request.schemaVersion,
  event_version: request.event.version,
  event_name: request.event.name,
  outcome: request.event.outcome,
  duration_bucket:
    request.event.name === "startup" ? request.event.durationBucket : null,
  cleanup_mode: request.event.name === "cleanup" ? request.event.mode : null,
  cleanup_reason:
    request.event.name === "cleanup" && "reason" in request.event
      ? request.event.reason
      : null,
  build_id: request.buildId,
  browser_family: request.browserFamily,
  app_mode: request.appMode,
  online: request.online,
});

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "method-not-allowed" });
    return;
  }
  const configuration = getSourceHardenedConfiguration();
  if (configuration === null || typeof fetch !== "function") {
    sendJson(response, 503, { error: "metrics-backend-unavailable" });
    return;
  }
  if (!isSameOriginRequest(request, configuration.allowedOrigin)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  const contentType = readHeader(request, "content-type");
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    sendJson(response, 415, { error: "unsupported-media-type" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error instanceof RequestTooLargeError ? 413 : 400, {
      error:
        error instanceof RequestTooLargeError
          ? "request-too-large"
          : "invalid-json",
    });
    return;
  }
  if (!validatePersistenceReleaseAMetricsRequest(body)) {
    sendJson(response, 400, { error: "invalid-schema" });
    return;
  }
  if (!FULL_SOURCE_SHA_PATTERN.test(body.buildId)) {
    sendJson(response, 400, { error: "invalid-schema" });
    return;
  }

  const insertUrl = new URL(`/rest/v1/${METRICS_TABLE}`, configuration.url);
  let insertResponse;
  try {
    insertResponse = await fetch(insertUrl, {
      method: "POST",
      headers: {
        apikey: configuration.serviceRoleKey,
        authorization: `Bearer ${configuration.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(toDatabaseRow(body)),
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    sendJson(response, 502, { error: "metrics-insert-failed" });
    return;
  }
  if (!insertResponse.ok) {
    sendJson(response, 502, { error: "metrics-insert-failed" });
    return;
  }

  sendJson(response, 202, { accepted: true });
}
