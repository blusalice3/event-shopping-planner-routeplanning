import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertVercelObservationEvidence,
  collectVercelProviderObservation,
  parseCollectorCliArguments,
  resolveCollectorPaths,
  writeProviderObservationFile,
} from "./collect-vercel-observation.mjs";

const basePolicy = JSON.parse(
  await readFile(
    new URL("../../config/provider-policy.json", import.meta.url),
    "utf8",
  ),
);
const NOW = Date.parse("2026-08-06T04:05:06.000Z");
const DATE = new Date(NOW).toUTCString();
const TOKEN = "vercel-token-must-never-appear-in-evidence";
const SECRET_VALUE = "environment-secret-must-never-appear-in-evidence";

const wafRule = (id, route) => ({
  id,
  active: true,
  action: "deny",
  conditionGroup: [
    {
      conditions: [{ type: "path", op: "eq", value: route }],
    },
  ],
  rateLimit: null,
});

const configuredPolicy = {
  ...basePolicy,
  bindingStatus: "configured",
  expectedTeamId: "team_test",
  expectedProjectId: "prj_test",
  ownedProductionDomains: ["example.test"],
  requiredEnvironmentNames: ["REQUIRED_ENV"],
  forbiddenEnvironmentNames: ["FORBIDDEN_ENV"],
  wafRules: {
    metricsRoute: wafRule("rule_metrics", "/api/persistence-release-a-metrics"),
    cspReportRoute: wafRule("rule_csp", "/api/csp-report"),
    googleSheetsCsvRoute: wafRule("rule_sheets", "/api/google-sheets-csv"),
  },
  logPolicy: {
    ...basePolicy.logPolicy,
    retentionDays: 1,
    retentionObservation: {
      kind: "vercel-runtime-plan-v1",
      observabilityPlus: false,
      drainId: null,
      jsonPointer: null,
    },
  },
  hstsPolicy: {
    minimumMaxAgeSeconds: 31_536_000,
    requireIncludeSubDomains: true,
    requirePreload: false,
  },
  blockerCodes: [],
};

const response = (body, { hsts = null, status = 200, date = DATE } = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      Date: date,
      ETag: '"mock-etag"',
      ...(body === null ? {} : { "Content-Type": "application/json" }),
      ...(hsts === null ? {} : { "Strict-Transport-Security": hsts }),
    },
  });

const createMockFetch = ({ date = DATE } = {}) => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    if (url.hostname === "example.test") {
      return response(null, {
        date,
        hsts: "max-age=63072000; includeSubDomains",
      });
    }
    if (url.pathname === "/v2/teams/team_test") {
      return response({ id: "team_test", billing: { plan: "pro" } }, { date });
    }
    if (url.pathname === "/v9/projects/prj_test") {
      return response(
        {
          id: "prj_test",
          accountId: "team_test",
          nodeVersion: "24.x",
          autoAssignCustomDomains: false,
          link: { type: "github", productionBranch: "main" },
          deploymentPolicy: {
            deploymentSources: [
              {
                enabled: true,
                environments: [{ type: "system", target: "production" }],
                sources: ["cli", "rest-api"],
              },
              {
                enabled: true,
                environments: [{ type: "system", target: "preview" }],
                sources: ["cli"],
              },
            ],
          },
        },
        { date },
      );
    }
    if (url.pathname === "/v9/projects/prj_test/domains") {
      return response(
        {
          domains: [
            {
              name: "example.test",
              projectId: "prj_test",
              verified: true,
            },
          ],
          pagination: { count: 1, next: null, prev: null },
        },
        { date },
      );
    }
    if (url.pathname === "/v10/projects/prj_test/env") {
      return response(
        {
          envs: [
            {
              key: "REQUIRED_ENV",
              target: ["production"],
              type: "sensitive",
              value: SECRET_VALUE,
            },
            {
              key: "FORBIDDEN_ENV",
              target: ["preview"],
              type: "sensitive",
              value: "preview-only-secret",
            },
          ],
          pagination: { count: 2, next: null, prev: null },
        },
        { date },
      );
    }
    if (url.pathname === "/v1/security/firewall/config/active") {
      return response(
        {
          firewallEnabled: true,
          rules: Object.values(configuredPolicy.wafRules).map((rule) => ({
            id: rule.id,
            active: rule.active,
            conditionGroup: rule.conditionGroup,
            action: {
              mitigate: {
                action: rule.action,
                rateLimit: rule.rateLimit,
              },
            },
          })),
        },
        { date },
      );
    }
    if (url.pathname === "/v1/drains") {
      return response(
        {
          drains: [
            {
              id: "drain_logs",
              status: "enabled",
              schemas: { log: { version: "v1" } },
              delivery: {
                type: "http",
                endpoint: "https://logs.example.test",
                secret: "drain-secret-must-not-appear",
              },
            },
          ],
        },
        { date },
      );
    }
    throw new Error(`Unexpected mock URL: ${url.href}`);
  };
  return { calls, fetchImpl };
};

