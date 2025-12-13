/**
 * Excel マップファイル解析ユーティリティ
 * 罫線、結合セル、背景色、ブロック定義を正確に抽出
 */

import * as XLSX from 'xlsx';
import {
  CellData,
  CellBorders,
  BorderStyle,
  MergedCellInfo,
  BlockDefinition,
  DayMapData,
  ShoppingItem,
} from '../types';

// SheetJSのセル型定義
interface XLSXCell {
  v?: string | number | boolean;
  t?: string;
  s?: {
    fill?: {
      fgColor?: { rgb?: string; theme?: number; tint?: number };
      bgColor?: { rgb?: string };
      patternType?: string;
    };
    patternType?: string;
    fgColor?: { rgb?: string };
    bgColor?: { rgb?: string };
    border?: {
      top?: { style?: string; color?: { rgb?: string } };
      right?: { style?: string; color?: { rgb?: string } };
      bottom?: { style?: string; color?: { rgb?: string } };
      left?: { style?: string; color?: { rgb?: string } };
    };
    font?: {
      sz?: number;
      bold?: boolean;
      color?: { rgb?: string };
    };
    alignment?: {
      horizontal?: string;
      vertical?: string;
    };
  };
}

// 列番号を文字に変換
function numberToColumnLetter(col: number): string {
  let result = '';
  let c = col;
  while (c > 0) {
    const remainder = (c - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    c = Math.floor((c - 1) / 26);
  }
  return result;
}

// セルアドレスを行・列番号に変換
function cellAddressToRowCol(address: string): { row: number; col: number } | null {
  const match = address.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  
  const colStr = match[1];
  const row = parseInt(match[2], 10);
  
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  
  return { row, col };
}

// 罫線スタイルを変換
function convertBorderStyle(border?: { style?: string; color?: { rgb?: string } }): BorderStyle | null {
  if (!border || !border.style || border.style === 'none') return null;
  
  const styleMap: Record<string, 'thin' | 'medium' | 'thick' | 'double'> = {
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
  
  return {
    style: styleMap[border.style] || 'thin',
    color: border.color?.rgb ? `#${border.color.rgb}` : '#000000',
  };
}

// 背景色を取得
function getBackgroundColor(style?: XLSXCell['s']): string | null {
  if (!style) return null;
  
  // fill プロパティをチェック
  if (style.fill) {
    if (style.fill.fgColor?.rgb && style.fill.fgColor.rgb !== 'FFFFFF' && style.fill.fgColor.rgb !== '000000') {
      return `#${style.fill.fgColor.rgb}`;
    }
  }
  
  // 直接のプロパティをチェック
  if (style.fgColor?.rgb && style.fgColor.rgb !== 'FFFFFF' && style.fgColor.rgb !== '000000') {
    return `#${style.fgColor.rgb}`;
  }
  
  return null;
}

// ブロック名かどうかを判定
function isBlockName(value: string | number | null): boolean {
  if (value === null || value === undefined) return false;
  const str = String(value).trim();
  if (str.length === 0 || str.length > 3) return false;
  
  // カタカナ、ひらがな、アルファベット（大文字・小文字）
  const katakana = /^[ア-ンァ-ヴー]+$/;
  const hiragana = /^[あ-んぁ-ゔー]+$/;
  const alphabet = /^[A-Za-z]+$/;
  
  return katakana.test(str) || hiragana.test(str) || alphabet.test(str);
}

// 数値セルかどうかを判定
function isNumberCell(value: string | number | null): boolean {
  if (value === null || value === undefined) return false;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  return !isNaN(num) && num > 0 && num <= 100;
}

/**
 * シートからマップデータを解析
 */
export function parseMapSheet(
  workbook: XLSX.WorkBook,
  sheetName: string
): DayMapData | null {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  
  const range = sheet['!ref'];
  if (!range) return null;
  
  const rangeMatch = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!rangeMatch) return null;
  
  const startAddr = cellAddressToRowCol(`${rangeMatch[1]}${rangeMatch[2]}`);
  const endAddr = cellAddressToRowCol(`${rangeMatch[3]}${rangeMatch[4]}`);
  if (!startAddr || !endAddr) return null;
  
  const maxRow = endAddr.row;
  const maxCol = endAddr.col;
  
  // 結合セル情報を取得
  const merges = sheet['!merges'] || [];
  const mergedCells: MergedCellInfo[] = [];
  const mergeMap = new Map<string, { row: number; col: number }>();
  
  merges.forEach((merge) => {
    // 結合セルの値を取得
    let value: string | number | null = null;
    const startCol = merge.s.c + 1;
    const startRow = merge.s.r + 1;
    const colLetter = numberToColumnLetter(startCol);
    const addr = `${colLetter}${startRow}`;
    
    if (sheet[addr]) {
      const cell = sheet[addr] as XLSXCell;
      const cellValue = cell.v;
      if (cellValue !== undefined && typeof cellValue !== 'boolean') {
        value = cellValue as string | number;
      }
    }
    
    mergedCells.push({
      startRow,
      startCol,
      endRow: merge.e.r + 1,
      endCol: merge.e.c + 1,
      value,
    });
    
    // 結合セルのマップを作成
    for (let r = startRow; r <= merge.e.r + 1; r++) {
      for (let c = startCol; c <= merge.e.c + 1; c++) {
        mergeMap.set(`${r}-${c}`, { row: startRow, col: startCol });
      }
    }
  });
  
  // セルデータを抽出
  const cells: CellData[] = [];
  const cellsMap = new Map<string, CellData>();
  
  // データが存在する範囲を特定
  let actualMaxRow = 0;
  let actualMaxCol = 0;
  
  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      const colLetter = numberToColumnLetter(col);
      const cellAddress = `${colLetter}${row}`;
      const xlsxCell = sheet[cellAddress] as XLSXCell | undefined;
      
      const mergeParent = mergeMap.get(`${row}-${col}`);
      const isMerged = !!mergeParent && (mergeParent.row !== row || mergeParent.col !== col);
      
      let value: string | number | null = null;
      let backgroundColor: string | null = null;
      let borders: CellBorders = { top: null, right: null, bottom: null, left: null };
      
      if (xlsxCell) {
        // 値を取得（booleanは除外）
        if (xlsxCell.v !== undefined && typeof xlsxCell.v !== 'boolean') {
          value = xlsxCell.v as string | number;
        }
        backgroundColor = getBackgroundColor(xlsxCell.s);
        
        // 罫線を取得
        if (xlsxCell.s?.border) {
          borders = {
            top: convertBorderStyle(xlsxCell.s.border.top),
            right: convertBorderStyle(xlsxCell.s.border.right),
            bottom: convertBorderStyle(xlsxCell.s.border.bottom),
            left: convertBorderStyle(xlsxCell.s.border.left),
          };
        }
      }
      
      // 実際のデータ範囲を更新
      if (value !== null ||
          backgroundColor ||
          borders.top || borders.right || borders.bottom || borders.left) {
        actualMaxRow = Math.max(actualMaxRow, row);
        actualMaxCol = Math.max(actualMaxCol, col);
      }
      
      const cellData: CellData = {
        row,
        col,
        value,
        backgroundColor,
        borders,
        isMerged,
        mergeParent,
      };
      
      cells.push(cellData);
      cellsMap.set(`${row}-${col}`, cellData);
    }
  }
  
  // 実際のデータ範囲のセルのみをフィルタ
  const filteredCells = cells.filter(
    (cell) => cell.row <= actualMaxRow && cell.col <= actualMaxCol
  );
  
  // ブロックを自動検出
  const blocks = detectBlocks(mergedCells, cellsMap, actualMaxRow, actualMaxCol);
  
  return {
    sheetName,
    cells: filteredCells,
    mergedCells: mergedCells.filter(
      (m) => m.startRow <= actualMaxRow && m.startCol <= actualMaxCol
    ),
    blocks,
    maxRow: actualMaxRow,
    maxCol: actualMaxCol,
  };
}

