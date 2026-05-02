import { describe, expect, it } from 'vitest';
import {
  buildResumeChoiceDialogState,
  resolveResumeChoice,
  type ResumeChoiceDialogState,
  type ResumeVisitGroup,
} from './resumeChoice';
import type { FocusModeSessionState } from '../../types/focus';

const makeVisit = (
  key: string,
  block = 'A',
  number = '01a',
  circle = '',
): ResumeVisitGroup => ({
  key,
  items: [{ block, number, circle }],
});

const emptyVisits = { normal: [], postponed: [], late: [] } as Record<
  'normal' | 'postponed' | 'late',
  ResumeVisitGroup[]
>;

const threeVisits: Record<'normal' | 'postponed' | 'late', ResumeVisitGroup[]> = {
  normal: [
    makeVisit('2026-01-01-A-01a-none'),
    makeVisit('2026-01-01-A-02a-none'),
  ],
  postponed: [],
  late: [],
};

const mixedPhaseVisits: Record<'normal' | 'postponed' | 'late', ResumeVisitGroup[]> = {
  normal: [makeVisit('2026-01-01-A-01a-none')],
  postponed: [makeVisit('2026-01-01-P-03a-none', 'P', '03a', 'postponed circle')],
  late: [],
};

const baseCompletedSnapshot: FocusModeSessionState = {
  phase: 'normal',
  phaseIndex: 1,
  savedPhaseIndices: { normal: 1, postponed: 0, late: 0 },
  postponedItemIds: [],
  lateItemIds: [],
  isCompleted: true,
  lastPurchaseChangeAt: null,
};

describe('buildResumeChoiceDialogState', () => {
  it('完了済み + lpc あり → 全選択肢 + wasCompleted=true', () => {
    const snapshot: FocusModeSessionState = {
      ...baseCompletedSnapshot,
      lastPurchaseChangeAt: {
        phase: 'normal',
        phaseIndex: 0,
        visitKey: '2026-01-01-A-01a-none',
      },
    };
    const result = buildResumeChoiceDialogState({
      initialResumeState: snapshot,
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result).not.toBeNull();
    expect(result!.wasCompleted).toBe(true);
    expect(result!.lastChangeEnabled).toBe(true);
    expect(result!.phaseStartEnabled).toBe(true);
    expect(result!.normalStartEnabled).toBe(true);
    expect(result!.pointerPhase).toBe('normal');
    expect(result!.pointerIndex).toBe(1);
  });

  it('完了済み + lpc なし → ダイアログ表示、lastChange disabled、wasCompleted=true', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: baseCompletedSnapshot,
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result).not.toBeNull();
    expect(result!.wasCompleted).toBe(true);
    expect(result!.lastChangeEnabled).toBe(false);
  });

  it('完了済み + allVisits=0 → null', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: baseCompletedSnapshot,
      visitsByPhase: emptyVisits,
      currentPhase: 'normal',
    });
    expect(result).toBeNull();
  });

  it('未完了 + lpc なし → null', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: { ...baseCompletedSnapshot, isCompleted: false },
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result).toBeNull();
  });

  it('未完了 + lpc あり → 従来ダイアログ、wasCompleted=false', () => {
    const snapshot: FocusModeSessionState = {
      ...baseCompletedSnapshot,
      isCompleted: false,
      lastPurchaseChangeAt: {
        phase: 'normal',
        phaseIndex: 0,
        visitKey: '2026-01-01-A-01a-none',
      },
    };
    const result = buildResumeChoiceDialogState({
      initialResumeState: snapshot,
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result).not.toBeNull();
    expect(result!.wasCompleted).toBe(false);
    expect(result!.lastChangeEnabled).toBe(true);
  });

  it('initialResumeState=null → null', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: null,
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result).toBeNull();
  });

  it('phaseStartPhase はダイアログ生成時点の currentPhase が入る', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: baseCompletedSnapshot,
      visitsByPhase: threeVisits,
      currentPhase: 'late',
    });
    expect(result!.phaseStartPhase).toBe('late');
  });

  it('lpc の visitKey が現在の並びに存在する → lastChangeEnabled=true', () => {
    const snapshot: FocusModeSessionState = {
      ...baseCompletedSnapshot,
      lastPurchaseChangeAt: {
        phase: 'normal',
        phaseIndex: 0,
        visitKey: '2026-01-01-A-01a-none',
      },
    };
    const result = buildResumeChoiceDialogState({
      initialResumeState: snapshot,
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result!.lastChangeEnabled).toBe(true);
    expect(result!.lastIndex).toBe(0);
  });

  it('lpc の visitKey が現在の並びに見つからない → lastChangeEnabled=false', () => {
    const snapshot: FocusModeSessionState = {
      ...baseCompletedSnapshot,
      lastPurchaseChangeAt: {
        phase: 'normal',
        phaseIndex: 0,
        visitKey: 'missing-key',
      },
    };
    const result = buildResumeChoiceDialogState({
      initialResumeState: snapshot,
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result!.lastChangeEnabled).toBe(false);
    expect(result!.lastSpaceLabel).toBe('対象スペースが現在の並びに見つかりません');
  });
  it('lastChange can resume into postponed phase when visitKey still exists', () => {
    const snapshot: FocusModeSessionState = {
      ...baseCompletedSnapshot,
      phase: 'postponed',
      phaseIndex: 0,
      lastPurchaseChangeAt: {
        phase: 'postponed',
        phaseIndex: 0,
        visitKey: '2026-01-01-P-03a-none',
      },
    };
    const result = buildResumeChoiceDialogState({
      initialResumeState: snapshot,
      visitsByPhase: mixedPhaseVisits,
      currentPhase: 'normal',
    });
    expect(result).not.toBeNull();
    expect(result!.lastChangeEnabled).toBe(true);
    expect(result!.lastPhase).toBe('postponed');
    expect(result!.lastIndex).toBe(0);
    expect(result!.lastSpaceLabel).toBe('P-03a postponed circle');
  });

  it('phaseStart is disabled when current phase has no visits', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: baseCompletedSnapshot,
      visitsByPhase: mixedPhaseVisits,
      currentPhase: 'late',
    });
    expect(result).not.toBeNull();
    expect(result!.phaseStartPhase).toBe('late');
    expect(result!.phaseStartEnabled).toBe(false);
    expect(result!.normalStartEnabled).toBe(true);
  });

  it('negative saved pointer index is clamped to phase start', () => {
    const result = buildResumeChoiceDialogState({
      initialResumeState: { ...baseCompletedSnapshot, phaseIndex: -2 },
      visitsByPhase: threeVisits,
      currentPhase: 'normal',
    });
    expect(result).not.toBeNull();
    expect(result!.pointerIndex).toBe(0);
  });
});

