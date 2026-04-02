import { db } from '../../../utils/indexedDB';
import type { SyncQueueEntry } from '../types/room';

export async function loadQueue(): Promise<SyncQueueEntry[]> {
  const result = await db.loadSyncQueue();
  if (result.status === 'ok' && result.data) {
    return result.data as SyncQueueEntry[];
  }
  return [];
}

export async function saveQueue(queue: SyncQueueEntry[]): Promise<void> {
  await db.saveSyncQueue(queue);
}

export async function clearQueue(): Promise<void> {
  await db.saveSyncQueue([]);
}
