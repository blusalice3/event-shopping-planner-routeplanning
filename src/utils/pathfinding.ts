import {
  CellData,
  RouteSegment,
  DayMapData,
  RoutePathConstraint,
} from "../types/map";

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
function isPassableCellData(cell: CellData): boolean {
  // 数値セルは通過不可
  if (cell.value !== null && typeof cell.value === "number") return false;
  if (cell.value !== null && /^\d+$/.test(String(cell.value))) return false;

  // 塗りつぶしセルは通過不可
  if (cell.backgroundColor && cell.backgroundColor !== "#FFFFFF") return false;

  return true;
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
function subCellToFractional(
  sr: number,
  sc: number,
): { row: number; col: number } {
  return {
    row: (sr + 0.5) / SUB_CELL_RESOLUTION + 0.5,
    col: (sc + 0.5) / SUB_CELL_RESOLUTION + 0.5,
  };
}

// 通過不可セルに隣接するサブセルのバッファコストマップを構築
// 経路がなるべく数値セルの境界近くを通らないようにするためのペナルティマップ
// エッジサブセルのみに軽いペナルティを設定し、最短経路を維持しつつセル中央を通るよう誘導
function buildBufferCostGrid(
  passableCells: Uint8Array,
  maxRow: number,
  maxCol: number,
): Uint8Array {
  const N = SUB_CELL_RESOLUTION;
  const maxSubCol = maxCol * N;
  const bufferGrid = new Uint8Array(maxRow * N * maxSubCol);

  const setBuffer = (sr: number, sc: number, penalty: number) => {
    const key = sr * maxSubCol + sc;
    if (penalty > bufferGrid[key]) {
      bufferGrid[key] = penalty;
    }
  };
  const isPassable = (row: number, col: number): boolean =>
    row >= 1 &&
    col >= 1 &&
    row <= maxRow &&
    col <= maxCol &&
    passableCells[(row - 1) * maxCol + col - 1] === 1;

  // 隣接方向とバッファ対象サブセルの対応
  // dr,dcは通過不可セルから見た通過可能セルの方向
  // 通過不可セルに面するエッジサブセルのみにペナルティ（中央・反対側は自由通行）
  const neighborOffsets: {
    dr: number;
    dc: number;
    getSubCells: (r: number, c: number) => { sr: number; sc: number }[];
  }[] = [
    // 通過可能セルが上(dr=-1) → 下端(localRow=2)が通過不可セルに面する
    {
      dr: -1,
      dc: 0,
      getSubCells: (r, c) => {
        const baseSr = (r - 1) * N + (N - 1); // localRow=2
        const baseSc = (c - 1) * N;
        return [
          { sr: baseSr, sc: baseSc },
          { sr: baseSr, sc: baseSc + 1 },
          { sr: baseSr, sc: baseSc + 2 },
        ];
      },
    },
    // 通過可能セルが下(dr=1) → 上端(localRow=0)が通過不可セルに面する
    {
      dr: 1,
      dc: 0,
      getSubCells: (r, c) => {
        const baseSr = (r - 1) * N; // localRow=0
        const baseSc = (c - 1) * N;
        return [
          { sr: baseSr, sc: baseSc },
          { sr: baseSr, sc: baseSc + 1 },
          { sr: baseSr, sc: baseSc + 2 },
        ];
      },
    },
    // 通過可能セルが左(dc=-1) → 右端(localCol=2)が通過不可セルに面する
    {
      dr: 0,
      dc: -1,
      getSubCells: (r, c) => {
        const baseSr = (r - 1) * N;
        const baseSc = (c - 1) * N + (N - 1); // localCol=2
        return [
          { sr: baseSr, sc: baseSc },
          { sr: baseSr + 1, sc: baseSc },
          { sr: baseSr + 2, sc: baseSc },
        ];
      },
    },
    // 通過可能セルが右(dc=1) → 左端(localCol=0)が通過不可セルに面する
    {
      dr: 0,
      dc: 1,
      getSubCells: (r, c) => {
        const baseSr = (r - 1) * N;
        const baseSc = (c - 1) * N; // localCol=0
        return [
          { sr: baseSr, sc: baseSc },
          { sr: baseSr + 1, sc: baseSc },
          { sr: baseSr + 2, sc: baseSc },
        ];
      },
    },
    // 通過可能セルが左上(dr=-1,dc=-1) → 右下角(localRow=2,localCol=2)
    {
      dr: -1,
      dc: -1,
      getSubCells: (r, c) => [
        { sr: (r - 1) * N + (N - 1), sc: (c - 1) * N + (N - 1) },
      ],
    },
    // 通過可能セルが右上(dr=-1,dc=1) → 左下角(localRow=2,localCol=0)
    {
      dr: -1,
      dc: 1,
      getSubCells: (r, c) => [{ sr: (r - 1) * N + (N - 1), sc: (c - 1) * N }],
    },
    // 通過可能セルが左下(dr=1,dc=-1) → 右上角(localRow=0,localCol=2)
    {
      dr: 1,
      dc: -1,
      getSubCells: (r, c) => [{ sr: (r - 1) * N, sc: (c - 1) * N + (N - 1) }],
    },
    // 通過可能セルが右下(dr=1,dc=1) → 左上角(localRow=0,localCol=0)
    {
      dr: 1,
      dc: 1,
      getSubCells: (r, c) => [{ sr: (r - 1) * N, sc: (c - 1) * N }],
    },
  ];

  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      // 通過不可セルを見つける
      if (isPassable(row, col)) continue;

      // 隣接する通過可能セルのエッジサブセルにペナルティを設定
      for (const offset of neighborOffsets) {
        const neighborRow = row + offset.dr;
        const neighborCol = col + offset.dc;
        if (
          neighborRow < 1 ||
          neighborCol < 1 ||
          neighborRow > maxRow ||
          neighborCol > maxCol
        )
          continue;
        if (!isPassable(neighborRow, neighborCol)) continue;

        const subCells = offset.getSubCells(neighborRow, neighborCol);
        for (const { sr, sc } of subCells) {
          setBuffer(sr, sc, BUFFER_PENALTY);
        }
      }
    }
  }

  return bufferGrid;
}

