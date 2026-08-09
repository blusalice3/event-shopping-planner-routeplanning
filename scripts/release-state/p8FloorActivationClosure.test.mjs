import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import { computeRoleEntryGraphHash } from "../lib/artifact-contract.mjs";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
} from "./releaseWorkflowValidation.mjs";
import {
  P8_FLOOR_ACTIVATION_CLOSURE_KIND,
  buildP8FloorActivationClosure,
  validateP8FloorActivationClosure,
} from "./p8FloorActivationClosure.mjs";
import { derivePolicyActivationSubject } from "./policyActivation.mjs";
import { buildAuthoritativePolicyActivationClosure } from "./policyActivationClosure.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const policyTemplate = JSON.parse(
  await readFile(path.join(root, "config", "release-variants.json"), "utf8"),
);
const namespace = "p8-floor-closure-test";
const sourceSha = "a".repeat(40);
const executorSourceSha = "b".repeat(40);
const operationId = "activate-p8-minimum-floor";
const committedAt = "2026-08-09T00:00:00.000Z";
const dbCompatibility = {
  contractUri: "urn:test:p8-db:v1",
  fingerprint: "d".repeat(64),
};
const PACKAGE_INDEX_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.release-package-index+json;version=1";
const MANIFEST_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-manifest+json;version=1";

const createStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    reads: 0,
    async putEvidence({ bytes, mediaType }) {
      const input = Buffer.from(bytes);
      const sha256 = sha256Bytes(input);
      const replayed = objects.has(sha256);
      objects.set(sha256, { bytes: input, mediaType, committedAt });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        byteLength: input.length,
        mediaType,
        committedAt,
        replayed,
      };
    },
    async readEvidence({ sha256 }) {
      this.reads += 1;
      return objects.get(sha256) ?? null;
    },
  };
};

const putBytes = async (store, bytes, mediaType) => {
  const receipt = await store.putEvidence({ bytes, mediaType });
  return { uri: receipt.uri, sha256: receipt.sha256 };
};

const putJson = (store, value, mediaType = "application/json") =>
  putBytes(store, canonicalJsonBytes(value), mediaType);

const artifactReference = (sha256, kind) => ({
  uri: `artifact://sha256/${sha256}/${kind}`,
  sha256,
});

const createZip = async (entries) => {
  const zip = new yazl.ZipFile();
  const chunks = [];
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  for (const [name, bytes] of entries) {
    zip.addBuffer(Buffer.from(bytes), name, {
      mtime: new Date("2026-08-09T00:00:00.000Z"),
      mode: 0o100600,
    });
  }
  zip.end();
  await once(zip.outputStream, "end");
  return Buffer.concat(chunks);
};

const outputConfig = (styleSrcAttr) => ({
  version: 3,
  routes: [
    {
      src: "^/.*$",
      headers: {
        "Content-Security-Policy": `default-src 'self'; style-src 'self'; style-src-attr ${styleSrcAttr}`,
        "X-Content-Type-Options": "nosniff",
      },
      continue: true,
    },
    { handle: "filesystem" },
    { src: "^/.*$", dest: "/index.html" },
  ],
});

