import React, { useState, useMemo, useEffect, useCallback } from 'react';
import type { HallDefinition } from '../../types';
import { normalizeBlockName } from '../../utils/hallFallback';

const HALL_COLORS = [
  '#FFE0B2',
  '#FFCCBC',
  '#D7CCC8',
  '#CFD8DC',
  '#B2DFDB',
  '#C8E6C9',
  '#DCEDC8',
  '#F0F4C3',
  '#FFF9C4',
  '#FFECB3',
  '#E1BEE7',
  '#D1C4E9',
];

interface SimpleHallDefinitionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  halls: HallDefinition[];
  onUpdateHalls: (halls: HallDefinition[]) => void;
  availableBlocks: string[];
}

interface EditingHall {
  id: string;
  name: string;
  color: string;
  blockNames: string[];
}

const createNewHall = (existingCount: number): EditingHall => ({
  id: `hall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: '',
  color: HALL_COLORS[existingCount % HALL_COLORS.length],
  blockNames: [],
});

export const SimpleHallDefinitionPanel: React.FC<SimpleHallDefinitionPanelProps> = ({
  isOpen,
  onClose,
  halls,
  onUpdateHalls,
  availableBlocks,
}) => {
  const [localHalls, setLocalHalls] = useState<HallDefinition[]>(halls);
  const [editing, setEditing] = useState<EditingHall | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLocalHalls(halls);
      setEditing(null);
    }
  }, [isOpen, halls]);

  // ブロックが割り当てられているホール一覧
  const blockToHallsMap = useMemo(() => {
    const map = new Map<string, HallDefinition[]>();
    localHalls.forEach((h) => {
      h.blockNames?.forEach((b) => {
        const key = b.trim().normalize('NFKC').toLowerCase();
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
      alert('ホール名を入力してください');
      return;
    }
    const saved: HallDefinition = {
      id: editing.id,
      name: editing.name.trim(),
      vertices: [],
      color: editing.color,
      blockNames: editing.blockNames.length > 0 ? editing.blockNames : undefined,
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
            <h2 className="text-white font-bold text-base">ホール定義（ブロック割当）</h2>
            <p className="text-blue-100 text-xs mt-0.5">ブロック名でホールを定義します</p>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white text-2xl leading-none px-2"
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
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
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
                      className={`w-8 h-8 rounded-lg transition-all ${
                        editing.color === color
                          ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-slate-800'
                          : 'hover:ring-2 hover:ring-slate-300'
                      }`}
                      style={{ backgroundColor: color }}
                      aria-label={`色: ${color}`}
                    />
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
                      const otherHalls = (blockToHallsMap.get(key) || []).filter(
                        (h) => h.id !== editing.id,
                      );
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
                                  <span
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{ backgroundColor: h.color }}
                                  />
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
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold text-slate-700 flex-shrink-0"
                          style={{ backgroundColor: hall.color || HALL_COLORS[0] }}
                        >
                          {hall.name.slice(0, 2)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {hall.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {blockCount > 0
                              ? `ブロック: ${hall.blockNames!.join(', ')}`
                              : 'ブロック未割当'}
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
          <div className="border-t border-slate-200 dark:border-slate-700 px-4 py-3 flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
            <button
              onClick={handleConfirmAll}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SimpleHallDefinitionPanel;
