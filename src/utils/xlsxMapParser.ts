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
  BlockDetectionSettings,
  DEFAULT_BLOCK_DETECTION_SETTINGS,
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

// Excelのテーマカラーインデックスから色を取得
// テーマカラーは実際のワークブックのテーマXMLから取得するのが理想だが、
// ExcelJSでは直接アクセスが難しいため、よく使われる標準的な色を返す
// 
// 重要: Excelのテーマインデックスの標準的なマッピング
// - theme 0: lt1 (Light 1) - 通常は白（背景色）
// - theme 1: dk1 (Dark 1) - 通常は黒（テキスト色）
// - theme 2: lt2 (Light 2) - 薄い背景色
// - theme 3: dk2 (Dark 2) - 濃いテキスト色
// - theme 4-9: accent1-6 - アクセントカラー
function getThemeColor(themeIndex: number, tint?: number): string | null {
  // Excel標準テーマカラー（Office テーマのデフォルト値）
  const themeColors: Record<number, string> = {
    0: '#FFFFFF', // lt1 - Light 1（背景色、通常は白）
    1: '#000000', // dk1 - Dark 1（テキスト色、通常は黒）
    2: '#E7E6E6', // lt2 - Light 2（薄い背景色）
    3: '#44546A', // dk2 - Dark 2（濃いテキスト色）
    4: '#4472C4', // accent1 - 青
    5: '#ED7D31', // accent2 - オレンジ
    6: '#A5A5A5', // accent3 - グレー
    7: '#FFC000', // accent4 - 黄
    8: '#5B9BD5', // accent5 - 水色
    9: '#F79646', // accent6 - オレンジ（多くのテーマでオレンジ系）
  };
  
  let color = themeColors[themeIndex];
  if (!color) {
    // 未知のテーマインデックスの場合、nullを返す（背景色なしとして扱う）
    return null;
  }
  
  // tint（明度調整）が指定されている場合は色を調整
  // 簡易実装: tintが正の場合は明るく、負の場合は暗くする
  if (tint !== undefined && tint !== 0) {
    // 詳細なtint計算は複雑なので、ここでは元の色をそのまま返す
    // 必要に応じて実装可能
  }
  
  return color;
}

// Excelのインデックスカラーから色を取得
function getIndexedColor(colorIndex: number): string | null {
  // Excel標準パレット（56色 + システムカラー）
  const indexedColors: Record<number, string> = {
    0: '#000000', // 黒
    1: '#FFFFFF', // 白
    2: '#FF0000', // 赤
    3: '#00FF00', // 緑
    4: '#0000FF', // 青
    5: '#FFFF00', // 黄
    6: '#FF00FF', // マゼンタ
    7: '#00FFFF', // シアン
    8: '#000000', // 黒
    9: '#FFFFFF', // 白
    10: '#FF0000', // 赤
    11: '#00FF00', // 緑
    12: '#0000FF', // 青
    13: '#FFFF00', // 黄
    14: '#FF00FF', // マゼンタ
    15: '#00FFFF', // シアン
    16: '#800000', // 暗い赤
    17: '#008000', // 暗い緑
    18: '#000080', // 暗い青
    19: '#808000', // 暗い黄
    20: '#800080', // 暗い紫
    21: '#008080', // 暗いシアン
    22: '#C0C0C0', // シルバー
    23: '#808080', // グレー
    // ... 他の色も必要に応じて追加
    64: '#000000', // システムテキスト（黒）
    65: '#FFFFFF', // システム背景（白）
  };
  
  const color = indexedColors[colorIndex];
  if (color) return color;
  
  // 未知のインデックスの場合はnullを返す（背景色なしとして扱う）
  return null;
}

// 背景色を取得（テーマカラー、インデックスカラー、ARGBに対応）
function getBackgroundColorFromExcelJS(fill?: ExcelJS.Fill): string | null {
  if (!fill) return null;
  
  if (fill.type === 'pattern' && fill.pattern !== 'none') {
    const patternFill = fill as ExcelJS.FillPattern;
    const fgColor = patternFill.fgColor;
    
    if (fgColor) {
      // ARGB形式の場合
      if (fgColor.argb) {
        const argb = fgColor.argb;
        // 白のみ除外（黒は壁として認識させるため含める）
        if (argb === 'FFFFFFFF' || argb === 'FFFFFF') {
          return null;
        }
        return `#${argb.length === 8 ? argb.substring(2) : argb}`;
      }
      
      // テーマカラーの場合
      if (fgColor.theme !== undefined) {
        const tint = (fgColor as { theme: number; tint?: number }).tint;
        const color = getThemeColor(fgColor.theme, tint);
        // 白（lt1、テーマ0）のみ除外
        if (color === '#FFFFFF' || color === null) {
          return null;
        }
        return color;
      }
      
      // インデックスカラーの場合
      if ((fgColor as { indexed?: number }).indexed !== undefined) {
        const indexed = (fgColor as { indexed: number }).indexed;
        const color = getIndexedColor(indexed);
        // 白のみ除外
        if (color === '#FFFFFF') {
          return null;
        }
        return color;
      }
    }
  }
  
  return null;
}

