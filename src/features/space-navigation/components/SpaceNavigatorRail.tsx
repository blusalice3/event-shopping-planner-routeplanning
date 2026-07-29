import React, { useCallback, useRef } from "react";
import type { NavigatorEntry } from "../types";
import type { SpaceNavigatorSide } from "../hooks/useSpaceNavigatorSettings";
import {
  candidateIndexFromCoordinate,
  clampCandidateIndex,
} from "../domain/candidateIndex";
import { NAVIGATOR_STATUS_COLORS } from "./SpaceNavigatorLegend";

export const SPACE_NAVIGATOR_RAIL_WIDTH_PX = 16;

interface SpaceNavigatorRailProps {
  entries: readonly NavigatorEntry[];
  currentIndex: number;
  formalIndex: number;
  candidateIndex: number;
  side: SpaceNavigatorSide;
  onCandidateChange: (index: number) => void;
  onOpen: () => void;
}

const getEntryBackground = (entry: NavigatorEntry) => {
  if (entry.statusSegments.length === 0)
    return NAVIGATOR_STATUS_COLORS.unvisited;
  const stops = entry.statusSegments.flatMap((segment) => {
    const color = NAVIGATOR_STATUS_COLORS[segment.kind];
    return [
      `${color} ${segment.startRatio * 100}%`,
      `${color} ${segment.endRatio * 100}%`,
    ];
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
};

export function SpaceNavigatorRail({
  entries,
  currentIndex,
  formalIndex,
  candidateIndex,
  side,
  onCandidateChange,
  onOpen,
}: SpaceNavigatorRailProps) {
  const railRef = useRef<HTMLDivElement>(null);

  const updateFromClientY = useCallback(
    (clientY: number) => {
      const rect = railRef.current?.getBoundingClientRect();
      if (!rect || rect.height <= 0 || entries.length === 0) return;
      onCandidateChange(
        candidateIndexFromCoordinate({
          coordinate: clientY,
          start: rect.top,
          end: rect.bottom,
          count: entries.length,
        }),
      );
    },
    [entries.length, onCandidateChange],
  );

  return (
    <div
      className={`fixed top-[env(safe-area-inset-top)] z-[45] flex items-stretch ${
        side === "left" ? "left-0 justify-start" : "right-0 justify-end"
      }`}
      style={{
        bottom: "var(--footer-height, 0px)",
        width: `${SPACE_NAVIGATOR_RAIL_WIDTH_PX}px`,
      }}
      aria-label="スペースナビ"
    >
      <div
        ref={railRef}
        className="relative h-full bg-transparent"
        style={{
          touchAction: "none",
          width: `${SPACE_NAVIGATOR_RAIL_WIDTH_PX}px`,
        }}
        role="slider"
        tabIndex={0}
        aria-label="スペースナビ"
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={entries.length}
        aria-valuenow={clampCandidateIndex(candidateIndex, entries.length) + 1}
        aria-valuetext={
          entries[clampCandidateIndex(candidateIndex, entries.length)]?.label
        }
        onKeyDown={(event) => {
          const currentCandidate = clampCandidateIndex(
            candidateIndex,
            entries.length,
          );
          let nextCandidate: number | null = null;
          switch (event.key) {
            case "ArrowUp":
              nextCandidate = clampCandidateIndex(
                currentCandidate - 1,
                entries.length,
              );
              break;
            case "ArrowDown":
              nextCandidate = clampCandidateIndex(
                currentCandidate + 1,
                entries.length,
              );
              break;
            case "Home":
              nextCandidate = 0;
              break;
            case "End":
              nextCandidate = Math.max(0, entries.length - 1);
              break;
            case "Enter":
            case " ":
              nextCandidate = currentCandidate;
              break;
            default:
              break;
          }
          if (nextCandidate === null) return;
          event.preventDefault();
          onCandidateChange(nextCandidate);
          onOpen();
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientY(event.clientY);
          onOpen();
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.preventDefault();
          updateFromClientY(event.clientY);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          updateFromClientY(event.clientY);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      >
        <div
          className={`pointer-events-none absolute top-0 flex h-full flex-col overflow-hidden border-x border-white/60 bg-slate-200 shadow-md dark:border-slate-700/70 dark:bg-slate-700 ${
            side === "left" ? "left-0" : "right-0"
          }`}
          style={{ width: `${SPACE_NAVIGATOR_RAIL_WIDTH_PX}px` }}
        >
          {entries.map((entry, index) => {
            const phaseBoundary =
              index > 0 && entries[index - 1]?.phase !== entry.phase;
            return (
              <span
                key={entry.id}
                className={`relative min-h-0 flex-1 ${
                  phaseBoundary
                    ? "border-t-2 border-white dark:border-slate-950"
                    : ""
                }`}
                style={{ background: getEntryBackground(entry) }}
                title={entry.label}
              >
                {entry.warningKinds.length > 0 && (
                  <span
                    className="pointer-events-none absolute inset-0"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(135deg, rgba(245,158,11,.95) 0 1px, transparent 1px 4px)",
                    }}
                  />
                )}
                {index === formalIndex && (
                  <span
                    className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-white dark:ring-slate-950"
                    title="正式な現在地"
                  />
                )}
                {index === currentIndex && (
                  <span className="pointer-events-none absolute inset-0">
                    <span
                      className={`absolute top-1/2 h-0 w-0 -translate-y-1/2 border-y-[4px] border-y-transparent ${
                        side === "left"
                          ? "left-0 border-l-[6px] border-l-white dark:border-l-slate-950"
                          : "right-0 border-r-[6px] border-r-white dark:border-r-slate-950"
                      }`}
                    />
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
