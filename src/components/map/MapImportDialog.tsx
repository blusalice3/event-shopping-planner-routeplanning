import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from "react";
import {
  BlockDetectionSettings,
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  DayMapData,
  BlockDefinition,
  CellData,
} from "../../types/map";
import type { ParseMapFileResult } from "../../xlsx/domain/mapWorkbook";
import type { XlsxExecutionPort } from "../../xlsx/port/XlsxExecutionPort";
export {
  loadBlockDetectionSettings,
  saveBlockDetectionSettings,
} from "../../utils/blockDetectionSettingsStorage";

interface MapImportDialogProps {
  isOpen: boolean;
  file: File | null;
  eventName: string;
  savedSettings: BlockDetectionSettings | null;
  onImport: (
    parsedData: Record<string, DayMapData>,
    settings: BlockDetectionSettings,
    initialAngles: Record<string, number>,
  ) => void;
  onClose: () => void;
  xlsxExecutionPort: XlsxExecutionPort;
}

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const mapImportFileIds = new WeakMap<File, number>();
let nextMapImportFileId = 1;

function cloneBlockDetectionSettings(
  settings: BlockDetectionSettings,
): BlockDetectionSettings {
  return {
    ...settings,
    allowedCharTypes: { ...settings.allowedCharTypes },
  };
}

function getBlockDetectionSettingsSignature(
  settings: BlockDetectionSettings,
): string {
  return JSON.stringify({
    maxBlockNameLength: settings.maxBlockNameLength,
    allowedCharTypes: {
      katakana: settings.allowedCharTypes.katakana,
      hiragana: settings.allowedCharTypes.hiragana,
      alphabet: settings.allowedCharTypes.alphabet,
      kanji: settings.allowedCharTypes.kanji,
      digit: settings.allowedCharTypes.digit,
      symbol: settings.allowedCharTypes.symbol,
    },
    allowDigitSymbolOnly: settings.allowDigitSymbolOnly,
    minNumberCellsPerBlock: settings.minNumberCellsPerBlock,
    minMergedCellCount: settings.minMergedCellCount,
    numberCellMin: settings.numberCellMin,
    numberCellMax: settings.numberCellMax,
    maxRegionSize: settings.maxRegionSize,
    polygonThreshold: settings.polygonThreshold,
  });
}

function getParseInputSignature(
  file: File,
  settings: BlockDetectionSettings,
): string {
  let fileId = mapImportFileIds.get(file);
  if (fileId === undefined) {
    fileId = nextMapImportFileId;
    nextMapImportFileId += 1;
    mapImportFileIds.set(file, fileId);
  }

  return `${fileId}:${file.name}:${file.size}:${file.lastModified}:${file.type}:${getBlockDetectionSettingsSignature(settings)}`;
}

async function parseMapWorkbook(
  executionPort: XlsxExecutionPort,
  file: File,
  settings: BlockDetectionSettings,
  kind: "map-preview" | "map-import",
  signal: AbortSignal,
): Promise<ParseMapFileResult> {
  const input =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : await new Response(file).arrayBuffer();
  if (signal.aborted) {
    throw new DOMException("Map workbook parsing was aborted.", "AbortError");
  }
  const response = await executionPort.importWorkbook(
    { kind, input, fileName: file.name, settings },
    signal,
  );
  if (response.kind !== kind) {
    throw new Error("XLSX Worker returned an unexpected map result kind.");
  }
  return response.value;
}

// ===== ブロック名カスタムソート =====
// 先頭文字でカテゴリ分類: A-Z → a-z → ア-ン → あ-ん → 漢字 → その他
function getBlockNameCategory(name: string): number {
  if (!name || name.length === 0) return 5;
  const ch = name.charCodeAt(0);
  if (ch >= 0x41 && ch <= 0x5a) return 0; // A-Z
  if (ch >= 0x61 && ch <= 0x7a) return 1; // a-z
  if (ch >= 0x30a0 && ch <= 0x30ff) return 2; // カタカナ
  if (ch >= 0x3040 && ch <= 0x309f) return 3; // ひらがな
  if (
    (ch >= 0x4e00 && ch <= 0x9fff) ||
    (ch >= 0x3400 && ch <= 0x4dbf) ||
    (ch >= 0xf900 && ch <= 0xfaff)
  )
    return 4; // 漢字
  return 5; // その他
}

