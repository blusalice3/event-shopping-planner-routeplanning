# 共有MVP-0c 構造変更入口インベントリ

MVP-0cでは共有作成、参加、復元、snapshot保存、ack、共有セッションメタデータ、期限切れ最小停止だけを到達可能にする。共有中のイベント構造や未公開同期対象をローカルだけで変更する入口は、以下の分類に従って閉じる。

| 入口 | 分類 | MVP-0cでの扱い | 実装上の境界 |
| --- | --- | --- | --- |
| 新規イベント取込 | allowed while sharing | 既存共有イベントが無い場合だけ許可。共有中イベントの上書き取込は停止。 | `handleExportFileImport` は active session が1件でもある間は停止する。`handleBulkAdd` は既存イベントが共有中なら停止する。 |
| スプレッドシート差分更新 | disabled until gate | 共有中イベントでは停止。 | `handleUpdateEvent`、`handleConfirmUpdate`、`handleUrlUpdate` が `guardSharingStructureMutation` を通る。 |
| イベント削除 | disabled until gate | 共有中イベントでは停止。 | `handleDeleteEvent` が `guardSharingStructureMutation` を通る。 |
| イベント名変更 | disabled until gate | 共有中イベントでは停止。 | `handleRenameEvent`、`handleConfirmRename` が `guardSharingStructureMutation` を通る。 |
| アイテム追加 | disabled until gate | 共有中イベントでは停止。 | `handleAddItem`、マップ経由追加、集中モード追加が `guardSharingStructureMutation` を通る。 |
| アイテム削除 | disabled until gate | 共有中イベントでは停止。 | `handleDeleteRequest`、`handleDeleteItemFromMap`、`handleConfirmDelete` が `guardSharingStructureMutation` を通る。 |
| アイテム編集 | disabled until gate | MVP-1の購入同期、MVP-2aの担当変更、MVP-2cの巡回順同期が揃うまで停止。 | `handleUpdateItem`、優先度変更、編集ダイアログ由来更新が `guardSharingStructureMutation` を通る。 |
| 購入状態、価格、数量、備考、URL、確保者 | disabled until gate | MVP-1まで停止。 | `handleUpdateItem` と購入系一括更新が `guardSharingStructureMutation` を通る。DB側では `claim_item` がMVP-0cテストで閉じている。 |
| 担当者、一括譲渡、自分担当フィルター | disabled until gate | MVP-2aまで停止。 | MVP-0c UIには担当変更導線を出さない。snapshot hydrateで得た `assignedTo` は共有セッションメタデータとセットで扱う。 |
| 実行列/候補列の並べ替え | disabled until gate | MVP-2cまで停止。 | `handleMoveItem`、上下移動、ブロック/番号ソート、訪問リスト並び替えが `guardSharingStructureMutation` を通る。 |
| 巡回順/routeOrderByDate | disabled until gate | MVP-2cまで停止。 | `rooms.route_order_version` は `null`、`route_order_versions` は `{}`。フロントはRealtimeやroute差分catch-upを開始しない。 |
| マップ画像取込 | disabled until gate | 共有中イベントでは停止。 | `handleImportMapData`、`handleMapFileChange` が `guardSharingStructureMutation` を通る。 |
| マップ/ホール定義編集 | disabled until gate | 共有中イベントでは停止。 | ホール追加、削除、結合、分割、手動ホール設定、セル選択、頂点編集が `guardSharingStructureMutation` を通る。 |
| マップ表示位置、回転 | disabled until gate | 共有snapshot側属性に含まれるためMVP-0cでは停止。 | `handleMapViewportChange`、`handleMapTabRotationAngleChange`、`handleFocusMapRotationAngleChange` が `guardSharingStructureMutation` を通る。 |
| 共有作成/参加/復元 | must call sharing RPC | MVP-0cで許可。 | `create_room`、`join_room_by_code`、`restore_member_by_key`、`get_room_snapshot`、`ack_room_snapshot_watermark` を使う。 |
| 期限切れ後の通常編集 | localize required | MVP-0cでは共有停止状態へ移行し、通常共有mutation入口を開かない。MVP-2bでローカル化UXを拡張する。 | ローカル期限タイマーと `heartbeat_room_session` の `ROOM_EXPIRED` で `sharingSessions` を `expired` にする。 |

## MVP-0cの閉鎖確認

- Realtime購読、通知catch-up、`get_room_item_changes_since`、live payload通常適用は起動しない。
- 購入同期、担当変更、退出、通知一覧、巡回順同期のUI/RPC入口はMVP-0cでは公開しない。
- public Guard経路は未実装のため、`VITE_SHARING_PUBLIC_GATE_ENABLED=true` のbuildでは共有パネルをfail-closedにする。
- ローカル/限定テストの直接RPC経路だけをMVP-0cのUI到達可能範囲にする。
