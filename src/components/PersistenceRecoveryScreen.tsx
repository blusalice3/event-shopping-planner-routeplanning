import React from "react";
import type { StartupRecoveryCandidate } from "../utils/persistenceResilience";

export interface PersistenceRecoveryScreenProps {
  message: string;
  details?: readonly string[];
  canExport: boolean;
  isRetrying: boolean;
  onRetry: () => void;
  onExport: () => void;
  candidates?: readonly StartupRecoveryCandidate[];
  isAdopting?: boolean;
  adoptionError?: string | null;
  onAdopt?: (candidateId: string) => void;
}

const EXPORT_UNAVAILABLE_REASON_ID =
  "persistence-recovery-export-unavailable-reason";
const ADOPTION_WARNING_ID = "persistence-recovery-adoption-warning";
const ADOPTION_SELECTION_REASON_ID =
  "persistence-recovery-adoption-selection-reason";
const ADOPTION_UNAVAILABLE_REASON_ID =
  "persistence-recovery-adoption-unavailable-reason";

function getAutomaticAdoptionRejectionReason(
  candidate: StartupRecoveryCandidate,
): string {
  if (candidate.adoptable !== true) {
    switch (candidate.role) {
      case "legacy-migration-source":
        return "旧localStorage原本は直接採用せず、検証済み移行またはJSON退避の対象として保持するためです。";
      case "persistence-metadata":
      case "persistence-checkpoint":
        return "永続化の検証用recordであり、アプリの保存内容として採用できないためです。";
      case "migration-journal":
      case "migration-archive":
        return "移行の進行・復旧証拠であり、アプリの保存内容として採用できないためです。";
      case "invalid-source":
        return "原本の形式またはdigestを検証できず、安全なapp payloadとして確定できないためです。";
    }
  }

  if (!candidate.revision || !candidate.digest) {
    return "revisionまたはdigestが不足しており、確定データとの連続性を検証できないためです。";
  }

  switch (candidate.source) {
    case "legacy-localStorage":
      return "旧localStorage原本と確定データの親子関係や新旧を安全に証明できないためです。";
    case "indexedDB":
      return "ほかの保存候補との因果関係やdigestの一致を一意に確認できないためです。";
    case "runtime-fallback":
      return "実行時フォールバックが確定済みrootから連続する保存か安全に証明できないためです。";
    case "migration-journal":
      return "移行の完了とIndexedDBからの直接読戻し検証を確認できないためです。";
  }
}

function displayCandidateValue(value: string | undefined): string {
  return value ?? "情報なし";
}

