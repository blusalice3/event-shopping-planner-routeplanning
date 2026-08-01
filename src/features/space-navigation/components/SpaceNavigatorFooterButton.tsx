import React from "react";
import { useOptionalSpaceNavigator } from "../SpaceNavigatorContext";

export function SpaceNavigatorFooterButton({
  compact = false,
}: {
  compact?: boolean;
}) {
  const navigator = useOptionalSpaceNavigator();
  const registration = navigator?.registration;
  if (
    !navigator ||
    !registration ||
    !navigator.settings.footerButtonVisible ||
    registration.entries.length === 0
  ) {
    return null;
  }

  const label =
    registration.layoutMode === "smartphone" ? "ナビ" : "スペース一覧";

  return (
    <button
      type="button"
      onClick={navigator.openPicker}
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 active:bg-indigo-800 ${
        compact ? "min-w-11 px-2 text-xs" : "px-3 py-2 text-sm"
      }`}
      aria-label="スペース一覧を開く"
      title="スペース一覧を開く"
    >
      <span aria-hidden="true">▥</span>
      <span>{label}</span>
    </button>
  );
}
