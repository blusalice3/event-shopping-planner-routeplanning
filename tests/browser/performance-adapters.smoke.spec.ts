import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioAdapters } from "../../scripts/performance/canonicalPlaywrightAdapters.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const targetUrl = new URL(
  "/",
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173",
).toString();

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const artifactBinding = () => {
  const identityPath = path.join(root, "dist", "release-identity.json");
  const identityBytes = readFileSync(identityPath);
  const workerNames = readdirSync(path.join(root, "dist", "assets")).filter(
    (name) => /^xlsx\.worker-[A-Za-z0-9_-]+\.js$/.test(name),
  );
  expect(workerNames).toHaveLength(1);
  const workerPath = path.join(root, "dist", "assets", workerNames[0]);
  const workerBytes = readFileSync(workerPath);
  return {
    archiveSha256: sha256(Buffer.concat([identityBytes, workerBytes])),
    outputFiles: [
      {
        path: "static/release-identity.json",
        sha256: sha256(identityBytes),
        size: statSync(identityPath).size,
      },
      {
        path: `static/assets/${workerNames[0]}`,
        sha256: sha256(workerBytes),
        size: statSync(workerPath).size,
      },
    ],
  };
};

test.describe("canonical public adapter smoke", () => {
  test.setTimeout(120_000);

  test("executes the foundation family against the standard artifact", async ({
    context,
    page,
  }) => {
    const fixtureBytes = readFileSync(
      path.join(root, "dist", "release-identity.json"),
    );
    const result = await scenarioAdapters["foundation-startup-cold"]({
      adapterKind: "foundation-browser",
      artifactBinding: artifactBinding(),
      browserContext: context,
      fixtureBytes,
      fixtureDocument: null,
      page,
      requiredAssertions: ["scenario-completed"],
      requiredTelemetry: ["durationMs"],
      sampleIndex: 0,
      scenarioId: "foundation-startup-cold",
      targetUrl,
      warmup: false,
    });
    expect(result.assertions).toEqual({ "scenario-completed": true });
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("executes the XLSX Worker family against the standard artifact", async ({
    context,
    page,
  }) => {
    const fixturePath = path.join(
      root,
      "scripts",
      "fixtures",
      "performance",
      "xlsx-worker-reject-corrupt.json",
    );
    const fixtureBytes = readFileSync(fixturePath);
    const fixtureDocument = JSON.parse(fixtureBytes.toString("utf8"));
    const result = await scenarioAdapters["xlsx-worker-reject-corrupt"]({
      adapterKind: "xlsx-worker-browser",
      artifactBinding: artifactBinding(),
      browserContext: context,
      fixtureBytes,
      fixtureDocument,
      page,
      requiredAssertions: fixtureDocument.requiredAssertions,
      requiredTelemetry: fixtureDocument.requiredTelemetry,
      sampleIndex: 0,
      scenarioId: fixtureDocument.scenarioId,
      targetUrl,
      warmup: false,
    });
    expect(result.assertions).toEqual({
      "single-terminal-error": true,
      "zero-domain-commits": true,
      "zero-download-side-effects": true,
    });
  });

  test("commits a valid XLSX through the public Worker and persistence surface", async ({
    context,
    page,
  }) => {
    const fixturePath = path.join(
      root,
      "scripts",
      "fixtures",
      "performance",
      "xlsx-worker-import-valid.json",
    );
    const canonicalFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const fixtureDocument = {
      ...canonicalFixture,
      dataset: {
        ...canonicalFixture.dataset,
        rowCount: 20,
        targetCompressedBytes: undefined,
      },
      requiredAssertions: [
        "worker-execution-observed",
        "single-terminal-result",
        "atomic-domain-commit",
      ],
      requiredTelemetry: ["durationMs"],
    };
    const fixtureBytes = Buffer.from(JSON.stringify(fixtureDocument), "utf8");
    const result = await scenarioAdapters["xlsx-worker-import-valid"]({
      adapterKind: "xlsx-worker-browser",
      artifactBinding: artifactBinding(),
      browserContext: context,
      fixtureBytes,
      fixtureDocument,
      page,
      requiredAssertions: fixtureDocument.requiredAssertions,
      requiredTelemetry: fixtureDocument.requiredTelemetry,
      sampleIndex: 0,
      scenarioId: fixtureDocument.scenarioId,
      targetUrl,
      warmup: false,
    });
    expect(result.assertions).toEqual({
      "worker-execution-observed": true,
      "single-terminal-result": true,
      "atomic-domain-commit": true,
    });
    expect(result.executionBinding.setup).toBeNull();
  });

  test("round-trips a staged event through the real public export", async ({
    context,
    page,
  }) => {
    const fixturePath = path.join(
      root,
      "scripts",
      "fixtures",
      "performance",
      "xlsx-worker-export-roundtrip.json",
    );
    const canonicalFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const fixtureDocument = {
      ...canonicalFixture,
      dataset: { ...canonicalFixture.dataset, itemCount: 20 },
      requiredAssertions: [
        "worker-execution-observed",
        "single-terminal-result",
        "round-trip-semantic-parity",
        "single-atomic-download",
      ],
      requiredTelemetry: ["durationMs"],
    };
    const fixtureBytes = Buffer.from(JSON.stringify(fixtureDocument), "utf8");
    const result = await scenarioAdapters["xlsx-worker-export-roundtrip"]({
      adapterKind: "xlsx-worker-browser",
      artifactBinding: artifactBinding(),
      browserContext: context,
      fixtureBytes,
      fixtureDocument,
      page,
      requiredAssertions: fixtureDocument.requiredAssertions,
      requiredTelemetry: fixtureDocument.requiredTelemetry,
      sampleIndex: 0,
      scenarioId: fixtureDocument.scenarioId,
      targetUrl,
      warmup: false,
    });
    expect(result.assertions).toEqual({
      "worker-execution-observed": true,
      "single-terminal-result": true,
      "round-trip-semantic-parity": true,
      "single-atomic-download": true,
    });
    expect(result.executionBinding.setup).toMatchObject({
      method: "indexeddb-schema-exact-single-transaction-stage-v1",
      timing: "excluded-from-measurement-v1",
      readback: "separate-readonly-transaction-v1",
      itemCount: 20,
    });
  });

  test("executes the full-list family against the standard artifact", async ({
    context,
    page,
  }) => {
    const fixturePath = path.join(
      root,
      "scripts",
      "fixtures",
      "performance",
      "list-long-full.json",
    );
    const canonicalFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const fixtureDocument = {
      ...canonicalFixture,
      dataset: { ...canonicalFixture.dataset, rowCount: 80 },
    };
    const fixtureBytes = Buffer.from(JSON.stringify(fixtureDocument), "utf8");
    const result = await scenarioAdapters["list-long-full"]({
      adapterKind: "shopping-list-browser",
      artifactBinding: artifactBinding(),
      browserContext: context,
      fixtureBytes,
      fixtureDocument,
      page,
      requiredAssertions: fixtureDocument.requiredAssertions,
      requiredTelemetry: fixtureDocument.requiredTelemetry,
      sampleIndex: 0,
      scenarioId: fixtureDocument.scenarioId,
      targetUrl,
      warmup: false,
    });
    expect(result.assertions).toEqual({
      "selected-renderer-full": true,
      "canonical-row-model": true,
      "accessible-name-parity": true,
    });
  });
});
