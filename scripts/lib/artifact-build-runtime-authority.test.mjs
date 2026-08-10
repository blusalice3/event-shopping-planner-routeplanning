import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import { projectContainmentDimensions } from "./release-policy.mjs";
import { assertArtifactBuildRuntimeAuthority } from "./artifact-build-runtime-authority.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const sourceSha = "a".repeat(40);
const namespace = "foundation-release";
const reference = (value) => {
  const sha256 = sha256Json(value);
  return { uri: `release-state://${namespace}/evidence/${sha256}`, sha256 };
};

const fixture = async ({ purpose = "policy-activation-qa" } = {}) => {
  const [basePolicy, providerPolicy, toolchainPolicy, cspPolicy, dbContract] =
    await Promise.all([
      readJson("config/release-variants.json"),
      readJson("config/provider-policy.json"),
      readJson("config/toolchain-versions.json"),
      readJson("config/csp-policy.json"),
      readJson("config/db-compatibility-contract.json"),
    ]);
  const releasePolicy = {
    ...basePolicy,
    activationStatus: purpose === "production" ? "active" : "proposed",
    activationBlockers:
      purpose === "production" ? [] : ["policy-activation-review-required"],
  };
  const standardDimensions = {
    releaseRole: "standard",
    ...releasePolicy.acceptedStandardFloors,
  };
  const common = {
    schemaVersion: 1,
    requirementsKind: "authoritative-artifact-build-requirements/v1",
    namespace,
    operationId: "build-p1",
    purpose,
    buildPurpose:
      purpose === "production"
        ? "production"
        : "non-promotable-policy-activation-qa",
    promotable: purpose === "production",
    executorSourceSha: sourceSha,
    targetSourceSha: sourceSha,
    expectedState: { sequence: 10, eventHash: "b".repeat(64) },
    acceptedGate: "P0-RELEASE",
    targetGate: "P1-PWA",
    releasePolicy: reference(releasePolicy),
    providerPolicy: reference(providerPolicy),
    currentDbCompatibility: {
      contractUri: dbContract.contractUri,
      fingerprint: sha256Json(dbContract),
    },
    toolchainPolicy: reference(toolchainPolicy),
    cspPolicy: reference(cspPolicy),
    standardDimensions,
    containmentDimensions: projectContainmentDimensions(
      releasePolicy,
      standardDimensions,
    ),
  };
  const requirements =
    purpose === "production"
      ? common
      : {
          ...common,
          previousReleasePolicy: {
            uri: `release-state://${namespace}/evidence/${"c".repeat(64)}`,
            sha256: "c".repeat(64),
          },
          proposedReleasePolicy: common.releasePolicy,
          activeReleasePolicy: {
            uri: `release-state://${namespace}/evidence/${"d".repeat(64)}`,
            sha256: "d".repeat(64),
          },
        };
  const requirementsSha256 = sha256Bytes(canonicalJsonBytes(requirements));
  return {
    input: {
      requirements,
      requirementsReference: {
        uri: `release-state://${namespace}/evidence/${requirementsSha256}`,
        sha256: requirementsSha256,
      },
      sourceSha,
      releasePolicy,
      providerPolicy,
      toolchainPolicy,
      cspPolicy,
      dbContract,
    },
  };
};

test("accepts exact active production and proposed nonpromotable authorities", async () => {
  for (const purpose of ["production", "policy-activation-qa"]) {
    const { input } = await fixture({ purpose });
    const result = assertArtifactBuildRuntimeAuthority(input);
    assert.equal(result.buildPurpose, input.requirements.buildPurpose);
    assert.equal(result.promotable, purpose === "production");
    assert.equal(result.targetGate, "P1-PWA");
  }
});

test("rejects source, policy, DB, dimension, and reviewed hash drift", async () => {
  const mutations = [
    (input) => {
      input.sourceSha = "f".repeat(40);
    },
    (input) => {
      input.releasePolicy.acceptedStandardFloors.listRender = "full";
    },
    (input) => {
      input.dbContract.contractUri = "postgresql://different.invalid/db";
    },
    (input) => {
      input.requirements.standardDimensions.listRender = "full";
    },
    (input) => {
      input.requirementsReference.sha256 = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const { input } = await fixture();
    mutate(input);
    assert.throws(() => assertArtifactBuildRuntimeAuthority(input));
  }
});

test("rejects proposed production and promotable Policy QA identities", async () => {
  const production = await fixture({ purpose: "production" });
  production.input.releasePolicy.activationStatus = "proposed";
  production.input.releasePolicy.activationBlockers = ["still-proposed"];
  production.input.requirements.releasePolicy = reference(
    production.input.releasePolicy,
  );
  production.input.requirementsReference = reference(
    production.input.requirements,
  );
  assert.throws(
    () => assertArtifactBuildRuntimeAuthority(production.input),
    /not active and promotable/,
  );

  const legacyBlockerField = await fixture({ purpose: "production" });
  legacyBlockerField.input.releasePolicy.blockerCodes = [];
  legacyBlockerField.input.requirements.releasePolicy = reference(
    legacyBlockerField.input.releasePolicy,
  );
  legacyBlockerField.input.requirementsReference = reference(
    legacyBlockerField.input.requirements,
  );
  assert.throws(
    () => assertArtifactBuildRuntimeAuthority(legacyBlockerField.input),
    /noncanonical blocker authority/,
  );

  const qa = await fixture();
  qa.input.requirements.promotable = true;
  qa.input.requirementsReference = reference(qa.input.requirements);
  assert.throws(
    () => assertArtifactBuildRuntimeAuthority(qa.input),
    /QA build authority is invalid/,
  );
});
