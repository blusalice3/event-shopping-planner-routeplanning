# 共有・連携機能 Protocol

> 状態: Draft／未着手
>
> 仮protocol version: `sharing-mvp-v1`
>
> 本書は実装予定のserver／client契約である。schema、migration、RPC、RLSが既に存在することや、
> remoteへ適用済みであることを示さない。signatureと制限値はM0 review後に固定する。

## 1. 正本と変更規則

- contract固定後は、本書、migration、生成型、RPC adapter、試験matrixを同じ変更で更新する。
- DBの正本は適用順を持つ`supabase/migrations/`とし、参考用の巨大な単独DDLを置かない。
- migrationはforward-onlyとし、適用済みfileを編集しない。
- `src/lib/database.types.ts`はlocal migration適用後に生成し、手書き型を正本にしない。
- 期限、rate、revision確定にはserver時刻を使う。
- clientとroomはprotocol versionを送り、非互換時は副作用なしで拒否する。
- 未分類のRPC、error、rate、権限、保持dataを残したままreleaseしない。

## 2. 命名と共通型

| 名前 | 型 | 規則 |
| --- | --- | --- |
| room ID | UUID | serverで発行 |
| member ID | UUID | serverで発行 |
| item ID | UUID | serverで発行 |
| `source_item_id` | text | room内で一意。既存local item IDを保持 |
| operation ID | UUID | clientでoperation作成時に一度だけ発行 |
| revision | bigint | server transactionで単調増加 |
| row version | bigint | 対象rowの確定変更ごとに増加 |
| timestamp | `timestamptz` | UTCのserver時刻 |
| protocol version | text | room作成時に固定 |

nickname、event label、商品文字列はUnicode正規化、最大長、制御文字、空白だけの値をserverで
検査する。最大長はM0でUIと既存import dataを調査して固定する。

## 3. schema案

### 3.1 `public.sharing_rooms`

主な列:

- `id uuid primary key`
- `protocol_version text not null`
- `event_label text not null`
- `host_member_id uuid null`
- `status text not null`
- `revision bigint not null default 0`
- `accepting_members boolean not null default false`
- `max_members integer not null`
- `created_at timestamptz not null`
- `expires_at timestamptz not null`
- `closing_at timestamptz null`
- `closed_at timestamptz null`

constraint:

- statusは`initializing | open | closing | closed`
- `expires_at > created_at`
- `max_members`はserver設定上限内
- `host_member_id`は同じroomのactive hostを参照する
- room作成後にprotocol versionを変更しない

### 3.2 `public.sharing_members`

主な列:

- `id uuid primary key`
- `room_id uuid not null`
- `nickname text not null`
- `role text not null`
- `status text not null`
- `joined_at timestamptz not null`
- `last_seen_at timestamptz not null`
- `left_at timestamptz null`
- `change_revision bigint not null`

constraint:

- roleは`host | member`
- statusは`active | left | blocked`
- active hostはroomごとに1件

### 3.3 `public.sharing_items`

主な列:

- `id uuid primary key`
- `room_id uuid not null`
- `source_item_id text not null`
- 共有projectionの各列
- `row_version bigint not null default 1`
- `change_revision bigint not null`
- `deleted_at timestamptz null`
- `updated_by_member_id uuid not null`
- `updated_at timestamptz not null`

constraint:

- `(room_id, source_item_id)`は一意
- `quantity`は1以上の設定上限以下
- `limitedPurchasedQuantity`は0以上`quantity`以下
- `purchaseStatus`は現行`PurchaseStatuses`との固定mappingだけを許可
- tombstone状態の通常更新を拒否

DB列はsnake caseとし、client mappingでcamel caseへ変換する。列の完全一覧は実装時に
`ShoppingItem`の共有allowlistから生成・reviewする。

### 3.4 `public.sharing_item_events`

購入状態変更のappend-only記録:

- `id uuid primary key`
- `room_id uuid not null`
- `item_id uuid not null`
- `member_id uuid not null`
- `operation_id uuid not null`
- `from_status text not null`
- `to_status text not null`
- `limited_purchased_quantity integer null`
- `created_at timestamptz not null`
- `voided_by_event_id uuid null`
- `change_revision bigint not null`

