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
const env = {
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "200",
  GITHUB_TOKEN: "github-token-fixture",
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
const policyActivationArgv = [
  "policy-activation-subject",
  "--namespace",
  namespace,
  "--operation-id",
  "activate-p1-policy",
  "--source-sha",
  "a".repeat(40),
  "--proposed-policy-sha256",
  "b".repeat(64),
  "--active-policy-sha256",
  "c".repeat(64),
  "--closure-bundle-sha256",
  "d".repeat(64),
  "--output",
  "policy-activation-subject.json",
];
const policyQaPackageArgv = [
  "policy-activation-qa-package",
  "--namespace",
  namespace,
  "--operation-id",
  "activate-p1-policy-qa",
  "--source-sha",
  "a".repeat(40),
  "--target-source-sha",
  "b".repeat(40),
  "--activation-gate",
  "P1-PWA",
  "--build-requirements-sha256",
  "d".repeat(64),
  "--proposed-policy-sha256",
  "c".repeat(64),
  "--standard-manifest",
  "standard-manifest.json",
  "--standard-archive",
  "standard.zip",
  "--companion-manifest",
  "companion-manifest.json",
  "--companion-archive",
  "companion.zip",
  "--output",
  "policy-qa-package.json",
];
const productionBuildRequirementsArgv = [
  "artifact-build-requirements",
  "--namespace",
  namespace,
  "--operation-id",
  "build-p1-candidate",
  "--source-sha",
  "a".repeat(40),
  "--target-source-sha",
  "a".repeat(40),
  "--output",
  "artifact-build-requirements.json",
];
const policyQaBuildRequirementsArgv = [
  "policy-activation-qa-build-requirements",
  "--namespace",
  namespace,
  "--operation-id",
  "build-p1-policy-qa",
  "--source-sha",
  "a".repeat(40),
  "--target-source-sha",
  "b".repeat(40),
  "--proposed-policy-sha256",
  "c".repeat(64),
  "--active-policy-sha256",
  "d".repeat(64),
  "--output",
  "policy-qa-build-requirements.json",
];
const policyActivationClosureArgv = [
  "policy-activation-closure",
  "--namespace",
  namespace,
  "--operation-id",
  "activate-p1-policy",
  "--source-sha",
  "a".repeat(40),
  "--qa-execution-sha256",
  "e".repeat(64),
  "--output",
  "policy-activation-closure.json",
];
const prepromotionSourceBytes = canonicalJsonBytes({ source: "reviewed" });
const prepromotionArgv = [
  "prepromotion-evidence-set",
  "--namespace",
  namespace,
  "--source",
  "prepromotion-source.json",
  "--source-sha",
  "a".repeat(40),
  "--source-sha256",
  sha256Bytes(prepromotionSourceBytes),
  "--output",
  "prepromotion-evidence-set.json",
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
        filePath.endsWith("approval-policy.json")
          ? { repository: "owner/repository" }
          : storePolicy,
      readFileImpl: async (filePath) =>
        filePath.endsWith("prepromotion-source.json")
          ? prepromotionSourceBytes
          : Buffer.from(`bytes:${filePath}`),
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
  assert.equal(
    parseAuthoritativeInputProducerArguments(prepromotionArgv).command,
    "prepromotion-evidence-set",
  );
  assert.equal(
    parseAuthoritativeInputProducerArguments(policyActivationArgv).command,
    "policy-activation-subject",
  );
  assert.equal(
    parseAuthoritativeInputProducerArguments(policyQaPackageArgv).command,
    "policy-activation-qa-package",
  );
  assert.equal(
    parseAuthoritativeInputProducerArguments(productionBuildRequirementsArgv)
      .command,
    "artifact-build-requirements",
  );
  assert.equal(
    parseAuthoritativeInputProducerArguments(policyQaBuildRequirementsArgv)
      .command,
    "policy-activation-qa-build-requirements",
  );
  assert.equal(
    parseAuthoritativeInputProducerArguments(policyActivationClosureArgv)
      .command,
    "policy-activation-closure",
  );
  assert.throws(
    () =>
      parseAuthoritativeInputProducerArguments([
        ...policyActivationClosureArgv.slice(0, -2),
        "--proposed-policy-sha256",
        "b".repeat(64),
        ...policyActivationClosureArgv.slice(-2),
      ]),
    /Invalid authoritative input command/,
  );
  assert.throws(
    () =>
      parseAuthoritativeInputProducerArguments([
        ...productionBuildRequirementsArgv.slice(0, -2),
        "--standard-dimensions",
        "caller.json",
      ]),
    /Invalid or duplicate authoritative input flag/,
  );
  assert.throws(
    () =>
      parseAuthoritativeInputProducerArguments([
        ...policyActivationArgv,
        "--minimum-safety-floors",
        "caller.json",
      ]),
    /Invalid authoritative input command/,
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

test("writes a reviewed pre-promotion evidence set with create-only semantics", async () => {
  const harness = createHarness();
  const evidenceSetBytes = canonicalJsonBytes({ evidence: "set" });
  let received;
  const result = await runAuthoritativeInputProducerCli(
    { ...harness.runtime, argv: prepromotionArgv },
    {
      ...harness.dependencies,
      buildPrePromotionEvidenceSet: async (options) => {
        received = options;
        return {
          evidenceSetBytes,
          evidenceSetSha256: sha256Bytes(evidenceSetBytes),
        };
      },
    },
  );
  assert.equal(received.sourceSha, "a".repeat(40));
  assert.equal(
    received.expectedSourceSha256,
    sha256Bytes(prepromotionSourceBytes),
  );
  assert.ok(received.sourceBytes.equals(prepromotionSourceBytes));
  assert.equal(received.currentRunId, "200");
  assert.equal(received.githubToken, "github-token-fixture");
  assert.equal(received.repository, "owner/repository");
  assert.equal(result.evidenceSetSha256, sha256Bytes(evidenceSetBytes));
  assert.ok(harness.writes[0].bytes.equals(evidenceSetBytes));
  assert.equal(harness.writes[0].options.flag, "wx");
  assert.equal(harness.store.closed, true);
});

test("writes a three-reference policy activation subject without caller authority", async () => {
  const harness = createHarness();
  const subjectBytes = canonicalJsonBytes({ kind: "policy-activation" });
  let received;
  const result = await runAuthoritativeInputProducerCli(
    { ...harness.runtime, argv: policyActivationArgv },
    {
      ...harness.dependencies,
      buildPolicyActivationSubject: async (options) => {
        received = options;
        return {
          subjectBytes,
          subjectSha256: sha256Bytes(subjectBytes),
        };
      },
    },
  );
  assert.equal(received.operationId, "activate-p1-policy");
  assert.equal(received.executorSourceSha, "a".repeat(40));
  assert.equal(received.proposedPolicySha256, "b".repeat(64));
  assert.equal(received.activePolicySha256, "c".repeat(64));
  assert.equal(received.closureBundleSha256, "d".repeat(64));
  assert.equal(Object.hasOwn(received, "minimumSafetyFloors"), false);
  assert.equal(Object.hasOwn(received, "acceptedEvent"), false);
  assert.equal(result.subjectSha256, sha256Bytes(subjectBytes));
  assert.ok(harness.writes[0].bytes.equals(subjectBytes));
  assert.deepEqual(harness.writes[0].options, {
    flag: "wx",
    mode: 0o600,
  });
  assert.match(
    harness.stdout.join(""),
    /PASS authoritative policy activation subject/,
  );
  assert.equal(harness.store.closed, true);
});

test("builds a nonpromotable policy QA pair from four reviewed artifact files", async () => {
  const harness = createHarness();
  const indexBytes = canonicalJsonBytes({
    packageKind: "policy-activation-qa-pair",
    promotable: false,
  });
  let received;
  const result = await runAuthoritativeInputProducerCli(
    { ...harness.runtime, argv: policyQaPackageArgv },
    {
      ...harness.dependencies,
      buildPolicyQaPackage: async (options) => {
        received = options;
        return {
          indexBytes,
          indexSha256: sha256Bytes(indexBytes),
        };
      },
    },
  );
  assert.equal(received.executorSourceSha, "a".repeat(40));
  assert.equal(received.targetSourceSha, "b".repeat(40));
  assert.equal(received.activationGate, "P1-PWA");
  assert.equal(received.proposedPolicyReference.sha256, "c".repeat(64));
  assert.equal(received.buildRequirementsReference.sha256, "d".repeat(64));
  assert.ok(
    received.standardManifestBytes.equals(
      Buffer.from("bytes:C:\\producer-test\\standard-manifest.json"),
    ),
  );
  assert.ok(
    received.companionArchiveBytes.equals(
      Buffer.from("bytes:C:\\producer-test\\companion.zip"),
    ),
  );
  assert.equal(result.indexSha256, sha256Bytes(indexBytes));
  assert.ok(harness.writes[0].bytes.equals(indexBytes));
  assert.equal(harness.writes[0].options.flag, "wx");
  assert.match(harness.stdout.join(""), /nonpromotable policy activation QA/);
  assert.equal(harness.store.closed, true);
});

test("builds policy closure from only the reviewed QA execution reference", async () => {
  const harness = createHarness();
  const bundleBytes = canonicalJsonBytes({
    bundleKind: "policy-activation-closure/v1",
  });
  let received;
  const result = await runAuthoritativeInputProducerCli(
    { ...harness.runtime, argv: policyActivationClosureArgv },
    {
      ...harness.dependencies,
      buildPolicyActivationClosure: async (options) => {
        received = options;
        return {
          bundleBytes,
          bundleSha256: sha256Bytes(bundleBytes),
        };
      },
    },
  );
  assert.equal(received.operationId, "activate-p1-policy");
  assert.equal(received.executorSourceSha, "a".repeat(40));
  assert.equal(received.qaExecutionReference.sha256, "e".repeat(64));
  for (const forbidden of [
    "proposedPolicyReference",
    "activePolicyReference",
    "approvalPolicyReference",
    "qaPackageReference",
  ]) {
    assert.equal(Object.hasOwn(received, forbidden), false);
  }
  assert.equal(result.bundleSha256, sha256Bytes(bundleBytes));
  assert.ok(harness.writes[0].bytes.equals(bundleBytes));
  assert.equal(harness.store.closed, true);
});

test("writes production and Policy QA build requirements from authoritative state only", async () => {
  for (const [argv, expected] of [
    [
      productionBuildRequirementsArgv,
      {
        purpose: "production",
        targetSourceSha: "a".repeat(40),
        hasPolicyReferences: false,
      },
    ],
    [
      policyQaBuildRequirementsArgv,
      {
        purpose: "policy-activation-qa",
        targetSourceSha: "b".repeat(40),
        hasPolicyReferences: true,
      },
    ],
  ]) {
    const harness = createHarness();
    const requirementsBytes = canonicalJsonBytes({
      requirementsKind: "authoritative-artifact-build-requirements/v1",
      purpose: expected.purpose,
    });
    let received;
    const result = await runAuthoritativeInputProducerCli(
      { ...harness.runtime, argv },
      {
        ...harness.dependencies,
        buildArtifactBuildRequirements: async (options) => {
          received = options;
          return {
            requirementsBytes,
            requirementsSha256: sha256Bytes(requirementsBytes),
          };
        },
      },
    );

    assert.equal(received.purpose, expected.purpose);
    assert.equal(received.executorSourceSha, "a".repeat(40));
    assert.equal(received.targetSourceSha, expected.targetSourceSha);
    assert.equal(
      Object.hasOwn(received, "proposedPolicyReference"),
      expected.hasPolicyReferences,
    );
    assert.equal(
      Object.hasOwn(received, "activePolicyReference"),
      expected.hasPolicyReferences,
    );
    assert.equal(Object.hasOwn(received, "standardDimensions"), false);
    assert.ok(Buffer.isBuffer(received.toolchainPolicyBytes));
    assert.ok(Buffer.isBuffer(received.cspPolicyBytes));
    assert.equal(result.requirementsSha256, sha256Bytes(requirementsBytes));
    assert.ok(harness.writes[0].bytes.equals(requirementsBytes));
    assert.deepEqual(harness.writes[0].options, {
      flag: "wx",
      mode: 0o600,
    });
    assert.equal(harness.store.closed, true);
  }
});

test("rejects production build requirements when executor and target sources differ", () => {
  assert.throws(
    () =>
      parseAuthoritativeInputProducerArguments([
        ...productionBuildRequirementsArgv.slice(0, 8),
        "b".repeat(40),
        ...productionBuildRequirementsArgv.slice(9),
      ]),
    /incomplete or invalid/,
  );
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

  assert.equal(Object.hasOwn(received, "providerPolicy"), false);
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
