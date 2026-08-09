import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyCspDeliveryToVercelOutput,
  assertNoPythonBuildTriggers,
  assertVercelOutputShape,
  buildBootstrapGeneratedFiles,
  buildRawDistManifest,
  buildReleaseContext,
  createArtifactManifestFromOutput,
  createBootstrapInput,
  createBootstrapStaging,
  assertIndependentBuildReproducibility,
  writeVerifiedArtifactObjects,
} from "./lib/artifact-builder-core.mjs";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "./lib/release-policy.mjs";
import {
  assertArtifactManifest,
  assertPairRelationship,
  assertReleasePackageIndex,
  assertRoleEntryGraph,
  computeRoleEntryGraphHash,
  publicPathToOutputPath,
} from "./lib/artifact-contract.mjs";
import { POLICY_ACTIVATION_QA_BUILD_PURPOSE } from "./lib/release-build-input.mjs";
import {
  OUTER_AGENT_ENTRY_MODULE,
  OUTER_AGENT_GRAPH_URL,
  OUTER_AGENT_URL,
} from "./lib/outer-agent-contract.mjs";
import {
  contentAddressedObjectPath,
  contentAddressedUri,
  parseContentAddressedUri,
  resolveContentAddressedObject,
  writeContentAddressedObject,
} from "./lib/content-addressed-store.mjs";
import {
  cspReportSinkContract,
  renderCspHeaders,
} from "./lib/csp-delivery.mjs";
import { verifyReleasePackage } from "./verify-release-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fixtureApplicationStylesheet = Buffer.from(
  "#loading-screen{display:flex}#loading-screen.hidden{display:none;visibility:hidden}\n",
  "utf8",
);

const createFixtureOuterAgent = (sourceSha) => {
  const outerAgentBytes = Buffer.from(
    "export const outerRecoveryAgent = true;\n",
    "utf8",
  );
  const graph = {
    schemaVersion: 1,
    graphKind: "single-entry-outer-agent-v1",
    sourceSha,
    entryModule: OUTER_AGENT_ENTRY_MODULE,
    entryFile: OUTER_AGENT_URL,
    modules: [
      {
        id: OUTER_AGENT_ENTRY_MODULE,
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: OUTER_AGENT_URL,
        sha256: sha256Bytes(outerAgentBytes),
        size: outerAgentBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: [OUTER_AGENT_ENTRY_MODULE],
      },
    ],
  };
  return {
    graph,
    graphBytes: canonicalJsonBytes(graph),
    outerAgentBytes,
  };
};

const loadFixtureContext = async () => {
  const [
    fixture,
    releasePolicy,
    toolchainPolicy,
    baseProviderPolicy,
    dbContract,
    cspPolicy,
  ] = await Promise.all([
    readJsonStrict(
      path.join(
        root,
        "scripts",
        "fixtures",
        "artifact",
        "release-package.fixture.json",
      ),
    ),
    readJsonStrict(path.join(root, "config", "release-variants.json")),
    readJsonStrict(path.join(root, "config", "toolchain-versions.json")),
    readJsonStrict(path.join(root, "config", "provider-policy.json")),
    readJsonStrict(path.join(root, "config", "db-compatibility-contract.json")),
    readJsonStrict(path.join(root, "config", "csp-policy.json")),
  ]);
  const providerPolicy = {
    ...baseProviderPolicy,
    ...fixture.providerPolicy,
    providerNodeFamily: "24.x",
    blockerCodes: ["fixture-only-do-not-promote"],
  };
  const providerObservation = {
    ...fixture.providerObservation,
    presentEnvironmentNames: [...providerPolicy.requiredEnvironmentNames],
    wafRules: providerPolicy.wafRules,
    logPolicy: providerPolicy.logPolicy,
  };
  const releaseContext = buildReleaseContext({
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    requireProductionBindings: false,
  });
  return {
    fixture,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    cspPolicy,
    releaseContext,
    archivePolicy: await readJsonStrict(
      path.join(root, "config", "artifact-archive-policy.json"),
    ),
  };
};

