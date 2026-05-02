import React, { useState, useCallback } from 'react';
import { HallDefinition, HallRouteSettings } from '../../types/map';

// 優先度レベルの型
type PriorityLevel = 'none' | 'priority' | 'highest';

interface HallOrderPanelProps {
  isOpen: boolean;
  onClose: () => void;
  halls: HallDefinition[];
  hallRouteSettings: HallRouteSettings;
  onUpdateHallRouteSettings: (settings: HallRouteSettings) => void;
  getItemCountInHall: (hallId: string) => number;
  onReorderExecuteList?: (hallOrder: string[]) => void; // 実行列並び替えコールバック
}

// グループIDからホールIDと優先度を分離するヘルパー
const parseGroupId = (
  groupId: string | null,
): { hallId: string | null; priority: PriorityLevel } => {
  if (groupId === null) return { hallId: null, priority: 'none' };
  if (groupId === 'undefined') return { hallId: null, priority: 'none' };
  if (groupId === 'undefined:highest') return { hallId: null, priority: 'highest' };
  if (groupId === 'undefined:priority') return { hallId: null, priority: 'priority' };
  if (groupId.endsWith(':highest')) {
    return { hallId: groupId.replace(':highest', ''), priority: 'highest' };
  }
  if (groupId.endsWith(':priority')) {
    return { hallId: groupId.replace(':priority', ''), priority: 'priority' };
  }
  return { hallId: groupId, priority: 'none' };
};

// グループの表示名を取得
const getGroupDisplayName = (groupId: string | null, halls: HallDefinition[]): string => {
  if (groupId === null) return 'ホール未定義';
  if (groupId === 'undefined') return 'ホール未定義';
  if (groupId === 'undefined:highest') return 'ホール未定義最優先';
  if (groupId === 'undefined:priority') return 'ホール未定義優先';

  const { hallId, priority } = parseGroupId(groupId);
  const hall = halls.find((h) => h.id === hallId);
  const hallName = hall?.name || 'ホール未定義';

  if (priority === 'highest') return `${hallName}最優先`;
  if (priority === 'priority') return `${hallName}優先`;
  return hallName;
};

// グループの色を取得
const getGroupColor = (groupId: string | null, halls: HallDefinition[]): string => {
  const { hallId, priority } = parseGroupId(groupId);

  if (priority === 'highest') return '#EF4444'; // 赤
  if (priority === 'priority') return '#F97316'; // オレンジ

  const hall = halls.find((h) => h.id === hallId);
  return hall?.color || '#9CA3AF'; // グレー
};

