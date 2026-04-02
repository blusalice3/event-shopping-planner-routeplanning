-- ============================================================
-- RLSポリシー
-- ============================================================

-- ────────────────────────────────────────────────
-- rooms
-- ────────────────────────────────────────────────

-- ルームメンバーのみ閲覧可能
CREATE POLICY "room_members_can_view_room" ON rooms
  FOR SELECT USING (
    id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- 認証済みユーザーはルーム作成可能（参加時のSELECTはroom_code検索で必要）
CREATE POLICY "authenticated_can_create_room" ON rooms
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- 作成者のみ更新・削除可能
CREATE POLICY "room_creator_can_update" ON rooms
  FOR UPDATE USING (created_by = auth.uid());

CREATE POLICY "room_creator_can_delete" ON rooms
  FOR DELETE USING (created_by = auth.uid());

-- 参加時のルームコード検索用（未参加でもアクティブなルームをコードで検索可能）
CREATE POLICY "anyone_can_find_active_room_by_code" ON rooms
  FOR SELECT USING (is_active = true);

-- ────────────────────────────────────────────────
-- room_members
-- ────────────────────────────────────────────────

-- 同一ルームメンバーのみ閲覧可能
CREATE POLICY "members_can_view_members" ON room_members
  FOR SELECT USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- 認証済みユーザーは参加可能
CREATE POLICY "authenticated_can_join" ON room_members
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- 自レコードのみUPDATE可能
CREATE POLICY "update_own_member_record" ON room_members
  FOR UPDATE USING (user_id = auth.uid());

-- 自レコードのみ削除可能（退出）
CREATE POLICY "delete_own_member_record" ON room_members
  FOR DELETE USING (user_id = auth.uid());

-- ────────────────────────────────────────────────
-- room_items
-- ────────────────────────────────────────────────

-- 同一ルームメンバーのみCRUD可能
CREATE POLICY "members_crud_items" ON room_items
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- ────────────────────────────────────────────────
-- notifications
-- ────────────────────────────────────────────────

-- 同一ルームメンバーのみ閲覧・作成可能
CREATE POLICY "members_crud_notifications" ON notifications
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- ────────────────────────────────────────────────
-- activity_log
-- ────────────────────────────────────────────────

-- 同一ルームメンバーのみ閲覧・作成可能
CREATE POLICY "members_crud_activity_log" ON activity_log
  FOR ALL USING (
    room_id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );
