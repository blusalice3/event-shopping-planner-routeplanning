import React from "react";
import type { NavigatorEntry } from "../types";
import type { SpaceNavigatorActionResult } from "../SpaceNavigatorContext";

interface SpaceNavigatorActionDialogProps {
  entry: NavigatorEntry;
  result: SpaceNavigatorActionResult | null;
  pendingIntent: "set-current" | "temporary" | "inspect" | null;
  busy: boolean;
  onChoose: (
    intent: "set-current" | "temporary" | "inspect",
    confirmed?: boolean,
  ) => void;
  onCancel: () => void;
}

const actions = [
  {
    intent: "set-current" as const,
    label: "現在地として移動",
    description: "以後の「次へ」と再開位置をここへ移します",
    className: "bg-indigo-600 text-white hover:bg-indigo-700",
  },
  {
    intent: "temporary" as const,
    label: "一時移動して操作",
    description: "現在地は残したまま、購入状態などを変更できます",
    className:
      "bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/60 dark:text-blue-100",
  },
  {
    intent: "inspect" as const,
    label: "内容だけ確認",
    description: "現在地は残したまま、変更操作を無効にして表示します",
    className:
      "bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-100",
  },
];

export function SpaceNavigatorActionDialog({
  entry,
  result,
  pendingIntent,
  busy,
  onChoose,
  onCancel,
}: SpaceNavigatorActionDialogProps) {
  const needsConfirmation = Boolean(
    result?.requiresConfirmation && pendingIntent,
  );

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="presentation"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-navigator-action-title"
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-800"
      >
        <p className="text-xs font-semibold text-indigo-600 dark:text-indigo-300">
          {entry.index + 1} / 選択中
        </p>
        <h2
          id="space-navigator-action-title"
          className="mt-1 text-xl font-bold text-slate-900 dark:text-white"
        >
          {entry.label}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {entry.circles.slice(0, 2).join("・")}
          {entry.circles.length > 2
            ? `・ほか${entry.circles.length - 2}件`
            : ""}
        </p>

        {result?.message && (
          <div
            className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
              needsConfirmation
                ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100"
                : "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-100"
            }`}
            role="alert"
          >
            {result.message}
          </div>
        )}

        <div className="mt-5 space-y-3">
          {needsConfirmation ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChoose(pendingIntent!, true)}
              className="min-h-12 w-full rounded-lg bg-amber-600 px-4 py-3 text-left font-bold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              警告を確認して移動
            </button>
          ) : (
            actions.map((action) => (
              <button
                key={action.intent}
                type="button"
                disabled={busy}
                onClick={() => onChoose(action.intent)}
                className={`min-h-12 w-full rounded-lg px-4 py-3 text-left transition-colors disabled:opacity-50 ${action.className}`}
              >
                <span className="block font-bold">{action.label}</span>
                <span className="mt-0.5 block text-xs opacity-80">
                  {action.description}
                </span>
              </button>
            ))
          )}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="mt-4 min-h-11 w-full rounded-lg text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
        >
          キャンセル
        </button>
      </section>
    </div>
  );
}
