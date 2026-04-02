import React, { useState } from 'react';
import type { MigrationMode, MigrationResult } from '../types/room';

interface DataMigrationDialogProps {
  mode: MigrationMode;
  onMigrate: () => Promise<MigrationResult | void>;
  onSkip: () => void;
  onClose: () => void;
}

const modeConfig: Record<
  MigrationMode,
  {
    title: string;
    message: string;
    confirmLabel: string;
    skipLabel: string;
  }
> = {
  'host-create': {
    title: 'データ共有',
    message: 'ローカルの買い物リストをルームに共有しますか？',
    confirmLabel: '共有する',
    skipLabel: '空のルームを作成',
  },
  'guest-join': {
    title: 'データマージ',
    message: '自分の買い物リストもルームにマージしますか？',
    confirmLabel: 'マージする',
    skipLabel: 'スキップ',
  },
  leave: {
    title: 'データ保存',
    message: '最新のルームデータをローカルに保存しますか？',
    confirmLabel: '保存する',
    skipLabel: '保存しない',
  },
};

const DataMigrationDialog: React.FC<DataMigrationDialogProps> = ({
  mode,
  onMigrate,
  onSkip,
  onClose,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState('');
  const config = modeConfig[mode];

  const handleMigrate = async () => {
    setIsLoading(true);
    setError('');
    try {
      const migrationResult = await onMigrate();
      if (migrationResult && 'added' in migrationResult) {
        setResult(migrationResult);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '処理に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            {config.title}
          </h3>
        </div>

        <div className="p-4 space-y-4">
          {result ? (
            <>
              <div className="text-sm text-slate-700 dark:text-slate-300 space-y-1">
                <p>{result.added}件のアイテムを追加しました。</p>
                {result.skipped > 0 && (
                  <p className="text-slate-500 dark:text-slate-400">
                    {result.skipped}件の重複アイテムはスキップしました。
                  </p>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  OK
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">{config.message}</p>
              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={onSkip}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  {config.skipLabel}
                </button>
                <button
                  onClick={handleMigrate}
                  disabled={isLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? '処理中...' : config.confirmLabel}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DataMigrationDialog;