type PathfindingScratch = {
  gScores: Float64Array;
  parentStateKeys: Int32Array;
  seenGenerations: Uint32Array;
  closedGenerations: Uint32Array;
  generation: number;
};

type PathfindingContext = {
  maxRow: number;
  maxCol: number;
  maxSubRow: number;
  maxSubCol: number;
  passableCells: Uint8Array;
  bufferCosts: Uint8Array;
  normalRouteCache: RouteSegmentsCacheEntry[];
  strictRouteCache: StrictRouteSegmentsCacheEntry[];
};

const MAX_SHARED_PATHFINDING_STATE_COUNT = 1_000_000;
let sharedPathfindingScratch: PathfindingScratch | null = null;

const createPathfindingScratch = (stateCount: number): PathfindingScratch => ({
  gScores: new Float64Array(stateCount),
  parentStateKeys: new Int32Array(stateCount),
  seenGenerations: new Uint32Array(stateCount),
  closedGenerations: new Uint32Array(stateCount),
  generation: 0,
});

function getPathfindingScratch(stateCount: number): PathfindingScratch {
  // 異常に大きなマップの作業領域はアプリ存続中に保持し続けない。
  if (stateCount > MAX_SHARED_PATHFINDING_STATE_COUNT) {
    return createPathfindingScratch(stateCount);
  }
  if (
    !sharedPathfindingScratch ||
    sharedPathfindingScratch.gScores.length < stateCount
  ) {
    sharedPathfindingScratch = createPathfindingScratch(stateCount);
  }
  return sharedPathfindingScratch;
}

type CachedPathfindingContext = {
  cells: CellData[];
  cellSnapshots: {
    row: number;
    col: number;
    value: CellData["value"];
    backgroundColor: CellData["backgroundColor"];
  }[];
  maxRow: number;
  maxCol: number;
  context: PathfindingContext;
};

