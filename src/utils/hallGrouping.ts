import type { ShoppingItem } from '../types/item';
import type { HallDefinition, DayMapData, BlockDefinition } from '../types/map';
import { resolveManualHallId, resolveHallByBlockName, normalizeBlockName } from './hallFallback';
import { findRouteLookupNumberCell } from './mapRoutingSignature';
import { extractNumberFromItemNumber } from './xlsxMapParser';
import { isPointInPolygonInclusive } from './mapRoutePolygon';

export type PriorityLevel = 'none' | 'priority' | 'highest';

/**
 * グループIDからホールIDと優先度を分離する。
 * - null → ホール未定義・優先度なし
 * - 'undefined:highest' / 'undefined:priority' → ホール未定義 + 優先度
 * - '<hallId>:highest' / '<hallId>:priority' → ホール + 優先度
 * - '<hallId>' → ホールのみ（優先度なし）
 */
export function parseGroupId(
  groupId: string | null,
): { hallId: string | null; priority: PriorityLevel } {
  if (groupId === null) return { hallId: null, priority: 'none' };
  if (groupId === 'undefined:highest') return { hallId: null, priority: 'highest' };
  if (groupId === 'undefined:priority') return { hallId: null, priority: 'priority' };
  if (groupId.endsWith(':highest')) {
    return { hallId: groupId.replace(':highest', ''), priority: 'highest' };
  }
  if (groupId.endsWith(':priority')) {
    return { hallId: groupId.replace(':priority', ''), priority: 'priority' };
  }
  return { hallId: groupId, priority: 'none' };
}

/**
 * ホールIDと優先度からグループIDを生成する（parseGroupIdの逆変換）。
 */
export function buildGroupId(
  hallId: string | null,
  priority: PriorityLevel | string,
): string | null {
  if (hallId === null) {
    if (priority === 'highest') return 'undefined:highest';
    if (priority === 'priority') return 'undefined:priority';
    return null;
  }
  if (priority === 'highest') return `${hallId}:highest`;
  if (priority === 'priority') return `${hallId}:priority`;
  return hallId;
}

export function buildItemRoutingSignature(items: ShoppingItem[], itemIds: string[]): string {
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return JSON.stringify(
    itemIds.map((itemId) => {
      const item = itemsById.get(itemId);
      if (!item) return ['missing', itemId];

      return [
        'item',
        item.id,
        item.eventDate ?? '',
        item.block ?? '',
        item.number ?? '',
        item.priorityLevel || 'none',
        item.manualHallId || '',
      ];
    }),
  );
}

/**
 * アイテムが属するホールIDを解決する。
 * 解決順序:
 *   1. 手動ホール設定 (`item.manualHallId`) が有効なら最優先
 *   2. numberセル位置によるポリゴン判定（頂点一致 → 多角形内判定）
 *   3. blockNames フォールバック
 */
export function getHallIdForItem(
  item: ShoppingItem,
  dayMapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
): string | null {
  // 1. 手動ホール設定
  const manual = resolveManualHallId(item.manualHallId, hallDefinitions);
  if (manual) return manual;

  // 2. numberセル位置によるポリゴン判定
  if (dayMapData) {
    const block = dayMapData.blocks.find((b: BlockDefinition) => b.name === item.block);
    if (block) {
      const numMatch = item.number?.match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0], 10);
        const cell = findRouteLookupNumberCell(block, num);
        if (cell) {
          const isPointInPoly = (
            row: number,
            col: number,
            vertices: { row: number; col: number }[],
          ): boolean => {
            if (vertices.length < 3) return false;
            let inside = false;
            for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
              const xi = vertices[i].col,
                yi = vertices[i].row;
              const xj = vertices[j].col,
                yj = vertices[j].row;
              if (yi > row !== yj > row && col < ((xj - xi) * (row - yi)) / (yj - yi) + xi) {
                inside = !inside;
              }
            }
            return inside;
          };

          for (const hall of hallDefinitions) {
            for (const vertex of hall.vertices) {
              if (vertex.row === cell.row && vertex.col === cell.col) {
                return hall.id;
              }
            }
            if (isPointInPoly(cell.row, cell.col, hall.vertices)) {
              return hall.id;
            }
          }
        }
      }
    }
  }

  // 3. blockNames フォールバック
  return resolveHallByBlockName(item.block, hallDefinitions);
}

/**
 * アイテムのグループID（ホールID + 優先度）を取得する。
 */