const createArtifact = async ({
  store,
  releasePolicy,
  releasePolicyReference,
  providerPolicyReference,
  buildAuthority,
  role,
  dimensions,
  styleSrcAttr,
  targetGate,
}) => {
  const configBytes = canonicalJsonBytes(outputConfig(styleSrcAttr));
  const chunkBytes = Buffer.from(`p8-${role}-entry`, "utf8");
  const indexBytes = Buffer.from(`<main>${role}</main>`, "utf8");
  const entries = [
    ["config.json", configBytes],
    ["static/assets/release-role.js", chunkBytes],
    ["static/index.html", indexBytes],
  ];
  const archiveBytes = await createZip(entries);
  const archiveReference = await putBytes(
    store,
    archiveBytes,
    ARTIFACT_ARCHIVE_MEDIA_TYPE,
  );
  const variantId = computeVariantId(releasePolicy, dimensions);
  const entryModule =
    role === "standard" ? "src/index.tsx" : "src/containment-entry.tsx";
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha,
    releaseRole: role,
    variantId,
    entryModule,
    entryFile: "/assets/release-role.js",
    modules: [
      {
        id: entryModule,
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: "/assets/release-role.js",
        sha256: sha256Bytes(chunkBytes),
        size: chunkBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: [entryModule],
      },
    ],
  };
  const manifest = {
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
    buildInputClosureHash: "1".repeat(64),
    lockfileSha256: "2".repeat(64),
    toolchainPolicyHash: "3".repeat(64),
    publicBuildEnvHash: "4".repeat(64),
    providerConfigurationHash: "5".repeat(64),
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility: dbCompatibility,
    publicIdentityKind: "release-identity-v1",
    bootstrap: null,
    publicResponseHashes: { "/": sha256Bytes(indexBytes) },
    roleEntryGraph,
    roleEntryGraphHash: computeRoleEntryGraphHash(roleEntryGraph),
    outputFiles: entries.map(([filePath, bytes]) => ({
      path: filePath,
      sha256: sha256Bytes(bytes),
      size: bytes.length,
    })),
  };
  const manifestReference = await putJson(store, manifest, MANIFEST_MEDIA_TYPE);
  return {
    archiveBytes,
    archiveReference,
    manifest,
    manifestReference,
  };
};

