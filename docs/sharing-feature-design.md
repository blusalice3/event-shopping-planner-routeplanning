# 共有・連携機能 設計

> 状態: Draft／未着手
>
> 本書は`event-shopping-planner-routeplanning-1.9.6.7`へ新規実装するための設計案であり、
> 既存schema、migration、RPC、共有runtimeが存在することを示さない。

## 1. 設計目標

- 既存のlocal-first機能を共有機能から独立して維持する。
- server正本、server replica、楽観的変更、outboxの境界を明確にする。
- 二重実行、通信断、順序逆転、同時更新、資格失効を安全に扱う。
- 共有不能時にlocal eventを失わず、明示的なfallbackへ移れるようにする。
- MVP対象外の将来機能をschemaや状態管理へ先行投入しない。

## 2. 現行コードから見た制約

### 2.1 状態管理

`src/App.tsx`が次の主要stateを個別の`useState`で保持し、
`src/hooks/useIndexedDbPersistence.ts`が保存と復元を行う。

- `eventLists`
- `eventMetadata`
- `executeModeItems`
- `dayModes`
- `mapData`
- `mapRotationSettings`
- `mapViewportSettings`
- `routeSettings`
- `hallDefinitions`
- `hallRouteSettings`

共有機能の状態をこれらへ直接混在させると、server snapshotやoutboxの反映で既存保存処理が
意図せず上書きされる。共有session、server replica、outboxは`src/features/sharing/`へ隔離し、
`App.tsx`とは明示的なadapterで接続する。

### 2.2 local永続化

現行IndexedDBはversion 5で、通常10 storeと汎用`syncQueue`を持つ。`syncQueue`は
`saveSyncQueue`／`loadSyncQueue`以外から利用されず、要素型は`unknown[]`である。

共有実装では次を行う。

- version 5から次versionへの前方migrationを追加する。
- 既存storeと`syncQueue`は破壊しない。
- 型付きの共有専用storeを新設する。
- 共有storeはlocalStorage fallback対象にしない。
- migration失敗時は共有だけを無効化し、既存local storeを初期化しない。

### 2.3 Supabase

現行production graphにはSupabase SDK、`src/lib/supabase.ts`、Auth、RPC、Realtimeを呼ぶ
consumerは存在しない。共有機能を実装するphaseで、SDK、型付きadapter、環境変数allowlist、
通信先CSPを同じcompatibility clusterとして追加する。

共有有効化は、client生成の可否だけではなく次の全条件を満たす場合だけとする。

1. `VITE_SHARING_ENABLED === "true"`
2. URLとanon keyが設定されている
3. clientが対応protocolを取得できる
4. server側release gateが有効である

### 2.4 識別子

eventは`eventName`をRecord keyとしており、rename時に複数storeのkeyを移動する。表示名を
server連携のidentityにできないため、`EventMetadata`へ`localEventId`を追加する。

itemはIDを持つが、UUIDと時刻＋乱数が混在する。既存IDを一括変換するとimport、update、
map参照へ影響するため、次の方針を採る。

- 既存item IDはそのまま維持する。
- 新規発番だけを`crypto.randomUUID()`へ統一する。
- server itemは独自UUIDを持つ。
- `(room_id, source_item_id)`でlocal itemとの対応を一意にする。
- source IDは`text`とし、既存IDがUUIDであることを要求しない。

## 3. 論理architecture

```text
既存UI / App state
        │ 明示的なcommand・projection
        ▼
sharing UI / hooks
        │
        ▼
sharing domain ── optimistic overlay
        │
        ├── IndexedDB server replica
        ├── IndexedDB typed outbox
        └── Supabase adapter ── RPC ── Postgres transaction / RLS
                                ▲
                                └── Realtime invalidation
```

Realtime payloadを直接React stateの正本にしない。通知を受けたsync coordinatorがrevisionを比較し、
差分またはsnapshotを取得してserver replicaを更新する。

## 4. module構成

予定する構成例:

```text
src/features/sharing/
  components/
    CreateRoomDialog.tsx
    JoinRoomDialog.tsx
    SharingStatus.tsx
    SharingPanel.tsx
    SyncConflictDialog.tsx
  domain/
    commands.ts
    errors.ts
    projection.ts
    roomState.ts
    syncState.ts
  data/
    sharingDb.ts
    sharingRepository.ts
    supabaseSharingApi.ts
  hooks/
    useSharingSession.ts
    useSharingSync.ts
  types.ts
```

責務:

