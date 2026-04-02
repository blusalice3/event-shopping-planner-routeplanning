import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDB = SupabaseClient<any>;

/** 単一アイテムの担当者割り当て */
export async function assignItem(
  supabase: SupabaseDB,
  roomId: string,
  localItemId: string,
  targetUserId: string | null,
  assignedBy: string,
): Promise<void> {
  const { error } = await supabase
    .from('room_items')
    .update({
      assigned_to: targetUserId,
      updated_by: assignedBy,
      updated_at: new Date().toISOString(),
    })
    .eq('room_id', roomId)
    .eq('local_item_id', localItemId);

  if (error) throw new Error(`担当者変更に失敗しました: ${error.message}`);

  // アクティビティログ記録
  await supabase.from('activity_log').insert({
    room_id: roomId,
    user_id: assignedBy,
    action: 'assign',
    payload: { local_item_id: localItemId, assigned_to: targetUserId },
  });
}

/** 複数アイテムの一括担当者割り当て（投げつけ）。targetUserId=nullで割り当てクリア */
export async function bulkAssignItems(
  supabase: SupabaseDB,
  roomId: string,
  localItemIds: string[],
  targetUserId: string | null,
  assignedBy: string,
): Promise<void> {
  if (localItemIds.length === 0) return;

  for (const localItemId of localItemIds) {
    await supabase
      .from('room_items')
      .update({
        assigned_to: targetUserId,
        updated_by: assignedBy,
        updated_at: new Date().toISOString(),
      })
      .eq('room_id', roomId)
      .eq('local_item_id', localItemId);
  }

  await supabase.from('activity_log').insert({
    room_id: roomId,
    user_id: assignedBy,
    action: 'bulk_assign',
    payload: { item_count: localItemIds.length, assigned_to: targetUserId },
  });
}

/** 担当者別のアイテム数を取得 */
export async function getAssignmentCounts(
  supabase: SupabaseDB,
  roomId: string,
): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('room_items')
    .select('assigned_to')
    .eq('room_id', roomId)
    .not('purchase_status', 'in', '("Purchased","SoldOut","Absent","LimitedPurchase")');

  if (error) throw new Error(`集計に失敗しました: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const userId = row.assigned_to ?? 'unassigned';
    counts[userId] = (counts[userId] || 0) + 1;
  }
  return counts;
}
