import type {
  ShoppingItem,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  HallRouteSettings,
  MapDataStore,
  DayMapData,
} from '../types';
import { getMaplessKey } from '../types';
import { getHallIdForItem } from './hallGrouping';

/**
 * map タブのホール定義 + mapless ホール定義を統合した HallRouteSettings を構築する。
 *
 * - hallOrder は map 側 → mapless 側の順にマージ
 * - 実行列の優先度付きアイテム / ホール未定義アイテムから動的に
 *   `'undefined' / 'undefined:priority' / 'undefined:highest' / '<hallId>:priority' / '<hallId>:highest'`
 *   を計算し、未登録のものをベース hallId 直後 (または末尾) に注入する
 *
 * App.tsx の `globalHallOrderRouteSettings` と FocusModeContainer の `focusHallOrder`
 * 両方から使う共通実装。両者の非対称によるソート順ズレを防ぐため一本化している。
 */
export function buildMergedHallRouteSettings(params: {
  eventName: string | null;
  dayName: string | null;
  mapTabName: string | null;
  hallDefinitionsStore: HallDefinitionsStore;
  hallRouteSettingsStore: HallRouteSettingsStore;
  executeIds: string[];
  items: ShoppingItem[];
  mapDataStore: MapDataStore;
}): { mergedHalls: HallDefinition[]; mergedSettings: HallRouteSettings; dayMapData: DayMapData | null } {
  const {
    eventName,
    dayName,
    mapTabName,
    hallDefinitionsStore,
    hallRouteSettingsStore,
    executeIds,
    items,
    mapDataStore,
  } = params;

  if (!eventName) {
    return {
      mergedHalls: [],
      mergedSettings: { hallOrder: [], hallVisitLists: [] },
      dayMapData: null,
    };
  }

  const hasMap = !!mapTabName;
  const mapHalls = hasMap ? hallDefinitionsStore[eventName]?.[mapTabName!] || [] : [];
  const maplessKey = dayName ? getMaplessKey(dayName) : null;
  const maplessHalls = maplessKey ? hallDefinitionsStore[eventName]?.[maplessKey] || [] : [];
  const mergedHalls = [...mapHalls, ...maplessHalls];

  const dayMapData = hasMap ? mapDataStore[eventName]?.[mapTabName!] || null : null;

  const mapSettings = hasMap ? hallRouteSettingsStore[eventName]?.[mapTabName!] : undefined;
  const maplessSettings = maplessKey ? hallRouteSettingsStore[eventName]?.[maplessKey] : undefined;

  const mapOrder =
    mapSettings?.hallOrder && mapSettings.hallOrder.length > 0
      ? mapSettings.hallOrder
      : mapHalls.map((h) => h.id);
  const maplessOrder =
    maplessSettings?.hallOrder && maplessSettings.hallOrder.length > 0
      ? maplessSettings.hallOrder
      : maplessHalls.map((h) => h.id);

  const mergedOrder = [...mapOrder, ...maplessOrder];

  // ===== 動的注入: ストアに無い優先度グループをアイテムから計算して補完 =====
  if (executeIds.length > 0) {
    const itemsMap = new Map(items.map((i) => [i.id, i]));
    const neededGroups = new Map<string, 'none' | 'priority' | 'highest'>();
    executeIds.forEach((itemId) => {
      const item = itemsMap.get(itemId);
      if (!item) return;
      const priority = (item.priorityLevel || 'none') as 'none' | 'priority' | 'highest';
      const hallId = getHallIdForItem(item, dayMapData, mergedHalls);
      // ホール定義済み + 通常優先度は既存のホールID順序に従うため注入不要
      if (hallId !== null && priority === 'none') return;
      let groupId: string;
      if (hallId === null) {
        groupId =
          priority === 'highest' ? 'undefined:highest'
            : priority === 'priority' ? 'undefined:priority'
            : 'undefined';
      } else {
        groupId = `${hallId}:${priority}`;
      }
      if (!neededGroups.has(groupId)) {
        neededGroups.set(groupId, priority);
      }
    });

    neededGroups.forEach((_priority, groupId) => {
      if (mergedOrder.includes(groupId)) return;
      const baseHallId = groupId.replace(/:(highest|priority)$/, '');
      const baseIndex = mergedOrder.indexOf(baseHallId);
      if (baseIndex >= 0) {
        // highest → priority → base の順になるよう、highest は baseIndex 直後、
        // priority はその後ろに挿入
        const insertAt = groupId.endsWith(':highest')
          ? baseIndex + 1
          : baseIndex + 1 + (mergedOrder.includes(`${baseHallId}:highest`) ? 1 : 0);
        mergedOrder.splice(insertAt, 0, groupId);
      } else {
        // ベース hallId が見つからない（'undefined' 系等）場合は末尾に追加
        mergedOrder.push(groupId);
      }
    });
  }

  return {
    mergedHalls,
    mergedSettings: {
      hallOrder: mergedOrder,
      hallVisitLists: [
        ...(mapSettings?.hallVisitLists || []),
        ...(maplessSettings?.hallVisitLists || []),
      ],
    },
    dayMapData,
  };
}
