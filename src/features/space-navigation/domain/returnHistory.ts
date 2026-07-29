import type {
  NavigatorReturnHistory,
  NavigatorReturnPoint,
  PopReturnHistoryResult,
} from "../types";

export function createReturnHistory<
  TPoint extends NavigatorReturnPoint = NavigatorReturnPoint,
>(): NavigatorReturnHistory<TPoint> {
  return [];
}

export function pushReturnHistory<TPoint extends NavigatorReturnPoint>(
  history: NavigatorReturnHistory<TPoint>,
  point: TPoint,
): NavigatorReturnHistory<TPoint> {
  return [...history, point];
}

export function peekReturnHistory<TPoint extends NavigatorReturnPoint>(
  history: NavigatorReturnHistory<TPoint>,
): TPoint | null {
  return history.length > 0 ? history[history.length - 1] : null;
}

export function popReturnHistory<TPoint extends NavigatorReturnPoint>(
  history: NavigatorReturnHistory<TPoint>,
): PopReturnHistoryResult<TPoint> {
  if (history.length === 0) {
    return { point: null, history: [] };
  }
  return {
    point: history[history.length - 1],
    history: history.slice(0, -1),
  };
}

export function clearReturnHistory<
  TPoint extends NavigatorReturnPoint = NavigatorReturnPoint,
>(_history?: NavigatorReturnHistory<TPoint>): NavigatorReturnHistory<TPoint> {
  return [];
}