function sortBlocksByCustomOrder(blocks: BlockDefinition[]): BlockDefinition[] {
  return [...blocks].sort((a, b) => {
    const catA = getBlockNameCategory(a.name);
    const catB = getBlockNameCategory(b.name);
    if (catA !== catB) return catA - catB;
    // 漢字カテゴリは numberCells の数が少ない順
    if (catA === 4) {
      const diff = a.numberCells.length - b.numberCells.length;
      if (diff !== 0) return diff;
    }
    // 同一カテゴリ内はロケール順（数値対応）
    return a.name.localeCompare(b.name, "ja", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

// ===== 簡易マッププレビューコンポーネント =====

interface MiniMapPreviewProps {
  mapData: DayMapData;
  blocks: BlockDefinition[];
  highlightBlockName: string | null;
  sheetLabel: string;
}

const MiniMapPreview: React.FC<MiniMapPreviewProps> = ({
  mapData,
  blocks,
  highlightBlockName,
  sheetLabel,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // セルマップを作成
  const cellMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  // ブロックごとのセル集合（cellGroupsがある場合はそれを使う）
  const blockCellSets = useMemo(() => {
    const result = new Map<string, Set<string>>();
    blocks.forEach((block) => {
      const cellSet = new Set<string>();
      if (block.cellGroups && block.cellGroups.length > 0) {
        block.cellGroups.forEach((group) => {
          if (group.type === "individual" && group.cells) {
            group.cells.forEach((c) => cellSet.add(`${c.row}-${c.col}`));
          } else if (group.type === "range") {
            for (let r = group.startRow || 0; r <= (group.endRow || 0); r++) {
              for (let c = group.startCol || 0; c <= (group.endCol || 0); c++) {
                cellSet.add(`${r}-${c}`);
              }
            }
          }
        });
      } else {
        for (let r = block.startRow; r <= block.endRow; r++) {
          for (let c = block.startCol; c <= block.endCol; c++) {
            cellSet.add(`${r}-${c}`);
          }
        }
      }
      result.set(
        block.name + "_" + block.startRow + "_" + block.startCol,
        cellSet,
      );
    });
    return result;
  }, [blocks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const CELL_SIZE = 3;
    const width = mapData.maxCol * CELL_SIZE;
    const height = mapData.maxRow * CELL_SIZE;

    canvas.width = width;
    canvas.height = height;

    // 背景を白にクリア
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // セルの背景色を描画
    mapData.cells.forEach((cell) => {
      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(
          (cell.col - 1) * CELL_SIZE,
          (cell.row - 1) * CELL_SIZE,
          CELL_SIZE,
          CELL_SIZE,
        );
      }
    });

    // ブロックをハイライト
    blocks.forEach((block) => {
      const blockKey = block.name + "_" + block.startRow + "_" + block.startCol;
      const cellSet = blockCellSets.get(blockKey);
      const isHighlighted =
        highlightBlockName === null || block.name === highlightBlockName;
      const alpha = isHighlighted ? 0.45 : 0.12;
      const color = block.color || "#E3F2FD";

      // 色をRGBに分解してalpha適用
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;

      if (cellSet) {
        cellSet.forEach((key) => {
          const [rowStr, colStr] = key.split("-");
          const row = parseInt(rowStr, 10);
          const col = parseInt(colStr, 10);
          ctx.fillRect(
            (col - 1) * CELL_SIZE,
            (row - 1) * CELL_SIZE,
            CELL_SIZE,
            CELL_SIZE,
          );
        });
      }

      // ハイライト中のブロックは枠線も描画（各構成領域ごとに個別の枠）
      if (highlightBlockName && block.name === highlightBlockName) {
        ctx.strokeStyle = "#1976D2";
        ctx.lineWidth = 2;

        if (block.cellGroups && block.cellGroups.length > 0) {
          // cellGroups がある場合は各グループごとにバウンディングボックスを計算して描画
          block.cellGroups.forEach((group) => {
            let gMinRow = Infinity,
              gMinCol = Infinity;
            let gMaxRow = 0,
              gMaxCol = 0;

            if (group.type === "range") {
              gMinRow = group.startRow ?? block.startRow;
              gMinCol = group.startCol ?? block.startCol;
              gMaxRow = group.endRow ?? block.endRow;
              gMaxCol = group.endCol ?? block.endCol;
            } else if (group.cells && group.cells.length > 0) {
              group.cells.forEach((gc) => {
                gMinRow = Math.min(gMinRow, gc.row);
                gMinCol = Math.min(gMinCol, gc.col);
                gMaxRow = Math.max(gMaxRow, gc.row);
                gMaxCol = Math.max(gMaxCol, gc.col);
              });
            }

            if (gMinRow <= gMaxRow && gMinCol <= gMaxCol) {
              ctx.strokeRect(
                (gMinCol - 1) * CELL_SIZE,
                (gMinRow - 1) * CELL_SIZE,
                (gMaxCol - gMinCol + 1) * CELL_SIZE,
                (gMaxRow - gMinRow + 1) * CELL_SIZE,
              );
            }
          });
        } else {
          // cellGroups がない場合は従来どおりブロック全体のバウンディングボックス
          ctx.strokeRect(
            (block.startCol - 1) * CELL_SIZE,
            (block.startRow - 1) * CELL_SIZE,
            (block.endCol - block.startCol + 1) * CELL_SIZE,
            (block.endRow - block.startRow + 1) * CELL_SIZE,
          );
        }
      }
    });
  }, [mapData, blocks, highlightBlockName, cellMap, blockCellSets]);

  return (
    <div>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
        {sheetLabel}
      </p>
      <div className="max-h-[200px] overflow-auto rounded border border-slate-200 dark:border-slate-600">
        <canvas ref={canvasRef} className="block [image-rendering:pixelated]" />
      </div>
    </div>
  );
};

// ===== メインダイアログ =====

const MapImportDialog: React.FC<MapImportDialogProps> = ({
  isOpen,
  file,
  eventName,
  savedSettings,
  onImport,
  onClose,
  xlsxExecutionPort,
}) => {
  const [settings, setSettings] = useState<BlockDetectionSettings>(
    cloneBlockDetectionSettings(
      savedSettings || DEFAULT_BLOCK_DETECTION_SETTINGS,
    ),
  );
  const [isAccordionOpen, setIsAccordionOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<Record<
    string,
    DayMapData
  > | null>(null);
  const [previewSkippedSheets, setPreviewSkippedSheets] = useState<string[]>(
    [],
  );
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);
  const [highlightBlock, setHighlightBlock] = useState<string | null>(null);
  const [activePreviewSheet, setActivePreviewSheet] = useState<string>("");
  const [initialAngles, setInitialAngles] = useState<Record<string, number>>(
    {},
  );
  const parseRequestTokenRef = useRef(0);
  const parseAbortControllerRef = useRef<AbortController | null>(null);
  const currentParseSignature = useMemo(
    () => (file ? getParseInputSignature(file, settings) : null),
    [file, settings],
  );
  const currentParseSignatureRef = useRef(currentParseSignature);
  currentParseSignatureRef.current = currentParseSignature;
  const latestSavedSettingsRef = useRef(savedSettings);
  latestSavedSettingsRef.current = savedSettings;
  const savedSettingsSignature = useMemo(
    () =>
      getBlockDetectionSettingsSignature(
        savedSettings || DEFAULT_BLOCK_DETECTION_SETTINGS,
      ),
    [savedSettings],
  );

  useEffect(
    () => () => {
      parseRequestTokenRef.current += 1;
      parseAbortControllerRef.current?.abort();
      parseAbortControllerRef.current = null;
    },
    [],
  );

  const invalidatePreviewForInputChange = useCallback(() => {
    parseRequestTokenRef.current += 1;
    parseAbortControllerRef.current?.abort();
    parseAbortControllerRef.current = null;
    setIsPreviewing(false);
    setIsLoading(false);
    setPreviewData(null);
    setPreviewSkippedSheets([]);
    setPreviewSignature(null);
  }, []);

  // ダイアログを開いたとき、または保存設定の内容が変わったときだけ初期化
  useEffect(() => {
    invalidatePreviewForInputChange();
    if (isOpen) {
      setSettings(
        cloneBlockDetectionSettings(
          latestSavedSettingsRef.current || DEFAULT_BLOCK_DETECTION_SETTINGS,
        ),
      );
      setIsAccordionOpen(false);
      setHighlightBlock(null);
      setActivePreviewSheet("");
      setInitialAngles({});
    }
  }, [
    eventName,
    invalidatePreviewForInputChange,
    isOpen,
    savedSettingsSignature,
  ]);

  // ファイル差し替えではユーザーが調整した検出設定を維持し、解析結果だけ失効
  useEffect(() => {
    invalidatePreviewForInputChange();
    setHighlightBlock(null);
    setActivePreviewSheet("");
    setInitialAngles({});
  }, [file, invalidatePreviewForInputChange]);

  const notifySkippedSheets = useCallback((skippedSheets: string[]) => {
    if (skippedSheets.length === 0) return;
    const uniqueSheets = Array.from(new Set(skippedSheets));
    alert(
      `次のシートは解析に失敗したためスキップしました:\n${uniqueSheets.join("\n")}`,
    );
  }, []);

  useEffect(() => {
    if (!previewData) return;
    const sheetNames = Object.keys(previewData);
    if (sheetNames.length === 0) return;
    setInitialAngles((prev) => {
      let changed = false;
      const next = { ...prev };
      sheetNames.forEach((sheetName) => {
        if (
          typeof next[sheetName] !== "number" ||
          Number.isNaN(next[sheetName])
        ) {
          next[sheetName] = 0;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [previewData]);

  // プレビュー実行
  const handlePreview = useCallback(async () => {
    if (!file || !currentParseSignature) return;
    const requestToken = parseRequestTokenRef.current + 1;
    parseRequestTokenRef.current = requestToken;
    const requestSignature = currentParseSignature;
    parseAbortControllerRef.current?.abort();
    const controller = new AbortController();
    parseAbortControllerRef.current = controller;
    const isCurrentRequest = () =>
      parseRequestTokenRef.current === requestToken &&
      currentParseSignatureRef.current === requestSignature;

    setIsPreviewing(true);
    try {
      const parsedResult = await parseMapWorkbook(
        xlsxExecutionPort,
        file,
        settings,
        "map-preview",
        controller.signal,
      );
      if (!isCurrentRequest()) return;

      if (parsedResult.error) {
        setPreviewData(null);
        setPreviewSkippedSheets([]);
        setPreviewSignature(null);
        alert(`プレビューに失敗しました: ${parsedResult.error}`);
        return;
      }

      setPreviewData(parsedResult.data);
      setPreviewSkippedSheets(parsedResult.skippedSheets);
      setPreviewSignature(parsedResult.data ? requestSignature : null);
      notifySkippedSheets(parsedResult.skippedSheets);

      if (parsedResult.data) {
        const firstKey = Object.keys(parsedResult.data)[0];
        if (firstKey) setActivePreviewSheet(firstKey);
      } else {
        setActivePreviewSheet("");
        alert("マップデータの解析に失敗しました。");
      }
    } catch {
      if (!isCurrentRequest()) return;
      console.error("Map preview failed (map-preview-failed).");
      setPreviewData(null);
      setPreviewSkippedSheets([]);
      setPreviewSignature(null);
      alert("プレビューに失敗しました。");
    } finally {
      if (parseRequestTokenRef.current === requestToken) {
        setIsPreviewing(false);
      }
      if (parseAbortControllerRef.current === controller) {
        parseAbortControllerRef.current = null;
      }
    }
  }, [
    currentParseSignature,
    file,
    settings,
    notifySkippedSheets,
    xlsxExecutionPort,
  ]);

  // インポート実行
  const handleImport = useCallback(async () => {
    if (!file || !currentParseSignature) return;
    const requestToken = parseRequestTokenRef.current + 1;
    parseRequestTokenRef.current = requestToken;
    const requestSignature = currentParseSignature;
    parseAbortControllerRef.current?.abort();
    const controller = new AbortController();
    parseAbortControllerRef.current = controller;
    const isCurrentRequest = () =>
      parseRequestTokenRef.current === requestToken &&
      currentParseSignatureRef.current === requestSignature;

    setIsPreviewing(false);
    setIsLoading(true);
    try {
      // 現在のファイルと設定で生成したプレビューだけを再利用する
      const canReusePreview =
        previewData !== null && previewSignature === requestSignature;
      let data = canReusePreview ? previewData : null;
      let skippedSheets = canReusePreview ? previewSkippedSheets : [];
      if (!data) {
        const parsedResult = await parseMapWorkbook(
          xlsxExecutionPort,
          file,
          settings,
          "map-import",
          controller.signal,
        );
        if (!isCurrentRequest()) return;

        if (parsedResult.error) {
          alert(`マップデータの取り込みに失敗しました: ${parsedResult.error}`);
          return;
        }
        data = parsedResult.data;
        skippedSheets = parsedResult.skippedSheets;
      }

      if (!isCurrentRequest()) return;
      notifySkippedSheets(skippedSheets);

      if (!data) {
        alert("マップデータの解析に失敗しました。");
        return;
      }

      const angleMap: Record<string, number> = {};
      Object.keys(data).forEach((sheetName) => {
        const rawAngle = initialAngles[sheetName];
        const angle =
          typeof rawAngle === "number" && Number.isFinite(rawAngle)
            ? rawAngle
            : 0;
        angleMap[sheetName] = normalizeRotationAngle(angle);
      });
      onImport(data, settings, angleMap);
    } catch {
      if (!isCurrentRequest()) return;
      console.error("Map import failed (map-import-failed).");
      alert("マップデータの取り込みに失敗しました。");
    } finally {
      if (parseRequestTokenRef.current === requestToken) {
        setIsLoading(false);
      }
      if (parseAbortControllerRef.current === controller) {
        parseAbortControllerRef.current = null;
      }
    }
  }, [
    currentParseSignature,
    file,
    settings,
    previewData,
    previewSignature,
    previewSkippedSheets,
    onImport,
    initialAngles,
    notifySkippedSheets,
    xlsxExecutionPort,
  ]);

  // 初期値にリセット
  const handleResetSettings = useCallback(() => {
    setSettings({ ...DEFAULT_BLOCK_DETECTION_SETTINGS });
    invalidatePreviewForInputChange();
  }, [invalidatePreviewForInputChange]);

  // 設定更新ヘルパー
  const updateSetting = useCallback(
    <K extends keyof BlockDetectionSettings>(
      key: K,
      value: BlockDetectionSettings[K],
    ) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
      invalidatePreviewForInputChange();
    },
    [invalidatePreviewForInputChange],
  );

  const updateCharType = useCallback(
    (
      charType: keyof BlockDetectionSettings["allowedCharTypes"],
      value: boolean,
    ) => {
      setSettings((prev) => ({
        ...prev,
        allowedCharTypes: { ...prev.allowedCharTypes, [charType]: value },
      }));
      invalidatePreviewForInputChange();
    },
    [invalidatePreviewForInputChange],
  );

  // プレビュー中のシートデータ
  const activePreviewMapData = useMemo(() => {
    if (!previewData || !activePreviewSheet) return null;
    return previewData[activePreviewSheet] || null;
  }, [previewData, activePreviewSheet]);

  // ソート済みブロック一覧
  const sortedPreviewBlocks = useMemo(() => {
    if (!activePreviewMapData) return [];
    return sortBlocksByCustomOrder(activePreviewMapData.blocks);
  }, [activePreviewMapData]);

  // 全シートのブロック合計数
  const totalBlockCount = useMemo(() => {
    if (!previewData) return 0;
    return Object.values(previewData).reduce(
      (sum, d) => sum + d.blocks.length,
      0,
    );
  }, [previewData]);

  // 現在の設定がデフォルトと同じか
  const isDefaultSettings = useMemo(() => {
    return (
      JSON.stringify(settings) ===
      JSON.stringify(DEFAULT_BLOCK_DETECTION_SETTINGS)
    );
  }, [settings]);

  if (!isOpen || !file) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="mx-4 flex max-h-[90vh] w-full max-w-[640px] flex-col rounded-lg bg-white shadow-xl dark:bg-slate-800">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            📋 マップデータ取り込み
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* コンテンツ（スクロール可能） */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {/* ファイル情報 */}
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <span>📄</span>
            <span className="font-medium">{file.name}</span>
            <span className="text-slate-400">
              ({(file.size / 1024).toFixed(1)} KB)
            </span>
          </div>

          {/* ===== 詳細設定アコーディオン ===== */}
          <div className="border border-slate-200 dark:border-slate-600 rounded-lg">
            <button
              onClick={() => setIsAccordionOpen(!isAccordionOpen)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg transition-colors"
            >
              <span className="flex items-center gap-2">
                ⚙️ ブロック自動検出の詳細設定
                {!isDefaultSettings && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    カスタム
                  </span>
                )}
              </span>
              <svg
                className={`w-4 h-4 transition-transform ${isAccordionOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {isAccordionOpen && (
              <div className="px-4 pb-4 space-y-4 border-t border-slate-200 dark:border-slate-600 pt-3">
                {/* ブロック名の最大文字数 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    ブロック名の最大文字数
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={settings.maxBlockNameLength}
                      onChange={(e) =>
                        updateSetting(
                          "maxBlockNameLength",
                          parseInt(e.target.value, 10),
                        )
                      }
                      className="flex-1"
                    />
                    <span className="text-sm font-mono w-8 text-center text-slate-700 dark:text-slate-300">
                      {settings.maxBlockNameLength}
                    </span>
                  </div>
                </div>

                {/* ブロック名の許可文字種 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                    ブロック名の許可文字種
                  </label>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {(
                      [
                        ["katakana", "カタカナ"],
                        ["hiragana", "ひらがな"],
                        ["alphabet", "英字"],
                        ["kanji", "漢字"],
                        ["digit", "数字"],
                        ["symbol", "記号"],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        key={key}
                        className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300"
                      >
                        <input
                          type="checkbox"
                          checked={settings.allowedCharTypes[key]}
                          onChange={(e) =>
                            updateCharType(key, e.target.checked)
                          }
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  {/* 数字+記号のみ許可サブオプション */}
                  {settings.allowedCharTypes.digit &&
                    settings.allowedCharTypes.symbol && (
                      <label className="flex items-center gap-1.5 mt-2 ml-1 text-sm text-slate-600 dark:text-slate-400">
                        <input
                          type="checkbox"
                          checked={settings.allowDigitSymbolOnly}
                          onChange={(e) =>
                            updateSetting(
                              "allowDigitSymbolOnly",
                              e.target.checked,
                            )
                          }
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span>数字+記号のみのブロック名を許可</span>
                        <span className="text-xs text-slate-400">
                          （例: 3-01）
                        </span>
                      </label>
                    )}
                </div>

                {/* 最小結合セル数 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    ブロック名セルの最小結合セル数
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1}
                      max={12}
                      value={settings.minMergedCellCount}
                      onChange={(e) =>
                        updateSetting(
                          "minMergedCellCount",
                          parseInt(e.target.value, 10),
                        )
                      }
                      className="flex-1"
                    />
                    <span className="text-sm font-mono w-8 text-center text-slate-700 dark:text-slate-300">
                      {settings.minMergedCellCount}
                    </span>
                  </div>
                  {settings.minMergedCellCount <= 1 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      ⚠
                      非結合（単一）セルも走査します。候補が増えるため処理に時間がかかる場合があります。
                    </p>
                  )}
                </div>

                {/* 数値セルの範囲 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    数値セル（ブース番号）の範囲
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={settings.numberCellMax}
                      value={settings.numberCellMin}
                      onChange={(e) =>
                        updateSetting(
                          "numberCellMin",
                          Math.max(0, parseInt(e.target.value, 10) || 0),
                        )
                      }
                      className="w-20 px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-center"
                    />
                    <span className="text-sm text-slate-500">〜</span>
                    <input
                      type="number"
                      min={settings.numberCellMin}
                      max={9999}
                      value={settings.numberCellMax}
                      onChange={(e) =>
                        updateSetting(
                          "numberCellMax",
                          Math.max(
                            settings.numberCellMin,
                            parseInt(e.target.value, 10) || 1,
                          ),
                        )
                      }
                      className="w-20 px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-center"
                    />
                  </div>
                </div>

                {/* 1ブロックあたりの最小ブース番号数 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    1ブロックあたりの最小ブース番号数
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1}
                      max={20}
                      value={settings.minNumberCellsPerBlock}
                      onChange={(e) =>
                        updateSetting(
                          "minNumberCellsPerBlock",
                          parseInt(e.target.value, 10),
                        )
                      }
                      className="flex-1"
                    />
                    <span className="text-sm font-mono w-8 text-center text-slate-700 dark:text-slate-300">
                      {settings.minNumberCellsPerBlock}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    ブース番号がこの数未満の領域はブロックとして認識しません
                  </p>
                </div>

                {/* 1領域の最大セル数 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    1領域の最大セル数
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={500}
                      max={10000}
                      step={100}
                      value={settings.maxRegionSize}
                      onChange={(e) =>
                        updateSetting(
                          "maxRegionSize",
                          parseInt(e.target.value, 10),
                        )
                      }
                      className="flex-1"
                    />
                    <span className="text-sm font-mono w-16 text-center text-slate-700 dark:text-slate-300">
                      {settings.maxRegionSize}
                    </span>
                  </div>
                </div>

                {/* 多角形判定の閾値 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    多角形判定の閾値（%）
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={50}
                      max={100}
                      value={settings.polygonThreshold}
                      onChange={(e) =>
                        updateSetting(
                          "polygonThreshold",
                          parseInt(e.target.value, 10),
                        )
                      }
                      className="flex-1"
                    />
                    <span className="text-sm font-mono w-12 text-center text-slate-700 dark:text-slate-300">
                      {settings.polygonThreshold}%
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    バウンディングボックスに対するセル数の比率がこの値未満なら多角形と判定
                  </p>
                </div>

                {/* 初期値に戻すボタン */}
                <div className="pt-1">
                  <button
                    onClick={handleResetSettings}
                    disabled={isDefaultSettings}
                    className="text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ↩️ 初期値に戻す
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ===== プレビューボタン ===== */}
          <div className="flex items-center gap-3">
            <button
              onClick={handlePreview}
              disabled={isPreviewing}
              className="px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-md hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors"
            >
              {isPreviewing ? (
                <span className="flex items-center gap-1.5">
                  <svg
                    className="animate-spin w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  検出中...
                </span>
              ) : (
                "🔍 プレビュー（ブロック検出）"
              )}
            </button>
            {previewData && (
              <span className="text-sm text-green-600 dark:text-green-400">
                ✅ {totalBlockCount}ブロック検出
              </span>
            )}
          </div>

          {/* ===== プレビュー結果 ===== */}
          {previewData && (
            <div className="space-y-3 border border-slate-200 dark:border-slate-600 rounded-lg p-3 bg-slate-50 dark:bg-slate-900/30">
              {/* シートタブ（複数シートの場合） */}
              {Object.keys(previewData).length > 1 && (
                <div className="flex gap-1 overflow-x-auto pb-1">
                  {Object.keys(previewData).map((sheetName) => (
                    <button
                      key={sheetName}
                      onClick={() => {
                        setActivePreviewSheet(sheetName);
                        setHighlightBlock(null);
                      }}
                      className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors ${
                        activePreviewSheet === sheetName
                          ? "bg-blue-600 text-white"
                          : "bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-600"
                      }`}
                    >
                      {sheetName}
                    </button>
                  ))}
                </div>
              )}

              {activePreviewMapData && (
                <>
                  {/* ブロック名一覧 */}
                  <div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">
                      検出ブロック ({activePreviewMapData.blocks.length}件)
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {sortedPreviewBlocks.length === 0 ? (
                        <span className="text-xs text-slate-400 italic">
                          ブロックが検出されませんでした
                        </span>
                      ) : (
                        sortedPreviewBlocks.map((block, idx) => (
                          <button
                            key={`${block.name}-${idx}`}
                            onClick={() =>
                              setHighlightBlock(
                                highlightBlock === block.name
                                  ? null
                                  : block.name,
                              )
                            }
                            className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
                              highlightBlock === block.name
                                ? "bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-500 text-blue-800 dark:text-blue-200"
                                : "bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600"
                            }`}
                          >
                            <svg
                              className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                              viewBox="0 0 10 10"
                              aria-hidden="true"
                            >
                              <rect
                                width="10"
                                height="10"
                                rx="1"
                                fill={block.color || "#E3F2FD"}
                              />
                            </svg>
                            <span className="font-medium">{block.name}</span>
                            <span className="text-slate-400 dark:text-slate-500">
                              ({block.numberCells.length})
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  {/* 簡易マッププレビュー */}
                  <MiniMapPreview
                    mapData={activePreviewMapData}
                    blocks={activePreviewMapData.blocks}
                    highlightBlockName={highlightBlock}
                    sheetLabel={activePreviewSheet}
                  />
                </>
              )}
            </div>
          )}

          <div className="space-y-2 border border-slate-200 dark:border-slate-600 rounded-lg p-3">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              日別マップの初期角度（0〜359°、未設定は0°）
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              ここで設定した角度は「リセット」の戻り先になります。
            </p>
            {!previewData ? (
              <p className="text-xs text-slate-400 dark:text-slate-500">
                プレビュー後に日別マップごとの角度を入力できます。
              </p>
            ) : (
              <div className="space-y-2">
                {Object.keys(previewData).map((sheetName) => {
                  const angle = initialAngles[sheetName] ?? 0;
                  return (
                    <label
                      key={sheetName}
                      className="flex items-center justify-between gap-3 text-sm text-slate-700 dark:text-slate-300"
                    >
                      <span className="font-medium">{sheetName}</span>
                      <input
                        type="number"
                        min={0}
                        max={359}
                        step={1}
                        value={angle}
                        onChange={(e) => {
                          const parsed = Number(e.target.value);
                          const safeValue =
                            Number.isFinite(parsed) && !Number.isNaN(parsed)
                              ? Math.max(0, Math.min(359, parsed))
                              : 0;
                          setInitialAngles((prev) => ({
                            ...prev,
                            [sheetName]: safeValue,
                          }));
                        }}
                        className="w-24 px-2 py-1 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-right"
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 rounded-b-lg flex-shrink-0">
          <div className="text-xs text-slate-400">
            {!isDefaultSettings && "⚙️ カスタム設定が適用されます"}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={handleImport}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50"
            >
              {isLoading ? "取り込み中..." : "取り込む"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MapImportDialog;
