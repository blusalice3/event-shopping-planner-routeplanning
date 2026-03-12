import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { DayMapData, BlockDefinition, CellData, NumberCellInfo, CellGroup } from '../../types';

interface BlockDefinitionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  mapData: DayMapData;
  onUpdateBlocks: (blocks: BlockDefinition[]) => void;
  onStartCellSelection: (
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual',
    editingData?: unknown,
  ) => void;
  pendingCellSelection?: {
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null;
  onClearPendingCellSelection?: () => void;
}

const BLOCK_COLORS = [
  '#E3F2FD',
  '#E8F5E9',
  '#FFF3E0',
  '#F3E5F5',
  '#E0F7FA',
  '#FBE9E7',
  '#F1F8E9',
  '#FCE4EC',
  '#E8EAF6',
  '#FFFDE7',
  '#EFEBE9',
  '#ECEFF1',
];

type SortDirection = 'asc' | 'desc';
type EditMode = 'normal' | 'multi' | 'wall';

interface MultiRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

interface EditingBlockData {
  block: Partial<BlockDefinition>;
  isAddingNew: boolean;
  selectedIndex: number | null;
  editMode: EditMode;
  wallCellGroups: CellGroup[];
  multiRanges: MultiRange[];
  currentBlocks: BlockDefinition[];
}

