import { computeRoleEntryGraphHash } from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import {
  OUTER_AGENT_GRAPH_URL,
  OUTER_AGENT_URL,
} from "../lib/outer-agent-contract.mjs";
import {
  ARTIFACT_BUILD_REQUIREMENTS_KIND,
  ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  CSP_POLICY_MEDIA_TYPE,
  PROVIDER_POLICY_MEDIA_TYPE,
  RELEASE_POLICY_MEDIA_TYPE,
  TOOLCHAIN_POLICY_MEDIA_TYPE,
} from "./artifactBuildAuthority.mjs";
import {
  prePromotionVerifierCommands,
  storePrePromotionBuildRunReceipt,
  storePrePromotionCategoryReceipt,
  storePrePromotionVerifierRunReceipt,
} from "./prePromotionEvidence.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
} from "./releaseWorkflowValidation.mjs";

const PACKAGE_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-package-index+json;version=1";
const MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";
const PROVIDER_EVIDENCE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.provider-deployment-evidence+json;version=1";
const ROUTE_PROBE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.immutable-route-probe+json;version=1";
const DEPLOYMENT_RECEIPT_MEDIA_TYPE =
  "application/vnd.vercel.prebuilt-deployment-receipt+json;version=1";

const putBytes = async (store, namespace, bytes, mediaType) => {
  const receipt = await store.putEvidence({ bytes, mediaType });
  const sha256 = sha256Bytes(bytes);
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length
  ) {
    throw new Error("Pre-promotion test fixture store receipt is invalid");
  }
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putJson = (store, namespace, value, mediaType) =>
  putBytes(store, namespace, canonicalJsonBytes(value), mediaType);

const reference = (sha256, kind) => ({
  uri: `artifact://sha256/${sha256}/${kind}`,
  sha256,
});

const sortedObject = (entries) =>
  Object.fromEntries(
    [...entries].sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );

const createManifest = ({
  sourceSha,
  role,
  dimensions,
  variantId,
  buildAuthority,
  targetGate,
  toolchainPolicyHash,
  providerPolicyHash,
  releasePolicyHash,
  providerConfigurationHash,
  dbCompatibility,
}) => {
  const chunkBytes = Buffer.from(`fixture-role:${role}`);
  const chunkHash = sha256Bytes(chunkBytes);
  const sharedOuterHash = sha256Bytes(Buffer.from("fixture-outer-agent"));
  const sharedOuterGraphHash = sha256Bytes(
    Buffer.from("fixture-outer-agent-graph"),
  );
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha,
    releaseRole: role,
    variantId,
    entryModule: "src/index.tsx",
    entryFile: "/assets/release-role.js",
    modules: [
      {
        id: "src/index.tsx",
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: "/assets/release-role.js",
        sha256: chunkHash,
        size: chunkBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: ["src/index.tsx"],
      },
    ],
  };
  return {
    schemaVersion: 1,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole: role,
    dimensions,
    buildAuthority,
    targetGate,
    buildPurpose: "production",
    promotable: true,
    buildInputClosureHash: sha256Json({ fixture: "build-input" }),
    lockfileSha256: sha256Json({ fixture: "lockfile" }),
    toolchainPolicyHash,
    publicBuildEnvHash: sha256Json({ schemaVersion: 1, values: {} }),
    providerConfigurationHash,
    providerPolicyHash,
    releasePolicyHash,
    requiredDbCompatibility: dbCompatibility,
    publicIdentityKind: "release-identity-v1",
    bootstrap: null,
    publicResponseHashes: sortedObject([
      ["/", sha256Bytes(Buffer.from(`fixture-index:${role}`))],
      [OUTER_AGENT_URL, sharedOuterHash],
      [OUTER_AGENT_GRAPH_URL, sharedOuterGraphHash],
    ]),
    roleEntryGraph,
    roleEntryGraphHash: computeRoleEntryGraphHash(roleEntryGraph),
    outputFiles: [
      {
        path: "static/assets/release-role.js",
        sha256: chunkHash,
        size: chunkBytes.length,
      },
    ],
  };
};

const routeReceipt = ({ path, deploymentUrl, bodySha256 }) => ({
  path,
  requestUrl: `${deploymentUrl}${path}`,
  responseUrl: `${deploymentUrl}${path}`,
  status: 200,
  bodySha256,
  byteLength: 1,
  etag: null,
  contentType: path === "/" ? "text/html" : "application/javascript",
  cacheControl: null,
  responseDate: "2026-08-06T00:00:00.000Z",
  securityHeaders: {
    "content-security-policy": null,
    "permissions-policy": null,
    "referrer-policy": null,
    "strict-transport-security": null,
    "x-content-type-options": null,
    "x-frame-options": null,
  },
});

