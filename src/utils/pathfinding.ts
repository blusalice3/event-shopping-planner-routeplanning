import {
  CellData,
  PathNode,
  RouteSegment,
  DayMapData,
} from '../types/map';

// サブセル解像度: 各セルをN×Nに分割
const SUB_CELL_RESOLUTION = 3;

// 既存ルートと重複した場合のペナルティ倍率
const OVERLAP_PENALTY = 4;

// 通過不可セル（数値セル・塗りつぶしセル）に隣接するサブセルのペナルティ
// ルートの線が数値セルに視覚的に被るのを防ぐためのバッファゾーン
const BUFFER_PENALTY = 3;

// 方向転換時のペナルティ（不要なジグザグを防止）
const TURN_PENALTY = 0.5;

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
  dirDr: number;  // この地点に到達した方向 (-1, 0, 1)
  dirDc: number;  // この地点に到達した方向 (-1, 0, 1)
}

// 方向インデックス: up=0, down=1, left=2, right=3, start=4(方向なし)
function dirIndex(dr: number, dc: number): number {
  if (dr === -1) return 0;
  if (dr === 1) return 1;
  if (dc === -1) return 2;
  if (dc === 1) return 3;
  return 4; // start (方向なし)
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

// 方向（上下左右のみ：直交ルーティング）
const DIRECTIONS = [
  { dr: -1, dc: 0, cost: 1 },   // 上
  { dr: 1, dc: 0, cost: 1 },    // 下
  { dr: 0, dc: -1, cost: 1 },   // 左
  { dr: 0, dc: 1, cost: 1 },    // 右
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

  // 方向対応のstateKey: 同じ地点でも到達方向が異なれば別状態として扱う
  const stateKey = (sr: number, sc: number, di: number) =>
    (sr * maxSubCol + sc) * 5 + di;

  // stateKeyから(sr, sc)を逆算
  const stateKeyToPos = (key: number) => {
    const posKey = Math.floor(key / 5);
    return { sr: Math.floor(posKey / maxSubCol), sc: posKey % maxSubCol };
  };

  // g値マップとparentマップ（方向対応）
  const gMap = new Map<number, number>();
  const parentMap = new Map<number, number>(); // stateKey → parentStateKey
  const closedSet = new Set<number>();

  const startDi = dirIndex(0, 0); // start: 方向なし
  const startStateKey = stateKey(start.sr, start.sc, startDi);

  gMap.set(startStateKey, 0);
  parentMap.set(startStateKey, -1); // スタートは親なし

  const openHeap = new BinaryHeap();
  const h0 = heuristic(start.sr, start.sc, goalSr, goalSc);
  openHeap.push({
    sr: start.sr, sc: start.sc,
    g: 0, h: h0, f: h0,
    parentSr: -1, parentSc: -1,
    dirDr: 0, dirDc: 0,
  });

  const maxIterations = maxSubRow * maxSubCol * 5;
  let iterations = 0;

  while (openHeap.size > 0 && iterations < maxIterations) {
    iterations++;

    const current = openHeap.pop()!;
    const currentDi = dirIndex(current.dirDr, current.dirDc);
    const currentStateKey = stateKey(current.sr, current.sc, currentDi);

    // 既に処理済みならスキップ
    if (closedSet.has(currentStateKey)) continue;
    closedSet.add(currentStateKey);

    // ゴール到達
    if (current.sr === goalSr && current.sc === goalSc) {
      // パスを再構築（stateKey → サブセル座標）
      const subPath: { sr: number; sc: number }[] = [];
      let key = currentStateKey;
      while (key !== -1) {
        const pos = stateKeyToPos(key);
        subPath.unshift(pos);
        key = parentMap.get(key) ?? -1;
      }

      // 直交コリニアマージ: 同一方向の連続点を除去
      const optimized = mergeCollinearPoints(subPath);

      // 小数row/col座標に変換
      return optimized.map((p) => subCellToFractional(p.sr, p.sc));
    }

    // 隣接ノードを探索
    for (const dir of DIRECTIONS) {
      const newSr = current.sr + dir.dr;
      const newSc = current.sc + dir.dc;
      const newDi = dirIndex(dir.dr, dir.dc);
      const newStateKey = stateKey(newSr, newSc, newDi);

      if (closedSet.has(newStateKey)) continue;

      // 通過可否判定（スタートセル・ゴールセルは例外で通過可能）
      if (!isPassableOrException(newSr, newSc)) {
        continue;
      }

      // 移動コスト計算
      let moveCost = dir.cost;

      // ターンペナルティ（スタート地点以外で方向が変わった場合）
      const isTurn = (current.dirDr !== 0 || current.dirDc !== 0) &&
                     (dir.dr !== current.dirDr || dir.dc !== current.dirDc);
      if (isTurn) {
        moveCost += TURN_PENALTY;
      }

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
      const existingG = gMap.get(newStateKey);

      if (existingG === undefined || newG < existingG) {
        gMap.set(newStateKey, newG);
        parentMap.set(newStateKey, currentStateKey);

        const newH = heuristic(newSr, newSc, goalSr, goalSc);
        openHeap.push({
          sr: newSr, sc: newSc,
          g: newG, h: newH, f: newG + newH,
          parentSr: current.sr, parentSc: current.sc,
          dirDr: dir.dr, dirDc: dir.dc,
        });
      }
    }
  }

  // 経路が見つからない場合はL字で結ぶ（小数座標、直交ルーティング維持）
  return [
    subCellToFractional(start.sr, start.sc),
    subCellToFractional(start.sr, goalSc),
    subCellToFractional(goalSr, goalSc),
  ];
}

// 直交コリニアマージ: 同一方向の連続ポイントを除去し、曲がり角のみ残す
function mergeCollinearPoints(
  subPath: { sr: number; sc: number }[]
): { sr: number; sc: number }[] {
  if (subPath.length <= 2) return subPath;

  const result: { sr: number; sc: number }[] = [subPath[0]];

  for (let i = 1; i < subPath.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = subPath[i];
    const next = subPath[i + 1];

    // 前後の方向が変わる場合のみポイントを残す（90°曲がり角）
    const dr1 = Math.sign(curr.sr - prev.sr);
    const dc1 = Math.sign(curr.sc - prev.sc);
    const dr2 = Math.sign(next.sr - curr.sr);
    const dc2 = Math.sign(next.sc - curr.sc);

    if (dr1 !== dr2 || dc1 !== dc2) {
      result.push(curr);
    }
  }

  result.push(subPath[subPath.length - 1]);
  return result;
}

// 経路上のサブセルを使用済みとしてマーク
// コーナーポイントだけでなく、直線セグメント上の全中間サブセルも補間してマークする
function markPathSubCells(
  path: { row: number; col: number }[],
  usedSubCells: Map<string, number>,
): void {
  const N = SUB_CELL_RESOLUTION;

  const markPoint = (sr: number, sc: number) => {
    const key = `${sr}-${sc}`;
    usedSubCells.set(key, (usedSubCells.get(key) ?? 0) + 1);
  };

  for (let i = 0; i < path.length; i++) {
    const sr = Math.round((path[i].row - 0.5) * N - 0.5);
    const sc = Math.round((path[i].col - 0.5) * N - 0.5);
    markPoint(sr, sc);

    // 次のポイントまでの直線セグメント上の中間サブセルもマーク
    if (i < path.length - 1) {
      const nextSr = Math.round((path[i + 1].row - 0.5) * N - 0.5);
      const nextSc = Math.round((path[i + 1].col - 0.5) * N - 0.5);
      const dsr = Math.sign(nextSr - sr);
      const dsc = Math.sign(nextSc - sc);
      let curSr = sr + dsr;
      let curSc = sc + dsc;
      while (curSr !== nextSr || curSc !== nextSc) {
        markPoint(curSr, curSc);
        curSr += dsr;
        curSc += dsc;
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

  // 直交パスの場合はコリニアマージのみ適用（Douglas-Peuckerが90°曲がりを斜めに潰すのを防止）
  const isOrthogonal = path.every((p, i) => {
    if (i === 0) return true;
    const prev = path[i - 1];
    return Math.abs(p.row - prev.row) < 0.01 || Math.abs(p.col - prev.col) < 0.01;
  });
  if (isOrthogonal) {
    // 同一方向の連続ポイントを除去（曲がり角は保持）
    const merged: { row: number; col: number }[] = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const prev = merged[merged.length - 1];
      const curr = path[i];
      const next = path[i + 1];
      const dr1 = Math.sign(curr.row - prev.row);
      const dc1 = Math.sign(curr.col - prev.col);
      const dr2 = Math.sign(next.row - curr.row);
      const dc2 = Math.sign(next.col - curr.col);
      if (dr1 !== dr2 || dc1 !== dc2) {
        merged.push(curr);
      }
    }
    merged.push(path[path.length - 1]);
    return merged;
  }

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
