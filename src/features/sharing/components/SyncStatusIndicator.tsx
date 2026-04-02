import React from 'react';
import type { SyncStatus } from '../types/room';

interface SyncStatusIndicatorProps {
  status: SyncStatus;
  pendingCount: number;
}

const statusConfig: Record<SyncStatus, { color: string; label: string }> = {
  disconnected: { color: 'bg-slate-400', label: '' },
  synced: { color: 'bg-green-500', label: '同期済み' },
  syncing: { color: 'bg-yellow-500 animate-pulse', label: '同期中' },
  offline: { color: 'bg-red-500', label: 'オフライン' },
  error: { color: 'bg-red-500', label: 'エラー' },
};

const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({ status, pendingCount }) => {
  if (status === 'disconnected') return null;

  const config = statusConfig[status];

  return (
    <div className="flex items-center space-x-1.5 text-xs text-slate-500 dark:text-slate-400">
      <div className={`w-2 h-2 rounded-full ${config.color}`} />
      <span>{config.label}</span>
      {pendingCount > 0 && (
        <span className="text-orange-500 dark:text-orange-400">
          ({pendingCount}件未同期)
        </span>
      )}
    </div>
  );
};

export default SyncStatusIndicator;
