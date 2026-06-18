import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = () => readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

const sliceBetween = (source: string, startNeedle: string, endNeedle: string) => {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('App MVP-2c sharing integration', () => {
  it('wires notification list refresh, read, and hide actions into the sharing panel', () => {
    const source = appSource();
    const refreshHandler = sliceBetween(
      source,
      'const refreshSharingNotifications = useCallback',
      'const handleMarkSharingNotificationRead = useCallback',
    );
    const readHandler = sliceBetween(
      source,
      'const handleMarkSharingNotificationRead = useCallback',
      'const handleHideSharingNotification = useCallback',
    );
    const hideHandler = sliceBetween(
      source,
      'const handleHideSharingNotification = useCallback',
      'const buildLocalizedSharingEventLists = useCallback',
    );
    const panelProps = sliceBetween(source, '<SharingMvp0cPanel', '/>');

    expect(refreshHandler).toContain('getNotificationList(session.roomId, 50, false)');
    expect(readHandler).toContain('markNotificationRead(session.roomId, notificationId, true)');
    expect(readHandler).toContain('await refreshSharingNotifications()');
    expect(hideHandler).toContain('hideNotification(session.roomId, notificationId, true)');
    expect(hideHandler).toContain('await refreshSharingNotifications()');
    expect(panelProps).toContain('notifications={activeSharingNotificationEntries}');
    expect(panelProps).toContain('onRefreshNotifications={refreshSharingNotifications}');
    expect(panelProps).toContain('onMarkNotificationRead={handleMarkSharingNotificationRead}');
    expect(panelProps).toContain('onHideNotification={handleHideSharingNotification}');
  });

  it('catches up route order changes and acknowledges per-date route versions', () => {
    const source = appSource();
    const syncHandler = sliceBetween(
      source,
      'const synchronizeSharingSession = useCallback',
      'const handleCreateSharingRoom = useCallback',
    );

    expect(syncHandler).toContain('versions.data.routeOrderVersions ?? {}');
    expect(syncHandler).toContain('if (versions.data.routeOrderVersion !== null)');
    expect(syncHandler).toContain('getRouteOrderByDate(session.roomId, eventDate)');
    expect(syncHandler).toContain('nextEventRouteOrders[eventDate] = route.data.itemIds');
    expect(syncHandler).toContain('[eventDate]: route.data.dateRouteOrderVersion');
    expect(syncHandler).toContain('updateExecuteModeItems((prev) => ({');
    expect(syncHandler).toContain('ackRoomRouteOrderVersions(');
    expect(syncHandler).toContain('routeOrderVersions: nextRouteOrderVersions');
  });

  it('publishes visit-list route order changes with conflict recovery', () => {
    const source = appSource();
    const confirmHandler = sliceBetween(
      source,
      'const handleVisitListConfirm = useCallback',
      'const handleVisitListCancel = useCallback',
    );

    expect(confirmHandler).toContain('activeSharingSession?.eventName === activeEventName');
    expect(confirmHandler).toContain('const itemIds = executeModeItemsRef.current[activeEventName]?.[dayName] || []');
    expect(confirmHandler).toContain('const expectedVersion = activeSharingSession.routeOrderVersions[dayName] ?? 0');
    expect(confirmHandler).toContain('updateRouteOrder({');
    expect(confirmHandler).toContain('roomId: activeSharingSession.roomId');
    expect(confirmHandler).toContain('eventDate: dayName');
    expect(confirmHandler).toContain('itemIds');
    expect(confirmHandler).toContain('expectedVersion');
    expect(confirmHandler).toContain("result.error.code === 'ROUTE_ORDER_CONFLICT'");
    expect(confirmHandler).toContain("synchronizeSharingSession(activeSharingSession.sessionId, 'manual')");
    expect(confirmHandler).toContain('routeOrderVersions: result.data.routeOrderVersions');
    expect(confirmHandler).toContain('await saveSharingSessionState({');
  });
});
