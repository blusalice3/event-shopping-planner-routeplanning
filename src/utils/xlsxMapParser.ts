/**
 * Excel マップファイル解析ユーティリティ (ExcelJS版)
 * 罫線、結合セル、背景色、ブロック定義を正確に抽出
 */

import ExcelJS from 'exceljs';
import {
  CellData,
  CellBorders,
  BorderStyle,
  MergedCellInfo,
  BlockDefinition,
  DayMapData,
  ShoppingItem,
  NumberCellInfo,
} from '../types';

// 罫線スタイルの太さ判定
type BorderWeight = 'thin' | 'medium' | 'thick' | 'double';

function isMediumOrThickBorder(style?: ExcelJS.BorderStyle): boolean {
  if (!style) return false;
  return style === 'medium' || style === 'thick' || style === 'double';
}

// ExcelJSの罫線スタイルを変換
function convertExcelJSBorder(border?: Partial<ExcelJS.Border>): BorderStyle | null {
  if (!border || !border.style) return null;
  if (border.style as string === 'none') return null;
  
  const styleMap: Record<string, BorderWeight> = {
    thin: 'thin',
    medium: 'medium',
    thick: 'thick',
    double: 'double',
    hair: 'thin',
    dotted: 'thin',
    dashed: 'thin',
    dashDot: 'thin',
    dashDotDot: 'thin',
    mediumDashed: 'medium',
    mediumDashDot: 'medium',
    mediumDashDotDot: 'medium',
    slantDashDot: 'medium',
  };
  
  let color = '#000000';
  if (border.color) {
    if (border.color.argb) {
      // ARGBの最初の2文字（アルファ）を除去
      color = `#${border.color.argb.substring(2)}`;
    } else if (border.color.theme !== undefined) {
      color = '#4CAF50'; // テーマカラーはデフォルトの緑色に
    }
  }
  
  return {
    style: styleMap[border.style] || 'thin',
    color,
  };
}

// 背景色を取得
function getBackgroundColorFromExcelJS(fill?: ExcelJS.Fill): string | null {
  if (!fill) return null;
  
  if (fill.type === 'pattern' && fill.pattern !== 'none') {
    const patternFill = fill as ExcelJS.FillPattern;
    if (patternFill.fgColor?.argb) {
      const argb = patternFill.fgColor.argb;
      // ARGB形式から色を取得（白と黒は除外）
      if (argb !== 'FFFFFFFF' && argb !== 'FF000000' && argb !== 'FFFFFF' && argb !== '000000') {
        return `#${argb.length === 8 ? argb.substring(2) : argb}`;
      }
    }
  }
  
  return null;
}

// ブロック名かどうかを判定（1〜3文字のカタカナ、ひらがな、アルファベット）
function isBlockName(value: ExcelJS.CellValue): boolean {
  if (value === null || value === undefined) return false;
  const str = String(value).trim();
  if (str.length === 0 || str.length > 3) return false;
  
  // カタカナ、ひらがな、アルファベット（大文字・小文字）
  const katakana = /^[ア-ンァ-ヴー]+$/;
  const hiragana = /^[あ-んぁ-ゔー]+$/;
  const alphabet = /^[A-Za-z]+$/;
  
  return katakana.test(str) || hiragana.test(str) || alphabet.test(str);
}

// 数値セルかどうかを判定（1〜100の整数）
function isNumberCell(value: ExcelJS.CellValue): boolean {
  if (value === null || value === undefined) return false;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  return !isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 100;
}

// ブロック用の色を生成
function generateBlockColor(index: number): string {
  const colors = [
    '#E3F2FD', '#E8F5E9', '#FFF3E0', '#F3E5F5', '#E0F7FA',
    '#FBE9E7', '#F1F8E9', '#FCE4EC', '#E8EAF6', '#FFFDE7',
    '#EFEBE9', '#ECEFF1',
  ];
  return colors[index % colors.length];
}

/**
 * 太い罫線で囲まれた領域を検出（Flood Fill方式）
 * 指定セルから開始し、太い罫線に囲まれた領域全体を返す
 */
