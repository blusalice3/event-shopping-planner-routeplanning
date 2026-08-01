export const SPREADSHEET_PASTE_COLUMNS = [
  { key: "circles", sheetColumn: "M", label: "サークル名" },
  { key: "eventDates", sheetColumn: "N", label: "参加日" },
  { key: "blocks", sheetColumn: "O", label: "ブロック" },
  { key: "numbers", sheetColumn: "P", label: "番号" },
  { key: "titles", sheetColumn: "Q", label: "タイトル" },
  { key: "prices", sheetColumn: "R", label: "価格" },
  { key: "remarks", sheetColumn: "W", label: "備考" },
] as const;

export type SpreadsheetPasteColumnKey =
  (typeof SPREADSHEET_PASTE_COLUMNS)[number]["key"];

export type SpreadsheetPasteColumns = Record<SpreadsheetPasteColumnKey, string>;

export interface SpreadsheetPasteInvalidRow {
  lineNumber: number;
  actualColumnCount: number;
  problem: "不足" | "超過";
}

export type SpreadsheetPasteParseResult =
  | {
      ok: true;
      columns: SpreadsheetPasteColumns;
    }
  | {
      ok: false;
      invalidRows: SpreadsheetPasteInvalidRow[];
      message: string;
    };

export const SPREADSHEET_PASTE_COLUMN_COUNT = SPREADSHEET_PASTE_COLUMNS.length;

export const SPREADSHEET_PASTE_COLUMN_GUIDE = SPREADSHEET_PASTE_COLUMNS.map(
  ({ sheetColumn, label }) => `${sheetColumn}列 ${label}`,
).join(" / ");

export const SPREADSHEET_PASTE_COLUMN_LABELS = Object.fromEntries(
  SPREADSHEET_PASTE_COLUMNS.map(({ key, sheetColumn, label }) => [
    key,
    `${sheetColumn}列 ${label}`,
  ]),
) as Record<SpreadsheetPasteColumnKey, string>;

export const normalizeImportedUrl = (value: string): string | undefined => {
  const trimmedValue = value.trim();
  if (!trimmedValue) return undefined;

  try {
    const parsedUrl = new URL(trimmedValue);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:"
      ? trimmedValue
      : undefined;
  } catch {
    return undefined;
  }
};

const createEmptyColumns = (): Record<SpreadsheetPasteColumnKey, string[]> => {
  const columns = {} as Record<SpreadsheetPasteColumnKey, string[]>;
  SPREADSHEET_PASTE_COLUMNS.forEach(({ key }) => {
    columns[key] = [];
  });
  return columns;
};

export const parseSpreadsheetPaste = (
  pasteData: string,
): SpreadsheetPasteParseResult => {
  const rows = pasteData
    .split(/\r\n|\n|\r/)
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter(({ text }) => text.trim() !== "");

  if (rows.length === 0) {
    return {
      ok: false,
      invalidRows: [],
      message: `貼り付け対象のデータがありません。各非空行を${SPREADSHEET_PASTE_COLUMN_COUNT}列（${SPREADSHEET_PASTE_COLUMN_GUIDE}）で貼り付けてください。`,
    };
  }

  const parsedRows = rows.map(({ text, lineNumber }) => ({
    cells: text.split("\t"),
    lineNumber,
  }));
  const invalidRows: SpreadsheetPasteInvalidRow[] = parsedRows
    .filter(({ cells }) => cells.length !== SPREADSHEET_PASTE_COLUMN_COUNT)
    .map(({ cells, lineNumber }) => ({
      lineNumber,
      actualColumnCount: cells.length,
      problem: cells.length < SPREADSHEET_PASTE_COLUMN_COUNT ? "不足" : "超過",
    }));

  if (invalidRows.length > 0) {
    const rowDetails = invalidRows
      .map(
        ({ lineNumber, actualColumnCount, problem }) =>
          `${lineNumber}行目（${actualColumnCount}列・${problem}）`,
      )
      .join("、");

    return {
      ok: false,
      invalidRows,
      message: `貼り付けデータの${rowDetails}は列数が正しくありません。各非空行は${SPREADSHEET_PASTE_COLUMN_COUNT}列（${SPREADSHEET_PASTE_COLUMN_GUIDE}）で貼り付けてください。`,
    };
  }

  const collectedColumns = createEmptyColumns();
  parsedRows.forEach(({ cells }) => {
    SPREADSHEET_PASTE_COLUMNS.forEach(({ key }, columnIndex) => {
      collectedColumns[key].push(cells[columnIndex]);
    });
  });

  return {
    ok: true,
    columns: Object.fromEntries(
      SPREADSHEET_PASTE_COLUMNS.map(({ key }) => [
        key,
        collectedColumns[key].join("\n"),
      ]),
    ) as SpreadsheetPasteColumns,
  };
};
