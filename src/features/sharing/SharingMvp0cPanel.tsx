import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { SharingAvailability } from '../../lib/supabase';
import type { SharingSessionMetadata } from '../../utils/indexedDB';
import type { AssignmentMemberProfile } from '../../types/item';
import type { NotificationListItem } from './client';
import { isSharingSessionActive, isSharingSessionOperational } from './appIntegration';

type SharingPanelMode = 'join' | 'invite' | 'status';

type SharingMvp0cPanelProps = {
  mode: SharingPanelMode;
  eventName?: string | null;
  eventNames?: string[];
  activeEventName?: string | null;
  sessions: Record<string, SharingSessionMetadata>;
  busy: boolean;
  availability: SharingAvailability;
  statusMessage: string | null;
  errorMessage: string | null;
  initialJoinRoomCode?: string | null;
  onCreateRoom?: (eventName: string, displayName: string) => Promise<void>;
  onJoinRoom: (roomCode: string, displayName: string) => Promise<void>;
  onRestoreRoom: (roomId: string) => Promise<void>;
  assignmentMembers?: AssignmentMemberProfile[];
  selectedItemCount?: number;
  assignedOnly?: boolean;
  onAssignedOnlyChange?: (enabled: boolean) => void;
  onBulkAssignSelected?: (assignedToMemberId: string) => Promise<void>;
  onPauseSession?: (session: SharingSessionMetadata) => Promise<void>;
  onResumeSession?: (session: SharingSessionMetadata) => Promise<void>;
  onLeaveSession?: (session: SharingSessionMetadata) => Promise<void>;
  onLocalizeSession?: (session: SharingSessionMetadata) => Promise<void>;
  notifications?: Array<{
    notification: NotificationListItem;
    message: string;
  }>;
  onRefreshNotifications?: () => Promise<void>;
  onMarkNotificationRead?: (notificationId: string) => Promise<void>;
  onHideNotification?: (notificationId: string) => Promise<void>;
  onClose?: () => void;
};

const formatSessionStatus = (session: SharingSessionMetadata): string => {
  if (isSharingSessionOperational(session)) return '共有中';
  if (isSharingSessionActive(session)) return '要更新';
  if (session.status === 'paused') return '一時離脱';
  if (session.status === 'expired') return '期限切れ';
  if (session.status === 'leaving') return '退出中';
  if (session.status === 'localizing') return 'ローカル化済み';
  return '停止中';
};

const formatAvailabilityMessage = (availability: SharingAvailability): string | null => {
  if (availability.enabled) return null;
  if (availability.reason === 'SUPABASE_UNCONFIGURED') {
    return 'Supabase未設定のため共有は利用できません。';
  }
  if (availability.reason === 'PUBLIC_GUARD_UNCONFIGURED') {
    return 'public Guard未設定のため共有は利用できません。';
  }
  return null;
};

export const getJoinRoomCodeFromInput = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const extractFromPath = (path: string): string | null => {
    const match = path.match(/\/join\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).trim().toUpperCase() : null;
  };

  const pathRoomCode = extractFromPath(trimmed);
  if (pathRoomCode) return pathRoomCode;

  try {
    const baseUrl =
      typeof window !== 'undefined' && window.location.origin
        ? window.location.origin
        : 'http://localhost';
    const parsedUrl = new URL(trimmed, baseUrl);
    return extractFromPath(parsedUrl.pathname) ?? trimmed.toUpperCase();
  } catch {
    return trimmed.toUpperCase();
  }
};

const buildJoinUrl = (roomCode: string): string => {
  const encodedRoomCode = encodeURIComponent(roomCode);
  if (typeof window === 'undefined' || !window.location.origin) {
    return `/join/${encodedRoomCode}`;
  }
  return `${window.location.origin}/join/${encodedRoomCode}`;
};

