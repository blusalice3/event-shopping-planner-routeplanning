import React, { useState } from 'react';
import { ExportOptions } from '../types';

interface ExportOptionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExport: (options: ExportOptions) => void;
  hasMapData: boolean;
}

const ExportOptionsDialog: React.FC<ExportOptionsDialogProps> = ({
  isOpen,
  onClose,
  onExport,
  hasMapData,
}) => {
  const [options, setOptions] = useState<ExportOptions>({
    includeItems: true,
    includeLayoutInfo: true,
    includeMapData: hasMapData,
    includeBlockDefinitions: hasMapData,
    includeRouteInfo: hasMapData,
    format: 'full',
  });
  
  const handleFormatChange = (format: 'full' | 'simple') => {
    if (format === 'simple') {
      setOptions({
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: false,
        includeBlockDefinitions: false,
        includeRouteInfo: false,
        format: 'simple',
      });
    } else {
      setOptions({
        includeItems: true,
        includeLayoutInfo: true,
        includeMapData: hasMapData,
        includeBlockDefinitions: hasMapData,
        includeRouteInfo: hasMapData,
        format: 'full',
      });
    }
  };
  
  const handleExport = () => {
    onExport(options);
    onClose();
  };
  
  if (!isOpen) return null;
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            エクスポート設定
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        {/* コンテンツ */}
        <div className="px-6 py-4 space-y-6">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            エクスポート内容を選択してください：
          </p>
          
          {/* チェックボックス */}
          <div className="space-y-3">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={options.includeItems}
                disabled
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700 dark:text-slate-300">
                アイテムデータ（必須）
              </span>
            </label>
            
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={options.includeLayoutInfo}
                onChange={(e) =>
                  setOptions({ ...options, includeLayoutInfo: e.target.checked })
                }
                disabled={options.format === 'simple'}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className={`text-sm ${options.format === 'simple' ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                配置情報（実行列・候補リストの順序）
              </span>
            </label>
            
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={options.includeMapData}
                onChange={(e) =>
                  setOptions({ ...options, includeMapData: e.target.checked })
                }
                disabled={!hasMapData || options.format === 'simple'}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className={`text-sm ${!hasMapData || options.format === 'simple' ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                マップデータ {!hasMapData && '（データなし）'}
              </span>
            </label>
            
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={options.includeBlockDefinitions}
                onChange={(e) =>
                  setOptions({ ...options, includeBlockDefinitions: e.target.checked })
                }
                disabled={!hasMapData || options.format === 'simple'}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className={`text-sm ${!hasMapData || options.format === 'simple' ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                ブロック定義 {!hasMapData && '（データなし）'}
              </span>
            </label>
            
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={options.includeRouteInfo}
                onChange={(e) =>
                  setOptions({ ...options, includeRouteInfo: e.target.checked })
                }
                disabled={!hasMapData || options.format === 'simple'}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className={`text-sm ${!hasMapData || options.format === 'simple' ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                ルート情報 {!hasMapData && '（データなし）'}
              </span>
            </label>
          </div>
          
          {/* 区切り線 */}
          <hr className="border-slate-200 dark:border-slate-700" />
          
          {/* ファイル形式 */}
          <div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
              📁 ファイル形式
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="format"
                  checked={options.format === 'full'}
                  onChange={() => handleFormatChange('full')}
                  className="w-4 h-4 border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="text-sm text-slate-700 dark:text-slate-300">
                    完全版（.xlsx）
                  </span>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    全データ含む
                  </p>
                </div>
              </label>
              
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="format"
                  checked={options.format === 'simple'}
                  onChange={() => handleFormatChange('simple')}
                  className="w-4 h-4 border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="text-sm text-slate-700 dark:text-slate-300">
                    簡易版（.xlsx）
                  </span>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    アイテムのみ（v1互換）
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>
        
        {/* フッター */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 rounded-b-lg">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleExport}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
          >
            エクスポート
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportOptionsDialog;