const createFixture = async ({
  acceptedGate = "P8-CLEAN",
  packageTargetGate = "P8-CLEAN",
  styleSrcAttr = "'none'",
  inventoryEligible = true,
} = {}) => {
  const store = createStore();
  const acceptedStandardFloors = Object.fromEntries(
    Object.entries(policyTemplate.targetStandard).filter(
      ([key]) => key !== "releaseRole",
    ),
  );
  const preP8Floors = Object.fromEntries(
    Object.entries(policyTemplate.minimumSafetyFloors).filter(
      ([key]) => key !== "styleSrcAttr",
    ),
  );
  const predecessorPolicyReference = await putJson(store, {
    policy: "pre-p8-compatible-predecessor",
  });
  const releasePolicy = {
    ...structuredClone(policyTemplate),
    activationStatus: "active",
    activationBlockers: [],
    acceptedStandardFloors,
    compatiblePredecessorPolicies: [
      {
        predecessorPolicy: predecessorPolicyReference,
        eligibleBindingIds: ["pre-p8-standard-binding"],
        allowedActions: ["rollback"],
        minimumSafetyFloors: preP8Floors,
        requiredDbCompatibility: dbCompatibility,
        expiresAt: "2027-08-09T00:00:00.000Z",
        owner: "foundation-release-owner",
      },
    ],
  };
  const releasePolicyReference = await putJson(
    store,
    releasePolicy,
    "application/vnd.event-shopping-planner.release-policy+json;version=1",
  );
  const providerPolicyReference = await putJson(store, {
    policy: "configured-provider",
  });
  const buildAuthority = await putJson(store, {
    requirementsKind: "authoritative-artifact-build-requirements/v1",
  });
  const standardDimensions = structuredClone(releasePolicy.targetStandard);
  const companionDimensions = projectContainmentDimensions(
    releasePolicy,
    standardDimensions,
  );
  const [standardArtifact, companionArtifact] = await Promise.all([
    createArtifact({
      store,
      releasePolicy,
      releasePolicyReference,
      providerPolicyReference,
      buildAuthority,
      role: "standard",
      dimensions: standardDimensions,
      styleSrcAttr,
      targetGate: packageTargetGate,
    }),
    createArtifact({
      store,
      releasePolicy,
      releasePolicyReference,
      providerPolicyReference,
      buildAuthority,
      role: "containment",
      dimensions: companionDimensions,
      styleSrcAttr,
      targetGate: packageTargetGate,
    }),
  ]);
  const packageIndex = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha,
    buildId: sourceSha,
    buildAuthority,
    targetGate: packageTargetGate,
    buildPurpose: "production",
    promotable: true,
    toolchainPolicyHash: "3".repeat(64),
    providerConfigurationHash: "5".repeat(64),
    providerPolicyHash: providerPolicyReference.sha256,
    releasePolicyHash: releasePolicyReference.sha256,
    requiredDbCompatibility: dbCompatibility,
    artifacts: [
      {
        releaseRole: "standard",
        variantId: standardArtifact.manifest.variantId,
        manifest: artifactReference(
          standardArtifact.manifestReference.sha256,
          "artifact.json",
        ),
        archive: artifactReference(
          standardArtifact.archiveReference.sha256,
          "artifact.zip",
        ),
      },
      {
        releaseRole: "containment",
        variantId: companionArtifact.manifest.variantId,
        manifest: artifactReference(
          companionArtifact.manifestReference.sha256,
          "artifact.json",
        ),
        archive: artifactReference(
          companionArtifact.archiveReference.sha256,
          "artifact.zip",
        ),
      },
    ],
  };
  const packageIndexReference = await putJson(
    store,
    packageIndex,
    PACKAGE_INDEX_MEDIA_TYPE,
  );
  const createBinding = async ({ role, artifact }) => {
    const bindingId = `p8-${role}-binding`;
    const availability = {
      schemaVersion: 1,
      evidenceKind: "artifact-archive-availability/v1",
      namespace,
      bindingId,
      sourceSha,
      variantId: artifact.manifest.variantId,
      releaseRole: role,
      artifactManifest: artifact.manifestReference,
      artifactArchive: {
        ...artifact.archiveReference,
        mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
        byteLength: artifact.archiveBytes.length,
        committedAt,
      },
      availability: "available",
    };
    const availabilityReference = await putJson(
      store,
      availability,
      ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
    );
    const providerEvidence = await putJson(store, {
      providerDeploymentId: `p8-${role}-deployment`,
    });
    return {
      bindingId,
      sourceSha,
      buildId: sourceSha,
      variantId: artifact.manifest.variantId,
      releaseRole: role,
      publicIdentityKind: "release-identity-v1",
      providerProjectId: "p8-project",
      providerDeploymentId: `p8-${role}-deployment`,
      deploymentUrl: `https://p8-${role}.example.test`,
      artifactArchive: artifact.archiveReference,
      artifactArchiveAvailability: availabilityReference,
      packageIndex: packageIndexReference,
      artifactManifest: artifact.manifestReference,
      providerEvidence,
      releasePolicy: releasePolicyReference,
      providerPolicy: providerPolicyReference,
      providerConfigurationHash: "5".repeat(64),
      requiredDbCompatibility: dbCompatibility,
    };
  };
  const [standard, companion] = await Promise.all([
    createBinding({ role: "standard", artifact: standardArtifact }),
    createBinding({ role: "containment", artifact: companionArtifact }),
  ]);
  const acceptedEvent = {
    uri: `release-state://${namespace}/events/88/${"e".repeat(64)}`,
    sha256: "e".repeat(64),
  };
  const current = {
    head: { sequence: 88, eventHash: "e".repeat(64) },
    records: [],
    snapshot: {
      acceptedGate,
      acceptedStandardFloors,
      minimumSafetyFloors: preP8Floors,
      currentDbCompatibility: dbCompatibility,
      activeReleasePolicy: releasePolicyReference,
      activePolicyCompatibility: structuredClone(
        releasePolicy.compatiblePredecessorPolicies,
      ),
      activeProduction: standard,
      acceptedStandard: standard,
      acceptedStandardEvent: acceptedEvent,
      containmentCompanion: companion,
      pendingOperation: null,
      pendingAcceptance: null,
      containmentIncident: null,
      standardRecovery: null,
      legacyObservedProduction: null,
      rollbackInventory: [],
      bootstrapRecovery: null,
    },
  };
  const transition = {
    activationGate: "P8-CLEAN",
    behaviorDimensionChange: null,
    minimumSafetyFloorChange: { styleSrcAttr: "none" },
    minimumSafetyFloors: releasePolicy.minimumSafetyFloors,
  };
  const rollbackInventory = [
    {
      binding: standard,
      acceptedEvent,
      acceptedGate: "P8-CLEAN",
      acceptedStandardFloors,
      evaluatedPolicy: releasePolicyReference,
      eligibleActions: inventoryEligible
        ? ["package-redeploy", "rollback"]
        : [],
      eligibility: inventoryEligible ? "eligible" : "ineligible",
      reasonCodes: inventoryEligible ? [] : ["release-policy-mismatch"],
    },
  ];
  const dependencies = {
    resolveAcceptedStandardAuthorityImpl: () => ({
      acceptedEvent,
      acceptedGate,
      acceptedStandardFloors,
    }),
    deriveRollbackInventoryImpl: async () => rollbackInventory,
  };
  return {
    store,
    current,
    releasePolicy,
    releasePolicyReference,
    transition,
    rollbackInventory,
    dependencies,
  };
};

