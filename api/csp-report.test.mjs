import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CSP_REPORT_BATCH_LIMIT,
  CSP_REPORT_RAW_LIMIT_BYTES,
  classifyBlockedTarget,
  createCspReportHandler,
} from "./csp-report.mjs";

const CONFIG = Object.freeze({
  dbUrl: "https://database.example.test",
  publicOrigin: "https://planner.example.test",
  credential: "test-only-credential",
  sourceSha: "a".repeat(40),
  providerDeploymentId: "deployment_test_1",
});

const createResponse = () => ({
  statusCode: 200,
  headers: new Map(),
  ended: false,
  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), String(value));
  },
  end() {
    this.ended = true;
  },
});

const invoke = async ({
  method = "POST",
  contentType = "application/csp-report",
  body,
  insert = async () => undefined,
  config = CONFIG,
}) => {
  const response = createResponse();
  const handler = createCspReportHandler({
    loadConfig: () => config,
    insert,
  });
  await handler(
    {
      method,
      headers: {
        "content-type": contentType,
      },
      body:
        typeof body === "string"
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
    },
    response,
  );
  return response;
};

test("stores only closed CSP fields and server-owned identity", async () => {
  let inserted;
  const rawDocument = "https://planner.example.test/private/event-name";
  const rawBlocked = "https://tracker.attacker.test/user-token";
  const response = await invoke({
    body: {
      "csp-report": {
        "document-uri": rawDocument,
        "effective-directive": "script-src-elem",
        disposition: "report",
        "blocked-uri": rawBlocked,
        "source-file": "https://planner.example.test/assets/private.js",
        "line-number": 99,
        sample: "private sample",
      },
    },
    insert: async (records) => {
      inserted = records;
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(inserted, [
    {
      schema_version: 1,
      effective_directive: "script-src-elem",
      disposition: "report",
      blocked_target_classification: "cross-site",
      source_sha: CONFIG.sourceSha,
      provider_deployment_id: CONFIG.providerDeploymentId,
    },
  ]);
  const serialized = JSON.stringify(inserted);
  assert.equal(serialized.includes(rawDocument), false);
  assert.equal(serialized.includes(rawBlocked), false);
  assert.equal(serialized.includes("private sample"), false);
});

test("accepts a bounded Reporting API batch", async () => {
  const reports = Array.from({ length: CSP_REPORT_BATCH_LIMIT }, () => ({
    type: "csp-violation",
    body: {
      effectiveDirective: "worker-src",
      disposition: "enforce",
      blockedURL: "blob:https://planner.example.test/id",
    },
  }));
  let inserted;
  const response = await invoke({
    contentType: "application/reports+json; charset=utf-8",
    body: reports,
    insert: async (records) => {
      inserted = records;
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(inserted.length, CSP_REPORT_BATCH_LIMIT);
  assert.ok(
    inserted.every(
      (record) => record.blocked_target_classification === "scheme",
    ),
  );
});

test("separates method, media type, invalid, oversize, and config errors", async () => {
  assert.equal((await invoke({ method: "GET" })).statusCode, 405);
  assert.equal(
    (
      await invoke({
        contentType: "application/json",
        body: {},
      })
    ).statusCode,
    415,
  );
  assert.equal((await invoke({ body: "{invalid-json" })).statusCode, 400);
  assert.equal(
    (
      await invoke({
        body: "x".repeat(CSP_REPORT_RAW_LIMIT_BYTES + 1),
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (
      await invoke({
        body: {
          "csp-report": {
            "effective-directive": "script-src",
            disposition: "report",
          },
        },
        config: null,
      })
    ).statusCode,
    503,
  );
});

test("maps upstream failure to 502 without reflecting details", async () => {
  const response = await invoke({
    body: {
      "csp-report": {
        "effective-directive": "connect-src",
        disposition: "report",
        "blocked-uri": "https://secret.example.test/path",
      },
    },
    insert: async () => {
      throw new Error("credential and raw URL must not be returned");
    },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.headers.get("content-length"), "0");
});

test("blocked target classifier never returns a raw target", () => {
  assert.equal(
    classifyBlockedTarget("/assets/app.js", "https://planner.example.test"),
    "self",
  );
  assert.equal(
    classifyBlockedTarget(
      "https://cdn.example.test/file.js",
      "https://planner.example.test",
    ),
    "same-site",
  );
  assert.equal(
    classifyBlockedTarget("data:text/plain,secret", CONFIG.publicOrigin),
    "scheme",
  );
});
