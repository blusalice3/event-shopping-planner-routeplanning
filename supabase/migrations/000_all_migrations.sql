-- ============================================================
-- 全マイグレーション統合ファイル
-- Supabase SQL Editor で一括実行用
-- ============================================================

-- ────────────────────────────────────────────────
-- 1. ルームテーブル
-- ────────────────────────────────────────────────
CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code CHAR(5) NOT NULL UNIQUE CHECK (room_code ~ '^[A-Z0-9]{5}$'),
  event_name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  max_members SMALLINT DEFAULT 5,
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX idx_rooms_active_code ON rooms(room_code) WHERE is_active = true;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────
-- 2. ルームメンバーテーブル
-- ────────────────────────────────────────────────
CREATE TABLE room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  display_name TEXT NOT NULL,
  color TEXT DEFAULT '#3B82F6',
  joined_at TIMESTAMPTZ DEFAULT now(),
  is_online BOOLEAN DEFAULT true,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  status TEXT CHECK (status IN ('roaming', 'inQueue', 'done', 'resting')) DEFAULT 'roaming',
  queue_circle_name TEXT,
  queue_started_at TIMESTAMPTZ,
  current_hall_id TEXT,
  current_block TEXT,
  current_number TEXT,
  remaining_items SMALLINT DEFAULT 0,
  UNIQUE(room_id, user_id)
);

ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────
-- 3. ルームアイテムテーブル
-- ────────────────────────────────────────────────
CREATE TABLE room_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  local_item_id TEXT NOT NULL,
  purchase_status TEXT DEFAULT 'None'
    CHECK (purchase_status IN ('None', 'Purchased', 'SoldOut', 'Absent', 'Postpone', 'Late', 'LimitedPurchase')),
  assigned_to UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  quantity SMALLINT DEFAULT 1,
  price INTEGER,
  order_index INTEGER DEFAULT 0,
  postponed BOOLEAN DEFAULT false,
  circle_name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  block_name TEXT,
  booth_number TEXT,
  title TEXT,
  UNIQUE(room_id, local_item_id)
);

ALTER TABLE room_items ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────
-- 4. 通知テーブル
-- ────────────────────────────────────────────────
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES auth.users(id),
  type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_notifications_unread
  ON notifications(room_id, target_user_id) WHERE NOT is_read;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────
-- 5. 行動ログテーブル（絆リスト）
-- ────────────────────────────────────────────────
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_activity_log_timeline
  ON activity_log(room_id, created_at DESC);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────
-- 6. RLSポリシー
-- ────────────────────────────────────────────────

-- rooms
CREATE POLICY "room_members_can_view_room" ON rooms
  FOR SELECT USING (
    id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

CREATE POLICY "authenticated_can_create_room" ON rooms
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "room_creator_can_update" ON rooms
  FOR UPDATE USING (created_by = auth.uid());

CREATE POLICY "room_creator_can_delete" ON rooms
  FOR DELETE USING (created_by = auth.uid());

CREATE POLICY "anyone_can_find_active_room_by_code" ON rooms
  FOR SELECT USING (is_active = true);

-- room_members
CREATE POLICY "members_can_view_members" ON room_members
  FOR SELECT USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

CREATE POLICY "authenticated_can_join" ON room_members
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "update_own_member_record" ON room_members
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "delete_own_member_record" ON room_members
  FOR DELETE USING (user_id = auth.uid());

-- room_items
CREATE POLICY "members_crud_items" ON room_items
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- notifications
CREATE POLICY "members_crud_notifications" ON notifications
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- activity_log
CREATE POLICY "members_crud_activity_log" ON activity_log
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- ────────────────────────────────────────────────
-- 7. DB関数（二重購入防止）
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION claim_item(
  p_room_id UUID,
  p_item_id UUID,
  p_user_id UUID,
  p_status TEXT
) RETURNS JSONB AS $$
DECLARE
  v_item room_items%ROWTYPE;
  v_claimer_name TEXT;
BEGIN
  SELECT * INTO v_item FROM room_items
    WHERE id = p_item_id AND room_id = p_room_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'item_not_found');
  END IF;

  IF v_item.purchase_status IN ('Purchased', 'LimitedPurchase')
     AND v_item.updated_by IS NOT NULL
     AND v_item.updated_by != p_user_id THEN
    SELECT display_name INTO v_claimer_name FROM room_members
      WHERE room_id = p_room_id AND user_id = v_item.updated_by;
    RETURN jsonb_build_object('success', false, 'claimed_by', v_claimer_name);
  END IF;

  UPDATE room_items SET
    purchase_status = p_status,
    updated_by = p_user_id,
    updated_at = now()
  WHERE id = p_item_id;

  INSERT INTO activity_log (room_id, user_id, action, payload)
    VALUES (
      p_room_id,
      p_user_id,
      'purchase',
      jsonb_build_object('item_id', p_item_id, 'status', p_status)
    );

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────
-- 8. Realtime有効化
-- ────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE room_items;
ALTER PUBLICATION supabase_realtime ADD TABLE room_members;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- ────────────────────────────────────────────────
-- 9. 背番号(jersey_number)追加 + assigned_to型変更
-- ────────────────────────────────────────────────
ALTER TABLE room_members ADD COLUMN jersey_number SMALLINT;
ALTER TABLE room_items DROP CONSTRAINT IF EXISTS room_items_assigned_to_fkey;
ALTER TABLE room_items ALTER COLUMN assigned_to TYPE TEXT USING assigned_to::TEXT;

-- ────────────────────────────────────────────────
-- 10. ルームマップデータテーブル（ホスト→ゲスト同期用）
-- ────────────────────────────────────────────────
CREATE TABLE room_map_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  data_type TEXT NOT NULL CHECK (data_type IN ('mapData', 'hallDefinitions')),
  map_name TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(room_id, data_type, map_name)
);

ALTER TABLE room_map_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_crud_map_data" ON room_map_data
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

ALTER PUBLICATION supabase_realtime ADD TABLE room_map_data;
