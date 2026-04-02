import React, { useState } from 'react';
import type { RoomMember } from '../types/room';

interface MemberListPanelProps {
  members: RoomMember[];
  hostUserId: string;
  currentUserId: string | null;
  roomCode: string;
  isHost: boolean;
  onClose: () => void;
  onDelegateHost?: (targetUserId: string) => void;
  onSetSubHost?: (targetUserId: string) => void;
  onRemoveSubHost?: (targetUserId: string) => void;
}

const MemberListPanel: React.FC<MemberListPanelProps> = ({
  members,
  hostUserId,
  currentUserId,
  roomCode,
  isHost,
  onClose,
  onDelegateHost,
  onSetSubHost,
  onRemoveSubHost,
}) => {
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const hasSubHost = members.some((m) => m.role === 'sub_host');
  const subHostHint = isHost && members.length >= 2 && !hasSubHost;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-sm overflow-hidden"
        onClick={(e) => { e.stopPropagation(); setMenuOpenFor(null); }}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-between items-center">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            メンバー一覧
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
            {roomCode}
          </span>
        </div>

        {subHostHint && (
          <div className="px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 text-xs text-yellow-700 dark:text-yellow-300">
            副ホストを指定すると、あなたが不在時でも再参加承認が可能になります。
          </div>
        )}

        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            const isMemberHost = member.userId === hostUserId;
            const showMenu = isHost && !isSelf && !isMemberHost;

            return (
              <li key={member.id} className="px-4 py-3 flex items-center space-x-3 relative">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                  style={{ backgroundColor: member.color }}
                >
                  {member.jerseyNumber}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 flex-wrap">
                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400">
                      #{member.jerseyNumber}
                    </span>
                    <span className="text-sm font-medium text-slate-800 dark:text-white truncate">
                      {member.displayName}
                    </span>
                    {isMemberHost && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400">
                        ホスト
                      </span>
                    )}
                    {member.role === 'sub_host' && !isMemberHost && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
                        副ホスト
                      </span>
                    )}
                    {isSelf && (
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        (自分)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <div
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      member.isOnline
                        ? 'bg-green-500'
                        : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={member.isOnline ? 'オンライン' : 'オフライン'}
                  />
                  {showMenu && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenFor(menuOpenFor === member.userId ? null : member.userId);
                      }}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-sm px-1"
                    >
                      ...
                    </button>
                  )}
                </div>
                {/* ホスト専用メニュー */}
                {menuOpenFor === member.userId && showMenu && (
                  <div className="absolute right-2 top-full mt-1 bg-white dark:bg-slate-700 rounded-lg shadow-lg border border-slate-200 dark:border-slate-600 z-10 py-1 min-w-[140px]">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`${member.displayName}さんにホストを委任しますか？`)) {
                          onDelegateHost?.(member.userId);
                        }
                        setMenuOpenFor(null);
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600"
                    >
                      ホストを委任
                    </button>
                    {member.role === 'sub_host' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveSubHost?.(member.userId);
                          setMenuOpenFor(null);
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600"
                      >
                        副ホストを解除
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetSubHost?.(member.userId);
                          setMenuOpenFor(null);
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600"
                      >
                        副ホストに指定
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
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
