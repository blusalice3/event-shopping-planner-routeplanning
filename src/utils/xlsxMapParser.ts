import {
  CellData,
  CellBorders,
  BorderStyle,
  MergedCellInfo,
  BlockDefinition,
  DayMapData,
  NumberCellInfo,
} from '../types';

// SheetJS (xlsx) の型定義
interface XLSXWorkbook {
  SheetNames: string[];
  Sheets: { [sheetName: string]: XLSXWorksheet };
}

interface XLSXWorksheet {
  '!ref'?: string;
  '!merges'?: XLSXRange[];
  [cellAddress: string]: XLSXCell | string | XLSXRange[] | undefined;
}

interface XLSXCell {
  v?: string | number | boolean;
  t?: string;
  s?: XLSXCellStyle;
}

interface XLSXCellStyle {
  fill?: {
    fgColor?: { rgb?: string; theme?: number };
    bgColor?: { rgb?: string };
    patternType?: string;
  };
  border?: {
    top?: XLSXBorder;
    right?: XLSXBorder;
    bottom?: XLSXBorder;
    left?: XLSXBorder;
  };
}

interface XLSXBorder {
  style?: string;
  color?: { rgb?: string; theme?: number };
}

interface XLSXRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

// セルアドレスを行・列に変換
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
function convertBorderStyle(xlsxBorder?: XLSXBorder): BorderStyle | null {
  if (!xlsxBorder || !xlsxBorder.style) return null;
  
  const styleMap: { [key: string]: BorderStyle['style'] } = {
    thin: 'thin',
    medium: 'medium',
    thick: 'thick',
    double: 'double',
  };
  
  const style = styleMap[xlsxBorder.style] || 'thin';
  const color = xlsxBorder.color?.rgb ? `#${xlsxBorder.color.rgb}` : '#000000';
  
  return { style, color };
}

// 背景色を取得
function getBackgroundColor(cellStyle?: XLSXCellStyle): string | null {
  if (!cellStyle?.fill) return null;
  
  const fill = cellStyle.fill;
  if (fill.patternType === 'none') return null;
  
  if (fill.fgColor?.rgb) {
    const rgb = fill.fgColor.rgb;
    // FFFFFFFFは白なので無視
    if (rgb === 'FFFFFFFF' || rgb === '00000000') return null;
    return `#${rgb.slice(-6)}`;
  }
  
  return null;
}

// ブロック名かどうかを判定
function isBlockNameValue(value: string | number | null): boolean {
  if (value === null || value === undefined) return false;
  const str = String(value).trim();
  if (str.length === 0 || str.length > 3) return false;
  
  // カタカナ、ひらがな、アルファベット1-3文字
  return /^[ァ-ヶア-ンa-zA-Zぁ-んー]+$/.test(str);
}

// 数値セルかどうかを判定
function isNumberCell(value: string | number | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return true;
  const num = parseInt(String(value), 10);
  return !isNaN(num) && num > 0;
}

// 太い罫線で囲まれた範囲を検出
function detectBlockBoundary(
  cells: Map<string, CellData>,
  startRow: number,
  startCol: number,
  maxRow: number,
  maxCol: number
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const visited = new Set<string>();
  const queue: { row: number; col: number }[] = [{ row: startRow, col: startCol }];
  
  let minRow = startRow, maxRowFound = startRow;
  let minCol = startCol, maxColFound = startCol;
  
  while (queue.length > 0) {
    const { row, col } = queue.shift()!;
    const key = `${row}-${col}`;
    
    if (visited.has(key)) continue;
    if (row < 1 || col < 1 || row > maxRow || col > maxCol) continue;
    
    visited.add(key);
    
    minRow = Math.min(minRow, row);
    maxRowFound = Math.max(maxRowFound, row);
    minCol = Math.min(minCol, col);
    maxColFound = Math.max(maxColFound, col);
    
    const cell = cells.get(key);
    const borders = cell?.borders;
    
    // 上に移動可能か（上に太い罫線がないか）
    if (!borders?.top || borders.top.style === 'thin' || borders.top.style === 'none') {
      queue.push({ row: row - 1, col });
    }
    // 下に移動可能か
    if (!borders?.bottom || borders.bottom.style === 'thin' || borders.bottom.style === 'none') {
      queue.push({ row: row + 1, col });
    }
    // 左に移動可能か
    if (!borders?.left || borders.left.style === 'thin' || borders.left.style === 'none') {
      queue.push({ row, col: col - 1 });
    }
    // 右に移動可能か
    if (!borders?.right || borders.right.style === 'thin' || borders.right.style === 'none') {
      queue.push({ row, col: col + 1 });
    }
  }
  
  if (visited.size < 4) return null;
  
  return {
    startRow: minRow,
    startCol: minCol,
    endRow: maxRowFound,
    endCol: maxColFound,
  };
}

