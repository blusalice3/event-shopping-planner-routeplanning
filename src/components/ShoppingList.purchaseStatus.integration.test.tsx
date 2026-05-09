import { render, screen } from '@testing-library/react';
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
});
