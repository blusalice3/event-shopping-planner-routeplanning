import type { ShoppingItem, HallDefinition, DayMapData } from '../../../types';
import { findItemHallId } from '../../events/itemOps';
import { getSpaceKey } from '../../../utils/spaceGrouping';

/**
 * アイテムのスペースキーから所属ホールIDへのマッピングを返す。
 * hallId → spaceKey[] のMapを返す。
 */
export function getHallSpaceKeys(
  items: ShoppingItem[],
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  if (!mapData || halls.length === 0) return result;

  // 各ホールに空Setを初期化
  for (const hall of halls) {
    result.set(hall.id, new Set());
  }

  // 未購入アイテムのみ対象
  const targetItems = items.filter(
    (item) => item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone',
  );

  for (const item of targetItems) {
    const hallId = findItemHallId(item, halls, mapData);
    if (hallId) {
      const spaceKey = getSpaceKey(item.block, item.number);
      const set = result.get(hallId);
      if (set) {
        set.add(spaceKey);
      }
    }
  }

  return result;
}

/**
 * ホール別一括割り当て。
 * 各ホールを指定されたメンバーに一括割り当て。
 */
export function computeHallBasedAssignment(
  items: ShoppingItem[],
  hallAssignments: { hallId: string; userId: string }[],
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
): Map<string, string[]> {
  // userId → itemIds[]
  const result = new Map<string, string[]>();

  const unassignedItems = items.filter(
    (item) => item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone',
  );

  for (const item of unassignedItems) {
    const hallId = findItemHallId(item, halls, mapData);
    if (!hallId) continue;

    const assignment = hallAssignments.find((a) => a.hallId === hallId);
    if (!assignment) continue;

    const existing = result.get(assignment.userId) ?? [];
    existing.push(item.id);
    result.set(assignment.userId, existing);
  }

  return result;
}
