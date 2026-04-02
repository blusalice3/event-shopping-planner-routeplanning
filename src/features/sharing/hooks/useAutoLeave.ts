import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom } from '../types/room';
import * as roomService from '../services/roomService';
import * as notificationService from '../services/notificationService';

const AUTO_LEAVE_TIMEOUT_MS = 10 * 60 * 1000; // 10分
const CHECK_INTERVAL_MS = 60 * 1000; // 1分ごとにチェック

interface UseAutoLeaveParams {
  activeRoom: ActiveRoom | null;
  userId: string | null;
  onAutoLeave: () => Promise<void>;
}

/**
 * 10分以上操作がないユーザーを自動退出させるフック。
 * - ユーザー操作（クリック/タッチ/キー入力）で最終操作時刻を更新
 * - 1分ごとに最終操作時刻をチェック
 * - 10分超過で退出処理を実行（ホスト移譲 → 退出）
 * - ホスト移譲はDB関数(delegate_host)経由でRLSを安全にバイパス
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

      console.log('Auto-leave: 10分以上操作なし、自動退出を開始');

      try {
        // ホストの場合、次のメンバーにホスト権限を移譲（DB関数経由）
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
 * ホスト権限を次のメンバーに移譲する（DB関数経由）。
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

  // DB関数経由でホスト移譲（RLSバイパス）
  const success = await roomService.transferHost(supabase, roomId, currentHostId, newHost.userId);

  if (!success) {
    console.error('Host transfer failed via delegate_host');
    return;
  }

  // 全員にホスト移譲通知
  await notificationService.broadcastNotification(
    supabase,
    roomId,
    'host_transferred',
    {
      senderId: currentHostId,
      message: `${newHost.displayName}さんが新しいホストになりました`,
      senderName: 'システム',
      newHostUserId: newHost.userId,
      newHostDisplayName: newHost.displayName,
      newHostJerseyNumber: newHost.jerseyNumber,
    },
  );
}
