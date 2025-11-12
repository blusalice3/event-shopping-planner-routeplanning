import React, { useRef, useState, useMemo } from 'react';
import { ShoppingItem } from '../types';
import ShoppingItemCard from './ShoppingItemCard';

interface ShoppingListProps {
  items: ShoppingItem[];
  onUpdateItem: (item: ShoppingItem) => void;
  onMoveItem: (dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate') => void;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  selectedItemIds: Set<string>;
  onSelectItem: (itemId: string) => void;
  onMoveToColumn?: (itemIds: string[]) => void;
  onRemoveFromColumn?: (itemIds: string[]) => void;
  columnType?: 'execute' | 'candidate';
  currentDay?: string; // 動的な参加日（例: '1日目', '2日目', '3日目'など）
}

// Constants for drag-and-drop auto-scrolling
const SCROLL_SPEED = 20;
const TOP_SCROLL_TRIGGER_PX = 150;
const BOTTOM_SCROLL_TRIGGER_PX = 100;

// 色のパレット定義（同系統の色が連続しないように色相環を考慮して配置）
// 色相環上で離れた色を交互に配置することで、隣り合うブロック値でも見分けやすくする
const colorPalette: Array<{ light: string; dark: string }> = [
  // 第1グループ: 暖色系と寒色系を交互に
  { light: 'bg-red-50 dark:bg-red-950/30', dark: 'bg-red-100 dark:bg-red-900/40' },        // 1: 赤
  { light: 'bg-blue-50 dark:bg-blue-950/30', dark: 'bg-blue-100 dark:bg-blue-900/40' },    // 2: 青
  { light: 'bg-yellow-50 dark:bg-yellow-950/30', dark: 'bg-yellow-100 dark:bg-yellow-900/40' }, // 3: 黄
  { light: 'bg-purple-50 dark:bg-purple-950/30', dark: 'bg-purple-100 dark:bg-purple-900/40' },  // 4: 紫
  { light: 'bg-green-50 dark:bg-green-950/30', dark: 'bg-green-100 dark:bg-green-900/40' },      // 5: 緑
  { light: 'bg-pink-50 dark:bg-pink-950/30', dark: 'bg-pink-100 dark:bg-pink-900/40' },          // 6: ピンク
  { light: 'bg-cyan-50 dark:bg-cyan-950/30', dark: 'bg-cyan-100 dark:bg-cyan-900/40' },          // 7: シアン
  { light: 'bg-orange-50 dark:bg-orange-950/30', dark: 'bg-orange-100 dark:bg-orange-900/40' },  // 8: オレンジ
  { light: 'bg-indigo-50 dark:bg-indigo-950/30', dark: 'bg-indigo-100 dark:bg-indigo-900/40' },  // 9: インディゴ
  { light: 'bg-lime-50 dark:bg-lime-950/30', dark: 'bg-lime-100 dark:bg-lime-900/40' },          // 10: ライム
  { light: 'bg-rose-50 dark:bg-rose-950/30', dark: 'bg-rose-100 dark:bg-rose-900/40' },          // 11: ローズ
  { light: 'bg-sky-50 dark:bg-sky-950/30', dark: 'bg-sky-100 dark:bg-sky-900/40' },              // 12: スカイ
  { light: 'bg-amber-50 dark:bg-amber-950/30', dark: 'bg-amber-100 dark:bg-amber-900/40' },      // 13: アンバー
  { light: 'bg-violet-50 dark:bg-violet-950/30', dark: 'bg-violet-100 dark:bg-violet-900/40' },  // 14: バイオレット
  { light: 'bg-emerald-50 dark:bg-emerald-950/30', dark: 'bg-emerald-100 dark:bg-emerald-900/40' }, // 15: エメラルド
  { light: 'bg-fuchsia-50 dark:bg-fuchsia-950/30', dark: 'bg-fuchsia-100 dark:bg-fuchsia-900/40' }, // 16: フクシア
  { light: 'bg-teal-50 dark:bg-teal-950/30', dark: 'bg-teal-100 dark:bg-teal-900/40' },          // 17: ティール
  { light: 'bg-slate-50 dark:bg-slate-950/30', dark: 'bg-slate-100 dark:bg-slate-900/40' },      // 18: スレート
  { light: 'bg-gray-50 dark:bg-gray-950/30', dark: 'bg-gray-100 dark:bg-gray-900/40' },          // 19: グレー
  { light: 'bg-stone-50 dark:bg-stone-950/30', dark: 'bg-stone-100 dark:bg-stone-900/40' },      // 20: ストーン
  { light: 'bg-neutral-50 dark:bg-neutral-950/30', dark: 'bg-neutral-100 dark:bg-neutral-900/40' }, // 21: ニュートラル
  { light: 'bg-zinc-50 dark:bg-zinc-950/30', dark: 'bg-zinc-100 dark:bg-zinc-900/40' },          // 22: ジンク
  // 第2グループ: より濃い色調で続ける（同系統が連続しないように）
  { light: 'bg-red-100 dark:bg-red-900/40', dark: 'bg-red-200 dark:bg-red-800/50' },            // 23: 赤（濃）
  { light: 'bg-blue-100 dark:bg-blue-900/40', dark: 'bg-blue-200 dark:bg-blue-800/50' },      // 24: 青（濃）
  { light: 'bg-yellow-100 dark:bg-yellow-900/40', dark: 'bg-yellow-200 dark:bg-yellow-800/50' }, // 25: 黄（濃）
  { light: 'bg-purple-100 dark:bg-purple-900/40', dark: 'bg-purple-200 dark:bg-purple-800/50' },  // 26: 紫（濃）
  { light: 'bg-green-100 dark:bg-green-900/40', dark: 'bg-green-200 dark:bg-green-800/50' },      // 27: 緑（濃）
  { light: 'bg-pink-100 dark:bg-pink-900/40', dark: 'bg-pink-200 dark:bg-pink-800/50' },          // 28: ピンク（濃）
  { light: 'bg-cyan-100 dark:bg-cyan-900/40', dark: 'bg-cyan-200 dark:bg-cyan-800/50' },          // 29: シアン（濃）
  { light: 'bg-orange-100 dark:bg-orange-900/40', dark: 'bg-orange-200 dark:bg-orange-800/50' },  // 30: オレンジ（濃）
];

// アイテムリストからブロックベースの色情報を計算
const calculateBlockColors = (items: ShoppingItem[]): Map<string, string> => {
  const colorMap = new Map<string, string>();
  
  // 未購入のアイテムから実際に存在するブロック値を収集
  const uniqueBlocks = new Set<string>();
  items.forEach(item => {
    if (item.purchaseStatus === 'None') {
      uniqueBlocks.add(item.block);
    }
  });
  
  // ブロック値をソート（数値と文字列の両方に対応）
  const sortedBlocks = Array.from(uniqueBlocks).sort((a, b) => {
    // 数値として比較できる場合は数値で比較
    const numA = Number(a);
    const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    // 文字列として比較
    return a.localeCompare(b);
  });
  
  // ブロック値ごとに色を割り当て
  const blockColorMap = new Map<string, { light: string; dark: string }>();
  sortedBlocks.forEach((block, index) => {
    // 色のパレットから循環的に色を割り当て
    const colorIndex = index % colorPalette.length;
    blockColorMap.set(block, colorPalette[colorIndex]);
  });
  
  // 各アイテムに色を割り当て（同じブロック値のアイテム同士で交互に色を付ける）
  items.forEach((item, index) => {
    // 未購入のアイテムのみブロックベースの色を適用
    if (item.purchaseStatus === 'None') {
      const block = item.block;
      const blockColor = blockColorMap.get(block);
      
      if (blockColor) {
        // 同じブロック値のアイテム同士で交互に色を付ける
        // 前のアイテムが同じブロック値かどうかを確認
        const prevItem = index > 0 ? items[index - 1] : null;
        const isSameBlockAsPrev = prevItem && prevItem.block === block && prevItem.purchaseStatus === 'None';
        
        if (isSameBlockAsPrev) {
          // 前のアイテムと同じブロック値の場合、交互に色を付ける
          const prevColor = colorMap.get(items[index - 1].id) || '';
          const shouldUseDark = prevColor === blockColor.light;
          colorMap.set(item.id, shouldUseDark ? blockColor.dark : blockColor.light);
        } else {
          // 前のアイテムと異なるブロック値の場合、薄い色から開始
          colorMap.set(item.id, blockColor.light);
        }
      }
    }
  });
  
  return colorMap;
};

const ShoppingList: React.FC<ShoppingListProps> = ({
  items,
  onUpdateItem,
  onMoveItem,
  onEditRequest,
  onDeleteRequest,
  selectedItemIds,
  onSelectItem,
  onMoveToColumn: _onMoveToColumn,
  onRemoveFromColumn: _onRemoveFromColumn,
  columnType,
  currentDay: _currentDay,
}) => {
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ブロックベースの色情報を計算
  const blockColorMap = useMemo(() => calculateBlockColors(items), [items]);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    dragItem.current = item.id;
    if (columnType) {
      e.dataTransfer.setData('sourceColumn', columnType);
    }
    const target = e.currentTarget;
    setTimeout(() => {
      if (target) {
        target.classList.add('opacity-40');
      }
      // 複数選択時は選択されたアイテムすべての不透明度を下げる
      if (selectedItemIds.has(item.id)) {
        document.querySelectorAll('[data-is-selected="true"]').forEach(el => {
          el.classList.add('opacity-40');
        });
      }
    }, 0);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem, index: number) => {
    e.preventDefault();
    // 選択されたアイテムの上にはドロップできない
    if (selectedItemIds.has(item.id) && selectedItemIds.has(dragItem.current || '')) {
      dragOverItem.current = null;
      return;
    }
    dragOverItem.current = item.id;
    
    // 挿入位置を計算（アイテムの中央より上か下かで判定）
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const itemHeight = rect.height || 100; // フォールバック値
    const insertIndex = relativeY < itemHeight / 2 ? index : index + 1;
    setInsertPosition(Math.min(insertIndex, items.length));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 自動スクロール機能
    const clientY = e.clientY;
    const windowHeight = window.innerHeight;
    
    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      // ヘッダーに近づいたら上にスクロール
      window.scrollBy(0, -SCROLL_SPEED);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      // フッターに近づいたら下にスクロール
      window.scrollBy(0, SCROLL_SPEED);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const sourceColumn = e.dataTransfer.getData('sourceColumn') as 'execute' | 'candidate' | undefined;
    
    // 同じ列内での移動のみ許可
    if (sourceColumn !== columnType) {
      setInsertPosition(null);
      dragItem.current = null;
      dragOverItem.current = null;
      return;
    }
    
    // 同じ列内での移動
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      onMoveItem(dragItem.current, dragOverItem.current, columnType);
    }
    
