import React from "react";
import type {
  LegacyCleanupStatus,
  PersistenceFailureDetail,
  PersistenceStatus,
  PersistedStoreName,
} from "../hooks/useIndexedDbPersistence";

interface PersistenceStatusIndicatorProps {
  status: PersistenceStatus;
  legacyCleanupStatus?: LegacyCleanupStatus;
  showRoutineStatus: boolean;
  failedStores: readonly PersistedStoreName[];
  failureDetails?: readonly PersistenceFailureDetail[];
  onRetry: () => void;
  onExportBackup: () => void;
}

const STORE_LABELS: Record<PersistedStoreName, string> = {
  eventLists: "イベントリスト",
  eventMetadata: "イベント情報",
  executeModeItems: "実行リスト",
  dayModes: "表示モード",
  mapData: "マップ",
  mapRotationSettings: "マップの回転",
  routeSettings: "経路",
  hallDefinitions: "会場",
  hallRouteSettings: "会場の巡回設定",
  mapViewportSettings: "マップの表示位置",
};

const PersistenceStatusIndicator: React.FC<PersistenceStatusIndicatorProps> = ({
  status,
  legacyCleanupStatus = "not-needed",
  showRoutineStatus,
  failedStores,
  failureDetails = [],
  onRetry,
  onExportBackup,
}) => {
  if (status === "failed") {
    const failedLabels = failedStores.map(
      (storeName) => STORE_LABELS[storeName],
    );

    return (
      <aside
        className="fixed bottom-4 right-4 z-[90] w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-red-300 bg-red-50 p-4 shadow-xl dark:border-red-800 dark:bg-red-950"
        role="alert"
        aria-live="assertive"
      >
        <p className="font-semibold text-red-800 dark:text-red-100">
          保存に失敗しました
        </p>
        <p className="mt-1 text-sm text-red-700 dark:text-red-200">
          このまま画面を閉じると、直前の変更を失う可能性があります。
        </p>
        {failedLabels.length > 0 && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-300">
            保存できなかった内容: {failedLabels.join("・")}
          </p>
        )}
        {failureDetails.length > 0 && (
          <ul
            className="mt-3 space-y-2 text-sm text-red-800 dark:text-red-100"
            aria-label="保存失敗の詳細"
          >
            {failureDetails.map((failure, index) => (
              <li
                key={`${failure.storeName}-${index}`}
                className="rounded-lg border border-red-200 bg-white/70 p-2 dark:border-red-800 dark:bg-red-950/70"
              >
                <p>
                  <span className="font-semibold">
                    {STORE_LABELS[failure.storeName]}
                  </span>
                  : {failure.userMessage}
                </p>
                <p className="mt-1 break-words text-xs text-red-600 dark:text-red-300">
                  原因コード: {failure.errorCode}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800"
            onClick={onRetry}
          >
            保存を再試行
          </button>
          <button
            type="button"
            className="rounded-lg border border-red-500 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900"
            onClick={onExportBackup}
          >
            JSONバックアップを保存
          </button>
        </div>
      </aside>
    );
  }

  const isLegacyDataRetained =
    legacyCleanupStatus === "ready" ||
    legacyCleanupStatus === "deferred" ||
    legacyCleanupStatus === "in-progress";

  if (!showRoutineStatus && !isLegacyDataRetained) {
    return null;
  }

  const presentation = {
    unsaved: {
      label: "未保存",
      className:
        "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
    },
    saving: {
      label: "保存中…",
      className:
        "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200",
    },
    saved: {
      label: isLegacyDataRetained ? "保存済み・旧データ保全中" : "保存済み",
      className:
        "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    },
  }[status];

  return (
    <div
      className={`fixed bottom-4 right-4 z-[80] rounded-full border px-3 py-1.5 text-xs font-medium shadow ${presentation.className}`}
      role="status"
      aria-live="polite"
      aria-label={presentation.label}
      title={
        isLegacyDataRetained
          ? "旧データの削除は安全条件が揃うまで延期しています。通常の保存は継続しています。"
          : undefined
      }
    >
      {presentation.label}
    </div>
  );
};

export default PersistenceStatusIndicator;
