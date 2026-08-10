import {
  createRuntimeFallbackPrefix,
  createSynchronousFingerprint,
  snapshotStartupRecoveryValue,
} from "../../utils/persistenceResilience";
import { DATA_KEY, type StoreName } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";

export type RecoveryAdoptionStoreName = Exclude<StoreName, "syncQueue">;

export interface RuntimeRawEvidence {
  readonly storageKey: string;
  readonly rawValue: string;
}

const fingerprintsEqual = (left: unknown, right: unknown): boolean => {
  try {
    const leftFingerprint = createSynchronousFingerprint(left);
    const rightFingerprint = createSynchronousFingerprint(right);
    return (
      leftFingerprint.algorithm === rightFingerprint.algorithm &&
      leftFingerprint.canonicalization === rightFingerprint.canonicalization &&
      leftFingerprint.canonicalLength === rightFingerprint.canonicalLength &&
      leftFingerprint.value === rightFingerprint.value
    );
  } catch {
    return false;
  }
};

export function recoveryEvidenceMatches(
  left: unknown,
  right: unknown,
): boolean {
  return fingerprintsEqual(
    snapshotStartupRecoveryValue(left),
    snapshotStartupRecoveryValue(right),
  );
}

export function captureRuntimeRawEvidence(
  storeName: RecoveryAdoptionStoreName,
): RuntimeRawEvidence[] {
  const prefix = createRuntimeFallbackPrefix(storeName, DATA_KEY);
  const evidence: RuntimeRawEvidence[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith(prefix)) continue;
    const rawValue = localStorage.getItem(storageKey);
    if (rawValue !== null) evidence.push({ storageKey, rawValue });
  }
  return evidence.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey),
  );
}

export function assertRuntimeRawEvidenceUnchanged(
  storeName: RecoveryAdoptionStoreName,
  expected: readonly RuntimeRawEvidence[],
): void {
  if (
    !recoveryEvidenceMatches(captureRuntimeRawEvidence(storeName), expected)
  ) {
    throw new PersistenceConflictError(
      `${storeName} runtime fallback sources changed during recovery adoption.`,
    );
  }
}
