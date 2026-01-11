import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
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
  onLayoutModeChange: (mode: 'pc' | 'smartphone') => void;
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
  onLayoutModeChange,
}) => {
  // 現在のフェーズ
  const [currentPhase, setCurrentPhase] = useState<FocusPhase>('normal');
  // 現在の訪問先インデックス（全訪問先での通算インデックス）
  const [currentGlobalIndex, setCurrentGlobalIndex] = useState(0);
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
  // 自動進行タイマーID
  const autoAdvanceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // 自動進行カウントダウン
  const [autoAdvanceCountdown, setAutoAdvanceCountdown] = useState<number | null>(null);

  // 実行列のアイテムを取得
  const executeItems = useMemo(() => {
    return executeModeItemIds
      .map(id => items.find(item => item.id === id))
      .filter((item): item is ShoppingItem => item !== undefined);
  }, [items, executeModeItemIds]);

  // 全訪問先リストを実行列順序で生成（フェーズ関係なく全て含む）
  const allVisits = useMemo(() => {
    const visitKeyOrder: string[] = [];
    const visitMap = new Map<string, ShoppingItem[]>();
    
    executeItems.forEach(item => {
      const key = getVisitKey(item);
      if (!visitMap.has(key)) {
        visitMap.set(key, []);
        visitKeyOrder.push(key);
      }
      visitMap.get(key)!.push(item);
    });
    
    return visitKeyOrder.map(key => ({
      key,
      items: visitMap.get(key)!,
    }));
  }, [executeItems]);

  // フェーズごとの訪問先リストを計算（現在のアイテム状態に基づく）
  const visitsByPhase = useMemo(() => {
    const normal: typeof allVisits = [];
    const postponed: typeof allVisits = [];
    const late: typeof allVisits = [];
    
    allVisits.forEach(visit => {
      // 通常フェーズに属するアイテムがあるか
      const hasNormalItems = visit.items.some(item => 
        item.purchaseStatus !== 'Postpone' && item.purchaseStatus !== 'Late'
      );
      // 後回しフェーズに属するアイテムがあるか
      const hasPostponedItems = visit.items.some(item => item.purchaseStatus === 'Postpone');
      // 遅参フェーズに属するアイテムがあるか
      const hasLateItems = visit.items.some(item => item.purchaseStatus === 'Late');
      
      if (hasNormalItems) normal.push(visit);
      if (hasPostponedItems) postponed.push(visit);
      if (hasLateItems) late.push(visit);
    });
    
    return { normal, postponed, late };
  }, [allVisits]);

  // 現在表示すべき訪問先とアイテム
  const currentVisit = useMemo(() => {
    if (allVisits.length === 0 || currentGlobalIndex >= allVisits.length) {
      return null;
    }
    return allVisits[currentGlobalIndex];
  }, [allVisits, currentGlobalIndex]);

  // 現在のフェーズを更新
  useEffect(() => {
    if (!currentVisit) return;
    
    const hasNormalItems = currentVisit.items.some(item => 
      item.purchaseStatus !== 'Postpone' && item.purchaseStatus !== 'Late'
    );
    const hasPostponedItems = currentVisit.items.some(item => item.purchaseStatus === 'Postpone');
    const hasLateItems = currentVisit.items.some(item => item.purchaseStatus === 'Late');
    
    if (hasNormalItems) {
      setCurrentPhase('normal');
    } else if (hasPostponedItems) {
      setCurrentPhase('postponed');
    } else if (hasLateItems) {
      setCurrentPhase('late');
    }
  }, [currentVisit]);

  // 総訪問先数
  const totalVisits = allVisits.length;

  // 現在の訪問先番号
  const currentVisitNumber = currentGlobalIndex + 1;

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
    return visitsByPhase[currentPhase].length;
  }, [visitsByPhase, currentPhase]);

  // 現在のフェーズ内でのインデックス
  const currentPhaseIndex = useMemo(() => {
    if (!currentVisit) return 0;
    const phaseVisits = visitsByPhase[currentPhase];
    const idx = phaseVisits.findIndex(v => v.key === currentVisit.key);
    return idx >= 0 ? idx : 0;
  }, [currentVisit, visitsByPhase, currentPhase]);

  // 価格未定かつ購入済みのアイテムをチェック
  const hasUndefinedPricePurchased = useMemo(() => {
    if (!currentVisit) return false;
    return currentVisit.items.some(item => 
      item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null)
    );
  }, [currentVisit]);

  // 全アイテムが後回しまたは遅参かどうか
  const allPostponedOrLate = useMemo(() => {
    if (!currentVisit) return false;
    return currentVisit.items.every(item => 
      item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late'
    );
  }, [currentVisit]);

  // 残りの合計金額を計算
  const remainingCost = useMemo(() => {
    return executeItems.reduce((sum, item) => {
      const isPurchasable = item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late';
      if (!isPurchasable) return sum;
      const price = item.price && item.price > 0 ? item.price : 0;
      return sum + (price * item.quantity);
    }, 0);
  }, [executeItems]);

  // 購入済み件数
  const purchasedCount = useMemo(() => {
    return executeItems.filter(item => item.purchaseStatus === 'Purchased').length;
  }, [executeItems]);

  // 次へボタンの点滅を更新
  useEffect(() => {
    if (!currentVisit) return;
    
    if (hasUndefinedPricePurchased) {
      setIsNextButtonBlinking(false);
      // 価格未定のアイテムを点滅
      const undefinedPriceIds = currentVisit.items
        .filter(item => item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null))
        .map(item => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
    } else {
      setBlinkingPriceItemIds(new Set());
      // 全アイテムの購入状態が変更されたら点滅開始
      const hasUnprocessed = currentVisit.items.some(item => item.purchaseStatus === 'None');
      setIsNextButtonBlinking(!hasUnprocessed && currentVisit.items.length > 0);
    }
  }, [currentVisit, hasUndefinedPricePurchased]);

  // 全アイテムが後回し/遅参になったら3秒後に自動進行
  useEffect(() => {
    if (allPostponedOrLate && currentVisit && currentGlobalIndex < allVisits.length - 1) {
      // カウントダウン開始
      setAutoAdvanceCountdown(3);
      
      const countdownInterval = setInterval(() => {
        setAutoAdvanceCountdown(prev => {
          if (prev === null || prev <= 1) {
            clearInterval(countdownInterval);
            return null;
          }
          return prev - 1;
        });
      }, 1000);
      
      autoAdvanceTimerRef.current = setTimeout(() => {
        setCurrentGlobalIndex(prev => prev + 1);
        setAutoAdvanceCountdown(null);
      }, 3000);
      
      return () => {
        if (autoAdvanceTimerRef.current) {
          clearTimeout(autoAdvanceTimerRef.current);
          autoAdvanceTimerRef.current = null;
        }
        clearInterval(countdownInterval);
        setAutoAdvanceCountdown(null);
      };
    } else {
      // 後回し/遅参でなくなった場合、タイマーをクリア
      if (autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
      setAutoAdvanceCountdown(null);
    }
  }, [allPostponedOrLate, currentVisit, currentGlobalIndex, allVisits.length]);

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
      // 価格未定アイテムを点滅
      if (currentVisit) {
        const undefinedPriceIds = currentVisit.items
          .filter(item => item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null))
          .map(item => item.id);
        setBlinkingPriceItemIds(new Set(undefinedPriceIds));
      }
      return;
    }

    if (currentGlobalIndex < allVisits.length - 1) {
      // 次の訪問先へ
      const nextIndex = currentGlobalIndex + 1;
      setCurrentGlobalIndex(nextIndex);
      setIsNextButtonBlinking(false);
      
      // フェーズ切り替え通知
      const nextVisit = allVisits[nextIndex];
      if (nextVisit) {
        const hasNormalItems = nextVisit.items.some(item => 
          item.purchaseStatus !== 'Postpone' && item.purchaseStatus !== 'Late'
        );
        const hasPostponedItems = nextVisit.items.some(item => item.purchaseStatus === 'Postpone');
        
        // 通常→後回しへの切り替え
        if (currentPhase === 'normal' && !hasNormalItems && hasPostponedItems) {
          setNotification('後回しアイテムの巡回を開始します');
        }
        // 後回し→遅参への切り替え
        else if (currentPhase === 'postponed' && !hasNormalItems && !hasPostponedItems) {
          setNotification('遅参アイテムの巡回を開始します');
        }
      }
    } else {
      // 全て完了
      setIsCompleted(true);
    }
  }, [currentGlobalIndex, allVisits, hasUndefinedPricePurchased, currentVisit, currentPhase]);

  // 前の訪問先へ
  const handlePrev = useCallback(() => {
    if (currentGlobalIndex > 0) {
      setCurrentGlobalIndex(currentGlobalIndex - 1);
      setIsNextButtonBlinking(false);
    } else {
      setNotification('最初の訪問サークル・スペースです');
    }
  }, [currentGlobalIndex]);

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
  const circleName = currentVisit?.items[0]?.circle || '';
  const spaceInfo = currentVisit?.items[0] 
    ? `${currentVisit.items[0].block}-${extractBaseNumber(currentVisit.items[0].number).toUpperCase()}` 
    : '';

  return (
    <div className="relative min-h-[calc(100vh-200px)] pb-20">
      {/* 通知 */}
      {notification && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse">
          {notification}
        </div>
      )}

      {/* 自動進行カウントダウン */}
      {autoAdvanceCountdown !== null && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg">
          {autoAdvanceCountdown}秒後に次の訪問先へ移動します...
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

      {/* アイテムリスト */}
      <div className="space-y-4 pb-24">
        {currentVisit?.items.map((item, index) => (
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
        className={`fixed right-4 top-1/2 transform -translate-y-1/2 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40 ${
          hasUndefinedPricePurchased
            ? 'bg-red-500 hover:bg-red-600 text-white'
            : isNextButtonBlinking
              ? 'bg-green-500 hover:bg-green-600 text-white animate-pulse'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
        }`}
        title="次の訪問先"
      >
        ▶
      </button>

      {/* フッター（SummaryBarと同じデザイン） */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
            <div className="text-slate-700 dark:text-slate-300">
              <span className="font-bold text-xl text-indigo-600 dark:text-indigo-400">
                {phaseDisplayName}: {currentPhaseIndex + 1}/{currentPhaseTotal}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400 ml-3 opacity-60">
                ({currentVisitNumber}/{totalVisits})
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-slate-700 dark:text-slate-300">
                <span className="font-semibold">{purchasedCount}</span> / {executeItems.length} 件購入済み
              </div>
              <div>
                <span className="text-sm text-slate-500 dark:text-slate-400">残りの合計: </span>
                <span className="font-bold text-xl text-blue-600 dark:text-blue-400">
                  ¥{remainingCost.toLocaleString()}
                </span>
              </div>
              <button
                onClick={() => onLayoutModeChange(layoutMode === 'pc' ? 'smartphone' : 'pc')}
                className={`p-2 rounded-md transition-colors ${
                  layoutMode === 'smartphone'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                }`}
                title={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
                aria-label={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
              >
                {layoutMode === 'smartphone' ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FocusMode;
