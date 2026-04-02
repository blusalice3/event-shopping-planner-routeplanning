-- ルームテーブル
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

-- アクティブなルームコードの高速検索用
CREATE INDEX idx_rooms_active_code ON rooms(room_code) WHERE is_active = true;

-- RLS有効化
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
