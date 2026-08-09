import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertArtifactManifest,
  assertReleasePackageIndex,
} from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  RELEASE_DIMENSION_KEYS,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import { extractPrebuiltArchive } from "../provider/prebuiltDeployment.mjs";
import {
  deriveRollbackInventory,
  resolveAcceptedStandardAuthority,
} from "./lifecycleExecution.mjs";
import { assertPolicyCompatibilityEntries } from "./policyCompatibility.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SOURCE_SHA_PATTERN,
  assertArtifactArchiveAvailable,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  assertExactKeys,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  sortAndDedupeReferences,
} from "./releaseWorkflowValidation.mjs";

export const P8_FLOOR_ACTIVATION_CLOSURE_KIND =
  "p8-floor-activation-closure/v1";
export const P8_FLOOR_ACTIVATION_CLOSURE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.p8-floor-activation-closure+json;version=1";
export const P8_FLOOR_ACTIVATION_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.p8-floor-activation-receipt+json;version=1";

const PACKAGE_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-package-index+json;version=1";
const ARTIFACT_MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";
const P8_GATE = "P8-CLEAN";
const RECEIPT_KINDS = Object.freeze({
  acceptedPackage: "p8-accepted-package/v1",
  securityHeaders: "p8-security-headers/v1",
  monotonicity: "p8-minimum-floor-monotonicity/v1",
  rollbackEligibility: "p8-rollback-eligibility/v1",
  liveState: "p8-live-release-state/v1",
});
const RECEIPT_FIELDS = Object.freeze(Object.keys(RECEIPT_KINDS));
const STANDARD_FLOOR_KEYS = RELEASE_DIMENSION_KEYS.filter(
  (key) => key !== "releaseRole",
);

const evidenceReference = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const assertIdentity = ({
  store,
  namespace,
  operationId,
  executorSourceSha,
}) => {
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    store.namespace !== namespace ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !SOURCE_SHA_PATTERN.test(executorSourceSha)
  ) {
    throw new Error("P8 floor closure identity or store is invalid");
  }
};

const readCanonicalEvidence = async ({
  store,
  namespace,
  reference,
  expectedMediaType,
  label,
}) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  if (stored.mediaType !== expectedMediaType) {
    throw new Error(`${label} media type is invalid`);
  }
  return {
    bytes: stored.bytes,
    value: parseCanonicalJsonBytes(stored.bytes, label),
  };
};

const putCanonicalEvidence = async ({
  store,
  namespace,
  value,
  mediaType,
  label,
}) => {
  const bytes = canonicalJsonBytes(value);
  const sha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.byteLength !== bytes.length ||
    receipt.mediaType !== mediaType ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256 });
  if (!stored?.bytes?.equals(bytes) || stored.mediaType !== mediaType) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return { bytes, reference: evidenceReference(namespace, sha256) };
};

const routeMatches = (route, pathname) => {
  if (typeof route?.src !== "string") return false;
  try {
    return new RegExp(route.src).test(pathname);
  } catch {
    throw new Error("P8 artifact config contains an invalid route regex");
  }
};

const collectP8HeadersForPath = ({ routes, filesystemIndex, pathname }) => {
  const headers = new Map();
  const headerRoutes = [];
  for (const [routeIndex, route] of routes
    .slice(0, filesystemIndex)
    .entries()) {
    if (!routeMatches(route, pathname) || route?.headers === undefined)
      continue;
    if (
      route.continue !== true ||
      route.headers === null ||
      typeof route.headers !== "object" ||
      Array.isArray(route.headers)
    ) {
      throw new Error("P8 artifact security-header route is invalid");
    }
    headerRoutes.push(routeIndex);
    for (const [name, value] of Object.entries(route.headers)) {
      const normalizedName = name.toLowerCase();
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        headers.has(normalizedName)
      ) {
        throw new Error("P8 artifact security headers are ambiguous");
      }
      headers.set(normalizedName, value);
    }
  }
  if (
    headers.has("content-security-policy-report-only") ||
    !headers.has("content-security-policy")
  ) {
    throw new Error(
      `P8 artifact does not carry one enforced CSP header for ${pathname}`,
    );
  }
  return {
    headerRoutes,
    headerValue: headers.get("content-security-policy"),
  };
};

