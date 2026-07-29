// @vitest-environment jsdom

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingItem } from '../types/item';
import VisitListPanel from './VisitListPanel';

const item: ShoppingItem = {
  id: 'touch-cancel-item',
  eventDate: 'Day1',
  block: 'A',
  number: '01a',
  circle: 'タッチキャンセル確認',
  title: '長押しドラッグ対象',
  price: 500,
  quantity: 1,
  purchaseStatus: 'None',
  priorityLevel: 'none',
  remarks: '',
  url: '',
};

describe('VisitListPanel touch drag cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.style.overflow = '';
    document.body.style.overscrollBehavior = '';
    document.body.style.touchAction = '';
  });

  it('releases the body lock and clears drag UI after touchcancel', () => {
    vi.useFakeTimers();
    document.body.style.overflow = 'auto';
    document.body.style.touchAction = 'pan-y';

    const view = render(
      <VisitListPanel
        isOpen
        onClose={vi.fn()}
        items={[item]}
        onUpdateOrder={vi.fn()}
        mapData={null}
        hallDefinitions={[]}
        hallOrder={[]}
        layoutMode="smartphone"
        onHighlightCell={vi.fn()}
        onClearHighlight={vi.fn()}
        hasUnsavedChanges={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const source = view.container.querySelector<HTMLElement>('[data-drag-item]');
    expect(source).not.toBeNull();

    fireEvent.touchStart(source!, {
      touches: [{ clientX: 120, clientY: 240 }],
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.touchAction).toBe('none');
    expect(
      view.container.querySelector('.pointer-events-none.border-blue-500'),
    ).not.toBeNull();
    expect(source).toHaveClass('opacity-50');

    fireEvent.touchCancel(source!, {
      changedTouches: [{ clientX: 120, clientY: 240 }],
    });

    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.touchAction).toBe('pan-y');
    expect(
      view.container.querySelector('.pointer-events-none.border-blue-500'),
    ).toBeNull();
    expect(source).not.toHaveClass('opacity-50');
  });
});
