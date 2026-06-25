import { describe, expect, it } from 'vitest';
import { isRouteAffectingItemPlacementChange } from './routeAffecting';
import type { ShoppingItem } from '../../types/item';

const item = (overrides: Partial<ShoppingItem> = {}): ShoppingItem =>
  ({
    id: 'item-1',
    circle: 'Circle',
    block: 'A',
    number: '01',
    title: 'Book',
    eventDate: '2026-08-15',
    purchaseStatus: 'None',
    price: 1000,
    quantity: 1,
    ...overrides,
  }) as ShoppingItem;

describe('isRouteAffectingItemPlacementChange', () => {
  it('does not treat route-neutral structural edits on route items as route-affecting', () => {
    expect(
      isRouteAffectingItemPlacementChange(
        item({ orderIndex: 0, title: 'Old' }),
        item({ orderIndex: 0, title: 'New' }),
      ),
    ).toBe(false);
  });

  it('treats date changes on route items as route-affecting', () => {
    expect(
      isRouteAffectingItemPlacementChange(
        item({ orderIndex: 0, eventDate: '2026-08-15' }),
        item({ orderIndex: 0, eventDate: '2026-08-16' }),
      ),
    ).toBe(true);
  });

  it('treats route membership changes as route-affecting', () => {
    expect(
      isRouteAffectingItemPlacementChange(
        item({ orderIndex: undefined }),
        item({ orderIndex: 3 }),
      ),
    ).toBe(true);
  });

  it('allows non-route item date changes to stay route-neutral', () => {
    expect(
      isRouteAffectingItemPlacementChange(
        item({ orderIndex: undefined, eventDate: '2026-08-15' }),
        item({ orderIndex: undefined, eventDate: '2026-08-16' }),
      ),
    ).toBe(false);
  });
});
