import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertArtifactManifest,
  assertReleasePackageIndex,
} from "../lib/artifact-contract.mjs";
import {
  contentAddressedObjectPath,
  parseContentAddressedUri,
  writeContentAddressedObject,
} from "../lib/content-addressed-store.mjs";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  SOURCE_SHA_PATTERN,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  compareUtf8,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "../release-state/releaseWorkflowValidation.mjs";

export const ARCHIVE_RECOVERY_ACTIONS = Object.freeze([
  "activate-containment",
  "redeploy-containment",
  "redeploy-standard",
  "rollback",
]);

const assertBindingId = (bindingId) => {
  if (
    typeof bindingId !== "string" ||
    bindingId.length < 1 ||
    bindingId.length > 255 ||
    [...bindingId].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Artifact recovery binding ID is invalid");
  }
};

const containmentCandidates = (snapshot) => {
  const candidates = [
    snapshot.activeProduction?.releaseRole === "containment"
      ? snapshot.activeProduction
      : null,
    snapshot.containmentCompanion,
    snapshot.bootstrapRecovery,
    snapshot.standardRecovery?.containmentBinding,
    snapshot.pendingOperation?.originBinding?.releaseRole === "containment"
      ? snapshot.pendingOperation.originBinding
      : null,
  ].filter(Boolean);
  return [
    ...new Map(
      candidates
        .sort((left, right) => compareUtf8(left.bindingId, right.bindingId))
        .map((binding) => [binding.bindingId, binding]),
    ).values(),
  ];
};

export const selectRecoveryBinding = ({ snapshot, action, bindingId }) => {
  if (action === "rollback") {
    const inventory = snapshot.rollbackInventory.find(
      (entry) => entry.binding.bindingId === bindingId,
    );
    if (
      inventory?.eligibility !== "eligible" ||
      !inventory.eligibleActions.includes("rollback")
    ) {
      throw new Error("Artifact recovery binding is not eligible for rollback");
    }
    return inventory.binding;
  }
  if (action === "redeploy-standard") {
    const inventory = snapshot.rollbackInventory.find(
      (entry) => entry.binding.bindingId === bindingId,
    );
    if (
      inventory?.eligibility === "eligible" &&
      inventory.eligibleActions.includes("package-redeploy")
    ) {
      return inventory.binding;
    }
    if (snapshot.acceptedStandard?.bindingId === bindingId) {
      return snapshot.acceptedStandard;
    }
    throw new Error(
      "Artifact recovery binding is not eligible for package-redeploy",
    );
  }
  const matches = containmentCandidates(snapshot).filter(
    (binding) => binding.bindingId === bindingId,
  );
  if (matches.length !== 1) {
    throw new Error("Containment archive binding is absent or ambiguous");
  }
  return matches[0];
};

const releaseStateReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const artifactReferences = (index) =>
  index.packageKind === "source-hardened-pair"
    ? index.artifacts
    : [index.artifact];

const assertBindingMatchesIndex = ({ binding, index, reference }) => {
  if (
    binding.sourceSha !== index.sourceSha ||
    binding.buildId !== index.buildId ||
    binding.releaseRole !== reference.releaseRole ||
    binding.variantId !== reference.variantId ||
    binding.packageIndex.sha256 !== sha256Bytes(canonicalJsonBytes(index)) ||
    binding.artifactManifest.sha256 !== reference.manifest.sha256 ||
    binding.artifactArchive.sha256 !== reference.archive.sha256 ||
    !sameCanonicalValue(
      binding.requiredDbCompatibility,
      index.requiredDbCompatibility,
    )
  ) {
    throw new Error(
      `Artifact recovery binding ${binding.bindingId} differs from its package index`,
    );
  }
};

const readCanonicalEvidence = async ({
  store,
  namespace,
  reference,
  label,
}) => {
  const object = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  const value = parseCanonicalJsonBytes(object.bytes, label);
  return { ...object, value };
};

