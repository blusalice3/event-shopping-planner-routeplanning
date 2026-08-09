import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import {
  assertFileManifestEqual,
  assertSafeRelativePath,
  buildFileManifest,
} from "./file-manifest.mjs";
import {
  assertDimensionObject,
  computeVariantId,
  projectContainmentDimensions,
  RELEASE_DIMENSION_KEYS,
} from "./release-policy.mjs";
import {
  ARTIFACT_DRILL_BUILD_PURPOSE,
  POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  RELEASE_BUILD_PURPOSES,
} from "./release-build-input.mjs";
import { parseContentAddressedUri } from "./content-addressed-store.mjs";
import {
  OUTER_AGENT_GRAPH_URL,
  OUTER_AGENT_URL,
  parseIndependentOuterAgentGraph,
} from "./outer-agent-contract.mjs";
import {
  NORMAL_POLICY_ACTIVATION_GATES,
  RELEASE_PHASE_GATES,
} from "../release-state/phaseGates.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^v?[0-9]+\.[0-9]+\.[0-9]+$/;
const PUBLIC_PATH_PATTERN = /^\/(?!\/)[^\\]*$/;
const PLACEHOLDER_PATTERN =
  /(?:^|[-_.:/])(placeholder|change[-_ ]?me|example|todo|tbd|unknown|unconfigured)(?:$|[-_.:/])/i;
const LEGACY_BOOTSTRAP_BUILD_PURPOSE = "legacy-bootstrap";
const RELEASE_BUILD_PURPOSE_SET = new Set([
  ...RELEASE_BUILD_PURPOSES,
  LEGACY_BOOTSTRAP_BUILD_PURPOSE,
]);
const SOURCE_HARDENED_BUILD_PURPOSES = new Set([
  "production",
  POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  ARTIFACT_DRILL_BUILD_PURPOSE,
]);
const RELEASE_PHASE_GATE_SET = new Set(RELEASE_PHASE_GATES);
const POLICY_ACTIVATION_GATE_SET = new Set(NORMAL_POLICY_ACTIVATION_GATES);
const RELEASE_STATE_EVIDENCE_URI_PATTERN =
  /^release-state:\/\/([a-z0-9][a-z0-9-]{2,62})\/evidence\/([0-9a-f]{64})$/;

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPublicPath = (value) =>
  typeof value === "string" &&
  !value.includes("\0") &&
  PUBLIC_PATH_PATTERN.test(value);

const assertRecord = (value, label) => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
};

