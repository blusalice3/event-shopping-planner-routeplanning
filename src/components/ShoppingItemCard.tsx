import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { ShoppingItem, PurchaseStatus, PurchaseStatuses } from '../types';
import GripVerticalIcon from './icons/GripVerticalIcon';
import CheckCircleIcon from './icons/CheckCircleIcon';
import CircleIcon from './icons/CircleIcon';
import XCircleIcon from './icons/XCircleIcon';
import MinusCircleIcon from './icons/MinusCircleIcon';
import PauseCircleIcon from './icons/PauseCircleIcon';
import ClockIcon from './icons/ClockIcon';

export interface ShoppingItemCardProps {
  item: ShoppingItem;
  onUpdate: (item: ShoppingItem) => void;
  isStriped: boolean;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  isSelected: boolean;
  onSelectItem: (itemId: string) => void;
  blockBackgroundColor?: string;
}

const statusConfig: Record<PurchaseStatus, { label: string; icon: React.FC<any>; color: string; dim: boolean; bg: string; }> = {
  None: { label: '未購入', icon: CircleIcon, color: 'text-slate-400 dark:text-slate-500', dim: false, bg: '' },
  Purchased: { label: '購入済', icon: CheckCircleIcon, color: 'text-green-600 dark:text-green-400', dim: true, bg: 'bg-green-500/20 dark:bg-green-500/30' },
  SoldOut: { label: '売切', icon: XCircleIcon, color: 'text-red-600 dark:text-red-400', dim: true, bg: 'bg-red-500/20 dark:bg-red-500/30' },
  Absent: { label: '欠席', icon: MinusCircleIcon, color: 'text-yellow-600 dark:text-yellow-400', dim: true, bg: 'bg-yellow-500/20 dark:bg-yellow-500/30' },
  Postpone: { label: '後回し', icon: PauseCircleIcon, color: 'text-purple-600 dark:text-purple-400', dim: false, bg: 'bg-purple-500/20 dark:bg-purple-500/30' },
  Late: { label: '遅参', icon: ClockIcon, color: 'text-blue-600 dark:text-blue-400', dim: false, bg: 'bg-blue-500/20 dark:bg-blue-500/30' },
};


