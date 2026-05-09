import type { ShoppingItem } from '../types/item';
import type { DayMapData, HallDefinition } from '../types/map';
import { sortItemsByHallOrder } from './hallGrouping';

export const normalizeMapRouteDayText = (value: string | null | undefined): string =>
  (value || '').replace(/\u3000/g, ' ').trim();

export const resolveMapRouteHallOrder = (
  routeHallOrder: string[] | undefined,
  fallbackHallOrder: string[],
): string[] => (routeHallOrder && routeHallOrder.length > 0 ? routeHallOrder : fallbackHallOrder);

export function buildMapRouteExecuteItemIds(params: {
  executeModeItemIds: string[];
  items: ShoppingItem[];
  mapData: DayMapData | null;
  hallDefinitions: HallDefinition[];
  hallOrder: string[];
  dayName: string;
}): string[] {
  const normalizedDayName = normalizeMapRouteDayText(params.dayName);
  const itemsById = new Map(params.items.map((item) => [item.id, item]));

  const visitItems = params.executeModeItemIds
    .map((id) => itemsById.get(id))
    .filter(
      (item): item is ShoppingItem =>
        item !== undefined &&
        normalizeMapRouteDayText(item.eventDate) === normalizedDayName,
    );

  return sortItemsByHallOrder(
    visitItems,
    params.mapData,
    params.hallDefinitions,
    params.hallOrder,
  ).map((item) => item.id);
}

export function filterFirstRouteMarkers<T extends { row: number; col: number }>(
  routePoints: T[],
): T[] {
  const seenCells = new Set<string>();

  return routePoints.filter((point) => {
    const key = `${point.row}-${point.col}`;
    if (seenCells.has(key)) return false;
    seenCells.add(key);
    return true;
  });
}
