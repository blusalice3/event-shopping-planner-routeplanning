import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ShoppingItem,
  AssignmentMemberProfile,
  PurchaseStatus,
  EventMetadata,
  ViewMode,
  DayModeState,
  ExecuteModeItems,
  MemberRouteItems,
  MemberRouteCandidateFilter,
  MapRouteDisplayMode,
  RouteScope,
} from './types/item';
import {
  MapDataStore,
  RouteSettingsStore,
  BlockDefinition,
  HallDefinition,
  HallRouteSettings,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  DayMapData,
  BlockDetectionSettings,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  MapViewportState,
} from './types/map';
import { ExportOptions } from './types/export';
import { FocusModeSessionState } from './types/focus';
import { MAPLESS_HALL_KEY, getMaplessKey } from './types/map';
import { resolveHallByBlockName, resolveManualHallId, findHallsByBlockName } from './utils/hallFallback';
import { buildMergedHallRouteSettings } from './utils/mergedHallRouteSettings';
import { isPointInPolygon, saveBlockDetectionSettings } from './components/map';
import { extractEventDates } from './utils/eventDates';
import { getSpaceKey } from './utils/spaceGrouping';
import { importFromXlsx, downloadBlob, type ItemFallbackWarning } from './utils/exportImport';
import {
  buildBulkAddUiPlan,
  buildBulkAddEventMetadata,
  buildBulkAddItems,
  buildInitialDayModesForBulkAdd,
  buildInitialExecuteItemsForBulkAdd,
  buildLayoutAppliedEventItems,
  hasBulkAddLayoutInfo,
  type BulkAddMetadata,
} from './features/events/bulkAdd';
import { type EventUpdateDiff } from './features/events/updateDiff';
import {
  applyEventUpdateToItems,
  removeDeletedIdsFromExecuteModeItems,
} from './features/events/updateApply';
import { reconcileFocusModeSessions } from './features/focus/focusModeSessionReconcile';
import {
  buildEventUpdateDiffFromSpreadsheet,
  resolveSpreadsheetSource,
} from './features/events/updateFlow';
import { buildEventExportFile, hasExportableItems } from './features/events/exportFlow';
import { toImportedEventData } from './features/events/fileImport';
import { removeRecordKey, renameRecordKey, upsertRecordKey } from './features/events/recordOps';
import {
  computeUpdateItem,
  computeDeleteItem,
  computeAddItemFromFocusMode,
  computeAddToExecuteListFromMapWithResult,
  computeRemoveFromExecuteListFromMap,
  computeMoveToExecuteColumn,
  computeRemoveFromExecuteColumn,
  computeMoveItem,
  computeMoveItemVertical,
  computeUpdateItemPriority,
  computeHallOrderForPriorityChange,
  computeInsertIntoExecuteAtPosition,
  expandExecuteRemovalItemIds,
  expandSameSpacePriorityItemIds,
  reorderExecuteIdsForSpaceAdjacency,
  removeDeletedIdsFromMemberRouteItems,
  applyCanonicalMemberRouteOrders,
} from './features/events/itemOps';
import {
  buildImportCompletionMessage,
  resolveEventListTab,
} from './features/events/uiOrchestration';
import {
  cloneHallsForDates,
  emptyHallRouteSettings,
  getCombinedHallRouteSettingsForDate,
  getGlobalHallItemCount as computeGlobalHallItemCount,
  remapHallRouteSettings,
  reorderExecuteIdsByHallOrder,
  splitGlobalHallRouteSettings,
  splitHallsForStorage,
  updateHallDefinitionsForHalls,
  updateHallRouteSettingsForHalls,
  updateMaplessHallDefinitions,
  updateMaplessHallRouteSettings,
} from './features/map/domain/hallOperations';
import { useMapSelectors } from './features/map/hooks/useMapSelectors';
import { useListInteractionState } from './features/lists/hooks/useListInteractionState';
import AppHeaderShell from './features/app-shell/components/AppHeaderShell';
import AppMainContent from './features/app-shell/components/AppMainContent';
import AppOverlayLayer from './features/app-shell/components/AppOverlayLayer';
import { useThemeMode } from './hooks/useThemeMode';
import {
  DEFAULT_UI_VISIBILITY,
  useUIVisibilitySettings,
  type UIVisibilitySettings,
} from './hooks/useUIVisibilitySettings';
import { useNumberCellOutlineStyle } from './hooks/useNumberCellOutlineStyle';
import { useDisablePriceUndefinedCheck } from './hooks/useDisablePriceUndefinedCheck';
import { useDisableLimitedPurchaseQuantityCheck } from './hooks/useDisableLimitedPurchaseQuantityCheck';
import {
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
  useSkipLimitedPurchaseForSingleQuantity,
} from './hooks/useSkipLimitedPurchaseForSingleQuantity';
import { usePurchaseStatusControlMode } from './hooks/usePurchaseStatusControlMode';
import { useIndexedDbPersistence } from './hooks/useIndexedDbPersistence';
import SharingMvp0cPanel from './features/sharing/SharingMvp0cPanel';
import {
  SHARING_STRUCTURE_LOCK_MESSAGE,
  SHARING_SYNC_UPGRADE_REQUIRED_MESSAGE,
  SHARING_SYNC_UNUSABLE_MESSAGE,
  buildLocalizedSharingSessionForSyncUpgrade,
  buildCurrentSharingAppData,
  buildRoomEventPayloadForEvent,
  clearSatisfiedRouteOrderAcks,
  findActiveSharingSessionForEvent,
  isSharingSyncUpgradeRequiredErrorCode,
  isSharingSessionActive,
  isSharingSessionOperational,
  isSharingSessionSyncMetadataCompatible,
  markPendingItemSyncAckAttempt,
  markPendingRouteOrderAckAttempt,
  mergePendingRouteOrderAcks,
  repairDuplicateSharingItemIdsForEvent,
  type SharingAppState,
} from './features/sharing/appIntegration';
import {
  buildAssignmentRouteGroups,
  normalizeExecuteIdsByAssignmentRouteLock,
  reorderExecuteIdsByAssignmentRouteOrder,
} from './features/sharing/assignmentRouteOrder';
import {
  ackRoomSyncProgress,
  ackRoomRouteOrderVersions,
  applyRoomItemChangesToItems,
  bulkUpdateRoomItemsWithPurchase,
  commitSnapshotThenAck,
  createClientRoomId,
  createSharingRoom,
  deleteRoomItemWithRoute,
  generateMemberKey,
  getAllNotificationsAfterWatermark,
  getNotificationList,
  getRoomItemChangesSince,
  getRoomMembersForDisplay,
  getRoomSnapshot,
  getRoomVersions,
  getMemberRouteOrderByDate,
  getRouteOrderByDate,
  heartbeatRoomSession,
  hideNotification,
  joinPreparedRoom,
  leaveRoom,
  loadMemberKey,
  markNotificationRead,
  mergeSnapshotRoomItemIntoShoppingItem,
  pauseRoomSession,
  prepareJoinRoom,
  prepareRestoreRoom,
  restorePreparedRoom,
  roomSnapshotToAppData,
  subscribeToRoomSync,
  ackRoomMemberRouteOrderVersions,
  updateRoomItemWithPurchase,
  updateRoomItemAssignmentWithMemberRoutes,
  updateRouteOrder,
  upsertRoomItemWithRoute,
  type NotificationListItem,
  type ProcessedSyncEvent,
  type RoomItemFieldClocks,
  type RoomNotification,
  type RouteOrderUpdate,
  type SnapshotRoomItem,
  type AssignmentWithMemberRoutesResult,
  forgetMemberKey,
} from './features/sharing/client';
import { isRouteAffectingItemPlacementChange } from './features/sharing/routeAffecting';
import { getSharingAvailability } from './lib/supabase';
import type { SmartInsertMode, SortState } from './features/app-shell/types';
import { normalizeSmartInsertMode } from './utils/smartInsertMode';
import {
  clearLimitedPurchase,
  getLimitedPurchaseCounts,
  matchesPurchaseStatusFilter,
} from './utils/purchaseQuantity';
import { db, type AppData, type SharingSessionMetadata } from './utils/indexedDB';

type ActiveTab = 'eventList' | 'import' | string;
export type BulkSortDirection = 'asc' | 'desc';
type BlockSortDirection = 'asc' | 'desc';
type SharingPanelMode = 'join' | 'invite' | 'status';
type SharingMutableItemFields = {
  price?: number | null;
  quantity?: number | null;
  actualPurchaseQuantity?: number | null;
  remarks?: string | null;
  url?: string | null;
};

type SharingStructuralItemFields = {
  circle?: string;
  block?: string;
  number?: string;
  title?: string;
  eventDate?: string;
  priorityLevel?: 'none' | 'priority' | 'highest';
  protectionLevel?: string | null;
  source?: string | null;
  manualHallId?: string | null;
};

type SharingCreateItemFields = SharingStructuralItemFields &
  SharingMutableItemFields & {
    purchaseStatus: PurchaseStatus;
    actualPurchaseQuantity: null;
  };
type SharingRouteOrderLockMode = 'reject' | 'normalize' | 'allow';

const EMPTY_ASSIGNMENT_MEMBERS: AssignmentMemberProfile[] = [];
const SHARING_MEMBER_PROFILE_REFRESH_INTERVAL_MS = 10_000;
const SHARING_ITEM_SYNC_REFRESH_INTERVAL_MS = 10_000;

const areAssignmentMemberProfilesEqual = (
  left: AssignmentMemberProfile[] | undefined,
  right: AssignmentMemberProfile[] | undefined,
): boolean => {
  const leftMembers = left ?? EMPTY_ASSIGNMENT_MEMBERS;
  const rightMembers = right ?? EMPTY_ASSIGNMENT_MEMBERS;
  if (leftMembers.length !== rightMembers.length) return false;

  return leftMembers.every((member, index) => {
    const other = rightMembers[index];
    return (
      other !== undefined &&
      member.roomMemberId === other.roomMemberId &&
      member.displayName === other.displayName &&
      member.color === other.color &&
      member.role === other.role &&
      member.membershipStatus === other.membershipStatus
    );
  });
};

const sortCycle: SortState[] = [
  'Manual',
  'Postpone',
  'Late',
  'Absent',
  'SoldOut',
  'None',
  'Purchased',
  'LimitedPurchase',
];

const hasSharingRouteMembership = (item: ShoppingItem): boolean =>
  item.orderIndex !== undefined && item.orderIndex !== null;

const isSharingRouteDateMoveToCandidate = (
  currentItem: ShoppingItem,
  updatedItem: ShoppingItem,
): boolean =>
  hasSharingRouteMembership(currentItem) &&
  currentItem.eventDate !== updatedItem.eventDate;

type CanonicalRouteOrder = {
  eventDate: string;
  itemIds: string[];
};

type SharingMemberRouteUpdate = {
  eventDate: string;
  routeMemberId: string;
  itemIds: string[];
  expectedVersion: number;
};

const applyCanonicalRouteOrderToItems = (
  items: ShoppingItem[],
  routeOrder: CanonicalRouteOrder,
): ShoppingItem[] => {
  const routeIndexByItemId = new Map(
    routeOrder.itemIds.map((itemId, index) => [itemId, index]),
  );
  let changed = false;
  const nextItems = items.map((item) => {
    const canonicalIndex = routeIndexByItemId.get(item.id);
    if (canonicalIndex === undefined && item.eventDate !== routeOrder.eventDate) {
      return item;
    }

    const nextOrderIndex = canonicalIndex ?? undefined;
    if ((item.orderIndex ?? null) === (nextOrderIndex ?? null)) {
      return item;
    }

    changed = true;
    return {
      ...item,
      orderIndex: nextOrderIndex,
    };
  });

  return changed ? nextItems : items;
};

const applyCanonicalRouteOrdersToItems = (
  items: ShoppingItem[],
  routeOrders: CanonicalRouteOrder[],
): ShoppingItem[] =>
  routeOrders.reduce(
    (nextItems, routeOrder) => applyCanonicalRouteOrderToItems(nextItems, routeOrder),
    items,
  );

const routeOrdersReferenceMissingItems = (
  items: ShoppingItem[],
  routeOrders: CanonicalRouteOrder[],
): boolean => {
  const localItemIds = new Set(items.map((item) => item.id));
  return routeOrders.some((routeOrder) =>
    routeOrder.itemIds.some((itemId) => !localItemIds.has(itemId)),
  );
};

const areRouteItemIdsEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((itemId, index) => itemId === b[index]);

const getChangedMemberRouteVersionKeys = (
  serverVersions: Record<string, Record<string, number>>,
  localVersions: Record<string, Record<string, number>> | undefined,
): Array<{ eventDate: string; roomMemberId: string }> => {
  const changedKeys: Array<{ eventDate: string; roomMemberId: string }> = [];
  Object.entries(serverVersions).forEach(([eventDate, versionsByMember]) => {
    Object.entries(versionsByMember).forEach(([roomMemberId, version]) => {
      if ((localVersions?.[eventDate]?.[roomMemberId] ?? 0) !== version) {
        changedKeys.push({ eventDate, roomMemberId });
      }
    });
  });
  return changedKeys;
};

const hasVisibleRouteItemsOutsideServerRouteVersions = (
  eventRouteOrders: ExecuteModeItems,
  serverRouteOrderVersions: Record<string, number>,
): boolean =>
  Object.entries(eventRouteOrders).some(
    ([eventDate, itemIds]) => !(eventDate in serverRouteOrderVersions) && itemIds.length > 0,
  );

const removeRouteOrdersOutsideServerRouteVersions = (
  eventRouteOrders: ExecuteModeItems,
  serverRouteOrderVersions: Record<string, number>,
): ExecuteModeItems =>
  Object.fromEntries(
    Object.entries(eventRouteOrders).filter(([eventDate]) => eventDate in serverRouteOrderVersions),
  );

const buildSharingStructuralRouteUpdates = (
  currentItem: ShoppingItem,
  updatedItem: ShoppingItem,
  currentItems: ShoppingItem[],
  currentExecuteModeItems: ExecuteModeItems,
  routeOrderVersions: Record<string, number>,
): RouteOrderUpdate[] => {
  const placementGroupingChanged =
    currentItem.block !== updatedItem.block ||
    currentItem.number !== updatedItem.number ||
    (currentItem.priorityLevel ?? 'none') !== (updatedItem.priorityLevel ?? 'none');

  if (!placementGroupingChanged || !hasSharingRouteMembership(currentItem)) return [];
  if (!updatedItem.eventDate || currentItem.eventDate !== updatedItem.eventDate) return [];

  const currentRouteItemIds = currentExecuteModeItems[updatedItem.eventDate] ?? [];
  const updatedItems = currentItems.map((item) =>
    item.id === updatedItem.id ? updatedItem : item,
  );
  const reorderedExecuteModeItems = reorderExecuteIdsForSpaceAdjacency(
    updatedItem.id,
    updatedItems,
    currentExecuteModeItems,
    updatedItem.eventDate,
  );
  const nextRouteItemIds = normalizeExecuteIdsByAssignmentRouteLock(
    currentRouteItemIds,
    reorderedExecuteModeItems[updatedItem.eventDate] ?? [],
    updatedItems,
  );

  if (areRouteItemIdsEqual(currentRouteItemIds, nextRouteItemIds)) return [];

  return [
    {
      eventDate: updatedItem.eventDate,
      itemIds: nextRouteItemIds,
      expectedVersion: routeOrderVersions[updatedItem.eventDate] ?? 0,
    },
  ];
};

const hasSharingAssignmentOrLockChange = (
  currentItem: ShoppingItem,
  updatedItem: ShoppingItem,
): boolean =>
  currentItem.assignedTo !== updatedItem.assignedTo ||
  currentItem.securedBy !== updatedItem.securedBy;

const buildSharingStructuralItemFields = (
  currentItem: ShoppingItem,
  updatedItem: ShoppingItem,
): SharingStructuralItemFields => {
  const fields: SharingStructuralItemFields = {};
  if (currentItem.circle !== updatedItem.circle) fields.circle = updatedItem.circle;
  if (currentItem.block !== updatedItem.block) fields.block = updatedItem.block;
  if (currentItem.number !== updatedItem.number) fields.number = updatedItem.number;
  if (currentItem.title !== updatedItem.title) fields.title = updatedItem.title;
  if (currentItem.eventDate !== updatedItem.eventDate) fields.eventDate = updatedItem.eventDate;
  if ((currentItem.priorityLevel ?? 'none') !== (updatedItem.priorityLevel ?? 'none')) {
    fields.priorityLevel = updatedItem.priorityLevel ?? 'none';
  }
  if ((currentItem.protectionLevel ?? null) !== (updatedItem.protectionLevel ?? null)) {
    fields.protectionLevel = updatedItem.protectionLevel ?? null;
  }
  if ((currentItem.source ?? null) !== (updatedItem.source ?? null)) {
    fields.source = updatedItem.source ?? null;
  }
  if ((currentItem.manualHallId ?? null) !== (updatedItem.manualHallId ?? null)) {
    fields.manualHallId = updatedItem.manualHallId ?? null;
  }
  return fields;
};

const buildSharingCreateItemFields = (item: ShoppingItem): SharingCreateItemFields => {
  const fields: SharingCreateItemFields = {
    circle: item.circle,
    block: item.block,
    number: item.number,
    eventDate: item.eventDate,
    priorityLevel: item.priorityLevel ?? 'none',
    protectionLevel: item.protectionLevel ?? 'full',
    source: item.source ?? 'app',
    manualHallId: item.manualHallId ?? null,
    price: item.price ?? null,
    quantity: item.quantity ?? 1,
    remarks: item.remarks ?? '',
    url: item.url ?? null,
    purchaseStatus: item.purchaseStatus,
    actualPurchaseQuantity: null,
  };

  if (item.title.trim() !== '') {
    fields.title = item.title;
  }

  return fields;
};

const createSpreadsheetShoppingItem = (
  itemData: EventUpdateDiff['itemsToAdd'][number],
): ShoppingItem => ({
  id: crypto.randomUUID(),
  circle: itemData.circle,
  eventDate: itemData.eventDate,
  block: itemData.block,
  number: itemData.number,
  title: itemData.title,
  price: itemData.price,
  quantity: itemData.quantity ?? 1,
  remarks: itemData.remarks,
  purchaseStatus: 'None',
  source: 'spreadsheet',
  protectionLevel: 'none',
  ...(itemData.url ? { url: itemData.url } : {}),
});

const buildSharingMutableItemFields = (
  currentItem: ShoppingItem,
  updatedItem: ShoppingItem,
): SharingMutableItemFields => {
  const fields: SharingMutableItemFields = {};
  if (currentItem.price !== updatedItem.price) fields.price = updatedItem.price;
  if (currentItem.quantity !== updatedItem.quantity) fields.quantity = updatedItem.quantity;
  if (
    currentItem.purchaseStatus === updatedItem.purchaseStatus &&
    currentItem.limitedPurchasedQuantity !== updatedItem.limitedPurchasedQuantity
  ) {
    fields.actualPurchaseQuantity =
      updatedItem.purchaseStatus === 'LimitedPurchase'
        ? updatedItem.limitedPurchasedQuantity ?? null
        : null;
  }
  if (currentItem.remarks !== updatedItem.remarks) fields.remarks = updatedItem.remarks;
  if ((currentItem.url ?? undefined) !== (updatedItem.url ?? undefined)) {
    fields.url = updatedItem.url ?? null;
  }
  return fields;
};

const buildPurchaseExpectedClockFields = (
  fields: SharingMutableItemFields,
  status?: PurchaseStatus | null,
): string[] => {
  const fieldNames = Object.keys(fields);
  if (status) {
    fieldNames.push('purchaseStatus', 'actualPurchaseQuantity', 'securedBy');
  }
  return Array.from(new Set(fieldNames));
};

const pickExpectedFieldClocks = (
  session: SharingSessionMetadata,
  localItemId: string,
  fieldNames: string[],
): RoomItemFieldClocks | null => {
  return pickExpectedFieldClocksFrom(session.fieldClocksByItemId?.[localItemId], fieldNames);
};

const pickExpectedFieldClocksFrom = (
  itemClocks: RoomItemFieldClocks | undefined,
  fieldNames: string[],
): RoomItemFieldClocks | null => {
  if (!itemClocks) return null;

  const expectedFieldClocks: RoomItemFieldClocks = {};
  for (const fieldName of fieldNames) {
    const clock = itemClocks[fieldName];
    if (!clock) return null;
    expectedFieldClocks[fieldName] = clock;
  }
  return expectedFieldClocks;
};

const mergeFieldClocksFromChanges = (
  current: SharingSessionMetadata['fieldClocksByItemId'],
  changes: Parameters<typeof applyRoomItemChangesToItems>[1],
): SharingSessionMetadata['fieldClocksByItemId'] => {
  const next = { ...(current ?? {}) };
  for (const change of changes) {
    const clocks = change.item?.fieldClocks ?? change.fieldClocks;
    if (!clocks) continue;
    next[change.localItemId] = {
      ...(next[change.localItemId] ?? {}),
      ...clocks,
    };
  }
  return next;
};

const mergeDeletedItemClocksFromChanges = (
  current: SharingSessionMetadata['deletedItemClocks'],
  changes: Parameters<typeof applyRoomItemChangesToItems>[1],
): SharingSessionMetadata['deletedItemClocks'] => {
  let next = current;
  for (const change of changes) {
    if (change.changeType !== 'delete' || !change.fieldClocks) continue;
    const currentEntry = next?.[change.localItemId];
    const deletedAt =
      typeof change.updatedValues.deletedAt === 'string'
        ? change.updatedValues.deletedAt
        : currentEntry?.deletedAt ?? change.createdAt;
    const deletedBy =
      typeof change.updatedValues.deletedBy === 'string'
        ? change.updatedValues.deletedBy
        : currentEntry?.deletedBy ?? null;
    next = {
      ...(next ?? {}),
      [change.localItemId]: {
        deletedAt,
        deletedBy,
        fieldClocks: {
          ...(currentEntry?.fieldClocks ?? {}),
          ...change.fieldClocks,
        },
        itemVersion: change.itemsVersion,
        updatedAt: change.createdAt,
      },
    };
  }
  return next;
};

const getDeletedLocalItemIdsFromChanges = (
  changes: Parameters<typeof applyRoomItemChangesToItems>[1],
): string[] =>
  Array.from(
    new Set(
      changes
        .filter((change) => change.changeType === 'delete')
        .map((change) => change.localItemId),
    ),
  );

const resolvePendingItemSyncAck = (
  pending: SharingSessionMetadata['pendingItemSyncAck'],
  ackedItemsVersion: number,
): SharingSessionMetadata['pendingItemSyncAck'] =>
  pending && ackedItemsVersion >= pending.targetItemsVersion ? undefined : pending;

const isFullItemRefreshRequired = (code: string): boolean => code === 'FULL_ITEM_REFRESH_REQUIRED';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const sharingFieldLabels: Record<string, string> = {
  circle: 'サークル名',
  circleName: 'サークル名',
  circle_name: 'サークル名',
  block: 'ブロック',
  blockName: 'ブロック',
  block_name: 'ブロック',
  number: 'スペース番号',
  boothNumber: 'スペース番号',
  booth_number: 'スペース番号',
  name: 'タイトル',
  title: 'タイトル',
  eventDate: '参加日',
  event_date: '参加日',
  priorityLevel: '優先度',
  priority_level: '優先度',
  protectionLevel: '保護レベル',
  protection_level: '保護レベル',
  source: '登録元',
  manualHallId: '手動ホール',
  manual_hall_id: '手動ホール',
  price: '価格',
  quantity: '数量',
  remarks: '備考',
  url: 'URL',
  purchaseStatus: '購入状態',
  purchase_status: '購入状態',
  actualPurchaseQuantity: '実購入数',
  actual_purchase_quantity: '実購入数',
  securedBy: '購入確保',
  secured_by: '購入確保',
  assignedTo: '担当者',
  assigned_to: '担当者',
  deletedAt: '削除日時',
  deleted_at: '削除日時',
  deletedBy: '削除者',
  deleted_by: '削除者',
  postponed: '後回し',
  routeOrderByDate: '巡回順',
  route_order_by_date: '巡回順',
  orderIndex: '巡回順',
  order_index: '巡回順',
};

const formatSharingUpdatedFieldLabels = (fields: string[]): string => {
  const labels = fields.map((field) => sharingFieldLabels[field] ?? '更新項目');
  return Array.from(new Set(labels)).join('、');
};

const buildSharingNotificationMessage = (
  notification: RoomNotification,
  items: ShoppingItem[],
  currentRoomMemberId: string,
): string | null => {
  const payload = asRecord(notification.payload);
  if (payload.updatedByMemberId === currentRoomMemberId) return null;

  const localItemId = typeof payload.localItemId === 'string' ? payload.localItemId : null;
  const item = localItemId ? items.find((candidate) => candidate.id === localItemId) : null;
  const itemLabel = item ? `${item.block}-${item.number} ${item.circle}`.trim() : '共有アイテム';
  const updatedFields = Array.isArray(payload.updatedFields)
    ? payload.updatedFields.filter((field): field is string => typeof field === 'string')
    : [];
  const label = updatedFields.length > 0 ? formatSharingUpdatedFieldLabels(updatedFields) : '内容';

  if (notification.notificationType === 'item_claimed') {
    return `${itemLabel} が他の参加者によって購入済みに更新されました。`;
  }
  if (notification.notificationType === 'item_claim_failed') {
    return `${itemLabel} は他の参加者が先に購入確保しました。最新状態を同期します。`;
  }
  if (notification.notificationType === 'item_assigned') {
    return `${itemLabel} の担当者を同期しました。`;
  }
  if (notification.notificationType === 'item_created') {
    return `${itemLabel} が追加されました。`;
  }
  if (notification.notificationType === 'item_deleted') {
    return `${itemLabel} が削除されました。`;
  }
  if (notification.notificationType === 'route_order_updated') {
    const eventDate = typeof payload.eventDate === 'string' ? payload.eventDate : '対象日';
    return `${eventDate} の巡回順を同期しました。`;
  }
  return `${itemLabel} の${label}を同期しました。`;
};
const sortLabels: Record<SortState, string> = {
  Manual: '巡回順',
  Postpone: '後回し',
  Late: '遅参',
  Absent: '欠席',
  SoldOut: '売切',
  None: '未購入',
  Purchased: '購入済',
  LimitedPurchase: '\u9650\u6570',
};

const buildFocusSessionKey = (eventName: string, eventDate: string): string =>
  `${eventName}::${eventDate}`;

const removeFocusModeSessionByEvent = (
  sessions: Record<string, FocusModeSessionState>,
  eventName: string,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (key.startsWith(`${eventName}::`)) {
      changed = true;
      return;
    }
    next[key] = value;
  });

  return changed ? next : sessions;
};

const renameFocusModeSessionKeys = (
  sessions: Record<string, FocusModeSessionState>,
  oldEventName: string,
  newEventName: string,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (key.startsWith(`${oldEventName}::`)) {
      const suffix = key.slice(oldEventName.length);
      next[`${newEventName}${suffix}`] = value;
      changed = true;
    } else {
      next[key] = value;
    }
  });

  return changed ? next : sessions;
};

const areStringArraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
};

const isFocusModeSessionStateEqual = (
  a: FocusModeSessionState | undefined,
  b: FocusModeSessionState,
): boolean => {
  if (!a) return false;
  if (
    a.phase !== b.phase ||
    a.phaseIndex !== b.phaseIndex ||
    a.isCompleted !== b.isCompleted ||
    a.savedPhaseIndices.normal !== b.savedPhaseIndices.normal ||
    a.savedPhaseIndices.postponed !== b.savedPhaseIndices.postponed ||
    a.savedPhaseIndices.late !== b.savedPhaseIndices.late ||
    !areStringArraysEqual(a.postponedItemIds, b.postponedItemIds) ||
    !areStringArraysEqual(a.lateItemIds, b.lateItemIds)
  ) {
    return false;
  }

  const lpcA = a.lastPurchaseChangeAt ?? null;
  const lpcB = b.lastPurchaseChangeAt ?? null;
  if ((lpcA === null) !== (lpcB === null)) return false;
  if (
    lpcA &&
    lpcB &&
    (lpcA.phase !== lpcB.phase ||
      lpcA.phaseIndex !== lpcB.phaseIndex ||
      lpcA.visitKey !== lpcB.visitKey)
  ) {
    return false;
  }

  return true;
};

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const toHalfWidthDigits = (value: string): string =>
  value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

const normalizeMapDayToken = (value: string): string =>
  toHalfWidthDigits(value)
    .replace(/[ \u3000]/g, '')
    .replace(/マップ$/, '');

const resolveImportMapTabName = (mapName: string, eventDates: string[]): string | null => {
  const normalizedMapDay = normalizeMapDayToken(mapName);
  const matchedEventDate = eventDates.find(
    (eventDate) => normalizeMapDayToken(eventDate) === normalizedMapDay,
  );
  return matchedEventDate ? `${matchedEventDate}マップ` : null;
};

type RotationScreenType = 'mapTab' | 'focusMode';

const resolveDayMapRotationState = (
  state: { initialAngle?: number; mapTabAngle?: number; focusModeAngle?: number } | undefined,
) => {
  const initialAngle = normalizeRotationAngle(state?.initialAngle ?? 0);
  return {
    initialAngle,
    mapTabAngle: normalizeRotationAngle(state?.mapTabAngle ?? initialAngle),
    focusModeAngle: normalizeRotationAngle(state?.focusModeAngle ?? initialAngle),
  };
};

