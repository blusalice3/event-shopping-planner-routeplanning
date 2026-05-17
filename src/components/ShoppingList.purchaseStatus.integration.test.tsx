import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ShoppingList from './ShoppingList';
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

describe('ShoppingList purchase status control mode', () => {
  it('passes radial purchase status control mode to item cards', () => {
    render(
      <ShoppingList
        items={[baseItem]}
        onUpdateItem={vi.fn()}
        onMoveItem={vi.fn()}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        selectedItemIds={new Set()}
        onSelectItem={vi.fn()}
        layoutMode="pc"
        viewMode="execute"
        purchaseStatusControlMode="radial"
      />,
    );

    expect(screen.getByRole('button', { name: /Current status/i })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });

  it('does not toggle already matching non-limited items when limited items are excluded from a bulk change', () => {
    const onBulkStatusChange = vi.fn();
    const limitedItem: ShoppingItem = {
      ...baseItem,
      id: 'limited-item',
      circle: 'Limited Circle',
      purchaseStatus: 'LimitedPurchase',
      quantity: 5,
      limitedPurchasedQuantity: 2,
    };
    const soldOutItem: ShoppingItem = {
      ...baseItem,
      id: 'sold-out-item',
      circle: 'Sold Out Circle',
      purchaseStatus: 'SoldOut',
    };

    render(
      <ShoppingList
        items={[limitedItem, soldOutItem]}
        onUpdateItem={vi.fn()}
        onMoveItem={vi.fn()}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        selectedItemIds={new Set()}
        onSelectItem={vi.fn()}
        layoutMode="pc"
        viewMode="execute"
        showSpaceGroups
        onBulkStatusChange={onBulkStatusChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '全売切' }));

    expect(onBulkStatusChange).not.toHaveBeenCalled();
    expect(screen.getByText('変更対象のアイテムはありません')).toBeInTheDocument();
  });
});
