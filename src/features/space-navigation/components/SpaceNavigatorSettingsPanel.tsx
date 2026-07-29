import React from 'react';
import { useOptionalSpaceNavigator } from '../SpaceNavigatorContext';
import { NAVIGATOR_STATUS_COLORS } from './SpaceNavigatorLegend';

export function SpaceNavigatorSettingsPanel() {
  const navigator = useOptionalSpaceNavigator();
  if (!navigator) return null;
  const { settings, updateSettings } = navigator;

  return (
    <div className="mb-3 border-t border-slate-200 pt-3 dark:border-slate-700">
      <h4 className="mb-2 text-xs font-semibold text-indigo-600 dark:text-indigo-300">
        スペースナビ
      </h4>
      <div className="space-y-2 text-xs">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={settings.railVisible}
            onChange={(event) => updateSettings({ railVisible: event.target.checked })}
            className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
          />
          <span>
            <span className="block text-slate-700 dark:text-slate-200">細い色付きナビ</span>
            <span className="block text-[10px] text-slate-500 dark:text-slate-400">
              画面端をドラッグして訪問先を選べます
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={settings.footerButtonVisible}
            onChange={(event) => updateSettings({ footerButtonVisible: event.target.checked })}
            className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
          />
          <span>
            <span className="block text-slate-700 dark:text-slate-200">
              固定フッターのスペース一覧ボタン
            </span>
            <span className="block text-[10px] text-slate-500 dark:text-slate-400">
              画面端の操作が難しい端末でも一覧を開けます
            </span>
          </span>
        </label>
        <fieldset>
          <legend className="mb-1 text-slate-600 dark:text-slate-300">表示する側</legend>
          <div className="flex gap-4">
            {(['left', 'right'] as const).map((side) => (
              <label key={side} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="spaceNavigatorSide"
                  checked={settings.side === side}
                  onChange={() => updateSettings({ side })}
                  className="h-3.5 w-3.5 text-indigo-600 focus:ring-indigo-500"
                />
                <span>{side === 'left' ? '左側' : '右側'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
          <p className="mb-1 text-[10px] text-slate-500 dark:text-slate-400">表示見本</p>
          <div className="flex h-4 overflow-hidden rounded border border-slate-300 dark:border-slate-600">
            {Object.values(NAVIGATOR_STATUS_COLORS).map((color) => (
              <span key={color} className="flex-1" style={{ backgroundColor: color }} />
            ))}
          </div>
        </div>
        {!settings.railVisible && !settings.footerButtonVisible && (
          <p className="rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            両方OFFのため、ナビの表示・操作範囲はすべて取り除かれます。
          </p>
        )}
      </div>
    </div>
  );
}

