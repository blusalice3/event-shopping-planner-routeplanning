import React, { useState } from 'react';
import type { RoomMember } from '../types/room';

interface HostTransferDialogProps {
  isOpen: boolean;
  onClose: () => void;
  members: RoomMember[];
  currentUserId: string;
  onTransfer: (newHostUserId: string) => Promise<void>;
}

/** ホスト手動退室時の移譲先選択ダイアログ */
const HostTransferDialog: React.FC<HostTransferDialogProps> = ({
  isOpen,
  onClose,
  members,
  currentUserId,
  onTransfer,
}) => {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!isOpen) return null;

  const otherMembers = members.filter((m) => m.userId !== currentUserId);

  const handleTransfer = async () => {
    if (!selectedUserId) return;
    setIsLoading(true);
    try {
      await onTransfer(selectedUserId);
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
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">ホスト権限の移譲</h3>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            退室前にホスト権限を移譲するメンバーを選択してください。
          </p>

          <div className="space-y-1">
            {otherMembers.map((member) => (
              <button
                key={member.userId}
                onClick={() => setSelectedUserId(member.userId)}
                className={`flex items-center space-x-3 w-full px-3 py-2.5 rounded-lg transition-colors ${
                  selectedUserId === member.userId
                    ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                  style={{ backgroundColor: member.color }}
                >
                  {member.jerseyNumber}
                </div>
                <div className="text-left flex items-center space-x-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-white">
                    #{member.jerseyNumber} {member.displayName}
                  </span>
                  {member.role === 'sub_host' && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
                      副ホスト
                    </span>
                  )}
                  <span className={`w-2 h-2 rounded-full ${member.isOnline ? 'bg-green-500' : 'bg-gray-300'}`} />
                </div>
              </button>
            ))}
          </div>

          {otherMembers.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">
              他のメンバーがいません。退室するとルームは非アクティブになります。
            </p>
          )}

          <div className="flex justify-end space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            >
              キャンセル
            </button>
            {otherMembers.length > 0 ? (
              <button
                onClick={handleTransfer}
                disabled={isLoading || !selectedUserId}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {isLoading ? '移譲中...' : '移譲して退室'}
              </button>
            ) : (
              <button
                onClick={handleTransfer}
                disabled={isLoading}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                退室する
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HostTransferDialog;