// シートからマップデータを抽出
export function parseMapSheet(
  workbook: XLSXWorkbook,
  sheetName: string
): DayMapData | null {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  
  const ref = sheet['!ref'];
  if (!ref) return null;
  
  // 範囲を解析
  const refMatch = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!refMatch) return null;
  
  const startAddr = cellAddressToRowCol(`${refMatch[1]}${refMatch[2]}`);
  const endAddr = cellAddressToRowCol(`${refMatch[3]}${refMatch[4]}`);
  if (!startAddr || !endAddr) return null;
  
  const maxRow = endAddr.row;
  const maxCol = endAddr.col;
  
  // 結合セル情報を取得
  const merges = sheet['!merges'] || [];
  const mergedCells: MergedCellInfo[] = [];
  const mergeMap = new Map<string, { row: number; col: number }>();
  
  merges.forEach((merge) => {
    const startCell = cellAddressToRowCol(
      `${String.fromCharCode(65 + merge.s.c)}${merge.s.r + 1}`
    );
    if (!startCell) return;
    
    // 結合セルの値を取得
    let value: string | number | null = null;
    const cellKey = Object.keys(sheet).find((key) => {
      const addr = cellAddressToRowCol(key);
      return addr && addr.row === merge.s.r + 1 && addr.col === merge.s.c + 1;
    });
    if (cellKey && sheet[cellKey]) {
      const cell = sheet[cellKey] as XLSXCell;
      const cellValue = cell.v;
      if (cellValue !== undefined && typeof cellValue !== 'boolean') {
        value = cellValue;
      }
    }
    
    mergedCells.push({
      startRow: merge.s.r + 1,
      startCol: merge.s.c + 1,
      endRow: merge.e.r + 1,
      endCol: merge.e.c + 1,
      value: value as string | number | null,
    });
    
    // 結合セルのマップを作成
    for (let r = merge.s.r + 1; r <= merge.e.r + 1; r++) {
      for (let c = merge.s.c + 1; c <= merge.e.c + 1; c++) {
        mergeMap.set(`${r}-${c}`, { row: merge.s.r + 1, col: merge.s.c + 1 });
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
        value = xlsxCell.v !== undefined ? (xlsxCell.v as string | number) : null;
        backgroundColor = getBackgroundColor(xlsxCell.s);
        
        if (xlsxCell.s?.border) {
          borders = {
            top: convertBorderStyle(xlsxCell.s.border.top),
            right: convertBorderStyle(xlsxCell.s.border.right),
            bottom: convertBorderStyle(xlsxCell.s.border.bottom),
            left: convertBorderStyle(xlsxCell.s.border.left),
          };
        }
      }
      
      // データが存在する範囲を更新
      if (value !== null || backgroundColor !== null || 
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
  const blocks: BlockDefinition[] = [];
  const processedBlocks = new Set<string>();
  
  // 4セル以上の結合セルでブロック名っぽい値を持つものを探す
  mergedCells.forEach((merge) => {
    const size = (merge.endRow - merge.startRow + 1) * (merge.endCol - merge.startCol + 1);
    if (size < 4) return;
    if (!isBlockNameValue(merge.value)) return;
    
    const blockKey = `${merge.startRow}-${merge.startCol}`;
    if (processedBlocks.has(blockKey)) return;
    
    // 太い罫線で囲まれた範囲を検出
    const boundary = detectBlockBoundary(
      cellsMap,
      merge.startRow,
      merge.startCol,
      actualMaxRow,
      actualMaxCol
    );
    
    if (!boundary) return;
    
    // 範囲内の数値セルを収集
    const numberCells: NumberCellInfo[] = [];
    for (let r = boundary.startRow; r <= boundary.endRow; r++) {
      for (let c = boundary.startCol; c <= boundary.endCol; c++) {
        const cell = cellsMap.get(`${r}-${c}`);
        if (cell && isNumberCell(cell.value)) {
          numberCells.push({
            row: r,
            col: c,
            value: typeof cell.value === 'number' ? cell.value : parseInt(String(cell.value), 10),
          });
        }
      }
    }
    
    if (numberCells.length === 0) return;
    
    processedBlocks.add(blockKey);
    
    blocks.push({
      id: crypto.randomUUID(),
      name: String(merge.value),
      cellRange: boundary,
      isAutoDetected: true,
      numberCells,
    });
  });
  
  return {
    rows: actualMaxRow,
    cols: actualMaxCol,
    cells: filteredCells,
    mergedCells: mergedCells.filter(
      (m) => m.startRow <= actualMaxRow && m.startCol <= actualMaxCol
    ),
    blocks,
  };
}

// 列番号を列文字に変換
function numberToColumnLetter(col: number): string {
  let result = '';
  while (col > 0) {
    col--;
    result = String.fromCharCode(65 + (col % 26)) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

// 「○日目」シートを検出
export function findDaySheets(workbook: XLSXWorkbook): string[] {
  const daySheetPattern = /^[0-9０-９]+日目$/;
  return workbook.SheetNames.filter((name) => daySheetPattern.test(name));
}

// ファイルからマップデータを読み込む
export async function parseMapFile(
  file: File
): Promise<{ [dayName: string]: DayMapData } | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        const data = e.target?.result;
        if (!data) {
          reject(new Error('ファイルの読み込みに失敗しました'));
          return;
        }
        
        // SheetJSを動的にインポート
        const XLSX = await import('xlsx');
        
        const workbook = XLSX.read(data, {
          type: 'array',
          cellStyles: true,
          cellNF: true,
        }) as unknown as XLSXWorkbook;
        
        const daySheets = findDaySheets(workbook);
        if (daySheets.length === 0) {
          reject(new Error('「○日目」という名前のシートが見つかりませんでした'));
          return;
        }
        
        const result: { [dayName: string]: DayMapData } = {};
        
        for (const sheetName of daySheets) {
          const mapData = parseMapSheet(workbook, sheetName);
          if (mapData) {
            const mapName = `${sheetName}マップ`;
            result[mapName] = mapData;
          }
        }
        
        if (Object.keys(result).length === 0) {
          reject(new Error('マップデータの解析に失敗しました'));
          return;
        }
        
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = () => {
      reject(new Error('ファイルの読み込みに失敗しました'));
    };
    
    reader.readAsArrayBuffer(file);
  });
}

// ナンバーから数値部分を抽出
export function extractNumberFromItemNumber(number: string): string {
  const match = number.match(/^\d+/);
  return match ? match[0] : '';
}

// アイテムとマップセルの照合
export function matchItemToCell(
  itemEventDate: string,
  itemBlock: string,
  itemNumber: string,
  mapDayName: string,
  block: BlockDefinition
): NumberCellInfo | null {
  // 参加日の照合（「1日目」と「1日目マップ」）
  const expectedMapName = `${itemEventDate}マップ`;
  if (mapDayName !== expectedMapName) return null;
  
  // ブロック名の照合
  if (block.name !== itemBlock) return null;
  
  // ナンバーの数値部分を抽出して照合
  const itemNum = extractNumberFromItemNumber(itemNumber);
  if (!itemNum) return null;
  
  const numValue = parseInt(itemNum, 10);
  
  // ブロック内の数値セルから一致するものを探す
  return block.numberCells.find((cell) => cell.value === numValue) || null;
}
