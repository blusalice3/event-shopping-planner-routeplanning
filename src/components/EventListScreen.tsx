import React, { useState, useRef } from 'react';
import TrashIcon from './icons/TrashIcon';

const DocumentArrowDownIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    fill="none" 
    viewBox="0 0 24 24" 
    strokeWidth={1.5} 
    stroke="currentColor" 
    {...props}>
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
    {...props}>
    <path 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" 
    />
  </svg>
);

// QRコードアイコン
const QrCodeIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    {...props}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z"
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
  onQRSend?: (name: string) => void;
  onQRReceive?: (name: string) => void;
}

const EventListScreen: React.FC<EventListScreenProps> = ({ eventNames, onSelect, onDelete, onExport, onUpdate, onRename, onImportMap, onImportExportFile, onQRSend, onQRReceive }) => {
  const longPressTimeout = useRef<number | null>(null);
  const [menuVisibleFor, setMenuVisibleFor] = useState<string | null>(null);
  const [syncMenuVisibleFor, setSyncMenuVisibleFor] = useState<string | null>(null);

  const handlePointerDown = (eventName: string) => {
    // Clear any existing menu
    if (menuVisibleFor !== eventName) {
        setMenuVisibleFor(null);
    }
    longPressTimeout.current = window.setTimeout(() => {
      setMenuVisibleFor(eventName);
    }, 500); // 500ms for long press
  };

  const handlePointerUp = () => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };

  const handleClick = (eventName: string) => {
    if (menuVisibleFor === eventName) {
        setMenuVisibleFor(null);
        setSyncMenuVisibleFor(null);
    } else if (menuVisibleFor === null) {
        onSelect(eventName);
    }
  };
  
  const handleDelete = (eventName: string) => {
    if(window.confirm(`「${eventName}」を削除しますか？この操作は元に戻せません。`)){
        onDelete(eventName);
        setMenuVisibleFor(null);
        setSyncMenuVisibleFor(null);
    }
  }
  
  const handleDocumentClick = (e: MouseEvent) => {
    if (menuVisibleFor && !(e.target as Element).closest('[data-menu-owner]')) {
      setMenuVisibleFor(null);
      setSyncMenuVisibleFor(null);
    }
  };

  React.useEffect(() => {
    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [menuVisibleFor]);


  if (eventNames.length === 0) {
    return (
      <div className="text-center py-12 animate-fade-in">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-200 mb-2">保存されたリストはありません</h2>
        <p className="text-slate-500 dark:text-slate-400 mb-6">「新規リスト作成」から新しいイベントの巡回表を作成してください。</p>
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
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">保存済みの即売会リスト</h2>
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
          {eventNames.map(name => (
            <li key={name} className="relative" data-menu-owner>
              <div 
                className="p-4 flex justify-between items-center cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors duration-200"
                onMouseDown={() => handlePointerDown(name)}
                onMouseUp={handlePointerUp}
                onTouchStart={() => handlePointerDown(name)}
                onTouchEnd={handlePointerUp}
                onClick={() => handleClick(name)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <span className="font-medium text-slate-800 dark:text-slate-200">{name}</span>
                {menuVisibleFor !== name && <span className="text-xs text-slate-400">クリックで開く / 長押しでメニュー</span>}
              </div>
               {menuVisibleFor === name && (
                 <div className="absolute right-4 top-1/2 -translate-y-1/2 flex bg-white dark:bg-slate-900 rounded-md shadow-lg z-10 border border-slate-200 dark:border-slate-700 divide-x divide-slate-200 dark:divide-slate-700">
                    {onUpdate && (
                      <button 
                          onClick={(e) => { e.stopPropagation(); onUpdate(name); setMenuVisibleFor(null); }}
                          className="flex items-center space-x-2 px-4 py-2 text-sm text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/50 rounded-l-md transition-colors"
                      >
                          <span>🔄 アイテム更新</span>
                      </button>
                    )}
                    {onRename && (
                      <button 
                          onClick={(e) => { e.stopPropagation(); onRename(name); setMenuVisibleFor(null); }}
                          className={`flex items-center space-x-2 px-4 py-2 text-sm text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/50 transition-colors ${onUpdate ? '' : 'rounded-l-md'}`}
                      >
                          <span>✏️ 名称変更</span>
                      </button>
                    )}
                    {onImportMap && (
                      <button 
                          onClick={(e) => { e.stopPropagation(); onImportMap(name); setMenuVisibleFor(null); }}
                          className="flex items-center space-x-2 px-4 py-2 text-sm text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/50 transition-colors"
                      >
                          <span>🗺️ マップデータ取り込み</span>
                      </button>
                    )}
                    {/* データ同期メニュー */}
                    <div className="relative">
                      <button 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            setSyncMenuVisibleFor(syncMenuVisibleFor === name ? null : name); 
                          }}
                          className="flex items-center space-x-2 px-4 py-2 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/50 transition-colors"
                      >
                          <QrCodeIcon className="w-4 h-4" />
                          <span>データ同期</span>
                          <svg className={`w-3 h-3 transition-transform ${syncMenuVisibleFor === name ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                      </button>
                      {/* サブメニュー */}
                      {syncMenuVisibleFor === name && (
                        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-slate-900 rounded-md shadow-lg border border-slate-200 dark:border-slate-700 min-w-[180px] z-20">
                          <button
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              onQRSend?.(name); 
                              setMenuVisibleFor(null); 
                              setSyncMenuVisibleFor(null); 
                            }}
                            className="flex items-center space-x-2 w-full px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-t-md transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                            </svg>
                            <span>QRコードで送信</span>
                          </button>
                          <button
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              onQRReceive?.(name); 
                              setMenuVisibleFor(null); 
                              setSyncMenuVisibleFor(null); 
                            }}
                            className="flex items-center space-x-2 w-full px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            <span>QRコードで受信</span>
                          </button>
                          <div className="border-t border-slate-200 dark:border-slate-700" />
                          <button 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                onExport(name); 
                                setMenuVisibleFor(null); 
                                setSyncMenuVisibleFor(null); 
                              }}
                              className="flex items-center space-x-2 w-full px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-b-md transition-colors"
                          >
                              <DocumentArrowDownIcon className="w-4 h-4" />
                              <span>Excel形式で出力</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <button 
                        onClick={(e) => { e.stopPropagation(); handleDelete(name); }}
                        className="flex items-center space-x-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/50 rounded-r-md transition-colors"
                    >
                        <TrashIcon className="w-4 h-4" />
                        <span>削除</span>
                    </button>
                 </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default EventListScreen;

