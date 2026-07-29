export type FocusPhase = "normal" | "postponed" | "late";

export type FocusMapCenteringMode = "prevToCurrent" | "currentOnly";

export interface FocusMapViewportSnapshot {
  offsetX: number;
  offsetY: number;
  zoomLevel: number;
  rotationAngle: number;
}

export interface FocusMapViewportRestoreRequest {
  snapshot: FocusMapViewportSnapshot;
  revision: number;
}

export interface FocusModeSessionState {
  phase: FocusPhase;
  phaseIndex: number;
  savedPhaseIndices: Record<FocusPhase, number>;
  postponedItemIds: string[];
  lateItemIds: string[];
  isCompleted: boolean;
  lastPurchaseChangeAt?: {
    phase: FocusPhase;
    phaseIndex: number;
    visitKey: string;
  } | null;
}