// フォント色を取得（テーマカラー、インデックスカラー、ARGBに対応）
function getFontColorFromExcelJS(font?: Partial<ExcelJS.Font>): string | null {
  if (!font || !font.color) return null;
  
  const fontColor = font.color;
  
  // ARGB形式の場合
  if (fontColor.argb) {
    const argb = fontColor.argb;
    const hex = `#${argb.length === 8 ? argb.substring(2) : argb}`;
    return hex;
  }
  
  // テーマカラーの場合
  if (fontColor.theme !== undefined) {
    const tint = (fontColor as { theme: number; tint?: number }).tint;
    const color = getThemeColor(fontColor.theme, tint);
    return color;
  }
  
  // インデックスカラーの場合
  if ((fontColor as { indexed?: number }).indexed !== undefined) {
    const indexed = (fontColor as { indexed: number }).indexed;
    const color = getIndexedColor(indexed);
    return color;
  }
  
  return null;
}

// セルの値を抽出（richText形式にも対応）
function extractCellValue(cellValue: ExcelJS.CellValue): string | number | null {
  if (cellValue === null || cellValue === undefined) return null;
  
  if (typeof cellValue === 'string' || typeof cellValue === 'number') {
    return cellValue;
  }
  
  if (typeof cellValue === 'object') {
    // richText形式の処理
    if ('richText' in cellValue && Array.isArray((cellValue as { richText: unknown[] }).richText)) {
      const richText = (cellValue as { richText: Array<{ text: string }> }).richText;
      const text = richText.map(rt => rt.text || '').join('');
      return text || null;
    }
    
    // 数式の結果
    if ('result' in cellValue) {
      const result = (cellValue as { result?: unknown }).result;
      if (typeof result === 'string' || typeof result === 'number') {
        return result;
      }
      // resultがrichText形式の場合
      if (typeof result === 'object' && result !== null && 'richText' in (result as object)) {
        const richText = ((result as { richText: Array<{ text: string }> }).richText);
        const text = richText.map(rt => rt.text || '').join('');
        return text || null;
      }
    }
  }
  
  return null;
}

