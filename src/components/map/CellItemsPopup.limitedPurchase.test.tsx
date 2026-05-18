// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ShoppingItem } from '../../types/item';
import CellItemsPopup from './CellItemsPopup';

const limitedItem: ShoppingItem = {
  id: 'limited-item',
  circle: 'Limited Circle',
  eventDate: 'Day1',
  block: 'A',
  number: '01',
  title: 'Limited Title',
  price: 1000,
  purchaseStatus: 'LimitedPurchase',
  quantity: 5,
  limitedPurchasedQuantity: 2,
  remarks: '',
};

const renderPopup = (props: Partial<ComponentProps<typeof CellItemsPopup>> = {}) => {
  const onClose = vi.fn();
  const onEditRequest = vi.fn();
  const onAddToVisitList = vi.fn();

  render(
    <CellItemsPopup
      isOpen
      onClose={onClose}
      blockName="A"
      number={1}
      items={[limitedItem]}
      executeModeItemIds={new Set()}
      onAddToVisitList={onAddToVisitList}
      onRemoveFromVisitList={vi.fn()}
      onEditRequest={onEditRequest}
      position={{ x: 100, y: 100 }}
      {...props}
    />,
  );

  return { onAddToVisitList, onClose, onEditRequest };
};

describe('CellItemsPopup limited purchase actions', () => {
  it('shows a direct edit button for limited purchase items without requiring long press', async () => {
    const { onAddToVisitList, onClose, onEditRequest } = renderPopup();

    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.click(screen.getByRole('button', { name: '限数を編集' }));

    expect(onAddToVisitList).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEditRequest).toHaveBeenCalledWith(limitedItem);
  });
});