過去eventをUPDATE／DELETEせず、訂正は新しいeventで表す。item現在値とevent追加は同じtransactionで
確定する。

### 3.5 非公開table

次はbrowserから直接SELECTできないschemaへ置く。

`sharing_private.sharing_invites`:

- room ID
- token hashまたはcode HMAC
- credential kind
- expires／revoked／attempt metadata

`sharing_private.sharing_operation_receipts`:

- actor Auth ID
- operation ID
- operation kind
- request hash
- room ID
- target ID
- result code
- resultの最小JSON
- committed revision
- created／expires

`sharing_private.sharing_runtime_control`:

- room creation enabled
- join enabled
- business writes enabled
- protocol version
- updated at／reason

`sharing_private.sharing_creator_grants`:

- creator codeのHMAC
- expires／used／revoked
- 発行目的を示す非秘密reference
- 使用したAuth IDとroom ID

`sharing_private.sharing_member_auth_bindings`:

- room ID
- member ID
- Auth user ID
- bound／revoked時刻

同じroomでactiveなAuth userは1件に制限する。pilot中のroom作成は有効な一回限りcreator grantを
同じtransactionで消費する。生codeは保存せず、operator用の発行／失効手順は
[運用計画](./sharing-feature-operations.md)を正本とする。

private tableには`anon`と`authenticated`のtable権限を付与しない。

## 4. 状態遷移

### 4.1 room

許可:

- `initializing → open`
- `initializing → closed`
- `open → closing`
- `closing → open`は、終了をcommitする前のhost取消だけ
- `closing → closed`

禁止:

- `closed`からの遷移
- `initializing`中のjoin
- `closing`中の通常item mutation
- 期限切れ後の通常mutation

### 4.2 member

許可:

- join成立時に`active`
- host以外は`active → left`
- `active → blocked`

active hostの`leave_sharing_room`は`host_must_close_room`で拒否し、hostはroom close transactionで
終了する。MVPでは`left`／`blocked`から同じmember IDへの復帰を行わない。再参加は新しいmemberとして
扱う。

### 4.3 outbox

client側の許可遷移:

```text
queued → sending → confirmed
   │         ├──→ outcome_unknown
   │         ├──→ conflict
   │         ├──→ blocked
   │         └──→ failed
   └────────────→ discarded
```

追加規則:

- `outcome_unknown`は同一operationのreceipt確認または冪等再送で`sending`へ戻し、
  `confirmed | conflict | blocked | failed`のいずれかへ確定する。
- `blocked`はAuth refreshなど同じoperationを安全に再開できる一時理由だけ`queued`へ戻せる。
- 永続的な資格失効、room終了、protocol不一致の`blocked`は`discarded`だけへ進める。
- `conflict`と`failed`を内容変更して再送しない。利用者が再適用する場合は元operationを
  `discarded`にし、新しいoperation IDで`queued`を作る。
- `confirmed`と`discarded`はterminalとする。

### 4.4 端末local fallback

fallbackはserver roomの状態ではなくclient状態である。

- onlineの一般memberは`leave_sharing_room`、hostはroom closeを試み、成功後にsenderを停止する。
- offlineならsenderを即時停止し、既存outboxをblockedとしてlocalに隔離する。
- 他memberやserver roomを一括fallbackさせない。
- serverへ再接続しても自動復帰せず、旧roomへlocal変更を自動送信しない。
- team全体を停止する場合、hostは接続可能になった時点で通常のroom closeを行う。

## 5. RPC閉集合案

### 5.1 room作成

- `create_sharing_room`
  - host memberと`initializing` roomを作る
  - client生成のinvite token／codeとoperator発行creator codeを検証し、hash／HMACだけを保存する
  - token／codeの生値を応答、receipt、logへ含めない
- `get_sharing_room_creation_result`
  - 同じAuth sessionとcreate operation IDから非秘密のroom ID／状態だけを回復する
- `append_sharing_items`
  - hostだけが上限付きchunkを追加する
  - source item IDの重複とpayload hashを検査する
- `finalize_sharing_room`
  - 期待件数とcanonical hashを検査して`open`へ遷移する

### 5.2 招待と参加

- `preview_sharing_invite`
  - rate制限下で最小previewだけを返す
  - `anon`からの実行を許可できる唯一の候補とし、join mutationはAnonymous Auth後だけ許可する
