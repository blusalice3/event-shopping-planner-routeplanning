import {
  assertArtifactManifest,
  assertPairRelationship,
  assertReleasePackageIndex,
} from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { verifyPhaseSequence } from "../lib/release-policy.mjs";
import {
  ARTIFACT_BUILD_REQUIREMENTS_KIND,
  ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  RELEASE_POLICY_MEDIA_TYPE,
  TOOLCHAIN_POLICY_MEDIA_TYPE,
} from "./artifactBuildAuthority.mjs";
import {
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  assertImmutableObjectReference,
  compareUtf8,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";

export const PRE_PROMOTION_EVIDENCE_CATEGORIES = Object.freeze([
  "qa",
  "reproducibility",
  "resource",
  "route",
  "security",
]);

export const PRE_PROMOTION_EVIDENCE_KINDS = Object.freeze({
  qa: "pre-promotion-qa-evidence/v1",
  reproducibility: "pre-promotion-reproducibility-evidence/v1",
  resource: "pre-promotion-resource-evidence/v1",
  route: "pre-promotion-route-evidence/v1",
  security: "pre-promotion-security-evidence/v1",
});

export const PRE_PROMOTION_EVIDENCE_MEDIA_TYPES = Object.freeze(
  Object.fromEntries(
    PRE_PROMOTION_EVIDENCE_CATEGORIES.map((category) => [
      category,
      `application/vnd.event-shopping-planner.pre-promotion-${category}+json;version=1`,
    ]),
  ),
);

export const PRE_PROMOTION_BUILD_RUN_KIND =
  "pre-promotion-reproducible-build-run/v1";
export const PRE_PROMOTION_BUILD_RUN_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.pre-promotion-build-run+json;version=1";
export const PRE_PROMOTION_VERIFIER_RUN_KIND = "pre-promotion-verifier-run/v1";
export const PRE_PROMOTION_VERIFIER_RUN_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.pre-promotion-verifier-run+json;version=1";
export const PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE =
  "text/plain;charset=utf-8";
export const PRE_PROMOTION_OIDC_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1";
export const PRE_PROMOTION_ROUTE_PROBE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.immutable-route-probe+json;version=1";
const DEPLOYMENT_RECEIPT_MEDIA_TYPE =
  "application/vnd.vercel.prebuilt-deployment-receipt+json;version=1";
const CSP_POLICY_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.csp-policy+json;version=1";
const PACKAGE_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-package-index+json;version=1";
const MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

const RECEIPT_COMMON_KEYS = Object.freeze([
  "buildAuthority",
  "buildId",
  "containmentArtifactArchive",
  "containmentManifest",
  "containmentVariantId",
  "evidenceKind",
  "namespace",
  "packageIndex",
  "proof",
  "releasePolicy",
  "requiredDbCompatibility",
  "schemaVersion",
  "sourceSha",
  "standardArtifactArchive",
  "standardManifest",
  "standardVariantId",
  "targetGate",
  "toolchainPolicy",
]);

const BUILD_REQUIREMENT_KEYS = Object.freeze([
  "acceptedGate",
  "buildPurpose",
  "containmentDimensions",
  "cspPolicy",
  "currentDbCompatibility",
  "executorSourceSha",
  "expectedState",
  "namespace",
  "operationId",
  "promotable",
  "providerPolicy",
  "purpose",
  "releasePolicy",
  "requirementsKind",
  "schemaVersion",
  "standardDimensions",
  "targetGate",
  "targetSourceSha",
  "toolchainPolicy",
]);

const VERIFIER_COMMANDS = Object.freeze({
  qa: Object.freeze([
    ["test-api", "npm run test:api"],
    ["test-browser", "npm run test:browser"],
    ["test-integration", "npm run test:integration"],
    ["test-unit", "npm run test:unit"],
    ["test-worker", "npm run test:worker"],
  ]),
  resource: Object.freeze([
    [
      "artifact-verify-build-1",
      "npm run artifact:verify -- -- --package <independent-build-output>",
      1,
    ],
    [
      "artifact-verify-build-2",
      "npm run artifact:verify -- -- --package <independent-build-output>",
      2,
    ],
    ["test-artifact", "npm run test:artifact"],
    ["verify-performance-policy", "npm run verify:performance-policy"],
  ]),
  security: Object.freeze([
    ["lint", "npm run lint"],
    ["test-encoding", "npm run test:encoding"],
    ["verify-architecture", "npm run verify:architecture"],
    ["verify-audit", "npm run verify:audit"],
    ["verify-csp-policy", "npm run verify:csp-policy"],
    ["verify-dependency-usage", "npm run verify:dependency-usage"],
    ["verify-toolchain", "npm run verify:toolchain"],
  ]),
});

const ROUTE_PROBE_KEYS = Object.freeze([
  "cspPolicy",
  "deploymentReceipt",
  "deploymentUrl",
  "evidenceKind",
  "namespace",
  "observedAt",
  "providerDeploymentId",
  "providerProjectId",
  "routes",
  "runtimeHtmlIdentity",
  "schemaVersion",
]);
const ROUTE_KEYS = Object.freeze([
  "bodySha256",
  "byteLength",
  "cacheControl",
  "contentType",
  "etag",
  "path",
  "requestUrl",
  "responseDate",
  "responseUrl",
  "securityHeaders",
  "status",
]);
const SECURITY_HEADER_KEYS = Object.freeze([
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
]);

const referenceFor = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const assertStore = (store, namespace, { write = false } = {}) => {
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    !store ||
    typeof store.readEvidence !== "function" ||
    (write && typeof store.putEvidence !== "function") ||
    (typeof store.namespace === "string" && store.namespace !== namespace)
  ) {
    throw new Error("Pre-promotion evidence store binding is invalid");
  }
};

