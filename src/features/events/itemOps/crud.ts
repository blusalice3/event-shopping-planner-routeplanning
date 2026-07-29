import type {
  ExecuteModeItems,
  ItemSource,
  ProtectionLevel,
  PurchaseStatus,
  ShoppingItem,
  ViewMode,
} from '../../../types/item';
import { normalizeLimitedPurchaseFields } from '../../../utils/purchaseQuantity';

export interface UpdateItemResult {
  items: ShoppingItem[];
  purchaseStatusChanged: boolean;
  priceChanged: boolean;
  quantityChanged: boolean;
  limitedPurchasedQuantityChanged: boolean;
  purchaseQuantityChanged: boolean;
  importantItemChanged: boolean;
}

/**
 * 単一アイテムの更新。protectionLevel昇格ロジックを含む。
 */
export function computeUpdateItem(
  items: ShoppingItem[],
  updatedItem: ShoppingItem,
  mode: ViewMode | undefined,
  currentProtection: ProtectionLevel | undefined,
  itemSource: ItemSource | undefined,
): UpdateItemResult {
  const normalizedUpdatedItem = normalizeLimitedPurchaseFields(updatedItem);
  const currentItem = items.find((item) => item.id === normalizedUpdatedItem.id);
  const purchaseStatusChanged =
    currentItem != null && currentItem.purchaseStatus !== normalizedUpdatedItem.purchaseStatus;
  const priceChanged = currentItem != null && currentItem.price !== normalizedUpdatedItem.price;
  const quantityChanged =
    currentItem != null && currentItem.quantity !== normalizedUpdatedItem.quantity;
  const limitedPurchasedQuantityChanged =
    currentItem != null &&
    currentItem.limitedPurchasedQuantity !== normalizedUpdatedItem.limitedPurchasedQuantity;
  const purchaseQuantityChanged = quantityChanged || limitedPurchasedQuantityChanged;
  const importantItemChanged = purchaseStatusChanged || priceChanged || purchaseQuantityChanged;

  let finalItem = normalizedUpdatedItem;

  if ((mode === 'execute' || mode === 'focus') && importantItemChanged) {
    const effectiveProtection = currentProtection ?? (itemSource === 'app' ? 'full' : 'none');
    if (effectiveProtection === 'none') {
      finalItem = { ...normalizedUpdatedItem, protectionLevel: 'deletable' as const };
    }
  }

  return {
    items: items.map((item) => (item.id === normalizedUpdatedItem.id ? finalItem : item)),
    purchaseStatusChanged,
    priceChanged,
    quantityChanged,
    limitedPurchasedQuantityChanged,
    purchaseQuantityChanged,
    importantItemChanged,
  };
}

// ────────────────────────────────────────────────
// 2. computeDeleteItem
// ────────────────────────────────────────────────

export interface DeleteItemResult {
  items: ShoppingItem[];
  executeModeItems: ExecuteModeItems;
}

/**
 * アイテム削除。eventListsとexecuteModeItems両方から除去する。
 */
export function computeDeleteItem(
  items: ShoppingItem[],
  deletedId: string,
  executeModeItems: ExecuteModeItems,
): DeleteItemResult {
  const newItems = items.filter((item) => item.id !== deletedId);

  const newExecuteItems: ExecuteModeItems = {};
  Object.keys(executeModeItems).forEach((eventDate) => {
    newExecuteItems[eventDate] = executeModeItems[eventDate].filter((id) => id !== deletedId);
  });

  return { items: newItems, executeModeItems: newExecuteItems };
}

// ────────────────────────────────────────────────
// 3. computeAddItemFromFocusMode
// ────────────────────────────────────────────────

export interface AddItemFromFocusModeResult {
  items: ShoppingItem[];
  executeModeItems: ExecuteModeItems;
  newItemId: string;
}

/**
 * フォーカスモードからの新規アイテム追加。
 */
export function computeAddItemFromFocusMode(
  items: ShoppingItem[],
  newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus },
  executeModeItems: ExecuteModeItems,
): AddItemFromFocusModeResult {
  const purchaseStatus = newItem.purchaseStatus || 'None';

  const item: ShoppingItem = {
    ...newItem,
    id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    purchaseStatus,
    source: 'app' as const,
    protectionLevel: 'full' as const,
  };

  const newItems = [...items, item];
  let newExecuteItems = executeModeItems;

  if (purchaseStatus === 'Postpone' || purchaseStatus === 'Late') {
    const dayName = newItem.eventDate;
    if (dayName) {
      const dayItems = executeModeItems[dayName] || [];
      newExecuteItems = {
        ...executeModeItems,
        [dayName]: [...dayItems, item.id],
      };
    }
  }

  return { items: newItems, executeModeItems: newExecuteItems, newItemId: item.id };
}

// ────────────────────────────────────────────────
// 4. computeAddToExecuteListFromMap
// ────────────────────────────────────────────────

/**
 * マップからexecuteリストにアイテムを追加（ホール順序を考慮した挿入位置決定）。
 */
