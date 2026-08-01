import React, { useEffect, useState } from "react";
import type { EventUpdateApplyOptions } from "../features/events/updateApply";
import type {
  LimitedPurchaseQuantityConflict,
  PendingPurchasedQuantityChange,
  QuantitySyncWarning,
  SpreadsheetItemToAdd,
} from "../features/events/updateDiff";
import type { ShoppingItem } from "../types/item";

interface UpdateConfirmationModalProps {
  itemsToDelete: ShoppingItem[];
  itemsToUpdate: ShoppingItem[];
  itemsToAdd: SpreadsheetItemToAdd[];
  protectedFromDelete?: number; // 保護により削除されなかったアイテム数
  protectedFromUpdate?: number; // 保護により更新されなかったアイテム数
  quantityWarnings?: QuantitySyncWarning[];
  pendingPurchasedQuantityChanges?: PendingPurchasedQuantityChange[];
  limitedPurchaseQuantityConflicts?: LimitedPurchaseQuantityConflict[];
  onConfirm: (options: EventUpdateApplyOptions) => void;
  onCancel: () => void;
}

const UpdateConfirmationModal: React.FC<UpdateConfirmationModalProps> = ({
  itemsToDelete,
  itemsToUpdate,
  itemsToAdd,
  protectedFromDelete = 0,
  protectedFromUpdate = 0,
  quantityWarnings = [],
  pendingPurchasedQuantityChanges = [],
  limitedPurchaseQuantityConflicts = [],
  onConfirm,
  onCancel,
}) => {
  const [applyPurchasedQuantityChanges, setApplyPurchasedQuantityChanges] =
    useState(false);
  const hasProtectedItems = protectedFromDelete > 0 || protectedFromUpdate > 0;

  useEffect(() => {
    setApplyPurchasedQuantityChanges(false);
  }, [pendingPurchasedQuantityChanges.length]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
            アイテム更新の確認
          </h2>

          <div className="space-y-4 mb-6">
            {itemsToDelete.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2">
                  削除: {itemsToDelete.length}件
                </h3>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
                  {itemsToDelete.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      • {item.circle} - {item.title}
                    </li>
                  ))}
                  {itemsToDelete.length > 5 && (
                    <li>...他 {itemsToDelete.length - 5}件</li>
                  )}
                </ul>
              </div>
            )}

            {itemsToUpdate.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-blue-600 dark:text-blue-400 mb-2">
                  更新: {itemsToUpdate.length}件
                </h3>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
                  {itemsToUpdate.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      • {item.circle} - {item.title}
                    </li>
                  ))}
                  {itemsToUpdate.length > 5 && (
                    <li>...他 {itemsToUpdate.length - 5}件</li>
                  )}
                </ul>
              </div>
            )}

            {itemsToAdd.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-green-600 dark:text-green-400 mb-2">
                  追加: {itemsToAdd.length}件
                </h3>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
                  {itemsToAdd.slice(0, 5).map((item, index) => (
                    <li key={index}>
                      • {item.circle} - {item.title}
                    </li>
                  ))}
                  {itemsToAdd.length > 5 && (
                    <li>...他 {itemsToAdd.length - 5}件</li>
                  )}
                </ul>
              </div>
            )}

            {hasProtectedItems && (
              <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-md border border-amber-200 dark:border-amber-700">
                <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-1">
                  <span>🔐</span> 保護されたアイテム
                </h3>
                <p className="text-sm text-amber-600 dark:text-amber-300">
                  {protectedFromDelete > 0 && (
                    <span>削除から保護: {protectedFromDelete}件</span>
                  )}
                  {protectedFromDelete > 0 && protectedFromUpdate > 0 && (
                    <span>、</span>
                  )}
                  {protectedFromUpdate > 0 && (
                    <span>更新から保護: {protectedFromUpdate}件</span>
                  )}
                </p>
              </div>
            )}

            {quantityWarnings.length > 0 && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-md border border-red-200 dark:border-red-700">
                <h3 className="text-sm font-semibold text-red-700 dark:text-red-300 mb-1">
                  数量を反映できなかった行: {quantityWarnings.length}件
                </h3>
                <p className="text-sm text-red-600 dark:text-red-300 mb-2">
                  数量は1～20の整数で入力してください。既存品目の数量は変更せず、
                  新規品目は追加していません。
                </p>
                <ul className="text-sm text-red-600 dark:text-red-300 space-y-1">
                  {quantityWarnings.slice(0, 5).map((warning, index) => (
                    <li
                      key={`${warning.eventDate}-${warning.block}-${warning.number}-${index}`}
                    >
                      • {warning.circle} - {warning.title || "（タイトルなし）"}
                      ：「{warning.receivedValue}」
                      {warning.kind === "new-item-skipped"
                        ? "（品目を追加しません）"
                        : "（現在の数量を維持します）"}
                    </li>
                  ))}
                  {quantityWarnings.length > 5 && (
                    <li>...他 {quantityWarnings.length - 5}件</li>
                  )}
                </ul>
              </div>
            )}

            {limitedPurchaseQuantityConflicts.length > 0 && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-md border border-red-200 dark:border-red-700">
                <h3 className="text-sm font-semibold text-red-700 dark:text-red-300 mb-1">
                  限数購入の予定数量を反映できない品目:{" "}
                  {limitedPurchaseQuantityConflicts.length}件
                </h3>
                <p className="text-sm text-red-600 dark:text-red-300 mb-2">
                  予定数量は実購入数より多い必要があります。購入状態と実購入数を保護し、
                  現在の予定数量を維持します。
                </p>
                <ul className="text-sm text-red-600 dark:text-red-300 space-y-1">
                  {limitedPurchaseQuantityConflicts
                    .slice(0, 5)
                    .map((conflict) => (
                      <li key={conflict.itemId}>
                        • {conflict.circle} -{" "}
                        {conflict.title || "（タイトルなし）"}：実購入
                        {conflict.actualPurchasedQuantity}、予定
                        {conflict.currentQuantity} → {conflict.nextQuantity}
                      </li>
                    ))}
                  {limitedPurchaseQuantityConflicts.length > 5 && (
                    <li>
                      ...他 {limitedPurchaseQuantityConflicts.length - 5}件
                    </li>
                  )}
                </ul>
              </div>
            )}

            {pendingPurchasedQuantityChanges.length > 0 && (
              <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-md border border-amber-300 dark:border-amber-700">
                <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">
                  購入済み品目の予定数量変更:{" "}
                  {pendingPurchasedQuantityChanges.length}件
                </h3>
                <p className="text-sm text-amber-700 dark:text-amber-300 mb-2">
                  誤って購入記録を変えないよう、予定数量は確認するまで変更しません。
                  実際に購入した数量は、この確認にかかわらず維持されます。
                </p>
                <ul className="text-sm text-amber-700 dark:text-amber-300 space-y-1 mb-3">
                  {pendingPurchasedQuantityChanges.slice(0, 5).map((change) => (
                    <li key={change.itemId}>
                      • {change.circle} - {change.title || "（タイトルなし）"}：
                      {change.currentQuantity} → {change.nextQuantity}
                    </li>
                  ))}
                  {pendingPurchasedQuantityChanges.length > 5 && (
                    <li>
                      ...他 {pendingPurchasedQuantityChanges.length - 5}件
                    </li>
                  )}
                </ul>
                <label className="flex items-start gap-2 text-sm font-medium text-amber-900 dark:text-amber-200 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={applyPurchasedQuantityChanges}
                    onChange={(event) =>
                      setApplyPurchasedQuantityChanges(event.target.checked)
                    }
                  />
                  内容を確認し、スプレッドシートの予定数量へ変更する
                </label>
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-3">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium rounded-md text-slate-700 bg-slate-200 hover:bg-slate-300 dark:text-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={() =>
                onConfirm({
                  applyPurchasedQuantityChanges,
                })
              }
              className="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
            >
              更新を実行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UpdateConfirmationModal;
