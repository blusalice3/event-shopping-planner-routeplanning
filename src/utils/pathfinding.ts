import { CellData, PathNode, RouteSegment, DayMapData } from '../types';

// セルが通過可能かどうかを判定
function isPassableCell(
  cellsMap: Map<string, CellData>,
  row: number,
  col: number,
  maxRow: number,
  maxCol: number,
  blockNameCells: Set<string>
): boolean {
  if (row < 1 || col < 1 || row > maxRow || col > maxCol) return false;
  
  const key = `${row}-${col}`;
  const cell = cellsMap.get(key);
  
  // セルが存在しない場合は通過可能
  if (!cell) return true;
  
  // ブロック名セルは通過可能
  if (blockNameCells.has(key)) return true;
  
  // 数値セルは通過不可
  if (cell.value !== null && typeof cell.value === 'number') return false;
  if (cell.value !== null && /^\d+$/.test(String(cell.value))) return false;
  
  // 塗りつぶしセルは通過不可
  if (cell.backgroundColor && cell.backgroundColor !== '#FFFFFF') return false;
  
  return true;
}

// マンハッタン距離を計算
function heuristic(
  row1: number,
  col1: number,
  row2: number,
  col2: number
): number {
  return Math.abs(row1 - row2) + Math.abs(col1 - col2);
}

// A*アルゴリズムで経路を探索
export function findPath(
  mapData: DayMapData,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  blockNameCells: Set<string>
): { row: number; col: number }[] {
  const { rows: maxRow, cols: maxCol, cells } = mapData;
  
  // セルマップを作成
  const cellsMap = new Map<string, CellData>();
  cells.forEach((cell) => {
    cellsMap.set(`${cell.row}-${cell.col}`, cell);
  });
  
  // オープンリストとクローズドリスト
  const openList: PathNode[] = [];
  const closedSet = new Set<string>();
  
  // スタートノード
  const startNode: PathNode = {
    row: startRow,
    col: startCol,
    g: 0,
    h: heuristic(startRow, startCol, endRow, endCol),
    f: heuristic(startRow, startCol, endRow, endCol),
    parent: null,
  };
  
  openList.push(startNode);
  
  // 方向（上下左右 + 斜め）
  const directions = [
    { dr: -1, dc: 0, cost: 1 },   // 上
    { dr: 1, dc: 0, cost: 1 },    // 下
    { dr: 0, dc: -1, cost: 1 },   // 左
    { dr: 0, dc: 1, cost: 1 },    // 右
    { dr: -1, dc: -1, cost: 1.4 }, // 左上
    { dr: -1, dc: 1, cost: 1.4 },  // 右上
    { dr: 1, dc: -1, cost: 1.4 },  // 左下
    { dr: 1, dc: 1, cost: 1.4 },   // 右下
  ];
  
  const maxIterations = maxRow * maxCol * 2; // 無限ループ防止
  let iterations = 0;
  
  while (openList.length > 0 && iterations < maxIterations) {
    iterations++;
    
    // f値が最小のノードを取得
    openList.sort((a, b) => a.f - b.f);
    const currentNode = openList.shift()!;
    
    const currentKey = `${currentNode.row}-${currentNode.col}`;
    
    // ゴールに到達
    if (currentNode.row === endRow && currentNode.col === endCol) {
      // パスを再構築
      const path: { row: number; col: number }[] = [];
      let node: PathNode | null = currentNode;
      while (node) {
        path.unshift({ row: node.row, col: node.col });
        node = node.parent;
      }
      return path;
    }
    
    closedSet.add(currentKey);
    
    // 隣接ノードを探索
    for (const dir of directions) {
      const newRow = currentNode.row + dir.dr;
      const newCol = currentNode.col + dir.dc;
      const newKey = `${newRow}-${newCol}`;
      
      // 既に処理済みの場合はスキップ
      if (closedSet.has(newKey)) continue;
      
      // 通過不可能なセルはスキップ（ただしゴールセルは例外）
      const isGoal = newRow === endRow && newCol === endCol;
      if (!isGoal && !isPassableCell(cellsMap, newRow, newCol, maxRow, maxCol, blockNameCells)) {
        continue;
      }
      
      // 斜め移動の場合、両隣のセルが通過可能かチェック
      if (Math.abs(dir.dr) === 1 && Math.abs(dir.dc) === 1) {
        const side1Passable = isPassableCell(
          cellsMap, currentNode.row + dir.dr, currentNode.col, maxRow, maxCol, blockNameCells
        );
        const side2Passable = isPassableCell(
          cellsMap, currentNode.row, currentNode.col + dir.dc, maxRow, maxCol, blockNameCells
        );
        if (!side1Passable || !side2Passable) continue;
      }
      
      const g = currentNode.g + dir.cost;
      const h = heuristic(newRow, newCol, endRow, endCol);
      const f = g + h;
      
      // 既にオープンリストにあるか確認
      const existingIndex = openList.findIndex(
        (n) => n.row === newRow && n.col === newCol
      );
      
      if (existingIndex !== -1) {
        // より良い経路が見つかった場合は更新
        if (g < openList[existingIndex].g) {
          openList[existingIndex] = {
            row: newRow,
            col: newCol,
            g,
            h,
            f,
            parent: currentNode,
          };
        }
      } else {
        // 新しいノードを追加
        openList.push({
          row: newRow,
          col: newCol,
          g,
          h,
          f,
          parent: currentNode,
        });
      }
    }
  }
  
  // 経路が見つからない場合は直線で結ぶ
  return [
    { row: startRow, col: startCol },
    { row: endRow, col: endCol },
  ];
}

// 訪問先間のルートセグメントを生成
export function generateRouteSegments(
  mapData: DayMapData,
  visitPoints: { row: number; col: number }[],
  blockNameCells: Set<string>
): RouteSegment[] {
  if (visitPoints.length < 2) return [];
  
  const segments: RouteSegment[] = [];
  
  for (let i = 0; i < visitPoints.length - 1; i++) {
    const from = visitPoints[i];
    const to = visitPoints[i + 1];
    
    const path = findPath(
      mapData,
      from.row,
      from.col,
      to.row,
      to.col,
      blockNameCells
    );
    
    segments.push({
      fromRow: from.row,
      fromCol: from.col,
      toRow: to.row,
      toCol: to.col,
      path,
    });
  }
  
  return segments;
}

// 経路を簡略化（Douglas-Peuckerアルゴリズムベース）
export function simplifyPath(
  path: { row: number; col: number }[],
  tolerance: number = 0.5
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
      end.col
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
  y2: number
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
