/**
 * Excel マップファイル解析ユーティリティ (ExcelJS版)
 * 罫線、結合セル、背景色、ブロック定義を正確に抽出
 */

import ExcelJS from "exceljs";
import {
  CellData,
  CellBorders,
  BorderStyle,
  MergedCellInfo,
  BlockDefinition,
  DayMapData,
  NumberCellInfo,
  BlockDetectionSettings,
  DEFAULT_BLOCK_DETECTION_SETTINGS,
} from "../../types/map";
import {
  findZeroBlockMapSheets,
  type ParseMapFileResult,
} from "../domain/mapWorkbook";
export {
  findZeroBlockMapSheets,
  type ParseMapFileResult,
} from "../domain/mapWorkbook";

type BorderWeight = "thin" | "medium" | "thick" | "double";

type ThemeColorMap = Map<number, string>;

const DEFAULT_THEME_COLORS: Record<number, string> = {
  0: "#FFFFFF",
  1: "#000000",
  2: "#E7E6E6",
  3: "#44546A",
  4: "#4472C4",
  5: "#ED7D31",
  6: "#A5A5A5",
  7: "#FFC000",
  8: "#5B9BD5",
  9: "#F79646",
  10: "#0563C1",
  11: "#954F72",
};

const DEFAULT_THEME_COLOR_MAP: ThemeColorMap = new Map(
  Object.entries(DEFAULT_THEME_COLORS).map(([index, color]) => [
    parseInt(index, 10),
    color,
  ]),
);

function parseThemeColorFromXml(
  themeXml: string,
  tagName: string,
): string | null {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(
    `<a:${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/a:${escapedTag}>`,
    "i",
  );
  const blockMatch = themeXml.match(blockPattern);
  if (!blockMatch) return null;

  const blockXml = blockMatch[1];
  const srgbMatch = blockXml.match(/<a:srgbClr[^>]*val="([0-9A-Fa-f]{6})"/i);
  if (srgbMatch) {
    return `#${srgbMatch[1].toUpperCase()}`;
  }

  const sysClrMatch = blockXml.match(
    /<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/i,
  );
  if (sysClrMatch) {
    return `#${sysClrMatch[1].toUpperCase()}`;
  }

  return null;
}

function buildWorkbookThemeColorMap(workbook: ExcelJS.Workbook): ThemeColorMap {
  const themeColorMap = new Map<number, string>(DEFAULT_THEME_COLOR_MAP);
  const themes = (workbook.model as unknown as { themes?: unknown }).themes;
  if (!themes) return themeColorMap;

  let themeXml: string | null = null;
  if (Array.isArray(themes)) {
    themeXml =
      themes.find(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ) ?? null;
  } else if (typeof themes === "object" && themes !== null) {
    themeXml =
      Object.values(themes as Record<string, unknown>).find(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ) ?? null;
  }

  if (!themeXml) return themeColorMap;

  const themeTags: string[] = [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ];

  themeTags.forEach((tagName, index) => {
    const color = parseThemeColorFromXml(themeXml, tagName);
    if (color) {
      themeColorMap.set(index, color);
    }
  });

  return themeColorMap;
}

function applyTintToHexColor(color: string, tint?: number): string {
  const normalized = normalizeHexColor(color);
  if (!normalized) return color;
  if (typeof tint !== "number" || Number.isNaN(tint) || tint === 0)
    return normalized;

  const safeTint = Math.max(-1, Math.min(1, tint));
  const hex = normalized.substring(1);

  const channels = [0, 2, 4].map((offset) =>
    parseInt(hex.substring(offset, offset + 2), 16),
  );
  const tintedChannels = channels.map((channel) => {
    const adjusted =
      safeTint < 0
        ? channel * (1 + safeTint)
        : channel * (1 - safeTint) + 255 * safeTint;
    return Math.max(0, Math.min(255, Math.round(adjusted)));
  });

  const tintedHex = tintedChannels
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `#${tintedHex.toUpperCase()}`;
}

function getThemeColor(
  themeIndex: number,
  themeColorMap: ThemeColorMap,
): string | null {
  const color =
    themeColorMap.get(themeIndex) ?? DEFAULT_THEME_COLORS[themeIndex] ?? null;
  return color ? normalizeHexColor(color) : null;
}

function resolveExcelColor(
  color: Partial<ExcelJS.Color> | undefined,
  themeColorMap: ThemeColorMap,
): string | null {
  if (!color) return null;

  if (color.argb) {
    const rgb = color.argb.length === 8 ? color.argb.substring(2) : color.argb;
    return normalizeHexColor(`#${rgb}`);
  }

  if (color.theme !== undefined) {
    const themeColor = getThemeColor(color.theme, themeColorMap);
    if (!themeColor) return null;
    const tint = (color as { tint?: number }).tint;
    return applyTintToHexColor(themeColor, tint);
  }

  if ((color as { indexed?: number }).indexed !== undefined) {
    const indexed = (color as { indexed: number }).indexed;
    return getIndexedColor(indexed);
  }

  return null;
}

function isMediumOrThickBorder(style?: ExcelJS.BorderStyle): boolean {
  if (!style) return false;
  return style === "medium" || style === "thick" || style === "double";
}

// ExcelJSの罫線スタイルを変換
function convertExcelJSBorder(
  border?: Partial<ExcelJS.Border>,
  themeColorMap: ThemeColorMap = DEFAULT_THEME_COLOR_MAP,
): BorderStyle | null {
  if (!border || !border.style) return null;
  if ((border.style as string) === "none") return null;

  const styleMap: Record<string, BorderWeight> = {
    thin: "thin",
    medium: "medium",
    thick: "thick",
    double: "double",
    hair: "thin",
    dotted: "thin",
    dashed: "thin",
    dashDot: "thin",
    dashDotDot: "thin",
    mediumDashed: "medium",
    mediumDashDot: "medium",
    mediumDashDotDot: "medium",
    slantDashDot: "medium",
  };

  const color = resolveExcelColor(border.color, themeColorMap) ?? "#000000";

  return {
    style: styleMap[border.style] || "thin",
    color,
  };
}

