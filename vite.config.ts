import { execFileSync } from "node:child_process";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const RELEASE_CAPABILITY_MANIFEST = "release-capabilities.json";

const createReleaseCapabilityManifestPlugin = (
  source: string,
  buildId: string,
): Plugin => ({
  name: "release-capability-manifest",
  transformIndexHtml: {
    order: "pre",
    handler: () => [
      {
        tag: "meta",
        attrs: {
          name: "event-shopping-planner-build-id",
          content: buildId,
        },
        injectTo: "head",
      },
    ],
  },
  generateBundle() {
    [
      RELEASE_CAPABILITY_MANIFEST,
      `release-capabilities.${buildId}.json`,
    ].forEach((fileName) => {
      this.emitFile({
        type: "asset",
        fileName,
        source,
      });
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const providerCommitSha =
    env.VERCEL === "1" &&
    /^[0-9a-f]{40}$/i.test(env.VERCEL_GIT_COMMIT_SHA ?? "")
      ? env.VERCEL_GIT_COMMIT_SHA.toLowerCase()
      : null;
  let sourceSha = "unknown";
  let sourceState = "unknown";
  try {
    const localCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
    const localSourceState =
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length === 0
        ? "clean"
        : "dirty";
    sourceSha = localCommitSha;
    sourceState =
      providerCommitSha !== null && providerCommitSha !== localCommitSha
        ? "provider-mismatch"
        : localSourceState;
  } catch {
    if (providerCommitSha !== null) {
      sourceSha = providerCommitSha;
      sourceState = "provider-immutable";
    }
  }
  const buildId = /^[0-9a-f]{7,64}$/i.test(sourceSha)
    ? sourceSha.toLowerCase()
    : "unknown-source";
  const isReleaseABuild = mode === "release-a";
  const releaseChannel = isReleaseABuild
    ? "release-a"
    : env.VITE_PERSISTENCE_RELEASE_CHANNEL === "release-b"
      ? "release-b"
      : "release-a";
  const legacyCleanupEnabled =
    !isReleaseABuild &&
    releaseChannel === "release-b" &&
    env.VITE_PERSISTENCE_LEGACY_CLEANUP === "true";
  const releaseCapabilityManifest = JSON.stringify(
    {
      kind: "event-shopping-planner-release-capabilities",
      version: 1,
      buildMode: mode,
      buildId,
      sourceSha,
      sourceState,
      releaseChannel,
      legacyLocalStorageCleanup: legacyCleanupEnabled
        ? "enabled"
        : "forced-off",
    },
    null,
    2,
  );

  return {
    define: {
      "import.meta.env.VITE_PERSISTENCE_RELEASE_CHANNEL":
        JSON.stringify(releaseChannel),
      "import.meta.env.VITE_PERSISTENCE_LEGACY_CLEANUP": JSON.stringify(
        legacyCleanupEnabled ? "true" : "false",
      ),
      "import.meta.env.VITE_APP_BUILD_ID": JSON.stringify(buildId),
    },
    plugins: [
      react(),
      createReleaseCapabilityManifestPlugin(releaseCapabilityManifest, buildId),
      VitePWA({
        registerType: "autoUpdate",
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
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,json}"],
          globIgnores: [
            "**/#U*.png",
            "icons/maskable-icon-512x512.png",
            "icons/pwa-64x64.png",
            "icons/pwa-192x192.png",
            "icons/pwa-512x512.png",
          ],
          cleanupOutdatedCaches: true, // 追加: 古いキャッシュを自動削除
          skipWaiting: true, // 追加: 新しいService Workerを即座にアクティブ化
          clientsClaim: true, // 追加: アクティブ化後すぐに制御を開始
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/cdn\.tailwindcss\.com\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "tailwind-cache",
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                },
              },
            },
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
              handler: "NetworkOnly",
            },
          ],
        },
      }),
    ],
    build: {
      outDir: "dist",
      sourcemap: false,
      minify: "esbuild",
      rollupOptions: {
        output: {
          manualChunks: {
            "xlsx-parser": [
              "./src/utils/xlsxMapParser.ts",
              "./src/utils/exportImport.ts",
            ],
          },
        },
      },
    },
    server: {
      port: 3000,
      open: true,
    },
  };
});
