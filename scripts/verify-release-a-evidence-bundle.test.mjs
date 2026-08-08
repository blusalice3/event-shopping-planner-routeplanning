import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  BUNDLE_KEYS,
  assertReleaseEvidenceBundleEnvelope,
  verifyReleaseAEvidenceBundle,
} from "./verify-release-a-evidence-bundle.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const objectSha = "a".repeat(64);
const namespace = "foundation-release";
const evidenceReference = {
  uri: `release-state://${namespace}/evidence/${objectSha}`,
  sha256: objectSha,
};
const eventReference = {
  uri: `release-state://${namespace}/events/1/${objectSha}`,
  sha256: objectSha,
};

const writeObject = async (objectsPath, value) => {
  const bytes = canonicalJsonBytes(value);
  const sha256 = sha256Bytes(bytes);
  await writeFile(path.join(objectsPath, `${sha256}.json`), bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const makeEnvelope = () => ({
  approvals: [],
  artifactManifest: evidenceReference,
  dbCompatibilityContract: evidenceReference,
  kind: "release-evidence-bundle/v1",
  packageIndex: evidenceReference,
  providerAssignmentEvidence: null,
  providerDeploymentEvidence: evidenceReference,
  providerPolicy: evidenceReference,
  releasePolicy: evidenceReference,
  releaseRole: "standard",
  releaseStateEvent: eventReference,
  schemaVersion: 1,
  sourceSha,
  stage: "pre-promotion",
  v1Evidence: evidenceReference,
});

test("closed envelope keys stay identical to the frozen schema", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../contracts/release-evidence-bundle-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual([...schema.required].sort(), BUNDLE_KEYS);
  assert.equal(schema.additionalProperties, false);
  assert.doesNotThrow(() =>
    assertReleaseEvidenceBundleEnvelope(makeEnvelope()),
  );
});

test("rejects missing v1 evidence and unknown envelope fields", () => {
  const missing = makeEnvelope();
  delete missing.v1Evidence;
  assert.throws(
    () => assertReleaseEvidenceBundleEnvelope(missing),
    /identity is invalid/,
  );
  assert.throws(
    () =>
      assertReleaseEvidenceBundleEnvelope({
        ...makeEnvelope(),
        unreviewed: true,
      }),
    /identity is invalid/,
  );
});

test("rejects an immutable object whose bytes differ from its reference", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "release-evidence-bundle-"),
  );
  try {
    const bundlePath = path.join(directory, "bundle.json");
    const objectsPath = path.join(directory, "objects");
    await mkdir(objectsPath, { recursive: true });
    await writeFile(bundlePath, JSON.stringify(makeEnvelope()), "utf8");
    await writeFile(path.join(objectsPath, `${objectSha}.json`), "{}", "utf8");
    await assert.rejects(
      verifyReleaseAEvidenceBundle({
        bundlePath,
        objectDirectory: objectsPath,
        validateV1Evidence: () => [],
      }),
      /Evidence object hash mismatch/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("accepts a complete pre-promotion immutable hash chain", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "release-evidence-bundle-valid-"),
  );
  try {
    const bundlePath = path.join(directory, "bundle.json");
    const objectsPath = path.join(directory, "objects");
    await mkdir(objectsPath, { recursive: true });

    const variantId = "b".repeat(64);
    const providerConfigurationHash = "c".repeat(64);
    const dbContract = {
      contractUri: "urn:event-shopping-planner:test-db:v1",
      schemaVersion: 1,
    };
    const requiredDbCompatibility = {
      contractUri: dbContract.contractUri,
      fingerprint: sha256Json(dbContract),
    };
    const releasePolicy = { policyKind: "test-release-policy/v1" };
    const providerPolicy = {
      ownedProductionDomains: ["release.example.test"],
      policyKind: "test-provider-policy/v1",
    };
    const releasePolicyHash = sha256Json(releasePolicy);
    const providerPolicyHash = sha256Json(providerPolicy);
    const artifactManifest = {
      buildId: sourceSha,
      providerConfigurationHash,
      providerPolicyHash,
      publicIdentityKind: "release-identity-v1",
      releasePolicyHash,
      releaseRole: "standard",
      requiredDbCompatibility,
      sourceSha,
      variantId,
    };
    const artifactManifestReference = await writeObject(
      objectsPath,
      artifactManifest,
    );
    const packageIndex = {
      artifacts: [
        {
          manifest: { sha256: artifactManifestReference.sha256 },
          releaseRole: "standard",
          variantId,
        },
      ],
      buildId: sourceSha,
      packageKind: "source-hardened-pair",
      providerConfigurationHash,
      providerPolicyHash,
      releasePolicyHash,
      requiredDbCompatibility,
      sourceSha,
    };
    const packageIndexReference = await writeObject(objectsPath, packageIndex);
    const identity = {
      buildId: sourceSha,
      releaseRole: "standard",
      requiredDbCompatibilityFingerprint: requiredDbCompatibility.fingerprint,
      schemaVersion: 1,
      sourceSha,
      variantId,
    };
    const providerEvidence = {
      artifactManifestHash: artifactManifestReference.sha256,
      packageIndexHash: packageIndexReference.sha256,
      providerConfigurationHash,
      providerDeploymentId: "deployment-test-standard",
      providerPolicyHash,
      providerProjectId: "project-test",
      publicIdentity: {
        identity,
        identityKind: "release-identity-v1",
        identitySha256: sha256Json(identity),
      },
      releasePolicyHash,
      releaseRole: "standard",
      requiredDbCompatibility,
      sourceSha,
      variantId,
    };
    const releaseStateEvent = {
      approvalRefs: [],
      namespace,
      operationId: "prepare-test-standard",
      payload: {},
      payloadSha256: sha256Json({}),
      schemaVersion: 1,
      sequence: 1,
    };
    const v1Evidence = {
      canary: { buildSha: sourceSha },
      release: { commitSha: sourceSha },
    };

    const [
      v1EvidenceReference,
      providerEvidenceReference,
      dbContractReference,
      releasePolicyReference,
      providerPolicyReference,
      releaseStateEvidenceReference,
    ] = await Promise.all([
      writeObject(objectsPath, v1Evidence),
      writeObject(objectsPath, providerEvidence),
      writeObject(objectsPath, dbContract),
      writeObject(objectsPath, releasePolicy),
      writeObject(objectsPath, providerPolicy),
      writeObject(objectsPath, releaseStateEvent),
    ]);
    const releaseStateEventReference = {
      ...releaseStateEvidenceReference,
      uri: `release-state://${namespace}/events/1/${releaseStateEvidenceReference.sha256}`,
    };
    const bundle = {
      approvals: [],
      artifactManifest: artifactManifestReference,
      dbCompatibilityContract: dbContractReference,
      kind: "release-evidence-bundle/v1",
      packageIndex: packageIndexReference,
      providerAssignmentEvidence: null,
      providerDeploymentEvidence: providerEvidenceReference,
      providerPolicy: providerPolicyReference,
      releasePolicy: releasePolicyReference,
      releaseRole: "standard",
      releaseStateEvent: releaseStateEventReference,
      schemaVersion: 1,
      sourceSha,
      stage: "pre-promotion",
      v1Evidence: v1EvidenceReference,
    };
    await writeFile(bundlePath, canonicalJsonBytes(bundle));

    const result = await verifyReleaseAEvidenceBundle({
      bundlePath,
      objectDirectory: objectsPath,
      validateV1Evidence: () => [],
    });
    assert.deepEqual(result, {
      immutableObjectCount: 8,
      releaseRole: "standard",
      sourceSha,
      stage: "pre-promotion",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
