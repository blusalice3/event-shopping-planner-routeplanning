import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";
import {
  assertIndependentOuterAgentGraph,
  OUTER_AGENT_ENTRY_MODULE,
  OUTER_AGENT_GRAPH_URL,
  OUTER_AGENT_URL,
  parseIndependentOuterAgentGraph,
} from "./lib/outer-agent-contract.mjs";
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
  outerAgent: OUTER_AGENT_URL,
  outerAgentGraph: OUTER_AGENT_GRAPH_URL,
  roleEntry: "/assets/release-role.js",
  serviceWorker: "/sw.js",
});

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const normalizeOuterModuleId = (moduleId) => {
  const normalized = moduleId.replaceAll("\\", "/");
  const normalizedRoot = repositoryRoot
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    throw new Error(
      `Independent outer agent contains a module outside the checkout: ${moduleId}`,
    );
  }
  return normalized.startsWith("\0")
    ? `virtual:${normalized.slice(1)}`
    : normalized;
};

export const buildIndependentOuterAgent = async ({
  outputDirectory,
  sourceSha,
}) => {
  assertSha(sourceSha, 40, "sourceSha");
  const outputRoot = path.resolve(outputDirectory);
  const entryPath = path.join(
    repositoryRoot,
    ...OUTER_AGENT_ENTRY_MODULE.split("/"),
  );
  let capturedModules = null;
  let capturedChunkModules = null;
  const graphPlugin = {
    name: "independent-outer-agent-graph",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(
        (entry) => entry.type === "chunk",
      );
      const entryChunk = chunks.find(
        (entry) =>
          entry.isEntry &&
          entry.facadeModuleId?.replaceAll("\\", "/") ===
            entryPath.replaceAll("\\", "/"),
      );
      if (!entryChunk || chunks.length !== 1) {
        throw new Error(
          "Independent outer agent must produce exactly one entry chunk",
        );
      }
      if (
        entryChunk.fileName !== OUTER_AGENT_URL.slice(1) ||
        entryChunk.imports.length !== 0 ||
        entryChunk.dynamicImports.length !== 0
      ) {
        throw new Error(
          "Independent outer agent has a role-specific chunk dependency",
        );
      }
      const moduleIds = new Set();
      const queue = [entryChunk.facadeModuleId];
      while (queue.length > 0) {
        const moduleId = queue.shift();
        if (
          moduleId === null ||
          moduleId === undefined ||
          moduleIds.has(moduleId)
        ) {
          continue;
        }
        const info = this.getModuleInfo(moduleId);
        if (!info) {
          throw new Error(
            `Outer agent module information is absent: ${moduleId}`,
          );
        }
        moduleIds.add(moduleId);
        if (info.code !== null) {
          queue.push(...info.importedIds, ...info.dynamicallyImportedIds);
        }
      }
      capturedModules = Array.from(moduleIds)
        .map((moduleId) => {
          const info = this.getModuleInfo(moduleId);
          if (!info) {
            throw new Error(
              `Outer agent module information is absent: ${moduleId}`,
            );
          }
          return {
            id: normalizeOuterModuleId(moduleId),
            external: info.code === null,
            staticImports: info.importedIds
              .map(normalizeOuterModuleId)
              .sort(compareUtf8),
            dynamicImports: info.dynamicallyImportedIds
              .map(normalizeOuterModuleId)
              .sort(compareUtf8),
          };
        })
        .sort((left, right) => compareUtf8(left.id, right.id));
      capturedChunkModules = Object.keys(entryChunk.modules)
        .map(normalizeOuterModuleId)
        .sort(compareUtf8);
    },
  };
  await viteBuild({
    configFile: false,
    root: repositoryRoot,
    mode: "release-a",
    logLevel: "silent",
    define: {
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": JSON.stringify("release-a"),
      "import.meta.env.SSR": "false",
    },
    plugins: [graphPlugin],
    build: {
      outDir: outputRoot,
      emptyOutDir: true,
      copyPublicDir: false,
      modulePreload: false,
      sourcemap: false,
      minify: "esbuild",
      rollupOptions: {
        input: entryPath,
        output: {
          entryFileNames: OUTER_AGENT_URL.slice(1),
          codeSplitting: false,
        },
      },
    },
  });
  if (capturedModules === null || capturedChunkModules === null) {
    throw new Error("Independent outer agent graph was not captured");
  }
  const outerAgentPath = path.join(
    outputRoot,
    ...OUTER_AGENT_URL.slice(1).split("/"),
  );
  const outerAgentBytes = await readFile(outerAgentPath);
  const graph = {
    schemaVersion: 1,
    graphKind: "single-entry-outer-agent-v1",
    sourceSha,
    entryModule: OUTER_AGENT_ENTRY_MODULE,
    entryFile: OUTER_AGENT_URL,
    modules: capturedModules,
    chunks: [
      {
        file: OUTER_AGENT_URL,
        sha256: sha256Bytes(outerAgentBytes),
        size: outerAgentBytes.length,
        staticImports: [],
        dynamicImports: [],
        modules: capturedChunkModules,
      },
    ],
  };
  assertIndependentOuterAgentGraph({ graph, sourceSha, outerAgentBytes });
  const graphPath = path.join(outputRoot, OUTER_AGENT_GRAPH_URL.slice(1));
  await writeFile(graphPath, canonicalJsonBytes(graph), { flag: "wx" });
  return {
    outerAgentPath,
    outerAgentBytes,
    outerAgentSha256: sha256Bytes(outerAgentBytes),
    graph,
    graphPath,
    graphSha256: sha256Bytes(canonicalJsonBytes(graph)),
  };
};

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
    ![
      "production",
      "qa-xlsx-main",
      "qa-list-force-full",
      "non-promotable-policy-activation-qa",
      "non-promotable-artifact-drill",
    ].includes(buildPurpose) ||
    typeof nonPromotable !== "boolean" ||
    nonPromotable !== (buildPurpose !== "production") ||
    (nonPromotable &&
      ![
        "non-promotable-policy-activation-qa",
        "non-promotable-artifact-drill",
      ].includes(buildPurpose) &&
      releaseRole !== "standard")
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
  const [outerAgent, outerAgentGraphBytes, roleEntry, serviceWorker] =
    await Promise.all([
      readOutput(distRoot, URLS.outerAgent),
      readOutput(distRoot, URLS.outerAgentGraph),
      readOutput(distRoot, URLS.roleEntry),
      readOutput(distRoot, URLS.serviceWorker),
    ]);
  parseIndependentOuterAgentGraph({
    graphBytes: outerAgentGraphBytes,
    sourceSha,
    outerAgentBytes: outerAgent,
  });
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
