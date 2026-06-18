import type { ShoppingItem } from './item';

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
  fontColor?: string | null;
  borders: CellBorders;
  isMerged?: boolean;
  mergeParent?: { row: number; col: number };
  isVerticalText?: boolean;
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

export interface CellGroup {
  type: 'range' | 'individual';
  startRow?: number;
  startCol?: number;
  endRow?: number;
  endCol?: number;
  cells?: { row: number; col: number }[];
}

export type NumberCellOutlineStyle = 'rounded' | 'square' | 'none' | 'dashed';

export interface BlockDefinition {
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  numberCells: NumberCellInfo[];
  nameCells?: { row: number; col: number }[];
  color?: string;
  id?: string;
  isAutoDetected?: boolean;
  isWallBlock?: boolean;
  cellGroups?: CellGroup[];
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

export interface MapViewportState {
  zoomLevel: number;
  offsetX: number;
  offsetY: number;
}

export interface MapViewportSettingsStore {
  [eventName: string]: {
    [dayMapName: string]: MapViewportState;
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

export interface BlockDetectionSettings {
  maxBlockNameLength: number;
  allowedCharTypes: {
    katakana: boolean;
    hiragana: boolean;
    alphabet: boolean;
    kanji: boolean;
    digit: boolean;
    symbol: boolean;
  };
  allowDigitSymbolOnly: boolean;
  minNumberCellsPerBlock: number;
  minMergedCellCount: number;
  numberCellMin: number;
  numberCellMax: number;
  maxRegionSize: number;
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

export interface MapCellStateDetail {
  hasItems: boolean;
  itemCount: number;
  isVisited: boolean;
  isFullyVisited: boolean;
  items: ShoppingItem[];
  hasPriorityItem: boolean;
  hasPriorityUnvisited: boolean;
  hasWarningRemarksUnvisited: boolean;
  hasPriorityLevel: boolean;
  hasHighestPriorityLevel: boolean;
}

export type MapCellState =
  | 'default'
  | 'hasItems'
  | 'partialVisit'
  | 'allVisit'
  | MapCellStateDetail;

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

export interface PathNode {
  row: number;
  col: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
}

export interface RouteSegment {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  path: { row: number; col: number }[];
  fromPriority?: 'none' | 'priority' | 'highest';
  toPriority?: 'none' | 'priority' | 'highest';
  fromItemId?: string;
  toItemId?: string;
  fromOrder?: number;
  toOrder?: number;
}

export interface RoutePathConstraint {
  isPathAllowed: (path: { row: number; col: number }[]) => boolean;
}

export type ZoomLevel = number;

export const ZOOM_LEVELS: number[] = [15, 30, 50, 75, 100, 125, 150];

export const MIN_ZOOM = 15;
export const MAX_ZOOM = 200;

export const MAPLESS_HALL_KEY = '__mapless__';

export function getMaplessKey(eventDate: string): string {
  return `${MAPLESS_HALL_KEY}:${eventDate}`;
}

export interface HallDefinition {
  id: string;
  name: string;
  vertices: { row: number; col: number }[];
  color?: string;
  blockNames?: string[];
}

export interface HallVisitList {
  hallId: string;
  itemIds: string[];
}

export interface HallRouteSettings {
  hallOrder: string[];
  hallVisitLists: HallVisitList[];
}

export interface HallDefinitionsStore {
  [eventName: string]: {
    [dayMapName: string]: HallDefinition[];
  };
}

export interface HallRouteSettingsStore {
  [eventName: string]: {
    [dayMapName: string]: HallRouteSettings;
  };
}
