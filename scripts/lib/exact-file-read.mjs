import { open } from "node:fs/promises";
import { exactFileIdentity } from "./exact-file-identity.mjs";

export const describeExactFile = (metadata) => {
  if (
    typeof metadata?.size !== "bigint" ||
    typeof metadata?.mtimeNs !== "bigint" ||
    typeof metadata?.ctimeNs !== "bigint" ||
    metadata.size < 0n ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError(
      "Filesystem snapshot metadata must use safe bigint values",
    );
  }
  return {
    identity: exactFileIdentity(metadata),
    size: Number(metadata.size),
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
};

export const sameExactFileDescription = (left, right) =>
  left?.identity === right?.identity &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

export const sameExactFileIdentityAndSize = (left, right) =>
  left?.identity === right?.identity && left.size === right.size;

export const readExactRegularFile = async ({
  description,
  maximumBytes,
  label,
  openFile = open,
  requireDescriptionTimestamps = true,
}) => {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    description.size < 1 ||
    description.size > maximumBytes
  ) {
    throw new Error(`${label} is empty or oversized`);
  }
  const handle = await openFile(description.path, "r");
  try {
    const beforeMetadata = await handle.stat({ bigint: true });
    if (!beforeMetadata.isFile()) {
      throw new Error(`${label} changed while read`);
    }
    const before = describeExactFile(beforeMetadata);
    if (
      !sameExactFileIdentityAndSize(description, before) ||
      (requireDescriptionTimestamps &&
        !sameExactFileDescription(description, before))
    ) {
      throw new Error(`${label} changed while read`);
    }
    const value = await handle.readFile();
    const bytes = Buffer.from(value);
    const after = describeExactFile(await handle.stat({ bigint: true }));
    if (
      !sameExactFileDescription(before, after) ||
      bytes.length !== description.size
    ) {
      throw new Error(`${label} changed while read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
};