const SharingInviteCard: React.FC<{ session: SharingSessionMetadata }> = ({ session }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const roomCode = session.roomCode;
  const joinUrl = roomCode ? buildJoinUrl(roomCode) : '';

  useEffect(() => {
    if (!roomCode || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, joinUrl, {
      width: 128,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    }).catch(() => undefined);
  }, [joinUrl, roomCode]);

  if (!roomCode) return null;

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(joinUrl);
      } else {
        const input = document.createElement('input');
        input.value = joinUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="grid gap-3 border border-sky-100 bg-white px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
      <canvas ref={canvasRef} className="h-32 w-32 rounded border border-slate-200 bg-white" />
      <div className="min-w-0 space-y-2">
        <div className="text-xs font-semibold text-sky-900">ゲスト参加URL / QR</div>
        <input
          className="w-full min-w-0 rounded border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700"
          value={joinUrl}
          readOnly
          aria-label={`${session.eventName}の参加URL`}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-sm font-bold tracking-widest text-slate-800">
            {roomCode}
          </span>
          <button
            type="button"
            className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-800"
            onClick={handleCopy}
          >
            {copied ? 'コピー済み' : '参加URLをコピー'}
          </button>
        </div>
      </div>
    </div>
  );
};

const SharingMvp0cPanel: React.FC<SharingMvp0cPanelProps> = ({
  mode,
  eventName,
  sessions,
  busy,
  availability,
  statusMessage,
  errorMessage,
  initialJoinRoomCode = null,
  onJoinRoom,
  onRestoreRoom,
  onCreateRoom,
  assignmentMembers = [],
  selectedItemCount = 0,
  assignedOnly = false,
  onAssignedOnlyChange,
  onBulkAssignSelected,
  onPauseSession,
  onResumeSession,
  onLeaveSession,
  onLocalizeSession,
  notifications = [],
  onRefreshNotifications,
  onMarkNotificationRead,
  onHideNotification,
  onClose,
}) => {
  const [joinRoomCode, setJoinRoomCode] = useState(initialJoinRoomCode ?? '');
  const [joinDisplayName, setJoinDisplayName] = useState('参加者');
  const [restoreRoomId, setRestoreRoomId] = useState('');
  const [bulkAssignMemberId, setBulkAssignMemberId] = useState('');

  useEffect(() => {
    if (initialJoinRoomCode) {
      setJoinRoomCode(initialJoinRoomCode);
    }
  }, [initialJoinRoomCode]);

  const sortedSessions = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => !eventName || session.eventName === eventName)
        .sort((a, b) =>
          a.eventName.localeCompare(b.eventName, 'ja', {
            numeric: true,
            sensitivity: 'base',
          }),
        ),
    [eventName, sessions],
  );

  const controlsDisabled = busy || !availability.enabled;
  const availabilityMessage = formatAvailabilityMessage(availability);
  const normalizedJoinRoomCode = getJoinRoomCodeFromInput(joinRoomCode);
  const canJoin =
    normalizedJoinRoomCode.length > 0 && joinDisplayName.trim().length > 0 && !controlsDisabled;
  const canRestore = restoreRoomId.trim().length > 0 && !controlsDisabled;
  const activeAssignmentMembers = assignmentMembers.filter(
    (member) => member.membershipStatus === 'active',
  );
  const selectedBulkMemberId =
    activeAssignmentMembers.some((member) => member.roomMemberId === bulkAssignMemberId)
      ? bulkAssignMemberId
      : activeAssignmentMembers[0]?.roomMemberId || '';
  const canBulkAssign =
    selectedItemCount > 0 && !!selectedBulkMemberId && !controlsDisabled && !!onBulkAssignSelected;
  const inviteSessions = sortedSessions.filter(isSharingSessionOperational);
  const title =
    mode === 'join' ? '共有に参加' : mode === 'invite' ? '参加URL/QR' : '共有状態';
  const handleCreateRoomFromLocalizedSession = async (session: SharingSessionMetadata) => {
    const displayName = window.prompt('新しい共有で使う表示名を入力してください。', '主催');
    if (displayName === null) return;
    await onCreateRoom?.(session.eventName, displayName.trim() || '主催');
  };

  return (
    <section className="mx-4 mt-4 border border-sky-200 bg-sky-50 px-4 py-3 text-slate-800 shadow-sm md:mx-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-sky-900">{title}</div>
          {availability.enabled && availability.mode === 'public_guard' && (
            <div className="mt-0.5 text-xs font-semibold text-sky-800">
              public Guard経由で共有します。
            </div>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            className="rounded border border-sky-200 bg-white px-2 py-1 text-xs font-semibold text-sky-800"
            onClick={onClose}
          >
            閉じる
          </button>
        )}
      </div>

      {(availabilityMessage || statusMessage || errorMessage) && (
        <div className="mt-3 space-y-1 text-xs">
          {availabilityMessage && <div className="font-semibold text-amber-800">{availabilityMessage}</div>}
          {statusMessage && <div className="text-sky-900">{statusMessage}</div>}
          {errorMessage && <div className="font-semibold text-red-700">{errorMessage}</div>}
        </div>
      )}

      {mode === 'join' && (
        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(10rem,1fr)_minmax(8rem,12rem)_auto]">
          <input
            className="min-w-0 rounded border border-sky-200 bg-white px-2 py-2 text-sm"
            value={joinRoomCode}
            onChange={(event) => setJoinRoomCode(event.target.value)}
            placeholder="参加URLまたはルームコード"
            disabled={controlsDisabled}
          />
          <input
            className="min-w-0 rounded border border-sky-200 bg-white px-2 py-2 text-sm"
            value={joinDisplayName}
            onChange={(event) => setJoinDisplayName(event.target.value)}
            placeholder="表示名"
            disabled={controlsDisabled}
          />
          <button
            type="button"
            className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!canJoin}
            onClick={() => onJoinRoom(normalizedJoinRoomCode, joinDisplayName)}
          >
            参加
          </button>
        </div>
      )}

      {mode === 'join' && (
        <details className="mt-3 border-t border-sky-200 pt-3 text-sm">
          <summary className="cursor-pointer text-xs font-semibold text-sky-900">
            以前参加した共有を復元
          </summary>
          <div className="mt-2 grid gap-2 md:grid-cols-[minmax(10rem,1fr)_auto]">
            <input
              className="min-w-0 rounded border border-sky-200 bg-white px-2 py-2 text-sm"
              value={restoreRoomId}
              onChange={(event) => setRestoreRoomId(event.target.value)}
              placeholder="ルームID"
              disabled={controlsDisabled}
            />
            <button
              type="button"
              className="rounded bg-slate-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={!canRestore}
              onClick={() => onRestoreRoom(restoreRoomId)}
            >
              復元
            </button>
          </div>
        </details>
      )}

      {mode === 'invite' && (
        <div className="mt-3 space-y-3">
          {inviteSessions.length === 0 ? (
            <div className="text-xs text-slate-600">共有中のルームがありません。</div>
          ) : (
            inviteSessions.map((session) => (
              <SharingInviteCard key={session.sessionId} session={session} />
            ))
          )}
        </div>
      )}

      {mode === 'status' && (
        <div className="mt-3 space-y-2 text-xs">
          {sortedSessions.length === 0 ? (
            <div className="text-slate-600">このイベントの共有セッションはありません。</div>
          ) : (
            sortedSessions.map((session) => (
              <div
                key={session.sessionId}
                className="flex flex-col gap-2 border border-sky-100 bg-white px-3 py-2 text-slate-700 md:flex-row md:flex-wrap md:items-center md:justify-between"
              >
                <span>
                  {session.eventName}: {formatSessionStatus(session)} / room {session.roomId}
                </span>
                <span className="flex flex-wrap gap-1">
                  {isSharingSessionOperational(session) && onPauseSession && (
                    <button
                      type="button"
                      className="rounded border border-sky-200 bg-white px-2 py-1 text-xs font-semibold text-sky-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                      disabled={busy}
                      onClick={() => onPauseSession(session)}
                    >
                      一時離脱
                    </button>
                  )}
                  {session.status === 'paused' && onResumeSession && (
                    <button
                      type="button"
                      className="rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                      disabled={busy || Date.parse(session.expiresAt) <= Date.now()}
                      onClick={() => onResumeSession(session)}
                    >
                      再開
                    </button>
                  )}
                  {isSharingSessionOperational(session) && session.role === 'member' && onLeaveSession && (
                    <button
                      type="button"
                      className="rounded border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                      disabled={busy}
                      onClick={() => onLeaveSession(session)}
                    >
                      退出
                    </button>
                  )}
                  {isSharingSessionOperational(session) && session.role === 'host' && (
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500"
                      disabled
                    >
                      ホスト退出不可
                    </button>
                  )}
                  {session.status === 'expired' && onLocalizeSession && (
                    <button
                      type="button"
                      className="rounded border border-amber-200 bg-white px-2 py-1 text-xs font-semibold text-amber-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                      disabled={busy}
                      onClick={() => onLocalizeSession(session)}
                    >
                      ローカル化
                    </button>
                  )}
                  {session.status === 'localizing' && onCreateRoom && (
                    <button
                      type="button"
                      className="rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                      disabled={busy || !availability.enabled}
                      onClick={() => void handleCreateRoomFromLocalizedSession(session)}
                    >
                      新規共有
                    </button>
                  )}
                </span>
                {session.status === 'localizing' && (
                  <div className="text-xs leading-relaxed text-amber-800 md:basis-full">
                    ローカルデータは保持されています。同期を再開する場合は、このイベントから新しい共有ルームを作成してください。
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {mode === 'status' && activeAssignmentMembers.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t border-sky-200 pt-3 text-sm md:flex-row md:items-center md:justify-between">
          <label className="inline-flex items-center gap-2 text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
              checked={assignedOnly}
              onChange={(event) => onAssignedOnlyChange?.(event.target.checked)}
              disabled={controlsDisabled || !onAssignedOnlyChange}
            />
            自分担当のみ
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="text-xs text-slate-600">選択中 {selectedItemCount}件</span>
            <select
              className="min-w-0 rounded border border-sky-200 bg-white px-2 py-1.5 text-sm"
              value={selectedBulkMemberId}
              onChange={(event) => setBulkAssignMemberId(event.target.value)}
              disabled={controlsDisabled}
              aria-label="一括譲渡先"
            >
              {activeAssignmentMembers.map((member) => (
                <option key={member.roomMemberId} value={member.roomMemberId}>
                  {member.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={!canBulkAssign}
              onClick={() => onBulkAssignSelected?.(selectedBulkMemberId)}
            >
              一括譲渡
            </button>
          </div>
        </div>
      )}

      {mode === 'status' && onRefreshNotifications && (
        <div className="mt-3 border-t border-sky-200 pt-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-sky-900">通知</div>
            <button
              type="button"
              className="rounded border border-sky-200 bg-white px-2 py-1 text-xs font-semibold text-sky-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              disabled={busy}
              onClick={() => onRefreshNotifications()}
            >
              更新
            </button>
          </div>
          {notifications.length === 0 ? (
            <div className="mt-2 text-xs text-slate-500">通知はありません。</div>
          ) : (
            <div className="mt-2 space-y-2">
              {notifications.map(({ notification, message }) => (
                <div
                  key={notification.id}
                  className="flex flex-col gap-2 border border-sky-100 bg-white px-3 py-2 text-xs text-slate-700 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className={notification.readAt ? 'text-slate-500' : 'font-semibold text-slate-800'}>
                      {message}
                    </div>
                    <div className="mt-0.5 text-slate-400">
                      {new Date(notification.createdAt).toLocaleString('ja-JP')}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {!notification.readAt && onMarkNotificationRead && (
                      <button
                        type="button"
                        className="rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                        disabled={busy}
                        onClick={() => onMarkNotificationRead(notification.id)}
                      >
                        既読
                      </button>
                    )}
                    {onHideNotification && (
                      <button
                        type="button"
                        className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                        disabled={busy}
                        onClick={() => onHideNotification(notification.id)}
                      >
                        非表示
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default SharingMvp0cPanel;
