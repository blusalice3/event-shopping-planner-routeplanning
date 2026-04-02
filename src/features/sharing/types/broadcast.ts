/** ブロードキャストイベントのレジストリ */
export interface BroadcastEventMap {
  'member:position': MemberPositionPayload;
  'member:stamp': MemberStampPayload;
  'member:heading': MemberHeadingPayload;
}

export type BroadcastEventName = keyof BroadcastEventMap;

/** B-6: メンバーのマップ上位置 */
export interface MemberPositionPayload {
  senderId: string;
  senderName: string;
  senderColor: string;
  hallId: string;
  block: string;
  number: string;
  x?: number;
  y?: number;
  timestamp: number;
}

/** B-8: クイックスタンプ */
export interface MemberStampPayload {
  senderId: string;
  senderName: string;
  emoji: string;
  targetCircle?: string;
  timestamp: number;
}

/** 「向かっている」通知 */
export interface MemberHeadingPayload {
  senderId: string;
  senderName: string;
  senderColor: string;
  targetCircle: string;
  targetHallId: string;
  targetBlock: string;
  targetNumber: string;
  timestamp: number;
}
