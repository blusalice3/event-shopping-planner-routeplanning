# 共有・連携機能 要件

> 状態: Draft／未着手
>
> 対象: `event-shopping-planner-routeplanning-1.9.6.7`
>
> 旧版向け文書の実装実績、migration、RPC、試験PASS、工数、SHA、承認状態は継承しない。

## 1. この文書の役割

本書はMVPの機能要件、非機能要件、対象外、受入条件の正本である。実装順は
[新規実装プラン](./sharing-feature-plan.md)、技術方式は[設計](./sharing-feature-design.md)、
server契約は[protocol](./sharing-feature-protocol.md)、試験方法は
[検証計画](./sharing-feature-verification.md)を参照する。

要件IDの状態は、文書が存在することではなく、現行treeの成果物と同じcommitで再実行できる
試験によって判定する。現時点の要件状態はすべて未実装である。

## 2. 用語

| 用語 | 意味 |
| --- | --- |
| local event | 現在のbrowserに保存されているevent。変更可能な表示名とは別に`localEventId`を持つ |
| room | 1つのeventを小規模グループで共有するserver上の単位 |
| host | roomを作成し、商品構造とroom終了を管理するmember |
| member | Anonymous Authでroomへ参加する利用者 |
| shared projection | `ShoppingItem`から明示的に選んだ共有対象field |
| server replica | 最後にserverで確定したroom／item状態のlocal copy |
| optimistic overlay | server確定前にUIへ一時表示する端末上の変更 |
| outbox | 未送信または結果確認待ちの共有command |
| operation ID | 同じ副作用を安全に再送するための一意なID |
| fallback | 選択した端末の共有senderを停止し、その端末だけlocal運用へ移す明示操作 |

## 3. MVPの利用条件

次の値はM0で再確認する仮置きであり、実装済みの制限値ではない。

- hostを含め2〜4人
- 最大300商品
- room期限は既定24時間、最大7日
- 1つのlocal eventにつき同時に有効な共有roomは1つ。これは端末内のUX制約であり、
  `localEventId`をserverへ送って全端末へ強制する不変条件ではない
- 面識のある小規模グループによる限定利用
- PC Chrome／Edge、Android Chrome／PWA
- server停止時のSLAや同一roomへの完全復旧は保証しない

## 4. 機能要件

### 4.1 起動と既存機能の保護

| ID | 要件 |
| --- | --- |
| `SHR-FLG-001` | client feature flagが未設定またはfalseなら共有入口を表示せず、Auth、Realtime、outbox送信を開始しない |
| `SHR-FLG-002` | Supabase URL／anon keyが欠落または不正な場合、既存local機能を通常どおり利用できる |
| `SHR-FLG-003` | server gateはclientに依存せず、room作成、参加、業務writeを個別に停止できる |
| `SHR-LOC-001` | 共有機能の有効／無効にかかわらず、既存eventの閲覧、編集、保存、XLSX export／importを維持する |

### 4.2 安定識別子

| ID | 要件 |
| --- | --- |
| `SHR-ID-001` | 各local eventは表示名とは別のUUID `localEventId`を持つ |
| `SHR-ID-002` | event renameでは`localEventId`を維持し、明示的なduplicateでは新しいIDを発行する |
| `SHR-ID-003` | 既存item IDは破壊的に変更しない。serverではroom内の`source_item_id`として扱う |
| `SHR-ID-004` | 新規itemの発番は`crypto.randomUUID()`へ統一する |
| `SHR-ID-005` | event名、商品名、circle名、配置の一致だけでlocalとserverのentityをmergeしない |

### 4.3 room作成

| ID | 要件 |
| --- | --- |
| `SHR-ROOM-001` | hostは選択したlocal eventからroomを作成できる |
| `SHR-ROOM-002` | 作成前に共有field、商品数、期限、member上限、privacy上の注意を表示する |
| `SHR-ROOM-003` | roomは初期itemの完全な登録が終わるまで参加可能状態にならない |
| `SHR-ROOM-004` | room作成はserver gate、operator発行の一回限りcreator code、rate、project／user上限を満たす場合だけ成功する |
| `SHR-ROOM-005` | 作成失敗時にlocal eventを変更せず、不完全roomは参加や通常同期に使えない |

