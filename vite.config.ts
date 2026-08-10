import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import cspReportHandler from "./api/csp-report.mjs";
import notFoundHandler from "./api/not-found.mjs";
import {
  assertCspMode,
  cspReportSinkContract,
  renderCspHeaders,
} from "./scripts/lib/csp-delivery.mjs";
import {
  assertReleaseBuildLauncherBinding,
  resolveReleaseBuildInput,
} from "./scripts/lib/release-build-input.mjs";
import {
  OUTER_AGENT_BUNDLE_ENV,
  OUTER_AGENT_GRAPH_ENV,
  OUTER_AGENT_GRAPH_URL,
  OUTER_AGENT_URL,
  parseIndependentOuterAgentGraph,
} from "./scripts/lib/outer-agent-contract.mjs";
import { injectStaticApplicationStylesheetLink } from "./scripts/lib/application-stylesheet-contract.mjs";

type ReleaseDimensions = Record<string, string>;
type CspPolicy = {
  readonly reportEndpoint: string;
  readonly directives: Record<string, string[]>;
  readonly securityHeaders: Record<string, string>;
};

const projectRoot = process.cwd();
const releasePolicy = JSON.parse(
  readFileSync(
    path.join(projectRoot, "config", "release-variants.json"),
    "utf8",
  ),
) as {
  dimensions: Record<string, string[]>;
  targetStandard: ReleaseDimensions;
  containmentProjection: Record<string, Partial<ReleaseDimensions>>;
};
const dbContract = JSON.parse(
  readFileSync(
    path.join(projectRoot, "config", "db-compatibility-contract.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const cspPolicy = JSON.parse(
  readFileSync(path.join(projectRoot, "config", "csp-policy.json"), "utf8"),
) as CspPolicy;

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Unsupported canonical build value");
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const readGitSource = (): { sourceSha: string; sourceState: string } => {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .toLowerCase();
  const sourceState =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length === 0
      ? "clean"
      : "dirty";
  return { sourceSha, sourceState };
};

const getBuildIdentity = () => {
  const git = readGitSource();
  const providerCommitSha =
    process.env.VERCEL === "1" &&
    /^[0-9a-f]{40}$/i.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "")
      ? process.env.VERCEL_GIT_COMMIT_SHA!.toLowerCase()
      : null;
  const input = resolveReleaseBuildInput({
    policy: releasePolicy,
    environment: process.env,
    gitSourceSha: git.sourceSha,
    gitSourceState: git.sourceState,
    providerCommitSha,
    defaultDbFingerprint: sha256(canonicalize(dbContract)),
  });
  const qaProfileIndex = process.argv.indexOf("--qa-profile");
  const qaProfile =
    qaProfileIndex === -1 ? null : (process.argv[qaProfileIndex + 1] ?? null);
  const cliBuildPurpose = qaProfile === null ? "production" : `qa-${qaProfile}`;
  assertReleaseBuildLauncherBinding(
    input,
    releasePolicy,
    cliBuildPurpose === "production" ||
      cliBuildPurpose === "qa-xlsx-main" ||
      cliBuildPurpose === "qa-list-force-full"
      ? cliBuildPurpose
      : null,
  );
  return {
    ...input,
    versionedIdentityUrl: `/release-identity.${input.sourceSha}.${input.variantId}.json`,
  };
};

const RELEASE_CAPABILITY_MANIFEST = "release-capabilities.json";
const ROLE_ENTRY_URL = "/assets/release-role.js";
const ROLE_ENTRY_GRAPH_URL = "/release-role-graph.json";
const QA_XLSX_VIRTUAL_MODULE = "\0foundation-qa-xlsx-main";

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const normalizeModuleId = (moduleId: string): string => {
  const normalized = moduleId.replaceAll("\\", "/");
  if (normalized.startsWith("\0")) {
    return `virtual:${normalized.slice(1)}`;
  }
  const normalizedRoot = projectRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized === normalizedRoot) return ".";
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    throw new Error(
      `Role entry graph contains a module outside the checkout: ${moduleId}`,
    );
  }
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw new Error("Role entry graph contains an invalid module ID");
  }
  return normalized;
};

