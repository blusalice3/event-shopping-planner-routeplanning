import React from "react";

export interface PersistenceRecoveryScreenProps {
  message: string;
  details?: readonly string[];
  canExport: boolean;
  isRetrying: boolean;
  onRetry: () => void;
  onExport: () => void;
}

const EXPORT_UNAVAILABLE_REASON_ID =
  "persistence-recovery-export-unavailable-reason";

const PersistenceRecoveryScreen: React.FC<PersistenceRecoveryScreenProps> = ({
  message,
  details = [],
  canExport,
  isRetrying,
  onRetry,
  onExport,
}) => (
  <main
    className="fixed inset-0 z-[120] overflow-y-auto bg-slate-100 px-4 py-8 dark:bg-slate-950"
    aria-labelledby="persistence-recovery-title"
    aria-describedby="persistence-recovery-safety-message"
    aria-busy={isRetrying}
  >
    <div className="flex min-h-full items-center justify-center">
      <section className="w-full max-w-2xl rounded-2xl border border-red-200 bg-white p-6 shadow-2xl dark:border-red-900 dark:bg-slate-900 sm:p-8">
        <p className="text-sm font-semibold text-red-700 dark:text-red-300">
          起動時の読み込みエラー
        </p>
        <h1
          id="persistence-recovery-title"
          className="mt-2 text-2xl font-bold text-slate-900 dark:text-white sm:text-3xl"
        >
          保存データを安全に読み込めませんでした
        </h1>
        <p
          id="persistence-recovery-safety-message"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
        >
          通常画面への反映とイベント・マップデータの自動保存は開始していません。安全を確認できない移行元・退避候補は自動削除せず、アプリの通常画面も開きません。
        </p>

        <div
          className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          role="alert"
          aria-live="assertive"
        >
          <h2 className="font-semibold">問題の内容</h2>
          <p className="mt-2 break-words text-sm leading-6">{message}</p>
          {details.length > 0 && (
            <ul
              className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700 dark:text-slate-200"
              aria-label="読み込み失敗の詳細"
            >
              {details.map((detail, index) => (
                <li key={`${index}-${detail}`} className="break-words">
                  {detail}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
          まず再試行してください。解決しない場合は、利用可能であれば保存候補をJSONで退避してから、管理者またはサポートへご相談ください。
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-700 px-4 py-2.5 font-semibold text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-slate-900"
            onClick={onRetry}
            disabled={isRetrying}
          >
            {isRetrying ? "読み込みを再試行中…" : "読み込みを再試行"}
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-400 bg-white px-4 py-2.5 font-semibold text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus-visible:ring-offset-slate-900"
            onClick={onExport}
            disabled={!canExport || isRetrying}
            aria-describedby={
              !canExport ? EXPORT_UNAVAILABLE_REASON_ID : undefined
            }
          >
            保存候補をJSONで退避
          </button>
        </div>

        {!canExport && (
          <p
            id={EXPORT_UNAVAILABLE_REASON_ID}
            className="mt-2 text-sm text-slate-600 dark:text-slate-400"
          >
            退避できる保存候補を準備できていないため、JSONで退避できません。
          </p>
        )}
      </section>
    </div>
  </main>
);

export default PersistenceRecoveryScreen;
