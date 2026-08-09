import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyDeterministicZip } from "../deterministic-zip.mjs";
import { assertArtifactManifest } from "../lib/artifact-contract.mjs";
import { projectContainmentDimensions } from "../lib/release-policy.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SOURCE_SHA_PATTERN,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  assertImmutableObjectReference,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";
import { NORMAL_POLICY_ACTIVATION_GATES } from "./phaseGates.mjs";
import {
  ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  validateAuthoritativeArtifactBuildRequirements,
} from "./artifactBuildAuthority.mjs";

export const POLICY_ACTIVATION_QA_PACKAGE_KIND = "policy-activation-qa-pair";
export const POLICY_ACTIVATION_QA_BUILD_PURPOSE =
  "non-promotable-policy-activation-qa";
export const POLICY_ACTIVATION_QA_ARCHIVE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-artifact+zip;version=1";
export const POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";
export const POLICY_ACTIVATION_QA_AVAILABILITY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-archive-availability+json;version=1";
export const POLICY_ACTIVATION_QA_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.policy-activation-qa-package-index+json;version=1";
const ARCHIVE_MEDIA_TYPE = POLICY_ACTIVATION_QA_ARCHIVE_MEDIA_TYPE;
const MANIFEST_MEDIA_TYPE = POLICY_ACTIVATION_QA_MANIFEST_MEDIA_TYPE;
const AVAILABILITY_MEDIA_TYPE = POLICY_ACTIVATION_QA_AVAILABILITY_MEDIA_TYPE;
const INDEX_MEDIA_TYPE = POLICY_ACTIVATION_QA_INDEX_MEDIA_TYPE;
const ACTIVATION_GATES = new Set(NORMAL_POLICY_ACTIVATION_GATES);

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const putBytes = async ({ store, namespace, bytes, mediaType, label }) => {
  const reference = referenceFor(namespace, bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.byteLength !== bytes.length ||
    receipt.mediaType !== mediaType ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (!stored?.bytes?.equals(bytes)) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return { reference, receipt };
};

const assertQaArtifact = (artifact, role, label) => {
  assertExactKeys(
    artifact,
    [
      "archive",
      "archiveAvailability",
      "bindingId",
      "manifest",
      "releaseRole",
      "variantId",
    ],
    label,
  );
  if (
    artifact.releaseRole !== role ||
    typeof artifact.bindingId !== "string" ||
    artifact.bindingId.length === 0 ||
    typeof artifact.variantId !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.variantId)
  ) {
    throw new Error(`${label} identity is invalid`);
  }
};

export const assertPolicyActivationQaPackageIndex = (
  index,
  {
    proposedPolicy,
    proposedPolicyReference,
    activationGate,
    executorSourceSha,
    targetSourceSha,
  },
) => {
  assertExactKeys(
    index,
    [
      "activationGate",
      "artifacts",
      "buildAuthority",
      "buildId",
      "buildPurpose",
      "executorSourceSha",
      "packageKind",
      "promotable",
      "proposedReleasePolicy",
      "requiredDbCompatibility",
      "schemaVersion",
      "sourceSha",
      "toolchainPolicyHash",
    ],
    "Policy activation QA package index",
  );
  if (
    index.schemaVersion !== 1 ||
    index.packageKind !== POLICY_ACTIVATION_QA_PACKAGE_KIND ||
    index.buildPurpose !== POLICY_ACTIVATION_QA_BUILD_PURPOSE ||
    index.promotable !== false ||
    !ACTIVATION_GATES.has(index.activationGate) ||
    index.activationGate !== activationGate ||
    index.sourceSha !== index.buildId ||
    !SOURCE_SHA_PATTERN.test(index.sourceSha) ||
    !SOURCE_SHA_PATTERN.test(index.executorSourceSha) ||
    (executorSourceSha !== undefined &&
      index.executorSourceSha !== executorSourceSha) ||
    (targetSourceSha !== undefined && index.sourceSha !== targetSourceSha) ||
    !/^[0-9a-f]{64}$/.test(index.toolchainPolicyHash) ||
    !sameCanonicalValue(index.proposedReleasePolicy, proposedPolicyReference) ||
    index.buildAuthority?.sha256 === undefined ||
    !Array.isArray(index.artifacts) ||
    index.artifacts.length !== 2
  ) {
    throw new Error("Policy activation QA package identity is invalid");
  }
  assertQaArtifact(index.artifacts[0], "standard", "Policy QA standard");
  assertQaArtifact(index.artifacts[1], "containment", "Policy QA containment");
  assertImmutableObjectReference(
    index.buildAuthority,
    index.proposedReleasePolicy.uri.split("/")[2],
    "Policy QA build authority",
  );
  if (
    index.artifacts[0].bindingId === index.artifacts[1].bindingId ||
    index.artifacts[0].variantId === index.artifacts[1].variantId ||
    proposedPolicy.activationStatus !== "proposed"
  ) {
    throw new Error("Policy activation QA package pair is not independent");
  }
  return index;
};

