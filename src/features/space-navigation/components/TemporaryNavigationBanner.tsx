import React from 'react';
import { useOptionalSpaceNavigator } from '../SpaceNavigatorContext';

export function TemporaryNavigationBanner() {
  const navigator = useOptionalSpaceNavigator();
  if (!navigator?.registration || !navigator.temporaryMode || navigator.history.length === 0) {
    return null;
  }

  const current = navigator.registration.entries[navigator.registration.currentIndex];
  const previous = navigator.history[navigator.history.length - 1];
  const previousLabel = previous.snapshot?.label ?? '元のスペース';

  return (
    <div className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+.5rem)] z-[60] w-[calc(100%-1rem)] max-w-2xl -translate-x-1/2 rounded-xl border border-indigo-300 bg-white/95 px-3 py-2 shadow-xl backdrop-blur dark:border-indigo-700 dark:bg-slate-800/95">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-indigo-600 dark:text-indigo-300">
            {navigator.temporaryMode === 'inspect' ? '内容だけ確認中・編集不可' : '一時移動中'}
          </p>
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
            {current?.label ?? '選択したスペース'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void navigator.returnToPrevious()}
            className="min-h-10 max-w-[55vw] truncate rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
            title={`${previousLabel}へ戻る`}
          >
            ← {previousLabel}
          </button>
          <button
            type="button"
            onClick={() => void navigator.promoteTemporary()}
            className="min-h-10 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            現在地にする
          </button>
        </div>
      </div>
    </div>
  );
}
