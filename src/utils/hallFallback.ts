import type { HallDefinition } from '../types/map';

/**
 * ブロック名を正規化（trim + NFKC）。
 * 大小文字は区別する (例: "E" と "e" は別ブロック扱い)。
 */
export function normalizeBlockName(name: string): string {
  return name.trim().normalize('NFKC');
}

/**
 * 同一 id のホールを排除（先に現れたものを優先）。
 */
function dedupeHallsById(halls: HallDefinition[]): HallDefinition[] {
  const seen = new Set<string>();
  const result: HallDefinition[] = [];
  for (const h of halls) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    result.push(h);
  }
  return result;
}

/**
 * ブロック名によるホール判定フォールバック。
 * ホールの `blockNames` に `blockName` が含まれるホールを検索する。
 * - 1件以上一致 → 最初に見つかったホールID
 * - 0件 → null
 * 入力ホールは id で dedupe するため、過去の不整合データで同一ホールが
 * 複数キーに存在しても安全に解決できる。
 */
export function resolveHallByBlockName(
  blockName: string | undefined,
  halls: HallDefinition[],
): string | null {
  if (!blockName) return null;
  const normalized = normalizeBlockName(blockName);
  const deduped = dedupeHallsById(halls);
  const matches = deduped.filter((h) =>
    h.blockNames?.some((b) => normalizeBlockName(b) === normalized),
  );
  return matches.length > 0 ? matches[0].id : null;
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
  return dedupeHallsById(halls).filter((h) =>
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