### 4.4 招待と参加

| ID | 要件 |
| --- | --- |
| `SHR-JOIN-001` | hostは招待URL、同値のQR、手入力codeを表示、copy、失効、再発行できる |
| `SHR-JOIN-002` | 招待URLの高entropy秘密はURL fragmentで受け渡し、読取直後に`history.replaceState`で除去し、query parameterや永続logへ出さない |
| `SHR-JOIN-003` | 手入力codeは期限、試行回数、rate limitを持ち、生値や単純hashをDBへ保存しない |
| `SHR-JOIN-004` | 参加前にevent名、host nickname、商品数、期限、現在人数／上限をpreviewする |
| `SHR-JOIN-005` | 利用者は本名を避けたnicknameを入力し、Anonymous Auth成立後に参加する |
| `SHR-JOIN-006` | 無効、失効、期限切れ、満員、受付停止、rate limitを区別できる安定error codeで返す |
| `SHR-JOIN-007` | 同名eventが存在しても自動mergeせず、IDが一致しない場合は別copyを既定にする |
| `SHR-JOIN-008` | 生の招待秘密をIndexedDB、localStorage、XLSX、診断exportへ保存しない |
| `SHR-JOIN-009` | create／invite rotationはonline専用とし、応答喪失後は非秘密operation IDからhost roomを確認して新credentialへrotateできる |

### 4.5 共有商品

初期MVPの共有対象は次とする。

| 種別 | field |
| --- | --- |
| 識別 | `source_item_id` |
| 商品内容 | `circle`、`eventDate`、`block`、`number`、`title` |
| 購入情報 | `price`、`quantity`、`purchaseStatus`、`limitedPurchasedQuantity` |
| 補助情報 | `remarks`、`priorityLevel` |

初期MVPで共有しないfield:

- `url`
- `protectionLevel`
- `source`
- `lastSyncedAt`
- `manualHallId`
- `orderIndex`、`postponed`
- `executeModeItems`の順序
- map、hall、route、viewport、UI設定、spreadsheet URL

`assignedTo`はMVP対象外とし、member IDへ正規化する設計が確定するまでserverへ送らない。

| ID | 要件 |
| --- | --- |
| `SHR-DATA-001` | 共有開始前に、共有対象fieldへremarksや価格が含まれることをhostへ表示する |
| `SHR-DATA-002` | hostだけが商品内容を追加、編集、削除できる初期権限とする |
| `SHR-DATA-003` | active memberはedit、execute、focus、map、bulkの各既存導線から購入状態と限数購入数を更新でき、共有中は全導線が共通command境界を通る |
| `SHR-DATA-004` | server payloadはallowlist方式で生成し、`ShoppingItem`全体を暗黙に送信しない |
| `SHR-DATA-005` | 未知field、未知enum、上限超過、無効な数量をserverで拒否する |
| `SHR-DATA-006` | item削除はserver上で識別可能なtombstoneまたはversion付き状態として同期する |

### 4.6 同期、冪等性、競合

| ID | 要件 |
| --- | --- |
| `SHR-SYNC-001` | server確定rowを共有状態の正本とする |
| `SHR-SYNC-002` | 各mutationはoperation IDとrequest hashを持ち、対象が既に存在する場合はroom IDとexpected versionも持つ |
| `SHR-SYNC-003` | 同じactor、operation ID、operation種別、request hashの再送は、初回後にgate、rate、room状態が変わっても同じ保存済み結果を返す |
| `SHR-SYNC-004` | 同じoperation IDを異なる内容へ再利用した場合は副作用なしで拒否する |
| `SHR-SYNC-005` | Realtime受信はinvalidateとして扱い、revision付き差分またはsnapshotを取得して確定する |
| `SHR-SYNC-006` | stale versionを黙ってlast-write-winsで上書きしない |
| `SHR-SYNC-007` | 競合時はserver値、端末変更、再適用／破棄の選択を利用者へ示す |
| `SHR-SYNC-008` | outbox残存、結果不明、revision不一致、再取得失敗時は「同期済み」と表示しない |
| `SHR-SYNC-009` | purchase statusと`limitedPurchasedQuantity`の組合せをserver transactionで検証する |
| `SHR-SYNC-010` | roomの`revision`を全体revisionとし、member／item変更rowへ同じ値を`change_revision`として記録する。room control、member、item tombstoneを指定revision以降で再取得できる |

