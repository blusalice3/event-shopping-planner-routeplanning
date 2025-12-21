import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { ShoppingItem, PurchaseStatus, PurchaseStatuses } from '../types';
import GripVerticalIcon from './icons/GripVerticalIcon';
import CheckCircleIcon from './icons/CheckCircleIcon';
import CircleIcon from './icons/CircleIcon';
import XCircleIcon from './icons/XCircleIcon';
import MinusCircleIcon from './icons/MinusCircleIcon';
import PauseCircleIcon from './icons/PauseCircleIcon';
import ClockIcon from './icons/ClockIcon';
import ChevronUpIcon from './icons/ChevronUpIcon';
import ChevronDownIcon from './icons/ChevronDownIcon';

export interface ShoppingItemCardProps {
  item: ShoppingItem;
  onUpdate: (item: ShoppingItem) => void;
  isStriped: boolean;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  isSelected: boolean;
  onSelectItem: (itemId: string) => void;
  blockBackgroundColor?: string;
  onMoveUp?: (itemId: string) => void;
  onMoveDown?: (itemId: string) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  isDuplicateCircle?: boolean;
  isSearchMatch?: boolean;
  layoutMode?: 'pc' | 'smartphone';
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
  onMoveUp,
  onMoveDown,
  canMoveUp = true,
  canMoveDown = true,
  isDuplicateCircle = false,
  isSearchMatch = false,
  layoutMode = 'pc',
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

  const handleQuantityChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseInt(e.target.value, 10) || 1;
    const updatedItem: ShoppingItem = {
      ...item,
      quantity: value
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

  // 備考欄のチェック - 画像タグを決定
  const warningTags = useMemo(() => {
    const tags: string[] = [];
    if (isDuplicateCircle) {
      tags.push('複数種');
    }
    if (item.remarks) {
      if (item.remarks.includes('優先')) {
        tags.push('優先');
      }
      if (item.remarks.includes('委託無')) {
        tags.push('委託無');
      }
    }
    return tags;
  }, [isDuplicateCircle, item.remarks]);

  // 警告タグが表示されるかどうか
  const hasWarningTags = warningTags.length > 0;

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
    rounded-lg shadow-md transition-all duration-300 relative overflow-hidden
    ${baseBg}
    ${currentStatus.dim ? 'opacity-60 dark:opacity-50' : 'opacity-100'}
    ${isSearchMatch ? 'ring-4 ring-red-500 ring-offset-2' : ''}
  `;
  
  // 未購入の場合はブロック色を使用するため、購入状態の背景色は適用しない
  const statusBgOverlay = isUnpurchased ? '' : `absolute inset-0 rounded-lg ${currentStatus.bg} pointer-events-none`;

  // スマートフォンモード用レイアウト
  if (layoutMode === 'smartphone') {
    return (
      <div 
          className={cardClasses} 
          ref={cardRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onTouchMove={handlePointerLeave}
          data-search-match={isSearchMatch ? 'true' : undefined}
      >
        {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-500"></div>}
        {statusBgOverlay && <div className={statusBgOverlay}></div>}
        
        {/* 警告ストライプ背景（右側全体） */}
        {hasWarningTags && (
          <div 
            className="absolute right-0 top-0 bottom-0 w-32 pointer-events-none"
            style={{
              backgroundImage: 'repeating-linear-gradient(45deg, #fef08a 0px, #fef08a 10px, #000 10px, #000 20px)',
              backgroundSize: '28.28px 28.28px',
              opacity: 0.3,
            }}
          ></div>
        )}
        
        <div className="flex">
          {/* 左側：チェックボックス・移動ボタン */}
          <div data-drag-handle className="relative p-2 flex flex-col items-center justify-start cursor-grab text-slate-400 dark:text-slate-500 border-r border-slate-200/80 dark:border-slate-700/80 space-y-1 z-10">
            <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onSelectItem(item.id)}
                onClick={(e) => e.stopPropagation()}
                data-no-long-press
                className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500"
                aria-label={`Select item ${item.circle} - ${item.title}`}
            />
            {onMoveUp && (
              <button
                onClick={(e) => { e.stopPropagation(); onMoveUp(item.id); }}
                disabled={!canMoveUp}
                data-no-long-press
                className={`p-0.5 rounded-md transition-colors ${canMoveUp ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'}`}
                aria-label="上に移動"
              >
                <ChevronUpIcon className="w-4 h-4" />
              </button>
            )}
            <GripVerticalIcon className="w-5 h-5" />
            {onMoveDown && (
              <button
                onClick={(e) => { e.stopPropagation(); onMoveDown(item.id); }}
                disabled={!canMoveDown}
                data-no-long-press
                className={`p-0.5 rounded-md transition-colors ${canMoveDown ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'}`}
                aria-label="下に移動"
              >
                <ChevronDownIcon className="w-4 h-4" />
              </button>
            )}
          </div>
          
