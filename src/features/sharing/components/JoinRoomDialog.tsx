import React, { useState, useRef, useEffect } from 'react';

interface JoinRoomDialogProps {
  onClose: () => void;
  onJoinRoom: (roomCode: string, displayName: string) => Promise<void>;
  onRejoinRoom: (roomCode: string, displayName: string) => Promise<void>;
  onMergeItems?: () => Promise<void>;
  initialCode?: string;
}

const JoinRoomDialog: React.FC<JoinRoomDialogProps> = ({
  onClose,
  onJoinRoom,
  onRejoinRoom,
  onMergeItems,
  initialCode,
}) => {
  const [step, setStep] = useState<'input' | 'migrate' | 'joining'>('input');
  const [code, setCode] = useState(initialCode?.toUpperCase() ?? '');
  const [displayName, setDisplayName] = useState(
    localStorage.getItem('sharing:displayName') ?? '',
  );
  const [isRejoin, setIsRejoin] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current && !initialCode) {
      inputRef.current.focus();
    }
  }, [initialCode]);

  const handleCodeChange = (value: string) => {
    const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    setCode(cleaned);
  };

  const handleJoin = async () => {
    if (code.length !== 5) {
      setError('5文字のルームコードを入力してください');
      return;
    }
    if (!displayName.trim()) {
      setError('表示名を入力してください');
      return;
    }

    setError('');
    setIsLoading(true);

    try {
      localStorage.setItem('sharing:displayName', displayName.trim());

      if (isRejoin) {
        await onRejoinRoom(code, displayName.trim());
      } else {
        await onJoinRoom(code, displayName.trim());
      }

      if (onMergeItems) {
        setStep('migrate');
        setIsLoading(false);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '参加に失敗しました');
      setIsLoading(false);
    }
  };

  const handleMerge = async () => {
    setIsLoading(true);
    try {
      await onMergeItems?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'マージに失敗しました');
    } finally {
      setIsLoading(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">ルームに参加</h3>
        </div>

        <div className="p-4 space-y-4">
          {step === 'input' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  ルームコード
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  value={code}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  placeholder="ABCDE"
                  className="w-full px-3 py-3 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-center text-2xl font-bold tracking-[0.5em] focus:ring-2 focus:ring-blue-500 outline-none"
                  maxLength={5}
                  autoComplete="off"
                />
              </div>
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
                />
              </div>
              <label className="flex items-center space-x-2 text-sm text-slate-600 dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isRejoin}
                  onChange={(e) => setIsRejoin(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-600"
                />
                <span>再参加（同じ名前で以前参加していた場合）</span>
              </label>
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
                  onClick={handleJoin}
                  disabled={isLoading || code.length !== 5}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? '参加中...' : '参加'}
                </button>
              </div>
            </>
          )}

          {step === 'migrate' && (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                自分の買い物リストもルームにマージしますか？
              </p>
              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400"
                >
                  スキップ
                </button>
                <button
                  onClick={handleMerge}
                  disabled={isLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? 'マージ中...' : 'マージする'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default JoinRoomDialog;
