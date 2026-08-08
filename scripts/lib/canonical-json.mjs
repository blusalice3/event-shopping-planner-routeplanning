import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import canonicalize from "canonicalize";

const assertCanonicalJsonValue = (value, seen = new Set()) => {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          "Canonical JSON does not support non-finite numbers",
        );
      }
      return;
    case "object": {
      if (seen.has(value)) {
        throw new TypeError("Canonical JSON does not support cyclic values");
      }
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((entry) => assertCanonicalJsonValue(entry, seen));
        seen.delete(value);
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON only supports plain objects");
      }
      for (const [key, entry] of Object.entries(value)) {
        if (
          entry === undefined ||
          typeof entry === "function" ||
          typeof entry === "symbol" ||
          typeof entry === "bigint"
        ) {
          throw new TypeError(`Unsupported canonical JSON value at ${key}`);
        }
        assertCanonicalJsonValue(entry, seen);
      }
      seen.delete(value);
      return;
    }
    default:
      throw new TypeError(`Unsupported canonical JSON type: ${typeof value}`);
  }
};

export const canonicalizeJson = (value) => {
  assertCanonicalJsonValue(value);
  const result = canonicalize(value);
  if (typeof result !== "string") {
    throw new TypeError("Canonical JSON serialization did not return bytes");
  }
  return result;
};

export const canonicalJsonBytes = (value) =>
  Buffer.from(canonicalizeJson(value), "utf8");

export const sha256Bytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export const sha256Json = (value) => sha256Bytes(canonicalJsonBytes(value));

export const parseJsonStrict = (text, source = "JSON input") => {
  if (text.codePointAt(0) === 0xfeff) {
    throw new SyntaxError(`${source} must not contain a BOM`);
  }
  const parsed = JSON.parse(text);
  canonicalizeJson(parsed);
  return parsed;
};

export const readJsonStrict = async (path) =>
  parseJsonStrict(await readFile(path, "utf8"), path);
