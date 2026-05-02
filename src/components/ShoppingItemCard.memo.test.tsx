import { describe, expect, it, vi } from 'vitest';
import type { ShoppingItem } from '../types/item';
import {
  areSameShoppingItemCardProps,
  SHOPPING_ITEM_CARD_COMPARISON_KEYS,
  type ShoppingItemCardProps,
} from './ShoppingItemCard';
import { areSameItemSnapshot, SHOPPING_ITEM_SNAPSHOT_KEYS } from './itemSnapshot';

const representativeShoppingItem = {
  id: 'item-1',
  circle: 'Circle',
  eventDate: 'Day1',
  block: 'A',
  number: '01',
  title: 'Title',
  price: 1000,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: 'remarks',
  url: 'https://example.com',
  priorityLevel: 'priority',
  protectionLevel: 'none',
  source: 'app',
  assignedTo: 'buyer',
  lastSyncedAt: '2026-01-01T00:00:00.000Z',
  orderIndex: 1,
  postponed: false,
  manualHallId: 'hall-1',
} satisfies Required<ShoppingItem>;

const representativeShoppingItemCardProps = {
  item: representativeShoppingItem,
  onUpdate: vi.fn(),
  isStriped: false,
  onEditRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
  isSelected: false,
  onSelectItem: vi.fn(),
  blockBackgroundColor: '#ffffff',
  onMoveUp: vi.fn(),
  onMoveDown: vi.fn(),
  canMoveUp: true,
  canMoveDown: true,
  isDuplicateCircle: false,
  isSearchMatch: false,
  layoutMode: 'pc',
  viewMode: 'focus',
  hallIndex: 1,
  priorityLevel: 'priority',
  highlightPrice: false,
} satisfies Required<ShoppingItemCardProps>;

const changeProp = (
  key: (typeof SHOPPING_ITEM_CARD_COMPARISON_KEYS)[number],
): Required<ShoppingItemCardProps> => {
  if (key === 'item') {
    return {
      ...representativeShoppingItemCardProps,
      item: { ...representativeShoppingItem, title: 'Changed' },
    };
  }
  const next = { ...representativeShoppingItemCardProps };
  const current = next[key];
  (next as Record<typeof key, unknown>)[key] =
    typeof current === 'boolean'
      ? !current
      : typeof current === 'number'
        ? current + 1
        : typeof current === 'function'
          ? vi.fn()
          : current === undefined
            ? 'changed'
            : `${String(current)}-changed`;
  return next;
};

describe('ShoppingItemCard memo comparator', () => {
  it('keeps comparison key coverage aligned with ShoppingItemCardProps keys', () => {
    expect([...SHOPPING_ITEM_CARD_COMPARISON_KEYS].sort()).toEqual(
      Object.keys(representativeShoppingItemCardProps).sort(),
    );
  });

  it.each(SHOPPING_ITEM_CARD_COMPARISON_KEYS.filter((key) => key !== 'item'))(
    'detects ShoppingItemCard comparator changes for %s',
    (key) => {
      expect(
        areSameShoppingItemCardProps(
          representativeShoppingItemCardProps,
          changeProp(key),
        ),
      ).toBe(false);
    },
  );

  it('keeps comparator true when item object changes but item snapshot is the same', () => {
    expect(
      areSameShoppingItemCardProps(representativeShoppingItemCardProps, {
        ...representativeShoppingItemCardProps,
        item: { ...representativeShoppingItem },
      }),
    ).toBe(true);
  });

  it('detects comparator changes when item snapshot changes', () => {
    expect(
      areSameShoppingItemCardProps(
        representativeShoppingItemCardProps,
        changeProp('item'),
      ),
    ).toBe(false);
  });
});

describe('item snapshot comparator', () => {
  it('keeps snapshot key coverage aligned with ShoppingItem keys', () => {
    expect([...SHOPPING_ITEM_SNAPSHOT_KEYS].sort()).toEqual(
      Object.keys(representativeShoppingItem).sort(),
    );
  });

  it.each(SHOPPING_ITEM_SNAPSHOT_KEYS)('detects item snapshot changes for %s', (key) => {
    const next = { ...representativeShoppingItem };
    const current = next[key];
    (next as Record<typeof key, unknown>)[key] =
      typeof current === 'boolean'
        ? !current
        : typeof current === 'number'
          ? current + 1
          : `${String(current)}-changed`;

    expect(areSameItemSnapshot(representativeShoppingItem, next)).toBe(false);
  });
});