export function getItemGroupId(
  item: ShoppingItem,
  dayMapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
): string | null {
  const hallId = getHallIdForItem(item, dayMapData, hallDefinitions);
  const priority = (item.priorityLevel || 'none') as PriorityLevel;
  return buildGroupId(hallId, priority);
}

export interface ResolvedMapRouteCell {
  block: BlockDefinition;
  cell: { row: number; col: number };
  numberValue: number;
}

export interface ResolveMapRouteCellForItemParams {
  mapData: DayMapData;
  item: ShoppingItem;
  requireCellInMap?: boolean;
}

export function isRouteCellResolvableOnMap(
  mapData: DayMapData,
  cell: { row: number; col: number },
): boolean {
  if (mapData.cells.some((candidate) => candidate.row === cell.row && candidate.col === cell.col)) {
    return true;
  }
  return mapData.blocks.some((block) =>
    block.numberCells.some((numberCell) => numberCell.row === cell.row && numberCell.col === cell.col),
  );
}

export function resolveMapRouteBlockCandidates(
  mapData: DayMapData,
  itemBlockName: string | null | undefined,
): BlockDefinition[] {
  const blockName = normalizeBlockName(itemBlockName || '');
  if (!blockName) return [];

  const exactMatches = mapData.blocks.filter((block) => normalizeBlockName(block.name) === blockName);
  if (exactMatches.length > 0) return exactMatches;

  const loweredBlockName = blockName.toLowerCase();
  const caseInsensitiveMatches = mapData.blocks.filter(
    (block) => normalizeBlockName(block.name).toLowerCase() === loweredBlockName,
  );
  return caseInsensitiveMatches.length === 1 ? caseInsensitiveMatches : [];
}

export function resolveMapRouteCellCandidatesForItem({
  mapData,
  item,
  requireCellInMap = false,
}: ResolveMapRouteCellForItemParams): ResolvedMapRouteCell[] {
  const numStr = extractNumberFromItemNumber(item.number);
  if (!numStr) return [];

  const numberValue = parseInt(numStr, 10);
  const candidates: ResolvedMapRouteCell[] = [];
  for (const block of resolveMapRouteBlockCandidates(mapData, item.block)) {
    const cell = findRouteLookupNumberCell(block, numberValue);
    if (!cell) continue;
    if (requireCellInMap && !isRouteCellResolvableOnMap(mapData, cell)) continue;
    candidates.push({ block, cell, numberValue });
  }
  return candidates;
}

export function resolveMapRouteCellForItem(
  params: ResolveMapRouteCellForItemParams,
): ResolvedMapRouteCell | null {
  return resolveMapRouteCellCandidatesForItem(params)[0] ?? null;
}

export function isManualHallCompatibleForMapRoute(params: {
  item: ShoppingItem;
  hallDefinitions: HallDefinition[];
  selectedHallId?: string;
}): boolean {
  const { item, hallDefinitions, selectedHallId = 'all' } = params;
  if (selectedHallId === 'all') return true;
  if (hallDefinitions.length === 0) return true;
  const manual = resolveManualHallId(item.manualHallId, hallDefinitions);
  return manual === null || manual === selectedHallId;
}

export interface GetHallCandidatesForMapRouteParams {
  item: ShoppingItem;
  dayMapData: DayMapData | null;
  hallDefinitions: HallDefinition[];
  resolvedRouteCell?: ResolvedMapRouteCell | null;
  resolvedRouteCellCandidates?: ResolvedMapRouteCell[];
}

function collectHallCandidatesForResolvedRouteCell(
  polygonCandidates: Set<string>,
  blockNameCandidates: Set<string>,
  resolved: ResolvedMapRouteCell,
  hallDefinitions: HallDefinition[],
): void {
  const normalizedResolvedBlockName = normalizeBlockName(resolved.block.name);
  for (const hall of hallDefinitions) {
    if (isPointInPolygonInclusive(resolved.cell.row, resolved.cell.col, hall.vertices)) {
      polygonCandidates.add(hall.id);
    }
    if (
      hall.blockNames?.some(
        (blockName) => normalizeBlockName(blockName) === normalizedResolvedBlockName,
      )
    ) {
      blockNameCandidates.add(hall.id);
    }
  }
}

