import assert from "node:assert/strict";
import test from "node:test";
import {
  providerConfigurationHash,
  providerConfigurationProjection,
} from "./providerConfiguration.mjs";

const baseObservation = {
  schemaVersion: 1,
  evidenceKind: "vercel-provider-observation-v1",
  provider: "vercel",
  observedAt: "2026-08-06T00:00:00.000Z",
  providerTeamId: "team_test",
  providerProjectId: "prj_test",
  ownedProductionDomains: ["example.test"],
  wafRules: { metricsRoute: { id: "rule_metrics" } },
  evidenceReceipts: [
    {
      kind: "project",
      responseDate: "Thu, 06 Aug 2026 00:00:00 GMT",
      etag: '"first"',
      responseSha256: "1".repeat(64),
    },
  ],
};

test("excludes only per-observation time and receipt evidence from configuration", () => {
  const laterObservation = {
    ...baseObservation,
    observedAt: "2026-08-06T00:01:00.000Z",
    evidenceReceipts: [
      {
        kind: "project",
        responseDate: "Thu, 06 Aug 2026 00:01:00 GMT",
        etag: '"second"',
        responseSha256: "2".repeat(64),
      },
    ],
  };
  assert.equal(
    providerConfigurationHash(laterObservation),
    providerConfigurationHash(baseObservation),
  );
  assert.deepEqual(providerConfigurationProjection(baseObservation), {
    schemaVersion: 1,
    evidenceKind: "vercel-provider-observation-v1",
    provider: "vercel",
    providerTeamId: "team_test",
    providerProjectId: "prj_test",
    ownedProductionDomains: ["example.test"],
    wafRules: { metricsRoute: { id: "rule_metrics" } },
  });
});

test("binds every nonvolatile provider configuration field", () => {
  assert.notEqual(
    providerConfigurationHash({
      ...baseObservation,
      ownedProductionDomains: ["other.example.test"],
    }),
    providerConfigurationHash(baseObservation),
  );
  assert.notEqual(
    providerConfigurationHash({
      ...baseObservation,
      newlyObservedConfiguration: true,
    }),
    providerConfigurationHash(baseObservation),
  );
});

test("rejects absent configuration input", () => {
  assert.throws(() => providerConfigurationHash(null), /must be an object/);
  assert.throws(
    () =>
      providerConfigurationHash({
        observedAt: "2026-08-06T00:00:00.000Z",
        evidenceReceipts: [],
      }),
    /no configuration fields/,
  );
});
