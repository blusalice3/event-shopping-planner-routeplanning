export const PurchaseStatuses = [
  'None',
  'Purchased',
  'SoldOut',
  'Absent',
  'Postpone',
  'Late',
  'LimitedPurchase',
] as const;

export type PurchaseStatus = (typeof PurchaseStatuses)[number];

export const ProtectionLevels = ['full', 'deletable', 'none'] as const;
export type ProtectionLevel = (typeof ProtectionLevels)[number];

export const ItemSources = ['spreadsheet', 'app'] as const;
export type ItemSource = (typeof ItemSources)[number];

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
  priorityLevel?: 'none' | 'priority' | 'highest';
  protectionLevel?: ProtectionLevel;
  source?: ItemSource;
  assignedTo?: string;
  lastSyncedAt?: string;
  orderIndex?: number;
  postponed?: boolean;
  manualHallId?: string;
}

export type ViewMode = 'edit' | 'execute' | 'focus';

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
