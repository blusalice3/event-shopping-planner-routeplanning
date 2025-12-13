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

// ===== マップ機能用の型定義 =====

export interface BorderStyle {
  style: 'thin' | 'medium' | 'thick' | 'double' | 'none';
  color: string;
}

export interface CellBorders {
  top: BorderStyle | null;
  right: BorderStyle | null;
  bottom: BorderStyle | null;
  left: BorderStyle | null;
}

export interface CellData {
  row: number;
  col: number;
  value: string | number | null;
  backgroundColor: string | null;
  borders: CellBorders;
  isMerged?: boolean;
  mergeParent?: { row: number; col: number };
}

export interface MergedCellInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  value: string | number | null;
}

export interface NumberCellInfo {
  row: number;
  col: number;
  value: number;
}

// 壁ブロック用のセル群定義
export interface CellGroup {
  type: 'range' | 'individual';  // range: 2セル間の範囲, individual: 個別セル指定
  // rangeタイプ用
  startRow?: number;
  startCol?: number;
  endRow?: number;
  endCol?: number;
  // individualタイプ用
  cells?: { row: number; col: number }[];
}

export interface BlockDefinition {
  name: string;
  // 通常ブロック用（4セル指定）
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  numberCells: NumberCellInfo[];
  color?: string;
  id?: string;
  isAutoDetected?: boolean;
  // 壁ブロック用
  isWallBlock?: boolean;
  cellGroups?: CellGroup[];  // 最大6群
}

export interface DayMapData {
  sheetName?: string;
  rows?: number;
  cols?: number;
  maxRow: number;
  maxCol: number;
  cells: CellData[];
  mergedCells: MergedCellInfo[];
  blocks: BlockDefinition[];
}

export interface MapDataStore {
  [eventName: string]: {
    [dayMapName: string]: DayMapData;
  };
}

export interface BlockDefinitionsStore {
  [eventName: string]: {
    [dayMapName: string]: BlockDefinition[];
  };
}

export interface VisitPoint {
  row: number;
  col: number;
  blockName: string;
  number: number;
  order: number;
  itemIds: string[];
}

export interface RouteSettings {
  isRouteVisible: boolean;
  visitOrder: VisitPoint[];
}

export interface RouteSettingsStore {
  [eventName: string]: {
    [dayMapName: string]: RouteSettings;
  };
}

// ===== エクスポート機能用の型定義 =====

export interface ExportOptions {
  includeItems: boolean;
  includeLayoutInfo: boolean;
  includeMapData: boolean;
  includeBlockDefinitions: boolean;
  includeRouteInfo: boolean;
  format: 'full' | 'simple';
}

export interface ExportData {
  version: string;
  exportDate: string;
  eventName: string;
  metadata: EventMetadata;
  items: ShoppingItem[];
  dayModes: DayModeState;
  executeModeItems: ExecuteModeItems;
  mapData?: {
    [dayMapName: string]: DayMapData;
  };
  blockDefinitions?: {
    [dayMapName: string]: BlockDefinition[];
  };
  routeSettings?: {
    [dayMapName: string]: RouteSettings;
  };
}

// マップセルの状態（詳細版）
export interface MapCellStateDetail {
  hasItems: boolean;
  itemCount: number;
  isVisited: boolean;
  isFullyVisited: boolean;
  items: ShoppingItem[];
}

// マップセルの状態（シンプル版、後方互換用）
export type MapCellState = 'default' | 'hasItems' | 'partialVisit' | 'allVisit' | MapCellStateDetail;

// マップ表示用のセル情報
export interface MapDisplayCell {
  row: number;
  col: number;
  value: string | number | null;
  backgroundColor: string | null;
  borders: CellBorders;
  width: number;
  height: number;
  isBlockName: boolean;
  isMerged: boolean;
  mergeWidth: number;
  mergeHeight: number;
  state: MapCellState;
  matchingItemIds: string[];
}

// 経路探索用のノード
export interface PathNode {
  row: number;
  col: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
}

// ルート描画用のセグメント
export interface RouteSegment {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  path: { row: number; col: number }[];
}

// ズームレベル
export type ZoomLevel = 30 | 50 | 75 | 100 | 125 | 150;

export const ZOOM_LEVELS: ZoomLevel[] = [30, 50, 75, 100, 125, 150];
