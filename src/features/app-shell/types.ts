import type { ViewMode } from '../../types/item';

export type ActiveTab = 'eventList' | 'import' | string;
export type SortState =
  | 'Manual'
  | 'Postpone'
  | 'Late'
  | 'Absent'
  | 'SoldOut'
  | 'None'
  | 'Purchased';
export type BulkSortDirection = 'asc' | 'desc';
export type BlockSortDirection = 'asc' | 'desc';
export type LayoutMode = 'pc' | 'smartphone';
export type SmartInsertMode = 'card' | 'preview';
export type ColumnType = 'execute' | 'candidate';

export type CellPosition = { row: number; col: number };
export type CellSelectionType = 'corner' | 'multiCorner' | 'rangeStart' | 'individual';

export type CellSelectionMode = {
  type: CellSelectionType;
  clickedCells: CellPosition[];
  editingBlockData?: unknown;
} | null;

export type PendingCellSelection = {
  type: string;
  cells: CellPosition[];
  editingData?: unknown;
} | null;

export type VertexSelectionMode = {
  clickedVertices: CellPosition[];
  editingData?: unknown;
} | null;

export type PendingVertexSelection = {
  vertices: CellPosition[];
  editingData?: unknown;
} | null;

export type VertexGuideOptions = {
  showGrid: boolean;
  showRuler: boolean;
};

export type MapTabMenuPosition = {
  left: number;
  top: number;
};

export type RangeSelectionState = {
  itemId: string;
  columnType: ColumnType;
  sourceType?: 'item' | 'spaceHeader';
} | null;

export type AppViewMode = ViewMode;