/**
 * ブロックを自動検出
 * 太い罫線で囲まれた領域内のブロック名セルと数値セルを検出
 */
function detectBlocks(
  mergedCells: MergedCellInfo[],
  cellsMap: Map<string, CellData>,
  maxRow: number,
  maxCol: number
): BlockDefinition[] {
  const blocks: BlockDefinition[] = [];
  const processedCells = new Set<string>();
  
  // 4セル以上の結合セルでブロック名を持つものを探す
  const blockNameMerges = mergedCells.filter((merge) => {
    const rows = merge.endRow - merge.startRow + 1;
    const cols = merge.endCol - merge.startCol + 1;
    const cellCount = rows * cols;
    return cellCount >= 4 && isBlockName(merge.value);
  });
  
  blockNameMerges.forEach((merge) => {
    const blockName = String(merge.value).trim();
    
    // 太い罫線で囲まれた領域を検出
    const boundedRegion = findBorderedRegion(
      merge,
      cellsMap,
      maxRow,
      maxCol
    );
    
    // 領域内の数値セルを検出
    const numberCells = findNumberCellsInRegion(
      boundedRegion,
      cellsMap,
      processedCells
    );
    
    // 既に同じ名前のブロックがあるかチェック
    const existingBlock = blocks.find((b) => b.name === blockName);
    if (existingBlock) {
      // 既存ブロックに追加（複数領域のブロック）
      existingBlock.numberCells.push(...numberCells);
      
      // 範囲を更新
      existingBlock.startRow = Math.min(existingBlock.startRow, boundedRegion.startRow);
      existingBlock.startCol = Math.min(existingBlock.startCol, boundedRegion.startCol);
      existingBlock.endRow = Math.max(existingBlock.endRow, boundedRegion.endRow);
      existingBlock.endCol = Math.max(existingBlock.endCol, boundedRegion.endCol);
      return;
    }
    
    if (numberCells.length > 0) {
      blocks.push({
        name: blockName,
        startRow: boundedRegion.startRow,
        startCol: boundedRegion.startCol,
        endRow: boundedRegion.endRow,
        endCol: boundedRegion.endCol,
        numberCells,
        color: generateBlockColor(blocks.length),
        isAutoDetected: true,
      });
    }
  });
  
  return blocks;
}