test("collects canonical Vercel API evidence without token or secret values", async () => {
  const mock = createMockFetch();
  const observation = await collectVercelProviderObservation({
    policy: configuredPolicy,
    token: TOKEN,
    fetchImpl: mock.fetchImpl,
    now: NOW,
  });
  assert.equal(observation.providerTeamId, "team_test");
  assert.equal(observation.providerProjectId, "prj_test");
  assert.deepEqual(observation.ownedProductionDomains, ["example.test"]);
  assert.deepEqual(observation.presentEnvironmentNames, ["REQUIRED_ENV"]);
  assert.equal(observation.gitProductionAutoDeploy, false);
  assert.equal(observation.gitPreviewAutoDeploy, false);
  assert.deepEqual(observation.wafRules, configuredPolicy.wafRules);
  assert.deepEqual(observation.logPolicy, configuredPolicy.logPolicy);
  assert.equal(observation.logRetentionEvidence.retentionDays, 1);
  assert.equal(observation.hsts[0].maxAgeSeconds, 63_072_000);
  assert.equal(observation.evidenceReceipts.length, 7);
  assert.doesNotThrow(() =>
    assertVercelObservationEvidence(observation, configuredPolicy, NOW),
  );

  const serialized = JSON.stringify(observation);
  for (const forbidden of [
    TOKEN,
    SECRET_VALUE,
    "preview-only-secret",
    "drain-secret-must-not-appear",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  for (const receipt of observation.evidenceReceipts) {
    assert.equal(receipt.responseDate, DATE);
    assert.equal(receipt.etag, '"mock-etag"');
    assert.match(receipt.bodySha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.responseSha256, /^[0-9a-f]{64}$/);
  }
  const apiCalls = mock.calls.filter(
    ({ url }) => new URL(url).hostname === "api.vercel.com",
  );
  assert.equal(apiCalls.length, 6);
  assert.equal(
    apiCalls.every(
      ({ init }) => init.headers.Authorization === `Bearer ${TOKEN}`,
    ),
    true,
  );
  const hstsCall = mock.calls.find(
    ({ url }) => new URL(url).hostname === "example.test",
  );
  assert.equal(hstsCall.init.headers.Authorization, undefined);
});

test("rejects stale provider Date headers", async () => {
  const stale = createMockFetch({
    date: new Date(NOW - 301_000).toUTCString(),
  });
  await assert.rejects(
    collectVercelProviderObservation({
      policy: configuredPolicy,
      token: TOKEN,
      fetchImpl: stale.fetchImpl,
      now: NOW,
    }),
    /outside the provider freshness window/,
  );
});

test("fails closed before fetching when provider binding is unconfigured", async () => {
  let fetchCount = 0;
  await assert.rejects(
    collectVercelProviderObservation({
      policy: basePolicy,
      token: TOKEN,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("must not fetch");
      },
      now: NOW,
    }),
    /Provider policy is not configured/,
  );
  assert.equal(fetchCount, 0);
});

test("rejects a tampered canonical response receipt", async () => {
  const mock = createMockFetch();
  const observation = await collectVercelProviderObservation({
    policy: configuredPolicy,
    token: TOKEN,
    fetchImpl: mock.fetchImpl,
    now: NOW,
  });
  const tampered = structuredClone(observation);
  tampered.evidenceReceipts[0].etag = '"different"';
  assert.throws(
    () => assertVercelObservationEvidence(tampered, configuredPolicy, NOW),
    /receipt is invalid/,
  );
});

test("collector CLI rejects unknown, duplicate, and missing-value arguments", () => {
  assert.throws(
    () => parseCollectorCliArguments(["--unknown", "value"]),
    /Unknown collector argument/,
  );
  assert.throws(
    () =>
      parseCollectorCliArguments([
        "--output",
        "one.json",
        "--output",
        "two.json",
      ]),
    /Duplicate collector argument/,
  );
  assert.throws(
    () => parseCollectorCliArguments(["--output"]),
    /requires exactly one value/,
  );
  assert.throws(
    () =>
      parseCollectorCliArguments(["--policy", "--output", "observation.json"]),
    /requires exactly one value/,
  );
});

test("collector CLI rejects identical policy and output paths", () => {
  assert.throws(
    () =>
      resolveCollectorPaths(
        ["--policy", "same.json", "--output", "./same.json"],
        path.resolve("collector-test"),
      ),
    /output must differ from policy path/,
  );
});

test("collector output is create-only", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vercel-observation-test-"),
  );
  const outputPath = path.join(directory, "observation.json");
  try {
    await writeFile(outputPath, "already-present", "utf8");
    await assert.rejects(
      writeProviderObservationFile(outputPath, {
        schemaVersion: 1,
      }),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector rejects absent, short, oversized, and control-character tokens", async () => {
  for (const token of [
    undefined,
    "short",
    "x".repeat(4_097),
    `valid-prefix
invalid`,
  ]) {
    let fetchCount = 0;
    await assert.rejects(
      collectVercelProviderObservation({
        policy: configuredPolicy,
        token,
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("must not fetch");
        },
        now: NOW,
      }),
      /VERCEL_TOKEN is absent or invalid/,
    );
    assert.equal(fetchCount, 0);
  }
});

test("collector does not propagate token-bearing fetch errors", async () => {
  await assert.rejects(
    collectVercelProviderObservation({
      policy: configuredPolicy,
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error(`upstream accidentally included ${TOKEN}`);
      },
      now: NOW,
    }),
    (error) =>
      /Provider observation request failed/.test(error.message) &&
      !error.message.includes(TOKEN),
  );
});

test("observation evidence rejects unknown top-level properties", async () => {
  const mock = createMockFetch();
  const observation = await collectVercelProviderObservation({
    policy: configuredPolicy,
    token: TOKEN,
    fetchImpl: mock.fetchImpl,
    now: NOW,
  });
  assert.throws(
    () =>
      assertVercelObservationEvidence(
        { ...observation, unexpected: true },
        configuredPolicy,
        NOW,
      ),
    /unexpected property set/,
  );
});
