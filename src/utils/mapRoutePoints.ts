import type { ShoppingItem } from "../types/item";
import type { DayMapData, HallDefinition } from "../types/map";
import {
  getMapRouteGroupParts,
  isManualHallCompatibleForMapRoute,
  resolveItemGroupIdForMapRoute,
  resolveMapRouteCellCandidatesForItem,
} from "./hallGrouping";
import { normalizeMapRouteDayText } from "./mapRouteOrder";

export type MapRoutePriorityLevel = "none" | "priority" | "highest";

export interface MapRoutePoint {
  itemId: string;
  row: number;
  col: number;
  order: number;
  priorityLevel: MapRoutePriorityLevel;
  groupKey: string | null;
  hallId: string | null;
  anchorLabel: string;
}

export interface ResolveMapRoutePointsParams {
  itemIds: string[];
  items: ShoppingItem[];
  mapData: DayMapData;
  hallDefinitions: HallDefinition[];
  dayName: string;
  selectedHallId?: string;
  orderOffset?: number;
  requireCellInMap?: boolean;
  respectManualHallMismatch?: boolean;
}

export interface ResolveMapRoutePointsResult {
  routePoints: MapRoutePoint[];
  missingItemIds: string[];
}

export function resolveMapRoutePoints(
  params: ResolveMapRoutePointsParams,
): ResolveMapRoutePointsResult {
  const normalizedDayName = normalizeMapRouteDayText(params.dayName);
  const itemsById = new Map(params.items.map((item) => [item.id, item]));
  const routePoints: MapRoutePoint[] = [];
  const missingItemIds: string[] = [];
  const orderOffset = params.orderOffset ?? 0;
  const selectedHallId = params.selectedHallId ?? "all";

  params.itemIds.forEach((itemId, index) => {
    const item = itemsById.get(itemId);
    if (
      !item ||
      normalizeMapRouteDayText(item.eventDate) !== normalizedDayName
    ) {
      missingItemIds.push(itemId);
      return;
    }

    if (
      params.respectManualHallMismatch === true &&
      selectedHallId !== "all" &&
      !isManualHallCompatibleForMapRoute({
        item,
        hallDefinitions: params.hallDefinitions,
        selectedHallId,
      })
    ) {
      missingItemIds.push(itemId);
      return;
    }

    const resolvedCandidates = resolveMapRouteCellCandidatesForItem({
      mapData: params.mapData,
      item,
      requireCellInMap: params.requireCellInMap === true,
    });
    const resolved = resolvedCandidates[0] ?? null;
    if (!resolved) {
      missingItemIds.push(itemId);
      return;
    }

    const groupKey = resolveItemGroupIdForMapRoute({
      item,
      dayMapData: params.mapData,
      hallDefinitions: params.hallDefinitions,
      selectedHallId,
      resolvedRouteCell: resolved,
      resolvedRouteCellCandidates: resolvedCandidates,
    });
    const { hallId } = getMapRouteGroupParts(groupKey);
    const order = orderOffset + index;
    routePoints.push({
      itemId,
      row: resolved.cell.row,
      col: resolved.cell.col,
      order,
      priorityLevel: (item.priorityLevel || "none") as MapRoutePriorityLevel,
      groupKey,
      hallId,
      anchorLabel: `${order + 1}. ${item.circle || itemId} / ${item.block}-${item.number} の後`,
    });
  });

  return { routePoints, missingItemIds };
}
