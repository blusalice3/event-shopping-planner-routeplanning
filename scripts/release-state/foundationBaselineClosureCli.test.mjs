import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseFoundationBaselineClosureArguments,
  runFoundationBaselineClosureCli,
} from "./produce-foundation-baseline-closure.mjs";

const namespace = "foundation-baseline-cli-test";
const sourceSha = "a".repeat(40);
const bootstrapSourceSha = "b".repeat(40);
const rawDistBytes = canonicalJsonBytes({
  schemaVersion: 1,
  treeSha256: "c".repeat(64),
  files: [{ path: "index.html", sha256: "d".repeat(64), size: 1 }],
});
const hash = (character) => character.repeat(64);
const reference = (sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const argv = ({ rawDistSha256 = sha256Bytes(rawDistBytes) } = {}) => [
  "--namespace",
  namespace,
  "--source-sha",
  sourceSha,
  "--bootstrap-source-sha",
  bootstrapSourceSha,
  "--run-id",
  "123",
  "--provider-binding-sha256",
  hash("1"),
  "--provider-observation-sha256",
  hash("2"),
  "--provider-policy-sha256",
  hash("3"),
  "--raw-dist-manifest",
  "raw-dist.json",
  "--raw-dist-manifest-sha256",
  rawDistSha256,
  "--recovery-rehearsal-sha256",
  hash("4"),
  "--output",
  "closure-result.json",
];

test("parser requires the exact closed argument set", () => {
  const parsed = parseFoundationBaselineClosureArguments(argv());
  assert.equal(parsed["--bootstrap-source-sha"], bootstrapSourceSha);
  for (const invalid of [
    [...argv(), "--passed", "true"],
    argv().with(1, "invalid_namespace"),
    argv().with(argv().indexOf("--provider-policy-sha256") + 1, "f"),
    argv().with(argv().indexOf("--source-sha"), "--caller-status"),
  ]) {
    assert.throws(
      () => parseFoundationBaselineClosureArguments(invalid),
      /argument|flag|identity/u,
    );
  }
});

test("CLI forwards only validated live resolutions and writes canonical create-only output", async () => {
  const store = {
    namespace,
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  const sourceResolution = { branded: "source" };
  const bootstrapResolution = { branded: "bootstrap" };
  const historicalResolution = { branded: "historical" };
  const policyResolution = { branded: "policies" };
  const producerResolution = { branded: "producer-oidc" };
  const closureResolution = { branded: "closure" };
  const closureReference = reference(hash("9"));
  const producerReference = reference(hash("8"));
  let unchangedChecks = 0;
  let written = null;
  let closureArguments = null;
  const stdout = [];
  const result = await runFoundationBaselineClosureCli(
    {
      argv: argv(),
      env: {
        REQUESTED_OPERATION: "produce-foundation-baseline-closure",
        RELEASE_STATE_DATABASE_URL: "control-secret",
        RELEASE_STATE_DATABASE_CA_PEM: "control-ca",
        APP_DATABASE_URL: "application-secret",
        APP_DATABASE_CA: "application-ca",
        GITHUB_RUN_ATTEMPT: "2",
      },
      cwd: "C:\\fixture",
      stdout: { write: (value) => stdout.push(value) },
    },
    {
      loadJson: async (filePath) => {
        if (filePath.endsWith("approval-policy.json"))
          return { approval: true };
        if (filePath.endsWith("release-state-store.json")) {
          return { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" };
        }
        if (filePath.endsWith("db-compatibility-contract.json")) {
          return {
            remote: {
              observationAuthority: {
                databaseUrlEnvironmentName: "APP_DATABASE_URL",
                databaseCaEnvironmentName: "APP_DATABASE_CA",
              },
            },
          };
        }
        if (filePath.endsWith("provider-policy.json"))
          return { provider: true };
        return { historical: true };
      },
      assertEnvironment: () => undefined,
      verifyBaseline: () => undefined,
      readRawDistManifest: async () => ({
        bytes: rawDistBytes,
        async assertUnchanged() {
          unchangedChecks += 1;
        },
      }),
      createStore: async () => store,
      resolveSource: ({ expectedSourceSha }) => {
        assert.equal(expectedSourceSha, sourceSha);
        return sourceResolution;
      },
      resolveBootstrapSource: ({ bootstrapSourceSha: actual }) => {
        assert.equal(actual, bootstrapSourceSha);
        return bootstrapResolution;
      },
      resolveHistorical: () => historicalResolution,
      resolvePolicies: (options) => {
        assert.equal(options.store, store);
        assert.equal(options.controlStoreConnectionString, "control-secret");
        assert.equal(
          options.applicationDatabaseConnectionString,
          "application-secret",
        );
        return policyResolution;
      },
      collectOidcReceipt: async ({ sourceSha: actual, runId }) => {
        assert.equal(actual, sourceSha);
        assert.equal(runId, "123");
        return Buffer.from("verified oidc receipt");
      },
      storeOidcReceipt: async ({ runAttempt }) => {
        assert.equal(runAttempt, "2");
        return { reference: producerReference };
      },
      resolveProducerOidc: async (options) => {
        assert.equal(options.reference, producerReference);
        assert.equal(options.sourceResolution, sourceResolution);
        return producerResolution;
      },
      resolveClosure: async (options) => {
        closureArguments = options;
        return closureResolution;
      },
      storeClosure: async ({ store: actualStore, resolution }) => {
        assert.equal(actualStore, store);
        assert.equal(resolution, closureResolution);
        return { reference: closureReference };
      },
      writeFileImpl: async (filePath, bytes, options) => {
        written = { filePath, bytes: Buffer.from(bytes), options };
      },
      now: () => 123_456,
    },
  );
  assert.equal(closureArguments.sourceResolution, sourceResolution);
  assert.equal(closureArguments.bootstrapSourceResolution, bootstrapResolution);
  assert.equal(closureArguments.producerOidcResolution, producerResolution);
  assert.deepEqual(
    closureArguments.providerBindingReference,
    reference(hash("1")),
  );
  assert.equal(unchangedChecks, 2);
  assert.deepEqual(written.options, { flag: "wx", mode: 0o600 });
  assert.equal(written.bytes.equals(canonicalJsonBytes(result)), true);
  assert.equal(stdout.join(""), `${written.bytes.toString("utf8")}\n`);
  assert.equal(store.closed, true);
});

test("CLI rejects a caller SHA that does not match the exact raw manifest", async () => {
  let storeCreated = false;
  await assert.rejects(
    runFoundationBaselineClosureCli(
      {
        argv: argv({ rawDistSha256: hash("f") }),
        env: { REQUESTED_OPERATION: "produce-foundation-baseline-closure" },
        cwd: "C:\\fixture",
      },
      {
        loadJson: async (filePath) =>
          filePath.endsWith("approval-policy.json")
            ? {}
            : filePath.endsWith("release-state-store.json")
              ? { databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL" }
              : filePath.endsWith("db-compatibility-contract.json")
                ? { remote: { observationAuthority: {} } }
                : {},
        assertEnvironment: () => undefined,
        verifyBaseline: () => undefined,
        readRawDistManifest: async () => ({
          bytes: rawDistBytes,
          assertUnchanged: async () => undefined,
        }),
        createStore: async () => {
          storeCreated = true;
          return {};
        },
      },
    ),
    /reviewed SHA-256/u,
  );
  assert.equal(storeCreated, false);
});