function findBorderedRegion(
  startRow: number,
  startCol: number,
  worksheet: ExcelJS.Worksheet,
  maxRow: number,
  maxCol: number,
  visited: Set<string>
): Set<string> {
  const region = new Set<string>();
  const queue: Array<{ row: number; col: number }> = [{ row: startRow, col: startCol }];
  
  while (queue.length > 0) {
    const { row, col } = queue.shift()!;
    const key = `${row}-${col}`;
    
    if (visited.has(key) || region.has(key)) continue;
    if (row < 1 || row > maxRow || col < 1 || col > maxCol) continue;
    
    region.add(key);
    
    const cell = worksheet.getCell(row, col);
    const border = cell.border;
    
    // 上方向へ
    if (!isMediumOrThickBorder(border?.top?.style)) {
      // 上のセルの下罫線もチェック
      if (row > 1) {
        const aboveCell = worksheet.getCell(row - 1, col);
        if (!isMediumOrThickBorder(aboveCell.border?.bottom?.style)) {
          queue.push({ row: row - 1, col });
        }
      }
    }
    
    // 下方向へ
    if (!isMediumOrThickBorder(border?.bottom?.style)) {
      if (row < maxRow) {
        const belowCell = worksheet.getCell(row + 1, col);
        if (!isMediumOrThickBorder(belowCell.border?.top?.style)) {
          queue.push({ row: row + 1, col });
        }
      }
    }
    
    // 左方向へ
    if (!isMediumOrThickBorder(border?.left?.style)) {
      if (col > 1) {
        const leftCell = worksheet.getCell(row, col - 1);
        if (!isMediumOrThickBorder(leftCell.border?.right?.style)) {
          queue.push({ row, col: col - 1 });
        }
      }
    }
    
    // 右方向へ
    if (!isMediumOrThickBorder(border?.right?.style)) {
      if (col < maxCol) {
        const rightCell = worksheet.getCell(row, col + 1);
        if (!isMediumOrThickBorder(rightCell.border?.left?.style)) {
          queue.push({ row, col: col + 1 });
        }
      }
    }
  }
  
  return region;
}

/**
 * 領域内の数値セルを抽出
 */
function extractNumberCellsFromRegion(
  region: Set<string>,
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>
): NumberCellInfo[] {
  const numberCells: NumberCellInfo[] = [];
  
  region.forEach((key) => {
    const [rowStr, colStr] = key.split('-');
    const row = parseInt(rowStr, 10);
    const col = parseInt(colStr, 10);
    
    // 結合セルの子セルは除外
    const mergeParent = mergeMap.get(key);
    if (mergeParent && (mergeParent.row !== row || mergeParent.col !== col)) {
      return;
    }
    
    const cell = worksheet.getCell(row, col);
    const value = cell.value;
    
    if (isNumberCell(value)) {
      const numValue = typeof value === 'number' ? value : parseInt(String(value), 10);
      numberCells.push({ row, col, value: numValue });
    }
  });
  
  return numberCells.sort((a, b) => a.value - b.value);
}

/**
 * 領域の境界ボックスを計算
 */
function calculateBoundingBox(region: Set<string>): {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} {
  let minRow = Infinity, minCol = Infinity;
  let maxRow = 0, maxCol = 0;
  
  region.forEach((key) => {
    const [rowStr, colStr] = key.split('-');
    const row = parseInt(rowStr, 10);
    const col = parseInt(colStr, 10);
    
    minRow = Math.min(minRow, row);
    minCol = Math.min(minCol, col);
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  });
  
  return {
    startRow: minRow,
    startCol: minCol,
    endRow: maxRow,
    endCol: maxCol,
  };
}

/**
 * ブロックを自動検出（ExcelJS版）
 * 太い罫線で囲まれた領域内のブロック名セルと数値セルを検出
 */
