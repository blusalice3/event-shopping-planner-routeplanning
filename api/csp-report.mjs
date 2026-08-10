import process from "node:process";

export const CSP_REPORT_RAW_LIMIT_BYTES = 16_384;
export const CSP_REPORT_NORMALIZED_LIMIT_BYTES = 16_384;
export const CSP_REPORT_BATCH_LIMIT = 20;
export const CSP_REPORT_UPSTREAM_TIMEOUT_MS = 3_000;
export const CSP_REPORT_BLOCKED_TARGET_COLUMN = "blocked_target";
export const CSP_BLOCKED_TARGET_VALUES = Object.freeze([
  "self",
  "scheme",
  "same-site",
  "cross-site",
  "unknown",
]);
export const CSP_EFFECTIVE_DIRECTIVE_VALUES = Object.freeze([
  "base-uri",
  "child-src",
  "connect-src",
  "default-src",
  "font-src",
  "form-action",
  "frame-ancestors",
  "frame-src",
  "img-src",
  "manifest-src",
  "media-src",
  "object-src",
  "script-src",
  "script-src-attr",
  "script-src-elem",
  "style-src",
  "style-src-attr",
  "style-src-elem",
  "worker-src",
  "unknown",
]);

const ALLOWED_CONTENT_TYPES = new Set([
  "application/csp-report",
  "application/reports+json",
]);
const ALLOWED_DISPOSITIONS = new Set(["report", "enforce"]);
const ALLOWED_EFFECTIVE_DIRECTIVES = new Set(CSP_EFFECTIVE_DIRECTIVE_VALUES);
const DIRECTIVE_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const FULL_SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PROVIDER_DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getHeader = (request, name) => {
  if (typeof request.headers?.get === "function") {
    return request.headers.get(name);
  }
  const headers = request.headers ?? {};
  const matchingKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  const value = matchingKey ? headers[matchingKey] : undefined;
  return Array.isArray(value) ? value[0] : value;
};

const setResponseStatus = (response, status) => {
  if (typeof response.status === "function") {
    response.status(status);
  } else {
    response.statusCode = status;
  }
};

const sendEmpty = (response, status, extraHeaders = {}) => {
  setResponseStatus(response, status);
  response.setHeader?.("Cache-Control", "no-store");
  response.setHeader?.("Content-Length", "0");
  for (const [name, value] of Object.entries(extraHeaders)) {
    response.setHeader?.(name, value);
  }
  response.end?.();
};

const readBodyBytes = async (request, maximumBytes) => {
  const declaredLength = Number(getHeader(request, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return { oversized: true, bytes: null };
  }

  if (typeof request.body === "string") {
    const bytes = Buffer.from(request.body, "utf8");
    return {
      oversized: bytes.byteLength > maximumBytes,
      bytes,
    };
  }
  if (Buffer.isBuffer(request.body)) {
    return {
      oversized: request.body.byteLength > maximumBytes,
      bytes: request.body,
    };
  }
  if (request.body !== undefined && request.body !== null) {
    let serialized;
    try {
      serialized = JSON.stringify(request.body);
    } catch {
      return { oversized: false, bytes: null };
    }
    const bytes = Buffer.from(serialized, "utf8");
    return {
      oversized: bytes.byteLength > maximumBytes,
      bytes,
    };
  }

  if (typeof request[Symbol.asyncIterator] !== "function") {
    return { oversized: false, bytes: null };
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumBytes) {
      return { oversized: true, bytes: null };
    }
    chunks.push(bytes);
  }
  return {
    oversized: false,
    bytes: Buffer.concat(chunks, length),
  };
};

const parseOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost"
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

const siteKey = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
    normalized.includes(":")
  ) {
    return normalized;
  }
  const labels = normalized.split(".");
  return labels.length <= 2 ? normalized : labels.slice(-2).join(".");
};

export const classifyBlockedTarget = (rawValue, applicationOrigin) => {
  if (typeof rawValue !== "string") return "unknown";
  const value = rawValue.trim();
  if (value === "" || value === "null") return "unknown";
  if (value === "self" || value === "'self'") return "self";
  if (
    /^(?:inline|eval|wasm-eval|trusted-types-policy|data:|blob:|filesystem:)/i.test(
      value,
    )
  ) {
    return "scheme";
  }
  try {
    const target = new URL(value, applicationOrigin);
    const origin = new URL(applicationOrigin);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return "scheme";
    }
    if (target.origin === origin.origin) return "self";
    return siteKey(target.hostname) === siteKey(origin.hostname)
      ? "same-site"
      : "cross-site";
  } catch {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) ? "scheme" : "unknown";
  }
};

const readString = (record, ...keys) => {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
};

