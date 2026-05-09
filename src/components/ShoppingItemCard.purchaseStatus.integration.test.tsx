import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShoppingItemCard, {
  OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS,
} from './ShoppingItemCard';
import type { ShoppingItem } from '../types/item';

const baseItem: ShoppingItem = {
  id: 'item-1',
  circle: 'Circle',
  eventDate: 'Day1',
  block: 'A',
  number: '01',
  title: 'Title',
  price: 1000,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
};

const defaultProps: ComponentProps<typeof ShoppingItemCard> = {
  item: baseItem,
  onUpdate: vi.fn(),
  isStriped: false,
  onEditRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
  isSelected: false,
  onSelectItem: vi.fn(),
  layoutMode: 'pc',
  viewMode: 'execute',
};

const renderCard = (overrides: Partial<ComponentProps<typeof ShoppingItemCard>> = {}) => {
  const onUpdate = vi.fn();
  const props = {
    ...defaultProps,
    onUpdate,
    ...overrides,
    item: {
      ...baseItem,
      ...overrides.item,
    },
  };
  const renderResult = render(<ShoppingItemCard {...props} />);

  return {
    onUpdate,
    unmount: renderResult.unmount,
    rerender: (nextOverrides: Partial<ComponentProps<typeof ShoppingItemCard>>) => {
      renderResult.rerender(<ShoppingItemCard {...props} {...nextOverrides} />);
    },
  };
};

const getStatusButton = () => screen.getByRole('button', { name: /Current status/i });
const getDialog = () => screen.getByRole('dialog', { name: '購入状態を選択' });
const getOverlay = () => {
  const overlay = document.querySelector('[data-purchase-status-overlay="item-1"]');
  if (!overlay) throw new Error('purchase status overlay not found');
  return overlay as HTMLElement;
};

