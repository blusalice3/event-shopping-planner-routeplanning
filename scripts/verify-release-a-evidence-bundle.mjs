import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateReleaseAEvidence } from "./verify-release-a-evidence.mjs";
import { assertPerformanceArtifactValueForAcceptedGate } from "./lib/performance-evidence-identity.mjs";
import {
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";

const usage =
  "Usage: node scripts/verify-release-a-evidence-bundle.mjs <bundle.json> --objects <directory>";
const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_OBJECT_BYTES = 256 * 1024 * 1024;

const readStrictJsonFile = async (
  filePath,
  maximumBytes = MAX_EVIDENCE_OBJECT_BYTES,
) => {
  const metadata = await stat(filePath);
  if (
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`Evidence JSON size is invalid: ${filePath}`);
  }
  const bytes = await readFile(filePath);
  if (bytes.length !== metadata.size || bytes.length > maximumBytes) {
    throw new Error(`Evidence JSON changed while reading: ${filePath}`);
  }
  return {
    bytes,
    value: parseJsonStrict(bytes.toString("utf8"), filePath),
  };
};

export const BUNDLE_KEYS = [
  "approvals",
  "artifactManifest",
  "dbCompatibilityContract",
  "kind",
  "packageIndex",
  "performanceEvidence",
  "providerAssignmentEvidence",
  "providerDeploymentEvidence",
  "providerPolicy",
  "releasePolicy",
  "releaseRole",
  "releaseStateEvent",
  "schemaVersion",
  "sourceSha",
  "stage",
  "v1Evidence",
];

export const assertReleaseEvidenceBundleEnvelope = (bundle) => {
  if (
    bundle.schemaVersion !== 1 ||
    bundle.kind !== "release-evidence-bundle/v1" ||
    Object.keys(bundle).sort().join("\n") !== BUNDLE_KEYS.join("\n") ||
    !["standard", "containment"].includes(bundle.releaseRole) ||
    ![
      "pre-promotion",
      "post-assignment-validation",
      "incident-activation",
      "acceptance-final",
    ].includes(bundle.stage) ||
    !/^[0-9a-f]{40}$/.test(bundle.sourceSha) ||
    !Array.isArray(bundle.approvals) ||
    bundle.approvals.length > 3
  ) {
    throw new Error("Release evidence bundle identity is invalid");
  }
};

