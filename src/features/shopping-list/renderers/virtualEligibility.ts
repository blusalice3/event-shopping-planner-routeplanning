export type VirtualListIneligibilityReason =
  | "runtime-unavailable"
  | "column-count-unknown"
  | "multiple-columns"
  | "zoom-unknown"
  | "zoom-unsupported"
  | "drag-state-unknown"
  | "drag-active"
  | "modal-state-unknown"
  | "modal-active"
  | "recovery-state-unknown"
  | "recovery-active"
  | "row-count-unknown"
  | "list-too-short"
  | "row-height-unknown"
  | "row-height-unstable"
  | "focus-restoration-unknown"
  | "focus-restoration-unavailable"
  | "row-keys-unstable";

export interface VirtualListEligibilityInput {
  readonly runtimeAvailable: boolean;
  readonly columnCount: number | null;
  readonly zoomPercent: number | null;
  readonly supportedZoomPercents: readonly number[];
  readonly dragActive: boolean | null;
  readonly modalActive: boolean | null;
  readonly recoveryActive: boolean | null;
  readonly rowCount: number | null;
  readonly minimumRowCount: number;
  readonly rowHeightPx: number | null;
  readonly stableRowHeight: boolean | null;
  readonly focusRestorationReady: boolean | null;
  readonly stableRowKeys: boolean;
}

export type VirtualListEligibility =
  | {
      readonly eligible: true;
      readonly reason: null;
      readonly rowHeightPx: number;
    }
  | {
      readonly eligible: false;
      readonly reason: VirtualListIneligibilityReason;
      readonly rowHeightPx: null;
    };

const ineligible = (
  reason: VirtualListIneligibilityReason,
): VirtualListEligibility => ({
  eligible: false,
  reason,
  rowHeightPx: null,
});

export const evaluateVirtualListEligibility = ({
  runtimeAvailable,
  columnCount,
  zoomPercent,
  supportedZoomPercents,
  dragActive,
  modalActive,
  recoveryActive,
  rowCount,
  minimumRowCount,
  rowHeightPx,
  stableRowHeight,
  focusRestorationReady,
  stableRowKeys,
}: VirtualListEligibilityInput): VirtualListEligibility => {
  if (!runtimeAvailable) return ineligible("runtime-unavailable");
  if (columnCount === null) return ineligible("column-count-unknown");
  if (columnCount !== 1) return ineligible("multiple-columns");
  if (zoomPercent === null) return ineligible("zoom-unknown");
  if (!supportedZoomPercents.includes(zoomPercent)) {
    return ineligible("zoom-unsupported");
  }
  if (dragActive === null) return ineligible("drag-state-unknown");
  if (dragActive) return ineligible("drag-active");
  if (modalActive === null) return ineligible("modal-state-unknown");
  if (modalActive) return ineligible("modal-active");
  if (recoveryActive === null) return ineligible("recovery-state-unknown");
  if (recoveryActive) return ineligible("recovery-active");
  if (rowCount === null || !Number.isInteger(rowCount) || rowCount < 0) {
    return ineligible("row-count-unknown");
  }
  if (
    !Number.isInteger(minimumRowCount) ||
    minimumRowCount <= 0 ||
    rowCount < minimumRowCount
  ) {
    return ineligible("list-too-short");
  }
  if (rowHeightPx === null || rowHeightPx <= 0) {
    return ineligible("row-height-unknown");
  }
  if (stableRowHeight === null) return ineligible("row-height-unknown");
  if (!stableRowHeight) return ineligible("row-height-unstable");
  if (focusRestorationReady === null) {
    return ineligible("focus-restoration-unknown");
  }
  if (!focusRestorationReady) {
    return ineligible("focus-restoration-unavailable");
  }
  if (!stableRowKeys) return ineligible("row-keys-unstable");

  return { eligible: true, reason: null, rowHeightPx };
};
