import React, { useState } from 'react';
import type { MigrationMode, MigrationResult } from '../types/room';

export interface RejoinSummary {
  jerseyNumber: number;
  displayName: string;
  myItems: { unpurchased: number; purchased: number; soldOut: number };
  teamSummary: { jerseyNumber: number; displayName: string; remaining: number; isMe: boolean }[];
}

interface DataMigrationDialogProps {
  mode: MigrationMode;
  onMigrate: () => Promise<MigrationResult | void>;
  onSkip: () => void;
  onClose: () => void;
  rejoinSummary?: RejoinSummary | null;
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
  'rejoin-summary': {
    title: '再参加完了',
    message: '',
    confirmLabel: 'OK',
    skipLabel: '',
  },
};

const DataMigrationDialog: React.FC<DataMigrationDialogProps> = ({
  mode,
  onMigrate,
  onSkip,
  onClose,
  rejoinSummary,
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
          {mode === 'rejoin-summary' && rejoinSummary ? (
            <>
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                ルームに再参加しました（#{rejoinSummary.jerseyNumber} {rejoinSummary.displayName}）
              </p>
              <div className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
                <p className="font-medium">あなたの担当アイテム:</p>
                <div className="pl-2 space-y-0.5 text-xs">
                  <p>未購入: {rejoinSummary.myItems.unpurchased}件</p>
                  <p>購入済み: {rejoinSummary.myItems.purchased}件</p>
                  {rejoinSummary.myItems.soldOut > 0 && (
                    <p>完売/不在: {rejoinSummary.myItems.soldOut}件</p>
                  )}
                </div>
              </div>
              {rejoinSummary.teamSummary.length > 0 && (
                <div className="text-sm text-slate-700 dark:text-slate-300 space-y-1">
                  <p className="font-medium">チーム全体:</p>
                  <div className="pl-2 space-y-0.5 text-xs">
                    {rejoinSummary.teamSummary.map((m) => (
                      <p key={m.jerseyNumber} className={m.isMe ? 'font-bold text-blue-600 dark:text-blue-400' : ''}>
                        #{m.jerseyNumber} {m.displayName}{m.isMe ? '(あなた)' : ''}: 残り{m.remaining}件
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  OK
                </button>
              </div>
            </>
          ) : result ? (
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
