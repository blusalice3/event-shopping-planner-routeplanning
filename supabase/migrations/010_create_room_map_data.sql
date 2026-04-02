-- ============================================================
-- ルームマップデータテーブル（ホスト→ゲスト同期用）
-- ============================================================

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

-- RLSポリシー: 同一ルームメンバーのみCRUD可能
CREATE POLICY "members_crud_map_data" ON room_map_data
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- Realtime有効化
ALTER PUBLICATION supabase_realtime ADD TABLE room_map_data;
