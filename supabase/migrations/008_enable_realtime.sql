-- Supabase Realtimeでリアルタイム同期するテーブルを登録
ALTER PUBLICATION supabase_realtime ADD TABLE room_items;
ALTER PUBLICATION supabase_realtime ADD TABLE room_members;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
