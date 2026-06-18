import React, { useMemo, useState } from 'react';
import type { SharingAvailability } from '../../lib/supabase';
import type { SharingSessionMetadata } from '../../utils/indexedDB';
import type { AssignmentMemberProfile } from '../../types/item';
import type { NotificationListItem } from './client';
import { isSharingSessionActive } from './appIntegration';

type SharingMvp0cPanelProps = {
  eventNames: string[];
  activeEventName: string | null;
  sessions: Record<string, SharingSessionMetadata>;
  busy: boolean;
  availability: SharingAvailability;
  statusMessage: string | null;
  errorMessage: string | null;
  onCreateRoom: (eventName: string, displayName: string) => Promise<void>;
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
};

const formatSessionStatus = (session: SharingSessionMetadata): string => {
  if (isSharingSessionActive(session)) return '共有中';
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

const SharingMvp0cPanel: React.FC<SharingMvp0cPanelProps> = ({
  eventNames,
  activeEventName,
  sessions,
  busy,
  availability,
  statusMessage,
  errorMessage,
  onCreateRoom,
  onJoinRoom,
  onRestoreRoom,
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
}) => {
  const [createEventName, setCreateEventName] = useState(activeEventName ?? eventNames[0] ?? '');
  const [createDisplayName, setCreateDisplayName] = useState('主催');
  const [joinRoomCode, setJoinRoomCode] = useState('');
  const [joinDisplayName, setJoinDisplayName] = useState('参加者');
  const [restoreRoomId, setRestoreRoomId] = useState('');
  const [bulkAssignMemberId, setBulkAssignMemberId] = useState('');

  const sortedSessions = useMemo(
    () =>
      Object.values(sessions).sort((a, b) =>
        a.eventName.localeCompare(b.eventName, 'ja', {
          numeric: true,
          sensitivity: 'base',
        }),
      ),
    [sessions],
  );

  const selectedEvent = createEventName || activeEventName || eventNames[0] || '';
  const controlsDisabled = busy || !availability.enabled;
  const availabilityMessage = formatAvailabilityMessage(availability);
  const canCreate = !!selectedEvent && !controlsDisabled;
  const canJoin =
    joinRoomCode.trim().length > 0 && joinDisplayName.trim().length > 0 && !controlsDisabled;
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

  return (
    <section className="mx-4 mt-4 border border-sky-200 bg-sky-50 px-4 py-3 text-slate-800 shadow-sm md:mx-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="flex-1">
          <div className="text-sm font-semibold text-sky-900">共有 MVP-0c</div>
          {availability.enabled && availability.mode === 'public_guard' && (
            <div className="mt-1 text-xs font-semibold text-sky-800">
              public Guard経由で共有します。
            </div>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(9rem,12rem)_auto]">
            <select
              className="min-w-0 rounded border border-sky-200 bg-white px-2 py-2 text-sm"
              value={selectedEvent}
              onChange={(event) => setCreateEventName(event.target.value)}
              disabled={controlsDisabled || eventNames.length === 0}
            >
              {eventNames.map((eventName) => (
                <option key={eventName} value={eventName}>
                  {eventName}
                </option>
              ))}
            </select>
            <input
              className="min-w-0 rounded border border-sky-200 bg-white px-2 py-2 text-sm"
              value={createDisplayName}
              onChange={(event) => setCreateDisplayName(event.target.value)}
              placeholder="表示名"
              disabled={controlsDisabled}
            />
            <button
              type="button"
              className="rounded bg-sky-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={!canCreate}
              onClick={() => onCreateRoom(selectedEvent, createDisplayName)}
            >
              共有を作成
            </button>
          </div>
        </div>

        <div className="grid flex-1 gap-2 md:grid-cols-[minmax(8rem,1fr)_minmax(8rem,12rem)_auto]">
          <input
            className="min-w-0 rounded border border-sky-200 bg-white px-2 py-2 text-sm"
            value={joinRoomCode}
            onChange={(event) => setJoinRoomCode(event.target.value)}
            placeholder="ルームコード"
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
            onClick={() => onJoinRoom(joinRoomCode, joinDisplayName)}
          >
            参加
          </button>
        </div>

        <div className="grid flex-1 gap-2 md:grid-cols-[minmax(10rem,1fr)_auto]">
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
      </div>

      {(availabilityMessage || statusMessage || errorMessage || sortedSessions.length > 0) && (
        <div className="mt-3 space-y-1 text-xs">
          {availabilityMessage && <div className="font-semibold text-amber-800">{availabilityMessage}</div>}
          {statusMessage && <div className="text-sky-900">{statusMessage}</div>}
          {errorMessage && <div className="font-semibold text-red-700">{errorMessage}</div>}
          {sortedSessions.map((session) => (
            <div
              key={session.sessionId}
              className="flex flex-col gap-2 text-slate-700 md:flex-row md:items-center md:justify-between"
            >
              <span>
                {session.eventName}: {formatSessionStatus(session)} / room {session.roomId}
              </span>
              <span className="flex flex-wrap gap-1">
                {isSharingSessionActive(session) && onPauseSession && (
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
                {isSharingSessionActive(session) && session.role === 'member' && onLeaveSession && (
                  <button
                    type="button"
                    className="rounded border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                    disabled={busy}
                    onClick={() => onLeaveSession(session)}
                  >
                    退出
                  </button>
                )}
                {isSharingSessionActive(session) && session.role === 'host' && (
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
              </span>
            </div>
          ))}
        </div>
      )}

      {activeAssignmentMembers.length > 0 && (
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

      {onRefreshNotifications && (
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
