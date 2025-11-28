import { RoutePlanningData, RoutePoint } from '../types';

const STORAGE_KEY = 'routePlanningData';

// ルートプランニングデータの保存
export function saveRoutePlanningData(data: RoutePlanningData): void {
  try {
    const allData = loadAllRoutePlanningData();
    allData[data.eventName] = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allData));
  } catch (error) {
    console.error('Failed to save route planning data', error);
    throw error;
  }
}

// ルートプランニングデータの読み込み
export function loadRoutePlanningData(eventName: string): RoutePlanningData | null {
  try {
    const allData = loadAllRoutePlanningData();
    return allData[eventName] || null;
  } catch (error) {
    console.error('Failed to load route planning data', error);
    return null;
  }
}

// 全てのルートプランニングデータの読み込み
function loadAllRoutePlanningData(): Record<string, RoutePlanningData> {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error('Failed to load all route planning data', error);
    return {};
  }
}

// ルートポイントの追加
export function addRoutePoint(
  eventName: string,
  eventDate: string,
  routePoint: RoutePoint
): void {
  const data = loadRoutePlanningData(eventName) || {
    eventName,
    routes: {},
  };
  
  if (!data.routes[eventDate]) {
    data.routes[eventDate] = [];
  }
  
  // 既存のポイントを削除（同じIDの場合）
  data.routes[eventDate] = data.routes[eventDate].filter((p: RoutePoint) => p.id !== routePoint.id);
  
  // 新しいポイントを追加
  data.routes[eventDate].push(routePoint);
  
  // 順序でソート
  data.routes[eventDate].sort((a: RoutePoint, b: RoutePoint) => a.order - b.order);
  
  saveRoutePlanningData(data);
}

// ルートポイントの削除
export function removeRoutePoint(
  eventName: string,
  eventDate: string,
  routePointId: string
): void {
  const data = loadRoutePlanningData(eventName);
  if (!data || !data.routes[eventDate]) {
    return;
  }
  
  data.routes[eventDate] = data.routes[eventDate].filter((p: RoutePoint) => p.id !== routePointId);
  
  // 順序を再割り当て
  data.routes[eventDate].forEach((point: RoutePoint, index: number) => {
    point.order = index;
  });
  
  saveRoutePlanningData(data);
}

// ルートポイントの順序変更
export function reorderRoutePoints(
  eventName: string,
  eventDate: string,
  routePointIds: string[]
): void {
  const data = loadRoutePlanningData(eventName);
  if (!data || !data.routes[eventDate]) {
    return;
  }
  
  const pointMap = new Map<string, RoutePoint>(data.routes[eventDate].map((p: RoutePoint) => [p.id, p]));
  const reorderedPoints: RoutePoint[] = [];
  
  routePointIds.forEach((id: string, index: number) => {
    const point: RoutePoint | undefined = pointMap.get(id);
    if (point) {
      point.order = index;
      reorderedPoints.push(point);
    }
  });
  
  data.routes[eventDate] = reorderedPoints;
  saveRoutePlanningData(data);
}

// ルートポイントの更新
export function updateRoutePoint(
  eventName: string,
  eventDate: string,
  routePoint: RoutePoint
): void {
  const data = loadRoutePlanningData(eventName);
  if (!data || !data.routes[eventDate]) {
    return;
  }
  
  const index = data.routes[eventDate].findIndex((p: RoutePoint) => p.id === routePoint.id);
  if (index !== -1) {
    data.routes[eventDate][index] = routePoint;
    saveRoutePlanningData(data);
  }
}

// 参加日ごとのルートポイントリストの取得
export function getRoutePoints(
  eventName: string,
  eventDate: string
): RoutePoint[] {
  const data = loadRoutePlanningData(eventName);
  if (!data || !data.routes[eventDate]) {
    return [];
  }
  
  return [...data.routes[eventDate]].sort((a: RoutePoint, b: RoutePoint) => a.order - b.order);
}

