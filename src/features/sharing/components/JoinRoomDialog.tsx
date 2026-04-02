import React, { useState, useRef, useEffect, useCallback } from 'react';

interface ExistingMember {
  jerseyNumber: number;
  displayName: string;
}

interface JoinRoomDialogProps {
  onClose: () => void;
  onJoinRoom: (roomCode: string, displayName: string) => Promise<void>;
  onRejoinRoom: (roomCode: string, displayName: string, jerseyNumber?: number) => Promise<void>;
  onMergeItems?: () => Promise<void>;
  onFetchExistingMembers?: (roomCode: string) => Promise<ExistingMember[]>;
  initialCode?: string;
}

const JoinRoomDialog: React.FC<JoinRoomDialogProps> = ({
  onClose,
  onJoinRoom,
  onRejoinRoom,
  onMergeItems,
  onFetchExistingMembers,
  initialCode,
}) => {
  const [step, setStep] = useState<'input' | 'selectMember' | 'migrate' | 'joining'>('input');
  const [code, setCode] = useState(initialCode?.toUpperCase() ?? '');
  const [displayName, setDisplayName] = useState(
    localStorage.getItem('sharing:displayName') ?? '',
  );
  const [isRejoin, setIsRejoin] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [existingMembers, setExistingMembers] = useState<ExistingMember[]>([]);
  const [selectedMember, setSelectedMember] = useState<ExistingMember | null>(null);
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

  // 再参加用: 既存メンバー一覧を取得
  const handleFetchMembers = useCallback(async () => {
    if (code.length !== 5 || !onFetchExistingMembers) return;
    setIsLoading(true);
    setError('');
    try {
      const members = await onFetchExistingMembers(code);
      if (members.length === 0) {
        setError('ルームにメンバーが見つかりません');
        setIsLoading(false);
        return;
      }
      setExistingMembers(members);
      setStep('selectMember');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'メンバー取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  }, [code, onFetchExistingMembers]);

  const handleJoin = async () => {
    if (code.length !== 5) {
      setError('5文字のルームコードを入力してください');
      return;
    }

    // 再参加モード: メンバー一覧を表示
    if (isRejoin) {
      await handleFetchMembers();
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
      await onJoinRoom(code, displayName.trim());

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

  // 選択したメンバーで再参加
  const handleRejoinWithMember = async () => {
    if (!selectedMember) return;

    const name = displayName.trim() || selectedMember.displayName;
    setError('');
    setIsLoading(true);

    try {
      localStorage.setItem('sharing:displayName', name);
      await onRejoinRoom(code, name, selectedMember.jerseyNumber);

      if (onMergeItems) {
        setStep('migrate');
        setIsLoading(false);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '再参加に失敗しました');
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
              {!isRejoin && (
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
              )}
              <label className="flex items-center space-x-2 text-sm text-slate-600 dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isRejoin}
                  onChange={(e) => setIsRejoin(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-600"
                />
                <span>再参加（背番号で割り振りデータを引き継ぎ）</span>
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
                  {isLoading ? (isRejoin ? 'メンバー取得中...' : '参加中...') : (isRejoin ? '背番号を選択' : '参加')}
                </button>
              </div>
            </>
          )}

          {step === 'selectMember' && (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                以前の背番号を選択してください。割り振りデータを引き継げます。
              </p>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  表示名（変更可能）
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
              <div className="space-y-1">
                {existingMembers.map((member) => (
                  <button
                    key={member.jerseyNumber}
                    onClick={() => {
                      setSelectedMember(member);
                      if (!displayName.trim()) {
                        setDisplayName(member.displayName);
                      }
                    }}
                    className={`flex items-center space-x-3 w-full px-3 py-2.5 rounded-lg transition-colors ${
                      selectedMember?.jerseyNumber === member.jerseyNumber
                        ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {member.jerseyNumber}
                    </div>
                    <div className="text-left">
                      <span className="text-sm font-medium text-slate-800 dark:text-white">
                        #{member.jerseyNumber} {member.displayName}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => { setStep('input'); setSelectedMember(null); }}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  戻る
                </button>
                <button
                  onClick={handleRejoinWithMember}
                  disabled={isLoading || !selectedMember}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? '再参加中...' : '再参加'}
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
