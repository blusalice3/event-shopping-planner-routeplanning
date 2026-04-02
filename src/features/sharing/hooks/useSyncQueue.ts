import { useState, useCallback, useEffect, useRef } from 'react';
import { db } from '../../../utils/indexedDB';
import type { SyncQueueEntry } from '../types/room';

const MAX_RETRIES = 3;

interface UseSyncQueueReturn {
  queueSize: number;
  enqueue: (entry: Omit<SyncQueueEntry, 'id' | 'createdAt' | 'status' | 'retryCount'>) => Promise<void>;
  drainQueue: (
    processor: (entry: SyncQueueEntry) => Promise<'success' | 'conflict' | 'error'>,
  ) => Promise<void>;
}

/**
 * オフライン同期キュー管理フック。
 * IndexedDB syncQueueストアを使用してオフライン操作をキューイングし、
 * ネットワーク復帰時にFIFO順でドレインする。
 */
export function useSyncQueue(isOnline: boolean): UseSyncQueueReturn {
  const [queueSize, setQueueSize] = useState(0);
  const isDrainingRef = useRef(false);
  const processorRef = useRef<
    ((entry: SyncQueueEntry) => Promise<'success' | 'conflict' | 'error'>) | null
  >(null);

  // 初期ロード
  useEffect(() => {
    db.loadSyncQueue().then((result) => {
      if (result.status === 'ok' && result.data) {
        setQueueSize((result.data as SyncQueueEntry[]).length);
      }
    });
  }, []);

  const loadQueue = useCallback(async (): Promise<SyncQueueEntry[]> => {
    const result = await db.loadSyncQueue();
    if (result.status === 'ok' && result.data) {
      return result.data as SyncQueueEntry[];
    }
    return [];
  }, []);

  const saveQueue = useCallback(async (queue: SyncQueueEntry[]) => {
    await db.saveSyncQueue(queue);
    setQueueSize(queue.length);
  }, []);

  const enqueue = useCallback(
    async (entry: Omit<SyncQueueEntry, 'id' | 'createdAt' | 'status' | 'retryCount'>) => {
      const queue = await loadQueue();
      const newEntry: SyncQueueEntry = {
        ...entry,
        id: `sq-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        createdAt: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
      };
      queue.push(newEntry);
      await saveQueue(queue);
    },
    [loadQueue, saveQueue],
  );

  const drainQueue = useCallback(
    async (
      processor: (entry: SyncQueueEntry) => Promise<'success' | 'conflict' | 'error'>,
    ) => {
      if (isDrainingRef.current) return;
      isDrainingRef.current = true;
      processorRef.current = processor;

      try {
        let queue = await loadQueue();
        const remaining: SyncQueueEntry[] = [];

        for (const entry of queue) {
          if (entry.status === 'failed' && entry.retryCount >= MAX_RETRIES) {
            continue; // 最大リトライ超過分は破棄
          }

          const result = await processor(entry);

          if (result === 'success' || result === 'conflict') {
            // 成功またはコンフリクト（ロールバック済み）: キューから除去
            continue;
          } else {
            // エラー: リトライカウント増加して残す
            remaining.push({
              ...entry,
              status: 'failed',
              retryCount: entry.retryCount + 1,
            });
          }
        }

        await saveQueue(remaining);
      } finally {
        isDrainingRef.current = false;
      }
    },
    [loadQueue, saveQueue],
  );

  // オフライン→オンライン復帰時の自動ドレイン
  useEffect(() => {
    if (isOnline && queueSize > 0 && processorRef.current) {
      drainQueue(processorRef.current);
    }
  }, [isOnline, queueSize, drainQueue]);

  return { queueSize, enqueue, drainQueue };
}