const writeBytes = async (base, relativePath, bytes) => {
  const target = path.join(base, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
};

const buildCapabilityBytes = (sourceSha, buildPurpose = "production") =>
  canonicalJsonBytes({
    kind: "event-shopping-planner-release-capabilities",
    version: 1,
    buildMode: "release-a",
    buildId: sourceSha,
    sourceSha,
    sourceState: "clean",
    releaseChannel: "release-a",
    legacyLocalStorageCleanup: "forced-off",
    ...(buildPurpose === "production"
      ? {}
      : { buildPurpose, nonPromotable: true }),
  });

const buildAuthority = (seed = "fixture-build-authority") => {
  const sha256 = sha256Json({ seed });
  return {
    uri: `release-state://foundation-fixture/evidence/${sha256}`,
    sha256,
  };
};

const createVercelOutputBase = async ({
  outputRoot,
  sourceSha,
  capabilityBytes,
  cspPolicy,
  cspMode = "enforced",
  sourceHardened = true,
}) => {
  const securityHeaders = sourceHardened
    ? renderCspHeaders({ cspMode, cspPolicy })
    : {};
  const reportSink = sourceHardened
    ? cspReportSinkContract({ cspMode, cspPolicy })
    : { enabled: false };
  const configBytes = canonicalJsonBytes({
    version: 3,
    routes: [
      ...(sourceHardened
        ? [
            {
              src: "^/sw\\.js$",
              headers: {
                "Cache-Control": "public, max-age=0, must-revalidate",
              },
              continue: true,
            },
            {
              src: "^/release-identity\\.json$",
              headers: { "Cache-Control": "private, no-store" },
              continue: true,
            },
            {
              src: "^/release-identity\\.[a-f0-9]{40}\\.[a-f0-9]{64}\\.json$",
              headers: {
                "Cache-Control": "public, max-age=31536000, immutable",
              },
              continue: true,
            },
            {
              src: "^/.*$",
              headers: securityHeaders,
              continue: true,
            },
          ]
        : []),
      { handle: "filesystem" },
      {
        src: "^/api(?:/.*)?$",
        dest: "/api/not-found",
      },
      { src: "^/(?!api(?:/|$)).*$", dest: "/index.html" },
    ],
  });
  const functionConfigBytes = canonicalJsonBytes({
    runtime: "nodejs24.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
  });
  await Promise.all([
    writeBytes(outputRoot, "config.json", configBytes),
    writeBytes(
      outputRoot,
      "functions/api/not-found.func/index.mjs",
      Buffer.from("export default()=>new Response('{}',{status:404});\n"),
    ),
    writeBytes(
      outputRoot,
      "functions/api/not-found.func/.vc-config.json",
      functionConfigBytes,
    ),
    writeBytes(
      outputRoot,
      "functions/api/persistence-release-a-metrics.func/index.mjs",
      Buffer.from("export default()=>new Response('{}',{status:503});\n"),
    ),
    writeBytes(
      outputRoot,
      "functions/api/persistence-release-a-metrics.func/.vc-config.json",
      functionConfigBytes,
    ),
    ...(sourceHardened
      ? [
          ...(reportSink.enabled
            ? [
                writeBytes(
                  outputRoot,
                  "functions/api/csp-report.func/index.mjs",
                  Buffer.from(
                    "export default()=>new Response(null,{status:204});\n",
                  ),
                ),
                writeBytes(
                  outputRoot,
                  "functions/api/csp-report.func/.vc-config.json",
                  functionConfigBytes,
                ),
              ]
            : []),
          writeBytes(
            outputRoot,
            "functions/api/google-sheets-csv.func/index.mjs",
            Buffer.from(
              "export default()=>new Response('csv',{status:200});\n",
            ),
          ),
          writeBytes(
            outputRoot,
            "functions/api/google-sheets-csv.func/.vc-config.json",
            functionConfigBytes,
          ),
        ]
      : []),
    writeBytes(
      outputRoot,
      "static/index.html",
      Buffer.from(
        sourceHardened
          ? '<!doctype html><html><head><link rel="stylesheet" href="/assets/app-fixture.css" /></head><body>fixture</body></html>\n'
          : "<!doctype html><html><body>fixture</body></html>\n",
      ),
    ),
    ...(sourceHardened
      ? [
          writeBytes(
            outputRoot,
            "static/assets/app-fixture.css",
            fixtureApplicationStylesheet,
          ),
        ]
      : []),
    writeBytes(outputRoot, "static/release-capabilities.json", capabilityBytes),
    writeBytes(
      outputRoot,
      `static/release-capabilities.${sourceSha}.json`,
      capabilityBytes,
    ),
    writeBytes(
      outputRoot,
      "static/sw.js",
      Buffer.from("self.addEventListener('fetch',()=>{});\n"),
    ),
  ]);
};

const createRoleOutput = async ({
  outputRoot,
  sourceSha,
  dimensions,
  releasePolicy,
  requiredDbCompatibility,
  capabilityBytes,
  cspPolicy,
  buildPurpose = "production",
}) => {
  await createVercelOutputBase({
    outputRoot,
    sourceSha,
    capabilityBytes,
    cspPolicy,
    cspMode: dimensions.cspMode,
  });
  const roleEntryBytes = Buffer.from(
    `globalThis.__fixtureRole=${JSON.stringify(dimensions.releaseRole)};\n`,
  );
  const outerAgent = createFixtureOuterAgent(sourceSha);
  await Promise.all([
    writeBytes(outputRoot, "static/assets/release-role.js", roleEntryBytes),
    writeBytes(
      outputRoot,
      `static${OUTER_AGENT_URL}`,
      outerAgent.outerAgentBytes,
    ),
    writeBytes(
      outputRoot,
      `static${OUTER_AGENT_GRAPH_URL}`,
      outerAgent.graphBytes,
    ),
  ]);
  const swBytes = await readFile(path.join(outputRoot, "static", "sw.js"));
  const variantId = computeVariantId(releasePolicy, dimensions);
  const identity = {
    schemaVersion: 1,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole: dimensions.releaseRole,
    requiredDbCompatibilityFingerprint: requiredDbCompatibility.fingerprint,
    ...(buildPurpose === "production"
      ? {}
      : { buildPurpose, nonPromotable: true }),
    pwaLifecycle: "legacy-auto-update-v1",
    appEntryUrl: "/assets/release-role.js",
    appEntrySha256: sha256Bytes(roleEntryBytes),
    serviceWorkerUrl: "/sw.js",
    serviceWorkerSha256: sha256Bytes(swBytes),
  };
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha,
    releaseRole: dimensions.releaseRole,
    variantId,
    entryModule: "fixture/release-role.js",
    entryFile: "/assets/release-role.js",
    modules: [
      {
        id: "fixture/release-role.js",
        external: false,
        staticImports: [],
        dynamicImports: [],
      },
    ],
    chunks: [
      {
        file: "/assets/release-role.js",
        sha256: sha256Bytes(roleEntryBytes),
        size: roleEntryBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: ["fixture/release-role.js"],
      },
    ],
  };
  const identityBytes = canonicalJsonBytes(identity);
  await Promise.all([
    writeBytes(outputRoot, "static/release-identity.json", identityBytes),
    writeBytes(
      outputRoot,
      `static/release-identity.${sourceSha}.${variantId}.json`,
      identityBytes,
    ),
    writeBytes(
      outputRoot,
      "static/release-role-graph.json",
      canonicalJsonBytes(roleEntryGraph),
    ),
  ]);
};

const createSourceHardenedFixturePackage = async (temporaryRoot, context) => {
  const packageRoot = path.join(temporaryRoot, "pair-package");
  const scratchRoot = path.join(temporaryRoot, "pair-scratch");
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
  ]);
  const sourceSha = context.fixture.sourceSha;
  const standardDimensions = { ...context.releasePolicy.initialStandard };
  const containmentDimensions = projectContainmentDimensions(
    context.releasePolicy,
    standardDimensions,
  );
  const capabilityBytes = buildCapabilityBytes(sourceSha);
  const authority = buildAuthority("source-hardened-pair");
  const artifactReferences = [];
  for (const dimensions of [standardDimensions, containmentDimensions]) {
    const outputRoot = path.join(
      temporaryRoot,
      `pair-${dimensions.releaseRole}`,
    );
    await createRoleOutput({
      outputRoot,
      sourceSha,
      dimensions,
      releasePolicy: context.releasePolicy,
      requiredDbCompatibility: context.releaseContext.requiredDbCompatibility,
      capabilityBytes,
      cspPolicy: context.cspPolicy,
    });
    const manifest = await createArtifactManifestFromOutput({
      outputRoot,
      releasePolicy: context.releasePolicy,
      sourceSha,
      dimensions,
      buildInputClosureHash: sha256Json({ fixture: "build-input" }),
      lockfileSha256: sha256Json({ fixture: "lockfile" }),
      releaseContext: context.releaseContext,
      publicBuildEnvHash: sha256Json({ schemaVersion: 1, values: {} }),
      publicIdentityKind: "release-identity-v1",
      bootstrap: null,
      buildAuthority: authority,
      targetGate: "P0-RELEASE",
      cspPolicy: context.cspPolicy,
    });
    artifactReferences.push(
      await writeVerifiedArtifactObjects({
        packageRoot,
        outputRoot,
        manifest,
        archivePolicy: context.archivePolicy,
        scratchRoot,
        objectLabel: dimensions.releaseRole,
      }),
    );
  }
  const index = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha,
    buildId: sourceSha,
    buildAuthority: authority,
    targetGate: "P0-RELEASE",
    buildPurpose: "production",
    promotable: true,
    toolchainPolicyHash: context.releaseContext.toolchainPolicyHash,
    providerConfigurationHash: context.releaseContext.providerConfigurationHash,
    providerPolicyHash: context.releaseContext.providerPolicyHash,
    releasePolicyHash: context.releaseContext.releasePolicyHash,
    requiredDbCompatibility: context.releaseContext.requiredDbCompatibility,
    artifacts: artifactReferences,
  };
  await writeFile(
    path.join(packageRoot, "release-package-index.json"),
    canonicalJsonBytes(index),
    { flag: "wx" },
  );
  return { packageRoot, index };
};

