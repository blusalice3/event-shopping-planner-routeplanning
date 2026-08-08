import type {
  PersistenceCommandPort,
  PersistenceSnapshot,
} from "../../app/ports/PersistenceCommandPort";
import { db } from "../facade/indexedDbPersistence";

export interface IndexedDbPersistenceCommandDelegate {
  restoreAppDataAtomically(snapshot: PersistenceSnapshot): Promise<void>;
}

export const createIndexedDbPersistenceCommandAdapter = (
  delegate: IndexedDbPersistenceCommandDelegate = db,
): PersistenceCommandPort => ({
  restoreAppDataAtomically(snapshot): Promise<void> {
    return delegate.restoreAppDataAtomically(snapshot);
  },
});
