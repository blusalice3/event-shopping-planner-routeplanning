import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOOGLE_SHEETS_REQUEST_LIMIT_BYTES,
  GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES,
  createGoogleSheetsCsvHandler,
} from "./google-sheets-csv.mjs";

const allowedOrigin = "https://planner.example.test";
const createResponse = () => ({
  statusCode: 200,
  headers: new Map(),
  body: null,
  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), String(value));
  },
  end(body) {
    this.body = body ?? null;
  },
});

const invoke = async ({
  method = "POST",
  contentType = "application/json",
  origin = allowedOrigin,
  body = {
    spreadsheetId: "document_123456",
    sheetName: "品目表",
  },
  fetchImpl = async () =>
    new Response("header,value\nA,1", {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    }),
  configured = true,
} = {}) => {
  const response = createResponse();
  const handler = createGoogleSheetsCsvHandler({
    loadConfig: () => (configured ? { allowedOrigin } : null),
    fetchImpl,
  });
  await handler(
    {
      method,
      headers: {
        "content-type": contentType,
        origin,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    response,
  );
  return response;
};

test("proxies only a closed Google Sheets CSV request", async () => {
  let requestUrl;
  let requestOptions;
  const response = await invoke({
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return new Response("列A,列B\n値A,値B", { status: 200 });
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(requestUrl.origin, "https://docs.google.com");
  assert.equal(requestUrl.pathname, "/spreadsheets/d/document_123456/gviz/tq");
  assert.equal(requestUrl.searchParams.get("sheet"), "品目表");
  assert.equal(requestOptions.redirect, "error");
  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.body.toString("utf8"), "列A,列B\n値A,値B");
});

test("rejects method, media type, origin, shape, and configuration drift", async () => {
  assert.equal((await invoke({ method: "GET" })).statusCode, 405);
  assert.equal((await invoke({ contentType: "text/plain" })).statusCode, 415);
  assert.equal(
    (await invoke({ origin: "https://attacker.example" })).statusCode,
    403,
  );
  assert.equal(
    (
      await invoke({
        body: {
          spreadsheetId: "short",
          targetUrl: "https://attacker.example",
        },
      })
    ).statusCode,
    400,
  );
  assert.equal((await invoke({ configured: false })).statusCode, 503);
  assert.equal(
    (
      await invoke({
        body: "x".repeat(GOOGLE_SHEETS_REQUEST_LIMIT_BYTES + 1),
      })
    ).statusCode,
    413,
  );
});

test("bounds upstream responses and hides upstream failures", async () => {
  assert.equal(
    (
      await invoke({
        fetchImpl: async () =>
          new Response(null, {
            status: 200,
            headers: {
              "Content-Length": String(GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES + 1),
            },
          }),
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (
      await invoke({
        fetchImpl: async () =>
          new Response(
            Buffer.alloc(GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES + 1, 0x61),
            { status: 200 },
          ),
      })
    ).statusCode,
    413,
  );
  const failed = await invoke({
    fetchImpl: async () => {
      throw new Error("private upstream detail");
    },
  });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body, null);
});
