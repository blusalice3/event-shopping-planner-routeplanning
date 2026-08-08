#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import {
  assertArtifactManifest,
  assertBootstrapInput,
  assertBootstrapRelationship,
  assertManifestMatchesOutput,
  assertPairRelationship,
  assertReleasePackageIndex,
  buildPublicResponseHashes,
  canonicalArtifactBytes,
  readAndVerifyCapability,
  readAndVerifyPublicIdentity,
  readAndVerifyRoleEntryGraph,
} from "./lib/artifact-contract.mjs";
import {
  assertBootstrapStaticOutput,
  assertProductionDbContract,
  assertProductionProviderContext,
  assertVercelOutputShape,
  buildBootstrapGeneratedFiles,
} from "./lib/artifact-builder-core.mjs";
import {
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import { resolveContentAddressedObject } from "./lib/content-addressed-store.mjs";
import {
  assertSafeRelativePath,
  manifestTreeHash,
} from "./lib/file-manifest.mjs";
import { verifyDeterministicZip } from "./deterministic-zip.mjs";
import { providerConfigurationHash } from "./provider/providerConfiguration.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertCanonicalJsonBytes = (bytes, parsed, label) => {
  if (!bytes.equals(canonicalArtifactBytes(parsed))) {
    throw new Error(`${label} is not encoded as exact canonical JSON bytes`);
  }
};

const readPackageIndex = async (packageRoot) => {
  const indexPath = path.join(packageRoot, "release-package-index.json");
  const bytes = await readFile(indexPath);
  const index = parseJsonStrict(bytes.toString("utf8"), indexPath);
  assertCanonicalJsonBytes(bytes, index, "ReleasePackageIndex");
  assertReleasePackageIndex(index);
  return { index, bytes, path: indexPath };
};

