/**
 * エクスポート/インポート ユーティリティ
 * IndexedDBのデータをxlsxファイルにエクスポート/インポート
 */

import ExcelJS from 'exceljs';
import { 
  ShoppingItem, 
  EventMetadata, 
  DayModeState, 
  ExecuteModeItems,
  MapDataStore,
  RouteSettingsStore,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  ExportOptions,
} from '../types';

// エクスポートデータの型
export interface ExportData {
  version: string;
  exportDate: string;
  eventName: string;
  metadata?: EventMetadata;
  items: ShoppingItem[];
  layoutInfo?: {
    executeModeItems: Record<string, string[]>;
    dayModes: Record<string, string>;
  };
  mapData?: Record<string, unknown>;
  blockDefinitions?: Record<string, unknown[]>;
  routeSettings?: Record<string, unknown>;
  hallDefinitions?: Record<string, unknown[]>;
  hallRouteSettings?: Record<string, unknown>;
}

// インポート結果の型
export interface ImportResult {
  success: boolean;
  eventName: string;
  items: ShoppingItem[];
  metadata?: EventMetadata;
  layoutInfo?: {
    executeModeItems: Record<string, string[]>;
    dayModes: Record<string, string>;
  };
  mapData?: Record<string, unknown>;
  routeSettings?: Record<string, unknown>;
  hallDefinitions?: Record<string, unknown[]>;
  hallRouteSettings?: Record<string, unknown>;
  errors: string[];
}

const EXPORT_VERSION = '2.0';

/**
 * データをxlsxファイルにエクスポート
 */
