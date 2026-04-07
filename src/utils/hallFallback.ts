import type { HallDefinition } from '../types';

/**
 * ブロック名を正規化（trim + NFKC + lowercase）
 */
function normalizeBlockName(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

/**
 * ブロック名によるホール判定フォールバック。
 * ホールの `blockNames` に `blockName` が含まれるホールを検索する。
 * - 1件一致 → そのホールID
 * - 複数一致 → null（曖昧のため手動設定が必要）
 * - 0件 → null
 */
export function resolveHallByBlockName(
  blockName: string | undefined,
  halls: HallDefinition[],
): string | null {
  if (!blockName) return null;
  const normalized = normalizeBlockName(blockName);
  const matches = halls.filter((h) =>
    h.blockNames?.some((b) => normalizeBlockName(b) === normalized),
  );
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * ブロック名に一致するホールIDのリストを返す（曖昧な場合の候補列挙用）。
 */
export function findHallsByBlockName(
  blockName: string | undefined,
  halls: HallDefinition[],
): HallDefinition[] {
  if (!blockName) return [];
  const normalized = normalizeBlockName(blockName);
  return halls.filter((h) =>
    h.blockNames?.some((b) => normalizeBlockName(b) === normalized),
  );
}

/**
 * 手動ホール設定（`item.manualHallId`）が指定ホール一覧に存在する場合のみ返す。
 */
export function resolveManualHallId(
  manualHallId: string | undefined,
  halls: HallDefinition[],
): string | null {
  if (!manualHallId) return null;
  return halls.some((h) => h.id === manualHallId) ? manualHallId : null;
}
