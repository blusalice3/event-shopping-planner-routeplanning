import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const projectRoot = process.cwd();

export const normalizePath = (value) => value.replaceAll("\\", "/");

export const utf8Compare = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const canonicalizeValue = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeValue(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      utf8Compare(left, right),
    );
    return `{${entries
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${canonicalizeValue(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const canonicalize = (value) =>
  Buffer.from(canonicalizeValue(value), "utf8");

export const readJson = async (relativePath) => {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const bytes = await readFile(absolutePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
};

export const writeJson = async (relativePath, value) => {
  const absolutePath = path.resolve(projectRoot, relativePath);
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
  });
};

export const fail = (title, errors) => {
  process.stderr.write(`${title} (${errors.length} issue(s))\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
};