function detectBlocksWithExcelJS(
  worksheet: ExcelJS.Worksheet,
  mergedCells: MergedCellInfo[],
  mergeMap: Map<string, { row: number; col: number }>,
  maxRow: number,
  maxCol: number
): BlockDefinition[] {
  const blocks: BlockDefinition[] = [];
  const processedRegions = new Set<string>(); // 処理済みセルを記録
  
  // 4セル以上の結合セルでブロック名を持つものを探す
  const blockNameMerges = mergedCells.filter((merge) => {
    const rows = merge.endRow - merge.startRow + 1;
    const cols = merge.endCol - merge.startCol + 1;
    const cellCount = rows * cols;
    return cellCount >= 4 && isBlockName(merge.value);
  });
  
  // ブロック名でグループ化（同じ名前のブロックは統合）
  const blockGroups = new Map<string, {
    regions: Set<string>[];
    numberCells: NumberCellInfo[];
  }>();
  
  blockNameMerges.forEach((merge) => {
    const blockName = String(merge.value).trim();
    
    // 既に処理済みの領域に含まれているかチェック
    const mergeKey = `${merge.startRow}-${merge.startCol}`;
    if (processedRegions.has(mergeKey)) return;
    
    // ブロック名セルの中心から太い罫線で囲まれた領域を検出
    const region = findBorderedRegion(
      merge.startRow,
      merge.startCol,
      worksheet,
      maxRow,
      maxCol,
      new Set()
    );
    
    // 領域内のセルを処理済みとしてマーク
    region.forEach((key) => processedRegions.add(key));
    
    // 領域内の数値セルを抽出
    const numberCells = extractNumberCellsFromRegion(region, worksheet, mergeMap);
    
    // 同じブロック名のグループに追加
    if (blockGroups.has(blockName)) {
      const group = blockGroups.get(blockName)!;
      group.regions.push(region);
      group.numberCells.push(...numberCells);
    } else {
      blockGroups.set(blockName, {
        regions: [region],
        numberCells: [...numberCells],
      });
    }
  });
  
  // ブロック定義を作成
  let colorIndex = 0;
  blockGroups.forEach((group, blockName) => {
    if (group.numberCells.length === 0) return;
    
    // 全領域を統合した境界ボックスを計算
    const allCells = new Set<string>();
    group.regions.forEach((region) => {
      region.forEach((key) => allCells.add(key));
    });
    
    const boundingBox = calculateBoundingBox(allCells);
    
    // 重複を除去してソート
    const uniqueNumberCells = group.numberCells.filter(
      (cell, index, self) =>
        index === self.findIndex((c) => c.row === cell.row && c.col === cell.col)
    ).sort((a, b) => a.value - b.value);
    
    blocks.push({
      name: blockName,
      startRow: boundingBox.startRow,
      startCol: boundingBox.startCol,
      endRow: boundingBox.endRow,
      endCol: boundingBox.endCol,
      numberCells: uniqueNumberCells,
      color: generateBlockColor(colorIndex++),
      isAutoDetected: true,
    });
  });
  
  return blocks;
}

/**
 * シートからマップデータを解析（ExcelJS版）
 */
async function parseMapSheetWithExcelJS(
  workbook: ExcelJS.Workbook,
  sheetName: string
): Promise<DayMapData | null> {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return null;
  
  // シートの範囲を取得
  const rowCount = worksheet.rowCount;
  const colCount = worksheet.columnCount;
  
  if (rowCount === 0 || colCount === 0) return null;
  
  // 結合セル情報を取得
  const mergedCells: MergedCellInfo[] = [];
  const mergeMap = new Map<string, { row: number; col: number }>();
  
  // ExcelJSの結合セル情報を処理
  const merges = (worksheet.model as { merges?: string[] })?.merges || [];
  merges.forEach((mergeRange: string) => {
    // "A1:B2" 形式をパース
    const match = mergeRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return;
    
    const startCol = columnLetterToNumber(match[1]);
    const startRow = parseInt(match[2], 10);
    const endCol = columnLetterToNumber(match[3]);
    const endRow = parseInt(match[4], 10);
    
    // 結合セルの値を取得
    const cell = worksheet.getCell(startRow, startCol);
    let value: string | number | null = null;
    if (cell.value !== null && cell.value !== undefined) {
      if (typeof cell.value === 'string' || typeof cell.value === 'number') {
        value = cell.value;
      } else if (typeof cell.value === 'object' && 'result' in cell.value) {
        // 数式の結果
        const result = (cell.value as { result?: unknown }).result;
        if (typeof result === 'string' || typeof result === 'number') {
          value = result;
        }
      }
    }
    
    mergedCells.push({
      startRow,
      startCol,
      endRow,
      endCol,
      value,
    });
    
    // 結合セルのマップを作成
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        mergeMap.set(`${r}-${c}`, { row: startRow, col: startCol });
      }
    }
  });
  
  // セルデータを抽出
  const cells: CellData[] = [];
  let actualMaxRow = 0;
  let actualMaxCol = 0;
  
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
      actualMaxRow = Math.max(actualMaxRow, rowNumber);
      actualMaxCol = Math.max(actualMaxCol, colNumber);
    });
  });
  
  // 全セルを処理
  for (let row = 1; row <= actualMaxRow; row++) {
    for (let col = 1; col <= actualMaxCol; col++) {
      const cell = worksheet.getCell(row, col);
      
      const mergeParent = mergeMap.get(`${row}-${col}`);
      const isMerged = !!mergeParent && (mergeParent.row !== row || mergeParent.col !== col);
      
      let value: string | number | null = null;
      if (cell.value !== null && cell.value !== undefined) {
        if (typeof cell.value === 'string' || typeof cell.value === 'number') {
          value = cell.value;
        } else if (typeof cell.value === 'object' && 'result' in cell.value) {
          const result = (cell.value as { result?: unknown }).result;
          if (typeof result === 'string' || typeof result === 'number') {
            value = result;
          }
        }
      }
      
      const backgroundColor = getBackgroundColorFromExcelJS(cell.fill);
      
      const borders: CellBorders = {
        top: convertExcelJSBorder(cell.border?.top),
        right: convertExcelJSBorder(cell.border?.right),
        bottom: convertExcelJSBorder(cell.border?.bottom),
        left: convertExcelJSBorder(cell.border?.left),
      };
      
      cells.push({
        row,
        col,
        value,
        backgroundColor,
        borders,
        isMerged,
        mergeParent,
      });
    }
  }
  
  // ブロックを自動検出
  const blocks = detectBlocksWithExcelJS(
    worksheet,
    mergedCells,
    mergeMap,
    actualMaxRow,
    actualMaxCol
  );
  
  return {
    sheetName,
    cells,
    mergedCells,
    blocks,
    maxRow: actualMaxRow,
    maxCol: actualMaxCol,
  };
}

