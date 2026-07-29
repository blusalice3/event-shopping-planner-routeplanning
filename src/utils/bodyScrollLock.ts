export interface BodyScrollLockOptions {
  lockOverscroll?: boolean;
  lockTouchAction?: boolean;
}

interface ActiveBodyScrollLock {
  lockOverscroll: boolean;
  lockTouchAction: boolean;
}

let nextLockId = 0;
const activeLocks = new Map<number, ActiveBodyScrollLock>();
let originalOverflow: string | null = null;
let originalOverscrollBehavior: string | null = null;
let originalTouchAction: string | null = null;

function applyBodyScrollLockState(): void {
  if (typeof document === 'undefined') return;

  if (activeLocks.size === 0) {
    document.body.style.overflow = originalOverflow ?? '';
    document.body.style.overscrollBehavior = originalOverscrollBehavior ?? '';
    document.body.style.touchAction = originalTouchAction ?? '';
    originalOverflow = null;
    originalOverscrollBehavior = null;
    originalTouchAction = null;
    return;
  }

  document.body.style.overflow = 'hidden';
  document.body.style.overscrollBehavior = Array.from(activeLocks.values()).some(
    (lock) => lock.lockOverscroll,
  )
    ? 'none'
    : (originalOverscrollBehavior ?? '');
  document.body.style.touchAction = Array.from(activeLocks.values()).some(
    (lock) => lock.lockTouchAction,
  )
    ? 'none'
    : (originalTouchAction ?? '');
}

export function acquireBodyScrollLock(
  options: BodyScrollLockOptions = {},
): () => void {
  if (typeof document === 'undefined') return () => {};

  if (activeLocks.size === 0) {
    originalOverflow = document.body.style.overflow;
    originalOverscrollBehavior = document.body.style.overscrollBehavior;
    originalTouchAction = document.body.style.touchAction;
  }

  const lockId = ++nextLockId;
  activeLocks.set(lockId, {
    lockOverscroll: options.lockOverscroll ?? false,
    lockTouchAction: options.lockTouchAction ?? false,
  });
  applyBodyScrollLockState();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLocks.delete(lockId);
    applyBodyScrollLockState();
  };
}
