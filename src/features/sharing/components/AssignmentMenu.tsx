import React from 'react';
import type { RoomMember } from '../types/room';

interface AssignmentMenuProps {
  members: RoomMember[];
  currentAssignedTo: string | undefined;
  currentUserId: string | null;
  onAssign: (targetUserId: string | null) => void;
  onClose: () => void;
  position: { x: number; y: number };
}

const AssignmentMenu: React.FC<AssignmentMenuProps> = ({
  members,
  currentAssignedTo,
  currentUserId,
  onAssign,
  onClose,
  position,
}) => {
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 min-w-[200px] overflow-hidden"
        style={{
          left: Math.min(position.x, window.innerWidth - 220),
          top: Math.min(position.y, window.innerHeight - 300),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            担当者を選択
          </span>
        </div>
        <div className="py-1">
          {/* 未割り当て */}
          <button
            onClick={() => onAssign(null)}
            className={`flex items-center space-x-2 w-full px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${
              !currentAssignedTo ? 'bg-blue-50 dark:bg-blue-900/30' : ''
            }`}
          >
            <div className="w-6 h-6 rounded-full bg-slate-300 dark:bg-slate-600 flex items-center justify-center text-xs text-white">
              -
            </div>
            <span className="text-slate-700 dark:text-slate-300">未割り当て</span>
            {!currentAssignedTo && (
              <span className="ml-auto text-blue-500 text-xs">現在</span>
            )}
          </button>
          {/* メンバー一覧 */}
          {members.map((member) => (
            <button
              key={member.userId}
              onClick={() => onAssign(member.userId)}
              className={`flex items-center space-x-2 w-full px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${
                currentAssignedTo === member.userId ? 'bg-blue-50 dark:bg-blue-900/30' : ''
              }`}
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs text-white font-bold shrink-0"
                style={{ backgroundColor: member.color }}
              >
                {member.displayName.charAt(0)}
              </div>
              <span className="text-slate-700 dark:text-slate-300 truncate">
                {member.displayName}
                {member.userId === currentUserId && ' (自分)'}
              </span>
              {currentAssignedTo === member.userId && (
                <span className="ml-auto text-blue-500 text-xs">現在</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AssignmentMenu;
