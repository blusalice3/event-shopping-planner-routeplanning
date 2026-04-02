/**
 * 5文字の英数字ルームコードを生成する。
 * 読み間違えやすい文字（I, O, 0, 1）を除外。
 */

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

export function generateRoomCode(): string {
  const values = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[values[i] % CHARSET.length];
  }
  return code;
}
