import * as XLSX from 'xlsx';
import { ShoppingItem, MapData, MapCell, BlockInfo, RoutePlanningData } from '../types';

export interface ExcelImportResult {
  items: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[];
  mapData: MapData[];
  routePlanningData?: RoutePlanningData;
}

export async function importExcelFile(file: File): Promise<ExcelImportResult> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { 
    type: 'array',
    cellStyles: true, // スタイル情報も読み込む
  });
  
  const result: ExcelImportResult = {
    items: [],
    mapData: [],
  };
  
  // 品目表シートからアイテムデータを読み込み
  const itemSheet = workbook.Sheets['品目表'];
  if (itemSheet) {
    result.items = parseItemSheet(itemSheet);
  }
  
  // マップシートを読み込み
  const eventDates = extractEventDates(result.items);
  for (const eventDate of eventDates) {
    const mapSheet = workbook.Sheets[eventDate];
    if (mapSheet) {
      const mapData = parseMapSheet(mapSheet, eventDate);
      result.mapData.push(mapData);
    }
  }
  
  // メタデータシートからルートプランニングデータを読み込み
  const metadataSheet = workbook.Sheets['_metadata'];
  if (metadataSheet) {
    result.routePlanningData = parseMetadataSheet(metadataSheet);
  }
  
  return result;
}

function parseItemSheet(sheet: XLSX.WorkSheet): Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] {
  const items: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];
  
  if (!sheet['!ref']) return items;
  
  const range = XLSX.utils.decode_range(sheet['!ref']);
  
  // CSV形式と同じく、A列からK列を読み込む
  for (let i = 1; i <= range.e.r; i++) {
    const circle = getCellValue(sheet, i, 0); // A列
    const eventDate = getCellValue(sheet, i, 1); // B列
    const block = getCellValue(sheet, i, 2); // C列
    const number = getCellValue(sheet, i, 3); // D列
    
    // A列からD列が全て入力されている行のみインポート
    if (!circle || !eventDate || !block || !number) {
      continue;
    }
    
    const title = getCellValue(sheet, i, 4); // E列
    const priceStr = getCellValue(sheet, i, 5); // F列
    const price = priceStr ? (parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0) : null;
    const remarks = getCellValue(sheet, i, 7); // H列
    const url = getCellValue(sheet, i, 10); // K列
    
    items.push({
      circle,
      eventDate,
      block,
      number,
      title,
      price,
      remarks,
      ...(url ? { url } : {}),
    });
  }
  
  return items;
}

function parseMapSheet(sheet: XLSX.WorkSheet, eventDate: string): MapData {
  if (!sheet['!ref']) {
    return createEmptyMapData(eventDate);
  }
  
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const cells: MapCell[][] = [];
  const blocks: BlockInfo[] = [];
  
  // セルデータを読み込み
  for (let row = range.s.r; row <= range.e.r; row++) {
    cells[row] = [];
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = sheet[cellAddress];
      
      if (!cell) {
        cells[row][col] = {
          row,
          col,
          value: '',
          isMerged: false,
        };
        continue;
      }
      
      // 結合セルの判定
      const mergedRange = findMergedRange(sheet, row, col);
      const isMerged = !!mergedRange;
      
      // 背景色の取得
      let backgroundColor: string | undefined;
      if (cell.s?.fill?.fgColor) {
        if (cell.s.fill.fgColor.rgb) {
          backgroundColor = `#${cell.s.fill.fgColor.rgb}`;
        } else if (cell.s.fill.fgColor.theme !== undefined) {
          // テーマカラーの場合はデフォルトの色を使用
          backgroundColor = undefined;
        }
      }
      
      // 罫線情報の取得
      const borders = extractBorders(cell.s?.border);
      
      cells[row][col] = {
        row,
        col,
        value: cell.v?.toString() || '',
        backgroundColor,
        originalBackgroundColor: backgroundColor,
        isMerged,
        mergedRange,
        borders,
      };
    }
  }
  
  return {
    eventDate,
    sheetName: eventDate,
    cells,
    blocks, // 初期状態では空（ユーザーが定義する）
    rowCount: range.e.r - range.s.r + 1,
    colCount: range.e.c - range.s.c + 1,
    cellSize: 30, // デフォルト値
  };
}