const pathfindingContextCache = new WeakMap<
  DayMapData,
  CachedPathfindingContext
>();

const snapshotPathfindingCells = (
  cells: CellData[],
): CachedPathfindingContext["cellSnapshots"] =>
  cells.map((cell) => ({
    row: cell.row,
    col: cell.col,
    value: cell.value,
    backgroundColor: cell.backgroundColor,
  }));

const haveSamePathfindingCells = (
  cells: CellData[],
  snapshots: CachedPathfindingContext["cellSnapshots"],
): boolean =>
  cells.length === snapshots.length &&
  cells.every((cell, index) => {
    const snapshot = snapshots[index];
    return (
      cell.row === snapshot.row &&
      cell.col === snapshot.col &&
      Object.is(cell.value, snapshot.value) &&
      cell.backgroundColor === snapshot.backgroundColor
    );
  });

function createPathfindingContext(mapData: DayMapData): PathfindingContext {
  const { maxRow, maxCol } = mapData;
  const passableCells = new Uint8Array(maxRow * maxCol);
  passableCells.fill(1);

  // 従来のMapと同様、同じ座標が複数ある場合は後のセルを優先する。
  for (const cell of mapData.cells) {
    if (
      cell.row < 1 ||
      cell.col < 1 ||
      cell.row > maxRow ||
      cell.col > maxCol
    ) {
      continue;
    }
    passableCells[(cell.row - 1) * maxCol + cell.col - 1] = isPassableCellData(
      cell,
    )
      ? 1
      : 0;
  }

  const maxSubRow = maxRow * SUB_CELL_RESOLUTION;
  const maxSubCol = maxCol * SUB_CELL_RESOLUTION;

  return {
    maxRow,
    maxCol,
    maxSubRow,
    maxSubCol,
    passableCells,
    bufferCosts: buildBufferCostGrid(passableCells, maxRow, maxCol),
    normalRouteCache: [],
    strictRouteCache: [],
  };
}

function getPathfindingContext(mapData: DayMapData): PathfindingContext {
  const cached = pathfindingContextCache.get(mapData);
  if (
    cached &&
    cached.cells === mapData.cells &&
    cached.maxRow === mapData.maxRow &&
    cached.maxCol === mapData.maxCol &&
    haveSamePathfindingCells(mapData.cells, cached.cellSnapshots)
  ) {
    return cached.context;
  }

  const context = createPathfindingContext(mapData);
  pathfindingContextCache.set(mapData, {
    cells: mapData.cells,
    cellSnapshots: snapshotPathfindingCells(mapData.cells),
    maxRow: mapData.maxRow,
    maxCol: mapData.maxCol,
    context,
  });
  return context;
}

// --- Binary Heap (優先度キュー) ---
interface HeapNode {
  sr: number;
  sc: number;
  g: number;
  f: number;
  dirDr: number; // この地点に到達した方向 (-1, 0, 1)
  dirDc: number; // この地点に到達した方向 (-1, 0, 1)
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
      [this.heap[idx], this.heap[parentIdx]] = [
        this.heap[parentIdx],
        this.heap[idx],
      ];
      idx = parentIdx;
    }
  }

  private sinkDown(idx: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < length && this.heap[left].f < this.heap[smallest].f)
        smallest = left;
      if (right < length && this.heap[right].f < this.heap[smallest].f)
        smallest = right;
      if (smallest === idx) break;
      [this.heap[idx], this.heap[smallest]] = [
        this.heap[smallest],
        this.heap[idx],
      ];
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
  { dr: -1, dc: 0, cost: 1 }, // 上
  { dr: 1, dc: 0, cost: 1 }, // 下
  { dr: 0, dc: -1, cost: 1 }, // 左
  { dr: 0, dc: 1, cost: 1 }, // 右
];

// サブセルグリッド上のA*探索（Theta*ライクなline-of-sight最適化付き）
export type PathfindingResult = {
  path: { row: number; col: number }[];
  usedFallback: boolean;
};

