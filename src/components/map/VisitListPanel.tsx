import React from 'react';
import { ShoppingItem, BlockDefinition } from '../../types';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';

interface VisitListPanelProps {
  isOpen: boolean;
  onClose: () => void;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  blocks: BlockDefinition[];
  onJumpToCell: (row: number, col: number) => void;
}

interface VisitCellInfo {
  row: number;
  col: number;
  blockName: string;
  number: number;
  order: number;
  circles: string[];
}

const VisitListPanel: React.FC<VisitListPanelProps> = ({
  isOpen,
  onClose,
  items,
  executeModeItemIds,
  blocks,
  onJumpToCell,
}) => {
  // 訪問先のセル情報を計算
  const visitCells: VisitCellInfo[] = React.useMemo(() => {
    const cells: VisitCellInfo[] = [];
    const processedCells = new Set<string>();
    
    executeModeItemIds.forEach((itemId) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;
      
      // 該当するブロックを探す
      const block = blocks.find((b) => b.name === item.block);
      if (!block) return;
      
      // ナンバーの数値部分を抽出
      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;
      const numValue = parseInt(numStr, 10);
      
      // ブロック内の該当する数値セルを探す
      const numberCell = block.numberCells.find((c) => c.value === numValue);
      if (!numberCell) return;
      
      const key = `${numberCell.row}-${numberCell.col}`;
      
      // 同じセルは1回のみ追加
      if (processedCells.has(key)) {
        // 既存のエントリにサークル名を追加
        const existingCell = cells.find(
          (c) => c.row === numberCell.row && c.col === numberCell.col
        );
        if (existingCell && !existingCell.circles.includes(item.circle)) {
          existingCell.circles.push(item.circle);
        }
        return;
      }
      
      processedCells.add(key);
      cells.push({
        row: numberCell.row,
        col: numberCell.col,
        blockName: item.block,
        number: numValue,
        order: cells.length + 1,
        circles: [item.circle],
      });
    });
    
    return cells;
  }, [items, executeModeItemIds, blocks]);
  
  if (!isOpen) return null;
  
  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-white dark:bg-slate-800 shadow-xl z-40 flex flex-col">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <h3 className="font-semibold text-slate-900 dark:text-white">
          訪問先リスト
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      {/* リスト */}
      <div className="flex-1 overflow-y-auto">
        {visitCells.length === 0 ? (
          <div className="p-4 text-center text-slate-500 dark:text-slate-400">
            訪問先がありません
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {visitCells.map((cell) => (
              <button
                key={`${cell.row}-${cell.col}`}
                onClick={() => onJumpToCell(cell.row, cell.col)}
                className="w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 bg-red-500 text-white text-sm font-bold rounded-full">
                    {cell.order}
                  </span>
                  <div className="flex-1">
                    <div className="font-medium text-slate-900 dark:text-white">
                      {cell.blockName}-{cell.number}
                    </div>
                    <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
                      {cell.circles.join(', ')}
                    </div>
                  </div>
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      
      {/* フッター */}
      <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          合計 {visitCells.length} 箇所
        </p>
      </div>
    </div>
  );
};

export default VisitListPanel;
