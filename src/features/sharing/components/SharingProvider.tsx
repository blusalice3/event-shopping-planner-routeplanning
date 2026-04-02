import React, { createContext, useContext, useCallback, useRef, useMemo, useState, useEffect } from 'react';
import { supabase, isSharingEnabled } from '../config/supabase';
import type { ShoppingItem, PurchaseStatus } from '../../../types';
import type {
  SharingContextValue,
  ActiveRoom,
  RoomMember,
  RemoteItemUpdate,
  RemoteMapDataUpdate,
  ClaimResult,
  SyncStatus,
  MigrationResult,
  RejoinRequest,
} from '../types/room';
import type { AppNotification } from '../services/notificationService';
import { useSupabaseAuth } from '../hooks/useSupabaseAuth';
import { useRoom } from '../hooks/useRoom';
import { useRoomSync } from '../hooks/useRoomSync';
import { useAssignment } from '../hooks/useAssignment';
import { usePresence } from '../hooks/usePresence';
import { useRoomMigration } from '../hooks/useRoomMigration';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useSyncQueue } from '../hooks/useSyncQueue';
import { useAutoLeave } from '../hooks/useAutoLeave';
import { useNotifications } from '../hooks/useNotifications';
import * as roomService from '../services/roomService';
import * as notificationService from '../services/notificationService';

const HOST_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分
const TRANSFER_VETO_WINDOW_MS = 5 * 60 * 1000; // 5分（デフォルト拒否権ウィンドウ）
const TRANSFER_CHECK_INTERVAL_MS = 60 * 1000; // 1分

const SharingContext = createContext<SharingContextValue | null>(null);

export function useSharing(): SharingContextValue | null {
  return useContext(SharingContext);
}

interface SharingProviderProps {
  children: React.ReactNode;
}

export const SharingProvider: React.FC<SharingProviderProps> = ({ children }) => {
  if (!isSharingEnabled()) {
    return <SharingContext.Provider value={null}>{children}</SharingContext.Provider>;
  }

  return <SharingProviderInner>{children}</SharingProviderInner>;
};