const readStored = async ({
  store,
  namespace,
  reference,
  mediaType,
  label,
  canonical = true,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (stored.mediaType !== mediaType) {
    throw new Error(`${label} media type is invalid`);
  }
  return {
    bytes: stored.bytes,
    mediaType: stored.mediaType,
    value: canonical ? parseCanonicalJsonBytes(stored.bytes, label) : null,
  };
};

const putStored = async ({ store, namespace, bytes, mediaType, label }) => {
  const sha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return referenceFor(namespace, bytes);
};

const putCanonical = ({ store, namespace, value, mediaType, label }) =>
  putStored({
    store,
    namespace,
    bytes: canonicalJsonBytes(value),
    mediaType,
    label,
  });

const assertRunIdentity = (value, label) => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) {
    throw new Error(`${label} workflow run id is invalid`);
  }
  return value;
};

const assertRunAttempt = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error(`${label} workflow run attempt is invalid`);
  }
  return value;
};

export const assertPrePromotionOidcReceipt = ({
  receipt,
  sourceSha,
  workflowRunId,
  runAttempt,
  label,
}) => {
  assertExactKeys(
    receipt,
    [
      "audience",
      "claims",
      "issuer",
      "kind",
      "schemaVersion",
      "signingKey",
      "subject",
      "tokenSha256",
      "verifiedAt",
    ],
    label,
  );
  assertExactKeys(
    receipt.signingKey,
    ["jwkThumbprintSha256", "kid"],
    `${label} signing key`,
  );
  assertExactKeys(
    receipt.claims,
    [
      "environment",
      "eventName",
      "expiresAt",
      "issuedAt",
      "jti",
      "notBefore",
      "ref",
      "refProtected",
      "repository",
      "runAttempt",
      "runId",
      "sourceSha",
      "workflowRef",
      "workflowSha",
    ],
    `${label} claims`,
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "github-actions-oidc-verification/v1" ||
    receipt.claims.sourceSha !== sourceSha ||
    receipt.claims.workflowSha !== sourceSha ||
    receipt.claims.runId !== workflowRunId ||
    receipt.claims.runAttempt !== String(runAttempt) ||
    receipt.claims.refProtected !== true ||
    receipt.claims.eventName !== "workflow_dispatch" ||
    receipt.claims.ref !== "refs/heads/main" ||
    !SHA256_PATTERN.test(receipt.tokenSha256) ||
    !SHA256_PATTERN.test(receipt.signingKey.jwkThumbprintSha256) ||
    [
      receipt.issuer,
      receipt.audience,
      receipt.subject,
      receipt.signingKey.kid,
      receipt.claims.repository,
      receipt.claims.workflowRef,
      receipt.claims.environment,
      receipt.claims.jti,
    ].some((value) => typeof value !== "string" || value.length === 0) ||
    [
      receipt.claims.issuedAt,
      receipt.claims.notBefore,
      receipt.claims.expiresAt,
      receipt.verifiedAt,
    ].some((value) => !Number.isFinite(Date.parse(value)))
  ) {
    throw new Error(`${label} does not bind the protected workflow run`);
  }
  return receipt;
};

const validateOidcReference = async ({
  store,
  namespace,
  reference,
  sourceSha,
  workflowRunId,
  runAttempt,
  label,
}) => {
  const stored = await readStored({
    store,
    namespace,
    reference,
    mediaType: PRE_PROMOTION_OIDC_MEDIA_TYPE,
    label,
  });
  return assertPrePromotionOidcReceipt({
    receipt: stored.value,
    sourceSha,
    workflowRunId,
    runAttempt,
    label,
  });
};