// ブロック名かどうかを判定（設定に基づく文字数・文字種チェック）
// ただし、数字のみの場合はブロック名ではなく数値セルとして扱うため除外
function isBlockName(value: ExcelJS.CellValue, settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS): boolean {
  // まずrichText等から実際の文字列を抽出
  const extracted = extractCellValue(value);
  if (extracted === null) return false;
  const str = String(extracted).trim();
  if (str.length === 0 || str.length > settings.maxBlockNameLength) return false;
  
  // 許可文字種に基づいて正規表現を構築
  const charTypes = settings.allowedCharTypes;
  let allowedPattern = '';
  // コンテンツ文字種（カタカナ・ひらがな・英字・漢字）のパターン
  const contentPatterns: RegExp[] = [];
  
  if (charTypes.katakana) {
    allowedPattern += 'ア-ンァ-ヴー';
    contentPatterns.push(/[ア-ンァ-ヴー]/);
  }
  if (charTypes.hiragana) {
    allowedPattern += 'あ-んぁ-ゔー';
    contentPatterns.push(/[あ-んぁ-ゔー]/);
  }
  if (charTypes.alphabet) {
    allowedPattern += 'A-Za-z';
    contentPatterns.push(/[A-Za-z]/);
  }
  if (charTypes.kanji) {
    allowedPattern += '\\u4E00-\\u9FFF\\u3400-\\u4DBF';
    contentPatterns.push(/[\u4E00-\u9FFF\u3400-\u4DBF]/);
  }
  // 数字と記号は補助文字種（これだけではブロック名にならない）
  if (charTypes.digit) {
    allowedPattern += '0-9０-９';
  }
  if (charTypes.symbol) {
    // 半角記号: - . / _ + & # * !
    // 全角記号: − ． ／ ＿ ＋ ＆ ＃ ＊ ！ ・ ： ～ 〜
    allowedPattern += '\\-\\.\\/\\_\\+\\&\\#\\*\\!−．／＿＋＆＃＊！・：～〜';
  }
  
  if (allowedPattern.length === 0) return false;
  
  // 全ての文字が許可された文字種であることを確認
  const allowedChars = new RegExp(`^[${allowedPattern}]+$`);
  if (!allowedChars.test(str)) return false;
  
  // 数字のみの場合は除外（数値セルとして扱うため）
  // ただし記号が含まれていれば数値セルではないので除外しない
  const digitsOnly = /^[0-9０-９]+$/;
  if (digitsOnly.test(str)) return false;
  
  // コンテンツ文字種（カタカナ・ひらがな・英字・漢字）が含まれていればOK
  if (contentPatterns.some(pattern => pattern.test(str))) return true;
  
  // コンテンツ文字種が含まれない場合（数字+記号のみ）
  // allowDigitSymbolOnly が有効かつ記号が有効なら許可
  if (settings.allowDigitSymbolOnly && charTypes.symbol && charTypes.digit) {
    // 数字と記号が両方含まれている場合のみ許可（記号だけ・数字だけは除外済み）
    const hasDigit = /[0-9０-９]/.test(str);
    const hasSymbol = /[-.\/_+&#*!−．／＿＋＆＃＊！・：～〜]/.test(str);
    return hasDigit && hasSymbol;
  }
  
  return false;
}

// 数値セルかどうかを判定（設定に基づく範囲チェック）
function isNumberCell(value: ExcelJS.CellValue, settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS): boolean {
  if (value === null || value === undefined) return false;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  return !isNaN(num) && Number.isInteger(num) && num >= settings.numberCellMin && num <= settings.numberCellMax;
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
 * 多角形（凹型含む）に対応
 */
function findBorderedRegion(
  startRow: number,
  startCol: number,
  worksheet: ExcelJS.Worksheet,
  maxRow: number,
  maxCol: number,
  visited: Set<string>,
  maxRegionSize: number = 2000
): Set<string> {
  const region = new Set<string>();
  const queue: Array<{ row: number; col: number }> = [{ row: startRow, col: startCol }];
  
  while (queue.length > 0 && region.size < maxRegionSize) {
    const { row, col } = queue.shift()!;
    const key = `${row}-${col}`;
    
    if (visited.has(key) || region.has(key)) continue;
    if (row < 1 || row > maxRow || col < 1 || col > maxCol) continue;
    
    region.add(key);
    
    const cell = worksheet.getCell(row, col);
    const border = cell.border;
    
    // 上方向へ
    if (!isMediumOrThickBorder(border?.top?.style)) {
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
  mergeMap: Map<string, { row: number; col: number }>,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS
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
    
    if (isNumberCell(value, settings)) {
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
  maxCol: number,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS
): BlockDefinition[] {
  const blocks: BlockDefinition[] = [];
  const globalProcessedCells = new Set<string>(); // グローバルな処理済みセル
  
  // 設定に基づく最小結合セル数以上の結合セルでブロック名を持つものを探す
  const blockNameMerges = mergedCells.filter((merge) => {
    const rows = merge.endRow - merge.startRow + 1;
    const cols = merge.endCol - merge.startCol + 1;
    const cellCount = rows * cols;
    return cellCount >= settings.minMergedCellCount && isBlockName(merge.value, settings);
  });
  
  // ブロック名でグループ化（同じ名前のブロックは統合）
  const blockGroups = new Map<string, {
    regions: Set<string>[];
    numberCells: NumberCellInfo[];
  }>();
  
  blockNameMerges.forEach((merge) => {
    const blockName = String(merge.value).trim();
    
    // このブロック名セルが既に処理済みかチェック
    const mergeKey = `${merge.startRow}-${merge.startCol}`;
    if (globalProcessedCells.has(mergeKey)) return;
    
    // ブロック名セルから太い罫線で囲まれた領域を検出
    // 各ブロック名から独立して検出するため、visited は空で開始
    const region = findBorderedRegion(
      merge.startRow,
      merge.startCol,
      worksheet,
      maxRow,
      maxCol,
      new Set(), // 各検出は独立
      settings.maxRegionSize
    );
    
    // この領域内のセルをグローバルに処理済みとしてマーク
    region.forEach((key) => globalProcessedCells.add(key));
    
    // 領域内の数値セルを抽出
    const numberCells = extractNumberCellsFromRegion(region, worksheet, mergeMap, settings);
    
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
    
    // 領域が矩形かどうかを判定（多角形の場合はcellGroupsを作成）
    const boxArea = (boundingBox.endRow - boundingBox.startRow + 1) * 
                    (boundingBox.endCol - boundingBox.startCol + 1);
    const isPolygon = allCells.size < boxArea * (settings.polygonThreshold / 100);
    
    const blockDef: BlockDefinition = {
      name: blockName,
      startRow: boundingBox.startRow,
      startCol: boundingBox.startCol,
      endRow: boundingBox.endRow,
      endCol: boundingBox.endCol,
      numberCells: uniqueNumberCells,
      color: generateBlockColor(colorIndex++),
      isAutoDetected: true,
    };
    
    // 多角形ブロックの場合、実際のセル群を保存
    if (isPolygon) {
      // 各領域をcellGroupとして保存（individualタイプ）
      blockDef.cellGroups = group.regions.map(region => ({
        type: 'individual' as const,
        cells: Array.from(region).map(key => {
          const [rowStr, colStr] = key.split('-');
          return { row: parseInt(rowStr, 10), col: parseInt(colStr, 10) };
        }),
      }));
    }
    
    blocks.push(blockDef);
  });
  
  return blocks;
}

/**
 * シートからマップデータを解析（ExcelJS版）
 */
async function parseMapSheetWithExcelJS(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS
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
    
    // 結合セルの値を取得（richText形式にも対応）
    const cell = worksheet.getCell(startRow, startCol);
    const value = extractCellValue(cell.value);
    
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
  
  // 5行5列分の余白を追加
  actualMaxRow += 5;
  actualMaxCol += 5;
  
  // 全セルを処理
  for (let row = 1; row <= actualMaxRow; row++) {
    for (let col = 1; col <= actualMaxCol; col++) {
      const cell = worksheet.getCell(row, col);
      
      const mergeParent = mergeMap.get(`${row}-${col}`);
      const isMerged = !!mergeParent && (mergeParent.row !== row || mergeParent.col !== col);
      
      // セルの値を取得（richText形式にも対応）
      const value = extractCellValue(cell.value);
      
      const backgroundColor = getBackgroundColorFromExcelJS(cell.fill);
      
      // フォント色を取得
      const fontColor = getFontColorFromExcelJS(cell.font);
      
      const borders: CellBorders = {
        top: convertExcelJSBorder(cell.border?.top),
        right: convertExcelJSBorder(cell.border?.right),
        bottom: convertExcelJSBorder(cell.border?.bottom),
        left: convertExcelJSBorder(cell.border?.left),
      };
      
      // 縦書き判定（textRotation が 'vertical' または 255 の場合）
      const alignment = cell.alignment;
      const isVerticalText = alignment?.textRotation === 'vertical' || 
                             alignment?.textRotation === 255;
      
      cells.push({
        row,
        col,
        value,
        backgroundColor,
        fontColor,
        borders,
        isMerged,
        mergeParent,
        isVerticalText,
      });
    }
  }
  
  // ブロックを自動検出
  const blocks = detectBlocksWithExcelJS(
    worksheet,
    mergedCells,
    mergeMap,
    actualMaxRow,
    actualMaxCol,
    settings
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
  file: File,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS
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
        const mapData = await parseMapSheetWithExcelJS(workbook, sheetName, settings);
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
  
  const itemBlockName = item.block?.trim() || '';
  
  // まず完全一致を試みる
  let block = mapData.blocks.find((b) => b.name === itemBlockName);
  
  // 完全一致がない場合、大文字/小文字を無視して検索（候補が1つの場合のみ）
  if (!block) {
    const candidates = mapData.blocks.filter((b) => 
      b.name.toLowerCase() === itemBlockName.toLowerCase()
    );
    if (candidates.length === 1) {
      block = candidates[0];
    }
  }
  
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
  cellsMap: Map<string, CellData>,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS
): BlockDefinition {
  const numberCells: NumberCellInfo[] = [];
  
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      const cell = cellsMap.get(`${r}-${c}`);
      if (cell && !cell.isMerged && cell.value !== null) {
        const num = typeof cell.value === 'number' ? cell.value : parseFloat(String(cell.value));
        if (!isNaN(num) && Number.isInteger(num) && num >= settings.numberCellMin && num <= settings.numberCellMax) {
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
