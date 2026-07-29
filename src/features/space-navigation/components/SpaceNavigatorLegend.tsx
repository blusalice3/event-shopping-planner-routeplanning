import React from 'react';
import type { NavigatorStatusKind } from '../types';

export const NAVIGATOR_STATUS_COLORS: Record<NavigatorStatusKind, string> = {
  unvisited: '#94a3b8',
  postponed: '#8b5cf6',
  late: '#3b82f6',
  limited: '#f97316',
  completed: '#22c55e',
};

const legendItems: Array<{ kind: NavigatorStatusKind; label: string }> = [
  { kind: 'unvisited', label: '未購入' },
  { kind: 'postponed', label: '後回し' },
  { kind: 'late', label: '遅参' },
  { kind: 'limited', label: '限数未入力' },
  { kind: 'completed', label: '完了' },
];

export function SpaceNavigatorLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-center text-slate-600 dark:text-slate-300 ${
        compact ? 'gap-x-2 gap-y-1 text-[10px]' : 'gap-x-3 gap-y-1 text-xs'
      }`}
      aria-label="スペースナビの色凡例"
    >
      {legendItems.map(({ kind, label }) => (
        <span key={kind} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm border border-black/10"
            style={{ backgroundColor: NAVIGATOR_STATUS_COLORS[kind] }}
          />
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2.5 w-3 rounded-sm border border-amber-600"
          style={{
            backgroundImage:
              'repeating-linear-gradient(135deg, #f59e0b 0 2px, transparent 2px 4px)',
          }}
        />
        入力警告
      </span>
    </div>
  );
}