const closureOptions = (fixture) => ({
  store: fixture.store,
  namespace,
  operationId,
  executorSourceSha,
  current: fixture.current,
  releasePolicy: fixture.releasePolicy,
  releasePolicyReference: fixture.releasePolicyReference,
  transition: fixture.transition,
  nowMilliseconds: Date.parse("2026-08-09T01:00:00.000Z"),
});

test("builds and rederives the P8 package, headers, state, and rollback closure", async () => {
  const fixture = await createFixture();
  const result = await buildP8FloorActivationClosure(
    closureOptions(fixture),
    fixture.dependencies,
  );
  assert.equal(result.bundle.bundleKind, P8_FLOOR_ACTIVATION_CLOSURE_KIND);
  assert.equal(Object.keys(result.receiptReferences).length, 5);
  const validation = await validateP8FloorActivationClosure(
    {
      ...closureOptions(fixture),
      closureBundleReference: result.bundleReference,
    },
    fixture.dependencies,
  );
  assert.equal(validation.references.length, 5);
  assert.equal(validation.targetSourceSha, sourceSha);
  assert.deepEqual(validation.activePolicyCompatibility, []);
  assert.deepEqual(validation.rollbackInventory, fixture.rollbackInventory);
  const headerReceiptReference = result.receiptReferences.securityHeaders;
  const headerReceipt = JSON.parse(
    fixture.store.objects
      .get(headerReceiptReference.sha256)
      .bytes.toString("utf8"),
  );
  assert.deepEqual(headerReceipt.result.standard.styleSrcAttr, ["'none'"]);
  assert.deepEqual(headerReceipt.result.companion.styleSrcAttr, ["'none'"]);
});

test("keeps normal QA and P8 floor closure selection distinct", async () => {
  const fixture = await createFixture();
  let received = null;
  const result = await buildAuthoritativePolicyActivationClosure(
    {
      store: fixture.store,
      namespace,
      operationId,
      executorSourceSha,
      qaExecutionReference: null,
    },
    {
      readState: async () => fixture.current,
      buildP8Closure: async (options) => {
        received = options;
        return { bundleKind: P8_FLOOR_ACTIVATION_CLOSURE_KIND };
      },
    },
  );
  assert.equal(result.bundleKind, P8_FLOOR_ACTIVATION_CLOSURE_KIND);
  assert.equal(received.current, fixture.current);
  assert.equal(received.transition.activationGate, "P8-CLEAN");
  assert.deepEqual(
    received.releasePolicyReference,
    fixture.releasePolicyReference,
  );
});