const verifyArchiveBytes = async ({ archiveBytes, manifest, role }) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), `foundation-policy-qa-${role}-`),
  );
  const archivePath = path.join(temporaryRoot, `${role}.zip`);
  try {
    await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
    await verifyDeterministicZip({
      archivePath,
      expectedFiles: manifest.outputFiles,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const buildArtifact = async ({
  store,
  namespace,
  operationId,
  role,
  manifest,
  manifestBytes,
  archiveBytes,
}) => {
  const [storedManifest, storedArchive] = await Promise.all([
    putBytes({
      store,
      namespace,
      bytes: manifestBytes,
      mediaType: MANIFEST_MEDIA_TYPE,
      label: `Policy QA ${role} manifest`,
    }),
    putBytes({
      store,
      namespace,
      bytes: archiveBytes,
      mediaType: ARCHIVE_MEDIA_TYPE,
      label: `Policy QA ${role} archive`,
    }),
  ]);
  const bindingId = `policy-qa-${operationId}-${role}`;
  const availability = {
    schemaVersion: 1,
    evidenceKind: "policy-activation-qa-archive-availability/v1",
    namespace,
    bindingId,
    sourceSha: manifest.sourceSha,
    variantId: manifest.variantId,
    releaseRole: role,
    manifest: storedManifest.reference,
    archive: {
      ...storedArchive.reference,
      mediaType: ARCHIVE_MEDIA_TYPE,
      byteLength: archiveBytes.length,
      committedAt: storedArchive.receipt.committedAt,
    },
  };
  const storedAvailability = await putBytes({
    store,
    namespace,
    bytes: canonicalJsonBytes(availability),
    mediaType: AVAILABILITY_MEDIA_TYPE,
    label: `Policy QA ${role} archive availability`,
  });
  return {
    bindingId,
    releaseRole: role,
    variantId: manifest.variantId,
    manifest: storedManifest.reference,
    archive: storedArchive.reference,
    archiveAvailability: storedAvailability.reference,
  };
};

export const buildPolicyActivationQaPackage = async (
  {
    store,
    namespace,
    operationId,
    executorSourceSha,
    targetSourceSha,
    activationGate,
    proposedPolicyReference,
    buildRequirementsReference,
    standardManifestBytes,
    standardArchiveBytes,
    companionManifestBytes,
    companionArchiveBytes,
  },
  {
    validateBuildRequirements = validateAuthoritativeArtifactBuildRequirements,
  } = {},
) => {
  if (
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    store.namespace !== namespace ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !SOURCE_SHA_PATTERN.test(executorSourceSha) ||
    !SOURCE_SHA_PATTERN.test(targetSourceSha) ||
    !ACTIVATION_GATES.has(activationGate) ||
    !Buffer.isBuffer(standardManifestBytes) ||
    !Buffer.isBuffer(companionManifestBytes) ||
    !Buffer.isBuffer(standardArchiveBytes) ||
    standardArchiveBytes.length === 0 ||
    !Buffer.isBuffer(companionArchiveBytes) ||
    companionArchiveBytes.length === 0
  ) {
    throw new Error("Policy activation QA package inputs are invalid");
  }
  const storedPolicy = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: proposedPolicyReference,
    label: "Policy QA proposed policy",
  });
  const proposedPolicy = parseCanonicalJsonBytes(
    storedPolicy.bytes,
    "Policy QA proposed policy",
  );
  const storedRequirements = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: buildRequirementsReference,
    label: "Policy QA artifact build requirements",
  });
  if (storedRequirements.mediaType !== ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE) {
    throw new Error(
      "Policy QA artifact build requirements media type is invalid",
    );
  }
  const { requirements } = await validateBuildRequirements({
    store,
    requirementsBytes: storedRequirements.bytes,
    expectedSha256: buildRequirementsReference.sha256,
    checkoutSourceSha: targetSourceSha,
  });
  if (
    requirements.purpose !== "policy-activation-qa" ||
    requirements.buildPurpose !== POLICY_ACTIVATION_QA_BUILD_PURPOSE ||
    requirements.promotable !== false ||
    requirements.targetGate !== activationGate ||
    !sameCanonicalValue(
      requirements.proposedReleasePolicy,
      proposedPolicyReference,
    )
  ) {
    throw new Error(
      "Policy QA build requirements do not authorize this package",
    );
  }
  const standardManifest = parseCanonicalJsonBytes(
    standardManifestBytes,
    "Policy QA standard manifest",
  );
  const companionManifest = parseCanonicalJsonBytes(
    companionManifestBytes,
    "Policy QA containment manifest",
  );
  assertArtifactManifest(standardManifest, proposedPolicy, {
    expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  });
  assertArtifactManifest(companionManifest, proposedPolicy, {
    expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  });
  if (
    standardManifest.releaseRole !== "standard" ||
    companionManifest.releaseRole !== "containment" ||
    standardManifest.sourceSha !== targetSourceSha ||
    companionManifest.sourceSha !== targetSourceSha ||
    standardManifest.buildId !== companionManifest.buildId ||
    standardManifest.toolchainPolicyHash !==
      companionManifest.toolchainPolicyHash ||
    standardManifest.releasePolicyHash !== proposedPolicyReference.sha256 ||
    companionManifest.releasePolicyHash !== proposedPolicyReference.sha256 ||
    !sameCanonicalValue(
      standardManifest.buildAuthority,
      buildRequirementsReference,
    ) ||
    !sameCanonicalValue(
      companionManifest.buildAuthority,
      buildRequirementsReference,
    ) ||
    standardManifest.targetGate !== activationGate ||
    companionManifest.targetGate !== activationGate ||
    !sameCanonicalValue(
      standardManifest.requiredDbCompatibility,
      companionManifest.requiredDbCompatibility,
    ) ||
    !sameCanonicalValue(standardManifest.dimensions, {
      releaseRole: "standard",
      ...proposedPolicy.acceptedStandardFloors,
    }) ||
    !sameCanonicalValue(
      companionManifest.dimensions,
      projectContainmentDimensions(proposedPolicy, standardManifest.dimensions),
    )
  ) {
    throw new Error("Policy activation QA manifests are not the proposed pair");
  }
  await Promise.all([
    verifyArchiveBytes({
      archiveBytes: standardArchiveBytes,
      manifest: standardManifest,
      role: "standard",
    }),
    verifyArchiveBytes({
      archiveBytes: companionArchiveBytes,
      manifest: companionManifest,
      role: "containment",
    }),
  ]);
  const [standardArtifact, companionArtifact] = await Promise.all([
    buildArtifact({
      store,
      namespace,
      operationId,
      role: "standard",
      manifest: standardManifest,
      manifestBytes: standardManifestBytes,
      archiveBytes: standardArchiveBytes,
    }),
    buildArtifact({
      store,
      namespace,
      operationId,
      role: "containment",
      manifest: companionManifest,
      manifestBytes: companionManifestBytes,
      archiveBytes: companionArchiveBytes,
    }),
  ]);
  const index = {
    schemaVersion: 1,
    packageKind: POLICY_ACTIVATION_QA_PACKAGE_KIND,
    buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    promotable: false,
    executorSourceSha,
    activationGate,
    proposedReleasePolicy: proposedPolicyReference,
    buildAuthority: buildRequirementsReference,
    sourceSha: standardManifest.sourceSha,
    buildId: standardManifest.buildId,
    toolchainPolicyHash: standardManifest.toolchainPolicyHash,
    requiredDbCompatibility: standardManifest.requiredDbCompatibility,
    artifacts: [standardArtifact, companionArtifact],
  };
  assertPolicyActivationQaPackageIndex(index, {
    proposedPolicy,
    proposedPolicyReference,
    activationGate,
    executorSourceSha,
    targetSourceSha,
  });
  const storedIndex = await putBytes({
    store,
    namespace,
    bytes: canonicalJsonBytes(index),
    mediaType: INDEX_MEDIA_TYPE,
    label: "Policy activation QA package index",
  });
  return {
    index,
    indexBytes: canonicalJsonBytes(index),
    indexReference: storedIndex.reference,
    indexSha256: storedIndex.reference.sha256,
  };
};

