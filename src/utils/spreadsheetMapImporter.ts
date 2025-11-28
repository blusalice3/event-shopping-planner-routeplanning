import { MapData, MapCell } from '../types';
import * as XLSX from 'xlsx';

/**
 * Googleスプレッドシートからマップシートを読み込む
 * 注意: GoogleスプレッドシートのCSVエクスポートでは結合セルや背景色などの情報が失われるため、
 * 完全なマップデータの読み込みはできません。
 * この関数は基本的なセルデータのみを読み込みます。
 */
export async function importMapSheetFromSpreadsheet(
  spreadsheetUrl: string,
  sheetName: string
): Promise<MapData | null> {
  try {
    const sheetIdMatch = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      throw new Error('無効なURL');
    }

    // GoogleスプレッドシートのCSVエクスポートURL
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    
    const response = await fetch(csvUrl);
    if (!response.ok) {
      return null; // シートが存在しない場合はnullを返す
    }

    const text = await response.text();
    
    // CSVをパースしてMapDataに変換
    // 注意: CSV形式では結合セルや背景色の情報が失われる
    const lines = text.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) {
      return null;
    }

    const cells: MapCell[][] = [];
    const maxCol = Math.max(...lines.map(line => line.split(',').length));

    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      const csvCells = parseCSVLine(line);
      cells[row] = [];
      
      for (let col = 0; col < Math.max(csvCells.length, maxCol); col++) {
        const value = csvCells[col]?.trim() || '';
        cells[row][col] = {
          row,
          col,
          value,
          isMerged: false, // CSV形式では結合情報が失われる
          originalBackgroundColor: undefined, // CSV形式では背景色情報が失われる
        };
      }
    }

    return {
      eventDate: sheetName,
      sheetName: sheetName,
      cells,
      blocks: [], // ブロック定義はユーザーが手動で定義する必要がある
      rowCount: cells.length,
      colCount: maxCol,
      cellSize: 30,
    };
  } catch (error) {
    console.error('Failed to import map sheet from spreadsheet', error);
    return null;
  }
}

function parseCSVLine(line: string): string[] {
  const cells: string[] = [];
  let currentCell = '';
  let insideQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    
    if (char === '"') {
      if (insideQuotes && line[j + 1] === '"') {
        currentCell += '"';
        j++;
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

/**
 * Googleスプレッドシートの全シート名を取得
 * 注意: Google Sheets APIを使わない限り、シート名の一覧を取得するのは困難です。
 * この関数は、既知の参加日（eventDates）に基づいてマップシートを読み込もうとします。
 */
export async function importMapSheetsFromSpreadsheet(
  spreadsheetUrl: string,
  eventDates: string[]
): Promise<MapData[]> {
  const mapDataList: MapData[] = [];
  
  for (const eventDate of eventDates) {
    const mapData = await importMapSheetFromSpreadsheet(spreadsheetUrl, eventDate);
    if (mapData) {
      mapDataList.push(mapData);
    }
  }
  
  return mapDataList;
}

