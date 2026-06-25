import type { ShoppingItem } from '../../types/item';

const hasRouteMembership = (item: ShoppingItem): boolean =>
  item.orderIndex !== undefined && item.orderIndex !== null;

export const isRouteAffectingItemPlacementChange = (
  currentItem: ShoppingItem,
  updatedItem: ShoppingItem,
): boolean => {
  const routeMembershipChanged =
    (currentItem.orderIndex ?? null) !== (updatedItem.orderIndex ?? null);
  if (routeMembershipChanged) return true;

  const eventDateChanged = currentItem.eventDate !== updatedItem.eventDate;
  return eventDateChanged && (hasRouteMembership(currentItem) || hasRouteMembership(updatedItem));
};