const validateAvailability = async ({
  store,
  namespace,
  artifact,
  manifest,
}) => {
  const availabilityStored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: artifact.archiveAvailability,
    label: `Policy QA ${artifact.releaseRole} archive availability`,
  });
  const availability = parseCanonicalJsonBytes(
    availabilityStored.bytes,
    `Policy QA ${artifact.releaseRole} archive availability`,
  );
  assertExactKeys(
    availability,
    [
      "archive",
      "bindingId",
      "evidenceKind",
      "manifest",
      "namespace",
      "releaseRole",
      "schemaVersion",
      "sourceSha",
      "variantId",
    ],
    "Policy QA archive availability",
  );
  const archiveStored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: artifact.archive,
    label: `Policy QA ${artifact.releaseRole} archive`,
  });
  if (
    availabilityStored.mediaType !== AVAILABILITY_MEDIA_TYPE ||
    archiveStored.mediaType !== ARCHIVE_MEDIA_TYPE ||
    availability.schemaVersion !== 1 ||
    availability.evidenceKind !==
      "policy-activation-qa-archive-availability/v1" ||
    availability.namespace !== namespace ||
    availability.bindingId !== artifact.bindingId ||
    availability.sourceSha !== manifest.sourceSha ||
    availability.variantId !== artifact.variantId ||
    availability.releaseRole !== artifact.releaseRole ||
    !sameCanonicalValue(availability.manifest, artifact.manifest) ||
    availability.archive.uri !== artifact.archive.uri ||
    availability.archive.sha256 !== artifact.archive.sha256 ||
    availability.archive.mediaType !== ARCHIVE_MEDIA_TYPE ||
    availability.archive.byteLength !== archiveStored.bytes.length ||
    !Number.isFinite(Date.parse(availability.archive.committedAt))
  ) {
    throw new Error("Policy QA archive availability binding is invalid");
  }
  await verifyArchiveBytes({
    archiveBytes: archiveStored.bytes,
    manifest,
    role: artifact.releaseRole,
  });
};

