import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ShoppingItem } from '../types/item';
import {
  normalizePostEventDistributionAnswer,
  POST_EVENT_DISTRIBUTION_OPTIONS,
  type PostEventDistributionAnswer,
} from '../utils/postEventDistributionCheck';

export type PostEventDistributionCheckMode = 'single' | 'bulk';

type PostEventDistributionCheckDialogProps = {
  open: boolean;
  mode: PostEventDistributionCheckMode;
  targets: ShoppingItem[];
  onCancel: () => void;
  onApply: (answers: { itemId: string; answer: PostEventDistributionAnswer }[]) => void;
};

const getItemLabel = (item: ShoppingItem): string => {
  const title = item.title.trim();
  if (title) return title;

  const space = [item.block, item.number].filter(Boolean).join('-');
  return [item.circle, space].filter(Boolean).join(' / ') || 'タイトル未設定';
};

const PostEventDistributionCheckDialog: React.FC<PostEventDistributionCheckDialogProps> = ({
  open,
  mode,
  targets,
  onCancel,
  onApply,
}) => {
  const targetIds = useMemo(() => targets.map((item) => item.id), [targets]);
  const [selectedAnswer, setSelectedAnswer] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set(targetIds));
  const [itemAnswers, setItemAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setSelectedAnswer('');
    setSelectedItemIds(new Set(targetIds));
    setItemAnswers({});
  }, [open, targetIds]);

  if (!open || targets.length === 0) return null;

  const isBulk = mode === 'bulk';
  const allSelected = targetIds.length > 0 && targetIds.every((id) => selectedItemIds.has(id));
  const applyTargetIds = isBulk ? targetIds.filter((id) => selectedItemIds.has(id)) : [targets[0].id];
  const canApply = applyTargetIds.length > 0;

  const toggleAll = (checked: boolean) => {
    setSelectedItemIds(checked ? new Set(targetIds) : new Set());
  };

  const toggleItem = (itemId: string, checked: boolean) => {
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  };

  const applyBulkAnswerToSelectedItems = () => {
    setItemAnswers((current) => {
      const next = { ...current };
      applyTargetIds.forEach((itemId) => {
        next[itemId] = selectedAnswer;
      });
      return next;
    });
  };

  const setItemAnswer = (itemId: string, answer: string) => {
    setItemAnswers((current) => ({
      ...current,
      [itemId]: answer,
    }));
  };

  const handleApply = () => {
    if (!canApply) return;
    onApply(
      applyTargetIds.map((itemId) => ({
        itemId,
        answer: normalizePostEventDistributionAnswer(itemAnswers[itemId] ?? selectedAnswer),
      })),
    );
  };

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="post-event-distribution-check-title"
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800"
      >
        <h2
          id="post-event-distribution-check-title"
          className="text-lg font-semibold text-slate-900 dark:text-white"
        >
          事後通販･頒布可否確認
        </h2>

        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              {isBulk ? '一括回答' : '回答内容'}
              <select
                aria-label={isBulk ? '一括回答' : '回答内容'}
                value={selectedAnswer}
                onChange={(event) => setSelectedAnswer(event.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-slate-600 dark:bg-slate-700 dark:text-white"
              >
                <option value="">未確認</option>
                {POST_EVENT_DISTRIBUTION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            {isBulk && (
              <button
                type="button"
                onClick={applyBulkAnswerToSelectedItems}
                disabled={!canApply}
                className="rounded-md border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950/30 dark:disabled:border-slate-600 dark:disabled:text-slate-500"
              >
                選択中に一括適用
              </button>
            )}
          </div>

          {isBulk ? (
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => toggleAll(event.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                />
                <span>スペース内全アイテムに適用</span>
              </label>
              <div className="mt-2 max-h-72 space-y-2 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-700">
                {targets.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md px-1 py-1 text-sm text-slate-700 dark:text-slate-300 sm:grid-cols-[auto_minmax(0,1fr)_minmax(9rem,12rem)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedItemIds.has(item.id)}
                      onChange={(event) => toggleItem(item.id, event.target.checked)}
                      className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                    />
                    <span className="min-w-0 flex-1 break-words">{getItemLabel(item)}</span>
                    <select
                      aria-label={`${getItemLabel(item)}の回答内容`}
                      value={itemAnswers[item.id] ?? selectedAnswer}
                      onChange={(event) => setItemAnswer(item.id, event.target.value)}
                      disabled={!selectedItemIds.has(item.id)}
                      className="col-span-2 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-600 dark:bg-slate-700 dark:text-white dark:disabled:bg-slate-800 sm:col-span-1"
                    >
                      <option value="">未確認</option>
                      {POST_EVENT_DISTRIBUTION_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
              {getItemLabel(targets[0])}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            記録
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return dialog;
  }

  return createPortal(dialog, document.body);
};

export default PostEventDistributionCheckDialog;
