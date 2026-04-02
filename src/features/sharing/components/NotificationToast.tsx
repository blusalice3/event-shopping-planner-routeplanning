import React from 'react';
import type { AppNotification } from '../services/notificationService';

interface NotificationToastProps {
  notification: AppNotification;
  onDismiss: () => void;
  onAction?: (notification: AppNotification) => void;
}

const typeConfig: Record<string, { icon: string; label: string; actionLabel?: string }> = {
  limited_purchase: { icon: '⚠️', label: '限数購入', actionLabel: '追加購入を引き受ける' },
  help_request: { icon: '🆘', label: 'ヘルプ要請', actionLabel: '引き受ける' },
  help_accepted: { icon: '✅', label: 'ヘルプ承諾' },
  bulk_transfer: { icon: '📦', label: 'アイテム転送' },
  price_update: { icon: '💰', label: '価格更新' },
  item_added: { icon: '➕', label: 'アイテム追加' },
};

const NotificationToast: React.FC<NotificationToastProps> = ({
  notification,
  onDismiss,
  onAction,
}) => {
  const config = typeConfig[notification.type] ?? { icon: '🔔', label: '通知' };
  const senderName = notification.payload?.senderName as string | undefined;
  const message = notification.payload?.message as string | undefined;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[90vw] max-w-md animate-fade-in">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="px-4 py-3 flex items-start space-x-3">
          <span className="text-xl flex-shrink-0">{config.icon}</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              {config.label}
              {senderName && ` - ${senderName}`}
            </p>
            <p className="text-sm text-slate-800 dark:text-white mt-0.5 line-clamp-2">
              {message || formatDefaultMessage(notification)}
            </p>
            <div className="flex items-center space-x-2 mt-2">
              {config.actionLabel && onAction && (
                <button
                  onClick={() => onAction(notification)}
                  className="px-3 py-1 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  {config.actionLabel}
                </button>
              )}
              <button
                onClick={onDismiss}
                className="px-3 py-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function formatDefaultMessage(notification: AppNotification): string {
  const p = notification.payload;
  switch (notification.type) {
    case 'limited_purchase': {
      const name = p.senderName ?? '誰か';
      const circle = p.circleName ?? '';
      return `${name}さんが${circle}を限数購入しました。追加購入が必要です。`;
    }
    case 'help_request': {
      const name = p.senderName ?? '誰か';
      const circle = p.circleName ?? '';
      return `${name}さんが${circle}でヘルプを求めています。`;
    }
    case 'help_accepted': {
      const name = p.senderName ?? '誰か';
      return `${name}さんがヘルプを引き受けました。`;
    }
    case 'bulk_transfer': {
      const name = p.senderName ?? '誰か';
      const count = p.itemCount ?? 0;
      return `${name}さんから${count}件のアイテムが転送されました。`;
    }
    case 'price_update': {
      const circle = p.circleName ?? '';
      const price = p.price ?? 0;
      return `${circle}の価格が¥${price}に更新されました。`;
    }
    default:
      return '新しい通知があります。';
  }
}

export default NotificationToast;