- `components`: 表示と利用者操作。Supabaseを直接呼ばない。
- `domain`: 純粋な型、validation、状態遷移、conflict判断。
- `data`: IndexedDBとSupabaseのI/O。
- `hooks`: lifecycle、購読、outbox sender、既存Appとの接続。
- `sharingRepository`: UIから見た唯一のdata access境界。

共有中の購入状態更新は`SharingCommandPort`相当の共通入口へ集約する。現行のedit、execute、
focus、map popup、bulk操作から直接`setEventLists`だけを更新する経路を残さず、共通commandが
local反映とoutbox作成を一つの操作として扱う。

## 5. local data model

### 5.1 event identity

`EventMetadata`へ次を追加する。

```ts
localEventId: string;
```

migration規則:

- 既存eventは起動後のmigrationで一度だけUUIDを付与する。
- metadataがないeventにも既定metadataを作成する。
- renameではmetadataとIDを維持する。
- duplicateは新IDを発行する。
- version付きXLSXの「同一eventへrestore」はIDを維持し、「別copyとしてimport」は新IDを発行する。
- legacy XLSXはevent名だけで暗黙にrestoreせず、更新対象を利用者が明示しない場合は新IDを発行する。
- 通常のspreadsheet更新やCSV追加ではevent IDを変更しない。

### 5.2 共有専用IndexedDB store

名称は実装時に確定するが、最低限次を分離する。

| store              | key                   | 内容                                          |
| ------------------ | --------------------- | --------------------------------------------- |
| `sharingRoomLinks` | `localEventId`        | room ID、member ID、非秘密のsession metadata  |
| `sharingReplicas`  | `roomId:sourceItemId` | 最後にserverで確定したitem rowとversion       |
| `sharingRoomState` | `roomId`              | room、member、revision、最終同期情報          |
| `sharingOutbox`    | `operationId`         | command、request hash、状態、attempt metadata |

共有専用storeの禁止事項:

- 招待token、Auth access tokenのapplication独自copy、service secretを保存しない。
- optimistic overlayをserver replicaへ上書きしない。
- 共有storeをlocalStorageへfallbackしない。
- outboxを認識できない旧形式から推測で再送しない。

### 5.3 client state

session状態:

- `disabled`
- `connecting`
- `joining`
- `syncing`
- `ready`
- `degraded`
- `closing`
- `closed`

outbox状態:

- `queued`
- `sending`
- `confirmed`
- `conflict`
- `outcome_unknown`
- `blocked`
- `failed`
- `discarded`

`session.ready`はclient UIが操作可能であることを表し、後述の`room.open`とは別の型とする。
個別operationの同期完了は、outboxとserver revisionを別に確認して表示する。

## 6. server data model

初期MVPの最小候補は次のとおりである。列、index、constraintの規範は
[protocol](./sharing-feature-protocol.md)で確定する。

| table                          | 役割                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `sharing_rooms`                | lifecycle、host、期限、protocol、全体revision                            |
| `sharing_invites`              | 招待秘密のhash／HMAC、期限、失効、試行制御                               |
| `sharing_members`              | member ID、nickname、role、status、last seen。生Auth user IDは公開しない |
| `sharing_items`                | 共有projection、source item ID、row version、tombstone                   |
| `sharing_item_events`          | 購入状態変更と取消のappend-only記録                                      |
| `sharing_operation_receipts`   | 冪等operationのrequest hashと最小結果                                    |
| `sharing_runtime_control`      | 作成、参加、業務writeのserver gate                                       |
| `sharing_creator_grants`       | pilotのroom作成を許可する一回限りcodeのHMAC、期限、使用状態              |
| `sharing_member_auth_bindings` | privateなAuth userとroom memberの対応                                    |

将来機能用のassignment、route、delegation、budget、host takeover tableや列は追加しない。

## 7. 認証と招待

### 7.1 Auth

- Supabase Anonymous Authを初期候補とする。
- actorはRPC内の`auth.uid()`から決める。
- clientから渡されたuser IDやroleを認可に使わない。
- Anonymous Authが作れない場合、共有だけを利用不可にしてlocal機能を維持する。
- 現行`persistSession: true`を維持する場合、sessionはSupabase SDKが選んだstorageだけに保存し、
  application独自のtoken copyを作らない。
- reload回復と引き換えにbrowser storageへsessionが残るriskをM0でreviewし、logout時にSDK sessionと
  非秘密room linkの扱いを試験する。

### 7.2 招待URL／QR

- clientがCSPRNGで高entropy tokenを生成し、serverにはhashだけを保存する。
- URLのfragmentへtokenを入れ、queryやRefererへ流さない。
- clientはfragment読取直後に`history.replaceState`を行い、join RPCに必要な間だけtokenをmemoryで
  保持する。
