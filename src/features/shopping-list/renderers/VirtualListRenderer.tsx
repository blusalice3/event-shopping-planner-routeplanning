import {
  defaultRangeExtractor,
  useWindowVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ShoppingListReadModel,
  ShoppingListRow,
} from "../model/buildListRows";
import type { ListScrollRequest } from "../controller/listController";
import { getShoppingListRowAccessibilityAttributes } from "./rowAccessibility";

export interface VirtualListWindow {
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly beforeSpacer: React.ReactNode;
  readonly afterSpacer: React.ReactNode;
}

interface VirtualListRendererBaseProps {
  readonly model: ShoppingListReadModel;
  readonly renderRow: (row: ShoppingListRow, index: number) => React.ReactNode;
  readonly accessibleLabel: string;
}

interface VirtualListWindowRendererProps extends VirtualListRendererBaseProps {
  readonly window: VirtualListWindow;
  readonly estimateSizePx?: never;
}

interface VirtualListRuntimeRendererProps extends VirtualListRendererBaseProps {
  readonly window?: never;
  readonly estimateSizePx: number;
  readonly overscan?: number;
  readonly gapPx?: number;
  readonly className?: string;
  readonly beforeContent?: React.ReactNode;
  readonly rootRef?: React.Ref<HTMLDivElement>;
  readonly onDragLeave?: React.DragEventHandler<HTMLDivElement>;
  readonly focusedRowKey?: string | null;
  readonly scrollRequest?: ListScrollRequest | null;
  readonly onFocusedRowKeyChange?: (rowKey: string | null) => void;
  readonly onScrollRequestConsumed?: (requestId: number) => void;
}

export type VirtualListRendererProps =
  | VirtualListWindowRendererProps
  | VirtualListRuntimeRendererProps;

const isValidWindow = (
  model: ShoppingListReadModel,
  window: VirtualListWindow,
): boolean =>
  Number.isInteger(window.startIndex) &&
  Number.isInteger(window.endIndexExclusive) &&
  window.startIndex >= 0 &&
  window.endIndexExclusive >= window.startIndex &&
  window.endIndexExclusive <= model.rows.length;

export const extractVirtualIndexesWithPinnedFocus = (
  range: Range,
  focusedIndex: number | null,
): number[] => {
  const indexes = defaultRangeExtractor(range);
  if (
    focusedIndex === null ||
    focusedIndex < 0 ||
    focusedIndex >= range.count ||
    indexes.includes(focusedIndex)
  ) {
    return indexes;
  }
  return [...indexes, focusedIndex].sort((left, right) => left - right);
};

interface FocusSnapshot {
  readonly rowKey: string;
  readonly focusableIndex: number;
}

export interface VirtualScrollAnchor {
  readonly rowKey: string;
  readonly offsetWithinRow: number;
}

