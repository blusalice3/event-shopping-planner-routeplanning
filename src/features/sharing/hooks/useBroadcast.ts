import { useEffect, useRef, useCallback, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { BroadcastEventMap, BroadcastEventName } from '../types/broadcast';

interface UseBroadcastReturn<E extends BroadcastEventName> {
  send: (payload: Omit<BroadcastEventMap[E], 'senderId' | 'timestamp'>) => void;
  lastMessage: BroadcastEventMap[E] | null;
}

/**
 * Supabase Broadcast Channel APIの汎用フック。
 * 既存のroom:${roomCode}チャネル上でエフェメラルデータを送受信する。
 * DB書き込みなしの軽量通信（位置情報、スタンプ等）に使用。
 *
 * レート制限: Supabaseクライアントの eventsPerSecond: 10 に従う。
 * 高頻度送信が必要な場合は消費側でthrottleすること。
 */
export function useBroadcast<E extends BroadcastEventName>(
  channel: RealtimeChannel | null,
  event: E,
  userId: string | null,
  onReceive?: (payload: BroadcastEventMap[E]) => void,
): UseBroadcastReturn<E> {
  const [lastMessage, setLastMessage] = useState<BroadcastEventMap[E] | null>(null);
  const onReceiveRef = useRef(onReceive);
  const userIdRef = useRef(userId);
  const channelRef = useRef(channel);
  const handlerRef = useRef<((msg: { type: string; event: string; payload: BroadcastEventMap[E] }) => void) | null>(null);

  // コールバック・値の最新版を保持（リスナー再登録を防止）
  useEffect(() => {
    onReceiveRef.current = onReceive;
  }, [onReceive]);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // broadcastリスナーの登録・解除
  useEffect(() => {
    if (!channel) {
      handlerRef.current = null;
      return;
    }

    const handler = (msg: { type: string; event: string; payload: BroadcastEventMap[E] }) => {
      const payload = msg.payload;
      // エコー抑制: 自分の送信は無視
      if (payload.senderId === userIdRef.current) return;

      setLastMessage(payload);
      onReceiveRef.current?.(payload);
    };

    handlerRef.current = handler;
    channel.on('broadcast', { event }, handler);

    return () => {
      // channel.bindings.broadcastから該当ハンドラを除去
      const bindings = channel.bindings?.broadcast;
      if (bindings) {
        const idx = bindings.findIndex((b) => b.callback === handler);
        if (idx !== -1) bindings.splice(idx, 1);
      }
      handlerRef.current = null;
    };
  }, [channel, event]);

  // 送信関数（安定参照）
  const send = useCallback(
    (payload: Omit<BroadcastEventMap[E], 'senderId' | 'timestamp'>) => {
      const ch = channelRef.current;
      const uid = userIdRef.current;
      if (!ch || !uid) return;

      ch.send({
        type: 'broadcast',
        event,
        payload: {
          ...payload,
          senderId: uid,
          timestamp: Date.now(),
        },
      });
    },
    [event],
  );

  return { send, lastMessage };
}
