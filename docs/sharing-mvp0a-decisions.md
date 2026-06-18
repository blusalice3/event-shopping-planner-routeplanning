# 共有機能 MVP-0a 作業ログ

## 実装範囲

今回の公開ゲートはMVP-0aです。共有UI、新規共有RPC、RLS変更、Realtime購読、DB機能差分は
公開しません。実DB接続後にbaselineを取得してレビューするまでMVP-0bへ進みません。

## 確定事項

| 項目                      | 決定                                                       |
| ------------------------- | ---------------------------------------------------------- |
| runtime schema            | `zod` 4.x                                                  |
| canonical JSON            | raw JSON重複key検出、全key/valueのNFC正規化、RFC 8785 JCS  |
| fingerprint               | canonical UTF-8 bytesのSHA-256をpaddingなしbase64url化     |
| client-safe型             | `public` schemaだけを `src/lib/database.types.ts` へ生成   |
| private DB型              | 必要になるまで生成しない。通常UIからimportしない           |
| DB設定保存先              | 将来の `private.sharing_runtime_config` 単一行管理テーブル |
| DB未設定時                | fail closed。既存のURL/keyだけの判定を公開判定にしない     |
| room item order           | `order_index` nullable化は後続migration。実行列外は `null` |
| route未有効値             | `route_order_version = null`, `route_order_versions = {}`  |
| 最大メンバー数            | 20                                                         |
| target item count         | 1000                                                       |
| maximum item count        | 5000                                                       |
| maximum event data        | 5 MiB                                                      |
| maximum canonical payload | 10 MiB                                                     |
| contract version          | `1`                                                        |

## MVP-0a decision_id 転記

| decision_id                    | 状態    | MVP-0aで固定した内容                                                        | 実装/確認先                                                                 |
| ------------------------------ | ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `M0A-LOCAL-PLAINTEXT`          | decided | 平文保存ではなく、後続DB実装では特権fixture経路も暗号文schemaに寄せる       | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-GUARD-TRUST`              | decided | publicではGuardをJWT検証/rate limitの信頼境界にし、DBはGuard申告principalを信頼済み入力として再検証する | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-GUARD-RPC-NAMES`          | decided | local/limited_test用bootstrap RPCとpublic Guard内部RPCを別名に分ける        | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-PAYLOAD-ENCRYPTION`       | decided | create payload本文は後続DB実装でOpenPGP AES-256暗号化し、平文RPC引数にしない | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-CANONICAL-JCS`            | decided | raw重複key検出、NFC、RFC 8785 JCS、SHA-256 base64url fingerprintを採用する  | `src/features/sharing/canonicalCreateRoomPayload.ts` / `sharing_mvp0a_canonical_jcs_vectors` |
| `M0A-ROOM-CODE-ROTATION`       | decided | version付きkey ringとalias table方式に固定する                             | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-ATTEMPT-COMMIT`           | decided | 期待済み業務失敗は安定error envelopeを返して試行状態をcommitする方式に固定 | `src/features/sharing/contracts.ts` / 後続DB test                           |
| `M0A-ITEMS-VERSION-ALLOCATION` | decided | room lock下で連続items_versionを割り当てる方式に固定                       | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-ORDER-INDEX`              | decided | `order_index` nullable、実行列外は `null` に固定                            | `sharing_mvp0a_gate_classification_table`                                   |
| `M0A-ROUTE-DISABLED`           | decided | route未有効値は `route_order_version = null`, `route_order_versions = {}`   | `src/features/sharing/contracts.ts` / `src/features/sharing/roomEventDataSchema.ts` |
| `M0A-OPEN-DECISIONS`           | decided | 本文の候補表現よりこの作業ログの決定表を優先し、PRごとの再選択をしない      | この表                                                                       |

## テストID / DoD