const BlockDefinitionPanel: React.FC<BlockDefinitionPanelProps> = ({
  isOpen,
  onClose,
  mapData,
  onUpdateBlocks,
  onStartCellSelection,
  pendingCellSelection,
  onClearPendingCellSelection,
}) => {
  const [blocks, setBlocks] = useState<BlockDefinition[]>(mapData.blocks);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(null);
  const [editingBlock, setEditingBlock] = useState<Partial<BlockDefinition> | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [editMode, setEditMode] = useState<EditMode>('normal');
  const [wallCellGroups, setWallCellGroups] = useState<CellGroup[]>([]);
  const [multiRanges, setMultiRanges] = useState<MultiRange[]>([]);

  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => map.set(`${cell.row}-${cell.col}`, cell));
    return map;
  }, [mapData.cells]);

  const sortedBlocks = useMemo(() => {
    return [...blocks].sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, 'ja');
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [blocks, sortDirection]);

  const detectNumberCells = useCallback(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      const cells: NumberCellInfo[] = [];
      const minR = Math.min(startRow, endRow),
        maxR = Math.max(startRow, endRow);
      const minC = Math.min(startCol, endCol),
        maxC = Math.max(startCol, endCol);
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const cell = cellsMap.get(`${r}-${c}`);
          if (cell && !cell.isMerged && cell.value !== null) {
            const num =
              typeof cell.value === 'number' ? cell.value : Number(String(cell.value).trim());
            if (!isNaN(num) && num > 0 && num <= 100) cells.push({ row: r, col: c, value: num });
          }
        }
      }
      return cells.sort((a, b) => a.value - b.value);
    },
    [cellsMap],
  );

  // セル選択結果を受け取った時の処理
  useEffect(() => {
    if (!pendingCellSelection || !isOpen) return;

    const { type, cells, editingData } = pendingCellSelection;
    const data = editingData as EditingBlockData | undefined;

    if (data) {
      // 編集中のデータを復元
      if (data.currentBlocks) setBlocks(data.currentBlocks);
      setEditingBlock(data.block);
      setIsAddingNew(data.isAddingNew);
      setSelectedBlockIndex(data.selectedIndex);
      setEditMode(data.editMode);
      setWallCellGroups(data.wallCellGroups);
      setMultiRanges(data.multiRanges || []);
    }

    // キャンセルの場合はデータ復元のみで終了
    if (type === 'cancelled') {
      if (onClearPendingCellSelection) {
        onClearPendingCellSelection();
      }
      return;
    }

    if (type === 'corner' && cells.length >= 4) {
      // 通常モードの4角選択
      const rows = cells.map((c) => c.row),
        cols = cells.map((c) => c.col);
      const range = {
        startRow: Math.min(...rows),
        startCol: Math.min(...cols),
        endRow: Math.max(...rows),
        endCol: Math.max(...cols),
      };
      const numCells = detectNumberCells(
        range.startRow,
        range.startCol,
        range.endRow,
        range.endCol,
      );
      setEditingBlock((prev) => ({ ...prev, ...range, numberCells: numCells }));
    } else if (type === 'multiCorner' && cells.length >= 4) {
      // 複数範囲モードの4角選択（1つの範囲を追加）
      const rows = cells.map((c) => c.row),
        cols = cells.map((c) => c.col);
      const newRange: MultiRange = {
        startRow: Math.min(...rows),
        startCol: Math.min(...cols),
        endRow: Math.max(...rows),
        endCol: Math.max(...cols),
      };
      setMultiRanges((prev) => [...prev, newRange]);
    } else if (type === 'rangeStart' && cells.length >= 2) {
      // 壁ブロックの範囲選択
      const [start, end] = cells;
      const g: CellGroup = {
        type: 'range',
        startRow: Math.min(start.row, end.row),
        startCol: Math.min(start.col, end.col),
        endRow: Math.max(start.row, end.row),
        endCol: Math.max(start.col, end.col),
      };
      setWallCellGroups((prev) => (prev.length >= 6 ? prev : [...prev, g]));
    } else if (type === 'individual' && cells.length > 0) {
      // 個別セル選択
      const g: CellGroup = { type: 'individual', cells: [...cells] };
      setWallCellGroups((prev) => (prev.length >= 6 ? prev : [...prev, g]));
    }

    if (onClearPendingCellSelection) {
      onClearPendingCellSelection();
    }
  }, [pendingCellSelection, isOpen, detectNumberCells, onClearPendingCellSelection]);

  // 通常モード：4角選択を開始
  const handleStartCornerSelection = useCallback(() => {
    const editingData: EditingBlockData = {
      block: editingBlock || {},
      isAddingNew,
      selectedIndex: selectedBlockIndex,
      editMode,
      wallCellGroups,
      multiRanges,
      currentBlocks: blocks,
    };
    onStartCellSelection('corner', editingData);
  }, [
    editingBlock,
    isAddingNew,
    selectedBlockIndex,
    editMode,
    wallCellGroups,
    multiRanges,
    blocks,
    onStartCellSelection,
  ]);

  // 複数範囲モード：4角選択を開始（1つの範囲を追加）
  const handleStartMultiCornerSelection = useCallback(() => {
    const editingData: EditingBlockData = {
      block: editingBlock || {},
      isAddingNew,
      selectedIndex: selectedBlockIndex,
      editMode: 'multi',
      wallCellGroups,
      multiRanges,
      currentBlocks: blocks,
    };
    onStartCellSelection('multiCorner', editingData);
  }, [
    editingBlock,
    isAddingNew,
    selectedBlockIndex,
    wallCellGroups,
    multiRanges,
    blocks,
    onStartCellSelection,
  ]);

  // 壁ブロック：範囲選択を開始
  const handleStartRangeSelection = useCallback(() => {
    const editingData: EditingBlockData = {
      block: editingBlock || {},
      isAddingNew,
      selectedIndex: selectedBlockIndex,
      editMode,
      wallCellGroups,
      multiRanges,
      currentBlocks: blocks,
    };
    onStartCellSelection('rangeStart', editingData);
  }, [
    editingBlock,
    isAddingNew,
    selectedBlockIndex,
    editMode,
    wallCellGroups,
    multiRanges,
    blocks,
    onStartCellSelection,
  ]);

  // 壁ブロック：個別セル選択を開始
  const handleStartIndividualSelection = useCallback(() => {
    const editingData: EditingBlockData = {
      block: editingBlock || {},
      isAddingNew,
      selectedIndex: selectedBlockIndex,
      editMode,
      wallCellGroups,
      multiRanges,
      currentBlocks: blocks,
    };
    onStartCellSelection('individual', editingData);
  }, [
    editingBlock,
    isAddingNew,
    selectedBlockIndex,
    editMode,
    wallCellGroups,
    multiRanges,
    blocks,
    onStartCellSelection,
  ]);

  // 壁ブロックの数値セル
  const wallBlockNumberCells = useMemo(() => {
    if (editMode !== 'wall') return [];
    const all: NumberCellInfo[] = [];
    wallCellGroups.forEach((g) => {
      if (g.type === 'range' && g.startRow && g.startCol && g.endRow && g.endCol) {
        all.push(...detectNumberCells(g.startRow, g.startCol, g.endRow, g.endCol));
      } else if (g.type === 'individual' && g.cells) {
        g.cells.forEach((c) => {
          const cell = cellsMap.get(`${c.row}-${c.col}`);
          if (cell && cell.value !== null) {
            const num =
              typeof cell.value === 'number' ? cell.value : Number(String(cell.value).trim());
            if (!isNaN(num) && num > 0 && num <= 100)
              all.push({ row: c.row, col: c.col, value: num });
          }
        });
      }
    });
    return all
      .filter((c, i, s) => i === s.findIndex((x) => x.row === c.row && x.col === c.col))
      .sort((a, b) => a.value - b.value);
  }, [editMode, wallCellGroups, detectNumberCells, cellsMap]);

  // 複数範囲モードの数値セル
  const multiRangeNumberCells = useMemo(() => {
    if (editMode !== 'multi') return [];
    const all: NumberCellInfo[] = [];
    multiRanges.forEach((range) => {
      all.push(...detectNumberCells(range.startRow, range.startCol, range.endRow, range.endCol));
    });
    return all
      .filter((c, i, s) => i === s.findIndex((x) => x.row === c.row && x.col === c.col))
      .sort((a, b) => a.value - b.value);
  }, [editMode, multiRanges, detectNumberCells]);

  // プレビュー用の数値セル
  const previewNumberCells = useMemo(() => {
    if (editMode === 'wall') return wallBlockNumberCells;
    if (editMode === 'multi') return multiRangeNumberCells;
    if (!editingBlock?.startRow || !editingBlock?.endRow) return [];
    return detectNumberCells(
      editingBlock.startRow,
      editingBlock.startCol || 1,
      editingBlock.endRow,
      editingBlock.endCol || 1,
    );
  }, [editingBlock, editMode, wallBlockNumberCells, multiRangeNumberCells, detectNumberCells]);

  const handleSaveBlock = useCallback(() => {
    if (!editingBlock?.name?.trim()) {
      alert('ブロック名を入力してください');
      return;
    }
    const name = editingBlock.name.trim();
    if (isAddingNew && blocks.find((b) => b.name === name)) {
      if (!confirm(`「${name}」は既に存在します。置き換えますか？`)) return;
      setBlocks((prev) => prev.filter((b) => b.name !== name));
    }

    let saved: BlockDefinition;

    if (editMode === 'wall') {
      // 壁ブロック
      if (!wallCellGroups.length) {
        alert('セル群を定義してください');
        return;
      }
      let minR = Infinity,
        minC = Infinity,
        maxR = 0,
        maxC = 0;
      wallCellGroups.forEach((g) => {
        if (g.type === 'range') {
          minR = Math.min(minR, g.startRow || Infinity);
          minC = Math.min(minC, g.startCol || Infinity);
          maxR = Math.max(maxR, g.endRow || 0);
          maxC = Math.max(maxC, g.endCol || 0);
        } else if (g.cells)
          g.cells.forEach((c) => {
            minR = Math.min(minR, c.row);
            minC = Math.min(minC, c.col);
            maxR = Math.max(maxR, c.row);
            maxC = Math.max(maxC, c.col);
          });
      });
      saved = {
        name,
        startRow: minR,
        startCol: minC,
        endRow: maxR,
        endCol: maxC,
        numberCells: wallBlockNumberCells,
        color: editingBlock.color || BLOCK_COLORS[0],
        isAutoDetected: false,
        isWallBlock: true,
        cellGroups: [...wallCellGroups],
      };
    } else if (editMode === 'multi') {
      // 複数範囲ブロック
      if (multiRanges.length === 0) {
        alert('少なくとも1つの範囲を定義してください');
        return;
      }
      let minR = Infinity,
        minC = Infinity,
        maxR = 0,
        maxC = 0;
      multiRanges.forEach((r) => {
        minR = Math.min(minR, r.startRow);
        minC = Math.min(minC, r.startCol);
        maxR = Math.max(maxR, r.endRow);
        maxC = Math.max(maxC, r.endCol);
      });
      // cellGroupsとして保存
      const cellGroups: CellGroup[] = multiRanges.map((r) => ({
        type: 'range' as const,
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: r.endRow,
        endCol: r.endCol,
      }));
      saved = {
        name,
        startRow: minR,
        startCol: minC,
        endRow: maxR,
        endCol: maxC,
        numberCells: multiRangeNumberCells,
        color: editingBlock.color || BLOCK_COLORS[0],
        isAutoDetected: false,
        isWallBlock: false,
        cellGroups,
      };
    } else {
      // 通常ブロック
      if (!editingBlock.startRow || !editingBlock.endRow) {
        alert('マップ上で4つの角をクリックして範囲を指定してください');
        return;
      }
      saved = {
        name,
        startRow: editingBlock.startRow,
        startCol: editingBlock.startCol || 1,
        endRow: editingBlock.endRow,
        endCol: editingBlock.endCol || 1,
        numberCells: previewNumberCells,
        color: editingBlock.color || BLOCK_COLORS[0],
        isAutoDetected: false,
        isWallBlock: false,
      };
    }

    if (isAddingNew) setBlocks((prev) => [...prev, saved]);
    else if (selectedBlockIndex !== null) {
      const orig = sortedBlocks[selectedBlockIndex];
      setBlocks((prev) => prev.map((b) => (b.name === orig.name ? saved : b)));
    }
    setEditingBlock(null);
    setSelectedBlockIndex(null);
    setIsAddingNew(false);
    setWallCellGroups([]);
    setMultiRanges([]);
  }, [
    editingBlock,
    isAddingNew,
    selectedBlockIndex,
    editMode,
    wallCellGroups,
    multiRanges,
    wallBlockNumberCells,
    multiRangeNumberCells,
    previewNumberCells,
    blocks,
    sortedBlocks,
  ]);

  const handleCancelEdit = useCallback(() => {
    setEditingBlock(null);
    setSelectedBlockIndex(null);
    setIsAddingNew(false);
    setWallCellGroups([]);
    setMultiRanges([]);
    setEditMode('normal');
  }, []);

  // モード切り替え
  const handleSwitchMode = useCallback((newMode: EditMode) => {
    setEditMode(newMode);
    setWallCellGroups([]);
    setMultiRanges([]);
    // 範囲情報をリセット
    if (newMode !== 'normal') {
      setEditingBlock((prev) =>
        prev ? { ...prev, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } : prev,
      );
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">ブロック定義</h2>
          <button
            onClick={() => {
              setBlocks(mapData.blocks);
              onClose();
            }}
            className="text-2xl text-slate-500 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-2 gap-6">
            {/* 左: ブロック一覧 */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  定義済み ({blocks.length}件)
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
                    className="px-2 py-1 text-xs rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
                  >
                    {sortDirection === 'asc' ? '↑昇順' : '↓降順'}
                  </button>
                  <button
                    onClick={() => {
                      setIsAddingNew(true);
                      setSelectedBlockIndex(null);
                      setEditMode('normal');
                      setEditingBlock({
                        name: '',
                        startRow: 0,
                        startCol: 0,
                        endRow: 0,
                        endCol: 0,
                        numberCells: [],
                        color: BLOCK_COLORS[blocks.length % BLOCK_COLORS.length],
                      });
                      setWallCellGroups([]);
                      setMultiRanges([]);
                    }}
                    className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    + 新規
                  </button>
                  <button
                    onClick={() => confirm('全て削除？') && setBlocks([])}
                    className="px-3 py-1.5 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200"
                  >
                    全削除
                  </button>
                </div>
              </div>
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {sortedBlocks.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-8">ブロックなし</p>
                ) : (
                  sortedBlocks.map((b, i) => (
                    <div
                      key={`${b.name}-${i}`}
                      className={`p-3 rounded-lg border cursor-pointer ${selectedBlockIndex === i ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                      onClick={() => {
                        setSelectedBlockIndex(i);
                        setEditingBlock({ ...b });
                        setIsAddingNew(false);
                        // モード判定
                        if (b.isWallBlock) {
                          setEditMode('wall');
                          setWallCellGroups(b.cellGroups ? [...b.cellGroups] : []);
                          setMultiRanges([]);
                        } else if (b.cellGroups && b.cellGroups.length > 0) {
                          setEditMode('multi');
                          setWallCellGroups([]);
                          setMultiRanges(
                            b.cellGroups
                              .filter((g) => g.type === 'range')
                              .map((g) => ({
                                startRow: g.startRow || 0,
                                startCol: g.startCol || 0,
                                endRow: g.endRow || 0,
                                endCol: g.endCol || 0,
                              })),
                          );
                        } else {
                          setEditMode('normal');
                          setWallCellGroups([]);
                          setMultiRanges([]);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-8 h-8 rounded flex items-center justify-center text-sm font-bold"
                            style={{ backgroundColor: b.color || '#E3F2FD' }}
                          >
                            {b.name}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-900 dark:text-white">
                              {b.name}
                              {b.isWallBlock && (
                                <span className="ml-2 text-xs text-orange-600 dark:text-orange-400">
                                  [壁]
                                </span>
                              )}
                              {!b.isWallBlock && b.cellGroups && b.cellGroups.length > 0 && (
                                <span className="ml-2 text-xs text-purple-600 dark:text-purple-400">
                                  [複数範囲]
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {b.numberCells.length}セル
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`「${b.name}」を削除？`)) {
                              setBlocks((prev) => prev.filter((x) => x.name !== b.name));
                              setSelectedBlockIndex(null);
                              setEditingBlock(null);
                            }
                          }}
                          className="p-1 text-red-500 hover:text-red-700"
                        >
                          🗑️
                        </button>
                      </div>
                      {b.isAutoDetected && (
                        <div className="mt-1 text-xs text-blue-600 dark:text-blue-400">
                          ⚡自動検出
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 右: 編集 */}
            <div>
              {editingBlock ? (
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      {isAddingNew ? '新規追加' : '編集'}
                    </h3>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleSwitchMode('normal')}
                        className={`px-2 py-1 text-xs rounded ${editMode === 'normal' ? 'bg-blue-500 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
                      >
                        通常
                      </button>
                      <button
                        onClick={() => handleSwitchMode('multi')}
                        className={`px-2 py-1 text-xs rounded ${editMode === 'multi' ? 'bg-purple-500 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
                      >
                        複数範囲
                      </button>
                      <button
                        onClick={() => handleSwitchMode('wall')}
                        className={`px-2 py-1 text-xs rounded ${editMode === 'wall' ? 'bg-orange-500 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
                      >
                        壁
                      </button>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        ブロック名
                      </label>
                      <input
                        type="text"
                        value={editingBlock.name || ''}
                        onChange={(e) => setEditingBlock((eb) => ({ ...eb, name: e.target.value }))}
                        placeholder="例: ア, め, N"
                        className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                    </div>

                    {editMode === 'normal' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          範囲指定
                        </label>
                        <button
                          onClick={handleStartCornerSelection}
                          className="w-full px-3 py-2 text-sm rounded bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400"
                        >
                          📍 4つの角をクリックして選択
                        </button>
                        {editingBlock.startRow !== undefined &&
                          editingBlock.startRow > 0 &&
                          editingBlock.endRow !== undefined &&
                          editingBlock.endRow > 0 && (
                            <div className="mt-2 p-2 bg-green-50 dark:bg-green-900/20 rounded text-xs text-green-700 dark:text-green-400">
                              範囲: 行{editingBlock.startRow}-{editingBlock.endRow}, 列
                              {editingBlock.startCol}-{editingBlock.endCol}
                            </div>
                          )}
                      </div>
                    )}

                    {editMode === 'multi' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          複数範囲指定（Nブロックなど）
                        </label>
                        {multiRanges.length > 0 && (
                          <div className="mb-2 space-y-1">
                            {multiRanges.map((r, i) => (
                              <div
                                key={i}
                                className="flex items-center justify-between p-2 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700"
                              >
                                <span className="text-xs text-slate-600 dark:text-slate-400">
                                  範囲{i + 1}: 行{r.startRow}-{r.endRow}, 列{r.startCol}-{r.endCol}
                                </span>
                                <button
                                  onClick={() =>
                                    setMultiRanges((prev) => prev.filter((_, j) => j !== i))
                                  }
                                  className="text-red-500 text-sm"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <button
                          onClick={handleStartMultiCornerSelection}
                          className="w-full px-3 py-2 text-sm rounded bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-400"
                        >
                          📍 4つの角をクリックして範囲を追加
                        </button>
                      </div>
                    )}

                    {editMode === 'wall' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          セル群 (最大6)
                        </label>
                        {wallCellGroups.length > 0 && (
                          <div className="mb-2 space-y-1">
                            {wallCellGroups.map((g, i) => (
                              <div
                                key={i}
                                className="flex items-center justify-between p-2 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700"
                              >
                                <span className="text-xs text-slate-600 dark:text-slate-400">
                                  {g.type === 'range'
                                    ? `範囲(${g.startRow},${g.startCol})-(${g.endRow},${g.endCol})`
                                    : `個別${g.cells?.length}セル`}
                                </span>
                                <button
                                  onClick={() =>
                                    setWallCellGroups((prev) => prev.filter((_, j) => j !== i))
                                  }
                                  className="text-red-500 text-sm"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={handleStartRangeSelection}
                            disabled={wallCellGroups.length >= 6}
                            className="flex-1 px-3 py-2 text-xs rounded bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-400"
                          >
                            + 範囲追加
                          </button>
                          <button
                            onClick={handleStartIndividualSelection}
                            disabled={wallCellGroups.length >= 6}
                            className="flex-1 px-3 py-2 text-xs rounded bg-orange-100 text-orange-700 hover:bg-orange-200 disabled:opacity-50 dark:bg-orange-900/30 dark:text-orange-400"
                          >
                            + 個別追加
                          </button>
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        色
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {BLOCK_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setEditingBlock((eb) => ({ ...eb, color: c }))}
                            className={`w-8 h-8 rounded border-2 ${editingBlock.color === c ? 'border-blue-500' : 'border-transparent'}`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="p-3 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700">
                      <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                        検出セル: {previewNumberCells.length}個
                      </div>
                      {previewNumberCells.length > 0 ? (
                        <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                          {previewNumberCells.map((c, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded"
                            >
                              {c.value}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          範囲を指定してください
                        </p>
                      )}
                    </div>

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={handleSaveBlock}
                        className="flex-1 px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {isAddingNew ? '追加' : '保存'}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="px-4 py-2 text-sm rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400">
                  <p className="mb-2">左から選択して編集</p>
                  <p className="text-sm">または「新規」で追加</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
          <button
            onClick={() => {
              setBlocks(mapData.blocks);
              onClose();
            }}
            className="px-4 py-2 text-sm rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
          >
            キャンセル
          </button>
          <button
            onClick={() => {
              onUpdateBlocks(blocks);
              onClose();
            }}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
};

export default BlockDefinitionPanel;