const writePackageIndex = async ({ packageRoot, bytes }) => {
  const resolvedRoot = path.resolve(packageRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const indexPath = path.join(resolvedRoot, "release-package-index.json");
  try {
    await writeFile(indexPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(indexPath);
    if (!existing.equals(bytes)) {
      throw new Error("Artifact recovery package index already differs");
    }
  }
  return indexPath;
};

const materializeReferencedEvidence = async ({
  store,
  namespace,
  packageRoot,
  reference,
  expectedKind,
  label,
}) => {
  const parsed = parseContentAddressedUri(reference.uri, expectedKind);
  if (parsed.sha256 !== reference.sha256) {
    throw new Error(`${label} URI and SHA-256 differ`);
  }
  const object = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: releaseStateReference(namespace, reference.sha256),
    label,
  });
  const written = await writeContentAddressedObject({
    packageRoot,
    bytes: object.bytes,
    kind: expectedKind,
  });
  if (
    written.uri !== reference.uri ||
    written.sha256 !== reference.sha256 ||
    written.path !==
      contentAddressedObjectPath(packageRoot, reference.sha256, expectedKind)
  ) {
    throw new Error(`${label} materialized path closure differs`);
  }
  return { ...written, bytes: object.bytes };
};

/**
 * Reconstructs only the immutable package objects required by the verified
 * prebuilt deploy path. It deliberately has no build or install capability.
 */
export const materializeArtifactRecoveryPackage = async ({
  store,
  namespace,
  bindings,
  packageRoot,
  releasePolicy,
}) => {
  if (store?.namespace !== namespace) {
    throw new Error("Artifact recovery namespace differs from its store");
  }
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 2) {
    throw new Error("Artifact recovery requires one package binding set");
  }
  for (const binding of bindings) {
    assertDeploymentBinding(binding, {
      namespace,
      allowLegacyBootstrap: true,
      label: "Artifact recovery binding",
    });
  }
  if (
    new Set(bindings.map((binding) => binding.releaseRole)).size !==
    bindings.length
  ) {
    throw new Error("Artifact recovery package bindings are ambiguous");
  }
  const [firstBinding] = bindings;
  const packageIndexObject = await readCanonicalEvidence({
    store,
    namespace,
    reference: firstBinding.packageIndex,
    label: "Artifact recovery package index",
  });
  const index = assertReleasePackageIndex(packageIndexObject.value);
  const indexBytes = canonicalJsonBytes(index);
  if (!packageIndexObject.bytes.equals(indexBytes)) {
    throw new Error("Artifact recovery package index is not canonical");
  }
  if (
    bindings.some(
      (binding) =>
        !sameCanonicalValue(binding.packageIndex, firstBinding.packageIndex),
    )
  ) {
    throw new Error(
      "Artifact recovery bindings do not share one package index",
    );
  }

  const references = artifactReferences(index);
  if (
    (index.packageKind === "source-hardened-pair" && bindings.length !== 2) ||
    (index.packageKind === "legacy-bootstrap-single" &&
      (bindings.length !== 1 || bindings[0].releaseRole !== "containment"))
  ) {
    throw new Error(
      "Artifact recovery binding set is incomplete for its package",
    );
  }
  const byRole = new Map(
    bindings.map((binding) => [binding.releaseRole, binding]),
  );
  for (const reference of references) {
    const binding = byRole.get(reference.releaseRole);
    if (!binding) {
      throw new Error(
        `Artifact recovery ${reference.releaseRole} binding is absent`,
      );
    }
    assertBindingMatchesIndex({ binding, index, reference });
    await assertArtifactArchiveAvailable({
      store,
      namespace,
      binding,
      label: `Artifact recovery ${reference.releaseRole} binding`,
    });
    const manifestObject = await materializeReferencedEvidence({
      store,
      namespace,
      packageRoot,
      reference: reference.manifest,
      expectedKind: "artifact-manifest.json",
      label: `Artifact recovery ${reference.releaseRole} manifest`,
    });
    const manifest = parseCanonicalJsonBytes(
      manifestObject.bytes,
      `Artifact recovery ${reference.releaseRole} manifest`,
    );
    assertArtifactManifest(manifest, releasePolicy);
    if (
      manifest.sourceSha !== index.sourceSha ||
      manifest.buildId !== index.buildId ||
      manifest.releaseRole !== reference.releaseRole ||
      manifest.variantId !== reference.variantId ||
      manifest.releasePolicyHash !== index.releasePolicyHash ||
      manifest.providerPolicyHash !== index.providerPolicyHash ||
      manifest.providerConfigurationHash !== index.providerConfigurationHash ||
      !sameCanonicalValue(
        manifest.requiredDbCompatibility,
        index.requiredDbCompatibility,
      )
    ) {
      throw new Error(
        `Artifact recovery ${reference.releaseRole} manifest binding differs`,
      );
    }
    await materializeReferencedEvidence({
      store,
      namespace,
      packageRoot,
      reference: reference.archive,
      expectedKind: "artifact.zip",
      label: `Artifact recovery ${reference.releaseRole} archive`,
    });
  }

  if (index.packageKind === "legacy-bootstrap-single") {
    await Promise.all([
      materializeReferencedEvidence({
        store,
        namespace,
        packageRoot,
        reference: index.bootstrapInput,
        expectedKind: "bootstrap-input.json",
        label: "Artifact recovery bootstrap input",
      }),
      materializeReferencedEvidence({
        store,
        namespace,
        packageRoot,
        reference: index.rawDistManifest,
        expectedKind: "raw-dist-manifest.json",
        label: "Artifact recovery raw dist manifest",
      }),
    ]);
  }
  const indexPath = await writePackageIndex({
    packageRoot,
    bytes: indexBytes,
  });
  return {
    schemaVersion: 1,
    resultKind: "artifact-recovery-package-materialized/v1",
    packageKind: index.packageKind,
    packageRoot: path.resolve(packageRoot),
    packageIndexPath: indexPath,
    packageIndexSha256: sha256Bytes(indexBytes),
    sourceSha: index.sourceSha,
    bindings: bindings
      .map(({ bindingId, releaseRole }) => ({ bindingId, releaseRole }))
      .sort((left, right) => compareUtf8(left.releaseRole, right.releaseRole)),
  };
};