type BorderDirection = "top" | "right" | "bottom" | "left";

type MergeRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

const toCellKey = (row: number, col: number): string => `${row}-${col}`;

function buildMergeRangeMap(
  mergedCells: MergedCellInfo[],
): Map<string, MergeRange> {
  const rangeMap = new Map<string, MergeRange>();
  mergedCells.forEach((merge) => {
    rangeMap.set(toCellKey(merge.startRow, merge.startCol), {
      startRow: merge.startRow,
      startCol: merge.startCol,
      endRow: merge.endRow,
      endCol: merge.endCol,
    });
  });
  return rangeMap;
}

function getBorderStyleWeight(style?: ExcelJS.BorderStyle): number {
  switch (style) {
    case "thin":
    case "hair":
    case "dotted":
    case "dashed":
    case "dashDot":
    case "dashDotDot":
      return 1;
    case "medium":
    case "mediumDashed":
    case "mediumDashDot":
    case "mediumDashDotDot":
    case "slantDashDot":
      return 2;
    case "thick":
      return 3;
    case "double":
      return 4;
    default:
      return 0;
  }
}

function pickStrongestBorder(
  candidates: Array<Partial<ExcelJS.Border> | undefined>,
): Partial<ExcelJS.Border> | undefined {
  let selected: Partial<ExcelJS.Border> | undefined;
  let selectedWeight = 0;

  candidates.forEach((candidate) => {
    const weight = getBorderStyleWeight(
      candidate?.style as ExcelJS.BorderStyle | undefined,
    );
    if (weight > selectedWeight) {
      selected = candidate;
      selectedWeight = weight;
    }
  });

  return selected;
}

function getMergedRangeForCell(
  row: number,
  col: number,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
): MergeRange | null {
  const mergeParent = mergeMap.get(toCellKey(row, col));
  if (!mergeParent) return null;
  return mergeRangeMap.get(toCellKey(mergeParent.row, mergeParent.col)) ?? null;
}

function resolveMergedRangeEdgeBorder(
  worksheet: ExcelJS.Worksheet,
  mergeRange: MergeRange,
  side: BorderDirection,
): Partial<ExcelJS.Border> | undefined {
  const candidates: Array<Partial<ExcelJS.Border> | undefined> = [];

  if (side === "top" || side === "bottom") {
    const row = side === "top" ? mergeRange.startRow : mergeRange.endRow;
    for (let col = mergeRange.startCol; col <= mergeRange.endCol; col++) {
      candidates.push(worksheet.getCell(row, col).border?.[side]);
    }
    return pickStrongestBorder(candidates);
  }

  const col = side === "left" ? mergeRange.startCol : mergeRange.endCol;
  for (let row = mergeRange.startRow; row <= mergeRange.endRow; row++) {
    candidates.push(worksheet.getCell(row, col).border?.[side]);
  }
  return pickStrongestBorder(candidates);
}

function resolveEffectiveBorderSide(
  worksheet: ExcelJS.Worksheet,
  row: number,
  col: number,
  side: BorderDirection,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
): Partial<ExcelJS.Border> | undefined {
  const mergeRange = getMergedRangeForCell(row, col, mergeMap, mergeRangeMap);
  if (!mergeRange) {
    return worksheet.getCell(row, col).border?.[side];
  }

  if (side === "top" && row !== mergeRange.startRow) return undefined;
  if (side === "bottom" && row !== mergeRange.endRow) return undefined;
  if (side === "left" && col !== mergeRange.startCol) return undefined;
  if (side === "right" && col !== mergeRange.endCol) return undefined;

  return resolveMergedRangeEdgeBorder(worksheet, mergeRange, side);
}

function getIndexedColor(colorIndex: number): string | null {
  const indexedColors: Record<number, string> = {
    0: "#000000",
    1: "#FFFFFF",
    2: "#FF0000",
    3: "#00FF00",
    4: "#0000FF",
    5: "#FFFF00",
    6: "#FF00FF",
    7: "#00FFFF",
    8: "#000000",
    9: "#FFFFFF",
    10: "#FF0000",
    11: "#00FF00",
    12: "#0000FF",
    13: "#FFFF00",
    14: "#FF00FF",
    15: "#00FFFF",
    16: "#800000",
    17: "#008000",
    18: "#000080",
    19: "#808000",
    20: "#800080",
    21: "#008080",
    22: "#C0C0C0",
    23: "#808080",
    64: "#000000",
    65: "#FFFFFF",
  };

  return indexedColors[colorIndex] ?? null;
}

function getBackgroundColorFromExcelJS(
  fill?: ExcelJS.Fill,
  themeColorMap: ThemeColorMap = DEFAULT_THEME_COLOR_MAP,
): string | null {
  if (!fill) return null;

  if (fill.type === "pattern" && fill.pattern !== "none") {
    const patternFill = fill as ExcelJS.FillPattern;
    const color = resolveExcelColor(patternFill.fgColor, themeColorMap);
    if (color === "#FFFFFF" || color === null) return null;
    return color;
  }

  return null;
}

function getFontColorFromExcelJS(
  font?: Partial<ExcelJS.Font>,
  themeColorMap: ThemeColorMap = DEFAULT_THEME_COLOR_MAP,
): string | null {
  if (!font || !font.color) return null;
  return resolveExcelColor(font.color, themeColorMap);
}

