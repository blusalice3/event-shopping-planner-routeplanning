
import React from 'react';
import { ShoppingItem } from '../types';

interface DeleteConfirmationModalProps {
  item: ShoppingItem;
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({ item, onConfirm, onCancel }) => {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 id="delete-modal-title" className="text-lg font-bold text-slate-900 dark:text-white">アイテムを削除</h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          以下のアイテムをリストから完全に削除します。この操作は元に戻せません。よろしいですか？
        </p>
        <div className="mt-4 p-4 bg-slate-100 dark:bg-slate-700/50 rounded-md space-y-2 text-sm text-slate-800 dark:text-slate-200">
          <div><span className="font-semibold text-slate-500 dark:text-slate-400">サークル:</span> {item.circle}</div>
          <div><span className="font-semibold text-slate-500 dark:text-slate-400">タイトル:</span> {item.title || '(タイトルなし)'}</div>
          <div><span className="font-semibold text-slate-500 dark:text-slate-400">価格:</span> {item.price === null ? <span className="text-red-600 dark:text-red-400">価格未定</span> : item.price === 0 ? '¥0' : `¥${item.price.toLocaleString()}`}</div>
        </div>
        <div className="mt-6 flex justify-end space-x-4">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium rounded-md text-slate-700 dark:text-slate-200 bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500 dark:focus:ring-offset-slate-800">
            No
          </button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-slate-800">
            Yes
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmationModal;
