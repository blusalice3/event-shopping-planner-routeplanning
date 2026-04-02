import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../config/supabase';
import type { ClaimResult, SyncQueueEntry } from '../types/room';
import * as roomService from './roomService';

type SupabaseDB = SupabaseClient<Database>;

/**
 * オフラインキューエントリを処理する。
 * useSyncQueue.drainQueue()のprocessorコールバックとして使用。
 */
export async function processSyncQueueEntry(
  supabase: SupabaseDB,
  entry: SyncQueueEntry,
  onConflict: (localItemId: string, claimedBy: string) => void,
): Promise<'success' | 'conflict' | 'error'> {
  const { operation, payload } = entry;

  try {
    if (operation === 'claim_item') {
      // room_itemのUUIDをルックアップ
      const roomItemId = await roomService.getRoomItemId(
        supabase,
        payload.roomId,
        payload.localItemId,
      );

      if (!roomItemId) {
        // アイテムがルームに存在しない場合はスキップ
        return 'success';
      }

      const result: ClaimResult = await roomService.claimItem(
        supabase,
        payload.roomId,
        roomItemId,
        payload.userId,
        payload.status ?? 'None',
      );

      if (result.success) {
        return 'success';
      } else if (result.claimedBy) {
        onConflict(payload.localItemId, result.claimedBy);
        return 'conflict';
      } else {
        return 'error';
      }
    }

    if (operation === 'update_item') {
      await roomService.updateRoomItem(
        supabase,
        payload.roomId,
        payload.localItemId,
        payload.updates ?? {},
      );
      return 'success';
    }

    return 'error';
  } catch {
    return 'error';
  }
}
