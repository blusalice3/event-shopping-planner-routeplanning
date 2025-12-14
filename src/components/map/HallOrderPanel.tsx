import React, { useState, useCallback } from 'react';
import { HallDefinition, HallRouteSettings } from '../../types';

interface HallOrderPanelProps {
  isOpen: boolean;
  onClose: () => void;
  halls: HallDefinition[];
  hallRouteSettings: HallRouteSettings;
  onUpdateHallRouteSettings: (settings: HallRouteSettings) => void;
  getItemCountInHall: (hallId: string) => number;
}

const HallOrderPanel: React.FC<HallOrderPanelProps> = ({
  isOpen,
  onClose,
  halls,
  hallRouteSettings,
  onUpdateHallRouteSettings,
  getItemCountInHall,
}) => {
  const [localOrder, setLocalOrder] = useState<string[]>(hallRouteSettings.hallOrder);

  // ホール順序を上に移動
  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setLocalOrder(prev => {
      const newOrder = [...prev];
      [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
      return newOrder;
    });
  }, []);

  // ホール順序を下に移動
  const handleMoveDown = useCallback((index: number) => {
    if (index >= localOrder.length - 1) return;
    setLocalOrder(prev => {
      const newOrder = [...prev];
      [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
      return newOrder;
    });
  }, [localOrder.length]);

  // 保存
  const handleSave = useCallback(() => {
    onUpdateHallRouteSettings({
      ...hallRouteSettings,
      hallOrder: localOrder,
    });
    onClose();
  }, [localOrder, hallRouteSettings, onUpdateHallRouteSettings, onClose]);

  // ホール名を取得
  const getHallName = useCallback((hallId: string): string => {
    const hall = halls.find(h => h.id === hallId);
    return hall?.name || '不明なホール';
  }, [halls]);

  // ホール色を取得
  const getHallColor = useCallback((hallId: string): string => {
    const hall = halls.find(h => h.id === hallId);
    return hall?.color || '#E0E0E0';
  }, [halls]);

  if (!isOpen) return null;

  // 訪問先があるホールのみ表示
  const hallsWithItems = localOrder.filter(hallId => getItemCountInHall(hallId) > 0);
  const hallsWithoutItems = localOrder.filter(hallId => getItemCountInHall(hallId) === 0);

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
              {/* 訪問先があるホール */}
              {hallsWithItems.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                    訪問先があるホール（この順序で回ります）
                  </h3>
                  <div className="space-y-2">
                    {hallsWithItems.map((hallId, displayIndex) => {
                      const actualIndex = localOrder.indexOf(hallId);
                      const itemCount = getItemCountInHall(hallId);
                      return (
                        <div
                          key={hallId}
                          className="flex items-center gap-2 p-3 bg-white dark:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600"
                        >
                          <span
                            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold text-white"
                            style={{ backgroundColor: getHallColor(hallId) }}
                          >
                            {displayIndex + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-slate-900 dark:text-white truncate">
                              {getHallName(hallId)}
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

              {/* 訪問先がないホール */}
              {hallsWithoutItems.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-slate-400 dark:text-slate-500 mb-2">
                    訪問先がないホール（スキップされます）
                  </h3>
                  <div className="space-y-1">
                    {hallsWithoutItems.map((hallId) => (
                      <div
                        key={hallId}
                        className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-800 rounded border border-slate-100 dark:border-slate-700 opacity-50"
                      >
                        <span
                          className="flex-shrink-0 w-6 h-6 rounded-full"
                          style={{ backgroundColor: getHallColor(hallId) }}
                        />
                        <span className="text-sm text-slate-500 dark:text-slate-400">
                          {getHallName(hallId)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* フッター */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
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
  );
};

export default HallOrderPanel;
