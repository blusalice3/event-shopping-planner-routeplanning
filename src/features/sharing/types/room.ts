import type { ShoppingItem, PurchaseStatus } from '../../../types';
import type { MemberStatus } from '../../../lib/database.types';

export type { MemberStatus };

/** アクティブなルーム情報 */
export interface ActiveRoom {
  id: string;
  roomCode: string;
  eventName: string;
  createdBy: string;
  expiresAt: string;
  maxMembers: number;
  isHost: boolean;
}

/** ルームメンバー */
export interface RoomMember {
  id: string;
  userId: string;
  displayName: string;
  color: string;
  isOnline: boolean;
  lastSeenAt: string;
  joinedAt: string;
  jerseyNumber: number;
  // DB同期フィールド
  status: MemberStatus;
  queueCircleName: string | null;
  queueStartedAt: string | null;
  currentHallId: string | null;
  currentBlock: string | null;
  currentNumber: string | null;
  remainingItems: number;
}

/** claim_item RPCの結果 */
export interface ClaimResult {
  success: boolean;
  claimedBy?: string;
  error?: string;
}

/** オフライン同期キューのエントリ */
export interface SyncQueueEntry {
  id: string;
  operation: 'claim_item' | 'update_item';
  payload: {
    roomId: string;
    itemId: string;
    localItemId: string;
    userId: string;
    status?: string;
    updates?: Record<string, unknown>;
  };
  createdAt: string;
  status: 'pending' | 'processing' | 'failed';
  retryCount: number;
}

/** 接続・同期状態 */
export type SyncStatus = 'disconnected' | 'synced' | 'syncing' | 'offline' | 'error';

/** localStorage永続化用 */
export interface StoredRoomInfo {
  roomCode: string;
  roomId: string;
  displayName: string;
  jerseyNumber?: number;
}

/** ShoppingItem → room_items のフィールドマッピング */
export interface RoomItemMapping {
  localItemId: string;
  roomItemId: string;
}

/** データ移行モード */
export type MigrationMode = 'host-create' | 'guest-join' | 'leave';

/** データ移行結果 */
export interface MigrationResult {
  added: number;
  skipped: number;
  total: number;
}

/** リモートアイテム更新 */
export interface RemoteItemUpdate {
  localItemId: string;
  purchaseStatus?: PurchaseStatus;
  assignedTo?: string | null;
  price?: number | null;
  quantity?: number;
  postponed?: boolean;
  orderIndex?: number;
  updatedBy?: string;
}

/** リモートマップデータ更新 */
export interface RemoteMapDataUpdate {
  dataType: 'mapData' | 'hallDefinitions';
  mapName: string;
  data: unknown;
}

/** SharingContext の値 */
export interface SharingContextValue {
  // Auth状態
  userId: string | null;
  isAuthReady: boolean;

  // ルーム状態
  activeRoom: ActiveRoom | null;
  members: RoomMember[];
  isRoomLoading: boolean;
  roomError: string | null;

  // 接続状態
  syncStatus: SyncStatus;
  isOnline: boolean;
  pendingQueueSize: number;

  // リアルタイムチャネル（useBroadcast等で使用）
  channel: import('@supabase/supabase-js').RealtimeChannel | null;

  // ルーム操作
  createRoom: (eventName: string, displayName: string, expiresAt: string) => Promise<ActiveRoom>;
  joinRoom: (roomCode: string, displayName: string) => Promise<ActiveRoom>;
  rejoinRoom: (roomCode: string, displayName: string, jerseyNumber?: number) => Promise<ActiveRoom>;
  leaveRoom: () => Promise<void>;

  // マップデータ同期
  uploadMapDataToRoom: (
    eventName: string,
    mapData?: Record<string, import('../../../types').DayMapData>,
    hallDefinitions?: Record<string, import('../../../types').HallDefinition[]>,
  ) => Promise<void>;
  downloadMapDataFromRoom: () => Promise<{ mapData?: Record<string, unknown>; hallDefinitions?: Record<string, unknown[]> }>;

  // 再参加用メンバー一覧取得
  getRoomMembersForRejoin: (roomCode: string) => Promise<{ jerseyNumber: number; displayName: string }[]>;

  // データ移行
  uploadItemsToRoom: (items: ShoppingItem[]) => Promise<void>;
  mergeGuestItems: (items: ShoppingItem[]) => Promise<MigrationResult>;
  downloadRoomItems: () => Promise<ShoppingItem[]>;

  // 同期操作
  syncPurchaseStatus: (
    localItemId: string,
    status: PurchaseStatus,
    preChangeItem: ShoppingItem,
    onRollback: (item: ShoppingItem) => void,
  ) => Promise<ClaimResult>;
  syncItemUpdate: (localItemId: string, updates: Partial<ShoppingItem>) => Promise<void>;

  // 担当者割り当て（背番号ベース）
  assignItem: (localItemId: string, targetJerseyNumber: number | null) => Promise<void>;
  bulkAssignItems: (localItemIds: string[], targetJerseyNumber: number | null) => Promise<void>;
  myItemsOnly: boolean;
  toggleMyItemsFilter: () => void;

  // 通知
  latestToast: import('../services/notificationService').AppNotification | null;
  dismissToast: () => void;
  unreadCount: number;
  broadcastNotification: (
    type: import('../services/notificationService').NotificationType,
    payload: Record<string, unknown>,
  ) => Promise<void>;

  // リモート更新ハンドラ登録
  registerRemoteUpdateHandler: (
    handler: (update: RemoteItemUpdate) => void,
  ) => void;
  registerMapDataUpdateHandler: (
    handler: (update: RemoteMapDataUpdate) => void,
  ) => void;
}
