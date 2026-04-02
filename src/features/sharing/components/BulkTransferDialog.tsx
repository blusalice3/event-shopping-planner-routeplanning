import React, { useState, useMemo } from 'react';
import type { ShoppingItem } from '../../../types';
import type { RoomMember } from '../types/room';

interface BulkTransferDialogProps {
  items: ShoppingItem[];
  members: RoomMember[];
  currentUserId: string | null;
  onTransfer: (itemIds: string[], targetUserId: string) => Promise<void>;
  onClose: () => void;
}

const BulkTransferDialog: React.FC<BulkTransferDialogProps> = ({
  items,
  members,
  currentUserId,
  onTransfer,
  onClose,
}) => {
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const unpurchasedItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (!item.assignedTo || item.assignedTo === currentUserId) &&
          (item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone'),
      ),
    [items, currentUserId],
  );

  const otherMembers = useMemo(
    () => members.filter((m) => m.userId !== currentUserId),
    [members, currentUserId],
  );

  const handleTransfer = async () => {
    if (!selectedMemberId || unpurchasedItems.length === 0) return;
    setIsLoading(true);
    setError('');
    try {
      await onTransfer(
        unpurchasedItems.map((item) => item.id),
        selectedMemberId,
      );
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
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            アイテムを投げつけ
          </h3>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            未購入アイテム {unpurchasedItems.length} 件を選択したメンバーに一括転送します。
          </p>

          {unpurchasedItems.length === 0 ? (
            <p className="text-sm text-slate-500">転送可能なアイテムがありません。</p>
          ) : (
            <>
              <div className="space-y-1">
                {otherMembers.map((member) => (
                  <button
                    key={member.userId}
                    onClick={() => setSelectedMemberId(member.userId)}
                    className={`flex items-center space-x-3 w-full px-3 py-2 rounded-lg transition-colors ${
                      selectedMemberId === member.userId
                        ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                      style={{ backgroundColor: member.color }}
                    >
                      {member.displayName.charAt(0)}
                    </div>
                    <span className="text-sm text-slate-800 dark:text-white">
                      {member.displayName}
                    </span>
                  </button>
                ))}
              </div>

              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
            </>
          )}

          <div className="flex justify-end space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            >
              キャンセル
            </button>
            <button
              onClick={handleTransfer}
              disabled={isLoading || !selectedMemberId || unpurchasedItems.length === 0}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isLoading ? '転送中...' : `${unpurchasedItems.length}件を転送`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BulkTransferDialog;
