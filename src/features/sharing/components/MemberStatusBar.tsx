import React from 'react';
import type { RoomMember } from '../types/room';

interface MemberStatusBarProps {
  members: RoomMember[];
  currentUserId: string | null;
}

const statusLabels: Record<string, string> = {
  roaming: '巡回中',
  inQueue: '列に並び中',
  done: '完了',
  resting: '休憩中',
};

const MemberStatusBar: React.FC<MemberStatusBarProps> = ({ members, currentUserId }) => {
  if (members.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 overflow-x-auto bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700">
      {members.map((member) => {
        const status = (member as RoomMember & { status?: string }).status ?? 'roaming';
        const queueCircle = (member as RoomMember & { queueCircleName?: string }).queueCircleName;
        const remaining = (member as RoomMember & { remainingItems?: number }).remainingItems;
        const isMe = member.userId === currentUserId;

        let statusText = statusLabels[status] || status;
        if (status === 'inQueue' && queueCircle) {
          statusText = `${queueCircle}で列に並び中`;
        }
        if (status === 'roaming' && remaining !== undefined) {
          statusText = `巡回中(残${remaining}件)`;
        }

        return (
          <div
            key={member.userId}
            className={`flex items-center space-x-1.5 px-2 py-1 rounded-full text-xs shrink-0 ${
              isMe
                ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-300 dark:ring-blue-700'
                : 'bg-white dark:bg-slate-800'
            }`}
          >
            <div
              className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold shrink-0"
              style={{ backgroundColor: member.color }}
            >
              {member.displayName.charAt(0)}
            </div>
            <span className="text-slate-700 dark:text-slate-300 whitespace-nowrap">
              {member.displayName}
            </span>
            <span className="text-slate-400 dark:text-slate-500 whitespace-nowrap">
              {statusText}
            </span>
            <div
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                member.isOnline ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'
              }`}
            />
          </div>
        );
      })}
    </div>
  );
};

export default MemberStatusBar;
