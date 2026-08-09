import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import {
  assertArtifactManifest,
  assertBootstrapInput,
  assertNoPlaceholder,
  buildPublicResponseHashes,
  computeRoleEntryGraphHash,
  readAndVerifyCapability,
  readAndVerifyOuterAgentGraph,
  readAndVerifyPublicIdentity,
  readAndVerifyRoleEntryGraph,
} from "./artifact-contract.mjs";
import {
  assertFileManifestEqual,
  buildFileManifest,
  manifestTreeHash,
} from "./file-manifest.mjs";
import {
  assertDimensionObject,
  computeVariantId,
  projectContainmentDimensions,
} from "./release-policy.mjs";
import { writeContentAddressedObject } from "./content-addressed-store.mjs";
import { hasFinalRemoteDbAuthority } from "./db-compatibility-authority.mjs";
import {
  createDeterministicZip,
  verifyDeterministicZip,
} from "../deterministic-zip.mjs";
import { providerConfigurationHash } from "../provider/providerConfiguration.mjs";
import {
  cspReportSinkContract,
  renderCspHeaders,
  renderVercelOutputConfig,
  resolveProviderEnvironmentContract,
} from "./csp-delivery.mjs";
import { readStaticApplicationStylesheetContract } from "./application-stylesheet-contract.mjs";

const REQUIRED_SOURCE_HARDENED_PUBLIC_PATHS = Object.freeze([
  "/",
  "/release-capabilities.json",
  "/sw.js",
]);

const compareStrings = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const arraysEqual = (left, right) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const isPythonBuildTrigger = (filePath) => {
  const baseName = path.posix.basename(filePath.replaceAll("\\", "/"));
  return (
    /\.py$/i.test(baseName) ||
    /^requirements.*\.txt$/i.test(baseName) ||
    /^Pipfile.*$/i.test(baseName) ||
    /^pyproject\.toml$/i.test(baseName)
  );
};

export const assertNoPythonBuildTriggers = (filePaths, label) => {
  const triggers = filePaths.filter(isPythonBuildTrigger).sort(compareStrings);
  if (triggers.length > 0) {
    throw new Error(
      `${label} contains forbidden Python runtime trigger(s): ${triggers.join(", ")}`,
    );
  }
};

const assertNoCriticalPlaceholder = (value, label) => {
  if (value === null || value === undefined) {
    throw new Error(`${label} is not configured`);
  }
  return assertNoPlaceholder(value, label);
};