function extractCellValue(
  cellValue: ExcelJS.CellValue,
): string | number | null {
  if (cellValue === null || cellValue === undefined) return null;

  if (typeof cellValue === "string" || typeof cellValue === "number") {
    return cellValue;
  }

  if (typeof cellValue === "object") {
    if (
      "richText" in cellValue &&
      Array.isArray((cellValue as { richText: unknown[] }).richText)
    ) {
      const richText = (cellValue as { richText: Array<{ text: string }> })
        .richText;
      const text = richText.map((rt) => rt.text || "").join("");
      return text || null;
    }

    if ("result" in cellValue) {
      const result = (cellValue as { result?: unknown }).result;
      if (typeof result === "string" || typeof result === "number") {
        return result;
      }
      if (
        typeof result === "object" &&
        result !== null &&
        "richText" in (result as object)
      ) {
        const richText = (result as { richText: Array<{ text: string }> })
          .richText;
        const text = richText.map((rt) => rt.text || "").join("");
        return text || null;
      }
    }
  }

  return null;
}

function isBlockName(
  value: ExcelJS.CellValue,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): boolean {
  const extracted = extractCellValue(value);
  if (extracted === null) return false;

  const str = String(extracted).trim();
  if (str.length === 0 || str.length > settings.maxBlockNameLength)
    return false;

  const isKatakana = (ch: string) => /[\u30A0-\u30FF]/u.test(ch);
  const isHiragana = (ch: string) => /[\u3040-\u309F]/u.test(ch);
  const isAlphabet = (ch: string) => /[A-Za-z]/.test(ch);
  const isKanji = (ch: string) => /[\u3400-\u4DBF\u4E00-\u9FFF]/u.test(ch);
  const isDigit = (ch: string) => /[0-9\uFF10-\uFF19]/u.test(ch);
  const isSymbol = (ch: string) => /[-./_+&#*!]/.test(ch);

  let hasContentType = false;
  let hasDigit = false;
  let hasSymbol = false;

  for (const ch of Array.from(str)) {
    if (settings.allowedCharTypes.katakana && isKatakana(ch)) {
      hasContentType = true;
      continue;
    }
    if (settings.allowedCharTypes.hiragana && isHiragana(ch)) {
      hasContentType = true;
      continue;
    }
    if (settings.allowedCharTypes.alphabet && isAlphabet(ch)) {
      hasContentType = true;
      continue;
    }
    if (settings.allowedCharTypes.kanji && isKanji(ch)) {
      hasContentType = true;
      continue;
    }
    if (settings.allowedCharTypes.digit && isDigit(ch)) {
      hasDigit = true;
      continue;
    }
    if (settings.allowedCharTypes.symbol && isSymbol(ch)) {
      hasSymbol = true;
      continue;
    }

    return false;
  }

  const digitsOnly = /^[0-9\uFF10-\uFF19]+$/u;
  if (digitsOnly.test(str)) return false;

  if (hasContentType) return true;

  if (
    settings.allowDigitSymbolOnly &&
    settings.allowedCharTypes.digit &&
    settings.allowedCharTypes.symbol
  ) {
    return hasDigit && hasSymbol;
  }

  return false;
}

function isNumberCell(
  value: ExcelJS.CellValue,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): boolean {
  const num = extractNumericCellValue(value);
  if (num === null) return false;
  return (
    Number.isInteger(num) &&
    num >= settings.numberCellMin &&
    num <= settings.numberCellMax
  );
}

function extractNumericCellValue(value: ExcelJS.CellValue): number | null {
  const extracted = extractCellValue(value);
  if (extracted === null || extracted === undefined) return null;

  if (typeof extracted === "number") {
    if (Number.isNaN(extracted) || !Number.isFinite(extracted)) return null;
    return extracted;
  }

  const str = String(extracted).trim();
  if (str === "") return null;

  const num = Number(str);
  if (Number.isNaN(num) || !Number.isFinite(num)) return null;
  return num;
}

function generateBlockColor(index: number): string {
  const colors = [
    "#E3F2FD",
    "#E8F5E9",
    "#FFF3E0",
    "#F3E5F5",
    "#E0F7FA",
    "#FBE9E7",
    "#F1F8E9",
    "#FCE4EC",
    "#E8EAF6",
    "#FFFDE7",
    "#EFEBE9",
    "#ECEFF1",
  ];
  return colors[index % colors.length];
}

function findBorderedRegion(
  startRow: number,
  startCol: number,
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
  maxRow: number,
  maxCol: number,
  visited: Set<string>,
  maxRegionSize: number = 2000,
): Set<string> {
  const region = new Set<string>();
  const queue: Array<{ row: number; col: number }> = [
    { row: startRow, col: startCol },
  ];

  while (queue.length > 0 && region.size < maxRegionSize) {
    const { row, col } = queue.shift()!;
    const key = `${row}-${col}`;

    if (visited.has(key) || region.has(key)) continue;
    if (row < 1 || row > maxRow || col < 1 || col > maxCol) continue;

    region.add(key);

    const canMoveTo = (
      nextRow: number,
      nextCol: number,
      currentSide: BorderDirection,
      nextSide: BorderDirection,
    ): boolean => {
      if (nextRow < 1 || nextRow > maxRow || nextCol < 1 || nextCol > maxCol) {
        return false;
      }

      const currentMergeParent = mergeMap.get(toCellKey(row, col));
      const nextMergeParent = mergeMap.get(toCellKey(nextRow, nextCol));
      if (
        currentMergeParent &&
        nextMergeParent &&
        currentMergeParent.row === nextMergeParent.row &&
        currentMergeParent.col === nextMergeParent.col
      ) {
        return true;
      }

      const currentSideStyle = resolveEffectiveBorderSide(
        worksheet,
        row,
        col,
        currentSide,
        mergeMap,
        mergeRangeMap,
      )?.style as ExcelJS.BorderStyle | undefined;
      if (isMediumOrThickBorder(currentSideStyle)) {
        return false;
      }

      const nextSideStyle = resolveEffectiveBorderSide(
        worksheet,
        nextRow,
        nextCol,
        nextSide,
        mergeMap,
        mergeRangeMap,
      )?.style as ExcelJS.BorderStyle | undefined;
      if (isMediumOrThickBorder(nextSideStyle)) {
        return false;
      }

      return true;
    };

    if (canMoveTo(row - 1, col, "top", "bottom")) {
      queue.push({ row: row - 1, col });
    }
    if (canMoveTo(row + 1, col, "bottom", "top")) {
      queue.push({ row: row + 1, col });
    }
    if (canMoveTo(row, col - 1, "left", "right")) {
      queue.push({ row, col: col - 1 });
    }
    if (canMoveTo(row, col + 1, "right", "left")) {
      queue.push({ row, col: col + 1 });
    }
  }

  return region;
}

/**
 * 2つの隣接セル間に太い罫線が存在するか判定
 */
function hasThickBorderBetween(
  worksheet: ExcelJS.Worksheet,
  row1: number,
  col1: number,
  row2: number,
  col2: number,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
): boolean {
  let currentSide: BorderDirection;
  let nextSide: BorderDirection;

  if (row2 === row1 - 1 && col2 === col1) {
    currentSide = "top";
    nextSide = "bottom";
  } else if (row2 === row1 + 1 && col2 === col1) {
    currentSide = "bottom";
    nextSide = "top";
  } else if (col2 === col1 - 1 && row2 === row1) {
    currentSide = "left";
    nextSide = "right";
  } else if (col2 === col1 + 1 && row2 === row1) {
    currentSide = "right";
    nextSide = "left";
  } else {
    return false;
  }

  const currentMergeParent = mergeMap.get(toCellKey(row1, col1));
  const nextMergeParent = mergeMap.get(toCellKey(row2, col2));
  if (
    currentMergeParent &&
    nextMergeParent &&
    currentMergeParent.row === nextMergeParent.row &&
    currentMergeParent.col === nextMergeParent.col
  ) {
    return false;
  }

  const s1 = resolveEffectiveBorderSide(
    worksheet,
    row1,
    col1,
    currentSide,
    mergeMap,
    mergeRangeMap,
  )?.style as ExcelJS.BorderStyle | undefined;
  if (isMediumOrThickBorder(s1)) return true;

  const s2 = resolveEffectiveBorderSide(
    worksheet,
    row2,
    col2,
    nextSide,
    mergeMap,
    mergeRangeMap,
  )?.style as ExcelJS.BorderStyle | undefined;
  if (isMediumOrThickBorder(s2)) return true;

  return false;
}

/**
 * 領域内に別のブロック名セルが含まれるか判定
 */
function regionContainsOtherBlockName(
  region: Set<string>,
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>,
  currentBlockName: string,
  settings: BlockDetectionSettings,
): boolean {
  for (const key of region) {
    const [rowStr, colStr] = key.split("-");
    const row = parseInt(rowStr, 10);
    const col = parseInt(colStr, 10);

    const mergeParent = mergeMap.get(key);
    if (mergeParent && (mergeParent.row !== row || mergeParent.col !== col))
      continue;

    const cell = worksheet.getCell(row, col);
    if (isBlockName(cell.value, settings)) {
      const name = String(extractCellValue(cell.value)).trim();
      if (name !== currentBlockName) return true;
    }
  }
  return false;
}

/**
 * シート端からBFSして「外部セル」を事前計算する
 *
 * シートの全辺端セルからBFSを開始し、太い罫線で停止する。
 * 到達できたセル群が「外部」であり、到達できなかったセルは
 * 太い罫線で包囲された「内部」セルとなる。
 * これにより任意のセルが包囲内部かどうかをO(1)で判定できる。
 */
function computeExteriorCells(
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
  maxRow: number,
  maxCol: number,
): Set<string> {
  const exterior = new Set<string>();
  // shift()のO(n)を回避するためインデックスベースのキューを使用
  const queue: Array<{ row: number; col: number }> = [];
  let qi = 0;

  // シートの全辺端セルをキューに投入
  for (let r = 1; r <= maxRow; r++) {
    queue.push({ row: r, col: 1 });
    if (maxCol > 1) queue.push({ row: r, col: maxCol });
  }
  for (let c = 2; c < maxCol; c++) {
    queue.push({ row: 1, col: c });
    if (maxRow > 1) queue.push({ row: maxRow, col: c });
  }

  const directions: [number, number, BorderDirection, BorderDirection][] = [
    [-1, 0, "top", "bottom"],
    [1, 0, "bottom", "top"],
    [0, -1, "left", "right"],
    [0, 1, "right", "left"],
  ];

  while (qi < queue.length) {
    const { row, col } = queue[qi++];
    const key = toCellKey(row, col);

    if (exterior.has(key)) continue;
    if (row < 1 || row > maxRow || col < 1 || col > maxCol) continue;

    exterior.add(key);

    for (const [dr, dc, currentSide, nextSide] of directions) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 1 || nr > maxRow || nc < 1 || nc > maxCol) continue;
      if (exterior.has(toCellKey(nr, nc))) continue;

      // 同一マージグループ内なら自由に移動
      const currentMergeParent = mergeMap.get(toCellKey(row, col));
      const nextMergeParent = mergeMap.get(toCellKey(nr, nc));
      if (
        currentMergeParent &&
        nextMergeParent &&
        currentMergeParent.row === nextMergeParent.row &&
        currentMergeParent.col === nextMergeParent.col
      ) {
        queue.push({ row: nr, col: nc });
        continue;
      }

      // 太い罫線があれば移動不可
      const s1 = resolveEffectiveBorderSide(
        worksheet,
        row,
        col,
        currentSide,
        mergeMap,
        mergeRangeMap,
      )?.style as ExcelJS.BorderStyle | undefined;
      if (isMediumOrThickBorder(s1)) continue;

      const s2 = resolveEffectiveBorderSide(
        worksheet,
        nr,
        nc,
        nextSide,
        mergeMap,
        mergeRangeMap,
      )?.style as ExcelJS.BorderStyle | undefined;
      if (isMediumOrThickBorder(s2)) continue;

      queue.push({ row: nr, col: nc });
    }
  }

  return exterior;
}

