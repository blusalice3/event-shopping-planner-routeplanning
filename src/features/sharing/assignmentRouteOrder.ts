import type { AssignmentMemberProfile, ShoppingItem } from '../../types/item';

export const UNASSIGNED_ROUTE_GROUP_ID = '__unassigned__';

export type AssignmentRouteGroup = {
  groupId: string;
  memberId: string | null;
  displayName: string;
  color: string | null;
  itemIds: string[];
};

export const getItemAssignmentGroupId = (item: ShoppingItem | undefined): string =>
  item?.assignedTo ?? UNASSIGNED_ROUTE_GROUP_ID;

const areStringArraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const getAssignmentGroupDisplay = (
  groupId: string,
  membersById: Map<string, AssignmentMemberProfile>,
): { memberId: string | null; displayName: string; color: string | null } => {
  if (groupId === UNASSIGNED_ROUTE_GROUP_ID) {
    return {
      memberId: null,
      displayName: '未担当',
      color: null,
    };
  }

  const member = membersById.get(groupId);
  return {
    memberId: groupId,
    displayName: member
      ? member.membershipStatus === 'left'
        ? `旧: ${member.displayName}`
        : member.displayName
      : '未解決メンバー',
    color: member?.color ?? null,
  };
};

export const buildAssignmentRouteGroups = (
  routeItemIds: string[],
  items: ShoppingItem[],
  members: AssignmentMemberProfile[],
): AssignmentRouteGroup[] => {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const membersById = new Map(members.map((member) => [member.roomMemberId, member]));
  const groupItemIdsById = new Map<string, string[]>();
  const groupOrder: string[] = [];

  for (const itemId of routeItemIds) {
    const groupId = getItemAssignmentGroupId(itemsById.get(itemId));
    if (!groupItemIdsById.has(groupId)) {
      groupItemIdsById.set(groupId, []);
      groupOrder.push(groupId);
    }
    groupItemIdsById.get(groupId)!.push(itemId);
  }

  return groupOrder.map((groupId) => {
    const display = getAssignmentGroupDisplay(groupId, membersById);
    return {
      groupId,
      ...display,
      itemIds: groupItemIdsById.get(groupId) ?? [],
    };
  });
};

export const reorderExecuteIdsByAssignmentRouteOrder = (
  routeItemIds: string[],
  items: ShoppingItem[],
  routeGroupOrder: string[],
): string[] => {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const itemIdsByGroupId = new Map<string, string[]>();
  const fallbackGroupOrder: string[] = [];

  for (const itemId of routeItemIds) {
    const groupId = getItemAssignmentGroupId(itemsById.get(itemId));
    if (!itemIdsByGroupId.has(groupId)) {
      itemIdsByGroupId.set(groupId, []);
      fallbackGroupOrder.push(groupId);
    }
    itemIdsByGroupId.get(groupId)!.push(itemId);
  }

  const orderedGroupIds = Array.from(new Set([...routeGroupOrder, ...fallbackGroupOrder]));
  const reorderedItemIds: string[] = [];

  for (const groupId of orderedGroupIds) {
    const groupItemIds = itemIdsByGroupId.get(groupId);
    if (!groupItemIds) continue;
    reorderedItemIds.push(...groupItemIds);
    itemIdsByGroupId.delete(groupId);
  }

  itemIdsByGroupId.forEach((groupItemIds) => {
    reorderedItemIds.push(...groupItemIds);
  });

  return reorderedItemIds;
};

export const buildAssignmentRouteGroupOrder = (
  routeItemIds: string[],
  items: ShoppingItem[],
): string[] => buildAssignmentRouteGroups(routeItemIds, items, []).map((group) => group.groupId);

export const normalizeExecuteIdsByAssignmentRouteLock = (
  currentRouteItemIds: string[],
  nextRouteItemIds: string[],
  items: ShoppingItem[],
): string[] => {
  const currentGroupOrder = buildAssignmentRouteGroupOrder(currentRouteItemIds, items);
  return reorderExecuteIdsByAssignmentRouteOrder(nextRouteItemIds, items, currentGroupOrder);
};

export const keepsAssignmentRouteLock = (
  currentRouteItemIds: string[],
  nextRouteItemIds: string[],
  items: ShoppingItem[],
): boolean =>
  areStringArraysEqual(
    nextRouteItemIds,
    normalizeExecuteIdsByAssignmentRouteLock(currentRouteItemIds, nextRouteItemIds, items),
  );