export const createStoredPrePromotionFixture = async ({
  store,
  namespace,
  sourceSha,
  dbCompatibility,
  providerPolicy,
  releasePolicy,
  fixedTime = "2026-08-06T00:00:00.000Z",
}) => {
  const [
    releasePolicyReference,
    providerPolicyReference,
    toolchainPolicyReference,
    cspPolicyReference,
  ] = await Promise.all([
    putJson(store, namespace, releasePolicy, RELEASE_POLICY_MEDIA_TYPE),
    putJson(store, namespace, providerPolicy, PROVIDER_POLICY_MEDIA_TYPE),
    putJson(
      store,
      namespace,
      { schemaVersion: 1, node: "24.19.0", npm: "11.19.0" },
      TOOLCHAIN_POLICY_MEDIA_TYPE,
    ),
    putJson(
      store,
      namespace,
      { schemaVersion: 1, directives: {} },
      CSP_POLICY_MEDIA_TYPE,
    ),
  ]);
  const standardDimensions = { ...releasePolicy.initialStandard };
  const containmentDimensions = projectContainmentDimensions(
    releasePolicy,
    standardDimensions,
  );
  const buildAuthorityValue = {
    schemaVersion: 1,
    requirementsKind: ARTIFACT_BUILD_REQUIREMENTS_KIND,
    namespace,
    operationId: "build-prepromotion-fixture",
    purpose: "production",
    buildPurpose: "production",
    promotable: true,
    executorSourceSha: sourceSha,
    targetSourceSha: sourceSha,
    expectedState: { sequence: 1, eventHash: "e".repeat(64) },
    acceptedGate: null,
    targetGate: "P0-RELEASE",
    releasePolicy: releasePolicyReference,
    providerPolicy: providerPolicyReference,
    currentDbCompatibility: dbCompatibility,
    toolchainPolicy: toolchainPolicyReference,
    cspPolicy: cspPolicyReference,
    standardDimensions,
    containmentDimensions,
  };
  const buildAuthority = await putJson(
    store,
    namespace,
    buildAuthorityValue,
    ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  );
  const providerConfigurationHash = "6".repeat(64);
  const standardManifest = createManifest({
    sourceSha,
    role: "standard",
    dimensions: standardDimensions,
    variantId: computeVariantId(releasePolicy, standardDimensions),
    buildAuthority,
    targetGate: "P0-RELEASE",
    toolchainPolicyHash: toolchainPolicyReference.sha256,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    providerConfigurationHash,
    dbCompatibility,
  });
  const containmentManifest = createManifest({
    sourceSha,
    role: "containment",
    dimensions: containmentDimensions,
    variantId: computeVariantId(releasePolicy, containmentDimensions),
    buildAuthority,
    targetGate: "P0-RELEASE",
    toolchainPolicyHash: toolchainPolicyReference.sha256,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    providerConfigurationHash,
    dbCompatibility,
  });
  const [standardManifestReference, containmentManifestReference] =
    await Promise.all([
      putJson(store, namespace, standardManifest, MANIFEST_MEDIA_TYPE),
      putJson(store, namespace, containmentManifest, MANIFEST_MEDIA_TYPE),
    ]);
  const standardArchiveBytes = Buffer.from("fixture-standard-archive");
  const containmentArchiveBytes = Buffer.from("fixture-containment-archive");
  const [standardArchiveReference, containmentArchiveReference] =
    await Promise.all([
      putBytes(
        store,
        namespace,
        standardArchiveBytes,
        ARTIFACT_ARCHIVE_MEDIA_TYPE,
      ),
      putBytes(
        store,
        namespace,
        containmentArchiveBytes,
        ARTIFACT_ARCHIVE_MEDIA_TYPE,
      ),
    ]);
  const packageIndex = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha,
    buildId: sourceSha,
    buildAuthority,
    targetGate: "P0-RELEASE",
    buildPurpose: "production",
    promotable: true,
    toolchainPolicyHash: toolchainPolicyReference.sha256,
    providerConfigurationHash,
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility: dbCompatibility,
    artifacts: [
      {
        releaseRole: "standard",
        variantId: standardManifest.variantId,
        manifest: reference(standardManifestReference.sha256, "artifact.json"),
        archive: reference(standardArchiveReference.sha256, "artifact.zip"),
      },
      {
        releaseRole: "containment",
        variantId: containmentManifest.variantId,
        manifest: reference(
          containmentManifestReference.sha256,
          "artifact.json",
        ),
        archive: reference(containmentArchiveReference.sha256, "artifact.zip"),
      },
    ],
  };
  const packageIndexReference = await putJson(
    store,
    namespace,
    packageIndex,
    PACKAGE_INDEX_MEDIA_TYPE,
  );
  const makeBinding = async ({
    role,
    manifest,
    manifestReference,
    archiveReference,
  }) => {
    const bindingId = `fixture-${role}-binding`;
    const deploymentUrl = `https://fixture-${role}.example.test`;
    const deploymentReceipt = await putJson(
      store,
      namespace,
      { schemaVersion: 1, receiptKind: "fixture-prebuilt-deployment/v1", role },
      DEPLOYMENT_RECEIPT_MEDIA_TYPE,
    );
    const routeProbeValue = {
      schemaVersion: 1,
      evidenceKind: "immutable-deployment-route-probe/v1",
      namespace,
      providerProjectId: providerPolicy.expectedProjectId,
      providerDeploymentId: `deployment-${role}`,
      deploymentUrl,
      observedAt: fixedTime,
      deploymentReceipt,
      cspPolicy: cspPolicyReference,
      runtimeHtmlIdentity: { sourceSha, buildId: sourceSha },
      routes: Object.entries(manifest.publicResponseHashes)
        .map(([path, bodySha256]) =>
          routeReceipt({ path, deploymentUrl, bodySha256 }),
        )
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
        ),
    };
    const routeProbeReference = await putJson(
      store,
      namespace,
      routeProbeValue,
      ROUTE_PROBE_MEDIA_TYPE,
    );
    const providerEvidenceValue = {
      schemaVersion: 1,
      providerProjectId: providerPolicy.expectedProjectId,
      providerDeploymentId: `deployment-${role}`,
      deploymentUrl,
      sourceSha,
      variantId: manifest.variantId,
      releaseRole: role,
      artifactManifestHash: manifestReference.sha256,
      packageIndexHash: packageIndexReference.sha256,
      providerConfigurationHash,
      providerPolicyHash: providerPolicyReference.sha256,
      releasePolicyHash: releasePolicyReference.sha256,
      requiredDbCompatibility: dbCompatibility,
      publicIdentity: { identityKind: "release-identity-v1" },
      routeProbeEvidenceHash: routeProbeReference.sha256,
      environmentPresenceEvidenceHash: "8".repeat(64),
    };
    const providerEvidence = await putJson(
      store,
      namespace,
      providerEvidenceValue,
      PROVIDER_EVIDENCE_MEDIA_TYPE,
    );
    const availabilityValue = {
      schemaVersion: 1,
      evidenceKind: "artifact-archive-availability/v1",
      availability: "available",
      namespace,
      bindingId,
      sourceSha,
      variantId: manifest.variantId,
      releaseRole: role,
      artifactManifest: manifestReference,
      artifactArchive: {
        ...archiveReference,
        mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
        byteLength:
          role === "standard"
            ? standardArchiveBytes.length
            : containmentArchiveBytes.length,
        committedAt: fixedTime,
      },
    };
    const artifactArchiveAvailability = await putJson(
      store,
      namespace,
      availabilityValue,
      ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
    );
    return {
      binding: {
        bindingId,
        sourceSha,
        buildId: sourceSha,
        variantId: manifest.variantId,
        releaseRole: role,
        publicIdentityKind: "release-identity-v1",
        providerProjectId: providerPolicy.expectedProjectId,
        providerDeploymentId: `deployment-${role}`,
        deploymentUrl,
        artifactArchive: archiveReference,
        artifactArchiveAvailability,
        packageIndex: packageIndexReference,
        artifactManifest: manifestReference,
        providerEvidence,
        releasePolicy: releasePolicyReference,
        providerPolicy: providerPolicyReference,
        providerConfigurationHash,
        requiredDbCompatibility: dbCompatibility,
      },
      routeProbeReference,
    };
  };
  const [standardResult, containmentResult] = await Promise.all([
    makeBinding({
      role: "standard",
      manifest: standardManifest,
      manifestReference: standardManifestReference,
      archiveReference: standardArchiveReference,
    }),
    makeBinding({
      role: "containment",
      manifest: containmentManifest,
      manifestReference: containmentManifestReference,
      archiveReference: containmentArchiveReference,
    }),
  ]);
  const standard = standardResult.binding;
  const containment = containmentResult.binding;
  const oidcReference = (workflowRunId, runAttempt) =>
    putJson(
      store,
      namespace,
      {
        schemaVersion: 1,
        kind: "github-actions-oidc-verification/v1",
        issuer: "https://token.actions.githubusercontent.com",
        audience: "urn:test:release-state",
        subject: "repo:test/repository:environment:foundation-release-state",
        tokenSha256: "9".repeat(64),
        signingKey: {
          kid: "fixture",
          jwkThumbprintSha256: "7".repeat(64),
        },
        claims: {
          repository: "test/repository",
          workflowRef:
            "test/repository/.github/workflows/release.yml@refs/heads/main",
          workflowSha: sourceSha,
          environment: "foundation-release-state",
          runId: workflowRunId,
          runAttempt: String(runAttempt),
          sourceSha,
          eventName: "workflow_dispatch",
          ref: "refs/heads/main",
          refProtected: true,
          jti: `fixture-${workflowRunId}-${runAttempt}`,
          issuedAt: fixedTime,
          notBefore: fixedTime,
          expiresAt: "2026-08-06T00:10:00.000Z",
        },
        verifiedAt: fixedTime,
      },
      "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1",
    );
  const buildRuns = [];
  const issuerReceipts = { builds: [], verifiers: {} };
  for (const [buildOrdinal, workflowRunId, runAttempt] of [
    [1, "101", 1],
    [2, "101", 1],
  ]) {
    const issuerReceiptReference = await oidcReference(
      workflowRunId,
      runAttempt,
    );
    issuerReceipts.builds.push(issuerReceiptReference);
    buildRuns.push(
      await storePrePromotionBuildRunReceipt({
        store,
        namespace,
        standardBinding: standard,
        containmentBinding: containment,
        workflowRunId,
        runAttempt,
        buildOrdinal,
        issuerReceiptReference,
        stdoutBytes: Buffer.from(`PASS artifact build ${workflowRunId}\n`),
        stderrBytes: Buffer.alloc(0),
      }),
    );
  }
  const verifierRuns = {};
  for (const category of ["qa", "resource", "security"]) {
    const workflowRunId = "101";
    const issuerReceiptReference = await oidcReference(workflowRunId, 1);
    issuerReceipts.verifiers[category] = issuerReceiptReference;
    verifierRuns[category] = await storePrePromotionVerifierRunReceipt({
      store,
      namespace,
      standardBinding: standard,
      containmentBinding: containment,
      category,
      workflowRunId,
      runAttempt: 1,
      issuerReceiptReference,
      executions: prePromotionVerifierCommands(category).map((command) => ({
        id: command.id,
        targetBuildOrdinal: command.targetBuildOrdinal,
        exitCode: 0,
        stdoutBytes: Buffer.from(`PASS ${command.id}\n`),
        stderrBytes: Buffer.alloc(0),
      })),
    });
  }
  const namedEvidence = {
    qa: await storePrePromotionCategoryReceipt({
      store,
      namespace,
      standardBinding: standard,
      containmentBinding: containment,
      category: "qa",
      proof: { verifierRun: verifierRuns.qa },
    }),
    reproducibility: await storePrePromotionCategoryReceipt({
      store,
      namespace,
      standardBinding: standard,
      containmentBinding: containment,
      category: "reproducibility",
      proof: { firstBuildRun: buildRuns[0], secondBuildRun: buildRuns[1] },
    }),
    resource: await storePrePromotionCategoryReceipt({
      store,
      namespace,
      standardBinding: standard,
      containmentBinding: containment,
      category: "resource",
      proof: { verifierRun: verifierRuns.resource },
    }),
    route: await storePrePromotionCategoryReceipt({
      store,
      namespace,
      standardBinding: standard,
      containmentBinding: containment,
      category: "route",
      proof: {
        standardRouteProbe: standardResult.routeProbeReference,
        containmentRouteProbe: containmentResult.routeProbeReference,
      },
    }),
    security: await storePrePromotionCategoryReceipt({
      store,
      namespace,
      standardBinding: standard,
      containmentBinding: containment,
      category: "security",
      proof: { verifierRun: verifierRuns.security },
    }),
  };
  return {
    buildAuthority,
    buildRuns,
    containment,
    issuerReceipts,
    namedEvidence,
    packageIndex,
    packageIndexReference,
    providerPolicyReference,
    releasePolicyReference,
    routeProbeReferences: {
      standard: standardResult.routeProbeReference,
      containment: containmentResult.routeProbeReference,
    },
    standard,
    toolchainPolicyReference,
    verifierRuns,
  };
};
