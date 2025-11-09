import React, { useState } from 'react';

interface UrlUpdateDialogProps {
  currentUrl: string;
  onConfirm: (url: string, sheetName: string) => void;
  onCancel: () => void;
}

const UrlUpdateDialog: React.FC<UrlUpdateDialogProps> = ({
  currentUrl,
  onConfirm,
  onCancel,
}) => {
  const [url, setUrl] = useState(currentUrl);
  const [sheetName, setSheetName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      onConfirm(url.trim(), sheetName.trim());
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">スプレッドシートURLを更新</h2>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="url" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                スプレッドシートURL
              </label>
              <input
                type="text"
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="https://docs.google.com/spreadsheets/d/..."
                required
              />
            </div>
            
            <div>
              <label htmlFor="sheetName" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                シート名（オプション）
              </label>
              <input
                type="text"
                id="sheetName"
                value={sheetName}
                onChange={(e) => setSheetName(e.target.value)}
                className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="シート1"
              />
            </div>
            
            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-sm font-medium rounded-md text-slate-700 bg-slate-200 hover:bg-slate-300 dark:text-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
              >
                キャンセル
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
              >
                更新
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default UrlUpdateDialog;

