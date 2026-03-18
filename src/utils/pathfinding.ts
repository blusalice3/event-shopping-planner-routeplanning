import { CellData, PathNode, RouteSegment, DayMapData } from '../types';

// サブセル解像度: 各セルをN×Nに分割
const SUB_CELL_RESOLUTION = 3;

// 既存ルートと重複した場合のペナルティ倍率
const OVERLAP_PENALTY = 4;

// 通過不可セル（数値セル・塗りつぶしセル）に隣接するサブセルのペナルティ
// ルートの線が数値セルに視覚的に被るのを防ぐためのバッファゾーン
const BUFFER_PENALTY = 3;

// セルが通過可能かどうかを判定（元のセル単位）
function isPassableCell(
  cellsMap: Map<string, CellData>,
  row: number,
  col: number,
  maxRow: number,
  maxCol: number,
): boolean {
  if (row < 1 || col < 1 || row > maxRow || col > maxCol) return false;

  const key = `${row}-${col}`;
  const cell = cellsMap.get(key);

  // セルが存在しない場合は通過可能
  if (!cell) return true;

  // 数値セルは通過不可
  if (cell.value !== null && typeof cell.value === 'number') return false;
  if (cell.value !== null && /^\d+$/.test(String(cell.value))) return false;

  // 塗りつぶしセルは通過不可
  if (cell.backgroundColor && cell.backgroundColor !== '#FFFFFF') return false;

  return true;
}

// サブセル座標から親セル座標（1-based）を取得
function subCellToCell(sr: number, sc: number): { row: number; col: number } {
  return {
    row: Math.floor(sr / SUB_CELL_RESOLUTION) + 1,
    col: Math.floor(sc / SUB_CELL_RESOLUTION) + 1,
  };
}

// セル座標（1-based）から中央サブセル座標（0-based）を取得
function cellToSubCell(row: number, col: number): { sr: number; sc: number } {
  const center = Math.floor(SUB_CELL_RESOLUTION / 2);
  return {
    sr: (row - 1) * SUB_CELL_RESOLUTION + center,
    sc: (col - 1) * SUB_CELL_RESOLUTION + center,
  };
}

// サブセル座標を描画用の小数row/col座標に変換
// 変換後は既存の (val - 0.5) * cellSize でピクセル座標になる
function subCellToFractional(sr: number, sc: number): { row: number; col: number } {
  return {
    row: (sr + 0.5) / SUB_CELL_RESOLUTION + 0.5,
    col: (sc + 0.5) / SUB_CELL_RESOLUTION + 0.5,
  };
}

// サブセルが通過可能かどうかを判定
function isPassableSubCell(
  cellsMap: Map<string, CellData>,
  sr: number,
  sc: number,
  maxSubRow: number,
  maxSubCol: number,
  maxRow: number,
  maxCol: number,
): boolean {
  if (sr < 0 || sc < 0 || sr >= maxSubRow || sc >= maxSubCol) return false;
  const { row, col } = subCellToCell(sr, sc);
  return isPassableCell(cellsMap, row, col, maxRow, maxCol);
}