const createIndependentOuterAgentInjectionPlugin = (
  identity: ReturnType<typeof getBuildIdentity>,
): Plugin => {
  const bundlePath = process.env[OUTER_AGENT_BUNDLE_ENV];
  const graphPath = process.env[OUTER_AGENT_GRAPH_ENV];
  if (!bundlePath || !graphPath) {
    throw new Error(
      "Release build requires an independently built outer agent and graph",
    );
  }
  const outerAgentBytes = readFileSync(path.resolve(bundlePath));
  const graphBytes = readFileSync(path.resolve(graphPath));
  parseIndependentOuterAgentGraph({
    graphBytes,
    sourceSha: identity.sourceSha,
    outerAgentBytes,
  });
  return {
    name: "independent-outer-agent-injection",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const sourceEntry =
          /<script\s+type=["']module["']\s+src=["']\/src\/pwa\/recovery\/outerAgentEntry\.ts["']\s*><\/script>/g;
        const matches = html.match(sourceEntry);
        if (matches?.length !== 1) {
          throw new Error(
            "HTML must contain exactly one source outer-agent entry",
          );
        }
        return html.replace(
          sourceEntry,
          "<!-- foundation-independent-outer-agent-entry -->",
        );
      },
    },
    buildStart() {
      this.emitFile({
        type: "asset",
        fileName: OUTER_AGENT_URL.slice(1),
        source: outerAgentBytes,
      });
      this.emitFile({
        type: "asset",
        fileName: OUTER_AGENT_GRAPH_URL.slice(1),
        source: graphBytes,
      });
    },
    generateBundle(_options, bundle) {
      const htmlShell = Object.entries(bundle).find(
        ([, entry]) =>
          entry.type === "chunk" && entry.isEntry && entry.name === "app",
      );
      if (htmlShell) {
        const [fileName, chunk] = htmlShell;
        const htmlShellModules =
          chunk.type === "chunk" ? Object.keys(chunk.modules) : [];
        if (
          chunk.type !== "chunk" ||
          chunk.imports.length !== 0 ||
          chunk.dynamicImports.length !== 0 ||
          htmlShellModules.some((moduleId) => {
            const normalized = normalizeModuleId(moduleId);
            return (
              normalized.startsWith("src/") && !normalized.endsWith(".css")
            );
          })
        ) {
          throw new Error(
            "HTML shell unexpectedly contains role-dependent code",
          );
        }
        delete bundle[fileName];
      }
      const roleDependentOuterEntry = Object.values(bundle).find(
        (entry) =>
          entry.type === "chunk" &&
          entry.facadeModuleId
            ?.replaceAll("\\", "/")
            .endsWith("/src/pwa/recovery/outerAgentEntry.ts"),
      );
      if (roleDependentOuterEntry) {
        throw new Error(
          "Role build regenerated the independent outer-agent entry",
        );
      }
    },
  };
};

const createIndependentOuterAgentHtmlPlugin = (): Plugin => ({
  name: "independent-outer-agent-html",
  transformIndexHtml: {
    order: "post",
    handler(html) {
      const marker = "<!-- foundation-independent-outer-agent-entry -->";
      if (html.split(marker).length !== 2) {
        throw new Error(
          "Built HTML has no unique independent outer-agent marker",
        );
      }
      return html.replace(
        marker,
        `<script type="module" src="${OUTER_AGENT_URL}"></script>`,
      );
    },
  },
});

const createStaticApplicationStylesheetPlugin = (): Plugin => ({
  name: "static-application-stylesheet",
  enforce: "post",
  generateBundle(_options, bundle) {
    const htmlAssets = Object.values(bundle).filter(
      (entry) => entry.type === "asset" && entry.fileName === "index.html",
    );
    if (htmlAssets.length !== 1 || htmlAssets[0]?.type !== "asset") {
      throw new Error(
        `Built output must contain exactly one index HTML asset; found ${htmlAssets.length}`,
      );
    }
    const htmlAsset = htmlAssets[0];
    const result = injectStaticApplicationStylesheetLink({
      html:
        typeof htmlAsset.source === "string"
          ? htmlAsset.source
          : Buffer.from(htmlAsset.source).toString("utf8"),
      cssAssets: Object.values(bundle)
        .filter(
          (entry) => entry.type === "asset" && entry.fileName.endsWith(".css"),
        )
        .map((entry) => ({
          fileName: entry.fileName,
          source: entry.type === "asset" ? entry.source : "",
        })),
    });
    htmlAsset.source = result.html;
  },
});

