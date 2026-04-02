import { useCallback } from 'react';
import { supabase } from '../config/supabase';
import type { ShoppingItem, DayMapData, HallDefinition } from '../../../types';
import type { ActiveRoom, MigrationResult } from '../types/room';
import * as roomService from '../services/roomService';
import * as mapSyncService from '../services/mapSyncService';

interface UseRoomMigrationReturn {
  uploadItemsToRoom: (items: ShoppingItem[]) => Promise<void>;
  mergeGuestItems: (localItems: ShoppingItem[]) => Promise<MigrationResult>;
  downloadRoomItems: () => Promise<ShoppingItem[]>;
  uploadMapDataToRoom: (
    eventName: string,
    mapData?: Record<string, DayMapData>,
    hallDefinitions?: Record<string, HallDefinition[]>,
    userId?: string,
  ) => Promise<void>;
  downloadMapDataFromRoom: () => Promise<{
    mapData?: Record<string, unknown>;
    hallDefinitions?: Record<string, unknown[]>;
  }>;
}

/**
 * ローカル↔ルーム間のデータ移行フック。
 * - uploadItemsToRoom: ホスト作成時、ローカルアイテム → room_items
 * - mergeGuestItems: ゲスト参加時、重複検出して追加
 * - downloadRoomItems: ルーム退出時、room_items → ローカルShoppingItem[]
 */
export function useRoomMigration(activeRoom: ActiveRoom | null): UseRoomMigrationReturn {
  const uploadItemsToRoom = useCallback(
    async (items: ShoppingItem[]) => {
      if (!supabase || !activeRoom) throw new Error('ルームが未接続です');
      await roomService.bulkInsertRoomItems(supabase, activeRoom.id, items);
    },
    [activeRoom],
  );

  const mergeGuestItems = useCallback(
    async (localItems: ShoppingItem[]): Promise<MigrationResult> => {
      if (!supabase || !activeRoom) throw new Error('ルームが未接続です');

      // 既存のルームアイテムを取得
      const existingItems = await roomService.getRoomItemsAsShoppingItems(supabase, activeRoom.id);

      // 重複検出: (circle, eventDate, block, number) のタプルで比較
      const existingKeys = new Set(
        existingItems.map((item) =>
          `${item.circle}|${item.eventDate}|${item.block}|${item.number}`,
        ),
      );

      const newItems = localItems.filter((item) => {
        const key = `${item.circle}|${item.eventDate}|${item.block}|${item.number}`;
        return !existingKeys.has(key);
      });

      if (newItems.length > 0) {
        await roomService.bulkInsertRoomItems(supabase, activeRoom.id, newItems);
      }

      return {
        added: newItems.length,
        skipped: localItems.length - newItems.length,
        total: localItems.length,
      };
    },
    [activeRoom],
  );

  const downloadRoomItems = useCallback(async (): Promise<ShoppingItem[]> => {
    if (!supabase || !activeRoom) throw new Error('ルームが未接続です');
    return roomService.getRoomItemsAsShoppingItems(supabase, activeRoom.id);
  }, [activeRoom]);

  const uploadMapDataToRoom = useCallback(
    async (
      eventName: string,
      mapData?: Record<string, DayMapData>,
      hallDefinitions?: Record<string, HallDefinition[]>,
      userId?: string,
    ) => {
      if (!supabase || !activeRoom) throw new Error('ルームが未接続です');
      await mapSyncService.uploadMapData(
        supabase,
        activeRoom.id,
        eventName,
        mapData,
        hallDefinitions,
        userId ?? '',
      );
    },
    [activeRoom],
  );

  const downloadMapDataFromRoom = useCallback(async () => {
    if (!supabase || !activeRoom) throw new Error('ルームが未接続です');
    return mapSyncService.downloadMapData(supabase, activeRoom.id);
  }, [activeRoom]);

  return { uploadItemsToRoom, mergeGuestItems, downloadRoomItems, uploadMapDataToRoom, downloadMapDataFromRoom };
}
