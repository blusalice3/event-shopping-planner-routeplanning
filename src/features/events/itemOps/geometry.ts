import type { DayMapData, HallDefinition } from '../../../types/map';
import type { ShoppingItem } from '../../../types/item';
import { resolveHallByBlockName, resolveManualHallId } from '../../../utils/hallFallback';
import { findRouteLookupNumberCell } from '../../../utils/mapRoutingSignature';

function isPointInPoly(
  row: number,
  col: number,
  vertices: { row: number; col: number }[],
): boolean {
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
}

/**
 * アイテムが属するホールIDを返す。
 * block中心座標とホールポリゴンで判定する。
 */
export function findItemHallId(
  item: ShoppingItem,
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
): string | null {
  // 1. 手動ホール設定が有効なら最優先
  const manual = resolveManualHallId(item.manualHallId, halls);
  if (manual) return manual;

  // 2. 既存のポリゴン判定
  if (mapData && halls.length > 0) {
    const blockName = item.block?.trim() || '';
    const block = mapData.blocks.find((b) => b.name === blockName);
    if (block) {
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;

      for (const hall of halls) {
        if (hall.vertices.length >= 4 && isPointInPoly(centerRow, centerCol, hall.vertices)) {
          return hall.id;
        }
      }
    }
  }

  // 3. blockNames フォールバック
  return resolveHallByBlockName(item.block, halls);
}

/**
 * アイテムが属するホールIDを返す（numberセルベース、優先度変更用）。
 * セルの正確な位置を使い、頂点一致もチェックする。
 */
export function findItemHallIdByCell(
  item: ShoppingItem,
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
): string | null {
  // 1. 手動ホール設定が有効なら最優先
  const manual = resolveManualHallId(item.manualHallId, halls);
  if (manual) return manual;

  // 2. 既存のnumberセル位置によるポリゴン判定
  if (mapData && halls.length > 0) {
    const block = mapData.blocks.find((b) => b.name === item.block);
    if (block) {
      const numMatch = item.number?.match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0], 10);
        const cell = findRouteLookupNumberCell(block, num);
        if (cell) {
          for (const hall of halls) {
            if (isPointInPoly(cell.row, cell.col, hall.vertices)) {
              return hall.id;
            }
            for (const vertex of hall.vertices) {
              if (vertex.row === cell.row && vertex.col === cell.col) {
                return hall.id;
              }
            }
          }
        }
      }
    }
  }

  // 3. blockNames フォールバック
  return resolveHallByBlockName(item.block, halls);
}

// ────────────────────────────────────────────────
// 1. computeUpdateItem
// ────────────────────────────────────────────────