// 通過不可セルに隣接するサブセルのバッファコストマップを構築
// 経路がなるべく数値セルの境界近くを通らないようにするためのペナルティマップ
// エッジサブセルのみに軽いペナルティを設定し、最短経路を維持しつつセル中央を通るよう誘導
function buildBufferCostMap(
  cellsMap: Map<string, CellData>,
  maxRow: number,
  maxCol: number,
): Map<number, number> {
  const N = SUB_CELL_RESOLUTION;
  const maxSubCol = maxCol * N;
  const bufferMap = new Map<number, number>();

  const setBuffer = (sr: number, sc: number, penalty: number) => {
    const key = sr * maxSubCol + sc;
    const existing = bufferMap.get(key) ?? 0;
    if (penalty > existing) {
      bufferMap.set(key, penalty);
    }
  };

  // 隣接方向とバッファ対象サブセルの対応
  // dr,dcは通過不可セルから見た通過可能セルの方向
  // 通過不可セルに面するエッジサブセルのみにペナルティ（中央・反対側は自由通行）
  const neighborOffsets: { dr: number; dc: number; getSubCells: (r: number, c: number) => { sr: number; sc: number }[] }[] = [
    // 通過可能セルが上(dr=-1) → 下端(localRow=2)が通過不可セルに面する
    { dr: -1, dc: 0, getSubCells: (r, c) => {
      const baseSr = (r - 1) * N + (N - 1); // localRow=2
      const baseSc = (c - 1) * N;
      return [{ sr: baseSr, sc: baseSc }, { sr: baseSr, sc: baseSc + 1 }, { sr: baseSr, sc: baseSc + 2 }];
    }},
    // 通過可能セルが下(dr=1) → 上端(localRow=0)が通過不可セルに面する
    { dr: 1, dc: 0, getSubCells: (r, c) => {
      const baseSr = (r - 1) * N; // localRow=0
      const baseSc = (c - 1) * N;
      return [{ sr: baseSr, sc: baseSc }, { sr: baseSr, sc: baseSc + 1 }, { sr: baseSr, sc: baseSc + 2 }];
    }},
    // 通過可能セルが左(dc=-1) → 右端(localCol=2)が通過不可セルに面する
    { dr: 0, dc: -1, getSubCells: (r, c) => {
      const baseSr = (r - 1) * N;
      const baseSc = (c - 1) * N + (N - 1); // localCol=2
      return [{ sr: baseSr, sc: baseSc }, { sr: baseSr + 1, sc: baseSc }, { sr: baseSr + 2, sc: baseSc }];
    }},
    // 通過可能セルが右(dc=1) → 左端(localCol=0)が通過不可セルに面する
    { dr: 0, dc: 1, getSubCells: (r, c) => {
      const baseSr = (r - 1) * N;
      const baseSc = (c - 1) * N; // localCol=0
      return [{ sr: baseSr, sc: baseSc }, { sr: baseSr + 1, sc: baseSc }, { sr: baseSr + 2, sc: baseSc }];
    }},
    // 通過可能セルが左上(dr=-1,dc=-1) → 右下角(localRow=2,localCol=2)
    { dr: -1, dc: -1, getSubCells: (r, c) => [{ sr: (r - 1) * N + (N - 1), sc: (c - 1) * N + (N - 1) }] },
    // 通過可能セルが右上(dr=-1,dc=1) → 左下角(localRow=2,localCol=0)
    { dr: -1, dc: 1, getSubCells: (r, c) => [{ sr: (r - 1) * N + (N - 1), sc: (c - 1) * N }] },
    // 通過可能セルが左下(dr=1,dc=-1) → 右上角(localRow=0,localCol=2)
    { dr: 1, dc: -1, getSubCells: (r, c) => [{ sr: (r - 1) * N, sc: (c - 1) * N + (N - 1) }] },
    // 通過可能セルが右下(dr=1,dc=1) → 左上角(localRow=0,localCol=0)
    { dr: 1, dc: 1, getSubCells: (r, c) => [{ sr: (r - 1) * N, sc: (c - 1) * N }] },
  ];

  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      // 通過不可セルを見つける
      if (isPassableCell(cellsMap, row, col, maxRow, maxCol)) continue;

      // 隣接する通過可能セルのエッジサブセルにペナルティを設定
      for (const offset of neighborOffsets) {
        const neighborRow = row + offset.dr;
        const neighborCol = col + offset.dc;
        if (neighborRow < 1 || neighborCol < 1 || neighborRow > maxRow || neighborCol > maxCol) continue;
        if (!isPassableCell(cellsMap, neighborRow, neighborCol, maxRow, maxCol)) continue;

        const subCells = offset.getSubCells(neighborRow, neighborCol);
        for (const { sr, sc } of subCells) {
          setBuffer(sr, sc, BUFFER_PENALTY);
        }
      }
    }
  }

  return bufferMap;
}

// --- Binary Heap (優先度キュー) ---
interface HeapNode {
  sr: number;
  sc: number;
  g: number;
  h: number;
  f: number;
  parentSr: number;
  parentSc: number;
}

class BinaryHeap {
  private heap: HeapNode[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(node: HeapNode): void {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      if (this.heap[idx].f >= this.heap[parentIdx].f) break;
      [this.heap[idx], this.heap[parentIdx]] = [this.heap[parentIdx], this.heap[idx]];
      idx = parentIdx;
    }
  }

  private sinkDown(idx: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < length && this.heap[left].f < this.heap[smallest].f) smallest = left;
      if (right < length && this.heap[right].f < this.heap[smallest].f) smallest = right;
      if (smallest === idx) break;
      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
      idx = smallest;
    }
  }
}