| test_id                                  | gate    | command / 確認方法                                                                 | 期待結果                                                                                   |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sharing_mvp0a_canonical_jcs_vectors`    | MVP-0a  | `npm run test:run -- src/features/sharing/canonicalCreateRoomPayload.test.ts`       | raw重複key、不正UTF-8、lone surrogate、NFC、BMP/非BMP key、`-0`、指数境界、非有限数、`null`、配列順、schema未知field、payload上限を安定codeで検証 |
| `sharing_mvp0a_room_event_schema`        | MVP-0a  | `npm run test:run -- src/features/sharing/roomEventDataSchema.test.ts`              | `zod` runtime schemaが未知version、未知top-level field、route形状違反、payload上限を拒否   |
| `sharing_mvp0a_typecheck`                | MVP-0a  | `npm run typecheck`                                                                 | 共有MVP-0aの型追加が既存アプリ型を壊さない                                                   |
| `sharing_mvp0a_encoding_check`           | MVP-0a  | `npm run encoding:check`                                                            | 既知例外以外のBOM/U+FFFD/不正UTF-8増加なし                                                   |
| `sharing_mvp0a_baseline_typegen`         | MVP-0a  | `npm run db:pull` / `npm run db:typegen`                                            | 実Supabase接続後にだけ実行。未接続のため今回範囲外                                           |
| `sharing_mvp0a_gate_classification_table` | MVP-0a | plan/log review                                                                     | 後続RPC/UI/DB差分をMVP-0aで公開しないことが確認できる                                       |

## 公開ゲート概要

| 項目                                         | 分類                                  | MVP-0aでの扱い                                                           |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| `src/features/sharing/contracts.ts`          | create now                            | contract version、安定error code、上限値だけを型として固定              |
| `room_event_data` runtime schema             | create now                            | `zod` schemaと単体テストだけを追加。DB JSONB migrationは作らない         |
| `canonicalCreateRoomPayload`                 | create now                            | JCS/NFC/fingerprintとschema検証フックを単体実装。DB/Guard統合はしない    |
| Supabase CLI / migrations基盤                | create now                            | `supabase/` と手順だけ作成。推測baseline SQLは作らない                   |
| `src/lib/database.types.ts` 生成             | external blocked                      | 実DB baseline後にpublic schemaだけ生成                                   |
| private schema / credential / payload table  | do not create before gate             | MVP-0b以降。MVP-0aでは名前と型生成境界だけ固定                           |
| bootstrap / create / join / restore RPC      | do not create before gate             | MVP-0b/0c以降。MVP-0aではUI/RPC導線を開かない                            |
| Realtime / item mutation / assignment / route | do not create before later gate       | MVP-1以降またはMVP-2系。MVP-0aでは到達不能                              |
| 旧 `isSharingEnabled()` の置換               | do not change behavior in MVP-0a      | リスクを記録し、MVP-0b/0cのfail closed移行対象にする                    |

## bundle影響

`zod` と `json-canonicalize` はMVP-0aで依存追加します。現時点では新しい共有コードがアプリentryから
importされていないため、共有UI公開前のproduction bundleには通常取り込まれません。`npm run build` を
MVP-0a検証に含め、共有導線公開前に実bundle差分を再確認します。

## 保留中だが実装を妨げない項目

| 項目             | 状態             | 接続後の対応                                |
| ---------------- | ---------------- | ------------------------------------------- |
| 実DB baseline    | decided          | 実DBは共有系テーブル/RPCなしの空DB相当として確認。空DBを正として基礎schemaを新規migration化 |
| DB由来生成型     | input_required   | MVP-0b migrationをローカルDBまたは実DBへ適用後、`public` schemaだけを生成 |
| DB major version | decided          | 実DB確認値はPostgreSQL 17系。`supabase/config.toml` は `major_version = 17` |
| 匿名Auth設定     | input_required    | Dashboardで確認し、ローカル入力ファイルへ `true` を記録 |
| `postponed` 移行 | decided          | 空DBのため既存データ移行なし。基礎schemaでは `postponed` と `purchase_status = 'Postpone'` を併存させ、MVP-1で正規更新RPCへ寄せる |
| secret provider  | decided          | MVP-0bでは `private.sharing_secret_versions` をsecret注入境界に固定。Vault化/外部secret providerは公開運用ゲートで拡張 |

空DBを正として扱う判断により、MVP-0b前に基礎schema migrationを追加します。
ただし `create_room` / `join_room_by_code` / `restore_member_by_key` / snapshot本体はMVP-0cまでfail-closedのままにします。

## ゲート分類

| ゲート       | 公開範囲                                                           |
| ------------ | ------------------------------------------------------------------ |
| MVP-0a       | CLI、baseline/typegen手順、設計記録、schema/canonicalizer単体      |
| MVP-0b       | RLS/helper/digest/challenge/rate limit。外部UIなし                 |
| MVP-0c       | create/join/restore/snapshot/ack、構造変更ロック、期限切れ最小停止 |
| MVP-1        | item mutation、差分catch-up、最小通知配送                          |
| MVP-2a       | 担当変更、一括譲渡、自分担当表示                                   |
| MVP-2b       | 退出、一時離脱、期限切れローカル化、cleanup                        |
| MVP-2c       | route同期、通知一覧、マップ表示                                    |
| PUBLIC-GUARD | 一般公開用Guard。完了前はpublic releasableではない                 |

## PWA移行

現行は `autoUpdate`、`skipWaiting`、`clientsClaim` が有効です。MVP-0aではリスクを記録し、
動作変更は行いません。MVP-0cの共有導線公開前に、更新保留状態を理解するクライアントを先行配布し、
`prompt`方式と安全条件付きService Worker適用へ移行します。

## 既存実装で確認済みの差分

- `isSharingEnabled()` はSupabase URL/keyの存在だけを見ている
- `claim_item` はクライアント指定の `p_user_id` を受け取る
- `rooms.room_code` は平文型として定義されている
- `notifications` は `target_user_id` と共有 `is_read` を持つ
- `room_items.order_index` は非null、`postponed` と `purchase_status` が併存する

これらは後続ゲートでfail closedに移行し、MVP-0aでは既存動作を変更しません。

## 既存文字コード例外

全監視対象をUTF-8 strictで再走査した結果、今回の変更前から次が存在します。

- `docs/refactor-regression-tickets.md`: U+FFFDが2文字
- `src/**/*.tsx`: UTF-8 BOM付きが3ファイル
- `docs/**/*.md`: UTF-8 BOM付きが10ファイル

推測修復は行わず、`scripts/utf8-known-exceptions.json` に件数を固定しました。
`npm run encoding:check` は既知例外の増減、新しいBOM/U+FFFD、不正UTF-8を失敗として扱います。
