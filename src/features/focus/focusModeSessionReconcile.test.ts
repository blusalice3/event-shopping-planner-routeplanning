import { describe, expect, it } from 'vitest';
import { reconcileFocusModeSessions } from './focusModeSessionReconcile';
import type { FocusModeSessionState } from '../../types/focus';
import type { ExecuteModeItems, ShoppingItem } from '../../types/item';

const buildItem = (
  id: string,
  purchaseStatus: ShoppingItem['purchaseStatus'],
): ShoppingItem =>
  ({
    id,
    circle: id,
    block: 'A',
    number: id,
    title: id,
    eventDate: '2026-08-15',
    purchaseStatus,
    price: 100,
    quantity: 1,
  }) as ShoppingItem;

const buildSession = (overrides: Partial<FocusModeSessionState>): FocusModeSessionState => ({
  phase: 'postponed',
  phaseIndex: 2,
  savedPhaseIndices: { normal: 1, postponed: 2, late: 3 },
  postponedItemIds: ['postpone-keep', 'postpone-stale', 'late-keep'],
  lateItemIds: ['late-keep', 'late-stale', 'normal-item'],
  isCompleted: false,
  lastPurchaseChangeAt: null,
  ...overrides,
});

describe('reconcileFocusModeSessions', () => {
  it('removes phase item ids that are no longer active route items with matching status', () => {
    const sessions = {
      'event-1::2026-08-15': buildSession({}),
    };
    const eventLists: Record<string, ShoppingItem[]> = {
      'event-1': [
        buildItem('postpone-keep', 'Postpone'),
        buildItem('late-keep', 'Late'),
        buildItem('normal-item', 'None'),
        buildItem('postpone-stale', 'Postpone'),
      ],
    };
    const executeModeItems: Record<string, ExecuteModeItems> = {
      'event-1': {
        '2026-08-15': ['postpone-keep', 'late-keep', 'normal-item'],
      },
    };

    expect(
      reconcileFocusModeSessions(
        sessions,
        eventLists,
        executeModeItems,
        new Set(['event-1::2026-08-15']),
      ),
    ).toEqual({
      'event-1::2026-08-15': {
        ...sessions['event-1::2026-08-15'],
        phaseIndex: 0,
        postponedItemIds: ['postpone-keep'],
        lateItemIds: ['late-keep'],
        savedPhaseIndices: { normal: 1, postponed: 0, late: 0 },
      },
    });
  });

  it('adds route items whose shared purchase status now belongs to phase lists', () => {
    const sessions = {
      'event-1::2026-08-15': buildSession({
        phase: 'normal',
        phaseIndex: 0,
        savedPhaseIndices: { normal: 0, postponed: 0, late: 0 },
        postponedItemIds: [],
        lateItemIds: [],
        isCompleted: true,
      }),
    };
    const eventLists: Record<string, ShoppingItem[]> = {
      'event-1': [
        buildItem('normal-item', 'None'),
        buildItem('remote-postpone', 'Postpone'),
        buildItem('remote-late', 'Late'),
      ],
    };
    const executeModeItems: Record<string, ExecuteModeItems> = {
      'event-1': {
        '2026-08-15': ['normal-item', 'remote-postpone', 'remote-late'],
      },
    };

    expect(
      reconcileFocusModeSessions(
        sessions,
        eventLists,
        executeModeItems,
        new Set(['event-1::2026-08-15']),
      ),
    ).toEqual({
      'event-1::2026-08-15': {
        ...sessions['event-1::2026-08-15'],
        postponedItemIds: ['remote-postpone'],
        lateItemIds: ['remote-late'],
        isCompleted: false,
      },
    });
  });

  it('keeps completed sessions completed when shared data does not change progress metadata', () => {
    const sessions = {
      'event-1::2026-08-15': buildSession({
        phase: 'normal',
        phaseIndex: 0,
        savedPhaseIndices: { normal: 0, postponed: 0, late: 0 },
        postponedItemIds: ['postpone-keep'],
        lateItemIds: ['late-keep'],
        isCompleted: true,
      }),
    };
    const eventLists: Record<string, ShoppingItem[]> = {
      'event-1': [
        buildItem('normal-item', 'None'),
        buildItem('postpone-keep', 'Postpone'),
        buildItem('late-keep', 'Late'),
      ],
    };
    const executeModeItems: Record<string, ExecuteModeItems> = {
      'event-1': {
        '2026-08-15': ['normal-item', 'postpone-keep', 'late-keep'],
      },
    };

    expect(
      reconcileFocusModeSessions(
        sessions,
        eventLists,
        executeModeItems,
        new Set(['event-1::2026-08-15']),
      ),
    ).toBe(sessions);
  });

  it('drops invalid session keys and resets empty phase indices', () => {
    const sessions = {
      'event-1::2026-08-15': buildSession({
        postponedItemIds: ['old-postpone'],
        lateItemIds: ['old-late'],
      }),
      'event-1::2026-08-16': buildSession({}),
    };

    expect(
      reconcileFocusModeSessions(
        sessions,
        { 'event-1': [buildItem('normal-item', 'None')] },
        { 'event-1': { '2026-08-15': ['normal-item'] } },
        new Set(['event-1::2026-08-15']),
      ),
    ).toEqual({
      'event-1::2026-08-15': {
        ...sessions['event-1::2026-08-15'],
        phase: 'normal',
        phaseIndex: 0,
        postponedItemIds: [],
        lateItemIds: [],
        savedPhaseIndices: { normal: 0, postponed: 0, late: 0 },
      },
    });
  });

  it('clears stale last-purchase pointers and clamps saved phase positions', () => {
    const sessions = {
      'event-1::2026-08-15': buildSession({
        phase: 'late',
        phaseIndex: 9,
        savedPhaseIndices: { normal: 9, postponed: 9, late: 9 },
        postponedItemIds: ['postpone-keep'],
        lateItemIds: ['late-keep'],
        lastPurchaseChangeAt: {
          phase: 'postponed',
          phaseIndex: 4,
          visitKey: 'missing-visit',
        },
      }),
    };
    const eventLists: Record<string, ShoppingItem[]> = {
      'event-1': [
        buildItem('postpone-keep', 'Postpone'),
        buildItem('late-keep', 'Late'),
        buildItem('normal-item', 'None'),
      ],
    };
    const executeModeItems: Record<string, ExecuteModeItems> = {
      'event-1': {
        '2026-08-15': ['normal-item', 'postpone-keep', 'late-keep'],
      },
    };

    expect(
      reconcileFocusModeSessions(
        sessions,
        eventLists,
        executeModeItems,
        new Set(['event-1::2026-08-15']),
      ),
    ).toEqual({
      'event-1::2026-08-15': {
        ...sessions['event-1::2026-08-15'],
        phaseIndex: 0,
        savedPhaseIndices: { normal: 2, postponed: 0, late: 0 },
        lastPurchaseChangeAt: null,
      },
    });
  });
});