const SharingProviderInner: React.FC<SharingProviderProps> = ({ children }) => {
  const { userId, isAuthReady } = useSupabaseAuth();
  const {
    activeRoom,
    members,
    isRoomLoading,
    roomError,
    pendingRejoin,
    createRoom,
    joinRoom,
    rejoinRoom,
    requestRejoinWithApproval,
    cancelPendingRejoin,
    leaveRoom,
    refreshMembers,
    getRoomMembersForRejoin,
    setActiveRoom,
  } = useRoom(userId);

  // justRejoined フラグ（再参加/引き継ぎ直後のパルスアニメーション用）
  const [justRejoined, setJustRejoined] = useState(false);
  const justRejoinedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { isOnline } = useConnectionStatus();
  const { queueSize, enqueue, drainQueue } = useSyncQueue(isOnline);

  // リモート更新ハンドラ（App.tsxから登録される）
  const remoteUpdateHandlerRef = useRef<((update: RemoteItemUpdate) => void) | null>(null);
  const mapDataUpdateHandlerRef = useRef<((update: RemoteMapDataUpdate) => void) | null>(null);

  const [membersState, setMembersState] = useState<RoomMember[]>([]);
  // membersが変わったらローカルステートも更新
  React.useEffect(() => {
    setMembersState(members);
  }, [members]);

  const onRemoteItemUpdate = useCallback((update: RemoteItemUpdate) => {
    remoteUpdateHandlerRef.current?.(update);
  }, []);

  const onMemberUpdate = useCallback((updatedMembers: RoomMember[]) => {
    setMembersState(updatedMembers);
  }, []);

  const onMapDataUpdate = useCallback((update: RemoteMapDataUpdate) => {
    mapDataUpdateHandlerRef.current?.(update);
  }, []);

  // rooms テーブル更新時: isHost をリアルタイム更新
  const onRoomUpdate = useCallback((updatedRoom: { createdBy: string }) => {
    setActiveRoom((prev) =>
      prev ? { ...prev, createdBy: updatedRoom.createdBy, isHost: updatedRoom.createdBy === userId } : null,
    );
  }, [userId, setActiveRoom]);

  const {
    latestToast,
    dismissToast,
    unreadCount,
    broadcastNotification: broadcastNotificationAction,
    handleIncomingNotification,
  } = useNotifications(activeRoom, userId);

  const { channel, addPendingWrite, removePendingWrite } = useRoomSync({
    activeRoom,
    userId,
    onRemoteItemUpdate,
    onMemberUpdate,
    onNotification: handleIncomingNotification,
    onMapDataUpdate,
    onRoomUpdate,
  });

  // 現在のメンバー情報からdisplayName/colorを取得
  const currentMember = useMemo(
    () => membersState.find((m) => m.userId === userId),
    [membersState, userId],
  );

  usePresence({
    channel,
    activeRoom,
    userId,
    displayName: currentMember?.displayName ?? '',
    color: currentMember?.color ?? '#3B82F6',
  });

  const { uploadItemsToRoom, mergeGuestItems, downloadRoomItems, uploadMapDataToRoom, downloadMapDataFromRoom } = useRoomMigration(activeRoom);

  const {
    myItemsOnly,
    toggleMyItemsFilter,
    assignItem: assignItemAction,
    bulkAssignItems: bulkAssignItemsAction,
  } = useAssignment(activeRoom, userId, addPendingWrite, removePendingWrite);

  // ── 再参加承認/拒否ハンドラ ──
  const handleApproveRejoin = useCallback(async (notification: AppNotification) => {
    if (!supabase || !activeRoom) return;
    const payload = notification.payload as unknown as RejoinRequest;
    await roomService.approveRejoin(supabase, activeRoom.id, payload);
    // 承認通知を送信
    await notificationService.createNotification(
      supabase, activeRoom.id, 'rejoin_approved',
      { message: '再参加が承認されました。' },
      payload.requesterId,
    );
    await notificationService.markNotificationRead(supabase, notification.id);
  }, [activeRoom]);

  const handleRejectRejoin = useCallback(async (notification: AppNotification) => {
    if (!supabase || !activeRoom) return;
    const payload = notification.payload as unknown as RejoinRequest;
    await notificationService.createNotification(
      supabase, activeRoom.id, 'rejoin_rejected',
      { message: '再参加が拒否されました。' },
      payload.requesterId,
    );
    // 同一ターゲットの未読rejoin_requestを一括既読化
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('notifications')
      .update({ is_read: true })
      .eq('room_id', activeRoom.id)
      .eq('type', 'rejoin_request')
      .eq('is_read', false)
      .contains('payload', { targetJerseyNumber: payload.targetJerseyNumber });
  }, [activeRoom]);

  // ── ホスト移譲ハンドラ ──
  const handleAcceptHostTransfer = useCallback(async (notification: AppNotification) => {
    if (!supabase || !userId) return;
    // 承諾記録をpayloadに書き込み
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('notifications').update({
      payload: { ...notification.payload, acceptedAt: new Date().toISOString(), acceptedBy: userId },
    }).eq('id', notification.id);
    await notificationService.markNotificationRead(supabase, notification.id);
  }, [userId]);

  const handleDeclineHostTransfer = useCallback(async (notification: AppNotification) => {
    if (!supabase) return;
    await notificationService.markNotificationRead(supabase, notification.id);
    // 辞退 → 次の候補にオファーを再送（DB関数が次回チェック時に処理）
  }, []);

  const handleVetoHostTransfer = useCallback(async (notification: AppNotification) => {
    if (!supabase || !activeRoom || !userId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).rpc('veto_host_transfer', {
      p_notification_id: notification.id,
      p_room_id: activeRoom.id,
      p_host_id: userId,
    });
    await notificationService.markNotificationRead(supabase, notification.id);
  }, [activeRoom, userId]);

  // ── ホスト委任/副ホスト操作 ──
  const handleDelegateHost = useCallback(async (targetUserId: string) => {
    if (!supabase || !activeRoom || !userId) return;
    const success = await roomService.transferHost(supabase, activeRoom.id, userId, targetUserId);
    if (success) {
      const target = membersState.find((m) => m.userId === targetUserId);
      await notificationService.broadcastNotification(supabase, activeRoom.id, 'host_transferred', {
        senderId: userId,
        message: `${target?.displayName ?? ''}さんが新しいホストになりました`,
        senderName: 'システム',
        newHostUserId: targetUserId,
        newHostDisplayName: target?.displayName,
        newHostJerseyNumber: target?.jerseyNumber,
      });
    }
  }, [activeRoom, userId, membersState]);

  const handleSetSubHost = useCallback(async (targetUserId: string) => {
    if (!supabase || !activeRoom) return;
    await roomService.setSubHost(supabase, activeRoom.id, targetUserId);
    await refreshMembers();
  }, [activeRoom, refreshMembers]);

  const handleRemoveSubHost = useCallback(async (targetUserId: string) => {
    if (!supabase || !activeRoom) return;
    await roomService.removeSubHost(supabase, activeRoom.id, targetUserId);
    await refreshMembers();
  }, [activeRoom, refreshMembers]);

  // ── メンバー引き継ぎ ──
  const handleInheritMember = useCallback(async (targetJerseyNumber: number) => {
    if (!supabase || !activeRoom || !userId) return;
    const result = await roomService.inheritMember(supabase, activeRoom.id, userId, targetJerseyNumber);
    if (result.success) {
      // 全員に通知
      await notificationService.broadcastNotification(supabase, activeRoom.id, 'member_inherited', {
        senderId: userId,
        displayName: currentMember?.displayName ?? '',
        fromJersey: result.fromJersey,
        toJersey: result.toJersey,
        itemsMoved: result.itemsMoved,
        message: `${currentMember?.displayName ?? ''}さんが #${result.toJersey} を引き継ぎました`,
        senderName: 'システム',
      });
      // localStorage更新
      const stored = localStorage.getItem('sharing:activeRoom');
      if (stored) {
        const info = JSON.parse(stored);
        info.jerseyNumber = result.toJersey;
        localStorage.setItem('sharing:activeRoom', JSON.stringify(info));
      }
      await refreshMembers();
      // パルスアニメーション
      setJustRejoined(true);
      if (justRejoinedTimerRef.current) clearTimeout(justRejoinedTimerRef.current);
      justRejoinedTimerRef.current = setTimeout(() => setJustRejoined(false), 5000);
    } else {
      throw new Error(result.error ?? '引き継ぎに失敗しました');
    }
  }, [activeRoom, userId, currentMember, refreshMembers]);

  // ── 5分間隔: ホスト不在検出ポーリング ──
  useEffect(() => {
    if (!activeRoom || !userId || activeRoom.isHost) return;
    if (!supabase) return;

    const interval = setInterval(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).rpc('initiate_host_transfer_offer', {
          p_room_id: activeRoom.id,
        });
      } catch {
        // ignore
      }
    }, HOST_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [activeRoom?.id, userId, activeRoom?.isHost]);

  // ── 1分間隔: 拒否権ウィンドウ経過チェック ──
  useEffect(() => {
    if (!activeRoom || !userId || !supabase) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const interval = setInterval(async () => {
      try {
        const { data } = await sb
          .from('notifications')
          .select('id, payload')
          .eq('room_id', activeRoom.id)
          .eq('type', 'host_transfer_offer')
          .eq('is_read', false);

        for (const n of (data ?? []) as { id: string; payload: Record<string, unknown> }[]) {
          const payload = n.payload;
          if (!payload.acceptedAt || payload.vetoed || payload.executed) continue;
          const acceptedAt = new Date(payload.acceptedAt as string).getTime();

          // 拒否権ウィンドウの動的計算
          const { data: hostMember } = await sb
            .from('room_members')
            .select('last_seen_at')
            .eq('room_id', activeRoom.id)
            .eq('user_id', activeRoom.createdBy)
            .single();

          let vetoMs = TRANSFER_VETO_WINDOW_MS;
          if (hostMember) {
            const offlineMin = (Date.now() - new Date((hostMember as { last_seen_at: string }).last_seen_at).getTime()) / 60_000;
            if (offlineMin >= 20) vetoMs = 0;
            else if (offlineMin >= 15) vetoMs = 2 * 60_000;
          }

          if (Date.now() - acceptedAt >= vetoMs) {
            await sb.rpc('execute_host_transfer', {
              p_notification_id: n.id,
              p_room_id: activeRoom.id,
              p_new_host_id: payload.candidateUserId,
            });
          }
        }
      } catch {
        // ignore
      }
    }, TRANSFER_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [activeRoom?.id, activeRoom?.createdBy, userId]);

  // 自動退出（10分操作なし）
  const handleAutoLeave = useCallback(async () => {
    if (!supabase || !activeRoom || !userId) return;
    try {
      // データをローカルに書き戻し
      const roomItems = await roomService.getRoomItemsAsShoppingItems(supabase, activeRoom.id);
      // remoteUpdateHandlerを通じてApp.tsxに通知（ローカル保存はApp.tsx側で実行）
      if (roomItems.length > 0) {
        for (const item of roomItems) {
          remoteUpdateHandlerRef.current?.({
            localItemId: item.id,
            purchaseStatus: item.purchaseStatus,
            assignedTo: item.assignedTo,
            price: item.price,
            quantity: item.quantity,
            postponed: item.postponed,
            orderIndex: item.orderIndex,
          });
        }
      }
    } catch (err) {
      console.warn('Auto-leave data sync failed:', err);
    }
    // 退出実行
    await leaveRoom();
    alert('10分以上操作がなかったため、ルームから自動退出しました。データはローカルに保存されています。');
  }, [activeRoom, userId, leaveRoom]);

  useAutoLeave({ activeRoom, userId, onAutoLeave: handleAutoLeave });

  // 同期状態の導出
  const syncStatus: SyncStatus = useMemo(() => {
    if (!activeRoom) return 'disconnected';
    if (!isOnline) return 'offline';
    if (queueSize > 0) return 'syncing';
    return 'synced';
  }, [activeRoom, isOnline, queueSize]);

  // 購入ステータスの同期（Optimistic UI + claim_item RPC）
  const syncPurchaseStatus = useCallback(
    async (
      localItemId: string,
      status: PurchaseStatus,
      preChangeItem: ShoppingItem,
      onRollback: (item: ShoppingItem) => void,
    ): Promise<ClaimResult> => {
      if (!supabase || !activeRoom || !userId) {
        return { success: false, error: 'not_connected' };
      }

      addPendingWrite(localItemId);

      if (!isOnline) {
        // オフライン: キューにエンキュー
        await enqueue({
          operation: 'claim_item',
          payload: {
            roomId: activeRoom.id,
            itemId: '', // ドレイン時にルックアップ
            localItemId,
            userId,
            status,
          },
        });
        removePendingWrite(localItemId, 0);
        return { success: true }; // 楽観的成功
      }

      try {
        // room_itemのUUID取得
        const roomItemId = await roomService.getRoomItemId(
          supabase,
          activeRoom.id,
          localItemId,
        );

        if (!roomItemId) {
          // room_itemsに存在しない場合はupsert
          await roomService.updateRoomItem(supabase, activeRoom.id, localItemId, {
            purchase_status: status,
            updated_by: userId,
          });
          removePendingWrite(localItemId);
          return { success: true };
        }

        const result = await roomService.claimItem(
          supabase,
          activeRoom.id,
          roomItemId,
          userId,
          status,
        );

        if (result.success) {
          removePendingWrite(localItemId);
        } else {
          removePendingWrite(localItemId, 0);
          onRollback(preChangeItem);
        }

        return result;
      } catch (err) {
        removePendingWrite(localItemId, 0);
        onRollback(preChangeItem);
        return {
          success: false,
          error: err instanceof Error ? err.message : 'sync_error',
        };
      }
    },
    [activeRoom, userId, isOnline, addPendingWrite, removePendingWrite, enqueue],
  );

  // 一般的なアイテム更新の同期（last-write-wins）
  const syncItemUpdate = useCallback(
    async (localItemId: string, updates: Partial<ShoppingItem>) => {
      if (!supabase || !activeRoom || !userId) return;

      const dbUpdates: Record<string, unknown> = {};
      if (updates.price !== undefined) dbUpdates.price = updates.price;
      if (updates.quantity !== undefined) dbUpdates.quantity = updates.quantity;
      if (updates.title !== undefined) dbUpdates.title = updates.title;
      if (updates.postponed !== undefined) dbUpdates.postponed = updates.postponed;
      if (updates.orderIndex !== undefined) dbUpdates.order_index = updates.orderIndex;
      if (updates.assignedTo !== undefined) dbUpdates.assigned_to = updates.assignedTo;
      dbUpdates.updated_by = userId;

      try {
        addPendingWrite(localItemId);
        await roomService.updateRoomItem(supabase, activeRoom.id, localItemId, dbUpdates);
        removePendingWrite(localItemId);
      } catch {
        removePendingWrite(localItemId, 0);
      }
    },
    [activeRoom, userId, addPendingWrite, removePendingWrite],
  );

  const registerRemoteUpdateHandler = useCallback(
    (handler: (update: RemoteItemUpdate) => void) => {
      remoteUpdateHandlerRef.current = handler;
    },
    [],
  );

  const registerMapDataUpdateHandler = useCallback(
    (handler: (update: RemoteMapDataUpdate) => void) => {
      mapDataUpdateHandlerRef.current = handler;
    },
    [],
  );

  // マップデータのアップロード（App.tsxからIndexedDBのデータを渡して呼ぶ）
  const uploadMapDataToRoomAction = useCallback(
    async (
      eventName: string,
      mapDataInput?: Record<string, import('../../../types').DayMapData>,
      hallDefsInput?: Record<string, import('../../../types').HallDefinition[]>,
    ) => {
      if (!userId) return;
      await uploadMapDataToRoom(eventName, mapDataInput, hallDefsInput, userId);
    },
    [uploadMapDataToRoom, userId],
  );

  const contextValue = useMemo(
    () => ({
      userId,
      isAuthReady,
      activeRoom,
      members: membersState,
      isRoomLoading,
      roomError,
      syncStatus,
      isOnline,
      pendingQueueSize: queueSize,
      createRoom,
      joinRoom,
      rejoinRoom,
      leaveRoom,
      uploadMapDataToRoom: uploadMapDataToRoomAction,
      downloadMapDataFromRoom,
      getRoomMembersForRejoin,
      uploadItemsToRoom,
      mergeGuestItems,
      downloadRoomItems,
      syncPurchaseStatus,
      syncItemUpdate,
      assignItem: assignItemAction,
      bulkAssignItems: bulkAssignItemsAction,
      myItemsOnly,
      toggleMyItemsFilter,
      latestToast,
      dismissToast,
      unreadCount,
      broadcastNotification: broadcastNotificationAction,
      registerRemoteUpdateHandler,
      registerMapDataUpdateHandler,
      // 再参加承認
      pendingRejoin,
      requestRejoinWithApproval,
      cancelPendingRejoin,
      handleApproveRejoin,
      handleRejectRejoin,
      // ホスト移譲
      handleAcceptHostTransfer,
      handleDeclineHostTransfer,
      handleVetoHostTransfer,
      handleDelegateHost,
      // 副ホスト
      handleSetSubHost,
      handleRemoveSubHost,
      // メンバー引き継ぎ
      handleInheritMember,
      // パルスアニメーション
      justRejoined,
    } as SharingContextValue),
    [
      userId,
      isAuthReady,
      activeRoom,
      membersState,
      isRoomLoading,
      roomError,
      syncStatus,
      isOnline,
      queueSize,
      createRoom,
      joinRoom,
      rejoinRoom,
      leaveRoom,
      uploadMapDataToRoomAction,
      downloadMapDataFromRoom,
      getRoomMembersForRejoin,
      uploadItemsToRoom,
      mergeGuestItems,
      downloadRoomItems,
      syncPurchaseStatus,
      syncItemUpdate,
      assignItemAction,
      bulkAssignItemsAction,
      myItemsOnly,
      toggleMyItemsFilter,
      latestToast,
      dismissToast,
      unreadCount,
      broadcastNotificationAction,
      registerRemoteUpdateHandler,
      registerMapDataUpdateHandler,
      pendingRejoin,
      requestRejoinWithApproval,
      cancelPendingRejoin,
      handleApproveRejoin,
      handleRejectRejoin,
      handleAcceptHostTransfer,
      handleDeclineHostTransfer,
      handleVetoHostTransfer,
      handleDelegateHost,
      handleSetSubHost,
      handleRemoveSubHost,
      handleInheritMember,
      justRejoined,
    ],
  );

  return (
    <SharingContext.Provider value={contextValue}>
      {children}
    </SharingContext.Provider>
  );
};