- `join_sharing_room`
  - tokenまたはcodeを検証し、member上限内でactive memberを作る
- `revoke_sharing_invite`
  - hostが現credentialを失効する
- `rotate_sharing_invite`
  - hostがclient生成した新credentialのhash／HMACを登録し、旧credentialを失効する

### 5.3 読取

- `get_sharing_snapshot`
  - room、member、itemをpage単位で返す
- `get_sharing_changes`
  - 最新room controlと、指定revisionより後のmember／item upsert／tombstoneを
    `change_revision`順で上限付き返却する
- `get_sharing_control`
  - room状態、gate、server time、最新revisionを返す

### 5.4 mutation

- `apply_sharing_item_content`
  - host専用の商品内容変更
- `apply_sharing_purchase_state`
  - active memberによる購入状態／限数購入数変更
- `heartbeat_sharing_member`
  - last seenをrate制限付きで更新

### 5.5 lifecycle

- `leave_sharing_room`
  - active hostは拒否し、room closeを要求する
- `remove_sharing_member`
- `set_sharing_accepting_members`
- `begin_sharing_room_close`
- `cancel_sharing_room_close`
- `commit_sharing_room_close`

RPC名とsignatureはmigration作成前に固定する。公開RPCごとに次をcatalog化し、空欄を残さない。

- caller
- input／output
- idempotency
- role
- room状態
- rate class
- payload上限
- lock対象
- revision更新
- error code
- gate OFF時の挙動

## 6. RPC共通処理順

mutationは原則として次の順で検査する。

1. `auth.uid()`とoperation envelopeの存在
2. inputの構造検査とcanonical request hashの計算
3. actor、operation ID、operation kindに対するtransaction lock
4. operation receiptの所有者、kind、hash
5. 既存receiptがあれば、現在のgate、rate、room状態より先に保存済み結果を返す
6. 新規実行だけprotocol version、server gate、room、期限、member、role、rate／quotaを検査する
7. target rowとexpected version
8. 業務不変条件
9. 業務変更、event、revision、receiptのcommit

同じ種類のRPCはlock順を統一する。

1. operation idempotency key
2. runtime control
3. room
4. member
5. target item
6. receipt

不要なlockは省略できるが、逆順取得は禁止する。2つ以上のDB接続を使った競合試験でdeadlockが
ないことを確認する。

## 7. 冪等性

mutation input:

- `p_operation_id uuid`
- `p_protocol_version text`
- operation固有payload
- `p_expected_version bigint`が必要なmutationでは必須

server処理:

- actor Auth ID、operation kind、payloadのcanonical表現からrequest hashを作る。
- invite、manual code、creator codeを含むoperationでは、低entropy秘密のplain hashをreceiptへ保存せず、
  server-keyed digestへ置換してcanonicalizeする。
- `(actor_auth_id, operation_id, operation_kind)`を一意にする。
- Authとreceipt所有権を確認できた同じhashの既存receiptは、新規実行用gate、rate、room状態に
  かかわらず保存済み結果を返す。
- 異なるhashは`idempotency_conflict`。
- 実行中の同一operationは`operation_in_progress`または完了待ちを返す。
- receiptと副作用を同じtransactionでcommitする。
- read-only RPCへ不要なoperation IDを付けない。

receiptのresultには秘密や商品payload全体を入れず、再送へ必要なID、version、revision、result codeだけを
保持する。

## 8. RLSと権限

原則:

- `anon`は共有業務tableをread／writeしない。
- `authenticated`もtableへの直接mutationを行わない。
- activeな同一room memberだけが、必要なpublic rowをSELECTできる。
- closed／expired roomではserver上の通常SELECT、Realtime、mutationを拒否し、local replicaだけを残す。
- 同じAuth actorによる既存operationの最小receipt結果返却は、新規room read／writeとは分離し、
  資格失効後も元operationの結果確認に必要な範囲だけ許可する。
- hostであってもprivate invite、receipt、runtime controlを直接SELECTしない。
- RPC execute権限は必要なroleへ個別付与し、default executeを剥奪する。

必須negative test:

