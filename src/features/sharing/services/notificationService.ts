import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDB = SupabaseClient<any>;

export type NotificationType =
  | 'limited_purchase'
  | 'help_request'
  | 'help_accepted'
  | 'bulk_transfer'
  | 'price_update'
  | 'item_added'
  // 再参加承認系
  | 'rejoin_request'       // → ホスト/副ホスト宛
  | 'rejoin_approved'      // → リクエスト者宛
  | 'rejoin_rejected'      // → リクエスト者宛
  // ホスト移譲系
  | 'host_transfer_offer'  // → 最古参メンバー宛（承諾依頼）+ ホスト宛
  | 'host_transfer_veto'   // → ホスト宛（拒否権の行使通知）
  | 'host_transferred'     // → 全員宛（移譲確定通知）
  // メンバー引き継ぎ
  | 'member_inherited';    // → 全員宛（メンバー引き継ぎ通知）

export interface AppNotification {
  id: string;
  roomId: string;
  targetUserId: string | null;
  type: NotificationType;
  payload: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

/** 通知作成（特定ユーザー宛て） */
export async function createNotification(
  supabase: SupabaseDB,
  roomId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
  targetUserId?: string,
): Promise<void> {
  await supabase.from('notifications').insert({
    room_id: roomId,
    type,
    payload,
    target_user_id: targetUserId ?? null,
  });
}

/** ブロードキャスト通知（全メンバー宛て） */
export async function broadcastNotification(
  supabase: SupabaseDB,
  roomId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<void> {
  await supabase.from('notifications').insert({
    room_id: roomId,
    type,
    payload,
    target_user_id: null,
  });
}

/** 未読通知を取得 */
export async function getUnreadNotifications(
  supabase: SupabaseDB,
  roomId: string,
  userId: string,
): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('room_id', roomId)
    .or(`target_user_id.eq.${userId},target_user_id.is.null`)
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return [];

  return (data ?? []).map((n: Record<string, unknown>) => ({
    id: n.id as string,
    roomId: n.room_id as string,
    targetUserId: n.target_user_id as string | null,
    type: n.type as NotificationType,
    payload: (n.payload ?? {}) as Record<string, unknown>,
    isRead: n.is_read as boolean,
    createdAt: n.created_at as string,
  }));
}

/** 通知を既読にする */
export async function markNotificationRead(
  supabase: SupabaseDB,
  notificationId: string,
): Promise<void> {
  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);
}

/** 全通知を既読にする */
export async function markAllRead(
  supabase: SupabaseDB,
  roomId: string,
  userId: string,
): Promise<void> {
  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('room_id', roomId)
    .or(`target_user_id.eq.${userId},target_user_id.is.null`)
    .eq('is_read', false);
}