test("derives the activation subject only from the P8 closure branch", async () => {
  const fixture = await createFixture();
  fixture.current.records = [{ event: { namespace } }];
  const closureBundleReference = await putJson(fixture.store, {
    bundleKind: P8_FLOOR_ACTIVATION_CLOSURE_KIND,
  });
  const closureEvidenceRefs = [];
  for (let index = 0; index < 5; index += 1) {
    closureEvidenceRefs.push(
      await putJson(fixture.store, { receipt: `p8-${index}` }),
    );
  }
  closureEvidenceRefs.sort((left, right) =>
    Buffer.compare(Buffer.from(left.uri), Buffer.from(right.uri)),
  );
  let p8Validated = false;
  let normalValidated = false;
  const subject = await derivePolicyActivationSubject(
    {
      store: fixture.store,
      namespace,
      operationId,
      executorSourceSha,
      proposedPolicyReference: fixture.releasePolicyReference,
      activePolicyReference: fixture.releasePolicyReference,
      closureBundleReference,
      current: fixture.current,
      nowMilliseconds: Date.parse("2026-08-09T01:00:00.000Z"),
    },
    {
      validateP8ClosureImpl: async (options) => {
        p8Validated = true;
        assert.equal(options.current, fixture.current);
        return {
          references: closureEvidenceRefs,
          targetSourceSha: sourceSha,
          activePolicyCompatibility: [],
          rollbackInventory: fixture.rollbackInventory,
        };
      },
      validateNormalClosureImpl: async () => {
        normalValidated = true;
        throw new Error("normal QA closure must not run for P8");
      },
      deriveRollbackInventoryImpl: async () => fixture.rollbackInventory,
    },
  );
  assert.equal(p8Validated, true);
  assert.equal(normalValidated, false);
  assert.equal(subject.activationGate, "P8-CLEAN");
  assert.equal(subject.targetSourceSha, sourceSha);
  assert.deepEqual(subject.activePolicyCompatibility, []);
  assert.deepEqual(subject.closureEvidenceRefs, closureEvidenceRefs);
  assert.deepEqual(subject.rollbackInventory, fixture.rollbackInventory);
});

test("rejects non-P8 live state before reading package evidence", async () => {
  const fixture = await createFixture({ acceptedGate: "P7-IDB" });
  const readsBefore = fixture.store.reads;
  await assert.rejects(
    buildP8FloorActivationClosure(
      closureOptions(fixture),
      fixture.dependencies,
    ),
    /exact pre-floor transition/u,
  );
  assert.equal(fixture.store.reads, readsBefore);
});

test("rejects a non-P8 package and an unsafe style attribute header", async () => {
  const wrongPackage = await createFixture({ packageTargetGate: "P7-IDB" });
  await assert.rejects(
    buildP8FloorActivationClosure(
      closureOptions(wrongPackage),
      wrongPackage.dependencies,
    ),
    /P8 release package index binding is invalid/u,
  );
  const unsafeHeader = await createFixture({
    styleSrcAttr: "'unsafe-inline'",
  });
  await assert.rejects(
    buildP8FloorActivationClosure(
      closureOptions(unsafeHeader),
      unsafeHeader.dependencies,
    ),
    /does not enforce style-src-attr 'none'/u,
  );
});

test("rejects ineligible rollback inventory and re-signed receipt tampering", async () => {
  const ineligible = await createFixture({ inventoryEligible: false });
  await assert.rejects(
    buildP8FloorActivationClosure(
      closureOptions(ineligible),
      ineligible.dependencies,
    ),
    /not rollback eligible after floor/u,
  );

  const fixture = await createFixture();
  const result = await buildP8FloorActivationClosure(
    closureOptions(fixture),
    fixture.dependencies,
  );
  const securityReference = result.receiptReferences.securityHeaders;
  const securityReceipt = JSON.parse(
    fixture.store.objects.get(securityReference.sha256).bytes.toString("utf8"),
  );
  securityReceipt.result.standard.headerValueSha256 = "0".repeat(64);
  const tamperedReceiptReference = await putJson(
    fixture.store,
    securityReceipt,
    fixture.store.objects.get(securityReference.sha256).mediaType,
  );
  const tamperedBundle = structuredClone(result.bundle);
  tamperedBundle.receipts.securityHeaders = tamperedReceiptReference;
  const tamperedBundleReference = await putJson(
    fixture.store,
    tamperedBundle,
    fixture.store.objects.get(result.bundleReference.sha256).mediaType,
  );
  await assert.rejects(
    validateP8FloorActivationClosure(
      {
        ...closureOptions(fixture),
        closureBundleReference: tamperedBundleReference,
      },
      fixture.dependencies,
    ),
    /securityHeaders receipt differs from live authority/u,
  );
});
