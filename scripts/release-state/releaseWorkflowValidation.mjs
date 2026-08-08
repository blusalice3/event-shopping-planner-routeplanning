import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DEPLOYMENT_BINDING_KEYS = [
  "artifactManifest",
  "bindingId",
  "buildId",
  "deploymentUrl",
  "packageIndex",
  "providerConfigurationHash",
  "providerDeploymentId",
  "providerEvidence",
  "providerPolicy",
  "providerProjectId",
  "publicIdentityKind",
  "releasePolicy",
  "releaseRole",
  "requiredDbCompatibility",
  "sourceSha",
  "variantId",
];
const PROVIDER_EVIDENCE_KEYS = [
  "artifactManifestHash",
  "deploymentUrl",
  "environmentPresenceEvidenceHash",
  "packageIndexHash",
  "providerConfigurationHash",
  "providerDeploymentId",
  "providerPolicyHash",
  "providerProjectId",
  "publicIdentity",
  "releasePolicyHash",
  "releaseRole",
  "requiredDbCompatibility",
  "routeProbeEvidenceHash",
  "schemaVersion",
  "sourceSha",
  "variantId",
];

export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const assertExactKeys = (value, keys, label) => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value;
};

export const sameCanonicalValue = (left, right) =>
  sha256Json(left) === sha256Json(right);

export const parseCanonicalJsonBytes = (bytes, label) => {
  if (
    !Buffer.isBuffer(bytes) &&
    !(bytes instanceof Uint8Array) &&
    typeof bytes !== "string"
  ) {
    throw new Error(`${label} bytes are invalid`);
  }
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const value = parseJsonStrict(input.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(input)) {
    throw new Error(`${label} must use canonical JSON bytes`);
  }
  return value;
};

export const assertImmutableObjectReference = (
  reference,
  namespace,
  label = "Immutable object reference",
) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !SHA256_PATTERN.test(reference.sha256) ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} is not bound to the release namespace`);
  }
  return reference;
};

const assertNonEmptyBoundedString = (value, label, maximum = 255) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const assertDbCompatibility = (value, label) => {
  assertExactKeys(value, ["contractUri", "fingerprint"], label);
  assertNonEmptyBoundedString(value.contractUri, `${label} contract URI`, 2048);
  if (!SHA256_PATTERN.test(value.fingerprint)) {
    throw new Error(`${label} fingerprint is invalid`);
  }
};

const assertHttpsUrl = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} is not a trusted HTTPS URL`);
  }
};

export const assertDeploymentBinding = (
  binding,
  {
    namespace,
    expectedRole = null,
    allowLegacyBootstrap = false,
    label = "Deployment binding",
  },
) => {
  assertExactKeys(binding, DEPLOYMENT_BINDING_KEYS, label);
  assertNonEmptyBoundedString(binding.bindingId, `${label} ID`);
  if (
    !SOURCE_SHA_PATTERN.test(binding.sourceSha) ||
    binding.buildId !== binding.sourceSha ||
    !SHA256_PATTERN.test(binding.variantId) ||
    !["standard", "containment"].includes(binding.releaseRole) ||
    (expectedRole !== null && binding.releaseRole !== expectedRole)
  ) {
    throw new Error(`${label} source, variant, or role is invalid`);
  }
  if (
    binding.publicIdentityKind !== "release-identity-v1" &&
    !(
      allowLegacyBootstrap &&
      binding.releaseRole === "containment" &&
      binding.publicIdentityKind === "legacy-bootstrap-v1"
    )
  ) {
    throw new Error(`${label} public identity is invalid`);
  }
  assertNonEmptyBoundedString(
    binding.providerProjectId,
    `${label} provider project`,
  );
  assertNonEmptyBoundedString(
    binding.providerDeploymentId,
    `${label} provider deployment`,
  );
  assertHttpsUrl(binding.deploymentUrl, `${label} deployment URL`);
  for (const [field, fieldLabel] of [
    ["packageIndex", "package index"],
    ["artifactManifest", "artifact manifest"],
    ["providerEvidence", "provider evidence"],
    ["releasePolicy", "release policy"],
    ["providerPolicy", "provider policy"],
  ]) {
    assertImmutableObjectReference(
      binding[field],
      namespace,
      `${label} ${fieldLabel}`,
    );
  }
  if (!SHA256_PATTERN.test(binding.providerConfigurationHash)) {
    throw new Error(`${label} provider configuration hash is invalid`);
  }
  assertDbCompatibility(
    binding.requiredDbCompatibility,
    `${label} DB compatibility`,
  );
  return binding;
};

export const collectBindingEvidenceReferences = (binding) => [
  binding.packageIndex,
  binding.artifactManifest,
  binding.providerEvidence,
  binding.releasePolicy,
  binding.providerPolicy,
];

export const assertEvidenceObjectAvailable = async ({
  store,
  reference,
  namespace,
  label,
}) => {
  assertImmutableObjectReference(reference, namespace, label);
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    stored === null ||
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    typeof stored.mediaType !== "string"
  ) {
    throw new Error(`${label} is absent or failed immutable verification`);
  }
  return stored;
};

export const validateProviderEvidenceForBinding = async ({
  store,
  namespace,
  binding,
  label,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    reference: binding.providerEvidence,
    namespace,
    label: `${label} provider evidence`,
  });
  const evidence = parseCanonicalJsonBytes(
    stored.bytes,
    `${label} provider evidence`,
  );
  assertExactKeys(
    evidence,
    PROVIDER_EVIDENCE_KEYS,
    `${label} provider evidence`,
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.providerProjectId !== binding.providerProjectId ||
    evidence.providerDeploymentId !== binding.providerDeploymentId ||
    evidence.deploymentUrl !== binding.deploymentUrl ||
    evidence.sourceSha !== binding.sourceSha ||
    evidence.variantId !== binding.variantId ||
    evidence.releaseRole !== binding.releaseRole ||
    evidence.artifactManifestHash !== binding.artifactManifest.sha256 ||
    evidence.packageIndexHash !== binding.packageIndex.sha256 ||
    evidence.providerConfigurationHash !== binding.providerConfigurationHash ||
    evidence.providerPolicyHash !== binding.providerPolicy.sha256 ||
    evidence.releasePolicyHash !== binding.releasePolicy.sha256 ||
    !sameCanonicalValue(
      evidence.requiredDbCompatibility,
      binding.requiredDbCompatibility,
    ) ||
    !isRecord(evidence.publicIdentity) ||
    evidence.publicIdentity.identityKind !== binding.publicIdentityKind ||
    !SHA256_PATTERN.test(evidence.routeProbeEvidenceHash) ||
    !SHA256_PATTERN.test(evidence.environmentPresenceEvidenceHash)
  ) {
    throw new Error(`${label} provider evidence differs from its binding`);
  }
  return evidence;
};

export const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const sortAndDedupeReferences = (references, namespace) => {
  const byUri = new Map();
  for (const reference of references) {
    assertImmutableObjectReference(reference, namespace);
    const previous = byUri.get(reference.uri);
    if (previous && previous.sha256 !== reference.sha256) {
      throw new Error("Immutable evidence URI has conflicting hashes");
    }
    byUri.set(reference.uri, reference);
  }
  return [...byUri.values()].sort((left, right) =>
    compareUtf8(left.uri, right.uri),
  );
};
