// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  usePurchaseStatusControlMode,
} from './usePurchaseStatusControlMode';

const STORAGE_KEY = 'purchaseStatusControlMode';

describe('usePurchaseStatusControlMode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('defaults to cycle and exposes the default value', () => {
    const { result } = renderHook(() => usePurchaseStatusControlMode());

    expect(DEFAULT_PURCHASE_STATUS_CONTROL_MODE).toBe('cycle');
    expect(result.current.purchaseStatusControlMode).toBe('cycle');
    expect(result.current.DEFAULT_PURCHASE_STATUS_CONTROL_MODE).toBe('cycle');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('cycle');
  });

  it('restores a valid saved mode', () => {
    localStorage.setItem(STORAGE_KEY, 'radial');

    const { result } = renderHook(() => usePurchaseStatusControlMode());

    expect(result.current.purchaseStatusControlMode).toBe('radial');
  });

  it('falls back to cycle for invalid saved values', () => {
    localStorage.setItem(STORAGE_KEY, 'invalid');

    const { result } = renderHook(() => usePurchaseStatusControlMode());

    expect(result.current.purchaseStatusControlMode).toBe('cycle');
  });

  it('persists mode changes', () => {
    const { result } = renderHook(() => usePurchaseStatusControlMode());

    act(() => {
      result.current.setPurchaseStatusControlMode('radial');
    });

    expect(result.current.purchaseStatusControlMode).toBe('radial');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('radial');
  });

  it('falls back to cycle when localStorage read fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });

    const { result } = renderHook(() => usePurchaseStatusControlMode());

    expect(result.current.purchaseStatusControlMode).toBe('cycle');
  });

  it('does not throw when localStorage write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });

    expect(() => renderHook(() => usePurchaseStatusControlMode())).not.toThrow();
  });
});