const assertRequiredDb = (value, label) => {
  assertExactKeys(value, ["contractUri", "fingerprint"], label);
  if (
    typeof value.contractUri !== "string" ||
    value.contractUri.length === 0 ||
    !SHA256_PATTERN.test(value.fingerprint)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const assertBuildAuthority = async ({
  store,
  namespace,
  reference,
  index,
  standardManifest,
  containmentManifest,
}) => {
  const stored = await readStored({
    store,
    namespace,
    reference,
    mediaType: ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
    label: "Artifact build authority",
  });
  const authority = stored.value;
  assertExactKeys(
    authority,
    BUILD_REQUIREMENT_KEYS,
    "Artifact build authority",
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.requirementsKind !== ARTIFACT_BUILD_REQUIREMENTS_KIND ||
    authority.namespace !== namespace ||
    authority.purpose !== "production" ||
    authority.buildPurpose !== "production" ||
    authority.promotable !== true ||
    authority.targetSourceSha !== index.sourceSha ||
    authority.targetSourceSha !== authority.executorSourceSha ||
    authority.targetGate !== index.targetGate ||
    authority.releasePolicy?.sha256 !== standardManifest.releasePolicyHash ||
    !sameCanonicalValue(
      authority.standardDimensions,
      standardManifest.dimensions,
    ) ||
    !sameCanonicalValue(
      authority.containmentDimensions,
      containmentManifest.dimensions,
    ) ||
    !sameCanonicalValue(
      authority.currentDbCompatibility,
      index.requiredDbCompatibility,
    )
  ) {
    throw new Error("Artifact build authority differs from the package pair");
  }
  return authority;
};

const resolvePackageContext = async ({
  store,
  namespace,
  packageIndexReference,
  standardManifestReference,
  containmentManifestReference,
  releasePolicyReference,
  standardArchiveReference,
  containmentArchiveReference,
}) => {
  const [indexStored, standardStored, containmentStored, policyStored] =
    await Promise.all([
      readStored({
        store,
        namespace,
        reference: packageIndexReference,
        mediaType: PACKAGE_INDEX_MEDIA_TYPE,
        label: "Pre-promotion package index",
      }),
      readStored({
        store,
        namespace,
        reference: standardManifestReference,
        mediaType: MANIFEST_MEDIA_TYPE,
        label: "Pre-promotion standard manifest",
      }),
      readStored({
        store,
        namespace,
        reference: containmentManifestReference,
        mediaType: MANIFEST_MEDIA_TYPE,
        label: "Pre-promotion containment manifest",
      }),
      readStored({
        store,
        namespace,
        reference: releasePolicyReference,
        mediaType: RELEASE_POLICY_MEDIA_TYPE,
        label: "Pre-promotion release policy",
      }),
    ]);
  const index = assertReleasePackageIndex(indexStored.value);
  if (
    index.packageKind !== "source-hardened-pair" ||
    index.buildPurpose !== "production" ||
    index.promotable !== true
  ) {
    throw new Error("Pre-promotion package is not a promotable role pair");
  }
  const releasePolicy = policyStored.value;
  verifyPhaseSequence(releasePolicy);
  const standardManifest = assertArtifactManifest(
    standardStored.value,
    releasePolicy,
  );
  const containmentManifest = assertArtifactManifest(
    containmentStored.value,
    releasePolicy,
  );
  assertPairRelationship({
    index,
    standardManifest,
    containmentManifest,
    releasePolicy,
  });
  if (
    index.artifacts[0].manifest.sha256 !== standardManifestReference.sha256 ||
    index.artifacts[1].manifest.sha256 !==
      containmentManifestReference.sha256 ||
    index.artifacts[0].archive.sha256 !== standardArchiveReference.sha256 ||
    index.artifacts[1].archive.sha256 !== containmentArchiveReference.sha256 ||
    index.releasePolicyHash !== releasePolicyReference.sha256 ||
    !sameCanonicalValue(
      index.buildAuthority,
      standardManifest.buildAuthority,
    ) ||
    !sameCanonicalValue(
      index.buildAuthority,
      containmentManifest.buildAuthority,
    )
  ) {
    throw new Error("Pre-promotion package object references are inconsistent");
  }
  await Promise.all([
    readStored({
      store,
      namespace,
      reference: standardArchiveReference,
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
      label: "Pre-promotion standard archive",
      canonical: false,
    }),
    readStored({
      store,
      namespace,
      reference: containmentArchiveReference,
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
      label: "Pre-promotion containment archive",
      canonical: false,
    }),
  ]);
  const authority = await assertBuildAuthority({
    store,
    namespace,
    reference: index.buildAuthority,
    index,
    standardManifest,
    containmentManifest,
  });
  const toolchainStored = await readStored({
    store,
    namespace,
    reference: authority.toolchainPolicy,
    mediaType: TOOLCHAIN_POLICY_MEDIA_TYPE,
    label: "Pre-promotion toolchain policy",
  });
  if (
    authority.toolchainPolicy.sha256 !== index.toolchainPolicyHash ||
    sha256Json(toolchainStored.value) !== index.toolchainPolicyHash
  ) {
    throw new Error("Pre-promotion toolchain policy differs from the package");
  }
  return {
    authority,
    containmentArchiveReference,
    containmentManifest,
    containmentManifestReference,
    index,
    packageIndexReference,
    releasePolicy,
    releasePolicyReference,
    standardArchiveReference,
    standardManifest,
    standardManifestReference,
    toolchainPolicyReference: authority.toolchainPolicy,
  };
};

const commonReceiptFromContext = ({ category, namespace, context, proof }) => ({
  schemaVersion: 1,
  evidenceKind: PRE_PROMOTION_EVIDENCE_KINDS[category],
  namespace,
  sourceSha: context.index.sourceSha,
  buildId: context.index.buildId,
  buildAuthority: context.index.buildAuthority,
  targetGate: context.index.targetGate,
  packageIndex: context.packageIndexReference,
  standardManifest: context.standardManifestReference,
  containmentManifest: context.containmentManifestReference,
  standardArtifactArchive: context.standardArchiveReference,
  containmentArtifactArchive: context.containmentArchiveReference,
  standardVariantId: context.standardManifest.variantId,
  containmentVariantId: context.containmentManifest.variantId,
  releasePolicy: context.releasePolicyReference,
  toolchainPolicy: context.toolchainPolicyReference,
  requiredDbCompatibility: context.index.requiredDbCompatibility,
  proof,
});

const contextFromReceipt = async ({ store, namespace, receipt, category }) => {
  assertExactKeys(receipt, RECEIPT_COMMON_KEYS, `${category} evidence receipt`);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.evidenceKind !== PRE_PROMOTION_EVIDENCE_KINDS[category] ||
    receipt.namespace !== namespace ||
    !SOURCE_SHA_PATTERN.test(receipt.sourceSha) ||
    receipt.buildId !== receipt.sourceSha ||
    !SHA256_PATTERN.test(receipt.standardVariantId) ||
    !SHA256_PATTERN.test(receipt.containmentVariantId)
  ) {
    throw new Error(`${category} evidence receipt identity is invalid`);
  }
  assertRequiredDb(
    receipt.requiredDbCompatibility,
    `${category} evidence DB compatibility`,
  );
  const context = await resolvePackageContext({
    store,
    namespace,
    packageIndexReference: receipt.packageIndex,
    standardManifestReference: receipt.standardManifest,
    containmentManifestReference: receipt.containmentManifest,
    releasePolicyReference: receipt.releasePolicy,
    standardArchiveReference: receipt.standardArtifactArchive,
    containmentArchiveReference: receipt.containmentArtifactArchive,
  });
  if (
    receipt.sourceSha !== context.index.sourceSha ||
    receipt.buildId !== context.index.buildId ||
    receipt.targetGate !== context.index.targetGate ||
    !sameCanonicalValue(receipt.buildAuthority, context.index.buildAuthority) ||
    receipt.standardVariantId !== context.standardManifest.variantId ||
    receipt.containmentVariantId !== context.containmentManifest.variantId ||
    !sameCanonicalValue(
      receipt.toolchainPolicy,
      context.toolchainPolicyReference,
    ) ||
    !sameCanonicalValue(
      receipt.requiredDbCompatibility,
      context.index.requiredDbCompatibility,
    )
  ) {
    throw new Error(`${category} evidence receipt differs from its package`);
  }
  return context;
};

const assertCommandOutput = (bytes, label) => {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${label} is oversized or invalid`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not UTF-8`);
  }
  return bytes;
};