          {/* メインコンテンツエリア */}
          <div className="flex-grow flex flex-col min-w-0 relative z-10">
            {/* 上段: 日付・ブロック・サークル名・警告タグ + 備考欄 */}
            <div className="p-2 pb-1">
              <div className="flex justify-between items-start gap-2">
                <div className="flex-grow min-w-0">
                  <p className="font-bold text-sm text-slate-900 dark:text-slate-100">{`${item.eventDate} ${locationString}`}</p>
                  <div className="flex items-center gap-1 flex-wrap mt-0.5">
                    <p className="text-sm text-slate-600 dark:text-slate-300 truncate" title={item.circle}>{item.circle}</p>
                    {warningTags.map((tag, index) => (
                      <img key={index} src={`/${tag}.png`} alt={tag} className="h-8 w-auto object-contain" />
                    ))}
                  </div>
                </div>
              </div>
              {/* タイトル */}
              <p className={`text-sm font-semibold text-slate-700 dark:text-slate-200 truncate mt-1 ${currentStatus.dim ? 'line-through' : ''}`} title={item.title}>
                {item.title || '（タイトルなし）'}
              </p>
            </div>
            
            {/* 下段: 備考欄 + 購入状態・数量・価格 */}
            <div className="p-2 pt-1 flex flex-col gap-1.5 border-t border-slate-200/50 dark:border-slate-700/50">
              {/* 備考欄（購入状態トグルの上） */}
              <input
                type="text"
                value={item.remarks}
                onChange={handleRemarksChange}
                placeholder="備考"
                className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 w-full focus:ring-2 focus:ring-blue-500 focus:outline-none transition"
              />
              
              {/* 操作エリア: 購入状態・数量・価格 */}
              <div className="flex items-center gap-2">
                <button 
                  onClick={togglePurchaseStatus} 
                  className="flex items-center space-x-1 p-1.5 rounded-md bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                  aria-label={`Current status: ${currentStatus.label}. Click to change.`}
                >
                  <IconComponent className={`w-5 h-5 ${currentStatus.color}`} />
                  <span className={`text-xs font-semibold ${currentStatus.color}`}>{currentStatus.label}</span>
                </button>
                
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-600 dark:text-slate-400">数量</span>
                  <select
                    value={item.quantity}
                    onChange={handleQuantityChange}
                    className="text-sm font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-1 text-center focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none w-12"
                  >
                    {Array.from({ length: 10 }, (_, i) => i + 1).map(num => (
                      <option key={num} value={num}>{num}</option>
                    ))}
                  </select>
                </div>
                