- 未認証
- 別room member
- left／blocked member
- closed／expired room
- clientがactor IDやroleを改ざん
- public tableへの直接INSERT／UPDATE／DELETE
- invite hash、receipt、runtime controlへの直接SELECT
- Realtimeで別room rowを購読

## 9. Realtimeとrevision

- publication対象は、RLSで同一room memberが読める必要最小限のtableだけにする。
- Realtime eventはinvalidate情報として扱う。
- `sharing_rooms.revision`をroom全体revisionとし、room control変更を含む全公開変更で増加させる。
- member／item変更rowは同じtransactionのroom revisionを`change_revision`として持つ。
- RPC結果は変更後revisionとserver timeを返す。
- `get_sharing_changes`は最新room controlと、`change_revision > p_after_revision`のmember／item
  最終row／tombstone、取得時点のroom revisionを返す。
- clientのrevisionが飛んだ場合、差分取得を試み、保持範囲外またはpage間整合を維持できない場合は
  snapshotを再取得する。
- Realtime未接続でもpollまたは利用者操作時のcontrol取得で収束できるようにする。
- payload順序、受信回数、client時刻を同期証明に使わない。

## 10. canonical hash

初期uploadの完全性確認にだけcanonical hashを使用する。

- field順、null、数値、Unicode正規化、改行をcodec versionへ固定する。
- clientとserverに同じtest vectorを持つ。
- JSON objectの自然なkey順序へ依存しない。
- hash不一致ではroomを`open`にせず、不足pageを再送できる。

通常差分同期はrow versionとroom revisionを正本とし、毎操作で全room hashを計算しない。

## 11. error contract

error responseは最低限次を持つ。

```ts
type SharingError = {
  code: string;
  retryable: boolean;
  userAction:
    | "none"
    | "retry"
    | "refresh"
    | "rejoin"
    | "resolve_conflict"
    | "use_local";
  retryAfterMs?: number;
};
```

安定code:

| code | retry | outbox |
| --- | --- | --- |
| `not_authenticated` | session refresh後のみ | blocked |
| `not_authorized` | no | blocked |
| `sharing_disabled` | gate再開までno | blocked |
| `room_not_found` | no | blocked |
| `room_initializing` | yes | queued |
| `room_closing` | no | blocked |
| `room_closed` | no | blocked |
| `room_expired` | no | blocked |
| `room_full` | no | 対象外 |
| `invite_invalid` | no | 対象外 |
| `invite_expired` | no | 対象外 |
| `invite_revoked` | no | 対象外 |
| `rate_limited` | `retry_after`後 | queued |
| `payload_too_large` | no | failed |
| `invalid_request` | no | failed |
| `idempotency_conflict` | no | failed |
| `revision_conflict` | 利用者確認後 | conflict |
| `member_inactive` | no | blocked |
| `host_must_close_room` | no。終了導線へ移動 | 対象外 |
| `protocol_mismatch` | update後のみ | blocked |
| `operation_in_progress` | yes | sending |

予期しないDB messageや内部table名をclientへ返さない。server logにも招待秘密と業務payloadを記録しない。

## 12. retentionと削除

保持期間はM0で確定する。少なくとも次を別々に決める。

- open／closed room
- itemとitem event
- member profile
- invite hash／attempt
- operation receipt
- security／rate metadata

要件:

- room削除は関連public／private rowを漏れなく削除する。
- cleanupは冪等で、途中失敗後に再実行できる。
- active roomをretention jobが削除しない。
- client exportへinvite、receipt、Auth ID、security metadataを含めない。
- 削除前に必要なlocal／XLSX退避を利用者へ案内する。

## 13. protocol固定前のchecklist

- [ ] 共有fieldと最大長が現行`ShoppingItem`に照合されている
- [ ] 仮上限値がlocal実測と利用planに照合されている
- [ ] 全RPCのsignatureとcatalogがreviewされている
- [ ] 全table、view、functionのgrantとRLSが一覧化されている
- [ ] operation canonicalizationとtest vectorがある
- [ ] room／member／outbox状態遷移に未定義の分岐がない
- [ ] 全error codeがclient表示と試験へ接続されている
- [ ] retention、cleanup、kill switch、rollbackが定義されている
- [ ] migration resetと前方upgradeの両方を試験できる

すべて未着手であり、checklistの完了は実装成果物と試験結果によってのみ更新する。