const createRoleEntryGraphPlugin = (
  identity: ReturnType<typeof getBuildIdentity>,
  roleEntry: string,
): Plugin => ({
  name: "release-role-entry-graph",
  generateBundle(_options, bundle) {
    const entryChunk = Object.values(bundle).find(
      (entry) =>
        entry.type === "chunk" &&
        entry.isEntry &&
        entry.facadeModuleId?.replaceAll("\\", "/") ===
          roleEntry.replaceAll("\\", "/"),
    );
    if (!entryChunk || entryChunk.type !== "chunk") {
      throw new Error("Release role entry chunk is absent from Rollup output");
    }
    if (entryChunk.facadeModuleId === null) {
      throw new Error("Release role entry chunk has no facade module");
    }
    const entryModuleId = entryChunk.facadeModuleId;

    const moduleIds = new Set<string>();
    const moduleQueue = [entryModuleId];
    while (moduleQueue.length > 0) {
      const moduleId = moduleQueue.shift();
      if (moduleId === undefined || moduleIds.has(moduleId)) continue;
      const moduleInfo = this.getModuleInfo(moduleId);
      if (!moduleInfo) {
        throw new Error(`Rollup module information is absent: ${moduleId}`);
      }
      moduleIds.add(moduleId);
      if (moduleInfo.code !== null) {
        moduleQueue.push(
          ...moduleInfo.importedIds,
          ...moduleInfo.dynamicallyImportedIds,
        );
      }
    }

    const modules = Array.from(moduleIds)
      .map((moduleId) => {
        const moduleInfo = this.getModuleInfo(moduleId);
        if (!moduleInfo) {
          throw new Error(`Rollup module information is absent: ${moduleId}`);
        }
        return {
          id: normalizeModuleId(moduleId),
          external: moduleInfo.code === null,
          staticImports: moduleInfo.importedIds
            .map(normalizeModuleId)
            .sort(compareUtf8),
          dynamicImports: moduleInfo.dynamicallyImportedIds
            .map(normalizeModuleId)
            .sort(compareUtf8),
        };
      })
      .sort((left, right) => compareUtf8(left.id, right.id));

    const chunksByFileName = new Map(
      Object.values(bundle)
        .filter((entry) => entry.type === "chunk")
        .map((entry) => [entry.fileName, entry]),
    );
    const reachableChunkNames = new Set<string>();
    const chunkQueue = [entryChunk.fileName];
    while (chunkQueue.length > 0) {
      const fileName = chunkQueue.shift();
      if (fileName === undefined || reachableChunkNames.has(fileName)) continue;
      const chunk = chunksByFileName.get(fileName);
      if (!chunk || chunk.type !== "chunk") {
        throw new Error(`Role entry imports an absent chunk: ${fileName}`);
      }
      reachableChunkNames.add(fileName);
      chunkQueue.push(...chunk.imports, ...chunk.dynamicImports);
    }
    const chunks = Array.from(reachableChunkNames)
      .map((fileName) => {
        const chunk = chunksByFileName.get(fileName);
        if (!chunk || chunk.type !== "chunk") {
          throw new Error(`Role entry chunk is absent: ${fileName}`);
        }
        return {
          file: `/${chunk.fileName.replaceAll("\\", "/")}`,
          sha256: sha256(chunk.code),
          size: Buffer.byteLength(chunk.code, "utf8"),
          staticImports: chunk.imports
            .map((value) => `/${value.replaceAll("\\", "/")}`)
            .sort(compareUtf8),
          dynamicImports: chunk.dynamicImports
            .map((value) => `/${value.replaceAll("\\", "/")}`)
            .sort(compareUtf8),
          modules: Object.keys(chunk.modules)
            .map(normalizeModuleId)
            .sort(compareUtf8),
        };
      })
      .sort((left, right) => compareUtf8(left.file, right.file));
    const graph = {
      schemaVersion: 1,
      graphKind: "rollup-role-entry-v1",
      sourceSha: identity.sourceSha,
      releaseRole: identity.releaseRole,
      variantId: identity.variantId,
      entryModule: normalizeModuleId(entryModuleId),
      entryFile: `/${entryChunk.fileName.replaceAll("\\", "/")}`,
      modules,
      chunks,
    };
    this.emitFile({
      type: "asset",
      fileName: ROLE_ENTRY_GRAPH_URL.slice(1),
      source: canonicalize(graph),
    });
  },
  writeBundle(outputOptions) {
    if (typeof outputOptions.dir !== "string") {
      throw new Error("Release role graph requires a directory build output");
    }
    const outputDirectory = path.resolve(projectRoot, outputOptions.dir);
    const graphPath = path.join(outputDirectory, ROLE_ENTRY_GRAPH_URL.slice(1));
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as {
      chunks: Array<{ file: string; sha256: string; size: number }>;
    };
    for (const chunk of graph.chunks) {
      const bytes = readFileSync(
        path.join(outputDirectory, ...chunk.file.slice(1).split("/")),
      );
      chunk.sha256 = sha256(bytes);
      chunk.size = bytes.length;
    }
    writeFileSync(graphPath, canonicalize(graph), {
      encoding: "utf8",
      flag: "w",
    });
  },
});