const assertExactKeys = (value, keys, label) => {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an unexpected property set`);
  }
};

const assertString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const assertSha256 = (value, label) => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
};

const assertSourceSha = (value, label) => {
  if (typeof value !== "string" || !SOURCE_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
  return value;
};

export const assertNoPlaceholder = (value, label) => {
  const text = assertString(value, label);
  if (PLACEHOLDER_PATTERN.test(text)) {
    throw new Error(`${label} contains a placeholder value`);
  }
  return text;
};

export const assertDbCompatibilityBinding = (value, label) => {
  assertExactKeys(value, ["contractUri", "fingerprint"], label);
  assertNoPlaceholder(value.contractUri, `${label}.contractUri`);
  assertSha256(value.fingerprint, `${label}.fingerprint`);
  return value;
};

const assertImmutableReference = (value, label) => {
  assertExactKeys(value, ["uri", "sha256"], label);
  assertString(value.uri, `${label}.uri`);
  assertSha256(value.sha256, `${label}.sha256`);
  return value;
};

const assertBuildAuthorityReference = (value, label, buildPurpose) => {
  assertImmutableReference(value, label);
  if (buildPurpose === ARTIFACT_DRILL_BUILD_PURPOSE) {
    const parsed = parseContentAddressedUri(
      value.uri,
      "artifact-drill-build-authority.json",
    );
    if (parsed.sha256 !== value.sha256) {
      throw new Error(`${label} content-addressed hash differs`);
    }
    return value;
  }
  const match = RELEASE_STATE_EVIDENCE_URI_PATTERN.exec(value.uri);
  if (match === null || match[2] !== value.sha256) {
    throw new Error(
      `${label} is not a closed Release State evidence reference`,
    );
  }
  return value;
};

const assertExpectedBuildPurpose = (expectedBuildPurpose) => {
  if (!RELEASE_BUILD_PURPOSE_SET.has(expectedBuildPurpose)) {
    throw new Error("Expected release build purpose is invalid");
  }
  return expectedBuildPurpose;
};

const assertBuildPurposeMarker = (value, expectedBuildPurpose, label) => {
  assertExpectedBuildPurpose(expectedBuildPurpose);
  if (
    expectedBuildPurpose === "production" ||
    expectedBuildPurpose === LEGACY_BOOTSTRAP_BUILD_PURPOSE
  ) {
    if (value.nonPromotable !== undefined || value.buildPurpose !== undefined) {
      throw new Error(`${label} is a nonpromotable QA build`);
    }
    return [];
  }
  if (
    value.nonPromotable !== true ||
    value.buildPurpose !== expectedBuildPurpose
  ) {
    throw new Error(
      `${label} build purpose differs from the expected QA build`,
    );
  }
  return ["buildPurpose", "nonPromotable"];
};

const assertArtifactBuildAuthority = (
  value,
  { bootstrap, expectedBuildPurpose, label },
) => {
  if (bootstrap) {
    if (
      !["production", LEGACY_BOOTSTRAP_BUILD_PURPOSE].includes(
        expectedBuildPurpose,
      ) ||
      value.buildAuthority !== null ||
      value.targetGate !== null ||
      value.buildPurpose !== LEGACY_BOOTSTRAP_BUILD_PURPOSE ||
      value.promotable !== false
    ) {
      throw new Error(`${label} legacy bootstrap build authority is invalid`);
    }
    return value;
  }
  assertExpectedBuildPurpose(expectedBuildPurpose);
  if (!SOURCE_HARDENED_BUILD_PURPOSES.has(value.buildPurpose)) {
    throw new Error(`${label}.buildPurpose is invalid`);
  }
  if (
    value.buildPurpose !== expectedBuildPurpose ||
    value.promotable !== (value.buildPurpose === "production")
  ) {
    throw new Error(`${label} purpose/promotable binding is invalid`);
  }
  assertBuildAuthorityReference(
    value.buildAuthority,
    `${label}.buildAuthority`,
    value.buildPurpose,
  );
  if (
    value.buildPurpose === ARTIFACT_DRILL_BUILD_PURPOSE
      ? value.targetGate !== "P0-ARTIFACT"
      : !RELEASE_PHASE_GATE_SET.has(value.targetGate)
  ) {
    throw new Error(`${label}.targetGate is invalid`);
  }
  if (
    value.buildPurpose === POLICY_ACTIVATION_QA_BUILD_PURPOSE &&
    !POLICY_ACTIVATION_GATE_SET.has(value.targetGate)
  ) {
    throw new Error(`${label}.targetGate is invalid for policy activation QA`);
  }
  return value;
};

const assertOutputFiles = (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Artifact outputFiles must be a non-empty array");
  }
  const folded = new Set();
  let previousPath = null;
  for (const [index, file] of files.entries()) {
    assertExactKeys(file, ["path", "sha256", "size"], `outputFiles[${index}]`);
    assertSafeRelativePath(file.path);
    if (
      file.path === "artifact-manifest.json" ||
      file.path === "release-package-index.json"
    ) {
      throw new Error("Artifact metadata must not be embedded in outputFiles");
    }
    assertSha256(file.sha256, `outputFiles[${index}].sha256`);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`outputFiles[${index}].size is invalid`);
    }
    if (previousPath !== null && compareUtf8(previousPath, file.path) >= 0) {
      throw new Error("Artifact outputFiles must use strict UTF-8 byte order");
    }
    previousPath = file.path;
    const caseFolded = file.path.toLocaleLowerCase("en-US");
    if (folded.has(caseFolded)) {
      throw new Error(`Case-colliding artifact path: ${file.path}`);
    }
    folded.add(caseFolded);
  }
};

const assertPublicResponseHashes = (hashes) => {
  assertRecord(hashes, "publicResponseHashes");
  const paths = Object.keys(hashes);
  let previousPath = null;
  for (const publicPath of paths) {
    if (!isPublicPath(publicPath)) {
      throw new Error(`Invalid public response path: ${publicPath}`);
    }
    if (previousPath !== null && compareUtf8(previousPath, publicPath) >= 0) {
      throw new Error(
        "publicResponseHashes must use strict UTF-8 byte insertion order",
      );
    }
    previousPath = publicPath;
    assertSha256(hashes[publicPath], `publicResponseHashes[${publicPath}]`);
  }
};

const assertSortedUniqueStrings = (values, label, validator = null) => {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  let previous = null;
  for (const [index, value] of values.entries()) {
    assertString(value, `${label}[${index}]`);
    if (validator !== null) validator(value, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      throw new Error(`${label} must use strict UTF-8 byte order`);
    }
    previous = value;
  }
};

const assertModuleId = (value, label) => {
  assertString(value, label);
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    /^(?:[A-Za-z]:\/|\/)/.test(value)
  ) {
    throw new Error(`${label} must be checkout-relative or virtual`);
  }
};

export const assertRoleEntryGraph = (graph, manifest) => {
  assertExactKeys(
    graph,
    [
      "schemaVersion",
      "graphKind",
      "sourceSha",
      "releaseRole",
      "variantId",
      "entryModule",
      "entryFile",
      "modules",
      "chunks",
    ],
    "RoleEntryGraph",
  );
  if (
    graph.schemaVersion !== 1 ||
    !["rollup-role-entry-v1", "legacy-static-entry-v1"].includes(
      graph.graphKind,
    )
  ) {
    throw new Error("RoleEntryGraph version or kind is invalid");
  }
  assertSourceSha(graph.sourceSha, "RoleEntryGraph.sourceSha");
  assertSha256(graph.variantId, "RoleEntryGraph.variantId");
  if (
    graph.sourceSha !== manifest.sourceSha ||
    graph.releaseRole !== manifest.releaseRole ||
    graph.variantId !== manifest.variantId
  ) {
    throw new Error("RoleEntryGraph identity differs from ArtifactManifest");
  }
  assertModuleId(graph.entryModule, "RoleEntryGraph.entryModule");
  if (!isPublicPath(graph.entryFile)) {
    throw new Error("RoleEntryGraph.entryFile is invalid");
  }
  if (!Array.isArray(graph.modules) || graph.modules.length === 0) {
    throw new Error("RoleEntryGraph.modules must be non-empty");
  }
  const moduleIds = new Set();
  let previousModule = null;
  for (const [index, module] of graph.modules.entries()) {
    const label = `RoleEntryGraph.modules[${index}]`;
    assertExactKeys(
      module,
      ["id", "external", "staticImports", "dynamicImports"],
      label,
    );
    assertModuleId(module.id, `${label}.id`);
    if (
      previousModule !== null &&
      compareUtf8(previousModule, module.id) >= 0
    ) {
      throw new Error(
        "RoleEntryGraph.modules must use strict UTF-8 byte order",
      );
    }
    previousModule = module.id;
    if (typeof module.external !== "boolean") {
      throw new Error(`${label}.external must be boolean`);
    }
    assertSortedUniqueStrings(
      module.staticImports,
      `${label}.staticImports`,
      assertModuleId,
    );
    assertSortedUniqueStrings(
      module.dynamicImports,
      `${label}.dynamicImports`,
      assertModuleId,
    );
    moduleIds.add(module.id);
  }
  if (!moduleIds.has(graph.entryModule)) {
    throw new Error("RoleEntryGraph entry module is absent");
  }
  for (const [index, module] of graph.modules.entries()) {
    for (const imported of [
      ...module.staticImports,
      ...module.dynamicImports,
    ]) {
      if (!moduleIds.has(imported)) {
        throw new Error(
          `RoleEntryGraph.modules[${index}] imports an absent module`,
        );
      }
    }
  }
  if (!Array.isArray(graph.chunks) || graph.chunks.length === 0) {
    throw new Error("RoleEntryGraph.chunks must be non-empty");
  }
  const chunkFiles = new Set();
  let previousChunk = null;
  for (const [index, chunk] of graph.chunks.entries()) {
    const label = `RoleEntryGraph.chunks[${index}]`;
    assertExactKeys(
      chunk,
      ["file", "sha256", "size", "staticImports", "dynamicImports", "modules"],
      label,
    );
    if (!isPublicPath(chunk.file)) {
      throw new Error(`${label}.file is invalid`);
    }
    if (previousChunk !== null && compareUtf8(previousChunk, chunk.file) >= 0) {
      throw new Error("RoleEntryGraph.chunks must use strict UTF-8 byte order");
    }
    previousChunk = chunk.file;
    assertSha256(chunk.sha256, `${label}.sha256`);
    if (!Number.isSafeInteger(chunk.size) || chunk.size < 0) {
      throw new Error(`${label}.size is invalid`);
    }
    assertSortedUniqueStrings(
      chunk.staticImports,
      `${label}.staticImports`,
      (value, valueLabel) => {
        if (!isPublicPath(value)) throw new Error(`${valueLabel} is invalid`);
      },
    );
    assertSortedUniqueStrings(
      chunk.dynamicImports,
      `${label}.dynamicImports`,
      (value, valueLabel) => {
        if (!isPublicPath(value)) throw new Error(`${valueLabel} is invalid`);
      },
    );
    assertSortedUniqueStrings(
      chunk.modules,
      `${label}.modules`,
      assertModuleId,
    );
    for (const moduleId of chunk.modules) {
      if (!moduleIds.has(moduleId)) {
        throw new Error(`${label} contains an absent module`);
      }
    }
    chunkFiles.add(chunk.file);
  }
  if (!chunkFiles.has(graph.entryFile)) {
    throw new Error("RoleEntryGraph entry file is absent");
  }
  for (const [index, chunk] of graph.chunks.entries()) {
    for (const imported of [...chunk.staticImports, ...chunk.dynamicImports]) {
      if (!chunkFiles.has(imported)) {
        throw new Error(
          `RoleEntryGraph.chunks[${index}] imports an absent chunk`,
        );
      }
    }
  }
  if (
    graph.graphKind === "rollup-role-entry-v1" &&
    graph.entryFile !== "/assets/release-role.js"
  ) {
    throw new Error("Rollup RoleEntryGraph must bind the stable role entry");
  }
  if (
    manifest.releaseRole === "containment" &&
    graph.graphKind === "rollup-role-entry-v1"
  ) {
    const forbiddenContainmentModule =
      /^(?:src\/(?:App\.tsx$|app\/|persistence\/|xlsx\/|hooks\/useIndexedDbPersistence\.ts$|utils\/indexedDB\.ts$|features\/shopping-list\/|components\/(?:ShoppingList|ShoppingItemCard|SummaryBar|VisitListPanel|map\/(?:MapVisitListPanel|VisitListPanel))\.(?:ts|tsx)$)|node_modules\/(?:exceljs\/|@zip\.js\/|@tanstack\/react-virtual\/))/;
    const forbidden = graph.modules.find((module) =>
      forbiddenContainmentModule.test(module.id),
    );
    if (forbidden) {
      throw new Error(
        `Containment RoleEntryGraph reaches forbidden module ${forbidden.id}`,
      );
    }
  }
  return graph;
};

const ARTIFACT_MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "sourceSha",
  "buildId",
  "variantId",
  "releaseRole",
  "dimensions",
  "buildAuthority",
  "targetGate",
  "buildPurpose",
  "promotable",
  "buildInputClosureHash",
  "lockfileSha256",
  "toolchainPolicyHash",
  "publicBuildEnvHash",
  "providerConfigurationHash",
  "providerPolicyHash",
  "releasePolicyHash",
  "requiredDbCompatibility",
  "publicIdentityKind",
  "bootstrap",
  "publicResponseHashes",
  "roleEntryGraph",
  "roleEntryGraphHash",
  "outputFiles",
]);

export const computeRoleEntryGraphHash = (roleEntryGraph) =>
  sha256Json(roleEntryGraph);

export const assertArtifactManifest = (
  manifest,
  releasePolicy,
  { expectedBuildPurpose = "production" } = {},
) => {
  assertExactKeys(manifest, ARTIFACT_MANIFEST_KEYS, "ArtifactManifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error("ArtifactManifest schemaVersion must be 1");
  }
  assertSourceSha(manifest.sourceSha, "ArtifactManifest.sourceSha");
  assertSourceSha(manifest.buildId, "ArtifactManifest.buildId");
  if (manifest.buildId !== manifest.sourceSha) {
    throw new Error("ArtifactManifest buildId must equal sourceSha");
  }
  if (!["standard", "containment"].includes(manifest.releaseRole)) {
    throw new Error("ArtifactManifest releaseRole is invalid");
  }
  assertDimensionObject(releasePolicy, manifest.dimensions);
  if (manifest.dimensions.releaseRole !== manifest.releaseRole) {
    throw new Error("ArtifactManifest role and dimension role differ");
  }
  const expectedVariantId = computeVariantId(
    releasePolicy,
    manifest.dimensions,
  );
  if (manifest.variantId !== expectedVariantId) {
    throw new Error("ArtifactManifest variantId differs from its dimensions");
  }
  for (const field of [
    "buildInputClosureHash",
    "lockfileSha256",
    "toolchainPolicyHash",
    "publicBuildEnvHash",
    "providerConfigurationHash",
    "providerPolicyHash",
    "releasePolicyHash",
    "roleEntryGraphHash",
  ]) {
    assertSha256(manifest[field], `ArtifactManifest.${field}`);
  }
  assertDbCompatibilityBinding(
    manifest.requiredDbCompatibility,
    "ArtifactManifest.requiredDbCompatibility",
  );
  if (
    !["release-identity-v1", "legacy-bootstrap-v1"].includes(
      manifest.publicIdentityKind,
    )
  ) {
    throw new Error("ArtifactManifest publicIdentityKind is invalid");
  }
  assertArtifactBuildAuthority(manifest, {
    bootstrap: manifest.publicIdentityKind === "legacy-bootstrap-v1",
    expectedBuildPurpose,
    label: "ArtifactManifest",
  });
  if (manifest.publicIdentityKind === "release-identity-v1") {
    if (manifest.bootstrap !== null) {
      throw new Error("Source-hardened artifact cannot contain bootstrap data");
    }
  } else {
    assertExactKeys(
      manifest.bootstrap,
      [
        "inputUri",
        "inputSha256",
        "rawDistManifestUri",
        "rawDistManifestSha256",
      ],
      "ArtifactManifest.bootstrap",
    );
    assertString(manifest.bootstrap.inputUri, "bootstrap.inputUri");
    assertSha256(manifest.bootstrap.inputSha256, "bootstrap.inputSha256");
    assertString(
      manifest.bootstrap.rawDistManifestUri,
      "bootstrap.rawDistManifestUri",
    );
    assertSha256(
      manifest.bootstrap.rawDistManifestSha256,
      "bootstrap.rawDistManifestSha256",
    );
    if (manifest.releaseRole !== "containment") {
      throw new Error("Legacy bootstrap artifact must be containment");
    }
  }
  assertPublicResponseHashes(manifest.publicResponseHashes);
  assertOutputFiles(manifest.outputFiles);
  assertRoleEntryGraph(manifest.roleEntryGraph, manifest);
  const expectedGraphHash = computeRoleEntryGraphHash(manifest.roleEntryGraph);
  if (manifest.roleEntryGraphHash !== expectedGraphHash) {
    throw new Error("ArtifactManifest roleEntryGraphHash is invalid");
  }
  return manifest;
};

const COMMON_INDEX_KEYS = Object.freeze([
  "schemaVersion",
  "packageKind",
  "sourceSha",
  "buildId",
  "buildAuthority",
  "targetGate",
  "buildPurpose",
  "promotable",
  "toolchainPolicyHash",
  "providerConfigurationHash",
  "providerPolicyHash",
  "releasePolicyHash",
  "requiredDbCompatibility",
]);

const assertArtifactReference = (reference, expectedRole, label) => {
  assertExactKeys(
    reference,
    ["releaseRole", "variantId", "manifest", "archive"],
    label,
  );
  if (reference.releaseRole !== expectedRole) {
    throw new Error(`${label}.releaseRole must be ${expectedRole}`);
  }
  assertSha256(reference.variantId, `${label}.variantId`);
  assertImmutableReference(reference.manifest, `${label}.manifest`);
  assertImmutableReference(reference.archive, `${label}.archive`);
};

export const assertReleasePackageIndex = (
  index,
  { expectedBuildPurpose = "production" } = {},
) => {
  const packageSpecificKeys =
    index?.packageKind === "source-hardened-pair"
      ? ["artifacts"]
      : index?.packageKind === "legacy-bootstrap-single"
        ? ["bootstrapInput", "rawDistManifest", "artifact"]
        : [];
  assertExactKeys(
    index,
    [...COMMON_INDEX_KEYS, ...packageSpecificKeys],
    "ReleasePackageIndex",
  );
  if (index.schemaVersion !== 1) {
    throw new Error("ReleasePackageIndex schemaVersion must be 1");
  }
  assertSourceSha(index.sourceSha, "ReleasePackageIndex.sourceSha");
  assertSourceSha(index.buildId, "ReleasePackageIndex.buildId");
  if (index.sourceSha !== index.buildId) {
    throw new Error("ReleasePackageIndex buildId must equal sourceSha");
  }
  for (const field of [
    "toolchainPolicyHash",
    "providerConfigurationHash",
    "providerPolicyHash",
    "releasePolicyHash",
  ]) {
    assertSha256(index[field], `ReleasePackageIndex.${field}`);
  }
  assertDbCompatibilityBinding(
    index.requiredDbCompatibility,
    "ReleasePackageIndex.requiredDbCompatibility",
  );
  assertArtifactBuildAuthority(index, {
    bootstrap: index.packageKind === "legacy-bootstrap-single",
    expectedBuildPurpose,
    label: "ReleasePackageIndex",
  });
  if (index.packageKind === "source-hardened-pair") {
    if (!Array.isArray(index.artifacts) || index.artifacts.length !== 2) {
      throw new Error("Source-hardened package requires exactly two artifacts");
    }
    assertArtifactReference(index.artifacts[0], "standard", "artifacts[0]");
    assertArtifactReference(index.artifacts[1], "containment", "artifacts[1]");
  } else if (index.packageKind === "legacy-bootstrap-single") {
    assertImmutableReference(index.bootstrapInput, "bootstrapInput");
    assertImmutableReference(index.rawDistManifest, "rawDistManifest");
    assertArtifactReference(index.artifact, "containment", "artifact");
  } else {
    throw new Error("ReleasePackageIndex packageKind is invalid");
  }
  return index;
};

const BOOTSTRAP_INPUT_KEYS = Object.freeze([
  "schemaVersion",
  "sourceSha",
  "nodeVersion",
  "npmVersion",
  "lockfileSha256",
  "rawDistManifest",
  "metricsDisabledTemplateSha256",
  "apiNotFoundTemplateSha256",
  "stagingVerifierSha256",
  "generatedPackageSha256",
  "generatedLockfileSha256",
  "generatedVercelConfigSha256",
  "providerProjectId",
  "providerConfigurationHash",
]);

export const assertBootstrapInput = (input) => {
  assertExactKeys(input, BOOTSTRAP_INPUT_KEYS, "BootstrapInput");
  if (input.schemaVersion !== 1) {
    throw new Error("BootstrapInput schemaVersion must be 1");
  }
  assertSourceSha(input.sourceSha, "BootstrapInput.sourceSha");
  if (
    typeof input.nodeVersion !== "string" ||
    !SEMVER_PATTERN.test(input.nodeVersion)
  ) {
    throw new Error("BootstrapInput.nodeVersion is invalid");
  }
  if (
    typeof input.npmVersion !== "string" ||
    !SEMVER_PATTERN.test(input.npmVersion) ||
    input.npmVersion.startsWith("v")
  ) {
    throw new Error("BootstrapInput.npmVersion is invalid");
  }
  for (const field of [
    "lockfileSha256",
    "metricsDisabledTemplateSha256",
    "apiNotFoundTemplateSha256",
    "stagingVerifierSha256",
    "generatedPackageSha256",
    "generatedLockfileSha256",
    "generatedVercelConfigSha256",
    "providerConfigurationHash",
  ]) {
    assertSha256(input[field], `BootstrapInput.${field}`);
  }
  assertImmutableReference(input.rawDistManifest, "rawDistManifest");
  assertNoPlaceholder(
    input.providerProjectId,
    "BootstrapInput.providerProjectId",
  );
  return input;
};

export const assertReleaseIdentity = (
  identity,
  { manifest, outputFilesByPath, expectedBuildPurpose = "production" },
) => {
  assertRecord(identity, "ReleaseIdentity");
  const buildPurposeKeys = assertBuildPurposeMarker(
    identity,
    expectedBuildPurpose,
    "ReleaseIdentity",
  );
  const lifecycle = identity.pwaLifecycle;
  const lifecycleKeys =
    lifecycle === "legacy-auto-update-v1"
      ? [
          "appEntryUrl",
          "appEntrySha256",
          "serviceWorkerUrl",
          "serviceWorkerSha256",
        ]
      : lifecycle === "prompt-close-all-v1"
        ? [
            "roleEntryUrl",
            "roleEntrySha256",
            "serviceWorkerUrl",
            "serviceWorkerSha256",
            "outerAgentUrl",
            "outerAgentSha256",
          ]
        : null;
  if (lifecycleKeys === null) {
    throw new Error("ReleaseIdentity pwaLifecycle is invalid");
  }
  assertExactKeys(
    identity,
    [
      "schemaVersion",
      "sourceSha",
      "buildId",
      "variantId",
      "releaseRole",
      "requiredDbCompatibilityFingerprint",
      ...buildPurposeKeys,
      "pwaLifecycle",
      ...lifecycleKeys,
    ],
    "ReleaseIdentity",
  );
  if (
    identity.schemaVersion !== 1 ||
    identity.sourceSha !== manifest.sourceSha ||
    identity.buildId !== manifest.buildId ||
    identity.variantId !== manifest.variantId ||
    identity.releaseRole !== manifest.releaseRole ||
    identity.requiredDbCompatibilityFingerprint !==
      manifest.requiredDbCompatibility.fingerprint ||
    identity.pwaLifecycle !== manifest.dimensions.pwaLifecycle
  ) {
    throw new Error("ReleaseIdentity differs from ArtifactManifest");
  }
  for (const key of lifecycleKeys) {
    if (key.endsWith("Url")) {
      const publicPath = identity[key];
      if (!isPublicPath(publicPath)) {
        throw new Error(`ReleaseIdentity.${key} is invalid`);
      }
      const filePath = publicPathToOutputPath(publicPath);
      const outputFile = outputFilesByPath.get(filePath);
      const hashKey = `${key.slice(0, -"Url".length)}Sha256`;
      if (!outputFile || outputFile.sha256 !== identity[hashKey]) {
        throw new Error(`ReleaseIdentity ${key}/${hashKey} is not in output`);
      }
    } else {
      assertSha256(identity[key], `ReleaseIdentity.${key}`);
    }
  }
  return identity;
};

export const publicPathToOutputPath = (publicPath) => {
  if (!isPublicPath(publicPath)) {
    throw new Error(`Invalid public response path: ${publicPath}`);
  }
  return publicPath === "/"
    ? "static/index.html"
    : `static/${publicPath.slice(1)}`;
};

export const buildPublicResponseHashes = async (outputRoot, publicPaths) => {
  const sortedPaths = [...new Set(publicPaths)].sort(compareUtf8);
  const entries = await Promise.all(
    sortedPaths.map(async (publicPath) => {
      const bytes = await readFile(
        path.join(outputRoot, ...publicPathToOutputPath(publicPath).split("/")),
      );
      return [publicPath, sha256Bytes(bytes)];
    }),
  );
  return Object.fromEntries(entries);
};

export const readAndVerifyRoleEntryGraph = async ({ outputRoot, manifest }) => {
  const graph = assertRoleEntryGraph(manifest.roleEntryGraph, manifest);
  if (graph.graphKind === "rollup-role-entry-v1") {
    const graphPath = path.join(
      outputRoot,
      "static",
      "release-role-graph.json",
    );
    const graphBytes = await readFile(graphPath);
    const outputGraph = parseJsonStrict(
      graphBytes.toString("utf8"),
      "release-role-graph.json",
    );
    if (
      !graphBytes.equals(canonicalJsonBytes(outputGraph)) ||
      !canonicalJsonBytes(outputGraph).equals(canonicalJsonBytes(graph))
    ) {
      throw new Error(
        "Built role entry graph differs from the canonical ArtifactManifest graph",
      );
    }
    if (
      manifest.publicResponseHashes["/release-role-graph.json"] !==
      sha256Bytes(graphBytes)
    ) {
      throw new Error("Role entry graph public response hash differs");
    }
  }
  for (const chunk of graph.chunks) {
    const bytes = await readFile(
      path.join(outputRoot, ...publicPathToOutputPath(chunk.file).split("/")),
    );
    if (bytes.length !== chunk.size || sha256Bytes(bytes) !== chunk.sha256) {
      throw new Error(`Role entry graph chunk bytes differ: ${chunk.file}`);
    }
  }
  return graph;
};

export const readAndVerifyOuterAgentGraph = async ({
  outputRoot,
  manifest,
}) => {
  if (manifest.publicIdentityKind !== "release-identity-v1") {
    if (
      manifest.publicResponseHashes[OUTER_AGENT_URL] !== undefined ||
      manifest.publicResponseHashes[OUTER_AGENT_GRAPH_URL] !== undefined
    ) {
      throw new Error(
        "Legacy bootstrap must not bind an independent outer agent",
      );
    }
    return null;
  }
  const [outerAgentBytes, graphBytes] = await Promise.all([
    readFile(
      path.join(
        outputRoot,
        ...publicPathToOutputPath(OUTER_AGENT_URL).split("/"),
      ),
    ),
    readFile(
      path.join(
        outputRoot,
        ...publicPathToOutputPath(OUTER_AGENT_GRAPH_URL).split("/"),
      ),
    ),
  ]);
  const graph = parseIndependentOuterAgentGraph({
    graphBytes,
    sourceSha: manifest.sourceSha,
    outerAgentBytes,
  });
  if (
    manifest.publicResponseHashes[OUTER_AGENT_URL] !==
      sha256Bytes(outerAgentBytes) ||
    manifest.publicResponseHashes[OUTER_AGENT_GRAPH_URL] !==
      sha256Bytes(graphBytes)
  ) {
    throw new Error("Independent outer agent public response binding differs");
  }
  return { graph, graphBytes, outerAgentBytes };
};

export const readAndVerifyPublicIdentity = async ({
  outputRoot,
  manifest,
  expectedBuildPurpose = "production",
}) => {
  const stablePath = path.join(outputRoot, "static", "release-identity.json");
  const versionedRelativePath = `release-identity.${manifest.sourceSha}.${manifest.variantId}.json`;
  const versionedPath = path.join(outputRoot, "static", versionedRelativePath);
  const [stableBytes, versionedBytes] = await Promise.all([
    readFile(stablePath),
    readFile(versionedPath),
  ]);
  if (!stableBytes.equals(versionedBytes)) {
    throw new Error("Stable and versioned release identity bytes differ");
  }
  const identity = parseJsonStrict(
    stableBytes.toString("utf8"),
    "release-identity.json",
  );
  const outputFilesByPath = new Map(
    manifest.outputFiles.map((file) => [file.path, file]),
  );
  assertReleaseIdentity(identity, {
    manifest,
    outputFilesByPath,
    expectedBuildPurpose,
  });
  for (const publicPath of [
    "/release-identity.json",
    `/${versionedRelativePath}`,
  ]) {
    const expected = sha256Bytes(stableBytes);
    if (manifest.publicResponseHashes[publicPath] !== expected) {
      throw new Error(`Manifest response hash differs for ${publicPath}`);
    }
  }
  return { identity, bytes: stableBytes };
};

const parseCapability = (
  bytes,
  source,
  expectedBuildPurpose = "production",
) => {
  const capability = parseJsonStrict(bytes.toString("utf8"), source);
  assertRecord(capability, source);
  assertBuildPurposeMarker(capability, expectedBuildPurpose, source);
  if (
    capability.kind !== "event-shopping-planner-release-capabilities" ||
    capability.version !== 1 ||
    capability.releaseChannel !== "release-a" ||
    capability.legacyLocalStorageCleanup !== "forced-off"
  ) {
    throw new Error(`${source} violates the frozen Release A capability`);
  }
  return capability;
};

export const readAndVerifyCapability = async ({
  outputRoot,
  manifest,
  expectedBuildPurpose = "production",
}) => {
  const stablePath = path.join(
    outputRoot,
    "static",
    "release-capabilities.json",
  );
  const versionedPath = path.join(
    outputRoot,
    "static",
    `release-capabilities.${manifest.sourceSha}.json`,
  );
  const [stableBytes, versionedBytes] = await Promise.all([
    readFile(stablePath),
    readFile(versionedPath),
  ]);
  if (!stableBytes.equals(versionedBytes)) {
    throw new Error("Stable and source-addressed capability bytes differ");
  }
  const capability = parseCapability(
    stableBytes,
    "release capability",
    expectedBuildPurpose,
  );
  if (
    capability.buildId !== manifest.buildId ||
    capability.sourceSha !== manifest.sourceSha ||
    capability.sourceState !== "clean"
  ) {
    throw new Error("Release capability source identity is invalid");
  }
  return { capability, bytes: stableBytes };
};

export const assertManifestMatchesOutput = async (outputRoot, manifest) => {
  const actual = await buildFileManifest(outputRoot);
  assertFileManifestEqual(actual, manifest.outputFiles, "artifact output");
  return actual;
};

export const assertPairRelationship = ({
  index,
  standardManifest,
  containmentManifest,
  releasePolicy,
}) => {
  const commonFields = [
    "sourceSha",
    "buildId",
    "buildInputClosureHash",
    "lockfileSha256",
    "toolchainPolicyHash",
    "publicBuildEnvHash",
    "providerConfigurationHash",
    "providerPolicyHash",
    "releasePolicyHash",
    "targetGate",
    "buildPurpose",
    "promotable",
  ];
  for (const field of commonFields) {
    if (standardManifest[field] !== containmentManifest[field]) {
      throw new Error(`Artifact pair differs at ${field}`);
    }
  }
  if (
    canonicalJsonBytes(standardManifest.buildAuthority).compare(
      canonicalJsonBytes(containmentManifest.buildAuthority),
    ) !== 0
  ) {
    throw new Error("Artifact pair build authority differs");
  }
  if (
    canonicalJsonBytes(standardManifest.requiredDbCompatibility).compare(
      canonicalJsonBytes(containmentManifest.requiredDbCompatibility),
    ) !== 0
  ) {
    throw new Error("Artifact pair DB compatibility differs");
  }
  const projected = projectContainmentDimensions(
    releasePolicy,
    standardManifest.dimensions,
  );
  for (const key of RELEASE_DIMENSION_KEYS) {
    if (containmentManifest.dimensions[key] !== projected[key]) {
      throw new Error(`Containment projection differs at ${key}`);
    }
  }
  const indexCommonFields = [
    "sourceSha",
    "buildId",
    "toolchainPolicyHash",
    "providerConfigurationHash",
    "providerPolicyHash",
    "releasePolicyHash",
    "targetGate",
    "buildPurpose",
    "promotable",
  ];
  for (const field of indexCommonFields) {
    if (index[field] !== standardManifest[field]) {
      throw new Error(`Package index differs from manifests at ${field}`);
    }
  }
  if (
    canonicalJsonBytes(index.buildAuthority).compare(
      canonicalJsonBytes(standardManifest.buildAuthority),
    ) !== 0
  ) {
    throw new Error("Package index build authority differs from manifests");
  }
  if (
    canonicalJsonBytes(index.requiredDbCompatibility).compare(
      canonicalJsonBytes(standardManifest.requiredDbCompatibility),
    ) !== 0
  ) {
    throw new Error("Package index DB compatibility differs");
  }
  if (
    index.artifacts[0].variantId !== standardManifest.variantId ||
    index.artifacts[1].variantId !== containmentManifest.variantId
  ) {
    throw new Error("Package artifact variant reference differs");
  }
  if (
    standardManifest.publicResponseHashes[OUTER_AGENT_URL] === undefined ||
    standardManifest.publicResponseHashes[OUTER_AGENT_GRAPH_URL] ===
      undefined ||
    standardManifest.publicResponseHashes[OUTER_AGENT_URL] !==
      containmentManifest.publicResponseHashes[OUTER_AGENT_URL] ||
    standardManifest.publicResponseHashes[OUTER_AGENT_GRAPH_URL] !==
      containmentManifest.publicResponseHashes[OUTER_AGENT_GRAPH_URL]
  ) {
    throw new Error(
      "Artifact pair independent outer agent bytes or closure graph differ",
    );
  }
};

export const assertBootstrapRelationship = ({
  index,
  manifest,
  bootstrapInput,
}) => {
  for (const field of [
    "sourceSha",
    "buildId",
    "toolchainPolicyHash",
    "providerConfigurationHash",
    "providerPolicyHash",
    "releasePolicyHash",
    "targetGate",
    "buildPurpose",
    "promotable",
  ]) {
    if (index[field] !== manifest[field]) {
      throw new Error(`Bootstrap package index differs at ${field}`);
    }
  }
  if (
    canonicalJsonBytes(index.buildAuthority).compare(
      canonicalJsonBytes(manifest.buildAuthority),
    ) !== 0
  ) {
    throw new Error("Bootstrap package build authority differs");
  }
  if (
    canonicalJsonBytes(index.requiredDbCompatibility).compare(
      canonicalJsonBytes(manifest.requiredDbCompatibility),
    ) !== 0
  ) {
    throw new Error("Bootstrap package DB compatibility differs");
  }
  if (
    index.sourceSha !== bootstrapInput.sourceSha ||
    index.providerConfigurationHash !== bootstrapInput.providerConfigurationHash
  ) {
    throw new Error("Bootstrap input differs from package identity");
  }
  if (
    index.bootstrapInput.sha256 !== manifest.bootstrap.inputSha256 ||
    index.bootstrapInput.uri !== manifest.bootstrap.inputUri ||
    index.rawDistManifest.sha256 !== manifest.bootstrap.rawDistManifestSha256 ||
    index.rawDistManifest.uri !== manifest.bootstrap.rawDistManifestUri ||
    bootstrapInput.rawDistManifest.sha256 !== index.rawDistManifest.sha256 ||
    bootstrapInput.rawDistManifest.uri !== index.rawDistManifest.uri
  ) {
    throw new Error("Bootstrap immutable object references differ");
  }
  if (
    index.artifact.variantId !== manifest.variantId ||
    index.artifact.releaseRole !== "containment"
  ) {
    throw new Error("Bootstrap artifact reference differs");
  }
};

export const canonicalArtifactBytes = (value) => canonicalJsonBytes(value);

export const artifactManifestHash = (manifest) =>
  sha256Bytes(canonicalArtifactBytes(manifest));
