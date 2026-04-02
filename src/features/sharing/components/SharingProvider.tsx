import React, { createContext, useContext, useCallback, useRef, useMemo, useState } from 'react';
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
} from '../types/room';
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
    createRoom,
    joinRoom,
    rejoinRoom,
    leaveRoom,
    refreshMembers,
    getRoomMembersForRejoin,
  } = useRoom(userId);

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

  // 自動退出（1時間操作なし）
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
    alert('1時間以上操作がなかったため、ルームから自動退出しました。データはローカルに保存されています。');
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

  const contextValue: SharingContextValue = useMemo(
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
    }),
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
    ],
  );

  return (
    <SharingContext.Provider value={contextValue}>
      {children}
    </SharingContext.Provider>
  );
};