describe('ShoppingItemCard purchase status control', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps cycle mode as the default click behavior', () => {
    const { onUpdate } = renderCard();

    fireEvent.click(getStatusButton());

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ purchaseStatus: 'Purchased' }));
  });

  it('opens radial dialog with dialog aria on the status button', () => {
    renderCard({ purchaseStatusControlMode: 'radial' });

    const button = getStatusButton();
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(getDialog()).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '購入状態' })).toBeInTheDocument();
  });

  it('selects an arbitrary status directly and closes', () => {
    const { onUpdate } = renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole('radio', { name: 'Lateに変更' }));

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ purchaseStatus: 'Late' }));
    expect(screen.queryByRole('dialog', { name: '購入状態を選択' })).not.toBeInTheDocument();
    expect(getStatusButton()).toHaveFocus();
  });

  it('closes without update when selecting the current status', () => {
    const { onUpdate } = renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole('radio', { name: 'Noneに変更' }));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '購入状態を選択' })).not.toBeInTheDocument();
  });

  it('cancels by cancel button and Escape without update', () => {
    const { onUpdate } = renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(getStatusButton()).toHaveFocus();

    fireEvent.click(getStatusButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '購入状態を選択' })).not.toBeInTheDocument();
    expect(getStatusButton()).toHaveFocus();
  });

  it('does not prevent default for overlay pointer events', () => {
    renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    const overlay = getOverlay();
    const PointerEventCtor = window.PointerEvent ?? MouseEvent;
    const pointerDown = new PointerEventCtor('pointerdown', { bubbles: true, cancelable: true });
    const pointerUp = new PointerEventCtor('pointerup', { bubbles: true, cancelable: true });

    overlay.dispatchEvent(pointerDown);
    overlay.dispatchEvent(pointerUp);

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(pointerUp.defaultPrevented).toBe(false);
  });

  it('prevents default for overlay mouse and click events', () => {
    renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    const overlay = getOverlay();
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    overlay.dispatchEvent(mouseDown);
    overlay.dispatchEvent(mouseUp);
    overlay.dispatchEvent(click);

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(mouseUp.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
  });

  it('keeps overlay until click or fallback after pointerup', () => {
    vi.useFakeTimers();
    renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    fireEvent.pointerUp(getOverlay());

    expect(getOverlay()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
    });

    expect(screen.queryByRole('dialog', { name: '購入状態を選択' })).not.toBeInTheDocument();
  });

  it('clears delayed pointerup fallback when captured click arrives', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    const overlay = getOverlay();
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
    });
    expect(screen.queryByRole('dialog', { name: '購入状態を選択' })).not.toBeInTheDocument();
  });

  it('clears delayed pointerup fallback when the menu receives input or unmounts', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { unmount } = renderCard({ purchaseStatusControlMode: 'radial' });

    fireEvent.click(getStatusButton());
    fireEvent.pointerUp(getOverlay());
    fireEvent.pointerDown(getDialog());

    expect(clearTimeoutSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
    });
    expect(getDialog()).toBeInTheDocument();

    fireEvent.pointerUp(getOverlay());
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('closes on mode change without stealing external focus', () => {
    const onUpdate = vi.fn();
    const props = { ...defaultProps, onUpdate, purchaseStatusControlMode: 'radial' as const };
    const { rerender } = render(
      <>
        <input aria-label="settings focus target" />
        <ShoppingItemCard {...props} />
      </>,
    );

    fireEvent.click(getStatusButton());
    screen.getByLabelText('settings focus target').focus();

    rerender(
      <>
        <input aria-label="settings focus target" />
        <ShoppingItemCard {...props} purchaseStatusControlMode="cycle" />
      </>,
    );

    expect(screen.queryByRole('dialog', { name: '購入状態を選択' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('settings focus target')).toHaveFocus();
  });

  it('focuses current status on open and leaves controls tabbable', async () => {
    const user = userEvent.setup();
    renderCard({
      purchaseStatusControlMode: 'radial',
      item: { ...baseItem, purchaseStatus: 'Postpone' },
    });

    fireEvent.click(getStatusButton());

    expect(screen.getByRole('radio', { name: 'Postponeに変更' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'キャンセル' })).not.toHaveAttribute(
      'tabindex',
      '-1',
    );

    await user.tab();
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
  });

  it('stops portal overlay events from React parents and document bubble mouse listeners', () => {
    const parentClick = vi.fn();
    const documentMouseDown = vi.fn();
    const documentMouseUp = vi.fn();
    const documentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ShoppingItemCard {...defaultProps} purchaseStatusControlMode="radial" />
      </div>,
    );

    fireEvent.click(getStatusButton());
    parentClick.mockClear();
    document.addEventListener('mousedown', documentMouseDown);
    document.addEventListener('mouseup', documentMouseUp);
    document.addEventListener('click', documentClick);

    const overlay = getOverlay();
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expect(parentClick).not.toHaveBeenCalled();
    expect(documentMouseDown).not.toHaveBeenCalled();
    expect(documentMouseUp).not.toHaveBeenCalled();
    expect(documentClick).not.toHaveBeenCalled();

    document.removeEventListener('mousedown', documentMouseDown);
    document.removeEventListener('mouseup', documentMouseUp);
    document.removeEventListener('click', documentClick);
  });

  it('documents jsdom click-through limits while blocking background click in simulated bubbling', () => {
    // jsdom cannot prove real coordinate click-through. A Playwright/browser check is
    // strongly recommended for the final guarantee that overlay coordinates do not
    // trigger background UI.
    const backgroundClick = vi.fn();
    render(
      <>
        <button onClick={backgroundClick}>background action</button>
        <ShoppingItemCard {...defaultProps} purchaseStatusControlMode="radial" />
      </>,
    );

    fireEvent.click(getStatusButton());
    fireEvent.click(getOverlay());

    expect(backgroundClick).not.toHaveBeenCalled();
  });

  it('enables radial behavior in smartphone edit and execute layouts', () => {
    const { rerender } = renderCard({
      purchaseStatusControlMode: 'radial',
      layoutMode: 'smartphone',
      viewMode: 'edit',
    });

    expect(getStatusButton()).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(getStatusButton());
    expect(getDialog()).toBeInTheDocument();

    rerender({ purchaseStatusControlMode: 'radial', layoutMode: 'smartphone', viewMode: 'execute' });
    expect(getStatusButton()).toHaveAttribute('aria-haspopup', 'dialog');
  });
});
