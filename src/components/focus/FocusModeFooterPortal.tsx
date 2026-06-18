import ReactDOM from 'react-dom';

interface FocusModeFooterPortalProps {
  compact?: boolean;
  layoutMode: 'pc' | 'smartphone';
  phaseDisplayName: string;
  currentPhaseIndex: number;
  currentPhaseVisitsLength: number;
  currentVisitNumber: number;
  totalVisits: number;
  purchasedCount: number;
  executeItemsLength: number;
  remainingCost: number;
  hasMapData: boolean;
  isMapVisible: boolean;
  onToggleMapVisibility: () => void;
  onLayoutModeChange: (mode: 'pc' | 'smartphone') => void;
}

export function FocusModeFooterPortal({
  compact = false,
  layoutMode,
  phaseDisplayName,
  currentPhaseIndex,
  currentPhaseVisitsLength,
  currentVisitNumber,
  totalVisits,
  purchasedCount,
  executeItemsLength,
  remainingCost,
  hasMapData,
  isMapVisible,
  onToggleMapVisibility,
  onLayoutModeChange,
}: FocusModeFooterPortalProps) {
  return ReactDOM.createPortal(
    <div
      id="focus-mode-footer"
      className={`fixed bottom-0 left-0 right-0 ${
        compact ? 'bg-white/90 dark:bg-slate-800/90' : 'bg-white/80 dark:bg-slate-800/80'
      } backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20`}
    >
      <div className={compact ? 'px-4 py-2' : 'max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3'}>
        <div className={compact ? 'flex justify-between items-center' : 'flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2'}>
          <div className="text-slate-700 dark:text-slate-300">
            <span className={compact ? 'font-bold text-lg text-indigo-600 dark:text-indigo-400' : 'font-bold text-xl text-indigo-600 dark:text-indigo-400'}>
              {phaseDisplayName}: {currentPhaseIndex + 1}/{currentPhaseVisitsLength}
            </span>
            {!compact && (
              <span className="text-sm text-slate-500 dark:text-slate-400 ml-3 opacity-60">
                ({currentVisitNumber}/{totalVisits})
              </span>
            )}
          </div>
          <div className={compact ? 'flex items-center gap-2' : 'flex items-center gap-3'}>
            <div className={compact ? 'text-sm text-slate-700 dark:text-slate-300' : 'text-slate-700 dark:text-slate-300'}>
              <span className="font-semibold">{purchasedCount}</span>
              {compact ? `/${executeItemsLength}` : ` / ${executeItemsLength} 件購入済み`}
            </div>
            <div className={compact ? 'text-sm' : ''}>
              {!compact && <span className="text-sm text-slate-500 dark:text-slate-400">残りの合計: </span>}
              <span className={compact ? 'font-bold text-blue-600 dark:text-blue-400' : 'font-bold text-xl text-blue-600 dark:text-blue-400'}>
                ¥{remainingCost.toLocaleString()}
              </span>
            </div>
            {hasMapData && (
              <button
                onClick={onToggleMapVisibility}
                className={`p-2 rounded-md transition-colors ${
                  isMapVisible
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                }`}
                title={isMapVisible ? 'マップを非表示' : 'マップを表示'}
              >
                <MapIcon />
              </button>
            )}
            <button
              onClick={() => {
                if (compact || (hasMapData && isMapVisible)) {
                  onLayoutModeChange(compact ? 'pc' : 'smartphone');
                  return;
                }
                onLayoutModeChange(layoutMode === 'pc' ? 'smartphone' : 'pc');
              }}
              className={
                compact || (hasMapData && isMapVisible)
                  ? 'p-2 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                  : `p-2 rounded-md transition-colors ${
                      layoutMode === 'smartphone'
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`
              }
              title={
                compact
                  ? 'タブレット/PCモードに切替'
                  : layoutMode === 'pc'
                    ? 'スマートフォンモードに切替'
                    : 'タブレット/PCモードに切替'
              }
              aria-label={
                compact
                  ? 'タブレット/PCモードに切替'
                  : layoutMode === 'pc'
                    ? 'スマートフォンモードに切替'
                    : 'タブレット/PCモードに切替'
              }
            >
              {compact || (hasMapData && isMapVisible) ? (
                compact ? <LaptopIcon /> : <SmartphoneIcon />
              ) : layoutMode === 'smartphone' ? (
                <SmartphoneIcon />
              ) : (
                <LaptopIcon />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MapIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
      />
    </svg>
  );
}

function SmartphoneIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
      />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </svg>
  );
}
