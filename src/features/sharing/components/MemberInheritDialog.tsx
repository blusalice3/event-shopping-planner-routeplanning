import React, { useState } from 'react';
import type { RoomMember } from '../types/room';

interface MemberInheritDialogProps {
  isOpen: boolean;
  onClose: () => void;
  members: RoomMember[];
  currentUserId: string;
  currentJerseyNumber: number;
  myItemCount: number;
  onInherit: (targetJerseyNumber: number) => Promise<void>;
}

function canInherit(
  member: RoomMember,
  currentUserId: string,
): { selectable: boolean; reason?: string } {
  if (member.userId === currentUserId) {
    return { selectable: false, reason: '現在のあなたです' };
  }
  const lastSeen = new Date(member.lastSeenAt).getTime();
  const isActive = member.isOnline || (Date.now() - lastSeen < 10 * 60 * 1000);
  if (isActive) {
    return { selectable: false, reason: 'オンライン中' };
  }
  return { selectable: true };
}

/** 事後的メンバー引き継ぎダイアログ */
const MemberInheritDialog: React.FC<MemberInheritDialogProps> = ({
  isOpen,
  onClose,
  members,
  currentUserId,
  currentJerseyNumber,
  myItemCount,
  onInherit,
}) => {
  const [selectedJersey, setSelectedJersey] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const otherMembers = members.filter((m) => m.jerseyNumber !== currentJerseyNumber);

  const handleInherit = async () => {
    if (selectedJersey == null) return;
    setIsLoading(true);
    setError('');
    try {
      await onInherit(selectedJersey);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '引き継ぎに失敗しました');
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
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">メンバー引き継ぎ</h3>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            現在あなたは <span className="font-bold">#{currentJerseyNumber}</span> として参加しています。
            元のメンバーを選択してデータを引き継ぎます。
          </p>

          <div className="space-y-1 max-h-48 overflow-y-auto">
            {otherMembers.map((member) => {
              const { selectable, reason } = canInherit(member, currentUserId);
              return (
                <button
                  key={member.jerseyNumber}
                  onClick={() => selectable && setSelectedJersey(member.jerseyNumber)}
                  disabled={!selectable}
                  className={`flex items-center justify-between w-full px-3 py-2.5 rounded-lg transition-colors ${
                    !selectable
                      ? 'opacity-50 cursor-not-allowed'
                      : selectedJersey === member.jerseyNumber
                        ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                      style={{ backgroundColor: member.color }}
                    >
                      {member.jerseyNumber}
                    </div>
                    <span className="text-sm font-medium text-slate-800 dark:text-white">
                      #{member.jerseyNumber} {member.displayName}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    {reason && (
                      <span className="text-xs text-slate-500 dark:text-slate-400">{reason}</span>
                    )}
                    {!selectable && member.isOnline && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                        選択不可
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {myItemCount > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              #{currentJerseyNumber}(あなた)に割り振られていたアイテム{myItemCount}件は引き継ぎ先に移動します。
            </p>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex justify-end space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            >
              キャンセル
            </button>
            <button
              onClick={handleInherit}
              disabled={isLoading || selectedJersey == null}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isLoading ? '引き継ぎ中...' : '引き継ぐ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemberInheritDialog;
