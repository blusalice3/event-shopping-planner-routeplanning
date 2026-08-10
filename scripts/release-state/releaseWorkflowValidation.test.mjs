import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
} from "./releaseWorkflowValidation.mjs";

const namespace = "archive-validation-test";
const committedAt = "2026-08-09T00:00:00.000Z";
const sourceSha = "a".repeat(40);
const reference = (bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const createFixture = () => {
  const values = new Map();
  const put = (bytes, mediaType) => {
    const objectBytes = Buffer.from(bytes);
    const objectReference = reference(objectBytes);
    values.set(objectReference.sha256, {
      bytes: objectBytes,
      mediaType,
      committedAt,
    });
    return objectReference;
  };
  const store = {
    namespace,
    async readEvidence({ sha256 }) {
      const value = values.get(sha256);
      return value
        ? {
            bytes: Buffer.from(value.bytes),
            mediaType: value.mediaType,
            committedAt: value.committedAt,
          }
        : null;
    },
  };
  const object = (name) => put(Buffer.from(name), "application/json");
  const archiveBytes = Buffer.from("content-addressed artifact archive");
  const artifactArchive = put(archiveBytes, ARTIFACT_ARCHIVE_MEDIA_TYPE);
  const artifactManifest = object("manifest");
  const baseBinding = {
    bindingId: "deployment-binding:archive-test",
    sourceSha,
    buildId: sourceSha,
    variantId: "b".repeat(64),
    releaseRole: "standard",
    publicIdentityKind: "release-identity-v1",
    providerProjectId: "project-test",
    providerDeploymentId: "deployment-test",
    deploymentUrl: "https://deployment-test.example.test",
    artifactArchive,
    packageIndex: object("package-index"),
    artifactManifest,
    providerEvidence: object("provider-evidence"),
    releasePolicy: object("release-policy"),
    providerPolicy: object("provider-policy"),
    providerConfigurationHash: "c".repeat(64),
    requiredDbCompatibility: {
      contractUri: "urn:test:db:v1",
      fingerprint: "d".repeat(64),
    },
  };
  const availability = {
    schemaVersion: 1,
    evidenceKind: "artifact-archive-availability/v1",
    availability: "available",
    namespace,
    bindingId: baseBinding.bindingId,
    sourceSha: baseBinding.sourceSha,
    variantId: baseBinding.variantId,
    releaseRole: baseBinding.releaseRole,
    artifactManifest,
    artifactArchive: {
      ...artifactArchive,
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
      byteLength: archiveBytes.length,
      committedAt,
    },
  };
  const storeAvailability = (value) =>
    put(canonicalJsonBytes(value), ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE);
  const binding = {
    ...baseBinding,
    artifactArchiveAvailability: storeAvailability(availability),
  };
  return {
    archiveBytes,
    availability,
    binding,
    store,
    storeAvailability,
    values,
  };
};

const rejectsWithCode = async (promise, code) =>
  assert.rejects(promise, (error) => error?.code === code);

test("verifies an archive, durable URI, and binding-specific availability receipt", async () => {
  const fixture = createFixture();
  const result = await assertArtifactArchiveAvailable({
    store: fixture.store,
    namespace,
    binding: fixture.binding,
  });
  assert.equal(result.archive.bytes.equals(fixture.archiveBytes), true);
  assert.deepEqual(result.archiveReference, fixture.binding.artifactArchive);
});

test("fails closed for missing archive references and missing stored bytes", async () => {
  const missingReference = createFixture();
  const bindingWithoutArchivePair = structuredClone(missingReference.binding);
  delete bindingWithoutArchivePair.artifactArchive;
  delete bindingWithoutArchivePair.artifactArchiveAvailability;
  assert.throws(
    () => assertDeploymentBinding(bindingWithoutArchivePair, { namespace }),
    /has no durable artifact archive binding/,
  );
  const bindingWithoutArchive = structuredClone(missingReference.binding);
  delete bindingWithoutArchive.artifactArchive;
  await rejectsWithCode(
    assertArtifactArchiveAvailable({
      store: missingReference.store,
      namespace,
      binding: bindingWithoutArchive,
    }),
    "artifact-archive-reference-missing",
  );

  const missingObject = createFixture();
  missingObject.values.delete(missingObject.binding.artifactArchive.sha256);
  await rejectsWithCode(
    assertArtifactArchiveAvailable({
      store: missingObject.store,
      namespace,
      binding: missingObject.binding,
    }),
    "artifact-archive-missing",
  );
});

test("fails closed for content-addressed archive tampering", async () => {
  const fixture = createFixture();
  fixture.values.set(fixture.binding.artifactArchive.sha256, {
    bytes: Buffer.from("tampered archive"),
    mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
    committedAt,
  });
  await rejectsWithCode(
    assertArtifactArchiveAvailable({
      store: fixture.store,
      namespace,
      binding: fixture.binding,
    }),
    "artifact-archive-tampered",
  );
});

test("rejects availability receipts for the wrong source or binding", async () => {
  for (const override of [
    { sourceSha: "f".repeat(40) },
    { bindingId: "deployment-binding:wrong" },
  ]) {
    const fixture = createFixture();
    const artifactArchiveAvailability = fixture.storeAvailability({
      ...fixture.availability,
      ...override,
    });
    await rejectsWithCode(
      assertArtifactArchiveAvailable({
        store: fixture.store,
        namespace,
        binding: { ...fixture.binding, artifactArchiveAvailability },
      }),
      "artifact-archive-binding-mismatch",
    );
  }
});

test("rejects an explicitly unavailable archive receipt", async () => {
  const fixture = createFixture();
  const artifactArchiveAvailability = fixture.storeAvailability({
    ...fixture.availability,
    availability: "unavailable",
  });
  await rejectsWithCode(
    assertArtifactArchiveAvailable({
      store: fixture.store,
      namespace,
      binding: { ...fixture.binding, artifactArchiveAvailability },
    }),
    "artifact-archive-unavailable",
  );
});
