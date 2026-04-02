import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '../config/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { ActiveRoom, RemoteItemUpdate, RemoteMapDataUpdate, RoomMember } from '../types/room';
import type { AppNotification } from '../services/notificationService';

interface UseRoomSyncParams {
  activeRoom: ActiveRoom | null;
  userId: string | null;
  onRemoteItemUpdate: ((update: RemoteItemUpdate) => void) | null;
  onMemberUpdate: (members: RoomMember[]) => void;
  onNotification?: (notification: AppNotification) => void;
  onMapDataUpdate?: (update: RemoteMapDataUpdate) => void;
  onRoomUpdate?: (updatedRoom: { createdBy: string }) => void;
}

interface UseRoomSyncReturn {
  pendingWrites: Set<string>;
  channel: RealtimeChannel | null;
  addPendingWrite: (localItemId: string) => void;
  removePendingWrite: (localItemId: string, delay?: number) => void;
}

/**
 * Supabase Realtime Postgres Changes購読フック。
 * room_items と room_members の変更をリアルタイムで受信し、
 * pendingWritesSetで自分のエコーをスキップする。
 */
export function useRoomSync({
  activeRoom,
  userId,
  onRemoteItemUpdate,
  onMemberUpdate,
  onNotification,
  onMapDataUpdate,
  onRoomUpdate,
}: UseRoomSyncParams): UseRoomSyncReturn {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pendingWritesRef = useRef(new Set<string>());
  const onRemoteItemUpdateRef = useRef(onRemoteItemUpdate);
  const onMemberUpdateRef = useRef(onMemberUpdate);
  const onNotificationRef = useRef(onNotification);
  const onMapDataUpdateRef = useRef(onMapDataUpdate);
  const onRoomUpdateRef = useRef(onRoomUpdate);

  // コールバックの最新版を保持
  useEffect(() => {
    onRemoteItemUpdateRef.current = onRemoteItemUpdate;
  }, [onRemoteItemUpdate]);
  useEffect(() => {
    onMemberUpdateRef.current = onMemberUpdate;
  }, [onMemberUpdate]);
  useEffect(() => {
    onNotificationRef.current = onNotification;
  }, [onNotification]);
  useEffect(() => {
    onMapDataUpdateRef.current = onMapDataUpdate;
  }, [onMapDataUpdate]);
  useEffect(() => {
    onRoomUpdateRef.current = onRoomUpdate;
  }, [onRoomUpdate]);

  // チャネル購読の確立・解除
  useEffect(() => {
    if (!supabase || !activeRoom || !userId) {
      channelRef.current = null;
      return;
    }

    const channel = supabase
      .channel(`room:${activeRoom.roomCode}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_items',
          filter: `room_id=eq.${activeRoom.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const newRow = payload.new as Record<string, unknown>;
            const localItemId = newRow.local_item_id as string;

            // 自分の書き込みエコーをスキップ
            if (pendingWritesRef.current.has(localItemId)) return;

            // 自分がupdated_byの場合もスキップ
            if (newRow.updated_by === userId) return;

            onRemoteItemUpdateRef.current?.({
              localItemId,
              purchaseStatus: newRow.purchase_status as RemoteItemUpdate['purchaseStatus'],
              assignedTo: (newRow.assigned_to as string | null) ?? null,
              price: newRow.price as number | null,
              quantity: newRow.quantity as number,
              postponed: newRow.postponed as boolean,
              orderIndex: newRow.order_index as number | undefined,
              updatedBy: newRow.updated_by as string | undefined,
            });
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_members',
          filter: `room_id=eq.${activeRoom.id}`,
        },
        () => {
          // メンバー状態変更時は全メンバーを再取得
          if (supabase) {
            import('../services/roomService').then(({ getRoomMembers }) => {
              getRoomMembers(supabase!, activeRoom.id).then((m) => {
                onMemberUpdateRef.current(m);
              });
            });
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_map_data',
          filter: `room_id=eq.${activeRoom.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const newRow = payload.new as Record<string, unknown>;
            // 自分が更新した場合はスキップ
            if (newRow.updated_by === userId) return;

            onMapDataUpdateRef.current?.({
              dataType: newRow.data_type as 'mapData' | 'hallDefinitions',
              mapName: newRow.map_name as string,
              data: newRow.data,
            });
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `room_id=eq.${activeRoom.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          // 自分が送信した通知はスキップ
          const senderId = (row.payload as Record<string, unknown> | null)?.senderId;
          if (senderId === userId) return;

          onNotificationRef.current?.({
            id: row.id as string,
            roomId: row.room_id as string,
            targetUserId: row.target_user_id as string | null,
            type: row.type as AppNotification['type'],
            payload: (row.payload ?? {}) as Record<string, unknown>,
            isRead: row.is_read as boolean,
            createdAt: row.created_at as string,
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: `id=eq.${activeRoom.id}`,
        },
        (payload) => {
          const updatedRoom = payload.new as Record<string, unknown>;
          onRoomUpdateRef.current?.({
            createdBy: updatedRoom.created_by as string,
          });
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase!.removeChannel(channel);
      channelRef.current = null;
    };
  }, [activeRoom?.id, activeRoom?.roomCode, userId]);

  const addPendingWrite = useCallback((localItemId: string) => {
    pendingWritesRef.current.add(localItemId);
  }, []);

  const removePendingWrite = useCallback((localItemId: string, delay = 2000) => {
    if (delay > 0) {
      setTimeout(() => {
        pendingWritesRef.current.delete(localItemId);
      }, delay);
    } else {
      pendingWritesRef.current.delete(localItemId);
    }
  }, []);

  return {
    pendingWrites: pendingWritesRef.current,
    channel: channelRef.current,
    addPendingWrite,
    removePendingWrite,
  };
}
