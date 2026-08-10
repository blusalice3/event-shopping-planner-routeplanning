import assert from "node:assert/strict";
import test from "node:test";

import { sha256Bytes } from "../lib/canonical-json.mjs";
import {
  assertCspReportPhaseStateAuthority,
  deriveCspReportWafAuthority,
  resolveCspReportPhaseStateAuthority,
} from "./csp-report-phase-authority.mjs";

const namespace = "csp-phase-authority";
const sourceSha = "1".repeat(40);
const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
  sha256: character.repeat(64),
});
const binding = (role, suffix) => ({
  bindingId: `binding:${role}:${suffix}`,
  sourceSha,
  buildId: sourceSha,
  variantId: suffix.repeat(64),
  releaseRole: role,
  publicIdentityKind: "release-identity-v1",
  providerProjectId: "project-authority",
  providerDeploymentId: `deployment-${suffix}`,
  deploymentUrl: `https://deployment-${suffix}.example.test/`,
  artifactArchive: reference("2"),
  artifactArchiveAvailability: reference("3"),
  packageIndex: reference("4"),
  artifactManifest: reference("5"),
  providerEvidence: reference("6"),
  releasePolicy: reference("7"),
  providerPolicy: reference("8"),
  providerConfigurationHash: "9".repeat(64),
  requiredDbCompatibility: {
    contractUri: "urn:event-shopping-planner:db-compatibility:v1",
    fingerprint: "a".repeat(64),
  },
});
const standard = binding("standard", "b");
const companion = binding("containment", "c");
const terminalCurrent = () => ({
  head: { sequence: 10, eventHash: "d".repeat(64) },
  records: [],
  snapshot: {
    acceptedGate: "P2B-REPORT",
    acceptedStandard: standard,
    activeProduction: standard,
    containmentCompanion: companion,
    acceptedStandardFloors: { cspMode: "report-only" },
    pendingOperation: null,
    pendingAcceptance: null,
  },
});

test("rejects a live P2B state with a pending operation", async () => {
  const current = terminalCurrent();
  current.snapshot.pendingOperation = { operationId: "caller-pending" };
  await assert.rejects(
    resolveCspReportPhaseStateAuthority({
      store: {},
      current,
      namespace,
      sourceSha,
    }),
    /terminal P2B closure/,
  );
});

test("rejects a live P2B state without its current companion", async () => {
  const current = terminalCurrent();
  current.snapshot.containmentCompanion = null;
  await assert.rejects(
    resolveCspReportPhaseStateAuthority({
      store: {},
      current,
      namespace,
      sourceSha,
    }),
    /durable artifact archive binding/,
  );
});

test("requires both current standard and companion to remain report-only", () => {
  const eventReference = (sequence, character) => ({
    sequence,
    uri: `release-state://${namespace}/events/${sequence}/${character.repeat(64)}`,
    sha256: character.repeat(64),
  });
  const projection = (role, suffix, cspMode) => ({
    bindingId: `binding:${role}:${suffix}`,
    sourceSha,
    releaseRole: role,
    providerDeploymentId: `deployment-${suffix}`,
    providerConfigurationHash: "9".repeat(64),
    artifactManifest: reference(suffix),
    cspMode,
  });
  const notFound = Buffer.from('{"error":"api-not-found"}', "utf8");
  const authority = {
    releaseStateHead: { sequence: 10, eventHash: "d".repeat(64) },
    acceptedGate: "P2B-REPORT",
    pendingOperation: null,
    pendingAcceptance: null,
    acceptedStandard: projection("standard", "b", "report-only"),
    containmentCompanion: projection("containment", "c", "report-only"),
    preP2B: {
      acceptedGate: "P2A-LOCAL",
      acceptedEvent: eventReference(4, "4"),
      assignmentValidatedEvent: eventReference(3, "3"),
      productionProbe: reference("f"),
      acceptedStandard: projection("standard", "e", "none"),
      containmentCompanion: projection("containment", "f", "none"),
      reportRoute: {
        method: "GET",
        path: "/api/csp-report",
        status: 404,
        bodySha256: sha256Bytes(notFound),
        bodyByteLength: notFound.length,
        cacheControl: "no-store",
        contentType: "application/json; charset=utf-8",
        allow: null,
        productionReceiptSetSha256: "0".repeat(64),
      },
    },
  };
  assert.equal(
    assertCspReportPhaseStateAuthority(authority).acceptedGate,
    "P2B-REPORT",
  );
  const drifted = structuredClone(authority);
  drifted.containmentCompanion.cspMode = "none";
  assert.throws(
    () => assertCspReportPhaseStateAuthority(drifted),
    /current standard\/companion policy differs/,
  );
});

test("derives exact active path, method, and rate semantics from live provider", () => {
  const rule = {
    id: "csp-report-rate-limit",
    active: true,
    action: "rate_limit",
    conditionGroup: [
      {
        conditions: [
          { type: "path", op: "eq", value: "/api/csp-report" },
          { type: "method", op: "eq", value: "POST" },
        ],
      },
    ],
    rateLimit: {
      algo: "fixed_window",
      keys: ["ip"],
      limit: 16,
      window: 60,
    },
  };
  const providerPolicy = { wafRules: { cspReportRoute: rule } };
  const providerObservation = {
    provider: "vercel",
    ownedProductionDomains: ["app.example.test"],
    wafRules: { cspReportRoute: rule },
  };
  const authority = deriveCspReportWafAuthority({
    providerObservation,
    providerPolicy,
  });
  assert.equal(authority.limit, 16);
  assert.equal(authority.windowSeconds, 60);
  const missingMethod = structuredClone(rule);
  missingMethod.conditionGroup[0].conditions.pop();
  assert.throws(
    () =>
      deriveCspReportWafAuthority({
        providerObservation: {
          ...providerObservation,
          wafRules: { cspReportRoute: missingMethod },
        },
        providerPolicy: { wafRules: { cspReportRoute: missingMethod } },
      }),
    /exact POST route semantics/,
  );
  const inactiveRateAction = { ...rule, action: "deny" };
  assert.throws(
    () =>
      deriveCspReportWafAuthority({
        providerObservation: {
          ...providerObservation,
          wafRules: { cspReportRoute: inactiveRateAction },
        },
        providerPolicy: {
          wafRules: { cspReportRoute: inactiveRateAction },
        },
      }),
    /rate semantics/,
  );
  const missingConditions = { ...rule, conditionGroup: null };
  assert.throws(
    () =>
      deriveCspReportWafAuthority({
        providerObservation: {
          ...providerObservation,
          wafRules: { cspReportRoute: missingConditions },
        },
        providerPolicy: { wafRules: { cspReportRoute: missingConditions } },
      }),
    /condition groups/,
  );
});