export const resolveVirtualScrollAnchorOffset = (
  anchor: VirtualScrollAnchor,
  rowIndexByKey: ReadonlyMap<string, number>,
  getOffsetForIndex: (
    index: number,
  ) => readonly [number, "auto" | "start" | "center" | "end"] | undefined,
): number | null => {
  const nextIndex = rowIndexByKey.get(anchor.rowKey);
  if (nextIndex === undefined) return null;
  const target = getOffsetForIndex(nextIndex);
  return target ? Math.max(0, target[0] + anchor.offsetWithinRow) : null;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const getFocusableElements = (rowElement: HTMLElement): HTMLElement[] =>
  Array.from(rowElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

const assignRef = <T,>(
  ref: React.Ref<T> | undefined,
  value: T | null,
): void => {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
};

interface MeasuredVirtualRowProps {
  readonly modelRow: ShoppingListRow;
  readonly virtualItem: VirtualItem;
  readonly scrollMargin: number;
  readonly measureElement: (node: HTMLDivElement | null) => void;
  readonly renderRow: (row: ShoppingListRow, index: number) => React.ReactNode;
}

const MeasuredVirtualRow = ({
  modelRow,
  virtualItem,
  scrollMargin,
  measureElement,
  renderRow,
}: MeasuredVirtualRowProps): React.ReactElement => {
  return (
    <div
      {...getShoppingListRowAccessibilityAttributes(modelRow)}
      ref={measureElement}
      data-index={virtualItem.index}
      data-layout-translate-y={`${Math.max(
        0,
        virtualItem.start - scrollMargin,
      )}px`}
      className="esp-virtual-list-row esp-layout-translate-y"
    >
      {renderRow(modelRow, virtualItem.index)}
    </div>
  );
};

const RuntimeVirtualListRenderer = ({
  model,
  renderRow,
  accessibleLabel,
  estimateSizePx,
  overscan = 8,
  gapPx = 8,
  className,
  beforeContent,
  rootRef: suppliedRootRef,
  onDragLeave,
  focusedRowKey: suppliedFocusedRowKey,
  scrollRequest,
  onFocusedRowKeyChange,
  onScrollRequestConsumed,
}: VirtualListRuntimeRendererProps): React.ReactElement => {
  const rootElementRef = useRef<HTMLDivElement | null>(null);
  const [rootElement, setRootElement] = useState<HTMLDivElement | null>(null);
  const [localFocusedRowKey, setLocalFocusedRowKey] = useState<string | null>(
    null,
  );
  const focusedRowKey =
    suppliedFocusedRowKey === undefined
      ? localFocusedRowKey
      : suppliedFocusedRowKey;
  const focusSnapshotRef = useRef<FocusSnapshot | null>(null);
  const scrollAnchorRef = useRef<VirtualScrollAnchor | null>(null);
  const previousRowKeySignatureRef = useRef<string | null>(null);

  const rowIndexByKey = useMemo(
    () => new Map(model.rows.map((row, index) => [row.rowKey, index])),
    [model.rows],
  );
  const focusedIndex =
    focusedRowKey === null ? null : (rowIndexByKey.get(focusedRowKey) ?? null);
  const rangeExtractor = useCallback(
    (range: Range) => extractVirtualIndexesWithPinnedFocus(range, focusedIndex),
    [focusedIndex],
  );
  const getItemKey = useCallback(
    (index: number) => model.rows[index]?.rowKey ?? `missing-row:${index}`,
    [model.rows],
  );
  const measureElement = useCallback(
    (element: HTMLDivElement, entry: ResizeObserverEntry | undefined) => {
      const borderBoxSize = entry?.borderBoxSize[0]?.blockSize;
      const measuredSize =
        typeof borderBoxSize === "number"
          ? borderBoxSize
          : element.getBoundingClientRect().height;
      return measuredSize > 0 ? measuredSize : estimateSizePx;
    },
    [estimateSizePx],
  );

  const scrollMargin = rootElement
    ? rootElement.getBoundingClientRect().top + window.scrollY
    : 0;
  const initialRect = useMemo(
    () => ({
      width: typeof window === "undefined" ? 0 : window.innerWidth,
      height: typeof window === "undefined" ? 0 : window.innerHeight,
    }),
    [],
  );
  const virtualizer = useWindowVirtualizer<HTMLDivElement>({
    count: model.rows.length,
    estimateSize: () => estimateSizePx,
    getItemKey,
    gap: gapPx,
    initialRect,
    measureElement,
    overscan,
    rangeExtractor,
    scrollMargin,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const rowKeySignature = useMemo(
    () => JSON.stringify(model.rows.map((row) => row.rowKey)),
    [model.rows],
  );

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootElementRef.current = node;
      setRootElement(node);
      assignRef(suppliedRootRef, node);
    },
    [suppliedRootRef],
  );

  const updateFocusedRowKey = useCallback(
    (rowKey: string | null) => {
      if (suppliedFocusedRowKey === undefined) {
        setLocalFocusedRowKey(rowKey);
      }
      onFocusedRowKeyChange?.(rowKey);
    },
    [onFocusedRowKeyChange, suppliedFocusedRowKey],
  );

  const clearFocusSnapshot = useCallback(() => {
    focusSnapshotRef.current = null;
    updateFocusedRowKey(null);
  }, [updateFocusedRowKey]);

  const handleFocusCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!(event.target instanceof HTMLElement)) return;
      const rowElement = event.target.closest<HTMLElement>("[data-row-key]");
      if (!rowElement || !rootElementRef.current?.contains(rowElement)) return;
      const rowKey = rowElement.dataset.rowKey;
      if (!rowKey) return;
      const focusableIndex = getFocusableElements(rowElement).indexOf(
        event.target,
      );
      focusSnapshotRef.current = { rowKey, focusableIndex };
      updateFocusedRowKey(rowKey);
    },
    [updateFocusedRowKey],
  );

  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        rootElementRef.current?.contains(nextTarget)
      ) {
        return;
      }
      if (nextTarget !== null) clearFocusSnapshot();
    },
    [clearFocusSnapshot],
  );

  useEffect(() => {
    const clearOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootElementRef.current?.contains(event.target)
      ) {
        clearFocusSnapshot();
      }
    };
    document.addEventListener("pointerdown", clearOnOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", clearOnOutsidePointer, true);
    };
  }, [clearFocusSnapshot]);

  useLayoutEffect(() => {
    const snapshot = focusSnapshotRef.current;
    if (!snapshot || !rowIndexByKey.has(snapshot.rowKey)) return;
    const activeElement = document.activeElement;
    if (
      activeElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement
    ) {
      return;
    }
    const rowElement = Array.from(
      rootElementRef.current?.querySelectorAll<HTMLElement>(
        ".esp-virtual-list-row[data-row-key]",
      ) ?? [],
    ).find((element) => element.dataset.rowKey === snapshot.rowKey);
    const focusTarget =
      rowElement && snapshot.focusableIndex >= 0
        ? getFocusableElements(rowElement)[snapshot.focusableIndex]
        : undefined;
    focusTarget?.focus({ preventScroll: true });
  }, [rowIndexByKey, virtualItems]);

  useEffect(() => {
    if (!scrollRequest) return;
    const rowIndex = rowIndexByKey.get(scrollRequest.rowKey);
    if (rowIndex !== undefined) {
      virtualizer.scrollToIndex(rowIndex, {
        align:
          scrollRequest.alignment === "nearest"
            ? "auto"
            : scrollRequest.alignment,
        behavior: "auto",
      });
    }
    onScrollRequestConsumed?.(scrollRequest.requestId);
  }, [onScrollRequestConsumed, rowIndexByKey, scrollRequest, virtualizer]);

  useLayoutEffect(() => {
    const previousSignature = previousRowKeySignatureRef.current;
    if (
      previousSignature !== null &&
      previousSignature !== rowKeySignature &&
      scrollAnchorRef.current
    ) {
      const anchor = scrollAnchorRef.current;
      const restoredOffset = resolveVirtualScrollAnchorOffset(
        anchor,
        rowIndexByKey,
        (index) => virtualizer.getOffsetForIndex(index, "start"),
      );
      if (restoredOffset !== null) {
        virtualizer.scrollToOffset(restoredOffset, { behavior: "auto" });
      }
      previousRowKeySignatureRef.current = rowKeySignature;
      return;
    }

    previousRowKeySignatureRef.current = rowKeySignature;
    const scrollOffset = virtualizer.scrollOffset;
    if (scrollOffset === null || scrollOffset < scrollMargin) return;
    const anchorItem = virtualItems.find((item) => item.end > scrollOffset);
    const anchorRow = anchorItem && model.rows[anchorItem.index];
    if (!anchorItem || !anchorRow) return;
    scrollAnchorRef.current = {
      rowKey: anchorRow.rowKey,
      offsetWithinRow: scrollOffset - anchorItem.start,
    };
  }, [
    model.rows,
    rowIndexByKey,
    rowKeySignature,
    scrollMargin,
    virtualItems,
    virtualizer,
  ]);

  const windowStart = virtualItems[0]?.index ?? 0;
  const windowEnd =
    virtualItems.length === 0
      ? 0
      : virtualItems[virtualItems.length - 1].index + 1;

  return (
    <div
      ref={setRootRef}
      role="list"
      aria-label={accessibleLabel}
      data-list-renderer="virtual"
      data-list-renderer-reason="virtual-eligible"
      data-list-row-count={model.rows.length}
      data-list-row-keys-stable={model.hasStableRowKeys ? "true" : "false"}
      data-list-window-start={windowStart}
      data-list-window-end={windowEnd}
      data-list-controller="shared"
      data-list-focused-row-key={focusedRowKey ?? undefined}
      className={`esp-virtual-list ${className ?? ""}`.trim()}
      onBlurCapture={handleBlurCapture}
      onDragLeave={onDragLeave}
      onFocusCapture={handleFocusCapture}
    >
      {beforeContent}
      <div
        className="esp-virtual-list-canvas esp-layout-height"
        data-layout-height={`${virtualizer.getTotalSize()}px`}
      >
        {virtualItems.map((virtualItem) => {
          const modelRow = model.rows[virtualItem.index];
          return modelRow ? (
            <MeasuredVirtualRow
              key={modelRow.rowKey}
              modelRow={modelRow}
              virtualItem={virtualItem}
              scrollMargin={scrollMargin}
              measureElement={virtualizer.measureElement}
              renderRow={renderRow}
            />
          ) : null;
        })}
      </div>
    </div>
  );
};