    setInsertPosition(null);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove('opacity-40');
    document.querySelectorAll('[data-is-selected="true"]').forEach(el => {
      el.classList.remove('opacity-40');
    });
    dragItem.current = null;
    dragOverItem.current = null;
    setInsertPosition(null);
    e.dataTransfer.clearData();
  };

  if (items.length === 0) {
      return (
        <div className="text-center text-slate-500 dark:text-slate-400 py-12 min-h-[200px] border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg relative">
          この日のアイテムはありません。
        </div>
      );
  }

  return (
    <div 
      ref={containerRef}
      className="space-y-4 pb-24 relative"
      onDragOver={(e) => {
        e.preventDefault();
        // コンテナ全体での自動スクロール
        const clientY = e.clientY;
        const windowHeight = window.innerHeight;
        
        if (clientY < TOP_SCROLL_TRIGGER_PX) {
          window.scrollBy(0, -SCROLL_SPEED);
        } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
          window.scrollBy(0, SCROLL_SPEED);
        }
      }}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {/* 挿入位置インジケーター */}
          {insertPosition === index && (
            <div className="flex items-center justify-center h-2 my-2 relative z-10">
              <div className="w-full h-0.5 bg-blue-500"></div>
              <div className="absolute left-1/2 -translate-x-1/2 bg-blue-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg font-bold">
                +
              </div>
            </div>
          )}
          <div
            data-item-id={item.id}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            onDragEnter={(e) => handleDragEnter(e, item, index)}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            className="transition-opacity duration-200 relative"
            data-is-selected={selectedItemIds.has(item.id)}
          >
            <ShoppingItemCard
              item={item}
              onUpdate={onUpdateItem}
              isStriped={index % 2 !== 0}
              onEditRequest={onEditRequest}
              onDeleteRequest={onDeleteRequest}
              isSelected={selectedItemIds.has(item.id)}
              onSelectItem={onSelectItem}
              blockBackgroundColor={blockColorMap.get(item.id)}
            />
          </div>
          {/* 最後のアイテムの後に挿入位置インジケーター */}
          {insertPosition === items.length && index === items.length - 1 && (
            <div className="flex items-center justify-center h-2 my-2 relative z-10">
              <div className="w-full h-0.5 bg-blue-500"></div>
              <div className="absolute left-1/2 -translate-x-1/2 bg-blue-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg font-bold">
                +
              </div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export default ShoppingList;
