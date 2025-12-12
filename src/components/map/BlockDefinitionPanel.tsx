import React, { useState, useCallback, useMemo } from 'react';
import { DayMapData, BlockDefinition, CellData } from '../../types';

interface BlockDefinitionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  mapData: DayMapData;
  onUpdateBlocks: (blocks: BlockDefinition[]) => void;
}

// ブロック用の色パレット
const BLOCK_COLORS = [
  '#E3F2FD', // 青
  '#E8F5E9', // 緑
  '#FFF3E0', // オレンジ
  '#F3E5F5', // 紫
  '#E0F7FA', // シアン
  '#FBE9E7', // 深いオレンジ
  '#F1F8E9', // ライトグリーン
  '#FCE4EC', // ピンク
  '#E8EAF6', // インディゴ
  '#FFFDE7', // 黄色
  '#EFEBE9', // ブラウン
  '#ECEFF1', // ブルーグレー
];

const BlockDefinitionPanel: React.FC<BlockDefinitionPanelProps> = ({
  isOpen,
  onClose,
  mapData,
  onUpdateBlocks,
}) => {
  const [blocks, setBlocks] = useState<BlockDefinition[]>(mapData.blocks);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(null);
  const [editingBlock, setEditingBlock] = useState<Partial<BlockDefinition> | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);

  // セルマップを作成
  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  // 指定範囲内の数値セルを検出
  const detectNumberCells = useCallback(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      const numberCells: Array<{ row: number; col: number; value: number }> = [];

      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const cell = cellsMap.get(`${r}-${c}`);
          if (cell && !cell.isMerged && cell.value !== null) {
            const num =
              typeof cell.value === 'number'
                ? cell.value
                : parseFloat(String(cell.value));
            if (!isNaN(num) && num > 0 && num <= 100) {
              numberCells.push({ row: r, col: c, value: num });
            }
          }
        }
      }

      return numberCells;
    },
    [cellsMap]
  );

  // ブロックを削除
  const handleDeleteBlock = useCallback((index: number) => {
    if (confirm(`ブロック「${blocks[index].name}」を削除しますか？`)) {
      setBlocks((prev) => prev.filter((_, i) => i !== index));
      setSelectedBlockIndex(null);
      setEditingBlock(null);
    }
  }, [blocks]);

  // ブロックを編集開始
  const handleEditBlock = useCallback((index: number) => {
    const block = blocks[index];
    setSelectedBlockIndex(index);
    setEditingBlock({ ...block });
    setIsAddingNew(false);
  }, [blocks]);

  // 新規追加開始
  const handleStartAddNew = useCallback(() => {
    setIsAddingNew(true);
    setSelectedBlockIndex(null);
    setEditingBlock({
      name: '',
      startRow: 1,
      startCol: 1,
      endRow: 20,
      endCol: 20,
      numberCells: [],
      color: BLOCK_COLORS[blocks.length % BLOCK_COLORS.length],
    });
  }, [blocks.length]);

  // 編集フォームの値を更新
  const handleEditChange = useCallback((field: keyof BlockDefinition, value: string | number) => {
    setEditingBlock((prev) => {
      if (!prev) return prev;
      return { ...prev, [field]: value };
    });
  }, []);

  // 数値セルをプレビュー
  const previewNumberCells = useMemo(() => {
    if (!editingBlock || !editingBlock.startRow || !editingBlock.startCol || !editingBlock.endRow || !editingBlock.endCol) {
      return [];
    }
    return detectNumberCells(
      editingBlock.startRow,
      editingBlock.startCol,
      editingBlock.endRow,
      editingBlock.endCol
    );
  }, [editingBlock, detectNumberCells]);

  // ブロックを保存
  const handleSaveBlock = useCallback(() => {
    if (!editingBlock || !editingBlock.name?.trim()) {
      alert('ブロック名を入力してください');
      return;
    }

    const numberCells = detectNumberCells(
      editingBlock.startRow || 1,
      editingBlock.startCol || 1,
      editingBlock.endRow || 20,
      editingBlock.endCol || 20
    );

    const savedBlock: BlockDefinition = {
      name: editingBlock.name.trim(),
      startRow: editingBlock.startRow || 1,
      startCol: editingBlock.startCol || 1,
      endRow: editingBlock.endRow || 20,
      endCol: editingBlock.endCol || 20,
      numberCells,
      color: editingBlock.color || BLOCK_COLORS[0],
      isAutoDetected: false,
    };

    if (isAddingNew) {
      setBlocks((prev) => [...prev, savedBlock]);
    } else if (selectedBlockIndex !== null) {
      setBlocks((prev) =>
        prev.map((b, i) => (i === selectedBlockIndex ? savedBlock : b))
      );
    }

    setEditingBlock(null);
    setSelectedBlockIndex(null);
    setIsAddingNew(false);
  }, [editingBlock, isAddingNew, selectedBlockIndex, detectNumberCells]);

  // 編集キャンセル
  const handleCancelEdit = useCallback(() => {
    setEditingBlock(null);
    setSelectedBlockIndex(null);
    setIsAddingNew(false);
  }, []);

  // 変更を適用
  const handleApply = useCallback(() => {
    onUpdateBlocks(blocks);
    onClose();
  }, [blocks, onUpdateBlocks, onClose]);

  // キャンセル（変更を破棄）
  const handleCancel = useCallback(() => {
    setBlocks(mapData.blocks);
    setSelectedBlockIndex(null);
    setEditingBlock(null);
    setIsAddingNew(false);
    onClose();
  }, [mapData.blocks, onClose]);

  // 全ブロックをクリア
  const handleClearAll = useCallback(() => {
    if (confirm('全てのブロック定義を削除しますか？')) {
      setBlocks([]);
      setSelectedBlockIndex(null);
      setEditingBlock(null);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            ブロック定義
          </h2>
          <button
            onClick={handleCancel}
            className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 text-2xl"
          >
            ✕
          </button>
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-2 gap-6">
            {/* 左側：ブロック一覧 */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  定義済みブロック ({blocks.length}件)
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={handleStartAddNew}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    + 新規追加
                  </button>
                  <button
                    onClick={handleClearAll}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400"
                  >
                    全削除
                  </button>
                </div>
              </div>

              {/* ブロック一覧 */}
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {blocks.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">
                    ブロックが定義されていません
                  </p>
                ) : (
                  blocks.map((block, index) => (
                    <div
                      key={index}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedBlockIndex === index
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                      }`}
                      onClick={() => handleEditBlock(index)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
                            style={{ backgroundColor: block.color || '#E3F2FD' }}
                          >
                            {block.name}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-900 dark:text-white">
                              {block.name}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              行 {block.startRow}-{block.endRow}, 列 {block.startCol}-{block.endCol}
                              {' '}({block.numberCells.length}個のナンバーセル)
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteBlock(index);
                          }}
                          className="p-1 text-red-500 hover:text-red-700 hover:bg-red-100 rounded"
                        >
                          🗑️
                        </button>
                      </div>
                      {block.isAutoDetected && (
                        <div className="mt-1 text-xs text-blue-600 dark:text-blue-400">
                          ⚡ 自動検出
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 右側：編集フォーム */}
            <div>
              {editingBlock ? (
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
                    {isAddingNew ? '新規ブロック追加' : 'ブロック編集'}
                  </h3>

                  <div className="space-y-4">
                    {/* ブロック名 */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        ブロック名
                      </label>
                      <input
                        type="text"
                        value={editingBlock.name || ''}
                        onChange={(e) => handleEditChange('name', e.target.value)}
                        placeholder="例: ア, め, A"
                        className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                    </div>

                    {/* 範囲指定 */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          開始行
                        </label>
                        <input
                          type="number"
                          value={editingBlock.startRow || 1}
                          onChange={(e) => handleEditChange('startRow', parseInt(e.target.value) || 1)}
                          min={1}
                          max={mapData.maxRow}
                          className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          終了行
                        </label>
                        <input
                          type="number"
                          value={editingBlock.endRow || 20}
                          onChange={(e) => handleEditChange('endRow', parseInt(e.target.value) || 20)}
                          min={1}
                          max={mapData.maxRow}
                          className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          開始列
                        </label>
                        <input
                          type="number"
                          value={editingBlock.startCol || 1}
                          onChange={(e) => handleEditChange('startCol', parseInt(e.target.value) || 1)}
                          min={1}
                          max={mapData.maxCol}
                          className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          終了列
                        </label>
                        <input
                          type="number"
                          value={editingBlock.endCol || 20}
                          onChange={(e) => handleEditChange('endCol', parseInt(e.target.value) || 20)}
                          min={1}
                          max={mapData.maxCol}
                          className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      </div>
                    </div>

                    {/* 色選択 */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        ブロック色
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {BLOCK_COLORS.map((color) => (
                          <button
                            key={color}
                            onClick={() => handleEditChange('color', color)}
                            className={`w-8 h-8 rounded border-2 ${
                              editingBlock.color === color
                                ? 'border-blue-500'
                                : 'border-transparent'
                            }`}
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </div>

                    {/* プレビュー */}
                    <div className="p-3 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700">
                      <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                        検出される数値セル: {previewNumberCells.length}個
                      </div>
                      {previewNumberCells.length > 0 ? (
                        <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                          {previewNumberCells.slice(0, 50).map((cell, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded"
                            >
                              {cell.value}
                            </span>
                          ))}
                          {previewNumberCells.length > 50 && (
                            <span className="text-xs text-slate-500">
                              ...他 {previewNumberCells.length - 50}個
                            </span>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500">
                          指定範囲に数値セル(1-100)が見つかりません
                        </p>
                      )}
                    </div>

                    {/* ボタン */}
                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={handleSaveBlock}
                        className="flex-1 px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {isAddingNew ? '追加' : '保存'}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400">
                  <p className="mb-2">左のリストからブロックを選択して編集</p>
                  <p className="text-sm">または「新規追加」ボタンで新しいブロックを定義</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* フッター */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3 flex-shrink-0">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
          >
            キャンセル
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
};

export default BlockDefinitionPanel;