export const normalizeEffectiveDirective = (rawValue) => {
  if (typeof rawValue !== "string") return null;
  const firstToken = rawValue.trim().toLowerCase().split(/\s+/, 1)[0];
  if (!DIRECTIVE_PATTERN.test(firstToken)) return null;
  return ALLOWED_EFFECTIVE_DIRECTIVES.has(firstToken) ? firstToken : "unknown";
};

const normalizeSingleReport = (candidate, applicationOrigin) => {
  if (!isRecord(candidate)) return null;
  const body = isRecord(candidate["csp-report"])
    ? candidate["csp-report"]
    : isRecord(candidate.body)
      ? candidate.body
      : candidate;
  if (candidate.type !== undefined && candidate.type !== "csp-violation") {
    return null;
  }
  const effectiveDirective = normalizeEffectiveDirective(
    readString(
      body,
      "effective-directive",
      "effectiveDirective",
      "violated-directive",
      "violatedDirective",
    ),
  );
  const disposition = (
    readString(body, "disposition") ?? "report"
  ).toLowerCase();
  if (effectiveDirective === null || !ALLOWED_DISPOSITIONS.has(disposition)) {
    return null;
  }
  const blockedTarget = readString(
    body,
    "blocked-uri",
    "blockedURL",
    "blockedUrl",
  );
  return {
    schema_version: 1,
    effective_directive: effectiveDirective,
    disposition,
    [CSP_REPORT_BLOCKED_TARGET_COLUMN]: classifyBlockedTarget(
      blockedTarget,
      applicationOrigin,
    ),
  };
};

const normalizePayload = (payload, contentType, applicationOrigin) => {
  const candidates =
    contentType === "application/reports+json" ? payload : [payload];
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    candidates.length > CSP_REPORT_BATCH_LIMIT
  ) {
    return null;
  }
  const normalized = candidates.map((candidate) =>
    normalizeSingleReport(candidate, applicationOrigin),
  );
  return normalized.every(Boolean) ? normalized : null;
};

export const loadCspReportConfig = (environment = process.env) => {
  const dbUrl = parseOrigin(environment.CSP_REPORT_DB_URL);
  const publicOrigin = parseOrigin(environment.CSP_REPORT_PUBLIC_ORIGIN);
  const credential = environment.CSP_REPORT_DB_SERVICE_ROLE_KEY?.trim();
  const sourceSha = environment.CSP_REPORT_SOURCE_SHA?.trim().toLowerCase();
  const providerDeploymentId =
    environment.CSP_REPORT_PROVIDER_DEPLOYMENT_ID?.trim();
  if (
    !dbUrl ||
    !publicOrigin ||
    !credential ||
    !FULL_SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !PROVIDER_DEPLOYMENT_ID_PATTERN.test(providerDeploymentId ?? "")
  ) {
    return null;
  }
  return {
    dbUrl,
    publicOrigin,
    credential,
    sourceSha,
    providerDeploymentId,
  };
};

const insertWithFetch = async (records, config, fetchImpl = fetch) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CSP_REPORT_UPSTREAM_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(
      `${config.dbUrl}/rest/v1/csp_violation_reports`,
      {
        method: "POST",
        headers: {
          apikey: config.credential,
          Authorization: `Bearer ${config.credential}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(records),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error("CSP report upstream rejected the insert.");
    }
  } finally {
    clearTimeout(timeout);
  }
};

export const createCspReportHandler = ({
  loadConfig = () => loadCspReportConfig(),
  insert = insertWithFetch,
} = {}) =>
  async function cspReportHandler(request, response) {
    if (request.method !== "POST") {
      sendEmpty(response, 405, { Allow: "POST" });
      return;
    }

    const contentType = String(getHeader(request, "content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      sendEmpty(response, 415);
      return;
    }

    const body = await readBodyBytes(request, CSP_REPORT_RAW_LIMIT_BYTES);
    if (body.oversized) {
      sendEmpty(response, 413);
      return;
    }
    if (!body.bytes || body.bytes.byteLength === 0) {
      sendEmpty(response, 400);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.bytes.toString("utf8"));
    } catch {
      sendEmpty(response, 400);
      return;
    }

    const config = loadConfig();
    if (!config) {
      sendEmpty(response, 503);
      return;
    }
    const normalized = normalizePayload(
      payload,
      contentType,
      config.publicOrigin,
    );
    if (!normalized) {
      sendEmpty(response, 400);
      return;
    }
    const records = normalized.map((record) => ({
      ...record,
      source_sha: config.sourceSha,
      provider_deployment_id: config.providerDeploymentId,
    }));
    if (
      Buffer.byteLength(JSON.stringify(records), "utf8") >
      CSP_REPORT_NORMALIZED_LIMIT_BYTES
    ) {
      sendEmpty(response, 413);
      return;
    }

    try {
      await insert(records, config);
    } catch {
      sendEmpty(response, 502);
      return;
    }
    sendEmpty(response, 204);
  };

export default createCspReportHandler();
