import React from 'react';

interface CellSelectionMode {
  type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
  clickedCells: { row: number; col: number }[];
  [key: string]: any;
}

interface CellSelectionOverlayProps {
  cellSelectionMode: CellSelectionMode;
  onConfirm: () => void;
  onCancel: () => void;
}

const CellSelectionOverlay: React.FC<CellSelectionOverlayProps> = ({
  cellSelectionMode, onConfirm, onCancel,
}) => {
  const isConfirmDisabled =
    ((cellSelectionMode.type === 'corner' || cellSelectionMode.type === 'multiCorner') && cellSelectionMode.clickedCells.length < 4) ||
    (cellSelectionMode.type === 'rangeStart' && cellSelectionMode.clickedCells.length < 2) ||
    (cellSelectionMode.type === 'individual' && cellSelectionMode.clickedCells.length === 0);

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
      <div className="text-center mb-3">
        <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
          {cellSelectionMode.type === 'corner' && `📍 セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
          {cellSelectionMode.type === 'multiCorner' && `📍 セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
          {cellSelectionMode.type === 'rangeStart' && `📍 範囲の2つのセルをクリック (${cellSelectionMode.clickedCells.length}/2)`}
          {cellSelectionMode.type === 'individual' && `📍 個別セルをクリック (${cellSelectionMode.clickedCells.length}個選択中)`}
        </div>
        {cellSelectionMode.clickedCells.length > 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400">
            選択: {cellSelectionMode.clickedCells.map(c => `(${c.row},${c.col})`).join(', ')}
          </div>
        )}
        <div className="text-xs text-blue-500 dark:text-blue-400 mt-1">
          💡 マーカーをクリックで選択解除
        </div>
      </div>
      <div className="flex gap-2 justify-center">
        <button
          onClick={onConfirm}
          disabled={isConfirmDisabled}
          className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          範囲を反映
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
};

export default CellSelectionOverlay;
