import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJsonBytes, sha256Bytes } from "./canonical-json.mjs";

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const assertSafeRelativePath = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe package path: ${value}`);
  }
  return value;
};

const hashFile = async (filePath) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const walk = async (root, current, entries) => {
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
      throw new Error(`Symbolic links are not allowed: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await walk(root, absolutePath, entries);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Unsupported file type: ${relativePath}`);
    }
    entries.push({
      path: relativePath,
      sha256: await hashFile(absolutePath),
      size: metadata.size,
    });
  }
};

export const buildFileManifest = async (root) => {
  const entries = [];
  await walk(path.resolve(root), path.resolve(root), entries);
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const caseFolded = new Set();
  for (const entry of entries) {
    const folded = entry.path.toLocaleLowerCase("en-US");
    if (caseFolded.has(folded)) {
      throw new Error(`Case-colliding package path: ${entry.path}`);
    }
    caseFolded.add(folded);
  }
  return entries;
};

export const manifestTreeHash = (files) =>
  sha256Bytes(canonicalJsonBytes(files));

export const assertFileManifestEqual = (
  actual,
  expected,
  label = "manifest",
) => {
  if (
    actual.length !== expected.length ||
    actual.some(
      (entry, index) =>
        entry.path !== expected[index]?.path ||
        entry.sha256 !== expected[index]?.sha256 ||
        entry.size !== expected[index]?.size,
    )
  ) {
    throw new Error(`${label} file path/hash/size set differs`);
  }
  return true;
};
