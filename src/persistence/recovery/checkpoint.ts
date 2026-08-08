import {
  isPersistenceCheckpoint,
  type PersistenceCheckpoint,
  type PersistenceDigestDescriptor,
} from "../../utils/persistenceResilience";
import type { StoreName } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";

export interface CheckpointRoot {
  readonly revision: string;
  readonly baseRevision: string | null;
  readonly payloadDigest: PersistenceDigestDescriptor;
  readonly writerId: string;
  readonly committedAt: string;
}

export function checkpointCommittedRootMatches(
  checkpoint: PersistenceCheckpoint,
  root: CheckpointRoot,
): boolean {
  return (
    checkpoint.committedRoot.revision === root.revision &&
    checkpoint.committedRoot.baseRevision === root.baseRevision &&
    checkpoint.committedRoot.digest.algorithm ===
      root.payloadDigest.algorithm &&
    checkpoint.committedRoot.digest.canonicalization ===
      root.payloadDigest.canonicalization &&
    checkpoint.committedRoot.digest.value === root.payloadDigest.value &&
    checkpoint.committedRoot.writerId === root.writerId &&
    checkpoint.committedRoot.committedAt === root.committedAt
  );
}

export function validateCheckpointForRoot(
  value: unknown,
  storeName: StoreName,
  key: string,
  root: CheckpointRoot,
): PersistenceCheckpoint | null {
  if (value === undefined || value === null) return null;
  if (
    !isPersistenceCheckpoint(value, { storeName, key }) ||
    !checkpointCommittedRootMatches(value, root)
  ) {
    throw new PersistenceConflictError(
      `${storeName}:${key} has an invalid persistence checkpoint.`,
    );
  }
  return value;
}