export async function exportToXlsx(
  eventName: string,
  items: ShoppingItem[],
  options: ExportOptions,
  additionalData: {
    metadata?: EventMetadata;
    executeModeItems?: Record<string, ExecuteModeItems>;
    dayModes?: Record<string, DayModeState>;
    mapData?: MapDataStore;
    routeSettings?: RouteSettingsStore;
    hallDefinitions?: HallDefinitionsStore;
    hallRouteSettings?: HallRouteSettingsStore;
  }
): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Event Shopping Planner';
  workbook.created = new Date();

  // 1. アイテムデータシート（必須）
  const itemsSheet = workbook.addWorksheet('アイテムデータ');
  
  // ヘッダー
  itemsSheet.columns = [
    { header: 'ID', key: 'id', width: 40 },
    { header: 'サークル名', key: 'circle', width: 20 },
    { header: '参加日', key: 'eventDate', width: 12 },
    { header: 'ブロック', key: 'block', width: 10 },
    { header: 'ナンバー', key: 'number', width: 10 },
    { header: 'タイトル', key: 'title', width: 30 },
    { header: '価格', key: 'price', width: 10 },
    { header: '数量', key: 'quantity', width: 8 },
    { header: 'ステータス', key: 'purchaseStatus', width: 12 },
    { header: '備考', key: 'remarks', width: 30 },
    { header: 'URL', key: 'url', width: 50 },
    { header: '優先度', key: 'priorityLevel', width: 10 },
  ];

  // データ
  items.forEach(item => {
    itemsSheet.addRow({
      id: item.id,
      circle: item.circle,
      eventDate: item.eventDate,
      block: item.block,
      number: item.number,
      title: item.title,
      price: item.price,
      quantity: item.quantity,
      purchaseStatus: item.purchaseStatus,
      remarks: item.remarks,
      url: item.url || '',
      priorityLevel: item.priorityLevel || 'none',
    });
  });

  // ヘッダー行のスタイル
  itemsSheet.getRow(1).font = { bold: true };
  itemsSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' },
  };

  // 2. メタデータシート
  if (options.format === 'full') {
    const metaSheet = workbook.addWorksheet('メタデータ');
    metaSheet.columns = [
      { header: 'キー', key: 'key', width: 30 },
      { header: '値', key: 'value', width: 100 },
    ];

    metaSheet.addRow({ key: 'version', value: EXPORT_VERSION });
    metaSheet.addRow({ key: 'exportDate', value: new Date().toISOString() });
    metaSheet.addRow({ key: 'eventName', value: eventName });

    if (additionalData.metadata) {
      metaSheet.addRow({ key: 'spreadsheetUrl', value: additionalData.metadata.spreadsheetUrl || '' });
      metaSheet.addRow({ key: 'spreadsheetSheetName', value: additionalData.metadata.spreadsheetSheetName || '' });
      metaSheet.addRow({ key: 'lastImportDate', value: additionalData.metadata.lastImportDate || '' });
    }

    metaSheet.getRow(1).font = { bold: true };
  }

  // 3. 配置情報シート
  if (options.includeLayoutInfo && options.format === 'full') {
    const layoutSheet = workbook.addWorksheet('配置情報');
    layoutSheet.columns = [
      { header: 'タイプ', key: 'type', width: 20 },
      { header: '参加日', key: 'eventDate', width: 12 },
      { header: 'データ', key: 'data', width: 100 },
    ];

    // 実行モードアイテム
    const eventExecuteItems = additionalData.executeModeItems?.[eventName] || {};
    Object.entries(eventExecuteItems).forEach(([eventDate, itemIds]) => {
      layoutSheet.addRow({
        type: 'executeModeItems',
        eventDate,
        data: JSON.stringify(itemIds),
      });
    });

    // 日モード
    const eventDayModes = additionalData.dayModes?.[eventName] || {};
    Object.entries(eventDayModes).forEach(([eventDate, mode]) => {
      layoutSheet.addRow({
        type: 'dayModes',
        eventDate,
        data: mode,
      });
    });

    layoutSheet.getRow(1).font = { bold: true };
  }

  // 4. マップデータシート
  if (options.includeMapData && options.format === 'full') {
    const eventMapData = additionalData.mapData?.[eventName];
    if (eventMapData) {
      const mapSheet = workbook.addWorksheet('マップデータ');
      mapSheet.columns = [
        { header: 'マップ名', key: 'mapName', width: 20 },
        { header: 'データ', key: 'data', width: 200 },
      ];

      Object.entries(eventMapData).forEach(([mapName, data]) => {
        mapSheet.addRow({
          mapName,
          data: JSON.stringify(data),
        });
      });

      mapSheet.getRow(1).font = { bold: true };
    }
  }

  // 5. ルート情報シート
  if (options.includeRouteInfo && options.format === 'full') {
    const routeSheet = workbook.addWorksheet('ルート情報');
    routeSheet.columns = [
      { header: 'タイプ', key: 'type', width: 20 },
      { header: 'マップ名', key: 'mapName', width: 20 },
      { header: 'データ', key: 'data', width: 200 },
    ];

    // ルート設定
    const eventRouteSettings = additionalData.routeSettings?.[eventName];
    if (eventRouteSettings) {
      Object.entries(eventRouteSettings).forEach(([mapName, data]) => {
        routeSheet.addRow({
          type: 'routeSettings',
          mapName,
          data: JSON.stringify(data),
        });
      });
    }

    // ホール定義
    const eventHallDefinitions = additionalData.hallDefinitions?.[eventName];
    if (eventHallDefinitions) {
      Object.entries(eventHallDefinitions).forEach(([mapName, data]) => {
        routeSheet.addRow({
          type: 'hallDefinitions',
          mapName,
          data: JSON.stringify(data),
        });
      });
    }

    // ホールルート設定
    const eventHallRouteSettings = additionalData.hallRouteSettings?.[eventName];
    if (eventHallRouteSettings) {
      Object.entries(eventHallRouteSettings).forEach(([mapName, data]) => {
        routeSheet.addRow({
          type: 'hallRouteSettings',
          mapName,
          data: JSON.stringify(data),
        });
      });
    }

    routeSheet.getRow(1).font = { bold: true };
  }

  // Blobとして出力
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { 
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
  });
}

/**
 * xlsxファイルからデータをインポート
 */