const createReleaseMetadataPlugin = (
  capabilitySource: string,
  identity: ReturnType<typeof getBuildIdentity>,
): Plugin => ({
  name: "release-metadata",
  transformIndexHtml: {
    order: "pre",
    handler: () => [
      {
        tag: "meta",
        attrs: {
          name: "event-shopping-planner-build-id",
          content: identity.sourceSha,
        },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: {
          name: "event-shopping-planner-source-sha",
          content: identity.sourceSha,
        },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: {
          name: "event-shopping-planner-variant-id",
          content: identity.variantId,
        },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: {
          name: "event-shopping-planner-release-role",
          content: identity.releaseRole,
        },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: {
          name: "event-shopping-planner-outer-agent-url",
          content: OUTER_AGENT_URL,
        },
        injectTo: "head",
      },
    ],
  },
  generateBundle() {
    [
      RELEASE_CAPABILITY_MANIFEST,
      `release-capabilities.${identity.sourceSha}.json`,
    ].forEach((fileName) => {
      this.emitFile({
        type: "asset",
        fileName,
        source: capabilitySource,
      });
    });
  },
});

const createQaBuildProfilePlugin = (
  identity: ReturnType<typeof getBuildIdentity>,
): Plugin => ({
  name: "foundation-qa-build-profile",
  enforce: "pre",
  resolveId(source, importer) {
    if (
      identity.buildPurpose === "qa-xlsx-main" &&
      importer
        ?.replaceAll("\\", "/")
        .endsWith("/src/app/composition/appRuntime.ts") &&
      source === "../../xlsx/adapters/productionXlsxExecutionPort"
    ) {
      return QA_XLSX_VIRTUAL_MODULE;
    }
    return null;
  },
  load(id) {
    if (id !== QA_XLSX_VIRTUAL_MODULE) return null;
    return [
      'import { MainThreadQaXlsxExecutionPort } from "/src/xlsx/adapters/mainThreadQaAdapter.ts";',
      "export const productionXlsxExecutionPort = new MainThreadQaXlsxExecutionPort();",
    ].join("\n");
  },
  transform(code, id) {
    const normalizedId = id.replaceAll("\\", "/").split("?")[0];
    if (
      identity.buildPurpose === "qa-xlsx-main" &&
      normalizedId.endsWith("/src/xlsx/adapters/mainThreadQaAdapter.ts")
    ) {
      const guard = "if (import.meta.env.PROD) {";
      if (!code.includes(guard)) {
        throw new Error("XLSX QA production guard transform target is absent");
      }
      return code.replace(guard, "if (false) {");
    }
    if (
      identity.buildPurpose === "qa-list-force-full" &&
      normalizedId.endsWith(
        "/src/features/shopping-list/renderers/rendererSelector.ts",
      )
    ) {
      const selector = "if (policy.forceFull) {";
      if (!code.includes(selector)) {
        throw new Error("List QA force-full transform target is absent");
      }
      return code.replace(selector, "if (true) {");
    }
    return null;
  },
});

const createCspPreviewDeliveryPlugin = (cspModeValue: string): Plugin => {
  const cspMode = assertCspMode(cspModeValue);
  const reportSink = cspReportSinkContract({ cspMode, cspPolicy });
  return {
    name: "csp-preview-delivery",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://preview.invalid")
          .pathname;
        if (pathname !== reportSink.path) {
          next();
          return;
        }
        const handler = reportSink.enabled ? cspReportHandler : notFoundHandler;
        void Promise.resolve(handler(request, response)).catch(() => {
          if (!response.headersSent) {
            response.statusCode = 500;
            response.setHeader("cache-control", "no-store");
          }
          if (!response.writableEnded) response.end();
        });
      });
    },
  };
};

