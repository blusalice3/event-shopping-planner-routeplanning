import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = () => readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const mapViewSource = () =>
  readFileSync(resolve(process.cwd(), 'src/components/map/MapView.tsx'), 'utf8');
const mapCanvasSource = () =>
  readFileSync(resolve(process.cwd(), 'src/components/map/MapCanvas.tsx'), 'utf8');

const sliceBetween = (source: string, startNeedle: string, endNeedle: string) => {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('App MVP-2c sharing integration', () => {
  it('describes shared item and route sync without the old item lock wording', () => {
    const source = appSource();
    const banner = sliceBetween(
      source,
      '{activeSharingSession && (',
      '<AppMainContent',
    );

    expect(banner).toContain('アイテム変更と巡回順を共有同期中です。');
    expect(banner).toContain('イベント設定・マップ・会場などの構造変更は停止しています。');
    expect(banner).not.toContain('追加・削除などの構造変更を停止');
  });

  it('allows shared display mode switching while keeping structure guards', () => {
    const source = appSource();
    const modeHandlers = sliceBetween(
      source,
      'const handleToggleMode = useCallback',
      'const handleSelectEvent = useCallback',
    );
    const structureHandlers = sliceBetween(
      source,
      'const handleDeleteEvent = useCallback',
      'const handleBlockSortToggle = () => {',
    );
    const mapStructureHandlers = sliceBetween(
      source,
      'const handleImportMapData = useCallback',
      'const handleAddToExecuteListFromMap = useCallback',
    );
    const hallStructureHandlers = sliceBetween(
      source,
      'const handleUpdateBlocks = useCallback',
      'const handleUpdateMaplessHalls = useCallback',
    );

    expect(modeHandlers).not.toContain('guardSharingStructureMutation');
    expect(modeHandlers).toContain("const newMode: ViewMode = currentModeValue === 'edit' ? 'execute' : 'edit'");
    expect(modeHandlers).toContain("if (mode !== 'focus')");
    expect(structureHandlers).toContain('guardSharingStructureMutation(eventName)');
    expect(structureHandlers).toContain('guardSharingStructureMutation(oldName)');
    expect(mapStructureHandlers).toContain('guardSharingStructureMutation(eventName)');
    expect(hallStructureHandlers).toContain('guardSharingStructureMutation(activeEventName)');
  });

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

  it('renders shared structural item notifications with Japanese labels', () => {
    const source = appSource();
    const fieldLabels = sliceBetween(
      source,
      'const sharingFieldLabels: Record<string, string> = {',
      'const buildSharingNotificationMessage = (',
    );
    const labelFormatter = sliceBetween(
      source,
      'const formatSharingUpdatedFieldLabels = (',
      'const buildSharingNotificationMessage = (',
    );
    const notificationMessageBuilder = sliceBetween(
      source,
      'const buildSharingNotificationMessage = (',
      'const sortLabels: Record<SortState, string> = {',
    );

    expect(fieldLabels).toContain("circle: 'サークル名'");
    expect(fieldLabels).toContain("circleName: 'サークル名'");
    expect(fieldLabels).toContain("circle_name: 'サークル名'");
    expect(fieldLabels).toContain("block: 'ブロック'");
    expect(fieldLabels).toContain("blockName: 'ブロック'");
    expect(fieldLabels).toContain("block_name: 'ブロック'");
    expect(fieldLabels).toContain("number: 'スペース番号'");
    expect(fieldLabels).toContain("boothNumber: 'スペース番号'");
    expect(fieldLabels).toContain("booth_number: 'スペース番号'");
    expect(fieldLabels).toContain("name: 'タイトル'");
    expect(fieldLabels).toContain("title: 'タイトル'");
    expect(fieldLabels).toContain("eventDate: '参加日'");
    expect(fieldLabels).toContain("event_date: '参加日'");
    expect(fieldLabels).toContain("priorityLevel: '優先度'");
    expect(fieldLabels).toContain("priority_level: '優先度'");
    expect(fieldLabels).toContain("protectionLevel: '保護レベル'");
    expect(fieldLabels).toContain("protection_level: '保護レベル'");
    expect(fieldLabels).toContain("source: '登録元'");
    expect(fieldLabels).toContain("manualHallId: '手動ホール'");
    expect(fieldLabels).toContain("manual_hall_id: '手動ホール'");
    expect(fieldLabels).toContain("purchaseStatus: '購入状態'");
    expect(fieldLabels).toContain("purchase_status: '購入状態'");
    expect(fieldLabels).toContain("actualPurchaseQuantity: '実購入数'");
    expect(fieldLabels).toContain("actual_purchase_quantity: '実購入数'");
    expect(fieldLabels).toContain("deletedAt: '削除日時'");
    expect(fieldLabels).toContain("deleted_at: '削除日時'");
    expect(fieldLabels).toContain("deletedBy: '削除者'");
    expect(fieldLabels).toContain("deleted_by: '削除者'");
    expect(fieldLabels).toContain("routeOrderByDate: '巡回順'");
    expect(fieldLabels).toContain("route_order_by_date: '巡回順'");
    expect(fieldLabels).toContain("orderIndex: '巡回順'");
    expect(labelFormatter).toContain("sharingFieldLabels[field] ?? '更新項目'");
    expect(labelFormatter).toContain('Array.from(new Set(labels))');
    expect(labelFormatter).not.toContain('sharingFieldLabels[field] ?? field');
    expect(notificationMessageBuilder).toContain('formatSharingUpdatedFieldLabels(updatedFields)');
    expect(notificationMessageBuilder).toContain("notification.notificationType === 'item_created'");
    expect(notificationMessageBuilder).toContain('が追加されました。');
    expect(notificationMessageBuilder).toContain("notification.notificationType === 'item_deleted'");
    expect(notificationMessageBuilder).toContain('が削除されました。');
  });

  it('persists tombstone clocks from shared delete diffs', () => {
    const source = appSource();
    const tombstoneHelper = sliceBetween(
      source,
      'const mergeDeletedItemClocksFromChanges = (',
      'const resolvePendingItemSyncAck = (',
    );
    const mutationSaver = sliceBetween(
      source,
      'const saveSharingMutationVersion = useCallback',
      'const refreshSharingNotifications = useCallback',
    );
    const syncHandler = sliceBetween(
      source,
      'const synchronizeSharingSession = useCallback',
      'const handleCreateSharingRoom = useCallback',
    );

    expect(tombstoneHelper).toContain("change.changeType !== 'delete'");
    expect(tombstoneHelper).toContain('[change.localItemId]');
    expect(tombstoneHelper).toContain('fieldClocks: {');
    expect(tombstoneHelper).toContain('itemVersion: change.itemsVersion');
    expect(mutationSaver).toContain('if (item.deletedAt)');
    expect(mutationSaver).toContain('deletedItemClocks = {');
    expect(mutationSaver).toContain('itemVersion: item.itemVersion');
    expect(syncHandler).toContain('let nextDeletedItemClocks = session.deletedItemClocks');
    expect(syncHandler).toContain('markPendingItemSyncAckAttempt(');
    expect(syncHandler).toContain('nextPendingItemSyncAck,');
    expect(syncHandler).toContain('mergeDeletedItemClocksFromChanges(');
    expect(syncHandler).toContain('deletedItemClocks: nextDeletedItemClocks');
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
    expect(syncHandler).toContain('hasVisibleRouteItemsOutsideServerRouteVersions(');
    expect(syncHandler).toContain('await applySnapshotAndAck(session.roomId)');
    expect(syncHandler).toContain('nextRouteOrderVersions = { ...serverRouteOrderVersions }');
    expect(syncHandler).toContain('removeRouteOrdersOutsideServerRouteVersions(');
    expect(syncHandler).toContain('getRouteOrderByDate(session.roomId, eventDate)');
    expect(syncHandler).toContain('nextEventRouteOrders[eventDate] = route.data.itemIds');
    expect(syncHandler).toContain('[eventDate]: route.data.dateRouteOrderVersion');
    expect(syncHandler).toContain('routeOrdersReferenceMissingItems(nextEventItems, changedRouteOrders)');
    expect(syncHandler).toContain('updateExecuteModeItems((prev) => ({');
    expect(syncHandler).toContain('ackRoomRouteOrderVersions(');
    expect(syncHandler).toContain('nextRouteOrderVersions = routeAck.data.routeOrderVersions');
    expect(syncHandler).toContain('routeOrderVersions: nextRouteOrderVersions');
  });

  it('blocks incremental sync when persisted v2 metadata is missing required clocks', () => {
    const source = appSource();
    const syncHandler = sliceBetween(
      source,
      'const synchronizeSharingSession = useCallback',
      'const handleCreateSharingRoom = useCallback',
    );

    expect(source).toContain('isSharingSessionSyncMetadataCompatible');
    expect(source).toContain('SHARING_SYNC_UPGRADE_REQUIRED_MESSAGE');
    expect(source).toContain('buildLocalizedSharingSessionForSyncUpgrade');
    expect(syncHandler).toContain('!isSharingSessionSyncMetadataCompatible(startSession)');
    expect(syncHandler).toContain('localizeSharingSessionForSyncUpgrade(startSession)');
  });

  it('recovers shared mutation full-refresh requirements through snapshot reinitialization', () => {
    const source = appSource();
    const assignmentHandler = sliceBetween(
      source,
      'const handleAssignSharingItem = useCallback',
      'const handleBulkAssignSelectedSharingItems = useCallback',
    );
    const bulkAssignmentHandler = sliceBetween(
      source,
      'const handleBulkAssignSelectedSharingItems = useCallback',
      'const refreshSharingNotifications = useCallback',
    );
    const updateHandler = sliceBetween(
      source,
      'const handleUpdateItem = useCallback',
      'const saveSharingRouteOrderMutation = useCallback',
    );
    const routeMutationHelper = sliceBetween(
      source,
      'const saveSharingRouteOrderMutation = useCallback',
      'const handleMoveItem = useCallback',
    );
    const deleteHandler = sliceBetween(
      source,
      'const handleConfirmDelete = async () => {',
      'const handleDoneEditing = () => {',
    );
    const bulkStatusHandler = sliceBetween(
      source,
      'const handleBulkStatusChange = useCallback',
      'const handleUpdateItemPriority = useCallback',
    );
    const addHandler = sliceBetween(
      source,
      'const handleAddItemFromFocusMode = useCallback',
      'const handleMoveToFirstFromMap = useCallback',
    );
    const visitListConfirmHandler = sliceBetween(
      source,
      'const handleVisitListConfirm = useCallback',
      'const handleVisitListCancel = useCallback',
    );

    expect(source).toContain("const isFullItemRefreshRequired = (code: string): boolean => code === 'FULL_ITEM_REFRESH_REQUIRED'");
    const snapshotHandler = sliceBetween(
      source,
      'const applySnapshotAndAck = useCallback',
      'const saveSharingSessionState = useCallback',
    );
    expect(snapshotHandler).toContain('isFullItemRefreshRequired(snapshotEnvelope.error.code)');
    expect(snapshotHandler).toContain('buildLocalizedSharingSessionForSyncUpgrade(sessionToStop)');
    expect(snapshotHandler).toContain('SHARING_SYNC_UNUSABLE_MESSAGE');
    for (const handler of [
      assignmentHandler,
      bulkAssignmentHandler,
      updateHandler,
      routeMutationHelper,
      deleteHandler,
      bulkStatusHandler,
      addHandler,
      visitListConfirmHandler,
    ]) {
      expect(handler).toContain('isFullItemRefreshRequired(');
      expect(handler).toContain('applySnapshotAndAck(');
    }
    expect(routeMutationHelper).toContain('applySnapshotAndAck,');
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

  it('moves a shared route item date edit to the new date candidate column', () => {
    const source = appSource();
    const updateHandler = sliceBetween(
      source,
      'const handleUpdateItem = useCallback',
      'const handleMoveItem = useCallback',
    );

    expect(updateHandler).toContain('const routeDateMoveToCandidate = isSharingRouteDateMoveToCandidate(');
    expect(updateHandler).toContain('!routeDateMoveToCandidate');
    expect(updateHandler).toContain('eventDate: currentItem.eventDate');
    expect(updateHandler).toContain('itemIds: currentRouteItemIds.filter((itemId) => itemId !== currentItem.id)');
    expect(updateHandler).toContain('routeUpdates');
    expect(updateHandler).toContain("result.error.code === 'ROUTE_ORDER_CONFLICT'");
    expect(updateHandler).toContain('applyCanonicalRouteOrdersToItems(updatedItems, changedRouteOrders)');
    expect(updateHandler).toContain('pendingRouteOrderAcks');
    expect(updateHandler).toContain('共有アイテムを新しい参加日の候補へ移動しました。');
  });

  it('saves shared candidate and execute column moves through route order RPC', () => {
    const source = appSource();
    const routeMutationHelper = sliceBetween(
      source,
      'const saveSharingRouteOrderMutation = useCallback',
      'const handleMoveItem = useCallback',
    );
    const moveHandler = sliceBetween(
      source,
      'const handleMoveItem = useCallback',
      'const handleMoveItemVerticalInternal = useCallback',
    );
    const bulkMoveHandlers = sliceBetween(
      source,
      'const handleMoveToExecuteColumn = useCallback',
      'const handleToggleMode = useCallback',
    );

    expect(routeMutationHelper).toContain('updateRouteOrder({');
    expect(routeMutationHelper).toContain('routeOrderVersions: result.data.routeOrderVersions');
    expect(routeMutationHelper).toContain('pendingRouteOrderAcks');
    expect(moveHandler).toContain('activeSharingSession?.eventName === activeEventName');
    expect(moveHandler).toContain('saveSharingRouteOrderMutation(');
    expect(moveHandler).toContain('共有アイテムを巡回順に追加しました。');
    expect(moveHandler).toContain('共有アイテムを候補へ移動しました。');
    expect(bulkMoveHandlers).toContain('computeMoveToExecuteColumn(');
    expect(bulkMoveHandlers).toContain('computeRemoveFromExecuteColumn(');
    expect(bulkMoveHandlers).toContain('saveSharingRouteOrderMutation(');
  });

  it('auto assigns shared candidate additions to the operating member', () => {
    const source = appSource();
    const assignmentHelper = sliceBetween(
      source,
      'const assignSharingRouteItemsToCurrentMember = useCallback',
      'const handleAssignSharingItem = useCallback',
    );
    const moveHandler = sliceBetween(
      source,
      'const handleMoveItem = useCallback',
      'const handleMoveItemVerticalInternal = useCallback',
    );
    const bulkMoveHandler = sliceBetween(
      source,
      'const handleMoveToExecuteColumn = useCallback',
      'const handleRemoveFromExecuteColumn = useCallback',
    );
    const mapAddHelper = sliceBetween(
      source,
      'const saveSharingMapRouteAddMutation = useCallback',
      'const handleAddToExecuteListFromMap = useCallback',
    );
    const mapRouteHandlers = sliceBetween(
      source,
      'const handleAddToExecuteListFromMap = useCallback',
      'const handleAddNewItemFromMap = useCallback',
    );

    expect(assignmentHelper).toContain('assignedToMemberId: session.roomMemberId');
    expect(assignmentHelper).toContain('updateRoomItemAssignmentWithMemberRoutes({');
    expect(assignmentHelper).toContain('buildSharingMemberRouteUpdatesForAssignment(');
    expect(moveHandler).toContain('assignSharingRouteItemsToCurrentMember(');
    expect(bulkMoveHandler).toContain('assignSharingRouteItemsToCurrentMember(');
    expect(bulkMoveHandler).toContain('共有アイテムを巡回順に追加し、担当者を更新しました。');
    expect(mapAddHelper).toContain('saveSharingRouteOrderMutation(');
    expect(mapAddHelper).toContain('assignSharingRouteItemsToCurrentMember(');
    expect(mapRouteHandlers).toContain('saveSharingMapRouteAddMutation(');
    expect(mapRouteHandlers).toContain('result.insertedItemIds');
    expect(mapRouteHandlers).toContain('insertedItemIds');
  });

  it('renders all-member map routes from execute order with member-colored number markers', () => {
    const mapView = mapViewSource();
    const mapCanvas = mapCanvasSource();
    const overlayBuilder = sliceBetween(
      mapView,
      'const memberRouteOverlays = useMemo<MemberRouteOverlay[]>(() => {',
      'const mapInsertRouteSegments = useMemo',
    );
    const overlayDrawing = sliceBetween(
      mapCanvas,
      'if (!isRotationInteracting && effectiveRouteVisible && memberRouteOverlays.length > 0) {',
      'if (!isRotationInteracting && effectiveRouteVisible && routeSegments.length > 0 && routeCrossingData) {',
    );

    expect(overlayBuilder).toContain('executeModeItemIds.filter');
    expect(overlayBuilder).toContain('item?.assignedTo === member.roomMemberId');
    expect(overlayBuilder).toContain("color: member.color || '#2563EB'");
    expect(overlayBuilder).not.toContain('memberRouteItemsForDate[member.roomMemberId]');
    expect(overlayDrawing).toContain('filterFirstRouteMarkers(overlay.routePoints)');
    expect(overlayDrawing).toContain('ctx.fillStyle = overlay.color');
    expect(overlayDrawing).toContain('drawUprightText(String(point.order + 1), px, py)');
  });

  it('saves shared map route operations through route order RPC', () => {
    const source = appSource();
    const mapAddHelper = sliceBetween(
      source,
      'const saveSharingMapRouteAddMutation = useCallback',
      'const handleAddToExecuteListFromMap = useCallback',
    );
    const mapRouteHandlers = sliceBetween(
      source,
      'const handleAddToExecuteListFromMap = useCallback',
      'const handleAddNewItemFromMap = useCallback',
    );
    const mapEndpointHandlers = sliceBetween(
      source,
      'const handleMoveToFirstFromMap = useCallback',
      'const currentMapExecuteItemIds = useMemo',
    );
    const hallOrderHandler = sliceBetween(
      source,
      'const handleReorderExecuteListByHallOrder = useCallback',
      'const [hallDefinitionMode, setHallDefinitionMode] = useState',
    );

    expect(mapRouteHandlers).toContain('activeSharingSession?.eventName === activeEventName');
    expect(mapAddHelper).toContain('saveSharingRouteOrderMutation(');
    expect(mapAddHelper).toContain('共有アイテムを巡回順に追加しました。');
    expect(mapRouteHandlers).toContain('saveSharingMapRouteAddMutation(');
    expect(mapRouteHandlers).toContain('共有アイテムを候補へ移動しました。');
    expect(mapEndpointHandlers).toContain('saveSharingRouteOrderMutation(');
    expect(mapEndpointHandlers).toContain('共有アイテムの巡回順を更新しました。');
    expect(hallOrderHandler).toContain('saveSharingRouteOrderMutation(');
    expect(hallOrderHandler).toContain('reorderExecuteIdsByHallOrder({');
  });

  it('saves shared execute-column bulk number sort through route order RPC', () => {
    const source = appSource();
    const bulkSortHandler = sliceBetween(
      source,
      'const handleBulkSort = useCallback',
      'const handleExportEvent = useCallback',
    );

    expect(bulkSortHandler).toContain('activeSharingSession?.eventName === activeEventName');
    expect(bulkSortHandler).toContain("mode !== 'edit'");
    expect(bulkSortHandler).toContain('共有中の候補列の一括番号ソートは同期対象外です。巡回列だけで選択してください。');
    expect(bulkSortHandler).toContain('saveSharingRouteOrderMutation(');
    expect(bulkSortHandler).toContain('共有アイテムの巡回順を更新しました。');
  });

  it('saves shared priority placement changes through route-aware upsert', () => {
    const source = appSource();
    const priorityRouteHelper = sliceBetween(
      source,
      'const buildSharingStructuralRouteUpdates = (',
      'const hasSharingAssignmentOrLockChange = (',
    );
    const updateHandler = sliceBetween(
      source,
      'const handleUpdateItem = useCallback',
      'const saveSharingRouteOrderMutation = useCallback',
    );
    const priorityHandlers = sliceBetween(
      source,
      'const handleUpdateItemPriority = useCallback',
      'const handleUpdateHallOrderForPriorityChangeFromEdit = useCallback',
    );
    const priorityHallOrderHelper = sliceBetween(
      source,
      'const handleUpdateHallOrderForPriorityChangeFromEdit = useCallback',
      'const handleTabChangeWithVisitListCheck = (newTab: string): boolean => {',
    );

    expect(priorityRouteHelper).toContain("currentItem.priorityLevel ?? 'none'");
    expect(priorityRouteHelper).toContain('reorderExecuteIdsForSpaceAdjacency(');
    expect(priorityRouteHelper).toContain('expectedVersion: routeOrderVersions[updatedItem.eventDate] ?? 0');
    expect(updateHandler).toContain('buildSharingStructuralRouteUpdates(');
    expect(updateHandler).toContain('upsertRoomItemWithRoute({');
    expect(priorityHandlers).toContain('activeSharingSession?.eventName === activeEventName');
    expect(priorityHandlers).toContain('void handleUpdateItem({ ...item, priorityLevel })');
    expect(priorityHallOrderHelper).toContain('activeSharingSession?.eventName === activeEventName');
    expect(priorityHallOrderHelper).toContain('if (sharingSession) return;');
  });

  it('uses edit-start item and field clock baseline for shared edit saves', () => {
    const source = appSource();
    const stateBlock = sliceBetween(
      source,
      'const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);',
      'const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);',
    );
    const updateHandler = sliceBetween(
      source,
      'const handleUpdateItem = useCallback',
      'const saveSharingRouteOrderMutation = useCallback',
    );
    const editRequestHandler = sliceBetween(
      source,
      'const handleEditRequest = (item: ShoppingItem) => {',
      'const handleDeleteRequest = useCallback',
    );

    expect(stateBlock).toContain('editFieldClockBaselineByItemId');
    expect(editRequestHandler).toContain('fieldClockBaseline');
    expect(editRequestHandler).toContain('setEditFieldClockBaselineByItemId');
    expect(updateHandler).toContain('const editBaselineItem =');
    expect(updateHandler).toContain('const editBaselineFieldClocks =');
    expect(updateHandler).toContain('buildSharingStructuralItemFields(editBaselineItem, updatedItem)');
    expect(updateHandler).toContain('buildSharingMutableItemFields(editBaselineItem, updatedItem)');
    expect(updateHandler).toContain('pickExpectedFieldClocksFrom(');
  });

  it('syncs limited purchase through actualPurchaseQuantity without introducing limitQuantity UI state', () => {
    const source = appSource();
    const updateHandler = sliceBetween(
      source,
      'const handleUpdateItem = useCallback',
      'const saveSharingRouteOrderMutation = useCallback',
    );
    const mutableFieldsHelper = sliceBetween(
      source,
      'type SharingMutableItemFields = {',
      'type SharingStructuralItemFields = {',
    );
    const createFieldsHelper = sliceBetween(
      source,
      'const buildSharingCreateItemFields = (item: ShoppingItem): SharingCreateItemFields => {',
      'const buildSharingMutableItemFields = (',
    );
    const expectedClockHelper = sliceBetween(
      source,
      'const buildPurchaseExpectedClockFields = (',
      'const pickExpectedFieldClocks = (',
    );

    expect(mutableFieldsHelper).toContain('actualPurchaseQuantity?: number | null;');
    expect(mutableFieldsHelper).not.toContain('limitQuantity');
    expect(createFieldsHelper).toContain('actualPurchaseQuantity: null');
    expect(createFieldsHelper).not.toContain('limitQuantity');
    expect(updateHandler).toContain("updatedItem.purchaseStatus === 'LimitedPurchase'");
    expect(updateHandler).toContain('updatedItem.limitedPurchasedQuantity ?? null');
    expect(expectedClockHelper).toContain(
      "fieldNames.push('purchaseStatus', 'actualPurchaseQuantity', 'securedBy')",
    );
  });

  it('creates shared safe-state items through route-aware upsert', () => {
    const source = appSource();
    const createFieldsHelper = sliceBetween(
      source,
      'const buildSharingCreateItemFields = (item: ShoppingItem): SharingCreateItemFields => {',
      'const buildSharingMutableItemFields = (',
    );
    const addHandler = sliceBetween(
      source,
      'const handleAddItemFromFocusMode = useCallback',
      'const handleMoveToFirstFromMap = useCallback',
    );
    const bulkAddHandler = sliceBetween(
      source,
      'const handleBulkAdd = useCallback',
      'const handleUpdateItem = useCallback',
    );
    const mapNewItemHandler = sliceBetween(
      source,
      'const handleAddNewItemFromMap = useCallback',
      'const handleAddItemFromFocusMode = useCallback',
    );

    expect(createFieldsHelper).toContain('purchaseStatus: item.purchaseStatus');
    expect(createFieldsHelper).toContain('actualPurchaseQuantity: null');
    expect(addHandler).toContain("requestedStatus === 'Purchased' || requestedStatus === 'LimitedPurchase'");
    expect(addHandler).toContain("requestedStatus === 'Postpone' || requestedStatus === 'Late'");
    expect(addHandler).toContain('upsertRoomItemWithRoute({');
    expect(addHandler).toContain('fields: buildSharingCreateItemFields(createdItem)');
    expect(addHandler).toContain('expectedFieldClocks: {}');
    expect(addHandler).toContain('pendingRouteOrderAcks');
    expect(addHandler).toContain('共有アイテムを追加しました。');
    expect(bulkAddHandler).toContain('const isSharedSingleAppCreate');
    expect(bulkAddHandler).toContain("metadata?.source === 'app'");
    expect(bulkAddHandler).toContain('routeUpdates: []');
    expect(bulkAddHandler).toContain('fields: buildSharingCreateItemFields(createdItem)');
    expect(bulkAddHandler).toContain('共有アイテムを追加しました。');
    expect(mapNewItemHandler).toContain('activeSharingSession?.eventName === activeEventName');
    expect(mapNewItemHandler).toContain('if (!sharingSession && guardSharingStructureMutation(activeEventName)) return');
  });

  it('opens shared delete confirmation and deletes through route-aware RPC', () => {
    const source = appSource();
    const deleteCleanupHelper = sliceBetween(
      source,
      'const cleanupDeletedSharedItemsFromUiState = useCallback',
      'const synchronizeSharingSession = useCallback',
    );
    const syncHandler = sliceBetween(
      source,
      'const synchronizeSharingSession = useCallback',
      'const handleCreateSharingRoom = useCallback',
    );
    const deleteRequestHandlers = sliceBetween(
      source,
      'const handleDeleteRequest = useCallback',
      'const handleClearNewItemDefaults = useCallback',
    );
    const confirmDeleteHandler = sliceBetween(
      source,
      'const handleConfirmDelete = async () => {',
      'const handleDoneEditing = () => {',
    );

    expect(deleteCleanupHelper).toContain('removeDeletedIdsFromExecuteModeItems(eventItems, deletedIds)');
    expect(deleteCleanupHelper).toContain('setSelectedItemIds((prev) => {');
    expect(deleteCleanupHelper).toContain('setItemToEdit((item) => (item && deletedIds.has(item.id) ? null : item))');
    expect(deleteCleanupHelper).toContain('setHighlightedItemId((itemId) => (itemId && deletedIds.has(itemId) ? null : itemId))');
    expect(syncHandler).toContain('const deletedItemIds = getDeletedLocalItemIdsFromChanges(changes.data.changes)');
    expect(syncHandler).toContain('cleanupDeletedSharedItemsFromUiState(session.eventName, deletedItemIds)');
    expect(deleteRequestHandlers).toContain('activeSharingSession?.eventName === activeEventName');
    expect(deleteRequestHandlers).toContain('if (!sharingSession && guardSharingStructureMutation(activeEventName)) return');
    expect(confirmDeleteHandler).toContain('deleteRoomItemWithRoute({');
    expect(confirmDeleteHandler).toContain("['deletedAt', 'deletedBy']");
    expect(confirmDeleteHandler).toContain('routeUpdates');
    expect(confirmDeleteHandler).toContain('pendingRouteOrderAcks');
    expect(confirmDeleteHandler).toContain('共有アイテムを削除しました。');
  });

  it('uses one shared bulk purchase RPC for all-or-nothing status updates', () => {
    const source = appSource();
    const bulkStatusHandler = sliceBetween(
      source,
      'const handleBulkStatusChange = useCallback',
      'const handleExecuteItemUpdate = useCallback',
    );

    expect(bulkStatusHandler).toContain('const sharingSession = activeSharingSession');
    expect(bulkStatusHandler).toContain('const mutations = []');
    expect(bulkStatusHandler).toContain('buildPurchaseExpectedClockFields({}, newStatus)');
    expect(bulkStatusHandler).toContain('mutations.push({');
    expect(bulkStatusHandler).toContain('localItemId: item.id');
    expect(bulkStatusHandler).toContain('fields: {}');
    expect(bulkStatusHandler).toContain('status: newStatus');
    expect(bulkStatusHandler).toContain('expectedFieldClocks');
    expect(bulkStatusHandler).toContain('bulkUpdateRoomItemsWithPurchase({');
    expect(bulkStatusHandler).toContain('roomId: sharingSession.roomId');
    expect(bulkStatusHandler).toContain('mutations');
    expect(bulkStatusHandler).not.toContain('updateRoomItemWithPurchase({');
    expect(bulkStatusHandler).toContain('result.data.changedItems.map((change) => change.item)');
    expect(bulkStatusHandler).toContain('await saveSharingMutationVersion(sharingSession, result.data.itemsVersion, updatedItems)');
    expect(bulkStatusHandler).toContain('applyBulkProgressUi(changedItems)');
    expect(bulkStatusHandler).toContain('まとめ変更を中断し、最新状態を取得しました。');
  });

  it('keeps shared item and route UI operations enabled while guarding event and map structure changes', () => {
    const source = appSource();
    const updateHandler = sliceBetween(
      source,
      'const handleUpdateItem = useCallback',
      'const saveSharingRouteOrderMutation = useCallback',
    );
    const routeMutationHelper = sliceBetween(
      source,
      'const saveSharingRouteOrderMutation = useCallback',
      'const handleMoveItem = useCallback',
    );
    const moveHandler = sliceBetween(
      source,
      'const handleMoveItem = useCallback',
      'const handleMoveItemVerticalInternal = useCallback',
    );
    const addHandler = sliceBetween(
      source,
      'const handleAddItemFromFocusMode = useCallback',
      'const handleMoveToFirstFromMap = useCallback',
    );
    const confirmDeleteHandler = sliceBetween(
      source,
      'const handleConfirmDelete = async () => {',
      'const handleDoneEditing = () => {',
    );
    const eventStructureHandlers = sliceBetween(
      source,
      'const handleDeleteEvent = useCallback',
      'const handleSortToggle = () => {',
    );
    const mapRotationHandlers = sliceBetween(
      source,
      'const handleMapTabRotationAngleChange = useCallback',
      'const currentMapTabViewport = useMemo',
    );
    const mapImportHandlers = sliceBetween(
      source,
      'const handleImportMapData = useCallback',
      'const handleMapFileChange = useCallback',
    );
    const hallStructureHandlers = sliceBetween(
      source,
      'const handleUpdateBlocks = useCallback',
      'const handleReorderExecuteListByHallOrder = useCallback',
    );
    const appContentProps = sliceBetween(source, '<AppMainContent', '<AppOverlayLayer');

    expect(updateHandler).toContain('if (sharingSession) {');
    expect(updateHandler).toContain('upsertRoomItemWithRoute({');
    expect(updateHandler).toContain('updateRoomItemWithPurchase({');
    expect(routeMutationHelper).toContain('updateRouteOrder({');
    expect(moveHandler).toContain('if (!sharingSession && guardSharingStructureMutation(activeEventName)) return');
    expect(moveHandler).toContain('saveSharingRouteOrderMutation(');
    expect(addHandler).toContain('if (!sharingSession && guardSharingStructureMutation(activeEventName)) return');
    expect(addHandler).toContain('upsertRoomItemWithRoute({');
    expect(confirmDeleteHandler).toContain('deleteRoomItemWithRoute({');

    expect(eventStructureHandlers).toContain('if (guardSharingStructureMutation(eventName)) return');
    expect(eventStructureHandlers).toContain('if (guardSharingStructureMutation(oldName)) return');
    expect(eventStructureHandlers).toContain('if (guardSharingStructureMutation(eventToRename)) return');
    expect(mapRotationHandlers).toContain('if (guardSharingStructureMutation(activeEventName)) return');
    expect(mapImportHandlers).toContain('if (guardSharingStructureMutation(eventName)) return');
    expect(hallStructureHandlers).toContain('if (guardSharingStructureMutation(activeEventName)) return');

    expect(appContentProps).toContain('handleBulkAdd={handleBulkAdd}');
    expect(appContentProps).toContain('handleBulkStatusChange={handleBulkStatusChange}');
    expect(appContentProps).toContain('handleDeleteRequest={handleDeleteRequest}');
    expect(appContentProps).toContain('handleMoveItem={handleMoveItem}');
    expect(appContentProps).toContain('handleMoveToExecuteColumn={handleMoveToExecuteColumn}');
    expect(appContentProps).toContain('handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}');
    expect(appContentProps).toContain('handleAddItemFromFocusMode={handleAddItemFromFocusMode}');
    expect(appContentProps).toContain('handleAddNewItemFromMap={handleAddNewItemFromMap}');
    expect(appContentProps).toContain('handleImportMapData={handleImportMapData}');
    expect(appContentProps).toContain('handleRenameEvent={handleRenameEvent}');
  });
});
