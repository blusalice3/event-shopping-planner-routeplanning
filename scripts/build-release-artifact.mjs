#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertBootstrapStaticOutput,
  assertIndependentBuildReproducibility,
  buildBootstrapGeneratedFiles,
  buildRawDistManifest,
  buildReleaseContext,
  buildSourceHardenedDimensions,
  calculateBuildInputClosure,
  collectPublicBuildEnvironment,
  createArtifactManifestFromOutput,
  createBootstrapInput,
  createBootstrapStaging,
  writeVerifiedArtifactObjects,
} from "./lib/artifact-builder-core.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "./lib/release-policy.mjs";
import {
  createReleaseBuildInput,
  RELEASE_BUILD_INPUT_ENV,
  releaseBuildInputEnvironment,
} from "./lib/release-build-input.mjs";
import { writeContentAddressedObject } from "./lib/content-addressed-store.mjs";
import { verifyReleasePackage } from "./verify-release-artifact.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(import.meta.url);

if (process.env[RELEASE_BUILD_INPUT_ENV] !== undefined) {
  const inheritedBuildInput = parseJsonStrict(
    process.env[RELEASE_BUILD_INPUT_ENV],
    RELEASE_BUILD_INPUT_ENV,
  );
  if (
    inheritedBuildInput?.nonPromotable === true ||
    inheritedBuildInput?.buildPurpose !== "production"
  ) {
    throw new Error(
      "Production artifact builder rejects inherited nonpromotable QA input",
    );
  }
}

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const commandOutput = (executable, args, cwd = repositoryRoot) =>
  execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const assertPathOutsideRepository = (targetPath) => {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(repositoryRoot, resolved);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new Error(
      "Release package output must be outside the source checkout",
    );
  }
  return resolved;
};

