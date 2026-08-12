import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BlockDefinition, DayMapData, HallDefinition } from "../../types/map";
import { isPointInPolygonInclusive } from "../../utils/mapRoutePolygon";
import { validateHallPolygon } from "../../utils/polygonValidation";
import { useModalDialogBehavior } from "../../hooks/useModalDialogBehavior";

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
  eventDates?: string[];
  activeEventDate?: string;
  mapTabDates?: string[];
  onSyncToOtherDates?: (targetDates: string[]) => void;
}

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
  activeEventDate = "",
  mapTabDates = [],
  onSyncToOtherDates,
}) => {
  const [localHalls, setLocalHalls] = useState<HallDefinition[]>(halls);
  const [selectedHallIndex, setSelectedHallIndex] = useState<number | null>(
    null,
  );
  const [editingHall, setEditingHall] =
    useState<Partial<HallDefinition> | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [activeTab, setActiveTab] = useState<"list" | "edit">("list");
  const [showSyncUI, setShowSyncUI] = useState(false);
  const [syncTargetDates, setSyncTargetDates] = useState<Set<string>>(
    new Set(),
  );
  const handleClose = useCallback(() => {
    setLocalHalls(halls);
    onClose();
  }, [halls, onClose]);
  const { dialogRef, onDialogKeyDown } = useModalDialogBehavior({
    isOpen,
    onEscape: handleClose,
  });

  const otherMapDates = useMemo(
    () => mapTabDates.filter((d) => d !== activeEventDate),
    [mapTabDates, activeEventDate],
  );

  const getBlocksInHall = useCallback(
    (hall: HallDefinition): BlockDefinition[] => {
      if (!hall.vertices || hall.vertices.length < 4) return [];
      return mapData.blocks.filter((block) => {
        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;
        return isPointInPolygon(centerRow, centerCol, hall.vertices);
      });
    },
    [mapData.blocks],
  );

  const selectedHallBlocks = useMemo(() => {
    if (selectedHallIndex === null || !localHalls[selectedHallIndex]) return [];
    return getBlocksInHall(localHalls[selectedHallIndex]);
  }, [getBlocksInHall, localHalls, selectedHallIndex]);

  const liveValidation = useMemo(() => {
    if (!editingHall?.vertices || editingHall.vertices.length < 4) return null;
    return validateHallPolygon({
      vertices: editingHall.vertices,
      existingHalls: localHalls,
      currentHallId: editingHall.id,
      mapBounds: {
        maxRow: mapData.maxRow,
        maxCol: mapData.maxCol,
      },
    });
  }, [
    editingHall?.vertices,
    editingHall?.id,
    localHalls,
    mapData.maxRow,
    mapData.maxCol,
  ]);

  useEffect(() => {
    if (!pendingVertexSelection || !isOpen) return;

    const { vertices, editingData } = pendingVertexSelection;
    const data = editingData as EditingHallData | undefined;

    if (data) {
      if (data.currentHalls) setLocalHalls(data.currentHalls);
      setEditingHall(data.hall);
      setIsAddingNew(data.isAddingNew);
      setSelectedHallIndex(data.selectedIndex);
      setActiveTab("edit");
    }

    if (vertices && vertices.length >= 4) {
      setEditingHall((prev) => ({ ...(prev || {}), vertices: [...vertices] }));
      setActiveTab("edit");
    }

    onClearPendingVertexSelection?.();
  }, [isOpen, onClearPendingVertexSelection, pendingVertexSelection]);

  const handleCreateNewHall = useCallback(() => {
    setIsAddingNew(true);
    setSelectedHallIndex(null);
    setEditingHall({
      name: "",
      vertices: [],
      color: HALL_COLORS[localHalls.length % HALL_COLORS.length],
    });
    setActiveTab("edit");
  }, [localHalls.length]);

  const handleSelectHall = useCallback(
    (index: number) => {
      setSelectedHallIndex(index);
      setEditingHall({ ...localHalls[index] });
      setIsAddingNew(false);
      setActiveTab("edit");
    },
    [localHalls],
  );

  const handleStartVertexSelection = useCallback(() => {
    const editingData: EditingHallData = {
      hall: editingHall || {},
      isAddingNew,
      selectedIndex: selectedHallIndex,
      currentHalls: localHalls,
    };
    onStartVertexSelection(editingData);
  }, [
    editingHall,
    isAddingNew,
    selectedHallIndex,
    localHalls,
    onStartVertexSelection,
  ]);

  const handleSaveHall = useCallback(() => {
    if (!editingHall?.name?.trim()) {
      alert("ホール名を入力してください。");
      return;
    }

    // no-map 由来ホール: 頂点が未設定で blockNames を持つ場合は
    // ポリゴン検証をスキップして名称/色の変更のみ許容する
    const hasPolygon =
      !!editingHall.vertices && editingHall.vertices.length >= 4;
    const isMaplessEdit =
      !hasPolygon &&
      !!editingHall.blockNames &&
      editingHall.blockNames.length > 0;

    if (!hasPolygon && !isMaplessEdit) {
      alert("4〜6個の頂点を選択してください。");
      return;
    }

    if (hasPolygon) {
      const validation = validateHallPolygon({
        vertices: editingHall.vertices!,
        existingHalls: localHalls,
        currentHallId: editingHall.id,
        mapBounds: {
          maxRow: mapData.maxRow,
          maxCol: mapData.maxCol,
        },
      });
      const errors = validation.issues.filter(
        (issue) => issue.level === "error",
      );
      if (errors.length > 0) {
        alert(
          `保存できません:\n${errors.map((issue) => `・${issue.message}`).join("\n")}`,
        );
        return;
      }
      const warnings = validation.issues.filter(
        (issue) => issue.level === "warning",
      );
      if (warnings.length > 0) {
        const confirmed = confirm(
          `以下の警告があります:\n${warnings.map((issue) => `・${issue.message}`).join("\n")}\n\nこのまま保存しますか？`,
        );
        if (!confirmed) return;
      }
    }

    const name = editingHall.name.trim();
    if (isAddingNew && localHalls.find((hall) => hall.name === name)) {
      const shouldReplace = confirm(
        `「${name}」は既に存在します。置き換えますか？`,
      );
      if (!shouldReplace) return;
      setLocalHalls((prev) => prev.filter((hall) => hall.name !== name));
    }

    const saved: HallDefinition = {
      id: editingHall.id || `hall-${Date.now()}`,
      name,
      vertices: hasPolygon ? editingHall.vertices! : [],
      color:
        editingHall.color ||
        HALL_COLORS[localHalls.length % HALL_COLORS.length],
      // ポリゴンを設定した場合は blockNames を破棄してマップ側ホールへ移行
      ...(isMaplessEdit ? { blockNames: editingHall.blockNames } : {}),
    };

    if (isAddingNew) {
      setLocalHalls((prev) => [...prev, saved]);
    } else if (selectedHallIndex !== null) {
      setLocalHalls((prev) =>
        prev.map((hall, i) => (i === selectedHallIndex ? saved : hall)),
      );
    }

    setEditingHall(null);
    setSelectedHallIndex(null);
    setIsAddingNew(false);
    setActiveTab("list");
  }, [
    editingHall,
    isAddingNew,
    localHalls,
    mapData.maxRow,
    mapData.maxCol,
    selectedHallIndex,
  ]);

  const handleCancelEdit = useCallback(() => {
    setEditingHall(null);
    setSelectedHallIndex(null);
    setIsAddingNew(false);
    setActiveTab("list");
  }, []);

  const handleDeleteHall = useCallback(
    (index: number) => {
      const hall = localHalls[index];
      if (!confirm(`「${hall.name}」を削除しますか？`)) return;
      setLocalHalls((prev) => prev.filter((_, i) => i !== index));
      if (selectedHallIndex === index) {
        setSelectedHallIndex(null);
        setEditingHall(null);
        setIsAddingNew(false);
        setActiveTab("list");
      }
    },
    [localHalls, selectedHallIndex],
  );

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
    if (!onSyncToOtherDates || otherMapDates.length === 0) return;
    if (
      !confirm(
        `全ての他の日付（${otherMapDates.length}日分）のホール定義を上書きします。よろしいですか？`,
      )
    )
      return;
    onSyncToOtherDates(otherMapDates);
    setShowSyncUI(false);
    setSyncTargetDates(new Set());
  }, [onSyncToOtherDates, otherMapDates]);

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hall-definition-title"
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="flex w-full max-w-4xl max-h-[90vh] flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-700">
          <h2
            id="hall-definition-title"
            className="text-lg font-bold text-slate-900 dark:text-white"
          >
            ホール定義エリア設定
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="ホール定義エリア設定を閉じる"
            className="text-2xl text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setActiveTab("list")}
              className={`px-3 py-1.5 text-sm rounded ${
                activeTab === "list"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300"
              }`}
            >
              一覧
            </button>
            <button
              onClick={() => setActiveTab("edit")}
              className={`px-3 py-1.5 text-sm rounded ${
                activeTab === "edit"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300"
              }`}
            >
              編集
            </button>
          </div>

          {activeTab === "list" && (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  定義済みホール ({localHalls.length}件)
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={handleCreateNewHall}
                    className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
                  >
                    + 新規
                  </button>
                  <button
                    onClick={() =>
                      confirm("すべてのホール定義を削除しますか？") &&
                      setLocalHalls([])
                    }
                    className="rounded bg-red-100 px-3 py-1.5 text-xs text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400"
                  >
                    全削除
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {localHalls.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    ホールが定義されていません。
                  </p>
                ) : (
                  localHalls.map((hall, i) => {
                    const blocksInHall = getBlocksInHall(hall);
                    return (
                      <div
                        key={hall.id}
                        className={`rounded-lg border p-3 transition-colors ${
                          selectedHallIndex === i
                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                            : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/50"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() => handleSelectHall(i)}
                            className="flex flex-1 items-center gap-2 text-left"
                          >
                            <div className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded text-xs font-bold">
                              <svg
                                className="absolute inset-0 h-full w-full"
                                viewBox="0 0 32 32"
                                aria-hidden="true"
                              >
                                <rect
                                  width="32"
                                  height="32"
                                  fill={hall.color || "#FFE0B2"}
                                />
                              </svg>
                              <span className="relative">
                                {hall.vertices && hall.vertices.length >= 4
                                  ? `${hall.vertices.length}角`
                                  : "ブロック"}
                              </span>
                            </div>
                            <div>
                              <div className="text-sm font-medium text-slate-900 dark:text-white">
                                {hall.name}
                              </div>
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                {blocksInHall.length}ブロック
                              </div>
                            </div>
                          </button>
                          <button
                            onClick={() => handleDeleteHall(i)}
                            aria-label={`${hall.name}を削除`}
                            className="p-1 text-red-700 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {activeTab === "edit" && (
            <div className="rounded-lg bg-slate-50 p-4 dark:bg-slate-900">
              {editingHall ? (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                    {isAddingNew ? "新規ホール追加" : "ホール編集"}
                  </h3>

                  {!isAddingNew &&
                    (!editingHall.vertices ||
                      editingHall.vertices.length < 4) &&
                    !!editingHall.blockNames?.length && (
                      <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                        このホールは現在ブロック指定のみで定義されています（
                        {editingHall.blockNames.length}ブロック）。
                        ポリゴンを設定するとマップ側ホールへ移行します（ブロック指定は破棄されます）。
                        名称・色のみの変更であればそのまま保存できます。
                      </div>
                    )}

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      ホール名
                    </label>
                    <input
                      type="text"
                      value={editingHall.name || ""}
                      onChange={(e) =>
                        setEditingHall((prev) => ({
                          ...prev,
                          name: e.target.value,
                        }))
                      }
                      placeholder="例: 東1ホール"
                      className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      エリア定義（4〜6個の頂点）
                    </label>
                    <button
                      onClick={handleStartVertexSelection}
                      className="w-full rounded bg-orange-100 px-3 py-2 text-sm text-orange-700 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400"
                    >
                      マップ上で頂点を選択
                    </button>
                    {editingHall.vertices &&
                      editingHall.vertices.length > 0 && (
                        <div className="mt-2 rounded bg-green-50 p-2 dark:bg-green-900/20">
                          <div className="text-xs text-green-700 dark:text-green-400">
                            選択済み: {editingHall.vertices.length}頂点
                          </div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {editingHall.vertices
                              .map((v) => `(${v.row},${v.col})`)
                              .join(" → ")}
                          </div>
                        </div>
                      )}
                    {liveValidation && liveValidation.issues.length > 0 && (
                      <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-900/20">
                        {liveValidation.issues.map((issue) => (
                          <div
                            key={issue.code}
                            className={`text-xs ${
                              issue.level === "error"
                                ? "text-red-700 dark:text-red-400"
                                : "text-amber-700 dark:text-amber-400"
                            }`}
                          >
                            {issue.level === "error" ? "エラー" : "警告"}:{" "}
                            {issue.message}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      色
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {HALL_COLORS.map((color) => (
                        <button
                          type="button"
                          key={color}
                          onClick={() =>
                            setEditingHall((prev) => ({ ...prev, color }))
                          }
                          className={`relative h-8 w-8 overflow-hidden rounded border-2 ${
                            editingHall.color === color
                              ? "border-blue-500"
                              : "border-transparent"
                          }`}
                          aria-label={`色: ${color}`}
                        >
                          <svg
                            className="absolute inset-0 h-full w-full"
                            viewBox="0 0 32 32"
                            aria-hidden="true"
                          >
                            <rect width="32" height="32" fill={color} />
                          </svg>
                        </button>
                      ))}
                    </div>
                  </div>

                  {!isAddingNew && selectedHallBlocks.length > 0 && (
                    <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
                      <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-400">
                        含まれるブロック ({selectedHallBlocks.length}個)
                      </div>
                      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                        {selectedHallBlocks.map((block) => (
                          <span
                            key={block.name}
                            className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-300"
                          >
                            {block.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleSaveHall}
                      className="flex-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                    >
                      {isAddingNew ? "追加" : "保存"}
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="rounded bg-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center text-slate-500 dark:text-slate-400">
                  <p className="mb-2">
                    編集するホールを一覧から選択してください。
                  </p>
                  <button
                    onClick={() => setActiveTab("list")}
                    className="rounded bg-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                  >
                    一覧へ戻る
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 px-6 py-4 dark:border-slate-700 space-y-3">
          {/* 同期UI */}
          {showSyncUI && (
            <div className="rounded-lg border border-indigo-200 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/20 p-3 space-y-2">
              <div className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                同期先の日付を選択（現在: {activeEventDate}）
              </div>
              {otherMapDates.length === 0 ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 py-2">
                  マップが設定された他の日付がありません
                </div>
              ) : (
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {otherMapDates.map((date) => (
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
              )}
              <div className="flex gap-2 pt-1">
                {otherMapDates.length > 0 && (
                  <>
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
                  </>
                )}
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
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="rounded bg-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
            {onSyncToOtherDates &&
              otherMapDates.length > 0 &&
              localHalls.length > 0 && (
                <button
                  onClick={() => setShowSyncUI((v) => !v)}
                  className={`rounded px-4 py-2 text-sm transition-colors ${
                    showSyncUI
                      ? "text-indigo-700 bg-indigo-100 dark:text-indigo-300 dark:bg-indigo-800/40"
                      : "text-indigo-600 bg-indigo-50 dark:text-indigo-400 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-800/40"
                  }`}
                >
                  他の日に同期
                </button>
              )}
            <button
              onClick={() => {
                onUpdateHalls(localHalls);
                onClose();
              }}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            >
              適用
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function isPointInPolygon(
  row: number,
  col: number,
  vertices: { row: number; col: number }[],
): boolean {
  return isPointInPolygonInclusive(row, col, vertices);
}

export { isPointInPolygon };
export default HallDefinitionPanel;
