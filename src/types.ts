export const PurchaseStatuses = [
  'None',
  'Purchased',
  'SoldOut',
  'Absent',
  'Postpone',
  'Late',
] as const;

export type PurchaseStatus = typeof PurchaseStatuses[number];

export interface ShoppingItem {
  id: string;
  circle: string;
  eventDate: string;
  block: string;
  number: string;
  title: string;
  price: number;
  purchaseStatus: PurchaseStatus;
  remarks: string;
}

// スプレッドシートURL情報を保存
export interface EventMetadata {
  spreadsheetUrl?: string;
  spreadsheetSheetName?: string;
  lastImportDate?: string;
}

// 編集モード/実行モードの状態
export type ViewMode = 'edit' | 'execute';

// 日別のモード状態
export interface DayModeState {
  day1: ViewMode;
  day2: ViewMode;
}

// 日別の実行モード用アイテムID配列
export interface ExecuteModeItems {
  day1: string[]; // 左列に配置されたアイテムのIDリスト
  day2: string[];
}
