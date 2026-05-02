// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FocusMode from './FocusMode';
import { minimalProps } from './FocusMode.fixtures';
import type { ShoppingItem } from '../types/item';

const purchasedItemWithUndefinedPrice: ShoppingItem = {
  id: 'item-undefined-price',
  eventDate: '2026-01-01',
  block: 'A',
  number: '01a',
  circle: 'Circle 1',
  title: 'Book 1',
  price: null,
  quantity: 1,
  purchaseStatus: 'Purchased',
  priorityLevel: 'none',
  remarks: '',
  url: '',
};

describe('FocusMode TICKET-06 undefined price blink guard', () => {
  it('keeps the undefined-price blink when the check is enabled', async () => {
    const { container } = render(
      <FocusMode
        {...minimalProps({
          items: [purchasedItemWithUndefinedPrice],
          executeModeItemIds: [purchasedItemWithUndefinedPrice.id],
        })}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-item-id="item-undefined-price"]')).toHaveClass(
        'animate-pulse',
        'ring-red-500',
      );
    });
  });

  it('suppresses the undefined-price blink when the check is disabled', async () => {
    const { container } = render(
      <FocusMode
        {...minimalProps({
          items: [purchasedItemWithUndefinedPrice],
          executeModeItemIds: [purchasedItemWithUndefinedPrice.id],
          disablePriceUndefinedCheck: true,
        })}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-item-id="item-undefined-price"]')).not.toHaveClass(
        'animate-pulse',
        'ring-red-500',
      );
    });
  });
});
