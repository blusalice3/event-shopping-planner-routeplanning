import { areMapRouteGroupKeysCompatible } from './hallGrouping';
import type { MapRoutePoint } from './mapRoutePoints';

export interface ValidateMapSmartInsertParams {
  anchorItemId: string;
  pendingItemIds: string[];
  routePoints: MapRoutePoint[];
}

export type MapSmartInsertValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'anchor-not-found' | 'pending-not-found' | 'group-mismatch';
      message: string;
    };

export function validateMapSmartInsert(
  params: ValidateMapSmartInsertParams,
): MapSmartInsertValidationResult {
  const pointByItemId = new Map(params.routePoints.map((point) => [point.itemId, point]));
  const anchorPoint = pointByItemId.get(params.anchorItemId);
  if (!anchorPoint) {
    return {
      ok: false,
      reason: 'anchor-not-found',
      message:
        '選択した基準アイテムがルート上にありません。別のルート線または番号を選んでください。',
    };
  }

  const pendingGroupKeys: Array<string | null> = [];
  for (const itemId of params.pendingItemIds) {
    const point = pointByItemId.get(itemId);
    if (!point) {
      return {
        ok: false,
        reason: 'pending-not-found',
        message:
          '追加対象が現在表示中のマップ上にありません。別の追加方法を選んでください。',
      };
    }
    pendingGroupKeys.push(point.groupKey);
  }

  if (!areMapRouteGroupKeysCompatible(anchorPoint.groupKey, pendingGroupKeys)) {
    return {
      ok: false,
      reason: 'group-mismatch',
      message:
        '選択した位置は追加対象とホールまたは優先度が異なります。別のルート線または番号を選んでください。',
    };
  }

  return { ok: true };
}