### 4.7 offlineと複数tab

| ID | 要件 |
| --- | --- |
| `SHR-OFF-001` | MVPでoffline queueを許す操作は購入状態／限数購入数の更新だけとする |
| `SHR-OFF-002` | outboxを共有専用IndexedDB storeへ保存し、localStorageへfallbackしない |
| `SHR-OFF-003` | timeoutや応答喪失は`outcome_unknown`として区別し、同じoperationを確認なしに作り直さない |
| `SHR-OFF-004` | reload、sleep、一時的なAuth refresh後もoperation IDとpayloadを維持する |
| `SHR-OFF-005` | 共有中はapplication writerを1 tabに限定し、非owner tabから既存stateやoutboxを書き戻さない |
| `SHR-OFF-006` | 資格失効、room終了、protocol不一致、server緊急停止では自動再送を停止する |
| `SHR-OFF-007` | `navigator.onLine`だけで同期可否や完了を判定しない |

### 4.8 memberとroom lifecycle

| ID | 要件 |
| --- | --- |
| `SHR-LIFE-001` | member一覧にnickname、role、接続状態、最終確認時刻を表示する |
| `SHR-LIFE-002` | host以外のmemberは退出でき、退出後はroomのread、write、Realtimeを利用できない |
| `SHR-LIFE-003` | hostはopen中に退出できず、先にroomを終了する。host引継ぎはMVPに含めない |
| `SHR-LIFE-004` | closing開始後は新規の通常業務mutationを拒否する |
| `SHR-LIFE-005` | room期限はserver時刻で判定し、期限切れ後のwriteを拒否する |
| `SHR-LIFE-006` | MVPのfallbackは端末単位とする。onlineの一般memberは退出、hostはroom終了を先に試みる。offlineではserver資格を変更せずlocal senderだけを停止し、その後の変更を旧roomへ自動再投入しない |
| `SHR-LIFE-007` | server全損やhost session喪失から同一roomを復元する保証はMVPに含めない |
| `SHR-LIFE-008` | room終了や共有障害後もlocal eventとXLSX exportを利用できる |
| `SHR-LIFE-009` | hostはmemberをremoveでき、対象memberのserver read、write、Realtimeを同じ処理で失効させる |

### 4.9 状態表示とaccessibility

| ID | 要件 |
| --- | --- |
| `SHR-UX-001` | shared、syncing、offline、pending、conflict、outcome unknown、closedを色以外でも区別する |
| `SHR-UX-002` | 未送信件数、最終server確認時刻、再試行停止理由を確認できる |
| `SHR-UX-003` | dialogは初期focus、focus trap、Esc、close後のfocus復帰を備える |
| `SHR-UX-004` | errorと入力欄を関連付け、非同期状態変更を適切なlive regionで通知する |
| `SHR-UX-005` | QRと同じ参加情報をcopy可能なURL／codeで提供し、画像だけに依存しない |
| `SHR-UX-006` | keyboardのみ、200% zoom、狭幅、縦横画面、reduced motionで主要導線を利用できる |

## 5. Securityとprivacy要件

