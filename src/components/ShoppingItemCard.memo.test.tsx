/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ShoppingItem } from '../types/item';
import {
  areSameShoppingItemCardProps,
  default as ShoppingItemCard,
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
  limitedPurchasedQuantity: 1,
  remarks: 'remarks',
  url: 'https://example.com',
  priorityLevel: 'priority',
  protectionLevel: 'none',
  source: 'app',
  assignedTo: 'buyer',
  securedBy: 'buyer',
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
  isInoperableCandidate: false,
  layoutMode: 'pc',
  viewMode: 'focus',
  hallIndex: 1,
  priorityLevel: 'priority',
  highlightPrice: false,
  highlightLimitedMissing: false,
  getLatestItemById: vi.fn(),
  onNotify: vi.fn(),
  onLimitedPurchaseDefer: vi.fn(),
  purchaseStatusControlMode: 'cycle',
  skipLimitedPurchaseForSingleQuantity: true,
  assignmentMembers: [],
  canAssignItem: vi.fn(),
  canUpdatePurchaseFields: vi.fn(),
  onAssignItem: vi.fn(),
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
  if (key === 'assignmentMembers') {
    return {
      ...representativeShoppingItemCardProps,
      assignmentMembers: [
        {
          roomMemberId: 'member-2',
          displayName: 'Member 2',
          color: null,
          role: 'member',
          membershipStatus: 'active',
        },
      ],
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

describe('ShoppingItemCard assignment controls', () => {
  it('shows the assigned member chip and calls onAssignItem when the assignee changes', async () => {
    const user = userEvent.setup();
    const onAssignItem = vi.fn();

    render(
      <ShoppingItemCard
        {...representativeShoppingItemCardProps}
        item={{ ...representativeShoppingItem, assignedTo: 'member-host' }}
        assignmentMembers={[
          {
            roomMemberId: 'member-host',
            displayName: 'Host',
            color: '#0ea5e9',
            role: 'host',
            membershipStatus: 'active',
          },
          {
            roomMemberId: 'member-guest',
            displayName: 'Guest',
            color: '#22c55e',
            role: 'member',
            membershipStatus: 'active',
          },
          {
            roomMemberId: 'member-left',
            displayName: 'Left',
            color: '#94a3b8',
            role: 'member',
            membershipStatus: 'left',
          },
        ]}
        canAssignItem={() => true}
        onAssignItem={onAssignItem}
      />,
    );

    expect(screen.getByText('担当: Host')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Left' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: '担当者を変更' }), 'member-guest');

    expect(onAssignItem).toHaveBeenCalledWith('item-1', 'member-guest');
  });

  it('hides the assignee select when the current member cannot assign the item', () => {
    render(
      <ShoppingItemCard
        {...representativeShoppingItemCardProps}
        item={{ ...representativeShoppingItem, assignedTo: 'member-host' }}
        assignmentMembers={[
          {
            roomMemberId: 'member-host',
            displayName: 'Host',
            color: '#0ea5e9',
            role: 'host',
            membershipStatus: 'active',
          },
        ]}
        canAssignItem={() => false}
        onAssignItem={vi.fn()}
      />,
    );

    expect(screen.getByText('担当: Host')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '担当者を変更' })).not.toBeInTheDocument();
  });

  it('resolves a left assignee for history while keeping assignment choices active-only', () => {
    render(
      <ShoppingItemCard
        {...representativeShoppingItemCardProps}
        item={{ ...representativeShoppingItem, assignedTo: 'member-left' }}
        assignmentMembers={[
          {
            roomMemberId: 'member-active',
            displayName: 'Active',
            color: '#22c55e',
            role: 'member',
            membershipStatus: 'active',
          },
          {
            roomMemberId: 'member-left',
            displayName: 'Left',
            color: '#94a3b8',
            role: 'member',
            membershipStatus: 'left',
          },
        ]}
        canAssignItem={() => true}
        onAssignItem={vi.fn()}
      />,
    );

    expect(screen.getByText('担当: Left（退出済み）')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Active' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Left' })).not.toBeInTheDocument();
  });
});