const extractVerifiedZip = async ({ archivePath, destination }) => {
  const openZip = promisify(yauzl.open);
  const archive = await openZip(archivePath, {
    lazyEntries: true,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const folded = new Set();
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      archive.close();
      reject(error);
    };
    archive.once("error", fail);
    archive.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    archive.on("entry", (entry) => {
      void (async () => {
        try {
          assertSafeRelativePath(entry.fileName);
          if (entry.fileName.endsWith("/")) {
            throw new Error(
              `Directory ZIP entry is forbidden: ${entry.fileName}`,
            );
          }
          const foldedPath = entry.fileName.toLocaleLowerCase("en-US");
          if (folded.has(foldedPath)) {
            throw new Error(
              `Duplicate/case-colliding ZIP path: ${entry.fileName}`,
            );
          }
          folded.add(foldedPath);
          const target = path.join(destination, ...entry.fileName.split("/"));
          const relative = path.relative(destination, target);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(
              `ZIP entry escapes extraction root: ${entry.fileName}`,
            );
          }
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise((resolveStream, rejectStream) => {
            archive.openReadStream(entry, (error, value) => {
              if (error) rejectStream(error);
              else resolveStream(value);
            });
          });
          await pipeline(
            stream,
            createWriteStream(target, { flags: "wx", mode: 0o600 }),
          );
          archive.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    archive.readEntry();
  });
};

const assertContractSchemas = async (root) => {
  const expected = new Map([
    [
      "contracts/artifact-manifest-v1.schema.json",
      "urn:event-shopping-planner:artifact-manifest:v1",
    ],
    [
      "contracts/release-package-index-v1.schema.json",
      "urn:event-shopping-planner:release-package-index:v1",
    ],
    [
      "contracts/bootstrap-input-v1.schema.json",
      "urn:event-shopping-planner:bootstrap-input:v1",
    ],
    [
      "contracts/release-identity-v1.schema.json",
      "urn:event-shopping-planner:release-identity:v1",
    ],
  ]);
  for (const [relativePath, expectedId] of expected) {
    const schema = await readJsonStrict(path.join(root, relativePath));
    if (
      schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
      schema.$id !== expectedId
    ) {
      throw new Error(`${relativePath} is not the frozen draft-2020-12 schema`);
    }
  }
};

const scanArtifactOutput = async ({
  outputRoot,
  outputFiles,
  environment,
  forbiddenRoots,
}) => {
  const secretValues = Object.entries(environment)
    .filter(
      ([name, value]) =>
        value &&
        String(value).length >= 12 &&
        /(?:TOKEN|SECRET|PASSWORD|PRIVATE|SERVICE_ROLE_KEY|DATABASE_URL)/i.test(
          name,
        ),
    )
    .map(([, value]) => Buffer.from(String(value), "utf8"));
  const forbiddenByteSequences = [
    ...forbiddenRoots
      .filter(Boolean)
      .flatMap((root) => [
        Buffer.from(path.resolve(root), "utf8"),
        Buffer.from(path.resolve(root).replaceAll("\\", "/"), "utf8"),
      ]),
    ...secretValues,
  ].filter((bytes) => bytes.length >= 4);
  for (const file of outputFiles) {
    if (
      /(?:^|\/)\.env(?:\.|$)/i.test(file.path) ||
      file.path.endsWith(".map")
    ) {
      throw new Error(`Forbidden artifact file: ${file.path}`);
    }
    if (file.size > 32 * 1024 * 1024) continue;
    const bytes = await readFile(
      path.join(outputRoot, ...file.path.split("/")),
    );
    if (forbiddenByteSequences.some((needle) => bytes.includes(needle))) {
      throw new Error(
        `Artifact file contains a secret or absolute workspace path: ${file.path}`,
      );
    }
  }
};

const assertPublicResponseHashes = async ({ outputRoot, manifest }) => {
  const actual = await buildPublicResponseHashes(
    outputRoot,
    Object.keys(manifest.publicResponseHashes),
  );
  if (
    canonicalArtifactBytes(actual).compare(
      canonicalArtifactBytes(manifest.publicResponseHashes),
    ) !== 0
  ) {
    throw new Error("Artifact public response hash map differs from output");
  }
};

const verifyArtifactReference = async ({
  packageRoot,
  reference,
  releasePolicy,
  scratchRoot,
  environment,
  forbiddenRoots,
  cspPolicy,
}) => {
  const [manifestObject, archiveObject] = await Promise.all([
    resolveContentAddressedObject({
      packageRoot,
      reference: reference.manifest,
      expectedKind: "artifact-manifest.json",
    }),
    resolveContentAddressedObject({
      packageRoot,
      reference: reference.archive,
      expectedKind: "artifact.zip",
    }),
  ]);
  const manifest = parseJsonStrict(
    manifestObject.bytes.toString("utf8"),
    reference.manifest.uri,
  );
  assertCanonicalJsonBytes(manifestObject.bytes, manifest, "ArtifactManifest");
  assertArtifactManifest(manifest, releasePolicy);
  if (
    manifest.releaseRole !== reference.releaseRole ||
    manifest.variantId !== reference.variantId
  ) {
    throw new Error("Artifact reference identity differs from manifest");
  }
  await verifyDeterministicZip({
    archivePath: archiveObject.path,
    expectedFiles: manifest.outputFiles,
  });
  const outputRoot = path.join(scratchRoot, manifest.releaseRole);
  await mkdir(outputRoot, { recursive: true });
  await extractVerifiedZip({
    archivePath: archiveObject.path,
    destination: outputRoot,
  });
  await assertManifestMatchesOutput(outputRoot, manifest);
  await assertVercelOutputShape(outputRoot, {
    publicIdentityKind: manifest.publicIdentityKind,
    cspPolicy,
  });
  await assertPublicResponseHashes({ outputRoot, manifest });
  await readAndVerifyRoleEntryGraph({ outputRoot, manifest });
  await scanArtifactOutput({
    outputRoot,
    outputFiles: manifest.outputFiles,
    environment,
    forbiddenRoots,
  });
  const capability = await readAndVerifyCapability({ outputRoot, manifest });
  const publicIdentity =
    manifest.publicIdentityKind === "release-identity-v1"
      ? await readAndVerifyPublicIdentity({ outputRoot, manifest })
      : null;
  return {
    manifest,
    manifestObject,
    archiveObject,
    outputRoot,
    capability,
    publicIdentity,
  };
};

const assertExpectedContext = ({
  index,
  releasePolicy,
  toolchainPolicy,
  providerPolicy,
  providerObservation,
  dbContract,
  requireProductionBindings,
}) => {
  const expected = {
    releasePolicyHash: sha256Json(releasePolicy),
    toolchainPolicyHash: sha256Json(toolchainPolicy),
    providerPolicyHash: sha256Json(providerPolicy),
    requiredDbCompatibility: {
      contractUri: dbContract.contractUri,
      fingerprint: sha256Json(dbContract),
    },
  };
  for (const [field, value] of Object.entries(expected)) {
    if (field === "requiredDbCompatibility") continue;
    if (index[field] !== value) {
      throw new Error(`Package index ${field} differs from local policy`);
    }
  }
  if (
    index.requiredDbCompatibility.contractUri !==
      expected.requiredDbCompatibility.contractUri ||
    index.requiredDbCompatibility.fingerprint !==
      expected.requiredDbCompatibility.fingerprint
  ) {
    throw new Error("Package index DB compatibility differs from contract");
  }
  if (providerObservation !== null) {
    if (
      index.providerConfigurationHash !==
      providerConfigurationHash(providerObservation)
    ) {
      throw new Error("Package provider configuration hash differs");
    }
  } else if (requireProductionBindings) {
    throw new Error("Production verification requires provider observation");
  }
  if (requireProductionBindings) {
    assertProductionProviderContext(providerPolicy, providerObservation);
    const productionDb = assertProductionDbContract(dbContract);
    if (
      productionDb.fingerprint !== index.requiredDbCompatibility.fingerprint
    ) {
      throw new Error("Production DB contract fingerprint differs");
    }
  }
};

const parseRawDistManifest = (bytes, label) => {
  const manifest = parseJsonStrict(bytes.toString("utf8"), label);
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !SHA256_PATTERN.test(manifest.treeSha256)
  ) {
    throw new Error("Raw dist manifest is invalid");
  }
  let previousPath = null;
  const folded = new Set();
  for (const file of manifest.files) {
    assertSafeRelativePath(file.path);
    if (
      typeof file.sha256 !== "string" ||
      !SHA256_PATTERN.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error(`Raw dist manifest entry is invalid: ${file.path}`);
    }
    if (previousPath !== null && compareUtf8(previousPath, file.path) >= 0) {
      throw new Error("Raw dist manifest is not in UTF-8 byte order");
    }
    previousPath = file.path;
    const key = file.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) {
      throw new Error(`Raw dist manifest case collision: ${file.path}`);
    }
    folded.add(key);
  }
  if (manifestTreeHash(manifest.files) !== manifest.treeSha256) {
    throw new Error("Raw dist manifest tree SHA-256 is invalid");
  }
  assertCanonicalJsonBytes(bytes, manifest, "raw dist manifest");
  return manifest;
};

const assertBootstrapInputRepositoryBinding = async ({
  bootstrapInput,
  root,
  providerPolicy,
}) => {
  const [metricsBytes, notFoundBytes, verifierBytes] = await Promise.all([
    readFile(
      path.join(root, "scripts", "templates", "bootstrap-metrics-disabled.mjs"),
    ),
    readFile(
      path.join(root, "scripts", "templates", "bootstrap-api-not-found.mjs"),
    ),
    readFile(path.join(root, "scripts", "verify-bootstrap-staging.mjs")),
  ]);
  const comparisons = [
    [
      "metricsDisabledTemplateSha256",
      bootstrapInput.metricsDisabledTemplateSha256,
      sha256Bytes(metricsBytes),
    ],
    [
      "apiNotFoundTemplateSha256",
      bootstrapInput.apiNotFoundTemplateSha256,
      sha256Bytes(notFoundBytes),
    ],
    [
      "stagingVerifierSha256",
      bootstrapInput.stagingVerifierSha256,
      sha256Bytes(verifierBytes),
    ],
  ];
  const generatedFiles = buildBootstrapGeneratedFiles(
    providerPolicy.providerNodeFamily,
    {
      metricsTemplateSha256: bootstrapInput.metricsDisabledTemplateSha256,
      notFoundTemplateSha256: bootstrapInput.apiNotFoundTemplateSha256,
    },
  );
  comparisons.push(
    [
      "generatedPackageSha256",
      bootstrapInput.generatedPackageSha256,
      sha256Bytes(generatedFiles.packageBytes),
    ],
    [
      "generatedLockfileSha256",
      bootstrapInput.generatedLockfileSha256,
      sha256Bytes(generatedFiles.lockfileBytes),
    ],
    [
      "generatedVercelConfigSha256",
      bootstrapInput.generatedVercelConfigSha256,
      sha256Bytes(generatedFiles.vercelConfigBytes),
    ],
  );
  const mismatches = comparisons
    .filter(([, actual, expected]) => actual !== expected)
    .map(([label]) => label);
  if (mismatches.length > 0) {
    throw new Error(`Bootstrap fixed input differs: ${mismatches.join(", ")}`);
  }
};

export const verifyReleasePackage = async ({
  packageRoot,
  releasePolicy,
  toolchainPolicy,
  providerPolicy,
  providerObservation = null,
  dbContract,
  cspPolicy,
  requireProductionBindings = false,
  root = repositoryRoot,
  environment = process.env,
}) => {
  const resolvedPackageRoot = path.resolve(packageRoot);
  await assertContractSchemas(root);
  const { index, bytes: indexBytes } =
    await readPackageIndex(resolvedPackageRoot);
  assertExpectedContext({
    index,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    requireProductionBindings,
  });
  const scratchRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-artifact-verify-"),
  );
  try {
    if (index.packageKind === "source-hardened-pair") {
      const standard = await verifyArtifactReference({
        packageRoot: resolvedPackageRoot,
        reference: index.artifacts[0],
        releasePolicy,
        scratchRoot,
        environment,
        forbiddenRoots: [resolvedPackageRoot, root],
        cspPolicy,
      });
      const containment = await verifyArtifactReference({
        packageRoot: resolvedPackageRoot,
        reference: index.artifacts[1],
        releasePolicy,
        scratchRoot,
        environment,
        forbiddenRoots: [resolvedPackageRoot, root],
        cspPolicy,
      });
      assertPairRelationship({
        index,
        standardManifest: standard.manifest,
        containmentManifest: containment.manifest,
        releasePolicy,
      });
      if (!standard.capability.bytes.equals(containment.capability.bytes)) {
        throw new Error(
          "Standard and containment Release A capability bytes differ",
        );
      }
      if (
        standard.publicIdentity === null ||
        containment.publicIdentity === null ||
        standard.publicIdentity.bytes.equals(containment.publicIdentity.bytes)
      ) {
        throw new Error(
          "Source-hardened role identity bytes must exist and differ",
        );
      }
    } else {
      const bootstrapObject = await resolveContentAddressedObject({
        packageRoot: resolvedPackageRoot,
        reference: index.bootstrapInput,
        expectedKind: "bootstrap-input.json",
      });
      const rawDistObject = await resolveContentAddressedObject({
        packageRoot: resolvedPackageRoot,
        reference: index.rawDistManifest,
        expectedKind: "raw-dist-manifest.json",
      });
      const artifact = await verifyArtifactReference({
        packageRoot: resolvedPackageRoot,
        reference: index.artifact,
        releasePolicy,
        scratchRoot,
        environment,
        forbiddenRoots: [resolvedPackageRoot, root],
        cspPolicy,
      });
      const bootstrapInput = parseJsonStrict(
        bootstrapObject.bytes.toString("utf8"),
        index.bootstrapInput.uri,
      );
      assertCanonicalJsonBytes(
        bootstrapObject.bytes,
        bootstrapInput,
        "BootstrapInput",
      );
      assertBootstrapInput(bootstrapInput);
      const rawDistManifest = parseRawDistManifest(
        rawDistObject.bytes,
        index.rawDistManifest.uri,
      );
      assertBootstrapRelationship({
        index,
        manifest: artifact.manifest,
        bootstrapInput,
      });
      await assertBootstrapInputRepositoryBinding({
        bootstrapInput,
        root,
        providerPolicy,
      });
      await assertBootstrapStaticOutput({
        outputRoot: artifact.outputRoot,
        rawDistManifest,
      });
      if (artifact.publicIdentity !== null) {
        throw new Error("Legacy bootstrap cannot contain ReleaseIdentity");
      }
    }
    return {
      index,
      packageIndexSha256: sha256Bytes(indexBytes),
      productionEligible: requireProductionBindings,
    };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
};

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const runCli = async () => {
  const packageRoot = option("--package");
  if (!packageRoot) {
    throw new Error(
      "Usage: node scripts/verify-release-artifact.mjs --package <directory> [--provider-observation <json>] [--require-production-bindings]",
    );
  }
  const providerObservationPath = option("--provider-observation");
  const requireProductionBindings = process.argv.includes(
    "--require-production-bindings",
  );
  const [
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    dbContract,
    cspPolicy,
    providerObservation,
  ] = await Promise.all([
    readJsonStrict(
      path.join(repositoryRoot, "config", "release-variants.json"),
    ),
    readJsonStrict(
      path.join(repositoryRoot, "config", "toolchain-versions.json"),
    ),
    readJsonStrict(path.join(repositoryRoot, "config", "provider-policy.json")),
    readJsonStrict(
      path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
    ),
    readJsonStrict(path.join(repositoryRoot, "config", "csp-policy.json")),
    providerObservationPath
      ? readJsonStrict(path.resolve(providerObservationPath))
      : Promise.resolve(null),
  ]);
  const result = await verifyReleasePackage({
    packageRoot: path.resolve(packageRoot),
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    cspPolicy,
    requireProductionBindings,
  });
  const mode = result.productionEligible
    ? "production-binding"
    : "local-structure-only";
  process.stdout.write(
    `PASS release artifact (${mode}): ${result.index.packageKind}; index ${result.packageIndexSha256}\n`,
  );
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await runCli();
}
