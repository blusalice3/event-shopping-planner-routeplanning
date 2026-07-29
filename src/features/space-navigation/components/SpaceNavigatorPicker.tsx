import React, { useEffect, useMemo, useRef, useState } from "react";
import type { NavigatorEntry, NavigatorStatusKind } from "../types";
import type { SpaceNavigatorSide } from "../hooks/useSpaceNavigatorSettings";
import { clampCandidateIndex } from "../domain/candidateIndex";
import {
  NAVIGATOR_STATUS_COLORS,
  SpaceNavigatorLegend,
} from "./SpaceNavigatorLegend";

interface SpaceNavigatorPickerProps {
  entries: readonly NavigatorEntry[];
  candidateIndex: number;
  side: SpaceNavigatorSide;
  onCandidateChange: (index: number) => void;
  onSelect: () => void;
  onClose: () => void;
}

const ROW_HEIGHT = 68;
const FULL_WINDOW_RADIUS = 3;
const COMPACT_WINDOW_RADIUS = 2;
const COMPACT_SHEET_HEIGHT = 660;

const getInitialWindowRadius = () =>
  typeof window !== "undefined" && window.innerHeight < COMPACT_SHEET_HEIGHT
    ? COMPACT_WINDOW_RADIUS
    : FULL_WINDOW_RADIUS;

const phaseLabels = {
  normal: "通常",
  postponed: "後回し",
  late: "遅参",
} as const;

const statusAbbreviations: Record<NavigatorStatusKind, string> = {
  unvisited: "未",
  postponed: "後",
  late: "遅",
  limited: "限",
  completed: "完",
};