export const planArtifactRecovery = async (
  { store, namespace, action, bindingId, expectedSourceSha },
  { readCurrent = readCurrentReleaseState } = {},
) => {
  if (!ARCHIVE_RECOVERY_ACTIONS.includes(action)) {
    throw new Error("Artifact recovery action is invalid");
  }
  assertBindingId(bindingId);
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha)) {
    throw new Error("Artifact recovery source SHA is invalid");
  }
  if (store?.namespace !== namespace) {
    throw new Error("Artifact recovery namespace differs from its store");
  }
  const current = await readCurrent({ store, requireInitialized: true });
  const binding = selectRecoveryBinding({
    snapshot: current.snapshot,
    action,
    bindingId,
  });
  if (binding.sourceSha !== expectedSourceSha) {
    throw new Error(
      "Artifact recovery binding differs from the requested source",
    );
  }
  const verified = await assertArtifactArchiveAvailable({
    store,
    namespace,
    binding,
    label: `Artifact recovery binding ${binding.bindingId}`,
  });
  return {
    schemaVersion: 1,
    planKind: "artifact-recovery-dry-run/v1",
    status: "ready",
    executionMode: "dry-run",
    action,
    namespace,
    expectedState: {
      sequence: current.head.sequence,
      eventHash: current.head.eventHash,
    },
    binding: {
      bindingId: binding.bindingId,
      sourceSha: binding.sourceSha,
      variantId: binding.variantId,
      releaseRole: binding.releaseRole,
      providerProjectId: binding.providerProjectId,
      providerDeploymentId: binding.providerDeploymentId,
    },
    artifactArchive: {
      ...verified.archiveReference,
      mediaType: verified.archive.mediaType,
      byteLength: verified.archive.bytes.length,
      committedAt: verified.archive.committedAt,
    },
    artifactArchiveAvailability: verified.availabilityReference,
    providerExecutionContract: {
      cli: "npm run release:deploy-prebuilt",
      protectedRecoveryCli: "npm run release:execute-archive-recovery",
      archiveMaterializationRequired: true,
      providerObservationRequired: true,
      deploymentReceiptRequired: true,
      deploymentReceiptProduced: false,
    },
  };
};