- QRは同じ招待URLを表す。アプリ内camera scannerはMVP対象外とする。
- 再発行時は旧credentialを失効する。

### 7.3 手入力code

- clientがtokenとは別の短期codeをCSPRNGで生成する。
- server秘密を使ったHMACだけを保存する。
- room単位と送信元単位のrate limit、attempt上限、期限を設ける。
- codeのentropyとUXはM0で決定し、protocolへ固定する。

### 7.4 秘密を伴うoperationの応答喪失

- createとinvite rotationはoffline outboxへ入れず、online時だけ実行する。
- clientは秘密を含まないoperation IDを送信前に永続化し、token／codeはmemoryだけに保持する。
- 応答喪失後もmemoryが残る間は同じoperation IDと同じ秘密で冪等再送する。
- reloadで秘密を失った場合、同じAuth sessionとoperation IDでhost roomの非秘密結果だけを取得し、
  新しいtoken／codeへrotateする。
- rotateの応答を失った場合も、さらに新しいcredentialへrotateして不明なcredentialを失効する。

## 8. 認可

- browser roleによる共有tableの直接INSERT／UPDATE／DELETEを禁止する。
- activeな同一room memberに必要最小限のSELECTだけをRLSで許可する。
- 招待、receipt、runtime controlの秘密列をbrowserからSELECTできない領域に置く。
- hostだけがitem構造、招待、参加受付、room終了を変更できる。
- hostはmemberをremoveでき、対象memberの資格を同じtransactionで失効する。
- active memberは購入状態と限数購入数だけを変更できる。
- 退出、block、期限切れ、closed後はread、write、Realtimeを拒否する。
- `SECURITY DEFINER` RPCを使う場合は空の`search_path`と完全修飾object名を使用する。

RLSだけでRPCの業務条件を省略しない。RPCでもroom、member、role、期限、gate、rate、
payload上限を同じtransaction内で検査する。

## 9. commandと冪等性

共有mutationは次を共通fieldとして持つ。room ID、target ID、expected versionは、対象が既に存在する
operationでだけ必須とする。

- `operation_id`
- operation種別
- room ID
- target ID
- expected version
- payload
- protocol version

serverはcanonical payloadからrequest hashを計算する。

1. Authとoperation envelopeを検査し、request hashを計算する。
2. `(actor, operation_id, operation_kind)`のreceiptを確認する。
3. 同じhashのreceiptがあれば、現在のgate、rate、room状態より先に保存済み結果を返す。
4. hashが違えば`idempotency_conflict`で拒否する。
5. 新規実行だけmember、room、gate、rate、expected version、業務不変条件を検査する。
6. 業務row、event、revision、receiptを同じtransactionで確定する。

client timeout後は同じoperation IDと同じpayloadで再送する。新しいoperation IDを発行して
結果不明の操作を重複実行しない。

## 10. 同期

### 10.1 初期同期

- hostはroomを`initializing`で作成する。
- itemを上限付きchunkで登録する。
- 件数とhashを検査して`open`へ遷移する。
- memberは`open`になるまで参加できない。
- join後にroom、member、itemのsnapshotを取得してlocal linkを作る。

### 10.2 通常同期

1. UIがdomain commandを発行する。
2. commandをoutboxへ永続化する。
3. optimistic overlayをUIへ表示する。
4. senderが同じoperationをRPCへ送る。
5. server結果をreplicaへ保存する。
6. confirmedになったoutbox entryを安全に削除する。
7. overlayを除去し、server replicaから既存App stateへprojectionする。

Realtimeはroom revisionの変化を通知する。受信漏れ、重複、順序逆転を前提とし、clientは
現在revisionとの差を確認して差分またはsnapshotを取得する。

`sharing_rooms.revision`をroom全体revisionとする。member／itemの公開変更rowには、そのtransactionで
採番した同じ値を`change_revision`として記録する。差分取得は最新room controlと
`change_revision > last_revision`のmember／item upsert／tombstoneを返し、保持範囲を超えた場合だけ
snapshotへ切り替える。

### 10.3 競合

- stale expected versionは`revision_conflict`で拒否する。
- item内容の競合はserver値とhostの端末変更を比較して再適用／破棄を選ぶ。
- 購入状態の競合は黙って再適用せず、server確定状態を表示する。
- serverで既に同じ意味の状態になっている場合だけ、明示的なno-op成功を返せる。
- client clockによるlast-write-winsを採用しない。

## 11. offlineと複数tab