const readLog = async ({ store, namespace, reference, label }) => {
  const stored = await readStored({
    store,
    namespace,
    reference,
    mediaType: PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE,
    label,
    canonical: false,
  });
  assertCommandOutput(stored.bytes, label);
  return stored;
};

const validateBuildRun = async ({ store, namespace, reference, context }) => {
  const stored = await readStored({
    store,
    namespace,
    reference,
    mediaType: PRE_PROMOTION_BUILD_RUN_MEDIA_TYPE,
    label: "Reproducibility build run",
  });
  const run = stored.value;
  assertExactKeys(
    run,
    [
      "command",
      "buildOrdinal",
      "containmentArtifactArchive",
      "issuerReceipt",
      "namespace",
      "packageIndex",
      "receiptKind",
      "runAttempt",
      "schemaVersion",
      "sourceSha",
      "standardArtifactArchive",
      "stderr",
      "stdout",
      "toolchainPolicy",
      "workflowRunId",
    ],
    "Reproducibility build run",
  );
  if (
    run.schemaVersion !== 1 ||
    run.receiptKind !== PRE_PROMOTION_BUILD_RUN_KIND ||
    run.namespace !== namespace ||
    run.command !== "npm run artifact:build" ||
    ![1, 2].includes(run.buildOrdinal) ||
    run.sourceSha !== context.index.sourceSha ||
    !sameCanonicalValue(run.packageIndex, context.packageIndexReference) ||
    !sameCanonicalValue(
      run.standardArtifactArchive,
      context.standardArchiveReference,
    ) ||
    !sameCanonicalValue(
      run.containmentArtifactArchive,
      context.containmentArchiveReference,
    ) ||
    !sameCanonicalValue(run.toolchainPolicy, context.toolchainPolicyReference)
  ) {
    throw new Error("Reproducibility build run differs from the package");
  }
  assertRunIdentity(run.workflowRunId, "Reproducibility build run");
  assertRunAttempt(run.runAttempt, "Reproducibility build run");
  await Promise.all([
    validateOidcReference({
      store,
      namespace,
      reference: run.issuerReceipt,
      sourceSha: run.sourceSha,
      workflowRunId: run.workflowRunId,
      runAttempt: run.runAttempt,
      label: "Reproducibility build OIDC receipt",
    }),
    readLog({
      store,
      namespace,
      reference: run.stdout,
      label: "Reproducibility build stdout",
    }),
    readLog({
      store,
      namespace,
      reference: run.stderr,
      label: "Reproducibility build stderr",
    }),
  ]);
  return run;
};

const validateVerifierRun = async ({
  store,
  namespace,
  reference,
  context,
  category,
}) => {
  const stored = await readStored({
    store,
    namespace,
    reference,
    mediaType: PRE_PROMOTION_VERIFIER_RUN_MEDIA_TYPE,
    label: `${category} verifier run`,
  });
  const run = stored.value;
  assertExactKeys(
    run,
    [
      "category",
      "commands",
      "issuerReceipt",
      "namespace",
      "packageIndex",
      "receiptKind",
      "runAttempt",
      "schemaVersion",
      "sourceSha",
      "toolchainPolicy",
      "workflowRunId",
    ],
    `${category} verifier run`,
  );
  const expectedCommands = VERIFIER_COMMANDS[category];
  if (
    run.schemaVersion !== 1 ||
    run.receiptKind !== PRE_PROMOTION_VERIFIER_RUN_KIND ||
    run.category !== category ||
    run.namespace !== namespace ||
    run.sourceSha !== context.index.sourceSha ||
    !sameCanonicalValue(run.packageIndex, context.packageIndexReference) ||
    !sameCanonicalValue(
      run.toolchainPolicy,
      context.toolchainPolicyReference,
    ) ||
    !Array.isArray(run.commands) ||
    run.commands.length !== expectedCommands.length
  ) {
    throw new Error(`${category} verifier run identity is invalid`);
  }
  assertRunIdentity(run.workflowRunId, `${category} verifier run`);
  assertRunAttempt(run.runAttempt, `${category} verifier run`);
  await validateOidcReference({
    store,
    namespace,
    reference: run.issuerReceipt,
    sourceSha: run.sourceSha,
    workflowRunId: run.workflowRunId,
    runAttempt: run.runAttempt,
    label: `${category} verifier OIDC receipt`,
  });
  for (const [
    index,
    [id, command, targetBuildOrdinal = null],
  ] of expectedCommands.entries()) {
    const actual = run.commands[index];
    assertExactKeys(
      actual,
      ["command", "exitCode", "id", "stderr", "stdout", "target"],
      `${category} verifier command ${id}`,
    );
    const expectedTarget =
      targetBuildOrdinal === null
        ? null
        : {
            buildOrdinal: targetBuildOrdinal,
            packageIndex: context.packageIndexReference,
            standardArtifactArchive: context.standardArchiveReference,
            containmentArtifactArchive: context.containmentArchiveReference,
          };
    if (
      actual.id !== id ||
      actual.command !== command ||
      actual.exitCode !== 0 ||
      !sameCanonicalValue(actual.target, expectedTarget)
    ) {
      throw new Error(`${category} verifier command matrix is invalid`);
    }
    await Promise.all([
      readLog({
        store,
        namespace,
        reference: actual.stdout,
        label: `${category} ${id} stdout`,
      }),
      readLog({
        store,
        namespace,
        reference: actual.stderr,
        label: `${category} ${id} stderr`,
      }),
    ]);
  }
  return run;
};