export default defineConfig(({ command, mode }) => {
  const identity = getBuildIdentity();
  const cspMode = assertCspMode(identity.dimensions.cspMode);
  const isReleaseABuild = mode === "release-a";
  const releaseChannel = isReleaseABuild
    ? "release-a"
    : process.env.VITE_PERSISTENCE_RELEASE_CHANNEL === "release-b"
      ? "release-b"
      : "release-a";
  const legacyCleanupEnabled =
    !isReleaseABuild &&
    releaseChannel === "release-b" &&
    process.env.VITE_PERSISTENCE_LEGACY_CLEANUP === "true";
  const capabilitySource = canonicalize({
    kind: "event-shopping-planner-release-capabilities",
    version: 1,
    buildMode: mode,
    buildId: identity.sourceSha,
    sourceSha: identity.sourceSha,
    sourceState: identity.sourceState,
    releaseChannel,
    legacyLocalStorageCleanup: legacyCleanupEnabled ? "enabled" : "forced-off",
    ...(identity.nonPromotable
      ? {
          buildPurpose: identity.buildPurpose,
          nonPromotable: true,
        }
      : {}),
  });
  const roleEntry =
    identity.releaseRole === "standard"
      ? path.resolve(projectRoot, "src", "index.tsx")
      : path.resolve(projectRoot, "src", "pwa", "containment", "index.ts");

  return {
    envPrefix: "__FOUNDATION_NO_PUBLIC_ENV__",
    define: {
      "import.meta.env.VITE_PERSISTENCE_RELEASE_CHANNEL":
        JSON.stringify(releaseChannel),
      "import.meta.env.VITE_PERSISTENCE_LEGACY_CLEANUP": JSON.stringify(
        legacyCleanupEnabled ? "true" : "false",
      ),
      "import.meta.env.VITE_APP_BUILD_ID": JSON.stringify(identity.sourceSha),
    },
    plugins: [
      ...(command === "build"
        ? [
            createIndependentOuterAgentInjectionPlugin(identity),
            createIndependentOuterAgentHtmlPlugin(),
            createStaticApplicationStylesheetPlugin(),
          ]
        : []),
      createQaBuildProfilePlugin(identity),
      createCspPreviewDeliveryPlugin(cspMode),
      react(),
      createReleaseMetadataPlugin(capabilitySource, identity),
      createRoleEntryGraphPlugin(identity, roleEntry),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        injectRegister: false,
        includeManifestIcons: false,
        manifest: {
          name: "即売会 購入巡回表",
          short_name: "巡回表",
          description: "同人誌即売会の購入リスト管理アプリ",
          lang: "ja",
          theme_color: "#2563eb",
          background_color: "#f8fafc",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          icons: [
            {
              src: "icons/pwa-64x64.png",
              sizes: "64x64",
              type: "image/png",
            },
            {
              src: "icons/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "icons/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
            },
            {
              src: "icons/maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,json,webmanifest}"],
          globIgnores: [
            "**/#U*.png",
            "manifest.webmanifest",
            "release-identity.json",
            "release-identity.*.json",
          ],
          additionalManifestEntries: [
            {
              url: identity.versionedIdentityUrl,
              revision: null,
            },
          ],
          injectionPoint: "self.__WB_MANIFEST",
          rollupFormat: "es",
          sourcemap: false,
          minify: true,
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    build: {
      outDir: "dist",
      sourcemap: false,
      minify: "esbuild",
      rollupOptions: {
        input: {
          app: path.resolve(projectRoot, "index.html"),
          "release-role": roleEntry,
        },
        output: {
          entryFileNames: (chunk) => {
            const facade = chunk.facadeModuleId?.replaceAll("\\", "/") ?? "";
            if (facade.endsWith("/src/pwa/recovery/outerAgentEntry.ts")) {
              return OUTER_AGENT_URL.slice(1);
            }
            if (facade === roleEntry.replaceAll("\\", "/")) {
              return ROLE_ENTRY_URL.slice(1);
            }
            return "assets/[name]-[hash].js";
          },
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
    server: {
      port: 3000,
      open: command === "serve",
    },
    preview: {
      headers: renderCspHeaders({ cspMode, cspPolicy }),
    },
  };
});