export const assertProductionProviderContext = (
  providerPolicy,
  providerObservation,
  { cspMode = null } = {},
) => {
  if (providerPolicy.bindingStatus !== "configured") {
    throw new Error(
      `Production provider binding is unavailable: ${(providerPolicy.blockerCodes ?? []).join(", ")}`,
    );
  }
  if (
    !Array.isArray(providerPolicy.blockerCodes) ||
    providerPolicy.blockerCodes.length !== 0
  ) {
    throw new Error("Production provider policy still contains blockers");
  }
  const expectedTeamId = assertNoCriticalPlaceholder(
    providerPolicy.expectedTeamId,
    "providerPolicy.expectedTeamId",
  );
  const expectedProjectId = assertNoCriticalPlaceholder(
    providerPolicy.expectedProjectId,
    "providerPolicy.expectedProjectId",
  );
  if (
    !Array.isArray(providerPolicy.ownedProductionDomains) ||
    providerPolicy.ownedProductionDomains.length === 0
  ) {
    throw new Error("Production provider domain set is empty");
  }
  if (
    providerPolicy.logPolicy?.retentionDays === null ||
    !isRecord(providerPolicy.wafRules?.metricsRoute)
  ) {
    throw new Error("Provider WAF/log-retention policy is not final");
  }
  if (!isRecord(providerObservation)) {
    throw new Error("Provider configuration observation is required");
  }
  const comparisons = [
    [
      "providerProjectId",
      providerObservation.providerProjectId,
      expectedProjectId,
    ],
    ["providerTeamId", providerObservation.providerTeamId, expectedTeamId],
    [
      "productionEnvironmentName",
      providerObservation.productionEnvironmentName,
      providerPolicy.productionEnvironmentName,
    ],
    [
      "providerNodeFamily",
      providerObservation.providerNodeFamily,
      providerPolicy.providerNodeFamily,
    ],
    [
      "autoAssignCustomProductionDomains",
      providerObservation.autoAssignCustomProductionDomains,
      false,
    ],
    [
      "gitProductionAutoDeploy",
      providerObservation.gitProductionAutoDeploy,
      false,
    ],
    ["hstsOwner", providerObservation.hstsOwner, providerPolicy.hstsOwner],
  ];
  const mismatches = comparisons
    .filter(([, actual, expected]) => actual !== expected)
    .map(([label]) => label);
  const expectedDomains = [...providerPolicy.ownedProductionDomains].sort(
    compareStrings,
  );
  const observedDomains = [
    ...(providerObservation.ownedProductionDomains ?? []),
  ].sort(compareStrings);
  if (!arraysEqual(expectedDomains, observedDomains)) {
    mismatches.push("ownedProductionDomains");
  }
  const environmentNames = new Set(
    providerObservation.presentEnvironmentNames ?? [],
  );
  const environmentContract = resolveProviderEnvironmentContract(
    providerPolicy,
    cspMode,
  );
  for (const name of environmentContract.requiredEnvironmentNames) {
    if (!environmentNames.has(name)) mismatches.push(`missing:${name}`);
  }
  for (const name of environmentContract.forbiddenEnvironmentNames) {
    if (environmentNames.has(name)) mismatches.push(`forbidden:${name}`);
  }
  if (
    sha256Json(providerObservation.wafRules) !==
    sha256Json(providerPolicy.wafRules)
  ) {
    mismatches.push("wafRules");
  }
  if (
    sha256Json(providerObservation.logPolicy) !==
    sha256Json(providerPolicy.logPolicy)
  ) {
    mismatches.push("logPolicy");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Production provider observation differs: ${mismatches.join(", ")}`,
    );
  }
  return {
    providerProjectId: expectedProjectId,
    providerConfigurationHash: providerConfigurationHash(providerObservation),
  };
};

export const assertProductionDbContract = (dbContract) => {
  if (!hasFinalRemoteDbAuthority(dbContract)) {
    throw new Error(
      `Production DB compatibility is unavailable: ${(dbContract.blockerCodes ?? []).join(", ")}`,
    );
  }
  assertNoCriticalPlaceholder(
    dbContract.contractUri,
    "dbCompatibility.contractUri",
  );
  return {
    contractUri: dbContract.contractUri,
    fingerprint: sha256Json(dbContract),
  };
};

export const buildReleaseContext = ({
  releasePolicy,
  toolchainPolicy,
  providerPolicy,
  providerObservation,
  dbContract,
  requireProductionBindings = true,
}) => {
  let providerContext;
  let requiredDbCompatibility;
  if (requireProductionBindings) {
    providerContext = assertProductionProviderContext(
      providerPolicy,
      providerObservation,
    );
    requiredDbCompatibility = assertProductionDbContract(dbContract);
  } else {
    if (!isRecord(providerObservation)) {
      throw new Error("Fixture provider observation is required");
    }
    assertNoCriticalPlaceholder(
      providerObservation.providerProjectId,
      "providerObservation.providerProjectId",
    );
    providerContext = {
      providerProjectId: providerObservation.providerProjectId,
      providerConfigurationHash: providerConfigurationHash(providerObservation),
    };
    assertNoCriticalPlaceholder(
      dbContract.contractUri,
      "dbCompatibility.contractUri",
    );
    requiredDbCompatibility = {
      contractUri: dbContract.contractUri,
      fingerprint: sha256Json(dbContract),
    };
  }
  return {
    ...providerContext,
    requiredDbCompatibility,
    toolchainPolicyHash: sha256Json(toolchainPolicy),
    providerPolicyHash: sha256Json(providerPolicy),
    releasePolicyHash: sha256Json(releasePolicy),
  };
};

export const buildArtifactDrillReleaseContext = ({
  releasePolicy,
  toolchainPolicy,
  providerPolicy,
  providerObservation,
  dbContract,
}) => {
  const standardDimensions = { ...releasePolicy.initialStandard };
  assertDimensionObject(releasePolicy, standardDimensions);
  const providerContext = assertProductionProviderContext(
    providerPolicy,
    providerObservation,
    { cspMode: standardDimensions.cspMode },
  );
  if (!isRecord(dbContract)) {
    throw new Error("Artifact drill DB compatibility contract is required");
  }
  assertNoCriticalPlaceholder(
    dbContract.contractUri,
    "dbCompatibility.contractUri",
  );
  return {
    ...providerContext,
    requiredDbCompatibility: {
      contractUri: dbContract.contractUri,
      fingerprint: sha256Json(dbContract),
    },
    toolchainPolicyHash: sha256Json(toolchainPolicy),
    providerPolicyHash: sha256Json(providerPolicy),
    releasePolicyHash: sha256Json(releasePolicy),
  };
};

export const collectPublicBuildEnvironment = (environment = process.env) => {
  const allowedNames = new Set([
    "VITE_APP_BUILD_ID",
    "VITE_PERSISTENCE_LEGACY_CLEANUP",
    "VITE_PERSISTENCE_RELEASE_CHANNEL",
  ]);
  const values = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("VITE_") || value === undefined) continue;
    if (!allowedNames.has(name)) {
      throw new Error(`Public build environment is not allowlisted: ${name}`);
    }
    values[name] = String(value);
  }
  if (
    values.VITE_PERSISTENCE_RELEASE_CHANNEL !== undefined &&
    values.VITE_PERSISTENCE_RELEASE_CHANNEL !== "release-a"
  ) {
    throw new Error("Foundation artifacts require Release A");
  }
  if (
    values.VITE_PERSISTENCE_LEGACY_CLEANUP !== undefined &&
    values.VITE_PERSISTENCE_LEGACY_CLEANUP !== "false"
  ) {
    throw new Error("Foundation artifacts require legacy cleanup hard-off");
  }
  const sortedValues = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) =>
      compareStrings(left, right),
    ),
  );
  const document = { schemaVersion: 1, values: sortedValues };
  return { document, hash: sha256Json(document) };
};

export const calculateBuildInputClosure = ({ repositoryRoot, sourceSha }) => {
  const root = path.resolve(repositoryRoot);
  const listed = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "-z", sourceSha],
    { cwd: root },
  );
  const trackedFiles = new TextDecoder("utf-8", { fatal: true })
    .decode(listed)
    .split("\0")
    .filter(Boolean);
  assertNoPythonBuildTriggers(trackedFiles, "Release build input");
  const candidates = trackedFiles
    .filter(
      (file) =>
        [
          "index.html",
          "package.json",
          "package-lock.json",
          "pwa-assets.config.ts",
          "postcss.config.js",
          "tailwind.config.js",
          "tsconfig.json",
          "tsconfig.node.json",
          "tsconfig.worker.json",
          "vercel.json",
          "vite.config.ts",
        ].includes(file) ||
        file.startsWith("api/") ||
        file.startsWith("public/") ||
        file.startsWith("src/") ||
        file.startsWith("config/csp-") ||
        file === "config/release-variants.json" ||
        file === "config/xlsx-limits.json" ||
        file === "contracts/release-identity-v1.schema.json" ||
        file === "scripts/build-pwa-recovery-agent.mjs" ||
        file === "scripts/build-release-vite.mjs" ||
        file === "scripts/lib/canonical-json.mjs" ||
        file === "scripts/lib/csp-delivery.d.mts" ||
        file === "scripts/lib/csp-delivery.mjs" ||
        file === "scripts/lib/release-build-input.mjs" ||
        file === "scripts/lib/release-policy.mjs" ||
        file === "scripts/verify-release-a-build.mjs",
    )
    .sort(compareStrings);
  const entries = candidates.map((file) => {
    const bytes = execFileSync("git", ["show", `${sourceSha}:${file}`], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    });
    return {
      path: file,
      byteLength: bytes.length,
      sha256: sha256Bytes(bytes),
    };
  });
  return {
    algorithm: "sha256-jcs-path-byteLength-fileSha256-v1",
    fileCount: entries.length,
    sha256: sha256Json(entries),
  };
};

const routeMatches = (route, pathname) => {
  if (typeof route?.src !== "string") return false;
  try {
    return new RegExp(route.src).test(pathname);
  } catch {
    throw new Error(
      `Vercel output contains an invalid route regex: ${route.src}`,
    );
  }
};

const assertExactStringMap = (actual, expected, label) => {
  const normalizeEntries = (value) =>
    Object.entries(value)
      .map(([key, entry]) => [key.toLowerCase(), entry])
      .sort(([left], [right]) => compareStrings(left, right));
  const actualEntries = normalizeEntries(actual);
  const expectedEntries = normalizeEntries(expected);
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some(
      ([key, value], index) =>
        key !== expectedEntries[index][0] ||
        value !== expectedEntries[index][1],
    )
  ) {
    throw new Error(`${label} differs from the exact header contract`);
  }
};

const collectHeadersForPath = (routes, filesystemIndex, pathname) => {
  const headers = {};
  for (const route of routes.slice(0, filesystemIndex)) {
    if (!routeMatches(route, pathname) || !isRecord(route.headers)) continue;
    if (route.continue !== true) {
      throw new Error(`Header route is terminal for ${pathname}`);
    }
    for (const [name, value] of Object.entries(route.headers)) {
      if (typeof value !== "string") {
        throw new Error(`Header route has a non-string ${name} value`);
      }
      const normalizedName = name.toLowerCase();
      if (
        headers[normalizedName] !== undefined &&
        headers[normalizedName] !== value
      ) {
        throw new Error(`Header route conflicts at ${name} for ${pathname}`);
      }
      headers[normalizedName] = value;
    }
  }
  return headers;
};

const assertSourceHardenedRoutes = ({
  routes,
  filesystemIndex,
  cspMode,
  cspPolicy,
}) => {
  const securityHeaders = renderCspHeaders({ cspMode, cspPolicy });
  const versionedIdentity = `/release-identity.${"a".repeat(40)}.${"b".repeat(64)}.json`;
  for (const [pathname, additionalHeaders] of [
    ["/", {}],
    ["/api/csp-report", {}],
    ["/sw.js", { "Cache-Control": "public, max-age=0, must-revalidate" }],
    ["/release-identity.json", { "Cache-Control": "private, no-store" }],
    [
      versionedIdentity,
      { "Cache-Control": "public, max-age=31536000, immutable" },
    ],
  ]) {
    assertExactStringMap(
      collectHeadersForPath(routes, filesystemIndex, pathname),
      { ...securityHeaders, ...additionalHeaders },
      `Vercel headers for ${pathname}`,
    );
  }
};

const assertRouteFallbackOrder = (
  routes,
  filesystemIndex,
  { cspMode = "enforced", cspPolicy = null } = {},
) => {
  const terminalAfterFilesystem = routes
    .slice(filesystemIndex + 1)
    .filter(
      (route) => typeof route?.dest === "string" && route.continue !== true,
    );
  const firstDestinationFor = (pathname) =>
    terminalAfterFilesystem.find((route) => routeMatches(route, pathname))
      ?.dest ?? null;
  for (const pathname of ["/api", "/api/unknown", "/api/deep/unknown"]) {
    if (firstDestinationFor(pathname) !== "/api/not-found") {
      throw new Error(
        `Vercel API fallback is absent or out of order for ${pathname}`,
      );
    }
  }
  if (
    cspMode === "none" &&
    firstDestinationFor(cspPolicy.reportEndpoint) !== "/api/not-found"
  ) {
    throw new Error(
      "Disabled CSP report route does not close to /api/not-found",
    );
  }
  for (const pathname of ["/", "/events/1", "/apiary"]) {
    if (firstDestinationFor(pathname) !== "/index.html") {
      throw new Error(
        `Vercel SPA fallback is absent or captures API routes for ${pathname}`,
      );
    }
  }
  const apiFallbacks = terminalAfterFilesystem.filter(
    (route) => route.dest === "/api/not-found",
  );
  if (
    apiFallbacks.length === 0 ||
    apiFallbacks.some(
      (route) =>
        routeMatches(route, "/apiary") || routeMatches(route, "/api-other"),
    )
  ) {
    throw new Error("Vercel API fallback escapes the exact /api namespace");
  }
};

export const applyCspDeliveryToVercelOutput = async ({
  outputRoot,
  cspMode,
  cspPolicy,
}) => {
  const configPath = path.join(outputRoot, "config.json");
  const config = parseJsonStrict(
    await readFile(configPath, "utf8"),
    "Vercel Build Output config.json",
  );
  const reportSink = cspReportSinkContract({ cspMode, cspPolicy });
  const renderedConfig = renderVercelOutputConfig({
    config,
    cspMode,
    cspPolicy,
  });
  const operations = [
    writeFile(configPath, canonicalJsonBytes(renderedConfig)),
  ];
  if (!reportSink.enabled) {
    operations.push(
      rm(path.join(outputRoot, "functions", "api", "csp-report.func"), {
        recursive: true,
        force: true,
      }),
    );
  }
  await Promise.all(operations);
  return reportSink;
};

export const assertVercelOutputShape = async (
  outputRoot,
  {
    publicIdentityKind = "release-identity-v1",
    cspMode = "enforced",
    cspPolicy = null,
  } = {},
) => {
  const outputFiles = await buildFileManifest(outputRoot);
  const paths = new Set(outputFiles.map((file) => file.path));
  assertNoPythonBuildTriggers(
    outputFiles.map((file) => file.path),
    "Vercel output",
  );
  for (const required of ["config.json", "static/index.html"]) {
    if (!paths.has(required)) {
      throw new Error(`Vercel output is missing ${required}`);
    }
  }
  const functionRoots = new Set(
    outputFiles
      .map((file) => /^functions\/(.+?\.func)\//.exec(file.path)?.[1] ?? null)
      .filter(Boolean),
  );
  const apiFunctionRoots = [...functionRoots]
    .filter((value) => value.startsWith("api/"))
    .sort(compareStrings);
  const reportSink =
    publicIdentityKind === "release-identity-v1"
      ? cspReportSinkContract({ cspMode, cspPolicy })
      : null;
  const expectedApiFunctionRoots =
    publicIdentityKind === "release-identity-v1"
      ? [
          ...(reportSink.enabled ? [reportSink.functionRoot] : []),
          "api/google-sheets-csv.func",
          "api/not-found.func",
          "api/persistence-release-a-metrics.func",
        ]
      : ["api/not-found.func", "api/persistence-release-a-metrics.func"];
  if (!arraysEqual(apiFunctionRoots, expectedApiFunctionRoots)) {
    throw new Error(
      `Vercel output API functions differ: ${apiFunctionRoots.join(", ")}`,
    );
  }
  for (const functionRoot of functionRoots) {
    const configPath = `functions/${functionRoot}/.vc-config.json`;
    if (!paths.has(configPath)) {
      throw new Error(`Vercel function config is missing: ${configPath}`);
    }
    const functionConfig = parseJsonStrict(
      await readFile(path.join(outputRoot, ...configPath.split("/")), "utf8"),
      configPath,
    );
    if (
      typeof functionConfig.runtime !== "string" ||
      !/^nodejs(?:[0-9]+(?:\.[0-9x]+)*)?$/i.test(functionConfig.runtime)
    ) {
      throw new Error(`Vercel function runtime is not Node: ${configPath}`);
    }
  }
  const config = parseJsonStrict(
    await readFile(path.join(outputRoot, "config.json"), "utf8"),
    "Vercel Build Output config.json",
  );
  if (config.version !== 3) {
    throw new Error("Vercel Build Output API version must be 3");
  }
  if (!Array.isArray(config.routes)) {
    throw new Error("Vercel Build Output routes must be an array");
  }
  const filesystemIndexes = config.routes
    .map((route, index) => (route?.handle === "filesystem" ? index : -1))
    .filter((index) => index >= 0);
  if (filesystemIndexes.length !== 1) {
    throw new Error("Vercel output requires exactly one filesystem boundary");
  }
  const filesystemIndex = filesystemIndexes[0];
  assertRouteFallbackOrder(config.routes, filesystemIndex, {
    cspMode,
    cspPolicy,
  });
  if (publicIdentityKind === "release-identity-v1") {
    assertSourceHardenedRoutes({
      routes: config.routes,
      filesystemIndex,
      cspMode,
      cspPolicy,
    });
  }
  return outputFiles;
};

export const createArtifactManifestFromOutput = async ({
  outputRoot,
  releasePolicy,
  sourceSha,
  dimensions,
  buildInputClosureHash,
  lockfileSha256,
  releaseContext,
  publicBuildEnvHash,
  publicIdentityKind,
  bootstrap,
  buildAuthority = null,
  targetGate = null,
  buildPurpose = publicIdentityKind === "legacy-bootstrap-v1"
    ? "legacy-bootstrap"
    : "production",
  promotable = buildPurpose === "production",
  additionalPublicPaths = [],
  cspPolicy = null,
}) => {
  await assertVercelOutputShape(outputRoot, {
    publicIdentityKind,
    cspMode:
      publicIdentityKind === "release-identity-v1"
        ? dimensions.cspMode
        : "enforced",
    cspPolicy,
  });
  const applicationStylesheet =
    publicIdentityKind === "release-identity-v1"
      ? await readStaticApplicationStylesheetContract(outputRoot)
      : null;
  const outputFiles = await buildFileManifest(outputRoot);
  const variantId = computeVariantId(releasePolicy, dimensions);
  let roleEntryGraph;
  if (publicIdentityKind === "release-identity-v1") {
    const graphBytes = await readFile(
      path.join(outputRoot, "static", "release-role-graph.json"),
    );
    roleEntryGraph = parseJsonStrict(
      graphBytes.toString("utf8"),
      "release-role-graph.json",
    );
    if (!graphBytes.equals(canonicalJsonBytes(roleEntryGraph))) {
      throw new Error("Release role entry graph must use canonical JSON bytes");
    }
  } else {
    const indexFile = outputFiles.find(
      (file) => file.path === "static/index.html",
    );
    if (!indexFile) {
      throw new Error("Legacy bootstrap output has no static index entry");
    }
    roleEntryGraph = {
      schemaVersion: 1,
      graphKind: "legacy-static-entry-v1",
      sourceSha,
      releaseRole: dimensions.releaseRole,
      variantId,
      entryModule: "legacy-bootstrap:index.html",
      entryFile: "/index.html",
      modules: [
        {
          id: "legacy-bootstrap:index.html",
          external: false,
          staticImports: [],
          dynamicImports: [],
        },
      ],
      chunks: [
        {
          file: "/index.html",
          sha256: indexFile.sha256,
          size: indexFile.size,
          staticImports: [],
          dynamicImports: [],
          modules: ["legacy-bootstrap:index.html"],
        },
      ],
    };
  }
  const publicPaths = [
    ...REQUIRED_SOURCE_HARDENED_PUBLIC_PATHS,
    `/release-capabilities.${sourceSha}.json`,
    ...(applicationStylesheet ? [applicationStylesheet.publicPath] : []),
    ...additionalPublicPaths,
  ];
  if (publicIdentityKind === "release-identity-v1") {
    publicPaths.push(
      "/assets/outer-recovery-agent.js",
      "/outer-agent-graph.json",
      "/release-identity.json",
      "/release-role-graph.json",
      `/release-identity.${sourceSha}.${variantId}.json`,
    );
  }
  const publicResponseHashes = await buildPublicResponseHashes(
    outputRoot,
    publicPaths,
  );
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole: dimensions.releaseRole,
    dimensions,
    buildAuthority,
    targetGate,
    buildPurpose,
    promotable,
    buildInputClosureHash,
    lockfileSha256,
    toolchainPolicyHash: releaseContext.toolchainPolicyHash,
    publicBuildEnvHash,
    providerConfigurationHash: releaseContext.providerConfigurationHash,
    providerPolicyHash: releaseContext.providerPolicyHash,
    releasePolicyHash: releaseContext.releasePolicyHash,
    requiredDbCompatibility: releaseContext.requiredDbCompatibility,
    publicIdentityKind,
    bootstrap,
    publicResponseHashes,
    roleEntryGraph,
    roleEntryGraphHash: "",
    outputFiles,
  };
  manifest.roleEntryGraphHash = computeRoleEntryGraphHash(roleEntryGraph);
  assertArtifactManifest(manifest, releasePolicy, {
    expectedBuildPurpose:
      publicIdentityKind === "legacy-bootstrap-v1"
        ? "production"
        : buildPurpose,
  });
  await readAndVerifyCapability({
    outputRoot,
    manifest,
    expectedBuildPurpose:
      publicIdentityKind === "legacy-bootstrap-v1"
        ? "production"
        : buildPurpose,
  });
  await readAndVerifyRoleEntryGraph({ outputRoot, manifest });
  if (publicIdentityKind === "release-identity-v1") {
    await readAndVerifyOuterAgentGraph({ outputRoot, manifest });
    await readAndVerifyPublicIdentity({
      outputRoot,
      manifest,
      expectedBuildPurpose: buildPurpose,
    });
  } else if (
    outputFiles.some((file) =>
      /^static\/release-identity(?:\.|$)/.test(file.path),
    )
  ) {
    throw new Error("Legacy bootstrap output must not add release identity");
  }
  return manifest;
};

export const assertIndependentBuildReproducibility = ({
  firstManifest,
  secondManifest,
  label,
}) => {
  const firstBytes = canonicalJsonBytes(firstManifest);
  const secondBytes = canonicalJsonBytes(secondManifest);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error(
      `${label} independent build output manifest/hash differs: ` +
        `${sha256Bytes(firstBytes)} != ${sha256Bytes(secondBytes)}`,
    );
  }
  return sha256Bytes(firstBytes);
};

export const buildRawDistManifest = async (rawDistRoot) => {
  const files = await buildFileManifest(rawDistRoot);
  return {
    schemaVersion: 1,
    treeSha256: manifestTreeHash(files),
    files,
  };
};

const bootstrapGeneratedPackage = (
  providerNodeFamily,
  metricsTemplateSha256,
  notFoundTemplateSha256,
) => ({
  name: "event-shopping-planner-legacy-bootstrap",
  version: "1.0.0",
  private: true,
  engines: {
    node: providerNodeFamily,
  },
  scripts: {
    "verify:bootstrap": `node scripts/verify-bootstrap-staging.mjs --root . --raw-dist-manifest ../raw-dist-manifest.json --metrics-template-sha256 ${metricsTemplateSha256} --not-found-template-sha256 ${notFoundTemplateSha256}`,
  },
});

const bootstrapGeneratedLock = (providerNodeFamily) => ({
  name: "event-shopping-planner-legacy-bootstrap",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "event-shopping-planner-legacy-bootstrap",
      version: "1.0.0",
      engines: {
        node: providerNodeFamily,
      },
    },
  },
});

const bootstrapGeneratedVercelConfig = () => ({
  $schema: "https://openapi.vercel.sh/vercel.json",
  framework: null,
  installCommand: "npm ci --ignore-scripts --no-audit --no-fund",
  buildCommand: "npm run verify:bootstrap",
  outputDirectory: "public",
  rewrites: [
    {
      source: "/api/persistence-release-a-metrics",
      destination: "/api/persistence-release-a-metrics",
    },
    { source: "/api", destination: "/api/not-found" },
    { source: "/api/:path*", destination: "/api/not-found" },
    { source: "/((?!api(?:/|$)).*)", destination: "/index.html" },
  ],
});

export const buildBootstrapGeneratedFiles = (
  providerNodeFamily = "24.x",
  { metricsTemplateSha256, notFoundTemplateSha256 },
) => {
  if (!/^[0-9]+\.x$/.test(providerNodeFamily)) {
    throw new Error("Bootstrap provider Node family is invalid");
  }
  for (const [label, hash] of [
    ["metricsTemplateSha256", metricsTemplateSha256],
    ["notFoundTemplateSha256", notFoundTemplateSha256],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Bootstrap ${label} is invalid`);
    }
  }
  return {
    packageBytes: canonicalJsonBytes(
      bootstrapGeneratedPackage(
        providerNodeFamily,
        metricsTemplateSha256,
        notFoundTemplateSha256,
      ),
    ),
    lockfileBytes: canonicalJsonBytes(
      bootstrapGeneratedLock(providerNodeFamily),
    ),
    vercelConfigBytes: canonicalJsonBytes(bootstrapGeneratedVercelConfig()),
  };
};

