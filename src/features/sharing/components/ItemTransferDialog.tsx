import React, { useState, useMemo } from 'react';
import type { ShoppingItem } from '../../../types';
import type { RoomMember } from '../types/room';

interface TransferItem {
  itemId: string;
  circle: string;
  title: string;
  block: string;
  number: string;
  quantity: number;
}

interface ItemTransferDialogProps {
  item: ShoppingItem;
  spaceItems: ShoppingItem[];
  members: RoomMember[];
  currentUserId: string | null;
  onTransfer: (transferItems: TransferItem[], targetJerseyNumber: number) => Promise<void>;
  onClose: () => void;
}

const ItemTransferDialog: React.FC<ItemTransferDialogProps> = ({
  item,
  spaceItems,
  members,
  currentUserId,
  onTransfer,
  onClose,
}) => {
  const hasSpaceItems = spaceItems.length > 1;
  const [mode, setMode] = useState<'single' | 'space'>(hasSpaceItems ? 'single' : 'single');
  const [selectedJerseyNumber, setSelectedJerseyNumber] = useState<number | null>(null);
  const [singleQuantity, setSingleQuantity] = useState(item.quantity);
  const [spaceQuantities, setSpaceQuantities] = useState<Record<string, number>>(
    () => Object.fromEntries(spaceItems.map((si) => [si.id, si.quantity])),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const otherMembers = useMemo(
    () => members.filter((m) => m.userId !== currentUserId),
    [members, currentUserId],
  );

  const handleTransfer = async () => {
    if (selectedJerseyNumber == null) return;
    setIsLoading(true);
    setError('');
    try {
      if (mode === 'single') {
        await onTransfer(
          [{ itemId: item.id, circle: item.circle, title: item.title, block: item.block, number: item.number, quantity: singleQuantity }],
          selectedJerseyNumber,
        );
      } else {
        const transferItems = spaceItems.map((si) => ({
          itemId: si.id,
          circle: si.circle,
          title: si.title,
          block: si.block,
          number: si.number,
          quantity: spaceQuantities[si.id] ?? si.quantity,
        }));
        await onTransfer(transferItems, selectedJerseyNumber);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '転送に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-md max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            アイテムを投げつけ
          </h3>
          {/* モード切替（スペースアイテムが複数ある場合のみ） */}
          {hasSpaceItems && (
            <div className="flex mt-2 gap-1">
              <button
                onClick={() => setMode('single')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  mode === 'single'
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                このアイテムのみ
              </button>
              <button
                onClick={() => setMode('space')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  mode === 'space'
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                同スペース一括 ({spaceItems.length}件)
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* アイテム情報 + 数量 */}
          {mode === 'single' ? (
            <div className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {item.block}-{item.number}
              </div>
              <div className="text-sm font-medium text-slate-800 dark:text-white">
                {item.circle}
                {item.title && <span className="text-slate-400 ml-1">{item.title}</span>}
              </div>
              <div className="flex items-center mt-2 gap-2">
                <label className="text-xs text-slate-500 dark:text-slate-400">必要数:</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={singleQuantity}
                  onChange={(e) => setSingleQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-center"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {spaceItems.map((si) => (
                <div key={si.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                  <div className="flex-1 min-w-0 mr-2">
                    <div className="text-sm text-slate-800 dark:text-white truncate">
                      {si.circle}
                      {si.title && <span className="text-xs text-slate-400 ml-1">{si.title}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <label className="text-xs text-slate-400">数:</label>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={spaceQuantities[si.id] ?? si.quantity}
                      onChange={(e) =>
                        setSpaceQuantities((prev) => ({
                          ...prev,
                          [si.id]: Math.max(1, parseInt(e.target.value) || 1),
                        }))
                      }
                      className="w-14 px-1.5 py-0.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-center"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* メンバー選択 */}
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
              転送先メンバー
            </p>
            <div className="space-y-1">
              {otherMembers.map((member) => (
                <button
                  key={member.jerseyNumber}
                  onClick={() => setSelectedJerseyNumber(member.jerseyNumber)}
                  className={`flex items-center space-x-2 w-full px-3 py-2 rounded-lg transition-colors ${
                    selectedJerseyNumber === member.jerseyNumber
                      ? 'bg-purple-100 dark:bg-purple-900/40 ring-2 ring-purple-500'
                      : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                    style={{ backgroundColor: member.color }}
                  >
                    {member.jerseyNumber}
                  </div>
                  <span className="text-sm text-slate-800 dark:text-white">
                    #{member.jerseyNumber} {member.displayName}
                  </span>
                </button>
              ))}
            </div>
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
            onClick={handleTransfer}
            disabled={isLoading || selectedJerseyNumber == null}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? '転送中...' : mode === 'single' ? '転送' : `${spaceItems.length}件を転送`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ItemTransferDialog;