const assertNullableHeader = (value, label) => {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length > 8192 ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== 0x09 && (codePoint <= 0x1f || codePoint === 0x7f);
      }))
  ) {
    throw new Error(`${label} is invalid`);
  }
};

const validateRouteProbe = async ({
  store,
  namespace,
  reference,
  manifest,
  binding,
  label,
}) => {
  const stored = await readStored({
    store,
    namespace,
    reference,
    mediaType: PRE_PROMOTION_ROUTE_PROBE_MEDIA_TYPE,
    label,
  });
  const probe = stored.value;
  assertExactKeys(probe, ROUTE_PROBE_KEYS, label);
  if (
    probe.schemaVersion !== 1 ||
    probe.evidenceKind !== "immutable-deployment-route-probe/v1" ||
    probe.namespace !== namespace ||
    !Number.isFinite(Date.parse(probe.observedAt)) ||
    probe.runtimeHtmlIdentity?.sourceSha !== manifest.sourceSha ||
    probe.runtimeHtmlIdentity?.buildId !== manifest.buildId ||
    !Array.isArray(probe.routes)
  ) {
    throw new Error(`${label} identity is invalid`);
  }
  if (
    binding &&
    (probe.providerProjectId !== binding.providerProjectId ||
      probe.providerDeploymentId !== binding.providerDeploymentId ||
      probe.deploymentUrl !== binding.deploymentUrl)
  ) {
    throw new Error(`${label} differs from its DeploymentBinding`);
  }
  const expectedPaths = Object.keys(manifest.publicResponseHashes).sort(
    compareUtf8,
  );
  const actualPaths = probe.routes.map((route) => route?.path);
  if (!sameCanonicalValue(actualPaths, expectedPaths)) {
    throw new Error(`${label} route set differs from the artifact manifest`);
  }
  for (const route of probe.routes) {
    assertExactKeys(route, ROUTE_KEYS, `${label} route`);
    assertExactKeys(
      route.securityHeaders,
      SECURITY_HEADER_KEYS,
      `${label} route security headers`,
    );
    const expectedUrl = `${probe.deploymentUrl}${route.path}`;
    if (
      route.requestUrl !== expectedUrl ||
      route.responseUrl !== expectedUrl ||
      route.status !== 200 ||
      route.bodySha256 !== manifest.publicResponseHashes[route.path] ||
      !Number.isSafeInteger(route.byteLength) ||
      route.byteLength < 0 ||
      !Number.isFinite(Date.parse(route.responseDate))
    ) {
      throw new Error(`${label} route receipt is invalid`);
    }
    for (const [name, value] of Object.entries({
      cacheControl: route.cacheControl,
      contentType: route.contentType,
      etag: route.etag,
      ...route.securityHeaders,
    })) {
      assertNullableHeader(value, `${label} route ${name}`);
    }
  }
  await Promise.all([
    readStored({
      store,
      namespace,
      reference: probe.deploymentReceipt,
      mediaType: DEPLOYMENT_RECEIPT_MEDIA_TYPE,
      label: `${label} deployment receipt`,
    }),
    readStored({
      store,
      namespace,
      reference: probe.cspPolicy,
      mediaType: CSP_POLICY_MEDIA_TYPE,
      label: `${label} CSP policy`,
    }),
  ]);
  return probe;
};

