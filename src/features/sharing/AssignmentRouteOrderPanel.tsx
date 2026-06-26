import React, { useMemo, useState } from 'react';
import type { AssignmentRouteGroup } from './assignmentRouteOrder';

type AssignmentRouteOrderPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  groups: AssignmentRouteGroup[];
  onApplyOrder: (groupOrder: string[]) => void;
};

const AssignmentRouteOrderPanel: React.FC<AssignmentRouteOrderPanelProps> = ({
  isOpen,
  onClose,
  groups,
  onApplyOrder,
}) => {
  const [localOrder, setLocalOrder] = useState<string[]>(groups.map((group) => group.groupId));

  React.useEffect(() => {
    setLocalOrder(groups.map((group) => group.groupId));
  }, [groups]);

  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.groupId, group])),
    [groups],
  );

  const orderedGroups = useMemo(
    () =>
      Array.from(new Set([...localOrder, ...groups.map((group) => group.groupId)]))
        .map((groupId) => groupById.get(groupId))
        .filter((group): group is AssignmentRouteGroup => group !== undefined),
    [groupById, groups, localOrder],
  );

  const moveGroup = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= orderedGroups.length) return;
    setLocalOrder((prev) => {
      const next = Array.from(new Set([...prev, ...orderedGroups.map((group) => group.groupId)]));
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">担当ルート順序</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-2xl text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {orderedGroups.length === 0 ? (
            <p className="py-8 text-center text-slate-500 dark:text-slate-400">
              実行列に担当者ルートがありません
            </p>
          ) : (
            <div className="space-y-2">
              {orderedGroups.map((group, index) => (
                <div
                  key={group.groupId}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-600 dark:bg-slate-700"
                >
                  <span
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                    style={{ backgroundColor: group.color ?? '#64748B' }}
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-900 dark:text-white">
                      {group.displayName}のルート
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {group.itemIds.length}件の訪問先
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => moveGroup(index, -1)}
                      disabled={index === 0}
                      className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-slate-500"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => moveGroup(index, 1)}
                      disabled={index === orderedGroups.length - 1}
                      className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-slate-500"
                    >
                      ▼
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => {
              onApplyOrder(orderedGroups.map((group) => group.groupId));
              onClose();
            }}
            disabled={orderedGroups.length === 0}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            全体ルートへ反映
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssignmentRouteOrderPanel;
