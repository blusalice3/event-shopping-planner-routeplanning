import React, { useEffect, useId, useMemo, useRef, useState } from "react";

type MapRotationControlsProps = {
  angle: number;
  initialAngle: number;
  onAngleChange: (angle: number) => void;
  className?: string;
  sliderClassName?: string;
  showHint?: boolean;
  defaultExpanded?: boolean;
  compact?: boolean;
};

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const MapRotationControls: React.FC<MapRotationControlsProps> = ({
  angle,
  initialAngle,
  onAngleChange,
  className = "",
  sliderClassName = "",
  showHint = false,
  defaultExpanded = false,
  compact = false,
}) => {
  const normalizedAngle = useMemo(() => normalizeRotationAngle(angle), [angle]);
  const normalizedInitialAngle = useMemo(
    () => normalizeRotationAngle(initialAngle),
    [initialAngle],
  );
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const compactRootRef = useRef<HTMLDivElement>(null);
  const compactToggleRef = useRef<HTMLButtonElement>(null);
  const compactPanelId = useId();
  const toggleTitle = isExpanded ? "回転操作を折りたたむ" : "回転操作を展開";

  useEffect(() => {
    if (!compact || !isExpanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!compactRootRef.current?.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsExpanded(false);
      compactToggleRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [compact, isExpanded]);

  const adjustmentControls = (
    <>
      <input
        type="range"
        min={0}
        max={359}
        step={1}
        value={normalizedAngle}
        onChange={(e) =>
          onAngleChange(normalizeRotationAngle(Number(e.target.value)))
        }
        className={`w-24 accent-blue-600 ${sliderClassName}`}
        aria-label="マップの回転角度"
        aria-valuetext={`${normalizedAngle}度`}
      />
      <button
        type="button"
        onClick={() =>
          onAngleChange(normalizeRotationAngle(normalizedAngle + 15))
        }
        className="min-h-8 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
        title="+15° (時計回り)"
      >
        +15
      </button>
      <button
        type="button"
        onClick={() =>
          onAngleChange(normalizeRotationAngle(normalizedAngle + 45))
        }
        className="min-h-8 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
        title="+45° (時計回り)"
      >
        +45
      </button>
      <button
        type="button"
        onClick={() => onAngleChange(normalizedInitialAngle)}
        className="min-h-8 rounded bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60"
        title={`初期角度(${normalizedInitialAngle}°)に戻す`}
      >
        リセット
      </button>
      {showHint && !compact && (
        <span className="whitespace-nowrap text-[10px] text-slate-500 dark:text-slate-400">
          Shift+ホイール
        </span>
      )}
    </>
  );

  if (compact) {
    return (
      <div
        ref={compactRootRef}
        className={`relative flex h-7 flex-none items-center rounded-md border border-slate-200 bg-white/90 p-0 dark:border-slate-600 dark:bg-slate-800/90 ${className}`}
        data-testid="map-rotation-compact"
      >
        <button
          ref={compactToggleRef}
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="flex h-full min-w-[4.5rem] touch-manipulation items-center justify-center gap-1 rounded px-1.5 text-xs font-semibold leading-none text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-200 dark:hover:bg-slate-700"
          title={toggleTitle}
          aria-label={`回転 ${normalizedAngle}°`}
          aria-expanded={isExpanded}
          aria-controls={compactPanelId}
        >
          <span aria-hidden="true">↻</span>
          <span className="tabular-nums">{normalizedAngle}°</span>
          <span className="text-[10px]" aria-hidden="true">
            {isExpanded ? "▴" : "▾"}
          </span>
        </button>
        {isExpanded && (
          <div
            id={compactPanelId}
            className="absolute right-0 top-full z-30 mt-1 flex w-max max-w-[calc(100vw-1rem)] items-center gap-1.5 rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-600 dark:bg-slate-800"
            data-testid="map-rotation-popover"
            role="group"
            aria-label="回転操作"
          >
            {adjustmentControls}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-600 bg-white/90 dark:bg-slate-800/90 px-2 py-1 ${className}`}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="px-1.5 py-1 text-xs rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600"
        title={toggleTitle}
        aria-label={toggleTitle}
        aria-expanded={isExpanded}
      >
        {isExpanded ? "▾" : "▸"}
      </button>
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
        回転
      </span>
      <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 w-10 text-right">
        {normalizedAngle}°
      </div>
      {isExpanded && adjustmentControls}
    </div>
  );
};

export default MapRotationControls;