export const verifyReleaseAEvidenceBundle = async ({
  bundlePath,
  objectDirectory,
  validateV1Evidence = validateReleaseAEvidence,
}) => {
  if (
    typeof bundlePath !== "string" ||
    bundlePath.length === 0 ||
    typeof objectDirectory !== "string" ||
    objectDirectory.length === 0
  ) {
    throw new Error(usage);
  }
  const bundle = (
    await readStrictJsonFile(path.resolve(bundlePath), MAX_BUNDLE_BYTES)
  ).value;
  assertReleaseEvidenceBundleEnvelope(bundle);

  const resolved = new Map();
  const referenceNamespaces = new Set();
  const resolveObject = async (reference) => {
    const uriMatch =
      typeof reference?.uri === "string"
        ? /^release-state:\/\/([a-z0-9][a-z0-9-]{2,62})\/(?:evidence|events\/[1-9][0-9]*)\/([0-9a-f]{64})$/.exec(
            reference.uri,
          )
        : null;
    if (
      reference === null ||
      typeof reference !== "object" ||
      !/^[0-9a-f]{64}$/.test(reference.sha256) ||
      uriMatch === null ||
      uriMatch[2] !== reference.sha256
    ) {
      throw new Error("Bundle contains an invalid immutable object reference");
    }
    referenceNamespaces.add(uriMatch[1]);
    if (resolved.has(reference.sha256)) return resolved.get(reference.sha256);
    const candidates = [
      path.join(path.resolve(objectDirectory), reference.sha256),
      path.join(path.resolve(objectDirectory), `${reference.sha256}.json`),
    ];
    let objectPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        objectPath = candidate;
        break;
      } catch {
        // Resolve by content hash only; no URI-derived filesystem paths.
      }
    }
    if (objectPath === null) {
      throw new Error(`Missing evidence object: ${reference.sha256}`);
    }
    const object = await readStrictJsonFile(objectPath);
    if (sha256Bytes(object.bytes) !== reference.sha256) {
      throw new Error(`Evidence object hash mismatch: ${reference.sha256}`);
    }
    resolved.set(reference.sha256, object.value);
    return object.value;
  };

  const [
    v1Evidence,
    packageIndex,
    artifactManifest,
    providerEvidence,
    dbContract,
    releasePolicy,
    providerPolicy,
    releaseStateEvent,
  ] = await Promise.all([
    resolveObject(bundle.v1Evidence),
    resolveObject(bundle.packageIndex),
    resolveObject(bundle.artifactManifest),
    resolveObject(bundle.providerDeploymentEvidence),
    resolveObject(bundle.dbCompatibilityContract),
    resolveObject(bundle.releasePolicy),
    resolveObject(bundle.providerPolicy),
    resolveObject(bundle.releaseStateEvent),
  ]);
  const approvalObjects = await Promise.all(
    bundle.approvals.map((approval) => resolveObject(approval)),
  );
  const performanceEvidence =
    bundle.performanceEvidence === null
      ? null
      : await resolveObject(bundle.performanceEvidence);
  let assignmentEvidence = null;
  if (bundle.providerAssignmentEvidence !== null) {
    assignmentEvidence = await resolveObject(bundle.providerAssignmentEvidence);
  }

  const v1Errors = validateV1Evidence(v1Evidence);
  if (v1Errors.length > 0) {
    throw new Error(`Frozen v1 evidence failed: ${v1Errors.join("; ")}`);
  }
  if (
    v1Evidence.release.commitSha !== bundle.sourceSha ||
    v1Evidence.canary.buildSha !== bundle.sourceSha
  ) {
    throw new Error("Bundle source does not match frozen v1 evidence");
  }
  if (
    releaseStateEvent.schemaVersion !== 1 ||
    releaseStateEvent.namespace === undefined ||
    releaseStateEvent.payloadSha256 !== sha256Json(releaseStateEvent.payload) ||
    !Array.isArray(releaseStateEvent.approvalRefs) ||
    sha256Json(releaseStateEvent.approvalRefs) !== sha256Json(approvalObjects)
  ) {
    throw new Error("Bundle Release State event or approval chain differs");
  }
  const eventReferencePattern = new RegExp(
    `^release-state://${releaseStateEvent.namespace}/events/${releaseStateEvent.sequence}/${bundle.releaseStateEvent.sha256}$`,
  );
  if (
    !eventReferencePattern.test(bundle.releaseStateEvent.uri) ||
    referenceNamespaces.size !== 1 ||
    !referenceNamespaces.has(releaseStateEvent.namespace)
  ) {
    throw new Error(
      "Bundle immutable references do not share the event namespace",
    );
  }
  if (
    packageIndex.sourceSha !== bundle.sourceSha ||
    packageIndex.buildId !== bundle.sourceSha ||
    artifactManifest.sourceSha !== bundle.sourceSha ||
    artifactManifest.buildId !== bundle.sourceSha ||
    providerEvidence.sourceSha !== bundle.sourceSha
  ) {
    throw new Error("Bundle source identity chain differs");
  }
  if (
    artifactManifest.releaseRole !== bundle.releaseRole ||
    providerEvidence.releaseRole !== bundle.releaseRole ||
    artifactManifest.variantId !== providerEvidence.variantId ||
    artifactManifest.publicIdentityKind !==
      providerEvidence.publicIdentity?.identityKind ||
    artifactManifest.providerConfigurationHash !==
      providerEvidence.providerConfigurationHash ||
    packageIndex.providerConfigurationHash !==
      providerEvidence.providerConfigurationHash
  ) {
    throw new Error("Bundle release role differs across evidence");
  }
  const packageArtifact =
    packageIndex.packageKind === "source-hardened-pair"
      ? packageIndex.artifacts?.find(
          (artifact) => artifact.releaseRole === bundle.releaseRole,
        )
      : packageIndex.packageKind === "legacy-bootstrap-single"
        ? packageIndex.artifact
        : null;
  if (
    packageArtifact?.variantId !== artifactManifest.variantId ||
    packageArtifact?.manifest?.sha256 !== bundle.artifactManifest.sha256
  ) {
    throw new Error("Package index does not bind the selected artifact");
  }
  if (providerEvidence.publicIdentity?.identityKind === "release-identity-v1") {
    const identity = providerEvidence.publicIdentity.identity;
    if (
      providerEvidence.publicIdentity.identitySha256 !== sha256Json(identity) ||
      identity?.schemaVersion !== 1 ||
      identity.sourceSha !== bundle.sourceSha ||
      identity.buildId !== bundle.sourceSha ||
      identity.variantId !== artifactManifest.variantId ||
      identity.releaseRole !== bundle.releaseRole ||
      identity.requiredDbCompatibilityFingerprint !==
        packageIndex.requiredDbCompatibility.fingerprint
    ) {
      throw new Error("Provider release identity hash differs");
    }
  } else if (
    providerEvidence.publicIdentity?.identityKind !== "legacy-bootstrap-v1" ||
    providerEvidence.publicIdentity.sourceSha !== bundle.sourceSha ||
    providerEvidence.publicIdentity.buildId !== bundle.sourceSha
  ) {
    throw new Error("Provider public identity binding is invalid");
  }

  const dbFingerprint = sha256Json(dbContract);
  for (const binding of [
    packageIndex.requiredDbCompatibility,
    artifactManifest.requiredDbCompatibility,
    providerEvidence.requiredDbCompatibility,
  ]) {
    if (
      binding.contractUri !== dbContract.contractUri ||
      binding.fingerprint !== dbFingerprint
    ) {
      throw new Error("Bundle DB compatibility chain differs");
    }
  }
  const releasePolicyHash = sha256Json(releasePolicy);
  const providerPolicyHash = sha256Json(providerPolicy);
  for (const owner of [packageIndex, artifactManifest, providerEvidence]) {
    if (
      owner.releasePolicyHash !== releasePolicyHash ||
      owner.providerPolicyHash !== providerPolicyHash
    ) {
      throw new Error("Bundle policy hash chain differs");
    }
  }
  if (
    providerEvidence.artifactManifestHash !== bundle.artifactManifest.sha256 ||
    providerEvidence.packageIndexHash !== bundle.packageIndex.sha256
  ) {
    throw new Error("Provider evidence does not bind the bundle artifacts");
  }

  const distinctApprovalIds = new Set(
    approvalObjects.map((approval) => approval.approvalId),
  );
  if (
    distinctApprovalIds.size !== approvalObjects.length ||
    approvalObjects.some(
      (approval) =>
        typeof approval.approvalId !== "string" ||
        approval.approvalId.length === 0 ||
        typeof approval.providerReviewerId !== "string" ||
        approval.providerReviewerId.length === 0 ||
        approval.operationId !== releaseStateEvent.operationId ||
        approval.decision !== "APPROVED" ||
        approval.trustedIssuer !==
          "https://token.actions.githubusercontent.com" ||
        approval.protectedEnvironment !== "foundation-release-state" ||
        !Number.isFinite(new Date(approval.approvedAt).getTime()),
    )
  ) {
    throw new Error("Bundle approval identities or bindings are invalid");
  }
  if (assignmentEvidence !== null) {
    const assignments = assignmentEvidence.assignments;
    const utf8Compare = (left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
    const domains = Array.isArray(assignments)
      ? assignments.map((assignment) => assignment.productionDomain)
      : [];
    if (
      assignmentEvidence.schemaVersion !== 1 ||
      assignmentEvidence.evidenceKind !== "assignment-validation" ||
      assignmentEvidence.providerProjectId !==
        providerEvidence.providerProjectId ||
      domains.length === 0 ||
      domains.some(
        (domain) => typeof domain !== "string" || domain.length === 0,
      ) ||
      new Set(domains).size !== domains.length ||
      domains.some(
        (domain, index) =>
          index > 0 && utf8Compare(domains[index - 1], domain) >= 0,
      ) ||
      assignments.some(
        (assignment) =>
          assignment.assignedDeploymentId !==
          providerEvidence.providerDeploymentId,
      ) ||
      sha256Json(domains) !== sha256Json(providerPolicy.ownedProductionDomains)
    ) {
      throw new Error(
        "Provider assignment validation does not bind all domains",
      );
    }
    const assignmentReceipt = await resolveObject({
      uri: assignmentEvidence.assignmentReceiptUri,
      sha256: assignmentEvidence.assignmentReceiptSha256,
    });
    if (
      assignmentReceipt.evidenceKind !== "assignment-receipt" ||
      assignmentReceipt.providerProjectId !==
        providerEvidence.providerProjectId ||
      sha256Json(assignmentReceipt.assignments) !== sha256Json(assignments)
    ) {
      throw new Error("Provider assignment receipt chain differs");
    }
    if (
      referenceNamespaces.size !== 1 ||
      !referenceNamespaces.has(releaseStateEvent.namespace)
    ) {
      throw new Error("Provider assignment receipt namespace differs");
    }
  }
  if (bundle.stage === "acceptance-final") {
    if (
      bundle.releaseRole !== "standard" ||
      releaseStateEvent.eventType !== "release-accepted" ||
      bundle.providerAssignmentEvidence === null ||
      approvalObjects.length !== 3
    ) {
      throw new Error(
        "Only an assigned standard can have acceptance-final evidence",
      );
    }
    const performanceArtifact = assertPerformanceArtifactValueForAcceptedGate({
      acceptedGate: releaseStateEvent.payload?.acceptedGate,
      value: performanceEvidence,
      label: "Acceptance performance evidence",
    });
    if (bundle.performanceEvidence !== null) {
      const performanceSourceSha =
        performanceArtifact.artifactKind === "performance-inherited-closure/v1"
          ? performanceArtifact.value.closure.p8Source.gitCommitSha
          : performanceArtifact.value.evidence.source.gitCommitSha;
      if (
        performanceSourceSha !== bundle.sourceSha ||
        !releaseStateEvent.evidenceRefs.some(
          (reference) =>
            reference.uri === bundle.performanceEvidence.uri &&
            reference.sha256 === bundle.performanceEvidence.sha256,
        )
      ) {
        throw new Error(
          "Acceptance performance evidence identity or source binding differs",
        );
      }
    }
    const roles = new Set(approvalObjects.map((approval) => approval.role));
    for (const role of [
      "releaseOwner",
      "dataSafetyReviewer",
      "operationsReviewer",
    ]) {
      if (!roles.has(role)) {
        throw new Error(`Acceptance bundle lacks approval role: ${role}`);
      }
    }
  }
  if (
    bundle.releaseRole === "containment" &&
    bundle.stage === "acceptance-final"
  ) {
    throw new Error("Containment cannot be accepted");
  }

  return {
    immutableObjectCount: resolved.size,
    releaseRole: bundle.releaseRole,
    sourceSha: bundle.sourceSha,
    stage: bundle.stage,
  };
};

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const bundlePath = process.argv[2];
  const objectDirectoryIndex = process.argv.indexOf("--objects");
  const objectDirectory =
    objectDirectoryIndex === -1
      ? null
      : (process.argv[objectDirectoryIndex + 1] ?? null);
  if (!bundlePath || !objectDirectory) throw new Error(usage);
  const result = await verifyReleaseAEvidenceBundle({
    bundlePath,
    objectDirectory,
  });
  console.log(
    `PASS Release A evidence bundle: ${result.stage}; ${result.sourceSha}; ${result.immutableObjectCount} immutable objects.`,
  );
}