const createBootstrapFixturePackage = async (temporaryRoot, context) => {
  const packageRoot = path.join(temporaryRoot, "bootstrap-package");
  const scratchRoot = path.join(temporaryRoot, "bootstrap-scratch");
  const rawDistRoot = path.join(temporaryRoot, "raw-dist");
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
    mkdir(rawDistRoot, { recursive: true }),
  ]);
  const sourceSha = context.fixture.sourceSha;
  const capabilityBytes = buildCapabilityBytes(sourceSha);
  await Promise.all([
    writeBytes(
      rawDistRoot,
      "index.html",
      Buffer.from("<!doctype html><html><body>fixture</body></html>\n"),
    ),
    writeBytes(rawDistRoot, "release-capabilities.json", capabilityBytes),
    writeBytes(
      rawDistRoot,
      `release-capabilities.${sourceSha}.json`,
      capabilityBytes,
    ),
    writeBytes(
      rawDistRoot,
      "sw.js",
      Buffer.from("self.addEventListener('fetch',()=>{});\n"),
    ),
  ]);
  const rawDistManifest = await buildRawDistManifest(rawDistRoot);
  const rawDistReference = await writeContentAddressedObject({
    packageRoot,
    bytes: canonicalJsonBytes(rawDistManifest),
    kind: "raw-dist-manifest.json",
  });
  const [metricsBytes, notFoundBytes, verifierBytes] = await Promise.all([
    readFile(
      path.join(root, "scripts", "templates", "bootstrap-metrics-disabled.mjs"),
    ),
    readFile(
      path.join(root, "scripts", "templates", "bootstrap-api-not-found.mjs"),
    ),
    readFile(path.join(root, "scripts", "verify-bootstrap-staging.mjs")),
  ]);
  const generatedFiles = buildBootstrapGeneratedFiles("24.x", {
    metricsTemplateSha256: sha256Bytes(metricsBytes),
    notFoundTemplateSha256: sha256Bytes(notFoundBytes),
  });
  const bootstrapInput = createBootstrapInput({
    sourceSha,
    nodeVersion: "v20.20.0",
    npmVersion: "10.8.2",
    lockfileSha256: sha256Json({ fixture: "baseline-lock" }),
    rawDistManifestReference: rawDistReference,
    metricsDisabledTemplateBytes: metricsBytes,
    apiNotFoundTemplateBytes: notFoundBytes,
    stagingVerifierBytes: verifierBytes,
    generatedFiles,
    providerProjectId: context.fixture.providerObservation.providerProjectId,
    providerConfigurationHash: context.releaseContext.providerConfigurationHash,
  });
  const bootstrapInputReference = await writeContentAddressedObject({
    packageRoot,
    bytes: canonicalJsonBytes(bootstrapInput),
    kind: "bootstrap-input.json",
  });
  const stagingRoot = path.join(temporaryRoot, "bootstrap-staging");
  await createBootstrapStaging({
    stagingRoot,
    rawDistRoot,
    metricsDisabledTemplateBytes: metricsBytes,
    apiNotFoundTemplateBytes: notFoundBytes,
    stagingVerifierBytes: verifierBytes,
    generatedFiles,
  });
  const rawManifestPath = path.join(temporaryRoot, "raw-dist-manifest.json");
  await writeFile(rawManifestPath, canonicalJsonBytes(rawDistManifest), {
    flag: "wx",
  });
  execFileSync(
    process.execPath,
    [
      path.join(stagingRoot, "scripts", "verify-bootstrap-staging.mjs"),
      "--root",
      stagingRoot,
      "--raw-dist-manifest",
      rawManifestPath,
      "--metrics-template-sha256",
      bootstrapInput.metricsDisabledTemplateSha256,
      "--not-found-template-sha256",
      bootstrapInput.apiNotFoundTemplateSha256,
    ],
    { cwd: stagingRoot, stdio: "pipe" },
  );
  const outputRoot = path.join(temporaryRoot, "bootstrap-output");
  await createVercelOutputBase({
    outputRoot,
    sourceSha,
    capabilityBytes,
    cspPolicy: context.cspPolicy,
    sourceHardened: false,
  });
  const containmentDimensions = projectContainmentDimensions(
    context.releasePolicy,
    context.releasePolicy.initialStandard,
  );
  const manifest = await createArtifactManifestFromOutput({
    outputRoot,
    releasePolicy: context.releasePolicy,
    sourceSha,
    dimensions: containmentDimensions,
    buildInputClosureHash: sha256Json({
      fixture: "bootstrap-input",
      bootstrapInputSha256: bootstrapInputReference.sha256,
    }),
    lockfileSha256: bootstrapInput.lockfileSha256,
    releaseContext: context.releaseContext,
    publicBuildEnvHash: sha256Json({ schemaVersion: 1, values: {} }),
    publicIdentityKind: "legacy-bootstrap-v1",
    bootstrap: {
      inputUri: bootstrapInputReference.uri,
      inputSha256: bootstrapInputReference.sha256,
      rawDistManifestUri: rawDistReference.uri,
      rawDistManifestSha256: rawDistReference.sha256,
    },
  });
  const artifactReference = await writeVerifiedArtifactObjects({
    packageRoot,
    outputRoot,
    manifest,
    archivePolicy: context.archivePolicy,
    scratchRoot,
    objectLabel: "bootstrap",
  });
  const index = {
    schemaVersion: 1,
    packageKind: "legacy-bootstrap-single",
    sourceSha,
    buildId: sourceSha,
    buildAuthority: null,
    targetGate: null,
    buildPurpose: "legacy-bootstrap",
    promotable: false,
    toolchainPolicyHash: context.releaseContext.toolchainPolicyHash,
    providerConfigurationHash: context.releaseContext.providerConfigurationHash,
    providerPolicyHash: context.releaseContext.providerPolicyHash,
    releasePolicyHash: context.releaseContext.releasePolicyHash,
    requiredDbCompatibility: context.releaseContext.requiredDbCompatibility,
    bootstrapInput: {
      uri: bootstrapInputReference.uri,
      sha256: bootstrapInputReference.sha256,
    },
    rawDistManifest: {
      uri: rawDistReference.uri,
      sha256: rawDistReference.sha256,
    },
    artifact: artifactReference,
  };
  await writeFile(
    path.join(packageRoot, "release-package-index.json"),
    canonicalJsonBytes(index),
    { flag: "wx" },
  );
  return { packageRoot, index, manifest };
};