/**
 * 太い罫線で囲われた包囲領域を検出（複雑な形状対応）
 *
 * 事前計算した外部セルマップを利用して、太い罫線の向こう側が
 * 包囲内部（外部からBFS到達不可能）かどうかをO(1)で判定する。
 * 内部と判定された隣接領域は反復的に統合し、階段状などの
 * 複雑な形状でも全数値セルを正しく検出する。
 */
function findEnclosedRegion(
  startRow: number,
  startCol: number,
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
  maxRow: number,
  maxCol: number,
  visited: Set<string>,
  maxRegionSize: number = 2000,
  blockName: string = "",
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
  exteriorCells: Set<string> = new Set(),
): Set<string> {
  // Phase 1: 通常のBFS（太い罫線で停止）で初期領域を取得
  const region = findBorderedRegion(
    startRow,
    startCol,
    worksheet,
    mergeMap,
    mergeRangeMap,
    maxRow,
    maxCol,
    visited,
    maxRegionSize,
  );

  // 外部セルマップが空の場合はPhase 1の結果のみ返す（フォールバック）
  if (exteriorCells.size === 0) {
    return region;
  }

  // Phase 2: 太い罫線を越えた包囲内部セルへの反復的拡張
  let expanded = true;
  const maxIterations = 200;
  let iteration = 0;
  const rejectedCells = new Set<string>();

  while (expanded && region.size < maxRegionSize && iteration < maxIterations) {
    expanded = false;
    iteration++;

    // 現在の領域の境界で太い罫線によりブロックされた隣接セルを収集
    const candidates: Array<{ row: number; col: number }> = [];

    for (const key of region) {
      const [rowStr, colStr] = key.split("-");
      const row = parseInt(rowStr, 10);
      const col = parseInt(colStr, 10);

      const neighbors = [
        { row: row - 1, col },
        { row: row + 1, col },
        { row, col: col - 1 },
        { row, col: col + 1 },
      ];

      for (const n of neighbors) {
        if (n.row < 1 || n.row > maxRow || n.col < 1 || n.col > maxCol)
          continue;
        const nKey = toCellKey(n.row, n.col);
        if (region.has(nKey) || visited.has(nKey) || rejectedCells.has(nKey))
          continue;

        // 太い罫線でブロックされていない隣接セルは対象外
        if (
          !hasThickBorderBetween(
            worksheet,
            row,
            col,
            n.row,
            n.col,
            mergeMap,
            mergeRangeMap,
          )
        ) {
          continue;
        }

        // ★核心: 外部セルなら即スキップ（O(1)判定、BFS不要）
        if (exteriorCells.has(nKey)) {
          rejectedCells.add(nKey);
          continue;
        }

        // 外部でない = 包囲内部セル → 候補
        candidates.push(n);
      }
    }

    for (const candidate of candidates) {
      const cKey = toCellKey(candidate.row, candidate.col);
      if (region.has(cKey) || rejectedCells.has(cKey)) continue;

      // 包囲内部からのBFS（太い罫線で停止、既存領域は訪問済み扱い）
      const probeVisited = new Set<string>(region);
      visited.forEach((k) => probeVisited.add(k));
      rejectedCells.forEach((k) => probeVisited.add(k));

      const probe = findBorderedRegion(
        candidate.row,
        candidate.col,
        worksheet,
        mergeMap,
        mergeRangeMap,
        maxRow,
        maxCol,
        probeVisited,
        Math.min(maxRegionSize - region.size, maxRegionSize),
      );

      if (probe.size === 0) {
        rejectedCells.add(cKey);
        continue;
      }

      // プローブ領域に別のブロック名が含まれていないか確認
      if (
        blockName &&
        regionContainsOtherBlockName(
          probe,
          worksheet,
          mergeMap,
          blockName,
          settings,
        )
      ) {
        probe.forEach((k) => rejectedCells.add(k));
        continue;
      }

      // プローブ領域を統合
      probe.forEach((k) => region.add(k));
      expanded = true;
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
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): NumberCellInfo[] {
  const numberCells: NumberCellInfo[] = [];

  region.forEach((key) => {
    const [rowStr, colStr] = key.split("-");
    const row = parseInt(rowStr, 10);
    const col = parseInt(colStr, 10);

    const mergeParent = mergeMap.get(key);
    if (mergeParent && (mergeParent.row !== row || mergeParent.col !== col)) {
      return;
    }

    const cell = worksheet.getCell(row, col);
    const value = cell.value;

    if (isNumberCell(value, settings)) {
      const numValue =
        typeof value === "number" ? value : parseInt(String(value), 10);
      numberCells.push({ row, col, value: numValue });
    }
  });

  return numberCells.sort((a, b) => a.value - b.value);
}

function normalizeHexColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (!trimmed) return null;

  const hex3 = /^#([0-9a-fA-F]{3})$/;
  const m3 = trimmed.match(hex3);
  if (m3) {
    const expanded = m3[1]
      .split("")
      .map((ch) => ch + ch)
      .join("");
    return `#${expanded}`.toUpperCase();
  }

  const hex6 = /^#([0-9a-fA-F]{6})$/;
  const m6 = trimmed.match(hex6);
  if (m6) {
    return `#${m6[1]}`.toUpperCase();
  }

  return null;
}

function collectMediumOrThickBorderColorsForCell(
  worksheet: ExcelJS.Worksheet,
  row: number,
  col: number,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
  themeColorMap: ThemeColorMap,
): Set<string> {
  const colors = new Set<string>();
  const sides: BorderDirection[] = ["top", "right", "bottom", "left"];

  sides.forEach((side) => {
    const border = resolveEffectiveBorderSide(
      worksheet,
      row,
      col,
      side,
      mergeMap,
      mergeRangeMap,
    );
    const style = border?.style as ExcelJS.BorderStyle | undefined;
    if (!isMediumOrThickBorder(style)) return;
    const normalized = normalizeHexColor(
      convertExcelJSBorder(border, themeColorMap)?.color,
    );
    if (normalized) {
      colors.add(normalized);
    }
  });

  return colors;
}

function collectRegionMediumOrThickBorderColors(
  regions: Set<string>[],
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
  themeColorMap: ThemeColorMap,
): Set<string> {
  const colors = new Set<string>();

  regions.forEach((region) => {
    region.forEach((key) => {
      const [rowStr, colStr] = key.split("-");
      const row = parseInt(rowStr, 10);
      const col = parseInt(colStr, 10);
      const cellColors = collectMediumOrThickBorderColorsForCell(
        worksheet,
        row,
        col,
        mergeMap,
        mergeRangeMap,
        themeColorMap,
      );
      cellColors.forEach((color) => colors.add(color));
    });
  });

  return colors;
}

function findNumberCellsByBorderColors(
  worksheet: ExcelJS.Worksheet,
  mergeMap: Map<string, { row: number; col: number }>,
  mergeRangeMap: Map<string, MergeRange>,
  maxRow: number,
  maxCol: number,
  targetColors: Set<string>,
  themeColorMap: ThemeColorMap,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
  ignoreNumberRange: boolean = false,
): NumberCellInfo[] {
  if (targetColors.size === 0) return [];

  const result: NumberCellInfo[] = [];

  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      const mergeParent = mergeMap.get(toCellKey(row, col));
      if (mergeParent && (mergeParent.row !== row || mergeParent.col !== col)) {
        continue;
      }

      const value = worksheet.getCell(row, col).value;
      const parsedValue = extractNumericCellValue(value);
      if (parsedValue === null || !Number.isInteger(parsedValue)) continue;
      if (!ignoreNumberRange && !isNumberCell(value, settings)) continue;
      if (ignoreNumberRange && parsedValue <= 0) continue;

      const borderColors = collectMediumOrThickBorderColorsForCell(
        worksheet,
        row,
        col,
        mergeMap,
        mergeRangeMap,
        themeColorMap,
      );
      const hasMatch = Array.from(borderColors).some((color) =>
        targetColors.has(color),
      );
      if (!hasMatch) continue;

      const numValue = parsedValue;
      result.push({ row, col, value: numValue });
    }
  }

  return result.sort((a, b) => a.value - b.value);
}