function findMergedRange(
  sheet: XLSX.WorkSheet, 
  row: number, 
  col: number
): { startRow: number; endRow: number; startCol: number; endCol: number } | undefined {
  if (!sheet['!merges']) return undefined;
  
  for (const merge of sheet['!merges']) {
    if (
      row >= merge.s.r &&
      row <= merge.e.r &&
      col >= merge.s.c &&
      col <= merge.e.c
    ) {
      return {
        startRow: merge.s.r,
        endRow: merge.e.r,
        startCol: merge.s.c,
        endCol: merge.e.c,
      };
    }
  }
  
  return undefined;
}

function extractBorders(border: any): MapCell['borders'] | undefined {
  if (!border) return undefined;
  
  const result: MapCell['borders'] = {};
  
  if (border.top) {
    result.top = {
      style: mapBorderStyle(border.top.style),
      color: border.top.color?.rgb ? `#${border.top.color.rgb}` : '#000000',
      width: mapBorderWidth(border.top.style),
    };
  }
  
  if (border.bottom) {
    result.bottom = {
      style: mapBorderStyle(border.bottom.style),
      color: border.bottom.color?.rgb ? `#${border.bottom.color.rgb}` : '#000000',
      width: mapBorderWidth(border.bottom.style),
    };
  }
  
  if (border.left) {
    result.left = {
      style: mapBorderStyle(border.left.style),
      color: border.left.color?.rgb ? `#${border.left.color.rgb}` : '#000000',
      width: mapBorderWidth(border.left.style),
    };
  }
  
  if (border.right) {
    result.right = {
      style: mapBorderStyle(border.right.style),
      color: border.right.color?.rgb ? `#${border.right.color.rgb}` : '#000000',
      width: mapBorderWidth(border.right.style),
    };
  }
  
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapBorderStyle(style: string | undefined): 'thin' | 'medium' | 'thick' | 'double' | 'dashed' | 'dotted' {
  if (!style) return 'thin';
  
  const styleMap: Record<string, 'thin' | 'medium' | 'thick' | 'double' | 'dashed' | 'dotted'> = {
    thin: 'thin',
    medium: 'medium',
    thick: 'thick',
    double: 'double',
    dashed: 'dashed',
    dotted: 'dotted',
  };
  
  return styleMap[style.toLowerCase()] || 'thin';
}

function mapBorderWidth(style: string | undefined): number {
  if (!style) return 1;
  
  const widthMap: Record<string, number> = {
    thin: 1,
    medium: 2,
    thick: 3,
    double: 2,
    dashed: 1,
    dotted: 1,
  };
  
  return widthMap[style.toLowerCase()] || 1;
}

function parseMetadataSheet(sheet: XLSX.WorkSheet): RoutePlanningData | undefined {
  // メタデータシートのパース実装（必要に応じて）
  // 現時点では未実装
  return undefined;
}

function extractEventDates(items: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[]): string[] {
  const eventDates = new Set<string>();
  items.forEach(item => {
    if (item.eventDate && item.eventDate.trim()) {
      eventDates.add(item.eventDate.trim());
    }
  });
  return Array.from(eventDates).sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, 'ja');
  });
}

function getCellValue(sheet: XLSX.WorkSheet, row: number, col: number): string {
  const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[cellAddress];
  return cell?.v?.toString().trim() || '';
}

function createEmptyMapData(eventDate: string): MapData {
  return {
    eventDate,
    sheetName: eventDate,
    cells: [],
    blocks: [],
    rowCount: 0,
    colCount: 0,
    cellSize: 30,
  };
}