// マンハッタン距離を計算
function heuristic(r1: number, c1: number, r2: number, c2: number): number {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

// 方向（上下左右 + 斜め）
const DIRECTIONS = [
  { dr: -1, dc: 0, cost: 1 },   // 上
  { dr: 1, dc: 0, cost: 1 },    // 下
  { dr: 0, dc: -1, cost: 1 },   // 左
  { dr: 0, dc: 1, cost: 1 },    // 右
  { dr: -1, dc: -1, cost: 1.4 }, // 左上
  { dr: -1, dc: 1, cost: 1.4 },  // 右上
  { dr: 1, dc: -1, cost: 1.4 },  // 左下
  { dr: 1, dc: 1, cost: 1.4 },   // 右下
];

// サブセルが特定セル内にあるかを判定
function isSubCellInCell(sr: number, sc: number, cellRow: number, cellCol: number): boolean {
  const N = SUB_CELL_RESOLUTION;
  const { row, col } = subCellToCell(sr, sc);
  return row === cellRow && col === cellCol;
}

// サブセルグリッド上のA*探索（Theta*ライクなline-of-sight最適化付き）
function findSubCellPath(
  cellsMap: Map<string, CellData>,
  maxRow: number,
  maxCol: number,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  usedSubCells?: Map<string, number>,
  bufferCostMap?: Map<number, number>,
): { row: number; col: number }[] {
  const N = SUB_CELL_RESOLUTION;
  const maxSubRow = maxRow * N;
  const maxSubCol = maxCol * N;

  // バッファコストマップが未提供の場合は構築
  const effectiveBufferMap = bufferCostMap ?? buildBufferCostMap(cellsMap, maxRow, maxCol);

  // セル座標 → サブセル座標（中央）
  const start = cellToSubCell(startRow, startCol);
  const end = cellToSubCell(endRow, endCol);

  // ゴールのサブセル座標
  const goalSr = end.sr;
  const goalSc = end.sc;

  // スタートセル・ゴールセルの座標（通過不可でも例外として許可する）
  const startCellRow = startRow;
  const startCellCol = startCol;
  const goalCellRow = endRow;
  const goalCellCol = endCol;

  // サブセルが通過可能か判定（スタートセル・ゴールセル例外付き）
  const isPassableOrException = (sr: number, sc: number): boolean => {
    if (sr < 0 || sc < 0 || sr >= maxSubRow || sc >= maxSubCol) return false;
    // スタートセル・ゴールセル内のサブセルは通過可能として扱う
    if (isSubCellInCell(sr, sc, startCellRow, startCellCol)) return true;
    if (isSubCellInCell(sr, sc, goalCellRow, goalCellCol)) return true;
    return isPassableSubCell(cellsMap, sr, sc, maxSubRow, maxSubCol, maxRow, maxCol);
  };

  const subKey = (sr: number, sc: number) => sr * maxSubCol + sc;

  // g値マップとparentマップ
  const gMap = new Map<number, number>();
  const parentMap = new Map<number, number>(); // key → parentKey
  const closedSet = new Set<number>();

  const startKey = subKey(start.sr, start.sc);

  gMap.set(startKey, 0);
  parentMap.set(startKey, -1); // スタートは親なし

  const openHeap = new BinaryHeap();
  const h0 = heuristic(start.sr, start.sc, goalSr, goalSc);
  openHeap.push({
    sr: start.sr, sc: start.sc,
    g: 0, h: h0, f: h0,
    parentSr: -1, parentSc: -1,
  });

  const maxIterations = maxSubRow * maxSubCol;
  let iterations = 0;

  while (openHeap.size > 0 && iterations < maxIterations) {
    iterations++;

    const current = openHeap.pop()!;
    const currentKey = subKey(current.sr, current.sc);

    // 既に処理済みならスキップ
    if (closedSet.has(currentKey)) continue;
    closedSet.add(currentKey);

    // ゴール到達
    if (current.sr === goalSr && current.sc === goalSc) {
      // パスを再構築（サブセル座標 → 小数row/col座標）
      const subPath: { sr: number; sc: number }[] = [];
      let key = currentKey;
      while (key !== -1) {
        const sr = Math.floor(key / maxSubCol);
        const sc = key % maxSubCol;
        subPath.unshift({ sr, sc });
        key = parentMap.get(key) ?? -1;
      }

      // Theta*ライクなline-of-sight最適化: 不要な中間点を除去
      // スタートセル・ゴールセルも考慮した見通し判定
      const optimized = optimizePathWithLineOfSight(
        subPath, cellsMap, maxSubRow, maxSubCol, maxRow, maxCol,
        startCellRow, startCellCol, goalCellRow, goalCellCol,
      );

      // 小数row/col座標に変換
      return optimized.map((p) => subCellToFractional(p.sr, p.sc));
    }

    // 隣接ノードを探索
    for (const dir of DIRECTIONS) {
      const newSr = current.sr + dir.dr;
      const newSc = current.sc + dir.dc;
      const newKey = subKey(newSr, newSc);

      if (closedSet.has(newKey)) continue;

      // 通過可否判定（スタートセル・ゴールセルは例外で通過可能）
      if (!isPassableOrException(newSr, newSc)) {
        continue;
      }

      // 斜め移動の場合、両隣のサブセルが通過可能かチェック
      if (Math.abs(dir.dr) === 1 && Math.abs(dir.dc) === 1) {
        if (!isPassableOrException(current.sr + dir.dr, current.sc) ||
            !isPassableOrException(current.sr, current.sc + dir.dc)) {
          continue;
        }
      }

      // 移動コスト計算
      let moveCost = dir.cost;

      // バッファゾーンペナルティ（スタートセル・ゴールセルは除外）
      if (!isSubCellInCell(newSr, newSc, startCellRow, startCellCol) &&
          !isSubCellInCell(newSr, newSc, goalCellRow, goalCellCol)) {
        moveCost += effectiveBufferMap.get(subKey(newSr, newSc)) ?? 0;
      }

      // 既存ルートとの重複ペナルティ
      if (usedSubCells) {
        const usageCount = usedSubCells.get(`${newSr}-${newSc}`) ?? 0;
        if (usageCount > 0) {
          moveCost *= 1 + usageCount * OVERLAP_PENALTY;
        }
      }

      const newG = current.g + moveCost;
      const existingG = gMap.get(newKey);

      if (existingG === undefined || newG < existingG) {
        gMap.set(newKey, newG);
        parentMap.set(newKey, currentKey);

        const newH = heuristic(newSr, newSc, goalSr, goalSc);
        openHeap.push({
          sr: newSr, sc: newSc,
          g: newG, h: newH, f: newG + newH,
          parentSr: current.sr, parentSc: current.sc,
        });
      }
    }
  }

  // 経路が見つからない場合は直線で結ぶ（小数座標）
  return [
    subCellToFractional(start.sr, start.sc),
    subCellToFractional(goalSr, goalSc),
  ];
}

// Line-of-Sight判定（スタートセル・ゴールセル例外付き）
// 2つのサブセル間の直線上にある全セルが通過可能かチェック
function lineOfSightWithExceptions(
  cellsMap: Map<string, CellData>,
  sr1: number, sc1: number,
  sr2: number, sc2: number,
  maxSubRow: number, maxSubCol: number,
  maxRow: number, maxCol: number,
  startCellRow: number, startCellCol: number,
  goalCellRow: number, goalCellCol: number,
): boolean {
  let x0 = sc1;
  let y0 = sr1;
  const x1 = sc2;
  const y1 = sr2;

  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    // スタートセル・ゴールセル内は通過可能として扱う
    if (!isSubCellInCell(y0, x0, startCellRow, startCellCol) &&
        !isSubCellInCell(y0, x0, goalCellRow, goalCellCol)) {
      if (!isPassableSubCell(cellsMap, y0, x0, maxSubRow, maxSubCol, maxRow, maxCol)) {
        return false;
      }
    }
    if (x0 === x1 && y0 === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return true;
}

// Line-of-Sightベースの経路最適化
// 直線で到達可能な中間点を除去して滑らかな経路にする
function optimizePathWithLineOfSight(
  subPath: { sr: number; sc: number }[],
  cellsMap: Map<string, CellData>,
  maxSubRow: number,
  maxSubCol: number,
  maxRow: number,
  maxCol: number,
  startCellRow: number,
  startCellCol: number,
  goalCellRow: number,
  goalCellCol: number,
): { sr: number; sc: number }[] {
  if (subPath.length <= 2) return subPath;

  const result: { sr: number; sc: number }[] = [subPath[0]];
  let current = 0;

  while (current < subPath.length - 1) {
    // 現在地から最も遠い直接見通せるポイントを探す
    let farthest = current + 1;
    for (let i = subPath.length - 1; i > current + 1; i--) {
      if (lineOfSightWithExceptions(
        cellsMap,
        subPath[current].sr, subPath[current].sc,
        subPath[i].sr, subPath[i].sc,
        maxSubRow, maxSubCol, maxRow, maxCol,
        startCellRow, startCellCol, goalCellRow, goalCellCol,
      )) {
        farthest = i;
        break;
      }
    }
    result.push(subPath[farthest]);
    current = farthest;
  }

  return result;
}

// 経路上のサブセルを使用済みとしてマーク
function markPathSubCells(
  path: { row: number; col: number }[],
  usedSubCells: Map<string, number>,
): void {
  const N = SUB_CELL_RESOLUTION;
  for (const point of path) {
    // 小数座標 → サブセル座標に逆変換
    const sr = Math.round((point.row - 0.5) * N - 0.5);
    const sc = Math.round((point.col - 0.5) * N - 0.5);

    // 周辺のサブセルもマーク（経路幅を持たせる）
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const key = `${sr + dr}-${sc + dc}`;
        usedSubCells.set(key, (usedSubCells.get(key) ?? 0) + 1);
      }
    }
  }
}

