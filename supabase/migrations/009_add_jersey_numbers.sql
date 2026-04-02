-- ============================================================
-- 背番号(jersey_number)追加 + assigned_to型変更
-- ============================================================

-- room_membersに背番号カラム追加
ALTER TABLE room_members ADD COLUMN jersey_number SMALLINT;

-- room_items.assigned_toのFK制約を外し、TEXT型に変更
-- (背番号文字列を格納するため)
ALTER TABLE room_items DROP CONSTRAINT IF EXISTS room_items_assigned_to_fkey;
ALTER TABLE room_items ALTER COLUMN assigned_to TYPE TEXT USING assigned_to::TEXT;
