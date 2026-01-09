import React from 'react';
import { ShoppingItem } from '../types';

interface UpdateConfirmationModalProps {
  itemsToDelete: ShoppingItem[];
  itemsToUpdate: ShoppingItem[];
  itemsToAdd: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[];
  onConfirm: () => void;
  onCancel: () => void;
}

const UpdateConfirmationModal: React.FC<UpdateConfirmationModalProps> = ({
  itemsToDelete,
  itemsToUpdate,
  itemsToAdd,
  onConfirm,
  onCancel,
}) => {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">アイテム更新の確認</h2>
          
          <div className="space-y-4 mb-6">
            {itemsToDelete.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2">
                  削除: {itemsToDelete.length}件
                </h3>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
                  {itemsToDelete.slice(0, 5).map(item => (
                    <li key={item.id}>• {item.circle} - {item.title}</li>
                  ))}
                  {itemsToDelete.length > 5 && <li>...他 {itemsToDelete.length - 5}件</li>}
                </ul>
              </div>
            )}
            
            {itemsToUpdate.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-blue-600 dark:text-blue-400 mb-2">
                  更新: {itemsToUpdate.length}件
                </h3>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
                  {itemsToUpdate.slice(0, 5).map(item => (
                    <li key={item.id}>• {item.circle} - {item.title}</li>
                  ))}
                  {itemsToUpdate.length > 5 && <li>...他 {itemsToUpdate.length - 5}件</li>}
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
                    <li key={index}>• {item.circle} - {item.title}</li>
                  ))}
                  {itemsToAdd.length > 5 && <li>...他 {itemsToAdd.length - 5}件</li>}
                </ul>
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
              onClick={onConfirm}
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

