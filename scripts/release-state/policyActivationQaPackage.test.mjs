import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeterministicZip } from "../deterministic-zip.mjs";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  assertReleasePackageIndex,
  computeRoleEntryGraphHash,
} from "../lib/artifact-contract.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import { ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE } from "./artifactBuildAuthority.mjs";
import {
  buildPolicyActivationQaPackage,
  validatePolicyActivationQaPackage,
} from "./policyActivationQaPackage.mjs";

const namespace = "foundation-production";
const executorSourceSha = "e".repeat(40);
const targetSourceSha = "a".repeat(40);

const createStore = () => {
  const objects = new Map();
  let puts = 0;
  return {
    namespace,
    get puts() {
      return puts;
    },
    async putEvidence({ bytes, mediaType }) {
      puts += 1;
      const sha256 = sha256Bytes(bytes);
      const replayed = objects.has(sha256);
      objects.set(sha256, { bytes: Buffer.from(bytes), mediaType });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        byteLength: bytes.length,
        mediaType,
        replayed,
        committedAt: "2026-08-09T05:00:00.000Z",
      };
    },
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { bytes: Buffer.from(stored.bytes), mediaType: stored.mediaType };
    },
  };
};

const putPolicy = async (store, policy) => {
  const bytes = canonicalJsonBytes(policy);
  const receipt = await store.putEvidence({
    bytes,
    mediaType:
      "application/vnd.event-shopping-planner.release-policy+json;version=1",
  });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const buildManifest = ({
  policy,
  policyReference,
  buildRequirementsReference,
  role,
  bytes,
}) => {
  const dimensions =
    role === "standard"
      ? { releaseRole: "standard", ...policy.acceptedStandardFloors }
      : projectContainmentDimensions(policy, {
          releaseRole: "standard",
          ...policy.acceptedStandardFloors,
        });
  const variantId = computeVariantId(policy, dimensions);
  const fileHash = sha256Bytes(bytes);
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "legacy-static-entry-v1",
    sourceSha: targetSourceSha,
    releaseRole: role,
    variantId,
    entryModule: "src/entry.ts",
    entryFile: "/index.html",
    modules: [
      {
        id: "src/entry.ts",
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: "/index.html",
        sha256: fileHash,
        size: bytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: ["src/entry.ts"],
      },
    ],
  };
  return {
    schemaVersion: 1,
    sourceSha: targetSourceSha,
    buildId: targetSourceSha,
    variantId,
    releaseRole: role,
    dimensions,
    buildInputClosureHash: "1".repeat(64),
    lockfileSha256: "2".repeat(64),
    toolchainPolicyHash: "3".repeat(64),
    publicBuildEnvHash: "4".repeat(64),
    providerConfigurationHash: "5".repeat(64),
    providerPolicyHash: "6".repeat(64),
    releasePolicyHash: policyReference.sha256,
    requiredDbCompatibility: {
      contractUri: "urn:event-shopping-planner:db:v1",
      fingerprint: "7".repeat(64),
    },
    buildAuthority: buildRequirementsReference,
    targetGate: "P1-PWA",
    buildPurpose: "non-promotable-policy-activation-qa",
    promotable: false,
    publicIdentityKind: "release-identity-v1",
    bootstrap: null,
    publicResponseHashes: { "/": fileHash },
    roleEntryGraph,
    roleEntryGraphHash: computeRoleEntryGraphHash(roleEntryGraph),
    outputFiles: [{ path: "index.html", sha256: fileHash, size: bytes.length }],
  };
};