export function getHallCandidatesForMapRoute({
  item,
  dayMapData,
  hallDefinitions,
  resolvedRouteCell,
  resolvedRouteCellCandidates,
}: GetHallCandidatesForMapRouteParams): string[] {
  const manual = resolveManualHallId(item.manualHallId, hallDefinitions);
  if (manual) return [manual];

  if (!dayMapData) {
    const fallback = resolveHallByBlockName(item.block, hallDefinitions);
    return fallback ? [fallback] : [];
  }

  const routeCells =
    resolvedRouteCellCandidates ??
    (resolvedRouteCell
      ? [resolvedRouteCell]
      : resolveMapRouteCellCandidatesForItem({
          mapData: dayMapData,
          item,
          requireCellInMap: false,
        }));

  const polygonCandidates = new Set<string>();
  const blockNameCandidates = new Set<string>();
  for (const routeCell of routeCells) {
    collectHallCandidatesForResolvedRouteCell(
      polygonCandidates,
      blockNameCandidates,
      routeCell,
      hallDefinitions,
    );
  }

  if (polygonCandidates.size > 0) return [...polygonCandidates];
  if (blockNameCandidates.size > 0) return [...blockNameCandidates];
  if (resolvedRouteCell || resolvedRouteCellCandidates) return [];

  const fallback = resolveHallByBlockName(item.block, hallDefinitions);
  return fallback ? [fallback] : [];
}

export interface ResolveItemGroupIdForMapRouteParams {
  item: ShoppingItem;
  dayMapData: DayMapData | null;
  hallDefinitions: HallDefinition[];
  selectedHallId?: string;
  resolvedRouteCell?: ResolvedMapRouteCell | null;
  resolvedRouteCellCandidates?: ResolvedMapRouteCell[];
}

export function resolveItemGroupIdForMapRoute({
  item,
  dayMapData,
  hallDefinitions,
  selectedHallId = 'all',
  resolvedRouteCell,
  resolvedRouteCellCandidates,
}: ResolveItemGroupIdForMapRouteParams): string | null {
  const priority = (item.priorityLevel || 'none') as PriorityLevel;
  const hallCandidates = getHallCandidatesForMapRoute({
    item,
    dayMapData,
    hallDefinitions,
    resolvedRouteCell,
    resolvedRouteCellCandidates,
  });

  if (
    selectedHallId !== 'all' &&
    hallCandidates.length > 1 &&
    hallCandidates.includes(selectedHallId)
  ) {
    return buildGroupId(selectedHallId, priority);
  }

  if (selectedHallId === 'all' && hallCandidates.length > 1) {
    return buildGroupId(null, priority);
  }

  if (hallCandidates.length === 1) {
    return buildGroupId(hallCandidates[0], priority);
  }

  if (resolvedRouteCell || resolvedRouteCellCandidates) {
    return buildGroupId(null, priority);
  }

  return buildGroupId(getHallIdForItem(item, dayMapData, hallDefinitions), priority);
}

export function getMapRouteGroupParts(groupKey: string | null): {
  hallId: string | null;
  priority: PriorityLevel;
  isHallUnresolved: boolean;
} {
  const { hallId, priority } = parseGroupId(groupKey);
  const normalizedHallId = hallId === undefined || hallId === 'undefined' ? null : hallId;
  return {
    hallId: normalizedHallId,
    priority,
    isHallUnresolved: normalizedHallId === null,
  };
}

export function areMapRouteGroupKeysCompatible(
  anchorGroupKey: string | null,
  pendingGroupKeys: Array<string | null>,
): boolean {
  const anchor = getMapRouteGroupParts(anchorGroupKey);
  return pendingGroupKeys.every((groupKey) => {
    const pending = getMapRouteGroupParts(groupKey);
    return pending.hallId === anchor.hallId && pending.priority === anchor.priority;
  });
}

/**
 * アイテムをグループIDごとに分類した Map を返す。
 * 返り値の Map への挿入順はアイテム入力順に依存（4段階ロジックの共通前処理）。
 */
type ResolveGroupId = (item: ShoppingItem) => string | null;

function bucketItemsByGroupId(
  items: ShoppingItem[],
  dayMapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
): Map<string | null, ShoppingItem[]> {
  return bucketItemsByGroupIdWithResolver(
    items,
    (item) => getItemGroupId(item, dayMapData, hallDefinitions),
  );
}

function bucketItemsByGroupIdWithResolver(
  items: ShoppingItem[],
  resolveGroupId: ResolveGroupId,
): Map<string | null, ShoppingItem[]> {
  const groups = new Map<string | null, ShoppingItem[]>();
  items.forEach((item) => {
    const groupId = resolveGroupId(item);
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId)!.push(item);
  });
  return groups;
}

/**
 * 4段階ロジックでアイテムを hallOrder + 優先度順に並べ替える。
 * 段階:
 *   1. `hallOrder` に登場するグループ（優先度付き含む）を順に配置
 *   2. `hallOrder` に含まれないが `hallDefinitions` に存在するホール（通常グループ）
 *   3. 優先度付きグループで残っているもの
 *   4. ホール未定義のアイテム（groupId === null）
 *
 * 各グループ内のアイテム順は入力配列の順序を保持する。
 */