| ID | 要件 |
| --- | --- |
| `SHR-SEC-001` | client bundleへ置けるSupabase資格情報はproject URLとanon keyだけとする |
| `SHR-SEC-002` | service role key、DB password、招待hash用server秘密をclientへ配布しない |
| `SHR-SEC-003` | mutation RPCは`auth.uid()`をserver内で取得し、client申告のactor IDを信頼しない |
| `SHR-SEC-004` | browserから共有tableへの直接INSERT／UPDATE／DELETEを許可しない |
| `SHR-SEC-005` | RLSはactiveな同一room memberに必要最小限のSELECTだけを許可する |
| `SHR-SEC-006` | 別room、未認証、退出済み、期限切れのaccessをDB試験で拒否する |
| `SHR-SEC-007` | RPCはroom状態、member資格、role、期限、rate、payload上限をtransaction内で再検査する |
| `SHR-SEC-008` | 招待秘密、Auth token、code、request hash、秘密を含むpayloadをconsole、analytics、診断へ出さない |
| `SHR-SEC-009` | SupabaseのHTTP／WebSocket originだけを必要最小限のCSPへ追加する |
| `SHR-SEC-010` | SupabaseのAPI応答と招待URLをService Worker cacheへ保存しない |
| `SHR-SEC-011` | Auth sessionを永続化する場合はSupabase SDKの管理下だけで保存し、application独自copyを作らず、logout時に削除する |

privacy表示には少なくとも次を含める。

- nicknameにも個人を特定できる文字列を入力しない案内
- 共有される商品名、価格、数量、remarksの確認
- 招待URL／QR／codeを受け取った人が参加できること
- 通信断やserver停止時に共有が完全でない可能性
- serverに保存する情報、保持期間、削除の契機

## 6. 非機能要件

| ID | 要件 |
| --- | --- |
| `SHR-NFR-001` | 共有機能OFF時の既存起動、保存、編集、map、focus、export／importに回帰を生じさせない |
| `SHR-NFR-002` | 300商品の初期snapshotと通常差分同期を低速なmobile回線で実測し、release上限を決める |
| `SHR-NFR-003` | client crash、tab終了、PWA background後も確定済みreplicaとoutboxを復元できる |
| `SHR-NFR-004` | schema変更はforward migrationで行い、旧clientを安全に停止できるprotocol versionを持つ |
| `SHR-NFR-005` | logと診断はerror code、version、件数、遅延などの非秘密情報を中心にする |
| `SHR-NFR-006` | Auth、RPC、Realtime失敗率、outbox滞留、競合、期限切れcleanupを監視可能にする |
| `SHR-NFR-007` | retentionと物理削除をtableごとに定義し、削除処理を冪等にする |
| `SHR-NFR-008` | PC Chrome／Edge、Android Chrome／PWAで同じ安全要件を満たす |

## 7. MVP対象外

次は要件やschemaへ先行投入しない。

- memberへの商品担当とroute同期
- map／hall共有
- 委託、代理購入、引取、再配分
- 個人予算、支出のprivate集計
- host transfer、複数人承認によるroom復旧
- 一般公開room、検索、SNS投稿
- push、メール、SMS通知
- cameraをアプリ内で直接制御するQR scanner
- 自動化されたfallbackデータの再統合
- iOS正式対応
- enterprise向けSLA、監査保管、複数region復旧

## 8. 実装前に確定する事項

| ID | 未決事項 | 現在の仮置き |
| --- | --- | --- |
| `SHR-DEC-001` | member上限 | hostを含め4人 |
| `SHR-DEC-002` | 商品上限 | 300件 |
| `SHR-DEC-003` | room期限 | 既定24時間、最大7日 |
| `SHR-DEC-004` | room作成制限 | server gateとoperator発行の一回限りcreator code |
| `SHR-DEC-005` | 手入力code | rate制限付き短期code |
| `SHR-DEC-006` | offline許可操作 | 購入状態／限数購入数のみ |
| `SHR-DEC-007` | 正式browser | PC Chrome／Edge、Android Chrome |
| `SHR-DEC-008` | retention | privacy、費用、復旧要件を確認後に決定 |
| `SHR-DEC-009` | Realtime方式 | Postgres Changesを候補とし、費用とRLS挙動を実測 |
| `SHR-DEC-010` | item内容の編集権限 | hostのみ |
| `SHR-DEC-011` | Auth session保存 | 現行`persistSession: true`を前提にSDK管理storage、logout、共有端末riskをreview |

これらの決定でMVPのrisk、費用、data modelが変わる場合、実装前に本書、
[protocol](./sharing-feature-protocol.md)、[検証計画](./sharing-feature-verification.md)を同時に更新する。