/**
 * 太い罫線で囲まれた領域を検出
 * ブロック名セルから上下左右に探索し、太い罫線（medium/thick）があるまで拡張
 */
function findBorderedRegion(
  merge: MergedCellInfo,
  cellsMap: Map<string, CellData>,
  maxRow: number,
  maxCol: number
): { startRow: number; startCol: number; endRow: number; endCol: number } {
  // ブロック名セルの位置から開始
  let startRow = merge.startRow;
  let startCol = merge.startCol;
  let endRow = merge.endRow;
  let endCol = merge.endCol;
  
  // 太い罫線かどうかを判定
  const isThickBorder = (border: BorderStyle | null): boolean => {
    if (!border) return false;
    return border.style === 'medium' || border.style === 'thick' || border.style === 'double';
  };
  
  // 上方向に探索
  for (let r = merge.startRow - 1; r >= 1; r--) {
    let hasThickBorder = false;
    for (let c = startCol; c <= endCol; c++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell?.borders?.bottom && isThickBorder(cell.borders.bottom)) {
        hasThickBorder = true;
        break;
      }
      const cellAbove = cellsMap.get(`${r + 1}-${c}`);
      if (cellAbove?.borders?.top && isThickBorder(cellAbove.borders.top)) {
        hasThickBorder = true;
        break;
      }
    }
    if (hasThickBorder) {
      startRow = r + 1;
      break;
    }
    startRow = r;
  }
  
  // 下方向に探索
  for (let r = merge.endRow + 1; r <= maxRow; r++) {
    let hasThickBorder = false;
    for (let c = startCol; c <= endCol; c++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell?.borders?.top && isThickBorder(cell.borders.top)) {
        hasThickBorder = true;
        break;
      }
      const cellAbove = cellsMap.get(`${r - 1}-${c}`);
      if (cellAbove?.borders?.bottom && isThickBorder(cellAbove.borders.bottom)) {
        hasThickBorder = true;
        break;
      }
    }
    if (hasThickBorder) {
      endRow = r - 1;
      break;
    }
    endRow = r;
  }
  
  // 左方向に探索
  for (let c = merge.startCol - 1; c >= 1; c--) {
    let hasThickBorder = false;
    for (let r = startRow; r <= endRow; r++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell?.borders?.right && isThickBorder(cell.borders.right)) {
        hasThickBorder = true;
        break;
      }
      const cellRight = cellsMap.get(`${r}-${c + 1}`);
      if (cellRight?.borders?.left && isThickBorder(cellRight.borders.left)) {
        hasThickBorder = true;
        break;
      }
    }
    if (hasThickBorder) {
      startCol = c + 1;
      break;
    }
    startCol = c;
  }
  
  // 右方向に探索
  for (let c = merge.endCol + 1; c <= maxCol; c++) {
    let hasThickBorder = false;
    for (let r = startRow; r <= endRow; r++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell?.borders?.left && isThickBorder(cell.borders.left)) {
        hasThickBorder = true;
        break;
      }
      const cellLeft = cellsMap.get(`${r}-${c - 1}`);
      if (cellLeft?.borders?.right && isThickBorder(cellLeft.borders.right)) {
        hasThickBorder = true;
        break;
      }
    }
    if (hasThickBorder) {
      endCol = c - 1;
      break;
    }
    endCol = c;
  }
  
  // 最大範囲を制限（無限に広がらないように）
  const maxExpansion = 30;
  startRow = Math.max(startRow, merge.startRow - maxExpansion);
  endRow = Math.min(endRow, merge.endRow + maxExpansion);
  startCol = Math.max(startCol, merge.startCol - maxExpansion);
  endCol = Math.min(endCol, merge.endCol + maxExpansion);
  
  return { startRow, startCol, endRow, endCol };
}