const validateCategoryProof = async ({
  store,
  namespace,
  category,
  receipt,
  context,
  bindings,
}) => {
  if (category === "reproducibility") {
    assertExactKeys(
      receipt.proof,
      ["firstBuildRun", "secondBuildRun"],
      "Reproducibility proof",
    );
    const [first, second] = await Promise.all([
      validateBuildRun({
        store,
        namespace,
        reference: receipt.proof.firstBuildRun,
        context,
      }),
      validateBuildRun({
        store,
        namespace,
        reference: receipt.proof.secondBuildRun,
        context,
      }),
    ]);
    if (
      first.workflowRunId === second.workflowRunId &&
      first.runAttempt === second.runAttempt &&
      first.buildOrdinal === second.buildOrdinal
    ) {
      throw new Error("Reproducibility proof must use two distinct build runs");
    }
    return [first, second].map(({ workflowRunId, runAttempt, sourceSha }) => ({
      workflowRunId,
      runAttempt,
      sourceSha,
    }));
  }
  if (category === "qa" || category === "security" || category === "resource") {
    assertExactKeys(receipt.proof, ["verifierRun"], `${category} proof`);
    const run = await validateVerifierRun({
      store,
      namespace,
      reference: receipt.proof.verifierRun,
      context,
      category,
    });
    return [
      {
        workflowRunId: run.workflowRunId,
        runAttempt: run.runAttempt,
        sourceSha: run.sourceSha,
      },
    ];
  }
  assertExactKeys(
    receipt.proof,
    ["containmentRouteProbe", "standardRouteProbe"],
    "Route proof",
  );
  const standardBinding = bindings?.standard ?? null;
  const containmentBinding = bindings?.containment ?? null;
  await Promise.all([
    validateRouteProbe({
      store,
      namespace,
      reference: receipt.proof.standardRouteProbe,
      manifest: context.standardManifest,
      binding: standardBinding,
      label: "Standard immutable route probe",
    }),
    validateRouteProbe({
      store,
      namespace,
      reference: receipt.proof.containmentRouteProbe,
      manifest: context.containmentManifest,
      binding: containmentBinding,
      label: "Containment immutable route probe",
    }),
  ]);
  if (
    standardBinding &&
    standardBinding.providerEvidence &&
    containmentBinding?.providerEvidence
  ) {
    const [standardProvider, containmentProvider] = await Promise.all([
      validateProviderEvidenceForBinding({
        store,
        namespace,
        binding: standardBinding,
        label: "Pre-promotion standard",
      }),
      validateProviderEvidenceForBinding({
        store,
        namespace,
        binding: containmentBinding,
        label: "Pre-promotion containment",
      }),
    ]);
    if (
      standardProvider.routeProbeEvidenceHash !==
        receipt.proof.standardRouteProbe.sha256 ||
      containmentProvider.routeProbeEvidenceHash !==
        receipt.proof.containmentRouteProbe.sha256
    ) {
      throw new Error("Route proof references differ from provider evidence");
    }
  }
  return [];
};

const assertContextMatchesBindings = ({ context, bindings, namespace }) => {
  if (!bindings) return;
  const { standard, containment } = bindings;
  assertDeploymentBinding(standard, {
    namespace,
    expectedRole: "standard",
    label: "Pre-promotion standard binding",
  });
  assertDeploymentBinding(containment, {
    namespace,
    expectedRole: "containment",
    label: "Pre-promotion containment binding",
  });
  if (
    standard.sourceSha !== context.index.sourceSha ||
    containment.sourceSha !== context.index.sourceSha ||
    standard.buildId !== context.index.buildId ||
    containment.buildId !== context.index.buildId ||
    standard.variantId !== context.standardManifest.variantId ||
    containment.variantId !== context.containmentManifest.variantId ||
    !sameCanonicalValue(standard.packageIndex, context.packageIndexReference) ||
    !sameCanonicalValue(
      containment.packageIndex,
      context.packageIndexReference,
    ) ||
    !sameCanonicalValue(
      standard.artifactManifest,
      context.standardManifestReference,
    ) ||
    !sameCanonicalValue(
      containment.artifactManifest,
      context.containmentManifestReference,
    ) ||
    !sameCanonicalValue(
      standard.artifactArchive,
      context.standardArchiveReference,
    ) ||
    !sameCanonicalValue(
      containment.artifactArchive,
      context.containmentArchiveReference,
    ) ||
    !sameCanonicalValue(
      standard.releasePolicy,
      context.releasePolicyReference,
    ) ||
    !sameCanonicalValue(
      containment.releasePolicy,
      context.releasePolicyReference,
    ) ||
    !sameCanonicalValue(
      standard.requiredDbCompatibility,
      context.index.requiredDbCompatibility,
    ) ||
    !sameCanonicalValue(
      containment.requiredDbCompatibility,
      context.index.requiredDbCompatibility,
    )
  ) {
    throw new Error("Pre-promotion evidence differs from DeploymentBindings");
  }
};

const contextIdentity = (context) => ({
  buildAuthority: context.index.buildAuthority,
  buildId: context.index.buildId,
  containmentArchive: context.containmentArchiveReference,
  containmentManifest: context.containmentManifestReference,
  containmentVariantId: context.containmentManifest.variantId,
  packageIndex: context.packageIndexReference,
  releasePolicy: context.releasePolicyReference,
  requiredDbCompatibility: context.index.requiredDbCompatibility,
  sourceSha: context.index.sourceSha,
  standardArchive: context.standardArchiveReference,
  standardManifest: context.standardManifestReference,
  standardVariantId: context.standardManifest.variantId,
  targetGate: context.index.targetGate,
  toolchainPolicy: context.toolchainPolicyReference,
});

const namedReferencesFromArray = (references, namespace) => {
  if (!Array.isArray(references) || references.length !== 5) {
    throw new Error("Pre-promotion evidence requires exactly five receipts");
  }
  const sorted = sortAndDedupeReferences(references, namespace);
  if (
    sorted.length !== references.length ||
    !sameCanonicalValue(sorted, references)
  ) {
    throw new Error("Pre-promotion evidence references are not canonical");
  }
  return references;
};

export const assertNamedPrePromotionEvidence = (named, namespace) => {
  assertExactKeys(
    named,
    PRE_PROMOTION_EVIDENCE_CATEGORIES,
    "Pre-promotion named evidence",
  );
  for (const category of PRE_PROMOTION_EVIDENCE_CATEGORIES) {
    assertImmutableObjectReference(
      named[category],
      namespace,
      `Pre-promotion ${category} evidence`,
    );
  }
  const refs = Object.values(named);
  if (new Set(refs.map(({ sha256 }) => sha256)).size !== refs.length) {
    throw new Error("Pre-promotion named evidence references must be distinct");
  }
  return named;
};

