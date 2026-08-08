import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { acquireBodyScrollLock } from "../utils/bodyScrollLock";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const getFocusableElements = (container: HTMLElement | null) =>
  container
    ? Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          !element.closest('[hidden], [aria-hidden="true"]') &&
          element.getAttribute("tabindex") !== "-1",
      )
    : [];

type UseModalDialogBehaviorOptions = {
  isOpen: boolean;
  onEscape: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

export const useModalDialogBehavior = <T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onEscape,
  initialFocusRef,
  fallbackFocusRef,
}: UseModalDialogBehaviorOptions) => {
  const dialogRef = useRef<T>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const fallbackFocusContainer = fallbackFocusRef?.current ?? null;
    const releaseBodyScrollLock = acquireBodyScrollLock({
      lockOverscroll: true,
    });

    return () => {
      releaseBodyScrollLock();
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      const fallbackFocus = getFocusableElements(fallbackFocusContainer)[0];
      const focusTarget = returnFocus?.isConnected
        ? returnFocus
        : fallbackFocus;
      focusTarget?.focus({ preventScroll: true });
    };
  }, [fallbackFocusRef, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    const initialFocus =
      initialFocusRef?.current ?? getFocusableElements(dialogRef.current)[0];
    initialFocus?.focus({ preventScroll: true });
  }, [initialFocusRef, isOpen]);

  const onDialogKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      const eventTarget = event.target instanceof Element ? event.target : null;
      if (eventTarget?.closest('[role="dialog"]') !== event.currentTarget) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;

      const dialogElement = dialogRef.current;
      const focusableElements = getFocusableElements(dialogElement);
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (!first || !last) return;

      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialogElement?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialogElement?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    },
    [onEscape],
  );

  return { dialogRef, onDialogKeyDown };
};
