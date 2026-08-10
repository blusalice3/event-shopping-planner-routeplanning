export const exactFileIdentity = (metadata) => {
  if (typeof metadata?.dev !== "bigint" || typeof metadata?.ino !== "bigint") {
    throw new TypeError("Filesystem identity metadata must use bigint");
  }
  return `${metadata.dev}:${metadata.ino}`;
};