export const createBootstrapInput = ({
  sourceSha,
  nodeVersion,
  npmVersion,
  lockfileSha256,
  rawDistManifestReference,
  metricsDisabledTemplateBytes,
  apiNotFoundTemplateBytes,
  stagingVerifierBytes,
  generatedFiles,
  providerProjectId,
  providerConfigurationHash,
}) => {
  const input = {
    schemaVersion: 1,
    sourceSha,
    nodeVersion,
    npmVersion,
    lockfileSha256,
    rawDistManifest: {
      uri: rawDistManifestReference.uri,
      sha256: rawDistManifestReference.sha256,
    },
    metricsDisabledTemplateSha256: sha256Bytes(metricsDisabledTemplateBytes),
    apiNotFoundTemplateSha256: sha256Bytes(apiNotFoundTemplateBytes),
    stagingVerifierSha256: sha256Bytes(stagingVerifierBytes),
    generatedPackageSha256: sha256Bytes(generatedFiles.packageBytes),
    generatedLockfileSha256: sha256Bytes(generatedFiles.lockfileBytes),
    generatedVercelConfigSha256: sha256Bytes(generatedFiles.vercelConfigBytes),
    providerProjectId,
    providerConfigurationHash,
  };
  assertBootstrapInput(input);
  return input;
};

