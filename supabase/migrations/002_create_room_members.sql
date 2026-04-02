-- ルームメンバーテーブル
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

-- RLS有効化
ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;