function findSubCellPath(
  context: PathfindingContext,
  scratch: PathfindingScratch,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  usedSubCells?: Uint32Array,
): PathfindingResult {
  const N = SUB_CELL_RESOLUTION;
  const { maxCol, maxSubRow, maxSubCol, passableCells, bufferCosts } = context;
  scratch.generation++;
  if (scratch.generation === 0xffffffff) {
    scratch.seenGenerations.fill(0);
    scratch.closedGenerations.fill(0);
    scratch.generation = 1;
  }
  const generation = scratch.generation;

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
    const zeroBasedRow = Math.floor(sr / N);
    const zeroBasedCol = Math.floor(sc / N);
    // スタートセル・ゴールセル内のサブセルは通過可能として扱う
    if (zeroBasedRow === startCellRow - 1 && zeroBasedCol === startCellCol - 1)
      return true;
    if (zeroBasedRow === goalCellRow - 1 && zeroBasedCol === goalCellCol - 1)
      return true;
    return passableCells[zeroBasedRow * maxCol + zeroBasedCol] === 1;
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

  const startDi = dirIndex(0, 0); // start: 方向なし
  const startStateKey = stateKey(start.sr, start.sc, startDi);

  scratch.gScores[startStateKey] = 0;
  scratch.parentStateKeys[startStateKey] = -1; // スタートは親なし
  scratch.seenGenerations[startStateKey] = generation;

  const openHeap = new BinaryHeap();
  const h0 = heuristic(start.sr, start.sc, goalSr, goalSc);
  openHeap.push({
    sr: start.sr,
    sc: start.sc,
    g: 0,
    f: h0,
    dirDr: 0,
    dirDc: 0,
  });

  const maxIterations = maxSubRow * maxSubCol * 5;
  let iterations = 0;

  while (openHeap.size > 0 && iterations < maxIterations) {
    iterations++;

    const current = openHeap.pop()!;
    const currentDi = dirIndex(current.dirDr, current.dirDc);
    const currentStateKey = stateKey(current.sr, current.sc, currentDi);

    // 既に処理済みならスキップ
    if (scratch.closedGenerations[currentStateKey] === generation) continue;
    scratch.closedGenerations[currentStateKey] = generation;

    // ゴール到達
    if (current.sr === goalSr && current.sc === goalSc) {
      // パスを再構築（stateKey → サブセル座標）
      const subPath: { sr: number; sc: number }[] = [];
      let key = currentStateKey;
      while (key !== -1) {
        const pos = stateKeyToPos(key);
        subPath.push(pos);
        key = scratch.parentStateKeys[key] ?? -1;
      }
      subPath.reverse();

      // 直交コリニアマージ: 同一方向の連続点を除去
      const optimized = mergeCollinearPoints(subPath);

      // 小数row/col座標に変換
      return {
        path: optimized.map((p) => subCellToFractional(p.sr, p.sc)),
        usedFallback: false,
      };
    }

    // 隣接ノードを探索
    for (const dir of DIRECTIONS) {
      const newSr = current.sr + dir.dr;
      const newSc = current.sc + dir.dc;
      const newDi = dirIndex(dir.dr, dir.dc);
      const newStateKey = stateKey(newSr, newSc, newDi);

      if (scratch.closedGenerations[newStateKey] === generation) continue;

      // 通過可否判定（スタートセル・ゴールセルは例外で通過可能）
      if (!isPassableOrException(newSr, newSc)) {
        continue;
      }

      // 移動コスト計算
      let moveCost = dir.cost;

      // ターンペナルティ（スタート地点以外で方向が変わった場合）
      const isTurn =
        (current.dirDr !== 0 || current.dirDc !== 0) &&
        (dir.dr !== current.dirDr || dir.dc !== current.dirDc);
      if (isTurn) {
        moveCost += TURN_PENALTY;
      }

      // バッファゾーンペナルティ（スタートセル・ゴールセルは除外）
      if (
        !(
          Math.floor(newSr / N) === startCellRow - 1 &&
          Math.floor(newSc / N) === startCellCol - 1
        ) &&
        !(
          Math.floor(newSr / N) === goalCellRow - 1 &&
          Math.floor(newSc / N) === goalCellCol - 1
        )
      ) {
        moveCost += bufferCosts[subKey(newSr, newSc)];
      }

      // 既存ルートとの重複ペナルティ
      if (usedSubCells) {
        const usageCount = usedSubCells[subKey(newSr, newSc)];
        if (usageCount > 0) {
          moveCost *= 1 + usageCount * OVERLAP_PENALTY;
        }
      }

      const newG = current.g + moveCost;
      const existingG =
        scratch.seenGenerations[newStateKey] === generation
          ? scratch.gScores[newStateKey]
          : undefined;

      if (existingG === undefined || newG < existingG) {
        scratch.gScores[newStateKey] = newG;
        scratch.parentStateKeys[newStateKey] = currentStateKey;
        scratch.seenGenerations[newStateKey] = generation;

        const newH = heuristic(newSr, newSc, goalSr, goalSc);
        openHeap.push({
          sr: newSr,
          sc: newSc,
          g: newG,
          f: newG + newH,
          dirDr: dir.dr,
          dirDc: dir.dc,
        });
      }
    }
  }

  // 経路が見つからない場合はL字で結ぶ（小数座標、直交ルーティング維持）
  return {
    path: [
      subCellToFractional(start.sr, start.sc),
      subCellToFractional(start.sr, goalSc),
      subCellToFractional(goalSr, goalSc),
    ],
    usedFallback: true,
  };
}

