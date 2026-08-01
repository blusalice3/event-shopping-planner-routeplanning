import React, { useEffect, useMemo, useState } from "react";
import {
  buildDifferentSourceResolution,
  buildSameSourceUpdateResolution,
  createUniqueAliasEventName,
  validateAliasEventName,
  type DifferentSourceChoice,
  type DifferentSourceEventAnalysis,
  type DuplicateEventResolution,
  type SameSourceEventAnalysis,
} from "../features/events/duplicateEvent";

export interface DuplicateEventDialogProps {
  analysis: SameSourceEventAnalysis | DifferentSourceEventAnalysis;
  existingEventNames: string[];
  onResolve: (resolution: DuplicateEventResolution) => void;
  onCancel: () => void;
}

const optionClass =
  "block rounded-lg border border-slate-300 p-3 dark:border-slate-600";

const DuplicateEventDialog: React.FC<DuplicateEventDialogProps> = ({
  analysis,
  existingEventNames,
  onResolve,
  onCancel,
}) => {
  const defaultAliasName = useMemo(
    () => createUniqueAliasEventName(analysis.eventName, existingEventNames),
    [analysis.eventName, existingEventNames],
  );
  const [choice, setChoice] = useState<DifferentSourceChoice>("create-alias");
  const [aliasName, setAliasName] = useState(defaultAliasName);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setChoice("create-alias");
    setAliasName(defaultAliasName);
    setSubmitError(null);
  }, [analysis.kind, analysis.eventName, defaultAliasName]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const aliasError =
    analysis.kind === "different-source" && choice === "create-alias"
      ? validateAliasEventName(aliasName, existingEventNames)
      : null;

  const handleSameSourceUpdate = () => {
    try {
      onResolve(
        buildSameSourceUpdateResolution(analysis as SameSourceEventAnalysis),
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "処理を続けられませんでした。",
      );
    }
  };

  const handleDifferentSourceChoice = () => {
    if (analysis.kind !== "different-source") return;
    try {
      onResolve(
        buildDifferentSourceResolution(analysis, choice, {
          aliasName,
          existingEventNames,
        }),
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "処理を続けられませんでした。",
      );
    }
  };

  const selectChoice = (nextChoice: DifferentSourceChoice) => {
    setChoice(nextChoice);
    setSubmitError(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-event-title"
        aria-describedby="duplicate-event-description"
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-slate-800"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2
          id="duplicate-event-title"
          className="text-xl font-bold text-slate-900 dark:text-white"
        >
          「{analysis.eventName}」はすでにあります
        </h2>

        {analysis.kind === "same-source" ? (
          <>
            <p
              id="duplicate-event-description"
              className="mt-3 text-sm text-slate-700 dark:text-slate-300"
            >
              同じスプレッドシートとシートから取り込もうとしています。新しいイベントは作らず、現在の内容との差分を確認してください。
            </p>
            <div className="mt-4 rounded-md bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100">
              「アイテム更新へ」を押しても、まだ内容は書き換わりません。次の差分確認画面で変更点を確認してから更新できます。
            </div>
            {analysis.sourceComparison.gidComparison === "different" && (
              <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
                URL内のシート番号（gid）は異なりますが、保存済みのシート名を優先して同じ更新元と判定しました。
              </p>
            )}
            {submitError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {submitError}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSameSourceUpdate}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                アイテム更新へ
              </button>
            </div>
          </>
        ) : (
          <>
            <p
              id="duplicate-event-description"
              className="mt-3 text-sm text-slate-700 dark:text-slate-300"
            >
              名前は同じですが、保存済みとは別の更新元です。どのように扱うか選んでください。
            </p>

            <fieldset className="mt-5 space-y-3">
              <legend className="sr-only">同名イベントの扱い</legend>

              <div className={optionClass}>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="duplicate-event-choice"
                    value="create-alias"
                    aria-label="別名作成（推奨）"
                    checked={choice === "create-alias"}
                    onChange={() => selectChoice("create-alias")}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-semibold text-slate-900 dark:text-white">
                      別名作成（推奨）
                    </span>
                    <span className="mt-1 block text-sm text-slate-600 dark:text-slate-300">
                      今あるイベントを残したまま、取り込んだ内容を別のイベントとして保存します。
                    </span>
                  </span>
                </label>
                {choice === "create-alias" && (
                  <span className="mt-3 block pl-6">
                    <label
                      htmlFor="duplicate-event-alias"
                      className="block text-sm font-medium text-slate-700 dark:text-slate-200"
                    >
                      新しいイベント名
                    </label>
                    <input
                      id="duplicate-event-alias"
                      type="text"
                      value={aliasName}
                      onChange={(event) => {
                        setAliasName(event.target.value);
                        setSubmitError(null);
                      }}
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                    />
                    {aliasError && (
                      <span
                        role="alert"
                        className="mt-1 block text-sm text-red-600 dark:text-red-400"
                      >
                        {aliasError}
                      </span>
                    )}
                  </span>
                )}
              </div>

              <div className={optionClass}>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="duplicate-event-choice"
                    value="append-fixed-items"
                    aria-label="固定品目として追加"
                    checked={choice === "append-fixed-items"}
                    onChange={() => selectChoice("append-fixed-items")}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-semibold text-slate-900 dark:text-white">
                      固定品目として追加
                    </span>
                    <span className="mt-1 block text-sm text-slate-600 dark:text-slate-300">
                      更新元は変えず、新しい品目だけを手入力と同じ固定品目として追加します。
                    </span>
                    <span className="mt-1 block text-sm text-slate-600 dark:text-slate-300">
                      完全一致の{analysis.duplicateItemCount}
                      件は追加対象から除かれます。
                    </span>
                  </span>
                </label>
              </div>

              <div
                className={`${optionClass} ${
                  analysis.incomingSourceIdentity
                    ? ""
                    : "cursor-not-allowed opacity-60"
                }`}
              >
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="duplicate-event-choice"
                    value="switch-source"
                    aria-label="更新元を切り替える"
                    checked={choice === "switch-source"}
                    onChange={() => selectChoice("switch-source")}
                    disabled={!analysis.incomingSourceIdentity}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-semibold text-slate-900 dark:text-white">
                      更新元を切り替える
                    </span>
                    <span className="mt-1 block text-sm text-slate-600 dark:text-slate-300">
                      今後の更新に使うスプレッドシートを変更します。次の差分確認が終わるまで、保存中の内容や更新元は変わりません。
                    </span>
                    {!analysis.incomingSourceIdentity && (
                      <span className="mt-1 block text-sm text-red-600 dark:text-red-400">
                        URLから更新元を確認できないため選択できません。
                      </span>
                    )}
                  </span>
                </label>
              </div>
            </fieldset>

            {choice === "switch-source" && (
              <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                更新元を切り替えると、次回以降は新しい表の内容が基準になります。まず次の画面で、追加・変更・削除の候補を確認してください。
              </div>
            )}

            {submitError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {submitError}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleDifferentSourceChoice}
                disabled={choice === "create-alias" && !!aliasError}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {choice === "create-alias"
                  ? "別名で作成"
                  : choice === "append-fixed-items"
                    ? "固定品目として追加"
                    : "差分確認へ"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default DuplicateEventDialog;