const buildFixture = async () => {
  const [policy, archivePolicy] = await Promise.all([
    readFile(
      new URL("../../config/release-variants.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL("../../config/artifact-archive-policy.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  const store = createStore();
  const proposedPolicyReference = await putPolicy(store, policy);
  const buildRequirements = {
    purpose: "policy-activation-qa",
    buildPurpose: "non-promotable-policy-activation-qa",
    promotable: false,
    targetGate: "P1-PWA",
    proposedReleasePolicy: proposedPolicyReference,
  };
  const requirementsBytes = canonicalJsonBytes(buildRequirements);
  const requirementsReceipt = await store.putEvidence({
    bytes: requirementsBytes,
    mediaType: ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  });
  const buildRequirementsReference = {
    uri: requirementsReceipt.uri,
    sha256: requirementsReceipt.sha256,
  };
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-policy-qa-package-"),
  );
  const artifacts = [];
  for (const role of ["standard", "containment"]) {
    const sourceDirectory = path.join(temporaryRoot, role);
    await mkdir(sourceDirectory, { recursive: true });
    const bytes = Buffer.from(`<html>${role}</html>`, "utf8");
    await writeFile(path.join(sourceDirectory, "index.html"), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    const archivePath = path.join(temporaryRoot, `${role}.zip`);
    await createDeterministicZip({
      sourceDirectory,
      outputPath: archivePath,
      policy: archivePolicy,
    });
    const manifest = buildManifest({
      policy,
      policyReference: proposedPolicyReference,
      buildRequirementsReference,
      role,
      bytes,
    });
    artifacts.push({
      manifestBytes: canonicalJsonBytes(manifest),
      archiveBytes: await readFile(archivePath),
    });
  }
  return {
    store,
    policy,
    proposedPolicyReference,
    buildRequirements,
    buildRequirementsReference,
    temporaryRoot,
    standard: artifacts[0],
    companion: artifacts[1],
  };
};

test("builds and revalidates a deterministic nonpromotable policy QA pair", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const validateBuildRequirements = async () => ({
    requirements: fixture.buildRequirements,
  });
  const result = await buildPolicyActivationQaPackage(
    {
      store: fixture.store,
      namespace,
      operationId: "policy-activation-p1",
      executorSourceSha,
      targetSourceSha,
      activationGate: "P1-PWA",
      proposedPolicyReference: fixture.proposedPolicyReference,
      buildRequirementsReference: fixture.buildRequirementsReference,
      standardManifestBytes: fixture.standard.manifestBytes,
      standardArchiveBytes: fixture.standard.archiveBytes,
      companionManifestBytes: fixture.companion.manifestBytes,
      companionArchiveBytes: fixture.companion.archiveBytes,
    },
    { validateBuildRequirements },
  );
  const validated = await validatePolicyActivationQaPackage(
    {
      store: fixture.store,
      namespace,
      packageReference: result.indexReference,
      proposedPolicy: fixture.policy,
      proposedPolicyReference: fixture.proposedPolicyReference,
      activationGate: "P1-PWA",
      executorSourceSha,
    },
    { validateBuildRequirements },
  );
  assert.equal(validated.promotable, false);
  assert.equal(validated.buildPurpose, "non-promotable-policy-activation-qa");
  assert.equal(validated.artifacts.length, 2);
  assert.throws(
    () => assertReleasePackageIndex(validated),
    /unexpected property set|packageKind/,
  );
});

test("rejects archive tamper before publishing a QA package index", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const putsBefore = fixture.store.puts;
  const tampered = Buffer.from(fixture.standard.archiveBytes);
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(
    buildPolicyActivationQaPackage(
      {
        store: fixture.store,
        namespace,
        operationId: "policy-activation-p1-tamper",
        executorSourceSha,
        targetSourceSha,
        activationGate: "P1-PWA",
        proposedPolicyReference: fixture.proposedPolicyReference,
        buildRequirementsReference: fixture.buildRequirementsReference,
        standardManifestBytes: fixture.standard.manifestBytes,
        standardArchiveBytes: tampered,
        companionManifestBytes: fixture.companion.manifestBytes,
        companionArchiveBytes: fixture.companion.archiveBytes,
      },
      {
        validateBuildRequirements: async () => ({
          requirements: fixture.buildRequirements,
        }),
      },
    ),
    /ZIP|archive|Invalid comment/i,
  );
  assert.equal(fixture.store.puts, putsBefore);
});

test("rejects the P8 floor-only transition before reading or publishing QA artifacts", async () => {
  const fixture = await buildFixture();
  try {
    const putsBefore = fixture.store.puts;
    await assert.rejects(
      buildPolicyActivationQaPackage(
        {
          store: fixture.store,
          namespace,
          operationId: "policy-activation-p8-invalid",
          executorSourceSha,
          targetSourceSha,
          activationGate: "P8-CLEAN",
          proposedPolicyReference: fixture.proposedPolicyReference,
          buildRequirementsReference: fixture.buildRequirementsReference,
          standardManifestBytes: fixture.standard.manifestBytes,
          standardArchiveBytes: fixture.standard.archiveBytes,
          companionManifestBytes: fixture.companion.manifestBytes,
          companionArchiveBytes: fixture.companion.archiveBytes,
        },
        {
          validateBuildRequirements: async () => ({
            requirements: fixture.buildRequirements,
          }),
        },
      ),
      /inputs are invalid/,
    );
    assert.equal(fixture.store.puts, putsBefore);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