const HallOrderPanel: React.FC<HallOrderPanelProps> = ({
  isOpen,
  onClose,
  halls,
  hallRouteSettings,
  onUpdateHallRouteSettings,
  getItemCountInHall,
  onReorderExecuteList,
}) => {
  const [localOrder, setLocalOrder] = useState<string[]>(hallRouteSettings.hallOrder);

  // hallRouteSettingsが変更されたらlocalOrderを更新
  React.useEffect(() => {
    setLocalOrder(hallRouteSettings.hallOrder);
  }, [hallRouteSettings.hallOrder]);

  // グループ順序を上に移動
  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setLocalOrder((prev) => {
      const newOrder = [...prev];
      [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
      return newOrder;
    });
  }, []);

  // グループ順序を下に移動
  const handleMoveDown = useCallback(
    (index: number) => {
      if (index >= localOrder.length - 1) return;
      setLocalOrder((prev) => {
        const newOrder = [...prev];
        [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
        return newOrder;
      });
    },
    [localOrder.length],
  );

  // 保存
  const handleSave = useCallback(() => {
    onUpdateHallRouteSettings({
      ...hallRouteSettings,
      hallOrder: localOrder,
    });
    onClose();
  }, [localOrder, hallRouteSettings, onUpdateHallRouteSettings, onClose]);

  // グループ内のアイテム数を取得（優先度対応）
  const getGroupItemCount = useCallback(
    (groupId: string): number => {
      // 通常のホールIDの場合はそのまま
      const { hallId, priority } = parseGroupId(groupId);

      // 優先度付きグループは個別にカウントが必要
      // ここでは簡略化のため、ベースのホールIDでカウントを取得
      // 実際には優先度ごとのカウントが必要な場合は、propsを拡張する
      if (priority !== 'none') {
        // 優先度付きグループは常に表示（アイテムがあると仮定）
        return getItemCountInHall(groupId);
      }

      return getItemCountInHall(hallId || groupId);
    },
    [getItemCountInHall],
  );

  if (!isOpen) return null;

  // 訪問先があるグループのみ表示
  const groupsWithItems = localOrder.filter((groupId) => getGroupItemCount(groupId) > 0);
  const groupsWithoutItems = localOrder.filter((groupId) => getGroupItemCount(groupId) === 0);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">ホール間移動順序</h2>
          <button
            onClick={onClose}
            className="text-2xl text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            ✕
          </button>
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-auto p-4">
          {localOrder.length === 0 ? (
            <p className="text-center text-slate-500 dark:text-slate-400 py-8">
              ホールが定義されていません
            </p>
          ) : (
            <>
              {/* 訪問先があるグループ */}
              {groupsWithItems.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                    訪問先があるグループ（この順序で回ります）
                  </h3>
                  <div className="space-y-2">
                    {groupsWithItems.map((groupId, displayIndex) => {
                      const actualIndex = localOrder.indexOf(groupId);
                      const itemCount = getGroupItemCount(groupId);
                      const { priority } = parseGroupId(groupId);
                      const displayName = getGroupDisplayName(groupId, halls);
                      const color = getGroupColor(groupId, halls);

                      return (
                        <div
                          key={groupId}
                          className={`flex items-center gap-2 p-3 rounded-lg border ${
                            priority === 'highest'
                              ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                              : priority === 'priority'
                                ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800'
                                : 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600'
                          }`}
                        >
                          <span
                            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold text-white"
                            style={{ backgroundColor: color }}
                          >
                            {displayIndex + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-slate-900 dark:text-white truncate">
                              {displayName}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {itemCount}件の訪問先
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => handleMoveUp(actualIndex)}
                              disabled={actualIndex === 0}
                              className="px-2 py-1 text-xs rounded bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              ▲
                            </button>
                            <button
                              onClick={() => handleMoveDown(actualIndex)}
                              disabled={actualIndex === localOrder.length - 1}
                              className="px-2 py-1 text-xs rounded bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              ▼
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 訪問先がないグループ */}
              {groupsWithoutItems.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-slate-400 dark:text-slate-500 mb-2">
                    訪問先がないグループ（スキップされます）
                  </h3>
                  <div className="space-y-1">
                    {groupsWithoutItems.map((groupId) => {
                      const displayName = getGroupDisplayName(groupId, halls);
                      const color = getGroupColor(groupId, halls);

                      return (
                        <div
                          key={groupId}
                          className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-800 rounded border border-slate-100 dark:border-slate-700 opacity-50"
                        >
                          <span
                            className="flex-shrink-0 w-6 h-6 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-sm text-slate-500 dark:text-slate-400">
                            {displayName}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* フッター */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-between">
          <div>
            {onReorderExecuteList && groupsWithItems.length > 0 && (
              <button
                onClick={() => {
                  onReorderExecuteList(localOrder);
                  onUpdateHallRouteSettings({
                    ...hallRouteSettings,
                    hallOrder: localOrder,
                  });
                }}
                className="px-4 py-2 text-sm rounded bg-amber-500 text-white hover:bg-amber-600"
                title="実行列のアイテムをグループ順序に従って並び替えます"
              >
                🔄 実行列を並び替え
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HallOrderPanel;