const assertAbsent = async (targetPath, label) => {
  try {
    await access(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${targetPath}`);
};

const assertCleanCheckout = () => {
  const status = commandOutput("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.length !== 0) {
    throw new Error("Release artifact build requires a clean checkout");
  }
  const sourceSha = commandOutput("git", ["rev-parse", "HEAD"]).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("Release source is not a full lowercase commit SHA");
  }
  return sourceSha;
};

const readPinnedVercelCli = async (toolchainPolicy) => {
  const packagePath = require.resolve("vercel/package.json");
  const packageJson = await readJsonStrict(packagePath);
  const expectedVersion = toolchainPolicy.packages?.vercel;
  if (
    typeof expectedVersion !== "string" ||
    packageJson.version !== expectedVersion
  ) {
    throw new Error(
      `Pinned Vercel CLI differs: ${packageJson.version} != ${expectedVersion}`,
    );
  }
  const relativeBin = packageJson.bin?.vercel;
  if (typeof relativeBin !== "string") {
    throw new Error("Pinned Vercel package has no CLI entry");
  }
  return path.resolve(path.dirname(packagePath), relativeBin);
};

const assertExactRuntime = (toolchainPolicy) => {
  const expectedNode = `v${toolchainPolicy.runtime.node}`;
  const actualNpm = commandOutput("npm", ["--version"]);
  if (
    process.version !== expectedNode ||
    actualNpm !== toolchainPolicy.runtime.npm
  ) {
    throw new Error(
      `Release runtime differs: Node ${process.version}/${expectedNode}, npm ${actualNpm}/${toolchainPolicy.runtime.npm}`,
    );
  }
};

const assertProviderCredentials = ({
  providerPolicy,
  providerObservation,
  environment,
}) => {
  const expected = {
    VERCEL_ORG_ID: providerPolicy.expectedTeamId,
    VERCEL_PROJECT_ID: providerPolicy.expectedProjectId,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (typeof environment[name] !== "string" || environment[name] !== value) {
      throw new Error(`${name} differs from the verified provider binding`);
    }
  }
  if (
    typeof environment.VERCEL_TOKEN !== "string" ||
    environment.VERCEL_TOKEN.length < 16
  ) {
    throw new Error("VERCEL_TOKEN is absent or invalid");
  }
  if (
    providerObservation.providerProjectId !== environment.VERCEL_PROJECT_ID ||
    providerObservation.providerTeamId !== environment.VERCEL_ORG_ID
  ) {
    throw new Error("Provider observation and build credentials differ");
  }
};

const runPinnedVercelBuild = ({ vercelCliPath, cwd, environment }) => {
  execFileSync(process.execPath, [vercelCliPath, "build", "--prod", "--yes"], {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
};

const assertCheckoutStillClean = () => {
  const status = commandOutput("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.length !== 0) {
    throw new Error("Vercel build changed the source checkout");
  }
};

const writePackageIndex = async (packageRoot, index) => {
  await writeFile(
    path.join(packageRoot, "release-package-index.json"),
    canonicalJsonBytes(index),
    { flag: "wx", mode: 0o600 },
  );
};

const buildSourceHardenedPackage = async ({
  packageRoot,
  scratchRoot,
  sourceSha,
  releasePolicy,
  releaseContext,
  archivePolicy,
  lockfileSha256,
  buildInputClosureHash,
  publicBuildEnvironment,
  vercelCliPath,
  standardDimensions,
  cspPolicy,
}) => {
  const dimensions = {
    standard: standardDimensions,
    containment: projectContainmentDimensions(
      releasePolicy,
      standardDimensions,
    ),
  };
  const references = [];
  for (const releaseRole of ["standard", "containment"]) {
    const roleDimensions = dimensions[releaseRole];
    const variantId = computeVariantId(releasePolicy, roleDimensions);
    const vercelRoot = path.join(repositoryRoot, ".vercel");
    const buildInput = createReleaseBuildInput({
      policy: releasePolicy,
      sourceSha,
      sourceState: "clean",
      releaseRole,
      dimensions: roleDimensions,
      variantId,
      dbFingerprint: releaseContext.requiredDbCompatibility.fingerprint,
    });
    const buildEnvironment = {
      ...process.env,
      ...publicBuildEnvironment.document.values,
      VITE_APP_BUILD_ID: sourceSha,
      VITE_PERSISTENCE_RELEASE_CHANNEL: "release-a",
      VITE_PERSISTENCE_LEGACY_CLEANUP: "false",
      ...releaseBuildInputEnvironment(buildInput, releasePolicy),
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: sourceSha,
    };
    let acceptedManifest = null;
    let acceptedReference = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assertAbsent(
        vercelRoot,
        `Vercel working directory before ${releaseRole} build ${attempt}`,
      );
      try {
        runPinnedVercelBuild({
          vercelCliPath,
          cwd: repositoryRoot,
          environment: buildEnvironment,
        });
        const outputRoot = path.join(vercelRoot, "output");
        const manifest = await createArtifactManifestFromOutput({
          outputRoot,
          releasePolicy,
          sourceSha,
          dimensions: roleDimensions,
          buildInputClosureHash,
          lockfileSha256,
          releaseContext,
          publicBuildEnvHash: publicBuildEnvironment.hash,
          publicIdentityKind: "release-identity-v1",
          bootstrap: null,
          cspPolicy,
        });
        if (acceptedManifest === null) {
          acceptedManifest = manifest;
          acceptedReference = await writeVerifiedArtifactObjects({
            packageRoot,
            outputRoot,
            manifest,
            archivePolicy,
            scratchRoot,
            objectLabel: releaseRole,
          });
        } else {
          assertIndependentBuildReproducibility({
            firstManifest: acceptedManifest,
            secondManifest: manifest,
            label: releaseRole,
          });
        }
      } finally {
        await rm(vercelRoot, { recursive: true, force: true });
      }
      assertCheckoutStillClean();
    }
    if (acceptedReference === null) {
      throw new Error(`${releaseRole} independent builds produced no artifact`);
    }
    references.push(acceptedReference);
  }
  const index = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha,
    buildId: sourceSha,
    toolchainPolicyHash: releaseContext.toolchainPolicyHash,
    providerConfigurationHash: releaseContext.providerConfigurationHash,
    providerPolicyHash: releaseContext.providerPolicyHash,
    releasePolicyHash: releaseContext.releasePolicyHash,
    requiredDbCompatibility: releaseContext.requiredDbCompatibility,
    artifacts: references,
  };
  await writePackageIndex(packageRoot, index);
};

const buildBootstrapPackage = async ({
  packageRoot,
  scratchRoot,
  rawDistRoot,
  foundationBaseline,
  releasePolicy,
  providerPolicy,
  releaseContext,
  archivePolicy,
  vercelCliPath,
}) => {
  const sourceSha = foundationBaseline.bootstrapBaselineSourceSha;
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      "Bootstrap baseline source is not provider-bound; production bootstrap is blocked",
    );
  }
  const rawDistManifest = await buildRawDistManifest(rawDistRoot);
  const rawDistManifestBytes = canonicalJsonBytes(rawDistManifest);
  const expectedRawDistManifestSha256 =
    foundationBaseline.baselineEvidence?.artifactObservation
      ?.rawDistManifestSha256;
  if (
    typeof expectedRawDistManifestSha256 !== "string" ||
    expectedRawDistManifestSha256 !== sha256Bytes(rawDistManifestBytes)
  ) {
    throw new Error(
      "Raw bootstrap dist manifest is not bound to foundation baseline evidence",
    );
  }
  const rawDistReference = await writeContentAddressedObject({
    packageRoot,
    bytes: rawDistManifestBytes,
    kind: "raw-dist-manifest.json",
  });
  const [
    metricsDisabledTemplateBytes,
    apiNotFoundTemplateBytes,
    stagingVerifierBytes,
  ] = await Promise.all([
    readFile(
      path.join(
        repositoryRoot,
        "scripts",
        "templates",
        "bootstrap-metrics-disabled.mjs",
      ),
    ),
    readFile(
      path.join(
        repositoryRoot,
        "scripts",
        "templates",
        "bootstrap-api-not-found.mjs",
      ),
    ),
    readFile(
      path.join(repositoryRoot, "scripts", "verify-bootstrap-staging.mjs"),
    ),
  ]);
  const generatedFiles = buildBootstrapGeneratedFiles(
    providerPolicy.providerNodeFamily,
    {
      metricsTemplateSha256: sha256Bytes(metricsDisabledTemplateBytes),
      notFoundTemplateSha256: sha256Bytes(apiNotFoundTemplateBytes),
    },
  );
  const bootstrapInput = createBootstrapInput({
    sourceSha,
    nodeVersion: foundationBaseline.baselineEvidence.runtime.node,
    npmVersion: foundationBaseline.baselineEvidence.runtime.npm,
    lockfileSha256: foundationBaseline.baselineEvidence.lockfileSha256,
    rawDistManifestReference: rawDistReference,
    metricsDisabledTemplateBytes,
    apiNotFoundTemplateBytes,
    stagingVerifierBytes,
    generatedFiles,
    providerProjectId: releaseContext.providerProjectId,
    providerConfigurationHash: releaseContext.providerConfigurationHash,
  });
  const bootstrapInputReference = await writeContentAddressedObject({
    packageRoot,
    bytes: canonicalJsonBytes(bootstrapInput),
    kind: "bootstrap-input.json",
  });
  const stagingRoot = path.join(scratchRoot, "bootstrap-staging");
  await createBootstrapStaging({
    stagingRoot,
    rawDistRoot,
    metricsDisabledTemplateBytes,
    apiNotFoundTemplateBytes,
    stagingVerifierBytes,
    generatedFiles,
  });
  const rawManifestPath = path.join(scratchRoot, "raw-dist-manifest.json");
  await writeFile(rawManifestPath, rawDistManifestBytes, { flag: "wx" });
  const verifierArguments = [
    path.join(stagingRoot, "scripts", "verify-bootstrap-staging.mjs"),
    "--root",
    stagingRoot,
    "--raw-dist-manifest",
    rawManifestPath,
    "--metrics-template-sha256",
    bootstrapInput.metricsDisabledTemplateSha256,
    "--not-found-template-sha256",
    bootstrapInput.apiNotFoundTemplateSha256,
  ];
  execFileSync(process.execPath, verifierArguments, {
    cwd: stagingRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  const buildEnvironment = {
    ...process.env,
    VERCEL: "1",
    VERCEL_GIT_COMMIT_SHA: sourceSha,
  };
  runPinnedVercelBuild({
    vercelCliPath,
    cwd: stagingRoot,
    environment: buildEnvironment,
  });
  const outputRoot = path.join(stagingRoot, ".vercel", "output");
  await assertBootstrapStaticOutput({ outputRoot, rawDistManifest });
  const standardDimensions = { ...releasePolicy.initialStandard };
  const containmentDimensions = projectContainmentDimensions(
    releasePolicy,
    standardDimensions,
  );
  const manifest = await createArtifactManifestFromOutput({
    outputRoot,
    releasePolicy,
    sourceSha,
    dimensions: containmentDimensions,
    buildInputClosureHash: sha256Json({
      schemaVersion: 1,
      bootstrapInputSha256: bootstrapInputReference.sha256,
      rawDistTreeSha256: rawDistManifest.treeSha256,
    }),
    lockfileSha256: bootstrapInput.lockfileSha256,
    releaseContext,
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
    archivePolicy,
    scratchRoot,
    objectLabel: "legacy-bootstrap",
  });
  const index = {
    schemaVersion: 1,
    packageKind: "legacy-bootstrap-single",
    sourceSha,
    buildId: sourceSha,
    toolchainPolicyHash: releaseContext.toolchainPolicyHash,
    providerConfigurationHash: releaseContext.providerConfigurationHash,
    providerPolicyHash: releaseContext.providerPolicyHash,
    releasePolicyHash: releaseContext.releasePolicyHash,
    requiredDbCompatibility: releaseContext.requiredDbCompatibility,
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
  await writePackageIndex(packageRoot, index);
};

const run = async () => {
  const outputArgument = option("--output");
  const providerObservationArgument = option("--provider-observation");
  const bootstrap = process.argv.includes("--bootstrap");
  const rawDistArgument = option("--raw-dist");
  const dimensionsArgument = option("--standard-dimensions");
  if (!outputArgument || !providerObservationArgument) {
    throw new Error(
      "Usage: node scripts/build-release-artifact.mjs --output <outside-checkout-directory> --provider-observation <json> [--standard-dimensions <json>] [--bootstrap --raw-dist <directory>]",
    );
  }
  if (bootstrap !== Boolean(rawDistArgument)) {
    throw new Error("--bootstrap and --raw-dist must be provided together");
  }
  const outputRoot = assertPathOutsideRepository(outputArgument);
  await assertAbsent(outputRoot, "Release package output");
  const sourceSha = assertCleanCheckout();
  const [
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    archivePolicy,
    foundationBaseline,
    cspPolicy,
  ] = await Promise.all([
    readJsonStrict(
      path.join(repositoryRoot, "config", "release-variants.json"),
    ),
    readJsonStrict(
      path.join(repositoryRoot, "config", "toolchain-versions.json"),
    ),
    readJsonStrict(path.join(repositoryRoot, "config", "provider-policy.json")),
    readJsonStrict(path.resolve(providerObservationArgument)),
    readJsonStrict(
      path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
    ),
    readJsonStrict(
      path.join(repositoryRoot, "config", "artifact-archive-policy.json"),
    ),
    readJsonStrict(
      path.join(repositoryRoot, "config", "foundation-baseline.json"),
    ),
    readJsonStrict(path.join(repositoryRoot, "config", "csp-policy.json")),
  ]);
  const releaseContext = buildReleaseContext({
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    requireProductionBindings: true,
  });
  assertExactRuntime(toolchainPolicy);
  assertProviderCredentials({
    providerPolicy,
    providerObservation,
    environment: process.env,
  });
  const vercelCliPath = await readPinnedVercelCli(toolchainPolicy);
  const packageLockBytes = await readFile(
    path.join(repositoryRoot, "package-lock.json"),
  );
  const effectivePublicEnvironment = {
    ...process.env,
    VITE_APP_BUILD_ID: sourceSha,
    VITE_PERSISTENCE_RELEASE_CHANNEL: "release-a",
    VITE_PERSISTENCE_LEGACY_CLEANUP: "false",
  };
  const publicBuildEnvironment = collectPublicBuildEnvironment(
    effectivePublicEnvironment,
  );
  const parent = path.dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const scratchRoot = await mkdtemp(
    path.join(parent, ".foundation-artifact-build-"),
  );
  const packageRoot = path.join(scratchRoot, "package");
  await mkdir(packageRoot, { recursive: true });
  try {
    if (bootstrap) {
      await buildBootstrapPackage({
        packageRoot,
        scratchRoot,
        rawDistRoot: path.resolve(rawDistArgument),
        foundationBaseline,
        releasePolicy,
        providerPolicy,
        releaseContext,
        archivePolicy,
        vercelCliPath,
      });
    } else {
      const standardDimensions = dimensionsArgument
        ? await readJsonStrict(path.resolve(dimensionsArgument))
        : buildSourceHardenedDimensions(releasePolicy).standard;
      const buildInputClosure = calculateBuildInputClosure({
        repositoryRoot,
        sourceSha,
      });
      await buildSourceHardenedPackage({
        packageRoot,
        scratchRoot,
        sourceSha,
        releasePolicy,
        releaseContext,
        archivePolicy,
        lockfileSha256: sha256Bytes(packageLockBytes),
        buildInputClosureHash: buildInputClosure.sha256,
        publicBuildEnvironment,
        vercelCliPath,
        standardDimensions,
        cspPolicy,
      });
    }
    const verification = await verifyReleasePackage({
      packageRoot,
      releasePolicy,
      toolchainPolicy,
      providerPolicy,
      providerObservation,
      dbContract,
      cspPolicy,
      requireProductionBindings: true,
      root: repositoryRoot,
      environment: process.env,
    });
    await rename(packageRoot, outputRoot);
    process.stdout.write(
      `PASS release artifact build: ${verification.index.packageKind}; index ${verification.packageIndexSha256}; ${outputRoot}\n`,
    );
  } finally {
    await rm(path.join(repositoryRoot, ".vercel"), {
      recursive: true,
      force: true,
    });
    await rm(scratchRoot, { recursive: true, force: true });
  }
  assertCheckoutStillClean();
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await run();
}