export function sortItemsByHallOrder(
  items: ShoppingItem[],
  dayMapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
  hallOrder: string[],
): ShoppingItem[] {
  // ホール定義 0 件でも、未定義系優先度バケットで分類して並べ替える。
  // groupItemsByHallOrder と同じ 4 段階ロジックを再利用するため、内部で呼び出して
  // フラット化するだけにする (グループ内のアイテム順は入力配列順を保持)。
  const grouped = groupItemsByHallOrder(items, dayMapData, hallDefinitions || [], hallOrder);
  const orderedItems: ShoppingItem[] = [];
  grouped.forEach((g) => {
    orderedItems.push(...g.items);
  });
  return orderedItems;
}

export function sortItemsByGroupOrderWithResolver(
  items: ShoppingItem[],
  hallDefinitions: HallDefinition[],
  hallOrder: string[],
  resolveGroupId: ResolveGroupId,
): ShoppingItem[] {
  return groupItemsByHallOrderWithResolver(
    items,
    hallDefinitions,
    hallOrder,
    resolveGroupId,
  ).flatMap((group) => group.items);
}

export interface HallGroupResult {
  groupId: string | null;
  hallId: string | null;
  hallName: string | null;
  hallColor?: string;
  priority: PriorityLevel;
  items: ShoppingItem[];
}

/**
 * 4段階ロジックでアイテムをホール別にグループ化する（メタ情報付き）。
 * `sortItemsByHallOrder` と同じ順序規則だが、フラット配列ではなくグループの配列を返す。
 *
 * `hallDefinitions` が空の場合は単一グループ（groupId=null）を返す。
 * `dayMapData` が null でも `blockNames` フォールバックや手動ホール設定でホールが解決される場合があるため、
 * `hallDefinitions` が存在する限り通常のグループ化処理を行う。
 */
