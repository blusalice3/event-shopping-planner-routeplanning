import React, { useState, useMemo } from 'react';
import type { ShoppingItem } from '../../../types';

interface HelpRequestDialogProps {
  onRequestHelp: (circleName: string) => Promise<void>;
  onClose: () => void;
  items?: ShoppingItem[];
}

const HelpRequestDialog: React.FC<HelpRequestDialogProps> = ({
  onRequestHelp,
  onClose,
  items = [],
}) => {
  const [circleName, setCircleName] = useState('');
  const [selectedBlock, setSelectedBlock] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // ブロック一覧抽出（未購入アイテムから）
  const blocks = useMemo(() => {
    const blockSet = new Set(
      items
        .filter((item) => item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone')
        .map((item) => item.block)
        .filter(Boolean),
    );
    return Array.from(blockSet).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      return !isNaN(numA) && !isNaN(numB) ? numA - numB : a.localeCompare(b);
    });
  }, [items]);

  // 選択ブロック内のアイテム一覧
  const blockItems = useMemo(() => {
    if (!selectedBlock) return [];
    return items
      .filter(
        (item) =>
          item.block === selectedBlock &&
          (item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone'),
      )
      .sort((a, b) => {
        const numA = parseInt(a.number) || 0;
        const numB = parseInt(b.number) || 0;
        return numA - numB;
      });
  }, [items, selectedBlock]);

  // サークル名候補（重複除去）
  const uniqueBlockItems = useMemo(() => {
    const seen = new Set<string>();
    return blockItems.filter((item) => {
      const key = `${item.number}-${item.circle}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [blockItems]);

  const handleSubmit = async () => {
    if (!circleName.trim()) {
      setError('サークル名を入力してください');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await onRequestHelp(circleName.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-sm max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            ヘルプ要請
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            列に並んでいるサークル名を入力または選択してください。
          </p>

          {/* ブロック選択 */}
          {blocks.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                ブロックで絞り込み
              </label>
              <select
                value={selectedBlock}
                onChange={(e) => setSelectedBlock(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white"
              >
                <option value="">選択してください</option>
                {blocks.map((block) => (
                  <option key={block} value={block}>
                    {block}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* ブロック内サークル候補 */}
          {selectedBlock && uniqueBlockItems.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                サークル候補（タップで入力）
              </label>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {uniqueBlockItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setCircleName(item.circle)}
                    className={`w-full text-left px-3 py-1.5 text-sm rounded transition-colors ${
                      circleName === item.circle
                        ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="text-xs text-slate-400 dark:text-slate-500 mr-2">
                      {item.number}
                    </span>
                    {item.circle}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* サークル名手動入力 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              サークル名
            </label>
            <input
              type="text"
              value={circleName}
              onChange={(e) => setCircleName(e.target.value)}
              placeholder="列に並んでいるサークル"
              className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white focus:ring-2 focus:ring-orange-500 outline-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || !circleName.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? '送信中...' : 'ヘルプを要請'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HelpRequestDialog;
