import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import {
  assertDimensionObject,
  projectContainmentDimensions,
} from "./release-policy.mjs";
import { RELEASE_PHASE_GATES } from "../release-state/phaseGates.mjs";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const QA_BUILD_PURPOSE = "non-promotable-policy-activation-qa";

const sameJson = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertReference = (reference, expectedSha256, label) => {
  if (
    reference?.sha256 !== expectedSha256 ||
    !SHA256_PATTERN.test(reference.sha256) ||
    typeof reference.uri !== "string" ||
    !reference.uri.endsWith(`/${reference.sha256}`)
  ) {
    throw new Error(`${label} differs from the reviewed immutable reference`);
  }
};

export const assertArtifactBuildRuntimeAuthority = ({
  requirements,
  requirementsReference,
  sourceSha,
  releasePolicy,
  providerPolicy,
  toolchainPolicy,
  cspPolicy,
  dbContract,
}) => {
  if (
    !requirements ||
    !SOURCE_SHA_PATTERN.test(sourceSha) ||
    requirements.targetSourceSha !== sourceSha ||
    !RELEASE_PHASE_GATES.includes(requirements.targetGate)
  ) {
    throw new Error(
      "Artifact build source or target gate differs from requirements",
    );
  }
  const requirementsSha256 = sha256Bytes(canonicalJsonBytes(requirements));
  assertReference(
    requirementsReference,
    requirementsSha256,
    "Artifact build requirements",
  );
  assertReference(
    requirements.releasePolicy,
    sha256Json(releasePolicy),
    "Release policy",
  );
  assertReference(
    requirements.providerPolicy,
    sha256Json(providerPolicy),
    "Provider policy",
  );
  assertReference(
    requirements.toolchainPolicy,
    sha256Json(toolchainPolicy),
    "Toolchain policy",
  );
  assertReference(requirements.cspPolicy, sha256Json(cspPolicy), "CSP policy");
  const expectedDbCompatibility = {
    contractUri: dbContract.contractUri,
    fingerprint: sha256Json(dbContract),
  };
  if (!sameJson(requirements.currentDbCompatibility, expectedDbCompatibility)) {
    throw new Error(
      "DB compatibility differs from reviewed build requirements",
    );
  }
  assertDimensionObject(releasePolicy, requirements.standardDimensions);
  assertDimensionObject(releasePolicy, requirements.containmentDimensions);
  if (
    requirements.standardDimensions.releaseRole !== "standard" ||
    !sameJson(
      requirements.containmentDimensions,
      projectContainmentDimensions(
        releasePolicy,
        requirements.standardDimensions,
      ),
    )
  ) {
    throw new Error("Artifact build dimensions are not the reviewed role pair");
  }
  if (requirements.purpose === "production") {
    if (
      requirements.buildPurpose !== "production" ||
      requirements.promotable !== true ||
      releasePolicy.activationStatus !== "active" ||
      !Array.isArray(releasePolicy.blockerCodes) ||
      releasePolicy.blockerCodes.length !== 0 ||
      Object.hasOwn(requirements, "proposedReleasePolicy") ||
      Object.hasOwn(requirements, "activeReleasePolicy")
    ) {
      throw new Error(
        "Production artifact build policy is not active and promotable",
      );
    }
  } else if (requirements.purpose === "policy-activation-qa") {
    if (
      requirements.buildPurpose !== QA_BUILD_PURPOSE ||
      requirements.promotable !== false ||
      releasePolicy.activationStatus !== "proposed" ||
      requirements.proposedReleasePolicy?.sha256 !==
        requirements.releasePolicy.sha256 ||
      requirements.activeReleasePolicy?.sha256 ===
        requirements.proposedReleasePolicy?.sha256
    ) {
      throw new Error("Policy activation QA build authority is invalid");
    }
  } else {
    throw new Error("Artifact build purpose is invalid");
  }
  return {
    buildPurpose: requirements.buildPurpose,
    containmentDimensions: structuredClone(requirements.containmentDimensions),
    promotable: requirements.promotable,
    requirementsReference: structuredClone(requirementsReference),
    standardDimensions: structuredClone(requirements.standardDimensions),
    targetGate: requirements.targetGate,
  };
};
