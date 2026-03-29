-- 通知テーブル
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES auth.users(id),
  type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 未読通知の高速検索用
CREATE INDEX idx_notifications_unread
  ON notifications(room_id, target_user_id) WHERE NOT is_read;

-- RLS有効化
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
