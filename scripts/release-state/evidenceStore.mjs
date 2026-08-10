import { sha256Bytes } from "../lib/canonical-json.mjs";

const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const assertNamespace = (namespace) => {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error("Evidence namespace is invalid");
  }
};

export const releaseEvidenceUri = (namespace, sha256) => {
  assertNamespace(namespace);
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new Error("Evidence SHA-256 is invalid");
  }
  return `release-state://${namespace}/evidence/${sha256}`;
};

export const putEvidenceObject = async ({
  client,
  namespace,
  bytes,
  mediaType,
}) => {
  assertNamespace(namespace);
  if (
    !Buffer.isBuffer(bytes) &&
    typeof bytes !== "string" &&
    !(bytes instanceof Uint8Array)
  ) {
    throw new Error("Evidence bytes are invalid");
  }
  const objectBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (objectBytes.length > MAX_EVIDENCE_BYTES) {
    throw new Error("Evidence object exceeds the 256 MiB ceiling");
  }
  if (
    typeof mediaType !== "string" ||
    mediaType.length === 0 ||
    mediaType.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(mediaType)
  ) {
    throw new Error("Evidence media type is invalid");
  }
  const sha256 = sha256Bytes(objectBytes);
  const result = await client.query({
    name: "foundation-put-evidence-v1",
    text: `
      select *
      from foundation_release.put_evidence_if_absent($1, $2, $3, $4)
    `,
    values: [namespace, sha256, mediaType, objectBytes],
  });
  if (result.rowCount !== 1) {
    throw new Error("Evidence store returned no receipt");
  }
  const receipt = result.rows[0];
  if (
    receipt.namespace !== namespace ||
    receipt.sha256 !== sha256 ||
    Number(receipt.byte_length) !== objectBytes.length ||
    receipt.media_type !== mediaType ||
    typeof receipt.replayed !== "boolean" ||
    !Number.isFinite(new Date(receipt.committed_at).getTime())
  ) {
    throw new Error("Evidence store receipt does not match submitted bytes");
  }
  return {
    uri: releaseEvidenceUri(namespace, sha256),
    sha256,
    mediaType: receipt.media_type,
    byteLength: Number(receipt.byte_length),
    committedAt: new Date(receipt.committed_at).toISOString(),
    replayed: receipt.replayed,
  };
};

export const readEvidenceObject = async ({ client, namespace, sha256 }) => {
  assertNamespace(namespace);
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new Error("Evidence SHA-256 is invalid");
  }
  const result = await client.query({
    name: "foundation-read-evidence-v1",
    text: `
      select media_type, byte_length, object_bytes, committed_at
      from foundation_release.release_evidence_objects
      where namespace = $1 and sha256 = $2
    `,
    values: [namespace, sha256],
  });
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  const bytes = Buffer.from(row.object_bytes);
  if (
    bytes.length !== Number(row.byte_length) ||
    sha256Bytes(bytes) !== sha256 ||
    typeof row.media_type !== "string" ||
    !Number.isFinite(new Date(row.committed_at).getTime())
  ) {
    throw new Error("Stored evidence object failed its content hash");
  }
  return {
    bytes,
    mediaType: row.media_type,
    committedAt: new Date(row.committed_at).toISOString(),
  };
};
