import React, { useState, useMemo, useEffect, useCallback } from "react";
import type { HallDefinition } from "../../types/map";
import { normalizeBlockName } from "../../utils/hallFallback";

const HALL_COLORS = [
  "#FFE0B2",
  "#FFCCBC",
  "#D7CCC8",
  "#CFD8DC",
  "#B2DFDB",
  "#C8E6C9",
  "#DCEDC8",
  "#F0F4C3",
  "#FFF9C4",
  "#FFECB3",
  "#E1BEE7",
  "#D1C4E9",
];

interface SimpleHallDefinitionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  halls: HallDefinition[];
  onUpdateHalls: (halls: HallDefinition[]) => void;
  availableBlocks: string[];
  eventDates?: string[];
  activeEventDate?: string;
  onSyncToOtherDates?: (targetDates: string[]) => void;
}

interface EditingHall {
  id: string;
  name: string;
  color: string;
  blockNames: string[];
}

const createNewHall = (existingCount: number): EditingHall => ({
  id: `hall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: "",
  color: HALL_COLORS[existingCount % HALL_COLORS.length],
  blockNames: [],
});

export const SimpleHallDefinitionPanel: React.FC<
  SimpleHallDefinitionPanelProps
> = ({
  isOpen,
  onClose,
  halls,
  onUpdateHalls,
  availableBlocks,
  eventDates = [],
  activeEventDate = "",
  onSyncToOtherDates,
}) => {
  const [localHalls, setLocalHalls] = useState<HallDefinition[]>(halls);
  const [editing, setEditing] = useState<EditingHall | null>(null);
  const [showSyncUI, setShowSyncUI] = useState(false);
  const [syncTargetDates, setSyncTargetDates] = useState<Set<string>>(
    new Set(),
  );

  const otherDates = useMemo(
    () => eventDates.filter((d) => d !== activeEventDate),
    [eventDates, activeEventDate],
  );

  useEffect(() => {
    if (isOpen) {
      setLocalHalls(halls);
      setEditing(null);
      setShowSyncUI(false);
      setSyncTargetDates(new Set());
    }
  }, [isOpen, halls]);

  // ブロックが割り当てられているホール一覧
  const blockToHallsMap = useMemo(() => {
    const map = new Map<string, HallDefinition[]>();
    localHalls.forEach((h) => {
      h.blockNames?.forEach((b) => {
        const key = normalizeBlockName(b);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(h);
      });
    });
    return map;
  }, [localHalls]);

  const handleCreate = useCallback(() => {
    setEditing(createNewHall(localHalls.length));
  }, [localHalls.length]);

  const handleSelectHall = useCallback((hall: HallDefinition) => {
    setEditing({
      id: hall.id,
      name: hall.name,
      color: hall.color || HALL_COLORS[0],
      blockNames: hall.blockNames ? [...hall.blockNames] : [],
    });
  }, []);

  const handleToggleBlock = useCallback((block: string) => {
    setEditing((prev) => {
      if (!prev) return prev;
      // ブロック名は availableBlocks から厳密一致で追加/削除する。
      // 大小文字違いの "E" と "e" を区別したいため正規化はしない。
      const exists = prev.blockNames.includes(block);
      return {
        ...prev,
        blockNames: exists
          ? prev.blockNames.filter((b) => b !== block)
          : [...prev.blockNames, block],
      };
    });
  }, []);

  const handleSaveEditing = useCallback(() => {
    if (!editing) return;
    if (!editing.name.trim()) {
      alert("ホール名を入力してください");
      return;
    }
    const saved: HallDefinition = {
      id: editing.id,
      name: editing.name.trim(),
      vertices: [],
      color: editing.color,
      blockNames:
        editing.blockNames.length > 0 ? editing.blockNames : undefined,
    };
    setLocalHalls((prev) => {
      const idx = prev.findIndex((h) => h.id === editing.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setEditing(null);
  }, [editing]);

  const handleDeleteEditing = useCallback(() => {
    if (!editing) return;
    if (!confirm(`ホール「${editing.name}」を削除しますか？`)) return;
    setLocalHalls((prev) => prev.filter((h) => h.id !== editing.id));
    setEditing(null);
  }, [editing]);

  const handleCancelEditing = useCallback(() => {
    setEditing(null);
  }, []);

  const handleConfirmAll = useCallback(() => {
    onUpdateHalls(localHalls);
    onClose();
  }, [localHalls, onUpdateHalls, onClose]);

  const handleToggleSyncDate = useCallback((date: string) => {
    setSyncTargetDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }, []);

  const handleSyncExecute = useCallback(() => {
    if (syncTargetDates.size === 0 || !onSyncToOtherDates) return;
    if (
      !confirm(
        `選択した${syncTargetDates.size}日分のホール定義を上書きします。よろしいですか？`,
      )
    )
      return;
    onSyncToOtherDates(Array.from(syncTargetDates));
    setShowSyncUI(false);
    setSyncTargetDates(new Set());
  }, [syncTargetDates, onSyncToOtherDates]);

  const handleSyncAll = useCallback(() => {
    if (!onSyncToOtherDates || otherDates.length === 0) return;
    if (
      !confirm(
        `全ての他の日付（${otherDates.length}日分）のホール定義を上書きします。よろしいですか？`,
      )
    )
      return;
    onSyncToOtherDates(otherDates);
    setShowSyncUI(false);
    setSyncTargetDates(new Set());
  }, [onSyncToOtherDates, otherDates]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-white font-bold text-base">
              ホール定義（ブロック割当）
            </h2>
            <p className="text-white text-xs mt-0.5">
              ブロック名でホールを定義します
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:text-white text-2xl leading-none px-2"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {editing ? (
            /* ===== 編集ビュー ===== */
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  ホール名
                </label>
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="例: 東1ホール"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-700 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
                  ホールカラー
                </label>
                <div className="flex flex-wrap gap-2">
                  {HALL_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setEditing({ ...editing, color })}
                      className={`relative h-8 w-8 overflow-hidden rounded-lg transition-all ${
                        editing.color === color
                          ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-slate-800"
                          : "hover:ring-2 hover:ring-slate-300"
                      }`}
                      aria-label={`色: ${color}`}
                    >
                      <svg
                        className="absolute inset-0 h-full w-full"
                        viewBox="0 0 32 32"
                        aria-hidden="true"
                      >
                        <rect width="32" height="32" rx="4" fill={color} />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
                  所属ブロック ({editing.blockNames.length}個選択中)
                </label>
                {availableBlocks.length === 0 ? (
                  <div className="text-xs text-slate-500 italic py-2">
                    利用可能なブロックがありません
                  </div>
                ) : (
                  <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700 max-h-56 overflow-y-auto">
                    {(() => {
                      const selectedSet = new Set(editing.blockNames);
                      return availableBlocks.map((block) => {
                        const key = normalizeBlockName(block);
                        const otherHalls = (
                          blockToHallsMap.get(key) || []
                        ).filter((h) => h.id !== editing.id);
                        // 厳密一致: "E" と "e" は別ブロックとして扱う
                        const checked = selectedSet.has(block);
                        return (
                          <label
                            key={block}
                            className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleToggleBlock(block)}
                              className="w-4 h-4 text-blue-600 rounded"
                            />
                            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                              {block}
                            </span>
                            {otherHalls.length > 0 && (
                              <span className="inline-flex items-center gap-1 ml-auto">
                                {otherHalls.map((h) => (
                                  <span
                                    key={h.id}
                                    className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                                    title={`${h.name}にも割当済み`}
                                  >
                                    <svg
                                      className="h-2.5 w-2.5 rounded-full"
                                      viewBox="0 0 10 10"
                                      aria-hidden="true"
                                    >
                                      <circle
                                        cx="5"
                                        cy="5"
                                        r="5"
                                        fill={h.color}
                                      />
                                    </svg>
                                    {h.name}
                                  </span>
                                ))}
                              </span>
                            )}
                          </label>
                        );
                      });
                    })()}
                  </div>
                )}
                <p className="text-xs text-slate-500 mt-1.5">
                  同じブロックを複数のホールに割り当てることができます
                </p>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleCancelEditing}
                  className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600"
                >
                  キャンセル
                </button>
                {localHalls.some((h) => h.id === editing.id) && (
                  <button
                    onClick={handleDeleteEditing}
                    className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 dark:bg-red-900/30 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50"
                  >
                    削除
                  </button>
                )}
                <button
                  onClick={handleSaveEditing}
                  disabled={!editing.name.trim()}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  確定
                </button>
              </div>
            </div>
          ) : (
            /* ===== 一覧ビュー ===== */
            <div className="space-y-3">
              {localHalls.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-500">
                  ホールがまだ定義されていません
                </div>
              ) : (
                localHalls.map((hall) => {
                  const blockCount = hall.blockNames?.length || 0;
                  return (
                    <button
                      key={hall.id}
                      onClick={() => handleSelectHall(hall)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 p-3 hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg text-xs font-bold text-slate-700">
                          <svg
                            className="absolute inset-0 h-full w-full"
                            viewBox="0 0 40 40"
                            aria-hidden="true"
                          >
                            <rect
                              width="40"
                              height="40"
                              rx="6"
                              fill={hall.color || HALL_COLORS[0]}
                            />
                          </svg>
                          <span className="relative">
                            {hall.name.slice(0, 2)}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {hall.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {blockCount > 0
                              ? `ブロック: ${hall.blockNames!.join(", ")}`
                              : "ブロック未割当"}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}

              <button
                onClick={handleCreate}
                className="w-full rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-600 p-3 text-sm text-slate-500 dark:text-slate-400 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
              >
                <span className="text-lg leading-none">+</span>
                新しいホールを追加
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {!editing && (
          <div className="border-t border-slate-200 dark:border-slate-700 px-4 py-3 space-y-3">
            {/* 同期UI */}
            {showSyncUI && (
              <div className="rounded-lg border border-indigo-200 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/20 p-3 space-y-2">
                <div className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                  同期先の日付を選択（現在: {activeEventDate}）
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {otherDates.map((date) => (
                    <label
                      key={date}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-indigo-100 dark:hover:bg-indigo-800/30 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={syncTargetDates.has(date)}
                        onChange={() => handleToggleSyncDate(date)}
                        className="w-4 h-4 text-indigo-600 rounded"
                      />
                      <span className="text-sm text-slate-700 dark:text-slate-200">
                        {date}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSyncAll}
                    className="flex-1 px-3 py-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg hover:bg-indigo-200 dark:hover:bg-indigo-800/60"
                  >
                    全日付に適用
                  </button>
                  <button
                    onClick={handleSyncExecute}
                    disabled={syncTargetDates.size === 0}
                    className="flex-1 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    選択した日に同期 ({syncTargetDates.size})
                  </button>
                  <button
                    onClick={() => {
                      setShowSyncUI(false);
                      setSyncTargetDates(new Set());
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  >
                    閉じる
                  </button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600"
              >
                キャンセル
              </button>
              {onSyncToOtherDates &&
                otherDates.length > 0 &&
                localHalls.length > 0 && (
                  <button
                    onClick={() => setShowSyncUI((v) => !v)}
                    className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                      showSyncUI
                        ? "text-indigo-700 bg-indigo-100 dark:text-indigo-300 dark:bg-indigo-800/40"
                        : "text-indigo-600 bg-indigo-50 dark:text-indigo-400 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-800/40"
                    }`}
                  >
                    他の日に同期
                  </button>
                )}
              <button
                onClick={handleConfirmAll}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                保存
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SimpleHallDefinitionPanel;
