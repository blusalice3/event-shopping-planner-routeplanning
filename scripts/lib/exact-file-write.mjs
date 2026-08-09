import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { exactFileIdentity } from "./exact-file-identity.mjs";
import {
  describeExactFile,
  readExactRegularFile,
  sameExactFileIdentityAndSize,
} from "./exact-file-read.mjs";

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const assertUnaliasedDirectory = async (directory, label) => {
  const metadata = await lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} directory is not a regular unaliased directory`);
  }
  if (comparablePath(await realpath(directory)) !== comparablePath(directory)) {
    throw new Error(`${label} directory resolves through a path alias`);
  }
};

const assertCommittedPath = async ({
  outputPath,
  description,
  label,
  lstatImpl,
}) => {
  const metadata = await lstatImpl(outputPath, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !sameExactFileIdentityAndSize(describeExactFile(metadata), description)
  ) {
    throw new Error(`${label} output path changed after commit`);
  }
};

const readCommittedBytes = async ({
  outputPath,
  description,
  expectedBytes,
  label,
  readFileImpl,
}) => {
  const actual = await readFileImpl({
    description: { path: outputPath, ...description },
    maximumBytes: expectedBytes.length,
    label: `${label} output`,
    requireDescriptionTimestamps: false,
  });
  if (!actual.equals(expectedBytes)) {
    throw new Error(`${label} output bytes differ after commit`);
  }
};

export const writeExactCreateOnlyFile = async (
  { outputPath, bytes: suppliedBytes, label, maximumBytes },
  {
    afterFinalMetadata = async () => {},
    linkImpl = link,
    lstatImpl = lstat,
    readFileImpl = readExactRegularFile,
  } = {},
) => {
  if (
    typeof outputPath !== "string" ||
    outputPath.length === 0 ||
    typeof label !== "string" ||
    label.length === 0 ||
    (!Buffer.isBuffer(suppliedBytes) &&
      !(suppliedBytes instanceof Uint8Array)) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    throw new Error("Exact create-only output options are invalid");
  }
  const bytes = Buffer.from(suppliedBytes);
  if (bytes.length < 1 || bytes.length > maximumBytes) {
    throw new Error(`${label} output is empty or oversized`);
  }
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  await mkdir(directory, { recursive: true });
  await assertUnaliasedDirectory(directory, label);
  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  let description;
  let linked = false;
  let retired = false;
  try {
    handle = await open(temporary, "wx+", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    description = describeExactFile(await handle.stat({ bigint: true }));
    const descriptorBytes = Buffer.alloc(bytes.length);
    const read = await handle.read(descriptorBytes, 0, bytes.length, 0);
    const descriptorAfter = describeExactFile(
      await handle.stat({ bigint: true }),
    );
    if (
      description.size !== bytes.length ||
      read.bytesRead !== bytes.length ||
      !descriptorBytes.equals(bytes) ||
      !sameExactFileIdentityAndSize(description, descriptorAfter)
    ) {
      throw new Error(`${label} temporary output differs`);
    }
    await linkImpl(temporary, resolved);
    linked = true;
    await assertCommittedPath({
      outputPath: resolved,
      description,
      label,
      lstatImpl,
    });
    await handle.close();
    handle = undefined;
    await unlink(temporary);
    retired = true;

    await assertCommittedPath({
      outputPath: resolved,
      description,
      label,
      lstatImpl,
    });
    await afterFinalMetadata({
      outputPath: resolved,
      description: { ...description },
      expectedBytes: Buffer.from(bytes),
    });
    for (let verification = 0; verification < 3; verification += 1) {
      await readCommittedBytes({
        outputPath: resolved,
        description,
        expectedBytes: bytes,
        label,
        readFileImpl,
      });
      await assertCommittedPath({
        outputPath: resolved,
        description,
        label,
        lstatImpl,
      });
    }
    return Object.freeze({
      path: resolved,
      bytes,
      identity: description.identity,
    });
  } catch (error) {
    if (linked && description !== undefined) {
      const current = await lstat(resolved, { bigint: true }).catch(() => null);
      if (
        current !== null &&
        current.isFile() &&
        !current.isSymbolicLink() &&
        exactFileIdentity(current) === description.identity
      ) {
        await unlink(resolved).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!retired) await unlink(temporary).catch(() => undefined);
  }
};
