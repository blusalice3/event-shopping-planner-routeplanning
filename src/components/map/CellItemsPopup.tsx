import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useId,
} from "react";
import { createPortal } from "react-dom";
import {
  ShoppingItem,
  PurchaseStatus,
  PurchaseStatuses,
} from "../../types/item";
import { getBaseNumber } from "../../utils/spaceGrouping";
import {
  clearLimitedPurchase,
  formatDisplayQuantity,
  getActualPurchasedQuantity,
  getPlannedQuantity,
  parseDecimalIntegerInput,
  validateLimitedPurchasePlannedQuantity,
  type LimitedPurchaseValidationError,
} from "../../utils/purchaseQuantity";
import {
  buildQuantityOptions,
  isStandardQuantityOption,
} from "../quantityOptions";
import { useModalDialogBehavior } from "../../hooks/useModalDialogBehavior";

interface SpaceGroup {
  baseNumber: string;
  label: string;
  itemIds: string[];
  addedCount: number;
  totalCount: number;
}

interface CellItemsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  blockName: string;
  number: number;
  items: ShoppingItem[];
  executeModeItemIds: Set<string>;
  onAddToVisitList: (itemId: string) => void;
  onRemoveFromVisitList: (itemId: string) => void;
  onBatchAddToVisitList?: (itemIds: string[]) => void;
  onBatchRemoveFromVisitList?: (itemIds: string[]) => void;
  onUpdateItem?: (item: ShoppingItem) => void;
  onDeleteItem?: (itemId: string) => void;
  onAddItem?: (
    item: Omit<ShoppingItem, "id"> & { purchaseStatus?: PurchaseStatus },
  ) => void;
  onUpdateItemPriority?: (
    itemId: string,
    level: "none" | "priority" | "highest",
  ) => void;
  onEditRequest?: (item: ShoppingItem) => void;
  eventDate?: string;
}

const statusLabels: Record<PurchaseStatus, string> = {
  None: "未購入",
  Purchased: "購入済",
  SoldOut: "売切",
  Absent: "欠席",
  Postpone: "後回し",
  Late: "遅参",
  LimitedPurchase: "限数",
};

const CELL_POPUP_OPENING_CLICK_GUARD_MS = 400;

const getExternalUrlHref = (url?: string) => {
  const trimmedUrl = url?.trim();
  if (!trimmedUrl) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmedUrl) || trimmedUrl.startsWith("//")) {
    return trimmedUrl;
  }
  return `https://${trimmedUrl}`;
};

