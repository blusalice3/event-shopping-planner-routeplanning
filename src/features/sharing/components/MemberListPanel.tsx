import React from 'react';
import type { RoomMember } from '../types/room';

interface MemberListPanelProps {
  members: RoomMember[];
  hostUserId: string;
  currentUserId: string | null;
  roomCode: string;
  onClose: () => void;
}

const MemberListPanel: React.FC<MemberListPanelProps> = ({
  members,
  hostUserId,
  currentUserId,
  roomCode,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-between items-center">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            メンバー一覧
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
            {roomCode}
          </span>
        </div>

        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {members.map((member) => (
            <li key={member.id} className="px-4 py-3 flex items-center space-x-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                style={{ backgroundColor: member.color }}
              >
                {member.jerseyNumber}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-bold text-slate-500 dark:text-slate-400">
                    #{member.jerseyNumber}
                  </span>
                  <span className="text-sm font-medium text-slate-800 dark:text-white truncate">
                    {member.displayName}
                  </span>
                  {member.userId === hostUserId && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400">
                      ホスト
                    </span>
                  )}
                  {member.userId === currentUserId && (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      (自分)
                    </span>
                  )}
                </div>
              </div>
              <div
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  member.isOnline
                    ? 'bg-green-500'
                    : 'bg-slate-300 dark:bg-slate-600'
                }`}
                title={member.isOnline ? 'オンライン' : 'オフライン'}
              />
            </li>
          ))}
        </ul>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};

export default MemberListPanel;
