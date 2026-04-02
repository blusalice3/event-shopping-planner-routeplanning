import type { SupabaseClient } from '@supabase/supabase-js';
import * as notificationService from './notificationService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDB = SupabaseClient<any>;

export type MemberStatus = 'roaming' | 'inQueue' | 'done' | 'resting';

/** メンバーステータス更新 */
export async function updateMemberStatus(
  supabase: SupabaseDB,
  roomId: string,
  userId: string,
  status: MemberStatus,
  extra?: {
    queueCircleName?: string;
    remainingItems?: number;
  },
): Promise<void> {
  const updates: Record<string, unknown> = {
    status,
    last_seen_at: new Date().toISOString(),
  };

  if (status === 'inQueue' && extra?.queueCircleName) {
    updates.queue_circle_name = extra.queueCircleName;
    updates.queue_started_at = new Date().toISOString();
  } else {
    updates.queue_circle_name = null;
    updates.queue_started_at = null;
  }

  if (extra?.remainingItems !== undefined) {
    updates.remaining_items = extra.remainingItems;
  }

  await supabase
    .from('room_members')
    .update(updates)
    .eq('room_id', roomId)
    .eq('user_id', userId);
}

/** ヘルプ要請 */
export async function requestHelp(
  supabase: SupabaseDB,
  roomId: string,
  userId: string,
  displayName: string,
  circleName: string,
  remainingItems: number,
): Promise<void> {
  // ステータスをinQueueに更新
  await updateMemberStatus(supabase, roomId, userId, 'inQueue', {
    queueCircleName: circleName,
    remainingItems,
  });

  // ヘルプ要請通知をブロードキャスト
  await notificationService.broadcastNotification(supabase, roomId, 'help_request', {
    senderId: userId,
    senderName: displayName,
    circleName,
    remainingItems,
    message: `${displayName}さんが${circleName}でヘルプを求めています（残り${remainingItems}件）`,
  });
}

/** ヘルプ引き受け */
export async function acceptHelp(
  supabase: SupabaseDB,
  roomId: string,
  helperId: string,
  helperName: string,
  requesterId: string,
): Promise<string[]> {
  // 要請者の未購入アイテムを取得
  const { data: requesterItems } = await supabase
    .from('room_items')
    .select('local_item_id')
    .eq('room_id', roomId)
    .eq('assigned_to', requesterId)
    .eq('purchase_status', 'None');

  const itemIds = (requesterItems ?? []).map(
    (item: Record<string, unknown>) => item.local_item_id as string,
  );

  // アイテムをヘルパーに再割り当て
  if (itemIds.length > 0) {
    for (const localItemId of itemIds) {
      await supabase
        .from('room_items')
        .update({
          assigned_to: helperId,
          updated_by: helperId,
          updated_at: new Date().toISOString(),
        })
        .eq('room_id', roomId)
        .eq('local_item_id', localItemId);
    }
  }

  // 承諾通知を送信
  await notificationService.createNotification(supabase, roomId, 'help_accepted', {
    senderId: helperId,
    senderName: helperName,
    itemCount: itemIds.length,
    message: `${helperName}さんがヘルプを引き受けました（${itemIds.length}件）`,
  }, requesterId);

  return itemIds;
}
