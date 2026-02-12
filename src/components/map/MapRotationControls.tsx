import React, { useMemo } from 'react';

type MapRotationControlsProps = {
  angle: number;
  initialAngle: number;
  onAngleChange: (angle: number) => void;
  className?: string;
  sliderClassName?: string;
  showHint?: boolean;
};

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const MapRotationControls: React.FC<MapRotationControlsProps> = ({
  angle,
  initialAngle,
  onAngleChange,
  className = '',
  sliderClassName = '',
  showHint = false,
}) => {
  const normalizedAngle = useMemo(() => normalizeRotationAngle(angle), [angle]);
  const normalizedInitialAngle = useMemo(
    () => normalizeRotationAngle(initialAngle),
    [initialAngle],
  );

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-600 bg-white/90 dark:bg-slate-800/90 px-2 py-1 ${className}`}
    >
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
        回転
      </span>
      <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 w-10 text-right">
        {normalizedAngle}°
      </div>
      <input
        type="range"
        min={0}
        max={359}
        step={1}
        value={normalizedAngle}
        onChange={(e) => onAngleChange(normalizeRotationAngle(Number(e.target.value)))}
        className={`w-24 accent-blue-600 ${sliderClassName}`}
      />
      <button
        type="button"
        onClick={() => onAngleChange(normalizeRotationAngle(normalizedAngle + 15))}
        className="px-1.5 py-1 text-xs rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600"
        title="+15° (時計回り)"
      >
        +15
      </button>
      <button
        type="button"
        onClick={() => onAngleChange(normalizeRotationAngle(normalizedAngle + 45))}
        className="px-1.5 py-1 text-xs rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600"
        title="+45° (時計回り)"
      >
        +45
      </button>
      <button
        type="button"
        onClick={() => onAngleChange(normalizedInitialAngle)}
        className="px-1.5 py-1 text-xs rounded bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60"
        title={`初期角度(${normalizedInitialAngle}°)に戻す`}
      >
        リセット
      </button>
      {showHint && (
        <span className="text-[10px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
          Shift+ホイール
        </span>
      )}
    </div>
  );
};

export default MapRotationControls;