export const resolveNamedPrePromotionEvidence = async ({
  store,
  namespace,
  namedEvidence,
  bindings = null,
  snapshot = null,
}) => {
  assertStore(store, namespace);
  assertNamedPrePromotionEvidence(namedEvidence, namespace);
  const resolved = {};
  const workflowRuns = [];
  let identity = null;
  for (const category of PRE_PROMOTION_EVIDENCE_CATEGORIES) {
    const stored = await readStored({
      store,
      namespace,
      reference: namedEvidence[category],
      mediaType: PRE_PROMOTION_EVIDENCE_MEDIA_TYPES[category],
      label: `Pre-promotion ${category} receipt`,
    });
    const context = await contextFromReceipt({
      store,
      namespace,
      receipt: stored.value,
      category,
    });
    assertContextMatchesBindings({ context, bindings, namespace });
    workflowRuns.push(
      ...(await validateCategoryProof({
        store,
        namespace,
        category,
        receipt: stored.value,
        context,
        bindings,
      })),
    );
    const actualIdentity = contextIdentity(context);
    if (identity !== null && !sameCanonicalValue(identity, actualIdentity)) {
      throw new Error(
        "Pre-promotion category receipts bind different packages",
      );
    }
    identity = actualIdentity;
    resolved[category] = stored.value;
  }
  if (
    snapshot &&
    (!sameCanonicalValue(
      identity.releasePolicy,
      snapshot.activeReleasePolicy,
    ) ||
      !sameCanonicalValue(
        identity.requiredDbCompatibility,
        snapshot.currentDbCompatibility,
      ))
  ) {
    throw new Error("Pre-promotion evidence differs from current policy or DB");
  }
  const references = Object.values(namedEvidence).sort((left, right) =>
    compareUtf8(left.uri, right.uri),
  );
  if (
    workflowRuns.length !== 5 ||
    workflowRuns.some(
      (run) =>
        run.workflowRunId !== workflowRuns[0].workflowRunId ||
        run.runAttempt !== workflowRuns[0].runAttempt ||
        run.sourceSha !== workflowRuns[0].sourceSha,
    )
  ) {
    throw new Error(
      "Pre-promotion evidence proofs do not share one protected workflow run",
    );
  }
  return {
    identity,
    namedEvidence,
    receipts: resolved,
    references,
    workflowRun: structuredClone(workflowRuns[0]),
  };
};

export const resolvePrePromotionEvidenceReferences = async ({
  store,
  namespace,
  references,
  bindings = null,
  snapshot = null,
}) => {
  namedReferencesFromArray(references, namespace);
  const namedEvidence = {};
  for (const reference of references) {
    const stored = await assertEvidenceObjectAvailable({
      store,
      namespace,
      reference,
      label: "Pre-promotion evidence receipt",
    });
    const category = PRE_PROMOTION_EVIDENCE_CATEGORIES.find(
      (candidate) =>
        stored.mediaType === PRE_PROMOTION_EVIDENCE_MEDIA_TYPES[candidate],
    );
    if (!category || Object.hasOwn(namedEvidence, category)) {
      throw new Error(
        "Pre-promotion evidence has a missing, duplicate, or wrong category",
      );
    }
    namedEvidence[category] = reference;
  }
  return resolveNamedPrePromotionEvidence({
    store,
    namespace,
    namedEvidence,
    bindings,
    snapshot,
  });
};

export const resolvePrePromotionBindingContext = async ({
  store,
  namespace,
  standardBinding,
  containmentBinding,
}) => {
  assertDeploymentBinding(standardBinding, {
    namespace,
    expectedRole: "standard",
    label: "Pre-promotion standard binding",
  });
  assertDeploymentBinding(containmentBinding, {
    namespace,
    expectedRole: "containment",
    label: "Pre-promotion containment binding",
  });
  const context = await resolvePackageContext({
    store,
    namespace,
    packageIndexReference: standardBinding.packageIndex,
    standardManifestReference: standardBinding.artifactManifest,
    containmentManifestReference: containmentBinding.artifactManifest,
    releasePolicyReference: standardBinding.releasePolicy,
    standardArchiveReference: standardBinding.artifactArchive,
    containmentArchiveReference: containmentBinding.artifactArchive,
  });
  assertContextMatchesBindings({
    context,
    bindings: { standard: standardBinding, containment: containmentBinding },
    namespace,
  });
  return context;
};

export const storePrePromotionBuildRunReceipt = async ({
  store,
  namespace,
  standardBinding,
  containmentBinding,
  workflowRunId,
  runAttempt,
  buildOrdinal,
  issuerReceiptReference,
  stdoutBytes,
  stderrBytes,
}) => {
  assertStore(store, namespace, { write: true });
  assertRunIdentity(workflowRunId, "Pre-promotion build");
  assertRunAttempt(runAttempt, "Pre-promotion build");
  if (![1, 2].includes(buildOrdinal)) {
    throw new Error("Pre-promotion build ordinal is invalid");
  }
  assertCommandOutput(stdoutBytes, "Pre-promotion build stdout");
  assertCommandOutput(stderrBytes, "Pre-promotion build stderr");
  const context = await resolvePrePromotionBindingContext({
    store,
    namespace,
    standardBinding,
    containmentBinding,
  });
  await validateOidcReference({
    store,
    namespace,
    reference: issuerReceiptReference,
    sourceSha: context.index.sourceSha,
    workflowRunId,
    runAttempt,
    label: "Pre-promotion build OIDC receipt",
  });
  const [stdout, stderr] = await Promise.all([
    putStored({
      store,
      namespace,
      bytes: stdoutBytes,
      mediaType: PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE,
      label: "Pre-promotion build stdout",
    }),
    putStored({
      store,
      namespace,
      bytes: stderrBytes,
      mediaType: PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE,
      label: "Pre-promotion build stderr",
    }),
  ]);
  const value = {
    schemaVersion: 1,
    receiptKind: PRE_PROMOTION_BUILD_RUN_KIND,
    namespace,
    workflowRunId,
    runAttempt,
    buildOrdinal,
    sourceSha: context.index.sourceSha,
    command: "npm run artifact:build",
    issuerReceipt: issuerReceiptReference,
    packageIndex: context.packageIndexReference,
    standardArtifactArchive: context.standardArchiveReference,
    containmentArtifactArchive: context.containmentArchiveReference,
    toolchainPolicy: context.toolchainPolicyReference,
    stdout,
    stderr,
  };
  return putCanonical({
    store,
    namespace,
    value,
    mediaType: PRE_PROMOTION_BUILD_RUN_MEDIA_TYPE,
    label: "Pre-promotion build run",
  });
};

