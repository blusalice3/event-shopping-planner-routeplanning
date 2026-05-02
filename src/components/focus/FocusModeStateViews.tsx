import type { ShoppingItem } from '../../types/item';
import type React from 'react';
import type { ResumeChoiceDialogState } from './resumeChoice';

const resumePhaseNameMap = {
  normal: '通常',
  postponed: '後回し',
  late: '遅参',
} as const;

export function ResumeChoiceDialogView({
  dialog,
  onChoice,
}: {
  dialog: ResumeChoiceDialogState;
  onChoice: (choice: 'lastChange' | 'pointer' | 'phaseStart' | 'normalStart') => void;
}) {
  const lastPhaseName = resumePhaseNameMap[dialog.lastPhase];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-choice-title"
      >
        <div className="bg-gradient-to-r from-teal-500 to-indigo-600 px-6 py-5 text-white">
          <h2 id="resume-choice-title" className="text-xl font-bold">
            集中モードを再開しますか？
          </h2>
          <p className="mt-1 text-sm text-white/85">
            どこから再開するか選んでください
          </p>
        </div>
        <div className="space-y-3 p-6">
          <button
            type="button"
            onClick={() => onChoice('lastChange')}
            disabled={!dialog.lastChangeEnabled}
            className="w-full rounded-lg bg-teal-600 px-4 py-3 text-left font-medium text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="block">最後に購入状態を変更したスペース</span>
            <span className="mt-1 block text-sm font-normal text-white/85">
              {dialog.lastSpaceLabel} ({lastPhaseName}フェーズ)
            </span>
          </button>
          <button
            type="button"
            onClick={() => onChoice('pointer')}
            className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-left font-medium text-white transition-colors hover:bg-indigo-700"
          >
            離脱時のポインタ位置
          </button>
          <button
            type="button"
            onClick={() => onChoice('phaseStart')}
            disabled={!dialog.phaseStartEnabled}
            className="w-full rounded-lg bg-slate-100 px-4 py-3 text-left font-medium text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
          >
            現在のフェーズの最初から
          </button>
          <button
            type="button"
            onClick={() => onChoice('normalStart')}
            disabled={!dialog.normalStartEnabled}
            className="w-full rounded-lg bg-slate-100 px-4 py-3 text-left font-medium text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
          >
            通常フェーズの最初から
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmptyVisitStateView({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-8">
      <div className="text-6xl mb-4">📋</div>
      <h2 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-2">
        訪問先がありません
      </h2>
      <p className="text-slate-500 dark:text-slate-400 mb-6 text-center">
        実行列にアイテムを追加してください
      </p>
      <button
        onClick={onEdit}
        className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
      >
        編集モードへ
      </button>
    </div>
  );
}

export function AutoAdvancingStateView() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-8">
      <div className="text-4xl mb-4 animate-spin">⏳</div>
      <p className="text-slate-500 dark:text-slate-400">次の訪問先を探しています...</p>
    </div>
  );
}

export function CompletionStateView({
  executeItems,
  layoutMode,
  onPrev,
  onModeChange,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  executeItems: ShoppingItem[];
  layoutMode: 'pc' | 'smartphone';
  onPrev: () => void;
  onModeChange: (mode: 'edit' | 'execute') => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
}) {
  const purchased = executeItems.filter((i) => i.purchaseStatus === 'Purchased');
  const soldOut = executeItems.filter((i) => i.purchaseStatus === 'SoldOut');
  const absent = executeItems.filter((i) => i.purchaseStatus === 'Absent');
  const postponed = executeItems.filter((i) => i.purchaseStatus === 'Postpone');
  const late = executeItems.filter((i) => i.purchaseStatus === 'Late');
  const unprocessed = executeItems.filter((i) => i.purchaseStatus === 'None');
  const purchasedAmount = purchased.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);
  const totalPlanned = executeItems.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[50vh] p-8 relative"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {layoutMode === 'pc' && (
        <button
          onClick={onPrev}
          className="fixed left-4 top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-all z-40"
          title="前の訪問先"
        >
          ◀
        </button>
      )}

      {layoutMode === 'smartphone' && (
        <div className="absolute top-4 left-0 right-0 text-center text-sm text-slate-500 dark:text-slate-400">
          ← 右スワイプで前の訪問先へ戻る
        </div>
      )}

      <div className="text-6xl mb-4">🎉</div>
      <h2 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-2">
        全ての訪問先を確認しました
      </h2>
      <p className="text-slate-500 dark:text-slate-400 mb-4 text-center">お疲れ様でした！</p>

      <div className="w-full max-w-sm mb-6 bg-slate-50 dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 mb-3 text-center">
          購入結果
        </h3>
        <div className="space-y-1.5 text-sm">
          <SummaryRow label="✅ 購入済み" value={purchased.length} className="text-green-600 dark:text-green-400" />
          {soldOut.length > 0 && <SummaryRow label="❌ 売切" value={soldOut.length} className="text-red-600 dark:text-red-400" />}
          {absent.length > 0 && <SummaryRow label="⚠️ 欠席" value={absent.length} className="text-yellow-600 dark:text-yellow-400" />}
          {postponed.length > 0 && <SummaryRow label="⏸️ 後回し" value={postponed.length} className="text-purple-600 dark:text-purple-400" />}
          {late.length > 0 && <SummaryRow label="🕐 遅参" value={late.length} className="text-blue-600 dark:text-blue-400" />}
          {unprocessed.length > 0 && <SummaryRow label="⬚ 未処理" value={unprocessed.length} className="text-slate-500 dark:text-slate-400" />}
        </div>

        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-600 space-y-1.5 text-sm">
          <AmountRow label="購入合計" amount={purchasedAmount} strong />
          <AmountRow label="予定合計" amount={totalPlanned} />
        </div>
      </div>

      <div className="flex gap-4">
        <button
          onClick={() => onModeChange('edit')}
          className="px-6 py-3 bg-slate-600 text-white rounded-lg font-medium hover:bg-slate-700 transition-colors flex items-center gap-2"
        >
          <span>📝 編集モードへ</span>
        </button>
        <button
          onClick={() => onModeChange('execute')}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors flex items-center gap-2"
        >
          <span>🏃 実行モードへ</span>
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className={className}>{label}</span>
      <span className="font-semibold text-slate-700 dark:text-slate-300">{value} 件</span>
    </div>
  );
}

function AmountRow({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <span className={strong ? 'font-bold text-green-600 dark:text-green-400' : 'font-semibold text-slate-700 dark:text-slate-300'}>
        ¥{amount.toLocaleString()}
      </span>
    </div>
  );
}
