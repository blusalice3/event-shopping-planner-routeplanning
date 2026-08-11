import process from "node:process";

export const GOOGLE_SHEETS_REQUEST_LIMIT_BYTES = 512;
export const GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES = 5_000_000;
export const GOOGLE_SHEETS_TIMEOUT_MS = 5_000;

const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const GID_PATTERN = /^\d{1,10}$/;
const MAX_GID = 2_147_483_647;
const HTMLVIEW_SHEET_PATTERN =
  /items\.push\(\{\s*name:\s*"((?:\\[\s\S]|[^"\\])*)"\s*,\s*pageUrl:\s*"((?:\\[\s\S]|[^"\\])*)"\s*,\s*gid:\s*"(\d{1,10})"/gu;
const GOOGLE_SHEETS_REDIRECT_HOST_PATTERN =
  /^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/iu;

const isValidSheetName = (value) =>
  value.length >= 1 &&
  value.length <= 100 &&
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint > 0x1f && codePoint !== 0x7f;
  });

const normalizeGid = (value) => {
  if (typeof value !== "string" || !GID_PATTERN.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_GID) {
    return null;
  }
  return String(parsed);
};

const decodeJavascriptString = (value) => {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    index += 1;
    if (index >= value.length) return null;
    const escaped = value[index];
    const simpleEscapes = {
      '"': '"',
      "'": "'",
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      decoded += simpleEscapes[escaped];
      continue;
    }

    const width = escaped === "x" ? 2 : escaped === "u" ? 4 : 0;
    if (width === 0) return null;
    const hexadecimal = value.slice(index + 1, index + 1 + width);
    if (hexadecimal.length !== width || !/^[0-9a-f]+$/iu.test(hexadecimal)) {
      return null;
    }
    decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
    index += width;
  }
  return decoded;
};

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
      (key) => key !== "spreadsheetId" && key !== "sheetName" && key !== "gid",
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
  const gid = parsed.gid === undefined ? undefined : normalizeGid(parsed.gid);
  if (parsed.gid !== undefined && gid === null) return null;
  return {
    spreadsheetId: parsed.spreadsheetId,
    sheetName: parsed.sheetName,
    ...(gid !== undefined ? { gid } : {}),
  };
};

const readBoundedResponseBytes = async (
  response,
  limit = GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES,
) => {
  const declaredLengthHeader = response.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      const error = new Error("Google Sheets response exceeds the limit");
      error.code = "RESPONSE_TOO_LARGE";
      throw error;
    }
  }
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
      if (length > limit) {
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

const getMediaType = (response) =>
  String(response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

const resolveSheetGid = async (payload, fetchImpl, signal) => {
  if (!payload.sheetName) return payload.gid;

  const metadataUrl = new URL(
    `https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}/htmlview`,
  );
  const metadataResponse = await fetchImpl(metadataUrl, {
    method: "GET",
    headers: { Accept: "text/html" },
    redirect: "error",
    signal,
  });
  if (!metadataResponse.ok || getMediaType(metadataResponse) !== "text/html") {
    throw new Error("Google Sheets metadata request failed");
  }

  const html = (await readBoundedResponseBytes(metadataResponse)).toString(
    "utf8",
  );
  const matchingGids = new Set();
  for (const match of html.matchAll(HTMLVIEW_SHEET_PATTERN)) {
    const name = decodeJavascriptString(match[1]);
    const pageUrlValue = decodeJavascriptString(match[2]);
    const gid = normalizeGid(match[3]);
    if (name !== payload.sheetName || !pageUrlValue || gid === null) continue;

    let pageUrl;
    try {
      pageUrl = new URL(pageUrlValue);
    } catch {
      continue;
    }
    if (
      pageUrl.protocol !== "https:" ||
      pageUrl.hostname !== "docs.google.com" ||
      pageUrl.port !== "" ||
      pageUrl.username !== "" ||
      pageUrl.password !== "" ||
      pageUrl.pathname !==
        `/spreadsheets/d/${payload.spreadsheetId}/htmlview/sheet` ||
      normalizeGid(pageUrl.searchParams.get("gid")) !== gid
    ) {
      continue;
    }
    matchingGids.add(gid);
  }

  if (matchingGids.size !== 1) {
    throw new Error("Google Sheets tab could not be resolved safely");
  }
  return matchingGids.values().next().value;
};

const isAllowedCsvRedirect = (url) =>
  url.protocol === "https:" &&
  url.port === "" &&
  url.username === "" &&
  url.password === "" &&
  GOOGLE_SHEETS_REDIRECT_HOST_PATTERN.test(url.hostname) &&
  url.pathname.startsWith("/export/");

const fetchCsv = async (payload, fetchImpl) => {
  const signal = AbortSignal.timeout(GOOGLE_SHEETS_TIMEOUT_MS);
  const gid = await resolveSheetGid(payload, fetchImpl, signal);
  const url = new URL(
    `https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}/export`,
  );
  url.searchParams.set("format", "csv");
  if (gid !== undefined) url.searchParams.set("gid", gid);
  const requestOptions = {
    method: "GET",
    headers: {
      Accept: "text/csv,text/plain;q=0.9",
    },
    redirect: "manual",
    signal,
  };
  let upstream = await fetchImpl(url, requestOptions);
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get("location");
    if (!location) throw new Error("Google Sheets redirect is missing");

    let redirectUrl;
    try {
      redirectUrl = new URL(location, url);
    } catch {
      throw new Error("Google Sheets redirect is invalid");
    }
    if (!isAllowedCsvRedirect(redirectUrl)) {
      throw new Error("Google Sheets redirect is not allowed");
    }
    if (upstream.body) {
      await upstream.body.cancel().catch(() => undefined);
    }
    upstream = await fetchImpl(redirectUrl, {
      ...requestOptions,
      redirect: "error",
    });
  }

  if (!upstream.ok) throw new Error("Google Sheets rejected the request");
  if (getMediaType(upstream) !== "text/csv") {
    throw new Error("Google Sheets returned an unexpected response");
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
