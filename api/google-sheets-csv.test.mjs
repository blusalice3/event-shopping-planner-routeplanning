import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOOGLE_SHEETS_REQUEST_LIMIT_BYTES,
  GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES,
  createGoogleSheetsCsvHandler,
} from "./google-sheets-csv.mjs";

const allowedOrigin = "https://planner.example.test";
const spreadsheetId = "document_123456";
const exportHost = "doc-00-80-sheets.googleusercontent.com";

const escapeJavascriptString = (value) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const createHtmlview = (sheets = [{ name: "品目表", gid: "42" }]) =>
  sheets
    .map(({ name, gid }) => {
      const pageUrl =
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}` +
        `/htmlview/sheet?headers=true&gid=${gid}`;
      const escapedPageUrl = pageUrl
        .replaceAll("/", "\\/")
        .replace("=", "\\x3d");
      return `items.push({name: "${escapeJavascriptString(name)}", pageUrl: "${escapedPageUrl}", gid: "${gid}",initialSheet: false});`;
    })
    .join("");

const createSuccessfulFetch =
  ({ csv = "header,value\nA,1", sheets } = {}) =>
  async (url) => {
    if (
      url.hostname === "docs.google.com" &&
      url.pathname.endsWith("/htmlview")
    ) {
      return new Response(createHtmlview(sheets), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (
      url.hostname === "docs.google.com" &&
      url.pathname.endsWith("/export")
    ) {
      return new Response(null, {
        status: 307,
        headers: {
          Location: `https://${exportHost}/export/signed/path?${url.searchParams}`,
        },
      });
    }
    if (url.hostname === exportHost && url.pathname.startsWith("/export/")) {
      return new Response(csv, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };

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
    spreadsheetId,
    sheetName: "品目表",
    gid: "99",
  },
  fetchImpl = createSuccessfulFetch(),
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

test("resolves the requested tab and proxies its full-row CSV export", async () => {
  const calls = [];
  const successfulFetch = createSuccessfulFetch({
    csv: "列A,列B\n表示行,1\n手動非表示行,2\nフィルタ非表示行,3",
  });
  const response = await invoke({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return successfulFetch(url, options);
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.origin, "https://docs.google.com");
  assert.equal(
    calls[0].url.pathname,
    `/spreadsheets/d/${spreadsheetId}/htmlview`,
  );
  assert.equal(calls[0].options.redirect, "error");

  assert.equal(calls[1].url.origin, "https://docs.google.com");
  assert.equal(
    calls[1].url.pathname,
    `/spreadsheets/d/${spreadsheetId}/export`,
  );
  assert.equal(calls[1].url.searchParams.get("format"), "csv");
  assert.equal(calls[1].url.searchParams.get("gid"), "42");
  assert.equal(calls[1].options.redirect, "manual");

  assert.equal(calls[2].url.hostname, exportHost);
  assert.equal(calls[2].options.redirect, "error");
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  assert.equal(calls[1].options.signal, calls[2].options.signal);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(
    response.body.toString("utf8"),
    "列A,列B\n表示行,1\n手動非表示行,2\nフィルタ非表示行,3",
  );
});

test("decodes escaped tab names and lets the saved sheet name override URL gid", async () => {
  const requestedName = '品目表 "引用" \\ path';
  let exportGid;
  const successfulFetch = createSuccessfulFetch({
    sheets: [
      { name: "別シート", gid: "1" },
      { name: requestedName, gid: "7" },
    ],
  });
  const response = await invoke({
    body: { spreadsheetId, sheetName: requestedName, gid: "99" },
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith("/export")) {
        exportGid = url.searchParams.get("gid");
      }
      return successfulFetch(url, options);
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(exportGid, "7");
});

test("does not fall back to URL gid when the requested tab cannot be resolved", async () => {
  let fetchCount = 0;
  const response = await invoke({
    body: { spreadsheetId, sheetName: "存在しない", gid: "99" },
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(createHtmlview(), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(fetchCount, 1);
  assert.equal(response.body, null);
});

test("uses URL gid directly only when no sheet name is available", async () => {
  let exportGid;
  const successfulFetch = createSuccessfulFetch();
  const response = await invoke({
    body: { spreadsheetId, gid: "5" },
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith("/htmlview")) {
        throw new Error("htmlview must not be requested");
      }
      if (url.pathname.endsWith("/export")) {
        exportGid = url.searchParams.get("gid");
      }
      return successfulFetch(url, options);
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(exportGid, "5");
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
          gid: "0",
          targetUrl: "https://attacker.example",
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await invoke({ body: { spreadsheetId, gid: "2147483648" } })).statusCode,
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

test("rejects redirects outside the fixed Google CSV download host", async () => {
  for (const location of [
    "https://attacker.example/export/file",
    "http://doc-00-80-sheets.googleusercontent.com/export/file",
    "https://googleusercontent.com.attacker.example/export/file",
    "https://doc-00-80-sheets.googleusercontent.com/not-export/file",
  ]) {
    let fetchCount = 0;
    const response = await invoke({
      body: { spreadsheetId, gid: "0" },
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(null, {
          status: 307,
          headers: { Location: location },
        });
      },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(fetchCount, 1);
  }
});

test("bounds upstream responses and rejects non-CSV responses", async () => {
  const directBody = { spreadsheetId, gid: "0" };
  assert.equal(
    (
      await invoke({
        body: directBody,
        fetchImpl: async () =>
          new Response(null, {
            status: 200,
            headers: {
              "Content-Type": "text/csv",
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
        body: directBody,
        fetchImpl: async () =>
          new Response(
            Buffer.alloc(GOOGLE_SHEETS_RESPONSE_LIMIT_BYTES + 1, 0x61),
            {
              status: 200,
              headers: { "Content-Type": "text/csv" },
            },
          ),
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (
      await invoke({
        body: directBody,
        fetchImpl: async () =>
          new Response("<html>sign in</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      })
    ).statusCode,
    502,
  );

  const failed = await invoke({
    body: directBody,
    fetchImpl: async () => {
      throw new Error("private upstream detail");
    },
  });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body, null);
});
