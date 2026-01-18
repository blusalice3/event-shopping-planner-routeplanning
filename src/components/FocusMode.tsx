import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ShoppingItem, DayMapData, HallDefinition, ZoomLevel, ZOOM_LEVELS } from '../types';
import ShoppingItemCard from './ShoppingItemCard';
import FocusModeMapCanvas from './FocusModeMapCanvas';

// フェーズの定義
type FocusPhase = 'normal' | 'postponed' | 'late';

interface FocusModeProps {
  items: ShoppingItem[];
  executeModeItemIds: string[];
  onUpdateItem: (item: ShoppingItem) => void;
  onModeChange: (mode: 'edit' | 'execute', lastItemId?: string) => void;
  layoutMode: 'pc' | 'smartphone';
  onLayoutModeChange: (mode: 'pc' | 'smartphone') => void;
  // マップ関連の追加props
  mapData?: { [dayMapName: string]: DayMapData };
  hallDefinitions?: HallDefinition[];
  onHideHeader?: (hide: boolean) => void;
}

// スワイプ判定の閾値
const SWIPE_THRESHOLD = 50;

// ナンバーからベース部分（アルファベットとその左側の数値）を抽出
const extractBaseNumber = (number: string): string => {
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
  mapData,
  hallDefinitions,
  onHideHeader,
}) => {
  // 現在のフェーズ（ユーザー操作でのみ変更）
  const [currentPhase, setCurrentPhase] = useState<FocusPhase>('normal');
  // 現在のフェーズ内での訪問先インデックス
  const [currentPhaseIndex, setCurrentPhaseIndex] = useState(0);
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
  // カウントダウンインターバルID
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // 自動進行カウントダウン
  const [autoAdvanceCountdown, setAutoAdvanceCountdown] = useState<number | null>(null);
  // ナビゲーションボタンの位置オフセット
  const [navButtonOffset, setNavButtonOffset] = useState({ left: 0, right: 0 });
  // アイテムリストのref
  const itemListRef = useRef<HTMLDivElement>(null);
  // スワイプ関連のref
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const isSwipingRef = useRef(false);
  // スワイプコンテナのref
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  // 後回しフェーズで表示するアイテムID（通常フェーズ終了時に確定）
  const [postponedPhaseItemIds, setPostponedPhaseItemIds] = useState<Set<string>>(new Set());
  // 遅参フェーズで表示するアイテムID（後回しフェーズ終了時に確定）
  const [latePhaseItemIds, setLatePhaseItemIds] = useState<Set<string>>(new Set());

  // マップ表示関連の状態
  const [isMapVisible, setIsMapVisible] = useState(false);
  const [mapZoomLevel, setMapZoomLevel] = useState<ZoomLevel>(100);
  const [selectedHallId, setSelectedHallId] = useState<string | 'follow'>('follow');
  const [splitRatio, setSplitRatio] = useState(50);
  const splitDragRef = useRef<{ startY: number; startRatio: number } | null>(null);

  // マップが利用可能かどうか
  const hasMapData = useMemo(() => {
    return mapData && Object.keys(mapData).length > 0;
  }, [mapData]);

  // 実行列のアイテムを取得
  const executeItems = useMemo(() => {
    return executeModeItemIds
      .map(id => items.find(item => item.id === id))
      .filter((item): item is ShoppingItem => item !== undefined);
  }, [items, executeModeItemIds]);

  // 全訪問先リストを実行列順序で生成
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

  // 現時点で後回し状態のアイテムIDセット
  const currentPostponedItemIds = useMemo(() => {
    return new Set(executeItems.filter(item => item.purchaseStatus === 'Postpone').map(item => item.id));
  }, [executeItems]);

  // 現時点で遅参状態のアイテムIDセット
  const currentLateItemIds = useMemo(() => {
    return new Set(executeItems.filter(item => item.purchaseStatus === 'Late').map(item => item.id));
  }, [executeItems]);

  // フェーズごとの訪問先リストを計算
  const visitsByPhase = useMemo(() => {
    const normal: typeof allVisits = [];
    const postponed: typeof allVisits = [];
    const late: typeof allVisits = [];
    
    allVisits.forEach(visit => {
      normal.push(visit);
      
      if (currentPhase === 'normal') {
        const hasPostponedItems = visit.items.some(item => currentPostponedItemIds.has(item.id));
        if (hasPostponedItems) postponed.push(visit);
      } else {
        const hasPostponedItems = visit.items.some(item => postponedPhaseItemIds.has(item.id));
        if (hasPostponedItems) postponed.push(visit);
      }
      
      if (currentPhase === 'normal' || currentPhase === 'postponed') {
        const hasLateItems = visit.items.some(item => currentLateItemIds.has(item.id));
        if (hasLateItems) late.push(visit);
      } else {
        const hasLateItems = visit.items.some(item => latePhaseItemIds.has(item.id));
        if (hasLateItems) late.push(visit);
      }
    });
    
    return { normal, postponed, late };
  }, [allVisits, currentPhase, currentPostponedItemIds, currentLateItemIds, postponedPhaseItemIds, latePhaseItemIds]);

  // 現在のフェーズの訪問先リスト
  const currentPhaseVisits = useMemo(() => {
    return visitsByPhase[currentPhase];
  }, [visitsByPhase, currentPhase]);

  // 現在表示すべき訪問先
  const currentVisit = useMemo(() => {
    if (currentPhaseVisits.length === 0) return null;
    const safeIndex = Math.min(currentPhaseIndex, currentPhaseVisits.length - 1);
    return currentPhaseVisits[safeIndex] || null;
  }, [currentPhaseVisits, currentPhaseIndex]);

  // 次の訪問先
  const nextVisit = useMemo(() => {
    if (currentPhaseVisits.length === 0) return null;
    const nextIndex = currentPhaseIndex + 1;
    if (nextIndex < currentPhaseVisits.length) {
      return currentPhaseVisits[nextIndex];
    }
    if (currentPhase === 'normal' && visitsByPhase.postponed.length > 0) {
      return visitsByPhase.postponed[0];
    }
    if ((currentPhase === 'normal' || currentPhase === 'postponed') && visitsByPhase.late.length > 0) {
      return visitsByPhase.late[0];
    }
    return null;
  }, [currentPhaseVisits, currentPhaseIndex, currentPhase, visitsByPhase]);

  // 現在のフェーズで表示すべきアイテム
  const currentVisitDisplayItems = useMemo(() => {
    if (!currentVisit) return [];
    
    if (currentPhase === 'normal') {
      return currentVisit.items;
    } else if (currentPhase === 'postponed') {
      return currentVisit.items.filter(item => postponedPhaseItemIds.has(item.id));
    } else {
      return currentVisit.items.filter(item => latePhaseItemIds.has(item.id));
    }
  }, [currentVisit, currentPhase, postponedPhaseItemIds, latePhaseItemIds]);

  // フェーズ名の日本語表示
  const phaseDisplayName = useMemo(() => {
    switch (currentPhase) {
      case 'normal': return '通常';
      case 'postponed': return '後回し';
      case 'late': return '遅参';
    }
  }, [currentPhase]);

  // 総訪問先数
  const totalVisits = useMemo(() => {
    return visitsByPhase.normal.length + visitsByPhase.postponed.length + visitsByPhase.late.length;
  }, [visitsByPhase]);

  // 現在の訪問先番号
  const currentVisitNumber = useMemo(() => {
    let number = currentPhaseIndex + 1;
    if (currentPhase === 'postponed') {
      number += visitsByPhase.normal.length;
    } else if (currentPhase === 'late') {
      number += visitsByPhase.normal.length + visitsByPhase.postponed.length;
    }
    return number;
  }, [currentPhaseIndex, currentPhase, visitsByPhase]);

  // 価格未定チェック
  const hasUndefinedPricePurchased = useMemo(() => {
    return currentVisitDisplayItems.some(item => 
      item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null)
    );
  }, [currentVisitDisplayItems]);

  // 残りの合計金額
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

  // 現在の訪問先のアイテムチェック状況（非「未購入」状態のカウント）
  const currentVisitCheckedCount = useMemo(() => {
    return currentVisitDisplayItems.filter(item => item.purchaseStatus !== 'None').length;
  }, [currentVisitDisplayItems]);

  // 現在の訪問先のアイテム総数
  const currentVisitTotalCount = useMemo(() => {
    return currentVisitDisplayItems.length;
  }, [currentVisitDisplayItems]);

  // 次の訪問先情報
  const nextVisitInfo = useMemo(() => {
    if (!nextVisit) return { spaceInfo: '最終', circleName: '' };
    const item = nextVisit.items[0];
    if (!item) return { spaceInfo: '最終', circleName: '' };
    const baseNumber = extractBaseNumber(item.number);
    return {
      spaceInfo: `${item.block}-${baseNumber.toUpperCase()}`,
      circleName: item.circle || '',
    };
  }, [nextVisit]);

  // 現在のマップ名
  const currentMapName = useMemo(() => {
    if (!currentVisit || currentVisit.items.length === 0) return null;
    const eventDate = currentVisit.items[0].eventDate;
    return `${eventDate}マップ`;
  }, [currentVisit]);

  // 現在のマップデータ
  const currentMapData = useMemo(() => {
    if (!currentMapName || !mapData) return null;
    return mapData[currentMapName] || null;
  }, [currentMapName, mapData]);

  // 追随モード用ホール特定
  const followHall = useMemo(() => {
    if (!hallDefinitions || hallDefinitions.length === 0 || !currentVisit || !currentMapData) return null;
    
    const currentItem = currentVisit.items[0];
    if (!currentItem) return null;
    
    const block = currentMapData.blocks.find(b => b.name === currentItem.block);
    if (!block) return null;
    
    const numStr = currentItem.number.match(/^(\d+)/)?.[1];
    if (!numStr) return null;
    const num = parseInt(numStr, 10);
    const cell = block.numberCells.find(nc => nc.value === num);
    if (!cell) return null;
    
    for (const hall of hallDefinitions) {
      if (hall.vertices.length < 3) continue;
      
      let inside = false;
      const vertices = hall.vertices;
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i].col, yi = vertices[i].row;
        const xj = vertices[j].col, yj = vertices[j].row;
        
        if (((yi > cell.row) !== (yj > cell.row)) &&
            (cell.col < (xj - xi) * (cell.row - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      
      if (inside) return hall;
    }
    
    return null;
  }, [hallDefinitions, currentVisit, currentMapData]);

  // 選択されたホール
  const selectedHall = useMemo(() => {
    if (selectedHallId === 'follow') {
      return followHall;
    }
    return hallDefinitions?.find(h => h.id === selectedHallId) || null;
  }, [selectedHallId, followHall, hallDefinitions]);

  // タイマークリア
  const clearAutoAdvanceTimer = useCallback(() => {
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setAutoAdvanceCountdown(null);
  }, []);

  // 次へボタン点滅更新
  useEffect(() => {
    if (currentVisitDisplayItems.length === 0) return;
    
    if (hasUndefinedPricePurchased) {
      setIsNextButtonBlinking(false);
      const undefinedPriceIds = currentVisitDisplayItems
        .filter(item => item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null))
        .map(item => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
    } else {
      setBlinkingPriceItemIds(new Set());
      const hasUnprocessed = currentVisitDisplayItems.some(item => item.purchaseStatus === 'None');
      setIsNextButtonBlinking(!hasUnprocessed && currentVisitDisplayItems.length > 0);
    }
  }, [currentVisitDisplayItems, hasUndefinedPricePurchased]);

  // 通知自動消去
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // マップ表示時のヘッダー非表示
  useEffect(() => {
    if (onHideHeader) {
      onHideHeader(isMapVisible && layoutMode === 'smartphone');
    }
  }, [isMapVisible, layoutMode, onHideHeader]);

  // ナビゲーションボタン位置調整
  useEffect(() => {
    if (isMapVisible) return;
    
    const checkOverlap = () => {
      if (!itemListRef.current) return;
      
      const buttonSize = 56;
      const buttonMargin = 16;
      const viewportHeight = window.innerHeight;
      const buttonCenterY = viewportHeight / 2;
      
      const interactiveElements = itemListRef.current.querySelectorAll('button, select, [role="button"]');
      
      let leftOffset = 0;
      let rightOffset = 0;
      
      interactiveElements.forEach(element => {
        const rect = element.getBoundingClientRect();
        const buttonTop = buttonCenterY - buttonSize / 2;
        const buttonBottom = buttonCenterY + buttonSize / 2;
        const yOverlap = !(rect.bottom < buttonTop || rect.top > buttonBottom);
        
        if (yOverlap) {
          const leftButtonRight = buttonMargin + buttonSize;
          if (rect.left < leftButtonRight) {
            leftOffset = Math.max(leftOffset, leftButtonRight - rect.left + 8);
          }
          const rightButtonLeft = window.innerWidth - buttonMargin - buttonSize;
          if (rect.right > rightButtonLeft) {
            rightOffset = Math.max(rightOffset, rect.right - rightButtonLeft + 8);
          }
        }
      });
      
      setNavButtonOffset({ left: leftOffset, right: rightOffset });
    };
    
    const timer = setTimeout(checkOverlap, 100);
    window.addEventListener('resize', checkOverlap);
    
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', checkOverlap);
    };
  }, [currentVisitDisplayItems, currentPhaseIndex, currentPhase, isMapVisible]);

  // 次へ移動
  const moveToNext = useCallback(() => {
    clearAutoAdvanceTimer();
    
    const nextIndex = currentPhaseIndex + 1;
    
    if (nextIndex < currentPhaseVisits.length) {
      setCurrentPhaseIndex(nextIndex);
      setIsNextButtonBlinking(false);
    } else {
      if (currentPhase === 'normal') {
        const postponedIds = new Set(
          executeItems.filter(item => item.purchaseStatus === 'Postpone').map(item => item.id)
        );
        setPostponedPhaseItemIds(postponedIds);
        
        const lateIds = new Set(
          executeItems.filter(item => item.purchaseStatus === 'Late').map(item => item.id)
        );
        setLatePhaseItemIds(lateIds);
        
        if (postponedIds.size > 0) {
          setNotification('後回しアイテムの巡回を開始します');
          setCurrentPhase('postponed');
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else if (lateIds.size > 0) {
          setNotification('遅参アイテムの巡回を開始します');
          setCurrentPhase('late');
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else {
          setIsCompleted(true);
        }
      } else if (currentPhase === 'postponed') {
        const currentLateIds = new Set(latePhaseItemIds);
        executeItems.forEach(item => {
          if (item.purchaseStatus === 'Late') {
            currentLateIds.add(item.id);
          }
        });
        setLatePhaseItemIds(currentLateIds);
        
        if (currentLateIds.size > 0) {
          setNotification('遅参アイテムの巡回を開始します');
          setCurrentPhase('late');
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else {
          setIsCompleted(true);
        }
      } else {
        setIsCompleted(true);
      }
    }
  }, [currentPhaseIndex, currentPhaseVisits.length, currentPhase, executeItems, clearAutoAdvanceTimer, latePhaseItemIds]);

  // 自動進行開始
  const startAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current) return;
    
    setAutoAdvanceCountdown(3);
    
    countdownIntervalRef.current = setInterval(() => {
      setAutoAdvanceCountdown(prev => {
        if (prev === null || prev <= 1) return prev;
        return prev - 1;
      });
    }, 1000);
    
    autoAdvanceTimerRef.current = setTimeout(() => {
      moveToNext();
    }, 3000);
  }, [moveToNext]);

  // 次の訪問先へ
  const handleNext = useCallback(() => {
    if (hasUndefinedPricePurchased) {
      setNotification('価格未定のアイテムがあります。価格を入力してください。');
      const undefinedPriceIds = currentVisitDisplayItems
        .filter(item => item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null))
        .map(item => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
      return;
    }

    // チェック漏れの確認（未購入状態のアイテムがある場合）
    const hasUncheckedItems = currentVisitDisplayItems.some(item => item.purchaseStatus === 'None');

    clearAutoAdvanceTimer();
    moveToNext();

    // チェック漏れがある場合は通知を表示
    if (hasUncheckedItems) {
      // 少し遅延させて画面遷移後に通知を表示
      setTimeout(() => {
        setNotification('前のサークルでチェック漏れがあります');
      }, 100);
    }
  }, [hasUndefinedPricePurchased, currentVisitDisplayItems, clearAutoAdvanceTimer, moveToNext]);

  // 前の訪問先へ
  const handlePrev = useCallback(() => {
    clearAutoAdvanceTimer();
    
    if (isCompleted) {
      setIsCompleted(false);
      if (latePhaseItemIds.size > 0) {
        setCurrentPhase('late');
        setCurrentPhaseIndex(visitsByPhase.late.length - 1);
      } else if (postponedPhaseItemIds.size > 0) {
        setCurrentPhase('postponed');
        setCurrentPhaseIndex(visitsByPhase.postponed.length - 1);
      } else if (visitsByPhase.normal.length > 0) {
        setCurrentPhase('normal');
        setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
      }
      return;
    }
    
    if (currentPhaseIndex > 0) {
      setCurrentPhaseIndex(currentPhaseIndex - 1);
      setIsNextButtonBlinking(false);
    } else {
      if (currentPhase === 'postponed' && visitsByPhase.normal.length > 0) {
        setCurrentPhase('normal');
        setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
        setIsNextButtonBlinking(false);
      } else if (currentPhase === 'late') {
        if (postponedPhaseItemIds.size > 0) {
          setCurrentPhase('postponed');
          setCurrentPhaseIndex(visitsByPhase.postponed.length - 1);
          setIsNextButtonBlinking(false);
        } else if (visitsByPhase.normal.length > 0) {
          setCurrentPhase('normal');
          setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
          setIsNextButtonBlinking(false);
        } else {
          setNotification('最初の訪問サークル・スペースです');
        }
      } else {
        setNotification('最初の訪問サークル・スペースです');
      }
    }
  }, [currentPhaseIndex, currentPhase, visitsByPhase, clearAutoAdvanceTimer, isCompleted, postponedPhaseItemIds, latePhaseItemIds]);

  // アイテム更新
  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    setLastInteractedItemId(updatedItem.id);
    onUpdateItem(updatedItem);
    
    const originalItem = currentVisitDisplayItems.find(i => i.id === updatedItem.id);
    if (!originalItem) return;
    
    if (updatedItem.purchaseStatus !== 'Postpone' && updatedItem.purchaseStatus !== 'Late') {
      clearAutoAdvanceTimer();
      return;
    }
    
    if (currentPhase !== 'normal') return;
    
    const willAllBePostponedOrLate = currentVisitDisplayItems.every(item => {
      if (item.id === updatedItem.id) {
        return updatedItem.purchaseStatus === 'Postpone' || updatedItem.purchaseStatus === 'Late';
      }
      return item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late';
    });
    
    if (willAllBePostponedOrLate) {
      startAutoAdvance();
    }
  }, [onUpdateItem, currentVisitDisplayItems, clearAutoAdvanceTimer, currentPhase, startAutoAdvance]);

  // スワイプハンドラ
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (layoutMode !== 'smartphone') return;
    const touch = e.touches[0];
    touchStartXRef.current = touch.clientX;
    touchStartYRef.current = touch.clientY;
    isSwipingRef.current = false;
  }, [layoutMode]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (layoutMode !== 'smartphone' || touchStartXRef.current === null || touchStartYRef.current === null) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartXRef.current;
    const deltaY = touch.clientY - touchStartYRef.current;
    
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      isSwipingRef.current = true;
    }
  }, [layoutMode]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (layoutMode !== 'smartphone' || touchStartXRef.current === null) return;
    
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartXRef.current;
    const deltaY = touch.clientY - (touchStartYRef.current || 0);
    
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_THRESHOLD) {
      if (deltaX > 0) {
        handlePrev();
      } else {
        handleNext();
      }
    }
    
    touchStartXRef.current = null;
    touchStartYRef.current = null;
    isSwipingRef.current = false;
  }, [layoutMode, handlePrev, handleNext]);

  // 分割線ドラッグ
  const handleSplitDragStart = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    splitDragRef.current = { startY: clientY, startRatio: splitRatio };
  }, [splitRatio]);

  const handleSplitDragMove = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    if (!splitDragRef.current) return;
    
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaY = clientY - splitDragRef.current.startY;
    const containerHeight = window.innerHeight - 150;
    const deltaRatio = (deltaY / containerHeight) * 100;
    
    const newRatio = Math.max(20, Math.min(80, splitDragRef.current.startRatio + deltaRatio));
    setSplitRatio(newRatio);
  }, []);

  const handleSplitDragEnd = useCallback(() => {
    splitDragRef.current = null;
  }, []);

  // モード切替
  const handleModeChangeInternal = useCallback((mode: 'edit' | 'execute') => {
    onModeChange(mode, lastInteractedItemId || undefined);
  }, [onModeChange, lastInteractedItemId]);

  // マップ表示トグル
  const toggleMapVisibility = useCallback(() => {
    setIsMapVisible(!isMapVisible);
  }, [isMapVisible]);

  // 訪問先がない場合
  if (allVisits.length === 0) {
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
      <div 
        className="flex flex-col items-center justify-center min-h-[50vh] p-8 relative"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {layoutMode === 'pc' && (
          <button
            onClick={handlePrev}
            className="fixed left-4 top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40"
            title="前の訪問先"
          >
            ◀
          </button>
        )}
        
        {layoutMode === 'smartphone' && (
          <div className="absolute top-4 left-0 right-0 text-center text-sm text-slate-500 dark:text-slate-400">
            ← 右スワイプで前の訪問先へ戻る
          </div>
        )}
        
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

  // 自動ナビゲーション: 表示アイテムがない場合に次へ進む
  // useEffectを使って状態更新を次のレンダリングサイクルに委ねる
  const shouldNavigate = (currentVisitDisplayItems.length === 0 && currentPhaseVisits.length > 0) ||
                         (currentPhaseVisits.length === 0);
  
  useEffect(() => {
    if (isCompleted) return;
    if (!shouldNavigate) return;
    
    // 現在のフェーズに訪問先がない場合
    if (currentPhaseVisits.length === 0) {
      moveToNext();
      return;
    }
    
    // 現在のフェーズに表示するアイテムがない場合、次の訪問先を探す
    if (currentVisitDisplayItems.length === 0 && currentPhaseVisits.length > 0) {
      // 次の訪問先を探す
      for (let i = currentPhaseIndex + 1; i < currentPhaseVisits.length; i++) {
        const visit = currentPhaseVisits[i];
        let hasItems = false;
        if (currentPhase === 'normal') {
          hasItems = visit.items.length > 0;
        } else if (currentPhase === 'postponed') {
          hasItems = visit.items.some(item => postponedPhaseItemIds.has(item.id));
        } else {
          hasItems = visit.items.some(item => latePhaseItemIds.has(item.id));
        }
        if (hasItems) {
          setCurrentPhaseIndex(i);
          return;
        }
      }
      // 見つからない場合は次のフェーズへ
      moveToNext();
    }
  }, [shouldNavigate, isCompleted, currentPhaseVisits, currentVisitDisplayItems.length, currentPhaseIndex, currentPhase, postponedPhaseItemIds, latePhaseItemIds, moveToNext]);

  // ナビゲーション中はローディング表示
  if (shouldNavigate) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8">
        <div className="text-4xl mb-4">⏳</div>
        <p className="text-slate-500 dark:text-slate-400">次の訪問先を探しています...</p>
      </div>
    );
  }

  // 現在の訪問先情報
  const circleName = currentVisit?.items[0]?.circle || '';
  const spaceInfo = currentVisit?.items[0] 
    ? `${currentVisit.items[0].block}-${extractBaseNumber(currentVisit.items[0].number).toUpperCase()}` 
    : '';

  // アイテムリストコンポーネント
  const ItemList = () => (
    <div ref={itemListRef} className={`space-y-4 pb-24 ${layoutMode === 'smartphone' && isMapVisible ? 'px-2' : layoutMode === 'smartphone' ? 'mx-2' : 'mx-4'}`}>
      {currentVisitDisplayItems.map((item, index) => (
        <div 
          key={item.id}
          data-item-id={item.id}
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
  );

  // ヘッダー情報
  const Header = () => (
    <div className={`bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 rounded-lg mb-4 shadow-lg ${layoutMode === 'smartphone' && isMapVisible ? 'mx-2' : layoutMode === 'smartphone' ? 'mx-2' : 'mx-4'}`}>
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <div className="text-sm opacity-80">訪問先</div>
          <div className="text-2xl font-bold">{spaceInfo}</div>
          <div className="flex items-center gap-2">
            <span className="text-lg">{circleName}</span>
            <span className="text-sm bg-white/20 px-2 py-0.5 rounded">
              {currentVisitCheckedCount}/{currentVisitTotalCount}
            </span>
          </div>
        </div>
        <div className="text-right flex-1">
          <div className="text-sm opacity-80">フェーズ</div>
          <div className="text-xl font-bold">{phaseDisplayName}</div>
          <div className="text-sm opacity-80 mt-1">
            次: {nextVisitInfo.spaceInfo}
            {nextVisitInfo.circleName && <span className="ml-1">{nextVisitInfo.circleName}</span>}
          </div>
        </div>
      </div>
    </div>
  );

  // マップコントロール
  const MapControls = () => (
    <div className="flex items-center gap-2 p-2 bg-white/90 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700">
      <select
        value={selectedHallId}
        onChange={(e) => setSelectedHallId(e.target.value)}
        className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
      >
        <option value="follow">追随モードON</option>
        {hallDefinitions?.map(hall => (
          <option key={hall.id} value={hall.id}>{hall.name}</option>
        ))}
      </select>
      
      <select
        value={mapZoomLevel}
        onChange={(e) => setMapZoomLevel(Number(e.target.value) as ZoomLevel)}
        className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
      >
        {ZOOM_LEVELS.map(level => (
          <option key={level} value={level}>{level}%</option>
        ))}
      </select>
    </div>
  );

  // フッターの高さ（スマートフォン: 約56px、PC: 約64px）
  const FOOTER_HEIGHT_SP = 56;
  const FOOTER_HEIGHT_PC = 64;
  const HEADER_HEIGHT = 64; // ヘッダーの高さ（非表示時は0）

  // マップズーム変更ハンドラ
  const handleMapZoomChange = useCallback((newZoom: ZoomLevel) => {
    setMapZoomLevel(newZoom);
  }, []);

  // スマートフォン+マップ表示（完了状態でない場合のみ）
  if (layoutMode === 'smartphone' && isMapVisible && currentMapData && !isCompleted) {
    // ヘッダー非表示時は高さを調整
    const availableHeight = `calc(100vh - ${FOOTER_HEIGHT_SP}px)`;
    
    return (
      <div 
        className="relative flex flex-col"
        style={{ height: availableHeight }}
      >
        {notification && (
          <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse">
            {notification}
          </div>
        )}

        {autoAdvanceCountdown !== null && (
          <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg">
            {autoAdvanceCountdown}秒後に次の訪問先へ移動します...
          </div>
        )}

        <div style={{ height: `${splitRatio}%` }} className="relative flex flex-col min-h-0">
          <MapControls />
          <div className="flex-grow relative overflow-hidden">
            <FocusModeMapCanvas
              mapData={currentMapData}
              mapName={currentMapName || ''}
              items={items}
              executeModeItemIds={executeModeItemIds}
              zoomLevel={mapZoomLevel}
              selectedHall={selectedHall}
              currentVisitKey={currentVisit?.key || null}
              nextVisitKey={nextVisit?.key || null}
              currentPhase={currentPhase}
              onZoomChange={handleMapZoomChange}
            />
          </div>
        </div>

        <div
          className="h-3 bg-slate-300 dark:bg-slate-600 cursor-row-resize flex items-center justify-center touch-none flex-shrink-0"
          onTouchStart={handleSplitDragStart}
          onTouchMove={handleSplitDragMove}
          onTouchEnd={handleSplitDragEnd}
          onMouseDown={handleSplitDragStart}
          onMouseMove={handleSplitDragMove}
          onMouseUp={handleSplitDragEnd}
          onMouseLeave={handleSplitDragEnd}
        >
          <div className="w-12 h-1 bg-slate-500 dark:bg-slate-400 rounded-full"></div>
        </div>

        {/* スワイプ判定は分割線より下のアイテム表示エリアのみ */}
        <div 
          style={{ height: `${100 - splitRatio}%` }} 
          className="overflow-y-auto min-h-0"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <Header />
          <ItemList />
        </div>

        <div className="fixed bottom-0 left-0 right-0 bg-white/90 dark:bg-slate-800/90 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
          <div className="px-4 py-2">
            <div className="flex justify-between items-center">
              <div className="text-slate-700 dark:text-slate-300">
                <span className="font-bold text-lg text-indigo-600 dark:text-indigo-400">
                  {phaseDisplayName}: {currentPhaseIndex + 1}/{currentPhaseVisits.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-sm text-slate-700 dark:text-slate-300">
                  <span className="font-semibold">{purchasedCount}</span>/{executeItems.length}
                </div>
                <div className="text-sm">
                  <span className="font-bold text-blue-600 dark:text-blue-400">
                    ¥{remainingCost.toLocaleString()}
                  </span>
                </div>
                <button
                  onClick={toggleMapVisibility}
                  className="p-2 rounded-md bg-blue-600 text-white"
                  title="マップを非表示"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                  </svg>
                </button>
                <button
                  onClick={() => onLayoutModeChange('pc')}
                  className="p-2 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                  title="タブレット/PCモードに切替"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // PC+マップ表示（完了状態でない場合のみ）
  if (layoutMode === 'pc' && isMapVisible && currentMapData && !isCompleted) {
    // ヘッダー64px + フッター64px = 128px
    const availableHeight = `calc(100vh - ${HEADER_HEIGHT + FOOTER_HEIGHT_PC}px)`;
    
    return (
      <div className="relative flex" style={{ height: availableHeight }}>
        {notification && (
          <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse">
            {notification}
          </div>
        )}

        {autoAdvanceCountdown !== null && (
          <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg">
            {autoAdvanceCountdown}秒後に次の訪問先へ移動します...
          </div>
        )}

        <div className="w-1/2 flex flex-col border-r border-slate-200 dark:border-slate-700">
          <MapControls />
          <div className="flex-grow relative overflow-hidden">
            <FocusModeMapCanvas
              mapData={currentMapData}
              mapName={currentMapName || ''}
              items={items}
              executeModeItemIds={executeModeItemIds}
              zoomLevel={mapZoomLevel}
              selectedHall={selectedHall}
              currentVisitKey={currentVisit?.key || null}
              nextVisitKey={nextVisit?.key || null}
              currentPhase={currentPhase}
              onZoomChange={handleMapZoomChange}
            />
          </div>
        </div>

        <div className="w-1/2 flex flex-col overflow-y-auto pb-20">
          <Header />
          <ItemList />
        </div>

        <button
          onClick={handlePrev}
          className="fixed right-[calc(50%+16px)] top-1/2 transform -translate-y-1/2 w-12 h-12 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-xl z-40"
          title="前の訪問先"
        >
          ◀
        </button>

        <button
          onClick={handleNext}
          className={`fixed right-4 top-1/2 transform -translate-y-1/2 w-12 h-12 rounded-full shadow-lg flex items-center justify-center text-xl z-40 ${
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

        <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
            <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
              <div className="text-slate-700 dark:text-slate-300">
                <span className="font-bold text-xl text-indigo-600 dark:text-indigo-400">
                  {phaseDisplayName}: {currentPhaseIndex + 1}/{currentPhaseVisits.length}
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
                  onClick={toggleMapVisibility}
                  className="p-2 rounded-md bg-blue-600 text-white"
                  title="マップを非表示"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                  </svg>
                </button>
                <button
                  onClick={() => onLayoutModeChange('smartphone')}
                  className="p-2 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                  title="スマートフォンモードに切替"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 従来レイアウト
  return (
    <div 
      ref={swipeContainerRef}
      className="relative min-h-[calc(100vh-200px)] pb-20"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {notification && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse">
          {notification}
        </div>
      )}

      {autoAdvanceCountdown !== null && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg">
          {autoAdvanceCountdown}秒後に次の訪問先へ移動します...
        </div>
      )}

      <div className={`bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 rounded-lg mb-4 shadow-lg ${layoutMode === 'smartphone' ? 'mx-2' : 'mx-16'}`}>
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="text-sm opacity-80">訪問先</div>
            <div className="text-2xl font-bold">{spaceInfo}</div>
            <div className="flex items-center gap-2">
              <span className="text-lg">{circleName}</span>
              <span className="text-sm bg-white/20 px-2 py-0.5 rounded">
                {currentVisitCheckedCount}/{currentVisitTotalCount}
              </span>
            </div>
          </div>
          <div className="text-right flex-1">
            <div className="text-sm opacity-80">フェーズ</div>
            <div className="text-xl font-bold">{phaseDisplayName}</div>
            <div className="text-sm opacity-80 mt-1">
              次: {nextVisitInfo.spaceInfo}
              {nextVisitInfo.circleName && <span className="ml-1">{nextVisitInfo.circleName}</span>}
            </div>
          </div>
        </div>
      </div>

      <div ref={itemListRef} className={`space-y-4 pb-24 ${layoutMode === 'smartphone' ? 'mx-2' : 'mx-16'}`}>
        {currentVisitDisplayItems.map((item, index) => (
          <div 
            key={item.id}
            data-item-id={item.id}
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

      {layoutMode === 'pc' && (
        <>
          <button
            onClick={handlePrev}
            style={{ 
              left: `${16 + navButtonOffset.left}px`,
              transition: 'left 0.2s ease-out'
            }}
            className="fixed top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl z-40"
            title="前の訪問先"
          >
            ◀
          </button>

          <button
            onClick={handleNext}
            style={{ 
              right: `${16 + navButtonOffset.right}px`,
              transition: 'right 0.2s ease-out'
            }}
            className={`fixed top-1/2 transform -translate-y-1/2 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-2xl z-40 ${
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
        </>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
            <div className="text-slate-700 dark:text-slate-300">
              <span className="font-bold text-xl text-indigo-600 dark:text-indigo-400">
                {phaseDisplayName}: {currentPhaseIndex + 1}/{currentPhaseVisits.length}
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
                onClick={toggleMapVisibility}
                disabled={!hasMapData}
                className={`p-2 rounded-md transition-colors ${
                  isMapVisible
                    ? 'bg-blue-600 text-white'
                    : hasMapData
                      ? 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                }`}
                title={hasMapData ? (isMapVisible ? 'マップを非表示' : 'マップを表示') : 'マップデータがありません'}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
              </button>
              <button
                onClick={() => onLayoutModeChange(layoutMode === 'pc' ? 'smartphone' : 'pc')}
                className={`p-2 rounded-md transition-colors ${
                  layoutMode === 'smartphone'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                }`}
                title={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
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
