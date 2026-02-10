import React from 'react';

interface VisitListConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

const VisitListConfirmDialog: React.FC<VisitListConfirmDialogProps> = ({ onConfirm, onCancel }) => (
  <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
      <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-3">変更を保存しますか？</h3>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">訪問先リストに未保存の変更があります。確定して保存するか、キャンセルして破棄してください。</p>
      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600">キャンセル（破棄）</button>
        <button onClick={onConfirm} className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700">確定（保存）</button>
      </div>
    </div>
  </div>
);

export default VisitListConfirmDialog;