export function SpaceNavigatorPicker({
  entries,
  candidateIndex,
  side,
  onCandidateChange,
  onSelect,
  onClose,
}: SpaceNavigatorPickerProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startIndex: number;
  } | null>(null);
  const didDragRef = useRef(false);
  const [windowRadius, setWindowRadius] = useState(getInitialWindowRadius);

  useEffect(() => {
    const updateWindowRadius = () => {
      const measuredHeight =
        sheetRef.current?.getBoundingClientRect().height ?? 0;
      const availableHeight =
        measuredHeight > 0 ? measuredHeight : window.innerHeight;
      const nextRadius =
        availableHeight < COMPACT_SHEET_HEIGHT
          ? COMPACT_WINDOW_RADIUS
          : FULL_WINDOW_RADIUS;
      setWindowRadius((currentRadius) =>
        currentRadius === nextRadius ? currentRadius : nextRadius,
      );
    };

    updateWindowRadius();
    window.addEventListener("resize", updateWindowRadius);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateWindowRadius);
    if (sheetRef.current) observer?.observe(sheetRef.current);

    return () => {
      window.removeEventListener("resize", updateWindowRadius);
      observer?.disconnect();
    };
  }, []);

  const rows = useMemo(
    () =>
      Array.from({ length: windowRadius * 2 + 1 }, (_, offset) => {
        const index = candidateIndex + offset - windowRadius;
        return { index, entry: entries[index] };
      }),
    [candidateIndex, entries, windowRadius],
  );

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/35 backdrop-blur-[1px]"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={sheetRef}
        className={`fixed top-[env(safe-area-inset-top)] flex w-[90vw] max-w-[420px] flex-col overflow-hidden bg-white/95 shadow-2xl dark:bg-slate-900/95 ${
          side === "left" ? "left-0 rounded-r-2xl" : "right-0 rounded-l-2xl"
        }`}
        style={{ bottom: "var(--footer-height, 0px)" }}
        role="dialog"
        aria-modal="true"
        aria-label="スペース一覧"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <div>
            <h2 className="font-bold text-slate-900 dark:text-white">
              スペース一覧
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {candidateIndex + 1} / {entries.length} 訪問
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 min-w-11 rounded-full text-xl text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="スペース一覧を閉じる"
          >
            ×
          </button>
        </header>

        <div className="shrink-0 px-4 py-2">
          <SpaceNavigatorLegend compact />
        </div>

        <div
          className="relative mx-3 my-3 grid min-h-0 flex-1 select-none overflow-hidden rounded-xl border border-slate-200 bg-slate-100/70 dark:border-slate-700 dark:bg-slate-950/50"
          style={{
            maxHeight: ROW_HEIGHT * rows.length,
            gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))`,
            touchAction: "none",
          }}
          data-testid="space-navigator-window"
          data-visible-row-count={rows.length}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startIndex: candidateIndex,
            };
            didDragRef.current = false;
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const delta = drag.startY - event.clientY;
            if (Math.abs(delta) > 5) didDragRef.current = true;
            const measuredRowHeight =
              event.currentTarget.getBoundingClientRect().height / rows.length;
            onCandidateChange(
              clampCandidateIndex(
                drag.startIndex +
                  Math.round(
                    delta /
                      (measuredRowHeight > 0 ? measuredRowHeight : ROW_HEIGHT),
                  ),
                entries.length,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            dragRef.current = null;
          }}
          onPointerCancel={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            dragRef.current = null;
          }}
        >
          <div
            className="pointer-events-none absolute left-0 right-0 top-1/2 z-10 -translate-y-1/2 border-y-2 border-indigo-500 bg-indigo-100/20 dark:bg-indigo-400/10"
            style={{ height: `${100 / rows.length}%` }}
          />
          {rows.map(({ index, entry }, rowIndex) => {
            const isSelected = index === candidateIndex;
            if (!entry) {
              return <div key={`empty-${rowIndex}`} className="min-h-0" />;
            }
            const visibleCircles = entry.circles.slice(0, 2);
            const otherCircleCount = Math.max(
              0,
              entry.circles.length - visibleCircles.length,
            );
            return (
              <button
                key={`${entry.id}-${rowIndex}`}
                type="button"
                className={`relative z-20 flex min-h-0 w-full items-center gap-3 overflow-hidden border-b border-slate-200/70 px-3 text-left transition-colors last:border-b-0 dark:border-slate-700/70 ${
                  isSelected
                    ? "font-semibold text-indigo-950 dark:text-indigo-100"
                    : "text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-800/70"
                }`}
                onClick={() => {
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  if (isSelected) onSelect();
                  else
                    onCandidateChange(
                      clampCandidateIndex(
                        candidateIndex + Math.sign(index - candidateIndex),
                        entries.length,
                      ),
                    );
                }}
                aria-current={isSelected ? "true" : undefined}
              >
                <span className="w-9 shrink-0 text-center text-xs text-slate-500 dark:text-slate-400">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-bold">{entry.label}</span>
                    {entry.phase && (
                      <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] dark:bg-slate-700">
                        {phaseLabels[entry.phase]}
                      </span>
                    )}
                    {entry.priorityLevel !== "none" && (
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
                        {entry.priorityLevel === "highest" ? "最優先" : "優先"}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs font-normal text-slate-500 dark:text-slate-400">
                    {visibleCircles.join("・")}
                    {otherCircleCount > 0 ? `・ほか${otherCircleCount}件` : ""}
                  </span>
                </span>
                <span className="flex max-w-[92px] flex-wrap justify-end gap-1">
                  {entry.statusSegments.map((segment) => (
                    <span
                      key={segment.kind}
                      className="rounded px-1 py-0.5 text-[10px] font-bold text-white"
                      style={{
                        backgroundColor: NAVIGATOR_STATUS_COLORS[segment.kind],
                      }}
                      title={`${statusAbbreviations[segment.kind]} ${segment.count}件`}
                    >
                      {statusAbbreviations[segment.kind]}
                      {segment.count}
                    </span>
                  ))}
                  {entry.warningKinds.length > 0 && (
                    <span
                      className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/60 dark:text-amber-100"
                      title="入力警告があります"
                    >
                      ⚠
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <p className="shrink-0 px-4 pb-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
          一覧を上下にドラッグし、中央の行をタップしてください。指を離しただけでは移動しません。
        </p>
      </section>
    </div>
  );
}
