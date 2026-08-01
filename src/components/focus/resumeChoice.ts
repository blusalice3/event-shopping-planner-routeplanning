import type { FocusModeSessionState, FocusPhase } from "../../types/focus";
import type { ShoppingItem } from "../../types/item";

// VisitGroup をそのまま import できないため、必要最小限のフィールドだけを型定義する。
// 実際の FocusMode 側の VisitGroup (items: ShoppingItem[]) は structural 互換で受け渡し可能。
export type ResumeVisitGroup = {
  key: string;
  items: Array<Pick<ShoppingItem, "block" | "number" | "circle">>;
};

export interface ResumeChoiceDialogState {
  isOpen: boolean;
  lastSpaceLabel: string;
  lastPhase: FocusPhase;
  lastIndex: number;
  pointerPhase: FocusPhase;
  pointerIndex: number;
  phaseStartPhase: FocusPhase;
  lastChangeEnabled: boolean;
  phaseStartEnabled: boolean;
  normalStartEnabled: boolean;
  wasCompleted: boolean;
}

/**
 * 再開ダイアログの state を算出する純粋関数。
 * 初回 resumeState の snapshot と現在の visitsByPhase から決定論的に state を作る。
 */
export function buildResumeChoiceDialogState(args: {
  initialResumeState: FocusModeSessionState | null | undefined;
  visitsByPhase: Record<FocusPhase, ResumeVisitGroup[]>;
  currentPhase: FocusPhase;
}): ResumeChoiceDialogState | null {
  const snapshot = args.initialResumeState;
  if (!snapshot) return null;

  const totalVisits =
    args.visitsByPhase.normal.length +
    args.visitsByPhase.postponed.length +
    args.visitsByPhase.late.length;
  if (totalVisits === 0) return null;

  const lpc = snapshot.lastPurchaseChangeAt ?? null;
  const wasCompleted = snapshot.isCompleted === true;
  if (!lpc && !wasCompleted) return null;

  let exactLastChangeIndex: number | null = null;
  if (lpc) {
    const visits = args.visitsByPhase[lpc.phase];
    if (visits.length > 0) {
      const idx = visits.findIndex((v) => v.key === lpc.visitKey);
      if (idx >= 0) exactLastChangeIndex = idx;
    }
  }

  const lastChangeEnabled = exactLastChangeIndex !== null;

  let lastSpaceLabel = "対象スペースが現在の並びに見つかりません";
  if (lastChangeEnabled && lpc) {
    const visits = args.visitsByPhase[lpc.phase];
    const firstItem = visits[exactLastChangeIndex as number]?.items?.[0];
    if (firstItem) {
      lastSpaceLabel =
        `${firstItem.block}-${firstItem.number} ${firstItem.circle ?? ""}`.trim();
    }
  }

  return {
    isOpen: true,
    lastSpaceLabel,
    lastPhase: lpc?.phase ?? snapshot.phase,
    lastIndex: lastChangeEnabled ? (exactLastChangeIndex as number) : 0,
    pointerPhase: snapshot.phase,
    pointerIndex: Math.max(0, snapshot.phaseIndex ?? 0),
    phaseStartPhase: args.currentPhase,
    lastChangeEnabled,
    phaseStartEnabled: args.visitsByPhase[args.currentPhase].length > 0,
    normalStartEnabled: args.visitsByPhase.normal.length > 0,
    wasCompleted,
  };
}

export interface ResumeChoiceResult {
  phase?: FocusPhase;
  phaseIndex?: number;
  isCompleted?: boolean;
}

/**
 * 再開ダイアログの選択から、適用すべき state の差分を算出する純粋関数。
 */
export function resolveResumeChoice(
  choice: "lastChange" | "pointer" | "phaseStart" | "normalStart",
  dialog: ResumeChoiceDialogState,
): ResumeChoiceResult {
  if (choice === "lastChange" && dialog.lastChangeEnabled) {
    return { phase: dialog.lastPhase, phaseIndex: dialog.lastIndex };
  }
  if (choice === "pointer") {
    const result: ResumeChoiceResult = {
      phase: dialog.pointerPhase,
      phaseIndex: dialog.pointerIndex,
    };
    if (dialog.wasCompleted) result.isCompleted = true;
    return result;
  }
  if (choice === "phaseStart" && dialog.phaseStartEnabled) {
    return { phase: dialog.phaseStartPhase, phaseIndex: 0 };
  }
  if (choice === "normalStart" && dialog.normalStartEnabled) {
    return { phase: "normal", phaseIndex: 0 };
  }
  return {};
}
