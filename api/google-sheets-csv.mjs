import process from "node:process";

export const GOOGLE_SHEETS_REQUEST_LIMIT_BYTES = 512;
export const GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES = 5_000_000;
export const GOOGLE_SHEETS_TIMEOUT_MS = 5_000;

const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

const isValidSheetName = (value) =>
  value.length >= 1 &&
  value.length <= 100 &&
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint > 0x1f && codePoint !== 0x7f;
  });

const getHeader = (request, name) => {
  if (typeof request.headers?.get === "function") {
    return request.headers.get(name);
  }
  const headers = request.headers ?? {};
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
};

const setStatus = (response, status) => {
  if (typeof response.status === "function") response.status(status);
  else response.statusCode = status;
};

const sendEmpty = (response, status, extraHeaders = {}) => {
  setStatus(response, status);
  response.setHeader?.("Cache-Control", "no-store");
  response.setHeader?.("Content-Length", "0");
  Object.entries(extraHeaders).forEach(([name, value]) =>
    response.setHeader?.(name, value),
  );
  response.end?.();
};

const readBody = async (request) => {
  const declaredLength = Number(getHeader(request, "content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > GOOGLE_SHEETS_REQUEST_LIMIT_BYTES
  ) {
    return { oversized: true, bytes: null };
  }
  if (request.body !== undefined && request.body !== null) {
    const bytes = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(
          typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body),
          "utf8",
        );
    return {
      oversized: bytes.byteLength > GOOGLE_SHEETS_REQUEST_LIMIT_BYTES,
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
    if (length > GOOGLE_SHEETS_REQUEST_LIMIT_BYTES) {
      return { oversized: true, bytes: null };
    }
    chunks.push(bytes);
  }
  return { oversized: false, bytes: Buffer.concat(chunks, length) };
};

const normalizeOrigin = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return url.origin;
  } catch {
    return null;
  }
};

export const loadGoogleSheetsCsvConfig = (environment = process.env) => {
  const allowedOrigin = normalizeOrigin(
    environment.GOOGLE_SHEETS_CSV_ALLOWED_ORIGIN,
  );
  return allowedOrigin ? { allowedOrigin } : null;
};

const parseRequestPayload = (bytes) => {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some(
      (key) => key !== "spreadsheetId" && key !== "sheetName",
    ) ||
    !SPREADSHEET_ID_PATTERN.test(parsed.spreadsheetId)
  ) {
    return null;
  }
  if (
    parsed.sheetName !== undefined &&
    (typeof parsed.sheetName !== "string" ||
      !isValidSheetName(parsed.sheetName))
  ) {
    return null;
  }
  return {
    spreadsheetId: parsed.spreadsheetId,
    sheetName: parsed.sheetName,
  };
};

const readBoundedResponseBytes = async (response) => {
  if (typeof response.body?.getReader !== "function") {
    const error = new Error("Google Sheets response is not stream-readable");
    error.code = "UPSTREAM_STREAM_UNAVAILABLE";
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      length += chunk.byteLength;
      if (length > GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES) {
        await reader.cancel("response limit exceeded").catch(() => undefined);
        const error = new Error("Google Sheets response exceeds the limit");
        error.code = "RESPONSE_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
};

const fetchCsv = async (payload, fetchImpl) => {
  const url = new URL(
    `https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}/gviz/tq`,
  );
  url.searchParams.set("tqx", "out:csv");
  if (payload.sheetName) url.searchParams.set("sheet", payload.sheetName);
  const upstream = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "text/csv,text/plain;q=0.9",
    },
    redirect: "error",
    signal: AbortSignal.timeout(GOOGLE_SHEETS_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error("Google Sheets rejected the request");
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES
  ) {
    const error = new Error("Google Sheets response exceeds the limit");
    error.code = "RESPONSE_TOO_LARGE";
    throw error;
  }
  return readBoundedResponseBytes(upstream);
};

export const createGoogleSheetsCsvHandler = ({
  loadConfig = () => loadGoogleSheetsCsvConfig(),
  fetchImpl = fetch,
} = {}) =>
  async function googleSheetsCsvHandler(request, response) {
    if (request.method !== "POST") {
      sendEmpty(response, 405, { Allow: "POST" });
      return;
    }
    const contentType = String(getHeader(request, "content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      sendEmpty(response, 415);
      return;
    }
    const config = loadConfig();
    if (!config) {
      sendEmpty(response, 503);
      return;
    }
    if (
      normalizeOrigin(getHeader(request, "origin")) !== config.allowedOrigin
    ) {
      sendEmpty(response, 403);
      return;
    }
    const body = await readBody(request);
    if (body.oversized) {
      sendEmpty(response, 413);
      return;
    }
    if (!body.bytes?.length) {
      sendEmpty(response, 400);
      return;
    }
    const payload = parseRequestPayload(body.bytes);
    if (!payload) {
      sendEmpty(response, 400);
      return;
    }

    let csvBytes;
    try {
      csvBytes = await fetchCsv(payload, fetchImpl);
    } catch (error) {
      sendEmpty(response, error?.code === "RESPONSE_TOO_LARGE" ? 413 : 502);
      return;
    }
    setStatus(response, 200);
    response.setHeader?.("Cache-Control", "private, no-store");
    response.setHeader?.("Content-Type", "text/csv; charset=utf-8");
    response.setHeader?.("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader?.("X-Content-Type-Options", "nosniff");
    response.setHeader?.("Content-Length", String(csvBytes.byteLength));
    response.end?.(csvBytes);
  };

export default createGoogleSheetsCsvHandler();
