import { useEffect, useRef } from 'react';
import { supabase } from '../config/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { ActiveRoom } from '../types/room';
import { updateHeartbeat } from '../services/roomService';

const HEARTBEAT_INTERVAL_MS = 30_000;

interface UsePresenceParams {
  channel: RealtimeChannel | null;
  activeRoom: ActiveRoom | null;
  userId: string | null;
  displayName: string;
  color: string;
}

/**
 * Supabase Presenceフック。
 * オンライン追跡 + 30秒間隔heartbeatでroom_members.is_online/last_seen_atを更新。
 */
export function usePresence({
  channel,
  activeRoom,
  userId,
  displayName,
  color,
}: UsePresenceParams): void {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!channel || !activeRoom || !userId || !supabase) return;

    // Presenceに自分を追跡登録
    channel.track({
      userId,
      displayName,
      color,
      online_at: new Date().toISOString(),
    });

    // Heartbeat: 30秒ごとにroom_membersを更新
    intervalRef.current = setInterval(() => {
      if (supabase) {
        updateHeartbeat(supabase, activeRoom.id, userId);
      }
    }, HEARTBEAT_INTERVAL_MS);

    // visibilitychange復帰時にPresenceを再trackし、heartbeat即実行
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && supabase) {
        channel.track({
          userId,
          displayName,
          color,
          online_at: new Date().toISOString(),
        });
        updateHeartbeat(supabase, activeRoom.id, userId);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      channel.untrack();
    };
  }, [channel, activeRoom?.id, userId, displayName, color]);
}
