import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  layoutMode: "pc" | "smartphone";
  side: SpaceNavigatorSide;
  onCandidateChange: (index: number) => void;
  onSelect: (index: number) => void;
  onClose: () => void;
}

const ROW_HEIGHT = 68;
const FULL_WINDOW_RADIUS = 3;
const COMPACT_WINDOW_RADIUS = 2;
const COMPACT_SHEET_HEIGHT = 660;
const WHEEL_LINE_HEIGHT = 16;
const WHEEL_STEP_THRESHOLD = ROW_HEIGHT / 2;

const getInitialWindowRadius = () =>
  typeof window !== "undefined" && window.innerHeight < COMPACT_SHEET_HEIGHT
    ? COMPACT_WINDOW_RADIUS
    : FULL_WINDOW_RADIUS;

const windowRadiusFromHeight = (height: number) => {
  const rowCount = Math.max(5, Math.floor(height / ROW_HEIGHT));
  const oddRowCount = rowCount % 2 === 0 ? rowCount - 1 : rowCount;
  return (oddRowCount - 1) / 2;
};

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
  layoutMode,
  side,
  onCandidateChange,
  onSelect,
  onClose,
}: SpaceNavigatorPickerProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startIndex: number;
    hasPointerCapture: boolean;
  } | null>(null);
  const didDragRef = useRef(false);
  const wheelDeltaRef = useRef(0);
  const candidateIndexRef = useRef(candidateIndex);
  const [windowRadius, setWindowRadius] = useState(getInitialWindowRadius);
  candidateIndexRef.current = candidateIndex;

  useEffect(() => {
    if (layoutMode === "smartphone") return;

    const updateWindowRadius = () => {
      const measuredHeight =
        listRef.current?.getBoundingClientRect().height ?? 0;
      const nextRadius =
        measuredHeight > 0
          ? windowRadiusFromHeight(measuredHeight)
          : getInitialWindowRadius();
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
    if (listRef.current) observer?.observe(listRef.current);

    return () => {
      window.removeEventListener("resize", updateWindowRadius);
      observer?.disconnect();
    };
  }, [layoutMode]);

  const rows = useMemo(() => {
    if (layoutMode === "smartphone") {
      return entries.map((entry, index) => ({ index, entry }));
    }

    const visibleRowCount = Math.min(entries.length, windowRadius * 2 + 1);
    const maxWindowStart = Math.max(0, entries.length - visibleRowCount);
    const windowStart = Math.min(
      Math.max(candidateIndex - windowRadius, 0),
      maxWindowStart,
    );

    return Array.from({ length: visibleRowCount }, (_, offset) => {
      const index = windowStart + offset;
      return { index, entry: entries[index] };
    });
  }, [candidateIndex, entries, layoutMode, windowRadius]);
  const selectedRowIndex = Math.max(
    0,
    rows.findIndex(({ index }) => index === candidateIndex),
  );

  useLayoutEffect(() => {
    if (layoutMode !== "smartphone") return;
    const selectedRow = selectedRowRef.current;
    const list = listRef.current;
    if (!selectedRow || !list) return;

    if (typeof selectedRow.scrollIntoView === "function") {
      selectedRow.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }

    list.scrollTop = Math.max(
      0,
      selectedRow.offsetTop -
        Math.max(0, (list.clientHeight - selectedRow.offsetHeight) / 2),
    );
  }, [candidateIndex, entries.length, layoutMode]);

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
          ref={listRef}
          className={`relative mx-3 my-3 min-h-0 flex-1 select-none rounded-xl border border-slate-200 bg-slate-100/70 dark:border-slate-700 dark:bg-slate-950/50 ${
            layoutMode === "smartphone"
              ? "block overflow-y-auto overscroll-contain"
              : "grid overflow-hidden"
          }`}
          style={
            layoutMode === "smartphone"
              ? {
                  touchAction: "pan-y",
                  WebkitOverflowScrolling: "touch",
                }
              : {
                  gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))`,
                  touchAction: "none",
                }
          }
          data-testid="space-navigator-window"
          data-visible-row-count={rows.length}
          data-scroll-mode={
            layoutMode === "smartphone" ? "native" : "candidate"
          }
          onClick={(event) => {
            if (layoutMode === "smartphone") return;
            if (event.target === event.currentTarget && didDragRef.current) {
              didDragRef.current = false;
            }
          }}
          onWheel={(event) => {
            if (layoutMode === "smartphone" || event.deltaY === 0) return;
            event.stopPropagation();
            const deltaScale =
              event.deltaMode === 1
                ? WHEEL_LINE_HEIGHT
                : event.deltaMode === 2
                  ? event.currentTarget.getBoundingClientRect().height ||
                    window.innerHeight
                  : 1;
            const normalizedDelta = event.deltaY * deltaScale;
            if (
              wheelDeltaRef.current !== 0 &&
              Math.sign(wheelDeltaRef.current) !== Math.sign(normalizedDelta)
            ) {
              wheelDeltaRef.current = 0;
            }
            wheelDeltaRef.current += normalizedDelta;
            if (Math.abs(wheelDeltaRef.current) < WHEEL_STEP_THRESHOLD) return;
            const direction = Math.sign(wheelDeltaRef.current);
            wheelDeltaRef.current = 0;
            const nextIndex = clampCandidateIndex(
              candidateIndexRef.current + direction,
              entries.length,
            );
            candidateIndexRef.current = nextIndex;
            onCandidateChange(nextIndex);
          }}
          onPointerDown={(event) => {
            if (layoutMode === "smartphone") return;
            dragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startIndex: candidateIndex,
              hasPointerCapture: false,
            };
            didDragRef.current = false;
          }}
          onPointerMove={(event) => {
            if (layoutMode === "smartphone") return;
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (event.pointerType === "mouse" && event.buttons === 0) {
              dragRef.current = null;
              didDragRef.current = false;
              return;
            }
            const delta = drag.startY - event.clientY;
            if (Math.abs(delta) > 5) {
              didDragRef.current = true;
              if (!drag.hasPointerCapture) {
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.hasPointerCapture = true;
              }
            }
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
            if (layoutMode === "smartphone") return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            dragRef.current = null;
          }}
          onPointerLeave={(event) => {
            if (layoutMode === "smartphone") return;
            const drag = dragRef.current;
            if (
              drag &&
              drag.pointerId === event.pointerId &&
              !drag.hasPointerCapture
            ) {
              dragRef.current = null;
              didDragRef.current = false;
            }
          }}
          onPointerCancel={(event) => {
            if (layoutMode === "smartphone") return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            dragRef.current = null;
            didDragRef.current = false;
          }}
          onLostPointerCapture={(event) => {
            if (layoutMode === "smartphone") return;
            if (dragRef.current?.pointerId === event.pointerId) {
              dragRef.current = null;
            }
          }}
        >
          {layoutMode === "pc" && rows.length > 0 && (
            <div
              className="pointer-events-none absolute left-0 right-0 z-10 -translate-y-1/2 border-y-2 border-indigo-500 bg-indigo-100/20 dark:bg-indigo-400/10"
              style={{
                height: `${100 / rows.length}%`,
                top: `${((selectedRowIndex + 0.5) / rows.length) * 100}%`,
              }}
              data-testid="space-navigator-selection"
            />
          )}
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
                ref={
                  layoutMode === "smartphone" && isSelected
                    ? selectedRowRef
                    : undefined
                }
                type="button"
                className={`relative z-20 flex w-full items-center gap-3 overflow-hidden border-b border-slate-200/70 px-3 text-left transition-colors last:border-b-0 dark:border-slate-700/70 ${
                  layoutMode === "smartphone" ? "min-h-[68px]" : "min-h-0"
                } ${
                  isSelected
                    ? `font-semibold text-indigo-950 dark:text-indigo-100 ${
                        layoutMode === "smartphone"
                          ? "bg-indigo-100/70 dark:bg-indigo-900/40"
                          : ""
                      }`
                    : "text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-800/70"
                }`}
                onClick={() => {
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  candidateIndexRef.current = index;
                  onCandidateChange(index);
                  onSelect(index);
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
          {layoutMode === "pc"
            ? "ホイールまたは上下ドラッグで候補を移動し、スペースをクリックしてください。"
            : "一覧を上下にスクロールして、移動先のスペースをタップしてください。"}
        </p>
      </section>
    </div>
  );
}