const deriveCspHeaderProjection = ({ config, configBytes }) => {
  if (
    config?.version !== 3 ||
    !Array.isArray(config.routes) ||
    config.routes.length === 0
  ) {
    throw new Error(
      "P8 artifact config is not a Vercel Build Output v3 config",
    );
  }
  const filesystemIndexes = config.routes
    .map((route, index) => (route?.handle === "filesystem" ? index : -1))
    .filter((index) => index >= 0);
  if (filesystemIndexes.length !== 1) {
    throw new Error("P8 artifact config has no unique filesystem boundary");
  }
  const [filesystemIndex] = filesystemIndexes;
  const verifiedPaths = [
    "/",
    "/api/csp-report",
    "/release-identity.json",
    "/sw.js",
  ];
  const observations = verifiedPaths.map((pathname) => ({
    pathname,
    ...collectP8HeadersForPath({
      routes: config.routes,
      filesystemIndex,
      pathname,
    }),
  }));
  const headerValues = new Set(
    observations.map(({ headerValue }) => headerValue),
  );
  if (headerValues.size !== 1) {
    throw new Error("P8 artifact enforced CSP differs across public routes");
  }
  const [headerValue] = headerValues;
  const directives = headerValue
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => directive.split(/\s+/u));
  const styleSrcAttr = directives.filter(
    ([directive]) => directive === "style-src-attr",
  );
  if (
    styleSrcAttr.length !== 1 ||
    styleSrcAttr[0].length !== 2 ||
    styleSrcAttr[0][1] !== "'none'"
  ) {
    throw new Error("P8 artifact CSP does not enforce style-src-attr 'none'");
  }
  return {
    configSha256: sha256Bytes(configBytes),
    configByteLength: configBytes.length,
    filesystemRouteIndex: filesystemIndex,
    verifiedPaths,
    securityHeaderRouteIndexesByPath: Object.fromEntries(
      observations.map(({ pathname, headerRoutes }) => [
        pathname,
        headerRoutes,
      ]),
    ),
    headerName: "Content-Security-Policy",
    headerValue,
    headerValueSha256: sha256Bytes(Buffer.from(headerValue, "utf8")),
    styleSrcAttr: ["'none'"],
  };
};