- offline queueのallowlistは購入状態と限数購入数だけとする。
- network errorはbackoffとjitterを使って再試行する。
- 401はsession refresh後に同一operationを再送する。
- 403、room closed、member inactive、protocol mismatch、server write停止は`blocked`にする。
- 応答を受ける前に接続が切れた場合は`outcome_unknown`とし、receipt確認または同一operationの
  冪等再送で解決する。
- Web Locks等でapplication全体のwriterを1 tabに限定する。
- 現行永続化は`eventLists`等をstore単位で丸ごと保存するため、senderだけを限定しても安全ではない。
- lockを取れないtabはread-only表示にし、共有event以外の編集によるstaleな全体state保存も行わない。
- 安全なexclusive lockを提供できないbrowserでは共有sessionを開始しない。
- browser storageが利用できない場合、offline mutationを受け付けない。

## 12. room lifecycle

room状態:

```text
initializing → open → closing → closed
       └──────────────→ closed
```

- `initializing`: hostが初期dataを登録中。参加不可。
- `open`: 参加と通常同期が可能。
- `closing`: 新規通常mutationを停止し、hostが未送信／結果不明を確認する。
- `closed`: 参加、read、write、Realtimeを停止する。local copyは残せる。
- 期限切れはserver時刻から導出し、通常writeを拒否して終了導線を表示する。

MVPのfallbackは端末単位であり、server roomや他memberを一括変更しない。clientがsenderを停止し、
local eventを独立運用へ切り替える。onlineの一般memberは先に退出RPC、hostはroom closeを試みる。
offlineではserver資格を変更できないためlocalで即時停止し、その旨を表示する。fallback後の変更を
旧roomへ自動mergeせず、再接続しても自動復帰しない。

## 13. error model

UIで分岐が必要なerrorは、message文字列ではなく安定codeで返す。

- `not_authenticated`
- `not_authorized`
- `sharing_disabled`
- `room_not_found`
- `room_initializing`
- `room_closing`
- `room_closed`
- `room_expired`
- `room_full`
- `invite_invalid`
- `invite_expired`
- `invite_revoked`
- `rate_limited`
- `payload_too_large`
- `invalid_request`
- `idempotency_conflict`
- `revision_conflict`
- `member_inactive`
- `protocol_mismatch`
- `operation_in_progress`

各errorはretry可否、outbox状態、利用者向け表示、log levelを
[protocol](./sharing-feature-protocol.md)へ定義する。

## 14. PWA、version、rollback

- clientとroomは`protocol_version`を持つ。
- 非互換clientは通常mutationを送らず、updateまたはlocal fallbackを案内する。
- Supabase APIと招待URLはWorkboxでcacheしない。
- Service Worker更新中の旧client／新client混在をbrowser試験する。
- migrationはforward-onlyとする。
- rollbackはserver gate OFF、送信停止、互換clientの再配備を先に行う。
- IndexedDB versionを下げず、旧clientが新storeを無視できるようにする。
- schemaを破壊的に戻すdown migrationを通常rollbackにしない。

## 15. privacyと診断

診断へ含めてよい候補:

- app version
- protocol version
- session状態
- 非秘密のroom ID短縮表現
- server revision
- outbox状態別件数
- 最後に成功した同期時刻
- 安定error code

含めないもの:

- Auth token
- 招待URL、QR payload、手入力code
- service role key、DB password
- 商品名、remarks、URL、価格などの業務data
- nicknameや生のuser ID
- request payloadとrequest hash

保持期間、削除処理、監視項目は[運用計画](./sharing-feature-operations.md)で確定する。

## 16. 主要な採用判断

| 判断                              | 採用理由                                          | 再検討条件                                    |
| --------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| local stateとserver replicaを分離 | 既存local機能とoffline dataを守るため             | 共有専用appへ全面移行する場合                 |
| Realtimeはinvalidateだけ          | 欠落、重複、順序逆転へ耐えるため                  | 別transportで完全順序と再送が保証される場合   |
| RPC経由mutation                   | 認可、冪等性、不変条件をtransactionへ集約するため | 同等のserver command層を採用する場合          |
| eventへ安定UUIDを追加             | rename可能な表示名をidentityにしないため          | event store全体をID keyへ移行する場合         |
| 既存item IDをtextで保持           | 破壊的なID一括変換を避けるため                    | 全import形式と参照を安全にmigrationできる場合 |
| offline operationを限定           | 誤再送と構造競合を抑えるため                      | pilot実測と追加競合設計が完了した場合         |
| assignment等を対象外              | 現行の`assignedTo`が安定member IDではないため     | member identityと権限設計を別途追加した場合   |
