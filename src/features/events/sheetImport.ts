import type { SheetItem } from './updateDiff';

const SPREADSHEET_ID_REGEX = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let currentCell = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        currentCell += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      cells.push(currentCell);
      currentCell = '';
    } else {
      currentCell += char;
    }
  }
  cells.push(currentCell);
  return cells;
}

function toPrice(value: string): number | null {
  if (value === '') return null;
  return parseInt(value.replace(/[^0-9]/g, ''), 10) || 0;
}

function toQuantity(value: string): number {
  if (value === '') return 1;
  return Math.max(1, Math.min(10, parseInt(value.replace(/[^0-9]/g, ''), 10) || 1));
}

export function buildGoogleSheetCsvUrl(spreadsheetUrl: string, sheetName?: string): string {
  const sheetIdMatch = spreadsheetUrl.match(SPREADSHEET_ID_REGEX);
  if (!sheetIdMatch) {
    throw new Error('Invalid spreadsheet URL');
  }

  const encodedSheet = sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : '';
  return `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/gviz/tq?tqx=out:csv${encodedSheet}`;
}

export function parseEventItemsFromCsv(csvText: string): SheetItem[] {
  const lines = csvText.split('\n').filter((line) => line.trim() !== '');
  const items: SheetItem[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);

    const circle = cells[12]?.trim() || '';
    const eventDate = cells[13]?.trim() || '';
    const block = cells[14]?.trim() || '';
    const number = cells[15]?.trim() || '';

    if (!circle || !eventDate || !block || !number) {
      continue;
    }

    const title = cells[16]?.trim() || '';
    const price = toPrice(cells[17]?.trim() || '');
    const remarks = cells[22]?.trim() || '';
    const url = cells[24]?.trim() || '';
    const quantity = toQuantity(cells[26]?.trim() || '');

    items.push({
      circle,
      eventDate,
      block,
      number,
      title,
      price,
      quantity,
      remarks,
      ...(url ? { url } : {}),
    });
  }

  return items;
}

export async function fetchEventItemsFromSpreadsheet(
  spreadsheetUrl: string,
  sheetName?: string,
): Promise<SheetItem[]> {
  const csvUrl = buildGoogleSheetCsvUrl(spreadsheetUrl, sheetName);
  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error('Failed to fetch spreadsheet data.');
  }

  const text = await response.text();
  return parseEventItemsFromCsv(text);
}