const WindowVirtualListRenderer = ({
  model,
  window,
  renderRow,
  accessibleLabel,
}: VirtualListWindowRendererProps): React.ReactElement => {
  if (!isValidWindow(model, window)) {
    throw new RangeError("Virtual list window is outside the canonical rows.");
  }
  const visibleRows = model.rows.slice(
    window.startIndex,
    window.endIndexExclusive,
  );

  return (
    <div
      role="list"
      aria-label={accessibleLabel}
      data-list-renderer="virtual"
      data-list-row-count={model.rows.length}
      data-list-window-start={window.startIndex}
      data-list-window-end={window.endIndexExclusive}
    >
      {window.beforeSpacer}
      {visibleRows.map((row, relativeIndex) => (
        <React.Fragment key={row.rowKey}>
          {renderRow(row, window.startIndex + relativeIndex)}
        </React.Fragment>
      ))}
      {window.afterSpacer}
    </div>
  );
};

/**
 * Audited dual boundary. Supplying `window` keeps the deterministic prototype
 * useful in unit tests; production supplies `estimateSizePx` and delegates
 * measurement, overscan, stable keys, focus pinning, and anchoring to TanStack.
 */
export const VirtualListRenderer = (
  props: VirtualListRendererProps,
): React.ReactElement => {
  if (props.window && !isValidWindow(props.model, props.window)) {
    throw new RangeError("Virtual list window is outside the canonical rows.");
  }
  return props.window ? (
    <WindowVirtualListRenderer {...props} />
  ) : (
    <RuntimeVirtualListRenderer {...props} />
  );
};
