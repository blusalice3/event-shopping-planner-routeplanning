-- 行動ログテーブル（絆リスト）
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 時系列表示用
CREATE INDEX idx_activity_log_timeline
  ON activity_log(room_id, created_at DESC);

-- RLS有効化
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
