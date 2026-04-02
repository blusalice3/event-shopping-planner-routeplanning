import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom } from '../types/room';
import type { AppNotification } from '../services/notificationService';
import * as notificationService from '../services/notificationService';

interface UseNotificationsReturn {
  notifications: AppNotification[];
  unreadCount: number;
  latestToast: AppNotification | null;
  dismissToast: () => void;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  broadcastNotification: (
    type: notificationService.NotificationType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  handleIncomingNotification: (notification: AppNotification) => void;
}

export function useNotifications(
  activeRoom: ActiveRoom | null,
  userId: string | null,
): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [latestToast, setLatestToast] = useState<AppNotification | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初回ロード
  useEffect(() => {
    if (!supabase || !activeRoom || !userId) {
      setNotifications([]);
      return;
    }

    notificationService
      .getUnreadNotifications(supabase, activeRoom.id, userId)
      .then(setNotifications);
  }, [activeRoom?.id, userId]);

  // 新規通知のリアルタイム受信ハンドラを登録
  const handleNewNotification = useCallback(
    (notification: AppNotification) => {
      // 自分が送信した通知はスキップ
      if (notification.payload?.senderId === userId) return;

      setNotifications((prev) => [notification, ...prev]);
      setLatestToast(notification);

      // 10秒後に自動消去
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = setTimeout(() => setLatestToast(null), 10000);
    },
    [userId],
  );

  // useRoomSyncから呼ばれる通知ハンドラ（SharingProviderで接続）
  const handleNewNotificationRef = useRef(handleNewNotification);
  useEffect(() => {
    handleNewNotificationRef.current = handleNewNotification;
  }, [handleNewNotification]);

  const dismissToast = useCallback(() => {
    setLatestToast(null);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
  }, []);

  const markAsRead = useCallback(
    async (notificationId: string) => {
      if (!supabase) return;
      await notificationService.markNotificationRead(supabase, notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    },
    [],
  );

  const markAllAsRead = useCallback(async () => {
    if (!supabase || !activeRoom || !userId) return;
    await notificationService.markAllRead(supabase, activeRoom.id, userId);
    setNotifications([]);
  }, [activeRoom, userId]);

  const broadcastNotificationAction = useCallback(
    async (
      type: notificationService.NotificationType,
      payload: Record<string, unknown>,
    ) => {
      if (!supabase || !activeRoom) return;
      await notificationService.broadcastNotification(supabase, activeRoom.id, type, {
        ...payload,
        senderId: userId,
      });
    },
    [activeRoom, userId],
  );

  return {
    notifications,
    unreadCount: notifications.length,
    latestToast,
    dismissToast,
    markAsRead,
    markAllAsRead,
    broadcastNotification: broadcastNotificationAction,
    handleIncomingNotification: handleNewNotification,
  };
}
