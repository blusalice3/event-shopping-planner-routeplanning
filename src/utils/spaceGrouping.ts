/**
 * スペース（ブース）単位のグループ化ユーティリティ
 *
 * スペースとは block + baseNumber で識別される同一ブースを指す。
 * 例: block="A", number="01a" → spaceKey="A-01a"
 *     block="A", number="01a2" → spaceKey="A-01a" （同じスペース）
 *     block="A", number="01b"  → spaceKey="A-01b" （別スペース）
 */

/**
 * ブース番号から末尾の追加数字を除去してベース番号を返す。
 * "01a" → "01a", "01a2" → "01a", "15c3" → "15c"
 * アルファベットを含まない場合はそのまま返す。
 */
export function getBaseNumber(number: string): string {
  const match = number.match(/^(\d+[a-zA-Z]+)\d*$/);
  return match ? match[1] : number;
}

/**
 * アイテムの block と number からスペースキーを生成する。
 * "A" + "01a" → "A-01a"
 */
export function getSpaceKey(block: string, number: string): string {
  return `${block}-${getBaseNumber(number)}`;
}
