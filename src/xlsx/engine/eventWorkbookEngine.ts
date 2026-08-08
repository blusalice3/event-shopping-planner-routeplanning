/**
 * エクスポート/インポート ユーティリティ
 * IndexedDBのデータをxlsxファイルにエクスポート/インポート
 */

import ExcelJS from "exceljs";
import {
  ShoppingItem,
  EventMetadata,
  PurchaseStatuses,
} from "../../types/item";
import {
  BlockDetectionSettings,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  isBlockDetectionSettings,
} from "../../types/map";
import type { ExportOptions } from "../../types/export";
import {
  normalizeLimitedPurchaseFields,
  validateLimitedPurchaseQuantities,
} from "../../utils/purchaseQuantity";
import type {
  EventWorkbookAdditionalData,
  EventWorkbookImportResult,
  ItemFallbackWarning,
  LegacySheetFieldFallback,
} from "../domain/eventWorkbook";
export type {
  EventWorkbookImportResult as ImportResult,
  ItemFallbackWarning,
  LegacySheetFieldFallback,
} from "../domain/eventWorkbook";

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
  mapRotationSettings?: MapRotationSettingsStore[string];
  mapViewportSettings?: MapViewportSettingsStore[string];
  routeSettings?: Record<string, unknown>;
  hallDefinitions?: Record<string, unknown[]>;
  hallRouteSettings?: Record<string, unknown>;
  blockDetectionSettings?: BlockDetectionSettings;
}

const EXPORT_VERSION = "2.2";
const WORKBOOK_CREATOR = "Event Shopping Planner";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type StrictPositiveIntegerCellParseResult =
  | { kind: "empty" }
  | { kind: "value"; value: number }
  | { kind: "invalid"; raw: string };

type FiniteNumberCellParseResult =
  | { kind: "empty" }
  | { kind: "value"; value: number }
  | { kind: "invalid"; raw: string };

const isFormulaCellValue = (
  rawValue: ExcelJS.CellValue,
): rawValue is ExcelJS.CellFormulaValue | ExcelJS.CellSharedFormulaValue =>
  typeof rawValue === "object" &&
  rawValue !== null &&
  ("formula" in rawValue || "sharedFormula" in rawValue);

const parseStrictPositiveIntegerScalar = (
  rawValue: number | string,
): StrictPositiveIntegerCellParseResult => {
  if (typeof rawValue === "number") {
    return Number.isInteger(rawValue) && rawValue >= 1
      ? { kind: "value", value: rawValue }
      : { kind: "invalid", raw: String(rawValue) };
  }

  const rawText = rawValue.trim();
  if (rawText === "") return { kind: "empty" };
  if (!/^\d+$/.test(rawText)) return { kind: "invalid", raw: rawText };

  const value = Number(rawText);
  return value >= 1
    ? { kind: "value", value }
    : { kind: "invalid", raw: rawText };
};

const parseStrictPositiveIntegerCell = (
  rawValue: ExcelJS.CellValue,
): StrictPositiveIntegerCellParseResult => {
  if (rawValue === null || rawValue === undefined) return { kind: "empty" };

  if (typeof rawValue === "number" || typeof rawValue === "string") {
    return parseStrictPositiveIntegerScalar(rawValue);
  }

  if (isFormulaCellValue(rawValue)) {
    const result = rawValue.result;
    if (typeof result === "number" || typeof result === "string") {
      return parseStrictPositiveIntegerScalar(result);
    }
    return { kind: "invalid", raw: "数式結果なし" };
  }

  return { kind: "invalid", raw: "非対応セル形式" };
};

const parseFiniteNumberScalar = (
  rawValue: number | string,
): FiniteNumberCellParseResult => {
  if (typeof rawValue === "number") {
    return Number.isFinite(rawValue)
      ? { kind: "value", value: rawValue }
      : { kind: "invalid", raw: String(rawValue) };
  }

  const rawText = rawValue.trim();
  if (rawText === "") return { kind: "empty" };
  const value = Number(rawText);
  return Number.isFinite(value)
    ? { kind: "value", value }
    : { kind: "invalid", raw: rawText };
};

const parseFiniteNumberCell = (
  rawValue: ExcelJS.CellValue,
): FiniteNumberCellParseResult => {
  if (rawValue === null || rawValue === undefined) return { kind: "empty" };

  if (typeof rawValue === "number" || typeof rawValue === "string") {
    return parseFiniteNumberScalar(rawValue);
  }

  if (isFormulaCellValue(rawValue)) {
    const result = rawValue.result;
    if (typeof result === "number" || typeof result === "string") {
      return parseFiniteNumberScalar(result);
    }
    return { kind: "invalid", raw: "数式結果なし" };
  }

  return { kind: "invalid", raw: "非対応セル形式" };
};

