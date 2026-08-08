import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  canonicalizeJson,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./lib/canonical-json.mjs";

const projectRoot = process.cwd();
const distDirectory = path.join(projectRoot, "dist");
const allowNonPromotableQa = process.argv.includes("--allow-nonpromotable-qa");

const readJson = async (filePath) =>
  JSON.parse(await readFile(filePath, { encoding: "utf8" }));

const capabilityPath = path.join(distDirectory, "release-capabilities.json");
const capability = await readJson(capabilityPath);
const isNonPromotableQa =
  capability?.nonPromotable === true &&
  ["qa-xlsx-main", "qa-list-force-full"].includes(capability?.buildPurpose);

if (isNonPromotableQa && !allowNonPromotableQa) {
  throw new Error("Production verifier rejects a nonpromotable QA capability");
}

if (
  capability?.kind !== "event-shopping-planner-release-capabilities" ||
  capability?.version !== 1 ||
  capability?.buildMode !== "release-a" ||
  !/^[0-9a-f]{40}$/i.test(capability?.buildId) ||
  capability?.sourceSha !== capability?.buildId ||
  !(
    ["clean", "provider-immutable"].includes(capability?.sourceState) ||
    (allowNonPromotableQa &&
      isNonPromotableQa &&
      capability?.sourceState === "dirty")
  ) ||
  capability?.releaseChannel !== "release-a" ||
  capability?.legacyLocalStorageCleanup !== "forced-off" ||
  (!isNonPromotableQa &&
    (capability?.nonPromotable !== undefined ||
      capability?.buildPurpose !== undefined))
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

for (const fileName of ["sw.js", "manifest.webmanifest"]) {
  const file = await stat(path.join(distDirectory, fileName));
  if (!file.isFile() || file.size === 0) {
    throw new Error(`Release A PWA artifact is missing or empty: ${fileName}`);
  }
}

const serviceWorkerSource = await readFile(path.join(distDirectory, "sw.js"), {
  encoding: "utf8",
});
const identityPath = path.join(distDirectory, "release-identity.json");
const hasPromptCloseAllIdentity = await stat(identityPath)
  .then((entry) => entry.isFile())
  .catch(() => false);

if (hasPromptCloseAllIdentity) {
  const canonicalIdentityBytes = await readFile(identityPath, "utf8");
  const identity = JSON.parse(canonicalIdentityBytes);
  if (
    canonicalizeJson(identity) !== canonicalIdentityBytes ||
    identity.schemaVersion !== 1 ||
    identity.sourceSha !== capability.sourceSha ||
    identity.buildId !== capability.buildId ||
    (identity.nonPromotable === true) !== isNonPromotableQa ||
    (identity.buildPurpose ?? "production") !==
      (capability.buildPurpose ?? "production") ||
    !["legacy-auto-update-v1", "prompt-close-all-v1"].includes(
      identity.pwaLifecycle,
    ) ||
    !["standard", "containment"].includes(identity.releaseRole) ||
    !/^[0-9a-f]{64}$/.test(identity.variantId) ||
    !/^[0-9a-f]{64}$/.test(identity.requiredDbCompatibilityFingerprint)
  ) {
    throw new Error(
      "Release A PWA verification failed: release identity is not canonical or source-bound.",
    );
  }
  const dbContract = await readJsonStrict(
    path.join(projectRoot, "config", "db-compatibility-contract.json"),
  );
  if (identity.requiredDbCompatibilityFingerprint !== sha256Json(dbContract)) {
    throw new Error(
      "Release A PWA verification failed: DB compatibility fingerprint differs.",
    );
  }
  const versionedIdentityName = `release-identity.${identity.sourceSha}.${identity.variantId}.json`;
  const versionedIdentityBytes = await readFile(
    path.join(distDirectory, versionedIdentityName),
    "utf8",
  );
  if (versionedIdentityBytes !== canonicalIdentityBytes) {
    throw new Error(
      "Release A PWA verification failed: stable and versioned identity bytes differ.",
    );
  }
  const identityOutputs =
    identity.pwaLifecycle === "prompt-close-all-v1"
      ? [
          ["outerAgentUrl", "outerAgentSha256"],
          ["roleEntryUrl", "roleEntrySha256"],
          ["serviceWorkerUrl", "serviceWorkerSha256"],
        ]
      : [
          ["appEntryUrl", "appEntrySha256"],
          ["serviceWorkerUrl", "serviceWorkerSha256"],
        ];
  for (const [urlField, hashField] of identityOutputs) {
    const url = identity[urlField];
    if (
      typeof url !== "string" ||
      !url.startsWith("/") ||
      url.startsWith("//") ||
      !/^[0-9a-f]{64}$/.test(identity[hashField])
    ) {
      throw new Error(`Release identity field is invalid: ${urlField}`);
    }
    const bytes = await readFile(
      path.join(distDirectory, ...url.slice(1).split("/")),
    );
    if (sha256Bytes(bytes) !== identity[hashField]) {
      throw new Error(`Release identity output hash differs: ${url}`);
    }
  }
  if (
    !serviceWorkerSource.includes(`/${versionedIdentityName}`) ||
    /\burl\s*:\s*["']\/release-identity\.json["']/.test(serviceWorkerSource) ||
    /\bskipWaiting\s*\(|\bclients\.claim\s*\(/.test(serviceWorkerSource)
  ) {
    throw new Error(
      "Release A PWA verification failed: precache or natural activation contract differs.",
    );
  }
} else {
  const legacyRegister = await stat(path.join(distDirectory, "registerSW.js"));
  if (
    !legacyRegister.isFile() ||
    legacyRegister.size === 0 ||
    !serviceWorkerSource.includes(
      `release-capabilities.${capability.buildId}.json`,
    )
  ) {
    throw new Error(
      "Release A PWA verification failed: legacy worker identity is incomplete.",
    );
  }
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
