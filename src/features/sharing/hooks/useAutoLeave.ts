import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom } from '../types/room';
import * as roomService from '../services/roomService';
import * as notificationService from '../services/notificationService';

const AUTO_LEAVE_TIMEOUT_MS = 60 * 60 * 1000; // 1時間
const CHECK_INTERVAL_MS = 60 * 1000; // 1分ごとにチェック

interface UseAutoLeaveParams {
  activeRoom: ActiveRoom | null;
  userId: string | null;
  onAutoLeave: () => Promise<void>;
}

/**
 * 1時間以上操作がないユーザーを自動退出させるフック。
 * - ユーザー操作（クリック/タッチ/キー入力）で最終操作時刻を更新
 * - 1分ごとに最終操作時刻をチェック
 * - 1時間超過で退出処理を実行（データ書き戻し → ホスト移譲 → 退出）
 */
export function useAutoLeave({
  activeRoom,
  userId,
  onAutoLeave,
}: UseAutoLeaveParams): void {
  const lastActivityRef = useRef(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ユーザー操作を検知して最終操作時刻を更新
  const updateActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!activeRoom || !userId) return;

    // 操作イベントをリッスン
    const events = ['click', 'touchstart', 'keydown', 'scroll'] as const;
    for (const event of events) {
      window.addEventListener(event, updateActivity, { passive: true });
    }

    // 1分ごとにタイムアウトチェック
    intervalRef.current = setInterval(async () => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed < AUTO_LEAVE_TIMEOUT_MS) return;
      if (!supabase || !activeRoom || !userId) return;

      console.log('Auto-leave: 1時間以上操作なし、自動退出を開始');

      try {
        // ホストの場合、次のメンバーにホスト権限を移譲
        if (activeRoom.isHost) {
          await transferHostRole(activeRoom.id, userId);
        }

        // データ書き戻し → 退出
        await onAutoLeave();
      } catch (err) {
        console.error('Auto-leave failed:', err);
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      for (const event of events) {
        window.removeEventListener(event, updateActivity);
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activeRoom?.id, userId, updateActivity, onAutoLeave]);
}

/**
 * ホスト権限を次のメンバーに移譲する。
 * joined_atが2番目に古いメンバー（最初のゲスト）を新ホストにする。
 */
async function transferHostRole(
  roomId: string,
  currentHostId: string,
): Promise<void> {
  if (!supabase) return;

  // 全メンバーをjoined_at順で取得
  const members = await roomService.getRoomMembers(supabase, roomId);
  const otherMembers = members.filter((m) => m.userId !== currentHostId);

  if (otherMembers.length === 0) return; // 自分だけなら移譲不要

  // joined_atが最も古いメンバーを新ホストに
  const newHost = otherMembers[0]; // getRoomMembersはjoined_at asc順

  // rooms.created_byを新ホストに更新
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('rooms')
    .update({ created_by: newHost.userId })
    .eq('id', roomId);

  if (error) {
    console.error('Host transfer failed:', error.message);
    return;
  }

  // 新ホストに通知
  await notificationService.createNotification(
    supabase,
    roomId,
    'bulk_transfer', // 既存の通知タイプを流用
    {
      senderId: currentHostId,
      message: `${newHost.displayName}さんがホストになりました`,
      senderName: 'システム',
    },
    newHost.userId,
  );
}
