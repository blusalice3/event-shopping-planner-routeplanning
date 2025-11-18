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
  remarks: string;
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
