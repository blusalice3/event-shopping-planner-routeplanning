import "./bodyScrollLock.css";

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
const BODY_SCROLL_LOCK_CLASS = "esp-body-scroll-lock";
const BODY_OVERSCROLL_LOCK_CLASS = "esp-body-overscroll-lock";
const BODY_TOUCH_LOCK_CLASS = "esp-body-touch-lock";

function applyBodyScrollLockState(): void {
  if (typeof document === "undefined") return;

  const locks = Array.from(activeLocks.values());
  document.body.classList.toggle(BODY_SCROLL_LOCK_CLASS, locks.length > 0);
  document.body.classList.toggle(
    BODY_OVERSCROLL_LOCK_CLASS,
    locks.some((lock) => lock.lockOverscroll),
  );
  document.body.classList.toggle(
    BODY_TOUCH_LOCK_CLASS,
    locks.some((lock) => lock.lockTouchAction),
  );
}

export function acquireBodyScrollLock(
  options: BodyScrollLockOptions = {},
): () => void {
  if (typeof document === "undefined") return () => {};

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
