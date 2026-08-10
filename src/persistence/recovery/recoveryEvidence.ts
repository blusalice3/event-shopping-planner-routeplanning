import type { MapDataStore } from "../../types/map";
import { normalizeMapDataForPersistence } from "../../utils/mapDataPersistence";
import {
  createSynchronousFingerprint,
  verifyPersistenceDigest,
  type PersistenceCheckpoint,
} from "../../utils/persistenceResilience";
import { DATA_KEY, STORES } from "../db/constants";
import { PersistenceConflictError } from "../db/errors";
import { isPlainRecord } from "../internal/valueValidation";
import {
  fingerprintsEqual,
  isStoredPersistenceMetadata,
  type StoredPersistenceMetadata,
} from "../internal/persistenceCore";
import { materializeMapData } from "../repositories/mapRepository";
import { validateCheckpointForRoot } from "./checkpoint";
import type { RecoveryAdoptionStoreName } from "./recoverySourceEvidence";

export interface RecoveryAdoptionCurrentEvidence {
  payload?: unknown;
  mapEntries?: Record<string, unknown>;
  metadata: unknown;
  checkpoint: unknown;
}

export function normalizeRecoveryAdoptionPayload(
  storeName: RecoveryAdoptionStoreName,
  payload: unknown,
): unknown {
  if (!isPlainRecord(payload)) {
    throw new PersistenceConflictError(
      `${storeName} recovery payload must be a JSON-compatible object.`,
    );
  }
  if (storeName === STORES.MAP_DATA) {
    return structuredClone(
      normalizeMapDataForPersistence(payload as MapDataStore),
    );
  }

  const stablePayload = structuredClone(payload);
  createSynchronousFingerprint(stablePayload);
  return stablePayload;
}

export function materializeRecoveryAdoptionCurrentPayload(
  storeName: RecoveryAdoptionStoreName,
  evidence: RecoveryAdoptionCurrentEvidence,
): unknown {
  if (storeName === STORES.MAP_DATA) {
    if (!evidence.mapEntries) {
      throw new PersistenceConflictError(
        "mapData recovery evidence is missing its physical records.",
      );
    }
    return materializeMapData(evidence.mapEntries).data;
  }
  return evidence.payload;
}

export async function getTrustedRecoveryAdoptionRoot(
  storeName: RecoveryAdoptionStoreName,
  evidence: RecoveryAdoptionCurrentEvidence,
): Promise<{
  root: StoredPersistenceMetadata;
  checkpoint: PersistenceCheckpoint | null;
} | null> {
  if (!isStoredPersistenceMetadata(evidence.metadata, storeName, DATA_KEY)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = materializeRecoveryAdoptionCurrentPayload(storeName, evidence);
    if (
      !(await verifyPersistenceDigest(
        payload,
        evidence.metadata.payloadDigest,
      )) ||
      !fingerprintsEqual(
        createSynchronousFingerprint(payload),
        evidence.metadata.payloadFingerprint,
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  let checkpoint: PersistenceCheckpoint | null = null;
  try {
    checkpoint = validateCheckpointForRoot(
      evidence.checkpoint,
      storeName,
      DATA_KEY,
      evidence.metadata,
    );
  } catch {
    // An invalid checkpoint is archived but is not carried into the new root.
  }
  return { root: evidence.metadata, checkpoint };
}
