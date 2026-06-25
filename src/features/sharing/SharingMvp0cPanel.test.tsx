/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SharingMvp0cPanel, { getJoinRoomCodeFromInput } from './SharingMvp0cPanel';

vi.mock('qrcode', () => ({
  default: {
    toCanvas: vi.fn().mockResolvedValue(undefined),
  },
}));

const baseProps = {
  mode: 'join' as const,
  eventNames: ['テストイベント'],
  activeEventName: 'テストイベント',
  sessions: {},
  busy: false,
  statusMessage: null,
  errorMessage: null,
  onCreateRoom: vi.fn(),
  onJoinRoom: vi.fn(),
  onRestoreRoom: vi.fn(),
};

const currentSyncMetadata = {
  contractVersion: 2,
  metadataSchemaVersion: 2,
  fieldClocksByItemId: {},
};

describe('SharingMvp0cPanel', () => {
  it('extracts a room code from a join URL', () => {
    expect(getJoinRoomCodeFromInput('https://example.test/join/AB123')).toBe('AB123');
    expect(getJoinRoomCodeFromInput('/join/cd456')).toBe('CD456');
    expect(getJoinRoomCodeFromInput('ef789')).toBe('EF789');
  });

  it('closes create, join, and restore controls when sharing is unavailable', () => {
    render(
      <SharingMvp0cPanel
        {...baseProps}
        availability={{ enabled: false, reason: 'SUPABASE_UNCONFIGURED' }}
      />,
    );

    expect(screen.getByText('Supabase未設定のため共有は利用できません。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '参加' })).toBeDisabled();
  });

  it('opens join controls for local or limited sharing', () => {
    render(
      <SharingMvp0cPanel
        {...baseProps}
        availability={{ enabled: true, mode: 'local_or_limited' }}
      />,
    );

    expect(screen.getByPlaceholderText('参加URLまたはルームコード')).toBeEnabled();
  });

  it('opens MVP-0c controls for configured public Guard sharing', () => {
    render(
      <SharingMvp0cPanel
        {...baseProps}
        availability={{ enabled: true, mode: 'public_guard' }}
      />,
    );

    expect(screen.getByText('public Guard経由で共有します。')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('参加URLまたはルームコード')).toBeEnabled();
  });

  it('prefills a join code from a shared URL route', async () => {
    const user = userEvent.setup();
    const onJoinRoom = vi.fn().mockResolvedValue(undefined);

    render(
      <SharingMvp0cPanel
        {...baseProps}
        availability={{ enabled: true, mode: 'local_or_limited' }}
        initialJoinRoomCode="AB123"
        onJoinRoom={onJoinRoom}
      />,
    );

    await user.click(screen.getByRole('button', { name: '参加' }));

    expect(screen.getByDisplayValue('AB123')).toBeInTheDocument();
    expect(onJoinRoom).toHaveBeenCalledWith('AB123', '参加者');
  });

  it('shows a guest join URL for active sessions with a room code', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    render(
      <SharingMvp0cPanel
        {...baseProps}
        mode="invite"
        availability={{ enabled: true, mode: 'local_or_limited' }}
        sessions={{
          activeHost: {
            sessionId: 'activeHost',
            roomId: 'room-host',
            roomCode: 'AB123',
            roomMemberId: 'member-host',
            eventName: 'Host Event',
            role: 'host',
            status: 'active',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
            ...currentSyncMetadata,
          },
        }}
      />,
    );

    const urlInput = screen.getByLabelText('Host Eventの参加URL') as HTMLInputElement;
    expect(urlInput.value).toMatch(/\/join\/AB123$/);
    expect(screen.getByRole('button', { name: '参加URLをコピー' })).toBeInTheDocument();
  });

  it('does not expose invite controls for active sessions with legacy sync metadata', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    render(
      <SharingMvp0cPanel
        {...baseProps}
        mode="invite"
        availability={{ enabled: true, mode: 'local_or_limited' }}
        sessions={{
          legacyActiveHost: {
            sessionId: 'legacyActiveHost',
            roomId: 'room-host',
            roomCode: 'AB123',
            roomMemberId: 'member-host',
            eventName: 'Host Event',
            role: 'host',
            status: 'active',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
            contractVersion: 1,
          },
        }}
      />,
    );

    expect(screen.getByText('共有中のルームがありません。')).toBeInTheDocument();
    expect(screen.queryByLabelText('Host Eventの参加URL')).not.toBeInTheDocument();
  });

  it('exposes the MVP-2a assigned-only filter and bulk assignment action for active members', async () => {
    const user = userEvent.setup();
    const onAssignedOnlyChange = vi.fn();
    const onBulkAssignSelected = vi.fn().mockResolvedValue(undefined);

    render(
      <SharingMvp0cPanel
        {...baseProps}
        mode="status"
        availability={{ enabled: true, mode: 'local_or_limited' }}
        assignmentMembers={[
          {
            roomMemberId: 'member-host',
            displayName: 'Host',
            color: '#0ea5e9',
            role: 'host',
            membershipStatus: 'active',
          },
          {
            roomMemberId: 'member-guest',
            displayName: 'Guest',
            color: '#22c55e',
            role: 'member',
            membershipStatus: 'active',
          },
          {
            roomMemberId: 'member-left',
            displayName: 'Left',
            color: '#94a3b8',
            role: 'member',
            membershipStatus: 'left',
          },
        ]}
        selectedItemCount={2}
        assignedOnly={false}
        onAssignedOnlyChange={onAssignedOnlyChange}
        onBulkAssignSelected={onBulkAssignSelected}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: '自分担当のみ' }));
    expect(onAssignedOnlyChange).toHaveBeenCalledWith(true);

    const assigneeSelect = screen.getByRole('combobox', { name: '一括譲渡先' });
    expect(screen.queryByRole('option', { name: 'Left' })).not.toBeInTheDocument();
    await user.selectOptions(assigneeSelect, 'member-guest');
    await user.click(screen.getByRole('button', { name: '一括譲渡' }));

    expect(onBulkAssignSelected).toHaveBeenCalledWith('member-guest');
  });

  it('exposes MVP-2b pause, leave, resume, and localize actions by session state', async () => {
    const user = userEvent.setup();
    const onPauseSession = vi.fn().mockResolvedValue(undefined);
    const onResumeSession = vi.fn().mockResolvedValue(undefined);
    const onLeaveSession = vi.fn().mockResolvedValue(undefined);
    const onLocalizeSession = vi.fn().mockResolvedValue(undefined);
    const onCreateRoom = vi.fn().mockResolvedValue(undefined);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('再共有主催');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    render(
      <SharingMvp0cPanel
        {...baseProps}
        mode="status"
        availability={{ enabled: true, mode: 'local_or_limited' }}
        sessions={{
          activeMember: {
            sessionId: 'activeMember',
            roomId: 'room-active',
            roomMemberId: 'member-active',
            eventName: 'Active Event',
            role: 'member',
            status: 'active',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
            ...currentSyncMetadata,
          },
          activeHost: {
            sessionId: 'activeHost',
            roomId: 'room-host',
            roomMemberId: 'member-host',
            eventName: 'Host Event',
            role: 'host',
            status: 'active',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
            ...currentSyncMetadata,
          },
          paused: {
            sessionId: 'paused',
            roomId: 'room-paused',
            roomMemberId: 'member-paused',
            eventName: 'Paused Event',
            role: 'member',
            status: 'paused',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
          },
          expired: {
            sessionId: 'expired',
            roomId: 'room-expired',
            roomMemberId: 'member-expired',
            eventName: 'Expired Event',
            role: 'member',
            status: 'expired',
            startedAt: past,
            expiresAt: past,
            itemsVersion: 0,
            routeOrderVersions: {},
          },
          leaving: {
            sessionId: 'leaving',
            roomId: 'room-leaving',
            roomMemberId: 'member-leaving',
            eventName: 'Leaving Event',
            role: 'member',
            status: 'leaving',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
          },
          localizing: {
            sessionId: 'localizing',
            roomId: 'room-localizing',
            roomMemberId: 'member-localizing',
            eventName: 'Localized Event',
            role: 'host',
            status: 'localizing',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
          },
        }}
        onCreateRoom={onCreateRoom}
        onPauseSession={onPauseSession}
        onResumeSession={onResumeSession}
        onLeaveSession={onLeaveSession}
        onLocalizeSession={onLocalizeSession}
      />,
    );

    expect(screen.getByText('Paused Event: 一時離脱 / room room-paused')).toBeInTheDocument();
    expect(screen.getByText('Expired Event: 期限切れ / room room-expired')).toBeInTheDocument();
    expect(screen.getByText('Leaving Event: 退出中 / room room-leaving')).toBeInTheDocument();
    expect(screen.getByText('Localized Event: ローカル化済み / room room-localizing')).toBeInTheDocument();
    expect(
      screen.getByText('ローカルデータは保持されています。同期を再開する場合は、このイベントから新しい共有ルームを作成してください。'),
    ).toBeInTheDocument();
    const leaveButtons = screen.getAllByRole('button', { name: '退出' });
    expect(leaveButtons).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: '一時離脱' })[0]);
    await user.click(screen.getByRole('button', { name: '再開' }));
    await user.click(leaveButtons[0]);
    await user.click(leaveButtons[1]);
    await user.click(screen.getByRole('button', { name: 'ローカル化' }));
    await user.click(screen.getByRole('button', { name: '新規共有' }));

    expect(onPauseSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'activeMember' }));
    expect(onResumeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'paused' }));
    expect(onLeaveSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'activeMember' }));
    expect(onLeaveSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'activeHost' }));
    expect(onLocalizeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'expired' }));
    expect(onCreateRoom).toHaveBeenCalledWith('Localized Event', '再共有主催');
    promptSpy.mockRestore();
  });

  it('marks active legacy sessions as requiring an update instead of exposing active controls', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    render(
      <SharingMvp0cPanel
        {...baseProps}
        mode="status"
        availability={{ enabled: true, mode: 'local_or_limited' }}
        sessions={{
          legacyActiveMember: {
            sessionId: 'legacyActiveMember',
            roomId: 'room-legacy',
            roomMemberId: 'member-legacy',
            eventName: 'Legacy Event',
            role: 'member',
            status: 'active',
            startedAt: past,
            expiresAt: future,
            itemsVersion: 0,
            routeOrderVersions: {},
            contractVersion: 1,
          },
        }}
        onPauseSession={vi.fn().mockResolvedValue(undefined)}
        onLeaveSession={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('Legacy Event: 要更新 / room room-legacy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '一時離脱' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '退出' })).not.toBeInTheDocument();
  });

  it('exposes MVP-2c notification refresh, read, and hide actions', async () => {
    const user = userEvent.setup();
    const onRefreshNotifications = vi.fn().mockResolvedValue(undefined);
    const onMarkNotificationRead = vi.fn().mockResolvedValue(undefined);
    const onHideNotification = vi.fn().mockResolvedValue(undefined);

    render(
      <SharingMvp0cPanel
        {...baseProps}
        mode="status"
        availability={{ enabled: true, mode: 'local_or_limited' }}
        notifications={[
          {
            notification: {
              id: 'notification-unread',
              eventId: 'event-unread',
              idempotencyKey: 'idem-unread',
              notificationType: 'route_order_updated',
              targetMemberId: null,
              payload: {},
              createdAt: '2026-08-15T09:00:00.000Z',
              readAt: null,
              hiddenAt: null,
            },
            message: '1日目 の巡回順を同期しました。',
          },
          {
            notification: {
              id: 'notification-read',
              eventId: 'event-read',
              idempotencyKey: 'idem-read',
              notificationType: 'item_fields_updated',
              targetMemberId: null,
              payload: {},
              createdAt: '2026-08-15T08:00:00.000Z',
              readAt: '2026-08-15T08:05:00.000Z',
              hiddenAt: null,
            },
            message: '価格変更を同期しました。',
          },
        ]}
        onRefreshNotifications={onRefreshNotifications}
        onMarkNotificationRead={onMarkNotificationRead}
        onHideNotification={onHideNotification}
      />,
    );

    expect(screen.getByText('通知')).toBeInTheDocument();
    expect(screen.getByText('1日目 の巡回順を同期しました。')).toBeInTheDocument();
    expect(screen.getByText('価格変更を同期しました。')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '既読' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '更新' }));
    await user.click(screen.getByRole('button', { name: '既読' }));
    await user.click(screen.getAllByRole('button', { name: '非表示' })[0]);

    expect(onRefreshNotifications).toHaveBeenCalledTimes(1);
    expect(onMarkNotificationRead).toHaveBeenCalledWith('notification-unread');
    expect(onHideNotification).toHaveBeenCalledWith('notification-unread');
  });
});
