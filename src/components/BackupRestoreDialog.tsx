import React, { useEffect, useMemo, useState } from "react";

type RestoreMode = "copy" | "replace";

interface BackupRestoreDialogProps {
  isOpen: boolean;
  backupEventNames: string[];
  currentEventNames: string[];
  onClose: () => void;
  onRestore: (
    sourceEventName: string,
    targetEventName: string,
  ) => Promise<void>;
}

export function createUniqueRestoredEventName(
  sourceEventName: string,
  currentEventNames: readonly string[],
): string {
  const usedNames = new Set(currentEventNames);
  const firstCandidate = `${sourceEventName}（復元）`;
  if (!usedNames.has(firstCandidate)) return firstCandidate;

  let suffix = 2;
  while (usedNames.has(`${sourceEventName}（復元${suffix}）`)) {
    suffix += 1;
  }
  return `${sourceEventName}（復元${suffix}）`;
}

const BackupRestoreDialog: React.FC<BackupRestoreDialogProps> = ({
  isOpen,
  backupEventNames,
  currentEventNames,
  onClose,
  onRestore,
}) => {
  const [sourceEventName, setSourceEventName] = useState("");
  const [restoreMode, setRestoreMode] = useState<RestoreMode>("copy");
  const [targetEventName, setTargetEventName] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const backupEventNamesSignature = JSON.stringify(backupEventNames);

  useEffect(() => {
    if (!isOpen) return;
    const initialSource = backupEventNames[0] ?? "";
    setSourceEventName(initialSource);
    setRestoreMode("copy");
    setTargetEventName(
      initialSource
        ? createUniqueRestoredEventName(initialSource, currentEventNames)
        : "",
    );
    setIsRestoring(false);
    setErrorMessage("");
  }, [backupEventNamesSignature, isOpen]);

  const trimmedTargetName = targetEventName.trim();
  const copyNameAlreadyExists =
    restoreMode === "copy" &&
    currentEventNames.includes(trimmedTargetName) &&
    trimmedTargetName.length > 0;
  const resolvedTargetName =
    restoreMode === "replace" ? sourceEventName : trimmedTargetName;
  const canRestore =
    sourceEventName.length > 0 &&
    resolvedTargetName.length > 0 &&
    !copyNameAlreadyExists &&
    !isRestoring;
  const replacesExistingEvent = useMemo(
    () => currentEventNames.includes(sourceEventName),
    [currentEventNames, sourceEventName],
  );

  if (!isOpen) return null;

  const handleSourceChange = (nextSource: string) => {
    setSourceEventName(nextSource);
    setErrorMessage("");
    if (restoreMode === "copy") {
      setTargetEventName(
        createUniqueRestoredEventName(nextSource, currentEventNames),
      );
    }
  };

  const handleModeChange = (nextMode: RestoreMode) => {
    setRestoreMode(nextMode);
    setErrorMessage("");
    if (nextMode === "copy") {
      setTargetEventName(
        createUniqueRestoredEventName(sourceEventName, currentEventNames),
      );
    }
  };

  const handleRestore = async () => {
    if (!canRestore) return;
    setIsRestoring(true);
    setErrorMessage("");
    try {
      await onRestore(sourceEventName, resolvedTargetName);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "復元中に予期しないエラーが発生しました。",
      );
      setIsRestoring(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isRestoring) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-restore-title"
        className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-800"
      >
        <h2
          id="backup-restore-title"
          className="text-xl font-semibold text-slate-900 dark:text-white"
        >
          バックアップからイベントを復元
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          選んだイベントだけを復元します。他のイベントは変更されません。
        </p>

        <label className="mt-5 block text-sm font-medium text-slate-700 dark:text-slate-200">
          復元するイベント
          <select
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-700 dark:text-white"
            value={sourceEventName}
            onChange={(event) => handleSourceChange(event.target.value)}
            disabled={isRestoring}
          >
            {backupEventNames.map((eventName) => (
              <option key={eventName} value={eventName}>
                {eventName}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="mt-5 space-y-3">
          <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">
            復元方法
          </legend>
          <label className="flex cursor-pointer gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/40">
            <input
              type="radio"
              name="backup-restore-mode"
              value="copy"
              checked={restoreMode === "copy"}
              onChange={() => handleModeChange("copy")}
              disabled={isRestoring}
            />
            <span>
              <span className="block font-medium text-slate-900 dark:text-white">
                別名で復元（推奨）
              </span>
              <span className="block text-sm text-slate-600 dark:text-slate-300">
                現在のデータを残したまま、別のイベントとして追加します。
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-lg border border-red-200 p-3 dark:border-red-900">
            <input
              type="radio"
              name="backup-restore-mode"
              value="replace"
              checked={restoreMode === "replace"}
              onChange={() => handleModeChange("replace")}
              disabled={isRestoring}
            />
            <span>
              <span className="block font-medium text-red-700 dark:text-red-300">
                同名で置換
              </span>
              <span className="block text-sm text-slate-600 dark:text-slate-300">
                同じ名前の現在データを、バックアップ内容に入れ替えます。
              </span>
            </span>
          </label>
        </fieldset>

        {restoreMode === "copy" ? (
          <label className="mt-5 block text-sm font-medium text-slate-700 dark:text-slate-200">
            復元後のイベント名
            <input
              type="text"
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-700 dark:text-white"
              value={targetEventName}
              onChange={(event) => {
                setTargetEventName(event.target.value);
                setErrorMessage("");
              }}
              disabled={isRestoring}
            />
            {copyNameAlreadyExists && (
              <span className="mt-1 block text-sm text-red-600 dark:text-red-400">
                この名前は使用中です。別の名前を入力してください。
              </span>
            )}
          </label>
        ) : (
          <div
            className="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
            role="alert"
          >
            {replacesExistingEvent
              ? `現在の「${sourceEventName}」の全データが置き換わります。`
              : `「${sourceEventName}」を同じ名前で新しく復元します。`}
          </div>
        )}

        {errorMessage && (
          <p
            className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
            role="alert"
          >
            {errorMessage}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-700"
            onClick={onClose}
            disabled={isRestoring}
          >
            キャンセル
          </button>
          <button
            type="button"
            className={`rounded-lg px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
              restoreMode === "replace"
                ? "bg-red-600 hover:bg-red-700"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
            onClick={() => void handleRestore()}
            disabled={!canRestore}
          >
            {isRestoring
              ? "復元中…"
              : restoreMode === "replace"
                ? "置換して復元"
                : "別名で復元"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BackupRestoreDialog;