// 旧API互換: セル単位のA*探索
export function findPath(
  mapData: DayMapData,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): { row: number; col: number }[] {
  const cellsMap = new Map<string, CellData>();
  mapData.cells.forEach((cell) => {
    cellsMap.set(`${cell.row}-${cell.col}`, cell);
  });

  return findSubCellPath(
    cellsMap, mapData.maxRow, mapData.maxCol,
    startRow, startCol, endRow, endCol,
  );
}

// 訪問先間のルートセグメントを生成（重複回避付き）
export function generateRouteSegments(
  mapData: DayMapData,
  visitPoints: { row: number; col: number; priorityLevel?: 'none' | 'priority' | 'highest' }[],
): RouteSegment[] {
  if (visitPoints.length < 2) return [];

  const cellsMap = new Map<string, CellData>();
  mapData.cells.forEach((cell) => {
    cellsMap.set(`${cell.row}-${cell.col}`, cell);
  });

  const segments: RouteSegment[] = [];
  const usedSubCells = new Map<string, number>();
  const bufferCostMap = buildBufferCostMap(cellsMap, mapData.maxRow, mapData.maxCol);

  for (let i = 0; i < visitPoints.length - 1; i++) {
    const from = visitPoints[i];
    const to = visitPoints[i + 1];

    const path = findSubCellPath(
      cellsMap, mapData.maxRow, mapData.maxCol,
      from.row, from.col, to.row, to.col,
      usedSubCells,
      bufferCostMap,
    );

    // この経路のサブセルを使用済みとしてマーク
    markPathSubCells(path, usedSubCells);

    segments.push({
      fromRow: from.row,
      fromCol: from.col,
      toRow: to.row,
      toCol: to.col,
      path,
      fromPriority: from.priorityLevel || 'none',
      toPriority: to.priorityLevel || 'none',
    });
  }

  return segments;
}

// 経路を簡略化（Douglas-Peuckerアルゴリズムベース）
export function simplifyPath(
  path: { row: number; col: number }[],
  tolerance: number = 0.5,
): { row: number; col: number }[] {
  if (path.length <= 2) return path;

  // 最も遠い点を見つける
  let maxDistance = 0;
  let maxIndex = 0;

  const start = path[0];
  const end = path[path.length - 1];

  for (let i = 1; i < path.length - 1; i++) {
    const distance = pointToLineDistance(
      path[i].row,
      path[i].col,
      start.row,
      start.col,
      end.row,
      end.col,
    );

    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  // 許容範囲を超える場合は分割して再帰
  if (maxDistance > tolerance) {
    const left = simplifyPath(path.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPath(path.slice(maxIndex), tolerance);

    return [...left.slice(0, -1), ...right];
  }

  // 許容範囲内の場合は始点と終点のみ
  return [start, end];
}

// 点から線分への距離
function pointToLineDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));

  const nearestX = x1 + t * dx;
  const nearestY = y1 + t * dy;

  return Math.sqrt((px - nearestX) ** 2 + (py - nearestY) ** 2);
}