                <div className="flex items-center gap-0.5 flex-grow justify-end">
                  {item.price !== null && <span className="text-xs text-slate-500 dark:text-slate-400">¥</span>}
                  <select
                    value={item.price === null ? '' : item.price}
                    onChange={handlePriceChange}
                    className={`text-sm font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-1 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none w-20 ${item.price === null ? 'text-red-600 dark:text-red-400' : ''}`}
                  >
                    {priceOptions.map(p => (
                      <option key={p === null ? '' : p} value={p === null ? '' : p}>
                        {p === null ? '価格未定' : p === 0 ? '0' : p.toLocaleString()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {menuVisible && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-col gap-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm rounded-lg shadow-2xl border border-slate-300 dark:border-slate-600 p-4">
                  <button onClick={() => { onEditRequest(item); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors">編集</button>
                  {item.url && (
                    <button onClick={() => { window.open(item.url, '_blank'); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-green-600 hover:bg-green-700 transition-colors">URLを開く</button>
                  )}
                  <button onClick={() => { onDeleteRequest(item); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors">削除</button>
              </div>
          </div>
        )}
      </div>
    );
  }

  // PCモード（従来のレイアウト）
  const pcCardClasses = `
    rounded-lg shadow-md transition-all duration-300 flex items-stretch relative overflow-hidden
    ${baseBg}
    ${currentStatus.dim ? 'opacity-60 dark:opacity-50' : 'opacity-100'}
    ${isSearchMatch ? 'ring-4 ring-red-500 ring-offset-2' : ''}
  `;

  return (
    <div 
        className={pcCardClasses} 
        ref={cardRef}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onTouchMove={handlePointerLeave} // Cancel on scroll
        data-search-match={isSearchMatch ? 'true' : undefined}
    >
      {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-500"></div>}
      {statusBgOverlay && <div className={statusBgOverlay}></div>}
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
        {onMoveUp && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp(item.id);
            }}
            disabled={!canMoveUp}
            data-no-long-press
            className={`p-1 rounded-md transition-colors ${
              canMoveUp
                ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer'
                : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'
            }`}
            aria-label="上に移動"
            title="上に移動"
          >
            <ChevronUpIcon className="w-4 h-4" />
          </button>
        )}
        <GripVerticalIcon className="w-6 h-6" />
        {onMoveDown && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown(item.id);
            }}
            disabled={!canMoveDown}
            data-no-long-press
            className={`p-1 rounded-md transition-colors ${
              canMoveDown
                ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer'
                : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'
            }`}
            aria-label="下に移動"
            title="下に移動"
          >
            <ChevronDownIcon className="w-4 h-4" />
          </button>
        )}
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
                <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <p className="text-slate-600 dark:text-slate-300 truncate" title={item.circle}>{item.circle}</p>
                    {warningTags.map((tag, index) => (
                        <img
                            key={index}
                            src={`/${tag}.png`}
                            alt={tag}
                            className="h-12 w-auto object-contain"
                            style={{ height: '3rem' }}
                        />
                    ))}
                </div>
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
      
      <div className="relative flex flex-col items-end justify-between space-y-3 p-4 border-l border-slate-200/80 dark:border-slate-700/80 z-10">
        {hasWarningTags && (
          <div 
            className="absolute inset-0 pointer-events-none rounded-r-lg"
            style={{
              backgroundImage: 'repeating-linear-gradient(45deg, #fef08a 0px, #fef08a 10px, #000 10px, #000 20px)',
              backgroundSize: '28.28px 28.28px',
              opacity: 0.4,
            }}
          ></div>
        )}
        <button 
          onClick={togglePurchaseStatus} 
          className="flex items-center space-x-2 p-2 -m-2 rounded-md bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors relative z-10 w-full justify-start"
          aria-label={`Current status: ${currentStatus.label}. Click to change.`}
        >
          <IconComponent className={`w-7 h-7 ${currentStatus.color}`} />
          <span className={`font-semibold w-16 text-left ${currentStatus.color}`}>{currentStatus.label}</span>
        </button>
        <div className="flex items-center gap-2 relative z-10 w-full">
          <span className="text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">数量</span>
          <select
            value={item.quantity}
            onChange={handleQuantityChange}
            className="flex-1 text-md font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 pl-2 pr-8 text-center focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none min-w-[60px]"
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map(num => (
              <option key={num} value={num}>
                {num}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1 relative z-10 w-full justify-end">
            {item.price !== null && <span className="text-slate-500 dark:text-slate-400">¥</span>}
            <select
              value={item.price === null ? '' : item.price}
              onChange={handlePriceChange}
              className={`flex-1 text-md font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 pl-2 pr-8 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none min-w-[100px] ${
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
            <div className="flex flex-col gap-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm rounded-lg shadow-2xl border border-slate-300 dark:border-slate-600 p-4">
                <button onClick={() => { onEditRequest(item); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors">編集</button>
                {item.url && (
                  <button 
                    onClick={() => { 
                      window.open(item.url, '_blank'); 
                      setMenuVisible(false); 
                    }} 
                    className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-green-600 hover:bg-green-700 transition-colors"
                  >
                    URLを開く
                  </button>
                )}
                <button onClick={() => { onDeleteRequest(item); setMenuVisible(false); }} className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors">削除</button>
            </div>
        </div>
      )}
    </div>
  );
};

export default ShoppingItemCard;