const ShoppingItemCard: React.FC<ShoppingItemCardProps> = ({
  item,
  onUpdate,
  isStriped,
  onEditRequest,
  onDeleteRequest,
  isSelected,
  onSelectItem,
  blockBackgroundColor,
}) => {
  const [menuVisible, setMenuVisible] = useState(false);
  const longPressTimeout = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const handlePriceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const updatedItem: ShoppingItem = {
      ...item,
      price: value === '' ? null : parseInt(value, 10) || 0
    };
    onUpdate(updatedItem);
  };

  const togglePurchaseStatus = useCallback(() => {
    const currentIndex = PurchaseStatuses.indexOf(item.purchaseStatus);
    const nextIndex = (currentIndex + 1) % PurchaseStatuses.length;
    const nextStatus = PurchaseStatuses[nextIndex];
    onUpdate({ ...item, purchaseStatus: nextStatus });
  }, [item, onUpdate]);

  const handleRemarksChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdate({ ...item, remarks: e.target.value });
  };
  
  const clearLongPress = useCallback(() => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    // Don't trigger on drag handle or interactive elements
    if ((e.target as HTMLElement).closest('[data-drag-handle], button, input, select, [data-no-long-press]')) {
        return;
    }
    clearLongPress();
    longPressTimeout.current = window.setTimeout(() => {
        setMenuVisible(true);
    }, 500); // 500ms for long press
  };

  const handlePointerUp = () => {
    clearLongPress();
  };
  
  const handlePointerLeave = () => {
    clearLongPress();
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuVisible && cardRef.current && !cardRef.current.contains(event.target as Node)) {
        setMenuVisible(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuVisible]);


  const priceOptions = useMemo(() => {
    const options = new Set<number | null>();
    options.add(null); // 価格未定を最初に追加
    options.add(0); // 0円を追加
    for (let i = 1; i <= 100; i++) {
        options.add(i * 100);
    }
    if (item.price !== null) {
      options.add(item.price); // Ensure current price is always an option
    }
    return Array.from(options).sort((a, b) => {
      if (a === null) return -1;
      if (b === null) return 1;
      return a - b;
    });
  }, [item.price]);


  const currentStatus = statusConfig[item.purchaseStatus];
  const locationString = `${item.block}-${item.number}`;
  const IconComponent = currentStatus.icon;

  // 備考欄のチェック
  const remarksWarning = useMemo(() => {
    if (!item.remarks) return null;
    if (item.remarks.includes('優先')) return '⚠️優先⚠️';
    if (item.remarks.includes('委託無')) return '⚠️委託無⚠️';
    return null;
  }, [item.remarks]);

  // 未購入の場合はブロックベースの色を使用、それ以外は購入状態の色を優先
  const isUnpurchased = item.purchaseStatus === 'None';
  const useBlockColor = isUnpurchased && blockBackgroundColor;

  // 文字表示エリアの背景色を計算（警告表示を隠すため）
  const textAreaBgColor = useMemo(() => {
    if (isSelected) {
      return 'rgba(219, 234, 254, 0.8)'; // bg-blue-100相当
    }
    if (useBlockColor) {
      return 'transparent';
    }
    if (isStriped) {
      return 'rgba(239, 246, 255, 0.4)'; // bg-blue-50/50相当
    }
    return 'rgba(255, 255, 255, 0.8)'; // bg-white相当
  }, [isSelected, useBlockColor, isStriped]);

  // ダークモード用の文字表示エリアの背景色を計算
  const textAreaBgColorDark = useMemo(() => {
    if (isSelected) {
      return 'rgba(30, 58, 138, 0.5)'; // dark:bg-blue-900/50相当
    }
    if (useBlockColor) {
      return 'transparent';
    }
    if (isStriped) {
      return 'rgba(15, 23, 42, 0.5)'; // dark:bg-slate-900/50相当
    }
    return 'rgba(30, 41, 59, 0.8)'; // dark:bg-slate-800相当
  }, [isSelected, useBlockColor, isStriped]);

  const baseBg = isSelected 
    ? 'bg-blue-100 dark:bg-blue-900/50'
    : useBlockColor
    ? blockBackgroundColor
    : isStriped
    ? 'bg-blue-50/50 dark:bg-slate-900/50'
    : 'bg-white dark:bg-slate-800';

  const cardClasses = `
    rounded-lg shadow-md transition-all duration-300 flex items-stretch relative overflow-hidden
    ${baseBg}
    ${currentStatus.dim ? 'opacity-60 dark:opacity-50' : 'opacity-100'}
  `;
  
  // 未購入の場合はブロック色を使用するため、購入状態の背景色は適用しない
  const statusBgOverlay = isUnpurchased ? '' : `absolute inset-0 rounded-lg ${currentStatus.bg} pointer-events-none`;

  return (
    <div 
        className={cardClasses} 
        ref={cardRef}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onTouchMove={handlePointerLeave} // Cancel on scroll
    >
      {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-500"></div>}
      {statusBgOverlay && <div className={statusBgOverlay}></div>}
      {remarksWarning && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <span className="text-gray-500 dark:text-gray-400 text-5xl font-bold opacity-40">{remarksWarning}</span>
        </div>
      )}
      <div data-drag-handle className="relative p-3 flex flex-col items-center justify-start cursor-grab text-slate-400 dark:text-slate-500 border-r border-slate-200/80 dark:border-slate-700/80 space-y-2 z-10">
        <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onSelectItem(item.id)}
            onClick={(e) => e.stopPropagation()} // Prevent long press/drag from firing
            data-no-long-press
            className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500"
            aria-label={`Select item ${item.circle} - ${item.title}`}
        />
        <GripVerticalIcon className="w-6 h-6" />
      </div>

      <div 
        className="relative flex-grow p-4 min-w-0 flex flex-col h-full z-20" 
      >
        {/* 警告表示を隠すための背景レイヤー */}
        <div 
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{ 
            backgroundColor: textAreaBgColor,
          }}
        ></div>
        {/* ダークモード用の背景レイヤー */}
        <style>{`
          @media (prefers-color-scheme: dark) {
            .text-area-bg-dark-${item.id.replace(/[^a-zA-Z0-9]/g, '-')} {
              background-color: ${textAreaBgColorDark} !important;
            }
          }
        `}</style>
        <div 
          className={`absolute inset-0 rounded-lg pointer-events-none text-area-bg-dark-${item.id.replace(/[^a-zA-Z0-9]/g, '-')}`}
        ></div>
        <div className="relative z-10 flex justify-between items-start gap-4">
            <div>
                <p className="font-bold text-md text-slate-900 dark:text-slate-100">{`${item.eventDate} ${locationString}`}</p>
                <p className="mt-1 text-slate-600 dark:text-slate-300 truncate" title={item.circle}>{item.circle}</p>
            </div>
            <input
                type="text"
                value={item.remarks}
                onChange={handleRemarksChange}
                placeholder="備考"
                className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 w-32 sm:w-40 focus:ring-2 focus:ring-blue-500 focus:outline-none transition"
            />
        </div>
        <div className={`relative z-10 flex-grow flex flex-col items-center justify-center text-center text-slate-700 dark:text-slate-200 ${currentStatus.dim ? 'line-through' : ''}`}>
          <p className="text-lg font-semibold truncate" title={item.title}>{item.title || '（タイトルなし）'}</p>
        </div>
      </div>
      
      <div className="relative flex flex-col items-end justify-between space-y-2 p-4 border-l border-slate-200/80 dark:border-slate-700/80 z-10">
        <button 
          onClick={togglePurchaseStatus} 
          className="flex items-center space-x-2 p-2 -m-2 rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          aria-label={`Current status: ${currentStatus.label}. Click to change.`}
        >
          <IconComponent className={`w-7 h-7 ${currentStatus.color}`} />
          <span className={`font-semibold w-16 text-left ${currentStatus.color}`}>{currentStatus.label}</span>
        </button>
        <div className="flex items-center">
            {item.price !== null && <span className="text-slate-500 dark:text-slate-400 mr-1">¥</span>}
            <select
              value={item.price === null ? '' : item.price}
              onChange={handlePriceChange}
              className={`w-28 text-md font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 pl-2 pr-8 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none ${
                item.price === null ? 'text-red-600 dark:text-red-400' : ''
              }`}
            >
              {priceOptions.map(p => (
                <option key={p === null ? '' : p} value={p === null ? '' : p}>
                  {p === null ? '価格未定' : p === 0 ? '0' : p.toLocaleString()}
                </option>
              ))}
            </select>
          </div>
      </div>
      
      {menuVisible && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20" onClick={(e) => e.stopPropagation()}>
            <div className="flex gap-4 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm rounded-lg shadow-2xl border border-slate-300 dark:border-slate-600 p-4">
                <button onClick={() => { onEditRequest(item); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors">編集</button>
                <button onClick={() => { onDeleteRequest(item); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors">削除</button>
            </div>
        </div>
      )}
    </div>
  );
};

export default ShoppingItemCard;