// 列文字を数値に変換
function columnLetterToNumber(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col;
}

/**
 * マップファイル（xlsx）を解析（ExcelJS版）
 */
export async function parseMapFile(
  file: File
): Promise<Record<string, DayMapData> | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    
    const result: Record<string, DayMapData> = {};
    
    // "○日目" パターンのシートを探す
    const dayPattern = /^(\d+日目)$/;
    
    for (const worksheet of workbook.worksheets) {
      const sheetName = worksheet.name;
      const match = sheetName.match(dayPattern);
      if (match) {
        const mapData = await parseMapSheetWithExcelJS(workbook, sheetName);
        if (mapData) {
          // シート名を "○日目マップ" に変換
          const mapName = `${match[1]}マップ`;
          result[mapName] = mapData;
        }
      }
    }
    
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    console.error('Error parsing map file:', error);
    return null;
  }
}

/**
 * アイテムの番号から数値部分を抽出
 * 例: "26a" -> "26", "26b1" -> "26"
 */
export function extractNumberFromItemNumber(itemNumber: string): string | null {
  const match = itemNumber.match(/^(\d+)/);
  return match ? match[1] : null;
}

/**
 * アイテムをマップのセルにマッチング
 */
export function matchItemToCell(
  item: ShoppingItem,
  mapData: DayMapData,
  dayName: string
): { row: number; col: number } | null {
  if (item.eventDate !== dayName) return null;
  
  const block = mapData.blocks.find((b) => b.name === item.block);
  if (!block) return null;
  
  const numStr = extractNumberFromItemNumber(item.number);
  if (!numStr) return null;
  
  const numValue = parseInt(numStr, 10);
  const numberCell = block.numberCells.find((c) => c.value === numValue);
  if (!numberCell) return null;
  
  return { row: numberCell.row, col: numberCell.col };
}

/**
 * ブロック定義を手動で作成/更新
 */
export function createBlockDefinition(
  name: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  cellsMap: Map<string, CellData>
): BlockDefinition {
  const numberCells: NumberCellInfo[] = [];
  
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell && !cell.isMerged && cell.value !== null) {
        const num = typeof cell.value === 'number' ? cell.value : parseFloat(String(cell.value));
        if (!isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 100) {
          numberCells.push({ row: r, col: c, value: num });
        }
      }
    }
  }
  
  return {
    name,
    startRow,
    startCol,
    endRow,
    endCol,
    numberCells: numberCells.sort((a, b) => a.value - b.value),
    color: '#E3F2FD',
  };
}