export function groupItemsByHallOrderWithResolver(
  items: ShoppingItem[],
  hallDefinitions: HallDefinition[],
  hallOrder: string[],
  resolveGroupId: ResolveGroupId,
): HallGroupResult[] {
  // ホール定義なしでも、priorityLevel でアイテムを 3 バケット (highest / priority / none) に分離する。
  // null バケット(通常)はキーを `null` のままにして既存の消費側 (`groupId ?? fallback`) と後方互換を保つ。
  if (hallDefinitions.length === 0) {
    const noneBucket: ShoppingItem[] = [];
    const priorityBucket: ShoppingItem[] = [];
    const highestBucket: ShoppingItem[] = [];
    items.forEach((item) => {
      const p = item.priorityLevel || 'none';
      if (p === 'highest') highestBucket.push(item);
      else if (p === 'priority') priorityBucket.push(item);
      else noneBucket.push(item);
    });

    // hallOrder に従って未定義系グループの順序を決定する
    const emit = (gId: 'undefined' | 'undefined:priority' | 'undefined:highest') => {
      const bucket =
        gId === 'undefined:highest' ? highestBucket
          : gId === 'undefined:priority' ? priorityBucket
          : noneBucket;
      if (bucket.length === 0) return null;
      return {
        groupId: (gId === 'undefined' ? null : gId) as string | null,
        hallId: null,
        hallName: null,
        priority: (gId === 'undefined:highest' ? 'highest'
          : gId === 'undefined:priority' ? 'priority'
          : 'none') as PriorityLevel,
        items: bucket,
      };
    };

    const result: HallGroupResult[] = [];
    const emitted = new Set<string>();
    hallOrder.forEach((gId) => {
      if (gId === 'undefined' || gId === 'undefined:priority' || gId === 'undefined:highest') {
        if (emitted.has(gId)) return;
        const g = emit(gId);
        if (g) {
          result.push(g);
          emitted.add(gId);
        }
      }
    });
    // hallOrder に無いものは highest → priority → none の順で末尾追加
    (['undefined:highest', 'undefined:priority', 'undefined'] as const).forEach((gId) => {
      if (emitted.has(gId)) return;
      const g = emit(gId);
      if (g) {
        result.push(g);
        emitted.add(gId);
      }
    });
    return result;
  }

  const hallMap = new Map<string, HallDefinition>();
  hallDefinitions.forEach((hall) => hallMap.set(hall.id, hall));

  const groups = bucketItemsByGroupIdWithResolver(items, resolveGroupId);
  const result: HallGroupResult[] = [];

  // 1. hallOrderに従ってグループを追加
  hallOrder.forEach((groupId) => {
    // hallOrder 内の 'undefined' は内部バケットキー `null` にマップする
    const bucketKey: string | null = groupId === 'undefined' ? null : groupId;
    if (groups.has(bucketKey)) {
      const { hallId, priority } = parseGroupId(bucketKey);
      const hall = hallMap.get(hallId || '');
      result.push({
        groupId: bucketKey,
        hallId,
        hallName: hall?.name || null,
        hallColor: hall?.color || '#6366f1',
        priority,
        items: groups.get(bucketKey)!,
      });
      groups.delete(bucketKey);
    }
  });

  // 2. hallOrderに含まれないがhallDefinitionsに含まれるホール（通常グループ）
  hallDefinitions.forEach((hall) => {
    const groupId = hall.id;
    if (groups.has(groupId)) {
      result.push({
        groupId,
        hallId: hall.id,
        hallName: hall.name,
        hallColor: hall.color || '#6366f1',
        priority: 'none',
        items: groups.get(groupId)!,
      });
      groups.delete(groupId);
    }
  });

  // 3. 優先度付きグループで残っているもの
  Array.from(groups.entries())
    .filter(([gId]) => gId !== null)
    .forEach(([groupId, groupItems]) => {
      const { hallId, priority } = parseGroupId(groupId);
      const hall = hallMap.get(hallId || '');
      result.push({
        groupId,
        hallId,
        hallName: hall?.name || null,
        hallColor: hall?.color || '#6366f1',
        priority,
        items: groupItems,
      });
    });

  // 4. ホール未定義（null）— priority 別に分離して追加
  const undefinedBuckets: Record<PriorityLevel, ShoppingItem[]> = {
    none: [],
    priority: [],
    highest: [],
  };
  if (groups.has(null)) {
    groups.get(null)!.forEach((item) => {
      const p = (item.priorityLevel || 'none') as PriorityLevel;
      undefinedBuckets[p].push(item);
    });
    groups.delete(null);
  }
  // 既に hallOrder で 'undefined:priority' 等が result に出現していないかチェックし、
  // 未出現分だけ最優先 → 優先 → 通常の順で末尾に追加
  const hasGroupId = (gid: string | null): boolean =>
    result.some((g) => g.groupId === gid);
  if (undefinedBuckets.highest.length && !hasGroupId('undefined:highest')) {
    result.push({
      groupId: 'undefined:highest',
      hallId: null,
      hallName: null,
      priority: 'highest',
      items: undefinedBuckets.highest,
    });
  }
  if (undefinedBuckets.priority.length && !hasGroupId('undefined:priority')) {
    result.push({
      groupId: 'undefined:priority',
      hallId: null,
      hallName: null,
      priority: 'priority',
      items: undefinedBuckets.priority,
    });
  }
  if (undefinedBuckets.none.length && !hasGroupId(null)) {
    result.push({
      groupId: null,
      hallId: null,
      hallName: null,
      priority: 'none',
      items: undefinedBuckets.none,
    });
  }

  return result;
}

export function groupItemsByHallOrder(
  items: ShoppingItem[],
  dayMapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
  hallOrder: string[],
): HallGroupResult[] {
  return groupItemsByHallOrderWithResolver(
    items,
    hallDefinitions || [],
    hallOrder,
    (item) => getItemGroupId(item, dayMapData, hallDefinitions || []),
  );
}

/**
 * アイテム配列から実際に存在するグループ ID を列挙する。
 * 未定義系グループは `'undefined' / 'undefined:priority' / 'undefined:highest'` という文字列キーで返す
 * （hallOrder に格納可能な形）。通常ホール側は `<hallId>` or `<hallId>:priority` 等。
 * HallOrderPanel で `hallRouteSettings.hallOrder` に未登録のグループを可視化するために使用する。
 */
export function collectGroupIdsFromItems(
  items: ShoppingItem[],
  dayMapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  items.forEach((item) => {
    const hallId = getHallIdForItem(item, dayMapData, hallDefinitions);
    const priority = (item.priorityLevel || 'none') as PriorityLevel;
    let key: string;
    if (hallId === null) {
      key = priority === 'highest' ? 'undefined:highest'
        : priority === 'priority' ? 'undefined:priority'
        : 'undefined';
    } else {
      key = priority === 'highest' ? `${hallId}:highest`
        : priority === 'priority' ? `${hallId}:priority`
        : hallId;
    }
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  });
  return ordered;
}
