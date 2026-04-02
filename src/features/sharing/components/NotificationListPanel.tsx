import React from 'react';
import type { AppNotification } from '../services/notificationService';

interface NotificationListPanelProps {
  notifications: AppNotification[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onAction?: (notification: AppNotification) => void;
  onApproveRejoin?: (notification: AppNotification) => void;
  onRejectRejoin?: (notification: AppNotification) => void;
  onAcceptHostTransfer?: (notification: AppNotification) => void;
  onDeclineHostTransfer?: (notification: AppNotification) => void;
  onVetoHostTransfer?: (notification: AppNotification) => void;
  onClose: () => void;
}

const typeLabels: Record<string, { icon: string; label: string }> = {
  limited_purchase: { icon: '⚠️', label: '限数購入' },
  help_request: { icon: '🆘', label: 'ヘルプ要請' },
  help_accepted: { icon: '✅', label: 'ヘルプ承諾' },
  bulk_transfer: { icon: '📦', label: 'アイテム転送' },
  price_update: { icon: '💰', label: '価格更新' },
  item_added: { icon: '➕', label: 'アイテム追加' },
  rejoin_request: { icon: '🔄', label: '再参加リクエスト' },
  rejoin_approved: { icon: '✅', label: '再参加承認' },
  rejoin_rejected: { icon: '❌', label: '再参加拒否' },
  host_transfer_offer: { icon: '👑', label: 'ホスト移譲提案' },
  host_transfer_veto: { icon: '⏳', label: '拒否権通知' },
  host_transferred: { icon: '👑', label: 'ホスト変更' },
  member_inherited: { icon: '🔄', label: 'メンバー引き継ぎ' },
};

const NotificationListPanel: React.FC<NotificationListPanelProps> = ({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onAction,
  onApproveRejoin,
  onRejectRejoin,
  onAcceptHostTransfer,
  onDeclineHostTransfer,
  onVetoHostTransfer,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-md max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-between items-center">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
            通知 ({notifications.length})
          </h3>
          {notifications.length > 0 && (
            <button
              onClick={onMarkAllRead}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              すべて既読
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              未読の通知はありません
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-700">
              {notifications.map((notification) => {
                const config = typeLabels[notification.type] ?? { icon: '🔔', label: '通知' };
                const message =
                  (notification.payload?.message as string) ||
                  `${notification.payload?.senderName ?? ''}からの${config.label}`;
                const time = new Date(notification.createdAt).toLocaleTimeString('ja-JP', {
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <li key={notification.id} className="px-4 py-3">
                    <div className="flex items-start space-x-3">
                      <span className="text-lg flex-shrink-0">{config.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800 dark:text-white">{message}</p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{time}</p>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {/* 再参加リクエスト: 承認/拒否 */}
                          {notification.type === 'rejoin_request' && onApproveRejoin && (
                            <>
                              <button
                                onClick={() => onApproveRejoin(notification)}
                                className="text-xs px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700"
                              >
                                承認
                              </button>
                              <button
                                onClick={() => onRejectRejoin?.(notification)}
                                className="text-xs px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700"
                              >
                                拒否
                              </button>
                            </>
                          )}
                          {/* ホスト移譲オファー: 承諾/辞退 */}
                          {notification.type === 'host_transfer_offer' && onAcceptHostTransfer && (
                            <>
                              <button
                                onClick={() => onAcceptHostTransfer(notification)}
                                className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700"
                              >
                                承諾
                              </button>
                              <button
                                onClick={() => onDeclineHostTransfer?.(notification)}
                                className="text-xs px-2 py-0.5 rounded bg-slate-500 text-white hover:bg-slate-600"
                              >
                                辞退
                              </button>
                            </>
                          )}
                          {/* 拒否権通知: 拒否する */}
                          {notification.type === 'host_transfer_veto' && onVetoHostTransfer && (
                            <button
                              onClick={() => onVetoHostTransfer(notification)}
                              className="text-xs px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700"
                            >
                              拒否する
                            </button>
                          )}
                          {/* 汎用アクション（既存タイプ用） */}
                          {onAction && !['rejoin_request', 'host_transfer_offer', 'host_transfer_veto'].includes(notification.type) && (
                            <button
                              onClick={() => onAction(notification)}
                              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              対応する
                            </button>
                          )}
                          <button
                            onClick={() => onMarkRead(notification.id)}
                            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                          >
                            既読
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};

export default NotificationListPanel;
