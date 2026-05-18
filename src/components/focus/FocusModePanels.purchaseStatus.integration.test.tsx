import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FocusModeItemList } from './FocusModePanels';
import type { ShoppingItem } from '../../types/item';

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

describe('FocusModeItemList purchase status control mode', () => {
  it('passes radial purchase status control mode to item cards', () => {
    render(
      <FocusModeItemList
        itemListRef={{ current: null }}
        layoutMode="pc"
        isMapVisible={false}
        currentVisitDisplayItems={[baseItem]}
        blinkingPriceItemIds={new Set()}
        onUpdateItem={vi.fn()}
        skipLimitedPurchaseForSingleQuantity
        purchaseStatusControlMode="radial"
      />,
    );

    expect(screen.getByRole('button', { name: /Current status/i })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });
});