describe('resolveResumeChoice', () => {
  const baseDialog: ResumeChoiceDialogState = {
    isOpen: true,
    lastSpaceLabel: 'A-01a',
    lastPhase: 'normal',
    lastIndex: 0,
    pointerPhase: 'late',
    pointerIndex: 2,
    phaseStartPhase: 'postponed',
    lastChangeEnabled: true,
    phaseStartEnabled: true,
    normalStartEnabled: true,
    wasCompleted: true,
  };

  it('pointer + wasCompleted=true → isCompleted=true 含む', () => {
    const r = resolveResumeChoice('pointer', baseDialog);
    expect(r).toEqual({ phase: 'late', phaseIndex: 2, isCompleted: true });
  });

  it('pointer + wasCompleted=false → isCompleted なし', () => {
    const r = resolveResumeChoice('pointer', { ...baseDialog, wasCompleted: false });
    expect(r).toEqual({ phase: 'late', phaseIndex: 2 });
  });

  it('lastChange + enabled → lastPhase/lastIndex', () => {
    const r = resolveResumeChoice('lastChange', baseDialog);
    expect(r).toEqual({ phase: 'normal', phaseIndex: 0 });
  });

  it('lastChange + disabled → 空', () => {
    const r = resolveResumeChoice('lastChange', { ...baseDialog, lastChangeEnabled: false });
    expect(r).toEqual({});
  });

  it('phaseStart → phaseStartPhase と phaseIndex=0 を返す', () => {
    const r = resolveResumeChoice('phaseStart', baseDialog);
    expect(r).toEqual({ phase: 'postponed', phaseIndex: 0 });
  });

  it('phaseStart + disabled → 空', () => {
    const r = resolveResumeChoice('phaseStart', { ...baseDialog, phaseStartEnabled: false });
    expect(r).toEqual({});
  });

  it('normalStart → phase=normal, phaseIndex=0', () => {
    const r = resolveResumeChoice('normalStart', baseDialog);
    expect(r).toEqual({ phase: 'normal', phaseIndex: 0 });
  });

  it('normalStart + disabled → 空', () => {
    const r = resolveResumeChoice('normalStart', { ...baseDialog, normalStartEnabled: false });
    expect(r).toEqual({});
  });
});
