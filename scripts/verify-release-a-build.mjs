import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const distDirectory = path.join(projectRoot, "dist");

const readJson = async (filePath) =>
  JSON.parse(await readFile(filePath, { encoding: "utf8" }));

const capabilityPath = path.join(distDirectory, "release-capabilities.json");
const capability = await readJson(capabilityPath);

if (
  capability?.kind !== "event-shopping-planner-release-capabilities" ||
  capability?.version !== 1 ||
  capability?.buildMode !== "release-a" ||
  !/^[0-9a-f]{40}$/i.test(capability?.buildId) ||
  capability?.sourceSha !== capability?.buildId ||
  !["clean", "provider-immutable"].includes(capability?.sourceState) ||
  capability?.releaseChannel !== "release-a" ||
  capability?.legacyLocalStorageCleanup !== "forced-off"
) {
  throw new Error(
    "Release A capability verification failed: legacy cleanup is not provably forced off.",
  );
}

const versionedCapabilityPath = path.join(
  distDirectory,
  `release-capabilities.${capability.buildId}.json`,
);
const versionedCapability = await stat(versionedCapabilityPath);
if (!versionedCapability.isFile() || versionedCapability.size === 0) {
  throw new Error(
    "Release A capability verification failed: versioned capability evidence is missing.",
  );
}
const versionedCapabilityPayload = await readJson(versionedCapabilityPath);
if (JSON.stringify(versionedCapabilityPayload) !== JSON.stringify(capability)) {
  throw new Error(
    "Release A capability verification failed: stable and versioned evidence differ.",
  );
}

for (const fileName of ["sw.js", "registerSW.js", "manifest.webmanifest"]) {
  const file = await stat(path.join(distDirectory, fileName));
  if (!file.isFile() || file.size === 0) {
    throw new Error(`Release A PWA artifact is missing or empty: ${fileName}`);
  }
}

const serviceWorkerSource = await readFile(path.join(distDirectory, "sw.js"), {
  encoding: "utf8",
});
if (
  !serviceWorkerSource.includes(
    `release-capabilities.${capability.buildId}.json`,
  )
) {
  throw new Error(
    "Release A PWA verification failed: active-worker build identity is not precached.",
  );
}

const indexHtml = await readFile(path.join(distDirectory, "index.html"), {
  encoding: "utf8",
});
if (
  !indexHtml.includes('name="event-shopping-planner-build-id"') ||
  !indexHtml.includes(`content="${capability.buildId}"`)
) {
  throw new Error(
    "Release A PWA verification failed: app build identity is missing from index.html.",
  );
}

const vercelConfig = await readJson(path.join(projectRoot, "vercel.json"));
const serviceWorkerHeader = vercelConfig.headers?.find(
  ({ source }) => source === "/sw.js",
);
const cacheControl = serviceWorkerHeader?.headers?.find(
  ({ key }) => key.toLowerCase() === "cache-control",
)?.value;
if (
  typeof cacheControl !== "string" ||
  !cacheControl.includes("max-age=0") ||
  !cacheControl.includes("must-revalidate")
) {
  throw new Error(
    "Release A PWA verification failed: /sw.js revalidation headers are incomplete.",
  );
}

process.stdout.write(
  `Release A artifact ${capability.buildId} verified: exact source; cleanup forced OFF; PWA artifacts and /sw.js headers present.\n`,
);
