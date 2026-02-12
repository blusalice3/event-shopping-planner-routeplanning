export const PurchaseStatuses = [
  'None',
  'Purchased',
  'SoldOut',
  'Absent',
  'Postpone',
  'Late',
] as const;

export type PurchaseStatus = (typeof PurchaseStatuses)[number];

// 保護レベル
export const ProtectionLevels = ['full', 'deletable', 'none'] as const;
export type ProtectionLevel = (typeof ProtectionLevels)[number];

// アイテムの追加元
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
  priorityLevel?: 'none' | 'priority' | 'highest'; // 優先度レベル
  protectionLevel?: ProtectionLevel; // 保護レベル（未設定の場合はsourceに基づくデフォルト）
  source?: ItemSource; // アイテムの追加元（未設定の場合は'spreadsheet'として扱う）
}

export type ViewMode = 'edit' | 'execute' | 'focus';

export type FocusPhase = 'normal' | 'postponed' | 'late';

export interface FocusModeSessionState {
  phase: FocusPhase;
  phaseIndex: number;
  savedPhaseIndices: Record<FocusPhase, number>;
  postponedItemIds: string[];
  lateItemIds: string[];
  isCompleted: boolean;
}

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
  fontColor?: string | null; // フォント色（Excelから抽出）
  borders: CellBorders;
  isMerged?: boolean;
  mergeParent?: { row: number; col: number };
  isVerticalText?: boolean; // 縦書きかどうか
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
  type: 'range' | 'individual'; // range: 2セル間の範囲, individual: 個別セル指定
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
  /** ブロック名が記載されているセルの座標一覧 */
  nameCells?: { row: number; col: number }[];
  color?: string;
  id?: string;
  isAutoDetected?: boolean;
  // 壁ブロック用
  isWallBlock?: boolean;
  cellGroups?: CellGroup[]; // 最大6群
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

export interface DayMapRotationState {
  initialAngle: number;
  mapTabAngle: number;
  focusModeAngle: number;
}

export interface MapRotationSettingsStore {
  [eventName: string]: {
    [dayMapName: string]: DayMapRotationState;
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

// ===== ブロック自動検出設定 =====

export interface BlockDetectionSettings {
  /** ブロック名の最大文字数 (default: 4) */
  maxBlockNameLength: number;
  /** ブロック名の許可文字種 */
  allowedCharTypes: {
    katakana: boolean;
    hiragana: boolean;
    alphabet: boolean;
    kanji: boolean;
    digit: boolean;
    symbol: boolean;
  };
  /** 数字+記号のみのブロック名を許可する (default: false) */
  allowDigitSymbolOnly: boolean;
  /** 1ブロックあたりの最小ブース番号数 (default: 1) */
  minNumberCellsPerBlock: number;
  /** ブロック名セルの最小結合セル数 (default: 4) */
  minMergedCellCount: number;
  /** 数値セル（ブース番号）の最小値 (default: 1) */
  numberCellMin: number;
  /** 数値セル（ブース番号）の最大値 (default: 100) */
  numberCellMax: number;
  /** 1領域の最大セル数 (default: 2000) */
  maxRegionSize: number;
  /** 多角形判定の閾値パーセント (default: 95) */
  polygonThreshold: number;
}

export const DEFAULT_BLOCK_DETECTION_SETTINGS: BlockDetectionSettings = {
  maxBlockNameLength: 4,
  allowedCharTypes: {
    katakana: true,
    hiragana: true,
    alphabet: true,
    kanji: true,
    digit: true,
    symbol: false,
  },
  allowDigitSymbolOnly: false,
  minNumberCellsPerBlock: 1,
  minMergedCellCount: 4,
  numberCellMin: 1,
  numberCellMax: 100,
  maxRegionSize: 2000,
  polygonThreshold: 95,
};

export interface BlockDetectionSettingsStore {
  [eventName: string]: BlockDetectionSettings;
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
  hasPriorityItem: boolean; // 「優先」「委託無」のアイテムがあるか
  hasPriorityUnvisited: boolean; // 未訪問の優先アイテムがあるか
}

// マップセルの状態（シンプル版、後方互換用）
export type MapCellState =
  | 'default'
  | 'hasItems'
  | 'partialVisit'
  | 'allVisit'
  | MapCellStateDetail;

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
  fromPriority?: 'none' | 'priority' | 'highest'; // 出発点の優先度
  toPriority?: 'none' | 'priority' | 'highest'; // 到着点の優先度
}

// ズームレベル
export type ZoomLevel = number;

export const ZOOM_LEVELS: number[] = [30, 50, 75, 100, 125, 150];

export const MIN_ZOOM = 30;
export const MAX_ZOOM = 200;

// ===== ホール（表示エリア）定義用の型 =====

// ホール定義（多角形エリア）
export interface HallDefinition {
  id: string;
  name: string;
  // 頂点座標（クリック順に結ぶ、4-6個）
  vertices: { row: number; col: number }[];
  color?: string;
}

// ホールごとの訪問先リスト
export interface HallVisitList {
  hallId: string;
  itemIds: string[]; // 訪問順に並んだアイテムID
}

// ホール間移動順序を含むルート設定（拡張版）
export interface HallRouteSettings {
  hallOrder: string[]; // ホールIDの訪問順序
  hallVisitLists: HallVisitList[]; // 各ホールの訪問先リスト
}

// ホール定義のストア
export interface HallDefinitionsStore {
  [eventName: string]: {
    [dayMapName: string]: HallDefinition[];
  };
}

// ホールルート設定のストア
export interface HallRouteSettingsStore {
  [eventName: string]: {
    [dayMapName: string]: HallRouteSettings;
  };
}
