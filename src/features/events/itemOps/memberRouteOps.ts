import type { MemberRouteItems, ShoppingItem } from '../../../types/item';

export type CanonicalMemberRouteOrder = {
  eventDate: string;
  roomMemberId: string;
  itemIds: string[];
};

export type MemberRouteMutationResult = {
  items: ShoppingItem[];
  memberRouteItems: MemberRouteItems;
};

const unique = (itemIds: string[]): string[] => Array.from(new Set(itemIds));

const getItemsById = (items: ShoppingItem[]): Map<string, ShoppingItem> =>
  new Map(items.map((item) => [item.id, item]));

export const removeDeletedIdsFromMemberRouteItems = (
  memberRouteItems: MemberRouteItems,
  deletedIds: Set<string>,
): MemberRouteItems => {
  if (deletedIds.size === 0) return memberRouteItems;

  let changed = false;
  const nextEntries = Object.entries(memberRouteItems).map(([eventDate, routesByMember]) => {
    let dateChanged = false;
    const nextRoutesByMember = Object.fromEntries(
      Object.entries(routesByMember).map(([roomMemberId, routeItemIds]) => {
        const nextItemIds = routeItemIds.filter((itemId) => !deletedIds.has(itemId));
        if (nextItemIds.length !== routeItemIds.length) {
          changed = true;
          dateChanged = true;
        }
        return [roomMemberId, dateChanged ? nextItemIds : routeItemIds];
      }),
    );

    return [eventDate, dateChanged ? nextRoutesByMember : routesByMember];
  });

  return changed ? Object.fromEntries(nextEntries) : memberRouteItems;
};

const removeItemIdsFromAllMemberRoutes = (
  memberRouteItems: MemberRouteItems,
  itemIds: Set<string>,
): MemberRouteItems => removeDeletedIdsFromMemberRouteItems(memberRouteItems, itemIds);

const upsertMemberRoute = (
  memberRouteItems: MemberRouteItems,
  eventDate: string,
  roomMemberId: string,
  itemIdsToAppend: string[],
): MemberRouteItems => {
  if (itemIdsToAppend.length === 0) return memberRouteItems;

  const currentDateRoutes = memberRouteItems[eventDate] ?? {};
  const currentRoute = currentDateRoutes[roomMemberId] ?? [];
  const appendIds = unique(itemIdsToAppend);
  const appendIdSet = new Set(appendIds);
  const nextRoute = [...currentRoute.filter((itemId) => !appendIdSet.has(itemId)), ...appendIds];

  return {
    ...memberRouteItems,
    [eventDate]: {
      ...currentDateRoutes,
      [roomMemberId]: nextRoute,
    },
  };
};

const assignItems = (
  items: ShoppingItem[],
  targetIds: Set<string>,
  assignedTo: string | undefined,
): ShoppingItem[] =>
  items.map((item) => {
    if (!targetIds.has(item.id)) return item;
    if (item.assignedTo === assignedTo) return item;
    return {
      ...item,
      assignedTo,
    };
  });

export const addToMemberRouteAndAssign = ({
  items,
  memberRouteItems,
  itemIds,
  eventDate,
  roomMemberId,
}: {
  items: ShoppingItem[];
  memberRouteItems: MemberRouteItems;
  itemIds: string[];
  eventDate: string;
  roomMemberId: string;
}): MemberRouteMutationResult => {
  const itemsById = getItemsById(items);
  const eligibleItemIds = unique(itemIds).filter(
    (itemId) => itemsById.get(itemId)?.eventDate === eventDate,
  );
  const targetIds = new Set(eligibleItemIds);
  const withoutExistingRoutes = removeItemIdsFromAllMemberRoutes(memberRouteItems, targetIds);

  return {
    items: assignItems(items, targetIds, roomMemberId),
    memberRouteItems: upsertMemberRoute(
      withoutExistingRoutes,
      eventDate,
      roomMemberId,
      eligibleItemIds,
    ),
  };
};

export const removeFromAllMemberRoutesAndUnassign = ({
  items,
  memberRouteItems,
  itemIds,
}: {
  items: ShoppingItem[];
  memberRouteItems: MemberRouteItems;
  itemIds: string[];
}): MemberRouteMutationResult => {
  const targetIds = new Set(unique(itemIds));

  return {
    items: assignItems(items, targetIds, undefined),
    memberRouteItems: removeItemIdsFromAllMemberRoutes(memberRouteItems, targetIds),
  };
};

export const delegateMemberRouteItem = ({
  items,
  memberRouteItems,
  itemIds,
  roomMemberId,
}: {
  items: ShoppingItem[];
  memberRouteItems: MemberRouteItems;
  itemIds: string[];
  roomMemberId: string;
}): MemberRouteMutationResult => {
  const itemsById = getItemsById(items);
  const targetIds = new Set(unique(itemIds).filter((itemId) => itemsById.has(itemId)));
  const withoutExistingRoutes = removeItemIdsFromAllMemberRoutes(memberRouteItems, targetIds);
  const nextMemberRouteItems = Array.from(targetIds).reduce((nextRoutes, itemId) => {
    const item = itemsById.get(itemId);
    if (!item) return nextRoutes;
    return upsertMemberRoute(nextRoutes, item.eventDate, roomMemberId, [itemId]);
  }, withoutExistingRoutes);

  return {
    items: assignItems(items, targetIds, roomMemberId),
    memberRouteItems: nextMemberRouteItems,
  };
};

export const bulkAssignOnly = ({
  items,
  itemIds,
  roomMemberId,
}: {
  items: ShoppingItem[];
  itemIds: string[];
  roomMemberId: string | undefined;
}): ShoppingItem[] => assignItems(items, new Set(unique(itemIds)), roomMemberId);

export const applyCanonicalMemberRouteOrders = (
  memberRouteItems: MemberRouteItems,
  routeOrders: CanonicalMemberRouteOrder[],
): MemberRouteItems => {
  if (routeOrders.length === 0) return memberRouteItems;

  return routeOrders.reduce<MemberRouteItems>((nextRoutes, routeOrder) => {
    const currentDateRoutes = nextRoutes[routeOrder.eventDate] ?? {};
    return {
      ...nextRoutes,
      [routeOrder.eventDate]: {
        ...currentDateRoutes,
        [routeOrder.roomMemberId]: unique(routeOrder.itemIds),
      },
    };
  }, memberRouteItems);
};