const CellItemsPopup: React.FC<CellItemsPopupProps> = ({
  isOpen,
  onClose,
  blockName,
  number,
  items,
  executeModeItemIds,
  onAddToVisitList,
  onRemoveFromVisitList,
  onBatchAddToVisitList,
  onBatchRemoveFromVisitList,
  onUpdateItem,
  onDeleteItem,
  onAddItem,
  onUpdateItemPriority,
  onEditRequest,
  eventDate,
}) => {
  const fieldIdPrefix = useId();
  const editDialogIds = {
    title: `${fieldIdPrefix}-edit-title`,
    description: `${fieldIdPrefix}-edit-description`,
    circle: `${fieldIdPrefix}-edit-circle`,
    itemTitle: `${fieldIdPrefix}-edit-item-title`,
    pricePreset: `${fieldIdPrefix}-edit-price-preset`,
    price: `${fieldIdPrefix}-edit-price`,
    quantity: `${fieldIdPrefix}-edit-quantity`,
    purchaseStatus: `${fieldIdPrefix}-edit-purchase-status`,
    priority: `${fieldIdPrefix}-edit-priority`,
    remarks: `${fieldIdPrefix}-edit-remarks`,
    url: `${fieldIdPrefix}-edit-url`,
  } as const;
  const addDialogIds = {
    title: `${fieldIdPrefix}-add-title`,
    description: `${fieldIdPrefix}-add-description`,
    circle: `${fieldIdPrefix}-add-circle`,
    circleSuggestions: `${fieldIdPrefix}-add-circle-suggestions`,
    itemTitle: `${fieldIdPrefix}-add-item-title`,
    eventDate: `${fieldIdPrefix}-add-event-date`,
    block: `${fieldIdPrefix}-add-block`,
    number: `${fieldIdPrefix}-add-number`,
    price: `${fieldIdPrefix}-add-price`,
    pricePreset: `${fieldIdPrefix}-add-price-preset`,
    quantity: `${fieldIdPrefix}-add-quantity`,
    purchaseStatus: `${fieldIdPrefix}-add-purchase-status`,
    remarks: `${fieldIdPrefix}-add-remarks`,
    url: `${fieldIdPrefix}-add-url`,
  } as const;
  const popupRef = useRef<HTMLDivElement>(null);
  const [longPressItem, setLongPressItem] = useState<ShoppingItem | null>(null);
  const [editingItem, setEditingItem] = useState<ShoppingItem | null>(null);
  const [editingQuantityText, setEditingQuantityText] = useState("1");
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [addQuantityError, setAddQuantityError] = useState<string | null>(null);
  const longPressTimeout = useRef<number | null>(null);
  const isLongPress = useRef(false);
  const suppressNextClick = useRef(false);
  const suppressPopupClickUntilRef = useRef(0);

  // === アイテム追加ダイアログ ===
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newItemForm, setNewItemForm] = useState({
    circle: "",
    title: "",
    price: "",
    quantity: "1",
    remarks: "",
    url: "",
    numberOverride: "",
    purchaseStatus: "None" as "None" | "Purchased" | "Postpone" | "Late",
  });

  const spaceGroups: SpaceGroup[] = useMemo(() => {
    const groupMap = new Map<
      string,
      { itemIds: string[]; addedCount: number }
    >();
    const groupOrder: string[] = [];
    for (const item of items) {
      const base = getBaseNumber(item.number);
      let group = groupMap.get(base);
      if (!group) {
        group = { itemIds: [], addedCount: 0 };
        groupMap.set(base, group);
        groupOrder.push(base);
      }
      group.itemIds.push(item.id);
      if (executeModeItemIds.has(item.id)) {
        group.addedCount++;
      }
    }
    return groupOrder.map((base) => {
      const g = groupMap.get(base)!;
      const suffix = base.replace(/^\d+/, "");
      return {
        baseNumber: base,
        label: suffix || base,
        itemIds: g.itemIds,
        addedCount: g.addedCount,
        totalCount: g.itemIds.length,
      };
    });
  }, [items, executeModeItemIds]);

  const handleSpaceGroupClick = useCallback(
    (group: SpaceGroup) => {
      if (group.addedCount === group.totalCount) {
        // 全追加済み → 全解除
        const addedIds = group.itemIds.filter((id) =>
          executeModeItemIds.has(id),
        );
        if (onBatchRemoveFromVisitList) {
          onBatchRemoveFromVisitList(addedIds);
        } else {
          addedIds.forEach((id) => onRemoveFromVisitList(id));
        }
      } else {
        // 未追加あり → 未追加分を追加
        const notAddedIds = group.itemIds.filter(
          (id) => !executeModeItemIds.has(id),
        );
        if (onBatchAddToVisitList) {
          onBatchAddToVisitList(notAddedIds);
        } else {
          notAddedIds.forEach((id) => onAddToVisitList(id));
        }
      }
    },
    [
      executeModeItemIds,
      onBatchAddToVisitList,
      onBatchRemoveFromVisitList,
      onAddToVisitList,
      onRemoveFromVisitList,
    ],
  );

  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);

  const toPlannedQuantityMessage = (
    error: LimitedPurchaseValidationError,
  ): string => {
    if (error === "planned_required") return "購入予定量を入力してください";
    if (error === "planned_not_integer")
      return "購入予定量は整数で入力してください";
    if (error === "planned_not_positive")
      return "購入予定量は1以上で入力してください";
    return "購入予定量を確認してください";
  };

  const handlePriceInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value.replace(/[^0-9]/g, "");
      setNewItemForm((prev) => ({ ...prev, price: value }));
    },
    [],
  );

  const handlePriceSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setNewItemForm((prev) => ({ ...prev, price: e.target.value }));
    },
    [],
  );

  const openAddDialog = useCallback(() => {
    setNewItemForm({
      circle: "",
      title: "",
      price: "",
      quantity: "1",
      remarks: "",
      url: "",
      numberOverride: String(number),
      purchaseStatus: "None",
    });
    setAddQuantityError(null);
    setAddDialogOpen(true);
  }, [number]);

  const closeAddDialog = useCallback(() => {
    setAddDialogOpen(false);
  }, []);
  const { dialogRef: editDialogRef, onDialogKeyDown: onEditDialogKeyDown } =
    useModalDialogBehavior({
      isOpen: editingItem !== null,
      onEscape: () => setEditingItem(null),
      fallbackFocusRef: popupRef,
    });
  const { dialogRef: addDialogRef, onDialogKeyDown: onAddDialogKeyDown } =
    useModalDialogBehavior({
      isOpen: addDialogOpen,
      onEscape: closeAddDialog,
      fallbackFocusRef: popupRef,
    });

  const handleAddItem = useCallback(() => {
    if (!onAddItem || !newItemForm.circle.trim()) return;
    const parsedQuantity = parseDecimalIntegerInput(newItemForm.quantity);
    const quantityValidation =
      validateLimitedPurchasePlannedQuantity(parsedQuantity);
    if (!quantityValidation.ok) {
      setAddQuantityError(toPlannedQuantityMessage(quantityValidation.error));
      return;
    }
    const price =
      newItemForm.price === "" ? null : parseInt(newItemForm.price, 10) || 0;
    onAddItem({
      eventDate: eventDate || "",
      block: blockName,
      number: newItemForm.numberOverride || String(number),
      circle: newItemForm.circle,
      title: newItemForm.title,
      price,
      quantity: parsedQuantity!,
      remarks: newItemForm.remarks,
      url: newItemForm.url || undefined,
      purchaseStatus: newItemForm.purchaseStatus,
    });
    closeAddDialog();
    onClose();
  }, [
    onAddItem,
    newItemForm,
    eventDate,
    blockName,
    number,
    closeAddDialog,
    onClose,
  ]);

  // 表示元のpointerup後に発生する互換clickだけを、DOM反映時点から抑止する。
  useLayoutEffect(() => {
    if (!isOpen) {
      suppressPopupClickUntilRef.current = 0;
      return;
    }
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    suppressPopupClickUntilRef.current =
      now + CELL_POPUP_OPENING_CLICK_GUARD_MS;
  }, [isOpen]);

  // ダイアログが閉じたらサブ状態もリセット
  useEffect(() => {
    if (!isOpen) {
      setAddDialogOpen(false);
      setLongPressItem(null);
      setEditingItem(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (e: PointerEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        if (!longPressItem && !editingItem && !addDialogOpen) {
          onClose();
        }
      }
    };
    if (isOpen) {
      document.addEventListener("pointerdown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
    };
  }, [isOpen, onClose, longPressItem, editingItem, addDialogOpen]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  }, []);

  const handleItemPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    item: ShoppingItem,
  ) => {
    isLongPress.current = false;
    suppressNextClick.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture はブラウザ依存のため利用不可環境はそのまま継続する。
    }
    clearLongPressTimer();
    longPressTimeout.current = window.setTimeout(() => {
      isLongPress.current = true;
      suppressNextClick.current = true;
      setLongPressItem(item);
    }, 500);
  };

  const handleItemPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // releasePointerCapture はブラウザ依存のため利用不可環境はそのまま継続する。
    }
    clearLongPressTimer();
  };

  const handleItemPointerLeave = () => {
    clearLongPressTimer();
  };

  const handlePopupInteractionStart = () => {
    // ポップアップ内で始まった新しい操作は、表示元のジェスチャーとは別操作。
    suppressPopupClickUntilRef.current = 0;
  };

  const handleItemClick = (item: ShoppingItem) => {
    if (isLongPress.current || suppressNextClick.current) {
      isLongPress.current = false;
      suppressNextClick.current = false;
      return;
    }
    handleVisitToggle(item);
  };

  const handlePopupClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now < suppressPopupClickUntilRef.current && e.detail > 0) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleVisitToggle = (item: ShoppingItem) => {
    if (executeModeItemIds.has(item.id)) {
      onRemoveFromVisitList(item.id);
    } else {
      onAddToVisitList(item.id);
    }
  };

  const handleEdit = () => {
    if (longPressItem) {
      setEditingItem({ ...longPressItem });
      setEditingQuantityText(String(getPlannedQuantity(longPressItem)));
      setQuantityError(null);
      setLongPressItem(null);
    }
  };

  const longPressItemUrlHref = getExternalUrlHref(longPressItem?.url);

  const handleDelete = () => {
    if (longPressItem && onDeleteItem) {
      onDeleteItem(longPressItem.id);
      setLongPressItem(null);
    }
  };

  const handleSaveEdit = () => {
    if (editingItem && onUpdateItem) {
      if (editingItem.purchaseStatus === "LimitedPurchase") return;
      const parsedQuantity = parseDecimalIntegerInput(editingQuantityText);
      const quantityValidation =
        validateLimitedPurchasePlannedQuantity(parsedQuantity);
      if (!quantityValidation.ok) {
        setQuantityError(toPlannedQuantityMessage(quantityValidation.error));
        return;
      }
      const originalItem = items.find((i) => i.id === editingItem.id);
      const originalPriority = originalItem?.priorityLevel || "none";
      const newPriority = editingItem.priorityLevel || "none";
      onUpdateItem(
        clearLimitedPurchase({ ...editingItem, quantity: parsedQuantity! }),
      );
      if (newPriority !== originalPriority && onUpdateItemPriority) {
        onUpdateItemPriority(editingItem.id, newPriority);
      }
      setEditingItem(null);
    }
  };

  if (!isOpen) return null;

  const formInputClass =
    "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white";
  const labelClass =
    "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";

  return createPortal(
    <>
      <div
        ref={popupRef}
        className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl transition-all duration-150 dark:border-slate-700 dark:bg-slate-800"
        role="dialog"
        aria-label={`${blockName}-${number}のアイテム一覧`}
        onClickCapture={handlePopupClickCapture}
        onPointerDownCapture={handlePopupInteractionStart}
        onTouchStartCapture={handlePopupInteractionStart}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
            <h2 className="font-semibold text-slate-900 dark:text-white whitespace-nowrap">
              {blockName}-{number}{" "}
              {items.length > 0 ? `（${items.length}件）` : ""}
            </h2>
            {spaceGroups.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {spaceGroups.map((group) => {
                  const allAdded = group.addedCount === group.totalCount;
                  const someAdded = group.addedCount > 0 && !allAdded;
                  return (
                    <button
                      key={group.baseNumber}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSpaceGroupClick(group);
                      }}
                      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium border transition-colors ${
                        allAdded
                          ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700"
                          : someAdded
                            ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-600"
                            : "bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-600"
                      }`}
                      title={`${group.baseNumber}: ${group.addedCount}/${group.totalCount}件追加済み`}
                    >
                      <span>{group.label}</span>
                      <span className="text-[10px]">
                        {allAdded ? "✓" : someAdded ? "─" : "○"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`${blockName}-${number}のアイテム一覧を閉じる`}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* 新規追加ボタン */}
        {onAddItem && (
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
            <button
              onClick={openAddDialog}
              className="w-full py-2 px-4 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              新規アイテム追加
            </button>
          </div>
        )}

        {/* アイテムリスト */}
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 && !onAddItem && (
            <div className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
              このセルにはアイテムがありません
            </div>
          )}
          {[...items]
            .sort((a, b) => {
              const suffixA = a.number.replace(/^\d+/, "");
              const suffixB = b.number.replace(/^\d+/, "");
              // サフィックスをアルファベット部分と数字部分に分解
              const parseA = suffixA.match(/^([a-zA-Z]*)(\d*)$/);
              const parseB = suffixB.match(/^([a-zA-Z]*)(\d*)$/);
              const alphaA = parseA ? parseA[1].toLowerCase() : "";
              const alphaB = parseB ? parseB[1].toLowerCase() : "";
              if (alphaA !== alphaB) return alphaA.localeCompare(alphaB);
              const numA = parseA && parseA[2] ? parseInt(parseA[2], 10) : 0;
              const numB = parseB && parseB[2] ? parseInt(parseB[2], 10) : 0;
              return numA - numB;
            })
            .map((item) => {
              const isInVisitList = executeModeItemIds.has(item.id);
              const numberSuffix = item.number.replace(/^\d+/, "");
              const priorityLevel = item.priorityLevel || "none";
              return (
                <div
                  key={item.id}
                  className={`relative p-4 border-b border-slate-100 dark:border-slate-700 last:border-b-0 cursor-pointer select-none ${
                    isInVisitList
                      ? "bg-blue-50 dark:bg-blue-900/20"
                      : "hover:bg-slate-50 dark:hover:bg-slate-700/50"
                  }`}
                  onPointerDown={(e) => handleItemPointerDown(e, item)}
                  onPointerUp={handleItemPointerUp}
                  onPointerLeave={handleItemPointerLeave}
                  onPointerCancel={handleItemPointerLeave}
                  onTouchMove={handleItemPointerLeave}
                  onClick={() => handleItemClick(item)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {isInVisitList && (
                          <span className="text-blue-500">📍</span>
                        )}
                        <span className="font-medium text-slate-900 dark:text-white">
                          {item.circle}
                        </span>
                        {numberSuffix && (
                          <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                            [{numberSuffix}]
                          </span>
                        )}
                        {(priorityLevel === "priority" ||
                          priorityLevel === "highest") && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                              priorityLevel === "highest"
                                ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
                            }`}
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                priorityLevel === "highest"
                                  ? "bg-red-500"
                                  : "bg-orange-500"
                              }`}
                            />
                            {priorityLevel === "highest" ? "最優先" : "優先"}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                        {item.title}
                      </p>
                      {item.catalogPrice !== undefined && (
                        <p className="text-sm text-slate-500 dark:text-slate-500 mt-1">
                          カタログ価格:{" "}
                          {item.catalogPrice === null
                            ? "未定"
                            : `¥${item.catalogPrice.toLocaleString()}`}
                        </p>
                      )}
                      <p className="text-sm text-slate-500 dark:text-slate-500 mt-1">
                        購入金額:{" "}
                        {item.price === null
                          ? "未定"
                          : `¥${item.price.toLocaleString()}`}
                      </p>
                      {item.sheetRemarks?.trim() && (
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                          シート備考: {item.sheetRemarks}
                        </p>
                      )}
                      {item.remarks && (
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                          利用者メモ: {item.remarks}
                        </p>
                      )}
                      {item.purchaseStatus !== "None" && (
                        <span
                          className={`inline-block mt-2 px-2 py-0.5 text-xs rounded-full ${
                            item.purchaseStatus === "Purchased"
                              ? "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300"
                              : item.purchaseStatus === "SoldOut"
                                ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300"
                                : "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300"
                          }`}
                        >
                          {statusLabels[item.purchaseStatus]}
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-xs px-2 py-1 rounded ${isInVisitList ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400"}`}
                    >
                      {isInVisitList ? "訪問先" : "タップで追加"}
                    </div>
                  </div>
                  {item.purchaseStatus === "LimitedPurchase" &&
                    onEditRequest && (
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            clearLongPressTimer();
                            setLongPressItem(null);
                            onClose();
                            onEditRequest(item);
                          }}
                          className="rounded bg-orange-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-800"
                        >
                          限数を編集
                        </button>
                      </div>
                    )}
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-right">
                    長押しで編集・削除
                  </p>
                </div>
              );
            })}
        </div>
      </div>

      {/* 長押しメニュー */}
      {longPressItem && (
        <div
          className="fixed inset-0 bg-black/30 z-[60] flex items-center justify-center"
          onClick={() => setLongPressItem(null)}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-64"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-slate-200 dark:border-slate-700">
              <div className="font-medium text-slate-900 dark:text-white truncate">
                {longPressItem.circle}
              </div>
              {longPressItem.title && (
                <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
                  {longPressItem.title}
                </div>
              )}
            </div>
            <div className="py-1">
              <button
                onClick={handleEdit}
                className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                ✏️ 編集
              </button>
              {longPressItemUrlHref && (
                <a
                  href={longPressItemUrlHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setLongPressItem(null)}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  🔗 URLを開く
                </a>
              )}
              {onDeleteItem && (
                <button
                  onClick={handleDelete}
                  className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  🗑️ 削除
                </button>
              )}
            </div>
            <div className="p-2 border-t border-slate-200 dark:border-slate-700">
              <button
                onClick={() => setLongPressItem(null)}
                className="w-full px-4 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 編集ダイアログ */}
      {editingItem && (
        <div
          className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4"
          onClick={() => setEditingItem(null)}
        >
          <div
            ref={editDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editDialogIds.title}
            aria-describedby={editDialogIds.description}
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onEditDialogKeyDown}
          >
            <div className="p-4 border-b border-slate-200 dark:border-slate-700">
              <h2
                id={editDialogIds.title}
                className="text-lg font-bold text-slate-900 dark:text-white"
              >
                アイテム編集
              </h2>
              <p
                id={editDialogIds.description}
                className="text-sm text-slate-500 dark:text-slate-400 mt-0.5"
              >
                {editingItem.block}-{editingItem.number}
              </p>
            </div>
            {editingItem.purchaseStatus === "LimitedPurchase" ? (
              <>
                <div className="p-4 max-h-[60vh] overflow-y-auto">
                  <div className="rounded border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-800 dark:bg-orange-900/20 dark:text-orange-200">
                    <div className="font-semibold">
                      限数 {formatDisplayQuantity(editingItem)}
                    </div>
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <dt>価格</dt>
                      <dd>
                        {editingItem.price === null || editingItem.price === -1
                          ? "価格未定"
                          : `${editingItem.price.toLocaleString()}円`}
                      </dd>
                      <dt>購入予定量</dt>
                      <dd>{getPlannedQuantity(editingItem)}</dd>
                      <dt>実購入数</dt>
                      <dd>
                        {getActualPurchasedQuantity(editingItem) ?? "未入力"}
                      </dd>
                    </dl>
                    <div className="mt-3">
                      限数の実購入数と予定数量は実行モードまたは詳細編集で変更してください
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingItem(null);
                        onClose();
                        onEditRequest?.(editingItem);
                      }}
                      className="mt-3 rounded bg-orange-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-800"
                    >
                      限数を編集
                    </button>
                  </div>
                </div>
                <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2 justify-end">
                  <button
                    onClick={() => setEditingItem(null)}
                    className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
                  >
                    閉じる
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
                  <div>
                    <label
                      htmlFor={editDialogIds.circle}
                      className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      サークル名
                    </label>
                    <input
                      id={editDialogIds.circle}
                      type="text"
                      value={editingItem.circle}
                      onChange={(e) =>
                        setEditingItem({
                          ...editingItem,
                          circle: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={editDialogIds.itemTitle}
                      className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      タイトル
                    </label>
                    <input
                      id={editDialogIds.itemTitle}
                      type="text"
                      value={editingItem.title}
                      onChange={(e) =>
                        setEditingItem({
                          ...editingItem,
                          title: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                    />
                  </div>
                  {editingItem.catalogPrice !== undefined && (
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-600 dark:bg-slate-800">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        カタログ価格（シート・読み取り専用）
                      </p>
                      <p className="font-medium text-slate-800 dark:text-slate-100">
                        {editingItem.catalogPrice === null
                          ? "未定"
                          : `${editingItem.catalogPrice.toLocaleString()}円`}
                      </p>
                    </div>
                  )}
                  {/* 購入金額: ドロップダウン + 直接入力 */}
                  <fieldset>
                    <legend className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                      購入金額（利用者が編集）
                    </legend>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label
                          htmlFor={editDialogIds.pricePreset}
                          className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
                        >
                          クイック選択
                        </label>
                        <select
                          id={editDialogIds.pricePreset}
                          value={
                            editingItem.price === null
                              ? "undecided"
                              : editingItem.price !== null &&
                                  editingItem.price % 100 === 0 &&
                                  editingItem.price >= 0 &&
                                  editingItem.price <= 10000
                                ? String(editingItem.price)
                                : "custom"
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "undecided") {
                              setEditingItem({ ...editingItem, price: null });
                            } else if (v === "custom") {
                              // カスタム選択時は現在値を維持
                            } else {
                              setEditingItem({
                                ...editingItem,
                                price: parseInt(v, 10),
                              });
                            }
                          }}
                          className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                        >
                          <option value="undecided">価格未定</option>
                          {Array.from({ length: 101 }, (_, i) => i * 100).map(
                            (p) => (
                              <option key={p} value={p}>
                                {p.toLocaleString()}円
                              </option>
                            ),
                          )}
                          {editingItem.price !== null &&
                            (editingItem.price % 100 !== 0 ||
                              editingItem.price > 10000) && (
                              <option value="custom">
                                {editingItem.price.toLocaleString()}円（手入力）
                              </option>
                            )}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor={editDialogIds.price}
                          className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
                        >
                          直接入力
                        </label>
                        <div className="relative">
                          <input
                            id={editDialogIds.price}
                            type="text"
                            inputMode="numeric"
                            value={editingItem.price ?? ""}
                            onChange={(e) => {
                              const raw = e.target.value.replace(/[^0-9]/g, "");
                              setEditingItem({
                                ...editingItem,
                                price: raw === "" ? null : parseInt(raw, 10),
                              });
                            }}
                            placeholder="直接入力"
                            className="w-full px-3 py-2 pr-8 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
                            円
                          </span>
                        </div>
                      </div>
                    </div>
                    {editingItem.price === null && (
                      <p className="text-xs text-amber-500 mt-1">※ 価格未定</p>
                    )}
                  </fieldset>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label
                        htmlFor={editDialogIds.quantity}
                        className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        数量
                      </label>
                      <select
                        id={editDialogIds.quantity}
                        value={editingQuantityText}
                        onChange={(e) => {
                          setQuantityError(null);
                          setEditingQuantityText(e.target.value);
                        }}
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                      >
                        {buildQuantityOptions(
                          getPlannedQuantity(editingItem),
                        ).map((num) => (
                          <option key={num} value={num}>
                            {isStandardQuantityOption(num)
                              ? num
                              : `${num}（現在値）`}
                          </option>
                        ))}
                      </select>
                      {quantityError && (
                        <p className="mt-1 text-xs text-red-600">
                          {quantityError}
                        </p>
                      )}
                    </div>
                    <div>
                      <label
                        htmlFor={editDialogIds.purchaseStatus}
                        className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        購入状態
                      </label>
                      <select
                        id={editDialogIds.purchaseStatus}
                        value={editingItem.purchaseStatus}
                        onChange={(e) =>
                          setEditingItem({
                            ...editingItem,
                            purchaseStatus: e.target.value as PurchaseStatus,
                          })
                        }
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                      >
                        {PurchaseStatuses.filter(
                          (status) => status !== "LimitedPurchase",
                        ).map((status) => (
                          <option key={status} value={status}>
                            {statusLabels[status]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {onUpdateItemPriority && (
                    <div>
                      <label
                        htmlFor={editDialogIds.priority}
                        className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        優先度
                      </label>
                      <select
                        id={editDialogIds.priority}
                        value={editingItem.priorityLevel || "none"}
                        onChange={(e) =>
                          setEditingItem({
                            ...editingItem,
                            priorityLevel: e.target.value as
                              | "none"
                              | "priority"
                              | "highest",
                          })
                        }
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                      >
                        <option value="none">なし（通常）</option>
                        <option value="priority">優先</option>
                        <option value="highest">最優先</option>
                      </select>
                      {(editingItem.priorityLevel === "priority" ||
                        editingItem.priorityLevel === "highest") && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${editingItem.priorityLevel === "highest" ? "bg-red-500" : "bg-orange-500"}`}
                          />
                          <span
                            className={`text-xs ${editingItem.priorityLevel === "highest" ? "text-red-600 dark:text-red-400" : "text-orange-600 dark:text-orange-400"}`}
                          >
                            {editingItem.priorityLevel === "highest"
                              ? "最優先"
                              : "優先"}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {editingItem.sheetRemarks?.trim() && (
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-600 dark:bg-slate-800">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        シート備考（読み取り専用）
                      </p>
                      <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
                        {editingItem.sheetRemarks}
                      </p>
                    </div>
                  )}
                  <div>
                    <label
                      htmlFor={editDialogIds.remarks}
                      className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      利用者メモ
                    </label>
                    <textarea
                      id={editDialogIds.remarks}
                      value={editingItem.remarks}
                      onChange={(e) =>
                        setEditingItem({
                          ...editingItem,
                          remarks: e.target.value,
                        })
                      }
                      rows={2}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={editDialogIds.url}
                      className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      URL
                    </label>
                    <input
                      id={editDialogIds.url}
                      type="url"
                      value={editingItem.url || ""}
                      onChange={(e) =>
                        setEditingItem({
                          ...editingItem,
                          url: e.target.value || undefined,
                        })
                      }
                      placeholder="https://example.com"
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                    />
                    {editingItem.url && (
                      <a
                        href={editingItem.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 mt-1"
                      >
                        🔗 開く
                      </a>
                    )}
                  </div>
                </div>
                <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2 justify-end">
                  <button
                    onClick={() => setEditingItem(null)}
                    className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    保存
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 新規アイテム追加ダイアログ */}
      {addDialogOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={closeAddDialog}
        >
          <div
            ref={addDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={addDialogIds.title}
            aria-describedby={addDialogIds.description}
            className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onAddDialogKeyDown}
          >
            <div className="bg-gradient-to-r from-green-700 to-emerald-700 text-white p-4">
              <h2 id={addDialogIds.title} className="text-lg font-bold">
                新規アイテム追加
              </h2>
              <p
                id={addDialogIds.description}
                className="text-sm text-white mt-1"
              >
                {eventDate} {blockName}-{number}
              </p>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor={addDialogIds.circle} className={labelClass}>
                    サークル名{" "}
                    <span aria-hidden="true" className="text-red-500">
                      *
                    </span>
                  </label>
                  <input
                    id={addDialogIds.circle}
                    type="text"
                    required
                    value={newItemForm.circle}
                    onChange={(e) =>
                      setNewItemForm((prev) => ({
                        ...prev,
                        circle: e.target.value,
                      }))
                    }
                    className={formInputClass}
                    placeholder="サークル名"
                    list={addDialogIds.circleSuggestions}
                  />
                  {items.length > 0 && (
                    <datalist id={addDialogIds.circleSuggestions}>
                      {[
                        ...new Set(
                          items.map((item) => item.circle).filter(Boolean),
                        ),
                      ].map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  )}
                </div>
                <div>
                  <label
                    htmlFor={addDialogIds.itemTitle}
                    className={labelClass}
                  >
                    タイトル
                  </label>
                  <input
                    id={addDialogIds.itemTitle}
                    type="text"
                    value={newItemForm.title}
                    onChange={(e) =>
                      setNewItemForm((prev) => ({
                        ...prev,
                        title: e.target.value,
                      }))
                    }
                    className={formInputClass}
                    placeholder="新刊セット"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label
                    htmlFor={addDialogIds.eventDate}
                    className={labelClass}
                  >
                    参加日
                  </label>
                  <input
                    id={addDialogIds.eventDate}
                    type="text"
                    value={eventDate || ""}
                    readOnly
                    className={`${formInputClass} bg-slate-100 dark:bg-slate-700`}
                  />
                </div>
                <div>
                  <label htmlFor={addDialogIds.block} className={labelClass}>
                    ブロック
                  </label>
                  <input
                    id={addDialogIds.block}
                    type="text"
                    value={blockName}
                    readOnly
                    className={`${formInputClass} bg-slate-100 dark:bg-slate-700`}
                  />
                </div>
                <div>
                  <label htmlFor={addDialogIds.number} className={labelClass}>
                    ナンバー
                  </label>
                  <input
                    id={addDialogIds.number}
                    type="text"
                    value={newItemForm.numberOverride}
                    onChange={(e) =>
                      setNewItemForm((prev) => ({
                        ...prev,
                        numberOverride: e.target.value,
                      }))
                    }
                    className={formInputClass}
                    placeholder="01a"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                <div className="relative">
                  <label htmlFor={addDialogIds.price} className={labelClass}>
                    購入金額
                  </label>
                  <input
                    id={addDialogIds.price}
                    type="text"
                    value={newItemForm.price}
                    onChange={handlePriceInputChange}
                    className={`${formInputClass} pr-12`}
                    placeholder="0"
                    inputMode="numeric"
                  />
                  <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">
                    円
                  </span>
                </div>
                <div>
                  <label
                    htmlFor={addDialogIds.pricePreset}
                    className={labelClass}
                  >
                    クイック選択
                  </label>
                  <select
                    id={addDialogIds.pricePreset}
                    onChange={handlePriceSelectChange}
                    className={formInputClass}
                    value={
                      priceOptions.includes(Number(newItemForm.price))
                        ? newItemForm.price
                        : ""
                    }
                  >
                    <option value="" disabled>
                      金額を選択...
                    </option>
                    {priceOptions.map((p) => (
                      <option key={p} value={p}>
                        {p.toLocaleString()}円
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor={addDialogIds.quantity} className={labelClass}>
                    数量
                  </label>
                  <select
                    id={addDialogIds.quantity}
                    value={newItemForm.quantity}
                    onChange={(e) => {
                      setAddQuantityError(null);
                      setNewItemForm((prev) => ({
                        ...prev,
                        quantity: e.target.value,
                      }));
                    }}
                    className={formInputClass}
                  >
                    {buildQuantityOptions(newItemForm.quantity).map(
                      (quantity) => (
                        <option key={quantity} value={quantity}>
                          {quantity}
                        </option>
                      ),
                    )}
                  </select>
                  {addQuantityError && (
                    <p className="mt-1 text-xs text-red-600">
                      {addQuantityError}
                    </p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor={addDialogIds.purchaseStatus}
                    className={labelClass}
                  >
                    購入状態
                  </label>
                  <select
                    id={addDialogIds.purchaseStatus}
                    value={newItemForm.purchaseStatus}
                    onChange={(e) =>
                      setNewItemForm((prev) => ({
                        ...prev,
                        purchaseStatus: e.target
                          .value as typeof newItemForm.purchaseStatus,
                      }))
                    }
                    className={formInputClass}
                  >
                    <option value="None">未購入</option>
                    <option value="Purchased">購入済</option>
                    <option value="Postpone">後回し</option>
                    <option value="Late">遅参</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor={addDialogIds.remarks} className={labelClass}>
                    利用者メモ
                  </label>
                  <input
                    id={addDialogIds.remarks}
                    type="text"
                    value={newItemForm.remarks}
                    onChange={(e) =>
                      setNewItemForm((prev) => ({
                        ...prev,
                        remarks: e.target.value,
                      }))
                    }
                    className={formInputClass}
                    placeholder="スケブお願い"
                  />
                </div>
                <div>
                  <label htmlFor={addDialogIds.url} className={labelClass}>
                    URL
                  </label>
                  <input
                    id={addDialogIds.url}
                    type="text"
                    value={newItemForm.url}
                    onChange={(e) =>
                      setNewItemForm((prev) => ({
                        ...prev,
                        url: e.target.value,
                      }))
                    }
                    className={formInputClass}
                    placeholder="https://example.com"
                  />
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
              <button
                onClick={closeAddDialog}
                className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddItem}
                disabled={!newItemForm.circle.trim()}
                className="flex-1 py-2 px-4 bg-green-700 hover:bg-green-800 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
              >
                リストに追加
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
};

export default CellItemsPopup;
