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

interface EventListScreenProps {
  eventNames: string[];
  onSelect: (name: string) => void;
  onDelete: (name: string) => void;
  onExport: (name: string) => void;
  onUpdate?: (name: string) => void;
  onRename?: (oldName: string) => void;
}

const EventListScreen: React.FC<EventListScreenProps> = ({ eventNames, onSelect, onDelete, onExport, onUpdate, onRename }) => {
  const longPressTimeout = useRef<number | null>(null);
  const [menuVisibleFor, setMenuVisibleFor] = useState<string | null>(null);

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
    } else if (menuVisibleFor === null) {
        onSelect(eventName);
    }
  };
  
  const handleDelete = (eventName: string) => {
    if(window.confirm(`「${eventName}」を削除しますか？この操作は元に戻せません。`)){
        onDelete(eventName);
        setMenuVisibleFor(null);
    }
  }
  
  const handleDocumentClick = (e: MouseEvent) => {
    if (menuVisibleFor && !(e.target as Element).closest('[data-menu-owner]')) {
      setMenuVisibleFor(null);
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
        <p className="text-slate-500 dark:text-slate-400">「新規リスト作成」から新しいイベントの巡回表を作成してください。</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">保存済みの即売会リスト</h2>
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
                 <div className="absolute right-4 top-1/2 -translate-y-1/2 flex bg-white dark:bg-slate-900 rounded-md shadow-lg z-10 border border-slate-200 dark:border-slate-700 divide-x divide-slate-200 dark:border-slate-700">
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
                    <button 
                        onClick={(e) => { e.stopPropagation(); onExport(name); setMenuVisibleFor(null); }}
                        className="flex items-center space-x-2 px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/50 transition-colors"
                    >
                        <DocumentArrowDownIcon className="w-4 h-4" />
                        <span>Excel形式で出力</span>
                    </button>
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

