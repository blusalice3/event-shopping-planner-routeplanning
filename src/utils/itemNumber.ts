/**
 * アイテム番号ユーティリティ
 */

/**
 * アイテムの番号から数値部分を抽出
 * 例: "26a" -> "26", "26b1" -> "26"
 */
export function extractNumberFromItemNumber(itemNumber: string): string | null {
  const match = itemNumber.match(/^(\d+)/);
  return match ? match[1] : null;
}

/**
 * アイテムの番号から「数字+アルファベット」のプレフィックスを抽出
 * 末尾の数字は無視する
 * 例: "14b" -> "14b", "14b1" -> "14b", "26a3" -> "26a"
 * 数字のみ（例: "14"）の場合は null を返す
 */
export function extractNumberAlphaPrefix(itemNumber: string): string | null {
  const match = itemNumber.match(/^(\d+[a-zA-Z]+)/);
  return match ? match[1].toLowerCase() : null;
}
