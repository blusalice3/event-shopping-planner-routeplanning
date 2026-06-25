import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSharingAvailabilityMock, rpcMock } = vi.hoisted(() => ({
  getSharingAvailabilityMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  getSharingAvailability: getSharingAvailabilityMock,
  supabase: {
    rpc: rpcMock,
  },
}));

const refreshRequired = {
  ok: false,
  error: {
    code: 'FULL_NOTIFICATION_REFRESH_REQUIRED',
    contract_version: 2,
  },
};

const notification = {
  id: 'notification-1',
  eventId: 'event-1',
  idempotencyKey: 'notification:key',
  notificationType: 'item_fields_updated',
  targetMemberId: null,
  payload: {},
  createdAt: '2026-08-01T00:00:01.000Z',
};

describe('sharing notification RPC wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSharingAvailabilityMock.mockReturnValue({
      enabled: true,
      mode: 'local_or_limited',
    });
  });

  it('accepts valid notification catch-up pages', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          limit: 100,
          events: [notification],
          notifications: [notification],
          nextWatermarkCreatedAt: notification.createdAt,
          nextWatermarkId: notification.id,
          hasMore: false,
          serverHighWatermarkCreatedAt: notification.createdAt,
          serverHighWatermarkId: notification.id,
        },
      },
    });

    const { getNotificationsAfterWatermark } = await import('./client');
    const result = await getNotificationsAfterWatermark('room-1', null, null);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.notifications).toHaveLength(1);
  });

  it('rejects malformed notification catch-up pages', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          limit: 100,
          notifications: [{ ...notification, createdAt: undefined }],
          nextWatermarkCreatedAt: null,
          nextWatermarkId: null,
          hasMore: false,
          serverHighWatermarkCreatedAt: null,
          serverHighWatermarkId: null,
        },
      },
    });

    const { getNotificationsAfterWatermark } = await import('./client');
    await expect(getNotificationsAfterWatermark('room-1', null, null)).resolves.toEqual(
      refreshRequired,
    );
  });

  it('rejects notification catch-up pages with malformed timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          limit: 100,
          notifications: [{ ...notification, createdAt: '' }],
          nextWatermarkCreatedAt: notification.createdAt,
          nextWatermarkId: notification.id,
          hasMore: false,
          serverHighWatermarkCreatedAt: notification.createdAt,
          serverHighWatermarkId: notification.id,
        },
      },
    });

    const { getNotificationsAfterWatermark } = await import('./client');
    await expect(getNotificationsAfterWatermark('room-1', null, null)).resolves.toEqual(
      refreshRequired,
    );
  });

  it('rejects notification catch-up pages with malformed watermarks', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          limit: 100,
          notifications: [notification],
          nextWatermarkCreatedAt: 'not-a-date',
          nextWatermarkId: notification.id,
          hasMore: false,
          serverHighWatermarkCreatedAt: notification.createdAt,
          serverHighWatermarkId: notification.id,
        },
      },
    });

    const { getNotificationsAfterWatermark } = await import('./client');
    await expect(getNotificationsAfterWatermark('room-1', null, null)).resolves.toEqual(
      refreshRequired,
    );
  });

  it('rejects malformed notification list items', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          limit: 50,
          notifications: [{ ...notification, readAt: false, hiddenAt: null }],
        },
      },
    });

    const { getNotificationList } = await import('./client');
    await expect(getNotificationList('room-1')).resolves.toEqual(refreshRequired);
  });

  it('rejects notification list items with malformed read timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          limit: 50,
          notifications: [{ ...notification, readAt: '', hiddenAt: null }],
        },
      },
    });

    const { getNotificationList } = await import('./client');
    await expect(getNotificationList('room-1')).resolves.toEqual(refreshRequired);
  });

  it('rejects malformed notification read state responses', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          notificationId: 'notification-1',
          readAt: true,
          hiddenAt: null,
        },
      },
    });

    const { markNotificationRead } = await import('./client');
    await expect(markNotificationRead('room-1', 'notification-1')).resolves.toEqual(
      refreshRequired,
    );
  });

  it('rejects notification read state responses with malformed timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          notificationId: 'notification-1',
          readAt: '2026-08-01T00:00:02.000Z',
          hiddenAt: 'not-a-date',
        },
      },
    });

    const { markNotificationRead } = await import('./client');
    await expect(markNotificationRead('room-1', 'notification-1')).resolves.toEqual(
      refreshRequired,
    );
  });
});
