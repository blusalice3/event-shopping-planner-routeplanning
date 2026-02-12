import React, { useState, useCallback, useMemo } from 'react';
import { DayMapData, HallDefinition, BlockDefinition } from '../../types';

interface HallDefinitionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  mapData: DayMapData;
  halls: HallDefinition[];
  onUpdateHalls: (halls: HallDefinition[]) => void;
  onStartVertexSelection: (editingData?: unknown) => void;
  pendingVertexSelection?: {
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null;
  onClearPendingVertexSelection?: () => void;
}

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

interface EditingHallData {
  hall: Partial<HallDefinition>;
  isAddingNew: boolean;
  selectedIndex: number | null;
  currentHalls: HallDefinition[];
}

const HallDefinitionPanel: React.FC<HallDefinitionPanelProps> = ({
  isOpen,
  onClose,
  mapData,
  halls,
  onUpdateHalls,
  onStartVertexSelection,
  pendingVertexSelection,
  onClearPendingVertexSelection,
}) => {
  const [localHalls, setLocalHalls] = useState<HallDefinition[]>(halls);
  const [selectedHallIndex, setSelectedHallIndex] = useState<number | null>(null);
  const [editingHall, setEditingHall] = useState<Partial<HallDefinition> | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);

  // ブロックがどのホールに属するか判定
  const getBlocksInHall = useCallback(
    (hall: HallDefinition): BlockDefinition[] => {
      if (!hall.vertices || hall.vertices.length < 4) return [];

      return mapData.blocks.filter((block) => {
        // ブロックの中心点を計算
        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;

        // 多角形内に点があるか判定（Ray casting algorithm）
        return isPointInPolygon(centerRow, centerCol, hall.vertices);
      });
    },
    [mapData.blocks],
  );

  // 選択中ホールのブロック
  const selectedHallBlocks = useMemo(() => {
    if (selectedHallIndex === null || !localHalls[selectedHallIndex]) return [];
    return getBlocksInHall(localHalls[selectedHallIndex]);
  }, [selectedHallIndex, localHalls, getBlocksInHall]);

  // 頂点選択結果を受け取った時の処理
  React.useEffect(() => {
    if (!pendingVertexSelection || !isOpen) return;

    const { vertices, editingData } = pendingVertexSelection;
    const data = editingData as EditingHallData | undefined;

    if (data) {
      if (data.currentHalls) setLocalHalls(data.currentHalls);
      setEditingHall(data.hall);
      setIsAddingNew(data.isAddingNew);
      setSelectedHallIndex(data.selectedIndex);
    }

    if (vertices && vertices.length >= 4) {
      setEditingHall((prev) => ({ ...prev, vertices: [...vertices] }));
    }

    if (onClearPendingVertexSelection) {
      onClearPendingVertexSelection();
    }
  }, [pendingVertexSelection, isOpen, onClearPendingVertexSelection]);

  // 頂点選択を開始
  const handleStartVertexSelection = useCallback(() => {
    const editingData: EditingHallData = {
      hall: editingHall || {},
      isAddingNew,
      selectedIndex: selectedHallIndex,
      currentHalls: localHalls,
    };
    onStartVertexSelection(editingData);
  }, [editingHall, isAddingNew, selectedHallIndex, localHalls, onStartVertexSelection]);

  // ホールを保存
  const handleSaveHall = useCallback(() => {
    if (!editingHall?.name?.trim()) {
      alert('ホール名を入力してください');
      return;
    }
    if (!editingHall.vertices || editingHall.vertices.length < 4) {
      alert('4〜6個の頂点を選択してください');
      return;
    }

    const name = editingHall.name.trim();

    // 重複チェック
    if (isAddingNew && localHalls.find((h) => h.name === name)) {
      if (!confirm(`「${name}」は既に存在します。置き換えますか？`)) return;
      setLocalHalls((prev) => prev.filter((h) => h.name !== name));
    }

    const saved: HallDefinition = {
      id: editingHall.id || `hall-${Date.now()}`,
      name,
      vertices: editingHall.vertices,
      color: editingHall.color || HALL_COLORS[localHalls.length % HALL_COLORS.length],
    };

    if (isAddingNew) {
      setLocalHalls((prev) => [...prev, saved]);
    } else if (selectedHallIndex !== null) {
      setLocalHalls((prev) => prev.map((h, i) => (i === selectedHallIndex ? saved : h)));
    }

    setEditingHall(null);
    setSelectedHallIndex(null);
    setIsAddingNew(false);
  }, [editingHall, isAddingNew, selectedHallIndex, localHalls]);

  // 編集キャンセル
  const handleCancelEdit = useCallback(() => {
    setEditingHall(null);
    setSelectedHallIndex(null);
    setIsAddingNew(false);
  }, []);

  // ホール削除
  const handleDeleteHall = useCallback(
    (index: number) => {
      const hall = localHalls[index];
      if (confirm(`「${hall.name}」を削除しますか？`)) {
        setLocalHalls((prev) => prev.filter((_, i) => i !== index));
        if (selectedHallIndex === index) {
          setSelectedHallIndex(null);
          setEditingHall(null);
        }
      }
    },
    [localHalls, selectedHallIndex],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            ホール（表示エリア）定義
          </h2>
          <button
            onClick={() => {
              setLocalHalls(halls);
              onClose();
            }}
            className="text-2xl text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            ✕
          </button>
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-2 gap-6">
            {/* 左: ホール一覧 */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  定義済みホール ({localHalls.length}件)
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setIsAddingNew(true);
                      setSelectedHallIndex(null);
                      setEditingHall({
                        name: '',
                        vertices: [],
                        color: HALL_COLORS[localHalls.length % HALL_COLORS.length],
                      });
                    }}
                    className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    + 新規
                  </button>
                  <button
                    onClick={() => confirm('全てのホール定義を削除しますか？') && setLocalHalls([])}
                    className="px-3 py-1.5 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400"
                  >
                    全削除
                  </button>
                </div>
              </div>

              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {localHalls.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">
                    ホールが定義されていません
                  </p>
                ) : (
                  localHalls.map((hall, i) => {
                    const blocksInHall = getBlocksInHall(hall);
                    return (
                      <div
                        key={hall.id}
                        className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedHallIndex === i
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                        }`}
                        onClick={() => {
                          setSelectedHallIndex(i);
                          setEditingHall({ ...hall });
                          setIsAddingNew(false);
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold"
                              style={{ backgroundColor: hall.color || '#FFE0B2' }}
                            >
                              {hall.vertices.length}角
                            </div>
                            <div>
                              <div className="text-sm font-medium text-slate-900 dark:text-white">
                                {hall.name}
                              </div>
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                {blocksInHall.length}ブロック
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteHall(i);
                            }}
                            className="p-1 text-red-500 hover:text-red-700"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* 右: 編集パネル */}
            <div>
              {editingHall ? (
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
                    {isAddingNew ? '新規ホール追加' : 'ホール編集'}
                  </h3>

                  <div className="space-y-4">
                    {/* ホール名 */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        ホール名
                      </label>
                      <input
                        type="text"
                        value={editingHall.name || ''}
                        onChange={(e) =>
                          setEditingHall((prev) => ({ ...prev, name: e.target.value }))
                        }
                        placeholder="例: 東1ホール, 西34ホール"
                        className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                    </div>

                    {/* 頂点選択 */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        エリア定義（4〜6個の頂点）
                      </label>
                      <button
                        onClick={handleStartVertexSelection}
                        className="w-full px-3 py-2 text-sm rounded bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400"
                      >
                        📍 マップ上で頂点をクリックして選択
                      </button>
                      {editingHall.vertices && editingHall.vertices.length > 0 && (
                        <div className="mt-2 p-2 bg-green-50 dark:bg-green-900/20 rounded">
                          <div className="text-xs text-green-700 dark:text-green-400">
                            選択済み: {editingHall.vertices.length}頂点
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            {editingHall.vertices.map((v) => `(${v.row},${v.col})`).join(' → ')}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 色選択 */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        色
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {HALL_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setEditingHall((prev) => ({ ...prev, color: c }))}
                            className={`w-8 h-8 rounded border-2 ${
                              editingHall.color === c ? 'border-blue-500' : 'border-transparent'
                            }`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>

                    {/* 含まれるブロック */}
                    {!isAddingNew && selectedHallBlocks.length > 0 && (
                      <div className="p-3 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700">
                        <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                          含まれるブロック ({selectedHallBlocks.length}個)
                        </div>
                        <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                          {selectedHallBlocks.map((block, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 text-xs bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded"
                            >
                              {block.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ボタン */}
                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={handleSaveHall}
                        className="flex-1 px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {isAddingNew ? '追加' : '保存'}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="px-4 py-2 text-sm rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400">
                  <p className="mb-2">左からホールを選択して編集</p>
                  <p className="text-sm">または「新規」で追加</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* フッター */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
          <button
            onClick={() => {
              setLocalHalls(halls);
              onClose();
            }}
            className="px-4 py-2 text-sm rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
          >
            キャンセル
          </button>
          <button
            onClick={() => {
              onUpdateHalls(localHalls);
              onClose();
            }}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
};

// 点が多角形内にあるか判定（Ray casting algorithm）
function isPointInPolygon(
  row: number,
  col: number,
  vertices: { row: number; col: number }[],
): boolean {
  let inside = false;
  const n = vertices.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = vertices[i];
    const vj = vertices[j];

    if (
      vi.col > col !== vj.col > col &&
      row < ((vj.row - vi.row) * (col - vi.col)) / (vj.col - vi.col) + vi.row
    ) {
      inside = !inside;
    }
  }

  return inside;
}

export { isPointInPolygon };
export default HallDefinitionPanel;
