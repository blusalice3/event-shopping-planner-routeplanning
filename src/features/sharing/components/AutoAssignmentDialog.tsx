import React, { useState, useMemo, useCallback } from 'react';
import type { ShoppingItem, HallDefinition, DayMapData } from '../../../types';
import type { RoomMember } from '../types/room';
import { getHallSpaceKeys } from '../services/autoAssignmentService';
import { getSpaceKey } from '../../../utils/spaceGrouping';

interface AutoAssignmentDialogProps {
  items: ShoppingItem[];
  members: RoomMember[];
  halls: HallDefinition[];
  mapData: DayMapData | undefined;
  onApply: (assignments: { userId: string; itemIds: string[] }[], clearItemIds: string[]) => Promise<void>;
  onClose: () => void;
}

interface SpaceGroup {
  spaceKey: string;
  block: string;
  number: string;
  circles: string[];
  itemIds: string[];
  itemCount: number;
}

const AutoAssignmentDialog: React.FC<AutoAssignmentDialogProps> = ({
  items,
  members,
  halls,
  mapData,
  onApply,
  onClose,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // フィルタstate
  const [dateFilter, setDateFilter] = useState<string>('');
  const [blockFilter, setBlockFilter] = useState<string>('');
  const [hallFilter, setHallFilter] = useState<string>('');
  const [assignFilter, setAssignFilter] = useState<'all' | 'unassigned' | 'assigned'>('all');

  // 一括割り当てメンバー選択ポップアップstate
  const [bulkAssignTarget, setBulkAssignTarget] = useState<'block' | 'hall' | null>(null);

  // 参加日一覧
  const uniqueDates = useMemo(() => {
    const dates = new Set(items.map((item) => item.eventDate).filter(Boolean));
    return Array.from(dates).sort();
  }, [items]);

  // 参加日フィルタ適用済みアイテム
  const dateFilteredItems = useMemo(() => {
    if (!dateFilter) return items;
    return items.filter((item) => item.eventDate === dateFilter);
  }, [items, dateFilter]);

  // 未購入アイテム（参加日フィルタ適用済み）
  const unpurchasedItems = useMemo(
    () => dateFilteredItems.filter((item) => item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone'),
    [dateFilteredItems],
  );

  // スペース別グループ化
  const spaceGroups = useMemo(() => {
    const groups = new Map<string, SpaceGroup>();
    for (const item of unpurchasedItems) {
      const key = getSpaceKey(item.block, item.number);
      const existing = groups.get(key);
      if (existing) {
        existing.itemIds.push(item.id);
        existing.itemCount++;
        if (!existing.circles.includes(item.circle)) {
          existing.circles.push(item.circle);
        }
      } else {
        groups.set(key, {
          spaceKey: key,
          block: item.block,
          number: item.number,
          circles: [item.circle],
          itemIds: [item.id],
          itemCount: 1,
        });
      }
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.block !== b.block) return a.block.localeCompare(b.block);
      const numA = parseInt(a.number) || 0;
      const numB = parseInt(b.number) || 0;
      return numA - numB;
    });
  }, [unpurchasedItems]);

  // ブロック一覧（フィルタ用）
  const uniqueBlocks = useMemo(() => {
    const blocks = new Set(spaceGroups.map((s) => s.block));
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      return !isNaN(numA) && !isNaN(numB) ? numA - numB : a.localeCompare(b);
    });
  }, [spaceGroups]);

  // ホール→スペースキーマッピング
  const hallSpaceKeys = useMemo(
    () => getHallSpaceKeys(dateFilteredItems, halls, mapData),
    [dateFilteredItems, halls, mapData],
  );

  // ホール一覧（スペースを含むホールのみ）
  const availableHalls = useMemo(() => {
    return halls.filter((hall) => {
      const keys = hallSpaceKeys.get(hall.id);
      return keys && keys.size > 0;
    });
  }, [halls, hallSpaceKeys]);

  // 現在の割り振りからmanualAssignmentsを初期化
  const initialManualAssignments = useMemo(() => {
    const assignments: Record<string, string> = {};
    for (const space of spaceGroups) {
      const assignedItems = unpurchasedItems.filter(
        (item) => space.itemIds.includes(item.id) && item.assignedTo,
      );
      if (assignedItems.length === 0) continue;

      // 全アイテムが同一メンバーに割り当てられている場合のみ設定
      const userIds = new Set(assignedItems.map((item) => item.assignedTo!));
      if (userIds.size === 1 && assignedItems.length === space.itemIds.length) {
        assignments[space.spaceKey] = assignedItems[0].assignedTo!;
      }
    }
    return assignments;
  }, [spaceGroups, unpurchasedItems]);

  // 手動割り当てstate: spaceKey → userId（現在の割り振りで初期化）
  const [manualAssignments, setManualAssignments] = useState<Record<string, string>>(
    () => initialManualAssignments,
  );

  // 手動割り振りの集計（メンバー別スペース数・アイテム数）
  const manualSummary = useMemo(() => {
    const summary = new Map<string, { spaceCount: number; itemCount: number }>();
    for (const m of members) {
      summary.set(m.userId, { spaceCount: 0, itemCount: 0 });
    }
    for (const space of spaceGroups) {
      const userId = manualAssignments[space.spaceKey];
      if (userId && summary.has(userId)) {
        const s = summary.get(userId)!;
        s.spaceCount++;
        s.itemCount += space.itemCount;
      }
    }
    return summary;
  }, [members, spaceGroups, manualAssignments]);

  // フィルタ済みスペースグループ
  const filteredSpaceGroups = useMemo(() => {
    let result = spaceGroups;
    if (blockFilter) {
      result = result.filter((s) => s.block === blockFilter);
    }
    if (hallFilter) {
      const hallKeys = hallSpaceKeys.get(hallFilter);
      if (hallKeys) {
        result = result.filter((s) => hallKeys.has(s.spaceKey));
      }
    }
    if (assignFilter === 'unassigned') {
      result = result.filter((s) => !manualAssignments[s.spaceKey]);
    } else if (assignFilter === 'assigned') {
      result = result.filter((s) => !!manualAssignments[s.spaceKey]);
    }
    return result;
  }, [spaceGroups, blockFilter, hallFilter, assignFilter, manualAssignments, hallSpaceKeys]);

  const handleSpaceAssign = useCallback((spaceKey: string, userId: string) => {
    setManualAssignments((prev) => {
      if (prev[spaceKey] === userId) {
        const next = { ...prev };
        delete next[spaceKey];
        return next;
      }
      return { ...prev, [spaceKey]: userId };
    });
  }, []);

  // ブロック一括割り当て
  const handleBulkBlockAssign = useCallback((userId: string) => {
    setManualAssignments((prev) => {
      const next = { ...prev };
      const target = blockFilter
        ? spaceGroups.filter((s) => s.block === blockFilter)
        : spaceGroups;
      for (const space of target) {
        next[space.spaceKey] = userId;
      }
      return next;
    });
    setBulkAssignTarget(null);
  }, [blockFilter, spaceGroups]);

  // ブロック一括解除
  const handleBulkBlockClear = useCallback(() => {
    setManualAssignments((prev) => {
      const next = { ...prev };
      const target = blockFilter
        ? spaceGroups.filter((s) => s.block === blockFilter)
        : spaceGroups;
      for (const space of target) {
        delete next[space.spaceKey];
      }
      return next;
    });
  }, [blockFilter, spaceGroups]);

  // ホール一括割り当て
  const handleBulkHallAssign = useCallback((userId: string) => {
    if (!hallFilter) return;
    const hallKeys = hallSpaceKeys.get(hallFilter);
    if (!hallKeys) return;
    setManualAssignments((prev) => {
      const next = { ...prev };
      for (const key of hallKeys) {
        next[key] = userId;
      }
      return next;
    });
    setBulkAssignTarget(null);
  }, [hallFilter, hallSpaceKeys]);

  // ホール一括解除
  const handleBulkHallClear = useCallback(() => {
    if (!hallFilter) return;
    const hallKeys = hallSpaceKeys.get(hallFilter);
    if (!hallKeys) return;
    setManualAssignments((prev) => {
      const next = { ...prev };
      for (const key of hallKeys) {
        delete next[key];
      }
      return next;
    });
  }, [hallFilter, hallSpaceKeys]);

  const handleApply = async () => {
    setIsLoading(true);
    setError('');
    try {
      const grouped = new Map<string, string[]>();
      const clearItemIds: string[] = [];
      for (const space of spaceGroups) {
        const assignedUserId = manualAssignments[space.spaceKey];
        if (assignedUserId) {
          const existing = grouped.get(assignedUserId) ?? [];
          existing.push(...space.itemIds);
          grouped.set(assignedUserId, existing);
        } else {
          clearItemIds.push(...space.itemIds);
        }
      }
      await onApply(
        Array.from(grouped.entries()).map(([userId, itemIds]) => ({ userId, itemIds })),
        clearItemIds,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '割り振りに失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            スペース割り振り
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {members.length < 2 && (
            <p className="text-sm text-orange-600 dark:text-orange-400">
              割り振りにはメンバーが2名以上必要です。
            </p>
          )}

          {unpurchasedItems.length === 0 && (
            <p className="text-sm text-slate-500">未購入アイテムがありません。</p>
          )}

          {members.length >= 2 && unpurchasedItems.length > 0 && (
            <div className="space-y-2">
              {/* メンバー別集計サマリー */}
              <div className="flex flex-wrap gap-1.5 px-1">
                {members.map((m) => {
                  const s = manualSummary.get(m.userId);
                  return (
                    <div key={m.userId} className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                      <div
                        className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold"
                        style={{ backgroundColor: m.color }}
                      >
                        {m.displayName.charAt(0)}
                      </div>
                      <span>{s?.spaceCount ?? 0}SP/{s?.itemCount ?? 0}件</span>
                    </div>
                  );
                })}
              </div>

              {/* 参加日フィルタ */}
              {uniqueDates.length > 1 && (
                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                  <span className="text-[10px] text-slate-400 shrink-0">参加日:</span>
                  <button
                    onClick={() => setDateFilter('')}
                    className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                      dateFilter === ''
                        ? 'bg-green-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    全日程
                  </button>
                  {uniqueDates.map((date) => (
                    <button
                      key={date}
                      onClick={() => setDateFilter(dateFilter === date ? '' : date)}
                      className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                        dateFilter === date
                          ? 'bg-green-600 text-white'
                          : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {date}
                    </button>
                  ))}
                </div>
              )}

              {/* ブロックフィルタ + 一括操作 */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                <span className="text-[10px] text-slate-400 shrink-0">ブロック:</span>
                <button
                  onClick={() => setBlockFilter('')}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                    blockFilter === ''
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  全て
                </button>
                {uniqueBlocks.map((block) => (
                  <button
                    key={block}
                    onClick={() => setBlockFilter(blockFilter === block ? '' : block)}
                    className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                      blockFilter === block
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {block}
                  </button>
                ))}
                <div className="flex gap-0.5 ml-auto shrink-0">
                  <div className="relative">
                    <button
                      onClick={() => setBulkAssignTarget(bulkAssignTarget === 'block' ? null : 'block')}
                      className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors"
                    >
                      一括割当
                    </button>
                    {bulkAssignTarget === 'block' && (
                      <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-300 dark:border-slate-600 p-2 flex gap-1">
                        {members.map((m) => (
                          <button
                            key={m.userId}
                            onClick={() => handleBulkBlockAssign(m.userId)}
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold hover:scale-110 transition-transform"
                            style={{ backgroundColor: m.color }}
                            title={m.displayName}
                          >
                            {m.displayName.charAt(0)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleBulkBlockClear}
                    className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
                  >
                    一括解除
                  </button>
                </div>
              </div>

              {/* ホールフィルタ + 一括操作（ホール定義がある場合のみ） */}
              {availableHalls.length > 0 && (
                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                  <span className="text-[10px] text-slate-400 shrink-0">ホール:</span>
                  <button
                    onClick={() => setHallFilter('')}
                    className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                      hallFilter === ''
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    全て
                  </button>
                  {availableHalls.map((hall) => (
                    <button
                      key={hall.id}
                      onClick={() => setHallFilter(hallFilter === hall.id ? '' : hall.id)}
                      className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                        hallFilter === hall.id
                          ? 'bg-purple-600 text-white'
                          : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {hall.name}
                    </button>
                  ))}
                  {hallFilter && (
                    <div className="flex gap-0.5 ml-auto shrink-0">
                      <div className="relative">
                        <button
                          onClick={() => setBulkAssignTarget(bulkAssignTarget === 'hall' ? null : 'hall')}
                          className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/60 transition-colors"
                        >
                          一括割当
                        </button>
                        {bulkAssignTarget === 'hall' && (
                          <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-300 dark:border-slate-600 p-2 flex gap-1">
                            {members.map((m) => (
                              <button
                                key={m.userId}
                                onClick={() => handleBulkHallAssign(m.userId)}
                                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold hover:scale-110 transition-transform"
                                style={{ backgroundColor: m.color }}
                                title={m.displayName}
                              >
                                {m.displayName.charAt(0)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={handleBulkHallClear}
                        className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
                      >
                        一括解除
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 割り当て状態フィルタ */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-400 shrink-0">状態:</span>
                {([['all', '全て'], ['unassigned', '未割当'], ['assigned', '割当済']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setAssignFilter(value)}
                    className={`px-2 py-0.5 text-[10px] font-medium rounded-full whitespace-nowrap transition-colors ${
                      assignFilter === value
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <span className="text-[10px] text-slate-400 ml-auto">
                  {filteredSpaceGroups.length}/{spaceGroups.length}件
                </span>
              </div>

              {/* スペースリスト */}
              <div className="space-y-1">
                {filteredSpaceGroups.map((space) => (
                  <div
                    key={space.spaceKey}
                    className="flex items-center px-2 py-1.5 rounded bg-slate-50 dark:bg-slate-900/50"
                  >
                    <div className="flex-1 min-w-0 mr-2">
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        {space.block}-{space.number}
                      </span>
                      <span className="text-xs text-slate-700 dark:text-slate-300 ml-1.5 truncate">
                        {space.circles.join(', ')}
                      </span>
                      {space.itemCount > 1 && (
                        <span className="text-[10px] text-slate-400 ml-1">
                          ({space.itemCount}件)
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {members.map((m) => (
                        <button
                          key={m.userId}
                          onClick={() => handleSpaceAssign(space.spaceKey, m.userId)}
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-bold transition-all ${
                            manualAssignments[space.spaceKey] === m.userId
                              ? 'ring-2 ring-offset-1 ring-blue-500 scale-110'
                              : 'opacity-40 hover:opacity-70'
                          }`}
                          style={{ backgroundColor: m.color }}
                          title={m.displayName}
                        >
                          {m.displayName.charAt(0)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400"
          >
            キャンセル
          </button>
          <button
            onClick={handleApply}
            disabled={isLoading || members.length < 2}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? '適用中...' : '適用'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AutoAssignmentDialog;