const verificationArguments = (context, packageRoot) => ({
  packageRoot,
  releasePolicy: context.releasePolicy,
  toolchainPolicy: context.toolchainPolicy,
  providerPolicy: context.providerPolicy,
  providerObservation: context.providerObservation,
  dbContract: context.dbContract,
  cspPolicy: context.cspPolicy,
  requireProductionBindings: false,
  root,
  environment: {},
});

const createContractFixture = (context) => {
  const sourceSha = context.fixture.sourceSha;
  const dimensions = { ...context.releasePolicy.initialStandard };
  const variantId = computeVariantId(context.releasePolicy, dimensions);
  const chunkHash = sha256Bytes(Buffer.from("fixture"));
  const outerAgent = createFixtureOuterAgent(sourceSha);
  const outerAgentHash = sha256Bytes(outerAgent.outerAgentBytes);
  const outerAgentGraphHash = sha256Bytes(outerAgent.graphBytes);
  const roleEntryGraph = {
    schemaVersion: 1,
    graphKind: "rollup-role-entry-v1",
    sourceSha,
    releaseRole: "standard",
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
        size: 7,
        staticImports: [],
        dynamicImports: [],
        modules: ["src/index.tsx"],
      },
    ],
  };
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole: "standard",
    dimensions,
    buildAuthority: buildAuthority("contract-fixture"),
    targetGate: "P0-RELEASE",
    buildPurpose: "production",
    promotable: true,
    buildInputClosureHash: sha256Json({ fixture: "input" }),
    lockfileSha256: sha256Json({ fixture: "lock" }),
    toolchainPolicyHash: context.releaseContext.toolchainPolicyHash,
    publicBuildEnvHash: sha256Json({ schemaVersion: 1, values: {} }),
    providerConfigurationHash: context.releaseContext.providerConfigurationHash,
    providerPolicyHash: context.releaseContext.providerPolicyHash,
    releasePolicyHash: context.releaseContext.releasePolicyHash,
    requiredDbCompatibility: context.releaseContext.requiredDbCompatibility,
    publicIdentityKind: "release-identity-v1",
    bootstrap: null,
    publicResponseHashes: {
      [OUTER_AGENT_URL]: outerAgentHash,
      "/assets/release-role.js": chunkHash,
      [OUTER_AGENT_GRAPH_URL]: outerAgentGraphHash,
    },
    roleEntryGraph,
    roleEntryGraphHash: computeRoleEntryGraphHash(roleEntryGraph),
    outputFiles: [
      {
        path: publicPathToOutputPath(OUTER_AGENT_URL),
        sha256: outerAgentHash,
        size: outerAgent.outerAgentBytes.length,
      },
      {
        path: "static/assets/release-role.js",
        sha256: chunkHash,
        size: 7,
      },
      {
        path: publicPathToOutputPath(OUTER_AGENT_GRAPH_URL),
        sha256: outerAgentGraphHash,
        size: outerAgent.graphBytes.length,
      },
    ],
  };
  const immutableReference = {
    uri: "artifact://sha256/" + chunkHash + "/artifact.json",
    sha256: chunkHash,
  };
  const index = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha,
    buildId: sourceSha,
    buildAuthority: manifest.buildAuthority,
    targetGate: manifest.targetGate,
    buildPurpose: manifest.buildPurpose,
    promotable: manifest.promotable,
    toolchainPolicyHash: manifest.toolchainPolicyHash,
    providerConfigurationHash: manifest.providerConfigurationHash,
    providerPolicyHash: manifest.providerPolicyHash,
    releasePolicyHash: manifest.releasePolicyHash,
    requiredDbCompatibility: manifest.requiredDbCompatibility,
    artifacts: [
      {
        releaseRole: "standard",
        variantId,
        manifest: immutableReference,
        archive: immutableReference,
      },
      {
        releaseRole: "containment",
        variantId: sha256Json({ role: "containment" }),
        manifest: immutableReference,
        archive: immutableReference,
      },
    ],
  };
  const containmentDimensions = projectContainmentDimensions(
    context.releasePolicy,
    dimensions,
  );
  const containmentManifest = structuredClone(manifest);
  containmentManifest.releaseRole = "containment";
  containmentManifest.dimensions = containmentDimensions;
  containmentManifest.variantId = computeVariantId(
    context.releasePolicy,
    containmentDimensions,
  );
  containmentManifest.roleEntryGraph.releaseRole = "containment";
  containmentManifest.roleEntryGraph.variantId = containmentManifest.variantId;
  containmentManifest.roleEntryGraphHash = computeRoleEntryGraphHash(
    containmentManifest.roleEntryGraph,
  );
  index.artifacts[1].variantId = containmentManifest.variantId;
  return { index, manifest, containmentManifest, roleEntryGraph };
};

test("requires byte-identical role-independent outer agents in a pair", async () => {
  const context = await loadFixtureContext();
  const { index, manifest, containmentManifest } =
    createContractFixture(context);
  assert.doesNotThrow(() =>
    assertPairRelationship({
      index,
      standardManifest: manifest,
      containmentManifest,
      releasePolicy: context.releasePolicy,
    }),
  );

  for (const publicPath of [OUTER_AGENT_URL, OUTER_AGENT_GRAPH_URL]) {
    const tampered = structuredClone(containmentManifest);
    tampered.publicResponseHashes[publicPath] = "f".repeat(64);
    assert.throws(
      () =>
        assertPairRelationship({
          index,
          standardManifest: manifest,
          containmentManifest: tampered,
          releasePolicy: context.releasePolicy,
        }),
      /independent outer agent bytes or closure graph differ/,
    );
  }
});

test("verifies a deterministic source-hardened role pair", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-pair-"),
  );
  try {
    const context = await loadFixtureContext();
    const { packageRoot } = await createSourceHardenedFixturePackage(
      temporaryRoot,
      context,
    );
    const result = await verifyReleasePackage(
      verificationArguments(context, packageRoot),
    );
    assert.equal(result.index.packageKind, "source-hardened-pair");
    assert.equal(result.productionEligible, false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("verifies bootstrap raw dist byte-for-byte and fixed staging inputs", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-bootstrap-"),
  );
  try {
    const context = await loadFixtureContext();
    const { packageRoot, index, manifest } =
      await createBootstrapFixturePackage(temporaryRoot, context);
    const result = await verifyReleasePackage(
      verificationArguments(context, packageRoot),
    );
    assert.equal(result.index.packageKind, "legacy-bootstrap-single");
    assert.equal(result.productionEligible, false);
    assert.deepEqual(
      {
        buildAuthority: manifest.buildAuthority,
        targetGate: manifest.targetGate,
        buildPurpose: manifest.buildPurpose,
        promotable: manifest.promotable,
      },
      {
        buildAuthority: null,
        targetGate: null,
        buildPurpose: "legacy-bootstrap",
        promotable: false,
      },
    );
    assert.deepEqual(
      {
        buildAuthority: index.buildAuthority,
        targetGate: index.targetGate,
        buildPurpose: index.buildPurpose,
        promotable: index.promotable,
      },
      {
        buildAuthority: null,
        targetGate: null,
        buildPurpose: "legacy-bootstrap",
        promotable: false,
      },
    );
    const authorityInjection = structuredClone(manifest);
    authorityInjection.buildAuthority = buildAuthority("bootstrap-injection");
    assert.throws(
      () => assertArtifactManifest(authorityInjection, context.releasePolicy),
      /legacy bootstrap build authority is invalid/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("policy activation QA artifact purpose is explicit and production-rejected", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-policy-qa-contract-"),
  );
  try {
    const context = await loadFixtureContext();
    const sourceSha = "9".repeat(40);
    const dimensions = projectContainmentDimensions(
      context.releasePolicy,
      context.releasePolicy.initialStandard,
    );
    const outputRoot = path.join(temporaryRoot, "output");
    const capabilityBytes = buildCapabilityBytes(
      sourceSha,
      POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    );
    await createRoleOutput({
      outputRoot,
      sourceSha,
      dimensions,
      releasePolicy: context.releasePolicy,
      requiredDbCompatibility: context.releaseContext.requiredDbCompatibility,
      capabilityBytes,
      cspPolicy: context.cspPolicy,
      buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    });
    const authority = buildAuthority("policy-activation-qa");
    const common = {
      outputRoot,
      releasePolicy: context.releasePolicy,
      sourceSha,
      dimensions,
      buildInputClosureHash: sha256Json({ fixture: "policy-qa-input" }),
      lockfileSha256: sha256Json({ fixture: "policy-qa-lock" }),
      releaseContext: context.releaseContext,
      publicBuildEnvHash: sha256Json({ schemaVersion: 1, values: {} }),
      publicIdentityKind: "release-identity-v1",
      bootstrap: null,
      buildAuthority: authority,
      cspPolicy: context.cspPolicy,
    };
    await assert.rejects(
      createArtifactManifestFromOutput({
        ...common,
        targetGate: "P6-APP",
      }),
      /nonpromotable QA build/,
    );

    await assert.rejects(
      createArtifactManifestFromOutput({
        ...common,
        targetGate: "P6-APP",
        buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
      }),
      /targetGate is invalid for policy activation QA/,
    );
    await assert.rejects(
      createArtifactManifestFromOutput({
        ...common,
        targetGate: "P8-CLEAN",
        buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
      }),
      /targetGate is invalid for policy activation QA/,
    );
    const manifest = await createArtifactManifestFromOutput({
      ...common,
      targetGate: "P1-PWA",
      buildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
    });
    assert.equal(manifest.targetGate, "P1-PWA");
    assert.equal(manifest.buildPurpose, POLICY_ACTIVATION_QA_BUILD_PURPOSE);
    assert.equal(manifest.promotable, false);
    assert.deepEqual(manifest.buildAuthority, authority);
    assert.throws(
      () => assertArtifactManifest(manifest, context.releasePolicy),
      /purpose\/promotable binding is invalid/,
    );
    assert.doesNotThrow(() =>
      assertArtifactManifest(manifest, context.releasePolicy, {
        expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
      }),
    );

    for (const targetGate of ["P6-APP", "P8-CLEAN"]) {
      const productionManifest = structuredClone(
        createContractFixture(context).manifest,
      );
      productionManifest.targetGate = targetGate;
      assert.doesNotThrow(() =>
        assertArtifactManifest(productionManifest, context.releasePolicy),
      );
      assert.equal(productionManifest.targetGate, targetGate);
    }

    const qaIndex = structuredClone(createContractFixture(context).index);
    qaIndex.buildAuthority = authority;
    qaIndex.targetGate = "P1-PWA";
    qaIndex.buildPurpose = POLICY_ACTIVATION_QA_BUILD_PURPOSE;
    qaIndex.promotable = false;
    assert.throws(
      () => assertReleasePackageIndex(qaIndex),
      /purpose\/promotable binding is invalid/,
    );
    assert.doesNotThrow(() =>
      assertReleasePackageIndex(qaIndex, {
        expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
      }),
    );
    qaIndex.targetGate = "P8-CLEAN";
    assert.throws(
      () =>
        assertReleasePackageIndex(qaIndex, {
          expectedBuildPurpose: POLICY_ACTIVATION_QA_BUILD_PURPOSE,
        }),
      /targetGate is invalid for policy activation QA/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects archive tampering independently of its manifest", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-tamper-"),
  );
  try {
    const context = await loadFixtureContext();
    const { packageRoot, index } = await createSourceHardenedFixturePackage(
      temporaryRoot,
      context,
    );
    const archive = index.artifacts[0].archive;
    const archivePath = contentAddressedObjectPath(
      packageRoot,
      archive.sha256,
      "artifact.zip",
    );
    await writeFile(archivePath, Buffer.from("tampered"), { flag: "w" });
    await assert.rejects(
      verifyReleasePackage(verificationArguments(context, packageRoot)),
      /bytes differ from declared SHA-256/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("current external policy explicitly blocks production artifact context", async () => {
  const [releasePolicy, toolchainPolicy, providerPolicy, dbContract] =
    await Promise.all([
      readJsonStrict(path.join(root, "config", "release-variants.json")),
      readJsonStrict(path.join(root, "config", "toolchain-versions.json")),
      readJsonStrict(path.join(root, "config", "provider-policy.json")),
      readJsonStrict(
        path.join(root, "config", "db-compatibility-contract.json"),
      ),
    ]);
  assert.throws(
    () =>
      buildReleaseContext({
        releasePolicy,
        toolchainPolicy,
        providerPolicy,
        providerObservation: null,
        dbContract,
        requireProductionBindings: true,
      }),
    /Production provider binding is unavailable/,
  );
});

test("rejects Python build triggers and non-Node Vercel functions", async () => {
  assert.throws(
    () =>
      assertNoPythonBuildTriggers(
        ["src/application.ts", "tools/worker.py"],
        "Release build input",
      ),
    /forbidden Python runtime trigger/,
  );
  assert.doesNotThrow(() =>
    assertNoPythonBuildTriggers(
      ["src/application.ts", "api/not-found.mjs"],
      "Release build input",
    ),
  );
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-runtime-"),
  );
  try {
    const context = await loadFixtureContext();
    const sourceSha = "f".repeat(40);
    const outputRoot = path.join(temporaryRoot, "output");
    await createVercelOutputBase({
      outputRoot,
      sourceSha,
      capabilityBytes: buildCapabilityBytes(sourceSha),
      cspPolicy: context.cspPolicy,
    });
    await writeBytes(outputRoot, "functions/worker.func/worker.py", "pass\n");
    await assert.rejects(
      assertVercelOutputShape(outputRoot, {
        publicIdentityKind: "release-identity-v1",
        cspPolicy: context.cspPolicy,
      }),
      /forbidden Python runtime trigger/,
    );

    await rm(path.join(outputRoot, "functions", "worker.func"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      path.join(
        outputRoot,
        "functions",
        "api",
        "not-found.func",
        ".vc-config.json",
      ),
      canonicalJsonBytes({
        runtime: "python3.12",
        handler: "index.py",
      }),
    );
    await assert.rejects(
      assertVercelOutputShape(outputRoot, {
        publicIdentityKind: "release-identity-v1",
        cspPolicy: context.cspPolicy,
      }),
      /function runtime is not Node/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("normalizes Vercel CSP headers and report function from dimensions", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-csp-modes-"),
  );
  try {
    const context = await loadFixtureContext();
    const sourceSha = "d".repeat(40);
    for (const cspMode of ["none", "report-only", "enforced"]) {
      const outputRoot = path.join(temporaryRoot, cspMode);
      await createVercelOutputBase({
        outputRoot,
        sourceSha,
        capabilityBytes: buildCapabilityBytes(sourceSha),
        cspPolicy: context.cspPolicy,
      });
      await applyCspDeliveryToVercelOutput({
        outputRoot,
        cspMode,
        cspPolicy: context.cspPolicy,
      });
      await assertVercelOutputShape(outputRoot, {
        publicIdentityKind: "release-identity-v1",
        cspMode,
        cspPolicy: context.cspPolicy,
      });
      const config = await readJsonStrict(path.join(outputRoot, "config.json"));
      const globalHeaders = config.routes.find(
        (route) => route.src === "^/.*$",
      ).headers;
      assert.deepEqual(
        globalHeaders,
        renderCspHeaders({ cspMode, cspPolicy: context.cspPolicy }),
      );
      const reportFunctionPath = path.join(
        outputRoot,
        "functions",
        "api",
        "csp-report.func",
        "index.mjs",
      );
      if (cspMode === "none") {
        await assert.rejects(readFile(reportFunctionPath), /ENOENT/);
      } else {
        assert.match(await readFile(reportFunctionPath, "utf8"), /Response/);
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("requires mode-aware CSP/Sheets API functions and exact emitted headers", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-routes-"),
  );
  try {
    const context = await loadFixtureContext();
    const sourceSha = "e".repeat(40);
    const outputRoot = path.join(temporaryRoot, "output");
    await createVercelOutputBase({
      outputRoot,
      sourceSha,
      capabilityBytes: buildCapabilityBytes(sourceSha),
      cspPolicy: context.cspPolicy,
    });
    await rm(path.join(outputRoot, "functions", "api", "csp-report.func"), {
      recursive: true,
      force: true,
    });
    await assert.rejects(
      assertVercelOutputShape(outputRoot, {
        publicIdentityKind: "release-identity-v1",
        cspPolicy: context.cspPolicy,
      }),
      /API functions differ/,
    );

    const secondOutputRoot = path.join(temporaryRoot, "header-output");
    await createVercelOutputBase({
      outputRoot: secondOutputRoot,
      sourceSha,
      capabilityBytes: buildCapabilityBytes(sourceSha),
      cspPolicy: context.cspPolicy,
    });
    const configPath = path.join(secondOutputRoot, "config.json");
    const config = await readJsonStrict(configPath);
    config.routes = config.routes.filter(
      (route) => route.headers?.["Content-Security-Policy"] === undefined,
    );
    await writeFile(configPath, canonicalJsonBytes(config));
    await assert.rejects(
      assertVercelOutputShape(secondOutputRoot, {
        publicIdentityKind: "release-identity-v1",
        cspPolicy: context.cspPolicy,
      }),
      /exact header contract/,
    );

    const thirdOutputRoot = path.join(temporaryRoot, "route-order-output");
    await createVercelOutputBase({
      outputRoot: thirdOutputRoot,
      sourceSha,
      capabilityBytes: buildCapabilityBytes(sourceSha),
      cspPolicy: context.cspPolicy,
    });
    const routeConfigPath = path.join(thirdOutputRoot, "config.json");
    const routeConfig = await readJsonStrict(routeConfigPath);
    const filesystemIndex = routeConfig.routes.findIndex(
      (route) => route.handle === "filesystem",
    );
    const apiFallbackIndex = routeConfig.routes.findIndex(
      (route) => route.dest === "/api/not-found",
    );
    [
      routeConfig.routes[filesystemIndex],
      routeConfig.routes[apiFallbackIndex],
    ] = [
      routeConfig.routes[apiFallbackIndex],
      routeConfig.routes[filesystemIndex],
    ];
    await writeFile(routeConfigPath, canonicalJsonBytes(routeConfig));
    await assert.rejects(
      assertVercelOutputShape(thirdOutputRoot, {
        publicIdentityKind: "release-identity-v1",
        cspPolicy: context.cspPolicy,
      }),
      /API fallback is absent or out of order/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("independent build proof rejects output manifest drift", () => {
  const firstManifest = {
    schemaVersion: 1,
    outputFiles: [{ path: "static/app.js", sha256: "1".repeat(64), size: 1 }],
  };
  assert.match(
    assertIndependentBuildReproducibility({
      firstManifest,
      secondManifest: structuredClone(firstManifest),
      label: "standard",
    }),
    /^[0-9a-f]{64}$/,
  );
  const secondManifest = structuredClone(firstManifest);
  secondManifest.outputFiles[0].sha256 = "2".repeat(64);
  assert.throws(
    () =>
      assertIndependentBuildReproducibility({
        firstManifest,
        secondManifest,
        label: "standard",
      }),
    /independent build output manifest\/hash differs/,
  );
});

test("artifact contract rejects malformed manifests and role entry graphs", async () => {
  const context = await loadFixtureContext();
  const { manifest, roleEntryGraph } = createContractFixture(context);
  assert.doesNotThrow(() =>
    assertArtifactManifest(structuredClone(manifest), context.releasePolicy),
  );
  assert.equal(publicPathToOutputPath("/"), "static/index.html");
  assert.equal(
    publicPathToOutputPath("/assets/release-role.js"),
    "static/assets/release-role.js",
  );
  assert.throws(() => publicPathToOutputPath("relative"), /Invalid public/);
  assert.throws(() => publicPathToOutputPath(null), /Invalid public/);
  assert.throws(() => publicPathToOutputPath("/bad\0path"), /Invalid public/);

  const graphCases = [
    [
      (graph) => {
        graph.extra = true;
      },
      /unexpected property set/,
    ],
    [(graph) => (graph.schemaVersion = 2), /version or kind/],
    [(graph) => (graph.graphKind = "unknown"), /version or kind/],
    [(graph) => (graph.sourceSha = "bad"), /full lowercase commit SHA/],
    [(graph) => (graph.variantId = "bad"), /lowercase SHA-256/],
    [(graph) => (graph.releaseRole = "containment"), /identity differs/],
    [(graph) => (graph.entryModule = ""), /non-empty string/],
    [(graph) => (graph.entryModule = "src\\entry.ts"), /checkout-relative/],
    [(graph) => (graph.entryFile = "relative"), /entryFile is invalid/],
    [(graph) => (graph.modules = []), /modules must be non-empty/],
    [
      (graph) => {
        graph.modules[0].extra = true;
      },
      /unexpected property set/,
    ],
    [(graph) => (graph.modules[0].external = "no"), /external must be boolean/],
    [
      (graph) => (graph.modules[0].staticImports = "src/other.ts"),
      /must be an array/,
    ],
    [(graph) => (graph.modules[0].staticImports = [""]), /non-empty string/],
    [
      (graph) => (graph.modules[0].staticImports = ["src/a.ts", "src/a.ts"]),
      /strict UTF-8 byte order/,
    ],
    [
      (graph) => {
        graph.modules[0].id = "src/other.ts";
      },
      /entry module is absent/,
    ],
    [
      (graph) => {
        graph.modules[0].staticImports = ["src/absent.ts"];
      },
      /imports an absent module/,
    ],
    [(graph) => (graph.chunks = []), /chunks must be non-empty/],
    [(graph) => (graph.chunks[0].file = "relative"), /file is invalid/],
    [(graph) => (graph.chunks[0].sha256 = "bad"), /lowercase SHA-256/],
    [(graph) => (graph.chunks[0].size = -1), /size is invalid/],
    [(graph) => (graph.chunks[0].staticImports = ["relative"]), /is invalid/],
    [
      (graph) => (graph.chunks[0].modules = ["src/absent.ts"]),
      /contains an absent module/,
    ],
    [
      (graph) => (graph.chunks[0].file = "/assets/other.js"),
      /entry file is absent/,
    ],
    [
      (graph) => (graph.chunks[0].staticImports = ["/assets/absent-chunk.js"]),
      /imports an absent chunk/,
    ],
    [
      (graph) => {
        graph.entryFile = "/assets/other.js";
        graph.chunks[0].file = "/assets/other.js";
      },
      /stable role entry/,
    ],
  ];
  for (const [mutate, message] of graphCases) {
    const graph = structuredClone(roleEntryGraph);
    mutate(graph);
    assert.throws(() => assertRoleEntryGraph(graph, manifest), message);
  }

  const duplicateGraph = structuredClone(roleEntryGraph);
  duplicateGraph.modules.push(structuredClone(duplicateGraph.modules[0]));
  assert.throws(
    () => assertRoleEntryGraph(duplicateGraph, manifest),
    /strict UTF-8 byte order/,
  );
  const duplicateChunkGraph = structuredClone(roleEntryGraph);
  duplicateChunkGraph.chunks.push(
    structuredClone(duplicateChunkGraph.chunks[0]),
  );
  assert.throws(
    () => assertRoleEntryGraph(duplicateChunkGraph, manifest),
    /strict UTF-8 byte order/,
  );
  const forbiddenGraph = structuredClone(roleEntryGraph);
  forbiddenGraph.releaseRole = "containment";
  forbiddenGraph.entryModule = "src/App.tsx";
  forbiddenGraph.modules[0].id = "src/App.tsx";
  forbiddenGraph.modules[0].staticImports = [];
  forbiddenGraph.chunks[0].modules = ["src/App.tsx"];
  const containmentManifest = {
    ...manifest,
    releaseRole: "containment",
  };
  assert.throws(
    () => assertRoleEntryGraph(forbiddenGraph, containmentManifest),
    /reaches forbidden module/,
  );

  const manifestCases = [
    [(value) => (value.schemaVersion = 2), /schemaVersion/],
    [(value) => (value.sourceSha = "bad"), /full lowercase commit SHA/],
    [(value) => (value.buildId = "bad"), /full lowercase commit SHA/],
    [(value) => (value.buildId = "b".repeat(40)), /must equal sourceSha/],
    [(value) => (value.releaseRole = "other"), /releaseRole is invalid/],
    [
      (value) => (value.dimensions.releaseRole = "containment"),
      /role and dimension role differ/,
    ],
    [
      (value) => (value.variantId = "f".repeat(64)),
      /differs from its dimensions/,
    ],
    [(value) => (value.lockfileSha256 = "bad"), /lowercase SHA-256/],
    [
      (value) => (value.requiredDbCompatibility.contractUri = "example"),
      /placeholder value/,
    ],
    [
      (value) => (value.requiredDbCompatibility.fingerprint = "bad"),
      /lowercase SHA-256/,
    ],
    [(value) => (value.publicIdentityKind = "other"), /publicIdentityKind/],
    [(value) => (value.bootstrap = {}), /cannot contain bootstrap/],
    [(value) => (value.publicResponseHashes = []), /must be an object/],
    [
      (value) => (value.publicResponseHashes = { relative: "a".repeat(64) }),
      /Invalid public response path/,
    ],
    [
      (value) =>
        (value.publicResponseHashes = {
          "/z": "a".repeat(64),
          "/a": "b".repeat(64),
        }),
      /strict UTF-8 byte insertion order/,
    ],
    [
      (value) =>
        (value.publicResponseHashes = {
          "/assets/release-role.js": "bad",
        }),
      /lowercase SHA-256/,
    ],
    [(value) => (value.outputFiles = []), /non-empty array/],
    [
      (value) => (value.outputFiles[0].path = "artifact-manifest.json"),
      /must not be embedded/,
    ],
    [(value) => (value.outputFiles[0].sha256 = "bad"), /lowercase SHA-256/],
    [(value) => (value.outputFiles[0].size = -1), /size is invalid/],
    [
      (value) => (value.roleEntryGraphHash = "f".repeat(64)),
      /roleEntryGraphHash is invalid/,
    ],
  ];
  for (const [mutate, message] of manifestCases) {
    const value = structuredClone(manifest);
    mutate(value);
    assert.throws(
      () => assertArtifactManifest(value, context.releasePolicy),
      message,
    );
  }

  const unorderedManifest = structuredClone(manifest);
  unorderedManifest.outputFiles = [
    {
      path: "static/z.js",
      sha256: "a".repeat(64),
      size: 1,
    },
    {
      path: "static/a.js",
      sha256: "b".repeat(64),
      size: 1,
    },
  ];
  assert.throws(
    () => assertArtifactManifest(unorderedManifest, context.releasePolicy),
    /strict UTF-8 byte order/,
  );
  const caseCollisionManifest = structuredClone(manifest);
  caseCollisionManifest.outputFiles = [
    {
      path: "static/App.js",
      sha256: "a".repeat(64),
      size: 1,
    },
    {
      path: "static/app.js",
      sha256: "b".repeat(64),
      size: 1,
    },
  ];
  assert.throws(
    () => assertArtifactManifest(caseCollisionManifest, context.releasePolicy),
    /Case-colliding artifact path/,
  );
});

test("package index and content-addressed object guards reject ambiguity", async () => {
  const context = await loadFixtureContext();
  const { index } = createContractFixture(context);
  assert.doesNotThrow(() => assertReleasePackageIndex(structuredClone(index)));
  const indexCases = [
    [(value) => (value.schemaVersion = 2), /schemaVersion/],
    [(value) => (value.sourceSha = "bad"), /full lowercase commit SHA/],
    [(value) => (value.buildId = "b".repeat(40)), /must equal sourceSha/],
    [(value) => (value.releasePolicyHash = "bad"), /lowercase SHA-256/],
    [(value) => (value.artifacts = []), /exactly two artifacts/],
    [
      (value) => (value.artifacts[0].releaseRole = "containment"),
      /must be standard/,
    ],
    [(value) => (value.artifacts[0].variantId = "bad"), /lowercase SHA-256/],
    [(value) => (value.artifacts[0].manifest = null), /must be an object/],
    [(value) => (value.packageKind = "unknown"), /unexpected property set/],
  ];
  for (const [mutate, message] of indexCases) {
    const value = structuredClone(index);
    mutate(value);
    assert.throws(() => assertReleasePackageIndex(value), message);
  }
  const unsupportedIndex = structuredClone(index);
  unsupportedIndex.packageKind = "unknown";
  delete unsupportedIndex.artifacts;
  assert.throws(
    () => assertReleasePackageIndex(unsupportedIndex),
    /packageKind is invalid/,
  );

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-content-store-"),
  );
  try {
    const bytes = Buffer.from("immutable fixture");
    const written = await writeContentAddressedObject({
      packageRoot: temporaryRoot,
      bytes,
      kind: "fixture.bin",
    });
    const replayed = await writeContentAddressedObject({
      packageRoot: temporaryRoot,
      bytes,
      kind: "fixture.bin",
    });
    assert.equal(replayed.uri, written.uri);
    assert.deepEqual(parseContentAddressedUri(written.uri, "fixture.bin"), {
      sha256: written.sha256,
      kind: "fixture.bin",
    });
    assert.equal(
      contentAddressedUri(written.sha256, "fixture.bin"),
      written.uri,
    );
    const resolved = await resolveContentAddressedObject({
      packageRoot: temporaryRoot,
      reference: written,
      expectedKind: "fixture.bin",
    });
    assert.deepEqual(resolved.bytes, bytes);

    for (const [operation, message] of [
      [() => contentAddressedUri("bad", "fixture.bin"), /Invalid.*SHA-256/],
      [
        () => contentAddressedUri(written.sha256, "Invalid Kind"),
        /Invalid.*kind/,
      ],
      [() => parseContentAddressedUri(null), /must be a string/],
      [() => parseContentAddressedUri("https://example.test"), /Unsupported/],
      [
        () => parseContentAddressedUri(written.uri, "other.bin"),
        /differs from/,
      ],
      [
        () => contentAddressedObjectPath(temporaryRoot, "bad", "fixture.bin"),
        /Invalid.*SHA-256/,
      ],
      [
        () =>
          contentAddressedObjectPath(
            temporaryRoot,
            written.sha256,
            "Invalid Kind",
          ),
        /Invalid.*kind/,
      ],
    ]) {
      assert.throws(operation, message);
    }
    for (const [reference, message] of [
      [null, /reference is invalid/],
      [[], /reference is invalid/],
      [{ uri: written.uri }, /reference is invalid/],
      [{ uri: written.uri, sha256: "f".repeat(64) }, /declared SHA-256 differ/],
    ]) {
      await assert.rejects(
        resolveContentAddressedObject({
          packageRoot: temporaryRoot,
          reference,
          expectedKind: "fixture.bin",
        }),
        message,
      );
    }
    await writeFile(resolved.path, Buffer.from("tampered"), { flag: "w" });
    await assert.rejects(
      resolveContentAddressedObject({
        packageRoot: temporaryRoot,
        reference: written,
        expectedKind: "fixture.bin",
      }),
      /bytes differ from declared SHA-256/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