const PersistenceRecoveryScreen: React.FC<PersistenceRecoveryScreenProps> = ({
  message,
  details = [],
  canExport,
  isRetrying,
  onRetry,
  onExport,
  candidates = [],
  isAdopting = false,
  adoptionError,
  onAdopt,
}) => {
  const [selectedCandidateId, setSelectedCandidateId] = React.useState<
    string | null
  >(null);
  const [hasSafelyExited, setHasSafelyExited] = React.useState(false);
  const [isAdoptionRequested, setIsAdoptionRequested] = React.useState(false);
  const safeExitTitleRef = React.useRef<HTMLHeadingElement>(null);
  const wasAdoptingRef = React.useRef(isAdopting);
  const isBusy = isRetrying || isAdopting || isAdoptionRequested;
  const selectedCandidate = candidates.find(
    ({ id, adoptable }) => id === selectedCandidateId && adoptable === true,
  );

  React.useEffect(() => {
    if (hasSafelyExited) {
      safeExitTitleRef.current?.focus();
    }
  }, [hasSafelyExited]);

  React.useEffect(() => {
    if (adoptionError || (wasAdoptingRef.current && !isAdopting)) {
      setIsAdoptionRequested(false);
    }
    wasAdoptingRef.current = isAdopting;
  }, [adoptionError, isAdopting]);

  const handleAdopt = () => {
    if (isBusy || !selectedCandidate || !onAdopt) return;
    setIsAdoptionRequested(true);
    onAdopt(selectedCandidate.id);
  };

  if (hasSafelyExited) {
    return (
      <main
        className="fixed inset-0 z-[120] overflow-y-auto bg-slate-100 px-4 py-8 dark:bg-slate-950"
        aria-labelledby="persistence-recovery-safe-exit-title"
        aria-describedby="persistence-recovery-safe-exit-message"
      >
        <div className="flex min-h-full items-center justify-center">
          <section className="w-full max-w-2xl rounded-2xl border border-emerald-200 bg-white p-6 shadow-2xl dark:border-emerald-900 dark:bg-slate-900 sm:p-8">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              安全終了
            </p>
            <h1
              id="persistence-recovery-safe-exit-title"
              ref={safeExitTitleRef}
              tabIndex={-1}
              className="mt-2 text-2xl font-bold text-slate-900 outline-none dark:text-white sm:text-3xl"
            >
              何も削除せず終了しました
            </h1>
            <div
              id="persistence-recovery-safe-exit-message"
              className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100"
              role="status"
              aria-live="polite"
            >
              <p>
                保存候補と旧原本は削除も変更もしていません。この画面からアプリの通常画面は開きません。
              </p>
              <p className="mt-2">
                ブラウザまたはPWAのこのタブ（画面）を閉じてください。もう一度確認する場合は、新しいタブでアプリを開いてください。
              </p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const adoptionDescriptionIds = [
    ADOPTION_WARNING_ID,
    !selectedCandidate ? ADOPTION_SELECTION_REASON_ID : null,
    !onAdopt ? ADOPTION_UNAVAILABLE_REASON_ID : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      className="fixed inset-0 z-[120] overflow-y-auto bg-slate-100 px-4 py-8 dark:bg-slate-950"
      aria-labelledby="persistence-recovery-title"
      aria-describedby="persistence-recovery-safety-message"
      aria-busy={isBusy}
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

          {candidates.length > 0 && (
            <section
              className="mt-6"
              aria-labelledby="persistence-recovery-candidates-title"
            >
              <h2
                id="persistence-recovery-candidates-title"
                className="text-lg font-bold text-slate-900 dark:text-white"
              >
                明示的に採用する候補を選ぶ
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                候補の識別情報だけを表示しています。保存内容（payload本文）はこの画面には表示しません。
              </p>
              <fieldset className="mt-3 space-y-3" disabled={isBusy}>
                <legend className="sr-only">明示的に採用する保存候補</legend>
                {candidates.map((candidate, index) => {
                  const inputId = `persistence-recovery-candidate-${index}`;
                  const detailsId = `${inputId}-details`;
                  const reasonId = `${inputId}-reason`;
                  return (
                    <div
                      key={`${candidate.id}-${index}`}
                      className="block rounded-xl border border-slate-300 bg-slate-50 p-4 text-sm text-slate-800 has-[:checked]:border-blue-600 has-[:checked]:ring-2 has-[:checked]:ring-blue-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:has-[:checked]:border-blue-400 dark:has-[:checked]:ring-blue-900"
                    >
                      <label
                        htmlFor={inputId}
                        className="flex cursor-pointer items-start gap-3 font-semibold"
                      >
                        <input
                          id={inputId}
                          type="radio"
                          name="persistence-recovery-candidate"
                          value={`candidate-${index}`}
                          checked={selectedCandidateId === candidate.id}
                          onChange={() => {
                            setSelectedCandidateId(candidate.id);
                            setIsAdoptionRequested(false);
                          }}
                          disabled={candidate.adoptable !== true}
                          aria-describedby={`${detailsId} ${reasonId}`}
                          className="mt-1 size-4 shrink-0 accent-blue-700"
                        />
                        <span>
                          復旧候補 {index + 1}
                          {candidate.adoptable === true
                            ? "（採用可能）"
                            : "（退避のみ）"}
                        </span>
                      </label>
                      <dl
                        id={detailsId}
                        className="mt-2 grid grid-cols-[min-content_1fr] gap-x-3 gap-y-1 pl-7"
                      >
                        <dt className="font-mono font-semibold">source</dt>
                        <dd className="break-all">{candidate.source}</dd>
                        <dt className="font-mono font-semibold">store</dt>
                        <dd className="break-all">
                          {displayCandidateValue(candidate.storeName)}
                        </dd>
                        <dt className="font-mono font-semibold">key</dt>
                        <dd className="break-all">
                          {displayCandidateValue(candidate.key)}
                        </dd>
                        <dt className="font-mono font-semibold">source key</dt>
                        <dd className="break-all">
                          {displayCandidateValue(candidate.sourceKey)}
                        </dd>
                        <dt className="font-mono font-semibold">target key</dt>
                        <dd className="break-all">
                          {displayCandidateValue(candidate.targetKey)}
                        </dd>
                        <dt className="font-mono font-semibold">revision</dt>
                        <dd className="break-all">
                          {displayCandidateValue(candidate.revision)}
                        </dd>
                        <dt className="font-mono font-semibold">digest</dt>
                        <dd className="break-all">
                          {displayCandidateValue(candidate.digest)}
                        </dd>
                      </dl>
                      <p
                        id={reasonId}
                        className="mt-3 pl-7 leading-6 text-amber-800 dark:text-amber-200"
                      >
                        <span className="font-semibold">
                          なぜ自動採用しないか:
                        </span>{" "}
                        {getAutomaticAdoptionRejectionReason(candidate)}
                      </p>
                    </div>
                  );
                })}
              </fieldset>

              <p
                id={ADOPTION_WARNING_ID}
                className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-100"
              >
                <span className="font-bold">警告:</span>{" "}
                採用後は選択候補が今後の確定データになります。先にJSONで退避し、内容を確認できた候補だけを選択してください。採用しても旧原本と未選択候補は削除しません。
              </p>
              {!selectedCandidate && (
                <p
                  id={ADOPTION_SELECTION_REASON_ID}
                  className="mt-2 text-sm text-slate-600 dark:text-slate-400"
                >
                  明示的に採用する候補を1つ選択してください。
                </p>
              )}
              {!onAdopt && (
                <p
                  id={ADOPTION_UNAVAILABLE_REASON_ID}
                  className="mt-2 text-sm text-slate-600 dark:text-slate-400"
                >
                  この画面では候補を採用する処理を利用できません。
                </p>
              )}
              {adoptionError && (
                <p
                  className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-100"
                  role="alert"
                  aria-live="assertive"
                >
                  候補を採用できませんでした。{adoptionError}
                </p>
              )}
              <button
                type="button"
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-red-700 px-4 py-2.5 font-semibold text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-slate-900"
                onClick={handleAdopt}
                disabled={isBusy || !selectedCandidate || !onAdopt}
                aria-describedby={adoptionDescriptionIds}
              >
                {isAdopting || isAdoptionRequested
                  ? "選択候補を採用中…"
                  : "選択候補を明示的に採用"}
              </button>
            </section>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-700 px-4 py-2.5 font-semibold text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-slate-900"
              onClick={onRetry}
              disabled={isBusy}
            >
              {isRetrying ? "読み込みを再試行中…" : "読み込みを再試行"}
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-400 bg-white px-4 py-2.5 font-semibold text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus-visible:ring-offset-slate-900"
              onClick={onExport}
              disabled={!canExport || isBusy}
              aria-describedby={
                !canExport ? EXPORT_UNAVAILABLE_REASON_ID : undefined
              }
            >
              保存候補をJSONで退避
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-400 bg-white px-4 py-2.5 font-semibold text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus-visible:ring-offset-slate-900"
              onClick={() => setHasSafelyExited(true)}
              disabled={isBusy}
            >
              何も削除せず終了
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
};

export default PersistenceRecoveryScreen;