export const storePrePromotionVerifierRunReceipt = async ({
  store,
  namespace,
  standardBinding,
  containmentBinding,
  category,
  workflowRunId,
  runAttempt,
  issuerReceiptReference,
  executions,
}) => {
  assertStore(store, namespace, { write: true });
  if (!Object.hasOwn(VERIFIER_COMMANDS, category)) {
    throw new Error("Pre-promotion verifier category is invalid");
  }
  assertRunIdentity(workflowRunId, `${category} verifier`);
  assertRunAttempt(runAttempt, `${category} verifier`);
  const expected = VERIFIER_COMMANDS[category];
  if (!Array.isArray(executions) || executions.length !== expected.length) {
    throw new Error(`${category} verifier command results are incomplete`);
  }
  const context = await resolvePrePromotionBindingContext({
    store,
    namespace,
    standardBinding,
    containmentBinding,
  });
  await validateOidcReference({
    store,
    namespace,
    reference: issuerReceiptReference,
    sourceSha: context.index.sourceSha,
    workflowRunId,
    runAttempt,
    label: `${category} verifier OIDC receipt`,
  });
  const commands = [];
  for (const [
    index,
    [id, command, targetBuildOrdinal = null],
  ] of expected.entries()) {
    const execution = executions[index];
    if (
      execution?.id !== id ||
      execution.exitCode !== 0 ||
      (execution.targetBuildOrdinal ?? null) !== targetBuildOrdinal ||
      !Buffer.isBuffer(execution.stdoutBytes) ||
      !Buffer.isBuffer(execution.stderrBytes)
    ) {
      throw new Error(`${category} verifier command result is invalid: ${id}`);
    }
    assertCommandOutput(execution.stdoutBytes, `${category} ${id} stdout`);
    assertCommandOutput(execution.stderrBytes, `${category} ${id} stderr`);
    const [stdout, stderr] = await Promise.all([
      putStored({
        store,
        namespace,
        bytes: execution.stdoutBytes,
        mediaType: PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE,
        label: `${category} ${id} stdout`,
      }),
      putStored({
        store,
        namespace,
        bytes: execution.stderrBytes,
        mediaType: PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE,
        label: `${category} ${id} stderr`,
      }),
    ]);
    commands.push({
      id,
      command,
      exitCode: 0,
      target:
        targetBuildOrdinal === null
          ? null
          : {
              buildOrdinal: targetBuildOrdinal,
              packageIndex: context.packageIndexReference,
              standardArtifactArchive: context.standardArchiveReference,
              containmentArtifactArchive: context.containmentArchiveReference,
            },
      stdout,
      stderr,
    });
  }
  const value = {
    schemaVersion: 1,
    receiptKind: PRE_PROMOTION_VERIFIER_RUN_KIND,
    category,
    namespace,
    workflowRunId,
    runAttempt,
    issuerReceipt: issuerReceiptReference,
    sourceSha: context.index.sourceSha,
    packageIndex: context.packageIndexReference,
    toolchainPolicy: context.toolchainPolicyReference,
    commands,
  };
  return putCanonical({
    store,
    namespace,
    value,
    mediaType: PRE_PROMOTION_VERIFIER_RUN_MEDIA_TYPE,
    label: `${category} verifier run`,
  });
};

export const storePrePromotionCategoryReceipt = async ({
  store,
  namespace,
  standardBinding,
  containmentBinding,
  category,
  proof,
}) => {
  assertStore(store, namespace, { write: true });
  if (!PRE_PROMOTION_EVIDENCE_CATEGORIES.includes(category)) {
    throw new Error("Pre-promotion evidence category is invalid");
  }
  const context = await resolvePrePromotionBindingContext({
    store,
    namespace,
    standardBinding,
    containmentBinding,
  });
  const receipt = commonReceiptFromContext({
    category,
    namespace,
    context,
    proof,
  });
  await validateCategoryProof({
    store,
    namespace,
    category,
    receipt,
    context,
    bindings: { standard: standardBinding, containment: containmentBinding },
  });
  return putCanonical({
    store,
    namespace,
    value: receipt,
    mediaType: PRE_PROMOTION_EVIDENCE_MEDIA_TYPES[category],
    label: `Pre-promotion ${category} receipt`,
  });
};

export const prePromotionVerifierCommandIds = (category) => {
  if (!Object.hasOwn(VERIFIER_COMMANDS, category)) {
    throw new Error("Pre-promotion verifier category is invalid");
  }
  return VERIFIER_COMMANDS[category].map(([id]) => id);
};

export const prePromotionVerifierCommands = (category) => {
  if (!Object.hasOwn(VERIFIER_COMMANDS, category)) {
    throw new Error("Pre-promotion verifier category is invalid");
  }
  return VERIFIER_COMMANDS[category].map(
    ([id, command, targetBuildOrdinal = null]) => ({
      id,
      command,
      targetBuildOrdinal,
    }),
  );
};
