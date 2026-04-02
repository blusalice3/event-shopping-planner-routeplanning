-- ============================================================
-- 副ホスト制度 + ホスト移譲DB関数 + メンバー引き継ぎ
-- ============================================================

-- room_membersにroleカラム追加
ALTER TABLE room_members
  ADD COLUMN role TEXT CHECK (role IN ('member', 'sub_host')) DEFAULT 'member';

-- ────────────────────────────────────────────────
-- 1. execute_host_transfer: 拒否権ウィンドウ経過後のホスト移譲実行
--    二重実行防止付き（payload.executedフラグ）
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION execute_host_transfer(
  p_notification_id UUID,
  p_room_id UUID,
  p_new_host_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_notification notifications%ROWTYPE;
BEGIN
  -- 通知をロックして取得
  SELECT * INTO v_notification FROM notifications
    WHERE id = p_notification_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- 既に実行済み or 拒否済みなら何もしない
  IF v_notification.payload->>'executed' IS NOT NULL
     OR v_notification.payload->>'vetoed' IS NOT NULL THEN
    RETURN false;
  END IF;

  -- executedフラグを設定（二重実行防止）
  UPDATE notifications SET payload = payload || '{"executed": true}'::jsonb
    WHERE id = p_notification_id;

  -- ホスト移譲実行
  UPDATE rooms SET created_by = p_new_host_id WHERE id = p_room_id;

  -- 行動ログに記録
  INSERT INTO activity_log (room_id, user_id, action, payload)
    VALUES (p_room_id, p_new_host_id, 'host_transfer_executed',
      jsonb_build_object('notification_id', p_notification_id));

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────
-- 2. veto_host_transfer: ホストによる移譲拒否権の行使
--    execute_host_transferとの排他制御で
--    レースコンディションを防止
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION veto_host_transfer(
  p_notification_id UUID,
  p_room_id UUID,
  p_host_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_notification notifications%ROWTYPE;
BEGIN
  SELECT * INTO v_notification FROM notifications
    WHERE id = p_notification_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- 既に実行済みなら拒否不可
  IF v_notification.payload->>'executed' IS NOT NULL THEN
    RETURN false;
  END IF;

  -- vetoedフラグを設定
  UPDATE notifications SET payload = payload || jsonb_build_object(
    'vetoed', true, 'vetoedBy', p_host_id::text, 'vetoedAt', now()::text
  ) WHERE id = p_notification_id;

  -- 行動ログに記録
  INSERT INTO activity_log (room_id, user_id, action, payload)
    VALUES (p_room_id, p_host_id, 'host_transfer_vetoed',
      jsonb_build_object('notification_id', p_notification_id));

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────
-- 3. delegate_host: ホストによる手動委任（即時移譲）
--    呼び出し者が現ホストであることを検証
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION delegate_host(
  p_room_id UUID,
  p_current_host_id UUID,
  p_new_host_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  -- 呼び出し者が現ホストであることを検証
  IF NOT EXISTS (
    SELECT 1 FROM rooms WHERE id = p_room_id AND created_by = p_current_host_id
  ) THEN
    RETURN false;
  END IF;

  -- 新ホストがルームメンバーであることを検証
  IF NOT EXISTS (
    SELECT 1 FROM room_members WHERE room_id = p_room_id AND user_id = p_new_host_id
  ) THEN
    RETURN false;
  END IF;

  UPDATE rooms SET created_by = p_new_host_id WHERE id = p_room_id;

  -- 行動ログに記録
  INSERT INTO activity_log (room_id, user_id, action, payload)
    VALUES (p_room_id, p_current_host_id, 'host_delegated',
      jsonb_build_object('new_host_id', p_new_host_id));

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────
-- 4. inherit_member: 事後的メンバー引き継ぎ
--    UNIQUE(room_id, user_id)制約を考慮し
--    アトミックに旧メンバー削除→ターゲット更新
--    ※ターゲットのroleは維持（副ホスト権限の継承）
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION inherit_member(
  p_room_id UUID,
  p_current_user_id UUID,
  p_target_jersey_number SMALLINT
) RETURNS JSONB AS $$
DECLARE
  v_current_member room_members%ROWTYPE;
  v_target_member room_members%ROWTYPE;
  v_items_moved INTEGER;
BEGIN
  -- 1. 現在のメンバー行を取得（ロック）
  SELECT * INTO v_current_member FROM room_members
    WHERE room_id = p_room_id AND user_id = p_current_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'current_member_not_found');
  END IF;

  -- 2. ターゲットメンバー行を取得（ロック）
  SELECT * INTO v_target_member FROM room_members
    WHERE room_id = p_room_id AND jersey_number = p_target_jersey_number
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'target_member_not_found');
  END IF;

  -- 3. ターゲットがオンラインなら拒否
  IF v_target_member.is_online = true
     AND v_target_member.last_seen_at > now() - interval '10 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'target_is_online');
  END IF;

  -- 4. 現在のジャージ番号に割り振られたアイテムをターゲットに移動
  UPDATE room_items
    SET assigned_to = p_target_jersey_number::TEXT
    WHERE room_id = p_room_id
      AND assigned_to = v_current_member.jersey_number::TEXT;
  GET DIAGNOSTICS v_items_moved = ROW_COUNT;

  -- 5. 現在のメンバー行を削除（UNIQUE制約を解放）
  DELETE FROM room_members
    WHERE id = v_current_member.id;

  -- 6. ターゲットメンバーのuser_idを現在のユーザーに更新
  --    ※roleカラムは更新しない（副ホスト権限の継承）
  UPDATE room_members SET
    user_id = p_current_user_id,
    display_name = v_current_member.display_name,
    is_online = true,
    last_seen_at = now()
    WHERE id = v_target_member.id;

  -- 7. アクティビティログ
  INSERT INTO activity_log (room_id, user_id, action, payload)
    VALUES (p_room_id, p_current_user_id, 'inherit_member',
      jsonb_build_object(
        'from_jersey', v_current_member.jersey_number,
        'to_jersey', p_target_jersey_number,
        'items_moved', v_items_moved
      ));

  RETURN jsonb_build_object(
    'success', true,
    'from_jersey', v_current_member.jersey_number,
    'to_jersey', p_target_jersey_number,
    'items_moved', v_items_moved,
    'inherited_display_name', v_target_member.display_name
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────
-- 5. initiate_host_transfer_offer: ホスト不在検出時の
--    移譲オファー送信（重複防止付き）
--    全クライアントから呼ばれるため排他制御が必要
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION initiate_host_transfer_offer(
  p_room_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_existing INTEGER;
  v_candidate room_members%ROWTYPE;
  v_host_id UUID;
BEGIN
  -- 既存のunreadオファーがあれば何もしない
  SELECT COUNT(*) INTO v_existing FROM notifications
    WHERE room_id = p_room_id
      AND type = 'host_transfer_offer'
      AND is_read = false;
  IF v_existing > 0 THEN RETURN false; END IF;

  -- ホストのuser_idを取得
  SELECT created_by INTO v_host_id FROM rooms WHERE id = p_room_id;

  -- 最古参のオンラインメンバー（ホスト以外）を取得
  SELECT * INTO v_candidate FROM room_members
    WHERE room_id = p_room_id
      AND user_id != v_host_id
      AND is_online = true
    ORDER BY joined_at ASC
    LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- オファー通知を最古参とホストに送信
  INSERT INTO notifications (room_id, type, payload, target_user_id)
    VALUES
      (p_room_id, 'host_transfer_offer',
       jsonb_build_object(
         'candidateUserId', v_candidate.user_id,
         'candidateDisplayName', v_candidate.display_name,
         'candidateJerseyNumber', v_candidate.jersey_number,
         'reason', 'inactivity'
       ), v_candidate.user_id),
      (p_room_id, 'host_transfer_offer',
       jsonb_build_object(
         'candidateUserId', v_candidate.user_id,
         'candidateDisplayName', v_candidate.display_name,
         'candidateJerseyNumber', v_candidate.jersey_number,
         'reason', 'inactivity'
       ), v_host_id);

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