export const validatePolicyActivationQaPackage = async (
  {
    store,
    namespace,
    packageReference,
    proposedPolicy,
    proposedPolicyReference,
    activationGate,
    executorSourceSha,
  },
  {
    validateBuildRequirements = validateAuthoritativeArtifactBuildRequirements,
  } = {},
) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: packageReference,
    label: "Policy activation QA package",
  });
  const index = assertPolicyActivationQaPackageIndex(
    parseCanonicalJsonBytes(stored.bytes, "Policy activation QA package"),
    {
      proposedPolicy,
      proposedPolicyReference,
      activationGate,
      executorSourceSha,
    },
  );
  if (stored.mediaType !== INDEX_MEDIA_TYPE) {
    throw new Error("Policy activation QA package media type is invalid");
  }
  const storedRequirements = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference: index.buildAuthority,
    label: "Policy QA artifact build requirements",
  });
  if (storedRequirements.mediaType !== ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE) {
    throw new Error(
      "Policy QA artifact build requirements media type is invalid",
    );
  }
  const { requirements } = await validateBuildRequirements({
    store,
    requirementsBytes: storedRequirements.bytes,
    expectedSha256: index.buildAuthority.sha256,
    checkoutSourceSha: index.sourceSha,
  });
  if (
    requirements.purpose !== "policy-activation-qa" ||
    requirements.targetGate !== activationGate ||
    !sameCanonicalValue(
      requirements.proposedReleasePolicy,
      proposedPolicyReference,
    )
  ) {
    throw new Error("Policy QA package build authority is invalid");
  }
  const manifests = [];
  for (const artifact of index.artifacts) {
    const manifestStored = await assertEvidenceObjectAvailable({
      store,
      namespace,
      reference: artifact.manifest,
      label: `Policy QA ${artifact.releaseRole} manifest`,
    });
    const manifest = parseCanonicalJsonBytes(
      manifestStored.bytes,
      `Policy QA ${artifact.releaseRole} manifest`,
    );
    if (manifestStored.mediaType !== MANIFEST_MEDIA_TYPE) {
      throw new Error("Policy QA manifest media type is invalid");
    }
    assertArtifactManifest(manifest, proposedPolicy, {
      expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    });
    if (
      manifest.sourceSha !== index.sourceSha ||
      manifest.buildId !== index.buildId ||
      manifest.variantId !== artifact.variantId ||
      manifest.releaseRole !== artifact.releaseRole ||
      manifest.toolchainPolicyHash !== index.toolchainPolicyHash ||
      manifest.releasePolicyHash !== proposedPolicyReference.sha256 ||
      !sameCanonicalValue(manifest.buildAuthority, index.buildAuthority) ||
      manifest.targetGate !== index.activationGate ||
      !sameCanonicalValue(
        manifest.requiredDbCompatibility,
        index.requiredDbCompatibility,
      )
    ) {
      throw new Error("Policy QA manifest differs from its package index");
    }
    await validateAvailability({
      store,
      namespace,
      artifact,
      manifest,
    });
    manifests.push(manifest);
  }
  if (
    !sameCanonicalValue(manifests[0].dimensions, {
      releaseRole: "standard",
      ...proposedPolicy.acceptedStandardFloors,
    }) ||
    !sameCanonicalValue(
      manifests[1].dimensions,
      projectContainmentDimensions(proposedPolicy, manifests[0].dimensions),
    )
  ) {
    throw new Error(
      "Policy QA package dimensions differ from the proposed gate",
    );
  }
  return index;
};
