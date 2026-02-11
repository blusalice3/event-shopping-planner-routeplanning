import React, { useState, useRef } from 'react';
import TrashIcon from './icons/TrashIcon';

const DocumentArrowDownIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    {...props}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
    />
  </svg>
);

const DocumentArrowUpIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    {...props}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
    />
  </svg>
);

interface EventListScreenProps {
  eventNames: string[];
  onSelect: (name: string) => void;
  onDelete: (name: string) => void;
  onExport: (name: string) => void;
  onUpdate?: (name: string) => void;
  onRename?: (oldName: string) => void;
  onImportMap?: (name: string) => void;
  onImportExportFile?: () => void;
}

const EventListScreen: React.FC<EventListScreenProps> = ({
  eventNames,
  onSelect,
  onDelete,
  onExport,
  onUpdate,
  onRename,
  onImportMap,
  onImportExportFile,
}) => {
  const longPressTimeout = useRef<number | null>(null);
  const longPressTriggeredRef = useRef<boolean>(false);
  const [menuVisibleFor, setMenuVisibleFor] = useState<string | null>(null);

  const handlePointerDown = (eventName: string) => {
    longPressTriggeredRef.current = false;
    // Clear any existing menu
    if (menuVisibleFor !== eventName) {
      setMenuVisibleFor(null);
    }
    longPressTimeout.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      setMenuVisibleFor(eventName);
    }, 500); // 500ms for long press
  };

  const handlePointerUp = () => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };

  const handlePointerLeave = () => {
    // マウスが要素外に出た場合もタイマーをクリア
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };

  const handleClick = (eventName: string) => {
    // 長押しでメニューが表示された直後のclickイベントを無視
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    if (menuVisibleFor === eventName) {
      setMenuVisibleFor(null);
    } else if (menuVisibleFor === null) {
      onSelect(eventName);
    }
  };

  const handleDelete = (eventName: string) => {
    if (window.confirm(`「${eventName}」を削除しますか？この操作は元に戻せません。`)) {
      onDelete(eventName);
      setMenuVisibleFor(null);
    }
  };

  const handleDocumentClick = React.useCallback(
    (e: MouseEvent) => {
      if (menuVisibleFor && !(e.target as Element).closest('[data-menu-owner]')) {
        setMenuVisibleFor(null);
      }
    },
    [menuVisibleFor],
  );

  React.useEffect(() => {
    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [handleDocumentClick]);

  if (eventNames.length === 0) {
    return (
      <div className="text-center py-12 animate-fade-in">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-200 mb-2">
          保存されたリストはありません
        </h2>
        <p className="text-slate-500 dark:text-slate-400 mb-6">
          「新規リスト作成」から新しいイベントの巡回表を作成してください。
        </p>
        {onImportExportFile && (
          <button
            onClick={onImportExportFile}
            className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            <DocumentArrowUpIcon className="w-5 h-5" />
            エクスポートファイルをインポート
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          保存済みの即売会リスト
        </h2>
        {onImportExportFile && (
          <button
            onClick={onImportExportFile}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            <DocumentArrowUpIcon className="w-4 h-4" />
            インポート
          </button>
        )}
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow overflow-hidden">
        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {eventNames.map((name) => (
            <li key={name} className="relative" data-menu-owner>
              <div
                className="p-4 flex justify-between items-center cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors duration-200"
                onMouseDown={() => handlePointerDown(name)}
                onMouseUp={handlePointerUp}
                onMouseLeave={handlePointerLeave}
                onTouchStart={() => handlePointerDown(name)}
                onTouchEnd={handlePointerUp}
                onClick={() => handleClick(name)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <span className="font-medium text-slate-800 dark:text-slate-200">{name}</span>
                {menuVisibleFor !== name && (
                  <span className="text-xs text-slate-400">クリックで開く / 長押しでメニュー</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* リスト操作メニュー（オーバーレイ） */}
      {menuVisibleFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => {
            setMenuVisibleFor(null);
          }}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 min-w-[280px] max-w-[90vw] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-white truncate">
                {menuVisibleFor}
              </h3>
            </div>
            <div className="py-2">
              {onUpdate && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdate(menuVisibleFor);
                    setMenuVisibleFor(null);
                  }}
                  className="flex items-center space-x-3 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                  <span className="text-lg">🔄</span>
                  <span>アイテム更新</span>
                </button>
              )}
              {onRename && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(menuVisibleFor);
                    setMenuVisibleFor(null);
                  }}
                  className="flex items-center space-x-3 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                  <span className="text-lg">✏️</span>
                  <span>名称変更</span>
                </button>
              )}
              {onImportMap && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onImportMap(menuVisibleFor);
                    setMenuVisibleFor(null);
                  }}
                  className="flex items-center space-x-3 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                  <span className="text-lg">🗺️</span>
                  <span>マップデータ取り込み</span>
                </button>
              )}
              <div className="border-t border-slate-200 dark:border-slate-700 my-2" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(menuVisibleFor);
                  setMenuVisibleFor(null);
                }}
                className="flex items-center space-x-3 w-full px-4 py-3 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                <DocumentArrowDownIcon className="w-5 h-5 text-blue-500" />
                <span>Excel形式で出力</span>
              </button>
              <div className="border-t border-slate-200 dark:border-slate-700 my-2" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(menuVisibleFor);
                }}
                className="flex items-center space-x-3 w-full px-4 py-3 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
              >
                <TrashIcon className="w-5 h-5" />
                <span>削除</span>
              </button>
            </div>
            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
              <button
                onClick={() => {
                  setMenuVisibleFor(null);
                }}
                className="w-full py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EventListScreen;
