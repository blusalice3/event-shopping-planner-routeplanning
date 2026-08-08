import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseAuthoritativeInputProducerArguments,
  runAuthoritativeInputProducerCli,
} from "./produce-protected-input.mjs";

const namespace = "producer-cli-test";
const storePolicy = {
  databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
};
const providerPolicy = {
  bindingStatus: "configured",
  expectedTeamId: "team-test",
  expectedProjectId: "project-test",
  ownedProductionDomains: ["app.example.test"],
  observationPolicy: {
    apiBaseUrl: "https://api.vercel.com",
    maxResponseAgeSeconds: 300,
    maxFutureClockSkewSeconds: 30,
  },
};
const env = {
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://role:secret@db.example.test/control?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "test-ca",
  VERCEL_TOKEN: "v".repeat(20),
};

const promotionArgv = [
  "promotion-subject",
  "--namespace",
  namespace,
  "--operation-id",
  "promote-cli",
  "--standard-binding",
  "standard.json",
  "--containment-binding",
  "containment.json",
  "--evidence-set",
  "evidence.json",
  "--output",
  "subject.json",
];

const providerArgv = [
  "provider-observation",
  "--namespace",
  namespace,
  "--output",
  "observation.json",
];

const createHarness = () => {
  const writes = [];
  const stdout = [];
  const store = {
    namespace,
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  return {
    writes,
    stdout,
    store,
    runtime: {
      env,
      cwd: "C:\\producer-test",
      stdout: {
        write(value) {
          stdout.push(value);
        },
      },
    },
    dependencies: {
      loadJson: async (filePath) =>
        filePath.endsWith("provider-policy.json")
          ? providerPolicy
          : storePolicy,
      readFileImpl: async (filePath) => Buffer.from(`bytes:${filePath}`),
      writeFileImpl: async (filePath, bytes, options) => {
        writes.push({ filePath, bytes: Buffer.from(bytes), options });
      },
      createStore: async (options) => {
        assert.equal(options.namespace, namespace);
        assert.equal(options.connectionString, env.RELEASE_STATE_DATABASE_URL);
        assert.equal(options.ca, env.RELEASE_STATE_DATABASE_CA_PEM);
        return store;
      },
    },
  };
};

test("parses only the closed command-specific flag sets", () => {
  assert.equal(
    parseAuthoritativeInputProducerArguments(promotionArgv).command,
    "promotion-subject",
  );
  assert.equal(
    parseAuthoritativeInputProducerArguments(providerArgv).command,
    "provider-observation",
  );
  assert.throws(
    () =>
      parseAuthoritativeInputProducerArguments([
        ...providerArgv,
        "--assignments",
        "caller.json",
      ]),
    /Invalid authoritative input command/,
  );
  assert.throws(
    () =>
      parseAuthoritativeInputProducerArguments([
        ...promotionArgv,
        "--snapshot",
        "snapshot.json",
      ]),
    /Invalid authoritative input command/,
  );
});

test("writes a new canonical promotion subject with wx and no derived caller fields", async () => {
  const harness = createHarness();
  const subjectBytes = canonicalJsonBytes({ kind: "subject" });
  let received;
  const result = await runAuthoritativeInputProducerCli(
    { ...harness.runtime, argv: promotionArgv },
    {
      ...harness.dependencies,
      buildPromotionSubject: async (options) => {
        received = options;
        return {
          subjectBytes,
          subjectSha256: sha256Bytes(subjectBytes),
        };
      },
    },
  );

  assert.equal(result.subjectSha256, sha256Bytes(subjectBytes));
  assert.equal(Object.hasOwn(received, "snapshot"), false);
  assert.equal(Object.hasOwn(received, "previousBinding"), false);
  assert.equal(Object.hasOwn(received, "expectedState"), false);
  assert.equal(received.operationId, "promote-cli");
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.writes[0].options, {
    flag: "wx",
    mode: 0o600,
  });
  assert.ok(harness.writes[0].bytes.equals(subjectBytes));
  assert.equal(harness.store.closed, true);
  assert.match(harness.stdout.join(""), /PASS authoritative promotion/);
});

test("collects provider authority without accepting assignment or binding files", async () => {
  const harness = createHarness();
  const observationBytes = canonicalJsonBytes({ kind: "observation" });
  let received;
  await runAuthoritativeInputProducerCli(
    { ...harness.runtime, argv: providerArgv },
    {
      ...harness.dependencies,
      buildProviderObservation: async (options) => {
        received = options;
        return {
          observationBytes,
          observationSha256: sha256Bytes(observationBytes),
        };
      },
    },
  );

  assert.equal(received.providerPolicy, providerPolicy);
  assert.equal(received.providerToken, env.VERCEL_TOKEN);
  assert.equal(Object.hasOwn(received, "assignments"), false);
  assert.equal(Object.hasOwn(received, "observedBinding"), false);
  assert.equal(harness.writes[0].options.flag, "wx");
  assert.ok(harness.writes[0].bytes.equals(observationBytes));
  assert.equal(harness.store.closed, true);
});

test("rejects namespace drift before opening the store", async () => {
  const harness = createHarness();
  let opened = false;
  await assert.rejects(
    runAuthoritativeInputProducerCli(
      {
        ...harness.runtime,
        argv: providerArgv,
        env: { ...env, RELEASE_STATE_NAMESPACE: "other-namespace" },
      },
      {
        ...harness.dependencies,
        createStore: async () => {
          opened = true;
          return harness.store;
        },
      },
    ),
    /differs from the producer environment/,
  );
  assert.equal(opened, false);
});
