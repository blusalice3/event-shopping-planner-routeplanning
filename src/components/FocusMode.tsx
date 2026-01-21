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
  // 新規アイテム追加
  onAddItem?: (item: Omit<ShoppingItem, 'id' | 'purchaseStatus'>) => void;
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
  onAddItem,
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

  // フェーズ切り替え確認ダイアログの状態
  const [phaseChangeDialog, setPhaseChangeDialog] = useState<{
    isOpen: boolean;
    targetPhase: FocusPhase | null;
    hasSavedIndex: boolean;
    savedIndex: number;
  }>({ isOpen: false, targetPhase: null, hasSavedIndex: false, savedIndex: 0 });

  // 各フェーズで最後に表示していたインデックスを記憶
  const [savedPhaseIndices, setSavedPhaseIndices] = useState<Record<FocusPhase, number>>({
    normal: 0,
    postponed: 0,
    late: 0,
  });

  // マップ表示関連の状態
  const [isMapVisible, setIsMapVisible] = useState(false);
  const [mapZoomLevel, setMapZoomLevel] = useState<ZoomLevel>(100);
  const [selectedHallId, setSelectedHallId] = useState<string | 'follow'>('follow');
  const [splitRatio, setSplitRatio] = useState(50);
  const splitDragRef = useRef<{ startY: number; startRatio: number } | null>(null);

  // セルクリックポップアップの状態
  const [cellPopupState, setCellPopupState] = useState<{
    isOpen: boolean;
    blockName: string;
    number: number;
    items: ShoppingItem[];
  }>({ isOpen: false, blockName: '', number: 0, items: [] });

  // アイテム追加ダイアログの状態
  const [addItemDialog, setAddItemDialog] = useState<{
    isOpen: boolean;
    eventDate: string;
    block: string;
    number: string;
  }>({ isOpen: false, eventDate: '', block: '', number: '' });

  // 新規アイテム追加フォームの状態
  const [newItemForm, setNewItemForm] = useState({
    circle: '',
    title: '',
    price: '',
    quantity: '1',
    remarks: '',
    url: '',
  });

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

  // 現時点で後回し状態のアイテムIDセット（通常フェーズ中に動的に更新）
  const currentPostponedItemIds = useMemo(() => {
    return new Set(executeItems.filter(item => item.purchaseStatus === 'Postpone').map(item => item.id));
  }, [executeItems]);

  // 現時点で遅参状態のアイテムIDセット（通常・後回しフェーズ中に動的に更新）
  const currentLateItemIds = useMemo(() => {
    return new Set(executeItems.filter(item => item.purchaseStatus === 'Late').map(item => item.id));
  }, [executeItems]);

  // フェーズごとの訪問先リストを計算
  const visitsByPhase = useMemo(() => {
    const normal: typeof allVisits = [];
    const postponed: typeof allVisits = [];
    const late: typeof allVisits = [];
    
    allVisits.forEach(visit => {
      // 通常フェーズ: 全ての訪問先を含む（網羅的）
      normal.push(visit);
      
      // 後回しフェーズ: 記憶されたアイテムIDがある訪問先
      if (currentPhase === 'normal') {
        // 通常フェーズ中は現時点の後回しアイテムで判定
        const hasPostponedItems = visit.items.some(item => currentPostponedItemIds.has(item.id));
        if (hasPostponedItems) postponed.push(visit);
      } else {
        // 後回し/遅参フェーズでは記憶されたIDで判定
        const hasPostponedItems = visit.items.some(item => postponedPhaseItemIds.has(item.id));
        if (hasPostponedItems) postponed.push(visit);
      }
      
      // 遅参フェーズ: 記憶されたアイテムIDがある訪問先
      if (currentPhase === 'normal' || currentPhase === 'postponed') {
        // 通常/後回しフェーズ中は現時点の遅参アイテムで判定
        const hasLateItems = visit.items.some(item => currentLateItemIds.has(item.id));
        if (hasLateItems) late.push(visit);
      } else {
        // 遅参フェーズでは記憶されたIDで判定
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
      // 通常フェーズ: 全アイテムを表示
      return currentVisit.items;
    } else if (currentPhase === 'postponed') {
      // 後回しフェーズ: 記憶された後回しアイテムIDに含まれるアイテムを表示
      return currentVisit.items.filter(item => postponedPhaseItemIds.has(item.id));
    } else {
      // 遅参フェーズ: 記憶された遅参アイテムIDに含まれるアイテムを表示
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

  // 総訪問先数（全フェーズ合計）
  const totalVisits = useMemo(() => {
    return visitsByPhase.normal.length + visitsByPhase.postponed.length + visitsByPhase.late.length;
  }, [visitsByPhase]);

  // 現在の訪問先番号（全フェーズ通算）
  const currentVisitNumber = useMemo(() => {
    let number = currentPhaseIndex + 1;
    if (currentPhase === 'postponed') {
      number += visitsByPhase.normal.length;
    } else if (currentPhase === 'late') {
      number += visitsByPhase.normal.length + visitsByPhase.postponed.length;
    }
    return number;
  }, [currentPhaseIndex, currentPhase, visitsByPhase]);

  // 価格未定かつ購入済みのアイテムをチェック
  const hasUndefinedPricePurchased = useMemo(() => {
    return currentVisitDisplayItems.some(item => 
      item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null)
    );
  }, [currentVisitDisplayItems]);

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

  // 現在の訪問先のアイテムチェック状況
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

  // 現在のインデックスを保存
  useEffect(() => {
    setSavedPhaseIndices(prev => ({
      ...prev,
      [currentPhase]: currentPhaseIndex,
    }));
  }, [currentPhase, currentPhaseIndex]);

  // タイマーをクリアする関数（フェーズ切り替えでも使用するので先に定義）
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

  // フェーズ切り替えダイアログを開く
  const handlePhaseChangeRequest = useCallback((targetPhase: FocusPhase) => {
    if (targetPhase === currentPhase) return;
    
    // 対象フェーズの訪問先が存在するか確認
    const targetVisits = visitsByPhase[targetPhase];
    if (targetVisits.length === 0) {
      setNotification(`${targetPhase === 'normal' ? '通常' : targetPhase === 'postponed' ? '後回し' : '遅参'}フェーズに該当するアイテムがありません`);
      return;
    }
    
    // 保存されたインデックスがあるかチェック
    const savedIndex = savedPhaseIndices[targetPhase];
    const hasSavedIndex = savedIndex > 0 && savedIndex < targetVisits.length;
    
    setPhaseChangeDialog({
      isOpen: true,
      targetPhase,
      hasSavedIndex,
      savedIndex: hasSavedIndex ? savedIndex : 0,
    });
  }, [currentPhase, visitsByPhase, savedPhaseIndices]);

  // フェーズ切り替え実行（最初から開始）
  const executePhaseChangeFromStart = useCallback(() => {
    const { targetPhase } = phaseChangeDialog;
    if (!targetPhase) return;
    
    // 現在のフェーズのインデックスを保存
    setSavedPhaseIndices(prev => ({
      ...prev,
      [currentPhase]: currentPhaseIndex,
    }));
    
    // フェーズ切り替え前に必要なデータを準備
    if (currentPhase === 'normal' && (targetPhase === 'postponed' || targetPhase === 'late')) {
      // 通常フェーズから後回し/遅参へ：現在の後回し/遅参アイテムを記憶
      const postponedIds = new Set(
        executeItems.filter(item => item.purchaseStatus === 'Postpone').map(item => item.id)
      );
      setPostponedPhaseItemIds(postponedIds);
      
      const lateIds = new Set(
        executeItems.filter(item => item.purchaseStatus === 'Late').map(item => item.id)
      );
      setLatePhaseItemIds(lateIds);
    } else if (currentPhase === 'postponed' && targetPhase === 'late') {
      // 後回しフェーズから遅参へ：遅参アイテムを更新
      const currentLateIds = new Set(latePhaseItemIds);
      executeItems.forEach(item => {
        if (item.purchaseStatus === 'Late') {
          currentLateIds.add(item.id);
        }
      });
      setLatePhaseItemIds(currentLateIds);
    }
    
    setCurrentPhase(targetPhase);
    setCurrentPhaseIndex(0);
    setIsNextButtonBlinking(false);
    setIsCompleted(false);
    clearAutoAdvanceTimer();
    
    const phaseName = targetPhase === 'normal' ? '通常' : targetPhase === 'postponed' ? '後回し' : '遅参';
    setNotification(`${phaseName}フェーズを最初から開始します`);
    
    setPhaseChangeDialog({ isOpen: false, targetPhase: null, hasSavedIndex: false, savedIndex: 0 });
  }, [phaseChangeDialog, currentPhase, currentPhaseIndex, executeItems, latePhaseItemIds, clearAutoAdvanceTimer]);

  // フェーズ切り替え実行（途中から再開）
  const executePhaseChangeFromSaved = useCallback(() => {
    const { targetPhase, savedIndex } = phaseChangeDialog;
    if (!targetPhase) return;
    
    // 現在のフェーズのインデックスを保存
    setSavedPhaseIndices(prev => ({
      ...prev,
      [currentPhase]: currentPhaseIndex,
    }));
    
    // フェーズ切り替え前に必要なデータを準備
    if (currentPhase === 'normal' && (targetPhase === 'postponed' || targetPhase === 'late')) {
      const postponedIds = new Set(
        executeItems.filter(item => item.purchaseStatus === 'Postpone').map(item => item.id)
      );
      setPostponedPhaseItemIds(postponedIds);
      
      const lateIds = new Set(
        executeItems.filter(item => item.purchaseStatus === 'Late').map(item => item.id)
      );
      setLatePhaseItemIds(lateIds);
    } else if (currentPhase === 'postponed' && targetPhase === 'late') {
      const currentLateIds = new Set(latePhaseItemIds);
      executeItems.forEach(item => {
        if (item.purchaseStatus === 'Late') {
          currentLateIds.add(item.id);
        }
      });
      setLatePhaseItemIds(currentLateIds);
    }
    
    setCurrentPhase(targetPhase);
    setCurrentPhaseIndex(savedIndex);
    setIsNextButtonBlinking(false);
    setIsCompleted(false);
    clearAutoAdvanceTimer();
    
    const phaseName = targetPhase === 'normal' ? '通常' : targetPhase === 'postponed' ? '後回し' : '遅参';
    setNotification(`${phaseName}フェーズを途中から再開します`);
    
    setPhaseChangeDialog({ isOpen: false, targetPhase: null, hasSavedIndex: false, savedIndex: 0 });
  }, [phaseChangeDialog, currentPhase, currentPhaseIndex, executeItems, latePhaseItemIds, clearAutoAdvanceTimer]);

  // フェーズ切り替えダイアログをキャンセル
  const cancelPhaseChange = useCallback(() => {
    setPhaseChangeDialog({ isOpen: false, targetPhase: null, hasSavedIndex: false, savedIndex: 0 });
  }, []);

  // 次へボタンの点滅を更新
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

  // 通知を自動で消す
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

  // ナビゲーションボタンの位置を調整
  useEffect(() => {
    const checkOverlap = () => {
      if (!itemListRef.current) return;
      
      const buttonSize = 56; // w-14 = 56px
      const buttonMargin = 16; // left-4/right-4 = 16px
      const viewportHeight = window.innerHeight;
      const buttonCenterY = viewportHeight / 2;
      
      // アイテムカード内の操作部分（ボタンやドロップダウン）の位置を取得
      const interactiveElements = itemListRef.current.querySelectorAll('button, select, [role="button"]');
      
      let leftOffset = 0;
      let rightOffset = 0;
      
      interactiveElements.forEach(element => {
        const rect = element.getBoundingClientRect();
        
        // ボタンの上下範囲
        const buttonTop = buttonCenterY - buttonSize / 2;
        const buttonBottom = buttonCenterY + buttonSize / 2;
        
        // Y軸で重なっているか
        const yOverlap = !(rect.bottom < buttonTop || rect.top > buttonBottom);
        
        if (yOverlap) {
          // 左ボタンとの重なりチェック
          const leftButtonRight = buttonMargin + buttonSize;
          if (rect.left < leftButtonRight) {
            leftOffset = Math.max(leftOffset, leftButtonRight - rect.left + 8);
          }
          
          // 右ボタンとの重なりチェック
          const rightButtonLeft = window.innerWidth - buttonMargin - buttonSize;
          if (rect.right > rightButtonLeft) {
            rightOffset = Math.max(rightOffset, rect.right - rightButtonLeft + 8);
          }
        }
      });
      
      setNavButtonOffset({ left: leftOffset, right: rightOffset });
    };
    
    // 初回チェックと再チェック
    const timer = setTimeout(checkOverlap, 100);
    window.addEventListener('resize', checkOverlap);
    
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', checkOverlap);
    };
  }, [currentVisitDisplayItems, currentPhaseIndex, currentPhase]);

  // 次のフェーズまたは訪問先へ移動する関数
  const moveToNext = useCallback(() => {
    clearAutoAdvanceTimer();
    
    const nextIndex = currentPhaseIndex + 1;
    
    if (nextIndex < currentPhaseVisits.length) {
      // 同じフェーズ内で次へ
      setCurrentPhaseIndex(nextIndex);
      setIsNextButtonBlinking(false);
    } else {
      // フェーズの終わり - 次のフェーズへ
      if (currentPhase === 'normal') {
        // 通常フェーズ終了 → 後回しアイテムIDを記憶
        const postponedIds = new Set(
          executeItems.filter(item => item.purchaseStatus === 'Postpone').map(item => item.id)
        );
        setPostponedPhaseItemIds(postponedIds);
        
        // 遅参アイテムIDも更新（通常フェーズで遅参にしたもの）
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
        // 後回しフェーズ終了 → 遅参アイテムIDを更新（後回しフェーズで遅参にしたものを追加）
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

  // 自動進行を開始する関数（ユーザー操作からのみ呼び出す）
  const startAutoAdvance = useCallback(() => {
    // 既にタイマーが動いている場合は何もしない
    if (autoAdvanceTimerRef.current) return;
    
    // カウントダウン開始
    setAutoAdvanceCountdown(3);
    
    countdownIntervalRef.current = setInterval(() => {
      setAutoAdvanceCountdown(prev => {
        if (prev === null || prev <= 1) {
          return prev;
        }
        return prev - 1;
      });
    }, 1000);
    
    autoAdvanceTimerRef.current = setTimeout(() => {
      moveToNext();
    }, 3000);
  }, [moveToNext]);

  // 次の訪問先へ（手動）
  const handleNext = useCallback(() => {
    // 価格未定チェック
    if (hasUndefinedPricePurchased) {
      setNotification('価格未定のアイテムがあります。価格を入力してください。');
      const undefinedPriceIds = currentVisitDisplayItems
        .filter(item => item.purchaseStatus === 'Purchased' && (item.price === -1 || item.price === null))
        .map(item => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
      return;
    }

    // チェック漏れの確認
    const hasUncheckedItems = currentVisitDisplayItems.some(item => item.purchaseStatus === 'None');

    clearAutoAdvanceTimer();
    moveToNext();

    // チェック漏れがある場合は通知を表示
    if (hasUncheckedItems) {
      setTimeout(() => {
        setNotification('前のサークルでチェック漏れがあります');
      }, 100);
    }
  }, [hasUndefinedPricePurchased, currentVisitDisplayItems, clearAutoAdvanceTimer, moveToNext]);

  // 前の訪問先へ
  const handlePrev = useCallback(() => {
    clearAutoAdvanceTimer();
    
    // 完了画面から戻る場合
    if (isCompleted) {
      setIsCompleted(false);
      // 最後のフェーズの最後の訪問先に戻る
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
      // フェーズの最初 - 前のフェーズへ
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

  // アイテム更新ハンドラ
  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    setLastInteractedItemId(updatedItem.id);
    
    // まずアイテムを更新
    onUpdateItem(updatedItem);
    
    // 購入状態が変更されたかチェック
    const originalItem = currentVisitDisplayItems.find(i => i.id === updatedItem.id);
    if (!originalItem) return;
    
    // 後回し/遅参以外に変更された場合、タイマーをクリア
    if (updatedItem.purchaseStatus !== 'Postpone' && updatedItem.purchaseStatus !== 'Late') {
      clearAutoAdvanceTimer();
      return;
    }
    
    // 通常フェーズでのみ自動進行をチェック
    if (currentPhase !== 'normal') return;
    
    // 更新後の状態で全アイテムが後回し/遅参かチェック
    const willAllBePostponedOrLate = currentVisitDisplayItems.every(item => {
      if (item.id === updatedItem.id) {
        return updatedItem.purchaseStatus === 'Postpone' || updatedItem.purchaseStatus === 'Late';
      }
      return item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late';
    });
    
    if (willAllBePostponedOrLate) {
      // 3秒後に自動進行を開始
      startAutoAdvance();
    }
  }, [onUpdateItem, currentVisitDisplayItems, clearAutoAdvanceTimer, currentPhase, startAutoAdvance]);

  // スワイプハンドラ（スマートフォンモード用）
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
    
    // 水平方向の移動が垂直方向より大きい場合のみスワイプとして処理
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      isSwipingRef.current = true;
    }
  }, [layoutMode]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (layoutMode !== 'smartphone' || touchStartXRef.current === null) return;
    
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartXRef.current;
    const deltaY = touch.clientY - (touchStartYRef.current || 0);
    
    // 水平方向の移動が垂直方向より大きく、閾値を超えた場合のみ処理
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_THRESHOLD) {
      if (deltaX > 0) {
        // 右スワイプ → 前へ
        handlePrev();
      } else {
        // 左スワイプ → 次へ
        handleNext();
      }
    }
    
    touchStartXRef.current = null;
    touchStartYRef.current = null;
    isSwipingRef.current = false;
  }, [layoutMode, handlePrev, handleNext]);

  // モード切り替え
  const handleModeChangeInternal = useCallback((mode: 'edit' | 'execute') => {
    onModeChange(mode, lastInteractedItemId || undefined);
  }, [onModeChange, lastInteractedItemId]);

  // マップ表示トグル
  const toggleMapVisibility = useCallback(() => {
    setIsMapVisible(!isMapVisible);
  }, [isMapVisible]);

  // スプリットドラッグ関連
  const handleSplitDragStart = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    splitDragRef.current = { startY: clientY, startRatio: splitRatio };
  }, [splitRatio]);

  const handleSplitDragMove = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    if (!splitDragRef.current) return;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaY = clientY - splitDragRef.current.startY;
    const viewportHeight = window.innerHeight;
    const deltaRatio = (deltaY / viewportHeight) * 100;
    const newRatio = Math.max(20, Math.min(80, splitDragRef.current.startRatio + deltaRatio));
    setSplitRatio(newRatio);
  }, []);

  const handleSplitDragEnd = useCallback(() => {
    splitDragRef.current = null;
  }, []);

  // マップズームレベル変更
  const handleMapZoomChange = useCallback((newZoom: ZoomLevel) => {
    setMapZoomLevel(newZoom);
  }, []);

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

  // 現在のフェーズに表示するアイテムがない場合、次の訪問先を探すためのフラグ
  const [needsAutoAdvance, setNeedsAutoAdvance] = useState<{ type: 'index' | 'next'; index?: number } | null>(null);

  // 現在のフェーズに表示するアイテムがない場合の自動進行処理（useEffectで実行）
  useEffect(() => {
    if (isCompleted || allVisits.length === 0) return;
    
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
          setNeedsAutoAdvance({ type: 'index', index: i });
          return;
        }
      }
      // 見つからない場合は次のフェーズへ
      setNeedsAutoAdvance({ type: 'next' });
    }
  }, [currentVisitDisplayItems, currentPhaseVisits, currentPhaseIndex, currentPhase, postponedPhaseItemIds, latePhaseItemIds, isCompleted, allVisits.length]);

  // 自動進行の実行
  useEffect(() => {
    if (needsAutoAdvance) {
      if (needsAutoAdvance.type === 'index' && needsAutoAdvance.index !== undefined) {
        setCurrentPhaseIndex(needsAutoAdvance.index);
      } else if (needsAutoAdvance.type === 'next') {
        moveToNext();
      }
      setNeedsAutoAdvance(null);
    }
  }, [needsAutoAdvance, moveToNext]);

  // 完了画面
  if (isCompleted) {
    return (
      <div 
        className="flex flex-col items-center justify-center min-h-[50vh] p-8 relative"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 戻るボタン（PCモードのみ表示） */}
        {layoutMode === 'pc' && (
          <button
            onClick={handlePrev}
            className="fixed left-4 top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40"
            title="前の訪問先"
          >
            ◀
          </button>
        )}
        
        {/* スマートフォンモードのスワイプヒント */}
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

  // 自動進行処理中は何も表示しない
  if (needsAutoAdvance || (currentVisitDisplayItems.length === 0 && currentPhaseVisits.length > 0)) {
    return null;
  }

  // 現在の訪問先情報
  const circleName = currentVisit?.items[0]?.circle || '';
  const spaceInfo = currentVisit?.items[0] 
    ? `${currentVisit.items[0].block}-${extractBaseNumber(currentVisit.items[0].number).toUpperCase()}` 
    : '';

  // 現在の訪問キー（マップ用）
  const currentVisitKey = currentVisit?.items[0] 
    ? `${currentVisit.items[0].eventDate}-${currentVisit.items[0].block}-${extractBaseNumber(currentVisit.items[0].number)}`
    : null;
  
  // 次の訪問キー（マップ用）
  const nextVisitKey = nextVisit?.items[0]
    ? `${nextVisit.items[0].eventDate}-${nextVisit.items[0].block}-${extractBaseNumber(nextVisit.items[0].number)}`
    : null;

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

  // ヘッダーコンポーネント
  const Header = () => (
    <div className={`bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-3 rounded-lg shadow-lg ${layoutMode === 'smartphone' && isMapVisible ? 'mx-2' : ''}`}>
      <div className="flex justify-between items-start">
        <div>
          <div className="text-xs opacity-80">訪問先</div>
          <div className="text-xl font-bold">{spaceInfo}</div>
          <div className="flex items-center gap-2">
            <span className="text-sm">{circleName}</span>
            <span className="bg-white/20 px-2 py-0.5 rounded text-sm">{currentVisitCheckedCount}/{currentVisitTotalCount}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs opacity-80">フェーズ</div>
          <select
            value={currentPhase}
            onChange={(e) => handlePhaseChangeRequest(e.target.value as FocusPhase)}
            className="text-lg font-bold bg-white/20 hover:bg-white/30 rounded-md py-1 px-2 text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors"
            style={{ 
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 4px center',
              backgroundSize: '16px',
              paddingRight: '24px',
            }}
          >
            <option value="normal" className="text-slate-900">通常</option>
            <option value="postponed" className="text-slate-900">後回し</option>
            <option value="late" className="text-slate-900">遅参</option>
          </select>
          <div className="text-xs opacity-80 mt-1">
            次: {nextVisitInfo.spaceInfo} {nextVisitInfo.circleName}
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

  // フッターの高さ定数
  const FOOTER_HEIGHT_SP = 56;

  // マップのセルクリックハンドラ
  const handleMapCellClick = useCallback((blockName: string, number: number, matchingItems: ShoppingItem[]) => {
    setCellPopupState({
      isOpen: true,
      blockName,
      number,
      items: matchingItems,
    });
  }, []);

  // セルポップアップを閉じる
  const closeCellPopup = useCallback(() => {
    setCellPopupState(prev => ({ ...prev, isOpen: false }));
  }, []);

  // アイテム追加ダイアログを開く
  const openAddItemDialog = useCallback(() => {
    if (!currentVisit) return;
    const firstItem = currentVisit.items[0];
    setAddItemDialog({
      isOpen: true,
      eventDate: firstItem?.eventDate || '',
      block: cellPopupState.blockName,
      number: String(cellPopupState.number),
    });
    setNewItemForm({ circle: '', title: '', price: '', quantity: '1', remarks: '', url: '' });
    closeCellPopup();
  }, [currentVisit, cellPopupState, closeCellPopup]);

  // アイテム追加ダイアログを閉じる
  const closeAddItemDialog = useCallback(() => {
    setAddItemDialog(prev => ({ ...prev, isOpen: false }));
  }, []);

  // アイテムを追加
  const handleAddNewItem = useCallback(() => {
    if (!onAddItem) return;
    const price = newItemForm.price === '' ? null : parseInt(newItemForm.price, 10) || 0;
    onAddItem({
      eventDate: addItemDialog.eventDate,
      block: addItemDialog.block,
      number: addItemDialog.number,
      circle: newItemForm.circle,
      title: newItemForm.title,
      price,
      quantity: parseInt(newItemForm.quantity, 10) || 1,
      remarks: newItemForm.remarks,
      url: newItemForm.url || undefined,
    });
    setNotification(`${addItemDialog.block}-${addItemDialog.number} にアイテムを追加しました`);
    closeAddItemDialog();
  }, [onAddItem, addItemDialog, newItemForm, closeAddItemDialog]);

  // フェーズ切り替え確認ダイアログ
  const PhaseChangeDialog = () => {
    if (!phaseChangeDialog.isOpen || !phaseChangeDialog.targetPhase) return null;
    
    const targetPhaseName = phaseChangeDialog.targetPhase === 'normal' ? '通常' 
      : phaseChangeDialog.targetPhase === 'postponed' ? '後回し' : '遅参';
    const targetVisits = visitsByPhase[phaseChangeDialog.targetPhase];
    const targetVisit = targetVisits[phaseChangeDialog.savedIndex];
    const savedVisitInfo = targetVisit 
      ? `${targetVisit.items[0]?.block}-${targetVisit.items[0]?.number} ${targetVisit.items[0]?.circle}`
      : '';
    
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-md w-full mx-4 overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4">
            <h2 className="text-lg font-bold">フェーズを切り替えますか？</h2>
            <p className="text-sm opacity-80 mt-1">{targetPhaseName}フェーズに移動します</p>
          </div>
          
          <div className="p-4 space-y-4">
            {targetVisits.length === 0 ? (
              <p className="text-slate-600 dark:text-slate-300 text-center py-4">
                {targetPhaseName}フェーズに該当するアイテムがありません
              </p>
            ) : (
              <>
                <p className="text-slate-600 dark:text-slate-300">
                  {targetPhaseName}フェーズには {targetVisits.length} 件の訪問先があります。
                </p>
                
                <div className="space-y-2">
                  <button
                    onClick={executePhaseChangeFromStart}
                    className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                  >
                    最初から開始
                    <span className="block text-xs opacity-80 mt-0.5">
                      {targetVisits[0]?.items[0]?.block}-{targetVisits[0]?.items[0]?.number} {targetVisits[0]?.items[0]?.circle}
                    </span>
                  </button>
                  
                  {phaseChangeDialog.hasSavedIndex && (
                    <button
                      onClick={executePhaseChangeFromSaved}
                      className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
                    >
                      途中から再開
                      <span className="block text-xs opacity-80 mt-0.5">
                        {savedVisitInfo} （{phaseChangeDialog.savedIndex + 1}/{targetVisits.length}）
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}
            
            <button
              onClick={cancelPhaseChange}
              className="w-full py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
            >
              キャンセル
            </button>
          </div>
        </div>
      </div>
    );
  };

  // セルアイテムポップアップコンポーネント
  const CellItemPopup = () => {
    if (!cellPopupState.isOpen) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-sm w-full mx-4 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
            <h3 className="font-semibold text-slate-900 dark:text-white">
              {cellPopupState.blockName}-{cellPopupState.number} {cellPopupState.items.length > 0 ? `（${cellPopupState.items.length}件）` : ''}
            </h3>
            <button onClick={closeCellPopup} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {onAddItem && (
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
              <button onClick={openAddItemDialog} className="w-full py-2 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                新規アイテム追加
              </button>
            </div>
          )}
          <div className="max-h-60 overflow-y-auto">
            {cellPopupState.items.length === 0 ? (
              <div className="px-4 py-6 text-center text-slate-500 dark:text-slate-400">このセルにはアイテムがありません</div>
            ) : (
              cellPopupState.items.map(item => (
                <div key={item.id} className="p-3 border-b border-slate-100 dark:border-slate-700 last:border-b-0">
                  <div className="font-medium text-slate-900 dark:text-white">{item.circle}</div>
                  <div className="text-sm text-slate-600 dark:text-slate-400">{item.title}</div>
                  {item.price !== null && <div className="text-sm text-slate-500">¥{item.price.toLocaleString()}</div>}
                </div>
              ))
            )}
          </div>
          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700">
            <button onClick={closeCellPopup} className="w-full py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors">閉じる</button>
          </div>
        </div>
      </div>
    );
  };

  // 価格のクイック選択オプション
  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);

  // フォームスタイル
  const formInputClass = "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white";
  const labelClass = "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";

  // 価格入力ハンドラ
  const handlePriceInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9]/g, '');
    setNewItemForm(prev => ({ ...prev, price: value }));
  }, []);

  // 価格選択ハンドラ
  const handlePriceSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setNewItemForm(prev => ({ ...prev, price: e.target.value }));
  }, []);

  // アイテム追加ダイアログのJSX（直接レンダリング用）
  const addItemDialogJSX = addItemDialog.isOpen ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4">
          <h2 className="text-lg font-bold">新規アイテム追加</h2>
          <p className="text-sm opacity-80 mt-1">{addItemDialog.eventDate} {addItemDialog.block}-{addItemDialog.number}</p>
        </div>
        <div className="p-4 space-y-4">
          {/* サークル名・タイトル */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>サークル名 <span className="text-red-500">*</span></label>
              <input 
                type="text" 
                value={newItemForm.circle} 
                onChange={(e) => setNewItemForm(prev => ({ ...prev, circle: e.target.value }))} 
                className={formInputClass} 
                placeholder="サークル名" 
              />
            </div>
            <div>
              <label className={labelClass}>タイトル</label>
              <input 
                type="text" 
                value={newItemForm.title} 
                onChange={(e) => setNewItemForm(prev => ({ ...prev, title: e.target.value }))} 
                className={formInputClass} 
                placeholder="新刊セット" 
              />
            </div>
          </div>
          
          {/* 参加日・ブロック・ナンバー（読み取り専用で表示） */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>参加日</label>
              <input 
                type="text" 
                value={addItemDialog.eventDate} 
                readOnly
                className={`${formInputClass} bg-slate-100 dark:bg-slate-700`} 
              />
            </div>
            <div>
              <label className={labelClass}>ブロック</label>
              <input 
                type="text" 
                value={addItemDialog.block}
                readOnly
                className={`${formInputClass} bg-slate-100 dark:bg-slate-700`} 
              />
            </div>
            <div>
              <label className={labelClass}>ナンバー</label>
              <input 
                type="text" 
                value={addItemDialog.number}
                onChange={(e) => setAddItemDialog(prev => ({ ...prev, number: e.target.value }))}
                className={formInputClass}
                placeholder="01a"
              />
            </div>
          </div>
          
          {/* 価格・クイック選択 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div className="relative">
              <label className={labelClass}>頒布価格</label>
              <input
                type="text"
                value={newItemForm.price}
                onChange={handlePriceInputChange}
                className={`${formInputClass} pr-12`}
                placeholder="0"
                inputMode="numeric"
              />
              <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">円</span>
            </div>
            <div>
              <label className={labelClass}>クイック選択</label>
              <select 
                onChange={handlePriceSelectChange}
                className={formInputClass}
                value={priceOptions.includes(Number(newItemForm.price)) ? newItemForm.price : ""}
              >
                <option value="" disabled>金額を選択...</option>
                {priceOptions.map(p => <option key={p} value={p}>{p.toLocaleString()}円</option>)}
              </select>
            </div>
          </div>
          
          {/* 数量 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>数量</label>
              <select
                value={newItemForm.quantity}
                onChange={(e) => setNewItemForm(prev => ({ ...prev, quantity: e.target.value }))}
                className={formInputClass}
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map(num => (
                  <option key={num} value={num}>{num}</option>
                ))}
              </select>
            </div>
          </div>
          
          {/* 備考・URL */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>備考</label>
              <input 
                type="text" 
                value={newItemForm.remarks} 
                onChange={(e) => setNewItemForm(prev => ({ ...prev, remarks: e.target.value }))} 
                className={formInputClass} 
                placeholder="スケブお願い" 
              />
            </div>
            <div>
              <label className={labelClass}>URL</label>
              <input 
                type="text" 
                value={newItemForm.url} 
                onChange={(e) => setNewItemForm(prev => ({ ...prev, url: e.target.value }))} 
                className={formInputClass} 
                placeholder="https://example.com" 
              />
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
          <button 
            onClick={closeAddItemDialog} 
            className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
          >
            キャンセル
          </button>
          <button 
            onClick={handleAddNewItem} 
            disabled={!newItemForm.circle.trim()} 
            className="flex-1 py-2 px-4 bg-green-600 hover:bg-green-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
          >
            リストに追加
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // スマートフォン+マップ表示モード
  if (layoutMode === 'smartphone' && isMapVisible && currentMapData && !isCompleted) {
    const availableHeight = `calc(100vh - ${FOOTER_HEIGHT_SP}px)`;
    
    return (
      <div 
        className="relative flex flex-col"
        style={{ height: availableHeight }}
      >
        {/* 通知 */}
        {notification && (
          <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse">
            {notification}
          </div>
        )}

        {/* 自動進行カウントダウン */}
        {autoAdvanceCountdown !== null && (
          <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg">
            {autoAdvanceCountdown}秒後に次の訪問先へ移動します...
          </div>
        )}

        {/* マップエリア */}
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
              onCellClick={handleMapCellClick}
            />
          </div>
        </div>

        {/* 分割線（ドラッグ可能） */}
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
          <div className="w-12 h-1 bg-slate-500 dark:bg-slate-400 rounded-full" />
        </div>

        {/* アイテムリストエリア（スワイプ判定はここのみ） */}
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

        {/* フッター */}
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
                {currentMapData && (
                  <button
                    onClick={toggleMapVisibility}
                    className={`p-2 rounded-md transition-colors ${
                      isMapVisible 
                        ? 'bg-blue-600 text-white' 
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                    title={isMapVisible ? 'マップを非表示' : 'マップを表示'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                    </svg>
                  </button>
                )}
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
        
        {/* フェーズ切り替え確認ダイアログ */}
        <PhaseChangeDialog />
        
        {/* セルアイテムポップアップ */}
        <CellItemPopup />
        
        {/* アイテム追加ダイアログ */}
        {addItemDialogJSX}
      </div>
    );
  }

  // フッターの高さ定数（PC用）
  const HEADER_HEIGHT = 64;
  const FOOTER_HEIGHT_PC = 64;

  // PC+マップ表示モード
  if (layoutMode === 'pc' && isMapVisible && currentMapData && !isCompleted) {
    const availableHeight = `calc(100vh - ${HEADER_HEIGHT + FOOTER_HEIGHT_PC}px)`;
    
    return (
      <div className="relative flex" style={{ height: availableHeight }}>
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

        {/* 左側: マップ */}
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
              onCellClick={handleMapCellClick}
            />
          </div>
        </div>

        {/* 右側: アイテムリスト */}
        <div className="w-1/2 flex flex-col overflow-y-auto pb-20">
          <Header />
          <ItemList />
        </div>

        {/* ナビゲーションボタン */}
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

        {/* フッター */}
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
                {currentMapData && (
                  <button
                    onClick={toggleMapVisibility}
                    className={`p-2 rounded-md transition-colors ${
                      isMapVisible 
                        ? 'bg-blue-600 text-white' 
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                    title={isMapVisible ? 'マップを非表示' : 'マップを表示'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                    </svg>
                  </button>
                )}
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
        
        {/* フェーズ切り替え確認ダイアログ */}
        <PhaseChangeDialog />
        
        {/* セルアイテムポップアップ */}
        <CellItemPopup />
        
        {/* アイテム追加ダイアログ */}
        {addItemDialogJSX}
      </div>
    );
  }

  return (
    <div 
      ref={swipeContainerRef}
      className="relative min-h-[calc(100vh-200px)] pb-20"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
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

      {/* ヘッダー情報 - スマートフォンモードでは横幅フル */}
      <div className={`bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 rounded-lg mb-4 shadow-lg ${layoutMode === 'smartphone' ? 'mx-2' : 'mx-16'}`}>
        <div className="flex justify-between items-start">
          <div>
            <div className="text-sm opacity-80">訪問先</div>
            <div className="text-2xl font-bold">{spaceInfo}</div>
            <div className="flex items-center gap-2">
              <span className="text-lg">{circleName}</span>
              <span className="bg-white/20 px-2 py-0.5 rounded text-sm">{currentVisitCheckedCount}/{currentVisitTotalCount}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm opacity-80">フェーズ</div>
            <select
              value={currentPhase}
              onChange={(e) => handlePhaseChangeRequest(e.target.value as FocusPhase)}
              className="text-xl font-bold bg-white/20 hover:bg-white/30 rounded-md py-1 px-2 text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors"
              style={{ 
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 4px center',
                backgroundSize: '16px',
                paddingRight: '24px',
              }}
            >
              <option value="normal" className="text-slate-900">通常</option>
              <option value="postponed" className="text-slate-900">後回し</option>
              <option value="late" className="text-slate-900">遅参</option>
            </select>
            <div className="text-sm opacity-80 mt-1">
              次: {nextVisitInfo.spaceInfo} {nextVisitInfo.circleName}
            </div>
          </div>
        </div>
      </div>

      {/* アイテムリスト - スマートフォンモードでは横幅フル */}
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

      {/* ナビゲーションボタン（PCモードのみ表示） */}
      {layoutMode === 'pc' && (
        <>
          {/* 戻るボタン（左側） */}
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

          {/* 次へボタン（右側） */}
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

      {/* フッター */}
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
              {currentMapData && (
                <button
                  onClick={toggleMapVisibility}
                  className={`p-2 rounded-md transition-colors ${
                    isMapVisible 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                  title={isMapVisible ? 'マップを非表示' : 'マップを表示'}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                  </svg>
                </button>
              )}
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
      
      {/* フェーズ切り替え確認ダイアログ */}
      <PhaseChangeDialog />
      
      {/* セルアイテムポップアップ */}
      <CellItemPopup />
      
      {/* アイテム追加ダイアログ */}
      {addItemDialogJSX}
    </div>
  );
};

export default FocusMode;