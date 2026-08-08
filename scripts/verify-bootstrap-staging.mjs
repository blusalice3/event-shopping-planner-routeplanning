import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

const canonicalizeJson = (value) => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Canonical JSON only accepts plain objects");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(",")}}`;
};

const parseJsonStrict = (bytes, source) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.codePointAt(0) === 0xfeff) {
    throw new Error(`${source} must not contain a BOM`);
  }
  const value = JSON.parse(text);
  canonicalizeJson(value);
  return value;
};

const assertSafeRelativePath = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => ["", ".", ".."].includes(part))
  ) {
    throw new Error(`Unsafe bootstrap path: ${value}`);
  }
};

const hashFile = async (filePath) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
};

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const walkFiles = async (root, current, entries) => {
  const directoryEntries = await readdir(current, { withFileTypes: true });
  directoryEntries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of directoryEntries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    assertSafeRelativePath(relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Bootstrap symlink is forbidden: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await walkFiles(root, absolutePath, entries);
    } else if (metadata.isFile()) {
      entries.push({
        path: relativePath,
        sha256: await hashFile(absolutePath),
        size: metadata.size,
      });
    } else {
      throw new Error(`Unsupported bootstrap file: ${relativePath}`);
    }
  }
};

const buildFileManifest = async (root) => {
  const resolved = path.resolve(root);
  const files = [];
  await walkFiles(resolved, resolved, files);
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const folded = new Set();
  for (const file of files) {
    const key = file.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) {
      throw new Error(`Bootstrap path case collision: ${file.path}`);
    }
    folded.add(key);
  }
  return files;
};

const assertFileManifestEqual = (actual, expected, label) => {
  if (
    actual.length !== expected.length ||
    actual.some(
      (entry, index) =>
        entry.path !== expected[index]?.path ||
        entry.sha256 !== expected[index]?.sha256 ||
        entry.size !== expected[index]?.size,
    )
  ) {
    throw new Error(`${label} path/hash/size set differs`);
  }
};

const manifestTreeHash = (files) =>
  sha256Bytes(Buffer.from(canonicalizeJson(files), "utf8"));

const stagingRoot = path.resolve(option("--root") ?? process.cwd());
const manifestPath = option("--raw-dist-manifest");
if (!manifestPath) throw new Error("--raw-dist-manifest is required");

const manifest = parseJsonStrict(
  await readFile(path.resolve(manifestPath)),
  manifestPath,
);
if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.files) ||
  !/^[0-9a-f]{64}$/.test(manifest.treeSha256)
) {
  throw new Error("Raw dist manifest is invalid");
}

const actualPublicFiles = await buildFileManifest(
  path.join(stagingRoot, "public"),
);
assertFileManifestEqual(actualPublicFiles, manifest.files, "bootstrap public");
if (manifestTreeHash(actualPublicFiles) !== manifest.treeSha256) {
  throw new Error("Bootstrap public tree hash differs from raw dist manifest");
}
if (
  actualPublicFiles.some((file) => /^release-identity(?:\.|$)/.test(file.path))
) {
  throw new Error("Legacy bootstrap must not add release identity files");
}

const expectedTopLevel = new Set([
  "api",
  "package-lock.json",
  "package.json",
  "public",
  "scripts",
  "vercel.json",
]);
const stagingFiles = await buildFileManifest(stagingRoot);
for (const entry of stagingFiles) {
  const topLevel = entry.path.split("/")[0];
  if (!expectedTopLevel.has(topLevel)) {
    throw new Error(`Bootstrap staging has an unapproved path: ${entry.path}`);
  }
}

const expectedExactPaths = new Set([
  "api/not-found.mjs",
  "api/persistence-release-a-metrics.mjs",
  "package-lock.json",
  "package.json",
  "scripts/verify-bootstrap-staging.mjs",
  "vercel.json",
]);
for (const entry of stagingFiles.filter(
  (file) => !file.path.startsWith("public/"),
)) {
  if (!expectedExactPaths.has(entry.path)) {
    throw new Error(`Bootstrap staging has an unapproved file: ${entry.path}`);
  }
}

const templateChecks = [
  {
    stagedRelative: "api/persistence-release-a-metrics.mjs",
    templateRelative: "scripts/templates/bootstrap-metrics-disabled.mjs",
    declaredSha256: option("--metrics-template-sha256"),
  },
  {
    stagedRelative: "api/not-found.mjs",
    templateRelative: "scripts/templates/bootstrap-api-not-found.mjs",
    declaredSha256: option("--not-found-template-sha256"),
  },
];
for (const {
  stagedRelative,
  templateRelative,
  declaredSha256,
} of templateChecks) {
  const stagedBytes = await readFile(path.join(stagingRoot, stagedRelative));
  const expectedSha256 =
    declaredSha256 ??
    sha256Bytes(await readFile(path.join(repositoryRoot, templateRelative)));
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`Invalid fixed template SHA-256 for ${stagedRelative}`);
  }
  if (sha256Bytes(stagedBytes) !== expectedSha256) {
    throw new Error(`${stagedRelative} differs from its fixed template`);
  }
}

process.stdout.write(
  `PASS bootstrap staging: ${actualPublicFiles.length} raw static files; tree ${manifest.treeSha256}.\n`,
);
