import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "./canonical-json.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_KIND_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const URI_PATTERN =
  /^artifact:\/\/sha256\/([0-9a-f]{64})\/([a-z0-9][a-z0-9.-]*)$/;

const assertObjectKind = (kind) => {
  if (typeof kind !== "string" || !OBJECT_KIND_PATTERN.test(kind)) {
    throw new Error(`Invalid content-addressed object kind: ${kind}`);
  }
  return kind;
};

export const contentAddressedUri = (sha256, kind) => {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Invalid content-addressed SHA-256: ${sha256}`);
  }
  assertObjectKind(kind);
  return `artifact://sha256/${sha256}/${kind}`;
};

export const parseContentAddressedUri = (uri, expectedKind = null) => {
  if (typeof uri !== "string") {
    throw new Error("Content-addressed URI must be a string");
  }
  const match = URI_PATTERN.exec(uri);
  if (!match) {
    throw new Error(`Unsupported immutable artifact URI: ${uri}`);
  }
  const [, sha256, kind] = match;
  if (expectedKind !== null && kind !== expectedKind) {
    throw new Error(
      `Immutable artifact URI kind ${kind} differs from ${expectedKind}`,
    );
  }
  return { sha256, kind };
};

export const contentAddressedObjectPath = (packageRoot, sha256, kind) => {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Invalid content-addressed SHA-256: ${sha256}`);
  }
  assertObjectKind(kind);
  return path.join(
    path.resolve(packageRoot),
    "objects",
    "sha256",
    `${sha256}.${kind}`,
  );
};

export const writeContentAddressedObject = async ({
  packageRoot,
  bytes,
  kind,
}) => {
  const normalizedBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const sha256 = sha256Bytes(normalizedBytes);
  const objectPath = contentAddressedObjectPath(
    packageRoot,
    sha256,
    assertObjectKind(kind),
  );
  await mkdir(path.dirname(objectPath), { recursive: true });
  try {
    await writeFile(objectPath, normalizedBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingBytes = await readFile(objectPath);
    if (!existingBytes.equals(normalizedBytes)) {
      throw new Error(`Content-addressed object collision: ${objectPath}`);
    }
  }
  return {
    uri: contentAddressedUri(sha256, kind),
    sha256,
    path: objectPath,
  };
};

export const resolveContentAddressedObject = async ({
  packageRoot,
  reference,
  expectedKind,
}) => {
  if (
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    typeof reference.uri !== "string" ||
    typeof reference.sha256 !== "string"
  ) {
    throw new Error("Immutable object reference is invalid");
  }
  const parsed = parseContentAddressedUri(reference.uri, expectedKind);
  if (parsed.sha256 !== reference.sha256) {
    throw new Error("Immutable object URI and declared SHA-256 differ");
  }
  const objectPath = contentAddressedObjectPath(
    packageRoot,
    parsed.sha256,
    parsed.kind,
  );
  const bytes = await readFile(objectPath);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== reference.sha256) {
    throw new Error(
      `Immutable object bytes differ from declared SHA-256: ${reference.uri}`,
    );
  }
  return {
    ...parsed,
    bytes,
    path: objectPath,
  };
};
