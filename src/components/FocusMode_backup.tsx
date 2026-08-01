import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { ShoppingItem } from "../types";
import ShoppingItemCard from "./ShoppingItemCard";

// フェーズの定義
type FocusPhase = "normal" | "postponed" | "late";

interface FocusModeProps {
  items: ShoppingItem[];
  executeModeItemIds: string[];
  onUpdateItem: (item: ShoppingItem) => void;
  onModeChange: (mode: "edit" | "execute", lastItemId?: string) => void;
  layoutMode: "pc" | "smartphone";
  onLayoutModeChange: (mode: "pc" | "smartphone") => void;
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
}) => {
  // 現在のフェーズ（ユーザー操作でのみ変更）
  const [currentPhase, setCurrentPhase] = useState<FocusPhase>("normal");
  // 現在のフェーズ内での訪問先インデックス
  const [currentPhaseIndex, setCurrentPhaseIndex] = useState(0);
  // 最後に操作したアイテムID
  const [lastInteractedItemId, setLastInteractedItemId] = useState<
    string | null
  >(null);
  // 次へボタンの点滅状態
  const [isNextButtonBlinking, setIsNextButtonBlinking] = useState(false);
  // 価格未定警告の点滅状態
  const [blinkingPriceItemIds, setBlinkingPriceItemIds] = useState<Set<string>>(
    new Set(),
  );
  // 通知メッセージ
  const [notification, setNotification] = useState<string | null>(null);
  // 完了状態
  const [isCompleted, setIsCompleted] = useState(false);
  // 自動進行タイマーID
  const autoAdvanceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // カウントダウンインターバルID
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // 自動進行カウントダウン
  const [autoAdvanceCountdown, setAutoAdvanceCountdown] = useState<
    number | null
  >(null);
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
  const [postponedPhaseItemIds, setPostponedPhaseItemIds] = useState<
    Set<string>
  >(new Set());
  // 遅参フェーズで表示するアイテムID（後回しフェーズ終了時に確定）
  const [latePhaseItemIds, setLatePhaseItemIds] = useState<Set<string>>(
    new Set(),
  );

  // 実行列のアイテムを取得
  const executeItems = useMemo(() => {
    return executeModeItemIds
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is ShoppingItem => item !== undefined);
  }, [items, executeModeItemIds]);

  // 全訪問先リストを実行列順序で生成
  const allVisits = useMemo(() => {
    const visitKeyOrder: string[] = [];
    const visitMap = new Map<string, ShoppingItem[]>();

    executeItems.forEach((item) => {
      const key = getVisitKey(item);
      if (!visitMap.has(key)) {
        visitMap.set(key, []);
        visitKeyOrder.push(key);
      }
      visitMap.get(key)!.push(item);
    });

    return visitKeyOrder.map((key) => ({
      key,
      items: visitMap.get(key)!,
    }));
  }, [executeItems]);

  // 現時点で後回し状態のアイテムIDセット（通常フェーズ中に動的に更新）
  const currentPostponedItemIds = useMemo(() => {
    return new Set(
      executeItems
        .filter((item) => item.purchaseStatus === "Postpone")
        .map((item) => item.id),
    );
  }, [executeItems]);

  // 現時点で遅参状態のアイテムIDセット（通常・後回しフェーズ中に動的に更新）
  const currentLateItemIds = useMemo(() => {
    return new Set(
      executeItems
        .filter((item) => item.purchaseStatus === "Late")
        .map((item) => item.id),
    );
  }, [executeItems]);

  // フェーズごとの訪問先リストを計算
  const visitsByPhase = useMemo(() => {
    const normal: typeof allVisits = [];
    const postponed: typeof allVisits = [];
    const late: typeof allVisits = [];

    allVisits.forEach((visit) => {
      // 通常フェーズ: 全ての訪問先を含む（網羅的）
      normal.push(visit);

      // 後回しフェーズ: 記憶されたアイテムIDがある訪問先
      if (currentPhase === "normal") {
        // 通常フェーズ中は現時点の後回しアイテムで判定
        const hasPostponedItems = visit.items.some((item) =>
          currentPostponedItemIds.has(item.id),
        );
        if (hasPostponedItems) postponed.push(visit);
      } else {
        // 後回し/遅参フェーズでは記憶されたIDで判定
        const hasPostponedItems = visit.items.some((item) =>
          postponedPhaseItemIds.has(item.id),
        );
        if (hasPostponedItems) postponed.push(visit);
      }

      // 遅参フェーズ: 記憶されたアイテムIDがある訪問先
      if (currentPhase === "normal" || currentPhase === "postponed") {
        // 通常/後回しフェーズ中は現時点の遅参アイテムで判定
        const hasLateItems = visit.items.some((item) =>
          currentLateItemIds.has(item.id),
        );
        if (hasLateItems) late.push(visit);
      } else {
        // 遅参フェーズでは記憶されたIDで判定
        const hasLateItems = visit.items.some((item) =>
          latePhaseItemIds.has(item.id),
        );
        if (hasLateItems) late.push(visit);
      }
    });

    return { normal, postponed, late };
  }, [
    allVisits,
    currentPhase,
    currentPostponedItemIds,
    currentLateItemIds,
    postponedPhaseItemIds,
    latePhaseItemIds,
  ]);

  // 現在のフェーズの訪問先リスト
  const currentPhaseVisits = useMemo(() => {
    return visitsByPhase[currentPhase];
  }, [visitsByPhase, currentPhase]);

  // 現在表示すべき訪問先
  const currentVisit = useMemo(() => {
    if (currentPhaseVisits.length === 0) return null;
    const safeIndex = Math.min(
      currentPhaseIndex,
      currentPhaseVisits.length - 1,
    );
    return currentPhaseVisits[safeIndex] || null;
  }, [currentPhaseVisits, currentPhaseIndex]);

  // 現在のフェーズで表示すべきアイテム
  const currentVisitDisplayItems = useMemo(() => {
    if (!currentVisit) return [];

    if (currentPhase === "normal") {
      // 通常フェーズ: 全アイテムを表示
      return currentVisit.items;
    } else if (currentPhase === "postponed") {
      // 後回しフェーズ: 記憶された後回しアイテムIDに含まれるアイテムを表示
      return currentVisit.items.filter((item) =>
        postponedPhaseItemIds.has(item.id),
      );
    } else {
      // 遅参フェーズ: 記憶された遅参アイテムIDに含まれるアイテムを表示
      return currentVisit.items.filter((item) => latePhaseItemIds.has(item.id));
    }
  }, [currentVisit, currentPhase, postponedPhaseItemIds, latePhaseItemIds]);

  // フェーズ名の日本語表示
  const phaseDisplayName = useMemo(() => {
    switch (currentPhase) {
      case "normal":
        return "通常";
      case "postponed":
        return "後回し";
      case "late":
        return "遅参";
    }
  }, [currentPhase]);

  // 総訪問先数（全フェーズ合計）
  const totalVisits = useMemo(() => {
    return (
      visitsByPhase.normal.length +
      visitsByPhase.postponed.length +
      visitsByPhase.late.length
    );
  }, [visitsByPhase]);

  // 現在の訪問先番号（全フェーズ通算）
  const currentVisitNumber = useMemo(() => {
    let number = currentPhaseIndex + 1;
    if (currentPhase === "postponed") {
      number += visitsByPhase.normal.length;
    } else if (currentPhase === "late") {
      number += visitsByPhase.normal.length + visitsByPhase.postponed.length;
    }
    return number;
  }, [currentPhaseIndex, currentPhase, visitsByPhase]);

  // 価格未定かつ購入済みのアイテムをチェック
  const hasUndefinedPricePurchased = useMemo(() => {
    return currentVisitDisplayItems.some(
      (item) =>
        item.purchaseStatus === "Purchased" &&
        (item.price === -1 || item.price === null),
    );
  }, [currentVisitDisplayItems]);

  // 残りの合計金額を計算
  const remainingCost = useMemo(() => {
    return executeItems.reduce((sum, item) => {
      const isPurchasable =
        item.purchaseStatus === "None" ||
        item.purchaseStatus === "Postpone" ||
        item.purchaseStatus === "Late";
      if (!isPurchasable) return sum;
      const price = item.price && item.price > 0 ? item.price : 0;
      return sum + price * item.quantity;
    }, 0);
  }, [executeItems]);

  // 購入済み件数
  const purchasedCount = useMemo(() => {
    return executeItems.filter((item) => item.purchaseStatus === "Purchased")
      .length;
  }, [executeItems]);

  // タイマーをクリアする関数
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

  // 次へボタンの点滅を更新
  useEffect(() => {
    if (currentVisitDisplayItems.length === 0) return;

    if (hasUndefinedPricePurchased) {
      setIsNextButtonBlinking(false);
      const undefinedPriceIds = currentVisitDisplayItems
        .filter(
          (item) =>
            item.purchaseStatus === "Purchased" &&
            (item.price === -1 || item.price === null),
        )
        .map((item) => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
    } else {
      setBlinkingPriceItemIds(new Set());
      const hasUnprocessed = currentVisitDisplayItems.some(
        (item) => item.purchaseStatus === "None",
      );
      setIsNextButtonBlinking(
        !hasUnprocessed && currentVisitDisplayItems.length > 0,
      );
    }
  }, [currentVisitDisplayItems, hasUndefinedPricePurchased]);

  // 通知を自動で消す
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // ナビゲーションボタンの位置を調整
  useEffect(() => {
    const checkOverlap = () => {
      if (!itemListRef.current) return;

      const buttonSize = 56; // w-14 = 56px
      const buttonMargin = 16; // left-4/right-4 = 16px
      const viewportHeight = window.innerHeight;
      const buttonCenterY = viewportHeight / 2;

      // アイテムカード内の操作部分（ボタンやドロップダウン）の位置を取得
      const interactiveElements = itemListRef.current.querySelectorAll(
        'button, select, [role="button"]',
      );

      let leftOffset = 0;
      let rightOffset = 0;

      interactiveElements.forEach((element) => {
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
            rightOffset = Math.max(
              rightOffset,
              rect.right - rightButtonLeft + 8,
            );
          }
        }
      });

      setNavButtonOffset({ left: leftOffset, right: rightOffset });
    };

    // 初回チェックと再チェック
    const timer = setTimeout(checkOverlap, 100);
    window.addEventListener("resize", checkOverlap);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", checkOverlap);
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
      if (currentPhase === "normal") {
        // 通常フェーズ終了 → 後回しアイテムIDを記憶
        const postponedIds = new Set(
          executeItems
            .filter((item) => item.purchaseStatus === "Postpone")
            .map((item) => item.id),
        );
        setPostponedPhaseItemIds(postponedIds);

        // 遅参アイテムIDも更新（通常フェーズで遅参にしたもの）
        const lateIds = new Set(
          executeItems
            .filter((item) => item.purchaseStatus === "Late")
            .map((item) => item.id),
        );
        setLatePhaseItemIds(lateIds);

        if (postponedIds.size > 0) {
          setNotification("後回しアイテムの巡回を開始します");
          setCurrentPhase("postponed");
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else if (lateIds.size > 0) {
          setNotification("遅参アイテムの巡回を開始します");
          setCurrentPhase("late");
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else {
          setIsCompleted(true);
        }
      } else if (currentPhase === "postponed") {
        // 後回しフェーズ終了 → 遅参アイテムIDを更新（後回しフェーズで遅参にしたものを追加）
        const currentLateIds = new Set(latePhaseItemIds);
        executeItems.forEach((item) => {
          if (item.purchaseStatus === "Late") {
            currentLateIds.add(item.id);
          }
        });
        setLatePhaseItemIds(currentLateIds);

        if (currentLateIds.size > 0) {
          setNotification("遅参アイテムの巡回を開始します");
          setCurrentPhase("late");
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else {
          setIsCompleted(true);
        }
      } else {
        setIsCompleted(true);
      }
    }
  }, [
    currentPhaseIndex,
    currentPhaseVisits.length,
    currentPhase,
    executeItems,
    clearAutoAdvanceTimer,
    latePhaseItemIds,
  ]);

  // 自動進行を開始する関数（ユーザー操作からのみ呼び出す）
  const startAutoAdvance = useCallback(() => {
    // 既にタイマーが動いている場合は何もしない
    if (autoAdvanceTimerRef.current) return;

    // カウントダウン開始
    setAutoAdvanceCountdown(3);

    countdownIntervalRef.current = setInterval(() => {
      setAutoAdvanceCountdown((prev) => {
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
      setNotification("価格未定のアイテムがあります。価格を入力してください。");
      const undefinedPriceIds = currentVisitDisplayItems
        .filter(
          (item) =>
            item.purchaseStatus === "Purchased" &&
            (item.price === -1 || item.price === null),
        )
        .map((item) => item.id);
      setBlinkingPriceItemIds(new Set(undefinedPriceIds));
      return;
    }

    clearAutoAdvanceTimer();
    moveToNext();
  }, [
    hasUndefinedPricePurchased,
    currentVisitDisplayItems,
    clearAutoAdvanceTimer,
    moveToNext,
  ]);

  // 前の訪問先へ
  const handlePrev = useCallback(() => {
    clearAutoAdvanceTimer();

    // 完了画面から戻る場合
    if (isCompleted) {
      setIsCompleted(false);
      // 最後のフェーズの最後の訪問先に戻る
      if (latePhaseItemIds.size > 0) {
        setCurrentPhase("late");
        setCurrentPhaseIndex(visitsByPhase.late.length - 1);
      } else if (postponedPhaseItemIds.size > 0) {
        setCurrentPhase("postponed");
        setCurrentPhaseIndex(visitsByPhase.postponed.length - 1);
      } else if (visitsByPhase.normal.length > 0) {
        setCurrentPhase("normal");
        setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
      }
      return;
    }

    if (currentPhaseIndex > 0) {
      setCurrentPhaseIndex(currentPhaseIndex - 1);
      setIsNextButtonBlinking(false);
    } else {
      // フェーズの最初 - 前のフェーズへ
      if (currentPhase === "postponed" && visitsByPhase.normal.length > 0) {
        setCurrentPhase("normal");
        setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
        setIsNextButtonBlinking(false);
      } else if (currentPhase === "late") {
        if (postponedPhaseItemIds.size > 0) {
          setCurrentPhase("postponed");
          setCurrentPhaseIndex(visitsByPhase.postponed.length - 1);
          setIsNextButtonBlinking(false);
        } else if (visitsByPhase.normal.length > 0) {
          setCurrentPhase("normal");
          setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
          setIsNextButtonBlinking(false);
        } else {
          setNotification("最初の訪問サークル・スペースです");
        }
      } else {
        setNotification("最初の訪問サークル・スペースです");
      }
    }
  }, [
    currentPhaseIndex,
    currentPhase,
    visitsByPhase,
    clearAutoAdvanceTimer,
    isCompleted,
    postponedPhaseItemIds,
    latePhaseItemIds,
  ]);

  // アイテム更新ハンドラ
  const handleUpdateItem = useCallback(
    (updatedItem: ShoppingItem) => {
      setLastInteractedItemId(updatedItem.id);

      // まずアイテムを更新
      onUpdateItem(updatedItem);

      // 購入状態が変更されたかチェック
      const originalItem = currentVisitDisplayItems.find(
        (i) => i.id === updatedItem.id,
      );
      if (!originalItem) return;

      // 後回し/遅参以外に変更された場合、タイマーをクリア
      if (
        updatedItem.purchaseStatus !== "Postpone" &&
        updatedItem.purchaseStatus !== "Late"
      ) {
        clearAutoAdvanceTimer();
        return;
      }

      // 通常フェーズでのみ自動進行をチェック
      if (currentPhase !== "normal") return;

      // 更新後の状態で全アイテムが後回し/遅参かチェック
      const willAllBePostponedOrLate = currentVisitDisplayItems.every(
        (item) => {
          if (item.id === updatedItem.id) {
            return (
              updatedItem.purchaseStatus === "Postpone" ||
              updatedItem.purchaseStatus === "Late"
            );
          }
          return (
            item.purchaseStatus === "Postpone" || item.purchaseStatus === "Late"
          );
        },
      );

      if (willAllBePostponedOrLate) {
        // 3秒後に自動進行を開始
        startAutoAdvance();
      }
    },
    [
      onUpdateItem,
      currentVisitDisplayItems,
      clearAutoAdvanceTimer,
      currentPhase,
      startAutoAdvance,
    ],
  );

  // スワイプハンドラ（スマートフォンモード用）
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (layoutMode !== "smartphone") return;
      const touch = e.touches[0];
      touchStartXRef.current = touch.clientX;
      touchStartYRef.current = touch.clientY;
      isSwipingRef.current = false;
    },
    [layoutMode],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (
        layoutMode !== "smartphone" ||
        touchStartXRef.current === null ||
        touchStartYRef.current === null
      )
        return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartXRef.current;
      const deltaY = touch.clientY - touchStartYRef.current;

      // 水平方向の移動が垂直方向より大きい場合のみスワイプとして処理
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
        isSwipingRef.current = true;
      }
    },
    [layoutMode],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (layoutMode !== "smartphone" || touchStartXRef.current === null)
        return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartXRef.current;
      const deltaY = touch.clientY - (touchStartYRef.current || 0);

      // 水平方向の移動が垂直方向より大きく、閾値を超えた場合のみ処理
      if (
        Math.abs(deltaX) > Math.abs(deltaY) &&
        Math.abs(deltaX) > SWIPE_THRESHOLD
      ) {
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
    },
    [layoutMode, handlePrev, handleNext],
  );

  // モード切り替え
  const handleModeChangeInternal = useCallback(
    (mode: "edit" | "execute") => {
      onModeChange(mode, lastInteractedItemId || undefined);
    },
    [onModeChange, lastInteractedItemId],
  );

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
          onClick={() => handleModeChangeInternal("edit")}
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
        {/* 戻るボタン（PCモードのみ表示） */}
        {layoutMode === "pc" && (
          <button
            onClick={handlePrev}
            className="fixed left-4 top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40"
            title="前の訪問先"
          >
            ◀
          </button>
        )}

        {/* スマートフォンモードのスワイプヒント */}
        {layoutMode === "smartphone" && (
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
            onClick={() => handleModeChangeInternal("edit")}
            className="px-6 py-3 bg-slate-600 text-white rounded-lg font-medium hover:bg-slate-700 transition-colors flex items-center gap-2"
          >
            <span>📝</span>
            <span>編集モードへ</span>
          </button>
          <button
            onClick={() => handleModeChangeInternal("execute")}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <span>🏃</span>
            <span>実行モードへ</span>
          </button>
        </div>
      </div>
    );
  }

  // 現在のフェーズに表示するアイテムがない場合、次の訪問先を探す
  if (currentVisitDisplayItems.length === 0 && currentPhaseVisits.length > 0) {
    // 次の訪問先を探す
    for (let i = currentPhaseIndex + 1; i < currentPhaseVisits.length; i++) {
      const visit = currentPhaseVisits[i];
      let hasItems = false;
      if (currentPhase === "normal") {
        hasItems = visit.items.length > 0;
      } else if (currentPhase === "postponed") {
        hasItems = visit.items.some((item) =>
          postponedPhaseItemIds.has(item.id),
        );
      } else {
        hasItems = visit.items.some((item) => latePhaseItemIds.has(item.id));
      }
      if (hasItems) {
        setCurrentPhaseIndex(i);
        return null;
      }
    }
    // 見つからない場合は次のフェーズへ
    moveToNext();
    return null;
  }

  // 現在の訪問先情報
  const circleName = currentVisit?.items[0]?.circle || "";
  const spaceInfo = currentVisit?.items[0]
    ? `${currentVisit.items[0].block}-${extractBaseNumber(currentVisit.items[0].number).toUpperCase()}`
    : "";

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
      <div
        className={`bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 rounded-lg mb-4 shadow-lg ${layoutMode === "smartphone" ? "mx-2" : "mx-16"}`}
      >
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

      {/* アイテムリスト - スマートフォンモードでは横幅フル */}
      <div
        ref={itemListRef}
        className={`space-y-4 pb-24 ${layoutMode === "smartphone" ? "mx-2" : "mx-16"}`}
      >
        {currentVisitDisplayItems.map((item, index) => (
          <div
            key={item.id}
            data-item-id={item.id}
            className={`relative ${blinkingPriceItemIds.has(item.id) ? "animate-pulse ring-2 ring-red-500 rounded-lg" : ""}`}
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
      {layoutMode === "pc" && (
        <>
          {/* 戻るボタン（左側） */}
          <button
            onClick={handlePrev}
            style={{
              left: `${16 + navButtonOffset.left}px`,
              transition: "left 0.2s ease-out",
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
              transition: "right 0.2s ease-out",
            }}
            className={`fixed top-1/2 transform -translate-y-1/2 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-2xl z-40 ${
              hasUndefinedPricePurchased
                ? "bg-red-500 hover:bg-red-600 text-white"
                : isNextButtonBlinking
                  ? "bg-green-500 hover:bg-green-600 text-white animate-pulse"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
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
                {phaseDisplayName}: {currentPhaseIndex + 1}/
                {currentPhaseVisits.length}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400 ml-3 opacity-60">
                ({currentVisitNumber}/{totalVisits})
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-slate-700 dark:text-slate-300">
                <span className="font-semibold">{purchasedCount}</span> /{" "}
                {executeItems.length} 件購入済み
              </div>
              <div>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  残りの合計:{" "}
                </span>
                <span className="font-bold text-xl text-blue-600 dark:text-blue-400">
                  ¥{remainingCost.toLocaleString()}
                </span>
              </div>
              <button
                onClick={() =>
                  onLayoutModeChange(layoutMode === "pc" ? "smartphone" : "pc")
                }
                className={`p-2 rounded-md transition-colors ${
                  layoutMode === "smartphone"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                }`}
                title={
                  layoutMode === "pc"
                    ? "スマートフォンモードに切替"
                    : "タブレット/PCモードに切替"
                }
                aria-label={
                  layoutMode === "pc"
                    ? "スマートフォンモードに切替"
                    : "タブレット/PCモードに切替"
                }
              >
                {layoutMode === "smartphone" ? (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
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
