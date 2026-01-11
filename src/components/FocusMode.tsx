import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { ShoppingItem } from '../types';
import ShoppingItemCard from './ShoppingItemCard';

// フェーズの定義
type FocusPhase = 'normal' | 'postponed' | 'late';

interface FocusModeProps {
  items: ShoppingItem[];
  executeModeItemIds: string[];
  onUpdateItem: (item: ShoppingItem) => void;
  onModeChange: (mode: 'edit' | 'execute', lastItemId?: string) => void;
  layoutMode: 'pc' | 'smartphone';
}

// ナンバーからベース部分（アルファベットとその左側の数値）を抽出
const extractBaseNumber = (number: string): string => {
  // "10a" -> "10a", "10a1" -> "10a", "10a2" -> "10a", "38a" -> "38a", "38a1" -> "38a"
  const match = number.match(/^(\d+[a-zA-Z])/);
  return match ? match[1].toLowerCase() : number.toLowerCase();
};

// 訪問先キーを生成（参加日 + ブロック + ベースナンバー）
const getVisitKey = (item: ShoppingItem): string => {
  const baseNumber = extractBaseNumber(item.number);
  return `${item.eventDate}-${item.block}-${baseNumber}`;
};

const FocusMode: React.FC<FocusModeProps> = ({
  items,
  executeModeItemIds,
  onUpdateItem,
  onModeChange,
  layoutMode,
}) => {
  // 現在のフェーズ
  const [currentPhase, setCurrentPhase] = useState<FocusPhase>('normal');
  // 現在の訪問先インデックス
  const [currentVisitIndex, setCurrentVisitIndex] = useState(0);
  // 最後に操作したアイテムID
  const [lastInteractedItemId, setLastInteractedItemId] = useState<string | null>(null);
  // 次へボタンの点滅状態
  const [isNextButtonBlinking, setIsNextButtonBlinking] = useState(false);
  // 価格未定警告の点滅状態
  const [blinkingPriceItemIds, setBlinkingPriceItemIds] = useState<Set<string>>(new Set());
  // 通知メッセージ
  const [notification, setNotification] = useState<string | null>(null);
  // 完了状態
  const [isCompleted, setIsCompleted] = useState(false);

  // 実行列のアイテムを取得
  const executeItems = useMemo(() => {
    return executeModeItemIds
      .map(id => items.find(item => item.id === id))
      .filter((item): item is ShoppingItem => item !== undefined);
  }, [items, executeModeItemIds]);

  // フェーズごとの訪問先リストを計算
  const visitsByPhase = useMemo(() => {
    const groupByVisitKey = (itemList: ShoppingItem[]) => {
      const groups = new Map<string, ShoppingItem[]>();
      itemList.forEach(item => {
        const key = getVisitKey(item);
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(item);
      });
      return Array.from(groups.values());
    };

    // 通常フェーズ: 後回し・遅参以外のアイテムがある訪問先
    const normalItems = executeItems.filter(item => 
      item.purchaseStatus !== 'Postpone' && item.purchaseStatus !== 'Late'
    );
    const normalVisits = groupByVisitKey(normalItems);

    // 後回しフェーズ: 後回しアイテムがある訪問先
    const postponedItems = executeItems.filter(item => item.purchaseStatus === 'Postpone');
    const postponedVisits = groupByVisitKey(postponedItems);

    // 遅参フェーズ: 遅参アイテムがある訪問先
    const lateItems = executeItems.filter(item => item.purchaseStatus === 'Late');
    const lateVisits = groupByVisitKey(lateItems);

    return {
      normal: normalVisits,
      postponed: postponedVisits,
      late: lateVisits,
    };
  }, [executeItems]);

  // 現在のフェーズの訪問先リスト
  const currentPhaseVisits = useMemo(() => {
    return visitsByPhase[currentPhase];
  }, [visitsByPhase, currentPhase]);

  // 現在の訪問先のアイテム（全アイテム表示：後回し・遅参含む）
  const currentVisitItems = useMemo(() => {
    if (currentPhaseVisits.length === 0) return [];
    
    const safeIndex = Math.min(currentVisitIndex, currentPhaseVisits.length - 1);
    const baseItems = currentPhaseVisits[safeIndex] || [];
    
    if (baseItems.length === 0) return [];
    
    // 同じ訪問先キーを持つ全アイテムを取得
    const visitKey = getVisitKey(baseItems[0]);
    return executeItems.filter(item => getVisitKey(item) === visitKey);
  }, [currentPhaseVisits, currentVisitIndex, executeItems]);

  // 総訪問先数（全フェーズ合計）
  const totalVisits = useMemo(() => {
    return visitsByPhase.normal.length + visitsByPhase.postponed.length + visitsByPhase.late.length;
  }, [visitsByPhase]);

  // 現在の訪問先番号（全フェーズ通算）
  const currentVisitNumber = useMemo(() => {
    let number = currentVisitIndex + 1;
    if (currentPhase === 'postponed') {
      number += visitsByPhase.normal.length;
    } else if (currentPhase === 'late') {
      number += visitsByPhase.normal.length + visitsByPhase.postponed.length;
    }
    return number;
  }, [currentVisitIndex, currentPhase, visitsByPhase]);

  // フェーズ名の日本語表示
  const phaseDisplayName = useMemo(() => {
    switch (currentPhase) {
      case 'normal': return '通常';
      case 'postponed': return '後回し';
      case 'late': return '遅参';
    }
  }, [currentPhase]);

  // 現在のフェーズの訪問先数
  const currentPhaseTotal = useMemo(() => {
    return currentPhaseVisits.length;
  }, [currentPhaseVisits]);

  // 価格未定かつ購入済みのアイテムをチェック
  const hasUndefinedPricePurchased = useMemo(() => {
    return currentVisitItems.some(item => 
      item.purchaseStatus === 'Purchased' && item.price === -1
    );
  }, [currentVisitItems]);

  // 次へボタンの点滅を更新
  useEffect(() => {
    if (hasUndefinedPricePurchased) {
      setIsNextButtonBlinking(false);
      // 価格未定のアイテムを点滅
      const undefinedPriceIds = currentVisitItems
        .filter(item => item.purchaseStatus === 'Purchased' && item.price === -1)
        .map(item => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
    } else {
      setBlinkingPriceItemIds(new Set());
      // 全アイテムの購入状態が変更されたら点滅開始
      const hasUnprocessed = currentVisitItems.some(item => item.purchaseStatus === 'None');
      setIsNextButtonBlinking(!hasUnprocessed && currentVisitItems.length > 0);
    }
  }, [currentVisitItems, hasUndefinedPricePurchased]);

  // 通知を自動で消す
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // 次の訪問先へ
  const handleNext = useCallback(() => {
    // 価格未定チェック
    if (hasUndefinedPricePurchased) {
      setNotification('価格未定のアイテムがあります。価格を入力してください。');
      return;
    }

    const nextIndex = currentVisitIndex + 1;
    
    if (nextIndex < currentPhaseVisits.length) {
      // 同じフェーズ内で次へ
      setCurrentVisitIndex(nextIndex);
      setIsNextButtonBlinking(false);
    } else {
      // フェーズ切り替え
      if (currentPhase === 'normal' && visitsByPhase.postponed.length > 0) {
        setNotification('後回しアイテムの巡回を開始します');
        setCurrentPhase('postponed');
        setCurrentVisitIndex(0);
        setIsNextButtonBlinking(false);
      } else if ((currentPhase === 'normal' || currentPhase === 'postponed') && visitsByPhase.late.length > 0) {
        if (currentPhase === 'postponed' || visitsByPhase.postponed.length === 0) {
          setNotification('遅参アイテムの巡回を開始します');
          setCurrentPhase('late');
          setCurrentVisitIndex(0);
          setIsNextButtonBlinking(false);
        }
      } else {
        // 全て完了
        setIsCompleted(true);
      }
    }
  }, [currentVisitIndex, currentPhaseVisits.length, currentPhase, visitsByPhase, hasUndefinedPricePurchased]);

  // 前の訪問先へ
  const handlePrev = useCallback(() => {
    if (currentVisitIndex > 0) {
      setCurrentVisitIndex(currentVisitIndex - 1);
      setIsNextButtonBlinking(false);
    } else {
      // フェーズの最初
      if (currentPhase === 'postponed' && visitsByPhase.normal.length > 0) {
        setCurrentPhase('normal');
        setCurrentVisitIndex(visitsByPhase.normal.length - 1);
        setIsNextButtonBlinking(false);
      } else if (currentPhase === 'late') {
        if (visitsByPhase.postponed.length > 0) {
          setCurrentPhase('postponed');
          setCurrentVisitIndex(visitsByPhase.postponed.length - 1);
          setIsNextButtonBlinking(false);
        } else if (visitsByPhase.normal.length > 0) {
          setCurrentPhase('normal');
          setCurrentVisitIndex(visitsByPhase.normal.length - 1);
          setIsNextButtonBlinking(false);
        } else {
          setNotification('最初の訪問サークル・スペースです');
        }
      } else {
        setNotification('最初の訪問サークル・スペースです');
      }
    }
  }, [currentVisitIndex, currentPhase, visitsByPhase]);

  // アイテム更新ハンドラ
  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    setLastInteractedItemId(updatedItem.id);
    onUpdateItem(updatedItem);
  }, [onUpdateItem]);

  // モード切り替え
  const handleModeChangeInternal = useCallback((mode: 'edit' | 'execute') => {
    onModeChange(mode, lastInteractedItemId || undefined);
  }, [onModeChange, lastInteractedItemId]);

  // 訪問先がない場合
  if (totalVisits === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8">
        <div className="text-6xl mb-4">📋</div>
        <h2 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-2">
          訪問先がありません
        </h2>
        <p className="text-slate-500 dark:text-slate-400 mb-6 text-center">
          実行列にアイテムを追加してください
        </p>
        <button
          onClick={() => handleModeChangeInternal('edit')}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          編集モードへ
        </button>
      </div>
    );
  }

  // 完了画面
  if (isCompleted) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8">
        <div className="text-6xl mb-4">🎉</div>
        <h2 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-2">
          全ての訪問先を確認しました
        </h2>
        <p className="text-slate-500 dark:text-slate-400 mb-6 text-center">
          お疲れ様でした！
        </p>
        <div className="flex gap-4">
          <button
            onClick={() => handleModeChangeInternal('edit')}
            className="px-6 py-3 bg-slate-600 text-white rounded-lg font-medium hover:bg-slate-700 transition-colors flex items-center gap-2"
          >
            <span>📝</span>
            <span>編集モードへ</span>
          </button>
          <button
            onClick={() => handleModeChangeInternal('execute')}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <span>🏃</span>
            <span>実行モードへ</span>
          </button>
        </div>
      </div>
    );
  }

  // 現在の訪問先情報
  const firstItem = currentVisitItems[0];
  const circleName = firstItem?.circle || '';
  const spaceInfo = firstItem ? `${firstItem.block}-${extractBaseNumber(firstItem.number).toUpperCase()}` : '';

  return (
    <div className="relative min-h-[calc(100vh-200px)]">
      {/* 通知 */}
      {notification && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse">
          {notification}
        </div>
      )}

      {/* ヘッダー情報 */}
      <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 rounded-lg mb-4 shadow-lg">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-sm opacity-80">訪問先</div>
            <div className="text-2xl font-bold">{spaceInfo}</div>
            <div className="text-lg">{circleName}</div>
          </div>
          <div className="text-right">
            <div className="text-sm opacity-80">フェーズ</div>
            <div className="text-xl font-bold">{phaseDisplayName}</div>
          </div>
        </div>
      </div>

      {/* 進捗表示 */}
      <div className="flex items-center justify-center mb-4 gap-4">
        <div className="text-center">
          <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            {phaseDisplayName}: {currentVisitIndex + 1}/{currentPhaseTotal}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400 ml-4 opacity-60">
            ({currentVisitNumber}/{totalVisits})
          </span>
        </div>
      </div>

      {/* アイテムリスト */}
      <div className="space-y-4 pb-24">
        {currentVisitItems.map((item, index) => (
          <div 
            key={item.id}
            className={`relative ${blinkingPriceItemIds.has(item.id) ? 'animate-pulse ring-2 ring-red-500 rounded-lg' : ''}`}
          >
            <ShoppingItemCard
              item={item}
              onUpdate={handleUpdateItem}
              isStriped={index % 2 === 1}
              onEditRequest={() => {}}
              onDeleteRequest={() => {}}
              isSelected={false}
              onSelectItem={() => {}}
              layoutMode={layoutMode}
            />
          </div>
        ))}
      </div>

      {/* ナビゲーションボタン */}
      {/* 戻るボタン（左側） */}
      <button
        onClick={handlePrev}
        className="fixed left-4 top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40"
        title="前の訪問先"
      >
        ◀
      </button>

      {/* 次へボタン（右側） */}
      <button
        onClick={handleNext}
        disabled={hasUndefinedPricePurchased}
        className={`fixed right-4 top-1/2 transform -translate-y-1/2 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40 ${
          hasUndefinedPricePurchased
            ? 'bg-slate-400 cursor-not-allowed'
            : isNextButtonBlinking
              ? 'bg-green-500 hover:bg-green-600 text-white animate-pulse'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
        }`}
        title="次の訪問先"
      >
        ▶
      </button>
    </div>
  );
};

export default FocusMode;