/**
 * 領域の境界ボックスを計算 */
function calculateBoundingBox(region: Set<string>): {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} {
  let minRow = Infinity,
    minCol = Infinity;
  let maxRow = 0,
    maxCol = 0;

  region.forEach((key) => {
    const [rowStr, colStr] = key.split("-");
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
 * ブロックを自動検出する（ExcelJS版）
 * 太い罫線で囲まれた領域内のブロック名セルと数値セルを検出
 * minMergedCellCount が1の場合は非結合（単一）セルも検出対象にする
 */
function detectBlocksWithExcelJS(
  worksheet: ExcelJS.Worksheet,
  mergedCells: MergedCellInfo[],
  mergeMap: Map<string, { row: number; col: number }>,
  maxRow: number,
  maxCol: number,
  themeColorMap: ThemeColorMap,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): BlockDefinition[] {
  const blocks: BlockDefinition[] = [];
  const globalProcessedCells = new Set<string>(); // グローバルな処理済みセル（重複対策）
  const blockGroups = new Map<
    string,
    {
      regions: Set<string>[];
      numberCells: NumberCellInfo[];
      nameCells: { row: number; col: number }[];
    }
  >();
  const mergeRangeMap = buildMergeRangeMap(mergedCells);

  // 外部セルの事前計算（シート端からBFS、太い罫線で停止）
  // これにより各ブロック候補のプローブ時に包囲判定がO(1)になる
  const exteriorCells = computeExteriorCells(
    worksheet,
    mergeMap,
    mergeRangeMap,
    maxRow,
    maxCol,
  );

  const processBlockNameCandidate = (
    blockName: string,
    startRow: number,
    startCol: number,
    nameCellCoords: { row: number; col: number }[],
  ) => {
    const cellKey = `${startRow}-${startCol}`;

    if (globalProcessedCells.has(cellKey)) return;

    const region = findEnclosedRegion(
      startRow,
      startCol,
      worksheet,
      mergeMap,
      mergeRangeMap,
      maxRow,
      maxCol,
      new Set(),
      settings.maxRegionSize,
      blockName,
      settings,
      exteriorCells,
    );

    // この領域内のセルをグローバルに処理済みとしてマーク
    region.forEach((key) => globalProcessedCells.add(key));

    const numberCells = extractNumberCellsFromRegion(
      region,
      worksheet,
      mergeMap,
      settings,
    );

    if (blockGroups.has(blockName)) {
      const group = blockGroups.get(blockName)!;
      group.regions.push(region);
      group.numberCells.push(...numberCells);
      group.nameCells.push(...nameCellCoords);
    } else {
      blockGroups.set(blockName, {
        regions: [region],
        numberCells: [...numberCells],
        nameCells: [...nameCellCoords],
      });
    }
  };

  const blockNameMerges = mergedCells.filter((merge) => {
    const rows = merge.endRow - merge.startRow + 1;
    const cols = merge.endCol - merge.startCol + 1;
    const cellCount = rows * cols;
    return (
      cellCount >= settings.minMergedCellCount &&
      isBlockName(merge.value, settings)
    );
  });

  blockNameMerges.forEach((merge) => {
    const blockName = String(merge.value).trim();
    const nameCellCoords: { row: number; col: number }[] = [];
    for (let r = merge.startRow; r <= merge.endRow; r++) {
      for (let c = merge.startCol; c <= merge.endCol; c++) {
        nameCellCoords.push({ row: r, col: c });
      }
    }
    processBlockNameCandidate(
      blockName,
      merge.startRow,
      merge.startCol,
      nameCellCoords,
    );
  });

  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      const key = `${row}-${col}`;

      if (globalProcessedCells.has(key)) continue;

      const mergeParent = mergeMap.get(key);
      if (mergeParent && (mergeParent.row !== row || mergeParent.col !== col))
        continue;

      const cell = worksheet.getCell(row, col);
      if (!isBlockName(cell.value, settings)) continue;

      const blockName = String(extractCellValue(cell.value)).trim();
      processBlockNameCandidate(blockName, row, col, [{ row, col }]);
    }
  }

  let colorIndex = 0;
  blockGroups.forEach((group, blockName) => {
    const uniqueNumberCells = group.numberCells
      .filter(
        (cell, index, self) =>
          index ===
          self.findIndex((c) => c.row === cell.row && c.col === cell.col),
      )
      .sort((a, b) => a.value - b.value);

    const regionBorderColors = collectRegionMediumOrThickBorderColors(
      group.regions,
      worksheet,
      mergeMap,
      mergeRangeMap,
      themeColorMap,
    );
    const nonBlackColors = Array.from(regionBorderColors).filter(
      (color) => color !== "#000000",
    );

    let colorExpandedNumberCells: NumberCellInfo[] = [];
    if (nonBlackColors.length > 0) {
      const targetColorSet = new Set(nonBlackColors);
      const strictColorExpandedCells = findNumberCellsByBorderColors(
        worksheet,
        mergeMap,
        mergeRangeMap,
        maxRow,
        maxCol,
        targetColorSet,
        themeColorMap,
        settings,
      );
      colorExpandedNumberCells = strictColorExpandedCells;

      const strictMin = strictColorExpandedCells[0]?.value;
      const strictMax =
        strictColorExpandedCells[strictColorExpandedCells.length - 1]?.value;
      const isLikelyRangeClipped =
        strictColorExpandedCells.length === 0 ||
        strictMin === settings.numberCellMin ||
        strictMax === settings.numberCellMax;

      if (isLikelyRangeClipped) {
        const relaxedColorExpandedCells = findNumberCellsByBorderColors(
          worksheet,
          mergeMap,
          mergeRangeMap,
          maxRow,
          maxCol,
          targetColorSet,
          themeColorMap,
          settings,
          true,
        );

        if (
          relaxedColorExpandedCells.length > strictColorExpandedCells.length
        ) {
          colorExpandedNumberCells = relaxedColorExpandedCells;
        }
      }
    }

    const nameCellKeys = new Set(
      group.nameCells.map((nc) => `${nc.row}-${nc.col}`),
    );
    const mergedNumberCells = [
      ...uniqueNumberCells,
      ...colorExpandedNumberCells,
    ]
      .filter(
        (cell, index, self) =>
          !nameCellKeys.has(`${cell.row}-${cell.col}`) &&
          index ===
            self.findIndex((c) => c.row === cell.row && c.col === cell.col),
      )
      .sort((a, b) => a.value - b.value);

    if (mergedNumberCells.length < settings.minNumberCellsPerBlock) return;

    const allCells = new Set<string>();
    group.regions.forEach((region) => {
      region.forEach((key) => allCells.add(key));
    });

    const boundingBox = calculateBoundingBox(allCells);

    const boxArea =
      (boundingBox.endRow - boundingBox.startRow + 1) *
      (boundingBox.endCol - boundingBox.startCol + 1);
    const isPolygon =
      allCells.size < boxArea * (settings.polygonThreshold / 100);

    const blockDef: BlockDefinition = {
      name: blockName,
      startRow: boundingBox.startRow,
      startCol: boundingBox.startCol,
      endRow: boundingBox.endRow,
      endCol: boundingBox.endCol,
      numberCells: mergedNumberCells,
      nameCells: group.nameCells.filter(
        (cell, index, self) =>
          index ===
          self.findIndex((c) => c.row === cell.row && c.col === cell.col),
      ),
      color: generateBlockColor(colorIndex++),
      isAutoDetected: true,
    };

    if (isPolygon) {
      blockDef.cellGroups = group.regions.map((region) => ({
        type: "individual" as const,
        cells: Array.from(region).map((key) => {
          const [rowStr, colStr] = key.split("-");
          return { row: parseInt(rowStr, 10), col: parseInt(colStr, 10) };
        }),
      }));
    }

    blocks.push(blockDef);
  });

  return blocks;
}

/**
 * シートからマップデータを解析（ExcelJS版） */
async function parseMapSheetWithExcelJS(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): Promise<DayMapData | null> {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return null;

  const rowCount = worksheet.rowCount;
  const colCount = worksheet.columnCount;

  if (rowCount === 0 || colCount === 0) return null;
  const IMPORT_CLICK_MARGIN = 25;
  const themeColorMap = buildWorkbookThemeColorMap(workbook);

  const mergedCells: MergedCellInfo[] = [];
  const mergeMap = new Map<string, { row: number; col: number }>();

  const merges = (worksheet.model as { merges?: string[] })?.merges || [];
  merges.forEach((mergeRange: string) => {
    const match = mergeRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return;

    const startCol = columnLetterToNumber(match[1]);
    const startRow = parseInt(match[2], 10);
    const endCol = columnLetterToNumber(match[3]);
    const endRow = parseInt(match[4], 10);

    const cell = worksheet.getCell(startRow, startCol);
    const value = extractCellValue(cell.value);

    mergedCells.push({
      startRow,
      startCol,
      endRow,
      endCol,
      value,
    });

    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        mergeMap.set(`${r}-${c}`, { row: startRow, col: startCol });
      }
    }
  });
  const cells: CellData[] = [];
  let actualMaxRow = 0;
  let actualMaxCol = 0;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
      actualMaxRow = Math.max(actualMaxRow, rowNumber);
      actualMaxCol = Math.max(actualMaxCol, colNumber);
    });
  });

  const sourceMaxRow = actualMaxRow;
  const sourceMaxCol = actualMaxCol;

  for (let row = 1; row <= sourceMaxRow; row++) {
    for (let col = 1; col <= sourceMaxCol; col++) {
      const cell = worksheet.getCell(row, col);

      const mergeParent = mergeMap.get(toCellKey(row, col));
      const isMerged =
        !!mergeParent && (mergeParent.row !== row || mergeParent.col !== col);

      const value = extractCellValue(cell.value);

      const backgroundColor = getBackgroundColorFromExcelJS(
        cell.fill,
        themeColorMap,
      );

      const fontColor = getFontColorFromExcelJS(cell.font, themeColorMap);

      const rawBorderSides = {
        top: cell.border?.top,
        right: cell.border?.right,
        bottom: cell.border?.bottom,
        left: cell.border?.left,
      };

      const borders: CellBorders = {
        top: convertExcelJSBorder(rawBorderSides.top, themeColorMap),
        right: convertExcelJSBorder(rawBorderSides.right, themeColorMap),
        bottom: convertExcelJSBorder(rawBorderSides.bottom, themeColorMap),
        left: convertExcelJSBorder(rawBorderSides.left, themeColorMap),
      };

      const alignment = cell.alignment;
      const isVerticalText =
        alignment?.textRotation === "vertical" ||
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

  const blocks = detectBlocksWithExcelJS(
    worksheet,
    mergedCells,
    mergeMap,
    sourceMaxRow,
    sourceMaxCol,
    themeColorMap,
    settings,
  );

  const shiftedCells = cells.map((cell) => ({
    ...cell,
    row: cell.row + IMPORT_CLICK_MARGIN,
    col: cell.col + IMPORT_CLICK_MARGIN,
    mergeParent: cell.mergeParent
      ? {
          row: cell.mergeParent.row + IMPORT_CLICK_MARGIN,
          col: cell.mergeParent.col + IMPORT_CLICK_MARGIN,
        }
      : undefined,
  }));

  const shiftedMergedCells = mergedCells.map((merge) => ({
    ...merge,
    startRow: merge.startRow + IMPORT_CLICK_MARGIN,
    startCol: merge.startCol + IMPORT_CLICK_MARGIN,
    endRow: merge.endRow + IMPORT_CLICK_MARGIN,
    endCol: merge.endCol + IMPORT_CLICK_MARGIN,
  }));

  const shiftedBlocks = blocks.map((block) => ({
    ...block,
    startRow: block.startRow + IMPORT_CLICK_MARGIN,
    startCol: block.startCol + IMPORT_CLICK_MARGIN,
    endRow: block.endRow + IMPORT_CLICK_MARGIN,
    endCol: block.endCol + IMPORT_CLICK_MARGIN,
    numberCells: block.numberCells.map((numberCell) => ({
      ...numberCell,
      row: numberCell.row + IMPORT_CLICK_MARGIN,
      col: numberCell.col + IMPORT_CLICK_MARGIN,
    })),
    nameCells: block.nameCells?.map((nameCell) => ({
      row: nameCell.row + IMPORT_CLICK_MARGIN,
      col: nameCell.col + IMPORT_CLICK_MARGIN,
    })),
    cellGroups: block.cellGroups?.map((group) => {
      if (group.type === "range") {
        return {
          ...group,
          startRow:
            typeof group.startRow === "number"
              ? group.startRow + IMPORT_CLICK_MARGIN
              : group.startRow,
          startCol:
            typeof group.startCol === "number"
              ? group.startCol + IMPORT_CLICK_MARGIN
              : group.startCol,
          endRow:
            typeof group.endRow === "number"
              ? group.endRow + IMPORT_CLICK_MARGIN
              : group.endRow,
          endCol:
            typeof group.endCol === "number"
              ? group.endCol + IMPORT_CLICK_MARGIN
              : group.endCol,
        };
      }
      return {
        ...group,
        cells: group.cells?.map((groupCell) => ({
          row: groupCell.row + IMPORT_CLICK_MARGIN,
          col: groupCell.col + IMPORT_CLICK_MARGIN,
        })),
      };
    }),
  }));

  const shiftedMaxRow = sourceMaxRow + IMPORT_CLICK_MARGIN * 2;
  const shiftedMaxCol = sourceMaxCol + IMPORT_CLICK_MARGIN * 2;

  return {
    sheetName,
    cells: shiftedCells,
    mergedCells: shiftedMergedCells,
    blocks: shiftedBlocks,
    maxRow: shiftedMaxRow,
    maxCol: shiftedMaxCol,
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
 * マップファイル（xlsx）を解析（ExcelJS版） */
export async function parseMapFile(
  file: File,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): Promise<ParseMapFileResult> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    const result: Record<string, DayMapData> = {};
    const skippedSheets: string[] = [];
    const sheetErrors: string[] = [];

    const dayPattern = /^([0-9０-９]+日目)$/;

    for (const worksheet of workbook.worksheets) {
      const sheetName = worksheet.name.trim();
      const match = sheetName.match(dayPattern);
      if (match) {
        try {
          const mapData = await parseMapSheetWithExcelJS(
            workbook,
            sheetName,
            settings,
          );
          if (mapData) {
            const mapName = `${match[1]}マップ`;
            result[mapName] = mapData;
          } else {
            skippedSheets.push(sheetName);
            sheetErrors.push(`シート「${sheetName}」: 解析できませんでした。`);
          }
        } catch {
          console.error("Map sheet parsing failed (map-sheet-parse-failed).");
          skippedSheets.push(sheetName);
          sheetErrors.push(
            `シート「${sheetName}」: 解析中にエラーが発生しました。`,
          );
        }
      }
    }

    findZeroBlockMapSheets(result).forEach((sheetName) => {
      sheetErrors.push(
        `シート「${sheetName}」: 有効なブロックが0件です。検出設定または元ファイルを確認してください。`,
      );
    });

    if (sheetErrors.length > 0) {
      return {
        data: null,
        skippedSheets,
        error: sheetErrors.join("\n"),
      };
    }

    return {
      data: Object.keys(result).length > 0 ? result : null,
      skippedSheets,
      error: null,
    };
  } catch {
    console.error("Map file parsing failed (map-file-parse-failed).");
    return {
      data: null,
      skippedSheets: [],
      error: "マップファイルを解析できませんでした。",
    };
  }
}