export async function importFromXlsx(file: File): Promise<ImportResult> {
  const result: ImportResult = {
    success: false,
    eventName: '',
    items: [],
    errors: [],
  };

  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    // 1. アイテムデータシートを読み込み
    const itemsSheet = workbook.getWorksheet('アイテムデータ');
    if (!itemsSheet) {
      result.errors.push('アイテムデータシートが見つかりません');
      return result;
    }

    const items: ShoppingItem[] = [];
    itemsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // ヘッダーをスキップ

      // 優先度の値を取得（列12）
      const priorityValue = String(row.getCell(12).value || '');
      let priorityLevel: 'none' | 'priority' | 'highest' | undefined;
      if (priorityValue === 'highest') {
        priorityLevel = 'highest';
      } else if (priorityValue === 'priority') {
        priorityLevel = 'priority';
      } else if (priorityValue === 'none' || priorityValue === '') {
        priorityLevel = undefined;  // 'none'は保存しない（デフォルト値）
      }

      const item: ShoppingItem = {
        id: String(row.getCell(1).value || crypto.randomUUID()),
        circle: String(row.getCell(2).value || ''),
        eventDate: String(row.getCell(3).value || ''),
        block: String(row.getCell(4).value || ''),
        number: String(row.getCell(5).value || ''),
        title: String(row.getCell(6).value || ''),
        price: row.getCell(7).value ? Number(row.getCell(7).value) : null,
        quantity: Number(row.getCell(8).value) || 1,
        purchaseStatus: (String(row.getCell(9).value || 'None') as ShoppingItem['purchaseStatus']),
        remarks: String(row.getCell(10).value || ''),
        url: String(row.getCell(11).value || ''),
        priorityLevel,
      };

      if (item.circle || item.title) {
        items.push(item);
      }
    });

    result.items = items;

    // 2. メタデータシートを読み込み
    const metaSheet = workbook.getWorksheet('メタデータ');
    if (metaSheet) {
      const metaMap = new Map<string, string>();
      metaSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const key = String(row.getCell(1).value || '');
        const value = String(row.getCell(2).value || '');
        if (key) metaMap.set(key, value);
      });

      result.eventName = metaMap.get('eventName') || '';
      
      if (metaMap.has('spreadsheetUrl')) {
        result.metadata = {
          spreadsheetUrl: metaMap.get('spreadsheetUrl') || '',
          spreadsheetSheetName: metaMap.get('spreadsheetSheetName') || '',
          lastImportDate: metaMap.get('lastImportDate') || '',
        };
      }
    }

    // イベント名がない場合はファイル名から推測
    if (!result.eventName) {
      result.eventName = file.name.replace(/\.xlsx$/i, '');
    }

    // 3. 配置情報シートを読み込み
    const layoutSheet = workbook.getWorksheet('配置情報');
    if (layoutSheet) {
      const executeModeItems: Record<string, string[]> = {};
      const dayModes: Record<string, string> = {};

      layoutSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const type = String(row.getCell(1).value || '');
        const eventDate = String(row.getCell(2).value || '');
        const data = String(row.getCell(3).value || '');

        try {
          if (type === 'executeModeItems') {
            executeModeItems[eventDate] = JSON.parse(data);
          } else if (type === 'dayModes') {
            dayModes[eventDate] = data;
          }
        } catch (e) {
          result.errors.push(`配置情報の解析エラー: ${eventDate}`);
        }
      });

      if (Object.keys(executeModeItems).length > 0 || Object.keys(dayModes).length > 0) {
        result.layoutInfo = { executeModeItems, dayModes };
      }
    }

    // 4. マップデータシートを読み込み
    const mapSheet = workbook.getWorksheet('マップデータ');
    if (mapSheet) {
      const mapData: Record<string, unknown> = {};

      mapSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const mapName = String(row.getCell(1).value || '');
        const data = String(row.getCell(2).value || '');

        try {
          if (mapName && data) {
            mapData[mapName] = JSON.parse(data);
          }
        } catch (e) {
          result.errors.push(`マップデータの解析エラー: ${mapName}`);
        }
      });

      if (Object.keys(mapData).length > 0) {
        result.mapData = mapData;
      }
    }

    // 5. ルート情報シートを読み込み
    const routeSheet = workbook.getWorksheet('ルート情報');
    if (routeSheet) {
      const routeSettings: Record<string, unknown> = {};
      const hallDefinitions: Record<string, unknown[]> = {};
      const hallRouteSettings: Record<string, unknown> = {};

      routeSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const type = String(row.getCell(1).value || '');
        const mapName = String(row.getCell(2).value || '');
        const data = String(row.getCell(3).value || '');

        try {
          if (type === 'routeSettings' && mapName && data) {
            routeSettings[mapName] = JSON.parse(data);
          } else if (type === 'hallDefinitions' && mapName && data) {
            hallDefinitions[mapName] = JSON.parse(data);
          } else if (type === 'hallRouteSettings' && mapName && data) {
            hallRouteSettings[mapName] = JSON.parse(data);
          }
        } catch (e) {
          result.errors.push(`ルート情報の解析エラー: ${type} - ${mapName}`);
        }
      });

      if (Object.keys(routeSettings).length > 0) {
        result.routeSettings = routeSettings;
      }
      if (Object.keys(hallDefinitions).length > 0) {
        result.hallDefinitions = hallDefinitions;
      }
      if (Object.keys(hallRouteSettings).length > 0) {
        result.hallRouteSettings = hallRouteSettings;
      }
    }

    result.success = true;
  } catch (error) {
    console.error('Import error:', error);
    result.errors.push(`インポートエラー: ${error instanceof Error ? error.message : '不明なエラー'}`);
  }

  return result;
}

/**
 * エクスポートファイルのダウンロード
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