// 直交コリニアマージ: 同一方向の連続ポイントを除去し、曲がり角のみ残す
function mergeCollinearPoints(
  subPath: { sr: number; sc: number }[],
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
  usedSubCells: Uint32Array,
  maxSubCol: number,
): void {
  const N = SUB_CELL_RESOLUTION;

  const markPoint = (sr: number, sc: number) => {
    const key = sr * maxSubCol + sc;
    usedSubCells[key]++;
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
  const context = getPathfindingContext(mapData);
  const scratch = getPathfindingScratch(
    context.maxSubRow * context.maxSubCol * 5,
  );
  return findSubCellPath(context, scratch, startRow, startCol, endRow, endCol)
    .path;
}

export type RouteVisitPoint = {
  row: number;
  col: number;
  priorityLevel?: "none" | "priority" | "highest";
  itemId?: string;
  order?: number;
};

const ROUTE_CACHE_LIMIT = 4;

type RouteSegmentsCacheEntry = {
  visitPoints: RouteVisitPoint[];
  segments: RouteSegment[];
};

type StrictRouteSegmentsCacheEntry = RouteSegmentsCacheEntry & {
  ok: boolean;
  failedFromIndex?: number;
};

const snapshotRouteVisitPoints = (
  visitPoints: RouteVisitPoint[],
): RouteVisitPoint[] =>
  visitPoints.map(({ row, col, priorityLevel, itemId, order }) => ({
    row,
    col,
    priorityLevel,
    itemId,
    order,
  }));

const areEquivalentRouteVisitPoints = (
  first: RouteVisitPoint,
  second: RouteVisitPoint,
): boolean =>
  first.row === second.row &&
  first.col === second.col &&
  first.priorityLevel === second.priorityLevel &&
  first.itemId === second.itemId &&
  first.order === second.order;

const getCommonRoutePointPrefixLength = (
  first: RouteVisitPoint[],
  second: RouteVisitPoint[],
): number => {
  const limit = Math.min(first.length, second.length);
  let index = 0;
  while (
    index < limit &&
    areEquivalentRouteVisitPoints(first[index], second[index])
  ) {
    index++;
  }
  return index;
};

const cloneRouteSegments = (segments: RouteSegment[]): RouteSegment[] =>
  segments.map((segment) => ({
    ...segment,
    path: segment.path.map((point) => ({ ...point })),
  }));

const touchRouteCacheEntry = <T>(cache: T[], entryIndex: number): T => {
  const [entry] = cache.splice(entryIndex, 1);
  cache.push(entry);
  return entry;
};

const pushRouteCacheEntry = <T>(cache: T[], entry: T): void => {
  cache.push(entry);
  if (cache.length > ROUTE_CACHE_LIMIT) cache.shift();
};

const findExactRouteCacheEntry = <T extends RouteSegmentsCacheEntry>(
  cache: T[],
  visitPoints: RouteVisitPoint[],
): T | undefined => {
  for (let index = cache.length - 1; index >= 0; index--) {
    if (
      cache[index].visitPoints.length === visitPoints.length &&
      getCommonRoutePointPrefixLength(cache[index].visitPoints, visitPoints) ===
        visitPoints.length
    ) {
      return touchRouteCacheEntry(cache, index);
    }
  }
  return undefined;
};

const findBestPrefixRouteCacheEntry = <T extends RouteSegmentsCacheEntry>(
  cache: T[],
  visitPoints: RouteVisitPoint[],
  canReuse: (entry: T) => boolean,
): { entry: T; prefixLength: number } | undefined => {
  let best: { entry: T; entryIndex: number; prefixLength: number } | undefined;

  for (let index = cache.length - 1; index >= 0; index--) {
    const entry = cache[index];
    if (!canReuse(entry)) continue;
    const prefixLength = getCommonRoutePointPrefixLength(
      entry.visitPoints,
      visitPoints,
    );
    if (prefixLength > (best?.prefixLength ?? 1)) {
      best = { entry, entryIndex: index, prefixLength };
    }
  }

  if (!best) return undefined;
  touchRouteCacheEntry(cache, best.entryIndex);
  return { entry: best.entry, prefixLength: best.prefixLength };
};

export type GenerateRouteSegmentsResult =
  | { ok: true; segments: RouteSegment[] }
  | {
      ok: false;
      segments: RouteSegment[];
      failedSegment: {
        from: RouteVisitPoint;
        to: RouteVisitPoint;
        fromIndex: number;
      };
    };

export interface GenerateRouteSegmentsStrictOptions {
  pathConstraint?: RoutePathConstraint;
}

// 訪問先間のルートセグメントを生成（重複回避付き）
export function generateRouteSegments(
  mapData: DayMapData,
  visitPoints: RouteVisitPoint[],
): RouteSegment[] {
  if (visitPoints.length < 2) return [];

  const context = getPathfindingContext(mapData);
  const exactCacheEntry = findExactRouteCacheEntry(
    context.normalRouteCache,
    visitPoints,
  );
  if (exactCacheEntry) return cloneRouteSegments(exactCacheEntry.segments);

  const prefixCacheEntry = findBestPrefixRouteCacheEntry(
    context.normalRouteCache,
    visitPoints,
    () => true,
  );
  const reusableSegmentCount = prefixCacheEntry
    ? prefixCacheEntry.prefixLength - 1
    : 0;
  const segments = prefixCacheEntry
    ? cloneRouteSegments(
        prefixCacheEntry.entry.segments.slice(0, reusableSegmentCount),
      )
    : [];
  const usedSubCells = new Uint32Array(context.maxSubRow * context.maxSubCol);
  let scratch: PathfindingScratch | undefined;
  segments.forEach((segment) =>
    markPathSubCells(segment.path, usedSubCells, context.maxSubCol),
  );

  for (let i = reusableSegmentCount; i < visitPoints.length - 1; i++) {
    const from = visitPoints[i];
    const to = visitPoints[i + 1];
    scratch ??= getPathfindingScratch(
      context.maxSubRow * context.maxSubCol * 5,
    );

    const result = findSubCellPath(
      context,
      scratch,
      from.row,
      from.col,
      to.row,
      to.col,
      usedSubCells,
    );
    const path = result.path;

    // この経路のサブセルを使用済みとしてマーク
    markPathSubCells(path, usedSubCells, context.maxSubCol);

    segments.push({
      fromRow: from.row,
      fromCol: from.col,
      toRow: to.row,
      toCol: to.col,
      path,
      fromPriority: from.priorityLevel || "none",
      toPriority: to.priorityLevel || "none",
      fromItemId: from.itemId,
      toItemId: to.itemId,
      fromOrder: from.order,
      toOrder: to.order,
    });
  }

  pushRouteCacheEntry(context.normalRouteCache, {
    visitPoints: snapshotRouteVisitPoints(visitPoints),
    segments: cloneRouteSegments(segments),
  });
  return segments;
}

export function generateRouteSegmentsStrict(
  mapData: DayMapData,
  visitPoints: RouteVisitPoint[],
  options?: GenerateRouteSegmentsStrictOptions,
): GenerateRouteSegmentsResult {
  if (visitPoints.length < 2) return { ok: true, segments: [] };

  const context = getPathfindingContext(mapData);
  const canUseCache = options?.pathConstraint === undefined;
  const exactCacheEntry = canUseCache
    ? findExactRouteCacheEntry(context.strictRouteCache, visitPoints)
    : undefined;
  if (exactCacheEntry) {
    const segments = cloneRouteSegments(exactCacheEntry.segments);
    if (exactCacheEntry.ok) return { ok: true, segments };
    const failedFromIndex = exactCacheEntry.failedFromIndex ?? 0;
    return {
      ok: false,
      segments,
      failedSegment: {
        from: visitPoints[failedFromIndex],
        to: visitPoints[failedFromIndex + 1],
        fromIndex: failedFromIndex,
      },
    };
  }

  const prefixCacheEntry = canUseCache
    ? findBestPrefixRouteCacheEntry(
        context.strictRouteCache,
        visitPoints,
        (entry) => entry.ok,
      )
    : undefined;
  const reusableSegmentCount = prefixCacheEntry
    ? prefixCacheEntry.prefixLength - 1
    : 0;
  const segments = prefixCacheEntry
    ? cloneRouteSegments(
        prefixCacheEntry.entry.segments.slice(0, reusableSegmentCount),
      )
    : [];
  const usedSubCells = new Uint32Array(context.maxSubRow * context.maxSubCol);
  let scratch: PathfindingScratch | undefined;
  segments.forEach((segment) =>
    markPathSubCells(segment.path, usedSubCells, context.maxSubCol),
  );

  for (let i = reusableSegmentCount; i < visitPoints.length - 1; i++) {
    const from = visitPoints[i];
    const to = visitPoints[i + 1];
    scratch ??= getPathfindingScratch(
      context.maxSubRow * context.maxSubCol * 5,
    );
    const result = findSubCellPath(
      context,
      scratch,
      from.row,
      from.col,
      to.row,
      to.col,
      usedSubCells,
    );
    const path = result.path;

    if (
      result.usedFallback ||
      options?.pathConstraint?.isPathAllowed(path) === false
    ) {
      if (canUseCache) {
        pushRouteCacheEntry(context.strictRouteCache, {
          visitPoints: snapshotRouteVisitPoints(visitPoints),
          segments: cloneRouteSegments(segments),
          ok: false,
          failedFromIndex: i,
        });
      }
      return {
        ok: false,
        segments,
        failedSegment: { from, to, fromIndex: i },
      };
    }

    markPathSubCells(path, usedSubCells, context.maxSubCol);
    segments.push({
      fromRow: from.row,
      fromCol: from.col,
      toRow: to.row,
      toCol: to.col,
      path,
      fromPriority: from.priorityLevel || "none",
      toPriority: to.priorityLevel || "none",
      fromItemId: from.itemId,
      toItemId: to.itemId,
      fromOrder: from.order,
      toOrder: to.order,
    });
  }

  if (canUseCache) {
    pushRouteCacheEntry(context.strictRouteCache, {
      visitPoints: snapshotRouteVisitPoints(visitPoints),
      segments: cloneRouteSegments(segments),
      ok: true,
    });
  }
  return { ok: true, segments };
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
    return (
      Math.abs(p.row - prev.row) < 0.01 || Math.abs(p.col - prev.col) < 0.01
    );
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

  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)),
  );

  const nearestX = x1 + t * dx;
  const nearestY = y1 + t * dy;

  return Math.sqrt((px - nearestX) ** 2 + (py - nearestY) ** 2);
}
