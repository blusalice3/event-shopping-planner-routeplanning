-- ルームアイテムテーブル（既存ShoppingItem型とマッピング）
CREATE TABLE room_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  local_item_id TEXT NOT NULL,
  purchase_status TEXT DEFAULT 'None'
    CHECK (purchase_status IN ('None', 'Purchased', 'SoldOut', 'Absent', 'Postpone', 'Late', 'LimitedPurchase')),
  assigned_to UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  quantity SMALLINT DEFAULT 1,
  price INTEGER,
  order_index INTEGER DEFAULT 0,
  postponed BOOLEAN DEFAULT false,
  circle_name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  block_name TEXT,
  booth_number TEXT,
  title TEXT,
  UNIQUE(room_id, local_item_id)
);

-- RLS有効化
ALTER TABLE room_items ENABLE ROW LEVEL SECURITY;