const App: React.FC = () => {
  const [eventLists, setEventLists] = useState<Record<string, ShoppingItem[]>>({});
  const [eventMetadata, setEventMetadata] = useState<Record<string, EventMetadata>>({});
  const [executeModeItems, setExecuteModeItems] = useState<Record<string, ExecuteModeItems>>({});
  const [memberRouteItems, setMemberRouteItems] = useState<Record<string, MemberRouteItems>>({});
  const executeModeItemsRef = useRef<Record<string, ExecuteModeItems>>({});
  const memberRouteItemsRef = useRef<Record<string, MemberRouteItems>>({});
  const commitExecuteModeItems = useCallback((nextAllEvents: Record<string, ExecuteModeItems>) => {
    executeModeItemsRef.current = nextAllEvents;
    setExecuteModeItems(nextAllEvents);
  }, []);
  const updateExecuteModeItems = useCallback(
    (
      updater: (
        current: Record<string, ExecuteModeItems>,
      ) => Record<string, ExecuteModeItems>,
    ) => {
      const nextAllEvents = updater(executeModeItemsRef.current);
      commitExecuteModeItems(nextAllEvents);
      return nextAllEvents;
    },
    [commitExecuteModeItems],
  );
  const setExecuteModeItemsCommitted = useCallback(
    (next: React.SetStateAction<Record<string, ExecuteModeItems>>) => {
      const nextAllEvents =
        typeof next === 'function'
          ? (next as (current: Record<string, ExecuteModeItems>) => Record<string, ExecuteModeItems>)(
              executeModeItemsRef.current,
            )
          : next;
      commitExecuteModeItems(nextAllEvents);
    },
    [commitExecuteModeItems],
  );
  const commitExecuteModeItemsForEvent = useCallback(
    (eventName: string, nextEventItems: ExecuteModeItems) => {
      commitExecuteModeItems({
        ...executeModeItemsRef.current,
        [eventName]: nextEventItems,
      });
    },
    [commitExecuteModeItems],
  );
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});

  useEffect(() => {
    memberRouteItemsRef.current = memberRouteItems;
  }, [memberRouteItems]);

  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('eventList');
  const [mapViewActive, setMapViewActive] = useState(false);
  const mapToggleLongPressRef = React.useRef<number | null>(null);
  const mapToggleLongPressFiredRef = React.useRef(false);
  const mapToggleButtonRef = React.useRef<HTMLButtonElement>(null);
  const mapToggleMenuRef = React.useRef<HTMLDivElement>(null);
  const [sortState, setSortState] = useState<SortState>('Manual');
  const [blockSortDirection, setBlockSortDirection] = useState<BlockSortDirection | null>(null);
  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [editDialogItem, setEditDialogItem] = useState<ShoppingItem | null>(null);
  const [editFieldClockBaselineByItemId, setEditFieldClockBaselineByItemId] = useState<
    Record<string, RoomItemFieldClocks>
  >({});
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<Set<string>>(new Set());
  const {
    selectedItemIds,
    setSelectedItemIds,
    selectedBlockFilters,
    setSelectedBlockFilters,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    spaceGroupingEnabled,
    setSpaceGroupingEnabled,
    collapsedSpaces,
    setCollapsedSpaces,
    executeSpaceGroupingEnabled,
    setExecuteSpaceGroupingEnabled,
    executeCollapsedSpaces,
    setExecuteCollapsedSpaces,
    clearSelection,
    clearBlockFilters,
    toggleBlockFilter,
    toggleCollapsedSpace,
    toggleExecuteCollapsedSpace,
    selectItemForRange,
    selectSpaceGroupForRange,
    toggleCurrentRangeSelection,
  } = useListInteractionState();

  const [newItemDefaults, setNewItemDefaults] = useState<{
    eventDate: string;
    block: string;
    number: string;
  } | null>(null);

  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [updateData, setUpdateData] = useState<EventUpdateDiff | null>(null);
  const [updateEventName, setUpdateEventName] = useState<string | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);

  const [searchKeyword, setSearchKeyword] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  const [layoutMode, setLayoutMode] = useState<'pc' | 'smartphone'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'smartphone' : 'pc',
  );
  const { uiVisibilitySettings, setUiVisibilitySettings } = useUIVisibilitySettings();
  const { numberCellOutlineStyle, setNumberCellOutlineStyle, DEFAULT_OUTLINE_STYLE } = useNumberCellOutlineStyle();
  const { disablePriceUndefinedCheck, setDisablePriceUndefinedCheck } = useDisablePriceUndefinedCheck();
  const {
    disableLimitedPurchaseQuantityCheck,
    setDisableLimitedPurchaseQuantityCheck,
  } = useDisableLimitedPurchaseQuantityCheck();
  const {
    purchaseStatusControlMode,
    setPurchaseStatusControlMode,
    DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  } = usePurchaseStatusControlMode();
  const {
    skipLimitedPurchaseForSingleQuantity,
    setSkipLimitedPurchaseForSingleQuantity,
  } = useSkipLimitedPurchaseForSingleQuantity();
  const [uiVisibilityOverride, setUiVisibilityOverride] = useState(false);
  const [uiSettingsPanelOpen, setUiSettingsPanelOpen] = useState(false);
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);
  const [focusModeSessions, setFocusModeSessions] = useState<Record<string, FocusModeSessionState>>(
    {},
  );

  const { themeMode, setThemeMode } = useThemeMode();

  const [mapData, setMapData] = useState<MapDataStore>({});
  const [mapRotationSettings, setMapRotationSettings] = useState<MapRotationSettingsStore>({});
  const [mapViewportSettings, setMapViewportSettings] = useState<MapViewportSettingsStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});
  const [simpleHallDefinitionMode, setSimpleHallDefinitionMode] = useState(false);
  const [globalHallOrderPanelOpen, setGlobalHallOrderPanelOpen] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);

  const [mapImportDialogOpen, setMapImportDialogOpen] = useState(false);
  const [mapImportPendingFile, setMapImportPendingFile] = useState<File | null>(null);
  const [mapImportPendingEventName, setMapImportPendingEventName] = useState<string>('');
  const { isInitialized } = useIndexedDbPersistence({
    values: {
      eventLists,
      eventMetadata,
      executeModeItems,
      memberRouteItems,
      dayModes,
      mapData,
      mapRotationSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      mapViewportSettings,
    },
    setters: {
      setEventLists,
      setEventMetadata,
      setExecuteModeItems: setExecuteModeItemsCommitted,
      setMemberRouteItems,
      setDayModes,
      setMapData,
      setMapRotationSettings,
      setRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
      setMapViewportSettings,
    },
  });

  const [sharingSessions, setSharingSessions] = useState<Record<string, SharingSessionMetadata>>({});
  const [sharingBusy, setSharingBusy] = useState(false);
  const [sharingStatusMessage, setSharingStatusMessage] = useState<string | null>(null);
  const [sharingErrorMessage, setSharingErrorMessage] = useState<string | null>(null);
  const [sharingNotificationList, setSharingNotificationList] = useState<NotificationListItem[]>([]);
  const [sharingAssignedOnly, setSharingAssignedOnly] = useState(false);
  const [currentRouteScopeByDate, setCurrentRouteScopeByDate] = useState<Record<string, RouteScope>>({});
  const [selectedRouteMemberIdByDate, setSelectedRouteMemberIdByDate] = useState<Record<string, string>>({});
  const [candidateFilterByDate, setCandidateFilterByDate] = useState<
    Record<string, MemberRouteCandidateFilter>
  >({});
  const [mapRouteDisplayModeByDate, setMapRouteDisplayModeByDate] = useState<
    Record<string, MapRouteDisplayMode>
  >({});
  const [initialJoinRoomCode, setInitialJoinRoomCode] = useState<string | null>(null);
  const [sharingPanelMode, setSharingPanelMode] = useState<SharingPanelMode | null>(null);
  const [sharingPanelEventName, setSharingPanelEventName] = useState<string | null>(null);
  const sharingSessionsRef = useRef<Record<string, SharingSessionMetadata>>({});
  const eventListsRef = useRef<Record<string, ShoppingItem[]>>({});
  const sharingSyncInFlightRef = useRef(false);
  const sharingSyncPendingRef = useRef(false);

  useEffect(() => {
    sharingSessionsRef.current = sharingSessions;
  }, [sharingSessions]);

  useEffect(() => {
    eventListsRef.current = eventLists;
  }, [eventLists]);

  const buildSharingAppState = useCallback(
    (): SharingAppState => ({
      eventLists,
      eventMetadata,
      executeModeItems,
      memberRouteItems,
      dayModes,
      mapData,
      mapRotationSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      mapViewportSettings,
    }),
    [
      eventLists,
      eventMetadata,
      executeModeItems,
      memberRouteItems,
      dayModes,
      mapData,
      mapRotationSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      mapViewportSettings,
    ],
  );

  const applySharingAppData = useCallback(
    (appData: AppData) => {
      setEventLists(appData.eventLists as Record<string, ShoppingItem[]>);
      setEventMetadata(appData.eventMetadata as Record<string, EventMetadata>);
      commitExecuteModeItems(appData.executeModeItems as Record<string, ExecuteModeItems>);
      setMemberRouteItems(appData.memberRouteItems as Record<string, MemberRouteItems>);
      setDayModes(appData.dayModes as Record<string, DayModeState>);
      setMapData(appData.mapData as MapDataStore);
      setMapRotationSettings(appData.mapRotationSettings as MapRotationSettingsStore);
      setRouteSettings(appData.routeSettings as RouteSettingsStore);
      setHallDefinitions(appData.hallDefinitions as HallDefinitionsStore);
      setHallRouteSettings(appData.hallRouteSettings as HallRouteSettingsStore);
      setMapViewportSettings(appData.mapViewportSettings as MapViewportSettingsStore);
    },
    [commitExecuteModeItems],
  );

  const refreshSharingSessions = useCallback(async () => {
    const sessions = await db.getAllData<SharingSessionMetadata>(db.STORES.SHARING_SESSIONS);
    setSharingSessions(sessions);
    return sessions;
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    void refreshSharingSessions();
  }, [isInitialized, refreshSharingSessions]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const match = window.location.pathname.match(/^\/join\/([^/?#]+)$/i);
    if (!match) return;

    setInitialJoinRoomCode(decodeURIComponent(match[1]).trim().toUpperCase());
    setSharingPanelMode('join');
    setSharingPanelEventName(null);
    setActiveTab('eventList');
    setSharingStatusMessage('参加URLを読み取りました。表示名を確認して参加してください。');
  }, []);

  const activeSharingSession = useMemo(
    () => findActiveSharingSessionForEvent(sharingSessions, activeEventName),
    [sharingSessions, activeEventName],
  );

  const activeSharingAssignmentMembers = useMemo(
    () => activeSharingSession?.memberProfileSnapshot ?? EMPTY_ASSIGNMENT_MEMBERS,
    [activeSharingSession?.memberProfileSnapshot],
  );
  const activeSharingNotificationEntries = useMemo(
    () =>
      activeSharingSession
        ? sharingNotificationList.map((notification) => ({
            notification,
            message:
              buildSharingNotificationMessage(
                notification,
                eventLists[activeSharingSession.eventName] ?? [],
                activeSharingSession.roomMemberId,
              ) ?? `${notification.notificationType} を受信しました。`,
          }))
        : [],
    [activeSharingSession, eventLists, sharingNotificationList],
  );
  const activeSharingAssignedOnlyMemberId =
    activeSharingSession && sharingAssignedOnly ? activeSharingSession.roomMemberId : null;
  const filterAssignedOnlyItems = useCallback(
    (sourceItems: ShoppingItem[]): ShoppingItem[] =>
      activeSharingAssignedOnlyMemberId
        ? sourceItems.filter((item) => item.assignedTo === activeSharingAssignedOnlyMemberId)
        : sourceItems,
    [activeSharingAssignedOnlyMemberId],
  );
  const canAssignSharingItem = useCallback(
    (_item: ShoppingItem): boolean => !!activeSharingSession,
    [activeSharingSession],
  );

  const isEventSharingLocked = useCallback(
    (eventName: string | null | undefined): boolean =>
      !!findActiveSharingSessionForEvent(sharingSessions, eventName),
    [sharingSessions],
  );

  const hasSharingSessionForEvent = useCallback(
    (eventName: string | null | undefined): boolean =>
      !!eventName &&
      Object.values(sharingSessions).some(
        (session) => session.eventName === eventName && session.status !== 'localizing',
      ),
    [sharingSessions],
  );

  const hasAnyActiveSharingSession = useMemo(
    () => Object.values(sharingSessions).some((session) => isSharingSessionOperational(session)),
    [sharingSessions],
  );

  const guardSharingStructureMutation = useCallback(
    (eventName: string | null | undefined): boolean => {
      if (!isEventSharingLocked(eventName)) return false;
      alert(SHARING_STRUCTURE_LOCK_MESSAGE);
      return true;
    },
    [isEventSharingLocked],
  );

  const sharingEventNames = useMemo(
    () =>
      Object.keys(eventLists).sort((a, b) =>
        a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' }),
      ),
    [eventLists],
  );
  const sharingAvailability = useMemo(() => getSharingAvailability(), []);

  const applySnapshotAndAck = useCallback(
    async (roomId: string, roomCode?: string) => {
      const rememberedRoomCode =
        roomCode ??
        sharingSessionsRef.current[roomId]?.roomCode ??
        Object.values(sharingSessionsRef.current).find((session) => session.roomId === roomId)
          ?.roomCode;
      const snapshotEnvelope = await getRoomSnapshot(roomId);
      if (!snapshotEnvelope.ok) {
        const sessionToStop = Object.values(sharingSessionsRef.current).find(
          (session) => session.roomId === roomId && isSharingSessionActive(session),
        );
        if (sessionToStop && isFullItemRefreshRequired(snapshotEnvelope.error.code)) {
          const localizedSession = buildLocalizedSharingSessionForSyncUpgrade(sessionToStop);
          await db.saveSharingSession(localizedSession);
          setSharingSessions((prev) => ({
            ...prev,
            [localizedSession.sessionId]: localizedSession,
          }));
          setSharingStatusMessage(
            `${sessionToStop.eventName} の共有同期を停止し、ローカルデータとして保持しました。`,
          );
          setSharingErrorMessage(SHARING_SYNC_UNUSABLE_MESSAGE);
          return;
        }
        setSharingErrorMessage(`snapshotの取得に失敗しました: ${snapshotEnvelope.error.code}`);
        return;
      }

      const currentAppData = buildCurrentSharingAppData(buildSharingAppState());
      const ack = await commitSnapshotThenAck(snapshotEnvelope.data, currentAppData);
      const nextAppData = roomSnapshotToAppData(snapshotEnvelope.data, currentAppData);
      applySharingAppData(nextAppData);
      const refreshedSessions = await refreshSharingSessions();

      if (rememberedRoomCode) {
        const sessionWithRoomCode = Object.values(refreshedSessions).find(
          (session) => session.roomId === roomId,
        );
        if (sessionWithRoomCode) {
          const nextSession: SharingSessionMetadata = {
            ...sessionWithRoomCode,
            roomCode: rememberedRoomCode,
          };
          await db.saveSharingSession(nextSession);
          setSharingSessions((prev) => ({
            ...prev,
            [nextSession.sessionId]: nextSession,
          }));
        }
      }

      const eventName = snapshotEnvelope.data.room.eventName;
      setActiveEventName(eventName);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());

      const nextTab = resolveEventListTab(nextAppData.eventLists[eventName] as ShoppingItem[]);
      setActiveTab(nextTab ?? 'eventList');

      if (!ack.ok) {
        setSharingErrorMessage(`snapshotの保存後ackに失敗しました: ${ack.error.code}`);
        return;
      }
      setSharingErrorMessage(null);
    },
    [
      applySharingAppData,
      buildSharingAppState,
      refreshSharingSessions,
      setSelectedBlockFilters,
      setSelectedItemIds,
    ],
  );

  const saveSharingSessionState = useCallback(async (session: SharingSessionMetadata) => {
    await db.saveSharingSession(session);
    setSharingSessions((prev) => {
      const next = {
        ...prev,
        [session.sessionId]: session,
      };
      sharingSessionsRef.current = next;
      return next;
    });
  }, []);

  const deleteSharingSessionsForEvent = useCallback(
    async (eventName: string) => {
      const sessionsToDelete = Object.values(sharingSessionsRef.current).filter(
        (session) => session.eventName === eventName,
      );
      if (sessionsToDelete.length === 0) return;

      await Promise.all(
        sessionsToDelete.map(async (session) => {
          await db.deleteSharingSession(session.sessionId);
          forgetMemberKey(session.roomId);
        }),
      );

      setSharingSessions((prev) => {
        const next = { ...prev };
        sessionsToDelete.forEach((session) => {
          delete next[session.sessionId];
        });
        sharingSessionsRef.current = next;
        return next;
      });
    },
    [],
  );

  const localizeSharingSessionForSyncUpgrade = useCallback(
    async (session: SharingSessionMetadata) => {
      const localizedSession = buildLocalizedSharingSessionForSyncUpgrade(session);
      await saveSharingSessionState(localizedSession);
      setSharingStatusMessage(
        `${session.eventName} の共有同期を停止し、ローカルデータとして保持しました。`,
      );
      setSharingErrorMessage(SHARING_SYNC_UPGRADE_REQUIRED_MESSAGE);
    },
    [saveSharingSessionState],
  );

  const expireSharingSession = useCallback(
    async (session: SharingSessionMetadata) => {
      const expiredSession: SharingSessionMetadata = {
        ...session,
        status: 'expired',
      };
      await saveSharingSessionState(expiredSession);
      setSharingStatusMessage(`${session.eventName} の共有期限が切れました。`);
    },
    [saveSharingSessionState],
  );

  const cleanupDeletedSharedItemsFromUiState = useCallback(
    (eventName: string, deletedItemIds: string[]) => {
      if (deletedItemIds.length === 0) return;
      const deletedIds = new Set(deletedItemIds);

      updateExecuteModeItems((prev) => {
        const eventItems = prev[eventName];
        if (!eventItems) return prev;
        return {
          ...prev,
          [eventName]: removeDeletedIdsFromExecuteModeItems(eventItems, deletedIds),
        };
      });

      setMemberRouteItems((prev) => {
        const eventItems = prev[eventName];
        if (!eventItems) return prev;
        return {
          ...prev,
          [eventName]: removeDeletedIdsFromMemberRouteItems(eventItems, deletedIds),
        };
      });

      setSelectedItemIds((prev) => {
        if (![...deletedIds].some((itemId) => prev.has(itemId))) return prev;
        return new Set([...prev].filter((itemId) => !deletedIds.has(itemId)));
      });
      setRecentlyChangedItemIds((prev) => {
        if (![...deletedIds].some((itemId) => prev.has(itemId))) return prev;
        return new Set([...prev].filter((itemId) => !deletedIds.has(itemId)));
      });
      setItemToEdit((item) => (item && deletedIds.has(item.id) ? null : item));
      setEditDialogItem((item) => (item && deletedIds.has(item.id) ? null : item));
      setEditFieldClockBaselineByItemId((prev) => {
        if (![...deletedIds].some((itemId) => itemId in prev)) return prev;
        return Object.fromEntries(
          Object.entries(prev).filter(([itemId]) => !deletedIds.has(itemId)),
        );
      });
      setItemToDelete((item) => (item && deletedIds.has(item.id) ? null : item));
      setHighlightedItemId((itemId) => (itemId && deletedIds.has(itemId) ? null : itemId));
    },
    [setSelectedItemIds, updateExecuteModeItems],
  );

  const synchronizeSharingSession = useCallback(
    async (sessionId: string, reason: 'initial' | 'realtime' | 'queued' | 'manual' = 'manual') => {
      const startSession = sharingSessionsRef.current[sessionId];
      if (!startSession || !isSharingSessionActive(startSession)) return;
      if (!isSharingSessionSyncMetadataCompatible(startSession)) {
        await localizeSharingSessionForSyncUpgrade(startSession);
        return;
      }

      if (sharingSyncInFlightRef.current) {
        sharingSyncPendingRef.current = true;
        return;
      }

      sharingSyncInFlightRef.current = true;
      try {
        let session = sharingSessionsRef.current[sessionId] ?? startSession;
        const versions = await getRoomVersions(session.roomId);
        if (!versions.ok) {
          if (versions.error.code === 'ROOM_EXPIRED') {
            await expireSharingSession(session);
          } else if (isSharingSyncUpgradeRequiredErrorCode(versions.error.code)) {
            await localizeSharingSessionForSyncUpgrade(session);
          } else if (reason !== 'realtime') {
            setSharingErrorMessage(`共有同期の確認に失敗しました: ${versions.error.code}`);
          }
          return;
        }

        if (!versions.data.isActive) {
          await expireSharingSession(session);
          return;
        }

        let nextItemsVersion = session.itemsVersion;
        let nextRouteOrderVersions = { ...(session.routeOrderVersions ?? {}) };
        let nextMemberRouteOrderVersions = { ...(session.memberRouteOrderVersions ?? {}) };
        let nextPendingRouteOrderAcks = session.pendingRouteOrderAcks;
        let nextFieldClocksByItemId = session.fieldClocksByItemId;
        let nextDeletedItemClocks = session.deletedItemClocks;
        let nextPendingItemSyncAck = session.pendingItemSyncAck;
        let nextEventItems = eventListsRef.current[session.eventName] ?? [];
        if (versions.data.itemsVersion > session.itemsVersion) {
          const changes = await getRoomItemChangesSince(session.roomId, session.itemsVersion);
          if (!changes.ok) {
            if (
              changes.error.code === 'ITEM_DIFF_EXPIRED' ||
              changes.error.code === 'FULL_ITEM_REFRESH_REQUIRED'
            ) {
              await applySnapshotAndAck(session.roomId);
            } else {
              setSharingErrorMessage(`共有差分の取得に失敗しました: ${changes.error.code}`);
            }
            return;
          }

          const changedItemIds = new Set(
            changes.data.changes
              .filter((change) =>
                change.updatedFields.some((field) =>
                  ['purchaseStatus', 'actualPurchaseQuantity', 'quantity', 'assignedTo'].includes(field),
                ),
              )
              .map((change) => change.localItemId),
          );

          if (changes.data.changes.length > 0) {
            const deletedItemIds = getDeletedLocalItemIdsFromChanges(changes.data.changes);
            nextEventItems = applyRoomItemChangesToItems(
              eventListsRef.current[session.eventName] ?? [],
              changes.data.changes,
            );
            setEventLists((prev) => ({
              ...prev,
              [session.eventName]: applyRoomItemChangesToItems(
                prev[session.eventName] ?? [],
                changes.data.changes,
              ),
            }));
            cleanupDeletedSharedItemsFromUiState(session.eventName, deletedItemIds);
            nextFieldClocksByItemId = mergeFieldClocksFromChanges(
              nextFieldClocksByItemId,
              changes.data.changes,
            );
            nextDeletedItemClocks = mergeDeletedItemClocksFromChanges(
              nextDeletedItemClocks,
              changes.data.changes,
            );
          }

          if (changedItemIds.size > 0) {
            setRecentlyChangedItemIds((prevIds) => {
              const next = new Set(prevIds);
              changedItemIds.forEach((itemId) => next.add(itemId));
              return next;
            });
          }

          nextItemsVersion = changes.data.itemsVersion;
        }

        const serverRouteOrderVersions = versions.data.routeOrderVersions ?? {};
        if (versions.data.routeOrderVersion !== null) {
          const eventRouteOrders = executeModeItemsRef.current[session.eventName] ?? {};
          if (
            hasVisibleRouteItemsOutsideServerRouteVersions(
              eventRouteOrders,
              serverRouteOrderVersions,
            )
          ) {
            await applySnapshotAndAck(session.roomId);
            return;
          }

          nextRouteOrderVersions = { ...serverRouteOrderVersions };
          const nextEventRouteOrders = removeRouteOrdersOutsideServerRouteVersions(
            eventRouteOrders,
            serverRouteOrderVersions,
          );
          const removedLocalRouteOrderDate =
            Object.keys(nextEventRouteOrders).length !== Object.keys(eventRouteOrders).length;
          const changedRouteDates = Object.keys(serverRouteOrderVersions).filter(
            (eventDate) =>
              (serverRouteOrderVersions[eventDate] ?? 0) !==
              ((session.routeOrderVersions ?? {})[eventDate] ?? 0),
          );

          if (changedRouteDates.length > 0 || removedLocalRouteOrderDate) {
            const changedRouteOrders: CanonicalRouteOrder[] = [];
            for (const eventDate of changedRouteDates) {
              const route = await getRouteOrderByDate(session.roomId, eventDate);
              if (!route.ok) {
                if (route.error.code === 'ROOM_EXPIRED') {
                  await expireSharingSession(session);
                  return;
                }
                if (isSharingSyncUpgradeRequiredErrorCode(route.error.code)) {
                  await localizeSharingSessionForSyncUpgrade(session);
                  return;
                }
                if (reason !== 'realtime') {
                  setSharingErrorMessage(`巡回順の取得に失敗しました: ${route.error.code}`);
                }
                return;
              }

              nextEventRouteOrders[eventDate] = route.data.itemIds;
              changedRouteOrders.push({
                eventDate,
                itemIds: route.data.itemIds,
              });
              nextRouteOrderVersions = {
                ...nextRouteOrderVersions,
                [eventDate]: route.data.dateRouteOrderVersion,
              };
            }

            if (routeOrdersReferenceMissingItems(nextEventItems, changedRouteOrders)) {
              await applySnapshotAndAck(session.roomId);
              return;
            }

            updateExecuteModeItems((prev) => ({
              ...prev,
              [session.eventName]: nextEventRouteOrders,
            }));
            setEventLists((prev) => {
              const items = prev[session.eventName] ?? [];
              const nextItems = applyCanonicalRouteOrdersToItems(items, changedRouteOrders);
              return nextItems === items
                ? prev
                : {
                    ...prev,
                    [session.eventName]: nextItems,
                  };
            });

            const routeAck = await ackRoomRouteOrderVersions(
              session.roomId,
              nextRouteOrderVersions,
            );
            if (routeAck.ok) {
              nextRouteOrderVersions = routeAck.data.routeOrderVersions;
              nextPendingRouteOrderAcks = clearSatisfiedRouteOrderAcks(
                nextPendingRouteOrderAcks,
                routeAck.data.routeOrderVersions,
                new Date().toISOString(),
              );
            } else if (reason !== 'realtime') {
              setSharingErrorMessage(`巡回順の同期ackに失敗しました: ${routeAck.error.code}`);
            }
          }
        }

        const serverMemberRouteOrderVersions = versions.data.memberRouteOrderVersions ?? {};
        const changedMemberRouteKeys = getChangedMemberRouteVersionKeys(
          serverMemberRouteOrderVersions,
          session.memberRouteOrderVersions,
        );
        if (changedMemberRouteKeys.length > 0) {
          const changedMemberRouteOrders: Array<{
            eventDate: string;
            roomMemberId: string;
            itemIds: string[];
          }> = [];
          for (const routeKey of changedMemberRouteKeys) {
            const route = await getMemberRouteOrderByDate(
              session.roomId,
              routeKey.eventDate,
              routeKey.roomMemberId,
            );
            if (!route.ok) {
              if (route.error.code === 'ROOM_EXPIRED') {
                await expireSharingSession(session);
                return;
              }
              if (isSharingSyncUpgradeRequiredErrorCode(route.error.code)) {
                await localizeSharingSessionForSyncUpgrade(session);
                return;
              }
              if (reason !== 'realtime') {
                setSharingErrorMessage(`個人ルートの取得に失敗しました: ${route.error.code}`);
              }
              return;
            }

            changedMemberRouteOrders.push({
              eventDate: route.data.eventDate,
              roomMemberId: route.data.routeMemberId,
              itemIds: route.data.itemIds,
            });
            nextMemberRouteOrderVersions = route.data.memberRouteOrderVersions;
          }

          setMemberRouteItems((prev) => ({
            ...prev,
            [session.eventName]: applyCanonicalMemberRouteOrders(
              prev[session.eventName] ?? {},
              changedMemberRouteOrders,
            ),
          }));

          const memberRouteAck = await ackRoomMemberRouteOrderVersions(
            session.roomId,
            serverMemberRouteOrderVersions,
          );
          if (memberRouteAck.ok) {
            nextMemberRouteOrderVersions = memberRouteAck.data.memberRouteOrderVersions;
            session = sharingSessionsRef.current[sessionId] ?? session;
          } else if (reason !== 'realtime') {
            setSharingErrorMessage(`個人ルートの同期ackに失敗しました: ${memberRouteAck.error.code}`);
          }
        }

        if (nextPendingRouteOrderAcks && Object.keys(nextPendingRouteOrderAcks).length > 0) {
          nextPendingRouteOrderAcks = markPendingRouteOrderAckAttempt(
            nextPendingRouteOrderAcks,
            new Date().toISOString(),
          );
          const routeAck = await ackRoomRouteOrderVersions(session.roomId, nextRouteOrderVersions);
          if (routeAck.ok) {
            nextRouteOrderVersions = routeAck.data.routeOrderVersions;
            nextPendingRouteOrderAcks = clearSatisfiedRouteOrderAcks(
              nextPendingRouteOrderAcks,
              routeAck.data.routeOrderVersions,
              new Date().toISOString(),
            );
          } else if (reason !== 'realtime') {
            setSharingErrorMessage(`巡回順の同期ackに失敗しました: ${routeAck.error.code}`);
          }
        }

        let lastProcessedEventCreatedAt = session.lastProcessedEventCreatedAt ?? null;
        let lastProcessedEventId = session.lastProcessedEventId ?? null;
        const processedEventIds: ProcessedSyncEvent[] = [];
        const notifications = await getAllNotificationsAfterWatermark(
          session.roomId,
          lastProcessedEventCreatedAt,
          lastProcessedEventId,
        );

        if (notifications.ok) {
          const delivered = notifications.data.events ?? notifications.data.notifications;
          const processedAt = new Date().toISOString();
          processedEventIds.push(
            ...delivered.map((notification) => ({
              event_id: notification.eventId,
              processed_at: processedAt,
            })),
          );
          const latest = delivered[delivered.length - 1];
          if (latest) {
            lastProcessedEventCreatedAt =
              notifications.data.nextWatermarkCreatedAt ?? latest.createdAt;
            lastProcessedEventId = notifications.data.nextWatermarkId ?? latest.id;

            const message = delivered
              .map((notification) =>
                buildSharingNotificationMessage(
                  notification,
                  eventListsRef.current[session.eventName] ?? [],
                  session.roomMemberId,
                ),
              )
              .filter((value): value is string => value !== null)
              .at(-1);
            if (message) {
              setSharingStatusMessage(message);
            } else if (reason === 'initial' && nextItemsVersion > session.itemsVersion) {
              setSharingStatusMessage('共有の最新状態を同期しました。');
            }
          }
        } else if (notifications.error.code === 'FULL_NOTIFICATION_REFRESH_REQUIRED') {
          lastProcessedEventCreatedAt = null;
          lastProcessedEventId = null;
        } else if (reason !== 'realtime') {
          setSharingErrorMessage(`共有通知の取得に失敗しました: ${notifications.error.code}`);
        }

        if (nextPendingItemSyncAck) {
          nextPendingItemSyncAck = markPendingItemSyncAckAttempt(
            nextPendingItemSyncAck,
            new Date().toISOString(),
          );
        }

        const ack = await ackRoomSyncProgress(
          session.roomId,
          nextItemsVersion,
          lastProcessedEventCreatedAt,
          lastProcessedEventId,
          processedEventIds,
        );
        session = sharingSessionsRef.current[sessionId] ?? session;
        if (ack.ok) {
          nextPendingItemSyncAck = resolvePendingItemSyncAck(
            nextPendingItemSyncAck,
            ack.data.itemsVersion,
          );
        }
        const updatedSession: SharingSessionMetadata = {
          ...session,
          itemsVersion: ack.ok ? ack.data.itemsVersion : nextItemsVersion,
          routeOrderVersions: nextRouteOrderVersions,
          memberRouteOrderVersions: nextMemberRouteOrderVersions,
          fieldClocksByItemId: nextFieldClocksByItemId,
          deletedItemClocks: nextDeletedItemClocks,
          pendingItemSyncAck: nextPendingItemSyncAck,
          pendingRouteOrderAcks: nextPendingRouteOrderAcks,
          lastProcessedEventCreatedAt: ack.ok
            ? ack.data.lastProcessedEventCreatedAt
            : lastProcessedEventCreatedAt,
          lastProcessedEventId: ack.ok ? ack.data.lastProcessedEventId : lastProcessedEventId,
          lastAckAt: new Date().toISOString(),
        };
        await saveSharingSessionState(updatedSession);

        if (!ack.ok && reason !== 'realtime') {
          setSharingErrorMessage(`共有同期ackに失敗しました: ${ack.error.code}`);
        } else if (ack.ok) {
          setSharingErrorMessage(null);
        }
      } catch (error) {
        console.error('Sharing sync error:', error);
        if (reason !== 'realtime') {
          setSharingErrorMessage('共有同期に失敗しました。通信状態を確認してください。');
        }
      } finally {
        sharingSyncInFlightRef.current = false;
        if (sharingSyncPendingRef.current) {
          sharingSyncPendingRef.current = false;
          window.setTimeout(() => {
            void synchronizeSharingSession(sessionId, 'queued');
          }, 0);
        }
      }
    },
    [
      applySnapshotAndAck,
      cleanupDeletedSharedItemsFromUiState,
      expireSharingSession,
      localizeSharingSessionForSyncUpgrade,
      saveSharingSessionState,
      updateExecuteModeItems,
    ],
  );

  const handleCreateSharingRoom = useCallback(
    async (eventName: string, displayName: string) => {
      if (!eventName) return;
      const existingSharingSession = findActiveSharingSessionForEvent(sharingSessions, eventName);
      if (existingSharingSession) {
        const shouldLocalize = window.confirm(
          `「${eventName}」には以前の共有セッションが残っています。` +
            'その共有同期を停止してローカルデータとして保持し、新しい共有ルームを作成しますか？',
        );
        if (!shouldLocalize) return;
      }

      setSharingBusy(true);
      setSharingStatusMessage('共有ルームを作成しています。');
      setSharingErrorMessage(null);
      try {
        if (existingSharingSession) {
          const localizedSession = buildLocalizedSharingSessionForSyncUpgrade(existingSharingSession);
          await saveSharingSessionState(localizedSession);
          forgetMemberKey(existingSharingSession.roomId);
          setSharingAssignedOnly(false);
        }

        const sharingState = buildSharingAppState();
        const repairResult = repairDuplicateSharingItemIdsForEvent({
          ...sharingState,
          eventName,
        });
        if (repairResult.repaired) {
          setEventLists(repairResult.state.eventLists);
          eventListsRef.current = repairResult.state.eventLists;
          updateExecuteModeItems(() => repairResult.state.executeModeItems);
          setMemberRouteItems(repairResult.state.memberRouteItems);
          memberRouteItemsRef.current = repairResult.state.memberRouteItems;
          setSharingStatusMessage('重複IDを修復しました。共有ルームを作成しています。');
        }

        const roomId = createClientRoomId();
        const memberKey = generateMemberKey();
        const payload = buildRoomEventPayloadForEvent(repairResult.state);
        const created = await createSharingRoom({
          roomId,
          displayName: displayName.trim() || '主催',
          rawRoomEventDataJson: payload.rawJson,
          itemCount: payload.itemCount,
          memberKey,
        });
        if (!created.ok) {
          setSharingErrorMessage(`共有ルームの作成に失敗しました: ${created.error.code}`);
          return;
        }

        await applySnapshotAndAck(created.data.roomId, created.data.roomCode);
        setSharingPanelEventName(eventName);
        setSharingPanelMode('invite');
        setSharingStatusMessage(
          repairResult.repaired
            ? '重複IDを修復しました。共有ルームを作成しました。参加URLとQRコードを表示しています。'
            : '共有ルームを作成しました。参加URLとQRコードを表示しています。',
        );
      } catch (error) {
        console.error('Sharing create error:', error);
        setSharingErrorMessage('共有ルームの作成に失敗しました。設定または通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [
      applySnapshotAndAck,
      buildSharingAppState,
      saveSharingSessionState,
      sharingSessions,
      updateExecuteModeItems,
    ],
  );

  const handleJoinSharingRoom = useCallback(
    async (roomCode: string, displayName: string) => {
      const normalizedRoomCode = roomCode.trim().toUpperCase();
      setSharingBusy(true);
      setSharingStatusMessage('共有ルームへ参加しています。');
      setSharingErrorMessage(null);
      try {
        const prepared = await prepareJoinRoom(normalizedRoomCode);
        if (!prepared.ok) {
          setSharingErrorMessage(`共有ルームの参加準備に失敗しました: ${prepared.error.code}`);
          return;
        }

        const memberKey = generateMemberKey();
        const joined = await joinPreparedRoom(
          prepared.data,
          displayName.trim() || '参加者',
          memberKey,
        );
        if (!joined.ok) {
          setSharingErrorMessage(`共有ルームへの参加に失敗しました: ${joined.error.code}`);
          return;
        }

        await applySnapshotAndAck(joined.data.roomId, normalizedRoomCode);
        setInitialJoinRoomCode(null);
        setSharingPanelMode(null);
        setSharingPanelEventName(null);
        setSharingStatusMessage('共有ルームへ参加しました。');
      } catch (error) {
        console.error('Sharing join error:', error);
        setSharingErrorMessage('共有ルームへの参加に失敗しました。設定または通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [applySnapshotAndAck],
  );

  const handleCreateSharingRoomFromMenu = useCallback(
    (eventName: string) => {
      const displayName = window.prompt('共有で使う表示名を入力してください。', '主催');
      if (displayName === null) return;
      void handleCreateSharingRoom(eventName, displayName);
    },
    [handleCreateSharingRoom],
  );

  const handleOpenSharingJoinPanel = useCallback(() => {
    setSharingPanelMode('join');
    setSharingPanelEventName(null);
  }, []);

  const handleOpenSharingInvitePanel = useCallback((eventName: string) => {
    setSharingPanelMode('invite');
    setSharingPanelEventName(eventName);
  }, []);

  const handleOpenSharingStatusPanel = useCallback((eventName: string) => {
    setSharingPanelMode('status');
    setSharingPanelEventName(eventName);
  }, []);

  const handleCloseSharingPanel = useCallback(() => {
    setSharingPanelMode(null);
    setSharingPanelEventName(null);
  }, []);

  const handleRestoreSharingRoom = useCallback(
    async (roomId: string) => {
      const normalizedRoomId = roomId.trim();
      const memberKey = loadMemberKey(normalizedRoomId);
      if (!memberKey) {
        setSharingErrorMessage('この端末に復元キーがありません。以前参加した同じ端末で復元してください。');
        return;
      }

      setSharingBusy(true);
      setSharingStatusMessage('共有ルームを復元しています。');
      setSharingErrorMessage(null);
      try {
        const prepared = await prepareRestoreRoom(normalizedRoomId);
        if (!prepared.ok) {
          setSharingErrorMessage(`共有ルームの復元準備に失敗しました: ${prepared.error.code}`);
          return;
        }

        const restored = await restorePreparedRoom(prepared.data, memberKey);
        if (!restored.ok) {
          setSharingErrorMessage(`共有ルームの復元に失敗しました: ${restored.error.code}`);
          return;
        }

        await applySnapshotAndAck(restored.data.roomId);
        setSharingStatusMessage('共有ルームを復元しました。');
      } catch (error) {
        console.error('Sharing restore error:', error);
        setSharingErrorMessage('共有ルームの復元に失敗しました。設定または通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [applySnapshotAndAck],
  );

  const applySharingMutationItems = useCallback(
    (eventName: string, mutationItems: SnapshotRoomItem[]) => {
      if (mutationItems.length === 0) return;
      setEventLists((prev) => ({
        ...prev,
        [eventName]: (prev[eventName] ?? []).map((item) => {
          const mutationItem = mutationItems.find((candidate) => candidate.localItemId === item.id);
          return mutationItem ? mergeSnapshotRoomItemIntoShoppingItem(item, mutationItem) : item;
        }),
      }));
    },
    [],
  );

  const saveSharingMutationVersion = useCallback(
    async (
      session: SharingSessionMetadata,
      itemsVersion: number,
      mutationItems: SnapshotRoomItem[],
      sessionPatch: Partial<SharingSessionMetadata> = {},
    ) => {
      const latestSession = {
        ...(sharingSessionsRef.current[session.sessionId] ?? session),
        ...sessionPatch,
      };
      const affectedLocalItemIds = Array.from(
        new Set(mutationItems.map((item) => item.localItemId).filter(Boolean)),
      );
      const fieldClocksByItemId = { ...(latestSession.fieldClocksByItemId ?? {}) };
      let deletedItemClocks = latestSession.deletedItemClocks;
      for (const item of mutationItems) {
        fieldClocksByItemId[item.localItemId] = {
          ...(fieldClocksByItemId[item.localItemId] ?? {}),
          ...item.fieldClocks,
        };
        if (item.deletedAt) {
          const currentEntry = deletedItemClocks?.[item.localItemId];
          deletedItemClocks = {
            ...(deletedItemClocks ?? {}),
            [item.localItemId]: {
              deletedAt: item.deletedAt,
              deletedBy: item.deletedBy,
              fieldClocks: {
                ...(currentEntry?.fieldClocks ?? {}),
                ...item.fieldClocks,
              },
              itemVersion: item.itemVersion,
              updatedAt: item.updatedAt,
            },
          };
        }
      }

      const existingPendingAck = latestSession.pendingItemSyncAck;
      const targetItemsVersion = Math.max(
        existingPendingAck?.targetItemsVersion ?? latestSession.itemsVersion,
        itemsVersion,
      );
      const pendingAffectedLocalItemIds = Array.from(
        new Set([...(existingPendingAck?.affectedLocalItemIds ?? []), ...affectedLocalItemIds]),
      );

      await saveSharingSessionState({
        ...latestSession,
        fieldClocksByItemId,
        deletedItemClocks,
        pendingItemSyncAck:
          targetItemsVersion > latestSession.itemsVersion
            ? {
                fromItemsVersion:
                  existingPendingAck?.fromItemsVersion ?? latestSession.itemsVersion,
                targetItemsVersion,
                affectedLocalItemIds: pendingAffectedLocalItemIds,
                retryCount: existingPendingAck?.retryCount ?? 0,
                lastTriedAt: existingPendingAck?.lastTriedAt,
                updatedAt: new Date().toISOString(),
              }
            : existingPendingAck,
      });
    },
    [saveSharingSessionState],
  );

  const buildSharingMemberRouteUpdatesForAssignment = useCallback(
    (
      session: SharingSessionMetadata,
      eventName: string,
      itemIds: string[],
      assignedToMemberId: string | null,
    ): SharingMemberRouteUpdate[] => {
      const eventItems = eventListsRef.current[eventName] ?? [];
      const itemsById = new Map(eventItems.map((item) => [item.id, item]));
      const currentMemberRoutes = memberRouteItemsRef.current[eventName] ?? {};
      const nextRoutesByDate = new Map<string, Map<string, string[]>>();
      const changedKeys = new Set<string>();

      const ensureRoute = (eventDate: string, roomMemberId: string): string[] => {
        let routesByMember = nextRoutesByDate.get(eventDate);
        if (!routesByMember) {
          routesByMember = new Map(
            Object.entries(currentMemberRoutes[eventDate] ?? {}).map(([memberId, routeIds]) => [
              memberId,
              [...routeIds],
            ]),
          );
          nextRoutesByDate.set(eventDate, routesByMember);
        }
        if (!routesByMember.has(roomMemberId)) {
          routesByMember.set(roomMemberId, []);
        }
        return routesByMember.get(roomMemberId) ?? [];
      };

      const markChanged = (eventDate: string, roomMemberId: string) => {
        changedKeys.add(`${eventDate}::${roomMemberId}`);
      };

      const uniqueItemIds = Array.from(new Set(itemIds));
      for (const itemId of uniqueItemIds) {
        const item = itemsById.get(itemId);
        if (!item?.eventDate) continue;

        const existingRoutesByMember = currentMemberRoutes[item.eventDate] ?? {};
        Object.entries(existingRoutesByMember).forEach(([roomMemberId, routeIds]) => {
          if (!routeIds.includes(itemId)) return;
          const route = ensureRoute(item.eventDate, roomMemberId);
          const nextRoute = route.filter((routeItemId) => routeItemId !== itemId);
          nextRoutesByDate.get(item.eventDate)?.set(roomMemberId, nextRoute);
          markChanged(item.eventDate, roomMemberId);
        });

        if (assignedToMemberId) {
          const route = ensureRoute(item.eventDate, assignedToMemberId);
          if (!route.includes(itemId)) {
            nextRoutesByDate.get(item.eventDate)?.set(assignedToMemberId, [...route, itemId]);
            markChanged(item.eventDate, assignedToMemberId);
          }
        }
      }

      return Array.from(changedKeys).map((key) => {
        const [eventDate, routeMemberId] = key.split('::');
        return {
          eventDate,
          routeMemberId,
          itemIds: nextRoutesByDate.get(eventDate)?.get(routeMemberId) ?? [],
          expectedVersion: session.memberRouteOrderVersions?.[eventDate]?.[routeMemberId] ?? 0,
        };
      });
    },
    [],
  );

  const applySharingAssignmentWithMemberRoutesResult = useCallback(
    async (
      session: SharingSessionMetadata,
      eventName: string,
      result: AssignmentWithMemberRoutesResult,
      statusMessage: string,
    ) => {
      const mutationItems = result.changedItems.map((change) => change.item);
      if (mutationItems.length > 0) {
        applySharingMutationItems(eventName, mutationItems);
      }

      setMemberRouteItems((prev) => ({
        ...prev,
        [eventName]: applyCanonicalMemberRouteOrders(
          prev[eventName] ?? {},
          result.changedMemberRouteOrders.map((routeOrder) => ({
            eventDate: routeOrder.eventDate,
            roomMemberId: routeOrder.routeMemberId,
            itemIds: routeOrder.itemIds,
          })),
        ),
      }));

      if (mutationItems.length > 0) {
        await saveSharingMutationVersion(session, result.itemsVersion, mutationItems, {
          memberRouteOrderVersions: result.memberRouteOrderVersions,
        });
      } else {
        const latestSession = sharingSessionsRef.current[session.sessionId] ?? session;
        await saveSharingSessionState({
          ...latestSession,
          memberRouteOrderVersions: result.memberRouteOrderVersions,
          lastAckAt: new Date().toISOString(),
        });
      }

      const memberRouteAck = await ackRoomMemberRouteOrderVersions(
        session.roomId,
        result.memberRouteOrderVersions,
      );
      if (memberRouteAck.ok) {
        const latestAfterAck = sharingSessionsRef.current[session.sessionId] ?? session;
        await saveSharingSessionState({
          ...latestAfterAck,
          memberRouteOrderVersions: memberRouteAck.data.memberRouteOrderVersions,
          lastAckAt: new Date().toISOString(),
        });
      } else {
        setSharingErrorMessage(`個人ルートの同期ackに失敗しました: ${memberRouteAck.error.code}`);
      }

      setSharingStatusMessage(statusMessage);
    },
    [
      applySharingMutationItems,
      saveSharingMutationVersion,
      saveSharingSessionState,
    ],
  );

  const ackSavedRouteOrderVersions = useCallback(
    async (
      session: SharingSessionMetadata,
      routeOrderVersions: Record<string, number>,
      pendingRouteOrderAcks: SharingSessionMetadata['pendingRouteOrderAcks'],
    ) => {
      if (!pendingRouteOrderAcks || Object.keys(pendingRouteOrderAcks).length === 0) return;

      const attemptedAt = new Date().toISOString();
      const attemptedPendingRouteOrderAcks = markPendingRouteOrderAckAttempt(
        pendingRouteOrderAcks,
        attemptedAt,
      );
      if (!attemptedPendingRouteOrderAcks) return;

      const latestBeforeAck = sharingSessionsRef.current[session.sessionId] ?? session;
      await saveSharingSessionState({
        ...latestBeforeAck,
        routeOrderVersions,
        pendingRouteOrderAcks: attemptedPendingRouteOrderAcks,
        lastAckAt: attemptedAt,
      });

      const routeAck = await ackRoomRouteOrderVersions(session.roomId, routeOrderVersions);
      const latestAfterAck = sharingSessionsRef.current[session.sessionId] ?? latestBeforeAck;
      if (routeAck.ok) {
        await saveSharingSessionState({
          ...latestAfterAck,
          routeOrderVersions: routeAck.data.routeOrderVersions,
          pendingRouteOrderAcks: clearSatisfiedRouteOrderAcks(
            attemptedPendingRouteOrderAcks,
            routeAck.data.routeOrderVersions,
            new Date().toISOString(),
          ),
          lastAckAt: new Date().toISOString(),
        });
        return;
      }

      setSharingErrorMessage(`巡回順の同期ackに失敗しました: ${routeAck.error.code}`);
    },
    [saveSharingSessionState],
  );

  const assignSharingRouteItemsToCurrentMember = useCallback(
    async (
      session: SharingSessionMetadata,
      eventName: string,
      itemIds: string[],
      statusMessage: string,
    ): Promise<boolean> => {
      const uniqueItemIds = Array.from(new Set(itemIds));
      if (uniqueItemIds.length === 0) return true;

      const eventItems = eventListsRef.current[eventName] ?? [];
      const targetIds = new Set(uniqueItemIds);
      const targetItems = eventItems.filter((item) => targetIds.has(item.id));
      if (targetItems.length === 0) return true;

      const assignments = [];
      for (const item of targetItems) {
        if (item.assignedTo === session.roomMemberId) continue;
        const expectedFieldClocks = pickExpectedFieldClocks(session, item.id, ['assignedTo']);
        if (!expectedFieldClocks) {
          setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
          await applySnapshotAndAck(session.roomId);
          return false;
        }
        assignments.push({
          localItemId: item.id,
          assignedToMemberId: session.roomMemberId,
          expectedFieldClocks,
        });
      }

      const memberRouteUpdates = buildSharingMemberRouteUpdatesForAssignment(
        session,
        eventName,
        uniqueItemIds,
        session.roomMemberId,
      );

      if (assignments.length === 0 && memberRouteUpdates.length === 0) return true;

      setSharingBusy(true);
      setSharingErrorMessage(null);
      try {
        const result = await updateRoomItemAssignmentWithMemberRoutes({
          roomId: session.roomId,
          assignments,
          memberRouteUpdates,
        });
        if (!result.ok) {
          if (isFullItemRefreshRequired(result.error.code)) {
            setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
            await applySnapshotAndAck(session.roomId);
            return false;
          }
          if (
            result.error.code === 'FIELD_CLOCK_CONFLICT' ||
            result.error.code === 'ROUTE_ORDER_CONFLICT'
          ) {
            setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
            await applySnapshotAndAck(session.roomId);
            return false;
          }
          setSharingErrorMessage(`担当者の自動更新に失敗しました: ${result.error.code}`);
          return false;
        }

        await applySharingAssignmentWithMemberRoutesResult(
          session,
          eventName,
          result.data,
          statusMessage,
        );
        return true;
      } catch (error) {
        console.error('Sharing auto assignment error:', error);
        setSharingErrorMessage('担当者の自動更新に失敗しました。通信状態を確認してください。');
        return false;
      } finally {
        setSharingBusy(false);
      }
    },
    [
      applySharingAssignmentWithMemberRoutesResult,
      applySnapshotAndAck,
      buildSharingMemberRouteUpdatesForAssignment,
    ],
  );

  const handleAssignSharingItem = useCallback(
    async (localItemId: string, assignedToMemberId: string | null) => {
      const session = activeSharingSession;
      if (!session || sharingBusy) return;

      const item = eventListsRef.current[session.eventName]?.find(
        (candidate) => candidate.id === localItemId,
      );
      if (!item) {
        setSharingErrorMessage('担当変更対象のアイテムが見つかりません。');
        return;
      }
      if (!canAssignSharingItem(item)) {
        setSharingErrorMessage('共有中の有効メンバーだけが担当者を変更できます。');
        return;
      }

      const expectedFieldClocks = pickExpectedFieldClocks(session, localItemId, ['assignedTo']);
      if (!expectedFieldClocks) {
        setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
        await applySnapshotAndAck(session.roomId);
        return;
      }

      setSharingBusy(true);
      setSharingErrorMessage(null);
      try {
        const memberRouteUpdates = buildSharingMemberRouteUpdatesForAssignment(
          session,
          session.eventName,
          [localItemId],
          assignedToMemberId,
        );
        const result = await updateRoomItemAssignmentWithMemberRoutes({
          roomId: session.roomId,
          assignments: [
            {
              localItemId,
              assignedToMemberId,
              expectedFieldClocks,
            },
          ],
          memberRouteUpdates,
        });
        if (!result.ok) {
          if (isFullItemRefreshRequired(result.error.code)) {
            setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
            await applySnapshotAndAck(session.roomId);
            return;
          }
          if (result.error.code === 'FIELD_CLOCK_CONFLICT') {
            setSharingErrorMessage(
              '他の参加者が同じ担当者欄を先に更新しました。最新状態を取得しました。',
            );
            await applySnapshotAndAck(session.roomId);
            return;
          }
          setSharingErrorMessage(`担当変更に失敗しました: ${result.error.code}`);
          return;
        }

        await applySharingAssignmentWithMemberRoutesResult(
          session,
          session.eventName,
          result.data,
          '担当者を更新しました。',
        );
      } catch (error) {
        console.error('Sharing assignment error:', error);
        setSharingErrorMessage('担当変更に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [
      activeSharingSession,
      applySharingAssignmentWithMemberRoutesResult,
      applySnapshotAndAck,
      buildSharingMemberRouteUpdatesForAssignment,
      canAssignSharingItem,
      sharingBusy,
    ],
  );

  const handleBulkAssignSelectedSharingItems = useCallback(
    async (assignedToMemberId: string) => {
      const session = activeSharingSession;
      if (!session || sharingBusy) return;

      const eventItems = eventListsRef.current[session.eventName] ?? [];
      const selectedItems = eventItems.filter((item) => selectedItemIds.has(item.id));
      if (selectedItems.length === 0) {
        setSharingErrorMessage('一括譲渡するアイテムを選択してください。');
        return;
      }

      if (selectedItems.some((item) => !canAssignSharingItem(item))) {
        setSharingErrorMessage('共有中の有効メンバーだけが一括譲渡できます。');
        return;
      }

      const assignments = [];
      for (const item of selectedItems) {
        const expectedFieldClocks = pickExpectedFieldClocks(session, item.id, ['assignedTo']);
        if (!expectedFieldClocks) {
          setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
          await applySnapshotAndAck(session.roomId);
          return;
        }
        assignments.push({ localItemId: item.id, assignedToMemberId, expectedFieldClocks });
      }

      setSharingBusy(true);
      setSharingErrorMessage(null);
      try {
        const memberRouteUpdates = buildSharingMemberRouteUpdatesForAssignment(
          session,
          session.eventName,
          selectedItems.map((item) => item.id),
          assignedToMemberId,
        );
        const result = await updateRoomItemAssignmentWithMemberRoutes({
          roomId: session.roomId,
          assignments,
          memberRouteUpdates,
        });
        if (!result.ok) {
          if (isFullItemRefreshRequired(result.error.code)) {
            setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
            await applySnapshotAndAck(session.roomId);
            return;
          }
          if (result.error.code === 'FIELD_CLOCK_CONFLICT') {
            setSharingErrorMessage(
              '他の参加者が同じ担当者欄を先に更新しました。一括譲渡を中断し、最新状態を取得しました。',
            );
            await applySnapshotAndAck(session.roomId);
            return;
          }
          setSharingErrorMessage(`一括譲渡に失敗しました: ${result.error.code}`);
          return;
        }

        await applySharingAssignmentWithMemberRoutesResult(
          session,
          session.eventName,
          result.data,
          `${selectedItems.length}件の担当者を更新しました。`,
        );
        setSelectedItemIds(new Set());
      } catch (error) {
        console.error('Sharing bulk assignment error:', error);
        setSharingErrorMessage('一括譲渡に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [
      activeSharingSession,
      applySharingAssignmentWithMemberRoutesResult,
      applySnapshotAndAck,
      buildSharingMemberRouteUpdatesForAssignment,
      canAssignSharingItem,
      selectedItemIds,
      setSelectedItemIds,
      sharingBusy,
    ],
  );

  const refreshSharingNotifications = useCallback(async () => {
    const session = activeSharingSession;
    if (!session) {
      setSharingNotificationList([]);
      return;
    }

    const result = await getNotificationList(session.roomId, 50, false);
    if (!result.ok) {
      setSharingErrorMessage(`通知一覧の取得に失敗しました: ${result.error.code}`);
      return;
    }
    setSharingNotificationList(result.data.notifications);
  }, [activeSharingSession]);

  const handleMarkSharingNotificationRead = useCallback(
    async (notificationId: string) => {
      const session = activeSharingSession;
      if (!session) return;
      const result = await markNotificationRead(session.roomId, notificationId, true);
      if (!result.ok) {
        setSharingErrorMessage(`通知の既読化に失敗しました: ${result.error.code}`);
        return;
      }
      await refreshSharingNotifications();
    },
    [activeSharingSession, refreshSharingNotifications],
  );

  const handleHideSharingNotification = useCallback(
    async (notificationId: string) => {
      const session = activeSharingSession;
      if (!session) return;
      const result = await hideNotification(session.roomId, notificationId, true);
      if (!result.ok) {
        setSharingErrorMessage(`通知の非表示に失敗しました: ${result.error.code}`);
        return;
      }
      await refreshSharingNotifications();
    },
    [activeSharingSession, refreshSharingNotifications],
  );

  const buildLocalizedSharingEventLists = useCallback(
    (eventName: string): Record<string, ShoppingItem[]> => ({
      ...eventListsRef.current,
      [eventName]: (eventListsRef.current[eventName] ?? []).map((item) => ({
        ...item,
        assignedTo: undefined,
        securedBy: undefined,
      })),
    }),
    [],
  );

  const commitLocalizedSharingSession = useCallback(async (session: SharingSessionMetadata) => {
    const localizedEventLists = buildLocalizedSharingEventLists(session.eventName);
    await db.commitSharingLocalize({
      eventLists: localizedEventLists as Record<string, unknown[]>,
      session,
    });
    eventListsRef.current = localizedEventLists;
    setEventLists(localizedEventLists);
    sharingSessionsRef.current = {
      ...sharingSessionsRef.current,
      [session.sessionId]: session,
    };
    setSharingSessions((prev) => ({
      ...prev,
      [session.sessionId]: session,
    }));
  }, [buildLocalizedSharingEventLists]);

  const recoverSharingSessionAfterLeaveFailure = useCallback(
    async (session: SharingSessionMetadata) => {
      await saveSharingSessionState({
        ...session,
        status: 'active',
      });
    },
    [saveSharingSessionState],
  );

  const localizeCommittedSharingSession = useCallback(async (session: SharingSessionMetadata) => {
    await commitLocalizedSharingSession(session);
    forgetMemberKey(session.roomId);
  }, [commitLocalizedSharingSession]);

  const refreshSharingMemberProfiles = useCallback(
    async (session: SharingSessionMetadata): Promise<SharingSessionMetadata> => {
      const result = await getRoomMembersForDisplay(session.roomId);
      if (!result.ok) return session;

      const latestSession = sharingSessionsRef.current[session.sessionId] ?? session;
      if (
        areAssignmentMemberProfilesEqual(latestSession.memberProfileSnapshot, result.data.members)
      ) {
        return latestSession;
      }

      const updatedSession: SharingSessionMetadata = {
        ...latestSession,
        memberProfileSnapshot: result.data.members,
      };
      await saveSharingSessionState(updatedSession);
      return updatedSession;
    },
    [saveSharingSessionState],
  );

  useEffect(() => {
    if (!isInitialized || !activeSharingSession || !sharingAvailability.enabled) return;

    const sessionId = activeSharingSession.sessionId;
    let disposed = false;
    const refreshCurrentMemberProfiles = () => {
      const currentSession = sharingSessionsRef.current[sessionId];
      if (!currentSession || !isSharingSessionActive(currentSession) || disposed) return;
      void refreshSharingMemberProfiles(currentSession);
    };

    refreshCurrentMemberProfiles();
    const timerId = window.setInterval(
      refreshCurrentMemberProfiles,
      SHARING_MEMBER_PROFILE_REFRESH_INTERVAL_MS,
    );

    return () => {
      disposed = true;
      window.clearInterval(timerId);
    };
  }, [
    activeSharingSession?.sessionId,
    isInitialized,
    refreshSharingMemberProfiles,
    sharingAvailability.enabled,
  ]);

  const handlePauseSharingSession = useCallback(
    async (session: SharingSessionMetadata) => {
      if (sharingBusy) return;

      setSharingBusy(true);
      setSharingStatusMessage('共有から一時離脱しています。');
      setSharingErrorMessage(null);
      try {
        const result = await pauseRoomSession(session.roomId);
        if (!result.ok) {
          setSharingErrorMessage(`一時離脱に失敗しました: ${result.error.code}`);
          return;
        }

        const latestSession = sharingSessionsRef.current[session.sessionId] ?? session;
        await saveSharingSessionState({
          ...latestSession,
          status: 'paused',
        });
        setSharingStatusMessage('一時離脱しました。再開するまで共有同期を停止します。');
      } catch (error) {
        console.error('Sharing pause error:', error);
        setSharingErrorMessage('一時離脱に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [saveSharingSessionState, sharingBusy],
  );

  const handleResumeSharingSession = useCallback(
    async (session: SharingSessionMetadata) => {
      if (sharingBusy) return;

      setSharingBusy(true);
      setSharingStatusMessage('共有を再開しています。');
      setSharingErrorMessage(null);
      try {
        const result = await heartbeatRoomSession(session.roomId);
        if (!result.ok) {
          if (result.error.code === 'ROOM_EXPIRED') {
            await expireSharingSession(session);
          } else {
            setSharingErrorMessage(`共有の再開に失敗しました: ${result.error.code}`);
          }
          return;
        }

        const latestSession = sharingSessionsRef.current[session.sessionId] ?? session;
        await saveSharingSessionState({
          ...latestSession,
          status: 'active',
          lastAckAt: new Date().toISOString(),
        });
        setSharingStatusMessage('共有を再開しました。');
        void synchronizeSharingSession(session.sessionId, 'manual');
      } catch (error) {
        console.error('Sharing resume error:', error);
        setSharingErrorMessage('共有の再開に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [expireSharingSession, saveSharingSessionState, sharingBusy, synchronizeSharingSession],
  );

  const handleLocalizeSharingSession = useCallback(
    async (session: SharingSessionMetadata) => {
      if (sharingBusy) return;

      setSharingBusy(true);
      setSharingErrorMessage(null);
      try {
        const sessionWithProfiles = await refreshSharingMemberProfiles(session);
        await localizeCommittedSharingSession({
          ...sessionWithProfiles,
          status: 'localizing',
        });
        setSharingAssignedOnly(false);
        setSharingStatusMessage(`${sessionWithProfiles.eventName} をローカル編集に切り替えました。`);
      } catch (error) {
        console.error('Sharing localize error:', error);
        setSharingErrorMessage('ローカル化に失敗しました。もう一度お試しください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [localizeCommittedSharingSession, refreshSharingMemberProfiles, sharingBusy],
  );

  const handleLeaveSharingSession = useCallback(
    async (session: SharingSessionMetadata) => {
      if (sharingBusy) return;
      const confirmationMessage =
        session.role === 'host'
          ? '主催が退出すると、この共有ルームは終了します。ローカルデータは保持されます。退出しますか？'
          : 'この共有から退出します。担当/確保者の履歴は残りますが、この端末の復元キーは削除されます。';
      if (!window.confirm(confirmationMessage)) {
        return;
      }

      setSharingBusy(true);
      setSharingStatusMessage('共有から退出しています。');
      setSharingErrorMessage(null);
      let sessionWithProfiles: SharingSessionMetadata | null = null;
      let serverLeaveSucceeded = false;
      try {
        sessionWithProfiles = await refreshSharingMemberProfiles(session);
        const leavingSession: SharingSessionMetadata = {
          ...sessionWithProfiles,
          status: 'leaving',
        };
        await saveSharingSessionState(leavingSession);

        const result = await leaveRoom(session.roomId);
        if (!result.ok) {
          await recoverSharingSessionAfterLeaveFailure(sessionWithProfiles);
          setSharingErrorMessage(`退出に失敗しました: ${result.error.code}`);
          return;
        }
        serverLeaveSucceeded = true;

        await localizeCommittedSharingSession({
          ...sessionWithProfiles,
          status: 'localizing',
          lastAckAt: new Date().toISOString(),
        });
        setSharingAssignedOnly(false);
        setSharingStatusMessage(`${sessionWithProfiles.eventName} の共有から退出しました。`);
      } catch (error) {
        console.error('Sharing leave error:', error);
        if (!serverLeaveSucceeded && sessionWithProfiles) {
          try {
            await recoverSharingSessionAfterLeaveFailure(sessionWithProfiles);
          } catch (recoveryError) {
            console.error('Sharing leave recovery error:', recoveryError);
          }
        }
        setSharingErrorMessage('退出に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
    },
    [
      localizeCommittedSharingSession,
      refreshSharingMemberProfiles,
      recoverSharingSessionAfterLeaveFailure,
      setSharingAssignedOnly,
      sharingBusy,
    ],
  );

  useEffect(() => {
    if (!isInitialized) return;
    const intervalId = window.setInterval(() => {
      const nowMs = Date.now();
      const locallyExpiredSessions = Object.values(sharingSessions).filter(
        (session) =>
          (session.status === 'active' || session.status === 'paused') &&
          Date.parse(session.expiresAt) <= nowMs,
      );
      locallyExpiredSessions.forEach((session) => {
        const expiredSession: SharingSessionMetadata = {
          ...session,
          status: 'expired',
        };
        void db.saveSharingSession(expiredSession).then(() => {
          setSharingSessions((prev) => ({
            ...prev,
            [session.sessionId]: expiredSession,
          }));
          setSharingStatusMessage(`${session.eventName} の共有期限が切れました。`);
        });
      });

      const activeSessions = Object.values(sharingSessions).filter((session) =>
        isSharingSessionActive(session, nowMs),
      );
      activeSessions.forEach((session) => {
        void heartbeatRoomSession(session.roomId).then(async (result) => {
          if (result.ok) return;
          if (result.error.code !== 'ROOM_EXPIRED') return;

          const expiredSession: SharingSessionMetadata = {
            ...session,
            status: 'expired',
          };
          await db.saveSharingSession(expiredSession);
          setSharingSessions((prev) => ({
            ...prev,
            [session.sessionId]: expiredSession,
          }));
          setSharingStatusMessage(`${session.eventName} の共有期限が切れました。`);
        });
      });
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, [isInitialized, sharingSessions]);

  useEffect(() => {
    if (!isInitialized || !activeSharingSession || !sharingAvailability.enabled) return;

    const sessionId = activeSharingSession.sessionId;
    let liveReady = false;
    let liveQueued = false;
    let disposed = false;

    const catchUpThenStartLive = async () => {
      await synchronizeSharingSession(sessionId, 'initial');
      if (disposed) return;
      liveReady = true;
      if (liveQueued) {
        liveQueued = false;
        void synchronizeSharingSession(sessionId, 'queued');
      }
    };

    const subscription = subscribeToRoomSync(
      activeSharingSession.roomId,
      (event) => {
        if (event.table === 'room_members') {
          if (event.eventType === 'INSERT') {
            void applySnapshotAndAck(activeSharingSession.roomId);
          } else if (event.eventType === 'UPDATE') {
            void refreshSharingMemberProfiles(activeSharingSession);
          }
          return;
        }
        if (!liveReady) {
          liveQueued = true;
          return;
        }
        void synchronizeSharingSession(sessionId, 'realtime');
      },
      (status) => {
        if (status === 'SUBSCRIBED') {
          void catchUpThenStartLive();
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setSharingErrorMessage('共有のライブ同期が一時的に切断されました。差分同期で復旧を試みます。');
          void synchronizeSharingSession(sessionId, 'manual');
        }
      },
    );

    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [
    activeSharingSession?.roomId,
    activeSharingSession?.sessionId,
    applySnapshotAndAck,
    isInitialized,
    refreshSharingMemberProfiles,
    sharingAvailability.enabled,
    synchronizeSharingSession,
  ]);

  useEffect(() => {
    if (!isInitialized || !activeSharingSession || !sharingAvailability.enabled) return;

    const sessionId = activeSharingSession.sessionId;
    const timerId = window.setInterval(() => {
      const currentSession = sharingSessionsRef.current[sessionId];
      if (!currentSession || !isSharingSessionActive(currentSession)) return;
      void synchronizeSharingSession(sessionId, 'realtime');
    }, SHARING_ITEM_SYNC_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timerId);
  }, [
    activeSharingSession?.sessionId,
    isInitialized,
    sharingAvailability.enabled,
    synchronizeSharingSession,
  ]);

  const hallDefinitionsMigratedRef = useRef(false);
  useEffect(() => {
    if (!isInitialized || hallDefinitionsMigratedRef.current) return;
    hallDefinitionsMigratedRef.current = true;

    setHallDefinitions((prev) => {
      let changed = false;
      const next: HallDefinitionsStore = {};
      for (const eventName of Object.keys(prev)) {
        const byTab = { ...prev[eventName] };

        const maplessById = new Map<string, HallDefinition>();
        for (const h of byTab[MAPLESS_HALL_KEY] ?? []) {
          maplessById.set(h.id, h);
        }
        for (const tabName of Object.keys(byTab)) {
          if (tabName === MAPLESS_HALL_KEY || tabName.startsWith(MAPLESS_HALL_KEY + ':')) continue;
          const original = byTab[tabName] || [];
          const keep: HallDefinition[] = [];
          for (const h of original) {
            const isMapless =
              (!h.vertices || h.vertices.length < 4) && !!h.blockNames?.length;
            if (isMapless) {
              if (!maplessById.has(h.id)) maplessById.set(h.id, h);
              changed = true;
            } else {
              keep.push(h);
            }
          }
          if (keep.length !== original.length) {
            byTab[tabName] = keep;
          }
        }

        const collectedMapless = Array.from(maplessById.values());
        if (collectedMapless.length > 0) {
          const eventItems = eventLists[eventName] || [];
          const dates = extractEventDates(eventItems);
          if (dates.length > 0) {
            for (const date of dates) {
              const dateKey = getMaplessKey(date);
              if (!byTab[dateKey] || byTab[dateKey].length === 0) {
                byTab[dateKey] = collectedMapless.map((h) => ({ ...h }));
                changed = true;
              }
            }
          }
        }
        if (byTab[MAPLESS_HALL_KEY] != null) {
          delete byTab[MAPLESS_HALL_KEY];
          changed = true;
        }

        next[eventName] = byTab;
      }
      return changed ? next : prev;
    });

    setHallRouteSettings((prev) => {
      let changed = false;
      const next: HallRouteSettingsStore = {};
      for (const eventName of Object.keys(prev)) {
        const byTab = { ...prev[eventName] };
        const oldSettings = byTab[MAPLESS_HALL_KEY];
        if (oldSettings != null) {
          const eventItems = eventLists[eventName] || [];
          const dates = extractEventDates(eventItems);
          for (const date of dates) {
            const dateKey = getMaplessKey(date);
            if (!byTab[dateKey]) {
              byTab[dateKey] = {
                hallOrder: [...oldSettings.hallOrder],
                hallVisitLists: oldSettings.hallVisitLists.map((vl) => ({
                  hallId: vl.hallId,
                  itemIds: [...vl.itemIds],
                })),
              };
              changed = true;
            }
          }
          delete byTab[MAPLESS_HALL_KEY];
          changed = true;
        }
        next[eventName] = byTab;
      }
      return changed ? next : prev;
    });
  }, [isInitialized, eventLists]);

  const items = useMemo(
    () => (activeEventName ? eventLists[activeEventName] || [] : []),
    [activeEventName, eventLists],
  );


  const eventDates = useMemo(() => extractEventDates(items), [items]);
  const activeEventDate = useMemo(
    () => (activeEventName && eventDates.includes(activeTab) ? activeTab : ''),
    [activeEventName, activeTab, eventDates],
  );
  const activeRouteStateKey = useMemo(
    () => (activeEventName && activeEventDate ? `${activeEventName}::${activeEventDate}` : null),
    [activeEventName, activeEventDate],
  );
  const activeRouteScope = useMemo<RouteScope>(() => {
    if (!activeSharingSession || !activeRouteStateKey) return 'global';
    return currentRouteScopeByDate[activeRouteStateKey] ?? 'global';
  }, [activeRouteStateKey, activeSharingSession, currentRouteScopeByDate]);
  const activeRouteMemberId = useMemo(() => {
    if (!activeSharingSession || !activeRouteStateKey) return null;
    if (activeSharingSession.role !== 'host') return activeSharingSession.roomMemberId;
    return selectedRouteMemberIdByDate[activeRouteStateKey] ?? activeSharingSession.roomMemberId;
  }, [activeRouteStateKey, activeSharingSession, selectedRouteMemberIdByDate]);
  const activeCandidateFilter = useMemo<MemberRouteCandidateFilter>(
    () =>
      activeRouteStateKey
        ? candidateFilterByDate[activeRouteStateKey] ?? 'includeUnassigned'
        : 'includeUnassigned',
    [activeRouteStateKey, candidateFilterByDate],
  );
  const selectedMemberRouteItemIds = useMemo(() => {
    if (
      !activeEventName ||
      !activeEventDate ||
      !activeRouteMemberId
    ) {
      return [];
    }
    return memberRouteItems[activeEventName]?.[activeEventDate]?.[activeRouteMemberId] ?? [];
  }, [
    activeEventDate,
    activeEventName,
    activeRouteMemberId,
    memberRouteItems,
  ]);
  const activeMemberRouteItemIds = useMemo(
    () => (activeRouteScope === 'member' ? selectedMemberRouteItemIds : []),
    [activeRouteScope, selectedMemberRouteItemIds],
  );
  const activeMapRouteDisplayMode = useMemo<MapRouteDisplayMode>(() => {
    if (!activeSharingSession || !activeRouteStateKey) return 'global';
    return (
      mapRouteDisplayModeByDate[activeRouteStateKey] ??
      (activeRouteScope === 'member' ? 'member' : 'global')
    );
  }, [
    activeRouteScope,
    activeRouteStateKey,
    activeSharingSession,
    mapRouteDisplayModeByDate,
  ]);
  const handleRouteScopeChange = useCallback(
    (scope: RouteScope) => {
      if (!activeRouteStateKey) return;
      setCurrentRouteScopeByDate((prev) => ({
        ...prev,
        [activeRouteStateKey]: scope,
      }));
      setSelectedItemIds(new Set());
    },
    [activeRouteStateKey, setSelectedItemIds],
  );
  const handleSelectedRouteMemberChange = useCallback(
    (roomMemberId: string) => {
      if (!activeRouteStateKey || !activeSharingSession) return;
      const nextMemberId =
        activeSharingSession.role === 'host' ? roomMemberId : activeSharingSession.roomMemberId;
      setSelectedRouteMemberIdByDate((prev) => ({
        ...prev,
        [activeRouteStateKey]: nextMemberId,
      }));
      setSelectedItemIds(new Set());
    },
    [activeRouteStateKey, activeSharingSession, setSelectedItemIds],
  );
  const handleCandidateFilterChange = useCallback(
    (filter: MemberRouteCandidateFilter) => {
      if (!activeRouteStateKey) return;
      setCandidateFilterByDate((prev) => ({
        ...prev,
        [activeRouteStateKey]: filter,
      }));
      setSelectedItemIds(new Set());
    },
    [activeRouteStateKey, setSelectedItemIds],
  );
  const handleMapRouteDisplayModeChange = useCallback(
    (mode: MapRouteDisplayMode) => {
      if (!activeRouteStateKey) return;
      setMapRouteDisplayModeByDate((prev) => ({
        ...prev,
        [activeRouteStateKey]: mode,
      }));
    },
    [activeRouteStateKey],
  );

  const {
    mapTabs,
    isMapTab,
    currentMapTabName,
    currentMapData,
    currentHalls,
    currentHallRouteSettings,
    getMapTabForDate,
    getHallsForDate,
    getMapDataForDate,
    getHallOrderForDate,
  } = useMapSelectors({
    activeEventName,
    activeTab,
    activeEventDate: activeEventDate || null,
    mapViewActive,
    mapData,
    hallDefinitions,
    hallRouteSettings,
  });


  const getHallExecuteCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      if (!activeEventDate) return 0;
      const dayName = activeEventDate;

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      return executeIds.filter((itemId) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return false;


        const block = currentMapData.blocks.find((b) => b.name === item.block);
        if (!block) return false;

        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;

        for (const hall of currentHalls) {
          if (hall.id === hallId && hall.vertices.length >= 4) {
            if (isPointInPolygon(centerRow, centerCol, hall.vertices)) {
              return true;
            }
          }
        }
        return false;
      }).length;
    },
    [activeEventName, isMapTab, activeEventDate, currentMapData, currentHalls, items, executeModeItems],
  );


  const getHallTotalItemCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      if (!activeEventDate) return 0;
      const dayName = activeEventDate;

      const dayItems = items.filter((item) => item.eventDate === dayName);

      return dayItems.filter((item) => {
        const block = currentMapData.blocks.find((b) => b.name === item.block);
        if (!block) return false;

        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;

        for (const hall of currentHalls) {
          if (hall.id === hallId && hall.vertices.length >= 4) {
            if (isPointInPolygon(centerRow, centerCol, hall.vertices)) {
              return true;
            }
          }
        }
        return false;
      }).length;
    },
    [activeEventName, isMapTab, activeEventDate, currentMapData, currentHalls, items],
  );


  const getItemHallId = useCallback(
    (item: ShoppingItem, eventDate: string): string | null => {
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return null;

      const manual = resolveManualHallId(item.manualHallId, halls);
      if (manual) return manual;

      const mapDataForDate = getMapDataForDate(eventDate);
      if (mapDataForDate) {
        const block = mapDataForDate.blocks.find((b) => b.name === item.block);
        if (block) {
          const centerRow = (block.startRow + block.endRow) / 2;
          const centerCol = (block.startCol + block.endCol) / 2;
          for (const hall of halls) {
            if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
              return hall.id;
            }
          }
        }
      }

      return resolveHallByBlockName(item.block, halls);
    },
    [getHallsForDate, getMapDataForDate],
  );


  const areItemsInSameHall = useCallback(
    (itemId1: string, itemId2: string, eventDate: string): boolean => {
      const item1 = items.find((i) => i.id === itemId1);
      const item2 = items.find((i) => i.id === itemId2);
      if (!item1 || !item2) return true;
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return true;
      const hallId1 = getItemHallId(item1, eventDate);
      const hallId2 = getItemHallId(item2, eventDate);

      if (hallId1 === null || hallId2 === null) return true;

      const priority1 = item1.priorityLevel || 'none';
      const priority2 = item2.priorityLevel || 'none';
      if (hallId1 !== hallId2 || priority1 !== priority2) return false;

      const spaceKey1 = getSpaceKey(item1.block, item1.number);
      const spaceKey2 = getSpaceKey(item2.block, item2.number);
      return spaceKey1 === spaceKey2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const areItemsInSameHallGroup = useCallback(
    (itemId1: string, itemId2: string, eventDate: string): boolean => {
      const item1 = items.find((i) => i.id === itemId1);
      const item2 = items.find((i) => i.id === itemId2);
      if (!item1 || !item2) return true;
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return true;
      const hallId1 = getItemHallId(item1, eventDate);
      const hallId2 = getItemHallId(item2, eventDate);

      if (hallId1 === null || hallId2 === null) return true;

      const priority1 = item1.priorityLevel || 'none';
      const priority2 = item2.priorityLevel || 'none';
      return hallId1 === hallId2 && priority1 === priority2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    if (activeEventDate) {
      const mode = modes[activeEventDate];
      if (mode) {
        return mode;
      }
      return 'edit';
    }
    return 'edit';
  }, [activeEventName, dayModes, activeEventDate]);


  const currentFocusSessionKey = useMemo(() => {
    if (!activeEventName) return null;
    const currentEventDate = activeEventDate;
    if (!currentEventDate) return null;
    return buildFocusSessionKey(activeEventName, currentEventDate);
  }, [activeEventName, activeEventDate]);

  const currentFocusResumeState = useMemo(() => {
    if (!currentFocusSessionKey) return null;
    return focusModeSessions[currentFocusSessionKey] || null;
  }, [focusModeSessions, currentFocusSessionKey]);

  const handleFocusSessionStateChange = useCallback(
    (state: FocusModeSessionState) => {
      if (!currentFocusSessionKey) return;
      setFocusModeSessions((prev) => {
        const existing = prev[currentFocusSessionKey];
        if (isFocusModeSessionStateEqual(existing, state)) return prev;
        return {
          ...prev,
          [currentFocusSessionKey]: state,
        };
      });
    },
    [currentFocusSessionKey],
  );

  const validFocusSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    Object.entries(eventLists).forEach(([eventName, eventItems]) => {
      extractEventDates(eventItems).forEach((eventDate) => {
        keys.add(buildFocusSessionKey(eventName, eventDate));
      });
    });
    return keys;
  }, [eventLists]);

  useEffect(() => {
    setFocusModeSessions((prev) => {
      return reconcileFocusModeSessions(
        prev,
        eventLists,
        executeModeItems,
        validFocusSessionKeys,
      );
    });
  }, [eventLists, executeModeItems, validFocusSessionKeys]);

  const currentFocusEventDate = useMemo(() => activeEventDate, [activeEventDate]);

  const currentFocusMapName = useMemo(
    () => (currentFocusEventDate ? `${currentFocusEventDate}マップ` : ''),
    [currentFocusEventDate],
  );

  const getDayMapRotationState = useCallback(
    (eventName: string, dayMapName: string) =>
      resolveDayMapRotationState(mapRotationSettings[eventName]?.[dayMapName]),
    [mapRotationSettings],
  );

  const updateMapRotationAngle = useCallback(
    (eventName: string, dayMapName: string, screen: RotationScreenType, angle: number) => {
      const normalizedAngle = normalizeRotationAngle(angle);
      setMapRotationSettings((prev) => {
        const eventSettings = prev[eventName] || {};
        const currentState = resolveDayMapRotationState(eventSettings[dayMapName]);
        const nextState =
          screen === 'mapTab'
            ? { ...currentState, mapTabAngle: normalizedAngle }
            : { ...currentState, focusModeAngle: normalizedAngle };
        if (
          currentState.initialAngle === nextState.initialAngle &&
          currentState.mapTabAngle === nextState.mapTabAngle &&
          currentState.focusModeAngle === nextState.focusModeAngle
        ) {
          return prev;
        }
        return {
          ...prev,
          [eventName]: {
            ...eventSettings,
            [dayMapName]: nextState,
          },
        };
      });
    },
    [],
  );

  const currentMapTabRotationState = useMemo(() => {
    if (!activeEventName || !isMapTab || !currentMapTabName) {
      return resolveDayMapRotationState(undefined);
    }
    return getDayMapRotationState(activeEventName, currentMapTabName);
  }, [activeEventName, isMapTab, currentMapTabName, getDayMapRotationState]);

  const currentFocusMapRotationState = useMemo(() => {
    if (!activeEventName || !currentFocusMapName) {
      return resolveDayMapRotationState(undefined);
    }
    return getDayMapRotationState(activeEventName, currentFocusMapName);
  }, [activeEventName, currentFocusMapName, getDayMapRotationState]);

  const handleMapTabRotationAngleChange = useCallback(
    (angle: number) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      if (guardSharingStructureMutation(activeEventName)) return;
      updateMapRotationAngle(activeEventName, currentMapTabName, 'mapTab', angle);
    },
    [
      activeEventName,
      isMapTab,
      currentMapTabName,
      guardSharingStructureMutation,
      updateMapRotationAngle,
    ],
  );

  const handleFocusMapRotationAngleChange = useCallback(
    (angle: number) => {
      if (!activeEventName || !currentFocusMapName) return;
      if (guardSharingStructureMutation(activeEventName)) return;
      updateMapRotationAngle(activeEventName, currentFocusMapName, 'focusMode', angle);
    },
    [activeEventName, currentFocusMapName, guardSharingStructureMutation, updateMapRotationAngle],
  );

  const currentMapTabViewport = useMemo((): MapViewportState | undefined => {
    if (!activeEventName || !isMapTab || !currentMapTabName) return undefined;
    return mapViewportSettings[activeEventName]?.[currentMapTabName];
  }, [activeEventName, isMapTab, currentMapTabName, mapViewportSettings]);

  const handleMapViewportChange = useCallback(
    (viewport: MapViewportState) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      setMapViewportSettings((prev: MapViewportSettingsStore) => {
        const eventSettings = prev[activeEventName] || {};
        const current = eventSettings[currentMapTabName];
        if (
          current &&
          current.zoomLevel === viewport.zoomLevel &&
          current.offsetX === viewport.offsetX &&
          current.offsetY === viewport.offsetY
        ) {
          return prev;
        }
        return {
          ...prev,
          [activeEventName]: {
            ...eventSettings,
            [currentMapTabName]: viewport,
          },
        };
      });
    },
    [activeEventName, isMapTab, currentMapTabName],
  );

  const { showHeaderBar, showTabBar, rawHideSomething } = useMemo(() => {
    if (!activeEventName) {
      return { showHeaderBar: true, showTabBar: true, rawHideSomething: false };
    }
    const layout = layoutMode === 'smartphone' ? 'sp' : 'pc';
    let rawHeader = true,
      rawTabBar = true;

    if (currentMode === 'focus') {
      const key =
        `focus_${layout}_${focusModeMapVisible ? 'mapOn' : 'mapOff'}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    } else if (currentMode === 'execute') {
      const key = `execute_${layout}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    }

    const hideSomething = !rawHeader || !rawTabBar;
    if (uiVisibilityOverride) {
      return { showHeaderBar: true, showTabBar: true, rawHideSomething: hideSomething };
    }
    return { showHeaderBar: rawHeader, showTabBar: rawTabBar, rawHideSomething: hideSomething };
  }, [
    uiVisibilityOverride,
    activeEventName,
    currentMode,
    layoutMode,
    focusModeMapVisible,
    uiVisibilitySettings,
  ]);

  const updateUIVisibilityConfig = useCallback(
    (key: keyof UIVisibilitySettings, field: 'header' | 'tabBar', value: boolean) => {
      setUiVisibilitySettings((prev) => ({
        ...prev,
        [key]: {
          ...DEFAULT_UI_VISIBILITY[key],
          ...prev[key],
          [field]: value,
        },
      }));
      setUiVisibilityOverride(false);
    },
    [setUiVisibilitySettings],
  );

  const handleBulkAdd = useCallback(
    async (
      eventName: string,
      newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[],
      metadata?: BulkAddMetadata,
    ) => {
      const sharingSession =
        activeSharingSession?.eventName === eventName ? activeSharingSession : null;
      const isNewEvent = !eventLists[eventName];
      const isSharedSingleAppCreate =
        !!sharingSession &&
        !isNewEvent &&
        newItemsData.length === 1 &&
        metadata?.source === 'app' &&
        !metadata.url &&
        !hasBulkAddLayoutInfo(metadata);

      if (eventLists[eventName] && !isSharedSingleAppCreate && guardSharingStructureMutation(eventName)) return;
      const newItems = buildBulkAddItems(newItemsData, metadata);

      if (sharingSession && isSharedSingleAppCreate) {
        const createdItem = newItems[0];
        if (!createdItem) return;

        setSharingBusy(true);
        setSharingStatusMessage('共有アイテムを追加しています。');
        setSharingErrorMessage(null);
        try {
          const mutation = await upsertRoomItemWithRoute({
            roomId: sharingSession.roomId,
            localItemId: createdItem.id,
            fields: buildSharingCreateItemFields(createdItem),
            routeUpdates: [],
            expectedFieldClocks: {},
          });

          if (!mutation.ok) {
            setSharingErrorMessage(`共有アイテムの追加に失敗しました: ${mutation.error.code}`);
            return;
          }

          setEventLists((prevLists) => {
            const currentItems: ShoppingItem[] = prevLists[eventName] || [];
            return {
              ...prevLists,
              [eventName]: [
                ...currentItems,
                mergeSnapshotRoomItemIntoShoppingItem(createdItem, mutation.data.item),
              ],
            };
          });

          await saveSharingMutationVersion(sharingSession, mutation.data.itemsVersion, [
            mutation.data.item,
          ], {
            routeOrderVersions: mutation.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
          });

          const uiPlan = buildBulkAddUiPlan(eventName, [createdItem], false, eventLists[eventName] || []);
          setSharingStatusMessage('共有アイテムを追加しました。');
          if (uiPlan.nextActiveTab) {
            setActiveTab(uiPlan.nextActiveTab);
          }
        } catch (error) {
          console.error('Sharing single item add error:', error);
          setSharingErrorMessage('共有アイテムの追加に失敗しました。通信状態を確認してください。');
        } finally {
          setSharingBusy(false);
        }
        return;
      }

      if (hasBulkAddLayoutInfo(metadata) && isNewEvent) {
        const { sortedItems, executeModeItems } = buildLayoutAppliedEventItems(
          newItems,
          metadata.layoutInfo,
        );
        setEventLists((prevLists) => ({
          ...prevLists,
          [eventName]: sortedItems,
        }));
        updateExecuteModeItems((prev) => ({
          ...prev,
          [eventName]: executeModeItems,
        }));
      } else {
        setEventLists((prevLists) => {
          const currentItems: ShoppingItem[] = prevLists[eventName] || [];
          return {
            ...prevLists,
            [eventName]: [...currentItems, ...newItems],
          };
        });
      }

      const eventMeta = buildBulkAddEventMetadata(metadata);
      if (eventMeta) {
        setEventMetadata((prev) => ({
          ...prev,
          [eventName]: eventMeta,
        }));
      }

      if (isNewEvent) {
        const initialDayModes = buildInitialDayModesForBulkAdd(newItems);
        setDayModes((prev) => ({
          ...prev,
          [eventName]: initialDayModes,
        }));

        if (!hasBulkAddLayoutInfo(metadata)) {
          const initialExecuteItems = buildInitialExecuteItemsForBulkAdd(newItems);
          updateExecuteModeItems((prev) => ({
            ...prev,
            [eventName]: initialExecuteItems,
          }));
        }
      }

      const uiPlan = buildBulkAddUiPlan(
        eventName,
        newItems,
        isNewEvent,
        eventLists[eventName] || [],
      );
      alert(uiPlan.alertMessage);

      if (uiPlan.nextActiveEventName) {
        setActiveEventName(uiPlan.nextActiveEventName);
      }
      if (uiPlan.nextActiveTab) {
        setActiveTab(uiPlan.nextActiveTab);
      }
    },
    [
      activeSharingSession,
      eventLists,
      guardSharingStructureMutation,
      saveSharingMutationVersion,
    ],
  );

  const handleUpdateItem = useCallback(
    async (updatedItem: ShoppingItem) => {
      if (!activeEventName) return;
      const sharingSession = activeSharingSession;

      if (sharingSession) {
        const currentItems = eventLists[activeEventName] || [];
        const currentItem = currentItems.find((item) => item.id === updatedItem.id);
        if (!currentItem) return;
        const editBaselineItem =
          editDialogItem?.id === updatedItem.id ? editDialogItem : currentItem;
        const editBaselineFieldClocks =
          editFieldClockBaselineByItemId[updatedItem.id] ??
          sharingSession.fieldClocksByItemId?.[updatedItem.id];

        if (hasSharingAssignmentOrLockChange(editBaselineItem, updatedItem)) {
          alert(
            '共有中の担当者や購入確保は専用の操作から変更してください。',
          );
          return;
        }

        const structuralFields = buildSharingStructuralItemFields(editBaselineItem, updatedItem);
        const hasStructuralChanges = Object.keys(structuralFields).length > 0;
        const routeDateMoveToCandidate = isSharingRouteDateMoveToCandidate(
          currentItem,
          updatedItem,
        );
        if (
          isRouteAffectingItemPlacementChange(currentItem, updatedItem) &&
          !routeDateMoveToCandidate
        ) {
          alert(
            '巡回順への追加・削除は、巡回順の操作から変更してください。',
          );
          return;
        }

        const fields = buildSharingMutableItemFields(editBaselineItem, updatedItem);
        const purchaseChanged = editBaselineItem.purchaseStatus !== updatedItem.purchaseStatus;
        const hasFieldChanges = Object.keys(fields).length > 0;

        if (hasStructuralChanges && (hasFieldChanges || purchaseChanged)) {
          alert(
            '共有中は構造項目と購入・価格項目を同時に保存できません。どちらか一方ずつ保存してください。',
          );
          return;
        }

        if (hasStructuralChanges) {
          const expectedFieldClocks = pickExpectedFieldClocksFrom(
            editBaselineFieldClocks,
            Object.keys(structuralFields),
          );
          if (!expectedFieldClocks) {
            setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }

          const routeUpdates = routeDateMoveToCandidate
            ? (() => {
                if (!currentItem.eventDate) return null;
                const currentRouteItemIds =
                  executeModeItemsRef.current[activeEventName]?.[currentItem.eventDate] ?? [];
                return [
                  {
                    eventDate: currentItem.eventDate,
                    itemIds: currentRouteItemIds.filter((itemId) => itemId !== currentItem.id),
                    expectedVersion: sharingSession.routeOrderVersions[currentItem.eventDate] ?? 0,
                  },
                ];
              })()
            : buildSharingStructuralRouteUpdates(
                currentItem,
                updatedItem,
                currentItems,
                executeModeItemsRef.current[activeEventName] || {},
                sharingSession.routeOrderVersions,
              );

          if (routeUpdates === null) {
            setSharingErrorMessage('巡回順に入っている共有アイテムの日付が不明です。最新状態を取得します。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }

          setSharingBusy(true);
          setSharingStatusMessage('共有アイテムを更新しています。');
          setSharingErrorMessage(null);
          try {
            const result = await upsertRoomItemWithRoute({
              roomId: sharingSession.roomId,
              localItemId: updatedItem.id,
              fields: structuralFields,
              routeUpdates,
              expectedFieldClocks,
            });

            if (!result.ok) {
              if (isFullItemRefreshRequired(result.error.code)) {
                setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
                await applySnapshotAndAck(sharingSession.roomId);
                return;
              }
              if (
                result.error.code === 'FIELD_CLOCK_CONFLICT' ||
                result.error.code === 'ROUTE_ORDER_CONFLICT'
              ) {
                setSharingErrorMessage(
                  '他の参加者が先に更新しました。最新状態を取得しました。',
                );
                await applySnapshotAndAck(sharingSession.roomId);
                return;
              }
              setSharingErrorMessage(`共有アイテムの更新に失敗しました: ${result.error.code}`);
              return;
            }

            setEventLists((prev) => {
              const items = prev[activeEventName] || [];
              const changedRouteOrders = result.data.changedRouteOrders ?? [];
              const updatedItems = items.map((item) =>
                item.id === updatedItem.id
                  ? mergeSnapshotRoomItemIntoShoppingItem(item, result.data.item)
                  : item,
              );
              const nextItems = applyCanonicalRouteOrdersToItems(updatedItems, changedRouteOrders);
              return {
                ...prev,
                [activeEventName]: nextItems,
              };
            });

            const changedRouteOrders = result.data.changedRouteOrders ?? [];
            if (changedRouteOrders.length > 0) {
              updateExecuteModeItems((prev) => ({
                ...prev,
                [activeEventName]: {
                  ...(prev[activeEventName] ?? {}),
                  ...Object.fromEntries(
                    changedRouteOrders.map((routeOrder) => [
                      routeOrder.eventDate,
                      routeOrder.itemIds,
                    ]),
                  ),
                },
              }));
            }
            const changedRouteOrderAcks = Object.fromEntries(
              changedRouteOrders.map((routeOrder) => [
                routeOrder.eventDate,
                routeOrder.dateRouteOrderVersion,
              ]),
            );
            const pendingRouteOrderAcks = mergePendingRouteOrderAcks(
              sharingSession.pendingRouteOrderAcks,
              changedRouteOrderAcks,
              'mutation',
              new Date().toISOString(),
            );
            await saveSharingMutationVersion(sharingSession, result.data.itemsVersion, [
              result.data.item,
            ], {
              routeOrderVersions: result.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
              pendingRouteOrderAcks,
            });
            if (changedRouteOrders.length > 0) {
              await ackSavedRouteOrderVersions(
                sharingSession,
                result.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
                pendingRouteOrderAcks,
              );
            }
            setSharingStatusMessage(
              routeDateMoveToCandidate
                ? '共有アイテムを新しい参加日の候補へ移動しました。'
                : '共有アイテムを更新しました。',
            );
          } catch (error) {
            console.error('Sharing item structural update error:', error);
            setSharingErrorMessage('共有アイテムの更新に失敗しました。通信状態を確認してください。');
          } finally {
            setSharingBusy(false);
          }
          return;
        }

        if (!hasFieldChanges && !purchaseChanged) return;

        const expectedFieldClocks = pickExpectedFieldClocksFrom(
          editBaselineFieldClocks,
          buildPurchaseExpectedClockFields(
            fields,
            purchaseChanged ? updatedItem.purchaseStatus : null,
          ),
        );
        if (!expectedFieldClocks) {
          setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
          await applySnapshotAndAck(sharingSession.roomId);
          return;
        }

        setSharingBusy(true);
        setSharingStatusMessage('共有アイテムを更新しています。');
        setSharingErrorMessage(null);
        try {
          const result = await updateRoomItemWithPurchase({
            roomId: sharingSession.roomId,
            localItemId: updatedItem.id,
            fields,
            status: purchaseChanged ? updatedItem.purchaseStatus : null,
            actualPurchaseQuantity:
              purchaseChanged && updatedItem.purchaseStatus === 'LimitedPurchase'
                ? updatedItem.limitedPurchasedQuantity ?? null
                : null,
            expectedFieldClocks,
          });

          if (!result.ok) {
            if (isFullItemRefreshRequired(result.error.code)) {
              setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (result.error.code === 'PERMISSION_DENIED') {
              setSharingErrorMessage(
                '他の参加者が先に購入確保しました。価格変更も含めて反映せず、最新状態を取得しました。',
              );
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (result.error.code === 'FIELD_CLOCK_CONFLICT') {
              setSharingErrorMessage(
                '他の参加者が同じ項目を先に更新しました。最新状態を取得しました。',
              );
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`共有アイテムの更新に失敗しました: ${result.error.code}`);
            return;
          }

          setEventLists((prev) => {
            const items = prev[activeEventName] || [];
            return {
              ...prev,
              [activeEventName]: items.map((item) =>
                item.id === updatedItem.id
                  ? mergeSnapshotRoomItemIntoShoppingItem(item, result.data.item)
                  : item,
              ),
            };
          });

          if (
            result.data.changedFields.includes('purchaseStatus') ||
            result.data.changedFields.includes('actualPurchaseQuantity') ||
            result.data.changedFields.includes('quantity')
          ) {
            setRecentlyChangedItemIds((prevIds) => new Set(prevIds).add(updatedItem.id));
          }

          await saveSharingMutationVersion(sharingSession, result.data.itemsVersion, [
            result.data.item,
          ]);
          setSharingStatusMessage('共有アイテムを更新しました。');
        } catch (error) {
          console.error('Sharing item update error:', error);
          setSharingErrorMessage('共有アイテムの更新に失敗しました。通信状態を確認してください。');
        } finally {
          setSharingBusy(false);
        }
        return;
      }

      if (guardSharingStructureMutation(activeEventName)) return;

      const currentEventDate = activeEventDate;
      const currentMode = dayModes[activeEventName]?.[currentEventDate];

      setEventLists((prev) => {
        const currentItems = prev[activeEventName] || [];
        const currentItem = currentItems.find((item) => item.id === updatedItem.id);

        const result = computeUpdateItem(
          currentItems,
          updatedItem,
          currentMode as ViewMode | undefined,
          currentItem?.protectionLevel,
          currentItem?.source,
        );

        if (result.purchaseStatusChanged || result.purchaseQuantityChanged) {
          setRecentlyChangedItemIds((prevIds) => new Set(prevIds).add(updatedItem.id));
        }

        return {
          ...prev,
          [activeEventName]: result.items,
        };
      });
    },
    [
      activeEventName,
      activeSharingSession,
      activeEventDate,
      ackSavedRouteOrderVersions,
      applySnapshotAndAck,
      dayModes,
      editDialogItem,
      editFieldClockBaselineByItemId,
      eventLists,
      guardSharingStructureMutation,
      saveSharingMutationVersion,
      updateExecuteModeItems,
    ],
  );

  const saveSharingRouteOrderMutation = useCallback(
    async (
      session: SharingSessionMetadata,
      eventName: string,
      eventDate: string,
      itemIds: string[],
      successMessage: string,
      assignmentRouteLockMode: SharingRouteOrderLockMode = 'reject',
    ): Promise<boolean> => {
      const resolvedItemIds = (() => {
        if (assignmentRouteLockMode === 'allow') return itemIds;

        const currentRouteItemIds =
          executeModeItemsRef.current[eventName]?.[eventDate] ?? [];
        const eventItems = eventListsRef.current[eventName] ?? [];
        const normalizedItemIds = normalizeExecuteIdsByAssignmentRouteLock(
          currentRouteItemIds,
          itemIds,
          eventItems,
        );

        if (
          assignmentRouteLockMode === 'reject' &&
          !areStringArraysEqual(itemIds, normalizedItemIds)
        ) {
          setSharingErrorMessage(
            '担当者ルートをまたぐ個別移動はできません。担当ルート順序から変更してください。',
          );
          return null;
        }

        return normalizedItemIds;
      })();
      if (!resolvedItemIds) return false;

      const expectedVersion = session.routeOrderVersions[eventDate] ?? 0;
      setSharingBusy(true);
      setSharingErrorMessage(null);
      try {
        const result = await updateRouteOrder({
          roomId: session.roomId,
          eventDate,
          itemIds: resolvedItemIds,
          expectedVersion,
        });

        if (!result.ok) {
          if (isFullItemRefreshRequired(result.error.code)) {
            setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
            await applySnapshotAndAck(session.roomId);
            return false;
          }
          setSharingErrorMessage(`巡回順の更新に失敗しました: ${result.error.code}`);
          if (result.error.code === 'ROUTE_ORDER_CONFLICT') {
            void synchronizeSharingSession(session.sessionId, 'manual');
          }
          return false;
        }

        const confirmedRouteOrder = {
          eventDate: result.data.eventDate,
          itemIds: result.data.itemIds,
        };
        updateExecuteModeItems((prev) => ({
          ...prev,
          [eventName]: {
            ...(prev[eventName] ?? {}),
            [confirmedRouteOrder.eventDate]: confirmedRouteOrder.itemIds,
          },
        }));
        setEventLists((prev) => {
          const items = prev[eventName] ?? [];
          const nextItems = applyCanonicalRouteOrderToItems(items, confirmedRouteOrder);
          return nextItems === items
            ? prev
            : {
                ...prev,
                [eventName]: nextItems,
              };
        });

        const latestSession = sharingSessionsRef.current[session.sessionId] ?? session;
        const pendingRouteOrderAcks = mergePendingRouteOrderAcks(
          latestSession.pendingRouteOrderAcks,
          { [confirmedRouteOrder.eventDate]: result.data.dateRouteOrderVersion },
          'reorder',
          new Date().toISOString(),
        );
        await saveSharingSessionState({
          ...latestSession,
          routeOrderVersions: result.data.routeOrderVersions,
          pendingRouteOrderAcks,
          lastAckAt: new Date().toISOString(),
        });
        await ackSavedRouteOrderVersions(
          latestSession,
          result.data.routeOrderVersions,
          pendingRouteOrderAcks,
        );
        setSharingStatusMessage(successMessage);
        return true;
      } catch (error) {
        console.error('Sharing route order update error:', error);
        setSharingErrorMessage('巡回順の更新に失敗しました。通信状態を確認してください。');
        return false;
      } finally {
        setSharingBusy(false);
      }
    },
    [
      ackSavedRouteOrderVersions,
      applySnapshotAndAck,
      saveSharingSessionState,
      synchronizeSharingSession,
      updateExecuteModeItems,
    ],
  );

  const handleMoveItem = useCallback(
    async (
      dragId: string,
      hoverId: string,
      targetColumn?: 'execute' | 'candidate',
      sourceColumn?: 'execute' | 'candidate',
    ) => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const effectiveSelectedIds = spaceGroupIds
        ? new Set(spaceGroupIds)
        : selectedItemIds;
      spaceGroupDragItemIdsRef.current = null;

      const currentEventExecuteItems = executeModeItemsRef.current[activeEventName] || {};
      const currentExecuteItems = currentEventExecuteItems[currentEventDate]
        ? {
            ...currentEventExecuteItems,
            [currentEventDate]: [...(currentEventExecuteItems[currentEventDate] || [])],
          }
        : currentEventExecuteItems;

      const selectionSpansMultipleSpaces = (() => {
        if (effectiveSelectedIds.size <= 1) return false;
        const spaceKeys = new Set<string>();
        effectiveSelectedIds.forEach((id) => {
          const item = (eventLists[activeEventName] || []).find((i) => i.id === id);
          if (item) spaceKeys.add(getSpaceKey(item.block, item.number));
        });
        return spaceKeys.size > 1;
      })();
      const hallCheck = (spaceGroupIds || selectionSpansMultipleSpaces)
        ? (id1: string, id2: string) => areItemsInSameHallGroup(id1, id2, currentEventDate)
        : (id1: string, id2: string) => areItemsInSameHall(id1, id2, currentEventDate);

      const result = computeMoveItem({
        dragId,
        hoverId,
        targetColumn,
        sourceColumn,
        mode: mode as ViewMode | undefined,
        effectiveSelectedIds,
        allItems: eventLists[activeEventName] || [],
        executeModeItems: currentExecuteItems,
        dayName: currentEventDate,
        selectedBlockFilters,
        areItemsInSameHall: hallCheck,
      });

      if (sharingSession && result.executeModeItems) {
        const nextItemIds = result.executeModeItems[currentEventDate] ?? [];
        const previousItemIds = currentExecuteItems[currentEventDate] ?? [];
        const previousItemIdSet = new Set(previousItemIds);
        const addedItemIds = nextItemIds.filter((itemId) => !previousItemIdSet.has(itemId));
        const isCandidateToExecute =
          sourceColumn === 'candidate' && targetColumn === 'execute';
        const saved = await saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          currentEventDate,
          nextItemIds,
          isCandidateToExecute
            ? '共有アイテムを巡回順に追加しました。'
            : sourceColumn === 'execute' && targetColumn === 'candidate'
              ? '共有アイテムを候補へ移動しました。'
              : '巡回順を更新しました。',
          isCandidateToExecute
            ? 'normalize'
            : sourceColumn === 'execute' && targetColumn === 'candidate'
              ? 'normalize'
              : 'reject',
        );
        if (saved && isCandidateToExecute) {
          await assignSharingRouteItemsToCurrentMember(
            sharingSession,
            activeEventName,
            addedItemIds,
            '共有アイテムを巡回順に追加し、担当者を更新しました。',
          );
        }
        return;
      }

      if (result.eventListItems) {
        setEventLists((prev) => ({ ...prev, [activeEventName]: result.eventListItems! }));
      }
      if (result.executeModeItems) {
        updateExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems! }));
      }
    },
    [
      activeEventName,
      selectedItemIds,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      selectedBlockFilters,
      eventLists,
      areItemsInSameHall,
      areItemsInSameHallGroup,
      activeSharingSession,
      assignSharingRouteItemsToCurrentMember,
      guardSharingStructureMutation,
      saveSharingRouteOrderMutation,
    ],
  );
  const handleMoveItemVerticalInternal = useCallback(
    async (direction: 'up' | 'down', itemId: string, targetColumn?: 'execute' | 'candidate') => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];
      const currentEventExecuteItems = executeModeItemsRef.current[activeEventName] || {};

      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const isSpaceGroupMove = !!spaceGroupIds;

      if (mode === 'edit' && targetColumn === 'execute') {
        const dayItems = [...(currentEventExecuteItems[currentEventDate] || [])];
        const getItemSpacePriorityKey = (id: string): string => {
          const item = items.find((i) => i.id === id);
          return item ? `${getSpaceKey(item.block, item.number)}::${item.priorityLevel || 'none'}` : '';
        };

        const effectiveIds = spaceGroupIds ? new Set(spaceGroupIds) : selectedItemIds;
        const movingGroupKeys = new Set<string>();
        movingGroupKeys.add(getItemSpacePriorityKey(itemId));
        effectiveIds.forEach((id) => {
          if (dayItems.includes(id)) {
            movingGroupKeys.add(getItemSpacePriorityKey(id));
          }
        });

        const movingIndices = dayItems
          .map((id, idx) => movingGroupKeys.has(getItemSpacePriorityKey(id)) ? idx : -1)
          .filter((idx) => idx >= 0);

        if (movingIndices.length > 0) {
          const movingStart = movingIndices[0];
          const movingEnd = movingIndices[movingIndices.length - 1];

          const adjacentIndex = direction === 'up' ? movingStart - 1 : movingEnd + 1;
          if (adjacentIndex >= 0 && adjacentIndex < dayItems.length) {
            const adjacentId = dayItems[adjacentIndex];
            const adjacentGroupKey = getItemSpacePriorityKey(adjacentId);

            if (!movingGroupKeys.has(adjacentGroupKey)) {
              let adjStart = adjacentIndex;
              let adjEnd = adjacentIndex;
              while (adjStart > 0 && getItemSpacePriorityKey(dayItems[adjStart - 1]) === adjacentGroupKey) adjStart--;
              while (adjEnd < dayItems.length - 1 && getItemSpacePriorityKey(dayItems[adjEnd + 1]) === adjacentGroupKey) adjEnd++;

              const movingBlock = dayItems.slice(movingStart, movingEnd + 1);
              const remaining = [...dayItems.slice(0, movingStart), ...dayItems.slice(movingEnd + 1)];

              const adjItemIdx = remaining.findIndex((id) => id === adjacentId);
              if (adjItemIdx >= 0) {
                let insertIdx: number;
                if (direction === 'up') {
                  let targetStart = adjItemIdx;
                  while (targetStart > 0 && getItemSpacePriorityKey(remaining[targetStart - 1]) === adjacentGroupKey) targetStart--;
                  insertIdx = targetStart;
                } else {
                  let targetEnd = adjItemIdx;
                  while (targetEnd < remaining.length - 1 && getItemSpacePriorityKey(remaining[targetEnd + 1]) === adjacentGroupKey) targetEnd++;
                  insertIdx = targetEnd + 1;
                }

                remaining.splice(insertIdx, 0, ...movingBlock);

                if (sharingSession) {
                  await saveSharingRouteOrderMutation(
                    sharingSession,
                    activeEventName,
                    currentEventDate,
                    remaining,
                    '巡回順を更新しました。',
                  );
                } else {
                  updateExecuteModeItems((prev) => ({
                    ...prev,
                    [activeEventName]: {
                      ...prev[activeEventName],
                      [currentEventDate]: remaining,
                    },
                  }));
                }
                return;
              }
            }
          }
        }
      }

      const effectiveSelectedIds = spaceGroupIds
        ? new Set(spaceGroupIds)
        : selectedItemIds;
      const hallCheck = spaceGroupIds
        ? (id1: string, id2: string) => areItemsInSameHallGroup(id1, id2, currentEventDate)
        : (id1: string, id2: string) => areItemsInSameHall(id1, id2, currentEventDate);

      const result = computeMoveItemVertical(
        direction,
        itemId,
        targetColumn,
        mode as ViewMode | undefined,
        effectiveSelectedIds,
        eventLists[activeEventName] || [],
        currentEventExecuteItems,
        currentEventDate,
        hallCheck,
      );

      if (sharingSession && result.executeModeItems) {
        await saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          currentEventDate,
          result.executeModeItems[currentEventDate] ?? [],
          '巡回順を更新しました。',
        );
        return;
      }

      if (result.eventListItems) {
        setEventLists((prev) => ({ ...prev, [activeEventName]: result.eventListItems! }));
      }
      if (result.executeModeItems) {
        updateExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems! }));
      }
    },
    [
      activeEventName,
      selectedItemIds,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      eventLists,
      items,
      areItemsInSameHall,
      areItemsInSameHallGroup,
      activeSharingSession,
      guardSharingStructureMutation,
      saveSharingRouteOrderMutation,
    ],
  );

  const handleMoveItemUp = useCallback(
    (itemId: string, targetColumn?: 'execute' | 'candidate') =>
      handleMoveItemVerticalInternal('up', itemId, targetColumn),
    [handleMoveItemVerticalInternal],
  );

  const handleMoveItemDown = useCallback(
    (itemId: string, targetColumn?: 'execute' | 'candidate') =>
      handleMoveItemVerticalInternal('down', itemId, targetColumn),
    [handleMoveItemVerticalInternal],
  );

  const expandToFullSpaceGroups = useCallback(
    (itemIds: string[]): string[] => {
      return expandSameSpacePriorityItemIds(itemIds, items);
    },
    [items],
  );

  const handleMoveToExecuteColumn = useCallback(
    async (itemIds: string[]) => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;

      const currentEventDate = activeEventDate;

      const expandedIds = expandToFullSpaceGroups(itemIds);

      if (
        rangeStart &&
        expandedIds.includes(rangeStart.itemId) &&
        rangeStart.columnType === 'candidate'
      ) {
        setRangeStart(null);
        setRangeEnd(null);
      } else if (
        rangeEnd &&
        expandedIds.includes(rangeEnd.itemId) &&
        rangeEnd.columnType === 'candidate'
      ) {
        setRangeEnd(null);
      }

      if (sharingSession && activeRouteScope === 'member' && activeRouteMemberId) {
        const eventItems = eventListsRef.current[activeEventName] ?? [];
        const targetIds = new Set(expandedIds);
        const targetItems = eventItems.filter((item) => targetIds.has(item.id));
        const assignedToOtherMember = targetItems.find(
          (item) => item.assignedTo && item.assignedTo !== activeRouteMemberId,
        );
        if (assignedToOtherMember && sharingSession.role !== 'host') {
          setSharingErrorMessage('他の参加者の担当アイテムは個人ルートへ追加できません。');
          return;
        }

        const assignmentTargets = targetItems.filter(
          (item) => item.assignedTo !== activeRouteMemberId,
        );
        const assignments = [];
        for (const item of assignmentTargets) {
          const expectedFieldClocks = pickExpectedFieldClocks(sharingSession, item.id, [
            'assignedTo',
          ]);
          if (!expectedFieldClocks) {
            setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }
          assignments.push({
            localItemId: item.id,
            assignedToMemberId: activeRouteMemberId,
            expectedFieldClocks,
          });
        }

        const memberRouteUpdates = buildSharingMemberRouteUpdatesForAssignment(
          sharingSession,
          activeEventName,
          expandedIds,
          activeRouteMemberId,
        );
        setSharingBusy(true);
        setSharingErrorMessage(null);
        try {
          const result = await updateRoomItemAssignmentWithMemberRoutes({
            roomId: sharingSession.roomId,
            assignments,
            memberRouteUpdates,
          });
          if (!result.ok) {
            if (isFullItemRefreshRequired(result.error.code)) {
              setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (
              result.error.code === 'FIELD_CLOCK_CONFLICT' ||
              result.error.code === 'ROUTE_ORDER_CONFLICT'
            ) {
              setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`個人ルートへの追加に失敗しました: ${result.error.code}`);
            return;
          }

          await applySharingAssignmentWithMemberRoutesResult(
            sharingSession,
            activeEventName,
            result.data,
            '個人ルートへ追加しました。',
          );
        } catch (error) {
          console.error('Sharing member route add error:', error);
          setSharingErrorMessage('個人ルートへの追加に失敗しました。通信状態を確認してください。');
          return;
        } finally {
          setSharingBusy(false);
        }
        setSelectedItemIds(new Set());
        return;
      }

      const nextExecuteModeItems = computeMoveToExecuteColumn(
        expandedIds,
        currentEventDate,
        items,
        executeModeItemsRef.current[activeEventName] || {},
        selectedBlockFilters,
      );

      if (sharingSession) {
        const previousItemIds =
          executeModeItemsRef.current[activeEventName]?.[currentEventDate] ?? [];
        const previousItemIdSet = new Set(previousItemIds);
        const addedItemIds = (nextExecuteModeItems[currentEventDate] ?? []).filter(
          (itemId) => !previousItemIdSet.has(itemId),
        );
        const saved = await saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          currentEventDate,
          nextExecuteModeItems[currentEventDate] ?? [],
          '共有アイテムを巡回順に追加しました。',
          'normalize',
        );
        if (!saved) return;
        const assigned = await assignSharingRouteItemsToCurrentMember(
          sharingSession,
          activeEventName,
          addedItemIds,
          '共有アイテムを巡回順に追加し、担当者を更新しました。',
        );
        if (!assigned) return;
      } else {
        updateExecuteModeItems((prev) => ({
          ...prev,
          [activeEventName]: computeMoveToExecuteColumn(
            expandedIds,
            currentEventDate,
            items,
            prev[activeEventName] || {},
            selectedBlockFilters,
          ),
        }));
      }

      setSelectedItemIds(new Set());
    },
    [
      activeEventName,
      activeTab,
      eventDates,
      rangeStart,
      rangeEnd,
      items,
      executeModeItems,
      selectedBlockFilters,
      expandToFullSpaceGroups,
      activeSharingSession,
      activeRouteMemberId,
      activeRouteScope,
      applySharingAssignmentWithMemberRoutesResult,
      applySnapshotAndAck,
      assignSharingRouteItemsToCurrentMember,
      buildSharingMemberRouteUpdatesForAssignment,
      guardSharingStructureMutation,
      saveSharingRouteOrderMutation,
    ],
  );
  const handleRemoveFromExecuteColumn = useCallback(
    async (itemIds: string[]) => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;

      const currentEventDate = activeEventDate;

      const expandedIds = expandToFullSpaceGroups(itemIds);

      if (
        rangeStart &&
        expandedIds.includes(rangeStart.itemId) &&
        rangeStart.columnType === 'execute'
      ) {
        setRangeStart(null);
        setRangeEnd(null);
      } else if (
        rangeEnd &&
        expandedIds.includes(rangeEnd.itemId) &&
        rangeEnd.columnType === 'execute'
      ) {
        setRangeEnd(null);
      }

      if (sharingSession && activeRouteScope === 'member' && activeRouteMemberId) {
        const assignments = [];
        const eventItems = eventListsRef.current[activeEventName] ?? [];
        const targetIds = new Set(expandedIds);
        for (const item of eventItems.filter((candidate) => targetIds.has(candidate.id))) {
          if (!item.assignedTo) continue;
          const expectedFieldClocks = pickExpectedFieldClocks(sharingSession, item.id, [
            'assignedTo',
          ]);
          if (!expectedFieldClocks) {
            setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }
          assignments.push({
            localItemId: item.id,
            assignedToMemberId: null,
            expectedFieldClocks,
          });
        }

        const memberRouteUpdates = buildSharingMemberRouteUpdatesForAssignment(
          sharingSession,
          activeEventName,
          expandedIds,
          null,
        );
        setSharingBusy(true);
        setSharingErrorMessage(null);
        try {
          const result = await updateRoomItemAssignmentWithMemberRoutes({
            roomId: sharingSession.roomId,
            assignments,
            memberRouteUpdates,
          });
          if (!result.ok) {
            if (isFullItemRefreshRequired(result.error.code)) {
              setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (
              result.error.code === 'FIELD_CLOCK_CONFLICT' ||
              result.error.code === 'ROUTE_ORDER_CONFLICT'
            ) {
              setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`個人ルートからの移動に失敗しました: ${result.error.code}`);
            return;
          }

          await applySharingAssignmentWithMemberRoutesResult(
            sharingSession,
            activeEventName,
            result.data,
            '個人ルートから候補へ移動しました。',
          );
        } catch (error) {
          console.error('Sharing member route remove error:', error);
          setSharingErrorMessage('個人ルートからの移動に失敗しました。通信状態を確認してください。');
          return;
        } finally {
          setSharingBusy(false);
        }
        setSelectedItemIds(new Set());
        return;
      }

      const nextExecuteModeItems = computeRemoveFromExecuteColumn(
        expandedIds,
        executeModeItemsRef.current[activeEventName] || {},
        currentEventDate,
      );

      if (sharingSession) {
        const saved = await saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          currentEventDate,
          nextExecuteModeItems[currentEventDate] ?? [],
          '共有アイテムを候補へ移動しました。',
          'normalize',
        );
        if (!saved) return;
      } else {
        updateExecuteModeItems((prev) => ({
          ...prev,
          [activeEventName]: computeRemoveFromExecuteColumn(
            expandedIds,
            prev[activeEventName] || {},
            currentEventDate,
          ),
        }));
      }

      setSelectedItemIds(new Set());
    },
    [
      activeEventName,
      activeTab,
      eventDates,
      rangeStart,
      rangeEnd,
      executeModeItems,
      expandToFullSpaceGroups,
      activeSharingSession,
      activeRouteMemberId,
      activeRouteScope,
      applySharingAssignmentWithMemberRoutesResult,
      applySnapshotAndAck,
      buildSharingMemberRouteUpdatesForAssignment,
      guardSharingStructureMutation,
      saveSharingRouteOrderMutation,
    ],
  );

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;

    const currentEventDate = activeEventDate;
    if (!currentEventDate) {
      alert('参加日タブが選択されていないため、表示モードを切り替えできません。');
      return;
    }

    const currentModeValue = dayModes[activeEventName]?.[currentEventDate];
    if (!currentModeValue) {
      alert('表示モードが未設定のため、表示モードを切り替えできません。');
      return;
    }
    const newMode: ViewMode = currentModeValue === 'edit' ? 'execute' : 'edit';

    setDayModes((prev) => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: newMode,
      },
    }));

    setSelectedItemIds(new Set());
    setCandidateNumberSortDirection(null);
  }, [activeEventName, activeEventDate, dayModes]);


  const handleSetViewMode = useCallback(
    (mode: ViewMode, scrollToItemId?: string) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      setDayModes((prev) => ({
        ...prev,
        [activeEventName]: {
          ...(prev[activeEventName] || {}),
          [currentEventDate]: mode,
        },
      }));

      setSelectedItemIds(new Set());
      setCandidateNumberSortDirection(null);


      if (mode !== 'focus') {
        setFocusModeMapVisible(false);
      }
      setUiVisibilityOverride(false);
      setUiSettingsPanelOpen(false);


      if (scrollToItemId) {
        setTimeout(() => {
          const element = document.querySelector(`[data-item-id="${scrollToItemId}"]`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      }
    },
    [activeEventName, activeEventDate],
  );

  const handleSelectEvent = useCallback(
    (eventName: string) => {
      const eventItems = eventLists[eventName] || [];
      const nextTab = resolveEventListTab(eventItems);
      if (!nextTab) {
        alert('参加日がないため処理を停止しました。');
        return;
      }

      setActiveEventName(eventName);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());
      setActiveTab(nextTab);
    },
    [eventLists],
  );

  const handleDeleteEvent = useCallback(
    async (eventName: string) => {
      if (guardSharingStructureMutation(eventName)) return;
      try {
        await deleteSharingSessionsForEvent(eventName);
      } catch (error) {
        console.error('Sharing session delete error:', error);
        alert('共有セッション情報の削除に失敗しました。もう一度お試しください。');
        return;
      }
      setEventLists((prev) => removeRecordKey(prev, eventName));
      setEventMetadata((prev) => removeRecordKey(prev, eventName));
      updateExecuteModeItems((prev) => removeRecordKey(prev, eventName));
      setMemberRouteItems((prev) => removeRecordKey(prev, eventName));
      setDayModes((prev) => removeRecordKey(prev, eventName));
      setMapData((prev) => removeRecordKey(prev, eventName));
      setMapRotationSettings((prev) => removeRecordKey(prev, eventName));
      setRouteSettings((prev) => removeRecordKey(prev, eventName));
      setHallDefinitions((prev) => removeRecordKey(prev, eventName));
      setHallRouteSettings((prev) => removeRecordKey(prev, eventName));
      setFocusModeSessions((prev) => removeFocusModeSessionByEvent(prev, eventName));
      if (activeEventName === eventName) {
        setActiveEventName(null);
        setActiveTab('eventList');
      }
    },
    [activeEventName, deleteSharingSessionsForEvent, guardSharingStructureMutation],
  );

  const handleRenameEvent = useCallback((oldName: string) => {
    if (guardSharingStructureMutation(oldName)) return;
    setEventToRename(oldName);
    setShowRenameDialog(true);
  }, [guardSharingStructureMutation]);

  const handleConfirmRename = useCallback(
    (newName: string) => {
      if (!eventToRename) return;
      if (guardSharingStructureMutation(eventToRename)) return;

      if (eventToRename === newName) {
        setShowRenameDialog(false);
        setEventToRename(null);
        return;
      }

      if (eventLists[newName]) {
        alert('同名のイベントが既に存在します。別の名前を指定してください。');
        return;
      }

      setEventLists((prev) => renameRecordKey(prev, eventToRename, newName));

      setEventMetadata((prev) => renameRecordKey(prev, eventToRename, newName));

      setDayModes((prev) => renameRecordKey(prev, eventToRename, newName));

      updateExecuteModeItems((prev) => renameRecordKey(prev, eventToRename, newName));
      setMemberRouteItems((prev) => renameRecordKey(prev, eventToRename, newName));


      setMapData((prev) => renameRecordKey(prev, eventToRename, newName));
      setMapRotationSettings((prev) => renameRecordKey(prev, eventToRename, newName));


      setRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));


      setHallDefinitions((prev) => renameRecordKey(prev, eventToRename, newName));


      setHallRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));
      setFocusModeSessions((prev) => renameFocusModeSessionKeys(prev, eventToRename, newName));

      if (activeEventName === eventToRename) {
        setActiveEventName(newName);
      }

      setShowRenameDialog(false);
      setEventToRename(null);
    },
    [eventToRename, eventLists, activeEventName, guardSharingStructureMutation],
  );

  const handleSortToggle = () => {
    setSelectedItemIds(new Set());
    setBlockSortDirection(null);
    setRecentlyChangedItemIds(new Set());
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;
    if (guardSharingStructureMutation(activeEventName)) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;

      const itemsForTab = allItems.filter((item) => item.eventDate === currentTabKey);

      if (itemsForTab.length === 0) return prev;

      const sortedItemsForTab = [...itemsForTab].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      let sortedIndex = 0;
      const newItems = allItems.map((item) => {
        if (item.eventDate === currentTabKey) {
          return sortedItemsForTab[sortedIndex++];
        }
        return item;
      });

      return { ...prev, [activeEventName]: newItems };
    });

    setBlockSortDirection(nextDirection);
    setSelectedItemIds(new Set());
  };

  const handleBlockSortToggleCandidate = () => {
    if (!activeEventName) return;
    if (guardSharingStructureMutation(activeEventName)) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);


      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );

      if (candidateItems.length === 0) return prev;

      const sortedCandidateItems = [...candidateItems].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
      });


      const executeItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && executeIds.has(item.id),
      );


      const newItems = allItems.map((item) => {
        if (item.eventDate !== currentTabKey) {
          return item;
        }
        if (executeIds.has(item.id)) {
          return executeItems.shift() || item;
        } else {
          return sortedCandidateItems.shift() || item;
        }
      });

      return { ...prev, [activeEventName]: newItems };
    });

    setBlockSortDirection(nextDirection);
    setSelectedItemIds(new Set());
  };

  const handleEditRequest = (item: ShoppingItem) => {
    const sharingSession =
      activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
    const fieldClockBaseline = sharingSession?.fieldClocksByItemId?.[item.id];
    if (fieldClockBaseline) {
      setEditFieldClockBaselineByItemId((prev) => ({
        ...prev,
        [item.id]: { ...fieldClockBaseline },
      }));
    } else {
      setEditFieldClockBaselineByItemId((prev) => {
        if (!(item.id in prev)) return prev;
        return Object.fromEntries(
          Object.entries(prev).filter(([itemId]) => itemId !== item.id),
        );
      });
    }
    setEditDialogItem(item);
  };

  const handleDeleteRequest = useCallback((item: ShoppingItem) => {
    const sharingSession =
      activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
    if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;
    setItemToDelete(item);
  }, [activeEventName, activeSharingSession, guardSharingStructureMutation]);

  const handleDeleteItemFromMap = useCallback((itemId: string) => {
    const sharingSession =
      activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
    if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;
    const item = items.find((i) => i.id === itemId);
    if (item) setItemToDelete(item);
  }, [items, activeEventName, activeSharingSession, guardSharingStructureMutation]);

  const handleClearNewItemDefaults = useCallback(() => {
    setNewItemDefaults(null);
  }, []);

  const handleModeChangeFromFocus = useCallback(
    (mode: 'edit' | 'execute', lastItemId?: string) => handleSetViewMode(mode, lastItemId),
    [handleSetViewMode],
  );

  const handleConfirmDelete = async () => {
    if (!itemToDelete || !activeEventName) return;
    const sharingSession = activeSharingSession;

    if (sharingSession?.eventName === activeEventName) {
      const expectedFieldClocks = pickExpectedFieldClocks(
        sharingSession,
        itemToDelete.id,
        ['deletedAt', 'deletedBy'],
      );
      if (!expectedFieldClocks) {
        setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
        await applySnapshotAndAck(sharingSession.roomId);
        return;
      }

      const routeUpdates = hasSharingRouteMembership(itemToDelete)
        ? (() => {
            if (!itemToDelete.eventDate) return null;
            const currentRouteItemIds =
              executeModeItemsRef.current[activeEventName]?.[itemToDelete.eventDate] ?? [];
            return [
              {
                eventDate: itemToDelete.eventDate,
                itemIds: currentRouteItemIds.filter((itemId) => itemId !== itemToDelete.id),
                expectedVersion: sharingSession.routeOrderVersions[itemToDelete.eventDate] ?? 0,
              },
            ];
          })()
        : [];

      if (routeUpdates === null) {
        setSharingErrorMessage('巡回順に入っている共有アイテムの日付が不明です。最新状態を取得します。');
        await applySnapshotAndAck(sharingSession.roomId);
        return;
      }

      setSharingBusy(true);
      setSharingStatusMessage('共有アイテムを削除しています。');
      setSharingErrorMessage(null);
      try {
        const result = await deleteRoomItemWithRoute({
          roomId: sharingSession.roomId,
          localItemId: itemToDelete.id,
          routeUpdates,
          expectedFieldClocks,
        });

        if (!result.ok) {
          if (isFullItemRefreshRequired(result.error.code)) {
            setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }
          if (
            result.error.code === 'FIELD_CLOCK_CONFLICT' ||
            result.error.code === 'ROUTE_ORDER_CONFLICT'
          ) {
            setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }
          setSharingErrorMessage(`共有アイテムの削除に失敗しました: ${result.error.code}`);
          return;
        }

        const deleteResult = computeDeleteItem(
          eventLists[activeEventName] || [],
          itemToDelete.id,
          executeModeItemsRef.current[activeEventName] || {},
        );
        const changedRouteOrders = result.data.changedRouteOrders ?? [];
        const canonicalExecuteModeItems = {
          ...deleteResult.executeModeItems,
          ...Object.fromEntries(
            changedRouteOrders.map((routeOrder) => [routeOrder.eventDate, routeOrder.itemIds]),
          ),
        };
        const canonicalDeleteItems = applyCanonicalRouteOrdersToItems(
          deleteResult.items,
          changedRouteOrders,
        );
        setEventLists((prev) => ({ ...prev, [activeEventName]: canonicalDeleteItems }));
        updateExecuteModeItems((prev) => ({
          ...prev,
          [activeEventName]: canonicalExecuteModeItems,
        }));
        setMemberRouteItems((prev) => {
          const eventItems = prev[activeEventName];
          if (!eventItems) return prev;
          return {
            ...prev,
            [activeEventName]: removeDeletedIdsFromMemberRouteItems(
              eventItems,
              new Set([itemToDelete.id]),
            ),
          };
        });

        const changedRouteOrderAcks = Object.fromEntries(
          changedRouteOrders.map((routeOrder) => [
            routeOrder.eventDate,
            routeOrder.dateRouteOrderVersion,
          ]),
        );
        const pendingRouteOrderAcks = mergePendingRouteOrderAcks(
          sharingSession.pendingRouteOrderAcks,
          changedRouteOrderAcks,
          'mutation',
          new Date().toISOString(),
        );
        await saveSharingMutationVersion(sharingSession, result.data.itemsVersion, [
          result.data.item,
        ], {
          routeOrderVersions: result.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
          pendingRouteOrderAcks,
        });
        if (changedRouteOrders.length > 0) {
          await ackSavedRouteOrderVersions(
            sharingSession,
            result.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
            pendingRouteOrderAcks,
          );
        }
        setItemToDelete(null);
        setSharingStatusMessage('共有アイテムを削除しました。');
      } catch (error) {
        console.error('Sharing item delete error:', error);
        setSharingErrorMessage('共有アイテムの削除に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
      return;
    }

    if (guardSharingStructureMutation(activeEventName)) return;

    const result = computeDeleteItem(
      eventLists[activeEventName] || [],
      itemToDelete.id,
      executeModeItemsRef.current[activeEventName] || {},
    );

    setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
    updateExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems }));
    setMemberRouteItems((prev) => {
      const eventItems = prev[activeEventName];
      if (!eventItems) return prev;
      return {
        ...prev,
        [activeEventName]: removeDeletedIdsFromMemberRouteItems(
          eventItems,
          new Set([itemToDelete.id]),
        ),
      };
    });
    setItemToDelete(null);
  };

  const handleDoneEditing = () => {
    if (itemToEdit?.eventDate) {
      setItemToEdit(null);
      setActiveTab(itemToEdit.eventDate);
    } else {
      setItemToEdit(null);
      alert('参加日がないため処理を停止しました。');
      setActiveTab('eventList');
    }
  };

  const getListColumnItems = useCallback(
    (columnType: 'execute' | 'candidate', currentEventDate: string): ShoppingItem[] => {
      if (!activeEventName) return [];

      if (columnType === 'execute') {
        const executeIds =
          activeRouteScope === 'member'
            ? activeMemberRouteItemIds
            : executeModeItems[activeEventName]?.[currentEventDate] || [];
        const itemsMap = new Map(items.map((item) => [item.id, item]));
        return executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
      }

      const executeIds = new Set(
        activeRouteScope === 'member'
          ? activeMemberRouteItemIds
          : executeModeItems[activeEventName]?.[currentEventDate] || [],
      );
      let filtered = items.filter(
        (item) => item.eventDate === currentEventDate && !executeIds.has(item.id),
      );
      if (selectedBlockFilters.size > 0) {
        filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
      }
      return filtered;
    },
    [
      activeEventName,
      activeMemberRouteItemIds,
      activeRouteScope,
      executeModeItems,
      items,
      selectedBlockFilters,
    ],
  );

  const handleSelectItem = useCallback(
    (itemId: string, columnType?: 'execute' | 'candidate') => {
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const currentColumnType =
        columnType ||
        (activeEventName
          ? (activeRouteScope === 'member'
              ? activeMemberRouteItemIds.includes(itemId)
              : executeModeItems[activeEventName]?.[currentEventDate]?.includes(itemId))
            ? 'execute'
            : 'candidate'
          : 'execute');

      selectItemForRange(itemId, currentColumnType, getListColumnItems(currentColumnType, currentEventDate));
    },
    [
      activeTab,
      activeEventName,
      activeMemberRouteItemIds,
      activeRouteScope,
      executeModeItems,
      eventDates,
      getListColumnItems,
      selectItemForRange,
    ],
  );

  const handleSelectSpaceGroupForRange = useCallback(
    (firstItemId: string, allItemIds: string[], columnType: 'execute' | 'candidate') => {
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      selectSpaceGroupForRange(
        firstItemId,
        allItemIds,
        columnType,
        getListColumnItems(columnType, currentEventDate),
      );
    },
    [activeEventDate, getListColumnItems, selectSpaceGroupForRange],
  );

  const spaceGroupDragItemIdsRef = useRef<string[] | null>(null);

  const [showPostponeFilterButton, setShowPostponeFilterButton] = useState(false);
  const [showLateFilterButton, setShowLateFilterButton] = useState(false);
  const executeSpaceGroupOrderRef = useRef<string[]>([]);
  const executeColumnItemsRef = useRef<ShoppingItem[]>([]);
  const recentlyChangedItemIdsRef = useRef<Set<string>>(new Set());

  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<
    'asc' | 'desc' | null
  >(null);

  const handleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection = candidateNumberSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);


      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );


      let filteredCandidateItems = candidateItems;
      if (selectedBlockFilters.size > 0) {
        filteredCandidateItems = candidateItems.filter((item) =>
          selectedBlockFilters.has(item.block),
        );
      }

      if (filteredCandidateItems.length === 0) return prev;


      const sortedCandidateItems = [...filteredCandidateItems].sort((a, b) => {
        const comparison = a.number.localeCompare(b.number, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
      });


      const sortedCandidateMap = new Map(
        sortedCandidateItems.map((item, index) => [item.id, { item, sortIndex: index }]),
      );


      const otherItems: ShoppingItem[] = [];
      const candidateItemsToSort: {
        item: ShoppingItem;
        originalIndex: number;
        sortIndex: number;
      }[] = [];

      allItems.forEach((item, index) => {
        if (item.eventDate !== currentTabKey) {
          otherItems.push(item);
        } else if (executeIds.has(item.id)) {
          otherItems.push(item);
        } else if (sortedCandidateMap.has(item.id)) {
          const { item: sortedItem, sortIndex } = sortedCandidateMap.get(item.id)!;
          candidateItemsToSort.push({ item: sortedItem, originalIndex: index, sortIndex });
        } else {
          otherItems.push(item);
        }
      });

      candidateItemsToSort.sort((a, b) => a.sortIndex - b.sortIndex);


      const resultItems: ShoppingItem[] = [];
      let candidateIndex = 0;

      allItems.forEach((item) => {
        if (item.eventDate !== currentTabKey) {
          resultItems.push(item);
        } else if (executeIds.has(item.id)) {
          resultItems.push(item);
        } else if (sortedCandidateMap.has(item.id)) {
          resultItems.push(candidateItemsToSort[candidateIndex++].item);
        } else {
          resultItems.push(item);
        }
      });

      return {
        ...prev,
        [activeEventName]: resultItems,
      };
    });

    setCandidateNumberSortDirection(nextDirection);
    setSelectedItemIds(new Set());
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    selectedBlockFilters,
    candidateNumberSortDirection,
    eventDates,
  ]);

  const handleClearSelection = clearSelection;
  const handleToggleBlockFilter = toggleBlockFilter;
  const handleClearBlockFilters = clearBlockFilters;

  const handleToggleSpaceCollapse = useCallback((spaceKey: string) => {
    toggleCollapsedSpace(spaceKey);
  }, [toggleCollapsedSpace]);

  const handleToggleAllSpaceCollapse = useCallback((collapse: boolean) => {
    if (!collapse) {
      setCollapsedSpaces(new Set());
    } else {
      const allGroupKeys = new Set<string>();
      items
        .filter((item) => item.eventDate === activeEventDate)
        .forEach((item) => {
          const spaceKey = getSpaceKey(item.block, item.number);
          const priority = item.priorityLevel || 'none';
          const groupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
          allGroupKeys.add(groupKey);
        });
      setCollapsedSpaces(allGroupKeys);
    }
  }, [items, activeEventDate]);

  const handleExecuteToggleSpaceCollapse = useCallback((spaceKey: string) => {
    toggleExecuteCollapsedSpace(spaceKey);
  }, [toggleExecuteCollapsedSpace]);

  const handleExecuteToggleAllSpaceCollapse = useCallback((collapse: boolean) => {
    if (!collapse) {
      setExecuteCollapsedSpaces(new Set());
    } else {
      if (!activeEventName) return;
      const currentEventDate = activeEventDate;
      const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
      const itemsMap = new Map(items.map((item) => [item.id, item]));
      const allGroupKeys = new Set<string>();
      executeIds.forEach((id) => {
        const item = itemsMap.get(id);
        if (!item) return;
        const spaceKey = getSpaceKey(item.block, item.number);
        const priority = item.priorityLevel || 'none';
        const groupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
        allGroupKeys.add(groupKey);
      });
      setExecuteCollapsedSpaces(allGroupKeys);
    }
  }, [activeEventName, activeEventDate, executeModeItems, items]);

  const handleBulkStatusChange = useCallback(
    async (groupKey: string, targetStatus: PurchaseStatus, groupItems: ShoppingItem[]) => {
      if (!activeEventName) return;
      const allAlready = groupItems.every((item) => item.purchaseStatus === targetStatus);
      const newStatus: PurchaseStatus = allAlready ? 'None' : targetStatus;
      const targets = groupItems.filter(
        (item) => targetStatus !== 'LimitedPurchase' && item.purchaseStatus !== 'LimitedPurchase',
      );
      const changedItems = targets.filter((item) => item.purchaseStatus !== newStatus);

      const applyBulkProgressUi = (itemsToMark: ShoppingItem[]) => {
        setRecentlyChangedItemIds((prevIds) => {
          const next = new Set(prevIds);
          itemsToMark.forEach((item) => next.add(item.id));
          return next;
        });

        if (sortState === 'Manual' && newStatus !== 'None') {
          const groupOrder = executeSpaceGroupOrderRef.current;
          if (groupOrder.length > 0 && groupKey === groupOrder[groupOrder.length - 1]) {
            const currentItems = executeColumnItemsRef.current;
            const groupItemIds = new Set(itemsToMark.map((item) => item.id));
            const allNonNone = currentItems.every(
              (item) => groupItemIds.has(item.id) || item.purchaseStatus !== 'None',
            );
            if (allNonNone) setShowPostponeFilterButton(true);
          }
        }

        if (sortState === 'Postpone' && newStatus !== 'None') {
          const groupOrder = executeSpaceGroupOrderRef.current;
          if (groupOrder.length > 0 && groupKey === groupOrder[groupOrder.length - 1]) {
            const currentItems = executeColumnItemsRef.current;
            const groupItemIds = new Set(itemsToMark.map((item) => item.id));
            const recentIds = recentlyChangedItemIdsRef.current;
            const allVisibleNonNone = currentItems.every((item) => {
              if (groupItemIds.has(item.id)) return true;
              if (item.purchaseStatus !== 'Postpone' && !recentIds.has(item.id)) return true;
              return item.purchaseStatus !== 'None';
            });
            if (allVisibleNonNone) setShowLateFilterButton(true);
          }
        }
      };

      if (changedItems.length === 0) return;

      const sharingSession = activeSharingSession;
      if (sharingSession) {
        setSharingBusy(true);
        setSharingStatusMessage('共有アイテムをまとめて更新しています。');
        setSharingErrorMessage(null);
        try {
          const mutations = [];
          for (const item of changedItems) {
            const expectedFieldClocks = pickExpectedFieldClocks(
              sharingSession,
              item.id,
              buildPurchaseExpectedClockFields({}, newStatus),
            );
            if (!expectedFieldClocks) {
              setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }

            mutations.push({
              localItemId: item.id,
              fields: {},
              status: newStatus,
              actualPurchaseQuantity: null,
              expectedFieldClocks,
            });
          }

          const result = await bulkUpdateRoomItemsWithPurchase({
            roomId: sharingSession.roomId,
            mutations,
          });

          if (!result.ok) {
            if (isFullItemRefreshRequired(result.error.code)) {
              setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (result.error.code === 'PERMISSION_DENIED') {
              setSharingErrorMessage(
                '他の参加者が先に購入確保しました。まとめ変更を中断し、最新状態を取得しました。',
              );
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (result.error.code === 'FIELD_CLOCK_CONFLICT') {
              setSharingErrorMessage(
                '他の参加者が同じ項目を先に更新しました。まとめ変更を中断し、最新状態を取得しました。',
              );
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`共有アイテムのまとめ更新に失敗しました: ${result.error.code}`);
            return;
          }

          const updatedItems = result.data.changedItems.map((change) => change.item);

          setEventLists((prev) => ({
            ...prev,
            [activeEventName]: (prev[activeEventName] ?? []).map((item) => {
              const updatedItem = updatedItems.find((candidate) => candidate.localItemId === item.id);
              return updatedItem ? mergeSnapshotRoomItemIntoShoppingItem(item, updatedItem) : item;
            }),
          }));

          await saveSharingMutationVersion(sharingSession, result.data.itemsVersion, updatedItems);
          applyBulkProgressUi(changedItems);
          setSharingStatusMessage('共有アイテムをまとめて更新しました。');
        } catch (error) {
          console.error('Sharing bulk status update error:', error);
          setSharingErrorMessage('共有アイテムのまとめ更新に失敗しました。通信状態を確認してください。');
        } finally {
          setSharingBusy(false);
        }
        return;
      }

      setEventLists((prev) => {
        const allItems = [...(prev[activeEventName] || [])];
        const groupItemIds = new Set(changedItems.map((item) => item.id));
        return {
          ...prev,
          [activeEventName]: allItems.map((item) => {
            if (!groupItemIds.has(item.id)) return item;
            return clearLimitedPurchase({ ...item, purchaseStatus: newStatus });
          }),
        };
      });
      applyBulkProgressUi(changedItems);
    },
    [
      activeEventName,
      activeSharingSession,
      ackSavedRouteOrderVersions,
      applySnapshotAndAck,
      saveSharingMutationVersion,
      sortState,
    ],
  );

  const handleExecuteItemUpdate = useCallback(
    (updatedItem: ShoppingItem) => {
      handleUpdateItem(updatedItem);

      if (sortState !== 'Manual' && sortState !== 'Postpone') return;
      if (updatedItem.purchaseStatus === 'None') return;

      const groupOrder = executeSpaceGroupOrderRef.current;
      if (groupOrder.length === 0) return;
      const lastGroupKey = groupOrder[groupOrder.length - 1];

      const spaceKey = getSpaceKey(updatedItem.block, updatedItem.number);
      const priority = updatedItem.priorityLevel || 'none';
      const itemGroupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
      if (itemGroupKey !== lastGroupKey) return;

      const currentItems = executeColumnItemsRef.current;

      if (sortState === 'Manual') {
        const lastGroupItems = currentItems.filter((item) => {
          const sk = getSpaceKey(item.block, item.number);
          const p = item.priorityLevel || 'none';
          return (p !== 'none' ? `${sk}:${p}` : sk) === lastGroupKey;
        });
        if (lastGroupItems[lastGroupItems.length - 1]?.id !== updatedItem.id) return;

        const allNonNone = currentItems.every(
          (item) => item.id === updatedItem.id || item.purchaseStatus !== 'None',
        );
        if (allNonNone) setShowPostponeFilterButton(true);
      } else {
        const recentIds = recentlyChangedItemIdsRef.current;
        const visibleLastGroupItems = currentItems.filter((item) => {
          const sk = getSpaceKey(item.block, item.number);
          const p = item.priorityLevel || 'none';
          const gk = p !== 'none' ? `${sk}:${p}` : sk;
          if (gk !== lastGroupKey) return false;
          return item.purchaseStatus === 'Postpone' || recentIds.has(item.id);
        });
        if (visibleLastGroupItems[visibleLastGroupItems.length - 1]?.id !== updatedItem.id) return;

        const allVisibleNonNone = currentItems.every((item) => {
          if (item.id === updatedItem.id) return true;
          if (item.purchaseStatus !== 'Postpone' && !recentIds.has(item.id)) return true;
          return item.purchaseStatus !== 'None';
        });
        if (allVisibleNonNone) setShowLateFilterButton(true);
      }
    },
    [handleUpdateItem, sortState],
  );

  const handleActivatePostponeFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState('Postpone');
    setShowPostponeFilterButton(false);
  }, []);

  const handleActivateLateFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState('Late');
    setShowLateFilterButton(false);
  }, []);

  const handleExecuteSpaceGroupOrderChange = useCallback((orderedGroupKeys: string[]) => {
    executeSpaceGroupOrderRef.current = orderedGroupKeys;
  }, []);

  const handleCollapseAndOpenNext = useCallback((currentGroupKey: string) => {
    const order = executeSpaceGroupOrderRef.current;
    const currentIndex = order.indexOf(currentGroupKey);
    const nextKey = currentIndex >= 0 && currentIndex < order.length - 1
      ? order[currentIndex + 1]
      : null;
    setExecuteCollapsedSpaces((prev) => {
      const next = new Set(prev);
      next.add(currentGroupKey);
      if (nextKey) {
        next.delete(nextKey);
      }
      return next;
    });
  }, []);

  const handleSetSpaceGroupDragItemIds = useCallback((itemIds: string[] | null) => {
    spaceGroupDragItemIdsRef.current = itemIds;
  }, []);

  const handleToggleRangeSelection = useCallback(
    (columnType: 'execute' | 'candidate') => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      toggleCurrentRangeSelection(columnType, getListColumnItems(columnType, currentEventDate), {
        halls: getHallsForDate(currentEventDate),
        currentMapData: getMapDataForDate(currentEventDate),
      });
    },
    [
      activeEventName,
      activeEventDate,
      getListColumnItems,
      getHallsForDate,
      getMapDataForDate,
      toggleCurrentRangeSelection,
    ],
  );

  const handleBulkSort = useCallback(
    (direction: BulkSortDirection) => {
      if (!activeEventName || selectedItemIds.size === 0) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;
      setSortState('Manual');
      setBlockSortDirection(null);
      const currentEventDate = activeEventDate;
      if (!currentEventDate) return;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      if (sharingSession) {
        if (mode !== 'edit') {
          setSharingErrorMessage('共有中の一括番号ソートは、巡回列だけで使用してください。');
          return;
        }

        const currentDayItems =
          executeModeItemsRef.current[activeEventName]?.[currentEventDate] || [];
        const executeIds = new Set(currentDayItems);
        const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
        const isInExecuteColumn = selectedItems.some((item) => executeIds.has(item.id));
        const isInCandidateColumn = selectedItems.some((item) => !executeIds.has(item.id));

        if (!isInExecuteColumn || isInCandidateColumn) {
          setSharingErrorMessage('共有中の候補列の一括番号ソートは同期対象外です。巡回列だけで選択してください。');
          return;
        }

        const itemsMap = new Map(items.map((item) => [item.id, item]));
        const selectedExecuteItems = currentDayItems
          .filter((id) => selectedItemIds.has(id))
          .map((id) => itemsMap.get(id)!)
          .filter(Boolean);
        const firstSelectedIndex = currentDayItems.findIndex((id) => selectedItemIds.has(id));
        if (firstSelectedIndex === -1) return;

        const otherItems = currentDayItems.filter((id) => !selectedItemIds.has(id));
        selectedExecuteItems.sort((a, b) => {
          const comparison = a.number.localeCompare(b.number, undefined, {
            numeric: true,
            sensitivity: 'base',
          });
          return direction === 'asc' ? comparison : -comparison;
        });
        const newDayItems = [...otherItems];
        newDayItems.splice(firstSelectedIndex, 0, ...selectedExecuteItems.map((item) => item.id));

        void saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          currentEventDate,
          newDayItems,
          '共有アイテムの巡回順を更新しました。',
        );
        return;
      }

      if (mode === 'edit') {
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
        const isInExecuteColumn = selectedItems.some((item) => executeIds.has(item.id));
        const isInCandidateColumn = selectedItems.some((item) => !executeIds.has(item.id));

        if (isInExecuteColumn && !isInCandidateColumn) {
          updateExecuteModeItems((prev) => {
            const eventItems = prev[activeEventName] || {};
            const dayItems = [...(eventItems[currentEventDate] || [])];

            const itemsMap = new Map(items.map((item) => [item.id, item]));
            const selectedItems = dayItems
              .filter((id) => selectedItemIds.has(id))
              .map((id) => itemsMap.get(id)!)
              .filter(Boolean);

            const otherItems = dayItems.filter((id) => !selectedItemIds.has(id));
            selectedItems.sort((a, b) => {
              const comparison = a.number.localeCompare(b.number, undefined, {
                numeric: true,
                sensitivity: 'base',
              });
              return direction === 'asc' ? comparison : -comparison;
            });

            const firstSelectedIndex = dayItems.findIndex((id) => selectedItemIds.has(id));
            if (firstSelectedIndex === -1) return prev;
            const newDayItems = [...otherItems];
            newDayItems.splice(firstSelectedIndex, 0, ...selectedItems.map((item) => item.id));
            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: newDayItems },
            };
          });
        } else if (isInCandidateColumn && !isInExecuteColumn) {
          setEventLists((prev) => {
            const allItems = [...(prev[activeEventName] || [])];
            const currentTabKey = currentEventDate;
            const executeIdsSet = new Set(
              executeModeItems[activeEventName]?.[currentEventDate] || [],
            );

            const candidateItems = allItems.filter(
              (item) => item.eventDate === currentTabKey && !executeIdsSet.has(item.id),
            );
            const selectedCandidateItems = candidateItems.filter((item) =>
              selectedItemIds.has(item.id),
            );
            const otherCandidateItems = candidateItems.filter(
              (item) => !selectedItemIds.has(item.id),
            );

            selectedCandidateItems.sort((a, b) => {
              const comparison = a.number.localeCompare(b.number, undefined, {
                numeric: true,
                sensitivity: 'base',
              });
              return direction === 'asc' ? comparison : -comparison;
            });

            const firstSelectedIndex = candidateItems.findIndex((item) =>
              selectedItemIds.has(item.id),
            );
            if (firstSelectedIndex === -1) return prev;

            const sortedCandidateItems = [...otherCandidateItems];
            sortedCandidateItems.splice(firstSelectedIndex, 0, ...selectedCandidateItems);


            const executeItems = allItems.filter(
              (item) => item.eventDate === currentTabKey && executeIdsSet.has(item.id),
            );

            const newItems = allItems.map((item) => {
              if (item.eventDate !== currentTabKey) {
                return item;
              }
              if (executeIdsSet.has(item.id)) {
                return executeItems.shift() || item;
              } else {
                return sortedCandidateItems.shift() || item;
              }
            });

            return { ...prev, [activeEventName]: newItems };
          });
        }
      } else {
        setEventLists((prev) => {
          const currentItems = [...(prev[activeEventName] || [])];
          const selectedItems = currentItems.filter((item) => selectedItemIds.has(item.id));
          const otherItems = currentItems.filter((item) => !selectedItemIds.has(item.id));

          selectedItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, {
              numeric: true,
              sensitivity: 'base',
            });
            return direction === 'asc' ? comparison : -comparison;
          });

          const firstSelectedIndex = currentItems.findIndex((item) => selectedItemIds.has(item.id));
          if (firstSelectedIndex === -1) return prev;

          const newItems = [...otherItems];
          newItems.splice(firstSelectedIndex, 0, ...selectedItems);

          return { ...prev, [activeEventName]: newItems };
        });
      }
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      selectedItemIds,
      items,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      guardSharingStructureMutation,
      saveSharingRouteOrderMutation,
      updateExecuteModeItems,
    ],
  );


  const handleExportEvent = useCallback(
    (eventName: string) => {
      const itemsToExport = eventLists[eventName];
      if (!hasExportableItems(itemsToExport)) {
        alert('出力できるアイテムがありません。');
        return;
      }
      setExportEventName(eventName);
      setShowExportOptions(true);
    },
    [eventLists],
  );


  const handleConfirmExport = useCallback(
    async (options: ExportOptions) => {
      if (!exportEventName) return;

      const itemsToExport = eventLists[exportEventName];
      if (!hasExportableItems(itemsToExport)) {
        return;
      }

      try {
        const { blob, filename } = await buildEventExportFile(
          exportEventName,
          itemsToExport,
          options,
          eventMetadata[exportEventName],
          {
            executeModeItems,
            dayModes,
            mapData,
            routeSettings,
            hallDefinitions,
            hallRouteSettings,
          },
        );

        downloadBlob(blob, filename);
      } catch (error) {
        console.error('Export error:', error);
        alert('アイテムの出力に失敗しました。');
      }

      setExportEventName(null);
    },
    [
      eventLists,
      executeModeItems,
      eventMetadata,
      dayModes,
      mapData,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      exportEventName,
    ],
  );


  const handleExportFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      e.target.value = '';
      if (hasAnyActiveSharingSession) {
        alert(SHARING_STRUCTURE_LOCK_MESSAGE);
        return;
      }

      try {
        const result = await importFromXlsx(file);

        if (!result.success) {
          alert(`インポートに失敗しました:\n${result.errors.join('\n')}`);
          return;
        }

        const fallbackWarnings = result.itemFallbackWarnings || [];
        const skippedItemIds = new Set<string>();
        const BULK_APPROVAL_THRESHOLD = 6;

        const describeFallbackWarning = (warning: ItemFallbackWarning): string =>
          `${warning.rowNumber}行目\n${warning.reasons.map((reason) => `- ${reason}`).join('\n')}`;

        if (fallbackWarnings.length >= BULK_APPROVAL_THRESHOLD) {
          const previewLines = fallbackWarnings
            .slice(0, 5)
            .map((warning) => `- ${warning.rowNumber}行目: ${warning.reasons[0] || '補完が必要です'}`);
          const previewText = previewLines.join('\n');
          const hasMore = fallbackWarnings.length > 5 ? '\n- ...' : '';

          const complementAll = window.confirm(
            `不正データが${fallbackWarnings.length}件見つかりました。\n${previewText}${hasMore}\n\nOK: すべて補完して取り込む\nキャンセル: すべてスキップ`,
          );

          if (!complementAll) {
            fallbackWarnings.forEach((warning) => {
              skippedItemIds.add(warning.itemId);
            });
          }
        } else {
          for (const warning of fallbackWarnings) {
            const shouldComplement = window.confirm(
              `不正データを検出しました。\n${describeFallbackWarning(warning)}\n\nOK: この行を補完して取り込む\nキャンセル: この行をスキップ`,
            );
            if (!shouldComplement) {
              skippedItemIds.add(warning.itemId);
            }
          }
        }

        const resolvedItems = result.items.filter((item) => !skippedItemIds.has(item.id));
        if (resolvedItems.length === 0) {
          if (result.items.length > 0 && skippedItemIds.size > 0) {
            alert('不正データをすべてスキップしたため、取り込み対象がありませんでした。');
          } else {
            alert('取り込んだファイルにアイテムが見つかりませんでした。');
          }
          return;
        }

        const fallbackResolutionMessages: string[] = [];
        if (fallbackWarnings.length > 0) {
          const skippedCount = skippedItemIds.size;
          const complementedCount = fallbackWarnings.length - skippedCount;
          if (complementedCount > 0) {
            fallbackResolutionMessages.push(
              `不正データ${complementedCount}件を補完して取り込みました。`,
            );
          }
          if (skippedCount > 0) {
            fallbackResolutionMessages.push(`不正データ${skippedCount}件をスキップしました。`);
          }
        }

        const resolvedResult = {
          ...result,
          items: resolvedItems,
          errors: [...result.errors, ...fallbackResolutionMessages],
        };

        if (resolvedResult.items.length === 0) {
          alert('取り込んだファイルにアイテムが見つかりませんでした。');
          return;
        }

        const importedData = toImportedEventData(resolvedResult);
        const eventName = importedData.eventName;
        const isUpdate = !!eventLists[eventName];


        setEventLists((prev) => upsertRecordKey(prev, eventName, importedData.items));


        if (importedData.metadata) {
          const metadata = importedData.metadata;
          setEventMetadata((prev) => upsertRecordKey(prev, eventName, metadata));
        }


        if (importedData.executeModeItems) {
          const executeItems = importedData.executeModeItems;
          updateExecuteModeItems((prev) => upsertRecordKey(prev, eventName, executeItems));
        }
        if (importedData.dayModes) {
          const importedDayModes = importedData.dayModes;
          setDayModes((prev) => upsertRecordKey(prev, eventName, importedDayModes));
        }


        if (importedData.mapData) {
          const importedMapData = importedData.mapData;
          setMapData((prev) => upsertRecordKey(prev, eventName, importedMapData));
        }


        if (importedData.routeSettings) {
          const importedRouteSettings = importedData.routeSettings;
          setRouteSettings((prev) => upsertRecordKey(prev, eventName, importedRouteSettings));
        }


        if (importedData.hallDefinitions) {
          const importedHallDefinitions = importedData.hallDefinitions;
          setHallDefinitions((prev) => upsertRecordKey(prev, eventName, importedHallDefinitions));
        }


        if (importedData.hallRouteSettings) {
          const importedHallRouteSettings = importedData.hallRouteSettings;
          setHallRouteSettings((prev) =>
            upsertRecordKey(prev, eventName, importedHallRouteSettings),
          );
        }


        alert(
          buildImportCompletionMessage({
            errors: importedData.errors,
            eventName,
            isUpdate,
            itemCount: importedData.items.length,
          }),
        );


        const nextTab = resolveEventListTab(importedData.items);
        if (!nextTab) {
          alert('参加日がないため処理を停止しました。');
          return;
        }
        setActiveEventName(eventName);
        setActiveTab(nextTab);
      } catch (error) {
        console.error('Import error:', error);
        alert('アイテムの取り込みに失敗しました。ファイル形式を確認してください。');
      }
    },
    [eventLists, hasAnyActiveSharingSession],
  );


  const handleUpdateEvent = useCallback(
    async (eventName: string, urlOverride?: { url: string; sheetName: string }) => {
      if (guardSharingStructureMutation(eventName)) return;
      const metadata = eventMetadata[eventName];
      const source = resolveSpreadsheetSource(metadata, urlOverride);

      if (!source) {
        setPendingUpdateEventName(eventName);
        setShowUrlUpdateDialog(true);
        return;
      }

      try {
        const currentItems = eventLists[eventName] || [];
        const updateDiff = await buildEventUpdateDiffFromSpreadsheet(currentItems, source);
        setUpdateData(updateDiff);
        setUpdateEventName(eventName);
        setShowUpdateConfirmation(true);
      } catch (error) {
        console.error('Update error:', error);
        setPendingUpdateEventName(eventName);
        setShowUrlUpdateDialog(true);
      }
    },
    [eventLists, eventMetadata, guardSharingStructureMutation],
  );

  const handleConfirmUpdate = async () => {
    if (!updateData || !updateEventName) return;

    const { itemsToDelete, itemsToUpdate, itemsToAdd } = updateData;
    const eventName = updateEventName;
    const sharingSession =
      activeSharingSession?.eventName === eventName ? activeSharingSession : null;

    if (sharingSession) {
      if (sharingSession.role !== 'host') {
        setSharingErrorMessage('共有中のスプレッドシート更新は主催のみ実行できます。');
        return;
      }

      setSharingBusy(true);
      setSharingStatusMessage('スプレッドシートの更新を共有へ反映しています。');
      setSharingErrorMessage(null);
      try {
        let workingItems = [...(eventLists[eventName] || [])];
        let workingExecuteModeItems = {
          ...(executeModeItemsRef.current[eventName] || {}),
        };
        let routeOrderVersions = { ...sharingSession.routeOrderVersions };

        for (const itemToDelete of itemsToDelete) {
          const expectedFieldClocks = pickExpectedFieldClocks(
            sharingSession,
            itemToDelete.id,
            ['deletedAt', 'deletedBy'],
          );
          if (!expectedFieldClocks) {
            setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }

          const routeUpdates = hasSharingRouteMembership(itemToDelete)
            ? (() => {
                if (!itemToDelete.eventDate) return null;
                const currentRouteItemIds = workingExecuteModeItems[itemToDelete.eventDate] ?? [];
                return [
                  {
                    eventDate: itemToDelete.eventDate,
                    itemIds: currentRouteItemIds.filter((itemId) => itemId !== itemToDelete.id),
                    expectedVersion: routeOrderVersions[itemToDelete.eventDate] ?? 0,
                  },
                ];
              })()
            : [];

          if (routeUpdates === null) {
            setSharingErrorMessage('巡回順に入っている共有アイテムの日付が不明です。最新状態を取得します。');
            await applySnapshotAndAck(sharingSession.roomId);
            return;
          }

          const result = await deleteRoomItemWithRoute({
            roomId: sharingSession.roomId,
            localItemId: itemToDelete.id,
            routeUpdates,
            expectedFieldClocks,
          });

          if (!result.ok) {
            if (
              isFullItemRefreshRequired(result.error.code) ||
              result.error.code === 'FIELD_CLOCK_CONFLICT' ||
              result.error.code === 'ROUTE_ORDER_CONFLICT'
            ) {
              setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`共有アイテムの削除に失敗しました: ${result.error.code}`);
            return;
          }

          const changedRouteOrders = result.data.changedRouteOrders ?? [];
          workingItems = applyCanonicalRouteOrdersToItems(
            workingItems.filter((item) => item.id !== itemToDelete.id),
            changedRouteOrders,
          );
          if (changedRouteOrders.length > 0) {
            workingExecuteModeItems = {
              ...workingExecuteModeItems,
              ...Object.fromEntries(
                changedRouteOrders.map((routeOrder) => [
                  routeOrder.eventDate,
                  routeOrder.itemIds,
                ]),
              ),
            };
          }
          routeOrderVersions = result.data.routeOrderVersions ?? routeOrderVersions;
        }

        for (const updatedItem of itemsToUpdate) {
          let currentItem = workingItems.find((item) => item.id === updatedItem.id);
          if (!currentItem) continue;

          const structuralFields = buildSharingStructuralItemFields(currentItem, updatedItem);
          if (Object.keys(structuralFields).length > 0) {
            const expectedFieldClocks = pickExpectedFieldClocks(
              sharingSession,
              updatedItem.id,
              Object.keys(structuralFields),
            );
            if (!expectedFieldClocks) {
              setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }

            const routeUpdates = buildSharingStructuralRouteUpdates(
              currentItem,
              updatedItem,
              workingItems,
              workingExecuteModeItems,
              routeOrderVersions,
            );
            const result = await upsertRoomItemWithRoute({
              roomId: sharingSession.roomId,
              localItemId: updatedItem.id,
              fields: structuralFields,
              routeUpdates,
              expectedFieldClocks,
            });

            if (!result.ok) {
              if (
                isFullItemRefreshRequired(result.error.code) ||
                result.error.code === 'FIELD_CLOCK_CONFLICT' ||
                result.error.code === 'ROUTE_ORDER_CONFLICT'
              ) {
                setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
                await applySnapshotAndAck(sharingSession.roomId);
                return;
              }
              setSharingErrorMessage(`共有アイテムの更新に失敗しました: ${result.error.code}`);
              return;
            }

            const changedRouteOrders = result.data.changedRouteOrders ?? [];
            workingItems = applyCanonicalRouteOrdersToItems(
              workingItems.map((item) =>
                item.id === updatedItem.id
                  ? mergeSnapshotRoomItemIntoShoppingItem(item, result.data.item)
                  : item,
              ),
              changedRouteOrders,
            );
            if (changedRouteOrders.length > 0) {
              workingExecuteModeItems = {
                ...workingExecuteModeItems,
                ...Object.fromEntries(
                  changedRouteOrders.map((routeOrder) => [
                    routeOrder.eventDate,
                    routeOrder.itemIds,
                  ]),
                ),
              };
            }
            routeOrderVersions = result.data.routeOrderVersions ?? routeOrderVersions;
            currentItem =
              workingItems.find((item) => item.id === updatedItem.id) ?? currentItem;
          }

          const mutableFields = buildSharingMutableItemFields(currentItem, updatedItem);
          if (Object.keys(mutableFields).length > 0) {
            const expectedFieldClocks = pickExpectedFieldClocks(
              sharingSession,
              updatedItem.id,
              buildPurchaseExpectedClockFields(mutableFields, null),
            );
            if (!expectedFieldClocks) {
              setSharingErrorMessage('共有アイテムの同期基準が不足しています。最新状態を取得します。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }

            const result = await updateRoomItemWithPurchase({
              roomId: sharingSession.roomId,
              localItemId: updatedItem.id,
              fields: mutableFields,
              status: null,
              actualPurchaseQuantity: null,
              expectedFieldClocks,
            });

            if (!result.ok) {
              if (
                isFullItemRefreshRequired(result.error.code) ||
                result.error.code === 'FIELD_CLOCK_CONFLICT'
              ) {
                setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
                await applySnapshotAndAck(sharingSession.roomId);
                return;
              }
              setSharingErrorMessage(`共有アイテムの更新に失敗しました: ${result.error.code}`);
              return;
            }

            workingItems = workingItems.map((item) =>
              item.id === updatedItem.id
                ? mergeSnapshotRoomItemIntoShoppingItem(item, result.data.item)
                : item,
            );
          }
        }

        for (const itemToAdd of itemsToAdd) {
          const createdItem = createSpreadsheetShoppingItem(itemToAdd);
          const result = await upsertRoomItemWithRoute({
            roomId: sharingSession.roomId,
            localItemId: createdItem.id,
            fields: buildSharingCreateItemFields(createdItem),
            routeUpdates: [],
            expectedFieldClocks: {},
          });

          if (!result.ok) {
            if (
              isFullItemRefreshRequired(result.error.code) ||
              result.error.code === 'FIELD_CLOCK_CONFLICT' ||
              result.error.code === 'ROUTE_ORDER_CONFLICT'
            ) {
              setSharingErrorMessage('他の参加者が先に更新しました。最新状態を取得しました。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`共有アイテムの追加に失敗しました: ${result.error.code}`);
            return;
          }

          workingItems = [
            ...workingItems,
            mergeSnapshotRoomItemIntoShoppingItem(createdItem, result.data.item),
          ];
          routeOrderVersions = result.data.routeOrderVersions ?? routeOrderVersions;
        }

        await applySnapshotAndAck(sharingSession.roomId);
        setShowUpdateConfirmation(false);
        setUpdateData(null);
        setUpdateEventName(null);
        setSharingStatusMessage('スプレッドシートの更新を共有へ反映しました。');
        alert('アイテムを更新しました。');
      } catch (error) {
        console.error('Sharing spreadsheet update error:', error);
        setSharingErrorMessage('スプレッドシート更新の共有反映に失敗しました。通信状態を確認してください。');
      } finally {
        setSharingBusy(false);
      }
      return;
    }

    if (guardSharingStructureMutation(updateEventName)) return;

    setEventLists((prev) => {
      const newItems = applyEventUpdateToItems(prev[eventName] || [], {
        itemsToDelete,
        itemsToUpdate,
        itemsToAdd,
      });
      return { ...prev, [eventName]: newItems };
    });


    updateExecuteModeItems((prev) => {
      const eventItems = prev[eventName];
      if (!eventItems) return prev;

      const deleteIds = new Set(itemsToDelete.map((item) => item.id));
      const updatedEventItems = removeDeletedIdsFromExecuteModeItems(eventItems, deleteIds);

      return {
        ...prev,
        [eventName]: updatedEventItems,
      };
    });

    setMemberRouteItems((prev) => {
      const eventItems = prev[eventName];
      if (!eventItems) return prev;

      const deleteIds = new Set(itemsToDelete.map((item) => item.id));
      return {
        ...prev,
        [eventName]: removeDeletedIdsFromMemberRouteItems(eventItems, deleteIds),
      };
    });

    setShowUpdateConfirmation(false);
    setUpdateData(null);
    setUpdateEventName(null);
    alert('アイテムを更新しました。');
  };

  const handleUrlUpdate = useCallback(
    (newUrl: string, sheetName: string) => {
      setShowUrlUpdateDialog(false);
      if (!pendingUpdateEventName) return;
      if (guardSharingStructureMutation(pendingUpdateEventName)) return;

      const eventName = pendingUpdateEventName;
      const currentMetadata = eventMetadata[eventName];
      const normalizedSheetName = sheetName || currentMetadata?.spreadsheetSheetName || '';

      setEventMetadata((prev) =>
        upsertRecordKey(prev, eventName, {
          spreadsheetUrl: newUrl,
          spreadsheetSheetName: normalizedSheetName,
          lastImportDate: currentMetadata?.lastImportDate || '',
        }),
      );

      setPendingUpdateEventName(null);
      handleUpdateEvent(eventName, { url: newUrl, sheetName: normalizedSheetName });
    },
    [pendingUpdateEventName, eventMetadata, handleUpdateEvent, guardSharingStructureMutation],
  );


  const handleImportMapData = useCallback(async (eventName: string) => {
    if (guardSharingStructureMutation(eventName)) return;
    if (mapFileInputRef.current) {
      mapFileInputRef.current.dataset.eventName = eventName;
      mapFileInputRef.current.click();
    }
  }, [guardSharingStructureMutation]);

  const handleMapFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const eventName = e.target.dataset.eventName;

    if (!file || !eventName) return;


    setMapImportPendingFile(file);
    setMapImportPendingEventName(eventName);
    setMapImportDialogOpen(true);

    e.target.value = '';
  }, []);


  const handleMapImportConfirm = useCallback(
    (
      parsedData: Record<string, DayMapData>,
      settings: BlockDetectionSettings,
      initialAngles: Record<string, number>,
    ) => {
      const eventName = mapImportPendingEventName;
      if (!eventName) return;
      if (guardSharingStructureMutation(eventName)) return;

      saveBlockDetectionSettings(eventName, settings);

      const eventDatesForTargetEvent = extractEventDates(eventLists[eventName] || []);
      const skippedDays = new Set<string>();
      const normalizedParsedData: Record<string, DayMapData> = {};
      const normalizedInitialAngles: Record<string, number> = {};

      Object.entries(parsedData).forEach(([mapName, dayMapData]) => {
        const mapTabName = resolveImportMapTabName(mapName, eventDatesForTargetEvent);
        if (!mapTabName) {
          skippedDays.add(normalizeMapDayToken(mapName) || mapName);
          return;
        }

        normalizedParsedData[mapTabName] = dayMapData;
        normalizedInitialAngles[mapTabName] = initialAngles[mapName] ?? 0;
      });

      setMapData((prev) => ({
        ...prev,
        [eventName]: {
          ...(prev[eventName] || {}),
          ...normalizedParsedData,
        },
      }));

      setMapRotationSettings((prev) => {
        const currentEventSettings = prev[eventName] || {};
        const nextEventSettings = { ...currentEventSettings };

        Object.keys(normalizedParsedData).forEach((dayMapName) => {
          const importedInitialAngle = normalizeRotationAngle(normalizedInitialAngles[dayMapName] ?? 0);
          nextEventSettings[dayMapName] = {
            initialAngle: importedInitialAngle,
            mapTabAngle: importedInitialAngle,
            focusModeAngle: importedInitialAngle,
          };
        });

        return {
          ...prev,
          [eventName]: nextEventSettings,
        };
      });

      const mapCount = Object.keys(normalizedParsedData).length;


      const firstMapName = Object.keys(normalizedParsedData)[0];
      if (firstMapName) {
        setActiveTab(firstMapName);
      }


      setMapImportDialogOpen(false);
      setMapImportPendingFile(null);
      setMapImportPendingEventName('');

      const skippedMessages = Array.from(skippedDays)
        .sort((a, b) => a.localeCompare(b, 'ja'))
        .map((dayName) => `${dayName}はないので取り込みしませんでした`);

      const messages: string[] = [];
      if (mapCount > 0) {
        messages.push(`${mapCount}件のマップタブを取り込みました。`);
      }
      messages.push(...skippedMessages);

      if (messages.length > 0) {
        alert(messages.join('\n'));
      }
    },
    [eventLists, mapImportPendingEventName, guardSharingStructureMutation],
  );


  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
  }, []);


  const saveSharingMapRouteAddMutation = useCallback(
    async (
      session: SharingSessionMetadata,
      eventName: string,
      eventDate: string,
      itemIds: string[],
      insertedItemIds: string[],
    ) => {
      const saved = await saveSharingRouteOrderMutation(
        session,
        eventName,
        eventDate,
        itemIds,
        '共有アイテムを巡回順に追加しました。',
        'normalize',
      );
      if (!saved) return;

      await assignSharingRouteItemsToCurrentMember(
        session,
        eventName,
        insertedItemIds,
        '共有アイテムを巡回順に追加し、担当者を更新しました。',
      );
    },
    [assignSharingRouteItemsToCurrentMember, saveSharingRouteOrderMutation],
  );


  const handleAddToExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab || !currentMapTabName || !activeEventDate) return [];
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      const dayName = activeEventDate;
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[currentMapTabName] || {
        hallOrder: [],
        hallVisitLists: [],
      };
      const currentMapData = mapData[activeEventName]?.[currentMapTabName];

      const currentForEvent = executeModeItemsRef.current[activeEventName] || {};
      const result = computeAddToExecuteListFromMapWithResult(
        itemId,
        dayName,
        items,
        currentForEvent,
        halls,
        hallRouteSettingsForMap,
        currentMapData,
      );

      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      if (sharingSession) {
        void saveSharingMapRouteAddMutation(
          sharingSession,
          activeEventName,
          dayName,
          result.executeModeItems[dayName] ?? [],
          result.insertedItemIds,
        );
      }
      return result.insertedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      currentMapTabName,
      isMapTab,
      items,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      commitExecuteModeItemsForEvent,
      saveSharingMapRouteAddMutation,
    ],
  );


  const handleAddToExecuteListFromMapAtPosition = useCallback(
    (itemId: string, referenceItemId: string, position: 'before' | 'after') => {
      if (!activeEventName || !isMapTab || !activeEventDate) return [];
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      const dayName = activeEventDate;
      const currentForEvent = executeModeItemsRef.current[activeEventName] || {};
      const result = computeInsertIntoExecuteAtPosition(
        [itemId],
        referenceItemId,
        position,
        currentForEvent,
        dayName,
        items,
        {
          canInsertWithReference: (insertedItemId, refId) =>
            areItemsInSameHallGroup(insertedItemId, refId, dayName),
        },
      );
      if (!result.accepted) return [];

      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      if (sharingSession) {
        void saveSharingMapRouteAddMutation(
          sharingSession,
          activeEventName,
          dayName,
          result.executeModeItems[dayName] ?? [],
          result.insertedItemIds,
        );
      }
      return result.insertedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      isMapTab,
      items,
      areItemsInSameHallGroup,
      commitExecuteModeItemsForEvent,
      saveSharingMapRouteAddMutation,
    ],
  );


  const handleRemoveFromExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      const dayName = activeEventDate;
      const currentForEvent = executeModeItemsRef.current[activeEventName] || {};
      const removeIds = expandExecuteRemovalItemIds([itemId], dayName, items, currentForEvent);
      const newExecuteItems = computeRemoveFromExecuteListFromMap(
        itemId,
        currentForEvent,
        dayName,
        items,
      );

      commitExecuteModeItemsForEvent(activeEventName, newExecuteItems);
      if (sharingSession) {
        void saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          dayName,
          newExecuteItems[dayName] ?? [],
          '共有アイテムを候補へ移動しました。',
          'normalize',
        );
      }
      return removeIds;
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      isMapTab,
      items,
      commitExecuteModeItemsForEvent,
      saveSharingRouteOrderMutation,
    ],
  );


  const handleBatchAddToExecuteListFromMap = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName || !activeEventDate) return [];
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      const dayName = activeEventDate;
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[currentMapTabName] || {
        hallOrder: [],
        hallVisitLists: [],
      };
      const currentMap = mapData[activeEventName]?.[currentMapTabName];

      {
        let current = executeModeItemsRef.current[activeEventName] || {};
        const insertedItemIds: string[] = [];
        for (const id of itemIds) {
          const result = computeAddToExecuteListFromMapWithResult(id, dayName, items, current, halls, hallRouteSettingsForMap, currentMap);
          if (result.accepted) {
            current = result.executeModeItems;
            insertedItemIds.push(...result.insertedItemIds);
          }
        }
        commitExecuteModeItemsForEvent(activeEventName, current);
        if (sharingSession) {
          void saveSharingMapRouteAddMutation(
            sharingSession,
            activeEventName,
            dayName,
            current[dayName] ?? [],
            insertedItemIds,
          );
        }
        return insertedItemIds;
      }
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      currentMapTabName,
      isMapTab,
      items,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      commitExecuteModeItemsForEvent,
      saveSharingMapRouteAddMutation,
    ],
  );


  const handleBatchAddToExecuteListFromMapAtPosition = useCallback(
    (itemIds: string[], referenceItemId: string, position: 'before' | 'after') => {
      if (!activeEventName || !isMapTab || !activeEventDate) return [];
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      const dayName = activeEventDate;

      const current = executeModeItemsRef.current[activeEventName] || {};
      const result = computeInsertIntoExecuteAtPosition(
        itemIds,
        referenceItemId,
        position,
        current,
        dayName,
        items,
        {
          canInsertWithReference: (insertedItemId, refId) =>
            areItemsInSameHallGroup(insertedItemId, refId, dayName),
        },
      );
      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      if (sharingSession) {
        void saveSharingMapRouteAddMutation(
          sharingSession,
          activeEventName,
          dayName,
          result.executeModeItems[dayName] ?? [],
          result.insertedItemIds,
        );
      }
      return result.insertedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      isMapTab,
      items,
      areItemsInSameHallGroup,
      commitExecuteModeItemsForEvent,
      saveSharingMapRouteAddMutation,
    ],
  );


  const handleBatchRemoveFromExecuteListFromMap = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      const dayName = activeEventDate;

      let current = executeModeItemsRef.current[activeEventName] || {};
      const removedItemIds: string[] = [];
      for (const id of itemIds) {
        const removeIds = expandExecuteRemovalItemIds([id], dayName, items, current);
        current = computeRemoveFromExecuteListFromMap(id, current, dayName, items);
        removedItemIds.push(...removeIds.filter((removeId) => !removedItemIds.includes(removeId)));
      }
      commitExecuteModeItemsForEvent(activeEventName, current);
      if (sharingSession) {
        void saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          dayName,
          current[dayName] ?? [],
          '共有アイテムを候補へ移動しました。',
          'normalize',
        );
      }
      return removedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      isMapTab,
      items,
      commitExecuteModeItemsForEvent,
      saveSharingRouteOrderMutation,
    ],
  );


  const handleAddNewItemFromMap = useCallback(
    (eventDate: string, block: string, number: string) => {
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;
      setNewItemDefaults({ eventDate, block, number });
      setItemToEdit(null);
      setActiveTab('import');
    },
    [activeEventName, activeSharingSession, guardSharingStructureMutation],
  );


  const handleAddItemFromFocusMode = useCallback(
    async (newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession && guardSharingStructureMutation(activeEventName)) return;

      const requestedStatus = newItem.purchaseStatus ?? 'None';
      if (
        sharingSession &&
        (requestedStatus === 'Purchased' || requestedStatus === 'LimitedPurchase')
      ) {
        setSharingErrorMessage(
          '共有中の新規追加では、購入済み・限数購入済みを初期状態にできません。追加後に購入状態を保存してください。',
        );
        return;
      }
      if (
        sharingSession &&
        (requestedStatus === 'Postpone' || requestedStatus === 'Late') &&
        !newItem.eventDate
      ) {
        setSharingErrorMessage(
          '共有中に延期・後回しのアイテムを追加するには、参加日を選択してください。',
        );
        return;
      }

      const result = computeAddItemFromFocusMode(
        eventLists[activeEventName] || [],
        newItem,
        executeModeItemsRef.current[activeEventName] || {},
      );

      if (sharingSession) {
        const createdItem = result.items.find((item) => item.id === result.newItemId);
        if (!createdItem) return;

        const routeUpdates =
          createdItem.purchaseStatus === 'Postpone' || createdItem.purchaseStatus === 'Late'
            ? [
                {
                  eventDate: createdItem.eventDate,
                  itemIds: result.executeModeItems[createdItem.eventDate] ?? [],
                  expectedVersion: sharingSession.routeOrderVersions[createdItem.eventDate] ?? 0,
                },
              ]
            : [];

        setSharingBusy(true);
        setSharingStatusMessage('共有アイテムを追加しています。');
        setSharingErrorMessage(null);
        try {
          const mutation = await upsertRoomItemWithRoute({
            roomId: sharingSession.roomId,
            localItemId: createdItem.id,
            fields: buildSharingCreateItemFields(createdItem),
            routeUpdates,
            expectedFieldClocks: {},
          });

          if (!mutation.ok) {
            if (isFullItemRefreshRequired(mutation.error.code)) {
              setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            if (mutation.error.code === 'ROUTE_ORDER_CONFLICT') {
              setSharingErrorMessage('他の参加者が先に巡回順を更新しました。最新状態を取得しました。');
              await applySnapshotAndAck(sharingSession.roomId);
              return;
            }
            setSharingErrorMessage(`共有アイテムの追加に失敗しました: ${mutation.error.code}`);
            return;
          }

          const changedRouteOrders = mutation.data.changedRouteOrders ?? [];
          setEventLists((prev) => {
            const currentItems = prev[activeEventName] ?? [];
            const nextCreatedItem = mergeSnapshotRoomItemIntoShoppingItem(
              createdItem,
              mutation.data.item,
            );
            const nextItems = [...currentItems, nextCreatedItem];
            return {
              ...prev,
              [activeEventName]: applyCanonicalRouteOrdersToItems(nextItems, changedRouteOrders),
            };
          });

          if (changedRouteOrders.length > 0) {
            updateExecuteModeItems((prev) => ({
              ...prev,
              [activeEventName]: {
                ...(prev[activeEventName] ?? {}),
                ...Object.fromEntries(
                  changedRouteOrders.map((routeOrder) => [
                    routeOrder.eventDate,
                    routeOrder.itemIds,
                  ]),
                ),
              },
            }));
          }

          const changedRouteOrderAcks = Object.fromEntries(
            changedRouteOrders.map((routeOrder) => [
              routeOrder.eventDate,
              routeOrder.dateRouteOrderVersion,
            ]),
          );
          const pendingRouteOrderAcks = mergePendingRouteOrderAcks(
            sharingSession.pendingRouteOrderAcks,
            changedRouteOrderAcks,
            'mutation',
            new Date().toISOString(),
          );
          await saveSharingMutationVersion(sharingSession, mutation.data.itemsVersion, [
            mutation.data.item,
          ], {
            routeOrderVersions: mutation.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
            pendingRouteOrderAcks,
          });
          if (changedRouteOrders.length > 0) {
            await ackSavedRouteOrderVersions(
              sharingSession,
              mutation.data.routeOrderVersions ?? sharingSession.routeOrderVersions,
              pendingRouteOrderAcks,
            );
          }
          setSharingStatusMessage('共有アイテムを追加しました。');
        } catch (error) {
          console.error('Sharing item create error:', error);
          setSharingErrorMessage('共有アイテムの追加に失敗しました。通信状態を確認してください。');
        } finally {
          setSharingBusy(false);
        }
        return;
      }

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      updateExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems }));
    },
    [
      activeEventName,
      activeSharingSession,
      applySnapshotAndAck,
      eventLists,
      executeModeItems,
      guardSharingStructureMutation,
      saveSharingMutationVersion,
      updateExecuteModeItems,
    ],
  );


  const handleMoveToFirstFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      if (!activeEventDate) return;
      const dayName = activeEventDate;
      const eventItems = executeModeItemsRef.current[activeEventName] || {};
      const dayItems = (eventItems[dayName] || []).filter((id) => id !== itemId);
      const nextItemIds = [itemId, ...dayItems];

      if (sharingSession) {
        void saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          dayName,
          nextItemIds,
          '共有アイテムの巡回順を更新しました。',
        );
        return;
      }

      updateExecuteModeItems((prev) => {
        const prevEventItems = prev[activeEventName] || {};
        return {
          ...prev,
          [activeEventName]: {
            ...prevEventItems,
            [dayName]: nextItemIds,
          },
        };
      });
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      isMapTab,
      saveSharingRouteOrderMutation,
      updateExecuteModeItems,
    ],
  );


  const handleMoveToLastFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      if (!activeEventDate) return;
      const dayName = activeEventDate;
      const eventItems = executeModeItemsRef.current[activeEventName] || {};
      const dayItems = (eventItems[dayName] || []).filter((id) => id !== itemId);
      const nextItemIds = [...dayItems, itemId];

      if (sharingSession) {
        void saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          dayName,
          nextItemIds,
          '共有アイテムの巡回順を更新しました。',
        );
        return;
      }

      updateExecuteModeItems((prev) => {
        const prevEventItems = prev[activeEventName] || {};
        return {
          ...prev,
          [activeEventName]: {
            ...prevEventItems,
            [dayName]: nextItemIds,
          },
        };
      });
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      isMapTab,
      saveSharingRouteOrderMutation,
      updateExecuteModeItems,
    ],
  );


  const currentMapExecuteItemIds = useMemo(() => {
    if (!activeEventName || !isMapTab || !activeEventDate) return [];

    const dayName = activeEventDate;

    if (activeMapRouteDisplayMode === 'member') {
      return selectedMemberRouteItemIds;
    }

    return executeModeItems[activeEventName]?.[dayName] || [];
  }, [
    activeEventName,
    activeEventDate,
    activeMapRouteDisplayMode,
    selectedMemberRouteItemIds,
    isMapTab,
    executeModeItems,
  ]);

  const currentMapMemberRouteItems = useMemo(() => {
    if (!activeEventName || !activeEventDate) return {};
    return memberRouteItems[activeEventName]?.[activeEventDate] ?? {};
  }, [activeEventName, activeEventDate, memberRouteItems]);

  const sharingAssignmentRouteGroups = useMemo(() => {
    if (!activeEventName || !activeEventDate) return [];
    if (activeSharingSession?.eventName !== activeEventName) return [];

    const routeItemIds = executeModeItems[activeEventName]?.[activeEventDate] || [];
    return buildAssignmentRouteGroups(routeItemIds, items, activeSharingAssignmentMembers);
  }, [
    activeEventName,
    activeEventDate,
    activeSharingSession?.eventName,
    activeSharingAssignmentMembers,
    executeModeItems,
    items,
  ]);

  const handleApplySharingAssignmentRouteOrder = useCallback(
    async (groupOrder: string[]) => {
      if (!activeEventName || !activeEventDate) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (!sharingSession) return;

      const currentRouteItemIds =
        executeModeItemsRef.current[activeEventName]?.[activeEventDate] || [];
      const eventItems = eventListsRef.current[activeEventName] || items;
      const nextRouteItemIds = reorderExecuteIdsByAssignmentRouteOrder(
        currentRouteItemIds,
        eventItems,
        groupOrder,
      );
      if (areStringArraysEqual(currentRouteItemIds, nextRouteItemIds)) return;

      const saved = await saveSharingRouteOrderMutation(
        sharingSession,
        activeEventName,
        activeEventDate,
        nextRouteItemIds,
        '担当ルート順序で全体共有ルートを更新しました。',
        'allow',
      );
      if (saved) {
        setSelectedItemIds(new Set());
      }
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      items,
      saveSharingRouteOrderMutation,
      setSelectedItemIds,
    ],
  );


  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return filterAssignedOnlyItems(items.filter((item) => item.eventDate === activeTab));
  }, [items, activeTab, activeEventName, eventDates, filterAssignedOnlyItems]);


  const [mapTabMenuOpen, setMapTabMenuOpen] = useState<string | null>(null);
  const [mapTabMenuPosition, setMapTabMenuPosition] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });

  React.useEffect(() => {
    if (mapTabMenuOpen !== 'mapToggle') return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        mapToggleMenuRef.current &&
        !mapToggleMenuRef.current.contains(e.target as Node) &&
        mapToggleButtonRef.current &&
        !mapToggleButtonRef.current.contains(e.target as Node)
      ) {
        setMapTabMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mapTabMenuOpen]);

  const [visitListPanelOpen, setVisitListPanelOpen] = useState(false);
  const [visitListPanelMapTab, setVisitListPanelMapTab] = useState<string | null>(null);
  const [visitListHasUnsavedChanges, setVisitListHasUnsavedChanges] = useState(false);
  const [visitListOriginalOrder, setVisitListOriginalOrder] = useState<string[]>([]);
  const [highlightedMapCell, setHighlightedMapCell] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [showVisitListConfirmDialog, setShowVisitListConfirmDialog] = useState(false);
  const [pendingTabChange, setPendingTabChange] = useState<string | null>(null);
  const [blockDefinitionMode, setBlockDefinitionMode] = useState(false);


  const [mapSelectedHallId, setMapSelectedHallId] = useState<string>('all');
  const [mapIsRouteVisible, setMapIsRouteVisible] = useState(true);
  const [mapIsHallOrderOpen, setMapIsHallOrderOpen] = useState(false);
  const [mapHallSelectorOpen, setMapHallSelectorOpen] = useState(false);
  const [mapSmartInsertEnabled, setMapSmartInsertEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertEnabled');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });
  const [mapSmartInsertMode, setMapSmartInsertMode] = useState<SmartInsertMode>(() => {
    try {
      return normalizeSmartInsertMode(localStorage.getItem('mapSmartInsertMode'));
    } catch {
      return 'map';
    }
  });
  const [smartInsertToast, setSmartInsertToast] = useState<string | null>(null);
  const [smartInsertToastType, setSmartInsertToastType] = useState<'success' | 'error'>('success');
  const smartInsertLongPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const smartInsertLongPressTriggeredRef = React.useRef(false);

  const showSmartInsertToast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      setSmartInsertToastType(type);
      setSmartInsertToast(message);
    },
    [],
  );


  React.useEffect(() => {
    try {
      localStorage.setItem('mapSmartInsertEnabled', String(mapSmartInsertEnabled));
    } catch (error) {
      console.error('Failed to persist mapSmartInsertEnabled:', error);
      showSmartInsertToast('スマート挿入設定の保存に失敗しました。', 'error');
    }
  }, [mapSmartInsertEnabled, showSmartInsertToast]);

  React.useEffect(() => {
    try {
      localStorage.setItem('mapSmartInsertMode', mapSmartInsertMode);
    } catch (error) {
      console.error('Failed to persist mapSmartInsertMode:', error);
      showSmartInsertToast('スマート挿入モードの保存に失敗しました。', 'error');
    }
  }, [mapSmartInsertMode, showSmartInsertToast]);


  React.useEffect(() => {
    if (smartInsertToast) {
      const timer = setTimeout(() => setSmartInsertToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [smartInsertToast]);


  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
    clickedCells: { row: number; col: number }[];
    editingBlockData?: unknown;
  } | null>(null);


  const [pendingCellSelection, setPendingCellSelection] = useState<{
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);


  const openVisitListPanel = useCallback(
    (mapTab: string) => {
      if (!activeEventName) return;


      const dayMatch = mapTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];


      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];


      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(mapTab);
      setVisitListHasUnsavedChanges(false);
      setVisitListPanelOpen(true);
    },
    [activeEventName, executeModeItems],
  );


  React.useEffect(() => {
    if (!visitListPanelOpen || !isMapTab || !activeEventName || !currentMapTabName) return;
    if (visitListPanelMapTab !== currentMapTabName) {
      if (visitListHasUnsavedChanges) {
        setVisitListHasUnsavedChanges(false);
      }
      if (!activeEventDate) return;
      const dayName = activeEventDate;
      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(currentMapTabName);
      setVisitListHasUnsavedChanges(false);
    }
  }, [
    currentMapTabName,
    isMapTab,
    activeEventName,
    visitListPanelOpen,
    visitListPanelMapTab,
    visitListHasUnsavedChanges,
    executeModeItems,
  ]);


  const handleVisitListOrderUpdate = useCallback(
    (newOrderItems: ShoppingItem[]) => {
      if (!visitListPanelMapTab || !activeEventName) return;

      const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];


      const newIds = newOrderItems.map((item) => item.id);


      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [dayName]: newIds,
        },
      }));
      setVisitListHasUnsavedChanges(true);
    },
    [visitListPanelMapTab, activeEventName],
  );


  const handleVisitListConfirm = useCallback(async () => {
    if (
      visitListHasUnsavedChanges &&
      visitListPanelMapTab &&
      activeEventName &&
      activeSharingSession?.eventName === activeEventName
    ) {
      const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
      if (dayMatch) {
        const dayName = dayMatch[1];
        const itemIds = executeModeItemsRef.current[activeEventName]?.[dayName] || [];
        const expectedVersion = activeSharingSession.routeOrderVersions[dayName] ?? 0;
        setSharingBusy(true);
        const result = await updateRouteOrder({
          roomId: activeSharingSession.roomId,
          eventDate: dayName,
          itemIds,
          expectedVersion,
        });
        setSharingBusy(false);

        if (!result.ok) {
          if (isFullItemRefreshRequired(result.error.code)) {
            setSharingErrorMessage('共有アイテムの最新状態を全体再取得しています。');
            await applySnapshotAndAck(activeSharingSession.roomId);
            return;
          }
          setSharingErrorMessage(`巡回順の更新に失敗しました: ${result.error.code}`);
          if (result.error.code === 'ROUTE_ORDER_CONFLICT') {
            void synchronizeSharingSession(activeSharingSession.sessionId, 'manual');
          }
          return;
        }

        const confirmedRouteOrder = {
          eventDate: result.data.eventDate,
          itemIds: result.data.itemIds,
        };
        updateExecuteModeItems((prev) => ({
          ...prev,
          [activeEventName]: {
            ...(prev[activeEventName] ?? {}),
            [confirmedRouteOrder.eventDate]: confirmedRouteOrder.itemIds,
          },
        }));
        setEventLists((prev) => {
          const items = prev[activeEventName] ?? [];
          const nextItems = applyCanonicalRouteOrderToItems(items, confirmedRouteOrder);
          return nextItems === items
            ? prev
            : {
                ...prev,
                [activeEventName]: nextItems,
              };
        });

        const pendingRouteOrderAcks = mergePendingRouteOrderAcks(
          activeSharingSession.pendingRouteOrderAcks,
          { [dayName]: result.data.dateRouteOrderVersion },
          'reorder',
          new Date().toISOString(),
        );
        await saveSharingSessionState({
          ...activeSharingSession,
          routeOrderVersions: result.data.routeOrderVersions,
          pendingRouteOrderAcks,
          lastAckAt: new Date().toISOString(),
        });
        await ackSavedRouteOrderVersions(
          activeSharingSession,
          result.data.routeOrderVersions,
          pendingRouteOrderAcks,
        );
        setSharingStatusMessage(`${dayName} の巡回順を更新しました。`);
        setSharingErrorMessage(null);
      }
    }
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, [
    activeEventName,
    activeSharingSession,
    ackSavedRouteOrderVersions,
    saveSharingSessionState,
    synchronizeSharingSession,
    updateExecuteModeItems,
    visitListHasUnsavedChanges,
    visitListPanelMapTab,
  ]);


  const handleVisitListCancel = useCallback(() => {
    if (!visitListPanelMapTab || !activeEventName) return;

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];


    if (visitListOriginalOrder.length > 0) {
      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [dayName]: [...visitListOriginalOrder],
        },
      }));
    }
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, [visitListOriginalOrder, visitListPanelMapTab, activeEventName, updateExecuteModeItems]);


  const handleVisitListClose = useCallback(() => {
    setVisitListPanelOpen(false);
  }, []);


  const handleHighlightMapCell = useCallback((row: number, col: number) => {
    setHighlightedMapCell({ row, col });
  }, []);

  const handleClearMapCellHighlight = useCallback(() => {
    setHighlightedMapCell(null);
  }, []);


  const visitListItems = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    const dayItems = items.filter((item) => item.eventDate === dayName);
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];


    return executeIds
      .filter((id: string) => dayItems.some((item) => item.id === id))
      .map((id: string) => dayItems.find((item) => item.id === id)!)
      .filter(Boolean);
  }, [visitListPanelMapTab, activeEventName, items, executeModeItems]);


  const visitListHallOrder = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const routeSettings = hallRouteSettings[activeEventName]?.[visitListPanelMapTab];

    if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
      return routeSettings.hallOrder;
    }


    return halls.map((h) => h.id);
  }, [visitListPanelMapTab, activeEventName, hallDefinitions, hallRouteSettings]);


  const handleUpdateItemPriority = useCallback(
    (itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
      if (!activeEventName || !visitListPanelMapTab) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (sharingSession) {
        const item = items.find((i) => i.id === itemId);
        if (item) {
          void handleUpdateItem({ ...item, priorityLevel });
        }
        return;
      }
      if (guardSharingStructureMutation(activeEventName)) return;

      const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
      const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];
      const currentSettings = hallRouteSettings[activeEventName]?.[visitListPanelMapTab] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      const result = computeUpdateItemPriority(
        itemId,
        priorityLevel,
        items,
        halls,
        mapDataForTab,
        currentSettings,
      );

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [visitListPanelMapTab]: result.hallRouteSettings,
        },
      }));

      const item = items.find((i) => i.id === itemId);
      if (item) {
        const dayName = item.eventDate;
        updateExecuteModeItems((prev) => {
          const currentExecItems = prev[activeEventName] || {};
          const reordered = reorderExecuteIdsForSpaceAdjacency(
            itemId,
            result.items,
            currentExecItems,
            dayName,
          );
          return {
            ...prev,
            [activeEventName]: reordered,
          };
        });
      }
    },
    [
      activeEventName,
      activeSharingSession,
      visitListPanelMapTab,
      items,
      hallDefinitions,
      mapData,
      hallRouteSettings,
      guardSharingStructureMutation,
      handleUpdateItem,
    ],
  );

  const handleUpdateItemPriorityFromEdit = useCallback(
    (itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      const currentItems = eventLists[activeEventName] || [];
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;

      if (sharingSession) {
        void handleUpdateItem({ ...item, priorityLevel });
        return;
      }

      if (guardSharingStructureMutation(activeEventName)) return;

      const resolvedHallId = getItemHallId(item, item.eventDate);
      const mapTabForItem = getMapTabForDate(item.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] || []).map((h) => h.id)
          : [],
      );
      const targetKey: string =
        resolvedHallId && mapHallIds.has(resolvedHallId)
          ? (mapTabForItem as string)
          : getMaplessKey(item.eventDate);

      const targetHalls = hallDefinitions[activeEventName]?.[targetKey] || [];
      const targetMapData =
        targetKey.startsWith(MAPLESS_HALL_KEY)
          ? undefined
          : mapData[activeEventName]?.[targetKey];
      const targetSettings = hallRouteSettings[activeEventName]?.[targetKey] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      const result = computeUpdateItemPriority(
        itemId,
        priorityLevel,
        currentItems,
        targetHalls,
        targetMapData,
        targetSettings,
      );

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [targetKey]: result.hallRouteSettings,
        },
      }));

      const dayName = item.eventDate;
      updateExecuteModeItems((prev) => {
        const currentExecItems = prev[activeEventName] || {};
        const reordered = reorderExecuteIdsForSpaceAdjacency(
          itemId,
          result.items,
          currentExecItems,
          dayName,
        );
        return {
          ...prev,
          [activeEventName]: reordered,
        };
      });
    },
    [
      activeEventName,
      eventLists,
      hallDefinitions,
      mapData,
      hallRouteSettings,
      getItemHallId,
      getMapTabForDate,
      guardSharingStructureMutation,
      activeSharingSession,
      handleUpdateItem,
    ],
  );

  const handleUpdateHallOrderForPriorityChangeFromEdit = useCallback(
    (
      itemId: string,
      newPriorityLevel: 'none' | 'priority' | 'highest',
      oldPriorityLevel: 'none' | 'priority' | 'highest',
    ) => {
      if (!activeEventName) return;

      const currentItems = eventLists[activeEventName] || [];
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;

      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;
      if (sharingSession) return;

      if (guardSharingStructureMutation(activeEventName)) return;

      const resolvedHallId = getItemHallId(item, item.eventDate);

      const mapTabForItem = getMapTabForDate(item.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] || []).map((h) => h.id)
          : [],
      );
      const targetKey: string =
        resolvedHallId && mapHallIds.has(resolvedHallId)
          ? (mapTabForItem as string)
          : getMaplessKey(item.eventDate);

      const targetHalls = hallDefinitions[activeEventName]?.[targetKey] || [];
      const targetMapData =
        targetKey.startsWith(MAPLESS_HALL_KEY)
          ? undefined
          : mapData[activeEventName]?.[targetKey];
      const targetSettings = hallRouteSettings[activeEventName]?.[targetKey] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      const itemsAfter = currentItems.map((i) =>
        i.id === itemId ? { ...i, priorityLevel: newPriorityLevel } : i,
      );

      const nextSettings = computeHallOrderForPriorityChange(
        itemId,
        newPriorityLevel,
        oldPriorityLevel,
        itemsAfter,
        targetHalls,
        targetMapData,
        targetSettings,
      );

      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [targetKey]: nextSettings,
        },
      }));

      const dayName = item.eventDate;
      updateExecuteModeItems((prev) => {
        const currentExecItems = prev[activeEventName] || {};
        const reordered = reorderExecuteIdsForSpaceAdjacency(
          itemId,
          itemsAfter,
          currentExecItems,
          dayName,
        );
        return {
          ...prev,
          [activeEventName]: reordered,
        };
      });
    },
    [
      activeEventName,
      eventLists,
      hallDefinitions,
      mapData,
      hallRouteSettings,
      getItemHallId,
      getMapTabForDate,
      guardSharingStructureMutation,
      activeSharingSession,
    ],
  );

  const handleTabChangeWithVisitListCheck = (newTab: string): boolean => {
    if (visitListPanelOpen && visitListHasUnsavedChanges) {
      setPendingTabChange(newTab);
      setShowVisitListConfirmDialog(true);
      return false;
    }
    return true;
  };


  const handleVisitListDialogConfirm = useCallback(() => {
    handleVisitListConfirm();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListConfirm, pendingTabChange]);


  const handleVisitListDialogCancel = useCallback(() => {
    handleVisitListCancel();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListCancel, pendingTabChange]);


  const handleUpdateBlocks = useCallback(
    (blocks: BlockDefinition[]) => {
      if (!activeEventName || !isMapTab || !currentMapData || !currentMapTabName) return;
      if (guardSharingStructureMutation(activeEventName)) return;

      setMapData((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [currentMapTabName]: {
            ...currentMapData,
            blocks,
          },
        },
      }));
    },
    [activeEventName, isMapTab, currentMapTabName, currentMapData, guardSharingStructureMutation],
  );


  const handleUpdateHalls = useCallback(
    (halls: HallDefinition[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      if (guardSharingStructureMutation(activeEventName)) return;

      const { polygonHalls, maplessHalls } = splitHallsForStorage(halls);
      const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;

      setHallDefinitions((prev) =>
        updateHallDefinitionsForHalls({
          previous: prev,
          eventName: activeEventName,
          mapTabName: currentMapTabName,
          maplessKey,
          polygonHalls,
          maplessHalls,
        }),
      );

      setHallRouteSettings((prev) =>
        updateHallRouteSettingsForHalls({
          previous: prev,
          eventName: activeEventName,
          mapTabName: currentMapTabName,
          maplessKey,
          polygonHalls,
          maplessHalls,
        }),
      );
    },
    [activeEventName, activeEventDate, isMapTab, currentMapTabName, guardSharingStructureMutation],
  );


  const handleUpdateHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [currentMapTabName]: settings,
        },
      }));
    },
    [activeEventName, isMapTab, currentMapTabName],
  );

  const handleUpdateMaplessHalls = useCallback(
    (halls: HallDefinition[]) => {
      if (!activeEventName || !activeEventDate) return;
      if (guardSharingStructureMutation(activeEventName)) return;

      const maplessKey = getMaplessKey(activeEventDate);

      setHallDefinitions((prev) =>
        updateMaplessHallDefinitions({
          previous: prev,
          eventName: activeEventName,
          maplessKey,
          halls,
        }),
      );

      setHallRouteSettings((prev) =>
        updateMaplessHallRouteSettings({
          previous: prev,
          eventName: activeEventName,
          maplessKey,
          halls,
        }),
      );
    },
    [activeEventName, activeEventDate, guardSharingStructureMutation],
  );

  const mapTabDates = useMemo(
    () => eventDates.filter((date) => !!getMapTabForDate(date)),
    [eventDates, getMapTabForDate],
  );

  const handleSyncMaplessHallsToOtherDates = useCallback(
    (targetDates: string[]) => {
      if (!activeEventName || !activeEventDate) return;
      if (guardSharingStructureMutation(activeEventName)) return;

      const sourceKey = getMaplessKey(activeEventDate);
      const sourceHalls = hallDefinitions[activeEventName]?.[sourceKey] || [];
      if (sourceHalls.length === 0) return;

      const clonedByDate = cloneHallsForDates(sourceHalls, targetDates);

      setHallDefinitions((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          updated[activeEventName][targetKey] = clonedByDate.get(date)!.halls;
        }
        return updated;
      });

      setHallRouteSettings((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          const { idMap } = clonedByDate.get(date)!;
          const sourceSettings = prev[activeEventName]?.[sourceKey] || emptyHallRouteSettings();
          updated[activeEventName][targetKey] = remapHallRouteSettings(sourceSettings, idMap);
        }
        return updated;
      });
    },
    [activeEventName, activeEventDate, hallDefinitions, hallRouteSettings, guardSharingStructureMutation],
  );

  const handleSyncPolygonHallsToOtherDates = useCallback(
    (targetDates: string[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      const sourceHalls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      if (sourceHalls.length === 0) return;

      const targetMapTabsByDate = new Map<string, string>();
      for (const date of targetDates) {
        const targetMapTab = getMapTabForDate(date);
        if (!targetMapTab) continue;
        targetMapTabsByDate.set(date, targetMapTab);
      }
      const clonedByDate = cloneHallsForDates(sourceHalls, Array.from(targetMapTabsByDate.keys()));

      setHallDefinitions((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const [date, { halls }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date)!;
          updated[activeEventName][targetMapTab] = halls;
        }
        return updated;
      });

      setHallRouteSettings((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const [date, { idMap }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date)!;
          const sourceSettings =
            prev[activeEventName]?.[currentMapTabName] || emptyHallRouteSettings();
          updated[activeEventName][targetMapTab] = remapHallRouteSettings(sourceSettings, idMap);
        }
        return updated;
      });
    },
    [activeEventName, isMapTab, currentMapTabName, hallDefinitions, hallRouteSettings, getMapTabForDate],
  );


  const globalHallOrderMapTabName = useMemo(
    () => (activeEventDate ? getMapTabForDate(activeEventDate) : null),
    [activeEventDate, getMapTabForDate],
  );

  const hasUndefinedPriorityItems = useMemo((): boolean => {
    if (!activeEventName || !activeEventDate) return false;
    const ids = executeModeItems[activeEventName]?.[activeEventDate] || [];
    return ids.some((id) => {
      const it = items.find((i) => i.id === id);
      if (!it) return false;
      const p = it.priorityLevel || 'none';
      return p === 'priority' || p === 'highest';
    });
  }, [activeEventName, activeEventDate, executeModeItems, items]);

  const globalHallOrderHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName) return [];
    const hasMap = !!globalHallOrderMapTabName;
    const mapHalls = hasMap
      ? hallDefinitions[activeEventName]?.[globalHallOrderMapTabName] || []
      : [];
    const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;
    const maplessHalls = maplessKey ? hallDefinitions[activeEventName]?.[maplessKey] || [] : [];
    return [...mapHalls, ...maplessHalls];
  }, [activeEventName, activeEventDate, globalHallOrderMapTabName, hallDefinitions]);

  const globalHallOrderRouteSettings = useMemo((): HallRouteSettings => {
    const executeIds =
      activeEventName && activeEventDate
        ? executeModeItems[activeEventName]?.[activeEventDate] || []
        : [];
    return buildMergedHallRouteSettings({
      eventName: activeEventName,
      dayName: activeEventDate,
      mapTabName: globalHallOrderMapTabName,
      hallDefinitionsStore: hallDefinitions,
      hallRouteSettingsStore: hallRouteSettings,
      executeIds,
      items,
      mapDataStore: mapData,
    }).mergedSettings;
  }, [
    activeEventName,
    activeEventDate,
    globalHallOrderMapTabName,
    hallDefinitions,
    hallRouteSettings,
    executeModeItems,
    items,
    mapData,
  ]);

  // 統合順序の保存: hallIDごとにmap側/mapless側を判別して分離保存
  const handleUpdateGlobalHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName) return;

      const mapHallIds = new Set<string>(
        globalHallOrderMapTabName
          ? (hallDefinitions[activeEventName]?.[globalHallOrderMapTabName] || []).map(
              (h) => h.id,
            )
          : [],
      );
      const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;
      const maplessHallIds = new Set<string>(
        (maplessKey ? hallDefinitions[activeEventName]?.[maplessKey] || [] : []).map((h) => h.id),
      );

      const { mapSettings, maplessSettings } = splitGlobalHallRouteSettings({
        settings,
        mapHallIds,
        maplessHallIds,
        hasMapTab: !!globalHallOrderMapTabName,
      });

      setHallRouteSettings((prev) => {
        const eventSettings = { ...(prev[activeEventName] || {}) };
        if (globalHallOrderMapTabName) {
          eventSettings[globalHallOrderMapTabName] = mapSettings;
        }
        if (maplessKey) eventSettings[maplessKey] = maplessSettings;
        return {
          ...prev,
          [activeEventName]: eventSettings,
        };
      });
    },
    [activeEventName, activeEventDate, globalHallOrderMapTabName, hallDefinitions],
  );

  const getGlobalHallItemCount = useCallback(
    (groupId: string): number => {
      if (!activeEventName || !activeEventDate) return 0;
      const executeIds =
        executeModeItems[activeEventName]?.[activeEventDate] || [];
      return computeGlobalHallItemCount({
        groupId,
        executeIds,
        items,
        getItemHallId,
      });
    },
    [activeEventName, activeEventDate, executeModeItems, items, getItemHallId],
  );


  const handleReorderExecuteListByHallOrder = useCallback(
    (hallOrder: string[]) => {
      if (!activeEventName) return;
      const sharingSession =
        activeSharingSession?.eventName === activeEventName ? activeSharingSession : null;

      if (!activeEventDate) return;
      const dayName = activeEventDate;

      const mapTabForDate = getMapTabForDate(dayName);
      const currentMapData = mapTabForDate
        ? mapData[activeEventName]?.[mapTabForDate]
        : undefined;
      const mapHalls = mapTabForDate
        ? hallDefinitions[activeEventName]?.[mapTabForDate] || []
        : [];
      const maplessKey = getMaplessKey(dayName);
      const maplessHalls = hallDefinitions[activeEventName]?.[maplessKey] || [];
      const halls = [...mapHalls, ...maplessHalls];
      const currentHallRouteSettings = getCombinedHallRouteSettingsForDate({
        eventName: activeEventName,
        dayName,
        mapTabName: mapTabForDate,
        hallRouteSettings,
      });

      const currentEventItems = executeModeItemsRef.current[activeEventName] || {};
      const currentDayItems = [...(currentEventItems[dayName] || [])];
      if (currentDayItems.length === 0) return;
      const reorderedItems = reorderExecuteIdsByHallOrder({
        hallOrder,
        dayItems: currentDayItems,
        items,
        halls,
        mapData: currentMapData,
        hallRouteSettings: currentHallRouteSettings,
      });

      if (sharingSession) {
        void saveSharingRouteOrderMutation(
          sharingSession,
          activeEventName,
          dayName,
          reorderedItems,
          '共有アイテムの巡回順を更新しました。',
        );
        return;
      }

      updateExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: reorderedItems,
          },
        };
      });
    },
    [
      activeEventName,
      activeEventDate,
      activeSharingSession,
      getMapTabForDate,
      mapData,
      hallDefinitions,
      hallRouteSettings,
      items,
      saveSharingRouteOrderMutation,
      updateExecuteModeItems,
    ],
  );


  const [hallDefinitionMode, setHallDefinitionMode] = useState(false);


  const [vertexSelectionMode, setVertexSelectionMode] = useState<{
    clickedVertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);


  const [pendingVertexSelection, setPendingVertexSelection] = useState<{
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);
  const [vertexGuideOptions, setVertexGuideOptions] = useState({
    showGrid: true,
    showRuler: true,
  });


  const handleStartVertexSelection = useCallback((editingData?: unknown) => {
    setVertexSelectionMode({ clickedVertices: [], editingData });
    setHallDefinitionMode(false);
  }, []);


  const sortVerticesNonCrossing = useCallback(
    (vertices: { row: number; col: number }[]): { row: number; col: number }[] => {
      if (vertices.length <= 2) return vertices;


      const centroidRow = vertices.reduce((sum, v) => sum + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((sum, v) => sum + v.col, 0) / vertices.length;


      const sorted = [...vertices].sort((a, b) => {
        const angleA = Math.atan2(a.row - centroidRow, a.col - centroidCol);
        const angleB = Math.atan2(b.row - centroidRow, b.col - centroidCol);
        return angleA - angleB;
      });

      return sorted;
    },
    [],
  );


  const handleConfirmVertexSelection = useCallback(() => {
    if (guardSharingStructureMutation(activeEventName)) return;
    if (vertexSelectionMode) {
      const sorted = sortVerticesNonCrossing(vertexSelectionMode.clickedVertices);
      setPendingVertexSelection({
        vertices: sorted,
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [sortVerticesNonCrossing, vertexSelectionMode, activeEventName, guardSharingStructureMutation]);


  const handleCancelVertexSelection = useCallback(() => {
    if (vertexSelectionMode?.editingData) {
      setPendingVertexSelection({
        vertices: [],
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [vertexSelectionMode]);


  useEffect(() => {
    const handleMapCellClickForVertex = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!vertexSelectionMode) return;

      const { row, col } = e.detail;

      setVertexSelectionMode((prev) => {
        if (!prev) return prev;


        const existingIndex = prev.clickedVertices.findIndex((v) => v.row === row && v.col === col);
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter((_, i) => i !== existingIndex),
          };
        }


        if (prev.clickedVertices.length >= 6) {
          return prev;
        }

        return {
          ...prev,
          clickedVertices: [...prev.clickedVertices, { row, col }],
        };
      });
    };

    window.addEventListener('mapCellClick', handleMapCellClickForVertex as EventListener);
    return () => {
      window.removeEventListener('mapCellClick', handleMapCellClickForVertex as EventListener);
    };
  }, [vertexSelectionMode]);


  const handleStartCellSelection = useCallback(
    (type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual', editingData?: unknown) => {
      setCellSelectionMode({ type, clickedCells: [], editingBlockData: editingData });
      setBlockDefinitionMode(false);
    },
    [],
  );


  const handleConfirmCellSelection = useCallback(() => {
    if (guardSharingStructureMutation(activeEventName)) return;
    if (cellSelectionMode) {
      setPendingCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true);
  }, [cellSelectionMode, activeEventName, guardSharingStructureMutation]);


  const handleCancelCellSelection = useCallback(() => {
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: 'cancelled',
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true);
  }, [cellSelectionMode]);


  useEffect(() => {
    const handleMapCellClick = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!cellSelectionMode) return;

      const { row, col } = e.detail;

      setCellSelectionMode((prev) => {
        if (!prev) return prev;


        const existingIndex = prev.clickedCells.findIndex((c) => c.row === row && c.col === col);
        if (existingIndex >= 0) {
          return {
            ...prev,
            clickedCells: prev.clickedCells.filter((_, i) => i !== existingIndex),
          };
        }


        return {
          ...prev,
          clickedCells: [...prev.clickedCells, { row, col }],
        };
      });
    };

    window.addEventListener('mapCellClick', handleMapCellClick as EventListener);
    return () => window.removeEventListener('mapCellClick', handleMapCellClick as EventListener);
  }, [cellSelectionMode]);

  const TabButton: React.FC<{
    tab: ActiveTab;
    label: string;
    count?: number;
    onClick?: () => void;
  }> = ({ tab, label, count, onClick }) => {
    const longPressTimeout = React.useRef<number | null>(null);

    const handlePointerDown = () => {
      if (!activeEventName) return;

      longPressTimeout.current = window.setTimeout(() => {
        if (eventDates.includes(tab)) {
          handleToggleMode();
        }
        longPressTimeout.current = null;
      }, 500);
    };

    const handlePointerUp = () => {
      if (longPressTimeout.current) {
        clearTimeout(longPressTimeout.current);
        longPressTimeout.current = null;
      }
    };

    const handleClick = () => {
      if (mapTabMenuOpen) {
        setMapTabMenuOpen(null);
      }
      if (onClick) {
        onClick();
      } else {
        setItemToEdit(null);
        setSelectedItemIds(new Set());
        setSelectedBlockFilters(new Set());
        setCandidateNumberSortDirection(null);
        setCollapsedSpaces(new Set());
        setActiveTab(tab);
      }
    };

    return (
      <button
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
          activeTab === tab
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
        }`}
      >
        {label}{' '}
        {typeof count !== 'undefined' && (
          <span className="text-xs bg-slate-200 dark:text-slate-700 rounded-full px-2 py-0.5 ml-1">
            {count}
          </span>
        )}
      </button>
    );
  };

  const executeColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds =
      activeRouteScope === 'member'
        ? activeMemberRouteItemIds
        : executeModeItems[activeEventName]?.[currentEventDate] || [];
    const itemsMap = new Map(items.map((item) => [item.id, item]));
    const orderedItems = executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
    return filterAssignedOnlyItems(orderedItems);
  }, [
    activeEventName,
    activeRouteScope,
    activeMemberRouteItemIds,
    activeTab,
    executeModeItems,
    items,
    eventDates,
    filterAssignedOnlyItems,
  ]);

  useEffect(() => {
    executeColumnItemsRef.current = executeColumnItems;
  }, [executeColumnItems]);

  useEffect(() => {
    recentlyChangedItemIdsRef.current = recentlyChangedItemIds;
  }, [recentlyChangedItemIds]);

  useEffect(() => {
    setShowPostponeFilterButton(false);
    setShowLateFilterButton(false);
  }, [currentMode, sortState]);

  const baseFilteredItems = useMemo(() => {
    const currentEventDate = activeEventDate;
    const itemsForTab = currentTabItems;

    if (!activeEventName) return itemsForTab;

    const mode = dayModes[activeEventName]?.[currentEventDate];

    if (mode === 'execute') {
      if (sortState === 'Manual') {
        return executeColumnItems;
      }
      const filterStatus = sortState as Exclude<SortState, 'Manual'>;
      return executeColumnItems.filter((item) => matchesPurchaseStatusFilter(item, filterStatus));
    }


    return itemsForTab;
  }, [
    activeTab,
    currentTabItems,
    sortState,
    activeEventName,
    dayModes,
    executeColumnItems,
    eventDates,
  ]);

  const baseFilteredItemIds = useMemo(
    () => new Set(baseFilteredItems.map((item) => item.id)),
    [baseFilteredItems],
  );

  const temporaryVisibleItems = useMemo(() => {
    if (!activeEventName) return [];
    const mode = dayModes[activeEventName]?.[activeEventDate];
    if (mode !== 'execute' || sortState === 'Manual') return [];

    return executeColumnItems.filter(
      (item) => recentlyChangedItemIds.has(item.id) && !baseFilteredItemIds.has(item.id),
    );
  }, [
    activeEventDate,
    activeEventName,
    baseFilteredItemIds,
    dayModes,
    executeColumnItems,
    recentlyChangedItemIds,
    sortState,
  ]);

  const temporaryVisibleCount = temporaryVisibleItems.length;
  const limitedCounts = useMemo(() => getLimitedPurchaseCounts(baseFilteredItems), [baseFilteredItems]);

  const sortDisplayLabel = useMemo(() => {
    const buildTemporaryLabel = (baseLabel: string): string =>
      temporaryVisibleCount > 0
        ? `${baseLabel}\uFF08\u4E00\u6642\u8868\u793A${temporaryVisibleCount}\u4EF6\uFF09`
        : baseLabel;

    if (sortState !== 'LimitedPurchase') {
      return buildTemporaryLabel(sortLabels[sortState]);
    }

    const details = [
      limitedCounts.missing > 0 ? `\u672A\u5165\u529B${limitedCounts.missing}` : null,
      temporaryVisibleCount > 0
        ? `\u4E00\u6642\u8868\u793A${temporaryVisibleCount}`
        : null,
    ].filter(Boolean);

    return details.length > 0
      ? `\u9650\u6570 ${limitedCounts.total}\u4EF6\uFF08${details.join('\u30FB')}\uFF09`
      : `\u9650\u6570 ${limitedCounts.total}\u4EF6`;
  }, [limitedCounts.missing, limitedCounts.total, sortState, temporaryVisibleCount]);

  const visibleItemIds = useMemo(() => {
    const currentEventDate = activeEventDate;
    if (!activeEventName) return new Set(baseFilteredItems.map((item) => item.id));
    const mode = dayModes[activeEventName]?.[currentEventDate];
    if (mode !== 'execute' || sortState === 'Manual') {
      return new Set(baseFilteredItems.map((item) => item.id));
    }

    return new Set([
      ...baseFilteredItems.map((item) => item.id),
      ...temporaryVisibleItems.map((item) => item.id),
    ]);
  }, [activeEventDate, activeEventName, baseFilteredItems, dayModes, sortState, temporaryVisibleItems]);

  const visibleItems = useMemo(() => {
    if (!activeEventName) return currentTabItems;
    const mode = dayModes[activeEventName]?.[activeEventDate];
    if (mode === 'execute') {
      return executeColumnItems.filter((item) => visibleItemIds.has(item.id));
    }
    return baseFilteredItems;
  }, [
    activeEventDate,
    activeEventName,
    baseFilteredItems,
    currentTabItems,
    dayModes,
    executeColumnItems,
    visibleItemIds,
  ]);

  const effectiveExecuteModeItems = useMemo(() => {
    if (
      !activeEventName ||
      !activeEventDate ||
      activeRouteScope !== 'member' ||
      !activeRouteMemberId
    ) {
      return executeModeItems;
    }

    return {
      ...executeModeItems,
      [activeEventName]: {
        ...(executeModeItems[activeEventName] ?? {}),
        [activeEventDate]: activeMemberRouteItemIds,
      },
    };
  }, [
    activeEventDate,
    activeEventName,
    activeMemberRouteItemIds,
    activeRouteMemberId,
    activeRouteScope,
    executeModeItems,
  ]);

  const focusModeItems = useMemo(
    () => {
      if (activeRouteScope !== 'member') return filterAssignedOnlyItems(items);
      const visibleIds = new Set(activeMemberRouteItemIds);
      return items.filter((item) => visibleIds.has(item.id));
    },
    [activeMemberRouteItemIds, activeRouteScope, filterAssignedOnlyItems, items],
  );


  const searchMatches = useMemo(() => {
    if (!searchKeyword.trim() || !activeEventName || !eventDates.includes(activeTab)) {
      return [];
    }

    const keyword = searchKeyword.trim().toLowerCase();
    const matches: string[] = [];

    currentTabItems.forEach((item) => {
      const circleMatch = item.circle.toLowerCase().includes(keyword);
      const titleMatch = item.title.toLowerCase().includes(keyword);
      const remarksMatch = item.remarks.toLowerCase().includes(keyword);

      if (circleMatch || titleMatch || remarksMatch) {
        matches.push(item.id);
      }
    });

    return matches;
  }, [searchKeyword, activeEventName, activeTab, currentTabItems, eventDates]);


  useEffect(() => {
    if (searchKeyword.trim()) {
      if (searchMatches.length > 0) {
        setCurrentSearchIndex(0);
      } else {
        setCurrentSearchIndex(-1);
        setHighlightedItemId(null);
      }
    } else {
      setCurrentSearchIndex(-1);
      setHighlightedItemId(null);
    }
  }, [searchKeyword, searchMatches]);


  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab]);


  const duplicateCircleItemIds = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return new Set<string>();
    const itemsForTab = currentTabItems;
    const circleCountMap = new Map<string, number>();
    const circleItemIdsMap = new Map<string, string[]>();

    itemsForTab.forEach((item) => {
      const circle = item.circle.trim();
      if (circle) {
        const count = circleCountMap.get(circle) || 0;
        circleCountMap.set(circle, count + 1);

        if (!circleItemIdsMap.has(circle)) {
          circleItemIdsMap.set(circle, []);
        }
        circleItemIdsMap.get(circle)!.push(item.id);
      }
    });


    const duplicateIds = new Set<string>();
    circleCountMap.forEach((count, circle) => {
      if (count > 1) {
        const itemIds = circleItemIdsMap.get(circle) || [];
        itemIds.forEach((id) => duplicateIds.add(id));
      }
    });

    return duplicateIds;
  }, [activeEventName, activeTab, currentTabItems, eventDates]);


  const availableBlocks = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds = new Set(
      activeRouteScope === 'member'
        ? activeMemberRouteItemIds
        : executeModeItems[activeEventName]?.[currentEventDate] || [],
    );
    const candidateItems = currentTabItems.filter((item) => !executeIds.has(item.id));
    const blocks = new Set(candidateItems.map((item) => item.block).filter(Boolean));
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
    });
  }, [
    activeEventName,
    activeRouteScope,
    activeMemberRouteItemIds,
    activeTab,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);

  const allBlocksForHallDefinition = useMemo(() => {
    if (!activeEventName) return [];
    const blocks = new Set(currentTabItems.map((item) => item.block).filter(Boolean));
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
    });
  }, [activeEventName, currentTabItems]);

  const currentMaplessHalls = useMemo(() => {
    if (!activeEventName || !activeEventDate) return [];
    return hallDefinitions[activeEventName]?.[getMaplessKey(activeEventDate)] || [];
  }, [activeEventName, activeEventDate, hallDefinitions]);

  const candidateColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds = new Set(
      activeRouteScope === 'member'
        ? activeMemberRouteItemIds
        : executeModeItems[activeEventName]?.[currentEventDate] || [],
    );
    let filtered = currentTabItems.filter((item) => !executeIds.has(item.id));

    if (activeRouteScope === 'member' && activeRouteMemberId) {
      filtered = filtered.filter((item) => {
        if (activeCandidateFilter === 'assignedOnly') {
          return item.assignedTo === activeRouteMemberId;
        }
        if (activeCandidateFilter === 'includeUnassigned') {
          return !item.assignedTo || item.assignedTo === activeRouteMemberId;
        }
        return true;
      });
    }


    if (selectedBlockFilters.size > 0) {
      filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
    }

    if (candidateNumberSortDirection !== null) {
      return filtered;
    }

    return [...filtered].sort((a, b) => {
      const blockComparison = a.block.localeCompare(b.block, 'ja', {
        numeric: true,
        sensitivity: 'base',
      });
      if (blockComparison !== 0) return blockComparison;

      return a.number.localeCompare(b.number, 'ja', {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [
    activeEventName,
    activeRouteScope,
    activeRouteMemberId,
    activeCandidateFilter,
    activeMemberRouteItemIds,
    activeTab,
    executeModeItems,
    currentTabItems,
    selectedBlockFilters,
    eventDates,
    candidateNumberSortDirection,
  ]);

  const candidateInoperableItemIds = useMemo(() => {
    if (
      activeRouteScope !== 'member' ||
      !activeRouteMemberId ||
      activeSharingSession?.role === 'host'
    ) {
      return new Set<string>();
    }

    return new Set(
      candidateColumnItems
        .filter((item) => !!item.assignedTo && item.assignedTo !== activeRouteMemberId)
        .map((item) => item.id),
    );
  }, [
    activeRouteMemberId,
    activeRouteScope,
    activeSharingSession?.role,
    candidateColumnItems,
  ]);


  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];

    const currentEventDate = activeEventDate;
    const mode = activeEventName ? dayModes[activeEventName]?.[currentEventDate] : undefined;

    let visibleItemIds: Set<string>;

    if (mode === 'execute') {
      visibleItemIds = new Set(visibleItems.map((item) => item.id));
    } else {
      const allVisibleIds = new Set([
        ...executeColumnItems.map((item) => item.id),
        ...candidateColumnItems.map((item) => item.id),
      ]);
      visibleItemIds = allVisibleIds;
    }

    return searchMatches.filter((id) => visibleItemIds.has(id));
  }, [
    searchMatches,
    activeEventName,
    activeTab,
    eventDates,
    dayModes,
    visibleItems,
    executeColumnItems,
    candidateColumnItems,
  ]);


  const handleSearchNext = useCallback(() => {
    if (!searchKeyword.trim() || visibleSearchMatches.length === 0) {
      if (searchMatches.length > 0 && visibleSearchMatches.length === 0) {
        alert('現在の絞り込み条件では一致する項目がありません。');
      }
      return;
    }


    const startIndex = currentSearchIndex === -1 ? -1 : currentSearchIndex;
    const nextIndex = (startIndex + 1) % visibleSearchMatches.length;
    setCurrentSearchIndex(nextIndex);

    const nextItemId = visibleSearchMatches[nextIndex];
    setHighlightedItemId(nextItemId);


    setTimeout(() => {
      const element = document.querySelector(`[data-item-id="${nextItemId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);


  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const candidateItems = currentTabItems.filter((item) => !executeIds.has(item.id));

    const blocksWithPriority = new Set<string>();
    candidateItems.forEach((item) => {
      if (item.remarks && (item.remarks.includes('優先') || item.remarks.includes('委託無'))) {
        blocksWithPriority.add(item.block);
      }
    });

    return blocksWithPriority;
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, eventDates]);


  const hasCandidateSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
    return selectedItems.some((item) => currentTabItems.includes(item) && !executeIds.has(item.id));
  }, [
    activeEventName,
    activeTab,
    currentMode,
    selectedItemIds,
    items,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);


  const hasExecuteSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
    return selectedItems.some((item) => currentTabItems.includes(item) && executeIds.has(item.id));
  }, [
    activeEventName,
    activeTab,
    currentMode,
    selectedItemIds,
    items,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);


  const showMoveButtons =
    (hasCandidateSelection && !hasExecuteSelection) ||
    (hasExecuteSelection && !hasCandidateSelection);

  if (!isInitialized) {
    return null;
  }

  const mainContentVisible = eventDates.includes(activeTab);

  const handleZoomChange = (newZoom: number) => {
    setZoomLevel(Math.max(15, Math.min(150, newZoom)));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200 font-sans">
      <AppHeaderShell
        activeEventDate={activeEventDate}
        activeEventName={activeEventName}
        activeTab={activeTab}
        blockSortDirection={blockSortDirection}
        currentHalls={currentHalls}
        currentMapData={currentMapData}
        currentMapTabName={currentMapTabName}
        currentMapTabRotationState={currentMapTabRotationState}
        currentMode={currentMode}
        currentSearchIndex={currentSearchIndex}
        DEFAULT_OUTLINE_STYLE={DEFAULT_OUTLINE_STYLE}
        DEFAULT_PURCHASE_STATUS_CONTROL_MODE={DEFAULT_PURCHASE_STATUS_CONTROL_MODE}
        DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY={
          DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY
        }
        DEFAULT_UI_VISIBILITY={DEFAULT_UI_VISIBILITY}
        disablePriceUndefinedCheck={disablePriceUndefinedCheck}
        disableLimitedPurchaseQuantityCheck={disableLimitedPurchaseQuantityCheck}
        skipLimitedPurchaseForSingleQuantity={skipLimitedPurchaseForSingleQuantity}
        eventDates={eventDates}
        executeSpaceGroupingEnabled={executeSpaceGroupingEnabled}
        getHallExecuteCount={getHallExecuteCount}
        getHallTotalItemCount={getHallTotalItemCount}
        getMapTabForDate={getMapTabForDate}
        globalHallOrderHalls={globalHallOrderHalls}
        globalHallOrderMapTabName={globalHallOrderMapTabName}
        handleBlockSortToggle={handleBlockSortToggle}
        handleBlockSortToggleCandidate={handleBlockSortToggleCandidate}
        handleBulkSort={handleBulkSort}
        handleClearSelection={handleClearSelection}
        handleMapTabRotationAngleChange={handleMapTabRotationAngleChange}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        handleSearchNext={handleSearchNext}
        handleSetViewMode={handleSetViewMode}
        handleSortToggle={handleSortToggle}
        hasCandidateSelection={hasCandidateSelection}
        hasExecuteSelection={hasExecuteSelection}
        hasUndefinedPriorityItems={hasUndefinedPriorityItems}
        isMapTab={isMapTab}
        items={items}
        itemToEdit={itemToEdit}
        layoutMode={layoutMode}
        mainContentVisible={mainContentVisible}
        mapHallSelectorOpen={mapHallSelectorOpen}
        mapIsRouteVisible={mapIsRouteVisible}
        mapSelectedHallId={mapSelectedHallId}
        mapSmartInsertEnabled={mapSmartInsertEnabled}
        mapSmartInsertMode={mapSmartInsertMode}
        mapTabMenuOpen={mapTabMenuOpen}
        mapTabMenuPosition={mapTabMenuPosition}
        mapToggleButtonRef={mapToggleButtonRef}
        mapToggleLongPressFiredRef={mapToggleLongPressFiredRef}
        mapToggleLongPressRef={mapToggleLongPressRef}
        mapToggleMenuRef={mapToggleMenuRef}
        mapViewActive={mapViewActive}
        numberCellOutlineStyle={numberCellOutlineStyle}
        openVisitListPanel={openVisitListPanel}
        purchaseStatusControlMode={purchaseStatusControlMode}
        searchKeyword={searchKeyword}
        selectedItemIds={selectedItemIds}
        setActiveEventName={setActiveEventName}
        setActiveTab={setActiveTab}
        setBlockDefinitionMode={setBlockDefinitionMode}
        setExecuteCollapsedSpaces={setExecuteCollapsedSpaces}
        setExecuteSpaceGroupingEnabled={setExecuteSpaceGroupingEnabled}
        setGlobalHallOrderPanelOpen={setGlobalHallOrderPanelOpen}
        setHallDefinitionMode={setHallDefinitionMode}
        setItemToEdit={setItemToEdit}
        setLayoutMode={setLayoutMode}
        setMapHallSelectorOpen={setMapHallSelectorOpen}
        setMapIsHallOrderOpen={setMapIsHallOrderOpen}
        setMapIsRouteVisible={setMapIsRouteVisible}
        setMapSelectedHallId={setMapSelectedHallId}
        setMapSmartInsertEnabled={setMapSmartInsertEnabled}
        setMapSmartInsertMode={setMapSmartInsertMode}
        setMapTabMenuOpen={setMapTabMenuOpen}
        setMapTabMenuPosition={setMapTabMenuPosition}
        setMapViewActive={setMapViewActive}
        setDisablePriceUndefinedCheck={setDisablePriceUndefinedCheck}
        setDisableLimitedPurchaseQuantityCheck={setDisableLimitedPurchaseQuantityCheck}
        setSkipLimitedPurchaseForSingleQuantity={setSkipLimitedPurchaseForSingleQuantity}
        setNumberCellOutlineStyle={setNumberCellOutlineStyle}
        setPurchaseStatusControlMode={setPurchaseStatusControlMode}
        setSearchKeyword={setSearchKeyword}
        setSelectedBlockFilters={setSelectedBlockFilters}
        setSelectedItemIds={setSelectedItemIds}
        setSimpleHallDefinitionMode={setSimpleHallDefinitionMode}
        setThemeMode={setThemeMode}
        setUiSettingsPanelOpen={setUiSettingsPanelOpen}
        setUiVisibilityOverride={setUiVisibilityOverride}
        setUiVisibilitySettings={setUiVisibilitySettings}
        showHeaderBar={showHeaderBar}
        showMoveButtons={showMoveButtons}
        showSmartInsertToast={showSmartInsertToast}
        showTabBar={showTabBar}
        smartInsertLongPressRef={smartInsertLongPressRef}
        smartInsertLongPressTriggeredRef={smartInsertLongPressTriggeredRef}
        sortLabels={sortLabels}
        sortDisplayLabel={sortDisplayLabel}
        sortState={sortState}
        TabButton={TabButton}
        themeMode={themeMode}
        uiSettingsPanelOpen={uiSettingsPanelOpen}
        uiVisibilitySettings={uiVisibilitySettings}
        updateUIVisibilityConfig={updateUIVisibilityConfig}
        visibleSearchMatches={visibleSearchMatches}
      />


      {rawHideSomething &&
        activeEventName &&
        (currentMode === 'focus' || currentMode === 'execute') && (
          <button
            onClick={() => {
              setUiVisibilityOverride((prev) => !prev);
              setUiSettingsPanelOpen(false);
            }}
            className={`fixed left-3 top-3 z-20 w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-all touch-manipulation select-none ${
              uiVisibilityOverride
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600 backdrop-blur-sm border border-slate-200 dark:border-slate-600'
            }`}
            title={uiVisibilityOverride ? '自動表示に戻す' : '画面要素をすべて表示'}
            style={{ WebkitTapHighlightColor: 'transparent' }}
            type="button"
          >
            {uiVisibilityOverride ? (
              <svg
                className="w-5 h-5 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                />
              </svg>
            ) : (
              <svg
                className="w-5 h-5 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
            )}
          </button>
        )}

      {sharingPanelMode && (
        <SharingMvp0cPanel
          mode={sharingPanelMode}
          eventName={sharingPanelEventName}
          eventNames={sharingEventNames}
          activeEventName={activeEventName}
          sessions={sharingSessions}
          busy={sharingBusy}
          availability={sharingAvailability}
          statusMessage={sharingStatusMessage}
          errorMessage={sharingErrorMessage}
          initialJoinRoomCode={initialJoinRoomCode}
          onCreateRoom={handleCreateSharingRoom}
          onJoinRoom={handleJoinSharingRoom}
          onRestoreRoom={handleRestoreSharingRoom}
          assignmentMembers={activeSharingAssignmentMembers}
          selectedItemCount={selectedItemIds.size}
          assignedOnly={sharingAssignedOnly}
          onAssignedOnlyChange={setSharingAssignedOnly}
          onBulkAssignSelected={handleBulkAssignSelectedSharingItems}
          onPauseSession={handlePauseSharingSession}
          onResumeSession={handleResumeSharingSession}
          onLeaveSession={handleLeaveSharingSession}
          onLocalizeSession={handleLocalizeSharingSession}
          notifications={activeSharingNotificationEntries}
          onRefreshNotifications={refreshSharingNotifications}
          onMarkNotificationRead={handleMarkSharingNotificationRead}
          onHideNotification={handleHideSharingNotification}
          onClose={handleCloseSharingPanel}
        />
      )}

      {activeSharingSession && (
        <div className="mx-4 mt-3 border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 md:mx-6">
          {activeSharingSession.eventName} は共有中です。アイテム変更と巡回順を共有同期中です。イベント設定・マップ・会場などの構造変更は停止しています。
        </div>
      )}

      <AppMainContent
        activeEventDate={activeEventDate}
        activeEventName={activeEventName}
        activeTab={activeTab}
        availableBlocks={availableBlocks}
        blocksWithPriorityRemarks={blocksWithPriorityRemarks}
        candidateColumnItems={candidateColumnItems}
        candidateInoperableItemIds={candidateInoperableItemIds}
        candidateNumberSortDirection={candidateNumberSortDirection}
        cellSelectionMode={cellSelectionMode}
        collapsedSpaces={collapsedSpaces}
        currentFocusMapRotationState={currentFocusMapRotationState}
        currentFocusResumeState={currentFocusResumeState}
        currentFocusSessionKey={currentFocusSessionKey}
        currentHallRouteSettings={currentHallRouteSettings}
        currentHalls={currentHalls}
        currentMapData={currentMapData}
        currentMapExecuteItemIds={currentMapExecuteItemIds}
        currentMapMemberRouteItems={currentMapMemberRouteItems}
        currentMapTabName={currentMapTabName}
        currentMapTabRotationState={currentMapTabRotationState}
        currentMapTabViewport={currentMapTabViewport}
        currentMode={currentMode}
        disablePriceUndefinedCheck={disablePriceUndefinedCheck}
        disableLimitedPurchaseQuantityCheck={disableLimitedPurchaseQuantityCheck}
        skipLimitedPurchaseForSingleQuantity={skipLimitedPurchaseForSingleQuantity}
        duplicateCircleItemIds={duplicateCircleItemIds}
        eventDates={eventDates}
        eventLists={eventLists}
        executeCollapsedSpaces={executeCollapsedSpaces}
        executeColumnItems={executeColumnItems}
        executeModeItems={effectiveExecuteModeItems}
        executeSpaceGroupingEnabled={executeSpaceGroupingEnabled}
        focusModeItems={focusModeItems}
        routeScope={activeRouteScope}
        routeMemberId={activeRouteMemberId}
        routeCandidateFilter={activeCandidateFilter}
        exportFileInputRef={exportFileInputRef}
        getHallOrderForDate={getHallOrderForDate}
        getHallsForDate={getHallsForDate}
        getMapDataForDate={getMapDataForDate}
        hallDefinitions={hallDefinitions}
        hallRouteSettings={hallRouteSettings}
        handleActivateLateFilter={handleActivateLateFilter}
        handleActivatePostponeFilter={handleActivatePostponeFilter}
        handleAddItemFromFocusMode={handleAddItemFromFocusMode}
        handleAddNewItemFromMap={handleAddNewItemFromMap}
        handleAddToExecuteListFromMap={handleAddToExecuteListFromMap}
        handleAddToExecuteListFromMapAtPosition={handleAddToExecuteListFromMapAtPosition}
        handleBatchAddToExecuteListFromMap={handleBatchAddToExecuteListFromMap}
        handleBatchAddToExecuteListFromMapAtPosition={handleBatchAddToExecuteListFromMapAtPosition}
        handleBatchRemoveFromExecuteListFromMap={handleBatchRemoveFromExecuteListFromMap}
        handleBulkAdd={handleBulkAdd}
        handleBulkStatusChange={handleBulkStatusChange}
        handleCandidateNumberSort={handleCandidateNumberSort}
        handleClearBlockFilters={handleClearBlockFilters}
        handleClearNewItemDefaults={handleClearNewItemDefaults}
        handleCollapseAndOpenNext={handleCollapseAndOpenNext}
        handleDeleteEvent={handleDeleteEvent}
        handleDeleteItemFromMap={handleDeleteItemFromMap}
        handleDeleteRequest={handleDeleteRequest}
        handleDoneEditing={handleDoneEditing}
        handleEditRequest={handleEditRequest}
        handleExecuteItemUpdate={handleExecuteItemUpdate}
        handleExecuteSpaceGroupOrderChange={handleExecuteSpaceGroupOrderChange}
        handleExecuteToggleAllSpaceCollapse={handleExecuteToggleAllSpaceCollapse}
        handleExecuteToggleSpaceCollapse={handleExecuteToggleSpaceCollapse}
        handleExportEvent={handleExportEvent}
        handleFocusMapRotationAngleChange={handleFocusMapRotationAngleChange}
        handleFocusSessionStateChange={handleFocusSessionStateChange}
        handleImportMapData={handleImportMapData}
        handleCreateSharingRoomFromMenu={
          sharingAvailability.enabled ? handleCreateSharingRoomFromMenu : undefined
        }
        handleJoinSharingRoomFromMenu={
          sharingAvailability.enabled ? handleOpenSharingJoinPanel : undefined
        }
        handleShowSharingInviteFromMenu={handleOpenSharingInvitePanel}
        handleShowSharingStatusFromMenu={handleOpenSharingStatusPanel}
        handleMapTabRotationAngleChange={handleMapTabRotationAngleChange}
        handleMapViewportChange={handleMapViewportChange}
        handleModeChangeFromFocus={handleModeChangeFromFocus}
        handleMoveItem={handleMoveItem}
        handleMoveItemDown={handleMoveItemDown}
        handleMoveItemUp={handleMoveItemUp}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        handleMoveToFirstFromMap={handleMoveToFirstFromMap}
        handleMoveToLastFromMap={handleMoveToLastFromMap}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        handleRemoveFromExecuteListFromMap={handleRemoveFromExecuteListFromMap}
        handleRenameEvent={handleRenameEvent}
        handleReorderExecuteListByHallOrder={handleReorderExecuteListByHallOrder}
        handleSelectEvent={handleSelectEvent}
        handleSelectItem={handleSelectItem}
        handleSelectSpaceGroupForRange={handleSelectSpaceGroupForRange}
        handleSetSpaceGroupDragItemIds={handleSetSpaceGroupDragItemIds}
        handleToggleAllSpaceCollapse={handleToggleAllSpaceCollapse}
        handleToggleBlockFilter={handleToggleBlockFilter}
        handleToggleRangeSelection={handleToggleRangeSelection}
        handleToggleSpaceCollapse={handleToggleSpaceCollapse}
        handleUpdateEvent={handleUpdateEvent}
        handleUpdateHallRouteSettings={handleUpdateHallRouteSettings}
        handleUpdateItem={handleUpdateItem}
        handleUpdateItemPriorityFromEdit={handleUpdateItemPriorityFromEdit}
        isSharingActiveForEvent={hasSharingSessionForEvent}
        highlightedItemId={highlightedItemId}
        highlightedMapCell={highlightedMapCell}
        isMapTab={isMapTab}
        items={items}
        itemToEdit={itemToEdit}
        layoutMode={layoutMode}
        mainContentVisible={mainContentVisible}
        mapData={mapData}
        mapIsHallOrderOpen={mapIsHallOrderOpen}
        mapRouteDisplayMode={activeMapRouteDisplayMode}
        mapIsRouteVisible={mapIsRouteVisible}
        mapSelectedHallId={mapSelectedHallId}
        mapSmartInsertEnabled={mapSmartInsertEnabled}
        mapSmartInsertMode={mapSmartInsertMode}
        newItemDefaults={newItemDefaults}
        numberCellOutlineStyle={numberCellOutlineStyle}
        purchaseStatusControlMode={purchaseStatusControlMode}
        rangeEnd={rangeEnd}
        rangeStart={rangeStart}
        selectedBlockFilters={selectedBlockFilters}
        selectedItemIds={selectedItemIds}
        setCollapsedSpaces={setCollapsedSpaces}
        setFocusModeMapVisible={setFocusModeMapVisible}
        setLayoutMode={setLayoutMode}
        setMapIsHallOrderOpen={setMapIsHallOrderOpen}
        setMapIsRouteVisible={setMapIsRouteVisible}
        setMapSelectedHallId={setMapSelectedHallId}
        setSpaceGroupingEnabled={setSpaceGroupingEnabled}
        showLateFilterButton={showLateFilterButton}
        showPostponeFilterButton={showPostponeFilterButton}
        spaceGroupingEnabled={spaceGroupingEnabled}
        vertexGuideOptions={vertexGuideOptions}
        vertexSelectionMode={vertexSelectionMode}
        visibleItems={visibleItems}
        visitListPanelOpen={visitListPanelOpen}
        zoomLevel={zoomLevel}
        assignmentMembers={activeSharingAssignmentMembers}
        canAssignItem={canAssignSharingItem}
        onAssignItem={handleAssignSharingItem}
        sharingAssignmentRouteGroups={sharingAssignmentRouteGroups}
        onApplySharingAssignmentRouteOrder={
          activeSharingSession ? handleApplySharingAssignmentRouteOrder : undefined
        }
        onRouteScopeChange={activeSharingSession ? handleRouteScopeChange : undefined}
        onRouteMemberChange={activeSharingSession ? handleSelectedRouteMemberChange : undefined}
        onRouteCandidateFilterChange={
          activeSharingSession ? handleCandidateFilterChange : undefined
        }
        onMapRouteDisplayModeChange={
          activeSharingSession ? handleMapRouteDisplayModeChange : undefined
        }
      />

      <AppOverlayLayer
        editDialogItem={editDialogItem}
        items={items}
        getHallsForDate={getHallsForDate}
        handleUpdateItem={handleUpdateItem}
        handleUpdateHallOrderForPriorityChangeFromEdit={handleUpdateHallOrderForPriorityChangeFromEdit}
        setEditDialogItem={setEditDialogItem}
        itemToDelete={itemToDelete}
        handleConfirmDelete={handleConfirmDelete}
        setItemToDelete={setItemToDelete}
        showUpdateConfirmation={showUpdateConfirmation}
        updateData={updateData}
        handleConfirmUpdate={handleConfirmUpdate}
        setShowUpdateConfirmation={setShowUpdateConfirmation}
        setUpdateData={setUpdateData}
        setUpdateEventName={setUpdateEventName}
        showUrlUpdateDialog={showUrlUpdateDialog}
        pendingUpdateEventName={pendingUpdateEventName}
        eventMetadata={eventMetadata}
        handleUrlUpdate={handleUrlUpdate}
        setShowUrlUpdateDialog={setShowUrlUpdateDialog}
        setPendingUpdateEventName={setPendingUpdateEventName}
        setActiveEventName={setActiveEventName}
        setActiveTab={setActiveTab}
        showRenameDialog={showRenameDialog}
        eventToRename={eventToRename}
        handleConfirmRename={handleConfirmRename}
        setShowRenameDialog={setShowRenameDialog}
        setEventToRename={setEventToRename}
        showExportOptions={showExportOptions}
        exportEventName={exportEventName}
        setShowExportOptions={setShowExportOptions}
        setExportEventName={setExportEventName}
        handleConfirmExport={handleConfirmExport}
        mapData={mapData}
        blockDefinitionMode={blockDefinitionMode}
        currentMapData={currentMapData}
        setBlockDefinitionMode={setBlockDefinitionMode}
        setPendingCellSelection={setPendingCellSelection}
        handleUpdateBlocks={handleUpdateBlocks}
        handleStartCellSelection={handleStartCellSelection}
        pendingCellSelection={pendingCellSelection}
        cellSelectionMode={cellSelectionMode}
        handleConfirmCellSelection={handleConfirmCellSelection}
        handleCancelCellSelection={handleCancelCellSelection}
        simpleHallDefinitionMode={simpleHallDefinitionMode}
        setSimpleHallDefinitionMode={setSimpleHallDefinitionMode}
        currentMaplessHalls={currentMaplessHalls}
        handleUpdateMaplessHalls={handleUpdateMaplessHalls}
        allBlocksForHallDefinition={allBlocksForHallDefinition}
        eventDates={eventDates}
        activeEventDate={activeEventDate}
        handleSyncMaplessHallsToOtherDates={handleSyncMaplessHallsToOtherDates}
        globalHallOrderPanelOpen={globalHallOrderPanelOpen}
        setGlobalHallOrderPanelOpen={setGlobalHallOrderPanelOpen}
        globalHallOrderHalls={globalHallOrderHalls}
        globalHallOrderRouteSettings={globalHallOrderRouteSettings}
        handleUpdateGlobalHallRouteSettings={handleUpdateGlobalHallRouteSettings}
        getGlobalHallItemCount={getGlobalHallItemCount}
        handleReorderExecuteListByHallOrder={handleReorderExecuteListByHallOrder}
        hallDefinitionMode={hallDefinitionMode}
        setHallDefinitionMode={setHallDefinitionMode}
        setPendingVertexSelection={setPendingVertexSelection}
        currentHalls={currentHalls}
        handleUpdateHalls={handleUpdateHalls}
        handleStartVertexSelection={handleStartVertexSelection}
        pendingVertexSelection={pendingVertexSelection}
        mapTabDates={mapTabDates}
        handleSyncPolygonHallsToOtherDates={handleSyncPolygonHallsToOtherDates}
        visitListPanelOpen={visitListPanelOpen}
        handleVisitListClose={handleVisitListClose}
        visitListItems={visitListItems}
        handleVisitListOrderUpdate={handleVisitListOrderUpdate}
        visitListHallOrder={visitListHallOrder}
        layoutMode={layoutMode}
        handleHighlightMapCell={handleHighlightMapCell}
        handleClearMapCellHighlight={handleClearMapCellHighlight}
        visitListHasUnsavedChanges={visitListHasUnsavedChanges}
        handleVisitListConfirm={handleVisitListConfirm}
        handleVisitListCancel={handleVisitListCancel}
        handleUpdateItemPriority={handleUpdateItemPriority}
        showVisitListConfirmDialog={showVisitListConfirmDialog}
        handleVisitListDialogCancel={handleVisitListDialogCancel}
        handleVisitListDialogConfirm={handleVisitListDialogConfirm}
        vertexSelectionMode={vertexSelectionMode}
        vertexGuideOptions={vertexGuideOptions}
        setVertexGuideOptions={setVertexGuideOptions}
        handleConfirmVertexSelection={handleConfirmVertexSelection}
        handleCancelVertexSelection={handleCancelVertexSelection}
        mapFileInputRef={mapFileInputRef}
        handleMapFileChange={handleMapFileChange}
        mapImportDialogOpen={mapImportDialogOpen}
        mapImportPendingFile={mapImportPendingFile}
        mapImportPendingEventName={mapImportPendingEventName}
        handleMapImportConfirm={handleMapImportConfirm}
        handleMapImportClose={handleMapImportClose}
        exportFileInputRef={exportFileInputRef}
        handleExportFileImport={handleExportFileImport}
        activeEventName={activeEventName}
        mainContentVisible={mainContentVisible}
        currentMode={currentMode}
        visibleItems={visibleItems}
        showHeaderBar={showHeaderBar}
        sortLabels={sortLabels}
        sortDisplayLabel={sortDisplayLabel}
        sortState={sortState}
        handleSortToggle={handleSortToggle}
        zoomLevel={zoomLevel}
        handleZoomChange={handleZoomChange}
        selectedItemIds={selectedItemIds}
        handleBulkSort={handleBulkSort}
        handleClearSelection={handleClearSelection}
        showMoveButtons={showMoveButtons}
        hasCandidateSelection={hasCandidateSelection}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        hasExecuteSelection={hasExecuteSelection}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        smartInsertToast={smartInsertToast}
        smartInsertToastType={smartInsertToastType}
      />
    </div>
  );
};

export default App;








