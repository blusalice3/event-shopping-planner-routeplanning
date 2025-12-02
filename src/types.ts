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
  price: number | null;
  purchaseStatus: PurchaseStatus;
  quantity: number;
  remarks: string;
  url?: string;
}

export type ViewMode = 'edit' | 'execute';

export interface EventMetadata {
  spreadsheetUrl: string;
  spreadsheetSheetName: string;
  lastImportDate: string;
}

export interface DayModeState {
  [eventDate: string]: ViewMode;
}

export interface ExecuteModeItems {
  [eventDate: string]: string[];
}

export interface CellInfo {
  value: any;
  isNumber: boolean;
  row: number;
  col: number;
  isMerged?: boolean;
  mergeInfo?: {
    r: number;
    c: number;
    rs: number;
    cs: number;
  };
  width?: number;
  height?: number;
  style?: {
    font?: {
      name?: string;
      sz?: number;
      bold?: boolean;
      italic?: boolean;
      color?: string;
    };
    fill?: {
      fgColor?: string;
      bgColor?: string;
    };
    border?: {
      top?: { style?: string; color?: string };
      bottom?: { style?: string; color?: string };
      left?: { style?: string; color?: string };
      right?: { style?: string; color?: string };
    };
    alignment?: {
      horizontal?: string;
      vertical?: string;
    };
  };
}

export interface MapData {
  [eventDate: string]: CellInfo[][]; // マップデータはセル情報の2次元配列として保存
}

export interface EventMapData {
  [eventName: string]: MapData;
}
