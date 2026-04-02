import type { SupabaseClient } from '@supabase/supabase-js';
import type { ShoppingItem } from '../../../types';
import type { ActiveRoom, RoomMember, ClaimResult } from '../types/room';
import { generateRoomCode } from '../utils/roomCodeGenerator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDB = SupabaseClient<any>;

const MEMBER_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

// ────────────────────────────────────────────────
// ルーム操作
// ────────────────────────────────────────────────

/** ルーム作成（コード衝突時最大3回リトライ） */
export async function createRoom(
  supabase: SupabaseDB,
  eventName: string,
  userId: string,
  displayName: string,
  expiresAt: string,
): Promise<ActiveRoom> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const roomCode = generateRoomCode();

    const { data: room, error } = await supabase
      .from('rooms')
      .insert({
        room_code: roomCode,
        event_name: eventName,
        created_by: userId,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        lastError = error;
        continue;
      }
      throw new Error(`ルーム作成に失敗しました: ${error.message}`);
    }

    // ホストをメンバーとして追加（背番号#1）
    const { error: memberError } = await supabase
      .from('room_members')
      .insert({
        room_id: room.id,
        user_id: userId,
        display_name: displayName,
        color: MEMBER_COLORS[0],
        jersey_number: 1,
      });

    if (memberError) {
      throw new Error(`メンバー登録に失敗しました: ${memberError.message}`);
    }

    return {
      id: room.id,
      roomCode: room.room_code,
      eventName: room.event_name,
      createdBy: room.created_by,
      expiresAt: room.expires_at,
      maxMembers: room.max_members,
      isHost: true,
    };
  }

  throw new Error(`コード生成に失敗しました。再度お試しください。(${lastError})`);
}

/** ルーム参加 */
export async function joinRoom(
  supabase: SupabaseDB,
  roomCode: string,
  userId: string,
  displayName: string,
): Promise<ActiveRoom> {
  // ルーム検索
  const { data: room, error: roomError } = await supabase
    .from('rooms')
    .select('*')
    .eq('room_code', roomCode.toUpperCase())
    .eq('is_active', true)
    .single();

  if (roomError || !room) {
    throw new Error('ルームが見つかりません。コードを確認してください。');
  }

  if (new Date(room.expires_at) < new Date()) {
    throw new Error('このルームは有効期限が切れています。');
  }

  // メンバー数チェック
  const { count } = await supabase
    .from('room_members')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', room.id);

  if (count != null && count >= room.max_members) {
    throw new Error(`参加上限に達しています（最大${room.max_members}名）。`);
  }

  // メンバー色と背番号の決定
  const { data: existingMembers } = await supabase
    .from('room_members')
    .select('color, jersey_number')
    .eq('room_id', room.id);

  const usedColors = new Set(existingMembers?.map((m) => m.color) ?? []);
  const color = MEMBER_COLORS.find((c) => !usedColors.has(c)) ?? MEMBER_COLORS[0];

  // 空いている最小背番号を探す
  const usedNumbers = new Set(existingMembers?.map((m) => m.jersey_number).filter(Boolean) ?? []);
  let jerseyNumber = 1;
  while (usedNumbers.has(jerseyNumber)) jerseyNumber++;

  // メンバー登録
  const { error: memberError } = await supabase
    .from('room_members')
    .insert({
      room_id: room.id,
      user_id: userId,
      display_name: displayName,
      color,
      jersey_number: jerseyNumber,
    });

  if (memberError) {
    if (memberError.code === '23505') {
      // 既に参加済み: 既存メンバーとして続行（再参加扱い）
    } else {
      throw new Error(`参加に失敗しました: ${memberError.message}`);
    }
  }

  return {
    id: room.id,
    roomCode: room.room_code,
    eventName: room.event_name,
    createdBy: room.created_by,
    expiresAt: room.expires_at,
    maxMembers: room.max_members,
    isHost: room.created_by === userId,
  };
}

/** デバイス再参加（背番号または同名メンバーのuser_idを付け替え） */
export async function rejoinRoom(
  supabase: SupabaseDB,
  roomCode: string,
  userId: string,
  displayName: string,
  jerseyNumber?: number,
): Promise<ActiveRoom> {
  const { data: room, error: roomError } = await supabase
    .from('rooms')
    .select('*')
    .eq('room_code', roomCode.toUpperCase())
    .eq('is_active', true)
    .single();

  if (roomError || !room) {
    throw new Error('ルームが見つかりません。');
  }

  // 背番号が指定されている場合は背番号で検索（優先）
  let existingMember = null;
  if (jerseyNumber != null) {
    const { data } = await supabase
      .from('room_members')
      .select('*')
      .eq('room_id', room.id)
      .eq('jersey_number', jerseyNumber)
      .single();
    existingMember = data;
  }

  // 背番号で見つからない場合は同名メンバーを検索（後方互換）
  if (!existingMember) {
    const { data } = await supabase
      .from('room_members')
      .select('*')
      .eq('room_id', room.id)
      .eq('display_name', displayName)
      .single();
    existingMember = data;
  }

  if (existingMember) {
    // 既存メンバーのuser_idを新デバイスに付け替え（名前も更新）
    const { error: updateError } = await supabase
      .from('room_members')
      .update({
        user_id: userId,
        display_name: displayName,
        is_online: true,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', existingMember.id);

    if (updateError) {
      throw new Error(`再参加に失敗しました: ${updateError.message}`);
    }
  } else {
    // メンバーが見つからなければ通常参加
    return joinRoom(supabase, roomCode, userId, displayName);
  }

  return {
    id: room.id,
    roomCode: room.room_code,
    eventName: room.event_name,
    createdBy: room.created_by,
    expiresAt: room.expires_at,
    maxMembers: room.max_members,
    isHost: room.created_by === userId,
  };
}

/** 再参加用: ルームの既存メンバー一覧取得（未参加状態でも呼べる） */
export async function getRoomMembersForRejoin(
  supabase: SupabaseDB,
  roomCode: string,
): Promise<{ jerseyNumber: number; displayName: string }[]> {
  const { data: room } = await supabase
    .from('rooms')
    .select('id')
    .eq('room_code', roomCode.toUpperCase())
    .eq('is_active', true)
    .single();

  if (!room) return [];

  const { data: members } = await supabase
    .from('room_members')
    .select('jersey_number, display_name')
    .eq('room_id', room.id)
    .order('jersey_number', { ascending: true });

  return (members ?? [])
    .filter((m) => m.jersey_number != null)
    .map((m) => ({
      jerseyNumber: m.jersey_number as number,
      displayName: m.display_name,
    }));
}

/** ルーム退出 */
export async function leaveRoom(
  supabase: SupabaseDB,
  roomId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('room_members')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`退出に失敗しました: ${error.message}`);
  }
}