/**
 * データをxlsxファイルにエクスポート
 */
export async function exportToXlsx(
  eventName: string,
  items: ShoppingItem[],
  options: ExportOptions,
  additionalData: EventWorkbookAdditionalData,
): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = WORKBOOK_CREATOR;
  workbook.created = new Date();

  // 1. アイテムデータシート（必須）
  const itemsSheet = workbook.addWorksheet("アイテムデータ");

  // ヘッダー
  itemsSheet.columns = [
    { header: "ID", key: "id", width: 40 },
    { header: "サークル名", key: "circle", width: 20 },
    { header: "参加日", key: "eventDate", width: 12 },
    { header: "ブロック", key: "block", width: 10 },
    { header: "ナンバー", key: "number", width: 10 },
    { header: "タイトル", key: "title", width: 30 },
    { header: "価格", key: "price", width: 10 },
    { header: "数量", key: "quantity", width: 8 },
    { header: "ステータス", key: "purchaseStatus", width: 12 },
    { header: "備考", key: "remarks", width: 30 },
    { header: "URL", key: "url", width: 50 },
    { header: "優先度", key: "priorityLevel", width: 10 },
    { header: "保護レベル", key: "protectionLevel", width: 12 },
    { header: "追加元", key: "source", width: 12 },
    { header: "手動ホール", key: "manualHallId", width: 20 },
    { header: "限数実購入数", key: "limitedPurchasedQuantity", width: 14 },
    { header: "カタログ価格", key: "catalogPrice", width: 14 },
    { header: "シート備考", key: "sheetRemarks", width: 30 },
  ];

  // データ
  items.forEach((item) => {
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
      url: item.url || "",
      priorityLevel: item.priorityLevel || "none",
      protectionLevel: item.protectionLevel || "",
      source: item.source || "",
      manualHallId: item.manualHallId || "",
      limitedPurchasedQuantity:
        item.purchaseStatus === "LimitedPurchase"
          ? (item.limitedPurchasedQuantity ?? "")
          : "",
      catalogPrice:
        item.catalogPrice !== undefined
          ? (item.catalogPrice ?? "")
          : item.source === "spreadsheet"
            ? (item.price ?? "")
            : "",
      sheetRemarks:
        item.sheetRemarks !== undefined
          ? item.sheetRemarks
          : item.source === "spreadsheet"
            ? item.remarks
            : "",
    });
  });

  // ヘッダー行のスタイル
  itemsSheet.getRow(1).font = { bold: true };
  itemsSheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE0E0E0" },
  };

  // 2. メタデータシート
  if (options.format === "full") {
    const metaSheet = workbook.addWorksheet("メタデータ");
    metaSheet.columns = [
      { header: "キー", key: "key", width: 30 },
      { header: "値", key: "value", width: 100 },
    ];

    metaSheet.addRow({ key: "version", value: EXPORT_VERSION });
    metaSheet.addRow({ key: "exportDate", value: new Date().toISOString() });
    metaSheet.addRow({ key: "eventName", value: eventName });

    if (additionalData.metadata) {
      metaSheet.addRow({
        key: "spreadsheetUrl",
        value: additionalData.metadata.spreadsheetUrl || "",
      });
      metaSheet.addRow({
        key: "spreadsheetSheetName",
        value: additionalData.metadata.spreadsheetSheetName || "",
      });
      metaSheet.addRow({
        key: "lastImportDate",
        value: additionalData.metadata.lastImportDate || "",
      });
    }

    if (options.includeMapData) {
      const eventSettings = [
        [
          "mapRotationSettings",
          additionalData.mapRotationSettings?.[eventName],
        ],
        [
          "mapViewportSettings",
          additionalData.mapViewportSettings?.[eventName],
        ],
        [
          "blockDetectionSettings",
          additionalData.blockDetectionSettings?.[eventName],
        ],
      ] as const;

      eventSettings.forEach(([key, value]) => {
        if (value === undefined) return;
        metaSheet.addRow({ key, value: JSON.stringify(value) });
      });
    }

    metaSheet.getRow(1).font = { bold: true };
  }

  // 3. 配置情報シート
  if (options.includeLayoutInfo && options.format === "full") {
    const layoutSheet = workbook.addWorksheet("配置情報");
    layoutSheet.columns = [
      { header: "タイプ", key: "type", width: 20 },
      { header: "参加日", key: "eventDate", width: 12 },
      { header: "データ", key: "data", width: 100 },
    ];

    // 実行モードアイテム
    const eventExecuteItems =
      additionalData.executeModeItems?.[eventName] || {};
    Object.entries(eventExecuteItems).forEach(([eventDate, itemIds]) => {
      layoutSheet.addRow({
        type: "executeModeItems",
        eventDate,
        data: JSON.stringify(itemIds),
      });
    });

    // 日モード
    const eventDayModes = additionalData.dayModes?.[eventName] || {};
    Object.entries(eventDayModes).forEach(([eventDate, mode]) => {
      layoutSheet.addRow({
        type: "dayModes",
        eventDate,
        data: mode,
      });
    });

    layoutSheet.getRow(1).font = { bold: true };
  }

  // 4. マップデータシート
  if (options.includeMapData && options.format === "full") {
    const eventMapData = additionalData.mapData?.[eventName];
    if (eventMapData) {
      const mapSheet = workbook.addWorksheet("マップデータ");
      mapSheet.columns = [
        { header: "マップ名", key: "mapName", width: 20 },
        { header: "データ", key: "data", width: 200 },
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
  if (options.includeRouteInfo && options.format === "full") {
    const routeSheet = workbook.addWorksheet("ルート情報");
    routeSheet.columns = [
      { header: "タイプ", key: "type", width: 20 },
      { header: "マップ名", key: "mapName", width: 20 },
      { header: "データ", key: "data", width: 200 },
    ];

    // ルート設定
    const eventRouteSettings = additionalData.routeSettings?.[eventName];
    if (eventRouteSettings) {
      Object.entries(eventRouteSettings).forEach(([mapName, data]) => {
        routeSheet.addRow({
          type: "routeSettings",
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
          type: "hallDefinitions",
          mapName,
          data: JSON.stringify(data),
        });
      });
    }

    // ホールルート設定
    const eventHallRouteSettings =
      additionalData.hallRouteSettings?.[eventName];
    if (eventHallRouteSettings) {
      Object.entries(eventHallRouteSettings).forEach(([mapName, data]) => {
        routeSheet.addRow({
          type: "hallRouteSettings",
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
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/**
 * xlsxファイルからデータをインポート
 */
export async function importFromXlsx(
  file: File,
): Promise<EventWorkbookImportResult> {
  const result: EventWorkbookImportResult = {
    success: false,
    eventName: "",
    items: [],
    errors: [],
  };

  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    const metaSheet = workbook.getWorksheet("メタデータ");
    const metaMap = new Map<string, string>();
    if (metaSheet) {
      metaSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const key = String(row.getCell(1).value || "");
        const value = String(row.getCell(2).value || "");
        if (key) metaMap.set(key, value);
      });
    }

    // 1. アイテムデータシートを読み込み
    const itemsSheet = workbook.getWorksheet("アイテムデータ");
    if (!itemsSheet) {
      result.errors.push("アイテムデータシートが見つかりません");
      return result;
    }

    const itemHeaderColumns = new Map<string, number>();
    itemsSheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
      const header = String(cell.value ?? "").trim();
      if (header && !itemHeaderColumns.has(header)) {
        itemHeaderColumns.set(header, column);
      }
    });
    const catalogPriceColumn = itemHeaderColumns.get("カタログ価格");
    const sheetRemarksColumn = itemHeaderColumns.get("シート備考");
    const hasCatalogPriceColumn = catalogPriceColumn !== undefined;
    const hasSheetRemarksColumn = sheetRemarksColumn !== undefined;
    if (hasCatalogPriceColumn !== hasSheetRemarksColumn) {
      result.errors.push(
        "アイテムデータの「カタログ価格」と「シート備考」は両方の列が必要です。ファイルが破損している可能性があります。",
      );
      return result;
    }
    const hasSheetDerivedColumns =
      hasCatalogPriceColumn && hasSheetRemarksColumn;
    if (!hasSheetDerivedColumns && metaMap.get("version") === EXPORT_VERSION) {
      result.errors.push(
        `バージョン${EXPORT_VERSION}の完全版に「カタログ価格」または「シート備考」がありません。ファイルが破損している可能性があります。`,
      );
      return result;
    }

    const items: ShoppingItem[] = [];
    const itemFallbackWarnings: ItemFallbackWarning[] = [];
    const legacySheetFieldFallbacks: LegacySheetFieldFallback[] = [];
    const validPurchaseStatuses = new Set<string>(
      PurchaseStatuses as readonly string[],
    );

    itemsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // ヘッダーをスキップ

      const rowReasons: string[] = [];

      const rawId = String(row.getCell(1).value ?? "").trim();
      const itemId = rawId || crypto.randomUUID();
      if (!rawId) {
        rowReasons.push("IDが空のため自動採番しました");
      }

      const circle = String(row.getCell(2).value ?? "");
      const eventDate = String(row.getCell(3).value ?? "");
      const block = String(row.getCell(4).value ?? "");
      const number = String(row.getCell(5).value ?? "");
      const title = String(row.getCell(6).value ?? "");

      const rawPrice = row.getCell(7).value;
      let price: number | null = null;
      if (
        rawPrice !== null &&
        rawPrice !== undefined &&
        String(rawPrice).trim() !== ""
      ) {
        const parsedPrice = Number(rawPrice);
        if (Number.isFinite(parsedPrice)) {
          price = parsedPrice;
        } else {
          rowReasons.push(
            `価格「${String(rawPrice)}」は不正のため空値で補完しました`,
          );
        }
      }

      const rawQuantity = row.getCell(8).value;
      const parsedQuantity = parseStrictPositiveIntegerCell(rawQuantity);
      let quantity = 1;
      if (parsedQuantity.kind === "value") {
        quantity = parsedQuantity.value;
      } else {
        const raw =
          parsedQuantity.kind === "invalid"
            ? `「${parsedQuantity.raw}」`
            : "空欄";
        rowReasons.push(`購入予定量${raw}は不正のため1で補完しました`);
      }

      if (!Number.isInteger(quantity)) {
        quantity = Math.max(1, Math.floor(quantity));
      }

      const rawPurchaseStatus = String(row.getCell(9).value ?? "").trim();
      const purchaseStatus: ShoppingItem["purchaseStatus"] =
        validPurchaseStatuses.has(rawPurchaseStatus)
          ? (rawPurchaseStatus as ShoppingItem["purchaseStatus"])
          : "None";
      if (rawPurchaseStatus && !validPurchaseStatuses.has(rawPurchaseStatus)) {
        rowReasons.push(
          `ステータス「${rawPurchaseStatus}」は不正のためNoneで補完しました`,
        );
      }

      const remarks = String(row.getCell(10).value ?? "");
      const url = String(row.getCell(11).value ?? "");

      // 優先度の値を取得（列12）
      const priorityValue = String(row.getCell(12).value ?? "").trim();
      let priorityLevel: "none" | "priority" | "highest" | undefined;
      if (priorityValue === "highest") {
        priorityLevel = "highest";
      } else if (priorityValue === "priority") {
        priorityLevel = "priority";
      } else if (priorityValue === "none" || priorityValue === "") {
        priorityLevel = undefined; // 'none'は保存しない（デフォルト値）
      } else {
        rowReasons.push(
          `優先度「${priorityValue}」は不正のため未設定で補完しました`,
        );
      }

      // 保護レベルの値を取得（列13）
      const protectionValue = String(row.getCell(13).value ?? "").trim();
      let protectionLevel: "full" | "deletable" | "none" | undefined;
      if (protectionValue === "full") {
        protectionLevel = "full";
      } else if (protectionValue === "deletable") {
        protectionLevel = "deletable";
      } else if (protectionValue === "none") {
        protectionLevel = "none";
      } else {
        protectionLevel = undefined; // 未設定
        if (protectionValue) {
          rowReasons.push(
            `保護レベル「${protectionValue}」は不正のため未設定で補完しました`,
          );
        }
      }

      // 追加元の値を取得（列14）
      const sourceValue = String(row.getCell(14).value ?? "").trim();
      let source: "spreadsheet" | "app" | undefined;
      if (sourceValue === "app") {
        source = "app";
      } else if (sourceValue === "spreadsheet") {
        source = "spreadsheet";
      } else {
        source = undefined; // 未設定
        if (sourceValue) {
          rowReasons.push(
            `追加元「${sourceValue}」は不正のため未設定で補完しました`,
          );
        }
      }

      let catalogPrice: number | null | undefined;
      let sheetRemarks: string | undefined;
      let usedLegacySheetFieldFallback = false;
      if (hasSheetDerivedColumns) {
        const parsedCatalogPrice = parseFiniteNumberCell(
          row.getCell(catalogPriceColumn!).value,
        );
        if (parsedCatalogPrice.kind === "value") {
          catalogPrice = parsedCatalogPrice.value;
        } else if (parsedCatalogPrice.kind === "empty") {
          if (source === "spreadsheet") {
            catalogPrice = null;
          }
        } else {
          rowReasons.push(
            `カタログ価格「${parsedCatalogPrice.raw}」は不正のため空値で補完しました`,
          );
          if (source === "spreadsheet") {
            catalogPrice = null;
          }
        }

        const parsedSheetRemarks = row.getCell(sheetRemarksColumn!).text;
        if (source === "spreadsheet" || parsedSheetRemarks !== "") {
          sheetRemarks = parsedSheetRemarks;
        }
      } else if (source === "spreadsheet") {
        catalogPrice = price;
        sheetRemarks = remarks;
        usedLegacySheetFieldFallback = true;
      }

      // 手動ホールIDを取得（列15、後方互換: 古いファイルは空）
      const manualHallValue = String(row.getCell(15).value ?? "").trim();
      const manualHallId = manualHallValue || undefined;
      const parsedLimitedPurchasedQuantity = parseStrictPositiveIntegerCell(
        row.getCell(16).value,
      );
      let limitedPurchasedQuantity: number | undefined;

      if (parsedLimitedPurchasedQuantity.kind === "value") {
        limitedPurchasedQuantity = parsedLimitedPurchasedQuantity.value;
      } else if (parsedLimitedPurchasedQuantity.kind === "invalid") {
        rowReasons.push(
          `限数実購入数「${parsedLimitedPurchasedQuantity.raw}」は不正のため未入力にしました`,
        );
      }

      if (
        purchaseStatus === "LimitedPurchase" &&
        limitedPurchasedQuantity !== undefined
      ) {
        const validation = validateLimitedPurchaseQuantities(
          limitedPurchasedQuantity,
          quantity,
        );
        if (!validation.ok) {
          rowReasons.push(
            `限数実購入数「${limitedPurchasedQuantity}」は購入予定量「${quantity}」に対して不正のため未入力にしました`,
          );
          limitedPurchasedQuantity = undefined;
        }
      }

      if (
        purchaseStatus !== "LimitedPurchase" &&
        limitedPurchasedQuantity !== undefined
      ) {
        rowReasons.push("限数以外の限数実購入数は無視しました");
        limitedPurchasedQuantity = undefined;
      }

      const item: ShoppingItem = normalizeLimitedPurchaseFields({
        id: itemId,
        circle,
        eventDate,
        block,
        number,
        title,
        price,
        ...(catalogPrice !== undefined ? { catalogPrice } : {}),
        quantity,
        purchaseStatus,
        remarks,
        ...(sheetRemarks !== undefined ? { sheetRemarks } : {}),
        url,
        ...(priorityLevel !== undefined ? { priorityLevel } : {}),
        ...(protectionLevel !== undefined ? { protectionLevel } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(manualHallId !== undefined ? { manualHallId } : {}),
        ...(limitedPurchasedQuantity !== undefined
          ? { limitedPurchasedQuantity }
          : {}),
      });

      if (item.circle || item.title) {
        items.push(item);
        if (usedLegacySheetFieldFallback) {
          legacySheetFieldFallbacks.push({
            itemId: item.id,
            rowNumber,
          });
        }
        if (rowReasons.length > 0) {
          itemFallbackWarnings.push({
            itemId: item.id,
            rowNumber,
            reasons: rowReasons,
          });
        }
      }
    });

    result.items = items;
    if (itemFallbackWarnings.length > 0) {
      result.itemFallbackWarnings = itemFallbackWarnings;
    }
    if (legacySheetFieldFallbacks.length > 0) {
      result.legacySheetFieldFallbacks = legacySheetFieldFallbacks;
    }

    // 2. メタデータシートを読み込み
    if (metaSheet) {
      result.eventName = metaMap.get("eventName") || "";

      if (metaMap.has("spreadsheetUrl")) {
        result.metadata = {
          spreadsheetUrl: metaMap.get("spreadsheetUrl") || "",
          spreadsheetSheetName: metaMap.get("spreadsheetSheetName") || "",
          lastImportDate: metaMap.get("lastImportDate") || "",
        };
      }

      const parseJsonMetadata = (key: string, label: string): unknown => {
        const serialized = metaMap.get(key);
        if (serialized === undefined || serialized === "") return undefined;
        try {
          return JSON.parse(serialized) as unknown;
        } catch {
          throw new Error(`${label}をJSONとして解析できません。`);
        }
      };

      try {
        const mapRotationSettings = parseJsonMetadata(
          "mapRotationSettings",
          "マップ回転設定",
        );
        if (mapRotationSettings !== undefined) {
          if (!isRecord(mapRotationSettings)) {
            throw new Error("マップ回転設定の形式が不正です。");
          }
          result.mapRotationSettings =
            mapRotationSettings as MapRotationSettingsStore[string];
        }

        const mapViewportSettings = parseJsonMetadata(
          "mapViewportSettings",
          "マップ表示位置",
        );
        if (mapViewportSettings !== undefined) {
          if (!isRecord(mapViewportSettings)) {
            throw new Error("マップ表示位置の形式が不正です。");
          }
          result.mapViewportSettings =
            mapViewportSettings as MapViewportSettingsStore[string];
        }

        const blockDetectionSettings = parseJsonMetadata(
          "blockDetectionSettings",
          "ブロック検出設定",
        );
        if (blockDetectionSettings !== undefined) {
          if (!isBlockDetectionSettings(blockDetectionSettings)) {
            throw new Error("ブロック検出設定の形式が不正です。");
          }
          result.blockDetectionSettings = blockDetectionSettings;
        }
      } catch (error) {
        result.errors.push(
          error instanceof Error
            ? error.message
            : "イベント設定の解析に失敗しました。",
        );
        return result;
      }
    }

    // イベント名がない場合はファイル名から推測
    if (!result.eventName) {
      const baseName = file.name.replace(/\.xlsx$/i, "");
      const generatedSimpleName =
        workbook.creator === WORKBOOK_CREATOR
          ? baseName.match(/^(.+)_\d{4}-\d{2}-\d{2}T\d{4}_simple$/)
          : null;
      result.eventName = generatedSimpleName?.[1] ?? baseName;
    }

    // 3. 配置情報シートを読み込み
    const layoutSheet = workbook.getWorksheet("配置情報");
    if (layoutSheet) {
      const executeModeItems: Record<string, string[]> = {};
      const dayModes: Record<string, string> = {};

      layoutSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const type = String(row.getCell(1).value || "");
        const eventDate = String(row.getCell(2).value || "");
        const data = String(row.getCell(3).value || "");

        try {
          if (type === "executeModeItems") {
            executeModeItems[eventDate] = JSON.parse(data);
          } else if (type === "dayModes") {
            dayModes[eventDate] = data;
          }
        } catch {
          result.errors.push("配置情報の解析エラー");
        }
      });

      if (
        Object.keys(executeModeItems).length > 0 ||
        Object.keys(dayModes).length > 0
      ) {
        result.layoutInfo = { executeModeItems, dayModes };
      }
    }

    // 4. マップデータシートを読み込み
    const mapSheet = workbook.getWorksheet("マップデータ");
    if (mapSheet) {
      const mapData: Record<string, unknown> = {};

      mapSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const mapName = String(row.getCell(1).value || "");
        const data = String(row.getCell(2).value || "");

        try {
          if (mapName && data) {
            mapData[mapName] = JSON.parse(data);
          }
        } catch {
          result.errors.push("マップデータの解析エラー");
        }
      });

      if (Object.keys(mapData).length > 0) {
        result.mapData = mapData;
      }
    }

    // 5. ルート情報シートを読み込み
    const routeSheet = workbook.getWorksheet("ルート情報");
    if (routeSheet) {
      const routeSettings: Record<string, unknown> = {};
      const hallDefinitions: Record<string, unknown[]> = {};
      const hallRouteSettings: Record<string, unknown> = {};

      routeSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const type = String(row.getCell(1).value || "");
        const mapName = String(row.getCell(2).value || "");
        const data = String(row.getCell(3).value || "");

        try {
          if (type === "routeSettings" && mapName && data) {
            routeSettings[mapName] = JSON.parse(data);
          } else if (type === "hallDefinitions" && mapName && data) {
            hallDefinitions[mapName] = JSON.parse(data);
          } else if (type === "hallRouteSettings" && mapName && data) {
            hallRouteSettings[mapName] = JSON.parse(data);
          }
        } catch {
          result.errors.push("ルート情報の解析エラー");
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
  } catch {
    console.error("Spreadsheet import failed (spreadsheet-import-failed).");
    result.errors.push("インポートエラー: ファイルを解析できませんでした");
  }

  return result;
}
