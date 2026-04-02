-- ============================================================
-- DB関数
-- ============================================================

-- ────────────────────────────────────────────────
-- 二重購入防止: claim_item
-- PostgreSQL行ロック（SELECT ... FOR UPDATE）により
-- 競合ウィンドウがゼロの排他制御を実現
-- ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION claim_item(
  p_room_id UUID,
  p_item_id UUID,
  p_user_id UUID,
  p_status TEXT
) RETURNS JSONB AS $$
DECLARE
  v_item room_items%ROWTYPE;
  v_claimer_name TEXT;
BEGIN
  -- 行ロックを取得
  SELECT * INTO v_item FROM room_items
    WHERE id = p_item_id AND room_id = p_room_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'item_not_found');
  END IF;

  -- 既に他メンバーが確保済みの場合はロールバック
  IF v_item.purchase_status IN ('Purchased', 'LimitedPurchase')
     AND v_item.updated_by IS NOT NULL
     AND v_item.updated_by != p_user_id THEN
    SELECT display_name INTO v_claimer_name FROM room_members
      WHERE room_id = p_room_id AND user_id = v_item.updated_by;
    RETURN jsonb_build_object('success', false, 'claimed_by', v_claimer_name);
  END IF;

  -- ステータス更新
  UPDATE room_items SET
    purchase_status = p_status,
    updated_by = p_user_id,
    updated_at = now()
  WHERE id = p_item_id;

  -- 行動ログに記録
  INSERT INTO activity_log (room_id, user_id, action, payload)
    VALUES (
      p_room_id,
      p_user_id,
      'purchase',
      jsonb_build_object('item_id', p_item_id, 'status', p_status)
    );

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