// ────────────────────────────────────────────────
// メンバー操作
// ────────────────────────────────────────────────

/** メンバー一覧取得 */
export async function getRoomMembers(
  supabase: SupabaseDB,
  roomId: string,
): Promise<RoomMember[]> {
  const { data, error } = await supabase
    .from('room_members')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });

  if (error) throw new Error(`メンバー取得に失敗しました: ${error.message}`);

  return (data ?? []).map((m) => ({
    id: m.id,
    userId: m.user_id,
    displayName: m.display_name,
    color: m.color,
    isOnline: m.is_online,
    lastSeenAt: m.last_seen_at,
    joinedAt: m.joined_at,
    jerseyNumber: m.jersey_number ?? 0,
    status: m.status ?? 'roaming',
    queueCircleName: m.queue_circle_name ?? null,
    queueStartedAt: m.queue_started_at ?? null,
    currentHallId: m.current_hall_id ?? null,
    currentBlock: m.current_block ?? null,
    currentNumber: m.current_number ?? null,
    remainingItems: m.remaining_items ?? 0,
  }));
}

/** Heartbeat更新 */
export async function updateHeartbeat(
  supabase: SupabaseDB,
  roomId: string,
  userId: string,
): Promise<void> {
  await supabase
    .from('room_members')
    .update({
      is_online: true,
      last_seen_at: new Date().toISOString(),
    })
    .eq('room_id', roomId)
    .eq('user_id', userId);
}

// ────────────────────────────────────────────────
// アイテム操作
// ────────────────────────────────────────────────

/** ローカルShoppingItem[] → room_items バルクupsert */
export async function bulkInsertRoomItems(
  supabase: SupabaseDB,
  roomId: string,
  items: ShoppingItem[],
): Promise<void> {
  if (items.length === 0) return;

  const rows = items.map((item) => ({
    room_id: roomId,
    local_item_id: item.id,
    purchase_status: item.purchaseStatus,
    quantity: item.quantity,
    price: item.price,
    circle_name: item.circle,
    event_date: item.eventDate,
    block_name: item.block || null,
    booth_number: item.number || null,
    title: item.title || null,
    order_index: item.orderIndex ?? 0,
    postponed: item.postponed ?? false,
  }));

  const { error } = await supabase
    .from('room_items')
    .upsert(rows, { onConflict: 'room_id,local_item_id' });

  if (error) {
    throw new Error(`アイテム同期に失敗しました: ${error.message}`);
  }
}

/** room_items → ShoppingItem[] 変換取得 */
export async function getRoomItemsAsShoppingItems(
  supabase: SupabaseDB,
  roomId: string,
): Promise<ShoppingItem[]> {
  const { data, error } = await supabase
    .from('room_items')
    .select('*')
    .eq('room_id', roomId)
    .order('order_index', { ascending: true });

  if (error) throw new Error(`アイテム取得に失敗しました: ${error.message}`);

  return (data ?? []).map((ri) => ({
    id: ri.local_item_id,
    circle: ri.circle_name,
    eventDate: ri.event_date,
    block: ri.block_name ?? '',
    number: ri.booth_number ?? '',
    title: ri.title ?? '',
    price: ri.price,
    purchaseStatus: ri.purchase_status as ShoppingItem['purchaseStatus'],
    quantity: ri.quantity,
    remarks: '',
    assignedTo: ri.assigned_to ?? undefined,
    orderIndex: ri.order_index,
    postponed: ri.postponed,
    lastSyncedAt: ri.updated_at,
  }));
}

/** 二重購入防止付きステータス変更 */
export async function claimItem(
  supabase: SupabaseDB,
  roomId: string,
  roomItemId: string,
  userId: string,
  status: string,
): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc('claim_item', {
    p_room_id: roomId,
    p_item_id: roomItemId,
    p_user_id: userId,
    p_status: status,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const result = data as { success: boolean; claimed_by?: string; error?: string };
  return {
    success: result.success,
    claimedBy: result.claimed_by,
    error: result.error,
  };
}

/** room_itemのローカルID → room_item UUID マッピング取得 */
export async function getRoomItemId(
  supabase: SupabaseDB,
  roomId: string,
  localItemId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('room_items')
    .select('id')
    .eq('room_id', roomId)
    .eq('local_item_id', localItemId)
    .single();

  return data?.id ?? null;
}

/** room_itemの部分更新 */
export async function updateRoomItem(
  supabase: SupabaseDB,
  roomId: string,
  localItemId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('room_items')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('room_id', roomId)
    .eq('local_item_id', localItemId);

  if (error) {
    throw new Error(`アイテム更新に失敗しました: ${error.message}`);
  }
}
