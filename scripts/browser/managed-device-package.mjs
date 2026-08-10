import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  parseContentAddressedUri,
  resolveContentAddressedObject,
  writeContentAddressedObject,
} from "../lib/content-addressed-store.mjs";
import { assertReleasePackageIndex } from "../lib/artifact-contract.mjs";
import { extractPrebuiltArchive } from "../provider/prebuiltDeployment.mjs";
import { assertDeploymentBinding } from "../release-state/releaseWorkflowValidation.mjs";
import { verifyReleasePackage } from "../verify-release-artifact.mjs";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readBoundEvidence = async ({ store, namespace, reference, label }) => {
  if (
    !isRecord(reference) ||
    typeof reference.sha256 !== "string" ||
    typeof reference.uri !== "string"
  ) {
    throw new Error(`${label} reference is invalid`);
  }
  const object = await store.readEvidence({ sha256: reference.sha256 });
  const releaseStateUri = `release-state://${namespace}/evidence/${reference.sha256}`;
  const artifactUriMatches = (() => {
    try {
      return (
        parseContentAddressedUri(reference.uri).sha256 === reference.sha256
      );
    } catch {
      return false;
    }
  })();
  if (
    !object ||
    !Buffer.isBuffer(object.bytes) ||
    sha256Bytes(object.bytes) !== reference.sha256 ||
    (reference.uri !== releaseStateUri && !artifactUriMatches)
  ) {
    throw new Error(`${label} evidence binding differs`);
  }
  return object.bytes;
};

const readArtifactEvidence = async ({ store, reference, label }) => {
  const parsed = parseContentAddressedUri(reference?.uri);
  if (parsed.sha256 !== reference.sha256) {
    throw new Error(`${label} immutable reference differs`);
  }
  const object = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !object ||
    !Buffer.isBuffer(object.bytes) ||
    sha256Bytes(object.bytes) !== reference.sha256
  ) {
    throw new Error(`${label} immutable bytes differ`);
  }
  return Object.freeze({ bytes: object.bytes, kind: parsed.kind });
};

const collectArtifactReferences = (value, references = new Map()) => {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactReferences(item, references);
    return references;
  }
  if (!isRecord(value)) return references;
  if (
    Object.keys(value).length === 2 &&
    typeof value.uri === "string" &&
    value.uri.startsWith("artifact://") &&
    typeof value.sha256 === "string"
  ) {
    const previous = references.get(value.uri);
    if (previous && previous.sha256 !== value.sha256) {
      throw new Error("Managed device package reference is ambiguous");
    }
    references.set(value.uri, value);
    return references;
  }
  for (const child of Object.values(value)) {
    collectArtifactReferences(child, references);
  }
  return references;
};

const parseCanonical = (bytes, label) => {
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
};

export const selectManagedDeviceRollbackBinding = (snapshot) => {
  const accepted = snapshot?.acceptedStandard;
  const candidates = (snapshot?.rollbackInventory ?? []).filter(
    (entry) =>
      entry.eligibility === "eligible" &&
      entry.eligibleActions?.includes("rollback") &&
      entry.binding?.releaseRole === "standard" &&
      entry.binding.sourceSha !== accepted?.sourceSha,
  );
  if (candidates.length !== 1) {
    throw new Error(
      "Managed device drill requires exactly one eligible rollback artifact",
    );
  }
  return candidates[0].binding;
};

export const materializeManagedDeviceStandardDist = async ({
  store,
  namespace,
  binding,
  packageRoot,
  distRoot,
  toolchainPolicy,
  providerPolicy,
  dbContract,
  cspPolicy,
}) => {
  assertDeploymentBinding(binding, {
    namespace,
    allowLegacyBootstrap: false,
    label: "Managed device artifact binding",
  });
  if (binding.releaseRole !== "standard") {
    throw new Error("Managed device artifact must be a standard binding");
  }
  const indexBytes = await readBoundEvidence({
    store,
    namespace,
    reference: binding.packageIndex,
    label: "Managed device package index",
  });
  const index = assertReleasePackageIndex(
    parseCanonical(indexBytes, "Managed device package index"),
  );
  if (
    index.sourceSha !== binding.sourceSha ||
    index.packageKind !== "source-hardened-pair"
  ) {
    throw new Error("Managed device package index differs from binding");
  }
  await mkdir(packageRoot, { recursive: false });
  await writeFile(
    path.join(packageRoot, "release-package-index.json"),
    indexBytes,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  const references = [...collectArtifactReferences(index).values()];
  await Promise.all(
    references.map(async (reference) => {
      const object = await readArtifactEvidence({
        store,
        reference,
        label: `Managed device package ${reference.uri}`,
      });
      const written = await writeContentAddressedObject({
        packageRoot,
        bytes: object.bytes,
        kind: object.kind,
      });
      if (
        written.uri !== reference.uri ||
        written.sha256 !== reference.sha256
      ) {
        throw new Error("Managed device materialized object differs");
      }
    }),
  );
  const releasePolicyBytes = await readBoundEvidence({
    store,
    namespace,
    reference: binding.releasePolicy,
    label: "Managed device release policy",
  });
  const releasePolicy = parseCanonical(
    releasePolicyBytes,
    "Managed device release policy",
  );
  const verification = await verifyReleasePackage({
    packageRoot,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation: null,
    dbContract,
    cspPolicy,
    requireProductionBindings: false,
    expectedBuildPurpose: "production",
  });
  if (
    verification.index.sourceSha !== binding.sourceSha ||
    verification.index.buildPurpose !== "production" ||
    verification.index.promotable !== true
  ) {
    throw new Error("Managed device package verification differs");
  }
  const standardReference = index.artifacts.find(
    ({ releaseRole }) => releaseRole === "standard",
  );
  if (
    !standardReference ||
    standardReference.archive.sha256 !== binding.artifactArchive.sha256 ||
    standardReference.archive.uri !== binding.artifactArchive.uri
  ) {
    throw new Error("Managed device standard archive differs from binding");
  }
  const [archiveObject, manifestObject] = await Promise.all([
    resolveContentAddressedObject({
      packageRoot,
      reference: standardReference.archive,
      expectedKind: "artifact.zip",
    }),
    resolveContentAddressedObject({
      packageRoot,
      reference: standardReference.manifest,
      expectedKind: "artifact-manifest.json",
    }),
  ]);
  const manifest = parseCanonical(
    manifestObject.bytes,
    "Managed device standard manifest",
  );
  await mkdir(distRoot, { recursive: false });
  await extractPrebuiltArchive({
    archivePath: archiveObject.path,
    destination: distRoot,
    expectedFiles: manifest.outputFiles,
  });
  return Object.freeze({
    binding,
    distRoot: path.resolve(distRoot),
    packageIndexSha256: sha256Bytes(indexBytes),
    packageRoot: path.resolve(packageRoot),
  });
};
