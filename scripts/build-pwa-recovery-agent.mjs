import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  assertDimensionObject,
  computeVariantId,
  projectContainmentDimensions,
} from "./lib/release-policy.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const URLS = Object.freeze({
  outerAgent: "/assets/outer-recovery-agent.js",
  roleEntry: "/assets/release-role.js",
  serviceWorker: "/sw.js",
});

const assertSha = (value, length, label) => {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${length}}$`).test(value)
  ) {
    throw new Error(`${label} must be a lowercase ${length}-character hash`);
  }
  return value;
};

const readOutput = async (distRoot, url) => {
  const filePath = path.join(distRoot, ...url.slice(1).split("/"));
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`PWA build output is missing or empty: ${url}`);
  }
  return readFile(filePath);
};

export const buildPwaRecoveryIdentity = async ({
  distDirectory,
  sourceSha,
  releaseRole,
  dimensions: suppliedDimensions = null,
  variantId: suppliedVariantId = null,
  dbFingerprint,
  buildPurpose = "production",
  nonPromotable = buildPurpose !== "production",
}) => {
  const distRoot = path.resolve(distDirectory);
  assertSha(sourceSha, 40, "sourceSha");
  assertSha(dbFingerprint, 64, "dbFingerprint");
  if (releaseRole !== "standard" && releaseRole !== "containment") {
    throw new Error(`Unsupported release role: ${releaseRole}`);
  }
  if (
    !["production", "qa-xlsx-main", "qa-list-force-full"].includes(
      buildPurpose,
    ) ||
    typeof nonPromotable !== "boolean" ||
    nonPromotable !== (buildPurpose !== "production") ||
    (nonPromotable && releaseRole !== "standard")
  ) {
    throw new Error("Release identity build purpose is invalid");
  }

  const policy = await readJsonStrict(
    path.join(repositoryRoot, "config", "release-variants.json"),
  );
  const dimensions =
    suppliedDimensions ??
    (releaseRole === "standard"
      ? policy.targetStandard
      : projectContainmentDimensions(policy, policy.targetStandard));
  assertDimensionObject(policy, dimensions);
  if (dimensions.releaseRole !== releaseRole) {
    throw new Error("Release identity role differs from supplied dimensions");
  }
  const variantId = computeVariantId(policy, dimensions);
  if (suppliedVariantId !== null && suppliedVariantId !== variantId) {
    throw new Error(
      "Release identity variant differs from supplied dimensions",
    );
  }
  const [outerAgent, roleEntry, serviceWorker] = await Promise.all([
    readOutput(distRoot, URLS.outerAgent),
    readOutput(distRoot, URLS.roleEntry),
    readOutput(distRoot, URLS.serviceWorker),
  ]);
  const versionedIdentityUrl = `/release-identity.${sourceSha}.${variantId}.json`;
  const serviceWorkerSource = serviceWorker.toString("utf8");
  if (!serviceWorkerSource.includes(versionedIdentityUrl)) {
    throw new Error(
      "Service Worker does not precache the source/variant-addressed identity",
    );
  }
  if (
    /\burl\s*:\s*["']\/release-identity\.json["']/.test(serviceWorkerSource) ||
    /\bskipWaiting\s*\(|\bclients\.claim\s*\(/.test(serviceWorkerSource)
  ) {
    throw new Error(
      "Service Worker violates stable-identity or natural-activation policy",
    );
  }

  const identityBase = {
    schemaVersion: 1,
    sourceSha,
    buildId: sourceSha,
    variantId,
    releaseRole,
    requiredDbCompatibilityFingerprint: dbFingerprint,
    ...(nonPromotable ? { buildPurpose, nonPromotable: true } : {}),
  };
  const identity =
    dimensions.pwaLifecycle === "legacy-auto-update-v1"
      ? {
          ...identityBase,
          pwaLifecycle: dimensions.pwaLifecycle,
          appEntryUrl: URLS.outerAgent,
          appEntrySha256: sha256Bytes(outerAgent),
          serviceWorkerUrl: URLS.serviceWorker,
          serviceWorkerSha256: sha256Bytes(serviceWorker),
        }
      : {
          ...identityBase,
          pwaLifecycle: dimensions.pwaLifecycle,
          roleEntryUrl: URLS.roleEntry,
          roleEntrySha256: sha256Bytes(roleEntry),
          serviceWorkerUrl: URLS.serviceWorker,
          serviceWorkerSha256: sha256Bytes(serviceWorker),
          outerAgentUrl: URLS.outerAgent,
          outerAgentSha256: sha256Bytes(outerAgent),
        };
  const canonicalBytes = canonicalJsonBytes(identity);
  const stablePath = path.join(distRoot, "release-identity.json");
  const versionedPath = path.join(distRoot, versionedIdentityUrl.slice(1));
  await Promise.all([
    writeFile(stablePath, canonicalBytes, { flag: "wx" }),
    writeFile(versionedPath, canonicalBytes, { flag: "wx" }),
  ]);
  return {
    identity,
    dimensions,
    identitySha256: sha256Bytes(canonicalBytes),
    dimensionsSha256: sha256Json(dimensions),
    stablePath,
    versionedPath,
  };
};

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await buildPwaRecoveryIdentity({
    distDirectory: argument("--dist") ?? path.join(repositoryRoot, "dist"),
    sourceSha: assertSha(argument("--source-sha"), 40, "--source-sha"),
    releaseRole: argument("--role"),
    dbFingerprint: assertSha(
      argument("--db-fingerprint"),
      64,
      "--db-fingerprint",
    ),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceSha: result.identity.sourceSha,
        variantId: result.identity.variantId,
        releaseRole: result.identity.releaseRole,
        identitySha256: result.identitySha256,
      },
      null,
      2,
    )}\n`,
  );
}
