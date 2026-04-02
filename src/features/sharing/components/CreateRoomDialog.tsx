import React, { useState } from 'react';
import { supabase } from '../config/supabase';
import QRCodeDisplay from './QRCodeDisplay';

interface CreateRoomDialogProps {
  eventName: string;
  onClose: () => void;
  onCreateRoom: (displayName: string, expiresAt: string) => Promise<{ roomCode: string }>;
  onMigrateItems: () => Promise<void>;
}

const CreateRoomDialog: React.FC<CreateRoomDialogProps> = ({
  eventName,
  onClose,
  onCreateRoom,
  onMigrateItems,
}) => {
  const [step, setStep] = useState<'input' | 'checking' | 'migrate' | 'done'>('input');
  const [displayName, setDisplayName] = useState(
    localStorage.getItem('sharing:displayName') ?? '',
  );
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleCreate = async () => {
    if (!displayName.trim()) {
      setError('表示名を入力してください');
      return;
    }

    setError('');
    setStep('checking');
    setIsLoading(true);

    // Supabase疎通確認（RLS制限のないAuth APIを使用）
    try {
      if (supabase) {
        const { error: pingError } = await supabase.auth.getSession();
        if (pingError) {
          setError('Supabaseに接続できません。ダッシュボードでプロジェクトが稼働中か確認してください。');
          setStep('input');
          setIsLoading(false);
          return;
        }
      }
    } catch {
      setError('ネットワークエラーが発生しました。');
      setStep('input');
      setIsLoading(false);
      return;
    }

    try {
      localStorage.setItem('sharing:displayName', displayName.trim());

      // 有効期限: 翌日の23:59
      const expires = new Date();
      expires.setDate(expires.getDate() + 1);
      expires.setHours(23, 59, 59, 999);

      const result = await onCreateRoom(displayName.trim(), expires.toISOString());
      setRoomCode(result.roomCode);
      setStep('migrate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ルーム作成に失敗しました');
      setStep('input');
    } finally {
      setIsLoading(false);
    }
  };

  const handleMigrate = async () => {
    setIsLoading(true);
    try {
      await onMigrateItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'データ移行に失敗しました');
    } finally {
      setIsLoading(false);
      setStep('done');
    }
  };

  const handleSkipMigrate = () => {
    setStep('done');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            ルーム作成 - {eventName}
          </h3>
        </div>

        <div className="p-4 space-y-4">
          {step === 'input' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  表示名
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="あなたの名前"
                  className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  maxLength={20}
                  autoFocus
                />
              </div>
              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleCreate}
                  disabled={isLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? '作成中...' : 'ルームを作成'}
                </button>
              </div>
            </>
          )}

          {step === 'checking' && (
            <div className="text-center py-8">
              <p className="text-slate-600 dark:text-slate-400">接続を確認中...</p>
            </div>
          )}

          {step === 'migrate' && (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                ローカルの買い物リストをルームに共有しますか？
              </p>
              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={handleSkipMigrate}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  空のルームを作成
                </button>
                <button
                  onClick={handleMigrate}
                  disabled={isLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? '共有中...' : '共有する'}
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <QRCodeDisplay roomCode={roomCode} />
              <div className="flex justify-center">
                <button
                  onClick={onClose}
                  className="px-6 py-2 text-sm font-medium rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                >
                  閉じる
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CreateRoomDialog;
