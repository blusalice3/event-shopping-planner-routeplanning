import React, { useRef, useEffect } from 'react';

type ActiveTab = 'eventList' | 'import' | string;

interface TabButtonProps {
  tab: ActiveTab;
  label: string;
  count?: number;
  onClick?: () => void;
  isMapTab?: boolean;
  activeTab: ActiveTab;
  activeEventName: string | null;
  eventDates: string[];
  mapTabMenuOpen: string | null;
  setMapTabMenuOpen: React.Dispatch<React.SetStateAction<string | null>>;
  setMapTabMenuPosition: React.Dispatch<React.SetStateAction<{ left: number; top: number }>>;
  onToggleMode: () => void;
  onTabChange: (tab: ActiveTab) => void;
  onOpenVisitListPanel: (tab: string) => void;
  onSetBlockDefinitionMode: (v: boolean) => void;
  onSetHallDefinitionMode: (v: boolean) => void;
}

const TabButton: React.FC<TabButtonProps> = ({
  tab, label, count, onClick, isMapTab: isMapTabProp,
  activeTab, activeEventName, eventDates,
  mapTabMenuOpen, setMapTabMenuOpen, setMapTabMenuPosition,
  onToggleMode, onTabChange, onOpenVisitListPanel,
  onSetBlockDefinitionMode, onSetHallDefinitionMode,
}) => {
  const longPressTimeout = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!activeEventName) return;
    
    const target = e.currentTarget as HTMLButtonElement;
    const rect = target.getBoundingClientRect();
    const menuLeft = rect.left + rect.width / 2;
    const menuTop = rect.bottom + 4;
    
    longPressTimeout.current = window.setTimeout(() => {
      if (isMapTabProp) {
        setMapTabMenuPosition({ left: menuLeft, top: menuTop });
        setMapTabMenuOpen(tab);
      } else if (eventDates.includes(tab)) {
        onToggleMode();
      }
      longPressTimeout.current = null;
    }, 500);
  };

  const handlePointerUp = () => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };

  const handleClick = () => {
    if (mapTabMenuOpen) {
      if (mapTabMenuOpen === tab) {
        setMapTabMenuOpen(null);
        return;
      }
      setMapTabMenuOpen(null);
    }
    if (onClick) {
      onClick();
    } else {
      onTabChange(tab);
    }
  };

  // メニュー外クリックで閉じる
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setMapTabMenuOpen(null);
      }
    };
    if (mapTabMenuOpen === tab) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [tab, mapTabMenuOpen]);

  const handleMenuItemClick = (action: 'visitList' | 'blockDefinition' | 'hallDefinition') => {
    setMapTabMenuOpen(null);
    onTabChange(tab);
    
    setTimeout(() => {
      switch (action) {
        case 'visitList':
          onOpenVisitListPanel(tab);
          break;
        case 'blockDefinition':
          onSetBlockDefinitionMode(true);
          break;
        case 'hallDefinition':
          onSetHallDefinitionMode(true);
          break;
      }
    }, 0);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
          activeTab === tab
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
        }`}
      >
        {label} {typeof count !== 'undefined' && <span className="text-xs bg-slate-200 dark:text-slate-700 rounded-full px-2 py-0.5 ml-1">{count}</span>}
      </button>
      
      {/* マップタブ長押しメニュー */}
      {mapTabMenuOpen === tab && isMapTabProp && (
        <div 
          ref={menuRef}
          className="fixed bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 min-w-[180px]"
          style={{
            left: `${(buttonRef.current?.getBoundingClientRect().left ?? 0) + (buttonRef.current?.getBoundingClientRect().width ?? 0) / 2}px`,
            top: `${(buttonRef.current?.getBoundingClientRect().bottom ?? 0) + 4}px`,
            transform: 'translateX(-50%)',
            zIndex: 9999,
          }}
        >
          <div className="absolute left-1/2 -translate-x-1/2 -top-2">
            <div className="w-3 h-3 bg-white dark:bg-slate-800 border-l border-t border-slate-200 dark:border-slate-700 transform rotate-45" />
          </div>
          <div className="py-1">
            <button
              onClick={() => handleMenuItemClick('visitList')}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-t-lg flex items-center gap-2"
            >
              <span>📍</span> 訪問先リスト
            </button>
            <button
              onClick={() => handleMenuItemClick('blockDefinition')}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
            >
              <span>🔲</span> ブロック定義
            </button>
            <button
              onClick={() => handleMenuItemClick('hallDefinition')}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-b-lg flex items-center gap-2"
            >
              <span>🏛️</span> ホール定義
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TabButton;
