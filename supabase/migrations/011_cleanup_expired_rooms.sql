-- ============================================================
-- 期限切れルーム自動削除
-- ============================================================

-- 期限切れルーム検索用インデックス
CREATE INDEX idx_rooms_expires_at ON rooms(expires_at);

-- ────────────────────────────────────────────────
-- cleanup_expired_rooms
-- expires_at から72時間経過したルームを物理削除
-- ON DELETE CASCADE により子テーブルも自動削除
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_expired_rooms()
RETURNS INTEGER AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM rooms
  WHERE expires_at + interval '72 hours' < now();

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
