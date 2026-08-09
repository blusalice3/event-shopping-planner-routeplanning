import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import {
  resolveContentAddressedObject,
  writeContentAddressedObject,
} from "./content-addressed-store.mjs";
import {
  assertDimensionObject,
  projectContainmentDimensions,
} from "./release-policy.mjs";
import { ARTIFACT_DRILL_BUILD_PURPOSE } from "./release-build-input.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";

export const ARTIFACT_DRILL_TARGET_GATE = "P0-ARTIFACT";
export const ARTIFACT_DRILL_BUILD_AUTHORITY_KIND =
  "artifact-drill-build-authority/v1";
export const ARTIFACT_DRILL_BUILD_AUTHORITY_OBJECT_KIND =
  "artifact-drill-build-authority.json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const AUTHORITY_KEYS = Object.freeze([
  "schemaVersion",
  "authorityKind",
  "sourceSha",
  "targetGate",
  "buildPurpose",
  "promotable",
  "releasePolicySha256",
  "toolchainPolicySha256",
  "providerPolicySha256",
  "providerObservationSha256",
  "providerConfigurationHash",
  "cspPolicySha256",
  "dbCompatibility",
  "foundationBaselineSha256",
  "standardDimensions",
  "containmentDimensions",
  "bootstrapVerification",
]);
const DB_BINDING_KEYS = Object.freeze(["contractUri", "fingerprint"]);
const BOOTSTRAP_VERIFICATION_KEYS = Object.freeze([
  "sourceSha",
  "packageIndexSha256",
  "artifactManifestSha256",
  "artifactArchiveSha256",
  "rawDistManifestSha256",
  "rawDistTreeSha256",
  "rawDistFileCount",
  "preserved",
  "releaseIdentityAbsent",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (value, keys, label) => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an unexpected property set`);
  }
};

const assertSha256 = (value, label) => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
};

const sameJson = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

export const assertArtifactDrillBootstrapVerification = (verification) => {
  assertExactKeys(
    verification,
    BOOTSTRAP_VERIFICATION_KEYS,
    "Artifact drill bootstrap verification",
  );
  if (!SOURCE_SHA_PATTERN.test(verification.sourceSha ?? "")) {
    throw new Error("Artifact drill bootstrap source SHA is invalid");
  }
  for (const key of BOOTSTRAP_VERIFICATION_KEYS.filter((key) =>
    key.endsWith("Sha256"),
  )) {
    assertSha256(verification[key], `Artifact drill bootstrap ${key}`);
  }
  if (
    !Number.isSafeInteger(verification.rawDistFileCount) ||
    verification.rawDistFileCount < 1 ||
    verification.preserved !== true ||
    verification.releaseIdentityAbsent !== true
  ) {
    throw new Error("Artifact drill bootstrap preservation proof is invalid");
  }
  return verification;
};

export const assertArtifactDrillBuildAuthority = (
  authority,
  {
    sourceSha = null,
    releasePolicy = null,
    toolchainPolicy = null,
    providerPolicy = null,
    providerObservation = null,
    dbContract = null,
    cspPolicy = null,
    foundationBaseline = null,
    bootstrapVerification = null,
  } = {},
) => {
  assertExactKeys(authority, AUTHORITY_KEYS, "Artifact drill build authority");
  if (
    authority.schemaVersion !== 1 ||
    authority.authorityKind !== ARTIFACT_DRILL_BUILD_AUTHORITY_KIND ||
    !SOURCE_SHA_PATTERN.test(authority.sourceSha ?? "") ||
    authority.targetGate !== ARTIFACT_DRILL_TARGET_GATE ||
    authority.buildPurpose !== ARTIFACT_DRILL_BUILD_PURPOSE ||
    authority.promotable !== false
  ) {
    throw new Error("Artifact drill build authority identity is invalid");
  }
  for (const key of [
    "releasePolicySha256",
    "toolchainPolicySha256",
    "providerPolicySha256",
    "providerObservationSha256",
    "providerConfigurationHash",
    "cspPolicySha256",
    "foundationBaselineSha256",
  ]) {
    assertSha256(authority[key], `Artifact drill authority ${key}`);
  }
  assertExactKeys(
    authority.dbCompatibility,
    DB_BINDING_KEYS,
    "Artifact drill DB compatibility",
  );
  if (
    typeof authority.dbCompatibility.contractUri !== "string" ||
    authority.dbCompatibility.contractUri.length === 0
  ) {
    throw new Error("Artifact drill DB contract URI is invalid");
  }
  assertSha256(
    authority.dbCompatibility.fingerprint,
    "Artifact drill DB fingerprint",
  );
  assertArtifactDrillBootstrapVerification(authority.bootstrapVerification);

  if (releasePolicy !== null) {
    assertDimensionObject(releasePolicy, authority.standardDimensions);
    assertDimensionObject(releasePolicy, authority.containmentDimensions);
    if (
      !sameJson(authority.standardDimensions, releasePolicy.initialStandard) ||
      !sameJson(
        authority.containmentDimensions,
        projectContainmentDimensions(
          releasePolicy,
          releasePolicy.initialStandard,
        ),
      )
    ) {
      throw new Error("Artifact drill dimensions differ from initial policy");
    }
  }
  const expectedHashes = [
    ["releasePolicySha256", releasePolicy],
    ["toolchainPolicySha256", toolchainPolicy],
    ["providerPolicySha256", providerPolicy],
    ["providerObservationSha256", providerObservation],
    ["cspPolicySha256", cspPolicy],
    ["foundationBaselineSha256", foundationBaseline],
  ];
  for (const [key, value] of expectedHashes) {
    if (value !== null && authority[key] !== sha256Json(value)) {
      throw new Error(`Artifact drill authority ${key} differs`);
    }
  }
  if (
    providerObservation !== null &&
    authority.providerConfigurationHash !==
      providerConfigurationHash(providerObservation)
  ) {
    throw new Error("Artifact drill provider configuration hash differs");
  }
  if (
    dbContract !== null &&
    (authority.dbCompatibility.contractUri !== dbContract.contractUri ||
      authority.dbCompatibility.fingerprint !== sha256Json(dbContract))
  ) {
    throw new Error("Artifact drill DB compatibility binding differs");
  }
  if (sourceSha !== null && authority.sourceSha !== sourceSha) {
    throw new Error("Artifact drill authority source SHA differs");
  }
  if (
    bootstrapVerification !== null &&
    !sameJson(authority.bootstrapVerification, bootstrapVerification)
  ) {
    throw new Error("Artifact drill bootstrap verification differs");
  }
  return authority;
};

export const createArtifactDrillBuildAuthority = ({
  sourceSha,
  releasePolicy,
  toolchainPolicy,
  providerPolicy,
  providerObservation,
  dbContract,
  cspPolicy,
  foundationBaseline,
  bootstrapVerification,
}) => {
  const authority = {
    schemaVersion: 1,
    authorityKind: ARTIFACT_DRILL_BUILD_AUTHORITY_KIND,
    sourceSha,
    targetGate: ARTIFACT_DRILL_TARGET_GATE,
    buildPurpose: ARTIFACT_DRILL_BUILD_PURPOSE,
    promotable: false,
    releasePolicySha256: sha256Json(releasePolicy),
    toolchainPolicySha256: sha256Json(toolchainPolicy),
    providerPolicySha256: sha256Json(providerPolicy),
    providerObservationSha256: sha256Json(providerObservation),
    providerConfigurationHash: providerConfigurationHash(providerObservation),
    cspPolicySha256: sha256Json(cspPolicy),
    dbCompatibility: {
      contractUri: dbContract.contractUri,
      fingerprint: sha256Json(dbContract),
    },
    foundationBaselineSha256: sha256Json(foundationBaseline),
    standardDimensions: structuredClone(releasePolicy.initialStandard),
    containmentDimensions: projectContainmentDimensions(
      releasePolicy,
      releasePolicy.initialStandard,
    ),
    bootstrapVerification: structuredClone(bootstrapVerification),
  };
  return assertArtifactDrillBuildAuthority(authority, {
    sourceSha,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    cspPolicy,
    foundationBaseline,
    bootstrapVerification,
  });
};

export const writeArtifactDrillBuildAuthority = async ({
  packageRoot,
  authority,
}) => {
  assertArtifactDrillBuildAuthority(authority);
  const stored = await writeContentAddressedObject({
    packageRoot,
    bytes: canonicalJsonBytes(authority),
    kind: ARTIFACT_DRILL_BUILD_AUTHORITY_OBJECT_KIND,
  });
  return { uri: stored.uri, sha256: stored.sha256 };
};

export const readArtifactDrillBuildAuthority = async ({
  packageRoot,
  reference,
  expected = {},
}) => {
  const object = await resolveContentAddressedObject({
    packageRoot,
    reference,
    expectedKind: ARTIFACT_DRILL_BUILD_AUTHORITY_OBJECT_KIND,
  });
  const authority = parseJsonStrict(
    object.bytes.toString("utf8"),
    "Artifact drill build authority",
  );
  if (
    !object.bytes.equals(canonicalJsonBytes(authority)) ||
    sha256Bytes(object.bytes) !== reference.sha256
  ) {
    throw new Error("Artifact drill build authority is not canonical");
  }
  assertArtifactDrillBuildAuthority(authority, expected);
  return { authority, object };
};
