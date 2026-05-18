// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
  useSkipLimitedPurchaseForSingleQuantity,
} from './useSkipLimitedPurchaseForSingleQuantity';

const STORAGE_KEY = 'skipLimitedPurchaseForSingleQuantity';

describe('useSkipLimitedPurchaseForSingleQuantity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('defaults to true when localStorage is empty', () => {
    const { result } = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());

    expect(DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.skipLimitedPurchaseForSingleQuantity).toBe(true);
  });

  it('restores true and false saved values', () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    const { result, unmount } = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());
    expect(result.current.skipLimitedPurchaseForSingleQuantity).toBe(false);

    unmount();
    localStorage.setItem(STORAGE_KEY, 'true');
    const next = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());
    expect(next.result.current.skipLimitedPurchaseForSingleQuantity).toBe(true);
  });

  it('falls back to true for invalid saved values and read failures', () => {
    localStorage.setItem(STORAGE_KEY, 'invalid');
    const invalid = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());
    expect(invalid.result.current.skipLimitedPurchaseForSingleQuantity).toBe(true);
    invalid.unmount();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });

    const failedRead = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());
    expect(failedRead.result.current.skipLimitedPurchaseForSingleQuantity).toBe(true);
  });

  it('persists direct and functional setter updates', () => {
    const { result } = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());

    act(() => {
      result.current.setSkipLimitedPurchaseForSingleQuantity(false);
    });

    expect(result.current.skipLimitedPurchaseForSingleQuantity).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');

    act(() => {
      result.current.setSkipLimitedPurchaseForSingleQuantity((previous) => !previous);
    });

    expect(result.current.skipLimitedPurchaseForSingleQuantity).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('updates in memory without throwing when localStorage write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });

    const { result } = renderHook(() => useSkipLimitedPurchaseForSingleQuantity());

    expect(() => {
      act(() => {
        result.current.setSkipLimitedPurchaseForSingleQuantity(false);
      });
    }).not.toThrow();

    expect(result.current.skipLimitedPurchaseForSingleQuantity).toBe(false);
  });
});