/**
 * 指定領域内の数値セルを検出
 */
function findNumberCellsInRegion(
  region: { startRow: number; startCol: number; endRow: number; endCol: number },
  cellsMap: Map<string, CellData>,
  processedCells: Set<string>
): Array<{ row: number; col: number; value: number }> {
  const numberCells: Array<{ row: number; col: number; value: number }> = [];
  
  for (let r = region.startRow; r <= region.endRow; r++) {
    for (let c = region.startCol; c <= region.endCol; c++) {
      const key = `${r}-${c}`;
      if (processedCells.has(key)) continue;
      
      const cell = cellsMap.get(key);
      if (!cell || cell.isMerged) continue;
      
      if (isNumberCell(cell.value)) {
        const numValue = typeof cell.value === 'number' 
          ? cell.value 
          : parseFloat(String(cell.value));
        
        numberCells.push({ row: r, col: c, value: numValue });
        processedCells.add(key);
      }
    }
  }
  
  return numberCells;
}

/**
 * ブロック用の色を生成
 */
function generateBlockColor(index: number): string {
  const colors = [
    '#E3F2FD', // 青
    '#E8F5E9', // 緑
    '#FFF3E0', // オレンジ
    '#F3E5F5', // 紫
    '#E0F7FA', // シアン
    '#FBE9E7', // 深いオレンジ
    '#F1F8E9', // ライトグリーン
    '#FCE4EC', // ピンク
    '#E8EAF6', // インディゴ
    '#FFFDE7', // 黄色
  ];
  return colors[index % colors.length];
}

/**
 * マップファイル（xlsx）を解析
 */
export async function parseMapFile(
  file: File
): Promise<Record<string, DayMapData> | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { 
      cellStyles: true,
      cellNF: true,
    });
    
    const result: Record<string, DayMapData> = {};
    
    // "○日目" パターンのシートを探す
    const dayPattern = /^(\d+日目)$/;
    
    workbook.SheetNames.forEach((sheetName) => {
      const match = sheetName.match(dayPattern);
      if (match) {
        const mapData = parseMapSheet(workbook, sheetName);
        if (mapData) {
          // シート名を "○日目マップ" に変換
          const mapName = `${match[1]}マップ`;
          result[mapName] = mapData;
        }
      }
    });
    
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    console.error('Error parsing map file:', error);
    return null;
  }
}

/**
 * "○日目" パターンのシートを検出
 */
export function findDaySheets(workbook: XLSX.WorkBook): string[] {
  const dayPattern = /^\d+日目$/;
  return workbook.SheetNames.filter((name) => dayPattern.test(name));
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
  // 参加日をチェック
  if (item.eventDate !== dayName) return null;
  
  // ブロックを探す
  const block = mapData.blocks.find((b) => b.name === item.block);
  if (!block) return null;
  
  // ナンバーの数値部分を抽出
  const numStr = extractNumberFromItemNumber(item.number);
  if (!numStr) return null;
  
  const numValue = parseInt(numStr, 10);
  
  // ブロック内の該当する数値セルを探す
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
  const numberCells: Array<{ row: number; col: number; value: number }> = [];
  
  // 指定範囲内の数値セルを収集
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell && !cell.isMerged && isNumberCell(cell.value)) {
        const numValue = typeof cell.value === 'number'
          ? cell.value
          : parseFloat(String(cell.value));
        numberCells.push({ row: r, col: c, value: numValue });
      }
    }
  }
  
  return {
    name,
    startRow,
    startCol,
    endRow,
    endCol,
    numberCells,
    color: '#E3F2FD',
  };
}