export const deriveP8ArchivedHeader = async ({ archiveBytes, manifest }) => {
  const configFiles = manifest.outputFiles.filter(
    ({ path: filePath }) => filePath === "config.json",
  );
  if (configFiles.length !== 1) {
    throw new Error("P8 artifact manifest has no unique config.json");
  }
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-p8-floor-"),
  );
  try {
    const archivePath = path.join(temporaryRoot, "artifact.zip");
    const outputRoot = path.join(temporaryRoot, "output");
    await mkdir(outputRoot, { recursive: false });
    await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
    await extractPrebuiltArchive({
      archivePath,
      destination: outputRoot,
      expectedFiles: manifest.outputFiles,
    });
    const configBytes = await readFile(path.join(outputRoot, "config.json"));
    const [configFile] = configFiles;
    if (
      configBytes.length !== configFile.size ||
      sha256Bytes(configBytes) !== configFile.sha256
    ) {
      throw new Error("P8 artifact config differs from its manifest");
    }
    const config = parseCanonicalJsonBytes(
      configBytes,
      "P8 artifact config.json",
    );
    return deriveCspHeaderProjection({ config, configBytes });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const assertP8Transition = ({ snapshot, transition, releasePolicy }) => {
  if (
    snapshot.acceptedGate !== P8_GATE ||
    transition?.activationGate !== P8_GATE ||
    transition.behaviorDimensionChange !== null ||
    !sameCanonicalValue(transition.minimumSafetyFloorChange, {
      styleSrcAttr: "none",
    }) ||
    !sameCanonicalValue(
      transition.minimumSafetyFloors,
      releasePolicy.minimumSafetyFloors,
    ) ||
    Object.hasOwn(snapshot.minimumSafetyFloors, "styleSrcAttr") ||
    !sameCanonicalValue(
      { ...snapshot.minimumSafetyFloors, styleSrcAttr: "none" },
      transition.minimumSafetyFloors,
    )
  ) {
    throw new Error("P8 floor closure is not the exact pre-floor transition");
  }
};

const assertLiveP8State = ({ snapshot, releasePolicyReference }) => {
  if (
    snapshot.pendingOperation !== null ||
    snapshot.pendingAcceptance !== null ||
    snapshot.containmentIncident !== null ||
    snapshot.standardRecovery !== null ||
    snapshot.legacyObservedProduction !== null ||
    snapshot.acceptedStandard === null ||
    snapshot.containmentCompanion === null ||
    !sameCanonicalValue(snapshot.activeProduction, snapshot.acceptedStandard) ||
    !sameCanonicalValue(snapshot.activeReleasePolicy, releasePolicyReference) ||
    !sameCanonicalValue(
      snapshot.acceptedStandard.releasePolicy,
      releasePolicyReference,
    ) ||
    !sameCanonicalValue(
      snapshot.containmentCompanion.releasePolicy,
      releasePolicyReference,
    )
  ) {
    throw new Error("P8 floor closure requires an idle active P8 package pair");
  }
};

const standardFloorsFromDimensions = (dimensions) =>
  Object.fromEntries(STANDARD_FLOOR_KEYS.map((key) => [key, dimensions[key]]));

const assertManifestBinding = ({
  manifest,
  binding,
  packageIndex,
  packageArtifact,
  releasePolicyReference,
}) => {
  if (
    manifest.targetGate !== P8_GATE ||
    manifest.buildPurpose !== "production" ||
    manifest.promotable !== true ||
    manifest.sourceSha !== binding.sourceSha ||
    manifest.buildId !== binding.buildId ||
    manifest.variantId !== binding.variantId ||
    manifest.releaseRole !== binding.releaseRole ||
    manifest.publicIdentityKind !== binding.publicIdentityKind ||
    manifest.providerConfigurationHash !== binding.providerConfigurationHash ||
    manifest.providerPolicyHash !== binding.providerPolicy.sha256 ||
    manifest.releasePolicyHash !== releasePolicyReference.sha256 ||
    !sameCanonicalValue(
      manifest.requiredDbCompatibility,
      binding.requiredDbCompatibility,
    ) ||
    packageArtifact.releaseRole !== binding.releaseRole ||
    packageArtifact.variantId !== binding.variantId ||
    packageArtifact.manifest.sha256 !== binding.artifactManifest.sha256 ||
    packageArtifact.archive.sha256 !== binding.artifactArchive.sha256 ||
    packageIndex.sourceSha !== binding.sourceSha ||
    packageIndex.buildId !== binding.buildId
  ) {
    throw new Error(`P8 ${binding.releaseRole} package binding differs`);
  }
};

const loadP8PackagePair = async ({
  store,
  namespace,
  snapshot,
  releasePolicy,
  releasePolicyReference,
  deriveArchivedHeaderImpl,
}) => {
  const standard = snapshot.acceptedStandard;
  const companion = snapshot.containmentCompanion;
  assertDeploymentBinding(standard, {
    namespace,
    expectedRole: "standard",
    label: "P8 accepted standard",
  });
  assertDeploymentBinding(companion, {
    namespace,
    expectedRole: "containment",
    label: "P8 containment companion",
  });
  if (
    standard.sourceSha !== companion.sourceSha ||
    standard.providerProjectId !== companion.providerProjectId ||
    !sameCanonicalValue(standard.packageIndex, companion.packageIndex) ||
    !sameCanonicalValue(
      standard.requiredDbCompatibility,
      companion.requiredDbCompatibility,
    )
  ) {
    throw new Error("P8 accepted standard and companion are not one package");
  }
  const [indexObject, standardManifestObject, companionManifestObject] =
    await Promise.all([
      readCanonicalEvidence({
        store,
        namespace,
        reference: standard.packageIndex,
        expectedMediaType: PACKAGE_INDEX_MEDIA_TYPE,
        label: "P8 release package index",
      }),
      readCanonicalEvidence({
        store,
        namespace,
        reference: standard.artifactManifest,
        expectedMediaType: ARTIFACT_MANIFEST_MEDIA_TYPE,
        label: "P8 accepted standard manifest",
      }),
      readCanonicalEvidence({
        store,
        namespace,
        reference: companion.artifactManifest,
        expectedMediaType: ARTIFACT_MANIFEST_MEDIA_TYPE,
        label: "P8 containment companion manifest",
      }),
    ]);
  const packageIndex = assertReleasePackageIndex(indexObject.value);
  if (
    packageIndex.packageKind !== "source-hardened-pair" ||
    packageIndex.targetGate !== P8_GATE ||
    packageIndex.buildPurpose !== "production" ||
    packageIndex.promotable !== true ||
    packageIndex.sourceSha !== standard.sourceSha ||
    packageIndex.providerPolicyHash !== standard.providerPolicy.sha256 ||
    packageIndex.releasePolicyHash !== releasePolicyReference.sha256 ||
    packageIndex.providerConfigurationHash !==
      standard.providerConfigurationHash ||
    !sameCanonicalValue(
      packageIndex.requiredDbCompatibility,
      standard.requiredDbCompatibility,
    )
  ) {
    throw new Error("P8 release package index binding is invalid");
  }
  const standardManifest = assertArtifactManifest(
    standardManifestObject.value,
    releasePolicy,
  );
  const companionManifest = assertArtifactManifest(
    companionManifestObject.value,
    releasePolicy,
  );
  const standardArtifacts = packageIndex.artifacts.filter(
    ({ releaseRole }) => releaseRole === "standard",
  );
  const companionArtifacts = packageIndex.artifacts.filter(
    ({ releaseRole }) => releaseRole === "containment",
  );
  if (standardArtifacts.length !== 1 || companionArtifacts.length !== 1) {
    throw new Error("P8 release package roles are ambiguous");
  }
  assertManifestBinding({
    manifest: standardManifest,
    binding: standard,
    packageIndex,
    packageArtifact: standardArtifacts[0],
    releasePolicyReference,
  });
  assertManifestBinding({
    manifest: companionManifest,
    binding: companion,
    packageIndex,
    packageArtifact: companionArtifacts[0],
    releasePolicyReference,
  });
  if (
    !sameCanonicalValue(
      standardManifest.dimensions,
      releasePolicy.targetStandard,
    ) ||
    !sameCanonicalValue(
      companionManifest.dimensions,
      projectContainmentDimensions(releasePolicy, standardManifest.dimensions),
    ) ||
    !sameCanonicalValue(
      standardFloorsFromDimensions(standardManifest.dimensions),
      snapshot.acceptedStandardFloors,
    )
  ) {
    throw new Error("P8 artifact dimensions differ from the accepted floor");
  }
  const [standardArchive, companionArchive] = await Promise.all([
    assertArtifactArchiveAvailable({
      store,
      namespace,
      binding: standard,
      label: "P8 accepted standard",
    }),
    assertArtifactArchiveAvailable({
      store,
      namespace,
      binding: companion,
      label: "P8 containment companion",
    }),
  ]);
  const [standardHeader, companionHeader] = await Promise.all([
    deriveArchivedHeaderImpl({
      archiveBytes: standardArchive.archive.bytes,
      manifest: standardManifest,
    }),
    deriveArchivedHeaderImpl({
      archiveBytes: companionArchive.archive.bytes,
      manifest: companionManifest,
    }),
  ]);
  return {
    packageIndex,
    standard,
    companion,
    standardManifest,
    companionManifest,
    standardHeader,
    companionHeader,
  };
};

const assertAcceptedInventoryEntry = ({ inventory, binding }) => {
  const entries = inventory.filter(({ binding: candidate }) =>
    sameCanonicalValue(candidate, binding),
  );
  if (
    entries.length !== 1 ||
    entries[0].eligibility !== "eligible" ||
    !sameCanonicalValue(entries[0].eligibleActions, [
      "package-redeploy",
      "rollback",
    ]) ||
    !Array.isArray(entries[0].reasonCodes) ||
    entries[0].reasonCodes.length !== 0
  ) {
    throw new Error(
      "P8 accepted standard is not rollback eligible after floor",
    );
  }
};

export const deriveP8FloorActivationAuthority = async (
  {
    store,
    namespace,
    operationId,
    executorSourceSha,
    current,
    releasePolicy,
    releasePolicyReference,
    transition,
  },
  {
    deriveArchivedHeaderImpl = deriveP8ArchivedHeader,
    deriveRollbackInventoryImpl = deriveRollbackInventory,
    resolveAcceptedStandardAuthorityImpl = resolveAcceptedStandardAuthority,
  } = {},
) => {
  assertIdentity({ store, namespace, operationId, executorSourceSha });
  const snapshot = current?.snapshot;
  if (!snapshot || !Array.isArray(current.records)) {
    throw new Error("P8 floor closure requires replayed live Release State");
  }
  assertP8Transition({ snapshot, transition, releasePolicy });
  assertLiveP8State({ snapshot, releasePolicyReference });
  if (
    releasePolicy.activationStatus !== "active" ||
    !Array.isArray(releasePolicy.activationBlockers) ||
    releasePolicy.activationBlockers.length !== 0 ||
    !sameCanonicalValue(
      releasePolicy.acceptedStandardFloors,
      snapshot.acceptedStandardFloors,
    )
  ) {
    throw new Error("P8 floor closure active release policy is invalid");
  }
  if (
    !sameCanonicalValue(
      snapshot.activePolicyCompatibility,
      releasePolicy.compatiblePredecessorPolicies,
    )
  ) {
    throw new Error(
      "P8 live predecessor compatibility differs from the active policy",
    );
  }
  assertPolicyCompatibilityEntries(
    releasePolicy.compatiblePredecessorPolicies,
    {
      namespace,
      minimumSafetyFloors: snapshot.minimumSafetyFloors,
      currentDbCompatibility: snapshot.currentDbCompatibility,
    },
  );
  const activePolicyCompatibility = [];
  const [packagePair, acceptedAuthority] = await Promise.all([
    loadP8PackagePair({
      store,
      namespace,
      snapshot,
      releasePolicy,
      releasePolicyReference,
      deriveArchivedHeaderImpl,
    }),
    Promise.resolve(
      resolveAcceptedStandardAuthorityImpl({
        current,
        binding: snapshot.acceptedStandard,
      }),
    ),
  ]);
  if (
    acceptedAuthority.acceptedGate !== P8_GATE ||
    !sameCanonicalValue(
      acceptedAuthority.acceptedEvent,
      snapshot.acceptedStandardEvent,
    ) ||
    !sameCanonicalValue(
      acceptedAuthority.acceptedStandardFloors,
      snapshot.acceptedStandardFloors,
    )
  ) {
    throw new Error("P8 accepted event does not authorize the live package");
  }
  const nextSnapshot = {
    ...snapshot,
    activePolicyCompatibility,
    minimumSafetyFloors: transition.minimumSafetyFloors,
  };
  const rollbackInventory = await deriveRollbackInventoryImpl({
    store,
    current: { ...current, snapshot: nextSnapshot },
    releasePolicy,
    minimumAcceptedGate: P8_GATE,
    minimumAcceptedFloors: snapshot.acceptedStandardFloors,
  });
  assertAcceptedInventoryEntry({
    inventory: rollbackInventory,
    binding: snapshot.acceptedStandard,
  });
  const receiptResults = {
    acceptedPackage: {
      acceptedEvent: acceptedAuthority.acceptedEvent,
      packageIndex: structuredClone(snapshot.acceptedStandard.packageIndex),
      packageIndexSha256: sha256Json(packagePair.packageIndex),
      sourceSha: packagePair.standard.sourceSha,
      releasePolicy: structuredClone(releasePolicyReference),
      standard: {
        bindingId: packagePair.standard.bindingId,
        variantId: packagePair.standard.variantId,
        artifactManifest: structuredClone(
          packagePair.standard.artifactManifest,
        ),
        artifactArchive: structuredClone(packagePair.standard.artifactArchive),
        artifactArchiveAvailability: structuredClone(
          packagePair.standard.artifactArchiveAvailability,
        ),
      },
      companion: {
        bindingId: packagePair.companion.bindingId,
        variantId: packagePair.companion.variantId,
        artifactManifest: structuredClone(
          packagePair.companion.artifactManifest,
        ),
        artifactArchive: structuredClone(packagePair.companion.artifactArchive),
        artifactArchiveAvailability: structuredClone(
          packagePair.companion.artifactArchiveAvailability,
        ),
      },
    },
    securityHeaders: {
      standard: packagePair.standardHeader,
      companion: packagePair.companionHeader,
    },
    monotonicity: {
      behaviorDimensionChange: null,
      minimumSafetyFloorChange: transition.minimumSafetyFloorChange,
      minimumSafetyFloors: transition.minimumSafetyFloors,
    },
    rollbackEligibility: {
      activePolicyCompatibility,
      rollbackInventory,
      rollbackInventorySha256: sha256Json(rollbackInventory),
    },
    liveState: {
      expectedState: structuredClone(current.head),
      acceptedGate: snapshot.acceptedGate,
      activeProductionBindingId: snapshot.activeProduction.bindingId,
      acceptedStandardBindingId: snapshot.acceptedStandard.bindingId,
      containmentCompanionBindingId: snapshot.containmentCompanion.bindingId,
      pendingOperation: null,
      pendingAcceptance: null,
      containmentIncident: null,
      standardRecovery: null,
      legacyObservedProduction: null,
    },
  };
  return {
    receiptResults,
    targetSourceSha: packagePair.standard.sourceSha,
    activePolicyCompatibility,
    rollbackInventory,
  };
};

const receiptCommon = ({
  namespace,
  operationId,
  executorSourceSha,
  releasePolicyReference,
}) => ({
  schemaVersion: 1,
  namespace,
  operationId,
  executorSourceSha,
  activationGate: P8_GATE,
  previousReleasePolicy: structuredClone(releasePolicyReference),
  proposedReleasePolicy: structuredClone(releasePolicyReference),
  activeReleasePolicy: structuredClone(releasePolicyReference),
});

export const validateP8FloorActivationClosure = async (
  {
    store,
    namespace,
    operationId,
    executorSourceSha,
    current,
    releasePolicy,
    releasePolicyReference,
    transition,
    closureBundleReference,
    nowMilliseconds,
  },
  dependencies = {},
) => {
  assertIdentity({ store, namespace, operationId, executorSourceSha });
  const bundleObject = await readCanonicalEvidence({
    store,
    namespace,
    reference: closureBundleReference,
    expectedMediaType: P8_FLOOR_ACTIVATION_CLOSURE_MEDIA_TYPE,
    label: "P8 floor activation closure",
  });
  const bundle = bundleObject.value;
  assertExactKeys(
    bundle,
    [
      "activationGate",
      "activeReleasePolicy",
      "bundleKind",
      "executorSourceSha",
      "namespace",
      "operationId",
      "previousReleasePolicy",
      "proposedReleasePolicy",
      "receipts",
      "schemaVersion",
    ],
    "P8 floor activation closure",
  );
  assertExactKeys(bundle.receipts, RECEIPT_FIELDS, "P8 floor receipts");
  if (
    bundle.schemaVersion !== 1 ||
    bundle.bundleKind !== P8_FLOOR_ACTIVATION_CLOSURE_KIND ||
    bundle.namespace !== namespace ||
    bundle.operationId !== operationId ||
    bundle.executorSourceSha !== executorSourceSha ||
    bundle.activationGate !== P8_GATE ||
    !sameCanonicalValue(bundle.previousReleasePolicy, releasePolicyReference) ||
    !sameCanonicalValue(bundle.proposedReleasePolicy, releasePolicyReference) ||
    !sameCanonicalValue(bundle.activeReleasePolicy, releasePolicyReference)
  ) {
    throw new Error("P8 floor activation closure identity is invalid");
  }
  const derived = await deriveP8FloorActivationAuthority(
    {
      store,
      namespace,
      operationId,
      executorSourceSha,
      current,
      releasePolicy,
      releasePolicyReference,
      transition,
      nowMilliseconds,
    },
    dependencies,
  );
  const common = receiptCommon({
    namespace,
    operationId,
    executorSourceSha,
    releasePolicyReference,
  });
  const references = [];
  for (const field of RECEIPT_FIELDS) {
    const receiptObject = await readCanonicalEvidence({
      store,
      namespace,
      reference: bundle.receipts[field],
      expectedMediaType: P8_FLOOR_ACTIVATION_RECEIPT_MEDIA_TYPE,
      label: `P8 floor ${field} receipt`,
    });
    const expectedReceipt = {
      ...common,
      receiptKind: RECEIPT_KINDS[field],
      result: derived.receiptResults[field],
    };
    if (!sameCanonicalValue(receiptObject.value, expectedReceipt)) {
      throw new Error(`P8 floor ${field} receipt differs from live authority`);
    }
    references.push(structuredClone(bundle.receipts[field]));
  }
  return {
    references: sortAndDedupeReferences(references, namespace),
    targetSourceSha: derived.targetSourceSha,
    rollbackInventory: derived.rollbackInventory,
    activePolicyCompatibility: derived.activePolicyCompatibility,
  };
};

export const buildP8FloorActivationClosure = async (
  options,
  dependencies = {},
) => {
  const {
    store,
    namespace,
    operationId,
    executorSourceSha,
    current,
    releasePolicy,
    releasePolicyReference,
    transition,
    nowMilliseconds,
  } = options;
  const derived = await deriveP8FloorActivationAuthority(options, dependencies);
  const common = receiptCommon({
    namespace,
    operationId,
    executorSourceSha,
    releasePolicyReference,
  });
  const receipts = {};
  for (const field of RECEIPT_FIELDS) {
    receipts[field] = (
      await putCanonicalEvidence({
        store,
        namespace,
        value: {
          ...common,
          receiptKind: RECEIPT_KINDS[field],
          result: derived.receiptResults[field],
        },
        mediaType: P8_FLOOR_ACTIVATION_RECEIPT_MEDIA_TYPE,
        label: `P8 floor ${field} receipt`,
      })
    ).reference;
  }
  const bundle = {
    schemaVersion: 1,
    bundleKind: P8_FLOOR_ACTIVATION_CLOSURE_KIND,
    namespace,
    operationId,
    executorSourceSha,
    activationGate: P8_GATE,
    previousReleasePolicy: structuredClone(releasePolicyReference),
    proposedReleasePolicy: structuredClone(releasePolicyReference),
    activeReleasePolicy: structuredClone(releasePolicyReference),
    receipts,
  };
  const stored = await putCanonicalEvidence({
    store,
    namespace,
    value: bundle,
    mediaType: P8_FLOOR_ACTIVATION_CLOSURE_MEDIA_TYPE,
    label: "P8 floor activation closure",
  });
  await validateP8FloorActivationClosure(
    {
      store,
      namespace,
      operationId,
      executorSourceSha,
      current,
      releasePolicy,
      releasePolicyReference,
      transition,
      closureBundleReference: stored.reference,
      nowMilliseconds,
    },
    dependencies,
  );
  return {
    bundle,
    bundleBytes: stored.bytes,
    bundleSha256: stored.reference.sha256,
    bundleReference: stored.reference,
    receiptReferences: receipts,
  };
};