export const createBootstrapStaging = async ({
  stagingRoot,
  rawDistRoot,
  metricsDisabledTemplateBytes,
  apiNotFoundTemplateBytes,
  stagingVerifierBytes,
  generatedFiles,
}) => {
  const resolvedRoot = path.resolve(stagingRoot);
  await mkdir(path.join(resolvedRoot, "api"), { recursive: true });
  await mkdir(path.join(resolvedRoot, "scripts"), { recursive: true });
  await cp(rawDistRoot, path.join(resolvedRoot, "public"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await Promise.all([
    writeFile(
      path.join(resolvedRoot, "api", "persistence-release-a-metrics.mjs"),
      metricsDisabledTemplateBytes,
      { flag: "wx" },
    ),
    writeFile(
      path.join(resolvedRoot, "api", "not-found.mjs"),
      apiNotFoundTemplateBytes,
      { flag: "wx" },
    ),
    writeFile(
      path.join(resolvedRoot, "scripts", "verify-bootstrap-staging.mjs"),
      stagingVerifierBytes,
      { flag: "wx" },
    ),
    writeFile(
      path.join(resolvedRoot, "package.json"),
      generatedFiles.packageBytes,
      { flag: "wx" },
    ),
    writeFile(
      path.join(resolvedRoot, "package-lock.json"),
      generatedFiles.lockfileBytes,
      { flag: "wx" },
    ),
    writeFile(
      path.join(resolvedRoot, "vercel.json"),
      generatedFiles.vercelConfigBytes,
      { flag: "wx" },
    ),
  ]);
};

export const assertBootstrapStaticOutput = async ({
  outputRoot,
  rawDistManifest,
}) => {
  const staticFiles = await buildFileManifest(path.join(outputRoot, "static"));
  assertFileManifestEqual(
    staticFiles,
    rawDistManifest.files,
    "bootstrap Vercel static output",
  );
  if (manifestTreeHash(staticFiles) !== rawDistManifest.treeSha256) {
    throw new Error("Bootstrap Vercel static tree hash differs");
  }
  if (staticFiles.some((file) => /^release-identity(?:\.|$)/.test(file.path))) {
    throw new Error("Bootstrap raw static tree contains a release identity");
  }
};

export const writeVerifiedArtifactObjects = async ({
  packageRoot,
  outputRoot,
  manifest,
  archivePolicy,
  scratchRoot,
  objectLabel,
}) => {
  const firstArchive = path.join(scratchRoot, `${objectLabel}.first.zip`);
  const secondArchive = path.join(scratchRoot, `${objectLabel}.second.zip`);
  const first = await createDeterministicZip({
    sourceDirectory: outputRoot,
    outputPath: firstArchive,
    policy: archivePolicy,
  });
  const second = await createDeterministicZip({
    sourceDirectory: outputRoot,
    outputPath: secondArchive,
    policy: archivePolicy,
  });
  if (first.archiveSha256 !== second.archiveSha256) {
    throw new Error("Repeated deterministic archive SHA-256 differs");
  }
  await Promise.all([
    verifyDeterministicZip({
      archivePath: firstArchive,
      expectedFiles: manifest.outputFiles,
    }),
    verifyDeterministicZip({
      archivePath: secondArchive,
      expectedFiles: manifest.outputFiles,
    }),
  ]);
  const [manifestReference, archiveReference] = await Promise.all([
    writeContentAddressedObject({
      packageRoot,
      bytes: canonicalJsonBytes(manifest),
      kind: "artifact-manifest.json",
    }),
    writeContentAddressedObject({
      packageRoot,
      bytes: await readFile(firstArchive),
      kind: "artifact.zip",
    }),
  ]);
  await rm(secondArchive, { force: true });
  await rm(firstArchive, { force: true });
  return {
    releaseRole: manifest.releaseRole,
    variantId: manifest.variantId,
    manifest: {
      uri: manifestReference.uri,
      sha256: manifestReference.sha256,
    },
    archive: {
      uri: archiveReference.uri,
      sha256: archiveReference.sha256,
    },
  };
};

export const buildSourceHardenedDimensions = (releasePolicy) => {
  const standard = { ...releasePolicy.initialStandard };
  const containment = projectContainmentDimensions(releasePolicy, standard);
  return { standard, containment };
};
