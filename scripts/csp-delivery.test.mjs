import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CSP_HEADER_NAMES,
  cspReportSinkContract,
  renderCspHeaders,
  renderVercelProjectConfig,
  resolveProviderEnvironmentContract,
} from "./lib/csp-delivery.mjs";
import { readJsonStrict } from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const loadPolicies = () =>
  Promise.all([
    readJsonStrict(path.join(root, "config", "csp-policy.json")),
    readJsonStrict(path.join(root, "config", "provider-policy.json")),
    readJsonStrict(path.join(root, "vercel.json")),
  ]);

test("renders exactly one active CSP header from the build mode", async () => {
  const [cspPolicy] = await loadPolicies();
  const expectedHeaderName = {
    none: null,
    "report-only": "Content-Security-Policy-Report-Only",
    enforced: "Content-Security-Policy",
  };
  for (const cspMode of ["none", "report-only", "enforced"]) {
    const headers = renderCspHeaders({ cspMode, cspPolicy });
    const activeCspHeaders = CSP_HEADER_NAMES.filter((name) =>
      Object.hasOwn(headers, name),
    );
    assert.deepEqual(
      activeCspHeaders,
      expectedHeaderName[cspMode] === null ? [] : [expectedHeaderName[cspMode]],
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) => !CSP_HEADER_NAMES.includes(name),
        ),
      ),
      cspPolicy.securityHeaders,
    );
  }
});

test("keeps vercel.json as the enforced target and renders phase variants", async () => {
  const [cspPolicy, , vercelConfig] = await loadPolicies();
  assert.deepEqual(
    renderVercelProjectConfig({
      config: vercelConfig,
      cspMode: "enforced",
      cspPolicy,
    }),
    vercelConfig,
  );
  for (const cspMode of ["none", "report-only"]) {
    const rendered = renderVercelProjectConfig({
      config: vercelConfig,
      cspMode,
      cspPolicy,
    });
    const globalRule = rendered.headers.find((rule) => rule.source === "/(.*)");
    assert.deepEqual(
      Object.fromEntries(
        globalRule.headers.map(({ key, value }) => [key, value]),
      ),
      renderCspHeaders({ cspMode, cspPolicy }),
    );
  }
});

test("enables the report function and credentials only for active CSP modes", async () => {
  const [cspPolicy, providerPolicy] = await loadPolicies();
  const baseEnvironment = resolveProviderEnvironmentContract(
    providerPolicy,
    "none",
  );
  for (const cspMode of ["none", "report-only", "enforced"]) {
    const sink = cspReportSinkContract({
      cspMode,
      cspPolicy,
      providerPolicy,
    });
    const environment = resolveProviderEnvironmentContract(
      providerPolicy,
      cspMode,
    );
    const enabled = cspMode !== "none";
    assert.equal(sink.enabled, enabled);
    assert.equal(sink.functionRoot, enabled ? "api/csp-report.func" : null);
    assert.equal(sink.fallbackDestination, enabled ? null : "/api/not-found");
    for (const name of providerPolicy.cspReportEnvironmentNames) {
      assert.equal(
        environment.requiredEnvironmentNames.includes(name),
        enabled,
      );
      assert.equal(
        baseEnvironment.requiredEnvironmentNames.includes(name),
        false,
      );
    }
  }
});
